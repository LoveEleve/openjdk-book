# OS 抽象层 — 文章大纲（Pass 1 修订版）

> vol-01 · 域 01 · 🔴 A | 拓扑排序 #1 | 基于 Pass 0+1 探索笔记修订
> Pass 1 产出：7 文件组 / 7 基本元素 / 7 标记问题

## 概念依赖

本域不依赖任何 JVM 内部域。

## 叙事计划

**开篇场景**：HotSpot 在 Linux 上用 `pthread_create` 创建线程，但 JVM 所有上层代码只调 `os::create_thread()`。OS 抽象层是 JVM 和操作系统的唯一接触面——换一个 OS 只需换这一层的实现，不改任何 Java 逻辑。

**第一层：抽象长什么样**

`os` 继承 `AllStatic`（`os.hpp:98`），304 个 static 方法，无虚函数、无继承——纯静态工具类。按职责分五组：
- 内存：`pd_reserve_memory` / `pd_commit_memory` / `pd_release_memory` 三段式
- 线程：`pd_create_thread`（包装 pthread）+ `pd_start_thread`
- 信号：`install_signal_handlers` + libjsig 协作 + `JVM_handle_linux_signal` 分发
- 容器：`init_container_support` → cgroup v1/v2 检测
- 系统信息：`available_memory` / `active_processor_count`

平台分派通过 `pd_*` 方法 + `LINUX_ONLY` 宏——编译期决定调用哪个平台的实现。共享层的 `os.hpp` 只声明，`os_linux.cpp`（6801 行）是实际载体。

**第二层：内存三段式——为什么 reserve 和 commit 分开**

`os::reserve_memory()` → `os::commit_memory()` → `os::release_memory()`。reserve 只占地址空间（`mmap PROT_NONE`，`os_linux.cpp:3212`），commit 才分配物理页（`mprotect` 或 mmap 重新映射，`os_linux.cpp:3842`）。

为什么分开？Java 堆需要连续地址空间（compressed oops 依赖 32GB 以下连续映射），reserve 先占坑保证连续性，commit 按 GC 节奏按需分配——堆扩缩容就是 commit/decommit 的节奏。

特殊策略：大页（`MAP_HUGETLB`，`os_linux.cpp:3245` 本地定义常量兼容旧内核）、NUMA（`libnuma_dlsym` → `dlvsym("libnuma_1.1")` 动态加载，`os_linux.cpp:3425`——不静态链接避免无 NUMA 机器依赖 libnuma.so，运行时检测后设 `numa_set_bind_policy(MPOL_PREFERRED)`，`os_linux.cpp:3477`）。

**第三层：线程创建——pthread_create 的重封装**

`os::create_thread()` → `os_linux.cpp:939` → `pthread_create`。栈大小计算是核心复杂度：`ThreadStackSize`（`-Xss`）→ 减去 `os::vm_page_size()` + TLS 开销 + guard page → 设 `pthread_attr`。glibc 2.27 后 guard page 行为变了，`os_linux.cpp:865-890` 通过 `pthread_getattr_np` 动态检测兼容。

CPU 亲和性未实现（`bind_to_processor` 返回 `false`，`os_linux.cpp:5892`）——留给后续版本。

**第四层：同步原语——ParkEvent 和 Parker**

JVM 线程同步有两套底层原语（`os_posix.hpp` + `park.hpp`）：
- `PlatformEvent`（`os_posix.hpp:170`，pthread_cond 等待/通知）→ **`ParkEvent`**（`park.hpp:118`）— JVM 内部线程间同步。每个 JavaThread 有自己的 ParkEvent，用于 VM 内部 wait/notify 场景。
- `PlatformParker`（`os_posix.hpp:205`，pthread_mutex + pthread_cond）→ **`Parker`**（`park.hpp:48`，含 `_counter` 字段）— Java 层 `Unsafe.park()/unpark()` 的底层实现。当 Java 代码调用 `LockSupport.park()` 时，最终进入 `Parker::park()`。

两者都是 `CHeapObj` 且析构是 `guarantee(false)`——永不销毁（immortal）。`_counter` 是 permit 模型的计数器：`unpark()` 设 `_counter=1`，`park()` 检查 `_counter`——如果是 1 就消费掉（不清零直接返回），是 0 就 pthread_cond_wait。

**第五层：信号——SIGSEGV 做控制流**

`safepointMechanism.cpp:52-63` 分配两页：前半页 `PROT_NONE`（不可读写），后半页可读。线程执行到 safepoint polling 指令时读前半页 → `SIGSEGV` → `JVM_handle_linux_signal`（`os_linux_x86.cpp:268`）→ `is_poll_address(si_addr)`（`os_linux_x86.cpp:431`）→ 挂起等安全点结束。

libjsig 协作：`install_signal_handlers` 中（`os_linux.cpp:5192`）设 `libjsig_is_loaded = true`——`sigaction()` 调用被 libjsig 拦截，保存旧 handler、传给 JVM。应用自己的 SIGSEGV 处理器在链中，JVM 只处理 poll address，其他 SIGSEGV 透传。

**第六层：容器感知——cgroup v1/v2 自动检测**

`init_container_support()` → `CgroupSubsystemFactory::create()` 检测 cgroup 版本：读 `/proc/self/mountinfo` 判断挂载类型。v1 读 `/sys/fs/cgroup/memory/memory.limit_in_bytes`（`cgroupV1Subsystem_linux.cpp:91`），v2 读 `/sys/fs/cgroup/cgroup.controllers`。容器内存限制覆盖 `-Xmx` 默认值，CPU quota 覆盖 `ActiveProcessorCount`——不给 JVM 参数也能自适应 Docker 环境。

**第七层：原子操作与内存屏障——怎么跨到 os_cpu 层**

`os_cpu/linux_x86/` 下有 `atomic_linux_x86.hpp`（CAS/LOCK 前缀实现）和 `orderAccess_linux_x86.hpp`（`mfence` 内存屏障）。这些是 JVM 并发语义的最底层——`synchronized`、`volatile`、`Atomic::cmpxchg` 最终都落到这些汇编指令。它们和信号处理放在同一层（`os_cpu/linux_x86/`），因为它们都是"操作系统 + CPU 架构"的交叉域。

**设计权衡**

一、编译期分派 vs 运行时虚函数。HotSpot 编译时就知道目标平台——不需要同一个二进制兼容 Linux 和 Windows。`pd_*` + `LINUX_ONLY` 零运行时开销。

二、NUMA 动态加载 vs 静态链接。避免无 NUMA 机器强制依赖 libnuma.so——`dlvsym` 检测不到就降级为均匀内存访问。

三、两段内存 vs 一段分配。`reserve` + `commit` 分离使 GC 能先占连续地址再按需分配——代价是增加一次系统调用，但换来 compressed oops 的可行性。

## 核心悬念

**304 个 static 方法怎么把 Linux 的全部能力封装成 JVM 能用的 5 组接口——内存/线程/信号/容器/原子操作？**

**→ 下一域**：这些接口最终都要生成机器码——信号处理的 trampoline、线程创建的 stub、原子操作的 LOCK 前缀。这些机器码怎么来的？需要一位"翻译官"把人读的指令变成 CPU 认识的字节。Assembler 篇见。

## 预估

1 篇，7 层递进，预估 2500-3500 行。
