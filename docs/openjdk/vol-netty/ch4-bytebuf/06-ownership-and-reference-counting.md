# Ch4-06 Netty 对象所有权与引用计数协议

## 先把真正的问题说清楚

很多人第一次踩 Netty 的内存坑，并不是因为不会用 `ByteBuf`，而是因为脑子里一直带着一个在同步代码里很自然、到了 Netty 里却会失效的直觉：谁创建对象，谁最后销毁对象。

这个直觉在普通 Java 对象上通常不会立刻出事。你 new 一个对象，方法返回以后把引用丢掉，GC 迟早会接手。可 Netty 的很多对象不是这种命运。`ByteBuf` 可能背后挂着直接内存，也可能来自池化分配器；一个 HTTP 消息可能只是 `ByteBuf` 外面又包了一层 holder；一个 HTTP/2 frame 可能在 pipeline 里继续向下传，还要在子 stream channel 里再走一遍。对象从创建点到真正完成业务使命，中间会经过多个 handler、多个异步边界、多个包装层，甚至还会在出站缓冲区里短暂停留。

这时候，“谁创建谁销毁”就不够用了。创建者往往不知道对象什么时候真的用完；最后一个消费者往往不是最初的创建者；有些对象明明只是换了一个外壳，底下却还共享着同一块内存。于是 Netty 才不得不把这件事拆成两层：一层用引用计数回答“这个对象现在还活着吗”，另一层用对象所有权协议回答“这一次该由谁负责最后那次 `release()`”。

如果只看到 `refCnt()`、`retain()`、`release()` 这几个 API，很容易以为 Netty 只是把 GC 换成了手工计数。真正更麻烦、也更重要的部分，其实是 ownership，也就是责任如何沿着 pipeline、codec、holder、缓冲区和协议对象不断转移。`refCnt` 只是一个可验证的存活信号；它从来不会替你宣布“当前所有者是谁”。

这就是本篇要解决的核心困惑：**在 Netty 里，引用计数只是寿命计量器，对象所有权才是运行时真正的协议。**如果这一点不先建立起来，后面无论是 leak detector、`ChannelOutboundBuffer`，还是 HTTP/2 frame 的 release 规则，都会看起来像零散的特例。

## 先拆开两个总被混在一起的概念

理解 Netty 的对象生命周期，第一步不是记 API，而是先把两个很像、却不能混在一起的概念分开。

第一个概念是“活着”。一个对象的 `refCnt` 大于 0，表示它还处在可用状态；降到 0，就说明底层清理逻辑已经触发，后续再访问通常会走向非法状态。`ReferenceCounted` 接口的合同非常直接：新对象初始引用计数为 1，`retain()` 增加计数，`release()` 减少计数，归零时显式释放资源，访问已释放对象通常会出问题，见 `common/src/main/java/io/netty/util/ReferenceCounted.java:19`。

第二个概念是“归谁管”。也就是：当前这份对象是谁在用，谁准备继续往下传，谁必须在失败时兜底，谁应该做最后一次 `release()`。这个问题并不写在 `ReferenceCounted` 的接口里。接口只说“可以 retain，可以 release，可以 touch”，但没有任何一行替业务决定“收到消息以后是继续转发，还是消费并终结，还是临时缓存等待异步写出”。

这两个概念之所以总被混淆，是因为它们在最简单的场景里经常重合。比如某个 handler 收到一个入站 `ByteBuf`，读完以后不再往后传，那它既是当前使用者，也常常是最后一个释放者。可一旦场景复杂起来，这种重合就会消失。

- 一个 handler 只是观察消息然后继续 `fireChannelRead`，它触碰了对象，但未必拥有最终释放责任。
- 一个 encoder 把旧对象编码成新对象，它可能在本次写操作里消费掉旧对象的 ownership。
- 一个 `ByteBufHolder` 只是给 `ByteBuf` 加了外壳，外壳和内容通常共享同一份生命周期。
- 一个 `ctx.write(msg)` 把对象交给出站链以后，正常成功、失败关闭、延迟 flush，对象释放时机都可能不在当前调用栈里。

所以在 Netty 里，最危险的误解不是“不知道要 release”，而是以为 `refCnt` 已经把 responsibility 一起定义好了。其实它没有。`refCnt` 只能告诉你对象还活着没有，不能告诉你谁该为它的死亡负责。

这个区分很重要，我们后面会反复回到这里：**存活状态是计数问题，责任归属是协议问题。**Netty 通过引用计数把寿命变得可验证，又通过 ownership 约定把责任在各个角色之间传递。两层都对，生命周期才不会失控。

## 一个直觉上很合理、实际上会连续出错的方案

要看清 Netty 为什么非得搞出 ownership 协议，最好的办法不是先看源码，而是先推演几个直觉上很自然的方案，看看它们为什么都不够。

第一个失败方案，是最符合普通 Java 经验的：只靠 GC。既然对象最终都会不可达，那让 GC 回收不就行了？这个方案的问题不在“最终能不能回收”，而在“业务什么时候算真正完成”。Netty 的 `ReferenceCounted` 文档从一开始就把对象描述成“requires explicit deallocation”，也就是需要显式释放，见 `common/src/main/java/io/netty/util/ReferenceCounted.java:19`。这句话的潜台词非常重：Netty 关心的不是“未来某个时刻终究能回收”，而是“在业务层面已经不再需要时，能不能立刻、确定地收尾”。对于直接内存、池化对象、异步长连接场景，这个时机如果完全交给 GC，往往就已经太晚了。

第二个失败方案，是“谁创建谁释放”。这在同步栈里看起来很干净：你分配，你负责回收。问题是 Netty 的消息会流动。一个 `ByteBuf` 被 decoder 切出来以后，后面也许还会经过聚合器、业务 handler、异步 write、出站缓冲区；最早创建它的那一层，根本不知道哪一步才是真正的消费终点。创建点知道出生，不知道葬礼。

第三个失败方案，是反过来极端化：谁收到谁释放。这个方案比上一个更危险，因为 pipeline 里大量 handler 并不是终点，它们只是中转站。只要消息还要继续向后传播，过早 release 就会让后续 handler 拿到一个已经失效的对象。`ReferenceCounted` 接口文档已经提醒：引用计数降到 0 以后，再访问通常会出错，见 `common/src/main/java/io/netty/util/ReferenceCounted.java:23`。所以“只要我碰过它，我就立刻 release”根本不是安全规则。

第四个失败方案，是所有人都不 release，等 channel 关闭统一兜底。这个方案短时间内最有迷惑性，因为程序一开始甚至可能跑得挺正常。问题在于，兜底路径不是正常路径。像 `ChannelOutboundBuffer` 确实会在关闭时释放还没刷出的消息并 fail 掉 promise，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:720`。但那是“连接已经走到失败或关闭边界，只能由运行时清仓”的补救动作，不是平时对象应该停留的归宿。把所有对象都拖到 close 再释放，等于把临时借用、正常消费、失败兜底三种语义全部混成一种，最后不是 leak，就是延迟堆积。

第五个失败方案，是把 `retain()` 当成复制。很多新手看到“引用计数 +1”，很容易脑补成“我相当于复制出了一份，之后就各管各的”。这恰好和 Netty 的真实语义相反。`retain()` 只是在共享同一底层对象的前提下延长寿命，它不会复制底层内容，也不会自动生成一份新的所有权说明书。后面看到 `ByteBufHolder.retain()`、`retainedDuplicate()`、HTTP/2 frame retain 规则时，这个误解尤其容易把人带偏。

这几个失败方案放在一起，答案就逐渐清楚了：Netty 不是简单要求“记得调 release”，而是要求每个角色在对象流转的每个边界上都说清楚一件事——**我现在是继续借用、转交 ownership，还是终结 ownership。**引用计数只是把这个决定变成可执行、可校验、可失败的操作。

## 引用计数骨架其实非常克制

如果只看接口和基类，Netty 在这件事上其实比很多人想象得更克制。它没有试图在框架底层发明一套宏大的“对象所有者类型系统”，也没有在接口里塞进一堆高层语义。它做的事情很朴素：给所有需要显式释放的对象一套统一的寿命计量骨架。

`ReferenceCounted` 接口只定义了六类动作：读当前计数、增加计数、减少计数、记录 touch 调试信息，见 `common/src/main/java/io/netty/util/ReferenceCounted.java:32`。这意味着框架底层非常清楚自己的边界：它可以强制每个对象都服从“归零才释放”的物理规律，但它不替上层业务决定释放责任的归属。

这个接口在通用对象和 `ByteBuf` 上各有一个抽象模板。通用对象走 `AbstractReferenceCounted`。这个类的结构几乎把事情说尽了：内部持有一个 `RefCnt`，`retain()` 调用 `RefCnt.retain`，`release()` 调用 `RefCnt.release`，一旦返回结果表示归零，就执行 `deallocate()`，见 `common/src/main/java/io/netty/util/AbstractReferenceCounted.java:23`、`common/src/main/java/io/netty/util/AbstractReferenceCounted.java:57`。`ByteBuf` 版本则是 `AbstractReferenceCountedByteBuf`，模式完全同构，也是 retain/release 委托给 `RefCnt`，归零时进入 `deallocate()`，见 `buffer/src/main/java/io/netty/buffer/AbstractReferenceCountedByteBuf.java:24`、`buffer/src/main/java/io/netty/buffer/AbstractReferenceCountedByteBuf.java:82`。

这里最值得注意的，不是模板有多复杂，而是模板刻意没有做什么。

它没有说“谁调用了 retain，谁以后必须 release”。
它没有说“哪个线程是合法所有者”。
它没有说“对象在 pipeline 里传播时 ownership 自动怎么转”。
它只做一件事：把生命周期的终点统一成 `deallocate()`，把从存活到死亡的跃迁统一成 `release()` 归零。

这就是为什么说 `refCnt` 不是 ownership 本身。ownership 协议发生在模板之外，发生在对象如何被包装、如何被转发、如何被缓冲、如何被 codec 消费这些具体场景里。模板只提供一个全系统共享的物理底座：不论你是谁，只要最后一次 `release()` 发生，资源收尾就能落到 `deallocate()` 上。

这个设计的好处，是所有上层组件都可以把“什么时候该终结 ownership”表达成同一种动作：`release()`。无论是业务 handler 消费完一个入站 `ByteBuf`，还是 encoder 消费完一个旧消息，还是 channel 关闭时出站缓冲区清空未发消息，最终都能回到同一个收尾入口。这种统一性比“自动替你猜所有者是谁”更可靠，因为框架能统一的是寿命终点，不能统一的是业务语义。

## 真正难的部分：五类角色如何分担责任

理解 ownership，不能只盯着对象本身，还要盯着对象在流转过程中遇到的角色。把这些角色拆出来，很多模糊地带就清楚了。对 Netty 来说，至少有五类角色最常见：创建者、转发者、消费者、包装者、缓冲者。

### 创建者

创建者负责把一个 `ReferenceCounted` 对象带入系统，默认拥有第一份责任。`ReferenceCounted` 文档明确写了新对象初始引用计数为 1，见 `common/src/main/java/io/netty/util/ReferenceCounted.java:21`。这意味着一旦你创建了对象，除非你马上把责任明确转交，否则你天然背着一份要么传递、要么终结的义务。

但创建者并不天然等于最终释放者。创建者最重要的职责，其实是决定第一跳往哪走：直接消费、交给下游 handler、交给 encoder、交给 `ctx.write`，还是包装进另一个 holder。创建者在第一跳做出的动作，会决定 ownership 是继续留在自己手里，还是开始转移。

### 转发者

转发者的典型例子，是 pipeline 里那些观察消息、修改少量元数据、然后继续把消息向后传的 handler。它们不是最终消费者，所以最关键的事情不是“用完赶紧 release”，而是“别把还要继续走的对象提前杀死”。

转发者真正需要判断的是：我只是借用它，还是我要让它脱离原本那条流转路线，在别的地方继续存活？如果只是同步观察然后继续原路传播，通常不需要额外 retain；如果要把对象保存起来、异步回调以后再用、或者同时交给多条路径，那就要开始讨论 retain 和新的释放责任了。

这也是为什么不能把 `refCnt` 理解成 ownership 的自动说明。转发者最怕的不是“忘了当前计数是多少”，而是没想清楚自己到底是在借用，还是在另起一份更长的生命周期。

### 消费者

消费者是最接近“最后释放者”的角色。它接过对象以后，不再往后传，也不再保存给别人，而是把对象的业务价值在这里终结。对于这种角色，`release()` 就不仅是技术动作，而是 ownership 协议的闭环动作。

Netty 的危险之处在于，很多角色表面上看像消费者，实际上不是。比如一个 encoder 接收旧对象并产出新对象，从旧对象的角度它是消费者；但从整个 pipeline 的角度，它又只是把语义换了一种形态继续往后写出。这个例子说明：消费不是“整个请求结束了”，而是“当前这份对象的责任到这里结束了”。

### 包装者

包装者是 Netty 生命周期里最容易让人出错的一类角色，因为它会制造一种错觉：对象看起来换了一个新外壳，于是很多人下意识以为生命周期也被切断了。`ByteBufHolder` 正好说明这件事并没有这么简单。

`ByteBufHolder` 本身就是 `ReferenceCounted`，同时暴露 `content()` 返回底层 `ByteBuf`，见 `buffer/src/main/java/io/netty/buffer/ByteBufHolder.java:23`。这句话的含义很强：holder 不是站在引用计数协议之外的普通包装类，它和底层 content 共享生命周期契约。

`DefaultByteBufHolder` 更把这种共享关系写得非常彻底。它的 `refCnt()` 直接委托给底层 `data.refCnt()`，`retain()` 调底层 `data.retain()`，`release()` 调底层 `data.release()`，见 `buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:80`、`buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:109`。换句话说，外层 holder 没有自己独立的一份引用计数；它只是把底层 `ByteBuf` 的寿命协议带到了更高层对象上。

这就是为什么“我拿到的是 HTTP 消息/HTTP2 frame，不是 ByteBuf，所以不用管 release”这种想法一定会出事。对 Netty 来说，很多高层协议对象只是把 ownership 协议继续向上抬了一层，而不是把它抹掉。

### 缓冲者

最后一类是缓冲者，也就是那些不会立刻消费对象，而是把它暂存在队列、缓冲区或异步边界之后等待后续处理的角色。缓冲者最容易被忽略，因为它通常不写业务逻辑，却经常在真正的生命周期边界上接管责任。

典型例子就是 `ChannelOutboundBuffer` 和 `PendingWriteQueue`。它们收到对象以后，不是马上发送成功，也不是立刻失败，而是先把对象托管起来，等待 flush、等待 event loop、等待底层可写，或者等待 channel 关闭后的兜底清理。只要这一步 ownership 不被明确定义，业务层就很难知道“现在到底还能不能碰这个对象，失败时谁会替我 release”。

所以真正成熟的理解方式不是“哪个类最重要”，而是“对象经过了哪些角色，每个角色到底是在借用、转交还是终结”。Netty 的 ownership 协议，本质上就是这些角色之间的责任传递图。

## `ByteBufHolder` 让“外壳换了，寿命没换”这件事变得可见

前面说包装者危险，是因为它太像“新对象”。`ByteBufHolder` 是最适合拿来建立这层直觉的例子。

`ByteBufHolder` 自己扩展了 `ReferenceCounted`，并定义了 `content()`、`copy()`、`duplicate()`、`retainedDuplicate()` 和 `replace()`，见 `buffer/src/main/java/io/netty/buffer/ByteBufHolder.java:23`。如果把这些方法连起来看，就会发现它想表达的不是“这是一个和 ByteBuf 无关的外层盒子”，而是“这是一个带协议语义的盒子，但底层仍由 ByteBuf 的生命周期驱动”。

`DefaultByteBufHolder.content()` 调用的是 `ByteBufUtil.ensureAccessible(data)`，见 `buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:34`。这一步非常有代表性：外层 holder 在把内容交给你之前，仍然要经过底层可访问性检查。这说明 holder 并没有把生命周期问题屏蔽掉，它只是让你通过更高层的抽象间接碰到底层内容。

再看几个复制和派生相关的方法。

- `copy()` 默认走 `replace(data.copy())`，见 `buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:44`。
- `duplicate()` 默认走 `replace(data.duplicate())`，见 `buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:53`。
- `retainedDuplicate()` 默认走 `replace(data.retainedDuplicate())`，见 `buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:63`。

这三个动作之所以重要，不是因为 API 名字不同，而是因为它们逼着你承认一个事实：看起来都是“给 holder 换个内容”，但底层生命周期语义并不一样。`copy()` 倾向于拿到一份新内容；`duplicate()` 只是视图复制，不自动 retain；`retainedDuplicate()` 明确延长共享底层内容的寿命。也就是说，**外层 holder 的身份根本不足以决定 ownership，真正决定责任的是底层 content 到底是复制了、共享了，还是共享后又延长了寿命。**

Netty 在这里做得非常诚实：它没有用 holder 把复杂性藏起来，而是把复杂性以更高层的接口形式继续暴露出来。你可以用 holder 来承载 HTTP、WebSocket、HTTP/2 等更丰富的语义，但 release 责任并不会因此消失，只会跟着 content 一起向上传导。

这也解释了一个常见误区：很多人觉得“如果一个对象只是包装另一个对象，那我只要管理最里层 ByteBuf 就行，外层 holder 无所谓”。实际上 Netty 的很多 API 是围绕 holder 设计的，释放外层 holder 本身就是触发底层 content 生命周期动作的合法入口。`DefaultByteBufHolder.release()` 直接调用 `data.release()`，见 `buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:109`。所以把 holder 和 content 的责任拆成两套来想，往往只会让你重复 release 或漏 release。

## codec 边界最能暴露 ownership 的转移

如果只在裸 `ByteBuf` 场景里看 ownership，很多人仍然会觉得这只是“内存对象多传了几次”的问题。真正让 ownership 变得显形的，是 codec 边界。因为 codec 的本质就是：它经常拿到一个旧对象，消费它的某些语义，然后生成一个新对象继续往后传。

`MessageToMessageEncoder.write()` 是一个非常典型的证据。这个方法先判断消息类型，创建 `CodecOutputList`，调用 `encode(ctx, cast, out)`，然后无论编码结果如何，都会在成功路径里执行 `ReferenceCountUtil.release(cast)`，见 `codec-base/src/main/java/io/netty/handler/codec/MessageToMessageEncoder.java:82`、`codec-base/src/main/java/io/netty/handler/codec/MessageToMessageEncoder.java:95`。这段逻辑说明了一件很关键的事情：**对这个 encoder 来说，旧对象在被成功编码以后，ownership 默认已经被消费掉了。**

这不是一个“方便你少写一行 release”的小优化，而是一条明确的边界声明。encoder 收到旧消息，产出新消息，随后释放旧消息，说明编码前后的对象不是同一份 ownership。即使业务语义还在继续，比如最终还是同一次 write、同一次请求、同一条连接，这一份“旧消息对象”的生命周期已经在 codec 这里结束了。

这也是为什么正文里反复强调：不能把“整个业务还没结束”和“当前对象还没结束”混成一件事。codec 最擅长做的，就是让这两件事分离。旧对象结束，新对象继续。旧的所有权关闭，新的所有权开启。理解了这一点，后面再看 HTTP 编解码、HTTP/2 frame 映射、聚合器、压缩器，很多原本看起来像魔法的 release 动作就不再神秘。

`CodecOutputList` 的存在还进一步说明，对象流 codec 不只是语义转换器，还是运行时的小对象复用点。它自己用 `FastThreadLocal` 缓存一组 `CodecOutputList`，见 `codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:38`。这条线本篇不展开，但它提醒我们：Netty 的 ownership 协议并不是一层抽象薄膜，而是和对象复用、线程本地缓存、编码写出路径绑在一起的。codec 一边决定旧对象何时释放，一边决定新对象如何被批量写出，这就是为什么 ownership 不能只当成“内存管理习惯”。

## write 之后，对象会暂时进入 Netty 的托管区

很多关于 ownership 的争论，最后都会卡在一个非常实际的问题上：`ctx.write(msg)` 之后，这个 `msg` 还算不算我的？

如果只看同步代码，最容易得到两个极端答案。一个是“已经交给 Netty 了，从此和我没关系”；另一个是“反正还没真正发出去，所以还是归我”。真实情况比这两个答案都更细。

`ChannelOutboundBuffer.addMessage()` 能很好地说明这条边界。它在把消息封装成 `Entry` 加入链表后，会先对消息执行一次 `touch()`，然后再增加 pending bytes，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:114`、`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:127`。这说明一旦 write 进入出站缓冲区，Netty 已经把它当成“我接下来要负责托管的一份对象”了：它会参与可写性统计，会进入后续 flush / writev 路径，也会进入失败清理路径。

再看 `ChannelOutboundBuffer.nioBuffers(...)`。这个方法会从 flushed entries 里提取 `ByteBuf`，并借助 `InternalThreadLocalMap` 上的 `ByteBuffer[]` 缓存来组织底层写出数组，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:432`、`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:437`。这一步进一步说明，对象一旦进入出站层，就不再只是“业务的一个 Java 引用”，而是已经成为 Netty 运行时写出链的一部分。

但这并不等于“write 以后业务永远不用再考虑它”。因为 ownership 的转交是阶段性的。正常情况下，对象会随着写成功而完成这段托管；异常情况下，它可能在 channel close 或 fail 路径里被出站层释放。`ChannelOutboundBuffer.close(...)` 就会遍历还没 flush 的 `unflushedEntry`，对消息做 `ReferenceCountUtil.safeRelease(e.msg)`，并把 promise 标成失败，见 `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:720`。这说明出站层确实承担了兜底责任，但承担的是“我已经接管这段生命周期以后”的兜底，不是“你想什么时候随便丢都行”。

`PendingWriteQueue` 把这个边界写得更直白。类注释直接说，它是一组稍后执行的写操作队列，同时会把这些待写消息也纳入 channel 的 writability 判断，见 `transport/src/main/java/io/netty/channel/PendingWriteQueue.java:30`。在 `add(...)` 里，它同样会统计 pending bytes，并对消息调用 `touch()`，见 `transport/src/main/java/io/netty/channel/PendingWriteQueue.java:120`。而在 `removeAndFailAll(...)` 里，如果这些待写消息最终失败，它会主动 `safeRelease(write.msg)`，见 `transport/src/main/java/io/netty/channel/PendingWriteQueue.java:182`。

这两段代码共同说明：**write 不是立刻发送成功，write 是把对象交给 Netty 的一段托管生命周期。**在这段生命周期里，对象既不再完全属于原始业务调用点，也还没有抽象到“无需任何责任”的程度。业务要做的不是“write 完立刻再 release 一次”，而是明确这次 write 是否已经构成所有权转移；一旦转移成立，后续失败释放就应该交由出站运行时兜底。

所以对 `ctx.write(msg)` 最准确的理解不是“发送”，而是“交接”。交接之后，Netty 运行时开始承担一段有限但真实的所有权责任。

## HTTP/2 再次证明：ownership 协议不会因为协议层升高而消失

如果 ownership 只停留在 `ByteBuf` 和出站缓冲区层面，它还可能被误解成一个偏底层的技巧。HTTP/2 API 层恰好能说明不是这样。

`Http2FrameCodec` 的类注释专门有一节 `Reference Counting`。里面写得非常明确：某些 `Http2StreamFrame` 因为携带了 `ByteBuf` 等引用计数对象，本身也实现了 `ReferenceCounted`；frame codec 在把这类对象向 pipeline 传播之前，会先调用 `retain()`，因此应用在消费完以后仍然需要 release，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:131`。这几句话非常有分量，因为它等于在协议 API 层又重复了一遍本篇的核心结论：框架可以帮你做传播前的 retain，但不会替你抹掉消费后的 release 责任。

`Http2MultiplexHandler` 的文档也沿用了同样的规则。它明确说，某些 `Http2StreamFrame` 携带引用计数对象，multiplex codec 在传播前会 retain，因此应用 handler 消费后仍要 release，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:67`。而且这里的场景比普通 pipeline 还更复杂：对象不只是在一个 channel 的 handler 链里流动，还可能被映射到 child stream channel。可即便抽象层级更高、路由更复杂，ownership 协议仍然没有变得自动化。

这说明什么？说明 ownership 不是 `ByteBuf` 私有语法，而是 Netty 整个对象流系统共享的通用规则。协议层可以把消息改造成 frame、holder、stream object，也可以把一条连接拆成多个 child channel，但只要底层还有引用计数对象，最终都得回到同一件事：这个对象现在是谁在消费，消费完以后谁负责 release。

所以当我们说“引用计数是协议，不是小技巧”时，真正的证据并不是某个 `ByteBuf` 的实现细节，而是 HTTP/2 这样更高层的 API 仍然在重复强调同一条责任链。越高级的抽象，没有把 ownership 消掉，只是把它变得更不容易一眼看见。

## 最容易混淆的几件事

到这里为止，主线其实可以收束成一句话：**Netty 用 `refCnt` 统一了寿命终点，用 ownership 约定了责任转移。**但这句话容易在几个地方被误读，最好在结束前把常见误解逐个澄清。

第一，`refCnt` 不是 ownership。本篇前面已经反复讲过，但这里还要再收一遍。`refCnt` 只描述对象是否仍然活着，见 `common/src/main/java/io/netty/util/ReferenceCounted.java:34`。ownership 描述的是“当前谁对最后一次 release 负责”。一个对象完全可能 `refCnt > 0`，但责任已经从创建者转移到出站缓冲区、到 codec、到后续 handler。

第二，`retain()` 不是 copy。`retain()` 只是在共享底层对象的前提下延长寿命，不会复制底层内容，也不会自动把责任一分为二。真正看起来像复制的动作，要去看 `copy()`、`duplicate()`、`retainedDuplicate()` 这种 API，它们在底层共享程度和生命周期语义上都不同，见 `buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:44`、`buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:53`、`buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:63`。

第三，拿到 holder 不等于摆脱 release 责任。`ByteBufHolder` 自己就是 `ReferenceCounted`，见 `buffer/src/main/java/io/netty/buffer/ByteBufHolder.java:23`；`DefaultByteBufHolder.release()` 最终还是释放底层 `ByteBuf`，见 `buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:109`。高层协议对象只是把这条责任链延长，并没有中断。

第四，`ctx.write(msg)` 不等于“现在就可以当它完全结束了”。更准确地说，write 表示 ownership 开始向 Netty 出站运行时转交。后续是成功写出、失败清理还是 channel close 兜底，要看对象在那段托管区里最终经历了什么。把 write 当成“马上发送成功”的同步动作，是大量过早 release 问题的源头。

第五，兜底释放不是正常语义。`ReferenceCountUtil.safeRelease(...)` 存在，是因为 Netty 承认失败路径里经常需要尽量回收对象并吞掉异常，见 `common/src/main/java/io/netty/util/ReferenceCountUtil.java:107`。但 safeRelease 的存在不意味着平时可以不想责任，只等异常时再说。正常路径里，ownership 仍然应该在每个边界上被明确地传递或终结。

## 收网：后面那些看似零散的规则，其实都挂在同一根主线上

现在再回头看最初那个问题：为什么 Netty 里“谁该 release”总是说不清？答案已经不难了。因为它根本不是一个单纯的 API 记忆问题，而是一套跨层共享的对象所有权协议。

- `ReferenceCounted` 和两个抽象基类只负责统一“归零时收尾”这件事。
- `ReferenceCountUtil` 提供跨对象形态的 retain/release/touch/safeRelease 兜底入口，见 `common/src/main/java/io/netty/util/ReferenceCountUtil.java:26`。
- `ByteBufHolder` 说明外层包装不会抹掉底层生命周期，只会把它继续向上传导。
- codec 说明旧对象 ownership 可以在语义转换点被消费，新对象继续往下走。
- `ChannelOutboundBuffer` 和 `PendingWriteQueue` 说明 write 以后会进入 Netty 运行时的托管区，失败时由运行时兜底释放。
- HTTP/2 API 层说明这套协议并不会因为抽象层升高而消失，反而会被更明确地提醒给应用。

所以本篇真正要留下来的心智模型只有一个：**在 Netty 里，不要先问“这个类要不要 release”，而要先问“这个对象现在归谁负责，它是在借用、转交，还是终结”。**只要这个问题答清楚，`retain()`、`release()`、`touch()`、`safeRelease()` 这些动作才有位置；否则它们看起来永远像一堆零散习惯用法。

这也是为什么后面的几篇必须按这个顺序继续展开。下一步写 leak detector，不是为了再介绍一个新工具，而是为了说明当 ownership 协议被破坏时，Netty 如何记录和定位泄漏。再下一步写 `ChannelOutboundBuffer` 和 writability，也不是单纯讲缓冲区，而是把“运行时托管区如何接管对象生命周期”完整展开。等这两条线接上，再看 HTTP/2 frame 和 multiplex child channel 的 release 规则，整个系统才会真正闭环。