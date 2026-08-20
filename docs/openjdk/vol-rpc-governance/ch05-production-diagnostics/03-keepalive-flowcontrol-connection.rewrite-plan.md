# grpc-java：Keepalive、流控与连接问题分析 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch05-production-diagnostics`
- 篇：`03 Keepalive、流控与连接问题分析`
- 对应主题：`G-PROD-3 keepalive / 流控 / 连接问题`
- 文章类型：生产诊断专题篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：线上最难解释的一类连接问题不是“直接断开”，而是“看起来还活着，但请求就是慢、抖、卡”。有时连接明明还在收发 ping，却没有业务进展；有时服务端发了 `GOAWAY ENHANCE_YOUR_CALM`，客户端开始报 `UNAVAILABLE`，大家都以为网络炸了；有时大量连接 churn，其实并不是链路不稳，而是 idle / max age / stream id exhaustion 在起作用。读者最大的困惑是：keepalive、flow control 和连接生命周期这些机制看起来都在 Netty/HTTP2 层，怎么把线上症状和源码中的具体判断点对上？
- 一句话顿悟：grpc-java 里“连接还活着”至少有三种含义：TCP/HTTP2 还没断、keepalive 还在收到回包或任意入站帧、flow-control 还有发送/接收信用；这三者并不等价。生产排障时要先区分 keepalive ping、BDP/flow-control ping、connection/stream window、GOAWAY 两阶段关闭、channel idle 与 transport idle 这些完全不同的机制，否则就会把“活着但卡住”“优雅 drain”“ping 过多被赶走”都误诊成网络故障。
- 文章边界：本篇重点讲 keepalive 机制（`KeepAliveManager`、`KeepAliveEnforcer`、客户端/服务端参数）、flow-control 窗口与 stalled 读写、GOAWAY / shutdown / maxConnectionIdle / stream-id exhaustion 的连接生命周期问题；不展开 Netty ByteBuf 细节，不重讲 channel/subchannel/picker 选路，不深入 xDS/LB 策略。

## 前置依赖

### HARD

- `ch05/01-deadline-cancel-retry-troubleshooting.md`：已经知道 deadline/cancel/retry 的生产判因框架。
- `ch05/02-channel-subchannel-picker-diagnosis.md`：已经知道 channel/subchannel/picker/transport 四层状态和本地缓冲队列。
- `ch03/04-compression-codec-message-framing.md`：已经知道消息在 stream/deframer 层如何推进，便于理解 flow-control 与 deframer 消费的关系。

### SOFT

- 不要求先懂 Netty 全量实现。
- 不要求先懂 BDP auto-tuning 细节。

### NAV

- 后续可接：xDS / 负载均衡进阶篇
- 后续可接：Netty HTTP/2 细节专题

## 一句话困惑

为什么连接明明还活着，RPC 却还是卡住？为什么有时服务端会因为“too many pings”把客户端赶走？为什么 `GOAWAY NO_ERROR` 最后却表现成客户端的 `UNAVAILABLE`？

## 一句话顿悟

生产上看到的“慢、抖、断”不能一股脑归因于网络。grpc-java 至少有三套容易混淆的机制：一套是 keepalive（连通性探活），一套是 flow control（发送/接收信用），一套是连接生命周期（idle、max age、GOAWAY、stream id exhaustion）。连接可以 keepalive 正常但 flow-control 卡死，也可以优雅 GOAWAY 却在客户端表现成可重试的 `UNAVAILABLE`。诊断时必须先分清“谁在发 ping”“窗口还有没有信用”“连接是在 drain 还是在真故障”。

## 读者理解路径

1. 先否定“只要 ping 通，连接就没问题”的直觉。
2. 建立最小总图：keepalive、BDP ping、flow-control、GOAWAY/idle/termination 三条并行机制。
3. 解释 keepalive 模型：`KeepAliveManager` 与 `KeepAliveEnforcer` 的分工，客户端/服务端参数如何互动。
4. 解释 flow-control 模型：连接窗口、流窗口、`consumeBytes()` 返回信用，为什么连接能活着但业务停住。
5. 解释 BDP ping 和 keepalive ping 完全不是一回事。
6. 解释 GOAWAY、graceful shutdown、maxConnectionIdle、maxConnectionAge、stream-id exhaustion 这些连接生命周期事件如何在客户端表现为 `UNAVAILABLE` 或 churn。
7. 收束到生产排障四问法：谁在发 ping？窗口还有没有信用？GOAWAY 是什么 error/debug 数据？当前是 channel idle 还是 transport idle？

## 失败方案推演

### 失败方案一：只要 keepalive ping 正常，连接就一定健康

- 这会把“TCP/HTTP2 还活着”和“业务请求能前进”混为一谈。
- grpc-java 的 keepalive 只证明 transport 最近还有入站活动，不证明 flow-control 还有信用。
- 所以连接可以 ping 正常，但因为窗口没被及时归还，业务流量依然卡死。

### 失败方案二：所有 PING 都是 keepalive ping

- 这会把 BDP auto-tuning 和 keepalive 混为一谈。
- grpc-java 里至少有两套 ping：keepalive 用于探活，BDP ping 用于估算带宽-时延积、调整窗口。
- 线上抓包看到 PING，不能直接得出“keepalive 太激进”的结论。

### 失败方案三：`GOAWAY NO_ERROR` 说明没问题，可以忽略

- 这会误判 graceful drain 对调用的真实影响。
- grpc-java 把某些 GOAWAY 处理成可重试的 `UNAVAILABLE`，这不是网络炸了，但对新 stream 来说仍然是一次真实的中断/重建事件。
- 所以 `NO_ERROR` 不是“没事”，而是“这是优雅关闭，不是崩溃关闭”。

## 必须澄清的误解

1. keepalive ping 和 BDP ping 不是同一个东西。
2. “连接活着”不等于“请求能继续前进”，flow-control 耗尽时前者成立而后者不成立。
3. `keepAliveWithoutCalls(true)` 不等于服务端会允许无业务流量时持续 ping；服务端 `permitKeepAliveWithoutCalls` 仍可拒绝。
4. `GOAWAY NO_ERROR` 对连接生命周期是正常事件，但对具体 stream 仍然可能表现成 `UNAVAILABLE` 和重连。
5. channel idle 与 transport/socket idle 不是同一回事。

## 文章结构与字数预算

1. 困惑开场：为什么“活着但卡住”比直接断开更难排障（800-1000 字）
2. 最小总图：keepalive / flow-control / connection lifecycle 三条并行机制（1000-1400 字）
3. keepalive 模型与参数互动（1600-2200 字）
4. flow-control 模型：窗口、consumeBytes、stalled read/write（1600-2200 字）
5. BDP ping vs keepalive ping（1000-1400 字）
6. GOAWAY / idle / max age / termination / stream-id exhaustion（1800-2400 字）
7. 常见线上症状：too_many_pings、连接 churn、活着但卡住（1600-2200 字）
8. 收网总结：连接问题排障四问法（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### keepalive
- `core/src/main/java/io/grpc/internal/KeepAliveManager.java:44` — keepalive 状态机枚举
- `core/src/main/java/io/grpc/internal/KeepAliveManager.java:160` — `onTransportStarted()`
- `core/src/main/java/io/grpc/internal/KeepAliveManager.java:188` — `onDataReceived()`
- `core/src/main/java/io/grpc/internal/KeepAliveManager.java:222` — `sendPing` / timeout 路径
- `core/src/main/java/io/grpc/internal/KeepAliveEnforcer.java:57` — `pingAcceptable()`
- `netty/src/main/java/io/grpc/netty/NettyClientTransport.java:239` — client transport 创建 keepalive manager
- `netty/src/main/java/io/grpc/netty/NettyServerHandler.java:430` — server handler 创建 keepalive manager
- `netty/src/main/java/io/grpc/netty/NettyServerHandler.java:995` — too_many_pings → GOAWAY ENHANCE_YOUR_CALM

### flow control / BDP
- `netty/src/main/java/io/grpc/netty/NettyClientHandler.java:247` — client 初始 flow-control window
- `netty/src/main/java/io/grpc/netty/NettyServerHandler.java:271` — server 初始 flow-control window
- `netty/src/main/java/io/grpc/netty/Utils.java:542` — FlowControlReader 注释：Netty local/channelz local 方向相反
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:363` — bytesRead()/消费路径
- `netty/src/main/java/io/grpc/netty/NettyClientStream.java:333` — bytesRead 回到 transport state
- `netty/src/main/java/io/grpc/netty/NettyClientHandler.java:411` — `returnProcessedBytes()` → `consumeBytes()`
- `netty/src/main/java/io/grpc/netty/AbstractNettyHandler.java:170` — `flowControlPing()`
- `netty/src/main/java/io/grpc/netty/AbstractNettyHandler.java:195` — BDP ping 处理

### connection lifecycle
- `netty/src/main/java/io/grpc/netty/NettyClientHandler.java:950` — GOAWAY 处理起点
- `netty/src/main/java/io/grpc/netty/NettyClientHandler.java:983` — `goingAway()` 关闭受影响 stream
- `netty/src/main/java/io/grpc/netty/NettyClientHandler.java:1040` — stream id exhaustion
- `netty/src/main/java/io/grpc/netty/NettyServerHandler.java:1097` — graceful shutdown 第一段 GOAWAY
- `netty/src/main/java/io/grpc/netty/NettyServerHandler.java:1118` — ping 后第二段 GOAWAY
- `core/src/main/java/io/grpc/internal/MaxConnectionIdleManager.java:65` — idle manager 核心调度
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:406` — channel 进入 IDLE

## 测试证据清单

- `core/src/test/java/io/grpc/internal/KeepAliveManagerTest.java:64` — keepalive 调度与 timeout
- `core/src/test/java/io/grpc/internal/KeepAliveEnforcerTest.java:64` — 服务端 anti-ping enforcement
- `netty/src/test/java/io/grpc/netty/NettyServerHandlerTest.java:866` — too_many_pings → GOAWAY
- `netty/src/test/java/io/grpc/netty/NettyClientHandlerTest.java:439` — GOAWAY 对 stream 的影响
- `netty/src/test/java/io/grpc/netty/NettyClientHandlerTest.java:740` — stream id exhaustion
- `netty/src/test/java/io/grpc/netty/NettyClientHandlerTest.java:841` — BDP ping 行为
- `netty/src/test/java/io/grpc/netty/NettyServerHandlerTest.java:965` — graceful drain / max idle / max age

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇重点放在 core/netty 默认实现，不展开 okhttp/cronet 等其他 transport。
- 某些连接行为（如 GOAWAY 细节）会受具体 HTTP/2 实现和对端策略影响，本文不外推成所有实现都一致。

## 与其他篇的边界

### 本篇要讲清

- keepalive manager / enforcer 的职责分工。
- flow-control 与 stalled RPC 的关系。
- BDP ping 与 keepalive ping 的差异。
- GOAWAY、idle、max age、stream-id exhaustion 的连接生命周期含义。
- 常见“活着但卡住”症状的判因方式。

### 本篇不深讲

- channel/subchannel/picker 的详细选路（已在 ch05/02）。
- deadline/cancel/retry 的最终状态收敛（已在 ch05/01）。
- xDS 与其他 transport 变体。

## 写作后检查

- [ ] 开篇先抓“活着但卡住”的排障痛点，而不是直接讲 KeepAliveManager。
- [ ] 至少展开 3 个失败方案，且包含“所有 ping 都是 keepalive”“GOAWAY NO_ERROR 可以忽略”。
- [ ] 明确给出 keepalive / flow-control / lifecycle 三条并行机制总图。
- [ ] 不把本篇写成参数说明手册。
- [ ] 每个排障结论都落到具体 file:line。
- [ ] 删除代码块后，读者仍能复述连接问题排障四问法。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。