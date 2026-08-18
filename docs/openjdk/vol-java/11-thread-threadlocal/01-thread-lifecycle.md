# 01. 线程的生命周期与调度原语 — start/run、join、sleep、中断

> **前置依赖**: [03-object-system/02 — System 与 Runtime](../03-object-system/02-system-runtime.md)(join 的超时计算用 currentTimeMillis)、[03-object-system/01 — 对象生命周期](../03-object-system/01-object-contract-references.md)(守护线程/线程组概念)
> → **后续**:[11-thread-threadlocal/02 — ThreadLocal 的完整解剖](02-threadlocal.md)
> 关联: 内部卷 17-threads(线程对象与状态机);JVM TI GetThreadState 规范

## 从 start 到 interrupt,一条时间线

面试从 "start 和 run 的区别" 开始,一路问到 "interrupt 之后线程还活着吗""join 是怎么等的""jstack 里的 BLOCKED 和 WAITING 有什么区别"——每一个问题背后都是 Thread 类里的一道 native 边界。这篇把四条线拆开: start 的启动流水线、sleep/yield/join 三个调度原语、interrupt 的协作式中断语义、以及线程状态的位标志解析。

## 1. "start() 到底做了什么" — synchronized + native start0

### 1.1 synchronized 的启动入口

`Thread.start()`(`Thread.java:780-807`):

```java
// Thread.java:780-807(截取核心,逐字)
public synchronized void start() {
    ...
    if (threadStatus != 0)
        throw new IllegalThreadStateException();

    /* Notify the group that this thread is about to be started
     * so that it can be added to the group's list of threads
     * and the group's unstarted count can be decremented. */
    group.add(this);

    boolean started = false;
    try {
        start0();
        started = true;
    } finally {
        try {
            if (!started) {
                group.threadStartFailed(this);
            }
        } catch (Throwable ignore) {
            ...
        }
    }
}

private native void start0();
```

四件事:

1. **`synchronized`**:整个方法加锁——防止两个线程并发 start 同一个 Thread 对象(同一把对象锁,第二个必然等第一个完成)
2. **`threadStatus != 0` 校验**(`Thread.java:788-789`):threadStatus 初值 0 对应 NEW 状态,一旦 start 过就不再是 0——**"只能启动一次"的保证**(已启动再调抛 `IllegalThreadStateException`)
3. **`group.add(this)`**(`Thread.java:794`):加入线程组、递减未启动计数——线程组簿记
4. **`start0()`**(`Thread.java:798`)→ native(`Thread.java:812`):真正的启动

`start0` 失败时的处理也值得看: `threadStartFailed`(`Thread.java:803`)通知线程组"启动失败",finally 里兜住——即使 start0 抛异常,线程组状态也要回滚。

### 1.2 native 边界:OS 线程的诞生

`start0`(`Thread.java:812`)是 native——**JVM 在这里创建 OS 线程**: 分配线程栈(`-Xss` 控制大小)、创建 pthread(Linux)、新线程的入口回调 `run()`。**线程栈的分配时机是 start,不是 new**——`new Thread()` 只是 Java 对象,`start()` 才是"这个对象背后真的长出一个内核线程"的时刻。

### 1.3 run():一个普通方法

`run()`(`Thread.java:827`)就是普通方法——**直接调 `run()` 等于在当前线程里执行一次方法调用**,没有新线程、没有新栈。这就是"为什么必须 start 不能直接 run"的机制答案: run 是回调目标,start 才是创建线程的动作。

关键设计(斜体):*Java 侧只做校验与簿记(synchronized/threadStatus/group),真正的工作在 native——OS 线程创建、栈分配、调度器登记。面试答"start 是 native 创建线程,run 只是回调"是入门;能说出"synchronized + threadStatus 检查双保险防重复启动"和"线程栈在 start 时分配"才是源码级。*

跨层标注: [内部卷: 17-threads 01-thread-hierarchy——JavaThread 对象与 OS 线程的绑定;os::create_thread → pthread_create]

## 2. "sleep/yield/join 谁让出 CPU" — 调度原语三兄弟

### 2.1 sleep:让出 CPU,不释放锁

`sleep(long, int)`(`Thread.java:319-337`):

```java
// Thread.java:319-337(截取核心,逐字)
public static void sleep(long millis, int nanos)
throws InterruptedException {
    if (millis < 0) {
        throw new IllegalArgumentException("timeout value is negative");
    }

    if (nanos < 0 || nanos > 999999) {
        throw new IllegalArgumentException(
                            "nanosecond timeout value out of range");
    }

    if (nanos >= 500000 || (nanos != 0 && millis == 0)) {
        millis++;
    }

    sleep(millis);
}
```

两个关键语义:

- **让出 CPU 但不释放锁**:sleep 是 `Thread` 的静态方法,与对象的监视器毫无关系——持锁线程 sleep,锁照持,别的线程进不来。这就是"sleep vs wait"的本质区别: wait 必须持锁调用、会释放锁;sleep 与锁无关
- **纳秒进位**:nanos >= 500000(半毫秒)时进位成 1 毫秒(`Thread.java:336` 的 `millis++`)——底层 `sleep(long)`(`Thread.java:295`)只接受毫秒,native 实现转 OS 定时器

### 2.2 yield:纯提示

`yield()`(`Thread.java:276`)是 native,语义只有一句:**提示调度器当前线程愿意让出 CPU**——纯提示,调度器可以无视。适合自旋等待时的"喘息",不保证任何时序。

### 2.3 join:wait/notify 模型,不是轮询

`join()`(`Thread.java:1374`)转调 `join(long)`(`Thread.java:1289`):

```java
// Thread.java:1289-1300(截取核心,逐字)
public final synchronized void join(long millis)
throws InterruptedException {
    long base = System.currentTimeMillis();
    long now = 0;

    if (millis < 0) {
        throw new IllegalArgumentException("timeout value is negative");
    }

    if (millis == 0) {
        while (isAlive()) {
            wait(0);
        }
    } else {
        ...
```

核心是 **wait 模型**: `while (isAlive()) wait(0)`——**无条件等待直到被唤醒**。谁唤醒?JVM 在**线程死亡路径**上对等待该线程的所有 wait 者调用 `notifyAll`(内部卷 17-threads 的线程退出流程)。所以:

- **join 不是轮询**:等待线程挂起在 wait 上,零 CPU 开销;`isAlive()` 是循环条件,被唤醒后重新检查
- **join 用 currentTimeMillis 算超时**(`Thread.java:1289-1290`):超时版 `wait(delay)` 逐次等待剩余时间

关键设计(斜体):*join 不用自旋而用 wait——线程死亡是"事件"不是"轮询目标",wait/notify 让等待者零开销挂起、事件到来再唤醒。对比自旋: 自旋是忙等(烧 CPU),wait 是休眠等(零开销)。面试"join 怎么实现"答出"while(isAlive()) wait(0) + JVM 死亡时 notifyAll"就过关;再补一句"sleep 不释放锁,wait 释放锁"就是高分。*

## 3. "interrupt 是中断线程吗" — 中断标志语义

### 3.1 interrupt:设置标志 + 唤醒阻塞

`interrupt()`(`Thread.java:979-999`):

```java
// Thread.java:979-999(截取核心,逐字)
public void interrupt() {
    if (this != Thread.currentThread()) {
        checkAccess();

        // thread may be blocked in an I/O operation
        synchronized (blockerLock) {
            Interruptible b = blocker;
            if (b != null) {
                interrupt0();  // set interrupt status
                b.interrupt(this);
                return;
            }
        }
    }

    // set interrupt status
    interrupt0();
}
```

**interrupt 不是"杀死线程"**——它只做两件事:

1. **设置中断标志**(`interrupt0()`@991/native `Thread.java:2086`)
2. **唤醒阻塞中的线程**:如果目标线程阻塞在 `wait/sleep/join`(或可中断锁 `Lock.lockInterruptibly`),被唤醒并抛 `InterruptedException`;`blocker` 分支(`Thread.java:984-993`)处理的是 **NIO 可中断 IO**(`InterruptibleChannel`——域 19)——`interrupt0` 先设标志,再调 `b.interrupt(this)` 关闭底层通道唤醒 IO 阻塞

**注意 synchronized 锁等待不可中断**:阻塞在 `synchronized` 上的线程,interrupt 只设标志,线程要等拿到锁后才在代码里自己检查标志——这就是"不可中断锁"语义。

### 3.2 两个读取方法:清除 vs 只读

```java
// Thread.java:1015-1016 + 1032-1033(截取核心,逐字)
public static boolean interrupted() {
    return currentThread().isInterrupted(true);
}

public boolean isInterrupted() {
    return isInterrupted(false);
}
```

- `interrupted()`(静态):`currentThread().isInterrupted(true)`——**返回并清除**当前线程标志,常用在循环里"清一次、处理一次"
- `isInterrupted()`(实例):`isInterrupted(false)`——只读不清除

### 3.3 协作式中断

中断是**协作式**的: interrupt 只立标志,线程自己决定何时响应——任务循环里 `if (Thread.currentThread().isInterrupted()) break;` 是标准响应模式。阻塞中被中断的语义: **标志在抛 InterruptedException 时被清空**(JVM 语义)——所以 catch 块里再调 `interrupted()` 返回 false,需要自己恢复标志(重新 `Thread.currentThread().interrupt()`)才能让上层感知。

关键设计(斜体):*interrupt 是"请求"不是"命令"——线程池 shutdownNow 能优雅关闭,靠的就是"给每个 worker 立标志 + 唤醒阻塞",worker 自行退出。面试"interrupt 一个阻塞在 IO 的线程": 传统阻塞 IO 无响应(只有 NIO InterruptibleChannel 可中断,域 19);synchronized 锁等待也不响应。能说清"哪些阻塞可中断、哪些只立标志"是这道题的完整答案。*

## 4. "线程现在是什么状态" — 状态位与 currentThread

### 4.1 currentThread:native 读 TLS

`currentThread()`(`Thread.java:258`)是 native——读取当前线程的线程局部存储(TLS)里的 JavaThread 对象引用,返回它。每次调用都是一次 native 边界,所以热点代码里要缓存(`Thread t = Thread.currentThread()`)。

### 4.2 threadStatus:JVMTI 位标志

`Thread` 的状态只有一个 `int` 字段(`Thread.java:210`):

```java
// Thread.java:210
private volatile int threadStatus;
```

**它不是 0/1/2 数字编码,而是 JVMTI 位标志**(`VM.java:304-309` 的定义:`ALIVE=0x0001`、`TERMINATED=0x0002`、`RUNNABLE=0x0004`、`BLOCKED_ON_MONITOR_ENTER=0x0400`、`WAITING_INDEFINITELY=0x0010`、`WAITING_WITH_TIMEOUT=0x0020`)。`getState()`(`Thread.java:1854`)就是位与解析:

```java
// Thread.java:1854-1857 + VM.java:282-298(截取核心,逐字)
public State getState() {
    // get current thread state
    return jdk.internal.misc.VM.toThreadState(threadStatus);
}
```

```java
// VM.java:282-298(截取核心,逐字)
public static Thread.State toThreadState(int threadStatus) {
    if ((threadStatus & JVMTI_THREAD_STATE_RUNNABLE) != 0) {
        return RUNNABLE;
    } else if ((threadStatus & JVMTI_THREAD_STATE_BLOCKED_ON_MONITOR_ENTER) != 0) {
        return BLOCKED;
    } else if ((threadStatus & JVMTI_THREAD_STATE_WAITING_INDEFINITELY) != 0) {
        return WAITING;
    } else if ((threadStatus & JVMTI_THREAD_STATE_WAITING_WITH_TIMEOUT) != 0) {
        return TIMED_WAITING;
    } else if ((threadStatus & JVMTI_THREAD_STATE_TERMINATED) != 0) {
        return TERMINATED;
    } else if ((threadStatus & JVMTI_THREAD_STATE_ALIVE) == 0) {
        return NEW;
    } else {
        return RUNNABLE;
    }
}
```

按位优先级从高到低: RUNNABLE → BLOCKED → WAITING → TIMED_WAITING → TERMINATED → NEW。六状态的对应关系:

| 状态 | 触发场景 |
|------|---------|
| NEW | 未 start |
| RUNNABLE | 可运行(含在跑) |
| BLOCKED | 等 synchronized 监视器 |
| WAITING | wait/join 无超时 |
| TIMED_WAITING | sleep/join(timeout)/wait(timeout) |
| TERMINATED | 结束 |

`threadStatus` 由 **VM 在状态转换时写入**(`VM.java:307-308` 注释:"The threadStatus field is set by the VM at state transition")——Java 侧只是持有这个被 VM 维护的字段。

关键设计(斜体):*用位标志而不是枚举值,是因为 JVMTI 状态本来就是组合位(一个线程可以同时是 ALIVE+RUNNABLE),位与解析把组合折叠成单一 Java 枚举。面试"BLOCKED vs WAITING": 等锁(监视器) vs 等事件(wait/join)——死锁检测看 BLOCKED 环。生产 jstack 的状态比 getState() 更实时: 后者是 Java 字段快照,前者直接问 VM。*

跨层标注: [内部卷: 17-threads 02-javathread-state——VM 侧状态机与 threadStatus 写入路径;JVM TI GetThreadState 规范]

## 核心悬念

线程有了生命周期——但**每个线程私有的变量**怎么存?`ThreadLocal` 挂在 `Thread.threadLocals` 字段上,面试官的下一个问题是: 它内部为什么用弱引用?为什么线程池里一定会内存泄漏?`ThreadLocal.withInitial` 和 `remove` 的源码是什么样?下一篇把 ThreadLocalMap 完整解剖——这也是"四种引用"在真实工程里最重要的一次实战。

> → [11-thread-threadlocal/02 — ThreadLocal 的完整解剖](02-threadlocal.md)
