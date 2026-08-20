# Ch13-03 大对象分块写出：ChunkedInput、ChunkedFile、ChunkedStream 与 HttpChunkedInput

## 先把“大对象写出”从普通 `write(ByteBuf)` 里拆出来

前面几篇里，我们一直在默认一个前提：当业务调用 `ctx.write(msg)` 时，这个 `msg` 已经是一份完整、可直接进入托管区的对象。它也许是 `ByteBuf`，也许是 `ByteBufHolder`，也许是某种协议对象，但无论如何，消息本体已经完整在手上了。`ChannelOutboundBuffer`、PendingWriteQueue、CoalescingBufferQueue、traffic shaping 和 writability 主线，都是建立在这个前提上的。

可一旦对象本身很大，这个前提就不再自然成立。

- 一个大文件可能根本不想整块读进内存；
- 一个 `InputStream` 也许长度未知，只能一段段取；
- 一个 HTTP 响应体可能必须按 chunked transfer 语义边发边包；
- 某些数据源甚至会短暂“此刻没有下一块”，但并不表示整个输入已经结束。

如果仍然把这些场景粗暴压成“先把全部内容弄成一个 `ByteBuf` 再 write”，问题会立刻暴露：内存峰值可能过高，失败边界会延后，writability 反馈会太迟，传输和数据源之间也失去渐进交接能力。

所以 Netty 才需要 `ChunkedInput` 这一支。它处理的不是“已经成型的消息对象如何写出”，而是**数据本体本来就是一个要逐块展开的源，写出过程必须和取数过程交错前进**。这和前面所有出站队列的立足点都不一样。前面那些结构处理的是“消息已经在手上，怎样托管、延迟、聚合和推进”；这里处理的是“消息本体还没完整展开，怎样让它一边展开、一边进入出站主线”。

因此本篇的核心问题不是“ChunkedInput 有哪些实现类”，而是：**Netty 为什么要把大对象写出重新建模成一个逐块可消费的输入源，再让出站主线一段段接住它。**

## `ChunkedInput`：它抽象的不是消息，而是一条可渐进消费的源

`ChunkedInput` 接口很小，但每个方法都在说明它和普通 message write 的差异。它定义了：

- `isEndOfInput()`：流是不是已经真正到头；
- `readChunk(...)`：当前能不能取到下一块；
- `length()`：总长度是否已知；
- `progress()`：现在已经走了多少；
- `close()`：关联资源什么时候该关闭。

定义见 `handler/src/main/java/io/netty/handler/stream/ChunkedInput.java:22`。

这里最关键的一点，是 `readChunk(...)` 返回 `null` 的语义。接口文档明确说，`null` 不一定意味着流已经结束，它也可能只是“下一块暂时还不可用”，见 `handler/src/main/java/io/netty/handler/stream/ChunkedInput.java:55`。这就把它和普通队列、普通集合、普通 `Iterator` 的结束语义彻底区分开了。

普通消息写出通常更接近：

- 对象已经完整存在；
- 要么写，要么不写；
- 写完就可以释放或完成 promise。

而 `ChunkedInput` 更接近：

- 数据本体本来就在逐步展开；
- 某一刻没有 chunk，不等于整个输入结束；
- 结束必须靠 `isEndOfInput()` 与最终状态共同判断；
- 关闭资源也不是由消息本体自动完成，而是由输入源自己负责。

这说明 `ChunkedInput` 的根本抽象不是“一个特殊消息对象”，而是“一条可渐进消费的写出源”。后面 `ChunkedFile`、`ChunkedNioFile`、`ChunkedStream` 和 `HttpChunkedInput` 的所有差异，本质上都只是这条抽象的不同实现方式。

所以第一层心智模型应该这样立：**普通 write 面对的是已成型对象，`ChunkedInput` 面对的是尚未完全展开的数据源。**`ChunkedInput` 负责决定数据如何被逐块生产，`ChannelOutboundBuffer` 则只负责在这些块已经产生以后，继续托管它们的出站生命周期；前者不能替代后者。

## 文件与流：为什么 `ChunkedFile`、`ChunkedNioFile`、`ChunkedStream` 要分别存在

如果 `ChunkedInput` 只是“每次返回一个 ByteBuf”，那一个实现类似乎就够了。但源码并没有这么做，而是分成了至少三条主线：`ChunkedFile`、`ChunkedNioFile` 和 `ChunkedStream`。这说明它们解决的并不只是“数据来自哪里”这么简单，还涉及读取方式、长度已知性和底层对象特征。

### `ChunkedFile`：RandomAccessFile + heap buffer

`ChunkedFile` 基于 `RandomAccessFile` 工作，保存 `startOffset`、`endOffset`、`chunkSize` 和当前 `offset`，见 `handler/src/main/java/io/netty/handler/stream/ChunkedFile.java:28`。`readChunk(...)` 会根据当前 offset 与 endOffset 算出这次应取多少字节，然后直接从文件读到一个 heap buffer 里，更新 writerIndex，再推进 offset，见 `handler/src/main/java/io/netty/handler/stream/ChunkedFile.java:136`。

这里最值得注意的是，它不是去“构造一个代表文件区间的描述”，而是真正把文件内容读进一个 `ByteBuf`。也就是说，`ChunkedFile` 代表的是一种**以文件为源、以 ByteBuf 为输送单位**的渐进读法。

类注释还专门提醒：如果操作系统支持 zero-copy，例如 `sendfile()`，你可能更想用 `FileRegion`，见 `handler/src/main/java/io/netty/handler/stream/ChunkedFile.java:28`。这句话很重要，因为它明确把 `ChunkedFile` 定位成“分块读文件进 ByteBuf”的路径，而不是所有文件传输场景的最佳答案。

### `ChunkedNioFile`：FileChannel + ByteBuf 写入

`ChunkedNioFile` 和 `ChunkedFile` 看起来接近，但它明确建立在 NIO `FileChannel` 上，见 `handler/src/main/java/io/netty/handler/stream/ChunkedNioFile.java:30`。它同样有 offset、length、chunkSize，但 `readChunk(...)` 里会循环调用 `buffer.writeBytes(in, offset + readBytes, chunkSize - readBytes)`，直到本轮 chunk 满或读不到更多数据，见 `handler/src/main/java/io/netty/handler/stream/ChunkedNioFile.java:140`。

相比 `ChunkedFile`，这里的差异不是“也能读文件”，而是它更适合和 NIO channel 模型对齐。测试里还专门验证了 `ChunkedNioFile` 不会偷偷改变外部 `FileChannel` 的 position，并在关闭 channel 的情况下正确抛出 `ClosedChannelException`，见 `handler/src/test/java/io/netty/handler/stream/ChunkedWriteHandlerTest.java:107` 和 `:128`。

所以 `ChunkedNioFile` 的真正价值，是把“文件逐块读出”这一过程放在 NIO `FileChannel` 语义上，而不是只看它和 `ChunkedFile` 都来自文件。

### `ChunkedStream`：长度未知、读取可瞬时为空的 InputStream 世界

`ChunkedStream` 则完全不同。它基于 `InputStream`，并且为了支持窥看结尾，会包装成 `PushbackInputStream`，见 `handler/src/main/java/io/netty/handler/stream/ChunkedStream.java:27`。它的 `length()` 永远返回 `-1`，说明总长度未知；`progress()` 只记录已经读了多少字节，见 `handler/src/main/java/io/netty/handler/stream/ChunkedStream.java:139`。

`isEndOfInput()` 也最能说明它的世界观。它不会简单地用“当前没读到数据”判断结束，而是先看 `available()`，再必要时读一个字节窥探并 `unread` 回去，见 `handler/src/main/java/io/netty/handler/stream/ChunkedStream.java:77`。这说明 `ChunkedStream` 面对的是一种更松散的输入源：

- 长度可能未知；
- `available()` 可能暂时为 0；
- 流结束和“此刻没有现成数据”必须分开判断。

因此 `ChunkedStream` 不是“文件分块读的另一种写法”，而是专门应对“流式输入、长度未知、结尾需要谨慎确认”的那条路径。

所以第二层心智模型可以这样记：

- `ChunkedFile`：文件区间 + heap buffer；
- `ChunkedNioFile`：FileChannel + NIO 读块；
- `ChunkedStream`：InputStream + 未知长度 + 结尾探测。

它们共用 `ChunkedInput<ByteBuf>` 抽象，但每一条都在针对不同数据源特征。

## `null` chunk 不等于结束：`ChunkedInput` 的结束语义和普通 write 完全不同

这一点值得单独拿出来讲，因为它几乎是理解 chunked write 最容易出错的地方。前面已经提到，`readChunk(...)` 返回 `null` 不一定表示输入结束；真正的结束要看 `isEndOfInput()`，见 `handler/src/main/java/io/netty/handler/stream/ChunkedInput.java:55`。

为什么这件事这么关键？因为它说明 chunked write 不能沿用普通消息的结束模型。普通 write 时，消息对象本身就是完整单元：你拿到它，要么入队，要么失败。没有“这次没拿到消息，但下次还有”的中间态。`ChunkedInput` 则明确允许这种中间态存在。

这意味着处理它的写出路径，不能把“本轮没有 chunk”简单当成“输入已经结束并且可以关闭资源”。否则一条慢流、网络文件、或者暂时没数据的 `InputStream`，就会被提前判死。

反过来，这也说明 chunked write 对 promise 完成时机更敏感。只要结束语义还没有真正成立，写出链就不能假设“一轮 readChunk 返回 null 就可以通知全部完成”。换句话说，listener 的完成必须依赖真正的 `isEndOfInput()` 语义以及最后收尾边界，而不能只看某一次读取结果为空。后面测试里关于 listener 何时被通知、last chunk 失败时怎样处理，都是围绕这条边界展开的。

所以第三层心智模型一定要钉死：**在 `ChunkedInput` 世界里，“没有下一块”和“整个输入结束”不是一个意思。**

## `HttpChunkedInput`：为什么 HTTP 场景还要再包一层

有了通用 `ChunkedInput<ByteBuf>` 以后，HTTP 场景似乎直接写它就够了。但源码里还专门有一个 `HttpChunkedInput`，这说明 HTTP 需要的不只是“很多 ByteBuf 分块写出去”，还需要把分块语义重新映射成 HTTP chunked transfer 的对象模型。

`HttpChunkedInput` 内部其实只包了一个 `ChunkedInput<ByteBuf>` 和一个 `LastHttpContent`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpChunkedInput.java:23`。但它做了两个很重要的重写。

第一，它把每次取到的 `ByteBuf` 包成 `DefaultHttpContent`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpChunkedInput.java:91`。这意味着下游看到的已经不再是原始 ByteBuf chunk，而是 HTTP 内容对象。

第二，它把真正的结束信号改造成 `LastHttpContent`。只有在底层 input `isEndOfInput()` 返回 true，并且终止 chunk 还没发过时，它才会返回 `lastHttpContent`；发过以后再返回 `null`，见 `codec-http/src/main/java/io/netty/handler/codec/http/HttpChunkedInput.java:70`。

这说明 `HttpChunkedInput` 的价值不在于“再包一层对象”，而在于：它把通用 ByteBuf chunk 流，翻译回 HTTP 协议自己需要的结束语义。HTTP chunked transfer 不是“最后一个 `null` 就算完”，而是“最后必须还有一个 `LastHttpContent`”。

所以这里一定要把边界说清楚：

- `ChunkedInput<ByteBuf>` 只关心底层字节块；
- `HttpChunkedInput` 关心 HTTP 内容对象和终止 chunk 语义；
- 两者的结束模型相连，但不相同。

如果忽略这一层，很容易把 HTTP 场景误写成“直到 `readChunk()` 返回 null 为止”，而漏掉真正协议层必须出现的 terminating chunk。

## 测试真正验证的，不是“能写出去”，而是结束、跳过和失败边界

`ChunkedWriteHandlerTest` 的价值不只是证明 `ChunkedStream`、`ChunkedNioStream`、`ChunkedFile`、`ChunkedNioFile` 都能写。更关键的是，它在系统性地验证三类边界：结束语义、失败后如何处理后续 chunk、以及 listener 什么时候应该被通知。

### 正常路径：不同来源都能走同一条 chunked write 主线

`testChunkedStream()`、`testChunkedNioStream()`、`testChunkedFile()`、`testChunkedNioFile()` 和 `testUnchunkedData()` 共同证明：不管来源是文件、NIO 文件、输入流，甚至已经现成的 ByteBuf，最终都可以沿同一条 chunked write 处理链往下走，见 `handler/src/test/java/io/netty/handler/stream/ChunkedWriteHandlerTest.java:73`。

这说明 chunked write 关注的不是来源类型，而是“当前对象能不能被抽象成连续可取的 chunk”。一旦这一层成立，下游处理模型就统一了。

### 结束边界：`isEndOfInput()` 以后 listener 仍然要被通知

`testListenerNotifiedWhenIsEnd()` 特别关键。测试构造一个 `ChunkedInput`，在第一次 `readChunk()` 后就把 `done=true`；此时真正的数据只有一块，但 listener 仍然必须在输入结束后被通知完成，见 `handler/src/test/java/io/netty/handler/stream/ChunkedWriteHandlerTest.java:153`。

这说明 chunked write 的“最后完成”不是“最后一个 chunk 写了就自然算完”，而是“输入流明确结束、最后的 chunk 处理完毕、再把整体写 future/lister 收尾”。如果没有这条约束，慢流或一次性单块输入在最后阶段很容易出现 future 永远不完成的假死现象。

### 失败边界：当前 chunk fail 以后，后续 chunk 不能继续无脑推进

测试里还有一组非常重要的用例：`testWriteFailureChunked*()`、`testSkipAfterFailed*()` 和 `testFailureWhenLastChunkFailed()`，见 `handler/src/test/java/io/netty/handler/stream/ChunkedWriteHandlerTest.java:267` 之后。

这些测试说明，一旦某一块写失败，系统不能只是“当前 promise fail 掉”就算完。还必须回答：

- 后续 chunk 还要不要继续尝试；
- 输入源该不该被关闭；
- 整体 write future/listener 何时算失败完成；
- 如果最后一个 chunk 失败，整体结束语义如何处理。

也就是说，chunked write 不是“把文件拆成很多小 write 就行”，而是“把大对象写出重建成一连串带结束和失败边界的状态机”。测试真正验证的是这台小状态机有没有在关键边界上掉链子。

## 它和前面出站主线的关系：不是替代，而是把对象来源模型换掉

讲到这里，最重要的一句总结是：chunked write 不是在替代前面写过的 `ChannelOutboundBuffer`、PendingWriteQueue、CoalescingBufferQueue 或 writability 主线。它只是把出站主线最前面的“对象来源模型”换掉了。

普通 write 的起点是：消息已经完整在手上。  
chunked write 的起点则是：消息本体本来就是一个要逐块展开的输入源。

从这个分叉点往后，很多前面已经写过的语义仍然全部有效：

- 仍然需要按 chunk 一步步进入写路径；
- 仍然需要 promise/future 收尾；
- 仍然会受到 writability 和流量整形影响；
- 仍然要面对失败、关闭和资源释放边界；
- HTTP 场景下还要额外遵守 `HttpContent` / `LastHttpContent` 的对象语义。

所以 chunked write 最稳的定位，不是“又一个专门处理文件的 handler 分支”，而是：**它把大对象/未知长度输入重新建模成可渐进消费的源，再让前面已经讲清楚的出站主线一段一段接住它。**这条主线并没有被绕开：pending bytes、flush 推进、失败收尾和 promise 完成都仍然成立，只是它们现在面对的不再是一块已成型消息，而是一条逐块产出的输入源。

这也解释了为什么 `ChunkedFile` / `ChunkedNioFile` 文档都特意提醒：如果操作系统支持 zero-copy，可能更适合 `FileRegion`。因为 chunked write 的重点从来就不是“任何大对象都一定是最佳性能”，而是“当数据必须渐进取出时，如何把这个过程纳入 Netty 的出站和协议边界”。

## 收网：大对象写出的关键，不是更大，而是不能假设对象已完整成型

现在可以把整条主线收回来。

- `ChunkedInput` 把大对象或未知长度输入抽象成一条可渐进消费的源，而不是已成型消息。  
- `ChunkedFile`、`ChunkedNioFile`、`ChunkedStream` 分别适配文件、NIO 文件和普通输入流三种来源，它们共享 chunk 语义，但来源模型和结束判断不同。  
- `null` chunk 不自动等于结束，`isEndOfInput()` 才是结束语义的核心。  
- `HttpChunkedInput` 又在通用 chunk 流之上补了一层 HTTP 语义：每块包成 `HttpContent`，结束时必须送出 `LastHttpContent`。  
- 测试真正验证的，是结束、监听器通知和失败后跳过/收尾边界，而不只是“能不能把数据写出去”。

所以本篇真正要留下来的结论是：**大对象分块写出的难点，不在于数据更大，而在于不能再假设对象本体已经完整成型。**Netty 因此把这类输入先抽象成一条 chunk 流，再让出站主线按块接住、按块推进、按块失败和按块收尾。

有了这层理解，后面再去看大文件下载、HTTP chunked transfer、长输入流传输，或者与 `FileRegion` 的 zero-copy 对照，就不会再只盯着“这次 write 的对象是什么”，而会先问：这个对象现在到底是不是已经完整成型，还是它本身就必须被当成一条逐块展开的输入源。