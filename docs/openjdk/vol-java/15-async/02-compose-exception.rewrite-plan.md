# 15-async/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `CompletableFuture`。本文聚焦 `thenCompose`、`thenCombine`、`whenComplete`、`handle`、`exceptionally`、`allOf`、`anyOf`、超时补偿与组合依赖节点；ForkJoinPool 执行引擎细节留到下一篇。
> 目标：把“CompletableFuture 组合与异常”改写成一篇围绕“单源回调只是开始，真正难的是两个结果怎么汇合、异常怎么沿链传播并被接管、以及批量等待怎样不把线程重新塞回阻塞模型”的机制文章。

## 1. 读者困惑

- `thenApply` 已经能接下一步了，为什么还要 `thenCompose`、`thenCombine`、`allOf`、`anyOf` 这些组合方法？
- 为什么 `thenCompose` 不是简单的 `thenApply` 返回另一个 Future？
- 两个异步结果汇合时，谁负责等谁，为什么组合节点不需要显式阻塞线程？
- `exceptionally`、`handle`、`whenComplete` 看起来都和异常有关，它们的角色到底差在哪？
- 异常在 CompletableFuture 链上为什么经常像数据一样往后流，直到被某个节点接管？
- `allOf` / `anyOf` 为什么一个返回 `Void`、一个返回 `Object`，这背后反映了什么组合语义？
- 超时为什么不是给 `get()` 加个 timeout 就完，而是可以直接写进异步链里？

## 2. 一句话顿悟

**CompletableFuture 的单链回调只是异步编排的起点；一旦进入真实业务，关键问题立刻变成“多个结果怎么汇合”“异常什么时候继续向后传播、什么时候被接管”“一批任务怎么形成非阻塞屏障”。`thenCompose` 解决的是把‘Future 的 Future’压平，`thenCombine`/`allOf`/`anyOf` 解决的是多源汇合，`exceptionally`/`handle`/`whenComplete` 则在定义异常是继续当作失败信号流动，还是在某个节点被转成新的正常结果。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖双源汇合、异常接管、allOf/anyOf、超时补偿和生产规范。
- 已指出 `exceptionally` 是恢复、`whenComplete` 是观察，这个区分方向正确。
- 已把执行引擎留给下一篇 ForkJoinPool，篇章边界合理。

### 必须重写

- 旧稿偏“方法族概览”，需要先建立总问题：异步真正难在多源组合和异常控制，而不是单链 thenApply。
- `thenCompose` 应加入主线，突出“Future 的 Future 必须压平”这一典型坑。
- `thenCombine` / `allOf` / `anyOf` 要讲成三种不同汇合语义，而不是单独列几个 API。
- 异常传播要强调“异常像结果一样沿链流动，直到被接管”，而不是只列处理方法说明。
- 超时和降级应收在“异步链的最后护栏”这一收尾段里。

## 4. 理解路径

### 第一节：从“单链不是异步编排终点”开场

承接上一篇：thenApply 解决的是单源单链传播，但真实业务经常是 A 的结果继续异步查 B、同时等 C 和 D，再决定是降级还是继续。先立问题：编排的难点是多源与异常，而不是再多写几个 then。

### 第二节：`thenCompose` 为什么是在压平“Future 的 Future”

证据：
- `CompletableFuture.java:2239-2252`：`thenCompose` 三个重载
- `CompletableFuture.java:1089`：`uniComposeStage`

主线：
- 朴素失败方案：用 `thenApply` 返回一个新的 CompletableFuture，结果得到嵌套 future。
- `thenCompose` 的本质是把“源完成后再拿到另一个 future”压平成一条连续异步链，而不是让调用方再手工解第二层。
- 这要作为本文的第一类组合问题先讲透。

### 第三节：`thenCombine` 为什么是“双源汇合”，不是“链上再接一步”

证据：
- `CompletableFuture.java:1190+`：`BiApply` 相关节点（按需在正文里点名）
- `CompletableFuture.java:1404`：`BiRelay`
- `CompletableFuture.java` 中 thenCombine 对应入口（重写时按需补精确行号或用现有 Bi 结构锚点）

主线：
- 两个源谁先完成都不够，必须两边都到齐才能执行组合函数。
- 组合节点像一个异步汇合点，而不是在某一边线程里阻塞等另一边。
- 强调它靠 Completion 节点和完成事件协作，而不是线程 join 式等待。

### 第四节：异常为什么会像数据一样沿链传播，直到被人接管

证据：
- `CompletableFuture.java:844-875`：`uniWhenComplete` / `uniWhenCompleteStage`
- `CompletableFuture.java:914-938`：`uniHandle` / `uniHandleStage`
- `CompletableFuture.java:977-996`：`uniExceptionally` / `uniExceptionallyStage`
- `CompletableFuture.java:2255-2282`：`whenComplete` / `handle`
- `CompletableFuture.java:2311-2313`：`exceptionally`

主线：
- 普通下游阶段看到上游异常时，通常不会执行原函数，而是继续带着异常往后传播。
- `whenComplete` 只观察，不把异常变正常；`exceptionally` 专做恢复；`handle` 两边都接住并产出新结果。
- 这样就能把“记录日志”“兜底默认值”“统一转换成业务结果”三个角色彻底区分开。

### 第五节：allOf / anyOf 为什么代表两种完全不同的批量语义

证据：
- `CompletableFuture.java:1404`：`BiRelay`（allOf 的基础节点）
- `CompletableFuture.java:2342`：`allOf`
- `CompletableFuture.java:2361`：`anyOf`

主线：
- `allOf` 解决的是“所有人都到齐”，所以返回 `Void`，结果需要调用方自行再拆各个 future。
- `anyOf` 解决的是“谁先完成就先用谁”，所以直接返回一个 `Object` 结果视图。
- 一个是异步屏障，一个是竞速选择，不要只背名字。

### 第六节：超时和降级为什么是异步链的最后护栏

证据：
- `CompletableFuture.java:2631`：`orTimeout` 关联逻辑
- `CompletableFuture.java:2653`：`completeOnTimeout` 关联逻辑

主线：
- 只在 `get(timeout)` 上超时，说明调用方等太久；而把超时写进链里，说明任务本身在规定时间后应转成异常或默认值。
- `orTimeout` 是把超时变成失败信号；`completeOnTimeout` 是把超时变成降级结果。
- 这让超时从“调用者姿势”升级成“编排语义的一部分”。

## 5. 失败方案清单

1. 用 `thenApply` 返回一个新的 CompletableFuture，却不压平嵌套 future。
2. 两个结果汇合时在回调里手工 `join()` 另一个 future，把异步编排退化回阻塞等待。
3. 把 `whenComplete` 当成恢复节点使用，结果异常仍然继续向后流。
4. 在任何异常场景都用 `exceptionally` 吞掉错误，导致失败信号消失。
5. 用 `allOf` 后直接以为能自动拿到所有结果集合。
6. 只在最外层 `get(timeout)` 设超时，不在异步链里设计降级和护栏。
7. 在阻塞或重计算回调上不做执行器隔离，拖住公共线程池。

## 6. 误解清单

1. thenCompose 和 thenApply 只是返回值类型不一样。
2. thenCombine 本质上还是单链，只是参数多一个。
3. 异常在 CompletableFuture 链上会自动就近被处理掉。
4. whenComplete / handle / exceptionally 都是“异常处理 API”，差别不大。
5. allOf 返回 `Void` 说明它没什么用。
6. anyOf 只是 allOf 的更快版本。
7. 异步编排中的超时只能靠外层阻塞等待超时实现。

## 7. 证据清单

- `CompletableFuture.java:1089`：`uniComposeStage`
- `CompletableFuture.java:1404`：`BiRelay`
- `CompletableFuture.java:2239-2252`：`thenCompose`
- `CompletableFuture.java:2255-2282`：`whenComplete` / `handle`
- `CompletableFuture.java:2311-2313`：`exceptionally`
- `CompletableFuture.java:2342`：`allOf`
- `CompletableFuture.java:2361`：`anyOf`
- `CompletableFuture.java:2631`：`orTimeout`
- `CompletableFuture.java:2653`：`completeOnTimeout`
- `CompletableFuture.java:844-875`：`uniWhenComplete`
- `CompletableFuture.java:914-938`：`uniHandle`
- `CompletableFuture.java:977-996`：`uniExceptionally`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦编排语义，不展开 ForkJoinPool / commonPool 调度细节，留到下一篇。
- 不把异常包装差异（CompletionException / ExecutionException）扩展成 FutureTask 对照全文，只在需要时点到为止。
- 不把 allOf/anyOf 讲成收集框架，它们首先是完成条件组合器。
- 周期性超时与定时调度交互留在应用层，不在本文展开。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么单链不够 → thenCompose 怎样压平 future 嵌套 → thenCombine / allOf / anyOf 各自在等什么 → 异常如何沿链传播并被 exceptionally / handle / whenComplete 以不同方式处理 → 超时如何进入异步编排语义”。
- 必须把组合和异常都讲成传播模型的一部分。
- 必须讲清 thenCompose 与 thenApply 的本质差异。
- 必须讲清 allOf/anyOf 的不同语义而不是只报返回类型。
- 结尾要自然引到 `03-forkjoinpool.md`。
