# 为什么 `sendMessage(request)` 不能直接把 Java 对象写到网络：grpc-java 的 Marshaller、ProtoUtils 与消息对象桥

> 本文基于 `grpc-java v1.83.1` 当前源码。前面的 codegen 篇已经说明 `*Grpc` 会把 request/response marshaller 写进 `MethodDescriptor`；客户端和服务端主线也已经说明，`ClientCall` / `ServerCall` 最终会把对象交给 stream。本文继续补上中间缺失的一层：一个 Java 对象到底怎样变成可传输的字节流，怎样被封装成 gRPC message frame，怎样经过压缩和长度校验，再怎样从对端输入恢复成应用对象。重点放在 `MethodDescriptor.Marshaller`、`ProtoUtils`、`ProtoLiteUtils`、`MessageFramer`、`MessageDeframer`；不把 protobuf 编译器内部、HTTP/2 frame 和 Netty connection handler 混进来。

## 为什么 `sendMessage(request)` 不能直接把 Java 对象写到网络

在前面的客户端主线里，我们已经看到过类似这样的动作：

- `ClientCall.sendMessage(request)`
- `ServerCall.sendMessage(response)`

从业务代码角度看，这很像是：

- 给框架一个 Java 对象
- 框架把它发出去

但“发出去”这三个字，实际上把中间一整层复杂机制擦掉了。

因为 transport 不可能直接理解：

- 这个对象是哪一个 Java 类
- 它应该使用 protobuf full 还是 protobuf lite
- 它怎样变成字节
- 一条 gRPC message 的边界在哪里
- 是否压缩
- 解压后允许多大
- 应用当前是否已经 request 了足够多的消息

如果这些问题都直接塞进 transport，前面已经建立的分层会立刻崩掉：

- transport 开始依赖 protobuf 类型
- HTTP/2 stream 开始理解业务对象
- client/server 不再共享统一 message 语义
- 自定义 marshaller 或非 protobuf binding 变得困难

所以 grpc-java 实际上把这段路拆成了几层：

- `MethodDescriptor.Marshaller` 负责对象和输入流之间的类型化转换
- `ProtoUtils` / `ProtoLiteUtils` 负责把 protobuf 接入这套统一接口
- `MessageFramer` 负责把输入流封装成 gRPC message frame
- transport 再负责把这些 frame 放进具体 stream
- `MessageDeframer` 从输入字节中拆出完整消息
- marshaller 最后把消息输入流还原成 Java 对象

如果先把最小总图压缩一下，它其实长这样：

```text
Java object
  -> MethodDescriptor.Marshaller
  -> InputStream
  -> MessageFramer
  -> gRPC message frame
  -> transport / HTTP2 stream
  -> MessageDeframer
  -> InputStream
  -> MethodDescriptor.Marshaller.parse()
  -> Java object
```

这条链最重要的地方，是它把三件经常被混在一起的事情拆开了：

- **对象转换**：Java 对象和字节流怎样互换
- **消息 framing**：字节流怎样变成一条有边界的 gRPC message
- **传输承载**：message frame 怎样进入 HTTP/2 / Netty stream

所以本文真正要回答的问题不是：

- grpc-java 怎样调用 protobuf 序列化
- grpc-java 怎样写一个 message

而是：

**为什么 grpc-java 必须把“对象、gRPC message frame、HTTP/2 stream”拆成三层，并且每一层都保留自己的失败、大小、压缩和回收边界。**

## 先看失败方案：为什么这段桥不能被一个类吞掉

### 失败方案一：`sendMessage()` 直接把 Java 对象交给 transport

这是最直观的方案：

- stream 收到对象
- transport 自己想办法把对象写出去

但这样会让 transport 立刻依赖上层对象类型。

它要知道：

- protobuf message 怎么序列化
- 自定义对象是否支持
- full/lite 应该选哪套 parser
- 失败时抛什么异常

更严重的是，一旦换成 JSON、自定义 IDL 或测试用的字符串 marshaller，transport 又要重新认识一套对象协议。

所以 grpc-java 把 transport 的输入收敛成更低层的形态：

- transport 不接 Java 对象
- 它接的是已经被 marshaller 变成的消息输入流和 frame

### 失败方案二：Marshaller 负责全部网络协议

如果不让 transport 负责，那是不是把所有事情都塞进 `Marshaller`？

也不行。

Marshaller 的职责是：

- `stream(T value)`：对象变成输入流
- `parse(InputStream stream)`：输入流变成对象

见 `api/src/main/java/io/grpc/MethodDescriptor.java:139`。

它并不应该负责：

- 5 字节 gRPC header
- compressed flag
- frame length
- flush
- endOfStream
- HTTP/2 stream
- request quota

如果把这些都塞进 marshaller，类型转换和网络协议就会重新耦合在一起。

所以 marshaller 是“对象边界”，不是“网络协议全集”。

### 失败方案三：MessageFramer 只是给 payload 前面加一个长度头

这看上去也很合理：

- 先序列化对象
- 前面加 5 个字节
- 交给 transport

但 `MessageFramer` 实际还要处理：

- compressed / uncompressed 标志
- 已知长度与未知长度
- `KnownLength` / `Drainable` 优化
- buffer allocator
- max outbound message size
- 多段 buffer
- flush 和 endOfStream
- stats / tracing
- close / dispose 时的 buffer 释放

所以 framing 不是简单的 prefix 操作，而是：

- **对象字节流进入 transport 之前的资源、性能和失败边界。**

### 失败方案四：Deframer 收到字节就一直解析，不需要 request quota

如果把输入端想成一个 while 循环，也会漏掉 gRPC 最关键的交互约束。

因为服务端/客户端应用并不是“对端来多少条就无限收多少条”，而是要通过：

- `request(numMessages)`

表达当前愿意接收多少消息。

Deframer 必须同时处理：

- header 是否收完整
- body 是否收完整
- 当前是否有 pending delivery quota
- 是否需要解压
- 单条消息是否超过限制
- stream 是否已经 close
- 是否存在 partial message

所以 `MessageDeframer` 不是一个一直读到 EOF 的工具，而是：

- **按消息额度推进的 framing 状态机。**

## 先立最小总图：对象、消息帧和 HTTP/2 stream 不是同一层

如果先不抠实现，最值得先记住的是这五层：

```text
应用对象
  -> Marshaller
  -> gRPC message frame
  -> ClientStream / ServerStream
  -> HTTP/2 stream / transport
```

回来的方向则是：

```text
HTTP/2 stream / transport
  -> ClientStream / ServerStream
  -> MessageDeframer
  -> Marshaller.parse()
  -> 应用对象
```

这张图里每一层回答的问题都不同。

### 第一层：应用对象

业务方法关心的是：

- request 对象
- response 对象

它不应该关心：

- 5 字节 framing header
- compressed flag
- buffer ownership

### 第二层：Marshaller

它关心的是：

- 对象怎样变成 `InputStream`
- `InputStream` 怎样恢复成对象

它不关心：

- message 的长度头
- 当前是否应该继续交付下一条
- HTTP/2 connection

### 第三层：gRPC message frame

它关心的是：

- 这一条 message 从哪里开始
- 有多长
- 是否压缩

### 第四层：ClientStream / ServerStream

它关心的是：

- message frame 如何进入某条 RPC stream
- 何时写出
- 何时 request 下一条
- 何时 close

### 第五层：HTTP/2 transport

它关心的是：

- stream id
- flow control
- frame
- connection
- flush

所以 gRPC message frame 与 HTTP/2 frame 根本不是一层对象。

如果把它们混成一层，后面所有 framing、压缩、流控和对象转换的边界都会变得模糊。

## 第一层：`MethodDescriptor.Marshaller` 为什么是对象与消息世界的类型化边界

`MethodDescriptor` 的类注释已经把它的位置说得很清楚：

- 它描述一个远程方法
- 提供方法名称
- 还提供解析和序列化 request/response message 的 `Marshaller`

见 `api/src/main/java/io/grpc/MethodDescriptor.java:29`。

这说明 marshaller 不是某个 protobuf 工具类私有的细节，而是 grpc-java 对“消息对象怎样进入 runtime”这件事抽象出来的统一接口。

### `Marshaller` 只有两个动作，但边界非常硬

接口本身很小：

- `stream(T value)`
- `parse(InputStream stream)`

见 `api/src/main/java/io/grpc/MethodDescriptor.java:130`、`:139`。

`stream(T value)` 的语义是：

- 给定一个对象
- 产生一个可以被写到 wire 的输入流

`parse(InputStream stream)` 的语义则是：

- 给定一段序列化消息输入流
- 还原成应用侧对象

见 `api/src/main/java/io/grpc/MethodDescriptor.java:148`、`:157`。

这两个动作看起来很小，但它们把对象世界和传输世界之间的边界钉死了。

上游可以是：

- protobuf
- protobuf lite
- 自定义字符串
- JSON
- 其他 IDL

只要能提供 `Marshaller`，下游 framing 和 transport 就不需要知道对象原本是什么类型。

### 为什么 `MethodDescriptor` 同时持有 request 和 response 两个 marshaller

一个 RPC 方法天然有两个方向：

- request
- response

所以 `MethodDescriptor` 里会分别保存：

- `requestMarshaller`
- `responseMarshaller`

见 `api/src/main/java/io/grpc/MethodDescriptor.java:40`、`:45`。

而它对外暴露的便利方法也严格区分：

- `streamRequest()` / `parseRequest()`
- `streamResponse()` / `parseResponse()`

见：

- `api/src/main/java/io/grpc/MethodDescriptor.java:283`
- `api/src/main/java/io/grpc/MethodDescriptor.java:295`
- `api/src/main/java/io/grpc/MethodDescriptor.java:306`
- `api/src/main/java/io/grpc/MethodDescriptor.java:318`

这说明 framing 层拿到的不是“一个万能序列化器”，而是明确知道：

- 当前是在编码 request
- 还是在编码 response
- 当前是在解析 request
- 还是在解析 response

这也是为什么前一篇 codegen 生成的 `MethodDescriptor` 是整个消息对象桥的地基。

### `KnownLength` 和 `Drainable` 说明“性能能力来自流，利用发生在 Framer”

`Marshaller.stream()` 的注释里还特别提到：

- 如果可能，返回的 stream 应实现 `KnownLength`，以改善 transport 效率

见 `api/src/main/java/io/grpc/MethodDescriptor.java:139`。

而 `MessageFramer` 在真正写 payload 时，又会显式检查传入的 `InputStream` 是否实现了 `Drainable`，见 `core/src/main/java/io/grpc/internal/MessageFramer.java:273`。

这里要把职责拆得更锋利一点。

真正发生的不是：

- Marshaller 自己负责 `KnownLength` 和 `Drainable`

而是：

- Marshaller 负责返回一条消息输入流
- 这条输入流**如果恰好具备** `KnownLength`、`Drainable` 这类性能能力，就会被 Framer 识别并利用

也就是说，性能能力是“流对象可能携带的特征”，而不是 Marshaller 额外承担的第二套协议职责。

所以更精确的说法应该是：

- Marshaller 负责对象 -> `InputStream`
- Framer 负责根据 `InputStream` 是否具备 `KnownLength` / `Drainable` 特征，决定怎样更高效地产生 frame

这也是为什么这里属于性能协作，而不是职责越界：

- Marshaller 仍然只负责提供可读消息流
- Framer 才是识别和利用这些能力的那一层

## 第二层：`ProtoUtils` / `ProtoLiteUtils` 怎样把 protobuf 接入统一 Marshaller

前一篇已经看到，`*Grpc` 生成骨架会把：

- `ProtoUtils.marshaller(...)`
- `ProtoLiteUtils.marshaller(...)`

写入 `MethodDescriptor`。

现在回到实现看，这两者真正做的是：

- 把 protobuf 的 message/parser API 适配到 grpc-java 的 `MethodDescriptor.Marshaller`

### `ProtoUtils` 是 full protobuf 的公共适配入口

`ProtoUtils` 的类注释非常直接：

- 它提供 protobuf with grpc 的工具方法

见 `protobuf/src/main/java/io/grpc/protobuf/ProtoUtils.java:25`。

其中最关键的是：

- `marshaller(defaultInstance)`
- `marshallerWithRecursionLimit(...)`
- `keyForProto(...)`
- `metadataMarshaller(...)`

见 `protobuf/src/main/java/io/grpc/protobuf/ProtoUtils.java:45`、`:54`。

这说明 `ProtoUtils` 不只是“调用 protobuf serialize”的薄包装，它还负责把 protobuf 类型接进：

- RPC message marshaller
- Metadata binary marshaller

两个不同的消息边界。

### `ProtoLiteUtils` 真正承载 MessageLite 到 InputStream 的转换

`ProtoLiteUtils` 则是更底层的实现桥。

它的 `marshaller(defaultInstance)` 会创建一个 `MessageMarshaller`，见 `protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:80`、`:85`。

`MessageMarshaller.stream(...)` 会把 protobuf lite message 包装成 `ProtoInputStream`，而 `parse(...)` 则从输入流中恢复对象，见：

- `protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:133`
- `protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:162`
- `protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:167`

所以从对象桥角度看，完整链路是：

```text
protobuf MessageLite
  -> ProtoLiteUtils.MessageMarshaller
  -> InputStream
  -> MessageFramer
```

以及反向：

```text
MessageDeframer output InputStream
  -> ProtoLiteUtils.MessageMarshaller.parse()
  -> protobuf MessageLite
```

### 为什么 `ProtoInputStream` 的优化值得单独注意

`ProtoLiteUtils.MessageMarshaller.parse(...)` 里有一条很有意思的优化：

- 如果传入的 stream 本身是同一个 parser 产生的 `ProtoInputStream`
- 且消息对象仍然可直接取出
- 就可以直接返回原 protobuf 对象

见 `protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:167`。

这意味着在某些 in-process 或内存路径里，gRPC 可能不需要重新把对象完整 parse 一遍。

但这不是所有 transport 都有的通用保证，而是建立在：

- stream 类型匹配
- parser 匹配
- protobuf message 不可变

这些条件之上。

所以这条优化很值得讲，但必须标成当前实现的性能路径，不能外推成“所有 gRPC 消息都零拷贝”。

### 为什么 full/lite 的差异已经落在对象桥层

full protobuf 与 lite protobuf 表面上只是两个工具类：

- `ProtoUtils`
- `ProtoLiteUtils`

但它们背后对应的是不同的 protobuf message API：

- full：`Message`
- lite：`MessageLite`

这意味着同一份 `.proto` 契约，进入 grpc-java 后，Marshaller 的对象桥实现就可能不同。

所以 lite/full 差异不是 transport 最后才临时适配的，而是：

- 从 `MethodDescriptor` 生成 marshaller 的时候就已经确定

## 第三层：`MessageFramer` 为什么不是简单长度头，而是 gRPC message 的出站状态机

`MessageFramer` 的类注释已经把职责说清楚：

- 它把 gRPC messages 编码成 transport 层可以交付的内容

见 `core/src/main/java/io/grpc/internal/MessageFramer.java:41`。

它与 transport 的连接点是 `Sink`：

- transport 实现 `deliverFrame(...)`
- framer 把 frame、endOfStream、flush、消息数交给 transport

见 `core/src/main/java/io/grpc/internal/MessageFramer.java:53`。

这说明 framer 处在非常准确的一层：

- 上游接收的是对象已经被 marshaller 转好的输入流
- 下游交给的是 transport 可承载的 frame

### 5 字节 header 到底表达了什么

`MessageFramer` 定义了：

- `HEADER_LENGTH = 5`
- `UNCOMPRESSED = 0`
- `COMPRESSED = 1`

见 `core/src/main/java/io/grpc/internal/MessageFramer.java:70`。

在已知长度的未压缩路径里，它会把：

- 压缩标志
- message length

写进这 5 个字节，再把 payload 写到 buffer，见 `core/src/main/java/io/grpc/internal/MessageFramer.java:216`。

所以 gRPC message frame 不是：

- 一段没有边界的 payload

而是：

```text
1 byte compression flag
4 bytes message length
N bytes message payload
```

这也是 gRPC message frame 与 HTTP/2 DATA frame 必须分开的根本原因：

- HTTP/2 DATA frame 负责 HTTP/2 层承载
- gRPC 5 字节 header 负责 RPC message 层边界

### 压缩路径为什么必须在 framer 里处理

`MessageFramer.writePayload(...)` 会根据：

- `messageCompression`
- 当前 `Compressor`

决定当前消息是否压缩，见 `core/src/main/java/io/grpc/internal/MessageFramer.java:133`、`:139`。

如果压缩，它会：

- 创建压缩输出流
- 把输入流写进去
- 关闭压缩流确保尾部数据落下
- 再把压缩后的 buffer chain 交付给 sink

见 `core/src/main/java/io/grpc/internal/MessageFramer.java:184`。

这说明压缩不是 marshaller 的职责。

- marshaller 负责对象 -> 原始消息流
- framer 负责“这一条 gRPC message 是否压缩，以及压缩后怎样进 frame”

### KnownLength / Drainable / buffer allocator 为什么都在 framer 里

如果消息长度已知，framer 可以：

- 先分配 header + payload 所需空间
- 直接写 5 字节 header
- 再把输入流写入 buffer

如果消息长度未知，就需要先写入 `BufferChainOutputStream`，再计算长度和组织 buffer chain。

见：

- `core/src/main/java/io/grpc/internal/MessageFramer.java:173`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:237`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:273`

这说明 framer 同时承担：

- 长度发现
- buffer allocation
- 多 buffer 组织
- frame header 写入
- sink 交付

而 `Drainable` 则允许某些输入流直接 drain 到输出流，减少不必要的拷贝。

这正是方法论里要求单独区分的“缓冲域”和“传输域”：

- framer 处理消息缓冲与 framing
- transport sink 处理连接/stream 承载

### max outbound size、flush、close / dispose 为什么也是 framer 主线

`MessageFramer` 还会在已知长度和压缩路径检查 max outbound message size；超限会转成 `RESOURCE_EXHAUSTED`，见 `core/src/main/java/io/grpc/internal/MessageFramer.java:216`、`:194`。

它还区分：

- `flush()`：把当前缓冲交给 sink，但不结束 stream
- `close()`：flush、标记 endOfStream、释放资源
- `dispose()`：释放 buffer，但不 flush

见：

- `core/src/main/java/io/grpc/internal/MessageFramer.java:304`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:323`
- `core/src/main/java/io/grpc/internal/MessageFramer.java:340`

这说明 framing 不是“把 bytes 交出去”这么简单，它还有自己的资源生命周期协议。

## 第四层：`MessageDeframer` 为什么是按需交付的输入状态机

出站 framer 解决的是：

- 对象怎样变成带边界的 gRPC message frame

入站 deframer 解决的则是：

- 输入字节怎样被拆回一条条消息
- 什么时候允许把消息交给应用

`MessageDeframer` 的类注释直接说明：

- 它是 gRPC frame 的 deframer
- 非线程安全
- 公共方法默认应在 deframing thread 调用

见 `core/src/main/java/io/grpc/internal/MessageDeframer.java:36`。

这说明它不仅是“解析工具”，还带着明确的线程与状态边界。

### HEADER / BODY 两态说明一条 message 不是一块输入就能完成

`MessageDeframer` 内部有两个状态：

- `HEADER`
- `BODY`

并且固定同样的 5 字节 header，见 `core/src/main/java/io/grpc/internal/MessageDeframer.java:43`、`:85`。

这意味着输入数据可能被拆成任意片段：

- header 还没收全
- header 收全了但 body 未收全
- body 收全后才形成完整 message

所以 deframer 必须保存：

- 当前 state
- requiredLength
- compressedFlag
- nextFrame
- unprocessed buffer

这也是为什么不能把它简化成一次 `parse(byte[])`。

### request quota 为什么决定消息何时进入应用

`MessageDeframer.request(numMessages)` 会增加 pending deliveries，然后触发 deliver，见 `core/src/main/java/io/grpc/internal/MessageDeframer.java:156`。

而 `deliver()` 只有在：

- `pendingDeliveries > 0`
- 当前消息数据足够
- `stopDelivery` 没有开启

时才会继续处理并交付消息，见 `core/src/main/java/io/grpc/internal/MessageDeframer.java:257`。

这说明 inbound flow control 和 message deframing 在这里发生了直接连接：

- transport 可以已经收到了更多字节
- 但应用没有 request 足够消息时，deframer 不会无限制地把对象交上去

所以 `request(1)` 不是“通知一下”，而是控制消息交付额度的运行时动作。

### 解压、大小限制和解析失败怎样进入 deframer 主线

`MessageDeframer` 同时持有：

- per-message `Decompressor`
- full-stream decompressor
- max inbound message size

见 `core/src/main/java/io/grpc/internal/MessageDeframer.java:89`、`:110`。

当 header 表示 compressed message 时，deframer 要使用对应 decompressor；如果消息超过 max inbound size，也不会直接放行给业务代码。

但这里也要把跨层边界讲清楚：

- **message frame 是否完整、header/body 是否成立、当前是否还能继续交付**，这是 deframer 的职责
- **解压后的消息流在被真正读取时是否超限、protobuf 字节是否能成功 parse 成对象**，则会继续跨到更后的输入流封装层和 marshaller 解析层

也就是说，入站失败并不是全部都在 deframer 一层收完，而是分层推进：

```text
transport bytes
  -> deframer header/body
  -> optional decompression
  -> size enforcing input stream / message InputStream
  -> MethodDescriptor.Marshaller.parse()
  -> application object
```

更准确地说：

- deframer 先保证“这是不是一条成立的 gRPC message”
- size enforcing input stream 再保证“这条消息在被消费时有没有越界”
- marshaller 最后回答“这条成立且未越界的消息，能不能恢复成对象”

所以 marshaller 只从最后一段开始负责对象恢复；前面的 frame、压缩、长度和交付额度主要属于 deframer，而大小约束与最终 parse 失败则是 deframer 与输入流封装、marshaller 共同完成的跨层收口。

### partial message、close、stopDelivery 为什么是失败/回收路径

`MessageDeframer.close()` 会判断是否存在 partial message，并关闭：

- full stream decompressor
- unprocessed buffer
- nextFrame

最后通知 listener `deframerClosed(hasPartialMessage)`，见 `core/src/main/java/io/grpc/internal/MessageDeframer.java:212`。

`stopDelivery()` 则允许其他线程先设置停止标记，但随后必须回到 deframing thread 调用 close，否则 deframer 可能一直等待更多消息，见 `core/src/main/java/io/grpc/internal/MessageDeframer.java:198`。

这几条路径说明：

- deframer 的 close 不是普通对象销毁
- 它必须区分正常结束、partial message、停止交付和资源释放

### 测试怎样证明 deframer 是状态机而不是读取循环

`MessageDeframerTest` 覆盖了基本 deframing、压缩、size enforcing 等路径，见：

- `core/src/test/java/io/grpc/internal/MessageDeframerTest.java:70`
- `core/src/test/java/io/grpc/internal/MessageDeframerTest.java:301`
- `core/src/test/java/io/grpc/internal/MessageDeframerTest.java:345`

transport fixture 又把 client/server stream 的对象收发真正串起来：

- client message 写出后在对端解析，见 `core/src/testFixtures/java/io/grpc/internal/AbstractTransportTest.java:866`
- server response 写出后在对端解析，见 `core/src/testFixtures/java/io/grpc/internal/AbstractTransportTest.java:912`
- 大消息、大小边界与同一 stream 多消息路径，见 `core/src/testFixtures/java/io/grpc/internal/AbstractTransportTest.java:1382`、`:1573`

所以第四层可以先收一句：

- `MessageDeframer` 是带有 framing 状态、交付额度、解压、大小限制和回收语义的输入状态机

## 第五层：失败路径为什么必须把对象桥、framing 和 transport 分开收口

现在可以把失败路径重新摆回整条桥上。

### marshaller 失败

如果对象无法正确 `stream()`，或者输入流最终无法 `parse()` 成对象，失败首先应该被理解为：

- 对象桥失败

而不是：

- transport 连接断开
- HTTP/2 stream 错误

但这里也要把出站和入站分开。

- **出站 marshaller 失败**：通常发生在 `ClientCallImpl` / `ServerCallImpl` 已经决定发送某个对象之后、`MethodDescriptor.streamRequest()` / `streamResponse()` 被真正调用时，它会继续沿 framer 写入链向上抛，并被包装成 gRPC status 或内部错误路径。
- **入站 marshaller 失败**：通常发生在 deframer 已经产出一条“形式上成立”的消息输入流之后，最终由 `parseRequest()` / `parseResponse()` 在对象恢复这一步失败，再沿 listener / call 上层收口。

这类失败不该被伪装成 transport 错误，否则排障时会丢掉最关键的类型/序列化原因。

### framer 失败

如果：

- 消息长度不准确
- 压缩过程失败
- outbound message 超过限制
- buffer 写入失败

framer 应该把它收束成明确的 gRPC status，而不是继续把半截 frame 交给 transport。

`MessageFramer.writePayload()` 对 IOException、RuntimeException 和 message length mismatch 都有明确包装路径，见 `core/src/main/java/io/grpc/internal/MessageFramer.java:133`。

这说明出站失败的顺序更准确地是：

```text
object -> marshaller.stream() -> framer -> transport sink
```

其中：

- 对象转流失败归对象桥
- frame 组织失败归 framer
- 只有已经成立的 frame 才应该继续进入 transport

### deframer 失败

如果：

- header 非法
- compressed flag 不可用
- body 不完整
- 当前没有足够 request quota

这些首先是 deframer 层问题。

而如果：

- 解压后的消息在消费时超过 size limit
- protobuf 字节无法成功 parse 成对象

这又是 deframer 继续向后的输入流封装层、marshaller 解析层问题。

所以更精确的失败链应该写成：

- deframer 负责“消息 frame 是否成立、何时允许交付”
- size enforcing input stream 负责“交付过程中有没有越界”
- marshaller 负责“这条消息字节能否恢复成对象”

只有把这三层区分开，入站失败路径才算真正闭环，而不会把所有异常都笼统扔给 deframer。

### 资源回收

这条对象桥还必须回答资源所有权问题：

- marshaller 返回的 InputStream 谁关闭
- framer 的 WritableBuffer 谁释放
- deframer 的 CompositeReadableBuffer 谁关闭
- close 与 dispose 的区别是什么
- partial message 在异常时如何收口

`MethodDescriptor.streamRequest()` 的注释明确说返回的 InputStream 应由调用方关闭，见 `api/src/main/java/io/grpc/MethodDescriptor.java:287`。

`MessageFramer.close()` 与 `dispose()` 又明确区分 flush+close 和不 flush 的释放路径，见 `core/src/main/java/io/grpc/internal/MessageFramer.java:323`、`:340`。

这正是方法论里强调的资源所有权协议：

- 不能只讲“对象序列化成功了”
- 还必须讲清楚失败和回收时谁负责收尾

## 最后把整条消息对象桥收回来

现在可以把整篇文章的主线收回来了。

如果只记一句最短的人话答案，那就是：

**grpc-java 没有让 Java 对象直接碰 transport，而是把对象转换、gRPC message framing、HTTP/2 承载、入站 deframing 和对象恢复拆成多层桥：Marshaller 负责类型化对象流，Framer 负责 5 字节消息边界与出站资源，Deframer 负责按需拆帧、解压、限流和失败收口，transport 只承载已经成立的 message frame。**

把它拆开，就是四层稳定职责。

### 第一层：Marshaller 负责对象与 InputStream

- request/response 对象进入输入流
- 输入流恢复成应用对象
- 不负责 gRPC frame，也不负责 HTTP/2

### 第二层：ProtoUtils / ProtoLiteUtils 负责 protobuf 适配

- full protobuf 使用 `Message`
- lite protobuf 使用 `MessageLite`
- 生成骨架从这里拿到具体 marshaller

### 第三层：MessageFramer / MessageDeframer 负责 gRPC message frame

- 5 字节 header
- compressed flag
- message length
- buffer / flush / close / dispose
- request quota / size enforcement / partial message

### 第四层：transport 负责 HTTP/2 stream 承载

- 负责连接、stream、flow control 和实际 wire 传输
- 不负责 Java 对象类型，也不负责 protobuf parser

## 这篇先立住的，不是 protobuf API，而是对象桥的分层协议

到这里为止，这篇文章故意没有展开：

- protobuf compiler 如何生成 Java message class
- JSON/custom IDL 的完整 marshaller 实现
- HTTP/2 DATA frame 与 Netty channel pipeline
- compressor/decompressor registry 的完整配置专题
- InProcess transport 的所有零拷贝优化

不是这些不重要，而是如果不先把 **对象 -> message frame -> transport -> message object** 这座桥立住，前面的 codegen、客户端、服务端和 builder 文章之间就仍然缺一层真正的消息落地语义。

所以这篇真正要留下来的心智模型只有一条：

```text
对象转换不是 framing
framing 不是 HTTP/2 transport
HTTP/2 transport 也不是对象解析
```

只要这条边界立住，后面再去看 compression、InProcess、metadata binary marshaller 或生产中的消息超限问题，读者就有了一张不会混层的消息对象总图。

而这，也正是 grpc-java 完整卷里必须补上的一层机制地基。