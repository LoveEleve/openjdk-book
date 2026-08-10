# 03-VM-Operation-System — VM_Operation 四态调度 + 加权轮询队列 + evaluate_operation + doit_prologue 门禁 + VMThread::loop() 大循环

> **标准环境**：OpenJDK 11 slowdebug build, `-Xms8g -Xmx8g -XX:+UseG1GC`, 64-bit Linux x86
> **前置文档**：[01-Safepoint-Protocol], [02-Polling-Mechanism], [07-VMThread], [07-02-BiasedLocking], [06-GC-Memory]
> **阅读收益**：理解 safepoint 的"发起层"——GC、偏向撤销、jstack 等完全不同操作如何通过统一的 `VM_Operation` 队列和 `VMThread::loop()` 调度执行；`doit_prologue()` 门禁如何让 GC 操作在入队前就被 GCLocker 取消

---

## §〇 源文件清单

| # | 文件 | 完整路径 | 核心函数（已验证行号） | 本文角色 |
|---|------|---------|---------------------|---------|
| 1 | `vmOperations.hpp` | `src/hotspot/share/runtime/vmOperations.hpp` | `VM_Operation` class(:134), `Mode` enum(:136-141), `evaluate()`(:171), `doit_prologue()`(:181), `evaluate_at_safepoint()`(:207) | ★★★ 基类 + Mode 四态定义 + evaluator 接口 |
| 2 | `vmThread.hpp` | `src/hotspot/share/runtime/vmThread.hpp` | `VMOperationQueue`(:39), `Priorities`(:41-45), `VMThread::loop()`(:465), `evaluate_operation()`(:411), `execute()`(:686) | ★★★ 队列结构 + loop 调度循环 + execute 阻塞机制 |
| 3 | `vmThread.cpp` | `src/hotspot/share/runtime/vmThread.cpp` | `VMOperationQueue::add()`(:156), `remove_next()`(:176), `loop()`(:465), `evaluate_operation()`(:411), `execute()`(:686) | ★★★ 核心实现：加权轮询 + loop 全景 + 调用者阻塞 |
| 4 | `vmOperations.cpp` | `src/hotspot/share/runtime/vmOperations.cpp` | `evaluate()`(:58) | ★ evaluate 实现（调用 doit） |
| 5 | `vmGCOperations.cpp` | `src/hotspot/share/gc/shared/vmGCOperations.cpp` | `VM_GC_Operation::doit_prologue()` GCLocker 门禁 | ★ `_safepoint` 派生的 GC 基类 |
| 6 | `safepoint.cpp` | `src/hotspot/share/runtime/safepoint.cpp` | `begin()`(:156), `end()`(:527) | ★ 交叉引用——被 VMThread::loop() 在 _safepoint 分支调用 |

---

## §一 为什么需要 VM_Operation 队列系统？

### ❓ GC、偏向撤销、逆优化、jstack——完全不同的事，为什么走同一条队列？

[01-Safepoint-Protocol] 讲透了 `begin()`/`end()` 的三态协议，[02-Polling-Mechanism] 讲透了 JavaThread 怎么被暂停。但两篇都没有回答：**谁触发了 `begin()`？为什么 VMThread 决定"现在要 GC"而不是"现在要撤销偏向锁"？**

答案在 `VMThread::loop()` 中——一个单一的 while(true) 循环，从一个单一的 `VMOperationQueue` 中取出下一个 `VM_Operation`，根据其 `Mode` 决定调用还是跳过 `begin()`/`end()`。

**为什么不给每种操作单独建一条线程？** 因为所有需要 STW 的操作**必须串行化**——不可能同时执行两个 `begin()`。两条线程各自调用 `begin()` → 双重 `Safepoint_lock->lock()` → 第二条线程阻塞在锁上 → 死锁（因为第一个 safepoint 的 `end()` 还没被调，`Threads_lock` 还被 VMThread 持有着）。

单一队列的关键价值不是"简单"——是**互斥保证**。所有 STW 操作排队在 FIFO 队列中，VMThread 只有一个，不存在两个操作同时请求 safepoint 的竞争。

### ❓ 四种 Mode，四种操作——一个队列怎么满足不同需求？

```cpp
// vmOperations.hpp:136-141 — Mode enum
enum Mode {
    _safepoint,       // 阻塞调用者，STW 强制暂停所有 JavaThread
    _no_safepoint,    // 阻塞调用者，不 STW（直接执行，不调 begin/end）
    _concurrent,      // 不阻塞调用者，不 STW（立即返回 + 非 STW 执行）
    _async_safepoint  // 不阻塞调用者，STW 强制暂停（fire-and-forget）
};
```

**四种 Mode 不只是"要不要 STW"——它控制两个正交维度：(A) 调用者是否阻塞，(B) 是否调用 begin/end：**

| Mode | 调用者阻塞？ | 调用 begin/end？ | 调用者能拿返回值？ | 典型操作 |
|------|------------|-----------------|-----------------|---------|
| `_safepoint` | ✅ wait 在 `VMOperationRequest_lock` | ✅ | ✅（通过 doit_epilogue） | G1 GC、偏向撤销、逆优化、类重定义 |
| `_no_safepoint` | ✅ wait 在 `VMOperationRequest_lock` | ❌ 直接 `evaluate_operation` → `doit()` | ✅ | VM_Exit、某些 PrintThreads |
| `_concurrent` | ❌ 立即返回 | ❌ | ❌ | JIT 编译任务（`VM_Compile` 等） |
| `_async_safepoint` | ❌ 立即返回 | ✅ | ❌ | jstack (VM_ThreadDump)、死锁检测 |

**核心领悟**：`_safepoint` 和 `_async_safepoint` **都调用 begin/end**，区别只在调用者行为。Mode 通过两个虚函数分别控制两个正交维度——`evaluate_at_safepoint()` 决定 begin/end，`evaluate_concurrently()` 决定调用者是否阻塞。ticket 计数系统是阻塞机制的**执行工具**：ticket 不匹配 → wait；VMThread 完成后 increment → 唤醒。Mode 是决策者，ticket 是执行者。

### 1.1 与 [01][02] 的衔接

- [01] begin/end → 本文解释 begin/end 被 `VMThread::loop()` 中的 `_safepoint` 分支调用
- [02] poll → SIGSEGV → block → 本文解释触发 poll 的 VM_Operation（如 GC）从哪来、何时入队
- [01] block() 中的 wait → 本文解释 execute() 中的 wait → **两套完全不同的阻塞、两种不同的线程状态**

---

## §二 ★★ VMOperationQueue — 加权轮询调度 + 入队通知

### 2.1 双优先级队列——但不是你想的"Safepoint 让路给 NoSafepoint"

```cpp
// vmThread.hpp:41-45 — Priorities enum
// ★ 注意：源码注释 SafepointPriority 为 "Highest priority"，
//    但 remove_next() 使用 10:1 加权轮询 — 并非绝对最高优先级
enum Priorities {
    SafepointPriority, // _safepoint + _async_safepoint 的子队列
    MediumPriority,    // _no_safepoint 的子队列
    nof_priorities
};
```

**入队逻辑**（`vmThread.cpp:156-174`）：

```cpp
// vmThread.cpp:156-169
bool VMOperationQueue::add(VM_Operation *op) {
    if (op->evaluate_at_safepoint()) {
        queue_add_back(SafepointPriority, op);  // _safepoint + _async → 队列0
        return true;
    }
    queue_add_back(MediumPriority, op);          // _no_safepoint → 队列1
    return true;
}
```

**❓ `_concurrent` 操作（如 JIT 编译任务）怎么入队？** `evaluate_at_safepoint()` 返回 false → 进 `MediumPriority` 子队列——与 `_no_safepoint` **共享同一队列**。但与 `_no_safepoint` 不同的是，`_concurrent` 的 `evaluate_concurrently()` 返回 true → `execute()` 中调用者入队后直接返回，不 wait。本文聚焦 safepoint 相关操作，`_concurrent` 不展开。

### 2.2 ★ 出队逻辑：加权轮询——不是简单优先级

**重要：这不是 `_no_safepoint` 永远优先！** 实际算法是**计数器调度**（`vmThread.cpp:176-200`）：

```cpp
// vmThread.cpp:176-200 — remove_next() 
VM_Operation* VMOperationQueue::remove_next() {
    int high_prio, low_prio;
    if (_queue_counter++ < 10) {       // 10/11 次 → SafepointPriority
        high_prio = SafepointPriority;
        low_prio  = MediumPriority;
    } else {                           // 1/11 次 → MediumPriority
        _queue_counter = 0;
        high_prio = MediumPriority;
        low_prio  = SafepointPriority;
    }
    VM_Operation* op = queue_remove_front(
        queue_empty(high_prio) ? low_prio : high_prio);
    return op;
}
```

**❓ 为什么是 10:1 而不是永久的 Safepoint 优先？** 这解决的是**饥饿问题**——如果 SafepointPriority 永远优先，`_no_safepoint` 操作（如 VM_Exit）在高频率 safepoint 场景下（如每 10ms 一次 GC）可能被无限推迟。10:1 轮询保证每 11 次出队中，MediumPriority 至少有机会被选一次。

**❓ 为什么用 10:1 这个确切比例？** 源码注释指向 JDK bug 4390175——这是一个经验值。如果 GC 频率极高（如 heap 不足导致的重复 GC），Safe 操作占绝对多数，Medium 操作在 10:1 下仍有**固定频率**的服务保证。

### 2.3 `add()` 的 notify-wait 机制——生产者-消费者解耦

```cpp
// vmThread.cpp:686-733 — execute() 中的入队流程
{
    VMOperationQueue_lock->lock_without_safepoint_check();
    bool ok = _vm_queue->add(op);              // 入队
    VMOperationQueue_lock->notify();            // ★ 唤醒 VMThread
    VMOperationQueue_lock->unlock();
}
```

**VMThread 侧**（`vmThread.cpp:497-500`）：

```cpp
while (!should_terminate() && _cur_vm_operation == NULL) {
    bool timedout = VMOperationQueue_lock->wait(
        Mutex::_no_safepoint_check_flag, GuaranteedSafepointInterval);
    // timedout → 触发强制 safepoint（cleanup）
}
```

**通知链路**：调用者 `execute(op)` → add 入队 → `VMOperationQueue_lock->notify()` → VMThread 在 `VMOperationQueue_lock->wait()` 中被唤醒 → `remove_next()` 取出操作 → 执行。

**空队列时的强制 safepoint**：如果 `wait(timeout)` 超时而没有操作入队 → `no_op_safepoint_needed()` 返回 true（GuaranteedSafepointInterval 到期）→ `SafepointSynchronize::begin()` + `end()` —— 一个无操作的 safepoint，仅用于 do_cleanup_tasks()。这是 [01] 中 cleanup 任务的触发机制。

---

## §三 ★★★ VMThread::loop() — 大循环的完整决策树

### 3.1 Mermaid 流程图

这是全文的灵魂——从空队列等待到 SafepointSynchronize::begin/end 的完整决策：

```mermaid
flowchart TD
    START([VMThread::loop while true]) --> LOCK[获取 VMOperationQueue_lock]
    LOCK --> DEQUEUE[_cur_vm_operation = <br/>_vm_queue->remove_next]
    DEQUEUE --> HAS_OP{_cur_vm_operation<br/>!= NULL?}

    HAS_OP -->|Yes| EVAL_SAFE{op → evaluate_at_safepoint?}
    HAS_OP -->|No| NO_OP_WAIT[VMOperationQueue_lock → wait<br/>timeout=GuaranteedSafepointInterval]
    NO_OP_WAIT --> TIMEOUT{超时?}
    TIMEOUT -->|Yes| NEED_SAFE{no_op_safepoint_needed?}
    NEED_SAFE -->|Yes| FORCE_SAFE[SafepointSynchronize::begin<br/>do_cleanup_tasks<br/>SafepointSynchronize::end]
    FORCE_SAFE --> REQUEUE[再次调用 _vm_queue->remove_next]
    NEED_SAFE -->|No| REQUEUE
    TIMEOUT -->|No, 有新操作入队| REQUEUE
    REQUEUE --> HAS_OP2{_cur_vm_operation?}
    HAS_OP2 -->|Yes| DRAIN[drain_at_safepoint_priority<br/>one safepoint 批量取所有]
    DRAIN --> EVAL_SAFE

    EVAL_SAFE -->|Yes: _safepoint| SAFE_PATH[SafepointSynchronize::begin<br/>[01] 三态协议]
    SAFE_PATH --> ARM_TIMEOUT[arm VMOperationTimeoutTask]
    ARM_TIMEOUT --> EVAL_OP1[evaluate_operation op1]
    EVAL_OP1 --> NEXT_COAL{队列中还有<br/>safepoint op?}
    NEXT_COAL -->|Yes| EVAL_OP_N[evaluate_operation next<br/>★ Coalesced: 1 safepoint=N VM ops]
    EVAL_OP_N --> NEXT_COAL
    NEXT_COAL -->|No| DISARM[drain more? → arm/disarm loop]
    DISARM --> SAFE_END[SafepointSynchronize::end<br/>[01] disarm + restart]
    SAFE_END --> LOCK

    EVAL_SAFE -->|No| NOT_SAFE[evaluate_operation op<br/>直接 doit，不 begin/end]
    NOT_SAFE --> LOCK
```

### 3.2 ★ 关键设计：Coalescing — 一次 safepoint 可以批量处理多个 _safepoint 操作

这是 `loop()` 最精妙的部分（`vmThread.cpp:560-609`）。进入 safepoint 后，VMThread 调用 `drain_at_safepoint_priority()` 把**队列中所有剩下的 `_safepoint` 操作一次性取出来**，在**同一个 begin/end 周期内**依次执行。

```cpp
// vmThread.cpp:560-573 — safepoint 路径
if (_cur_vm_operation->evaluate_at_safepoint()) {
    _vm_queue->set_drain_list(safepoint_ops);  // 注入排空列表
    SafepointSynchronize::begin();             // 一次 STW
    evaluate_operation(_cur_vm_operation);      // 执行第一个操作（GC）
    // 然后处理所有排空队列中的操作
    do {
        _cur_vm_operation = safepoint_ops;
        while (_cur_vm_operation != NULL) {
            VM_Operation* next = _cur_vm_operation->next();
            evaluate_operation(_cur_vm_operation);  // 执行下一个
            _cur_vm_operation = next;
        }
        // 再次检查是否有新入队的 safepoint 操作
        if (_vm_queue->peek_at_safepoint_priority()) {
            safepoint_ops = _vm_queue->drain_at_safepoint_priority();
        }
    } while(safepoint_ops != NULL);
    SafepointSynchronize::end();               // 一次恢复
}
```

**❓ 为什么需要 Coalescing？** 假设三个线程几乎同时触发 GC、偏向撤销和逆优化。如果不 coelesce：
- GC → begin() → doit() → end() → 撤销 → begin() → doit() → end() → 逆优化 → begin() → doit() → end()
- 3 次 safepoint，每次 arm/disarm polling page → 3 × TLB shootdown

Coalescing 后：
- begin() → doit(GC) → doit(撤销) → doit(逆优化) → end()
- 1 次 safepoint，1 次 TLB shootdown → **~3x 效率提升**

**★ Pre-fetch 模式**：Coalescing 循环的每一轮都预先取出下一个操作的指针（`VM_Operation* next = _cur_vm_operation->next()`），**然后**调用 `evaluate_operation(_cur_vm_operation)`（内部会 delete 当前 op）。delete 后 `_cur_vm_operation` 已悬空，但 `next` 已被提前保存——loop() 随后将 `_cur_vm_operation = next` 推进到下一个节点。没有 pre-fetch，delete 后再访问 `->next()` 就是 use-after-free。

### 3.3 `evaluate_operation()` — 执行 + 生命周期管理

```cpp
// vmThread.cpp:411-442 — evaluate_operation()
void VMThread::evaluate_operation(VM_Operation* op) {
    {
        op->evaluate();          // ★ 调用 VM_Operation::evaluate() → doit()
    }
    bool c_heap_allocated = op->is_cheap_allocated();
    if (!op->evaluate_concurrently()) {
        op->calling_thread()->increment_vm_operation_completed_count(); // ★ ticket++
    }
    if (c_heap_allocated) {
        delete _cur_vm_operation;  // ★ 删 _cur_vm_operation 而非 op：避免成员悬空
    }
}
```

**关键三步**：
1. `op->evaluate()` → 调用子类重写的 `doit()`（实际执行业务逻辑）
2. **ticket 递增**：`increment_vm_operation_completed_count()` —— **但仅对非 concurrent 模式**（`_safepoint` 和 `_no_safepoint`）。`_async_safepoint` 的 `evaluate_concurrently()` 返回 true，不递增 ticket——因为调用者不阻塞，无需唤醒
3. **delete _cur_vm_operation**：删的是成员变量而非参数——在 Coalescing 场景中，此函数可能被循环调用，每次 `_cur_vm_operation` 指向 drain_list 的下一个节点，delete 后 loop() 在调用侧重置为 `next`

---

## §四 ★☆ VMThread::execute() — 调用者的阻塞与返回

### 4.1 ticket 计数系统——调用者如何知道"VMThread 完成了我提交的操作"？

`execute()` 不是简单的 "入队 + wait"——它使用一个 ticket 系统来处理**多操作并发提交**（`vmThread.cpp:686-745`）：

```cpp
// vmThread.cpp:686-745 — execute() 的关键路径
void VMThread::execute(VM_Operation* op) {
    Thread* t = Thread::current();
    if (!t->is_VM_thread()) {
        bool concurrent = op->evaluate_concurrently();

        // ① ★ doit_prologue 门禁 — GCLocker 检查
        if (!concurrent) {
            t->check_for_valid_safepoint_state(true);
        }
        if (!op->doit_prologue()) {
            return;   // ★ 门禁拒绝 → 直接返回，不入队！
        }

        // ② 入队 + ticket
        op->set_calling_thread(t, Thread::get_priority(t));
        int ticket = 0;
        if (!concurrent) {
            ticket = t->vm_operation_ticket();  // ★ 记录 ticket（per-thread 计数器，每个调用者线程独立计数）
        }

        // ③ 入队 + notify VMThread
        {
            VMOperationQueue_lock->lock_without_safepoint_check();
            _vm_queue->add(op);
            VMOperationQueue_lock->notify();
            VMOperationQueue_lock->unlock();
        }

        // ④ ★ 调用者阻塞在 VMOperationRequest_lock 上
        if (!concurrent) {
            MutexLocker mu(VMOperationRequest_lock);
            while(t->vm_operation_completed_count() < ticket) {
                VMOperationRequest_lock->wait(!t->is_Java_thread());
            }
        }

        // ⑤ doit_epilogue (操作完成后的回调)
        if (execute_epilog) {
            op->doit_epilogue();
        }
    }
}
```

### 4.2 ★ 和 [01] block() 中的等待是两套完全不同的阻塞

| 维度 | `execute()` 中 wait | `block()` 中 wait |
|------|-------------------|-------------------|
| 哪条线程在等 | **调用者**线程（如触发 GC 的 JavaThread） | **被暂停的** JavaThread |
| 线程状态 | `_thread_in_vm`（调用者通过 ThreadInVMfromJava / ThreadInVMfromNative 进入 VM 代码） | `_thread_blocked`（被 safepoint 暂停） |
| 等待的锁 | `VMOperationRequest_lock` | `Threads_lock` |
| 唤醒者 | VMThread 在 `evaluate_operation()` 中 `op->evaluate()` 返回后调用 `increment_vm_operation_completed_count()` | VMThread 在 end() 中 `Threads_lock->unlock()` |
| 语义 | "等我的 GC 完成" | "等 safepoint 结束，我想继续跑" |
| ticket 系统？ | ✅ ticket 比较 `completed_count < ticket` | ❌ 无 ticket，只在 `Threads_lock` 上排队 |
| 被暂停？ | ❌ 未暂停——在 VM 代码中正常运行 | ✅ 已暂停——线程在 `_thread_blocked` 状态 |

**核心洞察**：Java GC 线程（触发 GC 的那个）**不属于被 safepoint 暂停的线程**——它在 `_thread_in_vm` 中执行 `execute()` → 入队 → wait 在 `VMOperationRequest_lock` 上 → 等 VMThread 完成 GC → doit_epilogue → 返回。

---

## §五 ★ `doit_prologue()` 门禁——GCLocker 在入队之前拦截 GC

### 5.1 门禁在哪一步生效？

注意 `execute()` 的流程：**先调 `doit_prologue()` → 再入队**。这是刻意设计：

```cpp
// vmThread.cpp:699-701
if (!op->doit_prologue()) {
    return;   // ★ 不入队！不 notify VMThread！不浪费任何 safepoint 开销
}
```

GC 操作的 `doit_prologue()` 重写（`vmGCOperations.cpp`）：

```cpp
// VM_GC_Operation::doit_prologue()
// 检查 GCLocker: is_active_and_needs_gc() → 如果有 JNI critical → 返回 false
```

**❓ 为什么门禁要放在 `execute()` 中（调用者线程），而不是在 `evaluate_operation()` 中（VMThread）？**

因为如果在 VMThread 中才检查：
- 调用者入队→ notify VMThread → VMThread 取出 → 检查 GCLocker → 发现 active → 放弃 → **白白 wake 了 VMThread + 产生了锁竞争**。
- 调用者线程自己检查 → 不入队 → VMThread 继续 sleep → **零开销**。

### 5.2 与 [01] doit() 内部 GCLocker 检查的关系——双层门禁

| | 第一层：doit_prologue() | 第二层：doit() 内部 check_active_before_gc() |
|---|---|---|
| **位置** | 调用者线程，入队前 | VMThread，begin() 之后 |
| **时机** | 操作还未入队 | 操作已取出，safepoint 已完成 begin |
| **检查内容** | `GCLocker::check_active_before_gc()`（内部先判 `is_active_and_needs_gc()` 再判 `!is_at_safepoint()`——已在 safepoint 中时不过滤） | `GCLocker::check_active_before_gc()` |
| **如果 active** | 不入队，调用者返回 | begin() 已执行（STW 已开始），放弃 doit()，jni_lock_count 记录到 safepoint 中 |
| **为什么需要两层？** | 避免无意义的 VMThread 唤醒 + 排队 | begin() 过程中 GCLocker 状态可能变化（JNI critical 进入/退出）——第二层确保在执行 GC 前状态是最新的 |

**这就是为什么 [01] 中 `begin()` 代码里搜不到 GCLocker**——它不仅在 begin() 外，还在入队之前。

---

## §六 ★ VM_Operation 的完整生命周期

### 6.1 生命周期图

```
调用者线程                              VMThread
──────────                              ────────

① new VM_G1CollectForAllocation()       [在 wait(VMOperationQueue_lock)]
    → C-heap 分配 (mtInternal)

② op->doit_prologue()                   [waiting...]
    → GCLocker OK? → Yes → 继续
    → No → return（调用者负责清理 op；C-heap 分配时有潜在 leak）

③ op->set_calling_thread(t, prio)
   ticket = t->vm_operation_ticket()

④ VMOperationQueue_lock->lock()
   _vm_queue->add(op)           ──notify──→ 被唤醒！
   VMOperationQueue_lock->unlock()            remove_next() → op 出队

⑤ VMOperationRequest_lock->lock()
   while(completed_count < ticket)
     VMOperationRequest_lock->wait()         ↓ [in _safepoint branch]
                                           SafepointSynchronize::begin()
                                           [01] arm polling page + 等所有线程
                                           ↓
                                           op->evaluate() → doit()
                                           ↓
                                           SafepointSynchronize::end()
                                           [01] disarm + restart
                                           ↓
                                           increment_vm_operation_completed_count()
                                           ──ticket matched!──→ 被唤醒！
                                           ↓
                                           delete op (C-heap)
                                           ↓
   doit_epilogue()                          next loop iteration
   return ← 调用者恢复执行
```

### 6.2 为什么必须 C-heap 分配？

`VM_Operation` 继承自 `CHeapObj<mtInternal>`（`vmOperations.hpp:134`）。**如果放在栈上会怎样？**

调用者线程的 `execute(op)` 中 op 是局部变量（栈对象）→ 入队 → 调用者被阻塞在 wait 中。问题：如果 `execute()` 返回后栈帧被释放 → op 所在的内存变成**野指针** → VMThread 在此之后可能才 `delete op`（VMT 还在 loop 中）。

但等等——调用者的 `execute()` **确实阻塞在 wait 中**（_safepoint 模式），所以栈对象在阻塞期间存活着。那为什么还需要 C-heap？答案是：**`_async_safepoint` 模式**——调用者**不阻塞**，`execute()` 立即返回 → 栈帧释放 → 栈内存被后续函数调用覆盖 → VMThread 后取出执行时读到随机数据 → 不可预测行为（use-after-free，可能 crash 也可能静默出错）。

**统一用 C-heap 是最安全的选择**：不管 Mode 是什么，生命周期由 VMThread 管理，调用者不必考虑内存问题。

---

## §七 GDB 验证 + 可证伪断言

### 断言 1-2：VMOperationQueue 加权轮询验证

**断言 1**：`remove_next()` 的 counter 在 0-10 之间循环

```gdb
(gdb) br vmThread.cpp:185
(gdb) commands
> silent
> printf "remove_next: _queue_counter=%d, high_prio=%d\n", \
    _vm_queue->_queue_counter, (int)(_vm_queue->_queue_counter < 10 ? 0 : 1)
> continue
> end
# 预期：0-9 → SafepointPriority, 10 → MediumPriority, 然后重置
```

**断言 2**：入队后 `_queue_length` 增加

```gdb
(gdb) br vmThread.cpp:168  # SafepointPriority 入队后
(gdb) commands
> silent
> printf "add SafepointPriority: queue_length=%d\n", \
    _vm_queue->_queue_length[0]
> continue
> end
```

### 断言 3：Mode 分发验证

**断言 3**：`_safepoint` 操作走 `begin→evaluate→end` 路径

```gdb
(gdb) br vmThread.cpp:565  # SafepointSynchronize::begin(); 
(gdb) commands
> silent
> printf "begin() called for: %s\n", _cur_vm_operation->name()
> continue
> end
```

**断言 4**：`_no_safepoint` 不调 `begin()`

```gdb
# 在 L560 的 if(evaluate_at_safepoint()) 处
(gdb) br vmThread.cpp:560
(gdb) commands
> silent
> printf "op=%s, safepoint=%d, going to 'else' branch=%d\n", \
    _cur_vm_operation->name(), \
    _cur_vm_operation->evaluate_at_safepoint(), \
    !_cur_vm_operation->evaluate_at_safepoint()
> continue
> end
```

### 断言 5：`doit_prologue()` 门禁验证

```gdb
(gdb) br vmThread.cpp:699  # if (!op->doit_prologue())  ← 在 execute() 中，变量名是 op
(gdb) commands
> silent
> printf "doit_prologue for %s returned: %d\n", \
    op->name(), \
    op->doit_prologue()
> continue
> end
```

### 断言 6-7：Coalescing 验证

**断言 6**：多次 safepoint 操作在一次 begin/end 中批量执行

```gdb
(gdb) br vmThread.cpp:578  # coalesced 循环
(gdb) commands
> silent  
> printf "Coalesced op: %s\n", _cur_vm_operation->name()
> continue
> end
```

**断言 7**：drain_at_safepoint_priority 后队列清空

```gdb
(gdb) br vmThread.cpp:529  # safepoint_ops = _vm_queue->drain_at_safepoint_priority()
(gdb) commands
> silent
> printf "SafepointPriority queue length after drain: %d\n", \
    _vm_queue->_queue_length[0]
> continue
> end
# 预期：0
```

### 断言 8-9：ticket 系统验证

**断言 8**：调用者线程在 execute() 中阻塞在 VMOperationRequest_lock 上

```gdb
(gdb) br vmThread.cpp:740  # VMOperationRequest_lock->wait
(gdb) commands
> silent
> printf "Caller %s waiting: ticket=%d, completed=%d\n", \
    Thread::current()->name(), \
    ticket, Thread::current()->vm_operation_completed_count()
> continue
> end
```

**断言 9**：VMThread 调用 increment_vm_operation_completed_count 唤醒调用者

```gdb
(gdb) br vmThread.cpp:436  # calling_thread()->increment_vm_operation_completed_count()
(gdb) commands
> silent
> printf "VMThread completed op: %s, calling_thread=%s\n", \
    op->name(), op->calling_thread()->name()
> continue
> end
```

### 断言 10：`_async_safepoint` 不阻塞调用者

```gdb
# 在 execute 入口和出口打断点
(gdb) br vmThread.cpp:686
(gdb) br vmThread.cpp:745
(gdb) commands 686
> silent
> printf "execute ENTER: op=%s, mode=%d\n", op->name(), op->evaluation_mode()
> continue
> end
(gdb) commands 745
> silent
> printf "execute RETURN: op=%s, concurrent=%d\n", op->name(), op->evaluate_concurrently()
> continue
> end
# _async_safepoint: ENTER 和 RETURN 之间无 wait → 调用者无阻塞
```

### 可证伪断言汇总

| # | 断言 | 验证方法 | 可证伪条件 |
|---|------|---------|-----------|
| 1 | `remove_next()` 是 10:1 加权轮询 | GDB 跟踪 `_queue_counter` | 非 10:1 |
| 2 | `_safepoint` 操作走 begin→eval→end | GDB 在 begin() 和 evaluate_operation 断点 | begin 没被调 |
| 3 | `_no_safepoint` 操作不走 begin() | GDB L560 分支 | 进了 _safepoint 分支 |
| 4 | doit_prologue 返回 false → 不入队 | GDB L699 断点 | false 仍然入队 |
| 5 | 一次 safepoint 可以批量执行多个操作 | GDB coalesced 循环 | 仅执行一个 |
| 6 | drain 后 SafepointPriority 队列为空 | GDB 读 `_queue_length[0]` | 非 0 |
| 7 | 调用者 ticket 不匹配时阻塞 | GDB L740 wait 断点 | 不阻塞 |
| 8 | VMThread 完成 op 后 increment ticket | GDB L436 断点 | 不 increment |
| 9 | `_async_safepoint` 调用者不 wait | GDB execute ENTER→RETURN 之间无 wait | 有 wait |
| 10 | VM_Operation 是 C-heap 对象 | GDB `ptype op` → 继承 CHeapObj | 栈对象 |

---

## 关键 JVM 参数

| 参数 | 默认值 | 作用 |
|------|--------|------|
| `-XX:GuaranteedSafepointInterval` | 1000 (ms) | 强制 safepoint 间隔（null op 触发 do_cleanup_tasks） |
| `-XX:+SafepointTimeout` | false | 启用 safepoint 超时检测 |
| `-XX:SafepointTimeoutDelay` | 10000 (ms) | 超时阈值 |
| `-XX:+PrintSafepointStatistics` | false | 打印 safepoint 统计（含 vmop 类型） |
| `-XX:+PrintVMQWaitTime` | false | 打印 VM_Operation 队列等待时间 |

---

## 关键日志

```bash
java -Xms8g -Xmx8g -XX:+UseG1GC \
  -XX:+PrintSafepointStatistics \
  -XX:PrintSafepointStatisticsCount=1 \
  -jar app.jar

# 输出示例:
#          vmop  [threads: total initially_running wait_to_block]  [time: spin block sync cleanup vmop] page_trap_count
# 0.364: G1CollectForAllocation [    12      4      3    ]  [    1     0     1     0    29    ]  3
# 0.412: RevokeBias             [    12      0      0    ]  [    0     0     0     0     1    ]  0
# 0.615: no vm operation        [    10      0      0    ]  [    0     0     0     3     0    ]  0
#        ▲                                                                                     ▲
#   "no vm operation" = 强制 safepoint（GuaranteedSafepointInterval 到期）                      
```
