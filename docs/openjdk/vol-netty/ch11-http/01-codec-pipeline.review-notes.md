# Ch11-01 `01-codec-pipeline.md` review notes

## 第一轮：事实审

### 已核对的核心结论

1. `HttpObjectDecoder` 当前继承 `ByteToMessageDecoder`，并通过内部 `State` 保存 HTTP 解析阶段，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:148`、`:226`。
2. 初始行解析后，`HttpRequestDecoder` 创建 `DefaultHttpRequest`，`HttpResponseDecoder` 创建 `DefaultHttpResponse`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpRequestDecoder.java:217`、`codec-http/src/main/java/io/netty/handler/codec/http/HttpResponseDecoder.java:211`。
3. 无 body 路径当前会输出当前 `HttpMessage` 与 `LastHttpContent.EMPTY_LAST_CONTENT`，然后 reset，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:402`。
4. 固定长度 body 当前按 `maxChunkSize` 分块，并在最后一块输出 `DefaultLastHttpContent`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:456`。
5. chunked body 当前按 `READ_CHUNK_SIZE -> READ_CHUNKED_CONTENT -> READ_CHUNK_DELIMITER -> READ_CHUNK_FOOTER` 推进，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:489`。
6. `HttpObjectDecoder` 当前默认限制 `maxInitialLineLength=4096`、`maxHeaderSize=8192`、`maxChunkSize=8192`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectDecoder.java:149`。
7. `HttpServerCodec` 当前继承 `CombinedChannelDuplexHandler<HttpRequestDecoder, HttpResponseEncoder>`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:50`。
8. `CombinedChannelDuplexHandler` 当前通过 inbound/outbound 两个 delegated context 组合两个方向 handler，并按事件方向分别委派，证据：`transport/src/main/java/io/netty/channel/CombinedChannelDuplexHandler.java:31`、`:126`、`:245`、`:275`。
9. `HttpServerCodec` 当前把 method 压缩成 HEAD/CONNECT/OTHER 三种 2-bit flag，long 内联保存 32 个 outstanding requests，超过后进入 `ArrayDeque` overflow，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:53`、`:60`、`:184`、`:211`。
10. `HttpServerCodec` 当前 request decoder 发现 `HttpRequest` 后入队 method，response encoder 在 `isContentAlwaysEmpty` 中 poll method，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:237`、`:284`。
11. server 端 HEAD 会影响 response body 为空判定；成功 CONNECT 会移除 `Transfer-Encoding`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpServerCodec.java:271`、`:284`。
12. `HttpClientCodec` 当前组合 `HttpResponseDecoder` 与 `HttpRequestEncoder`，并维护 `Queue<HttpMethod>`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:63`、`:68`。
13. client encoder 当前在编码 `HttpRequest` 时入队 method，response decoder 当前在 `isContentAlwaysEmpty` 中取出 method，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:272`、`:341`。
14. HEAD response 当前直接按空 body 处理；成功 CONNECT 在默认配置下设置 `done=true`、清空 queue，后续 decoder 进入 pass-through，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:359`、`:383`、`:307`。
15. `failOnMissingResponse` 当前通过 `AtomicLong requestResponseCounter` 在完整请求写出时递增、响应最后内容时递减，连接 inactive 且计数大于 0 时抛 `PrematureChannelClosureException`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpClientCodec.java:75`、`:292`、`:330`、`:404`。
16. `HttpMessage` 当前提供 protocol version 与 headers；`HttpRequest` 增加 method/uri；`HttpResponse` 增加 status，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpMessage.java:27`、`HttpRequest.java:38`、`HttpResponse.java:35`。
17. `HttpContent` 当前是 `HttpObject + ByteBufHolder`；`LastHttpContent` 增加 trailing headers；`FullHttpMessage` 是 `HttpMessage + LastHttpContent`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpContent.java:22`、`LastHttpContent.java:25`、`FullHttpMessage.java:20`。
18. `LastHttpContent.EMPTY_LAST_CONTENT` 当前使用 empty buffer、empty trailing headers，并复用单例，证据：`codec-http/src/main/java/io/netty/handler/codec/http/LastHttpContent.java:30`。

### 行号和术语复核

- 正文使用的 `HttpObjectDecoder`、`HttpServerCodec`、`HttpClientCodec`、`CombinedChannelDuplexHandler` 均与当前源码类名一致。
- 正文没有把 `FullHttpRequest` 写成 `HttpObjectDecoder` 默认直接输出；明确写成后续聚合结果。
- 正文把 server/client 的 method queue 说成语义上下文来源，没有误写成乱序响应 map。

## 第二轮：因果审

### 因果链是否成立

1. “HTTP 需要对象序列而不是单个完整 ByteBuf”由大 body、chunked body 和 `HttpObjectDecoder` 的多个输出状态共同支撑，成立。
2. “`HttpContent` 不是独立请求而是 body 分块”由其 `HttpObject + ByteBufHolder` 类型和 decoder 输出顺序支撑，成立。
3. “`LastHttpContent` 表达结束边界而非必然非空内容”由 `EMPTY_LAST_CONTENT` 的实现支撑，成立。
4. “server/client 使用组合双工 handler 是为了在一个 pipeline 位置分开方向代理”由 `CombinedChannelDuplexHandler` 的两个 context 和事件分派实现支撑，成立。
5. “HEAD/CONNECT 需要 method queue，因为 response 本身不足以决定 body/升级语义”由 `HttpResponseDecoder` 注释和两个组合 codec 的 override 支撑，成立。
6. “CONNECT 成功后剩余字节进入 pass-through”由 `done` 分支直接支撑，成立。
7. “请求响应 FIFO 不是 request id map”由当前 `ArrayDeque<HttpMethod>` 和 poll 语义支撑，成立。

### 需要克制的推断

- 文中说 HTTP/1.1 pipeline 的响应按请求顺序对应，作为当前 FIFO 设计的协议背景；没有扩展为所有 HTTP 版本或所有代理实现的普遍并发保证。
- 文中将 `maxChunkSize` 解释为控制单次 body 对象交付大小，这由固定长度和 chunked 读取逻辑直接支撑；没有把它写成总 body 上限。
- 文中把 header validation 写成当前源码推荐的安全边界，没有把当前默认值外推成完整安全防护。

## 第三轮：结构审

### 当前结构

1. 承接 Ch10，提出 HTTP 为什么需要对象序列。
2. 先推演“整包等待、字符串切分、无上下文响应解析”三个失败方案。
3. 建立对象模型：Message / Content / Last / Full。
4. 再讲 `HttpObjectDecoder` 状态机和 body 分支。
5. 再讲 server 双工组合与 method 位队列。
6. 再讲 client request-response FIFO、HEAD/CONNECT、missing response。
7. 用误解澄清重新压缩对象模型与方向模型。
8. 收网并桥接聚合/压缩。

该结构遵循问题 -> 失败 -> 模型 -> 状态机 -> 组合 -> 回收，未按源码文件顺序机械展开。

### 结构风险检查

- 没有提前展开下一篇 `HttpObjectAggregator` 的实现细节，只说明它是后续完整消息视图的来源。
- 没有把压缩协商前置成当前文章的事实前提。
- `HttpServerCodec` 与 `HttpClientCodec` 分开讲，避免把 server 的响应语义和 client 的请求上下文混在同一节。

## 第四轮：读者审

### 删码测试判断

删除正文 fenced code block 后，仍能复述：

1. 为什么 HTTP 输出 `HttpMessage + HttpContent + LastHttpContent`。
2. `HttpObjectDecoder` 如何按状态推进。
3. server/client 双工组合为什么需要方法队列。
4. HEAD/CONNECT 如何改变 body 和后续协议边界。
5. `FullHttpMessage` 与分块模型的差异。

代码块主要承担对象层次、状态图和数据流证据，不承担全部叙事骨架。

### 读者风险

- HTTP 对象层次较多，正文先给总图再逐层解释，避免直接从接口定义开始。
- `HttpContent` 与线上 chunk 的关系容易混淆，正文单独说明“相关但不是一一机械映射”。
- method queue 的 long 位压缩可能打断主线，正文先给 request-response 语义，再解释位布局和 overflow。

## 第五轮：边界审与缺陷猎取

### 已覆盖边界

- 初始行、headers、chunk、trailer 的上限。
- request/response 无 body 差异。
- variable-length response 的连接关闭收尾。
- CONNECT/upgrade 后 HTTP parser 停止与剩余字节透传。
- HEAD response 的 `Content-Length` 与实际 body 语义差异。
- `EMPTY_LAST_CONTENT` 的无 body 哨兵。
- client 连接关闭时 missing responses 的可选异常。

### Bug / issue 候选检查

本轮没有形成证据完整、可单列 issue 的源码缺陷：

- server method queue 的 inline + overflow 转换保持旧 inline 队列优先，当前实现未发现顺序错乱证据。
- client `done` pass-through 路径与 CONNECT 语义一致，未发现升级后仍误解析 HTTP 的实现缺口。
- `HttpObjectDecoder` 的固定长度、chunked、variable-length 和 decodeLast 分支目前自洽，未发现本篇范围内可证实的资源或索引漏洞。
- `EMPTY_LAST_CONTENT` 是不可变、无引用计数释放责任的单例设计，当前未发现误释放证据。

结论：本篇未发现需要单列 issue 候选的源码 bug。header validation、lone LF、升级时机属于边界/安全风险，应在部署和后续协议专题中继续关注，但当前证据不足以在本文定性为 Netty 实现缺陷。

## 第六轮：依赖审

### 前置依赖

- Ch10 Codec：解释 `HttpObjectDecoder` 为什么继承 `ByteToMessageDecoder`，真实存在。
- Ch7 Pipeline：解释双工组合 handler 的事件方向，真实存在。
- Ch4 ByteBuf：解释 HttpContent 的 ByteBufHolder 生命周期，正文只复用结论。
- Ch9 Bootstrap：只作为 child pipeline 已启动的运行背景，不承担本篇核心事实。

### 后续桥接

- 下一篇 `02-aggregation-compression.md` 已存在，正文结尾准确桥到 `HttpObjectAggregator` 和 `HttpContentCompressor`。
- 没有引用尚未分析的 HashedWheelTimer 作为当前机制前提，只保持章节导航边界。

## 机械检查

### 禁用词扫描目标

- 此处不再赘述
- 不再展开
- 类似地
- 同理
- 依此类推
- 篇幅所限
- 显然
- 容易看出
- 细节读者自行阅读源码

预期：正文不命中。

### 删码测试目标

正文删去 fenced code block 后，应保留完整的：

- HTTP 对象模型
- decoder 状态机
- server/client 双工组合
- method queue 语义
- HEAD/CONNECT/upgrade 边界
- 下一篇聚合与压缩桥接