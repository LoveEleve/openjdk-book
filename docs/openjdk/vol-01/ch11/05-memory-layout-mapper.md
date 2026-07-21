# G1 initialize() 上半段：reserve + 写屏障 + 6 Mapper + HRM

> **本文定位**：`G1CollectedHeap::initialize()` 前半段（`g1CollectedHeap.cpp:1569-1629`）。跟着执行流走：reserve_heap → CardTable/BarrierSet/HotCardCache → 6 Mapper → HRM.initialize。
>
> **前置依赖**：[ch11/03](03-reservedspace-mmap.md)（reserve_heap 的 mmap 机制）、[ch11/04](04-heap-policy-construction.md)（create_heap 创建 G1CollectedHeap 对象）。

---

## 1. 执行位置

`G1CollectedHeap::initialize()`（`g1CollectedHeap.cpp:1533`）是 `create_heap` 之后的第一个真正初始化调用。简化后（删除校验和 assert）：

```cpp
jint G1CollectedHeap::initialize() {
  // 1. reserve_heap（ch11/03 已讲）
  ReservedSpace heap_rs = Universe::reserve_heap(max_byte_size, heap_alignment);

  // 2. 写屏障基础设施（本文 2 节）
  G1CardTable* ct = new G1CardTable(reserved_region());
  G1BarrierSet* bs = new G1BarrierSet(ct);
  _hot_card_cache = new G1HotCardCache(this);

  // 3. 6 个 Mapper（本文 3 节）
  G1RegionToSpaceMapper* heap_storage = G1RegionToSpaceMapper::create_mapper(g1_rs, ...);
  G1RegionToSpaceMapper* bot_storage = create_aux_memory_mapper("Block Offset Table", ...);
  // ... cardtable / card_counts / prev_bitmap / next_bitmap

  // 4. HRM.initialize（本文 4 节）
  _hrm.initialize(heap_storage, prev_bitmap_storage, ...);

  // ... 后续步骤在 ch11/06-12 讲
}
```

---

## 2. reserve_heap——ch11/03 已讲

```cpp
ReservedSpace heap_rs = Universe::reserve_heap(max_byte_size, heap_alignment);
// max_byte_size = 8GB（-Xmx，生产环境 -Xms=-Xmx）
```

`reserve_heap` 的完整机制（mmap PROT_NONE + MAP_NORESERVE + 压缩指针基址选择）在 [ch11/03](03-reservedspace-mmap.md) 已详细讲解。这里只需要知道结果：

- `heap_rs` 是一段**已 reserve 但未 commit** 的 8GB 虚拟地址空间——地址不可读写，没有物理页
- `heap_rs.base()` 是堆基址，`heap_rs.size()` = 8GB
- 本文假设 `-Xms=-Xmx=8GB`（生产环境标准实践），Region 大小 4MB（`average_heap_size / 2048`，源码 `heapRegion.cpp:63-75`）→ 8GB / 4MB = 2048 个 Region——后续所有数值示例基于这两个参数

**本文从 reserve 完之后开始**——讲 `heap_rs` 拿到手之后，`initialize()` 接下来做什么。

---

## 3. 写屏障基础设施——CardTable + BarrierSet + HotCardCache

reserve 完之后，`initialize()` 立刻创建写屏障三件套（`g1CollectedHeap.cpp:1575-1584`）：

```cpp
G1CardTable* ct = new G1CardTable(reserved_region());
ct->initialize();
G1BarrierSet* bs = new G1BarrierSet(ct);
bs->initialize();
BarrierSet::set_barrier_set(bs);    // 全局安装
_card_table = ct;
_hot_card_cache = new G1HotCardCache(this);
```

**`ct->initialize()` 做了什么**（`cardTable.cpp:80-128`）：
1. mmap reserve 卡表数组——`ReservedSpace heap_rs(_byte_map_size)` 分配 16MB 卡表内存
2. 设置 `_byte_map` 指向 reserve 出来的数组基址
3. **设置偏置基址**——`_byte_map_base = _byte_map - (heap_base >> card_shift)`，这就是前文讲的偏置数组技巧的实现位置
4. 设置 guard card（边界保护，防止越界访问）

**`bs->initialize()` 做了什么**（`cardTableBarrierSet.cpp:73-75`）——只调了 `initialize_deferred_card_mark_barriers()`，初始化延迟卡标记屏障。内容很少。

### 3.1 G1CardTable——卡表

**为什么需要卡表**——G1 回收 Region 时，需要知道"堆里哪些区域的引用关系变了"。如果不知道，要么每次 GC 全堆扫描找变更（太慢），要么每次写引用都立即做完整记录（太重）。

卡表的方案是**把记录分两步**：

```
A.field = B
  ↓ 写后屏障
卡表标 A 所在的 card 为 dirty（1 字节写入，O(1)）    ← mutator 只做这步，极快
  ↓ 后台线程（ConcurrentRefine）消费 dirty card
扫描 dirty card 里的引用 → 做完整记录                ← 异步，不阻塞 mutator
```

卡表是 mutator 和后台处理之间的**缓冲层**——写屏障只标 1 字节（轻），完整记录交给后台线程异步做。后台线程怎么处理这些 dirty card → ch11/06（RemSet）和 ch11/08（Refinement）详讲。

卡表把堆按 512B 切分，每 512B 对应 1 字节（card）。8GB 堆 → 16MB 卡表。

**类结构**（`g1CardTable.hpp:47`，继承 `CardTable`）：

```cpp
class G1CardTable: public CardTable {
  G1CardTableChangedListener _listener;    // on_commit 回调——新 Region commit 时批量标 young
  // ↓ 继承自 CardTable（cardTable.hpp:44-47）
  jbyte* _byte_map;        // 卡表字节数组（实际存卡值）
  jbyte* _byte_map_base;   // 基址指针（地址→card 快速计算用）
  // card_shift = 9（cardTable.hpp:231）→ card_size = 1 << 9 = 512 字节
};
```

新增卡值 `g1_young_gen`。**为什么需要这个值**——young region 在下次 GC 时会被整体回收（复制走），不需要追踪它的引用变更。所以写后屏障遇到 `g1_young_gen` 卡时直接跳过，不标 dirty，省掉无用的入队和 refine 开销。

完整卡值（`cardTable.hpp:97-106` + `g1CardTable.hpp:53-54`）：

| 卡值 | 数值 | 来源 | 含义 | 写后屏障遇到时 |
|---|---|---|---|---|
| `clean_card` | -1 | CardTable | 没有引用变更 | 标 dirty + 入队 |
| `dirty_card` | 0 | CardTable | 有引用变更（已标记） | 跳过（已入过队） |
| `precleaned_card` | 1 | CardTable | 预清理过（**CMS 遗留，G1 不使用**） | 标 dirty + 入队（当普通卡处理） |
| `claimed_card` | 2 | CardTable | GC 期间已认领 | 标 dirty + 入队 |
| `deferred_card` | 4 | CardTable | GC 期间延迟处理 | 标 dirty + 入队 |
| `last_card` | 8 | CardTable | 边界值（不应出现） | — |
| `CT_MR_BS_last_reserved` | 16 | CardTable | 保留值（子类在此基础上新增） | — |
| `g1_young_gen` | 32 | **G1CardTable 新增** | 属于 young region | **跳过**（young region 整体回收，不需要追踪） |

写后屏障的逻辑（`g1BarrierSet.inline.hpp:50-54`）：不是 `g1_young_gen` → 走 slow path → 不是 `dirty` → 标 dirty + 入队。即只有 `g1_young_gen` 和 `dirty` 两种卡值会跳过。

**G1 实际只需要关注 3 个卡值**（其余继承自 CardTable 但 G1 不直接使用）：

**`clean_card`（-1）——初始状态**
- Region commit 时，对应的 card 全部初始化为 clean
- 含义：这块 512B 区域没有引用变更
- 写后屏障遇到：标 dirty + 入队（开始追踪变更）

**`dirty_card`（0）——已标记变更**
- 写后屏障把 clean 改成 dirty，表示"这里有引用写操作"
- 含义：这块 512B 区域有引用变更，需要 refine 线程处理
- 写后屏障遇到：跳过（已经标过 dirty + 入过队，不重复入队）
- refine 线程处理完后改回 clean

**`g1_young_gen`（32）——young region 专用**
- Region 变成 young 角色时，对应的 card 全部标为 g1_young_gen（`g1_mark_as_young`）
- **为什么 young region 不需要追踪引用变更**——GC 回收 young region 时会**扫描里面每一个对象**（检查存活状态，存活的复制到 survivor）。既然每个对象都要扫，就不需要卡表来告诉 GC"哪里有引用变更"——反正全扫。
- **对比 old region**——GC 回收 old region 时**不全扫**，只扫 dirty card 标记的区域（大部分 old region 对象是存活的，全扫太慢）。所以 old region 需要卡表追踪"哪里有变更"，young region 不需要。
- 写后屏障遇到 `g1_young_gen`：**跳过**（不标 dirty，不入队）——省掉无用的 refine 开销
- Region 从 young 变成 old 时，card 改回 clean（开始追踪变更）

**卡值转换流程**：
```
Region commit → card=clean
  ↓ mutator 写引用（写后屏障）
  card=dirty → refine 线程处理 → card=clean（循环）
  ↓ Region 变成 young
  card=g1_young_gen（写后屏障跳过）
  ↓ GC 回收 young region 后 Region 变成 old
  card=clean（重新开始追踪）
```

**GC 疏散暂停期间额外使用 2 个卡值**（非写屏障路径，GC worker 内部协调用）：

dirty card 有两条处理路径——并发期间由 ConcurrentRefine 线程处理（`refine_card_concurrently`），GC 暂停期间由 GC worker 线程处理（`refine_card_during_gc`）。claimed/deferred 只在 GC 暂停路径用。

**`claimed_card`（2）——已认领**
- GC 疏散暂停期间，多个 GC worker 并行处理 dirty card。`set_card_claimed` 标记"这张卡已被某个 GC worker 认领"，`is_card_claimed` 检查是否已被认领——防止多线程重复处理同一张卡（`g1RemSet.cpp:329,369`）

**`deferred_card`（4）——延迟处理**
- 疏散失败（evac failure）时，`mark_card_deferred` 标记"这张卡暂时跳过，延迟处理"（`g1EvacFailure.cpp:66`）。只能在 clean 或 claimed 状态上设置。`mark_card_deferred` 是 wait-free（不 spin），失败只是导致 update buffer 里出现重复条目——不值得争用（`g1CardTable.hpp:73-77` 注释）

**地址→card 的计算**（`byte_for(p)` at `cardTable.hpp:153-158`）：

```cpp
jbyte* byte_for(const void* p) const {
    return &_byte_map_base[uintptr_t(p) >> card_shift];  // 地址 >> 9 = 除以 512
}
```

**具体例子**——假设堆基址 `0x40000000`，对象 A 在堆偏移 512B 处（绝对地址 `0x40000200`，card 1 的起始）：

```
堆偏移:    0B            512B           1024B
           ├─ card 0 ─┤ ├─ card 1 ─┤  ├─ card 2 ─┤
           0~512          512~1024       1024~1536
                              ↑
                         对象 A (512B)
```

**`_byte_map_base` 是什么——偏置数组技巧**

问题：给定堆地址 `p`，要查 `_byte_map[(p - heap_base) / 512]`——需要**减法 + 除法**两次运算。写屏障是每次引用写都执行的热路径，少一条指令都有意义。

偏置数组的解法——预计算一个"假基址"，把减法吸收掉：

```
bias = heap_base / 512 = 0x40000000 / 512 = 0x200000（个元素）
_byte_map_base = _byte_map - bias           // 假基址，在真基址前面

访问时:
  byte_for(p) = &_byte_map_base[p >> 9]     // 只需要右移（除法），不需要减法
```

数值验证（对象 A 在 `0x40000200`）：

```
普通方法（需要减法）:
  index = (0x40000200 - 0x40000000) / 512 = 0x200 / 512 = 1
  result = _byte_map[1]

偏置方法（不需要减法）:
  biased_index = 0x40000200 >> 9 = 0x200001
  result = _byte_map_base[0x200001]
         = *(_byte_map - 0x200000 + 0x200001)    // 指针运算
         = *(_byte_map + 1)
         = _byte_map[1]                          // 结果一样，但省掉了减法
```

**代价**——`_byte_map_base` 到 `_byte_map` 之间有一段"浪费"的内存（`bias` 个元素，不能用），但换来热路径上少一次减法。

**JVM 内部多处使用这个技巧**（`G1BiasedMappedArray` 基类，`g1BiasedArray.hpp:39-61`）：

| 数据结构 | 偏置基址 | 访问方式 | 用途 |
|---|---|---|---|
| CardTable | `_byte_map_base` | `_byte_map_base[addr >> 9]` | 地址→card 字节 |
| G1HeapRegionTable | `_biased_base` | `_biased_base[addr >> RegionShift]` | 地址→HeapRegion* |
| InCSetStateFastTest | `_biased_base` | `_biased_base[addr >> RegionShift]` | 地址→是否在 CSet |
| HumongousReclaimCandidates | `_biased_base` | `_biased_base[addr >> RegionShift]` | 地址→是否可回收 |
| BlockOffsetTable | `_offset_array` | 类似偏置 | 地址→BOT entry |

所有"地址→数组元素"的查表都用这个技巧——预计算偏置基址，运行时只右移 + 索引，不减法。

G1CardTable 继承自 `CardTable`，新增一个卡值 `g1_young_gen`。**为什么需要这个值**——young region 在下次 GC 时会被整体回收（复制走），不需要追踪它的引用变更。所以写后屏障遇到 `g1_young_gen` 卡时直接跳过，不标 dirty，省掉无用的入队和 refine 开销。

卡值状态：

| 卡值 | 含义 | 写后屏障遇到时 |
|---|---|---|
| `clean` | 没有引用变更 | 标 dirty + 入队 |
| `dirty` | 已有引用变更（已标记过） | 跳过（已入过队） |
| `g1_young_gen` | 属于 young region | **跳过**（young region 整体回收，不需要追踪） |
| `claimed` / `deferred` | GC 期间的防重复处理标记 | GC 内部用，非写屏障路径 |

### 3.2 G1BarrierSet——写前 + 写后双屏障

**为什么需要双屏障**——G1 有两个不同的需求要在引用写操作时插入钩子，各解决一个问题：

#### 写前屏障（SATB）——解决并发标记的漏标问题

**场景**：并发标记期间，GC 正在标记存活对象，mutator 同时在跑。假设：
```
标记开始时的状态:  A.field = B    （A 引用 B）
GC 已标记 A，还没标记 B
此时 mutator 执行: A.field = C    （A 改成引用 C）
GC 继续从 A 出发标记 → 只看到 C，看不到 B
如果没有其他引用指向 B → B 被误判死亡，被回收
但 B 在标记开始时是存活的 → 漏标！
```

**SATB 的解法**——写前屏障在覆盖 `A.field` 之前，把旧值 B 存入 SATB 队列：
```
写前屏障: 读 A.field 旧值 = B → enqueue(B) 到 SATB 队列
写入新值: A.field = C
GC 后续处理 SATB 队列 → 标记 B（当作"标记开始时存活"）→ B 不会被漏标
```

**为什么只在并发标记期间激活**——非标记期间没有并发标记在跑，没有"漏标"风险。所以 SATB 队列只在标记期间激活（`set_active_all_threads(true)`），减少非标记期间的开销。

#### 写后屏障（dirty card）——解决跨 Region 引用追踪问题

**场景**：对象 A 在 Region 0，对象 B 在 Region 5。`A.field = B` 产生了新的跨 Region 引用。

**问题**——GC 回收 Region 5 时，需要知道"谁引用了 Region 5 的对象"（否则可能回收了还有引用的对象）。但每次写引用都立即记录太重，怎么办？

**解法**——写后屏障只标 dirty（1 字节，O(1)），后台线程异步处理：
```
写后屏障: A.field = C 后 → 把 A 所在的 card 标 dirty（1 字节写入，极快）
后台线程（ConcurrentRefine）: 消费 dirty card → 扫描里面的引用 → 记录跨 Region 引用关系
```

**为什么始终开启**——跨 Region 引用随时在变（不像 SATB 只在标记期间有风险），所以 dirty card 队列始终开启，没有"激活/关闭"开关。

#### 两个屏障的对比

| | 写前屏障（SATB） | 写后屏障（dirty card） |
|---|---|---|
| 解决什么问题 | 并发标记漏标 | 跨 Region 引用追踪 |
| 做什么 | 存旧值到 SATB 队列 | 标 card dirty + 入 DCQ |
| 什么时候激活 | **仅并发标记期间** | **始终开启** |
| 谁消费队列 | CM 线程（remark 时 drain） | ConcurrentRefine 线程（后台持续消费） |
| 不做会怎样 | 存活对象被误回收（正确性问题） | RSet 过时，GC 漏扫引用（正确性问题） |

两个屏障各解决一个不同的正确性问题——缺了任何一个，G1 都会出错。

两个屏障各解决一个不同问题——SATB 保标记正确性(没有漏标)，dirty card 保 RSet 时效性。

**类结构**（`g1BarrierSet.hpp:39`，继承链 `G1BarrierSet → CardTableBarrierSet → ModRefBarrierSet → BarrierSet`）：

```cpp
class G1BarrierSet: public CardTableBarrierSet {
  static SATBMarkQueueSet  _satb_mark_queue_set;   // SATB 队列集（并发标记期间用）
  static DirtyCardQueueSet _dirty_card_queue_set;  // 脏卡队列集（始终开启）
  // 核心方法:
  //   write_ref_field_pre(field)   —— 写前屏障（SATB 快照）
  //   write_ref_field_post(field)  —— 写后屏障（dirty card 标记）
};
```

两个队列集都是 `static`——全局唯一。但写屏障不是直接写全局队列（会争用），而是用**两级结构**：

```
全局 QueueSet（static，全局唯一）
  ├── 管理 completed buffer 链表（已满的 buffer 队列）
  ├── 管理 free list（空闲 buffer 复用）
  └── 设置阈值（buffer 满了什么时候提交）

每个 Java 线程（G1ThreadLocalData）
  ├── _satb_mark_queue（本地 SATB 队列，无锁写入）
  └── _dirty_card_queue（本地脏卡队列，无锁写入）
```

**写屏障的完整流程**：
```
写前屏障: 读旧值 → 写入当前线程的 _satb_mark_queue（无锁，快）
          队列满 → 提交到全局 _satb_mark_queue_set 的 completed buffer 链表
          CM 线程 remark 时消费 completed buffer

写后屏障: byte_for(field) 算出 card → 标 *byte=dirty → card 指针写入当前线程的 _dirty_card_queue（无锁，快）
          队列满 → 提交到全局 _dirty_card_queue_set 的 completed buffer 链表
          ConcurrentRefine 线程持续消费 completed buffer
```

**为什么两级**——写屏障是每次引用写都执行的热路径，直接写全局队列需要加锁（争用）。thread-local 队列无锁写入（快），满了才提交到全局（一次锁）。全局 QueueSet 协调后台线程消费。

**写后屏障的完整步骤**（`g1BarrierSet.inline.hpp:48-55` + `g1BarrierSet.cpp:99-114`）：
1. `byte = _card_table->byte_for(field)` —— 算 field 对应的 card 地址
2. 如果 `*byte == g1_young_gen` → 跳过（young region 不需要追踪）
3. 否则走 `write_ref_field_post_slow`：
   - `OrderAccess::storeload()` —— 内存屏障
   - 如果 `*byte != dirty` → **`*byte = dirty`**（标 dirty）
   - `enqueue(byte)` —— card 指针入 DirtyCardQueue
4. 如果已经是 dirty → 跳过（不重复入队）

QueueSet 的详细机制（completed buffer 管理 / free list / 阈值激活 / 3 区模型）在 ch11/08 展开。

G1BarrierSet 在每次引用写操作时触发两个屏障。

**写前屏障 `write_ref_field_pre`**（`g1BarrierSet.inline.hpp:36-46`）——SATB 快照逻辑：

```
1. 读 field 的当前值（旧值）
2. 如果 SATB 未激活（非标记期间）→ 跳过
3. 如果旧值非 null → enqueue(旧值) 到 SATB 队列
   - Java 线程 → thread-local SATB 队列
   - 非 Java 线程 → shared SATB 队列（持 Shared_SATB_Q_lock）
```

**写后屏障 `write_ref_field_post`**（`g1BarrierSet.inline.hpp:48-55` + `g1BarrierSet.cpp:99-114`）——dirty card 标记：

```
1. byte = _card_table->byte_for(field) —— 算 field 对应的 card 地址
2. 如果 *byte == g1_young_card_val → 跳过（young region 不需要 dirty）
3. 否则走 write_ref_field_post_slow：
   a. OrderAccess::storeload() —— 内存屏障
   b. 如果 *byte != dirty_card_val → 标 *byte = dirty
   c. enqueue(byte) 到 DirtyCardQueue
      - Java 线程 → thread-local DCQ
      - 非 Java 线程 → shared DCQ（持 Shared_DirtyCardQ_lock）
```

**具体例子**——假设并发标记期间（SATB 激活），对象 A 的 field 从指向 B 改成指向 C：

```
写前屏障:
  读 A.field 旧值 = B
  B != null → enqueue(B) 到当前线程的 SATB 队列
  （保证 B 不会被漏标——即使 A.field 不再指向 B，B 仍在快照中存活）

写入新值:
  A.field = C

写后屏障:
  byte = byte_for(&A.field) —— 算出 A.field 地址对应的 card
  *byte != g1_young_gen → 走 slow path
  *byte != dirty → *byte = dirty
  enqueue(byte) 到当前线程的 DirtyCardQueue
  （ConcurrentRefine 线程会消费这张脏卡，更新 C 所在 Region 的 RSet）
```

两个屏障各有独立队列集：
- `_satb_mark_queue_set`——SATB 队列（并发标记期间激活，`set_active_all_threads`）
- `_dirty_card_queue_set`——脏卡队列（始终开启）

每个 Java 线程通过 `G1ThreadLocalData` 持有两个 thread-local 队列，避免争用。

### 3.3 G1HotCardCache——热卡缓存

**为什么需要热卡缓存**——问题出在 ConcurrentRefine 线程和 mutator 的竞争循环：

**场景**：循环里频繁更新同一字段 `for (int i = 0; i < 1000; i++) { obj.field = new Value(i); }`，obj 在某张卡里。

**没有 HotCardCache 时的循环**：
```
mutator 第 1 次写: 标 card=dirty → 入 DCQ
ConcurrentRefine 线程: 取出 card → 扫描引用 → 更新 RSet → 改回 card=clean

mutator 第 2 次写: card 已是 clean → 标 dirty → 入 DCQ
ConcurrentRefine 线程: 又取出 card → 又扫描引用 → 又更新 RSet → 又改回 clean

... 重复 1000 次
```

每次 refine 都要扫描卡里的对象、遍历引用、更新 RSet——但 obj.field 指向的对象每次不同，扫描和更新 RSet 的工作量差不多，**重复劳动**。ConcurrentRefine 线程被这张热卡占满，没空处理其他卡。

**有 HotCardCache 时的流程**——HotCardCache 不在写后屏障里，而在 ConcurrentRefine 线程消费 DCQ 时起作用（`refine_card_concurrently` → `HotCardCache.insert`，`g1RemSet.cpp:591`）：

```
写后屏障: 标 card=dirty → enqueue 到 thread-local DCQ（不经过 HotCardCache）
  ↓ DCQ 满了 → 提交到全局 DCQS
ConcurrentRefine 线程: 从 DCQS 取出 card → refine_card_concurrently(card)
  → HotCardCache.insert(card)    ← 在这里才查 HotCardCache
     - 不热 → 返回 card → 继续处理（扫描引用、更新 RSet、改回 clean）
     - 热 → 缓存到环形数组 → 返回 NULL → 跳过处理
```

**计数是 refine 次数，不是写次数**——每次 ConcurrentRefine 线程处理这张卡时，`add_card_count` 计数+1：

```
第 1 次 refine: 计数 0→1, is_hot(0)=false → 正常处理
第 2 次 refine: 计数 1→2, is_hot(1)=false → 正常处理
第 3 次 refine: 计数 2→3, is_hot(2)=false → 正常处理
第 4 次 refine: 计数 3→4, is_hot(3)=false → 正常处理
第 5 次 refine: 计数=4(上限), is_hot(4)=true → 缓存到 HotCardCache，跳过
后续 refine: 卡已在缓存 → 继续跳过
GC 期间 drain: 排空缓存 → 只做一次 refine
```

**效果**——同一张卡被反复 dirty/refine/clean 循环时，前 4 次正常 refine，第 5 次起被缓存跳过，GC 期间统一处理一次。避免 refine 线程被热卡占满。

**类结构**（`g1HotCardCache.hpp:56`）：

```cpp
class G1HotCardCache: public CHeapObj<mtGC> {
  G1CollectedHeap* _g1h;
  bool             _use_cache;        // 是否启用缓存
  G1CardCounts     _card_counts;      // 卡计数器（每 512B 一个 jubyte 计数）
  jbyte**          _hot_cache;        // 环形数组（jbyte* 指针数组）
  size_t           _hot_cache_size;   // = 1 << G1ConcRSLogCacheSize = 1024
  volatile size_t  _hot_cache_idx;    // 原子递增索引（Atomic::add 分配 slot）
  // 热阈值: G1ConcRSHotCardLimit = 4（g1_globals.hpp:158）
};
```

**insert 流程**（`g1HotCardCache.cpp:59-81`）：

```
insert(card_ptr):
  1. count = _card_counts.add_card_count(card_ptr) —— 计数+1，返回递增前的计数
  2. if (!is_hot(count)) → 返回 card_ptr（不热，给 refine 线程立即处理）
  3. 热 → 原子递增 _hot_cache_idx → mask 到环形数组 → CAS 替换 slot
  4. CAS 成功 → 返回被驱逐的旧卡（可能 NULL）
  5. CAS 失败 → 返回 card_ptr（没存进去，立即 refine）
```

`is_hot(count)` = `count >= G1ConcRSHotCardLimit`（`g1CardCounts.cpp:108-110`）

**具体例子**——同一张卡被写 5 次（`G1ConcRSHotCardLimit=4`）：

```
第 1 次写: count=0(返回0), 递增到 1, is_hot(0)=false → 立即 refine
第 2 次写: count=1(返回1), 递增到 2, is_hot(1)=false → 立即 refine
第 3 次写: count=2(返回2), 递增到 3, is_hot(2)=false → 立即 refine
第 4 次写: count=3(返回3), 递增到 4, is_hot(3)=false → 立即 refine
第 5 次写: count=4(返回4, 已达上限不递增), is_hot(4)=true → 存入 _hot_cache 环形数组
  → 如果 slot 原来有旧卡 → 返回旧卡给 refine
  → 如果 slot 原来是空 → 返回 NULL（不需要立即 refine）
```

**设计意图**——前 4 次 refine 是"值得做的"（卡可能有新引用），第 5 次说明这张卡"太热了"（可能循环里反复写同一字段），延迟到 GC 期间 `drain()` 一起处理，避免 refine 线程被热卡占满。

GC 期间 `drain()` 排空缓存（`g1HotCardCache.cpp:83`）——多个 worker 并行 claim chunk 处理。

---

## 4. 6 份关联内存——6 个 Mapper

写屏障创建完后，`initialize()` 把 `heap_rs` 切分成 6 份独立的虚拟地址空间（`g1CollectedHeap.cpp:1587-1624`）。

### 4.1 一个 Region 背后有 6 份内存

G1 的每个 Region 不只是"一段堆内存"——它还关联了 5 种元数据。这 6 份是 **6 块独立的虚拟地址空间**（各自 mmap reserve，见 `create_aux_memory_mapper` at `g1CollectedHeap.cpp:1494`）。

关键区分——**数据粒度** vs **commit 粒度**：

| Mapper | 数据粒度 | 大小比例 | 8GB 堆实际大小 | 为什么需要 |
|---|---|---|---|---|
| **heap_storage** | 对象实例 | 1:1 | 8GB | 管理堆地址空间的 Region 级 commit/uncommit |
| **bot_storage** | 512B/entry（`u_char`） | 1:512 | **16MB** | GC 扫描时定位"地址属于哪个对象" |
| **cardtable_storage** | 512B/card（1 字节） | 1:512 | **16MB** | 写屏障标记"哪些卡被写了" |
| **card_counts_storage** | 512B/card | 1:512 | **16MB** | 热卡缓存——频繁写的卡优先 refine |
| **prev_bitmap_storage** | 64B/bit（`mark_distance=64`） | 1:512 | **16MB** | 并发标记完成后，存"上一次标记的存活对象" |
| **next_bitmap_storage** | 64B/bit | 1:512 | **16MB** | 并发标记进行中，存"这一轮正在标记的存活对象" |

**为什么都是 1:512**——BOT/CardTable 每 512B 堆 1 字节；Bitmap 每 64B 堆 1 bit = 每 512B 堆 1 字节（8 bit）。512 是多种粒度的公约数。

**每个 Mapper 的作用详解**：

**heap_storage（1:1，8GB）**——管理堆地址空间的 Region 级 commit/uncommit。底层地址空间就是堆本身（从 `heap_rs.first_part()` 切出，不是独立 mmap）。commit 一个 Region → 该 Region 地址可读写（PROT_READ|PROT_WRITE），mutator 可以分配对象；uncommit → 地址不可访问（PROT_NONE），物理页还给 OS。`commit_factor=1` 意味着 1:1 比例——8GB 堆 / 4MB Region = 2048 个 commit bit。对象存在这个地址空间里，但 heap_storage 本身是**管理者**（控制哪些 Region 可用），不是存储容器。

**8GB 堆的四层管理链**——8GB 不是被一个对象管理，而是四层委托：

```
G1CollectedHeap（collectedHeap.hpp:117）
  ├── _reserved（MemRegion）——记住 8GB 地址范围（base + end）
  │   initialize_reserved_region(heap_rs.base(), heap_rs.end())  ← line 1572 设置
  │   对外暴露 reserved_region() / is_in_reserved() / capacity()
  │
  └── _hrm（HeapRegionManager）——Region 生命周期管理
        ├── _heap_mapper（G1RegionToSpaceMapper*）——Region 级 commit/uncommit
        │     └── _storage（G1PageBasedVirtualSpace）——per-page commit/uncommit
        │           └── os::commit_memory / os::uncommit_memory——mmap 系统调用
        ├── _regions（G1HeapRegionTable）——Region 数组（地址→HeapRegion*）
        └── _free_list（FreeRegionList）——空闲 Region 链表
```

| 层 | 对象 | 管什么 | 不管什么 |
|---|---|---|---|
| 顶层 | G1CollectedHeap | 记住 8GB 地址范围（`_reserved`）+ 对外接口 | 不直接 commit/uncommit |
| Region 级 | HeapRegionManager | 哪些 Region 已 commit / 空闲 / 可分配 | 不直接操作 mmap |
| 翻译层 | G1RegionToSpaceMapper | Region index → 页 index 翻译 + `_commit_map` 位图 | 不直接操作 mmap |
| 页级 | G1PageBasedVirtualSpace | per-page commit/uncommit（mmap MAP_FIXED） | — |

G1CollectedHeap 是"顶层入口"（记住地址范围 + 对外接口），HRM 是"Region 管理者"（commit/uncommit 决策 + 空闲链表），heap_storage 是"翻译器"（Region→页），G1PageBasedVirtualSpace 是"执行者"（mmap 系统调用）。

**bot_storage（1:512，16MB）**——Block Offset Table，对象边界索引。GC 扫描时需要知道"给定一个地址，它属于哪个对象"。但堆里对象大小不一，不能直接算。BOT 每 512B 存一个 entry，记录"回退多少能找到对象起始"。详见 ch11/06。

**cardtable_storage（1:512，16MB）**——卡表，写屏障的基础。每 512B 堆对应 1 字节 card，写后屏障标 dirty。详见本文 3.1 节 G1CardTable。

**card_counts_storage（1:512，16MB）**——卡访问计数，热卡缓存的基础。每 512B 堆对应 1 字节计数器，`add_card_count` 递增，`is_hot(count >= 4)` 判热。详见本文 3.3 节 HotCardCache。

**prev_bitmap_storage（1:512，16MB）**——上一轮并发标记的存活位图。每 64B 堆对应 1 bit，bit=1 表示该位置有存活对象。本轮标记完成后，next bitmap swap 成 prev bitmap——GC 回收时用 prev 判断"哪些对象存活"。详见 ch11/07。

**next_bitmap_storage（1:512，16MB）**——本轮并发标记正在写的存活位图。并发标记期间，CMThread 标记存活对象时写这个位图。remark 完成后 swap——next 变成 prev，新的 next 清零等下一轮。详见 ch11/07。

**6 个 Mapper 的协作关系**：
```
mutator 写引用 → cardtable 标 dirty → refine 线程消费
  → 扫描 cardtable 对应区域的对象（用 bot 定位对象边界）
  → 标记存活对象（写 next_bitmap）
  → 统计热度（card_counts）
  → GC 回收时用 prev_bitmap 判断存活
```

以 cardtable 为例——Card Table 数据按 512B 切分（每 512B 堆空间对应 1 字节 card），但 **commit 按 Region 粒度**（一次 commit 一个 Region 对应的所有 card 字节）：

```
heap:           [─────── Region 0 (4MB) ───────][─────── Region 1 (4MB) ───────]
                  对象1    对象2    对象3...       对象4    对象5...

cardtable:      [c][c][c][c][c][c][c][c]...     [c][c][c][c][c][c][c][c]...
                └── 8192 个 card（4MB/512B）──┘  └── 8192 个 card ──┘
                ↑                                 ↑
                commit Region 0 时               commit Region 1 时
                这 8192 字节一起 commit          这 8192 字节一起 commit
```

**关键约束**：commit Region N 时，6 个 Mapper **各自在自己的地址空间里** commit Region N 对应的字节范围（`heapRegionManager.cpp:82-91` 同步调 6 个 Mapper 的 `commit_regions`）。"同步"指 6 个 Mapper 同时 commit，不是 6 份内存共享地址空间。否则 GC 扫描到这个 Region 时会缺数据——比如 heap commit 了但 bitmap 没 commit，标记时读 bitmap 就会崩。

### 4.2 G1RegionToSpaceMapper——Region 级 commit 的翻译器

**为什么需要 Mapper**——G1 的 commit/uncommit 以 Region 为单位（4MB），但 OS 的 commit 以页为单位（4KB）。`G1PageBasedVirtualSpace`（ch11/03 讲过）是页级管理器，不认识"Region"概念。Mapper 在两者之间做翻译——"commit Region 5"翻译成"commit Region 5 对应的那 1024 个页"（4MB/4KB=1024）。每个 Mapper 内部用 `_commit_map` 位图避免重复 commit。

6 份内存各自一个 `G1RegionToSpaceMapper`（`g1RegionToSpaceMapper.hpp:45`）。它的职责是把"Region 级别的 commit 请求"翻译成"页级别的 commit 操作"：

```
调用方: "commit Region 5"
  ↓
G1RegionToSpaceMapper:
  1. 查 _commit_map[5] —— 已经 commit 了？跳过
  2. 算出 Region 5 对应哪些页
  3. 调底层 G1PageBasedVirtualSpace 按页 commit（MAP_FIXED + PROT_READ|PROT_WRITE）
  4. 设 _commit_map[5] = 1
  5. fire_on_commit(5) —— 通知 HRM 等数据结构
```

**"Region→页"翻译的具体例子**——commit Region 5 时，Mapper 怎么算出对应哪些页：

```
参数: Region 大小=4MB, 页大小=4KB
_pages_per_region = 4MB / 4KB = 1024

Region 5 覆盖堆地址 [20MB, 24MB)
对应页 index: 5 * 1024 = 5120 ~ 6143（共 1024 个页）

源码（g1RegionToSpaceMapper.cpp:71-72）:
  start_page = start_idx * _pages_per_region     // 5 * 1024 = 5120
  _storage.commit(start_page, num_regions * _pages_per_region)  // commit 页 5120~6143
    → 对这 1024 个页调 os::commit_memory（mmap MAP_FIXED + PROT_READ|PROT_WRITE）
```

**为什么需要翻译**——OS 的 mmap 系统调用只认页（4KB），不认 Region（4MB）。G1 说"commit Region 5"，OS 听不懂——必须翻译成"commit 页 5120~6143"，OS 才能执行。

核心字段：
- `G1PageBasedVirtualSpace _storage`——底层页级虚拟空间（ch11/03 讲过，每页一个 bit 追踪 commit 状态）
- `CHeapBitMap _commit_map`——Region 级 commit 位图（避免重复 commit）
- `size_t _region_granularity`——Region 粒度（= `HeapRegion::GrainBytes`）

**为什么不直接用 G1PageBasedVirtualSpace**？因为 Region 大小 ≠ 页大小——一个 Region（4MB）通常包含多个页（4KB），Mapper 负责"Region → 页"的翻译。

---

## 5. HeapRegionManager——6 个 Mapper 的协调者

**为什么需要 HRM**——6 个 Mapper 各自独立，但 commit 一个 Region 时必须 6 份同步 commit（否则 GC 扫描缺数据）。HRM 是协调者——对外暴露 `commit_regions(index, num_regions)` 一个接口，内部调 6 个 Mapper 的 `commit_regions`，保证同步。同时管理 Region 的生命周期——哪些 Region 已 commit、哪些空闲可分配、哪些被 CSet 选中。

`HeapRegionManager`（`heapRegionManager.hpp:70`）持有 6 个 Mapper + Region 数组 + 空闲链表：

```cpp
class HeapRegionManager {
  G1HeapRegionTable _regions;          // Region 数组（按 index 索引 HeapRegion*）
  G1RegionToSpaceMapper* _heap_mapper;       // ← 6 个 Mapper
  G1RegionToSpaceMapper* _prev_bitmap_mapper;
  G1RegionToSpaceMapper* _next_bitmap_mapper;
  G1RegionToSpaceMapper* _bot_mapper;
  G1RegionToSpaceMapper* _cardtable_mapper;
  G1RegionToSpaceMapper* _card_counts_mapper;
  FreeRegionList _free_list;           // 空闲 Region 链表
  CHeapBitMap _available_map;          // 位图：哪些 Region 可分配
  uint _num_committed;                 // 已 commit 的 Region 数
};
```

`initialize()`（`g1CollectedHeap.cpp:1626`）把 6 个 Mapper 传给 HRM：

```cpp
_hrm.initialize(heap_storage, prev_bitmap_storage, next_bitmap_storage,
                bot_storage, cardtable_storage, card_counts_storage);
```

**核心操作**：

- `commit_regions(index, num_regions)`——**同时**调 6 个 Mapper 的 `commit_regions`，保证 6 份内存同步 commit
- `uncommit_regions(index, num_regions)`——同时调 6 个 Mapper 的 `uncommit_regions`
- `make_regions_available(index, num_regions)`——commit 后标记 Region 可分配（设 `_available_map` 位 + 加入 `_free_list`）
- `find_contiguous(num, only_empty)`——找连续 N 个空闲 Region（给 humongous 对象用）

**expand**（`g1CollectedHeap.cpp:1337`）在初始化时调用一次——把堆从 0 commit 到 `-Xms` 大小（本文场景 `-Xms=-Xmx=8GB`，一次性 commit 全部 2048 个 Region）。生产环境 `-Xms=-Xmx`，堆固定不扩展，之后不再调 expand：

```
expand(num_regions)
  → HeapRegionManager::commit_regions(start_idx, num_regions)
  → 6 个 Mapper 同步 commit（每个 Mapper commit 对应的 Region 范围）
  → make_regions_available —— 标记可分配 + 加入 free_list
```

---

## 6. trade-off：Region 化的代价

### 6.1 内存开销

每个 Region 关联 5 份辅助元数据，都是 1:512 比例——以 4MB Region 为例，每份 8KB，合计 40KB：

| 元数据 | 每 4MB Region 占用 | 计算方式 |
|---|---|---|
| BOT | 8KB | 4MB / 512 |
| Card Table | 8KB | 4MB / 512 |
| Card Counts | 8KB | 4MB / 512 |
| Prev Bitmap | 8KB | 4MB / 64 / 8（64B/bit） |
| Next Bitmap | 8KB | 4MB / 64 / 8 |
| **辅助元数据合计** | **40KB** | **~1% 开销** |

加上 RSet（每个 Region 一份入引用索引，通常 1%~5%），总元数据开销约 2%~6%。相比连续分代只需一份 card table（~0.2%），G1 的元数据开销大一个数量级——这是 Region 化的主要代价。

### 6.2 和其他 GC 对比

| | Serial/Parallel | CMS | G1 | ZGC |
|---|---|---|---|---|
| 堆布局 | 连续分代 | 连续分代 | **Region** | ZPage（动态大小） |
| 选择性回收 | ❌ | ❌（只能 Full GC 回收 old） | ✅ CSet | ✅ |
| 停顿可控 | ❌ | 部分（并发标记） | ✅ 预测模型 | ✅ 染色指针 |
| 元数据开销 | 低 | 中 | 高（~2-6%） | 中 |

G1 的 Region 化是"用内存换停顿可控"——对于服务端应用（停顿敏感、内存充裕）是合理 trade-off。

---

## 7. 概念链

```
initialize() 前半段：
  reserve_heap（ch11/03）→ heap_rs（已 reserve 未 commit）
  → CardTable + BarrierSet + HotCardCache（写屏障三件套）
    → 写前 SATB + 写后 dirty card + 热卡缓存
  → 6 个 Mapper（6 块独立地址空间，各自 1:512 比例）
    → heap/BOT/cardTable/cardCounts/prevBitmap/nextBitmap
    → G1RegionToSpaceMapper 翻译 Region→页
  → HRM.initialize（协调 6 个 Mapper + Region 数组 + 空闲链表）
  → expand → commit_regions → 6 Mapper 同步 → make_regions_available

数据粒度 vs commit 粒度：card=512B，bitmap=64B/bit，但 commit 统一按 Region
trade-off：2-6% 元数据开销 vs 停顿可控 + 选择性回收 + 内存弹性
```

---

## 8. 程序员影响

- **`-Xms` = `-Xmx`**：避免运行时 expand/shrink 的系统调用开销——G1 默认不 shrink，设一样省心
- **Region 大小**：`-XX:G1HeapRegionSize`——大堆用大 Region（减少 RSet 开销），小堆用小 Region（避免 humongous 对象过多）
- **humongous 对象**：超过 Region 一半的对象直接分配在连续多个 Region——避免频繁分配大数组时产生 humongous Region 碎片
- **写屏障成本**：G1 每次引用写都要过双屏障（SATB + dirty card）——这是 G1 吞吐量低于 Parallel GC 的主要原因
