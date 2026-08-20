# Ch11-02 aggregation and compression rewrite plan

## 一句话困惑

上一章已经知道 HTTP decoder 默认输出的是 `HttpMessage + HttpContent + LastHttpContent` 对象序列，但大多数业务 handler 并不想自己一块一块处理 body；另一方面，响应压缩也不能简单在业务线程里手写 gzip，因为它必须尊重 `Accept-Encoding`、跳过不该压的响应，并正确改写 headers 与内容流。

## 一句话顿悟

Netty 把这两个“后处理”问题拆成两条可组合骨架：`HttpObjectAggregator` 建立在通用 `MessageAggregator` 之上，把 start/content/last 对象流收成 `FullHttpMessage`；`HttpContentCompressor` 则建立在 `HttpContentEncoder` 之上，用一个内存内 `EmbeddedChannel` 承接真正的压缩 encoder，把 `HttpResponse + HttpContent` 改写成协商后的压缩内容流。

## 本篇范围

- 主讲 `MessageAggregator` 的通用 start→aggregate→finish 骨架。
- 主讲 `HttpObjectAggregator` 如何把 `HttpMessage + HttpContent + LastHttpContent` 收成 `FullHttpRequest/FullHttpResponse`。
- 主讲 `newContinueResponse` / `handleOversizedMessage` / `closeOnExpectationFailed` 三路分支。
- 主讲 `HttpContentEncoder` 的状态机和 `HttpContentCompressor` 的 `Accept-Encoding` 协商。
- 主讲为什么压缩借 `EmbeddedChannel` 而不是独立线程。
- 回答完整性问题 #2/#3/#4/#6/#7。

## 依赖声明

```text
本篇
├── HARD 前置：ch11-http/01-codec-pipeline.md
├── HARD 前置：ch10-codec/02-encoders-and-framedecoders.md
├── HARD 前置：ch7-pipeline/01-pipeline-structure.md
├── HARD 前置：ch4-bytebuf/01-dual-index-and-refcnt.md
├── SOFT 前置：ch8-memorypool/04-pooledbuf-lifecycle.md
├── NAV 后续：ch14-timer/01-hashed-wheel-timer.md
└── COMPARE：ChunkedWriteHandler / HttpContentDecompressor（仅导航，不展开）
```

## 结构设计

### 1. 开场：HTTP codec 已经给你对象序列，但业务通常想要“完整消息”或“已压缩输出”
- 承接上一篇：默认输出是分块对象流。
- 提出两个现实需求：完整 body 处理、自动响应压缩。
- 预计 700-900 字。

### 2. 失败方案：为什么不能在业务 handler 里自己攒 body、自己手写 gzip
- 失败方案 A：业务层自己缓存 `HttpContent` 到 `ByteBuf`。
- 失败方案 B：超大 body 先攒完再决定报 413。
- 失败方案 C：压缩在业务 handler 里直接 `GZIPOutputStream`/线程池做掉。
- 预计 1500-1900 字。

### 3. `MessageAggregator`：start→aggregate→finish 的通用骨架
- `acceptInboundMessage` 与 aggregating/currentMessage。
- `newContinueResponse`、content-length 预检查、`CompositeByteBuf` 累积。
- `handleIncompleteAggregateDuringClose`、channelInactive / handlerRemoved 释放。
- 预计 1800-2300 字。

### 4. `HttpObjectAggregator`：把 HTTP 对象流收成 `FullHttpMessage`
- `isStartMessage/isContentMessage/isLastContentMessage/isAggregated`。
- `beginAggregation` 创建 `AggregatedFullHttpRequest/Response`。
- `aggregate` 合并 trailing headers。
- `finishAggregation` 补 `Content-Length`，特别解释 HEAD 响应注释。
- `FullHttpRequest` 与 `HttpRequest + HttpContent` 的差异，回答完整性问题 #3。
- 预计 2000-2500 字。

### 5. 超限与 Expect：为什么 `handleOversizedMessage` 不能统一一刀切
- `100 Continue`、`417 Expectation Failed`、`413 Request Entity Too Large` 三类自动响应。
- request 分支：何时 close，何时继续丢弃直到下一请求。
- response 分支：为何直接 close + 抛 `TooLongHttpContentException`。
- 回答完整性问题 #6。
- 预计 1800-2300 字。

### 6. `HttpContentEncoder` / `HttpContentCompressor`：压缩不是一次函数调用，而是一条状态机改写链
- `acceptEncodingQueue`、`AWAIT_HEADERS/AWAIT_CONTENT/PASS_THROUGH`。
- `beginEncode` 决定是否压缩、选择目标编码、构造 `EmbeddedChannel`。
- full response 与 streaming response 的不同改写路径。
- `ComposedLastHttpContent` 的 trailing headers 保留。
- 预计 2200-2800 字。

### 7. `Accept-Encoding` 协商：q 值优先级与为什么用 `EmbeddedChannel`
- `determineEncoding`：br/zstd/snappy/gzip/deflate/*。
- `contentSizeThreshold`、已有 `Content-Encoding` 时跳过。
- `EmbeddedChannel.builder().handlers(createEncoderFor(...))` 的意义：复用现有 encoder pipeline，无需真实 socket、无需额外线程。
- 回答完整性问题 #4/#7。
- 预计 1700-2200 字。

### 8. 误解澄清
- Aggregator 不是“总是更好”。
- `FullHttpRequest` 不是 decoder 默认输出。
- 压缩不是任意 response 都压。
- `EmbeddedChannel` 不是异步线程池。
- 预计 900-1200 字。

### 9. 收网与桥接
- 收束：聚合负责“对象流变完整消息”，压缩负责“对象流变编码后内容流”。
- 桥到后续超时/连接管理：HTTP keep-alive、重试、idle 检测会引出 timer。
- 预计 500-700 字。

## 证据清单

- `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:52`
- `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:205`
- `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:221`
- `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:266`
- `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:283`
- `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:395`
- `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:420`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:86`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:161`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:204`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:219`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:227`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:242`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:57`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:82`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:110`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:249`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:271`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:321`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentCompressor.java:51`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentCompressor.java:252`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentCompressor.java:282`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentCompressor.java:329`
- `codec-http/src/main/java/io/netty/handler/codec/http/ComposedLastHttpContent.java:23`

## 误解清单

1. `HttpObjectAggregator` 只是把几个对象放进 List，再一次性回调业务。
2. `FullHttpRequest` 是 HTTP decoder 默认输出，只是看起来被“包装”了一层。
3. body 超限时统一回 413 就够了，不需要区分 request/response 或 Expect 场景。
4. `HttpContentCompressor` 是把整条 response 拿出来用 gzip 函数处理一下。
5. `EmbeddedChannel` 是额外线程或异步任务系统。
6. `Accept-Encoding` 只要找有没有 gzip 字样即可。

## 边界清单

- 本篇不展开 `HttpContentDecompressor` 和入站解压路径。
- 本篇不展开文件大流式传输或 `ChunkedWriteHandler`。
- 本篇不把 `contentSizeThreshold` 解释为完整的压缩策略；content-type 等更细过滤不在当前源码类中实现。
- 本篇不把自动 100/413/417 响应外推成所有 HTTP 服务应接受的产品语义；这里只说明 Netty 当前 handler 的行为。