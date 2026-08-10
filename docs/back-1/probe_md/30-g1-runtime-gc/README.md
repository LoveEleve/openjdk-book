# 30 — G1 运行时 GC — libjvm.so (gc/g1/)

## §〇 概述

分析 G1 GC 的核心运行时行为：从对象分配到 Young GC 执行、并发标记生命周期、Mixed GC 策略决策到 Full GC 最后手段。

**源码路径**：`src/hotspot/share/gc/g1/` (197 文件, ~65K 行)

### BUILD_LIBRARY

```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM
```

### 与已有 Phase 的衔接

| 已有文档 | 覆盖内容 | Phase 30 不重复 |
|---------|---------|----------------|
| 01-02-G1-Heap-Startup (1403行) | G1CollectedHeap 构造函数 18 步、mmap reserve/commit、6 个 Mapper、CardTable 布局、Region 类型初始化 | 从"堆已创建"展开运行时行为 |
| 01-08-G1-Policy-Analytics (1403行) | G1Policy 8 子组件初始化、Analytics 17 个 TruncatedSeq、IHOP 控制、MMUTracker | 展开运行时决策循环 |
| 01-09-G1-Concurrent-Marking-Infra (720行) | G1ConcurrentMark 构造函数、双缓冲位图、CMTask×13 | 展开标记全生命周期 |

---

## §一 已覆盖 vs 待覆盖

```
gc/g1/ (197 files, ~65K lines)

✅ 已覆盖（Phase 01 初始化）:
  G1CollectedHeap::initialize()           → 01-02 (构造 18 步)
  G1Policy 构造函数                        → 01-08 (8 子组件 init)
  G1ConcurrentMark 构造函数                → 01-09 (双 Bitmap + CMTask)
  G1CardTable::initialize()               → 01-02 (card_shift 计算)
  G1BarrierSet 初始化                      → 01-02 (SATB + post-write)

⏳ 待覆盖 — Phase 30 目标:
  ───────────── 堆运行时 ─────────────
  HeapRegion 生命周期                     Region 9 态状态机、Free→Eden→Old 转换
  HeapRegionManager 运行时                commit/uncommit 按需模型、Expand 策略
  HeapRegionRemSet 动态                   Sparse/Coarse/Fine PRT 三级切换
  Humongous 分配完整路径                   start+continues Region、eager reclaim
  Free List 管理                          MasterFreeRegionList + Secondary + Old

  ───────────── 对象分配路径 ─────────────
  TLAB 快速分配                           MemAllocator::mem_allocate → attempt_allocation
  G1Allocator 三层分配                    Mutator/SurvivorGC/OldGC AllocRegion
  PLAB 晋升缓冲区                          GC worker 的 Promotion Local Allocation Buffer
  Barrier Set 完整语义                     SATB pre-write + Card post-write + DirtyCardQueue

  ───────────── Young GC 运行时 ─────────────
  GC 触发路径                             VM_G1CollectForAllocation VM 操作
  Evacuation 核心                         根扫描 → 对象复制 → 引用更新
  G1ParScanThreadState                    Worker 线程扫描状态机 + oop 队列
  Remembered Set 扫描                     脏卡→PRT→跨 region 引用定位
  Reference Processing                    Soft/Weak/Phantom/Final 引用处理
  Pause 后处理                            Age Table 合并、Survivor 晋升、并发精炼唤醒

  ───────────── 并发标记运行时 ─────────────
  标记生命周期                            Initial Mark → Root Scan → Concurrent → Remark → Cleanup
  SATB 语义详解                           逻辑快照、pre-write barrier、buffer drain
  CMTask 并行标记                         13 task steal-based 调度
  Cleanup + Region 活跃度                 回收全空 Region、Mixed GC 准备
  Eager Reclaim                           Humongous 对象并发回收
  String Dedup                            字符串去重

  ───────────── Mixed GC + 策略 ─────────────
  CollectionSet 选择算法                  按 reclaimable bytes 排序 Old Region
  Mixed GC 终止条件                       期望回收量 + pause time 预测
  IHOP 自适应                             静态 vs 自适应 IHOP 运行时行为
  MMUTracker 暂停预测                     64 元素环形队列衰减平均
  Evacuation Failure 恢复                 Self-forwarded ptr 恢复

  ───────────── Full GC ─────────────
  Full GC 触发条件                        CM Failure、Evac Failure 升级、System.gc()
  Mark → Prepare → Adjust → Compact       4 阶段完整流程
  G1FullGCCompactionPoint                 逐 Region 压缩点管理
  Full GC 与 Young GC 异同                串行/并行、复制/压缩
```

---

## §二 文档拆分规划

| 编号 | 标题 | 源文件数 | 源码行数 | 状态 |
|:---:|------|:---:|:---:|:---:|
| 00 | Region Runtime & Allocation | 12 | ~4,200 | 待开始 |
| 01 | Young GC — Evacuation Full Lifecycle | 10 | ~6,900 | 待开始 |
| 02 | Concurrent Marking Lifecycle | 10 | ~5,700 | 待开始 |
| 03 | Mixed GC + Policy Decision Engine | 12 | ~3,800 | 待开始 |
| 04 | Full GC — Last Resort | 12 | ~1,600 | 待开始 |

### doc-00: Region Runtime & Allocation

Region 9 态状态机 + TLAB/PLAB/Humongous 分配路径 + Barrier + Card Table + Free List

**核心源文件**：
- `heapRegion.hpp/cpp` (~1200行) — Region 状态机
- `heapRegionManager.hpp/cpp` (~550行) — commit/uncommit
- `heapRegionType.hpp/cpp` (~200行) — 类型枚举
- `heapRegionSet.hpp/cpp` (~350行) — Free List 双链表
- `heapRegionRemSet.hpp/cpp` (~500行) — Sparse/Coarse/Fine PRT
- `g1Allocator.hpp/cpp` (~350行) — 三层 AllocRegion
- `g1AllocRegion.hpp/cpp` (~250行) — AllocRegion 填充/重试
- `memAllocator.hpp/cpp` (~200行) — TLAB 快速分配入口
- `g1BarrierSet.hpp/cpp` (~400行) — SATB + Card barrier
- `g1CardTable.hpp/cpp` (~350行) — Card 标记与扫描
- `dirtyCardQueue.hpp/cpp` (~300行) — 脏卡队列
- `satbMarkQueue.hpp/cpp` (~250行) — SATB 缓冲区

**关键问题**：
- Q1: HeapRegion 的 Free → Eden → Old 状态转换何时发生、由谁驱动？
- Q2: 一个 `new byte[3MB]` 如何从 TLAB 一路落到 Humongous Region？
- Q3: 为什么 G1 需要 SATB pre-write barrier，而 Parallel GC 不需要？
- Q4: Card Table 的 512 字节/card 粒度是如何计算的？

### doc-01: Young GC — Evacuation Full Lifecycle

GC 触发 → Safepoint 同步 → 根扫描 → 对象疏散 → 引用处理 → Pause 后处理

**核心源文件**：
- `g1CollectedHeap.cpp:3335-4020` (~700行) — do_collection_pause_at_safepoint()
- `vm_operations_g1.cpp:78-165` (~90行) — VM_G1CollectForAllocation
- `g1RootProcessor.hpp/cpp` (~450行) — 根集合扫描
- `g1ParScanThreadState.hpp/cpp/inline` (~500行) — Worker 扫描状态机
- `g1RemSet.hpp/cpp` (~1210行) — RSet 扫描
- `heapRegionRemSet.hpp/cpp` (~500行) — 单 Region PRT
- `g1OopClosures.hpp/cpp/inline` (~400行) — Evacuation 闭包
- `referenceProcessor.hpp/cpp` (~1800行) — 引用发现/处理
- `g1EvacFailure.hpp/cpp` (~263行) — 疏散失败恢复
- `g1Policy.cpp:600-900` (~300行) — Pause 后策略更新

**关键问题**：
- Q1: 疏散 (evacuation) 中对象被复制到新 Region，原始指针如何变成新地址？
- Q2: Young GC 中 Eden 满了但 Survivor 也满，对象晋升到 Old 的条件？
- Q3: Remembered Set 比全堆扫描能减少多少工作量？什么情况会膨胀？
- Q4: Humongous 对象在 Young GC 中被处理吗？eager reclaim 需要什么条件？

### doc-02: Concurrent Marking Lifecycle

Initial Mark → Root Region Scan → Concurrent Mark → Remark → Cleanup 全生命周期

**核心源文件**：
- `g1ConcurrentMark.cpp` (~3322行) — 标记生命周期 + CMTask + Cleanup
- `g1ConcurrentMarkThread.cpp` (~449行) — 标记线程循环
- `g1ConcurrentMarkBitMap.hpp/cpp/inline` (~350行) — 双缓冲位图
- `g1ConcurrentMarkObjArrayProcessor.hpp/cpp` (~120行) — 大数组分段
- `satbMarkQueue.hpp/cpp` (~250行) — SATB 队列
- `g1RegionMarkStatsCache.hpp/cpp/inline` (~150行) — Region 统计缓存
- `collectionSetChooser.hpp/cpp` (~200行) — CSet 选择器
- `g1StringDedup.hpp/cpp` (~350行) — 字符串去重
- `g1ConcurrentRefine.hpp/cpp` (~350行) — 并发精炼
- `g1ConcurrentRefineThread.hpp/cpp` (~150行) — 精炼线程

**关键问题**：
- Q1: 为什么 G1 用 SATB 而 CMS 用 Incremental Update？设计区别在哪？
- Q2: Initial Mark 为什么嵌入 Young GC？独立的利弊？
- Q3: Remark 阶段必须 pause 的原因？哪些工作无法并发完成？
- Q4: Cleanup 阶段回收全空 region 是 STW 的吗？代价多大？
- Q5: Concurrent Mark 中 allocation rate > mark rate 会发生什么？

### doc-03: Mixed GC + Policy Decision Engine

CSet 选择 + Mixed GC 执行 + IHOP/MMUTracker 自适应 + Evac Failure 处理

**核心源文件**：
- `g1Policy.hpp/cpp` (~1324行) — 决策引擎核心
- `g1Analytics.hpp/cpp` (~500行) — 预测模型衰减平均
- `g1IHOPControl.hpp/cpp` (~300行) — IHOP 自适应
- `g1CollectorState.hpp` (~100行) — Young Only↔Mixed 状态机
- `collectionSetChooser.hpp/cpp` (~200行) — CSet 排序选择
- `g1CollectionSet.hpp/cpp` (~250行) — CSet 管理
- `g1HeapSizingPolicy.hpp/cpp` (~200行) — 堆大小自适应
- `g1MMUTracker.hpp/cpp` (~200行) — 暂停时间追踪
- `g1InitialMarkToMixedTimeTracker.hpp` (~60行) — 时间追踪
- `g1EvacFailure.hpp/cpp` (~263行) — 疏散失败恢复
- `evacuationInfo.hpp` (~80行) — 疏散统计
- `g1YoungGCTraceTime.hpp` (~50行) — 日志追踪

**关键问题**：
- Q1: G1Policy 如何决定"这次是 Young GC 还是 Mixed GC"？
- Q2: CollectionSet 选择算法如何平衡"暂停时间"和"回收量"？
- Q3: 多少轮 Mixed GC 才够？什么时候回收不如预期？
- Q4: 疏散失败后 Recovery 如何保证对象不丢失？
- Q5: IHOP 自适应公式如何工作？-XX:InitiatingHeapOccupancyPercent=45 的依据？

### doc-04: Full GC — Last Resort

触发条件 → Mark → Prepare → Adjust → Compact 4 阶段完整流程

**核心源文件**：
- `g1FullCollector.cpp` (~335行) — Full GC 流程编排
- `g1FullGCMarker.hpp/cpp/inline` (~150行) — 标记器
- `g1FullGCMarkTask.hpp/cpp` (~80行) — 标记任务
- `g1FullGCPrepareTask.hpp/cpp` (~80行) — 压缩准备
- `g1FullGCAdjustTask.hpp/cpp` (~80行) — 指针调整
- `g1FullGCCompactTask.hpp/cpp` (~80行) — 对象移动
- `g1FullGCCompactionPoint.hpp/cpp` (~100行) — 压缩点
- `g1FullGCOopClosures.hpp/cpp/inline` (~120行) — 闭包集合
- `g1FullGCScope.hpp/cpp` (~60行) — Timer/Tracer
- `g1FullGCReferenceProcessorExecutor.hpp/cpp` (~100行) — 引用处理
- `g1FullGCTask.hpp/cpp` (~50行) — 任务基类
- `vm_operations_g1.cpp:37-76` (~40行) — VM_G1CollectFull

**关键问题**：
- Q1: G1 Full GC 是并行还是串行？每个阶段用什么并行策略？
- Q2: 为什么 Full GC 压缩对象而 Young GC 只复制？实现区别？
- Q3: Concurrent Mode Failure 和 Allocation Failure 触发 Full GC 的区别？
- Q4: Full GC 期间 Humongous 对象可达到时会被移动吗？

---

## §三 进度状态

| 步骤 | 状态 | 描述 |
|------|:---:|------|
| README 规划 | ✅ 完成 | 5 篇文档拆分方案 |
| jvm-scout 源码定位 | ✅ 完成 | 5 代理并行定位 (55+ 文件, 300+ 符号) |
| jvm-reader 源码阅读 | ✅ 完成 | 5 代理并行阅读 (120+ 方法深度分析) |
| jvm-tracer 调用链追踪 | ✅ 完成 | 3 代理并行追踪 (24 条跨子系统调用链) |
| Prompt 写作 | ✅ 完成 | 5 代理并行写作 (3,452 行, 38 问题组) |
| 文档生成 | ⏳ | 在新会话完成 (预期 ~12,500-17,500 行) |
| Review | ⏳ | 自检 + 修复 |

### 当前产出

| 文件 | 行数 | 状态 |
|------|:---:|:---:|
| `README.md` | 本文件 | ✅ |
| `prompts/prompt-00-Region-Allocation.md` | **758** (≥450 ✅) | ✅ |
| `prompts/prompt-01-Young-GC-Evacuation.md` | **496** (≥450 ✅) | ✅ |
| `prompts/prompt-02-Concurrent-Marking.md` | **697** (≥450 ✅) | ✅ |
| `prompts/prompt-03-Mixed-GC-Policy.md` | **781** (≥450 ✅) | ✅ |
| `prompts/prompt-04-Full-GC.md` | **720** (≥450 ✅) | ✅ |
| **Prompt 总计** | **3,452** | ✅ |
| `research-00-summary.md` ~ `research-04-summary.md` | 5 份研究汇总 | ✅ |

---

## §四 参考

- `probe_md/book/vol-02-gc-plan.md` — 第2卷 GC 书籍规划（6 章 3 级目录）
- `probe_md/01-jvm-startup/docs/02-G1-Heap-Startup.md` — G1 堆初始化（1403行）
- `probe_md/01-jvm-startup/docs/08-G1-Policy-Analytics.md` — G1Policy 初始化（1403行）
- `probe_md/01-jvm-startup/docs/09-G1-Concurrent-Marking-Infra.md` — 并发标记基础设施（720行）
