# grpc-java：Keepalive、流控与连接问题分析

> 基于 grpc-java v1.83.1

## 一、困惑开场：为什么连接明明活着，请求却还是卡住了

生产环境里最让人抓狂的一类问题，不是“连接直接断了”，而是“连接看起来还活着，但请求就是慢、抖、卡”。

你抓包看到客户端还在发 PING，服务端也还在回 ACK；TCP 连接没断，HTTP/2 流也没立刻 reset。按直觉看，这条链路应该是健康的。但业务请求就是迟迟不往前推进，最后可能变成超时，或者在某个 drain 时刻突然一起失败。

如果这时只盯着 keepalive，你很容易得到一个错误结论：**既然 ping 还在正常回，那就不是连接问题。**

但 grpc-java 里“连接活着”其实至少有三种完全不同的含义：

- TCP/HTTP2 还没断。
- keepalive 最近看到了入站活动，所以没有判死。
- flow-control 还有窗口信用，数据还能继续前进。

这三者不等价。连接完全可能在前两个意义上“活着”，但在第三个意义上已经“卡死”。这正是 keepalive、流控和连接生命周期容易被混在一起误诊的根源。

## 二、前情回顾：前两篇已经讲了“为什么失败 / 为什么没发出去”，这一篇只问“为什么连接还活着却没进展”

在 `ch05/01` 中，我们已经建立了“来源层 → 重试层 → 收敛层”的排障模型：最终看到的 `Status` 不等于最初来源，deadline、cancel、retry、listener 异常都会在 `closedInternal()` 里被重新解释。

在 `ch05/02` 中，我们又知道了一次调用在真正离开进程之前，会经过 `pendingCalls`、`pendingStreams`、picker、subchannel、transport 五道门。也就是说，“没发出去”并不一定是连接没建起来。

把这两篇连起来，其实已经回答了两类生产问题：

- 为什么一个失败最后显示成了这个 Status。  
- 为什么一个调用根本还没真正出去。  

这一篇继续往下挖第三类问题：**调用已经拿到了 transport，连接也没立刻断，为什么业务流量仍然会停住？**

所以这三篇的递进关系是：先解释“为什么失败被改写”，再解释“为什么没发出去”，最后解释“为什么明明还活着却没进展”。

## 三、先走三条失败的路

### 失败方案一：只要 keepalive ping 正常，连接就一定健康

这是最常见的误判。看到 PING 还在发、ACK 还在回，就以为连接没问题。

但 keepalive 证明的只是“最近还有入站活动”，不是“业务消息还能继续前进”。grpc-java 的 `KeepAliveManager.onDataReceived()` 对很多入站帧都一视同仁：headers、data、rst_stream、ping、ping ack 都算“我收到了东西”。这足以阻止 keepalive timeout 触发，但根本不足以证明 flow-control 还有信用，或者应用层正在继续消费消息。

所以 keepalive 正常，只能说明 transport 近期没完全失联；它不能证明你的业务流量没卡住。

### 失败方案二：所有 PING 都是 keepalive ping

另一类误判是抓到 PING 就说“keepalive 太激进”。

grpc-java 里至少有两套完全不同的 ping：

- **keepalive ping**：为了探活，定时发，超时则判连接可能已失效。
- **BDP ping**：为了估算带宽时延积、动态调大窗口，不是为了探活。

两者都走 HTTP/2 PING frame，但用途完全不同。线上看到一堆 PING，不先分清是哪一类，就很容易把“窗口自适应调优”误诊成“keepalive 太频繁”。

### 失败方案三：`GOAWAY NO_ERROR` 说明没问题，可以忽略

很多人看到 `GOAWAY NO_ERROR` 会下意识地说：都 `NO_ERROR` 了，那肯定没事。

这也是危险的误解。`GOAWAY NO_ERROR` 在 HTTP/2 里往往表示优雅 drain，而不是崩溃关闭。但对 grpc-java 客户端来说，它仍然是一个真实的连接生命周期事件：新的 stream 不能再复用这条连接，已有 stream 也可能受到 last stream id 边界的影响。grpc-java 甚至会把这类事件处理成可重试的 `UNAVAILABLE`，这不是网络炸了，但也绝不是“可以忽略”。

## 四、最小总图：并行发生的三套机制

这篇文章要抓住的不是一条单链路，而是三套并行发生的机制。

这里先做一个路标：下面这三块不是“先发生 keepalive，再发生 flow-control，最后进入 connection lifecycle”的执行顺序，而是三把同时照向同一条连接的诊断尺子。你在线上遇到的一个症状，往往要同时用这三把尺子去量，不能拿其中一把的结论替代另外两把。

```
               ┌──────────── keepalive ────────────┐
               │  什么时候发 ping，多久没活动算死 │
               └──────────────────────────────────┘
                              │
                              │ 同一条 HTTP/2 连接
                              │
               ┌──────────── flow control ─────────┐
               │  还有没有连接/流级窗口信用，数据能不能前进 │
               └──────────────────────────────────┘
                              │
                              │
               ┌──────── connection lifecycle ─────┐
               │  idle / max age / GOAWAY / shutdown / stream-id exhaustion │
               └──────────────────────────────────┘
```

排障时最容易犯的错，就是拿其中一套机制去解释另一套机制的症状。比如用 keepalive 的结论去解释 flow-control stall，用 GOAWAY 的语义去解释 ping timeout。后面所有内容，都是在把这三套机制拆开。

## 五、keepalive：谁在发 ping，谁有权把你赶走

### 5.1 `KeepAliveManager`：主动发 ping 的一方

grpc-java 的 keepalive 主调度器是 `KeepAliveManager`。它内部有一个明确的状态机：`IDLE`、`PING_SCHEDULED`、`PING_DELAYED`、`PING_SENT`、`IDLE_AND_PING_SENT`、`DISCONNECTED`。

`KeepAliveManager.java:44` — keepalive 状态机枚举

从生产角度看，你不用死记这些状态名，但要记住它在做两件事：

1. 到时间了就发一个 keepalive ping。  
2. 发出去之后，如果在 `keepAliveTimeout` 内没有看到任何新的入站活动，就判定连接可能已经失效，主动关闭。

`KeepAliveManager.java:160` — `onTransportStarted()`
`KeepAliveManager.java:188` — `onDataReceived()`
`KeepAliveManager.java:222` — send ping / timeout 关闭路径

### 5.2 客户端参数：`keepAliveTime`、`keepAliveTimeout`、`keepAliveWithoutCalls`

客户端侧的 keepalive manager 由 `NettyClientTransport.start()` 创建，参数来自 `NettyChannelBuilder`。

`NettyClientTransport.java:239` — client transport 创建 keepalive manager
`NettyChannelBuilder.java:111` — keepalive 默认值/禁用语义
`NettyChannelBuilder.java:532` — keepalive builder 参数入口

三个参数里最容易混淆的是：

- `keepAliveTime`：多久没有活动后发一次 keepalive ping。
- `keepAliveTimeout`：发出 keepalive ping 后，多久没看到入站活动就判死。
- `keepAliveWithoutCalls`：没有 active RPC 时，客户端自己是否还允许继续发 keepalive。

这里最关键的一点是：**`keepAliveTimeout` 不是 RPC timeout。** 它只约束 keepalive 这件事本身，不约束业务调用时长。

### 5.3 服务端参数：`KeepAliveEnforcer` 不是 manager

很多人会把服务端也理解成“也有一个 KeepAliveManager，所以客户端怎么 ping 都行”。不对。

这里最需要钉住的一句话是：**客户端允许自己 ping，不等于服务端允许你这么 ping。** `keepAliveWithoutCalls(true)` 只是客户端自己的意愿；服务端还有 `permitKeepAliveWithoutCalls` 和 `permitKeepAliveTime` 这道门，过不了就会被 anti-ping 机制赶走。 

服务端确实可以自己有一个 `KeepAliveManager`，但它还有另一套机制：`KeepAliveEnforcer`。这个 enforcer 不是主动发 ping 的，它是拿来判断“对方的 ping 我允不允许”的。

`KeepAliveEnforcer.java:57` — `pingAcceptable()`
`NettyServerHandler.java:995` — 服务端用 enforcer 判断 ping 是否过多

这就是客户端 keepalive 和服务端 permit-keepalive 之间最容易错位的地方：客户端允许“无调用也 ping”，不等于服务端允许你这么做。

### 5.4 `too_many_pings`：服务端怎么把你赶走

如果服务端认为客户端 ping 太激进，它不会温柔地告诉你“慢一点”，而是直接发 `GOAWAY ENHANCE_YOUR_CALM`，debug data 常见为 `too_many_pings`。

`NettyServerHandler.java:995` — too_many_pings → GOAWAY ENHANCE_YOUR_CALM
`NettyClientHandler.java:331` — 客户端识别 ENHANCE_YOUR_CALM
`NettyClientHandler.java:335` — debug data 为 `too_many_pings` 时触发 keepalive backoff

线上看到这类告警时，第一反应不应该是“网络抖了”，而应该是“keepalive 参数不匹配”。

## 六、流控：连接活着，为什么数据还是不动

这里先做一个路标。上一节讲的是“连接多久不说话会被判死”，这一节讲的是“连接明明还在说话，为什么业务数据却不前进”。这两个问题不要混在一起。

### 6.1 连接窗口和流窗口是两层不同的信用

grpc-java 依赖 HTTP/2 flow control。这里至少有两层窗口：

- **connection-level window**：整条连接共享的总信用。  
- **stream-level window**：某个具体 stream 自己的信用。

客户端和服务端都会在创建 HTTP/2 handler 时设置初始 flow-control window。

`NettyClientHandler.java:247` — client 初始 flow-control window
`NettyServerHandler.java:271` — server 初始 flow-control window

如果这两层窗口中的任意一层信用不足，业务数据就会停住。你看到的现象常常是：连接还活着、ping 也正常，但新的数据帧迟迟不前进。

### 6.2 窗口信用什么时候归还

这是流控排障里最关键的一步：窗口不是自动长回来的。必须等到接收方真正消费了数据，grpc-java 才会把 processed bytes 归还给 HTTP/2 flow control。

这条链路大致是：`MessageDeframer.bytesRead()` → stream transport state `bytesRead()` → handler `returnProcessedBytes()` → Netty `consumeBytes()`。

`MessageDeframer.java:363` — bytesRead / 消费路径
`NettyClientStream.java:333` — bytesRead 回到 transport state
`NettyClientHandler.java:411` — `returnProcessedBytes()` → `consumeBytes()`

也就是说，**如果应用层/deframer 消费不及时，窗口信用就不会及时归还。** 换成人话说，不是网络没发，也不是对端没回，而是“本地还没把已经到手的数据真正吃下去”，所以新的信用迟迟放不回来。

### 6.3 为什么“连接活着但卡住”经常是 flow-control 耗尽

这就是线上最容易误诊的场景：

- TCP 连接没断  
- keepalive 还在正常收到入站活动  
- 但业务流量就是不前进

这时高概率不是 keepalive 有问题，而是 flow-control 信用没被归还。连接在“连通性”意义上还活着，但在“业务前进能力”意义上已经停住了。

### 6.4 观测窗口时最容易踩的坑

grpc-java 通过 `Utils.FlowControlReader` 暴露窗口观测能力，但这里有一个特别容易坑人的注释：Netty 的 “local” 和 channelz 的 “local” 在方向含义上是相反的。

`Utils.java:542` — 注释：Netty local/channelz local 方向相反

这意味着你在线上看某个窗口指标时，先不要急着说“是本地窗口耗尽了还是远端窗口耗尽了”，得先确认这个指标的“local”到底站在哪个观察视角上说话。

## 七、BDP ping 不是 keepalive ping

### 7.1 同样是 PING，用途完全不同

grpc-java 里还有一套常被误认成 keepalive 的 ping：`flowControlPing()`，也就是 BDP ping。

`AbstractNettyHandler.java:170` — `flowControlPing()`
`AbstractNettyHandler.java:195` — BDP ping 处理

它的目标不是探活，而是估算带宽时延积，动态调大 connection window。也就是说，它更像“窗口自调优工具”，不是“心跳包”。

### 7.2 为什么抓包看到很多 PING，不一定是 keepalive 太频繁

线上抓包看到一堆 PING，很多人第一反应就是 keepalive 太 aggressive。但如果其中相当一部分其实是 BDP ping，那你就把调优流量误诊成探活流量了。

这也是为什么这篇文章一开始就强调：**先问“谁在发 ping”，再问“ping 发得是不是太多”。**

## 八、连接生命周期：GOAWAY、idle、max age、stream-id exhaustion

### 8.1 `GOAWAY`：优雅关闭不是崩溃关闭

客户端处理 GOAWAY 的逻辑，不是“连接死了，全部报错”，而是更细粒度地：先标记 going away，再根据 `lastKnownStream` 决定哪些 stream 受影响，必要时关闭受影响的流。

`NettyClientHandler.java:950` — GOAWAY 处理起点
`NettyClientHandler.java:983` — `goingAway()` 关闭受影响 stream

所以 `GOAWAY NO_ERROR` 不表示“什么都没发生”，而表示“这是优雅 drain，不是崩溃关闭”。对新 stream 来说，它仍然会触发重建或失败。

### 8.2 服务端优雅 drain 是两段式 GOAWAY

服务端因为 `maxConnectionIdle`、`maxConnectionAge` 或应用主动关闭连接时，grpc-java 不是一次性直接掐断，而是两段式 GOAWAY：

1. 先发一个 `lastStreamId = Integer.MAX_VALUE` 的 GOAWAY，告诉对端“别再新开了”。  
2. 发一个 ping，等它回来。  
3. 再发第二个 GOAWAY，带真实的 `lastStreamCreated`，然后进入真正关闭。

`NettyServerHandler.java:1097` — 第一段 GOAWAY
`NettyServerHandler.java:1118` — ping 后第二段 GOAWAY
`NettyServerHandler.java:1135` — 进入最终关闭

线上看这类日志，如果你把它误读成“服务端突然断开”，就会把优雅 drain 误诊成故障。

### 8.3 channel idle 和 transport idle 不是一回事

`ManagedChannelImpl` 的 idle 模式说的是 channel 层面的“长时间无需求，主动回收 resolver/LB/transport 相关状态”，不等于底层 socket 在 TCP 层面空闲了多久。

`ManagedChannelImpl.java:406` — channel 进入 IDLE

这也是为什么有些连接 churn 看起来像“网络不稳”，其实只是应用层长时间没流量，channel 进入了 idle，下一次请求又把它唤醒重建。

### 8.4 stream id exhaustion：不是泄漏，是老连接寿命走到头

HTTP/2 stream id 不是无限的。长寿命、高并发连接最终可能耗尽 stream id。此时 grpc-java 会报 `UNAVAILABLE`，并优雅地把连接退役，让后续请求去新连接上跑。

`NettyClientHandler.java:1040` — stream id exhaustion

线上如果看到这种现象，不要第一时间怀疑 server 崩了或连接泄漏。很多时候它只是“这条老连接该退休了”。

## 九、常见线上症状怎么从源码反推

### 9.1 ping 正常但业务卡住

优先怀疑 flow-control，不要先怪 keepalive。

看 deframer 消费是否及时、窗口信用是否归还、`consumeBytes()` 链路是否持续推进。连接可能在“活着”，但业务已经没有发送/接收信用了。

### 9.2 `too_many_pings`

优先对齐客户端和服务端 keepalive 参数：

- client `keepAliveTime` / `keepAliveWithoutCalls`
- server `permitKeepAliveTime` / `permitKeepAliveWithoutCalls`

这类问题本质上不是“网络不通”，而是“探活策略不被对端允许”。

### 9.3 `GOAWAY NO_ERROR`

不要忽略。先问：这是 graceful drain、max idle/max age，还是别的连接管理策略在起作用？它不等于故障，但一定是连接生命周期发生了变化。

### 9.4 大量 reconnect churn

不要先怪链路。先分清：是 channel idle 导致的懒重连，还是 transport 真失联，还是 keepalive timeout，还是 stream id exhaustion 在促使连接轮换。

## 十、误解澄清

### 误解一：keepalive ping 正常，就说明业务链路也正常

不是。keepalive 证明的是“近期还有入站活动”，不是“业务流量还能继续前进”。如果 flow-control 窗口信用没有归还，连接在 keepalive 意义上可以完全健康，但业务请求已经实质性停住了。

### 误解二：`GOAWAY NO_ERROR` 可以忽略，因为它不是错误

也不是。`NO_ERROR` 只说明这不是崩溃式关闭，不说明对连接生命周期没有影响。对新 stream 来说，它仍然意味着“这条连接开始 drain 了，要准备切走”。线上如果忽略这类 GOAWAY，就会把优雅轮换误诊成随机重连。

### 误解三：channel idle 和 transport idle 是同一个东西

不是。channel idle 是 `ManagedChannelImpl` 在更高层做的惰性收缩，关注的是“现在有没有继续维持整套解析/LB/transport 体系的必要”；transport/socket idle 则更底层，关注的是连接本身有没有业务或 keepalive 活动。两者层级不同，排障时不能混用。

## 十一、收网总结：连接问题排障四问法

回到开头的困惑：为什么连接明明活着，请求却还是卡住了？

因为 grpc-java 里“活着”至少有三种不同含义：transport 没死、keepalive 还满意、flow-control 还有信用。你如果只验证了前两种，就可能错过真正限制业务前进的第三种。

真正有用的排障方法，可以收成四问：

1. **谁在发 ping？** 是 keepalive ping，还是 BDP/flow-control ping？
2. **窗口还有没有信用？** 是连接窗口卡住了，还是某个 stream 窗口没归还？
3. **GOAWAY 是什么语义？** 是 `NO_ERROR` 的优雅 drain，还是 `ENHANCE_YOUR_CALM` 的 anti-ping 驱逐？
4. **当前 idle 是哪一层？** 是 channel idle，还是 transport 真空闲 / 真断开？

把这四问问清楚，大部分“慢、抖、断”的连接问题都会变得可解释：

- ping 正常但业务停住：优先看 flow-control。  
- `too_many_pings`：优先看 keepalive 参数错位。  
- `GOAWAY NO_ERROR`：优先看 drain / max idle / max age。  
- 频繁重连：优先分清 channel idle 还是 transport 真故障。  

**三句话总结：**

1. keepalive、flow-control、connection lifecycle 是三套并行机制，不能拿其中一套的现象去解释另外一套的问题。  
2. “连接活着”不等于“业务能前进”，flow-control 信用耗尽时前者成立而后者不成立。  
3. 生产上遇到“慢、抖、断”，先分清 ping 类型、窗口信用、GOAWAY 语义和 idle 层级，再去谈网络本身。  

**下篇说明：** 到这里，`ch05-production-diagnostics` 三篇全部完成，grpc-java 完整卷当前规划中的生产诊断主线已经闭环。