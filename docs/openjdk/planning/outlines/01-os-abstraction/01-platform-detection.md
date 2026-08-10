# 01. JVM 怎么知道自己跑在容器里？— 平台探测

> 🔴 Deep | 23 KP 中的 4 个入口机制
> 读者处境: JVM 是个 C++ 程序——它怎么看清脚下的机器是什么配置、跑在哪里？

### 1. "我是谁？" — 内核版本 + CPU 特性 + 虚拟化

场景: JVM 启动——第一件事，问 Linux 三个问题。

**内核版本编码** (`os_linux.hpp:60-66`):
- `0x00AABBCC` — 32 位整数压缩 uname 输出 (AA=major, BB=minor, CC=fix)
- 源码: `os_linux.hpp:60` 宏 `LINUX_VERSION_CODE` → `os_linux.cpp:4877` `get_linux_os_version()` → 驱动几十次条件编译 (epoll 版本? cgroup v1/v2? THP?)
- [内核: uname 系统调用返回 `utsname.release` 字符串，JVM 解析数字部分。不做 strcmp——if/else 整数比较比字符串快 100x]
- [man 2 uname]

**CPU 特性 bitmask** (`abstract_vm_version.hpp:139-152`):
- cpuid 指令 → `_features` bitmask → 每位对应一个 CPU 能力
- 源码: `vm_version_x86.cpp:464` 调用 cpuid → 填入 `_features` → `supports_cx8()` 等 getter
- 原子指令探测: `supports_cx8/atomic_getset4/getset8/getadd4/getadd8` (`abstract_vm_version.hpp:56-67`)
- 决定: JIT 能否生成 AVX 指令 / GC barrier 能否用 LOCK cmpxchg / crypto intrinsic 能否用 AES-NI
- [x86: cpuid 指令 — EAX=1 时 ECX/EDX 返回 feature flags bitmask。每个 bit 对应: bit25=SSE, bit28=AVX, bit19=CLFLUSH。JVM 存到 `_features`，用 AND 检测]

**虚拟化环境检测** (`abstract_vm_version.hpp:31-41`):
- `VirtualizationType` 枚举: XenHVM / KVM / VMWare / HyperV / PowerVM / PowerKVM
- 源码: `vm_version_x86.cpp:1410` 检测 → TSC 行为差异
- [x86: TSC (Time Stamp Counter) — 自 CPU 上电以来的 cycle 计数，rdtsc 指令读取。KVM 下 VM 暂停时 TSC 不递增，恢复时出现偏移——JVM 的 GC 日志/JFR 时间轴依赖 TSC 精度]
- [man 2 clock_gettime]

### 2. "我有几个 CPU？" — 物理核数 vs cgroup 配额

场景: 16 核物理机，K8s 分你 2 核。JVM 开几个 GC 线程？

**processor_count vs active_processor_count** (`os.hpp:232-281`):
- `_processor_count`: 物理核心数 — `os_linux.cpp:2057` sysconf(_SC_NPROCESSORS_CONF)
- `_initial_active_processor_count`: cgroup quota 后的实际可用数 — `os.cpp:161`
- GC 并行度 (ParallelGCThreads)、JIT 线程数 (CICompilerCount)、JFR 采样——全部基于 active_processor_count
- [C++: sysconf(_SC_NPROCESSORS_CONF) vs sysconf(_SC_NPROCESSORS_ONLN) — 前者返回所有 CPU (含 offline)，后者只返回 online。JVM 用 `is_MP()` 区分多处理器]
- [man 3 sysconf]

**cgroup CPU quota 计算** (`cgroupSubsystem_linux.cpp:142`):
- `cfs_quota_us / cfs_period_us` → 向上取整
- 典型: period=100ms, quota=200ms → 2 个 CPU 时间片
- [内核: CFS (Completely Fair Scheduler) bandwidth control — cfs_quota_us 是周期内可用时间，cfs_period_us 是统计周期。超过 quota → 线程被 throttled，直到下一周期]

**NUMA 感知** (`os_linux.hpp:272-306`):
- cpu_to_node / nindex_to_node 映射表 — `os_linux.cpp:2820`
- libnuma 动态加载 (dlsym) + v1/v2 API 兼容 — `os_linux.cpp:2890`
- [内核: NUMA (Non-Uniform Memory Access) — 每个 socket 有自己的本地内存。访问本地内存 ~100ns，远端 ~200ns。JVM 利用 libnuma 把 heap region 分配到本地 node]
- [C++: dlsym(RTLD_DEFAULT, "numa_available") — 运行时动态解析而非编译时链接，避免 libnuma 缺失时 linker 报错]

### 3. "我有多少内存？" — Container/Cgroup 自动检测

场景: 64GB 机器分 2GB 给容器，JVM 没指定 `-Xmx`——读物理内存 → 设 heap=16GB → OOM Kill。

**CgroupSubsystemFactory 策略模式** (`cgroupSubsystem_linux.hpp:244-268`):
- 检测 `/sys/fs/cgroup` 文件系统类型 → cgroup v1 vs v2
- 源码: `cgroupSubsystem_linux.cpp:62` 工厂 → v1→CgroupV1Subsystem / v2→CgroupV2Subsystem
- [内核: cgroup v1 — 每个控制器 (cpu/memory/io) 独立挂载点 `/sys/fs/cgroup/cpu/`, `/sys/fs/cgroup/memory/`。cgroup v2 — 统一挂载点 `/sys/fs/cgroup/`，所有控制器在一个文件。v2 不需要 `mount -t cgroup`，内核 4.5+ 默认启用]
- [man 7 cgroups]

**memory_limit_in_bytes** (`cgroupV1Subsystem_linux.cpp:271`):
- v1: `/sys/fs/cgroup/memory/memory.limit_in_bytes`
- v2: `/sys/fs/cgroup/memory.max`
- 驱动自适应 heap sizing — 替代 `PhysicalMemory/4` 的默认公式
- [内核: memory cgroup 控制 RSS (Resident Set Size)——进程实际占用的物理页。JVM heap 的 committed 内存计入 RSS，reserved 不计入——因为 MAP_NORESERVE]

**PER_CPU_SHARES 标准化** (`cgroupV1Subsystem_linux.cpp:295`):
- `/sys/fs/cgroup/cpu/cpu.shares` → 标准化为每 CPU 1024 — 不同编排系统 (K8s/Docker/Mesos) 设置不同 shares 值，归一化后 JVM 不关心底层
- [内核: cpu.shares 是相对权重——1024=基准。两个 cgroup 分别设为 1024/512 → CPU 时间 2:1。PER_CPU_SHARES 除以 online CPU 数，归一化到"每 CPU 的份额"]

**CachedMetric 20ms TTL** (`osContainer_linux.hpp:78-92`):
- `jlong _last_read` + `T _value` + `jlong _ttl` — 避免每次 `new Object()` 都 syscall
- 容器调度周期典型 100ms — 20ms 缓存不会错过真实变化
- [C++: 用 `os::javaTimeNanos()` 判断 TTL 过期——monotonic clock，不受 wall clock 调整影响]
- [man 2 clock_gettime] [man 3 clock_gettime]

---

### 核心悬念

**"一个 C++ 程序怎么在 K8s 容器里自动发现: 只有 2 核，只能用 2GB 内存。"** — 平台探测是全部后续决策的基础。内核版本(编译时)→CPU 特性(cpuid)→虚拟化(TSC)→cgroup(策略模式)。但探测只是"看"——下一篇: JVM 怎么向 OS **要**内存？不是 malloc，是 mmap + MAP_NORESERVE。

> → [02-virtual-memory.md](02-virtual-memory.md)
