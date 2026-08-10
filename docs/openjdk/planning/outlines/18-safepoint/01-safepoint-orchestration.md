# 01. JVM 怎么让所有线程同时停住？— Safepoint 编排

> 🔴 Deep | 2 KP 中的核心同步原语
> 读者处境: GC 需要扫描所有线程的栈——不能有线程在修改对象。怎么让 200 个线程在同一个瞬间全部停下来，然后 GC 做完再一起继续？

### 1. "三态机 — 从奔跑→停下→奔跑"

场景: VM thread 发起一次 safepoint（如做 GC）——它要协调所有 Java 线程从"在跑 Java code"切换到"停在安全点等 VM thread"。

**三状态转换** (`safepoint.hpp:61-66`):
```
_not_synchronized  (0) → 所有线程正常运行
_synchronizing     (1) → 正在协调——通知线程停、等它们到达安全点
_synchronized      (2) → 全部停住——只有 VM thread 在运行
```
- 源码: `safepoint.hpp:61-66` enum SynchronizeState
- 关键设计: `_not_synchronized = 0` 是有意设置——`do_call_back()` 检查 `_state != 0` 时编译器生成最快的 test 指令(test eax,eax; jnz)。如果是 1/2→需要 cmp。0 值省一条指令
- [C++: `_state` 是 `volatile SynchronizeState`——Java 线程在 polling 路径中直接读 `_state` 而不经过 safepoint lock。这是最关键的性能优化——如果每次 polling 都要获取锁→200 线程×每秒 10 次=2000 次锁争用。volatile read 是一条 mov 指令]

**safepoint_counter 双重功能** (`safepoint.hpp:119`):
```
volatile int _safepoint_counter:
  - 偶数: 无 safepoint → jni_GetPrimitive<X>Field 快速路径
  - 奇数: 在 safepoint 中 → 走慢路径
```
- 源码: `safepoint.hpp:112-119` 注释
- 关键设计: counter 在 begin 前+1(变奇数)，end 后+1(变偶数)。JNI GetField 快速路径: `if ((safepoint_counter & 1) == 0) return *field_ptr;` ——一条 bit test 指令，不进 JNI call。GC 线程修改这 counter 时 Java 线程可能同时读——但 volatile int 在 x86 上是原子读——不需要 lock prefix
- [x86: `testb $1, safepoint_counter` + `jnz slow_path` — 2 条指令，~1 cycle on L1 cache hit。如果全走 JNI slow path—需要至少 50+ cycles 的 native call overhead]

### 2. "两阶段等待——先自旋，再阻塞"

场景: VM thread 调 begin()——200 个线程中 195 个在安全点(Java/blocked/vm state)，5 个在 native code(native state)——VM thread 不能等 forever（native 可能做 IO），但也不能阻塞太早太快。

**begin() 的 spinning→blocking 两阶段** (`safepoint.cpp:240-380`):
```
Phase 1 - Spinning (自旋):
  while (_waiting_to_block > 0) {
    if (迭代次数 > _defer_thr_suspend_loop_count) → 进入 Phase 2
    SpinPause() → PAUSE 指令(~10-140 cycles 延迟)
  }

Phase 2 - Blocking (阻塞等待):
  while (_waiting_to_block > 0) {
    Safepoint_lock->wait(timer)  // Monitor::wait, 非 busy-wait
    if (timeout) → 打印 timeout 日志
  }
```
- 源码: `safepoint.cpp:240-380` `SafepointSynchronize::begin()` 主体
- 关键设计: _defer_thr_suspend_loop_count (默认 4000) 控制自旋→阻塞的转换点。(1) 少数线程很快到达安全点(Java→VM 转换只需 state write+mfence)→自旋等。(2) 剩余在 native 的线程可能需要>10ms 才回来→不值得自旋。阶段1是乐观路径，阶段2是悲观兜底
- [x86: `SpinPause()` = `rep; nop`(PAUSE 指令)——告诉 CPU "我在这自旋，别浪费预测资源"。对比裸循环——PAUSE 避免 memory order violation 导致的流水线 flush。在 Skylake+ 上 PAUSE 延迟=~140 cycles]
- [C++: Safepoint_lock 是 Monitor(Mutex::safepoint-1, "Safepoint")——Java 线程到达安全点后调 Safepoint_lock->notify() 唤醒 VM thread。底层是 pthread_cond_signal——只唤醒等待线程中的1个，不是 broadcast]

**begin() 完整流程** (`safepoint.cpp:240-380`):
```
1. _state = _synchronizing       // 全局宣布"safepoint 开始"
2. 装 arm polling page            // mprotect → 仍运行的线程马上看到
3. 翻转 safepoint_counter (++ → 奇数)
4. 收集统计: _nof_initial_running_threads
5. Phase 1: spinning — 乐观等
6. Phase 2: blocking — 每线程 condition wait
7. _state = _synchronized        // 全部停住
8. 执行 cleanup tasks             // 7项维护任务
```

### 3. "停了，现在干什么？— cleanup tasks"

场景: 所有线程停了——这宝贵的暂停窗口还可以做 7 件维护工作。

**7 项 SafepointCleanupTasks** (`safepoint.hpp:80-90`):
```
SAFEPOINT_CLEANUP_DEFLATE_MONITORS        // 清理无用的 ObjectMonitor
SAFEPOINT_CLEANUP_UPDATE_INLINE_CACHES    // 刷新过期的 IC
SAFEPOINT_CLEANUP_COMPILATION_POLICY      // 编译策略更新(热点统计)
SAFEPOINT_CLEANUP_SYMBOL_TABLE_REHASH     // Symbol 表 rehash(用扩容后)
SAFEPOINT_CLEANUP_STRING_TABLE_REHASH     // String 表 rehash
SAFEPOINT_CLEANUP_CLD_PURGE               // 清除 dead class loader data
SAFEPOINT_CLEANUP_SYSTEM_DICTIONARY_RESIZE // 类字典 resize
```
- 源码: `safepoint.cpp:500-580` `do_cleanup_tasks()`——用 `SerialSafepointCleanupTask` 串行执行
- 关键设计: 这些任务需要"没有 Java 线程在修改数据"——safepoint 恰好提供了这个保证。Rehash 不能在 concurrent 做——线程可能在查找 symbol/string 中间——table resize 会导致 dangling pointer
- [C++: CLD purge 依赖 `ClassLoaderDataGraph::purge()`——Full GC 时标记死类加载器，safepoint 时清理它们的 metadata。必须是 safepoint 因为清理过程中遍历 ClassLoaderData 链表——其他线程不能正在添加新类加载器]

### 4. "做完了——放它们走" — end()

场景: VM operation 执行完毕——撒开栓，所有线程恢复执行。

**end() 流程** (`safepoint.cpp:280-320`):
```
1. 执行 pending 的 biased lock revocation (延迟到 safepoint 做)
2. _safepoint_counter++ (→ 偶数)   // 释放 jni fast path
3. end_statistics()                 // 记录 time_to_exec_vmop
4. disarm polling page              // mprotect → 可读
5. _state = _not_synchronized       // 全局宣布"safepoint 结束"
6. Safepoint_lock->notify_all()     // 叫醒所有等待的线程
```
- 关键设计: 步骤2(counter++)在步骤5(state 复位)之前——JNI fast path 在 counter 为偶数时走——而 _state 可能是 _synchronized。不是 bug——counter=偶数意味着"可以开始正常访问"——_state 重置是线程恢复的必要条件但 JNI fast path 不需要读 _state

---

### 核心悬念

**"Safepoint 是 JVM 的集体呼吸——三态机 _not_synchronized→_synchronizing→_synchronized，两阶段 spinning→blocking 等所有线程。safepoint_counter 让 JNI 几乎零开销跳过节。"** — 但线程怎么知道自己该停了？下一篇: Polling 机制。

> → [02-polling-verifiers.md](02-polling-verifiers.md)
