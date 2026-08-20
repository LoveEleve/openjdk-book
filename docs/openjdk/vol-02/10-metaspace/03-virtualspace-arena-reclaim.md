# 03. VirtualSpaceNode 与归还链：Metaspace 为什么不在 node 用完时立刻 unmap

> 前置阅读：[02-Chunk 与 Metablock：Metaspace 为什么既不能直接 malloc，也不能只会 bump](02-chunk-metablock-allocation.md)
> 相关篇章：[02-VirtualSpace：为什么 HotSpot 总把“占坑”和“付款”分开](../09-memory-core/02-virtualspace.md)、[01-Metaspace 全景：类元数据为什么搬出堆，还依然离不开 GC](01-metaspace-overview.md)、[05-ClassLoader 层次：委派、bootstrap bridge 与 CLD 生命周期](../07-classfile-classloader/05-classloader-hierarchy.md)
> 版本边界：`OpenJDK 11u / HotSpot / Linux / x86_64`

## 这篇真正要回答的问题

前两篇已经把 metaspace 的“谁拥有元数据”和“chunk 内怎么分配”讲清楚了，但还剩最后一段最容易被讲扁的链路：当前 chunk 和 `ChunkManager` 都吃不到合适块时，metaspace 到底怎么从虚拟内存层继续要空间；而当某个 node 看起来已经没用了，它为什么又不立刻 `munmap` 还给 OS？

如果只记一句“metaspace 在 native memory 里，用完就还给系统”，这条链几乎一定会被讲错。真正困难的地方在于，这里同时有三种不同粒度的事缠在一起：node 里剩余 committed 空间的再切分、全局 freelist 上 chunk 的去留、以及 OS 视角的虚拟地址释放。HotSpot 没把这三件事糊成一个 `free()`，而是故意拆成了多步。

所以这篇要回答的核心问题是：**当前 metaspace node 不够用了，为什么不能只会“再 mmap 一块”；而当一个 node 看起来空了，为什么又不能立刻 `unmap`？`retire`、`purge` 和最终的 `release` 各自在解决什么约束？**

全文要收拢的结论是：**Metaspace 的归还链故意分成三层粒度。node 内剩余 committed 空间先在现场被 `retire` 切成标准 chunk 回到 `ChunkManager`，这是“把空间先还给 metaspace 自己”；只有等到 safepoint，`VirtualSpaceList::purge` 才确认这个 node 现在是不是一个 chunk 都不背了，并把它从链表摘掉；最后 node 析构时 `ReservedSpace::release` 才真正把虚拟地址还给 OS。**

## 如果 node 不够用就直接新建、空了就直接 unmap，为什么会出错

先把最直觉的两个方案摆出来。

第一种方案，是当前 node 不够用了，就直接新建一个 node。这样看起来最省脑子：老 node 不再管，新 node 继续切 chunk。但这个方案会白白浪费当前 node 里已经 commit 好、却还没切成 chunk 的剩余空间。对 metaspace 来说，这些空间已经付过“付款”成本，如果不先把它们变成标准 chunk 回收进 `ChunkManager`，等于把已经 commit 的页直接烂在现场。

第二种方案，是只要一个 node 看起来空了，就立刻 `munmap`。这个方案的问题在于，node 的“空”并不只是看 `top()` 或“当前有没有正在分配”。一个 node 里切出来的 free chunk 可能已经回到全局 `ChunkManager` freelist；从 node 自己视角看，这些 chunk 不再属于某个 `SpaceManager`，但从 metaspace 整体视角看，它们仍然活着、仍然能被复用。如果这时直接 `munmap`，你就会把 freelist 上还在挂着的 chunk 脚下地板抽掉。

第三种常见误解，是既然 class unloading 只会在 safepoint 里发生，那干脆把所有清理动作都拖到 safepoint 再一把梭。问题在于，node 用尽时现场就已经知道“哪些 committed 空间还没切分完”；如果不先现场消化掉，后面 safepoint 阶段就会背着一批本可立即复用的剩余空间，既拖慢后续分配，也把问题从“块管理”硬拖成“全局清场”。

所以 metaspace 的答案不是两个极端中的任意一个，而是把动作拆开：**现场先把剩余 committed 空间转成标准 chunk；safepoint 再判断 node 是否真的空了；最后才做 OS 级别的 release。**

## `VirtualSpaceNode`：它不是抽象概念，而是一块具体保留区的 owner

理解这条链，先要抓住 `VirtualSpaceNode` 是什么。`VirtualSpaceNode` 的字段定义在 `share/memory/metaspace/virtualSpaceNode.hpp:42` 开始：它内部有 `_rs` 表示 `ReservedSpace`，有 `_virtual_space` 表示当前已 commit 的 `VirtualSpace`，有 `_top` 表示下一个可切 chunk 的位置，还有 `_container_count` 记录这个 node 里现在还背着多少个 chunk，见 `share/memory/metaspace/virtualSpaceNode.hpp:48` 到 `share/memory/metaspace/virtualSpaceNode.hpp:58`。

这四样合在一起，已经足够说明它的角色：**一个 `VirtualSpaceNode` 就是 metaspace 世界里某一块具体 reserve 下来的虚拟地址区域的现场管家。** `_rs` 关心整段地址的保留与最终释放；`_virtual_space` 关心其中哪些页已经 commit；`_top` 关心当前 node 还能从已提交区域切出多少空间；`_container_count` 关心这个 node 身上现在还挂着多少 chunk 实体。

`initialize()` 也把这个 owner 身份写得很明确。它先要求 `_rs.base()` 与 `_rs.size()` 都对齐到 `Metaspace::commit_alignment()`，见 `share/memory/metaspace/virtualSpaceNode.cpp:506` 到 `share/memory/metaspace/virtualSpaceNode.cpp:510`；如果是 special reserved space，还会把整段都视为预提交，见 `share/memory/metaspace/virtualSpaceNode.cpp:512` 到 `share/memory/metaspace/virtualSpaceNode.cpp:518`；成功后把 `_top` 设到 `virtual_space()->low()`，并建立一张以最小 chunk 粒度为单位的 occupancy map，见 `share/memory/metaspace/virtualSpaceNode.cpp:523` 到 `share/memory/metaspace/virtualSpaceNode.cpp:528`。

所以这篇后面反复出现的“node”不是逻辑壳子，而是一块有边界、有保留区、有提交区、有 chunk 占用图的真实内存实体。

## 为什么扩张时先试 commit 当前 node，而不是立刻新建 node

真正的扩张路径发生在 `VirtualSpaceList::expand_by()`。这一层先问两个问题：允许不允许继续扩、还能不能在阈值和上限下继续扩，见 `share/memory/metaspace/virtualSpaceList.cpp:274` 到 `share/memory/metaspace/virtualSpaceList.cpp:285`。这一步把 metaspace 的增长节奏和前一篇讲过的 GC 阈值机制接起来了。

接着它做的第一选择，不是 reserve 新 node，而是先试 `expand_node_by(current_virtual_space(), ...)`，也就是在当前 node 上多 commit 一段页，见 `share/memory/metaspace/virtualSpaceList.cpp:287` 到 `share/memory/metaspace/virtualSpaceList.cpp:296`。再往里走，`VirtualSpaceNode::expand_by()` 会先算当前 node 还剩多少 `uncommitted` 空间；只要这部分空间还够 `min_words`，就把这次 commit 大小取成 `MIN2(preferred_bytes, uncommitted)`，然后调 `virtual_space()->expand_by(commit, false)`，见 `share/memory/metaspace/virtualSpaceNode.cpp:467` 到 `share/memory/metaspace/virtualSpaceNode.cpp:491`。

这条路径说明一个很重要的优先级：**对 metaspace 来说，当前 node 能继续 commit，就优先继续在同一块 reserve 下来的地址区里增长，而不是立刻开新洞。** 这么做的好处很直接：已经 reserve 的地址不用再额外扩展 envelope，局部性也更稳定，后面 `take_from_committed()` 还能直接从这块 freshly committed 空间继续切 chunk。

所以“node 不够用就直接新建一个”这个直觉方案，从源码上就不是 HotSpot 的第一反应。第一反应永远是：先把当前 node 还能承诺的页吃干净。

## `take_from_committed`：为什么切 chunk 之前还要先造 padding chunks

当前 node 一旦 commit 出新页，后面的 chunk 领取并不是简单从 `_top` 直接往前推。`take_from_committed()` 里最值得注意的，是它对齐 chunk 的方式。

不同规格的非 humongous chunk 要按自己的 chunk 大小对齐，见 `share/memory/metaspace/virtualSpaceNode.cpp:370` 到 `share/memory/metaspace/virtualSpaceNode.cpp:376`。如果当前 `top()` 还没走到适合目标 chunk 对齐的位置，HotSpot 不会浪费中间那段空白，而是先调用 `allocate_padding_chunks_until_top_is_at()` 把中间缝隙切成 specialized 或 small padding chunks，再立刻交还给 `ChunkManager`，见 `share/memory/metaspace/virtualSpaceNode.cpp:306` 到 `share/memory/metaspace/virtualSpaceNode.cpp:364` 与 `share/memory/metaspace/virtualSpaceNode.cpp:404` 到 `share/memory/metaspace/virtualSpaceNode.cpp:415`。

这件事的含义很重要：**在 metaspace 里，“对齐浪费”也不被白白扔掉，而是会尽量被转换成可复用的标准 chunk。** 这些 padding chunk 带着 `origin_pad` 出生记录，见 `share/memory/metaspace/virtualSpaceNode.cpp:336` 到 `share/memory/metaspace/virtualSpaceNode.cpp:355`。所以 node 内部的空间并不是“只有成功切出目标 chunk 才算有意义”，连对齐过程中的边角料也会尽量转成 metaspace 自己能再用的块。

这一点为后面的 `retire` 埋了个伏笔：如果连对齐碎片都要回收，那 node 用尽时剩余 committed 空间更不可能直接丢给 OS。

## `retire`：它做的是把现场剩余 committed 空间切碎归还，不是还给 OS

当 `VirtualSpaceList::expand_by()` 发现当前 node 已经没法继续 commit 时，才会走 `retire_current_virtual_space()`，见 `share/memory/metaspace/virtualSpaceList.cpp:298` 到 `share/memory/metaspace/virtualSpaceList.cpp:300`，再落到 `VirtualSpaceNode::retire()`，见 `share/memory/metaspace/virtualSpaceList.cpp:139` 到 `share/memory/metaspace/virtualSpaceList.cpp:147`。

这里最容易讲错的一句话就是“retire 当前 node”。很多人会下意识把 retire 理解成“把这个 node 退役并归还给系统”。源码做的事完全不是这个粒度。

`VirtualSpaceNode::retire()` 会从 `MediumIndex` 一路往下到 `ZeroIndex`，对每一种标准 chunk 尺寸做同样的循环：只要 `free_words_in_vs()` 还够当前尺寸，就调用 `get_chunk_vs(chunk_size)` 从 node 里切出一个标准 chunk，然后立刻 `chunk_manager->return_single_chunk(chunk)` 交回 `ChunkManager`，见 `share/memory/metaspace/virtualSpaceNode.cpp:560` 到 `share/memory/metaspace/virtualSpaceNode.cpp:579`。最后它只断言一件事：`free_words_in_vs() == 0`，见 `share/memory/metaspace/virtualSpaceNode.cpp:582`。

这条链说明 retire 的真实语义是：**把当前 node 里还没切出来、但已经 commit 过的剩余空间，尽量全部翻译成 metaspace 标准 chunk，并交还给全局 chunk 复用体系。** 它做的是 metaspace 内部的再编目，不是 OS 级释放。

换句话说，retire 之后这个 node 当然“不再承担新的 chunk 现场切分工作”，但它里面的内存还在，甚至已经被变成了 freelist 上可复用的 chunk。此时你如果直接 unmap，就是把刚刚交还给 `ChunkManager` 的那些 chunk 一起砍掉。

所以这里必须先记住一个路标：**retire 只完成“把 node 内剩余 committed 空间还给 metaspace 自己”；它还远远没有走到“还给 OS”。**

## `purge`：为什么一定要等 safepoint，而且只清理非 current 的空 node

真正决定“这个 node 现在能不能从链表里摘掉”的，是 `purge`。触发链从 `ClassLoaderDataGraph::purge()` 开始：它必须在 safepoint 执行，先把 `_unloading` 链表上的 `ClassLoaderData` 一个个 `delete` 掉；只要确实有类卸载，就调用 `Metaspace::purge()`，见 `share/classfile/classLoaderData.cpp:1457` 到 `share/classfile/classLoaderData.cpp:1472`。`Metaspace::purge()` 再带着 `MetaspaceExpand_lock` 分别清 class / non-class 两个 space list，见 `share/memory/metaspace.cpp:1478` 到 `share/memory/metaspace.cpp:1488`。

落到 `VirtualSpaceList::purge()` 时，源码有两个特别关键的条件：一是必须在 safepoint，见 `share/memory/metaspace/virtualSpaceList.cpp:74` 到 `share/memory/metaspace/virtualSpaceList.cpp:76`；二是只处理 `container_count() == 0 && vsl != current_virtual_space()` 的 node，见 `share/memory/metaspace/virtualSpaceList.cpp:86` 到 `share/memory/metaspace/virtualSpaceList.cpp:89`。

这两个条件分别在守两种约束。先说 safepoint。`VirtualSpaceList::find_enclosing_space()` 的注释明确说明，平时会有不加锁地遍历 metaspace mmap 区域的路径，而删除 virtual space node 只允许发生在 safepoint，见 `share/memory/metaspace/virtualSpaceList.cpp:121` 到 `share/memory/metaspace/virtualSpaceList.cpp:127`。这意味着 purge 不只是“清点空 node”，它还涉及链表摘除与并发可见性边界，所以必须等到世界停稳。

再说 `container_count()==0`。这个条件并不等于“node 里没有剩余 committed 空间”，而是更具体：这个 node 现在已经不再承载任何 chunk。只有这样，`VirtualSpaceNode::purge()` 才能从 `first_chunk()` 走到 `top()`，把仍挂在 freelist 上的那些 free chunks 一一 `remove_chunk()`，再把它们的 sentinel 拆掉，见 `share/memory/metaspace/virtualSpaceNode.cpp:75` 到 `share/memory/metaspace/virtualSpaceNode.cpp:88`。也就是说，**purge 做的不是切 chunk，而是把“这个 node 身上的 chunk 痕迹”从全局 freelist 体系里彻底抹掉。**

而 `vsl != current_virtual_space()` 则是在守另一个现实约束：当前 node 很可能马上还要继续用，哪怕它此刻恰好空着，也别急着把它从链表里摘掉。HotSpot 宁可保留当前 node，避免刚 purge 完又立刻重新 reserve 一块差不多的空间。

所以 purge 的真实语义是：**在 safepoint 里，确认某个非当前 node 已经一个 chunk 都不背了，再把它从 list 和 freelist 体系里同时摘掉。**

## 真正还给 OS 的动作，为什么必须最后才发生

当 `VirtualSpaceList::purge()` 满足条件后，它会先把 node 从链表里 unlink，再调 `vsl->purge(chunk_manager)` 把残留 free chunks 从 `ChunkManager` 摘掉，更新 reserved/committed 统计，最后才 `delete vsl`，见 `share/memory/metaspace/virtualSpaceList.cpp:92` 到 `share/memory/metaspace/virtualSpaceList.cpp:106`。

这里最后那个 `delete vsl` 才是 OS 级回收真正开始的地方。虽然我们这次没把析构函数片段全文贴出来，但从 `VirtualSpaceNode` 的职责和现稿交接链也能确定：node 析构最终会落到 `_rs.release()`，把整段 `ReservedSpace` 释放给操作系统。也就是说，**前面的 retire 和 purge 都还是 metaspace 内部的账务重整；只有析构 release 才是 OS 视角的地址归还。**

这也是为什么 HotSpot 不把“node 看起来空了”直接等同于“可以 unmap”。在真正 release 之前，至少有两层内部清理必须先完成：剩余 committed 空间得先翻译成可复用 chunk；freelist 上残留的 chunk 得先从全局结构里摘掉。只有这两步都做完，OS 级别的释放才安全。

所以把整条链压成“GC 时把空 node 还给 OS”会漏掉最关键的设计点：HotSpot 先保证 metaspace 自己的复用秩序，最后才考虑系统调用层面的释放。

## 把 chunk 的来源与去向整条收回来

到这里，metaspace 从“要 chunk”到“还地址”的整条链就能完整拼起来了。

来源这一侧，`SpaceManager` 缺 chunk 时先问 `ChunkManager`；全局 free chunks 没有，才落到 `VirtualSpaceList::get_new_chunk()`；当前 node 还有未提交空间，就优先在同一个 node 上 commit 更多页；当前 node 连 commit 都扩不动，才先 retire 当前 node 的剩余 committed 空间，再 reserve 一个新 node 继续服务。

去向这一侧，某个 `ClassLoaderData` 死掉后，它名下 `SpaceManager` 持有的 chunk list 会先经 `ChunkManager::return_chunk_list()` 批量回到全局 freelist，见 `share/memory/metaspace/chunkManager.cpp:623` 到 `share/memory/metaspace/chunkManager.cpp:649`；而 node 现场剩余的 committed 空间，则在 `retire` 时被切成标准 chunk 回流；等到 safepoint 里的 `ClassLoaderDataGraph::purge()` 拉起 `Metaspace::purge()`，那些已经一个 chunk 都不背的非 current node 才被从链表和 freelist 体系里摘除；最后 node 析构，虚拟地址才真正 release 给 OS。

换句话说，metaspace 的“回收”至少要分三层看：**chunk 回到全局 freelist，node 从 metaspace 拓扑里摘掉，地址回到 OS。** 这三层都叫“释放”，但根本不是同一件事。

## 最后把常见误解一次说清

当前 node 不够时，并不会总是直接新建 node；HotSpot 先试在当前 node 上 commit 更多页，见 `share/memory/metaspace/virtualSpaceList.cpp:289`。`retire` 也不等于 release 给 OS；它做的是把 node 内剩余 committed 空间切成标准 chunk 回给 `ChunkManager`，见 `share/memory/metaspace/virtualSpaceNode.cpp:560`。`purge` 也不只是“删链表节点”，它还要把 node 内残留 free chunks 从全局 freelist 结构里摘掉，见 `share/memory/metaspace/virtualSpaceNode.cpp:75`。当前 node 也不会因为一时空着就被 purge，条件明确排除了 `current_virtual_space()`，见 `share/memory/metaspace/virtualSpaceList.cpp:88`。归还给 `ChunkManager` 与归还给 OS 更不是同一件事：前者是 metaspace 内部再利用，后者是虚拟地址层面的最终释放。最后，CLD 卸载后也不会“立刻 unmap 对应 node”；它要先经过 safepoint 里的 `Metaspace::purge()` 这道批量筛选，见 `share/classfile/classLoaderData.cpp:1469` 与 `share/memory/metaspace.cpp:1482`。

把这些误解剥掉之后，这一篇最该留下的一句话就是：**Metaspace 不是在 node 用尽或类卸载时就一把梭把地址还给 OS；它先把 committed 空间尽量转成自己还能复用的 chunk，再在 safepoint 确认哪些 node 真正空了，最后才做系统级释放。复用秩序永远先于 `munmap`。**

> → 域 11 CDS
