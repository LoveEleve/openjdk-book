# Ch13-02 流量整形、流控辅助与日志：AbstractTrafficShapingHandler、FlowControlHandler、LoggingHandler — rewrite-plan

## 篇章定位

- 核心困惑：前面已经讲了 writability、PendingWriteQueue、HTTP/2 flow control、timeout/heartbeat，但在真实连接治理里，Netty 还提供了另一组运行时 handler：`AbstractTrafficShapingHandler` / `ChannelTrafficShapingHandler` 负责带宽整形，`FlowControlHandler` 负责把上游一次喷出的多条消息压回到“每次 read 一条”的节奏，`LoggingHandler` 负责把连接事件和 ByteBuf 内容可视化。它们到底分别在补哪一层空白？为什么都不属于“协议编解码”，却又直接影响连接稳定性和排障效率？
- 一句话顿悟：这些 handler 处理的不是“业务协议是什么”，而是“连接在运行时该怎么被节流、怎么避免下游被事件洪水淹没、怎么把关键状态打印出来”。`TrafficShapingHandler` 把带宽限制和延迟写队列叠到 writability 主线上，`FlowControlHandler` 把上游 decoder/encoder 可能一次吐出的多条消息重新收束成按 `read()` 驱动的下游节奏，`LoggingHandler` 则把 Channel 生命周期、I/O 事件和 ByteBuf 内容变成统一日志视图。
- 文章边界：本篇主讲 `AbstractTrafficShapingHandler` / `ChannelTrafficShapingHandler`、`FlowControlHandler`、`LoggingHandler` 的职责边界、与 writability / PendingBytes / read loop / flush / diagnostics 的关系；不展开全局 traffic shaping 的所有变体细节，不把应用层协议日志格式作为重点。

## 依赖

### HARD

- Ch7-05 `ch7-pipeline/05-outbound-buffer-and-writability.md`：理解 pending bytes、writability 与 userDefinedWritability。
- Ch7-08 `ch7-pipeline/08-pendingwrite-and-coalescing-queues.md`：理解挂起写与辅助托管层。
- Ch12-01 / Ch12-05：理解 HTTP/2 flow control 与额度分配主线，便于区分它和 `FlowControlHandler` 的边界。
- Ch13-01 `ch13-timeout/01-idle-and-write-timeout.md`：理解 transport 边界 handler 的组织方式。

### SOFT

- Ch4-06 ownership：只复用“handler 缓存消息就必须承担释放边界”。
- Ch8-07 diagnostics：只复用“日志/指标不是唯一真相”的诊断思路。

### NAV

- 后续：大对象分块写出 `ChunkedInput / ChunkedFile / HttpChunkedInput`。
- 后续：更具体的带宽调优和生产诊断案例。

## 结构设计

### 1. 开场：连接治理不是只有 timeout 和 watermarks
- 回收前文：writability、PendingWriteQueue、timeout 已经说明了“什么时候该停”和“什么时候算超时”。
- 引出本篇：现在要解决“怎么主动限速”“怎么避免事件洪水”“怎么把这些状态看见”。
- 预计 900-1200 字。

### 2. `AbstractTrafficShapingHandler`：限速不是直接拒写，而是延迟、挂队列和用户位
- read/write limit、checkInterval、maxTime、maxWriteDelay、maxWriteSize、userDefinedWritabilityIndex。
- `TrafficCounter` 的角色：统计而不是直接传输。
- `ChannelTrafficShapingHandler` 如何把待写对象挂进 `messagesQueue` 并在到点时再发。
- handlerRemoved 时为什么要么补写队列，要么 release 留存 ByteBuf。
- 预计 2200-2800 字。

### 3. `FlowControlHandler`：为什么它不是 HTTP/2 flow control
- 它解决的是“上游一次吐很多消息、下游却想按 read() 节奏慢慢吃”的 pipeline 节奏问题。
- `unsatisfiedReads`、queue、autoRead on/off、`dequeueOne/dequeueAll`。
- handlerRemoved/channelInactive 时为何要 drain 或 release。
- 预计 2200-2800 字。

### 4. `LoggingHandler`：为什么日志 handler 也是运行时治理的一部分
- 日志事件覆盖 Channel 生命周期、异常、用户事件、bind/connect/read/write/flush。
- `ByteBufFormat` 和 ByteBuf / ByteBufHolder 日志内容。
- 它不是调优器，但它让连接治理行为可观测。
- 预计 1400-1800 字。

### 5. 边界对照：三类 handler 分别补哪层空白
- TrafficShaping：带宽/延迟整形，直接影响 userDefinedWritability 与挂起写队列。
- FlowControlHandler：下游消费节奏收束，不是协议窗口流控。
- LoggingHandler：可观测性，不改写传输语义。
- 预计 1200-1600 字。

### 6. 测试回读：handler 移除、queue drain、writabilityChanged、客户端断开
- `TrafficShapingHandlerTest.testHandlerRemove`
- `FlowControlHandlerTest` 中 autoRead on/off 与 queue empty 行为
- 用测试说明这些 handler 都必须对齐生命周期和 release 边界。
- 预计 1600-2200 字。

### 7. 收网
- 连接治理三件事：限速、节奏、可观测。
- 桥接到下一篇大对象分块写出与更具体调优案例。
- 预计 600-800 字。

## 证据清单

- `handler/src/main/java/io/netty/handler/traffic/AbstractTrafficShapingHandler.java:36-175`
- `handler/src/main/java/io/netty/handler/traffic/AbstractTrafficShapingHandler.java:224-320`
- `handler/src/main/java/io/netty/handler/traffic/ChannelTrafficShapingHandler.java:25-220`
- `handler/src/main/java/io/netty/handler/flow/FlowControlHandler.java:33-245`
- `handler/src/main/java/io/netty/handler/logging/LoggingHandler.java:36-240`
- `handler/src/test/java/io/netty/handler/flow/FlowControlHandlerTest.java:121-260`
- `handler/src/test/java/io/netty/handler/traffic/TrafficShapingHandlerTest.java:55-116`

## 误解清单

1. `TrafficShapingHandler` 只是日志统计器，不会真实影响写路径。
2. `FlowControlHandler` 和 HTTP/2 flow control 是一回事。
3. `LoggingHandler` 只是调试便利工具，对运行时治理没有帮助。
4. 带宽整形只影响 write，不会和 writability、挂队列、release 边界产生关系。
5. 上游一次吐多条消息时，关闭 autoRead 就天然能保证下游一次只看一条。

## 边界清单

- 本篇不把 `FlowControlHandler` 写成协议窗口控制器，它只处理 pipeline 下游节奏。
- 本篇不把 `TrafficCounter` 写成 transport 本身，它是统计/调度辅助器。
- 本篇不把 `LoggingHandler` 写成性能优化器，它负责可观测性。
- 本篇不展开 `GlobalTrafficShapingHandler` / `GlobalChannelTrafficShapingHandler` 的所有变体细节，只用来辅助说明设计方向。

## 深审预警

- [ ] 不把带宽整形写成“直接 drop 多余流量”。
- [ ] 不把 `FlowControlHandler` 和 HTTP/2 flow control 混写。
- [ ] 不把 handlerRemoved / channelInactive 时的 drain/release 边界写漏。
- [ ] 不把 LoggingHandler 的日志视图写成 transport 真相本身。