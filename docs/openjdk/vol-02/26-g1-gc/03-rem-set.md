# 03. 为什么 G1 pause 不扫全老年代？— RSet + CardTable 的反向索引协议

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`。这里讨论的是 G1 里 remembered set、dirty card queue、并发精炼以及 pause 内 `Update RS / Scan RS` 的接力协议：它们怎样把“谁可能指向我要收的 Region”缩成一个足够小的工作集。SATB 与并发标记本身放在上一篇；分配与晋升放在下一篇。
>
> **前置依赖**：[02 — 应用线程还在改图，G1 为什么还敢并发标记？— 并发标记 + SATB](02-concurrent-marking.md)、[25-gc-framework/05 — CardTable + DirtyCardQueue](../25-gc-framework/05-cardtable-dirtycardq.md)、[01 — 为什么 G1 要把堆切成一张网格？— `HeapRegion` 与 `G1CollectedHeap`](01-heapregion.md)
> → **后续**：[04 — 分配与晋升](04-allocation.md)

上一篇并发标记已经回答了一个关键问题：**这一轮哪些对象活着。**

但 evacuation pause 还差另一半问题：**如果我要回收或搬移 Collection Set 里的 Region，外面谁还指着它们？**

最直觉的办法当然是：暂停时把整个老年代扫一遍，看看所有旧对象里哪些字段指向我要收的年轻区或 mixed CSet。

这当然正确，但几乎等于把每次 Young/Mixed Pause 的成本重新绑回“老年代总大小”。G1 花了这么大力气把堆切成 Region、把并发标记做成快照，最后如果 pause 里还要整块老年代重扫一遍，那前面的粒度化设计就等于在最关键的暂停路径上失效了。

这就逼出本篇最该回答的问题：**并发标记已经知道‘哪些对象活着’，可 evacuation pause 仍然必须知道‘谁指向了我要搬的 Region’。G1 为什么不直接在暂停里扫描整个老年代？为什么要提前把 post-write barrier 变成 dirty card queue，再后台精炼成 remembered set？RSet 到底存的不是‘我引用了谁’，而是‘谁引用了我’这件事，为什么这么关键？**

先把答案压成一句话：**G1 的 remembered set 本质上是一张 per-region 反向索引：我不关心‘这个 Old Region 指向了谁’，我关心‘如果我要收 Region Y，哪些别的 Region 的哪些 card 里可能有指向 Y 的引用’。post-write barrier 只负责把来源 card 标脏并入队；并发精炼线程再把“来源 card → 目标 Region”这层关系慢慢翻译进目标 Region 的 RSet。这样 pause 里就能先 Update RS 清尾，再 Scan RS 只扫可能命中 Collection Set 的卡，而不是整块老年代。**

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：Young/Mixed pause 时直接扫描整个老年代找入边

这是最自然的第一反应。

如果 pause 的目标是搬走一批年轻 Region 或 mixed CSet，那最稳妥的办法似乎就是：把所有可能持有外部引用的 old/humongous Region 全扫一遍，看到指向 CSet 的字段就处理。

这个办法的正确性没什么问题，问题在于它会把 pause 成本重新拖回按老年代体量增长。

因为你真正关心的并不是“老年代里全部对象的全部字段”，而只是“**那些可能跨 Region 指向 CSet 的字段**”。如果每次暂停都从整个 old/humongous 空间重新找这批字段，G1 的暂停时间就会重新和“堆有多大”而不是“这次要收的格子与它们的入边有多少”发生强耦合。

而 G1 之所以要做 Region 网格、并发标记、动态 collection set，本来就是为了把“这次暂停要处理什么”收窄到足够小的工作集。

所以第一种朴素方案失败，不是因为全扫老年代不安全，而是因为**它会把 G1 最关键的暂停时间优势重新抹掉。**

### 朴素方案二：写 barrier 现场直接把完整 RSet 更新好

第二个也很自然的想法是：好，我接受不能在 pause 里全扫老年代。那不如在每次写引用时就立刻把目标 Region 的 remembered set 更新好，这样 pause 里直接读现成结果就行。

这个想法的问题在于，它把 mutator 热路径当成了“后台记账线程”。

写引用的那一刻，应用线程最需要的是：

- 尽快把 card 标脏；
- 尽快把“这里可能出了跨 Region 更新”的线索留下；
- 然后回去继续业务逻辑。

如果在 barrier 现场就要求它：

- 找到来源字段所在 card；
- 扫描 card 上对象边界；
- 解析字段里到底指向哪个 Region；
- 再把这条关系更新进目标 Region 的 remembered set 结构里；

那这条 post-barrier 会立刻从“留下线索”膨胀成“替 GC 做完整索引维护”。这对应用线程来说代价太重，也完全失去了批处理和后台精炼的空间。

所以 G1 的做法正好相反：**mutator 只留下脏卡线索，真正的 RSet 翻译工作尽量后移到并发精炼线程和 pause 内 Update RS。**

这两个失败方案合起来，正好引出本篇主线：**G1 想把 pause 里的扫描范围压小，就必须提前把“谁可能指向我”这件事做成一张反向索引，但这张索引又不能在 mutator 热路径上完整维护。**

## `HeapRegionRemSet`：为什么 owner Region 存的是“谁引用了我”

先从 remembered set 的本体开始。

### `_rem_set` 挂在 `HeapRegion` 上，但语义不是“我引用了谁”

`HeapRegion` 里有一个 `_rem_set` 字段。真正的类型是 `HeapRegionRemSet`。`src/hotspot/share/gc/g1/heapRegionRemSet.hpp:170`

它内部最重要的两块是：

- `_code_roots`：代码根（例如 nmethod）里指向这个 Region 的引用；
- `_other_regions`：普通堆 Region 对这个 owner Region 的外部引用。`src/hotspot/share/gc/g1/heapRegionRemSet.hpp:170`

这里最需要读者记住的一句话是：**这张表的 owner 是“被指向的 Region”，表里记的是“谁从外面指向了我”。**

也就是说，它不是传统正向关系表：“我这个 Region 出去指向了谁”；它恰恰反过来，是：“如果我要回收我自己，外面有哪些来源 Region/代码根 可能要来找我”。

这一步是整篇最重要的方向感。如果这件事方向看反，后面 coarse/fine/sparse、dirty card、refine、scan RS 全都会越看越乱。

### `add_reference(from)` 为什么传的是来源字段地址

`HeapRegionRemSet::add_reference(OopOrNarrowOopStar from, uint tid)` 看起来很小，但语义极重。它拿到的不是 target 对象，不是 owner Region，也不是一条抽象“边”；它拿到的是**来源字段地址** `from`。`src/hotspot/share/gc/g1/heapRegionRemSet.hpp:257`

这就把 remembered set 的真正记录粒度说明白了：它要记的不是“来源 Region 里有个对象指向我”这么粗的事实，而是“来源 Region 里的哪张 card 上有某个字段可能指向我”。

也就是说，RSet 真正想缩小的是 pause 时的扫描粒度：**从整块 Region 缩到具体来源 cards。**

所以本节最该记住的一句话是：**remembered set 不是对象图边表，而是 target Region 视角下的来源 card 反查表。**

## `OtherRegionsTable`：为什么 coarse/fine/sparse 是混合容器，不是单一模式切换

一旦理解了 remembered set 的方向，下一步就要看：它拿什么来装这些“谁的哪些 cards 可能指向我”的信息。

很多材料会把 G1 的 Sparse/Fine/Coarse 讲成一种“三态升级路径”：一开始 sparse，不够了就 fine，再不够就 coarse。这样讲勉强不算错，但很容易让人误会成“整张表此刻只能处在其中一种模式”。

源码里的真实结构更复杂，也更有意思。

### `_coarse_map`、`_fine_grain_regions`、`_sparse_table` 是同一张表里的三种容器

`OtherRegionsTable` 自己同时持有：

- `_coarse_map`
- `_fine_grain_regions`
- `_sparse_table`。`src/hotspot/share/gc/g1/heapRegionRemSet.hpp:74`

这说明 remembered set 不是“在 sparse/fine/coarse 三个模式里三选一”，而是**同一张表里并存三种粒度容器**：

- 对某些来源 Region，只有很少几张 card，就待在 `SparsePRT`；
- 对另一些来源 Region，会升级成 `PerRegionTable` 这种 fine-grained 记录；
- 如果 fine 表太满，就驱逐某个 fine entry，把对应来源 Region 粗化成 `_coarse_map` 上的一个位。

源码注释把这个策略说得很直白：fine 表有容量上限；溢出时会删除一个 fine entry，并设置对应 coarse-grained bit。`src/hotspot/share/gc/g1/heapRegionRemSet.hpp:50`

所以 coarse/fine/sparse 不是“整张 remembered set 的三态”，而是**同一张 remembered set 里，不同来源 Region 被用不同精度记账的混合容器。**

### `SparsePRT` 自己还分 `_cur` / `_next`

更进一步，`SparsePRT` 自身也不是一张单表，而是 `_cur` 和 `_next` 两张 `RSHashTable`。注释直接写明：迭代只看 `_cur`，其余操作都改 `_next`。`src/hotspot/share/gc/g1/sparsePRT.hpp:225`

这一步很像上一章 `_prev_mark_bitmap` / `_next_mark_bitmap` 的思路：一份给 pause 稳定读取，一份给并发更新继续长。

所以本节最该记住的一句话是：**RSet 内部不是一根链，而是一组按来源 Region 和并发时机共同分层的混合索引结构。**

## 脏卡怎么进 RSet：post barrier 为什么只标脏和入队

现在回到 remembered set 最前面的源头：post-write barrier。

### `write_ref_field_post_slow`：它并不直接改 RSet

`write_ref_field_post_slow()` 的逻辑极其克制：

- 如果这张 card 还不是 dirty，就把它置成 dirty；
- 然后把 card 的字节地址 `byte` 扔进当前线程的 `dirty_card_queue`；
- 非 JavaThread 才走共享队列并加锁。`src/hotspot/share/gc/g1/g1BarrierSet.cpp:99`

这说明 post barrier 干的不是“完整更新 remembered set”，而只是两件事：

1. 这张 card 现在值得后续检查；
2. 把它排进一条待精炼队列。

换句话说，post barrier 记录的是**线索**，不是结论。

### 为什么 pause 开始时还要 `concatenate_logs()`

即便有后台精炼线程，pause 开始前也还得先把各 Java 线程手头尚未写满的 partial dirty logs 拼进全局 completed list。这件事在 `DirtyCardQueueSet::concatenate_logs()` 里做，而且要求在 safepoint 下执行。`src/hotspot/share/gc/g1/dirtyCardQueue.cpp:337`

这一步非常重要，因为它说明 remembered set 的更新不是“后台线程最终总会搞定”的懒散承诺，而是：**后台能处理多少算多少，pause 开始时必须先把尾巴也收进来。**

所以本节最该记住的一句话是：**post barrier 只留下脏卡线索，真正的 remembered set 内容要靠后续精炼和 pause 清尾来补齐。**

## 并发精炼：为什么 refine thread 的工作单位是一整块 completed buffer

既然 post barrier 只留下线索，那真正把 card 线索翻译成 remembered set 的工作，主要就落在并发精炼线程上了。

### `run_service()`：它等的不是单卡，而是 completed buffers

`G1ConcurrentRefineThread::run_service()` 的主循环非常直接：

- 先 `wait_for_completed_buffers()`；
- 醒来后进入 `SuspendibleThreadSetJoiner`；
- 然后反复调 `do_refinement_step(worker_id)`，直到这轮工作告一段落。`src/hotspot/share/gc/g1/g1ConcurrentRefineThread.cpp:92`

这一步特别值得记，因为它说明 refine thread 的输入并不是“一张张卡”，而是**completed dirty-card buffers 这种批量单位**。

### `do_refinement_step()`：真正处理的是“下一个已满 buffer”

`do_refinement_step()` 本身也很短：看当前 completed buffer 数量，必要时激活更多线程，然后直接调用 `refine_completed_buffer_concurrently(...)`。`src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp:429`

也就是说，并发精炼线程真正的工作单位不是单个 card，而是：**从队列里取出一整块 completed buffer，再逐卡处理。**

这正是为什么 post barrier 能够便宜：mutator 把 card 地址成批推进队列，后台线程再成批吃掉。

### `G1ConcurrentRefineOopClosure`：更新方向是“来源字段 → 目标 Region.rem_set”

真正的 remembered set 更新逻辑，在 `G1ConcurrentRefineOopClosure::do_oop_work()`。它会：

- 从来源字段 `p` 读出对象 `obj`；
- 如果 source 和 target 在同一 Region，直接返回；
- 找到 target 所在的 Region 的 `rem_set()`；
- 如果 target 的 remembered set 当前处于 tracked 状态，就 `to_rem_set->add_reference(p, _worker_i)`。`src/hotspot/share/gc/g1/g1OopClosures.inline.hpp:131`

这一步特别值得慢下来读，因为它把 remembered set 的方向彻底钉死了：**扫描是在来源 card 上做的，但更新发生在目标 Region 的 rem_set 里。**

也就是说，这条链路真正翻译的是：

“我在来源 card 上发现了一个字段，它指向了别的 Region，那就去那个被指向 Region 的反向索引里记上一笔：有人可能从这张 card 来找你。”

所以本节最该记住的一句话是：**并发精炼不是在给来源 Region 记账，而是在替目标 Region 维护‘谁可能会来找我’。**

## pause 接力：为什么先 Update RS 再 Scan RS

后台线程能吃掉大部分 dirty buffers，但 pause 真正开始时，仍然要有最后一轮接力。

### `prepare_for_oops_into_collection_set_do`：先把各线程尾巴汇总进来

在真正处理 collection set 之前，`prepare_for_oops_into_collection_set_do()` 会先 `concatenate_logs()`，再 reset `_scan_state`。`src/hotspot/share/gc/g1/g1RemSet.cpp:511`

这一步意味着：pause 并不是“后台都做完了，我直接用 RSet”，而是先把各线程手上还没凑满的 dirty-card 尾巴也推进 completed list，再开始正式处理。

### `update_rem_set`：先清尾，不然看到的是过期索引

`G1RemSet::oops_into_collection_set_do()` 的顺序非常短，却非常关键：

- 先 `update_rem_set(pss, worker_i)`；
- 再 `scan_rem_set(pss, worker_i)`。`src/hotspot/share/gc/g1/g1RemSet.cpp:506`

这个顺序不能反。因为如果先扫 remembered set，再去处理 dirty-card 尾巴，你扫到的就是一张还没把最新来源卡片翻进去的过期索引。

`update_rem_set()` 自己的作用也很明确：

- 先处理 hot card cache；
- 再处理所有 remaining dirty-card buffers；
- 每处理一张 card，都通过 `G1ScanObjsDuringUpdateRSClosure` 决定：
  - 如果目标已经在 CSet，直接把引用推去 evacuate 队列；
  - 否则再把这张来源 card 记进目标 Region 的 remset。`src/hotspot/share/gc/g1/g1RemSet.cpp:477`、`src/hotspot/share/gc/g1/g1OopClosures.inline.hpp:159`

所以 Update RS 干的不是“顺手扫一遍脏卡”，而是**把暂停开始瞬间还没精炼完的那批线索正式翻译成可用于本次 evacuation 的 remembered-set 视图。**

### `scan_rem_set`：真正扫的是 CSet 各 Region 的入边表

等尾巴清完，`scan_rem_set()` 才真正以 collection set 为中心展开。`src/hotspot/share/gc/g1/g1RemSet.cpp:425`

`scan_rem_set_roots()` 的迭代方式特别能说明 remembered set 的用途：

- 它遍历的是 `r->rem_set()`；
- 也就是“这个 CSet Region 的外部入边来源 cards”；
- 再按 block claim、`scan_top` 截断、`claim_card` 等机制逐卡扫描。`src/hotspot/share/gc/g1/g1RemSet.cpp:341`

这意味着 pause 里的扫描工作集不再是“整块 old/humongous 空间”，而是“**collection set 中每个 Region 的 remembered set 里列出的那些可能命中的来源 cards**”。

这就是 remembered set 设计真正的收益兑现点。

所以本节最该记住的一句话是：**Update RS 先把索引补新，Scan RS 再用这张索引去只扫必要的 cards。**

## 到这里为止，主线其实只发生了四件事

如果前面层次很多，这里先把整件事压回四步：

1. post barrier 只把“这张来源 card 可能变脏了”记成 dirty-card 线索；
2. 并发精炼线程把大部分线索提前翻译成“目标 Region.rem_set 记住了这张来源 card”；
3. pause 开始时再用 Update RS 把尾巴清干净；
4. 最后 Scan RS 只扫 Collection Set 各 Region 的 remembered set 里列出的来源 cards，而不是整个老年代。

只要这四步还在脑子里，RSet 就不会再像一堆 sparse/fine/coarse 结构体细节。

## 常见误解澄清

### 误解一：RSet 记录的是“我引用了谁”

不是。

它是 target Region 视角下的反向索引：如果我要收我自己，外面谁的哪些 cards 可能指向我。`src/hotspot/share/gc/g1/heapRegionRemSet.hpp:257`

### 误解二：Sparse/Fine/Coarse 是三选一单状态机

不对。

同一张 `OtherRegionsTable` 里可以同时有 `_sparse_table`、`_fine_grain_regions` 和 `_coarse_map`；它们是混合容器，不是整表三态。`src/hotspot/share/gc/g1/heapRegionRemSet.hpp:74`

### 误解三：post barrier 会直接更新完整 RSet

不会。

它只把 card 置 dirty 并入队；真正把来源 card 翻成 target Region.rem_set 的工作，主要在并发精炼和 pause 内 Update RS。`src/hotspot/share/gc/g1/g1BarrierSet.cpp:99`

### 误解四：Scan RS 在扫整个老年代

不是。

它是围绕 collection set 的 owner Region 逐个遍历 `rem_set()`，只扫 remembered set 里列出的来源 cards。`src/hotspot/share/gc/g1/g1RemSet.cpp:425`

### 误解五：`rebuild` / `tracking` 和并发标记里的 liveness 统计是一回事

不对。

并发标记负责“谁活着”；RSet/RemSet tracking 负责“谁可能指向我要收的 Region”。两者会在同一轮 GC 周期里衔接，但回答的是不同问题。

## 收网：RSet 的本质，不是“多一张表”，而是把 pause 的工作集从整块老年代缩到可能命中的 cards

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
写引用时
  G1 post-barrier
    └─ card 置 dirty + byte* 入 DirtyCardQueue

并发期
  G1ConcurrentRefineThread
    └─ 取 completed dirty buffers
         └─ 扫 card 上对象字段
              └─ 对每个跨 Region 引用: 目标 Region.rem_set.add_reference(from)

暂停期
  prepare_for_oops_into_collection_set_do
    └─ 把各线程尾巴 dirty logs 拼进 completed list
  update_rem_set
    └─ 处理尚未精炼完的脏卡
  scan_rem_set
    └─ 以 Collection Set 的每个 Region 为 owner，反查来源 cards
```

把它再压成三句话：

- G1 remembered set 真正记录的不是“谁往外指”，而是“如果我要收我，谁可能从外面来找我”。
- post barrier、dirty-card queue、并发精炼、Update RS、Scan RS 组成的是一条“线索 → 反向索引 → pause 工作集”的接力链。
- 没有这条链，Young/Mixed pause 就会重新退化成扫描整个 old/humongous 空间，暂停时间重新和老年代体量绑定。

所以这一篇真正该记住的，不是 `_coarse_map`、`SparsePRT` 这些结构名本身。

真正该记住的是：**G1 想把 pause 时间压短，靠的不是‘扫描得更快’，而是‘在暂停前就把要扫的东西缩小到只剩可能命中的 cards’。RSet 正是这张工作集压缩表。**

下一篇就顺着这条链继续往后走。到这里，G1 已经既知道“谁活着”，也知道“谁可能指向我要收的 Region”；剩下最现实的问题就是：对象平时怎么落到 Region、何时进 TLAB、什么时候横躺成 humongous、晋升失败又怎么兜底。

> → [04 — 分配与晋升](04-allocation.md)
