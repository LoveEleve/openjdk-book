# 01. TPE 核心 — ctl 状态机与 Worker 结构

> **前置依赖**: [12-lock-sync/01 — AQS 核心](../12-lock-sync/01-aqs-core.md)(Worker 互斥)、[10-concurrent-collections/05 — 阻塞队列](../10-concurrent-collections/05-blocking-queues.md)(workQueue)
> → **后续**: 02-execute-worker(按写作顺序)

## 线程池先看什么

`ThreadPoolExecutor` 的核心不是"开几个线程",而是把**运行状态、线程数量、任务队列、Worker 生命周期**组合成一套状态机。

## 1. "ctl 是什么?" — 一字段两用

### 1.1 打包布局

`ThreadPoolExecutor.java:380`:

```java
// ThreadPoolExecutor.java:380-382(截取,逐字)
    private final AtomicInteger ctl = new AtomicInteger(ctlOf(RUNNING, 0));
    private static final int COUNT_BITS = Integer.SIZE - 3;
    private static final int COUNT_MASK = (1 << COUNT_BITS) - 1;
```

- 高 3 位编码 `runState`
- 低 29 位编码 `workerCount`
- `runStateOf`/`workerCountOf`/`ctlOf`(`:392-394`)负责拆包与重新组合

`ctl` 是一个 `AtomicInteger`,所以状态和线程数可以通过一次 CAS 一起更新,避免两个独立变量之间出现中间态。

面试"线程数上限": 29 位,约 5 亿;面试"ctl 为什么一个 int": 原子一致更新 + 更少的共享状态。

关键设计(斜体):*"一字段两用"让状态与线程数共用一个原子字,状态迁移和线程计数可以一次 CAS 完成。*

## 2. "生命周期状态" — 状态迁移

### 2.1 五个运行状态

源码定义五个状态(`ThreadPoolExecutor.java:385-389`):

- `RUNNING`——接收新任务,处理队列任务
- `SHUTDOWN`——不接收新任务,继续处理队列
- `STOP`——不接收新任务,不处理队列,中断正在执行的任务
- `TIDYING`——Worker 已清空,准备终止
- `TERMINATED`——终止完成

这里常被口头说成"7 态",但源码的**运行状态是 5 个**;另外 2 个通常来自把 RUNNING/SHUTDOWN 的入口和终止过程另行拆算,不应当当作独立常量。

### 2.2 迁移

- `shutdown()`推动 `RUNNING → SHUTDOWN`
- `shutdownNow()`推动 `RUNNING/SHUTDOWN → STOP`
- 最后一个 Worker 退出后进入 `TIDYING → TERMINATED`

状态不是标签,而是策略: 每个状态都决定收不收任务、处理不处理队列、是否中断 Worker。

关键设计(斜体):*"状态即策略"——状态迁移直接改变提交、排队、执行和中断行为。面试"shutdown vs shutdownNow": SHUTDOWN 继续排队任务,STOP 中断并清理。*

## 3. "Worker 为什么继承 AQS?" — 任务互斥

### 3.1 Worker 结构

```java
// ThreadPoolExecutor.java:596-611(截取,逐字)
    private final class Worker
        extends AbstractQueuedSynchronizer
        implements Runnable
    {
        private static final long serialVersionUID = 6138294804551838833L;

        final Thread thread;
        Runnable firstTask;
        volatile long completedTasks;
```

Worker 是三件东西的组合:

- `thread`(`:607`)——实际执行任务的线程
- `firstTask`(`:609`)——创建 Worker 时携带的首任务
- `completedTasks`(`:611`)——已完成任务数
- AQS 基类——提供 Worker 的独占互斥状态

### 3.2 AQS 在这里做什么

Worker 把 AQS 当作一个极简独占锁,用于表示"当前 Worker 是否空闲"。`shutdownNow`/中断控制可以据此区分正在运行的任务和空闲 Worker,避免把任务执行互斥误解成线程池全局锁。

面试"Worker 为什么继承 AQS": 复用独占状态做任务互斥,并辅助中断控制。

关键设计(斜体):*"Worker = 线程 + 首任务 + 互斥状态"——它不是普通 Runnable 包装,而是线程池控制 Worker 生命周期的载体。*

## 4. "核心参数" — 五参数语义

### 4.1 参数表

| 参数 | 锚点 | 语义 |
|------|------|------|
| `corePoolSize` | `:541` | 核心线程数 |
| `maximumPoolSize` | `:549` | 线程数上限 |
| `workQueue` | `:447` | 任务队列 |
| `keepAliveTime` | `:524` | 非核心空闲线程保留时间 |
| `threadFactory` / `handler` | `:516` | 线程创建 / 拒绝处理 |

参数不是独立旋钮: core 决定常驻规模,队列决定缓冲,maximum 决定峰值,keepAlive 决定回收节奏,handler 决定饱和后的处理方式。

面试"线程池什么时候加线程": 取决于 execute 的 core/queue/maximum 三阶段决策。

关键设计(斜体):*"参数组合决定行为"——core 决定常驻,队列决定缓冲,maximum 决定峰值。面试"线程池参数怎么选": 先定任务模型,再定队列容量与拒绝策略。*

## 核心悬念

参数知道了——**execute 怎么用**?先加线程还是先入队?`addWorker` 的双重检查、队列满的处理、拒绝的时机——下一篇: execute 流程与 Worker 生命周期。

> → [02-execute-worker.md](02-execute-worker.md)