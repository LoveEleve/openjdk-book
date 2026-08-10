# prompt-00: Handshake & ThreadSMR — 线程握手协议与 Safe Memory Reclamation

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**场景 1 — JFR 转储时线程挂死**  
运维执行 `jcmd <pid> JFR.dump`，JFR 需要对所有 Java 线程执行 Handshake 以获取调用栈样本。如果某个线程持有 native lock 进入 `_thread_in_native` 状态且长时间不返回 JVM，HandshakeSpinYield 的自旋+睡眠策略如何保证既不阻塞 JFR 也不死等？

诊断三步：
```bash
# 1. jstack 查找阻塞在 handshake 的线程
jstack <pid> | grep -A 10 "Handshake"

# 2. strace 观察 VMThread 的系统调用
strace -e trace=futex,nanosleep -p <pid> -f 2>&1 | grep -E "FUTEX_WAIT|nanosleep"

# 3. GDB 检查 handshake state
gdb -p <pid>
(gdb) p HandshakeTimeout  # 超时设置
(gdb) p target->handshake_state()->_operation  # 是否 pending
```

如果 `_thread_in_native` 状态下线程从不 checkpoint（没有 safepoint poll / no GC），handshake 只能依赖 HandshakeSpinYield 的自适应降级等待。极端情况下 `HandshakeTimeout=0`（无超时），VMThread 永远阻塞——这是 JNI 编程的最佳实践层面的设计约束。

**场景 2 — ThreadLocalHandshakes=false 的灾难**  
老版本 JVM 不支持 ThreadLocalHandshakes（JDK 10 之前），VM_HandshakeFallbackOperation 需要把整个 JVM 停到 safepoint 才能操作一个线程。为什么 JDK 10 引入 ThreadLocalHandshakes 是革命性改进？量化对比：safepoint 全停（所有线程 GC 暂停，毫秒级，CPU 核越多越慢）vs 单线程 polling（10-100 微秒级，独立于线程数）。对 ZGC 而言，ZGC 的 concurrent marking 每 10ms 需要暂停一个线程来更新 colored pointer——如果没有 ThreadLocalHandshakes，ZGC 无法实现亚毫秒暂停。

**场景 3 — 线程退出后 Use-After-Free**  
JVM TI agent 持有 JavaThread* 指针，恰在此时 Java 线程退出。如果没有 ThreadSMR（Safe Memory Reclamation），agent 将访问已释放的内存→Segfault。ThreadsListHandle 如何在栈上保护线程指针直到 agent 返回？

诊断：
```bash
# 验证 ThreadsList 是否保护了已退出线程
gdb -p <pid>
(gdb) p ThreadsSMRSupport::_to_delete_list  # 待删除链
(gdb) p ThreadsSMRSupport::_deleted_thread_cnt  # 累计删除数
(gdb) p 'ThreadsSMRSupport::_java_thread_list'->_length  # 当前活跃线程数
```

Agent 代码模式：
```cpp
ThreadsListHandle tlh;  // Hazard ptr acquired
JavaThread* jt = ...;   // Lookup from tlh
// jt is safe here even if thread exited
jt->do_something();     // Safe: SMR prevents delete
// tlh destructor → release hazard ptr → smr_delete can now proceed
```

---

## §一 Task + Narrative + Beginner Callouts

**任务**：深度分析 runtime/ 中 Handshake（线程握手协议）和 ThreadSMR（安全内存回收）的 C++ 实现，两个紧密协作的线程安全基础设施。

**叙事线索**：JFR 需要对所有线程执行一次操作 → Handshake::execute() → ThreadLocalHandshakes 开/关两条路径 → HandshakeState 的 arm/execute/wait 三态 → ThreadSMR 保证操作期间线程不被删除。每个读者都会在源码中看到 **为什么 ThreadLocalHandshakes 是 JDK 10 最重要的 runtime 改进**——从全局 safepoint（毫秒级全停）到单线程 polling（微秒级点到点）。

**前置知识**：
- 需要理解 `JavaThread` (thread.hpp/cpp) 的基本生命周期和 `thread_state()` 转换
- 需要理解 Safepoint 概念（safepoint.hpp/cpp）——但不需要细节
- 需要理解 Semaphore (semaphore.hpp) 的 wait/signal/trywait 语义
- 需要理解 `VMThread` 通过 `VMThread::execute(vm_op)` 调度 VM_Operation 的模型

**文档产出目标**：
- 核心源码分析 ≥2000 行（对标 Phase 25 的 2114 行）
- 每个 `file:line` 引用必须经过验证（源码读取确认行号）
- Mermaid 图 ≥3 个（状态机 + 序列图 + 架构图）
- GDB 验证断言 ≥9 个

**Beginner Callouts**（7 个，文档 §一 内嵌）：

1. **什么是 Handshake？** 不是网络 TCP 握手。是 JVM 内部用来"叫醒"一个 JavaThread 并在其安全状态下执行一段代码的机制——类似"敲门→等待开门→进房间办事"。
2. **ThreadLocalHandshakes 是什么？** 一个 JVM flag（默认 true since JDK 10），控制握手走单线程 polling 路径还是全局 safepoint 路径。`-XX:+/-ThreadLocalHandshakes`。
3. **SMR = Safe Memory Reclamation**，不是 Shared Memory Region。它用 Hazard Pointer 模式保护正在被引用的对象不被释放——读者用无锁的 load_acquire 获取指针，写者在所有读者释放后执行 delete。
4. **Hazard Pointer** 的"hazard"指：读者申明"我正持有指向 X 的指针，X 是危险的（会被删）"。读者释放后 X 才变成安全的（可删除）。
5. **ThreadsListHandle = RAII 保护器**：构造时 acquire_stable_list（绑定到安全的 ThreadsList 快照），析构时 release_stable_list（允许旧列表被回收）。
6. **Semaphore 在 HandshakeState 中的作用**：不是用于互斥，而是用于"谁执行操作"的协商——VMThread 和 JavaThread 谁先拿到 semaphore 谁就执行 do_thread()。
7. **SafepointMechanism::arm/disarm_local_poll**：设置/清除 per-thread 的 polling page——线程下次 checkpoint 时会"感知"到有 handshake 在等待。这是 handshake 和 safepoint 共享的基础设施：当 SafepointMechanism::poll() 在 thread_local poll page 上读到一个 "armed" 值，线程会首先检查 handshake（process_by_self），然后才检查 safepoint。这意味着 handshake 的优先级高于 safepoint。

**Handshake 和 ThreadSMR 的关系**

这两个子系统不是孤立的——它们紧密协作。一个 JFR stack trace collection (Handshake) 必须保证在遍历线程列表时（ThreadSMR），被遍历的线程不会被删除。关键交集点：

1. **VM_HandshakeOneThread::doit()** (handshake.cpp:226-268) — 在 set_handshake 之前，先通过 `ThreadsListHandle tlh` (handshake.cpp:230) 获取稳定的线程列表快照。如果目标线程已退出，`tlh.includes(_target)` 返回 false，直接返回 "(thread dead)"。
2. **VM_HandshakeAllThreads::doit()** (handshake.cpp:274-336) — 使用 `JavaThreadIteratorWithHandle jtiwh` (handshake.cpp:280)，其内部的 ThreadsListHandle 保护整个迭代期间的线程列表不被修改。
3. **process_self_inner()** (handshake.cpp:428-445) — 线程自己执行 handshake 时**不需要** SMR 保护——因为线程在执行自己的 handshake，不会同时退出（线程不能在自己还在运行时删除自己）。

**设计对称性**：
- Handshake 解决"如何让目标线程执行一段代码"（执行者问题）
- ThreadSMR 解决"如何安全地找到目标线程"（可见性问题）
- 两者共同保证"在 N 个线程上安全地执行操作"这一基本原语

---

## §二 Standard Environment

### Source Roots

```
src/hotspot/share/runtime/handshake.hpp        (:1-101)
src/hotspot/share/runtime/handshake.cpp        (:1-528)
src/hotspot/share/runtime/threadSMR.hpp        (:1-373)
src/hotspot/share/runtime/threadSMR.cpp        (:1-1181)
src/hotspot/share/runtime/threadSMR.inline.hpp (:1-96)
src/hotspot/share/runtime/thread.hpp           (:1-2342) — JavaThread::handshake_state()
src/hotspot/share/runtime/safepointMechanism.hpp (:1-94) — arm_local_poll/disarm_local_poll
src/hotspot/share/runtime/semaphore.hpp        (:1-62) — Semaphore::wait/signal/trywait
```

编译入口：
```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM
```

### 构建命令
```bash
bash configure --with-debug-level=slowdebug --with-native-debug-symbols=internal
make hotspot
```

### Binary
```
build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so
```

### Syscall 速查表

| syscall | man | Handshake 用途 | ThreadSMR 用途 |
|---------|-----|---------------|---------------|
| futex(2) | man 2 futex | Semaphore::wait 底层 | delete_lock->wait() 底层 |
| nanosleep(2) | man 2 nanosleep | HandshakeSpinYield::wait_raw | — |
| sched_yield(2) | man 2 sched_yield | — | — |
| write(2) | man 2 write | log_handshake_info → fdStream::write | — |
| gettimeofday(2) | man 2 gettimeofday | os::javaTimeNanos 可能路径 | — |

### 全局状态表

| 变量 | 位置 | 类型 | 说明 |
|------|------|------|------|
| ThreadLocalHandshakes | globals.hpp | bool flag | 握手走单线程 poll 还是 safepoint |
| HandshakeTimeout | globals.hpp | uintx flag | 握手超时（default 0 = 无限）|
| EnableThreadSMRStatistics | globals.hpp | bool flag | 启用 SMR 统计 |
| ThreadsSMRSupport::_java_thread_list | threadSMR.cpp:83 | ThreadsList* volatile | 当前活跃线程列表 |
| ThreadsSMRSupport::_to_delete_list | threadSMR.cpp:122 | ThreadsList* | 待删除列表链 |
| ThreadsSMRSupport::_delete_notify | threadSMR.cpp:63 | volatile uint | 双重检查锁定 flag |
| HandshakeThreadsOperation::_done | handshake.cpp:70 | Semaphore(0) | 初始 0，每个线程完成后 signal |

---

## §三 Source Files Table

| File | Full Path | Lines | Core Constructs | Role |
|------|-----------|:---:|----------------|------|
| handshake.hpp | `share/runtime/handshake.hpp` | 101 | HandshakeClosure, Handshake, HandshakeState | 公共 API + 状态定义 |
| handshake.cpp | `share/runtime/handshake.cpp` | 528 | HandshakeOperation, HandshakeThreadsOperation, HandshakeSpinYield, VM_Handshake, VM_HandshakeOneThread, VM_HandshakeAllThreads, VM_HandshakeFallbackOperation | 核心实现 |
| threadSMR.hpp | `share/runtime/threadSMR.hpp` | 373 | ThreadsSMRSupport, ThreadsList, SafeThreadsListPtr, ThreadsListHandle, JavaThreadIterator, JavaThreadIteratorWithHandle | SMR 公共 API |
| threadSMR.cpp | `share/runtime/threadSMR.cpp` | 1181 | ThreadScanHashtable, smr_delete, add_thread, remove_thread, acquire_stable_list, release_stable_list, scan_hashtable | SMR 内部实现 |
| threadSMR.inline.hpp | `share/runtime/threadSMR.inline.hpp` | 96 | 内联快速路径 | inline 方法实现 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 Handshake 三步协议（arm → execute → wait）

① thread self-execution: process_self_inner() (handshake.cpp:428-445) 中 ThreadInVMForHandshake RAII → Semaphore::trywait → load_acquire → do_handshake → signal 的完整状态机是什么？为什么 ThreadInVMForHandshake 在 trywait 之前就转换了线程状态（`_thread_in_vm`）？答：因为线程必须处于安全状态才能被 VMThread 观察到并代执行——如果线程仍在 `_thread_in_Java`，VMThread 的 `possibly_vmthread_can_process_handshake` 返回 false，导致自旋浪费。转换到 `_thread_in_vm` 后 VMThread 可以安全地介入。

② clear_handshake() (handshake.cpp:423-426) 中 disarm_local_poll_release 的时机——为什么在 "disarm before execute the operation"？Ans: 如果先 execute 再 disarm，HandshakeClosure::do_thread 可能触发新的 handshake（嵌套 handshake），polling 需要保持 arm 状态让嵌套 handshake 也能被感知。

③ **Counterfactual**：如果不用 Semaphore 协商，改为"总是线程自己执行"——会失去 VMThread 代执行能力（线程在 _thread_blocked 状态时 VMThread 可以安全地替它执行，避免阻塞 handshake 发起者直到线程被 unpark）。

④ VMThread execution: try_process_by_vmThread() (handshake.cpp:492-527) 的 _no_operation/_not_safe/_state_busy/_success 四种 ProcessResult 的转换条件和含义？_not_safe → _state_busy → _success 的三态路径反映"线程必须变安全→抢执行权→确认安全→执行"的保守策略。

⑤ possibly_vmthread_can_process_handshake() (handshake.cpp:457-479) 的允许假阳性的设计：`_thread_in_native` 需额外检查 `has_last_Java_frame()` + `walkable()`——为什么？native code 可能持有一个正在被 GC 移动的 oop，栈不可 walkable 意味着不安全。

### 4.2 HandshakeSpinYield 自适应自旋策略

① HandshakeSpinYield (handshake.cpp:79-158) 如何通过 state_changed() 跟踪握手进度？2×N 数组的双缓冲结果计数器 (`_result_count[2][_number_states]`) 设计：当前 vs 上一轮。为什么用双缓冲而非直接比较单个计数器？因为需要采样窗口效应——如果只追踪"已完成数"，无法区分"正在执行中"vs"全部卡死"。

② _spin_time_ns 的计算：`5us * (active_processor_count - 1)`，max 100us——为什么要根据 CPU 数量动态计算？UP 机器上 `_spin_time_ns = 0` 意味着什么？答：UP 机器上自旋就是浪费 CPU（目标线程需要同一个 CPU 来执行 handshake），直接进入 sleep。多核机器上，自旋时间与剩余可用核数成正比——核越多，目标线程越可能在其他核上执行。

③ wait_raw() 的降级策略：10ns nanosleep (< 1ms) → naked_short_sleep(1) (≥ 1ms)。为什么不在全过程用 nanosleep？因为 nanosleep 的 syscall 开销 (~500ns) 在短等待时会反超自旋的开销——但长时间等待时 syscall 比 CPU 空转更省电。

④ wait_blocked() (handshake.cpp:101-104) 为什么用 ThreadBlockInVM 而非直接 wait_raw？因为 VMThread 本身不应该进入 blocked 状态——但 Handshake 发起者可能是 JavaThread，它需要告诉 VM "我是 blocked 的，可以在 safepoint 时忽略我"。ThreadBlockInVM 将这个 JavaThread 标记为 _thread_blocked，使 safepoint 协议不等待它。

⑤ **Counterfactual**：如果只用纯自旋 busyloop？多核场景 CPU 100% 浪费 + 内核调度器可能抢占 spin thread。如果只用 sleep？延迟从 us 级增加到 ms 级（naked_short_sleep 的最小粒度为 1ms），handshake 完成时间从 ~10us 增加到 ~1ms/per thread。

### 4.3 ThreadLocalHandshakes 的两条执行路径

① ThreadLocalHandshakes=true 时，VM_HandshakeAllThreads::doit() (handshake.cpp:274-336) 的流程：JavaThreadIteratorWithHandle 遍历 → set_handshake + arm poll → os::serialize_thread_states() (UseMembar=false 平台需要显式内存屏障) → 自旋 until all complete → 每轮遍历 safe threads 由 VMThread 代执行 (handshake_try_process_by_vmThread)。
② 为什么需要 `os::serialize_thread_states()` (handshake.cpp:292-294)？在某些弱内存模型平台（ARMv7, PPC），arm_local_poll_release 的 release store 不保证被目标线程的 polling load 看到——需要额外的 IPI (Inter-Processor Interrupt) 或内存屏障。
③ ThreadLocalHandshakes=false 时，VM_HandshakeFallbackOperation::doit() (handshake.cpp:352-363) 的回退——直接遍历所有线程执行 do_thread()。这里不需要 arm poll / handshake state / spin yield——因为执行时已经在 safepoint（所有线程已经暂停），所以直接调用 do_thread 是安全的。
④ **Counterfactual**：如果 JDK 10 不引入 ThreadLocalHandshakes，ZGC（依赖 per-thread handshake 进行 load barrier 自愈）和 Shenandoah（依赖 handshake for evacuation）如何实现？它们只能回退到 VM_HandshakeFallbackOperation，每次 GC 都需要全局 safepoint——ZGC 的 <1ms 暂停目标将永远无法达成。ThreadLocalHandshakes 是 ZGC 存在的前提条件。

### 4.4 ThreadsList 的 RCU 语义

① ThreadsList (threadSMR.hpp:158-196)：_length fixed on creation + _threads[] const pointer array（JavaThread * const * const）——两层 const，保证一旦 ThreadsList 被创建并发布后，其内容永不改变。这是 lock-free read 的基础：读者读到列表后无需任何同步就能遍历。
② add_thread() vs remove_thread()：为什么每次增删都分配新 ThreadsList 而不是原地修改？因为 ThreadsList 通过 Atomic::xchg 全局切换——正在遍历旧列表的读者不受影响。原地修改需要读锁（counter-productive for lock-free），或者锁住整个遍历（违背 SMR 目的）。
③ xchg_java_thread_list() (threadSMR.cpp:167-169) 的 Atomic::xchg 如何实现 write-side RCU？旧列表何时被回收？旧列表挂在 _to_delete_list 链上，等待 scan_hashtable 确认无 hazard ptr 引用后通过 free_list() 批量回收。
④ ThreadsList 内存布局：`sizeof(ThreadsList) = 32 + 8 * N` (32B header + 8B * N entries on LP64)。_nested_handle_cnt 的 sign bit 用途是什么？(在线程退出时用于标记)
⑤ **Counterfactual**：原地修改（vector push_back/erase）——需要全局读锁保护遍历，与 lock-free read 矛盾。如果用 read-copy-update 但原地修改 old list？RCU 要求 write-side 创建新副本——这正是 ThreadsList 的做法。

### 4.5 SafeThreadsListPtr — hazard pointer vs ref-count 的自动选择

① acquire_stable_list() 两个路径：fast_path (leaf) → 直接设置 `self->_threads_hazard_ptr = stable_list`（~1 CAS load_acquire）；nested_path → `inc_nested_handle_cnt()`（atomic inc）。为什么需要两个路径？JavaThreadIteratorWithHandle 嵌套使用时，外层已持有 ThreadsListHandle——如果里层也用 hazard ptr 写入同一字段，外层列表引用丢失 → 外层 hazard ptr 被覆盖 → 外层 ThreadsList 可能被提前回收。
② SafeThreadsListPtr 构造函数的 bool acquire 参数：`SafeThreadsListPtr(Thread *thread, bool acquire)`——当 acquire=true 时立即获取稳定的 list；当 acquire=false 时延迟到 set() 调用。ThreadsListSetter 使用 acquire=false 模式，允许可选地设置 hazard ptr。
③ **Counterfactual**：如果所有情况都用 hazard ptr？嵌套场景 hazard ptr 会覆盖旧的，外层列表不安全 → 外层 ThreadsList 可能在里层还持有它的引用时被删除。如果都用 ref-count？leaf 场景的 atomic inc/dec 比 hazard ptr 的 CAS 慢（~5ns vs ~1ns），但嵌套安全。双路径是最优折中。

### 4.6 smr_delete — 延迟删除的坐标协议

① smr_delete() (threadSMR.cpp) 的核心流程：将 JavaThread 放入 _to_delete_list → scan_hashtable 检查是否被任何线程的 hazard ptr 引用 → 未被引用则真正 delete → 否则等待下次 scan。为什么是"等待下次 scan"而非"等待该线程释放 hazard ptr"？因为主动通知每个线程释放太复杂——被动地周期性扫描所有 hazard ptr 更简单可靠。
② delete_lock() 的双重检查锁定：`_delete_notify` flag + Monitor::wait/notify 减少 Threads_lock 竞争。为什么不需要每次 delete 都拿 Threads_lock？大量线程同时退出时，Threads_lock 会成为瓶颈——delete_lock 是 ThreadSMR 私有的轻量级锁，专门用于删除协调。
③ smr_delete 中的 `ThreadsSMRSupport::update_deleted_thread_time_max()` 的 CAS 循环——为什么不是简单的赋值？多个线程可能同时更新 max，需要用 CAS 保证最终值是正确的最大值。
④ **Counterfactual**：如果不用 SMR 直接用全局锁保护线程删除？Threads_lock 变成每个 ThreadsListHandle 创建的瓶颈——每次查找线程都要拿锁，而查找是热路径（JNI/JVMTI 频繁使用）。

### 4.7 ThreadScanHashtable — hazard pointer 扫描引擎

① ThreadScanHashtable (threadSMR.cpp:177-200)：基于 ResourceHashtable 的 ptr_hash 使用 `golden ratio 2654435761u` 作为乘法散列——为什么不用 std::hash 或模运算？乘法散列 (multiply-shift hash) 在嵌入式 CPU 上比除法取模快 3-5×，且 golden ratio 保证良好的分布性。
② scan_hashtable 如何收集所有线程的 hazard ptr？遍历 _java_thread_list 中每个活跃 JavaThread → 读取其 `_threads_hazard_ptr` → 插入 hashtable。hazard ptr 本身指向一个 ThreadsList（非 JavaThread）——扫描完成后，hashtable 包含所有被保护的 ThreadsList。
③ 第二阶段扫描：从 hazard ptr hashtable 中提取被引用的 JavaThread → 构建第二个 hashtable。间接引用的含义：ThreadsList 保护了它包含的所有 JavaThread（只要 ThreadsList 被 hazard-protected，其 _threads[] 中的任何 JavaThread 都不能被删除）。
④ **Counterfactual**：如果不用 golden ratio hash 用简单模除？碰撞率上升 → scan performance 下降 → smr_delete 延迟增大。如果用 std::set？C++ 标准库的 allocator 不够灵活（HotSpot 有自己的 Arena/ResourceObj 分配体系）。

### 4.8 HandshakeState::claim_handshake_for_vmthread — Semaphore 竞态

① claim_handshake_for_vmthread() (handshake.cpp:481-490)：`_semaphore.trywait()` → 检查 `has_operation()` → 如果无 operation→signal 返还。为什么需要带回滚的双阶段尝试？因为线程可能在 trywait 和 has_operation 之间自行完成 handshake（process_self_inner 被其他线程触发或在 safepoint checkpoint 中 self-execute），并 signal 了 semaphore。VMThread 拿到 semaphore 后发现操作已不存在→需要 signal 返还给线程。
② 为什么 Semaphore(1) 而非 Semaphore(0)？Semaphore(1) 初始值表示"可用一次"。第一个拿到 semaphore 的执行操作，第二个被阻塞。Semaphore(0) 初始值意味着需要先 signal 才能 wait——不适用于这种"先到先得"的竞标模式。
③ **Counterfactual**：如果不用 semaphore 用 CAS flag？CAS 只能表示"有人在操作"，不能阻塞线程——Semaphore 的 wait 能阻塞目标线程防止它在 "已被 VMThread 判断为 safe" 到 "VMThread 开始执行 do_thread" 之间改变状态。这个窗口期 CAS flag 无法保护。

### 4.9 生产诊断：Handshake 超时与故障排查

① VM_Handshake::handshake_has_timed_out() (handshake.cpp:187-193) 和 handle_timeout() (handshake.cpp:195-205)：超时后 `LogStreamHandle(Warning, handshake)` 遍历未完成线程 → 打印线程状态 → fatal() 终止 JVM。
② 什么场景会导致超时？线程在 native code 中长时间不返回 JVM（无 safepoint checkpoint、无 JNI call）、JNI Critical Section 阻止线程状态转换、线程在 `_thread_in_Java` 状态下被 OS 挂起（信号处理中）。
③ 故障排查工具箱：
```bash
# GDB: 检查 handshake 状态
(gdb) p ThreadLocalHandshakes
(gdb) call ThreadsSMRSupport::print_info_on("debug")
# strace: 观察 futex 等待
strace -e trace=futex -p <pid> -f 2>&1 | grep -B 2 ETIMEDOUT
```
④ **Counterfactual**：如果超时后不 fatal 只 log warning？线程可能永久阻塞，后续 handshake 排队等待，JVM 变成僵尸——thread dump 无法获取、GC 可能也无法进行。fatal 是"宁可崩溃也不要僵尸"的设计取舍。

---

## §五 Article Structure

建议文档结构：

```
## §〇 生产场景（3 个场景 + 诊断步骤）
## §一 全景架构 — Handshake + ThreadSMR 协作模型
    Mermaid: Handshake lifecycle (arm → poll → execute → signal)
    Mermaid: ThreadSMR lifecycle (create → protect → scan → delete)
    7 个 Beginner Callout 内嵌
## §二 Source Files Table & Standard Environment
## §三 Handshake 协议深度
    3.1 HandshakeState 状态机（4 态 + ProcessResult）
    3.2 process_self_inner — 线程自己执行握手
    3.3 try_process_by_vmThread — VMThread 代执行
    3.4 HandshakeSpinYield — 自适应自旋策略
    3.5 VM_HandshakeOneThread — 单线程握手
    3.6 VM_HandshakeAllThreads — 全线程握手
    3.7 ThreadLocalHandshakes 回退路径
    3.8 Handshake::execute() 入口分析
## §四 ThreadSMR 详解
    4.1 ThreadsList — 不可变线程数组
    4.2 SafeThreadsListPtr — hazard ptr vs ref-count 双路径
    4.3 ThreadsListHandle — RAII 保护器
    4.4 smr_delete — 延迟删除坐标协议
    4.5 ThreadScanHashtable — hazard ptr 收集器
    4.6 add_thread / remove_thread 写端 RCU
## §五 端到端：JFR Dump 的全链路追踪
    5.1 JFR JfrRecorderService → Handshake::execute 入口
    5.2 handshake 发起 → 所有线程完成 → JFR 收集数据 时间线
    5.3 ThreadSMR 保证中间无 UAF
## §六 反事实对比表（Counterfactual Analysis）
    6.1 Handshake 设计空间：safepoint vs per-thread poll vs signal
    6.2 ThreadSMR 设计空间：RCU vs epoch-based reclamation vs ref-count
## §七 GDB 断点验证（≥7 assertions）
## §八 边缘场景（≥3 场景）
    - 并发 handshake（两个线程同时执行不同的 handshake）
    - 线程退出与 handshake 竞态
    - nested ThreadsListHandle 溢出
## §九 Cross-Reference
## §十 "不要写成→应该写成" 对照表
```

---

## §六 Writing Requirements（含"不要写成→应该写成"对照表 ≥8 行）

| # | 不要写成 | 应该写成 |
|---|---------|---------|
| 1 | "HandshakeState 使用 Semaphore 同步" | "Semaphore(1) 不是保护临界区而是协商'谁执行操作'——trywait 成功者获得执行权，失败者被阻塞直到操作完成" (handshake.cpp:416) |
| 2 | "ThreadLocalHandshakes 控制是否用单线程握手" | "ThreadLocalHandshakes=true → VM_HandshakeAllThreads 在 VMThread 主循环中执行，每个线程 arm poll 后继续运行；false → VM_HandshakeFallbackOperation 必须在全局 safepoint 下顺序执行 do_thread()" (handshake.cpp:389-413) |
| 3 | "ThreadsList 是线程列表" | "ThreadsList 是不可变的固定数组——每次 add_thread/remove_thread 都分配新 ThreadsList（~40B/thread），通过 Atomic::xchg 切换。旧列表延迟回收实现 lock-free read"(threadSMR.cpp:167-169) |
| 4 | "Hazard Pointer 保护线程不被删除" | "不是每个读者存一个 hazard ptr 就算完——ThreadScanHashtable 周期性扫描所有线程的 cached hazard ptr，构建引用集合 _ptrs，只有不在集合中的 ThreadsList 才能删除" (threadSMR.cpp:177-200) |
| 5 | "smr_delete 延迟删除线程对象" | "smr_delete 将 thread 放入 _to_delete_list → 等待 scan_hashtable 确认无任何 hazard ptr 引用 → delete。双重检查锁定 delete_lock() + _delete_notify 减少 Threads_lock 竞争" (threadSMR.cpp) |
| 6 | "HandshakeSpinYield 只是自旋+睡眠" | "它是自适应策略：state_changed() 跟踪 2×N 双缓冲计数器检测进度，有进度继续自旋 (_spin_time_ns = 5us × CPU数)，无进度降级到 nanosleep→sleep" (handshake.cpp:79-158) |
| 7 | "process_self_inner 线程自己执行握手" | "ThreadInVMForHandshake RAII 先将线程状态转为 _thread_in_vm → Semaphore::trywait 抢执行权 → load_acquire 读取 _operation → do_handshake → signal 释放——整个过程中 SafepointMechanism::disarm_local_poll 防止重复触发" (handshake.cpp:428-445) |
| 8 | "ThreadsListHandle 栈上构造" | "构造时 acquire_stable_list：leaf 路径写入 hazard ptr（~10ns CAS），nested 路径 inc_nested_handle_cnt（atomic inc ~5ns）。析构时 release：leaf 清空 hazard ptr，nested dec 到 0 时唤醒 smr_delete 线程" (threadSMR.cpp) |
| 10 | "add_thread 往列表加线程" | "不是追加到现有列表！add_thread 分配新 ThreadsList(N+1)，Atomic::xchg 切换旧→新。旧列表仍在 hazard ptr 保护期内——这跟 RCU 的写端 copy-on-write 完全一致" (threadSMR.cpp) |

**对照表不是"写法格式"参考，而是"思维深度"要求。每个"应该写成"都应该在文档中找到至少一处对应的段落——用 file:line + WHY 解释设计决策，而非简单的事实陈述。**

---

## §七 Output Format

- 标题：`# 00-Handshake & ThreadSMR — 线程握手协议与 Safe Memory Reclamation`
- 每个技术断言标注 `file:line`
- Mermaid 状态图：Handshake 生命周期 + ThreadSMR protect/scan/delete 循环
- Mermaid 序列图：JFR dump → Handshake::execute → HandshakeState → ThreadSMR protect
- 代码片段用 ` ```cpp ` 标注 file:line
- Callout 框用 `> **Callout N — 标题**` 块引用

---

## §八 Prohibited（≥8）

1. **禁止** 把 Handshake 描述成网络协议——这是 JVM 内部的线程间操作机制
2. **禁止** 混淆 handshake.cpp 中的 HandshakeOperation（内部实现类）和 HandshakeClosure（公共回调接口）
3. **禁止** 说 "ThreadsList 是线程安全的链表"——它是不可变数组，线程安全来自 copy-on-write RCU
4. **禁止** 把 ThreadSMR 的 hazard pointer 等同于 C++ hazard_ptr 标准提案——HotSpot 是自己实现的简化版
5. **禁止** 跳过 HandshakeSpinYield 的自适应逻辑——它不是简单的 spin+sleep，是进度驱动的降级策略
6. **禁止** 把 ThreadsSMRSupport 的统计字段 (_delete_lock_wait_cnt 等) 当作核心机制——它们是 `-XX:+EnableThreadSMRStatistics` 的可选诊断
7. **禁止** 遗漏 ThreadLocalHandshakes 回退路径——老版本 JVM 和一些不支持的平台走 VM_HandshakeFallbackOperation
8. **禁止** 把 Semaphore::trywait 等同于 Mutex::try_lock——Semaphore 的语义是"获取执行权"，不是互斥
9. **禁止** 把 scan_hashtable 说成"GC 扫描"——它是 hazard pointer 去重，不是垃圾回收
10. **禁止** 在无源码引用时做性能断言——每个性能数字必须标注出处（源码中注释的量级或 JDK bug ID）

---

## §九 Required（≥8）

1. ★ **Mermaid 状态图**：HandshakeState 的 arm → execute → signal → clear 四态 + ThreadSMR 的 create → protect → scan → delete 循环
2. ★ **process_self_inner 完整源码**：handshake.cpp:428-445 的 ThreadInVMForHandshake → Semaphore → load_acquire → do_handshake → signal 路径
3. ★ **VM_HandshakeAllThreads::doit 源码骨架**：handshake.cpp:274-336 的迭代→set_handshake→spin until all done 主循环
4. ★ **HandshakeSpinYield 自适应降级**：handshake.cpp:79-158 的 state_changed → reset_state → wait_raw/wait_blocked 决策树
5. ★ **ThreadsList 不可变设计**：threadSMR.hpp:158-196 的 _length/_threads[]/_next_list 结构 + add_thread/remove_thread 的 copy-on-write
6. ★ **SafeThreadsListPtr 双路径**：fast_path (hazard ptr) vs nested_path (ref-count) 的选择条件
7. ★ **smr_delete 延迟回收完整流程**：threadSMR.cpp 的 _to_delete_list → scan → condition_delete 三步
8. ★ **7 个 Beginner Callout** 内嵌在 §一 各小节末尾
9. ★ **"不要写成→应该写成" 对照表** ≥8 行
10. ★ **≥3 个独立的边缘场景** 讨论（并发 handshake、thread exit 竞态、nested overflow）
11. ★ **GDB 验证 ≥7 断言**

---

## §十 GDB Verification（≥7 assertions）

1. **验证 HandshakeState 初始化**：`p target->handshake_state()->_operation == NULL` — 新线程无 pending handshake
2. **验证 arm_local_poll_release**：`p *(int*)target->polling_page()` — arm 后 polling page 值改变
3. **验证 Semaphore 初始值**：`p ((HandshakeState*)...)->_semaphore._event._nsecs` 或其内部字段
4. **验证 ThreadsList 不可变性**：在两个 ThreadsListHandle 之间，`p _java_thread_list` 地址可能变化（add_thread/remove_thread 分配了新列表）
5. **验证 Hazard Pointer**：`p self->_threads_hazard_ptr` — ThreadsListHandle 构造后非 NULL
6. **验证 _to_delete_list 链**：`p ThreadsSMRSupport::_to_delete_list->_next_list` — 多线程退出后链表长度
7. **验证 HandshakeSpinYield 降级**：在 handshake.cpp:146 设断点，`p wait_target < now` — 自旋超时触发 sleep
8. **验证 smr_delete 不立即删除**：线程退出后 `p thread` 地址仍然有效（hazard ptr 保护中），直到 ThreadsListHandle 析构
9. **验证 handshake timeout**：设置 `-XX:HandshakeTimeout=1000000000`（1秒），触发超时 → fatal。`p _handshake_timeout`

---

## §十一 与 README 和同组 prompt 的连续性

**README**：本文档是 Phase 26 "运行时剩余" 的 doc-00，覆盖 handshake.cpp/hpp + threadSMR.cpp/hpp/inline（5 文件，~2,200 行）。

**与同组 prompt 的关系**：
- prompt-01 (JVM Flag System)：Handshake 的 `HandshakeTimeout` 和 `ThreadLocalHandshakes` flag 由 JVMFlag 注册。ThreadSMR 的 `EnableThreadSMRStatistics` 也是 flag。doc-00 应引用 "flag 注册在 globals.hpp" 但具体实现交给 doc-01。
- prompt-02 (VM Thread & Operations)：Handshake 通过 `VMThread::execute(&vm_handshake)` 提交 VM_Operation 到 VM Thread 主循环。doc-00 应引用 VM_Handshake::doit() 作为 VM_Operation 实例，但 VMThread 主循环分析交给 doc-02。

**旧文档关系**：
- `libjvm-analysis/07-thread-lock/` 覆盖线程生命周期（thread.cpp/hpp），HandshakeState 操作的是 thread->handshake_state()——doc-00 必须引用此依赖但不需要重复分析线程模型
- `libjvm-analysis/08-safepoint/` 覆盖 Safepoint，HandshakeSpinYield 不提 safepoint（它不需要全局 safepoint）

**上一 Phase 引用**：
- Phase 25 (JFR) doc-00 中 JfrRecorderService 通过 Handshake 获取线程调用栈——doc-00 应从 JFR dump 场景自然引出 handshake motivatio
