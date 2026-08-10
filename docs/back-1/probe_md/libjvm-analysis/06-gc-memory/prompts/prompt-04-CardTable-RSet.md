# PROMPT: 请撰写 04-CardTable-RSet.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**CardTable + Remembered Set（RSet）—— G1 如何让每次引用写入为 GC 铺路**

### 核心故事线（禁止做源码翻译机！）

你已经读了 01（HeapRegion：Region 字段、TAMS、free_list）、02（对象分配）、10（PLAB）和 03（Young GC：RSet 是"垃圾回收的逆索引"），现在需要深挖这个"逆索引"本身的全部机制——从 mutator 一条 `obj.f = value` 的写屏障开始，到 GC 时 `oops_into_collection_set_do` 从 RSet 中找到所有跨 Region 引用。

**★ 和 03 §四 的边界**：03 只简述了 RSet 三级结构 + `oops_into_collection_set_do` 在 Young GC Evacuation 阶段的位置——读者只知道"RSet 是逆索引，GC 用它找到谁引用了 CSet 中的对象"。本文要回答的是：**这个逆索引是怎么建造的？怎么维护的？怎么查询的？如果按最简单的设计（每个 Region 存一个数组 of (src_region, offset)）会有什么问题？**

**❓ 如果 G1 没有 RSet，Young GC 需要做什么才能找到所有指向 CSet 的引用？**

```
没有 RSet 的 G1：
  Young GC 要回收 Eden + Survivor Regions
    → 需要知道 "谁引用了这些 Region 中的对象"
      → 必须扫描所有 Old Region（全堆扫描）来找到跨 Region 引用
        → 8GB 堆，200 个 Old Region × 4MB = 800MB 扫描
          → 每次 Young GC 额外 ~50ms（纯扫描，还不算处理）
            → MaxGCPauseMillis=200ms 根本不可能做到

有 RSet 的 G1：
  Young GC 只需扫描 CSet Region 的 RSet
    → RSet 直接告你 "Region 5 的第 3 卡、Region 18 的第 47 卡... 引用了你"
      → 只扫这些脏卡（通常几百到几千张卡，每张 512B）
        → ~1MB 扫描（vs 800MB）
          → MaxGCPauseMillis=200ms 可实现
```

这就是 RSet 的价值：**把 O(All Old Regions) 的全堆扫描压缩为 O(Dirty Cards per CSet Region) 的按需扫描——用 mutator 的每一条引用写入代价（写屏障 ~20 cycles）换 GC 暂停的缩减（~50ms → ~5ms）。** 这是一种经典的 **amortized work** 策略。

### 完整的故事线

```
Mutator 写引用：  obj.f = value
  →
  写屏障 (G1BarrierSet::write_ref_field_post)
    ├─ value 是 NULL? → 跳过
    ├─ obj 在 Young? → 跳过（Young GC 会全扫 Young，不需 RSet 记录"谁引用了 Young"）
    ├─ obj 和 value 在同一个 Region? → 跳过（同 Region 引用自洽，GC 回收该 Region 时整体处理）
    └─ 跨 Region 引用 → 脏化 obj 所在的 Card（CardTable::mark_card）
        → enqueue 到 per-thread DirtyCardQueue（无锁，容量 256）
```

`obj` 在 Old 且 `value` 指向 Young 时必然不同 Region → 触发卡脏化。但 barrier 本身不做 CSet 检查。
          → buffer 满?: CAS 入队到全局 completed_buffers_head
            → G1ConcurrentRefineThread 从 completed_buffers 取 buffer
              → 逐卡扫描 → 判断是否是热卡（Hot Card Cache）
                → 冷卡: 更新目标 Region 的 RSet 条目
                → 热卡: 存入 Hot Card Cache，GC 时才批量处理
                  →
                  RSet 三级存储：
                    SparsePRT (初始，card→region 哈希表)
                      → 超过阈值(默认5)? → FinePRT (卡位图，1bit/card)
                        → FinePRT 满了? → Coarse (整 Region 1 bit: "这个 Region 可能引用了目标")
                          ↓
GC 时读取 (oops_into_collection_set_do)：
  遍历 CSet Region 的 RSet
    → Sparse: 直接查哈希表找对应的卡（最精确，只扫确切脏卡）
    → Fine: 遍历位图中标记的卡（可能有未脏的误报）
    → Coarse: 遍历整个"可能引用" Region 的所有卡（4MB=8192张，最粗）
      → 对每张脏卡: 扫描卡内对象 → do_oop_evac → push task queue
```

### 核心叙事线（12 个"为什么"问题，每个必须有源码回答）

**❓ 宏观问题（面试级）**

1. **❓ 为什么 Card 是 512B？不是 64B（更精确定位）也不是 4KB（更少内存开销）？**
   
   这是一个经典的 **memory vs precision tradeoff**。分析三个数量级的利弊：
   
   | 卡大小 | Card 数量 (2048 Regions × 4MB) | CardTable 内存 | 单个引用写入的影响范围 |
   |--------|------|------|------|
   | 64B | 128M 张卡 | 128MB | 脏化一张卡 = 标记 64B 范围（极精确，但 RSet 也极大） |
   | 512B (G1) | 16M 张卡 | 16MB | 脏化一张卡 = 标记 512B 范围（平衡点） |
   | 4KB | 2M 张卡 | 2MB | 脏化一张卡 = 标记 4KB 范围（太粗，GC 时多扫太多无用对象） |
   
   **CardTable 结构**：`_byte_map` 是个 `jbyte[]`（16MB），每字节表示一个卡的状态（dirty/clean）。**为什么用 `jbyte[]` 而不是 `bitmap`？** → `mark_card_deferred` 用 CAS 原子标记一个 byte：`CAS(byte, G1CardTable::g1_young_card_val(), dirty_card_val())`。如果用 bitmap，标记一个 bit 需要 RMW（Read-Modify-Write）：读 byte → OR bit → CAS 写回 byte。这个 RMW 在 mutator 热路径上比 direct byte CAS 慢 2~3 倍，而且 CAS 竞争窗口更大（bit 冲突概率 > byte 冲突概率）。**每个卡一个完整 byte 是"用 16MB 内存换 ~10 cycles per write barrier"的经典 tradeoff。**
   
   追问：**512B 是怎么来的？** 源码 `cardTable.hpp:234` 中 `card_shift = 9`（2^9=512）。为什么是编译时常量？→ 因为 JIT 编译器在生成代码中直接嵌入 `address >> card_shift` 的位移指令。如果运行时可变→ 每次都要除法→ ~30 cycles vs ~1 cycle。
   
   追问：**如果对象很大（比如 5KB 的 byte[]），写其中一个引用字段会脏化多少张卡？** → 1 张。卡脏化基于**字段地址**（`byte_for(p)`），不是对象大小。一个引用字段占 8 字节，所以无论 `obj` 有多大，只脏化覆盖该字段的那一张卡。

2. **❓ 为什么 G1 需要写屏障（Write Barrier）来脏化卡片，而不是靠 JIT 编译器或解释器主动标记？**
   
   2019 年的一篇论文统计：Java 程序中 **每 50~200 次引用写入** 才发生一次跨 Region 写入。如果每次引用写入都无条件脏化卡片，写屏障开销≈ 每次引用写入 ~30 cycles——但 80% 以上的写入都在同一个 Region 内或被优化跳过了。所以 G1 的写屏障不是"每写必卡"，而是**有条件过滤**：同 Region 不卡、Young 不卡、NULL 不卡。
   
   **设计替代分析**：如果不靠写屏障，靠 GC 时全堆扫描→ 每次 Young GC 多 ~50ms。如果不靠写屏障，靠 JIT 编译器插桩→ 每次引用写入多 3~5 条指令（5~15 cycles），但无过滤（所有写入都慢）。G1 选择**运行时屏障 + 快速过滤**。

3. **❓ 为什么 per-thread DirtyCardQueue 可以无锁？如果 buffer 满了怎么办？**
   
   `DirtyCardQueue`（`dirtyCardQueue.cpp`）的 producer（mutator）端完全无锁——每个线程有自己的 buffer（256 entries of `void*`）。**无锁的根基在基类 `PtrQueue`（`ptrQueue.hpp`）的三字段设计**：`_buf`（buffer 指针）、`_sz`（容量 256）、`_index`（per-thread 独占的写入游标）。`_index` 是 bump-pointer 递减模式：初始 `_index = _sz`，每次 enqueue 先 `_index--` 再写 `_buf[_index]`。因为是 per-thread 独占，减下标不需要 CAS。

   buffer 写满（`_index == 0`）才 CAS 入队到全局 `_completed_buffers_head`（单链表头插）。消费者（Refinement 线程）通过 CAS pop 头部完成 buffer。

   **256 entries 为什么是这个数？**
   - 太小（如 16）：频繁入队到 completed list → CAS 竞争 + 消费者被频繁唤醒
   - 太大（如 4096）：一个 buffer 攒太多卡 → 消费者处理一次耗时过长 → mutator 申请新 buffer 时可能触发 GC（在 `allocate` 路径上）
   - 256 = 2KB（256 × 8B）：小于一个 L1 cache line group 的范围，也是 JVM 在 `g1_globals.hpp:111` 中 `G1UpdateBufferSize=256` 的默认值

4. **❓ 为什么 G1ConcurrentRefine 需要在后台异步处理 dirty cards，而不是在 GC 中一次性处理？**
   
   如果 GC 才处理：每次 Young GC 暂停要额外扫 10000+ dirty cards → ~5ms 额外暂停。分摊到 mutator 时间：Refinement 线程利用 mutator 运行期间的空闲 CPU 核，悄悄处理 dirty cards → 到 GC 时只剩很少的残留卡。
   
   **Refinement 线程的激活策略**：不是"一直在跑"，而是有**自适应休眠**——`completed_buffers_num` 达到阈值才唤醒（`G1ConcRefinementThresholdStep`）。这也带有前向反馈的设计哲学：不等累积到 GC 才处理，而是在 mutator 期间就逐步消耗。
   
   追问：**为什么 Refinement 要限制处理时间（`G1ConcRefinementServiceIntervalMillis`）？** → 如果无限处理，Refinement 会占满 CPU，影响 mutator 的吞吐。

5. **❓ RSet 的三级结构（Sparse→Fine→Coarse）——为什么需要"降级"（degradation）机制？每一级的触发条件是什么？降级代价多大？**
   
   ```
   SparsePRT: 初始状态 — 线性探测哈希表（5 个源 Region 槽位）
     每个槽位存: {source_region_idx (4B) + N×card_idx (4B/card)}，N=G1RSetRegionEntries
     为什么初始是哈希表而不是数组？→ 大多数 Region 只被 <5 个其他 Region 引用 → 5 slot 的 hash 足够了
     为什么用线性探测？→ 缓存友好 + 无额外 GC 堆分配（全 inline）
   
   FinePRT: SparsePRT 的某个 slot 溢出（卡数 > N）→ 升级为 PerRegionTable
     1024B 连续内存（8192 bits，每 bit 一卡），malloc 分配
     为什么比 Sparse 慢？→ 需遍历所有 marked bits（O(cards_per_region)），但比 Coarse 精准——只扫脏卡
     为什么用 1 bit 不用 1 byte？→ 8192 bytes vs 1024 bytes → 省 8× 内存
   
   Coarse: FinePRT 满了（卡数过多）或并发标记期间降低屏障开销
     1 bit in OtherRegionsTable._coarse_map: "整个 Region N 可能引用了我"
     ★ 降级触发：(1) FinePRT 卡数超过阈值 (2) 并发标记期间避免 FinePRT 的 malloc 开销
     ★ 降级代价：GC 扫描 Coarse 需扫整个 Region（4MB=8192 cards），退化为 O(Region) 而非 O(脏卡)
     ★ 极端场景：如果 2048 Regions 全 FinePRT 互相引用 → 2048×2047×1KB ≈ 4GB RSet → 不可行
       所以降级是必须的——高连接度的 Region 必须退化为 Coarse
   ```
   
   追问：**降级是不可逆的吗？GC 后 RSet 会被重建吗？** → Cleanup 阶段 rebuild RSet（并发），将 Coarse→Fine→Sparse 逐级重建。深挖在 [07-ConcurrentMark-Phases]。

6. **❓ `oops_into_collection_set_do` 为什么是 G1RemSet 的公开入口？内部流程是什么？**
   
   这个函数的名字容易误导——它不是"扫描 CSet"，而是"扫描 RSet 来找到指向 CSet 的引用"。内部流程：
   ```
   oops_into_collection_set_do(pss, worker_id)
     → 遍历 CSet 中的每个 Region (per-worker 分摊)
       → G1ScanRSForRegionClosure::do_heap_region(r)
         → HeapRegionRemSetIterator::init(r->rem_set())
           → has_next(): 迭代 Sparse → Fine → Coarse（从精确到粗糙，先做最省事的）
             → 每张卡: CardTable::scanned_card → 扫卡内对象
               → G1ParCopyClosure::do_oop_work(p)
                 → oop obj = RawAccess::oop_load(p)
                   → if is_in_cset(obj): copy_to_survivor_space()
     ```
   
   追问：**为什么 `oops_into_cset_do` 放在 Evacuation Phase 而不是 Pre-Evacuate？** 
   → 03 已回答：RSet 扫描发现跨 Region 引用后需要立即 `copy_to_survivor_space` → 这必须在 GC alloc region 初始化之后。本文只需提到这个约束存在，引用 [03-YoungGC §四]。

7. **❓ G1HotCardCache 的设计动机——为什么需要"热卡缓存"？**
   
   "热卡"：被频繁重复 dirty 的卡——同一个引用 field 被反复写入（如循环中 `list.add(o)`）。如果不缓存到 Hot Card Cache：每次 write barrier 都走完 DirtyCardQueue→Refinement→RSet update 全路径 → 浪费 CPU。Hot Card Cache 将热卡暂存，到 GC 时才批量处理。

   追问：**怎么判断一张卡是"热卡"？** → `G1CardCounts` 表（per-Region per-card 的 `jbyte[]`）作为**衰减计数器**记录每卡被 dirty 的次数——Refinement 处理卡片后自动减计数。达到阈值 `G1ConcRSHotCardLimit=4`（经 4 次 dirty 未被处理）晋升为热卡。不是绝对值，是持续的"被反复 dirty 但还没来得及处理"的信号。
   
   追问：**Hot Card Cache 满了怎么办？** → 全刷新 `drain()` → 所有缓存的热卡走 Refinement 路径处理掉。GC 暂停期间 `set_use_cache(false)`——原因不是"不需要"，而是**强制 drain**：mutator 已停→无新卡 dirty→正是批量处理积压热卡的最佳时机。GC 结束后 `set_use_cache(true)` 重新启用。

8. **❓ OtherRegionsTable 的三个子结构（SparseHashTable + PerRegionTable* + CoarseMap）怎么组织？为什么叫 "OtherRegions" 而不仅仅是 "Regions"？**
   
   ```
   OtherRegionsTable (per-HeapRegion)
   ├─ _coarse_map: CoarsePerRegionTable (bitmap: Region N→1 bit "可能引用了我")
   │   为什么叫 Coarse？因为粒度退化到 Region 级（不是卡级）
   ├─ _fine_grain_regions: PerRegionTable* (指针数组, 默认 0 entries)
   │   要 fine 时 malloc PerRegionTable (1024B 连续内存 = 1 bit per card)
   ├─ _sparse_table: SparsePRT (线性探测哈希表, 5 entries)
   │   初始状态，存 (card_index, region_index) 对
   └─ _n_coarse_entries: int (统计 coarse 条目数，用于触发 GC 后 rebuild 决策)
   ```
   
   追问：**为什么叫 "OtherRegions"？** → 因为 RSet 记录的是 "其他 Region 中哪些卡引用了我"——不包含自己的 Region（同 Region 引用在 Young GC 中已统一处理），不包含 Humongous 的特判。所以是 "OtherRegions" 的 RSet。

9. **❓ G1FromCardCache 是什么？为什么能加速 oops_into_cset_do 的扫描？**
   
   RSet 扫描的 hot path 是"从卡地址→找到卡内的对象起始地址"。通常做法：从卡首地址往 top 方向，用 BOT (Block Offset Table) 逐一查找。但 BOT 查找对一张 512B 卡可能包含多个对象起始边界 → 需要线性扫描。
   
   `G1FromCardCache` 是 per-region per-card 的对象起始地址缓存：`HeapWord* _cache[max_regions * cards_per_region]`。Refinement 处理每张卡时记录 `cache[region * cards_per_region + card] = start_address` → GC 扫描时 O(1) 跳过 BOT 查找。
   
   追问：**缓存有多大？** → 2048 Regions × 8192 cards × 8B = **128MB** — 占 8GB 堆的 1.6%。值不值得？→ BOT 二分查找每次 ~10ns（2~3 次 memory deref），128MB 换 10% GC 扫描时间 → 在 200ms GC + 13 workers 的 8GB 场景下绝对值得。
   
   追问：**缓存为何每个 (region, card) 只有 1 个 slot？** → 一张卡内对象很少（平均 3~5 个），多 slot 缓存开销大于收益。且 GC 扫描很少重扫同一张卡——主要价值是消除"起始对象查找"的 O(log n) → O(1) 的降维。

10. **❓ `obj.f = value` 一个赋值，从 CPU 指令到 RSet 更新的完整路径中，有哪些"短路"（early exit）？为什么这么设计？**

    完整路径 + 所有短路点（每条短路标注 "为什么可以跳过"）：
    
    ```
    G1BarrierSet::write_ref_field_post(oop obj, T* field, oop new_value)
      │
      ├─ Short 1: new_value == NULL? → return
      │   为什么？NULL 不需要 GC 跟踪——永远不会被回收
      │
      ├─ Short 2: obj 在 Young Region? → return
      │   为什么？Young GC 会全扫 Young → 跨 Region 引用会在 GC 时自然发现
      │   ★ 面试追问：为什么不是检查 "value 在 Young"？→ 因为 barrier 的目标是记录
      │      "谁（Old）引用了要被回收的（Young）"——方向是 Old→Young，所以检查 obj 而非 value
      │
      ├─ Short 3: obj 和 new_value 在同一个 Region? → return
      │   为什么？同 Region 引用在回收时自洽——回收该 Region 时整体处理
      │
      ├─ Short 4: mark_card_deferred(card) → card 已经脏了 → 无需 enqueue
      │   底层是 CAS 操作：多个 mutator 线程可能同时写相邻对象 →
      │   可能落到同一张卡（概率极低但需防范）→ CAS 保证只有一条 enqueue 路径
      │   为什么？一张卡脏一次和脏十次效果相同——GC 扫描整张卡
      │
      └─ enqueue card index → DirtyCardQueue
           → buffer 满 → CAS 入队 completed_buffers_head → Refinement 后台处理 → 更新 RSet
    ```

    **追问：为什么短路判断都在 mutator 热路径上而不是 defer 到 Refinement 线程？** 
    → 短路判断极简单（region comparison = 几次指针减法），节约的成本巨大（跳过 DirtyCardQueue enqueue + 线程间 CAS + Refinement 全路径）。**每快速过滤一次不需要的 card dirtying = 节省 ~50 cycles。** 假设 80% 的引用写入被过滤（实际过滤率更高），mutator 只需付出 ~50-cycle barrier 开销在 20% 的跨 Region 写入上——这是 amortized work 的基石。

    **追问：post-barrier 和 SATB pre-barrier（[05-SATB-Barrier]）同时存在时，执行顺序是什么？** 
    → pre-barrier 先（存旧值到 SATB buffer），然后 store 发生，最后 post-barrier（脏化卡）。这个顺序保证了：1) 并发标记能看到 store 之前的旧值 → snapshot 完整 2) GC 时 RSet 能看到 store 之后的跨 Region 引用。

11. **❓ post-barrier 的 card dirtying 和 store 之间有什么内存序要求？如果 card 还没标记时 GC 就扫了，会怎样？**

    G1 对 post-barrier 没有强 memory_order 要求——不是 `release` 或 `seq_cst`。原因是：store 和 `mark_card` 之间**没有必须的 happens-before 关系**——GC 总是在 safepoint 扫描 RSet，此时所有 mutator 线程已停，store buffer 已 flush（safepoint 本身就是全局 barrier）。所以即使 store 和 mark 之间重排序了，GC 时必定已全部可见。
    
    **面试追问**：那 Refinement 线程呢？它在 mutator 运行期间处理 dirty cards → 会不会看到"card dirty 了但 store 还没完成"？ → Refinement 只更新 RSet metadata（记录"Region N 可能引用了 Region M"），不读对象内容。真正读对象内容的 GC 扫描发生在 safepoint 之后——此时 store 必定完成。
    
    这是 G1 的又一个 **deferred workload** 设计：及时记录"有跨 Region 引用"这个事实（只需 mark_card），但不急于验证引用的具体位置。验证延迟到安全的 safepoint 时刻。

12. **❓ Humongous Region 的 RSet 有什么特殊处理？为什么 ContinuesHumongous 没有自己的 RSet？**

    Humongous 对象跨多个 Region：1 个 `StartsHumongous` + N 个 `ContinuesHumongous`。RSet 只挂在 `StartsHumongous` 上——`ContinuesHumongous` 不带 RSet（`is_tracked() = false`）。当 Refinement 更新 RSet 时检测到目标 covers `ContinuesHumongous` → 自动 reroute 到对应的 `StartsHumongous` Region。
    
    **为什么？** 因为巨型对象作为一个整体被回收——只有 StartsHumongous 的 RSet 需要完整记录"谁引用了这个巨型对象"。如果每个 ContinuesHumongous 都有独立的 RSet → 浪费内存 + 更新和维护开销翻倍。
    
    **追问：Young GC 期间，Humongous 对象如何参与 RSet 扫描？** → 只需扫描 StartsHumongous 的 RSet。03 中提到的 `register_humongous_regions_with_cset()` 就是确保 StartsHumongous 被加入 CSet 以便 RSet 扫描能发现指向它的跨 Region 引用。

### 和 03/05 的边界

- **03 §四**：已简述 RSet 三级结构 + `oops_into_cset_do` 在 Evacuation 中的位置。本文深挖每个结构内部。
- **05 §二**：SATB 前屏障（`write_ref_field_pre`）→ 本文只讲后屏障（`write_ref_field_post`）→ CardTable dirtying。**两个屏障共享同一个 G1BarrierSet 对象，但功能完全不同**：
  - 前屏障（SATB）：存旧值（用于并发标记 snapshot 语义）
  - 后屏障（CardTable）：脏化卡（用于 RSet 维护）

### 禁止行为

- ❌ 把三级结构（Sparse/Fine/Coarse）的名字贴出来说"这是三级"——**每级的"为什么用这个数据结构" + "什么时候触发生级/降级" + "内存开销 vs 扫描代价"必须说清楚**
- ❌ 把写屏障代码列出来说"这里做了 dirty card"——**每一条 early exit shortcut 回答"为什么可以跳过"**
- ❌ 把 RSet 只描述为"记录跨 Region 引用"——**要回答"如果没有 RSet，Young GC 需要做什么？数量级多大？"**
- ❌ CardTable 只讲"512B per card"——**要回答"为什么 512B？64B 或 4KB 会怎样？"并给出数字论证**
- ❌ 不讲 G1FromCardCache 的缓存命中如何改变扫描复杂度
- ❌ 不讲 Coarse 降级的不可逆性 → 降级是永久的，直到 Cleanup stage rebuild RSet 才恢复

### 要求行为

- ✅ **★ 每节以"❓ 为什么..."开头**
- ✅ **★ 全文核心叙事线**：写屏障（mutator）→ DirtyCardQueue → Refinement 线程 → RSet 三级存储 → GC 时的 `oops_into_cset_do`。把这 5 个环节串成一条完整的链
- ✅ **★ Mermaid 图 ≥4 张**：
  1. 全链路：4 条 shortcut 路径（NULL/同Region/Young→跳过, 跨Region→dirty）
  2. RSet 三级结构 + 升/降级决策树（含内存成本标注）
  3. DirtyCardQueue 生产者-消费者协议（mutator CAS→Refinement 消费）
  4. `oops_into_cset_do` 扫描时序：Worker-1/2 如何分摊 CSet Region 的 Sparse→Fine→Coarse 扫描
- ✅ **★ GDB 验证 ≥7 条**：
  1. CardTable `_byte_map` 大小 = 16MB（num_cards=16M） + `card_shift=9` 常量验证
  2. `sizeof(HeapRegionRemSet)` + `OtherRegionsTable` ptype/o 字段布局
  3. `sizeof(SparsePRT)` + RSHashTable 5 entries 布局（可变大小）
  4. PerRegionTable 卡位图 1024B = 8192 bits（1 bit/card）
  5. `mark_card_deferred` CAS：多线程同时 dirty 同一卡时的竞争验证
  6. Hot Card Cache 中缓存的卡 + 晋升为热卡的 CardCounts 阈值（G1ConcRSHotCardLimit=4）
  7. G1FromCardCache 缓存命中 → object_start 地址验证（O(1) 跳过 BOT）
  8. G1ConcurrentRefineThread 线程数 = max(G1ConcRefinementThreads, floor(ParallelGCThreads×GreenZone)+1)
- ✅ **★ 设计替代分析**：每个核心设计问"如果不用 X 而用 Y，会怎样"
- ✅ **★ 字段粒度显式标注**：card (512B), perRegionTable (1 bit/card), CoarseMap (1 bit/region)
- ✅ **★ 交叉引用精确**：RSet GC 扫描 → [03 §四]; SATB 前屏障 → [05 §二]; Coarse→Fine 还原 → [07-Cleanup]

---

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（G1 Region = 4MB，2048 Regions）
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- Card 大小：512B（`card_shift=9`，16M cards）

---

## 三、聚焦源文件（行号需 grep 验证）

| # | 文件 | 模块 | 核心函数/类 | 本文角色 |
|---|------|------|------------|---------|
| 1 | `cardTable.hpp/cpp` | gc/shared | `class CardTable`(L52), `_byte_map`(L57), `card_shift`(L56), `card_size`(L55), `card_size_in_words`(L54), `mark_card()`, `mark_card_deferred()` | ★★★ CardTable 核心结构 |
| 2 | `g1CardTable.hpp/cpp` | gc/g1 | `class G1CardTable : public CardTable`(L31), `g1_younger_index()` | ★★★ G1 专有的 young gen 过滤支持 |
| 3 | `g1BarrierSet.hpp/cpp` | gc/g1 | `write_ref_field_post()`, `write_ref_array_post()`, `invalidate()` | ★★★ 写屏障入口 |
| 4 | `g1BarrierSet.inline.hpp` | gc/g1 | 内联写屏障 fast path（early exit shortcuts） | ★★ 热路径过滤 |
| 5 | `dirtyCardQueue.cpp/hpp` | gc/g1 | `class DirtyCardQueue : public PtrQueue`(L36), `_completed_buffers_head`, `enqueue()` | ★★★ 写屏障 → Refinement 的桥梁 |
| 6 | `g1ConcurrentRefine.cpp/hpp` | gc/g1 | `class G1ConcurrentRefine`(L38), `class G1ConcurrentRefineThread`(L76), `refinement_threads()`, `activation_threshold()` | ★★★ Refinement 线程池 |
| 7 | `g1ConcurrentRefineThread.hpp/cpp` | gc/g1 | `class G1ConcurrentRefineThread : public ConcurrentGCThread`(L30), `run()`, `wait_for_completed_buffers()` | ★★★ Refinement 线程生命周期 |
| 8 | `g1HotCardCache.hpp/cpp` | gc/g1 | `class G1HotCardCache`(L31), `_hot_cache`, `_hot_cache_size`, `_use_cache`(L39), `insert()`, `drain()` | ★★★ 热卡缓存 |
| 9 | `heapRegionRemSet.hpp/cpp` | gc/g1 | `class HeapRegionRemSet`(L82), `_other_regions`, `OtherRegionsTable`(L52) | ★★★ RSet per-Region 管理器 |
| 10 | `sparsePRT.hpp/cpp` | gc/g1 | `class SparsePRT`(L58), `class RSHashTable`(L33), `_capacity`, `_entries`, `add_card()` | ★★★ SparsePRT + 哈希表 |
| 11 | `g1RemSet.hpp/cpp` | gc/g1 | `class G1RemSet`(L40), `class G1ScanRSForRegionClosure`(L80), `oops_into_collection_set_do()` | ★★★ GC 扫描入口 |
| 12 | `heapRegionRemSet.inline.hpp` | gc/g1 | `PerRegionTable` inline | ★ FinePRT 内联 |
| 13 | `g1FromCardCache.hpp/cpp` | gc/g1 | `class G1FromCardCache`(L29), `_cache`(L33), `add_card()`, `at()` | ★★ Start Address 缓存 |
| 14 | `ptrQueue.hpp/cpp` (gc/shared/) | gc/shared | `class PtrQueue`(L36), `_buf`, `_sz`, `_index`, `_completed_buffers_head` | ★★ DirtyCardQueue/SATBQueue 基类 |
| 15 | `g1CardCounts.hpp/cpp` | gc/g1 | `class G1CardCounts`(L30), `_card_counts`(L33) | ★★ 每张卡被 dirty 的次数统计（热卡判断） |

> 以上行号均需在撰写前 grep 验证，不可直接引用。

---

## 四、文章结构（§〇 ~ §九 + 附录）

```
§〇 源文件清单（15 文件，标注模块归属 + grep 验证行号）

§一 ★ 全景 — 如果没有 RSet，Young GC 需要做什么？
  ❓ RSet 解决了什么数量级问题？
  1.1 无 RSet 的替代方案 → O(Old Regions) 全堆扫描
  1.2 "每条引用写入 ~20 cycles 换 GC 暂停 ~50ms → ~5ms" 的数量级论证
  1.3 写屏障 + RSet = Amortized Work 策略

§二 ★★★ CardTable — 卡表脏化
  ❓ 为什么 512B 而不是 64B 或 4KB？
  2.1 CardTable 结构（16MB byte_map）
  2.2 mark_card / mark_card_deferred（为什么需要 CAS？）
  2.3 为什么 card_shift 必须是编译时常量（JIT 生成的 code 中直接嵌入位移）
  2.4 ★ G1BarrierSet::write_ref_field_post() 的 4 个 shortcut 全走读（含内存序分析 + pre/post 屏障执行顺序）

§三 ★★★ DirtyCardQueue + G1ConcurrentRefine
  ❓ 为什么 per-thread 无锁队列？为什么不在 GC 中一次性处理脏卡？
  3.1 DirtyCardQueue：buffer 256 entries，无锁 enqueue
  3.2 buffer 满 → CAS → completed_buffers_head（生产者-消费者协议）
  3.3 G1ConcurrentRefineThread 生命周期：唤醒阈值 + 处理时限 + 自适应休眠
  3.4 为什么 Refinement 线程数随 completed_buffers_num 自适应调整？

§四 ★★★ (NEW) G1HotCardCache + CardCounts
  ❓ 为什么需要热卡缓存？什么卡是"热卡"？
  4.1 CardCounts：每张卡被 dirty 的次数统计（per-region per-card 数组）
  4.2 热卡阈值：G1ConcRSHotCardLimit=4
  4.3 HotCardCache：缓存热卡 → GC 暂停期间批量处理
  4.4 ★ 为什么不缓存所有卡？→ 缓存占用内存 + 批量处理延迟 → tradeoff

§五 ★★★ RSet 三级结构
  ❓ 为什么需要三级？如果只有一级（如只有 FinePRT），会怎样？
  5.1 OtherRegionsTable 整体组织
  5.2 SparsePRT：5-entry 线性探测哈希表，为什么初始用哈希而不是数组？
  5.3 FinePRT (PerRegionTable)：1024B 卡位图，什么时候从 Sparse 升级？
  5.4 Coarse：Region 级 1 bit，什么时候从 Fine 降级？
  5.5 ★ 升/降级决策树 Mermaid
  5.6 ★ 降级代价：Coarse 把 GC 扫描从 O(脏卡数) 退化为 O(Region 大小)

§六 ★★ HeapRegionRemSet — per-Region 的 RSet 管理器
  ❓ 为什么 RSet 是 per-Region 嵌入而不是集中式管理？
  6.1 HeapRegionRemSet 字段布局（嵌入在 HeapRegion._rem_set，~100B header）
  6.2 ★ 局部性优势：回收 Region-N 时只需读 Region-N 的 RSet——集中式需 hash lookup 所有 Region
  6.3 ★ 并行性优势：GC 多 worker 扫描不同 CSet Region 的 RSet → 嵌入式天然无竞争，集中式需要锁
  6.4 is_tracked() 条件：Free Region（无对象→无 RSet需要），ContinuesHumongous（委托给 StartsHumongous）
  6.5 ★ RSet 生命周期：创建（Region init）→ Refinement 线程更新（mutator-time）→ GC 读取 → Cleanup 重建

§七 ★★★ G1RemSet 的 GC 扫描入口
  ❓ oops_into_collection_set_do 内部流程
  7.1 G1ScanRSForRegionClosure：分摊 CSet Region 给不同 worker
  7.2 HeapRegionRemSetIterator：迭代 Sparse→Fine→Coarse（精确→粗糙，优先最小工作量）
  7.3 逐卡扫描：卡片 → 找对象 → do_oop_evac → push task queue
  7.4 ★ G1FromCardCache 加速：如何用每卡 1 个指针的缓存跳过 BOT 查找
  7.5 ★ 并行分摊策略：如何保证不同 worker 不重复扫描同一个 Region 的 RSet？

§八 ★★ 全链路时序图 — 一个 obj.f=value 赋值的完整旅程
  8.1 Mermaid 时序图：Mutator → Write Barrier → 4 shortcuts →
      DirtyCardQueue → Refinement Thread → RSet 更新/降级
  8.2 GC 时：oops_into_cset_do → Sparse→Fine→Coarse 三级迭代 → do_oop_evac
  8.3 所有并发组件的时间线：mutator写屏障(always) | Refinement处理(async) | GC扫描(safepoint)

§九 GDB 验证 + 可证伪断言（≥7 条）
  断言 1: CardTable_byte_map 大小 = num_cards = 16M（8GB/512B）
  断言 2: sizeof(SparsePRT) 含 5-entry RSHashTable（每 entry = regionIdx 4B + N cards），总 < 200B
  断言 3: PerRegionTable 卡位图 = 1024B（8192 bits / 8 bits/byte）
  断言 4: DirtyCardQueue buffer = 256 × sizeof(void*) = 2048B
  断言 5: mark_card_deferred CAS 竞争验证（同一卡被多线程同时 dirty 时的 CAS winner/loser，概率极低但必须正确）
  断言 6: Hot Card Cache size 默认值 + 验证卡升级为热卡的阈值
  断言 7: G1FromCardCache 缓存命中后的 object_start 地址 = 实际对象起始地址
  断言 8: G1ConcurrentRefineThread 线程数 = max(G1ConcRefinementThreads, floor(ParallelGCThreads×G1ConcRefinementGreenZone)+1)
```

---

## 五、交叉引用

| 引用点 | 本文位置 | 目标文档 |
|--------|---------|---------|
| Region 类型（Eden/Survivor/Old/Free） | §六（is_tracked 过滤） | `[01-HeapRegion]` |
| Young GC Evacuation 中 RSet 扫描简述 | §七（oops_into_cset_do 深挖） | `[03-YoungGC §四]` |
| SATB 前屏障（write_ref_field_pre） | §二（vs 后屏障对比） | `[05-SATB-Barrier §二]` |
| Refinement 线程的暂停协议 | §三（suspendibleThreadSet） | `[06-ConcurrentMark-Core]` |
| RSet Cleanup 重建 | §五（Coarse→Fine 还原） | `[07-ConcurrentMark-Phases §Cleanup]` |
| Hot Card Cache GC 期间关闭 | §四（flush） | `[03-YoungGC §二]` |
| G1Policy RSet 长度预测（_rs_lengths） | §六（统计累积） | `[08-MixedGC-Policy]` |

---

## 六、写作要求

1. **★ 每节以"❓ 为什么..."开头**
2. **★ 设计替代分析**：每回答一个"为什么 X"，追问"如果不用 X 而用 Y 会怎样"
3. **★ 可证伪断言 ≥7 条**（含 GDB 命令 + 预期输出）
4. **★ Mermaid 图 ≥4 张**：全链路 4 shortcuts + 三级升/降级决策树 + 生产者-消费者协议 + GC 扫描时序
5. **★ 字段粒度显式标注**：card (512B), perRegionTable (1 bit/card), CoarseMap (1 bit/region)
6. **★ 源文件行号全部 grep 验证后再写**（不直接引用本文档中的行号）
7. **★ 和 03/05 不重复**：03 简述 RSet 是逆索引（收尾段），05 讲 SATB 前屏障——04 是 RSet 全链深挖
8. **★ 短路径的数量级论证**：卡大小 512B vs 64B vs 4KB 的内存比较表、没有 RSet 时的全堆扫描 vs 有 RSet 的按需扫描对比
9. **★ 面试友好**：核心叙事线完整到可以在面试中 5 分钟讲完 "从 obj.f=x 到 GC 发现这个引用"

---

## 七、输出格式

- Markdown 文件，命名为 `04-CardTable-RSet.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/06-gc-memory/`
- 元信息头：标准环境 + 源文件清单（15 文件，行号 grep 验证）+ 前置依赖 + 阅读收益
- 阅读收益强调：读完本文后能回答"如果面试官问'G1 的 RSet 是什么？为什么能减少 GC 暂停？'——你能从 mutator 的 obj.f=x 这条语句出发，追踪到 GC 时 oops_into_cset_do 的所有中间环节，并回答每个环节的'为什么是这个设计'"
