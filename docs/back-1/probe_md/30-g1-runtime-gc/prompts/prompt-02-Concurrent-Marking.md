# PROMPT: 请撰写 02-Concurrent-Marking-Lifecycle.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

生产环境 G1 并发标记 Full GC 突发故障：

```
2024-07-15T14:32:18.876+0800: 251423.876: [GC concurrent-mark-start]
2024-07-15T14:32:19.482+0800: 251424.482: [GC concurrent-mark-end, 0.6063215 secs]
2024-07-15T14:32:19.483+0800: 251424.483: [GC remark, 0.0234567 secs]
2024-07-15T14:32:19.507+0800: 251424.507: [GC cleanup 1234M->1100M(4096M), 0.0123456 secs]
2024-07-15T14:32:20.100+0800: 251425.100: [GC concurrent-mark-start]
2024-07-15T14:32:21.348+0800: 251426.348: [GC concurrent-mark-end, 1.2480210 secs]
2024-07-15T14:32:21.349+0800: 251426.349: [GC pause (G1 Evacuation Pause) (concurrent mode failure), 0.1876543 secs]
   [Eden: 512.0M(512.0M)->0.0B(512.0M) Survivors: 64.0M->0.0B Heap: 3800.0M(4096M)->3200.0M(4096M)]
2024-07-15T14:32:21.537+0800: 251426.537: [GC pause (G1 Evacuation Pause) (to-space exhausted), 0.4567890 secs]
2024-07-15T14:32:22.100+0800: 251427.100: [GC concurrent-mark-abort]
2024-07-15T14:32:22.150+0800: 251427.150: [Full GC (Allocation Failure) 3800M->2100M(4096M), 0.9234567 secs]
```

**根因链**：G1 并发标记耗时 1.25s（超过正常 0.6s 2×）→ mutator 分配速率 800MB/s > 标记推进速率 400MB/s → Eden 填满时标记尚未完成 → concurrent mode failure → evacuation pause 无法分配 to-space → to-space exhausted → Full GC → 累计停顿 1.5s（远超 -XX:MaxGCPauseMillis=200 目标）。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 用 jstat 追踪标记周期与 GCCause
jstat -gccause -t $(pgrep -f "java.*MyApp") 1s
# 观察: FGC 列突增 → GCCause 列显示 "Concurrent Mode Failure"
# → "Allocation Failure" → Full GC

# 2. GDB 检查标记覆盖率和 SATB buffer 积压
gdb -p $(pgrep -f "java.*MyApp") \
    -ex "call G1CollectedHeap::heap()->concurrent_mark()->calc_active_workers()" \
    -ex "call G1CollectedHeap::heap()->concurrent_mark()->worker(0)->finger()" \
    -ex "call SATBMarkQueueSet::completed_buffers_num()" \
    -ex "call G1CollectedHeap::heap()->concurrent_mark()->prev_mark_bitmap()"
# 观察: finger 未到达堆顶 + completed_buffers_num > 1000 → 标记追不上

# 3. strace 观察标记线程 syscall 耗时
strace -p $(pgrep -f "G1 Conc") -T -c -f
# 观察: futex 等待占比 >40% → 标记线程空闲等待 mutator flush SATB
```

**反事实 1**：如果没用 SATB 而用 CMS 的 Incremental Update → 写入灰对象无需 pre-write barrier（零记录开销）→ 标记期间分配速率高 20% → 但 remark 需重新扫描所有被更新的灰对象 → remark 可能延长到 500ms（不再是 23ms）→ 总停顿更大。SATB 用 pre-write 开销（~5ns/写入）换 remark 的确定性（不重新扫描灰对象更新），在分配压力高时 remark 稳定。

**反事实 2**：如果分配速率控制在标记速度以下 → 永远不会 concurrent mode failure → 但需要更大的堆（12GB 而非 4GB）或多 3× concurrent mark threads → 成本 3× CPU 开销。

**反事实 3**：如果标记线程不做 regular_clock_call yield → 标记耗尽所有 CPU 时间片 100% → mutator 线程无法获得 CPU → allocation rate 降到接近 0 → 错觉上标记很快（因为没有对象产生）→ 但吞吐量崩塌，用户请求超时。标记 yield 的实际含义：用标记延迟（约 150%）换取 mutator 不饿死。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the COMPLETE G1 concurrent marking lifecycle — from the first thread waking up to the final bitmap swap. This is NOT a conceptual overview of "G1 does concurrent marking." It is ENGINEERING documentation that maps every function call, every state transition, every buffer flush, and every yield decision to source code with file:line references.

Reader completed **01-09-G1-Concurrent-Marking-Infra** (G1ConcurrentMark 构造函数、双缓冲位图、CMTask×13 初始化) and **01-08-G1-Policy-Analytics** (G1Policy 8 子组件、Analytics 17 个 TruncatedSeq、IHOP 控制)。This doc: **how the marking lifecycle actually runs** — from `pre_initial_mark` through `do_concurrent_mark` to `cleanup`.

### Interview Story Format Answer（必须出现在 §一 末尾）

"G1 concurrent marking follows a 7-phase lifecycle driven by the marking thread (G1ConcurrentMarkThread::run_service): Phase 0: pre_initial_mark (g1ConcurrentMark.cpp:874) grabs CGC_lock to synchronize with the next Young GC, which piggybacks initial mark at end-of-pause. Phase 1: scan_root_regions (g1ConcurrentMark.cpp:1047) scans region roots concurrently while next Young GC runs — exploiting parallel hardware. Phase 2: mark_from_roots (g1ConcurrentMark.cpp:1102) spawns 13 CMTasks, each executing do_marking_step in a 7-phase loop: drain local, bitmap scan, SATB drain, full drain, steal, termination. The CMTask yields via regular_clock_call 6-condition check (overflow/abort/STS/time quota/SATB accumulation/non-concurrent). Phase 3: preclean (g1ConcurrentMark.cpp:1901) drains remaining SATB + discovered references. Phase 4: Remark (g1ConcurrentMark.cpp:1273) — STW to guarantee consistency: SATB drained, mark stacks emptied, weak refs finalized. Phase 5: rebuild remembered sets (for upcoming regions). Phase 6: Cleanup (g1ConcurrentMark.cpp:1526) reclaims empty regions, computes new sizes, rebuilds CSet Chooser. Phase 7: cycle end — swap prev/next bitmap (g1ConcurrentMark.cpp:469) and return to idle. If allocation outpaces marking → overflow → concurrent_cycle_abort, 8 checkpoint positions. The SATB (Snapshot At The Beginning) protocol is what makes this possible: each mutator write captures the old pointer via pre-write barrier (write_ref_field_pre → SATBMarkQueue::enqueue), so marking sees a consistent logical snapshot even as objects move. The dirty card table, maintained by post-write barrier, tracks which old-to-young references need scanning during Remark."

### Beginner Callout Boxes（文档中必须出现的 ≥7 个 callout 框）

1. **SATB (Snapshot At The Beginning)**: SATB is NOT a physical snapshot (like a fork-and-copy). It's a LOGICAL snapshot: marking starts with the heap as it was at initial mark, and mutator writes during marking are captured by the pre-write barrier that enqueues the OLD pointer value into a SATB buffer. When marking later drains that buffer, it follows the old pointers — effectively seeing the heap "as it was at the beginning." This guarantees: (a) no object alive at marking start is missed, (b) objects that die during marking are treated as live (floating garbage, 1 cycle tolerance). Cost: ~5ns per reference write (compare-and-swap + conditional enqueue). Source: `src/hotspot/share/gc/g1/satbMarkQueue.hpp:132`.

2. **Dual Marking Bitmap (prev/next)**: G1 maintains TWO bitmaps, not one. `_prev_bitmap` holds the LAST cycle's marking result (read-only during current cycle). `_next_bitmap` is being written by the CURRENT cycle's marking. At cleanup, `swap_mark_bitmaps()` atomically swaps prev↔next — no zeroing needed. The pattern: 当前周期标记写入 next → cleanup 时 swap → previous 变成可读的标记结果 → next 变成待写入的空白 bitmap（本轮标记过程中不断重置指针对应的 region）。Two bitmaps have ZERO-copy transition cost. Source: `src/hotspot/share/gc/g1/g1ConcurrentMarkBitMap.hpp:82`.

3. **CMTask finger**: Each CMTask has a `_finger` (HeapWord pointer) tracking its scan frontier. The "finger" divides each region into [bottom, finger) — already scanned — and [finger, top) — yet to scan. When the task resumes scanning, it starts from finger, not from bottom. The finger is atomically updated via `claim_region()` (no CAS — each region is exclusive to one task by virtue of the global region index counter `_curr_region`). Source: `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:2730`.

4. **Work Stealing in Marking**: When a CMTask drains its local queue and has no more regions to scan, it enters `try_stealing()`: it picks a VICTIM task (round-robin from `_task->task_id()`) and pulls entries from the victim's `_global_finger` stack. If it successfully steals, it continues marking; if all tasks are empty, it enters termination protocol (`offer_termination`). The global terminator coordinates: all tasks must agree they're done before the marking cycle can proceed. Source: `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:g1ConcurrentMark.cpp` CMTask::try_stealing (find exact line in source).

5. **SATB Buffer Flow — 5 Stage Pipeline**: (1) Mutator: `write_ref_field_pre()` at barrier — old pointer enters per-thread SATB buffer. (2) Filter: SATB buffer uses 2-pointer compression (bottom/active) — if buffer full (64 entries), `enqueue_completed_buffer()` moves it to global completed list. (3) Flush: at safepoint or on demand, `flush()` pushes partial buffer to completed list. (4) Completed queue: Global `_completed_buffers` linked list protected by `SATBMarkQueue_lock`. (5) Drain: marking thread `drain_satb_buffers()` iterates completed list → applies closure to each entry → follows old pointers to mark. Source: `src/hotspot/share/gc/g1/satbMarkQueue.hpp/cpp`.

6. **regular_clock_call — 6 Condition Yield**: The marking task does NOT run continuously. Every `do_marking_step` iteration calls `regular_clock_call()` (g1ConcurrentMark.cpp:2424) to check 6 conditions: (1) `has_overflown()` — SATB buffers exceeded capacity, must restart marking; (2) `CMCheckpointRootsFinalClosure::do_abort()` — Full GC occurred, abort marking; (3) `SuspendibleThreadSet::should_yield()` — external request to yield (e.g., STW pause starting); (4) CPU time quota exceeded — OS scheduler fairness; (5) `SATBMarkQueueSet::set_active_all_threads()` changed — mutator buffer state toggled; (6) `!concurrent()` — non-concurrent mode specified. If any condition true → `set_has_aborted()` → marking aborts. Source: `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:2424`.

7. **Concurrent Mode Failure — 溢出与中止**: When allocation rate outpaces marking rate, two things happen. First, SATB overflow: mutators produce old-pointer entries faster than marking threads drain them → SATB completed buffer count exceeds threshold → `has_overflown()` returns true → marking cycle must restart from scratch (overflow restart). Second, heap exhaustion: Eden fills before marking finishes → concurrent mode failure → STW evacuation pause → if to-space also exhausts → Full GC. The `concurrent_cycle_abort()` (g1ConcurrentMark.cpp:2240) sets `_has_aborted=true` and resets `_concurrent=true` — the cycle is abandoned and started fresh. Source: `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:2240`.

8. **Marking Thread State Machine**: The marking thread (`G1ConcurrentMarkThread::run_service()`, g1ConcurrentMarkThread.cpp:? line) has states: `Idle` → sleep on `CGC_lock` wait; `MarkStarted` → woken by `set_started()`; `ScanRootRegions` → concurrent root scan; `MarkFromRoots` → 13 CMTask spawned; `MarkIdle` → between concurrent & remark; `Remark` → STW; `Cleanup` → STW; `CleanupForNextMark` → post-cleanup. Transition is NOT automatic — each step blocked by CGC_lock::wait until previous phase calls CGC_lock::notify_all. Source: `src/hotspot/share/gc/g1/g1ConcurrentMarkThread.cpp`.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux。

Source roots:
- `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp` (3322行) — 标记生命周期主引擎
- `src/hotspot/share/gc/g1/g1ConcurrentMarkThread.cpp` (449行) — 标记线程状态机
- `src/hotspot/share/gc/g1/g1ConcurrentMarkThread.hpp` (138行) — 状态定义
- `src/hotspot/share/gc/g1/g1ConcurrentMarkBitMap.hpp/cpp/inline.hpp` (82+127+98行) — 双缓冲位图
- `src/hotspot/share/gc/g1/g1ConcurrentMarkObjArrayProcessor.hpp/cpp` (77+59行) — 大数组分段
- `src/hotspot/share/gc/g1/satbMarkQueue.hpp/cpp` (132+358行) — SATB 缓冲区
- `src/hotspot/share/gc/g1/g1RegionMarkStatsCache.hpp/cpp/inline.hpp` (64+130+54行) — Region 统计
- `src/hotspot/share/gc/g1/collectionSetChooser.hpp/cpp` (321+203行) — CSet 选择
- `src/hotspot/share/gc/g1/g1StringDedup.hpp/cpp` (143+112行) — 字符串去重
- `src/hotspot/share/gc/g1/g1ConcurrentRefine.hpp/cpp` (501+139行) — 并发精炼
- `src/hotspot/share/gc/g1/g1ConcurrentRefineThread.hpp/cpp` (153+71行) — 精炼线程

Build: `make hotspot`

Key binaries:
- `build/linux-x86_64-normal-server-slowdebug/hotspot/variant-server/libjvm/debug/libjvm.so` — 标记引擎编译于此
- `build/linux-x86_64-normal-server-slowdebug/hotspot/variant-server/libjvm/gtest/g1ConcurrentMarkTest` — 单元测试

JVM flags:
```bash
# 启动标记相关参数
-XX:+UseG1GC
-XX:ConcGCThreads=2              # 并发标记线程数 (CMTask = ConcGCThreads)
-XX:ParallelGCThreads=4           # STW 阶段并行度
-XX:InitiatingHeapOccupancyPercent=45  # IHOP 标记启动阈值
-XX:G1MixedGCCountTarget=8        # Mixed GC 次数目标
-XX:G1HeapRegionSize=2m           # Region 大小
-XX:+UnlockDiagnosticVMOptions -XX:G1SummarizeConcMark  # 打印标记摘要
```

System call 速查表（文档中引用 man 2/3/5）：
| syscall | man | 标记中的使用 |
|---------|-----|------------|
| futex | man 2 futex | CGC_lock wait/notify，标记线程睡眠/唤醒 |
| sched_yield | man 2 sched_yield | SuspendibleThreadSet::should_yield → OS 让步 |
| mmap | man 2 mmap | 标记位图 (anonymous mapping) |
| pthread_create | man 3 pthread_create | 创建 CMTask worker 线程 |
| pthread_cond_wait | man 3 pthread_cond_wait | CGC_lock::wait 条件变量等待 |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **g1ConcurrentMark.cpp** | `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp` | 3322 | `pre_initial_mark`(:874), `post_initial_mark`(:884), `scan_root_regions`(:1047), `mark_from_roots`(:1102), `remark`(:1273), `cleanup`(:1526), `preclean`(:1901), `concurrent_cycle_abort`(:2240), `do_marking_step`(:2802), `regular_clock_call`(:2424), `drain_local_queue`(:2556), `drain_global_stack`(:2585), `try_stealing`(:?, find exact line in source) | 🔥 **标记引擎核心** — 7 阶段生命周期 + 13 CMTask |
| 2 | **g1ConcurrentMarkThread.cpp** | `src/hotspot/share/gc/g1/g1ConcurrentMarkThread.cpp` | 449 | `run_service(:?, 主循环)`, `sleep_before_next_cycle(:?)`, `do_concurrent_mark(:?)`, `set_started(:?)`, `should_terminate(:?)` | 🔥 **标记线程状态机** — CGC_lock wait/notify 循环 |
| 3 | **g1ConcurrentMark.hpp** | `src/hotspot/share/gc/g1/g1ConcurrentMark.hpp` | ~1300 | `G1ConcurrentMark` 类定义, `CMTask` 内嵌类, finger/region_idx 字段, `do_marking_step` 声明 | 🔥 **标记数据结构定义** |
| 4 | **g1ConcurrentMarkBitMap.hpp/cpp** | `src/hotspot/share/gc/g1/g1ConcurrentMarkBitMap.hpp` | 82+127 | `mark()/is_marked()`, `apply_to_marked_words()`, BitMap 基础操作, `swap_mark_bitmaps()` | **双缓冲位图** — 原子 swap，零拷贝过渡 |
| 5 | **satbMarkQueue.hpp/cpp** | `src/hotspot/share/gc/g1/satbMarkQueue.hpp` | 132+358 | `SATBMarkQueue::enqueue()`, `SATBMarkQueueSet::enqueue_completed_buffer()`, `set_active_all_threads()`, `apply_closure_to_completed_buffer()`, `filter()`, `flush()` | 🔥 **SATB Buffer 流** — 5 阶段管道 |
| 6 | **g1ConcurrentMarkObjArrayProcessor.hpp/cpp** | `src/hotspot/share/gc/g1/g1ConcurrentMarkObjArrayProcessor.hpp` | 77+59 | `process_array_chunk()`, `ObjArrayProcessor` — 大对象数组分段处理 | **大数组优化** — 防止 CMTask 在一段数组上耗尽时间配额 |
| 7 | **g1RegionMarkStatsCache.hpp/cpp** | `src/hotspot/share/gc/g1/g1RegionMarkStatsCache.hpp` | 64+130 | `add_live_bytes()`, `get()`, `evict()` — per-region live bytes 统计缓存 | **Region 活跃度** — Cleanup 阶段 CSet 选择依据 |
| 8 | **collectionSetChooser.hpp/cpp** | `src/hotspot/share/gc/g1/collectionSetChooser.hpp` | 321+203 | `sort_regions()`, `rebuild()`, `remove_and_move_to_next()`, `add_region()` | **CSet 选择器** — 按 reclaimable bytes 排序 Old Regions |
| 9 | **g1StringDedup.hpp/cpp** | `src/hotspot/share/gc/g1/g1StringDedup.hpp` | 143+112 | `enqueue_from_mark()`, `deduplicate()`, `StringDedupQueue`, `StringDedupTable` | **字符串去重** — 标记期间发现重复 String char[] |
| 10 | **g1ConcurrentRefine.hpp/cpp** | `src/hotspot/share/gc/g1/g1ConcurrentRefine.hpp` | 501+139 | `refine_card_concurrently()`, `refine()`, `RefineCardTableEntryClosure` | **并发精炼** — 标记结束后清理脏卡 |

---

## §四 Deep Dive Question Groups（≥7 组，EXACT questions + answer directions，每组含 counterfactual）

### 4.1 ★★★ SATB 语义: 为什么 G1 用 SATB 而 CMS 用 Incremental Update？

```
问题：
  ① SATB 的"逻辑快照"是什么？与物理快照的根本区别？
      答案方向: SATB 不复制堆内存，不 fork 进程。它在 Initial Mark 时记录所有
      根的初始状态，然后通过 pre-write barrier 捕获 mutator 修改的指针 OLD 值。
      标记线程遍历这些 old 指针找到的对象 → 看到的对象图是该对象在 Initial Mark
      时刻的"逻辑"可达性 → 即使后续 mutator 释放了引用，标记仍认为该对象 live
      （floating garbage）→ 产生一个周期的垃圾延迟。
      源码验证:
        - SATB pre-write barrier: g1BarrierSet.cpp 中的 write_ref_field_pre → 
          SATBMarkQueue::enqueue(old_value)
        - SATB drain: g1ConcurrentMark.cpp:drain_satb_buffers → 
          apply_closure_to_completed_buffer → mark the old pointed-to object
      
      追问: "逻辑快照"的一致性保证是什么？
      → 一致性意味着：任何在 Initial Mark 时从根可达的对象一定会被标记。
        证明: 一个对象 O 在 IM 时可达 → 存在一条路径 root→...→O。
        路径上的每个节点要么 (a) 在 bitmap scan 阶段被发现，要么 (b) 其引用
        被 mutator 覆盖，触发 pre-write barrier → old 指针进入 SATB buffer
        → marking 遍历 SATB buffer 发现 O。两种路径均覆盖。

  ② Counterfactual: 如果 G1 用 CMS 的 Incremental Update 而不是 SATB？
      答案方向: CMS 的 Incremental Update 在 post-write barrier 中标记被更新的
      灰对象 → Remark 阶段重新扫描这些灰对象以找新引用 → 但 CMS 的 remark 时
      间与被更新的灰对象数量成正比 → 在分配压力大时 remark 可能扩散 (cascading
      re-scan)。SATB 的 remark 不需要重新扫描灰对象——它只需要 drain SATB buffer
      和 weak ref 处理 → remark 时间由 completed buffer 数量和 weak ref 数量
      决定 → 更确定。但是 SATB 为此付出了 pre-write barrier 的代价（每个引用
      写入多一次读-比较-入队）。决策可以用数据量化：
        - 引用写入率 500M/s → CMS 0 额外开销，SATB ~2.5s CPU（5ns × 500M）
        - 但 CMS remark 200ms vs SATB remark 23ms
        - 结论：分配密集型应用 SATB 更优，引用密集型应用 CMS 更优
        实际中 G1 选择 SATB 因为当今的分配速率远超引用写入速率（对象大/多但不一定全被引用修改）。
```

### 4.2 ★★★ 标记生命周期全流程: Initial Mark → Root → Concurrent → Remark → Cleanup

```
问题：
  ① 为什么 Initial Mark 嵌入 Young GC？独立的坏处？
      答案方向: Initial Mark 需要 STW 来获得一致堆视图 —— 但 G1 不做额外的 STW。
      它在 Young GC 结束时 piggyback Initial Mark（g1CollectedHeap.cpp: 
      do_collection_pause_at_safepoint 末尾调用 G1ConcurrentMark::pre_initial_mark）。
      好处: 零额外停顿（IM 的工作量与 Young GC 的根扫描高度重叠）→ 停顿时间
      不变。坏处: Initial Mark 必须等 Young GC 触发 —— 如果 Eden 分配缓慢，
      标记启动延迟。
      源码: g1ConcurrentMark.cpp:874 pre_initial_mark — 获取 CGC_lock，
      检查 IM 是否已被请求。g1ConcurrentMark.cpp:884 post_initial_mark
      → set_active_all_threads(true) 启动 SATB recording。
      追问: 如果独立 Initial Mark (单独 STW)？→ 每个周期多 ~2ms 停顿，
      但标记启动可独立于 Young GC → 更快开始标记 → 更早完成 → 降低
      concurrent mode failure 风险。G1 也有 -XX:G1PeriodicGCInterval 作为 backup。
      
  ② Counterfactual: 如果 Initial Mark → Remark 全串行 STW 会怎样？
      答案方向: 全串行标记 (就像 Parallel GC): Initial Mark → Mark → Remark →
      Cleanup 全在 STW。优点: 简单、无并发一致性难题。缺点: 4GB heap 标记
      ~1.2s STOP THE WORLD → 每个 GC 周期停顿 1.2s → 应用程序线程全停
      → 延迟不可接受（API 响应超时、连接池断开、健康检查失败）。G1 用并发
      标记把 ~1.2s 标记时间分摊到 ~100 个 12ms 片段的并发时间中 → 单个
      停顿只有 Remark STW ~23ms + Cleanup STW ~12ms = 共 ~35ms → 远小于
      200ms pause target。
```

### 4.3 ★★★ CMTask 标记核心: do_marking_step 7 阶段 + regular_clock_call 6 条件

```
问题：
  ① do_marking_step 的 7 阶段全循环是怎样的？
      答案方向 (需在源码中找到精确行号):
        Phase 0: 初始化 — reset flags, recalculate step limits from 
          regular_clock_call results. 设置 attempted_region_bulk 标志.
        Phase 1: 初始 drain — drain_local_queue (先从 task 自身局部队列清空
          所有已发现但未标记的 oop) → drain_global_stack (从全局 stack 取待标记
          oop — 别人 steal 剩的回推) → drain_satb_buffers (完成 SATB buffer list)
        Phase 2: Bitmap 扫描循环 (main loop) — 对当前 region 从 finger 位置
          开始按 bitmap word 粒度量遍历 → claim_region 标记一个 region → 
          scan_object (扫描对象内的所有引用) → 推进 finger → 如果 region 扫完
          → 移动到下一 region (next_region())
        Phase 3: SATB drain — drain_satb_buffers again (phase 2 可能产生新的
          SATB buffer completed entries)
        Phase 4: 完全 drain — partially=false 标志，drain_local+global+SATB
          三重 drain，确保所有引用被完全发现
        Phase 5: Work stealing — try_stealing → 从其他任务的 global stack 
          steal 待处理 oop
        Phase 6: Termination Protocol — offer_termination (全局屏障):
          所有 task 必须同意所有活跃 task 已完成 → terminator 递增计数器
          → 最后一个 task 负责清理和通知
        Phase 7: 收尾 — overflow handling → if has_overflown() → 
          设置 has_aborted → barrier sync 唤醒所有 task 退出循环
      源码: g1ConcurrentMark.cpp:2802 do_marking_step (实现), :2424 regular_clock_call
      
      追问: 为什么 Phase 2 的 bitmap scan 需要用 claim_region CAS 锁定 region？
      → 多个 CMTask 并发扫描。每个 region 只能被一个 task 扫描。
        claim_region 不是真正的锁——它是全局计数器 _curr_region atomic++ 
        把每个 region 分配给唯一的 task。无锁设计，仅一个 atomic increment。
        开销 ~10ns per region (1 CAS), 对 2048 regions 仅 20µs 总开销。

  ② Counterfactual: 如果 do_marking_step 没有 work stealing 阶段？
      答案方向: 13 tasks 不均匀划分 region → 有些 task 扫完所有 region 后空闲
      其他 task 还在扫 → 任务不均衡 → total marking time 由最慢 task 决定
      (Amdahl's Law 的并行部分) → 标记时间延长 30-40%。Work stealing 保证
      空闲 task 窃取繁忙 task 的待处理队列 → 动态负载均衡 → 接近 N× 加速。
      源码: try_stealing (g1ConcurrentMark.cpp) 从 victim task 的 
      _global_transfer_finger 窃取。
```

### 4.4 ★★★ SATB Buffer 完整流: write_ref_field_pre → enqueue → filter → flush → drain

```
问题：
  ① SATB Buffer 从 mutator 写入到标记 drain 的完整 5 阶段流是什么？
      答案方向:
        Stage 1 (Mutator): 每次引用改写时，pre-write barrier 被调用。
          G1BarrierSet::write_ref_field_pre → 读取即将被覆盖的 oop 旧值
          → SATBMarkQueue()->enqueue(旧值) → 旧值写入 per-thread SATB buffer。
          Filter: 入队前检查旧值是否为 NULL（NULL 不记录）→ 对象不跨 region
          （？实际不做 region 检查但减少 NULL 记录）。
        Stage 2 (Buffer 满): SATB buffer 有 64 个 entries。当 bottom 到达
          active 指针 → buffer 满 → enqueue_completed_buffer → 将 buffer 
          node 加入全局 _completed_buffers 链表（SATBMarkQueue_lock 保护）
          → notify 标记线程。
        Stage 3 (Flush): 在 safepoint 或线程切换时 → SATBMarkQueue::flush()
          → 将半满 buffer（通过 active 指针截断）也推入 completed list
          → 防止 mutator 长期持有未发 buffer 中的旧指针导致标记不完整。
        Stage 4 (Completed Queue): 全局链表 _completed_buffers 是 SATBMarkQueueSet
          的单链表。标记线程通过 apply_closure_to_completed_buffer 遍历链表
          → 对每个 buffer 的每个 entry → 应用 mark closure → 遍历 entry
          指向的对象图 → 标记 reachable objects。链表遍历期间 mutator 
          可能同时追加新 buffer → 遍历完成后再次检查是否有新增。
        Stage 5 (Drain 完成 + 关闭): remark 阶段 → finalize_marking → 
          drain all SATB → 所有 buffer 处理完 → set_active_all_threads(false)
          → SATB recording 关闭 → subsequent pre-write barrier 变为空操作
          （不记入队）。直到下一个周期 post_initial_mark 重新开启。
      源码: satbMarkQueue.cpp (enqueue, flush, drain, set_active_all_threads)
      
      追问: 为什么 SATB 用 2-pointer (bottom/active) 而不是 1-pointer ring buffer？
      → 2-pointer 允许直接 memcpy 而无需处理 wrap-around → 单次 memcpy 
        复制所有 entries → 比逐个处理 ring 中的每个元素快 ~3×（连续内存）。
        额外好处: flush 时只需移动 active 指针，无需复制数据。

  ② Counterfactual: 如果 SATB buffer 无 filter 机制（记录所有 NULL 旧值）？
      答案方向: NULL 旧值被入队 → 标记线程 drain 时对每个 NULL entry 应用
      mark closure → 无效遍历 → 浪费标记 CPU 时间。在一个典型的应用中，引用
      写入中 ~60% 是对新分配对象（旧值为 NULL）→ 无 filter 会让 SATB buffer
      填充速率增加 2.5× → completed buffer 更多 → overflow 更容易触发 → 
      标记周期更可能 abort → Full GC 频率增加。filter 只减少 ~2ns 开销，
      但对 SATB 容量需求减少 ~60% 是决定性的。
```

### 4.5 ★★★ Remark 为什么需要 STW: 4 个必须 pause 的原因

```
问题：
  ① Remark 不能像 concurrent mark 一样完全并发执行的 4 个根本原因？
      答案方向:
        Reason 1 — SATB Buffer 一致性: concurrent mark 结束时，mutator 
          仍在产生 SATB buffer entries（不断写入旧指针）。Remark 必须 drain 
          所有剩余的 SATB buffers → 但 mutator 同时产生新 entries → 永远
          追不上。解决: STW 停止所有 mutator → 最后 drain → 然后 set_active_all_
          threads(false) 关闭 SATB recording → after STW, pre-write barrier
          变为空操作 → 新的旧指针不再被记录。
        Reason 2 — 一致堆视图: finalize_marking 扫描所有线程栈 (thread stack
          roots) + 所有强根 (JNI handles, StringTable, SystemDictionary)
          → 如果线程在并发标记时修改栈帧（push 新 frame 或 pop frame），
          栈扫描可能漏对象。STW 保证所有线程在安全点 → 栈帧稳定。
        Reason 3 — 原子 bitmap swap: swap_mark_bitmaps() 交换 prev/next 
          bitmap 指针 → 必须在没有任何线程读/写 bitmap 时进行 → STW 
          保证互斥。
        Reason 4 — Weak Reference 完整性: weak_refs_work 处理 Soft/Weak/
          Phantom/Final 引用 → 必须知道哪些引用对象是 live (被强引用标记)
          → 只能在所有标记完成后进行 → STW 简化并发引用发现的协调难度。
      源码: g1ConcurrentMark.cpp:1273 remark → finalize_marking → 
        weak_refs_work → swap_mark_bitmaps
      
      追问: 能否通过更复杂的协议使 remark 也并发？
      → 学术上可行 (e.g., 双 SATB buffer 双缓冲 + fencing protocol) 但实现
        复杂度爆炸 (需 handle 边界条件数十个)。HotSpot 在 JDK 12 的 
        Shenandoah 中使用 Brooks Pointer 实现全并发 (包括引用处理)，
        但代价是指针追逐的硬件 cache 开销。G1 选择了工程稳定性。

  ② Counterfactual: 如果 remark 不做 STW 而做"最后一轮 drain 并关闭 SATB"？
      答案方向: 关闭 SATB recording (set_active_all_threads(false)) 后，
        某些 mutator 已经执行了 pre-write barrier 的"读取旧值"步骤，但还未
        入队 → 旧值丢失 → 如果对象仅通过该引用可达 → 对象被错误回收 (live 
        object reclaimed) → JVM crash 或数据损坏。只有 STW 保证 barrier 的
        read-enqueue 是原子完成的 —— 所有线程在安全点保证已完成的 barrier 
        调用已完整入队。
```

### 4.6 ★★★ Cleanup + CSet 重建: reclaim → compute_new_sizes → Chooser::rebuild → sort

```
问题：
  ① Cleanup 阶段的具体步骤和每步的作用？
      答案方向:
        Step 1: reclaim_empty_regions — 遍历所有 Region 检查标记结果:
          如果 region 的 live_bytes == 0 → region 完全可回收 → 
          从 Old set 中移除 → Free list 添加 → 立即可用于分配 → 零延迟回收。
          这是 Cleanup 中唯一"直接回收"的操作 —— 不需要 evacuation。
        Step 2: compute_new_sizes — 根据标记结果重新计算 Heap 大小。
          分析旧 region 的 live bytes 分布 → 决定是否需要扩大或缩小堆 → 
          基于 G1Analytics 的预测模型。
        Step 3: finalize_marking (已在 remark 完成或再次确认) → 
          weak_refs_work 完成 → swap_mark_bitmaps 原子交换 →
          现在 prev_bitmap 持有本轮标记结果。
        Step 4: Chooser::rebuild — 重建 CollectionSet 选择器。
          遍历所有 Old region → 根据 live_bytes (从 g1RegionMarkStatsCache 
          读取) 计算 reclaimable_bytes = capacity - live_bytes → 
          只有 reclaimable_bytes > 0 的 region 进入备选池 →
          按 reclaimable_bytes 从大到小排序 (sort_regions)。
          排序用 qsort (标准库) → 排序后 CSet 选择从最大回收量的 region 开始。
        Step 5: RSet 更新 — finalize conc rset updating — 并发精炼线程
          完成的 RSet 更新的收尾清理。
        Step 6: 记账 — 记录 marking cycle statistics → 供下一周期 G1Policy 决策。
      源码: g1ConcurrentMark.cpp:1526 cleanup → reclaim_empty_regions → 
        compute_new_sizes → collectionSetChooser.cpp:rebuild → sort_regions
      
      追问: 为什么 Cleanup 中只有"完全空的 region"才被立即回收？
      → 部分回收 (partially empty region) 需要 evacuation — 将 live objects 
        复制到新 region → 不能在 Cleanup (单线程/STW) 中完成 → 留给 Mixed GC
        (多 worker evacuation)。

  ② Counterfactual: 如果 Cleanup 也做部分回收 (compact 旧 region)？
      答案方向: Cleanup 是单线程 STW → compaction of 1 region (move all 
        live objects + update all references) 可能耗时 10-50ms → 如果 100 个
        旧 region → 500ms-5s STW — 违反 200ms pause target。G1 解耦回收:
        Cleanup 只做零拷贝 (empty region → free list)，evacuation 由 Mixed GC 
        多 worker 并行完成 → 每个 Mixed GC 回收 6-8 个 region → 单个 pause 
        ~20ms → 满足目标。这是一个显式的设计决策——不是实现限制。
```

### 4.7 ★★★ 标记中止与恢复: concurrent_cycle_abort 8 检查点 + overflow restart

```
问题：
  ① 8 个 abort 检查点的完整位置和作用？
      答案方向 (从 tracer 提取):
        Check #1 (SCAN_ROOT_REGIONS): 根扫描结束时检查 _has_aborted →
          如果 true → 跳过 mark_from_roots → 直接终止
        Check #2-4 (MARK_FROM_ROOTS): do_marking_step 中在 Phase 2 
          bitmap scan 和 Phase 6 termination protocol 中多次检查
          has_overflown() → if overflow → set_has_aborted
        Check #5 (REMARK): remark 开始前检查 _has_aborted → 
          如果 aborted → 跳过 STW remark → 减少不必要停顿
        Check #6 (REBUILD_REM_SETS): 重建 Remembered Sets 前检查 →
          如果 aborted → 跳过（重建无意义）
        Check #7 (CLEANUP): cleanup 中检查 _has_aborted →
          如果 aborted → reclaim_empty_regions 仍执行（回收空region永远有益）
          但跳过 compute_new_sizes + Chooser::rebuild
        Check #8 (CYCLE_END): concurrent_cycle_end 中检查 
          should_terminate + _has_aborted → 决定是否重启标记
      源码: g1ConcurrentMark.cpp:2240 concurrent_cycle_abort; 
        g1ConcurrentMarkThread.cpp run_service 循环中的 abort 检查
      
      追问: 为什么溢出时要"完全重启标记"而不是"从断点继续"？
      → SATB overflow 意味着 marking 可能遗漏对象（queue 容量不足丢弃了 
        buffer entries）→ 当前的标记结果不完整且不可信 → 必须从头重新扫描。
        overflow 后 full restart 的代价是丢失本轮所有标记进度（~0.6-1.2s 
        浪费）→ 但这是保证标记正确性的最低代价。

  ② Counterfactual: 如果 SATB overflow 不 abort 标记而继续？会发生什么？
      答案方向: 丢弃的 SATB buffer entries 包含即将被覆盖的旧指针 → 
        这些旧指针指向的对象可能仍然 live → 但 marking 没有遍历它们 → 
        live object 被标记为 dead → Cleanup 回收 → live object's memory 
        被重用为新对象的分配 → 两个 live objects 共享同一块内存 → 
        JVM crash (SIGSEGV) 或 silent data corruption。溢出 abort 
        是正确性强制要求，不是性能优化。
```

---

## §五 Article Structure

```
§〇 生产场景 — Concurrent Mode Failure 导致 Full GC
  ★ 真实日志: marking 1.25s → concurrent mode failure → Full GC 923ms
  ★ Root cause: allocation rate > mark rate → Eden fills before mark complete
  ★ 三步诊断: jstat -gccause → GDB marking cycle → strace futex contention
  ★ 反事实分析: SATB vs Incremental Update trade-off; yield 必要性

§一 ★★★ 并发标记生命周期全链路源码走读
  ❓ 这不是概念概述——这是从 wakeup 到 bitmap swap 的代码级追踪
  1.1 SATB 逻辑快照理论基础 — 三色标记 + 快照语义 + pre-write barrier
  1.2 标记启动决策链 — IHOP → maybe_start_marking → decide_on_conc_mark_initiation
  1.3 Initial Mark piggyback — pre_initial_mark → post_initial_mark → set_active_all_threads
  1.4 Root Region 并发扫描 — scan_root_regions 利用并行硬件
  1.5 并发标记主循环 — mark_from_roots → 13 CMTask spawned → do_marking_step
  1.6 CMTask 7 阶段 + 6 条件 yield — regular_clock_call 与 overflow
  1.7 SATB Buffer 完整流 — write_ref_field_pre → enqueue → filter → flush → drain
  1.8 Preclean — 引用预清理 + discovered refs drain
  1.9 Remark STW — 4 个必须 pause 的原因 → finalize_marking → swap_bitmaps
  1.10 Cleanup + CSet 重建 — reclaim_empty → compute_new → Chooser::rebuild
  1.11 标记中止与恢复 — 8 abort 检查点 + overflow restart
  1.12 String Dedup + Concurrent Refinement — 辅助子系统
  1.13 ★ Mermaid 序列图: 标记全生命周期 + SATB buffer 流
       Lanes: Mutator / SATB Buffer Queue / CMTask / Marking Thread / G1Policy
  1.14 ★ 面试 Story Format 答案 — 从 IHOP 触发到 bitmap swap 的完整叙事

§二 ★★★ Beginner Callout 框 (≥8 个)
  2.1 SATB (Snapshot At The Beginning) — 逻辑快照含义
  2.2 Dual Marking Bitmap — prev/next 双缓冲设计
  2.3 CMTask finger — 扫描前沿指针
  2.4 Work Stealing in Marking — 标记任务窃取
  2.5 SATB Buffer Flow — 5 stage pipeline
  2.6 regular_clock_call — 6 condition yield
  2.7 Concurrent Mode Failure — overflow + abort
  2.8 Marking Thread State Machine — CGC_lock wait/notify

§三 ★★ 标记性能剖析
  ❓ 标记速度的决定因素: allocation rate vs mark rate race
  ❓ SATB buffer 高水位与 overflow 阈值
  ❓ CMTask 13 threads 的 scalability — Amdahl's Law 实践
  3.1 Mark rate 分析: marking thread×13 + mutator allocation rate 方程
  3.2 Overflow 条件: SATB completed buffer count > threshold 定量分析
  3.3 标记与分配的时间竞逐 — 为什么 1.25s 标记对 4GB heap 是瓶颈
  3.4 ConcGCThreads 13 的 scalability — 并发度调优

§四 ★ GDB 断点验证 — 7 断点完整标记追踪
  断言 1: Initial Mark → pre_initial_mark CGC_lock 获取
  断言 2: SATBMarkQueue::enqueue — verify pre-write barrier
  断言 3: CMTask::do_marking_step entry — finger + region index
  断言 4: regular_clock_call 6 condition check — verify yield behavior
  断言 5: CMBitMap::mark() — verify dual bitmap write
  断言 6: Remark STW — verify satb drain complete + swap bitmap
  断言 7: Cleanup — verify reclaim_empty_regions + Chooser::rebuild

§五 ★ Cross-Reference
  ❓ 01-02-G1-Heap-Startup — 堆布局 + Region 类型初始化
  ❓ 01-08-G1-Policy-Analytics — IHOP trigger + Analytics 预测
  ❓ 01-09-G1-Concurrent-Marking-Infra — CM infrastructure, 双 Bitmap
  ❓ 30-01-Young-GC — Young GC piggybacks initial mark
  ❓ 30-03-Mixed-GC — Mixed GC uses cleanup results
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because SATB's logical snapshot guarantees no live object at initial mark is missed, the pre-write barrier captures old pointer values..." — not "G1 uses SATB."

2. **3-5 lines source code per claim** — paste relevant C++ code from g1ConcurrentMark.cpp / g1ConcurrentMarkThread.cpp / satbMarkQueue.cpp, do not describe it in abstract.

3. **Mermaid diagram** — concurrent marking lifecycle sequence diagram. 5 lanes: Mutator Application / SATB Buffer Queue / CMTask Worker / Marking Thread / G1Policy. Complete flow: `G1Policy::need_to_start_conc_mark` → `pre_initial_mark` → `post_initial_mark` → `scan_root_regions` → `mark_from_roots` → `do_marking_step` 7 phases → `preclean` → `remark` → `cleanup` → `swap_bitmaps`. Annotate every step with file:line. Second Mermaid: SATB buffer flow from write_ref_field_pre to drain.

4. **GDB session** — ≥7 breakpoints with exact file:line numbers (find actual line numbers from source, do not use `?`):
   - `g1ConcurrentMark.cpp:874` pre_initial_mark — verify CGC_lock acquisition
   - `satbMarkQueue.cpp` enqueue — verify pre-write barrier old value
   - `g1ConcurrentMark.cpp:2802` do_marking_step entry — verify _finger, _region_idx
   - `g1ConcurrentMark.cpp:2424` regular_clock_call — verify 6 yield conditions
   - `g1ConcurrentMarkBitMap.cpp` mark() — verify dual bitmap
   - `g1ConcurrentMark.cpp:1273` remark — verify STW + satb drain + swap
   - `g1ConcurrentMark.cpp:1526` cleanup — verify reclaim + chooser rebuild
   Each with expected variable values to verify.

5. **≥8 Beginner callout boxes** — exact text from §一: SATB, Dual Bitmap, CMTask finger, Work Stealing, SATB Buffer Flow, regular_clock_call, Concurrent Mode Failure, State Machine.

6. **Cross-reference at five points**:
   - At `pre_initial_mark` → "→ 01-08-G1-Policy-Analytics for IHOP trigger decision"
   - At `scan_root_regions` → "→ 01-02-G1-Heap-Startup for root region tracking setup"
   - At `do_marking_step` → "→ 01-09-G1-Concurrent-Marking-Infra for CMTask initialization"
   - At Cleanup/Chooser → "→ 30-03-Mixed-GC for Mixed GC CSet execution"
   - At `g1ConcurrentMark constructor` → "→ 01-09-G1-Concurrent-Marking-Infra for bitmaps + CMTasks init"

7. **Story-format interview answer** — at §一末尾: 从 `IHOP threshold crossed` 到 `bitmap swap complete` 的完整叙事。Three parts: "启动决策和 Initial Mark 的 piggyback" + "并发标记核心 do_marking_step + SATB drain" + "STW Remark 收尾 + Cleanup 重建 CSet".

8. **不要写成→应该写成对照表**:

| 不要写成 | 应该写成 |
|---------|---------|
| "G1 使用 SATB 来实现并发标记" | "G1 的 SATB 协议通过 pre-write barrier (g1BarrierSet.cpp:write_ref_field_pre → SATBMarkQueue::enqueue) 捕获被覆盖的旧 oop 指针，保证标记线程看到 Initial Mark 时刻的堆逻辑快照，代价是每个引用写入约 5ns 的 compare-and-enqueue 开销" |
| "do_marking_step 是标记循环的核心" | "do_marking_step (g1ConcurrentMark.cpp:2802) 是一个 7 阶段终止检测循环：Phase 0 初始化→Phase 1 drain→Phase 2 bitmap 扫描→Phase 3 SATB drain→Phase 4 完全 drain→Phase 5 work stealing→Phase 6 termination protocol→Phase 7 收尾 overflow handling。每一步的推进由 regular_clock_call 6 条件 yield 控制" |
| "SATB buffer 缓冲旧指针" | "SATB buffer 是 per-thread 的 64-entry 双指针 (bottom/active) 队列。当 mutator 改写引用时，pre-write barrier 将旧 oop 入队 (satbMarkQueue.cpp:enqueue)。buffer 满时通过 enqueue_completed_buffer 将 buffer 节点加入全局 completed list (SATBMarkQueue_lock 保护)，标记线程通过 drain_satb_buffers 遍历 completed list 并应用 mark closure" |
| "Remark 阶段需要 stop the world" | "Remark (g1ConcurrentMark.cpp:1273) 必须 STW 因为 4 个并发安全条件：(1) 必须 drain 所有 SATB buffer 并关闭 recording，防止丢失引用；(2) 必须从一致栈帧扫描所有线程根 (finalize_marking)；(3) bitmap swap 必须在无并发读写时原子完成；(4) weak reference 处理必须在所有强标记完成后进行" |
| "标记溢出时会中止" | "当 SATB completed buffer 数量超过阈值或 allocation 快于 marking 时，has_overflown() 返回 true → set_has_aborted → concurrent_cycle_abort (g1ConcurrentMark.cpp:2240) 在 8 个检查点之一拦截 → 标记从头重启。溢出后继续标记会导致 live objects 被错误回收→JVM crash" |

---

## §七 Output Format

- Markdown file, named `02-Concurrent-Marking-Lifecycle.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/30-g1-runtime-gc/docs/`
- 元信息头:

```
> **阶段**：[30-g1-runtime-gc] — G1 并发标记运行时
> **前置**：[01-02-G1-Heap-Startup]（堆布局 + Region 初始化）、[01-08-G1-Policy-Analytics]（G1Policy IHOP 触发）、[01-09-G1-Concurrent-Marking-Infra]（CM infrastructure, 双 Bitmap, CMTask×13）
> **配套**：[30-01-Young-GC]（Young GC piggybacks initial mark）、[30-03-Mixed-GC]（Mixed GC 使用 cleanup 结果）、[30-04-Full-GC]（concurrent mode failure 触发 Full GC）
> **后续依赖本文**：[30-03-Mixed-GC]（CSet Chooser 重建 → Mixed GC 候选 region 选择）
> **阅读收益**：追踪 G1 并发标记从 IHOP 触发到 bitmap swap 的完整 7 阶段生命周期——理解 SATB 逻辑快照与 CMS Incremental Update 的设计差异、CMTask do_marking_step 的 7 阶段循环与 regular_clock_call 6 条件 yield、SATB Buffer 从 write_ref_field_pre 到 drain 的 5 阶段管道流、Remark 必须 STW 的 4 个并发安全原因、Cleanup 中 reclaim_empty_regions 和 CSet Chooser::rebuild 的重建逻辑、标记溢出与 8 位置 abort 恢复机制；掌握 "Concurrent Mode Failure → Full GC" 的完整诊断路径
```

- 目标行数: 2000+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "G1 使用 SATB" 而不展示 pre-write barrier 的完整源码 (write_ref_field_pre → enqueue) — 必须从 barrier 调用点到 SATB buffer drain 完整追踪
- ❌ 不解释 SATB vs Incremental Update 的设计差异 — 必须展示两者的 barrier 不同 (pre vs post)、remark 工作量方程、适用场景对比表
- ❌ 只说 "do_marking_step 是标记循环" 而不展示 7 个阶段 — 必须逐阶段展示源码、每个阶段的 yield 时机、与 regular_clock_call 的交互
- ❌ 忽略 SATB Buffer 的完整流 — 必须展示从 write_ref_field_pre 到 drain 的 5 阶段管道 (mutator enqueue → filter → completed list → drain → close)
- ❌ 把 remark 当作"另一个 pause"一笔带过 — 必须解释 4 个必须 STW 的原因 + 每个原因对应的源码
- ❌ 不讲标记溢出和中止机制 — 必须展示 8 个 abort 检查点 + overflow 条件 + 重启代价
- ❌ 忽略双 Bitmap (prev/next) 的设计 — 必须展示 swap_mark_bitmaps 的原子交换 + 为什么需要双缓冲
- ❌ 不讲 CMTask work stealing 和 termination protocol — 必须展示 try_stealing + offer_termination 的全局屏障
- ❌ 忽略 Cleanup 中的 CSet Chooser 重建 — 必须展示 rebuild → sort_regions → 按 reclaimable bytes 降序排列
- ❌ 忘记交叉引用 — 必须引 01-09 (infra), 01-08 (IHOP), 30-01 (Young GC piggyback), 30-03 (Mixed GC)
- ❌ 不解释 C 语言基础或 JVM 基本概念

---

## §九 Required（≥8）

- ✅ **★ Mermaid 标记全生命周期序列图** — 5 lanes: Mutator / SATB Buffer / CMTask / Marking Thread / G1Policy — IHOP触发 → pre_initial_mark → scan_root_regions → mark_from_roots → do_marking_step → preclean → remark → cleanup → swap_bitmaps
- ✅ **★ Mermaid SATB Buffer 流图** — 5 stage pipeline: write_ref_field_pre → enqueue → filter → completed list → drain → close
- ✅ **★ do_marking_step 7 阶段完整源码** — g1ConcurrentMark.cpp:2802 附近 — 每个阶段的代码 + 注释行号
- ✅ **★ regular_clock_call 6 条件 yield 源码** — g1ConcurrentMark.cpp:2424 附近
- ✅ **★ SATBBuffer 完整流源码** — satbMarkQueue.cpp enqueue + filter + flush + drain + set_active_all_threads
- ✅ **★ Remark 4 原因分析表** — 每个原因 + 对应的源码行 + 如果不 STW 的后果
- ✅ **★ Cleanup 步骤源码** — reclaim_empty_regions + compute_new_sizes + Chooser::rebuild + sort_regions
- ✅ **★ 8 abort 检查点位置表** — 每个检查点的源码位置 + 触发条件 + 处理方式
- ✅ **★ ≥8 Beginner Callout 框** — exact text from §一: SATB, Dual Bitmap, CMTask finger, Work Stealing, SATB Buffer Flow, regular_clock_call, Concurrent Mode Failure, State Machine
- ✅ **★ 面试 Story Format 答案** — §一末尾，从 IHOP trigger 到 bitmap swap 的完整叙事
- ✅ **★ GDB 断点 ≥7 条** — 精确到 file:line，每断点有预期变量值，覆盖 marking lifecycle + SATB + bitmap
- ✅ **★ Cross-Reference 5 处** — 01-02 (Heap), 01-08 (Policy/IHOP), 01-09 (Infra), 30-01 (Young GC), 30-03 (Mixed GC)
- ✅ **★ "不要写成→应该写成" 对照表** — ≥5 行，覆盖 SATB/do_marking_step/SATB Buffer/Remark/Overflow

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: Initial Mark CGC_lock 获取 (g1ConcurrentMark.cpp:874)
  (gdb) break g1ConcurrentMark.cpp:874
  (gdb) condition 1 _cm->should_terminate() == false
  运行: java -XX:+UseG1GC -XX:+G1PeriodicGCInterval=1000 -cp app.jar App
  (gdb) print _cm->_state → 期望: "Idle" 或 "Marking"
  (gdb) print _cm->_gc_tracer_cm->gc_id() → 期望: 非 0 值 (GC ID)
  (gdb) continue → 进入 post_initial_mark

断言 2: SATB pre-write barrier enqueue (satbMarkQueue.cpp enqueue)
  (gdb) break SATBMarkQueue::enqueue
  触发: mutator 线程执行任何引用赋值 (e.g., obj.field = new_value)
  (gdb) print pre_val → 期望: 旧 oop 指针 (非 NULL 或 NULL)
  (gdb) print _buf.active() → 期望: active 指针
  (gdb) print _buf.bottom() → 期望: bottom 指针
  (gdb) print active - bottom → 期望: buffer 中当前 entry 数 (0-63)
  (gdb) continue → 几个 enqueue 后检查:
  (gdb) print active - bottom → 期望: 增加了 1

断言 3: CMTask::do_marking_step entry (g1ConcurrentMark.cpp:2802)
  (gdb) break g1ConcurrentMark.cpp:2802
  (gdb) print this->_task_id → 期望: 0-12 (ConcGCThreads)
  (gdb) print this->_finger → 期望: HeapWord* 当前扫描位置
  (gdb) print this->_region_idx → 期望: region index
  (gdb) print G1CollectedHeap::heap()->num_regions() → 期望: 总 region 数
  (gdb) print _cm->_global_finger → 期望: 全局扫描进度
  (gdb) continue → 经过几个 do_marking_step 循环:
  (gdb) print this->_finger → 期望: 比之前推进了

断言 4: regular_clock_call 6 条件 yield (g1ConcurrentMark.cpp:2424)
  (gdb) break g1ConcurrentMark.cpp:2424
  (gdb) print _cm->has_overflown() → 期望: false (通常情况)
  (gdb) print _cm->has_aborted() → 期望: false
  (gdb) print SuspendibleThreadSet::should_yield() → 期望: false
  (gdb) print _time_target_ms → 期望: 本次步进的时间配额 (ms)
  (gdb) print _cm->_completed_buffers_num → 期望: SATB buffer 数量
  (gdb) print _cm->concurrent() → 期望: true (并发模式)
  (gdb) continue → 检查 yield 是否触发:
  (gdb) print _has_aborted → 期望: 保持 false 或变为 true (如果 overflow)

断言 5: CMBitMap mark 操作 (g1ConcurrentMarkBitMap.cpp mark)
  (gdb) break g1ConcurrentMarkBitMap.cpp:mark (找实际行号)
  (gdb) print addr → 期望: 待标记的 oop 地址
  (gdb) print _prev_mark_bitmap.is_marked(addr) → 期望: false (首次标记)
  (gdb) print _next_mark_bitmap.is_marked(addr) → 期望: false (写入前)
  (gdb) continue → 经过 mark 操作:
  (gdb) print _next_mark_bitmap.is_marked(addr) → 期望: true (标记后)
  (gdb) print _prev_mark_bitmap.is_marked(addr) → 期望: 仍为 false (双缓冲隔离)

断言 6: Remark STW — SATB drain + bitmap swap (g1ConcurrentMark.cpp:1273)
  (gdb) break g1ConcurrentMark.cpp:1273  (remark 入口)
  (gdb) print _cm->concurrent() → 期望: false (已退出并发模式)
  (gdb) print _cm->_completed_buffers_num → 期望: SATB buffer 数
  运行到 finalize_marking:
  (gdb) print _cm->weak_refs_work() → 期望: 开始弱引用处理
  运行到 swap_mark_bitmaps:
  (gdb) print _prev_bitmap.base() → 期望: 旧 bitmap 地址
  (gdb) print _next_bitmap.base() → 期望: 新 bitmap 地址
  (gdb) continue → swap 完成后:
  (gdb) print _prev_bitmap.base() → 期望: 指向原来的 next (已交换)
  (gdb) print _next_bitmap.base() → 期望: 指向原来的 prev
  (gdb) print _cm->_completed_buffers_num → 期望: 0 (全部 drain 完毕)

断言 7: Cleanup — reclaim_empty_regions + CSet Chooser rebuild (g1ConcurrentMark.cpp:1526)
  (gdb) break g1ConcurrentMark.cpp:1526  (cleanup 入口)
  (gdb) print _g1h->num_regions() → 期望: 总 region 数
  运行到 reclaim_empty_regions:
  (gdb) print reclaimed_count → 期望: 被回收的完全空 region 数 (≥0)
  运行到 Chooser::rebuild:
  (gdb) print chooser->num_remaining() → 期望: 候选 region 数
  (gdb) print chooser->remaining_reclaimable_bytes() → 期望: 可回收字节总数
  运行到 sort_regions:
  (gdb) print chooser->peek().reclaimable_bytes → 期望: 最大回收量的 region
  (gdb) continue
  (gdb) print chooser->peek().reclaimable_bytes → 期望: 下一个 (已消费最大)

断言 8: SATB buffer 完整 drain (apply_closure_to_completed_buffer)
  (gdb) break SATBMarkQueueSet::apply_closure_to_completed_buffer
  (gdb) print _completed_buffers_num → 期望: >0
  (gdb) print buffer_node->index() → 期望: buffer index
  单步遍历 buffer 中的 entries:
  (gdb) print *entry_ptr → 期望: 有效的 HeapWord* (oop 旧指针)
  (gdb) continue → buffer drain 完成:
  (gdb) print _completed_buffers_num → 期望: 减少了
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §二.3 承接**：本文展开 README §二.3 的 "标记生命周期 + SATB 语义 + CMTask 并行 + Cleanup + Eager Reclaim + String Dedup" 全部 6 个子主题 —— 从 `pre_initial_mark` 到 `swap_mark_bitmaps` 的完整代码级解答。

2. **从 README §一 承接**：Phase 01 的 01-09 仅覆盖 G1ConcurrentMark 构造函数 (双 Bitmap + CMTask×13)，本文展开 README 中 "并发标记运行时" 的全部 5 个子主题：
   - 标记生命周期 — §一 1.2-1.3 + §四 4.2
   - SATB 语义详解 — §一 1.1 + §四 4.1 + §四 4.4
   - CMTask 并行标记 — §一 1.5-1.6 + §四 4.3
   - Cleanup + Region 活跃度 — §一 1.10 + §四 4.6
   - Eager Reclaim + String Dedup — §一 1.12 (轻量引入，深入留给 30-00)

3. **同组边界**:
   - `30-00-Region-Runtime` — Region 状态机 + 对象分配路径。本文依赖其 Region 类型系统 (Free/Eden/Old) 理解标记日志中的 region type。
   - `30-01-Young-GC` — Young GC 完整生命周期。Initial Mark piggybacks 在 Young GC 末尾 (do_collection_pause_at_safepoint) → 本文 §一 1.3 解释 IM 如何切入。
   - `30-02-Concurrent-Marking` — **本文**。从 IM 到 Cleanup 的标记引擎。
   - `30-03-Mixed-GC` — Mixed GC 策略决策。Cleanup 重建的 CSet Chooser 是 Mixed GC 的输入 → 本文 §四 4.6 输出 CSet Chooser。
   - `30-04-Full-GC` — 最后手段。Concurrent Mode Failure (本文 §〇) 是 Full GC 的常见触发条件。

4. **全部文档共享 §一 开头语**: "Reader completed 01-09-G1-Concurrent-Marking-Infra (G1ConcurrentMark constructor, dual bitmaps, CMTask×13 initialization) and 01-08-G1-Policy-Analytics (G1Policy 8 sub-components, Analytics 17 TruncatedSeq, IHOP control). This doc: how the marking lifecycle actually runs — from pre_initial_mark through do_concurrent_mark to cleanup."

5. **从 research-02-summary 承接**：本文完全展开 research 中标记的所有发现：
   - do_marking_step 7 阶段 → §四 4.3
   - regular_clock_call 6 条件 → §四 4.3
   - remark STW 4 原因 → §四 4.5
   - cleanup 流程 → §四 4.6
   - SATB Buffer 完整流 → §四 4.4
   - 标记线程状态机 → §四 4.2
   - 8 abort 检查点 → §四 4.7
