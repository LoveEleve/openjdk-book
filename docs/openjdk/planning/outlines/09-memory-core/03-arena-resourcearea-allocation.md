# 03. Arena + ResourceArea — VM 内部的 C++ 快速分配器

> 🟡 Working | 10 KP 中的 4 个分配器机制
> 读者处境: JVM 的 C++ 代码从不直接调 `malloc/free`。GC marking 用 Arena (bump-pointer Chunk)，JIT compile 用 ResourceArea (per-thread Mark/Release)，生产分配用 AllocateHeap (NMT tracked)，debug 加 GuardedMemory (canary)。四种分配器——四个不同场景。

### 1. Arena — Chunk-based bump-pointer 分配器

场景: GC marking bitmap→需要 64KB 临时 bit array→`Arena arena(mtGC)`→`void* p = arena.Amalloc(65536)`→在 Chunk 内 bump-pointer——1 cycle。不需要 `free(p)`——scope 退出→`~Arena()`→Chunk 链全部还给 ChunkPool——零 per-object free 开销。

**Arena 结构** (`arena.hpp.cpp` + `arena.cpp`):
- `_first` Chunk(default 32KB)→`_last` Chunk 链表。Amalloc: `if (_top + size <= _max) { result = _top; _top += size; return result; }`——bump-pointer——3 条 C++ 语句
- [C++: bump-pointer 性能——`_top += size` 编译为 `add rax, rcx`——1 cycle。不涉及 malloc/lock——极快。小 alloc (<32KB) 在 Chunk 内——大 alloc (>=32KB)→`_huge` list——独立 `os::malloc`]
- `grow(size_t size)`: Chunk 空间不够→`ChunkPool::take_chunk(requested_size)`→如果 Pool 空→`new Chunk(requested_size)`→追加到 `_last->_next`。Pool hit: ~100ns——`os::malloc` avoided
- [C++: Arena 不是 thread-safe——需要外部 MutexLocker。GC parallel tasks——per-task Arena (在 task local)——不需要 lock。ClassLoader 编译 ClassFile→全局 ClassLoaderData Arena——`MutexLocker ml(ClassLoaderDataGraph_lock)`——仅 grow 时—Amalloc 无锁]
- `Afree(void* ptr, size_t size)`: 只是标记——不真正释放——Chunk 内部可能产生碎片。但 Arena 的生命周期短——GC task scope→task 结束→整个 Arena 销毁——碎片不累积
- `~Arena()`: 遍历 Chunk 链表→`ChunkPool::free_all_async(node)`→Chunk 入池——不调 `os::free`。ChunkPool 缓存减少了 frequent os::malloc/free
- NMT 追踪: `MemTracker::record_arena_allocation(size, mtFlag)`——NMT 按 mtFlag 分类——GC marking 的 Arena(mtGC) vs Compiler 的 Arena(mtCompiler)——统计各子系统内存使用

### 2. ResourceArea — per-thread Mark/Release 栈

场景: C2 编译 `library_call.cpp` (6991 行)——需要~200KB 临时 IR nodes/graph/loops→全分配在 `ResourceArea` (per-thread)→编译完成→`ResourceMark rm`析构→`_area->_top = _saved_top`——**1 cycle 回滚全部 ~200KB**。

**ResourceMark 机制** (`resourceArea.hpp.inline.hpp.cpp`):
- `ResourceMark rm(THREAD)`: ctor 存当前 `_area->_top` 到 `_saved_top`。dtor: `_area->_top = _saved_top`——瞬间释放 scope 内所有分配
- [C++: ResourceMark 的嵌套——C2 compile→inline→每层 inline 独立 ResourceMark。最内层 `ResourceMark rm3` 释放→top=rm3 marker→中层 rm2 释放→top=rm2 marker→外层 rm1 释放→top=rm1 marker。各层独立回收——C2 优化 inline 相关 IR nodes——inline 失败时只回滚该层]
- ResourceArea 是 Arena 子类——Chunk 不释放——top reset 后 Chunk 空间在 Arena 中——下次 alloc 复用。但嵌套过深→Chunk 的未用空隙可能很大——C2 在 large method 后调 `Thread::current()->resource_area()->rollback(0)`——full reset
- per-thread 隔离——不需要 lock——`Thread::current()->resource_area()->Amalloc(size)`——直接取 thread local `_resource_area`

**Arena vs ResourceArea 选择**:
- Arena: 需要**多次 allocate+free 不同对象**——GC marking bitmap、SymbolTable rehash temporary data——多线程共享 (per-task Arena)
- ResourceArea: **per-thread** 栈式生命周期——JIT compile/Class loading/Verifier——自然的 push/pop

### 3. AllocateHeap + GuardedMemory

**AllocateHeap/ReallocateHeap/FreeHeap** (`allocation.hpp.inline.hpp.cpp`):
- `AllocateHeap(size_t size, MEMFLAGS flags, AllocFailType alloc_fail)`: `os::malloc(size, flags)` + NMT tracking 64B header (prepend)。`alloc_fail = AllocFailStrategy::EXIT_OOM`——OOM 时直接 vm_exit→hs_err
- [C++: NMT header——`NativeCallStack` (call stack at allocation point, 4 frames recorded) + `size` + `flags` + `header_size`——跟踪每次 malloc 的调用栈。`jcmd VM.native_memory detail` 打印 NMT malloc 统计——包含调用栈]
- `ReallocateHeap(void* old, size_t new_size, MEMFLAGS flags)`: `os::realloc(old, new_size, flags)`——如果 realloc 能 in-place extend→保留；不能→malloc new+memcpy→free old。NMT tracking header 更新
- `FreeHeap(void* ptr)`: `os::free(ptr)`——release to OS。NMT 标记 freed
- MEMFLAGS 枚举: mtGC(60%), mtCompiler(5%), mtClass(20%), mtThread, mtInternal, mtCode, mtSymbol, mtString, mtClassShared, mtTest, mtTracing, mtNMT, mtOther——每种有独立统计

**GuardedMemory** (`guardedMemory.hpp.cpp`):
- `GuardedMemory::wrap(void* ptr, size_t size)`→分配 `size + 2*4B`→header canary (0xBAADF00D)→body (ptr)→footer canary (0xDEADBEEF)
- [C++: canary 检查——`verify()`→`if (header != 0xBAADF00D)`→buffer underflow——写越界左侧；`if (footer != 0xDEADBEEF)`→buffer overflow——写越界右侧。`guarded_malloc(n)` = `GuardedMemory::wrap(malloc(n+8), n)`]
- [C++: `#ifdef ASSERT` + `CheckMemoryInitialization`——只在 debug build 启用。类似 glibc `MALLOC_CHECK_=3` 但只在 JVM 内部分配]

### 4. ChunkPool — 全局 Chunk 缓存

**ChunkPool** (`allocation.cpp:50-100`):
- 全局单例——`ChunkPool::take_chunk(size_t)`→pool 有合适 Chunk→返回 (bump down)→没有→`new Chunk(size)`
- `ChunkPool::give_chunk(Arena::Chunk*)`→归还 pool→不 free。Pool 超大小限制→`delete chunk` 真释放
- [C++: ChunkPool 缓存避免了连续 GC tasks (并行) 反复 malloc/free Chunk 的开销。每个 GC task 结束后 Arena destruct→ChunkPool give→GC task 下次开始→Arena alloc→ChunkPool take——平均 0 `os::malloc` 调用]

---

### 核心悬念

**"JVM 的 C++ 代码从不调 delete——Arena bump-pointer (1 cycle)→scope exit ChunkPool return。ResourceArea per-thread Mark/Release——嵌套编译——各层独立回滚——最内层失败只回滚该层 IR nodes。"** — NMT tracked AllocateHeap 用于长期分配 (CodeCache/Metaspace)，GuardedMemory canary 只在 DEBUG。四种分配器——生命周期不同——覆盖了 JVM 内部所有的 C++ 内存需求。域 9 完成。

> → domain 10: [Metaspace — 类的元数据怎么分配+回收: VirtualSpaceNode→ChunkManager→Metablock→MetaspaceArena](../10-metaspace/01-metaspace-overview.md)
