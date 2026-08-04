# expand——commit 物理内存，分配 Region 并入空闲列表

> **本文定位**：`G1CollectedHeap::initialize()` 第 1670-1674 行。此前堆只是 `mmap` 预留了虚拟地址空间——现在真正 commit 物理内存，创建 HeapRegion 对象，放入空闲列表，让分配器可以开始分配对象。
>
> **前置依赖**：[ch11/07](07-g1-concurrent-mark-creation.md)（G1ConcurrentMark 创建完毕）。

---

## 1. 执行位置

G1ConcurrentMark 创建并挂上 CMThread 后，`initialize()` 调用 `expand()` 真正分配初始堆内存：

```cpp
// g1CollectedHeap.cpp:1670-1674
// Now expand into the initial heap size.
if (!expand(init_byte_size, _workers)) {
    vm_shutdown_during_initialization("Failed to allocate initial heap.");
    return JNI_ENOMEM;
}
```

`init_byte_size` 来自 `-Xms`。`_workers` 是 STW GC 的并行 worker 线程——只在 **`-XX:+AlwaysPreTouch`**（默认 false）时用于并行 pre-touch：遍历已 commit 的页，每页写一个字节 0，强制 OS 立即分配物理页（避免运行时首次访问的延迟抖动）。详见 §4.1。

---

## 2. G1CollectedHeap::expand——对齐后委托 HRM

`expand()`（`g1CollectedHeap.cpp:1337-1365`）只做两件事：

```cpp
size_t aligned_expand_bytes = ReservedSpace::page_align_size_up(expand_bytes);
aligned_expand_bytes = align_up(aligned_expand_bytes, HeapRegion::GrainBytes);
// ↑ 先对齐到 OS 页（4KB），再对齐到 Region 边界（4MB）

uint regions_to_expand = (uint)(aligned_expand_bytes / HeapRegion::GrainBytes);
uint expanded_by = _hrm.expand_by(regions_to_expand, pretouch_workers);
//                  ^^^^^ 委托给 HeapRegionManager
```

逻辑很简单：对齐 → 算 Region 数 → 交给 HRM。`is_maximal_no_gc()` 和 `expand_time_ms` 是非核心路径，一带而过。

---

## 3. HeapRegionManager::expand_by → expand_at——找连续区间

`expand_by()` 直接调 `expand_at(0, num_regions)`（`heapRegionManager.cpp:167-192`）：

```cpp
uint HeapRegionManager::expand_at(uint start, uint num_regions, WorkGang* pretouch) {
    uint cur = start;
    uint expanded = 0;
    while (expanded < num_regions &&
           (find_unavailable_from_idx(cur, &idx)) > 0) {
        uint to_expand = MIN2(num_regions - expanded, num_last_found);
        make_regions_available(idx, to_expand, pretouch);  // ★ 核心
        expanded += to_expand;
        cur = idx + num_last_found + 1;
    }
    return expanded;
}
```

`find_unavailable_from_idx(cur)` 从当前指针开始找下一段"未 commit 的连续 Region"。因为 `-Xms = -Xmx = 8GB`，整个堆从一开始就全量 expand，所以一次找到从 Region 0 开始的连续 2048 个 Region，然后一气 commit 完。分段逻辑在动态伸缩时才用。

---

## 4. make_regions_available——三件事：commit、建、入队

`make_regions_available()`（`heapRegionManager.cpp:121-147`）是 expand 的**核心**——把一段连续 Region Index 从"不可用"变成"可分配"。分三步：

**① commit 物理内存**——6 个 Mapper 各自 commit 自己那片虚拟地址空间中对应该 Region 范围的物理页（§4.1）。

**② 创建 HeapRegion 对象**——`_regions` 偏置数组（`G1HeapRegionTable`）中对应 index 的位置还是 NULL——按需 `new_heap_region(i)` 创建 `HeapRegion` 对象填入。`if (NULL)` 检查是安全的：`expand()` 可能在运行时被多次调用（动态扩堆），之前的 Region 已经创建过了。

**③ 初始化 + 入空闲列表**——对每个新 Region：先 `hr->initialize(mr)` 根据 Region 的堆地址算出 `_bottom`/`_end`、初始化 `_bot_part`（BOT 视图）、设 `_type = Free`。然后 `insert_into_free_list(hr)` 按地址有序插入 `_free_list`。**从此刻起，`G1Allocator` 就能从中取了。**

```cpp
void HeapRegionManager::make_regions_available(uint start, uint num_regions, WorkGang* pretouch) {
    commit_regions(start, num_regions, pretouch);       // ①

    for (uint i = start; i < start + num_regions; i++) {    // ②
        if (_regions.get_by_index(i) == NULL) {
            _regions.set_by_index(i, new_heap_region(i));
        }
    }
    _available_map.par_set_range(start, start + num_regions);

    for (uint i = start; i < start + num_regions; i++) {     // ③
        HeapRegion* hr = at(i);
        hr->initialize(mr);
        insert_into_free_list(hr);
    }
}
```

**一步回顾**——`expand(init_byte_size)` 首次调用时，`_regions` 全部 NULL、`_free_list` 空。执行完三件事后：`_regions[0..2047]` 全部填入 `HeapRegion*`，`_free_list` 链入 2048 个有序 Region，`_available_map` 全置 1。

### 4.1 commit_regions——6 个 Mapper 同步 commit

`-Xms = -Xmx = 8GB`，所以 `expand_at(0, 2048)` 一次性 commit 全部 2048 个 Region。HRM 调 `commit_regions(0, 2048)`：

```cpp
void HeapRegionManager::commit_regions(uint index, size_t num_regions, WorkGang* pretouch) {
    _num_committed += num_regions;   // 0 → 2048

    _heap_mapper->commit_regions(index, num_regions, pretouch);         // 堆: 8GB
    _prev_bitmap_mapper->commit_regions(index, num_regions, pretouch);  // prev 位图: 16MB
    _next_bitmap_mapper->commit_regions(index, num_regions, pretouch);  // next 位图: 16MB
    _bot_mapper->commit_regions(index, num_regions, pretouch);          // BOT: 8GB/512 = 16MB
    _cardtable_mapper->commit_regions(index, num_regions, pretouch);    // Card Table: 16MB
    _card_counts_mapper->commit_regions(index, num_regions, pretouch);  // Card Counts: 16KB
}
```

**6 个 Mapper 各自独立**——每个 Mapper 内部有一块独立的虚拟地址空间（ch11/05 mmap reserve 的），各自按自己的比例翻译 Region Index → 页 Index：

```
_heap_mapper:              Region 0 → 页 0~1023 (4MB / 4KB = 1024 pages/region)
                          Region 2047 → 页 2095104~2096127
                          commit 2048 × 1024 = 2,097,152 页 = 8GB

_prev_bitmap_mapper:      Region 0 → 页 0~3 (16MB/2048 = 8KB/region, 8KB/4KB = 2 pages/region)
                          Region 2047 → 页 4094~4095
                          commit 2048 × 2 = 4,096 页 = 16MB
                          (其他 4 个 Mapper 比例相同或类似)
```

**Mapper 内部——两层 commit 追踪**。每个 Mapper 有两级位图，**都追踪自己空间的内存提交状态**，不追踪别人的空间：

```
G1RegionToSpaceMapper（比如 prev_bitmap Mapper，自己空间 16MB）
├── _commit_map (CHeapBitMap, hpp:54)   ← 下标按堆 Region Index
│     _commit_map[5] = 1 表示 "堆 Region 5 在这 16MB 空间中对应的部分已 commit"（2 页）
│     _commit_map[0] = 0 表示 "堆 Region 0 对应的部分还没 commit"
│     ★ 追踪的是这 16MB，不是堆的 8GB
│
└── _storage (G1PageBasedVirtualSpace)
    └── _committed (CHeapBitMap, vs.hpp:62)  ← 下标按自己空间的页号
          _committed[10] = 1 表示 "这 16MB 空间里的页 10 已 commit"
```

源码验证（`g1RegionToSpaceMapper.cpp:70-76`）：

```cpp
void commit_regions(uint start_idx, size_t num_regions, ...) {
    start_page = start_idx * _pages_per_region;             // 堆 Region → 自己空间的页
    _storage.commit(start_page, num_regions * _pages_per_region);  // 在自己空间的 _committed 标记
    _commit_map.set_range(start_idx, start_idx + num_regions);     // 按堆 Region Index 标记
}
```

`start_idx` 是堆 Region Index，`start_page` 是自己空间的页——两层都追踪**自己**，只是下标体系不同。

**为什么必须 6 份同步 commit**——只 commit 堆而不 commit 位图：GC 标记时读取位图 → bit 对应堆上的 64 字节 → 对应的位图页没 commit → 访问未 commit 页 → SIGSEGV 崩溃。ch11/05 §4.1 讲过这个约束。

`pretouch` 参数——只在 `-XX:+AlwaysPreTouch`（默认 false）时执行。开启后遍历所有已 commit 的页，每页写一个字节 0——强制 OS 立即分配物理页（而不是等首次访问时才 page fault 懒分配），减少运行时延迟抖动。

### 4.2 new_heap_region——创建 Region 对象

每个 Region 在堆上有固定的位置。`new_heap_region(i)`（`heapRegionManager.cpp:68-74`）用简单的算术算出 Region i 的起始地址：

```cpp
HeapRegion* HeapRegionManager::new_heap_region(uint hrm_index) {
    HeapWord* bottom = g1h->bottom_addr_for_region(hrm_index);
    // = _hrm.reserved().start() + hrm_index * GrainWords   (g1CollectedHeap.inline.hpp:74)
    //   例: Region 0 → 0x7f0000000000 + 0 × 4MB = 0x7f0000000000
    //        Region 1 → 0x7f0000000000 + 1 × 4MB = 0x7f0000400000
    //        Region 2047 → 0x7f0000000000 + 2047 × 4MB

    MemRegion mr(bottom, bottom + HeapRegion::GrainWords);
    return g1h->new_heap_region(hrm_index, mr);
    // = new HeapRegion(hrm_index, bot(), mr)                (g1CollectedHeap.cpp:158)
}
```

`HeapRegion` 构造函数（`heapRegion.cpp:229-247`）做三件事：

```cpp
HeapRegion::HeapRegion(uint hrm_index, G1BlockOffsetTable* bot, MemRegion mr) :
    _hrm_index(hrm_index),                    // ① 存 Region Index
    _rem_set(new HeapRegionRemSet(bot, this)), // ② 创建本 Region 的 RSet（三层 Sparse/Fine/Coarse）
{                                              //    RSet 记录 "谁引用了我"（ch11/06 §3）
    initialize(mr);                            // ③ 初始化空间
}
```

`initialize(mr)` → `G1ContiguousSpace::initialize()` → `hr_clear()` → `set_free()` + `set_top(bottom())`。此时 Region 类型为 `Free`，`top = bottom = 起始地址`——没有分配任何对象，等待被分配给 Mutator 或 GC。

2048 个 Region 各自一个 `HeapRegion` 对象（每个约几百字节的 C Heap 内存）+ 一个 `HeapRegionRemSet`（RSet，初始为空）。总计几 MB 的 C Heap 开销。

### 4.3 hr->initialize + insert_into_free_list——初始化并入队

`make_regions_available()` 的最后一步——遍历刚创建的 Region，逐个初始化并加入空闲列表（`heapRegionManager.cpp:135-146`）：

```cpp
for (uint i = start; i < start + num_regions; i++) {
    HeapRegion* hr = at(i);

    HeapWord* bottom = G1CollectedHeap::heap()->bottom_addr_for_region(i);
    // = reserved.start() + i × GrainWords   (g1CollectedHeap.inline.hpp:74)

    MemRegion mr(bottom, bottom + HeapRegion::GrainWords); // ① 构造这个 Region 的堆地址范围

    hr->initialize(mr);                      // ② 设 _bottom/_end = mr, 初始化 _bot_part (BOT), 标 _type = Free
    insert_into_free_list(hr);               // ③ ★ 入队！从此可被 G1Allocator 取走
}
```

**① `bottom_addr_for_region(i)` + `MemRegion`**——用简单算术算出 Region i 在堆上的物理区间（和 §4.2 创建 Region 对象时用的同一个公式，但这里 Region 对象已存在，只是算地址）。`MemRegion(bottom, bottom+4MB)` 就是这个 Region 覆盖的堆范围。

**② `hr->initialize(mr)`**——把一个 Region 设成初始状态（`heapRegion.cpp:249-256`）。

先补一段上下文——**BOT 是干什么的**（ch11/06 §4 详细讲过，这里简要回顾）。GC 扫描 dirty card 时，Card 的 512B 边界可能切在对象中间——读到的不是对象头。BOT 解决这个问题：给定 Card 边界地址，回退到离它最近的对象的起始地址。

BOT 是一张**覆盖整个堆的全局表**——`G1BlockOffsetTable._offset_array`，每 512B 堆空间对应 1 字节 entry。entry = 0~63 是线性偏移（回退 entry 个 word），entry ≥ 64 是指数偏移（回退 16^(entry-64) 个 card——ch11/06 §4.3 有完整编码表）。entry = 0 特殊——表示"从 Region 起始地址（_bottom）逐对象前进找"，这是 BOT 两阶段定位的起点。

每个 Region 持有一个 `G1BlockOffsetTablePart`（`g1BlockOffsetTable.hpp:109`），**不存 BOT 数据**——数据在全局 `_offset_array` 里。它只存两个指针和一条"推进线"：

```cpp
class G1BlockOffsetTablePart {
    G1BlockOffsetTable* _bot;           // 指向全局 BOT 数组（所有 Region 共享同一份）
    G1ContiguousSpace*  _space;         // 指向自己的 Region
    HeapWord* _next_offset_threshold;   // "下次分配跨过这条线时，更新 BOT"
    size_t    _next_offset_index;       // 这条线对应的 BOT 数组下标
};
```

`_bot_part` 只管一件事：**记录"下次什么时候该写 BOT"**。2048 个 Region 各有自己的 `_bot_part`，都指向同一个全局 BOT 数组，各自管理数组里自己 Region 对应那一段。

回到 `initialize()`——对 BOT 的初始化只做两件事（`reset_bot()`, `g1BlockOffsetTable.hpp:204-207`）：

```cpp
void reset_bot() {
    zero_bottom_entry_raw();       // BOT[本Region起始Card] = 0 ← 搜索起点
    initialize_threshold_raw();    // _next_offset_threshold = 第二个 Card 起点
}
```

**`zero_bottom_entry_raw()`**——全局BOT数组中本Region起始Card的entry 写成 0。含义：BOT 两阶段定位的起点——看到 0 就从 Region 起始地址（_bottom）逐对象前进找（ch11/06 §4.4）。

**`initialize_threshold_raw()`**——`_next_offset_threshold` 推进到第二个 Card 起点。第一个 Card 不需要 BOT 回退（0 = 从 Region 起始找），threshold 从第二行开始。运行时 bump-pointer 分配后 → `_bot_part.alloc_block(res, size)` → 跨过 threshold 就写 entry 并推进，没跨过就跳过。

**其他字段**——`_bottom`/`_end` 是 Region 在堆上的固定边界，`_top` 是分配指针（初始 = bottom），`_type` 初始为 Free，通过 `hr_clear()` → `set_free()` + `set_top(bottom())` 设置。```cpp
class G1BlockOffsetTablePart {
    G1BlockOffsetTable* _bot;           // 指向全局 BOT 数组
    G1ContiguousSpace*  _space;         // 指向自己的 Region
    HeapWord* _next_offset_threshold;   // "下次 bump-pointer 分配跨过这条线时,更新 BOT"
    size_t    _next_offset_index;       // 这条线对应的 BOT 数组下标
};
```

**`_bot_part` 并不存 BOT 数据**——数据在全局 `_offset_array` 里。`_bot_part` 只管一件事：**"下一个可能触发 BOT 更新的位置在哪"**。2048 个 Region 各有自己的 `_bot_part`，都指向同一个全局 BOT 数组，各自管理数组里自己那一段。

`reset_bot()` 做两件事（`g1BlockOffsetTable.hpp:204-207`，内部源码如下）：

**`zero_bottom_entry_raw()`**（`g1BlockOffsetTable.cpp:401-406`）——把 Region 起始地址所在的 Card 的 BOT entry 写成 0：

```cpp
void G1BlockOffsetTablePart::zero_bottom_entry_raw() {
    size_t bottom_index = _bot->index_for_raw(_space->bottom());
    // bottom_index = Region起始地址 / 512B，即这个 Region 在全局 BOT 数组里的第一行下标
    _bot->set_offset_array_raw(bottom_index, 0);
    // BOT[bottom_index] = 0
}
```

**"全局BOT数组中本Region起始Card的entry"**就是全局 BOT 数组里 `bottom_index` 那个位置的 entry——它对应 Region 起始地址所在的 Card。这行永远是 0，因为 BOT entry=0 表示"不知道回退多少，从 Region 开头一个对象一个对象往后找"。

**`initialize_threshold_raw()`**（`:393-399`）——把 `_next_offset_threshold` 推进到第二个 Card 起点：

```cpp
HeapWord* G1BlockOffsetTablePart::initialize_threshold_raw() {
    _next_offset_index = _bot->index_for_raw(_space->bottom()); // 拿到 Region 起始 Card 的下标
    _next_offset_index++;              // 推进到第二个 Card
    _next_offset_threshold = _bot->address_for_index_raw(_next_offset_index);
    // _next_offset_threshold = Region起始地址 + 512B（第二个 Card 的起始地址）
    return _next_offset_threshold;
}
```

第一个 Card 不需要 BOT 回退（0 = 从 Region 开头找），threshold 从第二个 Card 开始。运行时 bump-pointer 分配后 → `_bot_part.alloc_block(res, size)` → 跨过 threshold 就写 entry 并推进，没跨过就跳过。

**③ `insert_into_free_list(hr)`**——按地址有序插入 `_free_list`（`FreeRegionList`，一个双向链表）。从此刻起，`G1Allocator::attempt_allocation_locked()` 可以从 `_free_list` 取 Region 分配给 Mutator。

---

## 5. 完整执行流

```
G1CollectedHeap::expand(init_byte_size, _workers)
  → 对齐到 Region 边界 → 算 Region 数 (8GB / 4MB = 2048)
  → _hrm.expand_by(2048, _workers)
    → expand_at(0, 2048)
      → make_regions_available(0, 2048, _workers)
        ├── ① commit_regions: 6 个 Mapper 同步 commit 物理内存
        ├── ② new_heap_region(i): 创建 2048 个 HeapRegion 对象
        └── ③ hr->initialize() + insert_into_free_list(): 入空闲列表
  → g1_policy()->record_new_heap_size() — 通知策略层
```

## 6. 结果

`expand()` 返回后，堆从"虚拟内存预留好了"变成"可以真正分配对象"：

- 6 块内存全部 commit 了物理页（可以写入数据）
- `_regions[0..2047]` 里是 2048 个已初始化的 HeapRegion
- `_free_list` 里有 2048 个空闲 Region 排队等待分配
- `_available_map` 标记了所有 Region 是 available 的

![HRM 内存布局](assets/hrm-memory-layout.png)

下一步 `g1_policy()->init()` 和队列初始化——继续看 09。
