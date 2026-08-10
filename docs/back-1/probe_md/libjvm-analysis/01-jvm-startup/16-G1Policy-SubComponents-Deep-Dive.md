# G1Policy + GC 子组件 — 31 字段决策引擎 + 8 辅助结构

> OpenJDK 11 slowdebug, GDB 验证
> G1Policy(552B, 31字段) + G1RemSet(120B) + CardTable(136B/16MB外部) + BarrierSet(64B) + Allocator(224B) + CollectionSet(128B) + BOT(32B) + CMBitMap(56B) + RootRegions(24B)

---

## 零、GDB 验证

```
G1Policy = 552 | G1RemSet = 120 | CardTable = 136 | BarrierSet = 64
Allocator = 224 | CollectionSet = 128 | BOT = 32 | CMBitMap = 56 | RootRegions = 24
ParallelGCThreads = 8 | ConcGCThreads = 2 | num_regions = 2048
```

---

## 一、G1Policy (552B, 31 字段) — GC 决策的大脑

不是简单的配置对象，而是 GC 的**预测-决策-跟踪**引擎。31 个字段分为 6 组：

### 1.1 预测与分析 (5 字段) — "下一个 GC 会多快完成？"

| 字段 | 类型 | 作用 |
|------|------|------|
| `_predictor` | G1Predictions | 基于历史数据的暂停时间预测器 |
| `_analytics` | G1Analytics* | 统计分析：平均暂停时间、标准差 |
| `_remset_tracker` | G1RemSetTrackingPolicy | RSet 更新频率 → 决定粗化策略 |
| `_mmu_tracker` | G1MMUTracker* | 最大暂停时间跟踪（-XX:MaxGCPauseMillis） |
| `_old_gen_alloc_tracker` | G1OldGenAllocationTracker | GC 间老年代分配速度 |

### 1.2 IHOP 与阈值 (1 字段) — "什么时候开始并发标记？"

| 字段 | 类型 | 作用 |
|------|------|------|
| `_ihop_control` | G1IHOPControl* | **Initiating Heap Occupancy Percent** — 自适应阈值 |

**为什么 IHOP 要自适应？** → 固定阈值（如 45%）对慢分配应用太晚、对快分配应用太早。IHOP 根据历史分配速度动态调整：分配快→降低阈值提前标记，分配慢→提高阈推迟标记。

### 1.3 年轻代控制 (6 字段) — "Eden 要多大？"

| 字段 | 类型 | 作用 |
|------|------|------|
| `_young_list_target_length` | uint | 目标年轻代 Region 数 |
| `_young_list_fixed_length` | uint | 固定年轻代长度 |
| `_young_list_max_length` | uint | Eden 最大扩展 Region 数 |
| `_young_gen_sizer` | G1YoungGenSizer | 年轻代自适应大小 |
| `_short_lived_surv_rate_group` | SurvRateGroup* | 短命对象存活率 |
| `_survivor_surv_rate_group` | SurvRateGroup* | Survivor 存活率 |

### 1.4 存活率与晋升 (3 字段) — "对象什么时候进老年代？"

| 字段 | 类型 | 作用 |
|------|------|------|
| `_tenuring_threshold` | uint | 晋升阈值（0~15），自适应调整 |
| `_max_survivor_regions` | uint | Survivor Region 上限 |
| `_survivors_age_table` | AgeTable | 每个年龄段的存活对象大小 |

### 1.5 GC 效率与统计 (10 字段) — "这次 GC 干得好吗？"

| 字段 | 类型 | 作用 |
|------|------|------|
| `_bytes_copied_during_gc` | size_t | 本次 GC 复制字节数 |
| `_free_regions_at_end_of_collection` | uint | GC 后空闲 Region 数 |
| `_max_rs_lengths` | size_t | RSet 最大长度 |
| `_rs_lengths_prediction` | size_t | RSet 长度预测→回收成本估算 |
| `_pending_cards` | size_t | 待处理脏卡数 |
| `_mark_remark_start_sec` | double | Remark 开始时间 |
| `_mark_cleanup_start_sec` | double | Cleanup 开始时间 |
| `_initial_mark_to_mixed` | G1InitialMarkToMixedTimeTracker | 从 Initial Mark 到 Mixed GC 的时间 |
| `_phase_times` | G1GCPhaseTimes* | 各阶段详细耗时 |
| `_policy_counters` | GCPolicyCounters* | 策略计数器（jstat 可见） |

### 1.6 引用与保留 (6 字段)

| 字段 | 类型 | 作用 |
|------|------|------|
| `_collection_set` | G1CollectionSet* | Collection Set 引用 |
| `_g1h` | G1CollectedHeap* | 堆回指 |
| `_full_collection_start_sec` | double | Full GC 开始时间 |
| `_collection_pause_end_millis` | jlong | 上次暂停结束时间 |
| `_reserve_factor` | double | 保留因子 |
| `_reserve_regions` | uint | 保留 Region 数 |

---

## 二、G1RemSet (120B) — 记忆集协调器

```
RSet 的核心问题：GC 回收 Region A 时，需要知道"哪些 Region 引用了 A 中的对象"
→ 没有 RSet → 每次 GC 扫描整个堆找跨 Region 引用（不可接受）
→ 有 RSet → 只扫描 RSet 指向 A 的 Region

120B = 协调器对象（CardTable 引用 + HotCardCache 引用 + 统计信息）
真正的 RSet 存储在各 HeapRegion._rem_set 中（HeapRegionRemSet, per-Region）
```

---

## 三、CardTable (136B 管理者 + 16MB 存储) — 写屏障的目标

```
为什么是 512 字节/卡？
  → 对象平均大小约几百字节。512B 保证每次记录覆盖 2-5 个对象——粒度刚好。
  → 太小：CardTable 膨胀（8GB/64B=128MB）
  → 太大：一次写标记太多无用区域（4KB=大量误扫描）

CardTable 映射：
  card_index = (addr - heap_base) >> 9  // /512， >>9 是编译器优化
  card_table[card_index] = dirty_byte   // 写屏障内联代码就是一条 mov
```

---

## 四、G1BarrierSet (64B) — 两大屏障入口

| 屏障 | 触发时机 | 做什么 |
|------|---------|--------|
| 写前屏障 pre_write_barrier | 引用被覆盖前 | 记录旧值到 SATB 队列（并发标记不漏标） |
| 写后屏障 post_write_barrier | 引用被覆盖后 | 标记对应 Card 为脏 |

---

## 五、G1Allocator (224B) — 对象分配三种路径

| 路径 | 速度 | 场景 |
|------|------|------|
| TLAB 分配 | 极快（bump-the-pointer） | 对象 < TLAB 剩余空间 |
| Region 慢速分配 | 慢（需 CAS 竞争） | TLAB refill / 对象太大不适合 TLAB |
| Humongous 分配 | 最慢（跨 Region） | 对象 > Region/2 |

---

## 六、G1CollectionSet (128B) — 回收集

```
GC 前 G1Policy 选择回收哪些 Region：
  Young GC: 全部 Eden + Survivor
  Mixed GC: 全部 Eden + Survivor + 选定的 Old Region（按 gc_efficiency 排序）

CollectionSet 存储选定的 Region 索引列表（最多 2048 个）
每个条目：Region 索引 + 回收原因
```

---

## 📋 生产场景对应

| 事故 | 涉及结构 | 排查章节 |
|------|---------|---------|
| Mixed GC 频率过高/过低 | G1Policy::_ihop_control | §1.2 IHOP 与阈值 |
| Eden 大小不合理 | G1Policy::_young_list_target_length | §1.3 年轻代控制 |
| 对象过早晋升到老年代 | G1Policy::_tenuring_threshold | §1.4 存活率与晋升 |
| RSet 膨胀导致 GC 慢 | G1RemSet / CardTable | §二 + §三 |
| CSet 选择不优 (回收效率低) | G1CollectionSet::gc_efficiency | §六 |

## 📋 面试必问

> **"G1Policy 如何决定 Mixed GC 的 CSet 大小？" → §1.5, §六**

> 按 `gc_efficiency` 对候选 Old Region 排序（gc_efficiency = 可回收字节 / 预计回收耗时），从高到低选择，直到累积预计耗时接近 `MaxGCPauseMillis` 目标。

> **"IHOP 为什么自适应而不是固定阈值？" → §1.2**

> 固定 45% 对慢分配应用太晚（堆满才开始标记 → 标记赶不上分配 → Full GC），对快分配应用太早（频繁启动标记 → CPU 浪费）。IHOP 根据 `_old_gen_alloc_tracker` 的历史分配速度动态调整。**



| 结构 | sizeof | 本质 |
|------|--------|------|
| BOT | 32B 壳, 16MB 外部 | 任意地址→所属对象 O(1) 定位 |
| CMBitMap | 56B 壳, 128MB 外部 | 并发标记位图 |
| RootRegions | 24B | Survivor 根区域列表 |
