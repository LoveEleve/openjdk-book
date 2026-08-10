# 第2卷：堆与垃圾回收（以 G1 为主，多 GC 横向对比）

> **内容来源**：基于 probe_md/ 下 ~215K 行深度分析文档及 src/hotspot/share/gc/ 源码
> **目标读者**：Java 进阶开发者，已读完第1卷（JVM 启动全流程）或等价知识
> **现有资产**：01-jvm-startup/docs/02-G1-Heap-Startup (1403行)、08-G1-Policy-Analytics (1403行)、09-G1-Concurrent-Marking-Infra (720行)

---

## 一、源码资产总览

### 1.1 GC 相关 Phase README 已有覆盖

| Phase | 文件 | GC 相关度 | 覆盖内容 |
|-------|------|--------|---------|
| 01-jvm-startup | README.md | **高** | universe_init() 中 G1Heap 初始化、barrier set、CardTable |
| 01-jvm-startup | docs/02-G1-Heap-Startup.md (1403行) | **核心** | G1 堆 mmap reserve/commit, 6 个 Mapper, Region 布局, CardTable, 18 步构造函数 |
| 01-jvm-startup | docs/08-G1-Policy-Analytics.md (1403行) | **核心** | G1Policy 8 子组件、IHOP、MMUTracker、Analytics、GCPhaseTimes、MonitoringSupport |
| 01-jvm-startup | docs/09-G1-Concurrent-Marking-Infra.md (720行) | **核心** | G1ConcurrentMark 构造函数、双缓冲位图、MarkStack、CMTask×13、ConcurrentRefine、YoungRemSetSampling |
| 15-core-native | README.md | 中 | Runtime.gc → JVM_GC 入口 |
| 17-jmx-management | README.md | 中 | GCMemoryManager、MemoryPool×3、GCNotifier、SensorInfo 阈值 |
| 19-signal-chaining | README.md | 低 | JVM_handle_linux_signal 中 GC/safepoint 防冲突 |
| 20-sa-postmortem | README.md | 中 | vmStructs_gc.hpp, SA 查看 GC 内部状态 |
| 23-logging | README.md | 中 | `-Xlog:gc*` 日志框架 |
| 24-utilities | README.md | 低 | BitMap (G1 标记位图基类) |
| 25-jfr | README.md | 中 | GC 周期事件采样 |
| 27-memory-extra | README.md | 高 | Metaspace 独立分析（可复用为堆外内存对比基线） |
| 28-code-extra | README.md | 中 | nmethod GC safepoint 协作、OopMap GC 扫描 |

### 1.2 现有文档内容覆盖矩阵

| 文档 | 已覆盖 | 未覆盖（需第2卷补） |
|------|--------|------------------|
| 02-G1-Heap (1403行) | 构造函数 18 步、mmap 预留/commit、CardTable、Region 类型、Mapper 层、JMX Pool | Region 回收状态机、Old 代分配器、Humongous 分配全路径、Free List 管理、TLAB retire、GC 锁 (GCLocker) |
| 08-G1-Policy (1403行) | 8 个子组件初始化、Analytics 17 个 TruncatedSeq、IHOP 静态/自适应 | Mixed GC 决策循环、CollectionSet 选择算法、Young/Mixed 阶段切换、Pause 预测自适应、Heap 大小自适应 |
| 09-G1-CM (720行) | 构造函数、双缓冲位图、MarkStack、CMTaskQueueSet、ConcurrentRefine | **并发标记完整生命周期** (initial mark → remark → cleanup)、SATB pre-write barrier 语义、Live Object 统计、Region 活跃度分类、标记中止与 restart、String Dedup 去重 |

### 1.3 GC 源文件统计

| GC 实现 | 目录 | 源文件数 (.hpp+.cpp) | 总行数 | 角色 |
|---------|------|-------------------|--------|------|
| **G1** | `src/hotspot/share/gc/g1/` | 197 | ~65K | 默认 GC，本书主分析目标 |
| **Shared** | `src/hotspot/share/gc/shared/` | 178 | ~35K | GC 基础设施（ReferenceProcessor, TLAB, OopStorage, WorkGang） |
| **Parallel** | `src/hotspot/share/gc/parallel/` | 81 | ~24K | 吞吐量优先的并行 GC |
| **CMS** | `src/hotspot/share/gc/cms/` | 47 | ~22K | 旧低延迟 GC（已不推荐） |
| **Z** | `src/hotspot/share/gc/z/` | 158 | ~20K | ZGC 超低延迟（<1ms 暂停） |
| **Shenandoah** | `src/hotspot/share/gc/shenandoah/` | 130 | ~23K | 并发压缩 GC |
| **Serial** | `src/hotspot/share/gc/serial/` | 20 | ~3.4K | 单线程 GC（最小堆） |
| **Epsilon** | `src/hotspot/share/gc/epsilon/` | 14 | ~1.3K | 无操作 GC（基准/测试） |

---

## 二、第2卷 6 章规划：3 级目录

### 规划原则

1. **由已知深入未知**：重用 01-jvm-startup 3 篇已有分析（02/08/09），不重复初始化内容
2. **按数据流组织**：分配路径 → Young GC → 并发标记 → Mixed GC → Full GC → 跨 GC 对比
3. **G1 为主轴 (5章) + 多 GC 对比 (1章)**：G1 5 章覆盖全生命周期，第6章横跨 7 种 GC

### 第6章：G1 堆运行时 — 从 Region 模型到对象分配

#### 6.1 堆的运行时视角（区别于启动视角）
- 6.1.1 HeapRegion 9 态状态机 — Free → Eden → Survivor → Old → Humongous → Archive, 含转换条件 (`heapRegionType.hpp:35-65`)
- 6.1.2 HeapRegionManager 的 commit/uncommit 按需模型 — 与 02 篇中启动时 6 个 Mapper 的预留/commit 相呼应 (`heapRegionManager.cpp:380-450`)
- 6.1.3 Humongous 对象分配完整路径 — 跨 region 大对象: start+continues 区域布局、eager reclaim 策略 (`g1CollectedHeap.cpp:1300-1450`)
- 6.1.4 三种 Free List：MasterFreeRegionList + SecondaryFreeList + OldFreeList 的选择逻辑 (`heapRegionSet.hpp`)
- 6.1.5 HeapRegion RemSet 动态选择 — Sparse/Coarse/Fine 三级 PRT (Per-Region Table) (`heapRegionRemSet.cpp:150-250`)

#### 6.2 对象分配路径
- 6.2.1 TLAB 快速分配 — `MemAllocator::mem_allocate` → `attempt_allocation` 链路 (`memAllocator.cpp:58-120`)
- 6.2.2 G1Allocator 三层分配 — MutatorAllocRegion + SurvivorGCAllocRegion + OldGCAllocRegion (`g1Allocator.hpp:45-70`)
- 6.2.3 TLAB retire 时 retire_fill 与 Region 边界碰撞 (`g1Allocator.cpp:85-115`)
- 6.2.4 PLAB (Promotion Local Allocation Buffer) — GC worker 晋升缓冲区 (`plab.cpp:50-90`)
- 6.2.5 Humongous 分配中 GCLocker 协作 — `GCLocker::check_active_before_gc` 防止死锁 (`gcLocker.cpp:70-100`)

#### 6.3 Barrier 与 Card Table
- 6.3.1 G1BarrierSet 的 pre-write + post-write barrier (`g1BarrierSet.cpp:35-85`)
- 6.3.2 SATB pre-write barrier：并发标记的"起始快照"语义 (`g1BarrierSet.inline.hpp:120-160`)
- 6.3.3 post-write barrier → Card Marking → DirtyCardQueue (`g1BarrierSet.inline.hpp:200-240`)
- 6.3.4 G1CardTable 的 512B/card 布局与 card_shift 计算 (`g1CardTable.hpp:40-70`)
- 6.3.5 DirtyCardQueueSet 的 completed buffer 处理与并发精炼 (`dirtyCardQueue.cpp:30-80`)

#### 生产场景钩子
- 开场故障：8GB 堆但 Humongous 对象连续失败 → 引入 Region 概念
- 开场故障：`-XX:+UseG1GC` 下服务 10s 停顿 → 引入 Barrier 开销

#### 核心问题
- Q1: 一个 `new byte[3MB]` 如何从 TLAB 一路落到 Humongous Region？
- Q2: HeapRegion 的 Free → Eden → Old 状态转换何时发生、由谁驱动？
- Q3: 为什么 G1 需要 SATB barrier，而 Parallel GC 不需要？语义区别在哪？
- Q4: Card Table 的 512 字节/card 粒度是如何计算的？为什么不是 256 或 1KB？

#### 源文件映射
| 核心源文件 | 行数 | 覆盖点 |
|-----------|:---:|--------|
| `src/hotspot/share/gc/g1/heapRegion.hpp/cpp` | ~1200 | Region 9 态状态机、遍历接口 |
| `src/hotspot/share/gc/g1/heapRegionManager.hpp/cpp` | ~550 | commit/uncommit、region 分配 |
| `src/hotspot/share/gc/g1/heapRegionType.hpp/cpp` | ~200 | Region 类型枚举与转换 |
| `src/hotspot/share/gc/g1/heapRegionSet.hpp/cpp` | ~350 | Free List 双链表 |
| `src/hotspot/share/gc/g1/heapRegionRemSet.hpp/cpp` | ~500 | Sparse/Coarse/Fine PRT |
| `src/hotspot/share/gc/g1/g1Allocator.hpp/cpp` | ~350 | 三层 AllocRegion 路由 |
| `src/hotspot/share/gc/g1/g1AllocRegion.hpp/cpp` | ~250 | AllocRegion 填充/重试 |
| `src/hotspot/share/gc/shared/memAllocator.hpp/cpp` | ~200 | TLAB 快速分配入口 |
| `src/hotspot/share/gc/g1/g1BarrierSet.hpp/cpp` | ~400 | pre/post-write barrier |
| `src/hotspot/share/gc/g1/g1CardTable.hpp/cpp` | ~350 | Card 标记与扫描 |
| `src/hotspot/share/gc/g1/dirtyCardQueue.hpp/cpp` | ~300 | 脏卡队列与完成缓冲区 |
| `src/hotspot/share/gc/g1/satbMarkQueue.hpp/cpp` | ~250 | SATB 缓冲区 |

---

### 第7章：G1 Young GC 全流程 — 一次完整 GC 暂停的全链路追踪

> **核心要求**：从触发到结束追踪一次完整的 GC 暂停，覆盖每个阶段的调用链与数据结构交互。

#### 7.1 触发路径
- 7.1.1 分配失败触发 — `mem_allocate()` → Eden 满 → `VM_G1CollectForAllocation` VM 操作 (`g1CollectedHeap.cpp:3335-3355`)
- 7.1.2 三种 GC 原因 — Allocation Failure / GCLocker / Humongous Allocation (`g1CollectedHeap.cpp:1978-1992`)
- 7.1.3 VM 操作机制 — `VM_G1CollectForAllocation::doit()` → `do_collection_pause_at_safepoint()` (`vm_operations_g1.cpp:78-165`)
- 7.1.4 并发标记启动决策 — `decide_on_conc_mark_initiation()` 嵌入 Young GC 逻辑 (`g1Policy.cpp:600-630`)

#### 7.2 Pause 前阶段
- 7.2.1 Safepoint 同步 — `SafepointSynchronize::begin()` 停止所有 Java 线程 (`safepoint.cpp:150-250`)
- 7.2.2 GCLocker 检查 — `check_active_before_gc()` 避免 JNI 临界区死锁 (`gcLocker.cpp:80-120`)
- 7.2.3 Root Region Scanning 等待 — `wait_for_root_region_scanning()` 确保 initial mark 根扫描完成 (`g1CollectedHeap.cpp:3600-3615`)
- 7.2.4 GC 计时/追踪启动 — `GCDrainStackTargetSize`、`_gc_timer_stw`、`GCTraceTime` (`g1CollectedHeap.cpp:3653-3730`)

#### 7.3 Evacuation 核心阶段 ★ 完整调用链
- 7.3.1 `G1ParScanThreadState` — 每个 worker 线程的扫描状态 (oop 队列 + PLAB + age table) (`g1ParScanThreadState.cpp:50-180`)
- 7.3.2 `G1RootProcessor` 扫描根集合 — Java 线程栈 + JNI handles + ClassLoaderData + CodeCache + SystemDictionary (`g1RootProcessor.cpp:80-200`)
- 7.3.3 对象扫描循环 — 从根出发: `G1ScanEvacuatedObjClosure::do_oop` → ptr → 复制到 to-region → 转发指针 → 递归处理字段 (`g1ParScanThreadState.inline.hpp:40-130`)
- 7.3.4 Remembered Set 扫描 — 从卡表定位脏卡 → Per-Region Table → Sparse/Coarse/Fine PRT (`heapRegionRemSet.cpp:180-350`)
- 7.3.5 G1ParScanThreadStateSet 刷新 — flush PLAB + 幸存者年龄表合并 (`g1ParScanThreadState.cpp:260-310`)
- 7.3.6 Redirty Cards — 将 evac 期间的脏卡重新标记 (`g1RemSet.cpp:720-780`)

#### 7.4 引用处理
- 7.4.1 ReferenceProcessor 发现 + 入队 — Soft/Weak/Phantom/Final reference 处理流程 (`referenceProcessor.cpp:450-700`)
- 7.4.2 G1ParCopyClosure 对引用对象的特殊处理 (`g1OopClosures.hpp:80-150`)
- 7.4.3 String Dedup 后处理 — 并发标记阶段收集去重线索 (`g1StringDedup.cpp:50-100`)

#### 7.5 Pause 后阶段
- 7.5.1 Survivor Age Table 更新 — `age_table()->merge_par()` 跨 worker 合并 (`g1CollectedHeap.cpp:3870-3890`)
- 7.5.2 Heap 大小自适应 — `resize_if_necessary_after_full_collection()` (`g1CollectedHeap.cpp:3950-3990`)
- 7.5.3 Concurrent Refinement 唤醒 — 通知精炼线程处理遗留脏卡 (`g1ConcurrentRefine.cpp:120-150`)
- 7.5.4 Concurrent Mark 通知 — 如果 initial mark，通知 `_cm_thread` 开始标记 (`g1CollectedHeap.cpp:3995-4015`)
- 7.5.5 JFR/JMX 事件发送 — `GCTraceTime` 析构触发事件 (`gcTraceTime.inline.hpp:45-60`)
- 7.5.6 Safepoint 结束 — `SafepointSynchronize::end()` 唤醒所有 Java 线程

#### 完整调用链 Mermaid 概要（文档中将详细展开）
```
VM_G1CollectForAllocation::doit()
  ├─ attempt_allocation_at_safepoint()——尝试对象分配
  └─ do_collection_pause_at_safepoint()——Young GC 核心
      ├─ GCLocker::check_active_before_gc()
      ├─ wait_for_root_region_scanning()
      ├─ decide_on_conc_mark_initiation()——判断是否 Initial Mark
      └─ [Pause Body]
          ├─ G1RootProcessor::evacuate_roots()——根扫描
          │   ├─ JavaThread::oops_do()
          │   ├─ JNIHandles::oops_do()
          │   ├─ CodeCache::blobs_do()
          │   └─ SystemDictionary::oops_do()
          ├─ G1ParScanThreadState::trim_queue()——迭代扫描/复制
          │   ├─ do_oop() → ptr → copy_to_survivor_region()
          │   ├─ forwardee 安装 ← CAS
          │   └─ push 引用字段到 work queue
          ├─ G1EvacuateRegionsTask——并行任务调度
          │   └─ G1ParScanThreadStateSet::flush()
          ├─ ReferenceProcessor::process_discovered_references()
          ├─ G1CMRefProcTaskExecutor——并发标记时的引用处理
          └─ [Post-evac]
              ├─ redirty_logged_cards()
              ├─ evac_failure_processing()
              ├─ preserve_cm_referents()
              └─ G1Policy::record_young_collection_end()
```

#### 生产场景钩子
- 开场故障：线上服务每次 Young GC 120ms（期望 <30ms）→ GDB 附加发现 8000+ dirty cards + Humongous 疏散失败
- 开场故障：Mixed GC 后 Old Gen 未下降 → CollectionSet 选错 Region

#### 核心问题
- Q1: Young GC 过程中是 STW (Stop-The-World) 还是部分并发？哪些阶段在 safepoint 内？
- Q2: 疏散 (evacuation) 过程中，对象被复制到新 Region，原始指针如何变成正确的新地址？
- Q3: Remembered Set 扫描相对于全堆扫描能减少多少工作量？什么情况下 RemSet 会膨胀？
- Q4: 如果 Young GC 中 Eden 满了但 Survivor 也满了，对象直接晋升到 Old 的条件是什么？
- Q5: Young GC 中发生了两次 safepoint（initial mark 和 remark）吗？还是只有一次？
- Q6: Humongous 对象在 Young GC 中被处理吗？如果能被 reclaim 需要什么前置条件？

#### 源文件映射
| 核心源文件 | 行数 | 覆盖点 |
|-----------|:---:|--------|
| `g1CollectedHeap.cpp:3335-4020` | ~700 | do_collection_pause + _at_safepoint 完整函数 |
| `vm_operations_g1.cpp:78-165` | ~90 | VM_G1CollectForAllocation::doit() |
| `g1RootProcessor.hpp/cpp` | ~450 | 根集合扫描 |
| `g1ParScanThreadState.hpp/cpp/inline` | ~500 | Worker 线程扫描状态机 |
| `g1RemSet.hpp/cpp` | ~1210 | Remembered Set 扫描 |
| `heapRegionRemSet.hpp/cpp` | ~500 | 单 region PRT |
| `g1OopClosures.hpp/cpp/inline` | ~400 | Evacuation 闭包链 |
| `referenceProcessor.hpp/cpp` | ~1800 | 引用发现与处理 |
| `g1EvacFailure.hpp/cpp` | ~263 | 疏散失败恢复 |
| `g1Policy.cpp:600-900` | ~300 | Pause 后 policy 更新 |

---

### 第8章：G1 并发标记 — SATB 快照与三色抽象

#### 8.1 并发标记的理论基础
- 8.1.1 三色标记抽象 — White (未标记) / Grey (已标记但未扫描) / Black (已标记+已扫描) (`g1ConcurrentMark.hpp:280-310`)
- 8.1.2 SATB (Snapshot-At-The-Beginning) 语义 — 标记开始时逻辑快照，mutator 修改通过 pre-write barrier 记录 (`satbMarkQueue.cpp:35-80`)
- 8.1.3 增量更新 (Incremental Update) vs SATB — G1 为什么选择 SATB 而非 CMS 的增量更新？(`g1ConcurrentMark.cpp:1-30` 注释)
- 8.1.4 浮垃圾 (Floating Garbage) 容忍 — SATB 的优点和代价

#### 8.2 标记生命周期（继承 09 篇初始化，深入运行时）
- 8.2.1 Initial Mark — 嵌入 Young GC pause，扫描 GC roots + survivor regions (`g1ConcurrentMark.cpp:680-720`)
- 8.2.2 Root Region Scanning — 并发扫描 survivor 区域 (`g1ConcurrentMark.cpp:730-800`)
- 8.2.3 Concurrent Marking — `G1CMTask::work()` 迭代 steal + scan + mark + drain SATB (`g1ConcurrentMark.cpp:2400-2700`)
- 8.2.4 Remark — 最终 STW pause，drain 所有 SATB buffers + 参考处理 (`g1ConcurrentMark.cpp:3300-3450`)
- 8.2.5 Cleanup — 计算 Region 活跃度，回收全空 region，准备 Mixed GC CSet (`g1ConcurrentMark.cpp:2850-3100`)
- 8.2.6 标记中止 (Abort) 与 Recovery — concurrent marking 可中断，所有 SATB buffer 数据保留 (`g1ConcurrentMark.cpp:1620-1680`)

#### 8.3 双缓冲标记位图
- 8.3.1 `_prevMarkBitMap` vs `_nextMarkBitMap` — "上一轮结果"vs"本轮结果"的切换机制 (`g1ConcurrentMarkBitMap.cpp:50-100`)
- 8.3.2 位图 mmap 布局 — `G1CMBitMapMappingChangedListener` 监听 heap 扩展/收缩 (`g1CollectedHeap.hpp:207`)
- 8.3.3 CMBitMapClosure 遍历 — 迭代 region 内所有标记对象 (`g1ConcurrentMarkBitMap.inline.hpp:50-90`)

#### 8.4 CMTask 并行标记
- 8.4.1 13 个 CMTask 的 steal-based 工作调度 — `G1CMTaskQueueSet` + `ParallelTaskTerminator` (`g1ConcurrentMark.cpp:2500-2600`)
- 8.4.2 `G1CMTask::drain_satb_buffers()` — 标记过程中处理 mutator 写入的 SATB 条目 (`g1ConcurrentMark.cpp:2150-2250`)
- 8.4.3 `G1CMTask::deal_with_reference()` — 引用对象的特殊标记处理 (`g1ConcurrentMark.cpp:1900-2000`)
- 8.4.4 `G1CMObjArrayProcessor` — 对象数组的分段处理避免溢出 (`g1ConcurrentMarkObjArrayProcessor.cpp:40-120`)
- 8.4.5 RegionMarkStats 缓存 — 减少跨 worker 的活跃度统计竞争 (`g1RegionMarkStatsCache.inline.hpp:35-70`)

#### 8.5 标记完成后的操作
- 8.5.1 `G1RegionMarkStats` 汇总 → Region 活跃度（高/中/低活）(`g1RegionMarkStatsCache.cpp`)
- 8.5.2 `RebuildRSSet` — 重建 Remembered Set 为 Mixed GC 准备 (`g1ConcurrentMark.cpp:3060-3200`)
- 8.5.3 Humongous 对象的 eager reclaim — 并发标记阶段回收无引用的 Humongous 区域 (`g1CollectedHeap.cpp:1800-1900`)
- 8.5.4 `CollectionSetChooser::rebuild()` — 按回收收益排序 Old Region (`collectionSetChooser.cpp:40-120`)
- 8.5.5 `G1StringDedup` — 并发标记期间识别重复字符串 (`g1StringDedup.cpp:100-200`)

#### 并发标记并发图
```
Mutator Threads (Java):
  ├─ new Object() → TLAB 分配
  ├─ obj.field = newVal → SATB pre-write: 记录 old value → SATB buffer
  └─ obj.field = null  → SATB pre-write: 记录 old value

Concurrent Mark Thread:
  ┌─── Initial Mark (STW) ───→ Root Region Scan ───→ Concurrent Mark ──┐
  │  扫描 roots + survivor     扫描 survivor     CMTask×13 并行       │
  │                              (并发)          + drain SATB          │
  └── Remark (STW) ←────────────────────────────────────────────────┘
            └──→ Cleanup (STW) → Mixed GCs...

SATB Buffer Flow:
  Mutator thread:  pre-write → SATB buffer → 满 → 全局 completed list
  CM thread:       drain global completed list → mark → grey
```

#### 生产场景钩子
- 开场故障：标记时间 1.2s 但 allocation 持续 > mark rate → 并发标记失败 (concurrent mode failure) → Full GC
- 开场故障：大量 String 对象导致标记阶段 SATB buffer overflow → 退化为串行处理

#### 核心问题
- Q1: 为什么 G1 用 SATB 而 CMS 用 Incremental Update？在设计上有什么区别？
- Q2: 初始标记 (Initial Mark) 为什么嵌入 Young GC？独立的利弊是什么？
- Q3: Remark 阶段必须 pause 的原因是什么？哪些工作不能在并发阶段完成？
- Q4: Cleanup 阶段回收全空 region 是 STW 的吗？代价有多大？
- Q5: Concurrent Mark 过程中如果 allocation rate > mark rate，会发生什么？
- Q6: SATB buffer 为什么要每线程一个？全局 buffer 有什么问题？

#### 源文件映射
| 核心源文件 | 行数 | 覆盖点 |
|-----------|:---:|--------|
| `g1ConcurrentMark.cpp` | 3322 | 标记生命周期+CMTask+Cleanup |
| `g1ConcurrentMarkThread.cpp` | 449 | 标记线程运行循环 |
| `g1ConcurrentMarkBitMap.hpp/cpp/inline` | ~350 | 双缓冲位图 |
| `g1ConcurrentMarkObjArrayProcessor.hpp/cpp` | ~120 | 大数组分段处理 |
| `satbMarkQueue.hpp/cpp` | ~250 | SATB 队列 |
| `g1RegionMarkStatsCache.hpp/cpp/inline` | ~150 | Region 统计缓存 |
| `collectionSetChooser.hpp/cpp` | ~200 | CSet 选择器 |
| `g1StringDedup.hpp/cpp` | ~350 | 字符串去重 |
| `g1ConcurrentRefine.hpp/cpp` | ~350 | 并发精炼 |
| `g1ConcurrentRefineThread.hpp/cpp` | ~150 | 精炼线程 |

---

### 第9章：G1 Mixed GC 与策略引擎 — 自适应循环控制

#### 9.1 Policy 决策循环（继承 08 篇，深入运行时决策）
- 9.1.1 `G1Policy::record_young_collection_end()` — Young GC 后更新所有预测模型 (`g1Policy.cpp:620-700`)
- 9.1.2 `G1Policy::record_concurrent_mark_cleanup_end()` — 标记清理后计算 Mixed GC 次数 (`g1Policy.cpp:850-920`)
- 9.1.3 `G1Policy::next_gc_should_be_mixed()` — Mixed GC 触发决策 (`g1Policy.cpp:930-980`)
- 9.1.4 `G1Policy::calculate_young_list_target_length()` — 年轻代大小动态计算 (`g1Policy.cpp:720-780`)

#### 9.2 Collection Set 选择
- 9.2.1 `CollectionSetChooser::sort_regions_by_reclaimable_bytes()` — 按回收收益排序 Old Region (`collectionSetChooser.cpp:120-180`)
- 9.2.2 `G1Policy::finalize_collection_set()` — 在预估暂停时间内选最优 CSet (`g1Policy.cpp:1020-1100`)
- 9.2.3 CSet 的 reclaimable_percent 阈值 — 什么样的 Region 值得回收？(`collectionSetChooser.cpp:80-120`)
- 9.2.4 `G1CollectionSet::add_old_region()` — Old Region 入 CSet 条件检查 (`g1CollectionSet.cpp:60-100`)
- 9.2.5 `G1CollectorState` 状态机 — Young Only → Mixed → Young Only 阶段切换 (`g1CollectorState.hpp:50-90`)

#### 9.3 Mixed GC 执行
- 9.3.1 Mixed GC 与 Young GC 的异同 — 共享 `do_collection_pause_at_safepoint`，区别在 CSet 含 Old Region
- 9.3.2 Old Region 的疏散复杂度 — 更多 RemSet 条目、更多跨 region 引用 (`g1ParScanThreadState.cpp:120-180`)
- 9.3.3 Mixed GC 的终止条件 — `G1Policy::should_continue_mixed_GC_set()` → 达到期望的 reclaim bytes 或 pause time 预测超限
- 9.3.4 `G1InitialMarkToMixedTimeTracker` — 从 Initial Mark 到 Mixed GC 的时间追踪 (`g1InitialMarkToMixedTimeTracker.hpp`)
- 9.3.5 Concurrent Refinement 在 Mixed GC 中的角色 — 预清理脏卡减少暂停 (`g1ConcurrentRefine.cpp:180-230`)

#### 9.4 堆大小自适应
- 9.4.1 `G1HeapSizingPolicy::resize()` — 基于 GC 统计的堆扩/缩容 (`g1HeapSizingPolicy.cpp:30-100`)
- 9.4.2 IHOP (Initiating Heap Occupancy Percent) 自适应 — 静态 vs 自适应 IHOP 的运行时行为 (`g1IHOPControl.cpp:50-150`)
- 9.4.3 `G1Analytics::compute_pause_time_ratio()` — 暂停时间占比预测 (`g1Analytics.cpp:80-150`)
- 9.4.4 `G1Analytics::predict_young_other_time_ms()` — 用衰减平均预测各阶段耗时 (`g1Analytics.cpp:200-280`)

#### 9.5 Evacuation Failure 处理
- 9.5.1 疏散失败的原因 — PLAB resize 不够快、碎片化、并发分配抢占 to-space (`g1EvacFailure.cpp:40-100`)
- 9.5.2 `RemoveSelfForwardPtrObjClosure` — 失败后恢复原始对象指针 (`g1EvacFailure.cpp:110-160`)
- 9.5.3 `EvacuationFailedInfo` 记录 — 失败 Region 计数和总量 (`evacuationInfo.hpp:35-60`)
- 9.5.4 疏散失败时的 remembered set 维护 (`g1RemSet.cpp:650-720`)

#### 生产场景钩子
- 开场故障：服务 Old Gen 持续增长 → Mixed GC 无法回收足够的空间 → 最终 Full GC → 100ms+ 停顿
- 开场故障：自适应 IHOP 过激进导致频繁并发标记 → CPU 20% 被 GC 吃掉

#### 核心问题
- Q1: G1Policy 如何决定"这次是 Young GC 还是 Mixed GC"？决策树的输入因子有哪些？
- Q2: CollectionSet 选择算法如何平衡"暂停时间"和"回收量"？排序依据是什么？
- Q3: 多少轮 Mixed GC 才足够？什么情况下 Mixed GC 会在回收完毕之前就结束？
- Q4: 疏散失败的恢复机制如何在保证对象不丢失的前提下保留 GC 进度？
- Q5: IHOP 的自适应公式是如何工作的？初始值 -XX:InitiatingHeapOccupancyPercent=45 的依据是什么？
- Q6: MMUTracker 的 64 元素环形队列如何影响 pause 预测？与 IHOP 如何配合？

#### 源文件映射
| 核心源文件 | 行数 | 覆盖点 |
|-----------|:---:|--------|
| `g1Policy.hpp/cpp` | 1324 | 决策引擎核心 |
| `g1Analytics.hpp/cpp` | ~500 | 预测模型 |
| `g1IHOPControl.hpp/cpp` | ~300 | IHOP 自适应 |
| `g1CollectorState.hpp` | ~100 | 阶段状态机 |
| `collectionSetChooser.hpp/cpp` | ~200 | CSet 排序/选择 |
| `g1CollectionSet.hpp/cpp` | ~250 | CSet 管理 |
| `g1HeapSizingPolicy.hpp/cpp` | ~200 | 堆大小自适应 |
| `g1MMUTracker.hpp/cpp` | ~200 | 暂停时间追踪 |
| `g1InitialMarkToMixedTimeTracker.hpp` | ~60 | 时间追踪器 |
| `g1EvacFailure.hpp/cpp` | ~263 | 疏散失败恢复 |
| `evacuationInfo.hpp` | ~80 | 疏散统计 |

---

### 第10章：G1 Full GC — Last Resort 的标记-清除-压缩

#### 10.1 Full GC 触发条件
- 10.1.1 并发标记失败 (Concurrent Mode Failure) — allocation rate > mark rate (`g1CollectedHeap.cpp:1978-1992`)
- 10.1.2 疏散失败升级 — 多次 Young/Mixed GC 无法满足分配 (`g1CollectedHeap.cpp:2880-2900`)
- 10.1.3 System.gc() 显式触发 — `JVM_GC` → `G1CollectedHeap::collect(GCCause::_java_lang_system_gc)` (`g1CollectedHeap.cpp:2900-2920`)
- 10.1.4 Metadata GC 阈值触发 — Metaspace 空间不足 (`g1CollectedHeap.cpp:1995-2010`)
- 10.1.5 `VM_G1CollectFull` VM 操作 — 与 Young GC 不同的 VM 操作路径 (`vm_operations_g1.cpp:37-76`)

#### 10.2 Full GC 四阶段
- 10.2.1 Phase 1: Mark — `G1FullGCMarkTask` 并行标记所有可达对象 (`g1FullGCMarkTask.cpp:35-80`)
- 10.2.2 Phase 2: Prepare for Compaction — `G1FullGCPrepareTask` 计算每个 region 的 compaction target (`g1FullGCPrepareTask.cpp:40-100`)
- 10.2.3 Phase 3: Adjust Pointers — `G1FullGCAdjustTask` 更新所有指向移动对象的指针 (`g1FullGCAdjustTask.cpp:35-80`)
- 10.2.4 Phase 4: Compact — `G1FullGCCompactTask` 将对象移动到新位置 (`g1FullGCCompactTask.cpp:35-90`)
- 10.2.5 `G1FullGCCompactionPoint` — 每个 region 的压缩目标点 (`g1FullGCCompactionPoint.cpp:35-70`)
- 10.2.6 `G1FullGCReferenceProcessorExecutor` — Full GC 中的引用处理 (`g1FullGCReferenceProcessorExecutor.cpp`)

#### 10.3 Full GC 的数据结构
- 10.3.1 `G1FullGCScope` — Full GC 的 timer/tracer/scope 管理 (`g1FullGCScope.cpp:30-60`)
- 10.3.2 `G1FullGCMarker` — 标记栈与闭包 (`g1FullGCMarker.cpp:35-70`)
- 10.3.3 `G1FullGCOopClosures` — 标记/调整/压缩三种闭包 (`g1FullGCOopClosures.hpp`)
- 10.3.4 Humongous 对象在 Full GC 中的处理 — 不移动，但可能被回收

#### 10.4 Full GC 的代价与优化
- 10.4.1 Full GC 时间分解 — Mark (~30%) + Prepare (~10%) + Adjust (~25%) + Compact (~35%) 的典型分布
- 10.4.2 `TearDownRegionSets` / `RebuildRegionSets` — Full GC 前后的 Region 集合重建 (`g1CollectedHeap.cpp:1960-2010`)
- 10.4.3 Full GC 后的 heap resize — 比 Mixed GC 更激进的收缩

#### 生产场景钩子
- 开场故障：大量 Full GC (每秒 1 次) → GDB 发现 Concurrent Mode Failure → 根因是 IHOP 过高致标记永远追不上分配
- 开场故障：Full GC 后 JVM 堆不释放给 OS → `-XX:-ShrinkHeapInSteps` 的效果

#### 核心问题
- Q1: G1 Full GC 是并行还是串行的？多少线程参与？每个阶段可以并行吗？
- Q2: 为什么 G1 Full GC 压缩对象而 Young/Mixed GC 只复制？压缩和复制的实现区别？
- Q3: Full GC 期间 Humongous 对象若可达，会被移动吗？
- Q4: Concurrent Mode Failure 和 Allocation Failure 的区别是什么？为什么前者要 Full GC？
- Q5: Full GC 和 Serial/Parallel GC 的 "Full GC" 在外观上一样吗？有什么区别？

#### 源文件映射
| 核心源文件 | 行数 | 覆盖点 |
|-----------|:---:|--------|
| `g1FullCollector.cpp` | 335 | Full GC 流程编排 |
| `g1FullGCMarker.hpp/cpp/inline` | ~150 | 标记器 |
| `g1FullGCMarkTask.hpp/cpp` | ~80 | 标记任务 |
| `g1FullGCPrepareTask.hpp/cpp` | ~80 | 压缩准备 |
| `g1FullGCAdjustTask.hpp/cpp` | ~80 | 指针调整 |
| `g1FullGCCompactTask.hpp/cpp` | ~80 | 对象移动 |
| `g1FullGCCompactionPoint.hpp/cpp` | ~100 | 压缩点 |
| `g1FullGCOopClosures.hpp/cpp/inline` | ~120 | 闭包集合 |
| `g1FullGCScope.hpp/cpp` | ~60 | Timer/Tracer |
| `g1FullGCReferenceProcessorExecutor.hpp/cpp` | ~100 | 引用处理 |
| `g1FullGCTask.hpp/cpp` | ~50 | 任务基类 |
| `vm_operations_g1.cpp:37-76` | ~40 | VM_G1CollectFull |
| `g1CollectedHeap.cpp:2840-2930` | ~90 | do_full_collection() |

---

### 第11章：多 GC 横向对比 — 为你的工作负载选择正确的收集器

#### 11.1 对比维度表

| 维度 | Serial | Parallel | CMS | G1 | ZGC | Shenandoah | Epsilon |
|------|--------|----------|-----|----|----|------------|---------|
| **暂停时间** | 10-100ms (线性随堆增) | 10-100ms (线性随堆增) | 10-50ms (Young) 200ms+ (Full) | <100ms (Young) + Full GC 0-100ms | <1ms (avg) <10ms (max) | <10ms (avg) <50ms (max) | 0 (无 GC) |
| **最大堆** | <1GB | <4GB | <16GB | <64TB | <16TB | <16TB | 任意 (无限制) |
| **吞吐量** | 最低 (单线程) | **最高** (STW 全并行) | 高 (并发 minor) | 高 (~90%) | 中高 (~85-92%) | 中高 (~90%) | **理论最高** (无 GC) |
| **并发阶段** | 无 | 无 | 并发标记 + 并发清除 | 并发标记 + 并发精炼 | 几乎全并发 | 几乎全并发 | 无 |
| **内存开销** | 最低 | 低 (无 RB) | 中 (CardTable) | 中高 (RSet 5-15%) | 高 (Colored pointers 6%) | 中高 (Brooks ptr 4%) | 最低 |
| **CPU 开销** | 1 核 | 多核 (STW 100%) | 2+ 核 (1 CMS + 1-4 bg) | 4+ 核 (CM + Refine + Workers) | 6+ 核 (多个并发线程) | 4+ 核 (多个并发) | 0 |
| **碎片化** | 高 (无压缩) | 低 (全压缩) | 高 (无压缩 Old) | 低 (Region 压缩) | 极低 (单代) | 极低 (单代) | N/A (不回收) |
| **推荐场景** | 单核/小内存 (<512MB) 桌面应用 | 批处理/ETL (吞吐 > 延迟) | (已 deprecated, 不推荐) | **默认**，通用服务器 | **超低延迟** (<1ms)，大堆 | 超低延迟，大堆 | 基准/短命测试 |
| **Java 版本** (源文件行数参考) | 所有版本 (3.4K行) | 所有版本 (24K行) | JDK 14- (22K行) ⚠️ 已移除 | JDK 7+ (65K行) ⭐ 默认 | JDK 11+ (20K行) | JDK 12+ (23K行) | JDK 11+ (1.3K行) |

#### 11.2 GC 算法分类

| 类别 | 收集器 | 算法 | 特点 |
|------|--------|------|------|
| 串行 Stop-The-World | Serial | Mark-Sweep-Compact (Old) + Copy (Young) | 单线程，暂停期间无并发操作 |
| 并行 Stop-The-World | Parallel | Mark-Sweep-Compact (Old) + Copy (Young) | 多线程 STW，追求吞吐量 |
| 并发标记 + STW 压缩 | CMS | Concurrent Mark + Concurrent Sweep (Old) | 旧低延迟方案，碎片化问题严重 |
| 并发标记 + STW 疏散 | G1 | SATB + Region-based Evacuation | 暂停时间可控，自适应，**现代默认** |
| 全并发 | ZGC | Load Barrier + Colored Pointers + Multi-mapping | 暂停 <1ms，堆 ≤16TB |
| 全并发 | Shenandoah | Brooks Pointers + Forwarding + Concurrent Compaction | 暂停 <10ms，堆 ≤16TB |
| 无操作 | Epsilon | 仅分配，不回收 | 基准测试/性能极限 |

#### 11.3 G1 vs 其他 GC 的深度对比

##### 11.3.1 G1 vs Parallel — 吞吐 vs 延迟
- 新生代对比：G1 Eden/Survivor 动态 vs Parallel 固定 Eden/Survivor — 为什么 G1 可以更灵活？
- 老年代对比：G1 Mixed GC (增量) vs Parallel Full GC (一次性) — 停顿时间分布的差异
- RemSet vs CardTable：G1 的 Sparse/Coarse/Fine PRT 比 Parallel 的 CardTableRS 多一层 indirection，成本在哪里？
- 推荐转换条件：堆 >4GB 且需要 <200ms 暂停 → Parallel → G1

##### 11.3.2 G1 vs CMS — 为什么 CMS 被弃用
- 碎片化核心差异：CMS 的 free list 分配 vs G1 的 region compaction
- Concurrent Mode Failure vs Mixed GC：CMS 遇到 CMF → 退化为单线程 Serial Old，G1 → 退化为并行 Full GC
- Floating Garbage 容忍：CMS 必须预留 free space 防止 promotion failure，G1 通过 PLAB + evacuation reserve
- Remark 对比：CMS remark 需 STW 重新扫描 mod-union table + 所有 root，G1 remark 只 drain SATB

##### 11.3.3 G1 vs ZGC/Shenandoah — 全并发 GC 的进化
- Barrier 开销：G1 的 SATB + Card Table (2 barriers) vs ZGC 的 Load Barrier (1 barrier, colored pointer) vs Shenandoah 的 Brooks Read Barrier
- 暂停时间构成：G1 暂停需要扫描 RemSet + 疏散 → ~30ms；ZGC 暂停仅 root scan → <0.1ms
- 吞吐量折损：全并发 GC 的 CPU 开销 (6-15% vs G1 的 5-10%)
- 推荐转换条件：延迟需求 <10ms 且能接受 5-10% 额外吞吐量折损 → G1 → ZGC/Shenandoah

#### 11.4 通用 GC 原语对比

##### 11.4.1 Barrier Set 实现对比
| GC | Barrier 类型 | 数量 | 关键实现 |
|----|-------------|------|---------|
| Serial | CardTable post-write | 1 | cardTableBarrierSet.cpp |
| Parallel | CardTable post-write | 1 | cardTableBarrierSet.cpp |
| CMS | String Dedup + CardTable | 1 | cardTableBarrierSet.cpp |
| **G1** | **SATB pre-write + CardTable post-write** | **2** | **g1BarrierSet.cpp** |
| ZGC | **Load Barrier** (colored pointer) | **1** | zBarrierSet.cpp |
| Shenandoah | **Brooks Read Barrier** (indirection ptr) | **1** | shenandoahBarrierSet.cpp |

##### 11.4.2 TLAB/PLAB 对比
- 所有 GC 共享 TLAB 快速路径：`ThreadLocalAllocBuffer::allocate()` (`threadLocalAllocBuffer.inline.hpp`)
- G1 特有 PLAB：`G1PLAB` 继承 `PLAB`，增加 age table + direct allocation 统计
- ZGC/Shenandoah 无分代 → 只有 TLAB，无 PLAB

##### 11.4.3 Reference Processing 对比
- 所有 GC 共享 ReferenceProcessor：`referenceProcessor.cpp` (~1800行)
- 不同 GC 在 `process_discovered_references()` 中的差异
- G1 特有：`G1CMRefProcTaskExecutor` — 并发标记中引用处理的并行执行器

#### 11.5 工作负载决策树

```
                     开始
                      │
            延迟要求 <1ms? ──── 是 ──→ ZGC (大堆/FAST) 或 ZGC Generational (JDK 21+)
                      │
                     否
                      │
            延迟要求 <10ms? ── 是 ──→ Shenandoah (大堆) 或 G1+低暂停目标
                      │
                     否
                      │
            堆 ≥4GB? ── 是 ──→ G1 (默认，现代最佳)
                      │
                     否
                      │
            吞吐量优先? ── 是 ──→ Parallel (批处理/ETL)
                      │
                     否
                      │
            单核/小内存? ── 是 ──→ Serial (<512MB 桌面/嵌入式)
                      │
                     否
                      │
            基准/无回收需求? ── 是 ──→ Epsilon
```

#### 核心问题
- Q1: G1 的 SATB pre-write barrier 是一个 store + 一次 conditional enqueue，ZGC 的 load barrier 是 colored pointer 检查。从 CPU 角度看，哪个更贵？
- Q2: Parallel GC 的 Full GC 可以在 200ms 内回收 4GB，G1 为什么不一次性做而选择多次 Mixed GC？
- Q3: CMS 的 floating garbage 和 G1 的 floating garbage 有什么区别？分别从哪里产生？
- Q4: 如果从 Parallel 切换到 G1，-XX 参数有哪些需要调整？哪些可以沿用？
- Q5: ZGC 的 colored pointers 占用 64-bit 指针中的 4 位（16TB 堆），在 46-bit 物理地址架构下够用吗？
- Q6: Shenandoah 的 Brooks pointer 为什么比 ZGC 的 colored pointer 更"重"？多出来的 memory dereference 有多大代价？

#### 源文件映射（各 GC 代表性文件）
| GC | 关键文件 | 行数 | 定位 |
|----|---------|:---:|------|
| **G1 (基准)** | g1CollectedHeap + g1Policy + g1ConcurrentMark | ~10K | `gc/g1/` |
| **Parallel** | parallelScavengeHeap + psMarkSweep + psParallelCompact | ~5K | `gc/parallel/` |
| **CMS** | concurrentMarkSweepGeneration + parNewGeneration | ~6K | `gc/cms/` |
| **ZGC** | zHeap + zDriver + zRelocate + zMark | ~5K | `gc/z/` |
| **Shenandoah** | shenandoahHeap + shenandoahConcurrentMark + shenandoahHeuristics | ~5K | `gc/shenandoah/` |
| **Serial** | serialHeap + defNewGeneration + tenuredGeneration | ~2K | `gc/serial/` |
| **Shared** | referenceProcessor + collectedHeap + barrierSet | ~3K | `gc/shared/` |

---

## 三、文档编写策略与顺序

### 3.1 依赖关系

```
第6章 (堆运行时) ──────────────────────────────────────────┐
    │                                                        │
    ├──→ 第7章 (Young GC) ──→ 第8章 (并发标记) ──→ 第9章 (Mixed GC + 策略)
    │                              │                        │
    └──────────────────────────→ 第10章 (Full GC) ←─────────┘
                                                              │
    第11章 (多 GC 对比) ←── 需要前 5 章全部完成 ─────────────┘
```

### 3.2 编写优先级

| 优先级 | 章节 | 理由 |
|--------|------|------|
| P0 | 第7章 Young GC | 最核心的数据流，全部其他章节的基础 |
| P0 | 第8章 并发标记 | 继承 09 篇初始化内容，自然延伸 |
| P1 | 第6章 堆运行时 | 提供对象分配和数据结构基础 |
| P1 | 第10章 Full GC | 单独相对独立，但需 Young GC 基础 |
| P2 | 第9章 Mixed GC | 依赖 Young GC + 并发标记的知识 |
| P3 | 第11章 多 GC 对比 | 需要前 5 章全部完成后的全景视角 |

### 3.3 与已有文档的衔接

| 新章节 | 已有资产 | 衔接策略 |
|--------|---------|---------|
| 第6章 堆运行时 | 02-G1-Heap-Startup (1403行) | **不重复**构造函数初始化，从运行时状态机视角展开，补充 Region 回收、TLAB、Free List、Barrier |
| 第7章 Young GC | 02 (堆结构) + 08 (Policy 初始化) | 02 提供堆结构基础，08 提供 Pause 预测模型初始化，第7章聚焦暂停运行时 |
| 第8章 并发标记 | 09-G1-CM-Infra (720行) | **不重复**构造函数和线程创建，从 Initial Mark → Cleanup 全生命周期展开 |
| 第9章 Mixed GC | 08-G1-Policy-Analytics (1403行) | **不重复**8 个子组件初始化，聚焦运行时决策循环 + CSet 选择算法 |
| 第10章 Full GC | 无 (G1 Full GC 完全未覆盖) | 全新内容，从触发到 4 阶段完整覆盖 |
| 第11章 多 GC 对比 | 无专项对比，各 GC 源码需新读 | 全新内容，需阅读 Parallel/CMS/ZGC/Shenandoah/Serial 源码 |

### 3.4 每章的质量目标

| 指标 | 目标 |
|------|------|
| 每章行数 | 3000-5000 行 (第11章可达 6000+) |
| 总行数 | ~25,000-30,000 行 |
| 核心源码覆盖 | ≥80% 的核心函数有 file:line 引用 |
| Mermaid 图 | 每章 ≥5 个序列图/状态图/架构图 |
| 生产场景 | 每章 ≥2 个真实故障场景 (strace/jstack/GDB/proc 验证) |
| 诊断工具五件套 | 每章覆盖：strace + jcmd + jstack + GDB + /proc 各至少 1 处 |

---

## 四、已有文档的复用清单

### 可直接引用的现有内容（不重复分析）

| 现有文档 | 复用内容 | 新章引用方式 |
|---------|---------|------------|
| **02-G1-Heap-Startup (1403行)** | G1CollectedHeap 39 成员初始化、6 个 Mapper、CardTable 布局、mmap reserve/commit、JMX Pool 注册 | 第6章引用：已有的数据结构布局作为"已知"，展开运行时行为 |
| **08-G1-Policy-Analytics (1403行)** | G1Policy 构造函数与 8 子组件初始化、Analytics 17 个 TruncatedSeq、IHOP 控制、MMUTracker 环形队列、GCPhaseTimes 28 Phase、SurvRateGroup | 第9章引用：已有的预测模型初始化作为"已知"，展开运行时决策 |
| **09-G1-Concurrent-Marking-Infra (720行)** | G1ConcurrentMark 构造函数、双缓冲位图布局、MarkStack chunk 链表、CMTaskQueueSet ×13、ParallelTaskTerminator、ConcurrentRefine 初始化、YoungRemSetSamplingThread | 第8章引用：已有的基础设施作为"已知状态"，展开标记生命周期 |

### 需要完整展开的未覆盖领域

| 领域 | 现有覆盖度 | 第2卷目标 |
|------|----------|----------|
| G1 Young GC 全流程 | 10% (02/08 都只触及初始化) | **100%** (第7章) — 最大增量 |
| G1 并发标记运行时 | 30% (09 只覆盖基础设施) | **90%** (第8章) |
| G1 Mixed GC | 20% (CollectionSet 类存在但未分析) | **90%** (第9章) |
| G1 Full GC | **0%** | **100%** (第10章) — 全空白 |
| G1 Evacuation Failure | **5%** (08 提到 region 计数) | **90%** (第9章嵌套) |
| 多 GC 对比 | **0%** | **100%** (第11章) — 全空白 |
| 对象分配完整路径 | 40% (TLAB 初始化) | **90%** (第6章) |
| Barrier Set 完整语义 | 30% (构造函数) | **90%** (第6章) |

---

## 五、后续 Phase 映射

本卷完成后，将建立以下 Phase 供后续实施：

| 后续 Phase | 对应的 Vol-2 章节 | 文档数估计 | 优先级 |
|------------|-----------------|----------|--------|
| Phase 30-gc-heap-runtime | 第6章 堆运行时 | 2-3 篇 (TLAB+Barrier/Region+FreeList) | P1 |
| Phase 31-gc-young | 第7章 Young GC | 3-4 篇 (触发+Evac/Ref/PostPause) | P0 |
| Phase 32-gc-conc-mark | 第8章 并发标记 | 3-4 篇 (SATB语义/标记生命周期/Cleanup) | P0 |
| Phase 33-gc-mixed-policy | 第9章 Mixed GC | 3 篇 (Decision+Cycle/CSet/EvacFailure) | P2 |
| Phase 34-gc-full | 第10章 Full GC | 2 篇 (Trigger/4Phases) | P1 |
| Phase 35-gc-comparison | 第11章 多 GC 对比 | 3-4 篇 (维度表/G1vsParallel+G1vsCMS/G1vsZ+Shen) | P3 |

---

## 六、与第1卷的衔接

第1卷（01-jvm-startup）覆盖了 JVM 从 `JNI_CreateJavaVM` 到 `return JNI_OK` 的全部 78 个初始化步骤，其中包括：
- `universe_init() #9`: G1CollectedHeap 构造 + mmap reserve/commit
- `referenceProcessor_init() #20`: ReferenceProcessor 初始化
- `universe_post_init() #28`: 预分配 OOM 对象

第2卷以上述初始化终点为**已知状态**，从"堆已经创建好了"的视角展开运行时行为。每章开头明确标注："承接第1卷 §一.1.1 G1CollectedHeap 构造函数，本文聚焦 \_\_\_ 的运行时行为"。
