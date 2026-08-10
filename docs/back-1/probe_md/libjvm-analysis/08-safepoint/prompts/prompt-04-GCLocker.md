# PROMPT: 请撰写 04-GCLocker.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**GCLocker — JNI Critical 如何阻止/延迟 GC + _jni_lock_count 原子计数 + _needs_gc 状态机 + "放弃而非等待"策略**

### 核心故事线（禁止做源码翻译机！）

[01-Safepoint-Protocol] 已经点出 GCLocker 不在 begin() 中——它在 VM_Operation 层就被检查。  
[03-VM-Operation-System] 已经详细分析了 `doit_prologue()` 门禁——GCLocker 在入队前拦截 GC。

但两篇都没有回答：**GCLocker 的 `_jni_lock_count` 是怎么递增/递减的？谁设置了 `_needs_gc`？为什么 JNI critical 的线程在 jstack 中看起来像"waiting for GC"但 GC 根本没在跑？如果一直有 JNI critical，GC 永远不会发生吗？堆会不会耗尽？**

**本文的核心叙事线**是从"JNI 代码调用 GetPrimitiveArrayCritical"到"GC 被放弃 + 下次重试 + 最终可能 OOME"的完整追踪：

1. **★ JNI Critical Section 是什么？为什么 GC 不能移动这些对象？** — Java 调用 `GetPrimitiveArrayCritical()` 返回的是**指向 Java 堆内数组的裸指针**——GC 如果移动这个数组（如 Young GC 的 copying），裸指针立刻变成野指针。因此 JNI Critical 期间 GC 被禁止。追问：**那为什么不直接用 JNI pinning（钉住对象不移动）？** Pinning 会导致堆碎片化（被钉住的对象卡在 Young 区无法晋升），GCLocker 的"放弃 GC 而非钉住对象"策略更轻量。再追问：**那如果堆真的满了呢？** `_needs_gc` 被设置后，下一次分配失败时 JVM 会连续尝试 GC —— 如果 GCLocker 一直 active，堆逐渐耗尽 → 最终触发 OOME。

2. **★☆☆ `_jni_lock_count` 的原子递增/递减协议 — 多线程并发安全**。`jni_lock()` 中 `Atomic::inc(&_jni_lock_count)` 保证原子性，`jni_unlock()` 中 `Atomic::dec(&_jni_lock_count)` 配对。追问：**为什么不用 Mutex 保护而用原子操作？** 因为 jni_lock/jni_unlock 是 JNI 调用的热路径，Mutex 开销（~50-100ns per lock/unlock pair）远大于原子 inc/dec（~5ns）。追问：**多线程同时持有 JNI Critical 时 `_jni_lock_count` 的语义？** `_jni_lock_count > 0` 表示"至少一个线程在 JNI Critical Section 中"——这是**计数型** gate（不只一个线程会进 JNI Critical，多个线程可以同时持有 `GetPrimitiveArrayCritical` 返回的裸指针）。`check_active_before_gc()` 检查 `_jni_lock_count > 0 && _needs_gc`——两条件都满足才 skip GC。追问：**`_needs_gc=true` 的 store 和 `jni_lock` 的 load 之间没有显式 fence——这是 bug 吗？** 不是。`_needs_gc` 在 safepoint 的 begin() 阶段被设置——此时 VMThread 持有 `Safepoint_lock`。JNI critical 线程在 `jni_lock` 完成后才进入 critical section。safepoint 的 `begin()` 中 `OrderAccess::fence()` 保证 `_needs_gc` 的写入对后续进入的 JNI critical 线程可见。这不是"竞态"——这是"消息传递"模式：VMThread 设置 needs_gc → fence → JNI 线程进入 critical → inc count → 检查 needs_gc。

3. **★ `_needs_gc` 状态机 — 谁设置？谁清除？** 设置者：**分配路径**——当 JavaThread 在 TLAB 中分配失败 → 尝试从堆分配 → 也失败 → 准备触发 GC → 设置 `GCLocker::set_needs_gc()` = true → 然后 `VMThread::execute(new VM_G1CollectForAllocation(...))`。清除者：**GC 执行时**——GC 完成后（或 GC 被 skip 后），如果 GCLocker 不再 active，调用 `clear_needs_gc()`。追问：**如果 GC 被 GCLocker skip 了——`_needs_gc` 会被清除吗？** 看 `check_active_before_gc()` 的源码——如果 active 且 needs_gc → 返回 true（skip GC），但 `_needs_gc` **保持 true**。引用 [01] begin() L484 的 `GCLocker::set_jni_lock_count(_current_jni_active_count)`——这个调用记录了 safepoint 时刻的 jni_lock_count，但不清除 `_needs_gc`。这意味着：**下次 GC 尝试时，即使 jni_lock_count 已降到 0，`_needs_gc` 仍为 true → GC 会继续执行**。

4. **★☆☆ `jni_lock()` 中的条件 wait — 为什么第一个进入 JNI critical 的线程会阻塞？** 这是 GCLocker 最反直觉的部分：
   ```
   // 伪代码：简化逻辑，实际实现需从 gcLocker.cpp 源码确认
   // ★ 关键问题：第一个进入者是 "wait（等 GC 完成）" 还是 "主动触发 GC"？
   jni_lock(thread):
     ① _jni_lock_count++;                     // 原子递增
     ② if (_needs_gc && _jni_lock_count == 1) // 第一个在 GC 需求激活后进入 critical
     ③    JNICritical_lock->wait();            // ★ 阻塞！等待 GC 完成
     ④    被唤醒后 _jni_lock_count++;          // GC 完成，重新递增
   ```
   **❓ 为什么是 _jni_lock_count == 1 才 wait？** 因为 GC 发生时，正在 JNI critical 中的线程持有堆内裸指针——GC 不能移动这些对象。如果 count==1 的线程（第一个在 GC 需求激活后进入的线程）不阻塞，它将持有裸指针 → GC 仍无法执行。所以它必须阻塞等待：等当前活跃 critical 全部退出 + GC 完成。**如果 count > 1**：说明已有其他线程在 critical 中——即使我们 wait 了也无法推进 GC。追问：**GC 是谁执行的？** VMThread 独立调度（通过 `VM_G1CollectForAllocation` 等 VM_Operation），不是 jni_lock 中的线程。jni_lock 的线程只**阻塞等待 GC 完成**，而非"代理执行 GC"。追问：**第一个进入者被谁唤醒？** 最后一个退出 critical 的线程在 `jni_unlock()` 中 `notify_all()`——以及 GC 完成后 VMThread 的 end()。

5. **★ `jni_unlock()` 的 notify_all — 最后一个退出的线程负责通知**：
   ```
   jni_unlock(thread):
     ① _jni_lock_count--;                     // 原子递减
     ② if (_needs_gc && _jni_lock_count == 0) // 我们是最后一个退出 critical 的线程
     ③    MutexLocker ml(JNICritical_lock);    // 获取锁
     ④    JNICritical_lock->notify_all();     // ★ 通知所有等待 GC 的线程
   ```
   **❓ 谁在 `JNICritical_lock` 上等待？** 两种场景：(A) `jni_lock()` 步骤③——第一个进入 critical 的线程（阻塞等待 GC 完成）；(B) GC 的 `doit_prologue()` 返回 false 后——VMThread 可能调用 `stall_until_clear()` 等待最后一个 JNI critical 退出（取决于 GC 策略）。

6. **★ 为什么 JNI critical 的持续时间必须"短"？JVM 如何 enforce？** JVM **不 enforce**——JNI 规范只是**建议** JNI critical 要"short"。如果 native 代码在 critical 中执行耗时操作（如 I/O），GC 被无限推迟。JVM 的策略是"放弃+重试"而非"强制打断"——因为强制打断 native 代码的唯一方式是 `pthread_kill` + signal handler，但 signal handler 中不能安全地执行 GC。追问：**那如果一直不退出呢？** 堆逐渐耗尽 → `_needs_gc` 保持 true → 每次分配失败都尝试 GC → doit_prologue 返回 false（GCLocker active）→ 调用者线程在 `JNICritical_lock` 上等待（stall_until_clear）→ 如果 JNI critical 永远不退出 → 调用者线程永久阻塞 → 后续线程也会阻塞 → 最终 OOME。

7. **★ 双层 GCLocker 检查的完整路径（衔接 [01][03]）**：

   第一层（[03] §五）— `doit_prologue()` 在入队前：
   ```
   VM_GC_Operation::doit_prologue()
     → GCLocker::check_active_before_gc() 
       → is_active_and_needs_gc() && !is_at_safepoint() → true → return false → 跳过整个 safepoint
   ```

   第二层（[01] §三）— `doit()` 内部在 begin() 之后：
   ```
   G1CollectedHeap::do_collection_pause_at_safepoint()
     → GCLocker::check_active_before_gc() → true → return false → 放弃 GC
   ```

   追问：**为什么 begin() 内部还有一个 `set_jni_lock_count()` 调用？** `begin()` L484 `GCLocker::set_jni_lock_count(_current_jni_active_count)` 把 safepoint 时刻的 jni_lock_count 快照到 GCLocker 中——用于统计和日志，不影响 GC 是否执行。

### 禁止行为

- ❌ 把 `jni_lock()` 和 `jni_unlock()` 贴出来逐行翻译——这两个函数结构清晰，不应做行级译码
- ❌ 只说"JNI Critical 期间不能 GC"而不解释为什么不是 pinning
- ❌ 把 _jni_lock_count 和 _needs_gc 当成独立字段描述——必须解释它们的状态交互
- ❌ 忽略 `jni_lock()` 中第一个进入者阻塞等待 GC 的设计——它是 GCLocker 协议的核心
- ❌ 把 GCLocker 描述为"简单的计数器"——它是一个有状态的协议
- ❌ 遗漏"放弃+重试"与"等待 JNI critical 退出"两种策略的对比
- ❌ 不讨论 memory ordering 问题——_needs_gc 和 _jni_lock_count 之间的竞态窗口
- ❌ 不画 GCLocker 的完整状态机图
- ❌ 不验证源码行号——所有行号必须用 grep 确认

### 要求行为

- ✅ **★ GCLocker 的完整状态机必须画成 Mermaid 状态图**：_jni_lock_count=0+!_needs_gc（空闲）→ _needs_gc=true（GC 请求）→ jni_lock count++（活跃 critical）→ count==0+_needs_gc（可 GC）→ GC 执行 → 空闲
- ✅ **★ `jni_lock()` 中第一个进入者阻塞等待的时序必须单独画图**：为什么 count==1 的线程必须阻塞，被谁唤醒
- ✅ **★ `_jni_lock_count` 和 `_needs_gc` 的交互表**：`_needs_gc=F + count=0` `_needs_gc=F + count>0` `_needs_gc=T + count=0` `_needs_gc=T + count>0` 四个状态的语义和行为
- ✅ **★ 和 [01][03] 的双向引用**：
  - [01] begin() L484 `set_jni_lock_count()` — 本文解释这个值的来源和用途
  - [01] doit() 内部 check_active_before_gc — 本文解释 this 如何与 jni_lock/jni_unlock 联动
  - [03] doit_prologue() 门禁 — 本文解释 GCLocker 的内部状态如何决定门禁的返回值
- ✅ **★ "放弃 GC"vs"等 JNI critical 退出"的决策树**：什么时候放弃（active && needs_gc → skip GC），什么时候等待（stall_until_clear → block until notify_all）
- ✅ **GDB 验证 ≥10 条**：重点在 _jni_lock_count 原子操作、_needs_gc 状态转换、jni_lock 中 wait/notify 的调用栈、jni_unlock 中 notify_all 的触发
- ✅ **`GetPrimitiveArrayCritical` 的 JNI 实现入口**：从 jni.cpp 到 gcLocker.cpp 的调用链——展示 JNI critical 的实际入口

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 核心函数（需验证行号） | 本文角色 |
|---|------|---------|---------------------|---------|
| 1 | `gcLocker.hpp` | `src/hotspot/share/gc/shared/gcLocker.hpp` | `GCLocker`(:38), `_jni_lock_count`(:45), `_needs_gc`(:46), `check_active_before_gc()`(:78), `stall_until_clear()`(:82) | ★★★ GCLocker 类定义 + 所有关键字段和接口 |
| 2 | `gcLocker.cpp` | `src/hotspot/share/gc/shared/gcLocker.cpp` | `jni_lock()`(:123), `jni_unlock()`(:150), `check_active_before_gc()`(:172), `stall_until_clear()`(:185) | ★★★ jni_lock/unlock 完整协议 + 门禁 + 等待 |
| 3 | `jni.cpp` | `src/hotspot/share/prims/jni.cpp` | `jni_GetPrimitiveArrayCritical()` → 如何在 JNI 入口处调用 GCLocker | ★ JNI Critical 的实际触发点 |
| 4 | `vmGCOperations.cpp` | `src/hotspot/share/gc/shared/vmGCOperations.cpp` | `VM_GC_Operation::doit_prologue()` 中的 GCLocker 门禁 | ★ 第一层 GCLocker 检查（入队前） |
| 5 | `g1CollectedHeap.cpp` | `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | `do_collection_pause_at_safepoint()` 中的 GCLocker 检查 | ★ 第二层 GCLocker 检查（begin() 后） |
| 6 | `safepoint.cpp` | `src/hotspot/share/runtime/safepoint.cpp` | `begin()` L484 `set_jni_lock_count()` — GCLocker 状态的 safepoint 快照 | ★ 交叉引用：safepoint 中的 GCLocker 交互 |
| 7 | `mutexLocker.cpp` | `src/hotspot/share/runtime/mutexLocker.cpp` | `JNICritical_lock` 的定义和 rank（`def(JNICritical_lock, ...)` 宏，行号待 grep 确认） | ★ GCLocker 使用的锁 |

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。禁止贴整段函数。

### 4.1 ★★★ `jni_lock()` / `jni_unlock()` 的完整协议 — 两个原子操作 + 一个条件等待

```
问题：
  ① jni_lock() 的完整流程是什么？（定位 gcLocker.cpp 中的行号）
     答案方向: 4 步：
       步骤1: Atomic::inc(&_jni_lock_count) — 原子递增
       步骤2: thread->set_critical_native_unlock() — 标记线程在 critical 中
       步骤3: if (_needs_gc && _jni_lock_count == 1):
         → _needs_gc = false — 清除标志（GC 已完成，需求已满足）
         → MutexLocker ml(JNICritical_lock) — 获取锁
         → 在锁内触发 GC（通过 VM_Operation）
         → 被唤醒后 _jni_lock_count++ — 重新进入 critical
       步骤4: return — 继续 JNI critical 执行
     ★ ★ 追问：`set_critical_native_unlock()` 设置了什么标记？VMThread 在 safepoint 的 SPIN 循环中如何检查这个标记？
       线索: safepoint.cpp 的 `examine_state_of_thread()` — 搜索 `in_critical()` 调用
       → VMThread 发现线程在 JNI critical 中时，不能等待它到达 safepoint，必须 roll_forward

  ② jni_unlock() 的完整流程是什么？
     答案方向: 3 步：
       步骤1: thread->clear_critical_native_unlock() — 清除标记
       步骤2: Atomic::dec(&_jni_lock_count) — 原子递减
       步骤3: if (_needs_gc && _jni_lock_count == 0):
         → JNICritical_lock->notify_all() — 通知等待 GC 的线程

  ③ ★ 关键设计：为什么是 count==1 的线程阻塞，而非任意线程？
     答案方向: count==1 意味着"我们是 GC 需求激活后第一个想进入 critical 的线程"。
     如果这个线程放行 → 它将持有裸指针 → GC 仍无法执行 → 死循环。
     所以它必须阻塞等待 GC 完成。count>1 的线程不需要 wait——因为它们进入时 critical 已经活跃，
     多一个或少一个不影响 GC 能否执行。这个设计保证：**只有在"放行就会延长 GC 等待"的边界条件下才阻塞。**

  ④ Memory ordering 问题: _jni_lock_count++ 和 _needs_gc 读之间没有显式 fence。
     问: 这有竞态风险吗？
     答案方向: 有。如果 CPU0 刚设置了 _needs_gc=true 但没有 fence，CPU1 在 jni_lock 中读 _needs_gc 时可能看到旧值 false
     → 错过 jni_lock 中的阻塞 → 线程直接进入了 critical（此时 GC 实际上需要执行）
     → 但这不是 bug：GC 仍会在 do_it_prologue 中被跳过（因为 count>0），_needs_gc 保持 true
     → 代价：一次 JNI critical 生命周期内 GC 被延迟。设计者认为这个代价可接受。
```

### 4.2 ★☆☆ `_needs_gc` 状态机 — 谁设置、谁清除、什么时候保持

```
问题：
  ① _needs_gc 在什么时候被设置为 true？
     答案方向: 在 hotSpot 的分配路径中——当 JavaThread 分配失败时：
       TLAB 分配失败 → 尝试直接在堆上分配 → 也失败
       → 判断需要 GC → GCLocker::set_needs_gc() → Atomic::store true
       → 然后 VMThread::execute(new VM_G1CollectForAllocation(...))
     ★ 设置 _needs_gc 和执行 GC 的线程不是同一个——设置者是分配失败的 JavaThread，
       GC 执行者是 VMThread（或 jni_lock 中的第一个进入者线程）

  ② _needs_gc 在什么时候被清除/保持？
     答案方向: 三种情况：
       (A) GC 成功执行后：_needs_gc = false（GC 已完成）
       (B) jni_lock() 中第一个进入者被唤醒后（GC 已完成）：_needs_gc 已被 GC 清除
       (C) [保持] check_active_before_gc() 返回 true（GC 被跳过）：_needs_gc 保持 true
     ★ 只有 GC 实际执行后才清除 _needs_gc——被 skip 时保持 true，下次仍会尝试

  ③ 如果 _needs_gc 一直为 true 会怎样？
     答案方向: 每个后续的分配失败都会尝试触发 GC → doit_prologue 返回 false
     → 分配者线程在 JNICritical_lock 上等待（stall_until_clear）
     → 当最后一个 JNI critical 退出时 notify_all → 分配者被唤醒 → 尝试分配 → 可能仍然失败
     → 循环直到分配成功或 OOME

  ④ 追问: 为什么不在设置了 _needs_gc 后立即尝试 GC？
     答案方向: 因为设置 _needs_gc 的线程可能是任意 JavaThread —— 它不在适合执行 GC 的状态。
     GC 必须由 VMThread 在 safepoint 中执行，而 VMThread 需要等到下一次 loop 迭代取出 VM_Operation。
     _needs_gc 是在通知 VMThread 之前设置的——保证 VMThread 取出操作时能看到。
```

### 4.3 ★ `check_active_before_gc()` — 双层门禁的核心逻辑

```
问题：
  ① check_active_before_gc() 的源码逻辑是什么？
     线索: gcLocker.cpp
     答案方向:
       if (is_active_and_needs_gc() && !is_at_safepoint()) {
         return true;   // 跳过 GC
       }
       return false;    // 继续 GC
     ★ !is_at_safepoint() 是关键——如果已经在 safepoint 中（如 no-op safepoint），跳过检查，继续 GC

  ② is_active_and_needs_gc() 怎么判断？
     答案方向: _needs_gc && (_jni_lock_count > 0)
     两个条件都必须满足——仅当同时有"GC 需求"和"活跃 JNI critical"时才阻止

  ③ 为什么第一层和第二层都用 check_active_before_gc()？
     答案方向: 第一层（doit_prologue）：入队前检查——避免无意义的入队和 VMThread 唤醒
     第二层（doit 内部）：begin() 后重新检查——begin() 过程中 JNI critical 可能已经退出了
     → 如果第二层发现 GCLocker 已 inactive → GC 正常执行 → 节省一次"放弃+重试"
```

### 4.4 ★ 为什么是"放弃 GC"而不是"等 JNI critical 退出"？

```
问题：
  ① "等 JNI critical 退出"为什么不行？
     答案方向: JNI critical section 的持续时间完全由外部 C 代码控制——可能执行 I/O、socket、甚至 sleep。
     如果 JVM 等待所有 JNI critical 退出 → 可能需要数秒甚至更久
     → 所有 JavaThread 在 begin() 中被暂停（_thread_blocked）
     → 整个 JVM 看起来像"hang"了 → 用户误以为 JVM 崩溃

  ② "放弃 GC"的代价 vs "等待"的代价：
         放弃 GC:    堆碎片化略微增加（没有及时 GC）+ 下次分配再尝试 → O(#JNI critical 生命周期) 延迟
         等待退出:   任意时长的 STW（可能数秒）→ 不可接受的 pause time
     ★ 设计者选择了确定性的短延迟（放弃+重试）而非不确定性的长延迟（等待）

  ③ 极端情况下怎么办？— stall_until_clear() 的兜底策略
     答案方向: 如果 _needs_gc 已经被设置，且 GCLocker active 阻止了 GC，
     VMThread（取决于 GC 策略，G1 默认不 stall）可能调用 stall_until_clear()
     → 在 JNICritical_lock 上 wait → 等 jni_unlock 中 notify_all 唤醒
     → 重新尝试 GC。★ 注意：stall 不是分配失败线程的调用——是 VMThread/GC 内部机制。
```

### 4.5 ★ GetPrimitiveArrayCritical 的 JNI 入口到 GCLocker 的调用链

```
问题：
  ① JNI 级入口: jni_GetPrimitiveArrayCritical() 在哪里？（jni.cpp）
     答案方向: jni.cpp 中的 JNI 函数——获取数组的直接指针

  ② 如何走到 GCLocker？
     答案方向:
       jni_GetPrimitiveArrayCritical(env, array, isCopy)
         → typeArrayOop 或 objArrayOop 的获取
         → GCLocker::lock_critical(thread)  // ← 中间层包装
         → jni_lock(thread)  // gcLocker.cpp
     ★ ★ 追问：`GCLocker::lock_critical()` 这个中间层除了调 `jni_lock()` 还做了什么？
       → 可能包括线程状态验证、`_jni_active_count` 标记（safepoint SPIN 循环用）等

  ③ 退出路径: jni_ReleasePrimitiveArrayCritical()
     答案方向:
       → 释放数组引用
       → GCLocker::unlock_critical(thread)
         → jni_unlock(thread)  // gcLocker.cpp

  ④ JNI Critical 期间，GC 被阻止——但 Java 堆分配请求怎么处理？
     答案方向: 堆分配请求不会被阻止——只阻止 GC。
     → 如果堆有空间 → 正常分配（TLAB 或直接分配）
     → 如果堆没空间 → 尝试 GC → GCLocker 阻止 → 分配失败 → caller 重试
```

## 五、文章结构

```
§〇 源文件清单（跨 gc/shared + prims + runtime）

§一 什么是 JNI Critical Section？为什么 GC 不能动这些对象？
  ❓ GetPrimitiveArrayCritical 返回的是什么指针？为什么不是 Handle？
  ❓ 为什么不用 JNI pinning 而是用 GCLocker？
  1.1 JNI Critical 的定义和 API（Get/Release 对）
  1.2 为什么不能 GC——裸指针 vs GC 移动
  1.3 GCLocker 的设计哲学："阻止 GC 开始"而非"阻止 GC 移动特定对象"

§二 ★★★ GCLocker 状态机 — _jni_lock_count × _needs_gc 的状态空间
  ❓ 为什么是两个字段而不是三个？
  2.1 Mermaid 状态图：四个状态之间的转换
  2.2 状态交互表：每个状态的含义 + 行为
  2.3 Memory ordering 隐忧：_needs_gc store 和 jni_lock load 之间的竞态

§三 ★☆☆ jni_lock() / jni_unlock() 协议 — 完整源码走读
  ❓ 为什么第一个进入 critical 的线程要阻塞等待？
  3.1 jni_lock() 四步协议（源码关键行 + 注释）
  3.2 jni_unlock() 三步协议
  3.3 ★ 第一个进入者的阻塞逻辑：为什么 count==1 的线程必须 wait
  3.4 时序图：第一个进入者阻塞→GC 完成→被唤醒的完整时间线

§四 ★ _needs_gc 的生命周期 — 设置/清除/保持
  ❓ 为什么 GC 被 skip 后 _needs_gc 不自动清除？
  ❓ 如果 _needs_gc 一直为 true 会怎样？
  4.1 设置者：分配路径（JavaThread 分配失败）
  4.2 清除者：GC 成功执行后 _needs_gc = false
  4.3 保持：GC 被 skip 时 _needs_gc 保持 true（下次仍会尝试）
  4.4 极端路径：_needs_gc 永远 true → 最终 OOME

§五 ★ check_active_before_gc() 双层门禁
  ❓ 为什么两层用同一个函数？
  ❓ !is_at_safepoint() 守卫的语义
  5.1 is_active_and_needs_gc() 的判断逻辑
  5.2 doit_prologue 中的第一层（[03] §五 衔接）
  5.3 doit() 内部的第二层（[01] §三 衔接）

§六 ★ 放弃 GC vs 等待 JNI critical 退出
  ❓ 如果 JavaThread 分配失败 + GCLocker active → 线程怎么办？
  6.1 分配路径的重试循环
  6.2 stall_until_clear() — 分配者线程的兜底等待
  6.3 两种策略的对比表（放弃 vs 等待）
  6.4 极端场景：JNI critical 永远不退出 → OOME 路径

§七 ★ GetPrimitiveArrayCritical → GCLocker 调用链
  7.1 jni.cpp 中的 JNI 入口 → gcLocker.cpp 的调用
  7.2 JNI Critical 的配对退出：ReleasePrimitiveArrayCritical
  7.3 GCLocker 对 Java 堆分配的影响（分配不受影响，GC 受影响）

§八 GDB 验证 + 可证伪断言（≥10 条）
  断言 1-2: _jni_lock_count 原子递增/递减验证
  断言 3: _needs_gc 状态转换验证（分配失败 → set_needs_gc）
  断言 4: jni_lock 中 wait 条件触发的调用栈验证
  断言 5: jni_unlock 中 notify_all 触发验证
  断言 6: check_active_before_gc 在 doit_prologue 中的返回值验证
  断言 7: _needs_gc 在 GC skip 后保持不变
  断言 8: JNICritical_lock 的 wait/notify 验证
  断言 9: GetPrimitiveArrayCritical → jni_lock 调用链
  断言 10: 多线程 JNI critical + GC 互斥验证
```

## 六、写作要求

**最重要的一条**：以 [01][02][03] 的写作风格为参考——以"❓ 为什么..."开头，先建立设计动机，再用源码做证据。

1. **★ GCLocker 的状态机是全文灵魂**：必须画 Mermaid 状态图——_jni_lock_count 和 _needs_gc 两个变量的四种状态组合及转换条件

2. **★ jni_lock 中第一个进入者阻塞等待的设计是全文最大的亮点**：为什么 count==1 的线程必须阻塞——放行就会延长 GC 等待。必须解释阻塞的必要性和唤醒机制

3. **★ 和 [01][03] 的双向引用**：
   - [01] begin() L484 `set_jni_lock_count()` — 本文解释此值何时被采集
   - [01] doit() 内部 check_active_before_gc — 本文解释其如何与 jni_lock/jni_unlock 联动
   - [03] doit_prologue() 门禁 — GCLocker 内部逻辑是 doit_prologue 返回 false 的根本原因

4. **★ 放弃 vs 等待的决策论证**：什么时候放弃 GC（active && needs_gc → doit_prologue 返回 false），什么时候等待（stall_until_clear → VMThread 阻塞直到 critical 全部退出），什么时候 jni_lock 阻塞（count==1 && _needs_gc → 等 GC 完成）

5. **★ 四种状态交互表**：_needs_gc × _jni_lock_count 的完整状态空间

6. **交叉引用**：[01-Safepoint-Protocol], [03-VM-Operation-System], [07-09-JavaThread-System], [10-NonJavaThread]

7. **GDB 验证重点**：_jni_lock_count 原子操作、_needs_gc 转换、jni_lock/jni_unlock 的 wait/notify 机制、notify_all 触发点

## 七、输出格式

- Markdown 文件，命名为 `04-GCLocker.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/08-safepoint/`
- 元信息头（标准环境 + 源文件 + 前置 [01-Safepoint-Protocol] [03-VM-Operation-System] [07-09-JavaThread-System] [10-NonJavaThread] + 阅读收益）
