# grpc-java：取消、half-close 与完成边界 — 一次调用的终点

> 基于 grpc-java v1.83.1

## 一、困惑开场：一次调用到底有多少种结束方式

假设你正在排查一个线上问题。客户端发起了一个 unary 调用，但迟迟没有收到响应。你查了客户端日志，发现 `onClose()` 被调用了，Status 是 `DEADLINE_EXCEEDED`。但你查了服务端日志，发现服务端明明处理完了请求，返回了 `Status.OK`。为什么客户端拿到的状态和服务端返回的不一致？

如果你继续深入，会发现更复杂的情况：客户端在 `onMessage()` 中抛了一个异常，服务端返回了 `Status.OK`，但客户端 `onClose()` 收到的是 `Status.CANCELLED`。或者客户端调用了 `cancel()`，但 `onClose()` 仍然被调用了——而且 Status 是 `CANCELLED` 而不是 `OK`。

这些现象背后有一个共同的问题：一次 gRPC 调用可以以多种方式结束——正常完成、客户端取消、超时、Context 取消、连接中断、服务端报错。这些路径看起来是独立的，但它们最终都走向同一个终点：`ClientCall.Listener.onClose(Status, Metadata)`。而且这个终点只被调用一次。这中间发生了什么？不同路径之间如果同时触发，谁赢？

## 二、前情回顾：我们已经知道契约和 Status，但还没讲终点怎么收敛

在 ch04/01 中，我们已经知道了四种方法类型的契约：什么时候客户端必须恰好发送一条消息，什么时候服务端必须恰好返回一条消息；违反契约时，grpc-java 会用 `Status.INTERNAL` 终止调用。在 ch04/02 中，我们又知道了服务端如何把最终 Status 编码到 trailers 里，客户端如何从 `grpc-status` 和 `grpc-message` 中解码出 Status。

但前面两篇其实只覆盖了"终点的一部分"。

ch04/01 讲的是：如果业务代码在方法类型契约上出错，grpc-java 会选一个 Status 来结束调用。
ch04/02 讲的是：如果服务端已经决定了最终 Status，它会怎么把这个 Status 放进 trailers，再让客户端解码出来。

两篇连起来，仍然少了一个关键问题：**当一次调用不是按"服务端写 trailers → 客户端读 trailers"这条理想路径结束时，最终 Status 从哪里来？**

例如：客户端在 `cancel()` 之后，服务端还没来得及返回 trailers；Context 的 deadline 自己过期了；底层 transport 直接 RST_STREAM 了；客户端 listener 在 `onMessage()` 里抛异常了。此时没有完整的 trailers 可用，甚至服务端还没来得及决定一个 Status。但客户端的 `onClose(Status, Metadata)` 仍然必须只收到一个、而且是语义正确的结果。本篇要补的，就是这最后一层：**一次调用的终止怎样收敛到唯一的 `onClose()`。**

## 三、先走三条失败的路

### 失败方案一：取消和完成是两条独立的路径，不会互相影响

一个很自然的直觉是：客户端 cancel 就是一条路径，服务端 close 是另一条路径，它们各自独立，互不干扰。

但实际实现中，这两条路径可能同时发生。客户端在 `onMessage()` 中抛了异常，触发了 `exceptionThrown()` → `stream.cancel()`，而此时服务端可能已经发送了正常的 trailers。`ClientCallImpl.ClientStreamListenerImpl.closedInternal()` 中的 `exceptionStatus` 覆盖机制就是用来处理这种竞态的：如果 listener 抛了异常，服务端返回的 Status 被覆盖为 `CANCELLED`——因为 listener 已经无法再处理下一条消息，即使服务端说"一切正常"。

所以取消和完成不是独立的，它们通过 `exceptionStatus` 和 `listenerClosed` 标志在 `closedInternal()` 中收敛。

### 失败方案二：deadline 超时就是取消，用 CANCELLED 就够了

如果 deadline 超时直接用 `CANCELLED`，那客户端就无法区分"调用被主动取消"和"调用超时"——两者都是 `Status.CANCELLED`，但它们的语义完全不同：取消是主动的，超时是时间约束的。

所以 grpc-java 用 `DEADLINE_EXCEEDED` 而不是 `CANCELLED` 来表示超时。`ClientCallImpl.CancellationHandler` 中的 `formatDeadlineExceededStatus()` 返回 `DEADLINE_EXCEEDED`，带有具体的超时描述。

而且 `closedInternal()` 中有一个 deadline 双检：如果服务端返回了 `CANCELLED`，但本地 deadline 也已经过期，它会将 `CANCELLED` 覆盖为 `DEADLINE_EXCEEDED`。这是因为从客户端的角度看，调用失败的原因更可能是超时——客户端已经等待了足够长的时间，不再关心服务端为什么返回 `CANCELLED`。

### 失败方案三：Context 取消是单向的，只会影响 gRPC 调用

你可能认为 Context 取消是单向的：Context 取消 → gRPC 调用取消。但服务端调用结束后，`ServerStreamListenerImpl.closedInternal()` 会调用 `context.cancel(cancelCause)` 来反向传播——服务端完成时通知 Context。

这意味着 Context 取消和 gRPC 调用取消之间是双向传播的：Context 取消导致 gRPC 调用取消，gRPC 调用完成（无论成功或失败）也会导致 Context 取消。这个双向传播形成了一个级联的取消链：父 Context 取消 → 子 Context 取消 → gRPC 调用取消 → 服务端 `context.cancel()` → 子 Context 取消。

## 四、最小总图：所有路径都通往 onClose

在进入具体实现之前，先建立一张总图。

一次 gRPC 调用的终止路径有 5 种来源，它们最终都收敛于 `ClientCall.Listener.onClose(Status, Metadata)`：

```
终止来源：
  ├─ 正常完成：trailers 到达 → statusFromTrailers() → transportReportStatus(OK)
  ├─ 服务端错误：trailers 到达 → statusFromTrailers() → transportReportStatus(error)
  ├─ 客户端取消：cancel() → stream.cancel(CANCELLED) → transportReportStatus(CANCELLED)
  ├─ deadline 超时：deadlineCancellationFuture → stream.cancel(DEADLINE_EXCEEDED) → transportReportStatus(DEADLINE_EXCEEDED)
  ├─ Context 取消：CancellationListener → stream.cancel(statusFromCancelled(context)) → transportReportStatus(status)
  ├─ transport 错误：RST_STREAM → transportReportStatus(error)
  └─ listener 异常：exceptionThrown() → stream.cancel(CANCELLED) → exceptionStatus 覆盖最终 Status

                          ↓
            transportReportStatus(status)
                          ↓
                closeListener(status)
                          ↓
        ClientStreamListenerImpl.closedInternal(status)
                          ↓
        ClientCall.Listener.onClose(status, trailers)
```

`closedInternal()` 是收敛的核心：它接收来自 `transportReportStatus()` 的 Status，然后应用两个覆盖规则（deadline 双检和 `exceptionStatus`），最后交付 `onClose()`。

## 五、half-close：客户端关闭写入端

### 5.1 half-close 的语义

half-close 是客户端关闭请求写入端的操作。在 HTTP/2 层面，它在最后一个 DATA frame 上设置 `END_STREAM` 标志。但 half-close 不等于"调用结束"，因为服务端仍然可以继续发送响应。

### 5.2 客户端调用 half-close

`ClientCallImpl.halfCloseInternal()` 检查 `cancelCalled` 和 `halfCloseCalled` 的状态，然后调用 `stream.halfClose()`。

`ClientCallImpl.java:499` — `halfCloseInternal()` 检查状态，调用 `stream.halfClose()`

`AbstractClientStream.halfClose()` 设置 `outboundClosed` 标志，关闭 framer，发送最后的帧。

`AbstractClientStream.java:190` — `halfClose()` 设置 `outboundClosed`，`endOfMessages()`

### 5.3 服务端接收 half-close

服务端收到 end-of-stream 后，通过 `deframerClosed()` 最终调用 `ServerStreamListenerImpl.halfClosed()`，进而调用 `ServerCall.Listener.onHalfClose()`。

`ServerCallImpl.java:349` — `ServerStreamListenerImpl.halfClosed()` 调用 `listener.onHalfClose()`

### 5.4 不同方法类型下，half-close 的时机并不一样

half-close 的协议语义是统一的：客户端关闭写入端。但在四种方法类型里，它出现的时机并不一样。

对于 unary 和 server-streaming，half-close 基本是"发完唯一一条请求后立刻发生"。`ClientCalls.asyncUnaryRequestCall()` 的代码路径就是先 `call.sendMessage(req)`，再 `call.halfClose()`。也就是说，这两类方法的 half-close 几乎是框架自动帮你做掉的，应用代码很少直接感知它。

对于 client-streaming 和 bidi-streaming，half-close 变成了应用代码自己控制的边界。客户端什么时候调用 `requestObserver.onCompleted()`，什么时候才真正 half-close。这里 half-close 的含义就更强：它不是"我发完这一条了"，而是"我以后不会再发任何请求消息了"。

### 5.5 half-close 之后，流还活着

half-close 之后，`ClientCall.isReady()` 返回 false，`sendMessage()` 抛出 `IllegalStateException`。但这只意味着客户端写入端关闭，不意味着整个调用结束——客户端仍然可以接收响应，直到 `onClose()` 被调用。对 server-streaming 和 bidi-streaming 来说，这个阶段恰恰是服务端继续发送响应的主要阶段。

这里先做一个路标。half-close 这一节讲的是"客户端主动结束请求发送"；下面进入取消的五种来源，讲的是"调用为何会整体终止"。前者是写入端边界，后者是整条调用的终点来源。不要把两者混在一起。

## 六、取消的 5 种来源

### 6.1 客户端主动取消

客户端调用 `ClientCall.cancel(message, cause)` 是最直接的取消方式。`cancelInternal()` 创建 `Status.CANCELLED`，调用 `stream.cancel(status)`，然后清理 deadline 定时器和 Context 监听器。

`ClientCallImpl.java:459` — `cancelInternal()` 创建 `Status.CANCELLED`，调用 `stream.cancel()`

`cancel()` 是幂等的——如果 `cancelCalled` 已经为 true，第二次调用是空操作。

### 6.2 deadline 超时

deadline 超时由 `CancellationHandler` 中的定时器触发。`CancellationHandler` 实现了 `Runnable`，当 deadline 定时器触发时，`run()` 调用 `stream.cancel(formatDeadlineExceededStatus())`。

`ClientCallImpl.java:392` — `CancellationHandler.run()` deadline 超时 → `stream.cancel(formatDeadlineExceededStatus())`

`formatDeadlineExceededStatus()` 创建 `Status.DEADLINE_EXCEEDED` 并附上超时描述。

`ClientCallImpl.java:396` — `formatDeadlineExceededStatus()` 返回 `DEADLINE_EXCEEDED`

deadline 有两个来源：`CallOptions` 的 deadline 和 `Context` 的 deadline。`effectiveDeadline()` 取两者中的最小值。

`ClientCallImpl.java:425` — `effectiveDeadline()` 取 `min(CallOptions, Context)` 最小值

如果 deadline 在执行 `start()` 之前就已经过期，`ClientCallImpl` 不会创建真正的 stream，而是创建一个 `FailingClientStream`，直接用 `DEADLINE_EXCEEDED` 调用 `onClose()`。

`ClientCallImpl.java:248` — deadline 已过期 → `FailingClientStream` 带 `DEADLINE_EXCEEDED`

### 6.3 Context 取消

`CancellationHandler` 实现了 `CancellationListener`，在 `setUp()` 中注册到当前 Context。当 Context 被取消时，`cancelled(Context)` 被调用。

`ClientCallImpl.java:334` — `CancellationHandler` 实现 `CancellationListener`
`ClientCallImpl.java:382` — `CancellationHandler.cancelled(Context)` Context 取消 → `stream.cancel(statusFromCancelled(context))`

`statusFromCancelled()` 将 Context 的取消原因转换为 Status：如果原因是 `TimeoutException`，返回 `DEADLINE_EXCEEDED`；如果原因是 `StatusRuntimeException`，返回对应的 Status；否则返回 `CANCELLED`。

`Contexts.java:128` — `statusFromCancelled()` 将 Context 取消转为 Status

### 6.4 transport 错误

当底层传输层发生错误（如 RST_STREAM、协议错误）时，`Http2ClientStreamTransportState` 调用 `transportReportStatus()` 把错误 Status 传递上去。

`Http2ClientStreamTransportState.java:172` — transport 错误 → `transportReportStatus(error)`

### 6.5 服务端内部错误

服务端在处理过程中如果发现内部错误（如 TOO_MANY_RESPONSES），通过 `handleInternalError()` 调用 `stream.cancel(status)` 来终止调用。

`ServerCallImpl.java:272` — `handleInternalError()` → `stream.cancel(status)`

## 七、正常完成与错误完成

### 7.1 正常完成依然要先过 transportReportStatus

正常完成这条路径我们在 ch04/02 已经看过一遍：服务端发送 trailers，客户端 `Http2ClientStreamTransportState.transportTrailersReceived()` 被调用，从 `grpc-status` 和 `grpc-message` 提取出 `Status`，然后交给 `transportReportStatus()`。

`Http2ClientStreamTransportState.java:172` — `transportTrailersReceived()` 接收 trailers
`Http2ClientStreamTransportState.java:193` — `statusFromTrailers()` 提取 Status
`AbstractClientStream.java:377` — `inboundTrailersReceived()` 交付 trailers

这一次不再重复讲编码/解码细节，只抓一件事：**无论是正常完成还是错误完成，最终都要进入 `transportReportStatus()`。** 正常完成时，它拿到的是 trailers 解出来的 `Status.OK` 或非 OK 状态；非正常完成时，它拿到的是 cancel、deadline、transport error 直接构造出来的 Status。

### 7.2 transportReportStatus 不是终点，只是汇合点

`transportReportStatus()` 自己并不直接调用应用层的 `onClose()`。它先把 `statusReported = true`，等待 deframer 完成，然后调用 `closeListener()`。

`AbstractClientStream.java:401` — `transportReportStatus()` 设置 `statusReported`，等待 deframer 关闭，调用 `closeListener()`

`closeListener()` 里有一个关键的 `listenerClosed` 标志。如果 `listenerClosed` 已经是 true，`closeListener()` 不会再次调用 `listener().closed()`。

`AbstractClientStream.java:456` — `closeListener()` 中 `listenerClosed` 标志确保只调用一次

这个标志保证：无论多少条路径（cancel、trailers 到达、transport 错误）同时到达，`onClose()` 只被调用一次。

这里再做一个路标。到这里为止，所有终止路径已经汇合到了 `transportReportStatus()`/`closeListener()` 这一层；下一节要看的是最后的收敛点 `closedInternal()`，它才是真正决定客户端最终看到哪个 Status 的地方。

## 八、closedInternal 的收敛逻辑

### 8.1 收敛点

`ClientStreamListenerImpl.closedInternal()` 是所有终止路径的最终收敛点。它接收从 `transportReportStatus()` 传来的 Status，然后应用两个覆盖规则。

`ClientCallImpl.java:689` — `closedInternal()` 收敛点

### 8.2 规则一：deadline 双检

第一个覆盖规则是 deadline 双检。如果服务端返回的 Status 是 `CANCELLED`，但本地 deadline 也已经过期，`closedInternal()` 会将 Status 覆盖为 `DEADLINE_EXCEEDED`。

`ClientCallImpl.java:692` — deadline 双检：`CANCELLED` + 本地 deadline 过期 → `DEADLINE_EXCEEDED`

这个规则的意义是：如果客户端已经超时了，它不再关心服务端为什么返回 `CANCELLED`。从客户端的视角看，调用的失败原因是超时，而不是服务端的取消。

### 8.3 规则二：exceptionStatus 覆盖

第二个覆盖规则是 `exceptionStatus`。如果 listener 在 `onHeaders()`、`onMessage()` 或 `onReady()` 中抛了异常，`exceptionThrown()` 会设置 `exceptionStatus` 并调用 `stream.cancel()`。在 `closedInternal()` 中，如果 `exceptionStatus` 非空，它会覆盖服务端返回的 Status。

`ClientCallImpl.java:723` — `exceptionStatus` 覆盖：listener 异常期间覆盖服务器状态

这个规则的意义是：如果 listener 已经无法继续处理消息（因为抛了异常），即使服务端说"一切正常，这是最后一条消息"，客户端也不能再接受这个 Status。`exceptionStatus` 覆盖确保 listener 感知到的错误不会被服务端的 OK 覆盖。

## 九、Context 取消的双向传播

### 9.1 正向传播：Context → gRPC 调用

`CancellationHandler` 实现了 `CancellationListener`，在 `setUp()` 中注册到当前 Context。当 Context 被取消时，`cancelled(Context)` 被调用，进而调用 `stream.cancel(statusFromCancelled(context))`。

这里的关键不是"能取消"，而是"取消原因要被翻译成 gRPC 能理解的 Status"。如果 Context 的取消原因是 `TimeoutException`，`statusFromCancelled()` 产出的是 `DEADLINE_EXCEEDED`；如果取消原因本身就是一个 `StatusRuntimeException`，那对应的 Status 会被保留下来；否则才退回到 `CANCELLED`。这意味着 Context 取消不是一个模糊的布尔信号，而是一条带因果信息的状态传播链。

### 9.2 反向传播：gRPC 调用 → Context

服务端侧，`ServerStreamListenerImpl` 在构造时注册了 Context 的取消监听器。当调用结束时，`closedInternal()` 调用 `context.cancel(cancelCause)` 来反向传播。

`ServerCallImpl.java:292` — 服务端注册 Context 取消监听器
`ServerCallImpl.java:361` — `closedInternal()` 中 `context.cancel(cause)` 反向传播

`onComplete()` 时，`cancelCause` 为 null，表示这个 Context 结束了，但不是因为错误而被取消；`onCancel()` 时，`cancelCause` 非空，表示这次结束带着失败原因。注意这里不是说"业务代码一定会看到一个取消异常"，而是说 Context 这棵树上的下游节点能够感知到这次调用已经结束，并根据 cause 决定自己的清理方式。

### 9.3 级联取消是怎么形成的

Context 的级联取消不是一句口号，而是靠监听器链条形成的。父 Context 被取消时，它通知自己的监听器；子 `CancellableContext` 在注册第一个监听器时，会把自己挂到父 Context 上，所以父取消会级联到子；而 gRPC 调用的 `CancellationHandler` 正是这样一个子节点监听器，于是父 Context 取消就会继续级联到 gRPC 调用。

反过来，服务端在 `closedInternal()` 中调用 `context.cancel(cause)` 后，挂在这个 Context 下面的其他子节点也会收到同样的取消通知。于是整条链条就闭环了：父 Context 取消 → 子 Context 取消 → gRPC 调用取消；gRPC 调用结束 → `context.cancel()` → 下游 Context/监听器感知结束。

这也是为什么 Context 取消和 gRPC 调用取消之间不是简单的单向依赖，而是一个双向、级联的传播模型。

## 十、收网总结

回到开头的困惑：为什么客户端拿到的 Status 和服务端返回的不一致？

因为 `closedInternal()` 中的两个覆盖规则：deadline 双检把服务端返回的 `CANCELLED` 转为 `DEADLINE_EXCEEDED`，`exceptionStatus` 覆盖把 listener 异常期间的服务端 Status 替换为 `CANCELLED`。从客户端的视角看，这两个覆盖是正确的——客户端已经超时了，它关心的是超时，而不是服务端为什么取消；客户端已经抛了异常，服务端说"OK"已经没有意义。

grpc-java 的调用终止模型可以概括为"一个终点，5 条路径，2 个覆盖规则"：

- **一个终点**：`ClientCall.Listener.onClose(Status, Metadata)`，通过 `listenerClosed` 标志保证只调用一次。
- **5 条路径**：正常完成、服务端错误、客户端取消、deadline 超时、Context 取消、transport 错误、listener 异常。
- **2 个覆盖规则**：deadline 双检（`CANCELLED` → `DEADLINE_EXCEEDED`）和 `exceptionStatus` 覆盖（listener 异常期间覆盖服务端 Status）。

**三句话总结：**

1. 一次 gRPC 调用有 5 种终止来源，它们通过 `transportReportStatus()` 统一收敛于 `closedInternal()`，`listenerClosed` 标志保证 `onClose()` 只被调用一次。
2. `closedInternal()` 应用两个覆盖规则：deadline 双检将服务端返回的 `CANCELLED` 转为 `DEADLINE_EXCEEDED`，`exceptionStatus` 覆盖将 listener 异常期间的服务端 Status 替换为 `CANCELLED`。
3. Context 取消与 gRPC 调用取消是双向传播的：Context 取消导致 gRPC 调用取消，gRPC 调用完成也通过 `context.cancel()` 反向传播到 Context。

**下篇预告：** 到这里，ch04 协议语义卷的三篇已经全部完成。下一篇将进入生产诊断卷（ch05），开始讲 deadline、cancel、retry 的线上排障。