# grpc-java：Marshaller、ProtoUtils 与消息对象桥 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch02-codegen-builders`
- 篇：`03 Marshaller、ProtoUtils 与消息对象桥`
- 对应主题：`G-DEEP-3 Marshaller、ProtoUtils 与消息对象桥`
- 文章类型：消息对象与 framing 机制补深篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：前面的 codegen 篇已经说明 `*Grpc` 会生成 method descriptor 和 marshaller，runtime 篇也反复出现 message、stream、compressor；但一个 Java 对象到底怎样变成 wire 上的 gRPC message，又怎样从输入字节还原成应用对象？中间的 framing、压缩、大小限制和按需交付又是谁负责？
- 一句话顿悟：grpc-java 把“对象类型契约”和“消息传输帧”拆成两座桥：`MethodDescriptor.Marshaller` / `ProtoUtils` / `ProtoLiteUtils` 负责对象与 `InputStream` 的类型化转换，`MessageFramer` / `MessageDeframer` 再负责 5 字节 gRPC message frame、压缩标志、长度、缓冲、流控交付与大小/解析失败。
- 文章边界：本篇重点解释 `MethodDescriptor.Marshaller`、`ProtoUtils`、`ProtoLiteUtils`、`MessageFramer`、`MessageDeframer` 怎样串成对象 -> 字节流 -> gRPC frame -> 对象的完整桥；不展开 protobuf 编译器内部、不重讲 Netty HTTP/2 frame、不把 compression registry 单独扩成另一篇。

## 前置依赖

### HARD

- `vol-rpc-governance/ch02-codegen-builders/01-protoc-grpc-skeleton.md`：已经知道 codegen 如何把 marshaller 写进 `MethodDescriptor`。
- `vol-rpc-governance/ch01-grpc-runtime/01-stub-channel-clientcall.md`：已经知道 `ClientCallImpl` 如何把对象交给 `ClientStream`。
- `vol-rpc-governance/ch01-grpc-runtime/02-servercall-and-streaming-model.md`：已经知道服务端调用如何从 stream 读出对象、写回响应。
- 至少知道 HTTP/2 stream 和 gRPC message frame 是两层不同概念。

### SOFT

- Netty HTTP/2 只作为 framing 之后的 transport 出口背景，不重讲。
- protobuf full/lite 的完整生态差异只点到 marshaller 选择。

### NAV

- 后续可接：Compression / Codec 深挖。
- 后续可接：InProcess Transport 与消息对象零拷贝/优化路径。

## 一句话困惑

为什么 `ClientCall.sendMessage(request)` 既不是直接把 Java 对象写到网络，也不是简单地交给 protobuf 序列化就结束，而还要经过 Marshaller、framer、压缩标志、5 字节长度头、deframer 和按需交付？

## 一句话顿悟

`Marshaller` 只负责回答“这个对象怎样变成可读字节流、字节流怎样还原成对象”，`MessageFramer` 再把这条字节流封装成 gRPC message frame，`MessageDeframer` 按 header/length/压缩/请求额度拆回消息；对象类型、消息帧和 HTTP/2 stream 因此被严格分成三层。

## 读者理解路径

1. 先否定“sendMessage 就是写对象”“protobuf 序列化就是全部消息传输”的直觉。
2. 建立最小总图：`Java object -> Marshaller -> InputStream -> MessageFramer -> gRPC frame -> transport -> MessageDeframer -> InputStream -> Marshaller -> Java object`。
3. 解释 `MethodDescriptor.Marshaller` 为什么只负责类型化对象/流转换，不负责 gRPC frame。
4. 解释 `ProtoUtils` / `ProtoLiteUtils` 如何把 protobuf full/lite 实现接入统一 Marshaller 接口。
5. 解释 `MessageFramer` 的 5 字节 header、压缩标志、长度、buffer、flush、max outbound size。
6. 解释 `MessageDeframer` 如何按 header/body 状态、压缩、max inbound size、request quota 交付消息。
7. 收束到 framing 失败、解析失败、部分消息、取消和流控为什么必须分别处理。

## 失败方案推演

### 失败方案一：`sendMessage()` 直接把 Java 对象写到 transport

- transport 不应该知道 protobuf/Java 对象类型
- 直接写对象会绕过 marshaller 与 framing
- 也无法统一支持自定义 marshaller、JSON/自定义 IDL 或不同 protobuf runtime
- 所以 `ClientStream` 接收的不是对象本身，而是经过 method descriptor 转成的消息流。

### 失败方案二：Marshaller 负责全部网络协议

- Marshaller 只负责对象与 `InputStream`
- 它不应该决定 compressed flag、5 字节长度头、flush、HTTP/2 stream 或 request quota
- 把这些都塞进 marshaller 会让类型转换和传输协议强耦合。

### 失败方案三：MessageFramer 只负责加一个长度头

- 它还要处理压缩、KnownLength/Drainable、buffer allocator、max outbound size、flush、endOfStream 和 stats
- 所以 framing 不是简单 prefix 操作，而是对象字节流进入 transport 前的资源与失败边界。

### 失败方案四：Deframer 收到字节就一直解析，不需要 request quota

- gRPC 必须配合 inbound flow control 和应用请求额度
- `MessageDeframer.request(numMessages)` 决定最多交付多少消息
- 解析失败、超限、partial frame、cancel 都要走不同收口
- 所以 deframer 是“字节 -> 消息事件”的状态机，不是一个 while 读取循环。

## 必须澄清的误解

1. Marshaller 不是 serializer + transport 的全集，它只负责类型化对象/流转换。
2. `ProtoUtils` / `ProtoLiteUtils` 只是 protobuf 到 Marshaller 的适配桥，不负责 gRPC frame。
3. gRPC message frame 与 HTTP/2 frame 不是同一层；前者由 `MessageFramer/Deframer` 处理，后者由 transport 处理。
4. `MessageFramer` 的 5 字节 header 不是可有可无的包装，它承载压缩标志和消息长度。
5. `MessageDeframer` 的 request quota、大小限制和 partial message 处理共同决定消息何时进入应用。

## 文章结构与字数预算

1. 困惑开场：对象为什么不能直接写到 transport（800-1000 字）
2. 最小总图：对象/Marshaller/framing/HTTP2/deframing 的五层桥（1200-1600 字）
3. `MethodDescriptor.Marshaller`：对象与 InputStream 的类型化边界（1800-2400 字）
4. `ProtoUtils` / `ProtoLiteUtils`：protobuf full/lite 如何接入统一桥（1400-2000 字）
5. `MessageFramer`：5 字节 header、压缩、buffer、flush 与大小边界（2200-3000 字）
6. `MessageDeframer`：header/body 状态、request quota、解压与 partial frame（2200-3000 字）
7. 失败路径与所有权收口：解析失败、超限、close、dispose、取消（1200-1800 字）
8. 收网总结：对象桥为什么是完整 RPC 卷不可缺的一层（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `api/src/main/java/io/grpc/MethodDescriptor.java:29`
- `api/src/main/java/io/grpc/MethodDescriptor.java:40`
- `api/src/main/java/io/grpc/MethodDescriptor.java:130`
- `api/src/main/java/io/grpc/MethodDescriptor.java:139`
- `api/src/main/java/io/grpc/MethodDescriptor.java:148`
- `api/src/main/java/io/grpc/MethodDescriptor.java:157`
- `api/src/main/java/io/grpc/MethodDescriptor.java:283`
- `api/src/main/java/io/grpc/MethodDescriptor.java:295`
- `api/src/main/java/io/grpc/MethodDescriptor.java:306`
- `api/src/main/java/io/grpc/MethodDescriptor.java:318`
- `protobuf/src/main/java/io/grpc/protobuf/ProtoUtils.java:25`
- `protobuf/src/main/java/io/grpc/protobuf/ProtoUtils.java:45`
- `protobuf/src/main/java/io/grpc/protobuf/ProtoUtils.java:54`
- `protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:39`
- `protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:76`
- `protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:85`
- `protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:133`
- `protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:162`
- `protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:167`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:41`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:70`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:102`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:133`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:184`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:237`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:304`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:323`
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:36`
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:43`
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:110`
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:156`
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:166`
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:212`
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:257`

## 测试证据清单

- `core/src/test/java/io/grpc/internal/MessageFramerTest.java:50`：framer 基本 framing 测试族。
- `core/src/test/java/io/grpc/internal/MessageDeframerTest.java:70`：deframer 基本状态机测试族。
- `core/src/test/java/io/grpc/internal/MessageDeframerTest.java:301`：压缩 deframing 路径。
- `core/src/test/java/io/grpc/internal/MessageDeframerTest.java:345`：size enforcing input stream 边界。
- `core/src/testFixtures/java/io/grpc/internal/AbstractTransportTest.java:866`：client message 从 stream 写出后在对端解析。
- `core/src/testFixtures/java/io/grpc/internal/AbstractTransportTest.java:912`：server response 从 stream 写出后在对端解析。
- `core/src/testFixtures/java/io/grpc/internal/AbstractTransportTest.java:1382`：大消息与大小边界。
- `core/src/testFixtures/java/io/grpc/internal/AbstractTransportTest.java:1573`：同一 stream 多消息 framing/deframing。
- `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:462`：服务端 listener 通过 method marshaller 解析请求对象。

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讲 gRPC message framing，不把 HTTP/2 frame 当成同一层。
- `ProtoLiteUtils` 的 full/lite 与 buffer 优化属于当前实现行为，不外推为所有 protobuf binding 的必然实现。
- `KnownLength`、`Drainable`、ThreadLocal buffer 等性能优化只讲其边界和动机，不展开成独立性能篇。

## 与其他篇的边界

### 本篇要讲清

- Java 对象怎样经过 Marshaller 进入 `InputStream`。
- protobuf full/lite 怎样接入统一 marshaller。
- `MessageFramer` 怎样把字节流变成 gRPC message frame。
- `MessageDeframer` 怎样按需拆帧、解压、限流并交付对象输入流。
- framing/deframing 的失败与回收边界。

### 本篇不深讲

- protoc 代码生成器内部算法。
- HTTP/2 frame / Netty connection handler。
- compression registry 全量专题。
- 自定义 JSON/其他 IDL binding 的完整实现。

## 写作后检查

- [ ] 开篇先抓“对象为什么不能直接写到 transport”，而不是直接列 Marshaller API。
- [ ] 至少展开 3 个失败方案，且包含“Marshaller 不是网络协议全集”和“Deframer 不是 while 读取循环”。
- [ ] 明确给出对象 -> Marshaller -> message frame -> deframer -> 对象的总图。
- [ ] 不把本文写成 protobuf API 词典。
- [ ] 不把 gRPC message frame 和 HTTP/2 frame 混成一层。
- [ ] 删除代码块后，读者仍能复述对象桥、framing 与 deframing 的职责边界。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。
