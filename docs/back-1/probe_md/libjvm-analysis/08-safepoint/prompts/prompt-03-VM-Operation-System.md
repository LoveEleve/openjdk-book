# PROMPT: 请撰写 03-VM-Operation-System.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**VM_Operation 三态调度与排队系统 — Mode 决策 + VMOperationQueue + evaluate_operation + doit_prologue 门禁 + VMThread::loop() 大循环**

### 核心故事线（禁止做源码翻译机！）

[01-Safepoint-Protocol] 把 begin/end 讲透了——VMThread 怎么暂停所有 JavaThread。
[02-Polling-Mechanism] 把轮询讲透了——JavaThread 怎么发现自己被 arm 了。

但有一个巨大的空白：[01] 的 timeline 图中 VMThread 在 `begin()`→`doit()`→`end()` 三步之间，**`doit()` 执行的是什么**？谁把它放进 VMThread 的执行队列的？GC、偏向锁撤销、逆优化、JIT 编译——这些完全不同的操作为什么都走同一条 `VMOperationQueue`？**多个线程同时请求 safepoint 怎么办？**

**本文的核心叙事线**是从"谁发起 safepoint"到"VMThread 如何选择执行什么操作"的完整追踪：

1. **★ VM_Operation 的三态 Mode — 不是所有操作都需要 STW**。`_safepoint`（阻塞调用者 + STW）、`_no_safepoint`（阻塞调用者 + 不 STW）、`_async_safepoint`（不阻塞调用者 + STW）。三态的差异不仅在于是否调用 `begin()`/`end()`，更在于**调用者线程的行为**：`_safepoint` 的调用者在 `VMThread::execute(op)` 中 `wait()` 直到 `doit()` 完成；`_async_safepoint` 的调用者直接返回。追问：**那 `_async_safepoint` 的调用者怎么拿到结果？** 不能——`VM_ThreadDump`（jstack）本身就是 fire-and-forget，结果输出到 jstack 的输出流，调用者不读返回值。`_no_safepoint` 又是另一回事——调用者阻塞但不 STW → `VM_Exit` 直接调用 `doit()` 不调 `begin()`。

2. **★ VMOperationQueue 的入队/出队机制 — 为什么不分优先级队列？** — 这不是偷懒，是**设计选择**。`_safepoint` 操作按 FIFO 排队，`_no_safepoint` 可以插队到前面。追问：**为什么不让 GC 操作最高优先级？** 单一 FIFO 队列保证**可预测性**——GC 操作不需要饥饿其他 safepoint 操作（如偏向撤销），因为 GC 本身已经是频率最高的 safepoint 触发者。`_no_safepoint` 插队的理由是它们**不 STW**，快速执行完就走，不拖延。再追问：**如果两个线程同时 new VM_GC_Operation 并 execute，谁先执行？** 第一个入队的先执行 → FIFO → 第二个线程的 `execute()` 在 `wait()` 中阻塞，等第一个完成后再执行第二个 → 这可能造成**重复 GC**：第一个 GC 完成后堆已有空间 → 第二个 GC 白做。这解释了 JVM 的优化：`VM_GC_Operation::doit_prologue()` 中的 GCLocker 检查——如果不需要 GC 了，`doit_prologue()` 返回 false 跳过整个 safepoint。

3. **★☆☆ VMThread::loop() 大循环和 evaluate_operation() — 三态调度的源码枢纽**。`VMThread::loop()` 是 VMThread 的**唯一运行逻辑**——一个无限循环，从队列取操作 → `evaluate_operation()` → 根据 Mode 决定路径。追问：**`evaluate_operation()` 是怎么决策的？** 调用 `op->evaluate()` → 检查 `doit_prologue()`（GC 操作的 GCLocker 门禁）→ 如果 false → 跳过 safepoint，VMThread 不调 begin()——直接回循环取下一个操作。再追问：**`doit_prologue()` 返回 false 后 VMThread 释放 `Safepoint_lock` 了吗？** 不需要——因为从没获取过（begin() 没被调），VMThread 只是在 VMOperationQueue 层放弃了本次操作。

4. **★ VM_Operation 的完整生命周期 — 从 C-heap 分配到 delete**。每个操作都是独立的 C-heap 对象（`new (ResourceObj::C_HEAP) VM_G1CollectForAllocation()`），不是栈对象、不是单例。为什么要堆分配？因为操作的发起者和执行者**不在同一条线程**——发起者（如 JavaThread 分配失败）new 操作后扔进队列就继续跑了，VMThread 后取出执行。追问：**谁负责 delete？** `evaluate_operation()` 执行完后 VMThread delete。追问：**如果 VM_Operation 是 `_async_safepoint`，调用者不等待——谁 delete？** VMThread 在 `doit()` 完成后 delete → 调用者线程完全不管理生命周期。

5. **★☆☆ `VMThread::execute()` 的阻塞机制 — 调用者如何等待 VMThread 完成？** 这是 `_safepoint` 和 `_no_safepoint` 模式的核心：调用者线程在 `VMOperationQueue::add()` 后立即 `wait()` 在一个内嵌的 Monitor 上 → VMThread 在 `doit()` 完成后 `notify_all()` 唤醒调用者。追问：**这个等待和 [01] 的 `block()` 中的 `Threads_lock->lock_without_safepoint_check()` 是什么关系？** 无关！`block()` 中的等待是 JavaThread（被 safepoint 暂停的线程）等 safepoint 结束；`execute()` 中的等待是 safepoint **发起者**（如触发 GC 的 JavaThread）等 GC 完成。前者在 `_thread_blocked` 中排队 `Threads_lock`，后者在 `_thread_in_vm` 中 `wait()` 在 VM_Operation 的内部 Monitor 上。两个阻塞点、两种语义、两套锁协议——不能混淆。

6. **★☆☆ `_no_safepoint` 操作的"插队"是怎么实现的？** — `VMOperationQueue` 实际上有**两个子队列**（`_queue[0]` 和 `_queue[1]`），而不是一个。`_safepoint` → `_queue[SafepointPriority]`，`_no_safepoint` → `_queue[NonSafepointPriority]`。`remove_next()` 先检查 NonSafepointPriority 子队列 → 有就出队 → 保证 `_no_safepoint` 操作永远优先于 `_safepoint` 操作执行。追问：**为什么这个"插队"是安全的？** 因为 `_no_safepoint` 操作不调 `begin()`/`end()` → 没有 STW → 不会导致 `_safepoint` 操作的调用者（已在 wait 中）被无限延迟——no_safepoint 操作很快（微秒级），等待时间可忽略。

7. **★ `evaluate_at_safepoint()` 的虚函数分发 — 不仅决定是否 STW，还决定调用者行为**。追问：**`_async_safepoint` 操作怎么做到"不阻塞调用者"？** `VMThread::execute()` 中检查 `op->evaluate_at_safepoint()`——如果是 `_safepoint` → 入队后 `wait()`；如果是 `_no_safepoint` → 入队后也 `wait()`（"阻塞"但"不 STW"）；如果是 `_async_safepoint` → 入队后**立即返回**（不 wait）。三种行为，由 Mode 决定。

### 禁止行为

- ❌ 把 `VMOperationQueue::add()` 贴出来逐行翻译——它就是在一个优先级数组里 push
- ❌ 把 `VMThread::loop()` 整个函数贴出来——只引用 evaluate_operation 的关键分支
- ❌ 把三个 Mode 列出来就完事——必须解释**每种 Mode 对调用者线程 / VMThread 的行为影响**
- ❌ 混淆 `execute()` 中调用者的等待和 `block()` 中 JavaThread 的等待——两套锁、两种语义
- ❌ 遗漏 `doit_prologue()` 的门禁作用——GCLocker 检查在 VM_Operation 层就完成
- ❌ 不解释 VM_Operation 的 C-heap 分配和生命周期——initiator vs executor 不同线程
- ❌ 不画 VMThread::loop() 的完整决策树——从取队列到 doit_prologue 到 Mode 分支
- ❌ 不验证源码行号——所有行号必须用 grep 确认
- ❌ 只讲 `vmOperations.cpp` 不讲 `vmThread.cpp`——loop() 和 evaluate 在 vmThread.cpp 中
- ❌ 忽略 `VM_Operation::evaluate()` 的两阶段：先 `doit_prologue()`（门禁）再 Mode 决策

### 要求行为

- ✅ **★ VMThread::loop() 的完整决策树必须画成 Mermaid 流程图**：loop → remove_next → evaluate → doit_prologue (GCLocker) → Mode 分支 (_safepoint → begin→doit→end / _no_safepoint → doit / _async_safepoint → begin→doit→end)
- ✅ **★ 三种 Mode 的对比表必须不小于 8 个维度**：是否 STW / 调用者是否阻塞 / 是否调用 begin/end / 调用者能拿回返回值吗 / 典型操作 / VMThread 执行路径 / 操作时间特性 / 队列优先级
- ✅ **★ VM_Operation 生命周期图**：创建 → C-heap 分配 → add 入队 → remove_next 出队 → doit_prologue 门禁 → Mode 分支 → doit() → cleanup（可选）→ 谁来 delete → 释放
- ✅ **★ 和 [01][02] 的双向引用**：
  - [02] 的轮询 → 本文解释 poll 到的 VM_Operation 是谁创建的、什么时候进来的
  - [01] 的 begin/end → 本文解释 begin/end 被谁调用（VMThread）及为什么有时不调（_no_safepoint）
  - [01] 的 block() 中 wait → 本文的 execute() 中 wait → 两套阻塞机制的对比
- ✅ **★ `evaluate_operation()` 的逐行分析**：为什么先 `doit_prologue()` 再 Mode 决策？先 eval_mode() 再检查模式？
- ✅ **★ VMOperationQueue 的双子队列结构**：SafepointPriority vs NonSafepointPriority
- ✅ **GDB 验证 ≥10 条**：重点在 verify VMOperationQueue 长度、Mode 分发的代码路径、调用者 wait 和 VMThread loop 的交互
- ✅ **典型 VM_Operation 子类的源码穿透**：至少分析 `VM_G1CollectForAllocation`（GC）、`VM_RevokeBias`（偏向锁）、`VM_ThreadDump`（jstack）三种，展示不同 Mode

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 核心函数（需验证行号） | 本文角色 |
|---|------|---------|---------------------|---------|
| 1 | `vmOperations.hpp` | `src/hotspot/share/runtime/vmOperations.hpp` | `VM_Operation`(:134), `Mode` enum(:136-141), `evaluate_at_safepoint()`(:207), `doit_prologue()` | ★★★ VM_Operation 基类 + Mode 三态定义 |
| 2 | `vmOperations.cpp` | `src/hotspot/share/runtime/vmOperations.cpp` | `VMOperationQueue::add()`(:56), `remove_next()` | ★★ 队列的入队/出队 + 双子队列 |
| 3 | `vmThread.hpp` | `src/hotspot/share/runtime/vmThread.hpp` | `VMThread`(:37), `execute()`(:62) | ★ execute 接口声明 |
| 4 | `vmThread.cpp` | `src/hotspot/share/runtime/vmThread.cpp` | `loop()`(:450), `evaluate_operation()`(:250), `execute()`(:330) | ★★★ 大循环 + evaluate 决策 + 调用者阻塞 |
| 5 | `vm_operations_g1.cpp` | `src/hotspot/share/gc/g1/vm_operations_g1.cpp` | `VM_G1CollectForAllocation::doit()`, `doit_prologue()` | ★ `_safepoint` 操作的典型子类 |
| 6 | `biasedLocking.cpp` | `src/hotspot/share/runtime/biasedLocking.cpp` | `VM_RevokeBias::doit()` | ★ 偏向撤销 — 小操作，大 STW |
| 7 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | `VM_ThreadDump::doit()` | ★ `_async_safepoint` — jstack 的 fire-and-forget |
| 8 | `vmGCOperations.cpp` | `src/hotspot/share/gc/shared/vmGCOperations.cpp` | `VM_GC_Operation::doit_prologue()`(:75) — GCLocker 门禁 | ★ 门禁机制的证据 |
| 9 | `safepoint.cpp` | `src/hotspot/share/runtime/safepoint.cpp` | `begin()`(:156), `end()`(:527) — 被 VMThread 在 evaluate 中调用 | ★ 交叉引用 [01] |

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。禁止贴整段函数。

### 4.1 ★★★ VM_Operation 的三态 Mode — 不仅决定 STW，还决定调用者行为

```
问题：
  ① Mode 三态是怎么定义的？
     线索: vmOperations.hpp Mode enum
     答案方向: _safepoint(0) / _no_safepoint(1) / _async_safepoint(2)
     每个值不只是一个数字——它影响两个维度的行为:
       (A) VMThread 是否调用 begin()/end()
       (B) 调用者线程是否在 execute() 中阻塞等待

  ② 为什么 _async_safepoint 的调用者不阻塞？
     答案方向: execute() 中检查 evaluate_at_safepoint() —— 如果是 async
     → 入队后直接返回，不在 Monitor 上 wait()
     → 调用者无法拿回 doit() 的返回值（也没有返回值需要拿——jstack 输出到流中）
     → 但 VMThread 仍然执行 begin→doit→end（需要 STW 获取所有线程的栈）

  ③ 三个 Mode 的完整决策矩阵（必须画表）:
     | 维度 | _safepoint | _no_safepoint | _async_safepoint |
     |------|-----------|--------------|-----------------|
     | STW？ | ✅ | ❌ | ✅ |
     | 调用者阻塞？ | ✅ (wait 在 Monitor 上) | ✅ (wait 在 Monitor 上) | ❌ (立即返回) |
     | begin()/end()？ | ✅ | ❌ | ✅ |
     | 调用者能拿返回值？ | 间接（通过操作对象的字段） | 间接 | ❌ |
     | 典型操作 | GC, Deopt, RevokeBias, RedefineClasses | VM_Exit, 部分 PrintThreads | VM_ThreadDump, VM_FindDeadlocks |
     | VMThread 执行路径 | evaluate → begin → doit → end → notify_all | evaluate → doit → notify_all | evaluate → begin → doit → end → (不 notify) |

  ④ Mode 是怎么被定义的——每个 VM_Operation 子类自己声明？
     答案方向: 虚函数 evaluate_at_safepoint() → 子类重写返回 true
     _no_safepoint 的操作重写 evaluate_at_safepoint() 返回 false（如 VM_Exit）
     _async_safepoint → evaluate_at_safepoint() 返回 true 但 behavior 由外部控制
     ★ 关键: Mode 不是独立字段，而是虚拟函数 + 外部调度的组合
```

### 4.2 ★☆☆ VMThread::loop() 大循环 — JVM 最核心的调度器

```
问题：
  ① loop() 的完整决策树是什么？
     线索: vmThread.cpp loop()
     答案方向:
       while(true) {
         op = queue->remove_next();        // 阻塞等操作
         evaluate_operation(op);            // 门禁检查 + Mode 分发
         delete op;                         // 释放
       }

  ② evaluate_operation() 内部的三阶段：
     阶段1: op->evaluate() → 调用 doit_prologue()
       → GC 操作: GCLocker::check_active_before_gc() → 返回 false → 跳过！
       → 其他操作: 默认返回 true
     阶段2: 检查 Mode → 决定 begin/end
     阶段3: op->doit() → 实际执行

  ③ 为什么 doit_prologue() 在 begin() 之前调用？
     答案方向: 因为 doit_prologue() 可能返回 false（如 GCLocker active）
     → 跳过整个 safepoint → 不调 begin() → 不 arm polling page
     → 节省无意义的 STW 开销
     → ★ 这是双层 GCLocker 检查的第一层（第二层在 doit() 内部的 check_active_before_gc()）

  ④ loop() 怎么处理空队列？
     答案方向: remove_next() 在没有操作时 → wait() 在 VMOperationQueue 内部 Monitor 上
     → 任何线程 add() 时 notify → VMThread 被唤醒 → 取出操作 → 继续
```

### 4.3 ★☆ VMOperationQueue — 双子队列 + FIFO + 插队

```
问题：
  ① 为什么有 _queue[0] 和 _queue[1] 两个子队列？
     线索: vmOperations.hpp 中 VMOperationQueue 的 _queue 数组
     答案方向: _queue[0] = SafepointPriority（_safepoint + _async_safepoint）
               _queue[1] = NonSafepointPriority（_no_safepoint）
      remove_next() 先检查 NonSafepointPriority → 有就取 → 没有再取 SafepointPriority
      → _no_safepoint 操作永远优先于 _safepoint

  ② 这个设计解决了什么问题？
     答案方向: 防止"饥饿"——_safepoint 操作（如 GC）可能耗时很长（几十ms）
     → 如果队列中排队了 _no_safepoint 操作（如 VM_Exit），不能被几十ms的 GC 阻塞
     → 插队保证 _no_safepoint 操作 ~μs 级完成

  ③ 为什么不给 GC 最高优先级？
     答案方向: 不需要。GC 已经是最高频率的 safepoint 触发者（占 >90%）。
     如果给 GC 优先级 → 偏向撤销、逆优化等被推迟 → 性能退化。
     FIFO 保证公平:K 个 safepoint 操作按到达顺序执行，没有操作被无限推迟。

  ④ add() 的 notify 机制:
     VMOperationQueue::add() → 入队 → lock 内部 Monitor → 入队列 → notify VMThread
     → VMThread 在 remove_next() 中 wait 在此 Monitor 上 → 被唤醒
     ★ 调用者不需要知道 VMThread 当前状态——notify+wait 解耦了生产者和消费者
```

### 4.4 ★☆ VM_Operation 的完整生命周期

```
问题：
  ① 创建: 谁 new？在哪分配？
     答案方向: 发起者线程（如 JavaThread 分配失败）在 C-heap 上
     new VM_G1CollectForAllocation(...) → mtInternal 类型
     ★ 为什么不是栈对象？因为发起者 new 后入队就返回了，栈对象会析构

  ② 入队: add() 做了什么？
     答案方向: 持有内部锁 → _queue[priority].push(op) → notify VMThread
     返回后调用者的行为取决于 Mode:
       _safepoint: 调 op->wait() → 阻塞在 VM_Operation 内嵌 Monitor 上
       _async_safepoint: 立即返回

  ③ 出队: remove_next() 怎么取？
     答案方向: VMThread 持有内部锁 → 先看 NonSafepointPriority 队列 → 再看 SafepointPriority → 
     都空 → wait() 在 Monitor 上（VMThread 空闲）

  ④ 执行: evaluate_operation() 怎么处理？
     答案方向: doit_prologue 门禁 → Mode 分支 → begin/doit/end 或直接 doit

  ⑤ 释放: 谁 delete？
     答案方向: VMThread 在 evaluate_operation() 返回后 delete op
     ★ 对于 _async_safepoint: VMThread delete（调用者不管生命周期）
     ★ 对于 _safepoint: doit() 完成后 VMThread notify_all 唤醒调用者 → 调用者返回前 op 已被 delete
     ★ 调用者只能从 op 对象的字段中读回结果——不能持有 op 指针
```

### 4.5 ★ `VMThread::execute()` 的阻塞机制 — 有别于 block()

```
问题：
  ① execute() 中调用者怎么等待？
     答案方向: VM_Operation 内部嵌一个 Monitor (ParkEvent 或类似)
     execute(op) → add to queue → op->wait() → 被阻塞
     VMThread doit() 完成后 → op->notify() → 唤醒调用者

  ② 这个等待和 block() 中的等待有什么不同？
     ★ 关键区别:
       (A) 线程状态: execute() 等待时线程是 _thread_in_vm / block() 等待时是 _thread_blocked
       (B) 等待的锁: execute() 等 VM_Operation 内嵌 Monitor / block() 等 Threads_lock
       (C) 唤醒者: execute() 由 VMThread 在完成 doit() 后唤醒 / block() 由 end() 中 Threads_lock->unlock() 释放
       (D) 语义: execute() = "等 GC 完成" / block() = "等 safepoint 结束"
       (E) 等待者: execute() = safepoint 发起者 / block() = safepoint 被暂停者

  ③ 为什么 _async_safepoint 不 wait？
     答案方向: fire-and-forget 语义 → jstack 不需要等线程 dump 完成才返回
     → execute() 中检查 op->evaluate_at_safepoint() 且 op->is_async() → 跳过 wait()
```

### 4.6 ★ 典型 VM_Operation 子类的源码穿透

```
问题：
  ① VM_G1CollectForAllocation (G1 Young GC):
     线索: vm_operations_g1.cpp
     Mode: _safepoint
     doit_prologue(): GCLocker::check_active_before_gc() 返回 false → 跳过 GC
     doit(): G1CollectedHeap::do_collection_pause_at_safepoint() → 实际执行 GC
     谁发起: JavaThread 分配失败 → VM_G1CollectForAllocation::doit_prologue

  ② VM_RevokeBias (偏向锁撤销):
     线索: biasedLocking.cpp
     Mode: _safepoint
     doit_prologue(): 默认返回 true（不需要 GCLocker）
     doit(): 遍历线程 → 找到持有偏向锁的线程 → 撤销
     为什么需要 STW？→ 偏向锁的状态修改需要所有线程的可见性保证

  ③ VM_ThreadDump (jstack):
     线索: thread.cpp
     Mode: _async_safepoint
     doit_prologue(): 默认返回 true
     doit(): 遍历所有线程 → 打印栈 → 输出到 jstack 流
     为什么是 async？→ jstack 命令行不需要等 dump 完成就退出
```

## 五、文章结构

```
§〇 源文件清单（跨 runtime/gc/prims）

§一 为什么需要一个统一的 VM_Operation 队列系统？
  ❓ 为什么不每个操作单独建一条线程？
  ❓ 为什么单一队列 + Mode 分发比多队列更好？
  1.1 三个典型场景：GC / 偏向撤销 / jstack
  1.2 单队列设计的核心理由：serialize VM operations（防止并发 STW）
  1.3 与 [01][02] 的衔接：VMThread 是被唤醒执行 begin/end 的——谁唤醒它的？

§二 ★★★ Mode 三态 — 一张表 + 一个决策树
  ❓ 为什么 _async_safepoint 调用者不阻塞？
  ❓ _no_safepoint 为什么不调 begin() 还叫 "safepoint" 相关操作？
  2.1 Mode 三态对比表（≥8 维度）
  2.2 evaluate_operation() 中的 Mode 决策树（Mermaid 流程图）
  2.3 doit_prologue() 门禁 — GCLocker 检查为什么在这里

§三 ★★ VMOperationQueue — 双子队列 + FIFO + 插队
  ❓ 为什么一个队列两个优先级就够了——为什么不多几个？
  3.1 _queue[0] vs _queue[1] — NonSafepointPriority 的插队机制
  3.2 add() / remove_next() 的生产者-消费者模型
  3.3 为什么不给 GC 最高优先级——FIFO 公平性论证

§四 ★★ VMThread::loop() — JVM 最核心的调度循环
  ❓ loop() 不 sleep 怎么不 100% CPU？
  ❓ 空队列时 VMThread 在哪里阻塞？
  4.1 loop() 的完整决策树（Mermaid 流程图）
  4.2 evaluate_operation() 的三阶段源码走读（doit_prologue → Mode 分支 → doit）
  4.3 空队列 → remove_next() → wait()

§五 ★ VM_Operation 生命周期
  ❓ 为什么是 C-heap 分配——不能用栈对象吗？
  ❓ 调用者怎么从 doit() 拿回结果？
  5.1 生命周期图：创建 → 入队 → 出队 → 门禁 → 执行 → 释放
  5.2 execute() 中调用者的阻塞 vs block() 中 JavaThread 的阻塞——两张表对比

§六 ★ evaluate_at_safepoint() 虚函数分发
  6.1 _safepoint 操作是怎么声明的
  6.2 _no_safepoint 操作重写 evaluate_at_safepoint() 返回 false
  6.3 _async_safepoint 的"双面性"——STW + 非阻塞调用者

§七 ★ 典型 VM_Operation 子类穿透
  7.1 VM_G1CollectForAllocation — GC 操作的双层 GCLocker 检查
  7.2 VM_RevokeBias — 小操作为什么需要 STW
  7.3 VM_ThreadDump — fire-and-forget 的异步 safepoint
  7.4 VM_Exit — 为什么是 _no_safepoint 而不是 _safepoint

§八 GDB 验证 + 可证伪断言（≥10 条）
  断言 1-2: VMOperationQueue 验证（队列长度、出队顺序）
  断言 3-4: evaluate_operation 中的 Mode 分支验证
  断言 5: VMThread loop() 断点验证空队列→wait
  断言 6: _no_safepoint 操作插队验证
  断言 7: doit_prologue GCLocker 门禁验证
  断言 8: execute() 调用者 wait 验证
  断言 9: VM_Operation C-heap 分配验证
  断言 10: _async_safepoint 不阻塞验证
```

## 六、写作要求

**最重要的一条**：以 [01] 和 [02] 的写作风格为参考——以"❓ 为什么..."开头，先建立设计动机，再用源码做证据。

1. **★ VMThread::loop() 的决策树是全文灵魂**：必须画 Mermaid 流程图——从 `remove_next()` 到 `evaluate_operation()` 的三个阶段分支——标注每一步的"谁、在哪、做什么"

2. **★ 和 [01][02] 的双向引用**：
   - [01] 的 begin/end → 本文解释是谁调用它们、什么条件下调用
   - [01] 的 block() 中 wait → 本文解释 execute() 中 wait → 两套阻塞机制对比
   - [02] 的 poll → 本文解释 poll 到的 VM_Operation 是谁创建的、何时入队的
   - [01] 的 GCLocker 检查在 doit_prologue → 本文解释 doit_prologue 是什么

3. **★ VM_Operation 的 C-heap 分配的生命周期论证**："因为发起者和执行者不是同一条线程"——一条原理贯穿创建/入队/执行/释放四个阶段

4. **★ doit_prologue() 的门禁作用**：与 [01] doit() 内部的第二层 GCLocker 检查形成双层保护

5. **★ 典型子类穿透**：GC / 偏向撤销 / jstack 三种操作——每种标注 Mode/调用者/doit 内容

6. **交叉引用**：[01-Safepoint-Protocol], [02-Polling-Mechanism], [07-VMThread], [07-02-BiasedLocking], [06-GC-Memory]

7. **GDB 验证重点**：队列长度、出队顺序（验证 NonSafepoint 优先）、evaluate 分行、execute 中调用者线程状态

## 七、输出格式

- Markdown 文件，命名为 `03-VM-Operation-System.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/08-safepoint/`
- 元信息头（标准环境 + 源文件 + 前置 [01-Safepoint-Protocol] [02-Polling-Mechanism] [07-VMThread] [07-02-BiasedLocking] [06-GC-Memory] + 阅读收益）
