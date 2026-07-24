# G1 Young GC：Evacuation 周期

> **本文定位**：ch11 运行时系列第一篇。沿单一线索讲完一次 Young GC 暂停的全部阶段——为什么要做、每一步做什么、源码在哪。
>
> **前置概念**：Eden / Survivor / Old 角色、STW 和 safepoint、Evacuation（搬活不删死）、GC Roots（ch11/07）。
>
> **阅读提示**：读完你能回答"一次 Young GC 从触发到结束，JVM 做了哪些事、每件事为什么重要"。细节（TLAB 分配、young target 算法）在附录。

---

## 1. 为什么要做 Young GC——eden 满了

mutator 线程（应用线程）不停地创建对象。每个线程有自己专属的 TLAB（线程本地分配缓冲区），分配对象时只做一次指针碰撞——约 10 条 CPU 指令，非常快。

但 TLAB 总有用完的时候。用完 → 找 MutatorAllocRegion（当前 Eden Region）要一块新空间 → 如果 Eden Region 也被切光了 → 需要一个新的 Eden Region。

G1Policy 控制着"堆里最多能有多少 Young Region"（§3.1 的 `_young_list_target_length`）。当 Eden Region 的数量已经达到这个上限，就无法再从一个新区了——**分配失败，触发 GC**。

```cpp
// g1CollectedHeap.cpp:459-460
do_collection_pause(word_size, gc_count_before, &succeeded,
                    GCCause::_g1_inc_collection_pause);
```

VMThread 发起 safepoint，所有 mutator 停下来。进入 `do_collection_pause_at_safepoint()`（g1CollectedHeap.cpp:2793）——下面六个阶段。

---

## 2. 六步走完一次 Young GC

```
┌─ 阶段 1: CSet 选择 ──────── 确认本次回收哪些 Region
│  finalize_collection_set()
│
├─ 阶段 2: Pre-Evacuation ── 准备工作：合并 dirty card + 重置 scan state
│  prepare_for_oops_into_collection_set_do()
│
├─ 阶段 3: Evacuation（核心）─ GC Workers 并行搬活对象
│  3a. Root 扫描 → 3b. RSet 扫描 → 3c. 搬活+追踪引用
│
├─ 阶段 4: Post-Evacuation ── 引用处理 + 弱引用 + 字符串去重
│  process_discovered_references()
│
├─ 阶段 5: Free CSet ──────── 空 Region 归还 FreeList
│  G1FreeCollectionSetTask (并行)
│
├─ 阶段 6: 启动下一个 CSet ─── 本轮 Survivor → 下一轮 CSet
│  start_new_collection_set()
```

---

## 3. 阶段 1: CSet 选择——确认回收清单

**做什么**：决定本次 GC 要回收哪些 Region。

Young GC 的 CSet = **所有 Eden Region + 所有 Survivor Region**（全量加入，无需选择）。这些 Region 在 GC 之前已经被增量地（incremental）加入 CSet——每分配一个新 Eden Region，它就自动进入 CSet 数组。GC 开始时 `finalize_collection_set()` 只是**锁定**这个集合，不再追加：

```cpp
// g1CollectedHeap.cpp:2944
g1_policy()->finalize_collection_set(target_pause_time_ms, &_survivor);
  └─ collection_set->finalize_young_part(target_pause_time_ms, survivor)
       ├─ finalize_incremental_building()      // Active→Inactive，锁定增量计数器
       ├─ init_region_lengths(eden, survivor)   // 记下各多少 Region
       ├─ survivors->convert_to_eden()          // 上一轮 Survivor 变成本轮 Eden
       └─ 返回剩余时间（Young-only 不调 finalize_old_part）
```

**为什么先做这个**：后续所有阶段都需要知道"回收谁"——Root 扫描看哪些根指向 CSet、RSet 扫描看谁引用了 CSet、搬运时要把 CSet Region 里的活对象搬走。

**附录 A** 讲了 `_young_list_target_length` 怎么决定"堆里该有多少 Eden"——它在 GC 之间持续调控，影响本次 CSet 的大小。

---

## 4. 阶段 2: Pre-Evacuation——最后准备

**做什么**：搬活对象之前，把"脏卡"信息准备好。

```cpp
// g1CollectedHeap.cpp:4039-4058
void G1CollectedHeap::pre_evacuate_collection_set() {
    _hot_card_cache->set_use_cache(false);           // 关闭热卡缓存
    g1_rem_set()->prepare_for_oops_into_collection_set_do();
}
```

`prepare_for_oops_into_collection_set_do()`（g1RemSet.cpp:511-516）做了两件事：

1. **`concatenate_logs()`**——把所有 mutator 线程还没提交的 dirty card buffer 拼到全局队列。这些 buffer 里记录了"哪个 card 被写过了"——mutator 在 GC 开始前还在写对象，最后一个 buffer 可能还没提交，必须赶在 GC 扫描之前合并进来，否则会漏掉引用。

2. **`_scan_state->reset()`**——为每个 Region 重算 `_scan_top[i]`（ch11/06 §2.3 讲过的机制）：不在 CSet 中的 old/humongous Region 设 `top()`（需要扫描它的 card），CSet 内的 Region 设 `bottom()`（不需要——CSet 内部引用在 evacuation 时自然处理）。

**为什么先做这个**：阶段 3 里 GC Workers 要去扫描 RSet（通过 `_scan_top`）和处理 dirty card（通过全局队列里的 buffer）。这些数据在这之前必须准备好。

---

## 5. 阶段 3: Evacuation——核心搬运

GC Workers 并行执行 `G1ParTask`（g1CollectedHeap.cpp:3185），每个 Worker 走三个阶段：

```cpp
void work(uint worker_id) {
    G1ParScanThreadState* pss = psss->state_for_worker(worker_id);

    // 子阶段 a: Root 扫描
    _root_processor->evacuate_roots(pss, worker_id);

    // 子阶段 b: RSet 扫描
    _g1h->g1_rem_set()->oops_into_collection_set_do(pss, worker_id);

    // 子阶段 c: 工作窃取——追踪所有"搬出来的对象"的引用
    G1ParEvacuateFollowersClosure evac(_g1h, pss, _queues, &_terminator);
    evac.do_void();
}
```

### 5a. Root 扫描——从"根"出发找到第一批活对象

**为什么从 Root 开始**：GC 判断对象是否存活的标准是"从 GC Roots 出发，沿引用链能否到达"。如果连 Root 都到不了的对象就是死的——不需要处理。

Root 扫描（`evacuate_roots`, g1RootProcessor.cpp:78）依次遍历所有 5 类 Root（ch11/07 §5 详细讲过）：

```
线程栈 → JNI handles → 系统类 → CodeCache → StringTable
```

**每种 Root 扫描的实质**：找到每一个指向 CSet Region 内对象的引用 → 发现这个对象"是活的" → **立刻把它搬走**。

具体怎么搬——GC Worker 调用 `G1ParCopyClosure::do_oop()`：
1. 读引用 → 指向 CSet 内的对象 A
2. 检查 A 的 mark word：如果已经被搬过（mark word 低 2 位 = 11，是 forwarding pointer），直接更新引用到新地址
3. 如果没搬过：在 Survivor/Old Region 中分配空间 → memcpy 整个对象过去 → 把 A 的旧地址压入 Worker 的工作队列（后续 5c 会追踪它的引用字段）→ 在 A 的旧位置写 forwarding pointer（mark word = 新地址 | 11）

### 5b. RSet 扫描——找到"谁引用了 CSet"

Root 扫描只覆盖了从 JVM 根出发的引用链。但 CSet 里的对象还可能被**不在 CSet 中的 old/humongous Region** 引用——Root 扫描完全看不到这些引用（因为 old Region 不是根）。

**RSet 就是解决这个问题的**——每个 Region 的 RSet 记录了"哪些其他 Region 的哪些 card 引用了我"（详见 ch11/06）。扫描 RSet = 遍历 CSet Region 的 RSet → 找到来自 old Region 的入引用 → 同样调用 `G1ParCopyClosure::do_oop()` 搬对象。

`oops_into_collection_set_do()`（g1RemSet.cpp:506）分两步：
1. `update_rem_set()`——处理那些 refinement 线程还没来得处理的 dirty card，先更新 RSet
2. `scan_rem_set()`——扫描所有 CSet Region 的 RSet，Worker 通过原子操作抢 card block 并行扫描

### 5c. 工作窃取——追踪到底

5a 和 5b 搬的对象被推进每个 Worker 的队列。但这些对象的**引用字段**还指向别的对象——那些对象可能也需要搬。

`G1ParEvacuateFollowersClosure::do_void()`（g1CollectedHeap.cpp:3157）：
```cpp
pss->trim_queue();                    // 先排空自己的队列
do {
    pss->steal_and_trim_queue(queues());  // 从别人那偷活
} while (!offer_termination());           // 直到活儿全干完
```

**工作窃取**：每个 Worker 处理完自己的队列后，从其他 Worker 的队列里偷作业。被偷到的作业又是一个引用 → 同样走 `G1ParCopyClosure::do_oop()` → 搬对象 → 产生新的引用 → 推队列 → 继续偷。BFS 扩散，直到整棵引用树遍历完。

**为什么需要这个阶段**：5a 和 5b 只覆盖了"直接引用到的对象"——但 A 引用了 B、B 引用了 C、C 是活的——如果不追踪，B 和 C 会被漏掉。工作窃取保证了"只要有一个 Worker 还不够忙，就继续找活干"，直到跟踪完所有引用。

---

## 6. 阶段 4: Post-Evacuation——引用处理和收尾

**做什么**：所有对象都搬完了，还有"软/弱/虚/终"引用需要处理。

```cpp
// g1CollectedHeap.cpp:4099-4166
void G1CollectedHeap::post_evacuate_collection_set(...) {
    // 1. RSet 扫描收尾
    g1_rem_set()->cleanup_after_oops_into_collection_set_do();

    // 2. 引用处理——Soft/Weak/Final/Phantom
    process_discovered_references(per_thread_states);

    // 3. 弱引用清理——StringTable/ResolvedMethodTable
    WeakProcessor::weak_oops_do(...);

    // 4. 字符串去重
    G1StringDedup::unlink_or_oops_do(...);

    // 5. 恢复热卡缓存 + re-dirty logged cards
    _hot_card_cache->reset_hot_cache();
    redirty_logged_cards();
}
```

**为什么放在这里**：引用处理需要知道"referent 还活着吗"——必须在所有对象都搬完、整个对象图都追踪完之后才能回答。

**为什么清理 StringTable**：intern 的字符串如果没人引用了，对应的 StringTable 条目也需要清掉——这也是 GC 的一部分，但不是"搬对象"，属于弱引用的清理范畴。

---

## 7. 阶段 5: Free CSet——搬完收地

**做什么**：CSet 里的所有活对象都被搬走了（阶段 3），空 Region 还给 FreeList。

`free_collection_set()`（g1CollectedHeap.cpp:2980）创建并行的 `G1FreeCollectionSetTask`：

**串行部分**（一个 Worker 持 `OldSets_lock` 执行）：
- 遍历 CSet 每个 Region
- 如果 `!r->evacuation_failed()` → `free_region()` → Region 变 Free
- 如果 `r->evacuation_failed()` → `r->set_old()` → 留在 old set（搬不走就当 Old）

**并行部分**（所有 Worker）：
- `r->rem_set()->clear_locked()`——清空 RSet（Region 要重用了，旧 RSet 不能留）
- 清空 hot card cache 计���

最后 `prepend_to_freelist()` 在 `FreeList_lock` 保护下把局部 free list 合并到全局 `_hrm._free_list`。

**evacuation_failed 是什么**：如果 Survivor/Old Region 空间不足，对象搬不走——这个 Region 不能释放（里面还有活对象），只能标记为 Old 留在堆里。反复出现会最终触发 Full GC。

---

## 8. 阶段 6: 启动下一个 CSet——本轮结束，下轮开始

```cpp
// g1CollectedHeap.cpp:2784-2791
void G1CollectedHeap::start_new_collection_set() {
    collection_set()->start_incremental_building();   // _inc_build_state = Active
    clear_cset_fast_test();                           // 清空 in_cset_fast_test 位图
    g1_policy()->transfer_survivors_to_cset(survivor()); // Survivor → 新 CSet 种子
}
```

**关键**：本轮 GC 存活下来的对象在 Survivor Region 中。这些 Survivor Region 在 GC 结束后就被加入**下一轮**的 CSet——因为下一次 Young GC 时它们就是"本次要回收的 survivor 部分"。

一轮完整的 Young GC 到这里结束。Safepoint 解除，mutator 恢复运行。GC 日志显示的时间就是 T5 到 T11（不含 TTSP）。

---

## 9. 完整时间线（T4-T11）

```
T4: safepoint → 所有 mutator 停下
T5: finalize_collection_set()         → CSet = {Eden_1, ..., Survivor_1}
T6: pre_evacuate()                    → dirty card merge + scan_state reset
T7: evacuate:
    ┌Worker 0: evacuate_roots → 发现引用 → 搬第一批 → 
    │         oops_into_cset_do → RS 扫描 → 搬更多
    │         steal_and_trim → 偷活 → 继续搬 → 空
    ├Worker 1,2,... 并行推进
    └－ 直到所有队列空
T8: post_evacuate()                   → 引用处理 + WeakProcessor + StringDedup
T9: free_collection_set()             → Eden_1,Eden_2... → FreeList
T10: start_new_collection_set()        → Survivor → 新 CSet
T11: VMThread::end()                   → mutator 恢复
```

---

## 10. 总结——读 GC 日志时的对应关系

| GC 日志行 | 对应本文 |
|-----------|---------|
| `Pause Young (Normal) (G1 Evacuation Pause)` | §1 触发（Normal = YoungOnlyGC） |
| `128M->64M(1024M)` | §7 Free CSet 后的堆使用量变化 |
| `8.234ms` | 不含 TTSP 的纯 GC 工作时间（T5→T11） |

---

## 附录 A: `_young_list_target_length` 怎么算

G1Policy 通过 `_young_list_target_length` 控制堆里该有多少 Young Region。计算分两种情况：

### A.1 初始值（无历史 GC 数据）

VM 启动时 `G1Policy::init()`（g1Policy.cpp:92）调用 `update_young_list_max_and_target_length()`。此时所有 analytics（预测数据的滑动窗口序列）为空——G1Analytics 用硬编码默认值代替：

| 预测项 | 默认值 |
|--------|--------|
| 拷贝成本 | 0.000009~0.00006 ms/byte |
| 固定开销 | 5.0 ms |
| 存活率 | 0.4 / age |
| RSet 扫描成本 | 0.0015~0.01 ms/card |
| RS 长度 / 分配速率 | 0（空序列） |

这些默认值代入 `G1YoungLengthPredictor` 的二分搜索，算出初始 target（4GB 堆约 25 个 Region）。

### A.2 运行时（每次 GC 后）

`record_collection_pause_end()`（g1Policy.cpp:710）把本次 GC 的真实数据喂进 analytics：

```
分配速率 = eden_region_count / app_time_ms
卡片扫描成本 = scan_time / cards_scanned
拷贝成本     = copy_time / bytes_copied
RS 长度      = _max_rs_lengths
积压卡片数   = _pending_cards
```

序列越长，EWMA 预测越准。`G1YoungRemSetSamplingThread` 还每 300ms 采样 RS 实际大小，超标时触发提前修正（×1.1 容错重新算）。

### A.3 二分搜索

`G1YoungLengthPredictor::will_fit(young_length)` 对每个候选值检查：
1. 空间：`young_length < free_regions - reserve`
2. 暂停：`base_time + copy_time + other_time ≤ MaxGCPauseMillis`
3. 拷贝安全：有足够剩余空间装搬来的活对象

上下界：`G1NewSizePercent`（5% 堆）~ `G1MaxNewSizePercent`（60% 堆）。

---

## 附录 B: 分配故障——从 TLAB 到 GC 的完整路径

本节展开 §1 中被压缩的"为什么分配会失败"的细节。

### B.1 TLAB 的 pointer bump

`_top + size ≤ _end` → `_top += size`，约 10 条 CPU 指令，无锁。

### B.2 TLAB 用完后——不是每次都退休

G1 用 `_refill_waste_limit`（TLAB 大小 / 64）做容差：
- 剩余 > waste_limit → **不退休**，直接在 Eden Region 上用 CAS 分配（绕过 TLAB，对象仍在 Eden）
- 剩余 ≤ waste_limit → 退休 TLAB，申请新的

每次走 CAS 路径时 waste limit 递增 4，逐步扩大容忍度。

### B.3 TLAB 退休做什么

`clear_before_allocation()`（threadLocalAllocBuffer.cpp:43）：
- 剩余空间填 dummy filler object（GC 遍历 Eden 时不撞空洞）
- 记入线程分配量
- 指针清零——空间不"捐回"，TLAB 本就属于 Eden

### B.4 Region 也满了——三级挽救

| 级别 | 机制 | 条件 |
|------|------|------|
| 第一级 | `attempt_retained_allocation()` | 上一轮保留的 retained region 还有空间 |
| 第二级 | `attempt_allocation_locked()` → retire → `new_mutator_alloc_region()` | young count < target |
| 第三级 | `attempt_allocation_force()` | GCLocker 活跃 + young count < max |

Region 没有 `_refill_waste_limit`——退休时剩余空间填 dummy，通过 `should_retain()` 判断是否保留。
