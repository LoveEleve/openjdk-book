# 为什么线程池不建议使用无界队列？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`42-production-practice/01-thread-pool-governance`
> 版本边界：下文引用的 `Executors.java`、`ThreadPoolExecutor.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

为什么很多规范都不建议线程池使用无界队列？它看起来不是更安全吗——至少不会轻易拒绝任务。

## 常见答法

> 因为无界队列可能把内存撑爆，所以不建议用。

这个答法方向对，但只讲了结果，没讲清机制。**无界队列的问题不只是"可能 OOM"，而是它会改写线程池的扩容行为：一旦工作队列能一直接任务，线程池在 `corePoolSize` 忙满之后会优先入队，而不是继续扩到 `maximumPoolSize`。结果就是 `maximumPoolSize` 基本失效，吞吐上不去，延迟却在队列里无限累积。**

## 追问一：为什么用了无界队列后，`maximumPoolSize` 基本失效？

> 答：因为 `ThreadPoolExecutor` 的策略是"核心线程满了先入队，入队失败才扩容"；无界队列几乎不会失败。

`ThreadPoolExecutor` 的队列策略 Javadoc 写得很直白：如果用了无界队列（例如不设容量的 `LinkedBlockingQueue`），当所有 `corePoolSize` 线程都忙时，新任务会继续排队，因此不会再创建超过 `corePoolSize` 的线程，`maximumPoolSize` 也就不起作用了（`ThreadPoolExecutor.java:173-178`）。

这也是为什么 `Executors.newFixedThreadPool(n)`（`Executors.java:91-94`）虽然底层是 `ThreadPoolExecutor`，但因为配的是无界 `LinkedBlockingQueue`，它本质上就是一个"固定 n 个工作线程 + 无限排队"的模型。

## 追问二：那它真正的风险只是 OOM 吗？

> 答：不是。更常见的是延迟失控、堆积失控、故障扩散比 OOM 更早发生。

无界队列最危险的地方往往不是一下子把 JVM 撑爆，而是：**生产速度持续高于消费速度时，任务会在队列里越堆越长。** 这会带来几层连锁反应：

- 请求响应时间越来越长
- 超时任务继续堆在队列里，占着内存和对象引用
- 上游重试进一步放大流量，形成雪崩
- 即使没 OOM，服务也已经先进入"看起来活着、其实处理不过来"的假死状态

所以无界队列掩盖的不是错误，而是**背压信号**。系统本该在处理不过来时尽早暴露压力，但无界队列把这个信号延后了。

## 追问三：那什么时候无界队列才勉强合理？

> 答：任务彼此独立、执行时间稳定、突发只是短暂抖动，而且你明确接受"固定线程数 + 排队"模型时。

`ThreadPoolExecutor` 的 Javadoc 也承认：无界队列有时能平滑短暂突发（`ThreadPoolExecutor.java:181-184`）。但前提非常苛刻——任务之间没有依赖，不会互相阻塞；你对峰值延迟有容忍度；并且流量高于处理能力只是瞬时而不是长期。

现实里更稳妥的选择通常是：**有界队列 + 明确拒绝策略 + 业务降级/回退**。这样线程池在系统过载时能尽早给出背压，而不是把问题埋到队列深处。

## 源码证据

- `Executors.newFixedThreadPool(n)`（`Executors.java:91-94`）：默认就是无界 `LinkedBlockingQueue`
- `ThreadPoolExecutor` 队列策略 Javadoc（`ThreadPoolExecutor.java:173-178`）：无界队列下不会创建超过 `corePoolSize` 的线程，`maximumPoolSize` 失效
- `ThreadPoolExecutor` 队列策略 Javadoc（`ThreadPoolExecutor.java:182-184`）：明确指出持续高于处理速度时会出现无界增长

## 一句话顿悟

**线程池不建议用无界队列，不只是因为“可能 OOM”，而是因为它把系统的过载信号藏进了无限排队里：线程不再继续扩，`maximumPoolSize` 近乎失效，延迟和堆积却会越来越大。** 面试官真正想听的不是你会背"无界队列危险"，而是你知道危险来自线程池的调度策略本身，而不是来自 `LinkedBlockingQueue` 这一个类名。