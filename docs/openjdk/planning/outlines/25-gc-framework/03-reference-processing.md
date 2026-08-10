# 03. SoftReference 什么时候被清除？— Reference Processing

> 🔴 Deep | 5 KP 中的引用生命周期
> 读者处境: `SoftReference<byte[]> ref = new SoftReference<>(new byte[100MB])`——内存紧张时 GC 可以清它。WeakReference 在下次 GC 就被清。PhantomReference 在对象被回收后才 enqueue——用于 clean up native resource。

### 1. "四种引用——四条生命线"

场景: Java 有 Soft/Weak/Phantom/Final 四种引用类型——GC 需要有序处理它们：Soft 被 memory pressure 触发→Weak 在 marking 后清理→Final 可能复活对象→Phantom 在 reclaim 后 enqueue。

**ReferenceProcessor 的核心字段** (`referenceProcessor.hpp:80-250`):
```
_discoveredSoftRefs, _discoveredWeakRefs,
_discoveredFinalRefs, _discoveredPhantomRefs
→ 四条链表——每 GC cycle 内处理顺序: Soft→Weak→Final→Phantom
```
- 源码: `referenceProcessor.hpp:80-250` 字段 + `referenceProcessor.cpp:200-800` process_discovered_references
- 关键设计: 顺序不能变——Finalizer 可能复活对象(`obj = this`)—如果在 Phantom 之后处理→复活的对象已被回收→dangling Phantom reference
- [C++: `process_discovered_references` 用 4 个 while 循环遍历四条链表——每条循环内 check if reference is alive(weak pointer `JNIHandles::resolve`)。对于 dead ref→`ref->clear()`→`ref->enqueue()`。处理顺序: Soft→Weak→Final→Phantom 是静态顺序——每个类型的处理逻辑不同(Soft 需要 LRU check)

**四阶段处理** (`referenceProcessor.cpp:400-700`):
```
Phase 1: discover — 从 oop 链表发现可处理的引用
Phase 2: enqueue — 在 marking 后清理引用
Phase 3: process — GC 期间的实际清理(soft 可能 skip if enough memory)
Phase 4: verify — DEBUG verify list integrity
```
- 关键设计: SoftRefLRUPolicyMSPerMB——1ms×heap MB=soft ref max age。heap=256MB→soft ref 在 memory pressure 下存活 256ms。`java -XX:SoftRefLRUPolicyMSPerMB=0`→立即清理(等同 Weak)

### 2. "OopStorage — 引用存储在哪"

场景: discovered refs 需要存在 GC 可访问的位置——OopStorage.

**OopStorage 并发存储** (`oopStorage.hpp:40-120`):
```cpp
class OopStorage {
  // 块分配(无锁): each GC thread 分配 private block→填 oop→link to global
  struct Block { oop _data[BlockSize]; };
  // 并发 iteration (for GC processing)
  void oops_do(OopClosure* cl); // GC 遍历所有 stored oop
};
```
- 源码: `oopStorage.hpp:40-120` + `oopStorage.cpp:allocation/iteration`
- 关键设计: block 分配无锁——每个 thread 持有自己的 active block→full→swap to global→分配新 block。iteration 是并发安全的——新 block 插在头部(linked list)——已有 block 不动

---

### 核心悬念

**"ReferenceProcessor 按 Soft→Weak→Final→Phantom 四阶段有序处理引用。SoftRef 在 memory pressure 下 LRU 清理(SoftRefLRUPolicyMSPerMB)。Phantom 在对象回收后用于 clean up native资源。"** — 但 GC workers 怎么平分扫描任务？下一篇: WorkGang + TaskQueue。

> → [04-workgang-taskqueue.md](04-workgang-taskqueue.md)
