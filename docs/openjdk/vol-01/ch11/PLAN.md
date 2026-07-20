# ch11 G1 initialize_heap 写作规划

## 约束

每篇文章必须满足：
1. 所有依赖的前置概念已在之前文章中讲解过
2. 不能出现"这个概念在第 N 篇会讲"——读者必须能按顺序读

## 论文引用

| 概念 | 论文 |
|------|------|
| G1 Region + SATB + CSet 整体设计 | Detlefs 等, "Garbage-First Garbage Collection", ISMM 2004 |
| MMU (Minimum Mutator Utilization) | Bacon 等, "A Real-time Garbage Collector with Low Overhead and Consistent Utilization", POPL 2003 |
| 19 序列预测 + 自适应 IHOP | HotSpot 工程实现，非单篇论文 |

## 文章列表（19 篇）

已发表：
- [x] 01 堆入口场景 — initialize_heap 五阶段全景
- [x] 02 G1 Region 与策略 — setup_heap_region_size + RSet 三层初设
- [x] 03 ReservedSpace/mmap — reserve(PROT_NONE) + commit(MAP_FIXED)

待写：

### 基础层（无 G1 对象依赖）

- [ ] **04 G1Policy 构造骨架** — 02 后（需要 Region 大小）
  | 依赖: 02
  | 内容: 21字段分类 → 构造/init 两阶段分离 → PhaseTimes 30+计时器
  |       SurvRateGroup×2 → GCPolicyCounters
  | 论文: ISMM 2004（G1 整体设计）

- [ ] **05 G1Analytics + 预测引擎** — 04 后（_predictor + _analytics 在 04 构造中创建）
  | 依赖: 04
  | 内容: 19 个 TruncatedSeq → 8 组查表种子 → EWMA 双平均(davg vs avg)
  |       G1Predictions::get_new_prediction → 5 个生产决策场景
  | 论文: 工程实现

- [ ] **06 G1MMUTracker + IHOP 时间/空间约束** — 04 后
  | 依赖: 04
  | 内容: MMU 64 槽环形缓冲 + add_pause/when_sec 推演
  |       IHOP 自适应/静态 → get_conc_mark_start_threshold 完整数值示例
  | 论文: POPL 2003（MMU 概念）

- [ ] **07 WorkGang 线程池** — 独立机制
  | 依赖: 无
  | 内容: AbstractWorkGang → WorkGang → GangWorker → WorkerThread
  |       os::create_thread → pthread_create → GangTaskDispatcher 信号量协调

### G1 对象层（依赖基础层）

- [ ] **08 G1Allocator + HeapSizing** — 需要 04（Policy 的 analytics）
  | 依赖: 02, 04
  | 内容: G1Allocator 构造 → G1AllocRegion(三态) → G1HeapSizingPolicy(expansion_amount)

- [ ] **09 G1CollectedHeap 构造函数** — 需要 04+07+08
  | 依赖: 04, 07, 08
  | 内容: 75行构造 → 23字段分组 → 构造/init 分离原因

### initialize 篇（按 G1::initialize 的执行顺序）

- [ ] **10 6 Mapper 体系** — 需要 03（mmap）
  | 依赖: 03
  | 内容: G1RegionToSpaceMapper + G1PageBasedVirtualSpace + 虚拟提交

- [ ] **11 CardTable + BarrierSet + HRM** — 需要 10
  | 依赖: 10
  | 内容: G1CardTable → G1BarrierSet → HeapRegionManager::initialize

- [ ] **12 G1RemSet 初始化** — 需要 11
  | 依赖: 11
  | 内容: G1RemSet → OtherRegionsTable 三层初始化

- [ ] **13 G1ConcurrentMark(上)** — 需要 11+07
  | 依赖: 11, 07
  | 内容: 双缓冲位图 → CMThread → MarkStack → ConcGCThreads

- [ ] **14 G1ConcurrentMark(下)** — 需要 13
  | 依赖: 13
  | 内容: per-worker task + RootRegions + 位图大小公式

- [ ] **15 SATB 队列初始化** — 需要 11+13
  | 依赖: 11, 13
  | 内容: SATBMarkQueueSet + 线程本地队列

- [ ] **16 ConcurrentRefinement** — 需要 15
  | 依赖: 15
  | 内容: 四区模型 + 阶梯唤醒链

- [ ] **17 expand + policy->init + 收尾** — 需要 10+04+16
  | 依赖: 04, 10, 16
  | 内容: expand → make_regions_available → g1_policy()->init() → Dummy region

### 配角 + 串联

- [ ] **18 CompressedOops + TLAB** — 需要 17
  | 依赖: 17
  | 内容: narrow_oop(G1大堆) + TLAB(humongous threshold)

- [ ] **19 完整串联** — 需要 01-18 全部
  | 依赖: 全部
  | 内容: initialize_heap(62行) + G1::initialize(201行) 逐行拆解

## 写作进度

| 篇 | 状态 | 日期 |
|----|------|------|
| 01 | ✅ | 07/17 |
| 02 | ✅ | 07/17 |
| 03 | ✅ | 07/17 |
| 04-19 | — | — |
