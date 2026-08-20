# Ch12-03 HTTP/2 ConnectionHandler、Encoder/Decoder 主链

## 先把一堆组件收成一条运行时主链

前两篇已经分别解决了两个问题。第一篇讲清楚 HTTP/2 的协议地基：frame 有自己的头和类型，stream 负责多路复用，HPACK 负责头压缩，连接级和流级窗口共同控制发送。第二篇讲清楚 Netty 的 API 层翻译：`Http2FrameCodec` 把 wire frame 变成 `Http2Frame` 对象，`Http2MultiplexHandler` 再把 stream 投影成 child channel。

可是，如果真的沿着一条连接的运行时继续往下追，新的问题马上会出现：frame reader 读出了帧以后，谁来判断这条帧是否符合当前 stream 状态？谁来应用 SETTINGS？谁来维护本地和远端窗口？谁来决定一条 DATA 什么时候才能真正写出去？谁来在 GOAWAY、stream error、channel close 之后把所有未完成状态收掉？

这些问题不能由 frame reader 单独解决。reader 能知道字节格式和帧类型，却不应该独自承担连接生命周期、流控、promise、SETTINGS、GOAWAY 和业务 listener 的全部责任。反过来，业务 handler 也不能直接面对一堆底层 reader/writer 回调，否则每个上层协议都得自己重建一套连接状态机。

Netty 的做法，是把这条运行时主链拆成几个职责明确、但共享同一个状态世界的角色：

- `Http2ConnectionHandler` 站在 pipeline 入口，负责连接级前置、解码阶段切换、flush 推进和关闭收尾；
- `DefaultHttp2ConnectionDecoder` 站在 frame reader 之上，把帧解释成 HTTP/2 语义，处理入站流控、SETTINGS、GOAWAY 和 listener 回调；
- `DefaultHttp2ConnectionEncoder` 站在 frame writer 之上，校验出站 stream 状态，应用远端 SETTINGS，把 DATA 交给远端流控，并推进本地 stream 生命周期；
- `Http2Connection` 保存双方共享的 stream、endpoint、窗口、SETTINGS、GOAWAY 和属性状态；
- flow controller 和 byte distributor 决定数据什么时候有资格发送、多个 stream 如何分配可发送额度。

本篇要解决的不是“这些类各自有哪些方法”，而是：**一条 HTTP/2 连接如何把 frame 解析、协议状态、流控、写出和关闭收成一个闭环。**

## 失败方案：如果只让 reader 和 writer 直接面对业务

先推演一个看似简单的实现：frame reader 读到一条 DATA，就直接通知业务；frame writer 收到一个 DATA，就直接把它写出去。这样类少、调用链短，好像更容易理解。

这个方案首先没有处理 stream 状态。入站 DATA 到来时，stream 可能已经 closed；出站 HEADERS 到来时，stream 可能还没创建，或者已经 half-closed local；RST_STREAM、END_STREAM、GOAWAY 对后续 frame 的影响，也不会凭空消失。reader 和 writer 可以告诉你“帧格式没问题”，却不能替你决定“此时协议状态允许不允许”。

其次，它没有处理 SETTINGS 的动态影响。远端 SETTINGS 可能改变最大并发 stream 数、最大帧大小、头表大小、初始窗口大小和 push 能力。若 writer 仍然拿着连接建立时的静态参数继续写，连接双方很快就会对可接受的帧和窗口产生分歧。

再次，它没有处理流控。出站 DATA 不能因为业务调用了 write 就立刻落到 frame writer；它必须先检查 stream 和 connection 的远端窗口。入站 DATA 也不能只交给 listener；应用消费了多少数据、什么时候应该发 WINDOW_UPDATE，都要经过本地流控器。

最后，它没有处理关闭。连接级错误、stream 级错误、GOAWAY、channelInactive 和 encoder/decoder close 彼此有关。只关 reader 不关 writer，或者只关底层 channel 不清理 stream，都可能把 promise、窗口状态和剩余对象留在半死不活的状态里。

所以 reader/writer 直连业务的方案，表面上减少了中间层，实际上把协议语义分散到了所有使用方。Netty 选择的结构正好相反：让 reader/writer 保持底层职责，让 connection handler、encoder、decoder 和 lifecycle manager 把语义集中收束。

这也是本篇的第一张心智图：

- frame reader/writer：处理 wire representation；
- encoder/decoder：处理 HTTP/2 语义；
- connection：保存共享状态；
- flow controller：决定窗口约束；
- lifecycle manager：处理状态推进和失败收尾；
- pipeline handler：把这条主链接入 Netty 的事件模型。

## `Http2ConnectionHandler`：连接级总编排器

`Http2ConnectionHandler` 的继承关系已经说明了它为什么处在主链中央：它继承 `ByteToMessageDecoder`，同时实现 `ChannelOutboundHandler` 和 `Http2LifecycleManager`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:55`。这意味着它一边接收入站字节并启动 decoder，一边接收 outbound 事件并驱动 encoder，还要承担连接生命周期管理。

它的构造器首先检查 encoder 和 decoder 是否共享同一个 `Http2Connection`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:93`。这个检查不是普通的依赖注入校验，而是在保护一个更根本的事实：encoder 和 decoder 必须生活在同一个协议状态世界里。

如果 encoder 持有 connection A，而 decoder 持有 connection B，入站 frame 在 B 上创建的 stream，出站 encoder 根本看不到；decoder 应用的远端 SETTINGS，也不会改变 encoder 正在使用的参数；一侧收到 GOAWAY，另一侧却继续认为连接可以创建新 stream。表面上两个组件都有自己的 connection 对象，实际上整条协议链已经分裂成两个互不相认的状态机。

因此，`connection()` 对 `Http2ConnectionHandler` 来说不是一个普通便利方法，它把 encoder/decoder 共同绑定的状态中心暴露出来，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:129`。stream、endpoint、flow controller、SETTINGS、GOAWAY 和属性都应该围绕这个共享对象演进。

### preface 是连接状态机的第一阶段

HTTP/2 连接不能一上来就把所有字节当普通 frame 解析。客户端需要先发送连接 preface，服务端需要验证它；双方还要处理第一组 SETTINGS。`Http2ConnectionHandler` 通过 `BaseDecoder`、`PrefaceDecoder` 和 `FrameDecoder` 把这段阶段切换放在连接级 handler 中。

`PrefaceDecoder.decode(...)` 会先验证连接是否 active、读取客户端 preface，并确认后续第一帧是 SETTINGS；确认成功后，才把 `byteDecoder` 切换成 `FrameDecoder`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:236`、`:253`。这不是普通的“先读一段固定字符串”，而是连接状态从“等待协议建立”切换到“允许处理普通 HTTP/2 frame”。

如果把 preface 验证遗漏，后面的 reader 即使能解析 9 字节 frame header，也无法确认当前输入已经进入 HTTP/2 正常状态。如果把 SETTINGS 验证遗漏，双方对初始能力和窗口的协商也没有可靠起点。

所以 `Http2ConnectionHandler` 的第一项核心职责，是把 pipeline 收到的字节放进正确的连接阶段，而不是直接把所有输入交给 decoder。

### flush 不只是向下调用一次

`Http2ConnectionHandler.flush(...)` 也不是简单地调用 `ctx.flush()`。它会先调用 `encoder.flowController().writePendingBytes()`，再把 flush 继续向下传，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:190`。

这一步把前面的 HTTP/2 远端流控和 Netty 出站 flush 接起来了。业务可能早就把 DATA 交给 remote flow controller，但因为窗口不足，数据暂时留在流控队列里；当 SETTINGS、WINDOW_UPDATE 或其他状态变化让窗口恢复时，flow controller 内部会重新评估哪些数据可以发送。真正的 flush 到来时，ConnectionHandler 给它一次集中推进 pending bytes 的机会，然后才让底层 pipeline 继续 flush。

这正是“write、flow control、flush”三层关系：

- write 把协议对象交给 encoder；
- encoder 把可控的 DATA 交给 remote flow controller；
- flow controller 先根据窗口和公平分配决定能写多少；
- ConnectionHandler 的 flush 把当前可发送部分推进到 frame writer 和 transport。

如果 flush 只穿过 pipeline，不触发 `writePendingBytes()`，那些已经被窗口放行、但仍停在 remote flow controller 里的数据，就可能错过下沉时机。

### channelInactive 的收尾范围

连接关闭时，`BaseDecoder.channelInactive(...)` 会先关闭 encoder 和 decoder，再调用 `connection().close(ctx.voidPromise())`，并且注释特别说明要移除的不只是 active streams，而是全部 streams，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:208`。

这个顺序很有代表性：底层输入输出已经不能继续处理，encoder/decoder 必须先停止；但协议状态中心还需要把全部 stream 清理掉，否则保留在 connection 里的 idle、reserved、half-closed 或其他非 active 状态仍然可能持有属性、promise 或资源。

所以关闭不是“channel 断了，剩下的对象自然会消失”。在 HTTP/2 里，连接级关闭必须向下清理 encoder、decoder、stream 和生命周期状态，才能真正结束这条协议状态机。

## `DefaultHttp2ConnectionDecoder`：reader 之上的入站协议语义

`DefaultHttp2ConnectionDecoder` 的类注释把职责说得很准确：它负责处理入站 frame 事件，并委托给 `Http2FrameListener`；同时它在 frame reader 之上强制执行 inbound flow control，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:44`。

这句话划出了 reader 和 decoder 的边界。`decodeFrame(...)` 本身只有一件事：把输入交给 `frameReader.readFrame(ctx, in, internalFrameListener)`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:184`。真正的 HTTP/2 语义并不结束于“reader 解析出一条 DATA”，而是在内部 `FrameReadListener` 接收到回调后继续处理。

### decoder 同时持有 connection、encoder 和 local flow controller

构造 decoder 时，它会保存共享的 `Http2Connection`、对应的 encoder、frame reader、request verifier，并确保 connection 已经有 local flow controller；随后把 encoder 的 frame writer 设置给 local flow controller，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:125`。

为什么 decoder 需要 encoder？因为入站语义经常会产生出站动作。收到 SETTINGS 可能需要 ACK，收到 PING 可能需要 PING ACK，消费入站 DATA 可能需要发送 WINDOW_UPDATE，本地流控器需要一个 frame writer 才能把窗口更新写回远端。

这说明 encoder 和 decoder 虽然在方向上分别负责 outbound 和 inbound，但并不是两条互不相干的单向管线。入站事件可能要求出站确认；出站 SETTINGS 又会改变 decoder/encoder 两侧后续行为。共享 connection 和互相可见的 writer/encoder，是这条闭环能够成立的前提。

### SETTINGS 确认是自动行为，但不是唯一配置

decoder 支持自动应用和发送 SETTINGS ACK，也支持关闭自动确认、把处理交给实现了 `Http2SettingsReceivedConsumer` 的 encoder，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:80`。

默认路径下，收到远端 SETTINGS 后，decoder 会让协议栈应用这些设置并发送 ACK。关闭自动确认时，构造器反而要求传入的 encoder 实现 `Http2SettingsReceivedConsumer`；如果不满足就直接抛出 `IllegalArgumentException`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:134`。

这条边界值得单独强调：自动 ACK 不是“decoder 永远自己处理”的硬编码，而是一个可配置的连接策略。但关闭自动 ACK 也不是把责任丢掉，而是要求调用方明确提供能够接住 SETTINGS 应用和确认的另一条路径。

### 入站 DATA 不能直接交给业务

`FrameReadListener.onDataRead(...)` 拿到 DATA 后，首先需要找到对应 stream、计算可读字节和 padding，再结合 local flow controller 判断这一批数据如何计入本地消费状态，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:250`。

这里的关键问题是：网络已经把数据交给 Netty，不等于应用已经消费了数据。decoder 需要区分“收到多少”和“应用真正消费多少”。应用的消费进度会参与本地流控器的窗口更新判断，进而决定何时向远端归还窗口；如果只按收到数据推进，而不等待实际消费，本地缓存就可能持续增长。

同一条入站路径还会处理 content-length 校验。decoder 为 stream 保存 content length 状态，并在收到 DATA 或 END_STREAM 时累计和检查，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:233`。这说明 decoder 不只是一个流控转发器，它还在把 HTTP 语义约束叠加到 frame 事件上。

因此，入站 DATA 的正确心智图不是：

`frame reader -> listener`

而是：

`frame reader -> decoder 语义检查 -> local flow controller / content-length -> stream listener -> 应用消费 -> 窗口更新`

如果跳过中间层，业务就会直接看到数据，却无法保证窗口、长度和 stream 状态都已经同步。

### GOAWAY 先通知，再更新共享状态

decoder 处理 GOAWAY 时，会先调用 listener 的 `onGoAwayRead(...)`，再调用 `connection.goAwayReceived(...)` 更新 connection 状态，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:227`。

这个顺序不是无关紧要的实现细节。listener 可能需要先看到协议事件，执行自己的记录、关闭或业务通知；共享 connection 状态随后再标记“远端已经发来 GOAWAY”，影响后续 stream 创建和状态判断。

从整体看，decoder 的工作就是把“收到 frame”升级成“连接状态发生了有顺序的协议变化”。SETTINGS、DATA、GOAWAY、PING 等事件都可能同时影响 listener、flow controller、encoder 和 connection。

## `DefaultHttp2ConnectionEncoder`：writer 之上的出站协议语义

如果 decoder 是 reader 之上的语义层，encoder 就是 frame writer 之上的出站语义层。`DefaultHttp2ConnectionEncoder` 保存 frame writer、共享 connection、lifecycle manager，并在构造时确保 connection 拥有 remote flow controller，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:38`。

它不负责把每个对象直接写成二进制。它首先要回答：

- 这个 stream 现在允许发送这类 frame 吗？
- 远端 SETTINGS 是否改变了当前写出参数？
- DATA 是否还有远端窗口？
- HEADERS 是否会创建新 stream、结束本地一侧，或者违反 headers 顺序？
- 写失败后应该由谁推进 lifecycle manager？

### 远端 SETTINGS 会反向改写 encoder 的能力边界

`remoteSettings(...)` 收到远端设置后，会依次处理 push 能力、最大并发 stream 数、header table size、最大 header list size、最大 frame size 和 initial window size，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:79`。

这些设置并不是存下来供日志查看，而是直接改写 encoder 和 flow controller 的工作边界：

- 最大并发 stream 数会更新 local endpoint 的 active stream 上限；
- header table size 会改变 outbound header encoder 配置；
- max frame size 会改变 frame size policy；
- initial window size 会改变 remote flow controller 的窗口。

因此远端 SETTINGS 是一条动态配置事件，它会改变后续写出行为。encoder 如果不及时应用这些改变，后面的 frame 可能在本地看似合法，却违反远端刚刚宣布的能力边界。

### DATA 写出前先检查 stream 状态

`writeData(...)` 不会直接把 DATA 交给 frame writer。它先通过 `requireStream(streamId)` 找到 stream，然后只允许 `OPEN` 和 `HALF_CLOSED_REMOTE` 状态发送 DATA；其他状态都会失败，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:120`。

如果找不到 stream 或状态不允许发送，encoder 会先释放传入的 `ByteBuf`，再把失败设置到 promise，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:137`。这条失败路径把本篇前面的 ownership 主线再次接了回来：出站 API 收到的数据并不因为失败就自动消失，谁接收了它，谁就要在拒绝时负责释放。

状态检查通过后，DATA 会被封装成 `FlowControlledData`，交给 remote flow controller 的 `addFlowControlled(...)`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:142`。这一步就是出站流控主线的入口：encoder 只确认“这条 DATA 在协议状态上有资格进入发送候选区”，真正什么时候、写多少，还要由窗口和分配策略决定。

### HEADERS 会创建或打开 stream，但状态推进不能过早

`writeHeaders0(...)` 的复杂度来自一个问题：第一次 HEADERS 可能需要创建本地 stream，后续 HEADERS 可能是 reserved stream 的打开、普通 headers 或 trailers。

如果 connection 里还没有这个 stream，encoder 会通过 local endpoint 创建 stream；如果已有 stream，则根据状态决定是否打开 reserved stream、是否允许继续写 headers，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:187`。

这里有一个很容易忽略的时序：在当前 `writeHeaders0(...)` 的初始 HEADERS 创建路径上，encoder 不会过早把“headers 已发送”的状态写进 connection。源码注释说明，它要等 headers 被编码并放进 outbound buffer 后，再让 lifecycle manager 负责适当的状态转移，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:193`。这是当前实现对初始 HEADERS 路径的特定时序约束，不应泛化成所有 HTTP/2 frame 都遵循同一套状态更新顺序。

随后，在这条路径中，encoder 会验证 headers 是否过多、是否违反 informational/trailer 顺序，再调用 frame writer 写出。如果编码阶段没有同步失败，它会设置 `stream.headersSent(...)`；如果 future 失败或 END_STREAM，则继续通知 lifecycle manager，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:230`。

这说明 encoder 不是简单的“把 headers 写出去”，而是围绕初始 HEADERS 建立了一个特定的 stream 生命周期边界：状态不能太早推进，也不能在写失败后遗留成“已经发送”的假象。其他 frame 的状态更新仍应回到各自实现路径核对。

## 为什么 Encoder 和 Decoder 必须共享同一个 `Http2Connection`

现在可以更明确地回答构造器里的那个校验：为什么 `Http2ConnectionHandler` 要求 `encoder.connection() == decoder.connection()`，而不是只要求两者实现相同接口？

因为 `Http2Connection` 不是一个纯配置对象，它是整条连接协议状态的共享账本。

- decoder 收到远端 SETTINGS，会更新 connection 的 endpoint 能力、header 配置和 local flow controller；
- encoder 处理这些设置后，要依据同一个 connection 决定后续创建 stream 和写出窗口；
- decoder 收到 GOAWAY，会更新 connection 的远端关闭边界；
- encoder 随后必须拒绝不再允许的新 stream 或失败对应 buffered writes；
- decoder 收到 RST_STREAM 或 END_STREAM，会推进 stream 状态；
- encoder 不能再按旧状态继续发送 DATA 或 HEADERS。

如果两者各自拿着不同 connection，所有这些信息都会分裂。问题不一定在第一次请求就暴露，而可能在 SETTINGS、GOAWAY、reserved stream 或并发流限制变化以后才出现，排查会非常困难。

因此共享 `Http2Connection` 的意义不是“两个对象方便互相调用”，而是保证 encoder、decoder、flow controller 和 lifecycle manager 对同一条连接拥有同一份状态认知。它把多个职责不同的组件重新绑在一个状态世界里。

## `StreamBufferingEncoder`：并发流上限不是马上报错，而是有限期等待

HTTP/2 允许远端通过 `SETTINGS_MAX_CONCURRENT_STREAMS` 限制同时 active 的 stream 数。如果本地在达到这个上限时继续创建新 stream，最粗暴的做法是直接失败。但 Netty 还提供了 `StreamBufferingEncoder`，把这个限制转化成一个可管理的暂存阶段。

它的类注释说明：在最大并发 stream 数达到以后，不会立刻允许新的 stream 建立；对应写入会被暂时缓存，等 active stream 关闭或远端提高并发上限后再尝试 drain，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/StreamBufferingEncoder.java:35`。

这层 decorator 不修改底层 encoder 的基本协议语义，而是在“stream 还没资格创建”与“stream 真正可以创建”之间加了一个等待区。当前主入口首先是 `writeHeaders0(...)`：它先判断连接是否关闭、stream 是否已存在、当前是否还能创建；如果不能创建，就创建或取得对应的 `PendingStream`，把初始 HEADERS 放进该 stream 的帧队列，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/StreamBufferingEncoder.java:168`。只有在这个 `PendingStream` 已经存在以后，后续针对同一待创建 stream 的 DATA 等 frame 才会继续追加到这条 stream 自己的帧队列里，而不是任意 frame 都能脱离 stream 独立进入缓冲。

这条等待线有三个重要出口。

第一，active stream 关闭时，连接 listener 会调用 `tryCreatePendingStreams()`，让等待的 stream 重新获得创建机会，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/StreamBufferingEncoder.java:128`。

第二，远端 SETTINGS 更新最大并发数后，decorator 会先让 delegate 应用设置，再更新本地记录并重新尝试创建等待 stream，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/StreamBufferingEncoder.java:242`。

第三，GOAWAY 或 connection close 会使等待中的写入失败。GOAWAY 使用 `Http2GoAwayException`，连接关闭使用 `Http2ChannelClosedException`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/StreamBufferingEncoder.java:45`。等待区不是无限期黑洞，它必须在协议不再允许创建时清理 promise 和引用计数对象。

因此，`StreamBufferingEncoder` 的价值不是“让并发限制消失”，而是把“暂时不允许创建”从立即失败改造成受控排队，同时为 stream close、SETTINGS、GOAWAY 和 close 建立清晰的 drain/fail 边界。

## `WeightedFairQueueByteDistributor`：把可发送额度分给多个 stream

当多个 stream 都有可发送 DATA 时，另一个问题出现了：即使每条 stream 都没有违反窗口，也不能让第一条 stream 把当前连接的可发送额度全部吃完。HTTP/2 需要一套在多个 stream 之间分配可发送额度的策略。

`WeightedFairQueueByteDistributor` 的类注释把自己限定为 `StreamByteDistributor` 的一种实现，它对 stream priority 敏感，并采用 Weighted Fair Queueing 方法分配字节，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:44`。它不是完整的流控器，也不是带宽保证器；它工作的前提是 flow controller 已经先判断出哪些 stream 当前是 streamable 的，然后它才在这些“已经有资格发送”的 stream 之间继续决定可发送额度如何分配。

它维护 connection stream 和依赖树状态。每个 stream 可以有父节点、权重和子节点；如果某个 stream 对象已经不存在，但优先级信息仍然有价值，分配器还会用 `stateOnlyMap` 和删除队列暂存 priority state，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:73`。

这说明优先级树不完全等同于 active stream 对象生命周期。stream 关闭或移除以后，部分 priority state 仍可能短暂保留，以便后续依赖关系计算不至于完全丢失。分配器还会通过 connection listener 在 stream added、active、closed、removed 时更新自己的状态，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:115`。

真正分配时，它会结合 `streamableBytes(state)`、窗口可用性和 priority tree 状态更新各个 stream 的可发送状态，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:189`。`allocationQuantum` 则在公平性和 goodput 之间做局部折中，类注释明确每次写操作会参考这个 quantum 决定相对下一个 stream 还应分配多少字节，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:54`。

这里必须把“公平”说得克制。它表示在当前连接状态、窗口、依赖树和可发送数据共同约束下，分配器尽量按策略分配额度；它不保证每条 stream 获得固定带宽，也不等于系统级的绝对公平。

## 收网：一条 HTTP/2 连接如何形成闭环

现在可以把这条连接级主链完整收回来。

入站方向是：

`ByteToMessageDecoder / preface -> frameReader -> DefaultHttp2ConnectionDecoder -> SETTINGS/DATA/GOAWAY 语义 -> local flow controller / listener -> FrameCodec 或 Multiplex API`

出站方向是：

`业务 frame -> DefaultHttp2ConnectionEncoder -> stream 状态与 headers 校验 -> remote flow controller -> byte distributor -> frameWriter -> ConnectionHandler.flush -> transport`

共享中枢是同一个 `Http2Connection`。它保存 stream、endpoint、窗口、SETTINGS、GOAWAY 和各种属性，让 encoder、decoder、flow controller、lifecycle manager 对同一条连接保持一致认识。

失败和关闭方向则是：

`stream error -> stream 级状态收尾`

`connection error / GOAWAY -> 限制新 stream、失败 buffered writes、通知 API`

`channelInactive -> 关闭 encoder/decoder、清理全部 streams`

所以本篇真正要留下来的心智模型是：**`Http2ConnectionHandler` 负责把连接级时序收拢，Decoder 负责把入站 frame 解释成协议语义，Encoder 负责把出站对象约束成合法写出，FlowController 和 Distributor 负责决定数据什么时候、以什么额度继续前进，而共享的 `Http2Connection` 保证所有角色生活在同一个状态世界。**

这也正好回收开篇那个问题：为什么业务不需要自己把 preface、SETTINGS、窗口、GOAWAY、stream 状态和写出公平性拼成一条链？因为这条连接级编排已经被 `Http2ConnectionHandler + Decoder + Encoder + FlowController + Http2Connection` 这组组件收好了。前一篇 `Ch12-02` 解决的是 API 层如何把 frame 和 stream 投影成对象与 child channel；这一篇解决的则是这些 API 背后真正驱动连接运行的状态机主链。后面再看 gRPC 或 Dubbo Triple，它们调用的不是一个简单的 HTTP/2 编码器，而是这一整套已经闭环的连接运行时。