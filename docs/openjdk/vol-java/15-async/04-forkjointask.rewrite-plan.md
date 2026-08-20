# 15-async/04 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ForkJoinTask`、`RecursiveTask`、`RecursiveAction`、`CountedCompleter`。本文聚焦 `status` 位状态、`fork/join/invoke`、`doExec/setDone/setExceptionalCompletion`、RecursiveTask/Action 分治骨架，以及 CountedCompleter 的 pending 完成传播；ForkJoinPool 执行引擎已在上一篇展开。
> 目标：把“ForkJoinTask 与分治”改写成一篇围绕“分治任务为什么不能只是一个 Runnable，而必须自带完成状态、等待语义和拆分/汇合协议”的机制文章，并把 RecursiveTask 与 CountedCompleter 的不同表达方式讲清楚。

## 1. 读者困惑

- ForkJoinPool 已经有线程和本地队列了，为什么还需要专门的 ForkJoinTask？
- `fork()`、`join()`、`invoke()` 为什么不是线程池 submit/get 的简单改名？
- `join()` 为什么能在等待时帮忙执行别的任务，而不是纯阻塞？
- ForkJoinTask 的 `status` 为什么要用位标记，不直接做布尔 done？
- `RecursiveTask`、`RecursiveAction`、`CountedCompleter` 为什么分成三种抽象，它们各自适合表达什么任务形状？
- CountedCompleter 为什么不用返回值 join，而要用 pending 计数完成传播？

## 2. 一句话顿悟

**ForkJoinTask 不是普通 Runnable 的替代品，而是为分治任务专门设计的“可 fork、可 join、可被窃取、可在池内等待时帮助推进”的任务状态机。它自己维护完成/异常/等待位状态，`fork` 负责把子任务送进池，`join` 负责在必要时等待并协助执行。RecursiveTask 用返回值汇总树形结果，CountedCompleter 则把‘什么时候算完成’改写成显式 pending 计数，更适合 DAG 或事件驱动式完成关系。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `status` 位标记、`fork/join` 骨架、RecursiveTask/Action 分治写法和 CountedCompleter 的 pending 完成传播。
- 已指出 ForkJoinTask 与 FutureTask 都有状态机，但语义侧重点不同，这是好抓手。
- 已把 FJP 执行引擎和任务抽象分成两篇，边界合理。

### 必须重写

- 旧稿偏术语速览，需要先立总问题：为什么分治任务不能只是普通 Runnable/Callable。
- `join()` 的价值要从“等待时还能帮助推进池内任务”这个场景切入，而不是只说等待结果。
- RecursiveTask/Action 要放回“树形分治结果汇总”的主线，不要只列有无返回值。
- CountedCompleter 需要讲成“把完成条件从 join 结果改成 pending 计数”的另一种编排哲学。
- 收束段要把域 15 四篇串起来：CF 负责编排，FJP 负责调度，FJT 负责任务语义。

## 4. 理解路径

### 第一节：从“为什么不能直接用 Runnable 表达分治任务”开场

用递归任务场景开场：一个任务会继续 fork 两个子任务，还要等它们回来合并结果。指出失败方案：普通 Runnable 只会“执行一次”，自己不知道如何记录完成状态、等待谁、如何在池内 join。引出 ForkJoinTask 需要自带任务状态机。

### 第二节：ForkJoinTask 为什么首先是一个完成状态机

证据：
- `ForkJoinTask.java:206`：类定义
- `ForkJoinTask.java:237`：`status`
- `ForkJoinTask.java:239-242`：`DONE/ABNORMAL/THROWN/SIGNAL`
- `ForkJoinTask.java:254-258`：`setDone`
- `ForkJoinTask.java:501`：`setExceptionalCompletion`

主线：
- ForkJoinTask 既要表达正常完成，也要表达异常、取消和等待者存在。
- `SIGNAL` 位说明 join 等待者需要被唤醒；`ABNORMAL/THROWN` 则负责异常结局可回抛。
- 这和 FutureTask 类似但更偏向池内任务协作，不只是外部结果持有。

### 第三节：`fork/join/invoke` 为什么是一套“分而后合”的任务协议

证据：
- `ForkJoinTask.java:699`：`fork`
- `ForkJoinTask.java:719-721`：`join`
- `ForkJoinTask.java:734-736`：`invoke`
- `ForkJoinTask.java:286-296`：`doExec`

主线：
- `fork` 把任务压进当前 worker 的本地队列，自己先不等结果。
- `join` 在需要结果时再等待，但等待不是纯睡眠，而可能帮助推进池内任务。
- `invoke` 则是“自己执行 + 等结果”的便捷合成。
- 这要讲成分治协议，而不是三个孤立方法。

### 第四节：为什么“先 fork 一边，当前线程算另一边”是典型骨架

证据：
- `ForkJoinTask.java:127-128`：类注释示例（`a.fork(); b.fork(); b.join(); a.join();` 相关提示）
- `RecursiveTask.java:47-53`：示例中 `f2.compute() + f1.join()`
- `RecursiveTask.java:80` / `93-94`：`compute` / `exec`
- `RecursiveAction.java:165` / `188-189`：`compute` / `exec`

主线：
- 当前线程先处理一侧，另一侧交给池内其他 worker 窃取或稍后 join。
- 这能减少无谓的任务切换和本地队列往返，是分治池与普通提交任务模型最不一样的地方。
- RecursiveTask/Action 的价值要回到这个骨架里解释。

### 第五节：join 为什么不是 Future.get 的池内翻版

证据：
- `ForkJoinTask.java:308`：内部等待注释（`Object.wait(timeout)` 相关）
- `ForkJoinTask.java:322`：`externalAwaitDone`
- `ForkJoinTask.java:381-412`：`doJoin` / `doInvoke` 相关路径

主线：
- 外部线程等待与池内 worker 等待是两种模式：池内 worker 会尽量帮助推进池中工作，而不只是僵等。
- 这说明 join 的目标不是单纯拿结果，而是尽量不浪费分治池的并行度。
- 要把它和上一域 Future.get 的“调用方阻塞等待结果”对照开。

### 第六节：CountedCompleter 为什么把“完成”改成 pending 计数传播

证据：
- `CountedCompleter.java:426`：类定义
- `CountedCompleter.java:432`：`pending`
- `CountedCompleter.java:482`：`onCompletion`
- `CountedCompleter.java:588-595`：`tryComplete`

主线：
- RecursiveTask 偏树形：等左右子任务都 join 回来再合并结果。
- CountedCompleter 不强调返回值树汇总，而是明确记录还有多少子动作没完成；计数归零时触发 `onCompletion` 并向 completer 继续传播。
- 它更适合 DAG、事件驱动或“结果不一定沿 join 树回收”的任务形态。

### 第七节：域 15 收官

主线：
- CompletableFuture 负责异步依赖编排。
- ForkJoinPool 负责 work-stealing 调度。
- ForkJoinTask / RecursiveTask / CountedCompleter 负责分治任务语义与完成协议。
- 把异步编排、执行引擎、任务抽象收成一条完整链路。

## 5. 失败方案清单

1. 用普通 Runnable/Callable 硬写分治任务，再手工拼接等待与结果汇总。
2. fork 之后立刻傻等子任务，而不让当前线程继续推进另一侧工作。
3. 把 join 当成 Future.get 的简单别名，忽略池内帮助执行语义。
4. 用 RecursiveTask 处理更适合 pending 计数驱动的 DAG 完成关系。
5. 把 CountedCompleter 当成“更复杂的 RecursiveTask”，却不理解它省掉的正是 join 结果树。
6. 把任务状态只看成 done/undone，不考虑异常、取消和等待者唤醒位。

## 6. 误解清单

1. ForkJoinTask 只是 Runnable 多了 fork/join 两个方法。
2. fork 一下就等于立刻新建一个线程去跑。
3. join 必然是纯阻塞等待，不会做额外工作。
4. RecursiveAction 只是没有返回值的差一点版本。
5. CountedCompleter 只是性能更好的 RecursiveTask。
6. ForkJoinPool 和 CompletableFuture 的关系只是“默认共用同一个池”。
7. 域 15 主要在讲 API 用法，不涉及执行与状态模型。

## 7. 证据清单

- `ForkJoinTask.java:206`：类定义
- `ForkJoinTask.java:237`：`status`
- `ForkJoinTask.java:239-242`：状态位常量
- `ForkJoinTask.java:254-258`：`setDone`
- `ForkJoinTask.java:286-296`：`doExec`
- `ForkJoinTask.java:322`：`externalAwaitDone`
- `ForkJoinTask.java:381-412`：池内/外等待路径相关
- `ForkJoinTask.java:501`：`setExceptionalCompletion`
- `ForkJoinTask.java:699`：`fork`
- `ForkJoinTask.java:719-721`：`join`
- `ForkJoinTask.java:734-736`：`invoke`
- `RecursiveTask.java:68`：类定义
- `RecursiveTask.java:80`：`compute`
- `RecursiveTask.java:93-94`：`exec`
- `RecursiveAction.java:165`：类定义
- `RecursiveAction.java:171`：`compute`
- `RecursiveAction.java:188-189`：`exec`
- `CountedCompleter.java:426`：类定义
- `CountedCompleter.java:432`：`pending`
- `CountedCompleter.java:482`：`onCompletion`
- `CountedCompleter.java:588-595`：`tryComplete`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦任务抽象和状态机，不展开 ForkJoinPool 内部队列和 ctl 细节，那些已在上一篇建立。
- 不把 CountedCompleter 全讲成图算法框架，只讲它与 RecursiveTask 的完成语义差异。
- join 的帮助执行语义只讲到够用，不打穿所有 await / helpJoin 分支。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么分治任务不能只是普通 Runnable → ForkJoinTask 为什么先是一套完成状态机 → fork/join/invoke 如何构成分而后合协议 → RecursiveTask/Action 如何表达树形分治 → CountedCompleter 为什么把完成改成 pending 计数传播 → 域 15 的编排、调度、任务抽象怎样闭环”。
- 必须把 join 与 Future.get 的池内外差异讲清。
- 必须把 CountedCompleter 的 pending 完成传播讲成另一种编排哲学。
- 必须在结尾收束整个异步域。
