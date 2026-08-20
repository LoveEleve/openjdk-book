# 02. Chunk 与 Metablock：Metaspace 为什么既不能直接 malloc，也不能只会 bump

> 前置阅读：[01-Metaspace 全景：类元数据为什么搬出堆，还依然离不开 GC](01-metaspace-overview.md)
> 相关篇章：[03-Arena、ResourceArea 与 AllocateHeap：HotSpot 怎么把 C++ 临时对象的生命周期收拢到作用域里](../09-memory-core/03-arena-resourcearea-allocation.md)、[01-ClassFileParser：为什么 parser 要先接管半成品元数据](../07-classfile-classloader/01-classfile-parser.md)
> 版本边界：`OpenJDK 11u / HotSpot / Linux / x86_64`

## 这篇真正要回答的问题

上一篇把 metaspace 的大图铺开之后，还留下了一个更贴近执行面的难题：`InstanceKlass`、`Method`、`ConstantPool` 这些元数据，很多只有几百字节到几 KB。对 HotSpot 来说，这意味着两件互相打架的要求同时成立。

一方面，分配必须足够快。类加载、方法解析、运行时生成类都不希望每造一个 metadata 对象就下一次系统分配。另一方面，元数据的寿命又不像 Arena 里的临时对象那样整齐。它们虽然大方向上跟着 `ClassLoaderData` 一起生灭，但在一个 loader 活着的漫长过程中，chunk 内部仍然会出现可复用的小空洞。如果只会一路 bump 往前冲，这些空洞就会越积越多。

所以这篇要回答的，不是“metaspace 里有哪些类”，而是更尖锐的一句：**几百字节的 metadata 为什么不能直接 `malloc`，又为什么不能满足于只靠 chunk 内的 bump-pointer 分配？**

全文要收拢的结论是：**Metaspace 的执行面被故意拆成了两层。`Metachunk` 负责把日常分配做得像 Arena/TLAB 一样快；`Metablock` 与 `BlockFreelist` 负责把 chunk 内部已经腾出来的碎块再吃一轮。Chunk 的生死跟着 class loader，Metablock 的复用只发生在同一个 `SpaceManager` 仓内。**

## 如果每个 metadata 都直接 malloc，会先坏在哪里

先看最朴素的方案：每个 `Klass`、每个 `Method`、每个常量池条目都直接 `malloc/free`。这个方案的问题，不只是“系统调用慢”这么简单。

首先，metadata 的量级本来就不大，却出现得很密。一个类加载进来，不是只要一块大对象，而是一串互相关联的小对象。如果都改成 direct malloc，你会不断为几百字节、几 KB 的对象单独付一次分配路径、一次块头开销、一次记账成本。其次，这会把 metaspace 想维持的“按 class loader 分仓”边界打散。上一篇讲过，Metaspace 真正看重的是 ownership：谁的 metadata 属于哪个 `ClassLoaderData`。如果每个对象都是自己独立申请、自己独立释放，那这条边界就会从结构事实退回成人工纪律。

于是很自然会有人往相反方向走：既然 direct malloc 太碎，那就像 Arena 一样，弄一批 chunk，元数据都往当前 chunk 里 bump allocate，不做别的。这能解决快路径，但会引出第二个问题：在一个 `ClassLoaderData` 活着的整个阶段里，chunk 内部并不是从头到尾都只增不减。HotSpot 会有局部回收和复用需求，退休 chunk 也会留下尾料。如果这些空洞永远不复用，就只能靠申请新 chunk 继续往前冲，内部碎片会不断积累。

再往前想一步，似乎也可以在 metadata 一释放时，把它所在 chunk 立刻还给全局 `ChunkManager`。这也不行。原因不是实现麻烦，而是粒度错了。chunk 的设计目标是“跟着 class loader 整仓生灭”；如果为了回收某个几百字节的洞，就把整块 chunk 提前从当前 `SpaceManager` 手里抽走，等于又把 ownership 边界打散了。

所以 Metaspace 最后选择的是第三条路：**快路径仍然靠 chunk 内 bump；但 chunk 内已经腾出来、且还值得保留的洞，不直接归还 chunk，更不直接归还全局，而是降一级变成 `Metablock`，继续留在本 `SpaceManager` 内复用。**

## `Metachunk`：为什么第一层单位必须是 chunk

Metaspace 的第一层单位是 `Metachunk`。这不是随便起的一个名字，而是刻意把“元数据对象”和“承载元数据的一整块仓位”分开。

`Metachunk` 的布局图在 `share/memory/metaspace/metachunk.hpp:42` 就画出来了：`bottom` 到 `end` 是整块 chunk，`_top` 把它切成“已经使用”和“还没使用”两半，见 `share/memory/metaspace/metachunk.hpp:87` 到 `share/memory/metaspace/metachunk.hpp:106`。真正的快路径也非常直接：`Metachunk::allocate()` 只看 `free_word_size() >= word_size`，放得下就返回 `_top`，然后把 `_top` 向前推，见 `share/memory/metaspace/metachunk.cpp:72` 到 `share/memory/metaspace/metachunk.cpp:79`。

这条路径和 Arena、TLAB 很像，都是 bump-pointer 分配。但这里有个必须立刻记住的边界：Arena 面向的是“短命对象按作用域整批丢弃”；Metachunk 面向的是“长寿命 metadata 按 class loader 成仓管理”。算法看起来相似，生命周期语义完全不同。

`Metachunk` 头部本身也不是纯样板。`_chunk_type` 和 `_is_class` 记着这块 chunk 属于哪一类粒度、是否来自 class space，见 `share/memory/metaspace/metachunk.hpp:97` 到 `share/memory/metaspace/metachunk.hpp:100`；`_sentinel` 是调试期用来抓破坏的 “MET” 魔数，见 `share/memory/metaspace/metachunk.hpp:90` 到 `share/memory/metaspace/metachunk.hpp:96`；`_origin` 则记录这块 chunk 是正常出生、padding、leftover、merge 还是 split 的产物，见 `share/memory/metaspace/metachunk.hpp:55` 到 `share/memory/metaspace/metachunk.hpp:69`。这些字段的共同点是：它们都在让 chunk 变成一个“自描述仓位”，而不是一段没有身份的裸内存。

还有一个容易忽略的成本是头部开销。`Metachunk::overhead()` 会把 `sizeof(Metachunk)` 按对象对齐要求向上取整，见 `share/memory/metaspace/metachunk.cpp:47` 到 `share/memory/metaspace/metachunk.cpp:49`。也就是说，chunk 并不是“整块都能拿来放 metadata”；每块先要为自己的头部付一笔固定账。这也是为什么 metaspace 不可能退回到“随便切很多超小 chunk”：块越小，头部摊销越差。

## 四类 chunk 粒度：为什么不是一个万能块大小

既然 chunk 是第一层单位，接下来就会遇到第二个问题：一块到底多大合适？如果所有 chunk 都统一尺寸，小请求会嫌浪费，大请求又嫌不够。OpenJDK 11u 的答案不是“做很多种尺寸，越细越好”，而是先控制在四类。

`metaspaceCommon.hpp` 里把尺寸表写得很清楚：class space 与 non-class space 各自有 specialized、small、medium 三档，而超过 medium 的都统一视为 humongous，见 `share/memory/metaspace/metaspaceCommon.hpp:35` 到 `share/memory/metaspace/metaspaceCommon.hpp:42`。对应的 chunk 类型枚举只有四种：`SpecializedIndex`、`SmallIndex`、`MediumIndex`、`HumongousIndex`，见 `share/memory/metaspace/metaspaceCommon.hpp:92` 到 `share/memory/metaspace/metaspaceCommon.hpp:107`。

这里最该先纠正的误解是“metaspace 有 8 种 chunk 类型”。更准确的说法是：**它有 4 种 chunk 类型，但 class space 与 non-class space 各自对前 3 种类型给出不同尺寸表。** `ClassSpecializedChunk` 和 `SpecializedChunk` 都属于 specialized，只是 class space 用 128 words，non-class 这边也恰好是 128；small 和 medium 在 class/non-class 两边则分别是 256/512、4K/8K words。

为什么只分到四类，而不是更细？因为这层分级想解决的是执行面的大矛盾：小 metadata 不要为大块付太多内部碎片，大 metadata 也别为了满足一次请求去拼太多小块。分得太细，chunk 管理、切分、回收规则会变得更重；分得太粗，内部浪费又会迅速上来。四类是 HotSpot 在复杂度和碎片之间选的一个折中。

所以从理解上，chunk 尺寸分层不是为了“把元数据排版得更整齐”，而是在控制两种成本：内部碎片，以及 chunk 管理本身的复杂度。

## `ChunkManager`：当前 chunk 用完之后，为什么先问全局 free chunks

日常分配大部分时候都停留在当前 `Metachunk` 的 bump 路径上。但一旦当前 chunk 放不下，`SpaceManager` 就会进入 `get_new_chunk()`，见 `share/memory/metaspace/spaceManager.hpp:176` 与 `share/memory/metaspace/spaceManager.cpp:383`。这一步最值得注意的，不是“它会申请新 chunk”，而是“它先去哪儿问”。

`SpaceManager::get_new_chunk()` 的第一站不是 `VirtualSpaceList`，而是 `chunk_manager()->chunk_freelist_allocate(chunk_word_size)`，见 `share/memory/metaspace/spaceManager.cpp:383` 到 `share/memory/metaspace/spaceManager.cpp:389`。只有全局空闲 chunk 池里拿不到，才往下沉到 `vs_list()->get_new_chunk(...)`。这个顺序非常关键，因为它说明 metaspace 不是“当前 chunk 不够 -> 立刻 commit/reserve 新空间”，而是“先复用已经归还的标准块，再考虑向 OS 追加承诺”。

`ChunkManager` 的内部结构也很清楚：三个非 humongous 的 `ChunkList`，外加一个管理 humongous chunk 的 `ChunkTreeDictionary`，见 `share/memory/metaspace/chunkManager.hpp:47` 到 `share/memory/metaspace/chunkManager.hpp:67`。也就是说，小中规格块走按类型分层的链表，大块走按尺寸查找的树结构。它们都是“全局 free chunks”，但访问方式不同。

更有意思的是 `free_chunks_get()` 里的失败补救逻辑。假如你想要一个 small chunk，可 freelist 里正好没有 small，但有更大的 medium，那么 `ChunkManager` 不会直接放弃，而是向更大块借一整块，再在 `split_chunk()` 里把它拆出至少一个目标尺寸块，见 `share/memory/metaspace/chunkManager.cpp:433` 到 `share/memory/metaspace/chunkManager.cpp:489`。拆出来的这些新块会被重新标成 `origin_split`，见 `share/memory/metaspace/chunkManager.cpp:368` 到 `share/memory/metaspace/chunkManager.cpp:410`。这一步说明 `ChunkManager` 不只是“存储空闲块的仓库”，它还是 chunk 规格重整的执行者。

这里同样有一个边界必须记清：`ChunkManager` 管的是 chunk 级别的复用与切分，而不是 chunk 内小空洞的复用。后者是下一层 `Metablock` 的职责。

## `Metablock`：为什么 chunk 内部的洞不能直接丢掉

如果说 `Metachunk` 解决的是“当前请求怎样快速落地”，那么 `Metablock` 解决的就是“已经腾出来但还没必要把整块 chunk 交出去的那些洞怎么办”。

`metablock.hpp` 的注释把它的定位说得非常清楚：`Metablock` 是 chunk 内部分配的单位；它可以被同一个 `SpaceManager` 复用，但永远不会在不同 `SpaceManager` 之间搬家；它也没有指回所属 `Metachunk` 的显式链接；真正的 chunk 回收发生在关联的 class loader 被回收时，见 `share/memory/metaspace/metablock.hpp:33` 到 `share/memory/metaspace/metablock.hpp:40`。

这几句话背后其实在回答一个很容易问错的问题：既然 metadata 有些会被“释放”，为什么不顺手把它所在 chunk 一起还掉？答案就是粒度不对。被释放的是 chunk 里的一块局部空间，而 chunk 自己仍然属于当前 `ClassLoaderData` 那一整仓元数据。HotSpot 不想因为局部出现了洞，就打破 chunk 级别的 ownership。

`SpaceManager::deallocate()` 的实现也证明了这一点。它不会去调用 `ChunkManager` 把整块 chunk 交还出去，而是先把这次释放的区间转成 `raw_word_size`，再丢进当前 manager 的 `BlockFreelist`，见 `share/memory/metaspace/spaceManager.cpp:322` 到 `share/memory/metaspace/spaceManager.cpp:331`。也就是说，**Metablock 的复用范围被故意限制在“同一个 `SpaceManager`、同一个 class loader 仓内”。**

这层限制非常重要，因为它让 metaspace 同时保住了两件事：chunk 的大生命周期边界依然跟着 class loader；chunk 内部的小碎片又不会白白烂掉。

## `BlockFreelist` 与 `SmallBlocks`：为什么复用途径还要再分两层

接下来就轮到 metaspace 的第二条执行路径：仓内复用。

`BlockFreelist` 同时持有两套结构：一个 `BlockTreeDictionary`，一个懒初始化的 `SmallBlocks`，见 `share/memory/metaspace/blockFreelist.hpp:37` 到 `share/memory/metaspace/blockFreelist.hpp:57`。这不是为了代码漂亮，而是因为“小空洞”和“大空洞”适合不同的数据结构。

`return_block()` 先把原地内存安上一个 `Metablock` 头，然后按大小分流：如果 `word_size < SmallBlocks::small_block_max_size()`，就丢进 `SmallBlocks`；否则进字典树，见 `share/memory/metaspace/blockFreelist.cpp:45` 到 `share/memory/metaspace/blockFreelist.cpp:55`。`SmallBlocks` 的实现是按 exact size 分桶的 `FreeList<Metablock>` 数组，桶下标就是 `word_size - _small_block_min_size`，见 `share/memory/metaspace/smallBlocks.hpp:39` 到 `share/memory/metaspace/smallBlocks.hpp:48`。这意味着对小块来说，查找成本基本就是“按大小算数组下标，再从链表头拿一个”。

大块就不适合这么做了。尺寸分布更散，用树结构更划算，于是 `BlockFreelist` 让它们走 `BinaryTreeDictionary`。`get_block()` 也体现了这两层顺序：先试 `SmallBlocks` 的精确尺寸桶；命不中再看字典树，见 `share/memory/metaspace/blockFreelist.cpp:58` 到 `share/memory/metaspace/blockFreelist.cpp:80`。

这一步里还有一个很值得写出来的策略细节：`WasteMultiplier = 4`，见 `share/memory/metaspace/blockFreelist.hpp:46` 到 `share/memory/metaspace/blockFreelist.hpp:48`。如果从字典树里找到的空闲块太大，大到 `block_size > 4 * word_size`，HotSpot 宁可把它原样放回 freelist，也不为了一个小请求把这块大空洞切得太碎，见 `share/memory/metaspace/blockFreelist.cpp:83` 到 `share/memory/metaspace/blockFreelist.cpp:87`。只有大小还算接近时，才会真的切出请求块，并把尾部剩余空间重新 `return_block()` 回去，见 `share/memory/metaspace/blockFreelist.cpp:89` 到 `share/memory/metaspace/blockFreelist.cpp:94`。

这个策略说明 metaspace 在仓内复用时也不是“只要能拿到就行”，而是在刻意控制二次碎片。如果一块大空洞过于肥硕，就先别为一个小对象把它切碎；等后面遇到更接近的大请求再用它，整体会更划算。

这里也顺手纠正一个现稿最容易让读者记错的点：`SmallBlocks` 并不是什么“三档分类器”，而是 **exact-size buckets**；大块也不是“单独一档 freelist”，而是字典树。真正的分界线，是“够不够小，适不适合按精确尺寸数组分桶”，不是业务上拍脑袋切出来的三段论。

## 把整条执行链收回来：快路径、慢路径、复用途径各管什么

到这里，metaspace 的执行面其实已经能收成一条很清楚的链。

当一个 metadata 分配请求到来时，`SpaceManager::allocate()` 先看本地 `BlockFreelist`，因为如果已经有同尺寸或近似尺寸的空洞，直接复用最省；空洞路径吃不下，再进入 `allocate_work()`，先试当前 `Metachunk` 的 bump allocate；当前 chunk 满了，再向全局 `ChunkManager` 借标准块；连全局 free chunks 都没有，才继续下沉到 `VirtualSpaceList`，去 commit 当前虚拟空间，必要时再 reserve 新 node。

换句话说，真正的层次不是“chunk + block”这么简单，而是三层协作：**本 manager 内的空洞复用，当前 chunk 内的快路径分配，全局 chunk 与虚拟空间层面的后备扩张。** 这三层里，只有最底层才会碰到 reserve/commit；大多数请求根本走不到那儿。

和 Arena/TLAB 做个有限对照，也能帮助记忆：它们的快路径算法确实很像，都是 bump-pointer；差别在于生命周期。TLAB 面向堆对象、最终交给 GC；Arena 面向作用域内临时对象、按 mark 或 region 一次回收；Metaspace 面向 class-loader-owned metadata，所以既要保留 chunk 级别的仓储边界，又要在仓内多做一层碎片复用。

## 最后把常见误解一次说清

Metaspace 里的 metadata 不适合 direct malloc/free，因为那会把所有权边界打散，并为大量小对象反复支付分配成本。Metaspace 也不是只会 chunk bump allocate；如果这样做，chunk 内部碎片会在长寿命 loader 的运行期不断积累。metadata 一释放，也不会顺手把所在 chunk 立刻交还全局；那会破坏“chunk 跟着 class loader 整仓生灭”的边界。`Metablock` 本身并不知道自己来自哪个 chunk，见 `share/memory/metaspace/metablock.hpp:35` 到 `share/memory/metaspace/metablock.hpp:40`；它只承担“这是一块可在本 manager 内复用的空洞”这一层语义。`SmallBlocks` 也不是三档分类器，而是按精确 word size 分桶的数组，见 `share/memory/metaspace/smallBlocks.hpp:44` 到 `share/memory/metaspace/smallBlocks.hpp:48`。Humongous chunk 也不走普通 freelist，而是单独走字典树，见 `share/memory/metaspace/chunkManager.hpp:62` 到 `share/memory/metaspace/chunkManager.hpp:67`。

把这些误解剥掉之后，这一篇最该留下的一句话就是：**Chunk 负责守住 class loader 级别的生命周期边界，Metablock 负责把这座仓库内部已经出现的碎片再榨一轮。Metaspace 既不退回到 direct malloc，也不满足于只会向前 bump；它是在两种粒度上分别处理“快”和“省”。**

> → [10-metaspace/03 — VirtualSpace 与归还](03-virtualspace-arena-reclaim.md)
