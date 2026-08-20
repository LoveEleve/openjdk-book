# 15-async/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `CompletableFuture`。本文聚焦 `result` / `AltResult`、`stack` / `Completion`、`completeValue` / `completeThrowable` / `postComplete`、`thenApply` / `uniApplyStage` 以及同步/异步执行差异；多源组合与异常编排放到下一篇。
> 目标：把“CompletableFuture 基础”改写成一篇围绕“它为什么不只是一个能拿结果的 Future，而是把结果状态、依赖节点和回调执行模型塞进同一个对象里”的机制文章。

## 1. 读者困惑

- `CompletableFuture` 和普通 `Future` 真正差在哪，为什么它不只是多了几个 thenXxx 方法？
- 一个异步结果为什么要同时维护 `result` 和 `Completion stack` 两块状态？
- 结果是 `null` 或异常时，为什么还要用 `AltResult` 这种装箱对象？
- `thenApply` 注册的回调到底存在哪，什么时候才会真的执行？
- 同步链和 `thenApplyAsync` 的线程执行差异，到底是语法差别还是执行模型差别？

## 2. 一句话顿悟

**CompletableFuture 的本体不是“一个将来会有值的盒子”，而是：一个 result 字段负责表示是否完成及结果形态，一条 Completion 栈负责挂住所有依赖回调，完成时再由 `postComplete` 把这些依赖一层层推进。因此它既是结果容器，也是依赖图节点，还是回调调度入口。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `result` / `AltResult`、`Completion` 栈、`postComplete`、`thenApply` 的 `UniApply` 节点，以及同步/异步执行器差异。
- 已指出 `thenApply` 不是立即执行，而是先注册依赖，这是关键抓手。
- 已把多源组合与异常编排留到下一篇，边界划分合理。

### 必须重写

- 旧稿偏“结构分段介绍”，需要先建立总问题：为什么 CF 必须把结果、依赖和执行模型都压进同一个对象。
- `result` 字段要讲成“结果状态机”，而不是只列三种取值含义。
- `Completion` 栈需要突出“回调先注册、结果完成后才被推进”的事件模型，而不只是数据结构说明。
- 同步/异步差异应回到“由谁执行回调、是否把完成线程拖住”的真实工程问题上。
- 收网段要更明确把 CompletableFuture 定位成异步编排地基，顺到下一篇组合与异常。

## 4. 理解路径

### 第一节：从“为什么 Future 不够串异步链”开场

对照上一域 FutureTask：Future 只解决结果、异常、取消与等待，但无法自然挂下一步处理逻辑。引出总问题：异步编排需要的不只是“等结果”，还要“结果到了以后谁来推进下游步骤”。

### 第二节：`result` 为什么不是普通字段，而是整个完成状态机入口

证据：
- `CompletableFuture.java:264-265`：`result` / `stack`
- `CompletableFuture.java:285-291`：`AltResult` / `NIL`
- `CompletableFuture.java:304-319`：`completeValue` / `completeThrowable`
- `CompletableFuture.java:299` / `312`：`encodeValue` / `encodeThrowable`

主线：
- `result == null` 表示未完成；非 null 表示完成，但完成又细分为正常值、null 值、异常结果。
- `AltResult` 不是技巧，而是为了把“正常 null”和“异常结果”与普通值区分开。
- `completeValue/completeThrowable` 用 CAS 做一次性发布，说明完成是抢占式、只能赢一次。

### 第三节：为什么回调不是立刻执行，而是先挂到 `Completion` 栈

证据：
- `CompletableFuture.java:463`：`Completion`
- `CompletableFuture.java:268` / `275`：`RESULT` / `STACK` CAS
- `CompletableFuture.java:279`：`pushStack`
- `CompletableFuture.java:488-498`：`postComplete`
- `CompletableFuture.java:512+`：`cleanStack`

主线：
- 调用 `thenApply` 时，如果源还没完成，不可能立刻跑回调；它必须先把依赖节点挂起来。
- Completion 栈就是这些“等源完成后再推进”的待办链。
- 源完成时 `postComplete` 逐个弹出并触发依赖推进，说明 CF 是事件驱动依赖传播，而不是轮询结果。

### 第四节：`thenApply` 为什么等于“注册一个 UniApply 节点”

证据：
- `CompletableFuture.java:653`：`uniApplyStage`
- `CompletableFuture.java:2098-2108`：`thenApply` / `thenApplyAsync`
- `CompletableFuture.java:630-645`：`UniApply` 成功路径（按需在正文中精确解释）

主线：
- `thenApply` 不是“现在执行函数”，而是创建目标 future + 注册一个依赖节点。
- 等源完成后，UniApply 读取源结果，执行 `fn.apply`，把值写入目标 future，再继续触发目标的下游依赖。
- 这就是为什么 CF 看起来像链式 API，内部其实是一个个 Completion 节点串起来的依赖传播网络。

### 第五节：同步链和 Async 版本为什么是执行模型差异，不是命名差异

证据：
- `CompletableFuture.java:2098`：`thenApply`
- `CompletableFuture.java:2103`：`thenApplyAsync`
- `CompletableFuture.java:2108`：带 executor 的 Async 版本
- `CompletableFuture.java` 中 defaultExecutor / commonPool 相关实现（正文按需点到）

主线：
- 同步版本通常由让源完成的那个线程顺手推进下游逻辑，省调度但可能拖慢完成线程。
- Async 版本把回调包装成任务交给默认或指定执行器，隔离线程但增加调度开销。
- 这解释了为什么 thenApply / thenApplyAsync 不是“一个同步一个异步”这么抽象，而是在回答“谁来跑你的回调”。

## 5. 失败方案清单

1. 把 CompletableFuture 只当成“可手动完成的 Future”，忽略依赖节点传播能力。
2. 以为 `thenApply` 会在调用处立刻执行函数。
3. 结果可能为 null 或异常时仍然试图用一个普通字段直接区分所有完成形态。
4. 在重回调/阻塞回调场景里无脑使用同步链，结果把完成线程拖住。
5. 在所有小回调场景都无脑用 Async，忽略额外调度成本。
6. 把下一篇的多源组合、异常恢复问题提前混进本文，打断基础心智。

## 6. 误解清单

1. CompletableFuture 只是 Future 多了几个链式语法糖。
2. `result` 存了值就说明回调已经全部跑完。
3. `AltResult` 只是为了包异常，和 null 值无关。
4. Completion 栈只是内部缓存，不影响执行顺序和传播模型。
5. thenApplyAsync 一定比 thenApply 更“高级”。
6. CompletableFuture 的回调总是在 commonPool 跑。

## 7. 证据清单

- `CompletableFuture.java:264-265`：`result` / `stack`
- `CompletableFuture.java:268` / `275`：RESULT / STACK CAS
- `CompletableFuture.java:285-291`：`AltResult` / `NIL`
- `CompletableFuture.java:299` / `304`：`encodeValue` / `completeValue`
- `CompletableFuture.java:312` / `318`：`encodeThrowable` / `completeThrowable`
- `CompletableFuture.java:463`：`Completion`
- `CompletableFuture.java:279`：`pushStack`
- `CompletableFuture.java:488-498`：`postComplete`
- `CompletableFuture.java:512+`：`cleanStack`
- `CompletableFuture.java:630-645`：UniApply 成功推进
- `CompletableFuture.java:653`：`uniApplyStage`
- `CompletableFuture.java:2098-2108`：`thenApply` / `thenApplyAsync`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇只讲单源依赖链基础，不展开 `thenCombine`、`allOf/anyOf`、异常恢复与扁平化链，那些放在下一篇。
- 不把 commonPool 扩展成完整 ForkJoinPool 教程，只解释回调执行线程差异到够用为止。
- 不把 Completion 栈说成业务可见顺序承诺，它是内部传播结构。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么异步编排需要把结果和依赖绑在同一对象里 → result 如何表示完成形态 → Completion 栈如何挂回调 → postComplete 如何推进下游 → thenApply 等于注册 UniApply 节点 → 同步链与 Async 版本怎样选择执行线程”。
- 必须把 CF 定位成结果状态机 + 依赖传播器。
- 必须把 thenApply / thenApplyAsync 讲成执行模型差异。
- 必须自然引到下一篇组合与异常编排。
