# Phase 30 doc-01 分析汇总：Young GC Evacuation Full Lifecycle

## 范围
GC 触发 → Safepoint 同步 → 根扫描 → 对象疏散 → 引用处理 → Pause 后处理

## 源文件和符号（scout-2 定位）

### 核心文件
- g1CollectedHeap.cpp:3335-4020 — do_collection_pause + do_collection_pause_at_safepoint
- vm_operations_g1.cpp:78-165 — VM_G1CollectForAllocation::doit
- g1ParScanThreadState.hpp/cpp/inline (~500行) — Worker 线程扫描状态机
- g1RootProcessor.hpp/cpp (~450行) — 根集合扫描
- g1RemSet.hpp/cpp (~1210行) — RSet 扫描
- g1OopClosures.hpp/cpp/inline (~400行) — Evacuation 闭包
- referenceProcessor.hpp/cpp (shared, ~1800行) — 引用处理
- g1EvacFailure.hpp/cpp (~263行) — 疏散失败
- g1Policy.cpp:643 — record_collection_pause_end
- safepoint.cpp:156,527 — SafepointSynchronize::begin/end

### 关键符号
- do_collection_pause_at_safepoint (g1CollectedHeap.cpp:3639)
- G1ParTask::work (g1CollectedHeap.cpp:4116)
- copy_to_survivor_space (g1ParScanThreadState.cpp:231)
- evacuate_roots (g1RootProcessor.cpp:80)
- oops_into_collection_set_do (g1RemSet.cpp:692)
- G1ParCopyClosure::do_oop_work (g1OopClosures.inline.hpp:238)
- process_discovered_references (referenceProcessor.cpp:202)

## 实现细节（reader-2 提取）

### do_collection_pause_at_safepoint 5 阶段
1. 前置检查: GCLocker, timer, verifier
2. 并发标记决策: decide_on_conc_mark_initiation → IHOP
3. CSet 构建: finalize_collection_set → cleanupHRRS
4. 疏散执行: init_gc_alloc_regions → pre_evacuate → evacuate → post_evacuate
5. 收尾: free_collection_set → eagerly_reclaim → record pause end → do_concurrent_mark

### copy_to_survivor_space 6 步决策链
1. next_state() 年龄判断 → dest_state
2. Old Gen Full 快速失败路径
3. PLAB 快速分配（无锁）
4. allocate_direct_or_new_plab() — 慢速 PLAB
5. allocate_in_next_plab() — 降级到另一代
6. CAS forward_to_atomic(obj, memory_order_relaxed) — 原子安装 forwarding pointer
   - 成功 → Copy::aligned_disjoint_words + 子引用扫描
   - 失败 → undo_allocation + 返回 forwardee

### RSet 两阶段
- update_rem_set: 处理 dirty card buffer 发现的新引用 → Hot Card Cache → dirty card buffers → refine_card_during_gc
- scan_rem_set: G1ScanRSForRegionClosure 遍历 CSet region → PerRegionTable 扫描 → strong code roots (nmethod)

### 根扫描去重
- SubTasksDone::is_task_claimed() 确保 VM root 每类只由一个 worker 执行
- process_java_roots: CLDG(单worker) + Threads(多worker分摊)
- process_vm_roots: 7 类 VM 内部根逐一去重执行

## 调用链（tracer-1 提取）

### 完整 Young GC 拓扑
```
Java 分配失败
  → do_collection_pause → VMThread::execute(VM_G1CollectForAllocation)
    → SafepointSynchronize::begin
    → VM_G1CollectForAllocation::doit → do_collection_pause_at_safepoint
      → GCLocker::check_active_before_gc [活跃→取消]
      → decide_on_conc_mark_initiation
      → evacuate_collection_set → G1ParTask → workers->run_task
        → 根扫描(do_oop_work) → copy_to_survivor_space
        → 队列排空(steal_and_trim_queue) → copy_to_survivor_space
      → post_evacuate → process_discovered_references (4遍: Soft/Weak/Final/Phantom)
      → record_collection_pause_end
    → SafepointSynchronize::end
```

### do_collection_pause_at_safepoint 只有2个直接调用者
1. VM_G1CollectForAllocation::doit (vm_operations_g1.cpp:78) — 分配失败
2. initiate_concurrent_GC (vmGCOperations.cpp:197) — 并发标记启动
