# 03. JVM 内部有 7 种线程 — 它们谁先谁后？

> 🔴 Deep | 23 KP 中的 5 个线程+同步机制
> 读者处境: 你只知道 `new Thread()`。JVM 内部还有 6 种你看不到的线程——不同的优先级、不同的 safepoint 待遇。

### 1. 7 种线程 — "不只是 Java Thread"

场景: `top -H -p <jvm_pid>`——几十个线程。你能认出几个？答: 7 种。

**os::ThreadType 枚举** (`os.hpp:487-495`):
- vm_thread: VM 操作执行者 (GC/deopt/biased lock revocation)——**1 个**——单例——所有 VM 操作排队到这唯一线程
- cgc_thread: 并发 GC 线程 (G1 concurrent mark/concurrent refinement)——CPU 数相关
- pgc_thread: 并行 GC 线程 (G1 young/mixed GC)——ParallelGCThreads 个
- java_thread: 你的 `new Thread()`——成千上百——JVM 内部是 `JavaThread` 对象包装 pthread
- compiler_thread: C1/C2 JIT 编译器——CICompilerCount 个 (默认: 2 个 C2 + 1 个 C1)
- watcher_thread: 周期性任务——**1 个**——每 50ms 检查一次: GC 要不要触发？偏向锁要不要撤销？JFR 要不要采样？
- os_thread: 未归类——JVM 启动后创建但不属于以上 6 类——通常 0 个

*ThreadType 不只是标签——safepoint 对不同类型有不同处理。java/compiler 线程在 safepoint 时必须停止执行——watcher/vm 线程是 safepoint 的**发起者和执行者**——它们不能停。如果 safepoint 把 watcher_thread 也停了——谁负责在 safepoint 中做 GC？*

### 2. 优先级映射 — WatcherThread 为什么最高？

**Java→OS 优先级 M:1 映射** (`os.cpp:217-247`):
- Java 11 级 (1-10+critical) → Linux nice 值 (-20~19，CFS 调度器)
- `java_to_os_priority[]` 映射表: `NormPriority=5 → nice=0 (默认)`, `MaxPriority=10 → nice=-10`
- [内核: CFS (Completely Fair Scheduler)——vruntime 决定调度顺序。线程的 vruntime = actual_runtime * 1024 / weight。nice 值改变 weight——nice=0(weight=1024) 增长速率 1x，nice=-20(weight=88761) 增长 ~87x 更慢——即获得更多 CPU 时间]
- [man 7 sched]

**调度层次**: WatcherThread(Critical=11) > VMThread(NearMax=9) > GC(8-9) > Java(Norm=5)
- 为什么 WatcherThread 最高？— 负责周期性触发 GC / JIT 编译 / JFR 采样——如果被饿死→JVM 自适应完全丧失→GC 永不触发→JVM 变成响应僵尸
- [C++: setpriority(PRIO_PROCESS, tid, nice)——设置线程 nice 值。`getpriority(PRIO_PROCESS, tid)`——读取当前 nice。pthread 创建后默认继承创建线程的 nice]
- [man 2 getpriority] [man 2 setpriority]

**os::create_thread → pthread_create** (`os.cpp:988-1050`):
- pthread_create + pthread_attr 设置 (stack size, guard size, detached state)
- [C++: pthread_attr_setstacksize——设置线程栈大小 (默认 1MB per Java thread)。pthread_attr_setguardsize——设置 guard page 大小 (默认 1 page)。pthread_attr_setdetachstate——PTHREAD_CREATE_DETACHED (线程退出自动回收) 或 PTHREAD_CREATE_JOINABLE (需 pthread_join)]
- [man 3 pthread_create] [man 3 pthread_attr_init]
- create_main_thread (JNI_CreateJavaVM 入口) vs create_attached_thread (JNI_AttachCurrentThread)——前者是 JVM 的第一个线程，后者是 native 代码附加的已有线程 (不改栈/优先级)

### 3. PlatformEvent — LockSupport.park() 的底层

场景: `LockSupport.park()`——你的 Java 线程被挂起。底层: pthread_cond_timedwait + CLOCK_MONOTONIC。

**ParkEvent 三态模型** (`os_posix.hpp:170-190`):
- `_event ∈ {-1(signaled), 0(neutral), 1(parked)}`
- park(): _event 0→1 → pthread_cond_timedwait——线程睡眠——等 unpark 或超时
- unpark(): _event 1→0 → pthread_cond_signal——唤醒线程
- [C++: pthread_cond_wait vs pthread_cond_timedwait——前者无限等(直到 signal)，后者指定绝对时间超时。JVM 用 pthread_cond_timedwait + CLOCK_MONOTONIC——不受系统时间调整影响。`clock_gettime(CLOCK_MONOTONIC, &now); now.tv_nsec += nanos;` 转换为绝对时间]
- [man 3 pthread_cond_wait] [man 3 pthread_cond_timedwait] [man 2 clock_gettime]

**为什么三态？** — park-then-signal 需要区分"还没 parked"和"已经收到 signal"。线程 A unpark()→B 还没调 park()——_event=-1 (signaled)——B 调 park() 时发现已经有 signal→立即返回(不等待)。两态模型无法表示"提前 signal"——导致 missed wakeup

**PlatformParker** (`os_posix.hpp:198-221`):
- 双 condvar: `_cond` (相对时间) 和 `_cond_abs` (绝对时间)
- `LockSupport.parkNanos(nanos)` → 相对时间→用 _cond——到 now+nanos 后超时
- `LockSupport.parkUntil(deadline)` → 绝对时间→用 _cond_abs——到 deadline 后超时
- 为什么两个？— pthread_cond_timedwait 需要绝对时间——nanos 版需要"now + nanos"→转换为绝对时间→clock_gettime 开销。_cond_abs 版的 deadline 已经是绝对时间——省一次 clock_gettime

**伪共享消除** (`os_posix.hpp:171`):
- _event 和 _nParked 之间有 64B padding——两个字段分到不同 cache line
- [x86: cache line=64B——两个线程分别修改 _event (unpark) 和 _nParked (park)——如果在同一 cache line→MESI protocol false sharing——写 invalidate→另一线程 cache miss→重新读。padding 把两字段分到不同 cache line——各自独立 MESI 状态]

**PosixSemaphore** (`semaphore_posix.hpp:33-50`):
- sem_t 薄封装——signal(批量)/wait/trywait/timedwait
- [C++: sem_init(sem, pshared, value)——pshared=0→进程内共享(线程间)，pshared≠0→进程间共享(通过 mmap 的共享内存)。sem_wait 原子减 1——如果值≤0 则阻塞。sem_post 原子加 1——唤醒一个 waiter]
- [man 3 sem_init] [man 7 sem_overview]

### 4. Suspend/Resume — 强制暂停 vs 协作等待

**四态协议** (`os.hpp:993-1048`):
- SR_RUNNING → SR_SUSPEND_REQUEST → SR_SUSPENDED → SR_WAKEUP_REQUEST → SR_RUNNING
- SUSPEND_REQUEST——中间态——suspend 请求已发出但线程还未到达 safepoint
- 超时回退——如果线程永远不到 safepoint (无限循环无 safepoint check)→SUSPEND_REQUEST 超时→请求者放弃——不阻塞整个 VM

*Suspend vs Park 的本质区别: Suspend 是外部强制的——线程不知道自己被 suspend 了(JVMTI/debug/stack walk 使用)。Park 是线程主动调 park() 的协作操作 (java.util.concurrent 使用)。Suspend 有死锁风险——被暂停的线程可能持有锁，请求暂停者在等这把锁*

---

### 核心悬念

**"Suspend 和 Park 的区别？别搞混——一个强制、一个协作，前者会死锁。"** — Suspend 是 JVMTI 和 debugger 的强制暂停——线程被 suspend 时不知道自己被停了——如果它持有 pthread_mutex→其他线程在等→死锁。Park 是 LockSupport 的协作操作——线程主动等待 PlatformEvent 的 pthread_cond。PlatformEvent 的伪共享消除是所有 Java 并发锁的基础。下一篇: 线程出错时——JVM 怎么用一个 SIGSEGV 处理 5 种完全不同的场景？

> → [04-signals-and-safepoint.md](04-signals-and-safepoint.md)
