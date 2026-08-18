# 03. 线程异常出口与 ThreadLocalRandom — uncaughtException 链、无锁随机数

> **前置依赖**: [11-thread-threadlocal/01 — 线程的生命周期](01-thread-lifecycle.md)(线程退出路径)、[11-thread-threadlocal/02 — ThreadLocal](02-threadlocal.md)(线程局部存储)、[06-exceptions/01 — Throwable](../06-exceptions/01-throwable-structure.md)
> → **后续**:域 13 原子类(13-atomic 系列,下一篇)
> 关联: 内部卷 17-threads(线程退出路径)

## 两个"线程私有"的收尾

线程池 `execute` 的任务抛了异常,日志里什么都没有——异常去哪了?`ThreadLocalRandom.current().nextInt()` 比 `new Random().nextInt()` 快——快在哪?这两个问题分别是线程异常出口和线程局部状态的两个极端: 一个是"异常的最后收容所",一个是"连 ThreadLocalMap 都不用"的线程私有实现。

这篇把 uncaughtException 处理链和 ThreadLocalRandom 的无锁种子机制讲清楚,最后画一张并发域的衔接地图。

## 1. "子线程的异常去哪了" — uncaughtException 链

### 1.1 出口:dispatchUncaughtException

线程 run() 返回时,如果异常一路没被捕获,VM 调用 `dispatchUncaughtException`(`Thread.java:1996-1999`):

```java
// Thread.java:1996-1999(截取核心,逐字)
private void dispatchUncaughtException(Throwable e) {
    getUncaughtExceptionHandler().uncaughtException(this, e);
}
```

就是一次普通方法调用: 把异常交给"当前线程的未捕获异常处理器"。

### 1.2 处理器链:实例 → 线程组 → 默认 → stderr

处理器怎么选?`getUncaughtExceptionHandler`(`Thread.java:1967-1970`):

```java
// Thread.java:1967-1970(截取核心,逐字)
public UncaughtExceptionHandler getUncaughtExceptionHandler() {
    return uncaughtExceptionHandler != null ?
        uncaughtExceptionHandler : group;
}
```

**实例处理器**(`uncaughtExceptionHandler`,`Thread.java:1897`,volatile)没设置时,**退回线程组**。`ThreadGroup.uncaughtException`(`ThreadGroup.java:1048-1062`)是整条链的核心:

```java
// ThreadGroup.java:1048-1062(截取核心,逐字)
public void uncaughtException(Thread t, Throwable e) {
    if (parent != null) {
        parent.uncaughtException(t, e);
    } else {
        Thread.UncaughtExceptionHandler ueh =
            Thread.getDefaultUncaughtExceptionHandler();
        if (ueh != null) {
            ueh.uncaughtException(t, e);
        } else if (!(e instanceof ThreadDeath)) {
            System.err.print("Exception in thread \""
                             + t.getName() + "\" ");
            e.printStackTrace(System.err);
        }
    }
}
```

完整链:

```
实例 uncaughtExceptionHandler(@1897)──存在──> 用它
        │ 不存在
        ▼
ThreadGroup.uncaughtException(@1048)──parent 非 null──> 逐级向上(parent 递归)
        │ 顶层线程组
        ▼
静态 defaultUncaughtExceptionHandler(@1900)──存在──> 用它
        │ 不存在
        ▼
System.err 打印 "Exception in thread \"名字\" " + 堆栈(ThreadDeath 除外)
```

### 1.3 异常"消失"的真相

**默认行为的终点就是 stderr 打印**——没有任何日志框架参与。线上 stderr 通常没人收集,所以"线程池 execute 的任务抛异常,日志里什么都没有"的真相是: 异常打印到了没人看的 stderr。

两条关键区分:

- **execute 的任务**:异常走这条链(默认 stderr)→ 看起来"消失"
- **submit 的任务**:异常被 `FutureTask` 捕获,存进 Future,`get()` 时以 ExecutionException 重新抛出(域 14 展开)

**主线程永远 catch 不了子线程的异常**——异常在子线程的栈上抛出,只能在子线程内处理(或走这条处理器链)。

关键设计(斜体):*这条链的设计是"层层兜底": 实例级(业务定制)→ 线程组级(父级递归,线程组天然有层级)→ 全局默认(进程级)→ stderr(最后防线)。生产做法: 进程启动时设置静态 `defaultUncaughtExceptionHandler` 统一记日志/上报——比每个线程单独设置干净。面试答"主线程 catch 不了子线程异常,只能靠处理器链或 Future"就过关。*

跨层标注: [内部卷: 17-threads(线程退出路径: 异常未捕获时的 dispatch 时机与 VM 侧处理)]

## 2. "ThreadLocalRandom 为什么快" — 无锁种子 + 线程局部

### 2.1 Random 的问题:一颗共享种子的 CAS 竞争

`java.util.Random` 的核心是一个 `AtomicLong seed`——`next()` 每次用 CAS 更新: `seed.compareAndSet(old, old * 0x5DEECE66D + 0xB)`。**高并发下所有线程争抢同一个 AtomicLong**,CAS 失败重试,争抢激烈时吞吐崩塌。随机数在高并发场景(UUID、限流、采样)是热点,这成为瓶颈。

### 2.2 ThreadLocalRandom:每线程独立种子

`ThreadLocalRandom.current()`(`ThreadLocalRandom.java:176-183`):

```java
// ThreadLocalRandom.java:176-183(截取核心,逐字)
public static ThreadLocalRandom current() {
    if (U.getInt(Thread.currentThread(), PROBE) == 0)
        localInit();
    return instance;
}
```

- **每线程一份独立种子**——没有共享状态,天然无锁、无 CAS 竞争
- `PROBE`(探针哈希)为 0 表示"本线程还没初始化",`localInit()`(`ThreadLocalRandom.java:165`)首次生成种子: `long seed = mix64(seeder.getAndAdd(SEEDER_INCREMENT))`——静态 `AtomicLong seeder`(`ThreadLocalRandom.java:1082`)只在**初始化时**被访问一次,之后完全脱离共享状态

### 2.3 种子存放:UNSAFE 直写 Thread 字段

种子存在哪?——**Thread 对象的字段里**(`Thread.java:2071`):

```java
// Thread.java:2071
long threadLocalRandomSeed;
```

更新用 **UNSAFE 直接读写**(`nextSeed`,`ThreadLocalRandom.java:194-199`):

```java
// ThreadLocalRandom.java:194-199(截取核心,逐字)
final long nextSeed() {
    Thread t; long r; // read and update per-thread seed
    U.putLong(t = Thread.currentThread(), SEED,
              r = U.getLong(t, SEED) + GAMMA);
    return r;
}
```

种子递进是纯加法: `seed + GAMMA`,其中 `GAMMA = 0x9e3779b97f4a7c15L`(`ThreadLocalRandom.java:1030`)——**64 位黄金比例常数**(`(√5-1)/2 × 2^64` 的整数部分,程序验证 `0x9E3779B97F4A7C15 / 2^64 = 0.618033988749895` 精确等于 `(√5-1)/2`)。它与域 11 第 2 篇的 32 位常数同属黄金比例家族,但数值对应关系要分清: 64 位的直接 32 位同族是 `0x9E3779B9`(同为 `(√5-1)/2` 表示),而 02 篇的 `0x61C88647` 是它的**平方互补值** `(3-√5)/2`。为什么敢用 UNSAFE 直写而不用 volatile 字段?**种子只在线程内使用**(每次用 `Thread.currentThread()` 取自己的线程),不存在跨线程可见性需求——unsafe 直写省掉 volatile 的屏障开销。

### 2.4 两种"线程局部"的对照

| | ThreadLocal | ThreadLocalRandom |
|---|---|---|
| 存储 | Thread.threadLocals(ThreadLocalMap,Entry 弱 key) | Thread.threadLocalRandomSeed(裸字段) |
| 访问 | getMap → getEntry(探测链) | UNSAFE 直读直写 |
| 清理 | 需要 remove/清理链 | 随线程死亡废弃(无 Entry 壳) |
| 适用 | 任意对象值 | 固定单值(种子) |

ThreadLocalRandom 是"线程私有"的更极端形态: **连 ThreadLocalMap 的开销都不要**——一个裸 long 字段 + 直接偏移读写。

关键设计(斜体):*"线程局部"有两种实现: ThreadLocal 挂在 map(可清除、可继承、任意值)vs ThreadLocalRandom 挂在裸字段(UNSAFE 直写、零间接)。随机数只需"线程内可见、线程内消费",没有跨线程共享需求,所以不走 ThreadLocalMap 那套弱引用+清理链的机制。面试点: "为什么 nextInt 没有线程安全问题"——每线程独立状态机 + UNSAFE 私有字段访问,不同线程读到的种子不同、互不干扰。*

跨层标注: [域 32 Unsafe 展开: U.objectFieldOffset 计算线程字段偏移,UNSAFE 直写的机制]

## 3. 线程域收尾 — 并发体系地图

### 3.1 接下来往哪走

本域是并发知识的地基,后续的依赖关系:

```
域 11 线程(语言级:synchronized/volatile/Thread)  ← 本域
  └── 域 13 原子类(volatile 语义 + CAS 指令封装)   ← 下一篇
        └── 域 12 锁与同步器(AQS 基于 CAS + volatile 状态)
              └── 域 14 线程池(Worker 用 AQS 状态管理)
                    └── 域 15 异步编程(CompletableFuture 基于线程池)
```

### 3.2 本域各篇的衔接

- **01 篇**(线程原语):start/interrupt/join 是语言级 API,对应内部卷 17-threads 的 JavaThread/OSThread
- **02 篇**(ThreadLocal):泄漏治理与 remove 规范——在域 14 线程池复用场景会重点展开(池化线程不销毁,ThreadLocal 的坑被放大)
- **03 篇**(本篇):异常出口 + 线程私有随机数——execute/submit 的异常差异在域 14 兑现

关键设计(斜体):*域 11 是并发域的"语言级地基"——synchronized/volatile/Thread 是语言自带语义;域 12-15 是"工具级"——AQS/原子类/线程池/CompletableFuture 都是建在地基上的库。面试链路: 从"线程怎么启动"一路问到"AQS 怎么实现",这条链就是从本域出发的。*

## 核心悬念

线程能并发了,但**共享变量怎么保证可见性**?`volatile` 是语言级关键字,它背后的内存屏障、CAS 指令、缓存一致性协议才是并发的底层真相——`synchronized` 的锁升级、AQS 的状态机、原子类的无锁更新,全都建立在这套内存语义上。下一站: 域 13 原子类与内存语义,再往上就是面试必考的 AQS(域 12)。

> → 下一篇: 域 13 原子类(13-atomic 系列)| 关联: 域 12 锁与同步器、域 14 线程池
