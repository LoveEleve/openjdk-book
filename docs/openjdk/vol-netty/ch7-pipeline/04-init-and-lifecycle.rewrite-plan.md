# Ch7-04 初始化与生命周期 — rewrite-plan

## 篇章定位

- 核心困惑：Pipeline 的链表和传播骨架已经有了，但 handler 什么时候才算“真正生效”？`ChannelInitializer` 为什么初始化完要把自己移掉？Channel 还没注册到 EventLoop 时，`handlerAdded()` 为什么不能想调就调？replace/remove/destroy 又如何在异步线程和链表结构之间保持一致？
- 一句话顿悟：Pipeline 的生命周期管理解决的是“结构已经改了，但这个 handler 现在能不能接事件”的时间差；`ChannelInitializer` 用“一次性注入后自移除”解决动态装配，pending callback 链解决“先加入、后注册”的时序断层，`replace` 和 `destroy` 则保证在事件仍可能流动时不把链条撕裂。
- 篇章边界：重点讲 `ChannelInitializer`、pending callback、`handlerState`、replace/remove/destroy；不深入 outbound buffer、handler 类型体系和 Pipeline 全部 API。

## 依赖

### HARD

- Ch7-01：Pipeline 是 head/tail 哨兵包围的双向链表，context 才是真节点。
- Ch7-02：handler 类型、`@Sharable`、`checkMultiplicity`、`invokeHandler` 和 executor 边界。
- Ch5 EventLoop：注册时机、线程亲和、异步执行器切换。
- Ch7-03：出站路径上的 `write/flush` 可能在替换/移除边界上继续流动。

### SOFT

- Ch6 Promise：remove/replace 中部分回调和执行器切换与 Promise 失败传播有关，但本篇只用最小语义。

### NAV

- Ch8 内存池：handler 生命周期完成后，消息/缓冲区生命周期如何继续归还内存池。
- Bootstrap / Pipeline 后续专题：初始化阶段为什么会批量 add handler。

## 素材事实卡片

### 卡片 A：ChannelInitializer 自移除

- `ChannelInitializer.java:53-59`：`@Sharable` + `ConcurrentHashMap.newKeySet()` 的 `initMap`。
- `ChannelInitializer.java:72-88`：`channelRegistered` 中若本次触发了 init，则补一次 `pipeline.fireChannelRegistered()`，并 `removeState(ctx)`；否则正常 forward。
- `ChannelInitializer.java:105-117`：`handlerAdded` 时如果 channel 已注册，直接尝试 init。
- `ChannelInitializer.java:124-141`：`initChannel(ctx)` 防重入，调用用户的 `initChannel(C)`，finally 中若还未 remove 就 `pipeline.remove(this)`。
- `ChannelInitializer.java:143-157`：`removeState` 对“ctx 已移除 / 未移除”做同步或异步清理。
- 关键叙事：它不是长期 handler，而是一次性 pipeline 组装器。

### 卡片 B：pending callback 与首次注册

- `DefaultChannelPipeline.java:73-83`：`pendingHandlerCallbackHead` 作为待回调单链表头。
- `DefaultChannelPipeline.java:188-205`：未注册时，新增 context 只 `setAddPending()` 并 `callHandlerCallbackLater(newCtx, true)`，不立即 `callHandlerAdded0`。
- `DefaultChannelPipeline.java:593-601`：首次 `channelRegistered` 时 `invokeHandlerAddedIfNeeded()` -> `callHandlerAddedForAllHandlers()`。
- 需要补读 `callHandlerCallbackLater` / `callHandlerAddedForAllHandlers()` 精确实现位置（正文写作前再补）以解释为何在 synchronized 外执行。
- `AbstractChannelHandlerContext.java:980-1017`：`setAddPending/callHandlerAdded/callHandlerRemoved/invokeHandler` 与 `handlerState` 四态。
- 关键叙事：结构加入和 handler 可接事件不是同一时刻。

### 卡片 C：remove 与 replace

- `DefaultChannelPipeline.java:401-427`：remove 先原子摘链，再根据是否已注册决定延后 `handlerRemoved` 还是立刻/异步调用。
- `DefaultChannelPipeline.java:433-438`：`atomicRemoveFromHandlerList` 只改 prev/next。
- `DefaultChannelPipeline.java:474-524`：replace 流程，若已注册则先 `callHandlerAdded0(newCtx)` 再 `callHandlerRemoved0(oldCtx)`；未注册则挂入 pending callback。
- `DefaultChannelPipeline.java:526-542`：`replace0` 链接新 ctx，并把 `oldCtx.prev=oldCtx.next=newCtx`，让旧 ctx 上可能残留的 forward 流量正确落到新 ctx。
- `DefaultChannelPipeline.java:556-590`：`callHandlerAdded0/callHandlerRemoved0` 的异常处理。
- 关键叙事：replace 不只是链表指针替换，还要考虑“旧 handler 还可能正在传播事件”的时间窗口。

### 卡片 D：destroy 两阶段

- `DefaultChannelPipeline.java:790-856`：`destroy()` -> `destroyUp()` -> `destroyDown()`。
- `destroyUp`：沿 next 方向走，遇到不同 executor 时把后续销毁提交到对应 executor。
- `destroyDown`：沿 prev 方向回收，`atomicRemoveFromHandlerList` + `callHandlerRemoved0`。
- `DefaultChannelPipeline.java:1406-1413`：`channelUnregistered` 时若 channel 已关闭，则触发 `destroy()`。
- 关键叙事：不是为了“好看地拆成两步”，而是为了保证 handlerRemoved 在正确线程上、且发生在事件处理收尾之后。

## 理解路径

1. **从“结构已经加进链上，为什么还不能立刻工作”切入**：把“链表修改完成”和“handler 可以安全接事件”区分开。
2. **先讲 ChannelInitializer**：一次性装配器，`@Sharable` 服务多个 Channel，但每个 ctx 只初始化一次，完成后自移除。
3. **再讲 pending callback**：未注册 Channel 上 add/remove handler 时，为什么不立刻回调 `handlerAdded/Removed`，以及首次注册时如何批量补发。
4. **把 `handlerState` 引进来**：`INIT -> ADD_PENDING -> ADD_COMPLETE -> REMOVE_COMPLETE`，解释 `invokeHandler()` 为什么有时要 forward 而不是调用 handler。
5. **讲 replace/remove**：指针先改还是回调先调，为什么 new handler 必须先 added，旧 ctx 的 prev/next 为什么要都指向 newCtx。
6. **讲 destroy 两阶段**：不同 executor 上的 handlerRemoved 不能简单单线程一路拆到底。
7. **收网**：Pipeline 生命周期的关键不是“什么时候插链”，而是“什么时候这个节点真正对事件可见、又在什么时候安全离场”。

## 失败方案推演

- `pipeline.addLast(handler)` 后立即同步 `handlerAdded()`：Channel 未注册时，handler 可能在错误线程/错误时机发起 write/read。
- `ChannelInitializer` 初始化完不移除自己：它会继续常驻链上，之后还要承担多余的匹配和生命周期成本，甚至可能重复初始化。
- replace 时先 remove old 再 add new：如果 old 的 remove 过程中触发读写事件，新 handler 还没 ready，会错过本该接住的事件。
- remove 只改链表不调 `handlerRemoved()`：资源释放、状态清理、外部引用解绑会被跳过。
- destroy 单向同步拆链：跨 executor 的 handlerRemoved 顺序和线程归属会乱，甚至可能在事件仍在传播时拆掉链。

## 文章结构与预算

1. “加进链表了”不等于“已经生效”（1000-1300 字）
2. ChannelInitializer：一次性装配后自移除（1800-2300 字）
3. PendingHandlerCallback 与 `handlerState`（2200-2800 字）
4. remove/replace 的时序保护（1900-2400 字）
5. destroyUp/destroyDown 两阶段清理（1700-2200 字）
6. 误解澄清与 Ch8/后续桥接（1000-1300 字）

目标：删掉代码后的叙述性正文 9500-11000 字。

## 证据清单

- `ChannelInitializer.java:53-157`
- `DefaultChannelPipeline.java:73-83`
- `DefaultChannelPipeline.java:188-205`
- `DefaultChannelPipeline.java:401-427`
- `DefaultChannelPipeline.java:433-438`
- `DefaultChannelPipeline.java:474-590`
- `DefaultChannelPipeline.java:593-601`
- `DefaultChannelPipeline.java:790-856`
- `DefaultChannelPipeline.java:1406-1413`
- `AbstractChannelHandlerContext.java:980-1017`

## 边界清单

- `ChannelInitializer` 是一次性装配器，不是长期数据处理 handler。
- pending callback 解决的是“注册时机未到”而不是“handler 逻辑异步化”本身。
- `handlerState` 是当前实现的 FSM 细节，正文用来解释时序，不外推为用户 API 合同。
- replace 的 forward 保护（`oldCtx.prev=oldCtx.next=newCtx`）是当前实现细节，但它解释了为何事件不会因为旧 ctx 暂留而失联。
- destroy 两阶段主要是线程归属与顺序保证，不是简单的代码分层美观。

## 深审预警

- [ ] 补齐 `callHandlerCallbackLater/callHandlerAddedForAllHandlers` 的精确源码位置与行为，确保未沿用旧认知。
- [ ] 不把 `ChannelInitializer` 的 `@Sharable` 写成线程安全证明，仍要强调 `initMap` 只是按 ctx 防重入。
- [ ] 明确 `handlerAdded` 何时直接触发、何时延迟到 registered 后批量触发。
- [ ] replace 流程要把“先 added 新的，再 removed 旧的”的因果讲透。
- [ ] destroy 两阶段若发现当前实现存在潜在边界缺陷，按方法论记录 issue 候选。
