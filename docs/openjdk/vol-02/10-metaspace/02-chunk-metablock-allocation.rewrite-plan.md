# 10-metaspace/02-chunk-metablock-allocation 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 metaspace 为什么需要“chunk 级别批量管理 + metablock 级别细粒度复用”的两级分配，而不是直接 malloc 或单纯 bump 分配

## 1. 选题判断

现稿已经覆盖了 `Metachunk`、`ChunkManager`、`Metablock`、`BlockFreelist`，但叙事仍偏“组件分解表”：四类 chunk 一节、ChunkManager 一节、Metablock 一节。读者能记住类名，却不一定抓住真正困惑：

**加载类时，大量元数据只有几百字节到几 KB，为什么 HotSpot 不直接对每个 `Klass`/`Method` 调一次 malloc？如果都塞进 chunk 里 bump allocate，又为什么还要搞出 `Metablock`、`BlockFreelist`、`SmallBlocks` 和字典树这些复用结构？**

也就是说，这篇真正要回答的不是“有哪些类”，而是“metaspace 为什么既不能退回到直接 malloc，也不能满足于只会向前 bump”。

## 2. 一句话顿悟

**Metaspace 的执行面要同时解决两件互相拉扯的事：一方面，元数据分配必须像 Arena/TLAB 一样快，所以日常路径落在当前 `Metachunk` 的 bump allocate；另一方面，元数据寿命又不完全整齐，chunk 退休后会留下很多仍可复用的小空洞，所以 HotSpot 不把这些空洞立刻还给全局，而是把它们变成 `Metablock`，留在同一个 `SpaceManager` 里通过 `BlockFreelist` 复用。Chunk 负责“跟着 class loader 整批生灭”，Metablock 负责“在 chunk 内部把碎片再吃一轮”。**

## 3. 总图

```text
Metadata request (hundreds of bytes ~ few KB)
  │
  ├─ SpaceManager::allocate
  │    ├─ 先看 per-manager BlockFreelist
  │    └─ 否则走 allocate_work
  │
  ├─ Metachunk
  │    ├─ bump allocate via _top
  │    ├─ chunk header self-describes type/origin/class-space
  │    └─ four size classes: specialized/small/medium/humongous
  │
  ├─ current chunk exhausted
  │    └─ SpaceManager::grow_and_allocate
  │         ├─ ChunkManager freelist/dictionary
  │         └─ split larger chunks when needed
  │
  └─ chunk retirement / deallocation inside one SpaceManager
       ├─ leftover small holes -> Metablock
       ├─ small holes -> SmallBlocks exact-size buckets
       └─ larger holes -> BinaryTreeDictionary
```

## 4. 结构大纲与字数预算

### 第一节：开场事故——几百字节的 metadata，为什么不能直接 malloc

目标约 1200 字。

- 从 `InstanceKlass` / `Method` / `ConstantPool` 的量级开场
- 说明直接 malloc 的问题：系统分配开销、头部开销、生命周期分散
- 再提出相反极端：全都靠 chunk bump 也会留下大量洞
- 引出两级分配的张力：快路径要像 bump，复用又不能完全放弃

### 第二节：三个朴素方案为什么都不够

目标约 1800 字。

至少推演：
1. 每个 metadata 对象直接 malloc/free
2. 只做 chunk bump allocate，从不回收 chunk 内空洞
3. 一旦对象释放，就把所在 chunk 立刻还给全局

要落出的结论：
- direct malloc 太贵，且把元数据所有权打散
- 纯 bump 会积累 chunk 内部碎片
- 逐块归还 chunk 会破坏“按 class loader 整仓生灭”的边界

### 第三节：Metachunk——为什么 metaspace 的第一层单位是 chunk

目标约 1900 字。

- `Metachunk` 的底层图：bottom / top / end
- `_top` bump allocate
- `overhead()` 与头部开销
- `_chunk_type` / `_is_class` / `_origin` / `_sentinel`
- 纠偏：`origin_*` 不是业务语义，而是 chunk 出生记录与调试线索

### 第四节：四类 chunk 粒度——为什么不是一个万能块大小

目标约 1700 字。

- `Specialized/Small/Medium/Humongous`
- class space 与 non-class space 尺寸不同
- 大小分层解决的不是“好看”，而是减少内部碎片与管理开销
- 纠偏：不是“8 种主类型”，而是 4 种 chunk 类型 + class/non-class 两套尺寸表

### 第五节：ChunkManager——为什么当前 chunk 用完后先问全局 free chunks

目标约 1900 字。

- `SpaceManager::get_new_chunk` 先走 `chunk_freelist_allocate`
- `ChunkManager` 的三条非 humongous freelist + humongous dictionary
- `free_chunks_get` 在没有目标尺寸时会向更大块借并 `split_chunk`
- `origin_split`、`inc_use_count`、container count 这些动作的意义
- 纠偏：缓存 miss 才下沉 `VirtualSpaceList`，不是每次缺块都去 commit/reserve

### 第六节：Metablock——为什么 chunk 内空洞不能直接丢掉

目标约 1700 字。

- `Metablock` 是 chunk 内部分配/复用的最小单位
- 它没有指回所属 chunk 的显式链接
- `SpaceManager::deallocate` 把空洞留在本 manager 内
- 解释“块可复用，但 chunk 的生死仍跟着 class loader”

### 第七节：BlockFreelist + SmallBlocks——为什么复用路径分成小块桶和字典树

目标约 2100 字。

- `BlockFreelist::return_block/get_block`
- `SmallBlocks` 是 exact-size buckets
- 大块走 `BinaryTreeDictionary`
- `WasteMultiplier`：为什么大块不愿意为了小请求切得太碎
- 小块和大块的分界不是文中流传的三档说法

### 第八节：整条执行链收拢——快路径、慢路径、复用途径怎么分工

目标约 1400 字。

- `SpaceManager::allocate` 先 freelist，再 current chunk bump，再 grow
- 把“元数据对象的直接分配”与“chunk 领取/切分/commit”三层分开
- 与 Arena/TLAB 做有限对照：快路径同构，生命周期语义不同

### 第九节：误解澄清与收网

目标约 1200 字。

至少回答：
1. metadata 是否应该直接 malloc/free
2. metaspace 是否只靠 bump、不做空洞复用
3. chunk 用完是否立刻还给全局
4. `Metablock` 是否知道自己属于哪个 chunk
5. `SmallBlocks` 是否是“三档分类器”
6. `Humongous` 是否也走普通 freelist

## 5. 失败方案必须写进正文

1. 每个 metadata 对象直接 malloc/free
2. 只做 chunk bump allocate，不复用 chunk 内空洞
3. metadata 一释放就把所在 chunk 立刻归还全局

## 6. 证据清单

- `share/memory/metaspace/metaspaceCommon.hpp:35-42,92-107`：chunk 尺寸与 `ChunkIndex`
- `share/memory/metaspace/metachunk.hpp:42-153`：结构图、`_top`、`_chunk_type`、`_is_class`、`_origin`、`_sentinel`
- `share/memory/metaspace/metachunk.cpp:47-49,53-80,83-89`：`overhead()`、ctor、`allocate()`、used/free
- `share/memory/metaspace/spaceManager.hpp:176-195,208-219`：分配接口与 word sizing
- `share/memory/metaspace/spaceManager.cpp:173-220,322-452`：grow、retire current、freelist、allocate path
- `share/memory/metaspace/chunkManager.hpp:43-157`：free chunk structures
- `share/memory/metaspace/chunkManager.cpp:342-430,433-570,572-597`：`split_chunk`、`free_chunks_get`、`chunk_freelist_allocate`、return chunk
- `share/memory/metaspace/blockFreelist.hpp:37-88`：dictionary + small blocks + `WasteMultiplier`
- `share/memory/metaspace/blockFreelist.cpp:45-99`：`return_block` / `get_block`
- `share/memory/metaspace/smallBlocks.hpp:37-79`：exact-size buckets
- `share/memory/metaspace/metablock.hpp:33-46`：Metablock 生命周期与无显式 chunk link

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇讲“chunk 与 block 的执行面”，不展开 `VirtualSpaceList` reserve/commit 细节；那是下一篇 `03-virtualspace-arena-reclaim.md`
- `Metablock` 的复用只发生在同一个 `SpaceManager` 内部，不跨 manager 搬运
- chunk 的归还粒度与 metablock 的复用粒度必须明确区分
- 不能把 class/non-class 的尺寸差异误写成“8 种 chunk 类型”

## 8. 完成后 review

- 删除代码后，能否复述“chunk 负责整仓寿命，metablock 负责仓内碎片复用”
- 是否明确回答了“为什么不能 direct malloc”“为什么不能只会 bump”
- 是否把 `SpaceManager -> Metachunk -> ChunkManager -> BlockFreelist` 讲成一条执行链，而不是类名列表
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
