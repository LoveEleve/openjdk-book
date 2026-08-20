# 26-g1-gc/01-heapregion 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
> 目标：解释 G1 为什么不再把堆看成几个固定大块，而要把整个堆切成大量等大 Region，并在这些 Region 上动态贴标签；同时讲清 HeapRegion、HeapRegionManager、G1CollectedHeap 各自在“网格化堆”里承担什么角色

## 1. 选题判断

现稿已有很强事实基础：
- `setup_heap_region_size`
- `HeapRegionBounds`
- `HeapRegionType` 位掩码
- `HeapRegion` / `G1ContiguousSpace` 继承关系
- TAMS 双指针
- `G1CollectedHeap::initialize`
- `G1RegionToSpaceMapper` commit/uncommit
- humongous threshold
- young pause / full collector 骨架

但当前正文还是偏“尺寸 / 标签 / 结构 / initialize / pause”按源码堆叠。真正该打穿的读者困惑更集中：

**G1 为什么非要把堆切成一张网格，而不是像传统分代收集器那样维持几块固定的大区？Region 的大小为什么要围着 2048 块这个数量级打转？标签为什么要设计成可流动的位掩码而不是静态分区名？这一整张网格到底是谁在管理、谁在按需 commit、谁在决定某块下一轮是 Eden 还是 Old？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**G1 的关键不是“Region 比代大还是小”，而是它把堆从‘少数几个固定角色的大块’改造成了‘大量等大格子 + 动态标签’的网格系统：地址空间先按 Region 粒度排成一张表，Region 自己承载对象与局部统计，标签决定它此刻扮演 Eden/Survivor/Old/Humongous 哪种角色，G1CollectedHeap 则像总调度器一样按暂停目标和存活度重新组合这些格子。**

## 3. 总图

```text
大堆先被切成 ~2048 个等大 Region
  ├─ Region 大小：1MB~32MB，围着目标块数自动计算
  ├─ Region 自己有 bottom/end/top、BOT、TAMS、RSet 指针等局部状态
  └─ RegionType 不是固定分区名，而是可重贴的位掩码标签

总管理者
  G1CollectedHeap
    ├─ _hrm        : Region 表与地址映射
    ├─ _allocator  : 普通分配/GC 分配
    ├─ _g1_rem_set : 跨 Region 引用记账
    ├─ _cm         : 并发标记
    └─ _g1_policy  : 选择这轮收哪些格子
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么 G1 不再把堆当成几个固定大块

目标约 1200 字。

- 从 Serial/CMS 的固定分代对比切入
- 点出：G1 不再把“代”绑在固定地址区间上
- 埋主线：它要的是可重排的格子，而不是固定分区

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. Region 只是把传统代再细切一层，语义本质没变
2. Region 大小应该固定，块数随堆大小线性增长

结论：
- G1 真正改变的是“角色流动方式”
- 2048 目标块数是元数据成本与回收粒度之间的折中

### 第三节：Region 大小——为什么 G1 盯的是目标块数，不是固定块尺寸

目标约 2200 字。

- `setup_heap_region_size`
- `MIN_REGION_SIZE/MAX_REGION_SIZE/TARGET_REGION_NUMBER`
- `GrainBytes/GrainWords/CardsPerRegion`
- 收回“固定块数上下文，非固定块尺寸”主线

### 第四节：RegionType——为什么标签是位掩码而不是分区名

目标约 2000 字。

- `HeapRegionType` 的 8 种标签
- `YoungMask/HumongousMask/ArchiveMask/OldMask`
- `is_young/is_humongous/is_old` 这些按位判定
- 动态 relabel 与归档区边界

### 第五节：HeapRegion 结构——为什么字段分层比平铺更重要

目标约 2200 字。

- `G1ContiguousSpace` vs `HeapRegion`
- `_bottom/_end/_top`、`_bot_part`、`_rem_set`
- `_prev/_next_marked_bytes`
- `_prev_top_at_mark_start/_next_top_at_mark_start`
- 强调 Region 不只是内存块，还是一份局部统计和并发标记边界容器

### 第六节：G1CollectedHeap.initialize——为什么要先 reserve，再造六张 mapper 账本

目标约 2300 字。

- Reserve the maximum
- `_hrm.initialize(...)`
- heap/BOT/card table/card counts/bitmaps 六张 mapper
- commit 初始堆而不是一次建满所有 Region
- 说明 Region 对象与地址空间/commit 状态不是同一层

### 第七节：commit/uncommit 与 humongous——为什么网格必须支持按 Region 粒度按揭和横躺对象

目标约 2100 字。

- `G1RegionToSpaceMapper::commit_regions/uncommit_regions`
- Linux 上 mmap 覆盖 commit/uncommit
- `humongous_threshold_for(region_size/2)`
- StartsHumongous / ContinuesHumongous
- 收回“Region 是可调度格子，不是静态分区”主线

### 第八节：pause 与 full——为什么 G1 的年轻回收是在挑格子，不是在整代回收

目标约 1900 字。

- `do_collection_pause_at_safepoint`
- `finalize_collection_set` / `evacuate_collection_set` / `free_collection_set`
- `G1FullCollector::collect` 四阶段
- 对比 young/mixed pause 与 full compaction 的不同尺度

### 第九节：误解澄清与收网

目标约 1300 字。

至少回答：
1. Region 是否只是“小号新生代/老年代块”
2. G1HeapRegionSize 是否总固定
3. Humongous 是否“>= Region 一半”
4. HeapRegion 对象是否在 initialize 时一次性全建好
5. G1 young pause 是否等于整块 Young 固定区整体回收

## 5. 失败方案必须写进正文

1. 把 Region 看成传统分代大块的细分切片
2. 把 G1HeapRegionSize 看成固定常量而不是围绕目标块数的折中
3. 把 HeapRegion、RegionType、HeapRegionManager 混成同一层概念

## 6. 证据清单

- `src/hotspot/share/gc/g1/heapRegion.cpp:63`：`setup_heap_region_size`
- `src/hotspot/share/gc/g1/heapRegionBounds.hpp:32`：`MIN_REGION_SIZE/MAX_REGION_SIZE/TARGET_REGION_NUMBER`
- `src/hotspot/share/gc/g1/heapRegionType.hpp:47`：位掩码布局
- `src/hotspot/share/gc/g1/heapRegionType.hpp:123`：查询谓词
- `src/hotspot/share/gc/g1/heapRegion.hpp:97`：`G1ContiguousSpace`
- `src/hotspot/share/gc/g1/heapRegion.hpp:191`：`HeapRegion`
- `src/hotspot/share/gc/g1/heapRegion.hpp:227`：`_hrm_index/_type/...`
- `src/hotspot/share/gc/g1/heapRegion.inline.hpp:243`：`note_start_of_marking`
- `src/hotspot/share/gc/g1/heapRegion.inline.hpp:248`：`note_end_of_marking`
- `src/hotspot/share/gc/g1/g1CollectedHeap.hpp:209`：`_hrm/_allocator`
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:1533`：`initialize`
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:1589`：heap mapper
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:1626`：`_hrm.initialize`
- `src/hotspot/share/gc/g1/g1RegionToSpaceMapper.cpp:70`：commit/uncommit（large region）
- `src/hotspot/os/linux/os_linux.cpp:3209`：commit mmap
- `src/hotspot/os/linux/os_linux.cpp:3641`：uncommit mmap
- `src/hotspot/share/gc/g1/g1CollectedHeap.hpp:1212`：`is_humongous/humongous_threshold_for`
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:2794`：`do_collection_pause_at_safepoint`
- `src/hotspot/share/gc/g1/g1FullCollector.cpp:167`：`collect()` 四阶段

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
- 本篇聚焦堆网格结构与管理，不展开 SATB/并发标记细节
- BOT/RSet 只点到 Region 角色，不在这里扩成完整专题
- 32 位/大页的 mapper 分支只点必要边界
- 下一篇应自然承接 TAMS 与并发标记怎么配合

## 8. 完成后 review

- 删除代码后，能否复述“G1 的核心是等大格子 + 动态标签，而不是固定代际大块”
- 是否清楚区分 Region 大小、Region 类型、Region 对象、Region 管理器四层
- 是否讲清 2048 目标块数的折中逻辑
- 是否说明 initialize 只 reserve/commit，不等于一次性把所有 Region 都填满
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
