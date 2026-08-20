# grpc-java：Service Config、Retry 与 Hedging — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch03-runtime-deepening`
- 篇：`01 Service Config、Retry 与 Hedging`
- 对应主题：`G-DEEP-1 Service Config / Retry / Hedging`
- 文章类型：运行时机制补深篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：前面的主干篇已经说明调用会经过 resolver、picker、transport，但很多“调用为什么会等、会重试、会并发试探、会被 throttle”这类行为，其实不是 transport 自己临时做的，而是 service config 和 channel 配置早就决定好的；这条线到底怎样从外部配置进入 MethodInfo，再落到 `RetriableStream`？
- 一句话顿悟：grpc-java 把“能不能重试、怎么退避、何时 hedging、哪些状态可重试、资源预算多大”先编码进 service config / builder 限额，再在 `ManagedChannelImpl` 里把它变成 `MethodInfo` 和 `RetriableStream` 的运行时策略；retry/hedging 不是 transport 附加技巧，而是配置、调用语义与 transport 之间的联合状态机。
- 文章边界：本篇重点解释 `ManagedChannelServiceConfig`、`MethodInfo`、`RetryPolicy`、`HedgingPolicy`、`ManagedChannelImplBuilder`、`ManagedChannelImpl.ChannelStreamProvider`、`RetriableStream` 的衔接；不扩展到 xDS 全景，不重讲基础 NameResolver/LB 主线，不把生产排障层全部吞进本篇。

## 前置依赖

### HARD

- `vol-rpc-governance/ch01-grpc-runtime/01-stub-channel-clientcall.md`：已经知道客户端主线最终落到 `ClientCallImpl` / `ClientStream`。
- `vol-rpc-governance/ch01-grpc-runtime/04-nameresolver-loadbalancer-netty-transport.md`：已经知道 resolver/LB/transport 桥。
- `vol-rpc-governance/ch02-codegen-builders/02-channel-server-builders.md`：已经知道 builder 怎样把默认 service config、retry 开关和预算装进 runtime。

### SOFT

- 不要求先懂 xDS；本篇先站在 grpc-java 核心 channel 运行时视角。
- 不把 Service Config 的所有 JSON 语法细枝末节写成配置手册。

### NAV

- 后续可接：`Health / Reflection / Channelz`
- 后续可接：生产排障篇里关于 retry/hedging 的线上问题

## 一句话困惑

为什么同样是一次 RPC，有的会在失败后等一段时间重试，有的会同时开多个尝试做 hedging，有的又会被 throttle 或预算限制挡住？这些行为到底是谁在什么时候决定的？

## 一句话顿悟

grpc-java 先把 service config 解析成 method/service/default 三层规则，再把 retry/hedging 约束写进 `MethodInfo`、builder 限额和 channel 预算里；`ManagedChannelImpl` 读这些规则后，不是直接让 transport“聪明一点”，而是显式创建 `RetriableStream`，把重试、hedging、pushback、throttle、commit 和 buffer 预算都放进同一条逻辑流状态机。

## 读者理解路径

1. 先否定“retry/hedging 是 transport 出错后临时补救”的粗糙理解。
2. 建立最小总图：`raw service config -> ManagedChannelServiceConfig / MethodInfo -> ChannelStreamProvider -> RetriableStream -> substreams`。
3. 解释 service config 为什么不是普通参数表，而是 method/service/default 三层匹配规则。
4. 解释 builder 限额（maxAttempts、buffer、enable/disable）为什么会影响后续 runtime 行为。
5. 解释 `RetriableStream` 为什么不是多个独立 ClientStream 的简单集合，而是带 commit / drain / retry / hedging / throttle 的逻辑流状态机。
6. 解释 retry 与 hedging 的关键差别：一个是失败后退避重试，一个是并行或延迟试探多个尝试。
7. 最后收束到：retry/hedging 是配置、语义和 transport 三层共同决定的运行时机制，不是 transport 小技巧。

## 失败方案推演

### 失败方案一：retry/hedging 只是 transport 失败后“再试一次”

- 这会漏掉：
- service config 匹配规则
- builder 级开关与上限
- retryable / non-fatal status code
- backoff、pushback、throttle、buffer 预算
- commit 后取消其他 substream
- 所以 retry/hedging 不是补救动作，而是完整状态机。

### 失败方案二：service config 只是配置表，和 runtime 主线关系不大

- 这会低估 `ManagedChannelServiceConfig` / `MethodInfo`。
- 它们不是“读完存起来”，而是会直接影响：
- `CallOptions` deadline / waitForReady / message size
- `ChannelStreamProvider` 是否构造 `RetriableStream`
- `RetriableStream` 采用哪套 policy
- 所以 config 不只是静态数据，而是 runtime 策略来源。

### 失败方案三：retry 和 hedging 只是顺序/并行上的小差别

- 这会错过语义差异：
- retry 关注失败后的退避和再次尝试
- hedging 关注在延迟/非致命状态下开启多个并发尝试
- commit、pushback、throttle、buffer 限制都不同
- 所以它们不是“一个串行一个并行”这么简单。

### 失败方案四：budget/throttle 只是性能优化，不影响主线

- 这会忽略：
- channelBufferLimit / perRpcBufferLimit 会改变流何时还能继续派生尝试
- throttle 会改变 retry/hedging 是否还能继续进行
- 这些不是优化附属件，而是 runtime 语义边界。

## 必须澄清的误解

1. retry/hedging 不是 transport 小技巧，而是 channel 运行时中的逻辑流机制。
2. service config 不是配置手册，而是 method/service/default 三层匹配策略来源。
3. `MethodInfo` 不是被动数据对象，它是具体调用行为的即时配置快照。
4. `RetriableStream` 不是若干 substream 列表，它有 commit、drain、pushback、throttle 和 buffer 预算状态机。
5. retry 和 hedging 的差异不只是串行/并行，而是失败语义、启动条件和收束策略都不同。

## 文章结构与字数预算

1. 困惑开场：为什么“再试一次”远远不够解释 retry/hedging（800-1000 字）
2. 最小总图：service config 怎样落到逻辑流状态机（1200-1600 字）
3. `ManagedChannelServiceConfig` / `MethodInfo`：配置怎样变成调用策略（1800-2400 字）
4. builder 限额与默认配置：哪些行为在 build 前就被参数化（1400-2000 字）
5. `ChannelStreamProvider`：什么时候进入 `RetriableStream` 路径（1400-2000 字）
6. `RetriableStream`：commit / retry / hedging / throttle / buffer 预算状态机（2600-3400 字）
7. retry vs hedging：真正差别与失败路径收口（1800-2400 字）
8. 收网总结：为什么这条线属于完整卷必须补的机制层（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:39`
- `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:89`
- `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:121`
- `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:180`
- `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:248`
- `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:285`
- `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:333`
- `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:380`
- `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:191`
- `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:201`
- `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:539`
- `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:551`
- `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:566`
- `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:596`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:461`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:483`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:603`
- `core/src/main/java/io/grpc/internal/RetriableStream.java:54`
- `core/src/main/java/io/grpc/internal/RetriableStream.java:88`
- `core/src/main/java/io/grpc/internal/RetriableStream.java:127`
- `core/src/main/java/io/grpc/internal/RetriableStream.java:155`
- `core/src/main/java/io/grpc/internal/RetriableStream.java:251`
- `core/src/main/java/io/grpc/internal/RetriableStream.java:286`
- `core/src/main/java/io/grpc/internal/RetriableStream.java:298`

## 测试证据清单

- `core/src/test/java/io/grpc/internal/ManagedChannelServiceConfigTest.java:148`：retry policy 解析与 MethodInfo 匹配。
- `core/src/test/java/io/grpc/internal/ManagedChannelServiceConfigTest.java:211`：空 retryableStatusCodes 与 perAttemptRecvTimeout 边界。
- `core/src/test/java/io/grpc/internal/HedgingPolicyTest.java:42`：hedging policy 解析与开关边界。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:663`：maxRetryAttempts / maxHedgedAttempts / buffer 限额配置。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:720`：defaultServiceConfig / disableServiceConfigLookUp builder 语义。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3396`：retry backoff、shutdown 与新调用失败的交互。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3512`：hedging delay、shutdown 与后续尝试的交互。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3617`：bad service config 可恢复。
- `core/src/test/java/io/grpc/internal/RetriableStreamTest.java:1619`：throttle 如何影响 retriable stream。
- `core/src/test/java/io/grpc/internal/RetriableStreamTest.java:1903`：normal retry 行为。
- `core/src/test/java/io/grpc/internal/RetriableStreamTest.java:2042`：hedging 多 substream 语义。
- `core/src/test/java/io/grpc/internal/RetriableStreamTest.java:2724`：per-RPC / channel buffer limit 对 hedging 的约束。

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讨论的是 grpc-java 核心 channel/service config/retriable stream 机制，不展开 xDS 对这套机制的再包装。
- 某些默认值/限制来自 builder 当前实现，不能外推成所有 transport 或所有上层框架都这样。
- retry/hedging 的 JSON 语法只在机制解释需要时点到，不把本文写成配置手册。

## 与其他篇的边界

### 本篇要讲清

- service config 怎样变成 MethodInfo。
- builder 限额怎样影响 runtime 的 retry/hedging 行为。
- `RetriableStream` 怎样统一承载 commit / backoff / hedging / throttle / buffer 预算。
- retry 和 hedging 的真正机制差异。

### 本篇不深讲

- xDS 全量策略控制面。
- 生产排障大全。
- LoadBalancer 策略实现大全。
- HTTP/2 transport 细节重讲。

## 写作后检查

- [ ] 开篇先抓“为什么再试一次远远不够解释 retry/hedging”，而不是直接讲配置项。
- [ ] 至少展开 3 个失败方案，且包含“service config 不是配置表”“budget/throttle 不是优化附属件”。
- [ ] 明确给出 `service config -> MethodInfo -> RetriableStream` 总图。
- [ ] 不把本篇写成 JSON 配置手册。
- [ ] 不把 `RetriableStream` 写成若干 substream 的机械列表。
- [ ] 删除代码块后，读者仍能复述 retry/hedging 的真正运行时结构。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。
