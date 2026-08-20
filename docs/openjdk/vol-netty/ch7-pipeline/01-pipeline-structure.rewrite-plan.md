# Ch7-01 Pipeline 结构与传播骨架 — rewrite-plan

## 篇章定位

- 核心困惑：EventLoop 已经会把 I/O 事件驱动起来，Promise 也能把结果传回来，那数据真正流进 Channel 以后，为什么还要再套一层 Pipeline？为什么不是把 decode、业务处理、write 全写进一个大 handler 或直接写进 Channel？
- 一句话顿悟：Pipeline 把“数据怎么流过多个处理阶段”显式建模成一条带 head/tail 哨兵的双向链表；入站事件沿 inbound 掩码向前传播，出站操作沿 outbound 掩码向后传播，`ChannelHandlerContext` 既是链表节点，也是事件传播的真正控制点。
- 篇章边界：聚焦 `DefaultChannelPipeline`、`AbstractChannelHandlerContext`、head/tail、addFirst/addLast、入站/出站传播和 child executor 绑定；handler 分类与 pipeline 生命周期拆到后续篇。

## 依赖

### HARD

- Ch5 EventLoop：I/O 事件和任务在单线程上驱动，handler 默认执行线程回到 channel.eventLoop。
- Ch6 Promise：出站 write/flush 操作要携带 `ChannelPromise` 沿 pipeline 传播。
- Ch4 ByteBuf：消息对象是 pipeline 中流动的载体。

### SOFT

- Java 双向链表/责任链模式：正文会给最小解释。
- Channel inbound/outbound 基础：以 read/write 为例即可。

### NAV

- Ch7-02：Inbound/Outbound/duplex handler 类型与 mask。
- Ch7-03：Outbound buffer、write/flush 深入。
- Ch7-04：init、handlerAdded/Removed、destroy 生命周期。
- Ch10 Codec：为什么 decoder/encoder 非常适合挂在 pipeline 中。

## 素材事实卡片

### 卡片 A：Pipeline 的概念图与双向传播

- `ChannelPipeline.java:84-123`：官方文档图示，入站 bottom-up，出站 top-down，按 handler 是否实现 inbound/outbound 接口跳过无关节点。
- `ChannelPipeline.java:125-175`：事件传播通过 `ChannelHandlerContext` 的 `fire*` / `write/flush` 等方法完成。
- 这是正文最好的“总图”证据来源，要先讲再落到实现。

### 卡片 B：默认结构是带 Head/Tail 哨兵的双向链表

- `DefaultChannelPipeline.java:49-68`：`HEAD_NAME/TAIL_NAME`、`head/tail`、`channel/succeededFuture/voidPromise`。
- `DefaultChannelPipeline.java:91-101`：构造时先建 tail 再建 head，再把 `head.next = tail; tail.prev = head`。
- `DefaultChannelPipeline.java:212-235`、`:249-279`：`addFirst0/addLast0/addBefore0/addAfter0` 都是链表拼接。
- 关键叙事：Pipeline 不是数组也不是普通 list，它是需要双向传播的双向链表。

### 卡片 C：HeadContext / TailContext 的职责

- `DefaultChannelPipeline.java:1263-1322`：TailContext 作为最后的 inbound 兜底，处理未消费的 inbound 事件和异常。
- `DefaultChannelPipeline.java:1324-1437`：HeadContext 同时实现 inbound/outbound，持有 `unsafe`，把出站操作真正打到 Channel.Unsafe，并把入站事件继续 fire 下去。
- `DefaultChannelPipeline.java:987-1036`：pipeline 自身的 `write/flush/fireChannelRead` 最终分别从 tail 或 head 启动。
- 关键叙事：head 连接真正的 I/O 边界，tail 吸收没人处理的入站尾声；它们让用户 handler 不需要自己面对 channel.unsafe 或“没有下一个节点”的边界。

### 卡片 D：Context 才是传播控制点

- `AbstractChannelHandlerContext.java:62-116`：每个 context 持有 `prev/next`、pipeline、name、executionMask、childExecutor/contextExecutor、handlerState。
- `AbstractChannelHandlerContext.java:133-140`：`executor()` 缓存 `childExecutor != null ? childExecutor : channel().eventLoop()`。
- `AbstractChannelHandlerContext.java:148-175`、`:341-360` 等：`fireChannelRegistered/fireChannelRead` 通过 `findContextInbound(mask)` 找下一个 inbound 节点，并根据 executor 决定直接调用还是 `execute()` 异步切换线程。
- 关键叙事：不是 Pipeline 在一层层调用 handler，而是当前 context 在找“下一个应该处理这个事件的 context”。

### 卡片 E：childExecutor 绑定

- `DefaultChannelPipeline.java:118-143`：`newContext` 和 `childExecutor(group)`；默认同一个 `EventExecutorGroup` 对同一 channel 会 pin 同一个 child executor（除非 `SINGLE_EVENTEXECUTOR_PER_GROUP` 关闭）。
- 关键边界：pipeline 内部可以为某个 handler 配置独立 executor group，但仍尽量保持同一 channel 对该 group 的 child 线程一致，减少并发时序复杂度。

## 理解路径

1. **从“为什么不能把所有逻辑塞进一个 handler”切入**：解码、业务、编码、异常处理、写出回调是不同阶段，不该共享一个巨型状态机。
2. **先给总图**：用 `ChannelPipeline` 文档图说明 inbound/outbound 双向传播和跳过规则。
3. **再落到结构**：`DefaultChannelPipeline` 是 head/tail 哨兵包围的双向链表，而不是普通 list。
4. **讲 head/tail**：用户为什么永远看不见它们，但它们又是整个传播链必需的两个边界节点。
5. **讲 context 是真正执行点**：每个节点既持有 handler，又持有 prev/next/executor/mask，事件传播通过它完成，不是 Pipeline 主类挨个 if/else 调。
6. **讲线程切换边界**：如果 handler 绑定额外 executor，context 如何决定直接调用还是 `executor.execute(...)`。
7. **收网**：Pipeline 让 Netty 把“数据流过谁”从一个大方法拆成一条有方向、有边界、有线程语义的责任链。

## 失败方案推演

- 所有逻辑塞进一个 handler：读写、解码、业务、异常、回写纠缠在一个大状态机里，难复用也难插拔。
- 用数组/普通 list 表达 pipeline：入站和出站的双向传播、动态插入前后节点、跳过不匹配 handler 都会更别扭。
- 不设置 head/tail 哨兵：每次传播都要处理“已经没有下一个/上一个节点”的边界代码。
- 直接由 Pipeline 类统一遍历调用 handler：线程切换、mask 跳过、prev/next 局部传播会变得笨重。
- 给同一 channel 的同组 handler 每次随机选不同 executor：处理顺序和状态亲和性会变差。

## 文章结构与预算

1. 为什么需要 Pipeline 而不是大一统 handler（1000-1300 字）
2. 总图：入站/出站双向传播（1800-2300 字）
3. 默认结构：head/tail 哨兵 + 双向链表（1800-2300 字）
4. Context：真正的传播控制点（2200-2800 字）
5. childExecutor 与线程归属（1500-2000 字）
6. 误解澄清、总图与 Ch7-02 桥接（1000-1300 字）

目标：删掉代码后的叙述性正文 9500-11000 字。

## 证据清单

- `ChannelPipeline.java:84-175`
- `DefaultChannelPipeline.java:49-68`
- `DefaultChannelPipeline.java:91-101`
- `DefaultChannelPipeline.java:118-143`
- `DefaultChannelPipeline.java:161-205`
- `DefaultChannelPipeline.java:212-235`
- `DefaultChannelPipeline.java:915-1036`
- `DefaultChannelPipeline.java:1263-1437`
- `AbstractChannelHandlerContext.java:62-140`
- `AbstractChannelHandlerContext.java:148-175`
- `AbstractChannelHandlerContext.java:341-360`

## 边界清单

- 当前正文以 `DefaultChannelPipeline` 为主，不外推所有 transport/pipeline 特化实现。
- `HeadContext/TailContext` 是内部哨兵节点，不把它们写成用户可插拔 handler 的普通同类。
- child executor 绑定要以当前 `SINGLE_EVENTEXECUTOR_PER_GROUP` 默认语义为准，不写成所有 handler 永远单线程无切换。
- 本篇只建立传播骨架，不展开具体 inbound/outbound handler 分类和生命周期回调。
- 不把 `Pipeline` 写成“总是零拷贝/总是无锁”；它只是把流向和执行边界组织起来。

## 深审预警

- [ ] 不把 inbound/outbound 传播方向写反。
- [ ] 不把 pipeline 自身当作真正遍历执行者，真正执行者是各个 context。
- [ ] 明确 head 处理 outbound 打到 `unsafe`，tail 兜底 inbound。
- [ ] 明确 `addFirst/addLast` 等是链表插入，不是数组 append。
- [ ] child executor 绑定语义要按当前源码说明 pin 行为与可配置例外。
- [ ] 如果在 Head/Tail 或 context 线程切换路径中发现真实 bug 候选，按方法论记录 issue 候选。
