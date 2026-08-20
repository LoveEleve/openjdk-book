# PoolChunk 的 run 管理：当前实现不是 memoryMap 树，而是可用 run 表 + handle 编码

> 本文基于当前 Netty `PoolChunk` / `PoolSubpage` 实现。前置：Ch8-01 `01-allocator-and-arena.md`；本文聚焦 `PoolChunk` 的可用 run 管理、handle 位编码、`allocateRun/allocateSubpage/free/collapseRuns`，不展开 ThreadCache 和 Subpage 位图细节。

## 先纠正一张很常见、但在当前源码里已经过时的地图

讲 Netty 内存池时，经常会看到一种很熟的叙述：`PoolChunk` 内部维护一棵 `memoryMap[]` 完全二叉树，节点存树深或可用层级，分配时从树根往下找，释放时再沿“兄弟节点”向上合并。

这张地图在很多旧资料里存在，也解释了为什么不少人一提到 Netty 内存池，第一反应就是“Buddy 二叉树”。

问题是：当前这份源码已经不是那套实现了。

`PoolChunk` 自己的大段类注释写得很清楚：它现在围绕的是 `runsAvailMap`、`runsAvail`、`allocateRun(size)`、`allocateSubpage(size)` 和 `free(handle)` 这几套结构，见 `PoolChunk.java:29-137`。你在当前类字段里能直接看到：

- `LongLongHashMap runsAvailMap`
- `IntPriorityQueue[] runsAvail`
- `PoolSubpage[] subpages`

见 `PoolChunk.java:161-173`。

也就是说，如果我们继续拿“memoryMap[] 树深数组”来讲当前实现，就会从第一步开始带着读者走错路。

所以本篇必须先立一个版本边界：

```text
当前 Netty 的 PoolChunk
不是“先把树讲清，再套源码”
而是“先把可用 run 表、handle 编码和连续 run 合并讲清”
```

这不意味着“Buddy”这个词完全失效。高层上它仍然能帮助理解“连续块切分、释放后再合并”的味道。但如果把这种高层比喻直接写成当前源码结构，就会把真正的实现细节说反。

因此这篇文章的主线不是“树怎么走”，而是：

```text
Chunk 如何记录可用 run
Chunk 如何把一段可用 run 切给请求
Chunk 如何在 free 时把连续空 run 并回去
Chunk 如何用一个 handle 把这些元数据带出再带回
```

## 一、handle：为什么 Arena 不返回一个分配结果对象

### 1. 因为一次分配之后，后面还要带着这份定位信息继续走很多层

上一节已经讲过，`PoolArena.allocate(...)` 最终会把某个 `PooledByteBuf` 初始化出来。但 arena 本身并不真正关心“这个 ByteBuf 在 chunk 里的偏移、页数和子页 bitmap 位”该怎么一直带着走，它只负责把请求导到合适的路径。

真正需要长期携带这些信息的，是后续链路：

```text
分配成功时
  -> PooledByteBuf 要知道自己映射到了 chunk 的哪一段
释放时
  -> Arena / Chunk 要知道该把哪一段 run 或哪一个 subpage bit 还回去
```

如果每次都分配一个小对象，比如：

```text
AllocResult {
    runOffset,
    runPages,
    isSubpage,
    bitmapIdx
}
```

在高频分配/释放场景里，很快又会把本该节省的内存压力变成新的对象分配压力。

所以 `PoolChunk` 选择的不是“多几个小对象换可读性”，而是：

```text
把定位元数据压进一个 long handle
这个 handle 沿着 Arena -> PooledByteBuf -> free 路径一直传递
```

### 2. 当前 handle 的位布局是什么

`PoolChunk` 注释已经写明了 handle 的位布局，见 `PoolChunk.java:76-87`：

```text
oooooooo ooooooos ssssssss ssssssue bbbbbbbb bbbbbbbb bbbbbbbb bbbbbbbb
```

对应含义是：

- `o`：runOffset，run 在 chunk 中的页偏移
- `s`：size，run 占多少页
- `u`：isUsed
- `e`：isSubpage
- `b`：bitmapIdx，只有 subpage 分配时才有意义

相关 shift 常量在 `PoolChunk.java:147-150`。

对普通 run handle，`toRunHandle` 只写入三部分：`runOffset`、`runPages` 和 `inUsed`，见 `PoolChunk.java:600-604`。如果后面这段 run 被拿来做 subpage，小块分配的 `PoolSubpage.toHandle(bitmapIdx)` 再额外把 `isSubpage` 和位图索引写进去，见 `PoolSubpage.java:208-214`。

所以 handle 的真正角色不是“一个编号”，而是：

```text
这是 ByteBuf 在 chunk 里的定位票据
也是之后 free 时找回这段空间的回程票
```

### 3. 为什么要把 `isSubpage` 单独编码出来

small 路径和 normal 路径的释放逻辑根本不同。

- normal：直接把这段 run 作为页级块还回去。
- small：先回到 `PoolSubpage` 位图，看看是不是还有别的元素在用这段 run；只有整段 subpage 真空了，才继续回到 run 级释放。

所以 `free(handle, ...)` 在第一步就要知道：

```text
这是 run 还是 subpage element？
```

当前实现正是靠 `isSubpage(handle)` 来分流，见 `PoolChunk.java:500-521`。这说明 `isSubpage` 不是为了让编码更完整，而是 free 路径必须在第一跳就做出分支。

### 4. handle 不是给人看的，而是给后续路径快速解码的

写成 long 的好处，不是“人读起来舒服”，而是它足够便宜：

- 分配时返回一个原生值。
- `PooledByteBuf.init(...)` 直接接收这个值，见 `PoolChunk.java:606-628`。
- 释放时再把它带回来，按位解码就能知道 offset / pages / bitmapIdx。

这让 Chunk 的元数据沿链路传递时不必再分配新对象。也正因为如此，理解内存池的关键之一，不是“每个类干了什么”，而是“这个 handle 在后面还能做什么”。

## 二、当前 `PoolChunk` 怎么记录“哪些 run 还空着”

### 1. 不是一棵树，而是两个互补结构

`PoolChunk` 用两套结构管理可用 run：

- `runsAvailMap`：按 run 的首尾页偏移查 handle。
- `runsAvail`：按“可容纳多少页”的等级，保存一组优先队列。

见 `PoolChunk.java:161-168`。

这两者的分工很清楚：

```text
我要按偏移找邻居
  -> runsAvailMap

我要找“至少够大的一块 run”
  -> runsAvail[pageIdx...]
```

如果只有 map，没有按大小分组的队列，分配时就要在所有空 run 里慢慢扫；如果只有队列，没有按偏移查找的 map，释放时就很难快速找前后相邻 run 做合并。

所以当前实现不是靠一棵大结构包打天下，而是靠“按大小找候选”和“按偏移找邻居”两套索引互补配合。

### 2. 初始化时整块 chunk 先被当成一段完整可用 run

构造 `PoolChunk` 时，`freeBytes` 初始等于 `chunkSize`；随后会把整块 chunk 作为一个完整可用 run 插入可用结构，见 `PoolChunk.java:198-220`。

也就是说，池化 chunk 的初始状态可以先理解成：

```text
一整块 chunk
  -> 现在全是 free run
  -> runOffset = 0
  -> runPages = chunkSize / pageSize
```

之后每次 normal 分配，本质上都在这套可用 run 结构上“挖掉一段”；每次释放，再把对应 run 放回去并尝试和邻居合并。

### 3. `insertAvailRun` 为什么要同时登记首尾页

`insertAvailRun(runOffset, pages, handle)` 先按页数等级把 handle 加入某个 `runsAvail[pageIdxFloor]` 的优先队列，再把 run 的第一页和最后一页都登记进 `runsAvailMap`，见 `PoolChunk.java:253-287`。

这一步很容易被忽略，但它直接服务于后面的合并逻辑：

```text
已知某段 run 的前一个页偏移 / 后一个页偏移
  -> 我需要快速知道，那里是不是正好有一段连续空 run 的边界
```

如果不同时记录首尾页，`collapsePast/collapseNext` 就没法通过相邻偏移常数级定位到可合并的 run handle。

所以 `runsAvailMap` 存的不只是“某个 offset 对应哪个 run”，而是“每段可用 run 的两端边界”。

## 三、normal 路径：先找一段够大的 run，再把尾巴塞回去

### 1. `allocateRun` 先把请求换成页数和页等级

`allocateRun(runSize)` 先计算本次需要多少页，再把页数映射成 pageIdx，见 `PoolChunk.java:370-399`。

这一步其实延续的是上一节 `SizeClasses` 的思路：请求在 Arena 里已经先归一成了某个 normalized size；现在进入 chunk 以后，又进一步被翻译成“需要几页”和“应该从哪个 runsAvail 队列等级开始找”。

所以 normal 分配的第一跳不是找字节，而是找页级 run。

### 2. `runFirstBestFit` 的“best fit”是什么意思

`runFirstBestFit(pageIdx)` 会从对应页数等级开始，往更大的等级方向找第一个非空优先队列；如果整个 chunk 一开始全空，则直接落在最大的页等级，见 `PoolChunk.java:426-437`。

注意，这里的 “best fit” 不是全局扫描所有可用 run 然后找绝对最优，而是：

```text
先找到能够容纳这次页数请求的最小页等级桶
桶里再取 offset 最小的那段 run
```

它因此是一种“分级近似 best fit”策略：按大小先筛一层，再按偏移取头部候选。

### 3. `splitLargeRun` 不是对半分，而是“前段给你，尾段回填”

这也是最容易沿用旧 Buddy 叙事写错的地方。

当前 `splitLargeRun(handle, needPages)` 不是把一个 run 不断二分，而是：

- 计算这段 run 总页数 `totalPages`
- 计算剩余页数 `remPages = totalPages - needPages`
- 如果还有剩余，就把尾部剩余段重新构造成一个 avail run 插回去
- 返回前半段已用 run 的 handle

见 `PoolChunk.java:439-462`。

可以把它压成：

```text
我需要 4 页
你有 10 页空 run
  -> 前 4 页给我
  -> 后 6 页作为新的 free run 重新挂回 avail 结构
```

这不是“对半拆”，而是“按请求长度切出前段，余量回填尾段”。如果正文沿用“Buddy 树逐层对半拆”的旧地图，读者在这里一定会迷路。

### 4. 分配成功后，`freeBytes` 直接减少本次 pinned 大小

`allocateRun` 成功返回前，会根据 handle 计算 pinned size，并从 `freeBytes` 中扣掉，见 `PoolChunk.java:393-395`。

这说明 Chunk 的“空闲容量”不是 lazy 估算，而是随每次 run 分配/释放立即更新的。后面 `usage()` 也正是基于 `freeBytes` 估算使用率，见 `PoolChunk.java:297-323`。

所以 current chunk 是否值得继续留在哪个 ChunkList，不只是链表位置问题，也依赖这个实时空闲量。

## 四、small 路径：不是直接分 bit，而是先借一段 run 再切 subpage

### 1. `calculateRunSize` 先找能整除 elemSize 的最小 run

small 分配并不是拿到一个 sizeIdx 后直接进入位图。当前 `calculateRunSize(sizeIdx)` 会先找一个合适的 runSize：

- runSize 必须是 pageSize 的倍数
- 同时又要尽量让 `elemSize` 能比较整齐地切进去
- 还要受 chunkSize 和最大元素数约束

见 `PoolChunk.java:401-423`。

所以 small 的真实逻辑是：

```text
我先决定要向 chunk 借多大一段连续 run
然后再把这段 run 切成更小的 elem
```

这比“每个 small 请求都固定占一页”更灵活，也解释了为什么 `PoolSubpage` 不是 Arena 的直接入口，而是 Chunk 里一层更细的二级分配器。

### 2. `allocateSubpage` 先借 run，再创建/初始化 PoolSubpage

`allocateSubpage(sizeIdx, head)` 的流程是：

1. 算出合适的 runSize
2. 调 `allocateRun(runSize)` 向 chunk 借这一整段 run
3. 根据 runOffset 和 elemSize 创建 `PoolSubpage`
4. 把 subpage 放进 `subpages[runOffset]`
5. 调 `subpage.allocate()` 真正拿到 bitmapIdx

见 `PoolChunk.java:473-490`。

这条路径非常值得停一下，因为它把 small 和 normal 的关系讲透了：

```text
small 不是完全独立于 run 管理之外的另一套系统
它是先借 run，再在 run 内做更细粒度切分
```

也就是说，small 路径只是比 normal 多了一层页内位图，并没有绕开 chunk 级 run 分配本身。

### 3. subpage handle 为什么要额外带 `bitmapIdx`

`PoolSubpage.allocate()` 最终会返回 `toHandle(bitmapIdx)`，它在 run handle 的基础上再写入 `isSubpage` 和 `bitmapIdx`，见 `PoolSubpage.java:90-112`、`:208-214`。

这让后续释放时可以先回到这段 subpage，再通过位图定位具体是哪一个小元素被归还，而不必只知道“这页里曾经有人分配过某个小块”。

所以 handle 再次发挥了跨层票据作用：Arena 不必关心细节，PooledByteBuf 只管把 handle 带着走，Chunk/Subpage 在 free 时再把它拆开。

## 五、free：不是简单把 used 标回 free，而是尽可能把连续 run 并大

### 1. subpage 释放先问“这页里是不是还有别的小块在用”

`PoolChunk.free(handle, normCapacity, nioBuffer)` 的第一步是看 handle 是否为 subpage。若是，就找到 `subpages[runOffset]` 对应的 `PoolSubpage`，先在它上面执行 `free(bitmapIdx)`。如果 subpage 释放后仍然还有别的小块在用，就直接 return，不继续回到 run 级别，见 `PoolChunk.java:500-521`。

这点非常重要：

```text
一个 small 元素释放
  != 整段 run 立刻可归还
```

只有当整段 subpage 真正空了，Chunk 才会把它重新视作可供 run 管理的连续空间。

### 2. 真正回到 run 级 free 后，会先合并再重新插回 avail 结构

一旦进入 run 级 free，当前实现会：

1. `collapseRuns(handle)` 尝试和前后连续空 run 合并
2. 清掉 `isUsed` 和 `isSubpage` 位
3. 把最终合并出来的 run 重新 `insertAvailRun(...)`
4. 增加 `freeBytes`

见 `PoolChunk.java:523-545`。

这说明 free 的核心不是“把这段空间标回 free 就完事”，而是：

```text
如果能并成更大的连续 run
就尽量并回去
让后续大请求仍有命中机会
```

### 3. 当前实现的合并不是树兄弟回溯，而是查前后邻居

`collapseRuns` 实际上由 `collapsePast` 和 `collapseNext` 两段组成，见 `PoolChunk.java:548-598`。

- `collapsePast` 通过 `runOffset - 1` 查前一个相邻边界，看前面是否紧挨着一段空 run。
- `collapseNext` 通过 `runOffset + runPages` 查后一个相邻边界，看后面是否紧挨着一段空 run。

如果相邻 run 连续，就把邻居从 avail 结构里删掉，合成一段更大的 run，再继续向更外层合并。

这就是当前实现和旧 memoryMap 树叙事最大的不同：

```text
不是沿树向上找兄弟
而是沿线性地址空间查前后连续邻居
```

所以如果要保留“Buddy”的比喻，也只能说它体现的是“释放后尽量并回大块”的精神，而不是当前源码真的沿一棵树回溯兄弟节点。

## 六、最容易错的五个判断

### 1. 当前 `PoolChunk` 还是老的 `memoryMap[]` 树实现

不成立。当前源码围绕 `runsAvailMap`、`runsAvail`、`allocateRun`、`allocateSubpage` 和 `collapseRuns` 组织，不是旧版树深数组。

### 2. handle 只是一个编号，真正信息都在别处

不成立。handle 本身就编码了 runOffset、runPages、isUsed、isSubpage 和 bitmapIdx，是跨 Arena/Chunk/Subpage/Buf 传递的定位票据。

### 3. `splitLargeRun` 的意思是把大块一层层对半拆

不成立。当前实现是按请求页数切出前段，把尾段余量作为新的 free run 回填。

### 4. small 分配完全绕开 run 管理

不成立。small 先通过 `allocateRun(runSize)` 向 chunk 借一段 run，再在 run 内进入 subpage 位图分配。

### 5. free 只是把当前 run 标记为空闲

不成立。当前实现会优先和前后连续空 run 合并，再把更大的 run 插回 avail 结构。

## 收网：Chunk 的核心，不是“树”，而是“票据 + 可用表 + 连续合并”

现在可以回到上一节留下的问题：Arena 决定了请求该走 normal 或 small，接下来 Chunk 到底做了什么？

当前实现的答案不是“在树里找一个节点”，而是更具体的三步：

```text
第一步：用 handle 表达这段分配的定位信息
第二步：用 runsAvailMap + runsAvail 记录当前还空着的连续 run
第三步：分配时切前段、回填尾段；释放时查前后连续邻居，再并回大块
```

对于 small 路径，还会再多一层：

```text
先借 run
再在 run 内用 PoolSubpage 位图切小块
```

所以 Ch8-02 最该带走的结论不是“Netty 也有个 Buddy”，虽然高层上可以这么理解；真正该记住的是：

```text
当前 PoolChunk 把 chunk 内空间管理拆成了
- 一个压缩 handle
- 一套按大小找候选、按偏移找邻居的可用结构
- 一条按连续地址合并回大块的释放路径
```

下一篇进入 `PoolSubpage` 与 `PoolThreadCache`。因为到这里为止，我们已经知道一段 run 怎么被借出来了；接下来要回答的是，小块位图怎么在页内找第一个空位，以及为什么 90% 的分配还会先尝试绕过 Arena 锁，直接命中线程本地缓存。