# PROMPT: 请撰写 03-Metaspace.md

## ⚠️ 关键：本 prompt 是导航地图，不是预制答案。你必须亲自读源码。

- §四 答案方向是"指引"。不能直接抄到文档里。
- **必须逐个读取 §三 列出的源文件**，基于自己的源码理解来写。
- 源码是证据（20%），分析洞察是正文（80%）。

## §〇 Production Scenario

```
$ java -XX:MaxMetaspaceSize=128m -XX:MetaspaceSize=64m MyApp
$ jcmd <pid> VM.native_memory summary scale=KB
-    Metaspace (reserved=1052776KB, committed=8920KB, used=7116KB)
-    Compressed Class Space (reserved=1048576KB, committed=260KB, used=4KB)
```

Metaspace reserved=~1GB 虚拟空间（VSL 8MB + CCS 1GB），committed=8MB 物理内存——MAP_NORESERVE lazy commitment 的体现。首次加载类时 `ClassLoaderMetaspace::allocate()` → `SpaceManager::allocate()` → current chunk 用尽 → `ChunkManager::chunk_freelist_allocate()` 查 free list → 空 → `VirtualSpaceList::get_new_chunk()` → `expand_by()` → `os::commit_memory(MAP_FIXED, PROT_RW)` → 此时才真正分配物理页。如果 Committed 接近 Reserved 且无法再 expand，触发 `Metaspace::report_metadata_oome()` → `java.lang.OutOfMemoryError: Metaspace`。

**反事实**：如果不用 lazy commitment——启动时 commit 全部 Metaspace（unlimited → 无法限制 → 无限消耗物理内存）。即使限制 1GB → 大多数应用只用 ~50MB → 浪费 950MB 物理内存。lazy commit 确保每字节物理内存都是实际需要的。

**三步诊断**：

```bash
# 1. jcmd native_memory → reserved vs committed 差异
jcmd <pid> VM.native_memory summary scale=KB | grep -A 3 "Metaspace"

# 2. jstat Metaspace
jstat -gc <pid> | awk '{print "MC:"$7" MU:"$8" CCSC:"$9" CCSU:"$10}'

# 3. GDB break
gdb -ex "break Metaspace::global_initialize" \
    -ex "break VirtualSpaceList::get_new_chunk" \
    -ex "break ChunkManager::chunk_freelist_allocate" \
    -ex "run" --args java -version
```

---

## §一 Task + Narrative + Beginner Callouts

### Task

深度分析 Metaspace 启动初始化：`Metaspace::global_initialize()` 创建 VirtualSpaceList + CompressedClassSpace + ChunkManager，lazy commitment 的完整触发链路。

### Interview Story Format Answer

"`Metaspace::global_initialize()` at `metaspace.cpp:1391` 创建数据元空间的 `VirtualSpaceList`（初始 1 个 VirtualSpaceNode: `mmap(NULL, 8MB, PROT_NONE, MAP_NORESERVE)` reserved=8MB, committed=0）+ `ChunkManager`（3 类 fixed-size free list: Specialized=1KB, Small=4KB, Medium=64KB + BinaryTreeDictionary for Humongous >64KB）。CompressedClassSpace 独立 1GB VSL（仅 1 个 VSN，`mmap` reserved=1GB, committed=0）— 所有 Klass 从固定 base 分配 offset，保证 `Klass* = base + 32bit offset` = 4 字节。首次分配链路: `ClassLoaderMetaspace::allocate()` → `SpaceManager::allocate()` chunk bump-pointer 不足 → `ChunkManager::chunk_freelist_allocate(size)` 查 `_free_chunks[list_index]` → 空 → `VirtualSpaceList::get_new_chunk(size)` → `take_from_committed` 检查 `OccupancyMap` → 可用空间不足 → `expand_by(min_words, preferred_words)` → `VirtualSpaceNode::expand_by()` → `VirtualSpace::expand_by()` → `os::commit_memory(addr, size, page_size, !exec)` → `mmap(MAP_FIXED, PROT_RW)` 提交物理页。CCS 必须独立 VSL——指针压缩要求 `Klass*` 的 32-bit offset 范围 ≤ 4GB，CCS 的 1GB 连续地址空间保证所有 klass offset 在范围内。2× multiplier 策略: `word_size = VIRTUALSPACEMULTIPLIER * _first_chunk_word_size = 2 * 4MB = 8MB`——预留 2 倍的初始大小，为 JDK 核心类加载留出增长空间。"

### Beginner Callout Boxes（≥7，§一 inline）

1. **MAP_NORESERVE**: `mmap(NULL, size, PROT_NONE, MAP_NORESERVE)` 预留虚拟地址不分配 swap。committed=0 表示 0 物理页消耗。commit 时才用 `mmap(MAP_FIXED, PROT_RW)` 提交。

2. **VirtualSpaceList 单链表**: `_virtual_space_list` 是 VirtualSpaceNode 单链表。数据空间可以有多个 VSN（每当前一个 VSN commit 满就创建新的）。CCS 只允许 1 个（`virtualSpaceList.cpp:227-231` assert）。

3. **ChunkManager 三类 free list**: `_free_chunks[SpecializedIndex=0]=ChunkList<1KB>, [SmallIndex=1]=ChunkList<4KB>, [MediumIndex=2]=ChunkList<64KB>`。类空间 chunk 更小: ClassSpecialized=1KB, ClassSmall=2KB, ClassMedium=32KB——因为 Klass 对象通常较小。

4. **Chunk 大小映射**: `list_index(size)` 决定去哪个 free list: `size==specialized(128 words)` → SpecializedIndex, `size==small(512 words)` → SmallIndex, `size==medium(8K words)` → MediumIndex, `size>medium` → HumongousIndex (BinaryTreeDictionary)。

5. **CompressedClassSpace**: `-XX:+UseCompressedClassPointers` 默认开启（32GB 堆以下）。CCS 独立 1GB VSL，紧挨堆末尾分配（`align_up(heap->reserved_region().end())`）。`set_narrow_klass_base_and_shift()` 计算 base 和 shift。

6. **HumongousChunk BinaryTreeDict**: >64KB 的 chunk 不在 fixed free list 中，而是 `_humongous_dictionary` 二叉搜索树按大小索引。分配时 `chunk_freelist_allocate` → `HumongousIndex` → `dictionary()->get_chunk(size)` → 可能需要 `split` 切开大块。

7. **OccupancyMap**: VirtualSpaceNode 内部用位图跟踪每个 128-word 块的提交状态。`take_from_committed()` 检查 occupancy → `is_available` → 可能返回 NULL → 触发 `expand_by`。

8. **BlockFreelist**: SpaceManager 的 chunk 内碎片回收。小块归还到 `BlockFreelist`（chunk 内部的小 free list），大块归还 `ChunkManager`。chunk 完全空闲时才可能 coalesce 并归还 VirtualSpaceNode。

---

## §二 Standard Environment

Source: `metaspace.cpp:1391-1494` (global_initialize), `virtualSpaceList.hpp:39-164` (VSL class), `virtualSpaceList.cpp:378-410` (get_new_chunk), `chunkManager.hpp:44-63` (ChunkManager), `chunkManager.cpp:127-218` (coalesce), `metaspaceCommon.hpp:35-42` (ChunkIndex), `metaspaceCommon.cpp:134-155` (chunk sizes)

Key flags: InitialBootClassLoaderMetaspaceSize (4MB), VIRTUALSPACEMULTIPLIER (2), CompressedClassSpaceSize (1G)

Syscalls: `mmap(PROT_NONE, MAP_NORESERVE)` (reserve), `mmap(MAP_FIXED, PROT_RW)` (commit)

---

## §三 Source Files Table

| # | File | Role |
|---|------|------|
| 1 | `metaspace.cpp` | global_initialize + VSL/CCS/ChunkManager 创建 |
| 2 | `virtualSpaceList.hpp/cpp` | VSL 单链表 + get_new_chunk + expand_by |
| 3 | `chunkManager.hpp/cpp` | 3 类 free list + HumongousDict + coalesce |
| 4 | `spaceManager.hpp/cpp` | SpaceManager allocation + BlockFreelist |
| 5 | `metaspaceCommon.hpp/cpp` | ChunkIndex enum + 大小常量 |
| 6 | `virtualSpaceNode.hpp/cpp` | VSN + OccupancyMap + commit |

---

## §四 Deep Dive Question Groups（≥6）

### 4.1 ★★★ VSL 8MB/0 commit 创建

问：`global_initialize` 为什么创建 8MB VirtualSpaceNode（reserved=8MB, committed=0）？2× multiplier 策略的来源和合理性？
答案方向: `_first_chunk_word_size = InitialBootClassLoaderMetaspaceSize/BytesPerWord = 4MB/8 = 524288 words`。`word_size = VIRTUALSPACEMULTIPLIER(2) * _first_chunk_word_size = 8MB`。2× 预留为加载 JDK 核心类（java.lang, java.util 等 ~4MB metadata）留增长空间。如果只预留 4MB → 加载第一个类可能需第二个 VSN（新 mmap reserve）→ 额外延迟。
追问: 为什么 InitialBootClassLoaderMetaspaceSize 默认 4MB？→ 经验测量 JDK 核心类约 3-4MB 元数据。
反事实: multiplier=1 → 8MB 堆 → 3 个 VSN → 3 次 mmap reserve → 启动延迟 + 碎片化。

### 4.2 ★★★ ChunkManager 三类 free list

问：ChunkManager 的 3 类 fixed-size free list 各自存什么大小的 chunk？为什么类空间 chunk 更小？
答案方向: `_free_chunks[0/1/2]` = ChunkList 链表。Specialized=128 words=1KB (数据空间), ClassSpecialized=128 words=1KB (类空间相同)。Small=512 words=4KB vs ClassSmall=256 words=2KB。Medium=8K words=64KB vs ClassMedium=4K words=32KB。类空间 chunk 小一半——Klass 对象(InstanceKlass ~500B-4KB) 比 Method 对象(几KB-几百KB) 小很多。
追问: list_index() 如何将请求大小映射到 Index? → `word_size==specialized → SpecializedIndex`, `==small → SmallIndex`, `==medium → MediumIndex`, `>medium → HumongousIndex`。
反事实: 如果全用一种 chunk 大小？→ 小对象浪费空间（1KB 对象占 64KB chunk → 63KB 浪费）→ 无法工作。

### 4.3 ★★★ CCS 独立 VSL

问：为什么 CompressedClassSpace 必须独立 1GB VSL 且只允许 1 个 VirtualSpaceNode？
答案方向: `-XX:+UseCompressedClassPointers` 需要 Klass* 在 32-bit offset (4GB) 范围。CCS 提供 1GB 连续虚拟地址空间 → 所有 Klass 从固定 base (`narrow_klass_base`) 分配的 offset 保证 `klass_offset < 1GB << shift` → `Klass* = base + (offset << shift)` = 4 字节。`set_narrow_klass_base_and_shift()` 计算 base 和 shift 参数。
追问: shift 是什么？→ 如果 Klass 对齐到 8 字节，shift=3 → offset << 3 → 最大地址范围 = 1GB << 3 = 8GB。
反事实: 如果 CCS 混在 Metaspace 的 VSL 中 → VSL 节点不保证连续 → 无法保证 offset 在 32-bit 范围 → 指针压缩失效 → Klass* = 8 字节。

### 4.4 ★★★ lazy commitment 全链路

问：首次 Metaspace 分配如何触发 `os::commit_memory()`？完整的调用链是什么？
答案方向: `ClassLoaderMetaspace::allocate()` → `SpaceManager::allocate()` → chunk bump-pointer 不足 → `ChunkManager::chunk_freelist_allocate(size)` → 从 `_free_chunks[list_index]` 取 → 空 → `VirtualSpaceList::get_new_chunk(size, commit_granularity)` → `current_vs()->get_chunk_vs(size)` → `take_from_committed(size)` → 检查 `OccupancyMap` `is_available` → 否 → `expand_by(min_words, preferred_words)` → `VirtualSpaceNode::expand_by()` → `VirtualSpace::expand_by()` → `os::commit_memory(start, size, page_size, !exec)` → `mmap(MAP_FIXED, PROT_READ|PROT_WRITE)`。
追问: commit_granularity 是多少？→ `_commit_alignment` 通常 = page_size = 4KB。如果请求 50KB → commit 向上对齐到 52KB (13 × 4KB)。
反事实: 如果没有 lazy commitment → 启动时 commit 全部 MaxMetaspaceSize → unlimited → 不可能。限制 1GB → 浪费 950MB。

### 4.5 ★★★ Chunk 回收链

问：chunk 如何被回收？coalesce 机制如何合并相邻空闲 chunk？何时归还给 VirtualSpaceNode？
答案方向: 类卸载 → `SpaceManager` 归还 chunk → `ChunkManager::return_single_chunk()` → `attempt_to_coalesce_around_chunk()` → 检查相邻 chunk 是否也在 free list → `SpecializedChunk×4 → SmallChunk, SmallChunk×16 → MediumChunk` 合并。整个 VirtualSpaceNode 的所有 chunk 都空闲 → `VirtualSpaceList::purge()` → `uncommit` + `release` VSN。
追问: 为什么 Specialized×4→Small 而不是直接 coalesce 任意大小？→ 维持固定大小分类，保证 free list 的分配效率。
反事实: 不 coalesce → 碎片累积 → Metaspace 可能需要更多 VSN 而非重用已有空间 → 虚拟地址消耗增加。

### 4.6 ★★★ ClassLoaderMetaspace per ClassLoader

问：每个 ClassLoader 有独立的 ClassLoaderMetaspace，但共享底层 VSL 和 ChunkManager——这个模型的好处和权衡？
答案方向: `ClassLoaderData::_metaspace` → `ClassLoaderMetaspace`（两个 SpaceManager: `_vsm` 数据, `_class_vsm` 类）。分配从 CLMS → SpaceManager → 定哪个 ChunkManager（metadata vs class）→ 共享的 VSL。CLMS 独立计费（per ClassLoader accounting），但底层共享 VSL+ChunkManager 避免重复虚拟空间预留。
追问: 类卸载时如何清理？→ `ClassLoaderData::unload()` → `ClassLoaderMetaspace::~ClassLoaderMetaspace()` → 归还所有 chunk → ChunkManager → coalesce。
反事实: 每个 ClassLoader 独立 VSL → 100 个 ClassLoader → 100 × 8MB reserved → 800MB 虚拟空间 → 浪费。

### 4.7 ★★★ CCS vs 数据空间 chunk 大小差异

问：为什么类空间（CCS）有独立的 ChunkManager 且 chunk 大小不同？ClassSmallChunk=2KB vs SmallChunk=4KB 的含义？
答案方向: `metaspaceCommon.cpp:134-155` 定义: 非类空间 `specialized=128, small=512, medium=8K` words。类空间 `class_specialized=128, class_small=256, class_medium=4K` words。ClassSmall 是非类空间的一半——Klass 通常 ≤ 2KB，4KB chunk 浪费 2KB。Independent ChunkManager 防止数据空间和类空间的 chunk 混合（不同的 VSL、不同的 free list 管理）。
追问: 如果数据空间和类空间共享 ChunkManager？→ 需要区分 chunk 来源（_space_list vs _class_space_list）→ 回收时回错 VSL → 分配失败。
反事实: ClassSmall=4KB（同数据空间）→ 每个 Klass ~2KB → 50% 浪费 → 1M classes → 2GB 额外浪费。

---

## §五 Article Structure

```
§〇 生产场景 — Metaspace OOM + lazy commitment diagnosis
§一 ★★★ Metaspace 启动初始化全链路
  1.1 global_initialize 完整流程 (line 1391-1494)
  1.2 VirtualSpaceList: 单链表 VSN (8MB reserve/0 commit)
  1.3 ChunkManager: 3 类 free list + HumongousDict + 类空间差异
  1.4 CompressedClassSpace: 独立 1GB VSL + narrow_klass_base/shift
  1.5 ★ lazy commitment: SpaceManager→ChunkManager→VSL→expand_by→commit_memory
  1.6 ClassLoaderMetaspace: per-CL 独立 SpaceManager, 共享 VSL+ChunkManager
  1.7 ★ Mermaid: Metaspace 完整内存布局 + lazy commit 链路 DAG
  1.8 ★ 面试 Story Format
§二 8 Callout (§一 inline)
§三 异常路径 (OOM 4 个点 + gc threshold)
§四 GDB 8 断点
§五 Cross-Reference
```

## §六 Writing Requirements

| 不要写成 | 应该写成 |
|---------|---------|
| "Metaspace 用 lazy commitment" | "`global_initialize`: VSL 用 `mmap(PROT_NONE, MAP_NORESERVE)` reserve 8MB/0 commit → 首次 `get_new_chunk` → `take_from_committed` 检查 `OccupancyMap` → `is_available`=false → `expand_by` → `os::commit_memory(MAP_FIXED, PROT_RW)`" |
| "ChunkManager 管理空闲块" | "`_free_chunks[0]=ChunkList<128 words>, [1]=ChunkList<512 words>, [2]=ChunkList<8K words>; Humongous>8K → `_humongous_dictionary` BinaryTreeDict; 类空间: [0]=128, [1]=256, [2]=4K words" |
| "CCS 独立 1GB" | "`allocate_metaspace_compressed_klass_ptrs(base=heap_end, 0)`: `mmap(base, 1GB, PROT_NONE, MAP_NORESERVE)` → `set_narrow_klass_base_and_shift()` → `initialize_class_space(rs)`: `_class_space_list = new VirtualSpaceList(rs)` (assert: only 1 node allowed)" |
| "Chunk 会被回收" | "类卸载 → `return_single_chunk()` → `attempt_to_coalesce_around_chunk()`: `Specialized×4→Small, Small×16→Medium` → 整个 VSN 空闲 → `VSL::purge()` → `os::uncommit_memory()`" |

## §八 Prohibited（≥8）
❌ 不展示两步 mmap → ❌ 不列 3 类 chunk 大小 → ❌ 不解释 CCS 独立 → ❌ 不画 commit 链路 → ❌ 不对比类/数据空间 → ❌ 不提 2× multiplier → ❌ 不解释 coalesce → ❌ 不写 GDB

## §九 Required（≥8）
✅ ★ Mermaid: VSL→ChunkManager→CCS 布局 + lazy commit 链路 DAG ✅ ★ Chunk 大小对比表（数据 vs 类空间）✅ ★ VSL 单链表结构图 ✅ ★ CCS 指针压缩数学推导 ✅ ★ lazy commitment 完整调用链源码 ✅ ★ coalesce 规则表 ✅ ★ 面试 Story ✅ ★ GDB 8 断点

## §十 GDB Verification（≥7）

断言 1: global_initialize → `print _space_list->_virtual_space_list` (单节点, 8MB reserved)
断言 2: VSL committed → `print _space_list->_committed_words` (0, 初始无 commit)
断言 3: CCS → `print _class_space_list->_reserved_words` (1G/8=128M words, 单节点)
断言 4: ChunkManager sizes → `print _free_chunks[0].size(), [1].size(), [2].size()`
断言 5: expand_by → break `VirtualSpace::expand_by` → `print committed before/after`
断言 6: chunk allocate → break `chunk_freelist_allocate` → `print list_index`
断言 7: OccupancyMap → `print is_available()` → true/false
断言 8: 类空间 ChunkManager → `print _chunk_manager_class->_free_chunks[1].size()` (256 words)

路径: `docs/03-Metaspace.md`
