# HTTP 聚合与压缩：对象流什么时候该收成完整消息，什么时候该继续流式改写

> 本文基于当前 Netty `MessageAggregator`、`HttpObjectAggregator`、`HttpContentEncoder`、`HttpContentCompressor` 与相关 HTTP full-message 实现。前置：Ch11 `01-codec-pipeline.md`、Ch10 Codec 两篇、Ch7 Pipeline、Ch4 ByteBuf；本文聚焦两个后处理问题：分块 HTTP 对象流如何收成 `FullHttpMessage`，以及响应如何根据 `Accept-Encoding` 协商后被压缩成新的内容流。不展开入站解压和大文件流式写出。

## 上一篇已经把 HTTP 变成对象流，这一篇要回答“什么时候别再一块一块往后传了”

上一篇把 HTTP codec 的第一层地基搭好了：

- `HttpObjectDecoder` 不直接产出一个完整 request/response。
- 它把请求行/响应行、headers、body chunk 和结束边界拆成对象序列。
- `HttpServerCodec` / `HttpClientCodec` 再补上方向组合和 HEAD/CONNECT 这些需要跨方向上下文的语义。

这时 pipeline 里向下游流动的东西，默认长这样：

```text
HttpRequest
  -> HttpContent
  -> HttpContent
  -> LastHttpContent
```

或者：

```text
HttpResponse
  -> HttpContent...
  -> LastHttpContent
```

这对流式处理很友好，但大多数业务 handler 真正想要的，经常不是“对象流”，而是下面两种更省心的视图之一：

```text
1. 给我一个完整的 FullHttpRequest / FullHttpResponse，body 我一次拿完
2. 让我继续处理对象流，但响应 body 自动按客户端 Accept-Encoding 压缩好
```

这两个需求看起来一个是“收”，一个是“改”；一个倾向聚合，一个倾向流式。

它们之所以值得单独做成 handler，而不是让业务层自己手搓，是因为两者都不只是“把数据拼一下”这么简单：

- 聚合要知道什么时候开始、什么时候结束、超限怎么拒绝、连接中断时半成品怎么回收。
- 压缩要知道这条响应该不该压、该用哪种算法、headers 怎么改、full response 和 streaming response 怎么分别处理。

所以这一篇真正要回答的是：

```text
HTTP 对象流什么时候该被收成一个完整消息？
什么时候又应该继续保留流式形态，但把每个内容块改写成压缩后的内容？
```

先把答案压成一句话：

```text
HttpObjectAggregator 建立在通用 MessageAggregator 骨架上，
负责把 start/content/last 收成 FullHttpMessage；
HttpContentCompressor 建立在 HttpContentEncoder 骨架上，
负责按 Accept-Encoding 协商结果把 HttpResponse/HttpContent 改写成新的压缩内容流。
```

所以这不是两个孤立的 HTTP 工具类，而是两条和 Ch10、Ch11-01 一脉相承的骨架：

- 聚合骨架：对象流 -> 完整消息
- 编码骨架：对象流 -> 改写后的对象流

## 一、为什么不能在业务 handler 里自己攒 body、自己 gzip

### 1. 失败方案一：业务 handler 自己缓存 `HttpContent`，等 `LastHttpContent` 再拼成完整 body

这是最自然的第一反应。

既然 pipeline 里已经拿到了：

```text
HttpRequest
HttpContent
HttpContent
LastHttpContent
```

那业务 handler 自己拿一个 `CompositeByteBuf` 或 byte array，把每块 body 存起来，等最后一块来了再统一处理，不也能做完聚合吗？

能做，但很快就会把本来该由骨架统一处理的边界重新拖回业务层：

- 哪种对象算 start，哪种算 content，哪种算结束。
- start message 本身如果已经自带一部分 content，该不该先并进去。
- 当前请求声明 `Expect: 100-continue` 时，要不要先回一个中间响应。
- `Content-Length` 一眼就超限时，是马上拒绝，还是先收一部分再报错。
- 连接中途关掉时，这个半成品聚合对象和其中的 `ByteBuf` 谁来 release。

也就是说，业务层看起来是在“拼 body”，实际上很快就不得不重写一条 start→aggregate→finish 状态机，还要顺手补错误恢复和资源回收。

这和上一章“不让业务 handler 自己重写 HTTP parser”是同一个道理：

```text
一旦某种状态机和生命周期边界会在所有 handler 里重复出现，
它就应该被收回框架层，而不是分散到业务逻辑里。
```

### 2. 失败方案二：先把 body 全收完，再根据大小决定回 413

另一个常见直觉是：

```text
反正业务迟早也得看完整 body，
那就先全收下来，等收完以后如果超了 1MB，再统一回 413。
```

问题在于，超限本来就是聚合层最需要尽早处理的场景。

如果先全收再拒绝：

- 一个 10MB、100MB 的 body 会先完整占住内存。
- 客户端明明在发送不被接受的请求，服务器却还在努力为它攒数据。
- 连接 keep-alive、`Expect: 100-continue`、autoRead 等行为都会变得尴尬。

当前 `HttpObjectAggregator` 的一个关键价值，就是把“过大消息不应流经业务 handler”这个原则提前落实到聚合层，而不是等业务层在最晚时刻才发现自己不该接这条消息。

### 3. 失败方案三：压缩直接在业务 handler 里手写 gzip，再自己改 headers

压缩也很容易被误当成一段简单后处理：

```text
body bytes -> gzip -> 设置 Content-Encoding: gzip -> write
```

问题在于真正的 HTTP 压缩并不只看“能不能压”：

- 客户端 `Accept-Encoding` 里可能有多种候选，还带 q 值优先级。
- 有些响应本来就没有 body，比如 HEAD、204、304，不能压。
- 已经带 `Content-Encoding` 的响应，不应再重复压一遍。
- full response 和 streaming response 的 header 改写策略不同。
- trailing headers 不能在压缩过程中被悄悄丢掉。

如果每个业务 handler 自己 `gzip(bytes)` 再手工改 header，整个 pipeline 很快就会出现一堆半正确实现：

- 有的忘了删 `Content-Length`
- 有的忘了改成 `Transfer-Encoding: chunked`
- 有的压了 HEAD 响应
- 有的把 trailing headers 吞了

所以压缩不是一个“函数调用”，而是一条 HTTP 对象流改写协议。

### 4. 失败方案四：既然压缩是 CPU 活，就扔进一个独立线程池慢慢做

这个直觉也很常见。

但如果只把“压缩”理解成一个异步任务，就会忽略最重要的一点：压缩不是孤立的一段 ByteBuf 计算，而是 HTTP response 对象流的一部分。

它要和当前 pipeline 的 headers、content chunks、last-content 边界严格对齐。把它简单扔给线程池，并不能自然解决：

- 哪一条请求的 `Accept-Encoding` 对应当前响应。
- 当前压缩后的 `HttpContent` 应该如何重新包装成对象并继续流经 pipeline。
- 压缩 encoder 自己的输出缓冲和结束 flush 何时完成。

这就是为什么当前实现选的不是线程池，而是 `EmbeddedChannel` 这种“内存内子通道”。它保留的是 pipeline/encoder 语义，而不是仅仅借一个工作线程。

## 二、`MessageAggregator`：聚合不是 HTTP 专属技巧，而是一条 start→aggregate→finish 骨架

先从 HTTP 之外往上看一层。

`HttpObjectAggregator` 本身并不是直接从零开始攒 body。它建立在一个更一般的骨架上：`MessageAggregator<I,S,C,O>`，见 `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:52`。

这说明“把一串对象收成一个大对象”并不是 HTTP 私货，而是一种可以复用的通用模式。

### 1. 这条骨架真正统一的，不是数据格式，而是对象流的三段结构

`MessageAggregator` 假定一条可聚合消息由三类对象构成：

```text
start message
  +
0 或更多 content messages
  +
最后一个 last-content message
```

它不关心 start 是 HTTP request、WebSocket frame 还是别的自定义消息；也不关心 content 里到底是文本还是二进制。它统一关心的是：

- 当前对象是不是一条新消息的开始。
- 当前对象是不是中间内容。
- 当前对象是不是最后一个内容对象。
- 如果我已经聚合出完整对象，后续应该何时把它向下游 fire。

所以这条骨架的本质是：

```text
把“一个对象序列”提升成“一个有开始、有中间、有结束的聚合生命周期”。
```

### 2. `acceptInboundMessage()` 先用 aggregating 状态把对象流切成“当前这条消息还归不归我管”

`MessageAggregator.acceptInboundMessage(...)` 的判断非常关键，见 `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:91`。

它的规则可以压成：

- 如果对象已经是 aggregated 结果，就放过，不再二次聚合。
- 如果是 start message，总是接受。
- 如果是 content message，只有当前 `aggregating == true` 时才接受。

这等于在 pipeline 入口就把一堆看似平铺的对象重新切成一条条聚合会话：

```text
start 来了 -> 进入 aggregating
content 来了 -> 继续并进当前消息
last 来了 -> 完成当前聚合并退出 aggregating
```

这一步特别重要，因为它让“当前这块 body 属于谁”这个问题有了框架层答案，而不是让业务 handler 自己猜。

### 3. `decode()` 里的 start 分支，才是聚合真正开始的地方

真正的主线在 `MessageAggregator.decode(...)`，见 `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:205`。

如果当前对象是 start message，它会：

- 进入 `aggregating = true`
- 清掉 oversize 处理标记
- 如果 `currentMessage` 不为空，说明内部状态不一致，释放旧对象后抛异常
- 根据需要先处理 `100-continue` 等 continue response
- 检查已知的 `Content-Length` 是否一眼超限
- 如果都通过，再创建 `CompositeByteBuf` 作为累计内容
- 调用 `beginAggregation(...)` 生成聚合结果对象壳子

这里最值得抓的一点是：聚合开始时，框架并不是简单 new 一个 list 把 chunks 放进去，而是先把所有会影响这条消息命运的边界都看一遍：

```text
要不要先回 continue
content-length 是否已经注定超限
start message 自己是不是已经带了错误 decoderResult
```

也就是说，start 分支不是“先收着再说”，而是这条消息正式进入聚合生命周期前的关口。

### 4. 中间 content 到来时，骨架真正做的是“累内容 + 转移附加信息 + 判断是否收尾”

当对象是 content message 时，当前实现会：

- 拿到 `currentMessage.content()` 里的 `CompositeByteBuf`
- 检查继续并入这块 content 后是否会超过 `maxContentLength`
- 把当前 content 的 `ByteBuf` retain 后追加进去
- 调用子类 `aggregate(...)` 转移附加信息
- 判断当前 content 是否 last
- 如果是最后一块，调用 `finishAggregation0(...)` 并把 `currentMessage` 输出给下游

见 `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:271`。

这里真正关键的是 `aggregate(...)` 这个钩子。因为内容本身已经统一并进 `CompositeByteBuf`，子类需要补的往往是“body 之外但依附在 content 上的信息”，比如 HTTP 的 trailing headers。

所以骨架的分工非常清楚：

```text
父类统一并内容
子类补语义尾料
最后一块到来时统一收尾
```

### 5. `CompositeByteBuf` 和 `maxCumulationBufferComponents` 说明聚合不是“永远零拷贝”

当前累计内容默认放进 `CompositeByteBuf`，见 `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:266`。它允许多块 body 内容先以多个组件的方式拼在一起，避免每来一块就整体拷贝一次。

但这并不等于“聚合从此零成本”。类里还维护了 `maxCumulationBufferComponents`，默认 1024，超过后会 consolidate 成单组件，见 `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:55` 与 `:158`。

这说明聚合在性能上的真实取舍是：

```text
先尽量以组合视图攒 body，减少前期复制；
但组件数太多时，还是要用一次整合换后续访问复杂度。
```

所以“用了 CompositeByteBuf”并不意味着聚合没有内存和复制代价，只是它把代价延后并集中管理了。

### 6. 连接关闭和 handler 移除时，半成品聚合对象必须被框架回收

聚合最容易出事的地方，其实不是正常 finish，而是“没 finish 就结束了”。

当前实现有两层保护：

- `channelInactive()` 时，如果还在 aggregating，默认抛 `PrematureChannelClosureException`，然后释放 `currentMessage`，见 `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:430`
- `handlerRemoved()` 时也会无条件 `releaseCurrentMessage()`，见 `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:450`

这两条边界非常重要，因为聚合层手里持有的是一个累计中的 `CompositeByteBuf`。如果连接断了或 handler 被移除而不回收，它就不是“业务没收到完整消息”这么简单，而是内存生命周期直接悬空。

## 三、`HttpObjectAggregator`：HTTP 聚合的真正工作，不是“拼 body”，而是把 HTTP 对象流恢复成 `FullHttpMessage`

有了 `MessageAggregator` 的通用骨架，再看 `HttpObjectAggregator` 会清晰很多。

它当前声明为：

```text
MessageAggregator<HttpObject, HttpMessage, HttpContent, FullHttpMessage>
```

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:86`。

这行泛型本身就已经把 HTTP 聚合的角色写清楚了：

- 输入总类型：`HttpObject`
- start：`HttpMessage`
- content：`HttpContent`
- 输出：`FullHttpMessage`

### 1. HTTP 聚合器其实并没有什么神秘判断：start 是 `HttpMessage`，content 是 `HttpContent`，last 是 `LastHttpContent`

当前实现把四个抽象判断落得很直接：

- `isStartMessage`：`msg instanceof HttpMessage`
- `isContentMessage`：`msg instanceof HttpContent`
- `isLastContentMessage`：`msg instanceof LastHttpContent`
- `isAggregated`：`msg instanceof FullHttpMessage`

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:132`。

这说明上一篇建立的对象模型并不是文档层抽象，而是当前聚合器真正依赖的协议边界。

换句话说：

```text
正因为 HTTP codec 先把头、内容块和最后一块拆成了不同对象，
聚合器现在才能用这三个类型边界干净地重建完整消息。
```

### 2. `beginAggregation()` 不是只造一个空壳，它顺手把 chunked 语义从外显传输形式变回完整消息视图

`beginAggregation(...)` 一上来就 `HttpUtil.setTransferEncodingChunked(start, false)`，然后根据 start 是 request 还是 response，创建 `AggregatedFullHttpRequest` 或 `AggregatedFullHttpResponse`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:204`。

这一步的真正意义，不只是选个子类，而是：

```text
从现在开始，下游看到的将不再是“一个靠 chunked/多个 HttpContent 表达的消息”，
而是一条准备被还原成完整 body 的 full message 视图。
```

也就是说，聚合器一旦接管当前对象流，它已经在把“分块传输方式”往“完整业务消息”这个方向重写。

### 3. `aggregate()` 对 HTTP 来说最重要的，不是 body，而是 trailing headers

body 内容已经由父类统一并进 `CompositeByteBuf`。`HttpObjectAggregator.aggregate(...)` 真正做的额外动作很少：如果当前 content 是 `LastHttpContent`，就把它的 trailing headers 合并进聚合结果，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:219`。

这一步值得单独强调，因为很多人一说“聚合”只想到 body bytes。当前 HTTP 实现明确告诉你：

```text
一条完整 HTTP 消息不只包括完整 body，
还包括最后一块上可能出现的 trailing headers。
```

如果聚合器只拼 body，不搬 trailing headers，那么下游拿到的 `FullHttpRequest` / `FullHttpResponse` 就不是完整语义。

### 4. `finishAggregation()` 补 `Content-Length`，是因为 full message 视图已经不再需要靠 chunked 来表达 body 边界

聚合完成时，当前实现如果还没有 `Content-Length`，就按聚合后 body 的 `readableBytes()` 补上它，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:227`。

源码注释特别提醒了一个容易误判的场景：HEAD response 里的 `Content-Length` 可能描述“如果用 GET 会传多少字节”，而不是实际线上已经发送的 body 长度。

这条注释说明 `finishAggregation()` 补长不是随便修 header，而是在把“对象流边界”重新收束成“完整消息边界”：

```text
既然现在下游将看到的是一个完整 full message，
那这条消息的 body 长度就应该能被当前 content 直接描述。
```

### 5. `FullHttpRequest` 和 `HttpRequest + HttpContent` 的差异，不只是“一个对象 vs 多个对象”

这正好回答完整性问题 #3。

`HttpRequest + HttpContent` 模型意味着：

- 业务 handler 可以边收边处理 body
- body 生命周期分块发生
- 你要自己识别何时结束、何时有 trailing headers
- 内存更省，更适合流式场景

`FullHttpRequest` 模型意味着：

- 头、完整 body、trailing headers 全部已经收齐
- 业务逻辑可以直接读 `request.content()`
- 不需要自己管理 chunk 序列
- 但聚合层已经承担了把完整 body 保存在内存中的代价

所以区别不只是接口形式不同，而是两种完全不同的消费方式：

```text
分块模型：把 HTTP 当成流
完整模型：把 HTTP 当成一次性对象
```

聚合器的价值，就是在需要的时候帮你从前者切到后者。

## 四、Expect 与超限：`handleOversizedMessage` 为什么不能统一一刀切

HTTP 聚合里最容易被讲成“细节”的，恰恰是最体现协议语义的部分：

- `Expect: 100-continue`
- body 超限
- request 和 response 的处理差异

如果这里只说“超大就抛异常”，那整条 handler 的设计味道会被直接抹平。

### 1. `newContinueResponse()` 先于真正聚合发生，因为它决定客户端应不应该继续发 body

`MessageAggregator.decode()` 的 start 分支里，在检查 content length 之前，会先调用 `newContinueResponse(...)`，见 `codec-base/src/main/java/io/netty/handler/codec/MessageAggregator.java:221`。

`HttpObjectAggregator.newContinueResponse(...)` 最终走到 `continueResponse(...)`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:161`。

它有三种可能：

- 不支持的 expectation -> 417 Expectation Failed
- `100-continue` 且 content-length 未超限 -> 100 Continue
- `100-continue` 但 content-length 已超限 -> 413 Request Entity Too Large

这三种响应为什么必须在聚合前先发？因为它们本来就是在回答客户端：

```text
你接下来该不该继续把 body 发给我？
```

如果等 body 都发完了再说，那 `100-continue` 协议点就失去意义了。

### 2. 不是所有 413 都要立刻 close，也不是所有场景都能继续 keep-alive

`HttpObjectAggregator.handleOversizedMessage(...)` 对 request 的处理分支并不单一，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:242`。

当前逻辑会综合考虑：

- 这是不是一个已经 full 的 request
- channel 是否 autoRead
- 当前是否带 `Expect: 100-continue`
- 当前连接是否 keep-alive

然后决定：

- 返回 `TOO_LARGE_CLOSE` 并在写完后 close
- 或者只返回 `TOO_LARGE`，让连接保持打开，并继续消费后续无效内容直到下一请求

这说明“body 超限”在 HTTP 里并不是一个完全独立的业务错误码，而是和连接生命周期绑在一起的传输决策。

如果客户端已经开始发送内容、或者当前连接状态让服务端不可能安全恢复到“读下一条请求”的边界，那 close 才是更稳的选择。

### 3. response 超限为什么和 request 超限完全不是同一件事

对于 oversized response，当前实现直接 `ctx.close()` 并抛 `TooLongHttpContentException`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:266`。

这和 request 的细分路径明显不同。

原因很简单：

```text
request 超限时，当前 handler 还扮演服务端，可选择如何回给客户端一个 HTTP 错误响应；
response 超限时，当前 handler 已经站在“客户端接收服务器响应”的位置，
它没有一个对等的“自动回错误响应给上游服务端”语义，只能认定当前连接已经不可继续信赖。
```

这就是完整性问题 #6 的核心：三路分支不是啰嗦，而是 request-side 与 response-side 责任根本不同。

### 4. `closeOnExpectationFailed` 进一步把协议语义下放成可配置策略

当前构造器还支持 `closeOnExpectationFailed`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpObjectAggregator.java:106`。

如果 `100-continue` 被判断为应失败，当前 handler 可以选择：

- 返回失败响应后直接关闭连接
- 或者保持连接打开，但忽略当前 request 后续内容直到下一请求

这说明 Netty 在这里没有把一种产品策略写死，而是把“失败 expectation 后这条连接还值不值得继续复用”暴露成配置选择。

## 五、`HttpContentEncoder` / `HttpContentCompressor`：压缩不是一次函数调用，而是一条流式改写状态机

现在切到压缩。

很多人第一次看 `HttpContentCompressor`，会以为主要逻辑都写在这个类里：挑算法、压字节、写出去。

其实当前实现的真正骨架在它的父类 `HttpContentEncoder`。

### 1. `HttpContentEncoder` 管的不是“怎么压”，而是“HTTP 对象流如何被改写”

`HttpContentEncoder` 是 `MessageToMessageCodec<HttpRequest, HttpObject>`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:57`。

这行泛型本身就暴露了它的角色：

- 入站 decode 方向接收 `HttpRequest`
- 出站 encode 方向改写 `HttpObject`

为什么压缩一个出站 response 还要关心入站 request？因为压缩算法要看客户端的 `Accept-Encoding`。

所以它会在 decode 阶段把当前请求的 `Accept-Encoding` 取出来，必要时对 HEAD/CONNECT 做特殊标记，再放进 `acceptEncodingQueue`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:82`。

这条队列的含义和上一篇 `HttpClientCodec` 的 method queue 十分相似：

```text
当前要写出去的响应，未来应该参考哪条请求带来的协商上下文。
```

### 2. 压缩主线实际上是一个三态机：`AWAIT_HEADERS -> AWAIT_CONTENT / PASS_THROUGH`

`HttpContentEncoder` 当前有三个状态：

- `AWAIT_HEADERS`
- `AWAIT_CONTENT`
- `PASS_THROUGH`

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:59`。

它们的意义可以先压成：

```text
AWAIT_HEADERS
  -> 正在等一条新 response 的 headers，决定这条响应是否进入压缩流

AWAIT_CONTENT
  -> 这条响应已经决定要压，后续 HttpContent 需要逐块送进 encoder

PASS_THROUGH
  -> 这条响应不压，后续 HttpContent 原样透传
```

这非常重要，因为它说明压缩并不是对某个对象调用一次 `compress()` 就结束，而是要先为“这一整条响应”做一次决策，然后让后续 chunks 继续遵守这个决策。

### 3. 为什么 full response 和 streaming response 要走不同改写路径

在 `AWAIT_HEADERS` 状态，当前实现先区分是否 full response：

```text
HttpResponse && LastHttpContent
```

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:110`。

如果是 full response：

- 先把 headers 改写成新的 `HttpResponse`
- 再调用 `encodeFullResponse(...)`
- 压完后，如果原来就带 `Content-Length`，就重新计算压缩后的长度；否则改成 chunked

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:184`。

如果是 streaming response：

- 先去掉旧 `Content-Length`
- 改成 `Transfer-Encoding: chunked`
- 进入 `AWAIT_CONTENT`
- 后续每个 `HttpContent` 逐块送入 encoder

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:193`。

这背后的原因不是实现风格，而是 HTTP 边界事实不同：

```text
full response：我已经能看到完整 body，因此可以事后回填精确 Content-Length
streaming response：body 还在陆续到达，只能把线上表示切换成 chunked 以便边压边发
```

### 4. trailing headers 不能在压缩完成时被吃掉

`encodeContent(...)` 在处理 `LastHttpContent` 时，除了 `finishEncode(out)`，还会保留 trailing headers：

- 如果 trailing headers 为空，补一个 `EMPTY_LAST_CONTENT`
- 否则构造 `ComposedLastHttpContent(headers, DecoderResult.SUCCESS)`

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:271` 与 `ComposedLastHttpContent.java:23`。

这一步再次证明：

```text
压缩器改写的是 body 字节，
不是删除 HTTP 对象流的结束语义。
```

也就是说，就算 body 内容已经被新算法重新编码，最后那块“这条响应到此结束，还有哪些 trailing headers”仍然必须保留下来。

## 六、`HttpContentCompressor`：真正属于它自己的，是 Accept-Encoding 协商和“该选哪条压缩子通道”

有了 `HttpContentEncoder` 这条骨架，再看 `HttpContentCompressor`，它的职责就聚焦很多了。

### 1. `beginEncode()` 真正回答的是：这条响应要不要压、压成什么、由谁压

`HttpContentCompressor.beginEncode(...)` 一上来先做几道过滤：

- 如果 `contentSizeThreshold > 0`，且当前 `HttpContent` 太小，就不压
- 如果 response 已经有 `Content-Encoding`，不重复压
- 再根据 `Accept-Encoding` 算出目标编码

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentCompressor.java:252`。

这说明压缩决策不是“只要客户端接受 gzip 就压”，而至少还要考虑：

```text
这条响应有没有内容值得压
它是不是已经被别处编码过
当前客户端到底接受哪些编码
```

如果其中任何一条不满足，`beginEncode()` 返回 null，父类状态机会自动把这一整条响应切到 `PASS_THROUGH`。

### 2. `Accept-Encoding` 协商不是简单 contains，而是 q 值 + 本地可用算法 + 通配符后备

`determineEncoding(...)` 当前会解析：

- `br`
- `zstd`
- `snappy`
- `gzip`
- `deflate`
- `*`

并分别记录 q 值，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentCompressor.java:329`。

最终选择逻辑不是“先找到谁就用谁”，而是：

- 优先比较显式声明且 q>0 的候选
- 在当前本地已配置/可用的算法之间按 q 值和固定优先级选一个
- 如果显式候选都不合适，再看 `*`

在当前实现里，显式候选的比较顺序体现为：

```text
br >= zstd >= snappy >= gzip >= deflate
```

前提是对应 options 已配置、算法可用。

所以完整性问题 #4 的真正答案不是“默认优先 gzip”，而是：

```text
先看客户端给出的 q 值；
再看本地是否配置/支持该算法；
若多个都可选，按当前实现里的比较顺序选中一个；
若显式候选没有合适值，再用 `*` 当后备。
```

### 3. 为什么 `EmbeddedChannel` 才是当前实现要的“压缩执行容器”

一旦目标编码选定，`HttpContentCompressor` 会返回一个 `Result`，其中最关键的是：

```text
EmbeddedChannel.builder().handlers(createEncoderFor(targetContentEncoding)).build()
```

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentCompressor.java:272`。

这里最容易被误解成“只是把压缩器包起来”。其实 `EmbeddedChannel` 解决的是一个更核心的问题：

```text
Netty 已经有一整套 ByteBuf -> ByteBuf 的 encoder 生态，
压缩器本身也是 MessageToByteEncoder<ByteBuf>；
那最自然的复用方式，不是重写一套压缩控制流，
而是开一个不绑网络的内存内 Channel，
把现成 encoder 放进去，让它像真实 pipeline 一样工作。
```

因此它不是线程池，也不是异步任务框架，而是一个“虚拟子通道”：

- 没有真实 socket
- 没有真实 I/O
- 但有完整的 encoder 生命周期和出站缓存语义

父类后续做的，只是：

- `encoder.writeOutbound(in.retain())`
- 反复 `readOutbound()` 取压好的 `ByteBuf`
- 包成新的 `DefaultHttpContent` 往外发

见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentEncoder.java:339`。

这就是完整性问题 #7 的答案：不用独立线程，是因为当前任务不是“把 CPU 活异步化”，而是“把已有压缩 encoder 嵌回 HTTP 对象流改写链”。`EmbeddedChannel` 恰好复用了最需要的那部分语义。

### 4. `contentSizeThreshold` 的意义：压缩是一种有收益门槛的改写，不是默认越多越好

`contentSizeThreshold` 当前直接挡在 `beginEncode()` 最前面。小于阈值就返回 null，不压，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpContentCompressor.java:252`。

这说明当前实现明确承认：

```text
压缩不是无脑正收益；
对于很小的 body，压缩头、状态初始化和 CPU 开销可能比节省的字节还更不划算。
```

它并不尝试在这个类里做“按 content-type 判断是否本来就已压缩”之类更高层策略；当前 handler 只在它有足够证据的地方先做了一个大小阈值剪枝。

## 七、误解澄清：聚合和压缩都不是“为了方便业务写起来更短”这么简单

### 误解一：`HttpObjectAggregator` 就是把几个对象装进一个 `FullHttpRequest`

不止。

它同时统一了：

- start/content/last 生命周期
- `100/417/413` 的自动响应
- 超限提前拒绝
- trailing headers 合并
- 连接关闭时半成品回收

如果只把它理解成“把 body 拼一下”，就会把最重要的协议边界全漏掉。

### 误解二：`FullHttpRequest` 比分块模型“更高级”

不是。

它只是更适合某类业务处理方式。流式上传、代理转发、大 body 背压等场景下，分块模型反而更接近底层真实需求。

### 误解三：超限时总是统一回 413 就够了

当前实现明确不是这样。

request-side 会结合 `Expect`、keep-alive、autoRead 和当前是否已经 full 决定是否 close；response-side 则直接 close + 异常。这两类责任根本不同。

### 误解四：`HttpContentCompressor` 是“找到 gzip 就压 gzip”

也不是。

它先过滤，再协商 q 值，再看本地是否配置可用，最后才决定目标编码。

### 误解五：`EmbeddedChannel` 是开了个子线程做压缩

不是。

它是一个内存内子通道，用来复用现成 encoder pipeline 语义，没有真实网络 I/O，也不是把压缩任务扔进线程池。

## 八、收网：聚合负责把对象流收成完整消息，压缩负责把对象流改写成另一条内容流

现在把本篇和上一篇一起收起来。

上一篇解决的是：

```text
HTTP 字节流 -> HttpMessage + HttpContent + LastHttpContent
```

这一篇解决的是这条对象流后面最常见的两种继续加工方式：

```text
对象流 -> FullHttpMessage
对象流 -> 压缩后的 HttpResponse + HttpContent 流
```

`HttpObjectAggregator` 选择第一条路。它的任务是：

- 识别 start/content/last
- 把 body 累进 `CompositeByteBuf`
- 合并 trailing headers
- 处理 `Expect` 和 oversized 边界
- 最后交给下游一个 `FullHttpRequest` 或 `FullHttpResponse`

`HttpContentCompressor` 选择第二条路。它的任务是：

- 根据请求上下文拿到 `Accept-Encoding`
- 决定这条响应要不要压、压成什么
- 用 `EmbeddedChannel` 承接真正的压缩 encoder
- 改写 headers、content chunks 和 last-content 边界

所以这篇真正该带走的话是：

```text
聚合不是“为了少处理几个对象”，
而是把一条 HTTP 对象流重新收束成一个完整消息视图。

压缩也不是“对 body 做一次函数变换”，
而是把整条 HTTP 响应对象流按协商结果改写成另一条内容流。
```

走到这里，HTTP 在 Netty 里的地基就已经基本完整了：

- Codec 负责把字节变成对象流
- Aggregator 负责把对象流收成完整消息
- Compressor 负责把对象流改写成新的编码内容

再往后，业务层开始真正关心的就不再是“HTTP 对象怎么拼和怎么压”，而会逐渐变成“连接多久保活、空闲多久超时、重试多久退避、任务多久触发”这类时间问题。那时再往下走，就自然会碰到 Netty 的 timer 体系。