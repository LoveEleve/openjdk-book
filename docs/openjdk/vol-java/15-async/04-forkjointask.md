# 04. ForkJoinTask 与分治 — 任务状态机、fork/join、CountedCompleter

> **前置依赖**: [15-async/03 — ForkJoinPool work-stealing](03-forkjoinpool.md)(执行引擎)、[14-threadpool/04 — FutureTask](../14-threadpool/04-futuretask-scheduled.md)(Future 状态对照)
> 关联: [16-stream/06 — Spliterator 与并行](../16-stream/06-spliterator-parallel.md)(并行分治)

## ForkJoin 任务怎么写

`ForkJoinPool` 只是执行引擎,`ForkJoinTask` 才是分治任务的抽象。这一篇看状态、fork/join、RecursiveTask 与 CountedCompleter。

## 1. "ForkJoinTask 的状态" — status 位标记

### 1.1 状态布局

`ForkJoinTask`(`ForkJoinTask.java:206`)实现 `Future<V>`;核心字段是 `volatile int status`(`:237`)。

状态位定义(`:239-243`):

- `DONE = 1 << 31`——完成标志
- `ABNORMAL = 1 << 18`——取消或异常
- `THROWN = 1 << 17`——记录异常
- `SIGNAL = 1 << 16`——存在等待者
- `SMASK = 0xffff`——短标签位

### 1.2 异常完成

`abnormalCompletion`(`:267`)用 CAS 设置异常完成状态。`join` 检查 `DONE/ABNORMAL`,必要时把异常重新抛给调用方。

关键设计(斜体):*"状态 = int 位标记"——完成、异常/取消、等待者和标签共用一个状态字。面试"ForkJoinTask 状态": 正常完成、异常完成、取消完成三类。*

## 2. "fork/join 的语义" — 分治骨架

### 2.1 fork

`fork()`(`ForkJoinTask.java:699`)把任务提交到当前 ForkJoinPool 的 WorkQueue(`:704`),本身不等待任务完成。

### 2.2 join

`join()`(`:719`)通过 `doJoin()`等待结果;如果当前线程属于 ForkJoinPool,等待过程中可以帮助执行其他任务,避免纯阻塞浪费并行度。

经典骨架:

```java
ForkJoinTask<Integer> left = ...;
ForkJoinTask<Integer> right = ...;
left.fork();
int rightResult = right.invoke();
int leftResult = left.join();
return rightResult + leftResult;
```

先 fork 一边,当前线程处理另一边,最后 join——这是工作窃取模型下常见的局部顺序。

关键设计(斜体):*"fork = 分,join = 合"——fork 把子任务放入池,当前线程继续做本地工作,join 时再等待/协助。面试"fork/join 为什么高效": 子任务可被其他 Worker 窃取。*

## 3. "RecursiveTask/RecursiveAction" — 分治写法

### 3.1 两种抽象

- `RecursiveTask.compute()`(`RecursiveTask.java:80`)——有返回值;`exec`(`:93`)负责把计算接入 ForkJoinTask 状态机
- `RecursiveAction`(`RecursiveAction.java:165`)——无返回值;适合数组填充、树遍历等副作用任务

### 3.2 标准分治

1. 判断区间是否小于阈值
2. 小任务直接计算
3. 大任务拆成左右子任务
4. fork 一侧,当前线程计算另一侧
5. join 并合并结果

关键设计(斜体):*"分治 = 阈值 + 拆分 + 合并"——阈值太小会产生大量任务管理开销,太大则并行不足。生产: 大数组计算/树遍历需要压测选择粒度。*

## 4. "CountedCompleter" — 计数完成

### 4.1 pending 计数

`CountedCompleter` 用 pending count 表示尚未完成的子任务数量。子任务完成时调用 `tryComplete()`(`CountedCompleter.java:588`):

- pending 非零 → 减少计数
- 计数归零 → 调用 `onCompletion`
- 再向 completer 父节点传播完成

它不要求像 RecursiveTask 那样返回一个树形结果,更适合依赖关系复杂的 DAG。

### 4.2 选型

- 结果需要递归汇总: `RecursiveTask`
- 无返回值的递归动作: `RecursiveAction`
- 完成依赖由计数表达: `CountedCompleter`

关键设计(斜体):*"CountedCompleter = 显式完成计数"——计数归零触发完成回调并向父节点传播。面试"RecursiveTask vs CountedCompleter": 前者偏树形返回值,后者偏计数驱动的依赖图。*

## 本域收官

域 15 把异步链与并行执行引擎接通: CompletableFuture 负责编排, ForkJoinPool 负责调度, ForkJoinTask/RecursiveTask 负责分治。它与原子、锁、集合、线程池共同组成并发体系的完整链路。

后续按路线进入下一阶段的写作顺序。