# PROMPT: 请撰写 08-G1-Policy-Analytics.md

## ⚠️ 关键：本 prompt 是导航地图，不是预制答案。你必须亲自读源码。

- 本 prompt 的 §四 答案方向是"指引"——告诉你去源码里找什么、从哪个角度分析。不能把"答案方向"直接抄到文档里。
- **你必须用 codegraph_explore 或 Read 工具逐个读取 §三 列出的每一个源文件**（至少读核心段落），基于自己的源码理解来写文档。
- 源码是证据（20%），你基于源码的分析洞察是正文（80%）。prompt 告诉你去找什么，不替你写答案。

## §〇 Production Scenario

```
$ java -Xms8g -Xmx8g -XX:+UseG1GC \
    -XX:MaxGCPauseMillis=200 \
    -XX:G1ConfidencePercent=50 \
    -XX:InitiatingHeapOccupancyPercent=45 \
    MyApp
```

GC 日志中出现 `[GC pause (G1 Evacuation Pause) (young), 0.0234567 secs]` —— 23ms 的 young GC 暂停。JVM 如何决定该暂停是否"合规"？如何预测下次 GC 需要多少时间？如何判断"该开始并发标记了"（IHOP 阈值）？

这三个问题的答案在 `G1Policy` 及其 8 个子组件中：
- `G1Analytics` 用 17 个历史序列预测暂停时间的每个组成部分
- `G1MMUTrackerQueue` 用 64 元素环形队列追踪 GC 暂停是否超出 `MaxGCPauseMillis` 目标
- `G1IHOPControl`（自适应模式）动态调整堆占用阈值，使并发标记在堆满之前完成
- `SurvRateGroup×2` 预测年轻代对象存活率以确定 Survivor/Eden 大小
- `G1MonitoringSupport` 把这些信息暴露为 JMX MBean，`jstat -gc` 展示的正是这些计数器的值

**三步诊断**：

```bash
# 1. 查看 GC 暂停预测 vs 实际
jcmd <pid> VM.flags | grep -E "MaxGCPauseMillis|G1ConfidencePercent|InitiatingHeapOccupancyPercent"
jstat -gcutil <pid> 1000
# GCT (GC Time) 列显示 GC 时间百分比

# 2. 查看 IHOP 阈值变化
grep -E "concurrent-mark-start|IHOP" gc.log
# 期望看到: concurrent-mark-start threshold = X.XB, IHOP = YY%

# 3. GDB 查看 Policy 内部状态
gdb -ex "break G1Policy::record_collection_pause_end" \
    -ex "run" \
    -ex "print _mmu_tracker" \
    -ex "print _analytics->_recent_gc_times_ms.last()" \
    -ex "print _ihop_control->get_conc_mark_start_threshold()" \
    --args java -Xms8g -Xmx8g -XX:+UseG1GC -jar app.jar
# 期望: recent_gc_times_ms 包含最近的暂停时间序列
```

**反事实**：如果 G1 没有预测模型（G1Analytics）→ 每次 GC 暂停时间完全不可预测 → 无法判断当前暂停是否合规 → 无法动态调整 young gen 大小 → 要么暂停时间超标（用户体验差），要么过于保守导致堆利用率低（浪费内存）。17 个 TruncatedSeq 用最近 10 次 GC 数据做加权平均预测，每个 Seq 对应暂停时间的一个独立成本因子。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

本文深度分析 G1 Policy 层在 JVM 启动时的初始化——G1Policy 构造函数创建的 8 个子组件及其内部数据结构。这是 `G1CollectedHeap::initialize()` 中 Step 16 (`:2286 g1_policy()->init()`) 的完整展开，以及构造函数中遗漏的 `G1MonitoringSupport`、`G1HeapVerifier`、`G1HeapSizingPolicy`、`EvacuationFailedInfo`、`PreservedMarksSet` 等子系统。

**前置**: [02-G1-Heap-Startup] — G1 堆内存布局和 Region 管理已覆盖。本文聚焦 Policy 层（决策引擎）和构造函数中遗漏的辅助子系统。

### Narrative

`G1CollectedHeap` 构造函数（`:1490-1582`）在初始化列表中执行 `new G1Policy(_gc_timer_stw)` —— 这触发了 G1 最复杂的对象创建链。`G1Policy` 构造函数（`g1Policy.cpp:50-72`）在初始化列表中创建 8 个子组件：`G1Predictions`（线性回归预测器）→ `G1Analytics`（17 个 TruncatedSeq 历史序列）→ `G1MMUTrackerQueue`（64 元素暂停追踪队列）→ `G1IHOPControl`（自适应或静态）→ `GCPolicyCounters`（PerfData 计数器）→ `SurvRateGroup×2`（存活率预测）→ `G1GCPhaseTimes`（阶段计时器，28 个 Phase × ParallelGCThreads 个 Worker 的时间数组）。

`G1Analytics` 构造函数（`g1Analytics.cpp:73-117`）用种子值填充 17 个 TruncatedSeq —— 每个 Seq 长度 10，存储最近 10 次 GC 的一个成本因子（如 `cost_per_card_ms_seq` 存储每次扫描一张 card 的毫秒数）。种子值来自 `cost_per_card_ms_defaults[index]` 等数组 —— index = `MIN2(ParallelGCThreads-1, 7)`，8 种预设配置对应 1-8+ 线程。

`G1MMUTrackerQueue` 内部用 64 元素的环形队列追踪 GC 暂停 —— 每个元素记录 `(start_time, end_time)`，当队列满时覆盖最旧的条目。`add_pause(start, end)` 添加新暂停 → `when_sec(current_time, pause_time)` 计算需要等待多久才能在不违反 `MaxGCPauseMillis` 的情况下执行下一次 GC。

`G1IHOPControl` 是一个类层次：基类存储 `_initial_ihop_percent` 和 `_target_occupancy`。`G1StaticIHOPControl` 固定返回 `_initial_ihop_percent * _target_occupancy / 100`。`G1AdaptiveIHOPControl` 额外维护 `_marking_times_s` 和 `_allocation_rate_s` 两个 TruncatedSeq，动态调整阈值使标记能在堆满前完成。

同时，构造函数体中创建了：`G1HeapVerifier`（`:1551`，6 种验证类型位掩码）、`G1HeapSizingPolicy`（`:1555`，基于 GC 开销比的堆扩展决策）、`EvacuationFailedInfo[13]`（`:1567-1573`，每个 GC 线程一个）、`PreservedMarksSet`（`:1527`，evacuation failure 时保存/恢复 mark word）。

`initialize()` 中 Step 未覆盖的 `_g1mm = new G1MonitoringSupport(this)`（`:2403`）创建了完整的 JMX 监控栈：3 个 CollectorCounters + 2 个 GenerationCounters + 5 个 HSpaceCounters。`initialize_serviceability()`（`:2538-2550`）创建 3 个 G1MemoryPool 并注册到 2 个 GCMemoryManager。

### Interview Story Format Answer（必须出现在 §一 末尾）

"`G1Policy` 构造函数在初始化列表中创建 8 个决策组件：`G1Predictions`（线性回归，置信度=G1ConfidencePercent/100=0.5）→ `G1Analytics`（17 个 TruncatedSeq，每个长度 10，存储 `cost_per_card_ms`/`alloc_rate`/`rs_length_diff` 等成本因子的最近 10 次观测值，用指数衰减加权平均做预测）→ `G1MMUTrackerQueue`（64 元素环形队列，每元素 16B，追踪 GC 暂停是否超出 MaxGCPauseMillis 目标——`when_sec()` 计算下次 GC 前需要等待的时间）→ `G1IHOPControl`（`G1UseAdaptiveIHOP=true` 时创建 `G1AdaptiveIHOPControl`，维护 `_marking_times_s` 和 `_allocation_rate_s` 两个 TruncatedSeq，动态调整 heap occupancy 阈值使并发标记在堆满前完成；false 时 `G1StaticIHOPControl` 固定返回 IHOP%×target_occupancy）→ `GCPolicyCounters`（PerfData 命名空间 `policy`，暴露 `tenuringThreshold` 和 `desiredSurvivorSize` 到 jstat）→ `SurvRateGroup×2`（`short_lived` 和 `survivor`，每个 Region 一个 TruncatedSeq(10)，追踪对象存活率——初始种子 0.4（40%），`accum_surv_rate_pred[i]` 累积 i 个年龄后的预期存活率）→ `G1GCPhaseTimes`（28 个 GCParPhases × ParallelGCThreads 个 Worker 的时间数组，记录 ExtRootScan/UpdateRS/ScanRS/ObjCopy/Termination 等阶段的每线程耗时）。

`G1CollectedHeap` 构造函数遗漏子系统：`G1HeapVerifier`（`:1551`，`_enabled_verification_types` 静态位掩码，YoungNormal=1/ConcurrentStart=2/Mixed=4/Remark=8/Cleanup=16/Full=32）→ `G1HeapSizingPolicy`（`:1555`，`_ratio_over_threshold_count` 追踪 GC 开销比是否持续超出 GCTimeRatio，`MinOverThresholdForGrowth=4` 次触发堆扩展）→ `EvacuationFailedInfo[13]`（`:1567-1573`，每个 GC 线程一个，记录 `_first_size`/`_smallest_size`/`_total_size`/`_count`）→ `PreservedMarksSet`（`:1527`，`_stacks` 数组每个 worker 一个 Padded<PreservedMarks>，每个 PreservedMarks 含 `Stack<OopAndMarkOop>` 用于 evacuation failure 时保存 mark word）。

`G1MonitoringSupport`（`:2403`，~1.1KB）创建 3 个 CollectorCounters（collector.0: incremental collections, collector.1: full collections, collector.2: concurrent STW phases）+ 2 个 GenerationCounters（generation.0: young, generation.1: old）+ 5 个 HSpaceCounters（gen.0.space.0: Eden, gen.0.space.1: S0/max=0 不用, gen.0.space.2: S1/实际 Survivor, gen.1.space.0: Old）。G1 只用 S1 作为 Survivor——因为 G1 的 Survivor 是一组离散 Region，不区分 from/to。`initialize_serviceability()`（`:2538-2550`）创建 3 个 G1MemoryPool（Eden/Survivor/OldGen）注册到 2 个 GCMemoryManager，其中 Old Pool 以 `always_affected_by_gc=false` 注册——Young/Mixed GC 不影响 Old Pool。总内存开销约 43KB（不含 SurvRateGroup 动态扩展）。"

### Beginner Callout Boxes（≥7，全部 inline 在 §一 中）

1. **TruncatedSeq 预测原理**: 每个 TruncatedSeq 存储最近 10 次观测值。预测时用指数衰减加权平均——最近一次权重最大，越旧权重越小。`G1Analytics` 有 17 个这样的序列，每个对应 GC 暂停时间的一个成本因子（如 `cost_per_card_ms_seq` 预测扫描每张 card 需要多少毫秒）。Source: `g1Analytics.hpp:34-159`, `numberSeq.cpp`。

2. **MMU (Minimum Mutator Utilization)**: `MaxGCPauseMillis` 不是单次暂停限制，是 MMU 约束——在 `GCPauseIntervalMillis` 时间窗口内，所有 GC 暂停的总时间不能超过 `MaxGCPauseMillis`。`G1MMUTrackerQueue::when_sec()` 计算"在时间窗口内还能暂停多久"。Source: `g1MMUTracker.hpp:50-82`。

3. **IHOP 自适应 vs 静态**: `G1UseAdaptiveIHOP=true`（默认）时，`G1AdaptiveIHOPControl` 根据历史标记耗时和分配速率动态计算 threshold。`false` 时 `G1StaticIHOPControl` 固定返回 `IHOP% × target_occupancy`。自适应模式需要 2 个额外的 TruncatedSeq。Source: `g1IHOPControl.hpp:85-153`, `g1Policy.cpp:849-860`。

4. **G1 只用 S1 做 Survivor**: 传统分代 GC 在 S0/S1 之间 ping-pong 复制。G1 的 Survivor 是一组离散 Region——所有 Survivor Region 统一报告为 S1（`generation.0.space.2`）。S0（`generation.0.space.1`）的 max=0，始终为 0。Source: `g1MonitoringSupport.cpp:203-217`。

5. **PreservedMarks 机制**: Evacuation failure 发生时，GC 线程无法将对象复制到目标 Region → 必须保持对象在原位置 → 但对象可能已经被 forward（mark word 被修改为 forwarding pointer）→ `PreservedMarks::push(oop, mark)` 保存原始 mark word → GC 结束后 `restore()` 恢复所有被修改的 mark word。Source: `preservedMarks.hpp:36-147`。

6. **G1GCPhaseTimes 的 28 个 Phase**: 每个 Phase 记录所有 GC worker 线程的时间——`WorkerDataArray<double>[ParallelGCThreads]`。GC 结束后 `print()` 输出 `[Ext Root Scanning (ms): Min: 0.1, Avg: 0.3, Max: 0.5, Diff: 0.4, Sum: 2.4]`。Source: `g1GCPhaseTimes.hpp:45-79`。

7. **G1HeapSizingPolicy 的扩展决策**: 不是"堆满了就扩"。基于 GC 开销比——如果 `(gc_time / (gc_time + mutator_time)) > (1 / (1 + GCTimeRatio))` 且连续超过 `MinOverThresholdForGrowth=4` 次 → 触发堆扩展。扩展量由 `expansion_amount()` 虚方法计算。Source: `g1HeapSizingPolicy.hpp:33-47`。

8. **EvacuationFailedInfo 的三级统计**: `_first_size`（第一个失败对象大小——通常是最大对象触发失败）→ `_smallest_size`（最小失败对象——说明 PLAB 碎片化严重）→ `_total_size`（失败对象总大小——衡量整体失败程度）→ `_count`（失败次数）。这些数据反馈给 G1Analytics 调整下次 GC 的 Eden 大小。Source: `copyFailedInfo.hpp:32-64`。

---

## §二 Standard Environment（必须写入文档 §二）

文档 §二 必须包含以下内容（不是概述，是精确的数据）：

### Source Roots

| 文件 | 关键行号 | 角色 |
|------|---------|------|
| `src/hotspot/share/gc/g1/g1Policy.cpp` | `:50-72` (构造), `:74-76` (析构), `:80-97` (init), `:849-860` (create_ihop_control) | G1Policy 主类 |
| `src/hotspot/share/gc/g1/g1Policy.hpp` | `:55-215` (成员变量) | G1Policy 类定义 |
| `src/hotspot/share/gc/g1/g1Analytics.cpp` | `:73-117` (构造, 17 个 TruncatedSeq 初始化) | G1Analytics 实现 |
| `src/hotspot/share/gc/g1/g1Analytics.hpp` | `:34-159` (成员变量 + 预测 API) | G1Analytics 类定义 |
| `src/hotspot/share/gc/g1/g1IHOPControl.hpp` | `:38-81` (基类), `:85-103` (Static), `:109-153` (Adaptive) | IHOP 控制类层次 |
| `src/hotspot/share/gc/g1/g1MMUTracker.hpp` | `:50-82` (基类), `:84-103` (QueueElem), `:107-143` (Queue) | MMU 追踪器 |
| `src/hotspot/share/gc/g1/g1MMUTracker.cpp` | `:42-142` (add_pause/when_sec/calculate_gc_time) | MMU 算法实现 |
| `src/hotspot/share/gc/g1/survRateGroup.cpp` | `:34-135` (构造/reset/stop_adding/record/finalize) | 存活率分组 |
| `src/hotspot/share/gc/g1/survRateGroup.hpp` | `:32-91` (成员变量) | SurvRateGroup 类定义 |
| `src/hotspot/share/gc/g1/g1GCPhaseTimes.hpp` | `:39-368` (枚举+成员+print API) | GC 阶段计时器 |
| `src/hotspot/share/gc/g1/gcPolicyCounters.cpp` | `:30-64` (构造, 6 个 PerfData 计数器) | Policy PerfData |
| `src/hotspot/share/gc/g1/g1MonitoringSupport.cpp` | `:98-225` (构造, 3+2+5 计数器) | JMX 监控支持 |
| `src/hotspot/share/gc/g1/g1MonitoringSupport.hpp` | `:117-249` (成员变量) | G1MonitoringSupport 类 |
| `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | `:1490-1582` (构造函数遗漏部分), `:2403` (_g1mm 创建), `:2538-2550` (initialize_serviceability) | G1CollectedHeap 构造 |
| `src/hotspot/share/gc/g1/g1HeapVerifier.hpp` | `:35-121` (类定义 + G1VerifyType 枚举) | 堆验证器 |
| `src/hotspot/share/gc/g1/g1HeapSizingPolicy.hpp` | `:33-63` (类定义 + 扩展决策) | 堆大小策略 |
| `src/hotspot/share/gc/shared/copyFailedInfo.hpp` | `:32-93` (CopyFailedInfo/PromotionFailedInfo/EvacuationFailedInfo) | 复制失败信息 |
| `src/hotspot/share/gc/shared/preservedMarks.hpp` | `:36-147` (PreservedMarks/PreservedMarksSet) | Mark 保存恢复 |

### Build & Binary

```bash
# 所有 Policy 代码链接到 libjvm.so
make jdk-image
# 产物: build/linux-x86_64-server-release/jdk/lib/server/libjvm.so
```

### Syscall 速查表

| Syscall | man | 调用点 | 说明 |
|---------|-----|--------|------|
| （本子系统不涉及直接 syscall — 纯 C++ 堆对象 + PerfData mmap 共享内存） | - | - | PerfData 的 mmap 见 prompt-07-PerfMemory |

### /proc 接口速查

| 路径 | man | 作用 | 本文涉及 |
|------|-----|------|---------|
| `/proc/<pid>/maps` | `man 5 proc` | 查看 PerfData mmap 区域 | G1MonitoringSupport 的 PerfData 计数器在此可见 |
| `jstat -gc <pid>` | - | 读取 PerfData 计数器 | GCPolicyCounters + G1MonitoringSupport 的计数器暴露给 jstat |

### 全局状态变量

| 变量 | 类型 | 位置 | 初始值 |
|------|------|------|--------|
| `_g1_policy->_analytics` | `G1Analytics*` | `g1Policy.hpp` | 17 个 TruncatedSeq(10) 含种子值 |
| `_g1_policy->_ihop_control` | `G1IHOPControl*` | `g1Policy.hpp` | Adaptive/Static，threshold = IHOP% × target_occupancy |
| `_g1_policy->_mmu_tracker` | `G1MMUTrackerQueue*` | `g1Policy.hpp` | 64 元素环形队列，初始空 |
| `_g1_policy->_short_lived_surv_rate_group` | `SurvRateGroup*` | `g1Policy.hpp` | 初始种子 surv_rate=0.4 |
| `_g1_policy->_phase_times` | `G1GCPhaseTimes*` | `g1Policy.hpp` | 28 Phase × ParallelGCThreads Worker 数组 |
| `_g1mm` | `G1MonitoringSupport*` | `g1CollectedHeap.hpp` | 3 Collector + 2 Gen + 5 Space Counters |
| `_verifier` | `G1HeapVerifier*` | `g1CollectedHeap.hpp:216` | 6 种验证类型位掩码 |
| `_heap_sizing_policy` | `G1HeapSizingPolicy*` | `g1CollectedHeap.hpp` | `_ratio_over_threshold_count=0` |
| `_evacuation_failed_info_array` | `EvacuationFailedInfo[]` | `g1CollectedHeap.hpp` | ParallelGCThreads 个，初始全 0 |
| `_preserved_marks_set` | `PreservedMarksSet` | `g1CollectedHeap.hpp` | `_in_c_heap=true`，空栈 |
| `_eden_pool/_survivor_pool/_old_pool` | `G1MemoryPool*×3` | `g1CollectedHeap.hpp:1501-1503` | initialize_serviceability() 后创建 |

---

## §三 Source Files Table（必须写入文档 §三）

| # | 源文件 | 关键行号 | 角色 | 应在文档 §一 讨论 |
|---|--------|---------|------|-----------------|
| 1 | `src/hotspot/share/gc/g1/g1Policy.cpp` | `:50-72`, `:80-97`, `:849-860` | G1Policy 构造 + init + IHOP 工厂 | §1.1 |
| 2 | `src/hotspot/share/gc/g1/g1Policy.hpp` | `:55-215` | G1Policy 类定义（28 个成员变量） | §1.1 |
| 3 | `src/hotspot/share/gc/g1/g1Analytics.cpp` | `:73-117` | G1Analytics 构造（17 个 TruncatedSeq 种子） | §1.2 |
| 4 | `src/hotspot/share/gc/g1/g1Analytics.hpp` | `:34-159` | G1Analytics 类定义 + 20 个预测 API | §1.2 |
| 5 | `src/hotspot/share/gc/g1/g1IHOPControl.hpp` | `:38-153` | IHOP 类层次（基类+Static+Adaptive） | §1.3 |
| 6 | `src/hotspot/share/gc/g1/g1MMUTracker.hpp` | `:50-143` | MMU 追踪器（基类+QueueElem+Queue） | §1.4 |
| 7 | `src/hotspot/share/gc/g1/g1MMUTracker.cpp` | `:42-142` | MMU 算法实现（add_pause/when_sec） | §1.4 |
| 8 | `src/hotspot/share/gc/g1/survRateGroup.cpp` | `:34-135` | SurvRateGroup 实现 | §1.5 |
| 9 | `src/hotspot/share/gc/g1/survRateGroup.hpp` | `:32-91` | SurvRateGroup 类定义 | §1.5 |
| 10 | `src/hotspot/share/gc/g1/g1GCPhaseTimes.hpp` | `:39-368` | G1GCPhaseTimes（28 Phase 枚举+类定义） | §1.6 |
| 11 | `src/hotspot/share/gc/g1/gcPolicyCounters.cpp` | `:30-64` | GCPolicyCounters（6 个 PerfData） | §1.7 |
| 12 | `src/hotspot/share/gc/g1/g1MonitoringSupport.cpp` | `:98-225` | G1MonitoringSupport 构造 | §1.8 |
| 13 | `src/hotspot/share/gc/g1/g1MonitoringSupport.hpp` | `:117-249` | G1MonitoringSupport 类定义 | §1.8 |
| 14 | `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | `:1490-1582`, `:2403`, `:2538-2550` | 构造函数遗漏 + _g1mm + serviceability | §1.9, §1.10, §1.11 |
| 15 | `src/hotspot/share/gc/g1/g1HeapVerifier.hpp` | `:35-121` | G1HeapVerifier 类 | §1.9 |
| 16 | `src/hotspot/share/gc/g1/g1HeapSizingPolicy.hpp` | `:33-63` | G1HeapSizingPolicy 类 | §1.9 |
| 17 | `src/hotspot/share/gc/shared/copyFailedInfo.hpp` | `:32-93` | CopyFailedInfo 层次 | §1.10 |
| 18 | `src/hotspot/share/gc/shared/preservedMarks.hpp` | `:36-147` | PreservedMarks/PreservedMarksSet | §1.10 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### Q1: G1Analytics 的 17 个 TruncatedSeq 分别预测什么？

**定位**：`g1Analytics.cpp:73-117` 构造 + `g1Analytics.hpp:34-159` 成员 + `numberSeq.cpp` TruncatedSeq 实现。

**必读源码**：`g1Analytics.cpp:73-117`（17 个 Seq 的 new 调用，种子值来源），`g1Analytics.hpp:114-158`（20 个 predict_* 方法签名），`numberSeq.hpp` 中 TruncatedSeq 的 `add()` 和 `davg()` 实现。

**答案方向**（≥8 行，含 file:line、追问、量化对比、内核引用）：

1. 列出全部 17 个 TruncatedSeq 的名称、长度参数、种子值来源数组名。区分 `NumPrevPausesForHeuristics`（=10）和 `TruncatedSeqLength`（=10）——两者值相同但语义不同：前者是暂停历史数，后者是通用序列长度。
2. `_recent_gc_times_ms` 存储什么？为什么长度用 NumPrevPausesForHeuristics 而非 TruncatedSeqLength？（答案：它直接影响 young gen sizing，需要与暂停预测关联）
3. `cost_per_card_ms_defaults[index]` 等种子数组——index 如何计算？为什么有 8 种预设？（答案：`MIN2(ParallelGCThreads-1, 7)`，线程数 1-8+ 分别对应不同预设，因为线程数影响并行扫描效率）
4. `_concurrent_mark_remark_times_ms` 和 `_concurrent_mark_cleanup_times_ms` 的种子为什么是 0.05 和 0.20？（答案：remark 通常 50ms，cleanup 通常 200ms——经验默认值，第一次标记后会被实际数据替换）
5. TruncatedSeq 的 `davg()`（衰减平均）算法：当前值 = 旧值 × alpha + 新观测值 × (1-alpha)，alpha 默认多少？（答案：`AbsSeq.cpp` 中 DefaultDavgAlpha = 0.7）
6. 20 个 predict_* 方法中，`predict_rs_update_time_ms(pending_cards)` 如何组合 `predict_cost_per_card_ms()` 和 `predict_scan_hcc_ms()`？（答案：`pending_cards × cost_per_card + scan_hcc`——线性模型）
7. 追问：如果 ParallelGCThreads 动态变化（`UseDynamicNumberOfGCThreads`），TruncatedSeq 的种子值是否重新计算？（答案：否——种子在构造时固定，但实际观测值会覆盖种子）
8. **反事实**：如果不用 TruncatedSeq 而用简单移动平均（SMA）→ SMA 对异常值同等权重 → 一次 Full GC 的异常长时间会持续影响 SMA 10 个周期 → 预测严重偏大 → young gen 缩得过小 → 频繁 GC。TruncatedSeq 的指数衰减给旧数据更低权重，异常值影响快速衰减。

### Q2: G1MMUTrackerQueue 如何计算"距离下次 GC 还需等待多久"？

**定位**：`g1MMUTracker.cpp:42-142` 实现 + `g1MMUTracker.hpp:50-143` 类定义。

**必读源码**：`g1MMUTracker.cpp:42-65` (remove_expired_entries), `:67-98` (calculate_gc_time), `:100-142` (when_sec)。

**答案方向**（≥8 行）：

1. `G1MMUTrackerQueue` 内部环形队列 `_array[64]`——为什么是 64？（答案：`QueueLength = 64`，在 `GCPauseIntervalMillis=500` 默认下，每个时间片最多追踪 64 次 GC 暂停——超过 64 次/500ms 意味着平均暂停间隔 <8ms，实际上不可能）
2. `add_pause(start, end)` 的入队逻辑：队列满时覆盖最旧的条目——这意味着什么？（答案：丢失最早的历史记录——但对 MMU 计算是安全的，因为最旧的记录可能已超出时间窗口）
3. `remove_expired_entries(current_time)` 如何判断"过期"？（答案：`current_time - elem.end_time > _time_slice`——即该 GC 暂停结束时间距离现在超过了一个时间窗口）
4. `calculate_gc_time(current_time)` 累加时间窗口内所有 GC 暂停的 duration——不是 `end-start`，是 `MIN2(end, current_time) - start`（部分在窗口内的暂停只计窗口内部分）
5. `when_sec(current_time, pause_time)` 的核心算法：如果 `gc_time + pause_time <= _max_gc_time` → 返回 0（可以立即 GC）；否则需要等待到最旧的 GC 记录过期（`oldest.end_time + _time_slice - current_time`）→ 等待时间窗口滑动。
6. 追问：`_max_gc_time = MaxGCPauseMillis/1000`——如果用户设置 `MaxGCPauseMillis=50`，意味着 500ms 窗口内总 GC 时间不能超过 50ms？（答案：不是——是每个 500ms 窗口内都不能超过 50ms。如果一次 GC 本身需要 60ms，则 MMU 永远无法满足——但 G1 不会拒绝执行 GC，只会选择违反 MMU）
7. **反事实**：如果没有 MMU 追踪 → GC 可能连续发生 → mutator 得不到 CPU 时间 → 吞吐量骤降。`when_sec()` 强制 GC 间插入最小 mutator 时间，保证 mutator 利用率 ≥ (1 - MaxGCPauseMillis/GCPauseIntervalMillis) = 90%（默认 50/500）。

### Q3: G1AdaptiveIHOPControl 如何动态调整阈值？

**定位**：`g1IHOPControl.hpp:109-153` 类定义 + `g1IHOPControl.cpp` 中 `update_allocation_info()` 和 `update_marking_length()`。

**必读源码**：`g1IHOPControl.hpp:109-153`（成员变量），`g1IHOPControl.cpp` 中 `G1AdaptiveIHOPControl::update_marking_length()` 和 `get_conc_mark_start_threshold()` 实现。

**答案方向**（≥8 行）：

1. `G1AdaptiveIHOPControl` 比 `G1StaticIHOPControl` 多了哪些成员？（答案：`_heap_reserve_percent`, `_heap_waste_percent`, `_predictor`, `_marking_times_s` (TruncatedSeq), `_allocation_rate_s` (TruncatedSeq), `_last_unrestrained_young_size`）
2. `get_conc_mark_start_threshold()` 的计算公式：`(target_occupancy - (allocation_rate × predicted_marking_time + heap_waste + reserve))` —— 解释每一项的含义和来源。
3. `_marking_times_s` 存储什么？何时添加新观测值？（答案：存储最近 10 次并发标记周期的时间长度；每次 `update_marking_length()` 调用时 `add()`）
4. `_allocation_rate_s` 存储什么？与 `G1Analytics::_alloc_rate_ms_seq` 的区别？（答案：IHOP 专用，追踪 mutator 期间老年代的分配速率；G1Analytics 的 alloc_rate 是整体分配速率）
5. `_last_unrestrained_young_size` 的作用？（答案：当 GC 暂停时间超出目标时，young gen 被约束——但 allocation rate 应该在不受约束的情况下测量——否则 allocation rate 被 young gen 限制扭曲）
6. `_heap_reserve_percent`（`G1ReservePercent=10`）和 `_heap_waste_percent`（`G1HeapWastePercent=5`）如何影响阈值？（答案：reserve 为安全余量——防止标记未完成时堆满；waste 容忍一些碎片——不回收 100% 可回收空间）
7. **反事实**：如果只用静态 IHOP（`-XX:G1UseAdaptiveIHOP=false`）→ 阈值固定为 `IHOP% × target_occupancy` → 如果 allocation rate 突然飙升（如批量数据导入），标记可能来不及在堆满前完成 → 触发 evacuation failure 或 Full GC。自适应模式根据实际 allocation rate 和 marking time 动态调低阈值。

### Q4: SurvRateGroup 如何预测对象存活率？

**定位**：`survRateGroup.cpp:34-135` 实现 + `survRateGroup.hpp:32-91` 类定义。

**必读源码**：`survRateGroup.cpp:42-70` (reset/start_adding_regions/stop_adding_regions), `:72-103` (record_surviving_words), `:105-135` (finalize_predictions/accum_surv_rate_pred)。

**答案方向**（≥8 行）：

1. `reset()` 中初始种子值 `surv_rate = 0.4`——为什么是 40%？（答案：经验值——大多数 Java 应用 young gen 对象存活率在 10-50%，40% 是保守估计，实际值会在首次 GC 后被覆盖）
2. `stop_adding_regions()` 动态扩展 `_accum_surv_rate_pred` 和 `_surv_rate_pred` 数组——每次 Young GC 后 young gen Region 数可能变化 → 数组长度需要动态调整。
3. `record_surviving_words(age, surv_words)` 中 `surv_rate = surv_words / HeapRegion::GrainWords`——这个计算有什么假设？（答案：假设每个 age 对应一个 Region——实际上多个 age 可能共享一个 Region，但 SurvRateGroup 按 age 而非 Region 分组）
4. `finalize_predictions(predictor)` 对每个 age 调用 `predictor.get_new_prediction(seq)`——返回的是指数衰减加权平均存活率。
5. `accum_surv_rate_pred(age)` 的累积乘法：`accum_surv_rate_pred[0] = surv_rate[0]`, `accum_surv_rate_pred[i] = accum_surv_rate_pred[i-1] × surv_rate[i]`——物理含义：经过 i+1 次 GC 后对象仍然存活的概率。
6. 追问：如果 `accum_surv_rate_pred(age)` 中 age 超出数组范围？（答案：线性外推 `_last_pred`——假设超出范围的 age 存活率恒定）
7. **反事实**：如果没有存活率预测 → 无法动态调整 Survivor 大小 → 要么 Survivor 太小（对象过早晋升到 Old → 增加 Mixed GC 频率），要么 Survivor 太大（浪费年轻代空间 → Eden 太小 → 频繁 Young GC）。存活率预测是 G1 自适应 tenuring threshold 的基础。

### Q5: G1MonitoringSupport 的 JMX 计数器布局——G1 为什么只用 S1 做 Survivor？

**定位**：`g1MonitoringSupport.cpp:98-225` 构造。

**必读源码**：`g1MonitoringSupport.cpp:138-225`（计数器创建），特别是 `:203-217`（HSpaceCounters 创建和 S0/S1 的区别）。

**答案方向**（≥8 行）：

1. 3 个 CollectorCounters 分别对应什么 GC 类型？（答案：collector.0=Young/Mixed GC, collector.1=Full GC, collector.2=Concurrent STW phases (remark/cleanup)）
2. 2 个 GenerationCounters 的 `min_capacity`/`max_capacity`/`init_capacity` 如何设置？（答案：min=0, max=max_heap_size, init=initial_heap_size × gen_ratio）
3. S0 (gen.0.space.1) 的 `max_capacity=0`——为什么？（答案：G1 不像传统 GC 在 S0/S1 间 ping-pong，所有 Survivor Region 统一报告为 S1）
4. S1 (gen.0.space.2) 的 `max_capacity=max_heap_size`——为什么这么大？（答案：理论上所有 Region 都可以是 Survivor，实际受 `G1ReservePercent` 和 IHOP 限制）
5. Old Space (gen.1.space.0) 的 `init_capacity = old_committed + padding`——padding 是什么？（答案：`_overall_reserved / (3 × HeapRegion::GrainBytes) × HeapRegion::GrainBytes`——额外一个 Region 的对齐）
6. `recalculate_sizes()` 如何计算 `_eden_committed`？（答案：`_eden_committed = young_list_max_length × HeapRegion::GrainBytes`）
7. 追问：`jstat -gc <pid>` 的 S0C/S1C/S0U/S1U 列读的是哪个计数器？（答案：S0C/S0U → `_from_counters`，S1C/S1U → `_to_counters`——G1 中 S0 始终为 0）
8. **反事实**：如果 G1 也像 Parallel GC 那样在 S0/S1 间 ping-pong → 需要额外的 Region 集合管理和 survivor age table 追踪 from/to 迁移 → 增加 GC 复杂度 → 而 G1 的 Survivor 只是一组 Region，GC 后直接切换标签（Old Region → Survivor Region）而不复制——更高效。

### Q6: initialize_serviceability 中 Old Pool 为什么以 always_affected_by_gc=false 注册？

**定位**：`g1CollectedHeap.cpp:2538-2550`。

**必读源码**：`g1CollectedHeap.cpp:2538-2550`（initialize_serviceability 完整函数），`gcMemoryManager.hpp` 中 `add_pool()` 的第三个参数 `always_affected_by_gc`。

**答案方向**（≥8 行）：

1. `_memory_manager.add_pool(_old_pool, false)` 中 `false` 的含义？（答案：Young/Mixed GC 不影响 Old Pool 的使用量——Old Pool 只在 Full GC 时被回收）
2. 为什么 `_full_gc_memory_manager.add_pool(_old_pool)` 没有第三个参数？（答案：默认 `true`——Full GC 必然影响所有 Pool）
3. 3 个 G1MemoryPool 的类型：`G1EdenPool`/`G1SurvivorPool`/`G1OldGenPool` 各自继承自什么？（答案：`G1MemoryPoolSuper` → `CollectedMemoryPool` → `MemoryPool`）
4. `G1MemoryPoolSuper` 的 `get_memory_usage()` 如何实现？（答案：调用 `_g1h->g1_policy()->mem_usage(type)`——动态计算而非缓存，因为 G1 Region 的 type 随时变化）
5. 追问：`jconsole` 的 Memory 标签页中 G1 Old Gen 的 "Used" 在 Young GC 后是否变化？（答案：不变化——因为 Young GC 不回收 Old Gen，`always_affected_by_gc=false` 使 JMX 通知也不触发）
6. **反事实**：如果 Old Pool 也标记 `always_affected_by_gc=true` → 每次 Young GC 后 jconsole 都会收到 Old Gen 的 MemoryNotification → jconsole 刷新 UI → 但实际上 Old Gen 使用量没变 → 虚假通知浪费 CPU。

### Q7: G1HeapSizingPolicy 如何基于 GC 开销比决定堆扩展？

**定位**：`g1HeapSizingPolicy.hpp:33-63` 类定义 + `g1HeapSizingPolicy.cpp` 实现。

**必读源码**：`g1HeapSizingPolicy.hpp:33-63`，`g1HeapSizingPolicy.cpp` 中 `expansion_amount()` 实现。

**答案方向**（≥8 行）：

1. `_ratio_over_threshold_count` 追踪什么？（答案：连续多少次 GC 的 overhead ratio 超出 `1/(1+GCTimeRatio)` 阈值）
2. `MinOverThresholdForGrowth=4`——为什么是 4 次而非 1 次？（答案：防止单次异常 GC（如 humongous allocation 触发的 evacuation failure）错误触发堆扩展——需要连续 4 次确认趋势）
3. `_ratio_over_threshold_sum` 存储什么？（答案：超出阈值的幅度之和——用于计算平均超出幅度）
4. `expansion_amount()` 的计算公式？（答案：`_g1h->capacity() × (ratio - threshold) / (1 - threshold)`——扩展量与超出幅度成正比）
5. 追问：如果 `GCTimeRatio=19`（默认），GC 时间超过多少会触发扩展？（答案：`1/(1+19) = 5%`——GC 时间超过总时间的 5% 即触发）
6. **反事实**：如果没有扩展策略 → 堆大小固定 → 对象分配速率超过回收速率 → 堆满 → Full GC → STW 时间可能数秒到数十秒。G1HeapSizingPolicy 在堆满之前提前扩展，避免灾难性的 Full GC。

### Q8: PreservedMarksSet 在 Evacuation Failure 中如何保存和恢复 mark word？

**定位**：`preservedMarks.hpp:36-147` 类定义。

**必读源码**：`preservedMarks.hpp:36-147`（完整类定义），`preservedMarks.cpp` 中 `restore()` 实现。

**答案方向**（≥8 行）：

1. `PreservedMarks::OopAndMarkOop` 结构：`oop _o; markOop _m`——各占多少字节？（答案：各 8B（64-bit），共 16B）
2. `PreservedMarks::push(oop, mark)` 何时被调用？（答案：evacuation failure 时，GC worker 发现目标 Region 已满 → 必须保持对象在原位置 → 但对象可能已被 forward（mark word 被修改）→ push 保存原始 mark word）
3. `PreservedMarksSet` 的 `_stacks` 为什么用 `Padded<PreservedMarks>`？（答案：每个 GC worker 一个栈，Padded 防止 false sharing——不同 worker 的栈在不同 cache line）
4. `restore(executor)` 如何恢复？（答案：遍历所有 worker 的栈 → 对每个 `OopAndMarkOop` 执行 `oop->set_mark(mark)` → 恢复原始 mark word）
5. `reclaim()` 何时调用？（答案：GC 结束后——释放 `_stacks` 数组）
6. `_in_c_heap` 为 true 时的行为？（答案：栈内存在 C-Heap 分配（`mtGC`），reclaim 时 `FREE_C_HEAP_ARRAY` 释放）
7. **反事实**：如果没有 PreservedMarks 机制 → evacuation failure 后对象的 mark word 残留 forwarding pointer → 下次访问该对象时 hash code/bias locking/GC age 信息丢失 → 行为异常（如 hashCode 变化、bias locking 失效）。PreservedMarks 保证 evacuation failure 对对象语义透明。

---

## §五 Article Structure（文档 §一 结构）

文档 §一 按以下顺序组织：

### §1.1 G1Policy 构造函数 — 8 个子组件的创建链
- 初始化列表顺序 + 每个子组件的构造时机和依赖关系
- 析构函数 `:74-76` 的清理顺序（`delete _ihop_control; delete _mmu_tracker; delete _analytics`）
- `G1Policy::init()` (`:80-97`) — 设置 `_g1h` 和 `_collection_set` 指针

### §1.2 G1Analytics — 17 个 TruncatedSeq 的预测模型
- 每个 Seq 的名称/长度/种子来源/物理含义
- `davg()` 衰减平均算法
- 20 个 predict_* API 及其组合关系
- 内存开销：19 个 TruncatedSeq ≈ 3.1KB

### §1.3 G1IHOPControl — 静态 vs 自适应 IHOP
- 基类/Static/Adaptive 三层类层次
- `create_ihop_control()` 工厂方法（`g1Policy.cpp:849-860`）
- 自适应模式的 `get_conc_mark_start_threshold()` 计算公式
- `update_marking_length()` 和 allocation rate 追踪

### §1.4 G1MMUTrackerQueue — 64 元素环形队列的暂停追踪
- QueueElem 结构（16B：start_time + end_time）
- `add_pause()` / `remove_expired_entries()` / `calculate_gc_time()` / `when_sec()`
- MMU 语义：`MaxGCPauseMillis` 是每个 `GCPauseIntervalMillis` 窗口内的总 GC 时间上限

### §1.5 SurvRateGroup — 对象存活率预测
- `_accum_surv_rate_pred[]` 和 `_surv_rate_pred[]` 双数组
- `record_surviving_words()` / `finalize_predictions()` / `accum_surv_rate_pred()`
- 累积乘法：`accum_surv_rate_pred[i] = Π surv_rate[0..i]`

### §1.6 G1GCPhaseTimes — 28 Phase × N Worker 的阶段计时
- GCParPhases 枚举（28 个 Phase）
- `WorkerDataArray<double>` 的每线程时间记录
- `print()` 输出格式：`[Phase Name (ms): Min: X, Avg: Y, Max: Z, Diff: W, Sum: S]`

### §1.7 GCPolicyCounters — PerfData 策略计数器
- 6 个 PerfData：name/collectors/generations/maxTenuringThreshold/tenuringThreshold/desiredSurvivorSize
- jstat 读取路径

### §1.8 G1MonitoringSupport — JMX 监控栈
- 3 CollectorCounters + 2 GenerationCounters + 5 HSpaceCounters
- G1 只用 S1 做 Survivor 的设计理由
- `recalculate_sizes()` 动态计算逻辑
- 内存开销：~1.1KB

### §1.9 G1CollectedHeap 构造函数遗漏成员
- G1HeapVerifier（`:1551`，6 种验证类型位掩码，~24B）
- G1HeapSizingPolicy（`:1555`，`MinOverThresholdForGrowth=4`，~40B）
- PreservedMarksSet（`:1527`，Padded 数组，~1KB）
- 其他遗漏成员列表（G1ArchiveAllocator, G1EvacStats×2, ReferenceProcessor×2, HeapRegionSet×2）

### §1.10 EvacuationFailedInfo 数组
- 每个 GC 线程一个（`:1567-1573`，`NEW_C_HEAP_ARRAY`，13 个 × 44B ≈ 572B）
- CopyFailedInfo 类层次：基类 → PromotionFailedInfo → EvacuationFailedInfo
- 三级统计：`_first_size`/`_smallest_size`/`_total_size`/`_count`

### §1.11 initialize_serviceability — MemoryPool 注册
- 3 个 G1MemoryPool 创建（`:2539-2541`）
- 注册到 2 个 GCMemoryManager（`:2543-2549`）
- Old Pool 的 `always_affected_by_gc=false` 语义

---

## §六 Writing Requirements（含"不要写成→应该写成"对照表）

| # | 不要写成 | 应该写成 |
|---|---------|---------|
| 1 | "G1Analytics 有 17 个历史序列用于预测" | "G1Analytics 构造函数（`g1Analytics.cpp:73-117`）用 `new TruncatedSeq(NumPrevPausesForHeuristics, &_predictor)` 创建 `_recent_gc_times_ms` 等 3 个序列，用 `new TruncatedSeq(TruncatedSeqLength)` 创建另外 14 个序列。种子值来自 8 个预设数组（`cost_per_card_ms_defaults[index]` 等），index = `MIN2(ParallelGCThreads-1, 7)`。每个 TruncatedSeq 内部维护 `_sequence` 数组（10×8B）和 `_alpha`（0.7），`davg()` 返回 `old_value × 0.7 + new_observation × 0.3`" |
| 2 | "MMU 追踪器确保暂停时间不超过目标" | "`G1MMUTrackerQueue`（`g1MMUTracker.hpp:107-143`）用 64 元素环形队列 `_array[QueueLength]`（每元素 `G1MMUTrackerQueueElem` 16B：start_time + end_time）。`add_pause(start, end)`（`g1MMUTracker.cpp:42-60`）计算 `(start - _head.start) × 1000.0` 时间差。`when_sec(current, pause)`（`:100-142`）首先 `calculate_gc_time(current)` 累加窗口内总 GC 时间，若 `gc_time + pause <= _max_gc_time` 返回 0（可立即 GC），否则返回需等待的秒数" |
| 3 | "IHOP 自适应调整堆占用阈值" | "`G1AdaptiveIHOPControl::get_conc_mark_start_threshold()`（`g1IHOPControl.cpp`）计算公式：`_target_occupancy - (_predictor->get_new_prediction(&_allocation_rate_s) × _predictor->get_new_prediction(&_marking_times_s) + _heap_waste_percent × _target_occupancy / 100 + _heap_reserve_percent × _target_occupancy / 100)`。`_allocation_rate_s` 追踪 mutator 期间老年代分配速率（`update_allocation_info()` 中添加观测值），`_marking_times_s` 追踪最近 10 次并发标记耗时" |
| 4 | "SurvRateGroup 预测对象存活率" | "`SurvRateGroup::record_surviving_words(age, surv_words)`（`survRateGroup.cpp:72-103`）计算 `surv_rate = (double)surv_words / HeapRegion::GrainWords` 并 `_surv_rate_pred[age]->add(surv_rate)`。`finalize_predictions(predictor)`（`:105-135`）对每个 age 调用 `predictor.get_new_prediction(*_surv_rate_pred[i])` 得到衰减平均存活率，然后 `_accum_surv_rate_pred[0] = _surv_rate_pred[0]->last()`，`_accum_surv_rate_pred[i] = _accum_surv_rate_pred[i-1] * _surv_rate_pred[i]->last()` ——累积乘法计算经过 i+1 次 GC 的存活概率" |
| 5 | "G1MonitoringSupport 创建 JMX 计数器" | "`G1MonitoringSupport` 构造函数（`g1MonitoringSupport.cpp:98-225`）创建：`_incremental_collection_counters = new CollectorCounters("G1 incremental collections", 0)`（`:141-143`）——collector.0；`_full_collection_counters`（`:145-147`）——collector.1；`_conc_collection_counters`（`:149-151`）——collector.2。`_old_collection_counters = new G1OldGenerationCounters("old", max_heap_size+pad, old_committed+pad, old_committed+pad)`（`:171-172`）——generation.1。S1 的 max=max_heap_size（`:212`），S0 的 max=0（`:205`）——因为 G1 只用 S1" |
| 6 | "initialize_serviceability 注册 MemoryPool" | "`initialize_serviceability()`（`g1CollectedHeap.cpp:2538-2550`）创建 3 个 Pool：`_eden_pool = new G1EdenPool(this)` → `_survivor_pool = new G1SurvivorPool(this)` → `_old_pool = new G1OldGenPool(this)`。`_full_gc_memory_manager.add_pool()` 注册 3 次（`:2543-2545`），`_memory_manager.add_pool()` 注册 3 次，其中 `add_pool(_old_pool, false)`（`:2549`）的 `false` 表示 Young/Mixed GC 不影响 Old Pool——因为 `G1OldGenPool::get_memory_usage()` 在 Young GC 后 used 不变" |

---

## §七 Output Format

文档输出路径：`/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/08-G1-Policy-Analytics.md`

### 文档标题格式

```
# 08-G1-Policy-Analytics — G1 决策引擎与监控基础设施
```

### Section 编号（写入文档时使用此编号）

```
§〇 Production Scenario — IHOP 阈值与 GC 暂停预测
§一 G1 Policy 层初始化全链路（11 小节）
§二 Standard Environment
§三 Source Files Table
§四 异常路径分析（G1Policy 构造失败 / G1MonitoringSupport OOM / Serviceability 注册失败）
§五 GDB 断点验证（≥7 断言）
§六 总内存开销
§七 Cross-Reference
§八 Mermaid 组件关系图
```

### GDB Verification（≥7 断言）

```
断言 1: G1Policy 构造完成 (g1Policy.cpp:72 之后)
  (gdb) print _g1_policy->_analytics
  期望: 非 NULL — G1Analytics 对象指针
  (gdb) print _g1_policy->_analytics->_recent_gc_times_ms.num()
  期望: 0 (刚构造，无观测值)

断言 2: 17 个 TruncatedSeq 种子值 (g1Analytics.cpp:117 之后)
  (gdb) print _g1_policy->_analytics->_recent_gc_times_ms.avg()
  期望: 0.0 (无观测值)
  (gdb) print _g1_policy->_analytics->_concurrent_mark_remark_times_ms.avg()
  期望: 0.05 (种子值)

断言 3: IHOP 控制类型 (g1Policy.cpp:72 之后)
  (gdb) print _g1_policy->_ihop_control
  期望: 非 NULL
  (gdb) print _g1_policy->_ihop_control->get_conc_mark_start_threshold()
  期望: = IHOP% × target_occupancy (如 0.45 × 8GB × G1HeapWastePercent 调整后)

断言 4: MMU Tracker 初始状态 (g1Policy.cpp:72 之后)
  (gdb) print _g1_policy->_mmu_tracker->_no_entries
  期望: 0 (队列空)
  (gdb) print _g1_policy->_mmu_tracker->_head_index
  期望: 0

断言 5: G1MonitoringSupport 计数器 (g1CollectedHeap.cpp:2403 之后)
  (gdb) print _g1mm->_incremental_collection_counters
  期望: 非 NULL (collector.0)
  (gdb) print _g1mm->_to_counters
  期望: 非 NULL (gen.0.space.2, G1 的 Survivor)

断言 6: initialize_serviceability (g1CollectedHeap.cpp:2550 之后)
  (gdb) print _eden_pool
  期望: 非 NULL
  (gdb) print _old_pool
  期望: 非 NULL
  (gdb) print _memory_manager.num_pools()
  期望: 3

断言 7: EvacuationFailedInfo 数组 (g1CollectedHeap.cpp:1573 之后)
  (gdb) print _evacuation_failed_info_array[0]._count
  期望: 0 (刚构造，无失败)
  (gdb) print _evacuation_failed_info_array[0]._total_size
  期望: 0
```

---

## §八 Prohibited（≥8 条）

1. **禁止只写概念不写代码行号**：每个技术断言必须有 `file:line` 引用。如 "G1Analytics 创建 17 个 TruncatedSeq" 必须标注 `g1Analytics.cpp:73-117`。
2. **禁止把 G1Policy 当成黑盒**：必须逐个展开 8 个子组件的构造过程，不能写成 "G1Policy 负责决策"。
3. **禁止忽略构造函数初始化列表顺序**：`G1Policy` 构造函数的初始化列表顺序就是创建顺序——文档必须按此顺序描述。
4. **禁止把 TruncatedSeq 当成普通队列**：必须解释 `davg()` 的指数衰减算法和 alpha 值。
5. **禁止跳过 S0 max=0 的设计理由**：G1MonitoringSupport 中 S0 的 max_capacity 为 0 不是 bug，是 G1 不区分 from/to Survivor 的设计决策——必须解释。
6. **禁止把 initialize_serviceability 当作"简单的注册代码"**：必须解释 Old Pool 的 `always_affected_by_gc=false` 语义及其对 JMX 通知的影响。
7. **禁止忽略内存开销**：每个子组件必须有 sizeof 估算（如 TruncatedSeq ≈ 136B, SurvRateGroup 动态扩展 ≈ 17KB/100 regions）。
8. **禁止省略 EvacuationFailedInfo 的类层次**：必须展示 CopyFailedInfo → PromotionFailedInfo/EvacuationFailedInfo 的继承关系。
9. **禁止写成 Java GC 教程**：这是 C++ 源码分析文档，不是"G1 GC 入门"。不要解释什么是 young GC/mixed GC/IHOP 概念——直接分析源码中的数据结构。

---

## §九 Required（≥8 条）

1. **Mermaid 组件关系图**：展示 G1Policy → G1Analytics/G1MMUTrackerQueue/G1IHOPControl/SurvRateGroup/G1GCPhaseTimes/GCPolicyCounters → G1MonitoringSupport/initialize_serviceability 的层次结构。
2. **TruncatedSeq 内部结构图**：展示 `_sequence[10]` 数组 + `_alpha` + `davg()` 的衰减平均计算。
3. **IHOP 类层次图**：G1IHOPControl (基类) → G1StaticIHOPControl / G1AdaptiveIHOPControl。
4. **MMU 环形队列图**：64 元素 `_array[64]` + `_head_index`/`_tail_index` + `add_pause`/`when_sec` 交互。
5. **G1MonitoringSupport 计数器布局表**：3 CollectorCounters + 2 GenerationCounters + 5 HSpaceCounters 的名称/类型/初始值。
6. **总内存开销表**：G1Policy (~120B) + G1Analytics (~3.1KB) + G1MMUTrackerQueue (~1.1KB) + G1IHOPControl (~344B) + GCPolicyCounters (~324B) + G1GCPhaseTimes (~2.7KB) + SurvRateGroup×2 (~34KB) + G1MonitoringSupport (~1.1KB) + G1HeapVerifier (~24B) + G1HeapSizingPolicy (~40B) + EvacuationFailedInfo[13] (~572B) + PreservedMarksSet (~1KB) = **总计 ~43KB**。
7. **§〇 三步诊断**：jcmd VM.flags + jstat -gcutil + GDB 断点验证 Policy 内部状态。
8. **§一 末尾 Interview Story Format Answer**：完整的技术叙述，覆盖所有子组件的创建链和关键数据结构。
9. **Callout 框 ≥7 个**：全部 inline 在 §一 中，不在 §二 出现。

---

## §十 与 README 和同组文档的连续性

- **前置文档**：[02-G1-Heap-Startup] — 本文是 02 的深入扩展，覆盖 02 中遗漏的 G1Policy 层和构造函数子系统
- **配套文档**：[09-G1-Concurrent-Marking-Infra] — G1ConcurrentMark 构造函数 + 并发精炼 + 线程创建
- **后续文档**：所有 GC 运行时 Phase（Young GC / Mixed GC / Full GC）依赖本文创建的 Policy 决策引擎
- **与 init_globals 的关系**：本文覆盖的子系统都在 `init_globals` 第 9 步 `universe_init()` 中创建——G1Policy 在 `G1CollectedHeap` 构造函数中创建，G1MonitoringSupport 在 `initialize()` 的 `:2403` 创建，initialize_serviceability 在 `:2538` 调用

---

## §十一 与 README 和同组 prompt 的连续性

- **prompt-02**（G1-Heap-Startup）覆盖了 G1 堆的 mmap 预留 + 6 Mapper + Card Table + BOT + Region 创建 + SATB/DirtyCard 队列。本文覆盖 02 中遗漏的 Policy 层（G1Policy 8 个子组件）和构造函数遗漏子系统（G1HeapVerifier/G1HeapSizingPolicy/EvacuationFailedInfo/PreservedMarksSet/G1MonitoringSupport/initialize_serviceability）。
- **prompt-09**（G1-Concurrent-Marking-Infra）覆盖 G1ConcurrentMark 完整构造函数 + 并发精炼 + 线程创建。本文与 09 的边界：Policy 层（本文）负责决策"何时 GC"，Concurrent Mark 层（09）负责执行"如何标记"。
- 本文创建的数据结构在后续 GC 运行时 Phase 中被使用：G1Analytics 的序列在每次 GC 后 `add()` 新观测值，G1MMUTrackerQueue 在每次 GC 后 `add_pause()`，SurvRateGroup 在每次 Young GC 后 `record_surviving_words()`。
