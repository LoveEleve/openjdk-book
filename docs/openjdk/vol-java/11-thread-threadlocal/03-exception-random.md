# 线程异常出口与 ThreadLocalRandom：线程私有状态的两种命运

> 本文基于 JDK 11 `Thread`、`ThreadGroup` 与 `ThreadLocalRandom`。讨论重点是未捕获异常处理链、实例/默认处理器、线程组兜底，以及 `ThreadLocalRandom` 的每线程种子初始化和线程字段直挂模型。`FutureTask`、线程池 execute/submit 的完整实现细节留到后续线程池专题。
> **前置依赖**：[线程的生命周期与调度原语](01-thread-lifecycle.md)、[ThreadLocal 原理与内存泄漏](02-threadlocal.md)、[Throwable 结构](../06-exceptions/01-throwable-structure.md)
> **后续**：域 13 原子类、域 14 线程池与任务执行

## 先看两个都和“线程私有”有关，却走向完全不同的结局

线程里的私有状态，并不总是拿来存业务上下文。它有时是“这个线程最后失败时，异常到底交给谁”，有时又是“这个线程高频生成随机数时，怎样完全避开别人的竞争”。这两类问题看起来毫无关系，实际上都在问同一件事：**既然线程是独立执行体，某些状态到底应该怎样绑在线程身上，并在退出、失败或高频访问时被处理。**

第一类场景最常见也最容易让人抓狂：子线程里抛了异常，主线程 try/catch 根本接不住；线程池 `execute()` 提交的任务炸了，日志框架里却什么都没有，只有进程 stderr 一闪而过一条堆栈。异常当然不是凭空蒸发了，而是沿着线程自己的退出路径找最后兜底人。

第二类场景则出现在完全不同的地方：并发下反复调用随机数。你如果让所有线程共享一个状态源，它们就会在同一个 seed 更新点上互相撞；可如果每个线程自己带一份随机状态，高频路径上就可以没有共享竞争。`ThreadLocalRandom` 正是这么做的，而且它甚至比普通 `ThreadLocal` 更激进——连 `ThreadLocalMap` 都不走，直接把种子塞在线程对象字段里。

所以这篇不把“未捕获异常”和“随机数性能”当作两段独立冷知识，而是把它们放在同一条收官主线上：**线程私有状态有两种命运——一种在失败时要找到最后的收容链，一种在高频运行时要尽量消掉共享争用。**

## 一、子线程异常为什么经常像“消失”了一样：因为它根本不会回到主线程栈上

### 先拆掉“主线程 catch 一切”的直觉

很多人写并发代码时，会潜意识把异常传播理解成单线程那套：谁调用谁，异常就沿着栈往上冒。这个直觉一旦搬到多线程里，就会立刻出错。主线程创建了子线程，不代表子线程里的异常还能沿着主线程的调用栈冒回来。线程一旦分叉，栈也就分叉了；子线程有自己的执行栈、自己的退出路径、自己的收尾逻辑。

这也是为什么主线程的 try/catch 接不住子线程里未捕获异常：不是 catch 失灵了，而是异常根本不在那条栈上抛出。它最后只能在线程自己的边界上处理，或者走线程自己的兜底链。

### 未捕获异常的真正出口就在当前线程对象上

JDK 11 给这件事设计了一个明确出口：`dispatchUncaughtException`，位于 `Thread.java:1996-1997`：

```java
// Thread.java:1996-1997
private void dispatchUncaughtException(Throwable e) {
    getUncaughtExceptionHandler().uncaughtException(this, e);
}
```

这段代码看上去非常朴素，但它把关键事实说透了：当异常一路没有在线程内部被接住时，JVM 不会把它扔回调用者线程，而是在线程自己的退出路径上，去找“这个线程的未捕获异常处理器”。

也就是说，问题已经从“异常沿谁的调用栈传播”切换成了“**当前线程的最后责任人是谁**”。

### 处理器链为什么是“实例 → 线程组 → 默认 → stderr”

JDK 11 中，这条责任链的关键节点都在 `Thread` 自己身上：

- `UncaughtExceptionHandler` 接口（`Thread.java:1884`）
- 实例处理器字段 `uncaughtExceptionHandler`（`Thread.java:1897`）
- 默认处理器字段 `defaultUncaughtExceptionHandler`（`Thread.java:1900`）
- `getUncaughtExceptionHandler()`（`Thread.java:1967`）
- `setUncaughtExceptionHandler()`（`Thread.java:1987`）
- `setDefaultUncaughtExceptionHandler()`（`Thread.java:1935`）

`getUncaughtExceptionHandler()` 的逻辑非常关键：如果线程实例自己设置了 handler，就优先用它；否则退回线程组。线程组再往上走父级链，直到最顶层，再看有没有全局默认处理器；再没有，才退化成 stderr 打印。`ThreadGroup.uncaughtException()` 的核心路径在 `ThreadGroup.java:1048-1055` 一带。

把这条责任链画出来：

```text
线程实例 handler
  → 没有就交给线程组
  → 线程组继续向 parent 递归
  → 到顶层后看 default handler
  → 再没有就打印到 stderr
```

这条链不是多余保险，而是在回答一个非常实际的问题：**如果没人显式接住线程里的异常，系统最晚也要决定由谁来知道它。**

## 二、为什么默认终点常常只是 stderr：异常没丢，只是没人收容它

### 这就是“日志里没有，但异常其实发生了”的真相

如果线程没设置实例级 handler，线程组也没有把异常转给业务处理器，全局默认 handler 也没设置，那 JDK 最后的动作通常只是把信息打印到标准错误输出。注意，这里没有任何日志框架自动介入。

这正是很多线上“异常像消失了”的真相：异常不是没抛，也不是 JVM 吞掉了，而是默认出口只剩 stderr。你的日志系统如果没有接住 stderr，或者容器环境没有正确收集标准错误流，异常就会表现成“代码炸了，但业务日志没有记录”。

所以在生产系统里，真正靠谱的策略不是赌每个线程都手动设置实例 handler，而是在进程入口统一配置默认未捕获异常处理器，让最后一道责任链至少能接进统一日志和告警体系。

### `execute` 和 `submit` 为什么让人感觉异常表现不同

这时再看线程池里最常见的困惑：为什么 `execute()` 提交的任务炸了，经常直接走到未捕获异常链；而 `submit()` 提交的任务，异常往往被 `Future` 包住，要等 `get()` 时才感知？本质就在于：前者更接近“线程里的异常没人兜住”，后者则更接近“任务框架先把异常转存起来”。

本文不展开 `FutureTask` 的完整实现，但这里至少要立住一个边界：**线程级未捕获异常处理链和任务框架级异常包装，不是同一条路。** 这也解释了为什么很多团队只盯着线程级 handler，却仍然会在 `submit` 路线上漏掉异常消费。

这一层的收束是：子线程异常没有神秘消失，它只是沿着线程自己的责任链去找收容所；而默认收容所，很多时候并不是你平时看的业务日志。

## 三、共享 Random 为什么会在并发下变成热点：因为所有线程都在抢同一个状态源

### 先看最直觉、也最容易被忽略的问题

随机数经常被当成小工具，似乎和并发核心路径没什么关系。但一旦系统里很多线程都在高频生成随机数，比如限流采样、负载均衡选择、会话 ID 辅助计算、内部扰动值生成，共享随机状态就会变成热点。

朴素方案是多个线程共享一个 `Random` 实例。这个方案的问题不是不正确，而是所有线程都要在同一个内部 seed 更新点上发生竞争。每次你要下一个随机值，都得先把共享状态推进一步；线程越多，高频更新点越拥挤。

这和前面讲 ThreadLocal 泄漏时的失败方案推演很像：看起来是“大家共用一个就好了”，真正代价却是把所有线程重新压回一个共享位置上互撞。对随机数这种高频工具路径来说，这种共享热点本身就可能成为瓶颈。

## 四、ThreadLocalRandom 为什么不走 ThreadLocalMap，而是把状态直接挂在线程字段上

### 先看它到底把状态放哪了

如果只是想“每线程一份随机数种子”，最容易想到的方案是直接用 `ThreadLocal<Random>`。JDK 没这么做。原因很简单：这条路径太重了。ThreadLocalMap 查找、Entry 管理、弱 key 清理、remove 边界，这些都是为“任意业务值”的通用线程私有存储准备的；随机数种子这种高频、固定用途、纯线程内消费的状态，没必要背这整套成本。

JDK 11 直接把相关字段挂到了 `Thread` 对象上：

- `threadLocalRandomSeed`（`Thread.java:2071`）
- `threadLocalRandomProbe`（`Thread.java:2075`）
- `threadLocalRandomSecondarySeed`（`Thread.java:2079`）

这已经把设计态度说明得很彻底了：**如果一个线程私有状态足够固定、访问足够高频，JDK 宁愿把它做成线程对象上的裸字段，也不愿让它通过 ThreadLocalMap 间接访问。**

### `current()` 和 `localInit()` 怎么把共享竞争压缩到初始化阶段

`ThreadLocalRandom.current()` 在 `ThreadLocalRandom.java:176-178`：

```java
// ThreadLocalRandom.java:176-178
public static ThreadLocalRandom current() {
    if (U.getInt(Thread.currentThread(), PROBE) == 0)
        localInit();
```

第一次进入当前线程时，如果 probe 还没初始化，就走 `localInit()`（`ThreadLocalRandom.java:162-168`）。在那里，JDK 才会触碰共享的初始化源：

- `probeGenerator`（`ThreadLocalRandom.java:1074`）
- `SEEDER_INCREMENT`（`ThreadLocalRandom.java:1040`）

也就是说，共享写入并没有彻底消失，而是**被压缩到初始化那一刻**。线程一旦拿到了自己的 probe 和 seed，后续高频路径就主要围绕当前线程对象上的字段打转，不再让所有线程都回到同一个共享随机状态源上竞争。

这就是 ThreadLocalRandom 真正的优化重点：不是“随机算法更高级”，而是**高频路径只动线程私有状态，共享竞争只发生在初始化阶段。**

### `nextSeed()` 为什么代表了它的核心优势

种子推进的关键入口在 `ThreadLocalRandom.java:194-197`：

```java
// ThreadLocalRandom.java:194-197
final long nextSeed() {
    Thread t; long r;
    U.putLong(t = Thread.currentThread(), SEED,
              r = U.getLong(t, SEED) + GAMMA);
```

这里最值得记住的不是 `GAMMA` 常量本身（它定义在 `ThreadLocalRandom.java:1030`），而是这件事的执行位置：**读取的是当前线程对象上的 seed，写回的也是当前线程对象上的 seed。** 也就是说，线程每次取随机数时，推进的是自己的状态机，而不是别人共享的那一颗全局种子。

这就是它相比共享 `Random` 的根本优势：没有一群线程反复在同一个状态点上 CAS 或竞争，大家各自转自己的轮子。

## 五、为什么这也算“线程私有状态”，却和 ThreadLocal 完全不是一条实现路线

### 前一篇讲的是“线程私有值容器”，这一篇讲的是“线程私有高频字段”

把 ThreadLocal 和 ThreadLocalRandom 放在一起看，特别能帮助读者真正理解“线程私有”并不是一种固定实现。

前一篇的 ThreadLocal 解决的是：我要给任意业务值找一个线程私有容器，因此需要一张 map、需要 key、需要清理、需要 remove、需要继承边界。它强在通用性，代价是结构更重、生命周期管理更麻烦。

而 ThreadLocalRandom 解决的是：我要给每个线程准备一份固定用途的高频随机状态，因此根本不需要通用 map，不需要弱引用 Entry，也不需要用户代码手动 remove。它强在路径极短，代价是用途极专，不适合承载任意业务值。

把两者对照成一张表：

```text
ThreadLocal
  → 任意业务值
  → 挂在线程的 ThreadLocalMap 上
  → 通用，但有清理与泄漏边界

ThreadLocalRandom
  → 固定用途的随机种子/探针
  → 直接挂在线程字段上
  → 极轻，但只服务这一类状态
```

这一节真正想让读者留下的结论是：**“线程私有状态”不是单一机制，而是一类设计目标。JDK 会根据状态的用途、频率和生命周期，选择 ThreadLocalMap 或线程裸字段这种完全不同的落点。**

## 六、域 11 收官：线程对象既是生命周期宿主，也是私有状态宿主

### 把三篇真正串成一条线

到这里，`11-thread-threadlocal` 这一域才算完整闭环。

第一篇讲的是 Thread 对象何时从普通对象变成真实线程，以及 `start`、`join`、`sleep`、`interrupt` 这些控制协议站在哪些边界上。第二篇讲的是一旦线程长期活着，为什么任意业务值可以挂到线程私有 map 上，以及为什么这会带来泄漏与串值边界。第三篇则把线程私有状态的另外两端拉了出来：异常失败时，线程如何沿自己的责任链找最后收容所；高频随机状态时，线程又如何直接把种子挂在自己身上，彻底躲开共享竞争。

把它们压成一张线程私有状态地图：

```text
Thread 对象
  ├── 生命周期入口：start / run / join / interrupt
  ├── 通用私有值：ThreadLocalMap
  │       └── 弱 key / 强 value / remove 边界
  ├── 异常收尾：UncaughtExceptionHandler 责任链
  └── 高频私有状态：threadLocalRandomSeed / probe
```

这张图很重要，因为它说明 Thread 不只是“一个跑任务的壳”，它还是 Java 并发模型里很多线程级协议的真实落点。

## 收网：线程私有状态的两种命运，一个是兜底失败，一个是消灭共享热点

回到开头的两个问题，现在已经能把它们放进同一条主线上了。

子线程异常之所以不会回到主线程，不是因为 JVM 漏掉了它，而是因为异常的最后命运属于线程自己的退出责任链：实例处理器、线程组、默认处理器、stderr。你有没有看见，只取决于这条链最后有没有接进你真正采集的日志出口。

`ThreadLocalRandom` 之所以比共享 `Random` 更适合并发，不是因为它多了一层魔法封装，而是因为它把高频随机状态变成了线程对象自己的字段。初始化时才短暂触碰共享源，运行时则只推动当前线程自己的 seed，于是共享竞争不再出现在热路径上。

把这篇压成一句话，就是：**线程私有状态在失败时要有最后兜底人，在高频时要尽量不再共享。** 这正好是域 11 的两个收尾方向。

下一站就不再停留在线程语言级 API 上了。进入域 13 和域 12 后，问题会变成：共享变量一旦必须被多线程共同读写，`volatile`、CAS、原子类和 AQS 状态机到底怎样把这些线程级基础设施接成真正的并发同步原语。