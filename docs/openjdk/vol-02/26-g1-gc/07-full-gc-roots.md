# 07. G1 的最后手段 — Full GC + 根处理 + 辅助

> **前置依赖**:[26-g1-gc/05 — 什么时候做 Young？什么时候做 Mixed？— 策略与集合选择](05-mixed-gc-policy.md):IHOP、Mixed GC 与 CSet 选择失败后,本篇看最后的 Full GC;[26-g1-gc/06 — G1 的写屏障为什么最重？— G1BarrierSet Pre/Post Barrier](06-g1-barrier.md):写屏障与并发细化的正常路径;[25-gc-framework/03 — SoftReference 什么时候被清除？— Reference Processing](openjdk/vol-02/25-gc-framework/03-reference-processing.md):Full GC 里的引用处理基础
> → **后续**:[27-jni/01 — JNI 怎么管理 native 引用？— Handle 系统](openjdk/vol-02/27-jni/01-handle-system.md)
> 关联域: 25-gc-framework(WorkGang/Reference Processing)、27-jni(JNI roots)、28-jvmti(JVMTI GC hooks)

Young/Mixed GC 都是在 Collection Set 里做 evacuation:选一批 Region,把活对象复制到别处,然后释放原 Region。这套机制的前提是**有地方可搬**——CSet 之外还有空间装下复制出来的活对象。

但当分配失败、显式 GC、碎片或其他条件让 evacuation 无法继续时,G1 会进入 **Full GC**。这条路径不再依赖 RSet 逐 Region 选集合,而是对整个堆做 mark-compact。本篇要回答的核心问题:

1. Full GC 是不是"把 CSet 放大到全堆、evacuation 再跑一遍"?
2. 它为什么切成"标记→定目标→改引用→移动"四个阶段,而不是直接复制?
3. Full GC 的根扫描和 Young GC 的根扫描,是不是同一套入口?

答案会反复落到一句话:**Full GC 是 G1 的独立兜底路径,它有自己的一套 `G1FullCollector`,不是把 evacuation 换个输入重跑一遍。**

---

## 1. 开场困惑——Full GC 是不是 evacuation 放大到全堆

先看 Young/Mixed 的 evacuation 为什么不能"放大成 Full GC"。

evacuation 的核心是:选 CSet → 把 CSet 里的活对象**复制**到 CSet 外的幸存者区/老年代 → 用 forwarding pointer 指回新地址 → 原地重试失败则修正。每一步都依赖"CSet 之外还有空闲空间"。而 Full GC 恰恰发生在什么时间?往往就是**堆已经没有可搬空间**了:分配失败、晋升失败、碎片化到了一定程度。让一个满堆再做一次需要更多空闲空间的复制,等于让缺水的船自己造水。

而且 evacuation 的另一根支柱是 RSet:它回答"哪些来源 Region 可能引用了 CSet 里的对象"。但 Full GC 要压缩**整个堆**——每个 Region 都可能被移动,来源和目标都在变,逐 Region 的 RSet 记账根本覆盖不了这种全局位移。

所以 Full GC 必须换一套完全不同的思路:**原地 mark-compact**。先标出全堆谁活着,再为所有活对象规划好新的连续布局,最后统一把引用和对象搬到位。它要回答的问题从"哪些 Region 值得收"变成"整堆怎么从现状压缩成更紧凑的布局"。

---

## 2. 两个朴素方案为什么都不对

### 方案一:Full GC = 把 CSet 放大到全堆、evacuation 再跑一遍

直觉上,既然 Young/Mixed 已经会选 CSet,那 Full GC 只要"全堆都是 CSet"不就行了?

问题有两层:

- **没有可搬空间**。evacuation 复制对象的去处是 CSet 之外;当 CSet 是全堆时,外面没有任何空闲区域,复制无从谈起。
- **RSet 覆盖不了全局位移**。RSet 记的是"谁在 CSet 外指向 CSet 内";全堆压缩时所有 Region 都可能挪窝,来源卡的边界是流动的,RSet 的"谁指向谁"账本在这种全局重排里就会过时。

结论:evacuation 是"有空间的增量回收",Full GC 是"没有空间的整体重排",两者不是同一算法的参数变化。

### 方案二:Full GC 的标记直接复用并发标记的 SATB 逻辑

02 篇讲过,并发标记需要一个微妙的 SATB 协议——因为应用线程在标记期间还活着、还在改图。但 Full GC 是 **STW 暂停**:整个世界停住,没有 mutator 并发改图,也就不存在"旧世界快照会被覆盖"的问题。

所以 Full GC 的标记不需要 SATB、不需要快照队列,只要在停摆的世界里从全部根出发做一次普通的全堆可达性扫描。复用 SATB 是拿一个为解决"并发改图"设计的复杂协议,去解决一个根本没有并发改图的场景。

这也解释了为什么 Full GC 会用 `G1RootProcessor` 的 `process_strong_roots` / `process_all_roots_no_string_table`(见第五节):它直接从根出发标记,不走并发标记的增量路径。

---

## 3. 骨架——prepare / collect / complete 三层生命周期

`G1FullCollector`(g1FullCollector.hpp:56-103)是 StackObj,承载当前这次 Full GC 的所有状态:per-worker 的 `G1FullGCMarker` 和 `G1FullGCCompactionPoint`、OopQueueSet/ObjArrayQueueSet 标记栈、`PreservedMarksSet`(被压缩移动打乱的 mark word)、串行兜底用的 `_serial_compaction_point`,以及引用处理需要的 closure。

整场 Full GC 挂在三个入口上:

- `prepare_collection`(g1FullCollector.cpp:140-165):开张前的准备;
- `collect`(g1FullCollector.cpp:167-179):四个 phase 依次执行;
- `complete_collection`(g1FullCollector.cpp:181-201):收尾恢复。

### prepare_collection:不是"标记前热身",是关掉后台世界

`prepare_collection` 做的事情,一眼就看出它是**从并发世界切到 STW 世界**的过渡:

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

  // When collecting the permanent generation Method*s may be moving,
  // so we either have to flush all bcp data or convert it into bci.
  CodeCache::gc_prologue();

  // We should save the marks of the currently locked biased monitors.
  // The marking doesn't preserve the marks of biased objects.
  BiasedLocking::preserve_marks();

  // Clear and activate derived pointer collection.
  clear_and_activate_derived_pointers();
}
```

每一步都是在关掉会干扰 STW 压缩的世界侧状态:

- `abort_concurrent_cycle()`:如果并发周期还在跑,先中止——Full GC 期间不能让并发线程继续改堆;
- `reference_processor()->enable_discovery()`:开启引用发现,并按是否显式 GC 决定软引用策略;
- `CodeCache::gc_prologue()`:Method* 可能移动,要么 flush bcp 数据要么转成 bci;
- `BiasedLocking::preserve_marks()`:保存偏向锁对象的 mark word(标记阶段会用 mark 位图覆盖它);
- `clear_and_activate_derived_pointers()`:C2 derived pointer(C2 中途切回 leaf call 时)需要登记/清理。

这些动作的共同点是:**把"对象还会被并发移动"的假设抹掉,为全堆压缩铺路。** 大纲说的"Full GC 先终止并发周期,再准备堆"就是这一步,但远不止"准备堆"——引用处理、偏斜锁、derived pointer、CodeCache 全在这一步接好。

### collect:四 phase 用调用顺序锁死依赖

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

四个 phase 的顺序不是约定,而是**由数据依赖强制**的,后面会专门展开(第六节)。

### complete_collection:搬完不等于结束

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

对象移动完成只是"物理上放好了"。要让 Java 程序重新可跑,还需要:

- `restore_marks()`:把 phase1 被 mark 位图覆盖的 mark word 还原(含 identity hash、age 等);
- `update_derived_pointers()`:压缩移动后,C2 的 derived pointer 指向的地址已经变了,要按 forwarding 更新;
- `CodeCache::gc_epilogue()` / `JvmtiExport::gc_epilogue()`:与 prologue 对称的恢复;
- `prepare_heap_for_mutators()`:重建 mutator 可用的 region sets、refinement、strong code roots 状态。

所以 Full GC 是一次**全局状态重建**,不是"对象搬完就 return"。

---

## 4. Phase 1 标记——不止 parallel scan,还带引用/弱根/unload

`phase1_mark_live_objects`(g1FullCollector.cpp:203-234)名字叫"标记活对象",实际干的可不止扫描:

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
    // Unload classes and purge the SystemDictionary.
    bool purged_class = SystemDictionary::do_unloading(scope()->timer());
    _heap->complete_cleaning(&_is_alive, purged_class);
  } else {
    GCTraceTime(Debug, gc, phases) debug("Phase 1: String and Symbol Tables Cleanup", scope()->timer());
    // If no class unloading just clean out strings and symbols.
    _heap->partial_cleaning(&_is_alive, true, true, G1StringDedup::is_enabled());
  }

  scope()->tracer()->report_object_count_after_gc(&_is_alive);
}
```

它其实分四步串起来:

1. **真正的并行标记**(`G1FullGCMarkTask`,见第五节):从全部根出发,drain oop/objarray 标记栈,得出存活位图;
2. **引用处理**:标记过程中发现的 Reference 对象按 Java 语义处理(Soft/Weak/Phantom)。注意 Full GC 的 subject-to-discovery closure 是"全堆都是发现范围"(g1FullCollector.hpp:47-53,`G1FullGCSubjectToDiscoveryClosure` 恒返回 true)——因为 Full GC 不再有 CSet/young 的边界,整个堆都参与引用发现;
3. **weak oops 清理**:`WeakProcessor::weak_oops_do` 处理 JNI weak globals 等 GC 框架内部的弱引用(远超 Java Reference);
4. **class unloading 分支**:`ClassUnloading` 开启时 `SystemDictionary::do_unloading` + `complete_cleaning`(连同 CodeCache 卸载);关闭时才只做 `partial_cleaning` 清理 String/Symbol table,并把 `G1StringDedup::is_enabled()` 传进去决定是否清 dedup 队列。

所以大纲把 Phase 1 简化成"parallel scan all live objects",漏掉了它会改变存活判定(引用处理)、元数据状态(卸载)和弱根(WeakProcessor)这些**标记之外、但依赖标记结果**的收尾工作。它不是"扫一遍",而是"扫完之后把引用语义和类卸载一并兑现"。

---

## 5. 根处理——服务于全堆可达性,不是服务 CSet

### Full GC MarkTask 使用 G1RootProcessor

`G1FullGCMarkTask::work`(g1FullGCMarkTask.cpp:44-69)是每个 worker 的入口:

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

  // This is the point where the entire marking should have completed.
  assert(marker->oop_stack()->is_empty(), "Marking should have completed");
  assert(marker->objarray_stack()->is_empty(), "Array marking should have completed");
```

这里的 `G1RootProcessor`(g1RootProcessor.hpp:49)持有一个 `StrongRootsScope` 和一组 `SubTasksDone`,让多个 worker 并行扫描根且不重复。它的 root 任务枚举(g1RootProcessor.hpp:59-74)显示了根家族的全貌:

```
Universe / JNIHandles / ObjectSynchronizer / Management /
SystemDictionary / ClassLoaderDataGraph / jvmti / CodeCache / aot /
filter_satb_buffers / refProcessor / weakProcessor
```

也就是**来自 Java 和 VM 的强根(Universe、JNI handles、类字典、CLDG)、同步器、监控、JVMTI、CodeCache**,以及 SATB buffer 过滤、引用处理、弱处理的后续阶段。代码根通过 `MarkingCodeBlobClosure` 进入 marker;`filter_satb_buffers` 负责 drain 并发周期中止后仍残留的 SATB buffer 条目。

### 和 Young GC 根处理的差别

`G1RootProcessor` 同时是 Young/Mixed GC 根扫描的家——但那个入口叫 `evacuate_roots`(g1RootProcessor.hpp:106),服务于 evacuation:它拿的是 `G1ParScanThreadState` 和 CSet 语义的闭包,目标是"把根指向的对象复制/转发并按 CSet 规则搬"。

Full GC 用的却是 `process_strong_roots` / `process_all_roots_no_string_table`,拿的是 `G1FullGCMarker` 的 marking closure,目标是"标记全堆可达性"。同样是 G1RootProcessor,**闭包不同、目标不同**:evacuate 服务于"根指向谁,把谁从 CSet 里救出去"的增量复制;Full GC 服务于"从根出发,整个堆谁活着"的全局标记。

这里还有个关键分支:`ClassUnloading` 时走 `process_strong_roots`,**不**走 `process_all_roots_no_string_table`。区别在于后者会包含弱根、string table 和 code cache 的完整扫描,而 `process_strong_roots` 只扫强根(oops + CLDs + code blobs)——因为不卸载类时,Phase 1 末尾的 `partial_cleaning` 需要全根信息来决定 String/Symbol table 的清理范围(g1FullCollector.cpp:228-231);卸载类时清理由 `SystemDictionary::do_unloading` 和 `complete_cleaning` 独立完成,根扫描只需要强根即可。

---

## 6. prepare → adjust → compact——为什么必须先想好再动手

### 压缩目标: compaction point

`G1FullGCCompactionPoint`(g1FullGCCompactionPoint.hpp:34-62)是 phase2 的产物:每个 worker 有一个,维护"当前 Region + compaction_top"和一组要压进去的 Region 列表。`forward(oop object, size_t size)`(hpp:54)把一个对象的压缩目标地址记下来。

关键:这个记录的是**目标地址**,对象本身还没动。它就是要先算好"每一个活对象将来住在哪",才敢改引用。

### Phase 2:并行出压缩计划,无 freed region 就 fallback serial

```cpp
// g1FullCollector.cpp:236-245(截取核心,逐字)
void G1FullCollector::phase2_prepare_compaction() {
  GCTraceTime(Info, gc, phases) info("Phase 2: Prepare for compaction", scope()->timer());
  G1FullGCPrepareTask task(this);
  run_task(&task);

  // To avoid OOM when there is memory left.
  if (!task.has_freed_regions()) {
    task.prepare_serial_compaction();
  }
}
```

`G1FullGCPrepareTask` 并行遍历所有 Region,对每个存活对象调用 compaction point 的 forward,建立"对象 → 新地址"映射。重点是那个注释:`if (!task.has_freed_regions())` ——如果这次标记没有释放出任何 Region(比如存活率太高),并行 plan 的空间根本不够压缩,就退到 `prepare_serial_compaction()`。**这是内存极紧时的兜底,不是默认路径。**

### Phase 3:改所有引用指向新地址

```cpp
// g1FullCollector.cpp:247-253(截取核心,逐字)
void G1FullCollector::phase3_adjust_pointers() {
  // Adjust the pointers to reflect the new locations
  GCTraceTime(Info, gc, phases) info("Phase 3: Adjust pointers", scope()->timer());

  G1FullGCAdjustTask task(this);
  run_task(&task);
}
```

phase2 已经知道了每个对象的新家;phase3 现在**把堆上、根上、CodeCache 里所有指向旧地址的引用,统一改成新地址**。它必须在对象移动之前做,因为一旦移动,旧的引用就找不到对象了——只能靠 phase2 的 forward 映射先算好目标,再在"对象还在原处"时把引用改对。

### Phase 4:才真正移动

```cpp
// g1FullCollector.cpp:255-265(截取核心,逐字)
void G1FullCollector::phase4_do_compaction() {
  // Compact the heap using the compaction queues created in phase 2.
  GCTraceTime(Info, gc, phases) info("Phase 4: Compact heap", scope()->timer());
  G1FullGCCompactTask task(this);
  run_task(&task);

  // Serial compact to avoid OOM when very few free regions.
  if (serial_compaction_point()->has_regions()) {
    task.serial_compaction();
  }
}
```

phase4 才按 phase2 的队列把对象搬到目标地址。同样,如果 phase2 准备了 serial compaction(前面那个 `prepare_serial_compaction`),phase4 结尾也要 `serial_compaction()` 收尾。

**为什么顺序铁定不能换:**如果先把对象搬了、再改引用,那么"改引用"这就要求读旧引用——搬走之后旧地址全是悬空,无处去找;如果边搬边改,对象间相互指向时(成环引用)就会改到一半引用半新半旧。只有"**全部先算好目标 → 引用统一在对象未动时改对 → 再执行移动**"这个顺序,才能保证移动完成的那一刻,堆上所有引用都是一致的。

这也是为什么不把 `MarkingCodeBlobClosure` 的 FixRelocations 打开(g1FullGCMarkTask.cpp:48,`!CodeBlobToOopClosure::FixRelocations`):CodeCache 的重定位交给 phase3 的 adjust,标记阶段只负责把代码根的对象指针送进标记栈,不提前动 mcode。

---

## 7. 误解澄清与收网

1. **Full GC 是否 = CSet 放大到全堆的 evacuation?** 不是。evacuation 靠"CSet 外有空间可搬",Full GC 恰恰发生在没空间可搬的绝境;而且 RSet 覆盖不了全堆全局位移。它是独立的 mark-compact 路径,用 `G1FullCollector`,不是 evacuation 换个输入重跑。
2. **Full GC 标记是否复用 SATB 并发标记?** 不是。Full GC 是 STW,没有 mutator 并发改图,不需要 SATB 快照协议;它从全部根出发做一次普通 STW 可达性标记。
3. **全堆压缩是否只是"搬完就结束"?** 不是。complete_collection 要 restore marks、update derived pointers、CodeCache/JVMTI epilogue、重建 mutator region 状态——是一次全局状态重建。
4. **为什么正常情况下干净、却保留串行兜底?** 因为 phase2 的并行 plan 需要"标记后腾出可压缩空间";如果存活率太高、没有 freed region,并行 plan 空间不够,就 fallback 到 serial compaction。兜底保证"内存越紧我越保守",而不是把并行当唯一路径。
5. **根处理是否和 Young GC 是同一套入口?** 同一个 `G1RootProcessor`,但闭包与目标不同:evacuate 服务 CSet 复制,Full GC 的 process_strong/all_roots 服务全堆可达性标记。`ClassUnloading` 时走强根,否则走全根(含弱根)。

把这一篇压成三句话:

- **Full GC 不是 evacuation 的放大版**,而是没有空间可搬时的整体 mark-compact,四阶段顺序由数据依赖锁死。
- **标记阶段不止扫描**:引用处理、weak oops、class unloading 全挂在 phase1 里,决定存活判定与元数据状态。
- **根处理一个处理器两个用途**:同一个 `G1RootProcessor`,Young GC 用它服务 CSet,Full GC 用它做全堆可达性标记。

到这里,G1 七篇闭环:Region → 并发标记 → RSet → 分配 → Mixed policy → 写屏障 → Full GC 与根处理。G1 把"暂停目标"这根唯一的软约束,一路贯彻到选 Region、标记、记账、屏障、以及最后的全局兜底。卷 2 到这里也画上句号——剩下的,是 JNI 这些跨语言边界怎么把引用交到 VM 手里,以及它们的配套机制。

> → [27-jni/01 — JNI 怎么管理 native 引用？— Handle 系统](openjdk/vol-02/27-jni/01-handle-system.md)