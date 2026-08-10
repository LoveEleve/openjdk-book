# 01-HeapRegion — G1 的最小回收单元（432 字节的 4MB 世界）

> **标准环境**：OpenJDK 11 slowdebug build | `-Xms8g -Xmx8g -XX:+UseG1GC` | 64-bit Linux x86  
> **G1 Region**：4MB，2048 Regions | `#ifdef ASSERT` 全部生效  
> **阅读顺序**：06 阶段第一篇，是整个 G1 系列的标准模板，后续 13 篇均引用本文的 Region 结构、TAMS、free_list  
> **前置依赖**：无（06 阶段起点）  
> **阅读收益**：理解 G1 Region 的完整继承链、字段 hot/cold 分类、TAMS 双缓冲协议、free_list 非循环证明、初始化全路径、状态机无 RETAINED 的真相

---

## §〇 源文件清单

| # | 文件 | 模块 | 本文角色 |
|---|------|------|---------|
| 1 | `heapRegion.hpp` | gc/g1 | ★★★ Region 核心字段 + G1ContiguousSpace |
| 2 | `heapRegion.cpp` | gc/g1 | ★★ 构造 + 初始化 + TAMS 生命周期回调 |
| 3 | `heapRegion.inline.hpp` | gc/g1 | ★★ bump-pointer 分配 + note_start/end_of_marking |
| 4 | `heapRegionType.hpp/cpp` | gc/g1 | ★★★ 位编码类型系统 |
| 5 | `heapRegionBounds.hpp/.inline.hpp` | gc/g1 | ★★ MIN=1MB, MAX=32MB, TARGET=2048 |
| 6 | `heapRegionManager.hpp/cpp` | gc/g1 | ★★★ Region 管理器 + 初始化全路径 |
| 7 | `heapRegionManager.inline.hpp` | gc/g1 | ★ insert_into_free_list 实现 |
| 8 | `heapRegionSet.hpp/cpp/.inline.hpp` | gc/g1 | ★★★ free_list 定义 + 非循环证明 |
| 9 | `space.hpp` | gc/shared | ★ Space → CompactibleSpace 基类 |
| 10 | `g1BlockOffsetTable.hpp` | gc/g1 | ★★ BOT 结构 |
| 11 | `g1YoungGenSizer.hpp` | gc/g1 | ★★ 年轻代约束（跨文件追踪） |
| 12 | `g1RegionToSpaceMapper.hpp` | gc/g1 | ★★ 6 个 Mapper 的虚拟内存映射 |

> 本文跨越 `gc/shared/`（Space 继承体系）和 `gc/g1/`（G1 专用 Region），是 G1 架构的基石。

---

## §一 ★ 继承链 — 四层叠加了什么？

### ❓ 为什么继承链是四层？

G1 Region 的继承链是：

```
CHeapObj<mtGC> → Space → CompactibleSpace → G1ContiguousSpace → HeapRegion
```

**为什么是 4 层而不是 1 层？** 因为 HOTSPOT 的 Space 体系是所有 GC（Serial/Parallel/CMS/G1）共享的抽象层。G1 不能随便拆掉共享层——那会导致连锁修改。每一层都在上一层基础上解决一个特定问题，不能扁平化：

```
Space           内存边界的抽象
  ↓
CompactibleSpace  压缩支持（Serial/Parallel 用，G1 的 Full GC 也用）
  ↓
G1ContiguousSpace G1 专用层：volatile bump-pointer + 内联 BOT + 并发分配锁
  ↓
HeapRegion       G1 独占：RSet + TAMS + 类型系统 + 链表指针 + 淘汰标记 + GC 效率
```

**设计替代分析**：如果扁平化为一层 → 要么把所有 G1 特有字段塞进 `Space`（污染 Serial/Parallel/CMS，每个 Space 实例白占 200+ 字节无用字段），要么让 `HeapRegion` 不继承 `Space`（丧失 GC 框架的 `object_iterate`/`block_start`/`used()` 等虚拟函数接口，需要为 G1 重写整套迭代框架）。

### 1.1 Space — 内存边界（为什么只存指针不存大小？）

**源码位置**：`space.hpp:63-245`

```cpp
// space.hpp:67-68
class Space: public CHeapObj<mtGC> {
protected:
  HeapWord* _bottom;  // 空间起始地址（字粒度）
  HeapWord* _end;     // 空间结束地址（exclusive）
  HeapWord* _saved_mark_word;  // 保存的标记位置（历史遗留）
  SequentialSubTasksDone _par_seq_tasks;  // 并行任务管理
};
```

**❓ 为什么只存 `_bottom` 和 `_end` 两个指针，不存 `_size` 字段？**

因为 G1 Region 的大小是**全局常量**——`HeapRegion::GrainBytes` 对所有 2048 个 Region 都相同。如果每个 Region 单独存一个 `size_t _size`（8 字节），2048 个 Region 就会浪费 **16KB**。而指针相减 `_end - _bottom` 的结果编译期就是常量 `GrainWords`（524288 字），一条 `mov` 指令就能拿到——存字段反而是多余的。

> 在 CMS 中（其 `CompactibleFreeListSpace` 子类）`_size` 需要存，因为 free chunk 大小可变。但在 G1 中，Region 大小固定——这就是共享层的代价：`Space` 的继承体系需要同时兼容 CMS 的可变 chunk 和 G1 的固定 Region，而 G1 必须接受 CMS 遗留的字段（如 `_saved_mark_word`）和接口。

**❓ 为什么 `_bottom` 和 `_end` 在 Region 整个生命周期中不变？**

在 G1 的设计约定中，Region 是固定 4MB 的格子——不存在 Region 变大变小。`_bottom` 由 `hrm_index * GrainWords + heap_base` 确定，`_end = _bottom + GrainWords`。

> **注意**：`Space` 基类提供了 `set_bottom()` / `set_end()` 的 mutable setter——这来自于 CMS 时代（free chunk 大小可变）。G1 中这些 setter 实际**不会被调用**——Region 边界的不变性只是**约定**，不是类型系统强制约束。如果某天 G1 代码调了 `set_end()`，编译器不会报错——这就是"共享层代价"的一个例证。

### 1.2 CompactibleSpace — G1 不用 Compaction，为什么还继承？

**源码位置**：`space.hpp:357-495`

```cpp
// space.hpp:361-362
class CompactibleSpace: public Space {
private:
  HeapWord* _compaction_top;           // 压缩后的新 top
  CompactibleSpace* _next_compaction_space;  // 压缩链（Region → Region）
};
```

**❓ G1 的主要回收方式是 Evacuation（对象复制到 Survivor/Old Region），不是 Compaction（对象在 Region 内部向前滑动），为什么还要继承 `CompactibleSpace` 这一层？**

两条原因：

1. **继承体系改不动**：`Space` 体系被 Serial/Parallel/CMS/G1 四个 GC 共享。`CompactibleSpace` 虽然大部分方法在 G1 中被覆盖（`prepare_for_compaction()` 直接 `ShouldNotReachHere()` —— `heapRegion.cpp:857-859`），但从继承树中拿掉它需要修改所有 GC 的 Space 引用——代价远大于保留。

2. **G1 的 Full GC 确实需要它**：当 Evacuation 失败太多或并发标记跟不上分配速度时，G1 会触发 Full GC（`G1FullGCCompact`），此时使用标记-压缩算法。Full GC 的 `G1FullGCCompactionPoint::forward()` 操作需要 `CompactibleSpace` 的 `_compaction_top` 和 `_next_compaction_space` 字段来维护跨 Region 的压缩指针。

**设计替代分析**：如果去掉 `CompactibleSpace` → G1 Full GC 需要自己维护压缩状态 → 等价于在 `G1ContiguousSpace` 中重新造一个 `_compaction_top` → 跟现在没区别。

### 1.3 ★ G1ContiguousSpace — G1 独有的关键层

**源码位置**：`heapRegion.hpp:97-189`

```cpp
// heapRegion.hpp:99-109
class G1ContiguousSpace: public CompactibleSpace {
  HeapWord* volatile _top;        // ★ bump-pointer 当前分配位置
protected:
  G1BlockOffsetTablePart _bot_part; // ★ G1 版本的 BOT（内联 ~40B 跟踪字段）
  Mutex _par_alloc_lock;            // ★ Region 级并行分配锁
  HeapWord* _pre_dummy_top;         // ★ 退役前的真实 top（dummy 填充前）
};
```

**注意**：G1 并不使用标准的 `ContiguousSpace`（`space.hpp:501-672`），而是 fork 了自己的 `G1ContiguousSpace`。虽然两者都继承 `CompactibleSpace`，但 `G1ContiguousSpace` 有 4 个独有的关键设计：

| 成员 | 粒度 | 为什么在这一层而不是 HeapRegion 层？ |
|------|------|--------------------------------------|
| `_top` (volatile) | HeapWord*（字地址）| **并发可见性**：① 多 GC worker CAS bump-pointer（Evacuation）② Refinement 线程读 `_top` 判断扫描边界（非 safepoint）③ volatile 阻止编译器跨 safepoint 缓存。G1ContiguousSpace 封装 bump-pointer 语义，让后续层的 HeapRegion 只感知"有分配能力"的抽象 |
| `_bot_part` | 内联 ~40B（仅 per-Region 跟踪字段，不含偏移数组本体）| **避免指针间接**：如果所有 BOT 操作都通过全局 `G1BlockOffsetTable*` 间接访问（两次 dereference），每次 BOT 查询多一次 L1 miss。内联 `_bot_part` 后，分配位标 `_next_offset_threshold` 直接嵌入 Region 对象内，bump-pointer 分配路径上可以用 `this->_bot_part.alloc_block()` 零间接访问 |
| `_par_alloc_lock` | Mutex | **Region 粒度锁**：并行 GC worker 在 Evacuation 时各自写入不同的 Survivor Region，锁粒度是 Region 级别而非全局 |
| `_pre_dummy_top` | HeapWord* | **退役完整性**：当 Region 退役时，会先分配 dummy object 占满剩余空间（防止其他线程继续写），但需要记住最后一个"真实对象"的位置 |

**❓ 为什么 `_top` 必须是 volatile？**

三条并发路径同时读写 `_top`：

1. **多个 GC worker 并行 Evacuation**（Young GC / Mixed GC 期间）：GC worker 将存活对象复制到 Survivor/Old Region 的 to-space，通过 `Atomic::cmpxchg` CAS bump-pointer（`heapRegion.inline.hpp:64`）——多个 worker 同时 CAS 同一个 `_top` 字段，volatile 保证 CAS 操作的内存序正确，确保每个 worker 看到的 `_top` 是最新的。

2. **Concurrent Refinement 线程**（非 safepoint 期间）：并发 refinement 线程扫描 dirty card 时，需要知道 Region 的已分配区域边界。通过 `_concurrent_iteration_safe_limit` 的计算间接依赖 `_top`。此时 mutator 确实在并发写 `_top`（TLAB refill 时扩展现有 Region 的 `_top`，或在 humongous 分配时写 `_top`）——这是真正的跨线程并发读写。

3. **Concurrent Mark 线程读 `_top`（在 safepoint 内）**：`note_start_of_marking()` 在 Initial Mark safepoint 调用——此时所有 mutator 和 GC worker 都已停止，所以这条路径不需要 volatile。但如果编译器将 `_top` 缓存在寄存器中，即使 safepoint 内的读也可能拿到过期值——volatile 阻止编译器跨 safepoint 缓存。

**面试追问点**：如果 `_top` 不是 volatile，场景 2 中 refinement 线程可能读到**过期**的 `_top` → 认为 Region 还没分配到某个地址 → 放弃扫描那片内存中的引用 → 漏掉跨代引用 → **活对象被当做垃圾回收 → SIGSEGV**。

**❓ `_pre_dummy_top` 解决什么问题？**

当一个 Old Region 作为 GC allocation region 被退役时：
1. 先记录当前 `_top` 到 `_pre_dummy_top`（保存最后一个真实对象的边界）
2. 用 dummy object 填满 `[_top, _end)` 区域（彻底禁止后续分配）
3. 后续验证代码可以通过 `_pre_dummy_top` 知道真实对象的边界在哪里

如果不用 `_pre_dummy_top`，退役后 `_top == _end`（因为 dummy object 占了全部剩余空间），无法区分"Region 满了"和"被 dummy 强占"。

### 1.4 ★ BOT 详解 — 为什么 GC 扫卡时需要知道对象边界？

**❓ 卡表的局限是什么？**

GC 线程通过 RSet（Remembered Set）知道"Old Region #501 的 Card #1500 有引用指向 Eden"。当扫描这张卡时：

- 卡只告诉你："从地址 `addr` 开始的 512 字节范围内有引用"
- 但 `addr` 可能指向一个对象的**中间**——如果对象从前一张卡跨越到这张卡
- 你不知道对象从哪里开始 → 无法解析 oop 的字段 → 无法遍历引用

**BOT 的解决方案**：以 `N_words`（2 的幂）个字为一个块，每个块存一个偏移值，表示"最近的对象起始地址离这个块边界多远"。

`N_words` 的具体值定义在 `blockOffsetTable.hpp` 的 `BOTConstants` 中：
```cpp
// blockOffsetTable.hpp (BOTConstants)
static const uint LogN = 9;         // 块大小为 2^9 = 512 字
static const uint N_words = 512;    // 512 words = 4096 bytes = 4KB
static const uint N_bytes = 4096;   // 即 4KB（一个普通内存页大小）
```
→ 每个 Region (4MB) = **1024 个 BOT 块**（4MB/4KB）。每个块条目 1 字节（`u_char`），per-Region 的 BOT 偏移数组为 1024 字节。

> ★ **BOT 粒度 (4KB) vs 卡粒度 (512B) 的不匹配**：BOT 块是 4KB，卡是 512B——一张 4KB 的 BOT 块覆盖 8 张卡。当 GC 通过 RSet 拿到一张脏卡的地址（512B 粒度），调用 `block_start(card_addr)` 时，BOT 只能精确定位到 4KB 块内的第一个对象起始偏移。如果脏卡地址落在对象的**中间**，`block_start()` 通过 `offset` 字段回退到前一个对象起始——这个回退精度是 **BOT 块级**（4KB），不是卡级（512B）。GC 扫描脏卡的正确性依赖两个事实：(1) BOT 保证找到的对象起始 ≤ card_addr；(2) 从对象起始顺序遍历字段，能覆盖到该脏卡覆盖的所有引用。

```
BOT 查找过程：
  GC 拿到地址 addr → BOT index = addr / N_words
  → offset = _offset_array[index]  （偏移数组在全局 G1BlockOffsetTable 中，由 BOT Mapper 管理）
  → 如果 offset == 0: addr 正好是对象起始
  → 如果 offset != 0: 回退 offset × HeapWordSize → 找到前一个对象的起始
```

**源码位置**：`g1BlockOffsetTable.hpp:109-230`

```cpp
// g1BlockOffsetTable.hpp:114-124
class G1BlockOffsetTablePart {
private:
  HeapWord* _next_offset_threshold;  // 下一个需要更新 BOT 的边界
  size_t    _next_offset_index;      // 对应边界的数组索引
  G1BlockOffsetTable* _bot;          // 全局 BOT（mapper 管理）
  G1ContiguousSpace* _space;         // 所属空间
};
```

**❓ 为什么用 2 的幂块大小而不是逐卡存储？**

| 方案 | 条目数/Region | 每 Region 开销 | 问题 |
|------|-------------|-------------|------|
| 每卡存一个偏移 | 8192（4MB/512B） | 16KB（8192×2B）| 内存开销太大 |
| 每 `N_words` 块存一个 | 1024（4MB/4KB）| 1024B（偏移数组在全局 BOT Mapper 中）+ ~40B（`_bot_part` 跟踪字段内联在 G1ContiguousSpace） | 偏移数组不在 per-Region 对象内，通过全局 BOT 指针间接访问 |

**❓ per-Region BOT（`_bot_part`）和 BOT Mapper 是什么关系？**

两者分工明确，不重复存储数据：

- **BOT Mapper**（`_bot_mapper` in `HeapRegionManager`）：管理**全堆** BOT 偏移数组 `_offset_array[]` 的虚拟→物理内存映射。实际的偏移值存在 `G1BlockOffsetTable::_offset_array` 中（一个 `volatile u_char*` 数组），当 Region 被 commit/uncommit 时，mapper 同步提交/释放对应的 BOT 内存页。

- **per-Region `_bot_part`**（`G1ContiguousSpace` 内联成员）：**不重复存储偏移数据**。它持有：
  - `G1BlockOffsetTable* _bot`：指向全局 BOT 的指针（其中 `_offset_array` 是唯一的偏移数组）
  - `_next_offset_threshold` / `_next_offset_index`：per-Region 的分配位标（对象分配越过 threshold 时触发 BOT 更新）
  - `_space`：反向引用所属的 G1ContiguousSpace

**关键澄清**：`_bot_part` 不是"缓存"——它不复制数据。它是 per-Region 的 **分配跟踪状态** + 全局数据访问入口。偏移数组本体只在 `_bot->_offset_array` 一份，由 BOT Mapper 管理其内存页。`_bot_part` 负责在对象分配时更新自己 Region 对应的偏移条目。

### 1.5 HeapRegion — 完整签名

```cpp
// heapRegion.hpp:191-701
class HeapRegion: public G1ContiguousSpace {
  // ── 空间组（继承自 Space→G1ContiguousSpace）──
  // _bottom, _end:  固定边界
  // _top (volatile): bump-pointer
  // _bot_part:       内联 BOT
  // _par_alloc_lock: Region 级分配锁
  // _pre_dummy_top:  真实对象边界

  // ── 索引 + 类型组 ──
  uint  _hrm_index;              // Region 序号 [0, 2047]
  HeapRegionType _type;          // 位编码类型（Free/Eden/Survivor/...）
  HeapRegion* _humongous_start_region;  // Humongous 起始 Region（如果自身是 Continues）
  bool _evacuation_failed;       // ★ 正交于 _type 的淘汰失败标记

  // ── 关系组 ──
  HeapRegionRemSet* _rem_set;    // 谁指向我（RSet 反向索引，卡粒度）
  HeapRegion* _next;             // free_list 链表 next
  HeapRegion* _prev;             // free_list 链表 prev
  #ifdef ASSERT
  HeapRegionSetBase* _containing_set;  // 调试：所属集合
  #endif

  // ── 统计组 ──
  size_t _prev_marked_bytes;     // 上次标记确认的活字节数（字节计数）
  size_t _next_marked_bytes;     // 本轮标记确认的活字节数（字节计数）
  double _gc_efficiency;         // GC 效率（回收字节/预测时间）
  HeapWord* _prev_top_at_mark_start;  // ★ 上次标记开始时的 top（TAMS）
  HeapWord* _next_top_at_mark_start;  // ★ 本轮标记开始时的 top（TAMS）
  size_t _recorded_rs_length;    // 记录的 RSet 长度
  double _predicted_elapsed_time_ms;  // 预测处理时间
  int  _young_index_in_cset;     // CSet 中年轻代索引
  SurvRateGroup* _surv_rate_group;    // 存活率统计组
  int  _age_index;               // 年龄统计索引
};
```

> **⚠️ 例外**：Humongous Region 打破了 "一个 Region = 一个回收单元" 的规则——对象 ≥ 2MB 会占用 2+ 个连续 Region（StartsHumongous + N × ContinuesHumongous），作为整体参与回收。详见后续 `[03-YoungGC]` 和 `[06-Humongous]`。

---

## §二 ★★★ HeapRegion 432B 字段全景

### ❓ 432 字节里塞了什么？

G1 Region 总共约 432 字节（`sizeof(HeapRegion)` ≈ 432 in slowdebug build）。这 432 字节被组织为 4 个逻辑组，每个组的访问频率和路径完全不同。

### 2.1 空间组 — bump-pointer 三件套

| 字段 | 所属层 | 粒度 | 说明 |
|------|--------|------|------|
| `_bottom` | Space | HeapWord* | Region 起始地址，终生不变 |
| `_end` | Space | HeapWord* | Region 结束地址，终生不变 |
| `_top` (volatile) | G1ContiguousSpace | HeapWord* | bump-pointer 当前位置，每次分配都移动 |
| `_bot_part` | G1ContiguousSpace | ~40B 内联（仅跟踪字段）| BOT 偏移表访问入口 + per-Region 分配位标（偏移数组本体在全局 BOT Mapper 中） |
| `_par_alloc_lock` | G1ContiguousSpace | Mutex (~40B) | Region 级并行分配锁 |
| `_pre_dummy_top` | G1ContiguousSpace | HeapWord* | 退役前的最后一个真实对象的 top |

**关系**：`_bottom ≤ _top ≤ _end`，`used() = byte_size(_bottom, _top)`，`free() = byte_size(_top, _end)`。

### 2.2 类型组 — `_type` 位编码（详见 §四）

| 字段 | 粒度 | 说明 |
|------|------|------|
| `_type` | `volatile Tag`（4 字节）| 13 个枚举条目（5 个 Mask + 8 个有效类型 Tag），用 bit flag 编码 |
| `_hrm_index` | uint（4 字节）| Region 索引 [0, 2047] |
| `_humongous_start_region` | HeapRegion* | Humongous 对象起始 Region 指针 |
| `_evacuation_failed` | bool（1 字节）| 淘汰失败标记（正交于 `_type`）|

### 2.3 关系组 — RSet + 链表

| 字段 | 粒度 | 说明 |
|------|------|------|
| `_rem_set` | HeapRegionRemSet* | RSet 反向索引（"谁指向我"），卡粒度 |
| `_next` | HeapRegion* | free_list 后继指针 |
| `_prev` | HeapRegion* | free_list 前驱指针 |
| `_containing_set` | HeapRegionSetBase* | 仅 ASSERT 模式，调试用 |

### 2.4 统计组 — 标记 + GC 决策

| 字段 | 粒度 | 说明 |
|------|------|------|
| `_prev_marked_bytes` | size_t（字节计数）| 上次标记确认的活字节 |
| `_next_marked_bytes` | size_t（字节计数）| 本轮标记确认的活字节 |
| `_prev_top_at_mark_start` | HeapWord*（字地址）| 上次标记开始时的 top（为 Mixed GC 提供只读快照）|
| `_next_top_at_mark_start` | HeapWord*（字地址）| 本轮标记开始时的 top（为并发标记提供读写视图）|
| `_gc_efficiency` | double | 回收效率 = reclaimable_bytes / predicted_time |
| `_predicted_elapsed_time_ms` | double | 预测处理时间 |
| `_recorded_rs_length` | size_t | RSet 长度（用于预测模型）|
| `_young_index_in_cset` | int | CSet 中排序索引 |
| `_surv_rate_group` | SurvRateGroup* | 存活率年龄组（预测模型）|
| `_age_index` | int | 年龄索引 |

### 2.5 ★ hot / cold 分类表

| 路径 | 访问字段 | 频率 | cache 亲和性 |
|------|---------|------|-------------|
| **Hot（Evacuation 分配）** | `_top`（目标 Survivor/Old Region）| 每次 Young/Mixed GC，所有存活对象都过这条路 | L1（但 CAS 竞争导致 cache line bouncing）|
| **Hot（TLAB refill）** | `_top`, `_end` | 对象数 / TLAB 大小 ≈ 每数千次分配一次 | L1 |
| **Warm（普通 TLAB 内部分配）** | 不碰 `_top`！ | — | TLAB 内部分配只碰 TLAB 的 `_top`（栈上快照），不碰 Region 的 `_top` |
| **Warm（Young GC CSet 遍历）** | `_type` | 每次 Young GC 对所有 CSet Region | L2（CSet Region 对象散布在不同内存页） |
| **Warm（RSet 扫描）** | `_rem_set`, `_bot_part` | 每次 Young GC 对 RSet 条目 | 跨 Region，cache unfriendly |
| **Warm（Region 状态转换）** | `_type`, `_next`, `_prev` | 每次 GC 结束时 | L2 |
| **Cold（并发标记开始）** | `_next_top_at_mark_start`, `_next_marked_bytes` | 每轮 Initial Mark safepoint 1 次 | cache evicted |
| **Cold（并发标记扫描）** | `_prev_top_at_mark_start` | 每个 Region 扫描开始时 load 一次，寄存器常驻 | 访问频率低（per-Region），但 load 时可能 cache miss |
| **Cold（Mixed GC 选策）** | `_prev_marked_bytes`, `_gc_efficiency`, `_predicted_elapsed_time_ms` | Cleanup 后 1 次（对所有 Region 排序选策）| L2/cold |
| **Cold（Evacuation Failure）** | `_evacuation_failed` | 只在失败时 | never |
| **Cold（Full GC）** | `_compaction_top`（继承 CompactibleSpace）| 只在 Full GC | never |

> **面试追问点**：为什么 Hot 路径说 `_top` 是 "L1 但 CAS 导致 cache line bouncing"？
> 答：多个 GC worker 并行 Evacuation 到同一个 Survivor Region 时，CAS bump-pointer 需要获取 `_top` 所在 cache line 的独占权（MESI Exclusive/Modified 状态）。每次 CAS 竞争导致 cache line 在 CPU 核之间反复跳转——即使数据在 L1 中，获取独占权的延迟（~20-40 cycles）远高于 L1 hit（~4 cycles）。这就是为啥 TLAB 内部不碰 Region 的 `_top`——把竞争延迟摊还到 TLAB refill 频率上。

### 2.6 GDB 字段偏移表

> **郑重声明**：以下偏移值均为**预估值**——`sizeof(HeapRegion)` 和具体字段偏移受以下因素影响：
> - `#ifdef ASSERT` 插入的 `_containing_set` 等调试字段
> - `SequentialSubTasksDone` 在 Space 中的精确大小
> - `Mutex` 的实现大小（依赖 `#ifdef ASSERT` 和平台）
> - 编译器 `alignof` 对齐规则（64-bit 下指针对齐 8 字节，bool 后可能有 7 字节 padding）
>
> **必须在 slowdebug build 中用 `ptype /o HeapRegion` 实测**才能确认。以下仅为"大概在什么位置"的参考。

```
(gdb) ptype /o HeapRegion
/* offset    |  size */  type = class HeapRegion : public G1ContiguousSpace {
                           // Space (基类，约 3×8 + sizeof(SequentialSubTasksDone))
   /*  0      |     8 */    HeapWord* _bottom;
   /*  8      |     8 */    HeapWord* _end;
   /* 16      |     8 */    HeapWord* _saved_mark_word;
                           // CompactibleSpace 字段（_compaction_top, _next_compaction_space, etc.）
                           // G1ContiguousSpace 字段:
   /* ~120    |     8 */    HeapWord* volatile _top;
   /* ~128    |   ~32 */    G1BlockOffsetTablePart _bot_part;  // 不含偏移数组，仅 per-Region 跟踪字段
   /* ~160    |   ~40 */    Mutex _par_alloc_lock;
   /* ~200    |     8 */    HeapWord* _pre_dummy_top;
                           // HeapRegion 字段:
   /* ~208    |     8 */    HeapRegionRemSet* _rem_set;
   /* ~216    |     4 */    uint _hrm_index;
   /* ~220    |     4 */    HeapRegionType _type;              // 4 字节（volatile Tag）
   /* ~224    |     8 */    HeapRegion* _humongous_start_region;
   /* ~232    |     1 */    bool _evacuation_failed;
                           // ... padding 约 7 字节 ...
   /* ~240    |     8 */    HeapRegion* _next;
   /* ~248    |     8 */    HeapRegion* _prev;
   /* ~256    |     8 */    HeapRegionSetBase* _containing_set;  // ASSERT only!
                           // ... 其余统计字段约 10×8 字节 ...
                           /* total size (bytes): ~432 */
                         }
```

> **核心 GDB 验证脚本**：
> ```bash
> gdb -p $(pgrep -f "YourMainClass") \
>   -ex "ptype /o HeapRegion" \
>   -ex "print sizeof(HeapRegion)" \
>   -ex "print sizeof(G1BlockOffsetTablePart)" \
>   -ex "print HeapRegion::GrainBytes" \
>   -ex "print HeapRegion::CardsPerRegion"
> ```
> **注意**：`_containing_set` 仅在 ASSERT build 中存在——product build 中所有后续字段偏移都会少 8 字节。

---

## §三 ★★★ TAMS 双缓冲 — 并发标记为什么需要两个指针

### ❓ 为什么一个指针不够？

TAMS（Top At Mark Start）是并发标记的核心协议。每个 Region 维护**两个** TAMS 指针：

- `_prev_top_at_mark_start`：上一轮标记完成时的快照 → 为 **Mixed GC** 提供只读视图
- `_next_top_at_mark_start`：本轮标记开始时的快照 → 为 **并发标记线程** 提供读写视图

**如果只有一个 TAMS 会怎样？**

关键不是"并发读写竞争"——G1 的状态切换都在 safepoint 发生，不存在 mutator 和 CM 线程同时写同一个 TAMS 的竞争。真正的问题是 **两个 marking cycle 的数据需要在时间上重叠共存**：

```
时间线（一次完整的并发标记周期）：
  Initial Mark (safepoint)
    → note_start_of_marking(): _next_TAMS = top(), _next_marked_bytes = 0
  Concurrent Mark (并发)
    → obj < _next_TAMS → 查 bitmap；obj >= _next_TAMS → 自动存活
  Remark (safepoint)
    → note_end_of_marking(): _prev ← _next swap
    → 此时 _prev_TAMS 冻结——再也没有人会写它
  Cleanup (safepoint)
    → swap_mark_bitmaps() → _prev_bitmap 固定
    → Mixed GC 使用 _prev_TAMS + _prev_bitmap 选择 Old Region
  ─── Mixed GC 周期开始（可能跨越多轮 Young GC）───
    → 每轮 Young GC 后，Mixed GC 用 _prev_TAMS 计算 live_bytes，选 Old Region 回收
    → _prev_TAMS 全程只读，没人写它，数据稳定
  ─── 与此同时，下一轮并发标记已经开始！───
    → 新 Initial Mark: note_start_of_marking() → _next_TAMS = top()
    → 新 Concurrent Mark 并发进行 → 写 _next_marked_bytes
    → Mixed GC 完全不碰 _next_xxx → 零干扰
```

**如果只有一个 TAMS**：Mixed GC 还在读"上一轮"的 TAMS 选 Old Region，但下一轮 Initial Mark 已经把唯一的 TAMS 覆盖为新的 `top()` → TAMS 语义断开 → Mixed GC 用的 TAMS 与 bitmap 不对应 → `live_bytes` 完全错误 → **SIGSEGV**。

**双缓冲的本质**：不是防止"两个线程同时写同一个字段"的并发竞争，而是允许 **两个 marking cycle 的数据在不同命名空间中独立存活**。当 Mixed GC cycle N 还在进行时，concurrent marking cycle N+1 已经可以开始——新 cycle 用 `_next_xxx` 系列字段，老 Mixed GC 继续用 `_prev_xxx` 系列字段。两者互不污染。

**双缓冲协议图示**：

```
  (cycle N 已完成)            (cycle N+1 进行中)
┌─────────────────┐     ┌─────────────────┐
│ _prev_TAMS      │     │ _next_TAMS       │
│ _prev_marked    │     │ _next_marked     │
│                 │     │                 │
│ Consumer:       │     │ Producer:       │
│  Mixed GC N     │     │  CM cycle N+1   │
│  (全程只读)     │     │  (持续读写)     │
├─────────────────┤     ├─────────────────┤
│ 写入时机:       │     │ 写入时机:       │
│ 仅 Remark       │     │ Initial Mark +  │
│ (note_end_of    │     │ CM 过程中       │
│  _marking)      │     │ 累加 marked     │
│ 之后永不修改    │     │ bytes           │
└─────────────────┘     └─────────────────┘
```

> **面试追问点**：面试官问 "为什么 _prev_TAMS 不用 volatile"？
> 答：因为 _prev_TAMS 只在 Remark safepoint 被写一次，之后只读。Mixed GC 和下一轮 CM 都只读 _prev_TAMS——没有并发写。不需要 volatile 带来的内存屏障开销。

### 3.1 TAMS 生命周期时间线

```
标记开始 (note_start_of_marking)：
  _next_TAMS = top()          // 记录本轮标记快照
  _next_marked_bytes = 0      // 清零本轮计数

标记进行 (do_marking_step)：
  obj >= _next_TAMS → 自动存活（SATB 快照后分配的）
  obj <  _next_TAMS → 查 bitmap 决定是否标记

标记完成 (note_end_of_marking)：
  _prev_TAMS ← _next_TAMS     // ★ swap: 本轮变为"上一轮"
  _next_TAMS ← bottom()       // 重置
  _prev_marked_bytes ← _next_marked_bytes
  _next_marked_bytes ← 0
```

**源码位置**：`heapRegion.inline.hpp:243-253`

```cpp
// heapRegion.inline.hpp:243-246
inline void HeapRegion::note_start_of_marking() {
  _next_marked_bytes = 0;
  _next_top_at_mark_start = top();  // ★ 记录快照
}

// heapRegion.inline.hpp:248-253
inline void HeapRegion::note_end_of_marking() {
  _prev_top_at_mark_start = _next_top_at_mark_start;  // ★ swap
  _next_top_at_mark_start = bottom();                 // ★ 重置
  _prev_marked_bytes = _next_marked_bytes;             // 字节计数也 swap
  _next_marked_bytes = 0;
}
```

**关键保证**：`_prev_TAMS` 只在 mark_end 时被写入（在 safepoint），之后只读。Mixed GC 可以在并发标记线程之外安全读取 `_prev_TAMS` 而没有数据竞争。

### 3.2 live_bytes 计算公式推导

**源码位置**：`heapRegion.hpp:371-373`

```cpp
// heapRegion.hpp:371-373
size_t live_bytes() {
  return (top() - prev_top_at_mark_start()) * HeapWordSize + marked_bytes();
}
```

**每项的含义**：

| 项 | 含义 | 粒度 |
|----|------|------|
| `top()` | 当前 bump-pointer 位置 | HeapWord* |
| `prev_top_at_mark_start()` | 上次标记开始时的 top | HeapWord* |
| `top() - prev_TAMS` | 标记以后新分配的对象数量（字地址差值） | 字计数 |
| `* HeapWordSize` | 字地址差值 → 字节数（×8 on 64-bit） | 字节计数 |
| `marked_bytes()` (= `_prev_marked_bytes`) | 标记阶段确认的活字节 | 字节计数 |

**举例**：
```
top = TAMS + 1000 字 → 标记后分配了 1000 × 8 = 8000 字节
prev_marked_bytes = 50000（标记确认字节）
live_bytes = 8000 + 50000 = 58000 字节

如果不 × 8：
live_bytes = 1000 + 50000 = 51000 ← 少了 7000 字节（7000 字节 ≈ 875 字，取决于平均对象大小，约对应 100-200 个对象）
```

**❓ 为什么 `_prev_marked_bytes` 存字节而不是字？**

因为 `_prev_marked_bytes` 是由并发标记线程在 while 循环中累加的（`add_to_marked_bytes(incr_bytes)`），累加量 `incr_bytes` 来自 `obj->size() * HeapWordSize`——已经是字节。如果存字计数需要在累加时 `obj->size()` 不用 ×8，但 `live_bytes()` 计算时需要把 `(top - TAMS) * 8` 改成直接加字计数。当前设计虽然 `live_bytes()` 多一次 ×8，但累加路径少一次 ÷8（或者累加路径也存字节，更自然）。

### 3.3 TAMS swap 和 bitmap swap 的时序关系

**关键事实**：TAMS swap 和 bitmap swap **不在同一个 safepoint**——它们分别发生在 **Remark** 和 **Cleanup** 两个独立的 safepoint：

```
G1 并发标记周期时间线：

  Initial Mark (safepoint)
    → note_start_of_marking() 遍历所有 Region
    → _next_TAMS = top(), _next_marked_bytes = 0

  Concurrent Mark (并发——mutator 正常运行)
    → 标记线程扫描堆，累加 _next_marked_bytes
    → obj >= _next_TAMS → 自动存活（SATB 快照后分配的新对象）

  Remark (safepoint) ← ★ TAMS swap 在这里
    → note_end_of_marking() 遍历所有 Region
    → _prev_TAMS ← _next_TAMS    （next 变为 prev——冻结！）
    → _next_TAMS ← bottom()      （next 重置为底部）
    → _prev_marked_bytes ← _next_marked_bytes
    → _next_marked_bytes ← 0
    → 此后 _prev_TAMS 永不修改——所有后续读写者都是只读

  Cleanup (safepoint) ← ★ Bitmap swap 在这里
    → swap_mark_bitmaps() 交换 _prev_bitmap ↔ _next_bitmap
    → 选择 Mixed GC 候选 Region（基于 _prev_TAMS + _prev_marked_bytes）
    → 此时 _prev_TAMS 与 _prev_bitmap 完全对应——都在上一轮标记结束时确定
```

**为什么分两步而不是一步完成？**

Remark 之后有额外的处理窗口：需要先保障 `_prev_TAMS` + `_prev_marked_bytes` 冻结（remark 完成的那一瞬间），然后 Cleanup 阶段才能用这些数据做 Counting（统计各 Region live bytes）和 Selecting（按 GC efficiency 排序选 CSet 候选）。Cleanup 期间 swap bitmap 后，新 bitmap 立刻可用于下一轮标记。

**中间窗口的安全性**：Remark 和 Cleanup 之间的时间段（concurrent cleanup），_prev_bitmap 还是"旧"的（尚未 swap），但 _prev_TAMS 已经冻结。此时没有 Mixed GC 进行（Mixed GC 在 Cleanup 之后才开始），所以不存在数据不一致窗口。

---

## §四 ★ 类型位编码 — 一条 AND 指令的百万倍价值

### ❓ 为什么不用数字枚举？

**源码位置**：`heapRegionType.hpp:64-91`

```cpp
// heapRegionType.hpp:64-91
typedef enum {
  FreeTag               = 0,    // 00000 0
  YoungMask             = 2,    // 00001 0
  EdenTag               = 2,    // 00001 0  = YoungMask
  SurvTag               = 3,    // 00001 1  = YoungMask + 1
  HumongousMask         = 4,    // 00010 0
  PinnedMask            = 8,    // 01000 0
  StartsHumongousTag    = 12,   // 01100 0  = HumongousMask | PinnedMask
  ContinuesHumongousTag = 13,   // 01100 1  = HumongousMask | PinnedMask + 1
  OldMask               = 16,   // 10000 0
  OldTag                = 16,   // 10000 0  = OldMask
  ArchiveMask           = 32,   // 100000 0
  OpenArchiveTag        = 56,   // 111000 0 = ArchiveMask | PinnedMask | OldMask
  ClosedArchiveTag      = 57    // 111000 1 = ArchiveMask | PinnedMask | OldMask + 1
} Tag;
```

**为什么跳过了 `1`？** 因为 bit 0 被保留给 YoungMask 的区分位：
- bit 0 = 0 → Free(0) / Old(16)
- bit 0 = 1 → Survivor(3) / ContinuesHumongous(13) / ClosedArchive(57)

**编码设计原则**：每个"大类"用一个 mask（2 的幂），大类内的"小类"用低 bit 区分：

| 大类 | Mask | 包含的 Tag |
|------|------|-----------|
| Free | — | 0 = 00000 0 |
| Young | 2 (bit1) | 2=Eden, 3=Survivor |
| Humongous | 4 (bit2) | 12=Starts, 13=Continues → 都用 bit2(=4) + bit3(=8) = 12 |
| Old | 16 (bit4) | 16=Old |
| Archive | 32 (bit5) | 56=Open, 57=Closed → 都用 bit5(=32) + bit3(=8) + bit4(=16) = 56 |

### 4.1 ★ `is_young()` = 一条 `test` 指令

```cpp
// heapRegionType.hpp:125
bool is_young() const { return (get() & YoungMask) != 0; }
```

`_tag` 的值：
- `FreeTag` = 0 → `0 & 2 = 0` → false
- `EdenTag` = 2 → `2 & 2 = 2` → true
- `SurvTag` = 3 → `3 & 2 = 2` → true
- `OldTag` = 16 → `16 & 2 = 0` → false

**x86_64 汇编**（预期）：
```asm
; is_young()  - 1 条指令，1 cycle
  test   byte ptr [rdi+offset], 0x02    ; 4字节 _tag 的最低字节 & YoungMask
  setne  al                             ; AL = (ZF==0) ? 1 : 0
```

**如果用数字枚举**（设计替代）：
```asm
; 如果 Tag 是 0,2,3,4,12,13,16,32,56,57 纯数字枚举
; is_young = (tag == EdenTag || tag == SurvTag) — 需要 4-5 条指令
  mov    eax, [rdi+offset]       ; 加载 tag
  cmp    eax, 2                  ; tag == Eden?
  je     .L_true
  cmp    eax, 3                  ; tag == Survivor?
  setne  al                      ; 结果取反
.L_true:
  ; 3-4 cycles vs 1 cycle
```

**为什么 1 cycle 差异是致命的？**

`is_young()` 的调用路径：
1. **每次 Young GC CSet 遍历**：对所有 CSet Region 调用 → 单次 GC 可达数十到数百个 Region → `is_young()` 被调用数百次
2. **每次并发标记 Claim Region**：`is_humongous()` 也有类似设计（`(tag & HumongousMask) != 0`）→ 标记 cycle 中每个对象检查 → 数百万次
3. **累积效应**：假设一次 GC 周期内 `is_young()` / `is_humongous()` 被调用 500 万次 → 每次省 2 cycles = **10M cycles ≈ 2-5ms** — 在 200ms 的 Young GC 中占 1-2.5%

### 4.2 其他 bit 查询

| 方法 | 实现 | 含义 |
|------|------|------|
| `is_young()` | `(tag & 2) != 0` | Eden(2) 和 Survivor(3) 都满足 |
| `is_humongous()` | `(tag & 4) != 0` | Starts(12) 和 Continues(13) 都满足 |
| `is_old()` | `(tag & 16) != 0` | Old(16), OpenArchive(56), ClosedArchive(57) 都满足 |
| `is_old_or_humongous()` | `(tag & (16\|4)) != 0` | 一次 AND 匹配 Old + Humongous |
| `is_archive()` | `(tag & 32) != 0` | OpenArchive(56), ClosedArchive(57) |
| `is_pinned()` | `(tag & 8) != 0` | Humongous(12,13) + Archive(56,57) 都 pinned |

**为什么 Archive 要叠加 OldMask 和 PinnedMask？**

CDS（Class Data Sharing）加载的类元数据和字符串常量映射到 Archive Region：
- 需要 `OldMask`：从 GC 角度看它们属于 Old（不参与 Young GC）
- 需要 `PinnedMask`：不可 Evacuation（固定内容不能被移动）

叠加而非独立创建新类型 → 现有的 `is_old()` 和 `is_pinned()` 直接对 Archive Region 返回 true → 无需在 GC 代码中到处增加 Archive 特殊判断。

### 4.3 `_tag` 的 volatile 声明

```cpp
// heapRegionType.hpp:93
volatile Tag _tag;
```

`_tag` 是 volatile 的原因是：Concurrent Mark 线程读写 `is_humongous()`/`is_old()` 时，mutator 线程可能同时在更新 Region 类型（如 `set_old()`）。volatile 保证跨线程的可见性。

---

## §五 ★ 状态机 — Free→Eden→Survivor→Old→Free（不含 RETAINED）

### ❓ 为什么没有 RETAINED 类型？

```
                                Free(0)
                              ↗   ↑   ↖
                         set_eden │    set_survivor / set_old
                            /     │         \
                         Eden(2)  │      Survivor(3)
                            \     │         /
                    GC: 对象被搬走  │    年龄++ ≥ threshold
                    Region 清空     │         ↓
                            ↓     ↓      Old(16)
                         set_free → Free(0) ← Mixed GC 回收

  注：Eden Region 在 GC 后自身回到 Free(0)（存活对象复制到 Surv/Old Region，Eden 清空）。
  Region 类型的生命周期是 Free→Eden→Free→Eden→Free→...，不是 Free→Eden→Survivor→Old。
  Survivor 和 Old 是独立的目标 Region——从 Free 分配而来，不是从 Eden "升级"而来。
```

**旧文档错误的 "RETAINED 状态"**：当 Evacuation Failure 发生时（目标 Region 没有空间容纳复制的对象），旧文档常称该 Region 进入 "RETAINED 状态"。但事实上：

- `HeapRegionType` 枚举中没有 `RetainedTag`
- Evacuation Failure 后的 Region，`_type` **仍然是 Old 或 Survivor**——没有改变
- 改变的是 `_evacuation_failed` 字段被设为 `true`

**两个正交维度**：

| 维度 | 字段 | 控制什么 | 值域 |
|------|------|---------|------|
| 结构类型 | `_type` | GC 怎么扫描这个 Region（Young/Old skips differently） | 6 种有效 Tag |
| 故障状态 | `_evacuation_failed` | GC 要不要回收这个 Region | true/false |

如果不正交，而是合并为 12 种 type（Old+Failed、Survivor+Failed 等）→ 位编码需要至少再多 1 bit → 但 `is_old()` 的 `(tag & OldMask)` 需要排除 "Old+Failed" 这个新组合 → 复杂度翻倍。

### 5.1 状态转换表

| 转换 | 触发函数（源文件:行号）| 前置条件 + 面试关键点 |
|------|---------------------|---------|
| Free → Eden | `HeapRegion::set_eden()` (`heapRegion.cpp:164`) | Region 在 free_list 中，被 mutator TLAB refill 取出 |
| Free → Survivor | `HeapRegion::set_survivor()` (`heapRegion.cpp:178`) | 作为 Evacuation 目标 Region 被分配（GC worker 需要新的 to-space）|
| **Eden → Free** | `hr_clear()` → `set_free()` (`heapRegion.cpp:157`) | **★ 存活对象被搬走，Region 清空回 free_list。Region 类型是 Eden→Free，不是 Eden→Survivor！** 对象被复制到 Survivor Region 里，但 Eden Region 自身清空后回到 Free。对象移动 ≠ Region 类型升级 |
| Survivor → Old | `HeapRegion::move_to_old()` (`heapRegion.cpp:185`) | `age() >= tenuring_threshold` → `relabel_as_old()` —— 注意 `relabel_as_old()` 内部有 3 分支：`is_eden→set Old` / `is_free→set Old` / 其他→`Surv→Old` |
| Old → Free | `HeapRegion::set_free()` (`heapRegion.cpp:157`) | Mixed GC 完全回收后 → `hr_clear()` → `insert_into_free_list()` |
| Any → Old | `HeapRegion::set_old()` (`heapRegion.cpp:193`) | 直接设置为 Old（如 humongous 对象被回收后，其占用的 Region 回 free_list 之前先标 Old） |
| Free → StartsHumongous | `HeapRegion::set_starts_humongous()` (`heapRegion.cpp:210`) | 分配巨型对象 → `top() == bottom()` 检查 |
| Free → ContinuesHumongous | `HeapRegion::set_continues_humongous()` (`heapRegion.cpp:223`) | 紧跟在 StartsHumongous 后面 → `first_hr->is_starts_humongous()` 前置条件 |

**`set_eden_pre_gc()`** (`heapRegion.cpp:171`) 是一个特殊的直接转换：
- Survivor → EdenPreGC：当上次 GC 的 Survivor Region 在下一次 GC 时被选为新的 Eden
- 通过 `set_eden_pre_gc()` 直接设置 `_type = EdenTag`（跳过 Survivor 阶段）

### 5.2 年轻代 Region 数量约束（跨文件）

**源码位置**：`g1YoungGenSizer.hpp:76-77`

```cpp
// g1YoungGenSizer.hpp:76-77
uint _min_desired_young_length;  // 年轻代最小 Region 数
uint _max_desired_young_length;  // 年轻代最大 Region 数
```

默认值计算（`calculate_default_min/max_length`）：
- `_min_desired_young_length` = `heap_regions * G1NewSizePercent / 100`（默认 G1NewSizePercent=5 → 2048 × 5% ≈ 102）
- `_max_desired_young_length` = `heap_regions * G1MaxNewSizePercent / 100`（默认 G1MaxNewSizePercent=60 → 2048 × 60% = 1228）

加上 G1ReservePercent（默认 10%）预留不分配：
- 可用 Region 上限 = 2048 × (1 - 10%) = 2048 × 90% ≈ 1843

**这些约束在哪里被使用？**

在 `g1Allocator.cpp` 的 `should_allocate_mutator_region()` 中：
- 年轻代 Region 数（Eden + Survivor）≥ `_max_desired_young_length` → 不再分配新的 Eden Region
- 年轻代 Region 数 < `_min_desired_young_length` → 必须分配

这解释了为什么**年轻代不是越多越好**——它是 5%-60% 的动态自适应窗口。

---

## §六 ★★ free_list — 非循环有序双向链表

### ❓ 为什么不是循环链表？

**源码位置**：`heapRegionSet.hpp:155-212`

```cpp
// heapRegionSet.hpp:159-164
class FreeRegionList : public HeapRegionSetBase {
private:
  HeapRegion* _head;  // hrm_index 最小
  HeapRegion* _tail;  // hrm_index 最大
  HeapRegion* _last;  // 有序插入缓存（last inserted position）
};
```

**验证非循环**：`heapRegionSet.cpp:271`

```cpp
// heapRegionSet.cpp:271
guarantee(_head == NULL || _head->prev() == NULL, "_head should not have a prev");
```

以及 `heapRegionSet.cpp:294`：
```cpp
guarantee(_tail == NULL || _tail->next() == NULL, "_tail should not have a next");
```

**不是循环链表的证明**：
- 空链表：`_head == _tail == _last == NULL`
- 非空链表：`_head->prev() == NULL`（源码强制断言），`_tail->next() == NULL`（源码强制断言）
- `_head` 和 `_tail` 之间没有 `_tail->next = _head` 的循环连接

**循环链表的问题**：
- 判空歧义：循环链表的 `head == tail` 无法区分"空链表"和"只剩一个节点"
- 需要额外计数器 `_count` 来判空 → `add`/`remove` 时维护 → 多一次内存写入
- 非循环链表：`_head == NULL` 就是空 → 一条 NULL 检查，O(1) 判空

**❓ 为什么不用数组？**

数组 `_regions[2048]` 已经存在（`G1HeapRegionTable`，用于 O(1) 地址→Region 索引映射）。如果用一个数组维护空闲 Region：
- 分配：扫描位图 O(n/64) → 比 O(1) 慢（虽然都是常数但链表头部取更直接）
- 回收：按 `hrm_index` 有序插入 O(n) → 数组需要移位 O(n)
- 连续 Region 批量分配（如 Humongous 需要 2+ 个连续 Free Region）：数组的 `find_contiguous` 比链表的 `allocate_free_regions_starting_at` 更复杂

**链表的设计优势**：
- `remove_region(from_head)`: O(1) 头部取（`remove_from_head_impl` 4 行代码）
- `add_ordered(hr)`: O(n) 有序插入，但 `_last` 缓存优化后摊还 O(1)（连续回收相邻 Eden Region 时从 `_last` 起步而非 `_head`）

**`_last` 缓存优化**（`heapRegionSet.inline.hpp:63-67`）：

```cpp
// heapRegionSet.inline.hpp:63-67
if (_last != NULL && _last->hrm_index() < hr->hrm_index()) {
  curr = _last;  // 从上次插入位置起步，而非 _head
} else {
  curr = _head;
}
```

当连续回收相邻 Eden Region 时（hrm_index 单调递增），每次从 `_last` 起步 → 几乎 O(1) 插入。

---

## §七 ★★ JVM 初始化 — 从 mmap 到 2048 个活 Region

### ❓ 2048 个 Region 是怎么来的？

```
G1CollectedHeap::initialize()
  ├── G1HeapRegionSize 计算（G1 决定 Region 大小）        ← §7.0
  ├── 创建 6 个 G1RegionToSpaceMapper                      ← §7.1
  ├── HeapRegionManager::initialize()                      ← §7.2
  │     └── _regions.initialize(base, end, GrainBytes)     → 建立地址→索引映射
  │     └── _available_map.initialize(2048)                 → 2048 bit 位图
  └── HeapRegionManager::expand_by(2048, _workers)          ← §7.3
        └── make_regions_available(0, 2048, _workers)
              ├── commit_regions()                          → 6 个 mapper 同步 commit
              │     └── _heap_mapper->commit_regions(0, 2048, workers)
              │     └── _prev_bitmap_mapper->commit_regions(...)
              │     └── _next_bitmap_mapper->commit_regions(...)
              │     └── _bot_mapper->commit_regions(...)
              │     └── _cardtable_mapper->commit_regions(...)
              │     └── _card_counts_mapper->commit_regions(...)
              ├── for i = 0..2047:
              │     └── new_heap_region(i) → new HeapRegion + HeapRegionRemSet
              │     └── initialize(mr) → 设 _bottom/_end/_top = bottom
              │     └── insert_into_free_list(at(i)) → add_ordered
              └── _available_map.par_set_range(0, 2048)
```

### 7.0 G1HeapRegionSize 计算 — 2048 的唯一解

**源码位置**：`heapRegion.cpp:64-111`

```cpp
// heapRegion.cpp:64-70
void HeapRegion::setup_heap_region_size(size_t initial_heap_size, size_t max_heap_size) {
  size_t region_size = G1HeapRegionSize;
  if (FLAG_IS_DEFAULT(G1HeapRegionSize)) {  // 用户没有手动设置 -XX:G1HeapRegionSize
    size_t average_heap_size = (initial_heap_size + max_heap_size) / 2;
    region_size = MAX2(average_heap_size / TARGET_REGION_NUMBER,  // 8GB/2048=4MB
                       MIN_REGION_SIZE);                           // 至少 1MB
  }
  // 取 2 的幂（向下取整）
  int region_size_log = log2_long((jlong) region_size);
  region_size = ((size_t)1 << region_size_log);  // 4MB = 1 << 22
  
  // 卡在 [1MB, 32MB] 范围
  if (region_size < MIN_REGION_SIZE) region_size = MIN_REGION_SIZE;
  else if (region_size > MAX_REGION_SIZE) region_size = MAX_REGION_SIZE;
}
```

**不同堆大小下的 Region 大小**：

| 堆大小 | 计算 | Region 大小 |Region 数 | 备注 |
|--------|------|------------|---------|------|
| 4GB | 4GB/2048=2MB | 2MB | 2048 | 正好 2 的幂 |
| 8GB | 8GB/2048=4MB | 4MB | 2048 | ★ 本文标准配置 |
| 16GB | 16GB/2048=8MB | 8MB | 2048 | 2 的幂 |
| 32GB | 32GB/2048=16MB | 16MB | 2048 | 2 的幂 |
| 64GB | 64GB/2048=32MB | 32MB | 2048 | 达到上限 |
| 1GB | MAX(1GB/2048=0.5MB, 1MB)=1MB | 1MB | 1024 | 下限保护 |

**两个隐藏约束锁定了 2048→4MB 的推导**：

1. **2 的幂约束**（`heapRegion.cpp:72-76`）：`log2_long(region_size)` 仅取整数 part → 必须是 ≤ 目标值的最大 2 的幂。8GB/2048=4MB 本身就是 2 的幂（2²²），所以直接满足。

2. **[1MB, 32MB] 范围**（`heapRegionBounds.hpp:35,42`）：4MB 在范围内。极端情况下，堆 < 2GB 时 Region = 1MB（下限），堆 > 64GB 时 Region = 32MB（上限）。

**结论**：2048 不是"选出来的"，是**一系列硬约束下的唯一解**。如果要改，必须同时对三者做同等调整：调整 `TARGET_REGION_NUMBER`（改 Region 数上限）、调整 `MAX_REGION_SIZE`（放宽上限）、并接受 RSet 开销变化——三者互相锁死。

### 7.1 为什么是 6 个 Mapper？

| # | Mapper | 映射内容 | 大小（8GB 堆）|
|---|--------|---------|-------------|
| 1 | `_heap_mapper` | 堆对象空间（obj 在这里）| 8GB |
| 2 | `_prev_bitmap_mapper` | Prev 标记位图（1 bit/字 = 总字数/8）| ~128MB |
| 3 | `_next_bitmap_mapper` | Next 标记位图 | ~128MB |
| 4 | `_bot_mapper` | BOT 偏移表（每 Region 1024 条目 × 1B = 1KB/Region）| 2048 × 1KB ≈ **2MB** |
| 5 | `_cardtable_mapper` | CardTable（1 byte/卡，卡大小=512B）| 8GB/512B ≈ **16MB** |
| 6 | `_card_counts_mapper` | per-card refinement counts（1 byte/卡）| ≈ **16MB** |

**❓ 为什么各自独立管理而不是合并成一个大 Mapper？**

6 种空间有不同的访问模式和保护需求：
- **bitmap** 在 GC 期间被批量 `mprotect` 切换读写（2 个 bitmap 交替读写）
- **cardtable** 在 GC 期间被 barrier set 密集写入
- **BOT** 只在对象分配时写，GC 扫卡时读

合并成一个 Mapper → 无法独立 commit/uncommit → 释放堆空间时无法同步释放辅助结构 → 内存泄漏。

### 7.2 HeapRegionManager::initialize() — 建立地址映射

**源码位置**：`heapRegionManager.cpp:35-82`

```cpp
// heapRegionManager.cpp:65
_regions.initialize(reserved.start(), reserved.end(), HeapRegion::GrainBytes);
```

`G1HeapRegionTable` 继承自 `G1BiasedMappedArray<HeapRegion*>`——这是一个**带偏移**的稀疏数组：
- 通过 `(addr - heap_base) / GrainBytes` 直接计算 Region 索引 → O(1) 寻址
- 不需要遍历 2048 个元素的数组

### 7.3 为什么 13 个 GC worker 参与 commit？

**源码位置**：`heapRegionManager.cpp:116-136`

```cpp
// _heap_mapper->commit_regions(index, num_regions, pretouch_gang);
```

commit 后，内核对已 commit 的虚拟地址首次访问时触发 **page fault** → 分配物理页。

**❓ 单线程 vs 多线程的性能差异有多大？**

理论最坏情况（无 THP 时）：
- 8GB / 4KB = **200 万次** page fault
- 每次 page fault ~10μs → **约 20 秒** — 不可接受

**现代 Linux 的 Transparent Huge Pages（THP）大幅减少 page fault 数**：
- THP 将连续 512 个 4KB 页合并为一个 2MB 大页
- 实际 page fault 数 ≈ 8GB / 2MB ≈ **4096 次**
- 4096 × 10μs ≈ 40ms — 即使单线程也只是 40ms

但这只算了 page fault 本身——pretouch 并非只为触发 page fault，还包括：
- `madvise(MADV_HUGEPAGE)`：建议内核使用大页
- 零页填充验证：确保所有页确实可读写（否则后续访问时 SIGBUS）
- 这涉及 8GB 内存的实际写入操作，受内存带宽限制

13 个 worker 的并行加速：
- `G1PageBasedVirtualSpace::pretouch()` 使用 `PretouchTask` 将地址空间按 worker_id 分区
- 每个 worker 负责其区间的内存访问和零页检查
- 将内存带宽饱和开销从单线程分摊到 13 核 → ~8x 加速（非理想 13x，受内存控制器带宽瓶颈约束）

**设计替代分析**：如果不用并行 pretouch → 单线程逐页访问 8GB → 即使有 THP，写入 8GB 内存仍需 ~150ms（单通道 DDR4 理论 ~17GB/s，实际 ~10GB/s）— 占 JVM 启动总时间 20%+。13 线程并行压缩到 ~20ms。

### 7.4 初始状态

```
初始化完成后：
  for each Region in [0..2047]:
    _type = FreeTag
    _top  = _bottom     (空 Region)
    _next → next region  (按 hrm_index 有序链接)
    _prev → prev region
    _head = Region[0], _tail = Region[2047]
    _num_committed = 2048
    _available_map = all 1's
```

---

## §八 GDB 验证 + 可证伪断言

### 断言 1：sizeof(HeapRegion) ≈ 432 字节

```bash
(gdb) print sizeof(HeapRegion)
$1 = 432
```

*如果输出不是 432*：说明 build 配置不同（fastdebug vs slowdebug、product vs debug）。CHECK: 在 slowdebug build 下验证。

### 断言 2：free_list 非循环，_head->_prev == NULL

```bash
(gdb) print G1CollectedHeap::heap()->_hrm._free_list._head->_prev
$2 = (HeapRegion *) 0x0
```

*如果非 NULL*：说明 `add_ordered`/`remove_region` 有 bug，或迭代器破坏了链表指针。CHECK: `heapRegionSet.cpp:271` 的 `guarantee(_head == NULL || _head->prev() == NULL)`。

### 断言 3：HeapRegion::GrainBytes = 4194304（4MB）

```bash
(gdb) print HeapRegion::GrainBytes
$3 = 4194304

(gdb) print HeapRegion::GrainWords
$4 = 524288          # 4194304 / 8

(gdb) print HeapRegion::CardsPerRegion
$5 = 8192            # 4194304 / 512
```

*如果输出不是 4194304*：说明 `-Xms` 或 `-Xmx` 不是 8GB。CHECK: heap size 是否为 8GB（`jinfo -flag MaxHeapSize <pid>`）。

### 断言 4：_num_committed = 2048

```bash
(gdb) print G1CollectedHeap::heap()->_hrm._num_committed
$6 = 2048
```

*如果输出 < 2048*：堆没有完全 commit（可能用了 `-XX:-AlwaysPreTouch`）。

### 断言 5：is_young() = (tag & 2) != 0，一条 test 指令

```bash
# 注意：HeapRegion::is_young() 是 wrapper，实际逻辑在 HeapRegionType::is_young()
# debug build 可能未 inline wrapper，需直接 disas HeapRegionType::is_young
(gdb) disas HeapRegionType::is_young
Dump of assembler code for function _ZNK14HeapRegionType8is_youngEv:
   0x... <+0>:  movzx  eax,BYTE PTR [rdi+0x0]   ; 加载 _tag（最低字节）
   0x... <+4>:  test   al,0x2                     ; ★ 一条 AND 指令
   0x... <+6>:  setne  al
   0x... <+9>:  ret
```

*如果 `disas HeapRegionType::is_young` 不显示 `test` 而是多行 `cmp`*：可能已被 inline 成 wrapper 内的分支。在 product build 中用 `-XX:+PrintAssembly` 从 HotSpot 反汇编日志中搜索 `is_young` 确认。

### 断言 6：初始状态全部 Free + 全部在 free_list

```bash
(gdb) print G1CollectedHeap::heap()->_hrm._free_list._length
$7 = 2048

(gdb) print G1CollectedHeap::heap()->_hrm._free_list._head->_type
$8 = {_tag = HeapRegionType::FreeTag}   # = 0
```

*如果 _length < 2048*：有些 Region 已经分配出去了（如 Archive Region）。在 JVM 刚启动时验证。

### 断言 7：TAMS 字段偏移验证

```bash
(gdb) ptype /o HeapRegion
# 输出中查找 _prev_top_at_mark_start 和 _next_top_at_mark_start 的偏移
# 预期它们相邻排列，且 _next_top_at_mark_start 在 _prev_top_at_mark_start 后面
```

*如果偏移与预估不符*：可能是 `#ifdef ASSERT` 插入了额外字段（`_containing_set`）导致后续字段偏移整体后移。

### 断言 8：EdenTag=2, SurvTag=3, OldTag=16

```bash
(gdb) print HeapRegionType::EdenTag
$9 = HeapRegionType::Eden

(gdb) print /d HeapRegionType::EdenTag
$10 = 2

(gdb) print /d HeapRegionType::SurvTag
$11 = 3

(gdb) print /d HeapRegionType::OldTag
$12 = 16
```

*如果 EdenTag 和 SurvTag 调换*：枚举定义被修改过。CHECK: `heapRegionType.hpp:68-69`。

---

## §九 一句话总结

**HeapRegion 是 G1 的全部——4 层继承链（Space 边界→CompactibleSpace 压缩兼容→G1ContiguousSpace G1 专用层→HeapRegion 完整字段），432 字节 4 组字段（空间 hot → 类型 warm → 关系 warm → 统计 cold），TAMS 双缓冲让 Mixed GC（只读 prev）和并发标记（读写 next）互不干扰，free_list 非循环用 `_head->prev==NULL` 一条指令判空取代循环链表的额外计数器，类型位编码让 `is_young()` 在 1 cycle 内完成（vs 数字枚举 3-4 cycles），Evacuation Failure 不是新类型而是 `_type` 和 `_evacuation_failed` 两个正交维度的叠加——2048 个 Region 是 2 的幂 × [1MB,32MB] × TARGET_NUMBER 三道约束的唯一解。**

---

## 附录 A：相关 JVM 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-XX:G1HeapRegionSize` | 自动计算 | 手动指定 Region 大小（会覆盖自动推导） |
| `-XX:G1NewSizePercent` | 5 | 年轻代最小占比（2048×5%=102 Regions） |
| `-XX:G1MaxNewSizePercent` | 60 | 年轻代最大占比（2048×60%=1228 Regions） |
| `-XX:G1ReservePercent` | 10 | 预留堆比例（不受分配占用） |
| `-XX:+AlwaysPreTouch` | false | 启动时并行 commit（13 worker 加速） |
| `-XX:G1HeapWastePercent` | 5 | 允许浪费的堆比例（影响 Mixed GC 选策） |

**日志关键输出**：
```bash
-XX:+PrintGCDetails -XX:+PrintHeapAtGC -Xlog:gc+region=trace
```

**GC+region 日志示例**：
```
[0.076s][trace][gc,region   ] G1HR COMMIT(FREE) [0x0000000600000000, 0x0000000600000000, 0x0000000600400000]
[0.076s][info ][gc,heap     ] Heap region size: 4M
```

## 附录 B：与《JVM G1 源码分析和调优》对比

| 本书节 | 覆盖主题 | 本文补充 |
|--------|---------|---------|
| §2.1 分区概念 | 介绍了 Region 的基本划分 | ★ 补充"2048 推导全过程"——从 `TARGET_REGION_NUMBER` 到 2 的幂约束的推导链 |
| §2.2 停顿预测 | 预测模型 | ★ 补充"年轻代约束跨文件追踪"——`_min/max_desired_young_length` 从 `g1YoungGenSizer` 到 `g1Allocator` 的完整使用链 |
| §2.3 卡表和位图 | 基本介绍 | ★ 补充"BOT 的块粒度设计和两层结构"——`N_words` 块大小选择 + `_bot_part`（per-Region 内联）vs `_bot_mapper`（全局）的关系 |

