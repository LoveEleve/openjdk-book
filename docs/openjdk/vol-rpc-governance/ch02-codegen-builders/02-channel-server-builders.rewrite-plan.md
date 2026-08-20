# grpc-java：ManagedChannelBuilder、ServerBuilder 与运行时配置装配 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch02-codegen-builders`
- 篇：`02 ManagedChannelBuilder、ServerBuilder 与运行时配置装配`
- 对应主题：`G-INT-2 ManagedChannelBuilder / ServerBuilder 装配层`
- 文章类型：装配层与配置映射篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：前一篇已经把 `.proto -> *Grpc` 的 codegen 装配桥立住了，但真实使用者进一步接触到的，往往是 `ManagedChannelBuilder`、`ServerBuilder` 以及 transport 特定 builder；这些外部配置到底是怎样被装进 grpc-java 内部运行时结构里的？
- 一句话顿悟：builder 层不是“参数收集器”，而是 grpc-java 的第二座装配桥：它把用户外部配置稳定映射进 name resolver、interceptor、executor、service config、compressor、keepalive、handler registry 与 transport builder，最终交给 `ManagedChannelImplBuilder` / `ServerImplBuilder` 装配成真正的运行时对象。
- 文章边界：本篇重点解释 `ManagedChannelBuilder`、`ServerBuilder`、`ManagedChannelImplBuilder`、`ServerImplBuilder` 怎样把用户配置映射进前面已经建立的客户端/服务端/横切面/发现选址主线；不深入具体 transport handler 实现，不扩展到 Spring/Boot 集成。

## 前置依赖

### HARD

- `vol-rpc-governance/ch02-codegen-builders/01-protoc-grpc-skeleton.md`：已经知道用户契约如何通过 `*Grpc` 骨架接入运行时。
- `vol-rpc-governance/ch01-grpc-runtime/01-stub-channel-clientcall.md`：已经知道客户端主线最终落到 `ManagedChannelImpl` / `ClientCallImpl`。
- `vol-rpc-governance/ch01-grpc-runtime/02-servercall-and-streaming-model.md`：已经知道服务端主线最终落到 `ServerImpl`。
- `vol-rpc-governance/ch01-grpc-runtime/04-nameresolver-loadbalancer-netty-transport.md`：已经知道 resolver/LB/transport 桥接结构。

### SOFT

- transport-specific builder（netty/okhttp/inprocess）只作为装配差异点到，不展开具体 transport 实现细节。
- metrics/census/observability 只在 builder 自动装配处点到，不展开专题。

### NAV

- 后续可接：`Marshaller / ProtoUtils / 消息对象桥`
- 后续可接：`InProcess Transport、Testing 与真实测试语义`

## 一句话困惑

为什么用户只是链式调几个 builder 方法，最终却能精确改变 resolver、interceptor、compressor、service config、keepalive、handler registry 甚至 transport 行为？

## 一句话顿悟

builder 层真正做的不是收集参数，而是把“用户能表达的外部配置”翻译成 grpc-java 内部可消费的运行时装配状态；`ManagedChannelImplBuilder` 与 `ServerImplBuilder` 则是这份装配状态汇总后真正生成 channel/server 运行时的中枢。

## 读者理解路径

1. 先否定“builder 只是 fluent API 外壳”的粗糙理解。
2. 建立最小总图：用户配置 -> 公共 Builder API -> ImplBuilder 装配状态 -> 运行时对象。
3. 解释 `ManagedChannelBuilder` 为什么不是 transport 细节外壳，而是客户端可配置边界的抽象总表。
4. 解释 `ManagedChannelImplBuilder` 怎样把 nameResolver、interceptor、executor、service config、authority、compressor 等状态真正装进 channel。
5. 解释 `ServerBuilder` / `ServerImplBuilder` 怎样把 addService、fallback registry、interceptor、decompressor、handshake/keepalive 等映射进 server 运行时。
6. 解释为什么 transport-specific builder（如 netty/okhttp）只是装配差异，而不是 builder 层存在的全部意义。
7. 最后收束到：builder 层是用户外部配置进入 grpc-java 主干运行时的第二座装配桥。

## 失败方案推演

### 失败方案一：builder 只是链式 API，真正逻辑都在 build 之后

- 这会漏掉：
- 哪些状态在 builder 层就被固化
- 哪些参数会限制后续 resolver/LB/transport 选择
- direct address / direct executor / service config lookup 等边界为什么在 builder 层就被拦住
- 所以 builder 不是外壳，而是装配阶段的一部分。

### 失败方案二：公共 Builder API 和 ImplBuilder 没有本质区别

- 这会忽略 grpc-java 的分层设计。
- 公共 `ManagedChannelBuilder` / `ServerBuilder` 是用户可见配置边界；`ManagedChannelImplBuilder` / `ServerImplBuilder` 则是真正把这些配置翻译成内部状态的装配中枢。
- 如果混成一层，读者会看不清“抽象配置能力”和“具体运行时装配”之间的关系。

### 失败方案三：transport-specific builder 才是真正的 builder 主体

- 这会把 builder 层重新写成 transport 细节文。
- `NettyChannelBuilder` / `OkHttpChannelBuilder` 当然重要，但它们只是在公共 builder 语义上继续补 transport 差异，不能替代 channel/server builder 的整体装配主线。

### 失败方案四：service config / interceptor / registry 这些都只是 build 之后 runtime 自己发现的

- 这会掩盖一个关键事实：
- builder 已经决定了哪些 resolver/provider/registry/默认值会被带进 runtime
- 所以很多“运行时行为”其实在 build 前就已经被参数化了

## 必须澄清的误解

1. `ManagedChannelBuilder` / `ServerBuilder` 不是 fluent API 门面，而是用户可配置边界。
2. `ManagedChannelImplBuilder` / `ServerImplBuilder` 不只是内部实现细节，它们是真正的运行时装配中枢。
3. `build()` 不是凭空创建 channel/server，而是在已经累积好的装配状态上收口。
4. transport-specific builder 只是 builder 生态的一部分，不等于 builder 层全部意义。
5. service config、resolver、interceptor、registry、keepalive 等行为很多在 builder 阶段就已经被决定。

## 文章结构与字数预算

1. 困惑开场：为什么 builder 不能只当链式 API 看（800-1000 字）
2. 最小总图：外部配置怎样进入内部装配状态（1200-1600 字）
3. `ManagedChannelBuilder`：用户可见客户端配置边界（1800-2400 字）
4. `ManagedChannelImplBuilder`：客户端装配中枢怎样把配置压进 runtime（2200-3000 字）
5. `ServerBuilder` / `ServerImplBuilder`：服务端装配中枢怎样成立（2200-2800 字）
6. transport-specific builder 的位置：为什么它们只是差异化补层（1200-1800 字）
7. 收网总结：builder 层为什么是第二座装配桥（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `api/src/main/java/io/grpc/ManagedChannelBuilder.java:27`
- `api/src/main/java/io/grpc/ManagedChannelBuilder.java:43`
- `api/src/main/java/io/grpc/ManagedChannelBuilder.java:90`
- `api/src/main/java/io/grpc/ManagedChannelBuilder.java:108`
- `api/src/main/java/io/grpc/ManagedChannelBuilder.java:122`
- `api/src/main/java/io/grpc/ManagedChannelBuilder.java:153`
- `api/src/main/java/io/grpc/ManagedChannelBuilder.java:218`
- `api/src/main/java/io/grpc/ManagedChannelBuilder.java:273`
- `api/src/main/java/io/grpc/ManagedChannelBuilder.java:327`
- `api/src/main/java/io/grpc/ManagedChannelBuilder.java:625`
- `api/src/main/java/io/grpc/ManagedChannelBuilder.java:636`
- `api/src/main/java/io/grpc/ServerBuilder.java:29`
- `api/src/main/java/io/grpc/ServerBuilder.java:43`
- `api/src/main/java/io/grpc/ServerBuilder.java:61`
- `api/src/main/java/io/grpc/ServerBuilder.java:75`
- `api/src/main/java/io/grpc/ServerBuilder.java:105`
- `api/src/main/java/io/grpc/ServerBuilder.java:144`
- `api/src/main/java/io/grpc/ServerBuilder.java:181`
- `api/src/main/java/io/grpc/ServerBuilder.java:193`
- `api/src/main/java/io/grpc/ServerBuilder.java:242`
- `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:72`
- `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:152`
- `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:279`
- `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:368`
- `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:407`
- `core/src/main/java/io/grpc/internal/ServerImplBuilder.java:57`
- `core/src/main/java/io/grpc/internal/ServerImplBuilder.java:81`
- `core/src/main/java/io/grpc/internal/ServerImplBuilder.java:118`
- `core/src/main/java/io/grpc/internal/ServerImplBuilder.java:143`
- `core/src/main/java/io/grpc/internal/ServerImplBuilder.java:181`
- `core/src/main/java/io/grpc/internal/ServerImplBuilder.java:257`
- `README.md:232`

## 测试证据清单

- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:149`：default/custom/default-port provider 语义。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:180`：executor/directExecutor/offloadExecutor 的 builder 装配行为。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:221`：nameResolverFactory/defaultLoadBalancingPolicy/direct address 限制。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:285`：decompressor/compressor/userAgent 等 builder 状态回退与默认值。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:347`：authority / transport address compatibility / overrideAuthority。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:417`：overrideAuthority 相关 builder 语义。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:544` 之后：effective interceptors / implicit census / target-aware interceptor 工厂。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:637`：idleTimeout 的默认值/禁用值/边界。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:817`：URI pattern / target parsing 边界。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:886`：NameResolver provider 选择路径。
- `core/src/test/java/io/grpc/internal/ServerImplBuilderTest.java`：server builder 默认值、interceptor、fallback registry、builder 约束。

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讨论的是公共 builder API 与默认 internal builder 的装配路径，不深入各 transport builder 的具体实现细节。
- `ManagedChannelBuilder` / `ServerBuilder` 中一些方法是 advisory/experimental/unsupported 的，必须明确实现边界，不能写成所有 transport 都等价支持。
- 这篇只讲 grpc-java 自身装配层，不扩展到 Spring Boot/Cloud 自动配置桥。

## 与其他篇的边界

### 本篇要讲清

- 用户外部配置如何通过 builder 进入 grpc-java 内部装配状态。
- `ManagedChannelImplBuilder` / `ServerImplBuilder` 怎样成为真正的装配中枢。
- build 前阶段如何决定 resolver、interceptor、service config、executor、registry、keepalive、handler registry 等行为。

### 本篇不深讲

- `Marshaller` / `ProtoUtils` 深层专题。
- in-process/testing 专题。
- Spring / Boot / Cloud 集成装配。
- 具体 transport handler 细节。

## 写作后检查

- [ ] 开篇先抓“builder 不是链式 API 外壳”，而不是直接列配置项。
- [ ] 至少展开 3 个失败方案，且包含“transport-specific builder 不等于 builder 层全部意义”。
- [ ] 明确给出“外部配置 -> builder 状态 -> runtime 对象”的总图。
- [ ] 不把本篇写成参数清单或 Javadoc 翻译。
- [ ] 不把这篇顺手扩成 transport 细节文。
- [ ] 删除代码块后，读者仍能复述 builder 为什么是第二座装配桥。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。
