# PROMPT: 请撰写 11-Stages5-10-Threads-And-ClassLoading.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**Scenario 1: VM Thread hung during GC**. Application freezes with `[GC (Allocation Failure) ...` in GC log but never completes. `jstack -l <pid>` shows VM Thread in `VMThread::run()` waiting on `VMOperationQueue::remove_next()`. Root cause: a previous `VM_Operation` (biased locking revocation) held `SafepointSynchronize_lock` without releasing, blocking all subsequent safepoint operations including GC. Fix: `-XX:-UseBiasedLocking` disables biased locking, eliminating the revocation safepoints. Diagnosis via `jstack` shows `"VM Thread" prio=10 tid=0x... runnable` blocked on `SafepointSynchronize::begin()`.

**Scenario 2: Module system bootstrap failure**. `Error: Unable to initialize main class ... Caused by: java.lang.module.FindException: Module java.base not found`. The JVM called `call_initPhase2()` but `java.lang.System.initPhase2()` threw an exception because the boot layer module resolution failed. Root cause: corrupted `modules` file in `lib/` directory, or `--module-path` pointing to incomplete module set. The failure occurs at thread.cpp:3791, where `vm_exit_during_initialization` is called with no message and no exception — the JVM simply exits with error code.

**Scenario 3: WatcherThread priority inversion**. Profiler shows GC pauses spiking to 200ms when `-XX:+ProfileVM` is enabled. Root cause: `WatcherThread` runs at `MaxPriority` (higher than `VMThread`), and its profiling callback (`JvmtiExport::post_data_dump`) preempts `VMThread` during safepoint exit, extending the pause. Fix: reduce profiling frequency or lower `WatcherThread` priority.

**诊断三件套**（直接写进 §〇）:

```bash
# 1. VM Thread 阻塞诊断
jstack <pid> | grep -A 20 "VM Thread"
# 检查 VM_Operation 队列中的操作类型和阻塞线程

# 2. 模块系统初始化失败
strace -e openat java --module-path broken/path -version 2>&1 | grep modules
# 检查 modules 文件是否被正确打开

# 3. WatcherThread 抢占诊断
jstack <pid> | grep -A 5 "WatcherThread"
# 检查 WatcherThread 当前执行的 PeriodicTask
# 对比 VMThread 的 priority: jstack <pid> | grep "VM Thread" | grep prio

# 4. GDB 断点 VM_Operation 执行
gdb -ex "break vmThread.cpp:465" \
    -ex "run" \
    -ex "print _cur_vm_operation->name()" \
    -ex "print _vm_queue->_queue_length[0]" \
    --args java -XX:+PrintSafepointStatistics app.jar
```

**反事实**：如果 VMThread 没有优先级队列（Safepoint/Medium/Low 三级）→ GC safepoint 操作可能被低优先级的 JVMTI 事件回调排在后面，GC 暂停时间不可预测。如果 call_initPhase2 失败只打印警告而不退出 → 后续代码依赖 `java.base` 模块已初始化（如 `ClassLoader.getPlatformClassLoader()`），所有 Java 调用都抛出 `InternalError`。如果 WatcherThread 优先级等于 VMThread → profiling 采样和 PeriodicTask 调度与 safepoint 操作竞争，GC 延迟不可预测。

---

## §一 Task + Narrative + Beginner Callouts

### Task

Reading this prompt, you will produce a document covering **Stages 5-10** of `Threads::create_vm()` (thread.cpp:4102-4347): the creation of all JVM background threads, Java core class loading, module system initialization, and the transition to Live Phase. This is the **culmination of Phase 01** — the final document that completes the JVM startup story from `JNI_CreateJavaVM` to `return JNI_OK`.

Reader completed documents 00-09 covering init_globals (31 steps) and individual data structures (CodeCache, G1 Heap, Metaspace, SymbolTable, StringTable, Mutex, PerfMemory, G1 Policy, G1 CM Infra). This doc: **the 8 background threads, 17 java.lang core classes, 3-phase module system, and the Live Phase handover** — everything that happens AFTER `init_globals()` returns.

### Interview Story Format Answer（必须出现在 §一 末尾）

"After `init_globals()` completes, `create_vm` enters Stage 5: `VMThread::create()` allocates the VMThread singleton and `VMOperationQueue` — a 3-priority circular doubly-linked list (Safepoint/Medium/Low). `os::create_thread` spawns the OS thread which enters `VMThread::run()` → `VMThread::loop()`, an infinite loop that dequeues `VM_Operation` from the queue, executes `evaluate()` at safepoint, and calls `SafepointSynchronize::end()`. Stage 6: `initialize_java_lang_classes()` loads 17 java.lang classes in strict dependency order — String→System→Class→ThreadGroup→Thread→Module→reflect.Method→ref.Finalizer→8 exception classes — each via `SystemDictionary::resolve_or_fail()` which triggers class loading, linking, verification, and `<clinit>` execution. Stage 7 creates Signal Dispatcher (handles SIGBREAK→thread dump) and AttachListener (UNIX domain socket for jcmd/jmap). Stage 8: ServiceThread (JVMTI deferred events + StringTable cleanup + GC notifications) and Compiler threads (C1/C2 via `compilation_init_phase1`). Stage 9: `call_initPhase2()` calls `System.initPhase2()` — the Java module system resolves `java.base` module → `call_initPhase3()` sets up SecurityManager and SystemClassLoader → `compute_java_loaders()` caches platform/system class loader oops. Stage 10: `enter_live_phase()` marks JVMTI_PHASE_LIVE → `post_vm_initialized()` fires VMInit callbacks to agents → `BiasedLocking::init()` schedules delayed biased lock enabling via PeriodicTask → `WatcherThread::start()` spawns the highest-priority thread (MaxPriority) for profiling and periodic tasks → `return JNI_OK`."

### Beginner Callout Boxes（文档 §一 中必须出现 ≥7 个 callout 框）

1. **VMThread is the ONLY thread that can execute safepoint operations**: All GC pauses, biased lock revocation, code cache sweeps, and JVMTI data dumps execute through `VMThread::execute(VM_Operation*)`. No other thread can enter a safepoint or modify the global VM state that requires a stop-the-world pause. The VMThread runs at elevated priority (`VMThreadPriority` or `NearMaxPriority`). Source: `vmThread.cpp:250-293`.

2. **VM_Operation has 4 execution modes**: `_safepoint` (needs safepoint, blocks caller — GC pauses), `_no_safepoint` (no safepoint, blocks caller — thread dumps), `_concurrent` (no safepoint, non-blocking — JVMTI data dump), `_async_safepoint` (needs safepoint, non-blocking — biased lock revocation). The mode determines whether `SafepointSynchronize::begin()` is called and whether the calling thread waits. Source: `vmOperations.hpp:134`.

3. **Java class loading is NOT just reading .class files**: `initialize_class()` in `Threads::initialize_java_lang_classes()` triggers a 5-step pipeline: load (find .class bytes) → link (verify + prepare + resolve) → initialize (execute `<clinit>`). For the 17 java.lang core classes, this happens before ANY Java code runs — the JVM is bootstrapping its own type system. Source: `thread.cpp:1166-1171`, `thread.cpp:3822-3873`.

4. **Module system initialization is a 3-phase Java callback**: Phase 1 (`call_initPhase1` in `initialize_java_lang_classes`) initializes the module layer. Phase 2 (`call_initPhase2` in Stage 9) resolves `java.base` and other boot modules — failure here is fatal (`vm_exit_during_initialization` with NO error message). Phase 3 (`call_initPhase3` in Stage 9) sets up SecurityManager and SystemClassLoader. Source: `thread.cpp:3773-3815`.

5. **The 17 java.lang classes have a strict dependency order**: `String` must load first (used by Class names), `System` before `Thread` (initPhase1 creates main thread group), `Class` before `Thread` (Thread extends Object, Object's Class must exist), `Thread` before `Module` (module system needs thread context). Violating this order → circular dependency → `ClassCircularityError`. Source: `thread.cpp:3822-3873`.

6. **Signal Dispatcher is a JavaThread that handles OS signals**: It's NOT a signal handler (those run in signal context with severe restrictions). Instead, it's a daemon JavaThread that blocks on `os::signal_wait()` and dispatches signals to Java-level `jdk.internal.misc.Signal` handlers via `JavaCalls::call_static`. For SIGBREAK (Ctrl+Break), it triggers thread dump + JNI ref dump + deadlock detection via `VMThread::execute`. Source: `os.cpp:346-470`.

7. **WatcherThread has HIGHER priority than VMThread**: `MaxPriority` (typically 10 on Linux, `SCHED_OTHER` max) vs VMThread's `NearMaxPriority` (9). This is intentional: profiling callbacks in WatcherThread must not be delayed by safepoint operations. However, this priority inversion can extend GC pauses if WatcherThread runs during safepoint exit. Source: `thread.cpp:1477-1523`, `thread.cpp:1614-1630`.

8. **AttachListener has a lazy initialization pattern**: If `StartAttachListener` is false (default), the listener is NOT created at startup. Instead, `Signal Dispatcher` checks for the attach trigger file on SIGBREAK and calls `AttachListener::init()` lazily. This saves a thread + socket for applications that never use jcmd/jmap. Source: `attachListener.cpp:435-445`, `os.cpp:346-360`.

---

## §二 Standard Environment

### Source Roots

| Root | Path | 用途 |
|------|------|------|
| create_vm 主流程 | `src/hotspot/share/runtime/thread.cpp` (:3886-4347) | Stages 5-10 全部逻辑 |
| VMThread | `src/hotspot/share/runtime/vmThread.cpp` + `vmThread.hpp` | VMThread::create/run/loop + VMOperationQueue |
| VM Operations | `src/hotspot/share/runtime/vmOperations.hpp` + `vmOperations.cpp` | VM_Operation 基类 |
| Safepoint | `src/hotspot/share/runtime/safepoint.cpp` + `safepoint.hpp` | SafepointSynchronize::begin/end |
| Class Loading | `src/hotspot/share/classfile/systemDictionary.cpp` (:1937-2020) | SystemDictionary::initialize + resolve_well_known_classes |
| Universe | `src/hotspot/share/memory/universe.cpp` (:323-550) | Universe::genesis + initialize_basic_type_mirrors |
| Signal Dispatcher | `src/hotspot/share/runtime/os.cpp` (:346-530) | signal_thread_entry + init_before_ergo |
| Attach Listener | `src/hotspot/share/services/attachListener.cpp` + `os/linux/attachListener_linux.cpp` | init + socket 管理 |
| Metaspace post-init | `src/hotspot/share/memory/metaspace.cpp` (:1496) | post_initialize |
| ServiceThread | `src/hotspot/share/runtime/serviceThread.cpp` + `serviceThread.hpp` | initialize + 5-event loop |
| Compile Broker | `src/hotspot/share/compiler/compileBroker.cpp` (:614-925) | compilation_init_phase1/2 + init_compiler_sweeper_threads |
| JSR292 | `src/hotspot/share/runtime/thread.cpp` (:3876-3884) | initialize_jsr292_core_classes |
| Module System | `src/hotspot/share/classfile/moduleEntry.cpp/hpp` + `packageEntry.cpp/hpp` | ModuleEntryTable + PackageEntryTable |
| JVMTI Export | `src/hotspot/share/prims/jvmtiExport.cpp` (:606-696) | enter_live_phase + post_vm_start/init |
| Biased Locking | `src/hotspot/share/runtime/biasedLocking.cpp` (:95) | init + EnableBiasedLockingTask |
| WatcherThread | `src/hotspot/share/runtime/thread.cpp` (:1477-1630) | WatcherThread constructor + start |

### Build Configuration

```bash
make hotspot
nm -C build/linux-x86_64-server-release/hotspot/variant-server/libjvm/libjvm.so | grep -E "VMThread::(create|run|loop)"
```

### Binary Paths

| Binary | Path |
|--------|------|
| libjvm.so | `build/linux-x86_64-server-release/hotspot/variant-server/libjvm/libjvm.so` |
| Key symbols | `VMThread::_vm_thread`, `VMOperationQueue::add`, `Threads::create_vm` |

### Syscall / Library 速查

| Call | man | 上下文 |
|------|-----|--------|
| `pthread_create` | `man 3 pthread_create` | VMThread/ServiceThread/CompilerThread/SignalDispatcher/WatcherThread 创建 |
| `pthread_cond_wait` | `man 3 pthread_cond_wait` | `VMOperationQueue::remove_next` 中等待 VM 操作 |
| `sched_setscheduler` | `man 2 sched_setscheduler` | `os::set_native_priority` 设置线程优先级 |
| `sigwait`/`sigwaitinfo` | `man 2 sigwait` | `os::signal_wait` Signal Dispatcher 阻塞 |
| `socket`/`bind`/`listen`/`accept` | `man 2 socket` | AttachListener UNIX domain socket |
| `unlink` | `man 2 unlink` | AttachListener::vm_start 清理残留 socket |

---

## §三 Source Files Table

| # | File | 行数 | 角色 | 关键行 |
|---|------|:---:|------|--------|
| 1 | `src/hotspot/share/runtime/thread.cpp` | ~6300 | create_vm Stages 5-10 + 类加载 + JSR292 | :3822-4347 |
| 2 | `src/hotspot/share/runtime/vmThread.cpp` | ~500 | VMThread::create/run/loop + VMOperationQueue | :56, :250, :293, :465 |
| 3 | `src/hotspot/share/runtime/vmThread.hpp` | ~200 | VMThread + VMOperationQueue 类定义 | :39 |
| 4 | `src/hotspot/share/runtime/vmOperations.hpp` | ~300 | VM_Operation 基类 + 4 种执行模式 | :134 |
| 5 | `src/hotspot/share/runtime/safepoint.cpp` | ~800 | SafepointSynchronize::begin/end | :156, :527 |
| 6 | `src/hotspot/share/classfile/systemDictionary.cpp` | ~3200 | initialize + resolve_well_known_classes + compute_java_loaders | :131, :1937, :2020 |
| 7 | `src/hotspot/share/memory/universe.cpp` | ~2000 | genesis + initialize_basic_type_mirrors | :323, :466 |
| 8 | `src/hotspot/share/runtime/os.cpp` | ~1500 | signal_thread_entry + init_before_ergo | :346, :477 |
| 9 | `src/hotspot/share/services/attachListener.cpp` | ~500 | AttachListener::init | :435 |
| 10 | `src/hotspot/os/linux/attachListener_linux.cpp` | ~600 | AttachListener Linux 实现 | :461, :495, :531 |
| 11 | `src/hotspot/share/memory/metaspace.cpp` | ~1500 | Metaspace::post_initialize | :1496 |
| 12 | `src/hotspot/share/runtime/serviceThread.cpp` | ~150 | ServiceThread::initialize + service_thread_entry | :51, :90 |
| 13 | `src/hotspot/share/compiler/compileBroker.cpp` | ~2000 | compilation_init_phase1/2 + init_compiler_sweeper_threads | :614, :768, :864 |
| 14 | `src/hotspot/share/prims/jvmtiExport.cpp` | ~2800 | enter_start_phase + enter_live_phase + post_vm_start/init | :606-696 |
| 15 | `src/hotspot/share/runtime/biasedLocking.cpp` | ~500 | BiasedLocking::init + EnableBiasedLockingTask | :95 |
| 16 | `src/hotspot/share/classfile/moduleEntry.cpp` | ~400 | ModuleEntryTable 构造函数 | :316 |
| 17 | `src/hotspot/share/classfile/packageEntry.cpp` | ~200 | PackageEntryTable 构造函数 | :170 |

---

## §四 Deep Dive Question Groups

### Group 1: VMThread — 单例设计与生命周期

1. **VMThread::create() 创建了哪些数据结构？VMOperationQueue 的 3 优先级循环双向链表如何实现？** 答案方向：`VMThread::create()` (vmThread.cpp:250) 创建: ① `new VMThread()` C++ 对象 (C-Heap); ② `new VMOperationQueue()` 含 3 个优先级哨兵节点 (SafepointPriority/MediumPriority/LowPriority)，每个是 `VM_Dummy` 自环哨兵; ③ `VMOperationTimeoutTask` (可选 PeriodicTask); ④ `_terminate_lock` (Monitor); ⑤ PerfData 计数器。追问：为什么不直接在构造函数中创建 OS 线程？调用方 `create_vm` 负责 `os::create_thread`，分离 C++ 对象构造和 OS 线程创建。

2. **VMThread::run() → VMThread::loop() 的无限循环在什么条件下终止？terminate_lock 的同步协议是什么？** 答案方向：`run()` 初始化后进入 `this->loop()` (vmThread.cpp:465): 循环从 `_vm_queue->remove_next()` 取操作 → `evaluate_operation()` → `SafepointSynchronize::begin/end`。终止条件: `_should_terminate` 标志 + 收到终止信号 → 执行 VM_Exit safepoint → `_terminate_lock->notify()` 通知等待者 (vmThread.cpp:293-340)。追问：为什么需要 `_terminate_lock`？`before_exit()` 等待 VMThread 完成最后的 safepoint 操作。

3. **VM_Operation 的 4 种执行模式有什么区别？evaluate_at_safepoint() 的返回值如何决定 VMThread 的行为？** 答案方向：`_safepoint` (evaluate_at_safepoint=true, 阻塞调用者) → VMThread 调用 `SafepointSynchronize::begin()` 后执行 `doit()`; `_no_safepoint` (evaluate_at_safepoint=false, 阻塞调用者) → 直接执行 `doit()`; `_concurrent` (evaluate_at_safepoint=false, 非阻塞) → 在 VMThread 循环中直接执行，调用者不等待; `_async_safepoint` (evaluate_at_safepoint=true, 非阻塞) → 在下次 safepoint 执行，调用者不等待 (vmOperations.hpp:134-250)。追问：GC 暂停使用哪种模式？`_safepoint` — 需要全局暂停且调用者等待完成。

### Group 2: Safepoint 协议 — VMThread 与 JavaThread 的握手

4. **SafepointSynchronize::begin() 如何让所有 JavaThread 停止？arm/disarm polling page 的机制是什么？** 答案方向：`SafepointSynchronize::begin()` (safepoint.cpp:156): ① `arm_safepoint()` 设置全局 `_state = _synchronizing`; ② 设置 polling page 为不可读 (mprotect PROT_NONE); ③ 遍历所有 JavaThread，检查 `thread->safepoint_state()->handle_polling_page_exception()`; ④ 等待所有线程阻塞 (自旋 + yield + `Safepoint_lock->wait()`)。追问：polling page 是什么？一个 4KB 内存页，JIT 编译的代码在每个 safepoint poll 点读取此页 — 正常可读时快速通过 (~1ns)，被保护时触发 SIGSEGV → 信号处理器 → 线程阻塞。

5. **SafepointSynchronize::end() 如何唤醒所有阻塞线程？disarm polling page 的时机是什么？** 答案方向：`end()` (safepoint.cpp:527): ① 重置 `_state = _not_synchronized`; ② `disarm_safepoint()` 恢复 polling page 为可读 (mprotect PROT_READ); ③ `Safepoint_lock->notify_all()` 唤醒所有在 `block()` 中等待的线程; ④ 设置 `_safepoint_counter++`。追问：如果在 `end()` 和线程实际恢复之间发生新的 safepoint 请求 → `_state` 再次变为 `_synchronizing`，线程重新阻塞。

### Group 3: 17 个 java.lang 核心类加载

6. **initialize_java_lang_classes() 的 17 个类按什么依赖顺序加载？每个 initialize_class 调用触发什么级联操作？** 答案方向：严格顺序 (thread.cpp:3822-3873): String → System → Class → ThreadGroup → Thread → Module → reflect.Method → ref.Finalizer → 8 个异常类 → JSR292 类。每个 `initialize_class` → `SystemDictionary::resolve_or_fail` → 类加载 (ClassLoader.loadClass) → 链接 (verify+prepare+resolve) → `<clinit>` 执行。追问：为什么 Thread 必须在 Module 之前？Module 类引用了 `java.lang.Thread`，必须先有 Thread 的 Klass。为什么 String 必须最先？所有类名是 String，Class 的 name 字段是 String。

7. **8 个异常类为什么需要预初始化？预分配的异常实例存储在哪里？** 答案方向：`OutOfMemoryError`/`NullPointerException`/`ClassCastException`/`ArrayStoreException`/`ArithmeticException`/`StackOverflowError`/`IllegalMonitorStateException`/`IllegalArgumentException` — 这些异常在 `universe_post_init()` 中预分配实例 (universe.cpp:1230-1280)，存储在 `Universe::_out_of_memory_error_*` 等静态 oop 中。追问：为什么预分配？这些异常在 JVM 内部抛出时（如 GC OOM、NPE on `null` receiver），JVM 没有 Java 线程上下文去分配对象，必须使用预分配实例。Counterfactual：如果不预分配 — JVM 需要在 OOM 条件下再分配 OOM 对象 → 递归 OOM → 死循环。

### Group 4: Signal Dispatcher — OS 信号到 Java 回调的桥接

8. **Signal Dispatcher 如何将 SIGBREAK (Ctrl+Break) 转换为线程 dump？** 答案方向：`signal_thread_entry()` (os.cpp:346) 主循环: `os::signal_wait()` 阻塞等待信号 → SIGBREAK: ① 触发 `AttachListener::is_init_trigger()` (尝试 lazy init attach listener); ② `VMThread::execute(new VM_PrintThreads())` 打印所有线程栈; ③ `VMThread::execute(new VM_PrintJNI())` 打印 JNI 引用; ④ `VMThread::execute(new VM_FindDeadlocks())` 检测死锁; ⑤ 可选 `VM_GC_HeapInspection` 堆直方图; ⑥ `JvmtiExport::post_data_dump()` JVMTI 数据 dump。追问：为什么信号处理不直接在 signal handler 中执行？signal handler 运行在异步信号上下文，不能分配内存、不能持锁、不能调用大部分 libc 函数。

9. **Signal Dispatcher 的优先级为什么是 NearMaxPriority？如果它被阻塞会有什么后果？** 答案方向：`NearMaxPriority` 确保 Signal Dispatcher 在 GC 线程之前被调度 (os.cpp:502)。如果被阻塞 → SIGBREAK 信号不被处理 → `jstack`/`kill -3` 无法获取线程 dump。追问：Linux 上 `NearMaxPriority` 对应什么 nice 值？`-XX:JavaPriority10_To_OSPriority` 映射 → nice -10 左右。

### Group 5: AttachListener — 动态诊断连接

10. **AttachListener 的 UNIX domain socket 路径是什么？vm_start() 为什么需要 unlink 残留文件？** 答案方向：路径 `/tmp/.java_pid<PID>` (attachListener_linux.cpp:461-480)。`vm_start()` 在启动时 `unlink(fn)` 删除残留 socket 文件 (L465)，防止上次异常退出留下的文件导致 `bind()` 失败。追问：`init()` 创建 socket → `bind()` → `listen()` → JavaThread 循环 `accept()`。如果 `bind()` 失败 (Address already in use) → `set_state(AL_NOT_INITIALIZED)` 允许后续 lazy init 重试。

11. **AttachListener 的 lazy initialization 机制是什么？为什么不是所有 JVM 都启动 AttachListener？** 答案方向：`StartAttachListener` 默认为 false。SIGBREAK 触发 `is_init_trigger()` → 检查触发文件 → `transit_state(AL_INITIALIZING)` → `AttachListener::init()`。追问：如果 `-XX:+StartAttachListener` — 在 `create_vm` Stage 7 直接调用 `init()`。Counterfactual：如果所有 JVM 都启动 AttachListener — 每个 JVM 进程多一个线程 + socket，容器中 1000 个 JVM 多 1000 个 socket 和文件描述符。

### Group 6: ServiceThread — 5 种后台事件处理

12. **ServiceThread 的 service_thread_entry 处理哪 5 种事件？为什么这些事件不能在各自触发线程中直接处理？** 答案方向：5 种事件 (serviceThread.cpp:90-130): ① `StringTable::do_concurrent_work()` — 并发清理死字符串; ② `JvmtiDeferredEventQueue::dequeue()` → `post()` — JVMTI 延迟事件; ③ `LowMemoryDetector::process_sensor_changes()` — 低内存通知; ④ `GCNotifier::sendNotification()` — GC JMX 通知; ⑤ `DCmdFactory::send_notification()` — 诊断命令 JMX 通知。追问：为什么需要延迟处理？JVMTI 事件不能在 safepoint 内发送（会导致 `JVMTI_ERROR_WRONG_PHASE`），必须延迟到 safepoint 之后。低内存检测需要分配 Java 对象 → 不能在 GC 中执行。

13. **ServiceThread 的等待机制是什么？为什么使用 Service_lock 而非简单的 sleep？** 答案方向：`MonitorLockerEx ml(Service_lock)` → `ml.wait()` 等待直到 `has_work()` 返回 true。各个生产者（GC/JVMTI/DCmdFactory）通过 `Service_lock->notify_all()` 唤醒 ServiceThread (serviceThread.cpp:51-88)。追问：如果没有事件 → ServiceThread 永久等待，不消耗 CPU。Counterfactual：如果用 `sleep(100ms)` 轮询 — 100ms 延迟对于低内存检测（需要立即释放内存）不可接受。

### Group 7: Compiler 线程创建 — compilation_init_phase1/2

14. **compilation_init_phase1 如何决定 C1/C2 编译器线程数？init_compiler_sweeper_threads 的内部流程是什么？** 答案方向：`compilation_init_phase1()` (compileBroker.cpp:614-766): 从 `CompilationPolicy::compiler_count()` 获取线程数 → 创建 `AbstractCompiler` 实例 (C1/C2 或 JVMCI) → `init_compiler_sweeper_threads()` (compileBroker.cpp:864-925): 创建 C1/C2 编译器线程 (JavaThread, daemon, NearMaxPriority) + CodeCache sweeper 线程。追问：编译器线程数的默认值？`CICompilerCount` 默认 = `max(log2(NCores), 1) * 3/2` for tiered, 或 1 for non-tiered。

15. **compilation_init_phase2 为什么只有一行 `_initialized = true`？这个 flag 的作用是什么？** 答案方向：`_initialized = true` (compileBroker.cpp:768) 标记编译系统就绪。在此之前，所有 `compile_method()` 调用被静默忽略。追问：为什么需要这个 flag？在 `init_globals` 期间，编译器线程尚未创建，方法调用可能触发编译请求 → 必须过滤掉。JVMCI 路径在 `JVMCIRuntime::force_initialization()` 之后才调用 phase2，确保 JVMCI 编译器完全就绪。

### Group 8: 模块系统 — call_initPhase2/3

16. **call_initPhase2 调用 `System.initPhase2()` 后 module 系统进入什么状态？为什么 Phase2 失败是 fatal error？** 答案方向：`call_initPhase2()` (thread.cpp:3791): 解析 `java.lang.System` Klass → `JavaCalls::call_static` 调用 `initPhase2(boolean, boolean)int` → 返回值非 `JNI_OK` → `vm_exit_during_initialization()`。Phase2 完成后: `java.base` 模块解析完毕，`-Xbootclasspath/a` 的类可用。追问：为什么 fatal 而非抛出异常？此时没有 Java 异常处理机制 — 异常需要 `java.lang.Throwable` 已加载，但模块系统失败意味着 `java.base` 不可用。Counterfactual：如果 Phase2 失败后尝试降级运行 — 任何 Java 调用都会触发 `NoClassDefFoundError`。

17. **call_initPhase3 与 Phase2 的区别是什么？为什么 Phase3 没有返回值检查？** 答案方向：`call_initPhase3()` (thread.cpp:3815): 调用 `System.initPhase3()void` — 设置 SecurityManager + SystemClassLoader。无返回值检查因为 `initPhase3` 声明为 void，异常由 JVM 的 Java 调用机制 (`CHECK_JNI_ERR`) 处理。追问：Phase3 之后 `compute_java_loaders()` (thread.cpp:4264) 获取 PlatformClassLoader 和 SystemClassLoader 的 oop → 存入 `SystemDictionary::_java_platform_loader` 和 `_java_system_loader`。

### Group 9: Live Phase — JVM 完全就绪

18. **enter_live_phase() 到 return JNI_OK 之间发生了什么？post_vm_initialized 如何通知所有 JVMTI agent？** 答案方向：`enter_live_phase()` → `JVMTI_PHASE_LIVE` (jvmtiExport.cpp:622) → `post_vm_initialized()` 遍历 `_head_environment` 链表 → 对每个 enabled 的 env 调用 `VMInit` 回调 (jvmtiExport.cpp:677-696) → `Management::initialize()` (JMX agent) → `BiasedLocking::init()` 延迟启用偏向锁 → `call_postVMInitHook()` Java 回调 → `WatcherThread::start()` 创建最高优先级线程 → `return JNI_OK` (thread.cpp:4282-4347)。

19. **BiasedLocking::init() 为什么使用延迟启用策略？EnableBiasedLockingTask 和 PeriodicTask 的关系是什么？** 答案方向：`BiasedLocking::init()` (biasedLocking.cpp:95): 如果 `BiasedLockingStartupDelay > 0` → `new EnableBiasedLockingTask(delay)` → `PeriodicTask::enroll()` 注册到 WatcherThread 的定时任务队列。delay 秒后 WatcherThread 执行 task → `VMThread::execute(new VM_EnableBiasedLocking())` → 在安全点启用偏向锁。追问：为什么需要延迟？启动期间大量类加载和初始化触发频繁的 safepoint，如果立即启用偏向锁 → 每次 safepoint 撤销所有偏向锁 → 启动时间增加 30-50%。Counterfactual：如果不延迟 → 启动期间偏向锁撤销风暴，CPU 消耗在 `BiasedLocking::revoke_at_safepoint()` 上。

### Group 10: WatcherThread — 最高优先级线程

20. **WatcherThread 为什么需要 MaxPriority？它执行的 PeriodicTask 队列包含哪些任务？** 答案方向：`WatcherThread::WatcherThread()` (thread.cpp:1477): `os::create_thread(this, os::watcher_thread)` → 创建 OS 线程 → `MaxPriority` → `os::start_thread`。WatcherThread 运行 `WatcherThread::run()` 循环：① 计算下次到期时间 (min of all enrolled PeriodicTasks); ② `_startup_ticks` (JVM 启动时间); ③ `sleep(最小到期时间)`; ④ 执行所有到期 task: `EnableBiasedLockingTask`, `StatSamplerTask` (perfdata 采样), `JniPeriodicCheckerTask`, `MemProfilerTask`, `VM_PeriodicTask` (JFR), 用户自定义 `PeriodicTask`。追问：为什么 WatcherThread 优先级高于 VMThread？profiling 采样必须在固定间隔执行，不能被 safepoint 延迟。

### Group 11: JSR292 核心类预加载

21. **initialize_jsr292_core_classes 为什么必须在编译器初始化之后？这 4 个类 (MethodHandle/MemberName/ResolvedMethodName/MethodHandleNatives) 的特殊性是什么？** 答案方向：`initialize_jsr292_core_classes()` (thread.cpp:3876): MethodHandle → ResolvedMethodName → MemberName → MethodHandleNatives。必须在编译器初始化之后因为: ① MethodHandle 的 signature polymorphic 方法需要 `SystemDictionary::find_method_handle_intrinsic` 在编译器初始化后才能解析; ② 提前加载避免后续类加载死锁 — 如果编译器在编译方法时触发 MethodHandle 类加载，而类加载需要 safepoint，形成循环依赖。追问：什么是 signature polymorphic 方法？`MethodHandle.invokeExact()` 和 `invoke()` 的签名由调用点的 MethodType 决定，JIT 编译器直接生成 native wrapper 而非常规虚方法调用。

### Group 12: create_vm 的失败处理 — CHECK_JNI_ERR vs vm_exit_during_initialization

22. **create_vm 的 Stages 5-10 中有哪些不同的失败处理模式？CHECK_JNI_ERR 和 vm_exit_during_initialization 的使用场景有什么区别？** 答案方向：两种模式: ① `CHECK_JNI_ERR` — Java 异常传播 → `JNI_CreateJavaVM` 返回错误码 (如 `JNI_ERR`, `JNI_EINVAL`)，允许调用者处理; ② `vm_exit_during_initialization` — 不可恢复错误 → 打印消息 → `os::exit(1)` 直接退出进程。追问：哪些步骤用 CHECK_JNI_ERR？类加载、模块系统初始化 (Java 层可抛出异常)。哪些用 vm_exit_during_initialization？线程创建 OOM、agent 加载失败 (C++ 层无法传播异常)。Counterfactual：如果所有错误都用 CHECK_JNI_ERR — OOM 在 `new JavaThread()` 时返回 NULL，但 JavaThread 构造失败导致后续 `set_threadObj` 崩溃。

---

## §五 Article Structure（每 Section 的行数目标）

### Section 编写顺序和依赖

```
§〇→§一→§二→§三 (基础信息，一次性写完)
  ↓
§四 Stage 5: VMThread (必须先于所有线程创建，因为 Stage 6+ 的类加载需要 safepoint)
  ↓
§五 Stage 6: 核心类加载 (必须先于模块系统，因为 initPhase1 依赖 java.lang.System)
  ↓
§六 Stage 7: Signal + Attach (必须在 Stage 8 之前，因为 ServiceThread 可能接收 JVMTI 事件)
  ↓
§七 Stage 8: ServiceThread + Compiler (编译器必须在 Stage 9 之前，因为 JSR292 需要)
  ↓
§八 Stage 9: 模块系统 (必须在 Live Phase 之前，因为 Live Phase 需要 SystemClassLoader)
  ↓
§九 Stage 10: Live Phase + 收尾 (最终阶段)
  ↓
§十→§十一→§十二→§十三 (汇总表 + 诊断 + syscall)
```

### 各 Section 详细要求

**§四 Stage 5: VMThread** — 必须包含:
- VMOperationQueue 3 优先级哨兵链表实现 (代码 + ASCII 图)
- VM_Operation 4 种执行模式对比表 (模式 + safepoint + 阻塞 + 典型用例)
- Safepoint 握手协议 Mermaid 序列图 (VMThread ↔ JavaThread)
- VMThread::execute() 的 30 个调用者分类 (GC/JIT/Class/Symbol/AOT)
- VMThread::loop() 的 drain 机制: drain_at_safepoint_priority() 批量合并
- 终止协议: _should_terminate → SafepointSynchronize::begin → VM_Exit → _terminate_lock

**§五 Stage 6: 核心类加载** — 必须包含:
- 17 个类的依赖关系 Mermaid 流程图 (String→System→...)
- initialize_class 的 5 步管线详解 (resolve_or_fail → load → link → verify → init)
- 8 个预分配异常类的存储 (Universe::_out_of_memory_error_* 等静态 oop)
- create_initial_thread() 主线程 Thread 对象创建 (RUNNABLE 状态设置)
- call_initPhase1() 模块系统第一阶段的 Java 回调
- SystemDictionary::initialize() 的 5 个内部哈希表创建 (PlaceholderTable 等)

**§六 Stage 7: Signal Dispatcher + AttachListener** — 必须包含:
- Signal Dispatcher Mermaid 序列图 (OS signal → sigwait → dispatch)
- SIGBREAK 处理的完整代码路径 (AttachListener lazy init → VM_PrintThreads → VM_FindDeadlocks)
- AttachListener socket 路径 `/tmp/.java_pid<PID>` 和 vm_start() unlink
- AttachListener lazy initialization 状态机 (AL_NOT_INITIALIZED → AL_INITIALIZING → AL_INITIALIZED)
- Metaspace::post_initialize() 的 GC 阈值设置

**§七 Stage 8: ServiceThread + Compiler** — 必须包含:
- ServiceThread 5 事件处理 Mermaid 流程图
- Service_lock 等待/通知协议 (wait → has_work → process → loop)
- compilation_init_phase1: compiler_count 计算 → init_compiler_sweeper_threads
- init_compiler_sweeper_threads 的内部: create_thread_oop → make_global → make_local → os::create_thread
- C1/C2 编译器线程数计算: CICompilerCount default = max(log2(NCores), 1) * 3/2
- JSR292 预加载 4 个类的死锁避免原理

**§八 Stage 9: 模块系统** — 必须包含:
- 3 Phase 模块系统初始化 Mermaid 时序图
- Phase2 的 fatal 处理: 为什么不能抛异常
- Phase3 的 SecurityManager 设置 (可能被 -Djava.security.manager 禁用)
- compute_java_loaders: PlatformClassLoader vs SystemClassLoader
- ModuleEntryTable (Hashtable<Symbol*, mtModule>) 和 PackageEntryTable 的结构

**§九 Stage 10: Live Phase + 收尾** — 必须包含:
- Live Phase 到 JNI_OK Mermaid 流程图
- BiasedLocking::init() 的延迟策略: EnableBiasedLockingTask + PeriodicTask + VM_EnableBiasedLocking
- WatcherThread::run() 循环: 计算最小到期时间 → sleep → 执行到期 task
- WatcherThread 的 PeriodicTask 队列: StatSampler + EnableBiasedLocking + JniPeriodicChecker + MemProfiler
- post_vm_initialized: JvmtiEventController::vm_init → 遍历 env 链表 → VMInit callback
- JNI_CreateJavaVM_inner 中 create_vm 返回后的收尾 (jni.cpp:4046-4139): JVMCI bootstrap + RuntimeService + CompileTheWorld + ciReplay

**§十 线程优先级总览** — 必须包含:
- 8 线程优先级对比表 (线程名 + 类型 + C++ 优先级 + Linux nice 值 + 入口函数 + 创建位置 file:line)
- 优先级设计原理: WatcherThread (MaxPriority) > VMThread (NearMaxPriority) > Compiler/Service/Signal/Attach (NearMaxPriority) > Sweeper (NearMaxPriority)
- 优先级反转风险: WatcherThread profiling 在 safepoint 退出期间抢占 VMThread

**§十一 JVMTI Phase 转变时间线** — 必须包含:
- 4 次阶段切换的 create_vm 位置和行号
- 每个阶段可用的 JVMTI API 范围 (ONLOAD: 查询系统属性; PRIMORDIAL: 受限; START: JNI 可用; LIVE: 全功能)
- JVMTI Phase 状态机 Mermaid 图 (stateDiagram)

**§十二 边缘场景与诊断** — 必须包含:
- VM_Operation 队列堆积: jstack VM Thread → 查看 _vm_queue 长度
- 模块系统初始化失败: -Xlog:modules=debug + strace -e openat
- 偏向锁撤销风暴: -XX:+TraceBiasedLocking + jstack safepoint 统计
- WatcherThread 优先级反转: perf sched record + perf sched latency
- Signal Dispatcher 死锁: 如果 Signal Dispatcher 调用需要 safepoint 的 VM_Operation → 死锁 (因为它已经持有某些锁)

**§十三 系统调用与 /proc 交互** — 必须包含:
- pthread_create (man 3): 所有线程创建的底层 syscall → clone(CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM|CLONE_SETTLS|CLONE_PARENT_SETTID|CLONE_CHILD_CLEARTID)
- sched_setscheduler (man 2): os::set_native_priority 设置 SCHED_OTHER nice 值
- sigwait/sigwaitinfo (man 2): Signal Dispatcher 阻塞等待
- socket/bind/listen/accept (man 2): AttachListener UNIX domain socket
- /proc/self/task/<tid>/stat: 验证线程优先级 (field 19 = nice)
- /proc/self/task/<tid>/sched: 验证调度策略 (SCHED_OTHER/SCHED_FIFO/SCHED_RR)

### 目标行数

| Section | 目标行数 |
|---------|:------:|
| §〇 Production Scenario | ~80 |
| §一 Interview + Callouts | ~100 |
| §二 Standard Environment | ~60 |
| §三 Source Files Table | ~30 |
| §四 Stage 5 VMThread | ~300 |
| §五 Stage 6 Class Loading | ~250 |
| §六 Stage 7 Signal + Attach | ~200 |
| §七 Stage 8 Service + Compiler | ~250 |
| §八 Stage 9 Module System | ~200 |
| §九 Stage 10 Live Phase | ~250 |
| §十 Thread Priority | ~80 |
| §十一 JVMTI Timeline | ~80 |
| §十二 Edge Cases + Diagnosis | ~100 |
| §十三 Syscall + /proc | ~60 |
| **总计** | **~2,040** |

```
# 11-Stages5-10-Threads-And-ClassLoading — VMThread 到 Live Phase

## §〇 Production Scenario（3 个真实故障 + 诊断工具 + 反事实）

## §一 Interview Answer + Beginner Callouts（≥7 callout 框）

## §二 Standard Environment（source roots + build + binary paths + syscall 速查）

## §三 Source Files Table

## §四 Stage 5: VMThread — 安全点执行引擎（~300 行）
### 4.1 VMThread::create(): 单例 + VMOperationQueue 3 优先级
### 4.2 VMThread::run() → loop(): 无限循环消费 VM_Operation
### 4.3 VM_Operation 4 种执行模式 (_safepoint/_no_safepoint/_concurrent/_async)
### 4.4 SafepointSynchronize::begin/end 握手协议
### 4.5 VMOperationQueue 循环双向链表实现

## §五 Stage 6: Java 核心类加载（~250 行）
### 5.1 initialize_java_lang_classes(): 17 个类的依赖顺序
### 5.2 initialize_class() 的 5 步管线 (load→link→verify→prepare→<clinit>)
### 5.3 8 个预分配异常类: 存储位置与使用场景
### 5.4 SystemDictionary::initialize() 与 resolve_well_known_classes()

## §六 Stage 7: Signal Dispatcher + AttachListener（~200 行）
### 6.1 Signal Dispatcher: signal_thread_entry + SIGBREAK 处理
### 6.2 AttachListener: UNIX domain socket + lazy initialization
### 6.3 Metaspace::post_initialize()

## §七 Stage 8: ServiceThread + Compiler 线程（~250 行）
### 7.1 ServiceThread: 5 种事件处理 + Service_lock 等待
### 7.2 CompileBroker::compilation_init_phase1: C1/C2 线程 + sweeper
### 7.3 compilation_init_phase2: _initialized = true
### 7.4 JSR292 核心类预加载 (MethodHandle/MemberName/...)

## §八 Stage 9: 模块系统 — call_initPhase2/3（~200 行）
### 8.1 call_initPhase2: System.initPhase2() + 失败 fatal
### 8.2 call_initPhase3: SecurityManager + SystemClassLoader
### 8.3 SystemDictionary::compute_java_loaders()

## §九 Stage 10: Live Phase + 收尾（~250 行）
### 9.1 enter_live_phase() + post_vm_initialized()
### 9.2 BiasedLocking::init() + EnableBiasedLockingTask 延迟策略
### 9.3 WatcherThread::start() + MaxPriority 设计
### 9.4 call_postVMInitHook() + create_vm_timer.end()
### 9.5 return JNI_OK

## §十 线程优先级总览（~80 行）
### 10.1 8 个线程的优先级对比表 (VMThread/Signal/Attach/Service/C1/C2/Sweeper/Watcher)
### 10.2 优先级设计原理: 为什么 WatcherThread > VMThread > 编译器？

## §十一 JVMTI Phase 转变时间线（~80 行）
### 11.1 PRIMORDIAL→ONLOAD→START→LIVE 的 4 次切换
### 11.2 每个阶段可用的 JVMTI API 范围

## §十二 边缘场景与诊断（~100 行）
### 12.1 VM_Operation 队列堆积: 诊断方法与 GDB 断点
### 12.2 模块系统初始化失败: strace + -Xlog:modules 诊断
### 12.3 偏向锁撤销风暴: jstack + -XX:+TraceBiasedLocking
### 12.4 WatcherThread 优先级反转: perf top + 调度延迟分析

## §十三 系统调用与 /proc 交互
### 13.1 pthread_create (man 3) — 所有后台线程创建
### 13.2 sched_setscheduler (man 2) — 线程优先级设置
### 13.3 sigwait/sigwaitinfo (man 2) — Signal Dispatcher
### 13.4 socket/bind/listen/accept (man 2) — AttachListener
### 13.5 /proc/self/task/<tid>/stat — 线程优先级验证
### 13.6 /proc/self/task/<tid>/sched — 调度策略验证
```

### Mermaid 图表要求

1. **VM_Operation 生命周期** (flowchart LR): 调用者 create → VMThread::execute → VMOperationQueue::add → VMThread::loop → evaluate → 返回结果
2. **Safepoint 握手协议** (sequenceDiagram): VMThread → arm_safepoint → JavaThread: poll → SIGSEGV → block → VMThread: all blocked → do operation → disarm_safepoint → notify_all → resume
3. **17 个核心类加载依赖图** (flowchart TD): String → System → Class → ThreadGroup → Thread → Module → Method → Finalizer → 8 异常类 → JSR292
4. **Signal Dispatcher 信号分发** (sequenceDiagram): OS signal → sigwait → Signal Dispatcher → VMThread::execute → print threads → JavaCalls::call_static → Signal.dispatch()
5. **ServiceThread 5 事件循环** (flowchart TD): Service_lock.wait → StringTable work → JVMTI events → LowMemoryDetector → GCNotifier → DCmdFactory → loop
6. **模块系统 3 Phase 时序** (sequenceDiagram): create_vm → initPhase1 → 加载 17 类 → initPhase2 → java.base 解析 → initPhase3 → SecurityManager
7. **Live Phase 到 JNI_OK 收尾** (flowchart LR): enter_live_phase → post_vm_initialized → BiasedLocking::init → WatcherThread::start → return JNI_OK

---

## §六 Writing Requirements

| 不要写成 | 应该写成 |
|---------|---------|
| "VMThread 执行 VM 操作" | "`VMThread::loop()` (vmThread.cpp:465) 循环从 `_vm_queue->remove_next()` 取出 `VM_Operation`，调用 `evaluate_operation()` → `SafepointSynchronize::begin()` (arm polling page → mprotect PROT_NONE → 等待所有 JavaThread 阻塞) → `VM_Operation::doit()` → `SafepointSynchronize::end()` (disarm polling page → mprotect PROT_READ → notify_all)" |
| "初始化 Java 核心类" | "`initialize_java_lang_classes()` (thread.cpp:3822-3873) 按严格依赖顺序调用 17 次 `initialize_class()`: String→System→Class→ThreadGroup→Thread→Module→reflect.Method→ref.Finalizer→OutOfMemoryError→NullPointerException→ClassCastException→ArrayStoreException→ArithmeticException→StackOverflowError→IllegalMonitorStateException→IllegalArgumentException。每个 `initialize_class` → `SystemDictionary::resolve_or_fail` → 类加载→链接→验证→<clinit>" |
| "Signal Dispatcher 处理信号" | "`signal_thread_entry()` (os.cpp:346) 在 `os::signal_wait()` (sigwait/sigwaitinfo, man 2) 阻塞等待 OS 信号。SIGBREAK: ① lazy init AttachListener; ② `VMThread::execute(new VM_PrintThreads())` 打印栈; ③ `VMThread::execute(new VM_FindDeadlocks())` 检测死锁; ④ `JvmtiExport::post_data_dump()` JVMTI dump。非 SIGBREAK: `JavaCalls::call_static` → `jdk.internal.misc.Signal.dispatch(sig)`" |
| "call_initPhase2 初始化模块系统" | "`call_initPhase2()` (thread.cpp:3791) 通过 `JavaCalls::call_static` 调用 `java.lang.System.initPhase2(boolean, boolean)int`。返回值非 JNI_OK → `vm_exit_during_initialization()` (fatal, 无异常消息，直接 exit(1))。完成后: `java.base` 模块解析完毕，`-Xbootclasspath/a` 类可用，`universe_post_module_init()` 执行 Universe 收尾" |
| "WatcherThread 启动" | "`WatcherThread::start()` (thread.cpp:1614) 在持有 `PeriodicTask_lock` 下创建 `WatcherThread` 单例。构造函数 (thread.cpp:1477) 内调用 `os::create_thread(this, os::watcher_thread)` → 设置 `MaxPriority` (高于 VMThread 的 NearMaxPriority) → `os::start_thread`。入口 `WatcherThread::run()` 循环执行 PeriodicTask 队列: 计算最小到期时间 → sleep → 执行到期 task (StatSampler/EnableBiasedLocking/JniPeriodicChecker/MemProfiler)" |

**核心原则**:
- 每个技术断言必须标注 `file:line`
- 源码是证据（20%），原理分析是正文（80%）
- 所有函数调用用 `FunctionName()` 格式
- 所有类名用 `ClassName` 格式
- 优先使用 Mermaid 图表展示调用序列和状态机

---

## §七 Output Format

- 输出路径: `/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/11-Stages5-10-Threads-And-ClassLoading.md`
- 标题格式: `# 11-Stages5-10-Threads-And-ClassLoading — VMThread 到 Live Phase`
- Section 编号: `## §〇`, `## §一`, ..., `## §十三`
- 代码块标注语言: `cpp` (C++), `bash` (shell), `mermaid` (图表)
- 文件引用格式: `src/hotspot/share/runtime/thread.cpp:3822`

---

## §八 Prohibited（禁止行为）

1. **禁止把 prompt 的"答案方向"直接抄进文档** — prompt 是导航，源码是证据
2. **禁止缺少 file:line 引用** — 每个技术断言必须标注源文件和行号
3. **禁止跳过 counterfactual 讨论** — 每个 Question Group 必须包含至少 1 个反事实分析
4. **禁止 Callout 框放在 §一 之外** — 所有 Callout 框只能在 §一 中
5. **禁止省略 man 手册引用** — 每个 syscall/libc 函数必须标注 `man 2`/`man 3`/`man 5`
6. **禁止"购物清单"式描述** — 不能只列出线程名和优先级，必须描述每个线程的内部循环逻辑和事件处理
7. **禁止 Mermaid 图表缺失** — §四到§九每个 Section 至少 1 个 Mermaid 图表
8. **禁止跳过线程优先级对比表** — §十必须有 8 个线程的优先级对比表
9. **禁止诊断工具不完整** — jstack + strace + GDB + /proc 四件套必须覆盖全部 3 个 Production Scenario
10. **禁止 Section 编号跳号** — 完成后运行 `rg '^## §' file.md` 验证连续

---

## §九 Required（必须包含）

1. **VM_Operation 4 种执行模式对比表**（_safepoint/_no_safepoint/_concurrent/_async_safepoint + evaluate_at_safepoint + 阻塞调用者 + 典型用例）
2. **Safepoint 握手协议 Mermaid 序列图**（VMThread arm → JavaThread poll → SIGSEGV → block → VMThread operate → disarm → notify_all）
3. **17 个核心类加载依赖 Mermaid 流程图**（String→System→...→8 异常→JSR292）
4. **Signal Dispatcher 信号分发 Mermaid 序列图**（OS signal → sigwait → Signal Dispatcher → VMThread::execute → JavaCalls）
5. **ServiceThread 5 事件处理循环 Mermaid 流程图**（wait→StringTable→JVMTI→LowMemory→GCNotifier→DCmd→loop）
6. **模块系统 3 Phase 时序 Mermaid 序列图**（initPhase1→initPhase2→initPhase3→compute_java_loaders）
7. **Live Phase 到 JNI_OK Mermaid 流程图**（enter_live_phase→post_vm_initialized→BiasedLocking→WatcherThread→return JNI_OK）
8. **8 线程优先级对比表**（线程名 + 类型 + 优先级 + nice值 + 入口函数 + 创建位置 file:line）
9. **JVMTI Phase 转变时间线**（PRIMORDIAL→ONLOAD→START→LIVE + create_vm 中对应行号 + 可用 API 范围）
10. **至少 7 个 Callout 框**（只在 §一 中）
11. **至少 5 个 Counterfactual 讨论**（VM_Operation 单队列、无延迟偏向锁、无 AttachListener lazy init、Signal Dispatcher 阻塞、WatcherThread 低优先级）

---

## §十 GDB Verification（≥7 断言）

1. **VMThread 创建**: `break vmThread.cpp:250` → 进入 `VMThread::create()` → `print _vm_queue` → `print _vm_queue->_queue_length[0]` (初始为 0)
2. **VMThread::loop 取操作**: `break vmThread.cpp:465` → `print _vm_queue->_queue_length[0]` → `continue` → 验证队列长度变化
3. **Safepoint begin**: `break safepoint.cpp:156` → `print SafepointSynchronize::_state` → 验证从 `_not_synchronized` 变为 `_synchronizing`
4. **initialize_class**: `break thread.cpp:1166` → `print name` (类名字符串) → `continue` → 验证 17 个类按顺序加载
5. **Signal Dispatcher**: `break os.cpp:502` → `print "Signal Dispatcher"` → `continue` → `info threads` 确认线程已创建
6. **call_initPhase2 返回值**: `break thread.cpp:3791` → `continue` 通过 `JavaCalls::call_static` → `print return_value` → 验证 JNI_OK
7. **enter_live_phase**: `break jvmtiExport.cpp:622` → `print JvmtiEnvBase::_phase` → 验证从 `JVMTI_PHASE_START` 变为 `JVMTI_PHASE_LIVE`
8. **WatcherThread 创建**: `break thread.cpp:1477` → `print this` → `continue` → `info threads` 确认 MaxPriority 线程存在

---

## §十一 与 README 和同组 prompt 的连续性

### 与 README 的关系
- 本文覆盖 Stages 5-10 (thread.cpp:4102-4347)
- 本文覆盖线程表全部 8 个线程 (T1-T8)
- 本文覆盖 JVMTI Phase 转变 (Start→Live)
- 本文覆盖 17 个 java.lang 类加载顺序
- 本文覆盖 JSR292 核心类预加载
- 本文覆盖模块系统 initPhase2/3

### 与同组 prompt 的连续性
- **prompt-00** (JNI_CreateJavaVM): 覆盖 Stages 0-4 + init_globals 框架 → 本文从 Stage 5 接续
- **prompt-01** (CodeCache): 覆盖 codeCache_init → 本文的编译器线程使用 CodeCache
- **prompt-02** (G1 Heap): 覆盖 G1 堆初始化 → 本文的 BiasedLocking 操作在 safepoint 中执行
- **prompt-06** (Mutex): 覆盖锁系统 → 本文的 Safepoint_lock/Service_lock/PeriodicTask_lock 基于 Mutex
- **prompt-08** (G1 Policy): 覆盖 G1Policy 初始化 → 本文的 ServiceThread 处理 GCNotifier 事件
- **prompt-10** (JNIHandle-CompileQueue-JVMTI): 覆盖 CompileQueue + JVMTI 环境 → 本文的 compilation_init_phase1 创建编译器线程消费 CompileQueue

### 文档间引用
- VMThread 创建引用文档 00 (init_globals 上下文)
- 编译器线程引用文档 10 (CompileQueue)
- 锁系统引用文档 06 (Mutex)
- G1 Policy 引用文档 08 (GC 通知)
- JVMTI 环境引用文档 10 (JvmtiEnv/JvmtiExport)
