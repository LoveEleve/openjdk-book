# Phase 30 doc-04 分析汇总：Full GC — Last Resort

## 范围
触发条件 → Mark → Prepare → Adjust → Compact 4 阶段完整流程

## 源文件和符号（scout-5 定位）

### 核心文件（26个源文件）
- g1FullCollector.cpp (335行) — 4 阶段编排
- g1FullGCMarker.hpp/cpp/inline (99+63+176行) — 标记器
- g1FullGCMarkTask.hpp/cpp (46+71行) — Phase 1 Mark
- g1FullGCPrepareTask.hpp/cpp (95+221行) — Phase 2 Prepare
- g1FullGCAdjustTask.hpp/cpp (48+118行) — Phase 3 Adjust
- g1FullGCCompactTask.hpp/cpp (61+113行) — Phase 4 Compact
- g1FullGCCompactionPoint.hpp/cpp (64+146行) — 压缩点管理
- g1FullGCOopClosures (119+106+104行) — 闭包集合
- g1FullGCScope (70+80行) — Timer/Tracer
- g1FullGCReferenceProcessorExecutor (73+104行) — 引用处理
- vm_operations_g1.cpp:37-43 — VM_G1CollectFull
- g1CollectedHeap.cpp — do_full_collection + satisfy_failed_allocation

### 4 阶段入口
- phase1_mark_live_objects (g1FullCollector.cpp:238)
- phase2_prepare_compaction (g1FullCollector.cpp:271)
- phase3_adjust_pointers (g1FullCollector.cpp:282)
- phase4_do_compaction (g1FullCollector.cpp:290)

### 关键符号
- mark_object (g1FullGCMarker.inline.hpp:40)
- G1FullGCCompactionPoint::forward (g1FullGCCompactionPoint.cpp:97)
- G1AdjustClosure::adjust_pointer (g1FullGCOopClosures.inline.hpp:63)
- compact_region (g1FullGCCompactTask.cpp:81)
- satisfy_failed_allocation (g1CollectedHeap.cpp:1313)

## 实现细节（reader-5 提取）

### 触发条件
satisfy_failed_allocation 3 次重试: try Young GC → expand heap → Full GC
第1次(不清软引用) → 第2次(清软引用) → 第3次(不再GC，直接分配)

### collect() 4 阶段编排（顺序不可变）
Phase 1 Mark: 确定哪些对象活着（标记 bitmap）
Phase 2 Prepare: 计算每个活对象的新地址（forward pointer），基于 bitmap
Phase 3 Adjust: 修正所有引用指向新地址，必须先有 forward pointer
Phase 4 Compact: 实际移动对象，必须先修正引用（移动后原始数据无效）

### mark_object 核心
1. 跳过 archive objects
2. _bitmap->par_mark(obj) — CAS 原子标记
3. mark->must_be_preserved(obj) → preserved_stack()->push — 保存 mark word
4. StringDedup::enqueue_from_mark — 去重候选

### 数组分块优化 (follow_array_chunk)
stride = MIN2(len - beg_index, ObjArrayMarkingStride)
先 push 剩余 chunk → 再处理当前 → 便于 work stealing

### Slide Compaction (forward)
_compaction_top 线性推进: new_addr = _compaction_top
对象依次紧密排列，需要移动时 obj->forward_to(oop(_compaction_top))
object_will_fit: 检查当前 region 空间，不够则 switch_region()
多 worker 无冲突: 各自独立 compaction_point + HeapRegionClaimer 确保 region 不相交

### Adjust 指针调整
obj->forwardee() != NULL → RawAccess::oop_store(p, forwardee) 直接写入新地址
archive objects 跳过（从不移动）

### Compact 移动
destination = obj->forwardee() → Copy::aligned_conjoint_words (支持重叠的 memmove)
→ obj->init_mark_raw() → mark_bitmap->clear_region() → complete_compaction()

### OOM 串行 Fallback
prepare_serial_compaction: 并行压缩未释放 region 时 → 收集最后一个 region → 串行重新 prepare

## 调用链（tracer-3 提取）

### do_full_collection 8 条调用路径
System.gc/JVM_GC → VM_G1CollectFull::doit → do_full_collection
Allocation Failure → satisfy_failed_allocation → satisfy_failed_allocation_helper → do_full_collection
Metadata GC 阈值 → collect_as_vm_thread → do_full_collection
Concurrent Mode Failure → abort_concurrent_cycle → Full GC

### 关键跨子系统影响
- prepare_collection → BiasedLocking::preserve_marks (锁子系统)
- prepare_collection → CodeCache::gc_prologue (代码缓存)
- complete_collection → BiasedLocking::restore_marks
- Phase 2 后 has_freed_regions 检查 → 若无 → serial compaction fallback
