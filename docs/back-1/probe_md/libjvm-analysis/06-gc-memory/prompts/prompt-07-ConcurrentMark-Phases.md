# PROMPT: 请撰写 07-ConcurrentMark-Phases.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**G1 并发标记的阶段宏观调度 — 从 Initial Mark 到 Cleanup，liveness 数据如何从 bitmap 流转为 Mixed GC 的回收候选**

### 核心故事线（禁止做源码翻译机！）

你已经读了 06（ConcurrentMark-Core：`do_marking_step()` 逐段走读），知道 CM worker 如何通过 10ms 时间片、finger CAS Claim、SATB drain、steal 这套引擎完成并发对象图扫描。本文要回答的是：**`do_marking_step()` 的"完成"不等于并发标记周期的结束——在它之前有 Initial Mark（为什么搭车 Young GC？）、在它之后有 Remark（为什么必须 STW？mutator 在 CM 完成后还在改什么使得 SATB 残留必须处理？）、还有 Cleanup（怎么从 bitmap 里的 bit 算出每个 Old Region 的 `_gc_efficiency`、选出下一轮 Mixed GC 的回收候选？）**

**★ 和 06 的边界**：06 聚焦 G1CMTask 内部的单轮 `do_marking_step()` 执行逻辑——drain 优先级链、finger CAS Claim、时间片控制、steal。本文聚焦跨阶段的宏观调度——Initial Mark 如何"搭车" Young GC 零额外 STW 启动 CM、Remark 为什么必须在 STW 下处理 SATB 残留和引用处理、Cleanup 如何把 bitmap 标记结果转化为 per-Region liveness 数据和 Mixed GC 候选排序。

**★ 和 08 的边界**：本文讲 liveness 数据的**生产端**（bitmap → live_bytes → _gc_efficiency）。08（MixedGC-Policy）讲 liveness 数据的**消费端**（G1Policy 如何用 _gc_efficiency 排序 + IHOP 自适应 + CSet 选策）。本文不展开 G1Policy 的决策算法，只讲到 "Cleanup 完成后 Mixed GC 候选列表已就绪"。

**★ 和 03 的边界**：03 深入讲了 Young GC 的四阶段执行。本文的 Initial Mark 段落会简述 Initial Mark 如何在 Young GC 中"搭车"触发（`set_initiate_conc_mark_if_possible(true)`）、在 Young GC 的 pre/post 回调中插入了 `pre_initial_mark()` 和 `post_initial_mark()` 两个钩子——但本文不重述 Young GC 的四阶段流程。

**❓ 如果 Remark 不 STW，只在并发标记完成后继续并发处理 SATB 残留，会发生什么？**

```
  并发标记的"完成"（所有 workers terminate）≠ 标记的"完整"

  并发标记完成后（所有 workers 的 task_queue + global stack 清空）：
    → 看起来所有活对象都标记完了
    → 但 mutator 在这 ~50-200ms 并发标记期间**一直在运行**！
    → mutator 每条引用写入都调用 pre-barrier → SATB buffer
    → 有些 SATB buffer 在 CM 完成前已满并入队 → 被 drain 了 ✓
    → 有些 SATB buffer 在 CM 完成**之后**才满 → 还在 buffer 里 or _completed_buffers_head 上
    → ★ 这些 buffer 中的 orphan old value 从未被标记线程看到过！
    → 还有 thread-local SATB buffers 中未满的部分 → 也没被处理过
    → 如果不做 STW Remark → 这些 orphan 漏标 → 被错当垃圾回收 → 应用崩溃

  做 STW Remark：
    → stop-the-world → 所有 mutator 线程暂停
    → 检查组处理所有 completed buffers + flush thread-local partial buffers
    → finalize_marking() 再次调用 do_marking_step()（但 serial/wait-free）
    → 所有残余 orphan 处理完毕 → 活对象完整标记
    → 此时 bitmap 结果可信 → swap → Mixed GC 可以安全依赖 prev bitmap
```

**★ 为什么 Initial Mark 能"搭车" Young GC 而零额外 STW？——不是零开销，是**重叠开销**：**

```
  Young GC（STW ~20ms）本身就需要：
    → Evacuation pause 遍历 GC Roots + scan RSet
    → 在这个过程中，如果 G1Policy 判定该启动 CM 了：
      → set_initiate_conc_mark_if_possible(true)
      → 在 Young GC 的 pre-evacuation 中加一小步：pre_initial_mark()
        → reset marking data structures (bitmap etc)
        → 每个 Region note_start_of_marking (设置 nTAMS = top)
      → Young GC 做 Evacuation（本身就要扫 roots！）
      → 在 Young GC 的 post-evacuation 中加一小步：post_initial_mark()
        → 激活 SATB buffer（set_active_all_threads(true)）
        → 激活 reference discovery
    → ★ Initial Mark 的标记 roots 开销和 Young GC 的 GC Roots 扫描是**重叠**的！
    → 不需要单独一个 STW pause 来标记 roots

  如果 Initial Mark 不是"搭车"而是独立 STW：
    → 需要额外的一次 STW pause（~2-5ms）来标记 roots → 多一次应用停顿
    → 在 Initial Mark 暂停中还要做一次 GC Roots 扫描 → 第二次重复扫描
    → ★ 搭车设计：把 CM 启动开销折叠进 Young GC 的必做工作中
```

---

### 完整的故事线

```
CM 周期的四个阶段 + 一个可选阶段 + 一个后台任务 + liveness 数据流：

  ┌─────────────────────────────────────────────────────────────────┐
  │ 阶段 1: Initial Mark（搭车 Young GC，STW ~0ms 额外开销）          │
  │   pre_initial_mark(): 两步 — ① reset() 全局重置标记数据            │
  │     ② NoteStartOfMarkHRClosure per-Region 设置 nTAMS = top       │
  │   Young GC Evacuation (自身做 GC Roots 扫描)                      │
  │   post_initial_mark(): 激活 SATB + ref discovery                 │
  │                                                                   │
  │ 阶段 2: Root Region Scanning（并发，不 STW）                       │
  │   scan_root_regions(): 扫描 Initial Mark 暂停中产生的 Survivor     │
  │                                                                   │
  │ 阶段 3: Concurrent Mark（并发，06 主角）                            │
  │   mark_from_roots() → CM workers → do_marking_step() ← [06]       │
  │                                                                   │
  │ 可选: Preclean（并发，可能不执行）                                   │
  │   preclean() — 提前发现和处理 reference，减少 Remark 工作量          │
  │                                                                   │
  │ 阶段 4: Remark（STW，为什么必须 STW？）                             │
  │   finalize_marking(): STW 下多 worker 并行标记（GC workers）       │
  │   ★ 处理所有 residual SATB buffer（CM 完成后 mutator 还在产生）    │
  │   ★ Reference Processing (Soft/Weak/Phantom/Final)                │
  │   ★ Class Unloading（purge dead classes）                         │
  │   swap_mark_bitmaps() ← [06 §二]                                  │
  │   ★ live_bytes 公式首次计算：                                     │
  │     live_bytes = (top - prev_TAMS) + marked_bytes                  │
  │     = TAMS 以上(implicitly live) + TAMS 以下 bitmap marked         │
  │                                                                   │
  │ ★ overflow restart: 如果 overflow → _restart_for_overflow →        │
  │   run_service() for 循环回到 mark_from_roots() → 再做一轮 CM       │
  │                                                                   │
  │ 阶段 5: Cleanup（STW）                                             │
  │   reclaim_empty_regions(): 回收完全空闲的 Regular Region            │
  │   ★ Humongous Eager Reclaim: 死 Humongous 直接回收                  │
  │   compute_new_sizes(): 堆扩缩容                                   │
  │   record_concurrent_mark_cleanup_end():                            │
  │     → calc_gc_efficiency() = reclaimable_bytes / predicted_time_ms │
  │     → CollectionSetChooser::sort_regions() → Mixed GC 候选列表     │
  │                                                                   │
  │ 后台: Concurrent Rebuild RSet（并发，Cleanup 之后）                  │
  │   rebuild_rem_set_concurrently() ← 后台 511ms 重建 RSet            │
  └─────────────────────────────────────────────────────────────────┘

  ★ liveness 数据流（本文的核心输出）：
    bitmap gray bits → _cm->liveness()(words) → *HeapWordSize → _prev_marked_bytes(bytes)
    → live_bytes() = (top-prev_TAMS)*WordSize + _prev_marked_bytes
    → reclaimable = capacity - live_bytes → _gc_efficiency → 08 的 CSet 选策
    每一步的单位转换和为什么需要这样转换——单位粒度追踪
```

---

### 核心叙事线（14 个"为什么"问题，每个必须有源码回答）

**❓ Initial Mark（搭车机制）**

1. **❓ 为什么 Initial Mark 能"搭车" Young GC？`set_initiate_conc_mark_if_possible(true)` 设置了什么状态？这个状态在 Young GC 的哪两个位置被检查？**

   **子问题**：
   (a) `G1CollectorState::set_initiate_conc_mark_if_possible()` 做了什么？为什么叫 "if possible"而不叫 "immediately"？
   (b) Young GC 的 `do_collection_pause()` 中，哪里检查 `in_initial_mark_gc()` 来决定是否调用 `pre_initial_mark()` 和 `post_initial_mark()`？
   (c) ★ `pre_initial_mark()` 的两步：① `reset()`（清 bitmap + 重置 CM tasks 全局数据结构）② `NoteStartOfMarkHRClosure`（per-Region 设置 `nTAMS = top`）。为什么两步必须分开？
   (d) ★ `post_initial_mark()` 做了什么？（激活 SATB buffer `set_active_all_threads(true)`、enable reference discovery）
   (e) ★ 为什么 `pre_initial_mark()` 必须在 Evacuation **之前**调用，`post_initial_mark()` 必须在 Evacuation **之后**调用？

2. **❓ Root Region Scanning 是什么？为什么需要它？它在 Initial Mark 和 Concurrent Mark 之间的什么位置？**

   **子问题**：
   (a) Root Region = Initial Mark 暂停结束时, Survivor 区域中的对象
   (b) `scan_root_regions()` 在 `run_service()` 中 `mark_from_roots()` **之前**调用
   (c) ★ 为什么必须 Concurrent Mark 开始**之前**扫描完 root regions？（这些 Survivor 对象可能在后续 Young GC 中被 copy → 不先标记会在 concurrent marking 期间"丢失"）

**❓ Concurrent Mark → Remark 之间的调度**

3. **❓ Preclean 阶段是什么？什么时候触发？为什么可能不执行？它对 Remark 有什么帮助？**

   **子问题**：
   (a) `preclean()` 在 `run_service()` 循环中的位置：`mark_from_roots()` 之后、Remark 之前
   (b) ★ 触发条件：`G1UseReferencePrecleaning` （`g1ConcurrentMarkThread.cpp:323`）
   (c) preclean 做什么？提前发现和处理 reference 对象的引用变化，减少 Remark 中 reference processing 的工作量
   (d) ★ 为什么是可选的？如果 `G1UseReferencePrecleaning=false`，reference discovery 的工作全部延迟到 Remark 中做 → Remark 暂停稍微变长

4. **❓ Overflow restart 循环：如果 CM 阶段 overflow 了，整个周期怎么重启？哪些阶段会被重新执行？**

   **子问题**：
   (a) 06 §五 overflow 路径 → `_has_overflown` → `_restart_for_overflow = true` → 回到 `run_service()` 的 `for (iter=1; ...; ++iter)` 循环
   (b) ★ 被跳过的阶段：Initial Mark / Root Region 已经做完 → 不会重做
   (c) ★ 被重新执行的阶段：`mark_from_roots()`（reset 后重新 CM）→ preclean → Remark → Cleanup
   (d) ★ 多轮 overflow 的代价：每多一轮就多一次 mark_from_roots + Remark STW → pause 时间累加

**❓ Remark（为什么必须 STW）**

5. **❓ Remark 为什么必须在 STW 下执行？CM workers 都 terminate 了，还有什么没标记完？**

   **子问题**：
   (a) ★ 三个未完成事项：① thread-local SATB buffer 中未满的部分没被处理 ② CM 完成后 mutator 新产生的 SATB buffer 没被 drain ③ reference processing 必须在 STW 下做
   (b) `finalize_marking()` 怎么做？（STW 下 `G1CMRemarkTask` 多 worker 并行标记，同 `do_marking_step` 引擎）
   (c) ★ `finalize_marking()` 处理完后 SATB 做了什么？`set_active_all_threads(false)` + 检查 `completed_buffers_num() == 0`
   (d) Reference Processing（弱引用、软引用、虚引用、Finalizer）在 Remark 中的位置
   (e) ★ Class Unloading：什么时候做？怎么判断 class 是 dead 的？`ClassLoaderDataGraph::purge()`

6. **❓ Remark 中 swap_mark_bitmaps() 的精确时机和后续影响？**

   **子问题**：
   (a) swap 发生在 `finalize_marking()` 完成后、`weak_refs_work()` 之后（`remark():1321`）
   (b) ★ 为什么不在 Cleanup 中 swap？因为 Cleanup 中已经需要读 prev bitmap 的 marking 结果来计算 live_bytes
   (c) swap 后 `_prev_mark_bitmap` 指向刚完成的标记结果 → Mixed GC 的依据

**❓ Cleanup — liveness 数据如何从 bitmap 标记变为回收候选**

7. **❓ `live_bytes()` 公式的逐项溯源 — 每一字节从哪个数据结构来？**

   **子问题**：
   (a) `live_bytes() = (top() - prev_top_at_mark_start()) * HeapWordSize + marked_bytes()`（`heapRegion.hpp:371`）
   (b) `top()`：Region 当前使用边界（Evacuation GC 可能改变了 top）
   (c) `prev_top_at_mark_start()`：上一轮 CM 开始时（Initial Mark 设置 `nTAMS`）的 top，swap 后 nTAMS 变成 prev_TAMS
   (d) ★ **单位转换链（三步）**：
      → `_cm->liveness(region_idx)` 返回 `_live_words`（**word 数**）
      → `add_to_marked_bytes(marked_words * HeapWordSize)` → 存为 `_prev_marked_bytes`（**字节数**）
      → `top() - prev_top_at_mark_start()` 是 word 差值 → `* HeapWordSize` → 字节
      → 两项相加：字节 + 字节 = 字节 ✓
   (e) `marked_bytes()` 的源头：`_cm->liveness()` 来自 `_region_mark_stats` → 由 06 的 `add_to_liveness()` 在每次 `mark_in_next_bitmap` 时累加
   (f) ★ 为什么是 `prev_TAMS` 而不是 `next_TAMS`？swap 后 `next_TAMS` 已变成 `prev_TAMS`
   (g) ★ GDB 验证：`p *_curr_region` 可以看到 `_prev_marked_bytes`, `_prev_top_at_mark_start`, `top()` 三个字段

8. **❓ `calc_gc_efficiency()` 的公式、分子 `reclaimable_bytes` 的含义、分母的来源**

   **子问题**：
   (a) `_gc_efficiency = reclaimable_bytes() / region_elapsed_time_ms`（`heapRegion.cpp:143-154`）
   (b) `reclaimable_bytes()` = `capacity() - live_bytes()` = Region 总容量 - 存活字节 = 可回收字节
   (c) ★ `region_elapsed_time_ms` 的来源：**需要从源码 grep 追踪**——这个变量可能是 G1Analytics 的预测输出、HeapRegion 自身记录的历史耗时、或是外部传入的预测值。**不要在未经 grep 验证的情况下断言具体函数名**（如 `G1Analytics::predict_region_elapsed_time_ms()`），需要在撰写时从 `heapRegion.cpp/.hpp` 和 `g1Analytics.cpp` 中交叉追踪
   (d) ★ 为什么用 `capacity()` 而不是 `used()`？因为标记的是容量范围内的垃圾
   (e) Mixed GC 怎么使用 `_gc_efficiency`？排序 → 选 `_gc_efficiency` 最高的前 N 个 Old Region 进 CSet

9. **❓ `reclaim_empty_regions()` 回收什么样的 Region？Humongous Eager Reclaim 又是什么？**

   **子问题**：
   (a) 回收条件（全貌）：`hr->used() > 0 && hr->max_live_bytes() == 0 && !hr->is_young() && !hr->is_archive()` — 有占用但全死，且不是 Young/Archive
   (b) `max_live_bytes()` 是什么？`used() - garbage_bytes()` → 最大活字节
   (c) ★ Humongous Eager Reclaim：对于死 Humongous 对象（多个连续 Region），在 Cleanup 中直接回收 → 不需要等到下一轮 Mixed GC
   (d) ★ 回收不是"直接还 free_list"——是通过 `free_region(hr)` 归还到 `HeapRegionManager::_free_list`

**❓ Concurrent Rebuild RSet**

10. **❓ 为什么 Cleanup 之后需要重建 RSet？什么时候做？为什么并发做？**

   **子问题**：
   (a) `rebuild_rem_set_concurrently()` → `g1_rem_set()->rebuild_rem_set(this, _concurrent_workers, _worker_id_offset)`（`g1ConcurrentMark.cpp:2223`）
   (b) 重建 RSet 的原因：回收 Region 后 RSet 中指向已回收 Region 的卡记录失效 → 需要重建为只记录指向存活 Region 的卡
   (c) ★ 为什么并发做？减少 STW 开销——RSet 重建可能耗时几百毫秒（实测 ~511ms）
   (d) `_top_at_rebuild_starts` 在重建中的作用：记录重建开始时每个 Region 的 top → 只需要重建到 top 为止

**❓ 面试层**

9. **❓ Initial Mark 为什么能"零额外 STW"？搭车机制的根本原理是什么？**

   **要求**：简短解释重叠开销设计。面试时可以一句话："Initial Mark 搭车 Young GC——在 Young GC 必做的 GC Roots 扫描之上，多设了 TAMS 和激活 SATB，不引入额外停顿。"

10. **❓ Remark 为什么要 STW？不做 STW 能行吗？**

    **要求**：解释三个必须在 STW 下完成的原因（mutator SATB residual、thread-local flush、reference processing）。面试话术："Remark=STW 是为了最后一把把 mutator 积累的 SATB buffer 全清完，保证 bitmap 结果完整。不清完 → 漏标 → 活对象被当垃圾。"

11. **❓ `live_bytes` 和 `used` 的区别是什么？Mixed GC 用哪个选 Region？**

    **要求**：
    - `used` = Region 中已分配的总字节数
    - `live_bytes` = 经过并发标记确定为存活的字节数（≤ used）
    - Mixed GC 选 Region 用 `reclaimable_bytes = capacity - live_bytes`（看能回收多少），不是看 `used - live_bytes`
    - `_gc_efficiency` = reclaimable_bytes / predicted_time_ms（性价比排序）

12. **❓ Cleanup 和 Remark 都做了 bitmap 相关操作，为什么需要两个独立的 STW 阶段？不能合并吗？**

    **要求**：
    - Remark 的核心任务：finalize marking（完成最后标记）+ swap bitmap → 让标记结果"定稿"
    - Cleanup 的核心任务：基于 swap 后的 prev bitmap 计算 liveness → 这是不同性质的工作
    - 合并问题：Cleanup 的回收空 Region 和 compute_new_sizes 需要 prev bitmap 已经 swap 完 → Remark swap 后才能做
    - 但实际上这两个阶段都是 STW，可以合并在一段代码中——源码之所以分开是因为 `run_service()` 循环结构（Remark→可选 restart→Cleanup）和 MMU 延迟逻辑

---

### 禁止行为

- ❌ 把 06 的 do_marking_step 再说一遍——06 已经讲透了，引用即可
- ❌ 把 03 的 Young GC 四阶段重述——只讲 Initial Mark **插入**的部分
- ❌ 只说"Remark 做 reference processing"——**必须回答：Soft/Weak/Phantom/Final 四种引用各在什么时候、谁去做、怎么区分 alive 和 dead**
- ❌ 只说"Cleanup 算 liveness"——**必须把 live_bytes() 公式逐项拆开，回答每一字节从哪个字段来**
- ❌ 不说 `_gc_efficiency` 的分母 `predicted_time_ms` 从哪里来
- ❌ 不说 Class Unloading 为什么能在 Remark 中做
- ❌ 把 swap_mark_bitmaps 在 Remark 中的时机和 Cleanup 中的使用混为一谈

### 要求行为

- ✅ **★ 每节以"❓ 为什么..."开头**
- ✅ **★ 全文核心叙事线**：Initial Mark（搭车）→ Root Region Scanning → [Concurrent Mark — 06] → Remark（STW finalize + SATB residual）→ Cleanup（liveness calc + gc_efficiency）→ Concurrent Rebuild RSet
- ✅ **★ liveness 数据流完整追踪**：从 bitmap 的一个 gray bit → `marked_bytes` 字段 → `live_bytes()` 公式 → `_gc_efficiency` → 08 的 `CollectionSetChooser::sort_regions()`
- ✅ **★ Mermaid 图 ≥4 张**：
  1. 阶段时序图（标注哪些 STW、哪些并发、哪些并行 + preclean 可选 + overflow restart 循环）
  2. Initial Mark 搭车 Young GC 的钩子插入点（pre_initial_mark / post_initial_mark 在 do_collection_pause 中的位置）
  3. Remark 从 `run_service()` 进入 → `finalize_marking()` → `weak_refs_work()` → `swap` 的详细决策流程（含 preclean 和 overflow restart 分支）
  4. liveness 数据流全链路：bitmap → live_words → *HeapWordSize → _prev_marked_bytes → live_bytes → reclaimable → gc_efficiency → CSet
- ✅ **★ GDB 验证 ≥7 条**：
  1. Initial Mark 前后 SATB `_active` 的 true/false（在 `post_initial_mark` 前后断点）
  2. Remark 前后 SATB `_active` 的 false（在 `set_active_all_threads(false)` 前后）
  3. `live_bytes()` vs `used()` 在 Cleanup 前后的对比（任意 Old Region）
  4. `_gc_efficiency` 在不同 Region 上的排序验证（选几个 Region 手动计算）
  5. swap 后 `_prev_mark_bitmap` 的 Region 的 `_prev_marked_bytes` 已有值
  6. `reclaim_empty_regions()` 前后的 free_list 长度变化
  7. `humongous_object_eagerly_reclaimed()` 后 Humongous Region 回到 free_list
- ✅ **★ 设计替代分析**：如果 Initial Mark 是独立 STW 而非搭车，代价多少？（额外 2-5ms STW + 重复 GC Roots 扫描）
- ✅ **★ 和 06/08 的精确边界**：
  - 06 → 本文：do_marking_step 完成 → Remark 开始
  - 本文 → 08：Cleanup 完成 → Mixed GC 候选列表就绪
- ✅ **★ 交叉引用精确**：SATB residual → [05 §五]；swap_mark_bitmaps → [06 §二]；do_marking_step → [06 §五]；G1Policy/Mixed → [08]
- ✅ **★ 面试友好**：§六 面试问题 ≥8 个

---

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（G1 Region = 4MB，2048 Regions）
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- `-XX:ConcGCThreads=N` 控制并发标记线程数（默认 = `(ParallelGCThreads + 2) / 4`）

---

## 三、聚焦源文件（行号需 grep 验证）

| # | 文件 | 模块 | 核心函数/类 | 本文角色 |
|---|------|------|------------|---------|
| 1 | `g1ConcurrentMark.cpp/.hpp` | gc/g1 | `remark()`(cpp:1273), `cleanup()`(cpp:1526), `pre_initial_mark()`(cpp:874), `post_initial_mark()`(cpp:884), `finalize_marking()`(cpp:2052), `scan_root_regions()`(cpp:1047), `reclaim_empty_regions()`(cpp:1470), `rebuild_rem_set_concurrently()`(cpp:2223), `humongous_object_eagerly_reclaimed()` | ★★★ 四阶段+后台核心实现 |
| 2 | `g1ConcurrentMarkThread.cpp` | gc/g1 | `run_service()`(cpp:248) — Preclean/Remark→Cleanup 调度 + overflow restart loop | ★★★ 阶段衔接 |
| 3 | `g1CollectedHeap.cpp` | gc/g1 | `do_collection_pause()` — `set_initiate_conc_mark_if_possible(true)` 触发 | ★★ Initial Mark 搭车 |
| 4 | `g1CollectorState.hpp` | gc/g1 | `G1CollectorState`, `set_initiate_conc_mark_if_possible()` | ★★ CM 状态控制 |
| 5 | `heapRegion.hpp/cpp` | gc/g1 | `live_bytes()`(hpp:371), `calc_gc_efficiency()`(cpp:143), `marked_bytes()`, `reclaimable_bytes()`, `note_start_of_marking()`, `NoteStartOfMarkHRClosure` | ★★★ liveness 计算公式 |
| 6 | `g1RemSet.cpp` | gc/g1 | `rebuild_rem_set()` | ★★ RSet 重建 |
| 7 | `collectionSetChooser.cpp/.hpp` | gc/g1 | `CollectionSetChooser::sort_regions()` | ★★ Mixed GC 候选排序 |
| 8 | `g1IHOPControl.cpp` | gc/g1 | `G1IHOPControl` — IHOP 判定触发 Initial Mark | ★ 触发时机（引用 [08]） |
| 9 | `g1Analytics.cpp` | gc/g1 | Region elapsed time 预测 → 需 grep 验证具体方法名 | ★★ gc_efficiency 分母来源 |
| 10 | `referenceProcessor.cpp` (gc/shared) | gc/shared | `ReferenceProcessor` — Remark 中 ref processing | ★★ 引用处理 |

> 以上行号均需在撰写前 grep 验证，不可直接引用。

---

## 四、文章结构（§〇 ~ §七 + 附录）

```
§〇 源文件清单（10 文件，标注模块归属 + grep 验证行号）

§一 ★ 全景 — CM 周期的阶段调度
  ❓ G1 并发标记周期有哪些阶段？为什么不能一个阶段做完？
  1.1 阶段时序图（Mermaid 1：每个阶段标注 STW/并发/并行 + 数据产出 + overflow restart loop）
  1.2 ★ 为什么需要这么多阶段？（并发标记的结果不可信直到 Remark 把 SATB 残留清完 + Cleanup 把 bit 转为数量）
  1.3 和 06/08 的衔接：06 讲阶段 3 的 worker 引擎，本文讲阶段 1/2/3.5(preclean)/4/5 的宏观调度 + overflow restart
  1.4 ★ liveness 数据流概览：bitmap words(graph) → _live_words → *HeapWordSize → _prev_marked_bytes(bytes) → live_bytes → reclaimable → _gc_efficiency

§二 ★★★ Initial Mark — 搭车 Young GC
  ❓ 为什么 Initial Mark 能"搭车" Young GC 零额外 STW？
  2.1 G1Policy 决策：`set_initiate_conc_mark_if_possible(true)` 的判定时机
  2.2 Mermaid 2：Young GC do_collection_pause 中的两个钩子插入点
  2.3 `pre_initial_mark()` 逐行走读：两步 — ① reset() ② NoteStartOfMarkHRClosure per-Region nTAMS=top
  2.4 Young GC Evacuation（03 的范畴，本文简述）
  2.5 `post_initial_mark()` 逐行走读：激活 SATB + enable ref discovery
  2.6 ★ 设计替代：如果 Initial Mark 是独立 STW → 代价分析

§三 ★★ Root Region Scanning
  ❓ Root Region 是什么？为什么必须在 Concurrent Mark 前扫描？
  3.1 Root Region 定义：Initial Mark pause 结束时的 Survivor 对象
  3.2 `scan_root_regions()` 逐行走读
  3.3 ★ 为什么必须 CM 前扫完？Evacuation GC 可能移动它们

§四 ★★ 从 CM 到 Remark 的调度 — Preclean + Overflow Restart
  ❓ CM 完成后到 Remark 之间还有什么调度决策？
  4.1 Preclean 阶段：`preclean()` — 提前发现和处理 reference，减少 Remark 工作量
    4.1.1 ★ 触发条件：`G1UseReferencePrecleaning` — 为什么可选的？
    4.1.2 位置：`run_service()` for 循环中 mark_from_roots() 之后
  4.2 ★ Overflow restart loop（06 §五 overflow 在调度层的后果）：
    → `_restart_for_overflow = true` → `run_service()` for 循环 goto mark_from_roots()
    → 哪些阶段被跳过（Initial Mark / Root Region），哪些重新执行（CM / preclean / Remark / Cleanup）
    → 多轮 overflow 的代价：Mark Restart for Mark Stack Overflow (iteration #N) 日志

§五 ★★ Remark — 为什么必须 STW
  ❓ CM workers 都 terminate 了，还有什么东西没标记？
  5.1 Remark 的入口：`run_service()` → `Pause Remark` → `CMRemark::doit()` → `remark()`
  5.2 `finalize_marking()` 逐行走读：STW 下多 worker 并行标记
  5.3 ★ 三个未完成事项的逐一处理：
    (a) thread-local SATB buffers → `set_active_all_threads(false)` → assert completed_buffers==0
    (b) reference processing → `weak_refs_work()` (简述，深挖→ [11])
    (c) class unloading → `ClassLoaderDataGraph::purge()`（什么时候做？条件？）
  5.4 `swap_mark_bitmaps()` → [06 §二]
  5.5 Mermaid 3：Remark 详细决策流程（finalize_marking → weak_refs_work → swap → flush cache → reclaim empty → compute sizes）

§六 ★★★ Cleanup — liveness 数据如何从 bitmap 变为 Mixed GC 候选
  ❓ live_bytes 公式中每一字节从哪个数据结构来？
  6.1 `live_bytes()` 公式逐项溯源 + 单位转换链（三步）
  6.2 `marked_bytes()` 从 bitmap → `_cm->liveness()` → `add_to_marked_bytes()` 的完整追踪
  6.3 `reclaim_empty_regions()` 的回收条件（含 `!is_young()` + `!is_archive()`）和回收动作
  6.4 ★ Humongous Eager Reclaim：死 Humongous 对象的单独回收路径
  6.5 ★ `calc_gc_efficiency()` = reclaimable_bytes / region_elapsed_time_ms
    → 分子：capacity - live_bytes
    → 分母：需从源码 grep 验证 `region_elapsed_time_ms` 的来源（G1Analytics 预测 vs 历史耗时 vs 局部变量）
  6.6 ★ `_gc_efficiency` 如何进入 Mixed GC 候选排序？
    → `CollectionSetChooser::sort_regions()` → 按 `_gc_efficiency` 降序排列
    → 08 在这个候选列表基础上做 CSet 选策
  6.7 Mermaid 4：liveness 数据流全链路（bitmap → live_words → marked_bytes → live_bytes → reclaimable → gc_efficiency → CSet）

§七 ★★ Concurrent Rebuild RSet
  ❓ 为什么 Cleanup 之后需要重建 RSet？
  7.1 回收 Region 后 RSet 中的卡指针失效 → 需要重建为指向存活 Region
  7.2 `rebuild_rem_set_concurrently()` 的并发执行
  7.3 `_top_at_rebuild_starts` 在重建中的作用

§七 面试问题合集 ≥8 个
  Q1: Initial Mark 为什么能"零额外 STW"？搭车机制的原理？
  Q2: Remark 为什么要 STW？不做 STW 能行吗？
  Q3: live_bytes 和 used 的区别？Mixed GC 用哪个选 Region？
  Q4: Cleanup 和 Remark 为什么需要两个独立的 STW 阶段？不能合并吗？
  Q5: _gc_efficiency 的分母从哪来？为什么需要它？
  Q6: Root Region Scanning 是什么？为什么需要它？
  Q7: 为什么在 Remark 中做 Class Unloading？怎么判断 class dead？
  Q8: 并发标记 overflow 后怎么恢复？会重新执行哪些阶段？
  Q9: Preclean 阶段是什么？为什么是可选的？
  Q10: Cleanup 回收了什么样的 Region？Humongous 死对象怎么回收？
  Q11: SATB buffer 在 Remark 中怎么被完全清空？

§八 GDB 验证 + 可证伪断言（≥7 条）
  断言 1: Initial Mark 前后 SATB _active 状态变化
  断言 2: Remark 前后 SATB _active 状态变化
  断言 3: live_bytes vs used 在 Cleanup 前后的对比
  断言 4: _gc_efficiency 在不同 Region 上的排序验证
  断言 5: swap 后 _prev_marked_bytes 已有值
  断言 6: reclaim_empty_regions 前后 free_list 长度变化
  断言 7: finalize_marking 中 completed_buffers_num == 0
  断言 8: Humongous Eager Reclaim 后 Region 从 starts/continues 回归 free_list

§九 附录：关键 GDB 断点 + GC log 示例
```

---

## 五、交叉引用

| 引用点 | 本文位置 | 目标文档 |
|--------|---------|---------|
| do_marking_step 引擎 | §五 + 引用 | `[06 §五]` |
| swap_mark_bitmaps 精确实现 | §五 | `[06 §二]` |
| SATB 残留处理 | §五 | `[05 §五]` |
| CM overflow → restart 路径 | §四 4.2 | `[06 §五]` (overflow 在 do_marking_step 中的路径) |
| Young GC 四阶段（搭车背景） | §二 | `[03 §二~§四]` |
| Reference Processing 四种引用 | §五 | `[11 §X]` |
| G1Policy / IHOP 触发 CM | §二 | `[08 §X]` |
| Mixed GC CSet 选策 | §六 | `[08 §X]` |
| G1Analytics 预测器（region_elapsed_time_ms 来源） | §六 | `[08 §X]` |

---

## 六、写作要求

1. **★ 每节以"❓ 为什么..."开头**
2. **★ 设计替代分析**：Initial Mark 独立 STW vs 搭车 的代价对比
3. **★ liveness 数据流完整追踪**：这是本文和 08 的核心桥梁——本文负责生产端（bitmap→live_bytes），08 负责消费端（CSet 选策）。必须把每个转换公式的输入输出都追踪清楚
4. **★ 可证伪断言 ≥6 条**（含 GDB 命令 + 预期输出）
5. **★ Mermaid 图 ≥4 张**：
   - 五阶段时序图
   - Initial Mark 搭车钩子
   - Remark 决策流程
   - liveness 数据流全链路
6. **★ 源文件行号全部 grep 验证后再写**
7. **★ 面试友好**：§七 面试 ≥8 个，每个都有一句话回答 + 展开
8. **★ 和 06/08 不重复**：
   - 06 的 do_marking_step 已经深挖过，本文只讲"它在哪个阶段被调用、前后有什么衔接"
   - 08 的 IHOP/G1Policy/CSet 选策是消费端，本文只讲 liveness 数据的生产方式

---

## 七、输出格式

- Markdown 文件，命名为 `07-ConcurrentMark-Phases.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/06-gc-memory/`
- 元信息头：标准环境 + 源文件清单（10 文件，行号 grep 验证）+ 前置依赖（已读 06/05/04/03/01）+ 阅读收益
- 阅读收益强调：读完本文后能回答"G1 的并发标记周期有哪些阶段？每个阶段为什么是 STW 或并发？Initial Mark 为什么能搭车 Young GC 零额外 STW？Remark 为什么不能省？liveness 怎么从 bitmap 的一个 bit 变成 `_gc_efficiency` 排序分数？Cleanup 怎么把 bitmap 标记结果转化为 Mixed GC 的回收候选？"——CM 周期五阶段的每一笔开销和每一字节数据流都了然于胸
