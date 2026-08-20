# Ch7-08 PendingWriteQueue 与 CoalescingBufferQueue

## 先把出站主线里那个一直空着的位置补上

前面写 `ChannelOutboundBuffer`、writability 和 `write/flush` 的时候，其实一直有一个空白位置被刻意留着没有展开：不是所有消息都会立刻进入 `ChannelOutboundBuffer`，也不是所有写出都天然按“消息条数”组织。有些 handler 会先把消息挂起来，等某个条件满足以后再统一下放；有些写路径会把很多小块 `ByteBuf` 先合成一个按字节消费的队列，再按需要取出一部分写出去。

如果不把这两类结构单独拿出来，前面的出站主线就会一直像少了一截。读者会知道“正式进入托管区以后发生什么”，却不知道“进入托管区之前的暂挂写”和“很多小块字节如何在写出前被重新组织”是谁在负责。`PendingWriteQueue`、`AbstractCoalescingBufferQueue`、`CoalescingBufferQueue` 和 `ChannelFlushPromiseNotifier` 正好填这个空白。

它们看起来都像“队列”，但队列的语义完全不同。

- `PendingWriteQueue` 管的是“现在还不能直接写，先挂起来的消息和 promise”；
- `CoalescingBufferQueue` 管的是“很多小块 ByteBuf 按总字节视角重新组织，支持部分取出和整体写出”；
- `ChannelFlushPromiseNotifier` 管的则不是排队本身，而是“写出进度到达某个字节检查点后，该完成哪些 promise”。

如果把它们都粗暴地理解成“另一个 `ChannelOutboundBuffer`”，后面 promise 语义、writability 账本和部分切片的引用计数边界都会立刻混乱。因为这几类结构虽然都在出站路径上，但它们站的位置、管理的粒度和退出条件都不一样。

所以本篇真正要解决的核心困惑是：**在正式托管区 `ChannelOutboundBuffer` 之外，Netty 为什么还需要一层“挂起写队列”和一层“按字节聚合队列”，并且为什么连这些临时队列都必须接入 pending bytes、promise 和 release 主线。**

## 第一类问题：消息还没正式进入托管区，但不能当它不存在

最容易理解的入口，是 `PendingWriteQueue`。类注释已经直接给出定位：这是一组待后续执行的写操作队列，而且这些待写操作同样会参与当前 channel 的 writability 计算，见 `transport/src/main/java/io/netty/channel/PendingWriteQueue.java:29`。

这句话非常关键，因为它把一个常见直觉直接打掉了：很多人会下意识觉得，既然消息还没真的 `ctx.write(...)`，那它对背压和托管区大概还不算数。当前实现并不这么处理。只要消息已经被某一层业务逻辑、handler 或协议逻辑明确挂起，准备稍后写出，它就已经开始占用这条出站路径的未来压力预算。

所以 `PendingWriteQueue` 不是“业务随手放点对象的临时链表”，而是一个提前把未来写出压力、promise 生命周期和失败清理收进来的挂起层。它站在正式托管区之前，但它不能装作与正式托管区无关。

如果这一步没有被认真建模，后面会立刻出两个问题：

- channel 还会乐观地报告自己可写，因为那些“暂时挂着、其实马上就要写出去”的消息完全没进账；
- 这些消息一旦在挂起阶段就失败或被取消，又会因为没有统一释放路径而直接泄漏。

所以 `PendingWriteQueue` 的意义，不在于“提供一个队列容器”，而在于：**把还没正式进入 `ChannelOutboundBuffer` 的消息，也拉进同一套出站语义体系里。**

## `PendingWriteQueue`：挂起写也必须先进账、先 touch、先绑定 promise

真正看源码，这种“提前入账”的思路从 `add(msg, promise)` 就开始了。

方法先检查 event loop 上下文、校验参数，再用 `size(msg)` 估算消息大小，随后创建一个 `PendingWrite` 节点链到队尾，增加 `size` 和 `bytes`，并通过 `tracker.incrementPendingOutboundBytes(write.size)` 把这条消息先计入 pending bytes，见 `transport/src/main/java/io/netty/channel/PendingWriteQueue.java:101`。

这里最值得注意的不是“它有个链表”，而是它还没真正 `invoker.write(msg, promise)`，就已经先把待写压力算进去了。这再次证明 `PendingWriteQueue` 并不是“纯业务侧暂存区”，而是出站背压链的一部分。

紧接着它又会对消息做 `touch()`，见 `transport/src/main/java/io/netty/channel/PendingWriteQueue.java:123`。这一步把它和前面所有 ownership、leak detector 的主线又接上了：即使消息还没正式进入 `ChannelOutboundBuffer`，只要它已经进入挂起写队列，就值得在调试层留下更清晰的轨迹。因为如果这条挂起消息后面漏了释放、或者在 re-entrant fail 路径里丢了，定位时你首先要找的就是“它曾经被哪一层挂在这里”。

所以 `add(...)` 一次操作里实际上同时发生了三件事：

1. 这条消息开始有一个“稍后再写”的挂起身份；
2. 这条身份已经进入当前 channel 的 pending bytes 账本；
3. 这条消息也开始接受 leak 定位语义。

这三件事缺一不可。只挂消息不进账，背压就失真；只进账不 touch，排障证据就变弱；只记证据不绑定 promise，后面批量成功或失败时又没法整体收尾。

所以 `PendingWriteQueue` 的第一层心智模型可以先立住：**它不是“写之前的随手容器”，而是“写之前的预托管层”。**

## 它最重要的不是 `add()`，而是两条出口：批量下放与批量失败

真正决定 `PendingWriteQueue` 值不值得独立成篇的，不是它怎么挂消息，而是它怎么退出。因为一旦消息已经提前进入账本和 promise 主线，退出方式就不能再模糊。

### `removeAndWriteAll()`：从挂起层统一下放到正式写路径

`removeAndWriteAll()` 会先创建一个总 promise，再用 `PromiseCombiner` 把每条消息自己的 promise 聚起来，然后把当前链头开始的所有消息逐条 `invoker.write(msg, promise)`，见 `transport/src/main/java/io/netty/channel/PendingWriteQueue.java:141`。

这里的关键不是“批量写”，而是它明确在做一层阶段转换：消息从“挂起写层”进入“正式写路径”。在这一步之前，消息虽然已经进了 pending bytes 账本，但还没真的进入 `ChannelOutboundBuffer`；在这一步之后，正式 write 主线才开始接手。

源码里还有一句特别重要的注释：如果其中某些 promise 在完成时又触发了新的写，这些新写会把队列“复活”，因此必须一直处理到队列真正为空，见 `transport/src/main/java/io/netty/channel/PendingWriteQueue.java:151`。这说明这条队列的出口并不是一个“写完当前数组就结束”的平面过程，而是要面对 re-entrant write 这种真实运行时边界。

### `removeAndFailAll()`：挂起层失败时也必须批量 release

另一条关键出口是 `removeAndFailAll(cause)`。它会循环清空当前链，对每个 `PendingWrite` 先 `ReferenceCountUtil.safeRelease(write.msg)`，再 fail 对应 promise，最后 recycle 节点，见 `transport/src/main/java/io/netty/channel/PendingWriteQueue.java:178`。

这条路径再次证明：挂起层不是“还没真的写，所以失败时随便丢”。恰恰相反，只要消息已经进入这层，就已经拥有了真正的 ownership、pending bytes 和 promise 语义。失败时如果不 release 消息本体、不回滚账本、不结束 promise，这层挂起写就会从临时缓冲变成真正的语义黑洞。

所以 `PendingWriteQueue` 最重要的设计不是“让消息晚点写”，而是让“晚点写”这件事本身也服从和正式出站主线一样严肃的退出规则。

## `PendingWrite` 和 `Entry` 很像，但它们并不站在同一层

很多人看到 `PendingWriteQueue.PendingWrite` 会本能地把它和 `ChannelOutboundBuffer.Entry` 画等号：都是链表节点、都持有 `msg/promise/size`、都带 Recycler 壳，看起来像是一个东西的两份实现。这个直觉很危险，因为它掩盖了它们真正不同的站位。

`PendingWrite` 的字段确实很简洁：`next`、`size`、`promise`、`msg`，并且自己也挂在 `Recycler` 上，见 `transport/src/main/java/io/netty/channel/PendingWriteQueue.java:303`。但它和 `Entry` 最大的差异不是字段多少，而是**所处阶段不同**。

- `PendingWrite` 站在正式托管区之前。消息还只是“准备稍后再调用 write”。
- `Entry` 站在正式托管区之内。消息已经进入 `ChannelOutboundBuffer`，并且开始经历 unflushed/flushed/remove 这些阶段。

也就是说，二者虽然都是运行时壳，但管理的是不同阶段的同一条出站链：

`业务/handler 决定暂挂 -> PendingWrite`

`真正调用 write -> ChannelOutboundBuffer.Entry`

这个差异非常重要，因为它决定了两者各自绑定的账本也不同。`PendingWrite` 主要面对的是挂起层的 pending bytes 和 promise 聚合；`Entry` 则直接进入 `ChannelOutboundBuffer` 的 pendingSize、writability 和 flush/remove 主线。

所以这篇一定要把它们分开讲，而不能一句“都是壳”带过去。前者解决的是“写之前的预托管”，后者解决的是“写之后的正式托管”。这两层如果不分清，读者就会误以为出站路径只有一个大队列，实际上 Netty 在正式托管区前面还专门留了一道受控的缓冲带。

## 第二类问题：很多小块 ByteBuf 先要按“字节”而不是“消息”组织

`PendingWriteQueue` 解决的是“现在还不能直接写”的问题，但还有另一类场景，它关心的不是“晚点写哪条消息”，而是“现在手上有很多小块 `ByteBuf`，我想按字节数重新组织它们”。这就是 `AbstractCoalescingBufferQueue` 和 `CoalescingBufferQueue` 出场的地方。

这类队列的核心视角和 `PendingWriteQueue` 完全不同。它不问“有多少条待写消息”，而问“现在总共有多少可读字节，我能不能先拿走其中前 7 个字节，剩下的下次再处理”。只要 framing、分块发送、HTTP/2 data 分片或其他聚合写场景存在，这种字节视角就很有价值。

`CoalescingBufferQueue` 的类注释已经把定位说得很清楚：生产者不断添加 `ByteBuf`，消费者则可以按任意长度取出字节，这样既能把很多小 buffer 合成一个更大的输出，也能把一个较大的输入按较小块拆出去，见 `transport/src/main/java/io/netty/channel/CoalescingBufferQueue.java:23`。

所以理解它的第一步，也要先改掉一个直觉：这不是“消息队列的另一种写法”，而是“字节队列”。只要这个直觉不改，后面的 retained slice、compose、partial remove 和 listener 聚合都会显得怪异。

## `AbstractCoalescingBufferQueue`：它管理的是 `ByteBuf + listener/promise` 的配对序列

`AbstractCoalescingBufferQueue` 内部维护的不是一个 `Queue<ByteBuf>`，而是一个 `ArrayDeque<Object>`，名字叫 `bufAndListenerPairs`，见 `transport/src/main/java/io/netty/channel/AbstractCoalescingBufferQueue.java:34`。这已经说明它不只是缓存数据块，还要同时记住：这些数据块在被完整消费或写出后，该完成哪些 promise 或 listener。

添加路径也体现了这种配对语义。无论是 `addFirst` 还是 `add`，它都会先 `buf.touch()`，然后把 `ByteBuf` 和可选的 `ChannelFutureListener` 或 promise 依次压进队列，同时增加 `readableBytes`，见 `transport/src/main/java/io/netty/channel/AbstractCoalescingBufferQueue.java:56`、`:96`。这意味着它一边在做“字节聚合”，一边还在保留“这些字节来自哪个 promise/listener 语义单元”的关系。

这条关系极其重要，因为 `remove(...)` 并不是简单地返回一个拼好的 `ByteBuf`。它还要确保：当某个原始 buffer 的最后一个字节真的被取走时，对应的 promise/listener 才能挂到这次 aggregate promise 上。也正因为如此，它才不能只维护一个 `Queue<ByteBuf>`；它必须维护“buffer 和完成语义的配对序列”。

所以这条队列真正组织的是：

- 数据层：有多少字节；
- 边界层：这些字节来自哪些原始 buffer；
- 完成层：哪些 promise/listener 应该在对应字节被完全消费后再完成。

只要把这三层看清，后面的 remove 和 compose 就容易理解了。

## `remove(bytes, aggregatePromise)`：先按长度取，再把完成语义延后到 aggregate promise

`AbstractCoalescingBufferQueue.remove(...)` 是这类队列最值得认真读的一段。它并不是“出队一个元素”，而是“按最多 N 个可读字节构造一个返回缓冲区”。

实现会不断 poll 队列元素：如果拿到的是 `ByteBuf`，就看它的 `readableBytes()` 是否超过当前还需要的字节数；若超过，就把原 buffer 放回队列头，并通过 `readRetainedSlice(bytes)` 取出一段可用切片；如果没有超过，就把整块 buffer 直接并进返回值，必要时用 `composeFirst` 或 `compose` 聚合起来，见 `transport/src/main/java/io/netty/channel/AbstractCoalescingBufferQueue.java:143`。

这说明它的核心能力不是“缓存很多 ByteBuf”，而是“把很多 ByteBuf 重新投影成一个按字节长度消费的视图”。而且这个视图不是简单 copy 出来的，它可能直接返回原 buffer，也可能返回 retained slice，也可能拼成 `CompositeByteBuf`。这意味着引用计数边界始终都在，根本没有因为“我只是做聚合队列”就消失。

更重要的是 promise 语义。队列里如果遇到 `ChannelFutureListener` 或 `DelegatingChannelPromiseNotifier`，它并不会立刻触发它们，而是把它们挂到当前传入的 `aggregatePromise` 上，见 `transport/src/main/java/io/netty/channel/AbstractCoalescingBufferQueue.java:193`。这意味着“某块字节已经被消费”的完成语义被故意推迟到聚合后的那次写出或完成点。

所以 `remove(...)` 同时在做三件事：

1. 按字节长度重新切片或拼接底层 buffer；
2. 维护正确的引用计数与 retained slice 边界；
3. 把原始 promise/listener 的完成时机转嫁到 aggregate promise 上。

这就是为什么它不能被简单看成“高效点的 ByteBuf 列表”。它其实是在重新组织“字节视图”和“完成语义”之间的对应关系。

## `CoalescingBufferQueue`：这是一个面向 Channel 的具体落地，而不是纯算法工具

`CoalescingBufferQueue` 自己的代码量不大，但它的落地点很明确：它持有一个 `Channel`，默认用这个 channel 的 allocator 去移除字节、去失败剩余队列、去决定是否把当前 readable bytes 也接入 writability 统计，见 `transport/src/main/java/io/netty/channel/CoalescingBufferQueue.java:35`。

这说明它不是一个脱离 Netty 运行时的纯聚合算法工具，而是一个明确站在 channel 语境里的字节聚合队列。尤其是构造器上的 `updateWritability` 开关：当它为 true 时，父类会把 channel 传进去，让内部 `PendingBytesTracker` 生效；为 false 时，它就只是纯聚合视角，见 `transport/src/main/java/io/netty/channel/CoalescingBufferQueue.java:46`。

这点很重要，因为它再次说明：Netty 并没有强迫所有临时队列都一定参与背压主线，但一旦某条队列确实会影响“未来要写出去多少字节”，它就保留了把这些字节纳入 channel writability 账本的能力。

也就是说，`CoalescingBufferQueue` 兼具两种姿态：

- 只做字节聚合；
- 或者既做字节聚合，又参与 channel 的 pending bytes / writability 视角。

这让它既能服务 framing、partial remove 这类纯字节问题，也能在需要时和整个出站背压模型对齐。

## `ChannelFlushPromiseNotifier`：它不是队列，而是“写到某个检查点后完成哪些 promise”

在这组结构里，`ChannelFlushPromiseNotifier` 最容易被顺手忽略，因为它不像前面几个类那样直接缓存消息或字节。可它解决的是另一个非常关键的问题：**如果一批写出跨越了多个逻辑 promise，我怎么按“写到多少字节”这个进度来完成它们。**

它内部维护的是 `writeCounter` 和一组 `FlushCheckpoint` 队列，见 `transport/src/main/java/io/netty/channel/ChannelFlushPromiseNotifier.java:25`。调用方可以通过 `add(promise, pendingDataSize)` 注册一个 promise，并声明：当总写出字节数推进到当前写计数再加上这段大小时，这个 promise 就应该被完成，见 `transport/src/main/java/io/netty/channel/ChannelFlushPromiseNotifier.java:63`。

后续每次写出了一些字节，就通过 `increaseWriteCounter(delta)` 推进总计数；再调用 `notifyPromises()`，把已经越过 checkpoint 的 promise success 或 fail，见 `transport/src/main/java/io/netty/channel/ChannelFlushPromiseNotifier.java:80`、`:103`。

这说明它关心的不是“哪条消息出队了”，而是“当前总共写出了多少字节，哪些 promise 该在这个总进度位置被完成”。对于 `CoalescingBufferQueue` 这类会把多块数据重新拼接、切片和延后完成的结构来说，这种按检查点完成的思路非常自然：一旦聚合写出改变了原始消息边界，真正稳定的完成依据就不再是“第几个消息”，而是“已经走过了多少写出字节”。

所以在这组专题里，`ChannelFlushPromiseNotifier` 不是“另一个 queue”，而是“字节进度到 promise 完成”的桥梁。它让按字节组织的数据队列，依然能把完成语义稳定地对齐回去。

## 测试真正揭露的问题：这些队列都不是纯容器，而是边界调度器

把测试串起来看，会发现它们最关心的根本不是“队列里有几个元素”，而是“这些结构会不会把边界搞错”。

### `PendingWriteQueueTest` 证明：挂起写如果不参与主线，会直接污染 writability 和 release

`shouldFireChannelWritabilityChangedAfterRemoval()` 是最典型的一条。测试把一条大于 high watermark 的消息放进 `PendingWriteQueue`，然后在 `channelWritabilityChanged()` 里调用 `queue.remove()`；如果实现没有先移除当前节点、再触发回调，就可能双重删除同一条消息，最后导致 double release，见 `transport/src/test/java/io/netty/channel/PendingWriteQueueTest.java:93`。

这说明 `PendingWriteQueue` 最大的风险不在“消息有没有排上队”，而在“排队、回调、移除和 release 的时序是否正确”。只要这个时序错了，writability 和 ownership 就会同时坏掉。

`testRemoveAndWriteAllReentrantWrite()` 和 `testRemoveAndFailAllReentrantFailAll()` 又进一步证明了 re-entrant 边界。`removeAndWriteAll()` 期间 promise listener 可以再向队列添加新消息；`removeAndFailAll()` 期间 fail listener 也可能再触发新的失败写。实现必须一直处理到队列真正为空，而不能假设“我遍历一轮链表就结束”，见 `transport/src/test/java/io/netty/channel/PendingWriteQueueTest.java:202`、`:221`。

### `CoalescingBufferQueueTest` 证明：字节视角和完成语义必须同时保留

`testAggregateWithPartialRead()` 很能说明问题。队列里先放 `cat` 和 `mouse` 两个 buffer，再只取前 4 个字节，返回 `catm`；这时 `catPromise` 只有在 aggregate promise success 后才完成，而 `mouse` 对应的 listener 还不能完成，因为它还有剩余字节没被消费，见 `transport/src/test/java/io/netty/channel/CoalescingBufferQueueTest.java:146`。

这正是前面反复强调的三层关系：字节可以先按部分视图取走，但完成语义必须等原始 buffer 的最后一个字节真的被消费以后再触发。

`testWritabilityChanged()` 也说明，一旦 `CoalescingBufferQueue` 配成参与 writability 账本，它就不再是纯容器，而是出站压力模型的一部分。它不能只会拼 buffer，还必须会在进出队时维护正确的字节规模。

所以这些测试给出的总判断非常明确：**`PendingWriteQueue` 和 `CoalescingBufferQueue` 都不是“容器类细节”，而是站在正式托管区之前、或者旁边，负责提前调度 ownership、writability、promise 和字节边界的辅助托管层。**

## 收网：它们不是第二个 `ChannelOutboundBuffer`，而是正式托管区之外的两种辅助托管层

现在可以把整条主线收回来了。

- `PendingWriteQueue` 处理的是“现在还不能正式 write，但这条消息已经不能再假装不存在”的挂起写阶段。它先把消息纳入 pending bytes 和 promise 主线，之后再批量写出或批量失败。  
- `PendingWrite` 虽然和 `ChannelOutboundBuffer.Entry` 一样都是壳，但它站在正式托管区之前，而不是里面。  
- `AbstractCoalescingBufferQueue` / `CoalescingBufferQueue` 处理的是“很多小块 ByteBuf 如何按字节长度重新组织、部分取出、聚合写出以及把原始 promise/listener 延后到 aggregate promise 上”的问题。  
- `ChannelFlushPromiseNotifier` 则解决“写出字节推进到某个检查点以后，该完成哪些 promise”的对齐问题。  
- 它们全都不是第二个 `ChannelOutboundBuffer`；它们只是位于正式托管区之前、旁边或之上的辅助托管层。正因为仍然在主线附近，它们才必须继续服从 ownership、pending bytes、writability 和 promise 这些语义边界。

所以本篇真正要留下来的结论是：**出站主线并不只靠 `ChannelOutboundBuffer` 一个人完成。`PendingWriteQueue` 负责把“暂时不能正式写”的消息先受控挂起来，`CoalescingBufferQueue` 负责把“很多小块字节”重新组织成可部分消费的写出视图，而 `ChannelFlushPromiseNotifier` 负责把写出进度重新对齐回 promise。**

把这三类辅助结构看清以后，前面 ownership、writability、flush、Entry/WriteTask 复用那些看似分散的专题就进一步闭环了：Netty 不是只有一个正式托管区，而是在正式托管区前后放了多层受控缓冲带。每一层都不负责全部工作，但每一层都必须继续服从同一套出站语义。