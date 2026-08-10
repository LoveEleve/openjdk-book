# Heap / Universe — 文章大纲

> vol-03 · 域 15 · 🔴 A | 拓扑排序 #15
> 依赖：GC Framework + OOPs + OS（reserve/commit 内存）
>
> **→ 从 Reference**：引用处理决定了"哪些软引用该收"，但那只是 GC 标记阶段的一个子任务。更大的问题是——`new Object()` 到底在哪分配？堆上的 TLAB 怎么做到纳秒级 bump pointer？Heap 篇。

## 叙事计划

**开篇场景**：`new Object()` 到底在哪分配内存？不是直接调 `malloc`——JVM 先用 TLAB（Thread Local Allocation Buffer），每个线程在 Eden 区有一块专属内存，分配对象只需一个指针 bump——`top += size`，不需要锁。只有 TLAB 用完了才走慢路径：refill 新的 TLAB 或触发 GC。

**第一层：Universe——JVM 内存世界的入口**

`Universe`（`universe.hpp:96`，`AllStatic`）持有 `_collectedHeap`（当前 GC 的堆实例）和 `_narrow_oop`（压缩指针配置：base + shift）。`initialize_heap()` 根据 `-XX:+UseG1GC` 等参数创建对应的 CollectedHeap 子类。`is_fully_initialized()` 是全局标志——在 `universe_init()` 完成后设为 true，之前很多 JVM 操作不能执行。

**第二层：TLAB——零锁的线程本地分配**

`ThreadLocalAllocBuffer`（`threadLocalAllocBuffer.hpp:46`）有三指针：`_start`（TLAB 起始）、`_top`（当前分配位置）、`_end`（TLAB 结束）。分配就是 bump pointer：`result = _top; _top += size; return result`——无锁、无 CAS、无竞争。每个线程独立一块，不会互相干扰。

`_desired_size` 是 GC 根据分配速率动态调整的——分配快的线程给更大的 TLAB（`refill_waste_limit` 控制何时丢弃剩余空间）。TLAB 浪费的空隙（alignment_reserve）通过 `make_parsable()` 在 GC 前填充 dummy 对象——防止 GC 遍历到未初始化内存。

**第三层：PLAB——GC 线程的本地分配**

GC 线程在疏散对象时也需要分配内存——`PLAB`（Promotion Local Allocation Buffer）是 GC 版的 TLAB。工作原理相同（bump pointer），但生命周期只在一次 GC pause 内。避免 GC 线程竞争全局 free list。

**第四层：对象分配全路径**

快速路径：TLAB 有空间 → bump pointer → 返回。慢速路径：TLAB 用尽 → `mem_allocate()` → 尝试从堆 free list 分配 → 失败 → 触发 GC（`collect()`）→ 重试。分配流程中 `GCLocker::check_active_before_gc()` 检查 JNI critical section 是否在阻止 GC。

**第五层：压缩指针的运行时配置**

`Universe::set_narrow_oop_base()` / `set_narrow_oop_shift()` 在 `universe_init()` 中根据堆大小自动配置。堆 ≤ 4GB（32 位编码的上限）：`shift=0`，base=堆起始地址，编码就是把地址转成 32 位。4GB < 堆 ≤ 32GB：`shift=3`（8 字节对齐），base=堆起始地址。堆 > 32GB：压缩指针自动禁用。

**设计权衡**

一、TLAB vs 全局 free list。TLAB 零锁但每线程浪费碎片。全局 free list 共享但需要锁。JVM 选 TLAB 为主、free list 为 fallback——99% 的分配走 bump pointer。

二、PLAB vs 共享分配。PLAB 给 GC 线程同样的零锁优势——疏散对象是 GC 的热路径，竞争 free list 会严重影响 pause 时间。

## 核心悬念

**`new Object()` 怎么在纳秒级完成——TLAB 里 bump 一个指针就搞定，不需要锁、不需要 CAS、不需要系统调用？**

## 预估

1 篇，5 层递进，预估 2200-2800 行。

**→ 下一域**：对象都在堆上了——但 Klass 元数据、常量池、方法表这些"描述对象是什么"的数据存哪里？PermGen 被废弃后的替代方案 Metaspace 篇见。
