# 26-g1-gc/04-allocation 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
> 目标：解释 G1 中一个对象从普通 mutator 分配、GC evacuation copy 到 humongous 连续 Region 分配的三条路径，以及每条路径如何在快路径、换 Region、暂停和失败重试之间分工

## 1. 选题判断

现稿已有很强事实基础：
- `mem_allocate` 的 humongous/普通分流
- `MutatorAllocRegion` / retained region
- `G1AllocRegion` lock-free/locked 两层
- slow path 与 Young pause
- `G1PLABAllocator`
- humongous 连续 Region、扩堆与初始化顺序

但当前正文信息密度很高，主要按“mutator/AllocRegion/slow/GC/humongous”堆路径。真正该打穿的读者困惑更集中：

**G1 里 `new Object()`、GC 复制活对象、超大对象分配，为什么不能共用同一个 bump-pointer？它们分别怎样避开线程竞争、减少尾部浪费、处理晋升目标、跨 Region 摆放和分配失败？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**G1 的分配不是一条越来越慢的长路径，而是三条互相隔离的路径：mutator 先在 TLAB 和 `MutatorAllocRegion` 上无锁 bump，GC worker 先在 survivor/old PLAB 上本地 bump，humongous 对象则直接申请连续 Region。它们共同遵守一个原则：对象级快路径尽量不抢全局锁，只有换 Region、补 PLAB、触发 pause 或处理连续大块时才进入慢协议。**

## 3. 总图

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

## 4. 结构大纲与字数预算

### 第一节：开场困惑——同一个“分配对象”，为什么 G1 有三套路径

目标约 1200 字。

- 从普通 new、GC copy、超大数组三种场景切入
- 点出三个场景的并发者、目标区域、对象形态都不同
- 埋主线：快路径尽量局部化，慢路径才承担全局协调

### 第二节：两个朴素方案为什么都不行

目标约 1800 字。

必须推演：
1. 所有对象都从一个共享 bump pointer 分配
2. 所有对象都统一走 TLAB/PLAB

结论：
- mutator、GC worker、humongous 的竞争与生命周期不同
- 大对象不能切片，GC copy 还要区分 survivor/old 目标

### 第三节：mutator 总入口——为什么先判 humongous，再走普通路径

目标约 1800 字。

- `G1CollectedHeap::mem_allocate`
- 严格 `> Region/2`
- `allocate_new_tlab` 只是普通分配请求的壳
- 收回三路分流主线

### 第四节：普通 mutator——为什么 TLAB 下面还有 retained/active 两个 Region

目标约 2200 字。

- `G1Allocator::attempt_allocation`
- `attempt_retained_allocation`
- `MutatorAllocRegion::should_retain`
- 为什么保留还能装 TLAB 的尾部 Region
- `G1AllocRegion` 快路径与 active region 非空发布顺序

### 第五节：slow path——为什么分配失败先锁内重试，再尝试增量 pause

目标约 1900 字。

- `attempt_allocation_locked`
- 重试/retire/new region
- GCLocker 特殊分支
- `do_collection_pause` 后无锁重试
- 强调普通分配失败不等于直接 Full GC

### 第六节：GC copy——为什么每个 worker 要有 survivor/old 两个 PLAB

目标约 2200 字。

- `G1PLABAllocator`
- survivor/tenured buffers
- PLAB bump 快路径
- `allocate_direct_or_new_plab`
- 过大对象或 refill 失败的 direct allocation
- `par_allocate_during_gc` 的 Young/Old 分流和 `FreeList_lock`

### 第七节：humongous——为什么完全绕过 TLAB/PLAB 去抢连续 Region

目标约 2300 字。

- `humongous_obj_size_in_regions`
- empty first / expand_at
- StartsHumongous/ContinuesHumongous
- 初始化顺序与 concurrent refine 并发碰撞
- 分配前检查是否触发 concurrent mark

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. TLAB refill 是否等于直接领新 Region
2. active allocation region 是否可能是空 Region
3. 所有 GC copy 是否都先进 PLAB
4. humongous 是否直接 Full GC
5. 普通分配失败是否必然马上停顿

## 5. 失败方案必须写进正文

1. 所有对象共享一个 bump pointer
2. 所有 GC copy 都强制先进入 PLAB
3. humongous 分配失败就直接 Full GC

## 6. 证据清单

- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:389`：`allocate_new_tlab`
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:398`：`mem_allocate`
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:410`：`attempt_allocation_slow`
- `src/hotspot/share/gc/g1/g1Allocator.inline.hpp:44`：mutator retained/active
- `src/hotspot/share/gc/g1/g1AllocRegion.cpp:134`：新 Region 先分配后发布
- `src/hotspot/share/gc/g1/g1AllocRegion.cpp:275`：`should_retain`
- `src/hotspot/share/gc/g1/g1Allocator.hpp:127`：`G1PLABAllocator`
- `src/hotspot/share/gc/g1/g1Allocator.inline.hpp:73`：PLAB 快路径
- `src/hotspot/share/gc/g1/g1Allocator.cpp:164`：GC Young/Old 分流
- `src/hotspot/share/gc/g1/g1Allocator.cpp:264`：direct/new PLAB
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:312`：humongous Region 数量
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:320`：连续 Region 分配
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:857`：humongous 分配前启动 concurrent mark

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
- 本篇聚焦分配路径，不展开完整 TLAB 实现和晋升年龄策略
- PLAB 只讲分配/目标分流，不展开 evacuation scanner
- humongous 初始化并发约束只讲必要主线，不扩 RSet/refinement 专题
- 下一篇承接 collection set/mixed policy 的策略选择

## 8. 完成后 review

- 删除代码后，能否复述“mutator、GC copy、humongous 是三条分配路径”
- 是否清楚区分 TLAB/MutatorAllocRegion、PLAB/GC alloc region、连续 Region
- 是否说明 lock-free 快路径与换 Region 慢路径的边界
- 是否解释了普通分配失败先 pause/retry，而非立刻 Full GC
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
