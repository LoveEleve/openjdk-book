# 02. VirtualSpace — reserve/commit 三级虚拟地址管理

> 🔴 Deep | 10 KP 中的 2 个虚拟内存机制
> 读者处境: Metaspace 要 1GB 虚拟地址——但只用 200MB commit。VirtualSpace 管这种 reserve+commit 双级——被 CodeCache/Metaspace/GC heap 全部依赖。是 JVM 所有大面积内存区域的基础抽象。

### 1. ReservedSpace — 先占坑，后付费

场景: `ReservedSpace rs(1024*1024*1024, 64*1024, false)`——请求 1GB 虚拟地址，对齐到 64KB。`os::reserve_memory(size, alignment)`→mmap MAP_NORESERVE——**物理内存消耗: 0 字节**。

**ReservedSpace 构造** (`virtualspace.cpp:50-200`):
- `ReservedSpace(size_t size, size_t alignment, bool large, char* requested_addr, bool executable)`:
  - size→`align_up(size, os::vm_allocation_granularity())`——Linux 默认 64KB 对齐
  - `os::reserve_memory(size, alignment, addr)`→mmap→返回 base。如果 base 未对齐→`release_memory`→重试→最多 10 次→失败→vm_exit
  - [C++: `ReservedSpace::align_reserved_region(char* base, size_t alignment)`——`((size_t)base + alignment - 1) & ~(alignment - 1)`——向上对齐。如果 base 正好在 alignment 边界——`_noaccess_prefix = 0`。如果偏离→`_noaccess_prefix = aligned_base - base`——base 前有 unaccessible prefix]
  - [C++: `_noaccess_prefix`——对齐过大的地址后 base 前有多余空间→设为 `PROT_NONE` (mprotect)——防止越界访问。Metaspace 的 CompressedKlassSpace 需要 64KB 对齐——`_noaccess_prefix` 可能为 0-63KB]
- `split_reserved_space(char* base, size_t size, size_t split, bool realloc)`: 把一个大的 ReservedSpace 切成左右两块——GC parallel tasks region marching——`os::split_reserved_memory(base, size, split)`
- `first_part(size_t partition_size, size_t alignment, bool split)`: 取 ReservedSpace 的第一段——用于 GC heap 的 young/old gen split
- `last_part(size_t partition_size, size_t alignment)`: 取最后一段——剩余地址空间

**全局统计** (`virtualspace.cpp:300-400`):
- `ReservedSpace::_rs_allocations`: 累计 reserve 次数——JFR MemoryManager MBean `Reserved` counter
- `_total_reserved_bytes`, `_total_committed_bytes`: 全局统计——JMX `MemoryUsage.getCommitted()`
- [C++: NMT 追踪——`MemTracker::record_virtual_memory_reserve(base, size, CALLER_PC)`——每次 reserve 记录到 NMT virtual memory map——`jcmd VM.native_memory` 输出各区域的 committed vs reserved]

### 2. VirtualSpace — 三段 expand/shrink

**VirtualSpace** (`virtualspace.cpp:400-700`):
- 三段布局: `_low` (base)→`_low_boundary`/`_lower_high` (低区顶, committed)→`_middle_high` (中间区顶)→`_upper_high` (高区顶, committed)→`_high_boundary`→`_high` (top)
- `initialize(ReservedSpace rs, size_t commit_size)`: commit commit_size bytes→set `_lower_high = _low + commit_size`。`_middle_high = _upper_high = _lower_high`——初始只有 lower committed
- `expand_by(size_t size, bool is_lower)`: commit 更多→**只能向上扩展**——先 try lower (if room below _middle_high)→再 middle。不能跳过未 committed 段→sequential expansion
- [C++: VirtualSpace 的三段被 CodeCache 用为: lower=non-profiled (C1 without profiling), middle=profiled (C1 with profiling→C2 recompiled), upper=non-method (stubs/adapter/blobs)。中间区域不能单独释放——导致 CodeCache 的 profiled vs non-profiled 段不能运行时 rebalance——这是 "CodeCache full with profiled methods but non-profiled has space" 问题的根源]
- `shrink_by(size_t size, bool is_lower)`: uncommit→只能从**边界**shrink——先 upper boundary→再 middle boundary——不能从内部 uncommit
- [C++: `os::uncommit_memory(addr, size)`→madvise(MADV_DONTNEED)——告诉内核"这些页我不要了"——释放物理页但保留虚拟地址。下次需要时 `commit_memory`→mmap MAP_FIXED 重新分配物理页]

**三段被实际使用的案例**:
- Metaspace: lower=CompressedKlassSpace base (固定 1GB narrow klass)→middle=Metaspace chunks (ChunkManager 管理，动态增长)→upper=reserved for future
- CodeCache: lower=profiled (segmented)→middle=non-profiled→upper=non-method
- [C++: VirtualSpace **不是** GC heap——GC heap 有自己的 heap region 管理 (G1 HeapRegionManager)。VirtualSpace 是 Metaspace/CodeCache 的基础——GC heap 直接用 `os::reserve_memory` + 自己做 commit/split]

### 3. MemRegion — 基础区域抽象

**MemRegion** (`memRegion.hpp:30-85`):
- `HeapWord* _start` + `size_t _word_size`——`sizeof(MemRegion)=16B`——栈上 value type
- `contains(void* addr)`——判断地址在区域内——G1 region::is_in(addr)
- `intersection(MemRegion other)`——两区域交集——G1 CollectionSet::intersection
- [C++: MemRegion 在 GC 中大量使用——G1 的 HeapRegion 是 MemRegion 子类——加了 `_type`, `_humongous_start`, `_rem_set`。ScanClosure: `card(addr)>>MemRegion(start, card_size)>>HeapRegion::is_in(addr)`]

---

### 核心悬念

**"VirtualSpace 三段——被 Metaspace/CodeCache 全部依赖——但**不支持中间释放**。"** — CodeCache 的 profiled/non-profiled 三段固定在 VirtualSpace 中——不能运行时 rebalance——导致 "CodeCache full but heat map shows unused segments"。下一个: Arena——VM 自己的 C++ 内存分配器。

> → [03-arena-resourcearea-allocation.md](03-arena-resourcearea-allocation.md)
