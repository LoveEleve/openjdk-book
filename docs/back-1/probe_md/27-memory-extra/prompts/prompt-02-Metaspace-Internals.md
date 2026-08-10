# Prompt-02: Metaspace Internals — ChunkManager, SpaceManager, BlockFreelist & BinaryTreeDictionary

---

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**场景 1：ClassLoader 关闭后 Metaspace 碎片化**
一个应用频繁创建和关闭 ClassLoader（如 IDE 插件的模块加载器）。每次 ClassLoader::unload() 调用 Metaspace::deallocate()，Chunk 通过 `return_single_chunk()` 返回 ChunkManager 空闲列表。但由于 ChunkManager 的 `attempt_to_coalesce_around_chunk()` 只在 `return_single_chunk()` 时触发合并，且只合并 Specialized→Small、Small→Medium 两个方向，碎片化的 Medium Chunk 无法合并回更大 Chunk。gc+metaspace+freelist 日志中 `free_chunks_count` 增长但 `free_chunks_total` 不变 → 虚拟空间浪费。追问：如果引入后台 Megachunk 合并线程？

**场景 2：SpaceManager 的 current_chunk 饥饿**
一个超大 ClassFile 的 ConstantPool 进入 SpaceManager::allocate()。当前 Metachunk（通常 2KB SmallChunk）无法满足分配，SpaceManager 需要调用 `ChunkManager::chunk_freelist_allocate()` 获取新 Chunk。如果 ChunkManager 空闲列表中没有足够大的 Chunk，`free_chunks_get()` 尝试从更大 Chunk 分割（`split_chunk()`）——但若连更大 Chunk 都没有，`chunk_freelist_allocate()` 返回 NULL → SpaceManager 走 `add_allocation_to_failure_list()` → 触发 VirtualSpaceNode 扩容 `VirtualSpaceList::get_new_chunk()` + `VirtualSpaceNode::allocate()` → 可能触发 GC。这是整个 Metaspace 分配链中唯一需要 GC 参与的路径。诊断：Metaspace DCmd (`jcmd <pid> VM.metaspace`) 的 `waste` 值。

**场景 3：BlockFreelist 延迟返还导致 OOM 误报**
一个 ClassLoader 反复加载/卸载小类。每次卸载时，SpaceManager::deallocate() 将 small block 放入 BlockFreelist（每类最多缓存 100 个块），而不是直接返回给 ChunkManager。如果程序持续加载新类（消费新块）但卸载速度慢，BlockFreelist 满 100 个块触发 `purge()` 返回给 SpaceManager → SpaceManager 再决定是否返给 ChunkManager → 但如果 SpaceManager 的当前 Chunk 仍在使用，这些块不会被返回到 ChunkManager。JVM 的 Metaspace DCmd 可能显示大量 `used` 但实际 `committed` 未释放，造成伪 OOM。

---

## §一 Task + Narrative + Beginner Callouts

### Task
分析 Metaspace 分配的三个核心分配器层次：
1. **ChunkManager** — 全局 Chunk 缓存（Specialized 1KB / Small 2KB / Medium 32KB / Humongous >32KB）
2. **SpaceManager** — per-ClassLoaderMetaspace 的 block-level 分配器
3. **BlockFreelist + BinaryTreeDictionary** — 块回收缓存 + 二叉树最佳匹配

以场景 2 的 ConstantPool 大分配为叙事线索，追踪从 `Metaspace::allocate()` 到最终的 VirtualSpace commit 或 GC 触发。

### 7 Beginner Callout 框（必须用 `> **Beginner Callout N —` 格式）

> **Beginner Callout 1 — 为什么需要 1/2/32KB 三层？** 不同 ClassLoader 产生的 Metaspace 块大小差异巨大：Lambda 匿名类 ~200B，普通类 ~500-1500B，复杂类 ~4-8KB。三层固定大小减少碎片化，Humongous（>32KB）用红黑树而非链表。不需要 C 标准库的 malloc/free 通用分配器。设计意图：固定大小类解耦了内存分配和碎片化——Chunk 只在一个尺寸维度上操作，不需要通用 allocator 的 split-and-coalesce。

> **Beginner Callout 2 — MetaspaceExpand_lock 是什么？** Metaspace 分配过程中的全局锁，保护 ChunkManager 的 `_free_chunks[]` 和 VirtualSpaceList。不同于 thread-local ResourceArea（无锁），Metaspace 是全局共享的，需要在分配新 VirtualSpace 时串行化。类比：类似于内核的 `mm->mmap_sem` 保护 VMA 操作。

> **Beginner Callout 3 — 为什么 Chunk 归还时自动合并？** Metaspace 没有独立的 compaction 阶段。如果不合并归还的 Chunk，碎片会导致 VirtualSpaceNode 被大量闲置小 Chunk 占据，无法分配大 Chunk。合并策略是纯化的：只在 `return_single_chunk()` 时尝试，不在分配路径上触发。设计意图：合并只在空闲时做，不热路径阻塞分配。

> **Beginner Callout 4 — BlockFreelist 为什么不直接返回 ChunkManager？** SpaceManager 回收小块的频率非常高（每个 ClassLoader 卸载时可能有数百个小块）。如果每次都向 ChunkManager 归还（需要 MetaspaceExpand_lock），锁竞争会成为瓶颈。延迟批量返回（每类 100 个块后一次 purge）摊销了锁开销。

> **Beginner Callout 5 — BinaryTreeDictionary 为什么只用于 Humongous？** Humongous Chunk 大小不固定（从 33KB 到数 MB），不能用固定大小的 FreeList 链表管理。红黑树按 size 排序，支持 `best_fit` 查找（返回 >= 请求大小 的最小 Chunk），时间复杂度 O(log n)。Small/Medium Chunk 用 O(1) 链表，因为大小固定不需要查找。

> **Beginner Callout 6 — OccupancyMap 是什么？** 每 64KB 的 VirtualSpace 配一个 bit-per-chunk 的占位图，追踪每个 Chunk 的 in-use/free 状态和 chunk_start 位。chunk_start 位只在 chunk 边界地址为 1，用于合并时的合法性检查（`chunk_starts_at_address()`）。类比：Linux 内核的 `struct page` 标志位。

> **Beginner Callout 7 — Metaspace DCmd 输出怎么看？** `jcmd <pid> VM.metaspace` 输出包含 `Usage`（已分配字节）、`Capacity`（已提交字节）、`Waste`（浪费字节 = committed - used）、`ChunkFreeListSummary`（specialized/small/medium/humongous 四层空闲统计）。`Waste/Capacity > 30%` 表示严重碎片化。

### Narrative

追踪一次 `Klass::metaspace_pointers_do()` 触发 ConstantPool 扩容的分配路径：
1. `Metaspace::allocate(type, size)` — 全局入口
2. `ClassLoaderMetaspace::allocate()` — 路由到 `_non_class_space_manager` 或 `_class_space_manager`
3. `SpaceManager::allocate()` — 当前 Metachunk 足够 → 直接 bump-pointer 分配
4. 当前 Metachunk 不足 → `SpaceManager::allocate_work()` → 先检查 BlockFreelist → 若无合适块 → `ChunkManager::chunk_freelist_allocate()`
5. ChunkManager 空闲列表空 → 触发 `VirtualSpaceList::get_new_chunk()` → `VirtualSpaceNode::allocate()` → `VirtualSpace::expand_by()`
6. VirtualSpace expand 失败 → `MetaspaceGC::inc_capacity_until_GC()` → 触发 Full GC
7. 路径回退 → 从 ChunkManager 获取 Chunk → 设置 current_chunk → bump-pointer 分配

---

## §二 Standard Environment

### Source Roots
```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM
```

### 构建与二进制
```
bash configure --with-debug-level=slowdebug
make jdk
```
Binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so`

### Syscall 速查
| syscall | man | 用途 |
|---------|-----|------|
| futex(2) | `man 2 futex` | MetaspaceExpand_lock 底层等待 |
| mmap(2) | `man 2 mmap` | VirtualSpaceNode reserve (MAP_NORESERVE) |
| mprotect(2) | `man 2 mprotect` | VirtualSpace commit (PROT_READ|PROT_WRITE) |
| madvise(2) | `man 2 madvise` | MADV_DONTNEED uncommit |

### 全局状态表（运行时关键变量）
| 变量 | 位置 | 类型 | 说明 |
|------|------|------|------|
| `ChunkManager::_free_chunks[3]` | chunkManager.hpp:51 | `ChunkList[NumberOfFreeLists]` | Specialized/Small/Medium 空闲链表 |
| `ChunkManager::_humongous_dictionary` | chunkManager.hpp:63 | `ChunkTreeDictionary` | Humongous 红黑树 |
| `ChunkManager::_free_chunks_total` | chunkManager.hpp:71 | `size_t` | 空闲 Chunk 总 words |
| `ChunkManager::_free_chunks_count` | chunkManager.hpp:72 | `size_t` | 空闲 Chunk 数量 |
| `ChunkManager::_is_class` | chunkManager.hpp:54 | `bool` | 是否为 Class Space ChunkManager |
| `SpaceManager::_current_chunk` | spaceManager.hpp | `Metachunk*` | 当前 bump-pointer Chunk |
| `BlockFreelist::_blocks` | blockFreelist.hpp | `BlockTreeArray*` | 按大小索引的块缓存 |
| `BlockFreelist::_small_blocks` | blockFreelist.hpp | `SmallBlocks*` | ≤256B 小块专用池 |
| `OccupancyMap::_map` | occupancyMap.hpp | `BitMap` | commit bit 占位图 |
| `BinaryTreeDictionary::_root` | binaryTreeDictionary.hpp | `TreeChunk<Chunk, FreeList<Chunk>>*` | 红黑树根节点 |

---

## §三 Source Files Table

| File | Full Path | Lines | Core Constructs | Role |
|------|-----------|:---:|----------------|------|
| chunkManager.hpp | memory/metaspace/chunkManager.hpp | 224 | `ChunkManager`, `ChunkList`, `ChunkTreeDictionary` | Chunk 缓存管理器 |
| chunkManager.cpp | memory/metaspace/chunkManager.cpp | 732 | `chunk_freelist_allocate()`, `return_single_chunk()`, `split_chunk()`, `attempt_to_coalesce_around_chunk()` | Chunk 分配/归还/分割/合并 |
| spaceManager.hpp | memory/metaspace/spaceManager.hpp | 234 | `SpaceManager`, `_current_chunk` | Block-level 分配器 |
| spaceManager.cpp | memory/metaspace/spaceManager.cpp | 540 | `allocate()`, `allocate_work()`, `deallocate()` | Block 分配/回收 |
| blockFreelist.hpp | memory/metaspace/blockFreelist.hpp | 93 | `BlockFreelist`, `BlockTreeArray` | 块回收缓存 |
| blockFreelist.cpp | memory/metaspace/blockFreelist.cpp | 109 | `get_block()`, `return_block()`, `purge()` | En-block 操作 |
| smallBlocks.hpp | memory/metaspace/smallBlocks.hpp | 89 | `SmallBlocks` | 小块专用池 |
| smallBlocks.cpp | memory/metaspace/smallBlocks.cpp | 62 | `return_block()`, `get_block()` | 小块快速路径 |
| metachunk.hpp | memory/metaspace/metachunk.hpp | 173 | `Metachunk`, `_word_size`, `_container`, `_origin` | Chunk 数据结构 |
| metachunk.cpp | memory/metaspace/metachunk.cpp | 175 | `Metachunk()` init, `mangle()` | Chunk 管理 |
| binaryTreeDictionary.hpp | memory/binaryTreeDictionary.hpp | 395 | `TreeChunk`, `TreeList`, `BinaryTreeDictionary` | Humongous 红黑树 |
| freeList.hpp | memory/freeList.hpp | 176 | `FreeList`, `_head`, `_tail`, `_count`, `_size` | 固定大小空闲链表 |
| occupancyMap.hpp | memory/metaspace/occupancyMap.hpp | 243 | `OccupancyMap`, `_map` (BitMap), `chunk_starts_at_address()` | 占位图 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 ChunkManager 三级池的分层设计（WHY 三层 + 红黑树）

**(a) Specialized (1KB) / Small (2KB) / Medium (32KB) / Humongous (>32KB) 四类的选择逻辑是怎么驱动的？**
追踪 `ChunkManager::list_index(size)` (`chunkManager.cpp:296`) → `get_chunk_type_by_size()` 如何将任意 size 映射到 ChunkIndex。关键：`get_size_for_nonhumongous_chunktype()` 的函数——对于 class space chunk 和 non-class chunk，Specialized/Small/Medium 大小不同。追问：为什么 class space 的 Chunk 比 non-class 大？（class space 只存 Klass 结构，更密集，减少 Chunk 数量可降低 VirtualSpaceNode 管理开销）

**(b) Humongous 为什么用红黑树而非链表？**
`ChunkManager::_humongous_dictionary` 类型为 `BinaryTreeDictionary<Metachunk, FreeList<Metachunk>>` (`chunkManager.hpp:63`)。Humongous chunk 大小不固定，需要用二叉树进行 best-fit 查找（`get_chunk(word_size)` 返回 >= word_size 的最小 chunk）。红黑树的 `TreeChunk` 结构体将 `next/prev` 指针复用到树节点指针（`left/right/parent`），避免额外内存开销。

**(c) Counterfactual — 如果只有 Medium 和 Humongous 两层（去掉 Specialized/Small）？** Lambda 类卸载会产生大量 1KB-2KB 空闲 Chunk。如果没有小额池，这些 Chunk 无法满足 1KB 的请求（Medium 是 32KB），SpaceManager 每次都要从 VirtualSpaceNode 新分配 Medium Chunk → 浪费 30KB+ 每 Lambda。三层设计使得 1KB 请求 -> Specialized, 3KB 请求 -> Small, 40KB 请求 -> Humongous，浪费率 < 50%（Specialized 1KB 分配 900B 浪费 12%，Small 2KB 分配 1500B 浪费 25%）。

### 4.2 SpaceManager 的 bump-pointer 快速路径（WHY current_chunk 缓存）

**(a) SpaceManager::allocate() 的两段式分配是怎样的？**
`spaceManager.cpp` 中的 `allocate()` 首先检查 `current_chunk()->free_word_size() >= word_size` — 若是，bump-pointer 直接返回（无锁、O(1)）。若否，调用 `allocate_work()` — 先检查 BlockFreelist 是否有回收的合适块，再触发 ChunkManager 获取新 Chunk，最后走 VirtualSpace 扩容。

**(b) 为什么 bump-pointer 分配和 BlockFreelist 查询有语义分离？**
Bump-pointer 分配返回的是全新未初始化内存（指针自增），而 BlockFreelist 返回的是已初始化的回收块（需要保留块中的元数据）。Klass allocation 需要内存清零（`new Klass()` 构造清零），但 `deallocate()` 后返回的块可能包含旧数据——必须由调用者清零确认。追问：为什么 Metaspace 不直接用 memset(0)？（性能：Klass 构造本身负责初始化字段，额外 memset 浪费 CPU）

**(c) Counterfactual — 如果 SpaceManager 不用 current_chunk 缓存，每次都从 ChunkManager 取？** 每次 Metaspace 分配都需获取 MetaspaceExpand_lock 进行 chunk_freelist_allocate()。在类加载密集阶段（如 Reflection 生成大量代理类），每次分配 200-500B 都需要全局锁 → 锁竞争成为瓶颈。`current_chunk` 缓存将分配从全局串行化为 per-SpaceManager 本地操作，摊销了锁开销。

### 4.3 BlockFreelist 的延迟返还策略（WHY 100 块阈值）

**(a) BlockFreelist 和 SmallBlocks 的职责划分？**
`BlockFreelist::_blocks` (BlockTreeArray) 按 size 维度索引块列表（类似 ChunkManager 的三级池）。
`BlockFreelist::_small_blocks` (SmallBlocks) 处理 ≤256B 的超小块——因为这些块分配频率高但价值低，不值得占用 BlockFreelist 的固定容量。
`SmallBlocks::return_block()` (`smallBlocks.cpp`) 直接用固定大小数组池化，分配/回收 O(1)。

**(b) 为什么 BlockFreelist::purge() 在 100 块时才触发？**
`blockFreelist.cpp` 中的 `return_block()` 在计数达到 threshold 时调用 `purge()` — 将缓存块逐批返还给 SpaceManager。100 的取值是经验值：太低 → 频繁获取 MetaspaceExpand_lock（每 10 个块一次 purge 导致 10 倍锁竞争）；太高 → 缓存的块占用虚拟地址空间不释放。100 是一次 JVM 参数微调后的结果。

**(c) Counterfactual — 如果使用 unbounded BlockFreelist（无 purge 阈值）？** 一个短暂存在的 ClassLoader 加载 5000 个小类后卸载。BlockFreelist 累积 5000 个回收块（~5KB × 5000 = 25MB committed），这些块已被 uncommit（PROT_NONE），但 VirtualSpace 占用映客地址无法回收。Linux OOM killer 会看到进程 RSS 包含这 25MB → 导致误杀。

### 4.4 chunk_freelist_allocate() 的 split 和 coalesce（WHY 两个方向）

**(a) split_chunk() 的递归分割算法**
`chunkManager.cpp:406-495` — `split_chunk()` 将一个 larger_chunk（如 Medium 32KB）分割为 target_chunk（如 Specialized 1KB）和 remainder chunks。
算法：先创建 target_chunk → 循环在剩余空间中以最大可能 alignment 创建 chunks（`prev_chunk_index` 递减扫描）。
关键：split 后的剩余 chunks 直接返回给 ChunkManager 的对应 FreeList，保持 `_free_chunks_total` 不变（空间不变，chunk 数增加）。

**(b) attempt_to_coalesce_around_chunk() 的合并约束**
`chunkManager.cpp:127-218` — 合并的 6 步安全检查：
1. Chunk 类型必须匹配（Specialized→Small 或 Small→Medium）
2. 合并范围必须在 VirtualSpaceNode 已提交区域内
3. 两端必须是 Chunk 边界（`chunk_starts_at_address()`）
4. OccupancyMap 区域检查无活跃 Chunk
5. 删除旧 chunks + 创建新 merged chunk
6. 更新 OccupancyMap 的 chunk_start 位

**(c) Counterfactual — 如果 split 和 coalesce 不在 freelist 操作时做而在独立的后台任务中做？** CMS collector 的 `CompactibleFreeListSpace` 就是这种设计——分配从不 compaction，只在 GC 期间做。但 Metaspace 没有独立的 GC 触发（MetaspaceGC 只是调整阈值），如果 split/coalesce 延迟，可能出现"有 10MB 空闲 Chunk 但全是 1KB 碎片，无法满足 3KB 分配"的伪 OOM。在 freelist 操作时立即做可以防止碎片扩散。

### 4.5 BinaryTreeDictionary 的 best-fit 语义（WHY 红黑树 + 链表混合）

**(a) 为什么 humongous 不用 FreeList 链表？**
`FreeList` (`freeList.hpp`) 是固定大小链表——每个节点的大小由 `_size` 确定。Humongous 大小不固定，用链表需要 O(n) 扫描找最佳匹配。红黑树的 `find_node(word_size)` 操作是 O(log n) — 找到第一个 size >= word_size 的 TreeChunk。
关键优化：`TreeList::get_chunk()` 使用 `best_fit` 而非 `first_fit` — 选择 size >= word_size 的最小 chunk，减少内部碎片。

**(b) `TreeChunk` 如何复用 `next/prev` 为 `left/right/parent`？**
`binaryTreeDictionary.hpp` 中 `TreeChunk` 继承自 `Metachunk`，复用 `_next`/`_prev` 为树指针（`_left`/`_right`/`_parent`）。当 chunk 在 FreeList 中时表现为链表节点；当 chunk 在红黑树中时表现为树节点。通过 `is_free()` 标志位 + `_list` 成员区分状态。

**(c) Counterfactual — 如果 humongous 也用 FreeList 但按 4KB page 对齐？** 这种设计（FreeBSD jemalloc slab layout）的好处是简化查找（每页固定大小），但会对齐浪费：一个 33KB humongous chunk 需要 36KB（9 pages），浪费 8%。BinaryTreeDictionary 的 best-fit 布局可以做到 33KB → 34KB（浪费 3%），但代价是树维护成本。Metaspace 选择了精度优先——因为 Humongous 分配是低频操作，树维护成本可接受。

### 4.6 OccupancyMap 的 bit-level 追踪（WHY bit-per-chunk 而非 page-level）

**(a) OccupancyMap 的两种 bit 语义**
`OccupancyMap::_map` (BitMap) 中每个 Bit 代表一个 chunk_word 对应 64 bit。两种位类型：
1. **in_use** bit — `set_bit_for_chunk()` / `clr_bit_for_chunk()` — 标记 chunk 内所有 word 的 in-use 状态
2. **chunk_starts** bit — 只在 chunk 起始地址处为 1，用于 `chunk_starts_at_address()` 验证 chunk 边界 (`occupancyMap.cpp`)

**(b) 为什么 OccupancyMap 粒度是 word (8B) 而非 page (4KB)？**
Metaspace 的分配粒度是 word (8B in 64-bit)。如果 OccupancyMap 粒度为 page，`chunk_starts_at_address()` 无法区分 "一个 chunk 从 page 中间开始" 还是 "相邻 Chunk 之间的边界" — 这对 `attempt_to_coalesce_around_chunk()` 的验证是致命的（合并时需确认合并区域的起终点正好是 Chunk 边界）。

**(c) Counterfactual — 如果 OccupancyMap 用 C++ `std::bitset`？** `std::bitset<N>` 需要编译期确定大小，而 VirtualSpaceNode 大小是运行期 mmap 返回的。`BitMap` (`bitMap.hpp`) 是 HotSpot 自研的运行时位图——底层用 `BitMap::bm_word_t*`（堆分配数组），支持 `set_range()`/`clear_range()` 等范围操作，适合大范围 Chunk 标记（chunk 可能数百 words）。

---

## §五 Article Structure

建议分以下 10 个 section：

1. **§〇 生产场景** — 3 个场景（碎片化/Chunk饥饿/BlockFreelist OOM误报）
2. **§一 ChunkManager 源码全链路** — chunk_freelist_allocate / return_single_chunk / split_chunk / attempt_to_coalesce 四操作逐行分析
3. **§二 SpaceManager bump-pointer 分配** — allocate / allocate_work / deallocate 三段
4. **§三 BlockFreelist 延迟缓存** — get_block / return_block / purge + SmallBlocks
5. **§四 BinaryTreeDictionary best-fit** — find_node / get_chunk / remove_chunk 三操作
6. **§五 FreeList 固定大小链表** — return_chunk_at_head / remove_chunk
7. **§六 OccupancyMap bit 追踪** — chunk_starts_at_address / set_chunk_starts / wipe_chunk_start_bits
8. **§七 MetaChunk 生命周期** — 分配(allocated) → 使用(in_use) → 回收(free) → 清除(purged) 状态机
9. **§八 诊断工具** — Metaspace DCmd / hs_err 中的 Metaspace 段 / strace 查看 mmap/mprotect
10. **§九 Cross-Reference** — 与 Doc-00（VirtualSpace Layer）和 Doc-01（Arena/ResourceArea）的关系

---

## §六 Writing Requirements（含 ≥8 行"不要写成→应该写成"对照表）

| 不要写成 | 应该写成 |
|---------|---------|
| 机械列出 chunkManager.cpp 的每个函数签名和参数 | 解释 `chunk_freelist_allocate()` 为什么先查 Small→Medium→Humongous 三级池（递增 size 减少内部碎片），再为什么 split 大 Chunk（避免 O(n) 扫描不同大小链表） |
| 只展示 `metachunk.hpp` 的 struct 字段定义 | 分析 Metachunk 的 `_word_size`/`_container`/`_origin`/`_use_count` 四个字段如何支持 ChunkManager 的 ref-counting 和 coalesce 验证（origin_split 可合并，origin_merge 不可再合并） |
| 把 BinaryTreeDictionary 当成黑盒"红黑树"一笔带过 | 展开 `TreeChunk` 如何复用 `_next/_prev` 为 `_left/_right/_parent` 的 C++ union 技巧，为 `TreeList::insert()` 和 `TreeList::remove()` 提供精确 file:line |
| 列出 SpaceManager::allocate() 的伪代码算法 | 逐行解析 bump-pointer 的 if-else 两条路径（`current_chunk->free_word_size() >= word_size` 和 `< word_size` 分支）含汇编级分析：bump-pointer 是单条 ADD 指令，allocate_work 是 ~500 条指令的完整分配路径 |
| 不提 ChunkManager::split_chunk() 的 align_down 细节 | 解释为什么 `split_chunk()` 中 remainder chunk 的大小选择必须是 `is_aligned(p, this_chunk_word_size)` —— Metachunk 按自己的 size 对齐，如果 alignment 不对，OccupancyMap 的 chunk_starts 检测会错误地把边界内地址当成 chunk_start |
| 只提"BlockFreelist 缓存块" | 解释 `BlockFreelist::return_block()` 为什么用 `BlockTreeArray`（按 size 二分索引）而非 `hashmap`（hashcode 冲突导致 O(k) CAS）—— size 是离散的有限集合（12 种常见大小），数组索引是 O(1) |
| 不详述 OccupancyMap::chunk_starts_at_address() 的内部实现 | 展开 `OccupancyMap::get_bit()` 的 `_map[index_to_bit_index(word_offset)]` 转换成 `bm_word_t` mask AND，解释为什么 chunk_start bit 只在 chunk 头部为 1（coalesce 时无需扫描整个 chunk — 只需检查区间起始地址的 1 个 bit） |
| 不提 MetaspaceExpand_lock 在 split/coalesce 中的角色 | 解释 `chunkManager.cpp:128 assert_lock_strong(MetaspaceExpand_lock)` — split_chunk 和 attempt_to_coalesce 都要求持锁，因为两者操作共享的 OccupancyMap 和 VirtualSpaceNode `container_count`，锁保护跨 Chunk 的位图修改 |

---

## §七 Output Format

- 每节开头用 H4 标题（`####`）标识具体主题
- 每个技术断言标注 `file:line` 引用格式为 `chunkManager.cpp:296` 等
- 代码片段用 ```cpp 代码块，标注源文件路径和行号范围
- Callout 框用 `> **Beginner Callout N — ...** 设计意图：...` 格式
- Counterfactual 用 `> **Counterfactual** — 如果...则会...` 格式
- Mermaid 图建议至少 2 个：ChunkManager 四级池架构图 + SpaceManager allocate 全链路序列图
- 文件头部用 `# 02-Metaspace Internals — 分配器三层 + 二叉树 + 占位图`

---

## §八 Prohibited（≥8 条）

1. **不要写成 Metaspace 入门教程** — 读者应已从 libjvm-analysis 理解 Metaspace 高层架构（ClassLoaderMetaspace/VirtualSpaceList/MetaspaceGC）
2. **不要只翻译 `chunkManager.hpp` 的头文件注释** — 每个 `ChunkManager::` 成员函数要用实际调用链解释为什么这么设计
3. **不要跳过 `metachunk.cpp` 的 mangle() 实现** — `chunk->mangle(badMetaWordVal)` 是调试特性，对理解 chunk 生命周期状态机很重要
4. **不要遗漏 OccupancyMap::chunk_starts_at_address() 的 align_down 约束** — 这是 coalesce 正确性的核心前提
5. **不要把 4 个分配器层次（ChunkManager/SpaceManager/BlockFreelist/FreeList）当独立章节孤立讨论** — 必须展示完整的分配链（从 Metaspace::allocate 到 VirtualSpace mmap）
6. **不要忽略 ChunkManager::free_chunks_get() 返回 NULL 后的扩容路径** — 这是触发 MetaspaceGC 的唯一场景，也是 OOM 的根本原因
7. **不要用 "链表" 描述 BinaryTreeDictionary 的 Humongous 管理** — 那是红黑树，性质和性能分析完全不同
8. **不要省略 `account_for_added_chunk/removed_chunk` 的计数器 concurrency 语义** — `_free_chunks_total` 和 `_free_chunks_count` 是统计量（非精确），在有锁保护下仍可能因 assert 中的 `slow_locked_verify_free_chunks_total()` 触发验证差异
9. **不要写 < 2 个 mermaid 图** — 至少需要一个 ChunkManager 四级池架构图 + 一个 SpaceManager allocate 全链路序列图
10. **不要遗漏 Metaspace DCmd 的输出格式和解读** — 必须解释 `VM.metaspace` 输出中 `ChunkFreeListSummary` 的四列含义

---

## §九 Required（≥8 条）

1. ★ **chunk_freelist_allocate() 源码逐行分析** — 从 free_list->head() NULL 检测→split_chunk→account_for_removed 全路径，标注精确 file:line
2. ★ **return_single_chunk() 的 coalesce 递归合并** — 展示 attempt_to_coalesce 先尝试 Medium→再回退 Small 的两次尝试逻辑
3. ★ **SpaceManager::allocate() bump-pointer if-else 两条路径** — 含汇编指令计数（bump: 1 ADD + 1 CMP; slow: ~500 条指令）
4. ★ **BlockFreelist return_block 延迟返还 + purge 阈值** — 标注 100 块阈值的位置和设计理由
5. ★ **BinaryTreeDictionary::get_chunk() 的 best_fit 查找** — treeSearch 递归函数 + 返回 >= word_size 的最小 chunk
6. ★ **OccupancyMap::chunk_starts_at_address() bit 操作** — 展开 _map 索引计算 + BitMap::par_set_bit 的原子操作
7. ★ **MetaChunk 四字段（_word_size/_container/_origin/_use_count）的完整生命周期** — 从 ::new placement new 构造到 mangle 销毁
8. ★ **Metaspace DCmd 输出解读 + strace 验证** — jcmd VM.metaspace 全字段解释 + strace -e mmap,mprotect,madvise 跟踪 VirtualSpace 操作
9. ★ **Mermaid 序列图** — 从 Metaspace::allocate() 到 VirtualSpace::expand_by() 的 5 lane 完整路径
10. ★ **与 Doc-00 (VirtualSpace) 和 Doc-01 (Arena) 的交叉引用表** — 标注每个分配器在内存层次中的位置和调用关系

---

## §十 GDB Verification（≥7 assertions）

1. **ChunkManager 四级池状态查看**
```gdb
(gdb) p Metaspace::_class_space_list
(gdb) p ((VirtualSpaceList*)...).chunk_manager()
(gdb) p *(ChunkManager*)0x7ffff0xxx
# 验证 _free_chunks[0/1/2] 的 _count 和 _size
# 验证 _humongous_dictionary._root 是否 NULL
```

2. **单个 Chunk 的 origin 追踪**
```gdb
(gdb) p ((Metachunk*)0x7fffexxx)->_origin
# 应为 origin_normal / origin_split / origin_merge / origin_minimal
# 验证 split 后的 chunk 保持 origin_split 不影响 coalesce
```

3. **SpaceManager::current_chunk() bump-pointer 状态**
```gdb
(gdb) p ((SpaceManager*)0x7fffexxx)->_current_chunk
(gdb) p ((Metachunk*)$1)->_top - ((Metachunk*)$1)->_bottom
# 应等于 current_chunk 已使用大小
```

4. **BlockFreelist purge 阈值验证**
```gdb
(gdb) p ((BlockFreelist*)0x7fffexxx)->_small_blocks
(gdb) p ((BlockFreelist*)0x7fffexxx)->_blocks._arrays[0]._count
# 验证每个 size class 的块数 < 100
```

5. **OccupancyMap chunk_start bit 验证**
```gdb
(gdb) p ((VirtualSpaceNode*)0x7fffexxx)->_occupancy_map
(gdb) p ((OccupancyMap*)$1)._map._size
(gdb) p ((OccupancyMap*)$1)._map._map[0]
# 验证 chunk 起始地址处的 bit 为 1
```

6. **BinaryTreeDictionary 红黑树平衡性验证**
```gdb
(gdb) p ((ChunkManager*)0x7fffexxx)->_humongous_dictionary
(gdb) p ((BinaryTreeDictionary<...>*)$1)._root._left
# 验证红黑树性质：左子树所有节点 size <= 根 size <= 右子树
```

7. **strace 追踪 ChunkManager allocate 的 mmap 操作**
```bash
strace -e trace=mmap,mprotect,madvise -p $(pgrep -f java) 2>&1 | head -20
# 观察 VirtualSpaceNode expand 时的 mmap(MAP_NORESERVE) + mprotect(PROT_READ|PROT_WRITE)
```

8. **jcmd VM.metaspace 输出验证**
```bash
jcmd <pid> VM.metaspace
# 检查 ChunkFreeListSummary 的 specialized/small/medium/humongous 四列
# Waste 值 > Capacity*30% 表示碎片化严重
```

9. **Metaspace DCmd 的 strace + proc 组合验证**
```bash
strace -e trace=write -p $(pgrep -f "java.*-Xlog:gc+metaspace") 2>&1 | grep -E "(coalesc|split|returned)"
# 同时查看: cat /proc/<pid>/maps | grep "rw-p" | wc -l
# 验证 committed 区域数量
```

---

## §十一 与 README 和同组 prompt 的连续性

### 与 README 的关系
本文档是 Phase 27 规划的 doc-02 — Metaspace Internals，覆盖 ChunkManager/SpaceManager/BlockFreelist/BinaryTreeDictionary/FreeList/OccupancyMap/MetaChunk 的源码内部实现。

### 与同组 prompt 的关系
- **prompt-00 (VirtualSpace Layer)**: 本文档依赖 doc-00 分析的 VirtualSpace/ReservedSpace/VirtualSpaceNode。SpaceManager 通过 ChunkManager::chunk_freelist_allocate 失败后才触发 VirtualSpaceNode::allocate()。
- **prompt-01 (Arena & ResourceArea)**: Arena 是 thread-local 的无锁分配器，Metaspace 是全局的持锁分配器。两者对比：Arena 用 chunk 链表 + bump-pointer（无 free），Metaspace 用 FreeList + 红黑树（支持 free）。
- 读者应先读 doc-00 理解虚拟空间，再读本文档理解块级分配器
- doc-01 的 Arena 是备选路径——当 ResourceArea 快速分配不足时，fallback 到 Metaspace

### 与已完成 Phase 的关系
- `libjvm-analysis/01-jvm-startup/03-Metaspace.md` — 本文档的前置阅读：理解 Metaspace 高层架构
- `libjvm-analysis/03-object-model/06-TLAB-Detail.md` — TLAB 的 bump-pointer 分配与 SpaceManager::current_chunk 的 bump-pointer 原理相同
