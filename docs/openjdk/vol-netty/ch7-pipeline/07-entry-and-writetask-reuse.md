# Ch7-07 ChannelOutboundBuffer.Entry 与 WriteTask：复用落点专题

## 先把“对象复用”这件事从工具层拉回真实热点

前面几篇已经把公共底盘铺开了：`FastThreadLocal` 解决线程本地热点访问，`Recycler` 解决受控的小对象复用，`PoolThreadCache` 解决底层区域描述的线程本地回收。但如果只停在这些公共工具层，读者很容易留下一个悬空感：这些基础设施看起来都说得通，可它们到底是怎么落到 Netty 真正的热点路径上的？

这个问题不回答，`Recycler` 很容易被误解成“框架里一个泛用的小工具”，而不是出站主链里的现实结构。要把这层落地看清，最合适的两个对象就是 `ChannelOutboundBuffer.Entry` 和 `AbstractChannelHandlerContext.WriteTask`。

它们都不承载业务消息语义，也不是用户 API 会直接接触的对象；但它们偏偏都站在出站路径最频繁的壳层上。一个是消息进入 `ChannelOutboundBuffer` 之后的排队壳，一个是消息跨 executor 出站时的任务壳。只要 write 足够频繁，这两类壳的创建、销毁和回收就会反复发生。

所以本篇真正要解决的核心困惑不是“Recycler 怎么实现”，而是：**Netty 到底复用了什么，为什么它复用的不是消息本体，而是围绕消息产生的运行时包装壳。**

这层区别很重要。因为一旦把“对象复用”误解成“消息本体反复利用”，立刻就会和引用计数、ownership、pending bytes、失败回滚这些主线撞车。消息本体仍然要服从自己的生命周期协议；Netty 真正想削薄的，是围绕这份消息不断产生的临时包装成本。

因此，理解 `Entry` 和 `WriteTask` 的最好方式，是把它们看成出站主链里两个不同位置的壳：

- `Entry` 属于托管区内部壳；
- `WriteTask` 属于托管区之前的异步任务壳。

有了这层定位，后面为什么它们都带着 `Recycler`，为什么取消和失败时必须连 pending bytes 一起回滚，为什么测试会关心 rejected task 以后 `totalPendingWriteBytes()` 是否归零，就都会变得顺理成章。

## `Entry` 复用的不是消息，而是“消息排队壳”

先看 `ChannelOutboundBuffer.Entry`。它的源码位置已经说明它不是独立组件，而是紧贴在出站缓冲区上的内部节点结构。类里第一件值得注意的事，就是它自带一个 `Recycler<Entry>`，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:826`。

如果只看到这里，最容易产生的误解是：既然 Entry 里有 `msg`，是不是 Netty 在复用整条消息？继续往下看就会发现完全不是。

`Entry.newInstance(...)` 做的事情非常克制：从 recycler 拿一个可用 Entry，把 `msg`、`pendingSize`、`total` 和 `promise` 填进去，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:850`。这里并没有复制消息，也没有修改消息本体的生命周期规则。Entry 只是把“这条消息现在排在托管区里，需要记录多少 pending bytes、对应哪个 promise、总量是多少”这一组出站元信息挂了上去。

这说明 Entry 复用的不是 payload，而是排队壳本身。它虽然可被回收重用，但生命周期仍然严格受 `ChannelOutboundBuffer` 托管区主线约束：只有消息完成取消、释放、账本回滚和节点脱链之后，这个壳才有资格回到 `Recycler`。真正被重复利用的是：

- 链表节点外壳；
- 记录 pending bytes 的整数字段；
- 记录总进度、总大小、缓存 `ByteBuffer` 数组的壳；
- 与 promise 绑定的临时节点身份。

这和 `PoolThreadCache` 的思路很像：不是复用用户看到的对象语义，而是复用运行时为这条对象语义准备的那层包装结构。只不过 `PoolThreadCache` 复用的是底层区域描述，这里复用的是出站排队节点。

所以理解 Entry 最关键的一步，是把它从“消息的一部分”拆出来。消息本体仍然是 `msg`；Entry 只是告诉 `ChannelOutboundBuffer`：这条消息目前站在队列里的哪个位置、占了多少托管成本、后面还有没有下一条、当前 write 进度多少。

一旦把这层分离看清，就能理解为什么 Entry 值得单独复用。因为在高频 write 场景里，消息本体也许本来就短命、不可共享或需要严格 release；但围绕它不断 new 一个节点壳、再 GC 掉这个节点壳，则是一种可以被显著削减的运行时噪声。

## Entry 为什么会直接进入 pending bytes 账本

如果 Entry 只是一个无关痛痒的链表节点，它是否复用就只会影响少量对象分配。而源码显示，Entry 并没有这么轻。它直接进入了 writability 和 pending bytes 的账本。

`newInstance(...)` 里最关键的一行不是 `entry.msg = msg`，而是 `entry.pendingSize = size + CHANNEL_OUTBOUND_BUFFER_ENTRY_OVERHEAD`，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:850`。这意味着出站托管区统计的不是“纯消息 payload 大小”，而是“消息 payload + 这条排队壳自身的托管开销”。

这件事很重要，因为它把 Entry 从一个纯内部节点提升成了背压模型的一部分。前面讲 `ChannelOutboundBuffer` 和 writability 时已经说明，Netty 用 `totalPendingSize`、high/low watermark 和用户位共同决定 `channel.isWritable()`。如果 Entry 自己的 overhead 不进账，那么大量小消息即使 payload 都不大，也可能因为节点壳本身累积出额外托管成本，却完全不反映在背压信号里。

换句话说，Entry 不只是“帮助消息排队”，它还让排队这件事本身被算进了托管区压力模型。于是它的生命周期就不再是一个纯内部实现细节，而是和 `incrementPendingOutboundBytes()`、`decrementPendingOutboundBytes()`、`channelWritabilityChanged()` 这些外部可观察行为绑在一起了。

这也是为什么 Entry 的取消、释放和回收不能只做局部字段清空。如果某条消息被取消了，Entry 不只是把 `msg` 放掉就完事；它还得把 pending bytes 一起处理干净，否则 channel 的可写状态会被污染。Netty 让 Entry 进入账本，其实也等于给它加上了“回收时必须把账一起平掉”的责任。

所以从主线位置看，Entry 是一个很典型的“复用壳”对象：它不是消息本体，却已经深深卷入运行时语义。正因为如此，它的复用才值得单独分析。

## Entry 的取消和回收：不是清空字段这么简单

Entry 的真正复杂度，不在于怎么创建，而在于它怎么退出。因为它既带着消息、又带着 pending bytes、又带着 promise，一旦退出路径设计得不完整，污染的就不只是一个小壳对象，而是整条出站托管区的状态。

`cancel()` 是最好的例子。当前实现里，如果 Entry 还没被取消过，它会先把 `cancelled` 设为 true，记住原本的 `pendingSize`，然后立刻 `ReferenceCountUtil.safeRelease(msg)` 释放消息本体，再把 `msg` 替换成 `Unpooled.EMPTY_BUFFER`，并清零 `pendingSize`、`total`、`progress`、`bufs`、`buf`，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:859`。

这里有三个层次同时在发生：

第一层，ownership 层面，消息本体已经终止，必须 release。  
第二层，背压层面，原先这条消息占的 pending bytes 需要从账本里扣掉。  
第三层，节点壳层面，Entry 自己的状态必须被清回一个可复用的干净形态。

如果这里只做第三层，也就是简单清空字段，问题会非常严重：消息本体可能泄漏，pending bytes 可能残留，channel 可能长期卡在错误的不可写状态。也正因为如此，Entry 的退出从来不是“对象池回收”那么局部的事情，而是同时牵动 ownership、背压和 promise 三条线。

真正进入 recycler 之前，`unguardedRecycle()` 还会把 `next`、`bufs`、`buf`、`msg`、`promise`、`progress`、`total`、`pendingSize`、`count` 和 `cancelled` 全部重置，再调用 `handle.unguardedRecycle(this)`，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:878`。这一步才是纯粹的“把壳洗干净准备下次再用”。

所以 Entry 的回收顺序不能倒：先收消息和账，再收壳。只要顺序反过来，运行时语义就会先坏掉，再谈对象复用已经没有意义。

这也是理解 Netty 对象复用的一条非常重要的原则：**被复用的壳对象越靠近真实运行时语义，它的回收越不可能只是“对象池动作”，而必须先完成业务语义和运行时语义的闭环。**

## `WriteTask` 复用的不是消息，而是“跨 executor 的写任务壳”

如果 Entry 属于托管区内部壳，那 `WriteTask` 就属于托管区之前的异步任务壳。它的存在，和 pipeline 出站路径可能跨 executor 有直接关系。

`AbstractChannelHandlerContext.WriteTask` 同样带着一个 `Recycler<WriteTask>`，见 `transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1073`。而它的 `newInstance(...)` 会先从 recycler 里拿一个任务壳，再调用 `init(...)` 绑定 `ctx`、`msg`、`promise` 和 `flush` 标志，见 `transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1081`。

这说明 `WriteTask` 复用的同样不是消息本体，而是“这次跨 executor 写操作”的任务包装壳。它要记录的是：

- 这次写对应哪个 `AbstractChannelHandlerContext`；
- 这次写携带什么消息；
- 这次写对应哪个 promise；
- 这次任务最终是单纯 `write`，还是 `write + flush`。

也就是说，`WriteTask` 的身份不是“被写的对象”，而是“把被写对象带到另一个执行点去处理的那个任务外壳”。

这层区别非常重要，因为它说明 Netty 复用热点壳的策略并不是只发生在 `ChannelOutboundBuffer` 这种消息已入队的阶段。只要消息在进入托管区之前，就可能因为跨 executor 而被包上一层临时任务外壳；这层壳如果每次都靠 `new` 和 GC，同样会在高频异步路径里形成持续 churn。

所以 `WriteTask` 和 Entry 的关系，不是两个都叫 Recycler 用户这么简单，而是它们恰好卡在出站路径的两道壳层上：

- `WriteTask` 把消息从当前调用点带到真正的执行点；
- Entry 把消息从真正执行点带进 `ChannelOutboundBuffer`。

一个是异步调度壳，一个是托管排队壳。两者复用的对象层级不同，但目的完全一致：削薄围绕消息反复产生的临时运行时包装成本。

## `WriteTask` 为什么也要进入 pending bytes 账本

只看 `WriteTask` 的名字，很容易以为它不过是一个普通 `Runnable` 包装器。可它最重要的一步不是包装消息，而是把任务本身也纳入 pending bytes 模型。

`init(...)` 里有一个关键分支：如果 `ESTIMATE_TASK_SIZE_ON_SUBMIT` 开启，就会通过 `ctx.pipeline.estimatorHandle().size(msg) + WRITE_TASK_OVERHEAD` 估算这次任务的大小，并立刻给 pipeline 增加 pending outbound bytes，见 `transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1105`。如果这次任务还带 flush 语义，则用 `size` 的符号位携带 flush 标志，见 `transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1117`。

这一步说明得非常直白：对 Netty 来说，哪怕消息此时还没真正进入 `ChannelOutboundBuffer`，只要它已经被包装成一个待执行的跨 executor 写任务，就已经开始对当前 pipeline 的出站压力产生影响。更准确地说，这里增加的是 `pipeline.incrementPendingOutboundBytes(...)` 这一层账本，而不是 `ChannelOutboundBuffer` 自己的待写字节统计。也就是说，pending bytes 的语义在这里被拆成了前后两层：前一层是“任务还在 executor/上下文切换之前的 pipeline 账本”，后一层才是消息真正进入托管区后的 `ChannelOutboundBuffer` 账本。

这件事非常关键，因为它把出站背压边界又往前推了一层。前面讲 `ChannelOutboundBuffer` 时，背压统计从 Entry 开始；现在可以更完整地说：在某些跨 executor 路径里，背压甚至会从 `WriteTask` 提交时就先入账。否则，如果这些待执行任务完全不算压力，系统就可能在 executor 队列里悄悄堆起一大批未来一定会进入托管区的写任务，而 `channel.isWritable()` 还假装一切正常。

所以 `WriteTask` 的设计并不只是“别总 new 一个 Runnable”，它还在把异步任务阶段也纳入同一套出站压力模型。只要这点不讲清楚，读者就会误以为 pending bytes 只从 `ChannelOutboundBuffer` 开始统计，而看不到跨 executor 路径上更早的积压信号。

## `run()` 和 `cancel()` 先减账，再执行或回收

既然 `WriteTask` 提交时已经先给 pipeline 增加了 pending bytes，那么它退出时最关键的事就不是“把壳回收到 Recycler”，而是先把这笔账冲回去。

`run()` 里第一步调用的不是 `ctx.write(...)`，而是 `decrementPendingOutboundBytes()`，之后才执行真正的 `ctx.write(msg, size < 0, promise)`，最后在 `finally` 里 recycle 自己，见 `transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1122`。

`cancel()` 也是一样：先 `decrementPendingOutboundBytes()`，再 recycle，见 `transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1132`。

这个顺序说明 `WriteTask` 不是把“执行写入”和“维护账本”拆成两条互不相关的线，而是把两者绑死了。对 pipeline 来说，一旦任务不再占着 executor 队列、不再等待进入真正写路径，它对 pending bytes 的贡献就必须马上消失。否则系统会长期高估当前出站压力，writability 信号也会被拖歪。

这里和 Entry 的回收逻辑形成了非常漂亮的对照：

- Entry 退出前要先处理消息释放、promise 和 `ChannelOutboundBuffer` 那边的 pending bytes；
- `WriteTask` 退出前要先处理 pipeline 这一层的 pending bytes，再进入执行或回收。

两者共同说明：**壳对象复用必须服从账本闭环。**如果账还挂着，壳就不能被当作“已经安全可复用的临时对象”。

还要再多看一步：`WriteTask.run()` 的结束并不等于这条消息的出站生命周期结束。它只是说明“这层异步任务壳已经把消息带到了真正的 `ctx.write(...)` 执行点”；消息随后还会继续进入 `ChannelOutboundBuffer`，再经历 Entry、flush、remove、释放这些后续阶段。因此，不要把 `WriteTask.run()` 误读成出站生命周期终点，它只是从 pipeline 账本阶段切换到托管区账本阶段的过渡点。

因此，不要把 `WriteTask.recycle()` 看成孤立的对象池动作。它只是最后一步。真正决定能不能安全回收它的，是这次异步写任务对应的 pipeline 账本是否已经消掉，以及消息是否已经被正确交接给后续托管区路径。

## RejectedExecution 证明：壳复用一旦脱离失败边界，就会直接污染主线语义

理解 `WriteTask` 最好的测试证据，是 `ChannelOutboundBufferTest.testWriteTaskRejected()`。它专门构造一个 executor：任务队列只允许一个待处理项，再加一个永远不执行的占位任务，让真正的写任务提交时被拒绝，见 `transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:430`。

然后测试检查两件事：

- write 返回的 future 原因必须是 `RejectedExecutionException`；
- 被写入的 `ByteBuf` 引用计数必须回到 0；
- `outboundBuffer().totalPendingWriteBytes()` 也必须回到 0。

对应断言见 `transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:501`。

这组断言的意义非常大。它说明如果异步写任务根本没有成功进入执行阶段，那么运行时至少要同时完成三件事：

1. fail promise，让业务知道写失败了；
2. release 消息本体，避免 ownership 泄漏；
3. 回滚 pending bytes，避免 writability 账本残留。

只要少掉其中任何一项，问题都会扩散。

- 少掉第一项，业务以为写成功了；
- 少掉第二项，消息泄漏；
- 少掉第三项，channel 可能长期不可写或统计失真。

这正好说明为什么本篇要把 Entry 和 WriteTask 拿出来单讲。它们看起来只是可回收的小壳，但它们一旦挂上了 pending bytes 和 ownership，就已经不再是“回收失败也无伤大雅”的内部对象。相反，它们正好卡在出站主线最脆弱的边界上：异步提交、失败回滚、消息释放、背压统计。也正因为如此，Netty 只能把复用和这些语义同时设计，而不能把它们拆开看。

## 两种壳放在一起看，才能看见 Netty 复用真正落在哪

现在把 Entry 和 WriteTask 放到同一张图里，Netty 的对象复用落点就非常清楚了。

- `WriteTask` 出现在消息真正进入 `ChannelOutboundBuffer` 之前，解决的是跨 executor 写路径上的临时任务壳；
- `ChannelOutboundBuffer.Entry` 出现在消息已经进入托管区之后，解决的是排队节点壳；
- 两者都不复用消息本体；
- 两者都必须先完成 pending bytes 回滚、失败路径和消息释放，再谈回收；
- 两者都利用 `Recycler` 把高频小壳留在局部复用面上。

如果只看公共底盘，`Recycler` 很容易像一个抽象工具；只有看到这两个使用方，才会明白 Netty 复用的真正目标从来不是“任何对象都值得进池”，而是那些处在最热路径、又高度结构化的小壳。

它们之所以适合复用，有几个共同条件：

- 生命周期短而规则明确；
- 内部字段结构稳定；
- 回收前必须完成的语义动作也清楚；
- 复用它们不会破坏消息本体的 ownership 协议。

这四个条件缺一个，复用都可能得不偿失。也正因为如此，Netty 没有把“消息本体也进同一个 Recycler”当成默认策略，而是把复用精准地落在这些运行时包装壳上。

所以真正应该记住的，不是 “Entry 也有 Recycler，WriteTask 也有 Recycler”，而是：**Netty 把对象复用打在最热的壳层上，而不是打在语义最重的消息本体上。**这正是它能同时兼顾性能和生命周期边界的原因。

## 收网：公共底盘真正有价值的地方，是落在真实热点壳上

现在可以把这条专题主线收回来了。

- `ChannelOutboundBuffer.Entry` 复用的是出站托管区里的排队壳，它既携带 `msg/promise/progress/ByteBuffer` 缓存，又把自身 overhead 带进 pending bytes 账本，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:850`。  
- `WriteTask` 复用的是跨 executor 写路径上的任务壳，它会在提交时先给 pipeline 增加 pending bytes，在执行或取消时再减回去，见 `transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1105`、`:1122`。  
- 两者都不复用消息本体；真正被复用的是围绕消息反复产生的运行时包装结构。  
- 两者的回收都不能脱离 ownership、promise 和 pending bytes 语义单独讨论；测试已经证明，特别是 rejected task 场景，一旦少掉任一边界，主线语义就会直接被污染，见 `transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:501`。

所以本篇真正要留下来的结论是：**Netty 复用的重点不是“把一切对象都放进池”，而是把最热、最短命、又最容易形成 churn 的运行时壳对象留在受控复用面上。**

有了这层理解，前面那些看起来分散的专题其实已经开始闭环了：`FastThreadLocal` 提供受控线程局部世界，`Recycler` 提供小壳回收面，`ChannelOutboundBuffer` 提供托管区与背压账本，`WriteTask` 和 `Entry` 则把这些公共底盘真正落到了出站热点路径上。后面再去看更多使用方时，读者不会再问“为什么 Netty 又在造一个小池子”，而会先问：这是不是又一个热点壳对象，它的回收边界是不是足够清楚，复用以后会不会污染主线语义。