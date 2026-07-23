# ch11 G1 全生命周期写作规划

## ch11 目标

读者读完 15 篇后能回答以下核心问题（面试可考）：

1. **G1 为什么用 Region 而不是连续分代？**（设计决策 + trade-off）
2. **G1 怎么管理 Region 化的堆？**（6 Mapper + HRM + Region 级 commit）
3. **G1 的写屏障做什么？**（SATB 写前 + dirty card 写后 + 两级队列 + 热卡缓存）
4. **G1 怎么追踪跨 Region 引用？**（RemSet + 三层 PRT 退化 + refine 流程）
5. **G1 怎么执行 Young GC？**（CSet 选择 + RSet 扫描 + Evacuation + PLAB + Humongous Reclaim）
6. **G1 怎么并发标记存活对象？**（ConcurrentMark + 双缓冲位图 + mark stack + SATB + 周期阶段）
7. **G1 怎么控制停顿时间？**（Policy 预测 + 队列系统 3 区模型 + IHOP + Mixed GC 分批）
8. **G1 怎么分配对象？**（Allocator 三态 + PLAB + TLAB + Dummy region）
9. **G1 初始化的完整流程是什么？**（create_heap → initialize 21 步 → 全生命周期串联）

**不要求掌握的**（源码细节，查源码即可）：
- G1CMTask 29 字段 / OtherRegionsTable free list / BOT 指数编码公式 / ConcurrentRefine calc_thresholds 公式

## 写作原则

**按理解顺序组织**——不代表代码执行顺序，而是读者认知路径：先知道 G1 运行时做什么，再回来看初始化为什么这么建。

每篇按"执行位置 → 做了什么 → 为什么"组织，不是源码逐行拆解：
1. **执行位置**——在 `initialize_heap` 或 G1 运行时的哪个阶段
2. **做了什么**——创建/初始化/执行了哪些组件
3. **为什么**——这些组件解决什么问题（设计决策）

**依赖规则**：A 依赖 B，则 B 必须排在 A 前面。不允许在讲解 A 时用"B 将在后面解释"搪塞。

## 理解顺序总览

```
初始化（01-06）→ Young GC 运行时（07-08）→ 回来讲初始化收尾（09-10）→ CM（11-13）→ Mixed GC（14）→ 回顾（15）

  G1CollectedHeap::initialize() 执行顺序              文档顺序（理解路径）
  ─────────────────────────────                      ──────────────────
  reserve_heap (mmap)                    → ch11/03    01 全景 → 02 Region → 03 mmap
  CardTable + 6 Mapper + HRM            → ch11/05    04 Policy → 05 布局 → 06 RemSet
  RemSet + BOT + CSet                   → ch11/06    ──────────────────────────
  ConcurrentMark + CMThread             → (延后到11) 07 Young GC 流程（新）
  expand + policy->init + SATB/DCQ      → ch11/09    08 Young GC 机制（新）
  Dummy + AllocRegion + TLAB +收尾       → ch11/10    ──────────────────────────
  ─────────────────────────────                      09 队列+expand（原07）
                                                     10 分配+TLAB（原08）
                                                     ──────────────────────────
                                                     11 CM 数据结构
                                                     12 CM 周期前半
                                                     13 CM 周期后半
                                                     14 Mixed GC
                                                     15 全生命周期回顾
```

## 文章列表（15 篇）

### 已发表（01-06）

- [x] **01 堆入口场景** — initialize_heap 五阶段全景
  | 文件: `01-initialize-heap-overview.md`
  | 覆盖: initialize_heap 五阶段总览

- [x] **02 G1 Region 与策略** — Region 大小 + RSet 三层初设
  | 文件: `02-g1-region-policy.md`
  | 覆盖: setup_heap_region_size + RSet 容量公式

- [x] **03 ReservedSpace/mmap** — reserve + commit
  | 文件: `03-reservedspace-mmap.md`
  | 覆盖: mmap(PROT_NONE) + MAP_FIXED + G1PageBasedVirtualSpace

- [x] **04 G1CollectedHeap 构造 + G1Policy 构造**
  | 文件: `04-heap-policy-construction.md`
  | 执行位置: GCConfig::create_heap()
  | 覆盖: 选 GC + new G1Policy + new G1CollectedHeap + 构造函数字段
  | 核心: G1Policy 的 4 个核心子对象（Analytics/MMU/IHOP/PhaseTimes）+ 构造/init 两段式

- [x] **05 内存布局：CardTable + 写屏障 + 6 Mapper + HRM**
  | 文件: `05-memory-layout-mapper.md`
  | 执行位置: g1CollectedHeap.cpp:1575-1629
  | 覆盖: G1CardTable + G1BarrierSet + HotCardCache + 6 个 Mapper + HRM.initialize
  | 核心: 6 份独立内存（heap/BOT/cardTable/cardCounts/prevBitmap/nextBitmap）+ Region 级 commit

- [x] **06 跨 Region 引用：RemSet + BOT + CSet 快速测试**
  | 文件: `06-remset-bot.md`
  | 执行位置: g1CollectedHeap.cpp:1640-1659
  | 覆盖: G1RemSet + G1BlockOffsetTable + in_cset_fast_test + humongous_reclaim_candidates
  | 核心: RSet 怎么追踪入引用 + BOT 怎么定位对象边界 + CSet 快速测试位图

### 待写——Young GC 运行时（07-08）

- [ ] **07 Young GC：Evacuation 周期**（运行时 1/2）
  | 文件: `07-young-gc-evacuation.md`
  | 执行位置: `g1CollectedHeap.cpp` 中 `collect()` → `do_collection_pause()` → Young-only pause 分支
  | 覆盖: 触发条件 + CSet 选择 + RSet 扫描 + Evacuation + 引用更新
  | 核心: 一个 Young GC pause 内部到底做了什么
  | 详细:
    - **触发条件**: eden 用尽（allocation failure）+ IHOP 触发时的 initial-mark piggyback
    - **CSet 选择**（young-only）: eden + survivor 全部 + 预测的 pause time 不超目标
    - Policy 预测: pause time 预测器（`_recent_gc_times` + `_pause_time_target`）
    - **Evacuation 根扫描**: 类根 + JNI 引用 + 线程栈根 + Universe 根 + JFR 引用
    - **RSet 扫描**: 用 06 讲的 `_scan_top[]` + `G1RemSetScanState` 并行扫描协调
    - **对象复制**: forwarding pointer → 拷贝到 survivor/old → 更新引用
    - **Survivor 晋升**: 年龄阈值 + G1Policy 算目标长度（不是简单"到 age 就晋升"）
    - **Pause time 报告**: `G1EvacStats` + `G1PhaseTimes` 各阶段耗时
  | 次要:
    - `G1CollectedHeap::do_collection_pause` 入口
    - `G1ParScanThreadState`（per-GC-worker 状态对象）
    - `G1ParScanClosure`（引用更新闭包）
    - `evac_failure` 处理（promotion 失败的 fallback）
  | 备注: 这是读者第一次看到初始化建好的数据结构**真正用起来**

- [ ] **08 Young GC：内部机制**（运行时 2/2）
  | 文件: `08-young-gc-internals.md`
  | 覆盖: PLAB + Preserved Marks + Dirty Card 处理 + Humongous Eager Reclaim + TLAB 交互
  | 核心: 让 evacuation 并行且安全的细节机制
  | 详细:
    - **PLAB**: per-GC-worker 本地分配缓冲 + 三个 PLAB（gclab/eden/survivor）+ 自适应大小 + 末尾 flush
    - **Preserved Marks**: forwarding pointer 与 mark 冲突时用 `G1PreservedMark` 暂存 + `PreservedMarksSet` 跨 worker 汇总 + 统一回填
    - **Dirty Card 处理**（GC 期间）: refine 线程在 pause 中处理 DCQ → 更新 RSet → 为下次 GC 准备
    - **Humongous Eager Reclaim**: `humongous_reclaim_candidates` 位图（06 建的）+ Young GC 中尝试回收
    - **TLAB 交互**: GC 结束后 `_mutator_alloc_region` retire → 新 TLAB 申请
    - `G1PostEvacuateCollectionSetClosure` 收尾
  | 次要:
    - `G1PLABStats`（浪费率统计反馈给 PLAB 大小调整）
    - `G1ParScanThreadState::allocate` 在 PLAB 失败时的 fallback
    - `fixup_root_set`（Reference 引用修复，跨 worker 同步）
  | 备注: 与 07 互补——07 讲流程主干，08 讲"为什么暂停时间可控"

### 待写——初始化收尾（09-10）

- [ ] **09 expand + policy->init + 队列系统**（阶段 2 后段）
  | 文件: `09-expand-policy-queue.md`
  | 执行位置: g1CollectedHeap.cpp:1671-1707
  | 覆盖: HRM::commit_regions → 6 Mapper 同步 → policy->init → SATB/DCQ 队列初始化
  | 核心: expand 到 init heap size + Policy 绑定 heap + 队列系统完整初始化
  | 详细:
    - `expand()`: HRM::commit_regions 调用链 + 6 Mapper 同步 commit
    - `policy->init()`: 绑定 _g1h/_collection_set + update_young_list_target_length + YoungGenSamplingThread
    - SATB queue 初始化: thread-local + 全局 QueueSet + completed buffer 管理 + free list + 阈值激活
    - **ConcurrentRefinement 3 区模型**: green（只缓存）/ yellow（逐步激活）/ red（全部 Refine）/ 超过 red+padding → mutator 背压参与处理 + 阶梯唤醒链 + 自适应 adjust
    - DCQ 初始化: 全局 `G1BarrierSet::dirty_card_queue_set` + 实例级委托
  | 次要:
    - SATB `filter()` 双指针压缩
    - `_shared_satb_queue` / `_shared_dirty_card_queue`（非 Java 线程，持锁）
    - `_free_ids`（并行 worker id 分配）
    - `_processed_buffers_mut` / `_processed_buffers_rs_thread`
    - `G1YoungRemSetSamplingThread`
  | 备注: 此时读者已理解 Young GC 运行时，所以 3 区模型的**动机**（"GC 暂停时不能积压太多 dirty card"）自然清晰

- [ ] **10 对象分配 + TLAB + 初始化收尾**
  | 文件: `10-allocation-tlab-finalize.md`
  | 执行位置: g1CollectedHeap.cpp:1711-1732 + compressed oops + TLAB + post_initialize
  | 覆盖: Dummy region + AllocRegion + TLAB + CompressedOops + Monitoring + PreservedMarks + CSet + initialize_serviceability
  | 核心: mutator 怎么分配对象 + compressed oops 设置 + TLAB 启动 + 初始化收尾
  | 详细:
    - `G1AllocRegion` 三态（Mutator/Survivor/Old）+ Dummy region 作用（非空不变式）
    - `attempt_allocation` vs `locked` 两段式
    - PLAB 概述（GC 期间 by evacuation——已在 08 详细讲，本文只对比 TLAB vs PLAB）
    - TLAB 启动: `TLAB::startup_initialization()`
    - CompressedOops: 窄指针 + base + shift 偏置
    - `post_initialize`: 双 `ReferenceProcessor` + `G1StringDedup`
    - `initialize_serviceability`: JMX 内存池（eden/survivor/old）→ 把 Region 化堆伪装成分代模型
    - Monitoring + PreservedMarksSet + CSet.initialize
  | 次要:
    - `G1EvacStats`（PLABStats 子类）
    - `G1HeapSizingPolicy` + `G1HeapVerifier`
    - `G1PLABAllocator`
    - `MutatorAllocRegion::retire` 的 `should_retain`
  | 备注: "TLAB 满 → 分配失败 → 触发 Young GC"这条链路现在自然闭合——读者已在 07/08 理解 Young GC

### 待写——并发标记（11-13）

- [ ] **11 并发标记：数据结构**（CM 1/3）
  | 文件: `11-concurrent-mark-data-structures.md`
  | 覆盖: 双缓冲位图 + Mark Stack + SATB 队列 + G1CMTask + Root Region + CM 初始化
  | 核心: 并发标记需要哪些数据结构、各自怎么设计
  | 详细:
    - **双缓冲位图**（`_prev_mark_bitmap` / `_next_mark_bitmap`）: swap 机制
    - **Mark Stack**: 全局 chunk 化 + per-worker 本地队列（无锁）+ overflow 路径
    - **G1CMTask**（29 字段）: per-GC-worker 标记任务对象
    - **SATB 队列**在 CM 阶段的角色: activate/deactivate + 4 drain 时机
    - **Root Region**: surviving 区在下一轮 CM 是"必然可达"的根源
    - **G1RegionMarkStats** + **1024 槽哈希缓存**: 减少原子竞争
    - **CM 初始化**（5 行代码）: `new G1ConcurrentMark` + `cm_thread()` + 字段初设
  | 次要:
    - `G1CMTaskQueueEntry`（oop vs array slice，bit0 区分）
    - `G1CMObjArrayProcessor`（大数组分片）
    - 三个 WorkGang task
    - `_marking_task_overheads`
  | 备注: 09 已讲 SATB 队列初始化，本篇讲 SATB 在 CM 阶段的驱动

- [ ] **12 并发标记：周期前半**（CM 2/3）
  | 文件: `12-concurrent-mark-cycle-first-half.md`
  | 覆盖: Initial-mark + Root Region Scan + Concurrent Mark + Preclean + Overflow
  | 核心: 应用线程不停顿的并发部分
  | 详细:
    - **Initial-mark**（STW，piggyback 在 Young GC——读者已从 07 理解 piggyback）
    - **Root Region Scan**（并发）: 扫描 survivor 区找对 old 区的引用
    - **Concurrent Mark**: GC worker + CM thread 一起跑 + 工作窃取
    - **Preclean**: SATB 队列 + dirty card 队列一起处理
    - **Overflow**: `WorkGangBarrierSync` 双屏障同步
    - **regular_clock 主动 abort**: 每 100ms 检查 SATB 队列长度
  | 备注: "并发"的真正实现——应用线程不被阻塞

- [ ] **13 并发标记：周期后半**（CM 3/3）
  | 文件: `13-concurrent-mark-cycle-second-half.md`
  | 覆盖: Remark + Cleanup + Rebuild RSet + 终止协议 + 标记结果落盘
  | 核心: STW 收尾 + 输出 per-region liveness 给 Mixed GC
  | 详细:
    - **Remark**（STW）: 终止 CM 任务 + 排空 SATB 队列
    - **Cleanup**（STW）: 计算 per-region liveness + 排序 + 标记 candidate
    - **Rebuild RSet**: 用 06 讲的状态机 `update_after_rebuild`
    - **ParallelTaskTerminator**: 所有 worker 忙等在 barrier + 最后 worker 偷活推进
    - **标记结果传递**: liveness → 14 Mixed GC 用于老年代回收目标选择
  | 备注: 输出的"per-region 存活字节数"是 Mixed GC 的输入

### 待写——Mixed GC + 回顾（14-15）

- [ ] **14 Mixed GC + Full GC 降级**
  | 文件: `14-mixed-gc-and-fallback.md`
  | 覆盖: IHOP 触发 + 老年代 CSet 选择 + 与 Young GC 的区别 + Full GC 兜底
  | 核心: 怎么用 CM 标记结果回收老年代
  | 详细:
    - **IHOP 触发**: 标记结束后预测老年代增长 → 达阈值 → 启动 Mixed GC
    - **老年代 CSet 选择**: 13 Cleanup 的 liveness + `G1MixedGCCountTarget`（分批）+ `G1HeapWastePercent`（浪费阈值）
    - **执行**: 复用 07 的 evacuation 流程，CSet 多了 old region
    - **收敛**: 每轮回收数递减 → 最终放弃
    - **Full GC 降级**: 触发条件 + 流程 + 为什么 G1 尽量避免
  | 备注: G1 一个完整周期结束

- [ ] **15 全生命周期回顾**
  | 文件: `15-full-lifecycle-recap.md`
  | 覆盖: 01-14 串成完整故事 + 回答 9 个核心问题 + 设计决策复盘
  | 核心: 读者能从 0 到完整 G1 设计
  | 详细:
    - **时间线**: 启动 → 初始化 → Young GC 首次触发 → IHOP 触发 CM → Mixed GC → Full GC 兜底
    - **数据结构生命周期**: 每篇建的、每篇用的、最终作用的映射图
    - **9 核心问题答案汇总**: 一句话答案 + 链接
    - **设计决策复盘**: Region vs 分代 / SATB vs Incremental Update / Mixed GC vs Full GC
    - **调优参数全景**: IHOP / MaxGCPauseMillis / G1MixedGCCountTarget / G1HeapWastePercent

## 文件命名方案

| 篇 | 文件名 | 状态 |
|---|--------|------|
| 01 | `01-initialize-heap-overview.md` | ✅ |
| 02 | `02-g1-region-policy.md` | ✅ |
| 03 | `03-reservedspace-mmap.md` | ✅ |
| 04 | `04-heap-policy-construction.md` | ✅ |
| 05 | `05-memory-layout-mapper.md` | ✅ |
| 06 | `06-remset-bot.md` | ✅ |
| 07 | `07-young-gc-evacuation.md` | 待写 |
| 08 | `08-young-gc-internals.md` | 待写 |
| 09 | `09-expand-policy-queue.md` | 待写 |
| 10 | `10-allocation-tlab-finalize.md` | 待写 |
| 11 | `11-concurrent-mark-data-structures.md` | 待写 |
| 12 | `12-concurrent-mark-cycle-first-half.md` | 待写 |
| 13 | `13-concurrent-mark-cycle-second-half.md` | 待写 |
| 14 | `14-mixed-gc-and-fallback.md` | 待写 |
| 15 | `15-full-lifecycle-recap.md` | 待写 |

## 关键决策

### 为什么 Young GC 必须排在 07/08

06 RemSet 讲完了"怎么追踪跨 Region 引用"，读者迫切想知道**这些数据结构在 GC 里怎么用**。如果跳过 Young GC 直接讲队列初始化（SATB/DCQ/ConcurrentRefinement 3 区模型），读者没有 GC 运行时上下文，只看到"在初始化这些东西"但不理解为什么。

反之，07/08 讲 Young GC 时：
- "eden 分配失败触发 GC"——不需要 TLAB 细节（TLAB 只是一种快速分配方式）
- "RSet 扫描出 CSet 的入引用"——直接引用 06，读者已懂
- "GC 暂停时 refine 线程继续处理 dirty card"——简单提及，详细留给 09 队列系统

Young GC 拆 2 篇（07 + 08）的理由：
- 内容量大（CSet/RSet扫描/Evacuation/引用更新/PLAB/PreservedMarks/DirtyCard/Humongous/交互），合并超 50KB
- 逻辑分层：07 是"流程主干"（GC 做了什么），08 是"并行安全机制"（为什么能做好）
- 可独立阅读：07 读完已能回答 "Young GC 是什么"

### 为什么 CM 拆 3 篇（11-13）

- 11 数据结构: 准备"工具箱"（bitmap/stack/SATB/task/root region）
- 12 周期前半: 用工具做"并发标记"（应用线程不停的那段）
- 13 周期后半: STW 收尾 + 输出结果给 Mixed GC

13 的 per-region liveness 直接传入 14 Mixed GC，形成数据传递链。

### CM 初始化代码放 11 开头

CM 在 init 里的初始化只有 5 行（`new G1ConcurrentMark` + `cm_thread()` + 字段初设）。放在 11"数据结构"开头，自然衔接"数据结构怎么建的"。

09（队列系统）简要提及"CM 已创建（详见 11）"即可。

## 写作进度

| 篇 | 状态 | 日期 |
|----|------|------|
| 01 | ✅ | 07/17 |
| 02 | ✅ | 07/17 |
| 03 | ✅ | 07/17 |
| 04 | ✅ | 07/20 |
| 05 | ✅ | 07/21 |
| 06 | ✅ | 07/23 |
| 07-15 | — | — |

## 论文引用

| 概念 | 论文 |
|------|------|
| G1 Region + SATB + CSet 整体设计 | Detlefs 等, "Garbage-First Garbage Collection", ISMM 2004 |
| MMU (Minimum Mutator Utilization) | Bacon 等, "A Real-time Garbage Collector with Low Overhead and Consistent Utilization", POPL 2003 |
| SATB (Snapshot-At-The-Beginning) | Yuasa, "Real-time garbage collection on general-purpose machines", JFP 1990 |
| PLAB 起源 | Flood 等, "Parallel garbage collection for shared memory computers" |
