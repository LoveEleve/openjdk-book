# PROMPT: 请撰写 05-Safepoint-Full-Path.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**Safepoint Full Path — 从分配失败到 GC 执行到恢复的完整时间线串联**

### 核心故事线（禁止做源码翻译机！）

前 4 篇文章已经把 safepoint 的每个子系统拆解清楚了：
- [01] 讲了 begin/end 三态协议 + 双循环等所有线程 + `set_jni_lock_count()` 快照
- [02] 讲了 Global Polling Page mprotect/SIGSEGV → ThreadLocal Handshake + `transition_and_fence` + `ThreadBlockInVM` + 轮询点分布
- [03] 讲了 VM_Operation 三态调度 + doit_prologue 门禁 + VMOperationQueue
- [04] 讲了 GCLocker jni_lock/jni_unlock 协议 + `_needs_gc` 状态机 + 放弃而非等待

但它们都是各自孤立的拼图。读者看完 4 篇后最大的困惑是：**这些东西到底怎么串在一起的？** 比如：GCLocker 的 `check_active_before_gc()` 到底在哪一层被调用？polling page 的 arm 和 `_state = _synchronizing` 谁先谁后？`transition_and_fence` 的 StoreLoad 和 begin() 的 `OrderAccess::fence()` 如何配合工作？如果 JNI critical 在 safepoint 进行中退出，会发生什么？

**本文的核心叙事线**是追踪**一个完整的 GC-triggered safepoint 从生到死的全过程**——以 [01] 的 begin/end 为骨架，把 [02][03][04] 的零件嵌入到正确的时间点上：

1. **★ 触发路径（衔接 [03]）**：JavaThread 在 TLAB 中分配失败 → `attempt_allocation()` → 尝试 expand heap → 调用 `VMThread::execute(new VM_G1CollectForAllocation(...))` → VM_Operation 入队 → 锁 Heap_lock → 获取 `_gc_count_before` → 入队到 VMOperationQueue → `VMOperationQueue_lock->notify()` 唤醒 VMThread。★ 追问：**为什么 VM_G1CollectForAllocation 的构造发生在分配失败线程中，而不是 VMThread 中？** 因为 GC 原因（如是否是 `_allocation_failure`）需要在调用者上下文确定——如果由 VMThread 构造，分配失败线程已经不知道"为什么失败了"。**★ 追问：`GCIdMark` 是什么时候创建的？** GCIdMark 给每次 GC 分配一个唯一 ID（用于 GC log 和 JFR），它在 `doit_prologue()` 成功后、`doit()` 开始前创建——而不是在入队时。这意味着如果 GCLocker skip 了 GC（doit_prologue 返回 false），这次 GC 请求没有 GCId，不会出现在日志中。

2. **★ doit_prologue 门禁（衔接 [03][04]）**：VMThread 被唤醒 → `VMThread::loop()` → 从队列取出操作 → `op->doit_prologue()`。这是 **GCLocker 第一层门禁**。`skip_operation()` 内部调用 `GCLocker::is_active_and_needs_gc()`（[04] §5.2）：如果 `_needs_gc` 已经被之前的 safepoint 设置 + 活跃 critical 存在 → skip → doit_prologue 返回 false → VMThread 跳过整个 safepoint。★ 追问：**doit_prologue 成功后有 Heap_lock 锁竞争吗？** doit_prologue 中 `Heap_lock->lock()`（[01] L97），如果 Heap_lock 已被另一个线程持有（如另一个分配失败的线程正在执行 `attempt_allocation`），VMThread 会阻塞等待 Heap_lock → 增加了 safepoint 的同步延迟。这是 GC pause time 的一部分但常被忽略。

3. **★ begin() 前序（衔接 [01][02]）**：doit_prologue 返回 true → VMThread 进入 `evaluate_operation()` → 准备调用 `SafepointSynchronize::begin()`。在 begin() 调用之前，VMThread 先设置 `_vm_operation = op`（让 `print_safepoint_timeout` 能知道是哪个操作导致超时）。

4. **★ begin() 逐步走读（衔接 [01] 的 9 步 + [02] 的 arm 细节 + [04] 的 set_jni_lock_count）**：

   ① `Threads_lock->lock()` → 阻止线程创建/销毁
   ② `MutexLocker mu(Safepoint_lock)` → 互斥 safepoint 请求
   ③ `_waiting_to_block = nof_threads` + `_current_jni_active_count = 0`
   ④ `_state = _synchronizing` ← **[02]** `transition_and_fence` 的"隐藏读者"——在 [02] §四，`transition_and_fence` 的 StoreLoad 保证 JavaThread 写 `_thread_state→_thread_blocked` 对 VMThread 可见。但在 begin() 中，VMThread 先写 `_state→_synchronizing` 再 fence——这是**对偶的"消息传递"模式**：VMThread 先写后读，JavaThread 先读后写。两边的 fence 共同形成了跨线程的 happens-before 关系。
   ★ 追问：**④ 和 ⑤ 的顺序为什么不能交换？** 如果先 arm polling（⑤）再设 `_state=_synchronizing`（④）→ 线程在 ⑤ 到 ④ 之间调用 poll → 看到 `_state==_not_synchronized` → 认为没有 safepoint → 继续执行 → 漏掉 safepoint → 无限等待。
   ⑤ arm polling page：ThreadLocal 模式 arm_local_poll；Global 模式 `OrderAccess::fence()` + `os::serialize_thread_states()` → **[02] §二**
   ⑥ 阶段1 SPIN 循环：`while(still_running > 0)` → 遍历所有 JavaThread → `examine_state_of_thread()` → 对 `_thread_in_native` 的线程 `roll_forward(_at_safepoint)`（[02] §6.3）；对 `_thread_in_vm` 的线程 `roll_forward(_call_back)`（[03] 的偏斜锁撤销回调就通过此机制实现）
   ⑦ 阶段2 BLOCK 循环：`while(_waiting_to_block > 0)` → 等线程完成状态转换
   ⑧ `_state = _synchronized` + `OrderAccess::fence()`
   ⑨ ★ **[04]** `GCLocker::set_jni_lock_count(_current_jni_active_count)` — 将 SPIN 循环中累积的 `_current_jni_active_count` 快照到 GCLocker 的 `_jni_lock_count`。★ 这个值的含义是"**safepoint 建立时刻**有多少线程在 JNI critical 中"——用于统计和日志，不被 `check_active_before_gc()` 读取（它读的是 `_jni_lock_count`，但此值已通过 safepoint 同步过）
   ⑩ `do_cleanup_tasks()`

5. **★ GCLocker 第二层门禁（衔接 [04] §5.3）**：op->doit() → `do_collection_pause_at_safepoint()` → L3648 `GCLocker::check_active_before_gc()`。如果此时 GCLocker active → `_needs_gc=true` → return false → 放弃本次 GC。★ 追问：**为什么两层门禁用不同的函数？** 第一层用 `is_active_and_needs_gc()`（纯读），第二层用 `check_active_before_gc()`（带副作用——设置 `_needs_gc`）。第一层必须纯读——它不在 safepoint 中调用（在 doit_prologue 中，尚未 enter safepoint），不能写 `_needs_gc`（写 `volatile` 字段不保证对其他 CPU 即时可见，只有在 safepoint 的 fence 后才能保证）。第二层在 safepoint 中——fence 已执行，写 `_needs_gc` 安全。

6. **★ GC 执行（衔接 [01] doit + Phase1-4）**：`do_collection_pause_at_safepoint()` → pre_evacuate → evacuate（并行）→ post_evacuate → free_collection_set。★ 追问：**GC 线程（如 G1ConcurrentMarkThread）在 safepoint 中是什么状态？** [01] §六 的 `safepoint_safe()` 判断——NonJavaThread 的 `_thread_state` 不受 safepoint 控制，但 `_thread_blocked` 状态的线程在 block() 中被阻塞。Concurrent GC 线程在 safepoint 中通过 `SafepointMechanism::block_if_requested()` 主动暂停。

7. **★ end() 逐步走读（衔接 [01] §四 + [02] disarm）**：`_state = _not_synchronized` → disarm（Global: `make_polling_page_readable()` + TLB shootdown；ThreadLocal: 清除 flag）→ `Safepoint_lock->notify_all()` → 释放 Threads_lock → 记录 pause time。★ 追问：**disarm 后，block() 中的线程怎么恢复？** block() L927 `Threads_lock->lock_without_safepoint_check()`——所有在 block() 中等待的线程都在 `Threads_lock` 上排队。end() 释放 `Threads_lock` → 线程依次获取锁 → 恢复 `_thread_state` → 继续执行。

8. **★ 时间开销分解（衔接 [01] 的 PrintSafepointStatistics）**：

```
safepoint 总 pause time = 
    lock_acquire_time         // Threads_lock + Safepoint_lock — 纳秒级
  + spin_time                 // 阶段1 SPIN — 等线程 poll 到 — 微秒级
  + block_time                // 阶段2 BLOCK — 等线程状态转换 — 微秒级
  + sync_time                 // 总计 begin() 到 _synchronized — 微秒到毫秒级
  + cleanup_time              // do_cleanup_tasks — 微秒级
  + vmop_time                 // doit() 执行 — 毫秒到秒级（GC）或微秒级（偏斜锁）
  = [PrintSafepointStatistics 输出]
```

★ 追问：**哪个阶段是 pause time 的最大贡献者？** 对于 GC-triggered safepoint：vmop_time（GC 本身，~10-500ms）>> spin_time（~100μs-1ms）> block_time（~10μs）。但对于 RevokeBias（偏斜锁撤销）：spin_time 可能 > vmop_time（doit 只需 <1μs 的 CAS 操作，但 SPIN 等所有线程仍需要 ~100μs）。

9. **★ GCLocker 的时间位置（衔接 [04]）**：

```
时间 →  
应用线程: [分配失败] → VM_G1CollectForAllocation.execute() → VMOperationQueue::add()
                                                                              ↓
VMThread:                            ← 被唤醒 ← notify() ← [从队列取出]
                                      ↓
                                    evaluate_operation():
                                      ↓
                                    doit_prologue() ─ ★ GCLocker 第一层（is_active_and_needs_gc 纯读）
                                      ├── skip → return false → 整个 safepoint 不走 ✗
                                      └── continue
                                          ↓
                                    SafepointSynchronize::begin() ─ ①-⑩
                                          ↓
                                    op->doit():
                                      └── do_collection_pause_at_safepoint()
                                            └── ★ GCLocker 第二层（check_active_before_gc，设 _needs_gc）
                                                  ├── active → return false → GC 放弃
                                                  └── inactive → 执行 GC
                                          ↓
                                    SafepointSynchronize::end()

★ 如果 GCLocker 在第一层 skip: 不会浪费任何 safepoint 开销（arm/disarm + SPIN + BLOCK = ~100μs 省了）
★ 如果 GCLocker 在第二层 skip: 浪费了一次完整的 begin/end（~100μs），但保证了 _needs_gc 被设置
```

### 禁止行为

- ❌ 把 4 篇文章的内容复制粘贴——只引用，不重述
- ❌ 省略任何一步的"谁、在哪、做什么"标注
- ❌ 遗漏 GCLocker 在时间线上的精确位置（第一层 vs 第二层）
- ❌ 不解释为什么 `is_active_and_needs_gc()` 在第一层是纯读而 `check_active_before_gc()` 在第二层带副作用
- ❌ 遗漏时间开销分解——必须标注每个阶段的量级
- ❌ 不画完整的 Mermaid 时序图——这是全文的核心价值
- ❌ 把 05 写成"目录"或"摘要"——它是一篇独立的深度分析
- ❌ 不区分"在 VMThread 中" vs "在分配者线程中"——每步的上下文线程不同
- ❌ 不标注每条路径的 [0X-文档名] 引用位置

### 要求行为

- ✅ **★ 完整的 Mermaid 时序图**：从 "分配失败" 到 "应用线程恢复"，标注每个步骤的作者、位置、[0X] 引用。时序图应该有清晰的阶段边界（触发 → 入队 → doit_prologue → GCLocker gate 1 → begin → SPIN → BLOCK → GCLocker gate 2 → doit → GC → end → 恢复）
- ✅ **★ 每个步骤标注源文件:行号 + 所属线程 + [0X]引用**：所有 from/to 边界必须有源码行号
- ✅ **★ 时间开销分解**：标注每个阶段的实际耗时量级（纳秒/微秒/毫秒/秒），引用 PrintSafepointStatistics 的输出格式
- ✅ **★ GCLocker 在两条路径上（第一层 skip vs 第二层 skip）的对比**：画两条并行时间线，标注差异
- ✅ **★ 和 [01][02][03][04] 的双向引用**：本文不重复他们的内容，但必须标注"详见 [0X] §N"
- ✅ **★ `从 _thread_in_native 返回 + JNI critical 退出`的竞态窗口分析**：如果 JNI critical 在 begin() 的 SPIN 阶段退出（jni_unlock 调用 GC），而同时 VMThread 正在 SPIN 中等 native 线程返回——这两个线程如何协调？jni_unlock 的 `heap->collect()` 本身需要 safepoint，但此时 VMThread 已经在 safepoint 中了——会怎样？
- ✅ **★ 不同 GC cause 下的 pause time 组成对比**：G1CollectForAllocation (Young GC) vs RevokeBias vs GCLocker Initiated GC vs noop safepoint — 每种 VM_Operation 的时间开销侧重不同

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 核心函数（需验证行号） | 本文角色 |
|---|------|---------|---------------------|---------|
| 1 | `safepoint.cpp` | `src/hotspot/share/runtime/safepoint.cpp` | `begin()`(:156), `end()`(:527), `block()`(:859), `set_jni_lock_count()`(:484) | ★★★ begin/end 骨架（衔接 [01]） |
| 2 | `safepointMechanism.inline.hpp` | `src/hotspot/share/runtime/safepointMechanism.inline.hpp` | `poll()`, `global_poll()`, `block_if_requested()` | ★★ arm/poll 节点（衔接 [02]） |
| 3 | `vmThread.cpp` | `src/hotspot/share/runtime/vmThread.cpp` | `loop()`(:450-530), `evaluate_operation()` | ★★ VMThread 事件循环（衔接 [03]） |
| 4 | `vmOperations.hpp` | `src/hotspot/share/runtime/vmOperations.hpp` | `VM_Operation::Mode` enum, `doit_prologue()` | ★ VM_Operation 调度（衔接 [03]） |
| 5 | `vmGCOperations.cpp` | `src/hotspot/share/gc/shared/vmGCOperations.cpp` | `VM_GC_Operation::doit_prologue()`(:83), `skip_operation()`(:70) | ★★ GCLocker 第一层门禁（衔接 [04]） |
| 6 | `g1CollectedHeap.cpp` | `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | `do_collection_pause_at_safepoint()`(:3639), `check_active_before_gc()`(:3648) | ★★ GCLocker 第二层门禁 + GC 执行（衔接 [04]） |
| 7 | `gcLocker.cpp` | `src/hotspot/share/gc/shared/gcLocker.cpp` | `check_active_before_gc()`(:94), `is_active_and_needs_gc()`(:83:header), `jni_lock()`(:123), `jni_unlock()`(:142) | ★★ GCLocker 协议（衔接 [04]） |
| 8 | `interfaceSupport.inline.hpp` | `src/hotspot/share/runtime/interfaceSupport.inline.hpp` | `transition_and_fence()`(:136), `ThreadBlockInVM`(:297) | ★★ 线程状态转换（衔接 [02]） |
| 9 | `genCollectedHeap.cpp` | `src/hotspot/share/gc/shared/genCollectedHeap.cpp` | 分配失败路径 → `VM_GenCollectForAllocation`(:359), retry loop(:316-352) | ★ 分配失败 → VM_Operation 创建（衔接 [03]） |
| 10 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | `make_polling_page_unreadable()`(:6011), `make_polling_page_readable()`(:6018) | ★ arm/disarm 系统调用（衔接 [02]） |

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。禁止贴整段函数。

### 4.1 ★★★ 完整时间线 — 每一步的精确行号和线程上下文

```
问题：
  ① 从 "分配失败" 到 "VM_Operation 入队" 的路径中，每一步在哪个线程中执行？
     (1) TLAB 分配 → 失败 — 分配者线程
     (2) attempt_allocation → expand_heap → 失败 — 分配者线程
     (3) new VM_G1CollectForAllocation(...) — 分配者线程
     (4) VMThread::execute(op) → VMOperationQueue::add() — 分配者线程
     (5) VMOperationQueue_lock->notify() → 唤醒 VMThread — 分配者线程
     (6) 分配者线程在 Heap_lock 或 op->result 上等待 — 分配者线程
     ★ 关键: 分配者线程在步骤(4)后不直接等——它在 do_prologue 中或操作完成后才被唤醒。

  ② doit_prologue 到底在哪个线程中执行？
     答案方向: VMThread。在 VMThread::loop() → evaluate_operation() 中。
     doit_prologue 不是分配者线程的回调——是 VMThread 在取出操作后做的"预检查"。
     ★ 为什么 doit_prologue 在 VMThread 中？因为它需要获取 Heap_lock（持锁者需要是执行 GC 的线程）

  ③ begin() 的调用栈是什么？
     VMThread::loop() → evaluate_operation() → SafepointSynchronize::begin() ...
     或: VMThread::loop() → doit_prologue → 返回 true → evaluate_operation() → begin()
     ★ 追问: doit_prologue 在哪一层嵌套？在 evaluate_operation 之前还是之后？
     → 之前。doit_prologue 返回 false → VCThread 跳过 evaluate_operation，不调用 begin()

  ④ GC 执行（doit）时，VMThread 持有哪些锁？
     - Threads_lock（从 begin() 开始持有，到 end() 释放）
     - Heap_lock（从 doit_prologue 中获取，到 doit_epilogue 释放）
     - Safepoint_lock（在 begin() 中获取为 MutexLocker，在 end() 末尾释放）
     ★ 锁的顺序: Threads_lock → Safepoint_lock → Heap_lock（降序，符合 Lock Ranking）
```

### 4.2 ★★★ GCLocker 在两条路径上的时间对比

```
问题：
  ① 路径 A: GCLocker 在第一层 skip（_needs_gc 已设置，doit_prologue 返回 false）:
     时间开销: VM_Operation 入队 + VMThread 取出 + doit_prologue(GCLocker check) + skip
      ≈ 0 μs safepoint 开销（没有 begin/end）
     
  ② 路径 B: GCLocker 在第二层 skip（_needs_gc 未设置，doit_prologue 放行，begin 后 skip）:
     时间开销: 路径 A + begin() (lock获取 + SPIN + BLOCK + cleanup) + GCLocker check + skip + end()
      ≈ 路径 A + ~100μs（浪费的 safepoint 建立/拆除）
     
  ③ 路径 B 为什么不是纯浪费？
     _needs_gc 在路径 B 中被首次设置 → 后续 GC 尝试走路径 A（零 safepoint 开销）
     一次"浪费"换来了后续所有 GC 尝试的"零浪费"

  ④ 竞态窗口: JNI critical 在 begin() 的 SPIN/BLOCK 阶段退出
     如果 jni_unlock 在 begin() 进行中触发 GC → jni_unlock 调用 heap->collect()
     → heap->collect() 内部调用 VM_G1CollectForAllocation → doit_prologue → skip_operation
     → skip_operation 看到 GCLocker::is_active_and_needs_gc() 为 false（因为 jni_unlock 已经 count-- 并设 _doing_gc=true）
     → 放行？还是被阻止？
     ★ 答案: jni_unlock 的 heap->collect() 在 JNICritical_lock 的 MutexUnlocker 保护下执行
     → 此时 _doing_gc=true → 其他线程的 jni_lock 被阻塞
     → 但 VMThread 的 SPIN 循环中看到的线程状态是? → 取决于此时 jni_unlock 所在线程在 _thread_blocked 还是在什么状态
```

### 4.3 ★★ JNI critical 在 safepoint 中退出的竞态分析

```
问题：
  ① 场景: VMThread 在 begin() SPIN 阶段。Thread-A 在 JNI critical 中（_thread_in_native）。
     VMThread 对 Thread-A: roll_forward(_at_safepoint) — 标记为已到达，不等待。
     Thread-A 释放 critical（jni_unlock）→ count-- → count==0 → _doing_gc=true → heap->collect()
     
     问: heap->collect() 会触发 VM_G1CollectForAllocation → doit_prologue → GCLocker check
         → 此时 VMThread 已经在 safepoint 中了！会发生什么？
     
     答: do_collection_pause_at_safepoint 的第一行: assert_at_safepoint_on_vm_thread()
         但 Thread-A 不是 VMThread → assert 失败 → crash！
         
     ★ 这不会发生——因为 jni_unlock 在 JNICritical_lock 的 MutexLocker 中 count-- == 0,
     然后设置 _doing_gc=true, 然后 MutexUnlocker 释放锁,
     然后 heap->collect()。但 Thread-A 从 native 返回时需要先经过 transition_from_native
     → poll() → 检测到 _state=_synchronizing → block() → 被暂停！
     
     ★ 所以实际上 jni_unlock 中 heap->collect() 在哪个线程上执行？
     → jni_unlock 的调用者线程（Thread-A）自己！
     → 但 Thread-A 在 native 中 — _thread_in_native_trans → poll → 发现 _synchronizing → block
     → 此时 jni_unlock 还没机会执行到 heap->collect()
     
     ★ 关键: unlock_critical 的调用路径是 ReleasePrimitiveArrayCritical → JNI 层
     → 这个调用在 Thread-A 从 Java 进入 JNI 时执行 → Thread-A 此时在 _thread_in_native
     → VMThread 的 SPIN 对 _thread_in_native → roll_forward(_at_safepoint) — 视为到达
     → 然后 Thread-A 在 _thread_in_native 中继续执行 ReleasePrimitiveArrayCritical 的代码
     → 路径: unlock_critical() → needs_gc && in_last_critical → jni_unlock() → heap->collect()
     → ★ 关键矛盾: heap->collect() 需要 safepoint，但当前 safepoint 正在进行中！
     
     ★ 追问: jni_unlock 的 heap->collect() 到底怎么和正在进行的 safepoint 互斥？
     → heap->collect() 内部 → VM_G1CollectForAllocation → doit_prologue
     → skip_operation: GCLocker::is_active_and_needs_gc() = false（因为 _doing_gc=true, 但 jni_lock_count 已为 0）
     → is_maximal_no_gc() → 如果堆已到最大 → skip → doit_prologue 返回 false
     → heap->collect() 返回 false → GC 未执行 → jni_unlock 继续，设 _needs_gc=false, notify_all
     → ★ 但实际上 jni_lock_count 已为 0 → 下次 check_active_before_gc 会看到 count==0 → 不 skip
     
     ★ 追问: 那 jni_unlock 中 GC 到底什么时候实际执行？
     → 如果正在进行的 safepoint 的 GCLocker 第二层已经 skip → VMThread 在 end() 中恢复所有线程
     → end() 后 jni_unlock 才可能获得 JNICritical_lock
     → heap->collect() → 正常执行
     
     ★ 追问: jni_unlock 的 heap->collect() 如果在 begin() 的 SPIN/BLOCK 期间执行会 crash 吗？
     → Thread-A 在 _thread_in_native 中，VMThread 标记为 _at_safepoint（roll_forward）
     → Thread-A 继续在 native 中执行 jni_unlock → _doing_gc=true → MutexUnlocker 释放锁 → heap->collect()
     → heap->collect() 最终到 VM_G1CollectForAllocation 的 doit_prologue
     → doit_prologue 在 Thread-A 上执行 → 获取 Heap_lock（如果在 safepoint 中，VMThread 持有 Heap_lock？）
     → ★ 此时 Heap_lock 可能被 VMThread 持有（doit_prologue/doit_epilogue 中）→ Thread-A 阻塞等 Heap_lock
     → end() 后 VMThread 释放 Heap_lock → Thread-A 获取 → 继续 doit_prologue → GCLocker check → 如果 skip → 返回 false
     → 或者 doit_prologue 成功 → Thread-A（在 safepoint 之外）调用 SafepointSynchronize::begin()
     → ★ 但此时 VMThread 的 safepoint 已经结束 → begin() 等待所有线程到达 → 正常完成 → GC 执行
```

### 4.4 ★ 不同 VM_Operation 的 pause time 组成差异

```
问题：
  ① G1 Young GC (VM_G1CollectForAllocation) 的 pause 分解:
     - spin: ~100μs（等所有线程 poll 到）
     - block: ~10μs（等线程状态转换）
     - vmop: ~10ms-500ms（实际 GC: pre_evacuate + evacuate + post_evacuate + free）
     - dominant: vmop_time（GC 本身占 >99% 的 pause）
     
  ② RevokeBias (VM_RevokeBias) 的 pause 分解:
     - spin: ~100μs（必须等所有线程，即使只需撤销一个线程的偏向锁）
     - block: ~10μs
     - vmop: <1μs（doit: 一个 CAS 操作）
     - dominant: spin_time（等线程占 >99% 的 pause）
     ★ 这就是为什么偏向锁撤销的 safepoint 这么昂贵——"杀鸡用牛刀"
     
  ③ GCLocker Initiated GC (GCCause::_gc_locker) 的 pause:
     - 由 jni_unlock 触发（最后一个 JNI critical 退出）
     - doit_prologue: GCLocker::is_active_and_needs_gc() = false（因为 count=0, _doing_gc=true）
     - heap->collect() → 正常执行
     - pause 组成同 Young GC，但 cause 是 _gc_locker
     
  ④ No-op safepoint (清理任务) 的 pause:
     - spin: ~100μs
     - cleanup: ~10μs (inline cache, CLD purge 等)
     - vmop: 0（无 GC）
     - dominant: spin_time
```

### 4.5 ★ `transition_and_fence` + `begin()` fence 的双向配合

```
问题：
  ① 两条 fence 形成了什么 happens-before 协议？
     
     路径 1 (VMThread → JavaThread):
       begin() L253: _state = _synchronizing
       begin() L264: OrderAccess::fence()  ← StoreLoad
       begin() L278: arm polling page
       → JavaThread poll: Sigsegv → handler → do_call_back() 读 _state = _synchronizing → block
       ★ fence 保证 _state 的写在 arm 前对 JavaThread 可见
     
     路径 2 (JavaThread → VMThread):
       transition_and_fence: _thread_state = _thread_blocked
       transition_and_fence: OrderAccess::fence()  ← StoreLoad (or serialize page)
       transition_and_fence: poll() ← JavaThread 开始 poll
       → VMThread SPIN: examine_state_of_thread() 读 _thread_state = _thread_blocked → roll_forward
       ★ fence 保证 _thread_state 的写在 SPIN 前对 VMThread 可见
     
     两条 fence 配对形成了"双向 handshake"：
       VMThread 写 _state → fence → JavaThread 读 → 进入 block
       JavaThread 写 _thread_state → fence → VMThread 读 → 标记到达
```

## 五、文章结构

```
§〇 源文件清单（跨 runtime/os/gc/shared）

§一 ★ 全景概览 — 一张图展示 safepoint 全生命周期
  ❓ 4 篇文章的子系统如何串在一起？
  1.1 Mermaid 全景时序图：从"分配失败"到"应用线程恢复"
  1.2 阶段分解：触发→入队→门禁→begin→GC→end→恢复
  1.3 线程上下文切换：分配者线程 ↔ VMThread ↔ JavaThread ↔ GC 线程

§二 ★★ 从分配失败到 VM_Operation 入队（衔接 [03] §四）
  ❓ 为什么分配失败的线程要自己构造 VM_Operation？
  2.1 genCollectedHeap 的 allocation retry loop（标注行号）
  2.2 VM_G1CollectForAllocation 的构造和排队
  2.3 分配者线程在 VMThread::execute() 之后的等待协议

§三 ★ doit_prologue — GCLocker 第一层门禁（衔接 [03] §五 + [04] §五）
  ❓ doit_prologue 在被 VMThread 唤醒的瞬间检查 GCLocker——如果 skip，代价是 0
  3.1 doit_prologue 源码走读（标注 Heap_lock 获取）
  3.2 skip_operation → is_active_and_needs_gc（纯读，不设 _needs_gc）
  3.3 两条路径的时间开销对比（skip vs continue）

§四 ★ begin() — safepoint 建立的 9 步（衔接 [01] §四-§五 + [02] §二/§四）
  ❓ 每一步什么线程？什么锁？什么 fence？
  4.1 步①-③: 获取锁 + 初始化计数器
  4.2 步④-⑤: _state=_synchronizing → arm polling（[02] 细节）
  4.3 步⑥-⑦: SPIN + BLOCK 双循环（[01] 细节 + _thread_in_native 处理 [02]）
  4.4 步⑧-⑨: _synchronized + set_jni_lock_count（[04] 交叉引用）
  4.5 步⑩: do_cleanup_tasks（symbolTable/stringTable/CLD/inlineCache）

§五 ★ doit() 内部 — GCLocker 第二层门禁 + GC 执行（衔接 [01] §三-L66 + [04] §五）
  ❓ 为什么需要第二层门禁——代价是一次浪费的 safepoint
  ❓ check_active_before_gc() 和 is_active_and_needs_gc() 的本质差异
  5.1 do_collection_pause_at_safepoint 源码走读
  5.2 GCLocker 第二层 — check_active_before_gc 设置 _needs_gc
  5.3 _needs_gc 首次设置的完整路径（首次分配失败 → 走完 safepoint → 设置 → 后续 skip）
  5.4 GC 执行四阶段（[06-GC-Memory 03-YoungGC] 引用）

§六 ★ end() — safepoint 拆除 + 恢复（衔接 [01] §六 + [02] disarm）
  ❓ disarm 后 block() 中的线程如何恢复？
  6.1 _state=_not_synchronized → disarm polling → notify_all → 释放 Threads_lock
  6.2 block() 中线程的恢复路径（Threads_lock->lock_without_safepoint_check）
  6.3 pause_time 的计算和 JFR/DTrace 事件

§七 ★★ GCLocker skip 的两条时间线对比（衔接 [04]）
  ❓ 第一层 skip ≈ 零开销 vs 第二层 skip ≈ 浪费 begin/end 但设置了 _needs_gc
  ❓ jni_unlock 在 safepoint 进行中退出的竞态窗口
  7.1 路径 A vs 路径 B 的 Mermaid 并行时序图
  7.2 竞态分析：JNI critical 退出 + VMThread SPIN 并发
  7.3 jni_unlock 的 heap->collect() 如何与正在进行的 safepoint 协调

§八 ★ 时间开销分解 + 不同 VM_Operation 对比
  ❓ 哪个阶段是 pause 的主要贡献者？
  ❓ 为什么 RevokeBias 的 safepoint 百分之九十九用来等线程？
  8.1 PrintSafepointStatistics 输出格式解读
  8.2 G1 Young GC vs RevokeBias vs GCLocker GC 的 pause 组成对比
  8.3 如何用 -XX:+PrintSafepointStatistics 排查长 pause 问题

§九 GDB 验证 + 可证伪断言（≥10 条）
  断言 1: safepoint 全链路调用栈验证（从 doit_prologue 到 end）
  断言 2: GCLocker first-layer skip vs second-layer skip 的断点验证
  断言 3: begin() fence + transition_and_fence fence 的双向 happens-before
  断言 4: PrintSafepointStatistics 各字段的源码级对应
  断言 5: _needs_gc 首次设置的精确断点（check_active_before_gc 在 g1CollectedHeap.cpp:3648）
  断言 6: jni_unlock 的 heap->collect() 在 safepoint 中/后的不同行为
  断言 7: block() 中线程在 Threads_lock 上排队的验证
  断言 8: doit_epilogue 中 Heap_lock->notify_all() 的触发点
  断言 9: 分配失败 → VM_G1CollectForAllocation → doit_prologue 的完整调用栈
  断言 10: SPIN 循环 + BLOCK 循环的时间差异（-XX:+PrintSafepointStatistics 验证）
```

## 六、写作要求

**最重要的一条**：以 [01] 和 [04] 的写作风格为参考——以"❓ 为什么..."开头，先建立设计动机，再用源码做证据。本文是 ALL 4 篇的总串联，不是目录或摘要。

1. **★ 全景 Mermaid 时序图是全文第一个核心交付物**：从"分配失败"到"应用线程恢复"，标注每个步骤的线程上下文、源文件:行号、[0X] 引用。时区要明确（分阶段用 background color 区分）

2. **★ 每一步必须标注"在哪个线程上执行"**：分配者线程 / VMThread / JavaThread / GC Worker Thread / Concurrent Mark Thread — 线程混淆是理解 safepoint 最大的障碍

3. **★ 和 [01][02][03][04] 的交叉引用必须精确到节**：不重述内容，只标注"详见 [0X] §N"

4. **★ GCLocker 的两条时间线对比是本文的独特贡献**：什么时候 skip 零开销 vs 什么时候 skip 浪费 begin/end——这是 [04] 没有明确定量的关键结论

5. **★ 时间开销分解必须有量化数据**：spin_time 量级 (μs)、block_time 量级 (μs)、vmop_time 量级 (ms-s)——标注这些数字来自 PrintSafepointStatistics 的哪个字段

6. **★ JNI critical 在 safepoint 进行中退出的竞态窗口**：这是 [04] 的"最后一个未回答的问题"——本文必须给出答案

7. **交叉引用**：[01-Safepoint-Protocol], [02-Polling-Mechanism], [03-VM-Operation-System], [04-GCLocker], [07-Thread-Architecture §五], [07-Internal-Locks], [10-NonJavaThread]

8. **GDB 验证重点**：safepoint 全链路调用栈 + GCLocker 两条路径的精确区分 + begin/fence/end 的完整序列

## 七、输出格式

- Markdown 文件，命名为 `05-Safepoint-Full-Path.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/08-safepoint/`
- 元信息头（标准环境 + 源文件 + 前置 [01] [02] [03] [04] + 阅读收益 + "阅读顺序最先，写作顺序最后"的说明）
