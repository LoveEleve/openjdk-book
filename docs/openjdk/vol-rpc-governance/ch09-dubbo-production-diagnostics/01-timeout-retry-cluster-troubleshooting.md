# Dubbo：Timeout、Retry 与 Cluster 线上排障

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：同样是失败，为什么看起来完全不是一回事

线上最让人崩溃的一类 Dubbo 问题，不是“调用失败了”，而是“看起来同样失败，结果却完全不像一回事”。

有时候报的是 timeout，但 provider 日志里明明还能看到业务处理完成；有时候一次调用看起来只打一枪，日志里却出现了好几台 provider；有时候 registry 里明明还有 provider，consumer 却说 `No provider available after filtering`；有时候只是配了一条 router 或 configurator，失败率就突然变了。

如果只盯着最终异常，你很容易得出非常自信但完全错误的判断：

- timeout = provider 慢  
- no provider = registry 没地址  
- retry = 同一台机器上再试几次  

Dubbo 真正的线上失败并不是一个平的错误面，而是三层叠起来的结果：

1. **候选集层**：现在还有哪些 invoker 可参与调用？  
2. **Cluster 语义层**：失败后要不要换别台、并发打多台、广播全量打？  
3. **Remoting timeout 层**：这个超时发生在消费者发送前、发送后等待、还是 provider 端慢返回？

所以这篇文章的核心不是“记住几个异常码”，而是学会把一个最终失败拆回这三层去判因。

## 二、前情回顾：前面几篇已经讲了主线，这一篇只问线上怎么倒查

在 Dubbo 运行时篇里，我们已经知道：

- `Directory -> RouterChain -> LoadBalance -> ClusterInvoker` 决定 consumer 侧这次究竟选谁。  
- `DubboInvoker`、`ExchangeClient`、`DefaultFuture` 决定 request/response 如何沿网络流动。  
- registry、router、configurator 又会在运行中改变 live invoker 集和 URL 语义。  

这些篇章讲的是“机制怎么运转”。这一篇做的不是新增一条主线，而是把前面这些主线重新拿回来，按事故排障视角重新切成“候选集 / cluster 语义 / timeout 来源”三层。

生产排障问的是另一件事：**当最终只剩一个 `RpcException` 时，我怎么把它拆回到候选集、cluster 语义和 remoting timeout 这三层。**

## 三、先走三条失败的路

### 失败方案一：最终异常码就等于最初来源

这是最常见的误判。看到 `RpcException.TIMEOUT_EXCEPTION`，就断定 provider 慢；看到 `NO_INVOKER_AVAILABLE_AFTER_FILTER`，就断定 registry 没地址。

但 Dubbo 的异常码往往是运行链收束后的结果，而不是最初来源。比如 timeout 这一类，`DubboInvoker` 最终都统一映射成 `RpcException.TIMEOUT_EXCEPTION`，但背后可能是：

- consumer 发送前就超时  
- 请求已经发出，但 provider 迟迟没回  
- countdown timeout 已经耗尽，请求甚至没机会发出去

所以“看最终码直接判因”是最危险的捷径。

### 失败方案二：failover 就是在原始 provider 列表里换一台重试

很多人把 failover 理解成一个静态 for-loop：A 失败了就试 B，B 失败了就试 C。

源码不是这么做的。`FailoverClusterInvoker` 每次重试前都会重新 `list(invocation)`，这意味着：

- provider 列表可能已经被 registry 更新了  
- router 规则可能已经变了  
- 本地 `validInvokers` 也可能变了

所以 failover 的 retry 不是“静态列表轮换”，而是“动态视图上的重试”。

### 失败方案三：地址不变，失败形态就不该变

这也是一个高频误判。你会觉得 registry 地址没变，那 Dubbo 的调用行为应该稳定。

但 router 和 configurator 都能在地址不变的前提下改变：

- 哪些 invoker 进入候选集  
- timeout 是多少  
- retries/forks 是多少  
- loadbalance 用哪种策略  

所以“地址没变但行为变了”在 Dubbo 里是完全正常的，它说明的不是网络出问题，而是控制面改变了调用语义。

## 四、最小总图：判因要分三层看

```text
调用失败
  ↓
[第一层] 候选集层
  Directory / RouterChain
  -> 这次调用到底还有谁可打？
  ↓
[第二层] Cluster 语义层
  failover / failfast / forking / broadcast
  -> 失败后要不要换别台、并发打多台、广播全量？
  ↓
[第三层] Remoting timeout 层
  DefaultFuture / DubboInvoker
  -> 这个 timeout 是 consumer-side 还是 server-side？
```

排障时最重要的不是一上来就看异常栈，而是先问三个问题：

1. **候选集当时是什么？** 还是已经被 router / configurator 裁得只剩零个或一个？  
2. **当前 cluster 语义是什么？** 是 failover、failfast、forking 还是 broadcast？  
3. **timeout 文本说的到底是什么？** 是 sending timeout，还是 waiting server-side response timeout？

这里再钉一句路标：这三层不是固定执行流水线，而是三种排障观察面。一次失败可能同时受三层影响，但你在排障时必须把它们拆开看，不然最终异常会把来源混在一起。

## 五、候选集层：为什么会出现 `No provider available`

### 5.1 `Directory.list()` 返回的不是 registry 全量地址

consumer 每次发起调用时，`AbstractClusterInvoker.invoke()` 先向 `Directory` 要候选集。

`AbstractClusterInvoker.java:345` — cluster invoke 入口
`AbstractClusterInvoker.java:355` — `list(invocation)`

这份列表不是 registry 原始 provider 全表，而是：

- 当前 invoker 视图  
- 经过 router chain 裁剪  
- 本地可用性过滤之后

所以它已经是一个“运行时有效候选集”，不是简单数据快照。

### 5.2 route miss 如何变成 no provider

`DynamicDirectory.doList()` 会调用 `singleRouterChain.route(...)`。如果 routing 执行后结果为空，最终 `AbstractClusterInvoker.checkInvokers(...)` 会抛出 `NO_INVOKER_AVAILABLE_AFTER_FILTER`。

`DynamicDirectory.java:212` — route 执行
`AbstractClusterInvoker.java:386` — `NO_INVOKER_AVAILABLE_AFTER_FILTER`

这解释了一个很常见的线上误判：provider 明明在 registry 里，但当前调用就是“no provider”。原因可能不在 registry，而在 router 把候选裁没了。

### 5.3 forbidden 又是另一类情况

如果 `DynamicDirectory` 已被标成 forbidden，且启用了 fail-fast，它会直接抛 `FORBIDDEN_EXCEPTION`。

`DynamicDirectory.java:197` — `FORBIDDEN_EXCEPTION`

所以线上看到“没 provider”时，要先分清：

- 是 routing 后空集合  
- 还是 directory 直接 forbidden  

这两类错误虽然都像“打不到 provider”，但来源不一样。

## 六、timeout：为什么同样都是 TIMEOUT，来源却不同

### 6.1 timeout 是在 consumer 侧算出来的

`DubboInvoker.doInvoke()` 会先通过 `RpcUtils.calculateTimeout(...)` 计算这次调用的 timeout。

`DubboInvoker.java:107` — timeout 计算
`RpcUtils.java:280` — timeout 获取
`RpcUtils.java:293` — countdown timeout

这里已经埋下了第一个坑：如果 countdown timeout 已经耗尽，请求甚至可能还没发出去，就直接走“超时终止”路径。

### 6.2 `DefaultFuture` 如何判定 client-side 和 server-side timeout

这里要先钉死一句：**Dubbo 最终给你的异常码都可能是 `RpcException.TIMEOUT_EXCEPTION`，真正决定判因的是 timeout 文本，而不是异常码本身。**

`HeaderExchangeChannel.request()` 创建 `DefaultFuture`，后者会挂一个 timeout 任务。

`DefaultFuture.java:128` — future / timeout 注册

timeout 触发时，`DefaultFuture` 会构造一个超时响应，再根据“请求是否已经 sent”区分两种文本：

- `Sending request timeout in client-side`  
- `Waiting server-side response timeout`

`DefaultFuture.java:260` — timeout response -> exception
`DefaultFuture.java:294` — client-side / server-side timeout 文本

### 6.3 最终异常码却是同一个

尽管 timeout 来源不同，`DubboInvoker` 最终都会把 remoting `TimeoutException` 映射成 `RpcException.TIMEOUT_EXCEPTION`。

`DubboInvoker.java:146` — timeout -> `RpcException.TIMEOUT_EXCEPTION`

所以最终看到同一个异常码，并不表示来源相同。你必须继续看 timeout message，才能知道是：

- consumer 发送阶段卡住了  
- 还是 provider 迟迟没回

### 6.4 late response：provider 可能已经做完，只是回来晚了

`DefaultFuture` 还专门记录了一个很容易被忽略的事实：超时之后，response 可能“终于回来了”。它会记录一条 warning，提醒这次 response 返回晚了。

`DefaultFuture.java:212` — late response warning

这类情况在生产上很关键：consumer 报 timeout，不代表 provider 没执行。它有可能执行了，而且已经执行完了，只是结果回来得太晚。

## 七、Cluster 语义层：为什么同一次调用会被放大成完全不同的形态

这里先做一个路标。前面讲的是“还有谁可打”和“timeout 从哪里来”，这一节讲的是“当一次尝试失败后，Dubbo 是否会继续打别台、并发打多台，或干脆全量广播”。这不是 loadbalance 的职责，而是 cluster 语义的职责。

### 7.1 Failover：动态视图上的重试

`FailoverClusterInvoker` 会按 `retries + 1` 计算总尝试次数。每次失败后，不是直接在旧列表里换下一台，而是重新 `list(invocation)`。

`FailoverClusterInvoker.java:68` — failover retry loop
`FailoverClusterInvoker.java:71` — retry 前重新 list
`FailoverClusterInvoker.java:129` — `retries + 1`

而且业务异常（`e.isBiz()`）不会被重试，会直接抛出。

`FailoverClusterInvoker.java:104` — business exception 不重试

所以 failover 最大的生产特征是：**同一个逻辑调用，可能连续打到多台 provider，而且每一轮看到的候选集不一定一样。**

### 7.2 Failfast：一枪定输赢

`FailfastClusterInvoker` 的语义最简单：选一次，打一枪，失败就抛。

`FailfastClusterInvoker.java:46` — failfast single shot

这类策略不会放大流量，但也不会替你掩盖任何单点故障。

### 7.3 Forking：同一次调用并发打多台

`ForkingClusterInvoker` 会选择 `forks` 台 provider 并发发起请求，谁先成功谁赢。

这里要给生产读者一个很重要的提醒：**一次业务调用打到多台 provider，不一定是重复提交 bug，也可能只是 cluster 策略本身就在并发放大。** 如果不先确认当前 cluster 模式，很多 forking/broadcast 场景会被误诊成“业务重复调用”或“网络重试失控”。

`ForkingClusterInvoker.java:76` — forks selection
`ForkingClusterInvoker.java:115` — first success / timeout wait

这意味着一次用户调用可能在后端同时制造多份压力。线上如果看到“同一个请求为什么打到了多台 provider”，先别怀疑网络重试，很可能只是 cluster 策略本身就是 forking。

### 7.4 Broadcast：所有 provider 都要打一遍

`BroadcastClusterInvoker` 会顺序调用所有 invokers，默认即使前面失败也会继续打，最后再决定是否抛错。

`BroadcastClusterInvoker.java:64` — fail percent
`BroadcastClusterInvoker.java:76` — call all invokers

所以 broadcast 的失败形态往往最“拖”：你看到的最终异常，可能已经是在所有 provider 都试过之后才统一抛出的。

## 八、为什么不改代码，失败形态也会变

### 8.1 router 变化会直接改候选集

`Directory.list()` 之前，router 规则先把候选集裁剪掉一部分。这意味着相同的业务调用，在路由规则变更后，可能进入一个完全不同的候选集。

结果就是：

- 以前会成功的调用，可能突然 no provider  
- 以前会 failover 到 B，可能现在因为路由只剩 A 而直接失败

### 8.2 configurator 变化会直接改 timeout / retries / loadbalance

configurator 不需要改 provider 地址，就能改变：

- timeout  
- retries  
- forks  
- loadbalance  
- 其他 URL 参数

所以同一个方法，同一批 provider，今天看起来像 failfast，明天可能就像 failover 放大；今天是 1 秒超时，明天是 200ms 立刻 timeout。原因不一定是业务或网络，而是治理平面把 URL 语义改了。

### 8.3 registry 更新会放大 failover 的不确定性

因为 `FailoverClusterInvoker` 每轮失败前都会重新 `list()`，所以 registry 变化会直接影响重试路径。第一轮可能打到 A，第二轮因为注册中心更新，候选集已经换了，第三轮甚至可能看到 completely different provider set。

这也是为什么很多生产问题看起来“同一个调用的失败轨迹不稳定”——控制面在你重试期间也在变。

## 九、误解澄清

### 误解一：timeout 就一定是 provider 慢

不是。先看 timeout 文本：是 `Sending request timeout in client-side`，还是 `Waiting server-side response timeout`。两者含义不同。

### 误解二：`NO_INVOKER_AVAILABLE_AFTER_FILTER` 就是 registry 没地址

不是。router 也可能把候选集裁空。

### 误解三：failover 只是静态换一台重试

不是。它每轮都会重新 `list()`，拿的是动态视图。

### 误解四：不改地址就不会改失败形态

不是。router 和 configurator 都能在地址不变时改变 runtime 行为。

### 误解五：一次业务调用只会落到一台 provider

不一定。forking 和 broadcast 天然会让一次调用打到多台甚至全部 provider。

### 误解六：provider 日志里看到执行成功，就说明 timeout 一定不是 provider 侧问题

也不对。late response 场景下，provider 完全可能已经成功执行，只是响应回到 consumer 太晚，最终仍然在 consumer 侧表现成 timeout。所以“provider 成功了”只能说明它做完了业务，不等于 consumer 端的等待窗口没有超时。

## 十、收网总结：排障要先分层，再看异常

回到开头的问题：为什么 Dubbo 里同样一个失败，看起来完全不像一回事？

因为最终异常只是三层共同作用后的结果：

- 候选集层决定“现在还有谁可打”  
- Cluster 语义层决定“失败后还要怎么打”  
- Remoting timeout 层决定“这个 timeout 到底发生在什么时候”  

真正有用的排障顺序应该是：

1. 先问：当前 routed candidates 是多少，是否已经被裁空？  
2. 再问：这次 cluster 策略是什么，会不会放大一次调用？  
3. 最后问：timeout 文本到底指向 consumer-side 还是 server-side？  

**三句话总结：**

1. Dubbo 的失败不能只看最终异常码，要分开看候选集、cluster 语义和 remoting timeout。  
2. failover、failfast、forking、broadcast 不是“不同名字的重试”，而是完全不同的失败放大模型。  
3. registry、router、configurator 变化即使不改业务代码，也足以让同一个调用呈现出完全不同的失败形态。  

**下篇建议：** 如果继续生产诊断层，可以接 `registry / config / metadata 失配问题分析`，把控制面与运行时错位的线上现象再单独打透。