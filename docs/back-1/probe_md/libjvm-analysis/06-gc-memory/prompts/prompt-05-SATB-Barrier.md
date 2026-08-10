# PROMPT: 请撰写 05-SATB-Barrier.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**SATB Barrier — G1 如何让并发标记安心运行而 mutator 可以继续修改引用**

### 核心故事线（禁止做源码翻译机！）

你已经读了 04（CardTable + RSet：post-barrier 脏化卡、DirtyCardQueue 生产者-消费者协议），知道 G1BarrierSet 同时维护两套前/后屏障。04 深挖了后屏障（write_ref_field_post）的全链路，本文深挖**前屏障（write_ref_field_pre）**及背后的**SATB（Snapshot-At-The-Beginning）理论**。

**★ 和 04 §二的边界**：04 已经指出 `G1BarrierSet` 有两个 barrier——`write_ref_field_pre`（SATB）和 `write_ref_field_post`（CardTable）。04 把 post-barrier 从头到尾讲透了。本文要回答的是：**pre-barrier 为什么记录旧值而不是新值？如果记录新值（增量更新）会怎样？旧值被记录之后发生了什么？SATB buffer 怎么从 per-thread 流转到并发标记线程？为什么 SATB 能保证"并发标记开始时活的对象一定被标记"？**

**❓ 如果 G1 没有 SATB，并发标记会出现什么错误？**

```
没有 SATB 的 G1 并发标记：
  Mutator 执行：  a.x = c;   // 覆盖了 a.x = b
  时间线：
    T1: TAMS 快照（并发标记开始时的 top）
    T2: 标记线程扫描 a → 发现 a.x = c（新值）
    T3: Mutator 执行 a.x = c（已经改了，旧值 b 丢失）
    T4: 标记线程扫描 b → 但 a 现在已经不引用 b 了
    T5: b 从"标记开始时的活对象"变成了"漏标" → 被误回收！

有 SATB 的 G1 并发标记：
  Mutator 执行前：
    write_ref_field_pre(field, old_value=b)
      → 把 b 存入 per-thread SATB buffer
  Mutator 执行：a.x = c
  标记线程：
    当 a.x = c 被看到时，SATB buffer 中的 b 会被处理
      → b 被标记为活对象 → 安全！

本质：SATB 在引用被覆盖的瞬间"抢救"旧值，
      确保并发标记开始时活的对象不会因为中间引用变化而漏标。
```

**★ 和 04 的架构对比（面试高频题）**：

```
              G1BarrierSet
             /            \
    write_ref_field_pre   write_ref_field_post
    (SATB 前屏障)         (CardTable 后屏障)
         │                      │
    记录旧值 ──→ 被覆盖前       脏化卡 ──→ 新引用建立后
         │                      │
    SATB buffer             DirtyCardQueue
    (per-thread, 1024)      (per-thread, 256)
         │                      │
    _completed_buffers_head      _completed_buffers_head
    (同一个 CAS 单链表！)       (同一个 CAS 单链表！)
         │                      │
    并发标记线程消费          Refinement 线程消费
         │                      │
    保证标记完整性            维护 RSet 跨 Region 索引
```

**★ 共享基类：PtrQueue**：SATB buffer 和 DirtyCardQueue 共享同一个 `PtrQueue` 基类（`ptrQueue.hpp`）——同一个无锁 bump-pointer 设计、同一个 `_completed_buffers_head` CAS 单链表协议。04 深挖了 DirtyCardQueue 的使用模式，本文深挖 SATB 在并发标记上下文中的独特语义。

**面试话术**："G1 有两个写屏障：前屏障（pre-barrier）存旧值到 SATB buffer，保证并发标记不丢活对象；后屏障（post-barrier）脏化卡，维护 RSet 让 Young GC 不用全堆扫描。两套队列共享同一个无锁 PtrQueue 基类。"

---

### 完整的故事线

```
Mutator 写引用：  obj.f = value
  │
  ├─ ★ Pre-barrier (write_ref_field_pre)
  │    └─ 检查：SATB 是否激活？→ 只在并发标记期间激活（省无关开销）
  │       T heap_oop = RawAccess<MO_VOLATILE>::oop_load(field)  // ★ 读旧值
  │       if (!CompressedOops::is_null(heap_oop)) {              // NULL 跳过
  │         enqueue(CompressedOops::decode_not_null(heap_oop))   // 入队
  │       }
  │
  ├─ store 发生（引用真的被修改了）
  │
  └─ ★ Post-barrier (write_ref_field_post) → 已在 [04-CardTable-RSet] 深挖
       → 脏化卡 → DirtyCardQueue → Refinement → RSet 更新

SATB Buffer 流转：
  enqueue(pre_val) → SATBMarkQueue (per-thread, 1024 entries, 无锁)
    → buffer 满 (index==0) → CAS 入队到 _completed_buffers_head
      → 并发标记线程 (G1CMTask) 消费
        → do_marking_step() 的 drain SATB 步骤
          → apply_closure_to_completed_buffer
            → 标记旧值指向的对象（G1CMTask::make_referent_alive）
              → push 到 mark stack → 继续递归标记

SATB 激活/停用：
  并发标记开始 → set_active_all_threads(true) → pre-barrier 开始记录
  并发标记结束 → set_active_all_threads(false) → pre-barrier 停止记录
  ★ 为什么停用？→ 标记结束后不需要抢救旧值了，省 ~30 cycles/write
```

---

### 核心叙事线（12 个"为什么"问题，每个必须有源码回答）

**❓ 理论层（面试必问）**

1. **❓ 为什么 SATB 记录旧值而不是新值？CMS 用增量更新（记录新值），它是怎么保证正确性的？G1 为什么选 SATB 而不是增量更新？**

   **要求**：这应该是本文最长、最深的分析——不是简单的"SATB 保护旧值、IU 可能漏标"，而是要分析两种方案各自的**完整正确性保证链**和**性能权衡**。

   **子问题（必须逐一回答）**：

   (a) Wilson 1992 漏标三条件是什么？在并发标记的时间线上画出条件①+②+③同时满足的场景。
       ```
       条件①：标记线程已经扫过了 a（a 被标为灰色/黑色）
       条件②：Mutator 把 a.x 从 b 改为 c（覆盖了指向 b 的引用）
       条件③：标记线程还没扫 b（b 是白色）
       
       如果①+②+③同时发生 → b 会被漏标！
       ```

   (b) SATB 如何打破条件③？增量更新（IU）如何打破条件②？
       ```
       SATB：在引用被覆盖前（事件②发生前），显式记录旧值 b
             → b 被 push 到 SATB buffer → 后续 drain 时发现 b → 标记 b
             → ★ 打破了条件③：b 不再是"白色"——它被 SATB 抢救回来了
       
       IU（CMS 方案）：在引用被覆盖后，记录新值 c + 记录"a 被修改了"
             → 新值 c 被标记 ✓
             → 被修改的 a 所在的 card 被标记为 dirty
             → Remark 阶段：重新扫描所有 dirty card（包括 a 所在的 card）
             → ★ 打破了条件②：a 被重新扫描 → a.x = b（如果 b 还没被覆盖的话）→ b 被标记
       
       两者都正确，只是途径不同！
       ```

   (c) ★★★ 那么 G1 为什么选 SATB 而不是 IU？——核心不是"正确性"，而是 **Remak 成本的差异**。
       ```
       SATB 的 Remark 成本：
         = 排空 residual SATB buffers + 处理灰色对象
         = O(SATB entries + grey objects)
         ★ 成本与并发标记期间 mutator 的引用覆盖次数有关，但 buffer 已有上限（1024 entries）→ 可控
       
       IU 的 Remark 成本（如果 G1 用 IU）：
         = 重新扫描所有并发标记期间 dirty 的 cards
         = O(# dirty cards × 512B per card)
         → 8GB 堆、高 mutation rate 的应用：可能 100K+ dirty cards → ~50MB 扫描
         → Remark 暂停不可预测（取决于 mutator 行为）
       
       ★ 面试上下文记忆点：
         CMS 堆通常较小（<4GB）→ IU re-scan 成本可接受
         G1 堆通常较大（8-64GB）→ SATB 的 predictale remark 是更好的选择
       
       G1 的额外优势（架构级别）：
         1. Region-based：每个 Region 独立回收，SATB snapshot 保证 Region 级别一致性
         2. Evacuation（复制）不是 Mark-Sweep：Floating Garbage 可以被下次 Young GC 回收，容忍度高
         3. Mixed GC 选策需要精确 liveness：SATB 的可预测 remark 时间让 G1Policy 能准确预测 GC 暂停
       ```

   (d) SATB 的代价——Floating Garbage 有多少？
       ```
       SATB 保守地保留了标记开始时所有活对象。如果：
         T1: a.x = b（标记开始时 b 是活的 → SATB 标记 b）
         T2: a.x = null（b 变成垃圾）
         T3: 但 b 已被标记 → 本轮不回收 → Floating Garbage
       
       但：如果 b 在 Young Region 中 → 下次 Young GC 回收 ✓
       如果 b 在 Old Region 中 → 下次 Mixed GC 回收 ✓
       影响：多保留一个 GC cycle → 对 G1 的 Evacution 模型来说可接受
       ```

   **面试一句话**："CMS 用增量更新，Remark 要重扫所有脏卡——堆越大越贵。G1 用 SATB，Remark 只排空 buffer——堆大小几乎不影响成本。代价是多保留一 cycle 的 Floating Garbage，G1 的 Young/Mixed GC 频繁，能很快回收。"

2. **❓ 为什么 SATB 是"快照"（Snapshot）——在什么时刻取的快照？最重要的是：哪些对象在这个快照里？哪些不在？**

   **子问题（必须逐一回答）**：
   
   (a) 快照时刻和边界：
   ```
   时刻：并发标记开始（Initial Mark）
   内容：TAMS（Top At Mark Start）以下的活对象图
   
   实现机制：
     并发标记开始
       → 设置所有 Region 的 TAMS = _top（每个 Region 当前已分配对象的边界）
       → ★ SATB pre-barrier 激活（set_active_all_threads(true)）
       → 后续直到 Remark 完成，所有引用覆盖都会抢救旧值
   ```

   (b) ★★★ 为什么 TAMS 以上的对象（并发标记期间新分配的）不需要 SATB 保护？
   
   这是 SATB 最重要的优化之一：
   ```
   TAMS 以上（并发标记期间新分配的对象）：
     → 保守视为"活" → 不需要 SATB 保护 → pre-barrier 不用管这些对象中的引用
     
   TAMS 以下（并发标记开始前分配的对象）：
     → "也许活也许死" → 需要 SATB 保护 → pre-barrier 在引用被覆盖前抢救旧值
   
   如果没有 TAMS 这个优化：
     → SATB 需要记录所有引用覆盖（包括新分配对象中的引用写入）
     → 但新分配对象中的引用不可能是"标记开始时活的对象"的引用
     → 大量无意义的 SATB 入队 → 浪费 buffer 容量和 drain 时间
   
   ★ 追问：TAMS 以上对象如果引用了 TAMS 以下对象怎么办？
      → TAMS 以上对象是"活"的 → 标记线程最终会扫描到它们
      → 扫描时自然会发现它们引用了 TAMS 以下的活对象 → 引用链完整
   ```

3. **❓ SATB 会引起 Floating Garbage 吗？和增量更新相比，SATB 的 Floating Garbage 多还是少？**

   **子问题**：
   
   (a) SATB 的 Floating Garbage 从哪里来？
   ```
   T1: 并发标记开始，a.x = b（b 被标记为"标记开始时活"）
   T2: Mutator 执行 a.x = null（b 变成垃圾）
   T3: b 已被标记 → 本轮 GC 不回收 → Floating Garbage
   ```
   
   (b) 这和 G1 的回收模型有什么关系？
   ```
   b 在 Young Region → 下次 Young GC 回收 ✓（Floating Garbage 只活一个 cycle）
   b 在 Old Region → 下次 Mixed GC 回收 ✓
   
   G1 的 Evacuation 模型容忍度高——
   因为它本来就频繁做 Young GC（每耗尽 Eden 就一次），
   Floating Garbage 不会长期占用堆空间。
   ```

**❓ 实现层（源码走读）**

4. **❓ write_ref_field_pre 为什么读旧值用 `RawAccess<MO_VOLATILE>::oop_load(field)` 而不是普通 load？为什么不需要更强的内存屏障保证 load→store 顺序？**

   **子问题**：
   (a) `MO_VOLATILE` 保证读到最新值（不被编译器优化为 stale 寄存器值）
   (b) 为什么不需要 `memory_order_release` 或 `memory_order_seq_cst`？
       → SATB 有 Remark 阶段兜底（STW，排空所有 residual SATB buffer + 灰对象）
       → 即使旧值读到的是"store 之前瞬间"的值（而非"store 之前"），Remark 也会处理
   (c) 和 post-barrier 的 `OrderAccess::storeload()` 对比——为什么 post-barrier 需要而 pre-barrier 不需要？
       → 04 §二已讲过：post-barrier 需要 storeload 因为 GC 在 safepoint 扫描 RSet
       → pre-barrier 不需要因为 Remark 提供了 safety net

5. **❓ SATB buffer 为什么是 1024 entries？和 DirtyCardQueue 的 256 entries 比较，为什么不同？**

   **子问题**：
   (a) 6 维度对比表：entry 语义(oop vs card address)、触发频率(无过滤 vs young card过滤)、
      consumer(单个 marking thread vs Refinement pool)、积压风险、全局参数
   (b) ★ SATB 为什么无过滤？→ 在引用被覆盖前，无法判断旧值是否"需要被抢救"
   (c) 如果 SATB buffer 太小（如 256）会怎样？→ 频繁 CAS 入队 → marking thread 被频繁打断

6. **❓ SATBMarkQueue 和 SATBMarkQueueSet 的架构——为什么需要 shared queue？非 Java 线程怎么办？**

   **子问题**：
   (a) 走读 `enqueue()` 中的 `if (thr->is_Java_thread())` 分支
   (b) shared queue 为什么需要 `Shared_SATB_Q_lock`？（非 Java 线程没有 per-thread 队列）
   (c) 哪些非 Java 线程会触发 SATB？（VMThread 的类卸载、CompilerThread 的 OopMap 更新等）
   (d) `set_active_all_threads()` 如何遍历所有 Java 线程并设置 _active？

7. **❓ SATB buffer 满了之后怎么办？和 DirtyCardQueue 的流程一样吗？**

   **子问题**：
   (a) 和 DirtyCardQueue 共享同一套 PtrQueue 生产者-消费者协议（引用 [04 §三.2]）
   (b) 消费端的差异：标记线程 drain SATB → make_referent_alive(vs Refinement 线程 drain DirtyCard → update RSet)
   (c) ★ 为什么两个队列用相同的协议而不是各自优化？→ 共享基类减少代码 + CAS 协议已充分测试

**❓ 生命周期层（什么时候激活/停用）**

8. **❓ SATB 什么时候激活？什么时候停用？不激活的时候 pre-barrier 发生了什么？**

   **子问题（必须逐一回答）**：

   (a) 激活点：并发标记开始前（pre-cleaning 前）
   ```
   g1ConcurrentMark.cpp 中 set_active_all_threads(true, false):
     → _all_active = true
     → 遍历所有 JavaThread → 每个线程的 SATB 队列 set_active(true)
     → shared_satb_queue.set_active(true)
   ```

   (b) 停用点：★★ 在 Remark **暂停中**（不是 Cleanup！）
   ```
   g1ConcurrentMark.cpp:1308-1312（正常结束）:
     → Remark 阶段（STW）完成后 → set_active_all_threads(false, true)
     → 还有一处：g1ConcurrentMark.cpp:2266-2271（标记中止时）
   
   ★ 追问：为什么在 Remark 中停用而不是等到 Cleanup？
     → Remark 完成 = 标记完成 → 不再有新的"标记开始时活的对象"需要保护
     → Cleanup 阶段已经不需要 SATB 了——早停用早省 ~30 cycles/write
   ```

   (c) 不激活时 barrier 的开销：
   ```
   enqueue(pre_val) {
     if (!_satb_mark_queue_set.is_active()) return;  // 直接返回，几乎零开销
     // ... 正常 enqueue
   }
   ```
   
   ★ 追问：谁的职责——`write_ref_field_pre` 还是 `enqueue()`？
   ```
   write_ref_field_pre (barrier inline):
     不管 SATB 是否激活——只管读旧值 + 调 enqueue
     职责：从 field 读旧值，NULL 过滤
   
   enqueue() (在 g1BarrierSet.cpp:132):
     检查 is_active()——如果未激活，直接 return
     职责：判断是否真的需要入队（active check + 选择 per-thread/shared queue）
   
   设计意图：职责分离——barrier inline 代码不关心并发标记是否在运行，
   这是 enqueue() 的决策。这样 inline 代码可以保持极简（3 条指令 + 2 个 call）。
   ```

9. **❓ 线程创建时如何初始化 SATB 队列？如果线程创建并发标记正在进行中怎么办？**

   源码（`g1BarrierSet.cpp:256-283`）：
   ```
   on_thread_attach(JavaThread* thread):
     assert SATB queue is NOT active  // 线程创建时 SATB 默认未激活
     assert SATB queue is empty
     assert DirtyCard queue IS active  // 脏卡队列始终激活
     
     if _satb_mark_queue_set.is_active():  // ★ 如果并发标记正在进行
       SATB queue.set_active(true)         // ★ 手动激活，确保新线程也参与 SATB
   
   设计意图：新线程创建时如果并发标记已经在进行，
   新线程的引用写入也需要 SATB 保护——否则新线程覆盖的引用可能漏标。
   ```

10. **❓ 线程销毁时 SATB 队列怎么办？残留的 buffer 会丢失吗？**

    ```
    on_thread_detach(JavaThread* thread):
      → flush SATB queue  → 将残留 buffer CAS 入队到 _completed_buffers_head
      → flush DirtyCard queue
   
    为什么必须 flush？→ 线程销毁后其 buffer 内存可能被回收，
    但 buffer 中还有未处理的 SATB entry → 这些 oop 如果丢失会导致漏标。
    ```

**❓ 消费层（并发标记如何 drain SATB）**

11. **❓ G1CMTask::do_marking_step() 中如何 drain SATB buffers？为什么 SATB 是最高优先级？**

    `do_marking_step()`（`g1ConcurrentMark.cpp`，详细走读在 [06]）的 drain 步骤：
    ```
    do_marking_step():
      ...
      // ★ Step 1: drain SATB buffers（最高优先级！）
      while (_cm->has_aborted() == false && satb_mq_set.completed_buffers_num() > 0) {
        if (!drain_satb_buffers()) break;
      }
      // Step 2: drain local mark stack
      // Step 3: drain global mark stack
      // Step 4: scan heap regions
      // Step 5: steal from other workers
    ```

    **❓ 为什么 SATB drain 是最高优先级？**
    → SATB buffer 中待处理的 oop 指向的对象尚未入队（既不在 mark stack 也不在任何 queue 中）。如果不优先 drain → 这些 oop 指向的对象一直是"白"的 → 可能被漏标。其他步骤处理的是已经在系统中的灰色对象——可以先等一等。

12. **❓ Remark 阶段为什么还需要 drain SATB？并发标记期间不是一直在 drain 吗？**

    Remark 阶段是 STW（Stop-The-World），此时需要：
    1. 处理并发标记期间最后时刻 mutator 写入残留的 SATB entries
    2. 处理已经 drain 但还在 mark stack 中的灰对象 → 递归标记完成
    3. 处理 SATB buffer 中可能存在的"repeat"——同一 oop 被多次入队
    
    **★ Remark 的 STW 为什么不可避免？**
    → 并发标记结束时，mutator 可能恰好刚覆盖了一个引用（刚 enqueue SATB 但还没被 drain），或者 mark stack 中还有未处理的灰色对象。这些无法靠并发标记解决——mutator 和 marking 线程都在跑，标记线程无法判断"标记是否真的完成了"。只有停下 mutator，排空所有 SATB + mark stack，才能确定标记边界。

---

### 和 04/06 的边界

- **04 §二**：G1BarrierSet 的双屏障架构已简述，post-barrier 全链深挖 → 本文深挖 pre-barrier 全链
- **04 §三**：DirtyCardQueue 的 PtrQueue 基类协议已深挖 → 本文聚焦 SATB 在并发标记上下文中的语义差异（激活/停用、drain 时机、优先级）
- **06 §X**：do_marking_step() 中 SATB drain 的完整走读 → 本文只简述 drain 的调用位置和优先级，不展开 do_marking_step 内部

### 禁止行为

- ❌ 把 PtrQueue 基类代码再贴一遍——04 已经深挖过，本文引用 `[04 §三]` 即可
- ❌ 把 "T heap_oop = RawAccess::oop_load(field)" 贴出来说"这里读了旧值"——这是源码翻译
- ❌ 只说"SATB 记录旧值"——**必须回答：为什么不记录新值？两种方案的漏标场景对比是什么？**
- ❌ 不讲 SATB 队列的 activate/deactivate 生命周期——这是 SATB 和 DirtyCardQueue 的关键差异
- ❌ 不讲 shared queue 的存在理由——不分 Java/非 Java 线程
- ❌ 不讲 buffer entry 是 oop（对象指针）而 DirtyCardQueue entry 是 card 地址——两者的语义差异
- ❌ 不讲 Remark 的 STW 为什么必不可少

### 要求行为

- ✅ **★ 每节以"❓ 为什么..."开头**
- ✅ **★ 全文核心叙事线**：pre-barrier（记录旧值）→ SATB buffer（per-thread 无锁）→ CAS 入队 → 并发标记线程 drain → 标记旧值 → Remark 补刀
- ✅ **★ Mermaid 图 ≥3 张**：
  1. 漏标三条件（Wilson 1992）+ SATB 如何打破条件 ③
  2. SATB buffer 流转：per-thread → CAS → completed_buffers_head → marking thread consume
  3. SATB 激活/停用时间线（与并发标记阶段的关系）
- ✅ **★ GDB 验证 ≥6 条**：
  1. sizeof(SATBMarkQueue) + buffer = 1024 × 8B = 8KB
  2. G1SATBBufferSize=1024 常量验证
  3. _satb_mark_queue_set.is_active() 在并发标记前/后为 false/true
  4. _all_active 字段的读写时机（并发标记开始/结束）
  5. shared_satb_queue 的存在验证（非 Java 线程的入队路径）
  6. on_thread_attach 中 SATB 激活逻辑验证（线程创建时并发标记正在进行）
  7. Remark 阶段 drain SATB buffers 的数量（GC log 验证）
- ✅ **★ 设计替代分析**：SATB vs 增量更新（Incremental Update），每种方案的漏标场景
- ✅ **★ 和 04 的对比表格**：pre-barrier vs post-barrier 全方位对比（触发条件、存储内容、消费者、队列大小、激活条件）
- ✅ **★ 交叉引用精确**：PtrQueue 基类 → [04 §三]；do_marking_step → [06 §X]；write_ref_field_post → [04 §二]

---

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（G1 Region = 4MB，2048 Regions）
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

---

## 三、聚焦源文件（行号需 grep 验证）

| # | 文件 | 模块 | 核心函数/类 | 本文角色 |
|---|------|------|------------|---------|
| 1 | `g1BarrierSet.hpp/cpp` | gc/g1 | `class G1BarrierSet`, `write_ref_field_pre()`(L60), `enqueue()`(L51) | ★★★ 前屏障入口 + SATB 全局状态 |
| 2 | `g1BarrierSet.inline.hpp` | gc/g1 | 内联 write_ref_field_pre（`RawAccess<MO_VOLATILE>::oop_load`） | ★★★ 前屏障热路径 |
| 3 | `satbMarkQueue.hpp/cpp` | gc/g1 | `class SATBMarkQueue : public PtrQueue`, `SATBMarkQueueSet`, `_all_active`(父类), `_shared_satb_queue`, `set_active_all_threads()` | ★★★ SATB 队列核心 |
| 4 | `ptrQueue.hpp/cpp` | gc/shared | `class PtrQueue`(L38), `_buf`, `_sz`, `_index`, `enqueue()`, `class PtrQueueSet`, `_completed_buffers_head` | ★★ SATB/DirtyCard 共享基类（引用 04，不重复讲） |
| 5 | `g1ConcurrentMark.hpp/cpp` | gc/g1 | `class G1ConcurrentMark`, `class G1CMTask`, `do_marking_step()`, **`set_active_all_threads(true/false)` 调用点** | ★★★ SATB 消费端 + **激活/停用的实际调用位置** |
| 6 | `g1ConcurrentMarkThread.hpp/cpp` | gc/g1 | `class G1ConcurrentMarkThread`, `run_service()` | ★ 并发标记线程调度生命周期（何时启动/sleep，不直接控制 SATB 激活） |
| 7 | `g1CollectedHeap.hpp/cpp` | gc/g1 | `G1CollectedHeap`, SATB 全局状态检查 | ★ 全局入口 |
| 8 | `g1ThreadLocalData.hpp/cpp` | gc/g1 | `satb_mark_queue()`, per-thread SATB 队列访问 | ★★ per-thread 访问器 |
| 9 | `g1RootClosures.hpp` + `g1OopClosures.hpp` | gc/g1 | SATB 相关的 closure 类型 | ★ GC 扫描 closure 引用 |

> 以上行号均需在撰写前 grep 验证，不可直接引用。

---

## 四、文章结构（§〇 ~ §七 + 附录）

```
§〇 源文件清单（9 文件，标注模块归属 + grep 验证行号）

§一 ★ 全景 — 如果没有 SATB，并发标记会出现什么错误？
  ❓ SATB 解决了什么正确性问题？
  1.1 Wilson 1992 漏标三条件
  1.2 SATB vs 增量更新的漏标场景走读（用 concurrency timeline）
  1.3 ★ 设计替代分析：G1 选 SATB 的架构原因（Region-based + predictale remark + Evacuation 容错）
  1.4 04 pre-barrier vs post-barrier 全方位对比表

§二 ★★★ G1BarrierSet::write_ref_field_pre — 前屏障全链走读
  ❓ 为什么读旧值用 MO_VOLATILE？为什么不需要更强的内存屏障？
  2.1 write_ref_field_pre 逐行走读（NULL 过滤、dest_uninitialized 过滤）
  2.2 ★ 为什么 MO_VOLATILE 够用？（Remark 补刀机制）
  2.3 和 [04 §二] post-barrier 的调用顺序（pre→store→post）
  2.4 ★ 并发标记期间 vs 非标记期间：is_active() 的分支行为

§三 ★★★ SATBMarkQueue — per-thread 无锁队列
  ❓ 为什么 1024 entries？和 DirtyCardQueue 的 256 entries 比为什么不同？
  3.1 SATBMarkQueue 继承 PtrQueue → _buf(8KB) + _index + _active
  3.2 ★ 活跃性控制：set_active() / is_active() — ★ 和 DirtyCardQueue 的关键差异（SATB 可停用，DCQ 不）
  3.3 enqueue() 流程：pre_val → _buf[_index--] → buffer 满 → CAS 入队
  3.4 SATBMarkQueueSet 全局管理：_all_active + _shared_satb_queue + set_active_all_threads
  3.5 ★ 为什么非 Java 线程需要 shared queue？（VMThread / CompilerThread 没有 per-thread SATB）
  3.6 BufferNode 池管理（简述，深挖在 [04 §三]）

§四 ★★ SATB 激活/停用生命周期
  ❓ 什么时候激活？什么时候停用？不激活时 overhead 多大？
  4.1 ★ 激活点：并发标记开始（Initial Mark → CMCreateMarkRootsTask → set_active_all_threads(true)）
  4.2 ★ 停用点：并发标记结束（Cleanup → set_active_all_threads(false)）
  4.3 ★ 线程创建时的特殊处理：on_thread_attach → 如果在并发标记中，手动激活
  4.4 ★ 线程销毁时的 flush：on_thread_detach → flush SATB buffer → CAS 入队
  4.5 Mermaid：SATB 激活/停用时间线（与并发标记各阶段的关系）[06 引用]

§五 ★★ SATB drain 在并发标记中的位置
  ❓ 为什么 SATB drain 是 do_marking_step 的最高优先级？
  5.1 drain_satb_buffers() 的调用位置（do_marking_step 的第一步）
  5.2 apply_closure_to_completed_buffer → make_referent_alive → push mark stack
  5.3 ★ 和 G1CMTask 其他步骤的优先级对比：drain_satb > drain_local > drain_global > scan > steal
  5.4 ★ Remark 阶段：为什么 STW drain SATB 必不可少？（详述并发标记完成瞬间的 race condition）
  5.5 GC log 验证：Remark 阶段 drain 的 SATB buffer 数量

§六 ★ 面试问题合集
  Q1: SATB 和 CardTable 两个 barrier 有什么区别？
     要求：6+ 维度对比表（触发条件/时机/存储内容/consumer/队列大小/激活条件），
     明确引用 [04 §二.3] 和 [04 §三.2]
  Q2: 增量更新（IU）和 SATB 哪个更好？
     要求：不是"谁更好"——是"适合不同的堆大小"。
     CMS（<4GB）用 IU，G1（8-64GB）用 SATB——核心差异是 Remark 成本。
  Q3: ★★★ 为什么 G1 选 SATB 而不是增量更新？（深入展开）
     要求至少从 3 个架构角度论证：
     (1) G1 的 Region-based + Evacuation 模型让 Floating Garbage 容忍度更高
     (2) SATB 的 Remark 时间 = O(SATB entries)，不随堆大小/脏卡数增长——这对 8GB+ 堆至关重要
     (3) Mixed GC 选策需要精确 liveness 预测（G1Policy），SATB 可预测的 remark 时间让预测模型更准确
  Q4: Remark 阶段为什么要 STW？
     要求：描述并发标记完成瞬间的 race condition timeline
  Q5: 并发标记期间线程被创建，它的 SATB 是激活的吗？
     要求：走读 on_thread_attach 的源码逻辑
  Q6: SATB buffer 满了会导致漏标吗？
     要求：不会——满了 CAS 入队，标记线程 drain。但如果标记线程来不及 drain → Remark 兜底。

§七 GDB 验证 + 可证伪断言（≥6 条）
  断言 1: SATB buffer size = 1024 × 8B = 8KB
  断言 2: G1SATBBufferSize=1024 常量验证
  断言 3: _satb_mark_queue_set._all_active 在并发标记前/后验证
  断言 4: on_thread_attach 中 SATB 激活逻辑（触发方法：在并发标记期间 `new Thread().start()`，断点验证新线程的 SATB _active=true）
  断言 5: shared_satb_queue 存在性验证
  断言 6: Remark 阶段 drain SATB buffers 的数量（GC log 验证）
          JVM 参数：`-Xlog:gc+marking=trace` 或 `-Xlog:gc+remset=trace`
          预期日志：`Concurrent Mark Remark ... SATB buffers processed: N`
  断言 7: _all_active 字段的切换时机（GDB 断点在 set_active_all_threads）
```

---

## 五、交叉引用

| 引用点 | 本文位置 | 目标文档 |
|--------|---------|---------|
| PtrQueue 基类协议（无锁 bump-pointer + CAS head） | §三（简述） | `[04-CardTable-RSet §三]` |
| write_ref_field_post（后屏障） | §二（对比） | `[04-CardTable-RSet §二]` |
| DirtyCardQueue 生产者-消费者协议 | §三（对比） | `[04-CardTable-RSet §3.2]` |
| do_marking_step 逐行走读 | §五（drain 位置简述） | `[06-ConcurrentMark-Core]` |
| 并发标记各阶段 | §四（激活/停用时间线） | `[07-ConcurrentMark-Phases]` |
| HeapRegion TAMS 概念 | §一（快照边界） | `[01-HeapRegion §三]` |

---

## 六、写作要求

1. **★ 每节以"❓ 为什么..."开头**
2. **★ 设计替代分析**：SATB vs 增量更新是本文的核心对比主题——必须通过具体的漏标时间线走读来论证
3. **★ 可证伪断言 ≥6 条**（含 GDB 命令 + 预期输出）
4. **★ Mermaid 图 ≥3 张**：漏标三条件时序 + SATB buffer 流转 + 激活/停用时间线
5. **★ 和 04 的对比表**：pre-barrier vs post-barrier 的 6+ 维度对比
6. **★ 源文件行号全部 grep 验证后再写**（不直接引用本文档中的行号）
7. **★ 和 04 不重复**：04 深挖了 PtrQueue 基类协议 + DirtyCardQueue → 本文引用即可，聚焦 SATB 的独特语义（active/deactivate、drain 优先级、shared queue、Remark 补刀）
8. **★ 面试友好**：§六 面试问题合集覆盖 6+ 个 SATB 高频问题，每个都有一句话回答 + 展开讲解
9. **★ 核心叙事线完整**：从 `write_ref_field_pre` 内联代码出发，追踪到 `enqueue` → `CAS` → `drain_satb_buffers` → `make_referent_alive` → `Remark`，并在每个环节回答"为什么这个设计"

---

## 七、输出格式

- Markdown 文件，命名为 `05-SATB-Barrier.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/06-gc-memory/`
- 元信息头：标准环境 + 源文件清单（9 文件，行号 grep 验证）+ 前置依赖（已读 01/04）+ 阅读收益
- 阅读收益强调：读完本文后能回答"如果面试官问'G1 的 SATB 是什么？为什么不记录新值？'——你能从漏标三条件出发，讲清楚 SATB 的 correct 性保证、和增量更新的取舍、从 pre-barrier 到 Remark 的完整数据流，并精准对比 pre/post-barrier 的 6+ 个维度差异"
