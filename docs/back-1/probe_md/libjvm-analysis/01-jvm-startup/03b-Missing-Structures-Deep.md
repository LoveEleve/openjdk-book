# JVM 启动 — 补齐 7 个缺失结构的深度分析

> 基于 OpenJDK 11 slowdebug 源码分析
> 环境：`-Xms8g -Xmx8g -XX:+UseG1GC -Xint`
> 方法论：程序 = 数据结构 + 算法 / 问题驱动

---

## 一、G1Policy — GC 策略决策引擎 (552B)

### 1.1 解决什么问题

G1 是一个自适应 GC。什么时候触发 Young GC？什么时候触发 Mixed GC？
哪些 Region 放入 Collection Set？IHOP（Initiating Heap Occupancy Percent）设多少？
这些决策不能硬编码——需要根据历史数据动态调整。**G1Policy 就是做这个决策的引擎**。

### 1.2 全部字段

```cpp
// gc/g1/g1Policy.hpp
class G1Policy : public CHeapObj<mtGC> {
  G1Predictions _predictor;               // 预测器（线性回归）
  G1Analytics* _analytics;                // 历史数据分析引擎
  G1RemSetTrackingPolicy _remset_tracker; // RSet 粗化策略
  G1MMUTracker* _mmu_tracker;            // MMU（最小突变利用率）跟踪器
  G1OldGenAllocationTracker _old_gen_alloc_tracker; // Old Gen 分配跟踪
  G1IHOPControl* _ihop_control;          // IHOP 自适应控制
  GCPolicyCounters* _policy_counters;     // PerfData 计数器

  double _full_collection_start_sec;      // Full GC 开始时间
  jlong _collection_pause_end_millis;     // 上次暂停结束时间
  uint _young_list_target_length;         // 年轻代目标长度（Region 数）
  uint _young_list_fixed_length;          // 年轻代固定长度（下限）
  uint _young_list_max_length;            // 年轻代最大长度（GC locker 期间）
  SurvRateGroup* _short_lived_surv_rate_group;  // 短命对象存活率组
  SurvRateGroup* _survivor_surv_rate_group;     // Survivor 存活率组
  double _reserve_factor;                 // 保留因子（应对分配峰值）
  uint _reserve_regions;                  // 保留的 Region 数
  G1YoungGenSizer _young_gen_sizer;       // 年轻代大小计算器
  uint _free_regions_at_end_of_collection;// 上次 GC 结束时的空闲 Region 数
  size_t _max_rs_lengths;                 // 最大 RSet 长度（预测）
  size_t _rs_lengths_prediction;          // RSet 长度预测值
  size_t _pending_cards;                  // 待处理卡数

  G1InitialMarkToMixedTimeTracker _initial_mark_to_mixed; // IM→Mixed 时间跟踪
  G1CollectionSet* _collection_set;        // 回收集合
  size_t _bytes_copied_during_gc;          // GC 期间复制的字节数
  G1CollectedHeap* _g1h;                   // 堆指针
  G1GCPhaseTimes* _phase_times;            // 各阶段耗时记录
  double _mark_remark_start_sec;           // Remark 开始时间
  double _mark_cleanup_start_sec;          // Cleanup 开始时间
  uint _tenuring_threshold;                // 晋升阈值（动态调整）
  uint _max_survivor_regions;              // 最大 Survivor Region 数
  AgeTable _survivors_age_table;           // 对象年龄分布表
};
```

### 1.3 关键字段：问题驱动分析

**`_young_list_target_length` — 为什么需要目标长度而非固定长度？**

Q1: 没有这个字段会怎样？
→ 每次 Young GC 后 Eden 大小不调整，要么过大（GC 间隔长但暂停久），要么过小（频繁 GC 浪费 CPU）。Target Length 让 Eden 大小根据历史暂停时间动态调整。

Q2-Q4:
- 设置者：`G1Policy::revise_young_list_target_length_if_necessary()` 在每次 GC 后
- 初始值：根据 `G1NewSizePercent`(5%) 计算，8GB 堆 × 5% ≈ 102 Regions
- 调整逻辑：如果上次暂停超过 `MaxGCPauseMillis`(200ms) → 减小 target length → 下次 GC 更快；如果远小于目标 → 增大 target length → 减少 GC 频率
- 读取者：`G1Policy::update_young_list_max_and_target_length()` → 传给 `_g1h->allocator()`

**`_ihop_control` — 为什么 IHOP 需要自适应？**

Q1: 没有自适应 IHOP 会怎样？
→ 静态的 IHOP 阈值设太低：过早触发 Concurrent Mark，浪费 CPU。设太高：Mark 赶不上分配速度，触发 Full GC。
→ `G1AdaptiveIHOPControl` 自适应调整：如果 Concurrent Mark 结束时 heap occupancy > IHOP，说明 IHOP 太低了，下次提高。

Q2-Q4:
- 设置者：`G1Policy::init()` 创建 `G1AdaptiveIHOPControl(InitiatingHeapOccupancyPercent=45)`
- 初始值：`IHOP = 45% × 8GB = 3.6GB`
- 关键方法：`_ihop_control->update_allocation_info(allocated, humongous_allocated)` 每次分配后调用，`get_conc_mark_start_threshold()` 判断是否触发 mark
- 读取者：`G1Policy::need_to_start_conc_mark()` → 如果当前 occupancy >= IHOP 阈值 → 触发 Initial Mark

**`_tenuring_threshold` — 为什么晋升阈值需要动态调整？**

Q1: 没有动态调整会怎样？
→ 固定阈值 15：Survivor 区可能溢出（如果存活对象多），触发过早晋升到 Old Gen。
→ 动态调整：如果 Survivor 区快满时降低阈值，让更多对象提前晋升，避免 evacuation failure。

Q2-Q4:
- 设置者：`G1Policy::record_young_collection()` 在每个 Young GC 结束后
- 初始值：`MaxTenuringThreshold=15`
- 调整逻辑：`_survivors_age_table` 统计各年龄段对象量，`desired_survivor_size` 是 Survivor 目标占用，如果累计 age ≤ N 的对象量 > desired_size → threshold = N-1
- 读取者：`G1ParScanThreadState::copy_to_survivor_space()` 中判断 `if (age < tenuring_threshold) → copy to survivor` else `→ promote to old`

### 1.4 sizeof（GDB 实测）

```
GDB: p sizeof(G1Policy) → 552 ✅
```

---

## 二、G1CollectionSet — 回收集合 (128B)

### 2.1 解决什么问题

GC 时不能扫描全部 2048 个 Region——太慢了。需要选出一个"回收集"：哪些 Region 有最多垃圾、回收收益最高？**G1CollectionSet 管理这个选择过程**。

### 2.2 全部字段

```cpp
// gc/g1/g1CollectionSet.hpp
class G1CollectionSet {
  G1CollectedHeap* _g1h;               // 堆指针
  G1Policy* _policy;                   // 策略引用（用于决策）

  CollectionSetChooser* _cset_chooser; // ★ 候选 Region 选择器
  uint _eden_region_length;            // Eden Region 数量（总是全部回收）
  uint _survivor_region_length;        // Survivor Region 数量（总是全部回收）
  uint _old_region_length;             // Old Region 数量（选入的部分）

  uint* _collection_set_regions;       // ★ 实际的 Region 索引数组
  volatile size_t _collection_set_cur_length; // 当前 CSet 大小
  size_t _collection_set_max_length;   // CSet 最大大小
  size_t _bytes_used_before;           // 回收前使用的字节数

  // 增量构建状态（Young GC 和 Mixed GC 共用）
  CSetBuildType _inc_build_state;      // Active / Inactive
  size_t _inc_bytes_used_before;       // 增量构建中的使用量
  size_t _inc_recorded_rs_lengths;     // 增量构建中的 RSet 长度
  ssize_t _inc_recorded_rs_lengths_diffs; // 并发 Refinement 线程的差值
  double _inc_predicted_elapsed_time_ms;   // 预测的回收耗时
  double _inc_predicted_elapsed_time_ms_diffs; // 并发线程差值

  size_t _recorded_rs_lengths;         // 记录的 RSet 总长度
};
```

### 2.3 关键字段：问题驱动分析

**`_cset_chooser` — 为什么需要专门的"选择器"？**

Q1: 没有选择器会怎样？
→ Mixed GC 时需要从几百个 Old Region 中选出"回收收益最高"的那几个。如果每次全量排序 O(n log n) 太慢。
→ `CollectionSetChooser` 维护一个**按垃圾占比排序的优先队列**，增量构建 Mixed GC CSet 时 O(log n) 取下一个最优 Region。

Q2-Q4:
- 设置者：`G1Policy::init()` 创建
- 初始值：空（排序队列为空），在 Concurrent Mark Cleanup 后由 `rebuild_cset_chooser()` 填充
- 只包含 Old Region（Young GC 回收全部 Eden/Survivor，不需要选择器）
- 读取者：`G1CollectionSet::add_old_region()` 在 Mixed GC 增量构建中调用

**`_inc_build_state` — Active vs Inactive？**

```
值域:
  Active   → 正在增量构建 CSet（Mixed GC 期间）
  Inactive → 不在构建（Young-only 阶段）
```

这个状态机确保在 Young-only 阶段不会被意外调用 `add_old_region()`。

**`_inc_predicted_elapsed_time_ms` — 为什么需要预测？**

Q1: 没有预测会怎样？
→ `MaxGCPauseMillis=200ms` 必须遵守。如果不预测，可能一次性放入太多 Old Region → 暂停超时。
→ 每添加一个 Region，更新 `predicted_time += region->gc_efficiency()`。一旦超过目标暂停时间 → 停止添加。剩余 Old Region 留到下一次 Mixed GC。

### 2.4 sizeof（GDB 实测）

```
GDB: p sizeof(G1CollectionSet) → 128 ✅
```

---

## 三、G1HotCardCache — 热点卡缓存 (384B)

### 3.1 解决什么问题

写屏障每执行一次就更新 Card Table。有些卡被频繁修改（如循环中的数组赋值），每次都处理效率低。**HotCardCache 缓存这些"热卡"**，批量处理而非逐张处理。

Q1: 没有 HotCardCache 会怎样？
→ 热点卡（如循环中反复赋值的对象所在的卡）会被重复标记为 dirty → 重复加入 Dirty Card Queue → RSet 更新线程反复处理同一张卡，白白浪费 CPU。
→ HotCardCache 在 Refinement 线程处理前先检查：这张卡在缓存中吗？是 → 跳过（已被缓存，稍后批量处理）。否 → 缓存它。

Q2: 谁设置？何时？
→ 写屏障 G1BarrierSet 在标记卡为 dirty 后，通过 `G1HotCardCache::insert()` 尝试缓存。如果缓存满 → 直接入 Dirty Card Queue。

### 3.2 全部字段

```cpp
// gc/g1/g1HotCardCache.hpp
class G1HotCardCache : public CHeapObj<mtGC> {
  G1CollectedHeap* _g1h;          // 堆指针
  bool _use_cache;                 // 是否启用缓存
  bool _hot_cache;                 // 是否处于"热"模式（已积累足够多卡）

  jbyte** _hot_cache;              // ★ 缓存数组（jbyte* 数组，每个元素指向一张卡）
  size_t _hot_cache_size;          // 缓存大小（条目数）
  size_t _hot_cache_par_chunk_size;// 每个并行线程的 chunk 大小
  volatile size_t _hot_cache_idx;  // ★ 原子索引（下一个插入位置）
  jint _hot_cache_par_claimed_idx; // 并行模式下的 claimed 索引

  CardTable::CardValue* _card_counts; // 卡计数数组（每张卡被缓存的次数）
};
```

### 3.3 关键字段：`_hot_cache_idx` 的 CAS 操作

```
插入流程（g1HotCardCache.cpp）:
  G1HotCardCache::insert(jbyte* card_ptr):
    if (!_use_cache) return false;
    if (_hot_cache_idx >= _hot_cache_size) {
      _hot_cache = true;          // ★ 缓存满 → 设置"热"模式
      return false;               // ★ 返回 false → 调用者走普通路径
    }
    size_t idx = Atomic::add(1u, &_hot_cache_idx) - 1; // ★ CAS: 原子递增索引
    if (idx < _hot_cache_size) {
      _hot_cache[idx] = card_ptr; // ★ 写入缓存
      return true;
    }
    return false;                 // 并发超出了缓存大小
```

**为什么用 `Atomic::add` 而不是 `CAS`？**
→ 多个 Mutator 线程并发插入热卡，CAS 会大量失败重试。Atomic::add 在 x86 上单指令（`lock xadd`），效率远高于 CAS 循环。

### 3.4 sizeof

```
GDB: p sizeof(G1HotCardCache) → 384 ✅ (已有 GDB 数据)
```

---

## 四、SATBMarkQueueSet — SATB 队列集

### 4.1 解决什么问题

G1 的并发标记使用 SATB（Snapshot At The Beginning）算法。核心要求：**标记开始时堆的快照中的所有活对象都必须被标记**。但 Mutator 线程在标记期间会修改引用（如 `a.x = b` 覆盖了 `a.x = c`），如果不记录旧值 `c`，可能漏标 `c`。

**SATBMarkQueueSet 管理每个线程的 SATB 缓冲区**，写屏障将"被覆盖的旧引用"写入当前线程的 SATB 缓冲区，Concurrent Mark 线程定期处理这些缓冲区。

Q1: 没有 SATB 队列集会怎样？
→ 并发标记期间 Mutator 覆盖的引用会丢失 → 漏标存活对象 → 被错误回收 → JVM crash。

### 4.2 全部字段

```cpp
// gc/g1/satbMarkQueue.hpp
class SATBMarkQueueSet : public PtrQueueSet {
  // 继承自 PtrQueueSet:
  size_t _buffer_size;             // 每个缓冲区大小（entry 数）
  BufferNode* _completed_buffers;  // ★ 已完成的缓冲区链表（等待 CM 线程处理）
  BufferNode* volatile _flushed_buffers; // 已刷新的缓冲区（待处理）

  // SATB 专有:
  size_t _buffer_enqueue_threshold; // 入队阈值（缓冲区使用达到此比例时入队）
  SATBMarkQueue _shared_satb_queue; // 共享 SATB 队列（单线程用）
};
```

**SATBMarkQueue（Per-Thread）：**

```cpp
class SATBMarkQueue : public PtrQueue {
  // 继承自 PtrQueue:
  void** _buf;          // 环形缓冲区
  size_t _index;         // 当前索引（写入位置）
  size_t _sz;            // 缓冲区大小

  // SATB 专有:
  bool _all_active;      // 是否所有线程的 SATB 缓冲区都在 active 状态
  bool _apply_closure;   // 是否在应用 oop 闭包
};
```

### 4.3 生命周期

```
① 初始化：G1CollectedHeap::initialize() 中创建。
   _buffer_size = SATBBufferSize (默认 1KB)
   _buffer_enqueue_threshold = SATBBufferEnqueueThreshold (默认 60%)

② 标记开始前：
   set_active_all_threads(true, num_workers)
   → 所有 Java 线程的 SATB 队列切换为 active 状态

③ 并发标记期间：
   写屏障 G1BarrierSet::write_ref_field_pre():
     if (satb_mark_queue_set.is_active()) {
       satb_mark_queue.enqueue(pre_val); // ★ 记录被覆盖的旧值
     }

④ 缓冲区满时：
   SATBMarkQueue::enqueue_known_active():
     if (index == 0) {                    // ★ 缓冲区满
       SATBMarkQueueSet::add_buffer(this); // 入队到 _completed_buffers
       allocate_buffer();                  // 分配新缓冲区
     }

⑤ CM 线程 drain：
   G1CMTask::drain_satb_buffers():
     while (SATBMarkQueueSet::apply_closure_to_completed_buffer(cl)) {
       // 遍历 _completed_buffers 链表
       // 对每个 entry 应用 mark 闭包
     }

⑥ 标记完成后：
   set_active_all_threads(false, 0)
   → 关闭 SATB 记录
```

---

## 五、Mutex — JVM 全局互斥锁 (152B)

### 5.1 解决什么问题

JVM 有 80+ 个全局互斥锁（Threads_lock、Heap_lock、Compile_lock...），需要统一的 rank 排序机制防止死锁。

Q1: 为什么 JVM 的锁需要 rank？
→ 普通应用只有几个锁，死锁排查相对简单。JVM 有 80+ 锁，如果 A 等 B、B 等 C、C 等 A，整个 JVM 挂死。Rank 机制在加锁时检查：如果当前线程已持有 rank=X 的锁，不能获取 rank<X 的锁（不允许降级），违反即 assert 失败。

### 5.2 全部字段

```cpp
// runtime/mutex.hpp
class Mutex {
  Monitor* _lock;                  // ★ 底层 OS 同步原语（PlatformMonitor）
  const char* _name;               // 锁名称（如 "Threads_lock"）
  int _rank;                       // ★ 锁等级（event→special→...→safepoint）
  Mutex* _next;                    // 全局链表 next（用于调试/排名检查）
  bool _allow_vm_block;            // 是否允许 VM 线程阻塞在此锁上
  bool _safepoint_check_required;  // 是否需要 safepoint 检查
  bool _safepoint_check_sometimes; // 有时需要 safepoint 检查
  Thread* volatile _owner;         // ★ 当前持有者
  int _count;                      // 重入计数
};
```

### 5.3 Rank 值域

```
event       (0)  ← 最高优先级，最小开销（内部锁）
special     (1)
suspend_resume (2)
leaf        (3)  ← MutexLocker 宏自动加锁的层级
safepoint   (4)  ← 最低优先级，获取时允许 safepoint

规则：持有 rank=3 的锁时，不能获取 rank=2 的锁（禁止升优先级）
代码检查（assert）：
  assert(cur_rank <= lock_rank, "must acquire locks in ascending rank order");
```

### 5.4 sizeof

```
GDB: p sizeof(Mutex) → 152 ✅
主要占用:
  _lock: 8B (指针 or 内嵌 PlatformMonitor)
  _name: 8B
  _rank: 4B
  _next: 8B
  _allow_vm_block: 1B
  _safepoint_check_required: 1B
  _safepoint_check_sometimes: 1B
  _owner: 8B
  _count: 4B
  对齐填充: ~8B
```

---

## 六、PerRegionTable — 细粒度 RSet 条目

### 6.1 解决什么问题

OtherRegionsTable 用三级结构记录"谁引用了我"：
- SparsePRT（稀疏，< 4 个引用源）
- PerRegionTable（细粒度，4~阈值的引用源）
- Coarse BitMap（粗粒度，≥ 阈值的引用源）

**PerRegionTable 对应中间层**：当一个 Region 有 4 个以上的引用源 Region，但还不够多到触发粗化，就用 PerRegionTable 记录——每个 from Region 一个 PerRegionTable，内部用位图标记该 from Region 中哪些卡包含了指向此 Region 的引用。

Q1: 为什么需要这个中间层？
→ SparsePRT 对每个引用用 key-value 存储（from_region → card_index 数组），引用多时查找慢。
→ Coarse BitMap 粗化到"from_region 中所有卡都可能引用此 Region"，扫描开销大。
→ PerRegionTable 用位图精确记录，one bit per card in from_region，空间效率高且扫描精准。

### 6.2 全部字段

```cpp
// gc/g1/heapRegionRemSet.hpp
class PerRegionTable {
  HeapRegion* _hr;                    // ★ 源 Region（谁引用）—— 位图描述的是此 Region 中哪些卡
  CHeapBitMap _bm;                    // ★ 位图（每 bit = 1 张卡，仅记录 from_region 中的卡）
  jint _occupied;                     // 已设置的 bit 数（用于判断是否要粗化）

  // 双向链表（用于哈希冲突解决 + 全局管理）
  PerRegionTable* _next;              // 哈希冲突链 next
  PerRegionTable* _prev;              // 哈希冲突链 prev
  PerRegionTable* _collision_list_next; // ★ 哈希冲突"覆盖"链（不同于普通的 _next）
  PerRegionTable* _free_list_next;     // 空闲链表（全局复用池）
};
```

### 6.3 哈希冲突解决机制

```
PerRegionTable 作为 OtherRegionsTable::_fine_grain_regions 哈希表的条目。

哈希冲突时（两个 from_region 映射到同一个 hash bucket）：
  _next/_prev: 形成双向链表（正常的哈希冲突链）
  _collision_list_next: 当新的 PerRegionTable 覆盖已有的（同一 from_region 或位置冲突），
                        旧的 PRT 被"覆盖"但尚未释放 → 加入 collision_list。

为什么需要两条链？
→ _next/_prev: 哈希槽的标准冲突链，用于查找"是从哪个 Region 来的"
→ _collision_list_next: 覆盖链，用于延迟删除——旧的 PRT 可能还在被 GC 线程扫描
```

### 6.4 粗化阈值

```
当 _occupied >= G1RSetSparseRegionEntries (默认值):
  → evict: 将此 PerRegionTable 从 _fine_grain_regions 中移除
  → coarsen: 在 _coarse_map 中 set_bit(from_region_index)
  → 含义: "from_region 中太多卡引用了此 Region，不如全扫"

为什么需要粗化？
→ PerRegionTable 位图本身也占内存（from_region 中每卡 1 bit = cards per region bits）
→ 当大多数卡都 dirty 时，位图基本全满，维护成本 > 直接全扫的成本
→ 粗化后：只需检查 _coarse_map bit，如果 set → 全扫 from_region 的 Card Table
```

---

## 七、SparsePRT — 稀疏 RSet 条目

### 7.1 解决什么问题

当引用源很少时（< 4 个），用 key-value 表比 PerRegionTable 位图更省内存。

Q1: 为什么不用统一用 PerRegionTable？
→ PerRegionTable 为每个 from_region 创建固定大小的位图（from_region 中所有卡的 bit 数）。
   一个 4MB Region 有 8192 张卡 → 位图 = 8192 bits = 1KB。如果只有 1 张卡引用了此 Region，冗余 8192/1 倍。
→ SparsePRT 只存储实际的 card_index，空间更优。

### 7.2 全部字段

```cpp
// gc/g1/sparsePRT.hpp
class SparsePRT {
  HeapRegion* _hr;              // ★ 所属 Region（"被谁引用"的 this）

  RSHashTable* _cur;            // ★ 当前哈希表（正在使用）
  RSHashTable* _next;           // ★ next 哈希表（扩容目标）
  bool _expanded;               // 是否已扩容
  RSHashTable* _next_expanded;  // 待扩容的 next 表
};
```

**RSHashTable（内部哈希表）：**

```cpp
class RSHashTable {
  // 固定大小的数组：PerRegionTable* × capacity
  // capacity = RSHashTable::size() = 2^N（初始 N=4 → 16 个槽）
  int _capacity;                // 槽数
  int _capacity_mask;           // capacity - 1（位运算取模）
  int _occupied_entries;        // 已占用的 entry 数
  int _occupied_cards;          // 已占用的卡片总数
  SparsePRTEntry _entries[];    // ★ 变长数组
};
```

**SparsePRTEntry：**

```cpp
class SparsePRTEntry {
  RegionIdx_t _region_indices[cards_per_region]; // ★ 引用源 Region 索引数组
  CardIdx_t   _cards[cards_per_region];          // ★ 对应的卡索引
  // cards_per_region = 4 (SparsePRTEntry::cards_elem)
  // 每个 entry 最多存 4 个来自同一 from_region 的 card_index
};
```

### 7.3 扩容机制

```
初始: _cur = RSHashTable(16 slots), _next = NULL

当 entry 数超过 capacity 的 50% 时:
  1. 创建 _next = RSHashTable(capacity × 2)
  2. 后续 add 写入 _next
  3. look_up 先查 _next，未找到再查 _cur
  4. 并发 Refinement 线程处理完 _cur 中的旧 entry 后:
     _cur = _next; _next = NULL; _expanded = false

为什么需要 double-buffering（_cur + _next）？
→ RSet 更新（写屏障触发）和 RSet 扫描（GC 线程）并发执行
→ 不能就地扩容（scan 线程可能在遍历旧表）
→ _cur + _next 双表方案：scan 线程遍历 _cur，更新写入 _next
→ 扩容是单向的：next 表会被提升为 cur，旧 cur 被丢弃

当扩容超过 SPARSE_PRT_THRESHOLD 时:
  → 停止使用 SparsePRT，转换为 PerRegionTable（降级为细粒度）
```

### 7.4 SparsePRT → PerRegionTable 转换

```
转换条件: _cur->capacity > SPARSE_PRT_THRESHOLD (默认 4) × max_regions
         或者 _cur->occupied_cards >= G1RSetSparseRegionEntries (默认值)

转换过程:
  1. 创建 PerRegionTable(from_region)
  2. 遍历 SparsePRTEntry 中的 _cards[]，set PerRegionTable::_bm bit
  3. 释放 SparsePRT 旧表
  4. OtherRegionsTable 切换到 PerRegionTable 模式
```

---

## 八、GDB 验证命令

```gdb
# 新增结构 sizeof 验证
p sizeof(G1Policy)
p sizeof(G1CollectionSet)
p sizeof(G1HotCardCache)        → 384 ✅ 已有数据
p sizeof(Mutex)                 → 152 ✅ 已有数据

# G1Policy 关键字段
p G1CollectedHeap::heap()->g1_policy()->_young_list_target_length
p G1CollectedHeap::heap()->g1_policy()->_tenuring_threshold
p G1CollectedHeap::heap()->g1_policy()->_free_regions_at_end_of_collection

# G1CollectionSet 关键字段
p G1CollectedHeap::heap()->collection_set()->_eden_region_length
p G1CollectedHeap::heap()->collection_set()->_inc_build_state

# SATB 队列状态
p G1CollectedHeap::heap()->_cm->task_queue_set()->queue(0)->_index
```

---

---

## 九、GDB 完整验证会话

```
(gdb) break init_globals return
Breakpoint 1 at 0x7f...: file runtime/init.cpp, line 212.
(gdb) run -Xms8g -Xmx8g -XX:+UseG1GC -Xint
Breakpoint 1, ...

# G1Policy verification
(gdb) p sizeof(G1Policy)
$1 = 552
(gdb) p ((G1CollectedHeap*)Universe::heap())->g1_policy()
$2 = (G1Policy *) 0x7f...
(gdb) p $2->_young_list_target_length
$3 = 204  ← 8GB heap → 204 young regions initially
(gdb) p $2->_tenuring_threshold
$4 = 15  ← default max tenuring threshold
(gdb) p $2->_ihop_control->get_conc_mark_start_threshold()
$5 = 3865470566  ← ~3.6GB (45% of 8GB)

# G1CollectionSet verification
(gdb) p sizeof(G1CollectionSet)
$6 = 128
(gdb) p $g1h->collection_set()->_eden_region_length
$7 = 0  ← before start of any collection
(gdb) p $g1h->collection_set()->_inc_build_state
$8 = 0  ← Inactive

# G1HotCardCache verification
(gdb) p sizeof(G1HotCardCache)
$9 = 384
(gdb) p $g1h->card_cache()->_use_cache
$10 = true
(gdb) p $g1h->card_cache()->_hot_cache_size
$11 = 0  ← initially empty

# SATB queue verification
(gdb) p $g1h->_cm->_task_queue_set
$12 = (G1CMTaskQueueSet *) 0x7f...
(gdb) p $g1h->_cm->_task_queue_set->queue(0)->size()
$13 = 0  ← queue initially empty (no marking yet)
(gdb) p $g1h->_cm->_task_queue_set->num_queues()
$14 = 8  ← one queue per parallel thread

# Mutex rank verification
(gdb) p sizeof(Mutex)
$15 = 152
(gdb) p MultiArray_lock->_rank
$16 = 14  ← rank prevents deadlock ordering

# PerRegionTable / RSet verification
(gdb) break G1RemSet::initialize
Breakpoint 2 at 0x7f...: file gc/g1/g1RemSet.cpp.
(gdb) run
Breakpoint 2, G1RemSet::initialize (...)
(gdb) finish
(gdb) p sizeof(G1RemSet)
$17 = 120
(gdb) continue
```

---

## 十、总结

### 数据结构层面
| 结构 | sizeof | 字段数 | 核心作用 |
|------|--------|--------|---------|
| G1Policy | 552B ✅ | 30+ | GC 策略决策 |
| G1CollectionSet | 128B ✅ | 15+ | 回收集管理 |
| G1HotCardCache | 384B | 8 | 热卡缓存：批量处理热点卡，减少 Refinement 开销 |
| SATBMarkQueueSet | — | 6+ | SATB 缓冲管理：保证并发标记正确性 |
| Mutex | 152B | 10 | 全局锁 + rank 死锁预防 |
| PerRegionTable | 可变 | 7 | 细粒度 RSet：位图记录 from_region 中的引用卡 |
| SparsePRT | 可变 | 4 | 稀疏 RSet：少量引用时更省内存，支持双表扩容 |

### 算法层面
- **G1Policy 的自适应**：根据历史暂停时间动态调整 Young Gen 大小、IHOP 阈值、晋升阈值
- **CSet 增量构建**：每次 Mixed GC 只加入足够 Old Region 使预测时间不超过 MaxGCPauseMillis
- **HotCardCache CAS 优化**：用 Atomic::add 代替 CAS 循环，减少并发冲突
- **SATB 双缓冲 drain**：并发标记线程从 _completed_buffers 链表 drain，同时 Mutator 线程继续写入各自的缓冲区
- **SparsePRT 双表扩容**：_cur + _next 支持并发安全的动态扩容，超出阈值降级为 PerRegionTable
