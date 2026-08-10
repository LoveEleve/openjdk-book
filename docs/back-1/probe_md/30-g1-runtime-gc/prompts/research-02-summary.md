# Phase 30 doc-02 分析汇总：Concurrent Marking Lifecycle

## 范围
Initial Mark → Root Region Scan → Concurrent Mark → Preclean → Remark → Cleanup → Abort

## 源文件和符号（scout-3 定位）

### 核心文件
- g1ConcurrentMark.cpp (3322行) — 标记生命周期 + CMTask
- g1ConcurrentMarkThread.cpp (449行) — 标记线程循环
- g1ConcurrentMarkBitMap (82+127+98行) — 双缓冲位图
- g1ConcurrentMarkObjArrayProcessor (77+59+36行) — 大数组分段
- satbMarkQueue.hpp/cpp (132+358行) — SATB 队列
- g1RegionMarkStatsCache (64+130+54行) — Region 活跃度统计
- collectionSetChooser (321+203行) — CSet 选择器
- g1StringDedup (143+112行) — 字符串去重
- g1ConcurrentRefine (501+139行) — 并发精炼
- g1ConcurrentRefineThread (153+71行) — 精炼线程

### 生命周期入口
- pre_initial_mark (:874) → post_initial_mark (:884)
- scan_root_regions (:1047) → scan_root_region (:1011)
- mark_from_roots (:1102)
- preclean (:1901) → remark (:1273) → cleanup (:1526)
- concurrent_cycle_abort (:2240)

### CMTask 方法
- do_marking_step (:2802) — 7 阶段标记循环
- drain_local_queue (:2556) / drain_global_stack (:2585)
- regular_clock_call (:2424) — 6 条件 yield

## 实现细节（reader-3 提取）

### do_marking_step 7 阶段
Phase 0: 初始化 (reset flags, recalculate limits)
Phase 1: 初始 drain (drain SATB + local queue + global stack)
Phase 2: BITMAP 扫描循环 (iterate bitmap, claim region, scan, retry)
Phase 3: SATB drain (drain_satb_buffers)
Phase 4: 完全 drain (partially=false)
Phase 5: Work Stealing (try_stealing)
Phase 6: Termination Protocol (offer_termination)
Phase 7: 收尾 (overflow handling → barrier sync)

### regular_clock_call 6 条件 yiled
1. has_overflown 2. Full GC abort 3. STS::should_yield
4. 时间配额用完 5. SATB buffer 累积 6. !concurrent跳过

### remark 需要 STW 的 4 个原因
1. SATB 一致性: mutator 持续产生 buffer，必须 STW drain
2. 一致堆视图: finalize_marking 扫描所有线程栈+强根+SATB
3. 原子性操作: swap_mark_bitmaps + reclaim_empty_regions + compute_new_sizes
4. 弱引用完整性: weak_refs_work 必须在所有标记完成后

### cleanup 流程
reclaim_empty_regions → compute_new_sizes → weak_refs_work → finalize_marking → swap_mark_bitmaps
(remark 中已完成，cleanup 主要是 verifier + RSet 更新 + 记账)

## 调用链（tracer-2 提取）

### SATB Buffer 完整流
```
Mutator: write_ref_field_pre → enqueue → SATBMarkQueue::enqueue → filter(2指针压缩)
  → [buffer满] → enqueue_completed_buffer → 加入全局 completed list → notify
Marking: do_marking_step → drain_satb_buffers → apply_closure_to_completed_buffer
Remark: finalize_marking → drain all SATB → set_active_all_threads(false) ← 关闭
```

### 标记线程状态机
Idle (sleep_before_next_cycle/CGC_lock wait)
  → set_started() (do_concurrent_mark 中 notify)
  → SCAN_ROOT_REGIONS
  → CONCURRENT_MARK (mark_from_roots → preclean → delay_to_keep_mmu → Pause Remark)
  → REBUILD_REM_SETS
  → Pause Cleanup
  → CLEANUP_FOR_NEXT_MARK
  → concurrent_cycle_end → Idle

### 8 个 abort 检查点
SCAN_ROOT_REGIONS(#1) → MARK_FROM_ROOTS(#2-4) → REMARK(#5) → REBUILD(#6) → CLEANUP(#7) → CYCLE_END(#8)

### 并发标记启动决策链
record_collection_pause_end → maybe_start_marking → need_to_start_conc_mark → get_conc_mark_start_threshold
→ set_initiate_conc_mark_if_possible → 下次 pause: decide_on_conc_mark_initiation → initiate_conc_mark
→ post_initial_mark → set_active_all_threads(true) → do_concurrent_mark → set_started()
