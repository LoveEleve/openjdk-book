# PROMPT: 请撰写 06-ConcurrentMark-Core.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**G1 并发标记核心算法 — do_marking_step 逐段走读**

### 核心故事线（禁止做源码翻译机！）

你已经读了 05（SATB Barrier：前屏障全链路 + completed_buffers 消费者协议），知道 mutator 在引用覆盖前把旧值抢救到 SATB buffer，满后 CAS 入队到 `_completed_buffers_head`。本文要回答的是：**这些 buffer 到底被谁、以什么顺序、在什么时间限制下消费的？`do_marking_step()` 这个 ~200 行的函数是整个并发标记的引擎——它同时管理 SATB drain、local/global mark stack、Region 扫描(finger CAS Claim)、工作窃取和时间片控制。**

**★ 和 05 的边界**：05 深挖了 SATB buffer 从 pre-barrier → enqueue → CAS 入队 → completed_buffers_head 的全链路。本文聚焦**消费端**——`drain_satb_buffers()` 在 `do_marking_step()` 中的调用位置、为什么是最高优先级、和 local/global drain 的精确顺序。

**★ 和 07 的边界**：本文聚焦 G1CMTask 内部的单轮 `do_marking_step()` 执行逻辑。07（ConcurrentMark-Phases）聚焦跨阶段的宏观调度——Initial Mark / Remark / Cleanup 各阶段做了什么、怎么衔接、liveness 数据怎么流转到 Mixed GC。本文不讲"Remark 为什么需要 STW"（那是 05 §五 和 07 的职责），只讲 `do_marking_step()` 本身的执行模型。

**❓ 如果并发标记没有时间片控制，会发生什么？**

```
没有 regular_clock_call 的 G1 并发标记：

  do_marking_step 一进入主循环就停不下来：
    → 扫描 Region → 发现更多灰色对象 → drain → 扫描 → ...
    → 如果堆很大（8GB=2048 Regions），一轮可能耗时 50-200ms
    → Mutator 在这期间仍然在运行 → 产生新的 SATB buffer
    → SATB buffer 堆积 → _completed_buffers_num 飙升
    → 标记线程没有机会停下来 drain SATB → 灰色对象越积越多
    → ★ SATB buffer 中的对象被标记线程"遗忘" → Remark 阶段要处理海量 residual buffer
    → Remark STW 暂停从毫秒级变成秒级 → 灾难

  有 regular_clock_call：
    → 每扫描一定量对象/卡后 → 检查时间片 + SATB buffer 积压
    → 超时 → 设置 _has_aborted → do_marking_step 退出
    → 下一轮 do_marking_step 开始时 → 先 drain SATB → 再继续扫描
    → ★ 这样可以保证 SATB buffer 不会无限堆积
    → Remark 只需要处理最后一轮未 drain 的少量 buffer

本质：regular_clock_call 把"一个无限大的标记任务"切成了"可控的时间片"，
      在每片的边界强制 drain SATB，防止积压。
```

**★ 为什么 SATB drain 优先级最高？——从灰色引用链完整性证明（不是效率问题）：**

```
do_marking_step 的 drain 顺序证明（为什么不能颠倒）：

  SATB buffer 中的 oop 不在任何现有灰色引用链上：
    → 这些 oop 是 mutator 覆盖引用时"抢救"下的旧值
    → 覆盖动作使它们在对象图中被"切断"了
    → ★ 它们没有任何灰色引用指向它们 → 不被标记线程的 BFS/DFS 发现

  ★ 如果先 drain local queue 再 drain SATB（错误顺序）：
    → local queue 中灰色对象 B 引用了对象 C
    → drain local → 标记 B → 标记 B 的所有子节点（包括 C）→ B 变黑
    → ★ 但 B 本身可能是"孤儿"的子节点——孤儿 O 在 SATB buffer 中
    → drain SATB → 孤儿 O 入链 → O 变灰 → 但 B 已经是黑的了
    → ★ B 不会被重新扫描 → O→B 的引用链中：O 灰，B 黑
    → 如果 B 内部还有被覆盖的引用指向 D → D 可能漏标
    → 这就是"灰色引用链断裂"——先 drain SATB 保证孤儿入链后再展开子节点

  ★ 为什么先 drain SATB 是正确的（从正确性出发，不是从效率出发）：
    → 先 drain SATB → 孤儿 O 被抢救 → O 变灰（push mark stack）
    → drain local queue → 孤儿 O 也在 local 中被展开 → O 的子节点被标记
    → ★ 灰色引用链始终完整：O(灰) → B(灰) → C(白→灰) → 全部被标记
    → 没有任何"灰引用指向黑对象"的悖论

  一句话：SATB drain 优先级最高不是效率问题——是 gray-chain integrity 问题。
  如果先 drain local，灰色引用链可能在 orphan 入链前断开，
  导致 orphan 标记后其子节点因"已黑"而不再被扫描。
```

---

### 完整的故事线

```
G1ConcurrentMarkThread 调度生命周期：
  并发标记何时启动？→ G1Policy 判定 Old 占用 ≥ IHOP → set_started()
  G1CMThread::run_service() 主循环 → 等待 → 收到信号 → 启动 CM workers

G1ConcurrentMark 全局结构（~1840B slowdebug）：
  _prev_mark_bitmap + _next_mark_bitmap（双缓冲）
  _global_mark_stack（灰色对象溢出栈）
  _finger（全局 CAS Claim 指针，Region 级工作分配）
  _cm_thread（G1ConcurrentMarkThread 调度线程）
  _task_queues（per-worker mark stack，支持 steal）

G1CMTask per-worker 结构（~392B slowdebug）：
  _task_queue（本 worker 的 mark stack，G1TaskQueue）
  _finger（本地扫描指针，Region 内推进）
  _curr_region（当前正在扫描的 Region）
  _time_target_ms（本轮时间片目标）
  _draining_satb_buffers（防止 repeat abort 的标志）

★★★ do_marking_step() 四段逐行走读：

  ★ 注意：regular_clock_call 不是独立段——它作为"跨段探针"穿插在段2（主循环）+ 段3（steal）中
  ★ do_marking_step 在 CM worker 中被**反复调用**（非单次）——每轮消耗 ~10ms 时间片，
    退出后 CMThread 调度下一轮 do_marking_step，finger/_curr_region 保持→从断点继续

  段1: 启动 drain — 为什么先 SATB 再 local 再 global？
    drain_satb_buffers()      ★ 05 §五：抢救孤儿
    drain_local_queue(true)    ★ 局部灰色 → _next_mark_bitmap
    drain_global_stack(true)   ★ 全局溢出对象
    
  段2: 主循环 — bitmap::iterate + 穿插 regular_clock_call
    while (_curr_region != NULL && !has_aborted()):
      update_region_limit()   ★ 为什么重读 _top？
      bitmap::iterate()        ★ 为什么只扫 TAMS 以下？
        → iterate 内部/每完成一个 object 后 → regular_clock_call() ★ 跨段探针
      claim_region()           ★ 全局 finger CAS 协议
    
  段3: 收尾 — 再 drain + steal（也穿插 regular_clock_call）
    drain_satb_buffers()       ★ 减少 Remark 工作
    drain_local_queue(false)   
    drain_global_stack(false)
    steal loop                 ★ 每轮 steal 后 → regular_clock_call()
      → termination protocol  ★ ParallelTaskTerminator
    
  跨段机制: regular_clock_call — 时间片控制 + SATB 积压检测
    检查条件：timeout？SATB buffer 积压？
    → 设置 _has_aborted → do_marking_step 退出
    → 下一轮 do_marking_step 从 _curr_region/_finger 断点继续
```

---

### 核心叙事线（15 个"为什么"问题，每个必须有源码回答）

**❓ 全局结构层**

1. **❓ 为什么 G1ConcurrentMark 需要双缓冲 bitmap（_prev_mark_bitmap / _next_mark_bitmap）？单 bitmap 不行吗？什么时候 swap？swap 的精确时机在哪个方法里？**

   **子问题**：
   (a) prev/next bitmap 各自的生命周期是什么？
   (b) bitmap swap 发生在哪个阶段？（Remark 完成后，Cleanup 之前）
   (c) swap 之后 prev bitmap 表示什么？next bitmap 表示什么？
   (d) ★ 如果不 swap 而是清空 prev 并复用 → 丢失上一轮标记结果 → Mixed GC 无法知道哪些 Old Region 有垃圾
   (e) G1CMBitMap 的大小：`HeapRegionSize * max_regions / 8 bits` = 4MB * 2048 / 8 = 1MB per bitmap
   (f) ★ 底层实现：`_mark_bitmap_1` 和 `_mark_bitmap_2` 是两个固定的 G1CMBitMap 对象，
        `_prev_mark_bitmap` 和 `_next_mark_bitmap` 是指向它们的指针，swap 时只交换指针（不拷贝数据）

1b. **❓ ★★★ TAMS 已经标记了"标记开始时的边界"，为什么还需要 per-object bitmap？**

   **要求**：
   (a) TAMS 是 per-Region 的**边界线**：只告诉你"这条线以上保守存活，这条线以下需要判断"
   (b) bitmap 是 per-object 的**状态机**：区分 TAMS 以下的每个对象是 white(0)/gray(1)/black(1+已遍历)
   (c) ★ 如果只有 TAMS 没有 bitmap → TAMS 以下所有对象都"可能是垃圾也可能不是" → 无法区分 → 要么全回收（错）要么全保留（无用功）
   (d) ★ bitmap 是 GC 的 to-do list：gray bit=1 表示"这个对象被发现为活但它的引用还没展开"，finger 推进到该位置时展开它
   (e) 类比：TAMS 是地图上的"省界"，bitmap 是"省内每个镇的访问状态"
   (f) G1ConcurrentMark 的 hpp 中 `_mark_bitmap_1` / `_mark_bitmap_2` 结构 + `_prev_mark_bitmap` / `_next_mark_bitmap` 指针

2. **❓ G1CMTask 为什么是 392B（slowdebug build）？每个字段在 do_marking_step 的哪个段被使用？——hot/cold 字段分析**

   **注意**：392B 是 slowdebug build 下的预期值，product build 中无 `#ifdef ASSERT` 字段会更小。

   **子问题**：
   (a) 逐字段标注：哪些是 hot（每次 do_marking_step 都访问）、哪些是 cold（只在特定阶段访问）
   (b) _curr_region 的生命周期：什么时候设置？什么时候清空？为什么必须是 per-task 而不是共享？
   (c) _time_target_ms 从哪里来？谁设定的？为什么不同 worker 的 time_target 可以不同？

**❓ 调度层**

3. **❓ G1ConcurrentMarkThread 什么时候启动并发标记？什么时候 sleep？为什么不在 GC pause 中直接启动？**

   **子问题**：
   (a) `run_service()` 的等待循环：`wait_for_universe_init()` + `wait(ConcurrentGCThread::_should_terminate ? ... : ...)`
   (b) G1Policy 判定 Old 占用 ≥ IHOP → `_cm_thread->set_started()` → `ConcurrentGCThread::notify_all()`
   (c) 为什么不能用 `_cm->do_marking()` 在线程池中启动？（CM 需要专用的调度线程管理暂停/恢复）
   (d) SuspendibleThreadSet：并发标记线程怎么被 safepoint 暂停？
   (e) CMCreateMarkingTask：每个 CM worker 如何在一个 G1CMTask 上运行？

4. **❓ 并发标记 worker 数量是怎么确定的？和 GC worker（ParallelGCThreads）什么关系？**

   **子问题**：
   (a) `ConcGCThreads` 默认推导：`max((ParallelGCThreads + 2) / 4, 1)`
   (b) ★ 为什么是 1/4？并发工作可以跑得慢，但不能抢占 mutator CPU
   (c) `_worker_id_offset`：CM worker 和 GC worker 的 ID 不冲突 —— 怎么做到的？

**❓ do_marking_step 走读层（★★★★★ 核心）**

5. **❓ 段1：为什么先 drain SATB 再 drain local 再 drain global？——精确的依赖关系链**

   **子问题**：
   (a) SATB buffer 中的 oop 是"孤儿"→ 不先 drain → 永远不会有灰色引用指向它们（05 §五 提及，本文严谨证明）
   (b) local queue 依赖 SATB drain 的结果（SATB drain 可能 push 新灰色对象到 local queue）
   (c) global stack 是溢出的灰色对象 → local drain 后可能有更多溢出 → 先 local 再 global
   (d) ★ 如果颠倒顺序会怎样？（用并发时间线走读漏标场景）

6. **❓ 段2：G1CMBitMap::iterate() 的逐行走读 — 为什么只扫 TAMS 以下？**

   **子问题**：
   (a) `iterate(&cl, MemRegion(from, to))` 的逐行走读：从 `from` 到 `to`，找 marked bit
   (b) ★ 为什么 `from = _finger`，`to = _region_limit`？（finger 是"上次扫到哪里"，不重复扫）
   (c) ★ `_region_limit` 是什么？为什么 `update_region_limit()` 要重读 `_top`？
       → Evacuation GC 可能在并发标记期间移动对象 → _top 变了 → 扫描范围要更新
   (d) 如果 _top 降低了（GC 复制走了对象）→ 被复制的对象已经被处理 → 不需要再扫
   (e) ★ TAMS 以下 vs 以上的标记策略：
       TAMS 以下 → bitmap gray → 需要 iterate → push gray objects
       TAMS 以上 → implicitly live → 不需要 scan bitmap → 保守标记为活

7. **❓ 段2：Finger CAS Claim 协议 — 为什么多 worker 用 CAS 争 region？为什么不是 work stealing 分 region？**

   **子问题**：
   (a) `_finger`（全局）是 `HeapWord* volatile` → 用 `Atomic::cmpxchg` 推进
   (b) `claim_region(worker_id)` 的完整走读 → CAS finger → 更新 _curr_region + _region_limit
   (c) ★ 为什么 CAS 而不是 steal？（扫描进度不可分割：一个 Region 必须由一个 worker 完整扫描）
   (d) ★ 为什么 finger 可以跳过大段未标记 region？
       G1CMBitMap::get_next_marked_addr()：找到下一个 marked bit → 跳过一整块未标记区域
   (e) Humongous Region 的特殊处理：只扫一次（region bottom 的 marked bit）

8. **❓ 段2：MarkStack 溢出 → task_queue → overflow rebuild 路径**

   **子问题**：
   (a) `_global_mark_stack`（G1CMMarkStack）是全局共享的灰色对象栈——所有 worker 的 gray objects 都 push 到这里
   (b) ★ 溢出机制不是 per-push 的 fallback，而是批量转移：
       → global stack push 失败 → worker 从 global stack pop 一批对象到自己的 `_task_queue`
       → 这样既腾出了 global stack 空间，又保留了待处理的灰色对象
       → 如果 task_queue 也满了 → `set_has_overflown()` → 标记不完整 → Remark 兜底
   (c) `_task_queue`（G1TaskQueue）是 per-worker 无锁队列 → 支持 push/pop/steal
   (d) `has_overflown()` 后怎么办？
       → 所有 workers 停止 → `_has_aborted` 全局设 true
       → Remark 阶段切换到单线程模式 → 从头开始全局重新标记（保证正确性）
       → 代价：Remark 暂停显著变长

9. **❓ 段3：为什么末尾要再 drain_satb_buffers + drain_local(false) + steal + termination？**

   **子问题**：
   (a) drain_satb_buffers：可能主循环期间 mutator 又产生了新的 SATB buffer → 尽早 drain 减少 Remark 负担
   (b) drain_local(false)：`partially=false` → 完全耗尽本地队列（不保留灰色对象给后续 steal）
   (c) steal：所有 region 都扫完了 → 没有新工作 → 从其他 task 偷 work
   (d) ★ steal 为什么用 `hash_seed` 随机选 victim？
       → 避免所有 worker 同时偷同一个 victim → 产生热点
       → hash_seed 初始化为 `worker_id + 17` → 每轮 steal 递增
   (e) ★ termination protocol：`ParallelTaskTerminator` 协调所有 worker 的终止判定
       → 每个 worker 宣布"我没有工作"→ 等待 → 如果期间有新工作被产生（steal）→ 取消终止
       → 所有 worker 都宣布无工作且经过 N 轮检查无人产生新工作 → 全局终止
       → 这和 Young GC 的终止协议同源（`ParallelTaskTerminator`），
          但 CM 有额外的时间片 abort 作为前置终止条件

10. **❓ 跨段机制：regular_clock_call — 时间片怎么做到毫秒级自适应？超时后 finger 怎么恢复？**

    **子问题**：
    (a) `_time_target_ms` 的计算公式：`G1ConcMarkStepDurationMillis - diff_prediction_ms`
        → 其中 `diff_prediction_ms` 是 `G1Analytics` 的运行平均预测器，
           从 `_marking_step_diffs_ms` 序列中学习"本 worker 历史超时偏差"
        → 源码（`g1ConcurrentMark.cpp:2816`）：`_time_target_ms = time_target_ms - diff_prediction_ms`
    (b) `G1ConcMarkStepDurationMillis` 默认 = **10ms**（`g1_globals.hpp:72`，非 100ms）
        → 每个 worker 独立获得 10ms - 自身历史超时偏差 = 自适应时间片
        → ★ 不同 worker 的 _time_target_ms 不同（各自的 diff_prediction 不同）
    (c) `regular_clock_call()` 内部：`elapsed > _time_target_ms` → `set_has_aborted()`
    (d) ★ 为什么检查 SATB buffer 积压？`_draining_satb_buffers` 标志的作用
        → 如果 SATB buffer 积压严重（`completed_buffers_num > threshold`），
          即使时间未超也要 abort → 先 drain SATB 防止堆积
        → 但如果 `_draining_satb_buffers == true`（正在 drain）→ 跳过此检查（避免重复 abort）
    (e) abort 后下一轮重启：`do_marking_step` 重新调用 → `_curr_region` 还在 → `_finger` 还在 → 从上次断点继续
    (f) ★ 如果 region 被 GC 移动了怎么办？→ `update_region_limit()` 重读 `_top`
        → 如果 Region 已被回收（`is_humongous` 且不匹配）→ `giveup_current_region()` → 重新 claim

**❓ 面试层**

11. **❓ G1 并发标记的"并发"到底是什么意思？和"并行"有什么区别？**

    **要求**：
    (a) 并发（concurrent）= 标记线程与 mutator 同时运行（不需要 STW）
    (b) 并行（parallel）= 多个标记线程同时工作
    (c) ★ G1 的并发标记是"并发 + 并行"的：多个 CM workers 之间并行，它们整体与 mutator 并发
    (d) 对比 CMS 的并发标记：也是并发+并行，但 G1 用 SATB 而 CMS 用 IU
    (e) 对比 Full GC 的标记：只有并行，没有并发（STW）

12. **❓ 如果 mark stack 溢出了，并发标记的结果还正确吗？**

    **要求**：
    (a) Overflow → 所有 tasks 的 `_has_aborted` 设为 true → workers 停止
    (b) Remark 阶段切换到全局单线程重新标记 → 保证正确性
    (c) 代价：Remark 暂停变长（因为要重建所有灰色对象）
    (d) 面试话术："overflow 不丢正确性，只增加 Remark 暂停时间"

13. **❓ 并发标记线程被 safepoint 暂停时，它的状态如何保存和恢复？**

    **要求**：
    (a) SuspendibleThreadSet::join() / leave()：线程声明自己"可暂停"
    (b) Safepoint 时 → STS yield → 线程停在安全检查点
    (c) Safepoint 结束后 → 线程恢复 → do_marking_step 从中断处继续
    (d) ★ `_curr_region` 和 `_finger` 在 safepoint 期间可能过时（GC 可能移动了 region）→ `update_region_limit()` 重新验证
    (e) 如果 region 被回收了 → `giveup_current_region()` → 重新 claim 下一个

14. **❓ 并发标记的 bitmap 和 Full GC 的 marker 是什么关系？如果 Full GC 发生在并发标记期间会怎样？**

    **要求**：
    (a) 并发标记用 `_next_mark_bitmap`（G1CMBitMap*，指向 `_mark_bitmap_1` 或 `_mark_bitmap_2` 之一）
    (b) Full GC 的 `G1FullGCMarker` 构造函数接收 `G1CMBitMap*` 参数——由调用方决定用哪个 bitmap（`g1FullGCMarker.hpp:75`）
    (c) ★ 重点：Full GC 开始时 abort 并发标记 → 设置 `_has_aborted` → CM workers 停止 → CM 不再操作 bitmap
    (d) Full GC 结束后 → 重新开始 CM cycle（从 Initial Mark 开始）→ bitmap 被清空重来
    (e) ★ 追问：如果不 abort CM 直接做 Full GC → 两个系统同时操作 bitmap → 数据竞争 → 标记结果不可信

---

### 和 05/07 的边界

- **05 §五**：SATB drain 在 do_marking_step 中的调用位置已简述 → 本文深挖 drain 优先级排序的完整证明 + drain_local/drain_global 的依赖关系
- **05 §三**：`apply_closure_to_completed_buffer` 的 MutexLock 取队协议 → 本文直接引用 `[05 §三]`
- **07 §X**：Remark 阶段为什么要 STW + cleanup 怎么计算 liveness → 本文只提一句"Remark 后续处理"，专注于 do_marking_step 本身

### 禁止行为

- ❌ 把 `do_marking_step()` 的 200 行代码全部贴出来"逐字翻译"——这是源码翻译
- ❌ 只说"regular_clock_call() 检查超时"——**必须回答：为什么会超时？time_target_ms 怎么计算的？**
- ❌ 只说"finger CAS Claim"——**必须回答：为什么多 worker 用 CAS 争 region 而不是 steal？finger CAS 协议为什么不会产生 ABA 问题？**
- ❌ 不说 overflow 的处理路径——overflow 后标记结果是否正确？
- ❌ 不说 bitmap swap 的精确时机和原因
- ❌ 不说 G1CMThread 的调度生命周期——它什么时候 sleep？什么时候 wake up？
- ❌ 把 05 的 SATB drain 再讲一遍——05 已经讲过了，本文引用即可

### 要求行为

- ✅ **★ 每节以"❓ 为什么..."开头**
- ✅ **★ 全文核心叙事线**：G1CMThread 调度 → G1CM 全局结构 → G1CMTask per-worker → do_marking_step 四段走读 → 时间片/steal/overflow
- ✅ **★ Mermaid 图 ≥4 张**：
  1. G1CMThread 调度生命周期状态机（Idle → Started → InProgress → Idle）
  2. do_marking_step 四段优先级链（SATB > local > global > scan > claim > steal）
  3. Finger CAS Claim 协议的并发时间线（2 workers 同时竞争 region）
  4. MarkStack overflow → task_queue → Remark rebuild 全路径
- ✅ **★ GDB 验证 ≥8 条**：
  1. sizeof(G1ConcurrentMark)（slowdebug ~1840B，验证所有字段偏移；product 更小）
  2. sizeof(G1CMTask)（slowdebug ~392B，ptype /o 验证字段偏移；product 更小）
  3. G1ConcurrentMarkThread::_state 状态转换（Idle/Started/InProgress）
  4. _finger 在 CAS Claim 前后的值变化（断点在 claim_region）
  5. SATB drain 前后 `_draining_satb_buffers` 的 true/false 切换
  6. regular_clock_call 触发 abort 的时机（-XX:G1ConcMarkStepDurationMillis=5 手动触发）
  7. _global_mark_stack push 失败 → overflow 路径
  8. bitmap swap 前后 prev/next 指针
- ✅ **★ 设计替代分析**：为什么 finger CAS 协议而不是 steal 协议分配 region？（扫描不可分割 vs work 可分割）
- ✅ **★ 和 05 的对比**：consumer 端的完整协议——SATB drain → local drain → global drain 的依赖关系和优先级证明
- ✅ **★ 交叉引用精确**：SATB drain → [05 §五]；G1TaskQueue → [03 §X]；G1Policy 启动 CM → [08 §X]
- ✅ **★ hot/cold 字段分析**：G1CMTask（slowdebug ~392B）的每个字段标注访问频率和所在阶段

---

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（G1 Region = 4MB，2048 Regions）
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- `-XX:ConcGCThreads=N` 控制并发标记线程数（默认 = `(ParallelGCThreads + 2) / 4`）

---

## 三、聚焦源文件（行号需 grep 验证）

| # | 文件 | 模块 | 核心函数/类 | 本文角色 |
|---|------|------|------------|---------|
| 1 | `g1ConcurrentMark.hpp` | gc/g1 | `class G1ConcurrentMark`(~1840B slowdebug)，`class G1CMTask`(~392B slowdebug)，`_finger`，`_next_mark_bitmap`，`_global_mark_stack`，`MarkStatsCache` | ★★★ 全局结构定义 |
| 2 | `g1ConcurrentMark.cpp` | gc/g1 | `do_marking_step()`（~200行），`drain_satb_buffers()`(L2620)，`claim_region()`，`regular_clock_call()`，`try_stealing()` | ★★★ 核心执行引擎 |
| 3 | `g1ConcurrentMarkThread.hpp/cpp` | gc/g1 | `class G1ConcurrentMarkThread`，`run_service()`，`State{Idle,Started,InProgress}` | ★★★ 调度线程生命周期 |
| 4 | `g1ConcurrentMarkBitMap.hpp/cpp` | gc/g1 | `class G1CMBitMap`，`iterate()`，`get_next_marked_addr()` | ★★ bitmap 扫描逻辑 |
| 5 | `g1ConcurrentMarkObjArrayProcessor.hpp/cpp` | gc/g1 | ObjArray 标记处理 — 当标记线程扫描到对象数组的 oop 时，通过 ObjArrayProcessor 批量处理元素引用，减少 per-element 的标记闭包调用开销 | ★ 数组对象标记优化 |
| 6 | `taskqueue.hpp/cpp` | gc/shared | `GenericTaskQueue`，`G1TaskQueue`，`steal()` | ★★ 工作窃取 + mark stack |
| 7 | `suspendibleThreadSet.hpp/cpp` | gc/shared | `SuspendibleThreadSet`，`join()`，`leave()` | ★ safepoint 暂停/恢复 |
| 8 | `g1BarrierSet.hpp/cpp` | gc/g1 | `SATBMarkQueueSet`，`drain_satb_buffers` 的调用 | ★ 引用 [05] |
| 9 | `satbMarkQueue.hpp/cpp` | gc/g1 | `SATBMarkQueueSet::apply_closure_to_completed_buffer` | ★ SATB 消费者协议 [05 §三] |
| 10 | `g1Policy.hpp/cpp` | gc/g1 | `G1Policy`，IHOP 判定 | ★ CM 启动触发点（引用 [08]） |
| 11 | `g1CollectedHeap.hpp/cpp` | gc/g1 | `G1CollectedHeap` | ★ 全局入口 |
| 12 | `concurrentGCThread.hpp/cpp` | gc/shared | `ConcurrentGCThread` 基类 | ★ CMThread 基类 |

> 以上行号均需在撰写前 grep 验证，不可直接引用。

---

## 四、文章结构（§〇 ~ §八 + 附录）

```
§〇 源文件清单（12 文件，标注模块归属 + grep 验证行号）

§一 ★ 全景 — G1 并发标记的系统视图
  ❓ G1 并发标记在 GC 全景中的位置是什么？
  1.1 G1 GC 周期模型：Young GC → Initial Mark → CM → Remark → Cleanup → Mixed GC
  1.2 ★ 并发标记的"并发 + 并行"模型：多 CM worker 并行，整体与 mutator 并发
  1.3 和 05 的衔接：SATB consumer 就是 CM worker → do_marking_step
  1.4 和 07 的衔接：本文聚焦单轮 do_marking_step，07 聚焦各阶段宏观调度

§二 ★★★ G1ConcurrentMark 全局结构（~1840B slowdebug）— 双缓冲 bitmap + finger + mark stack
  ❓ 为什么需要双缓冲 bitmap？prev/next 的语义和 swap 时机
  ❓ ★★★ TAMS 已经标记了边界，为什么还需要 per-object bitmap？
  2.1 G1ConcurrentMark 字段全景（~1840B slowdebug，product build 更小）— 逐字段标注 hot/cold
  2.2 ★ G1CMBitMap 结构：bitmap 大小 = RegionSize × max_regions / 8 bits
  2.3 Bitmap iterate() 算法：从 from 到 to 找 marked bit → 跳过未标记块
  2.4 ★ 为什么只扫 TAMS 以下？（TAMS 以上 implicitly live）
  2.5 ★ Finger CAS Claim 协议（全局 finger + 本地 finger 的区别）
  2.6 MarkStatsCache：per-task 的 Region liveness 缓存 → 避免重复 calc_gc_efficiency()

§三 ★★★ G1CMTask per-worker 结构（~392B slowdebug）— 字段 hot/cold 分析
  ❓ G1CMTask 为什么是 ~392B（slowdebug）？每个字段在哪个段被访问？
  3.1 字段全景：_curr_region / _finger(本地) / _task_queue / _time_target_ms
  3.2 ★ 字段 hot/cold 分析表（逐字段标注访问频率 + 所属阶段）
  3.3 _task_queue 和 _global_mark_stack 的关系（per-worker vs global）

§四 ★★ G1ConcurrentMarkThread — 并发标记线程调度
  ❓ 并发标记线程什么时候启动？什么时候 sleep？谁叫醒它？
  4.1 run_service() 主循环走读：wait → start → in_progress → idle
  4.2 Mermaid：State 状态机（Idle → Started → InProgress → Idle）
  4.3 ★ G1Policy 如何决定启动 CM：IHOP 阈值判定 → set_started() → notify
  4.4 SuspendibleThreadSet：CM worker 如何被 safepoint 暂停和恢复
  4.5 ★ ConcGCThreads 默认推导公式和原因

§五 ★★★★★ do_marking_step() 三段走读 + 跨段时间片机制
  ★ 前置理解：do_marking_step 被 CM worker 反复调用（非单次），每轮消耗自适应时间片
  
  ❓ 段1：为什么先 drain SATB 再 drain local 再 drain global？
    ★ 完整依赖关系证明（先抢救孤儿 → 产生灰色 → local 展开 → global 备份）
  ❓ 段2：Finger CAS Claim + bitmap::iterate + update_region_limit
    ★ 为什么重读 _top？（Evacuation GC 可能在 CM 期间移动对象）
    ★ regular_clock_call 穿插在此段中——每处理完一个 object 就检查超时
  ❓ 段3：末尾再 drain SATB + steal + termination
    ★ 为什么 hash_seed 随机选 victim？为什么 steal 而不是 CAS claim？
    ★ termination protocol 的 declare-wait-check 循环
  ❓ 跨段机制：regular_clock_call — 时间片自适应 + SATB 积压感知
    ★ _time_target_ms = G1ConcMarkStepDurationMillis - diff_prediction_ms
    ★ 超时后 finger/_curr_region 在下一轮 do_marking_step 中如何恢复
  
  5.1 Mermaid：do_marking_step 三段优先级链 + 跨段 time-check 时序图
  5.2 Mermaid：2 workers 并发 finger CAS Claim 时间线
  5.3 ★ Overflow 全路径：push → fail → batch-pop-to-task_queue → has_overflown → Remark rebuild

§六 ★ 面试问题合集
  Q1: G1 并发标记的"并发"和"并行"有什么区别？
  Q2: 如果 mark stack 溢出了怎么办？标记结果还正确吗？
  Q3: 为什么 SATB drain 优先级最高？
  Q4: regular_clock_call 如何保证毫秒级的时间片控制？
  Q5: Finger CAS Claim 为什么不产生 ABA 问题？  （★ 限定：单 marking cycle 内 finger 单调递增不后退）
  Q6: bitmap swap 做了什么？为什么需要双缓冲？
  Q7: 并发标记线程被 GC 暂停时，_curr_region 和 _finger 怎么处理？
  Q8: CM worker 数量和 GC worker 数量什么关系？

§七 GDB 验证 + 可证伪断言（≥8 条）
  断言 1: sizeof(G1ConcurrentMark)（slowdebug ~1840B，product 更小——验证所有字段偏移）
  断言 2: sizeof(G1CMTask)（slowdebug ~392B，ptype /o 验证字段偏移；product build 中 ASSERT 字段不存在因此更小）
  断言 3: G1ConcurrentMarkThread::_state 三态转换验证
  断言 4: _finger CAS Claim 前后值变化
  断言 5: _draining_satb_buffers 在 drain 前后切换
  断言 6: regular_clock_call abort 触发（调整 G1ConcMarkStepDurationMillis=5 手动触发，避免 1ms 导致频繁 abort-restart 循环影响调试）
  断言 7: _global_mark_stack overflow 路径
  断言 8: bitmap swap 前后 prev/next 指针
  断言 9: G1CMBitMap::iterate 的遍历范围（TAMS 以下）

§八 附录：关键 GDB 断点清单 + GC log 示例 + MarkStats 统计
```

---

## 五、交叉引用

| 引用点 | 本文位置 | 目标文档 |
|--------|---------|---------|
| SATB drain（consumer 端完整协议） | §五 段1 | `[05-SATB-Barrier §五]` |
| apply_closure_to_completed_buffer（MutexLock 取队） | §五 段1 | `[05-SATB-Barrier §三]` |
| G1TaskQueue / work steal 协议 | §五 段3 | `[03-YoungGC §X]` |
| G1Policy IHOP 启动 CM | §四 | `[08-MixedGC-Policy §X]` |
| Remark 阶段 STW 必要性 | §五 跨段机制 | `[05-SATB-Barrier §五]` + `[07-ConcurrentMark-Phases §X]` |
| Initial Mark 触发 + TAMS 设置 | §四 | `[07-ConcurrentMark-Phases §X]` |
| Cleanup 阶段 liveness 统计 | §二（bitmap swap） | `[07-ConcurrentMark-Phases §X]` |
| HeapRegion TAMS 概念 | §二 | `[01-HeapRegion §三]` |

---

## 六、写作要求

1. **★ 每节以"❓ 为什么..."开头**
2. **★ 设计替代分析**：Finger CAS Claim vs Steal 分配 region 的权衡（扫描不可分割 vs work 可分割）
3. **★ 可证伪断言 ≥8 条**（含 GDB 命令 + 预期输出）
4. **★ Mermaid 图 ≥4 张**：
   - CMThread 状态机
   - do_marking_step 四段优先级链
   - 2 workers 并发 Finger CAS Claim 时间线
   - MarkStack overflow → task_queue → Remark rebuild 全路径
5. **★ 和 05 的对比表**：05 的 SATB consumer vs 06 的完整 do_marking_step 调用链
6. **★ 源文件行号全部 grep 验证后再写**（不直接引用本文档中的行号）
7. **★ 和 05 不重复**：05 深挖了 SATB drain 的 buffer 协议 → 本文聚焦 do_marking_step 内部的调度、优先级排序、时间片控制
8. **★ 面试友好**：§六 面试问题合集 ≥8 个，每个都有一句话回答 + 展开讲解
9. **★ hot/cold 字段分析**：G1CMTask（slowdebug ~392B）的每个字段标注访问频率和所在阶段

---

## 七、输出格式

- Markdown 文件，命名为 `06-ConcurrentMark-Core.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/06-gc-memory/`
- 元信息头：标准环境 + 源文件清单（12 文件，行号 grep 验证）+ 前置依赖（已读 05/04/03/01）+ 阅读收益
- 阅读收益强调：读完本文后能回答"G1 的并发标记是如何在不停应用的情况下、多线程并行地完成对象图扫描的？时间片怎么控制？worker 之间怎么分配工作？mark stack 溢出怎么办？"——从 G1CMThread 的调度脉冲到 do_marking_step 的 200 行引擎，每一步的"为什么"都了然于胸
