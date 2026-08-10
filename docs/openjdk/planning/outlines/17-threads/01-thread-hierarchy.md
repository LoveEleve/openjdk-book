# 01. JVM 里有多少种线程？— Thread 层次体系

> 🔴 Deep | 4 KP 中的基础层次
> 读者处境: 你写的 `new Thread().start()` 最终到了 native——但 JVM 里远不止 Java 线程。CompilerThread、VMThread、GC Thread 都在同时运行。

### 1. "我们都有一个根" — Thread 基类

场景: 所有 JVM 线程——无论是 `new Thread()` 创建的 Java 线程、JIT compiler、还是 GC worker——都派生自同一个 C++ 基类: `Thread`。

**Thread 基类的职责** (`thread.hpp:115-115`):
- TLS 注册: `static THREAD_LOCAL_DECL Thread* _thr_current` — 每线程存自己的 Thread* (threadLocalStorage.hpp)
- 资源管理: TLAB(`_tlab`)、ResourceArea、HandleArea — 每线程独立的内存区
- GC 根: `oops_do(OopClosure*, CodeBlobClosure*)` — GC 遍历栈上的 oop/编译帧
- Safepoint 轮询: `_polling_page` — 每线程一个轮询页地址
- ObjectMonitor 缓存: `omFreeList/omInUseList` — 每线程的 monitor 本地缓存(不锁全局 freelist)
- Suspend 标记: `_suspend_flags` — 外部挂起/async exception/deopt suspend/trace flag
- [C++: `_rcu_counter` 参与 GlobalCounter——写侧递增 counter, 读侧检查 counter > local——用于 GC barrier 的 epoch-based state 追踪]

**Thread::current()** (`threadLocalStorage.hpp`):
- 核心宏: `THREAD_LOCAL_DECL Thread* _thr_current`
- 支持 signal handler 安全: `current_or_null_safe()` — signal handler 内可能没有 TLS
- [C++: `__thread` 或 `thread_local` 关键字——pthread_getspecific() 降级——signal handler 中可能读到 NULL 因为 TLS 未初始化]

**线程启动流程** (`thread.cpp:120-150`):
```
Thread::start(thread*):
  1. os::create_thread(thread, osthread)  // 创建 OS 线程
  2. os::start_thread(thread)             // 挂入调度队列
  3. 目标线程执行 Thread::call_run()      // → virtual run() 多态
```
- 关键设计: `call_run()` 做公共准备(初始化 thread_current)→调 `run()`(子类 override)→公共清理(remove from list, smr_delete)

### 2. "Java 这边的" — JavaThread 专有字段

场景: `new Thread().start()` — JVM 内有个 JavaThread 对应 Java 层的 Thread 对象。

**JavaThread 特有字段** (`thread.hpp:952-1051`):
```
JavaThread : Thread
  - _threadObj: oop → java.lang.Thread 实例
  - _next: JavaThread* → 全局线程链表(Threads::threads_list)
  - _anchor: JavaFrameAnchor → 当前 Java 帧状态(last_Java_sp/last_Java_pc)
  - _thread_state: JavaThreadState → 5态状态机(§02)
  - _safepoint_state: ThreadSafepointState → safepoint 相关数据
  - _deopt_nmethod: 正在 deopt 的编译方法
  - _vframe_array_head: deopt 时重建的虚拟帧数组
  - _callee_target: c2i adapter handshake 的 Method*(i2c adapter→找到错误方法的回退)
  - _vm_result/_vm_result_2: JNI/VM 调用的返回结果(oop vs non-oop)
  - _deferred_card_mark: ReduceInitialCardMarks 优化——延迟卡标记的区间
  - _monitor_chunks: deopt/JNI 分配的 monitor 块(off-stack)
  - _special_runtime_exit_condition: async exception/unsafe access error
  - _pending_async_exception: 等待下次 transition 抛出的异步异常
```
- 关键设计: JavaThread 的分配(`operator new`)走 C-Heap(mtThread 标记)——nmethod 在 CodeHeap，Thread 在 C-Heap。这是区分——Thread 不是 CodeBlob，不放在 CodeCache

### 3. "不是 Java 的" — NonJavaThread 体系

场景: VMThread（执行 VM operations）、ConcurrentGCThread（后台 GC）、WorkerThread（并行 GC）——它们不跑 Java 代码，但需要安全地与 JavaThread 共存。

**NonJavaThread 类型** (`thread.hpp:819-840, 857-951`):
```
NonJavaThread : Thread
  - 有独立的 list(_next 链) — NonJavaThread::Iterator 可遍历
  - NamedThread: 有名字的线程
    - VMThread: 执行 VM_Operation 的唯一线程(域20)
    - ConcurrentGCThread: 后台 GC 根(域25-26)
    - WorkerThread: 并行 GC 的 GangWorker(域25)
  - WatcherThread: 周期性任务调度(不是 NamedThread)
```
- [C++: NonJavaThread 不能用 oops_do 遍历栈上的 Java oop——因为它没有 JavaFrameAnchor。GC 遍历 NonJavaThread 时跳过 oops_do——只有 JavaThread 有 Java 栈帧]

### 4. "OS 那边怎么看着这个线程？" — OSThread

场景: JVM 用 pthread_create 创建线程——OS 给了一个 pthread_t。JVM 怎么追踪它？

**OSThread 封装** (`osThread.hpp`):
```
OSThread:
  - _thread_id: OS 线程 ID (pthread_t on Linux)
  - _state: ThreadState (已废弃) — 保留给 JVMTI 兼容
  - _interrupted: 中断标志
  - _start_thread_lock: 确保 start 和 thread run 的同步
  - platform 扩展: os::Linux::_pthread_id 等
```
- [C++: `os::create_thread` 调 pthread_create——传入 `java_start` wrapper——wrapper 中 `os::current_thread_id()` 存到 OSThread→调用 Thread::call_run()]

---

### 核心悬念

**"JVM 里的线程是一个三层的 Russian doll——Thread 是基、JavaThread 代表 Java 线程、NonJavaThread 代表 VM 内部线程——OSThread 包在 Thread 里连到 OS。"** — 但线程怎么告诉 JVM "我不能被 safepoint"？下一篇: JavaThread 状态机。

> → [02-javathread-state.md](02-javathread-state.md)
