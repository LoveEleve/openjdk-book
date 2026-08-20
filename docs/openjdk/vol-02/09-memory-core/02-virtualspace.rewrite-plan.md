# 09-memory-core/02-virtualspace 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释为什么 HotSpot 要把 reserve 与 commit 分开，以及 `ReservedSpace`/`ReservedHeapSpace`/`VirtualSpace` 各自协调的是哪一层边界

## 1. 选题判断

现稿已经覆盖了 reserve/commit、`ReservedSpace`、`ReservedHeapSpace`、`VirtualSpace`、Linux 系统调用、`MemRegion`，但仍偏按组件顺序铺陈。读者容易得到“VirtualSpace 是一切内存都用的三段虚拟空间管理器”的印象。

真正的读者困惑是：

**为什么 HotSpot 不直接一次 commit 到底，而要把“占住地址”和“把页变成可用”拆开？如果 reserve 只是虚拟地址，commit 才是实际页，`ReservedSpace`、`ReservedHeapSpace` 和 `VirtualSpace` 各自又是在协调哪一层问题？压缩 oops 的 noaccess prefix、Metaspace 的 `VirtualSpaceList`、G1 的 region mapper、CodeCache 的 `CodeHeap` 为什么不能混成一套抽象？**

## 2. 一句话顿悟

**HotSpot 把地址空间管理拆成三层：`ReservedSpace` 负责拿到一段稳定的虚拟地址区间，`ReservedHeapSpace` 在堆语义上再叠加压缩 oop/noaccess-prefix 等要求，`VirtualSpace` 则只负责在已保留区间内按页粒度/大页粒度逐步 commit/uncommit。真正的对象分配在这些层之上，发生在 `CollectedHeap` / `MemAllocator` 中；并且只有 Metaspace 直接使用经典 `VirtualSpace`，G1 heap 和 CodeCache 都有各自更高层的管理器。**

## 3. 总图

```text
OS VM primitives (Linux)
  │
  ├─ reserve: mmap(PROT_NONE, MAP_NORESERVE)
  ├─ commit : mmap(MAP_FIXED, PROT_READ|PROT_WRITE)
  ├─ uncommit: mmap(MAP_FIXED, PROT_NONE|MAP_NORESERVE)
  └─ protect: mprotect
  │
  ├─ ReservedSpace
  │    ├─ alignment / over-reserve / trim
  │    └─ stable reserved address range
  │
  ├─ ReservedHeapSpace
  │    ├─ compressed-oops placement
  │    └─ optional noaccess prefix for implicit null checks
  │
  ├─ VirtualSpace
  │    ├─ one reserved range
  │    ├─ lower/middle/upper commit-granularity zones
  │    ├─ expand_by / shrink_by
  │    └─ special/large-page fast path
  │
  └─ higher-level users
       ├─ Metaspace: VirtualSpaceList / VirtualSpaceNode
       ├─ G1 heap: ReservedHeapSpace + region mappers (not classic VirtualSpace growth)
       ├─ CodeCache: ReservedCodeSpace + CodeHeap
       └─ Object allocation: CollectedHeap / MemAllocator / TLAB
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——占 32GB 的坑，为什么不等于用了 32GB 内存

目标约 1000 字。

- 从 `-Xmx32g` 和 Linux `top`/RSS 差异开场
- 解释 reserve 与 commit 的直觉反差：先占地址，再付物理页
- 提出核心问题：为什么 HotSpot 需要把地址稳定性、物理页承诺、压缩 oop 护栏、对象分配各自拆层
- 回收上一篇：G1 `initialize()` 里 `Reserve the maximum` 的真实含义

### 第二节：三个朴素方案为什么都不够

目标约 1800 字。

至少推演：

1. 一次性 commit 全部最大堆 → 启动成本和物理内存压力不可接受
2. 只保留 reserve，不维护 committed boundary → 对象分配与 GC 无法知道哪些页已经可写
3. 用同一套 `VirtualSpace` 模型解释 heap/metaspace/code cache 所有增长 → 忽略 G1 region mapper、CodeHeap、special large-page 路径的差异

引出：地址区间、堆专用前缀、逐步提交、对象分配这几层必须分开讲。

### 第三节：ReservedSpace——先拿到稳定地址，再谈其它

目标约 2000 字。

- `ReservedSpace::initialize` 的输入契约：size/alignment 与 allocation granularity
- Linux 上 `vm_allocation_granularity == page size`
- 普通路径：`os::reserve_memory`
- misaligned fallback：`reserve_memory_aligned`
- 关键纠偏：不是“重试 10 次直到对齐”，而是一次 over-reserve + trim
- fixed-address attempts 与普通对齐 fallback 的区别
- large/special path 概念引出

### 第四节：Linux reserve/commit/uncommit——同一地址，两种映射状态

目标约 1800 字。

- reserve = `mmap(PROT_NONE, MAP_NORESERVE)`
- commit = `mmap(MAP_FIXED, PROT_READ|PROT_WRITE[/EXEC])`
- uncommit = `mmap(MAP_FIXED, PROT_NONE|MAP_NORESERVE)`
- `protect_memory` 才是 `mprotect`
- 强调地址 identity 不变：commit/uncommit 改的是 backing/protection，不是地址
- 这解释为什么上层可以长期持有一段地址，再决定实际可用页水位线

### 第五节：ReservedHeapSpace——为什么堆要在 reserve 之上再加 noaccess prefix

目标约 2000 字（核心拆解层）。

- `ReservedHeapSpace` 与普通 `ReservedSpace` 的差别
- `compressed_oop_base()` = `_base - _noaccess_prefix`
- `noaccess_prefix_size` = `lcm(page_size, alignment)`，不是固定一页，也不是普通 reserve 的前缀浪费
- 触发条件：非零 base compressed-oops / crossing `OopEncodingHeapMax`
- `protect_memory(..., MEM_PROT_NONE)` 为 implicit null checks 立护栏
- 若平台条件不满足则关闭 `narrow_oop_use_implicit_null_checks`
- 纠偏：“prefix 是压缩 oops 护栏”，不是“对齐出来的多余空间”

### 第六节：VirtualSpace——三段不是用途，而是提交粒度

目标约 2200 字（核心拆解层）。

- 类注释：commit a previously reserved range in smaller chunks
- `initialize_with_granularity`
- lower/middle/upper 三段的 alignment 和 boundary 计算
- 纠偏：三段不是 Eden/old/code 之类用途分区，而是 page-size / large-page-size commit zones
- 初始 high-water marks 与 committed_size
- `actual_committed_size` 的 contiguous invariant

### 第七节：expand/shrink——为什么只能在边界推进，不能从中间打洞

目标约 1800 字。

- `expand_by` lower -> middle -> upper 提交顺序
- `shrink_by` upper -> middle -> lower 回收顺序
- 中间段用大页粒度，两端用普通页
- `special` path 只是移动高水位，不发 commit/uncommit 系统调用
- 解释“已提交区必须保持从低地址开始连续”这一隐含协议

### 第八节：谁真正用 VirtualSpace，谁没有用

目标约 1900 字。

- Metaspace 直接使用 `VirtualSpaceList` / `VirtualSpaceNode`
- `VirtualSpaceNode` 内部嵌 classic `VirtualSpace`
- G1 heap 使用 `ReservedHeapSpace` + `G1RegionToSpaceMapper` / `HeapRegionManager`，不是 classic `VirtualSpace` 增长模型
- CodeCache 使用 `ReservedCodeSpace` + `CodeHeap`，不是 VirtualSpace 三段
- `MemRegion` 只是轻量区间描述，不是分配/提交管理器
- 纠偏：不能把 `VirtualSpace` 的三段拿去解释 CodeCache 的三块 heap 或 G1 的 region 角色

### 第九节：对象分配在更高层——为什么 reserve/commit 不是 `new Object()`

目标约 1700 字。

- `CollectedHeap` 的 `allocate_new_tlab` / `mem_allocate` / `collect` / `object_iterate`
- `MemAllocator`：TLAB fast path -> slow path -> outside-TLAB
- TLAB miss 不一定 refill；可能因为 `refill_waste_limit` 直接 outside-TLAB
- `finish()` mark then klass 发布顺序
- `oopFactory` 是 convenience layer，不是 reserve/commit manager 也不是真正的 collector allocator

### 第十节：误解澄清与收网

目标约 1000 字。

至少回答：

1. Linux 上 granularity 是否固定 64K
2. `reserve_memory_aligned` 是否循环重试
3. noaccess prefix 是否总存在 / 是否只是对齐浪费
4. commit/uncommit 是否会改变地址
5. VirtualSpace 三段是否对应用途分区
6. G1 heap 是否通过 classic `VirtualSpace` 扩容
7. CodeCache 是否也用 `VirtualSpace`
8. TLAB miss 是否必然申请新 TLAB

## 5. 失败方案必须写进正文

1. 一次性 commit 到底
2. 只 reserve 不区分 committed waterline
3. 用一套 VirtualSpace 叙事套所有内存子系统

## 6. 证据清单

- `virtualspace.cpp:120-232`：`ReservedSpace::initialize`
- `os_linux.cpp:3119-3129`：Linux page size / allocation granularity
- `os_posix.cpp:287-340`：`reserve_memory_aligned`
- `os_posix.cpp:214-219`、`os_linux.cpp:3838-3855`：reserve / `PROT_NONE` / `MAP_NORESERVE`
- `os_linux.cpp:3209-3218`：commit
- `os_linux.cpp:3641-3645`：uncommit
- `os_linux.cpp:3929-3941`：`protect_memory` -> `mprotect`
- `virtualspace.hpp:106-124`、`virtualspace.cpp:297-327,577-625`：ReservedHeapSpace noaccess prefix / compressed-oops base
- `universe.cpp:854-875,776-812`：`reserve_heap` 与 compressed-oops/null-check relationship
- `virtualspace.hpp:134-159`：VirtualSpace class comment / three regions
- `virtualspace.cpp:680-727`：`initialize_with_granularity`
- `virtualspace.cpp:768-801`：actual/committed/reserved sizes
- `virtualspace.cpp:844-928`：expand_by
- `virtualspace.cpp:935-1027`：shrink_by
- `metaspace.cpp:1227-1334`、`metaspace/virtualSpaceList.hpp:47-49`、`metaspace/virtualSpaceNode.hpp:52-53`：Metaspace using VirtualSpace
- `codeCache.hpp:89-108`、`codeCache.cpp:301-417`：CodeCache / CodeHeap
- `g1CollectedHeap.cpp:1569-1674`、`heapRegionManager.hpp:76-213`、`heapRegionManager.cpp:82-167`：G1 heap reserve + region manager path
- `memRegion.hpp:35-58`：MemRegion is descriptor only
- `collectedHeap.hpp:140-160,395-447`：allocation/collection/iteration APIs
- `memAllocator.cpp:284-445`、`threadLocalAllocBuffer.hpp:134-161`：TLAB/outside-TLAB / refill heuristic / finish ordering
- `oopFactory.hpp:37-72`、`oopFactory.cpp:82-88`：oopFactory convenience layer
- `os_linux.cpp:4471-4544`：special large-page reservations caveats
- `virtualspace.cpp:404-406,143-173,849-851,939-943`：special/file-backed committed semantics

## 7. 必须明确的边界

- 基于 OpenJDK 11u / HotSpot / Linux / x86_64
- Linux granularity = page size，不泛化到 Windows/AIX
- `ReservedSpace` / `ReservedHeapSpace` / `VirtualSpace` 分别解决 reservation、heap-specific compressed-oops guard、progressive commitment
- `special`/large-page 路径可能把 reserve 与 commit 合并，不能把 demand-commit 语义绝对化
- G1 heap、Metaspace、CodeCache 使用的上层管理器不同，只能在“都基于保留地址空间”这一层类比
- reserve/commit 是地址空间层；对象分配是 `CollectedHeap` / `MemAllocator` 层

## 8. 完成后 review

- 删除代码后能否复述“reserve stable range -> heap-specific prefix -> progressive commit zones -> subsystem-specific users -> object allocation on top”
- 是否纠正了 64K granularity、重试对齐、CodeCache/G1 误用 VirtualSpace、TLAB refill 必然性等误解
- 是否把 Linux mmap/protect 语义与 HotSpot 抽象层对应清楚
- 是否完成删码测试、禁用词、file:line、链接和版本边界检查
