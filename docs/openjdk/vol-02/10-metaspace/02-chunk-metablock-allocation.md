# 02. Chunk + Metablock — 两级分配器

> **前置依赖**:[10-metaspace/01 — Metaspace 全景](openjdk/vol-02/10-metaspace/01-metaspace-overview.md):四层架构里 SpaceManager 的"当前 chunk"在这里展开;[09-memory-core/03 — Arena](openjdk/vol-02/09-memory-core/03-arena-resourcearea-allocation.md):Metablock 的 bump 与 Arena 的 Amalloc 是同一算法;[07-classfile-classloader/01 — ClassFile 解析](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md):解析出的类元数据就是这里的客户
> → **后续**:[10-metaspace/03 — VirtualSpace 与归还](03-virtualspace-arena-reclaim.md)(chunk 从哪来又到哪去)
> 关联域: 09-memory-core(分配器家族)、10-metaspace(元数据)、06-oops(Klass 布局)

## 一个类要 500 字节,怎么给得又快又不浪费

加载一个类: InstanceKlass 约 500 字节、ConstantPool 约 2KB、每个方法约 1KB。如果直接每次向 OS 要 500 字节——系统调用开销就比数据还大;如果每次预留 32KB——碎片又受不了。Metaspace 的回答是**两级**: 大块 Chunk(从虚拟空间整块拿)里,小块 Metablock 用 bump-pointer 紧贴分配。这一篇拆执行面: Metachunk 的四类粒度与头部、ChunkManager 的缓存与切分、Metablock 的分配与 BlockFreelist 的空洞复用。

## 1. Metachunk: 四类粒度与自描述头部

### 粒度: 上一讲验证过的四类

Metaspace 的 chunk 不是流传的"8 种",而是**四类**(metaspaceCommon.hpp:95-101 的 ChunkIndex,10-01 讲过): Specialized(128 words)、Small(512 words,class 空间 256)、Medium(8K words,class 空间 4K)、以及超过 Medium 的 Humongous——每类另有 class 空间的小号版本(metaspaceCommon.hpp:36-41)。分级的意义: 小分配不浪费大块(内部碎片),大分配不凑多个小块(管理开销)。

### Metachunk 结构: 自描述 + 出生记录

`Metachunk`(metachunk.hpp:41-58 有一张 ASCII 结构图: end/top/bottom 三线之间是 free/used/capacity,截取核心,逐字):

```cpp
// metachunk.hpp:55-103(截取核心,逐字)
enum ChunkOrigin {
  // Chunk normally born (via take_from_committed)
  origin_normal = 1,
  // Chunk was born as padding chunk
  origin_pad = 2,
  // Chunk was born as leftover chunk in VirtualSpaceNode::retire
  origin_leftover = 3,
  // Chunk was born as result of a merge of smaller chunks
  origin_merge = 4,
  // Chunk was born as result of a split of a larger chunk
  origin_split = 5,
  ...
};

class Metachunk : public Metabase<Metachunk> {
  ...
  // Current allocation top.
  MetaWord* _top;
  ...
  uint32_t _sentinel;
  const ChunkIndex _chunk_type;
  const bool _is_class;
  // Whether the chunk is free (in freelist) or in use by some class loader.
  bool _is_tagged_free;
  ChunkOrigin _origin;
  int _use_count;
```

- **`_top`**(:88): chunk 内下一个可分配位置(图里的 top 线);
- **`_chunk_type`/`_is_class`**(:97-98): 哪类粒度、属于哪个空间(决定归还到哪个 free list);
- **`_origin`**(:102): **chunk 的出生记录**——normal(正常从已提交区切出)/pad(对齐填充)/leftover(整 Node 退役时剩下的)/merge(小块合并成)/split(大块切开)——调试与统计用;
- **`_sentinel`**(:95): "MET" 魔数,debug 抓越界写。

分配就是一次 bump(metachunk.cpp:72-80,截取核心,逐字):

```cpp
// metachunk.cpp:72-80(截取核心,逐字)
MetaWord* Metachunk::allocate(size_t word_size) {
  MetaWord* result = NULL;
  // If available, bump the pointer to allocate.
  if (free_word_size() >= word_size) {
    result = _top;
    _top = _top + word_size;
  }
  return result;
}
```

头部占用 `Metachunk::overhead()`(metachunk.cpp:47-48,按 object_alignment 对齐)——每个 chunk 先付头部钱,剩下的都是 payload。

## 2. ChunkManager: 缓存、切分与领取

### 三个 ChunkList + 一个字典

`ChunkManager`(chunkManager.hpp:44)维护 **三个固定粒度的 `ChunkList`**(Specialized/Small/Medium,:50)+ **一个 `ChunkTreeDictionary` 管 Humongous**(:59-60)——不是流传的"每粒度一个 free list 数组查更大粒度",Humongous 走二叉字典树(变长,按大小查)。

### 领取路径

`SpaceManager::get_new_chunk`(spaceManager.cpp:383-399,截取核心,逐字):

```cpp
// spaceManager.cpp:383-399(截取核心,逐字)
Metachunk* SpaceManager::get_new_chunk(size_t chunk_word_size) {
  // Get a chunk from the chunk freelist
  Metachunk* next = chunk_manager()->chunk_freelist_allocate(chunk_word_size);

  if (next == NULL) {
    next = vs_list()->get_new_chunk(chunk_word_size,
                                    medium_chunk_bunch());
  }
  ...
  return next;
}
```

先问 ChunkManager 的 free list(`chunk_freelist_allocate`,chunkManager.cpp:540),**缓存 miss 才下沉到 VirtualSpaceList**(上一讲 L4)——这就是"99% bump、1% freelist、0.01% commit"的三层路径里中间那层。ChunkManager 还有一手 `split_chunk`(chunkManager.cpp:342): 大块切出目标大小的小块(切出的带 `origin_split` 记录)。

## 3. Metablock 与 BlockFreelist: bump 之外的空洞复用

### 释放: 不还给 Chunk,先进空洞表

元数据被回收(`SpaceManager::deallocate`,spaceManager.cpp:322-331)后,空间**不立即还给 ChunkManager**——它留在 chunk 里成为空洞,进 `BlockFreelist`(blockFreelist.hpp:41)等复用:

```cpp
// blockFreelist.cpp:45-53(截取核心,逐字)
void BlockFreelist::return_block(MetaWord* p, size_t word_size) {
  assert(word_size >= SmallBlocks::small_block_min_size(), "never return dark matter");

  Metablock* free_chunk = ::new (p) Metablock(word_size);
  if (word_size < SmallBlocks::small_block_max_size()) {
    small_blocks()->return_block(free_chunk, word_size);
  } else {
  dictionary()->return_chunk(free_chunk);
}
```

**两条路按大小分**(不是流传的"SmallBlocks(<256B)/MediumBlocks(<2KB)/LargeBlocks(>=2KB)"三档):

- **小块**: `SmallBlocks`(smallBlocks.hpp:33)——**按 word_size 分桶的 `FreeList<Metablock>` 数组**(`_small_lists[word_size - min_size]`,:37),min 是 sizeof(Metablock)、max 是 sizeof(TreeChunk)(:33-35)——每个尺寸一个桶,取块 O(1);
- **大块**: `BinaryTreeDictionary<Metablock>`(blockFreelist.hpp:37/:43,经典 allocator 字典树)。

`get_block`(:58)先试小块桶,命中直接复用——**复用空洞比在新 chunk bump 更划算**(省了一个 chunk 的头部与碎片)。注意两点: 空洞**不触发 chunk 提前归还**——chunk 的归还发生在 ClassLoader 卸载时整组进行(07-05 的 CLD unload);且 Metablock 的注释(metablock.hpp:36-41)明说空洞块**没有指向所属 chunk 的链接**——归还的粒度是"块",chunk 的生死由 ClassLoader 决定,两者解耦。

**关键设计 (斜体)**: *两级的关键是"归还的粒度不同": Chunk 按 ClassLoader 生命周期整块生灭,Metablock 在 chunk 内部按块复用——空洞留在原地等下次分配,chunk 满到一定程度才整体回归。SmallBlocks 的按尺寸分桶让"找个合适空洞"变成数组下标,字典树兜住大块——释放与复用都不到系统调用层。*

## 4. 三层路径的性能

分配全景是三层(与 09-03 的 Arena 同构):

1. **bump-pointer**(Metachunk::allocate,1-2 次比较+加法)——99% 的分配命中当前 chunk;
2. **ChunkManager free list**(chunk_freelist_allocate,几十 ns)——1% 的场景(当前 chunk 满);
3. **VirtualSpaceList commit**(get_new_chunk → expand,µs 级)——<0.01%(全新虚拟内存)。

与 TLAB 的对照: **算法完全相同**(bump+整块回收),区别只是区域——TLAB 从 GC 堆切、Metablock 从 native 内存切;都没有 per-object free,回收都发生在"整块"级别。

## 核心悬念

两级分配到齐: Metachunk 四类粒度(Specialized/Small/Medium/Humongous)+ 自描述头部(_top/类型/origin 出生记录)+ bump 分配;ChunkManager 三个 ChunkList + Humongous 字典树,缓存 miss 才下沉 VirtualSpaceList(split_chunk 大块切小块);Metablock 释放先进 BlockFreelist——SmallBlocks 按尺寸分桶 O(1) 复用空洞、BinaryTreeDictionary 兜大块;三层路径 99/1/0.01 与 TLAB 同算法。但"从哪来又到哪去"只讲了一半: chunk 领取失败时 VirtualSpaceList 怎么 expand、ClassLoader 卸载后 chunk 怎么归还、整块虚拟空间怎么退役还给 OS?下一篇: VirtualSpace 与归还。

> → [10-metaspace/03 — VirtualSpace 与归还](03-virtualspace-arena-reclaim.md)
