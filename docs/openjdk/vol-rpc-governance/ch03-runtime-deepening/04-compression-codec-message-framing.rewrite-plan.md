# grpc-java：Compression、Codec 与 Message Framing — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch03-runtime-deepening`
- 篇：`04 Compression、Codec 与 Message Framing`
- 对应主题：`G-DEEP-4 Compression / Codec / Message Framing`
- 文章类型：运行时机制补深篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：前面的主干篇已经反复提到 compressor、message framing、decompressor 这些概念，但读者一直没弄清楚：一次具体的 RPC 里，消息体到底是怎么被压成字节流、送到 wire、再被还原成消息对象的？压缩是在哪一层完成的？为什么有 `Message-Encoding` 和 `Content-Encoding` 两种 header？为什么 `Codec.Identity.NONE` 这个"什么都不做"的类在整个代码里到处都是引用相等判断？
- 一句话顿悟：grpc-java 在 gRPC wire format 的消息帧层（5 字节 header + 载荷）之上叠加了可选的 per-message 压缩，`MessageFramer` 编码时根据 `Compressor` 决定是否压缩并设 flags，`MessageDeframer` 解码时根据 flags 和 `Decompressor` 解压；`CompressorRegistry`/`DecompressorRegistry` 完成编码协商，`ServerCallImpl.sendHeadersInternal()` 会验证服务端选定的压缩器是否在客户端 `Accept-Encoding` 列表中；`Codec.Identity.NONE` 是一个 sentinel 值，用引用相等代替昂贵的字符串比较。
- 文章边界：本篇重点解释 wire format 5 字节帧头、per-message 压缩与解压路径、`MessageFramer`/`MessageDeframer` 的核心状态机、`Compressor`/`Decompressor` 接口与 `Codec` 的 sentinel 设计、`CompressorRegistry`/`DecompressorRegistry` 的注册与协商流程；不展开到 `GzipInflatingBuffer` 的全流压缩（`Content-Encoding`）的完整状态机细节（可单独成篇或放入生产排障），不重讲 Netty 传输层 HTTP/2 frame 读写。

## 前置依赖

### HARD

- `vol-rpc-governance/ch01-grpc-runtime/01-stub-channel-clientcall.md`：已经知道 `ClientCallImpl` 怎样在 `start()` 期间准备 headers。
- `vol-rpc-governance/ch01-grpc-runtime/02-servercall-and-streaming-model.md`：已经知道 `ServerCallImpl` 怎样在 `sendHeaders()` 中设置响应头。
- `vol-rpc-governance/ch02-codegen-builders/03-marshaller-protoutils-message-bridge.md`：已经知道消息对象怎样被 marshaller 压成 `InputStream`。

### SOFT

- 不要求先懂 Netty 的 ByteBuf 或 HTTP/2 frame 细节。
- 不要求先懂 `GzipInflatingBuffer` 的完整实现。

### NAV

- 后续可接：生产诊断卷中关于压缩导致的延迟/内存问题排查。
- 后续可接：`GzipInflatingBuffer` 全流压缩的独立专题。

## 一句话困惑

一次 gRPC 调用中，消息体从 Java 对象变成字节流放到网上，再从网上收回来变成另一个 Java 对象——中间到底经历了哪些压缩、编码、帧格式化的步骤？`Message-Encoding` 和 `Content-Encoding` 有什么区别？为什么 `Codec.Identity.NONE` 这个"什么都不干"的类在代码里被反复引用相等判断？

## 一句话顿悟

grpc-java 的压缩路径分两段：帧头（5 字节：1 字节压缩标志 + 4 字节大端消息长度）决定消息体是否被压缩；`MessageFramer` 根据 `Compressor` 产出压缩或未压缩的帧，`MessageDeframer` 根据帧头标志选择 `Decompressor` 或直通；`Codec.Identity.NONE` 作为 sentinel 用引用相等（`==`）代替字符串比较来短路整个压缩路径。

## 读者理解路径

1. 先否定"压缩就是在消息体上套一个 GzipOutputStream 的简单理解"。
2. 建立最小总图：帧头（5B）→ `MessageFramer.writePayload()` → (可选) `Compressor.compress()` → wire → `MessageDeframer.deframe()` → (可选) `Decompressor.decompress()` → `InputStream`。
3. 解释 wire format：5 字节帧头的结构（compressed flag + message length），以及为什么 `MessageFramer.HEADER_LENGTH = 5`。
4. 解释 `Compressor`/`Decompressor` 接口的对称设计，以及 `Codec` 将两者组合的便利性。
5. 解释 `Codec.Identity.NONE` sentinel 的设计：为什么不用 null 而用引用相等判断。
6. 解释 `MessageFramer` 写路径：`writePayload()` → `writeCompressed()`/`writeUncompressed()` → `writeBufferChain()` → `Sink.deliverFrame()`。
7. 解释 `MessageDeframer` 读路径：`deframe()` → `deliver()` 循环 → `processHeader()` → `processBody()` → `getCompressedBody()`/`getUncompressedBody()`。
8. 解释 `CompressorRegistry`/`DecompressorRegistry` 的注册与协商机制。
9. 解释 `ClientCallImpl.prepareHeaders()` 和 `ServerCallImpl.sendHeadersInternal()` 的协商流程。
10. 收束到：wire format 是 gRPC 协议的基础设施，压缩是 wire format 上的可选层，`Codec.Identity.NONE` sentinel 是 grpc-java 对性能的极致追求。

## 失败方案推演

### 失败方案一：压缩就是在消息体上加一个 GzipOutputStream

- 这会漏掉 wire format 的 5 字节帧头结构。
- 会漏掉 compressed flag 的语义：压缩标志位放在帧头中，而不是通过消息体本身标记。
- 会漏掉 `MessageFramer` 和 `MessageDeframer` 两层分工：一个负责编码（含压缩），一个负责解码（含解压）。
- 所以压缩不是"套一个 GzipStream"，而是 wire format 上的可选层。

### 失败方案二：消息体直接通过 HTTP/2 DATA frame 发送，不需要额外的帧层

- 如果真的是这样，那 gRPC 就不需要 `MessageFramer.HEADER_LENGTH = 5` 这个设计了。
- HTTP/2 DATA frame 本身就是带长度的，但 gRPC 在 HTTP/2 之上又加了一层 5 字节帧头，原因在于：gRPC 支持多消息流（streaming），HTTP/2 DATA frame 的负载可能包含多个 gRPC 消息，需要帧头来分割。
- 此外，gRPC 的压缩标志是 per-message 的，HTTP/2 没有这个语义。
- 所以 gRPC 的 5 字节帧头不是多余的，它是 gRPC 协议的核心基础设施。

### 失败方案三：用 null 表示"不压缩"就够了，不需要 `Codec.Identity.NONE`

- 如果用 null，每处调用都需要 `if (compressor == null || compressor == someIdentity)` 这种双重判断。
- 用 `Codec.Identity.NONE` 作为 sentinel，配合 `compressor != Codec.Identity.NONE` 的引用相等判断，一次检查就够了。
- 而且 `Codec.Identity.NONE` 的 `compress()` 返回原 `OutputStream`，`decompress()` 返回原 `InputStream`，在必须使用 Compressor 接口的地方可以透明地传递。
- 所以 sentinel 模式减少了一次 null check，避免了分支，提升了性能。

## 必须澄清的误解

1. gRPC 的 wire format 不是 HTTP/2 DATA frame 本身，而是在 DATA frame 负载内再加一层 5 字节帧头。
2. `Message-Encoding` 是 per-message 压缩（gRPC 层），`Content-Encoding` 是 full-stream 压缩（HTTP 层），两者互斥。
3. `Codec.Identity.NONE` 不是"不设置压缩器"，而是一个主动选择的 no-op 压缩器，用 sentinel 模式避免 null check。
4. `Compressor` 和 `Decompressor` 接口不是对称的工厂方法，而是对称的流包装器（compress 包装 OutputStream，decompress 包装 InputStream）。
5. 服务端不是随便选一个压缩器就能用——它必须在 `sendHeaders()` 中验证客户端是否在 `Message-Accept-Encoding` 中声明了支持。

## 文章结构与字数预算

1. 困惑开场：为什么"套一个 GzipOutputStream"远远不够解释 gRPC 的压缩（800-1000 字）
2. 最小总图：从 `InputStream` 到 wire 再到 `InputStream` 的两段路径（1000-1400 字）
3. Wire format：5 字节帧头 + compressed flag + message length（1400-2000 字）
4. `Compressor`/`Decompressor` 接口与 `Codec` sentinel 设计（1400-2000 字）
5. `MessageFramer` 写路径：`writePayload()` → `writeCompressed()`/`writeUncompressed()` → `writeBufferChain()` → `Sink`（1800-2400 字）
6. `MessageDeframer` 读路径：`deframe()` → `deliver()` → `processHeader()` → `processBody()`（1800-2400 字）
7. 压缩协商：`CompressorRegistry`/`DecompressorRegistry` + `ClientCallImpl.prepareHeaders()` + `ServerCallImpl.sendHeadersInternal()`（1600-2200 字）
8. 收网总结：wire format 是基础设施，压缩是可选层，sentinel 是性能追求（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### Wire format
- `core/src/main/java/io/grpc/internal/MessageFramer.java:70` — `HEADER_LENGTH = 5`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:71` — `UNCOMPRESSED = 0`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:72` — `COMPRESSED = 1`

### Compressor / Decompressor / Codec
- `api/src/main/java/io/grpc/Compressor.java:32` — `getMessageEncoding()` 返回编码名称
- `api/src/main/java/io/grpc/Compressor.java:39` — `compress(OutputStream)` 包装输出流
- `api/src/main/java/io/grpc/Decompressor.java:32` — `getMessageEncoding()` 对称设计
- `api/src/main/java/io/grpc/Decompressor.java:39` — `decompress(InputStream)` 包装输入流
- `api/src/main/java/io/grpc/Codec.java:27` — `Codec` 接口同时继承 `Compressor` 和 `Decompressor`
- `api/src/main/java/io/grpc/Codec.java:38` — `Codec.Gzip` 返回 `"gzip"`
- `api/src/main/java/io/grpc/Codec.java:61` — `Codec.Identity.NONE` 单例
- `api/src/main/java/io/grpc/Codec.java:70` — `Identity.getMessageEncoding()` 返回 `"identity"`
- `api/src/main/java/io/grpc/Codec.java:74` — `Identity.compress()` 返回原 `OutputStream`
- `api/src/main/java/io/grpc/Codec.java:64` — `Identity.decompress()` 返回原 `InputStream`

### Registries
- `api/src/main/java/io/grpc/CompressorRegistry.java:41` — `getDefaultInstance()` 包含 Gzip 和 Identity
- `api/src/main/java/io/grpc/CompressorRegistry.java:63` — `lookupCompressor(String)` 按名称查找
- `api/src/main/java/io/grpc/DecompressorRegistry.java:49` — `getDefaultInstance()` 包含 Gzip(advertised) 和 Identity(not advertised)
- `api/src/main/java/io/grpc/DecompressorRegistry.java:63` — `with(Decompressor, boolean)` 不可变设计
- `api/src/main/java/io/grpc/DecompressorRegistry.java:99` — `getKnownMessageEncodings()` 所有已注册编码
- `api/src/main/java/io/grpc/DecompressorRegistry.java:116` — `getAdvertisedMessageEncodings()` 仅广告的编码
- `api/src/main/java/io/grpc/DecompressorRegistry.java:135` — `lookupDecompressor(String)` 查找（忽略 advertised）

### MessageFramer
- `core/src/main/java/io/grpc/internal/MessageFramer.java:102` — 构造函数：Sink, WritableBufferAllocator, StatsTraceContext
- `core/src/main/java/io/grpc/internal/MessageFramer.java:110` — `setCompressor(Compressor)`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:116` — `setMessageCompression(boolean)`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:133` — `writePayload(InputStream)` 核心方法
- `core/src/main/java/io/grpc/internal/MessageFramer.java:139` — 压缩判断：`messageCompression && compressor != Codec.Identity.NONE`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:173` — `writeUncompressed(InputStream, int)`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:184` — `writeCompressed(InputStream, int)`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:237` — `writeBufferChain(BufferChainOutputStream, boolean)` 写 5 字节头 + 载荷
- `core/src/main/java/io/grpc/internal/MessageFramer.java:393` — `BufferChainOutputStream` 收集压缩输出

### MessageDeframer
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:52` — `Listener` 接口定义
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:118` — 构造函数
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:141` — `setDecompressor(Decompressor)`
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:166` — `deframe(ReadableBuffer)` 喂入数据
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:260` — `deliver()` 核心循环
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:383` — `processHeader()` 解析 5 字节帧头
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:411` — `processBody()` 分发到压缩/未压缩
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:428` — `getUncompressedBody()` 直通
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:433` — `getCompressedBody()` 用 `decompressor.decompress()` 解压
- `core/src/main/java/io/grpc/internal/MessageDeframer.java:455` — `SizeEnforcingInputStream` 解压后大小限制

### 协商流程
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:155` — `prepareHeaders()` 设置 Message-Encoding/Accept-Encoding
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:188` — `startInternal()` 解析 compressor
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:217` — 从 `compressorRegistry.lookupCompressor()` 获取
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:108` — `sendHeadersInternal()` 验证 compressor
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:117` — 校验 `messageAcceptEncoding` 是否包含选择的编码
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:193` — `setCompression(String)` 按名称查找 compressor
- `core/src/main/java/io/grpc/internal/ServerImpl.java:473` — `streamCreatedInternal()` 读取客户端 Message-Encoding 设置 decompressor

## 测试证据清单

- `core/src/test/java/io/grpc/internal/MessageFramerTest.java` — framer 写路径、压缩/未压缩、flush/close 行为
- `core/src/test/java/io/grpc/internal/MessageDeframerTest.java` — deframer 读路径、header 解析、压缩/未压缩、大小限制
- `api/src/test/java/io/grpc/CodecTest.java` — Codec.Gzip 和 Codec.Identity 行为
- `api/src/test/java/io/grpc/CompressorRegistryTest.java` — 注册/查找语义
- `api/src/test/java/io/grpc/DecompressorRegistryTest.java` — 不可变设计、advertised 语义
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java` — prepareHeaders 的压缩 header 设置
- `core/src/test/java/io/grpc/internal/ServerCallImplTest.java` — sendHeaders 的 compressor 协商验证

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讨论的是 gRPC per-message 压缩（`Message-Encoding`），不展开 `Content-Encoding` 全流压缩的 `GzipInflatingBuffer` 完整状态机。
- `Codec.Identity.NONE` 的 sentinel 模式是 grpc-java 的具体实现，不是 gRPC 规范要求。
- gRPC wire format（5 字节帧头）是 gRPC 规范的一部分，但具体实现细节（如 `BufferChainOutputStream` 的逐块交付策略）是 grpc-java 的实现选择。

## 与其他篇的边界

### 本篇要讲清

- gRPC wire format 的 5 字节帧头结构。
- `MessageFramer` 写路径和 `MessageDeframer` 读路径的核心机制。
- `Compressor`/`Decompressor`/`Codec` 接口设计。
- `Codec.Identity.NONE` sentinel 模式。
- 客户端与服务端之间的压缩协商流程。

### 本篇不深讲

- `GzipInflatingBuffer` 的全流压缩（`Content-Encoding`）状态机（可单独成篇）。
- Netty 传输层的 HTTP/2 frame 读写细节。
- 压缩导致的延迟/内存/CPU 问题排查（留给生产诊断卷）。
- `Marshaller` 的消息体序列化（已在 ch02/03 篇中覆盖）。

## 写作后检查

- [ ] 开篇先抓"为什么套一个 GzipOutputStream 不够"，而不是直接讲帧头格式。
- [ ] 至少展开 3 个失败方案，且包含"消息体直接通过 HTTP/2 DATA frame 发送""用 null 表示不压缩就够了"。
- [ ] 明确给出 wire format 5 字节帧头的结构图。
- [ ] 不把本篇写成 `MessageFramer`/`MessageDeframer` 的字段说明书。
- [ ] 每个核心机制（sentinel 模式、BufferChain 交付、SizeEnforcingInputStream）先讲动机再给证据。
- [ ] 删除代码块后，读者仍能复述压缩路径、wire format 和协商流程。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。