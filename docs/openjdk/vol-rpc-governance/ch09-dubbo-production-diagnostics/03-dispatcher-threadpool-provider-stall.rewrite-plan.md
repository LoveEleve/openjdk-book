# Dubbo：Dispatcher、线程池与 provider 假死问题 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch09-dubbo-production-diagnostics`
- 篇：`03 Dispatcher、线程池与 provider 假死问题`
- 对应主题：`D-PROD-3 Provider Stall / Threadpool / Dispatcher`
- 文章类型：生产诊断执行面篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：线上经常会遇到一种很难排的 provider 问题：端口还通、进程还活着、甚至 heartbeat 还正常，但请求越来越慢、开始拒绝、最后看起来像“半死不活”。这类问题经常被误诊成网络不稳、consumer 重试过多，或者 provider 业务代码单纯变慢。但 Dubbo 里真正起作用的往往是：Netty IO event loop、dispatcher 切线程策略、业务线程池共享粒度、队列类型和拒绝策略共同塑造出来的一条执行面链路。
- 一句话顿悟：provider 侧的“慢、卡、拒绝”不是单一点故障，而是这样一条链：网络事件先在 Netty IO 线程里到达，经 `ChannelHandlers.wrap()` 进入 dispatcher，dispatcher 决定是否切到业务 executor，`DecodeHandler`/`HeaderExchangeHandler`/`DubboProtocol.requestHandler` 再把 request 送进 exporter/invoker；其中只要 dispatcher 选错、业务池打满、队列堆积或 direct 模式把慢业务压在 IO 线程上，consumer 最终看到的就可能是 timeout、线程池耗尽，甚至像网络故障一样的断连/重连。
- 文章边界：本篇重点讲 provider 侧执行链、dispatcher 模式差异、业务线程池与拒绝策略、以及这些现象如何映射成 consumer 看到的 timeout / rejected / network-like symptom；不重讲 Dubbo2 协议字段、Exchange 基础语义、cluster 重试算法。

## 前置依赖

### HARD

- `ch06-dubbo-runtime/04-remoting-exchange-dispatcher-network.md`
- `ch09-dubbo-production-diagnostics/01-timeout-retry-cluster-troubleshooting.md`

### SOFT

- 不要求先懂 Netty event loop 全量实现。
- 不要求先懂 Dubbo 所有线程池类型的调参细节。

### NAV

- 后续可接：Dubbo 控制面/执行面综合排障总篇。
- 后续可接：线程池调优与服务隔离专题。

## 一句话困惑

为什么 provider 明明没挂，端口也通，请求却还是越来越慢、开始拒绝，甚至看起来像网络问题？

## 一句话顿悟

排这类问题要盯的是 provider 执行链，而不是单看最终 timeout：Netty worker 负责收包，dispatcher 决定哪些事件切到业务线程池，线程池与队列决定是否堆积/拒绝，`HeaderExchangeHandler` / `DubboProtocol` 决定如何把执行异常和拒绝翻译成 response；因此 provider “假死”往往是 IO 线程、dispatcher 和业务 executor 之间的边界出了问题，而不是进程真的死了。

## 读者理解路径

1. 先否定“端口通 = provider 正常”的直觉。
2. 建立总图：IO event loop -> dispatcher -> 业务线程池 -> protocol handler -> invoker。
3. 解释 `all` / `execution` / `direct` / `message` / `connection` dispatcher 的实际线程边界。
4. 解释 threadpool 类型和队列差异如何改变症状（立刻拒绝 vs 长时间排队）。
5. 解释 RejectedExecution 如何被 provider 翻译成 `SERVER_THREADPOOL_EXHAUSTED_ERROR`，以及为什么有时 consumer 仍只看到 timeout。
6. 解释 direct 模式为何更像“网络故障”，而 execution/all 更像“业务池打满”。
7. 收束到：provider 假死不是一个状态，而是一条执行链上的阻塞或拒绝。

## 失败方案推演

### 失败方案一：端口还通、进程还活着，就说明 provider 没问题

- 这只说明 transport 层还活着，不说明业务 executor 还有空闲。
- provider 完全可能在 dispatcher 之后排队严重或被拒绝，consumer 端最后却只看到 timeout。
- 所以“活着”不等于“还能及时处理业务”。

### 失败方案二：Dispatcher 只是线程池配置别名

- 这会把 dispatcher 和 threadpool 混成一层。
- Dispatcher 决定“哪些事件切线程”，threadpool 决定“切过去之后怎么排队和拒绝”。
- 所以两者是相邻边界，不是同一概念。

### 失败方案三：一次调用打到多台 provider，就一定是重复提交 bug

- 这在 provider 假死场景里很常见，但真正原因可能是 consumer 侧 failover / forking 放大了请求，而 provider 侧只是更慢或更容易被拒绝。
- 所以排 provider 假死时，仍要回到前一篇看 cluster 语义，不然会把执行面问题误判成业务重入问题。

## 必须澄清的误解

1. `dispatcher` 决定的是线程切换边界，不是线程池实现本身。
2. `iothreads` 不是业务并发上限，业务线程池是另一套资源。
3. one-way / heartbeat 也会经过 dispatcher 和 transport，但它们的执行面症状不同于普通 request-response。
4. provider 返回 `SERVER_THREADPOOL_EXHAUSTED_ERROR` 不一定总能成功送达 consumer；某些模式下 consumer 最终可能还是看到 timeout。
5. `direct` 模式下慢业务可能压死 IO 线程，因此症状会像网络故障。

## 文章结构与字数预算

1. 困惑开场：为什么“活着但慢 / 卡 / 拒绝”最难排（800-1000 字）
2. 最小总图：provider 执行链（1000-1400 字）
3. dispatcher：五种模式的真实线程边界（1600-2200 字）
4. threadpool：共享粒度、队列与拒绝（1600-2200 字）
5. provider 侧拒绝 / 假死如何映射成 consumer 看到的现象（1600-2200 字）
6. direct / execution / all 三种最关键模式的对照（1400-1800 字）
7. 收网总结：provider 执行面排障四问法（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboProtocol.java:407` — createServer / Exchangers.bind
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/transport/dispatcher/ChannelHandlers.java:43` — dispatcher wrapper chain
- `dubbo-remoting/dubbo-remoting-netty4/src/main/java/org/apache/dubbo/remoting/transport/netty4/NettyServer.java:158` — iothreads / worker group
- `dubbo-remoting/dubbo-remoting-netty4/src/main/java/org/apache/dubbo/remoting/transport/netty4/NettyServerHandler.java:113` — channelRead -> handler.received
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/transport/dispatcher/ChannelEventRunnable.java:58` — dispatcher runnable
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/transport/dispatcher/all/AllChannelHandler.java:39`
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/transport/dispatcher/execution/ExecutionChannelHandler.java:33`
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/transport/dispatcher/direct/DirectChannelHandler.java:38`
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/transport/dispatcher/message/MessageOnlyChannelHandler.java:38`
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/transport/dispatcher/connection/ConnectionOrderedChannelHandler.java:46`
- `dubbo-common/src/main/java/org/apache/dubbo/common/threadpool/manager/DefaultExecutorRepository.java:159` — provider executor keyed by port
- `dubbo-common/src/main/java/org/apache/dubbo/common/threadpool/support/AbortPolicyWithReport.java:100` — rejection logging / exception
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/transport/dispatcher/WrappedChannelHandler.java:82` — `SERVER_THREADPOOL_EXHAUSTED_ERROR` feedback
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/exchange/Response.java:78` — status 100
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/exchange/support/header/HeaderExchangeHandler.java:107` — provider business response path
- `dubbo-remoting/dubbo-remoting-netty4/src/main/java/org/apache/dubbo/remoting/transport/netty4/NettyServerHandler.java:128` — idle close

## 测试证据清单

- `HeaderExchangeHandlerTest.java:61`
- `HeaderExchangeHandlerTest.java:102`
- `HeaderExchangeHandlerTest.java:132`
- `ChannelHandlersTest.java:36`
- `WrappedChannelHandlerTest.java:113`
- `AbortPolicyWithReportTest.java:60`
- `AbortPolicyWithReportTest.java:84`
- `FixedThreadPoolTest.java:47`
- `FixedThreadPoolTest.java:78`
- `EagerThreadPoolTest.java:45`
- `ThreadPoolStatusCheckerTest.java:48`

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇聚焦 provider 执行链与线程池/dispatcher 语义，不展开完整调参策略。
- 不重复展开 remoting 协议细节与 cluster 算法。

## 与其他篇的边界

### 本篇要讲清

- provider 侧执行链的线程边界。
- dispatcher 与 threadpool 的分工。
- 拒绝 / 排队 / 假死怎样映射成 consumer 症状。
- 典型模式（all / execution / direct）的差异。

### 本篇不深讲

- remoting 报文格式与 codec 细节。
- cluster 策略本身（只在诊断上引用）。
- registry/config-center 细节。

## 写作后检查

- [ ] 开篇先抓“活着但慢 / 卡 / 拒绝”的 provider 痛点。
- [ ] 至少展开 3 个失败方案，且包含“dispatcher=线程池”“端口通=provider 正常”。
- [ ] 明确给出 provider 执行链总图。
- [ ] 不把本文写成线程池参数手册。
- [ ] 每个症状都落到具体执行链位置和 file:line。
- [ ] 删除代码块后，读者仍能复述 provider 假死排障四问法。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。