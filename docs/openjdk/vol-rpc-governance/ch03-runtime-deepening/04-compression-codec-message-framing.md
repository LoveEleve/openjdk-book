# grpc-java：Compression、Codec 与 Message Framing — 消息体到字节流的桥梁

> 基于 grpc-java v1.83.1

## 一、困惑开场：一个"套 GzipOutputStream"远远不够的问题

假设你写了一个 gRPC 服务，其中某个方法返回一个很大的响应体——比如 10MB 的 protobuf 消息。你直觉上会想："给这个消息体加个 Gzip 压缩，传输量就下来了。" 于是你查了一下 grpc-java 的 API，找到了 `ServerCall.setCompression("gzip")`，把它加上了。消息体确实变小了，但你开始好奇：这行代码到底做了什么？

你可能以为它就是在消息体外面套了一个 `GZIPOutputStream`，然后把压缩后的字节扔到网络上。如果真是这么简单，那 gRPC 的压缩机制就只需要一个工具方法，根本不需要一套独立的接口体系。

但实际代码远比这个复杂。压缩不是"套一个 GzipStream"这么简单，原因有三个。

第一，gRPC 的消息不是直接放在 HTTP/2 DATA frame 里发送的——它在 DATA frame 的负载里又加了一层自己的帧头。这个帧头只有 5 个字节，但包含了压缩标志和消息长度两个关键信息。接收方必须先读这 5 个字节，才能知道后续的载荷是压缩的还是未压缩的。

第二，压缩不是"要么全开要么全关"的二元选择。gRPC 支持 per-message 压缩（每个消息独立决定是否压缩）和 full-stream 压缩（整个流级别的 Gzip 压缩），两者互斥。Per-message 压缩又涉及客户端和服务端之间的编码协商——客户端声明它支持哪些编码，服务端只能从客户端声明过的编码中选择。

第三，grpc-java 用了一个非常特别的方式来表示"不压缩"：它没有用 null，而是用了一个 `Codec.Identity.NONE` 单例，通过引用相等（`==`）来判断。这不是一个随意的设计选择，它反映了 grpc-java 在性能路径上的极致追求。

所以，`setCompression("gzip")` 这行代码背后，是一整套从 `Compressor` 接口到 `MessageFramer` 帧头、再到 `MessageDeframer` 解压路径的机制。本文就是要把这条路径走通。

## 二、前情回顾：消息体是怎么变成字节的

在 ch02/03 的 marshaller 篇中，我们已经建立过一个关键结论：一个 protobuf 消息对象不会直接在网络上传输，它会先经过 `Marshaller` 变成 `InputStream`——marshaller 负责"对象 → 字节流"这一段。你已经知道，这个 `InputStream` 就是消息体的原始字节，也可以说是消息在网络上的"原料"。

但接下来还差两段路才能到网络。

第一段是帧化。`InputStream` 只是连续的字节，接收方怎么知道一条消息从哪里开始、到哪里结束？如果消息之间没有边界，接收方根本无法把流切成一个个独立的消息对象。第二段是压缩。如果不压缩，10MB 的消息就是 10MB 的量在网络上跑；如果要压缩，就必须在压缩标志、编码名称、解压能力之间做协商。

这两段路正是本篇的主角：`MessageFramer` 负责把 `InputStream` 切成带帧头的帧（帧化 + 可选压缩），`MessageDeframer` 负责把帧还原成 `InputStream`（解帧 + 可选解压），外加一套 `Codec`/`Registry` 协商机制决定"用什么编码、支不支持解码"。

## 三、先走三条失败的路

### 失败方案一：压缩就是在消息体外面套一个 GzipOutputStream

最朴素的想象是：客户端拿到消息体的 `InputStream`，外面包一层 `GZIPOutputStream`，压缩后的字节直接放进 HTTP/2 DATA frame 发送；服务端收到 DATA frame 后，用 `GZIPInputStream` 解压，拿到原始字节。

这个方案的问题在于，它没有考虑"接收方怎么知道这个 frame 是压缩过的"。如果每个 frame 都是压缩的，那确实可以约定"全部压缩"，但 gRPC 允许 per-message 粒度控制压缩——你可以在同一个 stream 里，前一个消息压缩、后一个消息不压缩。接收方必须能从帧数据里区分出"这个帧是压缩的还是未压缩的"。

所以需要在帧头里放一个压缩标志位。这就是 gRPC wire format 的 5 字节帧头为什么存在——不是因为它喜欢加额外开销，而是因为压缩标志必须和消息体放在一起传输。

### 失败方案二：消息体直接塞进 HTTP/2 DATA frame，不需要额外帧层

如果你熟悉 HTTP/2，你可能会想：HTTP/2 DATA frame 本身就有 length 字段，为什么 gRPC 还要在 DATA frame 的 payload 里再包一层 5 字节的帧头？

这个问题的答案在于 gRPC 的 streaming 语义。HTTP/2 DATA frame 的 payload 可以包含多个 gRPC 消息（比如在 server-streaming 场景中，服务端连续发送多个消息，HTTP/2 可能把它们合并到同一个 DATA frame 中）。gRPC 的 5 字节帧头就是用来在这个"可能包含多个消息的 DATA frame payload"里分割出每个消息的边界。

此外，HTTP/2 的 DATA frame 没有压缩标志位——它不知道载荷里的数据是 gzip 压缩的还是 protobuf 原始字节。而 gRPC 的帧头提供了这个标志。

所以，5 字节帧头不是多余的，它是 gRPC 协议在 HTTP/2 之上实现多消息流和 per-message 压缩的基础设施。

### 失败方案三：用 null 表示"不压缩"就够了，不需要 Codec.Identity.NONE

如果不需要压缩，最直接的方式是把 compressor 设为 null，每处使用时检查 `if (compressor != null)`。但 grpc-java 没有这么选。

用 null 的问题在于，它需要两重检查：先检查 null，再检查 compressor 是不是某个具体实现。如果使用 `Codec.Identity.NONE` 这个 sentinel 单例，配合 `compressor != Codec.Identity.NONE` 的引用相等判断，一次比较就够了。而且 `Codec.Identity.NONE` 的 `compress()` 方法返回原 `OutputStream`，`decompress()` 返回原 `InputStream`——在必须使用 `Compressor` 接口的地方，它可以透明地传递，不需要特殊的 null 分支代码。

所以，sentinel 模式不是过度设计，而是在 gRPC 这种高性能路径中，减少一次 null check 和消除分支带来了可测量的性能收益。

## 四、最小总图：从 InputStream 到 wire 再到 InputStream

在进入具体实现之前，先建立一张总图。

从发送方看，一条消息的生命周期是：

```
InputStream → MessageFramer.writePayload() → (可选) Compressor.compress() → 5字节帧头 + 载荷 → Sink.deliverFrame() → Netty → HTTP/2 DATA frame
```

从接收方看，是逆向的：

```
HTTP/2 DATA frame → MessageDeframer.deframe() → processHeader() 解析5字节帧头 → (可选) Decompressor.decompress() → InputStream → 应用代码
```

中间的两个关键角色是 `MessageFramer`（写端）和 `MessageDeframer`（读端）。它们不关心消息内容是什么（那是 marshaller 的事），只关心"怎么把 InputStream 切成帧"和"怎么把帧还原成 InputStream"。

压缩是挂在这条路径上的一个可选层。`Compressor` 负责压缩（包装 OutputStream），`Decompressor` 负责解压（包装 InputStream）。`Codec` 把两者合二为一，`Codec.Identity.NONE` 是一个什么都不做的 sentinel。

这条路径中的每一层都有明确的职责，下面分层拆解。

## 五、Wire format：5 字节帧头

先讲最基础的东西：gRPC 的 wire format。每个 gRPC 消息被编码成下面这个格式：

```
+------------------+---------------------+
| 压缩标志 (1 byte) | 消息长度 (4 bytes)   |
+------------------+---------------------+
| 消息体 (length bytes)                    |
+------------------------------------------+
```

`MessageFramer.java:70` — `HEADER_LENGTH = 5`
`MessageFramer.java:71` — `UNCOMPRESSED = 0`
`MessageFramer.java:72` — `COMPRESSED = 1`

压缩标志位只有两个取值：0（未压缩）和 1（压缩）。消息长度是 4 字节的大端无符号整数，表示后续消息体的字节数。

这 5 个字节是 gRPC 协议的核心基础设施。`MessageFramer` 写帧时，在消息体前面加上这 5 个字节；`MessageDeframer` 读帧时，先读这 5 个字节，解析出压缩标志和消息长度，再决定后续的读取方式。

注意，消息长度是**压缩前**的长度还是**压缩后**的长度？答案是压缩后的长度。因为帧头是在压缩之后才写入的，`writeBufferChain()` 先把消息体通过 `Compressor.compress()` 压缩，然后统计压缩后的字节数，再写入帧头。

## 六、Compressor、Decompressor 与 Codec：对称的流包装器

### 6.1 发送方要压缩，接收方要解压——接口怎么设计

发送方和接收方各有各的需求。发送方拿到一个 `OutputStream` 后，想往里面写数据时数据自动被压缩；接收方拿到一个 `InputStream` 后，想从里面读数据时数据自动被解压。

grpc-java 的 `Compressor` 接口就是为发送方设计的：它接收一个 `OutputStream`，返回一个包装了压缩逻辑的 `OutputStream`。你向这个包装流写数据，数据就会被压缩后再写入原始流。发送方不需要知道压缩算法是什么，它只需要知道"给我一个 OutputStream，我往里写，你帮我压"。

`Compressor.java:32` — `getMessageEncoding()` 返回编码名称（如 `"gzip"`）
`Compressor.java:39` — `compress(OutputStream os)` 包装输出流

`Decompressor` 是为接收方设计的，接口完全对称：它接收一个 `InputStream`，返回一个包装了解压逻辑的 `InputStream`。你从包装流读数据，数据就会被解压后再返回。

`Decompressor.java:32` — `getMessageEncoding()` 返回编码名称
`Decompressor.java:39` — `decompress(InputStream is)` 包装输入流

如果一个类既想当发送方的压缩器，又想当接收方的解压器（比如 Gzip 同时支持压缩和解压），它就需要同时实现 `Compressor` 和 `Decompressor`。`Codec` 接口就是为了这个场景存在的——它同时继承两者，让一个类可以同时处理压缩和解压。

`Codec.java:27` — `Codec` 接口同时继承 `Compressor` 和 `Decompressor`

### 6.2 grpc-java 内置了什么压缩器

grpc-java 内置了两个 `Codec` 实现，一个真干活，一个装样子。

`Codec.Gzip` 用 `java.util.zip.GZIPOutputStream` 和 `GZIPInputStream` 实现真正的 gzip 压缩。

`Codec.java:38` — `Codec.Gzip` 的 `getMessageEncoding()` 返回 `"gzip"`

`Codec.Identity` 是"什么都不做"的实现。它的 `compress()` 方法直接返回传入的 `OutputStream`，没有包装任何压缩逻辑；`decompress()` 也直接返回传入的 `InputStream`。

`Codec.java:61` — `Codec.Identity.NONE` 单例
`Codec.java:74` — `Identity.compress()` 返回原 `OutputStream`
`Codec.java:64` — `Identity.decompress()` 返回原 `InputStream`

### 6.3 为什么不用 null 表示"不压缩"

熟悉 Java 的读者可能会想：`Codec.Identity` 不做任何事，那为什么不干脆把 compressor 设为 null，用 `if (compressor != null)` 来判断？

grpc-java 的作者不是没想过这个方案，但 null 有两个问题。

第一，null 需要两重检查。如果使用 null，每处调用先要检查 `compressor != null`，再检查 compressor 是不是某个具体实现（比如 `Identity`）。而 `Codec.Identity.NONE` 是一个单例，配合 `compressor != Codec.Identity.NONE` 的引用相等判断，一次比较就够了。

第二，null 不能透明地通过接口传递。`MessageFramer.writeCompressed()` 需要调用 `compressor.compress(bufferChain)`，如果 compressor 是 null，这里必须加一个 `if (compressor == null) { writeUncompressed(); } else { compressed.compress(); }` 的分支。而 `Codec.Identity.NONE.compress()` 直接返回原 `OutputStream`，不需要任何特殊处理——它就是一个合法的 `Compressor`，只是什么都不做而已。

`MessageFramer.java:139` — `messageCompression && compressor != Codec.Identity.NONE`

这看起来是一个很小的优化，但 `MessageFramer.writePayload()` 是每条消息都要经过的 hot path，减少一次 null check 和分支，在 gRPC 这种高性能中间件中是有意义的。

## 七、发送方写帧：MessageFramer 把 InputStream 变成帧

这里先做一个路标。下面这一节讲的是发送方（客户端或服务端都可以）怎么把消息体变成帧。如果你已经理解了 wire format 的 5 字节帧头，这一节就是看它怎么被实际写出来的。核心路径只有一条：`writePayload()` 决定是否压缩 → 压缩或未压缩分支 → 写帧头 → 交付给传输层。

### 7.1 发送方怎么决定要不要压缩

`MessageFramer` 收到一个消息体的 `InputStream` 后，第一件事不是写帧头，而是先判断这个消息要不要压缩。

`MessageFramer.java:133` — `writePayload(InputStream)` 核心方法

判断逻辑是：`messageCompression` 开关打开（默认 true），且当前 compressor 不是 `Codec.Identity.NONE`。前者是每条消息的独立开关，后者是全局压缩器。

`MessageFramer.java:139` — 压缩判断：`messageCompression && compressor != Codec.Identity.NONE`

如果启用压缩，走 `writeCompressed()` 路径；否则走 `writeUncompressed()` 路径。

### 7.2 消息体先过压缩器

`writeCompressed()` 做的事情是：创建一个 `BufferChainOutputStream`，让 `compressor.compress()` 把它包装成一个压缩输出流，然后消息体写入这个压缩流，最后把压缩后的字节链装帧。

`MessageFramer.java:184` — `writeCompressed(InputStream, int)`

这里有一个性能设计：`BufferChainOutputStream` 不是把所有压缩后的字节全收进一个 `byte[]` 再一次性交付，而是按块收集到 `WritableBuffer` 链中。当链中的某个块写满时，它立即被交付给 `Sink`（传输层回调），只有最后一个块保留在内存中等待后续可能的写入。

`MessageFramer.java:393` — `BufferChainOutputStream` 收集压缩输出

为什么要这么做？因为大消息（比如 10MB 的 protobuf）全部压进一个缓冲区后再发送，内存开销和延迟都大。边压缩边交付，减少了内存拷贝，也降低了首字节延迟。

### 7.3 不压缩时走另一条路

如果消息体不需要压缩，`writeUncompressed()` 走一条更轻量的路径。对于已知长度的消息，它可以直接将消息体字节写入 `OutputStreamAdapter`，然后写入帧头。

`MessageFramer.java:173` — `writeUncompressed(InputStream, int)`

### 7.4 写帧头：5 字节的诞生

无论压缩还是未压缩，最后都会走到 `writeBufferChain()`。这一步把 5 字节帧头写入 `Sink`——帧头包含 1 字节的压缩标志（`UNCOMPRESSED = 0` 或 `COMPRESSED = 1`）和 4 字节大端消息长度（注意是压缩后的长度）。

`MessageFramer.java:237` — `writeBufferChain(BufferChainOutputStream, boolean)` 写 5 字节头 + 载荷

### 7.5 交付给传输层

`MessageFramer` 不直接写网络。它通过 `Sink` 接口把帧交付给传输层。

`MessageFramer.java:53` — `Sink` 接口定义：`deliverFrame(WritableBuffer, endOfStream, flush, numMessages)`

在客户端，`Sink` 的实现是 `AbstractClientStream`，它把帧交给 Netty 的 `SendGrpcFrameCommand`。在服务端，`Sink` 的实现是 `AbstractServerStream`。到这里，帧已经走出了 gRPC 帧层，进入了 HTTP/2 传输层。

## 八、接收方读帧：MessageDeframer 走状态机还原 InputStream

再做一个路标。写路径讲完了，现在进入读路径。注意读路径和写路径是逆向对应的——写路径的帧头就是读路径第一步要解析的东西。如果你对写路径已经熟悉了，读路径的核心思想是一样的，只是方向相反。

### 8.1 接收方拿到字节后从哪里开始

`MessageDeframer` 收到从传输层来的原始字节后，调用 `deframe(ReadableBuffer)` 开始处理。

`MessageDeframer.java:166` — `deframe(ReadableBuffer)` 喂入数据

接收方不像发送方那样"一条消息写一次"——数据可能分批到达，每次到一批就喂给 `deframe()`。`MessageDeframer` 内部是一个状态机，在 `HEADER` 和 `BODY` 之间来回切换：

```
HEADER → 读取5字节帧头 → 解析压缩标志和消息长度 → BODY
BODY → 读取消息体 → 根据压缩标志决定是否解压 → 交付消息 → HEADER
```

### 8.2 核心循环：deliver()

`deliver()` 是 `MessageDeframer` 的核心循环。它持续处理数据，直到当前批次的消息全部交付完毕，或者数据不足以继续处理。

`MessageDeframer.java:260` — `deliver()` 核心循环

### 8.3 接收方先读 5 个字节

写路径是先写 5 字节帧头再写消息体，读路径当然是先读 5 字节帧头再读消息体。`processHeader()` 从输入流中读取 5 个字节，解析出压缩标志和消息长度。它还会检查消息长度是否超过 `maxInboundMessageSize` 的限制。

`MessageDeframer.java:383` — `processHeader()` 解析 5 字节帧头

### 8.4 根据帧头决定读法

`processBody()` 根据帧头中的压缩标志位走不同路径。

如果标志位是 `UNCOMPRESSED`，调用 `getUncompressedBody()`，直接返回 `ReadableBuffers.openStream(nextFrame)`——消息体就是原始字节，不需要解压。

`MessageDeframer.java:428` — `getUncompressedBody()` 直通

如果标志位是 `COMPRESSED`，调用 `getCompressedBody()`。这里有一个关键检查：如果当前 `decompressor` 是 `Codec.Identity.NONE`（即没有注册任何解压器），但消息体却是压缩的，说明数据有问题，会抛出异常。

`MessageDeframer.java:433` — `getCompressedBody()` 用 `decompressor.decompress()` 解压

正常路径下，`getCompressedBody()` 用 `decompressor.decompress()` 包装原始字节流，返回一个解压后的 `InputStream`。

### 8.5 解压后的大小限制

解压后的消息可能是巨大的——攻击者可以发送一个极小但压缩后膨胀极大的消息来耗尽服务端内存。为了防御这种攻击，`MessageDeframer` 在解压后的流上再包一层 `SizeEnforcingInputStream`，逐字节计数，一旦超过 `maxInboundMessageSize` 就抛出 `RESOURCE_EXHAUSTED` 异常。

`MessageDeframer.java:455` — `SizeEnforcingInputStream` 解压后大小限制

### 8.6 交付给应用层

`MessageDeframer` 不直接调用应用代码。它通过 `Listener` 接口交付消息。

`MessageDeframer.java:52` — `Listener` 接口定义：`messagesAvailable()`, `bytesRead()`, `deframerClosed()`, `deframeFailed()`

当 `processBody()` 完成一个消息的解析后，`deliver()` 调用 `listener.messagesAvailable(new SingleMessageProducer(stream))`，把解压后的 `InputStream` 交给上层处理。上层代码（`ClientCallImpl` 或 `ServerCallImpl`）拿到这个 `InputStream` 后，通过 `Marshaller.parse()` 把它还原成 protobuf 对象——到这里，消息体从字节流回到了 Java 对象，读写路径形成了闭环。

## 九、压缩协商：客户端和服务端怎么约定用什么编码

再做一个路标。帧层已经讲完了，现在进入更高一层——压缩协商。这一层不在 `MessageFramer` 或 `MessageDeframer` 中，而是在 `ClientCallImpl` 和 `ServerCallImpl` 中，通过 HTTP/2 header 完成。如果你对"帧怎么读写"已经清楚了，那么这一节回答的是"用哪个编码来压缩"这个问题。

### 9.1 客户端在 header 里声明自己支持什么

客户端在发起调用时，通过 `ClientCallImpl.prepareHeaders()` 设置四个压缩相关的 header。

`ClientCallImpl.java:155` — `prepareHeaders()` 设置压缩 header

```
Message-Encoding: gzip              ← 客户端发消息时用的压缩器
Message-Accept-Encoding: gzip,identity  ← 客户端收消息时支持的解压器
Content-Encoding: (reserved)
Content-Accept-Encoding: gzip       ← 客户端支持的全流解压
```

`Message-Encoding` 的值来自 `CallOptions` 中设置的 compressor，如果未设置，默认是 `identity`。

`ClientCallImpl.java:217` — 从 `compressorRegistry.lookupCompressor()` 获取 compressor
`ClientCallImpl.java:240` — 默认回退到 `Codec.Identity.NONE`

`Message-Accept-Encoding` 的值来自 `DecompressorRegistry.getAdvertisedMessageEncodings()`。注意，不是所有注册的 decompressor 都会被广告——只有注册时 `advertised` 参数为 true 的才会出现在 `Accept-Encoding` 中。

### 9.2 服务端选择

服务端收到客户端的请求后，在 `ServerImpl.streamCreatedInternal()` 中读取客户端的 `Message-Encoding` header，找出对应的 decompressor，设置到 stream 上。

`ServerImpl.java:473` — `streamCreatedInternal()` 读取客户端 Message-Encoding 设置 decompressor

当服务端准备发送响应时，在 `ServerCallImpl.sendHeadersInternal()` 中确定自己要用的 compressor。

`ServerCallImpl.java:108` — `sendHeadersInternal()` 验证 compressor

这里有一个关键约束：服务端不能随便选一个 compressor。它必须检查客户端在 `Message-Accept-Encoding` 中声明了哪些编码，只能从中选择。

`ServerCallImpl.java:117` — 校验 `messageAcceptEncoding` 是否包含选择的编码

如果客户端没有声明支持 `gzip`，但服务端选了 `gzip`，那客户端收到响应后可能无法解压——因为客户端可能没有注册 `GzipDecompressor`。grpc-java 在这一点上做了保护：如果服务端选择的 compressor 不在客户端的 `Accept-Encoding` 中，`sendHeadersInternal()` 会回退到 `Codec.Identity.NONE`。

### 9.3 谁来决定哪些编码可用

发送方和接收方各自需要一个地方来存放可用的压缩器和解压器。`CompressorRegistry` 就是给发送方用的：它按编码名称注册 compressor，发送方根据名称查到对应的 compressor 实例。它的默认实例包含 `Codec.Gzip` 和 `Codec.Identity.NONE`。

`CompressorRegistry.java:41` — `getDefaultInstance()` 包含 Gzip 和 Identity
`CompressorRegistry.java:63` — `lookupCompressor(String)` 按名称查找

`DecompressorRegistry` 是给接收方用的。与 `CompressorRegistry` 不同，它是不可变的——每次 `with()` 调用都返回一个新的实例。为什么不可变？因为 decompressor 的注册信息（哪些编码可用、哪些被广告）涉及安全性和兼容性，不允许在运行时被意外修改。

`DecompressorRegistry.java:49` — `getDefaultInstance()` 包含 Gzip(advertised) 和 Identity(not advertised)
`DecompressorRegistry.java:63` — `with(Decompressor, boolean)` 不可变设计

`DecompressorRegistry` 跟踪两个集合：`knownMessageEncodings`（所有已注册的编码）和 `advertisedMessageEncodings`（仅被广告的编码）。当一个 decompressor 被注册时，`advertised` 参数决定它是否出现在 `Accept-Encoding` header 中。但即使不广告，它仍然可以用于解压客户端发来的消息。

`DecompressorRegistry.java:99` — `getKnownMessageEncodings()` 所有已注册编码
`DecompressorRegistry.java:116` — `getAdvertisedMessageEncodings()` 仅广告的编码
`DecompressorRegistry.java:135` — `lookupDecompressor(String)` 查找（忽略 advertised）

这种设计让服务端可以"支持解压所有编码，但只广告一部分"——在兼容性和功能之间取得了平衡。

## 十、误解澄清

### 误解一：压缩开销只影响消息体大小，不影响帧结构

很多人以为压缩就是在消息体上加一个 Gzip 包装，帧结构不变。但实际上一旦启用压缩，帧头中消息长度字段的值是**压缩后**的长度，而不是原始长度。这意味着 `MessageFramer` 必须在压缩完成后才能写帧头，`MessageDeframer` 也必须先读帧头中的压缩标志才能决定是否走解压路径。压缩不是"贴在消息体上的贴纸"，它改变了帧的处理方式。

### 误解二：服务器端可以任意选择压缩器

服务端在 `sendHeadersInternal()` 中选择了 compressor，但这不意味着它可以随便选。它必须检查客户端在 `Message-Accept-Encoding` 中声明了哪些编码，只能从中选择。如果客户端没有声明支持 `gzip`，服务端选了 `gzip`，那客户端收到响应后可能无法解压。grpc-java 在这里做了保护：如果服务端选择的 compressor 不在客户端的 `Accept-Encoding` 中，它会回退到 `Codec.Identity.NONE`。

### 误解三：解压后的消息大小不需要额外检查

解压后的消息可能比原始压缩消息大很多倍——攻击者可以构造一个极其"压缩比"高的消息来耗尽服务端内存。`MessageDeframer` 在 `getCompressedBody()` 中返回的 `InputStream` 外面包了一层 `SizeEnforcingInputStream`，逐字节计数，一旦超过 `maxInboundMessageSize` 就抛出 `RESOURCE_EXHAUSTED`。这不是可选的优化，而是安全防线。

## 十一、收网总结

回到开头的困惑：`setCompression("gzip")` 这行代码到底做了什么？

它触发了一条从 `Compressor` 接口到 `MessageFramer`、再到 `MessageDeframer`、再到 `Decompressor` 接口的完整路径。这条路径上涉及了 gRPC 的 wire format（5 字节帧头）、流式压缩包装器（`Compressor`/`Decompressor`）、sentinel 模式（`Codec.Identity.NONE`）、逐块交付策略（`BufferChainOutputStream`）和压缩协商协议（`Message-Encoding`/`Accept-Encoding`）。

grpc-java 的压缩不是"套一个 GzipOutputStream"那么简单。它是 wire format 帧层上的一个可选层，有完整的编码协商、帧头标志位、解压后大小保护等机制。`Codec.Identity.NONE` sentinel 不是过度设计，它反映了 grpc-java 在 hot path 上对性能的极致追求——用一次引用相等比较代替了 null check 和分支。

**三句话总结：**

1. gRPC 的 wire format 是 5 字节帧头（1 字节压缩标志 + 4 字节消息长度）加上消息体载荷，`MessageFramer` 和 `MessageDeframer` 分别负责写端和读端的帧处理。
2. `Compressor`/`Decompressor` 是对称的流包装器，`Codec` 合二为一，`Codec.Identity.NONE` 作为 sentinel 用引用相等代替 null check 来短路压缩路径。
3. 压缩协商通过 `Message-Encoding`/`Message-Accept-Encoding` header 完成，服务端只能从客户端声明的编码中选择，`DecompressorRegistry` 的不可变设计和 advertised 机制提供了灵活性与安全性的平衡。

**下篇预告：** 下一篇将进入协议语义卷（ch04），开始讲 gRPC 的四种调用模式与方法契约总图，从"实现怎么走通"上升到"规范要求什么"。