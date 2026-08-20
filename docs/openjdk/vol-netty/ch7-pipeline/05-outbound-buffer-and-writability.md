# Ch7-05 ChannelOutboundBuffer 与 writability

## 先把最容易产生错觉的地方挑出来

很多人第一次在 Netty 里遇到背压，通常不是在网络协议层，而是在一个看起来很普通的现象上：业务线程只是 `write()` 了几个消息，`channel.isWritable()` 却突然变成了 `false`，紧接着 `channelWritabilityChanged()` 开始回调。更让人困惑的是，有时消息明明还没真正发出去，channel 已经不可写；有时消息已经 flush 了，channel 还是没立刻恢复可写；再往下看，还会发现同一个 channel 除了系统自己的可写状态，居然还允许用户自定义“额外不可写位”。

如果脑子里一直带着“write 就是发包”这个直觉，这一切都会显得很奇怪。因为在这个直觉里，消息应该在 `write()` 那一刻立刻下沉到底层 socket，channel 的可写性也应该主要由内核发送缓冲区决定。可 Netty 的运行时并不是这样组织的。对它来说，`write()` 首先不是一次真正的发送动作，而是一次进入托管区的交接动作。消息会先进入 `ChannelOutboundBuffer`，先被挂到一条出站链上，先计入待写总字节数，先参与当前 channel 的背压判断，之后才轮到 flush、I/O 线程、底层写出、部分写出、失败清理这些后续阶段。

所以理解 `channel.isWritable()` 的前提，不是先记高低水位线，而是先改掉“write 立刻发送”的心智模型。**Netty 的 writability 本质上是在回答：以当前用户态托管区里还没真正移除的待写数据规模来看，这个 channel 还适不适合继续无节制堆消息。**它不是“socket 现在一定还能写几个字节”的内核镜像，而是 Netty 自己的一层运行时节流判断。

这层判断一旦看清，很多现象就顺了。为什么一个大 `ByteBuf` 会比十个小消息更容易触发不可写？因为背压统计看的不是消息个数，而是待写总字节数。为什么要有高水位和低水位两条线？因为如果只用一条阈值，channel 会在边界附近疯狂抖动。为什么任务拒绝、取消、close 失败路径都得主动清理 pending bytes？因为只要待写规模统计失真，writability 就会整条偏掉。

所以本篇真正要解决的核心困惑不是“WaterMark API 怎么配”，而是：**对象写出去之前到底先去了哪里，Netty 又是如何根据这段托管区里的待写压力来决定 channel 是否还可继续写。**

## 第一步先改掉直觉：`write()`、`flush()`、真正移除，是三件事

要理解 `ChannelOutboundBuffer`，第一步得把三个在日常口语里经常混成一个动作的词拆开：`write()`、`flush()`、真正写出并移除。

在 Netty 里，`write()` 的第一站是 `ChannelOutboundBuffer.addMessage(...)`。这个方法会把消息包装成一个 `Entry`，接到链表尾部，必要时把它设成当前 `unflushedEntry`，然后对消息做一次 `touch()`，最后增加 pending bytes，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:114`。这里还没有发生真正的 socket 写出动作。消息只是从“业务手里的对象”变成了“出站缓冲区托管的一份待处理对象”。

接下来是 `flush()`。`ChannelOutboundBuffer.addFlush()` 会把当前 `unflushedEntry` 起始的那一批消息标记成 flushed，也就是从“还没允许发”的状态转成“已经可以被后续 `doWrite` 处理”的状态，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:142`。这一步依然不是“消息已经发到网卡了”，它只是完成了一个阶段切换：从入队但未激活，变成已激活、可供发送循环消费。

真正写出并移除，则发生在更后面。`remove()` 会在当前 flushed entry 完整写完以后，把它从链表头拿掉、释放消息、完成 promise，并减少 pending bytes，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:275`。如果是部分写出，`removeBytes(long writtenBytes)` 还会只推进当前 `ByteBuf` 的 `readerIndex`，等到这条消息真的全部写完以后才完整移除，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:361`。

这三步不能混。因为只要一混，后面的背压理解就全乱了。

- 如果把 `write()` 当作发送成功，就会误以为消息一入队就该立即减少 pending bytes。
- 如果把 `flush()` 当作消息已移除，就会误以为 flush 之后 channel 应该立刻恢复可写。
- 如果忽略“部分写出”这层，就会误以为一条消息不是在缓冲区里，就是已经完全离开了缓冲区。

这里最好直接把源码里的三个落点和三种阶段对上：

- `unflushedEntry`：已经 `addMessage()`，但还没 `addFlush()`；
- `flushedEntry`：已经 `addFlush()`，可以被后续发送循环消费；
- `remove()/removeBytes()`：真正写完或部分写完以后，消息才开始离开托管区。

`ChannelOutboundBuffer` 真正组织的是一个至少三阶段的生命周期：

1. **unflushed**：消息已经进入托管区，但还没被 flush 激活；
2. **flushed**：消息已经允许后续发送循环处理，但可能还没真正写完；
3. **removed**：消息已经完整写出或失败移除，pending bytes 才真正减少。

这就是为什么说 `write != flush != remove`。它们不是同义词，而是同一份对象在托管区里经历的连续阶段。

这个阶段划分不只是为了实现方便，而是直接决定了背压语义该落在哪。对 Netty 来说，只要消息还在托管区里、还没有真正从缓冲区移除，它就仍然算待写压力的一部分。也正因为如此，`channel.isWritable()` 判断的不是“是否已经 flush”，而是“当前还剩多少未完成的待写负担”。

## `ChannelOutboundBuffer` 真正统计的不是消息数量，而是待写总字节数

理解了三阶段以后，下一步就能回答另一个常见误会：为什么 Netty 不按消息条数背压，而是非得引入一套 pending bytes 统计？

答案很简单，因为消息条数对真实压力几乎没有描述能力。一个 1KB 的 `ByteBuf` 和一个 10MB 的 `ByteBuf`，在“消息个数”这个维度上都只算 1 条；一个 `FileRegion` 可能根本不是普通内存缓冲区，但它对出站写出压力的影响却可能更大。如果背压只看队列长度，系统得到的就是一个几乎无效的信号。

`ChannelOutboundBuffer` 从一开始就把重心放在字节规模上。`Entry.newInstance(...)` 会把待写消息包装成条目，并把 `pendingSize` 设为消息大小加上一笔 `CHANNEL_OUTBOUND_BUFFER_ENTRY_OVERHEAD`，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:850`。这说明 Netty 统计的不是纯 payload 大小，而是“这条消息占掉的整体托管成本”。

而消息大小本身怎么估算，则由 `total(Object msg)` 和更外围的 `MessageSizeEstimator` 协同决定。对 `ByteBuf` 来说，用 `readableBytes()`；对 `FileRegion` 来说，用 `count()`；对 `ByteBufHolder` 来说，用 `content().readableBytes()`，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:210`。这已经足以说明：Netty 在背压层面关注的是“这份待写对象大概还会占多少发送压力”，而不是“它长得像不像 ByteBuf”。

真正把背压和字节数绑死的，是 `incrementPendingOutboundBytes(...)` 和 `decrementPendingOutboundBytes(...)`。前者在增加 `totalPendingSize` 后，如果结果超过 high watermark，就把 channel 设为不可写；后者在减少 `totalPendingSize` 后，如果结果跌回 low watermark 以下，才恢复可写，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:176`、`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:195`。

这几行代码的意义非常直接：**Netty 的背压对象不是消息队列，而是待写总字节规模。**只要这份规模还没真正降下来，哪怕你觉得“消息已经 flush 了”“promise 也发出去了”“业务线程已经返回了”，channel 在运行时视角里仍然可能是不适合继续塞更多数据的。

这个视角还有一个很重要的推论：pending bytes 之所以可靠，不是因为它完美反映了内核 socket 缓冲区，而是因为它稳定反映了 Netty 自己这层托管区的压力。如果这层压力已经堆高了，业务继续往里灌消息，最终的风险往往不是“网络马上就坏”，而是对象越积越多、失败路径越来越贵、出站清理越来越重、应用自己的内存峰值和延迟也一起抖起来。

所以从设计目标看，`ChannelOutboundBuffer` 这套统计不是为了让 `isWritable()` 拟合一个绝对真实的系统状态，而是为了在用户态尽早建立一个足够实用的节流信号。只要这个信号能相对稳定地反映“托管区是不是已经太满”，它就达到了 Netty 背压层的目的。

## 为什么一定要 high / low 两条线，而不是一个阈值

只要明白了背压按字节统计，接下来最自然的问题就是：为什么还要多此一举搞两个阈值？一个上限不够吗？比如超过 64KB 就不可写，低于 64KB 就可写，逻辑不是更简单？

表面上看更简单，实际上会抖动得非常厉害。

`WriteBufferWaterMark` 的文档已经把设计意图说得很清楚：待写字节数超过 high watermark 时，`Channel.isWritable()` 开始返回 false；只有在它之后再次下降，并且跌回 low watermark 以下时，才恢复 true，见 `transport/src/main/java/io/netty/channel/WriteBufferWaterMark.java:21`。这其实就是在可写状态上加了一条迟滞带。

如果只用一个阈值，系统会出现什么问题？假设阈值是 64KB。某一刻总待写字节数从 63KB 长到 65KB，于是 channel 变成不可写；很快底层又消费掉 2KB，回到 63KB，于是立即恢复可写；业务再塞 3KB，又变不可写。只要业务写入和底层写出速度接近，这个状态就会在边界附近来回抖动，`channelWritabilityChanged()` 会被频繁触发，业务逻辑也会在“停一下、再写一点、再停一下”的细碎节奏里来回跳。

高低水位线的作用，就是把这个边界从一条线变成一个区间。超过高水位，说明真的积压到危险区了，该明确发出“先别继续灌”的信号；之后哪怕开始下降，也不急着立刻恢复，而是等它真正退回更安全的低水位以下，再把可写性打开。这样就把“不可写 -> 可写”的切换从边界瞬时抖动改成了有余量的区间切换。

`bytesBeforeUnwritable()` 和 `bytesBeforeWritable()` 这两个观测方法也很能说明这个设计细节。它们都用了 `+1` 的处理，并在注释里明确写出：writability 的变化发生在**越过阈值**时，而不是等于阈值时，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:769`、`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:782`。这说明 high/low watermark 不是模糊建议，而是精确参与状态切换逻辑的双边界。

所以从认知上最好不要把它理解成“两个配置值”，而要理解成“一个迟滞带”。

- high watermark 定义的是：再往上，托管区压力已经不适合继续无节制增长；
- low watermark 定义的是：只有退回到这里以下，才说明托管区真的缓下来了。

这条迟滞带存在以后，writability 才能成为一个足够稳定、适合业务逻辑订阅的信号。如果没有它，`channelWritabilityChanged()` 很快就会从“背压边界事件”退化成“边界噪声事件”。

## `channel.isWritable()` 不是只看系统位，还要叠加用户位

只讲高低水位线还不够，因为 `channel.isWritable()` 还有第二层很容易被忽略的来源：用户自定义 writability 位。

很多人以为，只要 `totalPendingWriteBytes` 降回 low watermark 以下，channel 就一定恢复可写。`ChannelOutboundBufferTest` 正好证明事情没有这么简单。

在 `testUserDefinedWritability1/2()` 里，测试先验证所有用户定义 writability 位默认都是 true，然后把某一位设成 false，结果 `channel.isWritable()` 立刻变成 false；即便再把别的位改动，只要还有任一位没恢复，channel 仍保持不可写，见 `transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:333`。这说明对于 Netty 来说，可写性不是单一来源，而是一个合成结果：系统根据 pending bytes 维护的一组状态位，再叠加用户自己维护的额外位。

`testMixedWritability()` 更直接。它先通过写入超过 high watermark 的数据触发一次系统级不可写，然后手工把某个用户位也设成 false。之后即使 `flush()` 把 `totalPendingWriteBytes` 降回 0，channel 仍然不会恢复可写；直到用户位重新设回 true，`channelWritabilityChanged()` 才再次触发恢复事件，见 `transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:391`。

这个测试的启发非常大：**对 Netty 来说，系统背压和业务背压是可以叠加的。**系统位负责表达“出站托管区现在太满了”；用户位则允许业务表达“即使系统层面还可写，我也知道当前链路、下游、配额或协议状态不适合继续写”。最终 `isWritable()` 返回的是这两类约束共同作用后的结果。

这层设计非常实用，因为框架不可能预先知道所有业务背压条件。某些场景下，业务自己比运行时更早知道“现在该停一下”，比如下游协议窗口还没恢复、应用级队列已经接近上限、或者某个 handler 正在执行昂贵回退逻辑。用户自定义 writability 位恰好给了这类场景一个直接接入统一可写性判断的入口。

这也意味着，排障时不能只盯着 watermark。假如 `totalPendingWriteBytes` 已经很低，channel 却仍然不可写，第一个要问的问题不是“Netty 为啥没恢复”，而是“是不是还有用户定义位没有释放”。测试已经明确告诉我们：只看系统 pending bytes，得不出完整答案。

所以最准确的理解是：`channel.isWritable()` 从来不是“当前待写字节数是否过线”这么单薄的一件事，它是**系统位和用户位的合成布尔结果**。前者让 Netty 能进行统一的出站背压，后者让业务可以把自己的节流条件挂进同一条可写性总线里。

## `PendingBytesTracker` 说明背压统计不是某个类的私事

讲到这里，还可以再往下补一层：这套 pending bytes 统计虽然最显眼地体现在 `ChannelOutboundBuffer` 上，但它并不是这个类的私有小账本。`PendingBytesTracker` 正是把这层共享基础设施抽出来的那一层。

`PendingBytesTracker` 自己实现了 `MessageSizeEstimator.Handle`，并包装了一份 estimator handle，见 `transport/src/main/java/io/netty/channel/PendingBytesTracker.java:20`。它暴露的核心接口只有两件事：增加待写字节数和减少待写字节数。但关键在于，它到底把这两件事记到哪里。

`newTracker(channel)` 会先判断 channel 的 pipeline 是否是 `DefaultChannelPipeline`。如果是，就创建一个直接挂在 pipeline 上的 tracker；否则再回退到 `ChannelOutboundBuffer`；如果 channel 甚至已经 closed，没有可用 outbound buffer，就继续退化成一个 noop tracker，见 `transport/src/main/java/io/netty/channel/PendingBytesTracker.java:35`。

这条分发逻辑说明了两个事实。

第一，pending bytes 的语义本来就不应该只属于 `ChannelOutboundBuffer`。它是整条出站链共同依赖的一层能力：谁在暂存待写消息，谁就应该有办法把这份压力接进统一的背压统计里。

第二，Netty 非常清楚运行时边界是不稳定的。channel 可能已经关闭，outbound buffer 可能已经不存在，某些场景里统计能力必须优雅降级，而不是因为“没地方记账了”就把写路径直接搞崩。

这也是为什么后续的 `PendingWriteQueue` 会自然接上这条线。它虽然不是 `ChannelOutboundBuffer` 本身，却同样需要在暂存消息时增加 pending bytes，在移除或失败时再减掉。这说明背压统计真正针对的不是“某个缓冲区实例”，而是“所有仍在用户态托管区里、还没有完成发送生命周期的对象”。

从方法论角度看，这个抽象很值得注意。Netty 没有把背压做成一个隐藏在单个类里的副作用，而是把“待写压力统计”抽成一层可复用基础设施，让 pipeline、outbound buffer、待写队列都能接入同一套可写性语义。这样后面无论对象被谁暂存，最终 `channel.isWritable()` 都还指向同一件事：当前整条出站托管区是否过满。

## 测试真正暴露的难点：writability 是时序现象，不是一个静态布尔值

如果只看类和字段，很容易把 writability 想成一个非常安静的状态：大概就是写多了变 false，写少了变 true。测试告诉我们的恰好相反。对于 Netty 来说，writability 更像一个运行时时序现象，它会随着线程切换、事件排队、flush、失败清理和任务拒绝不断交错。

`ReentrantChannelTest` 里的注释几乎可以当成一张教学图来读。它描述了这样一串可能发生的过程：一次 write 是从非 I/O 线程发起的，因此 pendingWriteBytes 可能先增加，从而先触发一次不可写；随后 write 事件在 I/O 线程真正执行，某些中间阶段又会减少或再次增加 pendingWriteBytes；最后 flush 真正移除消息时，再次触发 writability 变化，见 `transport/src/test/java/io/netty/channel/ReentrantChannelTest.java:60`。

这段测试最重要的价值，不是证明某一个固定顺序，而是提醒我们：**writability 回调不是某个操作的直接一一对应结果，它是多个线程和多个阶段交错之后暴露出来的运行时信号。**同一个写流程里，`channelWritabilityChanged()` 完全可能出现不止一次，甚至和 `write()`、`flush()` 的可观察顺序穿插在一起。

`ChannelOutboundBufferTest.testWriteTaskRejected()` 则从另一个方向说明了这个问题。它模拟 executor 已经无法接收更多任务的场景，然后验证：当 write 最终因为 `RejectedExecutionException` 失败时，对应 `ByteBuf` 的引用计数必须降到 0，同时 `totalPendingWriteBytes()` 必须回到 0，见 `transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:430`。这说明写流程哪怕没有真的走到底层发送，只要它在托管区里被接纳过、背压统计曾经加过账，失败路径也必须把这笔账完整冲回去。

这两组测试连在一起，给了一个很关键的排障结论：你不能把 writability 当作“某个 setter 改了一个布尔值”。它更像一份围绕待写生命周期不断修正的状态投影。

- 入队会增加压力；
- flush 只是阶段切换，不一定立刻减少压力；
- 真正移除或失败清理才会减少压力；
- 线程切换会让这些阶段的可观察顺序变复杂；
- 用户位又会让恢复可写的时机进一步延后。

所以当业务看到 `channelWritabilityChanged()` 频繁触发时，最忌讳的就是先用同步心智去理解它。Netty 想表达的不是“我刚才写了几条消息”，而是“整个托管区在这段时间里经历了几次足以影响继续写入决策的压力变化”。

## 真正排障时，应该按什么顺序想

前面的机制一旦串起来，排障顺序就能从“猜网络”“猜 socket”变成一套更可落地的检查流程。

第一步，先问消息现在处在哪个阶段：刚 `write()` 进了 unflushed 区，已经 `flush()` 进了 flushed 区，还是已经被 `remove()` 真正移除？如果这个阶段判断错了，后面很容易误以为“都 flush 了为什么还不可写”。

第二步，看 `totalPendingWriteBytes()` 和 high/low watermark 的关系。真正需要回答的问题不是“现在写了几条消息”，而是“托管区里总共还压着多少待写字节”。尤其要注意 `bytesBeforeUnwritable()` 和 `bytesBeforeWritable()` 给出的不是模糊建议，而是当前距离状态切换还差多少字节的观测值，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:765`。

第三步，如果待写字节数已经很低甚至归零，channel 却仍然不可写，就不要继续死盯系统位了。优先检查用户定义 writability 位是否还没恢复。`ChannelOutboundBufferTest.testMixedWritability()` 已经说明：系统位恢复并不自动抹掉业务位的额外限制，见 `transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:416`。

第四步，看失败或拒绝路径有没有把 pending bytes 冲干净。只要某条失败路径吞掉了对象释放或 pending bytes 回滚，channel 的可写状态就可能长期卡在错误值上。`testWriteTaskRejected()` 之所以重要，正因为它证明了“即使没有真的发送，也必须把托管区账目清回去”。

第五步，别忘了 writability 是时序现象。一次非 I/O 线程发起的写、一次重入 flush、一次执行器拒绝，都可能让回调顺序比直觉复杂得多。看到多次 `channelWritabilityChanged()` 并不自动意味着 bug，更可能意味着托管区压力在多个阶段先后跨过了不同边界。

用这套顺序回头看，`channel.isWritable()` 就不再是一个神秘布尔值，而是出站托管区健康度的聚合信号。你看到它变化，本质上是在看到一份运行时账本的关键阈值被越过或退回。

## 收网：`ChannelOutboundBuffer` 不是“暂存区”，而是出站托管区与背压信号源

现在可以把整条主线收回来。为什么只是 `write()` 一下，channel 就可能立刻不可写？因为 `write()` 在 Netty 里首先不是发包，而是把消息交给 `ChannelOutboundBuffer` 进入托管区；只要这份托管区里的待写总字节规模跨过了 high watermark，系统就有足够理由先阻止业务继续无节制堆消息。

- `addMessage()` 负责入队、触摸消息、增加 pending bytes，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:114`。  
- `addFlush()` 负责把消息从 unflushed 推进到 flushed，可供后续发送循环处理，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:142`。  
- `remove()` / `removeBytes()` 负责在真正写完或部分写完时推进生命周期，并在完整移除时减少 pending bytes，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:275`、`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:365`。  
- `WriteBufferWaterMark` 用 high/low 双阈值给 writability 增加迟滞带，避免边界抖动，见 `transport/src/main/java/io/netty/channel/WriteBufferWaterMark.java:21`。  
- `PendingBytesTracker` 说明这套待写压力统计是 pipeline / outbound buffer 共享的基础设施，而不是某个类的私账，见 `transport/src/main/java/io/netty/channel/PendingBytesTracker.java:35`。  
- 用户自定义 writability 位又把业务自己的节流条件并入同一条总线，测试已经证明它们会和系统位共同决定最终 `isWritable()`，见 `transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:333`。

所以本篇真正要留下来的心智模型是：**`ChannelOutboundBuffer` 不是“暂时放一放消息的地方”，而是 Netty 出站托管区与背压信号源。**它一边托管对象从 write 到真正移除的这段生命周期，一边把这段生命周期里的待写压力折算成 `channel.isWritable()` 这样一个可订阅的信号。

这也正好把下一篇自然引出来。既然这篇已经说明“对象写出去之前先被谁托管，以及托管压力如何变成可写性”，接下来就该看 `PendingWriteQueue` 和 `write / flush` 本身：当消息还没正式进入 `ChannelOutboundBuffer`、或者为了减少 syscall 需要延迟 flush 时，Netty 又是如何继续维持这套托管和背压语义不失真的。只有把这条线再接上，出站运行时的全图才会真正闭环。