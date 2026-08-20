# grpc-java：取消、half-close 与完成边界 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch04-protocol-semantics`
- 篇：`03 取消、half-close 与完成边界`
- 对应主题：`G-SPEC-3 Deadline / Cancel / Completion 契约边界`
- 文章类型：规范层机制总串联篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：一次 gRPC 调用可能以多种方式结束——正常完成、客户端取消、服务端报错、超时、连接中断、Context 取消。这些路径看起来是独立的，但它们最终都走向同一个终点：`ClientCall.Listener.onClose(Status, Metadata)`。读者一直没弄清楚的是：这些路径之间是什么关系？如果客户端在超时前一刻取消了，最终状态是 `CANCELLED` 还是 `DEADLINE_EXCEEDED`？如果服务端已经 close 了，客户端再 cancel 会发生什么？Context 取消和 gRPC 取消之间是什么关系？
- 一句话顿悟：grpc-java 的调用终止有一个统一的收敛模型——所有路径（正常完成、取消、超时、transport 错误、Context 取消、listener 异常）最终都通过 `transportReportStatus()` 到达 `ClientStreamListenerImpl.closedInternal()`，由 `listenerClosed` 标志保证 `onClose()` 只被调用一次；`CANCELLED` 和 `DEADLINE_EXCEEDED` 的优先级由 `closedInternal()` 中的 deadline 双检和 `exceptionStatus` 覆盖机制决定；Context 取消通过 `CancellationListener` 自动传播到 gRPC 调用，服务端取消通过 `context.cancel()` 反向传播到 Context。
- 文章边界：本篇重点解释 half-close 的契约语义、取消的 5 种来源与传播路径、正常完成与错误完成、deadline 与 cancel 的优先级、Context 取消与 gRPC 取消的双向传播、以及 `closedInternal()` 中的收敛逻辑；不展开 Metadata/Status 的编码/解码细节（已在 ch04/02 覆盖），不展开 deadline 在 xDS 场景下的动态配置，不展开生产排障中的取消诊断。

## 前置依赖

### HARD

- `ch04/01-method-type-contracts.md`：已经知道四种方法类型的契约和 `ServerCall.close()` 的语义。
- `ch04/02-metadata-status-trailers.md`：已经知道 Status 的 15 个标准码和 trailers 的编码/解码。
- `ch01/01-stub-channel-clientcall.md`：已经知道 `ClientCall` 的 cancel/halfClose/onClose 接口。

### SOFT

- 不要求先懂 `Context` 的完整实现细节。
- 不要求先懂 `Deadline` 的 ticker 和调度器。

### NAV

- 后续可接：生产诊断卷中的 deadline/cancel/retry 排障。
- 后续可接：`Context` 的传播机制专题。

## 一句话困惑

一次 gRPC 调用有那么多结束方式，它们之间是什么关系？如果客户端在超时前取消，最终状态是 `CANCELLED` 还是 `DEADLINE_EXCEEDED`？如果服务端已经 close 了，客户端再 cancel 会发生什么？Context 取消和 gRPC 取消是怎么互相传播的？

## 一句话顿悟

grpc-java 通过 `ClientStreamListenerImpl.closedInternal()` 统一收敛所有终止路径，`listenerClosed` 标志保证 `onClose()` 只被调用一次；deadline 双检将服务端返回的 `CANCELLED` 转为 `DEADLINE_EXCEEDED`，`exceptionStatus` 覆盖机制将 listener 异常期间的服务器状态替换为 `CANCELLED`；Context 取消通过 `CancellationListener` 传播到 gRPC 调用，服务端调用结束后通过 `context.cancel()` 反向传播到 Context。

## 读者理解路径

1. 先否定"取消和完成是两条独立路径"的直觉。
2. 建立最小总图：5 种终止来源 → `transportReportStatus()` → `closedInternal()` → `onClose()`。
3. 解释 half-close 的契约语义：客户端关闭写入端，服务端收到 `onHalfClose()`，但流不一定结束（服务端仍可发响应）。
4. 解释取消的 5 种来源：客户端 cancel、deadline 超时、Context 取消、transport 错误、服务端错误。
5. 解释正常完成与错误完成：trailers 到达 → `transportTrailersReceived()` → `statusFromTrailers()` → `transportReportStatus()`。
6. 解释 `closedInternal()` 的收敛逻辑：`listenerClosed` 标志、deadline 双检（`CANCELLED` → `DEADLINE_EXCEEDED`）、`exceptionStatus` 覆盖。
7. 解释 deadline 的两种来源：`CallOptions` 和 `Context`，以及它们如何通过 `effectiveDeadline()` 取最小值。
8. 解释 Context 取消的双向传播：Context → `CancellationHandler.cancelled()` → `stream.cancel()`；服务端 → `context.cancel()`。
9. 收束到：所有路径最终收敛于 `onClose()`，一次调用一个结果。

## 失败方案推演

### 失败方案一：取消和完成是两条独立的路径，不会互相影响

- 这是一个很自然的直觉：客户端 cancel 就是一条路径，服务端 close 是另一条，它们互不干扰。
- 但实际实现中，这两条路径可能同时发生——客户端在 `onMessage()` 中抛了异常，触发了 `exceptionThrown()` → `stream.cancel()`，而此时服务端可能已经发送了正常的 trailers。`closedInternal()` 中的 `exceptionStatus` 覆盖机制就是用来处理这种竞态：如果 listener 抛了异常，服务端返回的 Status 被覆盖为 `CANCELLED`。
- 所以取消和完成不是独立的，它们通过 `exceptionStatus` 和 `listenerClosed` 标志在 `closedInternal()` 中收敛。

### 失败方案二：deadline 超时 = 取消，用 CANCELLED 就够了

- 如果 deadline 超时直接用 `CANCELLED`，那客户端就无法区分"调用被取消"和"调用超时"——两者都是 `Status.CANCELLED`，但它们的语义不同（取消是主动的，超时是时间的）。
- 所以 grpc-java 用 `DEADLINE_EXCEEDED` 而不是 `CANCELLED` 来表示超时。`formatDeadlineExceededStatus()` 返回 `DEADLINE_EXCEEDED` 且带有具体的超时描述。
- 而且 `closedInternal()` 中有一个 deadline 双检：如果服务端返回了 `CANCELLED`，但本地 deadline 也已经过期，它会将 `CANCELLED` 覆盖为 `DEADLINE_EXCEEDED`——因为从客户端的角度看，调用失败的原因更可能是超时。

### 失败方案三：Context 取消只会影响 gRPC 调用，不会反向传播

- 你可能认为 Context 取消是单向的：Context 取消 → gRPC 调用取消。但服务端调用结束后，`ServerStreamListenerImpl.closedInternal()` 会调用 `context.cancel(cancelCause)` 来反方向传播——服务端完成时通知 Context。
- 这意味着 Context 取消和 gRPC 调用取消之间是双向传播的：Context 取消导致 gRPC 调用取消，gRPC 调用完成（无论成功或失败）也会导致 Context 取消（通过 `context.cancel()` 传播到子 Context）。
- 所以 Context 和 gRPC 调用之间是一个双向的、级联的取消关系。

## 必须澄清的误解

1. half-close 不等于调用结束——客户端关闭写入端后，服务端仍然可以继续发送响应。
2. `CANCELLED` 和 `DEADLINE_EXCEEDED` 是两种不同的 Status，语义不同，grpc-java 通过 deadline 双检确保超时返回 `DEADLINE_EXCEEDED` 而不是 `CANCELLED`。
3. `onClose()` 只被调用一次——`listenerClosed` 标志保证在多条路径同时到达时只有一个 `onClose()` 被交付。
4. Context 取消与 gRPC 调用取消是双向传播的，不是单向的。
5. 服务端 `onCancel()` 和 `onComplete()` 是互斥的——`closedInternal()` 的 `isOk()` 判断确保了它们不会同时触发。

## 文章结构与字数预算

1. 困惑开场：为什么"一次调用结束"不是一件简单的事（800-1000 字）
2. 最小总图：5 种终止来源 → 统一收敛 → `onClose()`（1000-1400 字）
3. half-close 的语义：客户端关闭写入端，但流不一定结束（1200-1600 字）
4. 取消的 5 种来源：客户端 cancel、deadline、Context、transport、服务端错误（1800-2400 字）
5. 正常完成与错误完成：trailers 到达 → Status 提取 → `transportReportStatus()`（1200-1600 字）
6. `closedInternal()` 的收敛逻辑：`listenerClosed`、deadline 双检、`exceptionStatus` 覆盖（1800-2400 字）
7. Context 取消的双向传播（800-1000 字）
8. 收网总结（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### half-close
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:499` — `halfCloseInternal()` 检查状态
- `core/src/main/java/io/grpc/internal/AbstractClientStream.java:190` — `halfClose()` 设置 `outboundClosed`
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:349` — `ServerStreamListenerImpl.halfClosed()` 调用 `listener.onHalfClose()`

### 取消 5 种来源
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:459` — `cancelInternal()` 创建 `Status.CANCELLED`，调用 `stream.cancel()`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:392` — `CancellationHandler.run()` deadline 超时 → `stream.cancel(formatDeadlineExceededStatus())`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:382` — `CancellationHandler.cancelled(Context)` Context 取消 → `stream.cancel(statusFromCancelled(context))`
- `core/src/main/java/io/grpc/internal/Http2ClientStreamTransportState.java:172` — transport 错误 → `transportReportStatus(error)`
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:272` — `handleInternalError()` → `stream.cancel(status)`

### 正常完成与错误完成
- `core/src/main/java/io/grpc/internal/Http2ClientStreamTransportState.java:172` — `transportTrailersReceived()` 接收 trailers
- `core/src/main/java/io/grpc/internal/Http2ClientStreamTransportState.java:193` — `statusFromTrailers()` 提取 Status
- `core/src/main/java/io/grpc/internal/AbstractClientStream.java:377` — `inboundTrailersReceived()` 交付 trailers
- `core/src/main/java/io/grpc/internal/AbstractClientStream.java:401` — `transportReportStatus()` 设置 `statusReported`，等待 deframer 关闭，调用 `closeListener()`

### 收敛逻辑
- `core/src/main/java/io/grpc/internal/AbstractClientStream.java:456` — `closeListener()` 中 `listenerClosed` 标志确保只调用一次
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:689` — `closedInternal()` 收敛点
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:692` — deadline 双检：`CANCELLED` + 本地 deadline 过期 → `DEADLINE_EXCEEDED`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:723` — `exceptionStatus` 覆盖：listener 异常期间覆盖服务器状态

### deadline
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:396` — `formatDeadlineExceededStatus()` 返回 `DEADLINE_EXCEEDED`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:248` — deadline 已过期 → `FailingClientStream` 带 `DEADLINE_EXCEEDED`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:425` — `effectiveDeadline()` 取 `min(CallOptions, Context)` 最小值
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:352` — `CancellationHandler.setUp()` 调度 deadline 定时器

### Context 取消传播
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:334` — `CancellationHandler` 实现 `CancellationListener`
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:292` — 服务端注册 Context 取消监听器
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:361` — `closedInternal()` 中 `context.cancel(cause)` 反向传播
- `api/src/main/java/io/grpc/Contexts.java:128` — `statusFromCancelled()` 将 Context 取消转为 Status

### 服务端完成
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:217` — `closeInternal()` 正常关闭
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:361` — `ServerStreamListenerImpl.closedInternal()` 分发 `onComplete()`/`onCancel()`
- `core/src/main/java/io/grpc/internal/AbstractServerStream.java:123` — `close()` 发送 trailers
- `core/src/main/java/io/grpc/internal/AbstractServerStream.java:295` — `transportReportStatus()` 服务端 transport 错误
- `core/src/main/java/io/grpc/internal/AbstractServerStream.java:319` — `complete()` 正常完成

## 测试证据清单

- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:168` — `statusPropagatedFromStreamToCallListener` 基本状态传播
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:189` — `exceptionInOnMessageTakesPrecedenceOverServer` exceptionStatus 覆盖
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:693` — `contextCancellationCancelsStream` Context 取消传播
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:720` — `contextAlreadyCancelledNotifiesImmediately` 已取消的 Context 在 start 时生效
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:768` — `deadlineExceededBeforeCallStarted` deadline 已过期
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:908` — `expiredDeadlineCancelsStream_CallOptions` CallOptions deadline 超时
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:933` — `expiredDeadlineCancelsStream_Context` Context deadline 超时
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:977` — `streamCancelAbortsDeadlineTimer` 取消中止 deadline 定时器
- `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:386` — `streamListener_halfClosed` halfClose 传播
- `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:408` — `streamListener_closedOk` 正常完成
- `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:423` — `streamListener_closedCancelled` 取消完成
- `api/src/test/java/io/grpc/ContextsTest.java:215` — `statusFromCancelled_TimeoutExceptionShouldMapToDeadlineExceeded`

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讨论的是 grpc-java 的 cancel/halfClose/completion 实现，不展开 xDS 场景下的动态配置。
- `Context` 的 `CancellableContext` 实现是 grpc-java 自己的，不展开 Java 标准库中的 `ExecutorService` 取消机制。
- `Deadline` 的 `Ticker` 支持在测试中替换，但不在本篇展开。

## 与其他篇的边界

### 本篇要讲清

- half-close 的契约语义：客户端关闭写入端后服务端的行为。
- 取消的 5 种来源及传播路径。
- `closedInternal()` 的收敛逻辑：`listenerClosed`、deadline 双检、`exceptionStatus` 覆盖。
- Context 取消与 gRPC 取消的双向传播。
- 服务端 `onComplete()` 与 `onCancel()` 的互斥关系。

### 本篇不深讲

- Status 的编码/解码细节（已在 ch04/02 覆盖）。
- Metadata 的 key-value 机制（已在 ch04/02 覆盖）。
- deadline 在 xDS 场景下的动态配置。
- 生产排障中的取消诊断（留给生产诊断卷）。

## 写作后检查

- [ ] 开篇先抓"一次调用结束不简单"而不是直接讲 cancel 接口。
- [ ] 至少展开 3 个失败方案，且包含"deadline 超时 = 取消""Context 取消是单向的"。
- [ ] 明确给出 5 种终止来源 → `transportReportStatus()` → `closedInternal()` → `onClose()` 的收敛总图。
- [ ] 不把本篇写成 ClientCallImpl 的状态标志说明书。
- [ ] 每个核心机制（deadline 双检、exceptionStatus 覆盖、listenerClosed 标志）先讲动机再给证据。
- [ ] 删除代码块后，读者仍能复述 5 种终止来源、收敛逻辑、deadline 双检、Context 双向传播。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。