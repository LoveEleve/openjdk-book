# 01. 为什么 G1 要把堆切成一张网格？— `HeapRegion` 与 `G1CollectedHeap`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`。这里讨论的是 G1 的堆结构骨架：Region 大小怎样确定、Region 类型怎样编码、`HeapRegion`/`HeapRegionManager`/`G1CollectedHeap` 各自承担什么角色，以及 commit/uncommit、humongous、young pause 与 full compaction 怎样围着这张网格运转。并发标记和 SATB 的细节留到下一篇展开。
>
> **前置依赖**：[25-gc-framework/02 — `CollectedHeap` + 分配路径](../25-gc-framework/02-collected-heap.md)、[25-gc-framework/01 — `BarrierSet` + Access API](../25-gc-framework/01-barrier-access.md)、[09-memory-core/01 — `Universe` + `CollectedHeap`](../09-memory-core/01-universe-heap.md)
> → **后续**：[02 — 并发标记 + SATB](02-concurrent-marking.md)

很多人第一次接触 G1 时，最直观的印象往往是：“它把堆切成了很多小块”。

这句话不算错，但很容易把 G1 最重要的设计感讲丢。

因为 G1 真正的变化并不是“块变小了”这么简单，而是它不再把堆的语义牢牢绑在几块固定的大区上。传统分代收集器更像是在堆上画几大块固定地盘：这里永远是 Eden，那边永远是 Old，GC 主要围着这些边界做文章。

G1 则反过来：它先把堆切成一张等大格子的网格，再让每个格子在不同阶段贴不同标签——这一轮是 Eden，下一轮变 Survivor，再下一轮变 Old；某些大对象甚至会横躺跨过多个格子。

这就逼出本篇最该回答的问题：**G1 为什么非要把堆切成一张网格，而不是像传统分代收集器那样维持几块固定的大区？Region 的大小为什么要围着 2048 块这个数量级打转？标签为什么要设计成可流动的位掩码而不是静态分区名？这一整张网格到底是谁在管理、谁在按需 commit、谁在决定某块下一轮是 Eden 还是 Old？**

先把答案压成一句话：**G1 的关键不是“Region 比代大还是小”，而是它把堆从‘少数几个固定角色的大块’改造成了‘大量等大格子 + 动态标签’的网格系统：地址空间先按 Region 粒度排成一张表，Region 自己承载对象与局部统计，标签决定它此刻扮演 Eden/Survivor/Old/Humongous 哪种角色，`G1CollectedHeap` 则像总调度器一样按暂停目标和存活度重新组合这些格子。**

## 先试两个最自然的理解，看看为什么都不对

### 朴素方案一：Region 只是把传统分代大块再细切一层

这是最常见的第一反应。

既然 G1 还是有 Eden、Survivor、Old 这些词，那 Region 看起来就像是把原来的年轻代/老年代再切成很多小片。大方向没变，只是粒度更细而已。

这个理解的问题在于，它低估了“角色能流动”这件事的意义。

在固定大块分代模型里，某块地址一开始被划进年轻代，它的身份就长期由地址决定。GC 的难点主要是怎样在这几块固定区域之间搬运对象。

而 G1 的 Region 则反过来：**地址是固定的，角色是流动的。** 某个 Region 这轮是 Eden，回收后可能变 Free；另一轮又可以重新贴成 Survivor；再往后还可能被贴成 Old。也就是说，分代不再是几块大地址区间，而是 Region 网格上的动态标签。

这件事带来的不是“块变小了”这么简单，而是整个调度模型变了：暂停时不再天然对应“收整个年轻代大区”，而更像是在网格上挑一组当前最值得回收的格子。

所以第一种朴素方案失败，不是因为 G1 没有代际概念，而是因为**它把“代”的语义从固定地址区间搬到了可流动的 Region 标签上。**

### 朴素方案二：Region 大小应该固定，堆越大块数就线性增长

第二个也很自然的想法是：既然 Region 是网格格子，那格子的大小应该是个常量，比如永远 1MB。堆越大，格子数自然越多。

这对实现来说当然最直接，但它会立刻把 G1 拖进另一头的麻烦：每个 Region 都会带着一套局部元数据和管理成本。块太小，元数据膨胀；块太大，回收粒度又变粗，很多“只收最值得收的那几块”就失去了精细度。

源码里的 `HeapRegionBounds` 其实把这个权衡说得很直白：

- Region 下限是 1MB；
- 上限是 32MB；
- 自动计算时目标是大约 2048 个 Region；
- 上限存在的直接原因之一，就是 region 太大时，cleanup 找到完全空 Region 的机会会下降。`src/hotspot/share/gc/g1/heapRegionBounds.hpp:32`

这说明 G1 真正在追的不是某个固定块尺寸，而是“**让块数维持在一个成本和粒度都还能接受的量级**”。

所以第二种朴素方案失败，不是因为固定块大小完全不可用，而是因为**G1 关心的是网格尺度的平衡，不是某个神圣不变的 MB 数字。**

这两个失败方案合起来，正好引出本篇主线：**G1 的核心不是“小块”，而是“固定地址网格 + 动态角色标签 + 围绕目标块数做尺度折中”。**

## Region 大小：为什么 G1 盯的是目标块数，不是固定块尺寸

先看这张网格的尺度是怎么定的。

`HeapRegion::setup_heap_region_size()` 的逻辑非常干净：

- 如果显式给了 `-XX:G1HeapRegionSize`，就先拿这个值；
- 如果没显式给，就用 `(initial_heap_size + max_heap_size) / 2 / target_number()` 做起始估算；
- 然后强制向下取 2 的幂；
- 最后再夹在最小 1MB、最大 32MB 之间。`src/hotspot/share/gc/g1/heapRegion.cpp:63`

这一步特别值得停一下，因为它直接说明：**G1 自动算 Region 大小时，心里想的首先不是“每块多大”，而是“总共大约要多少块”。**

### 为什么目标是 ~2048 块

`HeapRegionBounds` 里把这个目标直接写成了常量：`TARGET_REGION_NUMBER = 2048`。`src/hotspot/share/gc/g1/heapRegionBounds.hpp:32`

这不是一个拍脑袋的美观数字，而是整个 G1 网格尺度的设计锚点。因为一旦 Region 选定，后面很多 per-region 成本都会跟着它走：

- BOT 的粒度和分摊；
- card table / card counts 的 per-region 映射；
- remembered set 的区域维度；
- 并发标记 bitmap 的区域划分；
- 回收时 collection set 的选择粒度。

块数太少，意味着每块太大，回收和清理粒度会变粗；块数太多，则代表每个 Region 上的管理结构太密，光网格本身的维护成本就会膨胀。

所以“2048 块左右”本质上是在给整张网格选一个可接受的标尺。

### 这不是“堆越大越多块”，而是“堆越大每块越大”

因为目标块数近似固定，堆越大时自动结果往往不是块数暴涨，而是每块变大。比如一个足够大的堆，除以 2048 之后自然会推高 Region 大小，再经 2 的幂和上下限裁剪落到一个合适值。

这说明 G1 真正在追求的是：**保持网格复杂度大致稳定，让每块尺寸随着堆规模一起伸缩。**

所以本节最该记住的一句话是：**Region 大小不是主角，网格块数尺度才是主角。**

## `RegionType`：为什么标签是位掩码而不是分区名

网格尺度定好之后，下一步该看“格子现在扮演什么角色”。

很多资料会把 G1 Region 类型讲成一张“有几种区域”的枚举表，这样讲当然不算错，但还不够抓住它的设计重点。

因为 `HeapRegionType` 在源码里不是一组平铺编号，而是**位掩码组合**。`src/hotspot/share/gc/g1/heapRegionType.hpp:47`

### 角色不是独立编号，而是由掩码组合出来的

源码里的类型布局非常说明问题：

- `YoungMask`
- `HumongousMask`
- `PinnedMask`
- `OldMask`
- `ArchiveMask`

再在这些掩码上组合出：

- `Eden`
- `Survivor`
- `StartsHumongous`
- `ContinuesHumongous`
- `OpenArchive`
- `ClosedArchive`。`src/hotspot/share/gc/g1/heapRegionType.hpp:47`

这说明 Region 类型的重点不在“总共有几种名字”，而在“**这些名字本身就是位模式上的组合**”。

### 为什么这样编码比静态分区名更合适

位掩码的直接好处，是很多谓词都能变成按位测试：

- `is_young()` 看 `YoungMask`；
- `is_humongous()` 看 `HumongousMask`；
- `is_archive()` 看 `ArchiveMask`；
- `is_old()` 看 `OldMask`。`src/hotspot/share/gc/g1/heapRegionType.hpp:123`

这让 G1 在调度时可以很自然地问“这块是不是年轻区”“这块是不是 humongous”“这块是不是 old 但也可能 pinned/archive”，而不是每次都拿一串离散枚举名做多分支判断。

更重要的是，它非常适合“角色是流动的”这个世界观。因为一块 Region 本来就可能同时带着“old 的某种味道”和“archive/pinned 的特殊约束”。

所以本节最该记住的一句话是：**G1 的 Region 标签不是静态分区名，而是为了支持角色组合与快速谓词判断而设计的位掩码。**

## `HeapRegion` 结构：为什么字段分层比平铺更重要

尺度和标签都定了，接下来才轮到格子本身长什么样。

这里最容易被讲乱的点，是把 `_bottom/_end/_top/_type/_rem_set/_bot_part/TAMS` 全都当成“HeapRegion 自己的字段平铺表”。

源码其实明确把这些责任分层了。

### `HeapRegion` 不是直接从 `Space` 跳来的，它中间还夹着 `G1ContiguousSpace`

类骨架非常清楚：

- `G1ContiguousSpace` 先在 `CompactibleSpace` 之上增加 `_top`、`_bot_part`、并行分配锁等；
- `HeapRegion` 再在其上叠加 `_rem_set`、`_hrm_index`、`_type`、`_humongous_start_region`、`_prev/_next_marked_bytes`、TAMS 双指针等。`src/hotspot/share/gc/g1/heapRegion.hpp:97`

这说明 G1 并不是把所有区域相关状态粗暴塞进一个类里，而是先把“连续空间的分配面”和“Region 语义面”拆成了两层。

### `_top`、BOT、RSet、TAMS 分别在回答不同问题

- `_bottom/_end` 给的是地址范围（更底层的 Space 语义）；
- `_top` 给的是当前分配推进到哪（连续空间语义）；
- `_bot_part` 给的是块偏移表的 per-region 部分；
- `_rem_set` 负责跨 Region 引用记账；
- `_prev_marked_bytes/_next_marked_bytes` 和 TAMS 双指针则是并发标记视角下的存活统计边界。`src/hotspot/share/gc/g1/heapRegion.hpp:227`

这几个字段被放在一起，很容易让读者误以为它们都在回答“这个 Region 现在用了多少”。其实完全不是。

它们分别在回答：

- 地址边界在哪里；
- 分配到哪里了；
- 任意地址怎样反查块起点；
- 别的 Region 指向这里的引用怎么记；
- 标记开始前已有对象与标记期间新分配对象怎么分界。

所以本节最该记住的一句话是：**Region 不是一块内存而已，它还是一份局部管理账本。**

### TAMS 双指针为什么是下一篇并发标记的引线

`note_start_of_marking()` 会把 `_next_top_at_mark_start` 记成当前 `top()`；`note_end_of_marking()` 则把它转存到 `_prev_top_at_mark_start`，再把 next 重置回 `bottom()`。`src/hotspot/share/gc/g1/heapRegion.inline.hpp:243`

这一步的设计味道很强。它其实是在说：**并发标记时，Region 不只要知道“现在顶到哪”，还要知道“标记开始那一刻顶到哪”。**

这样，标记线程和分配线程才能共享同一块 Region，却不把“标记开始后新长出来的对象”混进本轮存活统计里。

所以 TAMS 这对指针，是 G1 从“网格化堆”走向“并发标记”的第一根引线。

## `G1CollectedHeap.initialize`：为什么要先 reserve，再造六张 mapper 账本

看完单块 Region，再看谁来管理整张网格。

`G1CollectedHeap` 自己的骨架已经非常能说明问题：

- `_hrm` 持有所有 Region 的序列与映射；
- `_allocator` 管普通分配；
- 其他子管理器各司其职。`src/hotspot/share/gc/g1/g1CollectedHeap.hpp:209`

这说明 `G1CollectedHeap` 本身不是“把所有 Region 细节亲手管理到位”的超级类，而更像一个总调度器。

### initialize 不是“创建所有 Region 并填满堆”，而是先 reserve 整张棋盘

`initialize()` 的第一件大事，是按 `max_heap_byte_size` 调 `Universe::reserve_heap(...)` 保留整块最大堆地址空间。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:1533`

然后它会依次创建：

- heap storage mapper
- BOT mapper
- card table mapper
- card counts mapper
- prev bitmap mapper
- next bitmap mapper

最后再 `_hrm.initialize(...)` 把这些 mapper 一起交给 RegionManager。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:1589`

这一步特别值得停一下，因为它说明 G1 在初始化阶段做的不是“把堆直接灌满对象空间”，而是**先把整张网格以及它附带的几张辅助账本地址空间都排好。** 这里的“排好”首先是 reserve/mapping 层面的：真正的 `HeapRegion` 实例还要等某个 Region 首次被 commit、进入 `make_regions_available` 时才创建并 `initialize`。`src/hotspot/share/gc/g1/heapRegionManager.hpp:48`、`src/hotspot/share/gc/g1/heapRegionManager.cpp:121`

### 为什么是“六张 mapper 账本”而不是一块单内存

这几张 mapper 分别对应：

- heap 本体
- BOT
- card table
- card counts
- 两张并发标记 bitmap

它们共享同一套 Region 粒度管理节奏，但并不是同一块单内存。也就是说，G1 的网格化不只发生在“对象区”，还发生在“跟着对象区一起切分的辅助结构区”。不过要记住：这里先就位的是地址空间和 mapper 视图，不等于每个 Region 对象此刻都已出生。

所以本节最该记住的一句话是：**G1 不是只把对象堆切成 Region，而是把一整套 per-region 辅助结构也一起网格化了；Region 实例本身则按需出场。**

## commit/uncommit 与 humongous：为什么网格必须支持按 Region 粒度按揭和横躺对象

光把最大堆 reserve 出来还不够，G1 还必须支持：

- 初始只 commit 一部分；
- 后面按 Region 粒度扩；
- 不用的 Region 再按粒度 uncommit；
- 以及对巨型对象跨格子摆放。

### `G1RegionToSpaceMapper`：commit 的单位就是 Region 组

`G1RegionToSpaceMapper` 的大粒度实现里，`commit_regions(start_idx, num_regions, ...)` 和 `uncommit_regions(...)` 会直接按 Region 组映射到页范围上做 commit/uncommit。`src/hotspot/share/gc/g1/g1RegionToSpaceMapper.cpp:70`

这说明整张网格不是“逻辑切出来看看”，而是真正参与虚拟内存按揭管理的单位。

### Linux 上的 commit/uncommit 本质上是同址覆盖 mmap

Linux 路径里，commit 是在原地址上用 `PROT_READ|PROT_WRITE` 的 `mmap(MAP_FIXED|MAP_ANONYMOUS)` 覆盖；uncommit 则是同样地址上再用一次 `PROT_NONE` 的 `mmap(MAP_FIXED|MAP_NORESERVE|MAP_ANONYMOUS)` 覆盖。`src/hotspot/os/linux/os_linux.cpp:3209`、`src/hotspot/os/linux/os_linux.cpp:3641`

这一步很有设计感，因为它说明从虚拟地址视角看，G1 真正稳定的是**那张 Region 网格**，而不是“这块地址是否当前有物理页 backing”。

这恰好和前面 Region 的网格观吻合：格子的地址总在那里，commit/uncommit 只是让它暂时有肉或没肉；而 Region 何时真正进入可用状态、何时被挂回 free list，还要经过 `HeapRegionManager::make_regions_available` 那一层对象初始化和列表管理。

### humongous：为什么“大对象横躺”而不是切碎

`humongous_threshold_for(region_size)` 直接定义成 `region_size / 2`，而 `is_humongous` 用的是严格大于。`src/hotspot/share/gc/g1/g1CollectedHeap.hpp:1212`

这说明 G1 在这里的策略是：**对象一旦大到超过半个 Region，就别再硬塞进普通 Region 分配流了，直接按连续 Region 成片摆放。**

这样做首先有一个很直接的物理原因：对象不能被切片跨 Region 分配，超过半个 Region 的对象继续走普通路径会很快把格子的剩余空间切得支离破碎。进一步看，它也在保护整张网格的普通调度规律：小对象走单格或少量格子的普通分配节奏，大对象则明确走“横躺跨格子”的专门路径。

所以本节最该记住的一句话是：**网格想维持调度秩序，就必须容忍两种完全不同的摆放方式：普通格子推进和 humongous 横躺。**

## pause 与 full：为什么 G1 的年轻回收是在挑格子，不是在整代回收

最后再回到回收动作本身，看这张网格怎样真正被用起来。

### young/mixed pause：本质上是在挑一组 Region 组队

`do_collection_pause_at_safepoint()` 的执行骨架非常清楚：

- 先 `finalize_collection_set(...)`
- 再初始化 GC alloc regions
- 然后 `evacuate_collection_set(...)`
- 最后 `free_collection_set(...)`。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:2794`

这一串动作最该注意的不是函数名，而是：**pause 在 G1 里不是天然针对某块固定地址区，而是在每次暂停前先组一份 collection set。** 对 mixed 候选 old regions 来说，这份“组队”尤其体现为按收益与暂停目标做选择；对 young-only / concurrent-start 等阶段，则还会受到当轮阶段约束。

这正是 Region 网格最核心的收益之一：回收对象的“战场范围”可以按当前目标动态重组，而不是死死绑定在一个固定 young 区大矩形上。

### full GC：四阶段压缩，则又回到另一种尺度

而 `G1FullCollector::collect()` 则是另一条路线：

- `phase1_mark_live_objects()`
- `phase2_prepare_compaction()`
- `phase3_adjust_pointers()`
- `phase4_do_compaction()`。`src/hotspot/share/gc/g1/g1FullCollector.cpp:167`

这条骨架非常接近经典 full compaction collector：当 G1 不再只是“挑格子做 evacuate”，而是真的进入 full GC 时，它会重新回到一种全堆尺度上的标记、调整、压缩流程。

所以 G1 并不是“永远只做 region 粒度的小步调度”，而是：**平时靠网格细粒度调度，走不通时仍然保留一条更重的全堆压缩后路。**

## 到这里为止，主线其实只发生了四件事

如果前面信息不少，这里先把整件事压回四步：

1. G1 先把堆切成围绕 ~2048 块目标数量自动定尺的等大 Region 网格；
2. Region 自己带着地址边界、分配指针、BOT/TAMS/存活统计和动态标签；
3. `G1CollectedHeap` 再把 heap/BOT/card/bitmap 这些辅助结构一起按 Region 粒度管理起来；
4. 平时回收靠 collection set 挑格子组队，full GC 时再回到全堆压缩尺度。

只要这四步还在脑子里，G1 就不会再被误解成“只是把年轻代和老年代切得更碎”。

## 常见误解澄清

### 误解一：Region 只是小号年轻代/老年代块

不是。

它们的关键不是“小”，而是角色可流动：同一块地址今天是 Eden，下一轮可能就变成 Survivor 或 Old。`src/hotspot/share/gc/g1/heapRegionType.hpp:123`

### 误解二：`G1HeapRegionSize` 总是一个固定常量

不对。

默认情况下它是围绕目标块数自动算出来的，再夹在 1MB 到 32MB 之间；只有显式 `-XX:G1HeapRegionSize` 才是用户固定值。`src/hotspot/share/gc/g1/heapRegion.cpp:63`

### 误解三：Humongous 条件是“大于等于 Region 一半”

不是。

源码明确用了严格大于，正好一半的对象仍不算 humongous。`src/hotspot/share/gc/g1/g1CollectedHeap.hpp:1212`

### 误解四：`HeapRegion` 对象会在 initialize 时一次性全建好并填满堆

不能这么理解。

初始化真正先做的是 reserve 最大地址空间、排好 mapper 和 Region 管理表；commit 与实际使用是后续按粒度推进的。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:1533`

### 误解五：G1 young pause 就等于回收一个固定 Young 大区

不是。

pause 前先有 `finalize_collection_set` 这一步，本质上是在根据当前目标和收益挑一组 Region 参战。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:2794`

## 收网：G1 的本质，不是“小块堆”，而是“网格化堆 + 动态标签 + 按格子调度”

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
大堆先被切成 ~2048 个等大 Region
  ├─ Region 大小：1MB~32MB，围着目标块数自动计算
  ├─ Region 自己有 bottom/end/top、BOT、TAMS、RSet 指针等局部状态
  └─ RegionType 不是固定分区名，而是可重贴的位掩码标签

总管理者
  G1CollectedHeap
    ├─ _hrm        : Region 表与地址映射
    ├─ _allocator  : 普通分配/GC 分配
    ├─ _g1_rem_set : 跨 Region 引用记账
    ├─ _cm         : 并发标记
    └─ _g1_policy  : 选择这轮收哪些格子
```

把它再压成三句话：

- G1 真正改变的不是“块更小”，而是把“代”的语义从固定地址大区挪成了 Region 网格上的动态标签。
- Region 大小围着目标块数自动定尺，是为了在回收粒度和 per-region 元数据成本之间找平衡。
- `G1CollectedHeap` 的调度力量，正来自它能按 Region 粒度 reserve、commit、贴标签、选 collection set，而不是被固定年轻代/老年代边界锁死。

所以这一篇真正该记住的，不是 1MB、2MB 还是 32MB 这些数字本身。

真正该记住的是：**G1 把堆从“几块固定地盘”改成了一张可重贴标签、可按格子调度、可按粒度按揭的网格。** 只有先理解这张网格，下一篇里并发标记如何依靠 TAMS 和位图与分配线程并行，才会变得自然。

> → [02 — 并发标记 + SATB](02-concurrent-marking.md)
