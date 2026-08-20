# grpc-java：四种调用模式与方法契约总图

> 基于 grpc-java v1.83.1

## 一、困惑开场：为什么"多发了一条消息"会报错

假设你写了一个简单的 unary 服务端方法，不小心在 `onNext()` 里调用了两次 `responseObserver.onNext(response)`，然后才调 `onCompleted()`。你猜会发生什么？不是"客户端多收一条消息"，而是服务端直接报错，调用被终止，客户端收到一个 `Status.INTERNAL`，错误消息是 `"Too many responses"`。

如果你换成 client-streaming，客户端在 `onNext()` 里发了两次请求，服务端也会报错，错误消息是 `"Too many requests"`。但如果你换成 bidi-streaming，同样的行为却不会报错——多发几条消息都可以。

这引出了一个核心问题：为什么有些"多发"被允许，有些被禁止？这些规则是谁定的，谁在强制执行？

答案藏在 gRPC 的四种方法类型契约中。Unary、ServerStreaming、ClientStreaming、BidiStreaming 不只是"代码风格不同"，它们有严格的协议契约：每条消息的类型、数量、时序都有明文规定。违反这些契约，grpc-java 会用 `Status.INTERNAL` 终止调用。

## 二、前情回顾：主干篇已经讲了实现，没讲规范

在 ch01 的主干篇中，我们已经走通了四种调用模式各自的实现路径。客户端侧，我们知道 `ClientCallImpl` 内部维护了 `halfCloseCalled` 和 `cancelCalled` 两个状态标志，`sendMessage()` 和 `halfClose()` 之间有时序约束。服务端侧，我们知道 `ServerCalls` 提供了四种 handler 工厂方法（`asyncUnaryCall`、`asyncServerStreamingCall`、`asyncClientStreamingCall`、`asyncBidiStreamingCall`），分别对应 `UnaryServerCallHandler` 和 `StreamingServerCallHandler` 两种实现。

但主干篇回答的是"怎么走通"，没有回答"走不通会怎样"——如果客户端在 unary 上发了两次请求，服务端的 `UnaryServerCallListener.onMessage()` 会怎么处理？如果服务端在 client-streaming 上发了两次响应，`ServerCallImpl.sendMessageInternal()` 会怎么反应？如果客户端在 blockingUnaryCall 中收到了两条响应，调用会成功还是失败？

这些边界条件正是本篇要补的规范层。主干篇关注的是"正常的路径"，本篇关注的是"边界在哪里"。

## 三、先走三条失败的路

### 失败方案一：四种方法类型只是"代码风格偏好"

很多人以为四种方法类型只是 gRPC 官方提供的四种"代码模板"——你觉得哪种风格适合就用哪种，没有严格的约束。

但如果你真的这么想，就无法解释 grpc-java 中那些专门的方法类型检查。`ServerCallImpl.sendMessageInternal()` 里有一行：

```java
if (method.getType().serverSendsOneMessage() && messageSent) {
    handleInternalError(Status.INTERNAL.withDescription(TOO_MANY_RESPONSES)...);
}
```

`ServerCalls.UnaryServerCallListener.onMessage()` 里也有一行：

```java
if (this.request != null) {
    call.close(Status.INTERNAL.withDescription(TOO_MANY_REQUESTS)...);
}
```

如果方法类型只是"风格偏好"，这些检查完全是多余的——你可以删掉它们，把四种模式统一成一种"你爱发多少条就发多少条"的语义，grpc-java 也能正常工作。但事实是，这些检查存在且被测试覆盖，说明它们不是可有可无的装饰，而是协议规范的一部分。

### 失败方案二：客户端和服务端的契约检查是对称的

你可能会想：既然服务端既检查请求数又检查响应数，那客户端应该也是对称的吧？毕竟客户端和服务端是在同一个协议下通信。

但实际实现并不对称。服务端对请求和响应都有严格的计数检查：`UnaryServerCallListener` 检查客户端发来的请求数量，`ServerCallImpl` 检查服务端自己发出的响应数量。但客户端只检查接收到的响应数量，不检查发送的请求数量——`ClientCallImpl.sendMessageInternal()` 只检查 `halfCloseCalled` 和 `cancelCalled` 的状态，不检查 `clientSendsOneMessage()`。

客户端侧的请求数量由 stub 层通过"调用一次 sendMessage 后立即调用 halfClose"的代码路径确保，而不是通过运行时检查。`ClientCalls.asyncUnaryRequestCall()` 的代码路径就是：先 `call.sendMessage(req)`，然后立即 `call.halfClose()`。如果开发者不走这个路径（比如直接调用 `ClientCall.sendMessage()` 两次），`ClientCallImpl` 不会阻止你——它只会在第二次 `sendMessage()` 时检查 `halfCloseCalled`，但此时 halfClose 还没调用，所以第二次 `sendMessage()` 会成功。这意味着在客户端侧，`ClientCallImpl` 并不会阻止你发送过多的请求。

这种不对称是有意设计的：服务端不能信任客户端，所以必须强制执行契约检查；客户端可以信任自己的 stub 代码，所以不需要额外的运行时检查。

### 失败方案三：违反契约就是内部异常，和 Status 无关

如果你熟悉 Java 的 `IllegalStateException`，你可能会觉得"违反契约不就是抛 IllegalStateException 嘛"。但 grpc-java 不是这样设计的。

当服务端多发了一条响应时，`ServerCallImpl.sendMessageInternal()` 不是抛 `IllegalStateException`——它调用 `handleInternalError()`，这个方法最终调用 `stream.cancel(Status.INTERNAL)`。客户端收到的是一个标准的 gRPC Status，`code` 是 `INTERNAL`，`description` 是 `"Too many responses"`。

同样，当客户端多发了一条请求时，`UnaryServerCallListener.onMessage()` 调用 `call.close(Status.INTERNAL, ...)`，客户端收到的是 `Status.INTERNAL`，`description` 是 `"Too many requests"`。

违反契约不是"内部异常"，而是"标准 gRPC INTERNAL 状态"。这个区别很重要：因为客户端可以通过 `Status.getCode()` 统一识别和处理，而不需要区分"这是框架抛的异常还是业务抛的异常"。

## 四、最小总图：四种契约 + 三层 enforce

在进入具体实现之前，先建立一张总图。

四种方法类型的契约可以概括为四句话：

```
UNARY：           客户端恰好发 1 条请求，服务端恰好回 1 条响应
SERVER_STREAMING：客户端恰好发 1 条请求，服务端回 0 条或多条响应
CLIENT_STREAMING：客户端发 0 条或多条请求，服务端恰好回 1 条响应
BIDI_STREAMING：  客户端发 0 条或多条请求，服务端回 0 条或多条响应
```

grpc-java 在三个层面强制执行这些契约：

- **服务端响应层**（`ServerCallImpl`）：检查 `serverSendsOneMessage()` 的方法是否发了多条响应或关闭时没有响应。
- **服务端请求层**（`ServerCalls.UnaryServerCallListener`）：检查 `clientSendsOneMessage()` 的方法是否收到了多条请求或关闭时没有收到请求。
- **客户端响应层**（`ClientCalls.StreamObserverToCallListenerAdapter`）：检查 `streamingResponse` 为 false 的方法是否收到了多条响应。

客户端请求层没有运行时检查，因为 stub 层的调用路径已经确保了请求数量。

## 五、契约从哪里定义：MethodDescriptor.MethodType

grpc-java 在 `MethodDescriptor.MethodType` 枚举中定义了四种方法类型的契约。每个枚举值通过 javadoc 明确说明了请求和响应的数量要求：

- `UNARY`："One request message followed by one response message."
- `CLIENT_STREAMING`："Zero or more request messages with one response message."
- `SERVER_STREAMING`："One request message followed by zero or more response messages."
- `BIDI_STREAMING`："Zero or more request and response messages arbitrarily interleaved in time."

`MethodDescriptor.java:81` — `UNARY` 枚举值及 javadoc
`MethodDescriptor.java:87` — `CLIENT_STREAMING` 枚举值及 javadoc
`MethodDescriptor.java:93` — `SERVER_STREAMING` 枚举值及 javadoc
`MethodDescriptor.java:99` — `BIDI_STREAMING` 枚举值及 javadoc

每个枚举值还提供了两个关键方法，让服务端和客户端在运行时判断当前方法类型的契约约束：`clientSendsOneMessage()` 和 `serverSendsOneMessage()`。UNARY 和 SERVER_STREAMING 的 `clientSendsOneMessage()` 返回 true；UNARY 和 CLIENT_STREAMING 的 `serverSendsOneMessage()` 返回 true。这两个方法贯穿了整条契约 enforce 链——`ServerCallImpl`、`UnaryServerCallListener`、`ClientCallImpl` 都依赖它们来做检查。

`MethodDescriptor.java:114` — `clientSendsOneMessage()` 方法
`MethodDescriptor.java:124` — `serverSendsOneMessage()` 方法

## 六、服务端检查请求：客户端不能多发，也不能少发

这里先做一个路标。下面讲的是服务端怎么检查客户端发来的请求数量。如果你只对"服务端怎么保证自己不多发响应"感兴趣，可以直接跳到第七节。但建议先读完本节——请求检查和响应检查的结构是对称的，理解了请求检查，响应检查就更容易理解。

### 6.1 服务端在哪里检查请求数量

服务端在 `ServerCalls.UnaryServerCallListener` 中检查客户端的请求数量。这个 Listener 只被 `UnaryServerCallHandler` 使用，而 `UnaryServerCallHandler` 只被 `asyncUnaryCall` 和 `asyncServerStreamingCall` 这两种 stub 方法创建——也就是说，它只用于 `clientSendsOneMessage()` 为 true 的方法类型。

`ServerCalls.java:126` — `UnaryServerCallHandler.startCall()` 检查 `clientSendsOneMessage()`，确保 handler 不会被误用于流式方法

### 6.2 多发检查：TOO_MANY_REQUESTS

`onMessage()` 每次被调用时，都会检查 `this.request` 是否已经非空。如果是，说明这是第二次收到请求——违反了 `clientSendsOneMessage()` 契约。它会立即调用 `call.close(Status.INTERNAL.withDescription("Too many requests"))` 终止调用。

`ServerCalls.java:154` — `UnaryServerCallListener.onMessage()` 第二次请求 → `TOO_MANY_REQUESTS`

### 6.3 少发检查：MISSING_REQUEST

`onHalfClose()` 被调用时，检查 `this.request` 是否为空。如果为空，说明客户端关闭了写入端但没有发送任何请求——违反了 `clientSendsOneMessage()` 契约。同样，它会调用 `call.close(Status.INTERNAL.withDescription("Half-closed without a request"))` 终止调用。

`ServerCalls.java:170` — `UnaryServerCallListener.onHalfClose()` 无请求 → `MISSING_REQUEST`

`ServerCalls.java:37` — `TOO_MANY_REQUESTS` 常量
`ServerCalls.java:38` — `MISSING_REQUEST` 常量

### 6.4 流式方法没有请求检查

`StreamingServerCallListener`（用于 client-streaming 和 bidi-streaming）没有请求计数检查。它的 `onMessage()` 直接转发给 `requestObserver.onNext(request)`，不计数、不限制。

`ServerCalls.java:261` — `StreamingServerCallListener.onMessage()` 无计数（允许 N 请求）

## 七、服务端检查响应：不能多发，也不能少发

再做一个路标。请求检查讲完了，现在进入响应检查。注意响应检查和请求检查不对称：请求检查在 `ServerCalls`（stub 模块），响应检查在 `ServerCallImpl`（core 模块）——因为请求是客户端发来的，响应是服务端自己发出的，检查点不在同一层。

### 7.1 服务端在哪里检查响应数量

服务端在 `ServerCallImpl` 中检查自己发出的响应数量。`ServerCallImpl` 是 grpc-java 核心运行时的一部分，位于 `core/` 模块，不依赖 `stub/` 模块。它通过 `method.getType().serverSendsOneMessage()` 来判断当前方法类型是否要求恰好一条响应。

### 7.2 多发检查：TOO_MANY_RESPONSES

`sendMessageInternal()` 是 `ServerCall.sendMessage()` 的内部实现。每次调用时，它检查：如果 `serverSendsOneMessage()` 为 true 且 `messageSent` 已经为 true（说明已经发送过一条响应），就调用 `handleInternalError()` 终止调用，错误消息是 `"Too many responses"`。

`ServerCallImpl.java:156` — `sendMessageInternal()` 的 `serverSendsOneMessage()` + `messageSent` 检查 → `TOO_MANY_RESPONSES`

注意，这里用的是 `handleInternalError()` 而不是 `call.close()`。`handleInternalError()` 会通过 `stream.cancel(Status.INTERNAL)` 来终止调用——这意味着服务端不会发送正常的响应，而是直接取消流。

### 7.3 少发检查：MISSING_RESPONSE

`closeInternal()` 在关闭调用时，检查：如果 `status.isOk()` 为 true（正常关闭），`serverSendsOneMessage()` 为 true，且 `!messageSent`（没有发送过任何响应），就调用 `handleInternalError()` 终止调用，错误消息是 `"Completed without a response"`。

`ServerCallImpl.java:217` — `closeInternal()` 的 `serverSendsOneMessage()` + `!messageSent` 检查 → `MISSING_RESPONSE`

这个检查只在 `status.isOk()` 时触发。如果服务端通过 `onError()` 关闭调用（状态不是 OK），`MISSING_RESPONSE` 检查不会触发——因为异常关闭不需要响应。

`ServerCallImpl.java:57` — `TOO_MANY_RESPONSES` 常量
`ServerCallImpl.java:58` — `MISSING_RESPONSE` 常量

## 八、客户端侧：只检查响应，不检查请求

再做一个路标。服务端侧的两个检查都讲完了，现在进入客户端侧。客户端侧和服务器端侧的检查力度不同：客户端只检查接收到的响应数量，不检查发送的请求数量。原因很简单——客户端发请求时调用的是自己的代码，不应该多发；但客户端收响应时面对的是网络，服务器可能有 bug，所以必须检查。

### 8.1 客户端怎么检查响应数量

客户端在 `ClientCalls.StreamObserverToCallListenerAdapter` 中检查收到的响应数量。当 `streamingResponse` 为 false（对应 UNARY 和 CLIENT_STREAMING），`onMessage()` 检查 `firstResponseReceived` 是否已经为 true。如果是，说明收到了第二条响应——违反 `serverSendsOneMessage()` 契约，抛出 `Status.INTERNAL`。

`ClientCalls.java:562` — `StreamObserverToCallListenerAdapter.onMessage()` 多条响应 → `INTERNAL`

对于 `futureUnaryCall` 场景，`UnaryStreamToFuture` 有更严格的检查：不仅检查多条响应，还检查零条响应。如果 `onClose()` 时状态为 OK 但 `isValueReceived` 为 false，说明服务端没有返回任何响应就正常关闭了，同样抛出 `Status.INTERNAL`。

`ClientCalls.java:618` — `UnaryStreamToFuture.onMessage()` 多条 → `INTERNAL`
`ClientCalls.java:633` — `UnaryStreamToFuture.onClose()` 无响应 → `INTERNAL`

### 8.2 请求无计数：客户端可以多发吗

前面已经提到，客户端侧没有请求计数检查。`ClientCallImpl.sendMessageInternal()` 只检查三个状态：`stream != null`（已启动）、`!cancelCalled`（未被取消）、`!halfCloseCalled`（尚未 half-close）。它不检查 `clientSendsOneMessage()`。

`ClientCallImpl.java:515` — `sendMessageInternal()` 状态检查（无计数）

这意味着，如果你直接调用 `ClientCall.sendMessage()` 两次（在 `ClientCalls` 的 stub 方法之外），`ClientCallImpl` 不会阻止你——第二次调用会成功，因为 `halfCloseCalled` 此时还是 false。

但 `ClientCalls` 的 stub 方法通过调用路径确保了契约合规。`asyncUnaryRequestCall()` 的代码是：

```java
call.sendMessage(req);
call.halfClose();
```

`ClientCalls.java:396` — `asyncUnaryRequestCall()` 发送 1 请求 + halfClose

`asyncStreamingRequestCall()` 则返回一个 `CallToStreamObserverAdapter`，让用户通过 `onNext()` 和 `onCompleted()` 来控制发送和 half-close——没有计数限制，适用于 client-streaming 和 bidi-streaming。

`ClientCalls.java:420` — `asyncStreamingRequestCall()` 返回 StreamObserver，不发送
`ClientCalls.java:468` — `CallToStreamObserverAdapter.onNext()` → `call.sendMessage()`
`ClientCalls.java:479` — `CallToStreamObserverAdapter.onCompleted()` → `call.halfClose()`

### 8.3 客户端请求路径的隐式约束

虽然没有显式的计数检查，但 `ClientCallImpl` 内部有一个 `unaryRequest` 标志，影响 `onReady()` 的行为。对于 UNARY 和 SERVER_STREAMING（`clientSendsOneMessage()` 为 true），`onReady()` 回调被静默忽略——不会触发 `listener.onReady()`。

`ClientCallImpl.java:120` — `unaryRequest` 标志（UNARY/SERVER_STREAMING 为 true）
`ClientCallImpl.java:745` — `onReady()` 对 `clientSendsOneMessage()` 方法静默

这是什么意思？`onReady()` 是流控信号——它告诉发送方"可以发送消息了"。对于 streaming 方法，这个信号在每次发送后重新触发，让发送方可以继续发送。对于 unary 方法，`onReady()` 被忽略——因为发送方只需要发送一次，不需要流控信号。

## 九、不对称设计：为什么客户端和服务端检查不同

把服务端和客户端的检查放在一起对比，不对称性一目了然：

| 维度 | 服务端（ServerCallImpl + ServerCalls） | 客户端（ClientCalls + ClientCallImpl） |
|------|------|------|
| 请求计数 | 强制检查（UnaryServerCallListener） | 无运行时检查（stub 路径确保） |
| 响应计数 | 强制检查（ServerCallImpl） | 强制检查（StreamObserverToCallListenerAdapter） |
| 违反后果 | stream.cancel(Status.INTERNAL) | 抛出 StatusRuntimeException(INTERNAL) |

这种不对称的设计原因是：**服务端不能信任客户端，客户端可以信任自己的代码**。

服务端处理的请求来自网络，可能来自任何客户端——完整的、恶意的、buggy 的，都有可能。如果不对请求数量做检查，一个恶意的客户端可以向 unary 方法发送大量请求，导致服务端异常。所以服务端必须强制执行契约。

客户端调用的是自己（或自己团队）的代码，通过 `ClientCalls` 的 stub 方法调用，请求数量由 stub 方法保证——`asyncUnaryRequestCall()` 发送一次就 halfClose，没有机会多发。所以不需要额外的运行时检查。

但客户端对响应数量的检查同样严格，因为响应来自网络，可能来自有 bug 的服务端。如果服务端在 unary 上发了两次响应，客户端必须能够检测到并通知调用者。

## 十、误解澄清

### 误解一：方法类型契约只在服务端检查，客户端不检查

很多人以为契约检查是服务端的事——"我是客户端，我想发几条就发几条，服务端会管我"。但客户端同样会检查响应数量。如果服务端在 unary 或 client-streaming 上发送了两条响应，`StreamObserverToCallListenerAdapter.onMessage()` 会抛出 `Status.INTERNAL`，客户端会收到错误。此外，`UnaryStreamToFuture` 还会检查零条响应的情况——服务端发了 OK 但没发响应，客户端也会报错。所以契约检查是双向的，只是力度不同。

### 误解二：contract violation 就是内部异常，不需要特殊处理

如果你认为违反契约只是抛一个 `IllegalStateException`，那你的错误处理逻辑可能需要调整。grpc-java 的契约违反不是通过异常抛出的，而是通过 `Status.INTERNAL` 终止调用。客户端收到的是标准的 gRPC Status，有明确的 code 和 description。这意味着你可以统一用 `Status.getCode() == Status.Code.INTERNAL` 来识别契约违反，而不需要区分"这是框架内部错误还是业务异常"。

### 误解三：serverSendsOneMessage 和 clientSendsOneMessage 是对称的

这两个方法名字看起来对称，但它们的语义不是"发送方是否发送一条消息"，而是"契约要求恰好一条"。`clientSendsOneMessage()` 为 true 意味着"客户端必须恰好发送一条请求"——多发是错误，少发也是错误。`serverSendsOneMessage()` 也是同样的含义。而且它们不是对称的返回值——UNARY 的 client 和 server 都返回 true，但 SERVER_STREAMING 的 client 返回 true 而 server 返回 false，CLIENT_STREAMING 的 server 返回 true 而 client 返回 false。

## 十一、收网总结

回到开头的困惑：为什么"多发了一条消息"会报错？

因为 unary 方法要求恰好 1 条请求和 1 条响应，多发一条就是违反契约。grpc-java 在服务端的 `ServerCallImpl` 和 `ServerCalls.UnaryServerCallListener` 中，以及客户端的 `ClientCalls.StreamObserverToCallListenerAdapter` 中，分别检查这些契约是否被遵守。违反时，以 `Status.INTERNAL` 终止调用，错误消息明确告诉你是哪种违反：`TOO_MANY_REQUESTS`、`MISSING_REQUEST`、`TOO_MANY_RESPONSES`、`MISSING_RESPONSE`。

四种方法类型不是"代码风格偏好"，它们有严格的协议契约。契约是规范层，enforce 是实现层——两者缺一不可。

另外有一条与契约相关但常被忽略的细节：`ServerCallImpl.sendMessageInternal()` 对 `serverSendsOneMessage()` 为 false 的方法（SERVER_STREAMING、BIDI_STREAMING）每次调用后立即 `stream.flush()`，为 true 的方法（UNARY、CLIENT_STREAMING）则延迟到 `close()` 时才 flush——这意味着 unary 和 client-streaming 的所有响应数据会与 close 一起原子性地交付，而 streaming 的每条响应都会立即发送。这不是契约检查，而是契约带来的传输层行为差异。

**三句话总结：**

1. UNARY 要求 1:1、SERVER_STREAMING 要求 1:N、CLIENT_STREAMING 要求 N:1、BIDI_STREAMING 要求 N:N——这是 gRPC 协议规范定义的契约，不是 grpc-java 的随意选择。
2. grpc-java 在服务端强制检查请求和响应计数（`UnaryServerCallListener` + `ServerCallImpl`），在客户端只强制检查响应计数（`StreamObserverToCallListenerAdapter`），请求计数由 stub 路径确保——这是"服务端不信任客户端"的设计哲学。
3. 违反契约不是内部异常，而是标准 gRPC `Status.INTERNAL`，有四个明确错误消息，客户端可以通过 `Status.getCode()` 统一识别。

**下篇预告：** 下一篇将进入 Metadata、Status 与 Trailers 语义，看 gRPC 的元数据、状态码和尾部在协议层面承担什么语义。