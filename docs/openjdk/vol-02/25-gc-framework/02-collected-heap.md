# 02. new Object() 走到了哪？— CollectedHeap + 分配路径

> **前置依赖**:[25-gc-framework/01 — GC 怎么在每次 oop 访问时悄悄插入 barrier？— BarrierSet + Access API](openjdk/vol-02/25-gc-framework/01-barrier-access.md):barrier 保证引用图完整,本篇讲"图的顶点从哪来";[09-memory-core/01 — Universe + CollectedHeap — JVM 的"宇宙大爆炸"](openjdk/vol-02/09-memory-core/01-universe-heap.md):堆的创建与 Universe 单例;[15-c2-compiler/07 — PhaseMacroExpand — 高层抽象→低层 MachNode 展开](openjdk/vol-02/15-c2-compiler/07-c2-macro-intrinsics.md):编译代码的 TLAB 快速路径与慢路径接线;[14-c1-compiler/04 — Runtime1 + FrameMap — C1 runtime 与栈帧](openjdk/vol-02/14-c1-compiler/04-c1-runtime-frame.md):C1 的分配慢路径
> → **后续**:[25-gc-framework/03 — SoftReference 什么时候被清除？— Reference Processing](openjdk/vol-02/25-gc-framework/03-reference-processing.md)
> 关联域: 17-threads(TLAB 挂在线程上)、09-memory-core(堆结构)、25-01(barrier 与分配的握手)

## 一行 `new Object()` 的三段旅程

`new Object()` 是 Java 里最常见的语句。解释器/编译代码执行它时,有**三段式**的去向: ①线程自己的 TLAB(bump pointer,免锁);②TLAB 不够,向堆要一块新的;③堆也没有,触发 GC 或走全局分配。本篇把这条链从 `ThreadLocalAllocBuffer::allocate` 一直追到 `G1CollectedHeap::do_collection_pause`,顺带回答: TLAB 凭什么快、大小怎么定、以及 GC 日志括号里的 "(G1 Evacuation Pause)" 是从哪来的。

## 1. TLAB — 线程本地的 bump pointer

### 1.1 分配本体: 一次比较 + 一次加法

TLAB 是线程对象里的一个结构(ThreadLocalAllocBuffer),字段就是 `_start/_top/_end` 三个指针。分配就是 bump:

```cpp
// threadLocalAllocBuffer.inline.hpp:34-54(截取核心,逐字)
inline HeapWord* ThreadLocalAllocBuffer::allocate(size_t size) {
  invariants();
  HeapWord* obj = top();
  if (pointer_delta(end(), obj) >= size) {
    // successful thread-local allocation
#ifdef ASSERT
    // Skip mangling the space corresponding to the object header to
    // ensure that the returned space is not considered parsable by
    // any concurrent GC thread.
    size_t hdr_size = oopDesc::header_size();
    Copy::fill_to_words(obj + hdr_size, size - hdr_size, badHeapWordVal);
#endif // ASSERT
    // This addition is safe because we know that top is
    // at least size below end, so the add can't wrap.
    set_top(obj + size);

    invariants();
    return obj;
  }
  return NULL;
}
```

*关键设计: 无锁的代价是"浪费可控"。比较 `end - top >= size` 失败就返回 NULL——TLAB 剩余空间不足以放一个对象时,那点空间要么丢弃、要么留到 GC 统计,但**绝不加锁等待**。每个线程独占自己的 TLAB,互不竞争;C2 把这条路径内联成快速分支(15-c2/07 篇的 `expand_allocate_common`: `fast_result_path` 内联 TLAB bump,TLAB 满才跳慢路径调用),解释器/C++ 侧经 `MemAllocator` 调用(§3)。*

### 1.2 大小: 自适应的 desired_size

TLAB 不是固定大小。初始大小由 `initial_desired_size`(threadLocalAllocBuffer.cpp:270-285)决定: `TLABSize` flag 显式指定,否则 `堆的 TLAB 容量 / (分配线程数 × target_refills)`——**堆越大、线程越少,TLAB 越大**;之后每次 refill 按 `compute_size` 再算:

```cpp
// threadLocalAllocBuffer.inline.hpp:56-74(截取核心,逐字)
inline size_t ThreadLocalAllocBuffer::compute_size(size_t obj_size) {
  // Compute the size for the new TLAB.
  // The "last" tlab may be smaller to reduce fragmentation.
  // unsafe_max_tlab_alloc is just a hint.
  const size_t available_size = Universe::heap()->unsafe_max_tlab_alloc(myThread()) /
                                                  HeapWordSize;
  size_t new_tlab_size = MIN3(available_size, desired_size() + align_object_size(obj_size), max_size());

  // Make sure there's enough room for object and filler int[].
  if (new_tlab_size < compute_min_size(obj_size)) {
    // If there isn't enough room for the allocation, return failure.
    log_trace(gc, tlab)("ThreadLocalAllocBuffer::compute_size(" SIZE_FORMAT ") returns failure",
                        obj_size);
    return 0;
  }
  log_trace(gc, tlab)("ThreadLocalAllocBuffer::compute_size(" SIZE_FORMAT ") returns " SIZE_FORMAT,
                      obj_size, new_tlab_size);
  return new_tlab_size;
}
```

*关键设计: 三个上限取最小——堆可给的最大值(`unsafe_max_tlab_alloc`)、期望值加本次对象、全局上限。"最后一个 TLAB 可以小一点"减少碎片(注释 :58-59)。**desired_size 不是运行时漂移,而是每次 GC 后重算**: `resize()`(threadLocalAllocBuffer.cpp:151-167)按线程的历史分配分数(`_allocation_fraction` 指数平均 × 堆容量 / target_refills)算出新值并同步重置 refill_waste_limit(:166-167)。相关 flag 全在 gc_globals.hpp: `MinTLABSize=2K`(:632)/`TLABSize=0`(:637,ergonomic)/`TLABWasteTargetPercent=1`(:657)/`TLABRefillWasteFraction=64`(:663)。*

### 1.3 浪费控制: refill_waste_limit

TLAB 用尽后,**不是立刻丢弃**。`allocate_inside_tlab_slow`(memAllocator.cpp:297-360)先查 `tlab.free() > tlab.refill_waste_limit()`(:314)——剩余空间还多(超过 `desired/64`)就**保留旧 TLAB,对象去共享空间**,并调 `record_slow_allocation` 把 waste limit 抬高(threadLocalAllocBuffer.inline.hpp:82-97,注释 :83-85: "a thread that repeatedly allocates objects of one size will get stuck on this slow path")——防止"每次都差一点、每次都要 refill"的抖动。剩余空间小(≤limit)才丢弃 TLAB、`compute_size` 后向堆要一块新的(:319-332)。

**[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/25-gc-heap-alloc-demo.txt)**: `-Xlog:gc+tlab=trace` 直接看到 `compute_size(2) returns 36702`(32MB 堆 ≈286KB)与 `TLAB: fill ... desired_size: 286KB refill waste: 4584B`(4584=286KB/64)——**小堆下 TLAB 是 286KB 量级,不是"512KB-2MB"**(大纲臆测);`UseTLAB` 是 pd product 可开关,`-XX:-UseTLAB` 让 2 亿次分配从 ~1.35s 涨到 ~8s(**6 倍**,素材 C 段)——bump pointer 免锁的价值。

## 2. CollectedHeap — 堆的统一门面

### 2.1 类骨架与单例真相

`CollectedHeap`(collectedHeap.hpp:104+)是所有堆的基类,核心分配 API 是**两个虚函数**:

```cpp
// collectedHeap.hpp:140-160(截取核心,逐字)
  // Create a new tlab. All TLAB allocations must go through this.
  // To allow more flexible TLAB allocations min_size specifies
  // the minimum size needed, while requested_size is the requested
  // size based on ergonomics. The actually allocated size will be
  // returned in actual_size.
  virtual HeapWord* allocate_new_tlab(size_t min_size,
                                      size_t requested_size,
                                      size_t* actual_size);

  // Raw memory allocation facilities
  // The obj and array allocate methods are covers for these methods.
  // mem_allocate() should never be
  // called to allocate TLABs, only individual objects.
  virtual HeapWord* mem_allocate(size_t size,
                                 bool* gc_overhead_limit_was_exceeded) = 0;
```

`mem_allocate` 是纯虚的——**分配单个对象**("should never be called to allocate TLABs");`allocate_new_tlab` 是**分配 TLAB 本身**("All TLAB allocations must go through this")。GC 侧还有 `collect(GCCause::Cause)`(:398)与 `do_full_collection`(:401)。

单例的真相与大纲的猜测不同:**不是构造器里 `Universe::_collectedHeap = this`**,而是 `Universe::initialize_heap` 里显式赋值(universe.cpp:766 `_collectedHeap = create_heap();` 然后 `_collectedHeap->initialize()` :767;`create_heap` :753-756 经 `GCConfig::arguments()->create_heap()` 按 `UseG1GC` 等 flag 选具体堆)。`CollectedHeap` 构造(collectedHeap.cpp:196-208)只初始化计数/日志/filler 尺寸,不碰 Universe。

### 2.2 GC Cause — 每次 GC 都带着"为什么"

GCCause 枚举(gcCause.hpp:43-92)约 30 个原因,按源码注释分三组: **public**(用户/工具显式触发:`_java_lang_system_gc`/`_jvmti_force_gc`/`_gc_locker`/`_heap_dump`/`_wb_young_gc`/`_dcmd_gc_run`…)、**implementation independent**(`_no_gc`/`_allocation_failure`)、**implementation specific**(`_metadata_GC_threshold`/CMS 家族/**G1 的两个**: `_g1_inc_collection_pause` 与 `_g1_humongous_allocation`/Z 家族)。它不只在日志里好看——`:97-124` 的 `is_*` 谓词(比如 `is_allocation_failure_gc`/`is_user_requested_gc`)驱动 GC 策略分支。

**[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/25-gc-heap-alloc-demo.txt)**: `-Xlog:gc` 的括号就是 cause——分配失败触发的 `Pause Young (Normal) (G1 Evacuation Pause)`;4MB 数组(32MB 堆 → region 1MB)触发 `(G1 Humongous Allocation)`;`jcmd GC.run` 触发 `(Diagnostic Command)`(= `_dcmd_gc_run`);OOM 前的 `Pause Full (G1 Humongous Allocation)`。大纲的 `_g1_evacuation_pause` 名字不存在,真实是 `_g1_inc_collection_pause`。

## 3. 慢路径 — refill、全局分配与 GC

TLAB 快速路径之外,`MemAllocator` 是解释器/C++ 侧的分配入口——编译代码的慢路径经 Runtime1/OptoRuntime 调进来(14-c1/04 与 15-c2/07 已讲): `OptoRuntime::new_instance_C`(opto/runtime.cpp:196)→ `InstanceKlass::allocate_instance`(instanceKlass.cpp:1241)→ `CollectedHeap::obj_allocate`(collectedHeap.hpp:301)→ `ObjAllocator`(memAllocator.hpp:81,MemAllocator 子类)→ 下面的三层。`MemAllocator::mem_allocate`(memAllocator.cpp:362-371)的三级:

1. **TLAB bump**(`allocate_inside_tlab` :284-295): `_thread->tlab().allocate(_word_size)`——§1.1 的免锁路径;
2. **refill**(`allocate_inside_tlab_slow` :297-360): §1.3 已述——保留或丢弃 TLAB,`compute_size` 后 `_heap->allocate_new_tlab(min, requested, &actual)`(:332),再 `tlab.fill`(:358)让对象落进新 TLAB;
3. **堆上直接分配**(`allocate_outside_tlab` :270-282): `_heap->mem_allocate(_word_size, ...)`(:272)——G1 的实现里这是最曲折的一环:

```cpp
// g1CollectedHeap.cpp:410-416,459-466(截取核心,逐字)
HeapWord* G1CollectedHeap::attempt_allocation_slow(size_t word_size) {
  ResourceMark rm; // For retrieving the thread names in log messages.

  // Make sure you read the note in attempt_allocation_humongous().

  assert_heap_not_locked_and_not_at_safepoint();
  assert(!is_humongous(word_size), "attempt_allocation_slow() should not "
         "be called for humongous allocation requests");
  ...
      result = do_collection_pause(word_size, gc_count_before, &succeeded,
                                   GCCause::_g1_inc_collection_pause);
      if (result != NULL) {
        assert(succeeded, "only way to get back a non-NULL result");
        log_trace(gc, alloc)("%s: Successfully scheduled collection returning " PTR_FORMAT,
                             Thread::current()->name(), p2i(result));
        return result;
      }
```

`mem_allocate`(g1CollectedHeap.cpp:398-408)先判 `is_humongous(word_size)`——**超过 region 一半的对象**(`_humongous_object_threshold_in_words = humongous_threshold_for(region_size) = region_size/2`,g1CollectedHeap.hpp:1212-1224;TLAB 也封顶在阈值之下,"we do not allow humongous TLABs" :393)走 `attempt_allocation_humongous`(整 region 分配,不经 TLAB);普通对象 `attempt_allocation`(:730-742)先试 `_allocator->attempt_allocation`(G1Allocator 从 Eden region bump),失败进 `attempt_allocation_slow`(:410-500): **Heap_lock 下再试** → GCLocker 活跃时尝试 `attempt_allocation_force`(扩 young)→ 都不行 `do_collection_pause(..., GCCause::_g1_inc_collection_pause)`(:459-460)触发 young GC,分配随 GC 完成;`succeeded` 但没分到(比如 humongous 失败)→ 返回 NULL 给上层报 OOM(:468-473)。

**PLAB** 是 GC 期间的孪生兄弟(plab.hpp:36+): "A per-thread allocation buffer used during GC"——结构完全同构(`_bottom/_top/_end/_hard_end` bump),GC worker 线程用它做**晋升分配**(对象从年轻代拷到 survivor/old 时落到 worker 自己的 buffer),避免 GC 内部也要抢全局。它只在 GC 期间存在,refill 走 `PLABStats` 的按需计算,与 TLAB 的自适应同源。G1 的实现是 `G1PLABAllocator`(g1ParScanThreadState.hpp:40/:52)封装,GC 期间按目标区分类(`par_allocate_during_gc` 按 `InCSetState::Young/Old` 分到 survivor/old 的 alloc region,g1Allocator.cpp:170-185)。

## 核心悬念

分配链封好了: **TLAB**(免锁 bump,`end-top>=size` 一次比较一次加法,desired_size 随堆与线程自适应,浪费受 refill_waste_limit 约束)、**CollectedHeap 门面**(`mem_allocate` 纯虚 = 对象、`allocate_new_tlab` = TLAB 本体,Universe 显式 create_heap)、**慢路径**(refill → Heap_lock → GCLocker 扩容 → `do_collection_pause(_g1_inc_collection_pause)`)、**PLAB**(GC 内的晋升 buffer)。但分配只解决了"对象在哪"——**对象什么时候该死**?`WeakReference` 指向的对象,GC 怎么知道要不要清?软引用按什么策略活多久?这就要进入 GC 的另一个体系: Reference Processing。

> → [25-gc-framework/03 — SoftReference 什么时候被清除？— Reference Processing](openjdk/vol-02/25-gc-framework/03-reference-processing.md)
