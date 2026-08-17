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

---

> ⚠️ 写作期修正(2026-08-17, vol-02/26-g1-gc/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"RegionType 6 种" 错(重要)**: 实际 **8 种**(多出 OpenArchive/ClosedArchive=CDS 归档,heapRegionType.hpp:64-91 enum);编码是**位掩码组合**非顺序 tag——Free=0/Eden=2/Surv=3/StartsHumongous=12/ContinuesHumongous=13/Old=16/OpenArchive=56/ClosedArchive=57(注释表 :47-62);`is_young() = (get() & YoungMask) != 0`(:125)非 `type==Eden||type==Survivor`;行号 :30-80 应为注释 :47-62/enum :64-91/谓词 :123-143
> - **"heapRegion.hpp:38-170 HeapRegion 完整定义" 错**: :97-189 是父类 G1ContiguousSpace,HeapRegion 类从 :191 起(至 :701);字段**分层继承**: `_bottom/_end` 在 space.hpp:66-67(Space 基类)、`_top` 在 heapRegion.hpp:99(G1ContiguousSpace volatile 字段)、`_bot_part`(G1BlockOffsetTablePart) :101;HeapRegion 自身字段 :196-264(_rem_set HeapRegionRemSet* :201、_hrm_index :228、_type :230、_humongous_start_region :233、_evacuation_failed :236、_next/_prev :239-240、_prev/_next_marked_bytes :247-248、prev/next TAMS :263-264)
> - **"G1BlockOffsetTable _block_offset" 错**: 每 Region 持 `G1BlockOffsetTablePart _bot_part`;实体是**全堆共享一张** G1BlockOffsetTable(单层 u_char 数组,每 512 字节一个 entry,blockOffsetTable.hpp:50-55 LogN=9);大纲"sparse(128-byte)+per-card 两层表"是 8u 时代旧设计,**jdk11u 无两层**
> - **"G1EvacuationPause" 类不存在**: 真实流程 pre_evacuate_collection_set(:4039)→evacuate_collection_set(:4063)→post_evacuate_collection_set(:4099);入口 collect(GCCause)(g1CollectedHeap.cpp:2005)按 cause 分流 VM_G1CollectForAllocation/VM_G1CollectFull;暂停本体 do_collection_pause_at_safepoint(:2794);g1CollectedHeap.hpp:100-400 应为类 :130 起/关键成员 :209-213
> - **"g1CollectedHeap.cpp:200-500 initialize" 错**: initialize 在 :1533-1727(建六张 G1RegionToSpaceMapper :1588-1624 + _hrm.initialize :1626 + expand(init_byte_size) :1670-1674)
> - **"创建所有 HeapRegion 对象(~2048 个)+hashtable" 错(重要)**: HeapRegion **按需创建**(commit 时才 new_heap_region,uncommit 保留复用,heapRegionManager.hpp:56-59 注释);索引是 `G1BiasedMappedArray<HeapRegion*>`(g1BiasedArray.hpp:99——地址右移 Region 大小直接寻址,**非 hashtable**,get_by_address :125-127)
> - **"release 用 MADV_DONTNEED" 错**: Linux commit=mmap PROT_READ|WRITE MAP_FIXED(os_linux.cpp:3209-3218),uncommit=mmap PROT_NONE MAP_FIXED :3641-3645,无 MADV_DONTNEED;shrink 不走 pause,仅在 Full GC 后 resize_if_necessary_after_full_collection(:1219-1230)
> - **"默认 Heap/2048" 精确化**: 默认时 region_size=(initial+max)/2/2048(HeapRegionBounds::TARGET_REGION_NUMBER,heapRegionBounds.hpp:46)取 2 的幂,夹 [1MB,32MB](:35/:42);4GB 堆→2MB ✓
> - **继承链补正**: HeapRegion→G1ContiguousSpace→CompactibleSpace→Space(ContiguousSpace=space.hpp:501 是 CMS/Serial 线,不在 G1 链)
