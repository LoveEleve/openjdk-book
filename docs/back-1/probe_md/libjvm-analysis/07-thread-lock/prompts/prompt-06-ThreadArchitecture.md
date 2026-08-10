# PROMPT: 请撰写 06-JVM-Thread-Architecture.md

## 一、任务

撰写一篇 550-650 行的深度 JVM 源码分析文档，主题：**JVM 17 种线程全景 — 从 Thread 基类到每个具体线程的创建、调度与生命周期**。

核心故事线：JVM 到底有多少种线程？它们之间的继承关系是什么？每个线程由谁创建、何时创建、入口函数是什么？NonJavaThread 和 JavaThread 在 safepoint 行为上的根本差异是什么？`os::create_thread()` 如何通过 ThreadType 参数统一创建所有类型的线程？所有线程的生命周期如何管理？JVM 退出时各线程如何终止？

**这篇文章的定位**：它是整个 07-thread-lock 主题的**线程体系总览篇**，为后续 [07-VMThread]、[08-WorkerThread]、[09-JavaThread-System]、[10-NonJavaThread] 四篇详细文章提供全景地图和交叉索引。读完本篇，读者应该能在脑中画出完整的继承树，知道每个线程属于哪个分支、走哪条创建链路、受什么调度约束。

**这篇文章不覆盖**：VMThread::loop() 的 STW 操作源码细节、WorkGang 的任务分发机制、ObjectMonitor 的锁协议、ThreadSMR Hazard Pointer 的完整实现——这些是 [07]/[08]/[01]/[05] 的主题。

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（Region=4MB, 2048个）
- 64 位 Linux x86

## 三、聚焦源文件

| 文件 | 类/函数 | 行号 | 本文角色 |
|------|------|:---:|---------|
| `runtime/thread.hpp` | `Thread : public ThreadShadow` 基类 | 115 | ★ 继承树根 |
| `runtime/thread.hpp` | `NonJavaThread : public Thread` | 792 | ★ NonJavaThread 分支 |
| `runtime/thread.hpp` | `NamedThread : public NonJavaThread` | 830 | 有名 NonJavaThread |
| `runtime/thread.hpp` | `WorkerThread : public NamedThread` | 858 | GC Worker 基类 |
| `runtime/thread.hpp` | `WatcherThread : public NonJavaThread` | 875 | PeriodicTask 线程 |
| `runtime/thread.hpp` | `JavaThread : public Thread` | 925 | ★ JavaThread 分支 |
| `runtime/thread.hpp` | `CodeCacheSweeperThread : public JavaThread` | 2109 | ★ Sweeper(属于JavaThread!) |
| `runtime/thread.hpp` | `CompilerThread : public JavaThread` | 2130 | ★ 编译器线程(属于JavaThread!) |
| `runtime/thread.hpp` | `Threads : AllStatic` | 2203 | ★ 全局线程管理 |
| `runtime/vmThread.hpp` | `VMThread : public NamedThread` | 114 | ★ STW 操作执行者 |
| `runtime/vmThread.cpp` | `VMThread::loop()` | 465 | VMThread 主循环 |
| `gc/shared/concurrentGCThread.hpp` | `ConcurrentGCThread : public NamedThread` | 31 | GC 并发线程基类 |
| `gc/shared/concurrentGCThread.cpp` | `ConcurrentGCThread::run()` | 82 | GC 并发线程入口 |
| `gc/g1/g1ConcurrentMarkThread.hpp` | `G1ConcurrentMarkThread : public ConcurrentGCThread` | 36 | ★ G1 CM 线程 |
| `gc/g1/g1ConcurrentMarkThread.cpp` | `G1ConcurrentMarkThread::run_service()` | 248 | CM 并发标记循环 |
| `gc/g1/g1ConcurrentRefineThread.hpp` | `G1ConcurrentRefineThread : public ConcurrentGCThread` | 37 | ★ G1 Refine 线程 |
| `gc/g1/g1ConcurrentRefineThread.cpp` | `G1ConcurrentRefineThread::run_service()` | 96 | DirtyCard→RSet 循环 |
| `gc/g1/g1YoungRemSetSamplingThread.hpp` | `G1YoungRemSetSamplingThread : public ConcurrentGCThread` | 42 | 记忆集采样线程 |
| `gc/shared/workgroup.hpp` | `AbstractGangWorker : public WorkerThread` | 257 | GC Worker 基类 |
| `gc/shared/workgroup.hpp` | `GangWorker : public AbstractGangWorker` | 279 | 具体 GC Worker 实现 |
| `gc/shared/workgroup.cpp` | `GangWorker::loop()` | 378 | GC Worker 主循环 |
| `runtime/serviceThread.hpp` | `ServiceThread : public JavaThread` | 35 | ★ Service Thread |
| `runtime/serviceThread.cpp` | `ServiceThread::initialize()` | 51 | Service Thread 创建 |
| `runtime/thread.cpp` | `Threads::create_vm()` | 3620 | ★ JVM 启动线程创建 |
| `runtime/thread.cpp` | `Threads::add()` | 4716 | JavaThread 全局注册 |
| `runtime/thread.cpp` | `Threads::remove()` | 4754 | JavaThread 全局摘除 |
| `runtime/thread.cpp` | `WatcherThread::run()` | 1553 | PeriodicTask 循环 |
| `runtime/thread.cpp` | `CompilerThread` 构造 / `compiler_thread_loop` | 3610 | 编译线程入口 |
| `runtime/thread.cpp` | `CodeCacheSweeperThread` 构造 | 3647 | Sweeper 线程构造 |
| `runtime/thread.cpp` | `VMThread::create()` 调用 | 4107 | VMThread 创建 |
| `os/linux/os_linux.cpp` | `os::create_thread()` | 965 | ★ 统一创建链路 |
| `os/linux/os_linux.cpp` | `thread_native_entry()` | 885 | ★ 线程醒来第一站 |
| `os/linux/os_linux.cpp` | `pthread_create(tid, attr, thread_native_entry, thread)` | 1031 | ★ pthread 创建 |
| `prims/jvm.cpp` | `JVM_StartThread()` | 2890 | ★ 应用线程创建入口 |
| `runtime/os.hpp` | `ThreadType` 枚举（7 种） | 486-493 | ★ 线程类型 + 栈大小 |
| `runtime/safepoint.cpp` | `SafepointSynchronize::begin()` | 156 | ★ safepoint 入口 |
| `services/attachListener.cpp` | `attach_listener_thread_entry()` | 348 | Attach Listener 入口 |
| `services/attachListener.cpp` | `new JavaThread(&attach_listener_thread_entry)` | 472 | Attach Listener 创建 |
| `runtime/os.cpp` | `signal_thread_entry()` | 346 | Signal Dispatcher 入口 |
| `runtime/os.cpp` | `new JavaThread(&signal_thread_entry)` | 502 | Signal Dispatcher 创建 |
| `runtime/sweeper.cpp` | `NMethodSweeper::sweeper_loop()` | 265 | CodeCache Sweeper 循环 |
| `java.base/java/lang/ref/Reference.java` | `ReferenceHandler` 内部类 | 190 | Reference Handler(Java层) |
| `java.base/java/lang/ref/Finalizer.java` | `FinalizerThread` 内部类 | 146 | Finalizer(Java层) |

## 四、必须深度走读的核心源码路径

### 4.1 继承体系（★★★ 全文基础，必须精确）

```
★★★ 关键发现：README 规划中将 CompilerThread/CodeCacheSweeperThread 归入 NonJavaThread 是错误的！
实际源码验证：
  - CompilerThread : public JavaThread      thread.hpp:2130  ← 是 JavaThread！
  - CodeCacheSweeperThread : public JavaThread  thread.hpp:2109  ← 是 JavaThread！
  - ServiceThread : public JavaThread       serviceThread.hpp:35  ← 是 JavaThread！

这三个线程虽然功能上属于"系统线程"，但在继承体系上属于 JavaThread 分支！
这意味着：
  ① 它们在 Threads::_thread_list 上（受 Threads_lock 保护）
  ② 它们参与 safepoint 协议（被 polling page 暂停）
  ③ 它们用 java_thread ThreadType 创建（栈大小 1MB）
  ④ jstack 能看到它们

但有一个特殊细节：
  - CompilerThread 创建时使用 compiler_thread ThreadType（栈大小 4MB！）
  - CodeCacheSweeperThread 创建时使用 java_thread ThreadType（栈大小 1MB）
  → os.hpp 注释说 java_thread 包含 "Java, CodeCacheSweeper, JVMTIAgent and Service threads"
  → 但 CompilerThread 单独用 compiler_thread 类型，获得更大栈空间（4MB vs 1MB）

完整继承树（精确行号）:

ThreadShadow : CHeapObj<mtThread>                   exceptions.hpp:60
  └── Thread                                        thread.hpp:115
      ├── NonJavaThread                             thread.hpp:792
      │   ├── NamedThread                           thread.hpp:830
      │   │   ├── VMThread                          vmThread.hpp:114
      │   │   ├── WorkerThread                      thread.hpp:858
      │   │   │   └── AbstractGangWorker            workgroup.hpp:257
      │   │   │       └── GangWorker                workgroup.hpp:279
      │   │   └── ConcurrentGCThread                concurrentGCThread.hpp:31
      │   │       ├── G1ConcurrentMarkThread        g1ConcurrentMarkThread.hpp:36
      │   │       ├── G1ConcurrentRefineThread      g1ConcurrentRefineThread.hpp:37
      │   │       └── G1YoungRemSetSamplingThread   g1YoungRemSetSamplingThread.hpp:42
      │   └── WatcherThread                         thread.hpp:875
      └── JavaThread                                thread.hpp:925
          ├── [应用线程] main / 用户线程             通过 JVM_StartThread 创建
          ├── ServiceThread                          serviceThread.hpp:35
          ├── CodeCacheSweeperThread                 thread.hpp:2109
          └── CompilerThread                         thread.hpp:2130
```

### 4.2 NonJavaThread 家族（7 个线程，精确到创建位置和入口函数）

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  线程名                    类                创建位置                      入口函数                        ThreadType
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
① VM Thread                 VMThread          thread.cpp:4107              VMThread::loop()               vm_thread
                                                               vmThread.hpp:114               vmThread.cpp:465

② GC Worker#0               GangWorker        workgroup.cpp 中              GangWorker::loop()             gc_thread
   (G1 ParGC Thread)                           WorkGang::initialize_workers  workgroup.cpp:378

③ G1 Main Marker             G1Concurrent-     g1CollectedHeap.cpp 中        run_service()                  cgc_thread
                              MarkThread       G1CollectedHeap::initialize   g1ConcurrentMarkThread.cpp:248

④ G1 Conc#0                  G1Concurrent-     g1ConcurrentRefine.cpp 中     run_service()                  cgc_thread
                              RefineThread     G1ConcurrentRefine::init      g1ConcurrentRefineThread.cpp:96

⑤ G1 Refine#0                同上              同上                          同上                            cgc_thread
   (可能有多个, #0-#N)

⑥ G1 Young RemSet            G1YoungRemSet-    g1CollectedHeap.cpp 中        run_service()                  cgc_thread
   Sampling                   SamplingThread    create_sampling_thread

⑦ VM Periodic Task           WatcherThread     thread.cpp:4140              WatcherThread::run()           watcher_thread
   Thread                                      WatcherThread::start()       thread.cpp:1553
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

★★★ 关键约束：所有 NonJavaThread 不在 Threads::_thread_list 上！
  - NonJavaThread 有自己的单链表: NonJavaThread::_next (thread.hpp:795)
  - 通过 NonJavaThread::Iterator 遍历（thread.hpp:813）
  - 不受 Threads_lock 保护，不参与 ThreadSMR Hazard Pointer
  - 但它们被 VMThread 在 safepoint 期间"约定"不获取竞争锁
```

### 4.3 JavaThread 家族（10 个系统线程 + N 个应用线程）

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  线程名                类                    创建位置                          入口函数                  守护  ThreadType
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1  main                  JavaThread(应用)      thread.cpp:3620                 user Java run()           ✗    java_thread
                                               Threads::create_vm()

2  Reference Handler     JavaThread(应用)      Reference.java:297              ReferenceHandler.run()    ✓    java_thread
                                               (Java层 new ReferenceHandler)   (Java while 循环)

3  Finalizer             JavaThread(应用)      Finalizer.java:184              FinalizerThread.run()     ✓    java_thread
                                               (Java层 new FinalizerThread)    (Java while 循环)

4  Signal Dispatcher     JavaThread(系统)      os.cpp:502                      signal_thread_entry()     ✓    java_thread
                                               os::initialize_jdk_signal_support

5  Service Thread        ServiceThread         serviceThread.cpp:51            service_thread_entry()    ✓    java_thread
                                               ServiceThread::initialize()

6  C1 CompilerThread     CompilerThread        compileBroker.cpp 中            compiler_thread_loop()    ✓    compiler_thread
                                               CompileBroker::init_compiler_   compileBroker.cpp:1828
                                               threads_synchronously

7  C2 CompilerThread     CompilerThread        同上                            同上                       ✓    compiler_thread

8  Sweeper thread        CodeCacheSweeper-     compileBroker.cpp 中            NMethodSweeper::          ✓    java_thread
                          Thread               make_compilable_thread          sweeper_loop()
                                                                               sweeper.cpp:265

9  Common-Cleaner        JavaThread(应用)      Java 层 Cleaner 机制            Cleaner.run()             ✓    java_thread
                                               (java.lang.ref.Cleaner)

10 Attach Listener       JavaThread(系统)      attachListener.cpp:472          attach_listener_thread_   ✓    java_thread
                                               AttachListener::init            entry()
                                                                               attachListener.cpp:348
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

★★★ 关键约束：所有 JavaThread 在 Threads::_thread_list 上！
  - 通过 Threads::add() 注册（thread.cpp:4716）
  - 受 Threads_lock 保护
  - 参与 ThreadSMR Hazard Pointer 协议
  - 参与 safepoint 协议（轮询 polling page）

★★★ startup 分类：
  启动期线程（create_vm 中创建）：
    ① main 线程 — Threads::create_vm 中 first
    ② Signal Dispatcher — create_vm 末尾 os::initialize_jdk_signal_support
    ③ Service Thread — create_vm 末尾 ServiceThread::initialize
    ④ VMThread — create_vm 中 VMThread::create (line 4107)

  延迟触发线程（运行时按需创建）：
    ⑤ Reference Handler — Java 层 Reference 类初始化时
    ⑥ Finalizer — Java 层 Finalizer 类初始化时
    ⑦ C1/C2 Compiler — 首次编译请求时 CompileBroker 触发
    ⑧ Sweeper — 编译器初始化时创建
    ⑨ Attach Listener — 收到 SIGQUIT 信号或 -XX:+StartAttachListener 时
    ⑩ Common-Cleaner — Java 层 Cleaner 使用时

★★★ 守护标记：
  main 是唯一 non-daemon JavaThread！
  → main 退出 → 最后一个 non-daemon 结束 → notify Threads_lock → destroy_vm
```

### 4.4 线程创建统一链路（所有线程共享 `os::create_thread`）

```
所有 JVM 线程（无论 JavaThread 还是 NonJavaThread）最终都走同一条创建链路:

JavaThread 路径:
  JVM_StartThread() / ServiceThread::initialize() / CompilerThread 构造
    → new JavaThread(entry_point, stack_size)
    → os::create_thread(this, thr_type, stack_size)        os_linux.cpp:965

NonJavaThread 路径:
  VMThread::create() / WorkGang::initialize_workers() / ConcurrentGCThread 构造
    → new XxxThread()
    → os::create_thread(this, thr_type, stack_size)        os_linux.cpp:965

★★★ 统一创建链路:
os::create_thread(Thread* thread, ThreadType thr_type, size_t stack_size)  os_linux.cpp:965
  → new OSThread(NULL, NULL)          ★ OS 层线程结构
  → osthread->set_thread_type(thr_type)
  → thread->set_osthread(osthread)    ★ Thread ↔ OSThread 关联
  → pthread_attr_init(&attr)
  → pthread_attr_setdetachstate(PTHREAD_CREATE_DETACHED)  ★ 不用 pthread_join
  → 计算栈大小: get_initial_stack_size(thr_type, req)
     ┌────────────────────────────────────────────────────┐
     │ ThreadType      │ 栈大小         │ 用途            │
     ├─────────────────┼───────────────┼─────────────────┤
     │ java_thread     │ 1MB (-Xss)    │ 应用+Service    │
     │ compiler_thread │ 4MB           │ C1/C2 编译器    │
     │ vm_thread       │ 512KB         │ VMThread        │
     │ cgc_thread      │ 512KB         │ GC 并发线程     │
     │ pgc_thread      │ 512KB         │ GC 并行线程     │
     │ watcher_thread  │ 512KB         │ WatcherThread   │
     │ os_thread       │ 512KB         │ (未使用?)       │
     └─────────────────┴───────────────┴─────────────────┘
  → pthread_attr_setstacksize(stack_size + guard_size)
  → pthread_create(&tid, &attr, thread_native_entry, thread)  line:1031
     → 最多重试 3 次 (EAGAIN)
  → 等待子线程初始化完成（handshake 协议）

★★★ thread_native_entry — 所有线程的醒来入口:
thread_native_entry(Thread* thread)               os_linux.cpp:885
  → thread->set_self_raw_id(os::current_thread_id())
  → ThreadLocalStorage::set_thread(thread)  ★ TLS: pthread_setspecific
  → osthread->set_state(INITIALIZED)        ★ 通知父线程
  → sync_with_child->notify()               ★ 唤醒 create_thread 中等待的父线程
  → sync_with_child->wait()                 ★ 等待 os::start_thread()
  → osthread->set_state(RUNNABLE)
  → thread->call_run()                      thread.cpp:427
    → this->run()  ★★★ 虚函数分发！
      → [JavaThread]           JavaThread::run()        → thread_main_inner → entry_point
      → [VMThread]             VMThread::run()          → loop()
      → [WatcherThread]        WatcherThread::run()     → PeriodicTask 循环
      → [ConcurrentGCThread]   ConcurrentGCThread::run() → run_service()
      → [GangWorker]           GangWorker::loop()       → WorkGang 任务循环
```

### 4.5 Safepoint 行为三分类

```
★★★ Safepoint 期间三类线程的行为差异（源码级精确）:

① JavaThread — 被暂停
   暂停机制: SafepointSynchronize::begin() (safepoint.cpp:156)
     → 设置 polling page 为不可读 (mprotect PROT_NONE)
     → JavaThread 在以下位置轮询 polling page:
       - 方法返回前 (TemplateInterpreter)
       - 循环回边 (CompiledCode)
       - JNI 调用返回时
     → 触发 SIGSEGV → 信号处理器调用 SafepointSynchronize::block()
   状态检查: VMThread 无锁读取 JavaThread::_thread_state (volatile jint)
     → _thread_in_Java / _thread_in_vm → 等待到 _thread_blocked / _thread_in_native
     → _thread_in_native → 安全（不操作堆），不暂停，标记为 _thread_blocked_safepoint
   ★ 关键: VMThread 是 _thread_state 的"隐藏读者"——无锁读取！

② NonJavaThread 有锁 — 自行约定
   包括: VMThread 自身、持有 Mutex 的 NonJavaThread
   约定: NonJavaThread 不在 safepoint 期间获取竞争锁（Lock Ranking 保证）
   实际: VMThread 执行 STW 操作时，其他 NonJavaThread 如果持有低秩锁
         → 不受影响，继续并发执行
         → 但它们不操作 Java 堆（NonJavaThread 的设计约束）

③ NonJavaThread 无锁 — 不受影响
   包括: WatcherThread、ConcurrentGCThread 子类、GangWorker
   行为: safepoint 期间继续并发执行
   安全性: 它们不操作 Java 堆中的 oop（或使用 SafepointSynchronize::verify_heap）
         → 不需要暂停

★★★ 对比表:
┌──────────────┬──────────┬─────────────────┬──────────────────────┐
│ 线程类型      │ 暂停机制  │ polling page    │ _thread_state 检查   │
├──────────────┼──────────┼─────────────────┼──────────────────────┤
│ JavaThread   │ 被动暂停  │ 轮询 + SIGSEGV  │ VMThread 无锁读取    │
│ NonJava有锁  │ 自行约定  │ 不轮询          │ 不检查               │
│ NonJava无锁  │ 不暂停    │ 不轮询          │ 不检查               │
└──────────────┴──────────┴─────────────────┴──────────────────────┘
```

### 4.6 双链表结构 + NonJavaThread 单链表

```
★★★ JVM 维护三套线程数据结构:

① Threads::_thread_list — JavaThread 双向链表
   声明: static JavaThread* _thread_list;        thread.hpp
   插入: Threads::add() — LIFO，插入头部   thread.cpp:4716
   删除: Threads::remove()                   thread.cpp:4754
   保护: Threads_lock (Mutex)
   遍历者: GC Root Scanning, jstack, JVMTI
   ★ 包含所有 JavaThread（含 CompilerThread/Sweeper/ServiceThread）

② ThreadsSMRSupport::_java_thread_list — ThreadsList 快照数组
   类型: ThreadsList* (CHeapObj, 内含 JavaThread* _threads[N])
   更新: add_thread / remove_thread — 创建新快照，原子交换
   保护: Hazard Pointer（无锁读取）
   遍历者: 无锁遍历者（ThreadsListHandle RAII）
   ★ 详见 [05-JVM-Thread-Lifecycle] §六

③ NonJavaThread::_next — NonJavaThread 单链表
   声明: NonJavaThread* volatile _next;          thread.hpp:795
   插入: NonJavaThread 构造函数中 register_thread_with_stack()
   删除: NonJavaThread 析构函数中
   保护: NonJavaThread_list_lock (Mutex)
   遍历者: NonJavaThread::Iterator (thread.hpp:813)
   ★ 不在 _thread_list 上，不受 Threads_lock 保护
```

## 五、文章结构

```
§〇 源文件清单（15+ 文件表格，跨 runtime/gc/os/prims/java.base 模块）

§一 17 种线程全景 — 为什么要先看全景？
  ❓ 为什么需要理解线程全景？
  1.1 数量级直觉 — 17 线程 = 7 NonJavaThread + 10 JavaThread 系统线程 + N 应用线程
  1.2 两大分支的本质差异 — 被 safepoint 暂停 vs 不被暂停
  1.3 本文定位 — 全景地图，为 [07]-[10] 提供导航

§二 完整 Mermaid 继承树 ★★★（核心，100+ 行）
  2.1 精确继承树 — 每个节点标注 `class X : public Y` 文件:行号
  2.2 Mermaid 继承图
  2.3 ★★★ 关键发现纠正：CompilerThread / CodeCacheSweeperThread / ServiceThread 继承自 JavaThread！
      ❓ 为什么它们是 JavaThread 而不是 NonJavaThread？
      → 它们需要执行 Java 代码（JIT编译/CodeCache清扫/低优先级服务）
      → 需要参与 safepoint 协议（可能持有 oop 引用）
      → 用 java_thread / compiler_thread ThreadType 创建

§三 NonJavaThread 家族（7 类）★★★（核心，120+ 行）
  3.1 VMThread — `VMThread::loop()` → STW 操作唯一执行者
      创建: thread.cpp:4107 VMThread::create()
      入口: vmThread.cpp:465 VMThread::loop()
      ThreadType: vm_thread, 栈: 512KB
  3.2 GC Worker (G1 ParGC Thread#0) — `GangWorker::loop()` → WorkGang 并行任务
      创建: WorkGang::initialize_workers()
      入口: workgroup.cpp:378 GangWorker::loop()
      ThreadType: pgc_thread, 栈: 512KB
  3.3 G1 Main Marker — `G1ConcurrentMarkThread::run_service()` → CM 并发标记
      创建: G1CollectedHeap::initialize()
      入口: g1ConcurrentMarkThread.cpp:248 run_service()
      ThreadType: cgc_thread, 栈: 512KB
  3.4 G1 Conc#0 / G1 Refine#0 — `G1ConcurrentRefineThread::run_service()` → DirtyCard→RSet
      创建: G1ConcurrentRefine::init()
      入口: g1ConcurrentRefineThread.cpp:96 run_service()
      ThreadType: cgc_thread, 栈: 512KB
  3.5 G1 Young RemSet Sampling — 记忆集采样
      创建: G1CollectedHeap::create_sampling_thread()
      入口: run_service()
      ThreadType: cgc_thread, 栈: 512KB
  3.6 VM Periodic Task Thread — `WatcherThread::run()` → PeriodicTask 框架
      创建: thread.cpp:4140 WatcherThread::start()
      入口: thread.cpp:1553 WatcherThread::run()
      ThreadType: watcher_thread, 栈: 512KB
  3.7 ★ 关键约束: NonJavaThread 不在 Threads::_thread_list 上
      → NonJavaThread::_next 单链表 (thread.hpp:795)
      → NonJavaThread::Iterator (thread.hpp:813)
      → 不受 Threads_lock 保护
      → 不参与 safepoint 协议

§四 JavaThread 家族（10 系统线程 + N 应用线程）★★★（核心，120+ 行）
  4.1 main — 唯一 non-daemon，退出触发 JVM 关闭
      创建: thread.cpp:3620 Threads::create_vm()
      入口: 用户 Java run()
  4.2 Reference Handler — 处理 pending Reference 队列
      创建: Reference.java:297 (Java 层)
      入口: ReferenceHandler.run() (Java while 循环)
  4.3 Finalizer — 执行对象 finalize()
      创建: Finalizer.java:184 (Java 层)
      入口: FinalizerThread.run() (Java while 循环)
  4.4 Signal Dispatcher — 处理 OS 信号
      创建: os.cpp:502 os::initialize_jdk_signal_support()
      入口: signal_thread_entry() (os.cpp:346)
  4.5 Service Thread — JVMTI 延迟事件 + hashtable 清理
      创建: serviceThread.cpp:51 ServiceThread::initialize()
      入口: service_thread_entry()
      ★ 继承自 JavaThread (serviceThread.hpp:35)
  4.6 C1/C2 CompilerThread — JIT 编译
      创建: CompileBroker::init_compiler_threads_synchronously()
      入口: compiler_thread_loop() (compileBroker.cpp:1828)
      ★ 继承自 JavaThread (thread.hpp:2130)
      ★ ThreadType: compiler_thread, 栈: 4MB（最大！）
  4.7 Sweeper thread — CodeCache 方法清扫
      创建: CompileBroker 中 make_compilable_thread
      入口: NMethodSweeper::sweeper_loop() (sweeper.cpp:265)
      ★ 继承自 JavaThread (thread.hpp:2109, CodeCacheSweeperThread)
  4.8 Common-Cleaner — java.lang.ref.Cleaner
      创建: Java 层 Cleaner 机制
  4.9 Attach Listener — jcmd/jmap 诊断连接
      创建: attachListener.cpp:472 AttachListener::init()
      入口: attach_listener_thread_entry() (attachListener.cpp:348)
  4.10 ★ 关键约束: 所有 JavaThread 在 Threads::_thread_list 上
       → Threads::add() 注册 (thread.cpp:4716)
       → 受 Threads_lock 保护
       → 参与 safepoint 协议

  ★★★ startup 时序图（Mermaid）:
     create_vm() 开始
       → main 线程 (首个 JavaThread)
       → VMThread::create() (首个 NonJavaThread)
       → WatcherThread::start()
       → Signal Dispatcher
       → Service Thread
       → ... (延迟创建的线程在运行时触发)

§五 线程创建统一链路 ★★★（核心，80+ 行）
  5.1 os::create_thread — ThreadType 参数决定栈大小
      ❓ 为什么 CompilerThread 需要 4MB 栈？
      → JIT 编译是递归过程，编译一个方法可能触发另一个编译（内联/逃逸分析）
      → 递归深度可达数百层，1MB 栈不够
  5.2 thread_native_entry — 虚函数 run() 多态分发
      ★ 每种线程的 run() 实现 → 对应的入口函数
  5.3 JavaThread vs NonJavaThread 的创建差异
      JavaThread: new JavaThread(entry_point) → entry_point 是函数指针
      NonJavaThread: new XxxThread() → 重写 run() 虚函数

§六 Safepoint 行为三分类 + 隐藏读者 ★★★（核心，60+ 行）
  6.1 JavaThread — 被暂停，轮询 polling page
  6.2 NonJavaThread 有锁 — 自行约定（Lock Ranking）
  6.3 NonJavaThread 无锁 — 不受影响
  ❓ 为什么 VMThread 要无锁读取 _thread_state？
     → safepoint 是高频操作（每次 GC 都要 STW）
     → 如果用 Mutex 保护 _thread_state → 所有 JavaThread 的状态转换都要持锁
     → 热路径性能退化 → 用 volatile + fence 代替（参见 [05] §四 4.2）
  ★ 预告: [05-JVM-Thread-Lifecycle] transition_and_fence 的 fence 语义来自此处

§七 17 线程生命周期总表 ★★★（核心，60+ 行）
  7.1 每线程: 谁创建 / 创建位置(文件:行号) / 能否终止 / 终止后影响
  7.2 JVM 退出策略: 最后一个 non-daemon → destroy_vm → 通知守护线程
  7.3 NonJavaThread 终止: should_terminate()=true → 跳出循环

§八 jstack 实测对照（30+ 行）
  8.1 jstack 17 线程逐一对应源码创建位置
  8.2 验证 10 JavaThread + 7 NonJavaThread = 17
  8.3 验证所有 NonJavaThread WCHAN=futex_wait_queue
  8.4 验证 main 是唯一 non-daemon JavaThread

§九 GDB 验证 + 可证伪断言（≥8 条）
```

## 六、风格要求

1. **❓ "为什么"驱动**: 至少 10 处
   - §一: 为什么需要理解线程全景？
   - §二: 为什么 CompilerThread/SweeperThread 继承 JavaThread 而不是 NonJavaThread？
   - §三: 为什么 NonJavaThread 不在 _thread_list 上？
   - §四: 为什么 main 是唯一 non-daemon？
   - §五: 为什么 CompilerThread 需要 4MB 栈？
   - §五: 为什么所有线程共用 os::create_thread？
   - §六: 为什么 VMThread 要无锁读取 _thread_state？
   - §六: 为什么 NonJavaThread 不需要参与 safepoint 协议？
   - §七: 为什么 JVM 退出取决于最后一个 non-daemon？
   - §七: 为什么 NonJavaThread 通过 should_terminate() 而不是 interrupt 终止？

2. **粒度显式标注**: 每个字段标粒度（Thread*/intptr_t/jint/oop/address），禁止模糊
3. **源码行号**: 每段源码标 `file:line` 格式
4. **精确函数走读**: 关键函数（os::create_thread, thread_native_entry, 各线程的 run()）逐行注释源码
5. **可证伪断言 ≥8 条**: 每条有 GDB 命令 + 预期值
6. **不低于 550 行、不超过 650 行**
7. **禁止编造函数名**: 所有函数名来自源码
8. **Mermaid ≥3 张**: 继承树 + startup 时序图 + safepoint 三分类流程图
9. **对比表 ≥4 张**: NonJavaThread 7类详细表 / JavaThread 10系统线程表 / ThreadType栈大小表 / Safepoint三类行为对比表
10. **交叉引用 ≥5 处**: 标注 [01-ObjectMonitor] / [05-Thread-Lifecycle] / [07-VMThread] / [08-WorkerThread] / [09-JavaThread-System] / [10-NonJavaThread]

## 七、关键"为什么"预期答案

| ❓ 问题 | 核心洞察 |
|---------|---------|
| 为什么需要理解线程全景？ | 后续7篇文章（01-05+07-10）都涉及具体线程类型，不理解全景就无法理解哪些线程参与safepoint、哪些线程持有锁、哪些线程操作堆 |
| 为什么 CompilerThread/Sweeper/ServiceThread 继承 JavaThread？ | 它们需要执行 Java 代码或持有 oop 引用 → 必须参与 safepoint 协议 → 必须是 JavaThread → 必须在 _thread_list 上。NonJavaThread 的设计约束是"不操作 Java 堆"，编译器/Sweeper 违背这个约束 |
| 为什么 NonJavaThread 不在 _thread_list 上？ | _thread_list 是 safepoint 协议的遍历目标——NonJavaThread 不需要被暂停，放在上面只会增加遍历开销和 Threads_lock 竞争 |
| 为什么 main 是唯一 non-daemon？ | main 线程代表"用户程序还在运行"。所有系统线程都是 daemon——它们的存在是为了服务用户程序。用户程序结束 = main 退出 → 没有需要服务的对象 → JVM 退出 |
| 为什么 CompilerThread 需要 4MB 栈？ | JIT 编译是递归过程（内联→逃逸分析→理想图→代码生成），递归深度可达数百层。1MB 栈在极端情况下会 StackOverflow，导致编译失败 |
| 为什么所有线程共用 os::create_thread？ | 底层都是 pthread_create → clone()。差异仅在于 ThreadType（决定栈大小）和 run() 虚函数（决定入口）。统一接口简化维护，避免重复代码 |
| 为什么 VMThread 要无锁读取 _thread_state？ | safepoint 是高频操作（每次 GC 都要 STW）。如果用 Mutex 保护 _thread_state → 所有 JavaThread 的状态转换都要持锁 → 热路径性能退化。volatile + fence 是更轻量的方案 |
| 为什么 NonJavaThread 不需要参与 safepoint？ | NonJavaThread 不操作 Java 堆中的 oop（或使用安全接口），因此不需要暂停。如果强制暂停反而增加 safepoint 延迟 |
| 为什么 JVM 退出取决于 non-daemon？ | daemon 线程的语义就是"后台服务"——JVM 不需要等它们完成。只要所有用户线程（non-daemon）退出，JVM 就可以安全关闭 |
| 为什么 NonJavaThread 用 should_terminate() 终止？ | NonJavaThread 的主循环是 while(!should_terminate()) → 设置标志位即可让线程自行退出循环。不使用 pthread_cancel/interrupt 因为太暴力，可能导致资源泄漏 |

## 八、可证伪断言（≥8 条）

| # | 断言 | 验证 |
|---|------|------|
| 1 | CompilerThread 继承自 JavaThread | GDB: `ptype CompilerThread` → `JavaThread` 出现在继承链中 |
| 2 | CodeCacheSweeperThread 继承自 JavaThread | GDB: `ptype CodeCacheSweeperThread` → 包含 JavaThread |
| 3 | ServiceThread 继承自 JavaThread | GDB: `ptype ServiceThread` → 包含 JavaThread |
| 4 | NonJavaThread 不在 Threads::_thread_list 上 | GDB: `p Threads::_thread_list` → 遍历链表，无 NonJavaThread |
| 5 | VMThread 使用 vm_thread ThreadType | GDB: `break os_linux.cpp:965` → VMThread 创建时 `p thr_type` = 0 (vm_thread) |
| 6 | CompilerThread 栈大小 = 4MB | GDB: `break os_linux.cpp:965` → CompilerThread 创建时 `p req_stack_size` ≈ 4194304 |
| 7 | NonJavaThread 有独立 _next 链表 | GDB: `p ((NonJavaThread*)0xNNN)->_next` → 指向下一个 NonJavaThread |
| 8 | Threads::add() LIFO 插入头部 | GDB: `break thread.cpp:4716` → 创建 2 个线程后 `p Threads::_thread_list` → 指向最新创建的 |
| 9 | WatcherThread 使用 watcher_thread ThreadType | GDB: `break os_linux.cpp:965` → WatcherThread 创建时 `p thr_type` = 5 |
| 10 | main 是唯一 non-daemon | GDB: 遍历 _thread_list → `p ((JavaThread*)thr)->is_daemon()` → 仅 main 为 false |
| 11 | ThreadSMR 快照长度 = JavaThread 数量（不含 NonJavaThread） | GDB: `p ThreadsSMRSupport::_java_thread_list->_length` → 等于 _thread_list 中 JavaThread 个数 |
| 12 | GangWorker 继承路径: GangWorker→AbstractGangWorker→WorkerThread→NamedThread→NonJavaThread→Thread | GDB: `ptype GangWorker` → 验证完整继承链 |

## 九、输出格式

- Markdown 文件，命名为 `06-JVM-Thread-Architecture.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/07-thread-lock/`
- 元信息头（标准环境 + 源文件 + 前置 + 关联 + 阅读收益）
- 章节 `## §X` / `### X.X`
- 代码块 ` ```cpp `，Mermaid ` ```mermaid `
- 继承链 ASCII 树 + Mermaid 双重展示
