# PROMPT: 请撰写 02-G1-Heap-Startup.md

## ⚠️ 关键：本 prompt 是导航地图，不是预制答案。你必须亲自读源码。

- 本 prompt 的 §四 答案方向是"指引"——告诉你去源码里找什么、从哪个角度分析。不能把"答案方向"直接抄到文档里。
- **你必须用 codegraph_explore 或 Read 工具逐个读取 §三 列出的每一个源文件**（至少读核心段落），基于自己的源码理解来写文档。
- 源码是证据（20%），你基于源码的分析洞察是正文（80%）。prompt 告诉你去找什么，不替你写答案。

## §〇 Production Scenario

```
$ java -Xms2g -Xmx2g -XX:+UseG1GC MyApp
$ cat /proc/<pid>/maps | grep heap
7f0000000000-7f0080000000 rw-p 00000000 00:00 0    ← 2GB Java Heap (mmap'd)
$ cat /proc/<pid>/maps | grep card
7f3a00000000-7f3a01000000 rw-p 00000000 00:00 0    ← 16MB Card Table
```

G1 启动时 reserv 2GB 虚拟地址空间但只 commit 用了的部分。Card Table 独立 mmap 16MB（2GB/512 = 4M cards × 1 byte = 4MB → 实际 16MB 含 guard）。当引用 `obj.field = newValue` 执行时，写屏障标记对应 card 为 dirty——young GC 只扫描 dirty cards 找 old→young 引用，而非整个 old generation。

**反事实**：如果没有 Card Table，young GC 需要扫描整个 old generation。2GB 堆 → 每次 young GC 扫描 2GB → 512GB 堆一次 young GC 需数秒 → 不可用。Card Table 把 old generation 扫描从 O(heap_size) 降到 O(dirty_cards)。通常 dirty cards 只占堆的 1-5%。

**三步诊断**：

```bash
# 1. 查看堆 Reserved/Committed
jcmd <pid> VM.native_memory summary scale=MB | grep "Java Heap"
# 期望: reserved=2048MB, committed=256MB (启动时仅 commit initial_heap_size)

# 2. 查看 Region 使用分布
jstat -gcutil <pid> 1000
# E/S0/S1/O/M — Eden/Survivor/Old/Metaspace percent

# 3. GDB 验证 Region 布局
gdb -ex "break G1CollectedHeap::initialize" \
    -ex "run" \
    -ex "print _hrm.length()" \
    -ex "print HeapRegion::GrainBytes" \
    -ex "print _hrm._regions.at(0)->bottom()" \
    --args java -version
# 期望: length()=512 (2GB/4MB), GrainBytes=4194304
```

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

本文深度分析 G1 Heap 在 JVM 启动时的初始化——不是 GC 运行时行为，是 `Universe::initialize_heap()` → `G1CollectedHeap::initialize()` 创建的全部数据结构。上下文：`init_globals` 第 9 步 `universe_init()` 的第 2 子步骤。

### Narrative

G1 启动不是"分配一块内存"那么简单。是一个 18 步序列：① `Universe::reserve_heap()` mmap 预留 2GB 虚拟空间（PROT_NONE, MAP_NORESERVE）→ ② 创建 G1CardTable + G1BarrierSet → ③ 创建 6 个 G1RegionToSpaceMapper（heap + bot + cardtable + card_counts + prev_bitmap + next_bitmap）→ ④ `_hrm.initialize()` 创建 HeapRegionManager + `_regions` 数组初始化 → ⑤ `_card_table->initialize()` 计算 `_byte_map_base` 偏移 → ⑥ `expand(init_byte_size)` → `_hrm.expand_by(N)` → `make_regions_available()` → commit_regions 并行 mmap 6 个 Mapper → 逐个 `new HeapRegion(i)` → 全 Free 入 `_free_list` → ⑦ SATBMarkQueueSet + DirtyCardQueueSet ×2 初始化。

### Interview Story Format Answer

"`Universe::initialize_heap()` 路由到 `G1CollectedHeap::initialize()`: 首先 `reserve_heap(max_byte_size)` mmap 用 PROT_NONE + MAP_NORESERVE 只占虚拟地址空间不占物理页——确保堆地址连续（压缩指针的前提）。然后创建 6 个 G1RegionToSpaceMapper: heap_storage(8GB) + bot_storage(16MB) + cardtable_storage(16MB) + card_counts_storage(16MB) + prev/next_bitmap_storage(128MB each)，总虚拟预留 ~8.3GB。`HeapRegion::setup_heap_region_size()` 计算 region_size = heap_size / TARGET_REGION_NUMBER(2048) → clamp[1MB, 32MB] → 最大2的幂 → 8GB堆→4MB Region。`_hrm.initialize()` 初始化 HeapRegionManager: `_regions` 数组容量 2048 → `_available_map` 2048-bit bitmap → `_free_list` 空链表。`expand(init_byte_size)` 调用 `make_regions_available()`: commit_regions 对 6 个 Mapper 逐一 mmap(MAP_FIXED, PROT_RW) 提交物理页 → for i=0..2047: `new HeapRegion(i)` — 构造 HeapRegion 对象（~200B each）+ `new HeapRegionRemSet`（每个 ~150B）— 全部 `_type=Free` → `insert_into_free_list`。`G1CardTable::initialize()` 设置 `_byte_map` 指向 mapper 的 reserved start，计算 `_byte_map_base = _byte_map - (heap_start >> 9)` 消除寻址减法。SATBMarkQueueSet 用 process_completed_threshold=20 初始，20 个 buffer 满触发并发标记处理。DirtyCardQueueSet(全局) yellow_zone=39, red_zone=65——用于自适应精炼线程数。总辅助开销（8GB 堆）: ~300MB（含 Card Table + BOT + Card Counts + 双 Bitmap + 2048 Region 对象 + RSet）。"

### Beginner Callout Boxes（≥7，全部 inline 在 §一 中）

1. **MAP_NORESERVE**: `mmap(PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE)` 预留虚拟地址不预分配 swap。不是物理内存，是地址空间。"reserved=8GB, committed=256MB" 的差异就是 NORESERVE 的体现。commit 时用 `mmap(MAP_FIXED, PROT_RW)` 提交物理页。

2. **TARGET_REGION_NUMBER=2048**: 为什么是 2048？经验值：太多 region → RSet 维护开销大（每个 region 有 RSet）。太少 → region 粒度粗 → 碎片化。2048 在大部分堆大小（1GB-64GB）给出 1MB-32MB region，是平衡点。

3. **Card Table 偏移优化**: `_byte_map_base = _byte_map - (heap_start >> 9)` 让 `byte_map_base[p >> 9]` 直接索引 card byte——消除 `(p - heap_start) >> 9` 的减法指令。每个字段存储操作省 1 CPU 指令 → 大量写屏障中累积收益显著。

4. **G1RegionToSpaceMapper**: 统一管理虚拟空间预留+分段 commit。每个 Mapper 负责一种数据结构（主堆/BOT/CardTable/CardCounts/Bitmap）。`commit_regions()` 并行提交——6 个 Mapper 可以并发 mmap。

5. **Card Counts Table**: 第三个 512B 粒度的辅助表——记录 card 被标记 dirty 的次数。用于 G1 自适应精炼：热 card（频繁修改）不加入 dirty card queue（减少精炼线程负载），冷 card 加入。

6. **HeapRegionRemSet (RSet)**: 每个 HeapRegion 150B 的 Remembered Set——记录哪些外部 region 引用了本 region。用于 G1 的 incremental collection: 只扫描 RSet 找 incoming references 而非整个堆。启动时 RSet 为空（所有 region 是 Free）。

7. **SATB (Snapshot At The Beginning)**: G1 并发标记的算法基础。写前屏障记录对象字段修改前的旧值到 SATB buffer。标记开始时所有 live objects 的 snapshot 在 SATB 中——即使对象在标记期间变 dead 也会被保留（floating garbage）。20 个 buffer 满触发并发标记线程处理。

8. **Humongous Region 阈值**: `_humongous_object_threshold_in_words = RegionSize/2`。超过半个 region 的对象是 Humongous——需要连续多个 region 存储。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:1490-1582` — G1CollectedHeap 构造函数
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:1638-2535` — G1CollectedHeap::initialize (18 步)
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:1855-2053` — 6 个 Mapper 创建
- `src/hotspot/share/gc/g1/heapRegion.cpp:64-111` — setup_heap_region_size (Region 大小计算)
- `src/hotspot/share/gc/g1/heapRegionManager.cpp:35-82` — HeapRegionManager::initialize
- `src/hotspot/share/gc/g1/heapRegionManager.cpp:165-218` — make_regions_available
- `src/hotspot/share/gc/g1/g1CardTable.cpp:75-139` — G1CardTable::initialize (_byte_map_base)
- `src/hotspot/share/gc/g1/g1RegionToSpaceMapper.cpp:78-99` — commit_regions (mmap 提交)
- `src/hotspot/share/gc/g1/heapRegionBounds.hpp:35-46` — MIN/MAX/TARGET constants
- `src/hotspot/share/gc/g1/satbMarkQueue.cpp:210-216` — SATBMarkQueueSet::initialize
- `src/hotspot/share/gc/g1/dirtyCardQueue.cpp:150-173` — DirtyCardQueueSet::initialize

Build: `make jdk`
Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so`

Key VM Flags:
| Flag | Default | Effect |
|------|---------|--------|
| G1HeapRegionSize | 0 (auto) | Region size; 0 → auto from TARGET_REGION_NUMBER |
| G1SATBProcessCompletedThreshold | 20 | SATB buffers completed → trigger concurrent mark |
| G1UpdateBufferSize | 256 | Dirty card update buffer entries |
| G1ConcRefinementThreads | 0 (auto) | Concurrent refinement thread count |

System calls:
| Call | man | Purpose |
|------|-----|---------|
| `mmap(NULL, size, PROT_NONE, MAP_NORESERVE\|ANON)` | man 2 | Virtual reservation (heap + 5 aux mappers) |
| `mmap(addr, size, PROT_RW, MAP_FIXED)` | man 2 | Physical commit per region batch |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **g1CollectedHeap.cpp** | `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | ~5000 | `initialize`(:1638, 18步), 6 Mapper create(:1855) | 🔥 主初始化—堆创建编排 |
| 2 | **g1CollectedHeap.hpp** | `src/hotspot/share/gc/g1/g1CollectedHeap.hpp` | ~1500 | `_hrm`, `_g1_policy`, `_task_queues`, `_dirty_card_queue_set` | G1 类声明—核心成员 |
| 3 | **heapRegion.cpp** | `src/hotspot/share/gc/g1/heapRegion.cpp` | ~1000 | `setup_heap_region_size`(:64), 构造函数(:246) | Region 大小计算 + 创建 |
| 4 | **heapRegionManager.cpp** | `src/hotspot/share/gc/g1/heapRegionManager.cpp` | ~500 | `initialize`(:35), `make_regions_available`(:165) | Region 管理—数组+FreeList |
| 5 | **g1CardTable.cpp** | `src/hotspot/share/gc/g1/g1CardTable.cpp` | ~200 | `initialize`(:75), `_byte_map_base`(:130) | Card Table 初始化 + 偏移优化 |
| 6 | **heapRegionBounds.hpp** | `src/hotspot/share/gc/g1/heapRegionBounds.hpp` | ~50 | `MIN_REGION_SIZE`, `MAX_REGION_SIZE`, `TARGET_REGION_NUMBER` | Region 常量定义 |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ 两步内存分配（Reserve → Commit）

问题：
  ① G1 为什么先 `mmap(PROT_NONE, MAP_NORESERVE)` 再分段 `mmap(MAP_FIXED, PROT_RW)` commit？
      答案方向: `g1CollectedHeap.cpp:1752` 调用 `Universe::reserve_heap(max_byte_size)`
        → `mmap(NULL, max_size, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE, -1, 0)`
        只占虚拟地址空间，不分配物理页。commit 阶段 `g1RegionToSpaceMapper.cpp:78-99`
        → `mmap(addr, region_size, PROT_READ|PROT_WRITE, MAP_FIXED|MAP_PRIVATE|MAP_ANONYMOUS, -1, 0)`
        在已预留的虚拟地址上提交物理页。
      
      追问: 为什么不能一次 `mmap(PROT_RW)` 直接分配全部物理内存？
      → 512GB 堆需要 512GB 物理内存 + swap → 远超实际可用量。lazy commit 确保
        只有真正使用的 region 才消耗物理页。虚拟地址免费，物理内存昂贵。

  ② Counterfactual: 如果只用一次 mmap 全 commit 而不分段？
      答案方向: 512GB 堆 → mmap 512GB PROT_RW → kernel overcommit → 实际物理内存
        不够时触发 OOM killer → 进程被杀。分段 commit 允许每个 region 按需提交——
        只 commit 正在使用的 regions，未使用的保持 PROT_NONE。

### 4.2 ★★★ Region 大小计算

问题：
  ① `HeapRegion::setup_heap_region_size()` (`heapRegion.cpp:64-111`) 如何计算 region_size？
      答案方向: 若 `G1HeapRegionSize` 未被用户设置（FLAG_IS_DEFAULT）→
        `average_heap_size = (initial + max) / 2`
        `region_size = MAX2(average_heap_size / TARGET_REGION_NUMBER, MIN_REGION_SIZE)`
        → clamp to [1MB, 32MB] → 取最大 2 的幂 → 8GB 堆: 8GB/2048=4MB
        设置 `LogOfHRGrainBytes=22, GrainBytes=4194304, CardsPerRegion=8192`
      
      追问: 为什么用 average 而非 max？
      → 堆可能动态扩容。用 average 避免 region 太大（扩容后 region 数太少）
        或太小（初始 region 太多 → RSet 维护开销）。

  ② Counterfactual: 如果 TARGET_REGION_NUMBER=1024 或 4096？
      答案方向: 1024 → region 大一倍 → 浪费更多空间（每个 region 内部碎片更多）
        → Humongous threshold 也大一倍 → 更多对象无法作为普通对象分配。
        4096 → region 小一半 → RSet 数量翻倍 → RSet 维护开销翻倍 → concurrent refinement 负载增加。

### 4.3 ★★★ 6 个 G1RegionToSpaceMapper — 内部机制 + BOT 设计

问题：
  ① G1 创建了哪 6 个 Mapper？每个管理什么、8GB 堆各多大？
      答案方向: `g1CollectedHeap.cpp:1855-2053`:
        1. heap_storage (8GB) — 主堆对象数据，使用 heap_rs.first_part
        2. bot_storage (16MB) — Block Offset Table (BOT)，O(1) 对象起始地址查找
        3. cardtable_storage (16MB) — Card Table，512B/card × N + guard
        4. card_counts_storage (16MB) — Card Counts Table，热卡缓存
        5. prev_bitmap_storage (128MB) — Previous Mark Bitmap (并发标记)
        6. next_bitmap_storage (128MB) — Next Mark Bitmap (并发标记)

  ② `G1RegionToSpaceMapper` 的内部 commit 粒度如何计算？`_pages_per_region` 和 `translation_factor` 的作用？
      答案方向: Mapper 构造参数: `_pages_per_region = region_size / page_size` (如 4MB/4KB=1024)。
        `translation_factor`: heap Mapper 为 1（直接映射），BOT/CardTable 为 card_size (512B)
        表示 1 个 Region 的 commit 对应多少字节的辅助结构。
        `commit_regions(start_idx, num_regions)`: 计算 `start_page = start_idx * _pages_per_region`，
        调用 `_storage.commit(start_page, num_regions * _pages_per_region)` → 底层 mmap(MAP_FIXED)。
        `AlwaysPreTouch` 时 WorkerGang 并行 touch 每个 page 触发物理页分配（避免首次访问时的 page fault 延迟）。
      
      追问: `create_mapper` vs `create_aux_memory_mapper` 的区别？
      → `create_mapper` 使用已有的 ReservedSpace (g1_rs)。`create_aux_memory_mapper`
        内部先 `new ReservedSpace(size)` → mmap 独立虚拟空间 → 再 `create_mapper`。
        5 个辅助 Mapper 都是独立 mmap，只有 heap_storage 使用 heap_rs.first_part。

      追问: `_commit_map` 位图的作用？
      → 记录哪些 region 已 commit。`set_range(start, start+num)` 标记。扩展时检查避免重复 commit。

  ③ BOT (Block Offset Table) 的 O(1) 查找机制是什么？
      答案方向: BOT 每 512B 堆区域存 1 个 offset byte——从当前地址到所属对象的起始位置的偏移。
        `block_start(p)` = `p - _array[p >> log2_card_size] * N_words` → 直接减法得对象头地址。
        为什么需要 BOT？GC 扫描 Card Table 找到 dirty card → 遍历 card 内的引用 → 需要知道每个引用
        属于哪个对象（用于 RSet 更新）→ BOT 提供 O(1) 对象起始地址查找。
        区别于 Card Table: Card Table 标记 dirty pages，BOT 定位对象边界。
      
      追问: BOT 的大小为什么是 16MB？
      → 8GB 堆 / 512B = 16M cards × 1 byte = 16MB。与 Card Table 相同粒度。
      
      反事实: 如果不用 BOT，如何找到对象起始地址？
      → 必须从 region 底部逐对象扫描直到超过目标地址 → O(n) 而非 O(1) → dirty card 处理显著变慢。

      反事实: 如果 6 个 Mapper 全放在一个映射里？
      → 单个 8GB 映射 → `mprotect` 改保护位需要对齐到 page boundary → 
        无法细粒度控制 → 且访问越界无隔离 → bug 难定位。

  ② Counterfactual: 如果全放在一个映射里？
      答案方向: 单个 8GB 映射 → `mprotect` 改保护位需要对齐到 page boundary →
        无法细粒度控制 → 性能优化空间为零 → 且访问越界无隔离 → bug 难定位。

### 4.4 ★★★ Card Table 偏移优化

问题：
  ① `_byte_map_base = _byte_map - (uintptr_t(low_bound) >> card_shift)` 的原理？
      答案方向: `g1CardTable.cpp:130`:
        card_byte_addr = &_byte_map_base[p >> card_shift]
        = _byte_map - (heap_start >> 9) + (p >> 9)
        = _byte_map + ((p - heap_start) >> 9)
        消除减法指令: 不用 `(p - heap_start) >> 9`，直接用 `p >> 9` 索引 `_byte_map_base`。
        x86 上 `LEA` 指令即可完成 `base + index`——单个指令替代 `sub` + `shr` + `add`。
      
      追问: `_byte_map_base` 是负数地址？安全吗？
      → `_byte_map_base` 可能 < 0 当 `heap_start` 足够大时。`p << 9` 当 p≥heap_start 时
        结果足够大，使最终地址回到合法范围。这是 C++ 合法且安全的指针算术。

  ② Counterfactual: 每次计算 `(p - heap_start) >> 9` 的代价？
      答案方向: 每个字段存储触发一次 card mark。10M writes/sec → 10M 次减法运算。
        `_byte_map_base` 优化消除 10M subtractions/sec → ~0.3ns/subtraction → 3ms CPU 节省。
        在 10K writes/sec 的应用中可忽略，但在高频 mutation 场景意义重大。

### 4.5 ★★★ Region 创建与 Free List

问题：
  ① `make_regions_available()` 如何创建 2048 个 HeapRegion？
      答案方向: `heapRegionManager.cpp:165-218`:
        1. commit_regions(0, 2048, workers) — 6 个 Mapper 各 mmap 提交
        2. for i in 0..2047: `new HeapRegion(hrm_index=i, bot, mr)`
           → new HeapRegionRemSet(bot, this) — 每个约 150B
           → initialize(mr): 设置 _bottom, _end, _top = bottom
           → _regions.set_by_index(i, hr)
        3. _available_map.par_set_range(0, 2048)
        4. for i in 0..2047: `insert_into_free_list(at(i))` — 全入 _free_list
      
      追问: 为什么 commit 用 workers（并行）？
      → OS mmap 系统调用耗时与 size 成正比。2048 regions → 可能 2048 次 commit →
        单线程耗时 → 多线程并行 mmap → 启动时间减半或更多。

  ② Counterfactual: 如果 HeapRegion 不包含 RSet？
      答案方向: GC 需要知道谁引用了这个 region → 唯一信息来源是 RSet。
        去掉 RSet → 每次 young GC 必须扫描整个 old gen 找引用 → 与 Card Table 缺失同效果。

### 4.6 ★★★ SATB + DirtyCard 队列双层设计

问题：
  ① 三套队列（SATBMarkQueueSet, DirtyCardQueueSet ×2）各自的作用和内部结构？
      答案方向: `g1CollectedHeap.cpp:2302-2342`:
        SATBMarkQueueSet (全局): process_completed_threshold=20 — 20 个 SATB buffer 满
          → 触发并发标记线程处理 → 标记所有存活的 old objects
        DirtyCardQueueSet (全局): yellow_zone=39, red_zone=65 — 控制 concurrent refinement
          线程数: 超过 yellow → 增加线程, 超过 red → 暂停 mutator 辅助精炼
        DirtyCardQueueSet (G1 自有): -1, -1 — 不自动处理，借用全局 buffer pool

  ② SATB buffer 的内部结构是什么？何时 allocation、何时 completed、并发标记线程如何 drain？
      答案方向: 每个 JavaThread 有私有 SATB buffer (SATBMarkQueue，继承自 PtrQueue)。
        buffer 大小 = `G1SATBBufferSize` entries。写前屏障: `enqueue(old_value)` →
        当前 buffer 满 → 加入 completed list → 分配新 buffer（从 `_free_list` CAS 取，
        空则 new CHeapObj）。`drain_satb_buffers()`: 遍历 `_completed_buffers` 链表 →
        逐个处理 entry（mark object + push to mark stack）。
        阈值 20 指 completed buffer 数达到 20 才触发 drain——减少频繁唤醒并发标记线程。
      
      追问: DirtyCard buffer 的 yellow/red zone 如何映射到线程数？
      → `G1ConcurrentRefine::adjust_threads()`: 检查 completed buffer 数 → 
        < yellow → 减少线程，≥ yellow → 增加线程，≥ red → 暂停 mutator (STW assist)。
        线程数在 0 到 `G1ConcRefinementThreads` 之间动态调整。

  ③ Counterfactual: 如果只有一个 DirtyCardQueueSet（不分全局/G1）？
      答案方向: GC worker 和 mutator 使用同一 buffer pool → 竞争 buffer 分配 →
        需要额外的同步 → 性能下降。分离后 G1 的 queue set 借用全局 pool 但不参与
        processing 决策——减少同步点。

### 4.7 ★★★ 启动总内存开销

问题：
  ① 8GB 堆启动时，辅助结构总计消耗多少内存？
      答案方向:
        HeapRegion 数组: 2048 × 8B = 16KB (指针数组)
        HeapRegion 对象: 2048 × ~200B = ~410KB
        HeapRegionRemSet: 2048 × ~150B = ~307KB
        Card Table: 16MB (mmap reserved)
        BOT: 16MB
        Card Counts: 16MB  
        prev_bitmap: 128MB
        next_bitmap: 128MB
        G1ConcurrentMark: ~5KB
        G1RemSet: ~200B
        CollectionSet: ~500B
        _in_cset_fast_test: 2048 bytes
        总计: ~305MB (不含堆对象本身的 8GB)
      
      追问: 这 305MB 中哪些是物理内存、哪些只是虚拟预留？
      → Bitmap×2 (256MB) 和 3 个 16MB 表在 commit_regions 时提交物理页。
        总计约 304MB 实际物理内存消耗。占 8GB 堆的 3.7%。

---

## §五 Article Structure

```
§〇 生产场景 — G1 Heap Reserve vs Commit
  ★ jcmd VM.native_memory → reserved=8GB, committed=256MB (启动时)
  ★ /proc/<pid>/maps → 6 个独立 mmap 区域
  ★ 反事实: 无 Card Table → young GC O(heap) STW

§一 ★★★ G1 Heap 启动 18 步全链路
  1.1 G1CollectedHeap 构造函数 — _workers/_allocator/_g1_policy/_task_queues
  1.2 initialize() 18 步总览
  1.3 ★ 两步 mmap: Reserve(PROT_NONE,NORESERVE) → Commit(MAP_FIXED,PROT_RW)
  1.4 Region 大小计算: TARGET_REGION_NUMBER=2048 → 8GB→4MB → LogOfHRGrainBytes=22
  1.5 ★ 6 个 G1RegionToSpaceMapper: heap/bot/cardtable/card_counts/prev_bitmap/next_bitmap
  1.6 Card Table: _byte_map + _byte_map_base 偏移优化 (省减法指令)
  1.7 make_regions_available: commit_regions + 2048×new HeapRegion + insert_into_free_list
  1.8 SATBMarkQueueSet (threshold=20) + DirtyCardQueueSet (yellow=39, red=65)
  1.9 ★ Mermaid: G1 堆完整内存布局图 (Reserved→Committed→6 Mapper→Region→CardTable)
  1.10 ★ 面试 Story Format 答案

§二 ★★★ 8 Beginner Callout 框 (inline in §一)

§三 ★★ 异常路径分析
  3.1 reserve_heap mmap 失败 → JNI_ENOMEM → vm_shutdown
  3.2 6 个 Mapper 之一 commit 失败 → expand_by 失败 → JNI_ENOMEM
  3.3 HeapRegion::new 失败 (C-Heap OOM) → vm_exit_out_of_memory
  3.4 SATB queue initialize 失败 → Monitor 分配失败 → vm_exit_during_initialization

§四 ★ GDB 断点验证 — 8 断点
  断言 1: reserve_heap → print heap_rs.size()
  断言 2: setup_heap_region_size → print GrainBytes
  断言 3: 6 Mappers → print 每个 mapper->reserved().size()
  断言 4: Card Table → print _byte_map_base
  断言 5: make_regions_available → print _hrm.length() + hr->type()
  断言 6: SATB queue → print process_completed_threshold
  断言 7: DirtyCard queue → print yellow_zone/red_zone
  断言 8: 总内存 → print total_aux_memory / M

§五 ★ Cross-Reference
  → 01-CodeCache (init_globals 第5步, 同属内存基础设施)
  → 03-Metaspace (init_globals 第9步, universe_init 子步骤)
  → 00-JNI-CreateJavaVM (vm_init_globals 中 mutex_init 创建了 G1 需要的 SATB/DirtyCard 锁)
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because compressed oops require contiguous heap address space, G1 uses PROT_NONE mmap to reserve the entire virtual region before committing individual regions..."

2. **3-5 lines source code per claim** — paste from g1CollectedHeap.cpp / heapRegion.cpp / g1CardTable.cpp.

3. **Mermaid** — G1 堆完整内存布局: Reserved space → 6 个 Mapper 各自的虚拟空间 → Commit 后的物理页 → Region 对象数组 → Card Table 索引 → _byte_map_base 偏移计算。

4. **≥8 Beginner callouts** inline in §一.

5. **Story-format interview answer** at §一末尾.

### 不要写成 → 应该写成

| 不要写成 | 应该写成 |
|---------|---------|
| "G1 堆用 mmap 分配" | "`Universe::reserve_heap(max_byte_size)` → mmap(PROT_NONE, MAP_PRIVATE\|ANON\|MAP_NORESERVE) 预留全部虚拟空间 → `commit_regions()` 按 Region 粒度 mmap(MAP_FIXED, PROT_RW) 提交物理页——每 4MB Region 触发一次 commit" |
| "Region 大小 4MB" | "`setup_heap_region_size()`: average=(init+max)/2 → average/2048 → clamp[1MB,32MB] → 取最大 2的幂: 8GB→4MB → 设置 `LogOfHRGrainBytes=22, GrainBytes=4194304, CardsPerRegion=8192`" |
| "Card Table 记录引用" | "`_byte_map_base = _byte_map - (heap_start >> 9)` → `byte_map_base[p >> 9]` 在 `LEA` 单指令完成, 消除 `(p - heap_start) >> 9` 的 subs+shr+add 三指令" |
| "6 个 Mapper 管理内存" | "heap_storage(8GB, 用 heap_rs.first_part) + create_aux_memory_mapper 创建 bot_storage(16MB) + cardtable_storage(16MB) + card_counts_storage(16MB) + prev/next_bitmap_storage(128MB each), 全部独立 mmap 虚拟空间" |
| "Region 初始全 Free" | "`make_regions_available(0,2048)`: commit_regions 并行 mmap → for i: new HeapRegion(i) + new HeapRegionRemSet → _type=Free → _top=_bottom → insert_into_free_list" |
| "SATB 队列用于并发标记" | "`SATBMarkQueueSet::initialize(..., G1SATBProcessCompletedThreshold=20)`: 20 个 completed buffer → 触发 `G1ConcurrentMark::drain_satb_buffers()` → 处理所有 buffered 旧引用值" |

---

## §七 Output Format

- Markdown file, named `02-G1-Heap-Startup.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/`

元信息头:
```
> **Phase**：[01-jvm-startup]
> **前置**：[01-CodeCache]（init_globals 第5步）、[00-JNI-CreateJavaVM]（mutex_init 创建的锁）
> **配套**：[03-Metaspace]、[04-SymbolTable]、[05-StringTable]（同属 universe_init）
> **后续依赖本文**：所有后续 Phase 依赖堆对象创建
> **阅读收益**：深度理解 G1 堆启动的 18 步序列——从 PROT_NONE 虚拟预留到 2048 个 HeapRegion 的 Free List，掌握 6 个独立 Mapper 的并行 commit 机制和 Card Table 的 _byte_map_base 偏移优化，量化 8GB 堆的 ~300MB 辅助内存开销。
```

- 目标行数: 600+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "G1 用 mmap 分配堆"而不展示两步 mmap（Reserve → Commit）的具体参数
- ❌ 不解释 TARGET_REGION_NUMBER=2048 的合理性 — 必须有 "太多→RSet维护开销, 太少→碎片化" 的trade-off
- ❌ 不列 6 个 Mapper 的名称/大小/用途 — 必须有完整 6 行表格
- ❌ 不推导 `_byte_map_base` 公式 — 必须有完整数学推导 + CPU 指令节省分析
- ❌ 不画内存布局图 — 必须有 Mermaid/ASCII 图展示 Reserved→Committed→Mapper→Region→CardTable 层次
- ❌ 不解释 SATB/DirtyCard 双层队列的区别 — 必须有 threshold=20/39/65 的含义
- ❌ 不量化辅助内存开销 — 必须计算 8GB 堆的 ~300MB 额外开销
- ❌ 不说明 HeapRegionRemSet 的初始状态 — 必须解释每个 Region 的 RSet 为空
- ❌ 不做 GDB 断点 trace — 至少 8 个断点覆盖 reserve/commit/mapper/card/region/satb

---

## §九 Required（≥8）

- ✅ **★ Mermaid G1 堆内存布局图** — Reserved→6 Mapper→Commit→Region→Card Table 完整层次
- ✅ **★ 两步 mmap 源码** — `Universe::reserve_heap` + `commit_regions` 的具体参数
- ✅ **★ Region 大小计算公式** — `setup_heap_region_size` 的完整推导 + LogOfHRGrainBytes
- ✅ **★ 6 个 G1RegionToSpaceMapper 表格** — 名称/大小/用途/创建方式 4 列
- ✅ **★ `_byte_map_base` 数学推导** — 公式展开 + CPU 指令对比
- ✅ **★ make_regions_available 源码** — commit + new HeapRegion × N 循环
- ✅ **★ SATB/DirtyCard 双层队列源码** — threshold 含义 + 初始化参数
- ✅ **★ 面试 Story Format 答案** — §一末尾
- ✅ **★ GDB 断点 ≥8 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ 辅助内存开销计算** — 8GB 堆 ~305MB 的逐项明细

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: reserve_heap (g1CollectedHeap.cpp:1752 之后)
  print Universe::heap()->reserved_region().byte_size() → 期望: 用户设置的 -Xmx 值
  print Universe::heap()->reserved_region().start() → 期望: 非 NULL 地址

断言 2: setup_heap_region_size (heapRegion.cpp:89 之后)
  print HeapRegion::GrainBytes → 期望: 4194304 (8GB 堆 → 4MB)
  print HeapRegion::LogOfHRGrainBytes → 期望: 22 (log2(4MB))
  print HeapRegion::CardsPerRegion → 期望: 8192 (4MB / 512B)

断言 3: 6 个 Mapper (g1CollectedHeap.cpp:2053 之后)
  print heap_storage->reserved().byte_size() → 期望: 用户设置的 heap size
  print bot_storage->reserved().byte_size() → 期望: ~16MB
  print cardtable_storage->reserved().byte_size() → 期望: ~16MB
  print card_counts_storage->reserved().byte_size() → 期望: ~16MB
  print prev_bitmap_storage->reserved().byte_size() → 期望: ~128MB

断言 4: Card Table (g1CardTable.cpp:130 之后)
  print G1CollectedHeap::heap()->card_table()->_byte_map → 期望: 非 NULL
  print G1CollectedHeap::heap()->card_table()->_byte_map_base → 期望: byte_map - (heap_start >> 9)
  print G1CollectedHeap::heap()->card_table()->_guard_index → 期望: heap_size/512 - 1

断言 5: make_regions_available (heapRegionManager.cpp:218 之后)
  print _hrm.length() → 期望: 2048 (8GB/4MB)
  print _hrm.at(0)->type() → 期望: Free (type tag = 0)
  print _hrm.at(0)->bottom() → 期望: = heap start
  print _hrm._free_list.length() → 期望: 2048 (全 Free)

断言 6: SATB queue (g1CollectedHeap.cpp:2305 之后)
  print G1BarrierSet::satb_mark_queue_set().process_completed_threshold() → 期望: 20

断言 7: DirtyCard queue (g1CollectedHeap.cpp:2330 之后)
  print G1BarrierSet::dirty_card_queue_set().num_par_ids() → 期望: = ParallelGCThreads
  print concurrent_refine()->yellow_zone() → 期望: 39
  print concurrent_refine()->red_zone() → 期望: 65

断言 8: 辅助内存开销
  print card_table_byte_size + bot_byte_size + card_counts_byte_size →
  print + prev_bitmap_byte_size + next_bitmap_byte_size →
  print + hrm.length() * (sizeof(HeapRegion) + sizeof(HeapRegionRemSet)) →
  # 期望: ~305MB (8GB 堆)
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 00-JNI-CreateJavaVM 承接**: 00 的 `vm_init_globals` 中 `mutex_init()` 创建了 `SATB_Q_FL_lock` 和 `DirtyCardQ_FL_lock`——G1 在 initialize 时使用这些锁初始化 SATB/DirtyCard 队列。

2. **同组边界**:
   - 01-CodeCache: init_globals 第 5 步，在 universe_init 之前创建
   - 02-G1-Heap-Startup（本文）: init_globals 第 9 步 universe_init 的子步骤 2
   - 03-Metaspace: universe_init 的子步骤 4（在 Heap 创建之后）
   - 04-SymbolTable + 05-StringTable: universe_init 的子步骤 11-12

3. **全部文档共享叙事弧**: "00 creates locks and main thread. 01 creates CodeCache (code container). 02 creates G1 Heap (object container) + Card Table + SATB queues. 03 creates Metaspace (class metadata container). 04-05 create symbol/string tables (lookup structures)."
