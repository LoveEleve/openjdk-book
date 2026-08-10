# PROMPT: 请撰写 10-PLAB.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**PLAB — GC worker 侧的 TLAB（为什么 GC worker 不能直接用 mutator 的分配方式？）**

### 核心故事线（禁止做源码翻译机！）

你读了 02 之后知道 mutator 线程通过 TLAB 做无锁 bump-pointer 分配，很快——~10 cycles。

**❓ GC worker 在 Evacuation 时也在疯狂分配对象（复制到 Survivor/Old），它为什么不直接用 mutator 的 TLAB？**

直觉答案"TLAB 是 thread-local 的，GC worker 没有 TLAB"是错的——GC worker **也可以有自己的** thread-local buffer。真正的问题是第 5 层：**13 个 GC worker 可能同时向同一个 Survivor Region 写**。mutator 的分配模型是"一个线程独占一个 Region"——但 GC worker 的 assignment 是并行的——多个 worker 同时选中同一个 Survivor Region 作为目标，必须用 CAS/lock 保护 Region 的 `_top`。

解是 PLAB（Promotion Local Allocation Buffer）：**PLAB 内部 bump（per-worker 独占、无锁 ~10 cycles）→ PLAB 满 → retire → 从 Region 切一块新的 PLAB（需要 CAS）→ new PLAB 又满 → 换代（Survivor→Old 切换）→ Old PLAB 也满 → 直接 CAS 分配进 Region → 连直接分配都失败 → Evacuation Failure 自转发**。

**PLAB 就是 GC worker 的 TLAB，但它面临 TLAB 没有的两个挑战**：
1. 和 13 个其他 worker 共享 Region 的 `_top`（TLAB 独占 Region，无此问题）
2. GC 暂停内被反复 retire（TLAB 跨 mutator phase，retire 频率低得多）

### 核心叙事线（7 个"为什么"问题，每个必须有源码回答）

1. **❓ 为什么 GC worker 不能用 mutator 的 TLAB？正确的回答是什么？** — TLAB 的前提是"一个 Region 同时只有一个线程在写"——mutator 的 Eden Region 被**恰好一个线程**独占。但 GC worker 并行 Evacuation 时，13 个 worker 同时往同一个 Survivor Region 拷贝对象。如果每个 worker 没有自己的 buffer 而直接 CAS Region._top → 13 个 worker × 每次分配都 CAS → contention 爆炸（retry loop 的 O(n²) 退化）。PLAB 的设计是：**把"需要 CAS 的分配"压缩到"偶尔 retire 时才 CAS 申请新 buffer"** → 大部分分配在 PLAB 内部用无锁 bump 完成。追问：**为什么 PLAB 这么小（几 KB），而 TLAB 这么大（~MB）？** → PLAB 只在一次 GC pause 内使用（几十到几百 ms），每个 worker 在此窗口内处理的存活对象总计几 KB 到几十 KB。TLAB 跨两次 GC 之间的整段 mutator phase（可能数秒）。追问：**如果让每个 GC worker 独占一个完整 Survivor Region（4MB）会怎样？** → 13×4MB=52MB 的 Survivor→远超实际存活量（通常几 MB）→ Region 利用率极低→大量浪费。

2. **❓ PLAB 的三级分配降级链和 mutator 的五级有什么本质不同？** — 不要贴 `copy_to_survivor_space` 的四个 if 然后说"第一个 if 是 plab_allocate，第二个是..."——这是源码翻译。要追问**为什么 PLAB 比 TLAB 少了"换 Region + Heap_lock"层级**：

   ```
   PLAB 降级链:
   Level 1: plab_allocate()                — PLAB 内 bump, 无锁, ~10 cycles
            → 失败 (PLAB 满)
   Level 2: allocate_direct_or_new_plab()  — retire + 从 Region 申请新 PLAB (CAS)
            → retire: 填充 dummy + invalidate
            → new PLAB: survivor/old_attempt_allocation (CAS Region._top)
               → 成功: set_buf() 绑定 → plab_allocate() → return
            → 失败 (Region 空间不够) → 走 direct path
            ~100-500 cycles
            → 失败 (direct path 也失败)
   Level 3: allocate_in_next_plab()        — 换代: survivor↔old 切换
            → 再回 Level 1-2 在新目标空间重试
            ~500-1000 cycles
            → 再失败
   Level 4: handle_evacuation_failure_par() — 自转发 (markOop forwarding ptr 指向自己)
   ```

   **为什么没有 Heap_lock + 换 Region 这一级？** — GC 期间所有 mutator 已停在 safepoint。没有 mutator 来并发竞争 `free_list` → 不需要 Heap_lock 这种全局大锁。PLAB refill 只用 `FreeList_lock`（仅在 region 切换时，粒度更细）。追问：**mutator 五级链有"换 Region"，PLAB 三级链有"换代"——两者是等价降级吗？** → 不是。mutator 换 Region = panic button（free_list 真的空了，要 GC），PLAB 换代 = normal fallback（survivor 满了换 old——一次 GC 内每个 worker 都会经历几次换代）。

3. **❓ 为什么 PLAB 必须 retire（dummy fill）而 TLAB 可以"留口气"（retained region）？** — 源码 `plab.hpp:53-59`（`invalidate()`），`plab.cpp:84-91`（`retire_internal()`）。PLAB retire 三步：
   1. `CollectesHeap::fill_with_dummy_object(_top, _hard_end - _top)` — 把 `[_top, _hard_end)` 填成一个 int array dummy object
   2. `_end = _hard_end; _top = _end; _bottom = _end;` — 让后续 allocate() 和 contains() 都返回 false
   3. 返回 remained = `pointer_delta(_end, _top)` — 这就是 `_wasted`

   追问：**为什么不填 dummy 会怎样？** — GC 结束前要遍历 Region 计算 liveness：`object_iterate(bottom(), top())`——每一步需要从当前对象 header 读 `size()` 跳到下一个。如果 PLAB retire 后的 `[_top, _hard_end)` 区间是未初始化的垃圾内存 → `object_iterate` 读到随机值作 size → segfault。**TLAB 为什么不需要？** — mutator Region 退休时，JVM 只在 retire 前 `fill_with_dummy_object(top, hard_end)`——但这是 optional 的（只在 `retire=true` 时）。关键是：**没有其他 reader 需要扫描退休 TLAB 的残留空间**（mutator 独占，GC 扫的是 live objects 在的 Region 而不是退休的 TLAB 碎片）。PLAB 不同——多个 worker 的 PLAB 残留在同一个 Region 中，GC 结束时必须保证整个 Region 从 bottom 到 Region._top parseable → 每个 PLAB retire 都必须 fill dummy。

   追问：**TLAB 也有 `make_parsable(true)` + `fill_with_dummy_object`，为什么说 TLAB 不需要？** → TLAB retire 确实填充了 dummy object（`threadLocalAllocBuffer.cpp:127`），但动机不同：TLAB 填充是为了让 Eden 在 GC 扫描时连续 parseable（多个 TLAB 来自同一个 Region），与 PLAB 的 dummy fill 本质相同。区别在于：TLAB 有 `_retained_alloc_region` 机制保留剩余空间继续用——PLAB 没有 retained 概念，剩余空间直接算 waste。

4. **❓ `allocate_direct_or_new_plab` 这个名字暗示了两种路径——什么时候走 retire→new_plab，什么时候走 direct？** — 源码 `g1Allocator.cpp:285-328`：
   ```cpp
   // 决策分支:
   // (A) PLAB.words_remaining() >= PLAB::min_size()
   //     → PLAB 还有"可观"空间 (≥ min_size) 但不放当前大对象
   //     → retire() old PLAB (dummy fill + 统计)
   //     → 申请新 PLAB: survivor/old_attempt_allocation(desired_plab_sz)
   //       → 成功: set_buf() 绑定新 buffer → plab_allocate() → return
   //       → 失败 → goto direct
   // (B) PLAB.words_remaining() < PLAB::min_size()
   //     → PLAB 太小，retire 本身的开销（dummy fill + 统计更新）
   //       可能比浪费的还多 → 不 retire，直接 goto direct
   // (C) direct path:
   //     → survivor/old_attempt_allocation(word_sz)  // 直接分对象, 不分 PLAB
   //     → 成功 → 记录到 _direct_allocated[]
   //     → 失败 → return NULL
   ```
   追问：**为什么 PLAB 太小就走 direct 而不是 retire 后再 get new PLAB？** → `retire()` 有 fixed overhead（dummy fill + PLABStats 更新）——如果 PLAB 只剩几个字的空间，retire 的 waste 记录中 dummy fill 的 waste 远超实际碎片。走 direct 避免了这次"虚高"统计 → 让 PLABStats 的 adaptive 公式不被污染。

5. **❓ PLABStats 的 waste accounting 为什么是闭环的？统计回路的完整链路是什么？** — 不要只列四个字段然后说"它们用了 AdaptiveWeightedAverage"。要追踪完整的数据流：

   每次 retire: `_wasted += (hard_end - top)_words` → PLABStats::add_wasted(v)
   每次 retired: `_allocated += word_sz` → PLABStats::add_allocated(v)
   GC 结束时: `flush_and_retire_stats(stats)` → 最后一个未退休 PLAB 的剩余空间 → add_unused(v)
   下一次 GC: `compute_desired_plab_sz()` 用 _allocated, _wasted, _undo_wasted, _unused + worker 数量 → 计算目标值 → `_filter.average(new_target)` → `_desired_net_plab_sz.set(…)`
   `desired_plab_sz(n_workers)` = `_desired_net_plab_sz + AlignmentReserve`

   追问：**如果这个闭环断了（比如 _unused 没有计入）会怎样？** → `compute_desired_plab_sz` 低估真实浪费 → 建议更大的 PLAB → 下轮 GC 的 PLAB 更大 → waste 更高 → 恶性循环。追问：**AdaptiveWeightedAverage 的衰减权重（默认 100）起到什么作用？** → 防止单次 GC 的异常值（如一次异常大的 Evacuation）颠覆长期趋势——类似 EMA（指数移动平均）。

6. **❓ PLAB 的 `_hard_end` vs `_end` 为什么要区分两个边界？** — 源码 `plab.hpp:40-43`：
   ```
   _bottom → _top: 已分配区域
   _top → _end: 可分配区域（_end = _hard_end - AlignmentReserve）
   _end → _hard_end: 对齐保护区（AlignmentReserve, 不参与分配）
   ```
   `AlignmentReserve` 的作用和 TLAB 的 `end_reserve()` 不同——TLAB reserve 是防止 C2 prefetch 越界（段错误保护），PLAB reserve 是防止**最后一个对象的对齐需求越过 `_hard_end` 触发 OOB**。追问：**为什么 `AlignmentReserve` 用 `arrayOopDesc::header_size(T_INT)`？（`plab.hpp:49` + `plab.cpp:46-47`）** → arrayOop 是 HotSpot 中对齐要求最严格的对象类型（需对齐到 `sizeof(jdouble)=8 字节`，header 大小=16 bytes）→ 用最严格的类型做 reserve 空间最安全。这和 TLAB 的 `alignment_reserve` 共享同一思想（`threadLocalAllocBuffer.hpp:146-148`）。

7. **❓ 为什么 `copy_to_survivor_space` 中先 PLAB allocate 再 CAS forward，而不是先 CAS 再 allocate？** — 源码 `g1ParScanThreadState.cpp:231-348`。不要只回答"乐观分配"三个字就结束——要追问**为什么乐观分配在 PLAB 场景下是最优的**：
   - PLAB allocate 是 per-worker 无锁 bump，~10 cycles——极快
   - CAS forward 是 multi-worker 竞争的 `lock cmpxchg`，~20 cycles + 可能的 retry——瓶颈在这
   - 如果先 CAS → 所有 13 个 worker 在同一个 markOop 上竞争 → 只有 winner 能 proceed → 12 个 loser 白等了 CAS
   - 如果先 allocate（乐观）：所有 13 个 worker 都先在自己的 PLAB 里分好空间 → 然后 CAS → winner 做 memcpy → loser 调用 undo_allocation() 回退
   - 在低竞争场景下（同一对象同一时间只有一个 worker 在处理，这是 Evacuation 的常见情况），先 allocate 的 winner 不需要 undo，loser 极少 → 总开销 ≈ 1 次 allocate + 1 次 CAS → 最优

   追问：**undo_allocation 具体做了什么？** → 源码 `plab.cpp:104-113`：`_undo_wasted += word_sz`（统计），然后 `_top = obj`（回退 bump-pointer 到分配前的位置）。它只记录浪费不实际 fill dummy——因为这个空间马上会被下个对象复用。

### 本文和 02/03 的关系

- **02 讲的是 "mutator 怎么用 TLAB 分配"**（per-thread Region 独占，Heap_lock 换 Region，5 级降级）
- **10 讲的是 "GC worker 怎么用 PLAB 分配"**（per-worker buffer，多 worker 共享 Region，CAS bump + 换代 + Evac Failure，4 级降级）
- **03 讲的是 "Evacuation 的大图"**（Root 扫描、RSet 扫描、TaskQueue、Steal），其中 `copy_to_survivor_space` 的 PLAB 调用是 03 的一个核心子过程——深挖在 10

**交叉引用约定**：
- `copy_to_survivor_space` 的 PLAB 分配流程 → **本文主战场** → 在 `[03-YoungGC §3.3]` 中简述 PLAB 步骤并引用本文
- `G1Allocator` 的三组 AllocRegion → 引用 `[02-ObjectAllocation §四]`
- Region 的 `_top` bump-pointer + CAS → 引用 `[01-HeapRegion §1.3]`
- `survivor_attempt_allocation` / `old_attempt_allocation` 的锁协议 → 引用 `[02-ObjectAllocation §4.3]`

### 禁止行为

- ❌ 把 `copy_to_survivor_space` 的四个 if 分支贴出来然后"第一个 if 是 plab_allocate，第二个是..."——这是翻译源码
- ❌ 只讲 PLAB 是"GC 版的 TLAB"不解释为什么设计需求不同（多 worker 共享 Region vs 单线程独占 Region）
- ❌ 不讲 `_hard_end` vs `_end` 为什么区分两个边界（AlignmentReserve 的精确理由）
- ❌ 不讲 waste accounting 的闭环（统计→滤波→反馈→自适应调整）而只讲"有四个统计字段"
- ❌ 不对比 PLAB 和 TLAB 的关键差异——这是本文的独特价值
- ❌ 不标注 PLAB retire 中 dummy fill 的精确原因（Regiion parseable 的强制需求）
- ❌ 不给出 GDB 可验证的断言

### 要求行为

- ✅ **★ 每节以 "❓ 为什么..." 开头**：先建立设计问题，再用源码做证据
- ✅ **★ PLAB vs TLAB 对比表**（≥10 行）：线程模型、锁策略、大小、生命周期、retire 方式、waste 处理、统计反馈、独占性、Region 共享模式、buffer 数量
- ✅ **★ 四级分配降级 Mermaid 图**：标注每级开销 + 失败后的下一级 + 换代决策 + Evac Failure 分支
- ✅ **★ PLABStats 自适应闭环 Mermaid**：GC 内 retire 累加 → flush → PLABStats → compute_desired_plab_sz → 下轮 GC 的 PLAB 大小反馈
- ✅ **★ `allocate_direct_or_new_plab` 的决策树**：words_remaining ≥ min_size? → retire + new PLAB / dirct
- ✅ **★ GDB 验证 ≥5 条**：
  - `sizeof(PLAB)` 用 GDB ptype/o 确认（72-96B，含 2×32B sentinel 头尾）
  - `PLAB._hard_end - PLAB._end == AlignmentReserve`
  - `G1PLABAllocator` 的三组 PLAB buffer 布局：`_surviving_alloc_buffer` / `_tenured_alloc_buffer` / `_alloc_buffers[2]`
  - `PLABStats._desired_net_plab_sz` 在 GC 前后的变化（GDB breakpoint at adjust_desired_plab_sz）
  - `PLAB._wasted` 在 `retire()` 后的增量 = `retire_internal()` 返回的 value
- ✅ **★ 设计替代分析**：每回答一个"为什么 X"，必须追问"如果不用 X 而用 Y 会怎样"
- ✅ **★ 和 02 不重复**：02 讲 mutator 侧的 TLAB→Eden→Lock→GC 降级链。10 以此为对照，讲 GC worker 侧的 PLAB→new PLAB→换代→direct→EvacFail。两者对比是 10 的独特价值

---

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（G1 Region = 4MB，2048 Regions）
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

---

## 三、聚焦源文件（行号已 grep 验证）

| # | 文件 | 模块 | 核心函数/类（行号已验证）| 本文角色 |
|---|------|------|---------------------------|---------|
| 1 | `plab.hpp` | gc/shared | `class PLAB`(L36), `_word_sz`(L39), `_bottom/_top/_end/_hard_end`(L40-43), `_allocated/_wasted/_undo_wasted`(L45-47), `AlignmentReserve`(L49), `invalidate()`(L53-59), `retire_internal()`(L63), `retire()`(L142), `class PLABStats`(L146), `_desired_net_plab_sz`(L154), `compute_desired_plab_sz()`(L169) | ★★★ PLAB 核心结构 + PLABStats |
| 2 | `plab.cpp` | gc/shared | `PLAB::PLAB()`(L44-53), `flush_and_retire_stats()`(L62-78), `retire()`(L80-82), `retire_internal()`(L84-91), `undo_allocation()`(L104-113), `PLABStats::adjust_desired_plab_sz()`(L147-190), `PLABStats::compute_desired_plab_sz()`(L192-203) | ★★★ retire + waste + adaptive |
| 3 | `plab.inline.hpp` | gc/shared | `allocate_aligned()`(L33-43), `PLABStats::add_allocated/wasted/unused`(L45-59) | ★★ bump-pointer 分配 |
| 4 | `plab.hpp`（内联实现块） | gc/shared | `allocate()`(L87-95), `set_buf()`(L122-133) | ★★★ bump-pointer + buffer 绑定 |
| 5 | `g1Allocator.hpp` | gc/g1 | `class G1PLABAllocator`(L127), `_surviving/_tenured_alloc_buffer`(L133-134), `_alloc_buffers[]`(L135), `_direct_allocated[]`(L145), `allocate_direct_or_new_plab()`(L164-166) | ★★★ GC 侧 PLAB 管理器 |
| 6 | `g1Allocator.cpp` | gc/g1 | `G1PLABAllocator::G1PLABAllocator()`(L267-279), `may_throw_away_buffer()`(L281-283), `allocate_direct_or_new_plab()`(L285-328), `undo_allocation()`(L330-332), `flush_and_retire_stats()`(L334-344) | ★★★ 三级分配降级 + 生命周期 |
| 7 | `g1Allocator.inline.hpp` | gc/g1 | `alloc_buffer()`(L65-71), `plab_allocate()`(L73-81), `allocate()`(L83-91) | ★★ inline PLAB bump |
| 8 | `g1ParScanThreadState.cpp` | gc/g1 | `copy_to_survivor_space()`(L231-348): plab_allocate(L250)→allocate_direct_or_new_plab(L256)→allocate_in_next_plab(L258)→undo_allocation(L281/L345) | ★★★ PLAB 使用者视角（四级调用链）|
| 9 | `g1ParScanThreadState.hpp` | gc/g1 | `class G1ParScanThreadState`(L45), `_plab_allocator`(L52), `_surviving_young_words`(L72) | ★★ per-worker 状态 |
| 10 | `g1EvacStats.hpp` | gc/g1 | `class G1EvacStats : public PLABStats`(L31), `_region_end_waste`(L33), `_direct_allocated`(L35), `compute_desired_plab_sz()`(L56) | ★ PLABStats 的 G1 子类 |

---

## 四、必须深度走读的核心概念

### 4.1 ★★★ PLAB 内部结构 — 和 TLAB 同构但细节不同（写作时展开为完整对比）

```
问题：
  ① PLAB 字段 vs TLAB 字段对应关系:
     PLAB._bottom  ↔ TLAB._start    (buffer 起始)
     PLAB._top     ↔ TLAB._top      (bump-pointer)
     PLAB._end     ↔ TLAB._end      (可分配尾部, 软边界)
     PLAB._hard_end ↔ TLAB._allocation_end + alignment_reserve (绝对硬边界)
     ★ 为什么 PLAB 没有 _pf_top？— PLAB 生命周期太短（一个 GC pause 内），
       C2 预取优化在 GC worker 上没有意义（不会为 GC worker 生成 prefetch 指令）

  ② PLAB 比 TLAB 多了三个统计字段 (_allocated, _wasted, _undo_wasted)，
     但少了 _desired_size / _refill_waste_limit 等调优字段:
     ★ 为什么？— PLAB 大小由集中式的 PLABStats 管理（一次 GC 内所有 worker 的
       PLAB 大小统一），不需要 per-PLAB 的独立调优字段。TLAB 是 per-thread 分散
       自适应，每个 TLAB 需要自己的 _desired_size。

  ③ PLAB 的 allocate() 是内联的简单 bump (无 CAS):
     if (pointer_delta(_end, _top) >= word_sz) {
       res = _top; _top += word_sz; return res;
     }
     ★ 为什么 PLAB bump 不需要 CAS?
     — PLAB 是 per-worker 独占的(每个 GC worker 有自己的 PLAB)，
       同一 PLAB 同一时间只有一个 worker 在写。

  ④ retire_internal() 三步:
     a) fill_with_dummy_object(_top, _hard_end) — 使区间 parseable
     b) invalidate(): _end=_hard_end; _top=_end; _bottom=_end — 使后续查看无效
     c) return _hard_end - _top (old top, 前) = '_wasted'
```

### 4.2 ★★ PLABStats 自适应闭环（完整数据流）

```
问题：
  ① 统计输入四元组:
     _allocated:   本轮 GC 所有 PLAB 的总分配量 (words)
     _wasted:      每次 retire 产生的内部碎片累加 (words)
     _undo_wasted: CAS forward 失败 undo 产生的浪费 (words)
     _unused:      最后一个 PLAB 在 GC 结束时未退休部分的剩余空间 (words)
     ★ 注意区分 _wasted 和 _unused 的来源:
       _wasted 是 per-retire 的 dummy fill 浪费 (每次 PLAB 退休时计入)
       _unused 是最后一次 flush 时计入 (最后一个 PLAB 在 GC 结束没退休,
       剩余空间不算 _wasted 因为没填充 dummy——flush_and_retire_stats 会单独处理)

  ② compute_desired_plab_sz() 输出:
     _desired_net_plab_sz (不含 AlignmentReserve)

  ③ desired_plab_sz(n_workers) = _desired_net_plab_sz + AlignmentReserve
     → 这个值是下次 GC 给每个 worker 分配 PLAB 时的 targeted size

  ④ adaptive filter: AdaptiveWeightedAverage(weight=100)
     → EMA 平滑: 新值对当前值的影响 = (1/weight) = 1%
     → 防止单次 GC 异常颠覆趋势
```

### 4.3 ★★ `allocate_direct_or_new_plab` 决策树

```
问题：
  ① 源码: g1Allocator.cpp:285-328

     决策路径:
       if (PLAB.words_remaining() >= PLAB::min_size())
         // 当前 PLAB 还有可观空间但不够当前对象
         → retire() current PLAB → 尝试 survivor/old_attempt_allocation(desired_plab_size)
           → 内部: ① CAS bump current Region → ② 失败则 FreeList_lock + 换新 Region
           → 获得新 buffer → set_buf() 绑定 → plab_allocate() 在新 PLAB 中分配
           → 没获得 → goto direct

       else  // PLAB 太小不值得 retire
         → goto direct

       direct:
         → survivor/old_attempt_allocation(word_sz) → 直接分对象, 不分缓冲区
         → 成功 → 记录到 _direct_allocated[] → return
         → 失败 → return NULL

  ② 为什么 retire 前要检查 words_remaining >= min_size()?
     两个理由:
     (a) 太小了 retire 也没浪费多少 → retire overhead (dummy fill + stats) 可能 > 浪费
     (b) 不 retire → PLAB 保持原状 → 下次小对象分配时还能继续用这个 PLAB
```

### 4.4 ★ TLAB vs PLAB 关键对比（写为完整表格，≥10 行）

```
维度              TLAB                           PLAB
使用者            mutator 线程                   GC worker 线程
Region 独占       是 (一个 Region 同期一个线程)    否 (多 worker CAS 共享 Region._top)
分配锁            bump 无锁                       bump 无锁, refill 需 CAS/FreeList_lock
生命周期            跨 mutator phase (两次GC间)     单个 GC pause 内
大小                ~100KB-2MB (自适连)           ~1KB-16KB (自适应+GC内动态变化)
retire 方式        retained region (复用剩余)       dummy fill (保持 Region parseable)
waste 处理         Eden used/capacity              per-PLAB 累加→闭环 PLABStats
统计反馈            TLAB::GlobalTLABStats           PLABStats 闭环(+_wasted vs _unused 分开)
Region 切换锁       Heap_lock (全局)                FreeList_lock (更细粒度)
换 Region 策略      有 (free_list 空=panic)         无 (GC 内不会真没空间, 真没了=Evac Failure)
为什么没 prefetch  C2 为 mutator 生成 prefetch      C2 不为 GC worker 生成 prefetch
满分              ~10 cycles (CPU pipeline)       ~10 cycles (相同 CPU 流水线)
```

### 4.5 ★ 从 `copy_to_survivor_space` 看 PLAB 的全貌

```
问题：
  ① copy_to_survivor_space 中 PLAB 调用链 (g1ParScanThreadState.cpp:231-348):
     Level 1 (L250): obj_ptr = plab_allocate(dest_state, word_sz)
     Level 2 (L256): obj_ptr = allocate_direct_or_new_plab(dest, word_sz, &refill_failed)
     Level 3 (L258): obj_ptr = allocate_in_next_plab(state, &dest, word_sz, refill_failed)
     Level 4 (L264/L318): handle_evacuation_failure_par(old, old_mark) → 自转发
     Undo   (L345):     _plab_allocator->undo_allocation(dest_state, obj_ptr, word_sz)
                        (CAS forward 失败—我抢先分好了空间但别人先 CAS 成功了)

  ② ★ 面试追问: 为什么先 allocate 再 CAS, 而不是先 CAS 再 allocate?
     不是"乐观分配"三字就能回答的——必须解释为什么在 PLAB 场景下乐观是最优的:
     - 13 个 worker 同时处理同一个 old object 的概率接近 0
       (G1ParScanThreadState 有自己的 task queue，同一对象只被一个 worker 出队)
     - 只有跨 Region 引用导致两个 worker 同时看到同一对象时才会竞争
     - 在此低竞争场景下, 先 allocate 的 undo 代价 (回退 bump-pointer) < CAS 竞争的代价
```

---

## 五、文章结构（§〇 ~ §七 + 附录）

```
§〇 源文件清单（10 文件，标注模块归属 + 行号已验证）

§一 ★ 全景 — GC worker 的分配问题
  ❓ 为什么 GC worker 不能直接用 mutator 的 TLAB？
  1.1 mutator TLAB 的两个前提（Region 独占 + per-thread 无竞争）被并行 GC 打破
  1.2 PLAB 的设计哲学：per-worker buffer + shared Region with CAS
  1.3 ★ TLAB vs PLAB 对比表（≥10 行, 覆盖 11 个维度）

§二 ★★ PLAB 结构 — GC worker 的 bump-pointer 缓冲区
  ❓ PLAB 为什么需要两个边界（_end 和 _hard_end）？
  2.1 PLAB 字段全景（_bottom/_top/_end/_hard_end/_word_sz + 三个统计字段）
  2.2 AlignmentReserve = arrayOopDesc::header_size(T_INT) = 16B
      为什么是 arrayOop header? (最严格对齐要求)
  2.3 set_buf() — 从 Region 切一块绑定到 PLAB（_bottom/_top/_end/_hard_end 一次性绑定）
  2.4 allocate() — 内联无锁 bump（10 cycles, 同构于 TLAB）
  2.5 🆚 vs TLAB: 为什么没有 _pf_top? 为什么没有 _desired_size? 为什么 PLAB 这么小?

§三 ★★★ 四级分配降级链 — copy_to_survivor_space 中的逐级退路
  ❓ 为什么 PLAB allocate(L1) 在前，CAS forward 在后——而不是反过来？
  3.1 Level 1: plab_allocate()（无锁 bump, ~10 cycles, >90% 命中）
  3.2 Level 2: allocate_direct_or_new_plab()（retire + new PLAB / direct CAS）
      3.2.1 retire() 内部: fill_with_dummy_object → invalidate → stats.add_wasted(...)
      3.2.2 new PLAB 申请: survivor/old_attempt_allocation → CAS Region._top
            → set_buf() 绑定新 buffer → plab_allocate() 在新 PLAB 中分配
      3.2.3 direct path: 直接 survivor/old_attempt_allocation(word_sz)
  3.3 Level 3: allocate_in_next_plab()（换代: survivor↔old）
      为什么不直接 Evac Failure 还要先换代试试？（多数活对象去 Survivor，但如果 Survivor 满了，Old 还有空间——换代是廉价退路）
  3.4 Level 4: handle_evacuation_failure_par()（自转发—markOop 转发指针指向自己）
  3.5 ★ 四级降级 Mermaid 决策树（标注每级开销 + 换代决策 + EvacFail 分支）
  3.6 先 allocate 再 CAS forward 的原理: undo_allocation 的实现和代价

§四 ★★ G1PLABAllocator — 三组 PLAB 的统一管理
  ❓ 为什么分 surviving / tenured 两组 PLAB，而不是所有对象共用同一组？
  4.1 G1PLABAllocator 结构（_surviving_alloc_buffer / _tenured_alloc_buffer / _alloc_buffers[2]）
  4.2 _survivor_alignment_bytes: 为什么大部分情况下是 0?
      (SurvivorAlignmentInBytes == ObjectAlignmentInBytes → 0, 无对齐需求)
  4.3 _direct_allocated[]: 跳过 PLAB 直接进 Region 的对象统计
  4.4 从 G1Allocator 到 G1PLABAllocator 的桥接
      → survivor_attempt_allocation / old_attempt_allocation 的锁协议 → 引用 [02 §4.3]

§五 ★★ PLAB 生命周期 — retire / flush_and_retire / undo
  ❓ 为什么 PLAB 的 retire 必须填充 dummy object？
  5.1 retire(): fill_with_dummy_object → invalidate → _wasted += ...
      ★ 为什么必须填充? → 保证 Region parseable (其他 reader 如 object_iterate 能跳对象)
      ★ 为什么 invalidate 三个指针 (_end/_top/_bottom 都置到 _hard_end)?
         → 强制后续所有 allocate() 和 contains() 返回 false, 防止误用已退休 PLAB
  5.2 flush_and_retire_stats(): GC 结束时最后一个 PLAB 的处理
      → _unused = last PLAB 剩余空间 → 计入 PLABStats (不算 _wasted, 因为没填充 dummy)
  5.3 undo_allocation(): CAS forward 失败时的回滚
      → _undo_wasted += word_sz (只记录统计, 不 fill dummy — 空间马上会被复用)
  5.4 ★ PLABStats 自适应闭环 Mermaid
      标注三个要素: ① retire 时累加 _wasted/_allocated ② GC 结束时 flush _unused
      ③ 下轮 GC 通过 adaptive filter 计算新 PLAB 期望大小

§六 ★ allocate_direct_or_new_plab 决策详解
  ❓ retire → new PLAB vs direct allocate 到底怎么选？
  6.1 决策树 (words_remaining vs min_size → retire vs direct)
  6.2 may_throw_away_buffer() 策略
      当 allocation_word_sz * 100 < buffer_size * ParallelGCBufferWastePct 时
      → 申请的对象太小 → PLAB relative waste 太高 → 直接扔了 PLAB 走 direct
  6.3 从 Region 申请新 PLAB 的 CAS 竞争分析
      survivor_attempt_allocation 内部两阶段: ① CAS bump → ② 失败则持 FreeList_lock 换 Region

§七 GDB 验证 + 可证伪断言（≥5 条）
  断言 1: sizeof(PLAB) = 72-96B (GDB ptype/o 确认, 含 head[32]/tail[32] sentinel)
  断言 2: PLAB._hard_end - PLAB._end = AlignmentReserve (GDB 打印验证, ~16B)
  断言 3: G1PLABAllocator 的 _surviving_alloc_buffer / _tenured_alloc_buffer offset
           (GDB ptype/o 确认三组 buffer 布局)
  断言 4: PLABStats._desired_net_plab_sz 在 GC 前后的变化
           (GDB b PLABStats::adjust_desired_plab_sz → p this->_desired_net_plab_sz)
  断言 5: _wasted 在 retire() 后增量 = retire_internal() 返回值
  断言 6: plab_allocate() hit rate > 90% (GC log 验证: direct_allocated vs PLAB allocated)
  断言 7: AlignmentReserve == typeArrayOopDesc::header_size(T_INT) / HeapWordSize = 2
```

---

## 六、与 01/02/03 的交叉引用

| 引用点 | 本文位置 | 目标文档 |
|--------|---------|---------|
| Region 的 `_top` bump-pointer + CAS | §3.2.2, §6.3 | `[01-HeapRegion §1.3]` |
| G1Allocator 三组 AllocRegion（mutator/survivor/old） | §4.4 | `[02-ObjectAllocation §四]` |
| survivor_attempt_allocation / old_attempt_allocation 锁协议 | §3.2.2, §4.4 | `[02-ObjectAllocation §4.3]` |
| free_list 取新 GC alloc region | §3.2.2 | `[01-HeapRegion §六]` |
| G1AllocRegion::attempt_allocation → CAS → attempt_allocation_locked → FreeList_lock | §6.3 | `[02-ObjectAllocation §3.2-3.3]` |
| copy_to_survivor_space 全貌 + CAS forward + memcpy | §3.1-3.6 | `[03-YoungGC §3.3]` 简述 + 引用本文 |
| Evacuation Failure 处理 + markOop 自转发 | §3.4 | `[03-YoungGC §3.5]` |

## 七、写作要求（继承 01/02 的方法论）

1. **★ 每节以 "❓ 为什么..." 开头** — 06 阶段统一格式
2. **★ PLAB vs TLAB 对比表**（纯新建——02 没有对比，本文必须做，≥10 行）
3. **★ Mermaid 图 2 张**：四级分配降级决策树 + PLABStats 自适应闭环（标注 _wasted/_unused 的区分）
4. **★ 设计替代分析**：每回答一个"为什么 X"，必须追问"如果不用 X 而用 Y 会怎样"
5. **★ 跨文件约束追踪**：`AlignmentReserve` 来自 `arrayOop` header size；`min_size()` 受 `MinTLABSize` 约束
6. **★ 可证伪断言 ≥5 条**（建议 7 条，含 PLAB sizeof、_hard_end-_end、waste 增量、desired_plab_sz 变化、hit rate、AlignmentReserve 值）
7. **★ 源码行号全部 grep 验证**（本文已提供验证过的行号）
8. **★ 和 02 不重复**：02 讲 mutator 侧的 TLAB→retained→current→Heap_lock→GC 降级链。10 以 02 为对照，讲 GC worker 侧的 PLAB→new PLAB→换代→direct→EvacFail。对比是 10 的独特价值，不是重复叙述
9. **★ 特别注意区分 _wasted 和 _unused**：两者都是"浪费"但来源不同——_wasted 是 per-retire dummy fill，_unused 是最后一个未退休 PLAB 的剩余。PLABStats 的自适应公式同时需要两者

## 八、输出格式

- Markdown 文件，命名为 `10-PLAB.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/06-gc-memory/`
- 元信息头：标准环境 + 源文件清单（10 文件，行号已验证）+ 前置依赖（`[01-HeapRegion]` + `[02-ObjectAllocation]`）+ 阅读收益
- 阅读收益强调：理解 GC worker 侧的分配机制是理解 03（Young GC Evacuation）、08（Mixed GC）和 09（Full GC）的前提——所有 GC 类型的对象复制都经过 PLAB
