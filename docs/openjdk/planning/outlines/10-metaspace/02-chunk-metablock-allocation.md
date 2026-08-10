# 02. Chunk + Metablock — 两级分配器

> 🔴 Deep | 9 KP 中的 2 个核心机制
> 读者处境: 加载一个类需要 InstanceKlass(~500B)+ConstantPool(~2KB)+Methods(~1KB each)。Metaspace 用 Chunk(大块, 4KB-4MB)+Metablock(小块, 在 Chunk 内 bump-pointer) 两级分配——大块从 VirtualSpace commit，小块极速分配。

### 1. Metachunk — 8 种粒度

场景: ClassLoaderData 要分配 2KB 的 ConstantPool——`MetaspaceArena::allocate(2048)`→当前 Chunk 有空间→bump-pointer (1 cycle)。满→ChunkManager::get_chunk(2048)→SpecializedChunk (1KB) 不够→SmallChunk (4KB)→cached→直接返回。

**Metachunk 粒度** (`chunkManager.hpp:40-100`):
- 8 种: Specialized(1KB)/SmallClassic(2KB)/Small(4KB)/MediumClassic(8KB)/Medium(32KB)/Large(256KB)/Humongous(>256KB, 实际 1-4MB)/SpecializedHumongous
- [C++: 为什么 8 种粒度？— Chunk 太大→小 allocation (<1KB) 浪费空间 (内部碎片)。Chunk 太小→大 allocation (>32KB) 需要多个 Chunk——多了 header+管理开销。分级让 allocation 在最近的粒度上: Specialized 给 Klass(~800B), Small 给 ConstantPool(~2KB), Medium 给 MethodData(~32KB)]
- Chunk header: `_word_size`(实际大小) + `_used_words`(已用) + `_prev/_next`(free list links) + `_is_free` flag。Header 大小: `sizeof(Metachunk)≈64B`
- [C++: `Metachunk::free_bytes()`= `(word_size - used_words) * wordSize`——Chunk 空闲空间。ChunkManager 用此判断 Chunk 是否可容纳新 allocation]

**ChunkManager free list** (`chunkManager.cpp:50-250`):
- `_chunks[NumberOfFreeLists]`数组: 每粒度一个 free list。get_chunk→先从对应粒度 free list 取→空→查下一个更大粒度→空→VirtualSpaceList::get_new_chunk
- `return_chunk(Metachunk*)`: 归还→set `_is_free`→加入对应粒度 free list→检查父 Node 是否所有 Chunk 已归还→是→`VirtualSpaceNode::retire()`
- [C++: ChunkManager 缓存——同一个 Chunk 被 ClassLoader A 释放→还给 ChunkManager→ClassLoader B 分配→直接复用。ChunkManager 避免了内核 commit/uncommit——提高类加载性能 2-3x]

### 2. Metablock — Chunk 内的 bump-pointer + free list

场景: `MetaspaceArena::allocate(512)`→当前 Chunk `_top+512 <= _end`→`void* p = _top; _top += 512; return p`——和 Arena::Amalloc 同样的 bump-pointer。

**Metablock 分配** (`metablock.hpp:30-80`):
- Metablock 在 Chunk 内紧贴分配——无 padding——上一个分配结束→下一个紧接着
- [C++: `_top` 和 `_end` 在 Chunk header 中——`_top` = Chunk 内下一个空闲位置，`_end` = Chunk payload 结束。allocate: `if (top + word_size > end) return NULL (need new Chunk)`→`result = top; top += word_size;` ]
- [C++: MetaspaceArena 的当前 Chunk——`_current_chunk`——allocate 先在此 Chunk→满→调 ChunkManager——ChunkManager::get_chunk——如果 free list 有 Chunk→直接返回——没有→VirtualSpaceList commit——extend。正常路径 (99%): bump-pointer。极少路径 (1%): 新 Chunk。极其罕见 (<0.01%): commit 新虚拟内存]

**Metablock 释放** (`blockFreelist.hpp.cpp`):
- Klass 被回收→其 MetaspaceObj 被 deallocate→`BlockFreelist::return_block(p, word_size)`——按大小加入对应 free list——不立即还给 ChunkManager——在 Chunk 内形成空洞 (free block)
- 下次 allocate——先查 BlockFreelist——如果有合适的 free block→复用 (cheaper than bump-pointer in new Chunk)
- 合并相邻 free block: `BlockFreelist::merge_with_next(p, next)`——相邻两个空闲块合并→减少碎片。如果 Chunk 内所有 block 都 free→Chunk 归还 ChunkManager
- [C++: BlockFreelist 分级——`SmallBlocks(<256B)`/`MediumBlocks(<2KB)`/`LargeBlocks(>=2KB)`。类似 Linux 内核的 slab allocator——按大小分 free list——快速查找合适的 free block]

### 3. 两级分配的性能

**allocate 三层路径**:
1. Chunk 内有空间→bump-pointer (1-2 cycles)——99% 命中的快速路径
2. Chunk 满→ChunkManager::get_chunk (free list lookup)——50-100ns——1% 命中的中速路径
3. ChunkManager cache 空→VirtualSpaceList::get_new_chunk (os::commit_memory)——1-10µs——<0.01% 命中的慢速路径——只有新类加载或 agent instrumentation 时

**对比 Java heap TLAB**: Metaspace 的 Metablock bump-pointer 和 TLAB 的 bump-pointer 是**同一算法**——但是不同内存区域 (native memory vs Java heap)——都没有 per-object free——都由 Chunk level 管理回收

---

### 核心悬念

**"Metaspace 的 Klass 分配——两级: Chunk(4KB-4MB from VirtualSpace)←bump-pointer Metablock(任意大小, 在 Chunk 内)←BlockFreelist(回收后空洞复用)。"** — 99% 分配在 bump-pointer——和 TLAB 一样快。BlockFreelist 回收后空洞避免浪费——ClassLoader 卸载后 Chunk 归还 ChunkManager——下次 ClassLoader 分配时复用。下一个: VirtualSpace 底层——Chunk 从哪来又到哪去。

> → [03-virtualspace-arena-reclaim.md](03-virtualspace-arena-reclaim.md)
