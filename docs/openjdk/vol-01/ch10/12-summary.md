# 12. ch10 总结——200 行 initialize() 逐行讲透之后

> **本文定位**：ch10 全部 12 篇文章（01-11 + 补章 12b）的收官总结。不新增源码分析，只做三件事——把 `initialize()` 的完整执行路径再走一遍、提炼整章反复出现的设计模式、指出后续学习路径。

---

## 1. 整章覆盖范围回顾

ch10 用 12 篇文章拆解了 G1 堆创建的全过程。覆盖的源码范围：

```
Universe::initialize_heap()                ← ch10/01（全景）
+- create_heap()                           ← ch10/04
   +- create_heap_with_policy<G1CollectedHeap, G1CollectorPolicy>()
      +- new G1CollectorPolicy()           ← ch10/02
      |   +- setup_heap_region_size()      ← Region 大小 1/2/4/8/16/32MB
      |   +- setup_remset_size()           ← RSet 表容量
      +- new G1CollectedHeap(policy)       ← ch10/04a（75 行构造函数）

+- _collectedHeap->initialize()            ← 201 行，G1 专属
   +- Universe::reserve_heap()             ← ch10/03（两次 mmap）
   +- G1CardTable + BarrierSet             ← ch10/05
   +- HotCardCache                         ← ch10/05
   +- 6 个 G1RegionToSpaceMapper           ← ch10/05
   +- HeapRegionManager::initialize()      ← ch10/05
   +- G1RemSet                             ← ch10/06
   +- G1BlockOffsetTable + CSet fast test  ← ch10/06
   +- G1ConcurrentMark (~150 行)           ← ch10/07
   +- expand(init_byte_size)               ← ch10/08
   +- g1_policy()->init()                  ← ch10/09
   +- SATB + 双 DCQ + ConcurrentRefine     ← ch10/10
   +- Dummy Region + 分配器就位            ← ch10/11
   +- G1MonitoringSupport + StringDedup    ← ch10/11
   +- PreservedMarksSet                    ← ch10/11
   +- G1CollectionSet::initialize()        ← ch10/11

+- TLAB set_max_size / CompressedOops / TLAB startup   ← ch10/01（概览）
```

---

## 2. 一条主线：从"什么都没有"到"可以分配"

把 201 行 initialize() 抽象成四个阶段，整章的主线就清楚了：

```
Phase 1: 虚拟地址空间               Phase 2: 元数据
+------------------------------+   +------------------------------+
| mmap 预约最大堆地址空间       | → | 6 个 Mapper 管理各类元数据    |
| (ch10/03)                    |   | HeapRegionManager 建 _regions |
+------------------------------+   | (ch10/05)                    |
                                   +------------------------------+
              ↓
Phase 3: 并发引擎与物理内存         Phase 4: 分配器与收尾
+------------------------------+   +------------------------------+
| ConcurrentMark (~150 行)     |   | Dummy Region 上膛            |
| expand() commit 物理页       | → | 分配器激活 (ch10/11)         |
| 队列系统 (ch10/07-10)        |   | 监控/去重/CSet 就位          |
+------------------------------+   +------------------------------+
```

每个阶段的输出是下一阶段的输入：

| 依赖链 | 说明 |
|--------|------|
| `setup_heap_region_size` → 全部 | Region 大小决定 Mapper 粒度、TLAB 上限、humongous 阈值 |
| `reserve_heap` → 6 Mapper | Mapper 需要预先保留的虚拟地址空间 |
| `_hrm.initialize` → ConcurrentMark | CM 需要 `max_regions()` 分配 per-region 位图 |
| `expand` → `g1_policy()->init` | 策略初始化需要知道 expand 后的 free region 数量 |
| `expand` → Dummy Region | dummy 使用 region 0 的物理地址，必须已 commit |

---

## 3. 整章反复出现的设计模式

### 3.1 两段式初始化：构造函数 vs initialize()

```
构造函数（75 行，1418-1492）          initialize()（201 行，1533-1735）
轻量创建                          重量初始化
不需要 Heap_lock                  需要持 Heap_lock
不依赖堆地址                      依赖 reserved_region() 结果
失败只能抛异常                    失败返回 JNI_ENOMEM 优雅退出
```

G1CollectedHeap、G1ConcurrentMark、G1CollectionSet 全部遵循这个模式——先构造对象空壳（指针置 NULL），再在 initialize() 里真正分配资源。

### 3.2 双缓冲 / 双队列

整章出现了三处"一对"结构：

| 结构 | 用途 |
|------|------|
| prev_bitmap / next_bitmap | 并发标记双缓冲——一个在标，另一个给下次用 |
| SATB QueueSet / DCQ QueueSet | 一个处理存量（SATB 快照），一个处理增量（DirtyCard） |
| 共享 DCQ / 私有 DCQ | 共享的给并发 refine，私有的给 mutator 快速入队 |

### 3.3 预留地址 + 按需 commit

```
reserve_heap:  mmap(N)     ← 只预约地址，不碰物理页
expand():      mmap 已预留的区间 ← 真正 commit，逐个 Region 初始化
```

堆内存、BOT、card table、位图全部走这个模式——`G1RegionToSpaceMapper` 封装了这套逻辑。

### 3.4 哨兵与空对象

Dummy Region 是 `G1AllocRegion` 的 Null Object——用"永远非 NULL 但永远分配失败"的 Region 消除分配路径上的 NULL 检查（ch10/11）。类似的哨兵还有 `FreeRegionList::set_unrealistically_long_length(max_regions() + 1)`——把 free list 长度的"不可能阈值"设在合法操作永远碰不到的值，一旦碰线说明内部状态坏了（ch10/06）。

---

## 4. 各章核心收获速查表

| 章节 | 主题 | 核心收获 |
|------|------|---------|
| 01 | initialize_heap 全景 | 五阶段：create_heap → initialize → TLAB max → CompressedOops → TLAB startup |
| 02 | Region 大小与策略 | 候选值 = 堆平均大小/2048，向下取整到 2 的幂，夹在 [1MB, 32MB] |
| 03 | reserve_heap | 两次 mmap——先 `PROT_NONE` 占住地址空间，再 `MAP_FIXED` commit 建页表 |
| 04 | create_heap | `GCConfig::arguments()` 选 GC，模板 `create_heap_with_policy` 三段式 |
| 04a | 构造函数 | 75 行只做"轻量创建"——WorkGang、G1Allocator、RefToScanQueue |
| 05 | Mapper 体系 | 6 个 Mapper 各自管理 heap/BOT/cardtable/card_counts/双位图 |
| 06 | RemSet + BOT | RSet 三层存储（Sparse → Fine → Coarse 逐级升级）；BOT 加速对象查找 |
| 07 | ConcurrentMark | 双缓冲位图 + CMThread + 独立 WorkGang + MarkStack |
| 08 | expand | HRM 找连续区间，逐个 commit + 初始化 region 并入 free list |
| 09 | policy init | 策略绑定堆与 CSet，计算 young 区目标大小 |
| 10 | 队列系统 | SATB + 共享/私有 DCQ + ConcurrentRefine + YoungGenSampling 线程 |
| 11 | 收尾 | Dummy Region、分配器、监控、PreservedMarks、CSet 数组 |

---

## 5. 从 initialize() 结束后继续看什么

`initialize()` 返回后，堆还不能马上跑——还有两条线：

**运行时路径**（对象怎么分配）：
```
mutator TLAB 分配
  +- TLAB 不够 → G1Allocator::mutator_alloc_region()->attempt_allocation()
       +- dummy 失败 → attempt_allocation_locked() → 新 region
```
这正是 ch10/11 埋下的伏笔——dummy region 如何在实际分配中"被绕过"。

**第一次 GC 路径**（堆什么时候开始收集）：
```
Eden 满 → young GC
  +- G1CollectionSet::finalize_young_part() 填 _collection_set_regions[]
  +- 撤离失败 → _preserved_marks_set[worker_id].push()
```

ch12 是独立的 Metaspace 诊断章（依赖 ch09/07，非本章），与 G1 堆初始化无直接承接关系。

**回到 initialize_heap() 内部**：ch10 的五阶段中，(1)(2) 由 ch10/02-04 讲透，(3)(4)(5) 由[补章 12b](12b-compressed-oops-and-tlab.md)讲透（universe.cpp:764-823）：

```
Universe::initialize_heap()
+- (1) create_heap()                                     ← ch10/04 已讲
+- (2) _collectedHeap->initialize() (201 行)              ← ch10/02-11 已讲
+- (3) ThreadLocalAllocBuffer::set_max_size()             ← 12b §2 已讲
|      +- heap()->max_tlab_size() = humongous 阈值（半 Region）
+- (4) CompressedOops 模式决策 (~40 行)                   ← 12b §3 已讲
|      +- 4GB/32GB 两个阈值切出 Unscaled/ZeroBased/DisjointBase/HeapBased
+- (5) ThreadLocalAllocBuffer::startup_initialization()   ← 12b §4 已讲
       +- _target_refills = 50 + GlobalTLABStats + 主线程 TLAB 重初始化
```

(3)-(5) 是 ch10 的遗留缺口——原计划在 ch10/06 展开（压缩指针与 TLAB），但 ch10/06 实际写成了 RemSet+BOT。已由[补章 12b](12b-compressed-oops-and-tlab.md)补完（三步合计约 90 行源码，一篇搞定）。

**再往后**才是 `universe_init()` 主线的后续步骤（universe.cpp:675-749）：

```
universe_init()
+- (3) SystemDictionary::initialize_oop_storage()          ← ch09-02
+- (4) Metaspace::global_initialize()                      ← ch09-07
+- (5) MetaspaceCounters::initialize_performance_counters()← ch09-06
+- (6) JVMFlagConstraintList::check_constraints()          ← ch09-05
+- (7) ClassLoaderData::init_null_class_loader_data()      ← ch09-03
+- (8) 6× new LatestMethodCache()                          ← ch11
+- (9) MetaspaceShared::initialize_shared_spaces()（CDS）  ← 不讲解（已归档）
+- (10) SymbolTable / StringTable::create_table()           ← 已归档
+- ⑪ ResolvedMethodTable::create_table()                 ← 已归档
```

---

## 6. 结束语

ch10 用了 12 篇文章（01-11 + 补章 12b）、覆盖 200+ 行 initialize()。回到最初的问题：**为什么 G1 的堆初始化这么重？**

答案是 G1 的全部特殊性都在这里：不是一块连续内存（6 个 Mapper 分治管理）、不是简单分代（Region 类型动态切换）、不是暂停即完（并发标记 + 并发 refine + 队列系统）、失败要优雅（撤离失败有 PreservedMarks 兜底）。这 200 行就是 G1 设计哲学的浓缩。

> **下一篇**：[ch11.1 LatestMethodCache](../ch11/01-latest-method-cache.md)——`universe_init()` 第 (8) 步，堆刚建好后的 6 个单槽方法缓存。
