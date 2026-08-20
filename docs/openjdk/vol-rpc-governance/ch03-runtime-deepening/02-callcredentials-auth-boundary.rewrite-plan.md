# grpc-java：CallCredentials、认证与调用凭证边界 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch03-runtime-deepening`
- 篇：`02 CallCredentials、认证与调用凭证边界`
- 对应主题：`G-DEEP-2 CallCredentials 与认证边界`
- 文章类型：认证/安全边界补深篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：为什么 `ClientInterceptor` 的注释会明确说“提供认证凭证更好用 `CallCredentials`，而不是自己写 interceptor”？`CallCredentials` 到底比 interceptor 多承担了什么运行时职责？
- 一句话顿悟：`CallCredentials` 不是 another metadata hack，它在 gRPC 里承担的是“每次 RPC 的异步凭证生成门”：通过 `applyRequestMetadata(RequestInfo, Executor, MetadataApplier)` 在流创建前把凭证挂到 metadata，RPC 只有在 `applier` 完成后才继续；它区别于 interceptor 的地方，是有明确的每-RPC 语义、异步边界、安全等级和失败/取消收口。
- 文章边界：本篇重点解释 `CallCredentials`、`CallOptions.withCallCredentials`、`AbstractStub.withCallCredentials`、`CallCredentialsApplyingTransportFactory`、`RequestInfo`、`MetadataApplier`，以及它和 `ClientInterceptor` 的职责分工；不展开 TLS/mTLS/ALTS 全部细节，不重讲认证框架生态。

## 前置依赖

### HARD

- `vol-rpc-governance/ch01-grpc-runtime/01-stub-channel-clientcall.md`：已经知道 stub/callOptions/ClientCall 主线。
- `vol-rpc-governance/ch01-grpc-runtime/03-interceptors-context-deadline.md`：已经知道 `ClientInterceptor` 挂在调用边界的职责。
- `vol-rpc-governance/ch02-codegen-builders/02-channel-server-builders.md`：已经知道 builder 怎样装配 runtime。
- `vol-rpc-governance/ch01-grpc-runtime/04-nameresolver-loadbalancer-netty-transport.md`：已经知道 transport 层位置。

### SOFT

- TLS/ALTS/mTLS 只作为背景需要时点到。
- 不展开具体 OAuth/JWT 生态实现。

### NAV

- 后续可接：`Health / Reflection / Channelz`
- 后续可接：安全/运维生产层专题

## 一句话困惑

为什么 gRPC 明明有 `ClientInterceptor` 能把 metadata 塞进调用，却还要单独设计一套 `CallCredentials`，并且官方注释专门说认证最好交给它？

## 一句话顿悟

`CallCredentials` 不是“另一个 metadata interceptor”，而是 gRPC 里负责“每次 RPC 的异步凭证生成门”的机制：它接收 `RequestInfo`、拿到 app executor、通过 `MetadataApplier` 在流创建前挂载 metadata，并规定 RPC 必须等 `apply()/fail()` 后才能继续。这让凭证逻辑能独立于 interceptor 链，拥有明确的每-RPC 语义、异步边界和失败收口。

## 读者理解路径

1. 先否定“认证用 ClientInterceptor 写个 header 就行”的直觉。
2. 建立最小总图：`stub.withCallCredentials -> CallOptions -> CallCredentialsApplyingTransportFactory -> applyRequestMetadata -> MetadataApplier -> stream creation`。
3. 解释 `CallCredentials` 为什么承担每-RPC 凭证生成，而不是简单 metadata 拼接。
4. 解释 `RequestInfo` 为什么给凭证生成器提供 method/authority/security level/transport attrs。
5. 解释 `MetadataApplier` 为什么是唯一出口，且 RPC 必须等它才算通过。
6. 解释 `CallCredentialsApplyingTransportFactory` 怎样把 channel 级 + per-call 级凭证组合起来。
7. 说明它和 `ClientInterceptor` 的职责边界：interceptor 适合通用横切，credentials 适合认证语义。
8. 收束到：认证不是调用入口的旁路逻辑，而是调用前必须通过的一道异步门。

## 失败方案推演

### 失败方案一：只用 ClientInterceptor 生成认证 header 就行

- 这会缺失：
- 每-RPC 的异步凭证生成语义
- `RequestInfo` 里的 method/authority/security level
- `MetadataApplier.apply()/fail()` 的强制出口
- interceptor 无法天然表达“这一道认证门是否已经通过”
- 所以 gRPC 从 API 注释开始就明确表示认证更适合 `CallCredentials`。

### 失败方案二：CallCredentials 只是把 metadata 塞进调用，和 interceptor 等价

- 这会忽略：
- 它要拿到 `RequestInfo`
- 它有独立的 `appExecutor`
- 它通过 `MetadataApplier` 异步放行或失败
- 它还可以组合成 `CompositeCallCredentials`
- 所以它不是等价物，而是独立机制。

### 失败方案三：安全等级无所谓，认证就只是加 header

- 这会忽略 `SecurityLevel` / `getAuthority()` / `getTransportAttrs()`。
- 真实认证常常需要结合：当前连接是否足够安全、目标是哪个 authority、transport 是什么。
- interceptor 拿不到这些面向凭证决策的结构化信息。

### 失败方案四：认证失败就原地抛一个异常

- 这会错过：
- RPC 应该在进入 transport 后、真正建流前被 `fail(status)` 收口
- 失败必须让调用最终以失败状态 close
- 而不是简单在某个中间层抛错
- 所以 `MetadataApplier.fail()` 才是凭证失败的正确出口。

## 必须澄清的误解

1. `CallCredentials` 不是另一个 header utils，而是每次 RPC 的异步凭证生成门。
2. 它不是被调用时同步返回 header，而是通过 `MetadataApplier` 异步放行。
3. RPC 必须等 `apply()/fail()` 之后才继续，所以凭证是调用前必经门。
4. `RequestInfo` 提供的 method/authority/security level/transport attrs 是凭证决策需要的信息。
5. `ClientInterceptor` 仍然重要，但它和 `CallCredentials` 的职责边界不同。

## 文章结构与字数预算

1. 困惑开场：为什么认证不能只靠 interceptor 塞 header（800-1000 字）
2. 最小总图：凭证生成门怎样进入调用前链（1200-1600 字）
3. `CallCredentials.applyRequestMetadata`：为什么是异步凭证生成口（1800-2400 字）
4. `RequestInfo`：凭证决策需要看到哪些调用信息（1400-2000 字）
5. `MetadataApplier`：为什么它是唯一出口，且 RPC 必须等它（1800-2400 字）
6. `CallCredentialsApplyingTransportFactory`：channel 级与 per-call 凭证怎样组合（1800-2400 字）
7. 与 `ClientInterceptor` 的职责边界（1200-1800 字）
8. 收网总结：认证为什么是调用前必经门，而不是旁路逻辑（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `api/src/main/java/io/grpc/CallCredentials.java:21`
- `api/src/main/java/io/grpc/CallCredentials.java:37`
- `api/src/main/java/io/grpc/CallCredentials.java:40`
- `api/src/main/java/io/grpc/CallCredentials.java:55`
- `api/src/main/java/io/grpc/CallCredentials.java:68`
- `api/src/main/java/io/grpc/CallCredentials.java:73`
- `api/src/main/java/io/grpc/CallCredentials.java:86`
- `api/src/main/java/io/grpc/CallOptions.java:65`
- `api/src/main/java/io/grpc/CallOptions.java:139`
- `api/src/main/java/io/grpc/CallOptions.java:284`
- `api/src/main/java/io/grpc/ClientInterceptor.java:31`
- `stub/src/main/java/io/grpc/stub/AbstractStub.java:224`
- `core/src/main/java/io/grpc/internal/CallCredentialsApplyingTransportFactory.java:43`
- `core/src/main/java/io/grpc/internal/CallCredentialsApplyingTransportFactory.java:83`
- `core/src/main/java/io/grpc/internal/CallCredentialsApplyingTransportFactory.java:117`
- `core/src/main/java/io/grpc/internal/MetadataApplierImpl.java:33`
- `core/src/main/java/io/grpc/internal/MetadataApplierImpl.java:54`
- `api/src/main/java/io/grpc/CompositeCallCredentials.java:27`
- `api/src/main/java/io/grpc/CompositeChannelCredentials.java:22`

## 测试证据清单

- `core/src/test/java/io/grpc/internal/CallCredentialsApplyingTest.java:63`：CallCredentials 应用主链路。
- `core/src/test/java/io/grpc/internal/CallCredentialsApplyingTest.java:131`：per-call credentials 进入 transport factory。
- `core/src/test/java/io/grpc/internal/CallCredentialsApplyingTest.java:147`：`RequestInfo` 传递 method 等信息。
- `core/src/test/java/io/grpc/internal/CallCredentialsApplyingTest.java:172`：app executor 被正确传给 credentials。
- `core/src/test/java/io/grpc/internal/CallCredentialsApplyingTest.java:254`：metadata 经由 applier 挂入调用。
- `core/src/test/java/io/grpc/internal/CallCredentialsApplyingTest.java:275`：异步 applier 后调用继续。
- `core/src/test/java/io/grpc/internal/CallCredentialsApplyingTest.java:305`：异步 fail 收口。
- `core/src/test/java/io/grpc/internal/CallCredentialsApplyingTest.java:464`：null credentials 时的行为。
- `core/src/test/java/io/grpc/internal/CallCredentialsApplyingTest.java:492`：channel 级 credentials fallback。
- `core/src/test/java/io/grpc/internal/CallCredentialsApplyingTest.java:508`：channel 级 + per-call credentials 组合。
- `api/src/test/java/io/grpc/CompositeCallCredentialsTest.java:27`：复合凭据组合语义。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:2096`：`RequestInfo` 传播到 call credentials。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:1769`：OOB channel 无 channel call credentials。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:1861`：OOB channel with OOB creds 语义。
- `api/src/test/java/io/grpc/CallOptionsTest.java:58`：CallOptions 携带并覆写 credentials。

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讲 `CallCredentials` 这个抽象机制，不扩展到 OAuth/JWT/mTLS/ALTS 的具体生态实现。
- `CompositeCallCredentials` / `CompositeChannelCredentials` 只讲组合语义，不展开所有细节。
- 某些方法带 `@ExperimentalApi` / `@Deprecated`，必须尊重当前 API 边界。

## 与其他篇的边界

### 本篇要讲清

- `CallCredentials` 为什么不同于 `ClientInterceptor`。
- 凭证如何通过 `CallOptions` 进入 transport 前链。
- `RequestInfo` / `MetadataApplier` 怎么组成调用前异步门。
- channel 级与 per-call 级凭证怎样组合。

### 本篇不深讲

- TLS/mTLS/ALTS 全量机制。
- OAuth/JWT 生态实现。
- 通用 metadata 横切主题。
- Server 端认证专题。

## 写作后检查

- [ ] 开篇先抓“为什么认证不能只靠 interceptor 塞 header”，而不是直接列 CallCredentials API。
- [ ] 至少展开 3 个失败方案，且包含“metadata 等价论”与“安全等级无所谓”。
- [ ] 明确给出 `stub.withCallCredentials -> CallOptions -> transport factory -> applyRequestMetadata -> MetadataApplier` 总图。
- [ ] 不把本篇写成凭证框架使用手册。
- [ ] 不把 `CallCredentials` 和 `ClientInterceptor` 职责混成一团。
- [ ] 删除代码块后，读者仍能复述调用前异步凭证门。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。