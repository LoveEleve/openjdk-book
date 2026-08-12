# 03. JVM 内部有 7 种线程 — 它们谁先谁后？

> **前置依赖**：[01 — 平台探测](01-platform-detection.md)：CPU 数与优先级基础；[02 — 虚拟内存](02-virtual-memory.md)：线程栈就是上篇的栈保护对象
> → **后续**：[04 — 信号与安全点](04-signals-and-safepoint.md)：线程怎么被"停"下来
> 关联域: 17-threads(线程完整体系)、19-sync(锁消费 PlatformEvent)、18-safepoint(线程暂停)

## `top -H` 里那几十个线程,你能认出几个?

`top -H -p <jvm_pid>`——一个刚启动的 JVM 就有几十个线程。`new Thread()` 创建的只是其中一类。JVM 内部还有 6 种你看不到的线程,它们有不同的职责、不同的优先级、甚至不同的 safepoint 待遇。这一篇把 7 种线程认全,再讲两件底层的事:优先级怎么映射到 OS、线程怎么被挂起和唤醒。

## 1. 7 种线程:不只是 Java Thread

`os.hpp:487-495` 的 `ThreadType` 枚举是官方清单:

```cpp
// os.hpp:487-495 —— 完整枚举
enum ThreadType {
  vm_thread,
  cgc_thread,        // Concurrent GC thread
  pgc_thread,        // Parallel GC thread
  java_thread,       // Java, CodeCacheSweeper, JVMTIAgent and Service threads.
  compiler_thread,
  watcher_thread,
  os_thread
};
```

| 类型 | 谁在跑 | 数量 |
|---|---|---|
| `vm_thread` | VM 操作执行者(GC/deopt/偏向锁撤销)——**所有 VM 操作排队到这唯一线程** | 1 |
| `cgc_thread` | 并发 GC(G1 concurrent mark/refinement) | 随 CPU 数 |
| `pgc_thread` | 并行 GC(G1 young/mixed GC) | ParallelGCThreads 个 |
| `java_thread` | 你的 `new Thread()`——JVM 内部是 `JavaThread` 对象包装一个 pthread | 成百上千 |
| `compiler_thread` | C1/C2 编译器 | CICompilerCount 个(按核数 ergonomics 推导——第一篇实测 192 核机器 = 15) |
| `watcher_thread` | 周期性任务(GC 触发/偏向锁撤销/JFR 采样)——定时醒来 | 1 |
| `os_thread` | 未归类(通常为 0) | 0 |

**ThreadType 不只是标签——safepoint 对不同类型有不同待遇**(域 18 的伏笔):`java_thread` 和 `compiler_thread` 在 safepoint 时**必须停下来**;而 `watcher_thread`/`vm_thread` 是 safepoint 的**发起者和执行者**——它们不能停。如果 safepoint 把 watcher_thread 也停了,谁在 safepoint 里做 GC?

**关键设计 (斜体)**: *为什么 vm_thread 是单例?VM 操作(GC、偏向锁撤销)大多需要"全 VM 静止"的语义——多个执行者同时做会互相踩踏。排队到一个线程,天然串行化,不需要额外的锁。代价是吞吐受单线程限制——所以只放必须串行的事。*

## 2. 优先级:WatcherThread 为什么最高?

### Java 11 级 → Linux nice 值的 M:1 映射

Java 有 11 个优先级(1-10 + CriticalPriority),Linux 有 40 个 nice 值(-20~19)。映射表定义在 `os_linux.cpp:4691`:

```cpp
// os_linux.cpp:4691 —— 完整映射表(nice 值,越小优先级越高)
int os::java_to_os_priority[CriticalPriority + 1] = {
  19,              // 0 Entry should never be used
   4,              // 1 MinPriority
   3,              // 2
   2,              // 3
   1,              // 4
   0,              // 5 NormPriority
  -1,              // 6
  -2,              // 7
  -3,              // 8
  -4,              // 9 NearMaxPriority
  -5,              // 10 MaxPriority
  -5               // 11 CriticalPriority
};
```

注意 **MaxPriority(10)映射到 nice=-5,不是 -10**——JVM 故意留余量,不让 Java 线程占尽 CPU。映射是 **M:1** 的:多个 Java 优先级映射到同一个 nice 值(10 和 11 都映射到 -5)。

- [内核: CFS(Completely Fair Scheduler)——vruntime 决定调度顺序:线程的 vruntime 增长速率 = actual_runtime × 1024 / weight。nice 改变 weight——nice=0(weight=1024)增长 1x;nice=-20(weight=88761)增长约 1/87x——即获得约 87 倍 CPU 时间]
- [man 7 sched]

**调度层次**(实测的创建顺序 + 优先级): `WatcherThread(Critical=11) > VMThread(NearMax=9) > GC(8-9) > Java(Norm=5)`。

- [C++: setpriority(PRIO_PROCESS, tid, nice) 设置线程 nice;getpriority 读取。pthread 创建后默认继承创建线程的 nice,所以 JVM 创建线程后要显式 set]
- [man 2 setpriority][man 2 getpriority]

**关键设计 (斜体)**: *为什么 WatcherThread 最高?它是"自适应"的心脏——周期性触发 GC、JIT 编译、JFR 采样。如果它被饿死,整个 JVM 的自适应机制瘫痪:GC 永不触发、堆无限膨胀、JVM 变成"响应僵尸"。给最重要的守护者最高的优先级,是"关键路径优先"原则的典型应用。*

### create_thread:一个 pthread_attr 的故事

线程创建的实现在 `os_linux.cpp:938`(核心):

```cpp
// os_linux.cpp:938 起(截取核心)
bool os::create_thread(Thread* thread, ThreadType thr_type, size_t req_stack_size) {
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);   // 退出自动回收
  pthread_attr_setguardsize(&attr, guard_size);                  // guard 页大小
  ...
  int status = pthread_attr_setstacksize(&attr, stack_size);     // 栈大小
```

- [man 3 pthread_create]
- [C++: 栈大小默认值在 `default_stack_size`(os_cpu/linux_x86/os_linux_x86.cpp:734):AMD64 下 Java 线程 1MB、Compiler 线程 4MB;Java 线程可用 `-Xss` 改(ThreadStackSize,globals_linux_x86.hpp:34)]
- [C++: pthread_attr_setdetachstate(PTHREAD_CREATE_DETACHED)——线程退出自动回收,不需要 join;PTHREAD_CREATE_JOINABLE 则需要 pthread_join。JVM 线程全是 DETACHED——没有谁等谁回收]

两个特殊入口: `create_main_thread`(JNI_CreateJavaVM 的第一个线程)和 `create_attached_thread`(JNI_AttachCurrentThread——native 代码附加已有线程,不改栈/优先级)。

## 3. PlatformEvent:`LockSupport.park()` 的底层

### 一个三态计数器 + 一个条件变量

`LockSupport.park()` 把你的 Java 线程挂起。底层是 `PlatformEvent`(`os_posix.hpp:163-192`):

```cpp
// os_posix.hpp:163-192(截取核心字段,注释逐字)
class PlatformEvent : public CHeapObj<mtSynchronizer> {
 private:
  double cachePad[4];        // Increase odds that _mutex is sole occupant of cache line
  volatile int _event;       // Event count/permit: -1, 0 or 1
  volatile int _nParked;     // Indicates if associated thread is blocked: 0 or 1
  pthread_mutex_t _mutex[1]; // Native mutex for locking
  pthread_cond_t  _cond[1];  // Native condition variable for blocking
  double postPad[2];
  ...
  void park();
  void unpark();
};
```

注释第一句值得背下来:"These event objects are **type-stable and immortal** - we never delete them."——PlatformEvent 与线程同生共死,永不删除。

- [C++: pthread_cond_wait 无限等;park 用 pthread_cond_timedwait + CLOCK_MONOTONIC(绝对时间超时)——不受系统时间调整影响]

### 为什么是三态(-1/0/1)?

park/unpark 的本质是"信号传递",三态解决**提前 unpark 丢失**的问题:

```
_event = 0   中性(啥都没发生)
_event = -1  已发信号(signal 到达,但线程还没 park)
_event = 1   线程已 park(在条件变量上等)

unpark():  A 调 unpark → _event = -1(发信号)
park():    B 调 park
            如果 _event 已经是 -1 → 立即返回(信号已经等在这了!)
            否则 → _event = 1 → 睡在条件变量上
```

两态模型无法表达"信号先到、线程后到"——B 调 park 时不知道有未消费的 signal,会睡死(错过唤醒)。

**关键设计 (斜体)**: *为什么"信号先到"必须被记住?Java 里 `t.unpark(); t.park()` 两个调用之间没有同步——线程 A 可能在 B 真正 park 之前就 unpark 了。三态让 unpark 先行变成"信号存根",park 时发现即返回。这是并发原语里"状态必须覆盖所有交错"的教科书案例。*

### 伪共享消除:padding 的真实位置

大纲和很多资料说"_event 和 _nParked 之间有 64B padding"——**实测不是**。看上面的结构:`cachePad[4]` 在 **`_mutex` 前面**(注释:让 _mutex 独占 cache line),`postPad[2]` 在 **`_cond` 后面**。真正要防伪共享的是 `_mutex`/`_cond`(park 路径频繁加锁)——`_event` 和 `_nParked` 是相邻的。

- [x86: cache line=64B。两个线程分别改 `_event`(unpark)和 `_mutex`(park 加锁)——若在同一 cache line,MESI 协议写失效会让双方互相 miss。padding 把高频写对象拆到独立 cache line]

### PlatformParker:双 condvar 的取舍

`PlatformParker`(`os_posix.hpp:205-220`)持有一个 `pthread_cond_t _cond[2]`:

- `LockSupport.parkNanos(nanos)`(相对时间)→ 用第一个 condvar:先把 `now + nanos` 算成绝对时间,再 timedwait
- `LockSupport.parkUntil(deadline)`(绝对时间)→ 用第二个 condvar:deadline 本身就是绝对时间,**省一次 clock_gettime**

- [man 3 pthread_cond_timedwait][man 2 clock_gettime]

**关键设计 (斜体)**: *为什么两个 condvar 而不是一个?pthread_cond_timedwait 只认绝对时间。parkNanos 每次都要"now + nanos"转换(一次 clock_gettime 系统调用);parkUntil 的 deadline 已经是绝对时间。两个 condvar 让 parkUntil 路径省掉转换开销——高频路径上的每次系统调用都值得省。*

### PosixSemaphore:sem_t 的薄封装

`PosixSemaphore`(`semaphore_posix.hpp:33-50`)是 POSIX `sem_t` 的薄封装:`signal(批量)/wait/trywait/timedwait`,非拷贝。

- [man 3 sem_init][man 7 sem_overview]

## 4. Suspend/Resume:强制暂停 vs 协作等待

### 四态协议

`suspend`(JVMTI/debugger 用)比 park 麻烦得多——它是**外部强制的**,线程自己不知道被停了。状态机在 `os.hpp:993` 的 `SuspendResume::State`:

```cpp
// os.hpp:993-1000 —— 状态枚举(完整)
class SuspendResume {
 public:
  enum State {
    SR_RUNNING,
    SR_SUSPEND_REQUEST,
    SR_SUSPENDED,
    SR_WAKEUP_REQUEST
  };
```

状态转移注释(`os.hpp:981-987`)画出了关键设计——**中间态和超时回退**:

```
SR_RUNNING ──suspend 请求──▶ SR_SUSPEND_REQUEST ──线程到 safepoint──▶ SR_SUSPENDED
    ▲                              │
    └────────── 超时回退 ──────────┘
    (WatcherThread 等太久,放弃请求,回 RUNNING)
```

- **SR_SUSPEND_REQUEST 是中间态**:请求已发出,线程还没到达安全点——它可能正在执行一段没有 safepoint check 的代码(比如无限循环)。
- **超时回退**:如果线程永远不到安全点,WatcherThread 等够时间就放弃——**不能因为一个线程卡住而阻塞整个 VM**。

- [C++: 线程收到挂起信号后,在下一个安全点检查 SR_SUSPEND_REQUEST → 切到 SR_SUSPENDED;恢复时反向走 SR_WAKEUP_REQUEST]

### Suspend vs Park:一个强制,一个协作

| | Suspend | Park |
|---|---|---|
| 谁发起 | 外部(JVMTI/debugger/栈遍历) | 线程自己(`LockSupport.park()`) |
| 线程知情吗 | 不知道 | 主动调用 |
| 死锁风险 | **有**——被挂线程可能持有锁,挂起者等锁 | 无——协作等待不抢锁 |
| 消费方 | JVMTI/debug/stack walk(域 28/24) | java.util.concurrent(域 19) |

**关键设计 (斜体)**: *为什么 Suspend 有死锁风险而 Park 没有?被 suspend 的线程意识不到自己停了——它手里可能攥着一把 pthread_mutex,而请求挂起者的代码在等这把锁。Park 是线程自愿等在条件变量上,不持有任何会阻塞别人的资源。这就是为什么调试器用 suspend、而并发库用 park——强制手段必须接受死锁的可能性。*

## 看见:7 种线程的实物

工具卷里见过这些线程的实物([卷 T ch02](openjdk/vol-tools/ch02.md) 的 `Thread.print` 输出):`"VM Thread"`、`"GC Thread#x"`、`"C1 CompilerThread0"`、`"WatcherThread"`、`"Attach Listener"`——它们就是这 7 种类型的实例。下次 `top -H` 看到几十个线程,你认得它们了。

## 核心悬念

"Suspend 和 Park 的区别?一个强制、一个协作,前者会死锁。"——这是线程世界观的骨架。但线程还有最后一个问题没答:**怎么让所有线程同时停在一个已知位置?** 下一篇:一个 SIGSEGV 信号处理器,怎么处理 5 种完全不同的场景——栈溢出、安全点轮询、空指针、内存序列化、真崩溃?

> → [04-signals-and-safepoint.md](04-signals-and-safepoint.md):SIGSEGV 五阶段分发
