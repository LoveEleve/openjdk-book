# Dubbo：Dispatcher、线程池与 provider 假死问题

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：为什么 provider 明明活着，却越来越像死了

线上最难排查的一类 Dubbo provider 问题，不是进程直接挂掉，而是“看起来还活着，但越来越像死了”。

端口还通，TCP 连接还能建立，甚至 heartbeat 也还在正常往返，但请求开始越来越慢；再往后，某些请求超时，某些请求被拒绝，最后 consumer 侧看起来像网络不稳、像 provider 间歇性失联，甚至像调用被重复打到了多台 provider。

这类现象的麻烦之处在于：如果只看最外层症状，你很容易把问题归咎于网络、注册中心或 consumer 重试。但真正决定 provider 是否“半死”的，往往是 provider 自己执行面的一条链：

```text
Netty IO thread -> dispatcher -> business executor -> exchange/protocol handler -> invoker
```

这条链上任何一层挤压、阻塞、拒绝，最终都可能在 consumer 侧表现成 timeout、线程池耗尽，甚至像网络故障一样的断连/重连。

## 二、前情回顾：前面几篇讲了调用如何上网，这一篇讲 provider 收到请求之后怎么卡死

在 remoting 篇里，我们已经看过 consumer 如何把 `Invocation` 变成 `Request`，provider 如何从网络字节恢复 `Request`、进入 `HeaderExchangeHandler`、再进入 `DubboProtocol.requestHandler.reply()` 和 `invoker.invoke()`。

在生产诊断第一篇里，我们也已经知道 consumer 看到的 timeout/retry/failover 等现象，不能只看异常码，要拆成候选集层、cluster 语义层和 remoting timeout 层。

这一篇继续往里走一步：不再问 consumer 为什么看到 timeout，而是问 **provider 侧到底在哪一层慢了、卡了、拒绝了，最后又是怎样被映射成 consumer 看到的 timeout 或网络样症状的。**

也就是说，这篇不是新增一条主线，而是把前面已经建立的 remoting/cluster 主线重新投影到 provider 执行面上来看。

## 三、先走三条失败的路

### 失败方案一：端口还通、进程还活着，就说明 provider 没问题

这只能说明 transport 层还在，不说明业务执行链还健康。

provider 完全可能还在正常 accept 连接、正常收包、正常收发 heartbeat，但 dispatcher 后面的业务线程池已经排队严重，或者某个模式下 IO 线程本身就被慢业务卡住了。此时进程“活着”，但业务语义上已经接近假死。

### 失败方案二：dispatcher 只是线程池参数的别名

如果这样理解，就会把两个完全不同的层次混成一个：

- dispatcher 决定“哪些事件切线程”  
- threadpool 决定“切过去之后怎么排队、怎么拒绝”  

所以同样是慢，根因可能在 dispatcher 策略，也可能在业务线程池和队列。

### 失败方案三：一次调用打到多台 provider，一定是重复提交 bug

这在 provider 假死场景里特别容易误判。consumer 侧 failover、forking、broadcast 都会天然放大请求数量；provider 变慢后，这种放大会更明显。

所以“同一次业务动作在多台 provider 上留下痕迹”不一定是业务重复提交，也可能只是 cluster 策略遇到了 provider 假死后的正常表现。

## 四、最小总图：provider 执行链的四道边界

```text
Netty worker event loop
    ↓
NettyServerHandler.channelRead()
    ↓
ChannelHandlers.wrap() 产出的 dispatcher 链
    ↓
(可能切到 business executor)
    ↓
DecodeHandler / HeaderExchangeHandler
    ↓
DubboProtocol.requestHandler.reply()
    ↓
Exporter -> Invoker.invoke()
    ↓
业务实现
```

要排 provider 假死，不要先问“是不是网络”，而要先问下面四个问题：

1. **当前 request 还在 IO 线程，还是已经切到业务 executor？**  
2. **如果切到了线程池，是在排队、被拒绝，还是已经执行中？**  
3. **如果没切线程，是不是 direct 模式把慢业务压在了 IO 线程上？**  
4. **最终 consumer 看到的是 timeout、线程池耗尽，还是像网络故障？**

这里要补一句路标：这四层更像 provider 假死的四个观察点，不是每次请求都必须“完整地经过四个相同分叉步骤”的机械流水线。不同 dispatcher 模式会让链条在不同位置切开、改道或者停住。

## 五、Dispatcher：决定事件在哪个线程执行

### 5.1 dispatcher 不等于线程池

`ChannelHandlers.wrap()` 会把底层 handler 包成：

```text
MultiMessageHandler -> HeartbeatHandler -> Dispatcher.dispatch(handler, url)
```

`ChannelHandlers.java:43` — dispatcher wrapper chain

也就是说，dispatcher 是一层“事件路由器”，它决定收到 request/response/connect/disconnect/exception 之后，是否要切到业务 executor 去执行。

### 5.2 `all`：什么都切到业务池

`all` 模式下，连接、断开、消息、异常，都会包装成 `ChannelEventRunnable` 投递给线程池。

`AllChannelHandler.java:39` — all dispatcher 逻辑

这种模式对业务隔离友好，但如果业务池或队列积压，连接事件本身也可能排队。

### 5.3 `execution`：只把 request 切出去

`execution` 是 provider 侧最有代表性的模式：

- request 交给业务线程池  
- response / connect / disconnect / heartbeat 等仍留在当前线程

`ExecutionChannelHandler.java:33` — 模式语义注释
`ExecutionChannelHandler.java:43` — request 提交 executor

所以它常见的症状是：网络看起来还活着，但业务请求越来越慢，因为真正堵的是 request 执行面。

### 5.4 `direct`：业务直接压在 IO 线程上

`direct` 模式几乎不切线程，业务逻辑直接在当前线程执行。provider 侧如果用了这种模式，慢业务会直接拖住 Netty worker event loop。

`DirectChannelHandler.java:38` — direct 模式

为什么它这么容易被误诊成网络故障？因为被堵住的不只是业务执行，而是负责收包、发包、心跳和连接事件传播的 IO 线程本身。于是 consumer 侧看到的现象就不再像“线程池慢”，而更像“网络突然抖了”：收包慢、回包慢、心跳延迟，甚至连接断开。

### 5.5 `message` 与 `connection`

- `message`：只把消息收取切到线程池，连接事件不切  
- `connection`：连接/断开事件有自己独立的单线程队列，普通请求仍然走业务池

这两种模式在极端连接风暴或心跳异常场景下会表现出不同症状，但对生产定位来说，最关键的仍然是：**你的 request 到底有没有离开 IO 线程。**

## 六、ThreadPool：排队和拒绝的真正发生地

### 6.1 provider 线程池是按端口共享的

`AbstractServer` 打开 server 后会通过 `ExecutorRepository` 创建 provider 业务线程池。默认仓库下，provider executor 的 key 是端口，这意味着同一端口上的多个服务共享一个业务池。

`DefaultExecutorRepository.java:159` — provider executor keyed by port

这条设计对线上诊断特别关键，而且必须当成一个钉子记住：**一个热点接口或慢接口，完全可能把同端口的其他 Dubbo 服务一起拖慢。** 所以你看到某个接口没问题、另一个接口慢，不要急着按“服务粒度”排查，先确认它们是不是其实在抢同一条端口级业务线程池。

### 6.2 队列形态决定症状是“立刻爆”还是“慢慢排”

以默认 `fixed` 线程池为例：

- `queues = 0` 用 `SynchronousQueue`，更容易快速拒绝  
- `queues > 0` 用有界 `LinkedBlockingQueue`，更容易长时间排队后 timeout  
- `queues < 0` 用近似无界安全队列，更容易把问题拖成“越来越慢”

`FixedThreadPool.java:55` — fixed pool 构造

所以同样是 provider 压力高，不同队列策略会产生完全不同的现场：

- 立刻报 `SERVER_THREADPOOL_EXHAUSTED_ERROR`  
- 长时间堆积后 consumer timeout  
- 进程活着但 p99 一路恶化

### 6.3 threadpool 耗尽怎样被显式暴露

默认拒绝策略是 `AbortPolicyWithReport`。线程池耗尽时，它会打印一条非常明确的 `Thread pool is EXHAUSTED!` 日志，再抛 `RejectedExecutionException`。

`AbortPolicyWithReport.java:100` — rejection logging / exception

这条日志是线上排障很重要的硬证据：它说明 provider 并不是“神秘地慢了”，而是业务执行资源已经打满。

## 七、provider 侧拒绝 / 堵塞，consumer 最终会看到什么

### 7.1 最理想情况：返回明确的线程池耗尽错误

如果 dispatcher 在 request 投递阶段抓到了 `RejectedExecutionException`，`WrappedChannelHandler.sendFeedback()` 会回一个 `Response.SERVER_THREADPOOL_EXHAUSTED_ERROR(100)` 给 consumer。

`WrappedChannelHandler.java:82` — exhausted feedback
`Response.java:78` — status 100

这种情况下，consumer 端看到的就是明确拒绝，排障相对容易。

### 7.2 更麻烦的情况：consumer 只看到 timeout

并不是所有 dispatcher 模式都能保证把 `SERVER_THREADPOOL_EXHAUSTED_ERROR` 成功回给 consumer。`execution` 模式下，源码自己就明确承认：线程池满时，这个错误码未必能及时送达，consumer 可能最后还是只看到 timeout。

`ExecutionChannelHandler.java:50` — 线程池耗尽时反馈未必可靠

这就是线上最让人困惑的场景：provider 其实是线程池满了，但 consumer 看起来像“provider 慢”或“网络超时”。

### 7.3 direct 模式更像网络故障

如果 provider 使用 `direct`，慢业务直接堵在 IO 线程上。此时不仅请求慢，连连接事件和心跳处理都可能被拖住。

于是 consumer 侧可能看到：

- timeout  
- channel inactive  
- 断连重连  
- 心跳异常

但根因并不是 transport 先坏，而是 provider 执行面把 transport 拖垮了。

## 八、one-way、heartbeat 与“假死”误判

### 8.1 one-way 不是“不重要”

one-way 请求虽然不期待 response，但仍然要经过 dispatcher 和 provider 业务执行面。如果业务池堵了，one-way 同样会堆积，只是 caller 更晚感知。

### 8.2 heartbeat 也会被执行链影响

provider 的 idle/heartbeat 事件最终还是要在这套 transport + dispatcher 模型里走。如果 direct 模式把 IO 线程拖住，consumer 侧就会误以为“网络不稳定”或“provider 掉线”。

`NettyServerHandler.java:128` — idle close

## 九、误解澄清

### 误解一：端口还通，provider 就没问题

不是。端口活着只说明 transport 活着，不说明业务执行链还健康。

### 误解二：dispatcher 就是线程池类型

不是。dispatcher 决定事件在哪个线程执行，threadpool 决定切过去之后怎么排队和拒绝。

### 误解三：consumer 看到 timeout，就一定是 provider 业务慢

不一定。也可能是 provider 线程池堆积、direct 模式堵住 IO，甚至明确拒绝没及时返回，最终被 consumer 看成 timeout。

### 误解四：一次调用打到多台 provider，一定是重复提交 bug

不一定。failover / forking / broadcast 本来就会放大一次调用，provider 假死只会把这种现象放得更明显。

### 误解五：provider 返回 `SERVER_THREADPOOL_EXHAUSTED_ERROR` 就一定总能被 consumer 看到

也不是。某些模式下，consumer 最终仍可能只看到 timeout。

### 误解六：consumer 看到 timeout，就说明 provider 没收到请求

不对。provider 完全可能已经收到请求、排进业务线程池、甚至已经执行业务成功，只是 response 回晚了，或者线程池拒绝没有成功反馈回去，最终仍在 consumer 侧表现成 timeout。看到 timeout 只能说明“在 consumer 的等待窗口内没拿到结果”，不能直接推出“provider 根本没处理”。

## 十、收网总结：provider 假死要沿执行链逐层排

回到开头的问题：为什么 provider 明明活着，却越来越像死了？

因为 Dubbo provider 侧真正决定症状的，不是“进程活没活”，而是这条执行链：

- IO 线程有没有被堵  
- dispatcher 有没有把 request 正确切出去  
- 业务线程池有没有排队/拒绝  
- exchange/protocol 层有没有把拒绝或异常明确反馈给 consumer  

真正有用的排障顺序可以压成四问：

1. **当前 request 还在 IO 线程，还是已经切到业务 executor？**  
2. **如果切出去了，是在排队、被拒绝，还是执行中？**  
3. **当前 dispatcher 模式是什么？** 是 `all`、`execution`、`direct`、`message` 还是 `connection`？  
4. **consumer 看到的是明确拒绝，还是 timeout / network-like symptom？**  

**三句话总结：**

1. Dubbo provider “假死”常常不是进程死了，而是 dispatcher 和业务线程池把请求卡在执行链中间。  
2. `all` / `execution` / `direct` 三种模式，会把同一个慢业务放大成完全不同的线上症状。  
3. 生产排障时，不要只盯着 timeout，要先沿着 `IO -> dispatcher -> executor -> protocol handler -> invoker` 这条链去找卡点。  

**下篇建议：** 如果继续 Dubbo 生产诊断层，可以进入 `ScopeModel / Config / Registry / Runtime state` 的整卷总收束篇，或者进入 Dubbo 生态与插件层。