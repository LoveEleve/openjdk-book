# 04. `new Object()` 在 G1 里到底落哪？— Mutator、GC Copy 与 Humongous 三条分配路径

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`。这里讨论 G1 中三类对象落地路径：Java mutator 的普通分配、GC worker 的 evacuation copy、以及 humongous 对象的连续 Region 分配。TLAB 的完整实现、晋升年龄策略和 evacuation scanner 不在本文展开。
>
> **前置依赖**：[03 — 为什么 G1 pause 不扫全老年代？— RSet + CardTable 的反向索引协议](03-rem-set.md)、[25-gc-framework/02 — `new Object()` 走到了哪？— `CollectedHeap` + 分配路径](../25-gc-framework/02-collected-heap.md)、[01 — 为什么 G1 要把堆切成一张网格？— `HeapRegion` 与 `G1CollectedHeap`](01-heapregion.md)
> → **后续**：[05 — Mixed GC + 策略](05-mixed-gc-policy.md)

到这里，G1 已经有了三张关键地图：

- Region 网格告诉它“空间被切成了哪些格子”；
- 并发标记告诉它“哪些对象活着”；
- RSet 告诉它“谁可能指向我要收的 Region”。

但 JVM 还要面对一个最现实的问题：**对象究竟应该落到哪一块内存里？**

这句话看起来像是在问一个地址，实际上是在问三套完全不同的分配协议：

- Java mutator 调 `new Object()`，希望以最低成本拿到一段普通 Eden 空间；
- GC worker 搬运活对象，希望多个线程并行把对象复制到 survivor 或 old 目标区；
- 超过半个 Region 的大对象，根本不适合塞进 TLAB 或 PLAB，而要横跨连续 Region。

这就逼出本篇最该回答的问题：**G1 里 `new Object()`、GC 复制活对象、超大对象分配，为什么不能共用同一个 bump-pointer？它们分别怎样避开线程竞争、减少尾部浪费、处理晋升目标、跨 Region 摆放和分配失败？**

先把答案压成一句话：**G1 的分配不是一条越来越慢的长路径，而是三条互相隔离的路径：mutator 先在 TLAB 和 `MutatorAllocRegion` 上无锁 bump，GC worker 先在 survivor/old PLAB 上本地 bump，humongous 对象则直接申请连续 Region。它们共同遵守一个原则：对象级快路径尽量不抢全局锁，只有换 Region、补 PLAB、触发 pause 或处理连续大块时才进入慢协议。**

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：所有对象共享一个 bump pointer

这是最简单的内存分配器思路：准备一块大空间，维护一个全局 `top`，谁来申请对象，谁就把 `top` 往前推一段。

如果只有一个线程，这个方案非常漂亮；但 G1 同时面对：

- 大量 Java mutator 线程；
- 多个 GC worker；
- 不同目标代际；
- Region 轮换与暂停边界；
- humongous 连续空间请求。

把它们全塞进一个 bump pointer，会立刻引入几种冲突：

- 每次普通对象分配都要在全局竞争；
- GC worker 复制 survivor 和 old 对象会抢同一套空间；
- TLAB/PLAB 的局部性完全消失；
- 大对象不能切片跨 Region，必须另找连续区间；
- 一旦 `top` 不能满足请求，普通对象和大对象的失败处理也会互相污染。

所以第一种方案失败，不是 bump pointer 不好，而是**G1 的三个住户有不同的竞争者、目标区和失败语义，必须先把路径隔离。**

### 朴素方案二：所有 GC copy 都先塞进 PLAB

第二个很自然的想法是：既然 PLAB 能让 worker 本地 bump，那 GC 复制的所有对象都先进入 PLAB。对象再大也先申请一个足够大的 PLAB，不就统一了吗？

这个办法会在两个地方浪费：

- 大对象本身可能接近或超过一个 PLAB 的合理尺寸；
- 为了容纳一次大分配而新开 PLAB，可能要扔掉旧 PLAB 的大段尾部空间。

所以 G1 的真实策略不是“PLAB 万能”，而是：**适合装进 PLAB 的对象用 PLAB；不值得为它新开一块 PLAB 的对象直接落到 GC allocation region。**

这两个失败方案合起来，正好引出本篇主线：**mutator、GC copy、humongous 不是同一条分配路径的不同速度档，而是三种不同的空间协议。**

## Mutator 总入口：为什么先判 humongous，再走普通路径

先看 Java 线程自己的分配。

`G1CollectedHeap::mem_allocate()` 的第一件事不是直接问 `G1Allocator`，而是先判断对象大小：

- 如果 `is_humongous(word_size)`，走 `attempt_allocation_humongous`；
- 否则走普通 `attempt_allocation`。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:398`

这条分流非常关键，因为它说明 humongous 对象从入口上就绕开了普通 mutator 快路径。

### 为什么 humongous 是严格大于 Region/2

`humongous_threshold_for(region_size)` 返回 `region_size / 2`，而 `is_humongous()` 使用严格大于。`src/hotspot/share/gc/g1/g1CollectedHeap.hpp:1212`

这个“严格大于”不是细枝末节，而是为了保证：

- TLAB 的大小上限不会刚好踩到 humongous 边界，避免把 TLAB 本身当成 humongous 对象处理；
- 正好半个 Region 的对象仍然可以留在普通分配模型里；
- 只有超过半个 Region，才进入连续 Region 逻辑。

所以普通对象分配和 humongous 分配的边界，是一个明确的大小协议，不是后面失败了才临时决定。

### `allocate_new_tlab` 其实只是普通路径的壳

G1 的 `allocate_new_tlab()` 自己几乎不做额外策略，只断言请求不能是 humongous，然后转到普通 `attempt_allocation`。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:389`

这说明 TLAB refill 在 G1 眼里并不是一条独立的“特殊分配算法”，而是普通对象分配的一种请求形式：带着最小和期望大小，向 mutator allocation path 要一段空间。

所以本节最该记住的一句话是：**G1 分配入口先按对象大小分出 humongous 与 ordinary，TLAB 只是 ordinary 路径的前端缓存。**

## 普通 Mutator：为什么 TLAB 下面还有 retained/active 两个 Region

普通对象进入 `attempt_allocation()` 后，才来到 `G1Allocator`。

### 第一层：先吃 retained，再吃 active

`G1Allocator::attempt_allocation()` 的顺序非常短：

1. 先向 `mutator_alloc_region()->attempt_retained_allocation(...)` 要空间；
2. 失败后，再向当前 active allocation region `attempt_allocation(...)` 要空间。`src/hotspot/share/gc/g1/g1Allocator.inline.hpp:44`

所以普通 mutator 的实际路径不是“TLAB 满了就立刻领新 Eden Region”，而是：

- Java 线程先在自己的 TLAB 里 bump；
- TLAB refill 到 G1；
- G1 先看有没有还值得继续使用的 retained Region；
- 再看当前 active mutator Region；
- 都失败后才进入加锁换区和 GC 慢路径。

### 为什么要保留一个尾部还没吃干净的 Region

`MutatorAllocRegion::should_retain()` 会检查：

- 当前 Region 的 free bytes 是否至少还能容纳 `MinTLABSize`；
- 如果已经有 retained Region，当前这个 Region 的空闲量是否更值得保留；
- 只有残量连一个完整 TLAB 都装不下时，才不保留。`src/hotspot/share/gc/g1/g1AllocRegion.cpp:275`

这项设计直接针对一个现实问题：**Region 退休时经常会留下装不下普通对象、但仍然能装下一块 TLAB 的尾巴。**

如果每次 active Region 不能继续满足当前请求就直接 retire，这些尾巴会变成内部浪费。G1 因此允许同时保留：

- 一个当前 active mutator allocation Region；
- 一个 retained allocation Region。

下一次 TLAB refill 先吃 retained，再吃 active，尽量把尾部空间榨干。

这不是为了让分配逻辑更复杂，而是用一个小型暂存位换更少的 Region 尾部浪费；但前提是残量真的还能装下一整个 TLAB，否则保留没有意义。

### 快路径为什么不需要堆锁

`G1AllocRegion::attempt_allocation()` 只是取当前 `_alloc_region`，调用并行 bump allocation；只要当前 Region 还有空间，整个路径不需要拿堆锁。`src/hotspot/share/gc/g1/g1Allocator.inline.hpp:44`

真正需要锁的是“当前 Region 不够了，要不要退休、要不要领新 Region”。这时 `attempt_allocation_locked()` 会：

1. 锁内重试一次，防止等待锁期间别人已经换好 Region；
2. `retire(true)` 封住旧 Region；
3. `new_alloc_region_and_allocate(...)` 领新 Region 并完成第一笔分配。`src/hotspot/share/gc/g1/g1Allocator.inline.hpp:54`

### 为什么新 Region 要先分配成功，再发布成 active

`new_alloc_region_and_allocate()` 的顺序非常关键：

- 先拿到新 Region；
- 先在里面完成第一笔分配；
- 做 `storestore`；
- 最后才更新 `_alloc_region`。`src/hotspot/share/gc/g1/g1AllocRegion.cpp:134`

源码注释直接说了原因：这样可以保证 active allocation Region 不会是空的。

这是一条很漂亮的发布协议：**别人一旦看见 `_alloc_region` 指向新 Region，就至少能相信这个 Region 已经有第一笔有效分配，而不是刚拿到一块还没初始化的空壳。**

## Slow path：为什么分配失败先锁内重试，再尝试增量 pause

普通快路径和换 Region 都失败后，才进入 `attempt_allocation_slow()`。

这条路径不是“失败就 Full GC”，而是一套循环：

1. 在 `Heap_lock` 下调用 `attempt_allocation_locked()`；
2. 如果 GCLocker 正在阻塞 GC，且年轻代还有扩展空间，先尝试 `attempt_allocation_force()`；
3. 如果可以调 GC，就安排一次 `do_collection_pause(..., GCCause::_g1_inc_collection_pause)`；
4. pause 之后再无锁重试普通分配；
5. 如果是 GCLocker 阻塞，就等待它清除，再回到下一轮。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:410`

这条顺序非常能体现 G1 的优先级：

- 先争取在现有分配结构里解决；
- 再尝试一次增量回收；
- 回收后重试；
- 循环不直接触发 Full GC，Full GC 由 `mem_allocate` 返回 NULL 后的调用方另行决定。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:410`

所以普通分配失败首先意味着“需要协调一次暂停或等待条件”，不等于马上进入 Full GC。

## GC Copy：为什么每个 worker 要有 survivor/old 两个 PLAB

mutator 分配解决的是“新对象第一次落地”。GC worker 复制活对象时，目标语义又不一样：对象可能去 survivor，也可能直接晋升 old。

### `G1PLABAllocator` 不是一个 PLAB，而是两个目标缓冲

`G1PLABAllocator` 同时维护：

- `_surviving_alloc_buffer`
- `_tenured_alloc_buffer`
- `_alloc_buffers[InCSetState::Num]`。`src/hotspot/share/gc/g1/g1Allocator.hpp:127`

这不是为了对象分类好看，而是因为 evacuation 的目标不同：

- 还年轻但活下来的对象去 survivor；
- 满足晋升条件或被策略安排的对象去 old。

如果两个目标共用一个 PLAB，就会把不同目标区的布局、统计和分配锁混在一起。

### 第一反应仍然是本地 bump

`G1PLABAllocator::allocate()` 先调用 `plab_allocate()`；只要当前 PLAB 够用，就直接本地 bump 返回。`src/hotspot/share/gc/g1/g1Allocator.inline.hpp:73`

这和 mutator 的 TLAB 思路是同构的：**对象复制的常见路径也尽量让 worker 在自己的局部缓冲里完成，不要每复制一个对象就去共享 Region 抢空间。**

### PLAB 不够时：新开一块，或者直接分配

`allocate_direct_or_new_plab()` 会先计算这个对象是否适合放进一个新的 PLAB，以及扔掉旧 PLAB 尾巴的浪费是否能接受；适合就 retire 旧 PLAB、申请新 PLAB，再在其中 bump。否则就直接调用 `par_allocate_during_gc()` 为这个对象分配空间。`src/hotspot/share/gc/g1/g1Allocator.cpp:264`

所以“大对象晋升”并不保证一定进 PLAB。它可能因为：

- 对象太大，不值得单独开 PLAB；
- 新 PLAB 申请失败；
- 旧 PLAB 尾部浪费太大；

而直接落进 GC allocation region。

### survivor/old 目标最后落到两条 GC allocation region

`par_allocate_during_gc()` 根据 `InCSetState` 分流：

- `Young` -> `survivor_attempt_allocation`
- `Old` -> `old_attempt_allocation`。`src/hotspot/share/gc/g1/g1Allocator.cpp:174`

这两条路径都先无锁尝试当前 GC allocation Region，失败后才在 `FreeList_lock` 下重试并换 Region。

因此 GC copy 的竞争也分成两层：

- PLAB 解决对象级别的 worker 竞争；
- survivor/old GC allocation Region 解决 Region 级别的共享竞争。

## Humongous：为什么完全绕过 TLAB/PLAB 去抢连续 Region

如果对象超过 Region 一半，它就不再进入普通 TLAB/PLAB 逻辑，而是走连续 Region 分配。

### 先算需要几块连续 Region

`humongous_obj_size_in_regions()` 会把对象大小向 Region 粒度对齐，再除以 `GrainWords`，得到所需 Region 数。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:312`

分配时的顺序是：

- 一个 Region 就先走单 Region 快路径；
- 多个 Region 先找连续的已提交空 Region；
- 不够再找 free + unavailable 的连续窗口，必要时 `expand_at()` 先 commit；
- 连连续窗口都找不到，才进入更重的回收/整理可能性。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:320`

这说明 humongous 分配失败也不是“直接 Full GC”这么简单。G1 会先判断是不是还有连续地址窗口，只是还没 commit；能扩就先扩。

### 为什么 humongous 初始化顺序必须小心

连续 Region 找到之后，还不能随便把它们标成 Starts/Continues 就算结束。

因为分配者虽然持有 `Heap_lock`，但 concurrent refinement 等 reader 线程可能同时看到这些新 Region。初始化必须确保其他线程不会在 Region 的 header、BOT、类型和 top 还处于半成品状态时，把它当成正常可扫描对象区。

所以 humongous 初始化会遵循类似这样的顺序：

- 先准备新对象头和填充对象；
- 第一块设为 `StartsHumongous`，后续块设为 `ContinuesHumongous`；
- 做必要的内存发布；
- 最后再把各 Region 的 `top` 推到正确位置。

这条顺序的本质不是“初始化代码比较长”，而是：**humongous Region 的发布也必须遵守并发可见性协议。**

### 为什么 humongous 分配前还要检查是否启动并发标记

G1 在 `attempt_allocation_humongous()` 里会在真正分配前调用 `need_to_start_conc_mark(...)`。源码注释直接说明：humongous 对象可能很快吃掉大量堆空间，所以要在分配前检查是否应启动并发标记，避免分配后再追踪这块新增内存。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:857`

这说明 humongous 不只是“另一种分配方式”，还是一个会影响整个 G1 周期状态的高压力事件。

## 到这里为止，主线其实只发生了四件事

如果前面路径比较多，这里先把整件事压回四步：

1. mutator 普通对象先走 TLAB，再由 `MutatorAllocRegion` 的 retained/active Region 接力；
2. 只有在换 Region 或条件不足时，才进入锁内分配、Young pause 和重试；
3. GC worker 复制对象先吃 survivor/old PLAB，不适合 PLAB 的对象再 direct allocate；
4. humongous 对象直接申请连续 Region，并在并发可见性约束下完成 Starts/Continues 初始化。

只要这四步还在脑子里，G1 的分配就不会再像一条从快到慢的单链路。

## 常见误解澄清

### 误解一：TLAB refill 就等于直接领新 Region

不完全是。

TLAB refill 先进入 G1 的普通 mutator allocation path，会先试 retained Region，再试 active Region，失败后才换 Region。`src/hotspot/share/gc/g1/g1Allocator.inline.hpp:44`

### 误解二：active allocation Region 可能只是刚领来的空 Region

当前发布顺序下不是这样。

G1 会先在新 Region 上完成第一笔分配，再发布 `_alloc_region`，用 `storestore` 保证观察者不会看到一个空的 active Region。`src/hotspot/share/gc/g1/g1AllocRegion.cpp:134`

### 误解三：所有 GC copy 都先进 PLAB

不对。

PLAB 不适合或 refill 失败时，GC worker 会直接向 survivor/old GC allocation Region 分配。`src/hotspot/share/gc/g1/g1Allocator.cpp:264`

### 误解四：humongous 分配失败就直接 Full GC

不是。

G1 会先找已提交的连续空 Region，再找可扩展的 free + unavailable 连续窗口；能扩就先 commit。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:320`

### 误解五：普通分配失败必然马上停顿

不是。

快路径失败后还会先锁内重试、处理 GCLocker 特殊分支，再尝试一次增量 pause 并重试；是否进入更重路径取决于后续连续失败。`src/hotspot/share/gc/g1/g1CollectedHeap.cpp:410`

## 收网：G1 分配的本质，是三条隔离路径共享一张 Region 网格

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
Java mutator
  new object / TLAB refill
    └─ mem_allocate
         ├─ > Region/2 -> humongous path
         └─ ordinary
              ├─ TLAB
              ├─ retained MutatorAllocRegion
              ├─ active MutatorAllocRegion
              └─ Heap_lock + allocation pause + retry

GC worker evacuation
  copy live object
    └─ G1PLABAllocator
         ├─ survivor PLAB
         ├─ old PLAB
         ├─ refill new PLAB
         └─ too large / refill fail -> direct GC alloc region

Humongous
  └─ contiguous Region run
       ├─ empty committed first
       ├─ free + unavailable -> expand/commit
       └─ initialize Starts/Continues + publish safely
```

把它再压成三句话：

- mutator 的目标是低延迟，所以把竞争挡在 TLAB、retained Region 和 active Region 之外。
- GC worker 的目标是并行复制，所以把对象级竞争挡在 PLAB 之外，再按 survivor/old 目标进入 GC allocation Region。
- humongous 的目标是保证大对象完整落地，所以绕过 TLAB/PLAB，直接申请连续 Region 并用专门初始化顺序发布。

所以这一篇真正该记住的，不是 TLAB、PLAB、MutatorAllocRegion、GC alloc region 这些名字本身。

真正该记住的是：**G1 没有试图用一个万能 allocator 解决所有对象落地问题，而是把不同住户的竞争和失败语义隔离到三条路径里；三条路径最后仍然共享同一张可按 Region 调度的网格。**

下一篇就顺着分配之后的策略问题继续往后走：并发标记给出了每个 Region 的存活度，RSet 给出了入边成本，分配路径给出了新空间和复制目标；Mixed GC 到底怎么把这些信息合成一份 collection set，暂停目标与回收收益又如何折中？下一篇展开策略层。

> → [05 — Mixed GC + 策略](05-mixed-gc-policy.md)
