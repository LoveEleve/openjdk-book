# G1 Young GC 详解（二）——Evacuation 核心 / Root 扫描 / RSet 扫描 / 工作窃取

> **系列定位**：三篇串讲一次 Normal Young GC。第二篇讲解 GC 最核心的阶段——搬走 CSet 中所有活对象。12 个 Root 子任务的并行分工、RSet 扫描怎么找到跨 Region 引用、工作窃取怎么保证不遗漏任何引用。
>
> **前置**：第一篇（08-01）——触发 / GCLocker / CSet 选择 / Pre-Evacuation。本章的 §2 Pre-Evacuation 是 08-01 §5 的承接点。
>
> **第三篇**：Post-Evacuation → Free CSet → 完整时间线（08-03）。

---

## 1. Pre-Evacuation——搬运前的最后准备（承接 08-01）

第一篇 §5 讲到 `pre_evacuate_collection_set()` 做了两件事。现在补充一个更完整的视图——**这一步到底是哪些数据结构需要 GC 前来不及清理完的**。

进入 safepoint 前，世界上有两类数据在变迁：

1. **mutator 的 dirty card buffer**：每个 mutator 线程在自己的 thread-local DirtyCardQueue 里攒满了写 barrier 产生的 dirty card。GC 开始前最后一刻 mutator 还在写引用——有些 card buffer 还是 "半满" 的，还没提交到全局队列。
2. **refinement 线程**：它们在 GC 之间一直在消费 dirty card、更新 RSet。GC 开始时 refinement 线程也停了——但可能还有处理到一半的 card。

`prepare_for_oops_into_collection_set_do()` 做两件事：

```cpp
// g1RemSet.cpp:511-516
void G1RemSet::prepare_for_oops_into_collection_set_do() {
    DirtyCardQueueSet& dcqs = G1BarrierSet::dirty_card_queue_set();
    dcqs.concatenate_logs();     // 把所有线程的半满 buffer → 全局 completed list
    _scan_state->reset();        // 为每个 Region 重算 _scan_top[]
}
```

`concatenate_logs()` 将每个线程的 `DirtyCardQueue` 的当前 partial buffer 拼接（concatenate）到全局 `DirtyCardQueueSet` 的 completed buffer list 上。这保证了 **GC Workers 有一份完整的 "所有 dirty card" 的视图**——不会漏掉任何一个 card。

`_scan_state->reset()` 为堆中每个 Region 重算 `_scan_top[i]`。代码逻辑已经在 08-01 §5.3 讲过——这里强调的是**这个数组在后续 §3 的 RSet 扫描中会被大量使用**——它决定了每个 old/humongous Region 的哪些 card block 需要被扫描。

---

## 2. Evacuation 全景——G1ParTask 的三个阶段

所有准备工作完成后，GC 正式进入**并行搬运**阶段：

```cpp
// g1CollectedHeap.cpp:2975
evacuate_collection_set(&per_thread_states);
  → G1RootProcessor root_processor(this, n_workers);
  → G1ParTask g1_par_task(this, psss, _task_queues, &root_processor, n_workers);
  → workers()->run_task(&g1_par_task);    // 所有 GC Worker 并行执行
```

每个 Worker（GC 线程）执行 `G1ParTask::work(worker_id)`（g1CollectedHeap.cpp:3185-3202）。这是一个严格的三阶段：

```cpp
void work(uint worker_id) {
    G1ParScanThreadState* pss = psss->state_for_worker(worker_id);

    // 阶段 A: Root 扫描——从 GC Roots 找到第一批指向 CSet 的引用
    _root_processor->evacuate_roots(pss, worker_id);

    // 阶段 B: RSet 扫描——找到来自 old Region 的跨 Region 引用
    _g1h->g1_rem_set()->oops_into_collection_set_do(pss, worker_id);

    // 阶段 C: 工作窃取——追踪所有"刚搬完的对象"的引用字段
    G1ParEvacuateFollowersClosure evac(_g1h, pss, _queues, &_terminator);
    evac.do_void();
}
```

三个阶段**每个 Worker 内部串行**（必须先扫完根和 RSet 把第一批对象推进队列、才能开始窃取），但**Worker 之间并行**——没有依赖。

---

## 3. 阶段 A: Root 扫描——从根源出发

### 3.1 为什么要从 Root 开始

GC 判断对象是否存活的唯一标准：**从 GC Roots 出发，沿引用链能否到达**。

如果某个对象能从任何 Root 走到——它是活的，需要被搬走（留在 CSet 里会被回收）。如果从任何 Root 都走不到——它是死的，不需要管它（CSet Region 被释放时自然消失）。Root 扫描就是找到 **"从外界进入 CSet 的第一扇门"**——所有能被根直接引用到的、且在 CSet 内的对象，必须立刻搬走。

### 3.2 12 个并行子任务

G1RootProcessor 把所有 Root 切分为 12 个独立子任务（g1RootProcessor.hpp:59-74）：

```
G1RP_PS_Universe_oops_do           ← 1. Universe 基础类型（java.lang.Class 的 mirror 等）
G1RP_PS_JNIHandles_oops_do         ← 2. JNI 全局引用和局部引用
G1RP_PS_ObjectSynchronizer_oops_do ← 3. ObjectMonitor 等待队列中的对象引用
G1RP_PS_Management_oops_do         ← 4. JMX MemoryPool/MemoryManager 持有的引用
G1RP_PS_SystemDictionary_oops_do   ← 5. 所有已加载 Java 类的静态字段
G1RP_PS_ClassLoaderDataGraph_oops_do ← 6. 类加载器层级中的引用
G1RP_PS_jvmti_oops_do             ← 7. JVMTI 探针（agent）持有的引用
G1RP_PS_CodeCache_oops_do         ← 8. JIT 编译后机器码中嵌入的对象引用
G1RP_PS_aot_oops_do               ← 9. AOT 编译缓存
G1RP_PS_filter_satb_buffers       ← 10. SATB 缓冲过滤（用于并发标记，Normal Young GC 跳过）
G1RP_PS_refProcessor_oops_do      ← 11. Reference 处理器
G1RP_PS_weakProcessor_oops_do     ← 12. 弱引用处理器
G1RP_PS_NumElements               ← 13.（计数哨兵）
```

### 3.3 如何保证不重复——CAS claim 机制

**12 个子任务不能每个 Worker 各做一遍**——那样会产生指数级的重复工作。G1 用 `SubTasksDone` 类（workgroup.cpp:446-460）做原子 claim：

```cpp
bool SubTasksDone::is_task_claimed(uint t) {
    uint old = _tasks[t];
    if (old == 0) {
        old = Atomic::cmpxchg(1u, &_tasks[t], 0u);  // CAS——第一个成功的人拿 0，后续拿 1
    }
    return old != 0;  // true = already claimed (skip), false = first claimer (do it)
}
```

**执行逻辑**：12 个子任务，N 个 Worker。每个 Worker 调 `try_claim_task(N)`：
- 任务 N 的锁位 = 0 → Worker 执行 `Atomic::cmpxchg(1, &_tasks[N], 0)` → 成功（返回 0）→ Worker 成为 claimant，执行该任务
- 任务 N 的锁位 = 1 → 已经有人 claim 过了 → Worker 跳过，尝试下一个任务

**最后一个 Worker 到屏障时**（`all_tasks_completed(n_workers)`），将所有锁位重置为 0——为下次 GC 的重用准备。

### 3.4 evacuate_roots 的调用顺序

```cpp
// g1RootProcessor.cpp:78-136
void G1RootProcessor::evacuate_roots(G1ParScanThreadState* pss, uint worker_i) {
    // 1. Java 根：Universe, JNIHandles, ObjectSynchronizer, Management,
    //    SystemDictionary, ClassLoaderDataGraph, JVMTI, AOT
    process_java_roots(closures, phase_times, worker_i);

    // 2. VM 根：CodeCache
    process_vm_roots(closures, phase_times, worker_i);

    // 3. StringTable——intern 的字符串
    process_string_table_roots(closures, phase_times, worker_i);

    // 4. CM ref_processor roots（如果有并发标记）
    if (!_process_strong_tasks.is_task_claimed(G1RP_PS_refProcessor_oops_do)) {
        _g1h->ref_processor_cm()->weak_oops_do(closures->strong_oops());
    }

    // 5. 如果 trace_metadata（InitialMark）：弱 CLD 第二遍
    // 6. SATB buffer filtering（如果有 mark_or_rebuild_in_progress）

    _process_strong_tasks.all_tasks_completed(n_workers());
}
```

### 3.5 找到 CSet 内的对象后——G1ParCopyClosure

每种 Root 扫描后的引用最终都交给 `G1ParCopyClosure::do_oop()` 处理：

```
读到引用 ref → ref 指向对象 A

  1. A 不在 CSet?
     → 不管——A 不需要搬

  2. A 在 CSet 中?  检查 A.mark_word:
     → 低 2 位 = 11 (marked_value = 3)?
        YES → A 已经被搬过了 → 取 forwarding pointer → 更新 ref
        NO  → A 还没搬 →
              a. 在 Survivor 或 Old Region 中分配目标空间
              b. memcpy A → 新地址 A'
              c. 在 A.mark_word 中写入 forwarding pointer: encode_pointer_as_mark(A')
              d. 把 A 的旧地址压入 Worker 的本地任务队列 (RefToScanQueue)
                 —— 后续 §5 会追踪 A 的引用字段
              e. 更新 ref → A'
```

**forwarding pointer 编码**（markOop.hpp:325, 356）：
```cpp
markOop set_marked() {
    return markOop((value() & ~lock_mask_in_place) | marked_value);
    // lock_mask_in_place = 3 → 清除最低 2 位 → 设 11
}

inline static markOop encode_pointer_as_mark(void* p) {
    return markOop(p)->set_marked();
    // 把新地址 &A' 写入 mark word，低 2 位 = 11
}
```

---

## 4. 阶段 B: RSet 扫描——找到来自 old Region 的引用

### 4.1 为什么 Root 扫描不够

Root 扫描（§3）覆盖了从 JVM 根出发的所有引用链。但还有一个巨大的盲区——**CSet Region 可能被不在 CSet 中的 old/humongous Region 引用**。

例如：一个 old Region 里的对象持有一个数组引用，这个数组在某个 eden Region 中。**old Region 不是 GC Root——Root 扫描根本不会进入 old Region 内部遍历它的字段。** 如果不通过 RSet 来补充——这个 eden Region 里的数组会被误判为 "没有引用指向它"——被错误回收。

### 4.2 RSet 怎么解决

每个 Region 的 RSet 记录了 "谁引用了我的哪个 card"（ch11/06）。扫描 CSet Region 的 RSet = **反向查找所有入引用**。

```cpp
// g1RemSet.cpp:506-508
void G1RemSet::oops_into_collection_set_do(G1ParScanThreadState* pss, uint worker_i) {
    update_rem_set(pss, worker_i);    // 先处理残存的 dirty card
    scan_rem_set(pss, worker_i);      // 再扫描 RSet
}
```

**`update_rem_set()`**——refinement 线程在 GC 之间一直在处理 dirty card、更新 RSet。但 GC 开始时 refinement 线程停了——可能还有一批 dirty card 已经在队列里但还没处理完。`update_rem_set()` 把所有积压的 dirty card 处理掉，确保 RSet 是最新的。

**`scan_rem_set()`**——遍历 CSet 中每个 Region 的 RSet。Worker 通过 `_iter_claims`（原子操作抢 card block）做并行分工。每个 card 被扫描时——这个 card 在 old Region 中的位置被用来查找这个 card 覆盖范围内是否有指向 CSet Region 的引用。如果找到了——交给 `G1ParCopyClosure::do_oop()`——**同一个搬运逻辑**。

**`_scan_top[i]` 的作用**——§1 里的 `_scan_state->reset()` 为每个 old/humongous Region 设了扫描上限。card 扫描从 card 0 开始，到 `_scan_top[i]` 对应的 card 停止——超过这个上限的空间还没分配对象，不用扫。

### 4.3 RSet 扫描和 Root 扫描共享同一个搬运逻辑

虽然 Root 扫描和 RSet 扫描的**数据来源不同**（Root 来自 JVM 内部结构，RSet 来自 card table 扫描），但它们的**落脚点完全相同**——找到指向 CSet 内对象的引用 → 调用 `G1ParCopyClosure::do_oop()` → 搬。

---

## 5. 阶段 C: 工作窃取——追踪到底

### 5.1 问题的来源

阶段 A 和 B 找到了 "被根或 old Region 直接引用到的 CSet 对象" 并搬走了它们。但这个被搬走对象的**引用字段**还指向别的对象——那些对象可能也在 CSet 中，也需要被搬。

例子：

```
Root → A（在 CSet, 被搬了）
       A.field1 → B（在 CSet, 还没搬, 因为没有任何 Root 直接引用 B）
       A.field2 → C（不在 CSet, 已经安全）
```

A 被搬走后，Worker 把 A 压入了自己的本地队列——表示 "A 的引用字段还需要被追踪"。阶段 C 就是不断消费这个队列——直到所有链条穷尽。

### 5.2 干活的循环

```cpp
// g1CollectedHeap.cpp:3157-3163
void G1ParEvacuateFollowersClosure::do_void() {
    G1ParScanThreadState* const pss = par_scan_state();

    pss->trim_queue();                   // 第一步：排空自己的队列
    do {
        pss->steal_and_trim_queue(queues());  // 从别人的队列偷活、继续排空
    } while (!offer_termination());           // 直到全局无活可干
}
```

`trim_queue()`（g1ParScanThreadState.inline.hpp:159-191）的内部逻辑：
1. 先从队列的 overflow stack 里取——这些是 "任务队列满时溢出的"
2. 再从主队列里取
3. 拿出来的是一个引用 → 调用 `G1ParCopyClosure::do_oop()` → 搬 → 被搬对象的引用字段可能产生新的引用 → push 回队列
4. 继续，直到队列低于下限阈值（`_stack_trim_lower_threshold`）

### 5.3 工作窃取——从别人那偷

`steal_and_trim_queue()`（g1ParScanThreadState.inline.hpp:146-157）：
```cpp
void G1ParScanThreadState::steal_and_trim_queue(RefToScanQueueSet *task_queues) {
    StarTask stolen_task;
    while (task_queues->steal(_worker_id, &_hash_seed, stolen_task)) {
        dispatch_reference(stolen_task);    // 处理偷到的作业
        trim_queue();                        // 可能产生了新的引用——排空
    }
}
```

`steal_best_of_2()`（taskqueue.inline.hpp:257-267）——每次随机选两个 Worker 的队列，"偷其中更好的那个"（队列更长、更有料）。

### 5.4 终止协议——什么时候全体收工

`offer_termination()` 使用 `ParallelTaskTerminator`：

1. 一个 Worker 自己的队列空了 + 偷了所有其他队列也是空 → 调 `offer_termination()` 进入 "等待退休" 状态
2. 其他 Worker 还在干活 → 退休状态自动解除 → 继续偷活
3. 所有 Worker 都进入退休状态 → 全局终止

这是经典的 "松耦合终止"——不是 "指挥说停大家一起停"，而是"每个 Worker 自己决定没活儿了才退休，退休了还能反悔"。

### 5.5 为什么需要工作窃取——BFS 扩散的必然

Root 扫描和 RSet 扫描只覆盖了 **Level 1 的引用**（从根或 old Region 直接引用到的 CSet 对象）。但对象图是一个多层有向图——A 引用 B → B 引用 C → C 引用 D——Level 1 搬了不等于 Level 2/3/N 都搬了。

工作窃取保证了这个 BFS 扩散不会在任何一层中断——只要有 Worker 的队列里还有引用，就一定被处理；只要别的 Worker 有活儿，空了的 Worker 就去偷。逐层扩散，直到整棵引用树遍历完。

---

## 6. G1ParScanThreadState——每个 Worker 的工具箱

每个 GC Worker 持有自己的 `G1ParScanThreadState`（g1ParScanThreadState.hpp:45）——承载了该 Worker 在 evacuation 期间的所有上下文：

```cpp
class G1ParScanThreadState {
    RefToScanQueue*  _refs;                    // 该 Worker 的任务队列
    G1PLABAllocator* _plab_allocator;           // 并行本地分配缓冲（下一篇展开）
    AgeTable         _age_table;                 // 对象年龄表（驱动晋升阈值）
    uint             _tenuring_threshold;        // 当前年龄晋升阈值
    G1EvacuationRootClosures* _closures;         // Root 扫描闭包集
    G1ScanEvacuatedObjClosure  _scanner;         // 搬完后扫描引用字段的闭包
    DirtyCardQueue   _dcq;                      // 脏卡队列
    uint             _worker_id;                 // Worker 编号
};
```

**三种队列的角色**：
- `_refs`——任务队列（push 作业 / pop 作业 / steal 作业）
- `_dcq`——这个 Worker 在扫描引用时如果产生了 dirty card，不会直接更新 RSet，而是放进这个队列，等 GC 收尾时批处理
- `_plab_allocator`——在 Survivor/Old Region 中为搬来的对象分配空间（下一篇 08-03 展开 PLAB）


---

## 附录: 本文涉及的字段速查

| 字段 | 所在类 | 类型 | 源码位置 | 用途 |
|------|--------|------|---------|------|
| `_refs` | `G1ParScanThreadState` | `RefToScanQueue*` | g1ParScanThreadState.hpp:47 | Worker 的本地任务队列——push/pop/steal 的载体 |
| `_plab_allocator` | `G1ParScanThreadState` | `G1PLABAllocator*` | g1ParScanThreadState.hpp:52 | PLAB 分配器——在 Survivor/Old Region 中为搬来的对象分配空间 |
| `_closures` | `G1ParScanThreadState` | `G1EvacuationRootClosures*` | g1ParScanThreadState.hpp:50 | Root 遍历所需的所有闭包集合 |
| `_age_table` | `G1ParScanThreadState` | `AgeTable` | g1ParScanThreadState.hpp:54 | 本地对象年龄表——驱动晋升阈值计算 |
| `_tenuring_threshold` | `G1ParScanThreadState` | `uint` | g1ParScanThreadState.hpp:57 | 当前晋升阈值——age >= 此值的对象晋升到 Old |
| `_process_strong_tasks` | `G1RootProcessor` | `SubTasksDone` | g1RootProcessor.hpp:51 | 12 个强根扫描子任务的任务声明管理器 |
| `_tasks` | `SubTasksDone` | `volatile uint*` | workgroup.hpp:341 | 任务声明数组——每个元素 0=未声明，通过 CAS 抢 |
| `RefToScanQueue` | (typedef) | `OverflowTaskQueue<StarTask, mtGC>` | g1CollectedHeap.hpp:98 | 带溢出栈的工作窃取队列——StarTask 可以是 oop* 或 narrowOop* |
