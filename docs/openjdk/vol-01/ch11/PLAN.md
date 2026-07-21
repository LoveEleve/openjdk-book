# ch11 G1 initialize_heap 写作规划

## ch11 目标

读者读完 10 篇后能回答以下核心问题（面试可考）：

1. **G1 为什么用 Region 而不是连续分代？**（设计决策 + trade-off）
2. **G1 怎么管理 Region 化的堆？**（6 Mapper + HRM + Region 级 commit）
3. **G1 的写屏障做什么？**（SATB 写前 + dirty card 写后 + 两级队列 + 热卡缓存）
4. **G1 怎么追踪跨 Region 引用？**（RemSet + 三层 PRT 退化 + refine 流程）
5. **G1 怎么并发标记存活对象？**（ConcurrentMark + 双缓冲位图 + mark stack + SATB + 周期阶段）
6. **G1 怎么控制停顿时间？**（Policy 预测 + MMU + IHOP + 队列系统 3 区模型）
7. **G1 怎么分配对象？**（Allocator 三态 + PLAB + TLAB + Dummy region）
8. **G1 初始化的完整流程是什么？**（create_heap → initialize 21 步串联）

**不要求掌握的**（源码细节，查源码即可）：
- G1CMTask 29 字段 / OtherRegionsTable free list / BOT 指数编码公式 / ConcurrentRefine calc_thresholds 公式

## 写作原则

**按 `initialize_heap` 的执行顺序组织**——跟着源码执行流走，每篇覆盖一个阶段或子系统，不跳顺序。合并细节篇（如 6 Mapper+HRM 合一篇、RemSet+BOT 合一篇），控制在 10 篇。

每篇按"执行顺序 → 做了什么 → 为什么"组织，不是源码逐行拆解：
1. **执行位置**——在 `initialize_heap` 的哪个阶段
2. **做了什么**——创建/初始化了哪些组件
3. **为什么**——这些组件解决什么问题（设计决策）

源码字段、数据结构细节只作为"证据"在需要时引用，不是文章主线。

## 执行顺序总览

```
Universe::initialize_heap()
  ├─ 阶段 1: GCConfig::create_heap()                    → ch11/04
  │    ├─ 选 GC 类型（G1Arguments）
  │    ├─ new G1Policy() + initialize_all()
  │    └─ new G1CollectedHeap(policy)
  │
  ├─ 阶段 2: G1CollectedHeap::initialize()              → ch11/05-09
  │    ├─ reserve_heap（mmap）                           ← ch11/03 已讲
  │    ├─ CardTable + BarrierSet + HotCardCache         → ch11/05
  │    ├─ 6 个 G1RegionToSpaceMapper                    → ch11/05
  │    ├─ HRM.initialize                                → ch11/05
  │    ├─ RemSet + BOT + in_cset_fast_test              → ch11/06
  │    ├─ ConcurrentMark + CMThread                     → ch11/07
  │    ├─ expand（init heap size）                      → ch11/08
  │    ├─ policy->init()                                → ch11/08
  │    ├─ SATB queue + Refinement + DirtyCardQueue      → ch11/08
  │    ├─ Dummy region + AllocRegion                    → ch11/09
  │    └─ Monitoring + PreservedMarks + CSet            → ch11/09
  │
  ├─ 阶段 3: compressed oops 设置                        → ch11/09
  ├─ 阶段 4: TLAB::startup_initialization()              → ch11/09
  └─ 阶段 5: 返回 JNI_OK
```

## 文章列表（10 篇）

### 已发表

- [x] **01 堆入口场景** — initialize_heap 五阶段全景
  | 文件: 01-initialize-heap-overview.md
  | 覆盖: initialize_heap 五阶段总览

- [x] **02 G1 Region 与策略** — Region 大小 + RSet 三层初设
  | 文件: 02-g1-region-policy.md
  | 覆盖: setup_heap_region_size + RSet 容量公式

- [x] **03 ReservedSpace/mmap** — reserve + commit
  | 文件: 03-reservedspace-mmap.md
  | 覆盖: mmap(PROT_NONE) + MAP_FIXED + G1PageBasedVirtualSpace

### 待写

- [ ] **04 G1CollectedHeap 构造 + G1Policy 构造**（阶段 1）
  | 执行位置: GCConfig::create_heap()
  | 覆盖: 选 GC + new G1Policy + new G1CollectedHeap + 构造函数字段
  | 核心: G1Policy 的 4 个核心子对象（Analytics/MMU/IHOP/PhaseTimes）+ 构造/init 两段式
  | 备注: 旧 04-g1policy-skeleton.md 重新组织

- [ ] **05 内存布局：CardTable + 6 Mapper + HRM**（阶段 2 前半）
  | 执行位置: g1CollectedHeap.cpp:1575-1629
  | 覆盖: G1CardTable + G1BarrierSet + HotCardCache + 6 个 Mapper + HRM.initialize
  | 核心: 6 份独立内存（heap/BOT/cardTable/cardCounts/prevBitmap/nextBitmap）+ Region 级 commit
  | 写屏障详细: 卡值状态（clean/dirty/g1_young_gen/claimed/deferred）+ 偏置数组技巧（_byte_map_base）+ 写前/写后屏障工作流程 + 两级队列结构概貌（thread-local + 全局 QueueSet，详细在 08）+ HotCardCache insert 流程 + 热阈值 G1ConcRSHotCardLimit=4
  | Mapper详细: 两种子类策略（G1RegionsLargerThanCommitSizeMapper——Region 跨多页，直接 commit；G1RegionsSmallerThanCommitSizeMapper——页跨多 Region，用 CommitRefcountArray 引用计数，0→1 才 commit，1→0 才 uncommit）
  | 次要组件: G1CardTableChangedListener（on_commit 回调——新 Region commit 时批量标 young）+ G1PageBasedVirtualSpace（ch11/03 讲过，05 引用）+ G1ThreadLocalData（per-thread SATB/DCQ 队列持有）
  | 备注: 新 04-region-memory-management.md 重新组织

- [ ] **06 跨 Region 引用：RemSet + BOT + CSet 快速测试**（阶段 2 中段）
  | 执行位置: g1CollectedHeap.cpp:1640-1659
  | 覆盖: G1RemSet + G1BlockOffsetTable + in_cset_fast_test + humongous_reclaim_candidates
  | 核心: RSet 怎么追踪入引用 + BOT 怎么定位对象边界 + CSet 快速测试位图
  | RemSet详细: G1FromCardCache（per-thread × per-Region 缓存，add_reference 第一步查命中跳过）+ OtherRegionsTable 三层结构（Sparse→Fine→Coarse 退化路径）+ refine_card_concurrently 7 步流程 + G1RemSetScanState 并行扫描协调 + HeapRegionRemSet vs OtherRegionsTable 关系
  | BOT详细: _offset_array 指数编码 + 两阶段定位（BOT 粗定位 + 对象链细定位）
  | 次要组件: HeapRegionRemSet 的 code roots（G1CodeRootSet——存 nmethod 引用）+ HeapRegionRemSet 状态机（Untracked/Updating/Complete——决定 add_reference 是否生效）+ SparsePRT 双缓冲（_cur + _next，便于并发 expand）+ PerRegionTable 的 free list + 双向链表（bulk free）+ FreeRegionList（MasterFreeRegionListMtSafeChecker 并发检查）

- [ ] **07 并发标记：ConcurrentMark + CMThread**（阶段 2 中后段）
  | 执行位置: g1CollectedHeap.cpp:1663-1668
  | 覆盖: G1ConcurrentMark + CMThread + 双缓冲位图 + mark stack + SATB 队列
  | 核心: 并发标记怎么工作 + SATB 怎么处理并发修改
  | CM详细: G1CMTask（per-worker 标记任务）+ 并发周期 8 阶段（mark/preclean/remark/cleanup/rebuild）+ 双缓冲位图 swap 机制 + mark stack 两级结构（全局 chunk 化 + per-worker 本地队列）+ root region scan + overflow 处理 + ParallelTaskTerminator（终止协议——所有 worker 标记完了怎么退出）+ WorkGangBarrierSync（overflow 双屏障同步）
  | SATB详细: 激活/关闭时机 + drain 4 时机 + regular_clock 主动 abort
  | 次要组件: G1RegionMarkStats / G1RegionMarkStatsCache（per-region live words 统计 + 1024 槽哈希缓存减少原子竞争）+ G1CMTaskQueueEntry（oop vs array slice 标签——bit0 区分）+ G1CMObjArrayProcessor（大数组按分片处理避免单对象压栈）+ G1CMConcurrentMarkingTask / G1CMRemarkTask / G1CMRootRegionScanTask（三个 WorkGang task）

- [ ] **08 expand + policy->init + 队列系统**（阶段 2 后段）
  | 执行位置: g1CollectedHeap.cpp:1671-1707
  | 覆盖: expand + policy->init + SATB queue + ConcurrentRefinement + DirtyCardQueue
  | 核心: expand 到 init heap size + Policy 绑定 heap + 队列初始化
  | 队列详细: PtrQueue 基础 + thread-local vs 全局 QueueSet 两级结构 + completed buffer 管理 + free list + 阈值激活 + ConcurrentRefine 3 区模型（green/yellow/red）+ 阶梯唤醒链 + 自适应 adjust
  | expand详细: HRM::commit_regions → 6 Mapper 同步 + policy->init 绑定 _g1h/_collection_set + update_young_list_target_length + YoungGenSamplingThread
  | 次要组件: SATB filter()（双指针压缩——保留"仍需标记且未被 next bitmap 标记"的条目）+ _shared_satb_queue / _shared_dirty_card_queue（非 Java 线程用，持锁）+ _free_ids（并行 worker id 分配）+ _processed_buffers_mut / _processed_buffers_rs_thread（分别统计 mutator 和 rs 线程处理的 buffer 数）+ G1YoungRemSetSamplingThread（周期性采样 young region 的 rs_lengths，修正预测）
  | 备注: 05 讲 G1BarrierSet 时只提 QueueSet 两级结构概貌，详细机制在本文展开

- [ ] **09 对象分配 + TLAB + 收尾**（阶段 2 末尾 + 阶段 3-4）
  | 执行位置: g1CollectedHeap.cpp:1711-1732 + compressed oops + TLAB + post_initialize
  | 覆盖: Dummy region + AllocRegion + TLAB + CompressedOops + Monitoring + PreservedMarks + CSet + initialize_serviceability
  | 核心: mutator 怎么分配对象 + compressed oops 设置 + TLAB 启动
  | 分配详细: G1AllocRegion 三态（Mutator/Survivor/Old）+ Dummy region 作用（非空不变式）+ attempt_allocation vs locked 两段式 + PLAB 机制 + 自适应大小 + post_initialize（双 ReferenceProcessor）+ G1StringDedup
  | 收尾详细: initialize_serviceability（创建 JMX 内存池 _eden_pool/_survivor_pool/_old_pool + 注册到 memory_manager——把 Region 化堆伪装成分代模型暴露给 JMX）+ G1MonitoringSupport + PreservedMarksSet + CSet.initialize
  | 次要组件: G1EvacStats（PLABStats 子类——记录 evacuated/浪费/直接分配，用于 PLAB 大小自适应）+ G1HeapSizingPolicy（构造函数体创建，expand 时用）+ G1HeapVerifier（构造函数体创建，堆验证）+ G1PLABAllocator（被 G1ParScanThreadState 持有，GC 期间 PLAB 管理）+ MutatorAllocRegion::retire 的 should_retain（TLAB 缓存复用优化）

- [ ] **10 完整串联**（阶段 5）
  | 执行位置: initialize_heap 全流程回顾
  | 覆盖: 把 01-09 串起来
  | 核心: 读者能回答"G1 初始化做了什么、为什么这么设计"

## 文件命名方案

| 篇 | 文件名 | 旧文件处理 |
|---|---|---|
| 04 | 04-heap-policy-construction.md（新写） | 旧 04-g1policy-skeleton.md 重命名为 04-heap-policy-construction-draft.md |
| 05 | 05-memory-layout-mapper.md（新写） | 新 04-region-memory-management.md 重命名为 05-memory-layout-mapper.md |
| 06 | 06-remset-bot.md（新写） | — |
| 07 | 07-concurrent-mark.md（新写） | — |
| 08 | 08-expand-policy-queue.md（新写） | — |
| 09 | 09-allocation-tlab-finalize.md（新写） | — |
| 10 | 10-initialize-recap.md（新写） | — |

## 写作进度

| 篇 | 状态 | 日期 |
|----|------|------|
| 01 | ✅ | 07/17 |
| 02 | ✅ | 07/17 |
| 03 | ✅ | 07/17 |
| 04-10 | — | — |

## 论文引用

| 概念 | 论文 |
|------|------|
| G1 Region + SATB + CSet 整体设计 | Detlefs 等, "Garbage-First Garbage Collection", ISMM 2004 |
| MMU (Minimum Mutator Utilization) | Bacon 等, "A Real-time Garbage Collector with Low Overhead and Consistent Utilization", POPL 2003 |
| SATB (Snapshot-At-The-Beginning) | Yuasa, "Real-time garbage collection on general-purpose machines", JFP 1990 |
