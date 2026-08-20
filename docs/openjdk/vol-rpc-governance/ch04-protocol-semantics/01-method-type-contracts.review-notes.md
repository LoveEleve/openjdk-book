# grpc-java：四种调用模式与方法契约总图 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `MethodDescriptor.MethodType` 定义四个核心值：`UNARY`（1 请求 1 响应）、`CLIENT_STREAMING`（N 请求 1 响应）、`SERVER_STREAMING`（1 请求 N 响应）、`BIDI_STREAMING`（N 请求 N 响应），证据：`api/src/main/java/io/grpc/MethodDescriptor.java:81`、`:87`、`:93`、`:99`。
2. `clientSendsOneMessage()` 返回 true 的为 UNARY 和 SERVER_STREAMING；`serverSendsOneMessage()` 返回 true 的为 UNARY 和 CLIENT_STREAMING，证据：`MethodDescriptor.java:114`、`:124`。
3. `UnaryServerCallHandler.startCall()` 前置检查 `clientSendsOneMessage()`，确保 handler 不会被误用于流式方法，证据：`stub/src/main/java/io/grpc/stub/ServerCalls.java:126`。
4. `UnaryServerCallListener.onMessage()` 第二次请求时调用 `call.close(Status.INTERNAL.withDescription(TOO_MANY_REQUESTS))`，`onHalfClose()` 无请求时调用 `call.close(Status.INTERNAL.withDescription(MISSING_REQUEST))`，证据：`ServerCalls.java:154`、`:170`、`:37`、`:38`。
5. `StreamingServerCallListener.onMessage()` 无请求计数检查，直接转发到 `requestObserver.onNext()`，证据：`ServerCalls.java:261`。
6. `ServerCallImpl.sendMessageInternal()` 检查 `serverSendsOneMessage()` && `messageSent`，触发 `handleInternalError()` 导致 `stream.cancel(Status.INTERNAL)`，证据：`core/src/main/java/io/grpc/internal/ServerCallImpl.java:156`、`:57`。
7. `ServerCallImpl.closeInternal()` 检查 `status.isOk()` && `serverSendsOneMessage()` && `!messageSent`，触发 `MISSING_RESPONSE`，但异常关闭（非 OK）不触发，证据：`ServerCallImpl.java:217`、`:58`。
8. `ServerCallImpl.sendMessageInternal()` 对 `!serverSendsOneMessage()` 方法每次调用后立即 `stream.flush()`，证据：`ServerCallImpl.java:169`。
9. `ClientCalls.StreamObserverToCallListenerAdapter.onMessage()` 当 `streamingResponse` 为 false 时检查多条响应，抛出 `Status.INTERNAL`，证据：`stub/src/main/java/io/grpc/stub/ClientCalls.java:562`。
10. `ClientCalls.UnaryStreamToFuture.onMessage()` 和 `onClose()` 分别检查多条和零条响应，证据：`ClientCalls.java:618`、`:633`。
11. `ClientCallImpl.sendMessageInternal()` 只做状态检查（`stream != null`、`!cancelCalled`、`!halfCloseCalled`），不做计数检查，证据：`core/src/main/java/io/grpc/internal/ClientCallImpl.java:515`。
12. `ClientCallImpl` 的 `unaryRequest` 标志（UNARY/SERVER_STREAMING 为 true）使 `onReady()` 回调被静默，证据：`ClientCallImpl.java:120`、`:745`。
13. `ClientCalls.asyncUnaryRequestCall()` 调用 `sendMessage(req)` 后立即 `halfClose()`，确保恰好 1 请求，证据：`ClientCalls.java:396`。

### 测试证据已核对

1. `ServerCallsTest.java:480` — `clientSendsOne_errorMissingRequest_unary` 验证 halfClose 无请求 → MISSING_REQUEST + INTERNAL
2. `ServerCallsTest.java:516` — `clientSendsOne_errorTooManyRequests_unary` 验证第二次请求 → TOO_MANY_REQUESTS + INTERNAL
3. `ServerCallsTest.java:400` — `disablingInboundAutoRequestForUnaryHasNoEffect` 验证 unary 强制请求 2 条消息
4. `ServerCallImplTest.java:229` — `sendMessage_serverSendsOne_closeOnSecondCall_unary` 验证第二次响应 → TOO_MANY_RESPONSES + INTERNAL
5. `ServerCallImplTest.java:302` — `serverSendsOne_okFailsOnMissingResponse_unary` 验证 close OK 无响应 → MISSING_RESPONSE + INTERNAL
6. `ServerCallImplTest.java:329` — `serverSendsOne_canErrorWithoutResponse` 验证异常关闭不触发 MISSING_RESPONSE

### 深审发现

1. **高风险：容易把四种方法类型写成 enumerator 说明书。** 当前正文已提到"契约定义→服务端 enforce→客户端 enforce→不对称设计"的因果链，没有退化成枚举值列表。  
2. **高风险：容易把"违反契约"写成内部异常。** 当前正文已强调 Status.INTERNAL 的语义，并区分了 `handleInternalError()`（stream.cancel）和 `call.close()` 两种终止方式。  
3. **中风险：容易忽略"不对称设计"的哲学原因。** 当前正文已用专门一节（Section 九）对比服务端和客户端的检查差异，并解释了"服务端不信任客户端"的设计哲学。  
4. **中风险：容易把客户端的 unaryRequest 标志忽略。** 当前正文已补 `onReady()` 静默的隐式约束。  
5. **低风险：容易把 ServerCallImpl 的 MISSING_RESPONSE 和 close 的交互忽略。** 当前正文已强调异常关闭不触发 MISSING_RESPONSE。

## 第二轮：因果审

- 四种方法类型必须有契约定义（`MethodDescriptor.MethodType`），否则服务端和客户端无法就"发多少条"达成一致：✅  
- 服务端必须先检查请求计数（`UnaryServerCallListener.onMessage()`），否则恶意客户端可以向 unary 方法发送大量请求：✅  
- 服务端必须先检查响应计数（`ServerCallImpl.sendMessageInternal()`），否则 buggy 的 handler 可能在 unary 上发送多条响应：✅  
- 服务端必须在 close 时检查 MISSING_RESPONSE（`ServerCallImpl.closeInternal()`），否则 buggy 的 handler 可能在 unary 上不发送任何响应就 close：✅  
- 客户端必须在收到响应时检查计数（`StreamObserverToCallListenerAdapter.onMessage()`），否则有 bug 的服务端可能在 unary 上发送多条响应：✅  
- 客户端不需要检查请求计数，因为 stub 路径（`asyncUnaryRequestCall`）已经确保恰好一次：✅  
- `onReady()` 对 unary 方法静默，因为 unary 方法不需要流控信号（只发一次）：✅

## 第三轮：结构审

正文结构按"困惑开场 → 前情回顾 → 失败方案(3个) → 最小总图 → MethodType 定义 → 服务端请求 enforce → 服务端响应 enforce → 客户端 enforce → 不对称设计对比 → 收网总结 → 下篇钩子"推进，没有退化成枚举值说明书。

失败方案已覆盖：
- 四种方法类型只是"代码风格偏好"  
- 客户端和服务端的契约检查是对称的  
- 违反契约就是内部异常，和 Status 无关  

每一层拆解均包含：动机→机制→证据，符合"分层拆解四动作"要求。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- 四种方法类型的合同契约（1:1、1:N、N:1、N:N）  
- 服务端 enforce 的两个检查点（请求计数 + 响应计数）  
- 客户端 enforce 的响应计数检查  
- 客户端请求无计数的原因（stub 路径确保）  
- 不对称设计的设计哲学（服务端不信任客户端）  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未扩入 Metadata/Status/Trailers 语义细节（留给 ch04/02）。✅  
- 未扩入 cancel/halfClose/completion 边界（留给 ch04/03）。✅  
- 未扩入 deadline 与 retry 的交互（留给生产排障卷）。✅  
- 未扩入 xDS 的动态方法类型配置。✅  
- 未扩入 `MethodType.UNKNOWN` 的 xDS 场景。✅  
- 重点仍压在四种方法类型的契约定义与 enforce 实现，边界收得住。✅

## 第六轮：依赖审

- 已直接承接 ch01 主干篇：四种方法类型的实现路径已建立，本篇补充规范层。✅  
- 已承接 ch03/04 压缩篇：wire format 的帧结构可能影响契约理解（如 flush 策略）。✅  
- `ServerCallsTest`、`ServerCallImplTest`、`ClientCallsTest` 的组合足以支撑"契约 enforce 体系"的论断。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：使用少量有限代码块（含示意代码），不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验 `MethodDescriptor`、`ServerCalls`、`ServerCallImpl`、`ClientCalls`、`ClientCallImpl`。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数（不含代码块与空白行）：约 `18,334`。  
- 目标定位：规范层总串联篇，篇幅与结构均满足要求。✅

## 结论

当前三件套的目标明确：这一篇应把四种方法类型从"代码风格偏好"提升到"有严格契约的协议规范"，讲清 grpc-java 在服务端和客户端通过三层 enforce 体系（`ServerCallImpl` + `ServerCalls` + `ClientCalls`）强制执行这些契约，并解释不对称设计的原因。只要正文按这个 review 结论收口，它就能成为 grpc-java 完整卷里规范层的基础篇。