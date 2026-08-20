# 26-g1-gc/05-mixed-gc-policy 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
> 目标：解释 G1 的策略层如何在“暂停目标时间”这一条外部约束下，依次决定三件事——什么时候启动并发标记（IHOP）、什么时候该做 Mixed GC、一个暂停里到底选哪些 Old Region 进 CSet；并说明所有决策都共享同一个“用历史样本预测时间、再按时间预算排优先级”的机制

## 1. 选题判断

现稿已有很强事实基础：
- `G1StaticIHOPControl` / `G1AdaptiveIHOPControl`
- `G1Predictions`（均值 + sigma×标准差）
- `next_gc_should_be_mixed` / `G1HeapWastePercent`
- `finalize_young_part` / `finalize_old_part`
- `calc_min_old_cset_length` / `calc_max_old_cset_length`
- `order_regions` / `gc_efficiency`

但当前正文仍偏“IHOP 一节 + 预测一节 + 触发一节 + 选择一节”的机制并列。真正该打穿的读者困惑更集中：

**G1 有三个暂停形态（Young-only / Mixed / Full），但应用只给定了一条硬约束：每次暂停别超过目标毫秒。G1 凭什么同时保证“不超时”又不让堆塞爆？什么时候标记、什么时候 Mixed、一个暂停收哪几个 Region，这三件事是不是彼此独立的三套规则？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**G1 的策略层没有三套独立规则，只有一条主线：把“历史样本 → 时间预测 → 时间预算”这条管道复用于三个决定。需要做标记时，IHOP 用“标记期间预计分配量”反推出启动阈值；决定是否 Mixed 时，用“剩余可回收空间占比 > G1HeapWastePercent”判断继续收是否划算；真正挑 Region 时，先在预算内塞满必须收的 Young，再用剩下的时间预算按 `gc_efficiency`（可回收字节 / 预测耗时）贪婪地挑 Old Region，并受 min/max 双重约束兜底。**

## 3. 总图

```text
外部约束: MaxGCPauseMillis (暂停目标)

IHOP (何时标记)
  adaptive: threshold = actual_target_threshold
            - predicted_promotion_bytes(标记时长 x 晋升速率)
            - last_unrestrained_young_size

时间预测 (G1Predictions)
  get_new_prediction = davg + sigma * stddev_estimate

Mixed 判定 (next_gc_should_be_mixed)
  候选非空 && 剩余可回收占比 > G1HeapWastePercent(5)

CSet 选择 (finalize_collection_set)
  finalize_young_part: 预算 = target - base_time - young_cost
  finalize_old_part:
    min = candidates / G1MixedGCCountTarget(8)
    max = num_regions x G1OldCSetRegionThresholdPercent(10)
    while (peek 非空 && 未达 max && 可回收占比 > 5%):
      predicted = predict_region_elapsed_time_ms(hr)
      若超预算且已 >= min -> break
      time_remaining -= predicted; add_old_region(hr)
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——一条暂停目标，三件不同的事

目标约 1100 字。

- 从 MaxGCPauseMillis 是 G1 唯一的外部硬约束切入
- 点出 G1 必须回答三个问题：何时标记、何时 Mixed、收哪几个 Region
- 埋主线：三件事共用“历史 → 预测 → 预算”的同一根管道

### 第二节：两个朴素理解为什么都不对

目标约 1600 字。

必须推演：
1. 等老年代快满才启动并发标记（标记慢于分配，堆塞爆 → Full GC）
2. 每次暂停都尽量多收老年代 Region（单次暂停超时）

结论：
- 标记必须提前，且提前量由“标记期间还会分配多少”决定
- 单次回收收益受暂停预算约束，必须给收益排序而不是来者不拒

### 第三节：IHOP——为什么启动阈值是“安全线减预计分配量”

目标约 2100 字。

- `G1StaticIHOPControl`: `_initial_ihop_percent * _target_occupancy / 100`（g1IHOPControl.hpp:94-97）
- `G1AdaptiveIHOPControl` 成员与两个 TruncatedSeq（g1IHOPControl.hpp:109-125）
- `get_conc_mark_start_threshold` 真实公式（g1IHOPControl.cpp:123-139）：
  - 预测晋升量 = 预测标记时长 × 预测晋升速率
  - 加上最近无约束 young 大小（标记期间 young 还会继续长）
  - 从 actual_target_threshold（扣掉 reserve + waste 后的安全线）里减掉
- `update_allocation_info` / `update_marking_length` 何时喂样本（g1IHOPControl.cpp:152,160）
- 说明：阈值低说明“标记期间预计涨得多，得提前”；高说明“分配平稳，可以晚点标记”

### 第四节：G1Predictions——暂停预算从哪来

目标约 1600 字。

- `G1Predictions::get_new_prediction = davg + sigma * stddev_estimate`（g1Predictions.hpp:57-59）
- `stddev_estimate` 小样本时用均值缩放（g1Predictions.hpp:41-48）
- `G1Analytics` 把预测包装成 cost_per_card / cost_per_byte 等（g1Analytics.cpp:222-306）
- 收回“预测给暂停预算留安全余量”主线

### 第五节：Mixed 判定——为什么标记完不是连续做一长串

目标约 1800 字。

- `record_concurrent_mark_cleanup_end` 先 `rebuild` 再问是否 mixed（g1Policy.cpp:987-994）
- `next_gc_should_be_mixed` 两门槛：候选非空 + 剩余可回收占比 > G1HeapWastePercent（g1Policy.cpp:1084-1103）
- 候选来源：`rebuild` 用 `region_occupancy_low_enough_for_evac` / 非 pinned / RSet complete 过滤（collectionSetChooser.cpp:285-287）
- Mixed 中的继续判定：每次 pause 结束再问一次（g1Policy.cpp:611-620）
- 说明“Mixed 阶段自然结束”的机制

### 第六节：CSet 选择——先扣固定的，再按收益排可选的

目标约 2400 字。

- `finalize_collection_set` 两步（g1Policy.cpp:1143-1146）
- `finalize_young_part`: base time → 预算 ← 目标 − base − young_cost（g1CollectionSet.cpp:356-398）
- `finalize_old_part` 停止条件完整列：max 上限、waste 占比、预测超预算且过 min、非自适应到 min 即止（g1CollectionSet.cpp:410-498）
- `calc_min_old_cset_length` / `calc_max_old_cset_length`（g1Policy.cpp:1105-1141）
- `order_regions` 按 gc_efficiency 降序（collectionSetChooser.cpp:41-61）
- gc_efficiency = reclaimable / predicted_elapsed（heapRegion.cpp:142-154）

### 第七节：误解澄清与收网

目标约 1300 字。

至少回答：
1. 标记完是否一定进入一长串连续 Mixed
2. IHOP 是否就是固定 45%
3. 预测是否只用于暂停目标，不参与 IHOP
4. gc_efficiency 是否是单纯的 liveness
5. 单次 Mixed 是否收得越多越好
6. clean 阶段“可回收比例过低”是谁在判断

## 5. 失败方案必须写进正文

1. 等老年代近满才标记，指望标记追得上分配
2. 每次暂停把剩余老年代 Region 尽量多收以图“尽早清理干净”
3. 把 IHOP、暂停预测、CSet 选择当成三套互不相干的规则

## 6. 证据清单

- `src/hotspot/share/gc/g1/g1IHOPControl.hpp:85-97`：`G1StaticIHOPControl::get_conc_mark_start_threshold`
- `src/hotspot/share/gc/g1/g1IHOPControl.hpp:109-125`：`G1AdaptiveIHOPControl` 成员
- `src/hotspot/share/gc/g1/g1IHOPControl.cpp:123-139`：自适应启动阈值真实公式
- `src/hotspot/share/gc/g1/g1IHOPControl.cpp:152-160`：`update_allocation_info` / `update_marking_length`
- `src/hotspot/share/gc/g1/g1Predictions.hpp:41-59`：`stddev_estimate` / `get_new_prediction`
- `src/hotspot/share/gc/g1/g1Analytics.cpp:222-306`：cost 预测包装
- `src/hotspot/share/gc/g1/g1Policy.cpp:536-551`：`need_to_start_conc_mark`
- `src/hotspot/share/gc/g1/g1Policy.cpp:987-994`：`record_concurrent_mark_cleanup_end`
- `src/hotspot/share/gc/g1/g1Policy.cpp:611-620`：Mixed 中继续判定
- `src/hotspot/share/gc/g1/g1Policy.cpp:1084-1103`：`next_gc_should_be_mixed`
- `src/hotspot/share/gc/g1/g1Policy.cpp:1105-1141`：`calc_min_old_cset_length` / `calc_max_old_cset_length`
- `src/hotspot/share/gc/g1/g1Policy.cpp:1143-1146`：`finalize_collection_set`
- `src/hotspot/share/gc/g1/g1CollectionSet.cpp:356-398`：`finalize_young_part`
- `src/hotspot/share/gc/g1/g1CollectionSet.cpp:410-498`：`finalize_old_part`
- `src/hotspot/share/gc/g1/collectionSetChooser.cpp:41-61`：`order_regions`
- `src/hotspot/share/gc/g1/collectionSetChooser.cpp:285-287`：候选过滤条件
- `src/hotspot/share/gc/g1/collectionSetChooser.cpp:290-302`：`rebuild`
- `src/hotspot/share/gc/g1/collectionSetChooser.hpp:104-105`：`mixed_gc_live_threshold_bytes`
- `src/hotspot/share/gc/g1/heapRegion.cpp:142-154`：`calc_gc_efficiency`
- `src/hotspot/share/gc/g1/g1_globals.hpp:235-267`：`G1MixedGCLiveThresholdPercent` / `G1HeapWastePercent` / `G1MixedGCCountTarget` / `G1OldCSetRegionThresholdPercent`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
- 本篇聚焦策略层（IHOP / 预测 / CSet 选择），不展开 SATB、RSet、分配细节
- 不细讲 Full GC 内部（fallback 只点边界）
- 不展开 ref processing / class unloading 的 pause 成本分解
- 下一篇若讲写屏障，应自然承接“为什么 G1 的 barrier 是‘最重’的”
- 预留：eager reclaim humongous 只在需要处点边界

## 8. 完成后 review

- 删除代码后，能否复述“一条暂停目标 → 时间预算 → 三个决策共用一个预测管道”
- 是否讲清自适应 IHOP 是“安全线减标记期间预计分配量”而不是简单百分比
- 是否能复述 Mixed 判定门槛（候选非空 + 可回收占比 > G1HeapWastePercent）
- 是否讲清 young 必收、old 按 gc_efficiency 在预算内选、min/max 双重约束
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验