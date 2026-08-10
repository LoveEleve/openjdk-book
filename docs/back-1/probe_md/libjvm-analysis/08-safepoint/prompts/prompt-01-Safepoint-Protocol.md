# PROMPT: 请撰写 01-Safepoint-Protocol.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**Safepoint 协议核心 — begin/end 三态协议 + 双循环等所有线程到达 + GCLocker 外部决策**

### 核心故事线（禁止做源码翻译机！）

[07-thread-lock] 把 21+ 条线程 + 80+ 把内部锁讲完了。你看到：
- [07-VMThread] 中 `VMThread::loop()` → `evaluate_operation()` → `SafepointSynchronize::begin()` → `op->doit()` → `SafepointSynchronize::end()`
- [16-Internal-Locks] 中 safepoint 期间 rank 检查被豁免，VMThread 可以自由获取任意锁
- [10-NonJavaThread] 中 NonJavaThread 不参与 safepoint

但有个关键问题从未被正面回答：**`begin()` 里面到底发生了什么？** 那不是一句"等所有线程"就完事了。

**本文的核心叙事线**是一条从"调用 begin()"到"进入 _synchronized"的源码追溯链：

1. **★ 为什么 begin() 要先获取 Threads_lock + Safepoint_lock？** — 不是随便拿的——`Threads_lock(barrier=20)` 阻止线程创建/销毁（safepoint 期间线程列表必须稳定），`Safepoint_lock(safepoint=19)` 是 Monitor（条件变量）——VMThread 用 `wait()` 在 BLOCK 阶段阻塞等线程，end() 用 `notify_all()` 唤醒。这两把锁的 rank 顺序是 20→19（降序 ✓）。关键是：begin() 获取 Threads_lock 时 `_state` 仍为 `_not_synchronized`——这是正常的 Lock Ranking 降序获取，不需要 safepoint 豁免。

2. **★ `_state = _synchronizing` 为什么必须在 arm polling page 之前？** — `do_call_back()` 检查 `_state != _not_synchronized`。如果先 arm 再改 `_state`，arm 和改状态之间存在时间窗口——线程在 arm 后立即 poll，发现 `_state` 仍是 `_not_synchronized` → 不阻塞 → 漏掉了！先改 `_state` 再 arm 使得：已经在 `_thread_in_vm` 中的线程，arm 后第一次 poll 就触发 SIGSEGV → handler → do_call_back() → 看到 `_synchronizing` → 阻塞。追问：**那"先改 _state"会不会导致 arm 之前就有线程阻塞？** 不会——arm 之前 polling page 可读，`poll()` 读到 0 直接返回 false，不触发 SIGSEGV，do_call_back() 根本不在执行路径上。线程必须等 arm（page 变不可读）之后的下一次 poll 才会进入阻塞流程。

3. **★★ 为什么是两个等待循环（spin + block）而不是一个？** — 第一阶段 `while (still_running > 0)`：线程仍在运行，VMThread **自旋**等它到达安全点——此时线程可能还在解释器/编译代码中，尚未发现 polling page 已 arm。第二阶段 `while (_waiting_to_block > 0)`：线程已确认 safepoint 请求，正在从 `_thread_in_vm`→`_thread_blocked` 状态转换——VMThread **阻塞**等待。为什么需要两阶段？因为线程"知道有 safepoint"和"完成状态转换进入 block"是两步——第一阶段等线程发现自己需要停，第二阶段等线程真正停下来。

4. **★ `os::serialize_thread_states()` 是做什么的？为什么不每个线程发一条 membar？** — Polling Page 的 mprotect 操作（`PROT_NONE`→不可读）触发**全局 IPI（核间中断）+ TLB shootdown**。跨核的 store buffer flush 效果并非来自 TLB invalidation 本身，而是来自**系统调用边界**——`mprotect` 是系统调用，`syscall`→内核→`iret` 返回的过程天然序列化了指令流（x86 上 `iret` 是一个完整的序列化指令，排空 store buffer）。比给每个 JavaThread 单独发一条 `mfence` 高效得多：10+ 核心时，每条 membar ~50ns，100 条线程 = 5μs；一次全局 mprotect + 序列化只用 ~1μs。**关键区分**：TLB shootdown 保证了页表一致性，store buffer flush 来自内核穿越——这是两个独立的效应，不要混为一谈。

5. **★ Safepoint_lock 在 begin/end 中同时充当"互斥锁"和"条件变量"** — begin() 用 `MutexLocker mu(Safepoint_lock)` 获取互斥（同一时间只有一个 safepoint 在同步），end() 用 `Safepoint_lock->notify_all()` 唤醒所有等待的线程。这和 [01-ObjectMonitor] 的 `monitor->wait()/notify()` 同构：底层都是 `pthread_cond_wait/signal`，只是 Safepoint_lock 由 VMThread 以 MutexLocker 持有而不是手动 unlock。

6. **★ GCLocker 检查不在 begin() 中！** — 这是本文最容易被误解的点。`SafepointSynchronize::begin()` 代码中搜索不到 `GCLocker::is_active_and_needs_gc()`。GCLocker 检查在 **GC VM_Operation::doit_prologue()** 中（`vmGCOperations.cpp`）——且 `doit_prologue()` 在**调用者线程**中执行（`vmThread.cpp:699`），不是 VMThread。如果 GCLocker active → `doit_prologue()` 返回 `false` → 调用者线程直接 return → **VM_Operation 不入队、VMThread 不感知、begin() 不会被调用**。这意味着：safepoint 协议本身不需要知道 GCLocker 的存在——决定权在调用者线程的 VM_Operation prologue 层。本文只交叉引用，不深度分析 GCLocker。

7. **★ block() 为什么先设 _thread_blocked 再等 _synchronized？** — JavaThread 进入 block() 后设置 `_thread_state = _thread_blocked`（表示"我已准备好暂停"），然后获取 `Safepoint_lock`、递减 `_waiting_to_block--`（L897-898），最后 `wait()` 在 Safepoint_lock 上等 VMThread 的 `notify_all()`。注意：block() 是 BLOCK 阶段的执行者——SPIN 阶段等线程通过 `set_has_called_back(true)` "报到"（still_running--），BLOCK 阶段等线程在 block() 中完成 `_waiting_to_block--` 并被 wait() 挂起。

### 禁止行为

- ❌ 把 begin() 整段贴出来逐行翻译——这是源码翻译机
- ❌ 混淆 `_synchronizing`(1) 和 `_synchronized`(2) — 前者是中间态（L253），后者是终态（L468）
- ❌ 说"GCLocker 检查在 begin() 中" — 它不在！
- ❌ 把两阶段等待（spin + block）描述为单一循环
- ❌ 遗漏 `Threads_lock->lock()`(L177) 和 `Safepoint_lock` 的 MutexLocker(L187) — 这是理解 Lock Ranking 豁免的关键
- ❌ 遗漏 `os::serialize_thread_states()` — 这是 Polling Page 替代 per-thread membar 的核心优化
- ❌ 不解释 `_synchronizing` 为什么在 arm 之前设 — 这是防止漏掉线程的关键设计
- ❌ 不画时间线图 — 至少需要三态转换图 + begin() 内部步骤时序图
- ❌ 不验证源码行号 — 所有行号必须用 grep 确认（本文已在 README 中验证）
- ❌ 把 begin() 描述为"等所有线程到 safepoint"就完了 — 必须拆解出获取锁→改状态→arm→双循环→cleanup 的具体步骤

### 要求行为

- ✅ **★ begin() 必须拆成 9 步走读**：① 获取 Threads_lock ② 获取 Safepoint_lock ③ 设 _waiting_to_block ④ 设 _state = _synchronizing ⑤ arm polling + serialize_thread_states ⑥ 阶段1 SPIN 循环 ⑦ 阶段2 BLOCK 循环 ⑧ 设 _state = _synchronized ⑨ do_cleanup_tasks。每步标注行号 + 5 行关键源码
- ✅ **★ 三态状态机必须画成 Mermaid 图**：_not_synchronized → _synchronizing → _synchronized → 回到 _not_synchronized，每个转换标注触发条件（begin 入口 / L253 / L468 / end 入口）
- ✅ **★ 两阶段等待必须对比**: SPIN 等什么（线程运行中 poll 到）、用什么（SpinPause）、线程如何确认（still_running--）；BLOCK 等什么（线程状态转换完成）、用什么（Monitor::wait）、线程如何确认（_waiting_to_block--）
- ✅ **★ serialize_thread_states() 必须解释清楚**：为什么一次全局 mprotect 比 100 条 per-thread membar 快？TLB shootdown 的副作用——强制所有核心刷新 store buffer
- ✅ **★ 先改 _state 再 arm 的设计必须画图**：如果反过来（先 arm 再改 _state）→ 线程在 arm 后 poll → 看到 _not_synchronized → 不阻塞 → 漏掉。对比正确顺序：改 _state → arm → 线程 poll → do_call_back → 看到 _synchronizing → 阻塞
- ✅ **★ GCLocker 的精确位置必须标注**：不在 begin() 中！代码证据：g1CollectedHeap.cpp:1175 + vmGCOperations.cpp:75
- ✅ **★ block() 的"先设状态再等"与 Lock Ranking 的关系**：block() 在 hold Threads_lock 的 safepoint 中被调用 → rank 豁免 → 安全
- ✅ **★ 与 [16] Lock Ranking 的衔接**：begin() 获取 Threads_lock(20) + Safepoint_lock(19) → 降序 ✓。safepoint 中 VMThread 再获取任意锁 → 豁免。附具体的锁序列
- ✅ **end() 必须走读**：改状态 → disarm → notify_all → 释放 Threads_lock → 记录 pause_time
- ✅ **GDB 验证 ≥10 条**：重点在 begin/end 断点验证 _state 转换 + 两阶段循环 + block() 中 _thread_state

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 核心函数（已验证行号） | 本文角色 |
|---|------|---------|---------------------|---------|
| 1 | `safepoint.cpp` | `src/hotspot/share/runtime/safepoint.cpp` | `begin()`(:156), `end()`(:527), `block()`(:859), `do_cleanup_tasks()`(:771) | ★★★ begin/end 逐行走读 |
| 2 | `safepoint.hpp` | `src/hotspot/share/runtime/safepoint.hpp` | `SafepointSynchronize`(:59), `SynchronizeState`(:61-66), `ThreadSafepointState`(:228), `do_call_back()`(:170-172) | ★ 三态定义 + 回调判断 |
| 3 | `safepointMechanism.hpp` | `src/hotspot/share/runtime/safepointMechanism.hpp` | `arm/disarm`(:80-87), `polling_type`(:37) | ★ arm/disarm 接口 |
| 4 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | `make_polling_page_unreadable()`(:6011), `make_polling_page_readable()`(:6018) | ★ mprotect 系统调用实现 |
| 5 | `g1CollectedHeap.cpp` | `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | `VM_G1CollectForAllocation::doit_prologue()` 的 GCLocker 检查(:1175) | ★ GCLocker 不在 begin() 中的证据 |
| 6 | `vmGCOperations.cpp` | `src/hotspot/share/gc/shared/vmGCOperations.cpp` | GC VM_Operation 的 `is_active_and_needs_gc()` 检查(:75) | ★ GCLocker 在 doit_prologue() 中的第二个证据 |

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。禁止贴整段函数。

### 4.1 ★★★ 三态状态机 — 为什么需要中间态 `_synchronizing`？

```
问题：
  ① 为什么不直接从 _not_synchronized 跳到 _synchronized？
     线索: do_call_back() 检查 _state != _not_synchronized
     答案方向: _synchronizing 是一个"信号"——告诉所有 poll 的线程"safepoint 正在请求"，
     但还未完成。线程看到 _synchronizing 后开始准备阻塞，但 VMThread 还在等。
     这个中间态允许线程在"知道 safepoint 在进行"和"safepoint 已经就绪"之间做区分。

  ② _synchronized 和 _synchronizing 的主要区别是什么？
     _synchronizing = safepoint 正在同步中，线程可以"报到"
     _synchronized = 所有线程已到达，safepoint 正式开始

  ③ 在 SPIN 阶段 (L300: while(still_running > 0))，_state 是多少？
     → _synchronizing（不是 _synchronized！）
     
  ④ 在 BLOCK 阶段 (L433: while(_waiting_to_block > 0))，_state 是多少？
     → 仍然是 _synchronizing
     
  ⑤ _state 什么时候变成 _synchronized？
     → @L468: _state = _synchronized —— 两阶段都结束后

  ★ 追问：如果在 SPIN 阶段 poll 线程看到 _synchronizing（不是 _synchronized），
     它怎么知道该阻塞？→ do_call_back() 只检查 != _not_synchronized，不检查 == _synchronized
```

### 4.2 ★★★ SafepointSynchronize::begin() — 9 步逐行走读（L156-510）

```
★★★ 要求: begin() 拆成 9 步（不是以前文档里错误的 7 步），每步标注行号 + 3-5 行源码引证:

  步骤① @L177: 获取 Threads_lock
    → 为什么需要？— safepoint 期间线程创建/销毁必须被阻止
    → rank=barrier(20)，与 Safepoint_lock(19) 形成 20→19 降序 ✓
    → 追问: 如果先获取 Safepoint_lock(19) 再获取 Threads_lock(20) → 
      升序违反 Lock Ranking？但 safepoint 中豁免了检查

  步骤② @L187: 获取 Safepoint_lock (MutexLocker mu)
    → 为什么是 MutexLocker（RAII）而不是显式 lock/unlock？
    → Safepoint_lock 同时是 Monitor — begin() 的 BLOCK 阶段用它 wait()，end() 用它 notify_all()

  步骤③ @L196-198: 设置计数器
    → @L181: nof_threads = Threads::number_of_threads() — 当前 JavaThread 总数
    → @L196: _waiting_to_block = nof_threads
    → @L198: still_running = nof_threads — 两个计数器初始值相同

  步骤④ @L253: _state = _synchronizing ← ★ 全文最关键的一行
    → 为什么在 arm 之前设？— 防止 arm 和改状态之间的时间窗口漏掉线程
    → ★ 画对比图（必做）:
       错误: arm polling → [窗口] → 设 _state → 线程在窗口内 poll → 看到 _not_synchronized → 不阻塞 → 漏掉！
       正确: 设 _state → arm polling → 线程 poll → do_call_back → 看到 _synchronizing → 阻塞 ✓

  步骤⑤ @L256-270: arm polling page
    → ThreadLocal 模式: arm_local_poll(cur) for each thread (JDK 10+)
    → Global 模式: OrderAccess::fence() + os::serialize_thread_states()
    → ★ os::serialize_thread_states(): 为什么不用 per-thread membar？
      一次 mprotect → TLB shootdown → 天然实现跨核 store buffer flush
    → 追问: 注释说 "more efficient than executing a membar instruction on every call to native code"
      这是指 "一次全局 mprotect < 100 条 per-thread membar" 还是指 "每线程一次"？
      → 指 "每线程在退出 native 时发 membar 的开销" — 每线程、每次 JNI 返回都发 membar 是 O(n)，
      而 mprotect 只需要 O(1) 加一次性的 TLB shootdown

  步骤⑥ @L300-420: 阶段 1 — SPIN 循环
    → while (still_running > 0) {
        遍历线程列表 (JavaThreadIteratorWithHandle):
          对每个 JavaThread:
            如果在 _thread_in_native 且有 jni_active → 跳过（不需要阻塞）
            检查 ThreadSafepointState → 如果已到达 → still_running--
        如果超时 (SafepointTimeout) → print_safepoint_timeout(打印未到达线程名)
        SpinPause / thread_yield
      }
    → ★ 为什么遍历持有 Threads_lock？— 防止遍历期间线程从列表上消失
    → ★ JavaThreadIteratorWithHandle 是什么？— ThreadSMR 的安全迭代器，
      内部用 Hazard Pointer 保护 _java_thread_list 快照
    → 为什么超时后只打印而不放弃？— safepoint 必须成功，否则 JVM 无法继续

  步骤⑦ @L433-460: 阶段 2 — BLOCK 循环
    → while (_waiting_to_block > 0) {
        等线程完成状态转换 (_thread_in_vm → _thread_blocked)
        线程完成转换 → _waiting_to_block--
        Safepoint_lock->wait() — 不消耗 CPU
      }
    → ★ 为什么阶段1 用 SPIN 但阶段 2 用 Monitor::wait？
      SPIN: 线程正在运行中，很快就会 poll → 几十 μs 内完成 → 不值得做上下文切换
      BLOCK: 线程已经知道 safepoint，但状态转换可能因持锁等而慢 → 毫秒级 → Monitor::wait 释放 CPU

  步骤⑧ @L468: _state = _synchronized ← 正式进入 safepoint
    → OrderAccess::fence() — 确保所有 CPU 看到新状态
    → @L484: GCLocker::set_jni_lock_count() — 记录当前 JNI active 计数
    → log_info(safepoint)("Entering safepoint region")

  步骤⑨ @L509: do_cleanup_tasks()
    → symbolTable rehash / stringTable rehash / CLD purge / inline cache cleanup...
    → 这些任务为什么要在 safepoint 中做？— 因为它们需要 STW 保证（遍历数据结构时不发生并发修改）

  ★ GCLocker 检查不在 begin() 中 — 它在 GC VM_Operation::doit_prologue() 中
    (g1CollectedHeap.cpp:1175, vmGCOperations.cpp:75)。
    doit_prologue() 返回 false → VMThread 跳过整个 safepoint，不会调用 begin()。
```

### 4.3 ★★ SafepointSynchronize::end() — 5 步逐行走读（L527-600）

```
  ① assert(Threads_lock->owned_by_self()) — 还持有 Threads_lock
  ② _state = _not_synchronized — 先改状态
  ③ disarm_safepoint: 恢复 polling page 为可读
     ThreadLocal: disarm_local_poll(cur)
     Global: mprotect(_polling_page, PROT_READ)
  ④ Safepoint_lock->notify_all() — 唤醒所有在 block() 中等 _synchronized 的线程
  ⑤ 释放 Threads_lock
  ⑥ 计算 pause_time → _end_of_last_safepoint
  
  追问: 为什么是先改 _state 再 disarm？
  → 改状态不影响（disarm 前 JavaThread 还在阻塞中），没有时间窗口问题
  → disarm 后 JavaThread poll 返回 0 → 但 _state 已经 _not_synchronized → 不阻塞 ✓
```

### 4.4 ★ SafepointSynchronize::block() — JavaThread 的阻塞协议（L859-920）

```
  ① _thread_state = _thread_blocked — 标记"我已准备好暂停"
  ② 检查 is_terminated() → 如果线程正在退出 → 特殊处理
  ③ while (_state != _synchronized) {
        Safepoint_lock->wait() — 等 VMThread 通知
     }
  ④ 被唤醒后 → _thread_state 由调用者恢复
  
  ★ 追问: block() 中 Safepoint_lock->wait() 怎么才能被唤醒？
  → end() 中 Safepoint_lock->notify_all()
  
  ★ 追问: block() 和 ThreadBlockInVM 是什么关系？
  → block() 是由 polling page SIGSEGV handler 调用的 — 线程被迫暂停
  → ThreadBlockInVM 是线程主动声明"我要阻塞" — 线程主动暂停
  → 两种路径，同一个终态: _thread_blocked
```

### 4.5 ★ 为什么 begin() 先改 _state 再 arm polling page？

```
这是 begin() 设计中最精妙的一步。必须画对比图：

【错误的顺序: 先 arm 再改 _state】
  时间 →
  VMThread:            arm polling ─────── [窗口] ─── 改 _state = _synchronizing
  JavaThread-A:                        poll → do_call_back() → _state = _not_synchronized → 不阻塞 → 漏掉了！
  后果: JavaThread-A 在 arm 后立即 poll，看到 _state 还是 _not_synchronized → 认为不需要 safari → 继续运行 → safepoint 永远等不到它 → 死等/超时

【正确的顺序: 先改 _state 再 arm】
  时间 →
  VMThread:            改 _state = _synchronizing ─── arm polling
  JavaThread-A:                                   poll → do_call_back() → _state = _synchronizing → 阻塞 ✓
  JavaThread-B:                            已在 _thread_in_vm 中 → 接下来第一件事就是 poll → 看到 _synchronizing → 阻塞 ✓

  ★ 关键: arm 之前已在 _thread_in_vm 的线程，在 arm 后的 poll 中必然发现 _state 已变——因为没有 "arm 了但 _state 没变" 的时间窗口。
```

## 五、文章结构

```
§〇 源文件清单（跨 runtime/os/gc）

§一 为什么需要 safepoint？— 从 [07] VMThread 的全景到 begin() 的深度
  ❓ VMThread::loop() 调用 begin()，里面发生了什么？
  ❓ safepoint 期间为什么 VMThread 可以安全持有任意锁？
  1.1 safepoint 与 [07-thread-lock] 的关系全景
  1.2 begin() 前的上下文：Threads_lock + Safepoint_lock 的获取

§二 ★★★ 三态状态机 — _not_synchronized → _synchronizing → _synchronized
  ❓ 为什么需要中间态 _synchronizing？
  ❓ 为什么 _synchronizing 在 arm 之前设置？
  2.1 SynchronizeState 枚举定义 (safepoint.hpp:61-66)
  2.2 Mermaid 三态转换图（双向，标注行号触发点）
  2.3 do_call_back() — JavaThread 如何"读到" safepoint 请求

§三 ★★★ SafepointSynchronize::begin() — 9 步逐行走读
  ❓ 为什么要两阶段等待（spin + block）而不是一个循环？
  ❓ os::serialize_thread_states() 比 per-thread membar 快多少？
  3.1 步骤①②: 获取 Threads_lock + Safepoint_lock — Lock Ranking 含义
  3.2 步骤③④: 设计数器 + _state = _synchronizing — ★ 先改状态再 arm 的设计
  3.3 步骤⑤: arm polling page — arm_local_poll vs global serialize
  3.4 步骤⑥: 阶段1 SPIN 循环 (L300-420) — still_running 递减
  3.5 步骤⑦: 阶段2 BLOCK 循环 (L433-460) — _waiting_to_block 递减
  3.6 步骤⑧: _state = _synchronized — 正式进入 safepoint
  3.7 步骤⑨: do_cleanup_tasks() — 为什么这些任务必须在 safepoint 中？
  3.8 ★ GCLocker 不在 begin() 中 — 它在 doit_prologue() 的证据

§四 ★ SafepointSynchronize::end() — 5 步逐行走读
  ❓ 为什么先改 _state 再 disarm？和 begin() 的"先改再 arm"有什么不同？
  4.1 end() 源码走读 (L527-600)

§五 SafepointSynchronize::block() — JavaThread 如何阻塞
  ❓ block() 怎么知道 safepoint 结束了？
  5.1 block() 源码走读 (L859-920)
  5.2 与 ThreadBlockInVM 的关系

§六 完整时间线: G1 Young GC 的 safepoint 全过程
  6.1 从 doit_prologue() → begin() → GC → end() 的完整序列
  6.2 标注每一步的线程状态 + _state 值 + 持有的锁

§七 GDB 验证 + 可证伪断言（≥10 条）
  断言 1-3: _state 转换验证（在 begin/end 断点中读 _state）
  断言 4-5: 双循环验证（断点 L300 + L433，读 still_running / _waiting_to_block）
  断言 6: os::serialize_thread_states() 的 strace 验证（mprotect 系统调用）
  断言 7-8: 锁获取验证（断点 L177 + L187，读 rank 值）
  断言 9: block() 中 _thread_state = _thread_blocked
  断言 10: GCLocker 检查在 doit_prologue() 不在 begin()（search begin() 代码验证）

  可证伪断言 1: slowdebug 下 _state 从 _not_synchronized → _synchronizing → _synchronized 严格按顺序
  可证伪断言 2: SPIN 阶段（L300）_state = _synchronizing（不是 _synchronized）
  可证伪断言 3: BLOCK 阶段结束后（L468 之后）_state = _synchronized
  可证伪断言 4: begin() 中无法搜索到 GCLocker::is_active_and_needs_gc
  可证伪断言 5: Threads_lock->owned_by_self() 在 begin() 全过程中为 true
  可证伪断言 6: Safepoint_lock 在 begin() 通过 MutexLocker RAII 持有
```

## 六、写作要求

**最重要的一条**：以 `[07-VMThread]` 和 `[16-Internal-Locks]` 的写作风格为参考——以"❓ 为什么..."开头，先建立设计动机，再用源码做证据。

1. **★ begin() 是全文灵魂**：必须拆成 9 步走读，每步标注行号 + 设计动机 + 3-5 行源码引证——**不贴整段函数**

2. **★ 三态状态机必须画 Mermaid 图**：标注每个转换的触发条件（begin 入口 / L253 / L468 / end 入口）

3. **★ 先改 _state 再 arm 必须画对比图**：错误顺序 vs 正确顺序，解释时间窗口问题

4. **★ 两阶段等待必须对比**：table 格式：SPIN 等谁 / 用啥 / 线程如何确认 / 为什么用自旋 vs BLOCK 等谁 / 用啥 / 线程如何确认 / 为什么用 wait

5. **★ GCLocker 的精确位置必须给出源码证据**：g1CollectedHeap.cpp:1175 + vmGCOperations.cpp:75，不能在本文中误写进 begin()

6. **交叉引用**：[07-VMThread] + [16-Internal-Locks] + [06-Thread-Architecture §五] + [10-NonJavaThread]

7. **与 [16] Lock Ranking 的衔接**：begin() 的锁获取序列 (20→19 降序 ✓ + safepoint 期间后续获取豁免)

8. **GDB 验证重点**：在 begin() 中设三处断点验证 `_state` 转换（入口 _not_synchronized → L253 后 _synchronizing → L468 后 _synchronized）

## 七、输出格式

- Markdown 文件，命名为 `01-Safepoint-Protocol.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/08-safepoint/`
- 元信息头（标准环境 + 源文件 + 前置 [07-VMThread] [16-Internal-Locks] [06-Thread-Architecture] [10-NonJavaThread] + 阅读收益）
