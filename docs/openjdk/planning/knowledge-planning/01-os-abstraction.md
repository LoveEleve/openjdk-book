# 域 01: OS 抽象层 — 知识规划

> 源码路径: hotspot/share/runtime/os.* + hotspot/os/linux/ + hotspot/os/posix/ + hotspot/os_cpu/linux_x86/
> 源码量: share 11 + os/linux ~21 + os/posix 7 + os_cpu/linux_x86 16 = ~55 文件
> 提取日期: 2026-08-08

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| os.hpp:296-362 + os.cpp:1759-1871 | **四态虚拟内存生命周期**: reserve → commit → uncommit → release 四级操作，通过 pd_* 平台相关实现+NMT tracking 集成 | High |
| os.hpp:103,111-117,310-318 + os.cpp:1488-1512 | **多页面大小递减数组**: _page_sizes[max=9] 降序排列(末尾 sentinel=0)，page_size_for_region() 在满足 min_pages 约束下选最大适配页面大小 | High |
| os.hpp:108,437-484 + os.cpp:1426-1468 | **内存序列化页(Memory Serialize Page)**: 以页面权限切换(RW→RO→RW)替代 memory barrier 实现跨线程状态序列化；每线程独立 cache line 偏移量消除伪共享 | High |
| os.hpp:107,427-431 + os_linux_x86.cpp:431-432 | **Safepoint 轮询页(Polling Page)**: 专用内存页在 safepoint 请求时设为不可读，线程定期加载触发 SIGSEGV → 信号处理器路由到 poll stub 进入 safepoint | High |
| os.cpp:449-466,1472-1486 + os_linux_x86.cpp:358-418 | **栈保护多区模型(Yellow/Red/Reserved/Shadow Zones)**: 四级栈保护区——yellow(溢出预警/StackOverflowError)、red(不可恢复/fatal)、reserved(关键操作保护区)、shadow(异常处理器调用栈预留) | High |
| os.cpp:1873-1877 | **Pre-touch 内存预热**: 逐页写入零值迫使 OS 立即分配物理页，避免后续首次访问的 lazy allocation 延迟 | High |
| os.hpp:487-495,74-82,929-930 + os.cpp:217-247 | **线程类型枚举 + Java→OS 优先级双向映射**: 7 种 VM 线程类型(vm_thread/cgc/pgc/java/compiler/watcher/os_thread)，java_to_os_priority[] 数组实现 M:1 优先级映射，含反向查找 | High |
| os.hpp:993-1048 | **Suspend/Resume 四态协议状态机**: SR_RUNNING → SR_SUSPEND_REQUEST → SR_SUSPENDED → SR_WAKEUP_REQUEST → SR_RUNNING，含超时回退(RUNNING/SUSPEND_REQUEST 均可回退) | High |
| os.hpp:232-281,399-406 + os_linux.hpp:272-306,57-58 | **CPU 拓扑检测 + NUMA 感知**: processor_count/active_processor_count 静态+动态计数；cpu_to_node/nindex_to_node 映射表；libnuma 动态加载(dlsym) + v1/v2 API 兼容 | High |
| os.hpp:188-218 + os_linux.hpp:209-228 | **多层时间测量体系**: javaTimeMillis(ms)→javaTimeNanos(ns)→elapsed_counter(HPET/TSC)→monotonic clock 检测→fast_thread_cpu_time(clock_gettime with clockid) | High |
| osContainer_linux.hpp + cgroupSubsystem_linux.hpp + cgroupV{1,2}Subsystem_linux.* | **Container/Cgroup 资源感知(策略模式+缓存)**: CgroupSubsystemFactory 自动检测 cgroup v1/v2 → 创建对应子系统 → CachedMetric 20ms 缓存避免频繁读 /sys/fs/cgroup；PER_CPU_SHARES=1024 云框架标准化转换 | High |
| os.hpp:823-831 + os_linux_x86.cpp:268-512 + jvm_posix.cpp | **信号处理框架(链式+三阶段分发)**: libjsig 拦截 sigaction 实现信号链；SIGPIPE/SIGXFSZ 先链→再忽略；Java 层 SIGBREAK→AttachListener 触发→thread dump；SIGSEGV 阶段1:栈溢出→阶段2:safepoint轮询→阶段3:null检查→阶段4:序列化页→阶段5:crash | High |
| os.hpp:653-685 + os.cpp:524-625 | **动态库加载与符号解析**: dll_load/dll_lookup/dll_unload 平台无关封装；dll_address_to_function_name(dladdr)→dll_address_to_library_name 地址反查；find_builtin_agent 静态链接 agent 检测(查找 Agent_OnLoad_<libname> 符号) | High |
| os_posix.hpp:143-159 | **ThreadCrashProtection (sigsetjmp/siglongjmp 保护)**: WatcherThread 回调执行中的 SIGSEGV/SIGBUS 安全恢复——在受保护区域外 sigsetjmp 设置跳转点，信号来临时 siglongjmp 回弹 | High |
| os.hpp:379-396 + os.cpp:1759-1790 | **内存映射文件 + 堆文件分配**: map_memory→remap_memory→unmap_memory 完整 mmap 封装；AllocateHeapAt(-XX:HeapDir)文件支持 | High |
| os_posix.hpp:170-221 | **PlatformEvent/PlatformParker(POSIX condvar+mutex 同步原语)**: ParkEvent 三态模型(_event=-1/0/1, _nParked=0/1)+cache 行填充；PlatformParker 双 condvar(相对/绝对时间) 实现 | High |
| semaphore_posix.hpp:33-50 | **PosixSemaphore (C++ 封装 POSIX sem_t)**: signal(可批量)/wait/trywait/timedwait 薄封装，非拷贝 | High |
| os.hpp:370-378 + os.cpp:1456-1468 | **内存保护操作(protect/guard/unguard)**: MEM_PROT_NONE/READ/RW/RWX 四级保护原语；guard/unguard 为栈保护页底层；序列化页通过 protect 切换权限 | High |
| os.hpp:409-424 + os_linux.hpp:93-108 | **大页面三模式支持**: (1) hugetlbfs-based reserve_memory_special_huge_tlbfs (2) SHM-based reserve_memory_special_shm (3) Transparent Huge Pages 自动模式+sanity_check | High |
| abstract_vm_version.hpp:31-41,56-67,139-152 | **虚拟化环境检测 + CPU 原子指令能力探测**: VirtualizationType 枚举(XenHVM/KVM/VMWare/HyperV/PowerVM/PowerKVM)；CPU feature bitmask(_features)；supports_cx8/atomic_getset4/getset8/getadd4/getadd8；L1 cache line size | High |
| os_perf.hpp:61-288 + os_perf_linux.cpp | **性能监控接口体系**: CPUInformation(sockets/cores/threads)→CPUPerformance(CPU load/context switch rate)→NetworkPerformance(bytes in/out)→SystemProcess monitoring；基于 /proc/stat 和 /proc/[pid]/stat | High |
| os.cpp:681-798 | **os::malloc 分配器(NMT 集成+ GuardedMemory 调试+ MallocMaxTestWords OOM 测试)**: NMT header 前置+MemTracker 记录→::malloc→GuardedMemory 边界检测(DEBUG)→MallocMaxTestWords 模拟 OOM | High |
| os_linux.hpp:60-66,229-231 | **Linux 内核版本编码检测**: 32 位编码(0x00AABBCC: AA=major, BB=minor, CC=fix)，通过 uname 解析并缓存，驱动特性条件编译 | High |

*23 个知识点*

---

## 02 聚合 — 跨文件汇总

> OS 抽象层的聚合维度特殊：share/ 定义接口 + 各平台层提供 pd_* 实现。同一机制跨越 share + linux + posix + linux_x86 四层时视为跨文件。

### P1 — 系统级共识 (≥5 文件)

| KP | 出现文件 | 跨层说明 |
|----|---------|---------|
| 虚拟内存生命周期 (reserve→commit→uncommit→release) | os.hpp.cpp, os_linux.hpp.cpp, os_posix.hpp.cpp, os_linux_x86.cpp, os.inline.hpp | share 定义公共接口 (reserve_memory/commit_memory 等) + pd_* 平台实现 — 是全部内存子系统 (GC/Compiler/Metaspace) 的底层 |
| 信号处理框架 (SIGSEGV 五阶段分发) | os.cpp, os_linux.cpp, os_linux_x86.cpp, jvm_posix.cpp, libjsig | 信号链机制 (libjsig 拦截 sigaction) 被 JVM/Attach/JVMTI/JFR 全部依赖 |
| CPU 拓扑 + NUMA | os.hpp.cpp, os_linux.hpp.cpp, os_linux_x86.cpp, assember_linux_x86.cpp, thread_linux_x86.cpp | processor_count 被 GC 并行度/编译器线程数/JFR 采样频率全部引用 |
| 线程创建与生命周期 | os.hpp.cpp, os_linux.cpp, os_posix.cpp, thread_linux_x86.cpp, osThread_linux.hpp.cpp | create_thread 被全部 VM 子系统调用 (VMThread/GC/Compiler/Watcher/Java) |

### P2 — 局部重要 (2-4 文件)

| KP | 出现文件 |
|----|---------|
| Safepoint 轮询页 | os.hpp.cpp, os_linux_x86.cpp — 定义在 os 层但消费在 interpreter 和 compiled code 的 safepoint check |
| 大页面三模式 (hugeTLB/SHM/THP) | os.hpp.cpp, os_linux.hpp.cpp — 被 GC heap/CodeCache/Metaspace 使用 |
| 栈保护多区模型 (Yellow/Red/Reserved/Shadow) | os.cpp, os_linux_x86.cpp — 每 Java 线程创建时调用 |
| 时间测量体系 | os.hpp.cpp, os_linux.hpp.cpp — 被 GC 日志/JFR/JMX 全部依赖 |
| 内存保护操作 (protect/guard/unguard) | os.hpp.cpp — 序列化页/栈 guard 底层 |
| 内存映射文件 (mmap) | os.hpp.cpp, os_linux.cpp — CDS/JIMAGE 直接依赖 |
| 动态库加载 (dll_load/lookup/unload) | os.hpp.cpp, os_linux.cpp — JVMTI agent/attach 加载依赖 |
| 性能监控接口 | os_perf.hpp, os_perf_linux.cpp — 被 PerfData/JMX/JFR 消费 |
| os::malloc 分配器 + NMT | os.cpp — 最底层 C++ 堆分配，所有 VM 数据结构隐含依赖 |
| Suspend/Resume 四态协议 | os.hpp.cpp — 被 safepoint/deopt/stack walk/JVMTI 引用 |
| PlatformEvent/PlatformParker | os_posix.hpp.cpp — ParkEvent 被 mutex/synchronizer 使用；Parker 被 Unsafe.park() 调用 |

### P3 — 孤立或专项 (1 文件/小子系统)

| KP | 文件 | 说明 |
|----|------|------|
| Container/Cgroup 资源感知 | osContainer + cgroupSubsystem + cgroupV{1,2}Subsystem (6 文件) | 策略模式子系统 — 文件集中但功能专项 |
| 虚拟化环境检测 + CPU 原子指令 | abstract_vm_version.hpp.cpp, vm_version.hpp.cpp | VM 版本探测独立子系统 |
| 内存序列化页 | os.hpp.cpp | 单文件实现但被全部线程使用 |
| Pre-touch 内存预热 | os.cpp | 工具函数 |
| PosixSemaphore | semaphore_posix.hpp.cpp | POSIX sem_t 薄封装 |
| ThreadCrashProtection | os_posix.hpp | WatcherThread 异常恢复 |
| Linux 内核版本检测 | os_linux.hpp | uname 解析 |

---

## 03 深度分类

### 🔴 Deep — 承载核心设计决策 (11 KP)

| KP | 为什么 🔴 |
|----|---------|
| 虚拟内存生命周期 (reserve→commit→uncommit→release) | **数据结构选择**: 为什么不是 malloc/free 而是 mmap？→ Java heap 需要地址空间预留+按需 commit 的双阶段模型。影响 GC Region 分配、Metaspace 扩容、CodeCache 刷新 |
| 大页面三模式 (hugeTLB/SHM/THP) | **内存管理策略**: 三种大页面获取方式对应三种运维成本模型——TLB miss 减少 vs 内存碎片 vs 配置复杂度。直接影响 G1 heap region 的对齐和 GC 停顿时间 |
| Safepoint 轮询页 | **并发策略**: 为什么用页面权限 (SIGSEGV) 而不是显式变量检查？→ 无 branch，JIT 编译的代码零开销直到 safepoint 真正请求 |
| 信号处理框架 (SIGSEGV 五阶段分发) | **异常处理策略**: 一个 SIGSEGV 信号处理器的五个阶段——从栈溢出→safepoint→null check→序列化页→crash——体现了"可能性排除"的故障诊断模式 |
| CPU 拓扑 + NUMA | **并发策略**: processor_count 被 GC 线程数/Compiler 线程数/JFR 采样率全部依赖。为什么需要 active_processor_count？→ 容器/cgroup CPU quota 限制 |
| Container/Cgroup 资源感知 | **架构决策**: 为什么用策略模式 (Factory → Subsystem) 而不是 if/else？→ cgroup v1/v2 API 完全不兼容。20ms 缓存为什么是这个值？→ 容器调度周期通常是 100ms |
| Stack guard 多区模型 | **并发策略**: 为什么需要四级而不是一级？yellow→recoverable StackOverflowError (抛异常); red→fatal; reserved→保障抛出 StackOverflowError 时还有栈可用; shadow→保障信号处理器在溢出栈上执行 |
| PlatformEvent/PlatformParker | **并发策略**: ParkEvent 三态模型 (_event=-1/0/1) — 为什么不用 POSIX semaphore 直接实现？→ 需要支持绝对时间超时 (pthread_cond_timedwait with CLOCK_MONOTONIC) |
| Suspend/Resume 四态协议 | **并发策略**: 为什么中间态 (SUSPEND_REQUEST) 和超时回退？→ suspend 不能阻塞 safepoint — 线程可能在持有锁时被请求 suspend |
| 虚拟化环境检测 + CPU 原子指令 | **数据结构选择**: CPU feature bitmask 被 JIT 指令选择 (SSE/AVX/...) 依赖。为什么需要检测虚拟化类型？→ KVM/Xen 的不同 TSC 行为影响时间测量 |
| 内核版本编码检测 | **兼容策略**: 为什么用 32 位编码 (0x00AABBCC)？→ Linux 3.x→4.x 的 epoll/container 系统调用兼容差异需要精确到 fix 版本 |

### 🟡 Working — 有设计但非核心 (7 KP)

| KP | 说明 |
|----|------|
| 线程创建 + Java↔OS 优先级映射 | 7 种线程类型的优先级分配策略体现了 VM 内部线程的调度层次 (WatcherThread > VMThread > GC > Java) |
| 时间测量体系 | 多层 clock 源选择 (monotonic vs wall clock vs thread CPU time) 有设计决策但更多是系统调用封装 |
| 内存保护操作 (protect/guard/unguard) | mprotect 封装，关键但薄 |
| 内存映射文件 (mmap) | open/mmap/munmap 封装，被 CDS/JIMAGE 使用但自身无特殊策略 |
| 动态库加载 (dll_load) | dlopen/dlsym 封装 + builtin agent 检测，薄封装 |
| 性能监控接口 | /proc 文件系统解析，提供 CPU/内存/网络计数 |
| os::malloc 分配器 + NMT | NMT header 前置 + GuardedMemory + MallocMaxTestWords OOM 模拟——主要是追踪/调试能力，非核心分配策略 |

### 🟢 Surface — 了解即可 (5 KP)

| KP | 放在哪 |
|----|------|
| 内存序列化页 | 跟随 🔴 Safepoint 轮询页一起讲（互补机制——轮询页走信号路径，序列化页走页面保护路径） |
| Pre-touch 内存预热 | 跟随 🔴 虚拟内存生命周期 (commit 阶段的可选步骤) |
| PosixSemaphore | 跟随 🟡 线程同步原语中作为其中之一 |
| ThreadCrashProtection | 跟随 🔴 信号处理框架 (sigsetjmp/siglongjmp 作为信号处理中的一个模式) |
| Linux 内核版本检测 | 跟随 🔴 内核版本编码（一个函数，放在系统环境检测部分） |

---

## 04 聚类 — 教学顺序与文章拆分

### 依赖图

```
A: 平台探测                          ← 无前置依赖
  ├─ B: 虚拟内存                                ← 依赖 A (page_size 来自内核)
  │    ├─ C: 栈保护                             ← 依赖 B (栈内存也是 VM)
  │    └─ D: 大页面                             ← 依赖 B (建立在 reserve/commit 之上)
  ├─ E: 线程抽象                                ← 依赖 A (CPU 拓扑)
  │    ├─ F: 同步原语 (Event/Parker/Semaphore)   ← 依赖 E (线程是 Park 的上下文)
  │    └─ G: Suspend/Resume                      ← 依赖 E+F (suspend 需要 notify 唤醒)
  ├─ H: 信号框架                                ← 依赖 A (内核信号 API)
  │    ├─ I: Safepoint 轮询                      ← 依赖 H (SIGSEGV 是入口) + 依赖 E (线程是执行上下文)
  │    └─ J: ThreadCrashProtection               ← 依赖 H (sigsetjmp)
  ├─ K: Container 感知                           ← 依赖 A (cgroup 来自内核)
  ├─ L: 时间测量                                 ← 依赖 A (clock 源来自内核)
  ├─ M: 辅助机制 (dll_load, malloc, perf, mmap)   ← 依赖 B (malloc 基于虚拟内存)
  └─ N: 虚拟化 + CPU 特性                        ← 依赖 A (cpuid 指令)
```

### 教学顺序

```
1. 平台探测 (内核版本 + 虚拟化检测 + CPU 特性)     ← 先建立"VM 怎么看 OS"的认知框架
2. 虚拟内存生命周期 (reserve→commit→uncommit→release) ← 全 VM 的基础内存操作
3. 大页面 (hugeTLB/SHM/THP)                     ← 从基础虚拟内存扩展到优化路径
4. 栈保护多区模型                                ← 从堆内存切换到线程栈
5. 线程创建与优先级映射                           ← 从内存转向线程
6. 同步原语 (PlatformEvent/Parker/PosixSemaphore/SuspendResume)
7. 信号处理框架 (信号链 + SIGSEGV 五阶段)
8. Safepoint 轮询页 + 内存序列化页                ← 信号框架的最高价值应用
9. Container/Cgroup 资源感知                     ← 云原生必须
10. 其他机制 (时间测量 / dll / malloc / 性能监控) ← 作为收尾参考
```

### 文章拆分建议

非巨型域 (~55 文件/23 KP)，建议 **1 篇完整文章**（预计 ~200-250 行 TOC 大纲），按教学顺序组织即可。

按叙事逻辑自然分为两大块：
- **上半场 (1-6)**: "OS 如何管理内存和线程" — 虚拟内存 → 大页面 → 栈 → 线程 → 同步
- **下半场 (7-10)**: "OS 如何感知 VM 需求" — 信号 → safepoint → container → 辅助

---

## 05 方案选择

**深度策略**: 🔴 Deep — 11 个核心机制需要深挖设计决策（为什么选这个数据结构/并发策略/内存模型？）

**写作方案**: 自上而下 (Top-Down) — 先建立 OS 抽象层的全景图（平台探测），再逐层深入虚拟内存/线程/信号/container 子系统

**关键横切**: 
- Safepoint 轮询 — 域 1 (OS) 定义机制，但域 18 (Safepoint) 提供 safepoint 请求和线程协调
- PlatformEvent/Parker — 域 1 (OS) 实现底层同步原语，但消费方是域 19 (Synchronization) 的 mutex/synchronizer
- os::malloc + NMT — 域 1 (OS) 提供分配器，但追踪逻辑在域 34 (NMT)
- Container 感知 — CPU/memory limits 被域 25 (GC Framework) 用于自适应 heap sizing

