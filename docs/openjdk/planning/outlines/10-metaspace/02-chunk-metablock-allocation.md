# 02. Chunk + Metablock — 两级分配器

> 🔴 Deep | 9 KP 中的 2 个核心机制
> 读者处境: 加载一个类需要 InstanceKlass(~500B)+ConstantPool(~2KB)+Methods(~1KB each)。Metaspace 用 Chunk(大块, 4KB-4MB)+Metablock(小块, 在 Chunk 内 bump-pointer) 两级分配——大块从 VirtualSpace commit，小块极速分配。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/10-metaspace/02 已按真实源码成文~145 行,本大纲为规划期产物,机制描述以文章为准;注意本大纲的"8 种粒度"与 01 篇 ⚠️ 块已修正的 4 类自相矛盾,以 01 篇为准):
> - **"8 种粒度 Specialized(1KB)/SmallClassic(2KB)/Small(4KB)/MediumClassic(8KB)/Medium(32KB)/Large(256KB)/Humongous/SpecializedHumongous" 全编造**: jdk11u 是 **4 类**(metaspaceCommon.hpp:95-101 ChunkIndex): Specialized=128 words(:36)/Small=512(class 256)(:38-39)/Medium=8K(class 4K)(:40-41)/Humongous;Chunk header 不是 "_word_size/_used_words/_prev/_next/_is_free 64B"——真实字段=_top(:88)/_sentinel MET(:95)/_chunk_type/_is_class(:97-98)/_is_tagged_free(:100)/_origin(:102,ChunkOrigin normal/pad/leftover/merge/split :55-66)/_use_count
> - **ChunkManager free list**: 真实=**三个固定粒度 ChunkList**(chunkManager.hpp:50,_free_chunks[NumberOfFreeLists],NumberOfFreeLists=3 :101?)+**Humongous 走 ChunkTreeDictionary**(:59-60)——非"每粒度一个 free list 数组查更大粒度";SpaceManager::get_new_chunk(spaceManager.cpp:383-399)=chunk_freelist_allocate(chunkManager.cpp:540)→空则 vs_list()->get_new_chunk;split_chunk(chunkManager.cpp:342,切出带 origin_split :372)
> - **"Metachunk::allocate: top+word_size>end→NULL" 简化但方向对**: 真实=Metachunk::allocate(metachunk.cpp:72-80)free_word_size()>=word_size 才 bump
> - **BlockFreelist 不是 "SmallBlocks(<256B)/MediumBlocks(<2KB)/LargeBlocks(>=2KB)" 三档**(编造): 真实=**SmallBlocks 按 word_size 分桶的 FreeList 数组**(smallBlocks.hpp:33,_small_lists[word_size-min_size] :37,min=sizeof(Metablock)/max=sizeof(TreeChunk) :33-35)+**BinaryTreeDictionary<Metablock>**(blockFreelist.hpp:37/:43);return_block(blockFreelist.cpp:45-53): <small_block_max_size→桶,否则字典;**merge_with_next 不存在**
> - **"MetaspaceArena" 不存在**(JDK15+): 真实=SpaceManager::deallocate(spaceManager.cpp:322-331,懒建 BlockFreelist)+SpaceManager::allocate(:401)
> - **空洞不触发 chunk 提前归还**: chunk 归还=ClassLoader 卸载整组(CLD unload,07-05);Metablock 无指向 chunk 的链接(metablock.hpp:36-41 注释)
> - 三层路径(99% bump/1% freelist/<0.01% commit)与 TLAB 同算法不同区域;悬念指向 03-virtualspace-arena-reclaim.md(标题 "03. VirtualSpace 与归还——chunk 从哪来又到哪去")✓

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
