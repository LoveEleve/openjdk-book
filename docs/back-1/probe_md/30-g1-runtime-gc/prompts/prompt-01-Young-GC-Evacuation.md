# PROMPT: 请撰写 01-Young-GC-Evacuation.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

线上 8GB G1 堆，每次 Young GC 暂停 120ms（期望 <30ms）。`jstat -gcutil <pid> 1000` 显示 Eden 38%、Survivor 99.9%、Old 72%、YGCT 均值 120ms——Survivor 总是在满的状态，表明晋升压力极大。GDB 附加 `gdb -ex "print G1CollectedHeap::heap()->_collection_set.region_length()"` 发现 CSet 中 200+ region。进一步 `gdb -ex "break copy_to_survivor_space" -ex "continue"` 发现 8000+ dirty cards + Humongous 疏散失败——`_plab_allocator->allocate_direct_or_new_plab` 返回 NULL 触发 `handle_evacuation_failure_par()`。

根因：PLAB 缓冲区太小（`-XX:ParallelGCBufferWastePct=5` 默认仅 5%）→ Worker 频繁从 PLAB 分配失败 → 退到 G1AllocRegion 走锁路径 → 多个 worker 串行化在 FreeList_lock → 6 worker 的实际并发度仅 ~1.3×。加上 RSet 粗粒度退化导致扫描 8000+ dirty cards（正常应 <500），每次 Young GC 在 RSet 扫描阶段耗时 40ms。修复：`-XX:ParallelGCBufferWastePct=10 -XX:ConcGCThreads=4`。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 确认 GC 暂停时间和频率
jstat -gcutil <pid> 1000
# YGCT 递增粒度 = 每停暂停时间，FGC 为 0 表示无 Full GC
# Survivor 总是满 → 晋升路径有问题 → 怀疑 PLAB 大小

# 2. strace 追踪 mmap/futex 确认锁竞争
strace -e trace=futex -f -p <pid> 2>&1 | grep FUTEX_WAIT
# 大量 FUTEX_WAIT 出在 FreeList_lock → 确认 PLAB refill 竞争

# 3. GDB 断点验证 PLAB refill 频率和 forwarding pointer
gdb -ex "break g1ParScanThreadState.cpp:256" \
    -ex "break g1ParScanThreadState.cpp:290" \
    -ex "run" \
    -ex "print plab_refill_failed" \
    -ex "print forward_ptr" \
    --args java -Xms8g -Xmx8g -XX:+UseG1GC -jar app.jar
# plab_refill_failed == true → PLAB refill 失败
# forward_ptr != NULL → 另一个 worker 已经完成疏散（CAS 竞争）
```

**反事实讨论**：
- 如果 PLAB 用全局共享分配器而非 per-worker PLAB → 6 worker 争同一 FreeList_lock → 并发度 ~1.1× → Young GC 耗时 10×。
- 如果 RSet 始终全粗粒度（无 Sparse/Fine） → 每 Young GC 扫描全部 old region 的 card table → 4GB old gen 扫描 ~200ms → 完全不可用。
- 如果 forwarding pointer 用锁而非 CAS → 每个对象疏散需要 1 次 futex → 50ns 变 3μs → Young GC 60× 变慢。

---

## §一 Task + Narrative + Beginner Callouts

### Task

撰写 `01-Young-GC-Evacuation.md`，深度分析 G1 Young GC 的完整生命周期：从 Java 分配失败触发到 Safepoint 同步、根扫描、对象疏散（evacuation）、引用处理、到 Pause 后策略更新。重心在**疏散（evacuation）本身的工程实现**——对象如何从 Eden 被复制到 Survivor/Old、并发 worker 如何协作、forwarding pointer 如何解决并发疏散。

读者已完成 Phase 01 的 `02-G1-Heap-Startup`（1403行）和本文组内 doc-00 `Region-Runtime-Allocation`（覆盖 Region 状态机、TLAB 三层分配、Barrier Set、RSet 数据结构），以及 Phase 15 `System-Arraycopy`（memmove 语义、Klass 虚分派、C2 intrinsic）。本文将 Shrinking-to-Survivor 复制——用 `Copy::aligned_disjoint_words` 做 memmove 类批量拷贝。

**注意**：本文内 Eden 被分配满后，`do_collection_pause_at_safepoint` 的 5 阶段按执行顺序组织——不要按主题分组，必须以时间线为主线，这是工程文档不是百科全书。

### Narrative

"线程 A 在 `memAllocator.cpp:387` 执行 TLAB bump-pointer 分配 → 返回 NULL → `attempt_allocation` CAS 失败 → `do_collection_pause` → VMThread 接收 VM_G1CollectForAllocation → `SafepointSynchronize::begin()` 阻塞所有 mutator 线程进入 Safepoint → `do_collection_pause_at_safepoint()` 启动。5 阶段：前置检查（GCLocker + 存量标记决策）→ CSet 构建（选择高垃圾密度的 Region）→ 疏散执行——`G1ParTask` 启动 6 worker——每个 worker 扫描自己的根集（11 类 VM root 去重 + 线程栈分摊）→ `copy_to_survivor_space` 做 6 步决策：next_state 判断晋升目标 → PLAB 无锁快速分配 → refill → 降级到另一代 → CAS forwarding pointer 安装 → 成功则 `Copy::aligned_disjoint_words` 复制对象体 + 增量 GC 年龄 → 失败则 undo_allocation 返回已转发的 forwardee。RSet 扫描在疏散中执行——worker 扫描 old region 指向 CSet region 的卡表引用。疏散后 ReferenceProcessor 四遍处理 Soft/Weak/Final/Phantom。最后 `record_collection_pause_end` 更新 14 个 TruncatedSeq 预测值和 Age Table——Safepoint 结束，mutator 继续运行。整个过程：0 次全局锁（除 PLAB refill 时），6 个阶段，~30ms（期望）。"

### Interview Story Format Answer（必须出现在 §一 末尾）

"G1 Young GC 的核心是疏散而不是标记。Java 分配失败后 VMThread 在 Safepoint 中执行 `do_collection_pause_at_safepoint` (g1CollectedHeap.cpp:3639)——入口先检查 GCLocker，然后决策 Initial Mark 或 Young-only。`G1ParTask` (g1CollectedHeap.cpp:4096) 启动并行 worker，每个 worker 执行三步：根扫描→RSet 扫描→队列 drain。根扫描中 `SubTasksDone::is_task_claimed` 确保 11 类 VM root 每类只由一个 worker 处理。`copy_to_survivor_space` (g1ParScanThreadState.cpp:231) 的 CAS forwarding pointer 是疏散并发的核心——worker A 和 worker B 可能同时看到同一个 CSet 对象（因为 RSet 扫描发现的引用和根扫描发现的引用可能重复），两者同时尝试疏散——`forward_to_atomic(obj, memory_order_relaxed)` (oop.inline.hpp:373) 这一行 CAS 决定了谁做复制谁退让。CAS 成功者负责复制并扫描子引用；CAS 失败者 undo_allocation 然后收到 forwardee——这正是 Newton 方法说的工作偷取（work stealing）的实际实现。"

### Beginner Callout Boxes（文档中必须出现的 ≥7 个 callout 框）

> **Safepoint**：JVM 中所有 Java 线程必须停止执行的特殊点。Safepoint 的本质是自愿协议——每个 Java 线程运行到检查点（方法返回、循环回边）时主动检查 `SafepointSynchronize::_state == _synchronizing`，然后阻塞自己。`SafepointSynchronize::begin()` (safepoint.cpp:156) 设置 `_state=_synchronizing` 然后轮询 `_waiting_to_block==thread_count`。GC 是 Safepoint 的最大用户，但并非唯一——偏向锁撤销、CodeCache 清理、Class Redefinition 都需要 Safepoint。

> **Forwarding Pointer（转发指针）**：疏散对象时在原对象内存的 mark word 中安装指向新位置的指针。`forward_to_atomic(oop p, memory_order_relaxed)` (oop.inline.hpp:373) 用 CAS 尝试安装——同时只有一个 worker 成功。成功后原对象标记为 `markOopDesc::marked_value (0x3)`。后续任何 worker 做 `is_forwarded()` → `forwardee()` 直接返回新地址——O(1) 去重。注意：forwarding pointer 的值是 `memory_order_relaxed`——因为 Safepoint 内所有线程同步，不存在无 Safepoint 的并发访问。

> **PLAB (Promotion Local Allocation Buffer)**：GC worker 的线程本地分配缓冲区——等价于 mutator 的 TLAB。每个 worker 持有两个 PLAB（Survivor + Old），PLAB 内分配仅 bump-pointer 无需锁。`ParallelGCBufferWastePct`（默认 5%）控制 PLAB 大小。PLAB 空了需要 `allocate_direct_or_new_plab()`——持 FreeList_lock 从空 Region 获取新空间。PLAB refill 是整个 Young GC 中唯一的锁竞争点。

> **CSet (Collection Set)**：当前 GC 暂停中要疏散的 Region 集合。Young GC 的 CSet 包含全部 Eden + Survivor Region；Mixed GC 额外包含精选的 Old Region。CSet 构建在 `finalize_collection_set()` 中——调用 `calc_new_collection_set_regions()` 按 reclaimable bytes 排序 Old Region 候选。CSet 的大小受 `G1MaxCSetRegionPercent`（默认 10% 堆）和 pause time target 约束。

> **RSet (Remembered Set) 两阶段**：RSet 在 Young GC 中有两个阶段——`update_rem_set`（增量处理：从 DirtyCardQueue 消费新发现的脏卡）和 `scan_rem_set`（存量扫描：遍历每个 CSet Region 的 PerRegionTable 找到 old→cset 引用）。update 处理的是 "GC 开始后 mutator 才写入"的引用（通过 DirtyCardQueue）；scan 处理的是 "GC 开始前已有的" 引用（已在 RSet 中）。两个阶段的区分避免了"漏收新引用"的竞争。

> **Root 类型 11 种**：Young GC 根扫描的 11 类根由 `SubTasksDone::is_task_claimed` 去重执行：(1) JNIHandles、(2) ClassLoaderDataGraph、(3) Universe、(4) ObjectSynchronizer、(5) Management、(6) JVMTI、(7) AOT、(8) SystemDictionary、(9) refProcessor、(10) SATB buffer drain、(11) Thread stacks。前三类在 `process_vm_roots` (g1RootProcessor.cpp:246) 中，后 8 类在 `process_java_roots` 中。Thread stack roots 由多个 worker 分摊——每个 worker 只处理自己的线程子集。

> **GC 年龄与 Tenuring Threshold**：每个对象在 mark word 中有 4-bit GC age（0-15）。Survivor 中存活过一轮 GC 的对象 age++。`desired_survivor_size` 和 Age Table 共同决定 `_tenuring_threshold`——当 Survivor 空间紧张时，threshold 降低，更年轻的对象直接晋升 Old。`allocate_in_next_plab()` (g1ParScanThreadState.cpp:159) 检测到 PLAB refill 连续失败 → 设 `_tenuring_threshold=0` → 所有对象强制晋升到 Old。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux (TencentOS Server 4.2)。

Source roots:
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` — do_collection_pause_at_safepoint (:3639-4080, 442行方法体), G1ParTask (:4096-4148), evacuate_collection_set (:4975), post_evacuate (:5026), free_collection_set (:5455)
- `src/hotspot/share/gc/g1/vm_operations_g1.cpp` — VM_G1CollectForAllocation::doit (:78-168), GCLocker 集成
- `src/hotspot/share/gc/g1/g1RootProcessor.cpp` — evacuate_roots (:80), process_java_roots (:224), process_vm_roots (:246)
- `src/hotspot/share/gc/g1/g1ParScanThreadState.cpp` — copy_to_survivor_space (:231-348, 118行核心), allocate_in_next_plab (:159), steal_and_trim_queue
- `src/hotspot/share/gc/g1/g1RemSet.cpp` — oops_into_collection_set_do (:692), update_rem_set (:660), scan_rem_set (:604)
- `src/hotspot/share/gc/g1/g1OopClosures.hpp/cpp/inline.hpp` — G1ParCopyClosure::do_oop_work (:238), G1ScanEvacuatedObjClosure (:75), G1ScanObjsDuringScanRSClosure (:186)
- `src/hotspot/share/gc/shared/referenceProcessor.cpp` — process_discovered_references (:202), process_soft_ref_reconsider (:788)
- `src/hotspot/share/gc/g1/g1EvacFailure.cpp` — handle_evacuation_failure_par, forward_to_atomic on evacuation failure
- `src/hotspot/share/gc/g1/g1Policy.cpp` — record_collection_pause_end (:643-740, 98行)
- `src/hotspot/share/runtime/safepoint.cpp` — SafepointSynchronize::begin (:156), end (:527)

**Source files 与已有 Phase 的不重复边界**：
- `heapRegionRemSet.hpp/cpp` — RSet 数据结构在 doc-00 覆盖，本文只用 `PerRegionTable::card_may_have_entries()` 查询和 `scan_rem_set_roots()` 扫描，不做 `add_reference()` 构建。
- `referenceProcessor.hpp/cpp` — shared 目录共享实现，本文侧重 Young GC 中四遍处理的调用和 `is_alive_closure` 实现。
- `g1BarrierSet` — SATB/Card barrier 在 doc-00 覆盖，本文只在 "根扫描中 barrier 消费 SATB buffer" 和 "update_rem_set 消费 DirtyCardQueue" 中引用。

Build: `make hotspot`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so`

Syscall 速查表:
| syscall | man 页面 | 用途 | 调用位置 |
|---------|---------|------|---------|
| `futex(FUTEX_WAIT)` | `man 2 futex` | Safepoint 线程阻塞 | safepoint.cpp:197 |
| `futex(FUTEX_WAKE)` | `man 2 futex` | Safepoint 结束唤醒 | safepoint.cpp:540 |
| `futex(FUTEX_WAIT)` | `man 2 futex` | FreeList_lock (PLAB refill 唯一锁) | Mutex::lock() 内部 |
| `sched_yield` | `man 2 sched_yield` | 自旋 Safepoint 等待 yield | safepoint.cpp 内 |

/proc 接口:
| 接口 | 内容 | 诊断价值 |
|------|------|---------|
| `/proc/<pid>/status` | VmRSS + voluntary_ctxt_switches | 查看 GC 期间上下文切换频率 → 推断锁竞争 |
| `/proc/<pid>/stat` | 进程状态 + 线程数 | GC 中 state=S (sleeping) → Safepoint 中所有线程 stopped |

---

## §三 Source Files Table

| 文件 | 行数 | 关键类/函数 | 核心功能 |
|------|:---:|---------|---------|
| g1CollectedHeap.cpp (:3335-4020) | 442 | do_collection_pause (3335), do_collection_pause_at_safepoint (3639), evacuate_collection_set (4975), post_evacuate (5026), free_collection_set (5455), G1ParTask (4096) | **Young GC 主循环** — 5 阶段 orchestrator |
| vm_operations_g1.cpp | 280 | VM_G1CollectForAllocation::doit (78), VM_G1CollectFull::doit (37) | VM_Operation 包装 — GC 触发入口 |
| g1ParScanThreadState.cpp | 431 | copy_to_survivor_space (231), allocate_in_next_plab (159) | **Worker 线程疏散引擎** — 6 步决策 + CAS forwarding |
| g1RootProcessor.cpp | 333 | evacuate_roots (80), process_java_roots (224), process_vm_roots (246) | 11 类 Root 扫描 + SubTasksDone 去重 |
| g1RemSet.cpp | 1210 | oops_into_collection_set_do (692), update_rem_set (660), scan_rem_set (604) | RSet 两阶段 — 新引用消费 + 存量扫描 |
| g1OopClosures.hpp/cpp/inline.hpp | ~400 | G1ParCopyClosure::do_oop_work (238), G1ScanEvacuatedObjClosure (75), G1ScanObjsDuringScanRSClosure (186) | **Evacuation 闭包集合** — 引用发现与递归扫描 |
| referenceProcessor.cpp | 1401 | process_discovered_references (202), process_soft_ref_reconsider (788), enqueue_discovered_references | 四遍引用处理 (Soft/Weak/Final/Phantom) |
| g1EvacFailure.cpp | 263 | handle_evacuation_failure_par, self_forwarded | 疏散失败恢复 — self-forwarding + 降级 retry |
| g1Policy.cpp (:643-740) | 98 | record_collection_pause_end (643), record_young_collection_end, revise_tenuring_threshold | Pause 后 14 TruncatedSeq 更新 + 年龄阈值修正 |
| safepoint.cpp (:156,:527) | ~1100 | SafepointSynchronize::begin (156), end (527) | 全局 Safepoint 同步 — 状态机 (_not_synchronized→_synchronizing→_synchronized) |

**行号格式**：所有源文件引用使用 `(:行号)` 格式，与 doc-00 一致。正文讨论的每个文件和函数必须在此表中列出。

**不覆盖的已知边界**：
- ✂ 不覆盖 G1ConcurrentMark 标记周期 — 属于 doc-02
- ✂ 不覆盖 Mixed GC CSet 选择算法 — 属于 doc-03
- ✂ 不覆盖 Full GC Mark→Prepare→Adjust→Compact — 属于 doc-04
- ✂ add_reference 不进 RSet 构建 — 属于 doc-00

---

## §四 Deep Dive Question Groups（≥7 组，每组含 counterfactual + 答案方向 ≥10 行）

### Group 1: GC 触发路径 — Allocation Failure / GCLocker / Humongous Allocation 三种原因

**关键源码**: g1CollectedHeap.cpp:488-500 (正常 do_collection_pause), g1CollectedHeap.cpp:941-950 (humongous 分配失败), vm_operations_g1.cpp:78-168 (VM_G1CollectForAllocation::doit), g1CollectedHeap.cpp:3639-3648 (GCLocker check)

**§四答案方向 (≥10 行, 含 file:line + 追问)**:
- Allocation Failure 是最常见的触发原因。TLAB refill 时 `G1AllocRegion::attempt_allocation()` CAS 失败→`retire()`→`new_alloc_region_and_allocate()`→FreeList 新 region 也失败→`do_collection_pause()` (g1CollectedHeap.cpp:3335)。`do_collection_pause` 多线程重入保护：`MutexLockerEx ml(Heap_lock)` 只允许一个线程启动 GC——其他线程 `wait()` 在 Heap_lock 上直到 GC 完成。
- GCLocker 检查：`check_active_before_gc()` (g1CollectedHeap.cpp:3648)——如果 GCLocker 活跃（JNI GetPrimitiveArrayCritical 正在进行），Young GC 被取消——这是 GCLocker 的"跳过 GC"保护。
- VM_G1CollectForAllocation (vm_operations_g1.cpp:78) 的 doit 包括：IHOP check→并发标记决策→`do_collection_pause_at_safepoint()`→`check_alloc_reserved_after_gc()`→若空间不够再试一次。
- Counterfactual: 如果 `Heap_lock` 允许多线程同时启动 GC → 两个线程同时进入 `do_collection_pause` → 第一个成功回收，第二个在已空堆上继续操作 → 断言失败或 double-free。
- 追问：Humongous 分配触发的 GC 路径与普通 TLAB 耗尽有什么不同？`g1CollectedHeap.cpp:941` 的调用点和 `:488` 的区别——一个在 `attempt_allocation_humongous` 路径，一个在 TLAB refill 路径。

### Group 2: Safepoint 同步机制 — begin→GC→end 的边界和线程状态

**关键源码**: safepoint.cpp:156-200 (begin), safepoint.cpp:527-550 (end), g1CollectedHeap.cpp:3640 (assert_at_safepoint_on_vm_thread), safepoint.cpp:1020-1030 (超时检测)

**§四答案方向 (≥10 行)**:
- `SafepointSynchronize::begin()` 的三步：1) `set_safepointing()` → `_state = _synchronizing` 2) `arm_safepoint()` → 每个 Java 线程检查标志 3) `synchronize_threads()` → 轮询直到所有线程 blocked。自旋策略：10ms 自旋→yield→5ms 自旋→yield→定时唤醒。
- Jave 线程如何检查 Safepoint？在方法返回、循环回边、JNI 边界时检查 `SafepointSynchronize::_state`——通过 `ThreadSafepointState::check_safepoint()` → 若 `_state==_synchronizing` 则 `block()` 在 `ThreadSafepointState::_rollback` 上 `futex_wait`。
- `SafepointSynchronize::end()` (safepoint.cpp:527)：更新 `_safepoint_counter++` → 设置 `_state = _not_synchronized` → 所有阻塞在 `_rollback` 的线程调用 `futex_wake` 唤醒。
- 插桩检测：`INST_LOG_GC("do_collection_pause_at_safepoint: target_pause_time_ms=%.3f", ...)` 记录在 g1CollectedHeap.cpp:3645——G1 的 InstLogger 贯穿 GC 全路径。
- Counterfactual: 如果 Safepoint 用 VM 全局锁代替自愿协议 → 每次 GC 需要中断所有线程 via POSIX 信号 → 信号处理开销 ~5µs per thread × 100 threads = 0.5ms → Safepoint 到达时间不可预测。
- 追问：Safepoint 中 VMThread 挂起和恢复的时序——如果线程 A 在 Safepoint 开始后才进入 JNI 临界区，GCLocker 如何处理？

### Group 3: 根扫描 — 11 种 Root 类型 + SubTasksDone 去重 + CLDG 单 worker

**关键源码**: g1RootProcessor.cpp:80-105 (evacuate_roots), g1RootProcessor.cpp:224-244 (process_java_roots), g1RootProcessor.cpp:246-310 (process_vm_roots), g1RootProcessor.cpp:103-297 (7 类 is_task_claimed 调用)

**§四答案方向 (≥10 行)**:
- `evacuate_roots()` (g1RootProcessor.cpp:80) 的并行策略：`process_java_roots` 分摊——ClassLoaderDataGraph 和 SystemDictionary 只有一个 worker 执行（通过 `SubTasksDone::is_task_claimed`），而 Thread stacks 由多个 worker 平分。也就是说 CLDG 作为整体由一个 worker 独占（避免 CLD 并发遍历的锁开销），但 CLDG 遍历碰到的所有引用对象都由该 worker 递归疏散。
- 11 类 VM 内部 root 的完整列表和去重逻辑（g1RootProcessor.cpp:232-297）：JNIHandles (:260)、CLDG (:232)、Universe (:253)、ObjectSynchronizer (:267)、Management (:274)、JVMTI (:281)、AOT (:289)、SystemDictionary (:297)、ReferenceProcessor (:103)、SATB buffers (:135)、Thread stacks (:224-244)。
- 每个 `is_task_claimed` 调用是 claim-protocol：成功 claim 的 worker 负责该 root 的所有对象——其他 worker 跳过。Thread stacks 不在 SubTasksDone 中，而是用 `ThreadRootsTask` 在 `process_java_roots` 中划分。
- SATB buffer 的过滤：`!is_task_claimed(G1RP_PS_filter_satb_buffers)` (g1RootProcessor.cpp:135)——并发标记进行中时将 SATB buffer 中所有 reference 也当作 root 扫描。
- Counterfactual: 如果 CLDG 不单 worker 独占 → 多个 worker 同时遍历 ClassLoaderDataGraph → CLD 的无锁遍历保证由 `_dependencies` 锁提供 → 但 Java 层的 class loader 已经让 CLDG 足够重（~0.1-1ms 扫描通常的 CLDG），单 worker 足以在暂停时间内完成。
- 追问：11 类 root 中哪种通常最重（最长处理时间）？Thread stacks？CLDG？SystemDictionary？

### Group 4: Evacuation 核心 — copy_to_survivor_space 6 步决策链 + CAS forwarding + Age Table 增量

**关键源码**: g1ParScanThreadState.cpp:231-348 (118行 copy_to_survivor_space), oop.inline.hpp:373 (forward_to_atomic CAS), g1ParScanThreadState.cpp:159-198 (allocate_in_next_plab 降级), g1ParScanThreadState.cpp:308 (_age_table.add)

**§四答案方向 (≥10 行)**:
- 6 步决策链 (g1ParScanThreadState.cpp:231-348)：
  1. `next_state()` (:242) → 从 age 推断 dest 是 Survivor 还是 Old。实现检查 `age < tenuring_threshold` 和 `Survivor space available`。
  2. Old Gen 全满快速失败 (:245-249) → `_old_gen_is_full && dest_state.is_old()` → 直接 `handle_evacuation_failure_par` 返回。
  3. PLAB 快速分配 (:250) → `_plab_allocator->plab_allocate(dest_state, word_sz)` 无锁 bump-pointer。>80% 的分配在此完成（每个 worker 的 PLAB 可容纳数十个对象）。
  4. PLAB 慢速分配 (:254-256) → `allocate_direct_or_new_plab` 持 FreeList_lock 造新 PLAB→`allocate`。最昂贵的路径。
  5. 降级尝试 (:258) → `allocate_in_next_plab(state, &dest_state, word_sz, ...)` 先尝试另一代的 PLAB → 再失败设 `_tenuring_threshold=0` 强制所有对象去 Old。
  6. CAS forwarding pointer (:290) → `old->forward_to_atomic(obj, memory_order_relaxed)`。成功→Copy::aligned_disjoint_words 复制对象体 (:292) + 设置 age (:295-308) + `_age_table.add(age, word_sz)` (:308) + oop_iterate_backwards 扫描子引用 (:341)。

- CAS forwarding 的关键语义 (oop.inline.hpp:373)：`forward_to_atomic(oop p, atomic_memory_order order)` → CAS `_mark` 字段从 `old_mark` 改为 `forward_ptr`。CAS 失败意味着另一个 worker 已安装 forward ptr → `undo_allocation()` (:345) 释放刚才分配的空间 → 返回 `forward_ptr` (forwardee)。`memory_order_relaxed` 是在 Safepoint 内的——不需要同步语义。

- Age Table 增量 (g1ParScanThreadState.cpp:308)：`_age_table.add(age, word_sz)` → `_age_table` 是 `G1SurvivorRegions::_surv_rate_group` 的成员——每个 per-worker 表在 GC 结束时合并（`G1Policy::record_collection_pause_end` 内）。

- 子引用扫描：成功复制对象后 `obj->oop_iterate_backwards(&_scanner)` (:341)——遍历新位置中对象的引用字段，对每个引用调用 `_scanner.do_oop_work` → 最终可能再次调用 `copy_to_survivor_space`（深度优先递归）。

- Counterfactual: 如果 forwarding pointer 用锁而非 CAS → 每个对象疏散需要 1 次 futex → Young GC 中 evac 阶段从 <30ms 变 ~500ms。
- Counterfactual: 如果 PLAB 总是直接用 G1AllocRegion 走锁路径 → 6 workers 串行化在 FreeList_lock → 并发度 ~1.3→ 疏散时间 ×3。

### Group 5: RSet 两阶段 — update_rem_set (新引用消费) → scan_rem_set (存量扫描)

**关键源码**: g1RemSet.cpp:692 (oops_into_collection_set_do 入口), g1RemSet.cpp:660-683 (update_rem_set — 消费 DirtyCardQueue), g1RemSet.cpp:604-630 (scan_rem_set — 扫描 PerRegionTable), g1RemSet.cpp:515-532 (G1ScanRSForRegionClosure::scan_rem_set_roots)

**§四答案方向 (≥10 行)**:
- 两阶段设计的原因：mutator 在 Safepoint 开始后直到真正停止这段时间内（embryo stop phase）仍可能执行 barrier→生成新的 dirty cards→这些 cards 不在已有 RSet 中→必须在 `update_rem_set` 中消费 DirtyCardQueue。
- `update_rem_set` (g1RemSet.cpp:660)：每个 worker 处理 1/n 个 DirtyCardQueue buffer→对每个 dirty card 调用 `G1RefineCardClosure::do_card_ptr()` → 如果 card 指向 CSet region→`G1ConcurrentRefineOopClosure` scan 该卡对应的一小段内存找到引用→加入 worker 的 task queue。
- `scan_rem_set` (g1RemSet.cpp:604)：每个 worker 遍历分配给自己的 CSet region 子集→`G1ScanRSForRegionClosure::scan_rem_set_roots()` (g1RemSet.cpp:515) → 查看该 region 的 PerRegionTable→`card_may_have_entries()` 检查每个 from-region 是否有引用→有则扫描对应卡片→`G1ScanObjsDuringScanRSClosure::do_oop_work` (:186) 对每个发现的对象调用 `copy_to_survivor_space`。
- 去重机制：RSet 扫描发现的对象和根扫描发现的对象可能重复→去重由 CAS forwarding pointer 解决——worker A 根扫描先找到对象 O→成功 CAS forwarding；worker B RSet 扫描后也发现 O→CAS 失败→收到 forwardee→递归扫描 forwardee 的子引用。
- Counterfactual: 如果只有 `scan_rem_set` 没有 `update_rem_set` → DirtyCardQueue 中存留的新引用被遗漏→这些引用指向 CSet object→GC 后 CSet object 被 free→保留的引用变成 dangling ptr→下次访问 SEGV。
- 追问：update_rem_set 中 Hot Card Cache 的作用——为什么不是直接从 DirtyCardQueue 而是先查 Hot Card Cache (HCC)？

### Group 6: 引用处理 — Soft/Weak/Final/Phantom 四遍处理 + CompleteGC 标记 + enqueue

**关键源码**: referenceProcessor.cpp:202-280 (process_discovered_references 主循环), referenceProcessor.cpp:788-830 (process_soft_ref_reconsider 4 遍), referenceProcessor.cpp:543 (discovered list 消费), g1CollectedHeap.cpp:5030 (post_evacuate 中调用)

**§四答案方向 (≥10 行)**:
- 四遍处理的顺序：Soft→Weak→Final→Phantom——每一遍有独立的 `DiscoveredList`（在 referenceProcessor 初始化时分配）。为什么是 4 遍而非 1 遍？Java reference 的处理规则复杂：(1) Soft 引用有"cleared only if heap pressure"规则——`process_soft_ref_reconsider` 调用 `SoftRefPolicy::should_clear_reference()` → TRUE 才清除；(2) Phantom 引用在 finalization 后才被清除。
- `process_discovered_references()` (referenceProcessor.cpp:202) 的主逻辑：iter 1 → process_soft_ref_reconsider → iter 2/3/4 → process each ref type。每个 iter 都调用 `is_alive_closure`（eg `G1STWIsAliveClosure` 检查 CSet 中的标记）→ 已死对象的引用被清除 → `keep_alive_closure`（疏散 keep_alive）→ `complete_gc_closure`（例如 Phantom 需要的特殊处理）。
- Discovered List 的并发性：ReferenceProcessor 持有全局 `_discoveredSoftRefs[worker_id]` 数组——每个 worker 处理一个发现列表。对象在 evacuation 中被发现是 Reference 子类时 `G1ParCopyClosure::do_oop_work` 将其加入 discovered list。
- Counterfactual: 如果引用处理在 evacuation 之前（而非之后）执行 → Soft/Weak ref 可能在 evacuation 中变为可达 → 需要重新发现 → 二次遍历。
- Counterfactual: 如果所有引用类型用同一遍处理 → Soft 引用错误清除（heap 明明空闲）→ Phantom 在 future 之前 enqueue → spec 违反。
- 追问：ReferenceProcessor 的 `discover_reference()` 路径中 Reference 对象本身是否被疏散？

### Group 7: Pause 后处理 — record_collection_pause_end 更新 14 TruncatedSeq + Tenuring Threshold 修正 + Concurrent Mark 唤醒

**关键源码**: g1Policy.cpp:643-740 (record_collection_pause_end 98行), g1Policy.cpp 中 `_analytics->report_xxx(field)` 调用序列, g1Analytics.cpp 中 TruncatedSeq 更新, g1CollectedHeap.cpp:3930-3950 (调用点)

**§四答案方向 (≥10 行)**:
- `record_collection_pause_end` (g1Policy.cpp:643) 更新的 14 TruncatedSeq 字段：
  - 暂停预测：`_recent_gc_times_ms->add(pause_time_ms)` (:657) — MMUTracker 的衰减平均输入
  - 卡片扫描：`_cost_per_card_ms_seq->add(cost_per_card_ms)` (:????)
  - 容量：`_constant_other_time_ms_seq->add(constant_other_time_ms)` (:655)
  - 回收效率：`_recent_avg_pause_time_ratio` ← 累积平均值 (:6??)
  - Survivor/晋升：`_cost_per_byte_ms_during_copied_bytes_seq->add(cost_per_byte_ms)` — 用于 future GC 的 PLAB 大小计算
  - 以及 `_copied_bytes`、`_old_cset_region_threshold`、`_rs_lengths` 等 14 个预测序列
- `revise_tenuring_threshold()` 决策：从 `_survivors_age_table` (g1Policy.cpp age table 合并后) 计算 `desired_survivor_size`——用 `count_of_contents(AgeTable, age)` 累加到 survivors → 年龄到达导致超额的第一个年龄设为新 `_tenuring_threshold`。
- 并发标记决策：`should_start_conc_mark` (g1Policy.cpp:690) → 检查 IHOP + marking cycle 状态 → `collector_state()->set_in_initial_mark_gc(true)` → 标记 cycle 初始化在 record pause end 后执行——Safepoint 结束前 `do_concurrent_mark()` 被调用。
- Counterfactual: 如果 14 TruncatedSeq 不更新（使用固定参数）→ GC 暂停预测使用历史旧数据 → 预测偏差累积 → 决策错误（under-evaucate 或 over-evaucate）。
- 追问：`constant_other_time_ms_seq` 和 `recent_gc_times_ms` 的区别——前者是"非变部分的 GC 时间"（基数）后者是"总暂停时间"（用于 adaptive 控制）→ 两者共同输入 pause time prediction。

### Group 8: 疏散失败恢复 — Self-forwarding + 降级 retry + 并发转移保证

**关键源码**: g1EvacFailure.cpp (263行), g1ParScanThreadState.cpp:245-249 (old_gen_full 路径), g1ParScanThreadState.cpp:260-264 (allocation fail 路径), oop.inline.hpp:373 (forward_to_atomic for self-forward), g1CollectedHeap.cpp:5026 (post_evacuate 恢复处理)

**§四答案方向 (≥10 行)**:
- 两种失败类型：`old_gen_is_full` (g1ParScanThreadState.cpp:245-249) 和 `allocation failed` (g1ParScanThreadState.cpp:260-264)。前者在 PLAB 分配之前——`dest_state.is_old()`→直接 `handle_evacuation_failure_par` 返回。后者在 PLAB 和降级路径都失败后——`handle_evacuation_failure_par` 返回 `self_forwarded` 对象。
- Self-forwarding：当对象无法在前向分配新空间时 `handle_evacuation_failure_par` → `forward_to_atomic(obj, obj)` 将对象的 forwarding pointer 指向自己——表示"这个对象疏散失败，留在原位置"。后续 worker 再碰到这个对象时 `is_self_forwarded()` 返回 true→worker 递归扫描原对象的子引用但不尝试复制。
- `preserved marks`：疏散失败的对象可能持有 biased lock → 需要保存 mark word → `PreservedMarksSet::push_if_necessary()` → 在 `restore_preserved_marks()` 中恢复。
- `post_evacuate_collection_set` (g1CollectedHeap.cpp:5026) 中的恢复逻辑：统计 evacuation failure→`_old_evac_failure_info.add_region(from_region)`→更新 analytics→标记 region 为 pinned（不能释放）→CSet 移除 pinned region→下次 GC 再试。
- Counterfactual: 如果疏散失败不存 self-forwarding → 后续 worker 继续尝试复制→分配仍然失败→无限循环—对象永远无法被处理。
- 追问：`PreservedMarksSet` 为什么是必要的？forwarding pointer 替代了 mark word →biased locking 的 thread_id+hint 信息丢失→不恢复会导致线程偏向错误。

---

## §五 Article Structure

```
# 01-Young-GC-Evacuation — G1 Young GC 疏散全生命周期

## §〇 生产场景 — Young GC 120ms 故障（期望 <30ms）
[(从 §〇 Production Scenario 移植, ≥100 行, 含 jstat + strace futex + GDB PLAB refill + forwarding pointer 断点)]
[(反事实: PLAB 无 per-worker / RSet 全 Coarse / forwarding 用锁)]

## §一 ★★★ Young GC 触发与 Safepoint 同步
### 1.1 三种触发路径 — Allocation Failure / Humongous / GCLocker
[g1CollectedHeap.cpp:488-500 Allocation Failure → do_collection_pause]
[g1CollectedHeap.cpp:941-950 Humongous 失败 → do_collection_pause]
[g1CollectedHeap.cpp:3648 GCLocker::check_active_before_gc 取消]
[VM_G1CollectForAllocation::doit (vm_operations_g1.cpp:78) 全路径]
### 1.2 Safepoint 同步 — begin→pause→end 状态机
[safepoint.cpp:156-200 begin → arming → synchronize wait]
[safepoint.cpp:527-550 end → wake threads → increment counter]
[ThreadSafepointState::block() 每个 Java 线程的阻塞路径]
[★ Safepoint 状态转换 Mermaid]

## §二 CSet 构建与疏散前准备
### 2.1 CollectionSet 构建 — finalize_collection_set
[g1CollectedHeap.cpp:3800-3810 finalize_collection_set, cleanupHRRS]
[Young GC vs Mixed GC 的 CSet 区别: young cset 固定所有 Eden+Survivor]
### 2.2 疏散前准备 — init_gc_alloc_regions + pre_evacuate
[g1CollectedHeap.cpp:3835 init_gc_alloc_regions — 创建 Survivor/Old GC AllocRegion]
[g1CollectedHeap.cpp:3839 pre_evacuate_collection_set — clear RSet + hot card cache reset]

## §三 ★★★ 疏散执行 — G1ParTask 并行 Worker
### 3.1 G1ParTask 启动 — work(worker_id) 的完整入口
[g1CollectedHeap.cpp:4096-4148 G1ParTask class]
[g1CollectedHeap.cpp:4116 work(uint worker_id) → 根扫描→RSet 扫描→队列 drain]
### 3.2 ★ 根扫描 — 11 类 Root + SubTasksDone 去重
[g1RootProcessor.cpp:80 evacuate_roots — 单 worker 入口]
[g1RootProcessor.cpp:224 process_java_roots — CLDG 单 worker + Thread stacks 分摊]
[g1RootProcessor.cpp:246 process_vm_roots — 7 类 VM root 逐个 is_task_claimed]
[SubTasksDone::is_task_claimed 表 — 每类 root 谁执行]
### 3.3 ★ RSet 两阶段 — update 新引用 + scan 存量
[g1RemSet.cpp:692 oops_into_collection_set_do — update+scan 顺序]
[g1RemSet.cpp:660 update_rem_set — 消费 DirtyCardQueue 新引用]
[g1RemSet.cpp:604 scan_rem_set — PerRegionTable 存量扫描 + strong code roots]
[worker 如何分配 CSet region — region 分片策略]

## §四 ★★★ Evacuation 核心 — copy_to_survivor_space 6 步决策
### 4.1 next_state() — 年龄判断 → 晋升目标 (Survivor/Old)
[g1ParScanThreadState 中的 InCSetState 枚举: Young/Old 状态判定]
### 4.2 PLAB 快速路径 — 无锁 bump-pointer 分配 (>80% 命中)
[g1ParScanThreadState.cpp:250 _plab_allocator->plab_allocate]
### 4.3 PLAB 慢速路径 — refill + 降级到另一代
[g1ParScanThreadState.cpp:254 allocate_direct_or_new_plab → FreeList_lock]
[g1ParScanThreadState.cpp:159 allocate_in_next_plab → 降级逻辑 + _tenuring_threshold=0]
### 4.4 ★★★ CAS Forwarding Pointer — 并发疏散的原子决定
[g1ParScanThreadState.cpp:290 forward_to_atomic(obj, memory_order_relaxed)]
[oop.inline.hpp:373 CAS _mark 字段 — 成功 vs 失败 两路分支]
[成功 → Copy::aligned_disjoint_words 复制 + age++ + _age_table.add]
### 4.5 ★ 子引用递归扫描 — oop_iterate_backwards 与 task queue
[g1ParScanThreadState.cpp:341 obj->oop_iterate_backwards(&_scanner)]
[task queue enqueue → steal_and_trim_queue → 再次 copy_to_survivor_space]
### 4.6 ★ Age Table 增量 + Promotion 统计
[g1ParScanThreadState.cpp:308 _age_table.add(age, word_sz)]
[g1ParScanThreadState.cpp:326-329 _surviving_young_words + _objects_copied + bytes_copied]

## §五 ★ 引用处理 — 四遍 Reference 处理
### 5.1 Reference 发现 — evacuation 中如何识别 Reference 子类
[G1ParCopyClosure::do_oop_work → ReferenceProcessor::discover_reference]
### 5.2 四遍处理 — Soft→Weak→Final→Phantom
[referenceProcessor.cpp:202 process_discovered_references 主循环]
[referenceProcessor.cpp:788 process_soft_ref_reconsider — SoftRefPolicy 判断]
### 5.3 is_alive / keep_alive / complete_gc 闭包
[G1STWIsAliveClosure — CSet 对象存活判断]
[各 worker 的 task queue enqueue — keep_alive 将引用指向的 Object 重新加入疏散队列]

## §六 疏散失败恢复
### 6.1 Old Gen Full / Allocation Fail 两种失败
[g1ParScanThreadState.cpp:245-249 old_gen_is_full 快速失败]
[g1ParScanThreadState.cpp:260-264 allocate fail 全部路径穷尽]
### 6.2 Self-forwarding — handle_evacuation_failure_par
[g1EvacFailure.cpp 疏散失败处理 — forward_to_atomic(obj, obj)]
[is_self_forwarded() → 原位置递归扫描不复制]
### 6.3 PreservedMarks — 偏向锁 mark word 保存/恢复
[PreservedMarksSet 在 evacuation failure 中的角色]
[post_evacuate→restore_preserved_marks]

## §七 Pause 后处理与策略更新
### 7.1 free_collection_set — CSet region 回收
[g1CollectedHeap.cpp:5455 → free region→prepend to Free List→reset region]
### 7.2 ★ record_collection_pause_end — 14 TruncatedSeq 更新
[g1Policy.cpp:643-740 逐个 analytics 字段 (pause time/card cost/copy cost/RS lengths)]
[revise_tenuring_threshold — Age Table 合并→计算新 threshold]
### 7.3 eagerly_reclaim_humongous — 并发标记后立即回收
[g1CollectedHeap.cpp:5605 Humongous 可达性判断 → reclaim objects/regions]
### 7.4 do_concurrent_mark — Initial Mark 情况下启动标记线程

## §八 ★ 完整调用链总览
### 8.1 全调用链 Mermaid 序列图
[3 lanes: Java Thread / VMThread / GC Worker(s)]
[Java alloc fail → VM_G1CollectForAllocation → Safepoint begin → 5阶段 → end]
[Worker: root scan → RSet scan → queue drain → copy_to_survivor → CAS forwarding]
[涉及所有核心函数和 file:line]
### 8.2 时间分布分析 — 每个阶段预期时间占比
[Root scan ~3-5ms / RSet scan ~5-20ms (取决于 coarse 退化) / Evacuation ~10-20ms / Ref proc ~1-5ms]

## §九 ★★★ Counterfactual 设计讨论
### 9.1 forwarding pointer 用 CAS vs Lock vs 全局转发表
### 9.2 PLAB per-worker vs 共享全局分配器
### 9.3 RSet update vs 全堆快照扫描
### 9.4 References 单独处理 vs 内嵌 evacuation
[每个 counterfactual 有量化对比]

## §十 边缘场景与子系统交互
### 10.1 GCLocker 活跃时 Young GC 被跳过 → 后果
### 10.2 所有 CSet region 都 failure → Full GC 升级路径
### 10.3 Worker 数 < Region 数时的负载均衡策略
### 10.4 Concurrent Refinement 与 Young GC 的 card 竞争
### 10.5 Safepoint 时间过长 → 超时检测 → VM Operation timeout

## §十一 诊断工具五件套
### 11.1 strace — futex 追踪 Safepoint 阻塞 + FreeList_lock 竞争
### 11.2 jstat — -gcutil 看存活率 + -gccapacity 看 Survivor 占用
### 11.3 jcmd — GC.heap_info (CSet region 分布) + GC.class_histogram (CSet 存活对象)
### 11.4 GDB — 4 断点验证: PLAB refill/CAS forwarding/Age Table/forwarding pointer
### 11.5 /proc — /proc/<pid>/status 看 VmRSS + 上下文切换推理锁竞争
```

**每节长度目标**：§〇 ≥100行, §一 ≥250行, §二 ≥150行, §三 ≥300行, §四 ≥400行, §五 ≥200行, §六 ≥150行, §七 ≥250行, §八 ≥150行, §九 ≥200行, §十 ≥150行, §十一 ≥200行。全文目标 ≥2500 行。

**Mermaid 要求 (≥6 个)**：
1. Safepoint 状态转换图 (not_synchronized → synchronizing → synchronized → end)
2. do_collection_pause_at_safepoint 5 阶段 Gantt 时间线
3. Worker 疏散并行序列图 (3 lanes: root scan worker 1/2/3 → wait barrier → RSet scan worker 1/2/3 → wait barrier → queue drain with work stealing)
4. copy_to_survivor_space 6 步决策流程图 (next_state→PLAB fast→slow→degrade→CAS→copy)
5. RSet 两阶段数据流 (MUTATOR dirty cards → DirtyCardQueue → update_rem_set → scan_rem_set → PerRegionTable → for_each_card → evacuation)
6. Reference 四遍处理序列图 (Soft head→clear→keep alive→enqueue → Weak→... → Final→... → Phantom→...)
7. 全调用链序列图 (§八要求的 3-lane 图)

---

## §六 Writing Requirements（含"不要写成→应该写成"对照表）

| 不要写成 | 应该写成 |
|---------|---------|
| 翻译源码逐行注释 | 用原理叙述执行流，源码引用 (file:line) 为证据——原理:源码 = 80:20 |
| 写 "G1ParTask 启动 worker 并行疏散" | 写出 worker 创建→启动→根扫描→RSet 扫描→队列 drain→退出的具体执行流，标注 file:line 和状态转换 |
| 省略 CAS forwarding 的并发语义 | 完整分析失败路径：CAS 成功做什么、CAS 失败做什么、undo_allocation 为什么安全 |
| "PLAB 分配失败走慢路径" | 写出 PLAB 快/慢/降级三级分配的具体代码行和条件判断，标注每级的预期命中率 |
| 用 Mermaid 代替源码分析 | Mermaid 辅助说明，正文必须有 file:line 引用和具体条件判断 |
| 省略量化数据 | 每阶段给出预期时间占比：root scan ~5ms, RSet scan ~5-20ms, Evac ~10-20ms, Ref proc ~1-5ms；dirty cards 正常<500/max>10000 |
| 只写正常路径 | 所有路径都要讨论错误路径：GCLocker 活跃/GCLocker 取消/evacuation failure/Safepoint 超时 |
| "G1 使用 Forwarding Pointer" | 写出 CAS 安装位置 (markOop _mark 字段)、specific line (oop.inline.hpp:373) 和 memory_order_relaxed 的语义——为什么是 relaxed 而非 acquire/release？ |

---

## §七 Output Format

- Markdown file，命名 `01-Young-GC-Evacuation.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/30-g1-runtime-gc/docs/`
- 元信息头（必须）：

```
> **阶段**：[30-g1-runtime-gc]
> **前置**：[01-jvm-startup]（02-G1-Heap-Startup: 堆构造 18 步，1403行）、[30-g1-runtime-gc]（00-Region-Runtime-Allocation: Region 状态转换 + TLAB/SATB/Card Barrier, ~2500行）
> **配套**：[02-Concurrent-Marking]（并发标记生命周期）、[03-Mixed-GC-Policy]（CSet 选择 + IHOP + MMUTracker）
> **后续依赖本文**：[03-Mixed-GC-Policy]（Mixed GC 执行依赖 Young GC 疏散路径）、[04-Full-GC]（Full GC 在执行 Migration 时复用 copy_to_survivor_space 模式）
> **阅读收益**：追踪 Young GC 从 Java 分配失败到 Safepoint 结束的完整 5 阶段时间线——理解 VM_G1CollectForAllocation VM 操作、Safepoint 同步协议、G1ParTask 并行 worker 启动、copy_to_survivor_space 的 CAS forwarding pointer 核心并发疏散、RSet 两阶段防止漏收引用的设计、ReferenceProcessor 四遍处理顺序、Pause 后 14 TruncatedSeq 自适应策略更新；掌握"120ms Young GC"故障的诊断路径 (jstat + strace + GDB)
> **目标行数**：≥2500 行（§〇≥100 + §一至§十一≥2400）
```

- 所有技术断言标注 `(file:line)` 源码引用（不限于 `g1CollectedHeap.cpp:3639` 格式）
- 使用 `> **Callout 标题**` 格式的 Callout 框（不用 `###` subsection），≥7 个（只在 §一 中）
- 每个函数分析 ≥12 行正文
- 边缘场景独立 section (§十)
- 诊断工具速查表独立 section (§十一) — strace + jstat + jcmd + GDB + /proc 各 ≥2 个实用命令
- 使用 GitHub Flavored Markdown，代码块标注语言（c, bash, yaml）

---

## §八 Prohibited（≥10 条）

1. ❌ 不要重复 doc-00 的设计内容。RSet 的 add_reference 构建、HeapRegion 状态转换、Barrier set 的 SATB/Card enqueue 路径已在 doc-00 覆盖——本文只引用不展开。引用时用 `"详见 00-Region-Runtime-Allocation §X"` 跳转。
2. ❌ 不要写 Concurrent Marking 的标记生命周期——这是 doc-02 的内容。本文仅覆盖 Young GC 中 Initial Mark 的决策触发和 `do_concurrent_mark` 唤醒。
3. ❌ 不要写 Mixed GC 的 CSet 选择算法——这是 doc-03 的内容。本文仅覆盖 Young GC 的 CSet（所有 Eden+Survivor）。
4. ❌ 不要写 Full GC 的四阶段——这是 doc-04 的内容。本文仅覆盖 evacuation failure 后可能升级到 Full GC 的条件。
5. ❌ 不要在 §一 中使用 FAQ/Q&A 格式。用连续 prose + 执行时间线叙事。
6. ❌ 不要用模糊的 "系统调用 X 用于 Y" 表述。所有系统调用标注 `man 2 futex` 格式。
7. ❌ 不要省略 counterfactual。每个设计决策点必须讨论 "如果不这样做会怎样"——forwarding pointer、PLAB per-worker、RSet 两阶段、引用处理顺序都需要 counterfactual。
8. ❌ 不要在 §二（环境节）中使用简称或模糊表述。`safepoint.cpp:156,527` 必须写明是 begin 还是 end。
9. ❌ 不要写出 "显而易见""显然""简单"——每个断言有 file:line 支撑。
10. ❌ 不要省略诊断工具。strace/jstat/jcmd/GDB/proc 全部独立出现，各有 ≥2 个实用命令。

---

## §九 Required（≥10 条）

1. ✅ 必须画 do_collection_pause_at_safepoint 的 5 阶段 Gantt 类时间线（前置检查→Init Mark 决策→CSet 构建→疏散执行→收尾）。
2. ✅ 必须写出 copy_to_survivor_space 的完整 6 步决策链，标注 file:line 和每步的条件判断。
3. ✅ 必须展示 CAS forwarding pointer (oop.inline.hpp:373) 的并发竞争——成功路径 vs 失败路径的完整对比。
4. ✅ 必须列出 11 类 VM root 和它们如何通过 SubTasksDone::is_task_claimed 去重。
5. ✅ 必须展示 RSet 两阶段 update_rem_set→scan_rem_set 的数据流和时间依赖。
6. ✅ 必须写出 ReferenceProcessor 四遍处理的顺序和每遍处理的语义（Soft→Weak→Final→Phantom）。
7. ✅ 必须包含 14 TruncatedSeq 在 record_collection_pause_end 中的更新清单（至少列出 8 个字段和它们的用途）。
8. ✅ §〇 必须包含真实生产故障（120ms Young GC）和完整三步诊断流程。
9. ✅ 必须包含全调用链 Mermaid 序列图（3 lanes: Java Thread/VMThread/GC Worker）。
10. ✅ 必须包含边缘场景独立 section：GCLocker 活跃→GC 跳过；所有 region failure→Full GC 升级；Safepoint 超时检测。
11. ✅ 每个核心函数的 man 页面和 syscall 引用在首次讨论时标注。
12. ✅ 文档末尾 `## §十一 诊断工具速查` 节必须含 strace/jstat/jcmd/GDB/proc 各 ≥2 个实用命令。

---

## §十 GDB Verification（≥8 断言）

以下所有断言读者可用 GDB 在当前 build 上验证：

1. 验证 Young GC 入口：`gdb -ex "break g1CollectedHeap.cpp:3639" -ex "run" --args java -Xms256m -Xmx256m -XX:+UseG1GC -XX:+PrintGC -jar app.jar` → `print target_pause_time_ms` 期望值 `>0.0`（GC pause target）
2. 验证 Safepoint 同步状态：`gdb -ex "break safepoint.cpp:156" -ex "continue" -ex "print SafepointSynchronize::_state"` → 期望值 `_synchronizing` (1)
3. 验证 Safepoint 结束：`gdb -ex "break safepoint.cpp:540" -ex "continue" -ex "print SafepointSynchronize::_state"` → `_not_synchronized` (0)
4. 验证 GCLocker 活跃检查：`gdb -ex "break g1CollectedHeap.cpp:3648" -ex "run" -ex "print GCLocker::is_active()"` → 通常在非 JNI critical 段内为 `false`
5. 验证 PLAB 快速分配成功：`gdb -ex "break g1ParScanThreadState.cpp:250" -ex "continue" -ex "print obj_ptr" -ex "print word_sz"` → `obj_ptr != NULL` 且 `word_sz == old->size()` (PLAB 快速路径 hit)
6. 验证 PLAB refill 失败路径：`gdb -ex "break g1ParScanThreadState.cpp:256" -ex "continue" -ex "print plab_refill_failed"` → 高内存压力时为 `true`
7. 验证 CAS forwarding pointer 成功：`gdb -ex "break g1ParScanThreadState.cpp:290" -ex "continue" -ex "print forward_ptr" -ex "next" -ex "print forward_ptr"` → CAS 前为 NULL，CAS 后如果成功仍为 NULL（成功路径进入 if 体）；若失败 forward_ptr 为非 NULL（返回 forwardee）
8. 验证 Age Table 增量：`gdb -ex "break g1ParScanThreadState.cpp:308" -ex "continue" -ex "print age" -ex "print word_sz" -ex "print this->_age_table.xxx"` → age 从 0 开始递增，word_sz 为对象大小
9. 验证 RSet 扫描的闭包调度：`gdb -ex "break g1OopClosures.inline.hpp:238" -ex "continue" -ex "print p" -ex "print *p"` → `*p` 指向 CSet 中的对象（旧位置），闭包将触发 copy_to_survivor_space

---

## §十一 与 README 和同组 prompt 的连续性

- 本 prompt 对应 `probe_md/30-g1-runtime-gc/README.md` 的 doc-01 (§二 文档拆分表行 2)。
- **前导知识**：
  - Phase 01 的 `02-G1-Heap-Startup` (1403行) — G1CollectedHeap 构造 18 步、6 Mapper、CardTable — 本文从 "堆已创建" 角度运行 GC。
  - Phase 30 doc-00 `00-Region-Runtime-Allocation` (~2500行) — Region 状态转换 (Eden→Survivor→Old)、RSet add_reference、Barrier Set、TLAB/G1AllocRegion 分配 — 本文的疏散使用 Survivor/Old 转换和 RSet 扫描，参考其 Region 状态机和 PRT 数据结构。
- **下游文档依赖本文**：
  - doc-02 `Concurrent Marking Lifecycle` — 依赖本文 Initial Mark 决策和 SATB buffer drain 在根扫描中的实现。
  - doc-03 `Mixed GC + Policy` — 依赖本文 evacuation 路径 (Mixed GC 执行与 Young GC 共享同一 G1ParTask 框架)。
  - doc-04 `Full GC` — 依赖本文 evacuation failure 升级条件和 CAS forwarding 语义。
- **全文边界（本文不覆盖）**：
  - ✂ G1ConcurrentMark::cycle_start/markRoots/remark/cleanup — doc-02
  - ✂ CollectionSetChooser::rebuild/sort_regions_by_reclaimable — doc-03
  - ✂ Full GC compaction + G1FullGCCompactionPoint — doc-04
  - ✂ RSet 三级构建 (add_reference + Sparse→Fine→Coarse 切换) — doc-00
  - ✂ Barrier set 的 SATB/Card enqueue（生产端） — doc-00
- **全文总长 ≥2500 行**（§〇 ≥100, §一 ≥250, §二 ≥150, §三 ≥300, §四 ≥400, §五 ≥200, §六 ≥150, §七 ≥250, §八 ≥150, §九 ≥200, §十 ≥150, §十一 ≥200）。
