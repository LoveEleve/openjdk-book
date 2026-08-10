# 域 01: OS 抽象层 — 全视角提问验证

> 23 KP / 🔴11 + 🟡7 + 🟢5 | ~55 文件 | 拆 4 篇文章
> 验证方法: 逐题检查 4 篇大纲是否覆盖了该视角的关注点

**大纲文件对照**:

| 篇 | 文件 | 覆盖范围 |
|:--:|------|------|
| 1 | `01-platform-detection.md` | 内核版本/CPU特性/虚拟化/processor_count + Container/cgroup |
| 2 | `02-virtual-memory.md` | 虚拟内存四态生命周期 + 大页面 + 栈保护 + Pre-touch + overcommit |
| 3 | `03-threads-and-sync.md` | 线程类型/优先级/调度 + PlatformEvent/Parker/Semaphore + SuspendResume |
| 4 | `04-signals-and-safepoint.md` | 信号链 + SIGSEGV五阶段 + Safepoint轮询页/序列化页 + 辅助 |

------

## 维度 1: 开发者 (Developer)

| # | 问题 | 大纲覆盖? |
|:--:|------|:--:|
| D1 | `os::reserve_memory()` 和 `os::commit_memory()` 为什么分开而不是一个 `os::allocate()`？中间发生了什么？ | ✅ §2 — 四态生命周期 + split_reserved_memory |
| D2 | `pd_reserve_memory` / `pd_commit_memory` 的 platform-dependent 分发是怎么实现的 — 虚函数表还是条件编译？ | ✅ §2 — pd_* 平台分发模式 |
| D3 | `_page_sizes[max=9]` 数组怎么填充的 — 从哪读出系统支持的页面大小？排序为什么是降序？ | ✅ §3 — 多页面大小递减数组 + page_size_for_region |
| D4 | `os::malloc` 在 `::malloc` 之外加了什么 — NMT header 的结构是什么样的？GuardedMemory canary 怎么检测 buffer overflow？ | ✅ §10 — NMT header 前置 + GuardedMemory |
| D5 | `os::create_thread` 的完整调用链是什么样的 — 从 `pthread_create` 到 `JavaThread::run()` 之间经过了哪些平台层？ | ✅ §5 — create_thread → pthread_create → pd_start_thread |
| D6 | `ParkEvent` 的 `_event` 三态 (0/-1/1) 的完整状态转移图 — park/signal/unpark 分别做什么转换？ | ✅ §6 — ParkEvent 三态模型 |
| D7 | `SuspendResume` 为什么是四态而不是两态 — SUSPEND_REQUEST 和 WAKEUP_REQUEST 中间态解决了什么问题？ | ✅ §6 — 四态协议 + 超时回退 |
| D8 | `sigsetjmp/siglongjmp` 在 `ThreadCrashProtection` 中怎么用的 — crash 保护的范围是什么？恢复后继续执行还是 abort？ | ✅ §7 — ThreadCrashProtection |

## 维度 2: 性能工程师 (Performance)

| # | 问题 | 大纲覆盖? |
|:--:|------|:--:|
| P1 | 大页面 (huge page) 在什么场景下有明显收益 — TLB miss 减少多少？对 G1 GC pause time 的影响？ | ✅ §3 — 三种大页面模式 |
| P2 | `Pre-touch` 对 JVM 启动时间和首次 GC 延迟的影响 — pretouch 本身要花多少时间？什么时候值得做？ | ✅ §2 — Pre-touch 预热 |
| P3 | `Memory Serialize Page` vs `mfence` 的性能差异 — 页面权限切换 (mprotect) 的延迟是多少？在什么情况下序列化页更快？ | ✅ §8 — 序列化页 vs membars |
| P4 | Safepoint polling page 的 `test [polling_page], %rax` 指令开销 — L1 cache hit 的延迟是多少？和 `cmp [flag], 0; jne` 比差多少？ | ✅ §8 — 零开销 safepoint check |
| P5 | `CachedMetric` 的 20ms TTL 怎么定的 — 更短 (1ms) 或更长 (100ms) 会有什么问题？ | ✅ §9 — 20ms 缓存设计 |
| P6 | `PlatformEvent` 的 cache 行填充 (64B padding) — 如果不做 padding，伪共享会导致多少性能损失？ | ✅ §6 — 伪共享消除 |

## 维度 3: SRE/运维 (SRE)

| # | 问题 | 大纲覆盖? |
|:--:|------|:--:|
| S1 | JVM 在容器 (Docker/K8s) 中怎么检测 cgroup — 如果 /sys/fs/cgroup 不存在会 fallback 到什么？ | ✅ §1 + §9 — 平台探测 + cgroup 检测 |
| S2 | `-XX:+UseLargePages` 开启后如果 OS 没有预留 huge page — JVM 启动失败还是 fallback 到 4K 页面？ | ✅ §3 — 三种模式 + THP fallback |
| S3 | `hs_err_pid.log` 在 SIGSEGV crash handler 中的输出内容 — 包括哪些信息？怎么从 crash log 定位根因？ | ✅ 04 §1 — crash log 含寄存器/栈帧/内存映射/线程列表/动态库 |
| S4 | `active_processor_count` vs `processor_count` 在 K8s 中不一致时 — JVM 日志 (GC/JIT) 中的 CPU 数应该相信哪个？ | ✅ §1 — 静态 vs 动态处理器数 |
| S5 | `AllocateHeapAt` (-XX:HeapDir) — 堆放到 NVMe/PMEM 设备上有意义吗？文件映射 vs 匿名映射的性能差异？ | ✅ §10 — AllocateHeapAt |
| S6 | `-XX:+UseContainerSupport` 默认开启后怎么验证 JVM 读到了正确的 cgroup limit？ | ✅ §9 — Container 资源感知 |

## 维度 4: 架构师 (Architect)

| # | 问题 | 大纲覆盖? |
|:--:|------|:--:|
| A1 | 为什么 JVM 的虚拟内存管理不是直接调用 `malloc/free`？— Java heap 和 C heap 分离的架构原因是什么？ | ✅ §2 — 为什么不是 malloc/free |
| A2 | 信号处理为什么需要 libjsig 的"信号链"而不是直接接管所有 signal handler？— 如果有 native agent (如 profiler) 同时注册了 SIGSEGV handler 怎么办？ | ✅ §7 — libjsig 信号链 |
| A3 | Container/Cgroup 支撑的三个子系统 (heap sizing / CPU count / thread scheduling) 中，哪一个的"感知不到容器"后果最严重？ | ✅ §9 — Container 资源感知 (三个维度) |
| A4 | `os::malloc` 的 NMT 集成 — 为什么是 header 前置 (侵入式) 而不是 side table？设计权衡是什么？ | ✅ §10 — NMT header 前置 |
| A5 | `PlatformEvent/PlatformParker` 为什么用 pthread_cond 而不是 futex(2) — 什么时候 futex 更快？JVM 为什么不直接用 futex？ | ✅ §6 — PlatformEvent/Parker (pthread_cond 选择) |
| A6 | 七种 ThreadType 的分类依据 — 为什么 Java 线程和 compiler 线程是不同的 ThreadType？Safepoint 对不同类型的处理有区别吗？ | ✅ §5 — 7 种线程类型 + 调度层次 |

## 维度 5: 研究者 (Researcher)

| # | 问题 | 大纲覆盖? |
|:--:|------|:--:|
| R1 | SIGSEGV handler 的五阶段分发和 Linux 内核的 `vm_fault` 处理 — JVM 在哪个阶段接管了内核的 page fault 处理？ | ✅ §7 — SIGSEGV 五阶段 |
| R2 | `mmap(MAP_NORESERVE)` 的 overcommit — Linux 的 `vm.overcommit_memory=2` 对 JVM 的 reserve 操作有什么影响？ | ✅ 02 §1 — overcommit_memory 参数讨论 |
| R3 | THP 的 khugepaged 内核线程 — 它怎么影响 JVM 的内存布局？为什么 G1 的 heap region 边界可能被 THP 打破？ | ✅ 02 §2 — khugepaged 跨 G1 region 边界合并页面 |
| R4 | TSC (Time Stamp Counter) 在不同虚拟化环境下的行为 — KVM vs Xen vs bare metal 的 TSC 偏移和漂移怎么影响 JVM 的时间测量？ | ✅ 01 §1 — 虚拟化检测 + TSC 差异 |
| R5 | `mprotect` 的 TLB shootdown — 当 safepoint polling page 被设为 PROT_NONE 时，所有 CPU core 的 TLB 怎么被 invalidate？延迟是多少？ | ✅ §8 — safepoint polling page |

## 维度 6: 学生/初学者 (Student)

| # | 问题 | 大纲覆盖? |
|:--:|------|:--:|
| L1 | `virtual memory` (虚拟内存) 和 `resident memory` (物理内存) 的区别 — 为什么 reserve 只有虚拟地址空间，commit 才有物理页？ | ✅ §2 — 四级操作模型 |
| L2 | `page fault` 是什么 — minor fault 和 major fault 的区别？JVM 在什么情况下触发 page fault？ | ✅ 02 §1 — minor/major fault 概念 |
| L3 | `SIGSEGV` 和 `NullPointerException` 的关系 — Java 的 NPE 是 JVM 软件抛出的还是 OS 信号触发的？ | ✅ 04 §1 — SIGSEGV→null check→uncommon trap |
| L4 | `TLB` (Translation Lookaside Buffer) 是什么 — 为什么大页面能减少 TLB miss？ | ✅ 02 §2 — 大页面 + TLB |
| L5 | `cgroup` v1 vs v2 的根本区别 — 为什么 JVM 需要两个完全不同的子系统实现？ | ✅ 01 §2 — 策略模式 + v1/v2 双子系统 |
| L6 | `strace` 跟踪 JVM 进程能看到什么 — JVM 启动时做了多少次 mmap/mprotect/pthread_create？ | ✅ 02 §1 — strace 观察视角 |

---

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 开发者 (Developer) | 8 | 8 | ✅ |
| 性能工程师 (Performance) | 6 | 6 | ✅ |
| SRE/运维 | 6 | 6 | ✅ |
| 架构师 (Architect) | 6 | 6 | ✅ |
| 研究者 (Researcher) | 5 | 5 | ✅ |
| 学生/初学者 | 6 | 6 | ✅ |
| **合计** | **37** | **37** | ✅ |

> 5 处初审 ⚠️ 已全部修复（S3 hs_err/R2 overcommit/R3 khugepaged/L2 page fault/L6 strace），大纲文件已同步更新。**37/37 全覆盖。**
