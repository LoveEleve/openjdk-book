# G1 的 Region 大小是怎么确定的？

> **本文定位**：背景知识文章。G1 把整个堆切成等大的 Region——本文回答两个问题：Region 多大、这个大小怎么算出来的。核心公式只有一行：`堆平均大小 / 2048` 向下取整到 2 的幂。本文用 `-Xms8G -Xmx8G` 贯穿全程——所有数值都有具体来由。
>
> **前置依赖**：ch11/01 全景。你知道 `initialize_heap` 的阶段 1 `create_heap()` 走进 `create_heap_with_policy<G1CollectedHeap, G1CollectorPolicy>()`。
>
> **阅读提示**：读完本文后你知道三件事：(1) Region 的计算公式和推演过程；(2) RSet 表容量怎么跟着 Region 大小走；(3) `initialize_all` 最终设置了哪几个参数。具体数值记住 Region = 4MB、CardsPerRegion = 8192、heap_alignment = 4MB 即可。

---

## 1. 场景：堆还没创建，Region 大小必须先定下来

`create_heap_with_policy` 模板（`gcArguments.inline.hpp:29-34`）的第一行 `new G1CollectorPolicy()` 触发了构造函数（`g1CollectorPolicy.cpp:35-50`），构造函数里只有两条有效语句：

```cpp
HeapRegion::setup_heap_region_size(InitialHeapSize, MaxHeapSize);  // 算 Region 大小
HeapRegionRemSet::setup_remset_size();                             // 算 RSet 表容量
```

为什么要在这里算？因为 `G1CollectedHeap` 的构造函数就需要 `GrainBytes`——用来设 humongous 阈值（`GrainWords / 2`）、用来创建工作线程池的参数。Region 大小定了，后续的一切才有基准。HotSpot 注释里写得很直白："the policy is created before the heap, we have to set this up here."

---

## 2. Region 大小的推演链

### 2.1 最简单方案——固定一个值，比如 1MB

直接写死 `GrainBytes = 1MB`。问题是如果用户设了 64GB 堆，会有 65536 个 Region——每个 Region 管理一套 RSet 元数据，开销爆炸。反过来如果堆只有 512MB，512 个 Region 又太粗，回收一个 Region 需要搬的活对象太多。

写死不行——**Region 大小必须随堆大小自适应**。

### 2.2 目标：约 2048 个 Region

G1 的设计目标是让堆在任何大小时都有约 2048 个 Region。这是经验和实测的平衡：太多则元数据开销大，太少则回收粒度粗。HotSpot 代码里这个值叫 `HeapRegionBounds::target_number()`。

已知目标数量，推公式只有一步：

```
Region 大小 = 堆大小 / 2048
```

用 `-Xms8G -Xmx8G` 走一遍：

```
堆大小 = 8G = 8192MB
Region 大小 = 8192MB / 2048 = 4MB
```

4MB 恰好是 2 的幂，不用再调整。为什么非要 2 的幂？因为 `GrainBytes` 作为基数参与大量位运算——Region 内地址偏移用低 22 位直接取得（`address & (GrainBytes - 1)`），跨 Region 定位用右移（`address >> LogOfHRGrainBytes`）。不是 2 的幂的话所有这些计算退化成除法和取模，性能损失不可接受。

如果算出来的候选值不是 2 的幂——比如 `-Xms24G -Xmx24G` 得 `12MB`——则向下取整到 `8MB`。源码 `log2_long() + 1 << log` 组合就是做这个取整。

如果算出来超过 32MB——比如 `-Xms128G -Xmx128G` 得 `64MB`——则夹到 32MB。上限 32MB 的意思是"Region 最多这么大，不能再大"，因为单个 Region 的回收停顿时间必须可控。下限 1MB ——"Region 至少这么大，不能再小"，因为每个 Region 的 RSet 等元数据有固定开销。

**公式总结**：

```
候选值 = 堆平均大小 / 2048
Region  = 候选值向下取整到 2 的幂，夹在 [1MB, 32MB]
```

### 2.3 产出的全局变量

`setup_heap_region_size` 把计算结果写入 5 个全局静态字段。以 8GB 堆、4MB Region 为例：

| 全局变量 | 值 | 含义 |
|---------|-----|------|
| `GrainBytes` | 4194304 | Region 字节数（唯一真值） |
| `GrainWords` | 524288 | Region 字数（= GrainBytes / 8） |
| `LogOfHRGrainBytes` | 22 | log₂(GrainBytes) —— 位移用 |
| `LogOfHRGrainWords` | 19 | log₂(GrainWords) |
| `CardsPerRegion` | 8192 | 每个 Region 的 card 数（= GrainBytes / 512） |

**card 是什么**：Card 是 G1 追踪跨 Region 引用的最小单位——每张 card 对应堆上 512 字节。当 Java 代码写 `a.field = b`、a 在 RegionX、b 在 RegionY 时，写屏障不是记录 "a 在 RegionX 的偏移 0x1234"，而是记录"RegionX 的第 N 张 card 变脏了"。512 字节做最小粒度是工程折中——比逐对象追踪省内存，比逐 Region 粗粒度减少 false sharing。`CardsPerRegion = 8192` 意味着 4MB 的 Region 被切成 8192 张 card，每张 512 字节。

为什么同时存 `GrainBytes` 和 `LogOfHRGrainBytes`？前者给算术（除法、比较），后者给位运算（`ptr >> 22` 直接定位 Region）。分离存储避免反复做 `log₂ → pow₂` 转换。

---

## 3. RSet 三层结构与容量推算

### 3.1 RSet 是每个 Region 自己持有的

RSet（Remembered Set）是每个 Region 持有的"反向引用表"——记录"哪些其他 Region 引用了我的对象"。**三个层级都在每个 Region 自己手里**——2048 个 Region = 2048 套独立 RSet，没有跨 Region 共享的结构。

```
Region 0:  [Coarse] [Sparse] [Fine]
Region 1:  [Coarse] [Sparse] [Fine]
...

全堆视角：每个 Region 独立承担自己被引用的追踪成本。
引用方多的 Region Fine 表会变多，空 Region 就基在基础开销。
```

### 3.2 为什么需要三层

问题：一个 young Region 可能被 0 个引用方指向（空），也可能被 100 个引用方指向（热点）。

如果给每个 Region 发一个全尺寸的 card bitmap（8192 bits）去追踪所有可能的引用方——大部分 Region 几乎没有引用方，浪费大量内存。反过来，如果所有 Region 只用稀疏哈希表——热点 Region 会被海量条目撑爆。

**G1 用三层递进解决：引用少用哈希（Sparse）→ 引用多了升为 bit-per-card 位图（Fine）→ 太多了退化成一 bit per Region（Coarse）。**

### 3.3 三层具体是哪些——同一 RSet 的三个组件

**第 1 层 — Sparse（SparsePRT）**：

哈希表，初始 **16 个桶**。每条记录保存 `(引用方 Region ID → card 列表)`。初始占用约 512 字节。容量受 `G1RSetSparseRegionEntries` 控制——超了触发扩容（桶数翻倍），翻倍到上限后不再扩。

**第 2 层 — Fine（PerRegionTable）**：

每个 PerRegionTable 追踪**一个特定引用方 Region** 内的所有 dirty card——内含 `CardsPerRegion` 个 bit 的位图（4MB Region = 8192 bit = **1024 字节**），精确记录"对方 Region 的哪些 card 引用了我的对象"。Fine 表按需创建。

Fine 表的寻址结构是一个**永久分配的指针数组** `_fine_grain_regions[]`，长度 `_max_fine_entries`（下面会算）。所有 Fine 表通过哈希函数映射到这个数组——数组本身每个槽 8 字节（存一个 `PerRegionTable*`），不管是否装了真正的表。

**第 3 层 — Coarse BitMap（粗糙）**：

一个永久存在的位图。`max_regions()` 个 bit（2048 bit = **256 字节**）。bit[N] = 1 表示 "Region N 可能引用了我"——没有 card 级精度，全 Region 级的脏标记。Fine 装不下了就从这里降级。

### 3.4 setup_remset_size 设置的参数——带具体数值

源码里的两个基数来自 `g1_globals.hpp`：

```cpp
G1RSetSparseRegionEntriesBase = 4     // 稀疏表基数（每条 1MB Region 对应 4 条）
G1RSetRegionEntriesBase       = 256   // 精细表基数
```

`setup_remset_size`（`heapRegionRemSet.cpp:630-642`）用 `base × (log₂(4M/1M) + 1)` = `base × 3`：

```
G1RSetSparseRegionEntries = 4 × 3 = 12      // Sparse 最多容纳 12 条引用方
G1RSetRegionEntries       = 256 × 3 = 768   // Fine 表数量上限 768
```

`_max_fine_entries`（Fine 指针数组的实际长度）在 `OtherRegionsTable` 构造函数里推算（`heapRegionRemSet.cpp:255-256`）：

```
_max_fine_entries = 1 << log₂(768) = 1024   // 向上取整到 2 的幂
```

### 3.5 升级路径

```
写屏障通知："Region A 的 card 37 被写，ref 指向 Region B"

Region B 的 RSet:
  ├─ Sparse 里有 Region A 的条目 → 追加 card 37
  │    ├─ Region A 条目没溢出 → 完成
  │    └─ Region A 的 card 列表太长 → 升级
  │         └─ new PerRegionTable(Region A) → 挂到 Fine 数组里
  │              ├─ Fine 表数量 ≤ 768 → 完成
  │              └─ Fine 表数量 > 768 → 降级
  │                   └─ 挑一个 PerRegionTable 删掉
  │                       Coarse bit[该Region] = 1
  │
  └─ Sparse 里没有 Region A 的条目 → 新增
       ├─ Sparse 条目 < 12 → 插入
       └─ Sparse 条目 ≥ 12 → 哈希表扩容（桶数翻倍）
```

### 3.6 内存开销（4MB Region、8GB 堆、2048 个 Region）

| 层级 | 每 Region 固定占用 | 每 Region 动态占用 | 全堆固定合计 |
|------|-------------------|-------------------|-------------|
| Coarse | 256 字节 | 无 | 512KB |
| Sparse | ~512 字节（初始 16 桶） | 扩容时翻倍 | ~1MB |
| Fine 指针数组 | 1024 × 8 = **8KB** | 无 | **16MB** |
| Fine 实表 | 无 | 每个引用方 1024 字节 | 随引用增多动态增长 |

一个 Region 的基础开销 = 256 + 512 + 8192 ≈ **8.8KB**。Fine 指针数组（8KB）占了 90%。后续 RSet 专题文章会深入解释这个设计为什么值——用 16MB 全堆开销换来 young GC 时不需要扫整个堆。

> **说明**：这里只讲 RSet 的容量参数初设——两个上限值跟着 Region 大小推算。三层结构的完整推演链（Sparse 怎么扩容 → Fine 怎么分配 → Coarse 降级的触发条件 → 写屏障怎么通知 RSet → ConcurrentRefinement 怎么清理 dirty card）会在后续的 RSet 专题文章中单独讲解。本文你只需要知道"上限怎么算的"和"三层的大致分工"。

---

## 4. initialize_all 设置的参数

Region 大小确定之后，`create_heap_with_policy` 接着调用 `policy->initialize_all()`。它做三件事：

### 4.1 initialize_alignments：抄 GrainBytes 作为对齐基准

```cpp
/* === g1CollectorPolicy.cpp:52-57 === */
_space_alignment = HeapRegion::GrainBytes;                            // = 4MB
_heap_alignment  = MAX3(card_table_alignment, _space_alignment, page_size);  // = MAX3(?, 4MB, 4KB) = 4MB
```

`_space_alignment` 直接抄 `GrainBytes`——G1 的空间分配自然以 Region 为粒度对齐。`_heap_alignment` 取三个约束的最大值，在 8GB 堆下结果就是 4MB。

### 4.2 initialize_flags：把堆大小对齐到 Region 大小

上一节有一个循环依赖还没解决：Region 大小是用**未对齐**的堆大小算的，但堆大小现在必须**对齐到** Region 大小。`initialize_flags` 做的就是这个：

```
_initial_heap_byte_size = align_up(InitialHeapSize, _heap_alignment)  // 8G → 对齐到 4MB 边界
_max_heap_byte_size     = align_up(MaxHeapSize, _heap_alignment)
_min_heap_byte_size     = align_up(_min_heap_byte_size, _heap_alignment)
```

以 `-Xms8G -Xmx8G` 为例，8G 本来就是 4MB 的倍数（8G = 2048 × 4MB），对齐后不变。如果用户设了 `-Xms2576M`（不是 4MB 倍数），则向上取整到 2576M 的下一个 4MB 整数倍。`FLAG_SET_ERGO` 把这个对齐后的值写回 `InitialHeapSize`/`MaxHeapSize` flag——后续代码读 flag 拿到的就是对过齐的值。

62 行代码里的其他内容（校验最小值、冲突解决）不在主路径上——生产环境不会设 `-Xms128K -Xmx64K`，这些 if 只是出错时的安全网。

### 4.3 initialize_size_info：打日志

5 行代码，`log_debug(gc, heap)` 输出对齐后的大小。用 `-Xlog:gc+heap=debug` 可以看到。

---

## 5. 完成时的状态——ch11/03 的起点

两段执行完毕后，以下参数全部就位（8GB 堆为例）：

| 参数 | 值 | 用途 |
|------|-----|------|
| `GrainBytes` | 4194304 (4MB) | Region 字节数——后续所有 Region 级操作的基础 |
| `GrainWords` | 524288 | = GrainBytes / 8 |
| `LogOfHRGrainBytes` | 22 | 位移操作 |
| `CardsPerRegion` | 8192 | 每个 Region 对应的 card 数 |
| `G1RSetSparseRegionEntries` | 12 | RSet 稀疏表容量上限 |
| `G1RSetRegionEntries` | 768 | RSet 精细表容量上限 |
| `_space_alignment` | 4MB | = GrainBytes |
| `_heap_alignment` | 4MB | 堆对齐粒度 |
| `_initial_heap_byte_size` | 8GB | 初始堆，已对齐 |
| `_max_heap_byte_size` | 8GB | 最大堆，已对齐 |

下一步：`create_heap_with_policy` 的第三步——`new G1CollectedHeap(policy)`，92 行构造函数。ch11/03 从 `G1CollectedHeap` 的 23 个字段初始化开始。
