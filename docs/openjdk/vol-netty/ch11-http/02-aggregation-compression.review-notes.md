# Ch11-02 `02-aggregation-compression.md` review notes

## 第一轮：事实审

### 已核对的核心结论

1. `HttpObjectAggregator` 当前继承 `MessageAggregator<HttpObject, HttpMessage, HttpContent, FullHttpMessage>`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:86`。
2. `MessageAggregator` 当前通过 `acceptInboundMessage` + `aggregating` 控制 start/content/last 生命周期，证据：`codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:91`。
3. `MessageAggregator.decode()` 的 start 分支会先处理 continue response、content-length 预检，再创建 `CompositeByteBuf` 和 `currentMessage`，证据：`codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:205`、`:221`、`:266`。
4. `MessageAggregator` 当前在 content 分支先检查超限，再 append content、aggregate 附加信息，并在 last 时 finishAggregation+输出，证据：`codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:271`。
5. `appendPartialContent` 当前对每块 `partialContent` 执行 `retain()` 后追加进 `CompositeByteBuf`，证据：`codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:326`。
6. `MessageAggregator` 当前在 channelInactive / handlerRemoved 都会释放 `currentMessage`，并在未完成聚合时抛 `PrematureChannelClosureException`，证据：`codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:430`、`:450`。
7. `HttpObjectAggregator` 当前把 `HttpMessage` 视为 start、`HttpContent` 视为 content、`LastHttpContent` 视为结束、`FullHttpMessage` 视为已聚合结果，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:132`。
8. `HttpObjectAggregator.beginAggregation()` 当前会先去掉 chunked 传输标记，再创建 `AggregatedFullHttpRequest/Response`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:204`。
9. `HttpObjectAggregator.aggregate()` 当前在最后一块时把 trailing headers 合并进聚合结果，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:219`。
10. `HttpObjectAggregator.finishAggregation()` 当前在缺失 `Content-Length` 时回填聚合后内容长度，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:227`。
11. `HttpObjectAggregator` 当前自动响应至少有 `100 Continue`、`417 Expectation Failed`、`413 Request Entity Too Large` 三种，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:89`、`:161`。
12. request 超限分支当前会根据是否 full、autoRead、100-continue、keep-alive 决定返回 `TOO_LARGE` 还是 `TOO_LARGE_CLOSE` 并是否关闭连接，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:242`。
13. response 超限分支当前直接 close 并抛 `TooLongHttpContentException`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:266`。
14. `HttpContentEncoder` 当前是 `MessageToMessageCodec<HttpRequest, HttpObject>`，通过入站请求记录 `Accept-Encoding`，通过出站响应对象流改写内容，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:57`、`:82`、`:110`。
15. `HttpContentEncoder` 当前用 `AWAIT_HEADERS` / `AWAIT_CONTENT` / `PASS_THROUGH` 三态维护一整条 response 的改写状态，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:59`。
16. `HttpContentEncoder` 对 full response 与 streaming response 走不同改写路径：full response 回填 `Content-Length`，streaming response 改成 chunked，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:184`、`:193`、`:230`。
17. `HttpContentEncoder.encodeContent()` 当前在 `LastHttpContent` 时 `finishEncode(out)`，并保留 trailing headers：空则 `EMPTY_LAST_CONTENT`，否则 `ComposedLastHttpContent`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:271`。
18. `HttpContentCompressor.beginEncode()` 当前先检查 `contentSizeThreshold`、已有 `Content-Encoding`、再根据 `Accept-Encoding` 选择算法，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpContentCompressor.java:252`。
19. `HttpContentCompressor.determineEncoding()` 当前维护 `br/zstd/snappy/gzip/deflate/*` 的 q 值，并按实现顺序选择当前可用算法，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpContentCompressor.java:329`。
20. `HttpContentCompressor` 当前通过 `EmbeddedChannel.builder().handlers(createEncoderFor(...)).build()` 构造实际压缩子通道，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpContentCompressor.java:272`。
21. `HttpContentEncoder` 当前真正向压缩子通道喂数据的是 `encoder.writeOutbound(in.retain())`，再 `readOutbound()` 取出压缩后的 ByteBuf，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:339`、`:352`。
22. `ComposedLastHttpContent` 当前携带 trailingHeaders、自带 empty content，不承担真实 ByteBuf 释放责任，证据：`codec-http/src/main/java/io/netty/handler/codec/http/ComposedLastHttpContent.java:23`。

### 术语精度检查

- 正文中“聚合器把 chunked 语义外显传输形式改回完整消息视图”是对 `setTransferEncodingChunked(start, false)` 的解释，符合当前语义边界。
- 正文未把 `contentSizeThreshold` 夸大成 content-type 过滤；明确说明更细过滤不在当前类中实现，保持准确。

## 第二轮：因果审

### 因果链是否成立

1. “业务层自己缓存 `HttpContent` 会重新承担聚合生命周期、超限、连接关闭和引用计数边界” 由 `MessageAggregator` 当前骨架直接支撑，成立。
2. “`HttpObjectAggregator` 的真正价值不只是拼 body，而是恢复完整 `FullHttpMessage` 语义” 由 trailing headers 合并、`Content-Length` 回填、continue/oversize 分支共同支撑，成立。
3. “request 超限与 response 超限不能统一处理” 由 `handleOversizedMessage` 中完全不同的 request/response 分支直接支撑，成立。
4. “压缩不是一次函数变换，而是一条 HTTP 对象流状态机改写链” 由 `HttpContentEncoder` 三态和 full/streaming 双路径直接支撑，成立。
5. “`EmbeddedChannel` 被选中是为了复用 encoder pipeline 语义，而不是为了并行化 CPU 活” 由 `writeOutbound/readOutbound` 的使用方式支撑，成立。
6. “`Accept-Encoding` 协商不是简单 contains gzip” 由 q 值解析与多算法比较支撑，成立。

### 需要克制的推断

- 文中关于“压缩对很小 body 收益未必为正”的解释，是 `contentSizeThreshold` 存在的合理设计推断，未被写成源码作者意图绝对化表述。
- 文中将 full-response/streaming-response 的差异解释为“一个能回填长度、一个只能 chunked”，是当前实现行为的准确人话，不涉及超出源码边界的协议猜测。

## 第三轮：结构审

### 当前结构是否按理解路径推进

1. 从上一章的对象流输出切入，提出“什么时候该收成完整消息、什么时候继续流式改写”的现实问题。
2. 先推演业务自己攒 body、超限晚拒绝、业务自己 gzip/线程池压缩的失败方案。
3. 再上升到 `MessageAggregator` 的通用骨架。
4. 然后落到 `HttpObjectAggregator` 的 HTTP 具体语义。
5. 再拆 `Expect` 与 oversized 三路分支。
6. 接着转到 `HttpContentEncoder` / `HttpContentCompressor` 压缩链。
7. 最后用误解澄清和收网把“聚合 vs 改写”两条骨架并列收束。

该结构符合问题 -> 失败 -> 顿悟 -> 机制 -> 回收，未按源码文件顺序机械翻译。

### 结构风险检查

- 没有把 `HttpContentCompressor` 先于 `HttpContentEncoder` 单独硬讲，避免让读者先见实现细节再补骨架。
- `handleOversizedMessage` 单列成节，避免它被埋在聚合细节里。
- 未把下游 timer 章节内容前置成当前文章的既定事实，只做篇末导航。

## 第四轮：读者审

### 删码测试判断

删掉代码块后，正文仍能复述：

1. `MessageAggregator` 的 start→aggregate→finish 模型。
2. `HttpObjectAggregator` 如何把分块对象流收成 `FullHttpMessage`。
3. oversized / Expect 为什么不能统一一刀切。
4. `HttpContentEncoder` 为什么需要三态和 full/streaming 双路径。
5. `HttpContentCompressor` 如何协商编码并借 `EmbeddedChannel` 做子通道压缩。

代码块承担的是局部证据，不是叙事骨架。

### 潜在阅读负担点

- `HttpObjectAggregator` 与 `MessageAggregator` 容易被看成两层重复；正文先解释通用骨架，再落 HTTP 语义，已减轻重复感。
- `EmbeddedChannel` 可能被误解成线程/异步工具；正文已单列解释其“虚拟子通道”角色。
- q 值协商容易落成纯规则表；正文先解释“不是简单 contains”，再讲实现顺序，阅读负担可接受。

## 第五轮：边界审与缺陷猎取

### 已覆盖边界

- start 阶段 continue response / expectation failed / pre-check oversized。
- content 阶段累计超限。
- incomplete aggregate during close / handlerRemoved 的 release。
- request oversized 与 response oversized 差异。
- full response 与 streaming response 的不同改写策略。
- trailing headers 在聚合和压缩后的保留。
- 已有 `Content-Encoding` 时跳过压缩。
- 小 body 低于阈值时跳过压缩。

### Bug / issue 候选检查

本轮未形成可单列 issue 的已证实源码缺陷：

- `MessageAggregator` 的 `currentMessage` 生命周期、close 时 release、handlerRemoved 时 release 当前是完整闭环，未观察到显著泄漏缺口。
- `HttpObjectAggregator.handleOversizedMessage` 的 request/response 分支虽然复杂，但都能从当前连接角色和协议责任推导出来，未发现相互冲突的行为证据。
- `HttpContentEncoder` 的状态切换、`encoder.finishAndReleaseAll()` 清理和 trailing headers 保留路径当前自洽，未发现明确的丢尾或重复释放证据。
- `determineEncoding()` 的优先级属于当前实现策略，不是直接可定性的错误；文中已按“当前实现顺序”表述，不上升为规范结论。

结论：本篇未发现需要单列 issue 候选的源码 bug。

## 第六轮：依赖审

### 前置依赖

- Ch11-01：对象流模型是本篇的硬前置，真实存在。
- Ch10-02：`MessageToByteEncoder` / codec 改写骨架是压缩节的硬前置，真实存在。
- Ch7 Pipeline：`writeAndFlush`、用户事件、handler 链位置是聚合/压缩节的硬前置，真实存在。
- Ch4 ByteBuf：CompositeByteBuf、retain/release 是聚合与压缩中引用计数和性能分析的硬前置，真实存在。

### 后续桥接

- 篇末桥到 timer/超时/keep-alive 层，只作为知识导航，没有使用未分析机制的既定结论。
- 没有把 `HttpContentDecompressor`、`ChunkedWriteHandler` 等未展开类的实现细节当前置事实。

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

删除全部 fenced code block 后，正文仍应保留：

- `MessageAggregator` 的三段聚合骨架
- `HttpObjectAggregator` 的 full-message 视图恢复
- 100/417/413 与 oversized 三路分支
- `HttpContentEncoder` 的三态与 full/streaming 双路径
- `HttpContentCompressor` 的 q 值协商与 `EmbeddedChannel` 子通道角色