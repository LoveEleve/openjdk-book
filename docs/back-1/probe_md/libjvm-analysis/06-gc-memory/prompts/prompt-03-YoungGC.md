# PROMPT: 请撰写 03-YoungGC.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**G1 Young GC — 从 G1Policy 主动调度到 Free CSet 的全链路**

### 核心故事线（禁止做源码翻译机！）

你已经读了 01（HeapRegion）、02（ObjectAllocation，刚修正完触发器描述）和 10（PLAB），现在可以回答整个 Young GC 流程了。但要特别注意——

**★ 02 刚被修正过一个关键错误**：02 之前错误地声称"GC 只在 Eden 真正耗空时才触发"。修正后的正确模型是：

> G1 的 Young GC 有**两条触发路径**：
> - **主路径**：G1Policy 维护 `_young_list_target_length`（约 102-256 Regions），当 Eden Region 数达到目标时主动发起 GC。这是先发制人的调度。
> - **后备路径**：`attempt_allocation_slow` 的 retry loop。当 mutator 分配速度超过了 policy 的预测，Eden 在实际 GC 之前就满了，`attempt_allocation_locked` 尝试换新 Region 但被 policy 拒绝（young gen 已达 `_young_list_max_length`），走 `do_collection_pause` 兜底。

本文必须从这个正确的触发器模型出发。

**❓ `do_collection_pause` 的 4 个阶段（Pre→Evacuate→Post→Free CSet）各自解决什么问题？如果跳过某一阶段会怎样？**

```
G1Policy 判断 young gen 已达目标 → 或 allocation failure 兜底
  → G1CollectedHeap::collect(GCCause::_g1_inc_collection_pause)
    → VM_G1CollectForAllocation → VMThread::execute()
      → do_collection_pause_at_safepoint()
        → do_collection_pause(word_size, gc_count_before, &succeeded, cause)
          │
          ├─ Phase 1: Pre-Evacuate（准备阶段）
          │   → Prepare CSet Regions（收集+锁定边界）
          │   → 初始化 G1ParScanThreadStateSet（per-worker 状态，延迟创建）
          │   → 启动 GC alloc region（Survivor/Old），调用 note_start_of_copying
          │     ★ 仅在 Initial Mark GC 时修改 TAMS（_next_top_at_mark_start）
          │     ★ 普通 Young GC 不修改 TAMS（保持上一次并发标记的边界）
          │
          ├─ Phase 2: Evacuate（核心疏散）★ 本文主战场
          │   → 10 种 GC Root 的并行扫描（每种策略不同，为什么？）
          │   → RSet 扫描：oops_into_cset_do（简述→ [04] 深挖）
          │   → copy_to_survivor_space（PLAB 四级降级→ [10] 深挖）
          │   → TaskQueue + Work Stealing + Termination Protocol
          │
          ├─ Phase 3: Post-Evacuate（收尾）
          │   → Reference Processing（Soft/Weak/Phantom/Final→ [11] 深挖）
          │   → Redirty Cards + RSet 清理
          │   → Evacuation Failure 处理（G1ParRemoveSelfForwardPtrsTask）
          │
          └─ Phase 4: Free CSet（释放回收）
              → 释放 CSet Regions 回 free_list
              → survivor Regions 保留到下次 GC（age++）
              → 统计反馈闭环（AgeTable→晋升阈值, PLABStats→PLAB size）
```

**核心洞察**：Young GC 的 Evacuation 阶段不是"先扫描全部根→再批量复制→再更新引用"的顺序模型，而是**交织的流水线**：扫描到引用 → 立即 copy_to_survivor_space → 返回 forwarding pointer → 更新当前引用 → 将新复制对象的字段推入 task queue → 继续扫描。这种交织使得单次遍历就能完成"发现活对象 + 复制 + 更新引用"。

### 核心叙事线（10 个"为什么"问题，每个必须有源码回答）

1. **❓ Young GC 什么时候触发？正确的回答是什么？（★ 本文第一问，必须和修正后的 02 一致）** 

   不要只说"分配失败就 GC"。真正的答案有两层：
   
   **主路径 — G1Policy 主动调度**：G1Policy 维护 `_young_list_target_length`（当前年轻代应该有多少个 Region，由 `G1Policy::update_young_list_target_length` 动态计算，受 `G1NewSizePercent`=5%~60% 约束）。当 Eden Region 数达到目标时，G1Policy 通过 `G1CollectedHeap::collect(GCCause::_g1_inc_collection_pause)` 主动发起 GC。**这是在堆还远未耗尽时先发制人的 GC——保证 GC 停顿可预测，也保证始终有充足空闲 Region 供 mutator 分配。**
   
   **后备路径 — 分配失败兜底**：当 mutator 分配速度超过 policy 预测，TLAB refill → Eden CAS → Heap_lock + `attempt_allocation_locked` → 尝试换新 Region 但失败（可能因为 free_list 中没有可分配为 Eden 的 Region，或 young gen 已达上限）→ `do_collection_pause` 兜底。此路径概率极低——G1Policy 的主动调度在绝大多数情况下已经提前 GC 了。源码 `g1CollectedHeap.cpp:431-550` 的 `attempt_allocation_slow` retry loop。
   
   追问：**为什么 G1Policy 不等 Eden 真正耗尽再 GC，而要"先发制人"提前 GC？** → 三个原因：(a) 提前 GC 保证有足够的空闲 Region 应对 Humongous 分配和 Old Gen 晋升；(b) 停顿时间可预测——Eden 大小决定了每次 GC 的存活对象量上限；(c) 如果没有空闲 Region，当 Humongous 分配或晋升突然到来时只能走 Full GC。
   
   追问：**`_young_list_target_length` 是怎么算出来的？** → `G1Policy::update_young_list_target_length(rs_lengths)` 基于 RSet 扫描成本、预期存活率、停顿时间目标综合计算。深挖在 [08-MixedGC-Policy]。

2. **❓ 为什么 G1 选择 Evacuation（复制）回收 Young，而不是 Mark-Sweep（标记清除）？** 
   
   不要只说"复制解决了碎片"。要给出数字级论证：
   - 年轻代存活率低（通常 <10%）：复制只搬运活对象（开销 ∝ 存活量），清除需要扫描全部（开销 ∝ 总量）
   - 复制天然压缩：新对象紧凑排列在目标 Region，无碎片
   - forwarding pointer（markOop CAS）是 per-object 无锁的
   - 但复制需要额外空间（to-space）→ G1 通过 free_list 保证始终有充足空闲 Region
   
   追问：**如果存活率 >50%，复制还最优吗？** → 此时 copying cost 超过 scanning cost，Mixed GC（只回收部分 Old Region，使用 Mark-Compact）或 Full GC 更优。追问：**为什么 Full GC（[09-FullGC]）用 Mark-Compact 而不是 Evacuation？** → 简述：无 to-space 可用时无法复制。

3. **❓ Pre-Evacuate 阶段到底准备了什么？为什么需要 Prepare + Register 两步？**

   Prepare：选择 CSet Region（哪些 Region 参与本次 GC）。为什么要在 safepoint 做？因为并发标记可能同时在修改 Region 状态。
   Register：锁定 CSet Region 的边界，启动 GC alloc region（target space）。`note_start_of_copying()` 在 target region 上设置——**仅在 Initial Mark GC 时修改 `_next_top_at_mark_start`**（先设为 `end()` 再在 `note_end_of_copying` 时设为 `top()`）。普通 Young GC 不修改 TAMS，保持上一次并发标记的边界。
   `G1ParScanThreadStateSet`：为每个 GC worker 延迟创建 `G1ParScanThreadState`（包含 PLAB、AgeTable、TaskQueue 等 per-worker 资源）。

   追问：**为什么 per-worker 状态要延迟创建而不是在 GC 开始时就全部建好？** → 节省不需要的 worker 的初始化开销。实际活跃 worker 数可能小于 `ParallelGCThreads`。

   **★ 两种 Young GC 的区分**：本文主线是 Regular Young GC。Initial Mark Young GC（在 `VM_G1CollectForAllocation` 中 `should_initiate_conc_mark=true`）多了：
   | 差异项 | Regular Young GC | Initial Mark Young GC |
   |--------|-----------------|----------------------|
   | TAMS | 不修改 | `note_start_of_copying(true)` → `_next_top_at_mark_start = end()` → `note_end_of_copying(true)` → 设为 `top()` |
   | Root 扫描 | 标准 10 种 | 多了 `CodeCache::scavenge_root_nmethods_do`（为并发标记提供初始 root） |
   | SATB | 不激活 | 激活 `G1SATBCardTableModRefBS::set_active(true)` |
   | 并发标记 | 不启动 | 启动 `G1ConcurrentMarkThread` |

4. **❓ GC Roots 为什么有 10 种？每种扫描策略为什么不同？**

   按扫描策略分 5 组，每组解释为什么走这个策略：
   - **(A) Frame walk（OopMap 驱动）**：Java 线程栈。为什么需要 OopMap？栈帧中 oop 位置是运行时变动的，只有 JIT 编译器生成的 OopMap 知道哪些 slot 是引用。
   - **(B) OopStorage 迭代**：JNI handles、StringTable、SymbolTable。为什么 JNI handles 从 JDK 10 开始改用 OopStorage？支持无锁并发分配、block 级迭代，避免传统链表遍历的 O(n) 和全局锁。
   - **(C) CodeCache 遍历**：nmethod 中的嵌入式 oop。为什么不能走普通 oop_iterate？nmethod 中的 oop 可能被 IC 缓存或压缩为 narrowOop。
   - **(D) VM 内部结构**：SystemDictionary、ClassLoaderDataGraph、Management。为什么这些数据结构不通过 OopMap 暴露？它们是 JVM 内部引用，没有对应的 Java 栈帧。
   - **(E) Synchronizer**：ObjectMonitor 中的对象引用。为什么在 safepoint 可以安全遍历？所有 mutator 已停，锁状态一致。
   
   追问：**为什么 GC Root 扫描必须放在 Evacuation 之前而不是之后？** → 如果放在之后：根引用的对象可能已经被其他 worker 复制了→重复复制。正确的顺序：扫描根→发现引用→立即 copy_to_survivor_space→return forwarding pointer→后续引用通过 forwarding pointer 避免重复复制。

5. **❓ RSet 扫描（oops_into_cset_do）为什么在 Evacuation 中而不是 Pre 或 Post？**

   简述 RSet 三级结构（SparsePRT→FinePRT→Coarse），为什么 RSet 是"垃圾回收的逆索引"（garbage-in→roots-out：Region A 引用了 Region B，RSet 记录在 B 上——要回收 B 时，扫描 B 的 RSet 就知道哪些 Region 可能引用了它）。RSet 扫描和 GC Root 扫描为什么缺一不可？（GC Root 管 JVM 内部引用，RSet 管跨 Region 引用。）
   
   深挖在 [04-CardTable-RSet]。

6. **❓ `copy_to_survivor_space` 为什么先 PLAB allocate 再 CAS forward，而不是反过来？**

   简述结论并引用 [10-PLAB §三]。本文只讲在 Young GC Evacuation 上下文中的调用链（Level 1→2→3→4→CAS→memcpy→age→return），不深挖 PLAB 内部。重点：
   - `forward_to_atomic` 为什么用 `memory_order_relaxed` 而不是 `memory_order_seq_cst`？→ GC 期间 mutator 已停，无并发写入，relaxed 已足够保序。
   - CAS forward 成功后为什么立即 memcpy？因为 winner 已经预分配了空间，别人不可能再用这块空间。
   - CAS forward 失败后为什么 `undo_allocation` 回退 bump-pointer？因为 loser 预分配的空间被浪费了。

7. **❓ 工作窃取（TaskQueue + Termination Protocol）——为什么 G1 用 TaskQueue 而不是 work-stealing deque？**

   - `StarTask` 的编码：一个 `void* _holder` 同时容纳 `oop*` 或 `narrowOop*`，最低位区分类型
   - `OverflowTaskQueue`：正常 push/pop_local + 满时 push_overflow（overflow stack 不参与 steal——因为它是 per-worker 私有的）
   - `ParallelTaskTerminator`：全 worker 队列都空时退出。但会产生"假终止"：Worker-A 的队列空了→offer_termination→此时 Worker-B 还在往 A 的队列 push→需要 `peek_in_queue_set` 多轮检查
   - 为什么 Termination Protocol 没有固定轮数？每个 worker 独立维护 `_offered_termination` 标志，没有中心化计数器

   追问：**为什么 overflow stack 不参与 steal？** → overflow stack 是 LIFO 而非 FIFO——push_overflow 是"暂时溢出"，期望本 worker 后续自己 pop 回来，steal 方应该先偷 queue（FIFO，存的是正常 task）。

8. **❓ Evacuation Failure 的处理为什么不仅仅是"标记失败→跳过"？**

   源码 `handle_evacuation_failure_par` + `G1ParRemoveSelfForwardPtrsTask`：
   (a) CAS 设置 markOop self-forwarding pointer
   (b) 标记 Region `evacuation_failed`
   (c) Post-Evacuate：`G1ParRemoveSelfForwardPtrsTask` 遍历 Collection Set（仅处理 `evacuation_failed()` 的 Region），为自转发对象重建 RSet + 标记 bitmap
   
   追问：**为什么需要 `RemoveSelfForwardPtrObjClosure` 额外遍历一遍？** → 自转发对象没有真正被复制 → 它的 RSet 可能过期（原来记录的跨 Region 引用可能指向已回收的 Region）→ 需要重建以保证后续 GC 的 RSet 扫描正确。

9. **❓ AgeTable 和 SurvRateGroup 为什么是 Young GC 的"双轨"统计？**

   - **AgeTable**：per-worker 累加 → flush 到 G1Policy → `compute_tenuring_threshold()` → 决定下次 GC 的晋升阈值。采样统计（不是精确计数：`add(age, word_sz)` 是累加大小而非哈希）。
   - **SurvRateGroup**：预测不同年龄 Region 的存活率（用于 CSet selection 和停顿预测）。
   
   追问：**为什么需要两个存活率统计？** → AgeTable 管晋升决策（这个对象该不该去 Old），SurvRateGroup 管回收效率预测（这个 Region 回收后能腾出多少空间）。一个是对象级，一个是 Region 级。

10. **❓ Reference Processing 为什么放在 Phase 3（Post-Evacuate）而不是 Phase 2？**

    Reference 对象（Soft/Weak/Phantom/Final）本身是普通 Java 对象 → 必须先在 Phase 2 被 `copy_to_survivor_space` 复制到新位置 → 复制后才能安全检查 referent 状态 → 如果 referent 已被回收→加入 pending list。
    
    如果放在 Phase 2：Reference 对象还没被复制 → 尝试处理可能导致 use-after-copy 或状态不一致。简述→ [11-Reference-Processing] 深挖。

### 本文和 01/02/10 的关系

- **01** 讲了 Region 是什么（字段、TAMS、free_list、初始化）
- **02** 讲了 mutator 怎么分配（TLAB → Eden → Heap_lock 五级降级）+ Young GC 的两条触发路径
- **10** 讲了 GC worker 怎么分配（PLAB → 换代 → direct → EvacFail 四级降级）
- **03** 是缝合层：把 01 的 Region 知识、02 的触发链、10 的 PLAB 分配串联成一条完整的 Young GC 执行线，并扩展覆盖 Root 扫描、RSet 扫描、TaskQueue/Steal、Reference 处理

### 禁止行为

- ❌ 把 10 种 GC Root 名字列出来说"这些是 Root"——按扫描策略分组，每组的"为什么"有源码回答
- ❌ 把 4 个阶段贴函数名然后说"这是四阶段"——每阶段回答"为什么需要这个阶段 / 如果跳过会怎样"
- ❌ 只讲"G1 用复制 GC"不说为什么——对比 Mark-Sweep/Mark-Compact，给数字
- ❌ TaskQueue 只讲"有队列可以 steal"——要讲 StarTask 编码、overflow 协议、Termination Protocol 为什么没有固定轮数
- ❌ 不讲 GC 触发模型随 02 修正后的正确理解

### 要求行为

- ✅ **★ 每节以"❓ 为什么..."开头**
- ✅ **★ Young GC 触发模型必须和修正后的 02 一致**：两条路径（G1Policy 主动 + 分配失败兜底），不做"Eden 耗空"式的错误简化
- ✅ **★ GC Root 分类 Mermaid 图**：按扫描策略分 5 组（Frame walk / OopStorage / CodeCache / VM internal / Synchronizer）
- ✅ **★ 四阶段 Mermaid 流程图**：标注各阶段的数据流动和关键决策点
- ✅ **★ Evacuation 阶段 Mermaid 序列图**：Worker-1/Worker-2 并行→Root 扫描→push task queue→steal→Termination
- ✅ **★ TaskQueue + Termination Protocol 专题小节**（~150 行）：StarTask 编码 + OverflowQueue + Termination 协议
- ✅ **★ GDB 验证 ≥8 条**：
  - 1) `_young_list_target_length` 在 GC 前后的值（GDB b G1Policy::record_young_collection）
  - 2) CSet 注册后的 Region 状态（GDB 打印 Region type + young_index_in_cset）
  - 3) `G1ParScanThreadState` 的 per-worker 字段布局（ptype/o）
  - 4) `StarTask` sizeof + 编码验证（低位 bit 区分 narrow/wide）
  - 5) `copy_to_survivor_space` 中 PLAB allocate 前后 `_top` 变化
  - 6) CAS forward `forward_to_atomic` 的 memory_order_relaxed 实际用了一个 mfence 吗？（x86 下 lock cmpxchg 自带 full barrier）
  - 7) TaskQueue `push`/`pop_local` 前后容量变化
  - 8) `AgeTable::compute_tenuring_threshold()` 的输出值
- ✅ **★ 和 02/10 不重复**：02 讲分配触发、10 讲 PLAB 内部——03 讲"这些机制在 Young GC 全流程中怎么串联"
- ✅ **★ 交叉引用精确**：copy_to_survivor_space → [10-PLAB §三]；RSet 扫描 → [04-CardTable-RSet]；SATB → [05]；Ref Processing → [11]；G1Policy → [08]

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
| 1 | `g1CollectedHeap.cpp` | gc/g1 | `do_collection_pause_at_safepoint()`(L3639), `do_collection_pause()`(L3335), `collect()`(L2820), `attempt_allocation_slow()`(L431) | ★★★ GC 入口 + 四阶段调度 |
| 2 | `g1CollectedHeap.hpp` | gc/g1 | `do_collection_pause()` 声明, `RefToScanQueue` typedef(L98) | ★★★ 类声明 |
| 3 | `g1ParScanThreadState.cpp` | gc/g1 | `copy_to_survivor_space()`(L231-348), `allocate_in_next_plab()`(L159), `handle_evacuation_failure_par()`(L380) | ★★★ 疏散核心逻辑 |
| 4 | `g1ParScanThreadState.hpp` | gc/g1 | `class G1ParScanThreadState`(L45), `_plab_allocator`(L52), `_age_table`(L54) | ★★★ per-worker 状态定义 |
| 5 | `g1ParScanThreadState.inline.hpp` | gc/g1 | `do_oop_evac()`(L33), `steal_and_trim_queue()`(L141) | ★★ 内联 fast path |
| 6 | `g1RootProcessor.hpp/cpp` | gc/g1 | `evacuate_roots()`, `process_java_roots()` 等 | ★★★ 10 种 Root 扫描调度 |
| 7 | `g1RootClosures.hpp/cpp` | gc/g1 | `G1EvacuationRootClosures`, `G1ParCopyClosure` | ★★ Root 闭包集 |
| 8 | `g1OopClosures.hpp/inline.hpp` | gc/g1 | `G1ParCopyClosure`, `G1ScanEvacuatedObjClosure` | ★★ 复制+扫描闭包 |
| 9 | `taskqueue.hpp/inline.hpp` | gc/shared | `GenericTaskQueue`, `StarTask`, `ParallelTaskTerminator` | ★★★ TaskQueue + Work Stealing |
| 10 | `g1Policy.hpp/cpp` | gc/g1 | `_young_list_target_length`, `_young_list_max_length`, `update_young_list_target_length()` | ★★ Young GC 触发决策 |
| 11 | `vm_operations_g1.hpp/cpp` | gc/g1 | `VM_G1CollectForAllocation`, `VM_G1CollectFull` | ★★ VM Operation 封装 |
| 12 | `g1EvacFailure.hpp/cpp` | gc/g1 | `G1ParRemoveSelfForwardPtrsTask` | ★★ Evacuation Failure 处理 |
| 13 | `ageTable.hpp/cpp` | gc/shared | `AgeTable`, `compute_tenuring_threshold()` | ★★ 晋升阈值计算 |
| 14 | `survRateGroup.hpp/cpp` | gc/g1 | `SurvRateGroup`, `surv_rate_pred` | ★ 存活率预测 |

> 以上行号均需在撰写前 grep 验证，不可直接引用。

---

## 四、文章结构（§〇 ~ §八 + 附录）

```
§〇 源文件清单（14 文件，标注模块归属 + grep 验证行号）

§一 ★ 全景 — Young GC 何时触发？两条路径
  ❓ Young GC 什么时候触发？主路径（G1Policy 主动）+ 后备（分配失败兜底）
  1.1 G1Policy 的 _young_list_target_length 是什么？怎么算的？
  1.2 attempt_allocation_slow 的后备 GC 路径
  1.3 两条路径的时序关系（为什么后备路径几乎不走？）
  1.4 ★ Mermaid：两条触发路径汇聚到 do_collection_pause

§二 ★★ 四阶段总览 — do_collection_pause 的调度
  ❓ 为什么需要四个阶段？如果合并 Pre+Evac 或 Post+Free 会怎样？
  2.1 Phase 1: Pre-Evacuate — 准备 CSet + per-worker 状态
  2.2 Phase 2: Evacuate — 核心疏散（本节概述，§三-§六展开）
  2.3 Phase 3: Post-Evacuate — Reference + 清理
  2.4 Phase 4: Free CSet — 释放回收 + 统计反馈
  2.5 ★ Mermaid：四阶段全流程（标注关键数据流动）

§三 ★★★ 根扫描 — 10 种 GC Root 的并行遍历
  ❓ 为什么 GC Root 扫描有 10 种而不是一种统一的？
  3.1 GC Root 五组分类（按扫描策略）— Frame walk / OopStorage / CodeCache / VM internal / Synchronizer
  3.2 G1RootProcessor 的并行调度（如何分配 Root 给不同 worker？）
  3.3 G1ParCopyClosure：遇到 Root 引用→立即 copy_to_survivor_space
  3.4 ★ Mermaid：10 种 Root 的分类树

§四 ★★ RSet 扫描 — 跨 Region 引用的逆索引
  ❓ RSet 扫描和 GC Root 扫描为什么缺一不可？
  4.1 RSet 的三级结构简述（SparsePRT→FinePRT→Coarse, 深挖→[04]）
  4.2 oops_into_cset_do：从 RSet 反推引用方 Region→逐卡扫描→发现引用→push task_queue
  4.3 ★ 为什么 RSet 扫描放在 Evacuation 中而不是 Pre-Evacuate？

§五 ★★★ 疏散核心 — copy_to_survivor_space 全流程
  ❓ 为什么先 allocate 再 CAS forward，不是反过来？
  5.1 四级降级链概述（bump→refill→换代→EvacFail, 深挖→[10-PLAB]）
  5.2 CAS forward（forward_to_atomic + memory_order_relaxed 的语义）
  5.3 memcpy + age 递增 + AgeTable::add
  5.4 ★ 和 10-PLAB 的交叉引用边界（本文讲调用链, 10 讲 PLAB 内部）

§六 ★★ TaskQueue + Work Stealing
  ❓ 为什么 G1 用 TaskQueue 而不是 work-stealing deque？
  6.1 StarTask 编码（void* _holder + 低位 bit 区分 narrow/wide）
  6.2 OverflowTaskQueue：push/pop_local + push_overflow（为什么 overflow 不 steal）
  6.3 ParallelTaskTerminator：全队列空→退出（假终止 + 多轮 peek）
  6.4 steal_and_trim_queue：随机 victim + trim 到阈值
  6.5 ★ Mermaid：Worker-A steal from Worker-B 的完整时序

§七 ★★ Survivor 管理 + Evacuation Failure
  ❓ survivor Regions 为什么不释放？Evac Failure 为什么不能简单跳过？
  7.1 survivor Regions 保留（age++ → 下次 GC）
  7.2 Evacuation Failure：self-forward + G1ParRemoveSelfForwardPtrsTask
  7.3 AgeTable + SurvRateGroup 的双轨统计

§八 ★★ Post-Evacuate + Free CSet
  ❓ Reference Processing 为什么必须在 Phase 3？
  8.1 Reference Processing 简述（→[11] 深挖）
  8.2 Redirty Cards + RSet 清理
  8.3 释放 CSet Regions 回 free_list（O(Regions) 不是 O(Heap)）

§九 GDB 验证 + 可证伪断言（≥8 条）
  断言 1: G1Policy._young_list_target_length 在 GC 前后的变化
  断言 2: CSet 注册后 Region 的 young_index_in_cset 和 evacuation_failed 标志
  断言 3: G1ParScanThreadState 的 sizeof + 字段 offset（ptype/o）
  断言 4: StarTask sizeof + 低位编码（GDB 打印地址最低位）
  断言 5: PLAB._top 在 copy_to_survivor_space 前后的变化
  断言 6: TaskQueue push/pop_local 前后容量
  断言 7: AgeTable::compute_tenuring_threshold() 输出值
  断言 8: worker 0 和 worker N 的 _objects_copied 差值（验证工作窃取均衡性）
```

---

## 五、交叉引用

| 引用点 | 本文位置 | 目标文档 |
|--------|---------|---------|
| Region TAMS/状态机/free_list | §二（Pre+Free） | `[01-HeapRegion]` |
| G1 分配五级降级链 + 两条触发路径 | §一（触发） | `[02-ObjectAllocation §一]` |
| copy_to_survivor_space→PLAB 四级降级 | §五（深挖引用） | `[10-PLAB §三]` |
| RSet 三级结构 + oops_into_cset_do | §四（深挖引用） | `[04-CardTable-RSet]` |
| SATB 在 Initial Mark 中的角色 | §一 | `[05-SATB-Barrier]` |
| G1Policy + IHOP + young_list_target_length | §一（深挖引用） | `[08-MixedGC-Policy]` |
| Reference Processing | §八（深挖引用） | `[11-Reference-Processing]` |
| Full GC (GC escalation 终点) | §二（简述） | `[09-FullGC]` |

---

## 六、写作要求

1. **★ 每节以"❓ 为什么..."开头**
2. **★ Young GC 触发模型必须和修正后的 02 一致**（两条路径，不是"Eden 耗空"）
3. **★ Mermaid 图 ≥4 张**：触发路径汇聚、四阶段全流程、GC Root 分类树、TaskQueue 窃取时序
4. **★ 设计替代分析**：每回答一个"为什么 X"，追问"如果不用 X 而用 Y 会怎样"
5. **★ 可证伪断言 ≥8 条**（含 GDB 命令 + 预期输出）
6. **★ 源文件行号全部 grep 验证后再写**（不可直接引用本文档中的行号）
7. **★ 和 02/10 不重复**：02 讲分配、10 讲 PLAB 内部——03 是缝合层，讲这些机制在 Young GC 全流程中怎么串联
8. **★ 特别注意不造"全局耗尽"式的结论**：G1 的 GC 是先发制人的主动调度，不是被动的应急响应

---

## 七、输出格式

- Markdown 文件，命名为 `03-YoungGC.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/06-gc-memory/`
- 元信息头：标准环境 + 源文件清单（14 文件，行号 grep 验证）+ 前置依赖 + 阅读收益
- 阅读收益强调：读完本文后能回答"G1 Young GC 为什么是先发制人的主动调度而非被动应急响应？从 G1Policy 决策到 Free CSet 的全链路每一步在做什么、为什么是这个顺序？"
