# Ch12-05 WeightedFairQueueByteDistributor：HTTP/2 可发送额度的公平分配

## 先把它和流控器彻底分开

前一篇已经把 HTTP/2 连接主链收起来了：`DefaultHttp2ConnectionEncoder` 不直接把 DATA 扔给 frame writer，而是先交给 remote flow controller；ConnectionHandler 的 flush 会再推进 pending bytes；而多个 stream 同时都可能处在“可以写”的状态里。到了这里，很多读者会自然以为：既然 flow controller 已经管窗口了，那公平发送顺序大概也已经顺便管了。

这个直觉只对了一半。flow controller 负责回答的是“哪条 stream 现在有资格继续发送”，也就是 streamable 与否、连接和流窗口还有没有空间；但当 A、B、C 三条 stream 都已经有资格发送时，谁先写、每次写多少、blocked 的父节点是否还要给子节点让路、权重怎样真正影响分配，这些问题并不由流控器自动回答。`WeightedFairQueueByteDistributor` 就是站在这条边界之后继续工作的。

所以本篇开头必须先把一个很容易混掉的边界钉死：**`WeightedFairQueueByteDistributor` 不是流控器。它不决定“能不能写”，它决定的是“已经能写的这些 stream，当前这轮连接级预算该怎么分”。**

只要这个边界不先立住，后面所有 priority tree、pseudo time、allocation quantum、state-only stream 看起来都会像是在“重复做一套流控”。其实它们解决的是另一个问题：当连接级写出额度有限，而多条 stream 同时都有资格消费它时，怎样让这个额度既考虑依赖关系，又不被单条流长期独占。

这也是为什么类注释一上来就把自己限定成 `StreamByteDistributor`，并强调它采用 Weighted Fair Queueing 思路分配字节，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:44`。它在 HTTP/2 主链里的位置，不是 reader/writer、不是 connection、不是 flow controller，而是更靠后的一个**可发送额度分配器**。

## 如果只按 streamId 轮询，或者先来先发，会卡在哪

理解这个分配器的价值，最好的办法不是先钻 pseudo time，而是先推演几个很直觉、但会迅速出问题的方案。

第一种失败方案，是最朴素的轮询：当前所有有数据可发的 stream，按 streamId 从小到大轮一遍，每条给一点。这个方案最大的问题是，它根本没把 HTTP/2 的 priority tree 放进来。某些 stream 在协议层被声明成更高优先级，或者被挂在某个父节点下面形成依赖关系，结果轮询一概无视，只按编号转圈。这样虽然看起来“均匀”，却和 HTTP/2 自己暴露的优先级结构脱节。

第二种失败方案，是先到先发：谁先把数据送进 flow controller，谁就一直先写，直到写不动再轮别人。这个方案更危险，因为它会把“先排队”误当成“应优先”。只要某条 stream 长时间保持可写、而且一直有大量数据积压，它就可能在一轮又一轮 flush 中连续吃掉大部分预算，其他 stream 虽然 technically streamable，却总只能捡剩下的边角。

第三种失败方案，是只看权重，不看状态边界。也就是说，一条 stream 只要权重大，就持续给它分额度；至于它的父节点是否 blocked、自己是不是只有一个空 frame、是不是刚从 connection 中移除但优先级信息还要暂时保留，都不管。这种做法的问题在于，HTTP/2 的优先级关系不是一张平面权重表，而是一棵会变化的依赖树。blocked parent、empty frame、state-only stream 这些边界如果不处理，分配顺序很快就会和树结构脱节。

这三种失败方案共同说明：要把连接级可发送额度分得合理，至少得同时回答四个问题：

- 哪些 stream 当前真的 streamable；
- 它们在优先级树里是什么父子关系；
- 这轮预算至少该给每条活跃 stream 多少基本机会；
- 某条 stream 暂时不能继续写时，机会能不能向子树或兄弟节点传播。

`WeightedFairQueueByteDistributor` 的整套设计，正是围绕这四个问题展开的。

## 总图：一棵状态树、一个 pseudoTime 队列、一个 allocation quantum

这套分配器如果只按类名看很散，真正的总图其实不复杂。可以先压成三层：

- `State` 树：表示 connection stream 以及所有 stream 在优先级树里的位置；
- `pseudoTimeQueue`：表示在某个父节点之下，哪个子状态下一次更应该得到写机会；
- `allocationQuantum`：表示这轮分配给某条 stream 的最小额度块，用来在公平和吞吐之间折中。

类构造器先创建 connection 自己的根状态 `connectionState`，并把它挂到 connection stream 上，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:110`。后面新增 stream、激活 stream、关闭 stream、移除 stream，都会通过 connection listener 去更新这棵树，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:115`。

也就是说，`WeightedFairQueueByteDistributor` 真正管理的不是一个“当前活跃 stream 列表”，而是一棵和 HTTP/2 priority tree 同步变化的状态树。只不过树上的节点不一定都对应着当前仍存在的 `Http2Stream` 对象，这就引出了 state-only stream 这一层。

如果某条 stream 已经从 connection 中移除，但它的优先级位置仍然影响到树结构，分配器会把它的状态保留在 `stateOnlyMap` 与 `stateOnlyRemovalQueue` 里，前提是数量没超过 `maxStateOnlySize`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:73`。这说明它维护的不是“当前连接里还活着哪些 stream”，而是“当前优先级树要继续成立，哪些状态节点还得暂时保留”。

再看 `allocationQuantum`。类注释专门说明，它是每次分配时给 stream 的最小额度块，用来在公平与 goodput 之间折中，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:54`。这意味着分配器追求的不是精确到每一个字节的理想公平，而是足够细的轮转与足够大的批量之间的现实平衡。

所以如果把总图压成一句最小心智图，可以这样记：

- flow controller 先说“这些 stream 现在能写”；
- distributor 再把这些 stream 放回 priority tree；
- pseudoTimeQueue 决定谁先拿下一次机会；
- allocationQuantum 决定这次最小给多少；
- blocked 的节点如果不能用掉机会，就让它的子树或其他节点继续往下拿。

这就是理解后面所有分配细节的起点。

## `updateStreamableBytes`：它不决定谁有资格发，只接收上游结论

把分配器和流控器分清，最关键的方法就是盯住 `updateStreamableBytes(...)`。这段实现很短，但它正好暴露出整条边界。

分配器不会自己去查窗口，也不会自己决定某条 stream 有没有 frame、是不是可以写。它接受的是上游传进来的 `StreamState`，再把 `streamableBytes(state)`、`state.hasFrame()` 和 `state.windowSize() >= 0` 这些已经被 flow controller 计算好的结果，写进自己维护的 `State` 里，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:189`。

也就是说，distributor 收到的是“资格结论”，不是“资格推理过程”。它不关心为什么当前窗口是 0，也不关心 HEADERS/DATA 是怎么进入 flow controller 队列的；它只关心：现在这条 stream 的可发送字节数是多少，它算不算 active，以及它在树里的位置。

这层分工非常重要。因为一旦 distributor 自己也开始判断窗口、维护发送资格，和 remote flow controller 的职责就会重叠，整个连接主链会变成两套互相竞争的可写判定器。Netty 当前实现明确避免了这一点：流控器决定 streamable，distributor 决定额度分配。

所以这里最值得立住的一句判断是：**`WeightedFairQueueByteDistributor` 工作的前提，是上游已经挑出了“当前可以被分配额度”的候选 stream。**没有这个前提，它的 priority tree 和 pseudo time 根本无从谈起。

## 真正的主线：`distribute()` 不是遍历列表，而是在树上递归让出与争取机会

分配器真正有意思的地方，是 `distribute()` 和 `distributeToChildren()` 这两段主线。它们表面上看像“遍历 children 然后 writer.write(...)”，实际上在做的是一种递归的、带让权语义的分配。

顶层 `distribute(maxBytes, writer)` 先检查 `connectionState.activeCountForTree` 是否为 0；如果整棵树没有任何活跃节点，就直接返回 false，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:257`。这说明分配器并不是“每次 flush 都去全树扫一遍”，而是完全建立在 active tree 的存在之上。

只要整棵树还有活跃状态，它就会循环调用 `distributeToChildren(...)`，并在“还有额度可分”或“activeCountForTree 发生变化”这两个条件下继续推进，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:263`。这里的关键不是循环本身，而是它允许 empty frame 这种“写了 0 字节但推进了状态”的情况继续影响后续分配。

真正的核心发生在 `distributeToChildren(...)`。父节点会从自己的 `pseudoTimeQueue` 里 poll 出一个子状态 `childState`，再 peek 下一个子状态 `nextChildState`，然后根据两者的 `pseudoTimeToWrite` 差值、权重和 `allocationQuantum` 计算当前这一轮最多应该给 `childState` 多少额度，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:313`。

如果 `childState` 自己是 active，就直接 `write(nsent, writer)`；否则它会递归进入自己的子节点，继续把机会向下传，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:286`。这就是为什么 blocked parent 并不意味着整棵子树都冻结。父节点自己写不动，不等于它的孩子也写不动；分配器的树形递归恰好允许“机会沿树继续传播”。

所以这条主线真正做的，不是简单轮询，而是：

1. 找出当前在这个父节点下最该先得到机会的 child；
2. 给它一个受权重与 quantum 约束的额度；
3. 如果它不能直接消费，就把机会继续向它的子树递归；
4. 写完后更新父节点的 pseudo time，再把仍然活跃的 child 放回队列。

这是一个“给机会 -> 用掉或向下传播 -> 重新排队”的模型，而不是“顺序扫列表”的模型。

## blocked parent、zero window 和 empty frame：为什么还要给一次机会

这套分配器最反直觉的地方之一，是某些看起来“写不出 payload”的 stream 仍然可能得到一次写机会。测试里专门把这一点钉得很死。

在 `distribute(...)` 里，如果某条 active stream 最终写出了 0 字节，而本轮预算其实还不为 0，分配器会把它标成暂时 inactive，直到下一次 `updateStreamableBytes` 再重新激活，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:287`。注释已经解释：这允许子节点继续获得额度，而不是让一个窗口为 0 的父节点永久挡在树上。

`WeightedFairQueueByteDistributorTest.emptyFrameAtHeadIsWritten()` 和 `streamWithZeroFlowControlWindowAndDataShouldWriteOnlyOnce()` 正好说明了这个设计。前者验证优先级最高但只有空帧的 stream 仍然会被给一次写机会；后者验证窗口为 0、但带有空 frame 机会的 stream 只会被写一次，之后除非再次 `updateStreamableBytes`，否则不会持续占着队列，见 `codec-http2/src/test/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributorTest.java:236`、`:301`。

这说明分配器区分的是两件事：

- “这条 stream 当前是不是还应该得到一次机会去证明自己能不能写”；
- “这条 stream 如果本轮没真正推进 payload，是否还应继续占着 active 资格”。

如果没有这种区分，blocked parent 或 empty frame 就会把整棵优先级树卡死。给一次机会，是为了让控制类或空帧语义不被饿死；只给一次，则是为了防止它在无法真正推进时长期霸占调度位置。

所以不要把“写了 0 字节”简单理解成“这次调度没有意义”。在 HTTP/2 连接主链里，它可能仍然代表一次必要的状态推进机会；只不过这次机会不能无限重复，必须在用过一次后把位置让出来。

## priority tree 变化与 state-only stream：为什么已移除 stream 的优先级状态还可能暂留

如果只考虑当前还存在的 `Http2Stream` 对象，优先级树会简单很多。难点在于，HTTP/2 的依赖关系并不会随着某条 stream 被移除就立刻变得无关紧要。`WeightedFairQueueByteDistributor` 之所以维护 `stateOnlyMap` 和 `stateOnlyRemovalQueue`，就是在处理这个问题。

当某条 stream 被移除时，connection listener 会把它对应的 `State` 从真实 `Http2Stream` 对象上脱开，把 `state.stream = null`，再根据 `maxStateOnlySize` 和当前优先级比较，决定要不要暂时保留这份 priority state，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:156`。

这说明 state-only stream 不是“永远缓存旧状态”，而是一个有限度的、按优先级选择保留的补丁层。它存在的意义，是在 stream 对象已经消失、但 priority tree 结构仍然需要平滑过渡时，避免树瞬间塌掉。`StateOnlyComparator` 还会按“是否曾经 activate/reserve、树深度、streamId”排序，决定哪些 state 更值得保留，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:384`。

另一边，`updateDependencyTree(...)` 也说明 priority tree 的变化不是简单换父节点。exclusive dependency 可能把一整组孩子挪走；如果 parent 本身是 child 的 descendant，还要先做重连；新建但尚无真实 stream 对象的状态节点，也可能临时进入 state-only map，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:196`。

所以这里真正要记住的，不是某个比较器怎么排，而是：**分配器维护的 priority tree 比“当前活着的 Http2Stream 集合”更宽一层。**它允许少量仅保留优先级意义的状态节点暂存，以便树结构和后续分配不会因为 stream 对象生命周期变化而过于剧烈抖动。

但这层保留不是永久的，也不是无上限的。`maxStateOnlySize`、移除队列和优先级比较共同限制了它的规模。否则所谓“暂存优先级状态”很快就会退化成无限制保留历史节点。

## 测试真正证明的，是“让权”和“最小额度”两件事

把测试串起来看，会发现它们最反复验证的不是“权重公式算对没有”，而是两种更重要的行为：让权，以及最小额度。

### 最小额度：每条活跃流至少要有一块最小机会

`minChunkShouldBeAllocatedPerStream()` 验证的就是 `allocationQuantum` 的存在意义。测试把四条 stream 的可写字节都设成一个 quantum，再只给 3 倍 quantum 的预算，结果前三条各得到一块最小额度，第四条留到下一轮；下一轮再写一次，最后一条 stream 才得到机会，见 `codec-http2/src/test/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributorTest.java:182`。

这说明 `allocationQuantum` 不是“权重直接换带宽比例”的工具，而是“确保活跃 stream 不会因为预算被切得过碎而完全拿不到机会”的底线。它在公平和吞吐之间加了一块最小分配粒度。

### 让权：父节点写不动时，孩子仍然应该继续拿额度

`blockedStreamNoDataShouldSpreadDataToChildren()` 和 `blockedStreamWithDataAndNotAllowedToSendShouldSpreadDataToChildren()` 则验证另一条核心规则：父节点 blocked 或不能真正推进 payload 时，分配器应该继续把额度传播给子节点，而不是让整棵子树原地冻结，见 `codec-http2/src/test/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributorTest.java:264`。

这条规则非常关键，因为它说明 priority tree 不是“父亲拿不到就全家饿死”的层级锁，而是一种带依赖关系的机会分配树。父节点代表的是优先级边界，不是硬性的流量闸门。只要孩子仍然 active，机会就该沿树向下走。

### writer 异常：分配器失败时是 connection 级错误

`connectionErrorForWriterException()` 还证明了一个容易忽略的边界：如果 writer 在分配过程中抛出异常，分配器把它包装成 connection 级 `INTERNAL_ERROR`，而不是某条单独 stream 的局部错误，见 `codec-http2/src/test/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributorTest.java:146`。

这说明分配器虽然最终是按 stream 发额度，但它自身属于连接级调度器。只要它在调度过程中出错，影响的就是连接级写出主线，而不是某一条 stream 单独可以隔离的问题。

把这些测试放在一起，整个分配器的性格就很清楚了：它真正想守住的是“每条活跃流别被完全饿死”和“父节点写不动时，子树机会还能传播”。权重、pseudoTime、state-only stream 全都是为这两件事服务的。

## 收网：它不是流控器，而是连接内“可发送额度如何分”的策略层

现在可以把整条主线收回来了。

- remote flow controller 先决定哪些 stream 当前已经 streamable；  
- `WeightedFairQueueByteDistributor` 再在这些已经有资格发送的 stream 之间，按 priority tree、权重、pseudo time 和最小额度块分配可发送预算；  
- blocked 的父节点并不会自动冻结整个子树，empty frame 和 zero-window stream 也仍可能获得一次必要的推进机会；  
- 少量已移除 stream 的 priority state 还可能以 state-only 形式暂存，以便树结构平滑过渡；  
- writer 发生异常时，分配器本身作为连接级组件，会把它提升成 connection 级错误。

所以本篇真正要留下来的心智模型是：**`WeightedFairQueueByteDistributor` 不是流控器，也不是带宽保证器，而是连接内“当前可发送额度如何继续往各条 stream 分”的策略层。**

有了这层理解，前面连接主链那篇里“FlowController/Distributor 决定数据推进”这句话才彻底落地：flow controller 负责资格，distributor 负责额度。再往后看 gRPC、Triple 或任何建立在 Netty HTTP/2 主链之上的框架，就不会再把 priority tree 看成一个遥远的协议角落，而会知道它最终真的会影响一条连接里多条流如何争用同一份写出预算。