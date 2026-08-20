# 02. 应用线程还在改图，G1 为什么还敢并发标记？— 并发标记 + SATB

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`。这里讨论的是 G1 并发标记的主协议：SATB pre-barrier、`G1ConcurrentMarkThread`、双 bitmap、remark 与 cleanup 怎样协作，保证在应用线程仍然运行并修改对象图时，G1 仍能得到一份“标记开始时”的活对象快照。RSet/card table 的细节放下一篇展开。
>
> **前置依赖**：[01 — 为什么 G1 要把堆切成一张网格？— `HeapRegion` 与 `G1CollectedHeap`](01-heapregion.md)、[25-gc-framework/01 — `BarrierSet` + Access API](../25-gc-framework/01-barrier-access.md)、[25-gc-framework/02 — `CollectedHeap` + 分配路径](../25-gc-framework/02-collected-heap.md)
> → **后续**：[03 — RSet + CardTable](03-rem-set.md)

一说“并发标记”，最容易冒出来的直觉问题其实非常朴素：

**你还在跑应用线程，它还在改引用、分配对象、把旧边改成新边，标记线程凭什么还能说自己最终知道‘谁活着’？**

如果把这个问题压得更尖一点，就是：在 stop-the-world 标记里，GC 能看到的是一个静止世界；而在 G1 并发标记里，对象图本身在不断动。你不可能一边拍照，一边又要求被拍对象永远别动。

这就逼出本篇最该回答的问题：**应用线程在并发标记期间还在不断改引用，G1 为什么还敢说自己最终能知道‘标记开始时谁活着’？它为什么不追当前世界，而要坚持追‘旧世界快照’？SATB、TAMS、双 bitmap、remark 各自到底在补哪一个漏洞？**

先把答案压成一句话：**G1 并发标记的关键不是“标得多快”，而是“先冻结旧世界，再允许应用继续改图”。SATB pre-barrier 记录的是被覆盖掉的旧引用，不是新引用；`_next_top_at_mark_start` 划出本轮该看的对象边界；并发线程只往 `_next_mark_bitmap` 里画本轮结果，remark 再在 STW 下把剩余 SATB buffers 和线程根补齐，最后把这轮 bitmap 与每个 Region 的 `_next_marked_bytes` 一起安装成下一轮 pause 的决策依据。**

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：并发标记只要足够快，就能追上当前对象图

这是最自然的第一反应。

既然应用线程会改图，那标记线程就追着它跑：你改一条边，我尽快看到；你分配一个对象，我尽快扫描它；只要速度足够快，最终总能跟上当前世界。

这个想法的问题在于，它把并发标记当成了一个“追最新状态”的赛车游戏，而对象图并不是一个有终点的赛道。

因为 mutator 的修改不是单调的：

- 某条旧边可以被删掉；
- 新边可以被加上；
- 同一个对象可能在标记线程赶到之前就已经被改过好几轮。

如果标记目标定义成“始终追当前世界”，你就会遇到一个根本问题：**当前世界没有稳定截面。** 你永远不知道“这一轮标记到底算完成在哪个时间点的图”。

所以 G1 并没有试图去追一个不断变化的“现在”，而是把目标先改写成：“给我一份标记开始那一刻的逻辑快照，只要当时活着的对象别丢就行。”

也就是说，并发标记的第一个关键选择不是算法，而是**目标定义**。

### 朴素方案二：既然要保快照，那写引用后把新值记下来就行

第二个也很自然的想法是：好，我接受不追当前世界，只要保住一个快照。那写引用时是不是应该把“新值”记下来？毕竟新值代表修改后的图，记录新值似乎比记录旧值更直觉。

这个想法正好踩中了 SATB 最反直觉、也最精妙的地方。

并发标记要保的不是“修改后世界长什么样”，而是“**修改前、标记开始时的世界里哪些对象原本还连着**”。如果某条边从 `A -> B` 改成 `A -> C`，真正危险的是：标记线程稍后再来扫 A 时，只看到 C，而把 B 永远漏掉。

换句话说，**快照会丢失的不是新边，而是被覆盖掉的旧边。**

所以要保住快照，你必须在写入发生前先把旧值记下来。多记一些新边无伤大雅，漏掉旧边则可能直接把“标记开始时本来活着的对象”错回收掉。

这就是为什么 G1 选择 SATB（Snapshot-At-The-Beginning）：它追的不是新边，而是旧边。

所以第二种方案失败，不是因为新值不重要，而是因为**对“保旧世界快照”这件事来说，被覆盖掉的旧值才是不能丢的那部分信息。**

这两个失败方案合起来，正好引出本篇主线：**G1 并发标记不是在追当前世界，而是在 mutator 继续改图的同时，尽力保住标记开始时那份旧世界快照。**

## SATB：为什么 pre-write barrier 记的是旧值

先看这套快照协议最核心的一层：SATB pre-write barrier。

### `write_ref_field_pre`：真正拦的是“旧边即将被覆盖”

G1 的 pre-barrier 在 `write_ref_field_pre` 里。逻辑很短：

- 如果目标位置还没初始化，或者这次访问不需要 keepalive，就直接返回；
- 否则先从 field 里读出旧值；
- 旧值非空，就 `enqueue(decode_not_null(old_value))`。`src/hotspot/share/gc/g1/g1BarrierSet.inline.hpp:36`

这段代码最值得记住的一点是：它不是在写完之后看“新引用是谁”，而是在写之前先把“旧引用是谁”拎出来。

这就是 SATB 的全部灵魂：**先拍下旧边，再允许你改图。**

### 为什么 `IS_DEST_UNINITIALIZED` 和 `AS_NO_KEEPALIVE` 可以跳过

这里的两个早退条件也很有信息量。

- `IS_DEST_UNINITIALIZED` 说明这是新对象或未初始化目的地，没有“被覆盖掉的旧值”可保；
- `AS_NO_KEEPALIVE` 则说明这次访问语义上不该因此额外延长对象活性。

这说明 pre-barrier 不是“凡是写引用都记一笔”，而是在非常精确地回答：**这次写操作会不会让某条旧边从快照里消失。**

### `enqueue`：为什么队列还要区分 Java 线程本地和共享队列

真正入队在 `G1BarrierSet::enqueue()` 里。这里又有两个特别关键的点：

- 如果 `_satb_mark_queue_set` 当前不 active，直接返回；
- 如果当前线程是 JavaThread，就进自己的线程本地 SATB 队列；否则才走共享队列并加锁。`src/hotspot/share/gc/g1/g1BarrierSet.cpp:61`

这说明 SATB 不只是正确性协议，还是一套非常刻意的**开销控制协议**：

- 并发标记没开时，pre-barrier 基本等于不存在；
- 标记期开启时，大头成本压到线程本地 buffer，尽量避免共享锁。

所以本节最该记住的一句话是：**SATB pre-barrier 的本体不是“有个队列”，而是“只在并发标记期，为每条即将消失的旧边留一张快照存根”。**

## 并发标记线程：为什么 root region 必须先扫完再进入常规并发循环

有了 SATB，还不够。GC 还得真的有一条并发线程去消费这些旧边，并把活性结果画进位图里。

### `run_service`：不是“后台一直标”，而是按阶段睡醒一轮轮干

`G1ConcurrentMarkThread::run_service()` 的骨架非常清楚：

- 平时睡在 `sleep_before_next_cycle()`；
- 被唤醒后把 phase 切到 `CONCURRENT_CYCLE`；
- 然后一轮轮推进 clear claimed marks、scan root regions、mark from roots、remark、cleanup 这些子阶段。`src/hotspot/share/gc/g1/g1ConcurrentMarkThread.cpp:247`

也就是说，G1 并发标记线程不是“永远在后台一点点扫”，而是一轮并发标记周期里的多阶段状态机；其中 `mark_from_roots()` 只是这整轮 cycle 里最核心、但不是唯一的并发工作段。

### 为什么 root region 扫描必须在后续 evacuation 前先完成

`run_service()` 里有一段注释非常重要：root regions 的扫描必须在下一次 GC 前完成，否则后续 pause 可能在 root region 还没扫完的情况下就先把对象拷走，导致正确性问题。`src/hotspot/share/gc/g1/g1ConcurrentMarkThread.cpp:279`

这一步说明并发标记不是“所有阶段都可以随便和暂停交织”。相反，它有一段非常刚性的先后关系：**某些起始根区域必须先补标完成，后面的 evacuation pause 才敢继续照常搬对象。**

所以并发标记线程不是一个“自由后台线程”，它其实在不断和暂停路径做正确性对齐。

## `mark_from_roots` 与 `make_reference_grey`：为什么 below-finger 才入灰栈

真正的大头并发工作从 `mark_from_roots()` 开始。`src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:973`

### `mark_from_roots`：它干的不是单线程 DFS，而是 worker gang 的时间片协作

`mark_from_roots()` 先算 active workers 数，再构造 `G1CMConcurrentMarkingTask`，最后让 concurrent workers 跑这份任务。`src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:973`

所以这里的并发标记不是“一个后台线程独自 DFS 堆”，而是 worker gang 共同消费一份图遍历工作。

### `make_reference_grey`：先在 next bitmap 里原子置位，再决定要不要入灰栈

最关键的对象标记入口在 `make_reference_grey()`：

- 先调 `_cm->mark_in_next_bitmap(_worker_id, obj)`；
- 如果这次 CAS 置位失败，说明别人已经抢先标过，直接返回；
- 置位成功后，再看这个对象是不是在 global finger 之下；
- 只有已经被 bitmap 扫描面“越过去”的区域，才需要把对象压灰栈补扫。`src/hotspot/share/gc/g1/g1ConcurrentMark.inline.hpp:213`

这一步特别值得讲清楚，因为它说明并发标记并不是“凡是新发现对象都一律压队列”，而是非常在意“这个对象当前位于扫描进度线的哪一侧”。

- 如果对象还在 finger 前面，后面的位图扫描迟早会自然遇到它；
- 如果对象已经落在 finger 后面，那说明扫描指针可能已经越过它了，这时不压灰栈就真有可能漏掉它的出边。

所以 below-finger 的判断，本质上是在补“**位图扫描面已经扫过去，而 SATB/引用遍历刚把你补标出来**”这种时序漏洞。

### 为什么 typeArray 甚至不入栈

`make_reference_grey()` 里对 `typeArray` 还有一条专门分支：直接 `process_grey_task_entry<false>(entry)`，不走正常灰栈压入。原因也写得很清楚：primitive array 没有引用字段，不值得为了它再走一圈 mark stack。`src/hotspot/share/gc/g1/g1ConcurrentMark.inline.hpp:213`

这再次说明并发标记的重点不是“统一把所有标记对象都做成同一种任务”，而是**在正确性成立前提下尽量减少无意义工作。**

## 双 bitmap 与 TAMS：为什么本轮结果不能直接覆盖上一轮结果

并发标记的第二个容易被想简单的点，是位图。

很多读者第一次看双 bitmap 时会想：两张位图是不是只是实现方便，多一张做中转？

G1 这里不是这样。

### `_prev_mark_bitmap` / `_next_mark_bitmap`：分别代表“上一轮世界结论”和“本轮正在画的结论”

G1ConcurrentMark 里明确有：

- `_mark_bitmap_1`
- `_mark_bitmap_2`
- `_prev_mark_bitmap`
- `_next_mark_bitmap`。`src/hotspot/share/gc/g1/g1ConcurrentMark.hpp`（对应实现见字段引用）

这套结构的关键不在“有两张位图”，而在它们的角色分工：

- `_prev` 代表上一轮已经完成、可被后续回收/策略路径当作稳定基准消费的标记结果；
- `_next` 代表本轮并发标记正在构造中的结果。

如果你一边并发标记，一边直接覆盖上一轮结果，那么后续依赖“上一轮稳定结论”的路径就会失去基准。所以下一轮结果必须先在 next 上独立生长，直到 remark 完成、确认补漏结束，才整体安装成新的 prev。

### TAMS 为什么是位图语义的边界线

上一章留下的 TAMS 双指针在这里终于接上了：`note_start_of_marking()` 记下 `_next_top_at_mark_start = top()`，`note_end_of_marking()` 再把它转存到 `_prev_top_at_mark_start`。`src/hotspot/share/gc/g1/heapRegion.inline.hpp:243`

这意味着本轮位图要描述的，不是“当前 Region 里现在所有对象”，而是“**标记开始那一刻之前已经存在于 Region 里的对象**”。标记开始后新分配的对象位于 TAMS 之上，它们不属于这一轮快照统计范围。

所以 TAMS 和双 bitmap 其实是在共同回答一个问题：**本轮活性结果到底是对哪一时刻的世界做出的判断。**

## remark 与 cleanup：为什么最后仍然必须 STW 补漏和入账

并发标记真正最容易被低估的一步，是最后那两个很短的暂停：remark 和 cleanup。

如果只看总时间，它们常常很短；但从正确性上说，它们是整轮并发标记真正落地的关键关门动作。

### `remark`：不是“最后扫一下”，而是关闭快照窗口

`remark()` 一开始就要求 `assert_at_safepoint_on_vm_thread()`。`src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:1139`

随后最关键的动作包括：

- `finalize_marking()`
- 把所有线程的 SATB active 统一关掉；
- `flush_all_task_caches()`
- `swap_mark_bitmaps()`
- `Update Remembered Set Tracking Before Rebuild`
- `Reclaim Empty Regions()`。`src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:1139`

这说明 remark 不是“并发标记的尾声日志”，而是**正式宣布‘旧世界快照窗口现在关闭，本轮结果要安装了’** 的阶段。

### `finalize_marking()`：必须保证剩余 SATB buffers 真正清空

`finalize_marking()` 里有一个非常强的保证：如果没有 overflow，那么 `completed_buffers_num()` 必须为 0。`src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:1858`

这句话特别关键，因为它说明 remark 的职责之一就是：**把并发期间 mutator 留下的那些 SATB 存根真正消化干净。**

并发阶段可以边跑边攒 buffer，但如果 remark 结束时 completed buffers 还没清光，那这一轮快照就还没真正闭合。

### `swap_mark_bitmaps` 与 liveness 入账为什么在这里发生

remark 里真正把本轮结果“安装”出来的动作，就是 `swap_mark_bitmaps()`，再配合 `Update Remembered Set Tracking Before Rebuild` 这一步，把 Region 层面的 liveness 统计和 rebuild 前的 RSet tracking 状态一起收口进去。`src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:1178`

这一步特别重要，因为它说明：**并发循环本身不是想什么时候记 `_next_marked_bytes` 就什么时候记。** 真正让本轮活性结果成为“下一轮策略可消费数据”的，是 remark 关门后的安装过程；而这个阶段名字虽然叫 `RemSetTracking`，实际做的不只是 RSet tracking policy 切换，还包含 marked bytes 与 TAMS 的收尾。

### cleanup：不是重算活性，而是收尾和后续准备

`cleanup()` 同样要求 safepoint。它做的是：

- `Update Remembered Set Tracking After Rebuild`
- 可选的 liveness 打印
- 统计和阶段收尾。`src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:1356`

这说明 cleanup 不是“再算一遍活性”，而是**把 remark 之后还需要补的一些 tracking/cleanup 状态做完，给下一轮 GC 或 marking 准备好场地。**

所以本节最该记住的一句话是：**remark 负责关门并安装结果，cleanup 负责收尾并把舞台整理给下一轮。**

## 到这里为止，主线其实只发生了四件事

如果前面细节很多，这里先把整件事压回四步：

1. G1 一开始就放弃追“当前世界”，改为追“标记开始时的旧世界快照”；
2. SATB pre-barrier 负责在旧边消失前把它们先记下来；
3. 并发线程负责把这份旧世界快照逐步画进 `_next_mark_bitmap`；
4. remark 再在 STW 下把剩余 SATB、线程根和 Region liveness 一起收口，并把本轮结果安装成新的稳定基准。

只要这四步还在脑子里，并发标记就不会再像一堆 barrier、bitmap 和 remark 阶段名的拼盘。

## 常见误解澄清

### 误解一：SATB 记录的是新引用

不是。

SATB pre-barrier 关心的是“即将被覆盖掉的旧值”，因为快照真正会丢的是旧边，不是新边。`src/hotspot/share/gc/g1/g1BarrierSet.inline.hpp:36`

### 误解二：并发标记是在追当前最新对象图

不对。

它追的是标记开始时的旧世界快照；当前世界的变化被容忍，只要不会把那张快照里的活对象漏掉。TAMS 和 SATB 都是在为这个目标服务。

### 误解三：双 bitmap 只是实现方便，多一张做缓存

不是。

`_prev` 和 `_next` 代表两轮不同时间语义的活性结果：一张稳定可消费，一张正在构建。没有这层分工，remark/cleanup 和下一轮策略都失去稳定基准。

### 误解四：remark 只是日志里一个很短的 STW 尾声

也不是。

remark 是关闭快照窗口、清空剩余 SATB、swap 位图并安装 liveness 结果的关键关门阶段。时间短不代表职责轻。`src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:1139`

### 误解五：cleanup 负责重新计算全部 liveness

不对。

主要的 mark 完成与位图安装发生在 remark；cleanup 更偏 tracking 收尾和下一轮准备。`src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:1356`

## 收网：G1 并发标记的本质，不是追当前世界，而是守住旧世界快照

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
标记开始前
  initial-mark pause
    └─ 记录 TAMS / 打开 SATB 队列

并发期间
  mutator 写引用
    └─ pre-write barrier 把旧值 enqueue 到 SATB queues
  G1ConcurrentMarkThread
    └─ drain SATB -> 扫灰对象 -> 在 next bitmap 置位

remark (STW)
  ├─ 重扫线程根
  ├─ drain 剩余 SATB buffers
  ├─ swap_mark_bitmaps
  └─ 把 liveness 入账到 Region

cleanup
  └─ 主要做回收空 Region 与后续 tracking 收尾，不重新计算整轮活性
```

把它再压成三句话：

- G1 并发标记真正冻结的不是线程，而是“标记开始时的旧世界快照”。
- SATB、TAMS、双 bitmap 和 remark 各自补的是不同漏洞：旧边会消失、新对象会继续分配、本轮结果不能直接覆盖上一轮、线程根和剩余 buffers 最后必须关门清空。
- 只有当这些协议一起成立时，G1 才敢让应用线程继续跑着，而自己并发地算出“这一轮到底谁活着”。

所以这一篇真正该记住的，不是 barrier 名字和 phase 名字。

真正该记住的是：**G1 并发标记的核心从来不是“边跑边标”，而是“先定义要保的那一刻，再用一整套协议保证那一刻不会被改图行为撕裂”。** 这就是它能一边让应用继续跑、一边又敢在下一次 pause 时拿存活度做决策的根本前提。

下一篇就顺着这套快照协议继续往下走。并发标记已经知道“谁活着”，但 evacuation pause 还要知道“老年代里谁指向我要搬的年轻对象”。那就轮到 G1 的另一根支柱：RSet 和 CardTable 了。

> → [03 — RSet + CardTable](03-rem-set.md)
