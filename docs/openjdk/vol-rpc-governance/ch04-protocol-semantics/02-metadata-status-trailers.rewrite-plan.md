# grpc-java：Metadata、Status 与 Trailers 语义 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch04-protocol-semantics`
- 篇：`02 Metadata、Status 与 Trailers 语义`
- 对应主题：`G-SPEC-2 Metadata / Status / Trailers 语义专题`
- 文章类型：规范层专题篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：在前面的主干篇中，我们已经反复看到 Metadata 和 Status 出现在调用链的各个关键位置——`ClientCall.start()` 的 headers、`ServerCall.sendHeaders()` 的 headers、`ServerCall.close()` 的 trailers、`ClientCall.listener.onClose()` 的 Status 和 trailers。但读者一直没弄清楚：Metadata 和 Status 到底是什么关系？为什么有些 Metadata 作为 headers 发送，有些作为 trailers 发送？为什么 Status 要放在 trailers 里而不是 headers 里？grpc- 前缀的 key 和普通 key 有什么区别？
- 一句话顿悟：gRPC 协议把一次 RPC 的元数据分为三段：headers 在流开始时发送（携带 content-type、encoding、timeout、鉴权信息等），Status 在 trailers 中发送（通过 `grpc-status` 和 `grpc-message` 两个标准 key 承载），应用层自定义的 Metadata 可以在 headers 和 trailers 中出现；`Metadata.Key<T>` 的 ASCII/Binary 类型决定了 key 的序列化方式（ASCII 直接可见字符，Binary 自动 base64 编码），`grpc-` 前缀的 key 是协议预留的，传输层在将 Metadata 交付给应用层之前会手动剥离这些 key。
- 文章边界：本篇重点解释 Metadata 的 key-value 机制（ASCII/Binary key 类型、内部存储结构）、Status 的 15 个标准码与序列化、Trailers 的协议语义、Status 从服务端到客户端的编码/解码循环，以及 grpc- 预留 key 的剥离机制；不展开 Status 的 gRPC-web 或 xDS 场景下的特殊处理，不展开 Metadata 的流式序列化（LazyStreamBinaryKey）的完整实现。

## 前置依赖

### HARD

- `ch04/01-method-type-contracts.md`：已经知道四种方法类型的契约和 `ServerCall.close()` 的行为。
- `ch01/01-stub-channel-clientcall.md`：已经知道 `ClientCall` 的 headers 和 `onClose()` 回调。
- `ch01/02-servercall-and-streaming-model.md`：已经知道 `ServerCall.sendHeaders()` 和 `ServerCall.close()` 的时序。

### SOFT

- 不要求先懂 `Metadata.Key<T>` 的序列化细节。
- 不要求先懂 HTTP/2 的 headers 和 trailers 帧格式。

### NAV

- 后续可接：`ch04/03-cancel-halfclose-completion`（取消、half-close 与完成边界）。
- 后续可接：生产诊断卷中的 Status 排障。

## 一句话困惑

Metadata、Status 和 Trailers 是 gRPC 通信的三个基本概念，但它们的边界在哪里？为什么 Status 要通过 trailers 发送而不是 headers？Metadata 的 key 为什么分成 ASCII 和 Binary 两种类型？grpc- 前缀的 key 为什么不能出现在应用层代码中？

## 一句话顿悟

gRPC 协议把一次 RPC 的元数据按生命周期分为三段：headers（流开始时）携带协议参数，trailers（流结束时）携带最终状态，Status 通过 `grpc-status` 和 `grpc-message` 两个标准 trailer key 编码/解码；`Metadata.Key<T>` 的 ASCII/Binary 类型决定了 key 值的序列化方式（ASCII 直接可见字符，Binary 自动 base64 编码），`grpc-` 前缀是协议预留命名空间，传输层在交付 Metadata 给应用层之前会剥离这些 key。

## 读者理解路径

1. 先否定"Metadata 就是 headers，Status 就是错误码"的粗糙理解。
2. 建立最小总图：Metadata（headers + trailers）→ Status（grpc-status + grpc-message）→ 编码/解码循环。
3. 解释 Metadata 的 key-value 机制：`Key<T>` 的抽象设计、ASCII/Binary 两种 key 类型及其序列化差异。
4. 解释 Metadata 的内部存储结构（`namesAndValues` 数组）和基本操作（put/get/remove）。
5. 解释 Status 的 15 个标准码和 `Status.Code` 枚举。
6. 解释 Status 的构造方式（withDescription、withCause、asRuntimeException）。
7. 解释 Trailers 的协议语义：为什么 Status 放在 trailers 中（确保消息体全部到达后才收到状态）。
8. 解释 Status 的编码/解码循环：服务端 `AbstractServerStream.addStatusToTrailers()` → 客户端 `Http2ClientStreamTransportState.statusFromTrailers()`。
9. 解释 grpc- 预留 key 的剥离机制（`stripTransportDetails()`）。
10. 收束到：Metadata + Status + Trailers 构成 gRPC 的完整元数据体系。

## 失败方案推演

### 失败方案一：Metadata 就是 headers，Status 就是错误码

- 如果只把 Metadata 当成 headers，就会漏掉 trailers 的语义——部分 Metadata（如 Status）是在流结束时通过 trailers 发送的，而不是在流开始时。
- 如果只把 Status 当成错误码，就会漏掉 `Status.Code` 枚举的 15 个标准码的语义层次——有些是客户端错误、有些是服务端错误、有些是网络错误。
- 所以 Metadata 和 Status 不是"headers + 错误码"那么简单，它们有各自的协议层级和生命周期。

### 失败方案二：Status 通过 headers 发送就够了，不需要 trailers

- 如果 Status 在 headers 中发送，那客户端在收到第一个 DATA frame 之前就已经知道了 RPC 的结果。但 gRPC 协议的语义是：Status 只有在流结束时才确定——对于 streaming 响应，服务端可能在发送了多条消息后才决定返回一个错误。
- 把 Status 放在 trailers 中确保了：在消息体全部到达之前，客户端不会看到最终状态。这保证了消息体与状态的一致性。
- 所以 Status 在 trailers 中不是随意选择，而是 gRPC 协议的语义要求。

### 失败方案三：Metadata 的 key 类型只有一种，不需要区分 ASCII/Binary

- 如果把所有 Metadata key 都当成 ASCII 字符串，那 Binary 类型的值（如 token、证书）如何处理？如果直接放 ASCII 字符串，那些不可见字符会被 HTTP/2 协议拒绝。
- gRPC 的解决方案是：Binary key 的名称必须以 `-bin` 结尾，值自动进行 base64 编码后再传输。这样 Binary 值可以安全地通过 HTTP/2 的 ASCII 头部传输，接收方根据 key 的 `-bin` 后缀自动解码。
- 所以 ASCII/Binary 的分隔不是过度设计，而是 HTTP/2 传输层对二进制数据的兼容性要求。

## 必须澄清的误解

1. Metadata 不是"headers 的别名"，它包含 headers 和 trailers 两段。
2. Status 不是"错误码"，它是一个包含 code、description 和 cause 的完整对象，通过 `grpc-status` 和 `grpc-message` 两个 trailer key 传输。
3. `grpc-` 前缀的 key 是协议预留的，应用层代码不能使用这个前缀。
4. Binary key 必须以 `-bin` 结尾，值会自动 base64 编码/解码。
5. 服务端关闭调用时传入的 trailers 是 append 模式——`grpc-status` 和 `grpc-message` 被自动追加到 trailers 中，不是覆盖。

## 文章结构与字数预算

1. 困惑开场：为什么 Metadata 中的一部分要在流结束时才到达（800-1000 字）
2. 最小总图：Metadata/Status/Trailers 的三段式生命周期（1000-1400 字）
3. Metadata 的 key-value 机制：`Key<T>`、ASCII/Binary、内部存储（1800-2400 字）
4. Status 的 15 个标准码与构造方式（1400-2000 字）
5. Trailers 的协议语义：为什么 Status 在 trailers 中（1200-1600 字）
6. Status 编码/解码循环：服务端出口 → 客户端入口（1800-2400 字）
7. grpc- 预留 key 的剥离机制（800-1000 字）
8. 收网总结（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### Metadata
- `api/src/main/java/io/grpc/Metadata.java:150` — `namesAndValues` 内部存储结构
- `api/src/main/java/io/grpc/Metadata.java:248` — `get(Key<T>)` 方法
- `api/src/main/java/io/grpc/Metadata.java:342` — `put(Key<T>, T)` 方法
- `api/src/main/java/io/grpc/Metadata.java:402` — `removeAll(Key<T>)` 方法
- `api/src/main/java/io/grpc/Metadata.java:467` — `serialize()` 方法
- `api/src/main/java/io/grpc/Metadata.java:671` — `Key<T>` 抽象类定义
- `api/src/main/java/io/grpc/Metadata.java:682` — `Key.of(String, BinaryMarshaller)` 工厂方法
- `api/src/main/java/io/grpc/Metadata.java:703` — `Key.of(String, AsciiMarshaller)` 工厂方法
- `api/src/main/java/io/grpc/Metadata.java:859` — `BinaryKey<T>` 内部类
- `api/src/main/java/io/grpc/Metadata.java:966` — `AsciiKey<T>` 内部类
- `api/src/main/java/io/grpc/Metadata.java:568` — `BinaryMarshaller<T>` 接口
- `api/src/main/java/io/grpc/Metadata.java:599` — `AsciiMarshaller<T>` 接口
- `api/src/main/java/io/grpc/Metadata.java:736` — `validateName()` 方法

### Status
- `api/src/main/java/io/grpc/Status.java:65` — `Status.Code` 枚举（OK=0 到 UNAUTHENTICATED=16）
- `api/src/main/java/io/grpc/Status.java:237` — `STATUS_LIST` 规范实例
- `api/src/main/java/io/grpc/Status.java:355` — `CODE_KEY`（`grpc-status` 头）
- `api/src/main/java/io/grpc/Status.java:386` — `MESSAGE_KEY`（`grpc-message` 头）
- `api/src/main/java/io/grpc/Status.java:396` — `fromThrowable()` 方法
- `api/src/main/java/io/grpc/Status.java:416` — `trailersFromThrowable()` 方法
- `api/src/main/java/io/grpc/Status.java:441` — `Status` 私有构造器
- `api/src/main/java/io/grpc/Status.java:455` — `withCause(Throwable)` 方法
- `api/src/main/java/io/grpc/Status.java:466` — `withDescription(String)` 方法
- `api/src/main/java/io/grpc/Status.java:523` — `asRuntimeException()` 方法
- `api/src/main/java/io/grpc/Status.java:560` — `StatusCodeMarshaller`（code 序列化）
- `api/src/main/java/io/grpc/Status.java:572` — `StatusMessageMarshaller`（percent-encoding）
- `api/src/main/java/io/grpc/StatusRuntimeException.java:26` — `StatusRuntimeException` 类

### Trailers 编码/解码
- `core/src/main/java/io/grpc/internal/AbstractServerStream.java:123` — `close(Status, Metadata)` 发送 trailers
- `core/src/main/java/io/grpc/internal/AbstractServerStream.java:138` — `addStatusToTrailers()` 注入 grpc-status/message
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:210` — `closeInternal()` 关闭调用
- `core/src/main/java/io/grpc/internal/Http2ClientStreamTransportState.java:172` — `transportTrailersReceived()` 接收 trailers
- `core/src/main/java/io/grpc/internal/Http2ClientStreamTransportState.java:193` — `statusFromTrailers()` 提取 Status
- `core/src/main/java/io/grpc/internal/Http2ClientStreamTransportState.java:255` — `stripTransportDetails()` 剥离 grpc- key
- `core/src/main/java/io/grpc/internal/AbstractClientStream.java:377` — `inboundTrailersReceived()` 交付 trailers

### 预留 key 与 GrpcUtil
- `api/src/main/java/io/grpc/InternalStatus.java:32` — `CODE_KEY` 和 `MESSAGE_KEY` 的 @Internal 暴露
- `core/src/main/java/io/grpc/internal/GrpcUtil.java:99` — `TIMEOUT_KEY` 等预留 key 定义
- `core/src/main/java/io/grpc/internal/GrpcUtil.java:144` — `CONTENT_TYPE_KEY` 定义
- `core/src/main/java/io/grpc/internal/GrpcUtil.java:300` — `httpStatusToGrpcStatus()`

## 测试证据清单

- `api/src/test/java/io/grpc/MetadataTest.java:127` — `testMutations()` put/get/removeAll
- `api/src/test/java/io/grpc/MetadataTest.java:189` — `testWriteParsed()` 序列化/反序列化
- `api/src/test/java/io/grpc/MetadataTest.java:310` — `testKeyCaseHandling()` key 大小写归一化
- `api/src/test/java/io/grpc/StatusTest.java:34` — `verifyExceptionMessage()` 异常消息格式
- `api/src/test/java/io/grpc/StatusTest.java:66` — `metadataEncode_lowAscii()` percent-encoding
- `core/src/test/java/io/grpc/internal/Http2ClientStreamTransportStateTest.java:242` — `transportTrailersReceived_notifiesListener()`
- `core/src/test/java/io/grpc/internal/Http2ClientStreamTransportStateTest.java:274` — `transportTrailersReceived_observesStatus()`
- `core/src/test/java/io/grpc/internal/Http2ClientStreamTransportStateTest.java:289` — `transportTrailersReceived_missingStatusUsesHttpStatus()`

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讨论的是 grpc-java 的 Metadata/Status/Trailers 实现，不展开 gRPC-web 或 gRPC-json 的适配。
- `Metadata.Key<T>` 的 `LazyStreamBinaryKey` 和 `TrustedAsciiKey` 是 grpc-java 的具体优化，不是 gRPC 规范要求。
- `grpc-status-details-bin` 的 protobuf 丰富错误详情在本篇不展开（留给 gRPC 进阶专题）。

## 与其他篇的边界

### 本篇要讲清

- Metadata 的 key-value 机制（ASCII/Binary 类型、内部存储、put/get/remove）。
- Status 的 15 个标准码和构造方式。
- Trailers 的协议语义及 Status 为什么在 trailers 中。
- Status 从服务端到客户端的编码/解码循环。
- grpc- 预留 key 的剥离机制。

### 本篇不深讲

- `Metadata.Key<T>` 的流式序列化（`LazyStreamBinaryKey`）的完整实现。
- `grpc-status-details-bin` 的 protobuf 丰富错误详情。
- gRPC-web 或 gRPC-json 的适配。
- Status 与 deadline/cancel/retry 的交互（留给生产排查卷）。

## 写作后检查

- [ ] 开篇先抓"Metadata 的一部分为什么在流结束时才到"，而不是直接讲 Key 类型。
- [ ] 至少展开 3 个失败方案，且包含"Status 通过 headers 发送就够了""Metadata key 只有一种类型"。
- [ ] 明确给出 Metadata/Status/Trailers 的三段式生命周期总图。
- [ ] 不把本篇写成 Metadata 字段说明书。
- [ ] 每个核心机制（ASCII/Binary 类型、Status 编码/解码、trailers 剥离）先讲动机再给证据。
- [ ] 删除代码块后，读者仍能复述 Metadata 的 key 类型、Status 的编码/解码、trailers 的剥离机制。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。