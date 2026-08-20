# grpc-java：Deadline、Cancel、Retry 的线上排障 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch05-production-diagnostics`
- 篇：`01 Deadline、Cancel、Retry 的线上排障`
- 对应主题：`G-PROD-1 调用超时 / 取消 / 重试排障`
- 文章类型：生产诊断专题篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：线上看到的 `DEADLINE_EXCEEDED`、`CANCELLED`、重试、hedging、transport 错误看起来都像“请求没成功”，但它们在 grpc-java 里来自完全不同的代码路径。为什么同样是一个失败，有时是 `DEADLINE_EXCEEDED`，有时是 `CANCELLED`，有时又会自动重试？为什么服务端明明返回了 `CANCELLED`，客户端最终却看到 `DEADLINE_EXCEEDED`？为什么 `shutdown()` 之后某些重试中的调用还会继续跑？
- 一句话顿悟：grpc-java 的线上失败不是“一个异常码打天下”，而是由一条收敛链决定：deadline、显式 cancel、Context cancel、listener 异常、transport 失败、retry/hedging 决策都会先在各自的来源层形成局部 Status，再通过 `transportReportStatus()`、`closedInternal()` 和 `RetriableStream` 的 commit/取消逻辑收敛成最终结果；排障时要先区分“谁先发起终止”“是否还有未提交的 attempt”“本地 deadline 是否已过期”，再谈最终看到的 Status。
- 文章边界：本篇重点讲客户端视角下的 deadline/cancel/retry 线上排障链路，解释 `DEADLINE_EXCEEDED`、`CANCELLED`、retry、hedging、transport error 在源码中的来源、覆盖规则和收敛方式；不重讲 MethodType 契约、Metadata/Status 基础语义，也不展开 xDS/负载均衡策略全景。

## 前置依赖

### HARD

- `ch03/01-service-config-retry-hedging.md`：已经知道 retry/hedging 的基本机制和 `RetriableStream`。
- `ch04/02-metadata-status-trailers.md`：已经知道 Status 的编码/解码与 trailers 语义。
- `ch04/03-cancel-halfclose-completion.md`：已经知道 `closedInternal()` 的收敛逻辑与 deadline 双检。

### SOFT

- 不要求先懂 Netty HTTP/2 handler 细节。
- 不要求先懂 xDS、LB、resolver 的全部实现。

### NAV

- 后续可接：`ch05/02-channel-subchannel-picker-diagnosis`
- 后续可接：`ch05/03-keepalive-flowcontrol-connection`

## 一句话困惑

线上看到 `DEADLINE_EXCEEDED`、`CANCELLED`、自动重试、hedging、transport error 时，怎么从现象反推出源码里的真正终止来源？为什么同样一个失败，最终 Status 会被本地 deadline 或 listener 异常“改写”？

## 一句话顿悟

线上排障要抓三件事：第一，终止最初是谁发起的（deadline、显式 cancel、Context、transport、服务端错误、listener 异常）；第二，这个调用是否还是一个未提交的逻辑 RPC（`RetriableStream` 还可能重试/hedge）；第三，本地 effective deadline 是否已经过期；只有把这三件事串起来，`CANCELLED`、`DEADLINE_EXCEEDED`、retry、hedging、shutdown 后继续运行这些现象才会变得可解释。

## 读者理解路径

1. 先否定“失败就是一个状态码”的粗糙理解。
2. 建立最小总图：终止来源 → 本地/远端 Status 形成 → retry/hedging 是否继续 → `closedInternal()` 收敛 → 最终 `onClose()`。
3. 解释 `DEADLINE_EXCEEDED` 的三个来源：start 前已过期、定时器触发、Context deadline。
4. 解释 `CANCELLED` 的四类来源：显式 cancel、Context 非超时取消、transport cancel、listener 异常。
5. 解释为什么远端 `CANCELLED` 可能被本地改写成 `DEADLINE_EXCEEDED`。
6. 解释 retry/hedging 在 `RetriableStream` 中的决策点：retryable status、pushback、throttle、attempt 限额、commit。
7. 解释 cancel 如何与未提交 attempt、scheduled retry、scheduled hedge 互动。
8. 解释 `shutdown()` 与 `shutdownNow()` 的排障差异：为何前者允许回退中的重试继续，后者直接杀掉。
9. 收束到“排障三问法”：谁先终止、是否已 commit、本地 deadline 是否过期。

## 失败方案推演

### 失败方案一：`DEADLINE_EXCEEDED` 和 `CANCELLED` 只是不同名字的失败

- 这会把“主动取消”和“时间预算耗尽”混成一类。
- grpc-java 明确区分：显式 cancel、非超时 Context 取消通常是 `CANCELLED`；deadline 到期走 `DEADLINE_EXCEEDED`。
- `closedInternal()` 还会把服务端送来的 `CANCELLED` 改写成客户端本地的 `DEADLINE_EXCEEDED`，说明二者语义不能混用。

### 失败方案二：看到最终 Status，就等于知道了失败来源

- 最终 `Status` 只是收敛结果，不一定等于最初来源。
- listener 异常会用 `exceptionStatus` 覆盖服务端返回的 `OK` 或别的状态。
- 本地 deadline 过期会把服务端返回的 `CANCELLED` 覆盖成 `DEADLINE_EXCEEDED`。
- 所以排障不能只看最终码，还要看谁先触发了终止链。

### 失败方案三：retry 是否发生，只看状态码是不是 `UNAVAILABLE`

- retry 不是“看到某个码就自动重试”。
- 它还取决于 `RpcProgress`、retry policy、retryable status codes、pushback、throttling、attempt 次数、是否已经 commit。
- 某些 transport 失败会走 transparent retry，某些 `UNAVAILABLE` 也可能因为 attempt 已满或 throttle 被拒绝。
- 所以排障不能只盯着状态码，还要看 `RetriableStream` 的决策上下文。

## 必须澄清的误解

1. 服务端返回 `CANCELLED`，客户端最终看到 `DEADLINE_EXCEEDED` 并不矛盾——这是本地 deadline 双检改写的结果。
2. `shutdown()` 不会立即杀掉已经在 backoff/hedging 阶段的未提交逻辑 RPC；`shutdownNow()` 才会强杀。
3. listener 回调里的异常会覆盖服务端的最终状态，导致看起来像“网络取消”。
4. retry/hedging 是否继续不是状态码单独决定，而是状态码 + 进度 + policy + throttle + commit 状态共同决定。
5. 一个逻辑 RPC 的 deadline 是绝对时间，不会因为 retry 新 attempt 而“重置一轮预算”。

## 文章结构与字数预算

1. 困惑开场：为什么“同样失败”会看到完全不同的状态码（800-1000 字）
2. 最小总图：来源层 → 重试层 → 收敛层（1000-1400 字）
3. `DEADLINE_EXCEEDED` 的三条来源链（1400-2000 字）
4. `CANCELLED` 的四类来源链（1400-2000 字）
5. `closedInternal()` 如何改写最终状态（1200-1600 字）
6. `RetriableStream` 的 retry/hedging 决策点（1800-2400 字）
7. cancel 与未提交 attempts / scheduled retries 的互动（1400-2000 字）
8. `shutdown()` vs `shutdownNow()` 的线上误判（1000-1400 字）
9. 收网总结：排障三问法（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### deadline / cancel 来源
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:194` — Context 已取消时不创建真实 stream，直接 `onClose(statusFromCancelled(context))`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:244` — `effectiveDeadline()` 与 `CancellationHandler` 创建
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:248` — deadline 已过期 → `FailingClientStream(DEADLINE_EXCEEDED)`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:352` — `CancellationHandler.setUp()` 调度 deadline 定时器并注册 Context listener
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:382` — `CancellationHandler.cancelled(Context)` Context 取消传播
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:392` — deadline 定时器触发 → `stream.cancel(formatDeadlineExceededStatus())`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:396` — `formatDeadlineExceededStatus()`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:459` — 显式 `cancelInternal()` 创建 `Status.CANCELLED`
- `api/src/main/java/io/grpc/Contexts.java:128` — `statusFromCancelled()`
- `api/src/context/java/io/grpc/Context.java:696` — deadline 到期通过 `TimeoutException` 取消 Context

### 收敛逻辑
- `core/src/main/java/io/grpc/internal/AbstractClientStream.java:401` — `transportReportStatus()`
- `core/src/main/java/io/grpc/internal/AbstractClientStream.java:456` — `closeListener()` 的 `listenerClosed` 标志
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:689` — `closedInternal()` 收敛点
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:692` — deadline 双检改写 `CANCELLED` → `DEADLINE_EXCEEDED`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:723` — `exceptionStatus` 覆盖

### retry / hedging
- `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:333` — retry policy 解析与 capped attempts
- `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:380` — hedging policy 解析与 capped attempts
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:483` — 构造 `RetryStream extends RetriableStream`
- `core/src/main/java/io/grpc/internal/RetriableStream.java:753` — deadline replay 到每个 substream
- `core/src/main/java/io/grpc/internal/RetriableStream.java:950` — `Sublistener.closed()` 开始 retry/hedging 决策
- `core/src/main/java/io/grpc/internal/RetriableStream.java:1006` — `makeRetryDecision()`
- `core/src/main/java/io/grpc/internal/RetriableStream.java:1065` — retry 需要 retryPolicy + retryable code + 未超次数 + 未 throttle
- `core/src/main/java/io/grpc/internal/RetriableStream.java:1099` — `makeHedgingDecision()`
- `core/src/main/java/io/grpc/internal/RetriableStream.java:526` — cancel 未提交逻辑 RPC 时 commit noop winner 并关闭 master listener
- `core/src/main/java/io/grpc/internal/RetriableStream.java:167` — commit 后取消 scheduled retry/hedge 与 loser substreams

### shutdown 差异
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1264` — `shutdown()` 路径
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1286` — 未提交 retriable streams 保护 delayed transport 不立即终止
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:959` — `shutdownNow()` 路径
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1299` — `shutdownNow()` 强杀 uncommitted retriable streams

## 测试证据清单

- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:189` — listener 异常覆盖服务端状态
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:693` — Context 取消传播到 stream
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:720` — 已取消 Context 在 start 时立即结束
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:768` — deadline start 前已过期
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:908` — CallOptions deadline 超时
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:933` — Context deadline 超时
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:977` — cancel 会中止 deadline 定时器
- `core/src/test/java/io/grpc/internal/RetriableStreamTest.java:722` — cancel during retry lifecycle
- `core/src/test/java/io/grpc/internal/RetriableStreamTest.java:1424` — pushback / throttling 影响 retry
- `core/src/test/java/io/grpc/internal/RetriableStreamTest.java:2042` — hedging 与 loser cancel
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3396` — shutdown 后 retry backoff 仍继续
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3512` — shutdown 后 hedge 仍继续
- `api/src/test/java/io/grpc/ContextsTest.java:215` — `TimeoutException` 映射 `DEADLINE_EXCEEDED`

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇聚焦客户端视角的 deadline/cancel/retry 生产排障，不展开服务端应用业务取消模式大全。
- `Deadline` 与 `Context` 的测试用 ticker/调度器替换机制不在正文展开。
- xDS / LB / resolver 导致的更复杂 retry routing 场景不展开。

## 与其他篇的边界

### 本篇要讲清

- `DEADLINE_EXCEEDED` 与 `CANCELLED` 的真实来源与重写规则。
- `closedInternal()` 的最终收敛逻辑。
- `RetriableStream` 中 retry/hedging 的核心决策点。
- cancel 如何影响未提交 attempt、scheduled retry/hedge。
- `shutdown()` 与 `shutdownNow()` 的排障差异。

### 本篇不深讲

- MethodType 契约本身（已在 ch04/01）。
- Metadata/Status 编码基础（已在 ch04/02）。
- cancel/half-close 基础语义（已在 ch04/03）。
- 负载均衡、picker、subchannel 的状态排障（留给 ch05/02）。

## 写作后检查

- [ ] 开篇先抓“同样失败为何会看到不同状态码”，而不是直接讲 `ClientCallImpl`。
- [ ] 至少展开 3 个失败方案，且包含“最终 Status 不等于最初来源”“retry 只看状态码”。
- [ ] 明确给出“来源层 → 重试层 → 收敛层”的总图。
- [ ] 不把本篇写成 `ClientCallImpl`/`RetriableStream` 的字段说明书。
- [ ] 每个排障结论都要落到具体 file:line 证据。
- [ ] 删除代码块后，读者仍能复述排障三问法。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。