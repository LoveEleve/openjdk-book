# 域 01: OS 抽象层 — 大纲

> 23 KP / 🔴11 + 🟡7 + 🟢5 | ~55 文件 | 非巨型域，1 篇完整文章
> 源码: hotspot/share/runtime/os.* + os/ + os_cpu/

---

### 1. 平台探测 — JVM 如何感知运行环境

- 内核版本编码 — 32 位整数 0x00AABBCC 压缩 major/minor/fix，驱动 epoll/container/signal 的条件编译 (`os_linux.hpp:60`)
- CPU 特性位掩码 — cpuid 指令 + _features bitmask，决定 JIT 指令选择 (SSE/AVX/...) (`abstract_vm_version.hpp:139`)
- 虚拟化环境检测 — VirtualizationType 枚举 (XenHVM/KVM/VMWare/HyperV)，不同 hypervisor 的 TSC 行为差异影响时间测量 (`abstract_vm_version.hpp:31`)
- active_processor_count vs processor_count — 静态核心数 vs 容器 cgroup quota 限制下的动态可用数 (`os.hpp:259`)

*关键设计: 为什么需要 active_processor_count？— 容器/cgroup CPU quota 将 16 核机器限制到 2 核，GC 并行度必须基于受限值而非物理核心数*

### 2. 虚拟内存生命周期 — reserve → commit → uncommit → release

- 四级操作模型 (`os.hpp:296-362`, `os.cpp:1759-1871`)
- reserve_memory: mmap(NULL, MAP_NORESERVE) — 只预留地址空间，不分配物理页 (`os_linux.cpp:4235`)
- commit_memory: mmap(MAP_FIXED|MAP_ANONYMOUS) — 在预留空间中实际分配物理页 (`os_linux.cpp:4333`)
- 为什么不是 malloc/free？— Java heap 需要连续地址空间 (G1 region 的对齐要求) + 按需 commit (lazy allocation)
- MAP_NORESERVE 与 Linux overcommit: vm.overcommit_memory=2 (strict) 时 mmap 必须确保物理页 — JVM 的预期是 overcommit=0 的 heuristic 模式 (`os_linux.cpp:4235`)
- Page fault 的 minor vs major: minor=页已分配只需页表更新 (TLB miss)，major=需要磁盘 I/O (swap in) — JVM Pre-touch 的目的是把 major fault 前置到初始化阶段
- *场景引入: strace -c java -version → 数千次 mmap/mprotect/futex/pthread_create — OS 抽象层的全貌*
- pd_* 平台分发模式: share 层调用 pd_reserve_memory → os_linux 实现 → 上层无感知 (`os.hpp:120-152`)
- Pre-touch 预热: 逐页写零值强制 page fault → 避免 GC 首次访问的多 ms 延迟 (`os.cpp:1873`)
- NMT tracking 集成: 每次 reserve/commit 调用 MemTracker::record_virtual_memory_reserve/commit (`os.cpp:1769`)

*关键设计: 为什么需要 split_reserved_memory？— ParMarkBitMap 需要一个超大连续地址空间，然后按 GC worker 数切成 N 份独立管理的子区域*

### 3. 大页面 — hugeTLB / SHM / THP 三模式

- 多页面大小递减数组 `_page_sizes[max=9]` (`os.hpp:111`)
- page_size_for_region(): 给定 region_size 和最小页数约束，选最大适配页面大小 (`os.cpp:1488`)
- 模式 1 — hugetlbfs: mount -t hugetlbfs → mmap 预留 — 需要 root 预配置 (`os_linux.hpp:93`)
- 模式 2 — SHM: shmget(SHM_HUGETLB) → shmat — IPC 密钥管理 (`os_linux.hpp:99`)
- 模式 3 — THP (Transparent Huge Pages): madvise(MADV_HUGEPAGE) — 零配置但 khugepaged 内核线程异步决策是否合并 4K 页为 2MB 页 (`os_linux.cpp:3932`)
- THP 对 G1 的隐式影响: khugepaged 可能跨越 G1 region 边界 (1-32MB) 合并页面 → region 的独立回收语义被打破 — 这是 G1 禁用 THP (默认) 的原因之一
- G1 heap region 与页面大小的对齐: G1 region size 必须是 page_size 的整数倍

*关键设计: 三种模式对应三种运维复杂度 — THP 最简单但内核可能不分配 huge page，hugetlbfs 保证 huge page 但需要 sysadmin 预留*

### 4. 栈保护多区模型 — Yellow / Red / Reserved / Shadow

- Yellow zone: 可恢复 — 触发 StackOverflowError (Java 异常) (`os.cpp:449`)
- Red zone: 不可恢复 — fatal error + hs_err 输出 (`os.cpp:455`)
- Reserved zone: 保障抛出 StackOverflowError 时还有栈帧可用 (`os.cpp:461`)
- Shadow zone: 信号处理器执行所需的调用栈预留 (`os.cpp:466`)
- 实现: os::guard_memory + os::unguard_memory → mprotect(PROT_NONE) (`os_linux_x86.cpp:358-418`)
- 每线程创建时分配的独立 guard 页: os::create_thread → os::pd_create_stack_guard_pages

*关键设计: 为什么需要四级？单级 guard 要么成功(多余的物理页)要么 crash(无恢复机会)。四级递进: yellow→还能抛异常, red→必死但先输出诊断, reserved→保障异常抛出的栈帧, shadow→保障信号处理器执行(在溢出栈上运行)*

### 5. 线程创建与优先级映射 — 7 种 VM 线程的调度层次

- 7 种 ThreadType: vm_thread, cgc_thread, pgc_thread, java_thread, compiler_thread, watcher_thread, os_thread (`os.hpp:487-495`)
- Java→OS 优先级映射: java_to_os_priority[] 数组 — M:1 映射 (java 11 级 → OS ~3 级) (`os.cpp:217-247`)
- 调度层次设计: WatcherThread(CriticalPriority=11) > VMThread(NearMax=9) > GC(8-9) > Java(Norm=5) (`os.hpp:74-82`)
- os::create_thread → pthread_create + setpriority → pd_start_thread (`os.cpp:988`)
- create_main_thread / create_attached_thread: JNI_CreateJavaVM 入口线程 vs JNI AttachCurrentThread
- osThread 平台对象: osThread_linux — 包装 pthread_t + thread_id (`osThread_linux.hpp:39`)

*关键设计: 为什么 WatcherThread 需要最高优先级？— 它负责周期性地触发 GC/偏向锁撤销/动态重编译/内存采样。如果被其他线程饿死，VM 响应性丧失*

### 6. 同步原语 — PlatformEvent / PlatformParker / PosixSemaphore / SuspendResume

- PlatformEvent: ParkEvent 三态模型 `_event ∈ {-1(signaled), 0(neutral), 1(parked)}` (`os_posix.hpp:170`)
- 伪共享消除: cache 行填充 (64B padding) 将 `_event` 和 `_nParked` 隔离到不同 cache line (`os_posix.hpp:171`)
- PlatformParker: pthread_cond_timedwait with CLOCK_MONOTONIC → Java LockSupport.parkNanos() 的底层 (`os_posix.hpp:198`)
- PosixSemaphore: sem_t 薄封装 — signal(批量)/wait/trywait/timedwait (`semaphore_posix.hpp:33`)
- Suspend/Resume 四态协议: SR_RUNNING → SR_SUSPEND_REQUEST → SR_SUSPENDED → SR_WAKEUP_REQUEST → SR_RUNNING (`os.hpp:993`)
- 超时回退: SUSPEND_REQUEST 不能无限等待 — 被请求 suspend 的线程可能在持有锁时进入 safepoint

*关键设计: 为什么 ParkEvent 用三个状态而不是两个？— 需要区分 "signal-before-park"(两状态不够)和 "park-then-signal"。三态模型的 _event==1(parked) 然后被 signal 设为 0(neutral) 然后被 unpark 设为 -1(signaled)*

### 7. 信号处理框架 — 信号链 + SIGSEGV 五阶段分发

- libjsig 信号链: 拦截 sigaction → 保存原始 handler → JVM handler → 链式调用 (`os.cpp:810`)
- SIGPIPE/SIGXFSZ: 先链到原始 handler → 再 install_ignored (双重保障) (`os_linux.cpp:4880`)
- SIGBREAK → AttachListener: signal_thread_entry → AttachListener::is_init_trigger() → thread dump (`os_linux.cpp:4938`)
- SIGSEGV 五阶段分发 (`os_linux_x86.cpp:268-512`):
  1. stack overflow check — 是否 hit 栈 guard 页？→ StackOverflowError 或 fatal
  2. safepoint poll — 是否 hit safepoint polling page？→ 进入 safepoint
  3. null check — 是否 null pointer？→ implicit null check in compiled code
  4. serialize page — 是否 hit memory serialization page？→ 重执行 load 指令
  5. crash — 以上都不是 → hs_err_pid.log 输出 (寄存器状态/栈帧/内存映射/加载的动态库/线程列表) + core dump (`os_linux_x86.cpp:512`)
- ThreadCrashProtection: sigsetjmp/siglongjmp → WatcherThread 回调中的安全恢复 (`os_posix.hpp:143`)

*关键设计: 为什么一个 SIGSEGV handler 要处理五种可能？— x86 没有硬件 null check。JIT 编译器生成 `mov [0], rX`→ 触发 SIGSEGV → handler 识别是 null check → 跳转到 uncommon trap。这是用信号异常替代显式条件分支的极致性能优化*
*crash log 的价值: hs_err 不只是报错 — 它是对 JVM 死亡瞬间的完整快照：正在运行什么 Java 线程、每个线程的 native stack、JIT 编译了哪些方法、GC 的历史日志。定位 production crash 时 hs_err 是唯一的线索*

### 8. Safepoint 轮询页 + 内存序列化页 — 无锁线程协调

- Safepoint polling page: 专用内存页 → safepoint 请求时设为 PROT_NONE → 线程执行 `test` 指令触发 SIGSEGV (`os.hpp:427-431`)
- 为什么是页面权限而不是显式变量？— JIT 编译的代码只需 `test [polling_page], %rax` (4 字节)，无需 cmp+jmp 分支
- make_polling_page_unreadable/readable: mprotect(PROT_NONE) / mprotect(PROT_READ) (`os_linux_x86.cpp:431`)
- Memory serialization page: UseMembar=false 时替代 mfence — 页面切换 (RW→RO→RW) 提供隐含的 store-load barrier (`os.hpp:437-484`)
- 每线程独立 cache line 偏移: thread address >> shift & mask → 避免所有线程写同一个 cache line

*关键设计: polling page 是 JIT 编译代码零开销 safepoint check 的基石 — 没有分支预测失败惩罚，正常路径零额外指令*

### 9. Container/Cgroup 资源感知 — 策略模式自动检测 v1/v2

- CgroupSubsystemFactory: 检测 /sys/fs/cgroup 类型 → 创建 CgroupV1Subsystem 或 CgroupV2Subsystem (`cgroupSubsystem_linux.hpp:244`)
- CachedMetric: 20ms TTL 缓存 — 避免每次分配都读 /sys/fs/cgroup (`osContainer_linux.hpp:78`)
- PER_CPU_SHARES: /sys/fs/cgroup/cpu/cpu.shares → 标准化为每 CPU 1024 (`cgroupV1Subsystem_linux.cpp:295`)
- memory_limit_in_bytes: 驱动的自适应 heap sizing (`cgroupV1Subsystem_linux.cpp:271`)
- active_processor_count: CPU quota (cfs_quota_us/cfs_period_us) → 向上取整 (`cgroupSubsystem_linux.cpp:142`)

*关键设计: 为什么 20ms 缓存？— 容器调度周期典型 100ms。小于 100ms 的缓存不会错过真实变化,但避免每次 new Object() 都读 sysfs 的系统调用开销*

### 10. 辅助机制 — 时间 / 动态库 / 内存分配 / 性能监控

- 多层时间体系: javaTimeMillis (wall clock) / javaTimeNanos (monotonic) / elapsed_counter (TSC/HPET) / elapsedVTime (thread CPU) (`os.hpp:188-218`)
- 动态库加载: dll_load (dlopen) → dll_lookup (dlsym) → find_builtin_agent (静态链入检测) (`os.hpp:653-685`)
- os::malloc: NMT header 前置 64B + MemTracker::record_malloc → ::malloc → GuardedMemory canary (DEBUG) (`os.cpp:681-798`)
- 性能监控: CPUInformation (sockets/cores/threads) → CPUPerformance (load/ctx switch) → NetworkPerformance → 全部解析 /proc (`os_perf.hpp:61`)
- 内存映射文件: mmap + AllocateHeapAt (-XX:HeapDir 支持) (`os.hpp:379-396`)

---

### 核心悬念

**"JVM 如何在裸机上造出一个稳定的 Java 运行时？"** — OS 抽象层是 JVM 与 Linux 内核之间唯一的接触点：虚拟内存的按需 commit 让 Java heap 可以看似无限但实际按 GC 节奏分配，SIGSEGV 的五个阶段让硬件异常变成 Java 异常/安全点/JIT null check，轮询页让所有线程在 4 字节指令内完成安全点协作——这些设计在 Linux 的 mmap/signal/pthread 之上构建了 Java 语义所需的一切。