# 03. SoftReference 什么时候被清除？— Reference Processing

> **前置依赖**:[25-gc-framework/02 — new Object() 走到了哪？— CollectedHeap + 分配路径](openjdk/vol-02/25-gc-framework/02-collected-heap.md):对象怎么来,本篇讲对象"该不该死";[25-gc-framework/01 — GC 怎么在每次 oop 访问时悄悄插入 barrier？— BarrierSet + Access API](openjdk/vol-02/25-gc-framework/01-barrier-access.md):引用处理发生在 GC 阶段树里(25-01 素材的 "Reference Processing" 阶段);[06-oops/01 — 对象头 — 一个 word,五种身份](openjdk/vol-02/06-oops/01-markoop-oopdesc.md):Reference 对象本身是普通 oop,遍历时被特殊对待
> → **后续**:[25-gc-framework/04 — 4 个 GC worker 怎么平分扫描任务？— WorkGang + TaskQueue](openjdk/vol-02/25-gc-framework/04-workgang-taskqueue.md)
> 关联域: 06-oops(instanceRefKlass)、09-memory-core(堆)、17-threads(引用发现与 mutator 并发)

## 一个引用对象的两种命运

`WeakReference` 指向的对象,下一次 GC 就可能被清;`SoftReference` 在内存紧张时才清;`PhantomReference` 的对象死了之后才轮到它出场;`FinalReference`(终结器)甚至能让对象"复活"。四种引用,四种命运——但处理它们的**是同一台机器**:`ReferenceProcessor`。本篇拆这台机器: 引用怎么被"发现"进列表、处理时按什么顺序、以及"软引用该不该清"那台 LRU 天平。

## 1. 发现 — 遍历对象图时"截获"引用

GC 标记/遍历对象图时,`Reference` 对象(InstanceRefKlass)被特殊对待(instanceRefKlass.inline.hpp):

```cpp
// instanceRefKlass.inline.hpp:64-90(截取核心,逐字)
template <typename T, class OopClosureType>
bool InstanceRefKlass::try_discover(oop obj, ReferenceType type, OopClosureType* closure) {
  ReferenceDiscoverer* rd = closure->ref_discoverer();
  if (rd != NULL) {
    oop referent = load_referent(obj, type);
    if (referent != NULL) {
      if (!referent->is_gc_marked()) {
        // Only try to discover if not yet marked.
        return rd->discover_reference(obj, type);
      }
    }
  }
  return false;
}

template <typename T, class OopClosureType, class Contains>
void InstanceRefKlass::oop_oop_iterate_discovery(oop obj, ReferenceType type, OopClosureType* closure, Contains& contains) {
  // Try to discover reference and return if it succeeds.
  if (try_discover<T>(obj, type, closure)) {
    return;
  }

  // Treat referent and discovered as normal oops.
  do_referent<T>(obj, closure, contains);
  do_discovered<T>(obj, closure, contains);
}
```

*关键设计: **发现成功就不再按普通 oop 遍历该引用**——referent 不进入强引用集合(否则引用就没有意义了),而是留在"待处理列表"里等 §2 的裁决。预检有两道: 这里 referent 已标记(`is_gc_marked`)= 强可达 → 不发现;`discover_reference` 内部还有一轮 is_alive 检查(:1165-1172)。发现失败才退化为普通引用扫描。* 

`discover_reference`(referenceProcessor.cpp:1146-1239)是一连串过滤:

- 开关检查(`_discovering_refs`/`RegisterReferences`,:1148);已入队的 FinalReference 不再发现(:1152-1155);
- **referent 已知强可达 → 不发现**(:1165-1172)——引用的 referent 若已被标记,就不需要特殊处理;
- **软引用当场裁决**(:1173-1184): `should_clear_reference` 说不该清(见 §3)→ 不发现,直接当强引用扫过——"For soft refs we can decide now if these are not current candidates for clearing";
- 已发现过 → 跳过(:1191-1210,并发收集器的 Reference 可能被 trace 两次);
- 通过过滤 → `add_to_discovered_list`(:1234)。

**discovered 列表不是独立存储,而是借 Reference 对象自身的 `discovered` 字段串链**(referenceProcessor.hpp:61-84 的 `DiscoveredList` 只存头指针 `_oop_head/_compressed_head` 与长度;`add_to_discovered_list` 把新对象设为 head,referenceProcessor.cpp:1050-1073;遍历器 `DiscoveredListIterator` 读对象的 `discovered` 字段推进,:269-286)。**四类引用四条列表**: `_discoveredSoftRefs/_discoveredWeakRefs/_discoveredFinalRefs/_discoveredPhantomRefs`(referenceProcessor.hpp:267-270)——实际是**一个连续数组的四段**(cpp 里 weak/final/phantom 依次指向 soft 数组的偏移,:123-126),每段按 worker 数分槽(`_max_num_queues` 槽,配合 25-04 篇的并行处理)。

## 2. 处理 — 四阶段的裁决

GC 的引用处理主入口是 `process_discovered_references`(referenceProcessor.cpp:201-261)。它先停用发现(:213)、同步软引用时钟(:223)、统计四种列表(:225-228),然后按 **RefPhase1→4** 依次处理:

```cpp
// referenceProcessor.cpp:230-251(截取核心,逐字)
  {
    RefProcTotalPhaseTimesTracker tt(RefPhase1, phase_times, this);
    process_soft_ref_reconsider(is_alive, keep_alive, complete_gc,
                                task_executor, phase_times);
  }

  update_soft_ref_master_clock();

  {
    RefProcTotalPhaseTimesTracker tt(RefPhase2, phase_times, this);
    process_soft_weak_final_refs(is_alive, keep_alive, enqueue, complete_gc, task_executor, phase_times);
  }

  {
    RefProcTotalPhaseTimesTracker tt(RefPhase3, phase_times, this);
    process_final_keep_alive(keep_alive, enqueue, complete_gc, task_executor, phase_times);
  }

  {
    RefProcTotalPhaseTimesTracker tt(RefPhase4, phase_times, this);
    process_phantom_refs(is_alive, keep_alive, enqueue, complete_gc, task_executor, phase_times);
  }
```

四个阶段各管一类事务(大纲的 "discover/enqueue/process/verify" 四阶段是编造的——真实是处理内部的四步):

- **Phase1 软引用重新考虑**(`process_soft_ref_reconsider`,:795-837): 遍历软引用列表,对每个 referent 已死的引用问 policy——**policy 说要清 → 留在列表等 Phase2;说保留 → 移出列表并 `make_referent_alive`**(process_soft_ref_reconsider_work,:348-377)——软引用存活的对象在这一步被"救活";
- **Phase2 清理**(`process_soft_weak_final_refs`,:839-915): 三条列表共用 `process_soft_weak_final_refs_work`(:379-423),三态裁决:

```cpp
// referenceProcessor.cpp:385-413(截取核心,逐字)
  while (iter.has_next()) {
    iter.load_ptrs(DEBUG_ONLY(!discovery_is_atomic() /* allow_null_referent */));
    if (iter.referent() == NULL) {
      // Reference has been cleared since discovery; only possible if
      // discovery is not atomic (checked by load_ptrs).  Remove
      // reference from list.
      log_dropped_ref(iter, "cleared");
      iter.remove();
      iter.move_to_next();
    } else if (iter.is_referent_alive()) {
      // The referent is reachable after all.
      // Remove reference from list.
      log_dropped_ref(iter, "reachable");
      iter.remove();
      // Update the referent pointer as necessary.  Note that this
      // should not entail any recursive marking because the
      // referent must already have been traversed.
      iter.make_referent_alive();
      iter.move_to_next();
    } else {
      if (do_enqueue_and_clear) {
        iter.clear_referent();
        iter.enqueue();
        log_enqueued_ref(iter, "cleared");
      }
      // Keep in discovered list
      iter.next();
    }
  }
```

  referent 已被清(并发发现的竞态)→ 移除;referent 还活着 → 移除并 `make_referent_alive`(保持其可达);referent 死了 → **`clear_referent`(referent 置 NULL)+ `enqueue`(挂到 pending 列表,最终被 ReferenceQueue 收到)**。软/弱引用 do_enqueue=true,Final 引用在 Phase2 只清不 enqueue(:905);
- **Phase3 Final 复活**(`process_final_keep_alive`,:917+;work :425-450): **把所有 final 引用(终结器对象)的 referent 全部 `make_referent_alive`**——终结器要运行的对象"复活"进存活集,并 `set_next_raw(obj, obj)` 自环标记非活跃(:436-437);enqueue 给 Finalizer 线程;
- **Phase4 Phantom**(`process_phantom_refs`,:956+;work :452-481): referent 死 → clear+enqueue;活/NULL → 移除。

*关键设计: **顺序是硬约束**。Finalizer 的"复活"必须发生在 Phantom 之前——Phantom 引用在对象真正回收时才有意义,若先处理 phantom 再复活对象,复活对象已被"判死"过,语义崩坏。Phase2 里 final 引用只清不 enqueue(:905),**入队推迟到 Phase3 的复活确认之后**(process_final_keep_alive_work :439)。每一轮 work 之后 `complete_gc->do_void()` 闭合可达集(:372/:445),让 keep-alive 的标记立即生效。*

**[实证](materials/commands/25-gc-reference-demo.txt)**: 内存压力场景(32MB 堆 + 分配压力)下 `weak referent: null`、`soft referent alive: false`、`phantom enqueued: true`、同一 ReferenceQueue 收到 2 个条目(素材 A);无压力场景(默认策略,System.gc ×10)软引用保活对象、weak 同活(素材 B)——软引用的"软可达"语义。引用处理在 GC 阶段树里是固定成员(25-01 素材的 "Reference Processing" 阶段)。

## 3. 软引用的 LRU 天平与 G1 的接线

**SoftReference 该不该清**由 ReferencePolicy 决定(referencePolicy.hpp:59 `LRUCurrentHeapPolicy`/:71 `LRUMaxHeapPolicy`)。核心是"访问时间":`SoftReference` 对象有实例字段 `timestamp`(最近一次 `get()` 记录)+ 静态字段 `clock`(每次 GC 推进,javaClasses.cpp:3560)。`should_clear_reference`(referencePolicy.cpp:69+):

```cpp
bool LRUMaxHeapPolicy::should_clear_reference(oop p,
                                             jlong timestamp_clock) {
  jlong interval = timestamp_clock - java_lang_ref_SoftReference::timestamp(p);
  assert(interval >= 0, "Sanity check");

  // The interval will be zero if the ref was accessed since the last scavenge/gc.
  if(interval <= _max_interval) {
    return false;
  }

  return true;
}
```

*关键设计: **最近被访问过的软引用不清**——clock 是**毫秒时间戳**(`update_soft_ref_master_clock` 用 `os::javaTimeNanos()/1e6`,referenceProcessor.cpp:157-161,"We need a monotonically non-decreasing time in ms"),`interval = clock - timestamp` 是**距上次访问的毫秒数**;`_max_interval = 堆 MB 数 × SoftRefLRUPolicyMSPerMB`(LRUMaxHeapPolicy :69;LRUCurrentHeapPolicy 用上次 GC 后剩余空间 :38)。**server 编译模式默认 LRUMaxHeapPolicy,否则 LRUCurrentHeapPolicy**(referenceProcessor.cpp:60-64)。默认 `SoftRefLRUPolicyMSPerMB=1000`(globals.hpp:1852):堆 32MB → max_interval = 32×1000 = 32000 毫秒 = **32 秒内被访问过的软引用都保留**。**它不是"存活时间",而是"访问间隔的容忍度"**——soft ref 被 `get()` 后 timestamp 刷新,interval 归零,继续存活;设为 0 → 永不保留(等同弱引用)。*

**G1 的接线**: G1 持有**两个** ReferenceProcessor——`_ref_processor_cm`(并发标记周期用)与 `_ref_processor_stw`(STW GC 用)(g1CollectedHeap.cpp:1009-1106)。发现挂在**扫描 closure** 上(`set_ref_discoverer`,g1OopClosures.hpp:101-102 与 g1ParScanThreadState.hpp:95)——**并发标记与 STW 年轻代/Full GC 的对象图扫描都会发现引用**(closure 的 `ref_discoverer()` 指向处理器,instanceRefKlass 的 try_discover);处理在 STW 阶段(GC 阶段树的 "Reference Processing")。**大纲的"OopStorage 存储 discovered refs"是错的**: JDK11 的 ReferenceProcessor 不碰 OopStorage(grep 零命中)——discovered 链走 Reference 对象自身的字段;OopStorage 是 JNI handles 的存储(27-jni/01 篇),用途不同。

## 核心悬念

引用的审判庭到齐: **发现**(对象图遍历时截获,discovered 字段串链成四类列表)、**四阶段处理**(Phase1 软引用重审 → Phase2 清理弱/软/final → Phase3 final 复活 → Phase4 phantom 入队,顺序是硬约束)、**软引用 LRU 天平**(interval vs max_interval,`SoftRefLRUPolicyMSPerMB` 调阈值)、**G1 双处理器接线**。但注意 Phase1-4 的输出里反复出现一个词: **`task_executor`**——`RefProcPhase1Task/2Task...`(:529-630)与 `maybe_balance_queues`——引用处理本身是**并行任务**,四类列表按 worker 分槽。GC 的并行骨架(WorkGang 派发、TaskQueue 偷取)是下一台机器。

> → [25-gc-framework/04 — 4 个 GC worker 怎么平分扫描任务？— WorkGang + TaskQueue](openjdk/vol-02/25-gc-framework/04-workgang-taskqueue.md)
