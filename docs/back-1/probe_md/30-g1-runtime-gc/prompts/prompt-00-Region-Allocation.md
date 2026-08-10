# PROMPT: 请撰写 00-Region-Allocation.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

### 故障场景：8GB 堆下 Humongous 连续分配失配

线上 Spark 应用在 shuffle reduce 阶段观察到此现象：

```
GC log 异常：
  Humongous allocation failed, word_size: 524289 (4MB+1word)
  GCDone (young): HumongousCount: 12/14, capacity: 67108864 (64MB)
  To-space exhausted -> Evacuation Failure: 16 -> Full GC

jcmd 诊断输出：
  jcmd <pid> GC.heap_info:
  Free Regions: 18 (18MB), Humongous Regions: 124 (124MB)
  Heap occupancy: 89%, 12 humongous objects spanning 124 regions
  Largest contiguous free: 3 regions (3MB) — insufficient for 4MB allocation

/proc/<pid>/maps 验证：
  堆段 size=8GB, RSS=7.8GB (已提交), mmap(MAP_NORESERVE) 产生的未提交空洞仅剩 200MB
```

**根因链**：reduce 端 `new byte[4MB]` → `MemAllocator::mem_allocate`(memAllocator.cpp:387) → 超 TLAB → `allocate_new_tlab` → 失败（TLAB refill 也过 \( \geq 1.5\% \) TLAB 阈值）→ `allocate_outside_tlab` → `G1CollectedHeap::mem_allocate` → Humongous 判定（word_size \( \geq \) Region::GrainWords/2）→ `G1CollectedHeap::allocate_humongous` → 需要 start+1 continues = 2 连续 Region → Free List 连续段最长仅 3 个 Region（且前 2 个被分配，第 3 个成碎片）→ 分配失败 → Evacuation Failure → Full GC 触发 → 12 秒 STW。

**反事实**：如果将 Humongous 对象的 starts/continues Region 布局改为不要求连续（用单独 Region 索引链），分配成功率会从 60% 提升到 98%——但跨 Region oops_do 遍历从 O(1) 退化为 O(n)，10 个 continues Region 的并发标记遍历从 ~50ns 涨到 ~500ns。

**三步诊断**（直接写进 §〇）：
```bash
# 1. Humongous 碎片化诊断
jcmd <pid> GC.run_finalization
jcmd <pid> GC.heap_info | grep -E "Humongous|Free"
# 期望：Free Regions contiguous >= 2，否则碎片严重

# 2. GDB 断点捕获分配失败
gdb -ex "break G1CollectedHeap::humongous_obj_allocate" \
    -ex "break G1CollectedHeap::attempt_allocation_humongous" \
    -ex "run" \
    -ex "print word_size" -ex "print HeapRegion::GrainWords" \
    --args java -Xmx8g -XX:+UseG1GC -XX:+PrintGCDetails ...

# 3. 验证 Free List 连续性
jcmd <pid> VM.native_memory | grep "G1FreeRegionSet"
```

---

## §一 Task + Narrative + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the complete lifecycle of G1 heap regions — from the 9-state tag machine to how a `new Object()` becomes an oop in a specific Region via TLAB/P-alloc/Humongous paths — and how the G1 Barrier Set maintains SATB snapshot consistency and Card Table remembered sets.

Reader completed **[01-02-G1-Heap-Startup]** (G1CollectedHeap constructor 18 steps, mmap reserve/commit, card table initialization), **[01-08-G1-Policy-Analytics]** (G1Policy 8 sub-components), **[01-09-G1-Concurrent-Marking-Infra]** (double-bitmap, CMTask×13). This doc: HOW the heap REGION runtime actually works — the 9-state machine that decides EVERYTHING in G1.

### Narrative: 对象从 new 到 Region 的完整旅程

一个 `new Object()` 在 G1 中的 7 步旅程：

```
Java: new Object()
  → 字节码 new #index 触发 fast_instance_alloc
  → C2 检测 TLAB 未满 → JIT 生成 bump-the-pointer 指令 (1~3 CPU cycle)
  → TLAB 满 → MemAllocator::allocate_outside_tlab (memAllocator.cpp:384)
  → G1Allocator::attempt_allocation → MutatorAllocRegion::attempt_allocation
  → par_allocate CAS 无锁分配 → 成功 (20~50ns)
  → 若失败 → attempt_allocation_locked → retire → new_alloc_region_and_allocate
    → Free List 提取 1 个 Free Region → set_eden() → G1AllocRegion::allocate
  → 最终：oop 在某 Eden Region 中，klass 指针指向 InstanceKlass
```

同时发生的屏障操作：
```
obj.field = other;  // Java 赋值字节码 putfield
  → SATB pre-write barrier: write_ref_field_pre(other) → enqueue 旧值
  → Card post-write barrier: write_ref_field_post → mark_card_deferred
  → DirtyCardQueue → 并发精炼线程 update RSet
```

### Interview Story Format Answer（必须出现在 §一 末尾）

"G1 Region 的状态机共 9 种 tag，通过 1 个 8-bit volatile Tag 字段编码（heapRegionType.hpp:64-91）：Free(0)、Eden(2)、Survivor(3)、StartsHumongous(12)、ContinuesHumongous(13)、Old(16)、OpenArchive(56)、ClosedArchive(57)，以及 PinnedMask(8) 叠加在 Humongous 和 Archive 上。每次 set_eden() 断言旧值为 FreeTag (heapRegionType.hpp:149)，is_young() 的判断是 O(1) 的位运算 `get() & YoungMask != 0` (heapRegionType.hpp:125) —— 9 态全部用位掩码而非 switch 分支，快了 ~2 个数量级。

对象分配的第一站是 TLAB：`MemAllocator::allocate()` (memAllocator.cpp:387) → `allocate_inside_tlab()` (memAllocator.cpp:375-384) 是 bump-the-pointer CAS 无锁分配；若 TLAB 满 → `allocate_new_tlab()` (memAllocator.cpp:335-372) → `G1Allocator::attempt_allocation()` (g1Allocator.inline.hpp:44-52) 先尝试 retained region → 再尝试 `MutatorAllocRegion::attempt_allocation()` CAS 路径 (g1AllocRegion.inline.hpp:73-91)。CAS 失败后走锁路径 `attempt_allocation_locked` (g1AllocRegion.inline.hpp:93-118) → `retire()` → `new_alloc_region_and_allocate()` → 从 MasterFreeRegionList 提取 Free Region → `HeapRegion::set_eden()`。

Humongous（超半 Region 大小）对象跳过 TLAB → `G1CollectedHeap::attempt_allocation_humongous()` → 分配 starts + continues 连续 Region 组。SATB Barrier `G1BarrierSet::enqueue()` (g1BarrierSet.cpp:128-146) 仅在 concurrent marking active 时工作，Java 线程走线程本地 SATB 队列（无锁），非 Java 线程加 Shared_SATB_Q_lock。Card Barrier `G1CardTable::mark_card_deferred()` (g1CardTable.cpp:34-54) 用 CAS cmpxchg 实现 wait-free 写入，`G1BarrierSet::invalidate()` (g1BarrierSet.cpp:190-227) 跳过所有 young card 并遍历剩余 region 的 card 标记为 dirty。"

### Beginner Callout Boxes（文档中必须出现的 ≥7 个 callout 框）

> **1. Bump-the-pointer 分配**
> G1 的 TLAB 分配不需要空闲链表——TLAB 内维护了 `_top` 指针（写入位置）和 `_end` 指针（TLAB 末尾）。`new Object()` 时只需：读取 `_top`，验证 `_top + obj_size ≤ _end`，返回 `_top`，`_top += obj_size`。这是 1 个 CAS 无锁操作的单线程快速路径，无需经过 `malloc` 的任何全局锁或数据结构。`retire()` 时才将剩余空间回收到堆。这就是为什么 Java 新对象分配比 C `malloc` 快 5~10 倍的根本原因。

> **2. Region 9 态位掩码 vs Switch**
> `heapRegionType.hpp:125` 的 `is_young()` 实现是 `(get() & YoungMask) != 0`——位掩码的 1 条 AND 指令。如果用 switch 语句做 9-way 分支：需要 ~9 条 CMP 指令 + 条件跳转，分支预测在 Region 类型混合（Eden+Old+Humongous 共存）时命中率仅 ~50%。位掩码 O(1) vs switch O(4.5 cycles avg) → 所有热路径上的 `is_young()` 判断加速 4~5 倍。

> **3. SATB 快照语义 vs Incremental Update**
> SATB (Snapshot-At-The-Beginning) 记录的是被覆盖的**旧值**——应用线程执行 `a.field = b` 前，先把 `a.field` 的旧值入队。这保证了并发标记的**逻辑快照**：标记开始时所有 live 对象的引用即使被修改覆盖，旧值指向的对象仍被记录为活。CMS 的 Incremental Update 记录的是**新值**——并发标记期间新增的引用。SATB 在浮动垃圾上容忍度更高（适合 G1 的 mixed GC 多轮回收），Incremental Update 漏标风险更低（适合 CMS 的单轮回收）。

> **4. 512 字节/Card 粒度的计算依据**
> G1 Card Table 的 card_shift=9 (512 字节/card) 是空间效率和时间精度的折衷：card 太小 → Card Table 膨胀（32GB 堆 512B/card → 64MB card table，256B/card → 128MB）；card 太大 → 粗粒度忆集 → 每个 card 包含更多跨 Region 引用 → Young GC 时需要扫描更多非必需区域。G1 选择 512B 因为它是 x86 中 OS 页大小（4KB）的 1/8，硬件 cache line size（64B）的 8 倍——恰好在页大小和 cache line 之间，既不浪费内存也不增加扫描开销。

> **5. StoreLoad 内存屏障在 Card Marking 中的角色**
> `G1BarrierSet::invalidate()` (g1BarrierSet.cpp:201) 在遍历 card 标记 dirty 之前发出 `OrderAccess::storeload()` ——这是最强内存屏障（x86 的 `mfence` 等效）。原因：必须保证前一条写 card 的操作对所有 CPU 可见后，才能读取 card 的当前值判断是否需要 enqueue。没有这个屏障：CPU A 写入 dirty card → CPU B 来不及看到 → CPU B 认为 card 已经是 dirty → 跳过 enqueue → 丢失忆集更新 → Young GC 可能漏标记跨 Region 引用。

> **6. PRT 三级退化（Sparse → Fine → Coarse）的本质**
> Remembered Set 跟踪"谁引用了我这个 Region 里的对象"。`OtherRegionsTable::add_reference()` (heapRegionRemSet.cpp:348-436) 的 3 级查找路径：
> ① **FromCardCache** (第 0 层) — 线程本地 map 查 card，命中率 ~97%，无锁无原子操作；
> ② **PerRegionTable** (Fine，第 2 层) — 位图 1 bit/card，`_fine_grain_regions[]` 查找；
> ③ **CoarseMap** (第 1 层) — 整个 from-region 粗粒度标记，1 bit/region。
> SparsePRT 是过渡态——新跨 Region 引用优先进 SparsePRT（有序数组存 card index），SparsePRT 满后转移到 Fine 或直接 Coarse。退化逻辑：`_n_fine_entries == _max_fine_entries` → `delete_region_table()` 退化为 Coarse (heapRegionRemSet.cpp:385-389)。

> **7. Humongous starts + continues 的连续 Region 布局**
> Humongous 对象（≥ Region/2）跨多个 Region 存储：第 1 个 Region 为 starts humongous（含对象头），后续 Region 为 continues humongous（纯数据延续）。连续的 Region 编号使 `oopDesc::is_objArray()` 可以通过 `region_index + 1` 快速定位 continues 区域，避免遍历链表。代价是连续 Region 可能不足 → 碎片化，此时需要 Full GC 的压缩阶段复原连续性。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux。

### Source roots
- `src/hotspot/share/gc/g1/` — G1 GC 核心源码 (197 文件, ~65K 行)
- `src/hotspot/share/gc/shared/` — 跨 GC 共享 (MemAllocator, PLAB, TLAB)
- `src/hotspot/os/linux/` — Linux OS 层 (mmap, commit)

### 构建命令
```bash
make jdk           # 全量构建（含 libjvm.so）
make hotspot       # 仅 HotSpot 构建（更快）
```

### 关键二进制
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — G1 全量源码编译
- 关键 syscall：
  - `man 2 mmap` — MAP_NORESERVE 预留虚拟地址空间（不占物理内存）用于 HeapRegion 映射
  - `man 2 madvise` — MADV_DONTNEED 释放已使用的 Region 物理内存
  - `man 2 mprotect` — 堆段保护（调试模式）

### 关键 Syscall 速查表

| syscall | man 段 | 在 G1 中的使用 | 关键参数 |
|---------|:---:|------|------|
| `mmap` | man 2 mmap | 堆 reserve (MAP_NORESERVE) | `PROT_READ\|PROT_WRITE`, `MAP_PRIVATE\|MAP_ANONYMOUS\|MAP_NORESERVE` |
| `munmap` | man 2 munmap | Region 释放 | 释放连续虚拟地址段 |
| `madvise` | man 2 madvise | Region 物理内存回收 | `MADV_DONTNEED` 释放物理页 |
| `mprotect` | man 2 mprotect | Debug 模式 | `PROT_NONE` 保护区 |

### G1 关键 -XX 参数

| 参数 | 默认值 | 作用 |
|------|:---:|------|
| `G1HeapRegionSize` | ~2MB (auto) | Region 大小 (1MB~32MB) |
| `TLABSize` | auto | 线程本地分配缓冲区大小 |
| `TLABWasteTargetPercent` | 1% | TLAB retire 的浪费阈值 |
| `G1HeapWastePercent` | 5% | 堆浪费阈值 |
| `InitiatingHeapOccupancyPercent` | 45% | IHOP 阈值 |
| `G1ReservePercent` | 10% | 保留 Region 百分比 |
| `G1RSetSparseRegionEntries` | auto | SparsePRT 初始条目数 |
| `G1ConcRefinementThreads` | auto | 并发精炼线程数 |
| `G1SATBBufferSize` | 1KB | SATB buffer 大小 |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **heapRegionType.hpp** | `src/hotspot/share/gc/g1/heapRegionType.hpp` | 189 | 9 态 Tag 枚举(0~57)(:64-91), `set_eden()`(:149), `set_old()`(:156), `relabel_as_old()`(:160-176), `is_young()`(:125), `is_humongous()`(:129), `is_old()`(:138) | 🔥 状态机核心 — 所有 GC 决策的基础 |
| 2 | **heapRegion.hpp/cpp** | `src/hotspot/share/gc/g1/heapRegion.hpp/cpp` | 724+922 | `setup_heap_region_size()`(:64-111), `hr_clear()`(:113-136), `allocate_no_bot_updates()`(inline.hpp), `par_allocate()`(inline.hpp) | 🔥 Region 生命周期 + 内部对象分配 |
| 3 | **heapRegionRemSet.cpp** | `src/hotspot/share/gc/g1/heapRegionRemSet.cpp` | 921 | `add_reference()`(:348-436), `card_within_region()`(:340-346), `find_region_table()`, `delete_region_table()` | 🔥 PRT 三级查找 + 退化逻辑 |
| 4 | **heapRegionManager.hpp/cpp** | `src/hotspot/share/gc/g1/heapRegionManager.hpp/cpp` | 286+607 | `commit_regions()`, `uncommit_regions()`, `expand_at()`, `find_uncontiguous_regions()` | Commit/uncommit 按需模型 + 连续 Region 查找 |
| 5 | **heapRegionSet.hpp/cpp** | `src/hotspot/share/gc/g1/heapRegionSet.hpp/cpp` | 245+366 | `FreeRegionList`(双链表), `OldRegionSet`, `MasterFreeRegionList` | Free List 三层链表管理 |
| 6 | **g1Allocator.inline.hpp** | `src/hotspot/share/gc/g1/g1Allocator.inline.hpp` | 167 | `attempt_allocation()`(:44-52), `attempt_allocation_locked()`(:54-59), `plab_allocate()`(:73-81) | 🔥 三层 AllocRegion 路由 |
| 7 | **g1AllocRegion.inline.hpp** | `src/hotspot/share/gc/g1/g1AllocRegion.inline.hpp` | 146 | `attempt_allocation()`(CAS :73-91), `attempt_allocation_locked()`(:93-118), `par_allocate()`(:54-71), `retire()`, `new_alloc_region_and_allocate()` | 🔥 CAS fast path → 锁慢路径 → retire → new region |
| 8 | **g1BarrierSet.cpp** | `src/hotspot/share/gc/g1/g1BarrierSet.cpp` | 291 | `enqueue()`(:128-146), `write_ref_array_pre_work()`(:148-158), `write_ref_field_post_slow()`(:172-188), `invalidate()`(:190-227), `on_thread_attach()`(:256-284) | 🔥 SATB + Card 双 Barrier 实现 |
| 9 | **g1CardTable.cpp** | `src/hotspot/share/gc/g1/g1CardTable.cpp` | 144 | `mark_card_deferred()`(:34-54), `initialize()`(:75-139), `g1_mark_as_young()`(:56-61), `is_in_young()`(:141-144), `_byte_map_base` 偏移计算(:130) | Card Table 操作 + 偏移计算 |
| 10 | **memAllocator.cpp** (shared) | `src/hotspot/share/gc/shared/memAllocator.cpp` | 460 | `allocate()`(:387-401), `allocate_inside_tlab()`(:375-384), `allocate_new_tlab()`, `finish()`(:411-424) | 🔥 JVM 对象分配统一入口 |
| 11 | **satbMarkQueue.cpp** | `src/hotspot/share/gc/g1/satbMarkQueue.cpp` | 358 | `enqueue()`, `flush()`, `filter()` 两指针对撞压缩 | SATB 队列管理 + Buffer 满处理 |
| 12 | **dirtyCardQueue.cpp** | `src/hotspot/share/gc/g1/dirtyCardQueue.cpp` | 373 | `enqueue()`, `flush()`, `apply_closure_to_completed_buffer()` | DirtyCardQueue 管理 |

---

## §四 Deep Dive Question Groups（7 组，每组含 counterfactual）

### 4.1 ★★★ Region 9 态状态机 — 位掩码设计 + 状态转换

```
问题：
  ① 为什么 G1 Region 用 9 种 Tag（而非传统 GC 的 3 种 Generation）？
      答案方向: heapRegionType.hpp:64-91 定义 9 种 Tag 值 Free(0)→Eden(2)→Surv(3)
      →StartsHumongous(12)→ContinuesHumongous(13)→Old(16)→OpenArchive(56)→ClosedArchive(57)，
      加上 PinnedMask(8) 叠加在 Humongous 和 Archive 上形成 StartsHumongousTag=12(HumongousMask|PinnedMask)。
      G1 需要区分 Eden∨Survivor (Young GC 处理范围不同) 和 Starts∨Continues Humongous (分配路径不同)，
      无法用 Young/Old/Perm 三代概括。每个 Tag 是全局唯一的——`is_young()` (heapRegionType.hpp:125)
      只需 1 条 AND 指令: `get() & YoungMask(2) != 0`，耗时 ≤1 CPU cycle。
      
      追问: `set_eden()` 为什么要求旧值必须是 FreeTag？
      → heapRegionType.hpp:149: `void set_eden() { set_from(EdenTag, FreeTag); }`
        进入 Eden 的 Region 必须是新分配的 Free Region——Eden 不应该从 Old/Survivor 直接转换。
        这防止了 GC 将活跃 Old Region 误标为 Eden 导致的数据损坏。
        验证: `set_from()` (heapRegionType.hpp:112-118) 中的 `assert(_tag == before)` 在 debug build 生效。

  ② 9 态中哪些状态转换是合法的？谁驱动转换？
      答案方向: 合法转换路径：
        Free → Eden (set_eden, Mutator 申请新 Region)
        Free → Survivor (set_survivor, Young GC 选中)
        Free → Old (set_old, Mixed GC 晋升)
        Free → StartsHumongous / ContinuesHumongous (Humongous 分配)
        Eden → Old (relabel_as_old, Young GC 中晋升)
        Eden → Survivor (set_eden_pre_gc, Young GC 后存活对象)
        Survivor → Old (relabel_as_old, aging 达阈值)
        Old → 无（Old Region 永不回退为 Free）
        Humongous → Free (hr_clear, eager reclaim 后释放)
      非法的:
        Old → Eden (无路径——Old 不会变回 Eden)
        Eden → Free (必须通过 GC 的 hr_clear 而不是单方面)
      转换的驱动者:
        - Young GC: Eden→Survivor, Survivor→Old, Eden→Old (晋升)
        - Mixed GC: Old→Free (回收空 Old Region)
        - Mutator 分配: Free→Eden, Free→Humongous
        - Full GC 压缩: Old 对象被压缩到一起后，空 Old→Free

  ③ 反事实: 如果 G1 用 2 代 (Young/Old) + TLAB 内 region type 区分（而非 9 态）？
      答案方向: TLAB 内无法判断 Humongous——因为 Humongous 对象不走 TLAB（单线程缓冲区只适合小对象）。
      Humongous 必须独立标记为 HumongousMask 才能走单独分配路径 (attempt_allocation_humongous)。
      如果 Humongous 合入 Old → Old region 内同时存在小对象和 4MB Humongous → 并发标记
      的 oops_do 遍历 Old region 时, 单个 4MB 对象需要构造 512K 的 oopMapEntry 数组（而非 4 个位标记）
      → 标记内存暴涨 12800 倍 (512K vs 4 ints) → 直接导致 remark 阶段 OOM。
      2 代模型无法解决"同一类型 Region 内对象大小分布差异 6 个数量级"的遍历效率问题。
```

### 4.2 ★★★ PRT 三级查找+退化 — Sparse→Fine→Coarse 切换条件

```
问题：
  ① FromCardCache → SparsePRT → Fine(PerRegionTable) → CoarseMap 的各级命中率如何？
      答案方向: heapRegionRemSet.cpp:348-436 `add_reference()`:
        第 0 层 FromCardCache (:353): `G1FromCardCache::contains_or_replace(tid, cur_hrm_ind, from_card)`
          — 线程本地缓存，97% 命中（大部分跨 Region 引用在同一线程内重复出现）
        第 1 层 CoarseMap (:363): `_coarse_map.at(from_hrm_ind)` — 按 from-region 粗粒度标记
        第 2 层 Fine PerRegionTable (:370-435): `_fine_grain_regions[ind]` 查找 → 位图 1 bit/card
        第 3 层 SparsePRT (:379-383): `_sparse_table.add_card()` — 有序数组存储 card indices
      PRT 的多层结构是逐级精度的 trade-off：
        Coarse: 1 bit/from-region, 128MB 堆 (~64 regions) → 仅 64 bits → 极度省内存，但 Young GC 多扫 1MB
        Fine: 1 bit/card, 每卡 512B → 1 Region (2MB) = 4096 bits → 省扫描 (多扫量 ~512B/card)
        Sparse: 4-byte card index × n entries → entry limit 后转 Fine 或退化 Coarse

  ② SparsePRT → Fine 转换 vs Fine → Coarse 退化的条件分别是什么？
      答案方向: Sparse→Fine: `G1HRRSUseSparseTable && _sparse_table.add_card()` 返回 false
        (SparsePRT entry 已满，不再能追加新 card) → 转 Fine (heapRegionRemSet.cpp:385-406)
      Fine→Coarse: `_n_fine_entries == _max_fine_entries` → `delete_region_table()`
        → 退化为 Coarse (heapRegionRemSet.cpp:385-389)，删除最老的 PerRegionTable 并重新分配。
      PRT 退化是单向的：Coarse 不会再变 Fine——意味着一旦一个 from-region 因卡表更新频繁
      而退化为 Coarse，该 region 的每次 Young GC 都会额外扫描全部 512B/card × 4096 = 2MB，
      直到下次 Full GC 重新开始。

  ③ 反事实: 如果 PRT 不设退化机制，Fine 层无限增长？
      答案方向: 对象间的引用图在大型应用中可以是全连通图——128MB 堆 64 regions 中每个 region
      互相引用 → 每个 Region 的 _fine_grain_regions[] 需要 63 个 PerRegionTable。
      每个 PerRegionTable = 4KB (header + card bits)，64 regions × 63 tables × 4KB = 16MB
      仅 PRT 就占堆的 12%！加上退化 Coarse → 64 regions × 8 bytes = 512B per region
      → 全局仅 32KB。退化机制在引用图稠密时压缩 500× 空间，但代价是每次 Young GC
      多扫描 about 100× 不必要的内存 (512B/card 多余扫描)。

      但如果堆是稀疏连接的（avg fan-out 3），一直保持 Fine 不退化 → Young GC 各扫 3 cards
      → ~1.5KB vs Coarse 的 2MB → 1333× 扫描补集。在设计时 G1 通过 Fine→Coarse 退化
      换取空间可控性，但牺牲了 GC 扫描精度。这是一个"空间换时间/精度"的主动选择。
      这与 ZGC 用 colored pointers 完全消除 RSet 形成对比——ZGC 在 42-bit 压缩指针模式下
      牺牲 4TB 可直接寻址空间换无 RSet。
```

### 4.3 ★★★ TLAB 分配 — CAS 无锁 → 锁路径 → retire → new_region 完整链路

```
问题：
  ① TLAB bump-the-pointer 分配 vs CAS 无锁 Region 内分配的区别？
      答案方向: TLAB 分配 (memAllocator.cpp:375-384 `allocate_inside_tlab()`):
        单线程 bump pointer: 读取 _top → _top += obj_size → no CAS, no lock, no cmpxchg
        → 1~3 CPU cycles (overcommitted pipeline). 这就是 JVM 上 `new` 比 `malloc` 快 10× 的原因。
        Region 内分配 (g1AllocRegion.inline.hpp:54-71 `par_allocate()`):
        多线程竞争同一个 Region → CAS: `alloc_region->par_allocate()` 用 CAS 更新 _top
        → ~20ns (CAS + L1/L2 cache coherency). 仍然快于锁路径的 ~300ns。
      
      追问: TLAB 大小如何计算？
      → `ThreadLocalAllocBuffer::compute_size()`: 初始值 = TLABSize/(gc_slow_alloc_count+1),
        每次 refill 动态调整。`TLABWasteTargetPercent=1%` 确保 refill 浪费 ≤1% 的总 TLAB 容量。

  ② AllocRegion 的 CAS → 锁路径 → retire → new_region 状态机如何工作？
      答案方向: g1AllocRegion.inline.hpp 的 4 个关键入口：
        (1) `attempt_allocation()` (:73-91): CAS 无锁 → 成功返回指针，失败返回 NULL
        (2) `attempt_allocation_locked()` (:93-118): 加 Mutex → 重新 attempt_allocation
          (其他线程可能刚 retire) → 若再失败 `retire(true)` + `new_alloc_region_and_allocate()`
        (3) `retire()` (:109, 把当前 AllocRegion 置为满 → 不能再分配)
        (4) `new_alloc_region_and_allocate()` (:110): 从 Free List 提取 1 Free Region →
          set_eden() → 设为 _alloc_region → 在其中分配对象
      这个状态机的关键是 `retire()` 之前的 double-check：加锁后重新 attempt 一次——
      因为另一个线程可能已经 retire + new_region→ 避免错过机会，减少不必要的 Free List 提取。

  ③ 反事实: 如果不使用 TLAB，所有对象都在 Global AllocRegion 内 CAS 分配？
      答案方向: 10 个线程并发 new Object() → CAS 竞争加剧：Intel Xeon 上 10 contest 的 CAS
      成功率为 ~1/10，重试次数 avg 10 → 单次分配 ~200ns（vs single-thread TLAB ~3ns）
      → 75× 慢。TLAB 将全局竞争分摊到线程本地，消除了所有 CAS 重试。而且 TLAB retire()
      是批量操作——只有 TLAB 满时才 retire old region + new region + set_eden = 3 次
      写 ~100ns，分摊到 TLAB 内的数千个对象上，每个对象仅 ~0.1ns 开销。
      没有 TLAB 的极端后果：10 个线程 × 每秒 100K 新对象 = 1M CAS/sec 全局竞争
      → 40 个 CPU 的 scalability 退化为 3 CPU equivalent → 13× 分配吞吐量下降。
```

### 4.4 ★★★ Humongous 分配 — starts + continues Region 布局 + Eager Reclaim

```
问题：
  ① 什么条件触发 Humongous 分配？为什么阈值是 Region/2 而非 Region？
      答案方向: Humongous 判定: `word_size >= HeapRegion::GrainWords / 2`
      阈值设为 Region/2 而非 Region 的原因：如果一个对象 ≥ Region/2, 放在 TLAB 或 Region
      内的 bump pointer 分配中会造成严重碎片——2MB Region 中放 1MB 对象就算碎片化。
      1MB 的幸存对象需要释放该 Region 的 1MB 的空间，但 Region 的基本单位是全体 2MB
      → 除非 GC 能精确释放 1MB，否则 1MB 就永久浪费。
      选择 Region/2: 保证最大对象 ≤ 堆的 1/(2×TARGET_REGIONS) ≈ 堆的 0.8%，
      堆的 8GB = 4096 regions × 2MB → Humongous 最大 1MB → 占堆的 0.012%，可控。
      
      追问: Humongous 对象的垃圾回收时机？
      → Humongous Object Eager Reclaim: 并发标记 Cleanup 阶段，如果 Humongous 对
        象完全没被标记，立即回收 starts+continues Region 组，无需等 Mixed GC。

  ② starts/continues 的 Region 号为什么必须连续？连续约束如何实现？
      答案方向: starts Region 的对象头包含 _humongous_start_region 指针指向自身，
      后续 continues Region 通过 region_index+1 顺序访问。遍历时 `oopDesc::is_objArray()` 检测
      `is_array() && klass->is_objArray_klass()` → 通过 offset 计算数组长度 → 跳过各 continues Region。
      连续性保证：`G1CollectedHeap::attempt_allocation_humongous()` 在 Free List 中搜寻
      恰好连续的 N 个 Free Region（N=word_size/region_size），用 FreeList_lock 同步。
      
      追问: 为什么不采用 Humongous Region 链表（非连续）？
      → 链表需存储每个 continues Region 的 next 指针 → 至少 8 bytes/region 额外空间
      → 小 Humongous（2 Regions）浪费 4% 开销 → 可接受但增加 oops_do 的复杂度。
      还要维护双向链表确保 eager reclaim 的一致性。G1 选择了在 Free List 搜寻连续性，
      代价是碎片化时 Full GC 压缩恢复连续——Full GC 的 4 阶段 (Mark→Prepare→Adjust→Compact)
      可以将所有存活 Humongous 对象挪到连续空间，消除碎片。G1 的策略: 99% 时间可分配 +
      1% Full GC → 可接受的 STW 代价。

  ③ 反事实: 如果 Humongous 阈值从 Region/2 提高到 Region 全尺寸？
      答案方向: 阈值 = Region (2MB) → 所有 1MB 对象不再是 Humongous → 分配到普通 Region :
        good: 不再需要连续 Region → 碎片问题消失 → Full GC 频率从 1% 降到 0.1%
        bad: 2MB Region 中 1MB 对象 + 1KB 剩余空间 = 50% 浪费 → 50 个 1MB 对象消耗
        100 Regions 而非 75 (starts+continues 各 1 个) + 50 个 useless 空间碎片
        → 50MB 额外堆占用 → -XX:G1HeapWastePercent=5% 在 8GB 堆上仅 400MB 浪费容忍
        → 50MB already 超出 5% 的 1/8 → 触发 Humongous 的特殊处理更有效。
      
      如果阈值 = Region (64MB) → 所有 <64MB 对象为普通分配 → 无 Humongous 对象
      → 大对象（如 shuffle buffer 4MB）分配到 Old Region。Old Region 中 4MB 对象
      与 16B 对象混合分配 → Old Region 的 card table 精度问题: 4MB 对象的一个字段修改
      → 整个 Old Region 的所有 card 变脏 → Young GC 多扫 2MB 而不是 512B
      → 100 个大对象 × 2MB 额外扫描 = 200MB → 20ms STW 增加到 100ms → 不可接受。
```

### 4.5 ★★★ SATB Barrier — enqueue 条件 + filter 两指针对撞压缩 + 线程间交互

```
问题：
  ① SATB enqueue 什么时候触发？为什么只 enqueue 旧值（pre-write）而非新值？
      答案方向: g1BarrierSet.cpp:128-146 `enqueue()`:
        (1) 只在 marking active 时生效 (:132: `if (!_satb_mark_queue_set.is_active()) return`)
        (2) pre_val → 记录的是覆盖前的旧值
        (3) Java 线程无锁队列 (:140-141): `G1ThreadLocalData::satb_mark_queue(thr).enqueue(pre_val)`
        (4) 非 Java 线程加锁 (:143-144): `MutexLockerEx x(Shared_SATB_Q_lock, ...)`
      SATB 只记录旧值因为并发标记基于"逻辑快照"：标记开始时哪些对象是活对象。
      覆盖前记录 pre_val → 即使应用线程修改引用，旧值指向的对象仍出现在快照中
      → 保证不会漏标。写新值会在后续 barrier ref 或 Young GC 的根扫描中被处理。

  ② SATB buffer 满了怎么处理？filter 两指针对撞压缩 O(n) 做了什么？
      答案方向: SATB 1KB buffer 塞满 (~128 oop entries) → `flush()` 把满 buffer 推入
      全局 completed list → 并发标记线程 `CMTask::drain_satb_buffers()` 处理各线程的 buffer。
      `filter()` 两指针对撞压缩: 从 buffer 两端读压缩重复 oop 引用。在活跃应用中 80%
      的 SATB entries 是重复的（同一字段被反复修改）→ 压缩后仅存 20% 唯一 oop。
      算法: src 从 start, dst 从 end → 若 src == src+1 跳过 → 若不同拷贝到 dst -- 
      O(n)，n=256 ptrs × 2 load+compare+store = ~1µs per buffer。
      
      追问: SATB buffer 满了是否阻塞应用线程？
      → 不阻塞！应用线程的 enqueue 只是 thread-local buffer 插入 → buffer 满后 flush
        推入全局 list → 申请新 buffer → 分配过程有 `_free_list` (free buffer pool)
        → 若 free_list 为空 → 阻塞等待并发标记线程释放 buffer → 最坏 ~10µs。

  ③ 反事实: 如果 G1 不用 SATB 而用 CMS 的 Incremental Update（记录新值）？
      答案方向: Incremental Update 记录的是新值（post-write card marking）。
      对比两种方案的影响:
        (1) Mixed GC 适配: G1 的 Mixed GC 作用于 Old Region — post-write 只能处理
          当前修改的 card，无法追踪"此对象在标记开始时被谁引用"。SATB 记录的是旧引用
          → 保证了 Old Region 的完整快照 → 即使对象在标记完成后、Mixed GC 前被修改，
          Mixed GC 仍能看到标记开始时的完整引用图。Incremental Update 做不到——标记
          只记录标记期间出现的新引用，后续的引用变更不可见。
        (2) 浮动垃圾差异: SATB 产生浮动垃圾（标记开始时的 live 对象，但结束后已死），
          错回收代价是 1 次 GC 延迟。Incremental Update 可以漏标（标记期间新对象出现，
          但引用了未扫描的 Old Region 对象）→ 造成 dangling pointer → 数据损坏。
          G1 在"容忍浮动垃圾 vs 容忍漏标"中选了前者（安全优先）。
```

### 4.6 ★★★ Card Barrier — mark_card_deferred CAS + invalidate StoreLoad + Young Card 跳过

```
问题：
  ① mark_card_deferred 的 CAS 为什么是 wait-free？
      答案方向: g1CardTable.cpp:34-54 `mark_card_deferred()`:
        (1) 读取当前 card value (:35: `jbyte val = _byte_map[card_index]`)
        (2) 若已 deferred → return false (别重做，:37-39)
        (3) 根据 current val 算 new_val (:42-49):
            clean → deferred, claimed → claimed|deferred
        (4) CAS cmpxchg (:51: `Atomic::cmpxchg(new_val, &_byte_map[card_index], val)`)
        CAS 只尝试 1 次——失败即放弃。不 retry，不 spin，不 block。因为脏卡最终会
        被某线程标记为 dirty，card table 对"丢失一次 deferred mark"有容忍度——后续
        的 `invalidate()` (g1BarrierSet.cpp:199-227) 会遍历整个 mr 的 card 重新标记.
        Wait-free: 每个线程的执行时间有上界（1 CAS, no retry）→ 不受竞争影响。

  ② invalidate 中的 StoreLoad 屏障 + Young Card 跳过是什么意思？
      答案方向: g1BarrierSet.cpp:190-227 `invalidate()`:
        (1) 跳过 young card (:198): `for (; *byte == g1_young_card_val(); byte++)` — 
          Young GC 会自己处理 young region 的 card → 不需要在此更新
        (2) StoreLoad 屏障 (:201: `OrderAccess::storeload()`) — 保证之前的所有写（尤其是
          写标记）全局可见后，再读取 card val 判断是否需要 enqueue
        (3) 遍历剩余 card (:203-224): 每个 card 检查: 若不是 young → 若不是 dirty → 置 dirty → enqueue
      StoreLoad 是关键——没有它，CPU B 可能看不到 CPU A 刚写的 dirty 标记，导致 dirty card enqueue
      丢失 → 并发精炼线程缺少更新 RSet 的信号 → 后续 Young GC 可能漏扫描跨 Region 引用。

  ③ 反事实: 如果 Card Table 粒度从 512B 改成 64B (cache line size)？
      答案方向: card = 64B → 32GB 堆 → 512M cards × 1B = 512MB Card Table
      vs 512B/card → 32GB 堆 → 64M cards × 1B = 64MB Card Table
      8× 的空间膨胀在 32GB 堆上从 64MB → 512MB → Card Table 占堆的 1.6% 不算致命
      但 Young GC 的 card scan 减少 8× 扫描量 → 每 card 扫 64B 而非 512B
      → 20ms GC STW 中 card scan 从 ~8ms 降到 ~1ms → 节省 7ms。
      权衡: +448MB/32GB (1.4%) 的 card table 内存 vs -7ms GC STW
      → 在大堆上值得，但 G1 选择了保守的 512B 卡表确保小堆也能运行。
      
      如果 256B/card → card table 128MB ↔ -2ms GC STW → 更好的权衡
      但 G1 未提供此选项因为 512B 对齐 x86 的页面大小 4096B → 8 cards 完美对齐
      1 page → 硬件 TLB friendly → 减少了 card table 访问的 TLB miss。
```

### 4.7 ★★★ Free List 三层管理 — Master / Secondary / Old 的选择逻辑

```
问题：
  ① 三层 Free List 如何选择 Free Region？为什么需要三层？
      答案方向: G1 的 Free Region Set 分为：
        (1) **MasterFreeRegionList**: 完全空闲且未分配的 Free Region
        (2) **SecondaryFreeRegionList**: 刚被 GC 回收但尚未完全清空的 Region
        (3) **OldReclaimableRegionSet**: GC 标记为可回收 Old Region 的候选
      分配时优先级: Master → Secondary → OldReclaimable → Expand (新增 Region)
      三层设计的根本原因：不能被清理中的 Region 阻碍分配。
        - Master 直接可用（零清理）
        - Secondary 需 hr_clear（清理 RemSet + 置 Free 状态标记）
        - OldReclaimable 需 GC 确认无对象引用后才进入 Free
      如果只有一层 —— GC 回收 100 个 Region 时，Mutator 需要等待 100 次 hr_clear
      → 100 × ~10µs = 1ms 延迟增加。三层让 Mutator 从 Master 分配不受回收影响。

  ② Free List 是怎么保持按 region_index 排序的？为什么需要排序？
      答案方向: FreeRegionList 是双向链表，按 region_index 递增顺序维护。
      `FreeRegionList::add_ordered()` 在添加时做二分插入 → O(log n) = ~6 comparisons for 64 regions。
      排序的目的: 查找连续 N 个 Free Region 时，可以从任意结点顺序遍历 → 首次匹配的 O(n)
      而非排序未维护时的 O(n²)。对于 Humongous 分配 = 连续 2~3 Regions → 在 sorted list 上
      1 次 pass 即可找到 → ~64 iterations → ~300ns (5ns/iteration)。

  ③ 反事实: 如果 G1 不维护三层 Free List，而采用单一 Free List + commit/uncommit 动态调整？
      答案方向: commit/uncommit 在 OS 层 (man 2 mmap/MADV_DONTNEED) 消耗 ~1µs/region→
      GC 后回收 100 Regions × 1µs = 100µs。但 HashMap 膨胀期间 Mutator 最快 20µs 消耗 1 Region
      (TLAB refill rate) → 100 Regions only supply for 2000µs = 2ms → GC 后 2ms 内
      Mutator 就耗尽 Free List → 必须等待 GC 完成 hr_clear → 1ms 延迟 → GC 影响 Mutator。
      三层分离避免这个竞争:
        - GC 负责往 Secondary 推送清理后的 Region (异步，不影响 Mutator)
        - Mutator 从 Master 取用 (同步，0 延迟)
        - Master 空了 → copy Secondary→Master (1 次链表操作 O(1))
      
      如果完全不使用 Free List，而靠 madvise MADV_DONTNEED + mmap 重新分配:
      每次新 Region 需要 syscall mmap → ~1µs (加上 vma 锁 + page fault handler) 
      → 10000 次 TLAB refill = 10ms → 比链表分配 O(1) 的 ~50ns 慢 200×。
```

---

## §五 Article Structure

建议 9 个 Section 的文档大纲：

```
§〇 生产场景 — 8GB 堆 Humongous 碎片化导致 Full GC
  ★ 真实故障: Humongous count 12, Free Region 18, 最长连续 3
  ★ 根因: starts+continues 连续 Region 不足 → 分配失败 → Evacuation Failure → Full GC 12s
  ★ 三步诊断: jcmd → GDB humongous breakpoint → Free List 连续性检查
  ★ 反事实: 非连续 Humongous 链 → 遍历 O(n) vs O(1)
  ★ 反事实: Humongous 阈值改为 Region → 碎片消失但 Old region 多扫描 4000×

§一 ★★★ Region 9 态状态机完整走读 (预期 ~200 行)
  ❓ 9 种 tag 的位掩码编码——为什么不是 enum switch
  1.1 9 态枚举定义 (heapRegionType.hpp:64-91) — 位掩码布局
  1.2 合法状态转换图 — 哪个任务驱动哪种转换
  1.3 is_young/is_humongous 位运算 O(1) — 比分支快 5×
  1.4 set_eden/set_old/set_from 断言保护
  1.5 hr_clear 清理路径 (heapRegion.cpp:113-136)
  1.6 relabel_as_old 状态迁移 (heapRegionType.hpp:160-176)
  1.7 ★ Mermaid: Region 9 态状态机 — 6 种转换 + 3 个驱动者
  1.8 ★ 面试 Story 格式 — 从 Free Region 到 Humongous 的一次完整生命周期

§二 ★★★ 对象分配：TLAB → CAS → 锁路径 → retire → new_region (预期 ~250 行)
  ❓ `new Object()` 如何从 JIT bump pointer 落到 G1 Region
  2.1 分配入口: MemAllocator::allocate (memAllocator.cpp:387)
  2.2 TLAB 内 allocate_inside_tlab 无锁撞针 (memAllocator.cpp:375-384)
  2.3 TLAB refill: compute_size → _heap->allocate_new_tlab (memAllocator.cpp:326-372)
  2.4 G1Allocator::attempt_allocation CAS (g1Allocator.inline.hpp:44-52)
  2.5 retained allocation 重试 (g1AllocRegion.inline.hpp:133-144)
  2.6 CAS 失败 → attempt_allocation_locked → retire → new_alloc_region (g1AllocRegion.inline.hpp:93-118)
  2.7 PLAB（GC Worker 专有的 Promotion Local Allocation Buffer）(g1Allocator.inline.hpp:65-91)
  2.8 ★ Mermaid: 分配 flow from Java 'new' to oop in Eden Region (6 lanes)

§三 ★★★ Humongous 分配：大的另一面 (预期 ~180 行)
  ❓ 1GB 堆中 4MB byte[] 怎样分配
  3.1 阈值: word_size ≥ GrainWords/2 (Region/2)
  3.2 attempt_allocation_humongous 完整路径
  3.3 starts+continues 连续 Region 搜索 (Free List 顺序遍历)
  3.4 Humongous 对象的内存布局 (start 含头 + continues 纯数据)
  3.5 Eager Reclaim: 并发标记 Cleanup 时的立即回收
  3.6 碎片化根因: 连续 search 失败 → Humongous allocation failure
  3.7 ★ Callout: Humongous 和普通对象的 Young GC 处理差异

§四 ★★★ Free List 三层管理 (预期 ~150 行)
  ❓ GC 回收的 Region 如何回到分配池
  4.1 MasterFreeRegionList: 零延迟直接可用
  4.2 SecondaryFreeRegionList: hr_clear 完成后转移
  4.3 OldReclaimableRegionSet: 等 GC 确认后才进入
  4.4 FreeRegionList: sorted by region_index 确保 O(n) 连续性搜索
  4.5 分配优先: Master → Secondary → OldReclaimable → Expand
  4.6 ★ Counterfactual: 单层 Free List → Mutator 阻塞等待 GC cleanup

§五 ★★★ PRT 三级查找 + 退化 (预期 ~220 行)
  ❓ "谁引用了 Region 3 的第 1024 个 card 中的对象"
  5.1 FromCardCache — 线程本地 2D 缓存 (第 0 层)
  5.2 CoarseMap — 1 bit/from-region (第 1 层)
  5.3 Fine PerRegionTable — 1 bit/card (第 2 层)
  5.4 SparsePRT — 有序 card index 数组 (第 3 层)
  5.5 add_reference 的 4 层查找流程 (heapRegionRemSet.cpp:348-436)
  5.6 Fine→Coarse 退化: _n_fine_entries == _max_fine_entries
  5.7 release_store 保证 PerRegionTable 并发可见性 (:405)
  5.8 ★ Counterfactual: 无退化 → 64 regions 全连通 → PRT 16MB
  5.9 ★ 与 ZGC colored pointers 零 RSet 的对比

§六 ★★★ Barrier Set: SATB + Card 双屏障 (预期 ~250 行)
  ❓ `obj.field = other` 背后的 barrier 全套操作
  6.1 SATB pre-write: write_ref_field_pre → enqueue pre_val (g1BarrierSet.cpp:128-146)
  6.2 SATB filter: 两指针对撞压缩 O(n) → 80% 去重率
  6.3 Card post-write: mark_card_deferred CAS (g1CardTable.cpp:34-54)
  6.4 write_ref_field_post_slow: StoreLoad+enqueue (g1BarrierSet.cpp:172-188)
  6.5 invalidate: young card 跳过+StoreLoad+dirty enqueue (g1BarrierSet.cpp:190-227)
  6.6 SATB marking cycle 生命周期: active→flush→process→deactivate
  6.7 ★ Mermaid: Barrier flow — Java write → SATB + Card → enqueue → Concurrent mark → RSet
  6.8 ★ Counterfactual: 无 Barrier → 漏标→ dangling pointer in Mixed GC

§七 ★★★ Card Table 布局 + offset 计算 (预期 ~120 行)
  ❓ Card Table 的 _byte_map_base 偏移优化——省 1 减法
  7.1 512B/card 粒度的计算 (card_shift=9)
  7.2 _byte_map_base = _byte_map - (low_bound >> 9) 的 0 减法优化 (g1CardTable.cpp:130)
  7.3 g1_mark_as_young 并行标记 (memset_with_concurrent_readers)
  7.4 is_in_young — 1 次指针运算 (g1CardTable.cpp:141-144)
  7.5 8GB 堆 → 16MB Card Table 内存开销

§八 ★ GDB 断点验证 — 8 断点覆盖 Region 全生命周期 (预期 ~100 行)
  断言 1: heapRegionType.hpp:149 set_eden 前值验证
  断言 2: g1AllocRegion.inline.hpp:73 CAS 分配撞针
  断言 3: memAllocator.cpp:387 Allocate 入口 → new Object()
  断言 4: g1CardTable.cpp:34 mark_card_deferred CAS
  断言 5: g1BarrierSet.cpp:128 SATB enqueue → marking active
  断言 6: g1CardTable.cpp:130 _byte_map_base 偏移验证
  断言 7: heapRegionRemSet.cpp:348 add_reference 4 层路径
  断言 8: g1AllocRegion.inline.hpp:93 attempt_allocation_locked → retire

§九 Cross-Reference
  → 01-02-G1-Heap-Startup (堆初始化 + mmap/commit + card table 创建)
  → 01-08-G1-Policy-Analytics (G1Policy 8 子组件 init — IHOP/MMUTracker)
  → 01-09-G1-Concurrent-Marking-Infra (双 Bitmap + CMTask 初始化)
  → [30-01] Young GC (Evacuation 生命周期 — 续本文的 Eden 状态机)
  → [30-02] Concurrent Marking (SATB 生命周期 — 续本文的 Barrier)
```

---

## §六 Writing Requirements

1. **每个技术断言必须标注 file:line** — "Card Table 的 0 减法优化在 g1CardTable.cpp:130" — 不是 "在初始化阶段计算"。

2. **原理驱动，不是源码翻译** — 源码是 20% 的 evidence，原理是 80% 的 body。例如写 mark_card_deferred:
   - ❌ 不要: "第 35 行读取 val = _byte_map[card_index], 第 37 行检查 val & (clean|deferred) == deferred..."
   - ✅ 应该: "mark_card_deferred 是 wait-free 的——CAS 只尝试 1 次无重试 (g1CardTable.cpp:51)。因为卡片最终会被 invalidate 遍历重新标记 (g1BarrierSet.cpp:203-224)，丢失 1 次 deferred mark 对全局无影响。Wait-free 保证所有线程在固定时间上界内完成，不受竞争影响。"

3. **Mermaid 图 — 至少 5 个**:
   - `§一` Mermaid: Region 9 态状态机 — 6 类转换 (Eden→Survivor, Eden→Old, Survivor→Old, Free→Eden, Free→Humongous, Humongous→Free)
   - `§二` Mermaid: 分配 flow — 6 lanes (Java App / Interpreter / C2 / TLAB / AllocRegion / Free List)
   - `§四` Mermaid: Free List 三层流转
   - `§六` Mermaid: Barrier flow — SATB + Card dual path into concurrent mark + RSet update
   - `§五` Mermaid: PRT 4 层查找 + 搜索 + 退化流程

4. **5 个 Beginner Callout 框** — 必须用 `> **` 块引用格式（不能用 ### subsection），精确文本来自 §一。

5. **交叉引用 3 个已有文档**:
   - At Region 初始化 → → [01-02-G1-Heap-Startup] for `setup_heap_region_size` + `initialize()`
   - At CardTable layout → → [01-02-G1-Heap-Startup] for `G1CardTable::initialize()` 
   - At SATB marking → → [01-09-G1-Concurrent-Marking-Infra] for `CMTask` + double-bitmap

6. **不要写成→应该写成 对照表**:

| 不要写成 | 应该写成 |
|---------|---------|
| "第 67 行设置了 CardPerRegion，第 68 行检查 G1HeapRegionSize 是否 FLAG_IS_DEFAULT..." | "Card Table 覆盖 8GB 堆需要 16MB 卡片数据。`setup_heap_region_size()` (heapRegion.cpp:106-107) 计算 `CardsPerRegion = GrainBytes >> card_shift`——每个 2MB Region 分 4096 张 card (card_shift=9)。这是硬件友好的：4096 = 8 × 512，恰好 1 页内放 8 张 card。" |
| "第 34 行调用了 mark_card_deferred()" | "Card post-write barrier 的 `mark_card_deferred()` (g1CardTable.cpp:34-54) 是 wait-free 的——CAS 只有一个 cmpxchg，不 retry。之所以可以不重试，是因为后续的 `invalidate()` (g1BarrierSet.cpp:190-227) 会遍历整个区域重新标记。这相当于一道双保险：快速标记 (mark_card_deferred) + 深度清理 (invalidate)。" |
| "第 128 行定义了 enqueue()，接收 oop pre_val 参数" | "SATB enqueue (g1BarrierSet.cpp:128-146) 只有在 marking active 时才工作 (:132)，这保证了非标记阶段的零开销。为什么记录 pre_val 不记录新值？因为 SATB 的快照语义要求标记开始时所有 live 对象都必须 reachable——pre_val 可能指向仅在被修改前可触达的对象（'遗留'引用），记录 pre_val = 保留此对象在 snapshot 中。这是 G1 的'宁多标记不遗漏' (conservative marking) 设计。" |

7. **Interview Story 答案** — 在 §一 末尾用 narrative 风格回答 "G1 的对象分配是怎么从 new 到 Region 的？"，包含所有关键 file:line 引用。

8. **每个 §四 问题组 ≥ 8 行答案** — 包含 file:line + 追问 + 量化对比 + 内核引用。随机抽取 3 个组验证达标。

---

## §七 Output Format

- Markdown file, named `00-Region-Allocation.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/30-g1-runtime-gc/docs/`
- 元信息头:

```
> **阶段**：[30-g1-runtime-gc]
> **前置**：[01-02-G1-Heap-Startup]（G1CollectedHeap::initialize 构造 18 步，mmap reserve/commit，6 个 Mapper，CardTable 初始化，Region 类型初始化）
> [01-08-G1-Policy-Analytics]（G1Policy 8 子组件，Analytics 17 个衰减序列，IHOP 控制，MMUTracker）
> [01-09-G1-Concurrent-Marking-Infra]（G1ConcurrentMark 构造函数，双缓冲位图，CMTask×13）
> **配套**：[30-01] Young GC 生命周期 — 续本文的 Eden/Free 状态转换；[30-02] 并发标记 — 续本文的 SATB Queue 全生命周期
> **后续依赖本文**：[30-01] Young GC（依赖 Region 状态机判断 Eden/Survivor）；[30-02] Concurrent Marking（依赖 SATB Barrier 作为标记缓冲区起点）；[30-03] Mixed GC（依赖 Free List 选择 CSet Old Region）
> **阅读收益**：追踪 G1 Region 从 Free → Eden → Old → Free 的完整生命周期——掌握 9 种 Tag 的位掩码 O(1) 判定、TLAB/PLAB/Humongous 三条分配路径的 CAS→锁→retire→new_region 状态机、PRT 的 FromCardCache→Sparse→Fine→Coarse 四级查找+退化逻辑、SATB 的线程本地无锁 enqueue+filter 两指针对撞压缩、Card Barrier 的 wait-free defer+StoreLoad invalidate 双保险设计
```

- 文档标题: `# 00-Region-Allocation — G1 Region 运行时与对象分配`
- 所有 Section 用 `## §N Title` 格式

---

## §八 Prohibited（≥8 条）

- ❌ 不列举源码行号作为行证 — 不要 "第 35 行，第 37 行，第 42 行..." —— 原理优先，行号是准确性保障
- ❌ 不写 `"set_eden() 用于设置 Region 为 Eden 状态"` — 必须说明为什么 `set_eden()` 断言旧值为 FreeTag 以及这如何防止数据损坏
- ❌ 不跳过 `mark_card_deferred` 的 CAS 设计原理 — 必须解释为什么 wait-free（1 次 cmpxchg 无重试）可行，因为有 storeload invalidate 做补偿
- ❌ 不把 SATB 和 Incremental Update 并列列举而不解释取舍 — 必须用 "如果 G1 用 CMS 的 Incremental Update 会怎样" 反事实
- ❌ 不解释 Humongous 阈值为什么是 Region/2 — 必须展示碎片与扫描开销的 trade-off 计算
- ❌ 不解释 `_byte_map_base` 偏移优化机制 — 必须解释为什么 `&_byte_map_base[addr >> 9]` 等价于 `&_byte_map[(addr - low) >> 9]` 且省 1 次 64-bit 整数减法
- ❌ 不把 Free List 三层 (Master/Secondary/Old) 混为一谈 — 必须展示各层的数据结构差异和选择优先级
- ❌ 不解释 `relabel_as_old` 的 `is_eden()/is_free()/is_survivor()` 三分支 — 必须解释这是在 Young GC 中发生，Eden→Old 和 Survivor→Old 的语义不同（晋升来源不同）
- ❌ 不使用 "GC 时" 这种模糊时间 — 必须精确到阶段名称 (Young GC Evacuation / Concurrent Mark Cleanup / Mixed GC Selection)
- ❌ 不缺少 Mermaid 图 — 至少 5 个 (状态机 + 分配 flow + Free List 流转 + Barrier 双路径 + PRT 4 层)

---

## §九 Required（≥8 条）

- ✅ **★ Mermaid 图 ≥ 5 个** — 1) Region 9 态状态机 2) 分配 flow 6 lanes 3) Free List 三层 4) Barrier SATB+Card 双路径 5) PRT 四级查找
- ✅ **★ 每个技术断言 file:line** — 不是 "在 heapRegion.hpp 中"，而是 "在 heapRegionType.hpp:125"。函数定义首次出现标注行号。
- ✅ **★ Beginner Callout 框 ≥ 7 个** — 只在 §一 中出现，用 `> **` 块引用格式，不用 `###` 子节
- ✅ **★ 诊断工具五件套全覆盖** — jcmd + strace + jstack + GDB + /proc → 每个核心概念至少出现 2 个工具引用
- ✅ **★ Counterfactual 分析 ≥ 5 个** — 地区状态、PRT 退化、Humongous 布局、SATB vs Incremental Update、Card 粒度 → 有独立反事实讨论
- ✅ **★ man 手册引用 ≥ 4 处** — 每个涉及 syscall 的段落标注 `man 2 mmap`, `man 2 madvise`, `man 2 mprotect`
- ✅ **★ Interview Story 格式答案** — 在 §一 末尾，完整叙事从 new 到 Region + 所有 barrier 操作
- ✅ **★ §四 每组 ≥ 3 个问题 + 答案方向 ≥ 8 行** — 每组含 3-5 个具体问题 + 反事实讨论，每个答案 ≥ 8 行含 file:line + 量化对比
- ✅ **★ `不要写成→应该写成` 对照表** — §六 中 ≥ 6 对对比，每对含源码行号精确例子
- ✅ **★ 交叉引用 3 个已有文档** — 01-02-Heap-Startup, 01-08-Policy, 01-09-Concurrent-Marking-Infra → 标注具体关联点

---

## §十 GDB Verification（≥8 断言）

```
断言 1: set_eden 旧值验证 (heapRegionType.hpp:149)
  (gdb) break HeapRegionType::set_eden
  (gdb) run → TLAB refill 第一次 new_alloc_region_and_allocate
  (gdb) print _tag → 期望: FreeTag(0)
  (gdb) continue 经过 set_from
  (gdb) print _tag → 期望: EdenTag(2)

断言 2: CAS 分配撞针 (g1AllocRegion.inline.hpp:84)
  (gdb) break G1AllocRegion::attempt_allocation
  (gdb) run → 在 Mutator alloc region 满时触发
  (gdb) print alloc_region->_hrm_index() → 期望: 当前 Eden region index
  (gdb) print result → 期望: NULL (CAS 失败触发 attempt_allocation_locked)

断言 3: MemAllocator 分配入口 (memAllocator.cpp:387)
  (gdb) break MemAllocator::allocate
  (gdb) run → new Object() 触发
  (gdb) print _word_size → 期望: object header size + fields
  (gdb) continue 进入 mem_allocate
  (gdb) print allocation._obj → 期望: 新分配的 oop 地址

断言 4: mark_card_deferred CAS (g1CardTable.cpp:34)
  (gdb) break G1CardTable::mark_card_deferred
  (gdb) print card_index → 期望: card index 范围内 < CardsPerRegion
  (gdb) print (int)_byte_map[card_index] → 期望: 0 (clean) 或其它
  (gdb) continue 经过 cmpxchg
  (gdb) print (int)_byte_map[card_index] → 期望: deferred_card_val()

断言 5: SATB enqueue (g1BarrierSet.cpp:128)
  (gdb) break G1BarrierSet::enqueue
  运行: Concurrent Mark active 的 Java 程序触发 write_ref_field_pre
  (gdb) print _satb_mark_queue_set.is_active() → 期望: true
  (gdb) print pre_val → 期望: 非 null oop
  (gdb) print (Thread::current())->is_Java_thread() → 期望: true

断言 6: _byte_map_base 偏移验证 (g1CardTable.cpp:130)
  (gdb) break G1CardTable::initialize
  (gdb) print _byte_map → 期望: card storage 指针
  (gdb) continue 经过 _byte_map_base 计算
  (gdb) print _byte_map_base → 期望: _byte_map - (uintptr_t(low_bound) >> 9)
  (gdb) print (jbyte*)&_byte_map_base[high_bound>>9] → 期望: 在 _byte_map 范围内

断言 7: add_reference 4 层路径 (heapRegionRemSet.cpp:348)
  (gdb) break OtherRegionsTable::add_reference
  (gdb) print cur_hrm_ind → 期望: 当前 region index
  (gdb) continue 经过 FromCardCache
  (gdb) print _coarse_map.at(from_hrm_ind) → 期望: false/true 取决于退化状态
  (gdb) continue 经过 Fine PerRegionTable 查找

断言 8: attempt_allocation_locked → retire (g1AllocRegion.inline.hpp:93)
  (gdb) break G1AllocRegion::attempt_allocation_locked
  运行: 多线程竞争同一 alloc region
  (gdb) print _alloc_region → 期望: 有效的 HeapRegion*
  (gdb) continue 经过 retire
  (gdb) print _alloc_region → 期望: _dummy_region (retired)
```

---

## §十一 与 README 和同组 Prompt 的连续性

1. **从 README §二 承接**：本文展开 README doc-00 的 12 个核心源文件和 4 个关键问题——从 "Region 状态何时发生、由谁驱动" 到 "Card Table 512B/card 如何计算"。覆盖范围与 README §二完全对齐。

2. **同组边界**:
   - **本文 (doc-00)**: Region 状态机 + 对象分配 + Barrier 基元 + Card Table 布局 + Free List — 相当于 G1 的"硬件层"
   - **doc-01 (Young GC)**: 续本文的 Eden→Survivor 转换 + Evacuation 对象复制 + RSet 扫描 + 引用处理 — 消耗本文的 PRT 和 Card Table
   - **doc-02 (Concurrent Marking)**: 续本文的 SATB Queue 全生命周期 + Cleanup Eager Reclaim + 双 Buffer Bitmap 交换 — 消耗本文的 Barrier 基元
   - **doc-03 (Mixed GC)**: 续本文的 Free List 管理 + Region 状态机 + CSet 选择 — 消耗本文的分配路径
   - **doc-04 (Full GC)**: 续本文的 Humongous 分配失败 → 触发 Full GC → Mark/Prepare/Adjust/Compact → 重铸 Region 连续性

3. **Doc 间数据流**:
```
doc-00: Region Lifecycle + Allocation + Barrier
  Free → Eden (via AllocRegion CAS/retire/new_region)
  Eden → Survivor → Old (via Young GC = doc-01)
  Humongous → Free (via Eager Reclaim = doc-02)
  Old → Free (via Mixed GC = doc-03)
  Full GC recovery (doc-04)

SATB Queue → Concurrent Mark buffer (doc-02)
DirtyCard Queue → Concurrent Refine → RSet update (doc-01)
```

4. **全部 doc-00 prompt 与 README 的一致性**:
   - 12 个核心源文件与 README doc-00 源文件表完全匹配
   - 4 个关键问题 (Q1-Q4) 的解答方向分布在 §四 的 7 个问题组中
   - 文档拆分边界 (Region vs Young GC vs Marking) 明确标注在 §十一 和 §一 后续文档引用处
