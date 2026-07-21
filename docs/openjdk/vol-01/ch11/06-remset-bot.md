# G1 跨 Region 引用：RemSet + BOT + CSet 快速测试

> **本文定位**：`G1CollectedHeap::initialize()` 中段（`g1CollectedHeap.cpp:1640-1659`）。跟着执行流走：G1RemSet 创建 → BOT 创建 → CSet 快速测试位图初始化。
>
> **前置依赖**：[ch11/05](05-memory-layout-mapper.md)（CardTable + 写屏障 + 6 Mapper + HRM）。

---

## 1. 执行位置

写屏障和 6 Mapper 创建完后，`initialize()` 创建跨 Region 引用追踪的基础设施（`g1CollectedHeap.cpp:1640-1659`）：

```cpp
// 1. RemSet 创建 + initialize（内部初始化 G1FromCardCache）
_g1_rem_set = new G1RemSet(this, _card_table, _hot_card_cache);
_g1_rem_set->initialize(max_capacity(), max_regions());

// 2. BOT 创建
_bot = new G1BlockOffsetTable(reserved_region(), bot_storage);

// 3. CSet 快速测试位图 + Humongous 回收候选位图
_in_cset_fast_test.initialize(start, end, granularity);
_humongous_reclaim_candidates.initialize(start, end, granularity);
```

---

## 2. G1RemSet——dirty card 的消费者（全局协调器）

### 2.1 G1RemSet vs RSet——两个不同的东西

**先区分两个容易混淆的概念**：

- **G1RemSet**——全局协调器（1 个实例，`_g1_rem_set`）。消费 dirty card，扫描里面的引用，把引用关系**写入目标 Region 的 RSet**。它自己不存储引用关系。
- **RSet（HeapRegionRemSet）**——每个 Region 持有的入引用索引（2048 个实例，每个 Region 一个）。记录"哪些其他 Region 的哪些 card 引用了我"。详见 Section 3。

```
G1RemSet（全局，1 个）
  ├── 消费 dirty card → 扫描引用 → 调 to_region.rem_set().add_reference(from)
  │                                      ↓
  │                              写入目标 Region 的 RSet
  │
  └── 协调 GC 期间的并行扫描（_scan_state）

HeapRegionRemSet（per-Region，2048 个）= RSet
  └── OtherRegionsTable 三层存储（Sparse/Fine/Coarse）
      └── 记录"哪些 card 引用了我"
```

**G1 回收 Region X 时**——扫 Region X 的 RSet（HeapRegionRemSet），找到所有指向它的引用，不用全堆扫描。G1RemSet 是"往 RSet 里写数据"的协调器，不是 RSet 本身。

### 2.2 类结构

```cpp
class G1RemSet : public CHeapObj<mtGC> {
  G1RemSetScanState* _scan_state;      // GC 暂停期间的扫描状态
  G1CollectedHeap*   _g1h;             // 堆引用
  G1CardTable*       _ct;              // 卡表
  G1Policy*          _g1p;             // 策略
  G1HotCardCache*    _hot_card_cache;  // 热卡缓存
  size_t             _num_conc_refined_cards;  // 并发 refined 卡计数（日志用）
};
```

G1RemSet 本身是薄壳——7 个字段，核心逻辑在 `refine_card_concurrently`（G1RemSet 的方法，消费 dirty card）和 `OtherRegionsTable`（HeapRegionRemSet 的内部组件，存储引用，详见 Section 3）。

### 2.3 refine_card_concurrently——7 步消费 dirty card

ConcurrentRefine 线程从 DCQ 取出 dirty card 后，调 `refine_card_concurrently`（`g1RemSet.cpp:539-671`）：

```
步骤 1: 脏检查 —— *card_ptr != dirty？直接返回（已被并发处理）
步骤 2: 定位 Region —— addr_for(card_ptr) → heap_region_containing(addr)
步骤 3: Region 类型过滤 —— 非 old/humongous？返回（young/free 卡丢弃）
步骤 4: HotCardCache 插入 —— insert(card_ptr)
         → 返回 NULL（缓存了）→ 返回
         → 返回原卡（不热）→ 继续
         → 返回旧卡（驱逐）→ 用旧卡继续
步骤 5: trim 到 top —— scan_limit = r->top()，若 <= start 是过期卡 → 返回
步骤 6: 清卡 + fence —— *card_ptr = clean + OrderAccess::fence（保证先清后读 top）
步骤 7: 扫描引用 —— r->oops_on_card_seq_iterate_careful(dirty_region, &cl)
         → closure 内对每个引用调 to->rem_set()->add_reference(from)（详见 Section 3）
         → 更新目标 Region 的 RSet
         → 失败则重新 dirty + 入队
```

**步骤 7 是核心**——扫描 dirty card 里的对象，找到跨 Region 引用，更新目标 Region 的 RSet。

### 2.4 refine_card_during_gc——GC 暂停期间的版本

GC 疏散暂停期间，GC worker 线程调 `refine_card_during_gc`（`g1RemSet.cpp:673`）——和并发版本类似，但：
- 不走 HotCardCache（GC 期间缓存已禁用）
- 走 `_scan_state`（`G1RemSetScanState`）协调多 worker 并行扫描
- 用 `claimed_card` / `deferred_card` 防重复处理（详见 ch11/05 卡值状态）

### 2.5 G1RemSetScanState——GC 期间的并行扫描协调

`G1RemSetScanState`（定义在 `g1RemSet.cpp:55-280`，不是独立头文件）是 GC 暂停期间的扫描状态，协调多个 GC worker 并行扫描 CSet Region 的 RSet：

```cpp
class G1RemSetScanState {
  size_t              _max_regions;          // Region 总数
  G1RemsetIterState*  _iter_states;          // 每个 Region 的扫描状态：Unclaimed/Claimed/Complete
  size_t*             _iter_claims;          // 每个 Region 当前的扫描进度位置
  uint*               _dirty_region_buffer;  // GC 期间累积的脏 Region 列表
  IsDirtyRegionState* _in_dirty_region_buffer; // 去重标记（Clean/Dirty）
  size_t              _cur_dirty_region;     // 脏 Region 计数
  HeapWord**          _scan_top;             // GC 开始时 top 快照——过滤非 old/humongous 区域
};
```

**为什么需要 ScanState**——GC 回收 CSet 时，多个 GC worker 并行扫描 CSet Region 的 RSet。需要协调：
1. **谁扫哪个 Region**——`_iter_states` 三态机：`Unclaimed`(0) → `Claimed`(1) → `Complete`(2)，worker 用 CAS 抢占 Unclaimed 的 Region
2. **扫到哪了**——`_iter_claims` 记录每个 Region 的当前扫描位置，避免重复扫描
3. **哪些 Region 有脏卡**——`_dirty_region_buffer` 累积 GC 期间发现的脏 Region，`_in_dirty_region_buffer` 去重
4. **top 快照**——`_scan_top` 在 GC 开始时快照每个 Region 的 top，过滤"top 以下的卡才需要扫描"（避免扫到 GC 期间新分配的对象）

**扫描流程**：
```
GC 开始: ScanState.reset() —— 所有 Region 重置为 Unclaimed
  ↓
每个 GC worker:
  1. claim_iter(region) —— CAS Unclaimed→Claimed，成功则扫描该 Region
  2. 遍历 Region 的 RSet 里记录的 card（引用方的 card，不是 dirty card）
  3. 对每张 card 调 refine_card_during_gc
  4. set_iter_complete(region) —— CAS Claimed→Complete
  5. 继续找下一个 Unclaimed 的 Region
  ↓
GC 结束: 并发清非 survivor 区域的卡表（G1ClearCardTableTask）
```

---

## 3. OtherRegionsTable——RSet 的三层存储

### 3.1 为什么需要三层

一个 Region 可能被很多其他 Region 引用。引用密度不同时，用不同数据结构存储最省内存：
- **少量引用**——用稀疏表（少量 card index）
- **中等引用**——用细粒度表（一个 Region 一个 BitMap）
- **大量引用**——用粗粒度位图（1 bit 表示"整个 Region 都引用我"）

### 3.2 三层结构

每个 Region 的 RSet（`HeapRegionRemSet`）持有一个 `OtherRegionsTable`（`heapRegionRemSet.hpp:74`），内部三层：

#### Sparse（稀疏）——少量引用时用

```cpp
class SparsePRT {
  RSHashTable* _cur;   // 当前活跃的哈希表
  RSHashTable* _next;  // 双缓冲——_cur 满时切换到 _next（expand），_cur 清空后变为新的 _next
};

class RSHashTable {
  SparsePRTEntry* _entries;  // entry 数组
  int*            _buckets;  // 哈希桶（存 entry index）
  int             _free_list; // 空闲 entry 链表
};

class SparsePRTEntry {
  uint   _region_ind;    // from-Region index
  int    _next_index;    // 哈希桶的下一个 entry
  int    _next_null;     // 当前已存几个 card
  size_t _cards[4];      // 变长数组——默认存 4 个 card_index（G1RSetSparseRegionEntries）
};
```

**特点**——每个 from-Region 最多存 4 个 card index。超过 4 个就放不下了，需要升级到 Fine。省内存（不需要一整个 BitMap），适合"一个 Region 只有零星几个 card 引用我"的场景。

#### Fine（细粒度）——中等引用时用

```cpp
class PerRegionTable : public CHeapObj<mtGC> {
  HeapWord*     _region;     // from-Region 起始地址
  CHeapBitMap   _bm;         // card 位图——每个 bit 对应一张 card
  PerRegionTable* _next;     // 哈希冲突链
  PerRegionTable* _prev;     // 双向链表（用于 bulk free）
  // 全局 free list 复用——避免反复 malloc/free
};
```

OtherRegionsTable 持有：
```cpp
PerRegionTable** _fine_grain_regions;  // 哈希表（桶数 = _max_fine_entries，默认 256）
size_t           _n_fine_entries;      // 当前 Fine 条目数
PerRegionTable*  _first_all_fine_prts; // 双向链表头（用于遍历/evict）
PerRegionTable*  _last_all_fine_prts;  // 双向链表尾
```

**特点**——每个 from-Region 一个 PerRegionTable，内部用 BitMap 存"哪些 card 引用了我"。BitMap 大小 = CardsPerRegion（4MB / 512B = 8192 bit = 1KB）。比 Sparse 精确（能记录任意数量的 card），但每个 PRT 占 1KB。

#### Coarse（粗粒度）——大量引用时退化

```cpp
CHeapBitMap _coarse_map;    // 1 bit = 1 个 from-Region
size_t      _n_coarse_entries;
static jint _n_coarsenings; // 全局 coarsen 次数统计
```

**特点**——1 bit 表示"整个 from-Region 都可能引用我"。最省内存（2048 个 Region 只需 256 字节），但精度最差——扫描时要回扫整个 from-Region（8192 张 card）。

#### 三层对比

| | Sparse | Fine | Coarse |
|---|---|---|---|
| 存储 | 4 个 card_index | BitMap（8192 bit） | 1 bit |
| 每 from-Region 内存 | ~40B | ~1KB | 1 bit |
| 精度 | 精确（但最多 4 个） | 精确（任意数量） | 粗糙（整个 Region） |
| 扫描成本 | 低 | 中 | 高（回扫整个 Region） |
| 什么时候用 | 零星引用 | 正常引用 | Fine 表满后 evict |

### 3.3 add_reference 退化路径

`add_reference(from, tid)`（`heapRegionRemSet.cpp:346-428`）——记录"from 地址引用了本 Region"：

```
步骤 1: 查 G1FromCardCache（per-thread 缓存）→ 命中返回（最热路径，无锁）
步骤 2: 查 _coarse_map → 命中返回（整个 from-Region 已记录）
步骤 3: 查 _fine_grain_regions 哈希表 → 找到 PerRegionTable？
         → 找到：prt->add_reference(from) → 在 PRT 的 card BitMap 置位 → 返回
步骤 4: PRT 没找到 → 尝试 _sparse_table.add_card() → 成功返回
步骤 5: Sparse 满了 → 分配新 PerRegionTable
         → Fine 表满？→ 采样 evict（按 _fine_eviction_stride 步长采样若干 PRT，挑 occupied 最大的 evict 到 Coarse）
         → 把 Sparse entry 的 card 迁移到新 PRT → 删 Sparse entry
步骤 6: prt->add_reference(from) → 在 PRT 的 card BitMap 置位
```

**退化方向**：Sparse → Fine → Coarse。密度越高，数据结构越粗（省内存但损失精度）。Coarse 命中时扫描整个 from-Region（慢但省内存）。

### 3.4 HeapRegionRemSet——RSet 的外层包装

```cpp
class HeapRegionRemSet {
  G1BlockOffsetTable* _bot;           // 指向全局 BOT（G1CollectedHeap._bot），用于定位对象起始
  G1CodeRootSet       _code_roots;    // 存指向本 Region 的 nmethod（JIT 代码引用）
  Mutex               _m;             // 保护并发修改
  OtherRegionsTable   _other_regions; // ← 委托的跨区域引用表
  RemSetState         _state;         // Untracked/Updating/Complete
};
```

- **`_state` 状态机**——控制 `add_reference` 是否生效：

```
Untracked ←──→ Updating ──→ Complete
  ↑                ↑              │
  │                │              │
  Region 释放    并发标记开始    RSet 更新完成
  /回收          (safepoint)     (safepoint)
```

| 状态 | 含义 | add_reference 行为 | 什么时候进入 |
|---|---|---|---|
| `Untracked` | 不跟踪引用 | 直接返回（不记录） | Region 释放/回收后 |
| `Updating` | 正在更新 RSet | 正常记录到 OtherRegionsTable | 并发标记开始时（safepoint） |
| `Complete` | RSet 完整 | 正常记录 | RSet 更新完成后（safepoint） |

**为什么需要状态机**——并非所有 Region 都需要跟踪 RSet。新建的 Region 在被分配为 old/humongous 之前不需要 RSet（young Region 会被整体回收）。通过状态机控制 `add_reference` 是否生效，避免对不需要 RSet 的 Region 做无用记录。

- **`_code_roots`**——存指向本 Region 的 nmethod（JIT 编译代码里的引用），底层是 chunked list（每个 chunk 存多个 nmethod*），避免单链表过长。GC 时 `strong_code_roots_do()` 遍历扫描这些代码引用。

---

## 4. G1FromCardCache——避免重复记录

### 4.1 为什么需要

`add_reference` 每次都要查三层结构，太慢。大多数情况下"这张 card 已经被记录过了"——用 per-thread 缓存快速判断。

### 4.2 结构

```cpp
class G1FromCardCache : public AllStatic {
  static uintptr_t** _cache;    // 二维数组：[region_idx][worker_id] → 最近处理的 card
  static uint _max_regions;     // Region 总数
};
```

**per-thread × per-Region**——每个线程对每个 Region 记住"最近处理过的 card"。

### 4.3 工作流程

```
add_reference(from_card, to_region, tid):
  1. 查 G1FromCardCache::contains_or_replace(tid, to_region, from_card)
     → 缓存里有同一张 card？→ 命中，跳过（已记录过）
     → 没有？→ 写入缓存，继续查三层结构
```

**具体例子**——假设 Region 0 的 card 5 反复产生引用到 Region 3：

```
第 1 次: Region 0 的 card 5 引用 Region 3
  → contains_or_replace(tid=0, region=3, card=5)
  → 缓存里 region 3 的值是 InvalidCard(0) → 不命中
  → 写入缓存：_cache[3][0] = 5
  → 继续查三层结构 → 记录到 OtherRegionsTable

第 2 次: Region 0 的 card 5 又引用 Region 3（同一张 card 里另一个对象）
  → contains_or_replace(tid=0, region=3, card=5)
  → 缓存里 region 3 的值是 5 == card 5 → 命中！
  → 直接返回，不走三层结构

第 3 次: Region 0 的 card 6 引用 Region 3（不同的 card）
  → contains_or_replace(tid=0, region=3, card=6)
  → 缓存里 region 3 的值是 5 != card 6 → 不命中
  → 替换缓存：_cache[3][0] = 6
  → 继续查三层结构 → 记录到 OtherRegionsTable
```

**效果**——同一张 card 反复产生引用（比如循环里同一对象多次写同一字段），FromCardCache 命中后直接跳过，不走三层结构。只有**不同的 card** 才需要查三层。注意：缓存只记住"最近一张 card"，不是所有 card 的集合——如果 card 5 和 card 6 交替产生引用，每次都会 miss + 替换。

### 4.4 为什么是 per-thread

多个 refine 线程可能同时处理同一张 card（不同对象）。如果共享缓存需要加锁——但 `add_reference` 是热路径。per-thread 缓存每个线程有自己的视图，无锁访问。代价是同一张 card 可能被多个线程各记录一次（冗余但不影响正确性——BitMap 置位是幂等的）。

---

## 5. G1BlockOffsetTable——从地址找到对象起始

### 5.1 为什么需要 BOT

GC 扫描 dirty card 时，card 里有多个对象（大小不一）。给定一个地址，要找到"它属于哪个对象"——即向前找到对象起始地址。但对象大小不一，不能直接算。

### 5.2 类结构

```cpp
class G1BlockOffsetTable {
  volatile u_char* _offset_array;  // 每 512B 堆对应 1 字节 entry
  MemRegion _reserved;             // 覆盖区域
};
```

每 512B 堆空间（= 1 card = `N_words=64` words）对应 1 字节 entry。entry 存的是"回退多少能找到对象起始"。

### 5.3 指数编码——1 字节覆盖整个 Region

| entry 值 | 含义 | 回退多少 |
|---|---|---|
| 0~63 | 线性偏移 | 回退 entry 个 word（512B 内） |
| 64 | 指数起点 | 回退 1 个 card（512B） |
| 65 | | 回退 16 个 card（8KB） |
| 66 | | 回退 256 个 card（128KB） |
| 67 | | 回退 4096 个 card（2MB） |

**为什么用指数**——1 字节只有 256 个值，线性编码最多覆盖 256×8B=2KB。指数编码（底数 16）可以覆盖 16^4 × 512B = 32MB，够覆盖最大的 Region（32MB）。

### 5.4 两阶段定位

`block_start_const(addr)`（`g1BlockOffsetTable.inline.hpp:113-155`）——给定地址找对象起始：

```
阶段 1: BOT 粗定位（block_at_or_preceding）
  index = addr >> 9                     // 算 card index
  offset = _offset_array[index]         // 读 BOT entry
  while (offset >= 64) {                // 指数编码 → 大步跳
    n_cards_back = 16^(offset - 64)     // 算回退几个 card
    q -= n_cards_back * 512B            // 往前跳
    offset = _offset_array[new_index]   // 重读
  }
  q -= offset * 8B                      // 线性偏移到对象头

阶段 2: 对象链细定位（forward_to_block_containing_addr_const）
  while (q <= addr) {                   // 从 q 开始逐对象前进
    q = current
    n = q + block_size(q)               // 下一个对象
    if (n > addr) return q              // q 包含 addr → 返回
  }
```

**阶段 1** 用 BOT 快速跳到大致区域，**阶段 2** 逐对象前进精确定位。

**具体数值例子**——Region 0 里有 3 个对象，找地址 1300B 属于哪个对象：

```
对象布局:
  对象 A: 偏移 0B,    大小 512B  (0~512)
  对象 B: 偏移 512B,  大小 1024B (512~1536)
  对象 C: 偏移 1536B, 大小 512B  (1536~2048)

Card 布局（每 512B 一张 card）:
  Card 0: 0~512     → 对象 A 起始
  Card 1: 512~1024  → 对象 B 起始
  Card 2: 1024~1536 → 对象 B 继续（B 起始在 512，距 card 2 起始 512B=1 card）
  Card 3: 1536~2048 → 对象 C 起始

目标: 找地址 1300B 属于哪个对象 → 在 card 2 范围内
```

**阶段 1: BOT 粗定位**
```
index = 1300 / 512 = 2                    → 读 BOT[2]
BOT[2] = 64                               → 指数编码（>= 64）
entry_to_cards_back(64) = 16^(64-64) = 1  → 回退 1 个 card
q = card_2_start - 1*512 = 1024 - 512 = 512  → 粗定位到偏移 512B
```

**阶段 2: 对象链细定位**
```
q = 512（对象 B 起始）
block_size(512) = 1024B                   → 下一个对象在 512 + 1024 = 1536
1536 > 1300                                → 地址 1300 在对象 B 范围内
return 512                                 → 对象 B 起始地址
```

**为什么需要两阶段**——阶段 1 用 BOT 1 字节快速跳到"大致区域"（可能跳过头或不够），阶段 2 逐对象前进精确定位。如果只有阶段 2（从堆底逐对象前进），4MB Region 里可能要遍历上千个对象——太慢。BOT 让阶段 1 一次跳到附近，阶段 2 只需遍历几个对象。

### 5.5 G1BlockOffsetTablePart——per-Region 视图

每个 HeapRegion 持有一个 `G1BlockOffsetTablePart`——把全局 BOT 数组的对应区段包装成 per-Region 视图，维护 `_next_offset_threshold`（下次该更新 BOT 的分配边界）。对象分配跨越 threshold 时更新 BOT entry。

---

## 6. in_cset_fast_test——O(1) 判断对象在不在 CSet

### 6.1 为什么需要

GC 回收时，对每个对象引用要判断"这个引用指向的对象在不在 CSet"——如果在，要疏散它。这个判断在 GC 热路径上，每次引用遍历都要做，必须极快。

### 6.2 InCSetState 枚举

```cpp
struct InCSetState {
  static const in_cset_state_t Humongous  = -1;  // 大对象 Region
  static const in_cset_state_t NotInCSet  =  0;  // 不在 CSet
  static const in_cset_state_t Young      =  1;  // young Region 在 CSet
  static const in_cset_state_t Old        =  2;  // old Region 在 CSet
};
```

**设计巧妙**——正值表示在 CSet，`is_in_cset() = (_value > 0)` 一条比较覆盖 Young+Old。负值（Humongous）走独立路径。

### 6.3 偏置数组实现

`_in_cset_fast_test`（`G1InCSetStateFastTestBiasedMappedArray`）——继承 `G1BiasedMappedArray<InCSetState>`（偏置数组技巧，详见 ch11/05），对象地址直接映射到 InCSetState，O(1) 查询。

```
GC 开始时:
  register_young_region_with_cset(r)   → _in_cset_fast_test.set_in_young(idx)    // = 1
  register_old_region_with_cset(r)     → _in_cset_fast_test.set_in_old(idx)      // = 2
  register_humongous_region_with_cset  → _in_cset_fast_test.set_humongous(idx)   // = -1

GC 扫描时:
  is_in_cset(obj) = _in_cset_fast_test.at(obj_addr) > 0    // 一条比较

GC 结束时:
  clear_cset_fast_test() → 全部重置为 NotInCSet (0)
```

---

## 7. humongous_reclaim_candidates——大对象急切回收

### 7.1 为什么需要

Humongous 对象（超过 Region 一半，即 8GB 堆 / 4MB Region → 超过 2MB 的对象）占整个连续 Region。如果 Humongous 对象已死，young GC 时可以急切回收——不用等 mixed GC。但要判断"是否真的没有引用"。

**为什么 Humongous 特殊**——普通 old Region 要等 mixed GC 才回收（需要并发标记确认存活率）。但 Humongous 对象只有"有人引用"和"没人引用"两种状态（没有部分存活），如果没引用就可以在 young GC 时直接回收，不用等 mixed GC。

### 7.2 结构

```cpp
HumongousReclaimCandidates _humongous_reclaim_candidates;  // G1BiasedMappedArray<bool>——偏置数组
bool _has_humongous_reclaim_candidates;                    // 是否有候选（无则跳过整个检查流程）
```

### 7.3 完整工作流程

**阶段 1: young GC 开始前——标记候选**
```
对每个 Humongous Region:
  → 检查 RSet 是否有入引用
  → RSet 为空（没有任何其他 Region 引用它）？
     → set_humongous_reclaim_candidate(idx, true)  → 标记为回收候选
     → register_humongous_region_with_cset(idx)    → _in_cset_fast_test = Humongous(-1)
  → RSet 非空？
     → 不标记（有引用，不能回收）
```

**为什么检查 RSet 而不是扫描全堆**——RSet 记录了"谁引用了我"。如果 RSet 为空，说明没有跨 Region 引用指向这个 Humongous 对象。但 RSet 可能不完整（并发 refine 有延迟），所以需要阶段 2 确认。

**阶段 2: young GC 扫描时——确认无引用**
```
GC worker 遍历引用:
  → 发现引用指向 Humongous 对象？
  → set_humongous_is_live(obj)
    → 从候选集移除：_humongous_reclaim_candidates[idx] = false
    → 标记为存活（不回收）

_has_humongous_reclaim_candidates 在此过程中更新:
  → 所有候选都被移除？→ _has_humongous_reclaim_candidates = false
  → 后续 Region 跳过检查（性能优化）
```

**阶段 3: young GC 回收时——回收确认的候选**
```
候选集里剩下的 Humongous Region:
  → _humongous_reclaim_candidates[idx] == true（阶段 2 没被移除）
  → 确认无引用 → 急切回收
  → 释放 Region → 加入 free_list
```

### 7.4 具体例子

```
Region 10~12: Humongous 对象 H1（3 个连续 Region，12MB）
Region 15~15: Humongous 对象 H2（1 个 Region，4MB）

young GC 开始前:
  H1 的 RSet 为空 → 标记候选: candidates[10]=candidates[11]=candidates[12]=true
  H2 的 RSet 非空（Region 3 引用 H2）→ 不标记

young GC 扫描时:
  遍历 Region 3 的引用 → 发现指向 H2 → H2 确认存活
  没有任何引用指向 H1 → H1 保持候选状态

young GC 回收时:
  H1: candidates[10~12]=true → 急切回收 Region 10~12
  H2: 不是候选 → 保留，等后续 mixed GC
```

---

## 8. 概念链

```
dirty card 消费链:
  写后屏障标 dirty → DCQ → ConcurrentRefine 线程 → refine_card_concurrently
    → HotCardCache 判热 → 扫描 card 里的引用（用 BOT 定位对象边界）
    → add_reference 到目标 Region 的 RSet

RSet 三层存储（OtherRegionsTable）:
  FromCardCache 命中跳过 → Coarse 命中跳过 → Sparse 尝试 → Fine 查找
  → Sparse 满 升级 Fine → Fine 满 evict 退化 Coarse

BOT 两阶段定位:
  阶段 1: 指数编码 BOT 粗定位（大步跳）
  阶段 2: 逐对象前进细定位

CSet 快速测试:
  InCSetState(-1/0/1/2) + 偏置数组 → O(1) 判断对象在不在 CSet

Humongous 急切回收:
  无 RSet 引用 → 标记候选 → young GC 时确认无引用 → 急切回收
```

---

## 9. 程序员影响

- **`-XX:G1RSetRegionEntries`**——Fine 表桶数（默认 256），控制 RSet 内存开销。大堆可调大减少 evict
- **`-XX:G1RSetSparseRegionEntries`**——Sparse 表每 Region 的 card 数（默认 4），影响稀疏引用的覆盖
- **RSet 内存开销**——每个 Region 一份 RSet，通常占堆 1%~5%。`-XX:+UnlockDiagnosticVMOptions -XX:+PrintRSetSummary` 可查看
- **BOT 透明**——BOT 是 GC 内部基础设施，程序员不直接操作，但理解它有助于理解"GC 怎么扫描堆"
- **Humongous 对象**——超过 Region 一半（2MB）的对象是 Humongous，避免频繁分配大数组产生碎片
