# G1 Young GC：Evacuation 周期

> **本文定位**：ch11 运行时系列第一篇。逐条讲完一次 Normal Young GC（GC 日志里的 `Pause Young (Normal)`）从触发到结束的完整流程。
>
> **前置概念**：Eden / Survivor / Old 角色、STW 和 safepoint、Evacuation（搬活不删死）、GC Roots（ch11/07）。
>
> **阅读提示**：各 Section 按"这个阶段做什么 → 为什么 → 源码在哪"组织。附录放细节（TLAB 分配、young target 算法）。

---

## 目录

1. [触发——分配失败](#1-触发分配失败)
2. [全景——do_collection_pause_at_safepoint](#2-全景do_collection_pause_at_safepoint)
3. [阶段 1: GCLocker 检查](#3-阶段-1-gclocker-检查)
4. [阶段 2: 决定是否 InitialMark](#4-阶段-2-决定是否-initialmark)
5. [阶段 3: CSet 选择](#5-阶段-3-cset-选择)
6. [阶段 4: Pre-Evacuation](#6-阶段-4-pre-evacuation)
7. [阶段 5: Evacuation 核心](#7-阶段-5-evacuation-核心)
8. [阶段 6: Post-Evacuation](#8-阶段-6-post-evacuation)
9. [阶段 7: Free CSet](#9-阶段-7-free-cset)
10. [阶段 8: 启动下一个 CSet](#10-阶段-8-启动下一个-cset)
11. [完整时间线](#11-完整时间线)
12. [附录 A: _young_list_target_length 算法](#附录-a-_young_list_target_length-算法)
13. [附录 B: TLAB/Region 分配故障详情](#附录-b-tlabregion-分配故障详情)

---

## 1. 触发——分配失败

mutator 不停地创建对象。每个线程在自己专属的 TLAB 里做 pointer bump 分配（`_top + size ≤ _end` → `_top += size`，约 10 条 CPU 指令）。

TLAB 用完了 → 向当前 Eden Region 要一块新空间 → Eden Region 也切光了 → 需要新 Eden Region。但 EhvaopRegion 的数量是受控的——G1Policy 用 `_young_list_target_length`（附录 A 解释了它怎么算）限制 Young Generation 的大小：

```cpp
// g1Policy.hpp:82
uint _young_list_target_length;   // Young Region (Eden+Survivor) 的目标总数
```

当现有 young region 数量已经达到这个上限 → 不能再申请新的 → 分配失败 → **触发 Young GC**。

```cpp
// g1CollectedHeap.cpp:459-460
do_collection_pause(word_size, gc_count_before, &succeeded,
                    GCCause::_g1_inc_collection_pause);
```

发起分配的那个线程通过 `VM_G1CollectForAllocation` 提交任务给 VMThread。VMThread 启动 safepoint 协议——arm polling page、关闭交互、等所有线程停下——然后进入 `do_collection_pause_at_safepoint()`。

---

## 2. 全景——do_collection_pause_at_safepoint

`G1CollectedHeap::do_collection_pause_at_safepoint()`（g1CollectedHeap.cpp:2793-3123）是约 330 行的主编排方法。下面是完整流程：

```
T0: safepoint → 所有线程停下
│
├─ 阶段 1: GCLocker 检查                               ─ line 2798
│   如果有 JNI critical section 持有者 → abort GC，return false
│
├─ 阶段 2: 决定是否 InitialMark                        ─ line 2826
│   decide_on_conc_mark_initiation() 判断 IHOP 是否达标
│
├─ 阶段 3: CSet 选择                                   ─ line 2944
│   finalize_collection_set() → finalize_young_part()
│
├─ 阶段 4: Pre-Evacuation                              ─ line 2972
│   合并 dirty card / 重置 scan_state
│
├─ 阶段 5: Evacuation（并行核心）                       ─ line 2975
│   G1ParTask: root scan → RSet scan → 搬活对象 + 工作窃取
│
├─ 阶段 6: Post-Evacuation                             ─ line 2977
│   引用处理 + 弱引用清理 + 字符串去重
│
├─ 阶段 7: Free CSet                                    ─ line 2980
│   空 Region → FreeList / evac_failed Region → Old
│
├─ 阶段 8: 启动下一个 CSet                              ─ line 2989
│   start_new_collection_set() + init_mutator_alloc_region
│
└─ 如果需要 → do_concurrent_mark()                     ─ line 3119
```

下面逐个阶段展开。

---

## 3. 阶段 1: GCLocker 检查

JNI 提供 `GetPrimitiveArrayCritical()` 函数——它返回一个**指向 Java 数组内存的原始指针**，让 native 代码直接操作数组内容，不经过 JVM 包装。

**问题**：这条指针指向堆里的对象。GC 是标记-复制——它会把活对象搬走。如果 `GetPrimitiveArrayCritical` 持有者还在操作这块内存时 GC 搬走了对象——指针变成野指针，直接 crash。

**GCLocker 的解决方案**：`lock_critical()` 进入 critical section 时给 `_jni_lock_count` 递增。GC 在 safepoint 中调用 `GCLocker::check_active_before_gc()`（g1CollectedHeap.cpp:2798）：

```cpp
if (GCLocker::check_active_before_gc()) {
    return false;  // 有 JNI critical section → 放弃本次 GC
}
```

返回 false 后——**本次 GC 被 abort**。VMThread 解除 safepoint，mutator 线程继续运行。那位分配失败的线程会再次触发 GC。一直循环，直到所有 JNI critical section 都被释放（`ReleasePrimitiveArrayCritical` → `unlock_critical()`）。

**为什么不在 safepoint 里等**——VMThread 不能干等，因为 `ReleasePrimitiveArrayCritical` 是 mutator 线程的 native 代码部分——必须让 mutator 恢复运行才能执行。所以策略是 "abort, retry" 而非 "wait"。

注意这是一个**双重中断机制**：
- 首先尝试 GCLocker 紧急扩展（第三级）——用 `_young_list_max_length` 做上限
- 如果扩展也不够——`GCLocker::stall_until_clear()`——在 `JNICritical_lock` 上等待所有 critical section 释放

**为什么 G1 希望这种情况极少发生**——每次 abort 都是浪费的一次 safepoint 往返。`GCLockerEdenExpansionPercent`（默认 5%）给 young gen 额外 buffer，就是为了减少 GCLocker 冲突。

---

## 4. 阶段 2: 决定是否 InitialMark

每次 Young GC 之前，G1Policy 判断一个关键问题：**"这次 Young GC 要不要顺便启动并发标记（InitialMark）？"**

```cpp
// g1CollectedHeap.cpp:2826
if (!_cm_thread->should_terminate()) {
    g1_policy()->decide_on_conc_mark_initiation();
}
```

`decide_on_conc_mark_initiation()`（g1Policy.cpp:936-985）检查：

```
if (collector_state()->initiate_conc_mark_if_possible()  // 上次 GC 结束时设的 flag?
    && collector_state()->in_young_only_phase()           // 当前是 young-only 阶段?
    && !about_to_start_mixed_phase())                     // 还没进入 mixed 阶段?
{
    initiate_conc_mark();  // → _in_initial_mark_gc = true → 本次变成 InitialMarkGC
}
```

那 `initiate_conc_mark_if_possible` 是谁设的？上一次 GC 结束时的 `maybe_start_marking()` → `need_to_start_conc_mark()`（g1Policy.cpp:531-551）：

```cpp
bool need_to_start_conc_mark() {
    size_t threshold = _ihop_control->get_conc_mark_start_threshold();  // IHOP!
    size_t cur_used = _g1h->non_young_capacity_bytes();  // old + humongous 占用量

    return cur_used > threshold;   // Old Gen 太满了 → 需要并发标记了
}
```

**IHOP 阈值**：自适应模式下等于 `internal_threshold - (marking_time × promotion_rate + max_young_size)`。本质含义：**"再等下去，下次 Young GC 放不进的就太多了——应该现在做准备"**。

**本次 Young GC**（Normal Young GC）：`in_initial_mark_gc()` 返回 false → `should_start_conc_mark = false` → 走纯 young 回收路径。Concurrent Mark 会在 ch11/13 详细展开。

---

## 5. 阶段 3: CSet 选择

**做什么**：决定本次 GC 要回收哪些 Region。

Normal Young GC 的 CSet = **所有 Eden Region + 所有 Survivor Region**（全量加入，无需选择）。每个 Region 进入 CSet 的时机：

| 哪种 Region | 什么时候进 CSet | 源码 |
|-----------|---------------|------|
| 已填满退休的 Eden | mutator 运行中——退休时 `retire_mutator_alloc_region()` → `add_eden_region()` | g1CollectedHeap.cpp:4874 |
| **当前活跃的 Eden**（mutator 正在用的） | GC 开始时——`release_mutator_alloc_region()` 退休它 → 同路径入 CSet | g1CollectedHeap.cpp:2926→4869→4874 |
| 上一轮 Survivor | 上轮 GC 结束时——`transfer_survivors_to_cset()` | g1Policy.cpp:1148 |

GC 开始时 `finalize_collection_set()`（g1CollectedHeap.cpp:2944）只是**锁定**这个集合——把增量构建模式从 Active 切 Inactive（`finalize_incremental_building()`），记下本轮的 eden/survivor 数量（`init_region_lengths`），再调用 `survivors->convert_to_eden()` 重标 Survivor 标签。

详细算法在附录 A。

---

## 6. 阶段 4: Pre-Evacuation

**做什么**：搬活对象之前，把 dirty card 数据准备好。

```cpp
// g1CollectedHeap.cpp:2972
pre_evacuate_collection_set();
  → _hot_card_cache->set_use_cache(false);    // 关闭热卡缓存
  → g1_rem_set()->prepare_for_oops_into_collection_set_do()
      → concatenate_logs()          // 合并所有线程的 partial dirty card buffer
      → _scan_state->reset()        // 为每个 Region 重算 _scan_top[i]
```

`concatenate_logs()`：mutator 线程在 GC 前最后分配对象时可能产生了 dirty card——这些卡写在 thread-local buffer 里，还没提交到全局队列。**必须赶在 GC 扫描前合并进来**，否则会漏掉引用。

`_scan_state->reset()`：为堆中每个 Region 重算 `_scan_top[i]`（ch11/06 §2.3）。不在 CSet 中的 old/humongous Region 设 `top()`（需要扫描它的 card），CSet 内/young/free Region 设 `bottom()`（不需要）——因为 CSet 内部引用在 evacuation 时自然处理。

---

## 7. 阶段 5: Evacuation 核心

**做什么**：搬走 CSet 中所有活对象。这是 G1 GC 最核心的并行阶段。

```cpp
// g1CollectedHeap.cpp:2975
evacuate_collection_set(&per_thread_states);
  → G1ParTask g1_par_task(this, psss, _task_queues, &root_processor, n_workers);
  → workers()->run_task(&g1_par_task);
```

### 7a. 根扫描——从 GC Roots 出发找活对象

每个 GC Worker 调用 `evacuate_roots(pss, worker_id)`（g1RootProcessor.cpp:78-136），依次遍历所有根类型。**Root 扫描的并行机制**——G1RootProcessor 定义了一个 12 个子任务的枚举（g1RootProcessor.hpp:59-74）：

```
G1RP_PS_Universe_oops_do         ← 1. Universe 基础类型
G1RP_PS_JNIHandles_oops_do       ← 2. JNI 全局/局部引用
G1RP_PS_ObjectSynchronizer_oops_do ← 3. 同步原语
G1RP_PS_Management_oops_do       ← 4. JMX/JFR 管理引用
G1RP_PS_SystemDictionary_oops_do ← 5. 系统字典
G1RP_PS_ClassLoaderDataGraph_oops_do ← 6. 类加载器数据图
G1RP_PS_jvmti_oops_do           ← 7. JVMTI 探针
G1RP_PS_CodeCache_oops_do       ← 8. CodeCache
G1RP_PS_aot_oops_do             ← 9. AOT 编译缓存
G1RP_PS_filter_satb_buffers     ← 10. SATB 缓冲过滤
G1RP_PS_refProcessor_oops_do    ← 11. Reference 处理器
G1RP_PS_weakProcessor_oops_do   ← 12. 弱引用处理器
G1RP_PS_NumElements             ← 13. (计数哨兵)
```

**如何保证没有两个 Worker 处理同一个根？** `SubTasksDone::is_task_claimed()`（workgroup.cpp:446-460）用 **CAS 原子操作**——12 个子任务每个有一个 0/1 锁标记。Worker 对任务 t 执行 `Atomic::cmpxchg(1, &_tasks[t], 0)`——第一个 worker 成功（返回 0），成为该任务的 claimant；后续 worker 发现已经是 1，直接跳过。

**扫描到 CSet 内的对象时** → 调用 `G1ParCopyClosure::do_oop()`：
1. 读引用 → 指向 CSet 内对象 A
2. A 的 mark word 低 2 位 = 11（forwarding pointer）→ 已搬过，更新引用到新地址
3. A 还没搬 → 在 Survivor/Old Region 中分配空间 → memcpy 过去 → 把 A 压入 Worker 队列（后面 7c 追踪它的引用字段）→ 写 forwarding pointer（`encode_pointer_as_mark(new_addr)`）

### 7b. RSet 扫描——找到跨 Region 引用

Root 扫描只覆盖从 JVM 根出发的引用。但 CSet 里的对象还可能被**不在 CSet 中的 old/humongous Region** 引用——Root 扫描看不到这些引用。

**RSet 就是解决这个问题的**——每个 Region 的 RSet 记录了"谁引用了我的 card"（ch11/06）。Worker 调用 `oops_into_collection_set_do(pss, worker_id)`（g1RemSet.cpp:506）：

1. `update_rem_set()`——处理 refinement 线程还没来得及处理的 dirty card，更新 RSet
2. `scan_rem_set()`——遍历 CSet Region 的 RSet → 找到来自 old Region 的入引用 → 同样调用 `G1ParCopyClosure::do_oop()` 搬对象

Worker 通过 `_iter_claims` 用原子操作抢 card block 来并行扫描。

### 7c. 工作窃取——追踪到底

Root 扫描（7a）和 RSet 扫描（7b）搬的对象被推进每个 Worker 的本地队列。但这些对象的**引用字段**还指向别的对象——那些对象也需要被搬。

`G1ParEvacuateFollowersClosure::do_void()`（g1CollectedHeap.cpp:3157）：
```cpp
pss->trim_queue();                     // 先排空自己的队列
do {
    pss->steal_and_trim_queue(queues());   // 从别的 Worker 偷活
} while (!offer_termination());            // 直到所有活儿全干完
```

**工作窃取**：Worker 自己的队列空后，从其他 Worker 的队列里随机选两个、偷其中更好的（`steal_best_of_2`）。偷到的作业又是一个引用 → 同样走 `G1ParCopyClosure::do_oop()` → 搬对象 → 产生新引用 → 推队列 → 继续偷。这是一个 BFS 扩散，直到整棵引用树遍历完。

**为什么需要这个阶段**：7a 和 7b 只覆盖了"直接引用到的对象"——但 A 引用 B、B 引用 C、C 是活的——如果不追踪，B 和 C 会被漏掉。工作窃取保证了"只要有一个 Worker 还不够忙，就继续找活干"。

---

## 8. 阶段 6: Post-Evacuation

所有对象都搬完了。现在还剩下"弱引用"需要判定：

```cpp
// g1CollectedHeap.cpp:2977
post_evacuate_collection_set(&per_thread_states);
```

内部（g1CollectedHeap.cpp:4099-4166）：
1. **引用处理**——`process_discovered_references()` 对 Soft/Weak/Final/Phantom 引用分四轮处理
2. **弱引用清理**——`WeakProcessor::weak_oops_do()` 清 StringTable/ResolvedMethodTable
3. **字符串去重**——`G1StringDedup::unlink_or_oops_do()`
4. **恢复热卡缓存**——`reset_hot_cache() + redirty_logged_cards()`

引用处理需要知道"referent 还活着吗"——必须在所有对象都搬完、对象图全部追踪完之后才能回答。

---

## 9. 阶段 7: Free CSet

**做什么**：CSet 里的所有活对象都被搬走了（阶段 5），空 Region 还给 FreeList。

```cpp
// g1CollectedHeap.cpp:2980
free_collection_set(&_collection_set, evacuation_info, surviving_young_words);
```

创建并行 `G1FreeCollectionSetTask`——分工：

**串行部分**（一个 Worker 持 `OldSets_lock`）：
- 遍历 CSet 每个 Region
- `!r->evacuation_failed()` → `free_region()` → `hr_clear()` + 插入局部 free list
- `r->evacuation_failed()` → `r->set_old()` → 加入 old set（搬不走就当 Old）

**并行部分**（所有 Worker，按 32 个 Region 为一批抢任务）：
- 清空每个 Region 的 RSet：`r->rem_set()->clear_locked()`
- 清空 hot card cache 计数

最后 `prepend_to_freelist()`（g1CollectedHeap.cpp:4221）合并局部 free list 到全局。

---

## 10. 阶段 8: 启动下一个 CSet

```cpp
// g1CollectedHeap.cpp:2989
start_new_collection_set();
  → collection_set()->start_incremental_building();   // _inc_build_state = Active
  → clear_cset_fast_test();                           // 清空 in_cset_fast_test
  → transfer_survivors_to_cset(survivor());           // Survivor → 下一轮 CSet

// g1CollectedHeap.cpp:3020
_allocator->init_mutator_alloc_region();
```

本轮 GC 存活下来的对象在 Survivor Region 中。`transfer_survivors_to_cset()` 把这些 Region 加入**下一轮**的 CSet——因为下一次 Young GC 时它们就是要被回收的 survivor 部分。等到下次 GC 的 `finalize_young_part()` 会调 `survivors->convert_to_eden()` 把它们的 Tag 从 `SurvTag(3)` 改为 `EdenTag(2)`。

**如果需要并发标记**（阶段 2 判断的）：`do_concurrent_mark()`（g1CollectedHeap.cpp:3119）通知 CM 线程启动。

---

## 11. 完整时间线

```
T0: safepoint → 所有线程停下
T1: GCLocker check → pass ───────────────────── line 2798
T2: decide_on_conc_mark_initiation → Normal ─── line 2826
T3: release_mutator_alloc_region() ──────────── line 2926
T4: finalize_collection_set() ───────────────── line 2944
T5: pre_evacuate() ──────────────────────────── line 2972
T6: evacuate_collection_set()（并行）
    ├ Worker 0: evacuate_roots(0) → RS scan → steal & trim
    ├ Worker 1: evacuate_roots(1) → ... ────── line 2975
    └ ...所有 Worker 并行推进，直到队列全空
T7: post_evacuate() ─────────────────────────── line 2977
T8: free_collection_set() ───────────────────── line 2980
T9: start_new_collection_set() ──────────────── line 2989
T10: init_mutator_alloc_region() ────────────── line 3020
T11: safepoint 结束 → mutator 恢复运行
```

GC 日志显示时间 = T3→T11（不含 TTSP）。

---

## 附录 A: `_young_list_target_length` 算法

G1Policy 用 `_young_list_target_length` 控制堆里该有多少 Young Region。**两次计算——初始值和运行值完全不同。**

### A.1 初始值（无历史数据）

VM 启动时 `G1Policy::init()`（g1Policy.cpp:92）调用 `update_young_list_max_and_target_length()`。所有 analytics 序列为空——G1Analytics 用硬编码默认值：

| 预测项 | 默认值 |
|--------|--------|
| 拷贝成本 | 0.000009~0.00006 ms/byte |
| 固定开销 | 5.0 ms |
| 存活率 | 0.4 / age |
| RSet 扫描成本 | 0.0015~0.01 ms/card |

`G1YoungLengthPredictor::will_fit(young_length)` 对每个候选值检查：
1. 空间足够：`young_length < free_regions - reserve`
2. 暂停不超：`base_time + copy_time + other_time ≤ MaxGCPauseMillis`
3. 拷贝安全余量：`safety_factor = (100/G1ConfidencePercent) * (100+TargetPLABWastePct)/100`

二分搜索在 `[G1NewSizePercent%堆, G1MaxNewSizePercent%堆]` 范围内找到最大值。

### A.2 运行时（每次 GC 后）

`record_collection_pause_end()`（g1Policy.cpp:710）把真实数据喂进 analytics：分配速率、RS 长度、拷贝时间、pending cards。序列越长，EWMA 预测越准。`G1YoungRemSetSamplingThread` 每 300ms 采样 RS 实际大小，超标时用 ×1.1 容错重新算——可能触发提前 GC。

---

## 附录 B: TLAB/Region 分配故障详情

### B.1 TLAB pointer bump

`_top + size ≤ _end` → `_top += size`，约 10 条 CPU 指令，无锁。

### B.2 TLAB 空间不够——不是每次都退休

G1 用 `_refill_waste_limit`（TLAB 大小 / 64）做容差：
- 剩余 > waste limit → **不退休**，在 Eden Region 上用 CAS 分配
- 剩余 ≤ waste limit → 退休 TLAB（填 dummy filler object + 清零指针），申请新的

每次走 CAS 路径时 waste limit 递??? 4。

### B.3 Region 也满了——三级挽救

| 级别 | 机制 | 条件 |
|------|------|------|
| 第一级 | `attempt_retained_allocation()` | retained region 还有空间 |
| 第二级 | `attempt_allocation_locked()` → retire → `new_mutator_alloc_region()` | young count < target |
| 第三级 | `attempt_allocation_force()` | GCLocker 活跃 + young count < max |
