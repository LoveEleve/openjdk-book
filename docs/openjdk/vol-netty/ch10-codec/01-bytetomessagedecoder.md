# ByteToMessageDecoder：为什么 TCP 字节流不能“来一段解一段”，而要先积攒、再循环、还要防重入

> 本文基于当前 Netty `ByteToMessageDecoder`、`CodecOutputList` 与相关测试实现。前置：Ch4 `01-dual-index-and-refcnt.md`、Ch4 `04-views-and-zerocopy.md`、Ch7 Pipeline、Ch9 `02-bootstrap-server.md`；本文聚焦 Codec 解码骨架——`channelRead -> cumulator -> callDecode` 主线、MERGE/COMPOSITE 两种积攒策略、循环终止条件、重入与移除保护、`discardAfterReads` 与 `decodeLast` 边界，不展开具体拆包器参数与编码器路径。

## Bootstrap 已经把 child pipeline 装好了，但 TCP 送进来的仍然不是“消息”

上一章结束时，服务端的 child channel 已经具备了完整运行骨架：

- 它有自己的 pipeline。
- 它已经挂上了 `childHandler`。
- 它被注册给了 worker EventLoopGroup。
- 后续每次有入站数据，都会沿着那条 child pipeline 往前跑。

可这时真正到达 codec handler 的，仍然只是 `ByteBuf` 形式的原始字节流。

这件事看上去平平无奇，实际上正是网络协议解析最麻烦的起点。因为 TCP 从来不替你保留“业务消息边界”。它只保证字节顺序，不保证一次 `channelRead()` 恰好对应一条完整协议消息。

所以 child pipeline 刚装好时，解码器面对的现实往往是这样的：

```text
第一次 channelRead()：到了 5 个字节
  -> 不够一条消息

第二次 channelRead()：又到了 7 个字节
  -> 这次合起来也许够 1 条

第三次 channelRead()：一下到了 40 个字节
  -> 里面可能连续塞了 3 条半消息
```

这就把解码器逼到一个很别扭的位置：

- 如果你太激进，每次来一段就立刻当成完整消息解，那半包场景会直接读穿边界。
- 如果你太保守，只要不确定完整就一概不做，那一次 read 里明明已经塞了多条完整消息时，又会平白拖延。
- 如果每个具体协议解码器自己各管一套缓存、循环和异常边界，那整个 codec 体系就会四分五裂。

`ByteToMessageDecoder` 正是为了解这个矛盾而存在的。

先把本文最核心的一句话摆前面，后面会反复回收：

```text
ByteToMessageDecoder 提供的不是某一种具体协议解析器，
而是一套通用解码骨架：
先把多次到达的 ByteBuf 积攒成 cumulation，
再用 callDecode 循环驱动子类反复尝试解码，
直到“当前数据不够再继续”或者“本轮应当停下”为止。
```

如果没有这条主线，后面读源码时很容易把重点放错：以为 `decode()` 才是全部；以为“return null”就是停止条件；以为 cumulator 只是个性能选项；以为重入保护只是为了防多线程。当前实现都不只这么浅。

## 一、如果想把解码压成“来一段就解一段”，会在三处撞墙

正式看源码前，先故意走三条最顺手、却最容易把 codec 主线写歪的路。

### 1. 失败方案一：每次 `channelRead()` 都假设自己拿到了一条完整消息

这是最自然的直觉。

业务协议既然自己定义了消息格式，那解码器收到一个 `ByteBuf` 时，直接按格式读不就行了？不够再抛异常，够了就产出消息。

问题在于，TCP 根本不替你保证这次 `channelRead()` 的字节数恰好对应协议边界。

举个最简单的长度字段协议例子：

```text
[4B length][payload]
```

如果第一次只到 2 个字节，而你直接 `readInt()`，要么越界，要么就得靠子类自己保存“前 2 个字节已经读过但不完整”的尴尬中间状态。随着协议复杂度上涨，这种“自己手搓半包缓存”的代码会迅速变脆。

所以解码器第一件事不能是假设完整，而是：

```text
我得先承认：这次到达的数据可能只是某条消息的一部分。
```

### 2. 失败方案二：那就让每个具体 decoder 自己维护积攒缓冲区

第二条路看起来更务实：既然 TCP 不保边界，那每个协议 decoder 自己维护一个 `ByteBuf cumulation`，数据不够就先攒着，下次来再拼。

这当然能做，但问题会很快暴露：

- 每个 decoder 都要重新处理积攒 buffer 的生命周期。
- 每个 decoder 都要决定何时扩容、何时释放、何时丢弃已读部分。
- 每个 decoder 都要自己防重入、自己处理 handler 被移除时残留数据怎么办。
- 最后每个 decoder 可能还会各自发明一套“什么时候继续解，什么时候停”的循环协议。

也就是说，真正难的并不只是“怎么按协议解析字段”，而是：

```text
半包怎么攒
多包怎么循环解
解码中途被移除怎么办
一次 read 里什么时机向下游 fire 消息
```

这些问题如果分散到每个协议子类里，整个 codec 框架就不再是框架，只剩一堆各自重复踩坑的局部实现。

`ByteToMessageDecoder` 的核心价值，恰恰就是把这些共性负担收回父类。

### 3. 失败方案三：解码循环只看 `decode()` 有没有返回值就够了

第三条路最隐蔽，因为很多人第一次读 Netty 资料都会碰到一句高度简化的话：数据不够时，decoder “return null”等更多数据。

这句话在教学上能帮你先建立直觉，但如果直接拿它当当前实现的精确事实，就会把最关键的一层讲错。

当前 `ByteToMessageDecoder.decode(...)` 是：

```java
protected abstract void decode(ChannelHandlerContext ctx, ByteBuf in, List<Object> out)
```

它根本没有返回值，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:529`。

父类判断“这次该继续循环还是该停下”，真正看的不是某个 `return null`，而是两件事：

- 子类有没有往 `out` 里放消息。
- 输入 `ByteBuf` 的可读字节数有没有减少。

也就是说，父类的核心判断语言不是“返回了什么”，而是：

```text
你到底消费了多少输入？
你到底产出了多少输出？
```

这条判断规则一旦立住，`ByteToMessageDecoder` 整个骨架就会一下子清晰很多。因为它让“等待更多数据”“已经解出消息”“子类实现有 bug”这三种状态可以被严格区分，而不是全靠子类自觉。

## 二、`channelRead()` 主线：父类先把字节攒好，再决定何时驱动解码

现在进入主线。

`ByteToMessageDecoder.channelRead(...)` 是整个解码骨架真正的入口，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:285`。这里第一眼看上去分支很多，但如果抓住角色，就没那么乱。

### 1. 真正需要父类接管的，只是 `ByteBuf` 入站消息

`channelRead(...)` 一开头就先看 `input instanceof ByteBuf`。如果不是 `ByteBuf`，直接 `ctx.fireChannelRead(input)` 往下传，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:330`。

这一步很重要，因为它说明 `ByteToMessageDecoder` 并不想霸占所有入站对象；它只接管“原始字节流转消息”的这条线。别的对象，不归它管。

换句话说，父类主线从一开始就很聚焦：

```text
只有当上游给我的是 ByteBuf 时，
我才进入“积攒 + 解码”骨架；
否则我只是一个透明转发者。
```

### 2. 每次进入主线，先从对象池里借一个 `CodecOutputList`

只要 `input` 是 `ByteBuf`，当前实现就会先 `CodecOutputList.newInstance()`，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:291`。

这说明父类在进入真正解码前，先准备的不是“返回值”，而是一个可复用的输出容器。它后面承担两件事：

- 子类 decode 时往里面塞消息。
- 父类在合适时机把这些消息批量 `fireChannelRead` 给下游。

这里先不要把它当成性能细节略过。因为它反过来说明了父类骨架的一条重要设计：

```text
子类负责声明“我解出了哪些消息”；
父类负责决定“什么时候把这些消息真正向下游发出去”。
```

这就是为什么 `out` 不是普通临时局部数组，而是专门被框架接管的一部分。

### 3. `cumulation` 不是“某次 read 的缓存”，而是跨多次到达共享的积攒缓冲区

真正的半包闭环，从这里开始建立。

`channelRead(...)` 里会先算：

- `first = cumulation == null`
- 然后把这次到达的 `input` 和旧 `cumulation` 交给 `cumulator.cumulate(...)`

见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:293`。

这一步的真正语义不是“把本次 buffer 稍微拼一下”，而是：

```text
以前没解完留下来的字节
  +
这次新到达的字节
  -> 变成新的 cumulation
```

所以 `cumulation` 的定位一定要摆正：它不是某个 decoder 子类私有的小技巧，而是整个解码骨架跨多次 `channelRead()` 保持连续视图的核心状态。

也正因为如此，父类必须接管它的生命周期。否则子类一旦手滑释放、替换或传播错误，半包状态立刻就会失真。

### 4. 真正的解码入口不是子类 `decode()`，而是父类 `callDecode(...)`

`cumulation` 准备好之后，`channelRead(...)` 并不直接调一次 `decode(...)` 就结束，而是进入 `callDecode(ctx, cumulation, out)`，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:296`。

这一步特别关键。它说明子类 `decode()` 根本不是解码生命周期的顶层入口，而只是父类循环骨架里的一个钩子。

也就是说，真正的角色分工是：

```text
channelRead()
  -> 负责收输入、做 cumulation、准备 out、收尾释放

callDecode()
  -> 负责循环驱动、判断继续还是停止、判断子类有没有违约

decode()
  -> 只负责“在当前输入视图下，尝试解出消息”
```

只要这三层关系没分清，后面很容易把 `decode()` 误写成“整个 codec 逻辑都在子类里”。当前实现明显不是这样。

### 5. `finally` 收尾才是这条主线真正成熟的地方

`channelRead(...)` 的 finally 块里做了三类极其重要的收尾：

- 如果 `cumulation` 已经不可读，就 release 并清空它。
- 否则每累计到一定次数，尝试 `discardSomeReadBytes()`。
- 再把 `out` 里的消息真正发给下游，最后 recycle 掉 `CodecOutputList`。

见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:302`。

这段收尾说明 `ByteToMessageDecoder` 的成熟点不只是“能解码”，而是它把长期运行中最容易烂掉的边界都拎在了父类这里：

- 累积缓冲区什么时候清空。
- 已读废数据什么时候压缩。
- 输出容器什么时候真正 fire、什么时候回池。

也就是说，它不是“一次 decode helper”，而是真正掌管整条 inbound 解码生命周期的骨架。

## 三、Cumulator：为什么父类连“怎么攒半包”都不给子类随便发明

现在可以专门看 `cumulator` 了。

当前 `ByteToMessageDecoder` 默认使用 `MERGE_CUMULATOR`，但也提供 `COMPOSITE_CUMULATOR`，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:83` 与 `:123`。

很多资料会把这两者概括成“一个拷贝，一个零拷贝”。这个说法方向没错，但如果只停在这里，远远不够支撑读源码。

### 1. MERGE 的第一原则不是“总是拷贝”，而是先看能不能直接复用 `in`

`MERGE_CUMULATOR` 一开始就处理了两个很关键的边界：

- 如果 `cumulation == in`，说明同一个 buffer 被双重 retain 了，要先 `in.release()`，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:86`。
- 如果旧 `cumulation` 已经不可读、而新 `in` 是 contiguous 的，就直接释放旧 `cumulation`，返回 `in`，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:91`。

这说明 MERGE 不是“逢输入必拷贝”，而是：

```text
能直接把新输入当新的 cumulation 用，就直接换过去；
只有需要把旧字节和新字节拼在一起时，才真的拷贝。
```

所以它的真实心智模型应该是“连续缓冲优先、必要时复制合并”，而不是一句空泛的“merge 就是拷贝”。

### 2. 真正触发 `expandCumulation(...)` 的，不只是容量不够

MERGE 要不要扩容，不只看 `required > cumulation.maxWritableBytes()`。当前实现还会在下面两种情况下替换 cumulation：

- `required > cumulation.maxFastWritableBytes() && cumulation.refCnt() > 1`
- `cumulation.isReadOnly()`

见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:98`。

这几个条件非常值得停一下，因为它们说明父类在积攒阶段就已经把 ByteBuf 生命周期安全考虑进来了：

```text
不是“理论上能写进去”就可以原地扩；
如果 cumulation 可能被共享，或者它本身只读，
那就宁可换一块新的，也别冒险在原对象上继续写。
```

这和前面 ByteBuf 生命周期一章建立过的“共享数据不等于共享寿命”正好呼应。

### 3. `expandCumulation(...)` 的要点不是分配新 buffer，而是所有权切换必须干净

`expandCumulation(...)` 会新分配一个更大 buffer，把旧 cumulation 和新 in 的可读数据都拷进去，再把 `in.readerIndex` 推到末尾，最后释放旧对象，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:574`。

这里最容易写错的，是把它理解成“扩容时顺手拷一下”。当前实现其实在用很明确的所有权转移协议：

```text
新 cumulation 接手全部旧数据 + 新数据
旧 cumulation 退场
in 也被视为已消费并在外层 finally 或此处被释放
```

这就是为什么相关测试特别盯着异常时 release 边界，比如 `releaseWhenMergeCumulateThrows()` 和 `releaseWhenMergeCumulateThrowsInExpand()`，见 `codec-base/src/test/java/io/netty/handler/codec/ByteToMessageDecoderTest.java:345`。

这类测试不是枝节，它们正说明当前实现很清楚：半包积攒不是只拼字节，还在拼所有权。

### 4. COMPOSITE 不是“更高级版本”，而是把拷贝成本换成更复杂的索引结构

`COMPOSITE_CUMULATOR` 的路线是：尽量把不同 `ByteBuf` 组件挂进 `CompositeByteBuf`，减少内存复制，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:123`。

但它并不意味着“天然更优”。当前类注释已经直接提醒：`CompositeByteBuf` 的索引实现更复杂，某些 decoder 场景下可能比 MERGE 更慢，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:119`。

所以真正该记住的不是“COMPOSITE 零拷贝，所以更先进”，而是：

```text
MERGE：字节布局简单，可能多一次拷贝
COMPOSITE：尽量少拷贝，但后续随机索引与组件管理更复杂
```

它们优化的不是同一个维度。

## 四、`callDecode()`：真正的停止条件不是 return，而是“输入有没有被消费，输出有没有被产出”

现在进入整篇最核心的一节。

`callDecode(...)` 才是 `ByteToMessageDecoder` 真正把“半包等待”和“多消息连续解码”统一起来的地方，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:464`。

### 1. 外层 `while (in.isReadable())` 说明：只要还有字节，父类就会继续问子类“还能不能再解”

这意味着一次 `channelRead()` 不一定只触发一次 `decode()`。如果当前 `cumulation` 里还有可读字节，并且前一次 decode 已经证明自己在推进，父类就会继续循环。

所以这里的父类姿态非常积极：

```text
我不会默认“一次 read 只够一条消息”；
只要你还能在当前 cumulation 上继续推进，
我就继续驱动你解。
```

这正是处理粘包场景所必需的那半边能力。

### 2. 为什么 `out` 非空时要先 fire，再 `out.clear()`，然后才继续 decode

`callDecode()` 每轮循环一开始，如果发现 `outSize > 0`，会先把 `out` 里的消息 `fireChannelRead` 给下游，再清空 `out`，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:469`。

这一步的好处不是“节省列表”，而是把父类和下游 pipeline 的契约切得很清楚：

```text
子类先把自己本轮解出的消息交给 out
父类再把这些消息批量往下游传播
传播完再进入下一轮 decode
```

这让父类在每轮 decode 之间都能重新检查：

- handler 有没有在下游传播过程中被移除
- 当前输入还能不能继续推进

所以这里的“先 fire 再继续”不是可有可无的小顺序，而是 codec 和 pipeline 交界处的稳定点。

### 3. 数据不够时，父类看的不是“子类说了等一下”，而是“这一轮既没产出消息，也没消费输入”

`callDecode()` 在调用子类 decode 之前，会先记下 `oldInputLength = in.readableBytes()`。调用后，如果 `out.isEmpty()` 并且 `oldInputLength == in.readableBytes()`，就 break，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:494`。

这就是当前实现里最重要的停机判据：

```text
如果这轮 decode 什么都没产出，
而且输入一字未动，
那父类就认定：当前数据还不够，先等下一批。
```

这比“靠返回值约定等待更多数据”强得多，因为它把协议统一成了可观测的状态变化，而不是对子类的一句口头承诺。

### 4. 为什么“解出消息但没消费任何输入”会被当成 bug 直接抛异常

更狠的是另一条判据：如果 `out` 非空，但 `oldInputLength == in.readableBytes()`，父类会直接抛 `DecoderException`，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:502`。

这条规则非常重要，因为它堵住了一类最容易制造死循环的子类 bug：

```text
我说我解出了一条消息，
但我其实一字节都没往前挪。
```

如果父类允许这种情况继续循环，那只要输入仍可读，它就会在同样的位置一遍遍“解出”同一条消息，整个 pipeline 很快失控。

所以当前实现不是“尽量相信子类”，而是：

```text
你可以产出消息，
但你必须证明自己真的消耗了输入；
否则这不是‘协议还没写完’，而是子类实现违约。
```

这条纪律其实正是 codec 骨架的强约束所在。

### 5. `singleDecode` 不是“更正确”，只是额外的人为刹车

`callDecode()` 最后还会看 `isSingleDecode()`，如果开启就 break，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:508`。

这说明单次只解一条消息并不是默认语义，而是一种人为截断策略。类注释也说了，它默认是 false，因为会有性能影响，只有某些协议升级场景才可能需要，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:198`。

所以在理解主线时要把它摆正位置：

```text
默认骨架是“能继续解就继续解”；
singleDecode 只是特殊场景下给父类循环额外踩一脚刹车。
```

## 五、重入与移除：真正危险的不是多线程，而是 decode 过程中 pipeline 自己变化了

如果只讲 cumulation 和循环，`ByteToMessageDecoder` 还只是一个不错的半包框架。让它真正有“框架味”的，是它对重入和 handler 移除这种 awkward 场景也给了统一兜底。

### 1. 三态不是装饰，它是在描述“现在能不能安全继续 decode”

当前类里定义了三个状态常量：

- `STATE_INIT`
- `STATE_CALLING_CHILD_DECODE`
- `STATE_HANDLER_REMOVED_PENDING`

见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:163`。

这三态真正描述的不是协议状态，而是父类自己此刻的运行态：

```text
INIT
  -> 当前没在调子类 decode

CALLING_CHILD_DECODE
  -> 当前正在子类 decode 调用栈里

HANDLER_REMOVED_PENDING
  -> 子类 decode 过程中有人要求把我移除，但还不能立刻完整收尾
```

一旦把这三态理解成“框架自身的安全状态”，后面几个 tricky 分支就都顺了。

### 2. 为什么 reentrant `channelRead()` 不能立刻递归解，而要先排进 `inputMessages`

`channelRead(...)` 最外层先判断：如果 `decodeState == STATE_INIT`，才进入正常主线；否则说明当前已经在 decode 过程中，此时新来的 `input` 不直接处理，而是进 `inputMessages` 队列，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:287` 与 `:334`。

这一步特别重要，因为它说明当前实现防的不是“多线程同时进来”，而是：

```text
同一条调用链里，decode 过程中又触发了一次新的 inbound read
```

如果这时直接递归再跑一轮完整 decode，`cumulation`、`out`、`decodeState` 和 handler 移除边界都会交叠。父类的选择是更保守也更稳的：

```text
原调用先跑完
新的输入先排队
等外层 do/while 回来再顺序处理
```

`ByteToMessageDecoderTest.reentrantReadSafety()` 就直接覆盖了这一点：第一次 decode 中又写入 8 字节触发 reentrant inbound，最终仍然按顺序读出先 4、后 8，见 `codec-base/src/test/java/io/netty/handler/codec/ByteToMessageDecoderTest.java:688`。

### 3. 为什么 decode 中被 remove 了，也不能立刻把内部状态整锅端掉

`handlerRemoved(...)` 一进来先看：如果当前 `decodeState == STATE_CALLING_CHILD_DECODE`，就把状态改成 `STATE_HANDLER_REMOVED_PENDING` 并 return，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:257`。

这意味着：

```text
如果我现在还在子类 decode 调用栈里，
那就算有人要 remove 我，
也不能马上完整执行 handlerRemoved 收尾。
```

原因很现实：这时你仍可能在读当前输入、往 out 塞消息，甚至后面还要把残留 cumulation 往下游传。贸然把内部缓冲区释放掉，只会把调用栈中还没结束的那段逻辑炸掉。

### 4. `decodeRemovalReentryProtection(...)` 的真正任务，是把“子类 decode 完成之后才能做的善后”统一兜住

`decodeRemovalReentryProtection(...)` 会先把 `decodeState` 设成 `STATE_CALLING_CHILD_DECODE`，调用子类 `decode(...)`，finally 里再看是否有 pending remove；如果有，就先把 `out` 里消息 fire 出去，再 `handlerRemoved(ctx)`，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:541`。

这段代码特别像“奇怪的防护层”，但它解决的问题非常具体：

```text
子类 decode 过程中
  -> 可能 reentrant read
  -> 可能 remove 当前 decoder

父类必须保证：
  1. 当前 decode 调用栈先安全落地
  2. 已经产出的消息别丢
  3. 真正的 handlerRemoved 收尾发生在安全时点
```

这就是为什么它不只是改个状态位，而是把 fire 和 remove 的顺序也兜了进来。

`ByteToMessageDecoderTest.testRemoveWhileInCallDecode()`、`handlerRemovedWillNotReleaseBufferIfDecodeInProgress()`、`reentrantReadThenRemoveSafety()` 都在不同角度验证这层保护，见 `codec-base/src/test/java/io/netty/handler/codec/ByteToMessageDecoderTest.java:149`、`:217`、`:720`。

## 六、`discardAfterReads` 与 `decodeLast`：半包框架不仅要会跑，还得会长期活着、会好好收尾

到这里主解码循环已经清楚了，再看两个容易被当作边角料、其实非常关键的长期边界：已读废数据如何回收，以及输入关闭时最后那点尾料怎么办。

### 1. `discardAfterReads = 16` 的意义不是一个神秘常数，而是“别每次都做潜在昂贵的数据整理”

当前 `channelRead()` finally 里，如果 cumulation 还可读，就会在 `++numReads >= discardAfterReads` 时触发 `discardSomeReadBytes()`，默认阈值是 16，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:191` 与 `:316`。

这一步必须和前面 ByteBuf 一章联系起来读：`discardSomeReadBytes()` 并不是零成本动作。它本质上是在尝试把前面已读部分挪走，为后续写入腾空间。

所以当前实现并不想每次 read 完都做这件事，而是：

```text
累计读了若干轮再整理一次，
在长期运行中折中内存占用和拷贝成本。
```

### 2. 为什么只在 `cumulation.refCnt() == 1 && !first` 时才 discard

`discardSomeReadBytes()` 自己内部还有一个很关键的保护条件：

- `cumulation != null`
- `!first`
- `cumulation.refCnt() == 1`

见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:377`。

这里最重要的是 `refCnt() == 1`。当前注释已经把原因说透：如果用户对 cumulation 做过 `slice().retain()` 或 `duplicate().retain()`，那这块底层内容可能还有别的共享视图在活着，此时不应贸然整理底层字节布局。

这条边界和前面 ByteBuf 章节是同一条原则：

```text
共享数据的底层存储如果还可能被别的引用链看见，
那解码骨架就不能为了腾空间随便重整它。
```

### 3. `channelInactive()` 和输入半关闭都要走 `channelInputClosed()`，因为“最后一小段尾料”不能直接丢

当 channel inactive，或者收到 `ChannelInputShutdownEvent` 时，当前实现都会走 `channelInputClosed(...)`，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:390` 与 `:395`。

这一步之所以重要，是因为连接关闭前 cumulation 里可能还残留最后一点字节：

- 它也许刚好构成一条完整消息。
- 它也许是协议允许在 EOF 时收尾的一段内容。

所以父类这里的态度不是“连接都关了，剩下的算了”，而是：

```text
先尽最大可能把 cumulation 里还能解的内容解完，
必要时再给子类一个 decodeLast(...) 的收尾机会。
```

### 4. `decodeLast(...)` 不是另起一套协议，而是“最后一次 decode 机会”

`channelInputClosed(...)` 里会先 `callDecode(ctx, cumulation, out)`，然后如果 handler 没被移除，再拿当前 cumulation（若已变空则用 `EMPTY_BUFFER`）调用 `decodeLast(...)`，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:440`。

默认 `decodeLast(...)` 只是在 `in.isReadable()` 时再调一次 `decodeRemovalReentryProtection(...)`，见 `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:566`。

这说明它的定位非常克制：

```text
不是另起一条平行解码规则，
而是给子类在输入关闭边界上最后一次处理残留字节的机会。
```

相关测试 `testDecodeLastNonEmptyBuffer()`、`testFireChannelReadCompleteOnInactive()`、`testDecodeLast()` 都在不同角度验证了收尾语义，见 `codec-base/src/test/java/io/netty/handler/codec/ByteToMessageDecoderTest.java:175`、`:270`、`:551`。

## 七、`CodecOutputList`：为什么连输出列表都要专门池化

最后把 `CodecOutputList` 收一下。

很多人第一次读 `ByteToMessageDecoder`，会把它看成单纯实现细节，觉得“反正就是个 list”。可当前父类每次 `channelRead()` 都要 `newInstance()`，结束时都要 `recycle()`，见 `codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:93` 与 `:192`。

这说明它服务的是一个非常现实的高频场景：

```text
decode 可能在每次 inbound read 上都被调用，
而一次 callDecode 循环里又可能多次 fire 出消息；
如果每轮都 new 一个普通 ArrayList，GC 压力会非常稳定地出现在热路径上。
```

当前实现通过 `FastThreadLocal` 给每线程缓存 16 个 `CodecOutputList`，见 `codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:38`。它还用 `insertSinceRecycled` 记录本轮是否真的放入过元素，供父类更新 `firedChannelRead` 标记，见 `codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:101` 与 `:185`。

所以这不是协议层机制，而是骨架层的性能配套：

```text
既然父类统一接管 out 容器，
那它也顺手统一把这个高频容器的对象分配压力压下去。
```

这件事单独看不大，但它和前面 cumulation 生命周期、重入保护放在一起，就更能看出 `ByteToMessageDecoder` 的定位：这不是一个“帮你少写点样板”的父类，而是一整套长期运行的热路径骨架。

## 八、收网：ByteToMessageDecoder 真正提供的，不是某种协议，而是一套“积攒 + 循环 + 状态保护”的解码协议

现在回到开头那个问题：为什么 TCP 字节流不能“来一段解一段”？

因为 child pipeline 里真正面对的，不是带消息边界的对象流，而是分段到达、可能半包、也可能粘包的连续字节流。

所以 `ByteToMessageDecoder` 必须同时解决三件事：

- 数据不够时，能安全地把半包积攒下来。
- 数据够时，能在一次 read 里连续解出多条消息。
- 解码过程中哪怕发生重入、handler 移除或输入关闭，也不把内部状态搞乱。

当前父类给出的总骨架可以压成这样：

```text
channelRead(ByteBuf)
  -> cumulator 把旧半包 + 新输入合成 cumulation
  -> callDecode 循环驱动子类 decode
       -> 没产出且没消费：停，等更多数据
       -> 产出但没消费：子类违约，抛异常
       -> 还能继续推进：继续循环
  -> finally 里做输出分发、discard、回收
  -> 重入 / remove / input closed 由父类状态机兜底
```

所以这篇真正该带走的，不是某个 `decode()` 示例怎么写，而是下面这句话：

```text
ByteToMessageDecoder 的本质，
是把“半包积攒”“多消息循环”“重入与移除保护”这些所有字节流协议都会重复遇到的问题，
统一收成了一条父类协议。
```

有了这条骨架，下一篇那些看起来五花八门的拆包器——`FixedLengthFrameDecoder`、`DelimiterBasedFrameDecoder`、`LengthFieldBasedFrameDecoder`、`LineBasedFrameDecoder`——其实都只是各自实现 `decode()` 的不同边界判断而已。真正难的“怎么攒、怎么循环、怎么停、怎么防状态失真”，这一篇已经由 `ByteToMessageDecoder` 先替它们解决掉了。