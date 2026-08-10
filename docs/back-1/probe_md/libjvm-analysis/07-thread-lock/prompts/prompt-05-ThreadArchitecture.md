# PROMPT: 请撰写 05-JVM-Thread-Lifecycle.md

## 一、任务

撰写一篇 500-550 行的深度 JVM 源码分析文档，主题：**JavaThread 的一生：从 `new Thread().start()` 到 `smr_delete()`**。

核心故事线：一个 JavaThread 如何被创建（`JVM_StartThread` → `os::create_thread` → `pthread_create` → `clone()`）、醒来后第一个函数做了什么（`thread_native_entry` → `Thread::current()` TLS → `call_run()` → `run()` 虚函数分发）、初始化过程（`JavaThread::run` — TLAB、栈保护页、状态转换 fence）、★★★ **三套状态系统的关系**（`JavaThreadState` vs `java.lang.Thread.State` vs `OSThread::ThreadState` — 它们分别存在哪、谁修改、为什么需要三套）、执行 Java 代码（`thread_main_inner` → `entry_point`）、结束时如何退出（`JavaThread::exit` — `ensure_join`、`omFlush`、锁处理）、以及退出后为什么不能直接 `delete`（ThreadSMR Hazard Pointers 完整协议：两套链表、快照替换、`is_a_protected_JavaThread` 源码、tag bit 并发认领、`smr_delete` 等待循环、竞态场景时序）。

**这篇文章不覆盖**：VMThread 的 `loop()` 源码、Lock Ranking 体系、safepoint `begin/end` 细节、各个具体线程类型的逐个分析。这些是后续文章的主题。

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（Region=4MB, 2048个）
- 64 位 Linux x86

## 三、聚焦源文件

| 文件 | 类/函数 | 行号 | 本文角色 |
|------|------|:---:|---------|
| `utilities/exceptions.hpp` | `ThreadShadow : CHeapObj<mtThread>` | 60 | 继承顶层 |
| `thread.hpp` | `Thread` 基类（`_osthread`, `_ParkEvent`, `_polling_page`） | 115 | ★ 基类 |
| `thread.hpp` | `NonJavaThread`（`_next` 单链表） | 792 | 分叉背景 |
| `thread.hpp` | `JavaThread`（`_thread_state`, `_threadObj`, `_next`, `_anchor`...） | 925 | ★ 主角 |
| `prims/jvm.cpp` | `JVM_StartThread()` | 2890 | ★ 创建入口 |
| `os/linux/os_linux.cpp` | `os::create_thread()`（`pthread_create` → `clone`） | 965 | ★ 唯一创建实现 |
| `os/linux/os_linux.cpp` | `thread_native_entry()`（pthread 回调） | ~900 | ★ 醒来第一站 |
| `runtime/thread.cpp` | `Thread::start()` → `os::start_thread()` | 564 | 启动调度 |
| `runtime/thread.cpp` | `Thread::call_run()` → 虚函数 `run()` 多态分发 | 427 | ★ 分发 |
| `runtime/thread.cpp` | `JavaThread::run()` — 初始化 | 1927 | ★ 生命周期 |
| `runtime/thread.cpp` | `JavaThread::thread_main_inner()` → `entry_point()` | 1967 | ★ 执行 Java |
| `runtime/thread.cpp` | `JavaThread::exit(bool, ExitType)` — 退出清理 | 2015 | ★ 退出 |
| `runtime/thread.cpp` | `Threads::add(JavaThread*, bool)` — 全局链表注册 | 4716 | ★ 注册 |
| `runtime/thread.cpp` | `Threads::remove(JavaThread*, bool)` — 全局链表摘除 | 4754 | ★ 摘除 |
| `runtime/threadSMR.hpp` | `ThreadsSMRSupport : AllStatic` | 88 | SMR 接口 |
| `runtime/threadSMR.hpp` | `ThreadsList : CHeapObj<mtThread>` | 158 | 快照数组 |
| `runtime/threadSMR.hpp` | `ThreadsListHandle : StackObj`（RAII） | 272 | ★ 读取者保护 |
| `runtime/threadSMR.cpp` | `add_thread(JavaThread*)` | 751 | 快照创建 |
| `runtime/threadSMR.cpp` | `remove_thread(JavaThread*)` | 928 | 快照移除 |
| `runtime/threadSMR.cpp` | `smr_delete(JavaThread*)` | 955 | ★ 延迟释放循环 |
| `runtime/threadSMR.cpp` | `is_a_protected_JavaThread(JavaThread*)` | 861 | ★ Hazard 检查 |
| `os/linux/osThread_linux.hpp` | `OSThread` — `_thread_id`, `_state` | — | OS 层状态 |
| `share/runtime/osThread.hpp` | `OSThread::ThreadState` 枚举（9 种） | 44-54 | OS 层状态定义 |
| `globalDefinitions.hpp` | `JavaThreadState` 枚举（12 种状态） | 890 | C++ 状态机 |
| `share/classes/java/lang/Thread.java` | `threadStatus` 字段 + `State` 枚举 | — | Java 层状态 |

## 四、必须深度走读的核心源码路径

### 4.1 创建链路（逐函数走读，不能跳过）

```
Java 层: new Thread().start()
  → Thread.start0()                         (Java native)
    → JVM_StartThread()                      jvm.cpp:2890
      → ❓ 为什么必须在 Threads_lock 保护下创建？
         → 答案：safepoint 期间 VMThread 遍历 _thread_list 收集需暂停的线程
         → 如果 JavaThread 已创建但未注册 → safepoint 漏掉它 → 堆损坏
      → MutexLocker mu(Threads_lock)        ★ 持有全局锁
      → 检查 java.lang.Thread.threadStatus  （防重复启动）
      → 读取 java.lang.Thread.stackSize      （-Xss 配置）
      → new JavaThread(&thread_entry, sz)    ★ C-Heap(mtThread) 分配
        JavaThread 构造函数内部（必须展开）:
          → Thread::Thread() 基类构造:
            |_ 分配 _ParkEvent / _SleepEvent / _MutexEvent (ParkEvent* x3)
            |_ 分配 _SR_lock (Monitor*)
            |_ _thread_state = _thread_new (=2)
          → set_entry_point(&thread_entry)    _entry_point 保存用户回调
          → 初始化 _jni_environment           JNI 环境关联
          → _satb_mark_queue.initialize()     G1 SATB 缓冲区
          → _dirty_card_queue.initialize()    G1 DirtyCard 缓冲区
      → native_thread->prepare(jthread)      ★ 双向关联
        → java_lang_Thread::set_thread(threadObj, native_thread)  ★ Java→C++
        → native_thread->_threadObj = threadObj                   ★ C++→Java
      → Thread::start(native_thread)         thread.cpp:564
        → java_lang_Thread::set_thread_status(RUNNABLE)
        → os::start_thread(thread)           ★ → os::create_thread

os::create_thread(Thread*, ThreadType, size_t)  os_linux.cpp:965
  → new OSThread(NULL, NULL)      ★ OS 层线程结构（_thread_id, _state）
  → osthread->set_thread_type(thr_type)
     ★ 4 种 ThreadType 的枚举值：java_thread / vm_thread / cgc_thread / watcher_thread
  → thread->set_osthread(osthread)       ★ Thread ↔ OSThread 单向关联
  → pthread_attr_init(&attr)
  → pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED)
     ★ ❓ 为什么 DETACHED 而不是 JOINABLE？
        → JVM 有自己的 join 机制：ensure_join() 用 java.lang.Thread 对象的 monitor 做 wait/notify
        → DETACHED = 线程退出时 pthread 资源自动回收，不泄漏
        → 面试追问："那 pthread 返回值怎么获取？" → 不获取，JVM 不在乎
  → 计算栈大小：get_initial_stack_size(thr_type, req)
     JavaThread=1MB(默认 -Xss), CompilerThread=4MB, GC/Watcher=512KB
  → pthread_attr_setstacksize(&attr, stack_size + guard_size)
  → pthread_create(&tid, &attr, thread_native_entry, thread)  ★ 最多重试 3 次(EAGAIN)
     ❓ 为什么会有 EAGAIN？→ ulimit -u 上限或 vm.max_map_count 不足导致 clone() 失败
     失败时抛 OutOfMemoryError("unable to create new native thread")

pthread_create 内部:
  → clone(CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND |
          CLONE_THREAD | CLONE_SYSVSEM | CLONE_SETTLS |
          CLONE_PARENT_SETTID | CLONE_CHILD_CLEARTID, ...)
    ❓ 这些 flags 各自的作用（逐一解释）:
      CLONE_VM      — 共享地址空间（否则无法访问 JVM 堆/Metaspace）
      CLONE_FS      — 共享 cwd、umask、root（否则 chdir 只影响父线程）
      CLONE_FILES   — 共享 fd 表（否则 file descriptor 泄漏/不可见）
      CLONE_SIGHAND — 共享信号处理器表（否则 sigaction 只对父线程生效）
      CLONE_THREAD  — 同一线程组（tgid 相同 → ps 显示为同一进程的多线程）
      CLONE_SETTLS  — 新线程有独立的 TLS（pthread_setspecific/__thread）
  → 内核 LWP 诞生 — 1 JavaThread = 1 pthread = 1 LWP (1:1 模型)
```

### 4.2 线程醒来后（thread_native_entry → call_run → run）

```
新线程在 clone() 后的第一个 C 函数:
  thread_native_entry(thread)             os_linux.cpp:~900

    ★★★ 第一步：建立身份
    → thread->set_self_raw_id(os::current_thread_id())
    → ThreadLocalStorage::set_thread(thread)
       ❓ 怎么实现的？
       → pthread_setspecific(Thread::_thr_current_key, thread)
       → 之后任何位置调用 Thread::current() → pthread_getspecific(_thr_current_key)
       → 这就是为什么 JVM 代码（包括信号处理器）能随时知道"我是谁"
    → 设置 os::current_thread_id() 相关字段

    → thread->call_run()                  thread.cpp:427
      → register_thread_stack_with_NMT()  NMT 栈内存追踪
      → MACOS_AARCH64_ONLY(this->init_wx())
      → this->run()  ★★★ 纯虚函数 → vtable 查找 → 多态分发!
        → [JavaThread]      JavaThread::run()       thread.cpp:1927
        → [VMThread]        VMThread::run()         → loop()
        → [WatcherThread]   WatcherThread::run()   → PeriodicTask 循环
        → [GangWorker]      GangWorker::run()      → WorkGang loop

JavaThread::run()                            thread.cpp:1927
  → initialize_tlab()            ★ TLAB 初始化（Eden 私人缓冲区）
  → record_base_of_stack_pointer()  ★ 记录栈基址
  → create_stack_guard_pages()   ★ mprotect PROT_NONE 创建栈保护页

  → ThreadStateTransition::transition_and_fence(this, _thread_new, _thread_in_vm)
     ★★★ 为什么必须用 fence 而不是普通赋值？
         VMThread 在 safepoint 期间不加锁地读取 JavaThread::_thread_state
         来判断该线程是否到达 safepoint。
         没有 fence → CPU store buffer 可能延迟写入
         → VMThread 读到 stale _thread_new → 认为线程未初始化 → 跳过它
         → 这个线程在 safepoint 期间继续执行 → 堆损坏！
         fence 语义：StoreLoad 屏障，确保 _thread_state 写入对所有 CPU 可见

  ★★★ 三套状态系统（面试必问，插入在此处讲解，30+ 行）
     ❓ 为什么 JVM 需要三套独立的状态系统？

     ① JavaThreadState (C++ 层，_thread_state, volatile jint)
        位置：JavaThread::_thread_state（C++ 堆对象内）
        12 种值：_thread_new(2), _thread_in_native(4), _thread_in_vm(6),
                _thread_in_Java(8), _thread_blocked(10) + 各自的 _trans 过渡态
        修改者：线程自身通过 ThreadStateTransition 宏
        读取者：VMThread（safepoint 协议中无锁读取）、GC、ThreadSMR
        用途：★ 唯一定义 safepoint 安全性 — VMThread 据此判断线程是否停在安全点
        关键特征：volatile + transition_and_fence 保证跨 CPU 可见性

     ② java.lang.Thread.State (Java 层，threadStatus, int 堆内字段)
        位置：java.lang.Thread 对象中的 threadStatus 字段（堆内 oop 字段）
        6 种值：NEW, RUNNABLE, BLOCKED, WAITING, TIMED_WAITING, TERMINATED
        修改者：java_lang_Thread::set_thread_status() — 在各关键点显式调用
        读取者：jstack、Thread.getState()、JVMTI、JFR
        用途：★ 对外暴露 — jstack 输出、Java API
        关键特征：堆内字段（GC 可见），与 safepoint 协议完全无关

     ③ OSThread::ThreadState (OS 抽象层，_state)  — osThread.hpp:44-54
        位置：OSThread::_state（C-Heap）
        9 种值：ALLOCATED, INITIALIZED, RUNNABLE, MONITOR_WAIT, CONDVAR_WAIT,
                OBJECT_WAIT, BREAKPOINTED, SLEEPING, ZOMBIE
        修改者：os::create_thread, os::start_thread 及各阻塞点
        读取者：JVMTI GetThreadState、历史遗留代码
        用途：OS 层调度跟踪（JVMTI 原生接口需要细粒度状态）
        关键特征：★ 注释明说 "ThreadState is legacy code and is not correctly
                  implemented" — 官方承认它是历史包袱！实际应看 JavaThreadState
        生命周期关键状态：ALLOCATED(new OSThread 后) → INITIALIZED(初始化后) →
                         RUNNABLE(start 后) → ZOMBIE(退出后)

     ★★★ 三者的映射关系（核心理解点）：
        它们是三个独立维护的字段，不存在自动同步——
        每次状态变化时，代码必须显式分别调用不同的 API!

        典型场景的状态对应：
        线程刚创建但未启动       Java=NEW      C++=   _thread_new          OS=ALLOCATED
        线程执行 run() 方法中    Java=RUNNABLE  C++=   _thread_in_Java      OS=RUNNABLE
        线程等 synchronized 锁   Java=BLOCKED   C++=   _thread_blocked      OS=MONITOR_WAIT
        线程在 Object.wait()     Java=WAITING   C++=   _thread_blocked      OS=OBJECT_WAIT
        线程执行 JNI 代码        Java=RUNNABLE  C++=   _thread_in_native    OS=RUNNABLE
        线程已退出               Java=TERMINATED C++= (已销毁)              OS=ZOMBIE

        ★ 关键差异：_thread_in_native 的 Java 状态仍然是 RUNNABLE！
          → jstack 看线程在 native 代码中仍然显示 RUNNABLE
          → 但 safepoint 协议认为它是安全的（native 代码不操作堆内 oop）

        ★ 另一个差异：等 synchronized 锁时 OS 状态是 MONITOR_WAIT，而 Object.wait()
          时是 OBJECT_WAIT — OS 层区分了两种等待，但 C++ 的 JavaThreadState
          统一用 _thread_blocked

  → set_active_handles(JNIHandleBlock::allocate_block())
  → thread_main_inner()                      thread.cpp:1967

JavaThread::thread_main_inner()              thread.cpp:1967
  → set_native_thread_name(thread_name)  ★ pthread_setname_np → OS 可见
  → this->entry_point()(this, this)      ★ 执行 thread_entry
     thread_entry 内部:
       → java_lang_Thread::set_thread_status(threadObj, RUNNABLE)
       → 调用 Java 层的 Thread.run() 方法
       → run() 返回后清理
  → DTRACE_THREAD_PROBE(stop, this)
  → this->exit(false)                    ★ 进入退出流程
  → this->smr_delete()                   ★ 通知 ThreadSMR 延迟释放
```

### 4.3 退出流程（JavaThread::exit）

```
JavaThread::exit(bool destroy_vm, ExitType exit_type)  thread.cpp:2015

  Phase 1: 异常处理 + JVMTI 通知
    → HandleMark hm(this)
    → 检查 pending_exception → 如果有，调用 dispatchUncaughtException()
    → JvmtiExport::post_thread_end(this)  (如果 JVMTI 启用)

  Phase 2: ensure_join() ★★★ 面试必问
    → Handle threadObj(this, this->threadObj())
    → ObjectLocker lock(threadObj, this)     ★ 获取 java.lang.Thread 对象的 monitor
    → java_lang_Thread::set_thread_status(threadObj, TERMINATED)
    → java_lang_Thread::set_thread(threadObj, NULL)  ★ 断开 Java→C++ 关联
    → lock.notify_all(this)                  ★ 唤醒所有 join() 等待者
    ❓ 为什么用 java.lang.Thread 的 monitor 而不是 pthread_join？
       → JVM 用 DETACHED 线程，pthread_join 不可用
       → Java 层的 Object.wait()/notify() 天然支持这个语义

  Phase 3: 系统清理
    → set_terminated_value()         ★ 标记 _thread_state 为 terminated
    → Threads::remove(this, is_daemon)               thread.cpp:4754
      → ObjectSynchronizer::omFlush(this)             ★ 归还 ObjectMonitor
      → ThreadsSMRSupport::remove_thread(this)        ★ ThreadSMR 快照移除
      → 从 Threads::_thread_list 双向链表摘除
      → 如果是最后一个 non-daemon 线程 → Threads_lock->notify_all()
        (通知等待 JVM 退出的 destroy_vm 线程)

    ★★★ 面试追问：退出的线程持有 synchronized 锁怎么办？
        Java 层: ThreadDeath 异常 → 栈展开 → monitorexit 字节码正常释放锁
        JNI 层: JNI_MonitorEnter 获取的锁 → omFlush 把 ObjectMonitor
               从 omInUseList 移到全局 free list
               → 但不会自动 notify → 其他等待者永远等不到！
               → 这就是 Thread.stop() deprecated 的原因之一

  Phase 4: 资源释放
    → ThreadSafepointState::destroy(this)
    → JNIHandleBlock::release_block(active_handles())
    → delete _thread_stat

  ★ 退出后不是终点 — thread_main_inner 在 exit() 之后调用 this->smr_delete()
```

### 4.4 ThreadSMR 安全删除（完整 Hazard Pointers 协议）

```
核心问题: Threads::_thread_list 的遍历者（GC 扫描、jstack、JVMTI）不持锁——
         用 ThreadsListHandle RAII 声明"我正在遍历"。
         如果遍历期间另一个线程直接 delete 已退出的 JavaThread
         → use-after-free → segfault。

❓ 为什么遍历者不能用 Mutex 保护？
   GC Root Scanning 是热路径——每次 Young GC 都要遍历所有 JavaThread 的
   栈帧找 GC root。用 Mutex 保护会串行化所有 GC 线程的遍历 → 并行 GC
   的优势荡然无存。Hazard Pointer 代价只是一次原子写，接近零开销。

两套链表系统（必须讲清楚）:
  ① Threads::_thread_list — JavaThread 双向链表（_next/_prev）
     受 Threads_lock 保护，add/remove 时持锁
  ② ThreadsSMRSupport::_java_thread_list — ThreadsList* 快照数组
     原子交换（xchg），无锁读取，通过 Hazard Pointer 保护

ThreadsList 快照机制:
  - add_thread: 创建新 ThreadsList（旧数组 + 新线程），原子交换 _java_thread_list
    旧快照 → _to_delete_list 链表，延迟释放
  - remove_thread: 同理，创建不含目标线程的新快照
  - 旧快照释放时机: free_list() → ScanHazardPtrGatherThreadsListClosure
    收集所有线程的 _threads_hazard_ptr → 找出无人引用的旧快照 → delete

JavaThread 对象的释放（与 ThreadsList 快照释放是两个独立层级）:
  - smr_delete(JavaThread*) 循环等待 is_a_protected_JavaThread(thread) == false
  - is_a_protected_JavaThread: 遍历所有线程的 _threads_hazard_ptr，
    检查目标 JavaThread 是否在任何一个被保护的 ThreadsList 中
    → 源码走读: scan_table → ScanHazardPtrGatherProtectedThreadsClosure
    → 检查每个活跃的 hazard_ptr 指向的 ThreadsList 是否包含该 thread

tag bit 机制（必须精确）:
  ★★★ 修正版描述（原描述有误）:
  - tag_hazard_ptr(list): intptr_t(list) | 1  — 设置 LSB=1
  - untag_hazard_ptr(list): intptr_t(list) & ~1 — 清除 LSB
  - is_hazard_ptr_tagged(list): 检查 LSB==1
  用途: ScanHazardPtrGatherProtectedThreadsClosure 遍历所有线程的
        _threads_hazard_ptr 时，原子地 tagging 每个已处理过的 hazard_ptr，
        防止多个清理线程对同一位 hazard_ptr 重复处理。
        保护机制本身仅依赖 _threads_hazard_ptr != NULL，不依赖 tag bit。
        tag bit 是清理过程中的并发认领标记，不是"持有/空闲"标记。

完整竞态场景走读:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
时间  T1 读取者（ThreadsListHandle）           T2 写入者（退出线程）
─────────────────────────────────────────────────────────────────
t1    ThreadsListHandle tlh;
      → _threads_hazard_ptr = &list_v1
      → 遍历 list_v1 中的线程...
t2                                            JavaThread::exit()
                                              → Threads::remove(this)
                                                → ThreadsSMRSupport::remove_thread(this)
                                                → 创建 list_v2（不含 this）
                                                → xchg_java_thread_list(list_v2)
                                                → free_list(list_v1)
                                                  → list_v1 进 _to_delete_list
t3                                            → this->smr_delete()
                                                → while(is_a_protected_JavaThread(this))
                                                  → ★ T1 的 hazard_ptr 指向 list_v1
                                                  → ★ list_v1 包含 this → 返回 true → wait!
t4    tlh 析构
      → _threads_hazard_ptr = NULL
t5                                            → is_a_protected_JavaThread(this) 再次检查
                                              → ★ 无 hazard_ptr 保护 → 返回 false → break
                                              → delete this  ★ 安全释放
```

## 五、文章结构

```
§〇 源文件清单（15+ 文件表格，跨 runtime/os/prims/util 模块）

§一 从一行 Java 代码到内核 LWP
  ❓ 为什么需要理解线程创建的完整路径？
  1.1 用户态 vs 内核态 — new Thread().start() 背后发生了什么？
  1.2 数量级直觉 — clone() ≈ 15μs vs TLAB 分配 ≈ 15ns，差 1000 倍
  1.3 1:1 线程模型 — JavaThread = pthread = LWP，没有绿色线程

§二 继承链速览（背景，控制 40 行内）
  2.1 Thread 基类核心字段 — _osthread(OSThread*), _ParkEvent(ParkEvent*), _polling_page(void*)
  2.2 JavaThread vs NonJavaThread — 核心分歧: 被 safepoint 暂停 vs 不被暂停
  2.3 Mermaid 继承树
  ★ 不展开 NonJavaThread 分支的每种具体类

§三 线程创建：从 Java 到 pthread_create ★★★（核心，150+ 行）
  3.1 JVM_StartThread 源码 — 持有 Threads_lock，new JavaThread，prepare 双向关联
      ❓ 为什么必须在 Threads_lock 下创建？
  3.2 os::create_thread 源码 — OSThread 分配，4 种 ThreadType，栈大小计算
      ❓ 为什么 DETACHED 而不是 JOINABLE？
      ❓ 为什么 EAGAIN 重试？
  3.3 pthread_create → clone() — flags 逐一解释
      ❓ CLONE_VM / CLONE_FILES / CLONE_SIGHAND 各自的作用
  3.4 线程醒来: thread_native_entry → Thread::current() TLS → call_run → run()
      ★ TLS 机制: pthread_setspecific 实现

§四 JavaThread::run — 线程的第一个 JVM 函数（100+ 行）
  4.1 TLAB 初始化、栈保护页创建
  4.2 ThreadStateTransition::transition_and_fence(_thread_new → _thread_in_vm)
      ❓ 为什么必须 fence 而不是普通赋值？
  4.3 ★★★ 三套状态系统：JavaThreadState vs java.lang.Thread.State vs OSThread::ThreadState
      ❓ 为什么需要三套独立的状态系统？
      — 存储位置、修改者、读取者、用途的对比表
      — 三者的映射关系表（典型场景 × 三套状态值）
      — 关键差异：_thread_in_native 的 Java 状态仍是 RUNNABLE
  4.4 thread_main_inner → entry_point → 执行 Java run()

§五 JavaThread::exit — 优雅退出（60+ 行）
  5.1 ensure_join — 断开 threadObj ↔ JavaThread 关联，notify_all 唤醒 join()
  5.2 ★ 面试重点: 退出线程持有的锁怎么处理？
      Java 层锁 (monitorexit) vs JNI 锁 (omFlush → orphaned)
  5.3 Threads::remove — 从 _thread_list 摘除，最后一个 non-daemon 通知 VM 退出
  5.4 omFlush — 归还 ObjectMonitor 到全局池（与 [01-ObjectMonitor] 交叉引用）

§六 ThreadSMR — 为什么不能直接 delete？★★★（核心，150+ 行）
  ❓ 为什么不能直接 delete JavaThread？
  ❓ 为什么遍历者不能用 Mutex 保护？（GC 热路径）
  ❓ tag bit 到底做什么用？（并发认领，不是持有/空闲）
  6.1 两套链表系统 — _thread_list vs _java_thread_list
  6.2 ThreadsList 快照 — add_thread / remove_thread 中 xchg 新旧快照
  6.3 Hazard Pointer — _threads_hazard_ptr 的读写保护
  6.4 tag bit: tag_hazard_ptr / untag_hazard_ptr / is_hazard_ptr_tagged 源码
      — ScanHazardPtrGatherProtectedThreadsClosure 中的角色
  6.5 is_a_protected_JavaThread 源码走读（完整 scan_table 流程）
  6.6 smr_delete 等待循环源码走读
  6.7 ★ 竞态场景时序: T1 遍历 + T2 退出 → 等待 → T1 释放 → T2 delete
  6.8 ThreadsListHandle RAII — 读取者如何保护自己

§七 GDB 验证 + 可证伪断言（≥8 条）

§八 一句话总结 + 交叉引用
```

## 六、风格要求

1. **❓ "为什么"驱动**: 至少 9 处
   - §一: 为什么需要理解线程创建全链路？
   - §三: 为什么必须在 Threads_lock 下创建？
   - §三: 为什么 DETACHED 而不是 JOINABLE？
   - §三: CLONE_VM/CLONE_FILES/CLONE_SIGHAND 各自为什么需要？
   - §四: 为什么 transition_and_fence 必须 fence 而不是普通赋值？
   - §四: 为什么需要三套独立的状态系统？（JavaThreadState / Thread.State / OSThread）
   - §六: 为什么不能直接 delete JavaThread？
   - §六: 为什么遍历者不能用 Mutex 保护？（Hazard Pointer vs Mutex 选型）
   - §六: tag bit 到底做什么用？

2. **粒度显式标注**: 每个字段标粒度（Thread*/intptr_t/jint/oop/address），禁止模糊
3. **源码行号**: 每段源码标 `file:line` 格式
4. **完整函数走读**: 关键函数（JVM_StartThread, os::create_thread, JavaThread::run, JavaThread::exit, smr_delete, is_a_protected_JavaThread）逐行注释源码
5. **可证伪断言 ≥8 条**: 每条有 GDB 命令 + 预期值
6. **不低于 500 行、不超过 600 行**（加了三套状态系统 + ThreadSMR 深度，上限放宽）
7. **禁止编造函数名**: 所有函数名来自源码
8. **Mermaid ≥2 张**: 继承树 + ThreadSMR 竞态时序图
9. **对比表 ≥3 张**: 三套状态系统对比 / ThreadType 栈大小 / JavaThreadState 完整枚举
10. **竞态场景 ≥1 个完整时序**: ThreadSMR T1 读取 + T2 退出

## 七、关键"为什么"预期答案

| ❓ 问题 | 核心洞察 |
|---------|---------|
| 为什么需要理解线程创建全链路？ | [01-ObjectMonitor] 和 [02-BiasedLocking] 中反复看到 Threads_lock、VMThread——不理解线程怎么创建/销毁，就没法理解这些概念从哪来、为什么存在 |
| 为什么必须在 Threads_lock 保护下创建？ | safepoint 期间 VMThread 遍历 _thread_list 收集需暂停的线程——如果 JavaThread 已 new 但未注册，safepoint 会漏掉它 → 堆损坏 |
| 为什么 DETACHED 不是 JOINABLE？ | JVM 有自己的 join 机制：ensure_join() 用 java.lang.Thread 对象的 monitor 做 wait/notify，不需要 pthread_join。DETACHED = 线程退出时自动回收 pthread 资源 |
| 为什么 transition_and_fence 必须 fence？ | VMThread 在 safepoint 期间无锁读取 _thread_state——无 fence → CPU store buffer 延迟 → 读到 stale _thread_new → 认为未初始化 → safepoint 漏掉 → 堆损坏 |
| 为什么需要三套状态系统？ | 三者在不同层级为不同读者服务：JavaThreadState 为 safepoint 协议（VMThread 读）→ 需要 fence；java.lang.Thread.State 为外部 API（jstack/Thread.getState）→ 存堆内；OSThread 为 JVMTI 遗留 → 历史包袱。三者独立维护，不存在自动同步，必须显式调用各自的 API |
| 为什么不能直接 delete JavaThread？ | GC/jstack/JVMTI 通过 ThreadsListHandle 无锁遍历线程列表——如果此时 delete 目标线程 → use-after-free → segfault |
| 为什么遍历者不用 Mutex？ | GC Root Scanning 是热路径，用 Mutex 会串行化所有 GC 线程的遍历，并行 GC 优势丧失。Hazard Pointer 代价仅为一次原子写 |
| tag bit 到底做什么用？ | ScanHazardPtrGatherProtectedThreadsClosure 遍历所有线程的 _threads_hazard_ptr 时，原子 tagging 每个已处理过的指针，防止多清理线程重复认领。它不是"持有/空闲"标记 |
| 退出线程持有的锁怎么办？ | Java 层：ThreadDeath → 栈展开 → monitorexit 正常释放。JNI 层：omFlush 移动 ObjectMonitor 但不 notify → orphaned → 其他线程永久等不到 → Thread.stop() 废弃原因 |

## 八、可证伪断言（≥8 条）

| # | 断言 | 验证 |
|---|------|------|
| 1 | `os::create_thread` → `pthread_create` → `clone()` | GDB: `break os_linux.cpp:1031` → `bt` 看到 pthread_create → clone |
| 2 | JVM_StartThread 持有 Threads_lock | GDB: `break jvm.cpp:2890` → `p Threads_lock->_owner` = 当前线程 |
| 3 | 新建 JavaThread 状态 = _thread_new (=2) | GDB: `break JavaThread::run` → `p this->_thread_state` → (JavaThreadState) 2 |
| 4 | `transition_and_fence` 后状态 = _thread_in_vm (=6) | GDB: transition 后下一行 → `p _thread_state` → 6 |
| 5 | 三套状态独立存储：_thread_state ≠ threadStatus ≠ OSThread::_state | GDB: `p ((JavaThread*)thr)->_thread_state`; `p java_lang_Thread::threadStatus(threadObj)`; `p ((JavaThread*)thr)->osthread()->get_state()` → 三个不同的 int 值，在不同地址 |
| 6 | Thread::current() 通过 pthread_getspecific 实现 | GDB: `p Thread::_thr_current_key` → 打印 key; `thread_native_entry` 中 bt 看到 pthread_setspecific |
| 6 | Thread::current() 通过 pthread_getspecific 实现 | GDB: `p Thread::_thr_current_key` → 打印 key; `thread_native_entry` 中 bt 看到 pthread_setspecific |
| 7 | `Threads::add` LIFO 插入头部 | GDB: `break thread.cpp:4722` → `p Threads::_thread_list` 指向最新线程 |
| 8 | `omFlush` 后 omInUseCount → 0 | GDB: `break thread.cpp:4761` 前后 → `p this->omInUseCount` → 0 |
| 9 | ThreadSMR: `remove_thread` 新 list 不含目标 | GDB: `break threadSMR.cpp:933` → `p new_list->includes(thread)` → false |
| 10 | `smr_delete` 在 is_a_protected 为 true 时循环等待 | GDB: `break threadSMR.cpp:977` → 竞态场景首次返回 true，后续返回 false |
| 11 | tag bit: LSB 被设为 1 后指针值变化 | GDB: `p/x tag_hazard_ptr(list)` → (原始值 \| 1) |

## 九、输出格式

- Markdown 文件，命名为 `05-JVM-Thread-Lifecycle.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/07-thread-lock/`
- 元信息头（标准环境 + 源文件 + 前置 + 关联 + 阅读收益）
- 章节 `## §X` / `### X.X`
- 代码块 ` ```cpp `，Mermaid ` ```mermaid `
- 继承链 ASCII 树 + Mermaid 双重展示
