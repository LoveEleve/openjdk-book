# grpc-java：Deadline、Cancel、Retry 的线上排障 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `ClientCallImpl.startInternal()` 先计算 effective deadline，如果 deadline 在 start 前已过期，直接创建 `FailingClientStream(DEADLINE_EXCEEDED)`，证据：`core/src/main/java/io/grpc/internal/ClientCallImpl.java:244`、`:248`、`:262`。
2. `CancellationHandler.setUp()` 会在 deadline 非 Context 来源时挂本地定时器，并注册 Context listener，证据：`ClientCallImpl.java:352`、`:356`、`:361`。
3. 本地 deadline 定时器触发时，`CancellationHandler.run()` 直接 `stream.cancel(formatDeadlineExceededStatus())`，证据：`ClientCallImpl.java:392`、`:396`。
4. `CancellationHandler.cancelled(Context)` 对 Context 取消做两路分发：`TimeoutException` → `DEADLINE_EXCEEDED`，其余 → `statusFromCancelled(context)`，证据：`ClientCallImpl.java:382`、`:385`、`api/src/main/java/io/grpc/Contexts.java:128`、`:138`。
5. 显式 `ClientCall.cancel()` 创建 `Status.CANCELLED`，调用 `stream.cancel(status)`，并清理 deadline/Context 钩子，证据：`ClientCallImpl.java:459`、`:481`、`:485`。
6. `transportReportStatus()` 是客户端终止收敛前的公共入口，`closeListener()` 中 `listenerClosed` 标志保证只交付一次，证据：`core/src/main/java/io/grpc/internal/AbstractClientStream.java:401`、`:456`。
7. `ClientStreamListenerImpl.closedInternal()` 是最终收敛点，deadline 双检把远端 `CANCELLED` 改写成 `DEADLINE_EXCEEDED`，`exceptionStatus` 覆盖会用本地 listener 异常对应状态覆盖服务器状态，证据：`ClientCallImpl.java:689`、`:692`、`:723`。
8. listener 在 `onHeaders()`、`onMessage()`、`onReady()` 中抛异常时，`exceptionThrown()` 会记录 `exceptionStatus` 并 cancel stream，证据：`ClientCallImpl.java:589`、`:623`、`:671`、`:774`。
9. `RetriableStream.Sublistener.closed()` 在 attempt 关闭后进入 retry/hedging 决策，`makeRetryDecision()` 依赖 retry policy、retryable code、attempt 上限和 throttle 状态，证据：`core/src/main/java/io/grpc/internal/RetriableStream.java:950`、`:1006`、`:1065`。
10. `RetriableStream.setDeadline()` 会把同一个 absolute deadline replay 到所有 substreams，新 attempt 不会获得新的整轮预算，证据：`RetriableStream.java:753`。
11. `RetriableStream.cancel()` 对未 commit 的逻辑 RPC 会先 commit 一个 noop winner，再做 post-commit 清理，证据：`RetriableStream.java:526`。
12. commit 后会取消 scheduled retry、scheduled hedge 和 loser substreams，证据：`RetriableStream.java:167`。
13. `ManagedChannelImpl.shutdown()` 保留未提交 retriable streams 的存活空间，`shutdownNow()` 才会强杀它们，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1264`、`:1286`、`:959`、`:1299`。
14. HTTP/2 `CANCEL` 映射到 gRPC `CANCELLED`，不是所有 transport 错误都走 `UNAVAILABLE`，证据：`core/src/main/java/io/grpc/internal/GrpcUtil.java:347`、`:340`。

### 测试证据已核对

1. `ClientCallImplTest.java:693` — Context 取消传播到 stream。
2. `ClientCallImplTest.java:720` — 已取消 Context 在 start 时立即结束。
3. `ClientCallImplTest.java:768` — deadline start 前已过期。
4. `ClientCallImplTest.java:908` — CallOptions deadline 超时。
5. `ClientCallImplTest.java:933` — Context deadline 超时。
6. `ClientCallImplTest.java:977` — cancel 会中止 deadline 定时器。
7. `ClientCallImplTest.java:189` — listener 异常覆盖服务端状态。
8. `RetriableStreamTest.java:722` — cancel during retry lifecycle。
9. `RetriableStreamTest.java:1424` — pushback / throttling 影响 retry。
10. `RetriableStreamTest.java:2042` — hedging 与 loser cancel。
11. `ManagedChannelImplTest.java:3396` — `shutdown()` 后 retry backoff 仍继续。
12. `ManagedChannelImplTest.java:3512` — `shutdown()` 后 hedge 仍继续。
13. `ContextsTest.java:215` — `TimeoutException` → `DEADLINE_EXCEEDED`。

### 深审发现

1. **高风险：容易把最终 Status 当成原始来源。** 当前正文已把“来源层 → 重试层 → 收敛层”拉开，并强调 `closedInternal()` 会改写最终状态。  
2. **高风险：容易把 retry 看成状态码驱动。** 当前正文已压回 `RpcProgress`、policy、pushback、throttle、commit 这组联合条件。  
3. **中风险：容易误判 `shutdown()` 后继续 retry 是泄漏。** 当前正文已补 `shutdown()` 与 `shutdownNow()` 的语义差异。  
4. **中风险：容易忽略 listener 异常导致的本地 `CANCELLED`。** 当前正文已把它单独列成一类来源。  
5. **低风险：容易把 deadline 当成每个 retry attempt 的独立预算。** 当前正文已明确 absolute deadline replay 到所有 substreams。  

## 第二轮：因果审

- 最终 `Status` 必须允许被改写，否则客户端无法区分“远端取消”和“本地 deadline 已过期”这两种更关键的排障语义：✅  
- retry/hedging 不能只看状态码，否则 `REFUSED`、`DROPPED`、pushback、throttle、attempt 上限这些因素都会被误判：✅  
- `shutdown()` 不能强杀已启动 retriable RPC，否则 graceful shutdown 会破坏正在 backoff 中的逻辑 RPC 语义：✅  
- listener 异常必须覆盖服务端状态，否则应用侧本地处理失败会被误记录成远端成功：✅  
- Context 取消必须带原因翻译为 Status，否则 deadline 与普通 cancel 无法区分：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → 最小总图 → `DEADLINE_EXCEEDED` 来源链 → `CANCELLED` 来源链 → 收敛改写 → retry/hedging 决策 → cancel 与 attempts/shutdown 互动 → 排障三问法总结”推进，没有退化成 `ClientCallImpl` 字段说明书。

失败方案已覆盖：
- 最终 Status 等于最初来源  
- retry 只看状态码  
- `shutdown()` 和 `shutdownNow()` 都会立刻杀掉重试中的调用  

每一层拆解均包含：线上现象 → 源码链路 → 排障结论，符合生产诊断卷定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- `DEADLINE_EXCEEDED` 的三条来源链  
- `CANCELLED` 的四类来源链  
- `closedInternal()` 的两条覆盖规则（deadline 双检、`exceptionStatus`）  
- retry/hedging 的联合决策条件  
- `shutdown()` vs `shutdownNow()` 的排障差异  
- 排障三问法  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重讲 MethodType 契约（已在 ch04/01）。✅  
- 未重讲 Metadata/Status 编码基础（已在 ch04/02）。✅  
- 未重讲 cancel/half-close 基础语义（已在 ch04/03）。✅  
- 未扩入 xDS/LB/resolver 的更复杂 retry routing 场景。✅  
- 重点仍压在客户端视角的 deadline/cancel/retry 排障链路与最终 Status 收敛，边界收得住。✅

## 第六轮：依赖审

- 已直接承接 ch03/01：`RetriableStream` 的基础机制已知，本篇把它转成线上判因视角。✅  
- 已承接 ch04/02 和 ch04/03：Status 编码/解码与 `closedInternal()` 收敛逻辑已知，本篇补充排障三问法。✅  
- `ClientCallImplTest`、`RetriableStreamTest`、`ManagedChannelImplTest`、`ContextsTest` 的组合足以支撑“来源层 + 重试层 + 收敛层”的论断。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：使用少量文字图与简短示意代码块，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验 `ClientCallImpl`、`AbstractClientStream`、`RetriableStream`、`ManagedChannelImpl`、`GrpcUtil`、`Contexts`。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数（不含代码块与空白行）：约 `19,382`。  
- 目标定位：生产诊断卷首篇，篇幅与结构均满足要求。✅

## 结论

当前三件套的目标明确：这一篇应把 `DEADLINE_EXCEEDED`、`CANCELLED`、retry、hedging、shutdown 行为从“零散现象”提升到“来源层 → 重试层 → 收敛层”的统一排障模型，讲清最终 `Status` 为什么经常不是最初来源，以及线上如何用“谁先终止、是否已 commit、本地 deadline 是否过期”三问法快速判因。