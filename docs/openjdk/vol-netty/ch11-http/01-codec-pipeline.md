# HTTP 编解码管道：HTTP 不是一个 ByteBuf，而是一串有顺序的对象

> 本文基于当前 Netty `HttpObjectDecoder`、`HttpServerCodec`、`HttpClientCodec` 与 HTTP 消息模型实现。前置：Ch10 Codec 两篇、Ch7 Pipeline、Ch4 ByteBuf；本文聚焦 HTTP 字节流如何变成 `HttpMessage + HttpContent + LastHttpContent`，以及 server/client 为什么用双工组合 codec 和方法队列补上 HEAD/CONNECT 语义。不展开 `HttpObjectAggregator` 和 `HttpContentCompressor` 的具体实现，它们放在下一篇。

## TCP frame 已经切出来了，为什么 HTTP 还不能直接交给业务 handler

上一章讲完四种拆包器时，问题已经从“TCP 半包怎么办”推进到了“协议边界在哪里”。定长协议、分隔符协议、长度字段协议，各自都能在父类骨架上切出一帧。

HTTP 看起来也可以照这个思路处理：

```text
读到一行请求行
读到一组 headers
读到 body
拼成一个 request
交给业务 handler
```

可真正运行时，这个模型很快就会遇到一个问题：HTTP 的“消息”并不是网络上一次性到达的一个对象。

一次请求可能先到：

```text
GET /upload HTTP/1.1

Host: example.com
Content-Length: 1048576


前 8KB body
```

下一次 read 才到后面的 body；如果是 chunked transfer encoding，网络上甚至还会夹着 chunk size、chunk data、chunk delimiter 和 trailing headers。

所以 HTTP codec 不能只回答“这一帧多长”。它还要把一条连续字节流翻译成一串有严格顺序的 HTTP 对象：

```text
HttpRequest
  -> HttpContent
  -> HttpContent
  -> LastHttpContent
```

没有 body 时，序列可能缩短成：

```text
HttpRequest
  -> EMPTY_LAST_CONTENT
```

响应方向同样如此：

```text
HttpResponse
  -> HttpContent...
  -> LastHttpContent
```

这就是本篇的核心问题：

```text
HTTP decoder 为什么不直接产出一个完整 request/response？
为什么要把头和 body 拆成多个对象？
server 为什么能用一个 HttpServerCodec 同时处理读 request 和写 response？
client 又怎么知道当前响应对应的是哪个请求，尤其是 HEAD 和 CONNECT？
```

先把本篇的答案压成一句话：

```text
HttpObjectDecoder 负责沿 HTTP 状态机解析字节，
把消息头、内容分块和结束标记分别产出；
HttpServerCodec / HttpClientCodec 再把入站 decoder 与出站 encoder 组合起来，
并额外保存 HTTP 方法上下文，修正单靠响应本身无法判断的语义。
```

HTTP codec 的复杂度，主要不在“把一行字符串切开”，而在于：

- 字节流的状态要跨多次 `channelRead()` 保存。
- body 可能需要流式交给下游，不能默认一次性聚合。
- 某些响应是否有 body，必须参考此前发出的请求方法。
- HTTP 升级后，后续字节不再是 HTTP，codec 必须让出解析权。

## 一、三个看似简单的方案，为什么都不够

### 1. 失败方案一：等整个 HTTP 请求收齐，再一次性解析

最直觉的实现是：decoder 一直缓存，直到看到完整 headers 和完整 body，再创建一个 `FullHttpRequest`。

对一个几百字节的 GET 请求，这似乎很方便。可 HTTP body 的大小并没有这样的保证。上传文件、JSON 请求、响应下载，都可能远大于一次合理的内存缓存。

如果 decoder 默认等完整 body：

- 一个慢速上传连接会长期占着累积 buffer。
- 多个并发连接会把内存压力叠加起来。
- 业务无法在 body 到达过程中做流式处理或背压。
- 一个恶意客户端只要声明很大的长度，就能让 decoder 提前承担巨大缓存责任。

所以“完整消息”不能成为 decoder 唯一的输出形态。HTTP codec 必须允许：

```text
先把 request line + headers 交给下游，
body 到一块就交一块，
最后再用一个明确的结束对象收口。
```

### 2. 失败方案二：把整个输入转成字符串，按空行和长度切分

HTTP 头部是文本，这很容易诱导实现者把整段 `ByteBuf` 转成字符串，然后寻找 `\r\n\r\n`。

这会掩盖几个重要事实：

- 当前 read 可能只包含半行，不能把“暂时没读到空行”当成 malformed。
- body 是字节，不应该先经过字符集转换。
- chunked body 的 size 行、数据、CRLF 和 trailer 是不同状态，不是一次 `split()` 可以表达的平面文本。
- 字节流仍然需要 readerIndex 精确推进和引用计数转移。

当前 `HttpObjectDecoder` 继承 `ByteToMessageDecoder`，本质上仍复用 Ch10 的 cumulation 和循环机制；它只是在此基础上增加 HTTP 自己的状态机，而不是把 TCP 字节流改造成字符串流。

### 3. 失败方案三：server/client 共用一个普通 HTTP decoder，看到响应再猜它是不是 HEAD 或 CONNECT

普通响应 decoder 只看到：

```text
HTTP/1.1 200 OK
Content-Length: 100

```

可如果这条响应对应的是 HEAD 请求，那么它没有 body，`Content-Length: 100` 只是描述对应 GET 响应的长度，不能据此真的读取 100 个字节。

CONNECT 也一样。成功的 `200` 响应之后，连接可能从 HTTP 控制流切换成隧道字节流。继续把后面的字节按 HTTP headers 和 chunks 解析，反而会破坏升级后的协议。

因此，响应 decoder 单独看是不够的。它需要知道此前发送的请求方法，或者由外层 codec 把这段上下文补给它。

这就引出 HTTP codec 的两个组合方向：

```text
server：请求 decoder + 响应 encoder
client：响应 decoder + 请求 encoder
```

这不是为了代码复用好看，而是因为 HTTP 两端的入站和出站语义本来就不同。

## 二、HTTP 对象总图：Message 是头，Content 是体，Last 是边界

先不急着看 `HttpObjectDecoder` 的大状态机。要理解它为什么输出多个对象，必须先建立 HTTP 对象模型。

当前 Netty 的层次可以写成：

```text
HttpObject
├── HttpMessage
│   ├── HttpRequest
│   └── HttpResponse
└── HttpContent
    └── LastHttpContent

FullHttpMessage
├── FullHttpRequest = HttpRequest + LastHttpContent + content
└── FullHttpResponse = HttpResponse + LastHttpContent + content
```

这张图的重点不是接口继承关系本身，而是它把一条 HTTP 消息拆成了两个维度：

- 语义头：版本、请求方法、URI、状态码、headers。
- 内容流：一块块 body，以及最后一块的 trailing headers。

### 1. `HttpMessage` 负责“这是什么消息”，不负责携带完整 body

`HttpMessage` 当前定义了协议版本和 headers，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpMessage.java:27`。

请求和响应分别在它上面增加自己的语义：

- `HttpRequest` 增加 `method()` 和 `uri()`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpRequest.java:38`。
- `HttpResponse` 增加 `status()`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpResponse.java:35`。

所以一个刚从请求行和 headers 解析出来的对象，表达的是：

```text
这是一个什么版本的请求/响应？
它的 method、uri 或 status 是什么？
它声明了哪些 headers？
```

它还不必承诺 body 已经全部在内存里。

### 2. `HttpContent` 是 body 的一个分块，不是另一条独立 HTTP 请求

`HttpContent` 同时继承 `HttpObject` 和 `ByteBufHolder`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContent.java:22`。

这意味着它的角色是：

```text
沿着 pipeline 继续传播一个 body chunk，
并让这个 chunk 保留自己的 ByteBuf 生命周期。
```

它不是一个没有上下文的裸 `ByteBuf`。上游先发 `HttpRequest` 或 `HttpResponse`，后续的 `HttpContent` 就属于这条消息的 body。

一个 chunked 请求的对象序列可以写成：

```text
HttpRequest(method=POST, uri=/upload, headers=...)
HttpContent(content=chunk-1)
HttpContent(content=chunk-2)
LastHttpContent(content=chunk-3, trailingHeaders=...)
```

业务 handler 如果关心流式处理，就可以在收到每个 `HttpContent` 时处理一部分数据，而不必等整条 body。

### 3. `LastHttpContent` 的职责不是“最后一块一定非空”，而是明确宣布 body 结束

`LastHttpContent` 扩展 `HttpContent`，并增加 `trailingHeaders()`，见 `codec-http/src/main/java/io/netty/handler/codec/http/LastHttpContent.java:25`。

它承担两个语义：

- 这是 body 的最后一个内容分块。
- 如果使用 chunked encoding，后面可能已经解析出了 trailing headers。

因此“最后”是边界信息，不等于“这一块一定有数据”。

当前还有一个 `EMPTY_LAST_CONTENT` 单例，content 是 `Unpooled.EMPTY_BUFFER`，trailing headers 是空 headers，见 `codec-http/src/main/java/io/netty/handler/codec/http/LastHttpContent.java:30`。

这让无 body 消息可以用：

```text
HttpRequest
  -> EMPTY_LAST_CONTENT
```

来表达“headers 已完成，body 为空，消息在这里结束”，而不必每次都新建一个空的 `LastHttpContent` 对象。

所以完整性问题 #8 的关键答案是：

```text
HttpRequest 是消息头和请求语义；
HttpContent 是这条消息的 body 分块；
LastHttpContent 是 body 结束标记和 trailing headers 的承载者。
```

### 4. `FullHttpMessage` 是聚合后的复合视图，不是 HTTP decoder 的必然输出

`FullHttpMessage` 同时继承 `HttpMessage` 和 `LastHttpContent`，见 `codec-http/src/main/java/io/netty/handler/codec/http/FullHttpMessage.java:20`。

对应地：

- `FullHttpRequest = HttpRequest + FullHttpMessage`，见 `codec-http/src/main/java/io/netty/handler/codec/http/FullHttpRequest.java:20`。
- `FullHttpResponse = HttpResponse + FullHttpMessage`，见 `codec-http/src/main/java/io/netty/handler/codec/http/FullHttpResponse.java:20`。

它们把 headers、语义字段、完整 body 和 trailing headers 放进一个对象，适合业务 handler 直接调用 `request.content()` 或 `response.content()`。

但要注意：`HttpObjectDecoder` 默认输出的是分块对象序列；`FullHttpRequest` / `FullHttpResponse` 通常是后续聚合器把这串对象重新组织后的结果。

因此这两种模型分别服务不同目标：

```text
分块模型：低内存、可流式、业务自己处理 body 生命周期
完整模型：业务简单、直接拿完整 content，但需要承担聚合内存成本
```

下一篇会专门讲聚合器如何在这两者之间切换。本文先记住对象层次，不把 `FullHttpMessage` 错当成 decoder 的唯一出口。

## 三、`HttpObjectDecoder`：HTTP 解析的核心是一台跨 read 保存状态的机器

对象模型立起来之后，再看 `HttpObjectDecoder` 就不容易迷路了。

当前类继承 `ByteToMessageDecoder`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:148`。它没有绕开 Ch10 的积攒机制，而是在父类驱动下，每次根据 `currentState` 消费当前已有字节。

它的状态包括：

```text
SKIP_INITIAL_LINE_CHARS
READ_INITIAL
READ_HEADER
READ_VARIABLE_LENGTH_CONTENT
READ_FIXED_LENGTH_CONTENT
READ_CHUNK_SIZE
READ_CHUNKED_CONTENT
READ_CHUNK_DELIMITER
READ_CHUNK_FOOTER
BAD_MESSAGE
UPGRADED
```

定义见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:226`。

这张状态图可以先简化成三段：

```text
请求/响应头
  -> READ_INITIAL -> READ_HEADER

body
  -> 无 body：直接 LastHttpContent
  -> 固定长度：READ_FIXED_LENGTH_CONTENT
  -> 连接结束决定长度：READ_VARIABLE_LENGTH_CONTENT
  -> chunked：READ_CHUNK_SIZE -> READ_CHUNKED_CONTENT
                         -> READ_CHUNK_DELIMITER -> ...
                         -> READ_CHUNK_FOOTER

协议升级
  -> UPGRADED：剩余字节不再按 HTTP 解析
```

这里先记住主线即可：HTTP decoder 不是“找一次分隔符然后返回一个对象”，而是每产出一个对象，就把状态推进到下一种等待条件。

### 1. 第一阶段：请求行或响应行先变成 `HttpMessage`

`HttpObjectDecoder.decode(...)` 进入 `READ_INITIAL` 后，会让 line parser 尝试读取初始行。如果当前 `cumulation` 里的字节还不够一整行，parser 返回空，decoder 直接等下一次调用。

如果读到了完整初始行：

- request decoder 通过 `createMessage(...)` 创建 `DefaultHttpRequest`
- response decoder 通过 `createMessage(...)` 创建 `DefaultHttpResponse`
- 状态切换为 `READ_HEADER`

`HttpRequestDecoder.createMessage(...)` 见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpRequestDecoder.java:217`；`HttpResponseDecoder.createMessage(...)` 见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpResponseDecoder.java:211`。

两者共享父类的行和 header 解析流程，但在“第一行代表什么”上分开：

```text
request：method uri version
response：version status reason
```

这正是 HTTP server/client codec 后面可以复用同一个 `HttpObjectDecoder` 骨架的原因：公共部分是行、header、body 状态机，差异点通过 `createMessage()` 和 `isDecodingRequest()` 这类扩展点落下去。

### 2. 第二阶段：headers 决定 body 走哪条路

读完 headers 后，`readHeaders(buffer)` 返回下一状态，`decode(...)` 再根据结果走不同分支，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:395`。

最重要的分支有四类。

#### 无 body

如果当前消息不期待 body，decoder 会：

```text
addCurrentMessage(out)
out.add(LastHttpContent.EMPTY_LAST_CONTENT)
resetNow()
```

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:402`。

这正好把前面的对象模型落成运行时序列：先产出 request/response，再用空的 last content 收口。

#### chunked body

如果 headers 表示 chunked，decoder 先产出当前 `HttpMessage`，然后把状态切到 `READ_CHUNK_SIZE`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:409`。

它不会把 chunk size 行交给业务 handler。size 行只是传输层控制信息；真正向下游输出的是 `HttpContent`。

#### 固定长度 body

如果 `Content-Length` 给出了长度，decoder 先产出 `HttpMessage`，把剩余长度放进 `chunkSize`，然后切到 `READ_FIXED_LENGTH_CONTENT`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:430`。

后续每轮最多读取 `maxChunkSize`，因此即使 `Content-Length` 很大，decoder 也会把 body 拆成多个 `HttpContent`，最后一个变成 `DefaultLastHttpContent`。

#### 响应直到连接关闭

HTTP response 在没有 `Content-Length` 或 chunked 编码时，body 长度可能由连接关闭决定。源码注释明确区分了 request 和 response：request 没有这两个 header 时 body 长度是 0，而 response 可能把连接关闭前收到的字节视为 body，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:418`。

这也是为什么 HTTP decoder 必须有 `READ_VARIABLE_LENGTH_CONTENT` 和 `decodeLast(...)` 的收尾逻辑：连接关闭本身可能就是这条响应 body 的结束边界。

### 3. 第三阶段：固定长度和 chunked body 如何产出 `HttpContent`

在 `READ_FIXED_LENGTH_CONTENT` 中，decoder 每次先看当前 buffer 是否可读，再决定这次取多少字节，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:456`。

取值受三个条件约束：

- 当前 buffer 有多少可读字节
- `maxChunkSize` 上限
- 当前消息还剩多少 `chunkSize`

如果这一轮刚好读完剩余 body，就产出 `DefaultLastHttpContent` 并 reset；否则产出普通 `DefaultHttpContent`，继续等待下一轮。

chunked 路径则多了一层传输控制状态：

```text
READ_CHUNK_SIZE
  -> 解析十六进制 chunk size

READ_CHUNKED_CONTENT
  -> 读取 chunk data，产出 HttpContent

READ_CHUNK_DELIMITER
  -> 消费 chunk data 后的 CRLF

chunk size = 0
  -> READ_CHUNK_FOOTER
  -> 解析 trailing headers
  -> 产出 LastHttpContent
```

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:489`。

注意一个很容易混淆的点：

```text
HTTP chunk 是线上传输格式的分块；
HttpContent 是 Netty 向 pipeline 暴露的对象分块。
```

两者相关，但不是一一对应的机械映射。`maxChunkSize` 可以让一个较大的固定长度 body 被切成多个 `HttpContent`；一个网络 chunk 也可能根据可读数据和配置被拆成多个对象。

### 4. 头部和 chunk 都有资源上限，否则状态机只是一个无限吃数据的入口

`HttpObjectDecoder` 当前默认限制包括：

- `maxInitialLineLength = 4096`
- `maxHeaderSize = 8192`
- `maxChunkSize = 8192`

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:149`。

它们解决的不是同一个问题：

- 初始行过长，防止请求行或状态行无界增长。
- headers 总量过大，防止头部解析缓冲区被撑大。
- chunk 过大，控制单次向下游交付的 body 对象大小。

此外，当前默认开启 header validation，源码在 `HttpObjectDecoder`、`HttpRequestDecoder`、`HttpResponseDecoder` 和组合 codec 的注释中都明确推荐这一点。原因是未验证的 header 可能留下 CRLF 注入等风险边界。

这里不把配置参数写成绝对安全保证；它们只是当前实现提供的解析边界，实际部署仍要按业务和协议流量调节。

### 5. 连接关闭和协议升级，是状态机的两个特殊出口

如果连接在 headers 读完前关闭，decoder 会生成带 `PrematureChannelClosureException` 的 invalid message；如果处于可由连接关闭结束的 variable-length response，则会产出 `EMPTY_LAST_CONTENT` 并 reset，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:574`。

如果 HTTP 升级已经发生，状态会进入 `UPGRADED`。此时剩余字节不应继续走 HTTP parser，而是被读取出来交给后续协议 handler，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:558`。

这两个出口共同说明：

```text
HTTP decoder 不只处理正常完整消息，
还必须定义“连接提前结束”和“HTTP 解析权已经交出去”时的行为。
```

## 四、`HttpServerCodec`：一个 pipeline 位置，内部两个方向各自工作

### 1. 为什么 server 不是简单地把两个 handler 串起来

服务端需要两条方向相反的链路：

```text
inbound：  Socket bytes -> HttpRequestDecoder -> HttpRequest/HttpContent
outbound：业务 response -> HttpResponseEncoder -> Socket bytes
```

`HttpServerCodec` 当前声明为：

```text
CombinedChannelDuplexHandler<HttpRequestDecoder, HttpResponseEncoder>
```

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:50`。

`CombinedChannelDuplexHandler` 的职责是把一个 inbound handler 和一个 outbound handler 组合成一个 pipeline handler，同时维护两个代理 context，见 `transport/src/main/java/io/netty/channel/CombinedChannelDuplexHandler.java:31` 和 `:126`。

这样设计的价值不是少写一个类名，而是让 server 的 HTTP 编解码能力在 pipeline 中占一个明确位置：

```text
HttpServerCodec
├── inbound 代理 -> HttpRequestDecoder
└── outbound 代理 -> HttpResponseEncoder
```

入站事件只交给 inbound handler，出站 write 只交给 outbound handler；两个内部 handler 可以各自保留自己的状态，也不会把读写方向混成一个巨大类。

这回答了完整性问题 #5：不是把两个独立 handler 随便串联，而是用一个双工组合器表达“它们属于同一个 HTTP codec 角色，但方向不同”。

### 2. server 为什么要在收到 request 时记录 method

`HttpRequestDecoder` 自己只能解析请求，`HttpResponseEncoder` 自己只负责编码响应。

但响应编码时，某些语义需要知道此前的请求方法：

- HEAD 响应不能真正带 body，即使响应头里可能有 `Content-Length`。
- 成功 CONNECT 响应之后，连接可能进入隧道模式。

因此 `HttpServerCodec` 用内部 `HttpServerRequestDecoder` 包住请求 decoder。它先调用父类 decode，再检查新产生的对象；每发现一个 `HttpRequest`，就把 method 放进队列，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:232`。

响应方向的 `HttpServerResponseEncoder` 在判断当前响应是否总是空 body 时，再 poll 出对应 method，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:257`。

数据关系是：

```text
收到 request HEAD
  -> 入站 decoder enqueue(HEAD)

业务写 response
  -> 出站 encoder poll(HEAD)
  -> isContentAlwaysEmpty = true
  -> 不把 response body 编码成线上内容
```

所以这不是一个“方便查日志”的队列，而是把入站请求语义传递给未来的出站响应编码。

### 3. 为什么 method queue 用一个 long，而不是一上来就 `ArrayDeque<HttpMethod>`

当前实现只需要区分三种方法语义：

```text
HEAD
CONNECT
OTHER
```

它没有必要保存完整的 `HttpMethod` 对象。源码用两个 bit 表示一个请求：

- `01` 表示 HEAD
- `10` 表示 CONNECT
- `11` 表示其它

一个 long 有 64 bits，因此可以内联保存 32 个请求，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:53`。

队列的低位保存最老 entry；poll 时取最低两位，然后无符号右移两位，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:211`。

这套结构的心智图是：

```text
第 1 个 method -> long 的最低 2 bits
第 2 个 method -> 接下来的 2 bits
...
第 32 个 method -> long 的最高 2 bits
超过 32 个 -> methodOverflowQueue
```

为什么超过 32 后不继续把新 entry 塞回 long？当前实现一旦进入 overflow，就一直追加到 `ArrayDeque`，直到 inline 队列排空、overflow 也排空，见 `enqueueMethod(...)` 的注释和实现，`codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:194`。

这保证了两个性质：

- 常见的少量 outstanding requests 不产生队列对象。
- 超过内联容量后仍然保持 FIFO，不会让后来的 overflow entry 越过 long 中尚未 poll 的旧 entry。

这就是完整性问题 #1 的答案：long 位队列不是为了炫技，而是因为当前只需 2 bits 的方法分类；它用低成本覆盖常见并发请求数，再用 `ArrayDeque` 承接溢出。

### 4. CONNECT 成功和异常 Transfer-Encoding 为什么还会反过来影响 response encoder

`HttpServerRequestDecoder` 在发现请求同时出现特殊 Transfer-Encoding 与 Content-Length 的处理路径后，会把 `mustCloseAfterResponse` 设为 true，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:251`。

随后 response encoder 在写出 `LastHttpContent` 时给 promise 添加 close listener，确保响应写完后关闭连接，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:261`。

CONNECT 成功响应则在 `sanitizeHeadersBeforeEncode(...)` 中移除 `Transfer-Encoding`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:271`。

这些分支共同体现一个事实：HTTP response 的线上形态不能只看 response 对象自己；它有时依赖此前请求方法、连接状态和协议安全边界。

## 五、`HttpClientCodec`：请求响应 FIFO 不是附加功能，而是响应解析的上下文来源

服务端是“收到请求，未来写响应”；客户端则相反：

```text
outbound：业务写 HttpRequest -> HttpRequestEncoder -> Socket
inbound：Socket bytes -> HttpResponseDecoder -> HttpResponse/HttpContent
```

`HttpClientCodec` 当前组合的是：

```text
CombinedChannelDuplexHandler<HttpResponseDecoder, HttpRequestEncoder>
```

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:63`。

### 1. 请求发出时入队 method，响应到达时出队 method

客户端 encoder 在编码 `HttpRequest` 时，把 method 放进 `Queue<HttpMethod>`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:272`。

响应 decoder 在判断 response body 是否总是为空时，从同一个 FIFO queue 取出对应 method，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:341`。

数据流是：

```text
write(HttpRequest HEAD)
  -> queue.offer(HEAD)
  -> 编码请求

收到 HTTP/1.1 200 OK
  -> queue.poll() == HEAD
  -> 响应按 HEAD 语义处理为无 body
```

为什么能用 FIFO？因为 HTTP/1.1 pipeline 的请求响应顺序要求保持对应顺序；第一个请求的响应不能让第二个请求的响应越过来。

因此这个队列不是业务层 request id，也不是用来匹配任意乱序响应的 map。它记录的是“按协议顺序，下一条响应应该继承哪个 request method 语义”。

### 2. HEAD 响应不能只看 `Content-Length`

`HttpResponseDecoder` 自己的注释已经说明，它无法单独知道当前响应是不是对应 HEAD 请求；使用 HTTP client 时应交给 `HttpClientCodec` 做额外状态管理，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpResponseDecoder.java:79`。

`HttpClientCodec.Decoder.isContentAlwaysEmpty(...)` 取出 method 后，如果是 HEAD，直接返回 true，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:359`。

这条规则的意义是：

```text
Content-Length 可以描述“如果用 GET 会返回多大内容”，
但对 HEAD 响应而言，它不意味着线上真的跟着这些 body 字节。
```

如果不保存请求方法，decoder 可能误把后续响应当成 HEAD body，readerIndex 就会错位，后面的响应也会被错误消费。

### 3. CONNECT 200 是 HTTP 解析器的边界，而不只是一个普通 status code

对于成功 CONNECT：

- 如果 `parseHttpAfterConnectRequest` 为 false，decoder 设置 `done = true`
- 清空 method queue
- 当前成功响应被视为无 body
- 后续输入进入 pass-through 模式

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:383`。

`done` 状态下，decoder 不再调用 HTTP response parser，而是把剩余可读字节直接读出交给下游，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:307`。

这可以表示成：

```text
HTTP response 200 to CONNECT
  -> 当前 HTTP 控制消息结束
  -> 协议所有权交给隧道/升级后的 handler
  -> 后续 bytes 不再按 HttpResponseDecoder 解析
```

这就是 HTTP upgrade 边界的本质：不是 decoder 变得更宽容，而是它明确停止对后续字节拥有解释权。

### 4. `failOnMissingResponse` 为什么用计数器而不是只看 method queue

客户端还可能需要检查：连接关闭时，是否有已经发出去却没有收到响应的请求。

当前 encoder 在写出请求的最后一个 `LastHttpContent` 时递增 `requestResponseCounter`，decoder 每产生一个响应的最后内容时递减，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:292` 和 `:330`。

当 channel inactive，如果计数器仍大于 0，就抛出 `PrematureChannelClosureException`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:404`。

这里使用计数器，而不是简单判断 method queue 是否为空，是因为它追踪的是“完整请求已经写完但对应响应尚未闭合”的数量；method queue 还承担 HEAD/CONNECT 语义，且响应对象可能经历 informational response 等情况。

这条边界回答了另一个常见问题：连接关闭不是天然表示“所有请求都处理完了”。客户端如果选择 `failOnMissingResponse`，就会把未配对请求显式暴露为异常。

## 六、误解澄清：HTTP 对象序列不是额外噪音，而是协议边界的显式化

### 误解一：`HttpRequest` 自带完整 body

不一定。

`HttpRequest` 只扩展 `HttpMessage`，它表达 method、URI、version 和 headers。body 由后续 `HttpContent` / `LastHttpContent` 承载。

### 误解二：`HttpContent` 是另一条独立的 HTTP 消息

不是。

它是前一个 `HttpMessage` 的 body 分块。只有 `LastHttpContent` 到达，当前消息的 body 才完成；如果有 trailing headers，也在最后对象上出现。

### 误解三：HTTP decoder 默认一步产出 `FullHttpRequest`

不是。

`HttpObjectDecoder` 的设计是流式输出消息头和内容块。要让业务 handler 只拿到一个完整对象，需要后续聚合层把对象序列拼回 `FullHttpRequest` 或 `FullHttpResponse`。

### 误解四：HEAD 响应有 `Content-Length` 就一定会跟着 body

不是。

HEAD 的响应语义来自请求方法，`HttpClientCodec` / `HttpServerCodec` 都用 method queue 补上单独 response 无法推断的上下文。

### 误解五：`HttpServerCodec` 是一个把 decoder 和 encoder 写在一起的单体 parser

不是。

它是 `CombinedChannelDuplexHandler` 的组合对象：inbound 和 outbound 仍由两个内部 handler 各自处理，只是在 pipeline 里以一个双工 codec 角色出现。

### 误解六：CONNECT 成功后继续按 HTTP 解析更安全

不是。

成功 CONNECT 后，连接可能已经进入隧道模式。当前 `HttpClientCodec` 默认把后续字节切换到 pass-through，继续用 HTTP parser 解释它们才会破坏协议边界。

## 七、收网：HTTP codec 做的不是“把字符串解析成对象”，而是把协议状态和对象边界同时交给 pipeline

现在回收开头的问题：为什么 HTTP 不能只用一个 handler，把一整段字节变成一个完整 request/response？

因为 HTTP 同时有三种结构：

```text
语义结构：请求行/响应行 + headers
内容结构：固定长度、连接结束或 chunked body
连接结构：普通 HTTP、HEAD 空 body、CONNECT/upgrade 后的非 HTTP 字节
```

`HttpObjectDecoder` 用跨 read 的状态机把这三种结构串起来：

```text
初始行 -> headers -> body 模式
                      ├── 无 body -> EMPTY_LAST_CONTENT
                      ├── 固定长度 -> HttpContent... -> LastHttpContent
                      ├── variable -> 连接关闭时 LastHttpContent
                      └── chunked -> chunk size/data/trailer -> LastHttpContent
```

`HttpServerCodec` 和 `HttpClientCodec` 再在两边补上方向组合和 method 上下文：

- server 记录收到的 request method，编码未来的 response。
- client 记录发出的 request method，解释未来的 response。
- HEAD 影响 body 是否为空。
- CONNECT 成功影响 HTTP 解析是否停止。
- method 队列把这些跨方向、跨时间的语义保存下来。

所以本篇真正的结论是：

```text
HttpRequest/HttpResponse 是消息头和协议语义，
HttpContent/LastHttpContent 是可流式交付的 body 与结束边界；
HttpServerCodec/HttpClientCodec 则把 decoder、encoder 和方法上下文组合成一个方向完整的 HTTP pipeline 角色。
```

这也留下了下一篇的问题：如果业务 handler 不想自己逐块处理 `HttpContent`，又希望直接拿到 `FullHttpRequest`；如果 body 太大不能无界聚合；如果响应还要按客户端能力压缩，Netty 应该把这些对象流再交给谁处理？

下一篇进入 `HttpObjectAggregator` 与 `HttpContentCompressor`：一个负责把分块对象收成完整消息，一个负责在 `HttpContent` 层完成大小限制与内容编码。