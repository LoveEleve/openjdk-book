# 02. new Object() 走到了哪？— CollectedHeap + 分配路径

> 🔴 Deep | 5 KP 中的堆基础 + 分配
> 读者处境: Java 中最常见的语句——`new Object()`——在 JVM 底层走了 3 条分配路径: TLAB(bump pointer, ~10 cycles) → PLAB(survivor promotion) → global heap allocation(mutex/CAS)。每次分配都注入了 GC barrier。

### 1. "TLAB — 线程本地的 bump pointer"

场景: Java 线程分配对象——不想每次都锁全局堆。TLAB 在 Eden 中预留一小块(~512KB-2MB)→ bump pointer 分配——等价于单条 `add` 指令。

**TLAB 分配** (`collectedHeap.inline.hpp:60-150`):
```cpp
HeapWord* CollectedHeap::allocate_from_tlab(Thread* thread, size_t size) {
  HeapWord* obj = thread->tlab().allocate(size);
  if (obj != NULL) { // 成功——bump pointer 分配, ~10 cycles
    return obj;
  }
  // 失败→return to slow path (global allocation)
}
```
- 源码: `collectedHeap.inline.hpp:60-150` tlab 分配 + `tlab.cpp:40-80` ThreadLocalAllocBuffer::allocate
- 关键设计: TLAB 的 bump pointer 是无锁的——每个线程有自己的 TLAB→没有竞争。剩余的 TLAB 不满一个对象→作为填充浪费。fast path: `check(top+size <= end)→add top,size→return old_top`——一条 cmp+ja + add→在 x86 上 ~6 cycles
- [x86: TLAB allocate 被 C2 直接 inline 成 3 条指令: `mov reg,[thread+TLAB_offset+top]; lea tmp,[reg+size]; cmp tmp,[thread+TLAB_offset+end]; jae slow_path; mov [thread+TLAB_offset+top],tmp`——全 inline, 无 stub call]

**PLAB (Promotion LAB)** (`plab.hpp:40-80`):
```
TLAB = Eden 分配(Humongous allocation bypass TLAB)
PLAB = survivor→old promotion(GC 期间新生代→老年代 copy)
```
- PLAB 也用 bump pointer——但只在 GC 期间存在——GC worker 线程各自有 PLAB

### 2. "堆的全局视图" — CollectedHeap

场景: GC 收集和对象分配都通过 CollectedHeap——它是堆的单例抽象。

**CollectedHeap API** (`collectedHeap.hpp:80-200`):
```cpp
class CollectedHeap {
  static CollectedHeap* _heap; // 单例(Universe::_collectedHeap)
  // 分配
  virtual HeapWord* allocate_new_tlab(size_t size);
  virtual HeapWord* mem_allocate(size_t size, bool* gc_overhead_limit_was_exceeded);
  // GC
  virtual void collect(GCCause::Cause cause) = 0;
  virtual void do_full_collection(bool clear_all_soft_refs) = 0;
  // Safepoint
  virtual void safepoint_synchronize_begin();
  virtual void safepoint_synchronize_end();
};
```
- 源码: `collectedHeap.hpp:80-200` 主 API
- 关键设计: Constructor 调用 `Universe::_collectedHeap = this`——全局单例。G1CollectedHeap、ParallelScavengeHeap、GenCollectedHeap 都继承它(但在 G1-ONLY 构建中只有 G1 被实例化)

**GC Cause 30+ 原因** (`gcCause.hpp:40-120`):
```
GCCause::_java_lang_system_gc      // System.gc()
GCCause::_g1_evacuation_pause      // 正常 GC
GCCause::_g1_humongous_allocation  // 大对象分配触发
GCCause::_metadata_GC_threshold     // Metaspace 满
GCCause::_jvmti_force_gc           // JVMTI agent 触发
...
```
- 关键设计: 每个 GC 步骤都可追溯到原因——用于日志/GCRoots 追踪。30+ 原因覆盖了所有触发点——包括诊断用(WB_Young/FullGC)和正常用(allocation failure/evacuation)

### 3. "三层分配路径" — TLAB → PLAB → slow

场景: 分配 16 bytes Object→TLAB fast path(98% 走这)→TLAB 满→refill(from Eden)→Eden 满→触发 young GC→young GC 中 survivor→old copy→用 PLAB→PLAB 满→全局分配。

**分配三级路径**:
```
Fast path:    TLAB bump pointer (~10 cycles, NO barrier)
Medium path:  PLAB bump pointer (GC 期间, promotion)
Slow path:    global CAS/mutex (TLAB refill, Humongous, VM allocation)
              → 可能触发 GC → 可能触发 OOM
```
- 关键设计: TLAB 大小自适应——基于线程的历史分配速率动态调整(`TLABWasteTargetPercent=1%`)。Refill waste 用 TLAB::refill_waste_limit→避免太频繁的 refill

---

### 核心悬念

**"CollectedHeap 统一了堆分配和 GC 接口。TLAB 用 bump pointer→~10 cycles per allocation(98% hit rate)。PLAB 在 GC 期间做 promotion bump allocation。Slow path 走全局 CAS。"** — 但 SoftReference 什么时候被清？下一篇: Reference Processing。

> → [03-reference-processing.md](03-reference-processing.md)
