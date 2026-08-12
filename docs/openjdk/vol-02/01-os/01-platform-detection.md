# 01. JVM 怎么知道自己跑在容器里？— 平台探测

> **前置依赖**：[卷 0 ch01 — java 命令是什么](openjdk/vol-00/ch01.md)；会读 C/C++ 和 Linux 基本概念
> → **后续**：[02 — 虚拟内存](02-virtual-memory.md)：探测完就要向 OS 要内存
> 关联域: 03-flags(自适应参数)、05-cpu-primitives(原子指令探测)、25-gc(自适应 heap)、26-g1(region 与容器)
> 工具实证: [卷 T ch05](openjdk/vol-tools/ch05.md) 的 Environment 页(CPU/内存/OS 全息)——"探测结果长什么样"的实物

## 一个 23KB 的 C 程序,怎么知道脚下是台什么机器

JVM 是个 C++ 程序。它启动后干的第一件事,不是加载你的类,而是**先看清自己脚下**:

- 跑在哪个 Linux 内核上?(3.x 还是 4.x,epoll 行为不一样)
- CPU 支持哪些指令?(有没有 AVX?JIT 能不能生成向量指令)
- 跑在物理机还是虚拟机里?(KVM 的 TSC 时钟会漂)
- 有几个核?分给容器几个核?
- 有多少内存?容器限额是多少?

这些问题有一个共同点:**答案全在操作系统那里,不在 JVM 自己身上**。JVM 只能去"问"——问内核、问 CPU 指令、问 cgroup 文件系统。这一篇就讲它怎么问、问完怎么用。

问的方式,是这一篇的三节:

```
"我是谁?"   → uname 查内核版本 + cpuid 查 CPU 特性 + TSC 查虚拟化
"我有几个 CPU?" → sysconf 数核 + cgroup 读配额 + NUMA 建映射
"我有多少内存?" → cgroup 读限额 + 缓存化避免频繁系统调用
```

## 1. "我是谁?" — 内核版本 + CPU 特性 + 虚拟化

### 内核版本:0x00AABBCC 一个整数装下整个版本号

JVM 启动时第一个系统调用级别的动作,是 `uname` 查内核版本(`man 2 uname` 返回 `utsname.release` 字符串,比如 `"4.18.0-193.el8.x86_64"`)。但 JVM 拿到字符串后**不做字符串比较**——它把版本号压成一个 32 位整数:

```cpp
// os_linux.hpp:60-66 —— _os_version 的格式约定
// 0x00000000 = uninitialized,
// 0x01000000 = kernel version unknown,
// otherwise a 32-bit number:
// Ox00AABBCC
// AA, Major Version
// BB, Minor Version
// CC, Fix   Version
static uint32_t _os_version;
```

解析发生在 `os::Linux::initialize_os_info()`(`os_linux.cpp:5253`):

```cpp
// os_linux.cpp:5253 起(截取核心)
struct utsname _uname;
...
rc = uname(&_uname);                       // 查内核版本字符串
rc = sscanf(_uname.release,"%d.%d.%d", &major, &minor, &fix);   // 拆三个数
_os_version = (major << 16) | (minor << 8) | fix;               // 压成整数
```

`"4.18.0"` → `0x041200`。之后"内核是否 ≥ 4.5"就是一次整数比较,而不是 strcmp。

- [内核: uname 是系统调用,`utsname.release` 是版本字符串。JVM 解析数字部分——if/else 整数比较比字符串比较快一个数量级]
- [man 2 uname]

**关键设计 (斜体)**: *为什么一个 32 位整数?因为内核版本要参与"几十次条件判断"——epoll 要不要用 EPOLL_CLOEXEC、cgroup 走 v1 还是 v2、THP 能不能开,全都按版本号分流。整数比较让每个判断都是一条指令,而且 0x00AABBCC 的布局让 `major` 恰好在高 16 位,`major >= 4` 直接按整数比较即可,不需要移位。*

这个整数存进 `_os_version` 后,整个 JVM 生命周期里所有"内核够不够新"的判断都读它——它是最早被确定、最晚被遗忘的一个全局状态。

### CPU 特性:一条 cpuid 指令,64 位 bitmask 装下全部能力

第二个"我是谁"是问 CPU:`cpuid` 指令(`x86:cpuid — EAX=1 时 ECX/EDX 返回 feature flags bitmask;bit25=SSE, bit28=AVX, bit19=CLFLUSH`)。JVM 在汇编层执行它(`vm_version_x86.cpp:140` 的 `__ cpuid()`),把结果聚合进一个 64 位整数:

```cpp
// abstract_vm_version.hpp:56-67
static uint64_t _features;            // CPU 能力位图,每位一个能力
static bool     _supports_cx8;        // 8 字节 CAS 支持(快查缓存)
// ...
// vm_version_x86.cpp:611,626 —— 初始化与聚合
_features = 0;
...
_features = feature_flags();          // cpuid 结果 → 位图
```

**每一位都是一笔生意**(`abstract_vm_version.hpp:139-152` 的 getter):

- `supports_cx8()` → 没有 8 字节 CAS,JVM 的并发原语全线降级
- AVX 位 → JIT 能不能生成 256 位向量指令(域 15 C2 的指令选择依赖它)
- AES-NI 位 → crypto intrinsic 走硬件还是软件(域 42)

- [x86: cpuid 的 EAX=1 子功能返回 ECX/EDX 两个 32 位寄存器,拼成 64 位。JVM 用 `_features & mask` 的 AND 测试,一条指令判断一个能力]
- [C++: 位图探测比逐个函数探测快——一次 cpuid 拿全,之后全是寄存器 AND。`supports_cx8` 这类高频查询还单独缓存成 bool,避免每次查位图]

**关键设计 (斜体)**: *为什么是"一次探测、终身使用"?cpuid 的结果在进程生命周期内不变,所以启动时测一次存进静态变量,之后所有子系统(JIT/GC/并发原语)只读位图。这避免了每次判断都执行 cpuid(它会让流水线停顿)。*

### 虚拟化:用 TSC 时钟的"呼吸"识别 KVM

第三个"我是谁"最隐蔽——**检测自己是不是跑在虚拟机里**。JVM 维护一个 `VirtualizationType` 枚举(`abstract_vm_version.hpp:31-41`):

```cpp
// abstract_vm_version.hpp:31-41
enum VirtualizationType {
  Unknown,        // 尚未检测
  XenHVM,         // Xen 硬件辅助虚拟化
  KVM,            // Kernel-based Virtual Machine
  VMWare,         // VMware
  HyperV,         // Microsoft Hyper-V
  PowerVM,        // IBM PowerVM
  PowerKVM,       // IBM PowerKVM
  // ...
};
static VirtualizationType _detected_virtualization;   // :76
```

检测方法之一是观察 **TSC(Time Stamp Counter)** 的行为:rdtsc 指令读出自 CPU 上电以来的 cycle 计数。物理机上 TSC 单调递增;KVM 下,VM 被暂停时 TSC 停走,恢复时出现**偏移**。

- [x86: TSC 是周期计数器,rdtsc 指令读取。KVM 的 VM 暂停/恢复会让 TSC 出现跳跃——JVM 的 GC 日志、JFR 时间轴全靠时间测量,知道虚拟化类型才能选对时钟策略]
- [man 2 clock_gettime]

**关键设计 (斜体)**: *为什么要在乎虚拟化?时间测量的精度策略不同——KVM 下 wall clock 可能被 NTP 调整、TSC 可能跳变,JVM 要决定用 CLOCK_MONOTONIC 还是 TSC 作为 elapsed 时间源(`os_linux.hpp:209-228` 的多层时间测量体系)。选错了,JFR 的事件时间轴就会出现"时间倒流"。*

## 2. "我有几个 CPU?" — 物理核数 vs cgroup 配额

### 两个计数:processor_count 与 active_processor_count

JVM 里有两个"CPU 数",含义完全不同(`os.hpp:232-281`):

```cpp
// os.hpp:232-281(截取字段)
static int _processor_count;                    // 物理核心数
static int _initial_active_processor_count;     // 容器配额后的可用数
```

第一个数来自 sysconf:

```cpp
// os_linux.cpp:384
set_processor_count(sysconf(_SC_NPROCESSORS_CONF));
```

- [C++: sysconf(_SC_NPROCESSORS_CONF) 返回所有 CPU(含 offline);_SC_NPROCESSORS_ONLN 只返回 online。JVM 用前者打底]
- [man 3 sysconf]

第二个数在 `os.cpp:1744` 的 `initialize_initial_active_processor_count()` 里确定——**直接把 cgroup 感知的 `active_processor_count()` 结果存下来**(配额处理在 cgroup 层,见第三节):

```cpp
// os.cpp:1744-1748 —— 完整实现
void os::initialize_initial_active_processor_count() {
  assert(_initial_active_processor_count == 0, "Initial active processor count already set.");
  _initial_active_processor_count = active_processor_count();
  log_debug(os)("Initial active processor count set to %d" , _initial_active_processor_count);
}
```

**这两个数的消费方,是整本书后面所有"按机器自动调参"的地方**: GC 并行线程数(域 25)、JIT 编译线程数 `CICompilerCount`(域 03)、JFR 采样频率(域 32)——**全部基于 `active_processor_count`**。16 核物理机,K8s 只给你 2 核,如果 JVM 按 16 开 GC 线程,每个线程都在抢配额,GC 停顿翻倍。

- [内核: CFS(Completely Fair Scheduler)bandwidth control——`cfs_quota_us` 是周期内可用的 CPU 时间,`cfs_period_us` 是统计周期。quota 用完,线程被 throttled 到下一周期]

### cgroup CPU 配额:quota ÷ period,向上取整

配额怎么算?`active_processor_count()`(`cgroupSubsystem_linux.cpp:519` 起,注释完整写了三输入算法)的核心是一行除法:

```cpp
// cgroupSubsystem_linux.cpp:555 起(截取核心)
int CgroupSubsystem::active_processor_count() {
  int quota  = cpu_quota();
  int period = cpu_period();
  if (quota > -1 && period > 0) {
    quota_count = ceilf((float)quota / (float)period);   // 除法,向上取整
  }
  ...
}
```

典型值: `period=100ms`、`quota=200ms` → 2 个 CPU 时间片。`quota=500ms` → 5 核。**一个除法加向上取整,容器给你几个核就出来了**。三输入(affinity/quota/shares)都没有时才退回系统 `active_processor_count()`;quota 和 shares 同时存在时,`PreferContainerQuotaForCPUCount`(默认 true)决定取 quota 还是两者较小值。

### NUMA:把"核"装进"节点"

核数之外,还有拓扑。多 socket 机器上,内存离 CPU 有远近之分:

- [内核: NUMA(Non-Uniform Memory Access)——每个 socket 有本地内存。访问本地内存约 100ns,远端约 200ns。JVM 用 libnuma 把 heap region 分配到本地 node,GC 扫描时少跨节点访问]

JVM 建立两张映射表(`os_linux.hpp:272-306`):`_cpu_to_node`(核→节点)和 `_nindex_to_node`(节点序号→节点)。而 libnuma 是**运行时动态加载**的,而且按符号版本解析:

```cpp
// os_linux.cpp:3423-3433 —— libnuma 符号按版本加载
// Handle request to load libnuma symbol version 1.1 (API v1). If it fails ...
void* os::Linux::libnuma_dlsym(void* handle, const char *name) {
  void *f = dlvsym(handle, name, "libnuma_1.1");
  // ... 失败则试 1.2 (API v2)
}
```

- [C++: dlvsym 按符号版本解析,兼容 libnuma 的 v1/v2 API;动态加载避免编译期硬链接——机器没装 libnuma 时 JVM 也能启动,只是 NUMA 优化降级为关闭]

**关键设计 (斜体)**: *为什么动态加载而不是链接时依赖?NUMA 是性能优化,不是生存必需。动态 dlsym 让 JVM 在没有 libnuma 的环境(大多数容器)里照常启动,有则用、无则弃——"优化必须可降级"是 VM 层的通用原则。*

## 3. "我有多少内存?" — cgroup 限额与自适应堆

### 场景:不设 -Xmx,容器里会怎样

64GB 物理机,容器限额 2GB,JVM 没写 `-Xmx`。如果 JVM 傻乎乎读物理内存 64GB,按默认公式 `PhysicalMemory/4` 把最大堆设成 16GB——**容器 2GB 配额瞬间被打爆,OOM Kill**。这不是段子,是容器化 Java 的第一大事故。

所以 JVM 必须读 cgroup 的限额。**读的方式,是一个策略模式**:

### CgroupSubsystemFactory:一个工厂,两个子系统

cgroup 有 v1/v2 两代,API 完全不兼容:

- [内核: cgroup v1——每个控制器独立挂载点 `/sys/fs/cgroup/cpu/`、`/sys/fs/cgroup/memory/`;cgroup v2——统一挂载点 `/sys/fs/cgroup/`,所有控制器在一个文件里,v2 不需要 mount,内核 4.5+ 默认启用]
- [man 7 cgroups]

JVM 用工厂模式消除这个差异(`cgroupSubsystem_linux.hpp:244-268` + `cgroupSubsystem_linux.cpp:59`):

```cpp
// cgroupSubsystem_linux.cpp:59 起 —— 工厂实际流程(截取)
CgroupSubsystem* CgroupSubsystemFactory::create() {
  // ... 读 /proc/self/mountinfo (:71) + /proc/self/cgroup
  bool valid_cgroup = determine_type(cg_infos, cgroups_v2_enabled, controllers_file, ...);  // :86
  if (is_cgroup_v2(&cg_type_flags)) {        // :94 判 v1/v2
    // ... new CgroupV2Subsystem(...)
  } else {
    // ... new CgroupV1Subsystem(...)
  }
}
```

**关键设计 (斜体)**: *为什么策略模式而不是 if/else 散落各处?cgroup v1/v2 的每个读数(memory 限额、CPU 配额、IO 权重)都有两套路径,if/else 会散落在十几个函数里;工厂 + 子类把"差异"关进两个类,上层代码只面对 `CgroupSubsystem*` 接口——新增 cgroup v3 时只需加一个子类。*

### memory.limit_in_bytes:一个文件,决定堆多大

限额的读法,在 v1 是一个文件、v2 是另一个文件:

```cpp
// cgroupV1Subsystem_linux.cpp:91-92 —— v1 路径
jlong CgroupV1Subsystem::read_memory_limit_in_bytes() {
  GET_CONTAINER_INFO(julong, _memory->controller(), "/memory.limit_in_bytes", ...);
  // v2 对应 /memory.max
```

读出来的 2GB,直接改写 JVM 的堆默认值——`osContainer` 层把限额交给 GC 的自适应堆计算(域 25),替代裸的 `PhysicalMemory/4`。

- [内核: memory cgroup 控制 RSS(Resident Set Size)——进程实际占用的物理页。JVM heap 的 committed 内存计入 RSS,reserved 不计入(因为 MAP_NORESERVE,下一篇的伏笔)]

### cpu.shares:读取时先做"没设置"判定

CPU 份额的读数有个容易误解的实现(`cgroupV1Subsystem_linux.cpp:285-292` 完整实现):

```cpp
int CgroupV1Subsystem::cpu_shares() {
  GET_CONTAINER_INFO(int, _cpu->controller(), "/cpu.shares", ...);
  // Convert 1024 to no shares setup
  if (shares == 1024) return -1;    // 1024 = 基准值 = "没设置",返回 -1
  return shares;
}
```

- [内核: cpu.shares 是相对权重——1024 是基准。两个 cgroup 分别设 1024/512 → CPU 时间 2:1]

**1024 被转换成 -1("未设置")**,因为 1024 就是默认值,等于没配。之后在 `active_processor_count()` 里,shares 参与计算的方式是 `share_count = ceilf(share / PER_CPU_SHARES)`(cgroupSubsystem_linux.cpp:576)——**而且受 `UseContainerCpuShares` 标志控制,默认是 false**:JDK 认为用 shares 推导 CPU 数不可靠(JDK-8281181),默认只用 quota。

### CachedMetric:20ms 缓存,挡住每秒百万次的系统调用

最后一个设计细节:这些读数**不能每次现读**。`new Object()` 分配时可能要查"限额还剩多少",如果每次都读 `/sys/fs/cgroup/...`,一个高分配应用就是每秒百万次文件读。解法是带 TTL 的缓存(`CachedMetric`,`cgroupSubsystem_linux.hpp:213`),调用侧先问"该不该重读"(`should_check_metric()`,20ms TTL 注释在 `osContainer_linux.hpp:35`):

```cpp
// cgroupSubsystem_linux.cpp:561-567 —— active_processor_count 里的缓存用法
CachedMetric* cpu_limit = contrl->metrics_cache();
if (!cpu_limit->should_check_metric()) {
  int val = (int)cpu_limit->value();      // 缓存没过期,直接用
  return val;
}
```

过期判断用 `os::javaTimeNanos()`(`man 2 clock_gettime` 的 monotonic clock)——**不受墙钟调整影响**:管理员手动改系统时间,缓存不会提前失效。

- [C++: monotonic clock 只增不减;wall clock 会被 NTP/manual 调整。TTL 判断必须用前者,否则调时间 = 缓存全失效]

**关键设计 (斜体)**: *为什么 TTL 是 20ms?容器调度周期典型是 100ms——20ms 缓存不会错过真实变化(配额在 100ms 尺度上变),又能挡住 99% 的重复读。这个数字不是拍脑袋:它贴着"变化速度"设计。*

## 看见:探测结果的实物

工具卷里我们已经见过探测结果的实物([卷 T ch05](openjdk/vol-tools/ch05.md) 的 Environment 页)——JMC 读的正是这些探测值:

```
CPU: AMD EPYC 9K65 192-Core Processor, 96 cores, 96 hardware threads
Memory: 59.6 GiB Physical Memory
OS: TencentOS Server 4.2, Linux 5.4.241 x86_64
```

192 核就是 `_processor_count`、59.6GiB 就是物理内存读数、内核 5.4.241 就是 `_os_version` 的解码。**探测是全部后续决策的地基**——GC 线程数、堆大小、时钟策略,全都从这一节的值出发。

## 核心悬念

一个 C++ 程序在 K8s 容器里自动发现"只有 2 核、只能用 2GB 内存"——平台探测回答了这个问题的"看"字。探测只是看;下一篇是"要":JVM 怎么向 OS 要内存?不是 `malloc`,而是 `mmap + MAP_NORESERVE`——先圈地址空间、后按需提交物理页,这就是 `-Xmx` 设 16GB 但进程只占 2GB 的真相。

> → [02-virtual-memory.md](02-virtual-memory.md):reserve → commit → uncommit → release 四态生命周期
