# Reference Processing — 文章大纲

> vol-03 · 域 14 · 🟡 B | 拓扑排序 #14
> 依赖：GC Framework（GC 周期触发引用处理）
>
> **→ 从 GC Framework**：GC 标记阶段遇到了 `SoftReference` 对象——不能直接收。怎么判断"软引用最近有没有被用到"？Reference Processing 篇。

## 叙事计划

**开篇场景**：Java 四种引用——强引用永不回收、`SoftReference` 内存紧张时收、`WeakReference` GC 就收、`PhantomReference` 收前通知。但"内存紧张"是什么标准？JVM 用 `SoftRefLRUPolicyMSPerMB`——默认每 MB 空闲堆给软引用 1 秒的存活时间。`ReferenceQueue` 不是实时通知——是 GC 处理后在 Java 层 `enqueue`。

**第一层：DiscoveredList——GC 标记阶段的引用链**

`DiscoveredList`（`referenceProcessor.hpp:61`）是 GC 在标记阶段构建的链表。当标记器遇到 `Reference` 对象时，不立即回收——而是把 referent 挂到对应链表：`SoftReference` → `_discoveredSoftRefs`、`WeakReference` → `_discoveredWeakRefs` 等。链表头存在 `Reference.discovered` 字段中——复用 Java 对象的字段，不需额外内存。

`DiscoveredListIterator`（`:87`）遍历发现链，逐个判断：`is_alive(referent)` → 跳过（还在用），`!is_alive` → 根据引用类型决定清理策略。

**第二层：SoftRefPolicy——LRU 时间戳清理**

`SoftRefPolicy::should_clear()` 不只看存活——还看最近有没有被访问。每个 SoftReference 有 `timestamp` 字段记录最后访问时间。当 `(clock - timestamp) > SoftRefLRUPolicyMSPerMB * free_heap_mb`——软引用很久没用且空闲内存不够了→清除。不是全清——保留最近用过的缓存，清除旧的。"LRU 时钟"是 GC 的 `_gc_timer`，不是系统时钟——避免系统时间跳变影响。

**第三层：ReferenceProcessor——四种引用的分阶段管线**

`ReferenceProcessor::process_discovered_references()`（1424 行 `.cpp`）分三个阶段：

阶段 1 — `SoftReference`：`SoftRefPolicy` 判定 → 部分保留（时钟还新鲜的）、部分清除（引用设为 null）→ 注册到 ReferenceQueue。

阶段 2 — `WeakReference`：全部 `is_alive=false` 的清除 → 注册到 ReferenceQueue。注意 `StringTable` / `interned string` 的 WeakReference 特殊处理——它们走 `Cleaner` 而不是 ReferenceQueue。

阶段 3 — `FinalReference`：不可达对象但有 `finalize()` 方法的→ 把 referent 加入 Finalizer 队列。注意：Finalizer 只"标记待处理"——实际 `finalize()` 调用在 `FinalizerThread`（Java 线程）中异步执行。同一对象可以被复活——`finalize()` 中重新赋值给静态字段。

阶段 4 — `PhantomReference`：referent 已确定不可达→不清除 referent（phantom reference 不回收对象）→注册到 ReferenceQueue。清理在 `ReferenceHandler` 线程中由 Java 代码完成——通常用于堆外内存（`DirectByteBuffer` 的 `Cleaner` 内就是这个机制）。

**设计权衡**

一、LRU 清理 vs 全清。LRU 保留热缓存但需额外时间戳存储和比较。`SoftRefLRUPolicyMSPerMB = 0` 等价于全清——每次 GC 都收软引用。

二、Finalizer vs Cleaner。`finalize()` 可复活对象但延迟不确定（FinalizerThread 单线程可能阻塞）。JDK 9 引入 `java.lang.ref.Cleaner`（Java 层，使用 PhantomReference 机制）作为 Finalizer 的替代——Cleaner 不复活对象、确定性更高、不依赖单一线程。`DirectByteBuffer` 的堆外内存回收已经迁移到 Cleaner；`StringTable` 的 interned string 清理也通过 Cleaner 完成。虽然 Cleaner 是 JDK 侧实现（不在 HotSpot C++ 源码中），但它的底层依赖 PhantomReference + ReferenceHandler——这两个都在 HotSpot 中。理解 Cleaner 是理解"JVM 如何管理非堆资源"的关键拼图。

## 核心悬念

**`SoftReference` 的"内存不够"是什么标准？不是 OOM——是 GC 用 LRU 算法在每次 collection 后主动筛选"你最近没用过"的软引用。**

## 预估

1 篇，3 层递进，预估 1500-2000 行。

**→ 下一域**：引用处理决定了"哪些软引用该回收"——垃圾的对象可以收，活着的对象去哪？TLAB 的 bump-pointer 怎么把对象放到堆的哪个位置？Heap/Universe 篇见。
