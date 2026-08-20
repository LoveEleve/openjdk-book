# 为什么一个 `stub.method(request)` 最后会变成一次远程调用：gRPC-Java 的 Stub、Channel 与 ClientCall 主线

> 本文基于 `grpc-java v1.83.1` 当前源码。本文只讲客户端 unary 调用的最短闭环：一个看起来像本地 Java 方法的 `stub.method(request)`，为什么最后会变成一次真正的远程 RPC。重点放在 `AbstractStub`、`ClientCalls`、`ManagedChannel`、`ClientCall`、`ClientCallImpl` 这几层如何接力；只把 transport 当作出口桥接，不重讲 Netty HTTP/2、NameResolver、LoadBalancer、Context、Deadline、服务端主线和四种流式调用全景。

## 为什么一句 `stub.method(request)` 不能只用“这是动态代理”打发掉

很多人第一次接触 gRPC 客户端时，都会很自然地把它理解成一种“远程代理”：

- 本地写的是方法调用
- 背后帮你转成网络请求
- 所以它本质上就是代理

这句话不能说完全错，但问题在于，它只解释了“外观看起来为什么像本地方法”，却几乎没有解释运行时真正发生了什么。

因为只要你把问题问得再具体一点，这个说法立刻就会失效。

比如：

- deadline 到底挂在哪里？
- 调用的压缩、authority、wait-for-ready 这些选项存在哪里？
- 为什么同步阻塞、future、异步回调三种写法，最后还能落到同一套底层调用线上？
- 拦截器是插在 stub 前面，还是 `ClientCall` 上？
- 真正的远程调用对象是在生成 stub 的那一刻创建的，还是在方法真正开始时才创建？
- gRPC 到底是在什么时候从“方法长得像 Java”切到“调用已经进入 transport 世界”这条线上去的？

只要这些问题答不上来，“这是一个代理”就只是标签，不是解释。

更关键的是，gRPC 客户端这里最值得建立的，不是“它模仿了本地方法调用”这层表面印象，而是它内部其实有一条非常稳定的运行时主线：

```text
Stub
  -> ClientCalls
  -> ManagedChannel.newCall()
  -> ClientCall.start()
  -> ClientStream / ClientTransport
```

这条链一旦立住，后面你再看：

- 为什么有 blocking stub、future stub、async stub
- 为什么 `withDeadlineAfter()`、`withWaitForReady()` 这些配置不会修改原对象
- 为什么后面的拦截器、Context、Deadline、NameResolver、LoadBalancer 都能插进来
- 为什么最后还能平顺地接到 Netty HTTP/2 transport

整个客户端运行时就不再是“黑盒代理”，而是一条层层收束、层层降落的调用主线。

所以本文真正要回答的问题不是“gRPC 是不是代理”，而是：

**为什么一个看起来像本地 Java 方法的 `stub.method(request)`，最后会被一步步压缩成一次真正的远程调用。**

## 先看失败方案：为什么这件事不能粗暴地讲

### 失败方案一：只讲生成代码和动态代理外观

这是最常见、也最容易误导人的讲法。

因为对使用者来说，最容易看到的确实就是这一层：

- 先有 `.proto`
- 再生成一个 `*Grpc`
- 然后拿到某种 stub
- 最后调用 `stub.xxx(request)`

于是就很容易把整个故事压缩成一句：

- “生成器帮你造了一个代理对象，调它的方法就行。”

问题在于，这种讲法只解释了语法入口，解释不了运行时骨架。

它答不出几个关键问题：

- `Stub` 自己到底持有什么状态？
- 为什么配置一个 deadline 不会把原 stub 改坏？
- blocking、future、async 三种表面 API 为什么最后能共用同一条底层通路？
- 真正和 transport 接壤的那层统一抽象是什么？

如果这些都不讲，读者脑子里剩下的就只有一个极其模糊的印象：

- “gRPC 大概会帮我把方法发出去。”

可一旦进入源码，这句话几乎没有导航价值。

### 失败方案二：直接从 transport 或 HTTP/2 讲起

另一种常见误区，是反过来直接扎到底层。

比如一开口就讲：

- 最后要走到 HTTP/2
- 要写 headers 和 data frame
- 要创建 stream
- 要经过 `ClientTransport.newStream()`

这些事实当然也都对，而且前面的 Netty HTTP/2 篇章已经把这条下游链讲得很清楚了。但如果我们此刻的问题是：

- “本地方法调用是怎样变成远程调用的？”

那一上来就钻到 transport，会直接跳过客户端运行时里最关键的那一段桥：

- `Stub` 怎么保存调用上下文
- `ClientCalls` 怎么把不同调用风格标准化
- `ManagedChannel` 在哪里接管调用
- `ClientCallImpl.start()` 在哪一刻让“调用描述”真正开始落地

如果这一段桥没立住，读者最后只会得到一种断裂感：

- 上面是 Java 方法
- 下面是 HTTP/2 stream
- 中间是黑箱

而本文要做的，恰恰就是把这段黑箱拆开。

### 失败方案三：把 blocking、future、async 理解成“只是返回值形式不同”

表面上看，这个说法也很合理：

- blocking 就是同步拿结果
- future 就是拿个 `ListenableFuture`
- async 就是给个 `StreamObserver`

好像不过是“返回值样式变了”。

但运行时上，它们并不是简单地改个返回类型。

因为它们需要解决的是三种不同的收束方式：

- blocking 需要一边等待结果，一边还能把回调任务排空，不然线程会卡死在等待里
- future 需要把 `ClientCall.Listener` 上的事件压缩成一个 future 的成功、失败或取消
- async 则需要把 listener 事件重新翻译成 `onNext / onError / onCompleted` 这套 observer 语义

也就是说，表面 API 虽然不同，但它们必须被重新压到同一条更底层的语义线上去。

那条线不是“不同方法返回不同类型”，而是：

- 最终都要变成一次 `ClientCall`

这也是 `ClientCalls` 这一层真正存在的原因。

### 失败方案四：第一篇把服务发现、负载均衡、服务端和流式全吞进来

还有一种更隐蔽的问题，不是知识点错了，而是边界错了。

`ManagedChannel` 当然不只是一个薄薄的“创建调用”对象。它后面连着：

- name resolution
- load balancing
- pending call
- retry / hedging
- delayed transport

整个客户端运行时世界。

同样，gRPC 当然也不只有 unary。后面还有：

- server streaming
- client streaming
- bidi streaming
- 服务端 `ServerCall`
- 上下文传播
- deadline 取消

可如果第一篇一口气把这些全吃进去，最短闭环就没了，整篇文章会重新退化成“仓库总览”。

所以这一篇必须强行收边界：

- 我们只立客户端 unary 的最短闭环
- 只抓 `Stub -> ClientCalls -> ManagedChannel -> ClientCallImpl -> ClientTransport`
- 只把 transport 当作出口
- 其他内容一律后移

你可以把这理解成：第一篇不是为了把 gRPC 讲完，而是为了先把 **RPC 客户端调用运行时的最小心智图** 立住。

## 先立最小总图：一个本地方法调用是怎样一步步被压缩的

如果先不抠任何细节，gRPC 客户端 unary 调用最值得先记住的，不是类名，而是角色顺序。

最小总图可以先压缩成下面这样：

```text
用户代码
  -> 某个具体 Stub 方法
  -> Stub 持有的 Channel + CallOptions
  -> ClientCalls 选择调用范式
  -> ManagedChannel.newCall()
  -> ClientCallImpl.start()
  -> ClientStreamProvider.newStream()
  -> ClientTransport.newStream()
```

如果换成人话，这条线其实只发生了五件事。

第一，**本地方法外观要先被还原成“我要调哪一个远程方法，用什么调用选项调”**。

第二，**不同表面调用风格要被压成同一套底层调用模型**。不管你是同步等结果，还是拿 future，还是走回调，底层都不能各搞一套完全不同的 transport 调用方式。

第三，**客户端运行时总入口要接管这次调用**。也就是把“我要调一个 RPC”正式交给 channel 世界，而不是停留在 stub 这一层。

第四，**统一调用对象要开始真正落地**。headers、compressor、deadline、listener、stream 都要在这里就位。

第五，**调用从这里起不再只是一个 Java 方法描述，而是真的开始向 transport 世界下沉**。

所以本篇后面虽然会反复提到 `AbstractStub`、`ClientCalls`、`ManagedChannel`、`ClientCallImpl` 这些类，但请先记住：

- 它们不是并列知识点
- 它们是在一条收束链上接力

也就是说，gRPC 客户端并不是“一个 stub 直接发请求”，而是：

- stub 保存入口上下文
- `ClientCalls` 统一调用范式
- channel 创建统一调用对象
- `ClientCallImpl` 让调用正式开始
- transport 接走流

先有这张图，后面再落代码，读者才不会迷路。

## 第一层：`Stub` 为什么几乎不发 RPC，却必须站在最前面

如果只从名字看，很多人会误以为 `Stub` 就是“真正负责发请求的对象”。

但源码往前一看，会发现 `AbstractStub` 做的事情其实非常克制。

它最核心的状态只有两个：

- `channel`
- `callOptions`

证据：`stub/src/main/java/io/grpc/stub/AbstractStub.java:55`

这已经很能说明问题了。`Stub` 的第一职责，不是自己实现一大堆 RPC 逻辑，而是作为一个稳定入口，把这次调用最关键的两类上下文抱在身上：

- 这次调用最终要交给哪个 `Channel`
- 这次调用应该携带哪些 `CallOptions`

这也是为什么类注释一上来就强调：stub 的配置是不可变的，修改配置会返回一个新的 stub，而且这种改动应该足够便宜，见 `stub/src/main/java/io/grpc/stub/AbstractStub.java:38`。

这条约束很重要。

因为对一个 RPC 客户端入口来说，最危险的事情之一，就是把运行时配置做成“会原地变”的共享对象。那样一来：

- 一个线程改了 deadline
- 另一个线程正在发调用
- 第三个线程又改了 executor

你很快就会得到一堆互相污染的调用状态。

所以 gRPC 的做法非常明确：

- `Stub` 自己是线程安全的
- 配置不原地修改
- 每次 `withXxx()` 都返回一个基于原 `channel + callOptions` 重建的新 stub

比如：

- `withDeadline(...)` 通过 `build(channel, callOptions.withDeadline(...))` 生成新对象，见 `stub/src/main/java/io/grpc/stub/AbstractStub.java:141`
- `withInterceptors(...)` 通过包一层新 channel 再 `build(...)`，见 `stub/src/main/java/io/grpc/stub/AbstractStub.java:215`

这就说明，`Stub` 的核心价值不是“自己发调用”，而是：

- 把一组调用上下文稳定、便宜、不可变地封装起来

你可以把它理解成客户端运行时的入口壳。

这个入口壳里最重要的不是业务逻辑，而是边界控制。

### `build(...)` 说明 Stub 不是具体类集合，而是一种入口协议

`AbstractStub` 里还有一个很关键的方法：

- `protected abstract S build(Channel channel, CallOptions callOptions)`

证据：`stub/src/main/java/io/grpc/stub/AbstractStub.java:105`

这说明 gRPC 对 stub 的定义，并不是“某个具体实现类长什么样”，而是：

- 只要你是一个 stub，你就必须能够在新的 `Channel + CallOptions` 上重建自己

这件事看起来很朴素，但它其实决定了整个调用入口的形状。

因为它意味着，后面所有这些行为：

- `withDeadlineAfter()`
- `withWaitForReady()`
- `withExecutor()`
- `withCompression()`
- `withInterceptors()`

本质上都不需要改写调用逻辑本身。它们只需要做一件事：

- 重新组合 `Channel + CallOptions`
- 然后再 `build(...)` 出一个同类型的新 stub

于是，stub 层可以一直保持很薄。

它不需要知道怎么建 stream，不需要知道怎么做 flow control，也不需要知道 transport 的细节。它只需要牢牢守住一点：

- 入口配置怎么组织

这就是为什么说 `Stub` 虽然几乎不发 RPC，却必须站在最前面。

因为没有这一层，你后面所有关于调用选项、调用风格和线程安全的组织都会立刻散掉。

### 三种 StubType 说明“不同表面风格”从一开始就被标记了

gRPC 里还有一个很容易被忽视、但对理解调用主线很重要的设计：

- blocking stub
- async stub
- future stub

并不是纯粹靠“生成了不同名字的类”来区分的。

在 `AbstractBlockingStub.newStub(...)` 里，构造 stub 时会把 `ClientCalls.STUB_TYPE_OPTION` 写成 `BLOCKING`，见 `stub/src/main/java/io/grpc/stub/AbstractBlockingStub.java:62`。

`AbstractAsyncStub` 和 `AbstractFutureStub` 也做了同样的事，分别写成 `ASYNC` 和 `FUTURE`，见：

- `stub/src/main/java/io/grpc/stub/AbstractAsyncStub.java:61`
- `stub/src/main/java/io/grpc/stub/AbstractFutureStub.java:62`

这说明什么？

说明从入口层开始，gRPC 就已经在给调用打标签：

- 这不是一个“抽象上完全一样、只是最后返回值不同”的调用
- 它从 stub 入口开始，就知道自己属于哪种调用风格

当然，这不意味着底层要走三条完全不同的 transport 主线。相反，它恰恰意味着：

- 不同风格可以先被标记
- 再在下游被重新压回同一套 `ClientCall` 模型

这也是后面 `ClientCalls` 能成立的前提之一。

### 测试怎么证明 Stub 层的职责确实是“入口配置”

测试也把这件事钉得很死。

`BaseAbstractStubTest` 并没有去测什么 transport 细节，而是在反复验证：

- channel 不能为空
- call options 不能为空
- `withWaitForReady()` 会返回带新选项的 stub
- `withExecutor()` 会把 executor 写进新的 call options

见：`stub/src/test/java/io/grpc/stub/BaseAbstractStubTest.java:71`

`AbstractStubTest` 还专门验证了：默认的普通 stub 不会自动带 `STUB_TYPE_OPTION`，见 `stub/src/test/java/io/grpc/stub/AbstractStubTest.java:45`。

这很关键。它说明 gRPC 对 stub 层的测试重点根本不是“能不能发出去”，而是：

- 它是不是一个正确的入口容器
- 它是不是在稳定地组织 `Channel + CallOptions`

所以到这里，我们已经可以先收一个小结论：

- `Stub` 的主要职责不是执行远程调用
- 它的主要职责是把“这次调用交给谁、带着什么配置去交”稳定地保存下来

真正把这次调用进一步压缩成统一运行时动作的，是下一层：`ClientCalls`。

## 第二层：`ClientCalls` 为什么不是工具类边角料，而是调用范式统一器

如果第一次扫源码，很多人看到 `ClientCalls` 时容易掉以轻心。

因为它的名字和位置看起来都很像“方便用户调用的一组工具方法”。

但类注释其实已经把它说得很清楚：

- 这里的工具方法，与生成 stub 类中可能出现的调用签名是一一对应的
- 这样运行时就可以改变行为，而不要求重新生成 stub

证据：`stub/src/main/java/io/grpc/stub/ClientCalls.java:58`

这句话的信息量很大。

它说明 `ClientCalls` 并不是一层无关紧要的包装，而是一个非常明确的运行时桥：

- 上游是生成代码暴露给用户的多种调用外观
- 下游是统一的客户端调用模型

它站在中间，负责把“不同看上去很不一样的调用方式”，压成同一条更稳定的运行时线。

### blocking unary：不是直接等结果，而是先把调用压成 future 再收口

先看最简单、也是本文主线最关心的 blocking unary。

`blockingUnaryCall(ClientCall, req)` 的实现非常短：

- 它不是自己去 start、sendMessage、halfClose
- 而是先调用 `futureUnaryCall(call, req)`
- 再 `getUnchecked(...)` 把结果取回来

见：`stub/src/main/java/io/grpc/stub/ClientCalls.java:140`

这一步已经很说明设计取向了。

gRPC 没有为 blocking unary 单独再造一套底层调用协议，而是先把它统一压成 future 语义，再在最外层做同步等待。

也就是说，blocking 不是底层模型，只是上层收束方式。

真正更值得注意的是另一个重载：

- `blockingUnaryCall(Channel, MethodDescriptor, CallOptions, ReqT)`

它会：

1. 创建一个 `ThreadlessExecutor`
2. 把 `STUB_TYPE_OPTION` 设成 `BLOCKING`
3. 再把这个 executor 写进 call options
4. 然后用 `channel.newCall(...)` 创建 `ClientCall`
5. 接着走 `futureUnaryCall(call, req)`
6. 最后在 while 循环里一边等 future，一边 `waitAndDrain()` 执行器上的任务

见：`stub/src/main/java/io/grpc/stub/ClientCalls.java:155`

这段逻辑非常关键，因为它直接打破了一个常见错觉：

- blocking 并不是“线程堵住不动，等网络层自己把结果塞回来”

恰恰相反，它是在做一件更精细的事：

- 当前线程虽然在等待结果
- 但它还要帮忙排空回调执行器上的任务
- 否则 listener 事件可能永远没有机会被处理，future 也就永远不会完成

所以 blocking unary 的本质，不是“直接同步发 RPC”，而是：

- 先走统一的异步/监听模型
- 再用一种可控的方式在外层做同步等待

这就解释了为什么 `ThreadlessExecutor` 会成为 blocking 语义的重要组成部分。

### future unary：把 listener 事件收束为 `GrpcFuture`

再往下一层看，`futureUnaryCall(...)` 又做了什么。

它会创建一个 `GrpcFuture`，然后调用：

- `asyncUnaryRequestCall(call, req, new UnaryStreamToFuture<>(responseFuture))`

见：`stub/src/main/java/io/grpc/stub/ClientCalls.java:321`

这里的关键点是：future 并不是一种完全独立的调用路径，它只是把 response listener 换成了 `UnaryStreamToFuture` 这个适配器。

这个适配器会：

- 在 `onMessage()` 时接收响应值
- 在 `onClose()` 时把 OK / error 收束成 future 的完成或异常
- 在 `onStart()` 时先 `request(2)`，保证 unary 语义下既能拿到正常响应，也能抓到服务端多发一条消息这种违规行为

见：`stub/src/main/java/io/grpc/stub/ClientCalls.java:603`

所以 future unary 的本质仍然不是“future 自己会发请求”，而是：

- 统一调用动作还是那套调用动作
- 只不过 listener 事件被适配成了 future 世界能理解的完成模型

### async unary：把 listener 事件再翻译成 `StreamObserver`

async unary 则是第三种收束方式。

`asyncUnaryCall(...)` 本身会继续走：

- `asyncUnaryRequestCall(...)`

见：`stub/src/main/java/io/grpc/stub/ClientCalls.java:81`

而这个过程里，真正承担桥接作用的是：

- `StreamObserverToCallListenerAdapter`
- `CallToStreamObserverAdapter`

前者把 `ClientCall.Listener` 的回调事件翻译成 `StreamObserver` 的 `onNext / onError / onCompleted`；后者则把请求侧的 observer 操作，再翻译回 `ClientCall` 的 `sendMessage / halfClose / cancel / request`。

见：

- `stub/src/main/java/io/grpc/stub/ClientCalls.java:443`
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:535`

这说明 async 风格也没有偏离主线。它只是在 listener 和 observer 之间插了一个翻译层。

### `startCall()` 才暴露了 `ClientCalls` 最本质的工作

把这些分支都看完后，`ClientCalls` 真正最值得记住的反而不是某个 public API，而是内部那条很朴素的主线：

- `call.start(responseListener, new Metadata())`
- `responseListener.onStart()`

见：`stub/src/main/java/io/grpc/stub/ClientCalls.java:432`

它说明 `ClientCalls` 本质上在干三件事：

1. 选择哪种 listener / adapter 去接这次调用
2. 用统一方式启动 `ClientCall`
3. 再根据不同调用风格，组织请求发送、消息消费和结果收束方式

也就是说，`ClientCalls` 是 gRPC 客户端运行时真正的“调用范式统一器”。

它让下面这件事成为可能：

- 上游表面 API 可以很多样
- 下游 transport 入口却仍然可以非常统一

### 测试如何证明 `ClientCalls` 的中心地位

测试对此提供了非常直接的证据。

`ClientCallsTest` 里既有：

- `unaryBlockingCallSuccess()` 这种直接针对 blocking unary 最短闭环的验证，见 `stub/src/test/java/io/grpc/stub/ClientCallsTest.java:126`
- `unaryBlockingCallFailed()` 这种错误收束验证，见 `stub/src/test/java/io/grpc/stub/ClientCallsTest.java:145`
- `blockingUnaryCall2_success()` 这种走真实 in-process channel 的端到端闭环，见 `stub/src/test/java/io/grpc/stub/ClientCallsTest.java:167`
- `blockingUnaryCall2_interruptedWaitsForOnClose()` 这种专门验证“线程中断后仍要等 `onClose()` 清理完成”的边界，见 `stub/src/test/java/io/grpc/stub/ClientCallsTest.java:195`
- `blockingUnaryCall_HasBlockingStubType()` 这种验证 `STUB_TYPE_OPTION` 的测试，见 `stub/src/test/java/io/grpc/stub/ClientCallsTest.java:273`
- `unaryFutureCallSuccess()` 这种 future 收束测试，见 `stub/src/test/java/io/grpc/stub/ClientCallsTest.java:317`

测试面向的不是“用户调的某个具体 stub 类”，而正是 `ClientCalls` 这层。

这就说明在 gRPC 作者眼里，真正把多种调用外观统一起来的关键位置，就是这里。

所以到这一层可以先收一个更完整的判断：

- `Stub` 保存入口上下文
- `ClientCalls` 负责统一调用风格

再往下，才轮到 channel 世界正式接管调用。

## 第三层：`ManagedChannel` 为什么不是“一条连接”，而是客户端运行时总入口

很多人第一次看到 `ManagedChannel` 这个名字时，脑子里会自然浮现一个很朴素的想象：

- 它就是连到远端服务器的一条连接

这个理解太窄了。

`ManagedChannel` 的抽象定义首先强调的不是“发请求”，而是 **lifecycle management**，也就是生命周期管理，见 `api/src/main/java/io/grpc/ManagedChannel.java:22`。

它暴露的第一批 API 也不是“怎么发消息”，而是：

- `shutdown()`
- `isShutdown()`
- `shutdownNow()`
- `awaitTermination()`
- `getState()`
- `notifyWhenStateChanged()`
- `resetConnectBackoff()`
- `enterIdle()`

见：`api/src/main/java/io/grpc/ManagedChannel.java:26`

这已经很能说明问题了。

gRPC 对 channel 的定位，从一开始就不是：

- “一个已经连好的 socket”

而是：

- “一个要负责管理客户端连接状态、生命周期、调用入口和后续运行时行为的总入口”

当然，本文不能在这里展开 NameResolver、LoadBalancer、Subchannel 和连接状态机的全部细节。但即使先不讲那些，也要先把一个误解纠正掉：

- `ManagedChannel` 不是 transport 的别名
- 它是客户端运行时入口的总门面

### `ManagedChannelImpl.newCall()` 看起来很薄，但它是调用正式进入 channel 世界的切点

在 `ManagedChannelImpl` 里，`newCall(...)` 的实现看上去非常薄：

- 它只是把请求转给 `interceptorChannel.newCall(method, callOptions)`

见：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:809`

但这层薄，并不意味着它不重要。恰恰相反，它说明 gRPC 在这里故意把职责切得很清楚：

- channel 这一层要负责正式接管调用
- 但并不要求所有细节都堆在一个方法体里

真正更值得看的是，它接下来会把调用导向 `RealChannel`，再由 `clientCallImplChannel` 生成真正的 `ClientCallImpl`。

在 `clientCallImplChannel.newCall(...)` 里，gRPC 会直接 new 出一个 `ClientCallImpl`，并把以下东西塞进去：

- `method`
- 这次调用对应的 executor
- `callOptions`
- `transportProvider`
- 调度 deadline 取消的 executor
- `channelCallTracer`

见：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:838`

这一步非常关键，因为它说明：

- 在 channel 世界里，调用已经不再只是一个“某个 stub 方法”
- 它被还原成了一次统一的调用对象构造

也就是说，从 `ManagedChannel.newCall()` 往下，gRPC 开始正式抛弃“本地方法外观”，转向“统一调用对象”视角。

### `RealChannel.newCall()` 说明 channel 不只是创建调用，还要处理“调用可能暂时发不出去”

再进一步看 `RealChannel.newCall(...)`，事情就更有意思了。

如果 config selector 已经准备好，它会直接创建新调用；如果还没准备好，它会先：

- 触发 `exitIdleMode()`
- 检查 shutdown
- 必要时创建 `PendingCall`
- 把调用暂时挂起，等后面时机成熟再 `reprocess()`

见：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:864`

这说明什么？

说明 channel 层做的事情远不只是“把调用对象 new 出来”。

它还要处理一个更接近真实运行时的问题：

- 调用入口已经来了
- 但底层运行时条件可能还没准备好

比如：

- name resolution 还没准备好
- channel 正处在某个过渡阶段
- config selector 还没稳定下来

于是 channel 不能简单地说：

- “没准备好，那你别调。”

它要做的是：

- 先承认这次调用已经进入系统
- 再决定它是立刻下沉，还是先变成 pending call，等时机成熟再继续推进

这就是为什么 `PendingCall` 这层会存在。

对第一篇来说，我们不需要把 name resolution 展开，但至少要先记住：

- `ManagedChannel` 是调用世界和下游运行时条件之间的第一道缓冲层

这比“它是一条连接”准确得多。

### `newClientCall(...)` 说明 channel 负责把复杂运行时压回统一调用对象

`RealChannel.newClientCall(...)` 也进一步暴露了这种设计取向。

它会根据当前是否有 config selector，以及 selector 的类型，来决定：

- 直接走 `clientCallImplChannel.newCall(...)`
- 还是包装成 `ConfigSelectingClientCall`

见：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1049`

这一层意义很大。

因为它说明：不管下游运行时条件多复杂，channel 的目标都还是把这些复杂性，重新折叠回一个统一的调用对象模型中去。

换句话说，channel 层虽然连着很多复杂世界，但它对上游暴露的统一动作始终是：

- `newCall()`

这正是客户端运行时总入口应有的样子。

### 测试怎么证明 channel 层不是薄壳

`ManagedChannelImplTest` 里最有代表性的几个测试，也正好钉住了这一点。

`immediateDeadlineExceeded()` 验证的是：如果 deadline 一开始就已经过期，新调用会立刻失败，见 `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:487`。

这说明 channel 层不是“无脑造一个 call 就完了”，它连“这个调用现在是不是还值得发”这种运行时边界都要兜住。

`startCallBeforeNameResolution()` 更关键：它验证了调用可以先于 name resolution 创建，后面再通过 pending call 重新推进，见 `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:500`。

这正说明 `ManagedChannel` 是一个运行时入口，而不是静态连接句柄。

`newCallWithConfigSelector()` 则证明 config selector 甚至可以在 `start()` 时改写调用行为，见 `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:565`。

所以到这里，我们可以把 channel 层的职责先压缩成一句：

- `ManagedChannel` 负责让一次调用正式进入客户端运行时，并把后续复杂世界重新折叠成统一的 `ClientCall` 入口

再往下，真正决定“远程调用从现在开始发生”的，就是 `ClientCallImpl.start()`。

## 第四层：`ClientCallImpl.start()` 才是“远程调用真正开始发生”的时刻

到这里为止，前面的几层其实都还在做“组织调用”的工作：

- `Stub` 保存入口上下文
- `ClientCalls` 统一表面调用风格
- `ManagedChannel` 接管调用并构造统一调用对象

可这几层做完之后，调用仍然还停留在一种“描述已经很完整，但尚未真正开跑”的状态里。

真正的转折点，是 `ClientCallImpl.start()`。

类注释已经明说它就是 `ClientCall` 的实现，见 `core/src/main/java/io/grpc/internal/ClientCallImpl.java:69`。

而构造器里保存的这些状态，也已经暴露出它的角色：

- `method`
- `callExecutor`
- `callOptions`
- `clientStreamProvider`
- `deadlineCancellationExecutor`
- `Context.current()`

见：`core/src/main/java/io/grpc/internal/ClientCallImpl.java:97`

这说明 `ClientCallImpl` 不是一个“轻薄转发器”，而是一次客户端调用真正落地前的统一装配位。

### 为什么说 `start()` 是关键切点

`start()` 本身只做了一层 PerfMark 包装，真正逻辑在 `startInternal(...)`，见：

- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:181`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:188`

而这段逻辑恰恰就是“调用从描述变成执行”的全过程。

它会先做几件入口级校验：

- 不能重复 start
- 不能已经 cancel
- listener 不能为空
- headers 不能为空

然后立刻面对第一个真实运行时问题：

- 当前 `Context` 如果已经被取消了，还要不要真的创建 stream？

答案是不需要。它会直接用 `NoopClientStream`，然后异步通知 observer 关闭。

这说明从 `ClientCallImpl.start()` 开始，gRPC 已经进入“这次调用到底还能不能成立”的阶段了，而不是“先往后交给别人再说”。

### headers、compressor、deadline 都是在这里真正落位的

继续往下看，`startInternal(...)` 会依次处理：

- `applyMethodConfig()`
- compressor 查找
- `prepareHeaders(...)`
- `effectiveDeadline()`
- `CancellationHandler`

见：

- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:213`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:242`

这几步之所以重要，是因为它们说明了一个核心事实：

- 在 `ClientCallImpl.start()` 之前，很多调用信息都还只是静态描述
- 在 `start()` 这里，它们才第一次被统一整理成一次真正可以交给 stream 的调用上下文

比如 deadline。

在 `Stub` 层你可以不断 `withDeadlineAfter(...)`，但那只是把信息写进 `CallOptions`。

只有到了 `ClientCallImpl.start()`，gRPC 才会认真回答：

- 当前生效的 deadline 到底是谁
- 它是来自 `Context`，还是来自 `CallOptions`
- 如果 deadline 现在就已经超时了，是不是连 stream 都不该建

如果 deadline 已经过期，`ClientCallImpl` 甚至不会真的创建 stream，而是直接创建一个 `FailingClientStream`，见 `core/src/main/java/io/grpc/internal/ClientCallImpl.java:250`。

这正是“start 才是真正转折点”的最好证据。

因为到这一刻，gRPC 已经不再是在组织一次潜在调用，而是在对一次真实调用做成立性判断。

### 真正的下沉动作：`clientStreamProvider.newStream(...)`

`ClientCallImpl.start()` 里最关键的一步，当然还是这句：

- `stream = clientStreamProvider.newStream(method, callOptions, headers, context)`

证据：`core/src/main/java/io/grpc/internal/ClientCallImpl.java:250`

这句代码的重要性在于，它标志着一次调用正式越过了“统一调用对象”边界，开始申请自己的 stream。

也就是说，到这里为止：

- 上游所有关于 stub、调用风格、channel、config、deadline、headers 的事情
- 都被压缩成了一个可以真正建 stream 的调用请求

这就是本文最关键的一次收束。

如果你问：

- “本地 Java 方法是什么时候真正开始变成远程调用的？”

最准确的回答不是：

- 在生成 stub 的时候
- 在 `ManagedChannel.newCall()` 的时候
- 在 transport 真正写出 frame 的时候

而是：

- **在 `ClientCallImpl.start()` 让这次调用开始创建自己的 `ClientStream` 时，它正式越过了本地方法外观，进入了远程调用运行时。**

### `stream.start(...)` 说明 `ClientCallImpl` 不是终点，只是 transport 前最后统一抽象

当然，`ClientCallImpl` 还不是 transport 本身。

在 stream 创建之后，它还会继续把很多属性灌进去：

- authority
- inbound / outbound message size
- deadline
- compressor
- decompressor registry

然后调用：

- `stream.start(new ClientStreamListenerImpl(observer))`

见：`core/src/main/java/io/grpc/internal/ClientCallImpl.java:286`

这说明 `ClientCallImpl` 在整个客户端运行时里的准确位置是：

- transport 之前的最后统一抽象

它已经足够靠下，能接触 deadline、headers、compressor 和 stream；
但它又还没有低到直接处理 HTTP/2 frame 或 Netty handler。

所以它正好是解释“本地方法怎样变成远程调用”的最佳落点。

因为从这里往后，调用虽然还会继续往下沉，但那条主线已经属于 transport 世界，而不再属于“客户端调用入口如何组织”的问题域了。

### 测试怎么证明 `ClientCallImpl.start()` 是成立性与下沉性的双重切点

`ClientCallImplTest` 对这件事给了很强的托底。

`deadlineExeedeed(...)` 那组测试验证了：如果 deadline 在调用开始前就已经过期，`ClientCallImpl` 不会真正去 `newStream(...)`，见 `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:781`。

这说明 `start()` 不是无条件下沉。

`contextDeadlineShouldBePropagatedToStream()` 则证明 context deadline 会被真正灌给 stream，见 `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:809`。

这说明 `start()` 确实是调用属性真正落位的地方。

`expiredDeadlineCancelsStream_CallOptions()` 又验证了：已经建好的 stream，在 deadline 到期后会被取消，见 `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:909`。

这说明 `ClientCallImpl` 不只是 start 一下就撒手不管，它还继续承担调用生命周期中的取消和收尾协调。

所以到这一层，我们可以非常明确地收一句：

- `ClientCallImpl.start()` 是客户端调用真正开始发生的时刻
- 因为它同时承担了“调用成立性判断”和“向 stream 世界下沉”这两件事

## 第五层：transport 为什么只需要点到为止，却必须点到

本文一直在强行压边界，不重讲 transport 细节。

但“只点到 transport”不等于“可以完全不讲 transport”。

因为如果你连最后落到哪一层都不交代，前面那条调用主线仍然是不闭环的。

最小需要交代的一件事，就是 `ClientCallImpl` 往下真正面对的统一出口是什么。

答案就是：

- `ClientTransport.newStream(...)`

`ClientTransport` 的类注释把它定义成客户端 transport，通常封装一条到远端服务器的连接；但它也明确提醒，**在客户端还没发现任何服务器地址之前创建的 stream，后面可能最终会被发到不同连接上**，见 `core/src/main/java/io/grpc/internal/ClientTransport.java:28`。

这句话很重要。

它再一次提醒我们：

- transport 虽然是连接级世界
- 但 gRPC 客户端调用并不是简单地“某个 stub 直接抓住一条 TCP 连接写数据”

而 `ClientTransport.newStream(...)` 的定义也非常明确：

- 给定 method、headers、call options 和 tracers
- 创建一条新的 stream
- 这个动作立即返回，不等待请求是否已经被真正验证或发送成功
- 失败信息会通过 `ClientStreamListener` 回来

见：`core/src/main/java/io/grpc/internal/ClientTransport.java:56`

这正好和前文的整条主线严丝合缝地对上：

- `Stub` 负责入口配置
- `ClientCalls` 负责统一调用风格
- `ManagedChannel` 负责接管调用并创建统一调用对象
- `ClientCallImpl.start()` 负责把调用压成 `ClientStream`
- transport 再负责把这条 stream 放进真正的连接级世界

所以 transport 在本文里应该怎么出现？

最合适的方式不是把 Netty handler 再讲一遍，而是明确告诉读者：

- 到 `ClientTransport.newStream()` 为止，客户端调用入口这条线就算交棒完成了
- 从这里往后，就是前面 Netty HTTP/2 篇章已经建立好的 frame、stream、connection handler、flow control 和 write queue 世界

也就是说，transport 在本文里的职责更像一个出口路标，而不是下一段正文主线。

## 最后把整条链收回来：为什么 `stub.method(request)` 最后一定会变成一次远程调用

现在可以把整篇文章的主线收回来了。

如果你只记一句最短的人话答案，那就是：

**`stub.method(request)` 并不是被某个神秘代理直接发了出去，而是被一层层压缩成一次统一的 `ClientCall`，再由 `ClientCallImpl` 压成真正的 `ClientStream`，最后交给 transport。**

把它拆开，就是四层非常稳定的职责分工。

### 第一层：`Stub` 保存入口上下文

它不负责直接发请求，而是稳定保存：

- 这次调用走哪个 `Channel`
- 这次调用带哪些 `CallOptions`

而且它用不可变方式组织这些配置，保证每次 `withXxx()` 都返回一个新的入口对象，而不会污染已有调用。

### 第二层：`ClientCalls` 统一调用范式

它把：

- blocking
- future
- async

这些上游看上去很不一样的 API 风格，统一压到一条更稳定的调用语义线上。

所以不同的不是底层 transport 模型，而是结果收束方式。

### 第三层：`ManagedChannel` 接管调用

它让一次调用正式进入客户端运行时世界。

它不是简单的一条连接，而是能够处理：

- 生命周期
- 入口接管
- pending call
- config 选择
- 运行时缓冲

这些复杂边界的总入口。

### 第四层：`ClientCallImpl.start()` 让调用真正开始发生

这里才是最关键的转折点。

因为在这里：

- headers 会被准备好
- compressor 会被确定
- deadline 会被裁决
- listener 会被安装
- stream 会被真正创建

从这一刻起，调用不再只是一个“像本地方法的描述”，而是已经进入远程调用运行时。

### 第五层：transport 接走 stream

再往下，调用就进入了前面已经讲过的 transport 世界：

- `ClientTransport.newStream()`
- `ClientStream`
- Netty HTTP/2 handler
- frame / stream / flow control / write queue

这些是下一层地基，但不是本文的主线。

## 这篇先立住的，不是 gRPC 全景，而是 RPC 客户端运行时基线

到这里为止，这篇文章其实故意没有展开很多你可能已经想到的问题：

- 服务端怎样接住这次调用
- `StreamObserver` 四种模式到底怎么对齐
- `Context` 和 `Deadline` 为什么是横切面语义
- `NameResolver` 和 `LoadBalancer` 怎样决定“调谁”
- Netty HTTP/2 里 frame 和 child channel 怎样继续往下跑

不是这些不重要，而是第一篇如果不先把客户端调用基线立住，后面所有主题都会变成漂在空中的知识点。

所以这篇真正要留下来的心智模型只有一条：

```text
stub.method(request)
  != 某个模糊的“代理直接发请求”
  == 入口上下文
     -> 调用范式统一
     -> channel 接管
     -> ClientCall 启动
     -> stream 创建
     -> transport 出口
```

只要这条线立住，后面再看：

- 拦截器挂在哪
- deadline 为什么能取消调用
- 为什么服务发现还没完成时调用也可以先建出来
- 为什么最后仍然会落到 HTTP/2 stream

整个 RPC 客户端运行时就不再像一团黑箱。

而这，正是“RPC 与治理”这一整组主题最应该先建立的第一块地基。