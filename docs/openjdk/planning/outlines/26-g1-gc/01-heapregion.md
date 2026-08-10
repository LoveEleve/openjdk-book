# 01. 堆被切成 2048 块 — HeapRegion + G1CollectedHeap

> 🔴 Deep | 5 KP 中的 Region 模型
> 读者处境: 经典 GC 把堆分成 Young/Old 两大块——固定大小。G1 把堆切成 ~2048 个等大 Region(1-32MB)——每 Region 在 GC 间可以改变类型(Eden→Survivor→Old)。

### 1. "2048 块积木" — HeapRegion 模型

场景: 4GB 堆 → `4GB/2048 = 2MB per Region`。Region 是 G1 收集的最小单元。每 Region 有独立的 bottom/end/top(类似 TLAB but region-level)。

**RegionType 6 种** (`heapRegionType.hpp:30-80`):
```
Free        — 未使用
Eden        — 年轻代(新对象分配)
Survivor    — 年轻代存活对象
Old         — 老年代
HumongousStarts  — 巨型对象头
HumongousContinues — 巨型对象身
```
- 源码: `heapRegionType.hpp:30-80` + `heapRegion.hpp:38-170` HeapRegion 完整定义
- 关键设计: Region 大小固定——由 `G1HeapRegionSize` 控制(默认 Heap/2048)。即使对象只有 16 bytes, 该 Region 也不缩小。Humongous(>50% Region) 用连续的 Starts+Continues Region——不需 compaction in Evacuation。类型在 GC 间动态变化: Eden 一次性全清空, Survivor 往 Old 晋升
- [C++: Region type 在 `HeapRegionType` 中用 tag value 编码——6 个 tag(tagFree=0..tagHumContinues=5)。`is_young() = type==Eden || type==Survivor`, `is_humongous() = type==StartsHumongous || ContinuesHumongous`。这些 predicate 被 G1CollectedHeap 的 collection set 选择逻辑大量调用——inline tag comparison 优化到单条 cmp 指令]

**HeapRegion 结构** (`heapRegion.hpp:80-200`):
```cpp
class HeapRegion : public G1ContiguousSpace {
  HeapWord* _bottom;     // Region 开始地址
  HeapWord* _end;        // Region 结束地址
  HeapWord* _top;        // 当前分配指针(bump pointer)
  HeapWord* _prev_top_at_mark_start;  // 上次标记开始的 top
  HeapWord* _next_top_at_mark_start;  // 下次标记开始的 top
  HeapRegionType _type;
  G1BlockOffsetTable _block_offset;   // 对象起始位置索引
  G1RemSet* _rem_set;                 // Remembered Set
};
```
- 源码: `heapRegion.hpp:80-200` 字段
- 关键设计: prev/next TAMS(Top At Mark Start)——并发标记开始时记录当前 top→标记仅跟踪 top _at_that_time(新分配的对象不计入此次标记)。nextTAMS 留给下一轮标记。在标记和 evacuation 之间——top 可能大幅增长→这些新对象不算在 "this marking cycle" 中→由下一轮标记处理
- [C++: `_block_offset`(G1BlockOffsetTable) 存 Each region's offset→object start mapping。用 Two-level lookup: first-level sparse(128-byte granularity)→second-level per-card mapping。找 region 中任意地址对应 object 的起始 O(1)查询→GC worker 扫描 card 找到 dirty refs 时快速定位 root object]

### 2. "G1 的堆引擎" — G1CollectedHeap

场景: G1CollectedHeap 是 `CollectedHeap`(域25)的 G1 实现——它初始化 Region 表、管理 evacuation pause、协调查找/标记/分配周期。

**G1CollectedHeap** (`g1CollectedHeap.hpp:100-400`):
```
allocate_new_tlab → G1Allocator
collect(GCCause)  → do_collection_pause_at_safepoint
  → G1EvacuationPause(young evacuation + optional old evacuation)
full_collection   → G1FullCollector(serial parallel compaction)
```
- 源码: `g1CollectedHeap.hpp:100-400` + `g1CollectedHeap.cpp:200-500` initialize
- 关键设计: 初始化阶段创建所有 HeapRegion 对象(~2048 个)——每个在 C-heap 分配——然后构造成 RegionTable(hashtable: region_idx→HeapRegion*)。初始化 commit 仅 commit 一部分 region(Uncommit unused to save RSS)
- [x86: `_hrm`(G1HeapRegionManager) 管理 free region list——vacating region 后归还到 free list。使用 expand/shrink 动态调整 commit 的 region 数。region 的 commit/decommit 用 `os::commit_memory`(mmap)——release 模式用 MADV_DONTNEED 退还 OS]

---

### 核心悬念

**"G1 将堆切成 ~2048 个 Region——每 Region 独立標記类型(Eden/Survivor/Old/Humongous)，在 GC 间动态重指定。prev/next TAMS 双边界让并发标记只追踪标记开始时的对象。"** — 下一篇: 并发标记。

> → [02-concurrent-mark.md](02-concurrent-mark.md)
