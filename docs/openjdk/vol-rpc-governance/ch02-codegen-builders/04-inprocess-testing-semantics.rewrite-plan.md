# grpc-java：InProcess Transport、Testing 与真实测试语义 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch02-codegen-builders`
- 篇：`04 InProcess Transport、Testing 与真实测试语义`
- 对应主题：`G-INT-3 InProcess / Testing 装配桥`
- 文章类型：集成层与测试语义篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：为什么 grpc-java 官方明确反对 mock stub，反而强烈推荐 `InProcessTransport`、`InProcessChannelBuilder`、`InProcessServerBuilder` 和 `GrpcCleanupRule`？这些东西到底只是测试便利工具，还是 grpc-java 整卷里真正重要的一层装配桥？
- 一句话顿悟：InProcess 不是“假 transport”，而是 grpc-java 专门提供的一条真实运行时近似路径：它保留 Stub、Builder、Marshaller、ClientCall/ServerCall、Stream、状态语义，只去掉 socket/TCP/真实网络噪音；`GrpcCleanupRule` 则把测试中的资源收尾纪律显式固化成可复用的测试基础设施。
- 文章边界：本篇重点解释 `InProcessChannelBuilder`、`InProcessServerBuilder`、`InProcessTransport`、`GrpcCleanupRule` 与 examples/README 中的测试哲学，回答为什么这条路径比 mock stub 更接近真实 grpc-java 语义；不扩展到 JUnit/Mockito 教程，不重讲前面四篇主干运行时。

## 前置依赖

### HARD

- `vol-rpc-governance/ch02-codegen-builders/01-protoc-grpc-skeleton.md`：已经知道 `*Grpc` 骨架怎样接入 runtime。
- `vol-rpc-governance/ch02-codegen-builders/02-channel-server-builders.md`：已经知道 builder 怎样把配置装进 runtime。
- `vol-rpc-governance/ch02-codegen-builders/03-marshaller-protoutils-message-bridge.md`：已经知道对象 -> message frame -> transport 的消息桥。
- `vol-rpc-governance/ch01-grpc-runtime/01-stub-channel-clientcall.md`、`02-servercall-and-streaming-model.md`：已经知道客户端/服务端主线。

### SOFT

- 不要求读者先懂全部 JUnit Rule 细节，只需要知道测试资源也需要生命周期收尾。
- 不把 mocking 框架优缺点展开成测试哲学大战。

### NAV

- 后续可接：`Health / Reflection / Channelz`
- 后续可接：`Service Config、Retry 与 Hedging`

## 一句话困惑

为什么 grpc-java 官方宁可提供一整套 InProcess builder / transport / cleanup rule，也不鼓励直接 mock stub 和 response？

## 一句话顿悟

因为 grpc-java 认为测试最值钱的不是“随手伪造返回值”，而是尽量保留真实运行时语义：InProcess 路径仍然经过 builder、stub、marshaller、stream、status、deadline、cancellation，只是去掉了真实 socket/TCP，因此它是集成层里的“真实语义近似桥”，不是测试玩具。

## 读者理解路径

1. 先否定“测试里 mock stub 最方便，所以也最合理”的直觉。
2. 建立最小总图：`InProcessServerBuilder / InProcessChannelBuilder -> InProcessTransport -> 真实 grpc-java 主线（minus socket/TCP）`。
3. 解释 examples/README 为什么把 mock stub 视为假安全感，而把 InProcess 当官方推荐路径。
4. 解释 `InProcessChannelBuilder` / `InProcessServerBuilder` 怎样在 builder 层显式关闭或替换某些网络相关语义，同时保留调用主线。
5. 解释 `InProcessTransportTest` 怎样证明 client/server 消息、状态、method lookup、cause propagation 等仍然是真实发生的。
6. 解释 `GrpcCleanupRule` 为什么重要：测试不只是能跑，还必须把 channel/server 资源收尾纪律固化下来。
7. 最后收束到：InProcess/testing 不是附录，而是 grpc-java 集成层与开发者体验层的重要组成部分。

## 失败方案推演

### 失败方案一：mock stub 更轻量，所以可以替代真实测试路径

- 这会绕过：
- marshaller/message framing
- headers / metadata
- deadline / cancellation
- method lookup / unimplemented path
- channel/server resource cleanup
- 所以它测到的是“你 mock 了什么”，不是 grpc-java 真实会怎么跑。

### 失败方案二：InProcess 只是测试假 transport，不值得单独讲

- 这会低估：
- 它仍然经过 builder、stub、stream、status、server/client 调用主线
- 它还保留 method lookup、cause/status 传播、message parsing、metadata size 限制等语义
- 它删掉的主要是 socket/TCP 噪音，不是 grpc runtime 本体

### 失败方案三：测试收尾只是框架外的 JUnit 小事

- 这会忽略 grpc-java 里 server/channel 本身就是有生命周期的资源。
- `GrpcCleanupRule` 不是装饰语法糖，而是把 graceful shutdown / awaitTermination / forced cleanup 这些运行时纪律固化进测试。

### 失败方案四：InProcess 和真实 transport 完全等价

- 这也不对。
- 某些网络/安全/keepalive/TLS 语义在 InProcess 中要么不支持、要么被短路、要么 deliberately no-op。
- 所以本篇既不能把它贬成玩具，也不能把它夸成 100% 等价网络 transport。

## 必须澄清的误解

1. InProcess 不是“mock transport”，而是删除网络噪音后的真实语义近似桥。
2. 官方不鼓励 mock stub，不是出于风格洁癖，而是因为那会绕过 grpc-java 的关键运行时路径。
3. `InProcessChannelBuilder` / `InProcessServerBuilder` 不是普通 builder 别名，它们显式修改了部分 transport 相关行为边界。
4. `GrpcCleanupRule` 不是测试语法糖，而是生命周期收尾协议在测试层的体现。
5. InProcess 很适合主线语义测试，但不等于所有网络/安全/平台问题都能用它覆盖。

## 文章结构与字数预算

1. 困惑开场：为什么官方不鼓励 mock stub（800-1000 字）
2. 最小总图：InProcess 在 grpc-java 体系里的位置（1200-1600 字）
3. README 测试哲学：为什么“假安全感”不是危言耸听（1400-2000 字）
4. `InProcessChannelBuilder` / `InProcessServerBuilder`：它们怎样保留主线、去掉网络噪音（1800-2400 字）
5. `InProcessTransport`：哪些 runtime 语义仍然真实成立（1800-2400 字）
6. `GrpcCleanupRule`：测试中的资源生命周期为什么也属于 grpc 运行时一部分（1200-1800 字）
7. 收网总结：InProcess/testing 为什么属于完整卷的集成层（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `examples/README.md:134`
- `examples/README.md:141`
- `examples/README.md:154`
- `examples/README.md:164`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:43`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:61`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:109`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:117`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:139`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:183`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:224`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:44`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:50`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:84`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:130`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:132`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:157`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:177`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:202`
- `testing/src/main/java/io/grpc/testing/GrpcCleanupRule.java:37`
- `testing/src/main/java/io/grpc/testing/GrpcCleanupRule.java:118`
- `testing/src/main/java/io/grpc/testing/GrpcCleanupRule.java:133`
- `testing/src/main/java/io/grpc/testing/GrpcCleanupRule.java:165`
- `testing/src/main/java/io/grpc/testing/GrpcCleanupRule.java:225`
- `testing/src/main/java/io/grpc/testing/GrpcCleanupRule.java:253`

## 测试证据清单

- `inprocess/src/test/java/io/grpc/inprocess/InProcessTransportTest.java:63`：InProcessTransport 的单元测试族。
- `inprocess/src/test/java/io/grpc/inprocess/InProcessTransportTest.java:116`：`propagateCauseWithStatus(true)` 证明测试路径可保留更强的错误可见性。
- `inprocess/src/test/java/io/grpc/inprocess/InProcessTransportTest.java:153`：method not found 仍走 `UNIMPLEMENTED`，说明 method lookup 语义未丢。
- `inprocess/src/test/java/io/grpc/inprocess/InProcessTransportTest.java:193`：client/server 消息仍真实经过 `streamRequest` / `parseRequest`、`streamResponse` / `parseResponse`。
- `examples/README.md:134` 之后：官方明确不鼓励 mock stub，并说明 InProcess 路径能覆盖 deadline/cancellation/headers 等真实语义。
- `GrpcCleanupRule` 本身实现：graceful cleanup、awaitTermination、必要时 force cleanup。

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讲 InProcess/testing 作为集成层桥接，不把它外推成所有 transport 都等价。
- `usePlaintext()` / `useTransportSecurity()` / keepalive 等在 InProcess builder 上的 no-op 行为，必须视作当前实现选择，而不是抽象规范。
- `propagateCauseWithStatus(true)` 明确偏向测试可见性，不外推到不可信网络场景。

## 与其他篇的边界

### 本篇要讲清

- 为什么官方不鼓励 mock stub。
- InProcess builder/transport 怎样保留主线语义并去掉网络噪音。
- 哪些 runtime 语义在 InProcess 中仍真实成立。
- 测试资源收尾为什么也属于 grpc 运行时纪律。

### 本篇不深讲

- JUnit / Mockito 使用教程。
- 所有 InProcess 内部优化细节。
- 网络 transport 的 TLS/keepalive 差异对照大全。
- Spring 测试集成封装。

## 写作后检查

- [ ] 开篇先抓“为什么官方不鼓励 mock stub”，而不是直接介绍 InProcess API。
- [ ] 至少展开 3 个失败方案，且包含“测试收尾不是小事”。
- [ ] 明确给出 InProcess 在 grpc-java 体系中的装配位置。
- [ ] 不把本篇写成测试工具说明书。
- [ ] 不把 InProcess 夸成完全等价网络 transport。
- [ ] 删除代码块后，读者仍能复述它为什么是集成层桥接，不是测试附录。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。
