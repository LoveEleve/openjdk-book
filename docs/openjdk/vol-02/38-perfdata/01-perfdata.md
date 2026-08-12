# 01. PerfData 架构 — jstat 的数据从哪来

> **前置依赖**:[16-codecache/05 — Dependencies 与 Deopt](openjdk/vol-02/16-code-cache/05-dependencies-deopt.md):16 域收官后进入观测域;vol-tools 已演示 jstat 的用法
> → **后续**:[02 — StatSampler](02-stat-sampler.md)
> 关联域: 18-safepoint(部分计数器在 safepoint 采样)、39-runtime-mon(另一条观测通道)、32-jfr(事件采样)

## jstat 凭什么每秒看到 GC 数字

`jstat -gc <pid> 1000` 每秒吐一行: YGC、YGCT、FGC……这些数字不是 JMX 拉取的,也不是 JVM 主动上报的——**JVM 把计数器写进一块共享内存,jstat 在另一个进程里直接读同一块内存**。中间没有任何 IPC、没有 socket、没有序列化: 写的一方是普通内存写,读的一方是普通内存读。这篇拆开这块共享内存: 计数器长什么样(PerfData)、文件怎么建怎么映射(PerfMemory)、以及"无锁"是怎么做到的。

## 1. 计数器模型: 对象在 C 堆,值在共享区

### 三种可变性,六种单位

每个计数器是一个 `PerfData` 对象(perfData.hpp:244 起),核心属性两个:

- **可变性**(Variability,perfData.hpp:255-262): `V_Constant`(创建时写一次)/`V_Monotonic`(单调变化,只增或只减)/`V_Variable`(随意改);
- **单位**(Units,perfData.hpp:266-273): `U_None`/`U_Bytes`/`U_Ticks`/`U_Events`/`U_String`/`U_Hertz`。

类层次按"类型 × 可变性"组合(注释 perfData.hpp:97-107,截取):

```cpp
// perfData.hpp:97-107(截取注释,逐字)
 * - PerfData (Abstract)
 *     - PerfLong (Abstract)
 *         - PerfLongConstant        (alias: PerfConstant)
 *         - PerfLongVariant (Abstract)
 *             - PerfLongVariable    (alias: PerfVariable)
 *             - PerfLongCounter     (alias: PerfCounter)
 *
 *     - PerfByteArray (Abstract)
 *         - PerfString (Abstract)
 *             - PerfStringVariable
 *             - PerfStringConstant
```

`PerfCounter`(单调 jlong)、`PerfVariable`(可改 jlong)、`PerfConstant`(常量)、`PerfString`(字节数组)就是这套组合的常用别名。

### 一个关键的分层: 对象与值分开住

简单把计数器理解成"一块内存"并不完整——**PerfData 对象本身在 C 堆**,它的值 `_valuep` 指向**共享内存区域里的对应位置**(perfData.hpp:289-291,注释原文 "returns the address of the data portion of the item in the PerfData memory region")。共享区里放的是 `PerfDataEntry`(perfMemory.hpp:78-98): 一个固定头(entry_length/name_offset/vector_length/data_type/flags/data_units/data_variability/data_offset)+ 变长 body(name + padding + 数据)。这个布局是**对外契约**——perfMemory.hpp:55-56 注释原文 "The PerfDataPrologue structure is known by the PerfDataBuffer Java class libraries that read the PerfData memory region",jstat 侧的 Java 代码按这个结构解析。

`PerfData::create_entry`(perfData.cpp:125 起)负责在共享区里铺条目: 头 + 名字 + 对齐 + 数据,**数据按 8 字节对齐**(perfData.cpp:151-153,`align = sizeof(jlong) - 1`)。共享区内存不够时退回 C 堆(`_on_c_heap = true`,perfData.cpp:159-161)——没了共享区,jstat 就看不到它,但 JVM 照常工作。

### 谁创建了计数器

不是 PerfDataManager 集中造好的一批——是**各子系统在初始化时各自注册**: GC 的 `CollectorCounters` 建 `sun.gc.collector.<n>.time/invocations/lastEntryTime/lastExitTime`(collectorCounters.cpp:43-58,名称空间按 `name_space("collector", ordinal)`,perfData.cpp:373-377),StatSampler 建 `sun.rt.javaCommand`/`sun.os.hrt.ticks`(statSampler.cpp:322-324/:356-359)……注册入口是 `PerfDataManager::create_xxx`(perfData.cpp:506 起),它把对象挂进三个列表(`_all`/`_sampled`/`_constants`,perfData.cpp:40-42),并把值写进共享区。

**关键设计 (斜体)**: *对象与值分离,是"生产者本地、消费者远端"模型的核心: JVM 内部照常用 C++ 对象操作计数器(inc/add 直接写 `_valuep`),外部进程只认共享区里的二进制布局——对象是 JVM 的私事,布局是公共契约。*

## 2. PerfMemory: 一个文件,一块共享内存

### 文件与映射

Linux 上的共享内存实现是"文件做名字空间的 mmap"(注释 perfMemory_linux.cpp:127-132 原文 "the solaris and linux shared memory implementation uses the mmap interface with a backing store file to implement named shared memory")。文件路径:`/tmp/hsperfdata_<user>/<pid>`(`PERFDATA_NAME = "hsperfdata"`,perfMemory.cpp:43;容器内走 `/proc/{vmid}/root/tmp/...`,perfMemory_linux.cpp:142-146)。

创建路径(`mmap_create_shared`,perfMemory_linux.cpp:1056 起):

```cpp
// perfMemory_linux.cpp:1056-1092(截取核心,逐字)
  int vmid = os::current_process_id();

  char* user_name = get_user_name(geteuid());

  if (user_name == NULL)
    return NULL;

  char* dirname = get_user_tmp_dir(user_name, vmid, -1);
  char* filename = get_sharedmem_filename(dirname, vmid, -1);
  ...
  // cleanup any stale shared memory files
  cleanup_sharedmem_files(dirname);
  ...
  fd = create_sharedmem_file(dirname, short_filename, size);
  ...
  mapAddress = (char*)::mmap((char*)0, size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);
```

写进程 `mmap(MAP_SHARED, PROT_READ|PROT_WRITE)`;读进程(jstat)用 `mmap_attach_shared`(perfMemory_linux.cpp:1210 起)只读映射同一文件。两块映射指向同一组物理页——这就是"共享内存"。

### 权限: 目录可以看,文件不能碰

隔离靠的是**文件权限**,不是目录权限:

- 目录 `/tmp/hsperfdata_<user>` 以 **0755** 创建(perfMemory_linux.cpp:852-853 注释原文 "create the directory with 0755 permissions. note that the directory will be owned by euid::egid")——任何人都能进目录、能列出文件名;
- 文件 `<pid>` 以 **0600** 创建(`open(filename, O_RDWR|O_CREAT|O_NOFOLLOW, S_IRUSR|S_IWUSR)`,perfMemory_linux.cpp:909)——**只有创建者(同 uid 的 JVM)能读写**。

两个附加防线: 创建/打开前做 `is_directory_secure`(:240)/`is_file_secure`(:417)检查(防 symlink 攻击),以及容器场景的 `flock` 竞争处理——多个容器进程共享 /tmp 且 pid 相同时,只有抢到 `flock` 锁的进程写文件,其余禁用 perfdata(perfMemory_linux.cpp:938-942 注释原文 "we allow only one of them (the winner of the flock() call) to write to the file")。

**关键设计 (斜体)**: *目录 0755 + 文件 0600 的组合是刻意的: 目录公开是为了让监控工具能发现"有哪些 JVM 在跑"(列目录找 pid 文件),文件私有是为了让数据只有同用户能读;0600 只对 owner 开放,不同用户的 JVM 互相看不见。*

### 布局与生命周期

映射内存的最前面是 `PerfDataPrologue`(perfMemory.hpp:62-74): magic(`0xcafec0c0`)、字节序、主次版本(当前 2.0)、`accessible`(就绪标志)、used/overflow、`entry_offset`(第一条目的偏移)与 `num_entries`。读方先读 prologue,再从 `entry_offset` 起遍历 PerfDataEntry。

文件何时消失: JVM 退出时 `PerfMemory::destroy` → `delete_shared_memory` → `remove_file`(perfMemory_linux.cpp:1136-1146,unlink 掉 backing file)。进程崩溃时文件残留,下次 JVM 启动会 `cleanup_sharedmem_files` 清理过期文件(mmap_create_shared 里的调用)。

## 3. 无锁协议: 对齐写 + 单调语义

### 为什么不需要锁

两个进程读写同一块内存,为什么不需要锁或原子指令?答案分两层:

1. **写是原子的**: 计数器值 8 字节对齐(create_entry 的对齐逻辑),x86-64 上对齐的 64 位 store 天然原子——`PerfLongVariant::inc/add` 就是 `(*(jlong*)_valuep)++`(perfData.hpp:416-419),普通内存写,没有锁也没有 `Atomic::` 包装;
2. **读方容忍旧值**: jstat 读到的可能不是最新值(缓存一致性保证最终可见,不保证读到的就是刚写的那次)——但计数器大多是单调的(GC 次数、累计时间),读到稍旧的值没有语义错误。jstat 每秒采一次,本来就不需要纳秒级精确。

### 边界在哪

这套"无锁"的适用范围是**标量 64 位计数器**。两个例外要说明: ①`sample()` 类的采样计数器由 StatSampler 周期写入(值来源是 helper,perfData.cpp:216-220,02 篇展开);②prologue 的 `accessible` 标志在 **VM 启动完成时**才置位(management.cpp:205-207),结构每次修改后 `mark_updated` 更新 `mod_time_stamp`(perfMemory.cpp:235-240)——读方靠这两个字段判断"数据是否就绪、结构是否变过",不是热路径上的并发协议。

[实证:] 素材库的 jstat 输出(materials/commands/jstat-gc.txt)每列都对应一类计数器: YGC/YGCT(次数/累计时间,U_Events/U_Ticks)、S0C/EC/OC(容量,U_Bytes)……jstat 就是读共享内存、按 Prologue/Entry 布局把这些值格式化出来的;`-XX:+PerfDataSaveToFile` 类的转储选项(perfMemory_linux.cpp:81-89 的 `save_memory_to_file`)能把这块内存原样落盘。

## 核心悬念

观测通道的骨架到齐: 计数器对象在 C 堆、值在共享区,`sun.gc.collector.0.time` 这类名字由各子系统注册;PerfMemory 用 `/tmp/hsperfdata_<user>/<pid>` 文件做 mmap 名字空间,目录 0755 文件 0600;64 位对齐写 + 单调语义让读方无锁。但还有一个环节没讲: 谁在"周期性"地把内部状态刷进这些计数器?jstat 每次看到的都是最新值吗?采样线程怎么不干扰业务线程?——下一篇: StatSampler——周期性刷新与同步协议。

> → [02-stat-sampler.md](02-stat-sampler.md)
