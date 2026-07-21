# Metaspace —— 类元数据的 Native Memory 管理器

> **本文定位**：背景知识文章。03（ClassLoaderData）和 06（MetaspaceCounters）都引用了 Metaspace 的内部机制——VirtualSpaceList、ChunkManager、ClassType/NonClassType 分离——但从未系统讲解。本文补上这个缺口：从 "CLD 需要一个内存分配器" 逐层推到全局 VirtualSpaceList → per-CLD SpaceManager → chunk 级复用。
>
> **前置依赖**：ClassLoaderData 见 [ch10/03](03-classloader-data-null.md)——理解每个 CLD 有一个独立的 Metaspace。OopStorage 见 [ch10/02](02-oopstorage.md)。
>
> **JDK 版本**：本文基于 **JDK 11u** 源码（`src/hotspot/share/memory/metaspace/`）。JDK 16 起 JEP 387 "Elastic Metaspace" 重新设计了 Metaspace——`SpaceManager` 被 `MetaspaceArena` 替代，`ChunkManager` 的 humongous `BinaryTreeDictionary` 被移除，chunk 管理改为 buddy allocator + granule 粒度 lazy commit。本文描述的三层架构（VSL + ChunkManager + SpaceManager）适用于 JDK 8~15；JDK 16+ 读者请参考 [JEP 387](https://openjdk.org/jeps/387) 和文末附录 A。

---

## 1. 问题：元数据存在哪里

### 1.1 JDK 7 及以前：PermGen

永久代是 Java 堆的一个区域，所有类的元数据都堆在一起。class loader 被 GC 回收后，它加载的类的元数据仍然占据 PermGen——必须等下一次 Full GC 才能释放，而且只有 CMS 才回收。

### 1.2 JDK 8：Metaspace

Java 8 用 Metaspace 替代 PermGen。核心变化：元数据不再存 Java 堆里，而是分配在 native memory（C 堆）。每个 CLD 有自己的 `ClassLoaderMetaspace` 实例——class loader 被 GC 回收后，整个 Metaspace 连同里面所有 Klass、Method、ConstantPool 一次性归还操作系统。

优点：
- 独立生命周期：每个 loader 的元数据独立分配、独立释放
- 不需要 Full GC 才回收
- 空间上限是操作系统内存，不是 `-XX:MaxPermSize`

### 1.3 三层结构

Metaspace 分三层管理（全局层内部还有 VSL → Node → chunk 的嵌套层次）：

```
全局层（所有 CLD 共享）:
  VirtualSpaceList  →  VirtualSpaceNode 链表
    └─ VirtualSpaceNode  →  mmap reserve 的一段连续虚拟地址，lazy commit
         └─ chunk        →  固定 size class 的块（Specialized/Small/Medium/Humongous）
  ChunkManager      →  空闲 chunk 的全局回收池（跨 CLD 复用）

Per-CLD 层（每个 CLD 独占）:
  ClassLoaderMetaspace  →  持有两个 SpaceManager
    SpaceManager (_vsm)      →  NonClassType 分配器
    SpaceManager (_class_vsm) →  ClassType 分配器

分配层:
  SpaceManager  从 ChunkManager 获取 chunk，在 chunk 内 pointer-bump 分配 block
```

**一个 block 的完整层次**：VSL（链表）→ VirtualSpaceNode（一段连续虚拟地址）→ chunk（固定 size class）→ block（bump pointer 分配的小块，就是你的 Klass/Method/ConstantPool）。

---

## 2. 全局层：VirtualSpaceList + VirtualSpaceNode

### 2.1 类比：一个连续的地址空间链表

Metaspace 不直接调 `malloc`。它先通过 `mmap` 预留大块虚拟地址空间（reserve），按需提交物理页（commit）。这避免了频繁的 mmap/munmap 系统调用。

`VirtualSpaceList`（VSL）是一个 VirtualSpaceNode 的单向链表——每个 Node 是 `mmap` 分配的一段连续虚拟地址空间（默认 256KB 起步）：

```
VirtualSpaceList:
  Node_0 → Node_1 → Node_2 → NULL
  [256K]   [512K]   [1M]
```

`_current_virtual_space` 指向当前活跃的 Node。分配时先从当前 Node 的 committed 区域 bump pointer 分配——不够则 expand（commit 更多物理页）或创建新 Node。

### 2.2 VirtualSpaceNode

`VirtualSpaceNode.hpp:42`，每个 Node 管理一段连续虚拟空间。核心字段（省略 `_next` 链表指针、`_is_class` 类型标记等实现细节）：

```cpp
class VirtualSpaceNode : public CHeapObj<mtClass> {
  ReservedSpace _rs;              // mmap 返回的保留地址空间（ch11/03 详讲，2.2.2 回顾）
  VirtualSpace _virtual_space;    // committed 范围管理——commit 连续生长模型（详见 2.2.2）
  MetaWord* _top;                 // bump pointer——当前已分配的最高地址，下一次分配从此开始
  uintx _container_count;         // Node 内活跃 chunk 计数——分配时 inc，归还时 dec，
                                  // purge 时 ==0 是删除 Node 的判定条件（见第 9 节）
  OccupancyMap* _occupancy_map;   // 双 bit 位图——记录每个 chunk 的起始位置和状态（详见 2.2.1）
};
```

**reserve 和 commit 分离**。`VirtualSpaceNode` 构造函数调 `mmap` reserve 一大块虚拟地址（比如 2MB），但一开始 `_virtual_space` 的 committed 大小可以是 0。`expand_by(min_words, preferred_words)` 按需把物理页 commit 进去——粒度是 `os::vm_page_size()`（4KB）。这叫 lazy commit。

#### 2.2.1 OccupancyMap 的两层位图

VirtualSpaceNode 内部是一大段连续虚拟地址，被切分成多个 chunk（不同大小：Specialized/Small/Medium/Humongous）。随着 chunk 被分配出去、归还、再分配，Node 需要快速回答两个问题：

- **问题 1**：给定一个地址，它是不是某个 chunk 的起始位置？（区分 chunk 头部 vs chunk 中间）
- **问题 2**：给定一个区域，里面有没有正在被使用的 chunk？（判断能否合并）

不靠位图的话，回答这两个问题要遍历 chunk 链表逐个比对地址——O(n)。`OccupancyMap`（`occupancyMap.hpp:49`）用两层平行的位图把它们变成 O(1) 查询：

```cpp
uint8_t* _map[2];
enum { layer_chunk_start_map = 0,  // 第一层：标记 chunk 起始位置
       layer_in_use_map = 1 };    // 第二层：标记 chunk 是否在用
```

`uint8_t* _map[2]` 是 C 声明语法不直观——它不是"两个位图数组"，而是**一个长度为 2 的指针数组**，每个元素是 `uint8_t*`（字节指针），分别指向两块独立的字节数组（位图）：

```cpp
uint8_t* _map[2];
// 等价于：
uint8_t* _map_layer_0;  // 指向第一层位图（chunk-start-map）
uint8_t* _map_layer_1;  // 指向第二层位图（in-use-map）
```

`_map` 只是把两个指针打包在一起，方便用 `_map[layer]` 索引访问。两块位图大小相同（都是 `_map_size` 字节），因为覆盖同一个 Node 的地址范围；区别只在内容——第一层记录 chunk 头部位置，第二层记录占用状态。内存布局：

```
_map[0] ──→ [byte0][byte1][byte2]...   ← 第一层位图（chunk-start-map）
_map[1] ──→ [byte0][byte1][byte2]...   ← 第二层位图（in-use-map）
```

每个 `uint8_t` 字节有 8 个 bit，所以 1 字节可以表示 8 个 slot。查询 bit N 的值（源码 `get_bit_at_position`）：

```cpp
byteoffset = N / 8;              // 第几个字节
mask = 1 << (N % 8);             // 字节内的第几个 bit
return (_map[layer][byteoffset] & mask) > 0;  // 读出该 bit
```

所以前面的例子（8 个 slot）实际上只需要 1 字节就能装下整个位图：

```
_map[0] ──→ [0b10001000]   ← 第一层：bit 0 和 bit 4 是 1（两个 chunk 头部）
_map[1] ──→ [0b11110000]   ← 第二层：bit 0-3 是 1（Small A 在用）
```

每个 bit 代表一个 `SpecializedChunk` 大小的区域（最小 chunk size，`metaspaceCommon.hpp:37` `SpecializedChunk = 128 words = 1KB`），所以位图粒度是最细的——任何 chunk 都能被位图精确覆盖。

**具体例子**（示意值，展示位图如何编码 chunk 布局）：

假设 Node 有一段 8KB 的 committed 区域。位图粒度是 1KB，所以 8KB 被切成 8 个 slot，里面有两个 Small chunk（每个 4KB = 4 个 slot）：

```
地址:    [0,1K)  [1K,2K)  [2K,3K)  [3K,4K)  [4K,5K)  [5K,6K)  [6K,7K)  [7K,8K)
slot:      0       1       2       3       4       5       6       7
内容:    [------ Small A (4KB) ------]  [------ Small B (4KB) ------]
```

**第一层 chunk-start-map**（bit=1 = chunk 头部）：

```
slot:  0  1  2  3  4  5  6  7
bit:   1  0  0  0  1  0  0  0
```

- bit 0 = 1 → slot 0 是 Small A 的头部
- bit 4 = 1 → slot 4 是 Small B 的头部
- 其他 = 0 → 这些 slot 是 chunk 的中间或尾部

→ **回答问题 1**："地址 4K 是不是 chunk 起始？" 查 bit 4 = 1 → 是（Small B 的头部）

**第二层 in-use-map**（bit=1 = 正在使用）：

假设 Small A 在被某个 CLD 用着，Small B 已归还（空闲）：

```
slot:  0  1  2  3  4  5  6  7
bit:   1  1  1  1  0  0  0  0
```

- bit 0-3 = 1 → Small A 的 4 个 slot 都在用
- bit 4-7 = 0 → Small B 的 4 个 slot 都空闲

→ **回答问题 2**："区域 [0, 8K) 里有没有正在使用的 chunk？" 查 bit 0-7 → bit 0-3 = 1 → 有 → 不能合并

**合并场景**：归还 Small A 后，想合并 Small A + Small B 成一个 8KB 的大 chunk：

1. 查 chunk-start-map[0] = 1 → Small A 是头部，且地址 0 对齐 8KB 边界 ✅
2. 查 in-use-map[0..7] → 全是 0 → 区域内全部空闲 ✅
3. 两个条件都满足 → 删除 Small A 和 Small B，原位创建一个 8KB 的大 chunk

如果 Small A 还在用：in-use-map[0..3] = 1 → 步骤 2 失败 → 不合并。

两层位图的分工：**chunk-start-map 告诉你"边界在哪"，in-use-map 告诉你"能不能动"**。两层配合完成合并判定——这就是 4.1 节 `attempt_to_coalesce_around_chunk` 的 5 步判定中第 3、4 步的底层实现。

#### 2.2.2 ReservedSpace 和 VirtualSpace——reserve/commit 的 C++ 封装

`ReservedSpace` 和 `VirtualSpace` 是 HotSpot 内存管理的基础设施类（`virtualspace.hpp`），不是 Metaspace 专属的——G1 堆、CodeCache、CardTable 都用它们。这里只讲和 Metaspace 相关的部分。

**ReservedSpace**（`virtualspace.hpp:32`）封装 mmap reserve 的结果：

```cpp
class ReservedSpace {
  char*  _base;           // mmap 返回的基地址
  size_t _size;           // 预约的虚拟地址范围大小
  size_t _alignment;      // 对齐粒度
  bool   _special;        // 是否一次性 commit 全部（大页场景）
  // 省略 _noaccess_prefix / _fd_for_heap / _executable
};
```

`_special=true` 表示 reserve 时就 commit 了全部页（典型是大页 `MAP_HUGETLB` 场景，reserve 和 commit 一次完成）。Metaspace 走 `_special=false`——reserve 和 commit 分离。**ch11/03 已详细讲解 ReservedSpace 的 initialize 流程和对齐重试**，本文不重复。

**VirtualSpace**（`virtualspace.hpp:136`）在 ReservedSpace 基础上追踪 committed 范围——假设 commit 是**连续生长**的（从低地址往高地址扩展）：

```cpp
class VirtualSpace {
  char* _low_boundary;    // reserved 区域下界（整个预约范围的起始）
  char* _high_boundary;   // reserved 区域上界（整个预约范围的结束）

  char* _low;             // committed 区域下界（已 commit 的起始）
  char* _high;            // committed 区域上界（已 commit 的结束）
                          // ——expand_by 把 _high 往上推，shrink_by 往下退

  bool _special;          // 是否一次性 commit 全部（与 ReservedSpace::_special 联动）
  // 省略 MPSS 大页混合对齐字段：_lower_high / _middle_high / _upper_high 等
};
```

`expand_by(words)` 把 `_high` 往上推——调 `os::commit_memory` 把新页权限从 `PROT_NONE` 改成 `PROT_READ|PROT_WRITE`。`shrink_by(words)` 反过来——调 `os::uncommit_memory` 改回 `PROT_NONE`。`committed_size()` = `_high - _low`。

**Metaspace vs G1 的 commit 模型差异**：

| | Metaspace（通用 `VirtualSpace`） | G1 堆（`G1PageBasedVirtualSpace`，ch11/03 讲过） |
|---|---|---|
| commit 追踪方式 | `_low`/`_high` 两根指针，假设连续生长 | `CHeapBitMap`，每个 bit 对应一页 |
| 支持分散 commit？ | ❌ 不支持——只能从 `_low` 往 `_high` 方向连续扩展 | ✅ 支持——可以只 commit Region 3、跳过 Region 4、再 commit Region 5 |
| 适用场景 | bump pointer 分配（`_top` 往前推，commit 跟着推进） | per-Region 独立 commit/uncommit（Region 级别回收） |

Metaspace 用连续 commit 模型是因为它的分配是 bump pointer（`_top` 从低地址往高地址推），不需要跳着 commit。G1 需要 per-Region 独立 commit 是因为不同 Region 的生命周期不同——有的 Region 在用，有的被回收了可以 uncommit。

### 2.3 全局有两个 VirtualSpaceList

`Metaspace` 持有两个 VSL（`metaspace.hpp:137-138`）：

```
_space_list          → NonClassType（Method、ConstantPool、Symbol 等）
_class_space_list    → ClassType（InstanceKlass 等，压缩指针模式）
```

为什么是两个？64 位开启 `UseCompressedClassPointers` 时，Klass 对象需要保持在 32-bit 可寻址范围内（narrow klass）。所以 ClassType 单独从堆顶之上 mmap ——它的地址范围是压缩指针可达的。NonClassType 不受此限制。

`using_class_space()` 只在 64-bit + `+UseCompressedClassPointers` 时返回 true。关闭压缩指针或 32 位平台时，ClassType 和 NonClassType 共用同一个 `_space_list`。

### 2.4 global_initialize 创建了什么

`Metaspace::global_initialize()`（`metaspace.cpp:1294`）在 `universe_init` 第 694 行调用——是 Metaspace 的初始化入口。简化后的源码（删除条件编译和 assert，保留生产环境默认路径 `UseSharedSpaces=true` + 64-bit + `UseCompressedClassPointers`）：

```cpp
void Metaspace::global_initialize() {
  // 1. 初始化 GC 水位线
  MetaspaceGC::initialize();                    // _capacity_until_GC = MaxMetaspaceSize

  // 2. CDS 接管（默认 UseSharedSpaces=true）
  MetaspaceShared::initialize_runtime_shared_and_meta_spaces();
  //   → 内部映射归档的内存空间，包括压缩类空间
  //   → 创建 _class_space_list 和 _chunk_manager_class

  // 3. 计算首个 chunk 大小（给 Boot CLD 用）
  _first_chunk_word_size = align_word_size_up(InitialBootClassLoaderMetaspaceSize / BytesPerWord);
  _first_class_chunk_word_size = align_word_size_up(
      MIN2((size_t)MediumChunk*6, (CompressedClassSpaceSize/BytesPerWord)*2));

  // 4. 计算初始 VirtualSpaceNode 大小
  size_t word_size = align_up(VIRTUALSPACEMULTIPLIER * _first_chunk_word_size,
                              Metaspace::reserve_alignment_words());

  // 5. 创建 NonClassType 的 VSL 和 ChunkManager
  _space_list = new VirtualSpaceList(word_size);
  _chunk_manager_metadata = new ChunkManager(false);

  // 6. 收尾
  _tracer = new MetaspaceTracer();
  _initialized = true;
}
```

逐步解释：

**步骤 1：MetaspaceGC::initialize()** —— 第 8.3 节讲过，设 `_capacity_until_GC = MaxMetaspaceSize`。VM 初始化阶段不能 GC，先把水位线放到最高，等 `post_initialize` 再降回正常。

**步骤 2：CDS 接管** —— 默认 `UseSharedSpaces=true`（`globals.hpp:2484`，JDK 11 已默认开启），`MetaspaceShared::initialize_runtime_shared_and_meta_spaces()` 接管压缩类空间初始化：映射归档的内存空间，创建 `_class_space_list` 和 `_chunk_manager_class`。CDS 是独立子系统，由 `MetaspaceShared` 类管理，本文不展开。

> **非 CDS 路径**：如果 `-Xshare:off` 关闭 CDS 或归档不可用，步骤 2 被跳过，改走 `allocate_metaspace_compressed_klass_ptrs`（`metaspace.cpp:1074`）自己 `mmap` reserve `CompressedClassSpaceSize` 大小 + 调 `initialize_class_space(rs)`（`metaspace.cpp:1222`）创建 `_class_space_list` 和 `_chunk_manager_class`。逻辑等价但本文不展开。

**步骤 3：计算首个 chunk 大小** —— 给 Boot CLD 用（Boot CLD 是第一个被创建的 CLD，加载 `java.base` 等核心模块）：

- `_first_chunk_word_size` = `InitialBootClassLoaderMetaspaceSize / wordSize`（NonClass，默认 4MB）—— Boot CLD 首个 NonClass chunk
- `_first_class_chunk_word_size` = `MIN2(MediumChunk*6, CompressedClassSpaceSize/2)`（Class）—— 源码注释说"比 medium chunk 大，避免被放入 medium freelist"——故意大于 Medium，这样首个 class chunk 不会和普通 Medium chunk 混在同一个 freelist 里

**步骤 4：计算初始 VirtualSpaceNode 大小**：

- `word_size = VIRTUALSPACEMULTIPLIER * _first_chunk_word_size`——初始 Node 大小是首个 chunk 的若干倍
- 对齐到 `reserve_alignment_words`——保证后续 chunk 分配地址对齐

**步骤 5：创建 NonClassType VSL + ChunkManager**：

- `_space_list = new VirtualSpaceList(word_size)`——用步骤 4 的大小创建首个 VirtualSpaceNode
- `_chunk_manager_metadata = new ChunkManager(false)`——`false` 表示 NonClass
- 如果 `_space_list->initialization_succeeded()` 返回 false → `vm_exit_during_initialization` 直接退出 VM

**步骤 6：收尾**：

- `_tracer = new MetaspaceTracer()`——JFR 追踪用
- `_initialized = true`——标记初始化完成，后续 `ClassLoaderMetaspace::initialize` 会调 `verify_global_initialization()` 检查这个标志

**初始化完成后的全局状态**：

```
Metaspace（AllStatic 静态类）:
  _space_list          → VirtualSpaceList (NonClass)  ← 步骤 5 创建
  _chunk_manager_metadata → ChunkManager (NonClass)   ← 步骤 5 创建
  _class_space_list    → VirtualSpaceList (Class)     ← 步骤 2 CDS 创建
  _chunk_manager_class → ChunkManager (Class)         ← 步骤 2 CDS 创建
  _first_chunk_word_size / _first_class_chunk_word_size ← 步骤 3 计算
  _capacity_until_GC   = MaxMetaspaceSize              ← 步骤 1 设置
  _initialized         = true                          ← 步骤 6 设置
```

这些全局状态在后续 CLD 创建时被使用——每个 CLD 的 `ClassLoaderMetaspace` 从对应的 `ChunkManager` 获取 chunk，从对应的 `VirtualSpaceList` 获取新 Node。

---

## 3. Per-CLD 层：ClassLoaderMetaspace + SpaceManager

### 3.1 延迟创建

CLD 构造函数把 `_metaspace` 初始化成 NULL（`classLoaderData.cpp:150`）。首次实际分配元数据时才调用 `metaspace_non_null()` 创建 ClassLoaderMetaspace：

```cpp
ClassLoaderMetaspace* ClassLoaderData::metaspace_non_null() {
    ClassLoaderMetaspace* metaspace = OrderAccess::load_acquire(&_metaspace);
    if (metaspace == NULL) {
        MutexLockerEx ml(_metaspace_lock, ...);
        if ((metaspace = _metaspace) == NULL) {
            // 按 CLD 类型选 MetaspaceType：Boot/Anonymous/Reflection/Standard
            metaspace = new ClassLoaderMetaspace(_metaspace_lock, type);
            OrderAccess::release_store(&_metaspace, metaspace);
        }
    }
    return metaspace;
}
```

延迟创建的原因：有些 class loader 只是做委托，从不加载自己的类——不需要 Metaspace。双重检查锁定（DCL）保证只创建一次。

### 3.2 ClassLoaderMetaspace 结构

`metaspace.hpp:237`。每个 CLD 持有一个实例。核心字段：

```cpp
class ClassLoaderMetaspace {
    const Metaspace::MetaspaceType _space_type;  // Boot/Anonymous/Reflection/Standard——决定首次 chunk 大小
    SpaceManager* _vsm;        // NonClassType——Method、ConstantPool、Symbol
    SpaceManager* _class_vsm;  // ClassType——InstanceKlass、ArrayKlass
    Mutex* _lock;              // 从 CLD 传入的 _metaspace_lock
};
```

`allocate(word_size, mdtype)` 根据元数据类型路由到对应的 SpaceManager：`mdtype == ClassType` → `class_vsm()->allocate()`，否则 → `vsm()->allocate()`。

### 3.3 SpaceManager——在 chunk 内分配 block

`spaceManager.hpp:43`。SpaceManager 是 per-CLD 的分配器。它从 ChunkManager 获取 chunk，在 chunk 内做 pointer-bump 分配小块（block）。核心字段（省略 `_lock`/`_mdtype`/`_space_type`/`_num_chunks_by_type[]` 统计等）：

```cpp
class SpaceManager : public CHeapObj<mtClass> {
  Metachunk* _chunk_list;         // 在用的 chunk 链表头——析构时遍历它归还所有 chunk（见 4.2 节 return_chunk_list）
  Metachunk* _current_chunk;      // 当前活跃 chunk（链表中的一个节点），新分配从此 chunk 的剩余空间取
  BlockFreelist* _block_freelists; // 之前释放的 block 的空闲链表——小块释放后不归还 chunk，挂在这里等复用
  size_t _capacity_words;         // 三个统计字段：capacity = used + free + waste + overhead
  size_t _used_words;             // 只记三个，free+waste 由差值推出
  size_t _overhead_words;
};
```

**分配流程**（`SpaceManager::allocate_work`）：
1. 查 `_block_freelists`——有没有之前释放的同大小 block。有就直接返回
2. `_current_chunk` 里还有空间 → bump pointer 分配
3. 当前 chunk 满了 → 从 ChunkManager 获取新 chunk → 设为 `_current_chunk`

**和全局 ChunkManager 的关系**：SpaceManager 通过 `chunk_manager()->chunk_freelist_allocate(word_size)` 获取 chunk。如果 ChunkManager 没有合适大小的空闲 chunk，再走 VSL 分配新 Node。

---

## 4. ChunkManager——chunk 级的全局回收池

`chunkManager.hpp:44`。ChunkManager 管理已分配但暂时不用的 chunk——避免释放后又立即重新分配造成的虚拟内存抖动。

**三种大小的空闲链表**：

```
_free_chunks[SpecializedIndex]  →  小 chunk（< 1KB）
_free_chunks[SmallIndex]        →  中 chunk（~4KB）
_free_chunks[MediumIndex]       →  大 chunk（~16KB+）
```

外加一个 `_humongous_dictionary`——超大 chunk 的二叉搜索树字典（`BinaryTreeDictionary`，HotSpot 自带的平衡 BST，非严格红黑树）。

### 4.1 split 和 coalesce——对偶机制

ChunkManager 的核心是 split（切大 chunk 成小 chunk）和 coalesce（合并相邻小 chunk 成大 chunk）的对偶机制。两者一起维持 chunk size class 的流动性——避免某一种 size 用尽而另一种堆积。

**split**（`chunkManager.cpp:342`）发生在分配时——`chunk_freelist_allocate(word_size)` 在目标 freelist 没货时，从更大的 freelist 取一个 chunk，按目标 size 切出至少一个目标 chunk，剩余空间切成尽可能大的 chunk 全部归还 freelist。这是"切大补小"。

**coalesce**（`chunkManager.cpp:63` `attempt_to_coalesce_around_chunk`）发生在归还时——`return_single_chunk` 把 Small 或 Specialized chunk 还回 freelist 后，立刻尝试合并相邻 chunk 形成更大的 chunk。这是"合小成大"。

coalesce 的判定流程（依赖 2.2.1 的 OccupancyMap）：

1. 计算目标 chunk 类型对应的合并区域 `[p_merge_region_start, p_merge_region_end)`——按 `target_chunk_word_size` 对齐
2. 检查区域完全在 VSN 的 committed 范围内（`vsn->bottom()` ~ `vsn->top()`）
3. **chunk-start-map 检查**：区域起止位置必须是 chunk 边界（`ocmap->chunk_starts_at_address()`）——保证不会切断一个跨边界的 humongous chunk
4. **in-use-map 检查**：区域内不能有正在使用的 chunk（`ocmap->is_region_in_use()` 返回 false）——保证合并的全是空闲 chunk
5. 全部满足 → `remove_chunks_in_area` 删除区域内所有小 chunk → 原位 `::new` 创建一个大的合并 chunk → 更新 OccupancyMap 的 chunk-start bit → 加入目标 freelist

归还路径的合并尝试顺序（`return_single_chunk` 末尾）：

```
归还 Small chunk     → 先尝试合并成 Medium（target=MediumIndex）
                    → 失败则放弃
归还 Specialized chunk → 先尝试合并成 Medium
                    → 失败再尝试合并成 Small
                    → 仍失败则放弃
```

Medium chunk 归还时不尝试合并——下一个 size class 是 Humongous，没有固定大小无法对齐合并。

### 4.2 return_chunk_list——批量归还

`return_chunk_list(Metachunk* chunks)`（`chunkManager.cpp:623`）接收一个 chunk 链表头，遍历链表对每个 chunk 调 `return_single_chunk(cur)` 单独归还。`return_single_chunk` 根据大小分发：

- 非 humongous（Specialized/Small/Medium）→ 加入对应 `_free_chunks[index]` freelist 头部 → 触发 4.1 的 coalesce 尝试
- humongous → 调 `_humongous_dictionary.return_chunk(chunk)` 加入 BST 字典

SpaceManager 析构或 CLD 卸载时，把 `_chunk_list` 整条链表通过 `return_chunk_list` 还给 ChunkManager——每个 chunk 单独走分发+合并流程，而不是作为整批处理。

**为什么有两个 ChunkManager？** 和 VSL 同理——ClassType 和 NonClassType 各一个全局实例（`_chunk_manager_metadata` 和 `_chunk_manager_class`）。ClassType 的 chunk 在压缩指针空间里——如果混用会导致地址溢出。

---

## 5. 分配全路径：从 Klass::new 到 bump pointer

以创建 InstanceKlass 为例，走完整分配链路：

```
Klass::operator new (klass.cpp:187)
  → Metaspace::allocate(loader_data, word_size, ClassType, THREAD)
    → loader_data->metaspace_non_null()                     // 首次延迟创建
    → ClassLoaderMetaspace::allocate(word_size, ClassType)   // 路由到 class_vsm
      → SpaceManager::allocate(word_size)                    // 在 chunk 内分配
        → 查 _block_freelists → 有 → 直接返回
        → _current_chunk 有空间 → bump pointer 分配，返回
        → _current_chunk 满了 → ChunkManager::chunk_freelist_allocate
          → freelist 命中 → 设为新 _current_chunk
          → freelist 未命中 → VirtualSpaceList::get_new_chunk
            → 当前 Node 有空间 → bump pointer 从 committed 区域分配新 chunk
            → 当前 Node 满了 → expand_by（commit 更多页）→ 重试
            → expand 失败 → 创建新 Node，在新 Node 上 commit + 分配
    → Copy::fill_to_words(result, 0)                          // 零初始化
```

**分配粒度对比**：VirtualSpaceNode 以 word（HeapWord = 8 字节）为单位 bump pointer。commit 以 page（4KB）为单位。chunk 以固定 size class 为单位（Specialized/Small/Medium/Humongous）。

---

## 6. 锁模型：per-CLD 锁

每个 CLD 有独立的 `_metaspace_lock`（`classLoaderData.cpp:156`）：`new Mutex(leaf+1, "Metaspace allocation lock", _safepoint_check_never)`。

这意味着：
- 不同 CLD 的元数据分配**完全不互斥**——AppClassLoader 和 PlatformClassLoader 的 `allocate` 可以并发执行
- 同一个 CLD 内的分配**串行化**——两个线程同时给同一个 CLD 加载类时，SpaceManager 的 bump pointer 需要锁保护
- `_safepoint_check_never`——持锁时不检查 safepoint，不会被 GC 打断

对比 OopStorage 的锁模型：OopStorage 用全局 `_allocation_mutex` 保护所有 Block 操作（一个 OopStorage 实例一把锁），Metaspace 用 per-CLD 锁（一个 CLD 一把锁）。粒度不同——因为 OopStorage 的 allocate 是 light-weight（CAS 抢 slot），Metaspace 的 allocate 可能需要 commit 新页、获取新 chunk——持锁时间长。

---

## 7. committed / used / reserved 三种内存状态

`MetaspaceUtils` 提供三个查询（`metaspace.hpp:317-394`），对应 jstat 的 MU/MC/MR：

```
reserved（MR）：mmap 预留的虚拟地址空间总量。最大，但大部分未 commit
  ↓ commit
committed（MC）：OS 实际分配了物理页的大小。≥ used
  ↓ allocate
used（MU）：实际被元数据占用的字节。≤ committed
```

三者之间是严格包含关系：`used < committed < reserved`。

**数据源不同**：
- `reserved/committed` 从 VirtualSpaceList 的缓存计数器取——每次 `link_vs`（新 Node）、`expand_by`（commit 更多）、`purge`（删 Node）时更新
- `used` 从 SpaceManager 的 `_used_words` 累加——每次 `allocate` / `deallocate` 时更新

这意味着 committed 和 used 的差异 = `free + waste + overhead`——chunk 内已 commit 但未分配的剩余空间。差大说明 chunk 碎片化严重——分配频繁、释放频繁，或者 chunk 尺寸选择不当。

---

## 8. MetaspaceGC——触发 GC 的水位线

`Metaspace` 只管分配，何时触发 GC 由 `MetaspaceGC`（`metaspace.hpp:448`）单独负责。核心是一个高水位线 `_capacity_until_GC`（`volatile size_t`，`metaspace.hpp:453`）。

### 8.1 水位线的语义

```
committed_bytes  <  _capacity_until_GC  <  MaxMetaspaceSize
                   ↑
                   超过此值就触发 GC
```

- `_capacity_until_GC` 是"软上限"——分配使 committed 超过它时触发一次 GC
- `MaxMetaspaceSize` 是"硬上限"——OOM 的边界
- 两者之间是 GC 的缓冲区——GC 后如果还是超水位线，就提高水位线；如果远低于水位线，就降低

### 8.2 原子调整——CAS 无锁

`inc_capacity_until_GC(v)`（`metaspace.cpp:142`）用 `Atomic::cmpxchg` CAS 自增——多线程并发扩展时无需加锁。失败情况：
- `new_value > MaxMetaspaceSize` → 直接返回 false，`can_retry=false`
- CAS 失败（其他线程抢先修改了 `_capacity_until_GC`）→ 返回 false，但 `can_retry=true`（可重试）

`dec_capacity_until_GC(v)`（`metaspace.cpp:178`）用 `Atomic::sub` 原子减少——GC 后收缩水位线。

### 8.3 生命周期

- `MetaspaceGC::initialize()`（`metaspace.cpp:184`）：VM 启动时设 `_capacity_until_GC = MaxMetaspaceSize`——因为初始化阶段不能 GC，先放开上限
- `MetaspaceGC::post_initialize()`（`metaspace.cpp:190`）：初始化完成后重置为 `MAX2(committed_bytes, MetaspaceSize)`——回到正常水位
- `MetaspaceGC::compute_new_size()`（`metaspace.cpp:235`）：**每次 GC 末尾调用**，根据 `MinMetaspaceFreeRatio` / `MaxMetaspaceFreeRatio` 调整：
  - 计算期望容量 `minimum_desired_capacity = used_after_gc / (1 - MinMetaspaceFreeRatio/100)`
  - 如果 `capacity_until_GC < minimum_desired_capacity` → `inc_capacity_until_GC` 提高水位线
  - 如果 `capacity_until_GC > minimum_desired_capacity` 且空闲比超过 `MaxMetaspaceFreeRatio` → `dec_capacity_until_GC` 降低水位线

`used_after_gc` 这里实际取 `MetaspaceUtils::committed_bytes()` 而不是 `used_bytes()`——注释解释：chunk freelist 内存可能在碎片化后无法分配，所以保守地视为"已用"。这个保守估计避免水位线被压到 committed 之下导致历史 bug。

### 8.4 OOM 触发链路

分配失败时（ChunkManager 没货 + VSL expand 失败）→ `Metaspace::allocate` 走 `expand_and_allocate` → 检查 `MetaspaceGC::allowed_expansion()` → 如果 0 → `report_metadata_oome` 抛 OOM。GC 在这之前由 JVM 的 `VM_CollectForMetadataAllocation` VM 操作触发——它会调 `compute_new_size` 调整水位线，给再次分配留出空间。

---

## 9. purge——CLD 卸载后释放虚拟内存

CLD 被 GC 卸载后，它的 `ClassLoaderMetaspace` 析构 → `SpaceManager` 析构 → chunk 通过 4.2 的 `return_chunk_list` 还给 ChunkManager。但此时**虚拟地址空间没有真正释放**——VirtualSpaceNode 还在 VSL 链表里，只是 `container_count` 减少。

`Metaspace::purge()`（`metaspace.cpp:1482`）在 safepoint 时真正清理空 Node：

```cpp
void Metaspace::purge() {
  MutexLockerEx cl(MetaspaceExpand_lock, Mutex::_no_safepoint_check_flag);
  purge(NonClassType);
  if (using_class_space()) {
    purge(ClassType);
  }
}
```

`VirtualSpaceList::purge(ChunkManager* chunk_manager)`（`virtualSpaceList.cpp:74`）遍历 Node 链表，对满足条件的 Node 做删除：

- **删除条件**：`vsl->container_count() == 0`（Node 内已无活跃 chunk）**且** `vsl != current_virtual_space()`（保留当前活跃 Node，因为它马上还要用）
- **删除流程**：从链表 unlink → `vsl->purge(chunk_manager)` 把 Node 内残留的 chunk 还给 ChunkManager → 减 `reserved_words` / `committed_words` / `virtual_space_count` 计数 → `delete vsl`（析构调 `munmap` 真正释放虚拟地址）

`purge` 必须在 safepoint 调用（`assert(SafepointSynchronize::is_at_safepoint(), ...)`）——因为遍历 Node 链表期间不能有并发分配。`MetaspaceExpand_lock` 保护 ChunkManager 的 freelist 修改。

这是 Metaspace 真正把内存还给操作系统的唯一路径——`munmap` 在 `~VirtualSpaceNode()` 中调用。ChunkManager 的 freelist 只是中转，committed 但未 purge 的内存仍然占着虚拟地址。

---

## 10. 概念链

```
JDK 7 PermGen 共享元数据 → JDK 8 Metaspace per-CLD 独立
全局层：VSL（链表）→ VirtualSpaceNode（mmap reserve 一段连续虚拟地址）→ 内部切分成 chunk
Per-CLD 层：延迟创建 ClassLoaderMetaspace → 两个 SpaceManager
分配：ChunkManager（全局回收）→ SpaceManager（per-CLD bump pointer）
OccupancyMap 双层位图：chunk-start-map（边界）+ in-use-map（占用）→ coalesce 依赖
split（切大补小）↔ coalesce（合小成大）→ 维持 size class 流动性
ClassType/NonClassType 分离 → 压缩指针需要 Klass 在 32-bit 范围
committed/used/reserved 三层 → jstat MU/MC/MR
MetaspaceGC _capacity_until_GC 水位线 → CAS 原子调整 → compute_new_size GC 后重算
purge → CLD 卸载后 container_count==0 的 Node 从 VSL 链表删除 → munmap 还给 OS
```

---

## 11. 总结

| 概念 | 职能 |
|---|---|
| Metaspace（类） | AllStatic 静态工具类——管理全局 VSL + ChunkManager |
| ClassLoaderMetaspace | per-CLD 实例——持两个 SpaceManager（ClassType + NonClassType） |
| VirtualSpaceList | 虚拟地址空间链表——mmap reserve → lazy commit |
| VirtualSpaceNode | VSL 链表节点——mmap reserve 的一段连续虚拟地址，内部被切分成多个 chunk，`container_count` 追踪活跃 chunk 数 |
| OccupancyMap | 双层位图——chunk-start-map 判边界 + in-use-map 判占用，coalesce 依赖 |
| ChunkManager | chunk 级全局回收池——3 个 freelist + humongous BST 字典 |
| SpaceManager | per-CLD 分配器——从 ChunkManager 取 chunk，chunk 内 bump pointer 分配 block |
| split / coalesce | split 切大 chunk 补小 chunk，coalesce 合小 chunk 成大 chunk |
| ClassType/NonClassType | Klass 对象 vs 其他元数据——压缩指针时分到独立 VSL |
| committed/used/reserved | 三层内存状态——对应 jstat MC/MU/MR |
| MetaspaceGC | `_capacity_until_GC` 高水位线——CAS 原子调整，超限触发 GC |
| purge | safepoint 时清理 `container_count==0` 的空 Node，`munmap` 还给 OS |

---

## 附录 A：为什么 JDK 16+ 换了架构（JEP 387）

本文描述的三层架构（VSL + ChunkManager + SpaceManager）在 JDK 8~15 一直沿用。JDK 16 起 JEP 387 "Elastic Metaspace" 把它整个重写了。这一附录解释**为什么要换**以及**核心思想是否变化**——避免读者误以为旧实现是"垃圾"才被替换。

### A.1 演进动机——三个真实痛点

JEP 387 的 Motivation 开篇直言：

> "metaspace has been somewhat notorious for high off-heap memory usage"

不是抽象的"代码复杂"，而是三类生产环境暴露的内存浪费：

**痛点 1：chunk 太粗 → 小 class loader 浪费大**

JDK 11 的 chunk size class 固定为 Specialized/Small/Medium/Humongous 四档，Medium 已是 16KB+。一个只加载一两个类的 reflection/anonymous CLD 也要占一整个 chunk。JEP 原文：

> "Metaspace chunks are coarse-grained... This can, however, cause applications that use many small class loaders to suffer unreasonably high metaspace usage."

JDK 8 设计 Metaspace 时（2014）主要场景是应用服务器——少量大 class loader。**当时没有预见到**：JDK 8 lambda 大量生成 anonymous CLD、JDK 9 模块系统引入 layer 动态加载、现代框架（Spring AOT、GraalVM、ByteBuddy）大量动态生成类。这些场景下"很多小 CLD"才成为主流，粗 chunk 的浪费被放大。

**痛点 2：freelist 复用不及时**

CLD 卸载后 chunk 还给 ChunkManager freelist，但**什么时候再被取用没人保证**——可能很久，可能永远不：

> "That reuse may not happen for a long time, however, or it may never happen."

大量 class loading/unloading 的应用（应用服务器、JSP 重编译、动态生成代码的框架）会在 freelist 里堆积大量闲置 chunk。

**痛点 3：碎片化导致无法还给 OS——这是最致命的**

freelist 里的空间理论上可以 unmap 还给操作系统，但**前提是物理连续**：

> "That space can be returned to the operating system to be used for other purposes if it is not fragmented, but that's often not the case."

JDK 11 的 coalesce 机制（本文 4.1 节）只能合并**物理相邻的同 size chunk**。但 chunk 在 VSL Node 里被分配/释放的顺序是任意的——freelist 里大量 chunk 物理上不连续，coalesce 救不了。所以 `Metaspace::purge`（本文第 9 节）只能删 `container_count==0` 的**整个 Node**——条件极苛刻，大部分情况内存就锁在 freelist 里了。

**三个痛点合起来 = Metaspace 内存"涨上去就下不来"**，JEP 把这叫 **inelasticity**（无弹性）。

### A.2 核心思想没变——设计哲学保留

JEP 387 是实现重写，不是设计哲学推翻。下表对照哪些保留、哪些变化：

| 维度 | JDK 11 | JDK 16+ | 是否变化 |
|---|---|---|---|
| 存储位置 | native memory（C 堆外） | native memory | ❌ 保留 |
| 分配单位 | per-CLD arena | per-CLD arena | ❌ 保留 |
| 分配算法 | pointer-bump | pointer-bump | ❌ 保留 |
| 地址空间 | reserve/commit 分离 | reserve/commit 分离 | ❌ 保留 |
| Klass 压缩 | CompressedClassSpace 单独 VSL | CompressedClassSpace 单独 VSL | ❌ 保留 |
| 元数据生命周期 | 跟 CLD 一起 bulk-free | 跟 CLD 一起 bulk-free | ❌ 保留 |

JEP 387 的 Non-Goals 明确：

> "It is not a goal to change the way that compressed class-pointer encoding works, or the fact that a compressed class space exists."

### A.3 实现变化——buddy allocator 替代固定 size class

| 维度 | JDK 11 | JDK 16+ | 变化 |
|---|---|---|---|
| chunk 分级 | 固定 4 档（Spec/Small/Medium/Humongous） | **buddy allocator**——按 2 的幂次动态切分合并 | 重写 |
| humongous 字典 | `BinaryTreeDictionary` BST | **移除**——buddy 自带合并 | 移除 |
| OccupancyMap | 双层位图（chunk-start + in-use） | **移除**——buddy 的 split/merge 内建 | 移除 |
| per-CLD 分配器 | `SpaceManager` | `MetaspaceArena`（重命名+简化） | 重命名 |
| commit 时机 | VSL Node 创建时 commit | **lazy commit per granule**——按需 commit 统一粒度的 granule | 重写 |
| uncommit 粒度 | 整个 Node（`container_count==0` 才行） | **per-granule**——buddy 合并出大块就 uncommit | 这是 elasticity 的核心 |
| 控制选项 | 无 | `-XX:MetaspaceReclaimPolicy=(balanced\|aggressive\|none)` | 新增 |

buddy allocator 天然支持合并——JDK 11 那套复杂的 coalesce 判定流程（OccupancyMap 双层位图、5 步检查）整个被算法本身吸收了。这就是 JEP 说的"reduce maintenance costs"。

弹性来自 uncommit 粒度的细化：JDK 11 只能整 Node 还给 OS（条件极苛刻），JDK 16+ 可以 per-granule 还——buddy 合并出连续大块就能 uncommit。

### A.4 为什么不直接用 C heap？

JEP 387 测试过去掉 Metaspace 全用 C heap 的方案，被否决了。C heap 方案测试结果：

| 指标 | C heap 方案 vs buddy 方案 |
|---|---|
| 性能 | 降 8~12% |
| 峰值 RSS | 增 15~18% |
| 弹性 | **完全无弹性**——峰值后内存一点都不还，差异高达 153% |

原因：C heap 没有 bulk-free（要逐对象释放）、没有 pointer-bump 紧密打包、无法实现 compressed class space。所以 arena + pointer-bump 的核心设计被**保留**——这套设计本身没问题，问题在 chunk 管理算法。

### A.5 一句话评价

JDK 11 的 Metaspace 实现**在它诞生的时代是合格的工程决策**——分配快、代码可读、解决了 PermGen 的核心痛点。局限来自场景演进快于架构迭代：JDK 8 设计时的"少量大 CLD"假设在 lambda/模块/动态框架普及后被打破，粗 chunk + 整 Node uncommit 的 trade-off 从"合理"变成"内存浪费"。

JEP 387 不是"修复 bug"，是**针对新场景的架构迭代**——如果 JDK 8 时代就直接上 buddy allocator，反而可能是过度设计，因为当时没有足够的生产数据证明 elasticity 比 allocation speed 更重要。

历史时间线：
- **2014 JDK 8**：Metaspace 引入（JEP 122），主要目标是替代 PermGen——成功
- **2018 JDK 11**：Metaspace 已在生产跑了 4~5 年，问题开始暴露但还没到必须改的程度
- **2019/03**：Thomas Stuefe 提交 JEP 387 草案
- **2021/03 JDK 16**：JEP 387 发布，花了 2 年多设计实现

这不是"low vs high"的替换，是**不同时代针对不同场景的优化方向选择**。
