# Ch11-01 HTTP codec pipeline rewrite plan

## 一句话困惑

Ch10 已经说明 TCP 字节流如何被切成 frame，但 HTTP 并不是一帧 `ByteBuf` 就结束：请求行、响应行、headers、body、chunked trailer 需要沿 pipeline 逐步变成不同对象；与此同时 server 既要读 request 又要写 response，client 还要把响应和此前发出的请求方法对应起来。

## 一句话顿悟

Netty 没有把 HTTP 做成一个“万能 handler”：`HttpObjectDecoder` 负责把字节流推进 HTTP 状态机并产出 `HttpMessage + HttpContent + LastHttpContent`；`HttpServerCodec` / `HttpClientCodec` 再用 `CombinedChannelDuplexHandler` 把入站 decoder 与出站 encoder 组合到一个 pipeline 位置，并在 HTTP 特殊语义上补一层方法跟踪。

## 本篇范围

- 主讲 HTTP 从 TCP 字节到 HTTP 对象序列的转换。
- 主讲 `HttpServerCodec` 的 inbound/outbound 组合、HEAD/CONNECT method queue 和 32 项 long 内联优化。
- 主讲 `HttpClientCodec` 的 request method FIFO、HEAD/CONNECT 响应处理、升级透传和缺失响应检查。
- 主讲 `HttpObject` / `HttpMessage` / `HttpRequest` / `HttpResponse` / `HttpContent` / `LastHttpContent` / `FullHttpMessage` 的层次关系。
- 不展开 `HttpObjectAggregator` 的三阶段细节、压缩协商和超限处理，留给 Ch11-02。

## 依赖声明

```text
本篇
├── HARD 前置：ch10-codec/01-bytetomessagedecoder.md
├── HARD 前置：ch10-codec/02-encoders-and-framedecoders.md
├── HARD 前置：ch7-pipeline/01-pipeline-structure.md
├── HARD 前置：ch4-bytebuf/01-dual-index-and-refcnt.md
├── SOFT 前置：ch9-bootstrap/02-bootstrap-server.md
├── NAV 后续：ch11-http/02-aggregation-compression.md
└── NAV 后续：ch14-timer/01-hashed-wheel-timer.md
```

## 结构设计

### 1. 开场：HTTP 不是一个 frame，而是一串有顺序的对象
- 承接 Ch10：通用拆包器已经能找到边界，HTTP 还要表达请求/响应语义和 body 分块。
- 提出“为什么不能一个 handler 一把梭”的问题。
- 预计 700-900 字。

### 2. 失败方案：把 HTTP 当成一次性字符串或单个 ByteBuf
- 失败方案 A：整段 read 完再解析。
- 失败方案 B：只产出一个完整 request/response，body 大时导致内存压力。
- 失败方案 C：server/client 共用同一个方向逻辑，不跟踪方法。
- 预计 1400-1800 字。

### 3. HTTP 对象总图：Message 是头，Content 是体，Last 是边界
- `HttpObject` 基础。
- `HttpMessage = version + headers + decoderResult`。
- request/response 添加各自语义字段。
- `HttpContent = ByteBufHolder`，`LastHttpContent = content + trailingHeaders`。
- `FullHttpMessage = HttpMessage + LastHttpContent`。
- `EMPTY_LAST_CONTENT` 的无 body 哨兵。
- 预计 1800-2200 字。

### 4. `HttpObjectDecoder`：HTTP 是状态机，不是一次 split
- `SKIP_INITIAL_LINE_CHARS -> READ_INITIAL -> READ_HEADER`。
- 无 body、固定长度、连接结束、chunked 四类 body 走向。
- `maxInitialLineLength`、`maxHeaderSize`、`maxChunkSize` 的保护角色。
- 解析 chunk size/trailer，输出 HttpContent/LastHttpContent。
- 预计 2200-2800 字。

### 5. `HttpServerCodec`：一个 pipeline 位置，内部两个方向 handler
- `CombinedChannelDuplexHandler<HttpRequestDecoder,HttpResponseEncoder>`。
- inbound decoder 产出 request 并 enqueue method；outbound encoder poll method 决定 HEAD 空 body、CONNECT 成功响应 header 处理。
- 解释为什么不是两个独立 pipeline handler。
- 解释 long 位队列：2 bits/method，32 个无需分配，overflow ArrayDeque 保序。
- 预计 2000-2500 字。

### 6. `HttpClientCodec`：请求响应 FIFO 与协议升级边界
- outbound `HttpRequestEncoder` 发送 request 时 queue method。
- inbound `HttpResponseDecoder` 取 method，HEAD 无 body，CONNECT 200 后 done/pass-through。
- `failOnMissingResponse` + AtomicLong + channelInactive 的异常语义。
- upgrade 后 encoder/decoder 如何停止 HTTP 处理，剩余字节透传。
- 预计 2200-2800 字。

### 7. 误解澄清：HttpRequest 不等于完整 body，HttpContent 不是“额外协议消息”
- HTTP header object 与 body chunk 的关系。
- 无 body 不是创建空 content，而可复用 `EMPTY_LAST_CONTENT`。
- `FullHttpRequest` 不是 decoder 默认一步产出，而是后续聚合层的完整视图。
- HEAD 的 Content-Length 不等于有 body。
- 预计 1000-1400 字。

### 8. 收网与桥接
- 收束 server/client 组合 codec、HTTP 状态机、分块对象模型。
- 回收开篇问题。
- 桥到 Ch11-02：如果业务不想处理对象序列，就用 aggregator；如果要压缩，继续在 HttpContent 层做编码。
- 预计 600-800 字。

## 证据清单

- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:148`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:226`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:371`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:395`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:447`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:489`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:574`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:50`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:53`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:184`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:237`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:257`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:284`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:63`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:68`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:272`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:302`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:341`
- `transport/src/main/java/io/netty/channel/CombinedChannelDuplexHandler.java:31`
- `transport/src/main/java/io/netty/channel/CombinedChannelDuplexHandler.java:126`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpMessage.java:27`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpContent.java:22`
- `codec-http/src/main/java/io/netty/handler/codec/http/LastHttpContent.java:25`
- `codec-http/src/main/java/io/netty/handler/codec/http/FullHttpMessage.java:20`
- `codec-http/src/main/java/io/netty/handler/codec/http/FullHttpRequest.java:20`
- `codec-http/src/main/java/io/netty/handler/codec/http/FullHttpResponse.java:20`

## 误解清单

1. HTTP decoder 一次 read 就应该产出一个完整 request/response。
2. `HttpRequest` 自带 body，`HttpContent` 只是额外通知。
3. `HttpServerCodec` 是一个同时实现读写的单体 parser。
4. HEAD 响应有 `Content-Length` 就一定有 body。
5. `HttpClientCodec` 只负责 decoder + encoder 组合，不需要跟踪请求方法。
6. `FullHttpRequest` 是 HTTP decoder 默认的唯一输出形态。

## 边界清单

- 本篇不展开 `HttpObjectAggregator` 如何累计和超限，Ch11-02 处理。
- 本篇不展开 `HttpContentCompressor` 的 q 值协商和 EmbeddedChannel，Ch11-02 处理。
- 本篇对 header validation 只说明当前源码的安全边界，不扩展成独立安全审计。
- 本篇对 HTTP upgrade 只讲 codec 停止解析与透传，不讲具体 WebSocket upgrade handler。
- 本篇不把 `HttpMessage + HttpContent` 解释成应用层必须采用的唯一模型；它是当前 Netty HTTP codec 的输出协议。