# HTTP/2 编解码：一条 TCP 连接上为什么能同时交错跑很多请求

> 本文基于当前 Netty HTTP/2 核心实现：`DefaultHttp2FrameReader`、`DefaultHttp2Connection`、`HpackStaticTable`、`HpackEncoder`、`HpackDecoder`、`DefaultHttp2LocalFlowController`、`DefaultHttp2RemoteFlowController`。前置：Ch11 HTTP 两篇、Ch10 Codec、Ch7 Pipeline；本文聚焦 HTTP/2 的四层骨架：二进制帧、Stream 多路复用、HPACK 头压缩、双层流控，并建立到 gRPC / Dubbo Triple 的传输桥接。

## HTTP/1.1 真正卡住的，不只是文本格式，而是“连接”和“请求”被绑在了一起

如果只看 HTTP/1.1 的表面问题，很多人会把焦点放在“文本协议解析慢”。

这当然有一部分道理：

- 要逐字符找 `\r\n`
- 要切请求行、状态行、headers
- body 的边界也依赖 header 决定

但 HTTP/1.1 真正把后续协议生态逼到升级点上的，不只是文本解析，而是一个更结构性的限制：

```text
一条连接上的请求/响应关系，本质上还是一条线性队列。
```

你可以开很多连接并发，但单条连接里，请求和响应仍然天然排在一条时间线上。某个请求慢了，后面的复用收益就会被拖住；于是浏览器常见的做法是多开连接，结果又把连接数、握手、缓冲和资源竞争全推高。

所以 HTTP/2 要解决的问题，不是“把 GET / HTTP/1.1 改写成几个二进制字段”这么浅，而是：

```text
能不能把“请求”从“连接”上拆下来，
让同一条 TCP 连接同时承载很多彼此隔离的请求/响应生命周期？
```

这就是 HTTP/2 真正的起点。

它并没有把连接废掉，而是把连接变成一个更低层的承载面：

- 连接上流动的不再是整段 HTTP 文本报文
- 而是一帧一帧带 `streamId` 的二进制 frame
- 真正的“第几个请求、哪条响应属于谁、哪条流什么时候结束”，都挂在 Stream 上

所以本篇最重要的一句话可以先立起来：

```text
HTTP/2 的核心不是二进制本身，
而是把“连接”和“请求”拆成了两层：
连接上只负责传 frame，
请求/响应语义则挂在独立的 Stream 上。
```

一旦这句话立住，后面那四块看似分散的机制就能自然串起来：

- 帧头里的 `streamId` 负责最小路由
- `DefaultHttp2Connection` 负责维护每条 Stream 的状态
- HPACK 负责在同一条连接上复用 header 上下文
- 流控负责在连接级和 stream 级分别加反压

## 一、如果只是把 HTTP/1.1 文本改成二进制字段，很多问题根本没动

### 1. 失败方案一：只把文本报文格式压成二进制头部

最容易想到的“升级”是：

```text
请求行和 headers 不再用字符串，
而是换成定长字段或更容易解析的二进制块。
```

这么做的确能让 parser 简化一些。但如果请求和连接的关系仍然是“一条连接一次只完整服务一条请求/响应线”，那你只是把语法换了，没把结构换掉。

换句话说：

- 你会更快地解析一条请求
- 但这条连接上仍然没有“多个独立请求上下文同时并存”的能力

所以二进制不是 HTTP/2 的目的，而只是后面那套多路复用状态机更容易实现的前提。

### 2. 失败方案二：一条连接上还是只允许一个活动请求

第二条路更接近很多人对“连接复用”的直觉：

```text
还是一条连接，但我把每个请求做快一点，
然后严格按先后顺序一个一个处理。
```

这个方案对轻量请求也许还能凑合，但只要其中一个响应慢、body 大、或者消费方背压明显，后面的请求还是会排队。

所以 HTTP/2 真正要的不是“一个更快的顺序管道”，而是：

```text
在同一条连接里，
允许很多请求/响应的 frame 交错出现，
同时又不把彼此的状态搞混。
```

这就要求每个 frame 都得带一个最小可路由的身份标记，而这个标记就是 `streamId`。

### 3. 失败方案三：只做连接级窗口，不做每个 Stream 的窗口

如果你已经接受“一条连接上多条 Stream 并发”，又很容易继续掉进第三个简化陷阱：

```text
反正最终都是走同一条 TCP 连接，
那只要给整条连接一个总窗口，不让总量失控，不就行了吗？
```

问题在于，这样做只能限制“总发送量”，却无法限制“某一条流是不是独占了全部窗口”。

如果一条大响应一直狂发，而另一条小但高优先级的流也在同一连接上等待，总窗口并不能阻止前者把连接级额度全吃掉。

所以 HTTP/2 的流控必须分成两层：

```text
连接级窗口：限制整条连接的总在途数据
流级窗口：限制每条 Stream 各自能占多少额度
```

这也正是为什么后面的 `DefaultHttp2RemoteFlowController.isWritable(stream)` 不是只看连接窗口，而是双条件同时判断。

## 二、二进制帧总图：9 字节帧头不是样板，它就是多路复用的最小路由层

先从 frame 层看 HTTP/2。

当前标准帧类型常量定义在 `Http2FrameTypes`，包括：

- `DATA`
- `HEADERS`
- `PRIORITY`
- `RST_STREAM`
- `SETTINGS`
- `PUSH_PROMISE`
- `PING`
- `GO_AWAY`
- `WINDOW_UPDATE`
- `CONTINUATION`

见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameTypes.java:21`。

但比“有哪些帧”更重要的是：所有这些帧在进入语义解析前，都先共享同一个 9 字节头。

### 1. 9 字节头到底装了什么

`DefaultHttp2FrameReader.preProcessFrame(...)` 里，当前实现按顺序读：

- 3 字节 `payloadLength`
- 1 字节 `frameType`
- 1 字节 `flags`
- 4 字节 `streamId`

见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:188`。

可以把它压成：

```text
0-2 byte   : length (24bit)
3   byte   : type
4   byte   : flags
5-8 byte   : streamId
```

所以完整性问题 #1 的答案里，“streamId 在哪”可以直接说：它位于帧头最后 4 字节，也就是第 6-9 个字节位点（按 1-based 计数）。

这一点并不是字段说明书层面的 trivia，而是多路复用的真正起点。因为从 parser 的角度看，HTTP/2 连接上所有 frame 在刚到手时都只是字节块；是谁把它们重新分拣回不同请求上下文？答案不是“先看 HEADERS/DATA”，而是先看 `streamId`。

### 2. `readFrame()` 主线：先统一读头，再按 type 进分支

`DefaultHttp2FrameReader.readFrame(...)` 的主线很清楚：

- 如果还在读头，就先 `preProcessFrame(...)`
- 头一旦完整，再 `verifyFrameState()`
- 然后 `processPayloadState(...)`

见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:147`。

这说明 HTTP/2 reader 的组织方式不是“先猜当前是 HEADERS 还是 DATA”，而是：

```text
所有帧先统一经过同一个 framing 层；
framing 层把长度、类型、flags、streamId 抽出来以后，
再决定 payload 该走哪一条语义路径。
```

相比 HTTP/1.1 文本报文那种“边解析边推断边界”的风格，这里的层次明显更硬：

- framing 先把壳切出来
- type-specific parser 再看内容

这就是完整性问题 #10 的核心：二进制更快不只是“CPU 喜欢数字”，而是协议先给了 parser 一个更稳定、定长、可直接寻址的外壳。

### 3. `verifyFrameState()`：有些错误不是 payload 错，而是 frame 此刻根本不该出现

读完头以后，当前实现并不立刻读 payload，而是先 `verifyFrameState()`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:207`。

这一步会根据 `frameType` 校验：

- 这个帧是不是必须关联某个 stream
- payload 长度是不是合法
- 当前是不是正在处理中间的 headers continuation
- 某些控制帧是不是必须跑在连接级 stream 0 上

这说明 HTTP/2 的帧语义比 HTTP/1.1 文本行更显式，但也更严格：

```text
不是“只要字段能读出来就算一个合法帧”，
而是帧类型、长度、streamId 和当前解析上下文必须同时匹配。
```

比如 `SETTINGS` 必须在 stream 0 上，`PING` 长度必须等于 8，`CONTINUATION` 必须接在一个尚未完成的头块之后。当前 reader 都在统一入口把这些状态约束兜了起来。

### 4. HEADERS 和 DATA 的 parser 之所以能交错工作，靠的不是“记住顺序”，而是 `streamId`

读 payload 分发的入口在 `processPayloadState(...)`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:246`。

这里最重要的认知是：

```text
HTTP/2 不要求同一连接上先完整读完 stream 1 的所有东西，
再开始 stream 3；
它允许 HEADERS(1)、HEADERS(3)、DATA(1)、DATA(5) 这样交错出现。
```

而 parser 仍然能知道该把哪个回调交给哪条请求上下文，靠的不是“连接上请求先后顺序”，而是每一帧头里的 `streamId`。

这就是完整性问题 #5 的主线答案：`DefaultHttp2FrameReader` 先从 9 字节头读出长度、类型、flags、streamId，再根据 type 进入 `readHeadersFrame`、`readDataFrame`、`readSettingsFrame` 等分支；其中 `streamId` 是把 frame 重新挂回某条 Stream 的关键路由键。

## 三、Stream 多路复用：连接上交错的是 frame，请求/响应状态则被保存到 Stream 里

帧头只负责把字节重新分路，但真正让 HTTP/2“像很多条独立请求同时跑”成立的，是连接对象对 Stream 生命周期的管理。

### 1. `DefaultHttp2Connection` 的真正职责，不是保存 socket，而是保存“这条连接上有哪些 Stream 还活着”

`DefaultHttp2Connection` 里最关键的结构之一是：

- `streamMap`
- `activeStreams`
- `localEndpoint`
- `remoteEndpoint`

见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:63`。

这几样东西一起表达的是：

```text
一条 HTTP/2 连接不再只有“连接本身”的状态；
它还要同时维护很多条 Stream 的状态集合。
```

这也是为什么上一篇 HTTP/1.1 的 `HttpRequest` / `HttpContent` 模型，到了这里还不够。HTTP/2 先把数据切成 frame，再把这些 frame 重新归档到 Stream 上；“一个请求”在这里不再天然等于“连接上当前唯一的活动消息”。

### 2. 奇偶 streamId 不是小规定，而是双方各自的命名空间

`DefaultEndpoint` 初始化时：

- server 侧 `nextStreamIdToCreate = 2`
- client 侧 `nextStreamIdToCreate = 1`

见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:731`。

同时 `isValidStreamId(streamId)` 用奇偶性和 endpoint 角色共同判断当前 id 是否归自己，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:761`。

所以完整性问题 #2 的答案很明确：

```text
客户端主动创建的 Stream 用奇数 ID；
服务端主动创建的 Stream 用偶数 ID；
0 保留给连接级控制。
```

为什么要这样设计？因为一条 TCP 连接两端都可能主动发起新的 Stream。如果没有奇偶分治，两端就得先全局协商“下一个可用 streamId 归谁”，否则编号空间会互撞。

有了奇偶划分后，双方各自的命名空间天然隔离：

- client 只增长奇数
- server 只增长偶数

这样 streamId 不只是唯一标识，更是“这条 Stream 最初由谁发起”的来源标记。

### 3. `createStream()` 真正做的，是把一个 ID 变成一条有状态生命周期的 Stream

`DefaultEndpoint.createStream(...)` 会：

- 根据是否 halfClosed 计算初始状态
- 校验这个 streamId 是否允许新建
- 创建 `DefaultStream`
- 更新下一个期望 streamId
- 加入 `streamMap`
- 再 `activate()` 进入活跃集合

见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:776`。

这里最重要的一点是：`streamId` 本身只是编号，真正的请求/响应生命周期存在 `DefaultStream.state` 里，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:381`。

状态可能是：

- `IDLE`
- `OPEN`
- `HALF_CLOSED_LOCAL`
- `HALF_CLOSED_REMOTE`
- `CLOSED`
- 以及 reserved 状态

这意味着 HTTP/2 里“一个请求还活着吗”不再靠连接推断，而是每条 Stream 自己说了算。

### 4. 多路复用真正解决了哪一层队头阻塞，又没解决哪一层

有了很多独立 Stream 之后，同一条连接上的 frame 可以交错：

```text
HEADERS stream 1
HEADERS stream 3
DATA    stream 1
HEADERS stream 5
DATA    stream 3
...
```

所以在应用层语义上：

- stream 1 慢，不必阻塞 stream 3 的头先被发送
- stream 5 可以后发起但先拿到一部分带宽
- 某条流被 `RST_STREAM` 取消，也不必把整条连接上的所有请求一起干掉

这就是完整性问题 #6 的前半句：HTTP/2 的 streamId 多路复用确实缓解了 HTTP/1.1 那种“连接级请求顺序捆绑”带来的应用层队头阻塞。

但 TCP 层队头阻塞仍然存在。因为这些 frame 最终还是按字节序进同一条 TCP 连接；底层某个包丢了，需要重传时，后面的字节在 TCP 视角依然得等它补齐。

所以要把边界说清：

```text
HTTP/2 解决的是应用层/请求层的队头阻塞；
TCP 传输层的 HOL 仍然在，直到 QUIC/HTTP/3 才从传输层层面改变这一点。
```

### 5. gRPC 在 HTTP/2 上为什么能天然跑并发 RPC

到这里可以顺手回答完整性问题 #11 的桥接部分。

一个 gRPC 请求在 HTTP/2 上，本质上就是一条 Stream：

- 元数据走 `HEADERS`
- 消息体走 `DATA`
- 流结束靠 `END_STREAM` flag

所以 gRPC 不是“绕开 HTTP/2 自己发包”，而是把 RPC 语义建立在 HTTP/2 已经提供好的 frame + stream 模型之上。这也是为什么本篇被放成 gRPC 和 Dubbo Triple 的桥接地基，而不是独立的协议旁枝。

## 四、HPACK：61 项静态表 + 连接级动态表，不是在“压字符串”，而是在复用连接上的 header 上下文

HTTP/2 的另一大变化，是 header 不再每次原样重复发送。

### 1. 静态表为什么对 HTTP 特别有效

`HpackStaticTable` 里当前静态表一共 61 项，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/HpackStaticTable.java:52`。

其中最关键的伪头和状态索引就落在前面：

- index 2：`:method GET`
- index 3：`:method POST`
- index 4：`:path /`
- index 5：`:path /index.html`
- index 8：`:status 200`
- index 12：`:status 400`
- index 13：`:status 404`
- index 14：`:status 500`

这直接回答完整性问题 #3。

为什么这张表特别有效？因为 HTTP 里有大量低熵、重复度极高的字段：

- `:method GET/POST`
- `:scheme http/https`
- 常见 `:status`
- 常见 header name

这些东西如果每次都按字符串发，本来就在浪费带宽。静态表让它们第一次就能被编码成很短的索引表示。

### 2. HPACK 真正复用的，不是某个 Stream 自己的历史，而是整条连接的 header 上下文

`HpackEncoder.encodeHeader(...)` 的主线是：

- 先看是不是敏感 header
- 再看动态表是否已有完全匹配
- 再看静态表是否命中
- 否则 literal 编码，并在允许时加入动态表

见 `codec-http2/src/main/java/io/netty/handler/codec/http2/HpackEncoder.java:161`。

这里最重要的认知是：动态表不是 per-stream，而是 per-connection。

也就是说，如果 stream 1 刚刚发过：

```text
:path: /api/users
authorization: Bearer xxx
```

那么同一条连接上的 stream 3、stream 5 后续都可能直接受益于这条动态表上下文。

所以完整性问题 #7 的前半句答案是：

```text
连接级动态表让同一连接上的多个 Stream 可以共享已学到的 header 表示，
连接越活跃、header 模式越稳定，后续 header block 往往越省字节。
```

### 3. 风险也正因为它是连接级共享，而不是隔离的

但收益的另一面同样明显。

因为压缩上下文是整条连接共享的：

- 一次解码错误可能污染后续所有 Stream 的 header 解码
- 动态表大小更新和索引状态必须严格同步
- 某条流的 header 表示并不是局部私有状态，而是连接级演化结果的一部分

这也是为什么 `HpackDecoder` 里很多错误会直接构造成 `ShutdownHint.HARD_SHUTDOWN` 的压缩错误，而不是“只关掉一条流”就算了，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/HpackDecoder.java:55`。

所以完整性问题 #7 的后半句答案就是：

```text
动态表连接级共享让压缩收益跨 Stream 复用，
但也意味着压缩上下文一旦损坏，影响面天然是整条连接，不只是单个请求。
```

### 4. `HpackDecoder` 为什么要先处理动态表大小更新

`HpackDecoder.decode(...)` 一上来就先 `decodeDynamicTableSizeUpdates(in)`，再进主解码状态机，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/HpackDecoder.java:126`。

这一步不是枝节。它说明在 HPACK 里，header block 的内容解释方式本身就可能依赖此前协商或更新过的动态表大小。

换句话说，HPACK 不是“拿到字节就查个表”，而是：

```text
先保证压缩上下文配置和表状态一致，
再解释当前这段 header block。
```

这也再次强化了“HPACK 是连接级状态机”的认知，而不是一次性纯函数转换。

## 五、双层流控：为什么不能只限制连接总量，而必须同时限制每条 Stream

HTTP/2 允许一条连接上很多 Stream 同时跑，那“谁能继续发 DATA”就不只是一个 socket 缓冲区问题，还变成了多路共享额度问题。

### 1. 本地流控器：消费了字节以后，什么时候发 `WINDOW_UPDATE`

`DefaultHttp2LocalFlowController` 当前默认 `windowUpdateRatio = 0.5f`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2LocalFlowController.java:47`。

`consumeBytes(stream, numBytes)` 会同时消费：

- 连接级窗口
- 流级窗口

见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2LocalFlowController.java:176`。

也就是说，应用层一旦把某条流的若干字节真正处理掉，返回窗口额度时不是只返给这条流，还要同步返还给整条连接。

这正是完整性问题 #4 的前半句：`consumeBytes` 会驱动双层窗口消费，并在窗口下降到阈值以下时触发 `WINDOW_UPDATE` 写回。

### 2. 为什么阈值默认是 0.5，而不是“每消费一点就立刻更新”

如果每收到一点数据、每处理一点数据就立刻发 `WINDOW_UPDATE`，那流控本身会制造大量控制帧噪音。

所以当前实现默认用 0.5：

```text
窗口消耗到初始窗口的一半以下，
再把额度补回去。
```

这不是规范唯一要求，而是当前实现的折中点：

- 更新太频繁，控制帧过多
- 更新太迟，发送方可能过早卡住

因此完整性问题 #4 的第二半答案是：`windowUpdateRatio` 默认 0.5，表示窗口消耗过半再触发补充。

### 3. 远端流控器：某条流可不可写，不只看它自己窗口大不大

`DefaultHttp2RemoteFlowController.isWritable(stream)` 的实现最终要求：

```text
isWritableConnection() && state.isWritable()
```

见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2RemoteFlowController.java:170` 和 `:606`。

这意味着一条流要继续发数据，至少要同时满足：

- 整条连接还有可用窗口
- 这条 Stream 自己还有可用窗口
- 底层 Channel 当前也可写

所以双层流控不是“多此一举”，而是把两个完全不同的问题分开控制：

```text
连接级窗口：总在途量别失控
流级窗口：某条流别把所有预算都吞掉
```

这就是完整性问题 #8 的核心。

### 4. 为什么只做连接级窗口不够

假设连接总窗口还有 64KB，但其中一条大文件流一直排着大量待发数据；如果没有流级窗口，它完全可以持续占据几乎全部可用额度。此时另一条只需要发几十字节 metadata 的流，也得排在后面等总窗口重新释放。

所以只靠连接级窗口，你能限制“总量”，却限制不了“分配公平性”。而 HTTP/2 的多路复用目标，恰恰要求它不仅能并发存在，还要避免单流把别的流饿死。

当前远端流控器再往下还配合 `StreamByteDistributor` 做字节分配；本文不展开分配算法细节，但至少要记住：

```text
双层窗口是多路复用可持续工作的底座，
而不是额外的复杂附件。
```

## 六、误解澄清：HTTP/2 的四块机制不是并列特性，而是一整套“连接与请求解耦”的后果

### 误解一：HTTP/2 的提升主要来自“二进制比文本快”

太浅了。

二进制 framing 确实让 parser 更容易做定长头解析，但如果没有 `streamId`、连接对象和流控配套，它依然只是“更容易解析的一条顺序连接协议”。

### 误解二：streamId 只是编号，不真正参与语义路由

不对。

帧层先靠 `streamId` 把交错 frame 重新挂回各自 Stream，连接层再在该 Stream 上推进状态。没有 `streamId`，多路复用只剩概念。

### 误解三：客户端和服务端都可以随便申请下一个 streamId

也不对。

奇偶划分本质上就是双方各自的命名空间，既避免冲突，也天然标出 Stream 的发起方。

### 误解四：HPACK 动态表是每个 Stream 自己维护的

不是。

它是连接级共享的，所以收益跨 Stream 复用，风险也跨 Stream 扩散。

### 误解五：HTTP/2 已经彻底消除了所有队头阻塞

也不是。

它消除了应用层“一个连接一次只服务一个请求”的捆绑，但 TCP 丢包重传导致的传输层 HOL 仍然存在。

### 误解六：gRPC 在传输层上和 HTTP/2 是两套无关体系

恰恰相反。

gRPC 的元数据、payload 和流结束语义就是映射到 HTTP/2 的 HEADERS、DATA 和 END_STREAM 上的。本篇不展开 gRPC 源码，但这层桥接必须先建立。

## 七、收网：HTTP/2 真正做的，是把“连接上的字节流”拆成了 frame 层、stream 层、header 上下文层和流控层

现在回到开头的问题：为什么一条 TCP 连接上能同时交错跑很多请求？

因为 HTTP/2 不再把“一个连接”直接等同于“当前唯一请求上下文”。它把这件事拆成了四层：

```text
帧层：9 字节头 + type + flags + streamId
  -> 负责把字节切成可路由 frame

Stream 层：DefaultHttp2Connection + DefaultStream
  -> 负责维护每条请求/响应自己的生命周期状态

头压缩层：HPACK static/dynamic table
  -> 负责在连接级复用 header 上下文

流控层：connection window + stream window
  -> 负责总量反压和单流公平性
```

这四层一起工作，才让 HTTP/2 从“一个更快的 HTTP/1.1”变成了“一个能在单连接里托起并发请求的传输基础设施”。

所以本篇真正该带走的话可以压成两句：

```text
HTTP/2 的关键不是把文本换成二进制，
而是把连接上的数据流切成带 streamId 的 frame，再把请求/响应语义挂到 Stream 上。

HPACK 和双层流控也不是附属优化，
它们分别解决多 Stream 共享连接时的 header 冗余和反压公平性问题。
```

也正因为如此，到了 gRPC、Dubbo Triple 这些跑在 HTTP/2 上的 RPC 协议时，很多看起来“很高级”的能力——并发流、头压缩、分块传输、连接内多请求并存——其实已经在这层地基里被准备好了。后面的框架做的，更多是把自己的 RPC 语义映射到这套 frame/stream/header/window 模型之上。