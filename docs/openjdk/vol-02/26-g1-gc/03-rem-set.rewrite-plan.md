# 26-g1-gc/03-rem-set 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
> 目标：解释 G1 为什么不在 Young/Mixed Pause 里扫描整个老年代找入边，而要构造 per-region 的 remembered set；同时讲清 post-write barrier、DirtyCardQueue、并发精炼、Update RS、Scan RS 怎样接力把“可能指向 Collection Set 的 card”缩到最小工作集

## 1. 选题判断

现稿已有很强事实基础：
- `HeapRegionRemSet` / `OtherRegionsTable`
- `SparsePRT`
- `add_reference`
- `G1RemSet::update_rem_set / scan_rem_set`
- `scan_rem_set_roots`
- `write_ref_field_post_slow`
- `G1ConcurrentRefineThread` / `do_refinement_step`
- `G1ConcurrentRefineOopClosure`

但当前正文仍偏“RSet 结构层次很多”的事实堆叠。真正该打穿的读者困惑更集中：

**并发标记已经知道‘哪些对象活着’，可 evacuation pause 仍然必须知道‘谁指向了我要搬的 Region’。G1 为什么不直接在暂停里扫描整个老年代？为什么要提前把 post-write barrier 变成 dirty card queue，再后台精炼成 remembered set？RSet 到底存的不是‘我引用了谁’，而是‘谁引用了我’这件事，为什么这么关键？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**G1 的 remembered set 本质上是一张 per-region 反向索引：我不关心‘这个 Old Region 指向了谁’，我关心‘如果我要收 Region Y，哪些别的 Region 的哪些 card 里可能有指向 Y 的引用’。post-write barrier 只负责把来源 card 标脏并入队；并发精炼线程再把“来源 card → 目标 Region”这层关系慢慢翻译进目标 Region 的 RSet。这样 pause 里就能先 Update RS 清尾，再 Scan RS 只扫可能命中 Collection Set 的卡，而不是整块老年代。**

## 3. 总图

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

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么 G1 pause 不直接扫整个老年代找入边

目标约 1200 字。

- 从 evacuation pause 还要找指向 CSet 的外部引用切入
- 点出：全扫 old/humongous 的成本会让 pause 时间重新和老年代大小绑定
- 埋主线：RSet 是“谁引用了我”的反向索引

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. Young/Mixed GC 时扫描整个老年代最稳妥
2. 写 barrier 可以直接把目标 Region 立即更新到 RSet，不需要 dirty card queue/refinement

结论：
- 第一种把 pause 成本重新和堆大小绑定
- 第二种把 mutator 热路径推得太重，也丢掉批处理精炼机会

### 第三节：`HeapRegionRemSet`——为什么 owner Region 存的是“谁引用了我”

目标约 2200 字。

- `_rem_set` 在 `HeapRegion` 上
- `HeapRegionRemSet` / `_other_regions` / `_code_roots`
- `add_reference(from)` 的方向
- 说明 owner region / source region / source card 三层关系

### 第四节：`OtherRegionsTable`——为什么 coarse/fine/sparse 是混合容器，不是单一模式切换

目标约 2200 字。

- `_coarse_map`
- `_fine_grain_regions`
- `SparsePRT`
- cap fine table then coarsen 的策略
- 路标：这张表是在做“怎样花不同粒度的空间去记来源 Region 的 card”

### 第五节：脏卡怎么进 RSet——post barrier 为什么只标脏和入队

目标约 1900 字。

- `write_ref_field_post_slow`
- dirty card queue
- 为什么不在 barrier 里直接更新 RSet
- `concatenate_logs()` 在 pause 起点把线程尾巴拼进来
- 收回“mutator 热路径只负责留下线索”主线

### 第六节：并发精炼——为什么 refine thread 的工作单位是一整块 completed buffer

目标约 2100 字。

- `G1ConcurrentRefineThread::run_service`
- `do_refinement_step`
- `refine_completed_buffer_concurrently`
- `G1ConcurrentRefineOopClosure::do_oop_work`
- 说明 refine 的真正方向是“来源字段 -> 目标 Region.rem_set.add_reference”

### 第七节：pause 接力——为什么先 Update RS 再 Scan RS

目标约 2200 字。

- `prepare_for_oops_into_collection_set_do`
- `update_rem_set`
- `scan_rem_set`
- `scan_rem_set_roots`
- `iter_claimed_next` / `scan_top` / `claim_card`
- 强调 pause 的工作集是“可能指向 CSet 的 cards”，不是整个 old

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. RSet 是否记录“我引用了谁”
2. Sparse/Fine/Coarse 是否三选一单状态机
3. post barrier 是否直接更新 RSet
4. Scan RS 是否在扫整个老年代
5. `rebuild` / `tracking` 是否和 liveness 标记是同一件事

## 5. 失败方案必须写进正文

1. 暂停里直接扫描整个老年代找入边
2. post barrier 现场直接维护完整 RSet
3. 把 RSet 理解成“来源 Region 存自己指向谁”的正向表

## 6. 证据清单

- `src/hotspot/share/gc/g1/heapRegionRemSet.hpp:50`：`_coarse_map` 注释
- `src/hotspot/share/gc/g1/heapRegionRemSet.hpp:74`：`OtherRegionsTable`
- `src/hotspot/share/gc/g1/heapRegionRemSet.hpp:133`：`card_within_region`
- `src/hotspot/share/gc/g1/heapRegionRemSet.hpp:170`：`HeapRegionRemSet`
- `src/hotspot/share/gc/g1/heapRegionRemSet.hpp:257`：`add_reference`
- `src/hotspot/share/gc/g1/sparsePRT.hpp:46`：`SparsePRTEntry`
- `src/hotspot/share/gc/g1/sparsePRT.hpp:225`：`SparsePRT` 双表注释
- `src/hotspot/share/gc/g1/g1BarrierSet.cpp:99`：`write_ref_field_post_slow`
- `src/hotspot/share/gc/g1/dirtyCardQueue.cpp:337`：`concatenate_logs`
- `src/hotspot/share/gc/g1/g1ConcurrentRefineThread.cpp:92`：`run_service`
- `src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp:429`：`do_refinement_step`
- `src/hotspot/share/gc/g1/g1OopClosures.inline.hpp:131`：并发 refine 更新 target remset
- `src/hotspot/share/gc/g1/g1OopClosures.inline.hpp:159`：pause Update RS closure
- `src/hotspot/share/gc/g1/g1RemSet.hpp:54`：`G1RemSet` 注释与 `scan_rem_set/update_rem_set`
- `src/hotspot/share/gc/g1/g1RemSet.cpp:341`：`scan_rem_set_roots`
- `src/hotspot/share/gc/g1/g1RemSet.cpp:425`：`scan_rem_set`
- `src/hotspot/share/gc/g1/g1RemSet.cpp:477`：`update_rem_set`
- `src/hotspot/share/gc/g1/g1RemSet.cpp:506`：`oops_into_collection_set_do`
- `src/hotspot/share/gc/g1/g1RemSet.cpp:511`：`prepare_for_oops_into_collection_set_do`
- `src/hotspot/share/gc/g1/g1RemSet.cpp:518`：`cleanup_after_oops_into_collection_set_do`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
- 本篇聚焦 remembered set / card tracking，不展开 SATB 与并发标记细节
- RSet rebuild/cleanup 只在必要处点边界，不抢后续 mixed/policy 篇章内容
- glibc/OS card table 之外的外部结构不展开
- 下一篇若讲分配/晋升，应自然承接“既知道谁活、也知道谁指向 CSet 了”

## 8. 完成后 review

- 删除代码后，能否复述“RSet 是 per-region 反向索引，pause 扫的是可能指向 CSet 的卡”
- 是否清楚解释 post barrier、dirty queues、并发 refine、Update RS、Scan RS 的接力顺序
- 是否讲清来源字段地址进入目标 Region.rem_set 的方向
- 是否讲清 sparse/fine/coarse 是混合容器而不是单一模式切换
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
