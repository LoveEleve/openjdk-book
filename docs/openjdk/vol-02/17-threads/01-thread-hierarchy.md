# 01. JVM 里有多少种线程?— Thread 层次体系

> **前置依赖**:[07-classfile-classloader/07 — javaClasses](openjdk/vol-02/07-classfile-classloader/07-javaclasses-core-mirrors.md):Thread 镜像的 eetop/tid 与这里的 JavaThread/OSThread 是同一枚硬币;启动流程里 `set_thread_status(RUNNABLE)` 写的就是那个字段;[07-classfile-classloader/05 — ClassLoader](openjdk/vol-02/07-classfile-classloader/05-classloader-hierarchy.md):线程上下文类加载器在 JavaThread 身上
> → **后续**:[17-threads/02 — JavaThread 状态机](02-javathread-state.md)(线程怎么告诉 JVM“我不能被 safepoint”)
> 关联域: 09-memory-core(每线程的 TLAB/ResourceArea)、07-classfile(Thread 镜像)、01-os(线程与同步)、20-vmops(VMThread)

`new Thread().start()` 之后，JVM 里其实有四层身份在同时转：Java 层的 `java.lang.Thread` 对象、C++ 侧的 `JavaThread`、OS 层的 pthread，以及把 JVM 线程和 OS 线程对上的 `OSThread`。

但 JVM 自己还养着一批“不是用户 Java 线程的线程”：执行 VM 操作的 VMThread、后台 GC 线程、JIT 编译器线程、WatcherThread。它们不是简单的“JavaThread/非 JavaThread”二分，而是同一套 Thread 层次体系下的不同多态分支。

本篇要回答的核心问题:

1. `Thread` / `JavaThread` / `OSThread` / pthread 分别负责什么?
2. 一条 Java 线程从 `start()` 到 `run()` 中间经过哪些阶段?
3. 为什么 CompilerThread 不跑用户 Java，却仍然是 JavaThread 子类?
4. VMThread、GC、WatcherThread 又为什么走 NonJavaThread 分支?

答案会反复落到一句话:**Thread 管公共线程行李与生命周期，JavaThread 承载 Java 身份、状态机和栈锚点，OSThread 对账 OS 身份，pthread 负责内核调度。JVM 线程家族的差异不在“有没有 OS 线程”，而在 run() 的多态行为和 Java 栈/safepoint 协议。**

---

## 1. 先试两个最自然的理解，看看为什么都不对

### 误解一：一个 JavaThread 就等于一个 pthread

从 OS 角度看，最终确实是一条 pthread；但 JavaThread 不是 pthread 的替身。

JavaThread 还要保存 Java 层 Thread 对象、当前 Java 帧锚点、线程状态、safepoint 状态、deopt 现场、JNI handle 和 VM 返回值。pthread 只负责让代码在内核调度器上运行。

所以“线程”在 JVM 里不是一个单层对象，而是几个层次叠加出来的身份。

### 误解二：不跑用户 Java 的线程就是 NonJavaThread

CompilerThread 不跑用户 Java 方法，却是 `CompilerThread : public JavaThread`。它仍然需要 JavaThread 这套 safepoint / Handle / VM transition 协议，才能安全参与编译期的对象访问、JVMCI/JFR/JVMTI 交互与线程状态切换。

相反，VMThread、后台 GC 线程、WatcherThread 走 `NonJavaThread` 分支，因为它们不承载用户 Java 执行帧，也不需要 JavaThread 那套 Java 栈协议。

因此分类依据不是“代码是不是 Java”，而是**这个线程是否需要 JavaThread 的状态、栈锚点和 safepoint 协议**。

---

## 2. Thread：所有 JVM 线程共同携带的“行李”

所有 JVM 线程的共同基类是 `Thread`(thread.hpp:115)。它不跑具体业务，而是给每个线程配公共状态与资源。

核心字段包括:

- `_tlab`：线程本地 Eden 分配缓冲;
- `_polling_page`：safepoint 轮询页;
- `_rcu_counter`：GlobalCounter 读侧临界区计数;
- `omFreeList` / `omInUseList`：ObjectMonitor 的线程本地缓存;
- `_suspend_flags`：挂起、异步异常等特殊退出条件。

这些字段都属于“线程行李”，但不是每种线程都会以同样方式使用它们。

`Thread` 对象本身通过 `allocate(size, mtThread)` 分配在 C-Heap，NMT 归入 `mtThread`，不是 CodeCache 也不是 Metaspace。`thread.hpp:185-191`

### Thread::current：当前线程从哪里读

`Thread::current()` 是 inline 快路径：

```cpp
// thread.hpp:794-817(截取核心,逐字)
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
```

普通路径优先使用编译器 TLS 的 `_thr_current`，读取成本低；`current_or_null_safe()` 则走 library TLS，专门用于信号处理器等 compiler TLS 不可靠的场景。

---

## 3. JavaThread：从 `start()` 到 `run()` 的启动链

一条 Java 线程的诞生可以拆成四段。

### 创建：先有 JavaThread，再创建 OS 线程

`JavaThread` 构造器调用 `os::create_thread(this, thr_type, stack_sz)`，Linux 下进一步走 `pthread_create`。OS 线程创建出来后处于挂起状态，由创建者显式启动。`thread.cpp:1758`

### 启动：先写 Java threadStatus，再唤醒 OS 线程

`Thread::start`(thread.cpp:488-502)会在启动 JavaThread 之前把 Java 镜像的 `threadStatus` 写成 `RUNNABLE`:

```cpp
// thread.cpp:488-502(截取核心,逐字)
void Thread::start(Thread* thread) {
  if (!DisableStartThread) {
    if (thread->is_Java_thread()) {
      java_lang_Thread::set_thread_status(
          ((JavaThread*)thread)->threadObj(),
          java_lang_Thread::RUNNABLE);
    }
    os::start_thread(thread);
  }
}
```

为什么要提前写?注释已经说明：线程一旦真正运行起来，可能立刻进入 `MONITOR_WAIT`、`SLEEPING` 等状态，创建者无法再准确预测启动瞬间的初始状态。

### OS 入口：pthread 先完成自己的对账

pthread 的入口是 `thread_native_entry`(os_linux.cpp:770-819)，它会：

- 记录栈边界;
- `initialize_thread_current()` 设置 TLS;
- `osthread->set_thread_id(os::current_thread_id())` 写入内核线程 ID;
- 完成父子握手;
- 在 `startThread_lock` 上等待 `os::start_thread` 唤醒。

所以 `jstack` 里看到的 `nid=0x...`，本质上就是这里记录的 OS thread id。

### call_run：多态进入具体线程行为

`call_run`(thread.cpp:370-401)调用虚函数 `run()`。之后会根据具体子类分发到 `JavaThread::run`、`WatcherThread::run` 或其他线程实现。

`run()` 返回后线程对象可能已经自删，所以后续清理只能碰 TLS，不能再访问 `this`。`thread.cpp:386-390`

`JavaThread::run`(thread.cpp:1818 起)随后会初始化 TLAB、建立栈保护页、完成 `_thread_new → _thread_in_vm` 状态转换，再由 `thread_main_inner` 调 `entry_point()`。普通 Java 线程的 entry 会通过 JavaCalls 调 `Thread.run()`。

---

## 4. JavaThread：一个 Java 线程的 C++ 身份

`JavaThread : Thread`(thread.hpp:952)承载与 Java 层 Thread 对象对应的状态:

- `_threadObj`：Java 层 Thread 对象;
- `_anchor`：`JavaFrameAnchor`，记录当前 Java 帧，GC 栈扫描和 stack walk 都从它起步;
- `_thread_state`：JavaThread 状态机;
- `_deopt_nmethod` / `_vframe_array_head`：deoptimization 现场;
- `_vm_result` / `_vm_result_2`：VM/Java 调用的返回值;
- `_monitor_chunks`：从栈上卸下来的 monitor 链;
- `_pending_async_exception`：下一次安全 transition 时抛出的异步异常;
- `_safepoint_state`：线程在 safepoint 中的状态。

其中 `_threadObj` 与 07-07 的 Thread 镜像形成双向关系：Java 镜像通过 `eetop` 等字段找到 native JavaThread，JavaThread 也持有 `_threadObj`。

**CompilerThread 也是 JavaThread 子类**(`CompilerThread : public JavaThread`,thread.hpp:2129)。它不跑用户 Java 代码，但仍需要 JavaThread 这套 safepoint / Handle / VM transition 协议，因此会复用 JavaThread 的状态机、锚点与轮询机制。这正说明继承关系表达的是“需要哪套 VM 线程协议”，不是“最终执行哪种业务代码”。

---

## 5. NonJavaThread / NamedThread / WatcherThread：VM 自己的线程

### NonJavaThread 家族

`NonJavaThread : Thread`(thread.hpp:819)是“不跑 Java 代码”的根，带独立链表与遍历器。它的两个主要分支:

- **`NamedThread : NonJavaThread`**(thread.hpp:857)：带名字的 VM 线程;
  - `VMThread`：执行 VM_Operation 的唯一线程;
  - `ConcurrentGCThread`：后台 GC 线程的根;
  - `WorkerThread`：并行 GC 等任务的 worker。
- **`WatcherThread : NonJavaThread`**(thread.hpp:902)：名字硬编码为 `"VM Periodic Task Thread"`，执行 PeriodicTask 表。

`WatcherThread` 的 `real_time_tick` 会断言当前调用者是 WatcherThread，说明它确实是周期任务的专门宿主。

### 为什么 GC 对 NonJavaThread 的 Java 栈几乎无事可做

NonJavaThread 没有 `JavaFrameAnchor`，也不执行 Java 代码。因此 GC 的栈遍历不需要像 JavaThread 一样扫描 Java 帧。

`Thread::oops_do` 会处理 JNI 活跃句柄、句柄区与挂起异常；JavaThread 的 `oops_do` 才额外处理 Java 栈帧与 anchor。`thread.cpp:876-884`

所以 NonJavaThread 的核心特征不是“没有栈”，而是**没有需要按 Java 语义解释的 Java 执行帧**。

---

## 6. OSThread：OS 那边的对账本

`OSThread`(osThread.hpp:56)是 JVM 线程和 OS 线程之间的对账本:

```cpp
// osThread.hpp:56-77(截取核心,逐字)
class OSThread: public CHeapObj<mtThread> {
  private:
    OSThreadStartFunc _start_proc;
    void* _start_parm;
    volatile ThreadState _state;
    volatile jint _interrupted;
```

它主要保存:

- `_start_proc` / `_start_parm`：OS 线程入口和参数;
- `_state`：旧 ThreadState 的提示值，不是 JavaThread 的完整状态机;
- `_interrupted`：Java `Thread.isInterrupted()` 相关中断标志;
- `_thread_id`：平台线程 ID，用于 `/proc` 和诊断工具。

因此四层身份可以这样对账：

```text
Thread       → VM 线程公共行李与生命周期
JavaThread   → Java 对象、状态机、JavaFrameAnchor
OSThread     → pthread / OS id / interrupt 状态
pthread      → 内核调度实体
```

JVM 自己的 VMThread、GC、编译器、Watcher 只是换了 `run()` 多态实现，并不意味着它们都要拥有完全不同的底层线程模型。

---

## 7. 误解澄清与收网

1. **JVM 里只有 JavaThread 和 pthread 两层吗?** 不是。至少要区分 Thread、JavaThread、OSThread 与 pthread 四层身份。
2. **CompilerThread 是 NonJavaThread 吗?** 在 11u 中不是，它是 JavaThread 子类，只是不跑用户 Java 代码。
3. **WatcherThread 是 JavaThread 吗?** 不是，它是 NonJavaThread，专门承载周期任务。
4. **JavaThread 的 threadStatus 是线程跑起来后再写吗?** 不是，`Thread::start` 会在启动 OS 线程前先写 `RUNNABLE`。
5. **OSThread 的 `_state` 就是 JavaThread 的完整状态机吗?** 不是，它只是 OS 侧的提示状态；真正用于 Java/safepoint 协议的是 `JavaThread::_thread_state`。

把这一篇压成三句话:

- **Thread 管公共行李，JavaThread 管 Java 身份，OSThread 管 OS 对账，pthread 管内核调度。**
- **JavaThread 启动链是 create → start 写 RUNNABLE → pthread 入口写 TLS/nid → call_run → 多态 run。**
- **CompilerThread 复用 JavaThread 协议，VM/GC/Watcher 走 NonJavaThread，差异来自执行状态和栈扫描需求。**

下一篇: JavaThread 状态机——线程如何告诉 JVM“我现在在哪，能不能被 safepoint”。

> → [17-threads/02 — JavaThread 状态机](02-javathread-state.md)