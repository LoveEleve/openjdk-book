# PROMPT: 请撰写 09-FullGC.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**G1 Full GC — 保底回收机制的全栈走读：触发链、四阶段 Mark-Prepare-Adjust-Compact、markOop 转发指针、PreservedMarks 偏向锁恢复、碎片消除 + fallback 全景**

### 核心故事线（禁止做源码翻译机！）

你已经读了 03（Young GC Evacuation 四阶段）、06+07（并发标记 + CM Phase 详解）、08（Mixed GC 策略引擎）。现在面临 G1 的**最后保底**：当 Young GC 和 Mixed GC 都无法满足分配请求时（Evacuation Failure 累积、Humongous 分配风暴），G1 回退到 Full GC —— 全堆 STW、单次标记、滑动压缩。

**和 03/06/07/08 的对比是本文的灵魂**：

| 对比维度 | Young GC (03) | Concurrent Mark (06) | Full GC (本文) |
|---------|:---:|:---:|:---:|
| 并发度 | STW (short) | Concurrent + STW | STW (全堆一次性) |
| 依赖 RSet？| ✅ 需要 | ❌ 不需要 | ❌ **不需要** ← 为什么？ |
| 依赖 SATB？| ❌ 不需要 | ✅ 需要 | ❌ **不需要** ← 为什么？ |
| 依赖 TAMS？| ❌ 不需要 | ✅ 双 TAMS | ❌ **不需要** ← 为什么？ |
| 存活判定 | RSet扫描+复制 | bitmap标记 | 全堆递归标记（复用 CM next_bitmap，无并发→无需双缓冲） |
| 回收方式 | Evacuate (复制) | — | 滑动压缩（在原有 Region 内或跨 Region 移动） |
| 转发指针 | CAS (markOop) | — | markOop 直接写（**为什么不需要 CAS？**） |
| 碎片处理 | 无 (Eden 全清) | 无 | ✅ 消除碎片 |

**★ 全文核心叙事线**：

```
attempt_allocation() 失败 → Expansion 尝试 → 仍不足
    → VM_G1CollectForAllocation → Young/Mixed GC → 仍不足
      → do_full_collection(true)                    ← 内联"升级"逻辑
        → GCLocker::check_active_before_gc() 检查
        → collector.prepare_collection()     ← 终止 CM、flush logs、abort refinement
        → collector.collect()               ← 4 阶段 MPAC
        → collector.complete_collection()   ← restore_marks、rebuild free_list
    ↓
┌──────────────────────────────────────────────────────────────────────┐
│ G1FullCollector::collect() — StackObj，4 阶段调度                     │
│                                                                      │
│ prepare_collection(): 终止 CM + abort refinement + 前置验证            │
│                                                                      │
│ Phase 1 Mark: 并行全堆标记（无并发mutator→无SATB→工作队列替代MarkStack）│
│   输入: 所有 GC Roots（线程栈/JNI/CodeCache/类/j.l.ref）+ ReferenceProcessor
│   输出: 全堆 live mark（复用 CM 的 _next_bitmap）+ Reference discovered list
│                                                                      │
│ Phase 2 Prepare: forward() 设置转发指针 + clear RSet                   │
│   ★★★ 核心技术: markOop::encode_pointer_as_mark(x) — 复用对象头        │
│   ★★★ 为什么不需要 CAS？→ 全 STW，Phase 2 workers 各自处理互不重叠的 Region│
│   不释放对象，只"标记要被移动到哪里"                                     │
│                                                                      │
│ Phase 3 Adjust: 修正所有引用 → 新地址                                  │
│   ★★★ 为什么 Phase 2 和 Phase 3 必须分开？                            │
│     → Referrer 可能被 Compact 到 Referent 之前的位置                    │
│     → 必须先知道所有对象的最终位置，再统一修正所有引用                    │
│   三类修正: GC Roots（所有root类型） + oop fields + CodeCache nmethod   │
│   含 DerivedPointerTable::update_pointers() — JIT 内嵌指针修正          │
│                                                                      │
│ Phase 4 Compact: 并行 memcpy → 新位置                                  │
│   ★★★ 为什么用 aligned_conjoint_words 而不是 memcpy？                 │
│     → 滑动压缩中源和目标可能重叠 → conjoint (可正向/反向处理重叠)        │
│   ★★★ 为什么需要 serial_compaction_point 做兜底？                      │
│     → 并行分配 Region 间的 compaction target 可能碎片化                 │
│                                                                      │
│ Complete: restore_marks() — 从 PreservedMarks 恢复偏向锁               │
│   ★★★ 为什么要 preserved marks？                                      │
│     → Phase 2 forward() 覆写 oop mark word 为转发指针                   │
│     → 偏向锁位被"污染" → Complete 阶段必须恢复                          │
│   + update_derived_pointers() — Phase 3 修正后的最后一步                │
│   + resize_if_necessary_after_full_collection() — 根据 Min/MaxHeapFreeRatio 扩缩容 │
└──────────────────────────────────────────────────────────────────────┘
    ↓
回到 Young GC 模式（G1Policy 重置所有状态机标志）
```

---

### 核心叙事线（16 个"为什么"问题，每个必须有源码回答）

**❓ 触发链：什么时候到 Full GC？**

1. **❓ 为什么 Young GC 和 Mixed GC 会"搞不定"？Evacuation Failure 怎么积累？**

   **子问题**：
   (a) Young GC Phase 2 Evacuate → `copy_to_survivor_space` 中 PLAB 分配失败 → 换 PLAB → 换 Region → Evacuation Failure
   (b) ★ 两个层面的 `_evacuation_failed` 标志：`HeapRegion::_evacuation_failed`（per-Region）vs `G1CollectedHeap::_evacuation_failed`（全局）— 各在哪用、怎么判定不再重试？
   (c) ★ Evacuation Failure 后，Region 变为 `RETAINED`（type 仍是 Old/Survivor 但 `_evacuation_failed=true`）→ 这些 Region 不能被 Mixed GC CSet 回收
   (d) ★ 累积的 Evac Failure Region → Old Gen 碎片化 → 大对象（Humongous ≥ 2MB）无连续 Region 可分配 → 进入 `VM_G1CollectForAllocation`
   (e) `G1ReservePercent`（默认 10%）的预留空间全部耗尽 → 扩容也失败 → Full GC inevitable

2. **❓ `satisfy_failed_allocation()` 的精确触发链是什么？怎么从 Young/Mixed GC 升级到 Full GC？**

   **子问题**：
   (a) `attempt_allocation()` 失败 → `VM_G1CollectForAllocation::doit()` → `do_collection_pause()` Young GC → `attempt_allocation()` 重试 → 仍 NULL → `do_full_collection()` 升级（`vm_operations_g1.cpp:154`）
   (b) ★ 关键代码：`if (g1h->do_collection_pause(...) && _result == NULL)` → `g1h->do_full_collection(false, true)` — 这不是独立函数，是 `VM_G1CollectForAllocation::doit()` 中的内联升级逻辑
   (c) ★ GCLocker 的 `check_active_before_gc()` 检查 — `do_full_collection()` 第一行就检查 JNI 临界区是否活跃 → 活跃则直接返回 false
   (d) ★ `VM_G1CollectFull` safepoint 协议 — `VM_G1CollectForAllocation`（Young/Mixed GC）失败后，有时会调度一个独立的 Full GC VM operation

3. **❓ Full GC 的 fallback 链：attempt_allocation → Expansion → YoungGC → MixedGC → FullGC×N → OOM 每一步的边界是什么？**

   **要求**：画一条 Mermaid 决策树，标注每一步的条件和退出/升级路径。必须包含 `satisfy_failed_allocation_helper()` 的 `do_gc` 参数重试逻辑。**注意: JDK 11 没有显式的 "Full GC × N 重试循环"——重试由上层 `attempt_allocation_slow` 的循环控制。验证 Full GC 后如果 `_pause_succeeded=true` 但 allocation 仍失败会怎样。**

**❓ Phase 1 Mark：全堆标记**

4. **❓ 为什么 Full GC 的标记不需要 SATB？为什么不需要 TAMS？为什么只要一 pass？**

   **子问题**：
   (a) ★ 无并发 mutator → 没有"标记期间的对象修改" → 不需要 SATB 快照 → 可以精确标记
   (b) ★ 无并发 mutator → 没有"标记后分配的对象" → 不需要 TAMS 双缓冲 → bitmap 一次性即可
   (c) `G1FullGCMarkTask`：N workers 并行遍历全堆 Region → `G1FullGCMarker::mark_object()` → 递归标记 — 但这不是 do_marking_step！没有时间片、没有 finger claim、没有 task_queue steal
   (d) ★ `G1FullGCMarker::follow_object()` 的标记栈（`_oop_stack` + `_objarray_stack`）vs 06 的 MarkStack + CMTask 的复杂度对比
   (e) ★ 简述 `G1FullGCReferenceProcessorExecutor` — 标记阶段附带 Reference discovery（→ [11-Ref §X] 深挖）
   (f) `mark_bitmap()` 返回的是 `_next_mark_bitmap()`（复用 CM 的 next bitmap）——为什么用这个 bitmap？

5. **❓ `G1FullGCMarker::preserved_stack` 是什么？Phase 1 怎么 capture bias locks？**

   **子问题**：
   (a) ★ 偏向锁的 markOop 和普通 markOop 的区别（低 3 位 = 101 表示 biased）
   (b) ★ Phase 1 标记过程中遇到 biased 对象 → `preserved_stack->push()` → `ChunkedList` 结构保存
   (c) ★ 为什么要在 Phase 1 保存偏向锁？→ Phase 2 forward() 会用 encode_pointer_as_mark() 覆写 markOop → 偏向锁信息丢失 → 需要 Phase 1 先 snapshot

**❓ Phase 2 Prepare：压缩规划**

6. **❓ 为什么 Phase 2 叫"Prepare"而不叫"Forward"？它在准备什么？**

   **子问题**：
   (a) ★ 三任务：`G1FullGCPrepareTask` — ① 计算 forwarding + ② 清空 RSet（`HeapRegion::rem_set()->clear_locked()`）+ ③ 冻结 `DerivedPointerTable`（`deactivate_derived_pointers()`）
   (b) ★ 为什么全堆 GC 后要清空 RSet？→ 对象全被移动 → RSet 全部失效 → 必须重建
   (c) ★ 冻结 `DerivedPointerTable`：Phase 1 激活 → Phase 2 冻结 → Complete 更新 — 为什么必须在这里冻结？→ Phase 2 开始移动对象，JIT nmethod 中的内嵌指针会失效 → 需要先 snapshot 再在 Complete 中统一修正
   (d) 目标地址怎么算？`G1FullGCCompactionPoint::forward()` 中的 bump-pointer：`_compaction_top` 在当前 Region 中 → 满了 → `switch_region()` → 新 Region

7. **❓ markOop 转发指针怎么工作？为什么 Full GC 不需要 CAS 而 Young GC 需要？**

   **子问题**：
   (a) ★ Young GC 的 `forward_to_atomic()` — CAS 是因为多个 GC worker 可能同时尝试转发同一个对象
   (b) ★ Full GC 的 `forward()` — 直接写入，因为：
     - 全堆 STW（无 mutator），并且
     - Phase 2 每个 worker 被分配互不重叠的 Region → 不会有两个 worker 处理同一个对象
   (c) ★ `markOopDesc::encode_pointer_as_mark(p)` — 编码格式：`p | marked_bit | lock_bits` → 解码时 `decode_pointer_from_mark()` 去除标记位
   (d) ★ 为什么不能直接在 markOop 里存地址？→ GC 标记位必须保留（至少 locked = 11 必须保留表示 GC 状态）
   (e) ★ 转发后对象 `is_forwarded()` → `is_marked()` 判定 — 读 markOop 的低位检查

8. **❓ `G1FullGCCompactionPoint` 的生命周期和内部状态？**

   **子问题**：
   (a) ★ 每个 GC worker 一个 `G1FullGCCompactionPoint` → `_current_region`（当前分配目标）+ `_compaction_top`（bump pointer）+ `_compaction_regions`（已分配的 Region 列表）
   (b) ★ `forward(oop, size)` → bump pointer 在当前 Region 中分配 → 满了 → `switch_region()` → 新 Region
   (c) ★ `merge(G1FullGCCompactionPoint* other)` — 串行合并多个 CompactionPoint（`serial_compaction_point` 需要）
   (d) ★ `_compaction_points[i]`（并行版，每 worker 一个）vs `_serial_compaction_point`（兜底版）— 为什么需要两个概念？→ 并行版各 worker 独立分配 Region 间的 compaction target，最后可能有碎片 → serially merge → 统一处理

**❓ Phase 3 Adjust：修正引用**

9. **❓ 为什么 Phase 2（Prepare=写转发指针）和 Phase 3（Adjust=读转发指针修正引用）必须分开两个 phase？**

   **子问题**：
   (a) ★ 核心原因：**在 Phase 2 期间，Referrer 的对象也可能被转发** →
     如果边转发边修正，Referrer 的 final destination 未知 → 修正到错误地址
   (b) ★ 时序要求：Phase 2 所有对象都有 `is_forwarded()` → Phase 3 所有引用统一修正
   (c) ★ 三类修正：
     - GC Roots → `G1FullGCAdjustTask` 扫描所有 root（线程栈/JNI/CodeCache/类）
     - oop fields → `adjust_object(oop)` → 遍历 oop 的所有引用字段 → `decode_pointer_from_mark()` 取值
     - CodeCache nmethods → `DerivedPointerTable::update_pointers()` — 修正 JIT 内嵌对象指针

10. **❓ `G1FullGCAdjustTask` 怎么并行修正？每个 worker 负责什么范围？**

    **子问题**：
    (a) ★ `G1FullGCAdjustTask::work()` → `adjust_roots()` → `G1RootProcessor` 遍历所有 root 类型
    (b) ★ `G1AdjustClosure::do_oop(oop*)` → 读 oop → `is_forwarded()` → `forwardee()` → 写新地址
    (c) ★ 为什么 Adjust 也需要 fix 对象间的 oop fields？→ 因为 Phase 2 只写了 forwarding 但没改 referrer 的字段

**❓ Phase 4 Compact：滑动压缩**

11. **❓ `aligned_conjoint_words()` 怎么处理源和目标重叠？**

    **子问题**：
    (a) ★ `conjoint` vs `disjoint`：disjoint = 源和目标不重叠 → 用 `memcpy`；conjoint = 可能重叠 → 源 < 目标时从后往前 copy，源 > 目标时从前往后 copy
    (b) ★ 为什么 Full GC 会有重叠？→ 滑动压缩在同一个 Region 内向前 compact → 源和目标在同一个 Region → 可能重叠
    (c) ★ `G1FullGCCompactTask` 的 `compact_region(HeapRegion*)` — 每个 worker 并行 compact 各自的 Region

12. **❓ 为什么需要 `serial_compaction_point` 兜底？什么情况下并行 compact 会失败？**

    **子问题**：
    (a) ★ 并行 compact 时，每个 worker 处理一组 Region → 但最后一个 Region 可能有碎片 → worker 间竞争 → 退化为串行
    (b) ★ `G1FullGCCompactTask` 的 `work()` 流程：先并行 → 再 `serial_compaction()` 处理剩余
    (c) ★ `serial_compaction_point` 怎么初始化？→ `merge()` 所有 worker 的 CompactionPoint → 统一分配

**❓ Complete：恢复状态**

13. **❓ `restore_marks()` 怎么从 PreservedMarks 恢复偏向锁？**

    **子问题**：
    (a) ★ `PreservedMarks::restore()` → 遍历 `ChunkedList<OopAndMarkOop>` → 对每个 (obj, mark) → `obj->set_mark(mark)` → 恢复偏向锁的 markOop
    (b) ★ `OopAndMarkOop` 结构：存储原始对象的 oop + 原始 markOop
    (c) ★ 恢复时机：Phase 4 之后 → 对象已被移动到新位置 → 在 Complete 阶段恢复 mark word
    (d) ★ 如果不恢复 → 偏向锁状态丢失 → 下次访问时的偏向锁重偏向不必要 → 性能回退

14. **❓ Full GC 后 G1Policy 的状态机怎么重置？为什么 Full GC 是"毁灭性"的重置？**

   **子问题**：
   (a) `g1Policy.cpp:record_full_collection_end()`: `set_in_young_only_phase(true)` + `set_in_young_gc_before_mixed(false)` + `set_mark_or_rebuild_in_progress(false)` + `clear_collection_set_candidates()`
   (b) ★ Full GC 后：RSet 被清空 → 必须重新 accumulation → 需要 time_to_build → Young-only GC 先跑
   (c) ★ `_short_lived_surv_rate_group->start_adding_regions()` — SurvRateGroup 重置（Full GC 后 age 数据不可信）
   (d) ★ Free list 重建（Compact 后 freed Region 重新进入 `_free_list`）
   (e) ★ `resize_if_necessary_after_full_collection()` — Full GC 独有的堆扩缩容（`MinHeapFreeRatio`/`MaxHeapFreeRatio`），Young GC 后没有对应逻辑

15. **❓ 为什么 `G1FullCollector` 是 `StackObj`？这反映了 Full GC 的什么特性？**

   **子问题**：
   (a) ★ `G1FullCollector` 在 `do_full_collection()` 的栈上构造（`g1CollectedHeap.cpp:1184`）→ GC 完成后自动析构释放所有资源
   (b) ★ 这反映了 Full GC 的两个本质特性：① 全 STW 同步执行——不像 CM 在后台线程跑；② 与调用者生命周期绑定——不需要堆上持久对象
   (c) ★ 对比：G1Policy、G1Analytics、G1IHOPControl 都是 `CHeapObj`——因为它们生命周期跨越多次 GC
   (d) ★ 析构时释放了什么？→ `_markers[]`、`_compaction_points[]`、`_oop_queue_set` 等

**❓ 面试层**

16. **❓ G1 Full GC 和 Parallel GC / Serial GC 的 Full GC 有什么不同？为什么 G1 的 Full GC 叫"保底"？**

    **要求**：
    - Parallel GC：最传统的 Mark-Compact（标记→计算target→修正→移动）
    - Serial GC：单线程 Mark-Compact
    - G1 Full GC：4 阶段 Mark-Prepare-Adjust-Compact，并行（除了 serial compaction point）
    - G1 希望尽量不触发 Full GC → Young GC + Mixed GC 组合拳 → Full GC 是最后保底

---

### 禁止行为

- ❌ 把 03 的 Evacuation 机制再讲一遍 — 只在"为什么 Full GC 不需要 CAS 而 Young GC 需要"中对比，不重述
- ❌ 把 06 的 do_marking_step 重述 — 只在"为什么 Full GC 标记更简单"中对比，不重述
- ❌ 把 04 的 RSet 三级结构重述 — 只说"Phase 2 清空 RSet，因为对象全移动"
- ❌ 把 11 的 Reference Processing 展开 — 只说"简述 `G1FullGCReferenceProcessorExecutor`，深挖在 11"
- ❌ 只说"Phase 4 做 compact" — **必须回答：conjoint words 为什么、serial compaction point 为什么**
- ❌ 只说"preserved marks 恢复偏向锁" — **必须回答：Phase 1 怎么 capture、Phase 4 Complete 怎么 restore、数据结构是什么**
- ❌ 把 Full GC 讲成孤立模块 — **全文必须在每阶段和 03/06/07/08 做精确对比**

### 要求行为

- ✅ **★ 每节以"❓ 为什么..."开头**
- ✅ **★ 全文核心叙事线**：触发链（Evac Failure → SATB → Full GC）→ 4 阶段（MPAC）→ Complete（marks 恢复 + RSet 重建）→ 回到 Young GC
- ✅ **★ 每条差异都是"为什么"的答案**：
  - 为什么不需要 RSet？→ STW，mutator 在 Phase 1 已经标记完一切
  - 为什么不需要 SATB？→ STW，无并发标记中的 mutator 修改
  - 为什么不需要 TAMS？→ 一次 pass 标记，无标记期间的 allocation
  - 为什么不需要 CAS 转发？→ 可以确保互斥（在 Phase 2 不会有两个 worker 处理同一个对象）
  - 为什么 Phase 2 和 3 必须分开？→ Referrer 的 forwarding 目标待定
- ✅ **★ Mermaid 图 ≥5 张**：
  1. Full GC 触发链决策树（Young GC fail → Mixed fail → Expansion fail → Full GC）
  2. 4 阶段总览序列图（Mark → Prepare → Adjust → Compact → Complete）
  3. Phase 2 forward() 的 forwarding pointer 编码/解码图
  4. Phase 3 Adjust — 三类引用修正（Roots / oop fields / CodeCache nmethods）
  5. Phase 4 Compact — conjoint vs disjoint 对比图
  6. (可选) markOop 转发指针的位布局图
- ✅ **★ GDB 验证 ≥8 条**：
  1. Break on `do_full_collection()` → 观察 prepare → collect → complete 三阶段
  2. Break on `prepare_collection()` → 验证 CM 终止、refinement abort
  3. Break on `G1FullCollector::collect()` → 观察 4 阶段完整时间线
  4. Break on `G1FullGCMarkTask::work()` → 验证 worker 数和标记栈
  5. Break on `G1FullGCPrepareTask::work()` → 验证 forwarding 指针的 markOop 格式
  6. Break on `G1FullGCAdjustTask::work()` → 验证三类 root 修正
  7. Break on `G1FullGCCompactTask::work()` → 验证 conjoint memcpy
  8. Break on `restore_marks()` → 验证 PreservedMarks 的恢复
  9. Break on `record_full_collection_end()` → 验证状态机重置 + resize_if_necessary
  10. Print `G1FullCollector` → sizeof + compaction_points 数组 + StackObj 验证
- ✅ **★ 设计替代分析 ≥4 处**：
  1. 如果 Full GC 用并发标记而不是 STW 全堆标记 → 需要 SATB → 复杂度急剧上升
  2. 如果 forwarding 用单独的表（类似 Parallel GC）而不是复用 markOop → 需要额外 O(N) 内存
  3. 如果 Phase 2 和 3 合并 → Referrer 引用会被修正到临时地址 → 需要多轮修正
  4. 如果 Full GC 不做 compaction 而只 mark-sweep → 碎片加剧 → 后续 Young/Mixed GC 分配大对象失败概率飙升
- ✅ **★ 和 03/06/07/08 的精确对比**：
  - 03 → 本文：Young GC CAS forwarding vs Full GC markOop direct write
  - 06 → 本文：CM do_marking_step 复杂性 vs Full GC 标记简单性
  - 07 → 本文：CM Cleanup RSet rebuild vs Full GC RSet 全量清空
  - 08 → 本文：Young/Mixed GC 的正常路径 vs Full GC 的保底路径

---

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:MaxGCPauseMillis=200`
- 默认 IHOP = 45%（自适应）
- 64 位 Linux x86
- `-XX:ConcGCThreads=2 -XX:ParallelGCThreads=4`
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

---

## 三、聚焦源文件（行号需 grep 验证）

| # | 文件 | 模块 | 核心函数/类 | 本文角色 |
|---|------|------|------------|---------|
| 1 | `g1FullCollector.cpp/.hpp` | gc/g1 | `G1FullCollector::collect()`, `phase1-4_*()`, `restore_marks()`, `complete_collection()` | ★★★ 4 阶段主调度器 |
| 2 | `g1FullGCMarker.cpp/.hpp/.inline.hpp` | gc/g1 | `G1FullGCMarker`, `mark_object()`, `follow_object()`, `_preserved_stack` | ★★★ Phase 1 标记引擎 |
| 3 | `g1FullGCMarkTask.cpp/.hpp` | gc/g1 | `G1FullGCMarkTask::work()` — 并行 GC Roots 扫描 + 标记 | ★★ Phase 1 任务定义 |
| 4 | `g1FullGCPrepareTask.cpp/.hpp` | gc/g1 | `G1FullGCPrepareTask::work()` — forward() + clear RSet | ★★★ Phase 2 核心逻辑 |
| 5 | `g1FullGCCompactionPoint.cpp/.hpp` | gc/g1 | `G1FullGCCompactionPoint`, `forward()`, `add()`, `merge()` | ★★★ Phase 2/4 分配目标 |
| 6 | `g1FullGCOopClosures.cpp/.hpp/.inline.hpp` | gc/g1 | `G1MarkAndPushClosure`, `G1AdjustClosure`, `G1ForwardingClosure` | ★★ 标记/调整/转发闭包 |
| 7 | `g1FullGCAdjustTask.cpp/.hpp` | gc/g1 | `G1FullGCAdjustTask::work()` — 三类引用修正 | ★★ Phase 3 核心逻辑 |
| 8 | `g1FullGCCompactTask.cpp/.hpp` | gc/g1 | `G1FullGCCompactTask::work()` — conjoint memcpy | ★★ Phase 4 核心逻辑 |
| 9 | `g1FullGCReferenceProcessorExecutor.cpp/.hpp` | gc/g1 | Reference discovery during marking | ★ Phase 1 子组件 |
| 10 | `g1FullGCScope.cpp/.hpp` | gc/g1 | `G1FullGCScope` — GC timer + logging | ★ 计时统计 |
| 11 | `g1EvacFailure.cpp/.hpp` | gc/g1 | `G1EvacFailure::handle_evacuation_failure()` | ★★ 触发链起点 |
| 12 | `vm_operations_g1.cpp/.hpp` | gc/g1 | `VM_G1CollectForAllocation::doit()`, `VM_G1CollectFull::doit()` | ★★ 触发链 VM Operation |
| 13 | `g1CollectedHeap.cpp/.hpp` | gc/g1 | `do_full_collection()`, `satisfy_failed_allocation()`, `prepare_heap_for_full_collection()`, `resize_if_necessary_after_full_collection()` | ★★★ 触发调度+准备+收尾 |
| 14 | `preservedMarks.cpp/.hpp/.inline.hpp` | gc/shared/ | `PreservedMarksSet`, `PreservedMarks`, `OopAndMarkOop`, `ChunkedList` | ★★★ Complete 阶段恢复 |

**辅助组件（在对应子节中简述）**：

| 组件 | 归属 | 说明 |
|------|:---:|------|
| `markOopDesc` (oops/markOop.hpp) | 09 §四 | `encode_pointer_as_mark()`, `decode_pointer_from_mark()`, `is_forwarded()` 的位布局 |
| `GCLocker` (gc/shared/gcLocker) | 09 §二 | JNI 临界区阻止 Full GC 的协议 |
| `DerivedPointerTable` (code/) | 09 §四+§七 | Phase 1 激活 → Phase 2 冻结 → Complete 更新：JIT nmethod 内嵌对象指针修正协议 |

---

## 四、文章结构（§〇 ~ §八 + 附录）

```
§〇 源文件清单（14 文件 + 3 辅助组件，标注模块归属 + grep 验证行号）

§一 ★ 全景 — Full GC 的角色和 03/06/07/08 的对比定位
  ❓ G1 为什么还需要 Full GC？Young GC + Mixed GC 不已经解决了吗？
  1.1 Mermaid 1：Full GC 触发链决策树
  1.2 Full GC vs Young/Mixed/CM 的对比矩阵（RSet/SATB/TAMS/CAS forwarding）
  1.3 全文 4 阶段总览 + G1FullCollector(StackObj) 字段

§二 ★★★ 触发链：从 Evacuation Failure 到 Full GC
  ❓ 什么条件会触发全堆GC？
  2.1 Evacuation Failure 的累积效应 → RETAINED Region
  2.2 ★ 扩容 (Expansion) 为什么也失败了？G1ReservePercent 耗尽
  2.3 ★ GCLocker 检查：JNI 临界区必须等 → 为什么？
  2.4 ★ `VM_G1CollectForAllocation::doit()` → `do_collection_pause()` → `_result==NULL` → `do_full_collection()` — 内联升级逻辑完整源码
  2.5 ★ `prepare_collection()` — Full GC 前做了什么？终止 CM、abort refinement、前置验证
  2.6 ★ `do_full_collection()` — G1FullCollector(StackObj) 构造 + prepare → collect → complete

§三 ★★★ Phase 1 Mark：全堆标记
  ❓ 为什么 Full GC 的标记比 CM 简单一个数量级？
  3.1 Mermaid 2：4 阶段执行序列图
  3.2 `G1FullGCMarkTask::work()` — GC Roots 列表 + 递归标记
  3.3 ★ 为什么不需要 SATB？→ 无并发 mutator 标记中的修改
  3.4 ★ 为什么不需要 TAMS？→ 标记期间无新对象分配
  3.5 ★ 为什么不需要 do_marking_step 的 4 段式时间片？
  3.6 `G1FullGCMarker` 的标记栈（`_oop_stack` + `_objarray_stack`）
  3.7 ★ `_preserved_stack` — Phase 1 的偏向锁 snapshot（来源、数据结构、为什么必须此时做）
  3.8 ★ 简述 `G1FullGCReferenceProcessorExecutor` — 标记附带的 reference discovery（深挖 → [11]）

§四 ★★★ Phase 2 Prepare：压缩规划（核心章节）
  ❓ 为什么 Phase 2 叫"Prepare"？它在为 Phase 3 和 4 准备什么？
  4.1 双任务：forward() + clear RSet
  4.2 ★ 为什么直接在 Region 内向前 compact ？目标地址怎么算？
  4.3 ★★★ markOop 转发指针的完整位布局：
     - `encode_pointer_as_mark(p)` = `p | marked_bit | lock_bits`
     - `is_forwarded()` 怎么检查？
     - `forwardee()` 怎么解码？
  4.4 Mermaid 3：forwarding pointer 编码/解码图
  4.5 ★ 为什么不需要 CAS forwarding？→ Young GC CAS vs Full GC direct write 的精确条件
  4.6 ★ G1FullGCCompactionPoint 的生命周期：
     - forward(oop, size) → bump-pointer → switch_region → add(hr) → merge(other)
  4.7 ★ 为什么 Clear RSet？→ 全堆移动 → RSet 全部失效 → 需要全量重建
  4.8 ★ ★ 设计替代：如果 forwarding 用单独表存储（如 Parallel GC）而不是复用 markOop → 内存 + 复杂度

§五 ★★ Phase 3 Adjust：修正所有引用
  ❓ 为什么 Phase 2 和 3 必须分开？
  5.1 Mermaid 4：三类引用修正图
  5.2 ★ 三类引用修正：
     (a) GC Roots → `G1AdjustClosure::do_oop(oop*)` 扫描所有 root 类型
     (b) oop fields → 遍历堆中所有对象的引用字段 → 读 forwarding → 写新地址
     (c) CodeCache nmethods → `DerivedPointerTable::update_pointers()`
  5.3 ★ G1AdjustClosure 工作原理：读 oop → `is_forwarded()` → `forwardee()` → 写新地址
  5.4 ★ 设计替代：如果 Phase 2 和 3 合并 → 有多轮修正 → 为什么不行？

§六 ★★ Phase 4 Compact：滑动压缩
  ❓ conjoint_words 怎么处理重叠？serial_compaction_point 为什么需要？
  6.1 `G1FullGCCompactTask::work()` — 并行 compact
  6.2 Mermaid 5：conjoint vs disjoint memcpy 对比图
  6.3 ★ `aligned_conjoint_words()` — 为什么用 conjoint 而不是 memcpy？
  6.4 ★ `serial_compaction_point` — 为什么需要兜底？
  6.5 `G1FullGCCompactionPoint::remove_last()` — 串行 compactor

§七 ★★ Complete：恢复和重建
  ❓ 为什么必须 restore_marks() 和重建 free_list？
  7.1 ★ `restore_marks()` — PreservedMarksSet::restore() 的完整唤醒
  7.2 ★ `OopAndMarkOop` 数据结构 + `ChunkedList` 存储方式
  7.3 ★ 为什么不恢复 → 偏向锁状态丢失 → 下次各线程重新偏向 → 性能代价
  7.4 ★ `update_derived_pointers()` — Phase 3 修正后 Complete 中最后更新
  7.5 G1Policy::record_full_collection_end() — 状态机全面重置
  7.6 ★ `resize_if_necessary_after_full_collection()` — Min/MaxHeapFreeRatio 驱动堆扩缩容

§八 面试问题合集 ≥12 个
  Q1: G1 的 Full GC 什么时候触发？Evacuation Failure 怎么一步一步走到 Full GC？
  Q2: 为什么 Full GC 不需要 RSet、SATB、TAMS？而 Young/Mixed/CM 分别需要什么？
  Q3: Full GC 的 Phase 2 叫"Prepare"而不是"Forward"——它在准备什么？Phase 4 叫"Compact"而不是"Copy"——compaction 和 evacuation 的本质区别在哪？
  Q4: markOop 转发指针怎么编码和解码？为什么不需要 CAS？
  Q5: Phase 2 和 Phase 3 为什么不能合并？
  Q6: aligned_conjoint_words 怎么处理重叠？和 memcpy 有什么区别？
  Q7: preserved marks 是什么？为什么 Phase 1 要 capture，Complete 要 restore？
  Q8: Full GC 后 G1Policy 状态机发生了什么？
  Q9: Full GC 的 parallel workers 在各阶段怎么分工？
  Q10: G1 Full GC 和其他 GC（Parallel/Serial）的 Full GC 有什么区别？
  Q11: Serial compaction point 的兜底原因是什么？并行 compact 一般在什么情况下会退化？
  Q12: `prepare_collection()` 在 Full GC 前做了什么？为什么需要在 collect() 之前独立这步？

§九 GDB 验证 + 可证伪断言（≥8 条）
  断言 1: Full GC 触发链 — Mermaid 1 决策树
  断言 2: Phase 1 Mark — G1FullGCMarkTask worker 分配
  断言 3: Phase 2 forwarding — markOop encode_pointer_as_mark 格式
  断言 4: Phase 2 CompactionPoint — forward() bump-pointer 分配
  断言 5: Phase 3 Adjust — G1AdjustClosure 三类修正
  断言 6: Phase 4 Compact — conjoint_words 处理重叠
  断言 7: Complete restore_marks — PreservedMarks 恢复
  断言 8: record_full_collection_end — G1Policy 状态机重置

§十 附录：关键 GDB 断点 + GC log 示例
```

---

## 五、交叉引用

| 引用点 | 本文位置 | 目标文档 | 内容简述 |
|--------|---------|---------|---------|
| Evacuation Failure→RETAINED Region | §二 | `[03 §X]` | Young GC Phase 2 Evac 失败处理 |
| Full GC 标记 vs do_marking_step | §三 | `[06 §X]` | CM 标记 4 段式 vs Full GC 一 pass |
| Young GC CAS forwarding | §四 | `[03 §X]` | forward_to_atomic vs static invalidate |
| Full GC RSet Clear | §四 | `[04 §X]` | RSet 三级结构 → 全量清空 |
| CM Cleanup RSet rebuild | §四 | `[07 §X]` | CM 后 RSet 的部分重建 vs Full GC 全清除 |
| Reference Processing | §三 | `[11 §X]` | G1FullGCReferenceProcessorExecutor 简述 |
| G1Policy 状态机重置 | §七 | `[08 §X]` | record_full_collection_end 完整分析 |

---

## 六、写作要求

1. **★ 每节以"❓ 为什么..."开头**
2. **★ 执行视角**：Full GC 是"执行引擎"多于"决策引擎" — 故事线是"它怎么做"而不是"决策什么"
3. **★ 和 03/06/07/08 的对比必须贯穿全文**：每个不需要 RSet/SATB/TAMS/CAS 的地方都对标
4. **★ 设计替代分析 ≥3 处**
5. **★ 可证伪断言 ≥8 条**（含 GDB 命令 + 预期输出）
6. **★ Mermaid 图 ≥5 张**
7. **★ 源文件行号全部 grep 验证后再写**
8. **★ 面试友好**：§八 面试 ≥10 个
9. **★ 和 03/06/07/08/11 的边界**：03 提供 CAS forwarding 对比；06 提供 CM 标记对比；07 提供 RSet 重建对比；08 提供 Policy 状态重置；11 提供 Reference Processing 深挖位置

---

## 七、输出格式

- Markdown 文件，命名为 `09-FullGC.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/06-gc-memory/`
- 元信息头：标准环境 + 源文件清单（14 文件 + 3 辅助，行号 grep 验证）+ 前置依赖（必须已读 03/06/07/08；建议了解 04/01）+ 阅读收益
- 阅读收益强调：读完本文后能回答"G1 Full GC 什么时候触发？4 阶段各自做什么？markOop 怎么同时存储 forwarding pointer 和 GC 状态？为什么不需要 SATB/RSet/CAS？conjoint words 怎么做？preserved marks 怎么保护偏向锁？" — 从触发到 debunk 的 Full GC 全栈剖析
