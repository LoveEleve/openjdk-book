# 07. G1 的最后手段 — Full GC + 根处理 + 辅助

> **前置依赖**:[26-g1-gc/05 — 什么时候做 Young？什么时候做 Mixed？— 策略与集合选择](05-mixed-gc-policy.md):IHOP、Mixed GC 与 CSet 选择失败后,本篇看最后的 Full GC;[26-g1-gc/06 — G1 的写屏障为什么最重？— G1BarrierSet Pre/Post Barrier](06-g1-barrier.md):写屏障与并发细化的正常路径;[25-gc-framework/03 — SoftReference 什么时候被清除？— Reference Processing](openjdk/vol-02/25-gc-framework/03-reference-processing.md):Full GC 里的引用处理基础
> → **后续**:[27-jni/01 — JNI 怎么管理 native 引用？— Handle 系统](openjdk/vol-02/27-jni/01-handle-system.md)
> 关联域: 25-gc-framework(WorkGang/Reference Processing)、27-jni(JNI roots)、28-jvmti(JVMTI GC hooks)

Young/Mixed GC 都是在 Collection Set 里做 evacuation:选一批 Region,把活对象复制到别处,然后释放原 Region。但当分配失败、显式 GC、碎片或其他条件让 evacuation 无法继续时,G1 会进入 **Full GC**。这条路径不再依赖 RSet 逐 Region 选集合,而是对整个堆做 mark-compact:

1. 标记全堆活对象;
2. 为对象准备压缩目标;
3. 调整所有引用;
4. 移动对象并完成压缩。

G1 的 Full GC 有自己的一套 `G1FullCollector`,不是把 Young GC 的 evacuation 再跑一遍。

---

## 1. Full GC — 四阶段 mark-compact

### Full GC 先终止并发周期,再准备堆

`G1FullCollector::prepare_collection`(g1FullCollector.cpp:140-165):

```cpp
// g1FullCollector.cpp:140-165(截取核心,逐字)
void G1FullCollector::prepare_collection() {
  _heap->g1_policy()->record_full_collection_start();

  _heap->print_heap_before_gc();
  _heap->print_heap_regions();

  _heap->abort_concurrent_cycle();
  _heap->verify_before_full_collection(scope()->is_explicit_gc());

  _heap->gc_prologue(true);
  _heap->prepare_heap_for_full_collection();

  reference_processor()->enable_discovery();
  reference_processor()->setup_policy(scope()->should_clear_soft_refs());
```

Full GC 开始不是直接 `mark()`:

- 记录 Full GC 开始;
- 中止可能还在运行的 concurrent cycle;
- 做 Full GC 前检查;
- 准备 region sets、reference processor 和 CodeCache/derived pointer 状态。

### `collect()` 明确串起四个 phase

`G1FullCollector::collect`(g1FullCollector.cpp:167-179):

```cpp
// g1FullCollector.cpp:167-179(截取核心,逐字)
void G1FullCollector::collect() {
  phase1_mark_live_objects();
  verify_after_marking();

  // Don't add any more derived pointers during later phases
  deactivate_derived_pointers();

  phase2_prepare_compaction();

  phase3_adjust_pointers();

  phase4_do_compaction();
}
```

四阶段的顺序不能调换:

1. **Mark live objects**:从根递归标记;
2. **Prepare compaction**:为活对象计算压缩目标;
3. **Adjust pointers**:按新地址改引用;
4. **Do compaction**:移动对象到目标地址。

这和 evacuation 的关键差别是:evacuation 在选定 CSet 上复制,Full GC 先为全堆活对象建立压缩计划,再统一调整指针。

### Phase 1 不只是标记,还处理引用与弱根

`phase1_mark_live_objects`(g1FullCollector.cpp:203-234):

```cpp
// g1FullCollector.cpp:203-234(截取核心,逐字)
void G1FullCollector::phase1_mark_live_objects() {
  // Recursively traverse all live objects and mark them.
  GCTraceTime(Info, gc, phases) info("Phase 1: Mark live objects", scope()->timer());

  // Do the actual marking.
  G1FullGCMarkTask marking_task(this);
  run_task(&marking_task);

  // Process references discovered during marking.
  G1FullGCReferenceProcessingExecutor reference_processing(this);
  reference_processing.execute(scope()->timer(), scope()->tracer());

  // Weak oops cleanup.
  {
    GCTraceTime(Debug, gc, phases) trace("Phase 1: Weak Processing", scope()->timer());
    WeakProcessor::weak_oops_do(&_is_alive, &do_nothing_cl);
  }

  // Class unloading and cleanup.
  if (ClassUnloading) {
    GCTraceTime(Debug, gc, phases) debug("Phase 1: Class Unloading and Cleanup", scope()->timer());
```

所以 Full GC 的“标记阶段”还包含:

- discovered reference processing;
- weak oop 清理;
- ClassUnloading 开启时的 SystemDictionary 清理,否则做 String/Symbol table 清理;
- GC 后对象数量报告。

大纲把 Phase 1 简化成“parallel scan all live objects”,漏掉了这些会改变存活判定和元数据状态的工作。

### Prepare / Adjust / Compact 的数据依赖

`phase2_prepare_compaction`、`phase3_adjust_pointers`、`phase4_do_compaction`(g1FullCollector.cpp:236-265)分别运行 `G1FullGCPrepareTask`、`G1FullGCAdjustTask` 和 `G1FullGCCompactTask`,都通过 `run_task` 使用 collector 的 WorkGang。Prepare 阶段若发现没有释放 Region,还会准备 serial compaction 作为兜底;Compact 阶段同样保留 serial compaction 兜底路径。

因此“全堆压缩”并不意味着只有一个串行循环。**正常阶段是并行的,但在内存余量很紧时保留串行兜底。**

---

## 2. Full GC 根处理 — 从哪些入口开始标记

### Full GC MarkTask 使用 G1RootProcessor

`G1FullGCMarkTask::work`(g1FullGCMarkTask.cpp:44-69):

```cpp
// g1FullGCMarkTask.cpp:44-69(截取核心,逐字)
void G1FullGCMarkTask::work(uint worker_id) {
  Ticks start = Ticks::now();
  ResourceMark rm;
  G1FullGCMarker* marker = collector()->marker(worker_id);
  MarkingCodeBlobClosure code_closure(marker->mark_closure(), !CodeBlobToOopClosure::FixRelocations);

  if (ClassUnloading) {
    _root_processor.process_strong_roots(
        marker->mark_closure(),
        marker->cld_closure(),
        &code_closure);
  } else {
    _root_processor.process_all_roots_no_string_table(
        marker->mark_closure(),
        marker->cld_closure(),
        &code_closure);
  }

  // Mark stack is populated, now process and drain it.
  marker->complete_marking(collector()->oop_queue_set(), collector()->array_queue_set(), &_terminator);
```

Full GC 的 root scan 由每个 worker 的 `G1FullGCMarkTask` 调用 `G1RootProcessor` 完成:

- `ClassUnloading` 时走 `process_strong_roots`;
- 否则走 `process_all_roots_no_string_table`;
- 根闭包把对象推入 Full GC marker;
- 根填完后,`complete_marking` 并行 drain oop/objarray mark stack。

### 根不是只有 JavaThread 栈

`G1RootProcessor` 处理的 root 家族包括 Java/VM roots、JNI handles、ClassLoaderData、CodeCache 和其他管理性 roots。代码根还通过 `MarkingCodeBlobClosure` 进入 marker。StringTable 是否走这条 root path,取决于 `process_all_roots_no_string_table` 与后续清理策略;不能简单把 StringTable 和所有 root 混成同一个列表。

这也是 Full GC 和 Young/Mixed GC 的重要区别:Young GC 的 root closure 服务于 evacuation/CSet,Full GC 的 root closure 服务于**全堆 mark-compact**。

---

## 3. Full GC 结束 — 恢复运行态并重新建立 G1 状态

### complete_collection 做恢复与收尾

`G1FullCollector::complete_collection`(g1FullCollector.cpp:181-201):

```cpp
// g1FullCollector.cpp:181-201(截取核心,逐字)
void G1FullCollector::complete_collection() {
  // Restore all marks.
  restore_marks();

  // When the pointers have been adjusted and moved, we can
  // update the derived pointer table.
  update_derived_pointers();

  BiasedLocking::restore_marks();
  CodeCache::gc_epilogue();
  JvmtiExport::gc_epilogue();

  _heap->prepare_heap_for_mutators();

  _heap->g1_policy()->record_full_collection_end();
  _heap->gc_epilogue(true);

  _heap->verify_after_full_collection();
  _heap->print_heap_after_full_collection(scope()->heap_transition());
}
```

压缩移动完成后还不能立即返回 Java:

1. 恢复被保存的 mark word;
2. 更新 derived pointer;
3. 执行 CodeCache/JVMTI epilogue;
4. 重建 mutator 可用的 region sets、refinement 和 strong code roots 状态;
5. 记录 Full GC 结束、做验证并打印结果。

Full GC 是一次全局状态重建,不是单纯“对象搬完就 return”。

---

## 4. String Dedup 与 Phase Times — 辅助机制不能乱归因

### Full GC Phase 1 会触发 G1 侧清理

`phase1_mark_live_objects` 的无 ClassUnloading 分支会调用 `_heap->partial_cleaning(&_is_alive, true, true, G1StringDedup::is_enabled())`(g1FullCollector.cpp:228-231)。这说明 String Dedup 是 Full GC 清理阶段的一个可选协作者,不是 Full GC mark-compact 的第四个核心 phase。

大纲中“candidate Strings 只在 survivor→old promotion 处理、典型 15-30% savings”等数字没有在本篇源码中得到直接证明,不能当作 G1 Full GC 的固定事实。StringDedup 的队列/table 细节属于 25-06 的共享层,这里只保留它在 Full GC cleanup 分支中的位置。

### phase timing 由 `GCTraceTime` 记录

Full GC 的四个核心 phase 都通过 `GCTraceTime(Info, gc, phases)` 包住,比如 Phase 1、Prepare、Adjust、Compact。这些 timing 由 `G1FullGCScope`/`G1GCPhaseTimes` 等统计设施汇总,用于日志和监控,但不能反推出一个固定的“Full GC 比 evacuation 慢 10-50 倍”。具体倍数取决于堆大小、存活率、根数量、引用处理和压缩空间。

---

## 核心悬念

**Full GC 是 G1 的全局兜底:**先停止并发周期,再由 WorkGang 并行标记根可达对象、处理引用与弱根,准备压缩目标、调整指针、移动对象,最后恢复 marks、CodeCache/JVMTI 与 mutator 状态。它和 Young/Mixed 的 evacuation 不是同一条路径。**到这里 G1 七篇闭环:Region→并发标记→RSet→分配→Mixed policy→写屏障→Full GC 与根处理。**至此卷 2 的 152 篇正文全部完成。
