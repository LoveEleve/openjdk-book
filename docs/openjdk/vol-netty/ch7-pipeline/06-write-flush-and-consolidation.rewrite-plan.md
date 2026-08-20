# Ch7-06 write、flush 与 FlushConsolidation — rewrite-plan

## 篇章定位

- 核心困惑：既然 `ctx.writeAndFlush()` 这么常用，为什么 Netty 还要把 `write()` 和 `flush()` 拆成两个动作？`flush()` 到底昂贵在哪里？`FlushConsolidationHandler` 为什么能在不改业务语义的前提下减少 flush 次数？
- 一句话顿悟：`write()` 负责把对象送进出站托管区，`flush()` 负责给托管区发出“现在可以真正下沉到传输层”的推进信号；两者拆开以后，Netty 才能在 read loop、事件循环调度和不可写边界上有选择地合并多次 flush，把多个小写批量沉底成更少的实际传输推进。
- 文章边界：本篇主讲 `ChannelOutboundInvoker.write/writeAndFlush/flush` 的语义边界、`FlushConsolidationHandler` 如何在 read loop 内外合并 flush、为什么 channel 不可写时要立刻 flush、为什么 close/disconnect/exception/handlerRemoved 都要做一次兜底 flush；不展开 syscall/内核网络栈细节，不展开 `PendingWriteQueue` 主题。

## 依赖

### HARD

- Ch7-05 `ch7-pipeline/05-outbound-buffer-and-writability.md`：理解 `write` 先进入 `ChannelOutboundBuffer`，以及 `write != flush != remove`。
- Ch7-01 `ch7-pipeline/01-pipeline-structure.md`：理解 outbound 事件沿 pipeline 传播。
- Ch6-01 `ch6-promise/01-state-model-and-listeners.md`：理解 write future 的异步完成，不把 `writeAndFlush` 看成同步发送完成。

### SOFT

- Ch4-06 / Ch4-07：这里只借用“对象已经进入托管区”和 `touch()` / leak 定位的背景，不再重讲。
- Ch2 Channel：只借“真正网络发送不等于业务调用返回”的背景。

### NAV

- 后续篇（待写）：`PendingWriteQueue` 如何把更早阶段的待写对象继续挂进托管区。
- HTTP/2 API 层后续篇：child stream channel 的 flush 与连接级写出如何叠加。

## 素材事实卡片

### 卡片 A：`write()` 和 `flush()` 的接口合同是分开的

- `ChannelOutboundInvoker.write(...)` 文档明确说：write 不会请求实际 flush，想把 pending data 下沉到 transport，必须显式再调 `flush()`。
- `writeAndFlush(...)` 只是语法糖，不改变两步语义本质。
- 结论：拆开不是 API 风格问题，而是运行时调度策略前提。

### 卡片 B：`FlushConsolidationHandler` 的目标不是改写语义，而是减少 flush 次数

- 类注释明确：flush 往往昂贵，因为可能触发 transport 层 syscall。
- 读循环进行中时，flush 不立即向后传播，而是在 `channelReadComplete()` 统一推进。
- 非读循环时，若 `consolidateWhenNoReadInProgress=true`，则调度一个 event loop 任务，给更多 flush 合并进来的机会。
- 达到阈值 `explicitFlushAfterFlushes` 时直接刷出，避免无限拖延。

### 卡片 C：为什么不可写、异常、close、disconnect、handlerRemoved 都要兜底 flush

- `channelWritabilityChanged()`：channel 变成不可写时立刻 flush，释放内存压力。
- `exceptionCaught()` / `close()` / `disconnect()` / `handlerRemoved()`：都先 `resetReadAndFlushIfNeeded` 或 `flushIfNeeded`，确保 pending flush 不被吞掉。
- 结论：flush 合并不是“能拖多久拖多久”，而是“在不破坏边界语义时尽量拖”。

### 卡片 D：测试暴露了 read loop 内外的不同行为

- `testFlushViaScheduledTask`：非读循环且允许合并时，flush 先排任务，不立刻透传。
- `testFlushViaThresholdOutsideOfReadLoop`：阈值达到后即使在非读循环也立即 flush。
- `testFlushViaReadComplete`：读循环中多次读，统一在 `channelReadComplete` 刷出。
- `testFlushViaClose/Disconnect/Exception/Removal`：边界事件都会触发兜底 flush。
- `testResend`：listener 里再次 `writeAndFlush` 也不能把消息吞掉。

### 卡片 E：任务提交失败也会影响 write/flush 语义边界

- `AbstractChannelHandlerContext.safeExecute(...)`：任务提交失败时要 release msg 并 fail promise。
- 说明 write/flush 拆开的另一个前提是：有些传播要跨 executor，不能假设调用点和真正执行点重合。

## 理解路径

1. **从最常见误会开场**：`writeAndFlush` 看起来像一步，其实只是“先入托管区，再发推进信号”。
2. **先解释为什么要拆开**：如果 `write()` 自动 flush，就无法在托管区里形成批量。
3. **推演失败方案**：每次 write 都立刻 flush，会怎样放大 flush 次数和边界噪声。
4. **再讲 `FlushConsolidationHandler` 的三个场景**：读循环内、非读循环、不可写/边界事件。
5. **最后回到时序与语义保证**：为什么它不是偷偷改语义，而是在显式边界上合并推进。

## 失败方案推演

- 每次 write 自动 flush：无法批量，flush 次数和传输推进次数高度耦合。
- 所有 flush 都一律延迟：close/exception/不可写等边界会把 pending 数据卡死在托管区。
- 只在读循环结束时 flush：非读循环场景无法得到推进，轻负载下反而延迟过高。
- 非读循环无限等待更多 flush：吞吐也许变好，但延迟与边界语义不可控。

## 文章结构与预算

1. 开场：为什么 `writeAndFlush` 最容易让人误解（1000-1400 字）
2. 先拆语义：`write` 入托管区，`flush` 发推进信号（1600-2200 字）
3. 失败方案：如果每次 write 都自动 flush，会发生什么（1400-1900 字）
4. `FlushConsolidationHandler` 总图：读循环内、非读循环、阈值、调度任务（1800-2400 字）
5. 边界兜底：不可写、exception、close、disconnect、removal 为什么都要立刻 flush（1600-2200 字）
6. 测试与时序：scheduled task、threshold、readComplete、resend（1600-2200 字）
7. 收网：桥回托管区、背压与后续协议层（600-900 字）

目标：去掉代码块后的叙述性正文 8500-11000 字，最低不低于 8000 字。

## 证据清单

- `transport/src/main/java/io/netty/channel/ChannelOutboundInvoker.java:216-219`
- `handler/src/main/java/io/netty/handler/flush/FlushConsolidationHandler.java:30-58`
- `handler/src/main/java/io/netty/handler/flush/FlushConsolidationHandler.java:98-139`
- `handler/src/main/java/io/netty/handler/flush/FlushConsolidationHandler.java:142-219`
- `transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1034-1052`
- `handler/src/test/java/io/netty/handler/flush/FlushConsolidationHandlerTest.java:36-178`
- `transport/src/test/java/io/netty/channel/embedded/EmbeddedChannelTest.java:564-582`

## 边界清单

- 本篇不把 flush 昂贵简单写成“就是 syscall”，只保留 transport 推进成本这层抽象，不展开内核细节。
- 本篇不把 `writeAndFlush` 写成独立第三种机制；它只是组合调用。
- 本篇不把 `FlushConsolidationHandler` 的测试顺序外推成所有运行时唯一顺序，只当作行为证据。
- 本篇不展开 `PendingWriteQueue`，避免和前后篇交叉过深。

## 深审预警

- [ ] 不把 `write()` 写成自动 flush。
- [ ] 不把 flush 合并写成“永远更优”，必须写出边界兜底和延迟代价。
- [ ] 不把读循环内和非读循环外的合并策略混成一个逻辑。
- [ ] 不把 `channel` 不可写时立刻 flush 说成吞吐优化；它首先是释放内存压力的兜底动作。