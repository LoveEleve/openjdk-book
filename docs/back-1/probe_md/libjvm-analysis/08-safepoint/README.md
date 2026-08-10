# 08 - Safepoint 机制

> **标准环境**：OpenJDK 11 slowdebug build, `-Xms8g -Xmx8g -XX:+UseG1GC`, 64-bit Linux x86
> **已完结阶段**：[07-thread-lock] — 16 篇，覆盖 21+ 条线程 + 80+ 把内部锁
> **源码索引**：`source_index/02-runtime.md` (safepoint/threadSMR/vmOperations), `source_index/06-gc.md` (gcLocker)

> ★ 本阶段是 **07-thread-lock 的自然延续**：[07] 的 VMThread 在 safepoint 中执行 VM_Operation 已经讲了，[07 §四] 的 safepoint_check 三态已经讲了，[10] 的 NonJavaThread 不参与 safepoint 已经讲了。本阶段聚焦**"safepoint 协议本身是如何工作的"**——轮询、阻塞、JNI Critical、ThreadSMR——这些是对 [07] 拼图的补全。

---

## 〇、为什么需要这个阶段？

07-thread-lock 把 21+ 条线程和 80+ 把锁讲完了，但留下了几个拼图空白：

| [07] 留下的问题 | 本阶段对应的答案 |
|---|---|
| VMThread 调用 `SafepointSynchronize::begin()`，里面发生了什么？ | **01-Safepoint-Protocol** — begin/end 三态协议 + 等所有线程到达 |
| JavaThread 被 safepoint "暂停"，到底是怎么暂停的？ | **02-Polling-Mechanism** — Polling Page mprotect + SIGSEGV 处理 |
| `ThreadBlockInVM` 和 `transition_and_fence` 在 safepoint 中的角色？ | **02-Polling-Mechanism** — 线程状态转换与 fence 的必要性 |
| JNI Critical 怎么阻止 GC？`GCLocker` 怎么工作的？ | **03-GCLocker** — jni_lock_count + needs_gc + 延迟 GC |
| `ThreadSMR` 的 Hazard Pointer 和 safepoint 的交互？ | 交叉引用 [07-Thread-Architecture §五] |
| `Handshake`（JDK 10+）如何替代部分 safepoint？ | 交叉引用 — 本文聚焦 JDK 11 默认 Polling Page 模式 |

---

## 一、核心源文件清单

| # | 文件 | 完整路径 | 核心类/函数 | 本阶段角色 |
|---|------|---------|------------|----------|
| 1 | `safepoint.hpp` | `src/hotspot/share/runtime/safepoint.hpp` | `SafepointSynchronize`(:59), `SynchronizeState`(:61-66), `ThreadSafepointState`(:228) | ★★★ begin/end 三态机 + 等待逻辑 |
| 2 | `safepoint.cpp` | `src/hotspot/share/runtime/safepoint.cpp` | `begin()`(:156), `end()`(:527), `block()`(:859), `check_for_lazy_critical_native()` | ★★★ 核心实现：双循环等线程（spin+block）、do_cleanup_tasks、恢复 |
| 3 | `safepointMechanism.hpp` | `src/hotspot/share/runtime/safepointMechanism.hpp` | `SafepointMechanism`(:34), `arm/disarm`, `thread_local_poll` | ★★ Polling Page vs ThreadLocal 两种模式 |
| 4 | `safepointMechanism.inline.hpp` | `src/hotspot/share/runtime/safepointMechanism.inline.hpp` | `global_poll()`(:37), `local_poll()`(:41), `poll()`(:50), `block_if_requested()` | ★★ 内联轮询逻辑 — 每个 JavaThread 的热路径 |
| 5 | `safepointMechanism.cpp` | `src/hotspot/share/runtime/safepointMechanism.cpp` | `default_initialize()`(:42), `block_if_requested_slow()` | 初始化 + 慢路径 |
| 6 | `vmOperations.hpp` | `src/hotspot/share/runtime/vmOperations.hpp` | `VM_Operation`(:134), `Mode` enum(:136-141), `evaluate_at_safepoint()`(:207) | ★★ VM_Operation 三态调度 |
| 7 | `vmOperations.cpp` | `src/hotspot/share/runtime/vmOperations.cpp` | `VMOperationQueue::add()`(:56) | 队列操作 |
| 8 | `gcLocker.hpp` | `src/hotspot/share/gc/shared/gcLocker.hpp` | `GCLocker`(:38), `_jni_lock_count`(:45), `_needs_gc`(:46) | ★★ JNI Critical 阻止 GC 的核心 |
| 9 | `gcLocker.cpp` | `src/hotspot/share/gc/shared/gcLocker.cpp` | `jni_lock()`(:123), `jni_unlock()`, `check_active_before_gc()` | ★★ JNI Critical 进入/退出 + GC 延迟检查 |
| 10 | `interfaceSupport.inline.hpp` | `src/hotspot/share/runtime/interfaceSupport.inline.hpp` | `ThreadBlockInVM`(:297), `transition_and_fence()`(:136) | ★ 线程状态转换 + StoreLoad fence |
| 11 | `threadSMR.hpp` | `src/hotspot/share/runtime/threadSMR.hpp` | `ThreadsSMRSupport`, `ThreadsListHandle` | Hazard Pointer — 交叉引用 [07] |
| 12 | `threadSMR.cpp` | `src/hotspot/share/runtime/threadSMR.cpp` | `smr_delete()`, `_java_thread_list` | 安全删除 — 交叉引用 [07] |
| 13 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | `make_polling_page_unreadable()`(:6011), `make_polling_page_readable()`(:6018) | ★ Linux 平台轮询页的 mprotect 实现 |
| 14 | `handshake.hpp` | `src/hotspot/share/runtime/handshake.hpp` | `Handshake`(:48), `HandshakeClosure` | JDK 10+ ThreadLocal Handshake — 浅析 |
| 15 | `handshake.cpp` | `src/hotspot/share/runtime/handshake.cpp` | `execute()`(:389) | 线程握手的调度 |
| 16 | `safepointVerifiers.hpp` | `src/hotspot/share/runtime/safepointVerifiers.hpp` | `NoSafepointVerifier`(:110) | assert 工具：禁 safepoint 区域 |

---

## 二、文档计划（5 篇）

### [01] Safepoint-Protocol — begin/end 三态协议 + 等所有线程

> **核心叙事**：`SafepointSynchronize::begin()` 是 JVM 中最关键的同步点——它把 JVM 从"所有线程并发"转换到"只有 VMThread 在跑"。这中间发生了：(1) arming 轮询机制 → (2) 等所有 JavaThread 到达安全点 → (3) GCLocker 检查 → (4) 进入 _synchronized 状态。`end()` 则做反向操作。这篇文章回答：**为什么 begin() 有时要等几秒钟？哪些线程最慢？JNI Critical 怎么延迟 safepoint？**

#### 聚焦源文件

| # | 文件 | 核心函数 | 必读行号 |
|---|------|---------|---------|
| 1 | `safepoint.cpp` | `begin()`, `end()`, `block()` | begin:156-510, end:527-600, block:859-920 |
| 2 | `safepoint.hpp` | `SynchronizeState` enum | :61-66 |
| 3 | `safepointMechanism.hpp` | `arm/disarm` | :80-87 |
| 4 | `os_linux.cpp` | `make_polling_page_unreadable/readable` | :6011-6021 |

#### 必须深度走读的概念

```
1. ★★★ 三态状态机 + 源码验证 (safepoint.hpp:61-66):
   _not_synchronized(0) — 正常并发运行
        ↓ begin() @L156: 获取 Threads_lock + Safepoint_lock
   _synchronizing(1)    — @L253: _state = _synchronizing, 然后 arm polling page
        ↓ 两阶段等待（spin + block）
        ↓ @L468: _state = _synchronized
   _synchronized(2)     — 只有 VMThread 在跑，执行 doit() + cleanup
        ↓ end() @L527 被调用
   _not_synchronized(0) — 恢复并发

   ★ 关键: _synchronizing(1) 是中间状态 —— _state 设为 _synchronizing 后再 arm polling。
     JavaThread 在 poll() 中调用 do_call_back()，检查 _state != _not_synchronized。
     _synchronizing 满足此条件 → 线程看到后开始阻塞。
   ★ _synchronized(2) 是终态 —— 所有线程到达后才设置（@L468），表示"safepoint 就绪"。
   ★ 隐藏读者：JavaThread 通过 poll() 读取 _state，通过 do_call_back() 决定是否阻塞

2. ★★★ SafepointSynchronize::begin() 源码走读 (L156-510):
   ① @L177: 获取 Threads_lock — 阻止线程创建/销毁
   ② @L187: 获取 Safepoint_lock  (MutexLocker mu) — 防并发 safepoint 请求
   ③ @L196: _waiting_to_block = nof_threads
   ④ @L253: _state = _synchronizing ← ★ 先改状态，再 arm
   ⑤ @L256: arm polling page:
        ThreadLocal: arm_local_poll(cur) for each thread
        Global: OrderAccess::fence() + os::serialize_thread_states()
        ★ os::serialize_thread_states() = mprotect 操作 — 一次全局操作
          同步所有线程的 store buffer，比 per-thread membar 高效
   ⑥ @L300: ★ 阶段 1 — SPIN 循环:
      while (still_running > 0) {
        遍历线程列表 (JavaThreadIteratorWithHandle — ThreadSMR 安全迭代):
          对每个 JavaThread:
            检查 _thread_state → 如果是 _thread_in_native 且有 jni_active → 跳过
            检查 ThreadSafepointState → 如果已到达 → still_running--
        如果超时 (SafepointTimeout) → print_safepoint_timeout
        SpinPause / thread_yield
      }
   ⑦ @L433: ★ 阶段 2 — BLOCK 循环:
      while (_waiting_to_block > 0) {
        等线程从 _thread_in_vm → _thread_blocked 完成
        线程完成转换 → _waiting_to_block--
      }
   ⑧ @L468: _state = _synchronized ← 所有线程到达，正式进入 safepoint
   ⑨ @L509: do_cleanup_tasks() — symbolTable/stringTable rehash, CLD purge...
   ★ GCLocker 检查不在 begin() 中 — 它在 GC VM_Operation::doit_prologue() 中
     (g1CollectedHeap.cpp:1175)，在 begin() 被调用之前。若 GCLocker active →
     doit_prologue() 返回 false → VMThread 跳过整个 safepoint。

3. ★★ SafepointSynchronize::end() 源码走读 (L527-600):
   assert(Threads_lock->owned_by_self()) — 仍持有 Threads_lock
   ① _state = _not_synchronized (先改状态，让还未醒的线程看到)
   ② disarm_safepoint: 恢复 polling page 为可读
   ③ Safepoint_lock->notify_all() → 唤醒所有在 safepoint_lock 上等待的线程
   ④ 释放 Threads_lock
   ⑤ 计算 safepoint pause time → _end_of_last_safepoint 记录

4. ★ block() — JavaThread 如何在 safepoint 中阻塞 (L859):
   ① 设置 _thread_state = _thread_blocked
   ② 等待 VMThread 设置 _state = _synchronized
   ③ 检查是否被 suspend → 如果是，执行 suspend 逻辑
   ④ 返回后 _thread_state 由调用者恢复

5. ★ 为什么 begin() "先改 _state，再 arm polling page"？
   do_call_back() 检查 _state != _not_synchronized (safepoint.hpp:170-172)
   _synchronizing 满足此条件 → arm 之前已在 _thread_in_vm 的线程，在 arm 后
   第一件事就是 poll() → do_call_back() → 看到 _state 已变 → 立即阻塞。
   这样不会漏掉已经在 VM 代码中的线程。如果先 arm 再改 _state，arm 和改状态
   之间存在时间窗口 — 线程在 arm 后检查 _state，发现仍是 _not_synchronized → 不阻塞 → 漏掉。
```

#### 交叉引用
- [07-VMThread] — VMThread::loop() 调用 begin/end
- [07-Thread-Architecture §五] — ThreadSMR _java_thread_list 的快照机制
- [07-Internal-Locks] — Threads_lock(20) + Safepoint_lock(19) 在 begin/end 中的获取/释放，safepoint 期间 rank 豁免
- [10-NonJavaThread] — NonJavaThread 不参与 safepoint 的原因
- [03-GCLocker] — GC VM_Operation::doit_prologue() 中的 GCLocker 检查（本文 §04）

---

### [02] Polling-Mechanism — 轮询页 + ThreadBlockInVM + transition_and_fence

> **核心叙事**：JavaThread 怎么"发现"自己被要求暂停？不是发信号——是**主动轮询**。每个 JavaThread 在关键路径上（方法返回、循环回边、JNI 返回）检查一个全局 "polling page" 是否可读。不可读 → SIGSEGV → 信号处理 → 进入 safepoint 阻塞。JDK 10+ 引入了 ThreadLocal Handshake，不需要全局 mprotect。这篇文章回答：**"暂停"到底是一个主动动作还是被动动作？为什么不同时用信号通知？**

#### 聚焦源文件

| # | 文件 | 核心函数 | 必读行号 |
|---|------|---------|---------|
| 1 | `safepointMechanism.inline.hpp` | `global_poll()`, `local_poll()`, `poll()`, `block_if_requested()` | :37-85 |
| 2 | `safepointMechanism.cpp` | `default_initialize()`, `block_if_requested_slow()` | :42-120 |
| 3 | `interfaceSupport.inline.hpp` | `ThreadBlockInVM`, `transition_and_fence()` | :136-306 |
| 4 | `os_linux.cpp` | `make_polling_page_unreadable/readable`, SIGSEGV handler | :6011-6021 |
| 5 | `handshake.hpp` | `Handshake::execute()` | :48-100 |

#### 必须深度走读的概念

```
1. ★★★ 两种轮询模式对比:
   
   ┌─ 全局 Polling Page (ThreadLocalHandshakes=false, JDK 默认) ───────┐
   │ 机制:                                                              │
   │   arm: mprotect(_polling_page, PROT_NONE)  → 页不可读              │
   │   poll: 每个 JavaThread 读 *(polling_page)  → MMU → SIGSEGV        │
   │   handler: handle_polling_page_exception() → block()               │
   │   disarm: mprotect(_polling_page, PROT_READ) → 页可读              │
   │   poll: *(polling_page) 正常返回 0 → 不阻塞                         │
   │                                                                     │
   │ 优点: 已知每个 JavaThread 的精确 safepoint 位置（SIGSEGV 的 IP）    │
   │ 缺点: mprotect 是全局操作 → TLB shootdown 开销（~1μs×CPU数）        │
   └─────────────────────────────────────────────────────────────────────┘
   
   ┌─ ThreadLocal Handshake (ThreadLocalHandshakes=true, JDK 10+) ──────┐
   │ 机制:                                                              │
   │   arm: 对于目标线程 → 设置 _handshake->operation + CAS flag        │
   │   poll: 目标线程检查自己的 flag → 如果 set → do_handshake()         │
   │   disarm: 清除 flag                                                │
   │                                                                     │
   │ 优点: 无需全局 mprotect → 单个线程握手 → 延迟更低                   │
   │ 缺点: 每个线程需要额外的 poll 检查点                                  │
   └─────────────────────────────────────────────────────────────────────┘

2. ★★★ transition_and_fence — 为什么状态转换必须有 StoreLoad fence？

   void transition_and_fence(JavaThread *thread, JavaThreadState from, JavaThreadState to) {
     thread->set_thread_state(to);    // ① 写新状态
     OrderAccess::storeload();        // ② ★ StoreLoad 屏障
   }

   ★ 隐藏读者深度分析:
   - 写者: 当前 JavaThread (写 _thread_state)
   - 隐藏读者: VMThread (在 begin() 中无锁读取所有 JavaThread 的 _thread_state)
   - 没有 fence: VMThread 可能从 store buffer 读到旧状态 _thread_in_vm
     而实际线程已经进入 _thread_blocked → VMThread 认为线程未到达 → 死等
   - 有了 fence: StoreLoad 强制 store buffer 刷新 → VMThread 看到最新状态
   
   ★ 这是 [07] 记忆规则 "隐藏读者" 的经典实例。

3. ★★ 轮询点的位置 — JavaThread 在哪里检查 polling page？

   ① 方法返回: 解释器 → SafepointMechanism::poll()
   ② 循环回边 (back branch): 编译代码中插入 safepoint_poll 节点
   ③ JNI 返回: ThreadInVMfromNative 析构 → transition_and_fence → poll()
   ④ ThreadBlockInVM ~dtor: 恢复 _thread_in_vm 前 → poll()
   ⑤ 锁阻塞: Monitor::lock() → ThreadBlockInVM → ILock → 内部可能 poll

   轮询代价: 全局 poll → 一次内存读 (20-30 CPU cycles)
            ThreadLocal poll → 一次 flag 检查 (3-5 CPU cycles)

4. ★ ThreadBlockInVM 的生命周期:
   构造: _thread_in_vm → _thread_blocked (transition_and_fence)
   析构: _thread_blocked → _thread_in_vm (transition_and_fence + poll)
   
   ★ 使用场景:
   - Mutex::lock() → 持锁阻塞 → ThreadBlockInVM → 允许 safepoint
   - wait() → 释放锁等待 → ThreadBlockInVM → 允许 safepoint
   - JNI → JVM 转换 → ThreadInVMfromJava → 进入 VM 代码
```

#### 交叉引用
- [07-Internal-Locks §四] — safepoint_check 三态与轮询的关系
- [09-JavaThread-System] — 10 个 JavaThread 的轮询行为
- [10-NonJavaThread] — NonJavaThread 不轮询的原因

---

### [03] VM-Operation-System — VM_Operation 三态调度 + 排队

> **核心叙事**：谁发起 safepoint？任何线程都可以 `VMThread::execute(op)` 投递一个 VM_Operation。不同的操作有不同的执行模式：_safepoint（需要 STW）、_no_safepoint（阻塞但不需要 STW）、_async_safepoint（异步 safepoint）。VMThread 从 VMOperationQueue 取出操作，根据 mode 决定是否调用 begin()/end()。这篇文章回答：**为什么 GC、逆优化、类重定义都走同一条 VMOperationQueue？为什么不分优先级队列？**

#### 聚焦源文件

| # | 文件 | 核心函数 | 必读行号 |
|---|------|---------|---------|
| 1 | `vmOperations.hpp` | `VM_Operation` class, `Mode` enum | :134-310 |
| 2 | `vmOperations.cpp` | `add()`, `remove_next()` | :56-120 |
| 3 | `vmThread.cpp` | `loop()`, `evaluate_operation()` | :450-530 |
| 4 | `vm_operations_g1.cpp` | `VM_G1CollectForAllocation` | G1 GC 的 VM_Operation 示例 |

#### 必须深度走读的概念

```
1. ★★★ Mode 三态:
   _safepoint (0):      阻塞 + 需要 STW。VMThread 调用 begin()→doit()→end()
                         例: VM_GC_Operation, VM_RevokeBias, VM_Deoptimize
   _no_safepoint (1):   阻塞但不需要 STW。VMThread 直接调用 doit()
                         例: VM_Exit, VM_PrintThreads（某些平台）
   _async_safepoint (2): 非阻塞 + 需要 STW。操作在后台执行
                         例: VM_ThreadDump（jstack)

2. ★ 为什么 async_safepoint 是 "非阻塞"？
   投递方调用 execute() 后不等待 doit() 完成即返回。
   适用于不需要同步等待结果的操作（如 threaddump）。

3. ★★ VMOperationQueue 的调度规则:
   - _safepoint 操作: 按到达顺序排队
   - _no_safepoint 操作: 可以插队到 _safepoint 前面
   - _async_safepoint: 类似 _safepoint，但 execute() 不等待

   为什么不给 GC 操作最高优先级？→ 单一队列 + FIFO = 简单、可预测。
   GC 操作的优先通过 "no_safepoint 操作可插队" 间接保证：非 safepoint
   操作先执行（快速），safepoint 操作后执行（但有 STW 开销）。

4. ★ 关键: VM_Operation 不是单例 — 每个操作的 C-heap 分配
   - new VM_G1CollectForAllocation() → C-heap(mtInternal)
   - VMOperationQueue::add() → 加入 _queue[priority]
   - doit() 执行后 → delete op（释放）
```

#### 交叉引用
- [07-VMThread] — VMThread::loop() 中取出操作的详细流程
- [07-02-BiasedLocking] — VM_RevokeBias 作为 safepoint 操作的典型
- [06-GC-Memory] — VM_G1CollectForAllocation 触发 Young GC（待 09-gc-memory 阶段）

---

### [04] GCLocker — JNI Critical 如何阻止/延迟 GC

> **核心叙事**：Java 通过 JNI 调用 C 代码时，如果 C 代码持有指向 Java 堆内对象的指针（GetPrimitiveArrayCritical/GetStringCritical），GC 不能移动这些对象——否则指针失效。GCLocker 通过 `_jni_lock_count` 计数器跟踪活跃的 JNI critical section。当需要 GC 时，如果 jni_lock_count > 0，**GC 的 VM_Operation::doit_prologue() 直接返回 false**——VMThread 不进入 safepoint，整个 GC 操作被跳过。这篇文章回答：**为什么 jstack 有时看到线程在 "waiting for GC" 但实际上 GC 没在跑？**

#### 聚焦源文件

| # | 文件 | 核心函数 | 必读行号 |
|---|------|---------|---------|
| 1 | `gcLocker.hpp` | `GCLocker`, `_jni_lock_count`, `_needs_gc` | :38-93 |
| 2 | `gcLocker.cpp` | `jni_lock()`, `jni_unlock()`, `check_active_before_gc()` | :123-200 |
| 3 | `g1CollectedHeap.cpp` | `VM_G1CollectForAllocation::doit_prologue()` 中的 GCLocker 检查 | :1175 |
| 4 | `vmGCOperations.cpp` | GC VM_Operation 的 GCLocker 检查 | :75 |

#### 必须深度走读的概念

```
1. ★★★ GCLocker::jni_lock() / jni_unlock() 全生命周期:
   
   进入 JNI critical (gcLocker.cpp:123-140):
     jni_lock(thread):
       ① MutexLocker mu(JNICritical_lock)         ← 先获取锁
       ② while (is_active_and_needs_gc() || _doing_gc):
            JNICritical_lock->wait()              ← 如果 GC 挂起, 在此阻塞
       ③ thread->enter_critical()                 ← 标记在 critical 中
       ④ _jni_lock_count++                        ← 递增计数
   
   退出 JNI critical (gcLocker.cpp:142-167):
     jni_unlock(thread):
       ① MutexLocker mu(JNICritical_lock)         ← 获取锁
       ② _jni_lock_count--                        ← 递减计数
       ③ thread->exit_critical()                  ← 退出标记
       ④ 如果 needs_gc() && _jni_lock_count == 0 (最后一个退出):
          _doing_gc = true
          MutexUnlocker → heap->collect(_gc_locker)  ← 执行 GC (无锁)
          _doing_gc = false; _needs_gc = false
          JNICritical_lock->notify_all()              ← 唤醒等待进入的线程

2. ★★★ GCLocker 检查在 GC VM_Operation::doit_prologue() 中，不在 begin() 中！

   源码验证:
     g1CollectedHeap.cpp:1175:
       if (GCLocker::check_active_before_gc()) {
         return false;  // ← 返回 false → VMThread 不调用 begin()！
       }
   
     vmGCOperations.cpp:75:
       if (!skip && GCLocker::is_active_and_needs_gc()) {
         _gc_locked = true;  // ← GC 被 GCLocker 阻止
       }
   
   ★ 正确流程:
     调用者线程: VMThread::execute(op) → doit_prologue() → skip_operation()
       → GCLocker::is_active_and_needs_gc() → active → return false
       → ★ 操作不入队, VMThread 不唤醒, 零 safepoint 开销
       → inactive → 入队 → VMThread 取出 → begin() → doit() → end()
     ★ doit_prologue() 只在调用者线程执行一次
     ★ VM_Operation::evaluate() 只调 doit(), 不调 doit_prologue() — vmOperations.cpp:58-77
   
   ★ 关键策略: 在 VM_Operation 层就放弃，而不是在 safepoint 内部。
     VMThread 根本不会为了被 GCLocker 阻止的 GC 而 arm polling page —
     避免了无意义的 STW 开销。

3. ★ GC locker 的统计:
   - _jni_lock_count: 当前活跃的 JNI critical section 数量
   - _needs_gc: 是否需要 GC（堆内存不足，由分配路径设置）
   - is_active_and_needs_gc() = needs_gc && jni_lock_count > 0

4. ★ 为什么不是 "等 JNI critical 结束" 而是 "放弃本次 GC"？
   — JNI critical section 持续时间不可控（外部 C 代码）
   — 如果等待 → 可能长时间 STW（所有 JavaThread 被暂停等一个 JNI 调用）
   — 放弃策略: 立即释放 → JNI critical 自然退出 → 下次再尝试 GC
   — 如果一直不结束 → 下次 GC 尝试 → 仍不结束 → 重复 → 
     分配压力持续增大 → 最终可能在 jni_lock 步骤③中触发 OOME
```

#### 交叉引用
- [01-Safepoint-Protocol] — begin() 被 GCLocker 从外部阻止调用
- [07-09-JavaThread-System] — JNI 调用的线程状态转换
- [10-NonJavaThread] — 为何 NonJavaThread 不需要 GCLocker

---

### [05] Safepoint-Full-Path — 发起→等所有线程→执行→恢复 全景串联

> **核心叙事**：把前 4 篇文章串成一条完整的 safepoint 时间线——从某线程分配失败触发 GC，到 VM_Operation 入队，到 VMThread 取出，到 arm polling page 等所有线程，到 doit() 执行 GC，到 disarm 恢复。这篇文章是 08-safepoint 的总览篇。**写作顺序最后，阅读顺序最先。**

#### 聚焦源文件
横跨 `safepoint.cpp`, `safepointMechanism.inline.hpp`, `vmOperations.cpp`, `vmThread.cpp`, `gcLocker.cpp`, `interfaceSupport.inline.hpp`, `os_linux.cpp`

#### 核心内容

```
safepoint 全链路时序:

时间 → 
应用线程: [分配失败] → VM_G1CollectForAllocation.execute() → VMOperationQueue::add() → 继续运行
                                                                              ↓
VMThread:                            ← 被唤醒 ← notify() ← [从队列取出]
                                      ↓
                                    evaluate_operation():
                                      ↓
                                    doit_prologue():
                                      ① GCLocker::check_active_before_gc()?          │
                                         true → return false → 跳过整个 safepoint    │
                                         false → 继续                                │
                                      ↓
                                    SafepointSynchronize::begin():                   │
                                      ① 获取 Threads_lock (L177) ──────────────────┐ │
                                      ② 获取 Safepoint_lock (L187)                  │ │
                                      ③ _waiting_to_block = N                       │ │
                                      ④ _state = _synchronizing (L253)              │ │
                                      ⑤ arm polling page (mprotect) + serialize      │ │
                                      ⑥ 阶段1 SPIN: while(still_running>0) ───┐     │ │
JavaThread-1: [poll → do_call_back()   → 确认到达 → still_running--          │     │ │
                → block() →            _thread_state = _thread_blocked]───┘   │     │ │
                                      ⑦ 阶段2 BLOCK: while(_waiting_to_block>0)→┘  │ │
                                      ⑧ _state = _synchronized (L468) ← 正式进入   │ │
                                      ⑨ do_cleanup_tasks()                          │ │
                                    op->doit() ─ 执行 GC / 逆优化 / 偏向撤销        │ │
                                    SafepointSynchronize::end():                     │ │
                                      ① _state = _not_synchronized                   │ │
                                      ② disarm polling page                          │ │
                                      ③ notify_all()                                │ │
                                      ④ 释放 Threads_lock ──────────────────────────┘ │
应用线程: ← 恢复运行 ← _thread_state 恢复 ← 被唤醒

★ 时间开销分解:
   begin() 总时间 = lock获取 + spin等线程 + block等线程 + cleanup
   spin等线程 ≈ max(每个线程的 poll 延迟)     ← 线程在运行中检查 polling page 的时间
   block等线程 ≈ max(线程状态转换时间)         ← _thread_in_vm → _thread_blocked
   cleanup ≈ O(N) rehash + O(M) CLD purge
   
★ GCLocker 在 doit_prologue() 中就决定了是否跳过 GC —
   不会浪费任何 safepoint 开销在"注定被放弃"的 GC 上。
```

#### 交叉引用
横跨 01-04 全部四篇，标注每个步骤的源文件:行号

---

## 三、写作顺序与阅读顺序

```
写作顺序（按依赖链）:
  01-Safepoint-Protocol ──┐
  02-Polling-Mechanism ────┤
  03-VM-Operation-System ──┼──→ 05-Safepoint-Full-Path (全串联，需前四篇)
  04-GCLocker ─────────────┘

  01-04 可以并行撰写（互相独立），05 最后写。

阅读顺序（按理解梯度）:
  05-Full-Path → 01-Protocol → 02-Polling → 03-VM-Operation → 04-GCLocker
  （先看全景 → 再深入各子系统）

预估篇幅:
  01: ~800 行  (safepoint 协议核心 + begin/end 逐行)
  02: ~700 行  (轮询页 + ThreadBlockInVM + transition_and_fence)
  03: ~500 行  (VM_Operation 体系 + Mode 三态)
  04: ~550 行  (GCLocker + JNI Critical)
  05: ~500 行  (全链路时序串联)
  总计: ~3,050 行
```

---

## 四、写作规范（沿用 07-thread-lock 标准）

| 规范 | 说明 |
|------|------|
| **标题格式** | `01-Safepoint-Protocol.md` — 编号-英文名 |
| **元信息头** | 标准环境 + 核心源文件清单 + 前置文档 + 阅读收益 |
| **源码引用** | `safepoint.cpp:156`（文件:行号） |
| **GDB 断言** | ≥10 条，每条含命令 + 预期值 |
| **交叉引用** | `[07-VMThread]`、`[07-Internal-Locks §三]` 等 |
| **核心标注** | `★★★` 核心代码，`★` 关键发现，`❓` 问题驱动 |
| **禁止行为** | 不编造函数名；先查 source_index；先读 .hpp 再读 .cpp；不做源码翻译机 |

---

## 五、GDB 验证清单

| # | 断点 | 目的 | 文档 |
|---|------|------|------|
| 1 | `SafepointSynchronize::begin` | 观察 begin() 调用栈 + _state 转换 | 01,05 |
| 2 | `SafepointSynchronize::end` | 观察 end() + pause_time | 01,05 |
| 3 | `SafepointMechanism::global_poll` | 验证 poll 的频率 + 返回值 | 02 |
| 4 | `SafepointSynchronize::block` | 观察线程如何阻塞 + _thread_state 变化 | 01,02 |
| 5 | `os::make_polling_page_unreadable` | 验证 mprotect 系统调用 | 02 |
| 6 | `transition_and_fence` | 验证 StoreLoad 屏障 + 状态转换 | 02 |
| 7 | `VMOperationQueue::add` | 观察谁投递了 VM 操作 | 03 |
| 8 | `VM_Operation::evaluate` | 观察 mode 决定是否 begin/end | 03 |
| 9 | `GCLocker::jni_lock` | 观察 JNI critical 进入 + _jni_lock_count | 04 |
| 10 | `GCLocker::jni_unlock` | 观察 JNI critical 退出 + notify | 04 |
| 11 | `GCLocker::check_active_before_gc` | 验证 GC VM_Operation::doit_prologue() 放弃 GC | 01,04 |

---

## 六、与 07-thread-lock 的衔接

```
07-thread-lock (已完结 16 篇)           08-safepoint (本文)
─────────────────────────────────────   ─────────────────────
[07-VMThread] 调用 begin/end           → 01: begin/end 内部
[07-Internal-Locks] safepoint_check    → 02: poll 里的 safepoint 检查
[07-Internal-Locks] Safepoint_lock     → 01: begin/end 中的 lock
[07-Thread-Architecture] ThreadSMR      → 交叉引用: begin() 遍历 _thread_list
[09-JavaThread-System] 系统线程         → 02: 每条线程的 poll 点
[10-NonJavaThread] 不参与 safepoint     → 01: 为什么 NonJavaThread 不阻塞
[11-AttachListener] threaddump          → 03: VM_ThreadDump 是 _async_safepoint

08-safepoint 的产出 (ThreadSMR 浅析):
  → 08-safepoint 中的 begin() 持有 Threads_lock，通过 JavaThreadIteratorWithHandle 安全迭代
  → ThreadSMR 提供 Hazard Pointer 保护的 _java_thread_list 快照，配合 Threads_lock 保证双重安全
  → 不做深度重复（[07] 已经讲透），只做交叉引用
```

---

## 七、关键 JVM 参数

| 参数 | 默认值 | 作用 |
|------|--------|------|
| `-XX:+SafepointTimeout` | false | 启用 safepoint 超时检测 |
| `-XX:SafepointTimeoutDelay` | 10000ms | 超时后打印未到达线程 |
| `-XX:+PrintSafepointStatistics` | false | 打印每次 safepoint 的统计 |
| `-XX:+PrintSafepointStatisticsCount` | 0 | 累计多少次后打印 |
| `-XX:+UnlockDiagnosticVMOptions -XX:+LogVMOutput -XX:LogFile=safepoint.log` | — | safepoint 日志 |
| `-XX:+UseCountedLoopSafepoints` | true | 计数循环中插入 safepoint |
| `-XX:GuaranteedSafepointInterval` | 1000ms | 保证最长 safepoint 间隔 |

---

## 八、关键日志

```bash
# safepoint 统计日志
java -Xms8g -Xmx8g -XX:+UseG1GC \
  -XX:+PrintSafepointStatistics \
  -XX:PrintSafepointStatisticsCount=1 \
  -jar app.jar

# 输出示例:
#          vmop  [threads: total initially_running wait_to_block]  [time: spin block sync cleanup vmop] page_trap_count
# 0.364: G1CollectForAllocation [    12      0      2    ]  [    0     0     0     0    29    ]  0
#                    ▲                                     ▲       ▲    ▲     ▲     ▲    ▲
#                 操作类型                                线程数   spin  block sync cleanup vmop
#                                                          (ms)  (ms)  (ms)  (ms)   (ms)  (ms)
```

---

## 九、下一步

08-safepoint 完结后 → 09-gc-memory（GC 子系统深度分析，G1 为主）→ safepoint 是 GC 的前置依赖（GC 需要 STW），所以 08 必须在 09 之前完成。
