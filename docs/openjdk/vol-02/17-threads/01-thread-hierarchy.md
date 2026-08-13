# 01. JVM 里有多少种线程?— Thread 层次体系

> **前置依赖**:[07-classfile-classloader/07 — javaClasses](openjdk/vol-02/07-classfile-classloader/07-javaclasses-core-mirrors.md):Thread 镜像的 eetop/tid 与这里的 JavaThread/OSThread 是同一枚硬币;启动流程里 `set_thread_status(RUNNABLE)` 写的就是那个字段;[07-classfile-classloader/05 — ClassLoader](openjdk/vol-02/07-classfile-classloader/05-classloader-hierarchy.md):线程上下文类加载器在 JavaThread 身上
> → **后续**:[17-threads/02 — JavaThread 状态机](02-javathread-state.md)(线程怎么告诉 JVM"我不能被 safepoint")
> 关联域: 09-memory-core(每线程的 TLAB/ResourceArea)、07-classfile(Thread 镜像)、01-os(线程与同步)、20-vmops(VMThread)

## 一个 JVM,好几种线程

`new Thread().start()` 之后,JVM 里其实有四层身份在同时转: Java 层的 `java.lang.Thread` 对象、C++ 侧的 `JavaThread`、OS 层的 pthread、以及一个把三者连起来的 `OSThread`。而且 JVM 自己还养着一批"不是 Java 线程的线程": 执行 VM 操作的 VMThread、后台 GC 线程、JIT 编译器线程。这一篇把整个家族捋一遍: 共同基类 Thread 扛着什么、一个 Java 线程从 start() 到 run() 的完整链路、非 Java 线程的分支、以及 OS 那边的眼睛长什么样。

## 1. 共同基类: Thread 扛着每线程的"行李"

### 类的位置与核心职责

所有 JVM 线程的共同基类是 `Thread`(thread.hpp:115,继承 ThreadShadow 的异常字段——ThreadShadow 定义在 exceptions.hpp:60,挂起异常/异常文件行号都在它身上)。它不跑任何业务,而是给每个线程配齐"行李"——每线程独立的东西(thread.hpp:315-373,截取核心,逐字):

```cpp
// thread.hpp:315-373(截取核心,逐字)
  volatile uintx _rcu_counter;
  ...
  volatile void* _polling_page;                 // Thread local polling page
  ...
  ThreadLocalAllocBuffer _tlab;                 // Thread-local eden
  ...
  ObjectMonitor* omFreeList;
  int omFreeCount;                              // length of omFreeList
  ...
  ObjectMonitor* omInUseList;                   // SLL to track monitors in circulation
  int omInUseCount;                             // length of omInUseList
```

- **`_tlab`**(:348): 09 域讲过的线程本地分配缓冲——Java 对象分配的每线程快车道;
- **`_polling_page`**(:346): safepoint 轮询页——每线程一个只读页,VM 要停世界时把页变成不可读,线程执行到轮询点就 SIGSEGV 自动进 safepoint(01 域 04 篇的机制);
- **`_rcu_counter`**(:315): GlobalCounter 的线程本地字段——读侧进临界区时把全局 counter 记进这里(critical_section_begin),写侧要安全回收内存时 write_synchronize 等所有读者离开(globalCounter.hpp:30-42 注释: 读路径无竞争 store + fence,写侧较重);
- **`omFreeList`/`omInUseList`**(:369-373): ObjectMonitor 的每线程本地缓存——锁监视器对象按线程缓存,不抢全局 freelist;
- **`_suspend_flags`**: 外部挂起/异步异常的合并旗标——注释写得很清楚(:204-209): JVM_SuspendThread/JVMTI SuspendThread 置位,Java 线程在 `handle_special_runtime_exit_condition` 时自挂起;同一个字段还兼任 async exception 等"特殊退出条件"的标记(:241-243,一次检查全知道)。

还有 `operator new` → `allocate(size, mtThread)`(thread.hpp:185-191): **Thread 对象分配在 C-Heap**(mtThread 标记,NMT 可查),不是 CodeCache 也不是 Metaspace。

### Thread::current(): 我在哪

"当前线程"的读取是 inline 的(thread.hpp:794-817,截取核心,逐字):

```cpp
// thread.hpp:794-817(截取核心,逐字)
// Inline implementation of Thread::current()
inline Thread* Thread::current() {
  Thread* current = current_or_null();
  assert(current != NULL, "Thread::current() called on detached thread");
  return current;
}

inline Thread* Thread::current_or_null() {
#ifndef USE_LIBRARY_BASED_TLS_ONLY
  return _thr_current;
#else
  if (ThreadLocalStorage::is_initialized()) {
    return ThreadLocalStorage::thread();
  }
  return NULL;
#endif
}

inline Thread* Thread::current_or_null_safe() {
  if (ThreadLocalStorage::is_initialized()) {
    return ThreadLocalStorage::thread();
  }
  return NULL;
}
```

`_thr_current` 是编译器级 TLS(`THREAD_LOCAL_DECL Thread*`,thread.hpp:122,定义 thread.cpp:171),`__thread` 关键字,一次读寄存器/段基址——这是快路径;`current_or_null_safe()`(thread.hpp:811-817)永远走 `ThreadLocalStorage`(threadLocalStorage.hpp:41-48 的 library TLS 包装: `thread()`/`set_thread()`/`init()`)——信号处理器里 compiler TLS 不可靠,library 调用 `pthread_getspecific` 更安全(threadLocalStorage.hpp:31-36 注释明说: 所有平台在 signal handler 场景都用 library TLS)。

## 2. 启动流程: 从 new Thread().start() 到 run()

一条 Java 线程的诞生分四段:

- **创建**: `JavaThread` 构造器里调 `os::create_thread(this, thr_type, stack_sz)`(thread.cpp:1758)——底层 `pthread_create`(os_linux.cpp:1007),**OS 线程创建后处于挂起状态**,由创建者显式启动(注释 :1765-1770);
- **启动**: `Thread::start`(thread.cpp:488-502,截取核心,逐字):

```cpp
// thread.cpp:488-502(截取核心,逐字)
void Thread::start(Thread* thread) {
  // Start is different from resume in that its safety is guaranteed by context or
  // being called from a Java method synchronized on the Thread object.
  if (!DisableStartThread) {
    if (thread->is_Java_thread()) {
      // Initialize the thread state to RUNNABLE before starting this thread.
      // Can not set it after the thread started because we do not know the
      // exact thread state at that time. It could be in MONITOR_WAIT or
      // in SLEEPING or some other state.
      java_lang_Thread::set_thread_status(((JavaThread*)thread)->threadObj(),
                                          java_lang_Thread::RUNNABLE);
    }
    os::start_thread(thread);
  }
}
```

注意它通过 **07-07 的 Thread 镜像**把 `threadStatus` 字段写成 RUNNABLE(:497-498)——"为什么在启动前写"注释说得很清楚: 线程一旦跑起来状态就不可知了(MONITOR_WAIT/SLEEPING 都可能),必须在启动瞬间前定好;
- **OS 入口**: pthread 的入口是 `thread_native_entry`(os_linux.cpp:770 起): 记录栈边界(:772)、`initialize_thread_current()` 设置 TLS(:789)、`osthread->set_thread_id(os::current_thread_id())`(:794——**07-07 jstack 的 nid 在这里落库**),然后是一段父子握手(:810-819): 把自己置成 INITIALIZED 并 notify 父线程,随后在 `startThread_lock` 上 wait;`os::start_thread`(os.cpp:884-890)在 SR_lock 下把状态置成 **RUNNABLE**(pd_start_thread),唤醒它,这才进入 `Thread::call_run()`;
- **call_run → run()**: `call_run`(thread.cpp:370-401)调虚函数 `run()`(:386)——多态分发到 JavaThread::run 或 WatcherThread::run 等。注释点破一个细节: run() 返回后线程对象**可能已经自删**(:389-390,"the thread object may already have deleted itself"),所以之后的清理只能碰 TLS 不能碰 this。

`JavaThread::run`(thread.cpp:1818 起)是 Java 线程的入口: 初始化 TLAB、建栈保护页、**状态转换 `_thread_new → _thread_in_vm`**(transition_and_fence,:1831)——这是 02 篇状态机的第一次亮相,然后 `thread_main_inner`(:1855 起)调 `entry_point()`——普通线程的 entry 是 `thread_entry`(jvm.cpp:2844,JavaCalls 虚调用 `Thread.run()`),于是 Java 层的 run() 终于被调用。

## 3. JavaThread: 一个 Java 线程的 C++ 身份

`JavaThread : Thread`(thread.hpp:952)扛着与 Java 层线程对象一一对应的全部状态(截取核心,逐字):

```cpp
// thread.hpp:957-1040(截取核心,逐字)
  JavaThread*    _next;                          // The next thread in the Threads list
  ...
  oop            _threadObj;                     // The Java level thread object
  ...
  JavaFrameAnchor _anchor;                       // Encapsulation of current java frame and it state
  ...
  CompiledMethod*       _deopt_nmethod;         // CompiledMethod that is currently being deoptimized
  vframeArray*  _vframe_array_head;              // Holds the heap of the active vframeArrays
  ...
  oop           _vm_result;    // oop result is GC-preserved
  Metadata*     _vm_result_2;  // non-oop result
  ...
  MemRegion     _deferred_card_mark;
  ...
  MonitorChunk* _monitor_chunks;                 // Contains the off stack monitors
  ...
  oop           _pending_async_exception;
  ...
  volatile JavaThreadState _thread_state;
  ...
  ThreadSafepointState *_safepoint_state;        // Holds information about a thread during a safepoint
```

- **`_threadObj`**(:960): Java 层 Thread 对象——07-07 的 eetop 与这里的 `threadObj()` 就是一对双向指针;
- **`_next`**(:957): 全局线程链表(Threads 列表)的链;
- **`_anchor`**(:984): JavaFrameAnchor——当前 Java 帧在哪(last_Java_sp/pc),GC 遍历栈、stack walk 都从它起步;
- **`_thread_state`**(:1038): JavaThreadState 状态机(02 篇);
- **`_deopt_nmethod`/`_vframe_array_head`**(:995-996): deoptimization 现场——被去优化的编译方法与重建的帧数组;
- **`_vm_result`**(:1015-1016): VM/Java 调用的返回值(oop 与 non-oop 分开存,GC 安全的交接点);
- **`_monitor_chunks`**(:1023): 从栈上卸下来的 monitor(JavaFrameAnchor 上的 monitor 链);
- **`_pending_async_exception`**(:1034): 等下次 transition 抛出的异步异常。

一个重要修正: 编译器线程也是 **JavaThread 的子类**(`CompilerThread : public JavaThread`,thread.hpp:2129)——它不跑用户代码,但共享 JavaThread 的整套机制(状态机/锚点/轮询)。流传说法"编译器线程是非 Java 线程"在 jdk11u 不成立。

## 4. NonJavaThread 与 NamedThread: VM 自己的线程

### 家族谱

`NonJavaThread : Thread`(thread.hpp:819)是"不跑 Java 代码"的根,自带独立链表(`_next`,:822)与遍历器 `Iterator`(:840)。它的两个分支:

- **`NamedThread : NonJavaThread`**(thread.hpp:857): 有名字的线程(`_name`,:866),子类三个:
  - `VMThread`(vmThread.hpp:114)——执行 VM_Operation 的唯一线程(20 域);
  - `ConcurrentGCThread`(concurrentGCThread.hpp:31)——后台 GC 线程的根(25-26 域);
  - `WorkerThread`(thread.hpp:885)——并行 GC 的干活线程(带 `_id`);
- **`WatcherThread : NonJavaThread`**(thread.hpp:902)——**不挂 NamedThread 名下**,名字硬编码 "VM Periodic Task Thread"(:923),跑周期任务(PeriodicTask 的 `real_time_tick` 断言必须是 WatcherThread 来调,task.cpp:49-50——09-03 的 ChunkPoolCleaner 就是这样的 PeriodicTask)。

### 为什么 GC 不怎么管它们的栈

NonJavaThread 没有 `JavaFrameAnchor`、不执行 Java 代码,所以 GC 的栈遍历(oops_do)对它们几乎无事可做——没有 Java 帧就没有堆引用(Thread 基类的 `oops_do` 处理的是 JNI 活跃句柄、句柄区与挂起异常,thread.cpp:876-884;JavaThread 的 `oops_do` 才额外遍历 Java 栈帧与锚点)。

## 5. OSThread: OS 那边的眼睛

`OSThread`(osThread.hpp:56,`CHeapObj<mtThread>`)是每个 JVM 线程与 OS 线程的"对账本"(截取核心,逐字):

```cpp
// osThread.hpp:56-77(截取核心,逐字)
class OSThread: public CHeapObj<mtThread> {
  friend class VMStructs;
  friend class JVMCIVMStructs;
 private:
  OSThreadStartFunc _start_proc;  // Thread start routine
  void* _start_parm;              // Thread start routine parameter
  volatile ThreadState _state;    // Thread state *hint*
  volatile jint _interrupted;     // Thread.isInterrupted state
```

- `_start_proc`/`_start_parm`(:58-59): 线程入口函数与其参数;
- `_state`(:60): 老 ThreadState 枚举的"hint"(只作提示,真正状态在 JavaThread._thread_state,注释就写 `Thread state *hint*`);
- `_interrupted`(:61): **中断标志必须是 jint**(注释 :63-67)——Java 的 `Thread.currentThread().isInterrupted()` 的 intrinsics 要直接双跳读它;
- `_thread_id`(osThread.hpp 底部 platform 段): 内核线程 ID(pthread_t,注释明说可用来查 /proc)——07-07 jstack 的 `nid=0x...` 就是它。

JavaThread 通过 `osthread()` 访问它。三个世界的对账: `Thread`(C++ 逻辑身份)→ `OSThread`(OS 身份: pthread_t/中断标志)→ pthread(内核)。

**关键设计 (斜体)**: *四层身份各管一事: Thread 管"每线程行李"(TLAB/轮询页/监控缓存),JavaThread 管"Java 身份"(对象/状态机/锚点),OSThread 管"OS 身份"(pthread_t/中断),pthread 管内核调度。JVM 自己的线程(VMThread/GC/编译器)只是这套体系里换了个 run() 的多态实例——编译器线程甚至直接复用 JavaThread。*

## 核心悬念

家族的轮廓到齐: Thread 基类扛着每线程的行李(TLAB/轮询页/monitor 缓存)与 TLS 快路径;一条 Java 线程从 create_thread(挂起)→ start(写 RUNNABLE 状态)→ thread_native_entry(存 nid)→ call_run→run() 四段成型;JavaThread 是一对一身份(对象/锚点/状态),CompilerThread 也是它的子类;NonJavaThread 分支出 NamedThread(VMThread/GC)/WatcherThread;OSThread 对账 OS 身份。但你大概注意到了 run() 里那个一闪而过的词: `transition_and_fence(_thread_new, _thread_in_vm)`——线程在 VM 内外进进出出,靠 `_thread_state` 状态机告诉世界"我现在在哪、能不能被 safepoint"。下一篇: JavaThread 状态机与状态转换。

> → [17-threads/02 — JavaThread 状态机](02-javathread-state.md)
