# PooledByteBuf 生命周期：为什么 `release()` 背后是两次归还，而不是一次 free

> 本文基于当前 Netty `PooledByteBuf`、`AbstractPooledDerivedByteBuf`、`SimpleLeakAwareByteBuf` 与 `ResourceLeakDetector` 实现。前置：Ch4 `01-dual-index-and-refcnt.md`、Ch4 `04-views-and-zerocopy.md`、Ch8 `01-allocator-and-arena.md`、`02-chunk-and-buddy.md`、`03-subpage-and-threadcache.md`；本文聚焦池化 ByteBuf 的退出路径——双归还、派生视图释放顺序、泄漏后果与检测边界，不展开 Bootstrap 装配流程和 Adaptive allocator 的内部算法。

## 前三篇把“怎么借”讲完了，但真正难收尾的，其实是“怎么还”

到上一节为止，Netty 内存池最容易让人兴奋的部分基本都讲过了。

- `PooledByteBufAllocator` 先把请求归一成有限档位。
- `PoolArena` 决定 small、normal、huge 该往哪条路走。
- `PoolChunk` 把 run 切出来，再在 free 时做合并。
- `PoolSubpage` 和 `PoolThreadCache` 让高频小块分配不必每次都回共享结构里抢锁。

如果只看“借出来”这一半，池化世界像是一套非常顺滑的复用系统：申请一个 `ByteBuf`，写点数据，用完 `release()`，事情似乎就结束了。

可一旦把问题换成运行时视角，事情马上就不再那么简单。

```text
业务线程 / EventLoop 借到一个 pooled ByteBuf
  -> 它拿到的不只是一个 Java 对象
  -> 它还占着某个 chunk 里的 run 或 subpage elem
  -> 它甚至可能持有一个可复用的 tmpNioBuf
```

于是 `release()` 真正要解决的，就不再是“这个 Java 对象以后谁来管”这么单纯的问题，而是：

```text
这个 buffer 活着时占住的底层内存，怎么回到 Arena 体系？
这个 buffer 自己的对象外壳，怎么回到 Recycler？
如果它不是原始 buffer，而是 slice / duplicate 这样的派生视图，谁有资格把 parent 的引用计数减掉？
```

这篇文章就是要把这条线收完整。

前 3 篇讲的是池化分配如何成立；这一篇讲的是池化生命周期如何闭环。只有把“怎么还”讲清楚，前面那些 size class、run、subpage、thread cache 才不是一套只进不出的结构。

先把本文最核心的一句话放在前面，后面会反复回收它：

```text
PooledByteBuf 结束生命周期时，真正归还的是两套彼此独立的资源：
一套是底层内存，要回 Arena / Chunk / Subpage / ThreadCache。
一套是对象外壳，要回 Recycler。
```

如果脑子里少了这条主线，后面很多实现都会被误读。你会以为 `deallocate()` 就是一次普通 free；会以为派生视图只要把 parent 放掉就行；也会以为忘记 `release()` 最多只是多活一个 Java 对象。事实都不是这样。

## 一、如果把池化回收想成一次普通 free，三步就会走偏

正式看源码前，先故意走三条最常见、也最容易让人直觉相信的错误路线。

### 1. 误解一：`deallocate()` 不就是“把这块内存释放掉”吗

这条直觉来自 non-pooled 世界。

比如 `UnpooledHeapByteBuf.deallocate()` 就非常短，核心只做两件事：`freeArray(array)`，然后把 `array` 换成空数组，见 `buffer/src/main/java/io/netty/buffer/UnpooledHeapByteBuf.java:547`。如果底层是普通 heap byte[]，这条路径几乎就等于：

```text
这个 ByteBuf 不再持有原来的数组
  -> 后面的实际回收交给 JVM / GC 处理
```

所以很多人把这个经验直接带进 pooled 世界，会自然得出一个判断：`PooledByteBuf.deallocate()` 也就是“把自己占的那段内存标回空闲”。

问题在于，池化世界比这里多了一层约束：

- 它不只要让“这段内存不再属于当前 ByteBuf”。
- 它还要让“这段内存重新对下一次分配可见”。
- 同时还要让“当前这个 ByteBuf 对象本身也能被下次分配复用”。

也就是说，pooled 的退出路径从一开始就不是“退出对象”，而是“退出对象 + 退出底层池化占用”。

### 2. 误解二：对象和底层内存是一体的，所以选什么释放顺序都无所谓

这条误解也很自然。`PooledByteBuf` 在使用时看起来就像一个整体：

- 它有 `memory`。
- 它有 `chunk`。
- 它有 `handle`。
- 它对外暴露的是一个 `ByteBuf` API。

于是很容易觉得：既然这是同一个对象身上的几个字段，那释放时要么先清字段再回池，要么先回池再清字段，区别不会太大。

可当前实现偏偏在意这个顺序，而且在不同对象上还故意用了不同顺序：

- 原始 `PooledByteBuf`：先 `arena.free(...)`，再 `recyclerHandle.unguardedRecycle(this)`，见 `buffer/src/main/java/io/netty/buffer/PooledByteBuf.java:173`。
- 派生 `AbstractPooledDerivedByteBuf`：先 `recyclerHandle.unguardedRecycle(this)`，再 `parent.release()`，见 `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:85`。

如果顺序真无所谓，源码不会在这两个地方都写出这样明确的阶段划分。

这其实已经在提示我们：对象生命周期和底层内存生命周期虽然关联，但并不是一回事；而且不同角色退出时，风险点也不一样。

### 3. 误解三：派生视图释放时，当然应该先把 parent 放掉

这条误解尤其像“常识”。

设想一个 `retainedSlice()` 得到的派生对象。它自己并不拥有独立内存，只是共享 parent 的底层内容。那它释放时最像样的做法似乎应该是：

```text
先 parent.release()
  -> 让真正的底层拥有者先退场
再把自己这个小壳子回收掉
```

单从资源归属看，这很像正确答案。

问题是，派生对象不是一次性小壳子，而是会进入 Recycler 的可复用对象。如果你先把 parent 放掉，再把自己塞回对象池，就留下了一个时间窗口：这个派生对象外壳有可能在旧释放动作完全结束前，又被拿出来 `init(...)` 成一个新的派生对象。这样后面再去碰 `this.parent`，你碰到的就可能已经不是旧 parent 了。

当前源码在 `AbstractPooledDerivedByteBuf.deallocate()` 里专门写了注释说明这个风险：必须先把 `this.parent` 保存到局部变量，再 recycle 当前对象，否则同一个对象可能被再次取得并重新初始化，导致后续 `release()` 打到错误的 parent 上，见 `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:87`。

所以本文后面要讲的，不只是“谁先谁后”的实现细节，而是：

```text
不同 ByteBuf 角色退出时，真正要防的事故并不一样。
原始 pooled buffer 要防的是旧内存占用没退干净就把对象放回去。
派生 pooled buffer 要防的是对象壳子先被复用，导致 release 打到错误 parent。
```

带着这三条失败路线，我们再进主线，很多顺序就不再像“奇怪写法”，而会像“被问题逼出来的写法”。

## 二、`PooledByteBuf` 的退出主线：一次 `release()`，两套资源分别归还

先看 `PooledByteBuf` 活着时身上都挂着什么。

`init0(...)` 会把几个关键字段填进去：`chunk`、`memory`、`tmpNioBuf`、`allocator`、`cache`、`handle`、`offset`、`length`、`maxLength`，见 `buffer/src/main/java/io/netty/buffer/PooledByteBuf.java:60`。这几个字段里，真正决定后续回收路径的是四件东西：

- `handle`：这是上一节讲过的回程票，free 时靠它找回 run 或 subpage elem。
- `chunk`：这是底层内存真正挂靠的 chunk。
- `cache`：free 时决定能不能先回 ThreadCache 快路径。
- `recyclerHandle`：这是对象外壳回 Recycler 的入口。

换句话说，一个 `PooledByteBuf` 活着，不是单纯“有块内存可用”，而是同时占着两层资源：

```text
底层池化内存占用
  -> 由 chunk + handle + cache 串回 Arena 体系

对象外壳占用
  -> 由 recyclerHandle 串回 Recycler 体系
```

这也是 `deallocate()` 为什么不是一句 `free(memory)` 能讲完的根源。

### 1. 真正的退出点不是 `release()`，而是“引用计数归零后触发 deallocate”

ByteBuf 前面已经讲过引用计数：`release()` 本身只是在引用计数意义上减少持有者；只有减到 0 时，真正的释放逻辑才会发生。

所以这里最重要的不是把 `release()` 当成某个神奇 API，而是把它读成一扇门：

```text
refCnt > 0
  -> 资源仍然属于当前这条引用链

refCnt == 0
  -> 现在才允许真正退场
```

这种分层非常关键。它保证 slice、duplicate、composite 这样的共享场景，不会因为某一条局部引用先调用 `release()`，就把底层内容提前还给内存池。

### 2. `PooledByteBuf.deallocate()` 先退的是底层内存，而不是对象外壳

`PooledByteBuf.deallocate()` 的关键部分很短，但每一步都在对付不同风险，见 `buffer/src/main/java/io/netty/buffer/PooledByteBuf.java:173`：

```java
@Override
protected final void deallocate() {
    if (handle >= 0) {
        final long handle = this.handle;
        this.handle = -1;
        memory = null;
        chunk.arena.free(chunk, tmpNioBuf, handle, maxLength, cache);
        tmpNioBuf = null;
        chunk = null;
        cache = null;
        this.recyclerHandle.unguardedRecycle(this);
    }
}
```

这里真正的动作顺序可以压成下面这张图：

```text
refCnt -> 0
  -> 取出旧 handle
  -> 把 this.handle 置为 -1，宣布“当前对象不再占有那段池化区域”
  -> 调 arena.free(...)
       -> 让 run / subpage elem 回到 Arena 体系
       -> 如果条件合适，还可能先回 ThreadCache
  -> 清掉 tmpNioBuf / chunk / cache 等旧挂钩
  -> recyclerHandle.unguardedRecycle(this)
       -> 让 PooledByteBuf 对象壳子回到 Recycler
```

这就是本文开头那句核心结论的第一次完整落地：

```text
先还底层内存
再还对象外壳
```

### 3. 为什么必须先 `arena.free(...)`，再 `unguardedRecycle(this)`

这里最值得警惕的，是把“对象回池”和“底层内存回池”看成同一种回收。它们根本不是同一层事情。

`arena.free(...)` 处理的是底层池化区域：

- 如果是 small，它可能先回 subpage 位图，再决定整段 run 是否真的腾空。
- 如果是 normal，它会把 run 放回 chunk 的可用结构，并尝试和邻居合并。
- 如果 thread cache 命中条件成立，它还可能先把条目塞进当前线程的缓存，而不是立刻回共享 arena。

这些路径前面几篇都已经建立过。这里要强调的是：无论具体走哪条支路，它们都属于“让底层内存重新进入可复用体系”的动作。

而 `recyclerHandle.unguardedRecycle(this)` 完全是另一套复用：它让下一次分配不必再 `new PooledHeapByteBuf` 或 `new PooledDirectByteBuf`。当前 `Recycler` 的类定义就把它标成 lightweight object pool，见 `common/src/main/java/io/netty/util/Recycler.java:39`；正文这里只需要抓住它的角色：这是对象外壳的复用池，不是底层 run/subpage 的复用池。

所以先后顺序不能写反。原因不是形式上的“资源先、对象后”，而是更具体的两层语义：

```text
当同一个 PooledByteBuf 外壳重新被拿出来复用时
它不应该还挂着上一轮尚未退回池化体系的底层占用信息
```

当前实现在回收对象前，已经：

- 把 `this.handle` 置成 -1。
- 把 `memory` 清空。
- 让 `arena.free(...)` 处理掉旧 handle 对应的底层占用。
- 再把 `chunk`、`cache`、`tmpNioBuf` 清掉。

这说明它要保证的不是“字段看起来干净”这么表面，而是：

```text
对象回 Recycler 时
上一轮底层内存占用已经完成回程
而不是只把 Java 对象塞回池里，底层状态却还悬着
```

### 4. 双归还为什么值得单独讲：因为它把“内存复用”和“对象复用”彻底拆开了

讲到这里，已经可以给“双归还”一个比大纲更准确的定义。

它不是说 `release()` 被调用两次，也不是说同一块内存会被回收两轮。它真正表达的是：

```text
PooledByteBuf 的生命周期里，有两类完全不同的可复用资源：
1. 底层 run / subpage elem / chunk 片段
2. ByteBuf Java 对象外壳
```

第一类资源复用，服务的是：

- 少走系统分配/释放
- 少切新页
- 少重新建立 run/subpage 状态

第二类资源复用，服务的是：

- 少创建 Java 对象
- 少制造 GC 压力
- 少为高频路径重复初始化外壳

它们可以同时发生，但并不是一个池。

这是理解 pooled 生命周期时最该记住的事实之一。因为一旦把这两类资源混成一个概念，很多边界就会被误写成口号，比如“release 之后内存和对象都自动回收了”。真实表述应该是：

```text
refCnt 归零以后
底层内存沿 Arena 体系回去
对象外壳沿 Recycler 体系回去
两条回程线在同一个 deallocate() 里衔接，但各自服务不同复用目标
```

## 三、和 `UnpooledHeapByteBuf` 一对照，就知道 pooled 省下来的不是“复杂度”

前面已经顺手看过 `UnpooledHeapByteBuf.deallocate()`，现在值得专门把它拉出来对照一次。

`UnpooledHeapByteBuf.deallocate()` 的关键实现只有：

```java
@Override
protected void deallocate() {
    freeArray(array);
    array = EmptyArrays.EMPTY_BYTES;
}
```

见 `buffer/src/main/java/io/netty/buffer/UnpooledHeapByteBuf.java:547`。

这条路径有几个明显特征：

- 没有 `handle`。
- 没有 `chunk` 回程票。
- 没有 `cache`。
- 没有 Recycler 对象回池。
- 没有 `arena.free(...)`。

也就是说，unpooled heap world 的问题极其简单：

```text
这个对象别再指着旧数组了
```

而 pooled world 多出来的是完整的资源归属恢复：

```text
这段内存重新可分配了吗？
它是回 ThreadCache、Subpage 还是 Chunk？
这个 Java 对象下次能不能不 new 直接拿来用？
```

这也是为什么“池化更快”从来不是一张免成本通行证。真正准确的说法应该是：

```text
池化把频繁分配/释放的成本前移成了一套更讲究的生命周期协议
只有调用方遵守 `retain/release` 纪律，这套协议才换得回来性能收益
```

如果业务代码不守这套协议，池化不会神奇地帮你兜底；它反而会因为底层内存不能回池，而让问题比 unpooled 更难受。这个坑我们在后面的泄漏小节再收。

先在这里做个路标：到目前为止，主线只需要记住两件事。

```text
第一，PooledByteBuf 的 deallocate 是双归还，不是普通 free。
第二，pooled 比 unpooled 多出来的收益，也来自更多的生命周期约束。
```

下面开始看最容易被讲错、也最能体现“顺序是被问题逼出来的”那部分：派生视图退场。

## 四、派生视图不是直接持有底层内存，但它仍然必须沿 parent 链有序退场

前面在 Ch4 已经强调过：共享数据不等于共享寿命。`slice()`、`duplicate()`、`retainedSlice()`、`retainedDuplicate()` 看起来都像“只是同一块内存的不同视图”，但在 pooled world 里，它们的生命周期并不完全一样。

这一节先把角色分清，再讲为什么 `AbstractPooledDerivedByteBuf` 要用一个反直觉顺序收尾。

### 1. retained 派生对象不是“随便包一层视图”，它会先为 parent 增加一次持有

以 `retainedSlice()` 和 `retainedDuplicate()` 为例：

- `PooledByteBuf.retainedSlice(...)` 返回 `PooledSlicedByteBuf.newInstance(this, this, index, length)`，见 `buffer/src/main/java/io/netty/buffer/PooledByteBuf.java:157`。
- `PooledByteBuf.retainedDuplicate()` 返回 `PooledDuplicatedByteBuf.newInstance(this, this, readerIndex(), writerIndex())`，见 `buffer/src/main/java/io/netty/buffer/PooledByteBuf.java:146`。
- 这两个工厂最终都会落到 `AbstractPooledDerivedByteBuf.init(...)`，见 `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:62`。

而 `init(...)` 一开头就做了一件非常关键的事：`wrapped.retain()`，见 `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:64`。

这一步的真实含义是：

```text
派生对象虽然不单独拥有底层内存
但它在自己的生命周期开始前，会先给 parent 增加一次引用计数
```

所以 retained 派生视图不是“无成本借个窗口看看”，而是：

```text
共享底层内容
  +
多出一条独立的生命周期分支
```

当前类注释也把这个设计点说得很明确：每个 pooled derived buffer 都维护自己的引用计数；如果释放时直接越过中间链路去动 root parent，就可能在别的 derived buffer 还没释放完时，把底层内容提前放掉，见 `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:33`。

### 2. 它维护的不只是一个 root parent，还维护“当前该找谁 release”

`AbstractPooledDerivedByteBuf` 里有两个关键引用：

- `rootParent`：真正暴露底层存储能力的那个 `AbstractByteBuf`。
- `parent`：当前派生对象在释放时应该去 `release()` 的上游节点。

这两个引用分开保存非常重要。它说明派生链不是一条“总是直接指向根”的简单关系，而是：

```text
读写能力可以走到底层 rootParent
生命周期回收则要尊重当前派生链上的 parent 关系
```

这也是为什么 `slice` 套 `retainedSlice`、`duplicate` 套 `retainedDuplicate` 时，不是所有对象都直接冲着最初那个原始 buffer 去做 `release()`。如果那样做，就会把中间派生对象自己的 refCnt 语义整个踩扁。

### 3. `deallocate()` 为什么先保存 parent，再清引用，再 recycle 自己，最后才 `parent.release()`

现在看真正关键的退出实现，见 `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:85`：

```java
@Override
protected final void deallocate() {
    ByteBuf parent = this.parent;
    this.parent = this.rootParent = null;
    recyclerHandle.unguardedRecycle(this);
    parent.release();
}
```

源码前面的注释几乎已经把事故模型讲穿了：如果不先把 parent 暂存起来，而是边 recycle 边从 `this.parent` 取值，就有可能在当前对象被重新取得并 `init(...)` 之后，`release()` 落到错误的 parent 上，见 `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:87`。

把这个风险翻成人话，就是：

```text
派生对象的危险点，不是“底层内容会不会立刻被回池”
而是“这个对象壳子回 Recycler 后，谁还能保证 this.parent 还是旧的那个”
```

所以它的退出顺序必须是：

```text
1. 先把旧 parent 抓到局部变量里
2. 把 this.parent / this.rootParent 清空
3. 把当前派生对象外壳回收进 Recycler
4. 再用刚才保存的旧 parent 做 release()
```

这就是为什么它看起来反常识，却又是当前实现里最安全的写法。

### 4. 这里的“先 recycle 自己再 release parent”并不是在鼓励 use-after-free

很多读者第一次看到这段顺序会紧张：既然对象都先 recycle 了，那不是可能马上就被别的线程或别的分配路径拿出来继续用了？这时候你后面才 `parent.release()`，会不会太晚？

这里要把风险点分层看。

对原始 `PooledByteBuf` 而言，必须先把底层内存归还动作做完再 recycle 对象，因为它自己就直接握着那张 `handle` 回程票。

对派生 `AbstractPooledDerivedByteBuf` 而言，它自己不直接把 chunk/run/subpage 还回 Arena。它要做的资源性动作只有一件：

```text
把自己对 parent 的那一次 retain 关系撤掉
```

因此它最先要保护的是“这次 release 打到正确 parent”，而不是“自己这层对象壳子还能不能晚一点回池”。这两种对象承担的责任不同，所以安全顺序也不同。

换句话说：

```text
原始 pooled buffer 的 deallocate 顺序，是围绕底层内存回程设计的。
派生 pooled buffer 的 deallocate 顺序，是围绕 parent 链正确退场设计的。
```

这不是风格差异，而是职责差异。

### 5. 清空 `parent/rootParent` 还有一个额外效果：别把旧引用链无谓拖住

当前源码里还有一条很容易被忽略的注释：清空 `parent` 和 `rootParent`，是为了让它们可以被 GC 用于 leak detection，见 `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:91`。

这句话不能被夸大成“清空引用就是回收机制”。真正的回收动作仍然是后面的 `parent.release()`。但它至少说明，当前实现明确不想让一个已经退场的派生对象继续无意义地挂住旧 parent 链。

这和前面说的“对象池复用风险”其实是同一个设计方向：

```text
对象回 Recycler 前
尽量把上一轮生命周期留下的旧关系摘干净
```

### 6. non-retained 视图是另一种玩法：共享内容，也共享引用计数委托

这里还得把一个很容易混淆的边界补上。

`AbstractPooledDerivedByteBuf.slice(...)` 返回的不是 retained 派生对象，而是 `PooledNonRetainedSlicedByteBuf`；`duplicate0()` 返回的是 `PooledNonRetainedDuplicateByteBuf`，见 `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:155` 与 `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:161`。

这两个 non-retained 变体有个共同点：它们把 `retain/release/refCnt/isAccessible` 一类动作全部委托给 `referenceCountDelegate`，见 `buffer/src/main/java/io/netty/buffer/AbstractPooledDerivedByteBuf.java:167` 之后的内部类实现。

这意味着：

```text
non-retained 视图共享的不只是底层内容
还共享引用计数语义
```

因此它们不需要像 retained 派生对象那样，自己再建立一条“先 retain parent，释放时再 release parent”的独立生命周期支路。它们本来就把计数责任委托回去了。

这也是读 pooled 视图时最该记住的区分：

```text
retained 视图：共享内容，但有自己独立的引用计数生命周期
non-retained 视图：共享内容，也共享引用计数委托
```

一旦把这两类对象混讲，就会把“为什么有的派生对象需要先 recycle 再 parent.release”整个说糊。

## 五、忘记 `release()` 时，卡住的不只是一个对象，而是整条回程线

现在可以收那个最现实的问题了：如果业务代码忘了 `release()`，到底发生了什么？

最粗浅的回答当然是“内存泄漏”。但这个回答在 pooled world 里太笼统，因为它掩盖了真正被卡住的层次。

### 1. 泄漏的第一后果不是日志，而是 `deallocate()` 压根不会发生

前面已经强调过，真正的退出点不是 API 名字叫 `release()`，而是引用计数有没有归零。

如果某条引用链一直没有把 refCnt 减到 0，那么后果非常具体：

```text
PooledByteBuf.deallocate() 不会跑
  -> arena.free(...) 不会跑
  -> recyclerHandle.unguardedRecycle(this) 也不会跑
```

这就意味着两层资源都被卡住了：

- 底层 run/subpage elem 没有重新进入 Arena 体系。
- 当前 ByteBuf 对象外壳也没有回 Recycler。

所以 pooled 泄漏不是“多留下一个 Java 对象”这么轻描淡写。它至少同时影响：

- 内存池命中率
- 可用 chunk/run/subpage 容量
- 对象池命中率
- 长时间运行下的整体内存占用

换句话说，忘记 `release()` 是把前面整章建立起来的复用体系一起掐断，而不是只漏掉一个壳子。

### 2. Leak detector 干的是“发现没归还”，不是“替你归还”

Netty 的 leak aware 包装入口在 `AbstractByteBufAllocator.toLeakAwareBuffer(...)`。这里会通过 `AbstractByteBuf.leakDetector.track(buf)` 给 buffer 绑一个 `ResourceLeakTracker`，然后包装成 `SimpleLeakAwareByteBuf` 或 `AdvancedLeakAwareByteBuf`，见 `buffer/src/main/java/io/netty/buffer/AbstractByteBufAllocator.java:40`。

`ResourceLeakDetector.track(obj)` 只是创建追踪器；`trackForcibly(obj)` 则是不管当前检测级别都强制创建一个追踪器，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:253` 与 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:266`。

关键点在于：这些 tracker 的职责是观测，不是代替回收。

一旦 `SimpleLeakAwareByteBuf.release()` 发现底层 `super.release()` 真正返回 `true`，它才会调用 `closeLeak()` 去关闭这个 tracker，见 `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:143`。如果 release 根本没做到引用计数归零，那 close 就不会发生。

所以 leak detector 的语义应该读成：

```text
如果对象最终被垃圾回收了，但 tracker 还没被正常 close
  -> 说明用户层没有按协议把生命周期走完
  -> 于是给你报 leak
```

它不是说：

```text
既然都检测到了，那就顺便把底层 run 还回去吧
```

当前 `ResourceLeakDetector.reportLeak()` 做的是从引用队列里捞到历史 leak，输出 traced 或 untraced 报告，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:311`。这是报告链，不是资源回收链。

### 3. 为什么 retained 派生对象还要“强制跟踪”

这里还有一个跟本文主线关系很近的细节。

`SimpleLeakAwareByteBuf.unwrappedDerived(...)` 遇到 `AbstractPooledDerivedByteBuf` 时，会先把它的 parent 更新成当前 leak-aware buffer，然后对 derived buffer 调用 `trackForcibly(derived)`，见 `buffer/src/main/java/io/netty/buffer/SimpleLeakAwareByteBuf.java:191`。

这说明当前实现明确不想让 retained 派生对象躲出泄漏检测视野之外。原因也很好理解：

```text
派生视图虽然共享底层内容
但它们有独立引用计数生命周期
如果其中一支 retained 链忘了 release
它一样会阻止 parent 链最终归零
```

所以本文前面说“共享数据不等于共享寿命”，到了 leak detection 这里也要再说一次，而且教学作用不同：

- 前面那次重复，是为了说明派生对象为什么要有自己的 release 顺序。
- 这里这次重复，是为了说明 retained 派生对象为什么也值得被单独追踪。

### 4. 报告里的“垃圾回收后才发现”不等于问题只是 GC 级别的

`ResourceLeakDetector` 的报错文案会提到：“`release()` was not called before it's garbage-collected”，见 `common/src/main/java/io/netty/util/ResourceLeakDetector.java:348`。

这句话很容易让人误会成：等对象 GC 了，问题才真正出现。

其实不是。真正的问题在引用计数没归零的那一刻就已经发生了：

- 底层内存没回池。
- 对象没回 Recycler。
- 后续分配可能更快打到新 chunk/new object。

GC 只是 leak detector 发现这件事的一个时机，不是问题发生的起点。

所以面对池化 ByteBuf 泄漏，最准确的心智模型应该是：

```text
泄漏检测报告是事后发现机制
真正丢失的是整个“引用计数归零 -> 双归还”回程协议
```

## 六、`AdaptivePoolingAllocator` 是边界，不是本篇主线的延长线

大纲里把 `AdaptivePoolingAllocator` 也列成了候选内容，但这里必须谨慎收边界，不然会把两套生命周期揉在一起。

当前 Netty 确实有 `AdaptivePoolingAllocator`，而且它也在做池化分配，入口是 `allocate(size, maxCapacity)`，见 `buffer/src/main/java/io/netty/buffer/AdaptivePoolingAllocator.java:254`。但它的内部角色是 `AdaptiveByteBuf`、`Chunk`、`MagazineGroup`、`Magazine` 这一套；它不是 `PooledByteBuf + PoolArena + PoolChunk + RecyclerHandle` 这条主线的简单换皮。

更具体地说，本文刚刚讲透的两个关键结论：

- 原始 pooled buffer 通过 `arena.free(...) + recyclerHandle.unguardedRecycle(this)` 双归还。
- 派生 pooled buffer 通过 `AbstractPooledDerivedByteBuf.deallocate()` 沿 parent 链有序退场。

这些结论的证据都落在 `PooledByteBuf` 这一支实现上。把 Adaptive allocator 直接混进来，会让读者产生一种错觉：只要名字里也有 pooling，它的生命周期就能直接套这套说明。当前源码并不支持这种外推。

所以本篇最合理的处理方式不是硬展开它，而是明确边界：

```text
Adaptive allocator 在当前仓库里存在
但它是另一套分配/复用组织方式
不应并入本文的 `PooledByteBuf` 生命周期主叙事
```

这不是逃避，而是版本边界纪律。正文只能讲当前证据支持的那条主线，不能因为大纲提到“都是池化”就把两套实现合成一锅。

## 七、收网：`release()` 只是门把手，真正退场的是两条资源链

现在回到文章最开始那个问题：为什么 `release()` 背后不是一次普通 free？

因为对 `PooledByteBuf` 来说，活着的从来不只是一个 Java 对象。

它活着时，至少同时占着：

- 一段池化体系里的底层内存。
- 一个可复用的 ByteBuf 外壳对象。
- 如果它是 retained 派生视图，还额外挂着 parent 链上的一次 retain 关系。

所以它死去时，也必须把这几条关系按规则拆开。真正该记住的总图是：

```text
原始 PooledByteBuf
  refCnt -> 0
    -> arena.free(...)
         -> 底层 run / subpage elem 回池化内存体系
    -> recyclerHandle.unguardedRecycle(this)
         -> 对象外壳回 Recycler

retained 派生 ByteBuf
  refCnt -> 0
    -> 暂存旧 parent
    -> 清掉旧 parent/rootParent 引用
    -> recyclerHandle.unguardedRecycle(this)
    -> parent.release()
         -> 沿 parent 链撤销这条派生生命周期分支
```

于是开篇的悬念也可以完整回收了。

`release()` 真正重要的，不是这三个字本身，而是它把对象送到了哪一条回程协议上：

- 对原始 pooled buffer，它把你送到“双归还”。
- 对 retained 派生 buffer，它把你送到“沿 parent 链有序退场”。
- 对忘记 release 的调用方，它什么都不会神奇补做，于是整条回程线一起卡住。

到这里，第 8 章的主线也就真正闭环了。

前 3 篇解决的是：池化内存怎样被切出来、缓存住、复用起来。
这一篇解决的是：这些借出来的 ByteBuf 用完后，怎样把底层内存和对象外壳分别送回去。

下一章进入 Bootstrap 时，视角会从“单个资源怎么分配和归还”切到“一个 Channel 从创建到注册时，前面这些基础设施如何第一次装配成活系统”。那时 allocator、EventLoop、Pipeline 和 Channel 不再是并列知识点，而会在一次 `bind()` 过程中真正汇合。