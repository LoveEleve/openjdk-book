# PROMPT: 请撰写 03-thread-monitoring.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

你的应用有 2000 个线程，监控系统每秒通过 JMX 调用 `ThreadMXBean.getThreadInfo(ids, 50)` 获取前 50 个线程的 50 层栈帧。某天 GC 日志显示 safepoint 时间从 50ms 飙升到 500ms，其中 `ThreadDump` VM Operation 占了 400ms。

Root cause: `jmm_GetThreadInfo` (management.cpp:1077) 在 `maxDepth > 0` 时走 `do_thread_dump()` (management.cpp:1026) 路径 → 构造 `VM_ThreadDump` VM Operation → `VMThread::execute(&op)` → 进入全局 safepoint → 在 safepoint 内遍历 2000 个线程的栈帧（每个 ~100μs）→ 2000 × 100μs = 200ms。加上 `locked_synchronizers=true` 时 `VM_ThreadDump::doit_prologue()` (vmOperations.cpp:301) 获取 `Heap_lock`（全局锁），其他需要在 safepoint 中访问 Heap_lock 的操作也被阻塞。

核心认知：`jmm_GetThreadInfo` 有 **双路径**：`maxDepth==0` 不需要 safepoint（只用 `ThreadsListHandle` 读线程统计信息），`maxDepth!=0` 需要 `VM_ThreadDump` safepoint。`jmm_DumpThreads` (management.cpp:1173) 支持 **三重锁信息提取**：stack-frame locked monitors（depth 来自栈帧深度）、JNI locked monitors（depth=-1，因为不在 Java 栈帧上）、JSR-166 synchronizers（`AbstractOwnableSynchronizer` 的 owner 检测）。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 确认 safepoint 时间异常
jcmd <pid> VM.safepoint_statistics
# 查看 "ThreadDump" 的 safepoint 次数和耗时 — 如果 >100ms/次，说明线程数多或栈深

# 2. 查看线程数
jcmd <pid> Thread.print | head -1
# 预期: "Full thread dump ... (2000 threads)"

# 3. 对比 maxDepth=0 vs maxDepth>0 的响应时间
java -jar cmdline-jmxclient.jar ... java.lang:type=Threading ThreadCount
# JVM_LEAF, ~0.1ms
java -jar cmdline-jmxclient.jar ... java.lang:type=Threading \
  'getThreadInfo([1], 0)'  # maxDepth=0, 无 safepoint, ~0.2ms
java -jar cmdline-jmxclient.jar ... java.lang:type=Threading \
  'getThreadInfo([1], 50)'  # maxDepth=50, safepoint, ~5ms+
```

**反事实**: 如果 `jmm_GetThreadInfo` 在 `maxDepth>0` 时也绕过 safepoint（用 `ThreadsListHandle` + 直接读栈帧）→ 在非 safepoint 状态访问栈帧 → 栈帧可能正在被 JIT 编译器修改（OSR 替换、去优化重写的 frame anchor）→ 栈帧遍历器读到半初始化的 bci/scope → 返回错误的 method/line number 或访问已释放的 nmethod → SIGSEGV。`VM_ThreadDump` 的 safepoint 代价（遍历 N 个线程栈帧的 ~100μs/thread）换来了栈帧遍历的安全性保证。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the **complete thread monitoring pipeline**: from `ThreadImpl.c` JNI bridge through `jmm_GetThreadInfo`/`jmm_DumpThreads` in management.cpp, down to `VM_ThreadDump` VM Operation executing in safepoint, and `ThreadService::dump_stack_traces` walking every Java thread's stack frames. This covers: the maxDepth==0 vs maxDepth!=0 dual-path dispatch, the triple lock information extraction (stack-frame locked monitors, JNI locked monitors, JSR-166 synchronizers), the `FindDeadlockedThreads` vs `FindMonitorDeadlockedThreads` DFS deadlock detection algorithm, and the `ThreadsListHandle` hazard pointer mechanism for safepoint-free thread list access.

The reader has completed **01-management-jmm-interface** (jmm_interface vtable, JVM_ENTRY/JVM_LEAF dispatch), **03-object-model** (oop, Klass, JavaCalls). This doc: **how the JVM dumps thread stacks and detects deadlocks** — from JMX call to ThreadInfo[] return.

### 文档按执行顺序逐层展开（共 8 个板块）：

| # | 板块 | 核心揭秘 | 目标行数 |
|---|------|---------|:---:|
| 1 | **ThreadImpl JNI 桥接层** | 15 个 JNI 函数 → jmm_interface 映射表 | ~200 |
| 2 | **jmm_GetThreadInfo 双路径** | maxDepth==0 (无 safepoint) vs maxDepth!=0 (VM_ThreadDump safepoint) | ~300 |
| 3 | **jmm_DumpThreads 三重锁提取** | Stack-frame monitors / JNI monitors / JSR-166 synchronizers | ~300 |
| 4 | **VM_ThreadDump::doit — safepoint 执行** | doit_prologue (Heap_lock) → doit (遍历线程) → snapshot_thread → doit_epilogue | ~300 |
| 5 | **ThreadSnapshot 数据结构** | 14 个字段 + initialize 的状态处理逻辑 | ~200 |
| 6 | **FindDeadlockedThreads vs FindMonitorDeadlockedThreads** | DFS 环检测算法 + ObjectMonitor vs AOS 的差异 | ~300 |
| 7 | **ThreadsListHandle — 无 safepoint 线程列表访问** | Hazard pointer (SMR) 机制保证并发安全 | ~200 |
| 8 | **ThreadService 后端** | dump_stack_traces / find_deadlocks_at_safepoint / ThreadDumpResult | ~200 |

### Interview Story Format Answer（必须出现在 §一 末尾）

"Thread monitoring in the JVM is a dual-path system. `jmm_GetThreadInfo` (management.cpp:1077) checks `maxDepth`: if 0, it reads thread statistics (state, contention counts, blocked time) using `ThreadsListHandle` — a hazard pointer mechanism that requires NO safepoint, costs ~100ns per thread. If maxDepth > 0, it calls `do_thread_dump()` which constructs a `VM_ThreadDump` VM Operation and dispatches through `VMThread::execute(&op)` — this enters a global safepoint, pauses all Java threads, and walks each thread's stack frames. The triple lock extraction in `jmm_DumpThreads` (management.cpp:1173) collects: (1) stack-frame locked monitors with their frame depth, (2) JNI locked monitors with depth=-1 (outside Java frames), (3) JSR-166 `AbstractOwnableSynchronizer` owners. Deadlock detection uses DFS: `find_deadlocks_at_safepoint()` (threadService.cpp:362) follows `current_pending_monitor` chains for ObjectMonitor deadlocks, and additionally follows `current_park_blocker` chains for `ReentrantLock` deadlocks when `concurrent_locks=true`. The algorithm uses `depth_first_number` tags — a cycle is detected when a visited thread's `depth_first_number >= starting_dfn`."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **maxDepth==0 vs maxDepth!=0**: When `maxDepth==0`, `jmm_GetThreadInfo` only reads thread metadata — state, blocked count, waited count, blocked time, waited time — all stored in `JavaThread` C++ fields. NO stack walking, NO safepoint. When `maxDepth!=0`, it triggers `VM_ThreadDump` — a VM Operation requiring global safepoint — and walks every requested thread's stack frames. The performance difference: ~0.1ms for maxDepth=0 vs ~5ms+ for maxDepth=50 on a typical server.

2. **ThreadsListHandle — hazard pointer**: `ThreadsListHandle` (threadSMR.hpp) uses Safe Memory Reclamation (SMR) with hazard pointers. `acquire_stable_list()` atomically marks a `ThreadsList` as "in use" via CAS on a tagged pointer — this prevents the list from being freed while being read. No global lock, no safepoint. Used in `do_thread_dump()` and `jmm_GetThreadAllocatedMemory()` for safe thread ID → JavaThread* lookups without stopping the world.

3. **JNI locked monitors depth=-1**: When `jmm_DumpThreads` extracts locked monitors, stack-frame monitors get their actual frame depth (e.g., depth=3 for a monitor locked in the 3rd frame). JNI locked monitors — those acquired via `JNI MonitorEnter` — are NOT on Java stack frames. They're tracked in `ThreadStackTrace::_jni_locked_monitors` list. Their depth is set to -1 to distinguish them from stack-frame monitors.

4. **DFS deadlock detection**: The deadlock detector uses depth-first search on the wait-for graph. Each thread has a `depth_first_number`. The algorithm follows `current_pending_monitor` (ObjectMonitor) to find the monitor's owner, then continues from that thread. For `FindDeadlockedThreads` (concurrent_locks=true), it also follows `current_park_blocker` (AbstractOwnableSynchronizer) to detect JSR-166 lock cycles. A cycle is found when a thread's `depth_first_number >= starting_dfn` — meaning we've looped back to a thread visited in the current DFS path.

5. **VM_ThreadDump::doit_prologue — Heap_lock**: When `_with_locked_synchronizers=true`, `VM_ThreadDump::doit_prologue()` (vmOperations.cpp:301) acquires `Heap_lock` — a global lock that protects the Java heap. This is necessary because `ConcurrentLocksDump::dump_at_safepoint()` iterates all `AbstractOwnableSynchronizer` objects, which are Java objects on the heap. The Heap_lock prevents concurrent GC from moving these objects during the dump.

6. **ThreadSnapshot::initialize — state downgrade**: `ThreadSnapshot::initialize()` (threadService.cpp:857-913) may downgrade a thread's state. If a thread is `BLOCKED_ON_MONITOR_ENTER` but the monitor has been deflated (removed), `ObjectSynchronizer::get_lock_owner()` returns NULL → the state is downgraded to `RUNNABLE`. Similarly for `IN_OBJECT_WAIT` without a valid monitor. This prevents JMX clients from seeing stale blocking information.

7. **DeadlockCycle linked list**: Each detected deadlock cycle is stored as a `DeadlockCycle` object containing a `GrowableArray<JavaThread*>` of participating threads. Multiple cycles are linked via `_next` pointers. The JMX layer flattens this into a `ThreadInfo[]` array — if a thread participates in multiple cycles, it appears only once.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/java.management/share/native/libmanagement/ThreadImpl.c` — 15 JNI 函数 (:32-150)
- `src/java.management/share/native/libmanagement/HotspotThread.c` — 内部线程统计 (:31-44)
- `src/hotspot/share/services/management.cpp` — jmm_GetThreadInfo(:1077), jmm_DumpThreads(:1173), do_thread_dump(:1026), find_deadlocks(:1735), jmm_FindDeadlockedThreads(:1776), jmm_FindMonitorDeadlockedThreads(:1784), jmm_GetThreadCpuTimeWithKind(:2162), jmm_GetThreadAllocatedMemory(:2123)
- `src/hotspot/share/services/threadService.hpp` — ThreadSnapshot(:191), ThreadStackTrace(:255), DeadlockCycle(:393), ThreadDumpResult(:361), ThreadConcurrentLocks(:315)
- `src/hotspot/share/services/threadService.cpp` — find_deadlocks_at_safepoint(:362), dump_stack_traces(:306), ThreadSnapshot::initialize(:857), ThreadStackTrace::dump_stack_at_safepoint(:645)
- `src/hotspot/share/runtime/vmOperations.cpp` — VM_ThreadDump 构造(:273), doit_prologue(:301), doit(:317), snapshot_thread(:385), doit_epilogue(:310)
- `src/hotspot/share/runtime/threadSMR.cpp` — ThreadsListHandle 构造(:684), acquire_stable_list_fast_path(:392)

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so`

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **ThreadImpl.c** | `src/java.management/share/native/libmanagement/ThreadImpl.c` | 150 | 15 JNI 函数(:32-150), setThreadContentionMonitoringEnabled0(:32), getThreadInfo1(:52), findDeadlockedThreads0(:118), dumpThreads0(:143) | JNI bridge — ThreadMXBean |
| 2 | **HotspotThread.c** | `src/java.management/share/native/libmanagement/HotspotThread.c` | 44 | getInternalThreadCount(:31), getInternalThreadTimes0(:39) | JNI bridge — internal threads |
| 3 | **management.cpp** | `src/hotspot/share/services/management.cpp` | 2282 | do_thread_dump(:1026), jmm_GetThreadInfo(:1077), jmm_DumpThreads(:1173), find_deadlocks(:1735), jmm_FindDeadlockedThreads(:1776), jmm_FindMonitorDeadlockedThreads(:1784), jmm_GetThreadAllocatedMemory(:2123), jmm_GetThreadCpuTimeWithKind(:2162) | 🔥 JMM thread entry points |
| 4 | **threadService.hpp** | `src/hotspot/share/services/threadService.hpp` | ~420 | ThreadSnapshot(:191-253), ThreadStackTrace(:255-282), StackFrameInfo(:287-313), ThreadConcurrentLocks(:315-336), ConcurrentLocksDump(:338-359), ThreadDumpResult(:361-391), DeadlockCycle(:393-411) | Data structures |
| 5 | **threadService.cpp** | `src/hotspot/share/services/threadService.cpp` | 1058 | find_deadlocks_at_safepoint(:362-481), ThreadDumpResult 构造/析构(:483-509), add_thread_snapshot(:511-527), ThreadSnapshot::initialize(:857-913), ThreadStackTrace::dump_stack_at_safepoint(:645-673), dump_stack_traces(:306-345), InflatedMonitorsClosure(:604-621) | 🔥 Thread service core |
| 6 | **vmOperations.cpp** | `src/hotspot/share/runtime/vmOperations.cpp` | ~3200 | VM_ThreadDump 构造(:273-299), doit_prologue(:301-308), doit(:317-383), snapshot_thread(:385-389), doit_epilogue(:310-315), VM_FindDeadlocks::doit(:247-271) | 🔥 VM Operation — safepoint execution |
| 7 | **threadSMR.cpp** | `src/hotspot/share/runtime/threadSMR.cpp` | ~700 | ThreadsListHandle 构造(:684-689), acquire_stable_list_fast_path(:392-440) | Hazard pointer — thread list safety |

---

## §四 Deep Dive Question Groups（8 组，全部含 Counterfactual + 答案方向）

### 4.1 ★★★ jmm_GetThreadInfo 双路径分派

```
问题：
  ① maxDepth==0 路径 (management.cpp:1115-1129) 为什么不需要 safepoint？
      答案方向:
      1. dump_result.set_t_list() — 设置 hazard ptr (SMR)
      2. 遍历每个 tid: t_list->find_JavaThread_from_java_tid(tid)
      3. jt==NULL → add_thread_snapshot() (dummy — 线程已终止)
      4. jt!=NULL → add_thread_snapshot(jt) → ThreadSnapshot::initialize()
         initialize 只读: 线程状态、争用统计、blocker object/owner
         不调用 dump_stack_at_safepoint() — 不需要访问栈帧
      5. 所有读取的数据都在 JavaThread 的 C++ 字段中 — 原子读取保证一致性
      
  ② maxDepth!=0 路径 (line 1130-1139) 为什么需要 safepoint？
      答案方向:
      1. ThreadsListHandle 做 tid→threadObj handle 转换 (C++ JavaThread 可能在此期间终止)
      2. 构造 VM_ThreadDump op (with_locked_monitors=false, with_locked_synchronizers=false)
      3. VMThread::execute(&op) → 进入 safepoint
      4. doit(): 遍历线程 → dump_stack_at_safepoint(maxDepth) → 走 vframe 链
         读取每个 java_frame 的 method/bci/line_number → 构造 StackFrameInfo
      
  ③ Counterfactual: 如果 maxDepth>0 时也绕过 safepoint？
      答案方向: 在非 safepoint 状态访问栈帧 → 栈帧可能正在被 JIT 修改
      (OSR 替换、去优化) → 读到半初始化的 frame → SIGSEGV 或返回垃圾数据。
      另一种方案: 每个线程自旋 dump 自己的栈 (像 async-profiler 的 signal-based 方案)
      → 但需要 signal handler 中访问 VM 数据结构 → 复杂且不可移植。
```

### 4.2 ★★★ jmm_DumpThreads 三重锁信息提取

```
问题：
  ① management.cpp:1224-1291 的三重锁提取逻辑是什么？
      答案方向:
      1. Stack-frame locked monitors (:1250-1263):
         遍历每个 StackFrameInfo → 读取 _locked_monitors (GrowableArray<oop>)
         → 记录 monitor oop + 锁定的栈深度 (depth from frame)
         → 存入 monitors_array + depths_array
      
      2. JNI locked monitors (:1265-1273):
         从 stacktrace->jni_locked_monitors() 读取
         JNI MonitorEnter 锁定的 monitor — 不在 Java 栈帧上
         → depth = -1 (表示 "不在 Java 栈帧上")
         → 追加到 monitors_array + depths_array
      
      3. JSR-166 synchronizers (:1277-1291):
         从 ts->get_concurrent_locks() → ThreadConcurrentLocks::owned_locks()
         → java.util.concurrent 锁 (ReentrantLock, ReentrantReadWriteLock 等)
         → 存入 synchronizers_array
         → 需要 _with_locked_synchronizers=true (doit_prologue 获取 Heap_lock)
      
  ② Counterfactual: 如果 JNI locked monitors 不设 depth=-1？
      答案方向: 如果设 depth=0 (栈顶) → JMX 客户端认为锁是在第 0 帧获取的
      → 但实际是 JNI 代码中获取的 → 误导开发者在错误的代码位置排查死锁。
      depth=-1 是 JMX 规范中的约定 — 表示 "不在 Java 栈帧上"。
```

### 4.3 ★★★ VM_ThreadDump::doit — safepoint 中的执行

```
问题：
  ① VM_ThreadDump::doit (vmOperations.cpp:317-383) 的完整执行流程？
      答案方向:
      1. ResourceMark rm — 资源标记
      2. _result->set_t_list() — 设置 hazard ptr
      3. if _with_locked_synchronizers → ConcurrentLocksDump::dump_at_safepoint()
         遍历所有 AbstractOwnableSynchronizer → 建立 owner 映射
      4. 分支:
         A. _num_threads==0 (所有线程):
            遍历 t_list 每个 JavaThread:
              - 跳过 is_exiting() / is_hidden_from_external_view()
              - 如果 _with_locked_synchronizers → 查找 concurrent_locks
              - snapshot_thread(jt, tcl)
         B. _num_threads>0 (指定线程):
            遍历 _threads 数组:
              - th()==NULL → dummy snapshot
              - java_lang_Thread::thread(th()) → JavaThread*
              - 验证 jt 在 t_list 中
              - 跳过 NULL/terminated/hidden
              - snapshot_thread(jt, tcl)
      
  ② snapshot_thread (line 385-389) 做什么？
      答案方向:
      1. _result->add_thread_snapshot(java_thread) → 创建 ThreadSnapshot → initialize()
      2. snapshot->dump_stack_at_safepoint(_max_depth, _with_locked_monitors)
         → 创建 ThreadStackTrace → dump_stack_at_safepoint()
         → 遍历 vframe 链 → 每个 java_frame 创建 StackFrameInfo
         → 如果 _with_locked_monitors: InflatedMonitorsClosure 找 JNI 锁
      3. snapshot->set_concurrent_locks(tcl)
      
  ③ Counterfactual: 如果 doit_prologue 不获取 Heap_lock (with_locked_synchronizers 时)？
      答案方向: ConcurrentLocksDump::dump_at_safepoint() 遍历 Java 堆上的
      AbstractOwnableSynchronizer 对象 → 如果 GC 并发移动这些对象
      → 读到的 owner 指针可能指向已移动的对象 → 返回错误的 owner 信息
      → 死锁检测误判。Heap_lock 在 safepoint 内获取 → 保证 GC 不会并发执行。
```

### 4.4 ★★★ FindDeadlockedThreads vs FindMonitorDeadlockedThreads

```
问题：
  ① 两种死锁检测的算法差异是什么？
      答案方向:
      FindMonitorDeadlockedThreads:
        find_deadlocks(true) → concurrent_locks=false
        → 只追踪 current_pending_monitor (ObjectMonitor 等待链)
        → 检测 synchronized 死锁
      
      FindDeadlockedThreads:
        find_deadlocks(false) → concurrent_locks=true
        → 追踪 current_pending_monitor + current_park_blocker
        → 检测 synchronized + JSR-166 (ReentrantLock) 死锁
      
      算法 (find_deadlocks_at_safepoint, threadService.cpp:362-481):
        1. 初始化所有线程 depth_first_number = -1
        2. 外层循环: JavaThreadIterator 遍历
        3. 内层循环: 沿等待链追踪
           - current_pending_monitor → monitor owner → 下一个线程
           - if concurrent_locks: current_park_blocker → AOS owner → 下一个线程
        4. 死锁判定:
           - 找不到 owner → 永久阻塞 (行414) → 记录为死锁
           - depth_first_number >= 0 && >= thisDfn → 发现环 (行455-469)
           - currentThread == previousThread → 自环 (忽略)
      
  ② Counterfactual: 如果 FindDeadlockedThreads 使用 Warshall 算法（全图闭包）？
      答案方向: Warshall 算法 O(N³) vs DFS O(N+E) → 2000 线程时 Warshall 需要
      8×10⁹ 操作 → 几秒钟 → 在 safepoint 内执行会导致 STW 时间灾难。
      DFS 只在有等待关系的线程上遍历 — 大部分线程不参与等待链 → 实际复杂度 ~O(N)。
```

### 4.5 ★★★ ThreadSnapshot 数据结构

```
问题：
  ① ThreadSnapshot (threadService.hpp:191-253) 的 14 个字段各代表什么？
      答案方向:
      - JavaThread* _thread: 保护的 JavaThread 指针
      - oop _threadObj: Java 层 Thread 对象
      - ThreadStatus _thread_status: NEW/RUNNABLE/BLOCKED/WAITING/TIMED_WAITING/TERMINATED
      - bool _is_ext_suspended: JVMTI 外部挂起标志
      - bool _is_in_native: 是否在 native 代码中
      - jlong _contended_enter_ticks/count: 锁争用统计
      - jlong _monitor_wait_ticks/count: Object.wait 统计
      - jlong _sleep_ticks/count: Thread.sleep 统计
      - oop _blocker_object: 阻塞对象
      - oop _blocker_object_owner: 阻塞对象持有者的 Thread 对象
      - ThreadStackTrace* _stack_trace: 栈追踪 (maxDepth>0 时填充)
      - ThreadConcurrentLocks* _concurrent_locks: JSR-166 锁
      - ThreadSnapshot* _next: 链表指针
      
  ② initialize() (threadService.cpp:857-913) 中的状态降级逻辑？
      答案方向:
      BLOCKED_ON_MONITOR_ENTER / IN_OBJECT_WAIT / IN_OBJECT_WAIT_TIMED:
        → ObjectSynchronizer::get_lock_owner() 获取 monitor 持有者
        → monitor 不存在或 owner 不可用 → 状态降级为 RUNNABLE
        → 防止 JMX 客户端看到 stale 的阻塞信息
      PARKED / PARKED_TIMED:
        → 读取 current_park_blocker() → 如果是 AOS 子类 → 读取 owner
      
  ③ Counterfactual: 如果 initialize 不做状态降级？
      答案方向: 线程在等待 monitor → GC 发生 → monitor deflation → monitor 被释放
      → 线程醒来 → 但 ThreadSnapshot 仍报告 BLOCKED_ON_MONITOR_ENTER
      → JMX 客户端看到错误的状态 → 误判死锁或性能问题。
```

### 4.6 ★★★ ThreadsListHandle — 无 safepoint 线程列表访问

```
问题：
  ① ThreadsListHandle 如何在不使用 safepoint 的情况下安全访问线程列表？
      答案方向:
      使用 Safe Memory Reclamation (SMR) 的 hazard pointer 机制:
        acquire_stable_list_fast_path (threadSMR.cpp:392-440):
          1. 读当前 ThreadsList 指针
          2. CAS 设置 tagged hazard ptr (标记 "我正在使用这个列表")
          3. 验证列表指针未变 (如果变了 → 慢路径 retry)
          4. 返回稳定的列表引用
      
      保护机制: 当 ThreadsList 需要被释放时，SMR 等待所有 hazard ptr 释放 —
      不是通过锁或 safepoint，而是通过引用计数 + 延迟释放。
      
  ② Counterfactual: 如果 ThreadsListHandle 需要 safepoint？
      答案方向: jmm_GetThreadAllocatedMemory 在分配路径上被调用 → 每次分配
      都进入 safepoint → 吞吐量崩溃。ThreadsListHandle 的 hazard pointer
      使线程列表访问的开销降到 ~10ns (一次 CAS + 一次 load) vs safepoint 的 ~100μs。
```

### 4.7 ★★★ jmm_GetThreadCpuTimeWithKind — CPU 时间查询

```
问题：
  ① jmm_GetThreadCpuTimeWithKind (management.cpp:2162-2184) 的实现？
      答案方向:
      1. os::is_thread_cpu_time_supported() — 平台支持检查
      2. thread_id == 0 → os::current_thread_cpu_time(user_sys_cpu_time)
         → 获取当前线程的 CPU 时间 (不查线程列表)
      3. thread_id > 0 → ThreadsListHandle tlh → 
         tlh.list()->find_JavaThread_from_java_tid(tid)
         → os::thread_cpu_time(thread, user_sys_cpu_time)
      4. 失败返回 -1
      
  ② Counterfactual: 如果所有 CPU 时间查询都用 current_thread_cpu_time？
      答案方向: 无法查询其他线程的 CPU 时间 → 监控系统只能看当前线程
      → 无法发现某个线程的 CPU 异常 → 失去对线程级 CPU 使用的可见性。
      ThreadsListHandle 提供了查询其他线程的轻量方式 — 不需要 safepoint。
```

### 4.8 ★★★ jmm_GetThreadAllocatedMemory — 线程分配内存

```
问题：
  ① jmm_GetThreadAllocatedMemory (management.cpp:2123-2155) 如何查询线程分配量？
      答案方向:
      1. 验证 ids 和 sizeArray 参数
      2. ThreadsListHandle tlh — 不需要 safepoint
      3. 遍历每个 tid: tlh.list()->find_JavaThread_from_java_tid(tid)
         → thread->cooked_allocated_bytes() — TLAB 分配统计
      4. 写入 sizeArray[j]
      
  ② Counterfactual: 如果 TLAB 统计需要全局锁？
      答案方向: cooked_allocated_bytes 是 per-thread 统计 — 不需要锁。
      TLAB 本身是线程局部的 — 每个线程独立分配，只在 TLAB refill 时
      才访问全局分配器。线程分配内存统计只是累加 per-thread 计数器 → 原子操作即可。
```

---

## §五 Article Structure

```
§〇 生产场景 — safepoint 时间异常 (ThreadDump 占 400ms)
  ★ 真实现象: 2000 线程，每秒 ThreadInfo 查询 → safepoint 时间 50ms→500ms
  ★ Root cause: jmm_GetThreadInfo maxDepth>0 → VM_ThreadDump safepoint
  ★ 三步诊断: jcmd VM.safepoint_statistics → Thread.print → 对比 maxDepth=0 vs >0
  ★ 反事实: 无 safepoint → 栈帧半初始化 → crash

§一 ★★★ Thread Monitoring 全链路源码走读
  ❓ 这不是线程教程 — 这是 JVM 如何 dump 线程栈和检测死锁
  1.1 ThreadImpl.c 15 JNI 函数映射表
  1.2 jmm_GetThreadInfo 双路径分派 (maxDepth==0 vs !=0)
  1.3 jmm_DumpThreads 三重锁提取 (monitors + JNI monitors + synchronizers)
  1.4 VM_ThreadDump::doit — safepoint 中遍历线程栈帧
  1.5 ThreadSnapshot 14 字段 + initialize 状态降级
  1.6 FindDeadlockedThreads vs FindMonitorDeadlockedThreads DFS 算法
  1.7 ThreadsListHandle — hazard pointer 无 safepoint 线程列表访问
  1.8 ★ Mermaid: JMX → jmm_GetThreadInfo → do_thread_dump → VM_ThreadDump → safepoint → ThreadService
  1.9 ★ 面试 Story Format 答案

§二 ★★★ 7 Beginner Callout 框
  2.1 maxDepth==0 vs maxDepth!=0
  2.2 ThreadsListHandle — hazard pointer
  2.3 JNI locked monitors depth=-1
  2.4 DFS deadlock detection
  2.5 VM_ThreadDump::doit_prologue — Heap_lock
  2.6 ThreadSnapshot::initialize — state downgrade
  2.7 DeadlockCycle linked list

§三 ★★ jmm_DumpThreads 三重锁提取完整源码
  ❓ Stack-frame monitors → JNI monitors → JSR-166 synchronizers 的提取顺序和数据结构

§四 ★★ DFS 死锁检测算法
  ❓ 伪代码 + 源码: 初始化 → 外层循环 → 内层追踪 → 环判定 → 输出

§五 ★★ ThreadSnapshot 状态机
  ❓ 6 种线程状态 → initialize 的状态转换逻辑

§六 ★ GDB 断点验证
  断言 1: jmm_GetThreadInfo maxDepth dispatch → verify maxDepth value
  断言 2: VM_ThreadDump::doit → verify thread count
  断言 3: find_deadlocks_at_safepoint → verify DFS traversal
  断言 4: ThreadsListHandle construction → verify hazard ptr

§七 ★ Cross-Reference
  ❓ 01-management-jmm-interface — jmm_GetThreadInfo 的 JMM 入口
  ❓ 02-memory-pool-threshold — ServiceThread 完整事件循环
  ❓ 09-native-interface — JVM_ENTRY 宏机制
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because stack walking requires consistent frame data, jmm_GetThreadInfo uses a safepoint when maxDepth>0..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant code from management.cpp / threadService.cpp / vmOperations.cpp, do not describe it.

3. **Mermaid** — JMX call → jmm_GetThreadInfo → maxDepth dispatch → do_thread_dump → VM_ThreadDump → VMThread::execute → safepoint → doit → snapshot_thread → ThreadSnapshot → return ThreadInfo[].

4. **7 Beginner callout boxes** — exact text from §一.

5. **Cross-reference at four points**:
   - At `jmm_GetThreadInfo` → "→ 01-management-jmm-interface for JMM entry point"
   - At `ServiceThread` → "→ 02-memory-pool-threshold for ServiceThread event loop"
   - At `JVM_ENTRY` → "→ 09-native-interface for JVM_ENTRY macro details"
   - At `JavaCalls::call_virtual` → "→ 03-object-model for JavaCalls mechanism"

6. **Story-format interview answer** — at §一末尾.

7. **DFS deadlock detection pseudocode** — show the algorithm in pseudocode with line references to threadService.cpp

---

## §七 Output Format

- Markdown file, named `03-thread-monitoring.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/17-jmx-management/`
- 元信息头:

```
> **阶段**：[17-jmx-management]
> **前置**：[01-management-jmm-interface]（jmm_interface vtable）、[03-object-model]（JavaCalls）
> **配套**：[00-what-is-jmx]（JMX 概念）、[02-memory-pool-threshold]（ServiceThread）、[04-os-flag-diagnostic]（Flag/DCmd）
> **阅读收益**：追踪线程 dump 从 JMX 调用到 safepoint 执行的完整路径——理解 jmm_GetThreadInfo 的 maxDepth==0 vs !=0 双路径、jmm_DumpThreads 的三重锁信息提取、VM_ThreadDump::doit 的 safepoint 执行步骤、FindDeadlockedThreads vs FindMonitorDeadlockedThreads 的 DFS 环检测算法、ThreadsListHandle 的 hazard pointer 无锁线程列表访问；掌握 "ThreadDump 导致 safepoint 时间飙升" 的诊断和优化路径。
```

- 目标行数: 450+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "jmm_GetThreadInfo 有两种模式" 而不展示 maxDepth==0 vs !=0 的源码分叉 — 必须贴出 management.cpp:1115-1139 的双路径代码
- ❌ 不解释 JNI locked monitors 为什么 depth=-1 — 必须对比 stack-frame monitors (depth=实际帧深度) vs JNI monitors (不在栈帧上)
- ❌ 忽略 ThreadsListHandle 的 hazard pointer 机制 — 必须展示 acquire_stable_list_fast_path 的 CAS 逻辑
- ❌ 不说 FindDeadlockedThreads 和 FindMonitorDeadlockedThreads 的算法差异 — 必须展示 concurrent_locks=true vs false 的等待链差异
- ❌ 忽略 VM_ThreadDump::doit_prologue 的 Heap_lock — 必须展示 _with_locked_synchronizers=true 时的锁获取
- ❌ 不展示 ThreadSnapshot::initialize 的状态降级逻辑 — 必须展示 monitor deflation 后的 RUNNABLE 降级
- ❌ 不做 DFS 死锁检测的伪代码展示 — 必须用伪代码 + 行号引用展示完整算法
- ❌ 忘记 do_thread_dump 的 tid→handle 转换和竞态条件 — 必须展示 "线程可能在转换和 safepoint 之间终止" 的注释
- ❌ 不做 GDB 断点 trace — 至少 4 个断点覆盖 dispatch → safepoint → doit → snapshot
- ❌ 跳过 jmm_GetThreadCpuTimeWithKind 和 jmm_GetThreadAllocatedMemory — 必须展示这两个函数的 ThreadsListHandle 用法

---

## §九 Required（≥8）

- ✅ **★ Mermaid 线程 dump 序列图** — JMX → jmm_GetThreadInfo → maxDepth dispatch → do_thread_dump → VM_ThreadDump → safepoint → ThreadService
- ✅ **★ jmm_GetThreadInfo 双路径源码** — maxDepth==0 vs !=0 的完整分叉代码
- ✅ **★ jmm_DumpThreads 三重锁提取源码** — Stack-frame monitors + JNI monitors + synchronizers
- ✅ **★ DFS 死锁检测算法伪代码 + 源码** — find_deadlocks_at_safepoint 的完整逻辑
- ✅ **★ ThreadSnapshot 14 字段表格** — 每个字段的类型、含义、填充时机
- ✅ **★ ThreadsListHandle hazard pointer 源码** — acquire_stable_list_fast_path
- ✅ **★ 7 Beginner Callout 框** — exact text from §一
- ✅ **★ 面试 Story Format 答案** — §一末尾
- ✅ **★ GDB 断点 ≥4 条** — 精确到 file:line
- ✅ **★ 交叉引用** — 01 (JMM entry), 02 (ServiceThread), 09 (JVM_ENTRY), 03-object-model (JavaCalls)

---

## §十 GDB Verification（≥4 assertions）

```
断言 1: jmm_GetThreadInfo maxDepth dispatch (management.cpp:1077)
  (gdb) break management.cpp:1077
  运行: JMX getThreadInfo(ids, 0) → 验证 maxDepth=0 路径
  (gdb) print maxDepth → 期望: 0
  (gdb) continue → 进入 dump_result.set_t_list() (无 VM_ThreadDump)
  再运行: getThreadInfo(ids, 50) → 验证 maxDepth>0 路径
  (gdb) print maxDepth → 期望: 50
  (gdb) continue → 进入 do_thread_dump → VM_ThreadDump

断言 2: VM_ThreadDump::doit (vmOperations.cpp:317)
  (gdb) break vmOperations.cpp:317
  (gdb) print this->_num_threads → 期望: 0 (全部线程) 或 >0 (指定线程)
  (gdb) print this->_max_depth → 期望: maxDepth 参数值
  (gdb) print this->_with_locked_monitors → 期望: true/false
  (gdb) print this->_with_locked_synchronizers → 期望: true/false

断言 3: find_deadlocks_at_safepoint DFS (threadService.cpp:362)
  (gdb) break threadService.cpp:362
  运行: JMX findDeadlockedThreads()
  (gdb) print concurrent_locks → 期望: true
  (gdb) continue → 进入 DFS 遍历

断言 4: ThreadsListHandle 构造 (threadSMR.cpp:684)
  (gdb) break threadSMR.cpp:684
  (gdb) print this → 期望: ThreadsListHandle 对象
  (gdb) continue → 进入 acquire_stable_list
```

---

## §十一 与 README 和同组 Prompt 的连续性

- 本文从 **README §四 文档规划** 的 03-thread-monitoring.md 承接 — 覆盖 ThreadImpl + ThreadService + deadlock detection
- **同组边界**:
  - 本文覆盖: jmm_GetThreadInfo 双路径、jmm_DumpThreads 三重锁、VM_ThreadDump safepoint 执行、DFS 死锁检测、ThreadsListHandle、ThreadSnapshot
  - 03 ← 01 (management-jmm-interface): jmm_GetThreadInfo/jmm_DumpThreads 的 JMM 入口 → 本文展开 ThreadService/VM_ThreadDump 后端
  - 03 → 02 (memory-pool-threshold): 无直接依赖，但共享 ServiceThread 基础设施
  - 03 → 04 (os-flag-diagnostic): 无直接依赖
- 本文以 **§〇 的 ThreadDump safepoint 时间异常** 作为生产场景 — 展示 maxDepth>0 路径的 safepoint 代价

---

## §十二 Anti-Hallucination Checklist（生成后自检，必须逐项确认）

| # | 检查项 | 验证方式 |
|---|--------|---------|
| 1 | jmm_GetThreadInfo line 1077 = JVM_ENTRY | grep "jmm_GetThreadInfo" management.cpp |
| 2 | maxDepth==0 路径 = line 1115-1129 (无 VM_ThreadDump) | grep "maxDepth" management.cpp |
| 3 | maxDepth!=0 路径 = line 1130-1139 (do_thread_dump) | grep "do_thread_dump" management.cpp |
| 4 | JNI locked monitors depth=-1 | grep "jni_locked_monitors\|depth.*-1" management.cpp |
| 5 | VM_ThreadDump::doit_prologue Heap_lock = line 301 | grep "Heap_lock" vmOperations.cpp |
| 6 | find_deadlocks_at_safepoint = line 362 | grep "find_deadlocks_at_safepoint" threadService.cpp |
| 7 | concurrent_locks=true → 追踪 park_blocker | grep "current_park_blocker\|concurrent_locks" threadService.cpp |
| 8 | ThreadSnapshot::initialize = line 857 | grep "ThreadSnapshot::initialize" threadService.cpp |
| 9 | ThreadsListHandle 构造 = line 684 | grep "ThreadsListHandle::ThreadsListHandle" threadSMR.cpp |
| 10 | 文档中每个 file:line 引用都是真实行号 | 逐一 grep 验证 |
| 11 | §四 所有 8 组问题都有 Counterfactual 子问题 | 逐组检查 |
| 12 | §一 有 Interview Story Format Answer | 检查 §一 末尾 |
