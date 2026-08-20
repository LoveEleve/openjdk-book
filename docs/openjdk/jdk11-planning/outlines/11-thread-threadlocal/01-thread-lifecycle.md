# 01. 线程的生命周期与调度原语 — start/run、join、sleep、中断

> 🔴 Deep | 域 11 线程与 ThreadLocal 第 1 篇 | Layer 1
> 读者处境: 面试从 "start 和 run 的区别" 问到 "interrupt 之后线程还活着吗"——Thread 类里每个原语背后的 native 边界在哪,一次看清。

### 1. "start() 到底做了什么？" — synchronized + native start0

场景: 面试第一问——为什么必须 start 不能直接调 run?

- `Thread.java:780` `public synchronized void start()` — `threadStatus != 0` 校验(已启动抛 IllegalThreadStateException,`Thread.java:788-789`)→ `group.add` 加入线程组 → `start0()`
- `Thread.java:812` `private native void start0()` — **native 边界**: JVM 创建 OS 线程,新线程入口回调 `run()`
- `Thread.java:827` `public void run()` — 普通方法: 直接调 run 只是当前线程内执行方法调用,没有新线程
- `Thread.java:210` `private volatile int threadStatus` — **JVMTI 位标志**(不是 0/1/2 数字编码),`getState()` 经 `jdk.internal.misc.VM.toThreadState` 位与解析(`VM.java:282`)
- 关键设计 (斜体): *start 的 synchronized 防并发启动;threadStatus 双重检查保证"一个线程只能 start 一次";native 侧负责 OS 线程创建 + 栈分配,Java 侧只做校验与簿记*
- 面试点: "new Thread 的线程栈什么时候分配?"——start0 时(JVM 创建 OS 线程带默认栈大小,-Xss 控制)
- [内部卷: 17-threads(线程对象与状态机);C++: os::create_thread → pthread_create]

### 2. "sleep/yield/join 谁让出 CPU？" — 调度原语三兄弟

场景: 生产代码 sleep 做重试等待、join 等子线程——它们的语义差别?

- `Thread.java:319` `sleep(long millis, int nanos)` — 让出 CPU **但不释放锁**(与 wait 的本质区别);native 实现(JVM 内转 OS 定时器)
- `Thread.java:276` `public static native void yield()` — 提示调度器让出 CPU(仅提示,无保证)
- `Thread.java:1374` `join()` → `Thread.java:1289` `join(long)`: **wait/notify 模型**——`while (isAlive()) wait(0)`(1289-1309),线程死亡时 JVM notifyAll 唤醒等待者
- 关键设计 (斜体): *join 不用自旋而用 wait——线程死亡时 JVM 在 native 侧调用 notifyAll(内部卷: 线程退出路径),等待者零开销挂起;sleep 抛 InterruptedException(可中断),yield 不可中断*
- 面试点: "sleep vs wait"——sleep 不释放锁(Thread 静态方法,与监视器无关);"join vs 自旋"——join 是等事件,自旋是忙等
- [内部卷: 17-threads(线程退出与 notifyAll 路径);man 3 pthread_join? — JVM 内部实现不同,Java join 是 wait 模型]

### 3. "interrupt 是中断线程吗？" — 中断标志语义

场景: 生产线程池优雅关闭用 interrupt——它到底做了什么?

- `Thread.java:979` `public void interrupt()` — 设置中断标志;若阻塞在 wait/sleep/join(或可中断锁 Lock.lockInterruptibly)则唤醒并抛 InterruptedException;native `interrupt0`(991)。**注意: synchronized 锁等待不可中断**(仅设置标志,拿到锁后才响应)
- `Thread.java:1015` `public static boolean interrupted()` — **静态,返回并清除**当前线程标志
- `isInterrupted()` — 实例方法,只读不清除
- 关键设计 (斜体): *interrupt 不是"杀死线程"——它只设置标志;线程配合 `interrupted()/isInterrupted()` 自行响应(协作式中断);阻塞中的线程被中断: 标志清除 + 抛 InterruptedException(JDK 语义: 中断状态在异常抛出时清空)*
- 生产: 线程池 shutdownNow 遍历 worker interrupt;任务内 `if (Thread.currentThread().isInterrupted()) break;` 响应
- 面试点: "interrupt 一个阻塞在 IO 的线程?"——Java 层 interrupt 对传统阻塞 IO 无效(除 NIO InterruptibleChannel,域 19)
- [内部卷: 17-threads(中断状态 native 实现)]

### 4. "线程现在是什么状态？" — 状态位与 currentThread

场景: 线上 jstack 看到 RUNNABLE/BLOCKED/WAITING——对应 Java 侧哪些方法?

- `Thread.java:258` `public static native Thread currentThread()` — 获取当前执行线程对象(native 读 TLS)
- 状态映射: NEW(未 start)/RUNNABLE(可运行)/BLOCKED(等监视器)/WAITING(join/wait 无超时)/TIMED_WAITING(sleep/join(timeout))/TERMINATED
- `Thread.java:210` threadStatus(JVMTI 位标志)+ `Thread.java:1854` `getState()` → `VM.toThreadState` 位与解析(`jdk/internal/misc/VM.java:282`)
- 关键设计 (斜体): *Java 层只有一个 int(threadStatus),完整状态机在 JVM(native 侧维护,JVMTI 位标志由 VM 同步写入);jstack 的线程状态是 JVMTI 从 VM 完整状态读取——比 getState() 更实时(后者是 Java 字段快照)*
- 面试: "BLOCKED vs WAITING"——等锁 vs 等事件;生产: 死锁检测看 BLOCKED 环
- [内部卷: 17-threads(状态机);工具: jstack(内部卷 00-jvm-tools)]

---

### 核心悬念

线程有了生命周期,但**每个线程私有的变量**怎么存?`ThreadLocal` 挂着 `Thread.threadLocals` 字段——它内部为什么用弱引用?为什么一定会内存泄漏?下一篇: ThreadLocalMap 的完整解剖。

> → [02-threadlocal.md](02-threadlocal.md)
