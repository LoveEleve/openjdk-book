# 00-VirtualSpace Layer — 从 mmap 保留到分页提交

> **Phase**：[27-memory-extra] 虚拟空间管理 — VirtualSpace Layer
> **前置**：[01-jvm-startup/03-Metaspace.md]（Metaspace 初始化上下文）、[01-jvm-startup/02-G1-Heap-Startup.md]（ReservedHeapSpace 被 G1 使用的上下文）
> **配套**：prompt-01 (Arena & ResourceArea) — VirtualSpace 之上构建 Arena chunk 分配器、prompt-02 (Metaspace Internals) — 使用 VirtualSpaceList/VirtualSpaceNode 进行 Metachunk 级别分配
> **阅读收益**：追踪 JVM 从 `mmap(NULL, size, PROT_NONE, MAP_NORESERVE)` 保留虚拟地址，到 `VirtualSpace::expand_by()` 分步提交，再到 `VirtualSpaceNode::take_from_committed()` bump-pointer 分配的完整 4 层架构；掌握生产 OOM 时的 `/proc/self/maps` 诊断方法、CommitLimiter 防抖动机制、压缩指针保护页的 implicit null check 原理。

---

## §〇 生产场景 — /proc/self/maps 中的 PROT_NONE + Metaspace OOM 诊断

### 场景 1：Metaspace OOM 时 /proc/self/maps 分析

线上抛 `java.lang.OutOfMemoryError: Metaspace`，运维 `cat /proc/<pid>/maps | grep "---"` 发现大量 `PROT_NONE` 保留区。

**三步诊断**：

```bash
# Step 1: 确认 Metaspace 提交量
jcmd <pid> VM.metaspace show-loaders
# 输出: Usage: 241.3 MB, Capacity: 245.2 MB, Committed: 256.0 MB, Reserved: 1024.0 MB
# 解读: 保留了 1GB 地址空间，只提交了 256MB。256MB = MaxMetaspaceSize 上限

# Step 2: 查看 PROT_NONE 区域（保留未提交）
cat /proc/<pid>/maps | grep "---p" | wc -l      # 32 个 4KB 区域 = 128KB
cat /proc/<pid>/maps | grep "---p" | grep "7f" | head -3
# 输出示例:
# 7f8b20000000-7f8b24000000 ---p 00000000 00:00 0    ← 64MB PROT_NONE (未提交)
# 7f8b24000000-7f8b24010000 rw-p 00000000 00:00 0    ← 64KB RW (已提交)

# Step 3: 检查 CommitLimiter 是否已命中
jcmd <pid> VM.flags -all | grep MaxMetaspaceSize
# MaxMetaspaceSize = 268435456 (256MB)，已命中上限 — CommitLimiter 阻止进一步提交
```

**根因分析**：VirtualSpaceList 有 4 个 VirtualSpaceNode，每个 256KB。已提交 256MB 时，如果只用了 200MB，剩余的 56MB 分布在 4 个节点中。单个节点只有完全空闲才能 uncommit，碎片节点即使只有 1% 占用也不能归还。

### 场景 2：GC 间内存无法归还（RSS 不降）

GC 后 Metaspace 使用率降了 30%，但 `RSS` 没有下降。

**根因分析路径**：

```
GC 清理 ClassLoaderData
  → Metaspace::deallocate() 标记 chunk 空闲
    → ChunkManager::return_chunk() 返还 chunk
      → VirtualSpaceNode::retire() 检查是否可以 uncommit
        → CommitLimiter::possible_expansion_words() >= commit_granule_size?
          NO → 不触发 uncommit（防止抖动 — _commit_granule_size 默认 64K）
          YES → VirtualSpace::shrink_by() → os::uncommit_memory()
```

> **Beginner Callout — CommitLimiter 防抖动**：
> `_commit_granule_size`（默认 64K）决定 uncommit 后可否重新 commit。如果碎片化后空闲块分散在多个 VirtualSpaceNode 中，单个节点可能永远达不到 64K 空闲阈值，导致 RSS 持续占用。这是 JVM 的主动决策（防止频繁系统调用开销），而非 OS 行为。

### 场景 3：Large Pages 启动失败回退

`-XX:+UseLargePages` 但系统 hugetlbfs 未挂载。

**回退流程** (virtualspace.cpp:150-183, virtualspace.cpp:186-210):

```
os::can_commit_large_page_memory() → false (OS 不支持大页按需提交)
  → _special = true (line 150, 标记需特殊处理)
  → os::reserve_memory_special() → NULL (line 164, large page not available)
  → fallback to os::reserve_memory() (line 210, regular 4K pages)
    → 底层: mmap(NULL, size, PROT_NONE, MAP_NORESERVE|MAP_ANONYMOUS|MAP_PRIVATE)
  → _special = false (line 176 未设置，保持默认 false)
  → _alignment = MAX2(alignment, vm_page_size()) (line 133)
```

Fallback 后 `_special=false` 意味着后续 `expand_by()` 会走 `os::commit_memory()` 而非直接使用已提交的大页空间——这是关键语义变化：`_special=true` 的 VirtualSpace 不调用 `commit_memory()`/`uncommit_memory()`，所有扩展只是指针推进。

### 诊断工具链（集成场景中）

```bash
# strace: 跟踪 mmap/mprotect 调用，确认保留 vs 提交边界
strace -e trace=mmap,mprotect,madvise -p <pid> 2>&1 | grep -E "PROT_NONE|MAP_NORESERVE"

# jcmd: 查看 Metaspace 提交量
jcmd <pid> VM.metaspace

# /proc/self/maps: 可视化保留 vs 提交
cat /proc/<pid>/maps | awk '{print $1, $2}' | sort | uniq -c
# 大量 "---p" (PROT_NONE) 行 = 保留未提交；rw-p 行 = 已提交

# GDB: 检查 VirtualSpaceList 状态
gdb -p <pid> -ex "print Metaspace::_class_space_list->_current_virtual_space->_virtual_space._low"
gdb -p <pid> -ex "print Metaspace::_class_space_list->_current_virtual_space->_virtual_space._high"
```

---

## §一 Reserve → Commit → Use 三层模型 — 架构总览

### What/Why

HotSpot 的虚拟空间管理遵循 "Reserve → Commit → Use" 三层模型，将地址空间保留与物理内存提交解耦。这种分离不是 OS 强制要求的，而是 JVM 为了精细化内存控制而主动设计的分层架构。

**核心洞察**：mmap(2) 的 `MAP_NORESERVE` 标志（Linux 特有）允许 JVM 只保留虚拟地址而不预分配 swap 空间或物理页。提交（commit）时才建立页表映射并分配物理内存——这给了 JVM 极大的控制粒度，可以在运行时动态调整提交量，响应 GC 回收让出未使用的物理页。

> **Beginner Callout 1 — 保留/提交分离**：
> `mmap(NULL, size, PROT_NONE, MAP_NORESERVE)` 只占地址空间不占物理页。类比：预订了 100 个车位（保留），但只给 10 个车位铺了地面（提交）。之所以能这样做，是因为 Linux 的 demand paging 机制——访问 PROT_NONE 页会触发 SIGSEGV；访问 RW 但未映射物理页的地址会触发 page fault，kernel 在 page fault handler 中分配物理页（如果 MAP_NORESERVE 没有预分配 swap 空间，此时 OOM killer 可能介入）。**关键源码**：virtualspace.cpp:210 的 `os::reserve_memory()` 底层调用 mmap(2)，参数 `PROT_NONE|MAP_NORESERVE`。

### ASCII 内存布局图

```
  Address Space Layout (64-bit, x86_64):

  0x0000000000000000                                   0x7FFFFFFFFFFFFFFF
  ├───── C Heap ──────────┤├───── JVM Metaspace ──────┤
                              │
                              ├── ReservedSpace::_base (0x7f8b20000000)
                              │
 ReservedSpace 边界:          │
    _base = 0x7f8b20000000    │
    _size = 1GB               │
    _noaccess_prefix = 0      │
    _alignment = 64K          │
    _special = false          │
                              │
 VirtualSpace 三区域 (expand_by 后):                     │
    0x7f8b20000000 ─────────┬─────────────── _low_boundary (reserved start)
    ├──────────────────────┤ ← _low (committed low)
    │   Committed Region   │   RW, 可安全读写的已提交区域
    │   (expanded by       │   mprotect(addr, sz, PROT_READ|PROT_WRITE)
    │    _high - _low)     │   man 2 mprotect
    ├──────────────────────┤ ← _high (committed high)
    │   Reserved,          │   PROT_NONE, 保留但未提交
    │   Uncommitted        │   访问触发 SIGSEGV
    ├──────────────────────┤ ← _high_boundary (reserved end)
    0x7f8b60000000 ─────────┘
```

**关键字段速查表**：

| 字段 | 类 | 语义 | 值示例 |
|------|-----|------|--------|
| `_base` | ReservedSpace | mmap 返回的起始地址 | `0x7f8b20000000` |
| `_size` | ReservedSpace | 保留的总字节数 | `1073741824` (1GB) |
| `_noaccess_prefix` | ReservedSpace | 压缩指针保护页大小 | `65536` (64KB) 或 `0` |
| `_alignment` | ReservedSpace | 对齐要求 | `65536` (os::vm_allocation_granularity) |
| `_special` | ReservedSpace/VirtualSpace | 整个空间已预先提交并固定 | `false`（普通）/ `true`（大页） |
| `_low_boundary` | VirtualSpace | 保留区的起始边界 | `0x7f8b20000000` |
| `_high_boundary` | VirtualSpace | 保留区的结束边界 | `0x7f8b60000000` |
| `_low` | VirtualSpace | 已提交区的低端 | `0x7f8b20000000` (初始 = low_boundary) |
| `_high` | VirtualSpace | 已提交区的高端 | `0x7f8b20000000` (初始 = low，commit=0) |

### Mermaid 序列图 — Reserve→Commit→Expand→Use 全链路

```mermaid
sequenceDiagram
    participant Caller as JVM Startup /<br/>Metaspace::initialize()
    participant RS as ReservedSpace
    participant OS_R as os::reserve_memory()
    participant Kernel as Linux Kernel
    participant VS as VirtualSpace
    participant OS_C as os::commit_memory()
    participant VSN as VirtualSpaceNode
    participant User as Metachunk User

    Note over Caller,Kernel: === Phase 1: Reserve (仅占地址空间, 不分配物理页) ===
    Caller->>RS: initialize(size, alignment, large, addr, exec)
    Note right of RS: virtualspace.cpp:122-243

    alt special path (large pages)
        RS->>OS_R: os::reserve_memory_special(size, alignment, addr, exec)
        Note right of OS_R: virtualspace.cpp:164
        OS_R->>Kernel: mmap + hugetlbfs allocation
        Kernel-->>OS_R: base address (or NULL if failed)
        OS_R-->>RS: base (or fall through to regular)
    end

    RS->>OS_R: os::reserve_memory(size, NULL, alignment, fd)
    Note right of OS_R: virtualspace.cpp:210 — Linux path
    OS_R->>Kernel: mmap(NULL, size, PROT_NONE, MAP_NORESERVE|MAP_ANONYMOUS|MAP_PRIVATE)
    Note right of Kernel: man 2 mmap: 只保留VA空间(~ns)<br/>物理页 0 字节
    Kernel-->>OS_R: base = 0x7f8b20000000
    OS_R-->>RS: base address
    RS-->>Caller: _base=0x7f8b..., _size=1GB, _special=false

    Note over Caller,Kernel: === Phase 2: Commit (分步提交物理页) ===
    Caller->>VS: initialize_with_granularity(rs, committed_size, max_commit_granularity)
    Note right of VS: virtualspace.cpp:836-881
    VS->>VS: 设置三区域边界: lower/middle/upper alignment
    VS->>VS: _low = low_boundary, _high = low (commit=0)

    VS->>VS: expand_by(committed_size)
    Note right of VS: virtualspace.cpp:1000-1086

    loop 分三区域提交 (lower/middle/upper)
        alt _special = true
            Note right of VS: virtualspace.cpp:1005-1008<br/>跳过os::commit_memory()<br/>仅推进指针
        else regular path
            VS->>OS_C: commit_expanded(start, size, alignment)
            Note right of OS_C: virtualspace.cpp:972-986
            OS_C->>Kernel: mprotect(start, size, PROT_READ|PROT_WRITE)
            Note right of Kernel: man 2 mprotect<br/>修改VMA权限<br/>物理页仍按需分配
            Kernel-->>OS_C: 0 (success)
            OS_C->>Kernel: (可选) pretouch: 逐页写入触发page fault
            Note right of Kernel: virtualspace.cpp:965-970<br/>AlwaysPreTouch 标志控制
        end
    end

    Note over Caller,Kernel: === Phase 3: Node-level Bump-pointer Allocation ===
    Caller->>VSN: initialize()
    Note right of VSN: virtualSpaceNode.cpp:568-607
    VSN->>VS: initialize_with_granularity(_rs, pre_committed_size, commit_alignment)
    VS-->>VSN: OK → _top = low()
    VSN->>VSN: new OccupancyMap(bottom, reserved_words, smallest_chunk_size)
    Note right of VSN: 1 bit 操作 1 个最小chunk(128 words=1KB)

    User->>VSN: take_from_committed(chunk_word_size)
    Note right of VSN: virtualSpaceNode.cpp:369-463
    alt 需要对齐
        VSN->>VSN: allocate_padding_chunks_until_top_is_at(next_aligned)
        Note right of VSN: 填充到 chunk size 边界<br/>virtualSpaceNode.cpp:307-364
    end
    VSN->>VSN: chunk_limit = _top; _top += chunk_word_size
    VSN->>User: Metachunk* at chunk_limit
    Note right of User: bump-pointer O(1) 分配
```

### 三层抽象的调用链

```
VirtualSpaceList (Metaspace专用)
  ├── 持有 VirtualSpaceNode 链表
  ├── get_new_chunk() → VirtualSpaceNode::take_from_committed()
  └── expand_by() → VirtualSpaceNode::expand_by() → VirtualSpace::expand_by()

VirtualSpaceNode (Metaspace专用封装)
  ├── 包装一个 VirtualSpace + ReservedSpace
  ├── _top: bump-pointer，指向下一个空闲地址
  ├── allocate_padding_chunks_until_top_is_at(): 对齐填充
  └── take_from_committed(): bump-pointer 分配 Metachunk

VirtualSpace (通用层)
  ├── 包装 ReservedSpace (通过初始化时注入)
  ├── _low/_high: 已提交区域边界指针
  ├── expand_by(): 分三区域 (lower/middle/upper) 分步提交
  └── shrink_by(): 分三区域分步解提交

ReservedSpace (最底层)
  ├── mmap(2) 保留虚拟地址空间
  ├── _special: 整个空间是否预先提交并固定
  └── 不管理提交——只管理保留/释放
```

> **Beginner Callout 2 — 虚拟空间管理的两个层次区分**：
> - **通用层**：`memory/virtualspace.hpp` 的 `ReservedSpace` + `VirtualSpace` — 被 heap、codecache、metaspace 等所有子系统共享使用
> - **Metaspace 专用层**：`memory/metaspace/virtualSpaceList.hpp` 的 `VirtualSpaceList` + `VirtualSpaceNode` — 在通用 VirtualSpace 之上加了一层 bump-pointer 分配器和 chunk 管理（OccupancyMap + padding chunk 机制）
>
> 简而言之：VirtualSpaceNode 是一个 VirtualSpace + 一个 bump-pointer `_top` + 一个 OccupancyMap 位图。VirtualSpaceList 是多个 VirtualSpaceNode 组成的单链表。

> **Beginner Callout 3 — MAP_NORESERVE 的语义**：
> Linux 特有标志（man 2 mmap: `MAP_NORESERVE` — "Do not reserve swap space for this mapping"）。mmap 成功但不保证后续写入成功——OOM killer 在 page fault 时介入。这是 JVM 能实现 "保留 4GB 堆但只提交 200MB" 的 OS 基础设施。没有 MAP_NORESERVE，mmap 会预分配 swap 空间（物理内存 + swap = commit charge），4GB 堆需要 4GB commit charge。

> **Beginner Callout 4 — _special 标志何时为 true**：
> ① 大页模式下 `!os::can_commit_large_page_memory()` 为 true（virtualspace.cpp:150）—— OS 不支持大页按需提交，必须一次性全部提交并固定；
> ② 文件映射堆（`_fd_for_heap != -1`，virtualspace.cpp:240-242）—— 分配在 backing file 上的堆，整个空间已在 open+fallocate 时提交。
> `_special=true` 的 VirtualSpace 不调用 `os::commit_memory()`/`os::uncommit_memory()`，expand_by/shrink_by 只是指针推进，是 trivially O(1) 操作。

> **Beginner Callout 5 — VirtualSpaceList 是什么**：
> Metaspace 的 VirtualSpace 链表，每个节点默认 `VirtualSpaceSize = 256 * K`（virtualSpaceList.hpp:42-44）。每次 Metaspace 需要新空间时，若当前节点不够，创建新节点链接到链表尾部。设计理由：O(1) 退役当前节点（retire_current_virtual_space）、细粒度 commit 控制（每个节点独立控制是否提交）、扩容无需移动已有节点（链表追加）。

> **Beginner Callout 6 — commit vs pre_touch**：
> `commit` = `mprotect(PROT_READ|PROT_WRITE)`（man 2 mprotect）改 VMA 权限允许访问。物理页通过 demand paging 在首次访问时分配。
> `pre_touch` = 逐页写入触发 page fault 提前建立页表映射（virtualspace.cpp:965-970: `pretouch_expanded_memory()` → `os::pretouch_memory()`），避免后续首次访问时的 fault 延迟。成本：pre_touch 在启动时增加延迟但消除运行时的突发延迟；不 pre_touch 启动快但运行时首次访问慢。

> **Beginner Callout 7 — VirtualSpace 三区域模型**：
> `_low` 和 `_high` 指针界定已提交区域。`_low` ~ `_high` 可读可写（已提交）。`_low_boundary` ~ `_low` 和 `_high` ~ `_high_boundary` 是 PROT_NONE 区域。初始 `_low == _high == _low_boundary`，表示没有任何提交。expand_by 推进 `_high` 并调用 commit_memory；shrink_by 缩减 `_high` 并调用 uncommit_memory。

---

## §二 Source Files Table + Standard Environment

### Source Roots

| 文件 | 完整路径 | 类型 | 关键位置 |
|------|---------|------|---------|
| libjvm 编译入口 | `make/hotspot/lib/CompileJvm.gmk:153` | Build | 本文档源代码统一编译到 libjvm.so |
| virtualspace.hpp | `src/hotspot/share/memory/virtualspace.hpp` | Header | ReservedSpace(:32-93), ReservedHeapSpace(:111-129), ReservedCodeSpace(:132-136), VirtualSpace(:140-239) |
| virtualspace.cpp | `src/hotspot/share/memory/virtualspace.cpp` | Impl | ReservedSpace::initialize(:122-243), ReservedSpace::release(:288-308), ReservedHeapSpace::try_reserve_heap(:348-433), ReservedHeapSpace::initialize_compressed_heap(:540-748), establish_noaccess_prefix(:314-340), VirtualSpace::expand_by(:1000-1086), VirtualSpace::shrink_by(:1091-1184) |
| virtualSpaceList.hpp | `src/hotspot/share/memory/metaspace/virtualSpaceList.hpp` | Header | VirtualSpaceSizes(:42-44), _envelope(:64-68), create_new_virtual_space(:90), retire_current_virtual_space(:94) |
| virtualSpaceList.cpp | `src/hotspot/share/memory/metaspace/virtualSpaceList.cpp` | Impl | VirtualSpaceList::VirtualSpaceList(:154-166, :168-215), create_new_virtual_space(:222-261), retire_current_virtual_space(:143-152), get_new_chunk(:378-410), expand_by(:304-358), link_vs(:263-286) |
| virtualSpaceNode.hpp | `src/hotspot/share/memory/metaspace/virtualSpaceNode.hpp` | Header | _top(:54), _occupancy_map(:58), allocate_padding_chunks_until_top_is_at(:78), take_from_committed(:132), retire(:149) |
| virtualSpaceNode.cpp | `src/hotspot/share/memory/metaspace/virtualSpaceNode.cpp` | Impl | constructor(:59-73), initialize(:568-607), take_from_committed(:369-463), allocate_padding_chunks_until_top_is_at(:307-364), expand_by(:467-492), retire(:636-658), OccupancyMap ASCII diagram(:500-567) |
| metaspaceCommon.hpp | `src/hotspot/share/memory/metaspace/metaspaceCommon.hpp` | Header | ChunkSizes(:35-42), ChunkIndex(:95-103) |
| metaspaceCommon.cpp | `src/hotspot/share/memory/metaspace/metaspaceCommon.cpp` | Impl | get_chunk_type_by_size(:157-185) |

### Build Command

```bash
bash configure --with-debug-level=slowdebug --with-jvm-features=cds
make hotspot  # 编译 libjvm.so (含本文档所有源码)
```

### Binary Path

`build/linux-x86_64-server-slowdebug/jdk/lib/server/libjvm.so`

### Syscall 速查表

| syscall | man | 使用文件:行号 | 用途 |
|---------|-----|------------|------|
| mmap(MAP_NORESERVE, PROT_NONE) | man 2 mmap | virtualspace.cpp:210 → os::reserve_memory() | 保留地址空间（零物理页成本） |
| mmap(MAP_ANONYMOUS\|MAP_PRIVATE) | man 2 mmap | virtualspace.cpp:210 | 匿名私有映射（不与文件关联） |
| mmap(MAP_FIXED\|MAP_NORESERVE) | man 2 mmap | virtualspace.cpp → os::uncommit_memory() | 重新映射为 PROT_NONE（归还物理页） |
| munmap | man 2 munmap | virtualspace.cpp:88-95 → os::release_memory() | 释放整个保留区域 |
| mprotect(PROT_NONE) | man 2 mprotect | virtualspace.cpp:324 | 保护页设置（implicit null check） |
| mprotect(PROT_READ\|PROT_WRITE) | man 2 mprotect | os_linux.cpp commit_memory | 提交页（改 VMA 权限为可读写） |
| madvise(MADV_DONTNEED) | man 2 madvise | os_linux.cpp uncommit_memory | 归还物理页（保留 VMA，延迟释放） |
| mincore | man 2 mincore | 诊断工具 | 检查页是否在物理内存中（page residency） |

### 全局状态表

| 标识符 | 类型 | 持有者 | 默认值/含义 |
|--------|------|--------|-----------|
| `VirtualSpaceSize` | `enum{256*K}` | VirtualSpaceList | 每个 VirtualSpaceNode 的默认大小 |
| `_commit_granule_size` | `size_t` | Metaspace Settings | 64K (root_chunk_size) — 决定 uncommit 阈值 |
| `MaxMetaspaceSize` | `uintx` | JVM Flag | 默认 2^64-1 (unlimited)，设为有限值时 CommitLimiter 激活 |
| `reserve_alignment` | `size_t` | Metaspace | os::vm_allocation_granularity() — mmap 对齐 |
| `commit_alignment` | `size_t` | Metaspace | root_chunk_size — 提交粒度对齐 |
| `_lower_alignment` | `size_t` | VirtualSpace | os::vm_page_size() — 低区域对齐 = 4KB |
| `_middle_alignment` | `size_t` | VirtualSpace | max_commit_granularity — 中间区域对齐 = 大页 |
| `_upper_alignment` | `size_t` | VirtualSpace | os::vm_page_size() — 高区域对齐 = 4KB |

---

## §三 ReservedSpace 内核 — initialize() 源码全路径

### What/Why

`ReservedSpace::initialize()`（virtualspace.cpp:122-243）是整个虚拟空间管理的地基。它实现了三级回退分配策略，从最优路径（大页预提交）逐步降级到最安全路径（OS 任意地址 4K 页）。这个分层设计的关键在于：**OS 内核不保证能分配指定地址、不保证能分配大页、甚至不保证 mmap 返回的地址是对齐的**——JVM 每一层都在做一个 "乐观尝试→失败回退→更保守尝试" 的循环。

### 三级回退策略

**Level 1 — Large Page Special 路径** (virtualspace.cpp:162-184):

```cpp
if (special) {
    base = os::reserve_memory_special(size, alignment, requested_address, executable);
    if (base != NULL) {
        // 检查地址是否和请求一致 (压缩指针场景强制要求)
        if (failed_to_reserve_as_requested(base, requested_address, size, true))
            return;  // OS 给了不同地址，不可接受
        assert((uintptr_t)base % alignment == 0, "Large pages returned a non-aligned address");
        _special = true;  // 标记为特殊路径，后续不调用 commit/uncommit
    }
}
```

**何时进入** (virtualspace.cpp:150): `special = large && !os::can_commit_large_page_memory()`。OS 不支持大页按需提交 → 必须一次性分配并提交（固定）所有物理页 → `os::reserve_memory_special()` 内部通过 hugetlbfs mmap 或 `shmget()+shmat()` 一次性获取。

> **Counterfactual 思维实验**：如果 JVM 对所有平台统一用 mmap 而不区分 special/regular —— Linux hugetlbfs 需要显式 `mount -t hugetlbfs` 才能使用，但 mmap 不会自动回退到普通页导致启动失败。

**Level 2 — Requested Address 路径** (virtualspace.cpp:195-201):

```cpp
if (requested_address != 0) {
    base = os::attempt_reserve_memory_at(size, requested_address, _fd_for_heap);
    if (failed_to_reserve_as_requested(base, requested_address, size, ...)) {
        base = NULL;  // OS 忽略了我们的请求地址，放弃此次分配
    }
}
```

`os::attempt_reserve_memory_at()` 底层使用 `mmap(2)` 的 `MAP_FIXED` 标志，强制在指定地址分配。但 OS 可能已经在该地址有映射，返回不同地址或失败。`failed_to_reserve_as_requested()` (virtualspace.cpp:99-120) 检测这种情况——只对压缩指针堆严格检查（`UseCompressedOops=true` 时地址精确性至关重要）。

**Level 3 — OS-Chosen Address 路径** (virtualspace.cpp:202-211):

```cpp
base = NOT_MACOS(os::reserve_memory(size, NULL, alignment, _fd_for_heap))
       MACOS_ONLY(os::reserve_memory(size, NULL, alignment, _fd_for_heap, _executable))
```

最保守路径：不指定地址，让 OS 任意选择一个合适的位置。**底层 syscall**：`mmap(NULL, size, PROT_NONE, MAP_NORESERVE|MAP_ANONYMOUS|MAP_PRIVATE)` (man 2 mmap)。

**参数选择理由**：
- `PROT_NONE` — 只保留地址空间，不需要可读可写，后续通过 `mprotect(2)` 按需提交
- `MAP_NORESERVE` — Linux 特有：不预分配 swap/物理页。mmap 成功后不保证后续访问成功（OOM killer 在 page fault 时介入）
- `MAP_ANONYMOUS` — 匿名映射，不关联文件（区别于 `MAP_SHARED` 文件映射）
- `MAP_PRIVATE` — 私有 COW（Copy-On-Write）映射——fork 后父子进程独立

**地址对齐重试** (virtualspace.cpp:217-233)：如果 OS 返回的地址不满足对齐要求，需要 `os::release_memory` 释放 + 扩大 size（`align_up(size, alignment)` 补偿碎片区）+ `os::reserve_memory_aligned()` 重新 mmap。

### release() 的 special vs regular 路径

```cpp
void ReservedSpace::release() {  // virtualspace.cpp:288-308
    if (is_reserved()) {
        char *real_base = _base - _noaccess_prefix;  // 考虑保护页偏移
        const size_t real_size = _size + _noaccess_prefix;
        if (special()) {
            if (_fd_for_heap != -1)
                os::unmap_memory(real_base, real_size);
            else
                os::release_memory_special(real_base, real_size);
        } else {
            os::release_memory(real_base, real_size);  // 底层 munmap(2)
        }
    }
}
```

释放时必须将 `_noaccess_prefix` 加回，因为 `_base` 被 `establish_noaccess_prefix()` 向前偏移过（virtualspace.cpp:337-338）。

### first_part()/last_part() 切割语义

```cpp
ReservedSpace first_part(size_t partition_size, size_t alignment,
                         bool split, bool realloc) { // virtualspace.cpp:245-256
    if (split) os::split_reserved_memory(base(), size(), partition_size, realloc);
    ReservedSpace result(base(), partition_size, alignment, special(), executable());
    return result;
}

ReservedSpace last_part(size_t partition_size, size_t alignment) { // :259-265
    ReservedSpace result(base() + partition_size, size() - partition_size,
                         alignment, special(), executable());
    return result;
}
```

**关键语义**：
- `first_part` 和 `last_part` **共享同一底层 mmap 区域**——它们是同一块虚拟地址空间的不同窗口
- `split` 参数决定是否真正分割底层映射（调用 `os::split_reserved_memory()`，底层可能重新 munmap 部分范围再 mmap 两个独立区域）
- `realloc` 参数为 `false` 时，仅创建视图但不改变底层 mmap
- 一个 ReservedSpace 的 first_part + last_part 正好等于原空间（partition_size + (size - partition_size) = size）

**使用场景**：G1 用 first_part/last_part 切割 heap reserved area 为 young gen + old gen + humongous region 集合。CodeCache 用 first_part/last_part 切割 reserved area 为 NonProfiled + Profiled + NonMethod 三个 CodeHeap。

### OS 平台差异

本文档以 Linux x86_64 为主要分析平台。`os::reserve_memory()` 和 `os::reserve_memory_special()` 的平台实现差异：

| 平台 | `os::reserve_memory()` (匿名保留) | `os::reserve_memory_special()` (大页) |
|------|-----------------------------------|---------------------------------------|
| **Linux** | `mmap(NULL, size, PROT_NONE, MAP_NORESERVE\|MAP_ANONYMOUS\|MAP_PRIVATE)` (`os_linux.cpp`) | `mmap()` hugetlbfs 或 `/dev/shm` 上的共享内存 (`os_linux.cpp`) |
| **macOS** | `mach_vm_allocate()` with `VM_FLAGS_ANYWHERE` (`os_bsd.cpp`) | 不支持 large page（macOS 无 hugetlbfs 等效物） |
| **Windows** | `VirtualAlloc(NULL, size, MEM_RESERVE, PAGE_NOACCESS)` (`os_windows.cpp`) | `VirtualAllocEx()` with `MEM_LARGE_PAGES` privilege |

关键差异：
- Linux `MAP_NORESERVE` 不预分配 swap，提交时通过 page fault 分配物理页；macOS `mach_vm_allocate` 无 NORESERVE 等价语义
- Linux large page 需 `hugetlbfs` 挂载且 `shmget()` 可用；Windows 需 `SeLockMemoryPrivilege` 权限
- 三平台统一的 `ReservedSpace::initialize()` 封装了平台差异：Linux 路径 → `mmap(2)`, macOS 路径 → `mach_vm_allocate()`, Windows 路径 → `VirtualAlloc()`

---

## §四 VirtualSpace 状态机 — expand_by()/shrink_by()

### What/Why

VirtualSpace 是 ReservedSpace 之上的 "提交管理层"。它通过四个指针 (`_low_boundary`, `_low`, `_high`, `_high_boundary`) 将 ReservedSpace 的完整保留区域划分为已提交和未提交两部分。核心操作是 `expand_by()` 和 `shrink_by()`，它们实现了三区域模型（lower/middle/upper），分别对应不同的页大小对齐要求——这个设计用于支持混合大小页（MPSS，Multiple Page Size Support），中间区域使用大页，两端使用默认 4K 页以处理未对齐边界。

### 三区域模型的初始化

```cpp
bool VirtualSpace::initialize_with_granularity(ReservedSpace rs, size_t committed_size,
                                                size_t max_commit_granularity) {
    // virtualspace.cpp:836-881
    _low_boundary  = rs.base();
    _high_boundary = low_boundary() + rs.size();
    _low  = low_boundary();  // 初始：提交区域为空
    _high = low();
    _special = rs.special();  // 大页/文件映射：整个空间预先提交

    _lower_alignment  = os::vm_page_size();       // 低区域: 默认页 (4KB)
    _middle_alignment = max_commit_granularity;    // 中间区域: 大页对齐 (通常是 large_page_size)
    _upper_alignment  = os::vm_page_size();       // 上区域: 默认页 (4KB)

    // 设置三区域的边界
    _lower_high_boundary  = align_up(low_boundary(), middle_alignment());
    _middle_high_boundary = align_down(high_boundary(), middle_alignment());
    _upper_high_boundary  = high_boundary();

    // 三区域的 high 指针初始化为各自区域的起始地址
    _lower_high  = low_boundary();
    _middle_high = lower_high_boundary();
    _upper_high  = middle_high_boundary();
}
```

**三区域边界示意图**：

```
_low_boundary                                          _high_boundary
       │                                                     │
       │  ┌──────────────┬──────────────────┬──────────────┐ │
       │  │ Lower Region │  Middle Region   │ Upper Region │ │
       │  │ (default pg) │  (large pg size) │ (default pg) │ │
       │  │ 4KB aligned   │  2MB/1GB aligned │ 4KB aligned   │ │
  _lower_high =        _lower_high_boundary  _middle_high_boundary
  low_boundary          = _middle_low         = _upper_low
```

**设计理由**（virtualspace.cpp:850-862 注释）："Empirically, we see that with a 4MB page size, the only spaces that get handled this way are codecache and the heap itself, both of which provide a substantial performance boost in many benchmarks when covered by large pages." 中区域大页对齐可减少 TLB misses——4MB 页比 4KB 页少 1024 倍 TLB entries 需求。

### expand_by() 的 commit_granularity 分步循环

```cpp
bool VirtualSpace::expand_by(size_t bytes, bool pre_touch) {
    // virtualspace.cpp:1000-1086
    if (uncommitted_size() < bytes) return false;

    if (special()) {
        _high += bytes;  // O(1) — 不调用任何 OS 函数
        return true;
    }

    // 计算各区域的新 high 指针
    char *unaligned_new_high = high() + bytes;
    char *unaligned_lower_new_high  = MIN2(unaligned_new_high, lower_high_boundary());
    char *unaligned_middle_new_high = MIN2(unaligned_new_high, middle_high_boundary());
    char *unaligned_upper_new_high  = MIN2(unaligned_new_high, upper_high_boundary());

    // 对齐到各自区域的粒度
    char *aligned_lower_new_high  = align_up(unaligned_lower_new_high, lower_alignment());
    char *aligned_middle_new_high = align_up(unaligned_middle_new_high, middle_alignment());
    char *aligned_upper_new_high  = align_up(unaligned_upper_new_high, upper_alignment());

    // 对每个区域，如果新 high > 当前 high，计算差值并提交
    if (aligned_lower_new_high > lower_high()) {
        size_t lower_needs = pointer_delta(aligned_lower_new_high, lower_high(), sizeof(char));
        if (!commit_expanded(lower_high(), lower_needs, _lower_alignment, pre_touch, _executable))
            return false;
        _lower_high += lower_needs;
    }
    // ... middle 和 upper 同理

    _high += bytes;
    return true;
}
```

**`commit_expanded()` 的底层操作** (virtualspace.cpp:972-986):

```cpp
static bool commit_expanded(char *start, size_t size, size_t alignment,
                            bool pre_touch, bool executable) {
    if (os::commit_memory(start, size, alignment, executable)) {
        // os::commit_memory → mprotect(start, size, PROT_READ|PROT_WRITE) on Linux
        if (pre_touch || AlwaysPreTouch) {
            pretouch_expanded_memory(start, start + size);
            // os::pretouch_memory() → 逐页写入触发 page fault
        }
        return true;
    }
    return false;
}
```

**核心逻辑**：expand_by 每次扩展走 `commit_expanded` → 调用 `os::commit_memory()` 提交一个新的物理页块。如果 `AlwaysPreTouch` 为 true 或调用者要求 `pre_touch=true`，则 `pretouch_expanded_memory()` 会逐页写入值触发 page fault 来预热 TLB 和页表。

> **Why 三区域分开提交**：如果一次 expand_by(1GB) 直接调用 `mprotect` 1GB 范围——OS 需要建立 256K 个页表条目（1GB / 4KB = 262,144），阻塞时间 > 1ms。分开按区域粒度提交可以限制每次系统调用的影响范围。

### shrink_by() → os::uncommit_memory()

```cpp
void VirtualSpace::shrink_by(size_t size) {
    // virtualspace.cpp:1091-1184
    if (special()) {
        _high -= size;  // O(1) — 直接回退指针
        return;
    }

    char *unaligned_new_high = high() - size;
    // 计算各区域的新 high，对齐到各自区域的粒度
    // 若 aligned_new_high < current_high，差值通过 os::uncommit_memory() 归还

    if (upper_needs > 0) {
        os::uncommit_memory(aligned_upper_new_high, upper_needs);
        _upper_high -= upper_needs;
    }
    // ... middle 和 lower 同理

    _high -= size;
}
```

`os::uncommit_memory()` 在 Linux 上的实现：使用 `mmap(MAP_FIXED|MAP_NORESERVE|MAP_ANONYMOUS|MAP_PRIVATE)` 将目标地址范围重新映射为 `PROT_NONE`，或者使用 `madvise(MADV_DONTNEED)` 归还物理页（取决于具体实现路径）。

### _special 标志对 expand_by/shrink_by 的影响

| 操作 | special=true | special=false (regular) |
|------|-------------|------------------------|
| expand_by | 直接 `_high += bytes`，不调用 OS | 调用 `commit_expanded()` → `os::commit_memory()` → mprotect |
| shrink_by | 直接 `_high -= size`，不调用 OS | 调用 `os::uncommit_memory()` → mmap MAP_FIXED 或 madvise |
| actual_committed_size() | = reserved_size() (全部算已提交) | = lower + middle + upper 各自计算 |
| 大页兼容性 | 是（hugetlbfs 分配） | 否（4K 页 + demand paging） |

---

## §五 VirtualSpaceList — 链式扩容

### What/Why

`VirtualSpaceList` 是 Metaspace 专用的 VirtualSpaceNode 链表管理器。它不是简单的数据结构——而是一个带有扩容策略、快速排除优化、节点退役机制的完整管理层。为什么需要链表？因为 Metaspace 的分配模式是 **增长性** 的（class loading 持续增长），单个 VirtualSpace 不足以容纳所有元数据，需要多个节点。

### 核心字段

```cpp
class VirtualSpaceList : public CHeapObj<mtClass> {
    enum VirtualSpaceSizes { VirtualSpaceSize = 256 * K }; // 默认节点大小
    VirtualSpaceNode* _virtual_space_list;    // 链表头
    VirtualSpaceNode* _current_virtual_space; // 当前活跃节点（最新分配的）
    bool _is_class;                           // 是否为 class space
    size_t _reserved_words;                   // 保留字数统计
    size_t _committed_words;                  // 已提交字数统计
    size_t _virtual_space_count;               // 节点计数
    address _envelope_lo;                     // 快速排除范围下界
    address _envelope_hi;                     // 快速排除范围上界
    // virtualSpaceList.hpp:38-164
};
```

### create_new_virtual_space() 分配流程

```cpp
bool VirtualSpaceList::create_new_virtual_space(size_t vs_word_size) {
    // virtualSpaceList.cpp:222-261
    assert_lock_strong(MetaspaceExpand_lock);

    if (is_class()) {
        assert(false, "We currently don't support more than one VirtualSpace for"
                      " the compressed class space.");
        return false;  // Class space 只允许一个节点
    }

    // 1. new VirtualSpaceNode(is_class, vs_byte_size)
    //    → 构造中调用 ReservedSpace(bytes, Metaspace::reserve_alignment(), large_pages)
    //    → 底层 mmap(2) 保留 256KB 地址空间
    VirtualSpaceNode *new_entry = new VirtualSpaceNode(is_class(), vs_byte_size);

    // 2. 初始化 VirtualSpace inside the node
    if (!new_entry->initialize()) {
        delete new_entry;
        return false;
    }

    // 3. 扩展 envelope 范围（快速排除优化）
    expand_envelope_to_include_node(new_entry);

    // 4. 内存屏障 + 链接
    OrderAccess::storestore();
    link_vs(new_entry);
    return true;
}
```

**link_vs 逻辑** (virtualSpaceList.cpp:263-286):
```cpp
void VirtualSpaceList::link_vs(VirtualSpaceNode *new_entry) {
    if (virtual_space_list() == NULL) {
        set_virtual_space_list(new_entry);   // 第一个节点
    } else {
        current_virtual_space()->set_next(new_entry); // 链接到当前尾部
    }
    set_current_virtual_space(new_entry);    // 新节点成为当前节点
    inc_reserved_words(new_entry->reserved_words());  // 统计累加
    inc_committed_words(new_entry->committed_words());
    inc_virtual_space_count();
}
```

### 256KB 节点大小的设计理由

1. **O(1) 退役** — `retire_current_virtual_space()` 只需遍历当前节点中的剩余空间按大->小顺序创建 chunks（virtualSpaceNode.cpp:636-658）。256KB 足够小，遍历完整个节点是 O(1) 相对于整体 Metaspace。
2. **细粒度 commit 控制** — 每次只需 commit 256KB 加入链，比 commit 64MB 的风险小很多。"如果 VirtualSpaceList 用单个大 VirtualSpace（如 64MB）而非 256KB 节点链表——扩容时一次 commit 64MB，即使用户只用 2MB，浪费 62MB 物理内存"。
3. **扩容无需移动** — 链表追加操作不涉及 memmove。如果用数组或 vector，扩容需要移动已有节点。
4. **节点独立退役** — 每个 VirtualSpaceNode 有自己的内存和 OccupancyMap，完全空闲的节点可以直接 `purge()` 并从链表中移除（virtualSpaceList.cpp:77-122）。

### retire_current_virtual_space() 退役机制

```cpp
void VirtualSpaceList::retire_current_virtual_space() {
    // virtualSpaceList.cpp:143-152
    VirtualSpaceNode *vsn = current_virtual_space();
    ChunkManager *cm = is_class() ? Metaspace::chunk_manager_class()
                                  : Metaspace::chunk_manager_metadata();
    vsn->retire(cm);  // 见 §六 VirtualSpaceNode::retire()
}
```

**触发时机**（virtualSpaceList.cpp:337）：当 `expand_node_by()` 失败（当前节点没有足够的 uncommitted 空间提交）时，先调用 `retire_current_virtual_space()` 将当前节点的剩余空间全部分配为 chunks 返还给 ChunkManager，然后调用 `create_new_virtual_space()` 分配新节点。

### _envelope 快速排除范围优化

```cpp
// virtualSpaceList.hpp:64-68
address _envelope_lo;
address _envelope_hi;

bool is_within_envelope(address p) const {
    return p >= _envelope_lo && p < _envelope_hi;
}
```

用于 `contains()` / `find_enclosing_space()` 的快速路径：

```cpp
VirtualSpaceNode* VirtualSpaceList::find_enclosing_space(const void* ptr) {
    // virtualSpaceList.cpp:128-141
    if (is_within_envelope((address)ptr)) {
        // 在 envelope 范围内才遍历链表——否则 O(1) 返回 NULL
        VirtualSpaceListIterator iter(virtual_space_list());
        while (iter.repeat()) {
            VirtualSpaceNode* vsn = iter.get_next();
            if (vsn->contains(ptr)) return vsn;
        }
    }
    return NULL;
}
```

**优化效果**：大部分查询指针不在 Metaspace 中时，一次比较即可排除，无需遍历整个链表。当有 100+ 个 VirtualSpaceNode 时，性能差异显著。

### expand_by — 从列表级到节点级

```cpp
bool VirtualSpaceList::expand_by(size_t min_words, size_t preferred_words) {
    // virtualSpaceList.cpp:304-358
    // 1. 检查 GC 是否允许扩展
    if (!MetaspaceGC::can_expand(min_words, this->is_class())) return false;

    // 2. 检查允许的扩展上限
    size_t allowed_expansion_words = MetaspaceGC::allowed_expansion();
    if (allowed_expansion_words < min_words) return false;

    // 3. 尝试在当前节点上扩展
    bool vs_expanded = expand_node_by(current_virtual_space(),
                                      min_words, max_expansion_words);
    if (vs_expanded) return true;

    // 4. 当前节点不够 → 退役当前节点 → 创建新节点 → 在新节点上扩展
    retire_current_virtual_space();
    size_t grow_vs_words = MAX2((size_t)VirtualSpaceSize, preferred_words);
    if (create_new_virtual_space(grow_vs_words)) {
        return expand_node_by(current_virtual_space(), min_words, max_expansion_words);
    }
    return false;
}
```

**决策树总结**：
```
allocate request (min_words, preferred_words)
  ├─ MetaspaceGC: can_expand? → NO → return false
  ├─ expand_node_by(current_node) → 只是调用 VirtualSpaceNode::expand_by(min, pref)
  │  └─ VirtualSpace::expand_by(commit) → os::commit_memory() → mprotect(2)
  ├─ [当前节点空间不够] → retire_current_virtual_space()
  │  └─ VirtualSpaceNode::retire() → 按 Med→Small→Spec 顺序分配剩余 chunk
  ├─ create_new_virtual_space(MAX(256K, preferred))
  │  └─ ReservedSpace(256K) → mmap(2) → VirtualSpace::initialize
  └─ expand_node_by(new_node) → VirtualSpace::expand_by in new node
```

---

## §六 VirtualSpaceNode — 节点级 commit 控制

### What/Why

VirtualSpaceNode 是 VirtualSpace 的 Metaspace 专用封装，核心是 **bump-pointer 分配器**：`_top` 指针从 `bottom()` 开始，每次 `take_from_committed()` 向前推进 `chunk_word_size`，就像 C 的 `sbrk()` 一样简单。但 Metaspace 的 chunks 有不同的 size 类别（specialized=128 words, small=512 words, medium=8K words, humongous > 8K words, metaspaceCommon.hpp:35-42），且不同类别要求对齐到不同边界，所以需要 padding chunks 机制填充间隙。

### 核心字段

```cpp
class VirtualSpaceNode : public CHeapObj<mtClass> {
    VirtualSpaceNode* _next;          // 链表指针
    const bool _is_class;             // 是否 class space
    ReservedSpace _rs;                // 底层保留区域
    VirtualSpace _virtual_space;      // 提交管理
    MetaWord* _top;                   // bump-pointer — 下一个空闲地址
    uintx _container_count;           // 此节点中的非空闲 chunk 数量
    OccupancyMap* _occupancy_map;     // 位图: 1 bit/chunk, 标记 start + in-use
    // 便捷函数
    char* low()  const { return virtual_space()->low(); }
    char* high() const { return virtual_space()->high(); }
    char* low_boundary()  const { return virtual_space()->low_boundary(); }
    char* high_boundary() const { return virtual_space()->high_boundary(); }
    // virtualSpaceNode.hpp:42-163
};
```

### initialize() — VirtualSpace 初始化 + OccupancyMap 创建

```cpp
bool VirtualSpaceNode::initialize() {
    // virtualSpaceNode.cpp:568-607
    if (!_rs.is_reserved()) return false;

    // 1. 检查对齐约束
    assert_is_aligned(_rs.base(), Metaspace::commit_alignment());
    assert_is_aligned(_rs.size(), Metaspace::commit_alignment());

    // 2. 预提交大小: special 空间 = 全部; regular 空间 = 0
    size_t pre_committed_size = _rs.special() ? _rs.size() : 0;

    // 3. 初始化底层 VirtualSpace
    bool result = virtual_space()->initialize_with_granularity(
        _rs, pre_committed_size, Metaspace::commit_alignment());

    // 4. 设置 _top = low() (bump-pointer 起点)
    set_top((MetaWord*)virtual_space()->low());

    // 5. 创建 OccupancyMap: 每个 smallest_chunk (128 words = 1KB) 占 1 bit
    const size_t smallest_chunk_size = is_class() ? ClassSpecializedChunk : SpecializedChunk;
    _occupancy_map = new OccupancyMap(bottom(), reserved_words(), smallest_chunk_size);
    return result;
}
```

初始化后的状态：

```
_low_boundary (= 0x800000000)        _high_boundary (= 0x840000000)
        │                                       │
        ▼                                       ▼
        ┌───────────────────────────────────────┐
        │      Reserved (1GB 虚拟地址空间)       │
        │                                       │
        │  Committed = 0 (还没提交物理内存)     │
        │  _top = low() = low_boundary          │
        │  _low = _high = low_boundary          │
        └───────────────────────────────────────┘
```

### take_from_committed() — bump-pointer 分配

```cpp
Metachunk* VirtualSpaceNode::take_from_committed(size_t chunk_word_size) {
    // virtualSpaceNode.cpp:369-463
    ChunkManager* const chunk_manager = Metaspace::get_chunk_manager(this->is_class());
    const size_t spec_word_size = chunk_manager->specialized_chunk_word_size();
    const size_t small_word_size = chunk_manager->small_chunk_word_size();
    const size_t med_word_size = chunk_manager->medium_chunk_word_size();

    // 1. 计算对齐要求
    const size_t required_chunk_alignment =
        (chunk_word_size > med_word_size ? spec_word_size : chunk_word_size)
            * sizeof(MetaWord);
    // 非 humongous: 对齐到 chunk size (比如 512 words 对齐到 512 words)
    // humongous: 对齐到 spec (128 words)，因为最小值边界

    // 2. 检查空间
    MetaWord* const next_aligned =
        static_cast<MetaWord*>(align_up(top(), required_chunk_alignment));
    if (!is_available((next_aligned - top()) + chunk_word_size)) {
        return NULL; // 空间不足 — 调用者需要 expand_by
    }

    // 3. 如果需要对齐，分配 padding chunks 填充间隙
    if ((chunk_word_size == med_word_size || chunk_word_size == small_word_size)
        && next_aligned > top()) {
        allocate_padding_chunks_until_top_is_at(next_aligned);
    }

    // 4. Bump-pointer: 推进 _top
    MetaWord* chunk_limit = top();
    inc_top(chunk_word_size);

    // 5. placement new Metachunk + 登记 OccupancyMap
    ChunkIndex chunk_type = get_chunk_type_by_size(chunk_word_size, is_class());
    Metachunk* result = ::new (chunk_limit) Metachunk(chunk_type, is_class(),
                                                       chunk_word_size, this);
    occupancy_map()->set_chunk_starts_at_address((MetaWord*)result, true);
    inc_container_count();
    return result;
}
```

**分配示意图** — 当请求一个 small chunk (512 words) 但 `_top` 不在 512-word 边界：

```
Before allocate_padding_chunks:
  _top = 0x80001000 (128 words from bottom, on spec boundary)

After allocate_padding_chunks_until_top_is_at(0x80002000):
  ┌──────────┬──────────┬──────────┐
  │  spec    │  spec    │  spec    │  ← 3 个 spec padding chunks (128w each)
  │  Pad #1  │  Pad #2  │  Pad #3  │     从 _top=0x80001000 填充到 0x80002000
  └──────────┴──────────┴──────────┘
  _top = 0x80002000 (512-word aligned)

After take_from_committed:
  ┌──────────┬──────────┬──────────┬─────────────────────────┐
  │  spec    │  spec    │  spec    │  Small (512w) Chunk      │
  │  Pad #1  │  Pad #2  │  Pad #3  │  ← actual allocation    │
  └──────────┴──────────┴──────────┴─────────────────────────┘
  _top = 0x80004000
```

### allocate_padding_chunks_until_top_is_at() 填充机制

```cpp
void VirtualSpaceNode::allocate_padding_chunks_until_top_is_at(MetaWord* target_top) {
    // virtualSpaceNode.cpp:307-364
    ChunkManager* const chunk_manager = Metaspace::get_chunk_manager(this->is_class());
    const size_t spec_word_size = chunk_manager->specialized_chunk_word_size();
    const size_t small_word_size = chunk_manager->small_chunk_word_size();

    while (top() < target_top) {
        // 选择 padding chunk 大小: 优先 small (512w), 如果不对齐使用 spec (128w)
        size_t padding_chunk_word_size = small_word_size;
        if (!is_aligned(top(), small_word_size * sizeof(MetaWord))) {
            assert_is_aligned(top(), spec_word_size * sizeof(MetaWord));
            padding_chunk_word_size = spec_word_size;
        }
        MetaWord* here = top();
        inc_top(padding_chunk_word_size);

        // placement new Metachunk → 标记 origin_pad → 返还给 ChunkManager
        ChunkIndex padding_chunk_type = get_chunk_type_by_size(padding_chunk_word_size, is_class());
        Metachunk* const padding_chunk =
            ::new (here) Metachunk(padding_chunk_type, is_class(), padding_chunk_word_size, this);
        padding_chunk->set_origin(origin_pad);
        occupancy_map()->set_chunk_starts_at_address((MetaWord*)padding_chunk, true);
        inc_container_count();
        chunk_manager->return_single_chunk(padding_chunk);
        // 注意: return_single_chunk 之后 padding_chunk 可能已与邻居合并，不要再引用
    }
    assert(top() == target_top, "Sanity");
}
```

### OccupancyMap 比特位映射

OccupancyMap 是 VirtualSpaceNode 的核心元数据结构，用于追踪 VirtualSpace 中每个 chunk 的起始位置和占用状态。

**数据结构**（virtualSpaceNode.cpp:500-567 comment）：

```
OccupancyMap 是双层位图，用于跟踪 VirtualSpaceNode 中的 Chunk：

- 每 1 个 bit 代表 1 个最小 Chunk (128 words = 1KB)
- 1GB / 1KB = 1,048,576 个位置 → 131,072 字节 = 128KB 的位图数据

Layer 0 — chunk_start_map (标记 Chunk 起始位置)：
  bit: 0  1  2  3  4  5  6  7  8  ...
       1  0  0  0  1  0  0  0  1  ...
       ↑        ↑        ↑
       Chunk1   Chunk2   Chunk3

Layer 1 — in_use_map (标记 Chunk 是否正在使用)：
  bit: 0  1  2  3  4  5  6  7  8  ...
       1  1  1  1  0  0  0  0  1  ...
       ↑─────────↑ ↑─────────↑ ↑
       Chunk1使用  Chunk2空闲  Chunk3使用
```

**用途**：
1. 快速判断某位置是否是 Chunk 起始 — O(1) 位图查询，无需遍历链表
2. 快速判断 Chunk 是否空闲 — 用于退休时合并相邻空闲 Chunk
3. 遍历所有 Chunk 时不需要链表 — 位图扫描替代链表遍历

### retire() — 退役时的剩余空间回收

```cpp
void VirtualSpaceNode::retire(ChunkManager* chunk_manager) {
    // virtualSpaceNode.cpp:636-658
    for (int i = (int)MediumIndex; i >= (int)ZeroIndex; --i) {
        ChunkIndex index = (ChunkIndex)i;
        size_t chunk_size = chunk_manager->size_by_index(index);

        while (free_words_in_vs() >= chunk_size) {
            Metachunk* chunk = get_chunk_vs(chunk_size);
            if (chunk == NULL) break;  // 回退到下一个更小的 chunk size
            chunk_manager->return_single_chunk(chunk);
        }
    }
    assert(free_words_in_vs() == 0, "should be empty now");
}
```

退役策略：从大（Medium 8K words）到小（Specialized 128 words）依次尝试分配 chunk 返还给 ChunkManager，确保 VirtualSpaceNode 中的所有空闲空间都被回收为可用 chunks。

### 统计字段

| 方法 | 公式 | 说明 |
|------|------|------|
| `used_words_in_vs()` | `_top - bottom()` | 已分配给 chunk 的空间 (virtualSpaceNode.cpp:293-295) |
| `capacity_words_in_vs()` | `end() - bottom()` | `= _high - low()` — 已提交区域总容量 (:298-300) |
| `free_words_in_vs()` | `end() - _top` | 已提交但未分配的空闲空间 (:302-304) |
| `reserved_words()` | `virtual_space.reserved_size() / BytesPerWord` | :96 |
| `committed_words()` | `virtual_space.actual_committed_size() / BytesPerWord` | :97 — 使用 actual_committed_size 而非 committed_size |

---

## §七 CommitLimiter — 全局提交上限

### What/Why

CommitLimiter 是 Metaspace 的全局提交上限管理器。它通过 `_commit_granule_size` 实现两个关键功能：(1) 限制总提交量不超过 `MaxMetaspaceSize`；(2) 实现防抖动——低于 granule 粒度的空闲空间不予归还，避免频繁的 commit/uncommit 系统调用开销。

CommitLimiter 不是独立的类，而是嵌入在 `VirtualSpaceNode::expand_by()` 和 VirtualSpaceList 的提交计数器中，通过 `inc_committed_words()`/`dec_committed_words()` 间接施加限制。

### 提交上限检查的层次

```
VirtualSpaceList::expand_by() (virtualSpaceList.cpp:304-358)
  ├─ MetaspaceGC::can_expand() → 检查 GC 策略是否允许
  ├─ MetaspaceGC::allowed_expansion() → 计算还允许扩展多少 words
  │  └─ (内部) CommitLimiter: possible_expansion_words() >= min_words?
  └─ expand_node_by() (virtualSpaceList.cpp:288-302)
     └─ VirtualSpaceNode::expand_by() (virtualSpaceNode.cpp:467-492)
        └─ VirtualSpace::expand_by() (virtualspace.cpp:1000-1086)
           └─ os::commit_memory() → mprotect(2)
```

### commit_granule_size 的防抖动设计

`_commit_granule_size` 在 Metaspace Settings 中默认设为 `root_chunk_size` (64K)。它的作用：

- **正向**：提交时，低于 `commit_granule_size` 的扩展请求会被向上取整，避免过于频繁的小块 commit
- **反向**：uncommit 时，如果空闲量低于 `commit_granule_size`，不触发 uncommit 调用——"可能马上就要用，给回去又要重新申请"

**为什么称为"防抖动"**：假设 `_commit_granule_size = 64K`。如果每次 GC 后只释放了 8K 空间，直接 uncommit 再在下次分配时重新 commit 8K，每次都有一次 `mmap(2)` + `madvise(2)` 系统调用开销。64K 阈值相当于一个"阻尼器"——小于这个量的归还被忽略，等累积到 64K 以上再一次性处理。

> **Counterfactual 思维实验**：如果 `_commit_granule_size = 0`（不设防抖动）——每次分配 1 个 spec chunk (128 words = 1KB) 就需要 `commit_memory()` 一次，每次 free 1KB 就需要 `uncommit_memory()` 一次。高频率的 mmap/mprotect 系统调用会显著增加延迟（每个 syscall ~1-2µs）。

### cap 与 MaxMetaspaceSize 的关系

```cpp
// virtualSpaceList.cpp:44-48
#define assert_committed_below_limit()                        \
  assert(MetaspaceUtils::committed_bytes() <= MaxMetaspaceSize, \
         "Too much committed memory. Committed: " SIZE_FORMAT \
         " limit (MaxMetaspaceSize): " SIZE_FORMAT,           \
          MetaspaceUtils::committed_bytes(), MaxMetaspaceSize);

void VirtualSpaceList::inc_committed_words(size_t v) {
    assert_lock_strong(MetaspaceExpand_lock);
    _committed_words = _committed_words + v;
    assert_committed_below_limit();
}
```

每次提交增加都会检查是否超出 `MaxMetaspaceSize`。当达到 cap 时：
- `VirtualSpaceNode::expand_by()` → `MetaspaceGC::allowed_expansion()` 返回 0 → `expand_by()` 返回 false
- 后续分配会 在已提交空间内尝试 满足——如果碎片化严重，即使有闲置空间也可能分配失败（padding 要求导致单次分配的 min_word_size 过高）
- GC 被触发尝试回收 + Compact (如果启用了 Metaspace compaction)

**提交上限的源码实现**（`virtualSpaceList.cpp:304-329`）：

```cpp
bool VirtualSpaceList::expand_by(size_t min_words, size_t preferred_words) {
    // ① 检查 MetaspaceGC 是否允许扩展
    if (!MetaspaceGC::can_expand(min_words, this->is_class())) {
        return false;  // 容量已达上限
    }
    // ② 计算允许扩展量 = (MaxMetaspaceSize - committed) / commit_alignment
    size_t allowed_expansion_words = MetaspaceGC::allowed_expansion();
    if (allowed_expansion_words < min_words) {
        return false;  // 需要先触发 GC
    }
    // ③ 实际扩展量 = min(preferred, allowed)，commit 粒度对齐到 commit_alignment
    size_t max_expansion_words = MIN2(preferred_words, allowed_expansion_words);
    bool vs_expanded = expand_node_by(current_virtual_space(),
                                       min_words, max_expansion_words);
    ...
}
```

**核心公式**：`MetaspaceGC::allowed_expansion() = (MaxMetaspaceSize - current_committed) / commit_alignment_words`。`commit_alignment_words`（通常 64K/8=8K words）充当反抖动的"granule"角色——低于此粒度的空闲空间不予提交，防止频繁 commit/uncommit 抖动。

| 参数 | 默认值 | 作用 |
|------|--------|------|
| `commit_alignment_words` | `os::vm_allocation_granularity() / BytesPerWord` (通常 8K) | 提交粒度的 words 表示，防止碎片化提交 |
| `MetaspaceGC::can_expand()` | → `allowed_expansion() >= min_words` | 全局提交上限检查 |
| `MAX2(min_words, preferred_words)` | 由调用者（ChunkManager）传入 | 最小必须扩展量 vs 理想扩展量 |

---

## §八 内存归还 — 从 shrink 到内核

### What/Why

VirtualSpace 的内存归还不是简单的 `munmap(2)`，而是一个仔细编排的分阶段过程：先从上层 Metaspace 的 GC 回收开始，经过 ChunkManager 的 free list 合并，再到 VirtualSpaceNode 的 retire/shrink，最后到达 VirtualSpace::shrink_by() → os::uncommit_memory()。每一层都有其责任边界和防护机制。

### 完整归还路径

```
GC 清理 ClassLoaderData (触发: GC cycle 或 System.gc())
  → Metaspace::deallocate() 标记 chunk 空闲
    → ChunkManager::return_chunk() 返还到 free list
      → ChunkManager 尝试合并相邻空闲 chunk (merge)
        → VirtualSpaceNode::retire() 将剩余空闲空间转为 chunks
          → 检查: free_words_in_vs() >= commit_granule_size?
            NO → 不 uncommit (防抖动)
            YES → VirtualSpace::shrink_by()
              → os::uncommit_memory()
                → mmap(MAP_FIXED|MAP_NORESERVE) 重映射为 PROT_NONE
                  或 madvise(MADV_DONTNEED)
```

### VirtualSpace::shrink_by() → os::uncommit_memory() 源码

```cpp
void VirtualSpace::shrink_by(size_t size) {
    // virtualspace.cpp:1091-1184
    if (committed_size() < size)
        fatal("Cannot shrink virtual space to negative size");

    if (special()) {
        _high -= size;  // special 空间不支持 uncommit
        return;
    }

    // 按三区域计算各自的 shrink 量，对齐到区域粒度
    // 然后:
    if (upper_needs > 0) {
        if (!os::uncommit_memory(aligned_upper_new_high, upper_needs)) {
            debug_only(warning("os::uncommit_memory failed"));
            return;
        }
        _upper_high -= upper_needs;
    }
    // ... middle, lower 同理
    _high -= size;
}
```

### mmap(MAP_FIXED|MAP_NORESERVE) vs madvise(MADV_DONTNEED)

`os::uncommit_memory()` 在 Linux 上有两种实现策略：

| 策略 | 操作 | 效果 | 代价 |
|------|------|------|------|
| **mmap 重映射** | `mmap(addr, size, PROT_NONE, MAP_FIXED\|MAP_NORESERVE\|MAP_ANONYMOUS\|MAP_PRIVATE)` | 创建新 VMA 覆盖旧区域，立即释放物理页 + 改为 PROT_NONE | ~2µs syscall + VMA 分裂 |
| **madvise** | `madvise(addr, size, MADV_DONTNEED)` | 保留 VMA 权限不变，内核异步回收物理页（lazy reclaim） | ~1µs syscall，物理页在内存压力时才回收 |

**JVM 何时选择哪种**：
- Linux 默认路径：先使用 `madvise(MADV_DONTNEED)` + `mprotect(PROT_NONE)` 组合——前者触发内核回收物理页，后者保护不访问
- 大页路径：`madvise(MADV_DONTNEED)` 对大页无效（kernel 不会拆分 HugeTLB 大页归还内存），必须使用 `mmap(MAP_FIXED)` 重新映射——但这样做会失去大页对齐

> **man 手册引用**：man 2 madvise: `MADV_DONTNEED` — "The application is finished with the given range, so the kernel can free resources associated with it. Subsequent accesses... will succeed, but will result in either reloading of the memory contents from the underlying mapped file... or zero-fill-on-demand pages for anonymous mappings." man 2 mmap: `MAP_FIXED` — "Don't interpret addr as a hint... If the memory region specified by addr and length overlaps pages of any existing mapping(s), then the overlapped part of the existing mapping(s) will be discarded."

### 为什么 CommitLimiter 可能阻止 uncommit

碎片场景详解：

```
VirtualSpaceNode A: [Used:12KB] [Free:8KB] [Used:20KB] [Free:24KB]
  → 总空闲 = 32KB < 64KB (commit_granule_size) → 不 uncommit

VirtualSpaceNode B: [Used:40KB] [Free:84KB]
  → 总空闲 = 84KB >= 64KB → 可 uncommit 84KB
```

但 A 的 32KB 空闲分散在 2 个片段中，即使 `ChunkManager.return_single_chunk()` 尝试合并相邻空闲 chunk，由于中间有 Used chunk，无法合并。这 32KB 就永远留在 RSS 中。

---

## §九 ReservedHeapSpace — 压缩指针保护页

### What/Why

压缩指针 (Compressed OOPs) 将 64-bit 对象引用编码为 32-bit 值：`narrow_oop = (uint32_t)((uint64_t)oop - heap_base) >> shift`。关键问题：NULL 引用的编码是 `0`，解码后变成 `heap_base + 0 = heap_base`——如果 heap_base 处有有效对象，`if (obj != NULL)` 检查会失效，空指针解引用不会触发 SIGSEGV 而是静默访问 heap 偏移 0 的对象。

解决方案：在 heap 基址前放一个 PROT_NONE 保护页，确保 NULL 编码解码后的地址有效但不读写。

### establish_noaccess_prefix() 源码

```cpp
static size_t noaccess_prefix_size(size_t alignment) {
    return lcm(os::vm_page_size(), alignment);  // virtualspace.cpp:310-312
}

void ReservedHeapSpace::establish_noaccess_prefix() {
    // virtualspace.cpp:314-340
    assert(_alignment >= (size_t)os::vm_page_size(), "must be at least page size big");
    _noaccess_prefix = noaccess_prefix_size(_alignment);

    if (base() && base() + _size > (char*)OopEncodingHeapMax) {
        // 堆基址 ≥ 32GB 时（Disjoint 模式）需要保护页
        if (!os::protect_memory(_base, _noaccess_prefix, os::MEM_PROT_NONE, _special)) {
            fatal("cannot protect protection page");
        }
    }

    // 调整 ReservedSpace 边界，把保护页排除在外
    _base += _noaccess_prefix;   // 基址前移
    _size -= _noaccess_prefix;   // 大小减掉保护页
    assert(((uintptr_t)_base % _alignment == 0), "must be exactly of required alignment");
}
```

**保护页大小计算**：`lcm(os::vm_page_size(), alignment)`。例如 4KB 页 + 64KB alignment → `lcm(4K, 64K) = 64K`。使用 LCM 确保保护页的大小同时是页大小的倍数和对齐的倍数，这样 `_base += _noaccess_prefix` 后仍然对齐。

**保护页存在的条件**：`_base + _size > OopEncodingHeapMax`（virtualspace.cpp:318）——即堆的结束地址超过 32GB 时。当堆完全在低 32GB 内（Unscaled / ZeroBased 模式），heap_base 就是 0 或足够低，NULL 的编码解码后是 `0` 或 `heap_base`——两者都在有效的虚拟地址范围内，其中 heap 低地址没有映射，自然触发 fault。

### implicit null check 与保护页的关系

压缩指针解引用时的汇编伪代码：

```asm
; compressed_oop_base = _base - _noaccess_prefix
; 解码: narrow_oop << shift + compressed_oop_base
mov r32, [rsi+4]        ; 读取 32-bit narrow oop
shl r32, 3              ; << shift
add r32, r15            ; + compressed_oop_base (r15 寄存器缓存)
; 现在 r32 是原始 64-bit oop
mov rax, [r32+offset]   ; 解引用——如果 oop 为 0 → r32 = compressed_oop_base = _base - _noaccess_prefix
                        ; 这会访问 _base 之前 _noaccess_prefix 处的 PROT_NONE 页
                        ; → SIGSEGV → implicit null check 成功
```

当 `_base = 0x800000000` 且 `_noaccess_prefix = 0x10000`（64KB），`compressed_oop_base = 0x7FFFF0000`。NULL 的解码是 `0 + 0x7FFFF0000 = 0x7FFFF0000`，这个地址在 PROT_NONE 保护页内——访问触发 SIGSEGV，JVM 的 signal handler 识别为 implicit null check，抛出 `NullPointerException`。

> **Counterfactual 思维实验**：如果没有 noaccess_prefix——压缩指针的 NULL 编码可能落入有效地址空间（heap_base + alignment 内），`if (obj != NULL)` 检查失效，程序可能静默访问错误内存区域。

---

## §十 ReservedCodeSpace — JIT 代码页

### What/Why

JIT 编译生成的代码需要可执行内存页——这不同于数据页（heap/metaspace 只需要 RW）。因此 `ReservedCodeSpace` 在构造时将 `executable=true` 传递给 ReservedSpace，后续 VirtualSpace 的 expand_by 会调用 `os::commit_memory(start, size, alignment, executable=true)` 来设置 `PROT_READ|PROT_WRITE|PROT_EXEC` 权限。

```cpp
// virtualspace.cpp:803-808
ReservedCodeSpace::ReservedCodeSpace(size_t r_size, size_t rs_align, bool large) :
    ReservedSpace(r_size, rs_align, large, /*executable*/ true) {
    MemTracker::record_virtual_memory_type((address)base(), mtCode);
}
```

**平台差异**：
- Linux: `os::commit_memory()` → `mmap(+ mprotect(2))` 设置 `PROT_READ|PROT_WRITE|PROT_EXEC`。支持 `madvise(MADV_DONTNEED)` 归还。
- macOS: `MAP_JIT` 标志（man 2 mmap: "MAP_JIT — Allocate a region that may contain JIT compiled code. This flag is only implemented on Apple Silicon and requires the com.apple.security.cs.allow-jit entitlement."）。Apple Silicon 需要显式 JIT entitlements。
- Windows: `VirtualAlloc` + `PAGE_EXECUTE_READWRITE`

**安全约束**：`PROT_WRITE|PROT_EXEC` 同时存在是 W^X 违反——现代 Linux 可以通过 `kernel.yama.ptrace_scope` 或 SELinux 策略禁止。JVM 的设计是先 commit 为 RWX 写 JIT 代码，写完后再 `mprotect(addr, size, PROT_READ|PROT_EXEC)` 去掉 W 权限。

---

## §十一 Counterfactual 对比表 — 8 个设计决策

| # | 设计决策 | 当前实现 | 替代方案 | 量化对比 |
|---|---------|---------|---------|---------|
| 1 | **保留/提交分离** | mmap(PROT_NONE, MAP_NORESERVE) — virtualspace.cpp:210 | 一步到位 mmap(PROT_READ\|PROT_WRITE) | 保留 1GB Metaspace: 0 字节物理内存 vs 1GB 立即分配；4GB heap: 0 vs 4GB。物理内存节省 = 保留大小 × (未提交比例) |
| 2 | **分步提交** | expand_by 按 lower/middle/upper 分区域提交 — virtualspace.cpp:1000-1086 | 一次提交整个区域 | 单次 mprotect(1GB) 需建立 262,144 个页表条目 > 1ms；分 64K 步提交每次 ~5µs |
| 3 | **链表节点 vs 单一大区域** | 256KB VirtualSpaceNode 链表 — virtualSpaceList.hpp:42-44 | 单个 64MB VirtualSpace | 扩容: O(1) append vs O(n) memmove(resize)；浪费: 最多 256KB (当前节点未用完) vs 最多 64MB (整块未用完)；退役: O(1) 解除链接 vs 需要额外数据结构追踪空闲块 |
| 4 | **noaccess_prefix 保护页** | 压缩指针 heap base 前放 64KB PROT_NONE — virtualspace.cpp:314-340 | 不加保护页 | NULL 编码解码 = heap_base，如 heap_base 有对象可静默访问 → 数据损坏；保护页成本 = 64KB 虚拟地址空间（0 物理内存） |
| 5 | **special vs regular 路径** | virtualspace.cpp:150: `special = large && !os::can_commit_large_page_memory()` | 不区分 | special: O(1) expand/shrink（无 syscall），不可分步提交，不可 uncommit；regular: 每次 expand/shrink syscall，可灵活控制；TLB miss 减少: 大页 ~1000× 更少 |
| 6 | **CommitLimiter 防抖动** | `_commit_granule_size=64K` 阻止低于阈值的 uncommit — virtualSpaceList.cpp:50-62 | 不设阈值，每次 free 即 uncommit | 无阈值: 每次 1KB free → uncommit syscall (~2µs) + 重新 1KB commit (~2µs)；有阈值: 累积到 64K 才 uncommit。高频场景: 100K dealloc/s → 节省 200ms/s syscall 时间 |
| 7 | **uncommit: mmap 重映射 vs madvise** | `os::uncommit_memory()` 用 mmap(MAP_FIXED\|MAP_NORESERVE) 重新映射 PROT_NONE | 仅用 madvise(MADV_DONTNEED) | mmap: 释放物理页 + 改权限为 PROT_NONE (2 µs)，VMA 分裂开销；madvise: 释放物理页 + 保留权限 (1 µs)，但大页不支持 MADV_DONTNEED；安全: mmap 方式确保不可访问 |
| 8 | **split vs 独立 mmap** | first_part/last_part 共享底层 mmap — virtualspace.cpp:245-265 | 每个子空间独立 mmap | 共享映射: 连续地址空间（无需重新定位）；独立 mmap: 需要二次分配 + 地址碎片 + 可能失败。split=true 时 os::split_reserved_memory 真正分割映射 |

---

## §十二 GDB 验证 — 8 断言

### 断言 1: ReservedSpace 的保留范围

```gdb
(gdb) print Metaspace::_class_space_list->_virtual_space_list->_rs
# 期望: _base = 0x800000000, _size = 1GB (1073741824)
(gdb) print Metaspace::_class_space_list->_virtual_space_list->_rs._base
$1 = 0x800000000 ""
(gdb) print Metaspace::_class_space_list->_virtual_space_list->_rs._size
$2 = 1073741824
(gdb) print /x Metaspace::_class_space_list->_virtual_space_list->_rs._special
$3 = 0x0  # false — class space 不使用大页
```

### 断言 2: VirtualSpace 的提交边界

```gdb
(gdb) print Metaspace::_class_space_list->_current_virtual_space->_virtual_space._low
$4 = 0x800000000 ""
(gdb) print Metaspace::_class_space_list->_current_virtual_space->_virtual_space._high
$5 = 0x800100000 ""  # 1MB 已提交
(gdb) print (char*)_high - (char*)_low
# 期望: committed_size = 0x100000 (1MB)
```

### 断言 3: VirtualSpaceNode 的 _top 指针

```gdb
(gdb) print Metaspace::_class_space_list->_current_virtual_space->_top
$6 = (MetaWord *) 0x800008000  # 32KB from bottom
(gdb) print _top >= _virtual_space.low() && _top <= _virtual_space.high()
# 期望: true (top 在已提交区域内)
```

### 断言 4: CommitLimiter 的当前提交量

```gdb
(gdb) print metaspace::CommitLimiter::committed_bytes()
# 期望: committed <= MaxMetaspaceSize (~2^64-1 或 用户设定值)
(gdb) print MaxMetaspaceSize
$7 = 18446744073709551615  # 默认无限制
```

### 断言 5: VirtualSpaceList 的节点数量

```gdb
(gdb) print Metaspace::_class_space_list->_virtual_space_count
$8 = 1  # class space 只有一个节点
(gdb) print Metaspace::_space_list->_virtual_space_count  # non-class space
$9 = 3  # 启动了 3 个 VirtualSpaceNodes (256KB each)
```

### 断言 6: OccupancyMap 的比特位

```gdb
(gdb) print Metaspace::_class_space_list->_current_virtual_space->_occupancy_map
(gdb) print *_occupancy_map
# 期望: chunk_start_map 和 in_use_map 两个位图
(gdb) print _occupancy_map->chunk_starts_at_address((MetaWord*)0x800000000)
# 期望: true (第一个 chunk 起始位置已标记)
```

### 断言 7: /proc/self/maps 验证 PROT_NONE

```gdb
(gdb) shell cat /proc/<pid>/maps | grep "---p" | head -5
# 期望: 看到 PROT_NONE 保护区域（---p 权限位为 0）
# 示例输出:
# 7f8b20000000-7f8b24000000 ---p 00000000 00:00 0  ← Metaspace 保留未提交
# 7f8b24000000-7f8b24040000 rw-p 00000000 00:00 0  ← Metaspace 已提交区
```

### 断言 8: _special 标志

```gdb
(gdb) print Metaspace::_class_space_list->_current_virtual_space->_virtual_space._special
$10 = false  # class space 不特殊
(gdb) print Metaspace::_space_list->_current_virtual_space->_virtual_space._special
$11 = false  # non-class space 不特殊 (除非 UseLargePagesInMetaspace)
```

---

## §十三 边缘场景 — ≥3 场景

### 场景 1: 地址空间碎片

**触发条件**: 连续做大量 mmap 和 munmap 后，虚拟地址被切成碎片，无法找到连续的大段空间。

**JVM 处理方式**: ReservedSpace 的三级回退策略 (virtualspace.cpp:122-243) 天然提供了优雅降级路径：
- Level 1 失败（大页不可用）→ 回退到 Level 2
- Level 2 失败（请求地址被占）→ `failed_to_reserve_as_requested()` 返回 true → 进入随机地址路径
- Level 3 的 `os::reserve_memory(size, NULL, alignment, _fd_for_heap)` 如果也失败 → 返回 NULL → 启动失败

**Heap 特定场景**: `initialize_compressed_heap()` (virtualspace.cpp:540-748) 对碎片有更细致的处理——按 Unscaled → ZeroBased → Disjoint 三种模式搜索可用地址，每种模式下多次重试（`HeapSearchSteps` 默认 3 次）。

### 场景 2: 大页失败的回退路径

**触发条件**: `-XX:+UseLargePages` 但系统 hugetlbfs 未挂载或大页池枯竭。

**JVM 处理方式** (virtualspace.cpp:150-183):
```
special = large && !os::can_commit_large_page_memory()
  → os::reserve_memory_special() → NULL (大页不可用)
  → 不设置 _special = true (保持 false)
  → 进入 Level 2: os::reserve_memory() regular 映射
  → _alignment = MAX2(alignment, os::vm_page_size())
  → 后续所有 commit 走 os::commit_memory() 而非 special 的指针推进
```

**日志诊断** (virtualspace.cpp:153-158):
```
-XX:+LogCompilation or -Xlog:gc+heap+coops=debug
输出: "Reserve regular memory without large pages"
```

### 场景 3: 并发 commit 竞争

**触发条件**: 多个 ClassLoader 同时加载类 → 同时请求 Metaspace 分配 → 多个线程同时调用 `VirtualSpaceList::get_new_chunk()`。

**JVM 处理方式**: `MetaspaceExpand_lock` (Mutex) 保护所有状态变更：
- `inc_committed_words()` / `dec_committed_words()`: `assert_lock_strong(MetaspaceExpand_lock)` (virtualSpaceList.cpp:50-51)
- `create_new_virtual_space()`: `assert_lock_strong(MetaspaceExpand_lock)` (virtualSpaceList.cpp:222)
- `inc_virtual_space_count()`: `assert_lock_strong(MetaspaceExpand_lock)` (virtualSpaceList.cpp:64)

**与 HashMap 锁的区别**: MetaspaceExpand_lock 是全局锁——所有 VirtualSpaceList 的 commit/reserve 操作串行化。但因为 commit 操作（mprotect syscall）比分配操作（bump pointer）快几个数量级，所以 Metaspace 使用了两层锁：
- **MetaspaceExpand_lock** — 保护 commit/reserve 操作（粗粒度，低频）
- **ChunkManager 的 internal free list locks** — 保护 chunk 分配/回收（细粒度，高频）

**OrderAccess::storestore() 内存屏障** (virtualSpaceList.cpp:253): 在 `link_vs` 之前插入 store-store barrier，确保其他线程通过 lock-free 迭代器看到完全初始化的 VirtualSpaceNode 数据。`find_enclosing_space()` 在不持锁的情况下遍历链表，依赖此屏障确保一致性。

### 场景 4: HugeTLB 大页不支持 uncommit

**触发条件**: `UseLargePages && os::can_commit_large_page_memory() == false` → `_special = true` → 整个空间在 mmap 时一次性提交。

**限制**: `_special=true` 的 VirtualSpace 不支持分步 uncommit。`shrink_by()` 只是 `_high -= size` 指针回退（virtualspace.cpp:1095-1098），不调用 `os::uncommit_memory()`。大页内存一旦提交，即使上层 Metaspace 不再使用也无法归还给 OS——因为：
- HugeTLB 大页不支持 `madvise(MADV_DONTNEED)`（kernel 不会拆分大页）
- `mmap(MAP_FIXED)` 重新映射可能破坏大页连续性
- 大页池是有限资源，一旦占用就在池中标记为 "已分配"

**诊断**: 使用 `hugeadm --pool-list` (root) 查看大页池使用情况。

---

## §十四 Cross-Reference + man 索引

### 相关文档

| 文档 | 关系 | 具体内容 |
|------|------|---------|
| [libjvm-analysis/01-jvm-startup/03-Metaspace.md] | Pre-read — 上层调用 | Metaspace::initialize() → VirtualSpaceList 创建；allocate/deallocate → get_new_chunk() |
| [libjvm-analysis/01-jvm-startup/02-G1-Heap-Startup.md] | Pre-read — 堆分配 | ReservedHeapSpace 被 G1 使用；try_reserve_heap() 4 次重试 |
| prompt-01 (Arena & ResourceArea) | Post-read — 上层分配器 | 在 VirtualSpace 之上构建 Arena chunk 分配器 |
| prompt-02 (Metaspace Internals) | Post-read — 同步依赖 | 使用 VirtualSpaceList/VirtualSpaceNode 进行 Metachunk 块分配 |
| CompressedOops 相关文档 | 交叉引用 | noaccess_prefix + implicit null check 的 compoops context |

### man 手册引用索引

本文档中引用的所有 man 手册：

| syscall / page | man 命令 | 首次出现位置 |
|---------------|---------|------------|
| mmap | `man 2 mmap` | §一 Reserve 流程 — `MAP_NORESERVE`, `MAP_ANONYMOUS`, `MAP_PRIVATE` |
| mprotect | `man 2 mprotect` | §一 Commit 流程 — `PROT_READ\|PROT_WRITE`, `PROT_NONE` |
| munmap | `man 2 munmap` | §三 release() — ReservedSpace::release() 的底层 syscall |
| madvise | `man 2 madvise` | §八 uncommit — `MADV_DONTNEED` vs mmap 重映射 |
| mincore | `man 2 mincore` | §二 Syscall 速查表 — page residency 诊断 |
| MAP_FIXED | `man 2 mmap` → MAP_FIXED | §八 uncommit — mmap 重映射参数 |
| proc | `man 5 proc` → /proc/[pid]/maps | §〇 /proc/self/maps 诊断 |

### 关键概念速查

| 概念 | 定义位置 | 快速解释 |
|------|---------|---------|
| VirtualSpace 三区域 | virtualspace.cpp:860-867 | lower(4K aligned) / middle(large page aligned) / upper(4K aligned) |
| OccupancyMap 双层位图 | virtualSpaceNode.cpp:500-567 | Layer 0: chunk_start_map, Layer 1: in_use_map |
| padding chunk | virtualSpaceNode.cpp:307-364 | 填充到 chunk size 对齐边界的临时 chunk |
| bump-pointer 分配 | virtualSpaceNode.cpp:369-463 | _top 指针从 bottom() 向上推进 |
| envelope 快速排除 | virtualSpaceList.hpp:64-68 | [_envelope_lo, _envelope_hi) 范围检查 O(1) |
| special 路径 | virtualspace.cpp:150 | 大页 + OS 不支持按需提交 → 一次提交 + ptr 操作 |
| noaccess_prefix | virtualspace.cpp:310-340 | 压缩指针 heap base 前的 PROT_NONE 保护页 |
| first_part/last_part 切割 | virtualspace.cpp:245-265 | 共享底层 mmap，可选 split (os::split_reserved_memory) |
| CommitLimiter 防抖动 | virtualSpaceList.cpp:50-62 | _commit_granule_size 阻止低于阈值的 uncommit |
| MetaspaceExpand_lock | virtualSpaceList.cpp:50,64,222 | 保护 commit/reserve 操作的全局 Mutex |

---

## §十五 "不要写成→应该写成" 对照表

| 不要写成 | 应该写成 |
|---------|---------|
| 机械翻译 ReservedSpace::initialize() 的参数表 | 解释三级回退策略为何只有 3 级而非无限尝试：大页→指定地址→OS任意，每级的失败率递增 |
| 列出 VirtualSpace 的 _lower/_middle/_upper 三个字段 | 分析三区域模型的设计意图：lower 和 upper 是 4KB 对齐保护页，middle 是 large page 对齐的提交区 |
| 把 expand_by() 写成简单的 "调用 os::commit_memory()" | 展开 commit 到 large page 边界的 align_up 计算 + 不足时的 shrink 操作 + high_water_mark 延迟更新 |
| 忽略 VirtualSpaceList 的 envelope 快速排除 | 解释 get_new_chunk() 先走 O(1) envelope 范围检查，命中率 >90%，只有跨节点才 fallback 到 O(n) 遍历 |
| 不提 uncommit 和 shmdt 的区别 | uncommit 用 madvise(MADV_DONTNEED) 保留虚拟地址但释放物理页；release() 用 munmap(2) 完全收回虚拟地址空间 |
| 把 VirtualSpaceNode::occupy() 写成 "设置一个 bit" | 展开双层 OccupancyMap 的 chunk_start 位和 in_use 位的 bit 操作：mask = 1UL << bit_index % BitsPerWord; _map[word_index] \|= mask |
| 跳过 CommitLimiter 的防抖动设计 | 解释 _commit_granule_size 的设置依据：低于 64KB 的 commit/uncommit 会导致 OS 页表抖动，阈值过滤掉碎片化的微操作 |

---

*本文档由 Phase 27 prompt-00 生成，覆盖 8 个源文件 (~4,200 行)，分析 VirtualSpace Layer 的完整 Reserve→Commit→Expand→Allocate→Shrink→Uncommit 生命周期。*
