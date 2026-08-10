# 09-JVM-JavaThread-System：10 个系统 JavaThread — 守护者全景

> **标准环境**: OpenJDK 11 slowdebug build, `-Xms8g -Xmx8g -XX:+UseG1GC`, 64-bit Linux AMD64
> **编译模式**: 默认 mixed mode（Tiered Compilation 开启 → C1 x1 + C2 x1）
> **对比模式**: `-Xint` 纯解释（CompilerThread + Sweeper 不创建 → 10 → 8 条线程）
> **源文件**: `thread.cpp/.hpp` `serviceThread.cpp/.hpp` `compileBroker.cpp` `attachListener.cpp` `os.cpp` `os_linux.cpp` `os_linux_x86.cpp` `os_posix.cpp` `jvm.cpp` `sweeper.cpp`
> **前置**: [05-ThreadArchitecture] 继承链 + daemon 字段, [06-ThreadOverview] 线程分类全景, [07-VMThread] VMThread 事件循环, [08-WorkerThread] WorkerThread 并行军团
> **阅读收益**: 理解 JVM 内部创建的所有 JavaThread → 回答"jstack 里 17 个线程哪来的" → 面试高频追问"X 线程挂了会怎样"

---

## §〇 源文件清单

本文分析跨越 `runtime` / `compiler` / `services` / `os` / `prims` 五个模块：

| # | 文件 | 完整路径 | 核心类/函数 | 本文角色 |
|---|------|---------|------------|---------|
| 1 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | `create_vm()`, `JavaThread构造` `Threads::add/remove` | ★ startup 5 线程创建 + daemon 追踪 |
| 2 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | `JavaThread`, `CompilerThread`, `CodeCacheSweeperThread` | 类继承 + 字段定义 |
| 3 | `serviceThread.cpp/.hpp` | `src/hotspot/share/runtime/` | `ServiceThread::initialize()`, `service_thread_entry()` | ★ ServiceThread 主循环 |
| 4 | `compileBroker.cpp` | `src/hotspot/share/compiler/` | `compiler_thread_loop()`, `make_thread()`, `compilation_init_phase1/2` | ★ C1/C2 编译器线程创建与调度 |
| 5 | `sweeper.cpp` | `src/hotspot/share/runtime/` | `NMethodSweeper::sweeper_loop()` | Sweeper 线程循环 |
| 6 | `os.cpp` | `src/hotspot/share/runtime/` | `initialize_jdk_signal_support()`, `signal_thread_entry()` | ★ SignalDispatcher 创建与循环 |
| 7 | `attachListener.cpp` | `src/hotspot/share/services/` | `AttachListener::init()`, `attach_listener_thread_entry()` | AttachListener UNIX socket |
| 8 | `jvm.cpp` | `src/hotspot/share/prims/` | `JVM_StartThread()` | ★ Java 线程创建入口 — ReferenceHandler/Finalizer 必经之路 |
| 9 | `os_linux.cpp` | `src/hotspot/os/linux/` | `os::create_thread()`, `default_guard_size()` | OS 线程创建 + ThreadType → stack_size |
| 10 | `os_linux_x86.cpp` | `src/hotspot/os_cpu/linux_x86/` | `Posix::default_stack_size()` | ★ stack_size 平台默认值 (1MB vs 4MB) |
| 11 | `os_posix.cpp` | `src/hotspot/os/posix/` | `get_initial_stack_size()` | stack_size 计算逻辑 |
| 12 | `globals_linux_x86.hpp` | `src/hotspot/os_cpu/linux_x86/` | `CompilerThreadStackSize`, `ThreadStackSize` | 平台特定 flag 默认值 |

---

## §一 10 线程全景图 — jstack 实测 + 创建时机矩阵

### 1.1 jstack 实测输出

一个只跑 `synchronized(new Object())` 的最小 JVM（8GB 堆, G1GC, mixed mode），`jstack` 输出如下：

```
┌──────┬───────────────────────────────┬──────────────┬──────────┐
│ #    │ jstack 线程名                   │ 分类          │ daemon   │
├──────┼───────────────────────────────┼──────────────┼──────────┤
│ #1   │ "main"                        │ startup       │ false ★  │
│ #2   │ "Reference Handler"           │ startup       │ true     │
│ #3   │ "Finalizer"                   │ startup       │ true     │
│ #4   │ "Signal Dispatcher"           │ startup       │ true     │
│ #5   │ "Service Thread"              │ startup 尾     │ true     │
│ #6   │ "C2 CompilerThread0"          │ runtime       │ true     │
│ #7   │ "C1 CompilerThread0"          │ runtime       │ true     │
│ #8   │ "Sweeper thread"              │ runtime       │ true     │
│ #9   │ "Common-Cleaner"              │ runtime       │ true     │
│ #10  │ "Attach Listener"             │ runtime       │ true     │
└──────┴───────────────────────────────┴──────────────┴──────────┘
```

此后全文用简称: `main`, `RefHandler`, `Finalizer`, `SigDispatcher`, `ServiceThread`, `C2`/`C1`, `Sweeper`, `Cleaner`, `AttachListener`。

> **⚠ 10 线程的前提条件**: 本文的 "10 个系统 JavaThread" 基于默认 JVM 配置：
> - 无 JVMTI agent（`-agentlib:jdwp` 等会额外创建 JavaThread）
> - 非 JVMCI 模式（JVMCI 会创建 `JVMCI CompilerThread` 系列）
> - JDK 11 默认模式（JDK 15+ 的 MonitorDeflationThread 等新线程不在讨论范围）
> - 如果用了 agentlib，jstack 输出的线程数会超过本文描述的 10 条

### 1.2 创建时机矩阵 — startup 5 vs runtime 5

```
┌─────────────────────────┬──────────────────────────────────────────────────┐
│ create_vm() 中直接创建    │ main + RefHandler(隐式) + Finalizer(隐式)         │
│                          │ + SigDispatcher + ServiceThread                  │
│                          │ + C1 CompilerThread0 + C2 CompilerThread0        │
│                          │ + Sweeper (+ AttachListener 条件创建)             │
│ 首次 jcmd 连接触发        │ AttachListener (正常路径不条件创建)                │
│ JDK 内部 Cleaner 机制     │ Common-Cleaner                                    │
└─────────────────────────┴──────────────────────────────────────────────────┘

★ 关键更正：CompilerThread(C1/C2) 和 Sweeper 并非"首次 JIT 编译时"才创建，
  而是在 create_vm() → compilation_init_phase1() → init_compiler_sweeper_threads()
  中就完成创建。只是编译请求要等 compilation_init_phase2() 设置 _initialized=true
  后才被处理。
```

**关键的"为什么"**：

**Q: 为什么需要"系统 JavaThread"？** — JVM 有一些任务必须在 Java 线程上下文中执行（访问堆上对象、持有 `java.lang.Thread` 身份参与 safepoint）。但纯 C++ 代码可以直接用 NonJavaThread（如 WatcherThread）。区分标准见 §四核心对比线。

**Q: 10 条线程怎么被发现的？** — 从 `jstack` 输出反向溯源 → 在每个线程名的构造点打断点 → 逐条追踪到 `create_vm()` 或运行时创建点。

**Q: 为什么 main 是 10 条中唯一的 non-daemon？** — main 不需要显式 `setDaemon(false)`，因为 `java.lang.Thread._daemon` 默认就是 `false`。所有其他系统 JavaThread 在创建时都显式调用了 `java_lang_Thread::set_daemon(thread_oop())`。JVM 退出条件：所有 non-daemon JavaThread 死亡 → main 返回 → `destroy_vm` 启动。

### 1.3 ThreadType 与 stack_size — 同样是 JavaThread，栈差 4 倍

```cpp
// os_linux_x86.cpp:757-765 — 平台默认栈大小
size_t os::Posix::default_stack_size(os::ThreadType thr_type) {
#ifdef AMD64
  size_t s = (thr_type == os::compiler_thread ? 4 * M : 1 * M);
#else
  size_t s = (thr_type == os::compiler_thread ? 2 * M : 512 * K);
#endif
  return s;
}
```

```
┌──────────────────────┬────────────┬──────────────┬────────────────────┐
│ ThreadType            │ AMD64 栈大小│ 使用者        │ 为什么这个大小      │
├──────────────────────┼────────────┼──────────────┼────────────────────┤
│ os::java_thread      │ 1MB        │ 8/10 系统线程  │ 普通 Java 代码 +   │
│                      │            │               │ JNI 调用栈          │
│ os::compiler_thread  │ 4MB ★      │ CompilerThread │ IdealGraph 递归 +   │
│                      │            │               │ 寄存器分配(数百帧)  │
│ os::gc_thread        │ ~512KB     │ GC Worker      │ [08] 纯 C++, 无    │
│                      │            │ (NonJavaThread)│ Java 栈帧           │
│ os::watcher_thread   │ ~512KB     │ WatcherThread  │ [07] PeriodicTask  │
│                      │            │ (NonJavaThread)│ 定时回调, 浅栈       │
└──────────────────────┴────────────┴──────────────┴────────────────────┘
```

★★★ **关键**: ThreadType 不是由"是不是 JavaThread"决定，而是由 `JavaThread` 构造函数中的入口点地址决定：

```cpp
// thread.cpp:1861-1865 — JavaThread 构造中的 ThreadType 判定
os::ThreadType thr_type = os::java_thread;
thr_type = entry_point == &compiler_thread_entry ? os::compiler_thread :
           os::java_thread;
os::create_thread(this, thr_type, stack_sz);
```

这是一个容易被忽略的设计细节 — 面试追问："JavaThread 栈大小默认多少？" → 错误答案: 1MB → 正确答案: **取决于 ThreadType！CompilerThread 是 4MB，其余 1MB**。

### 1.4 daemon 标记 + JVM 退出协议

```cpp
// thread.cpp:4012-4014 — create_vm() 开头初始化计数器
_thread_list = NULL;
_number_of_threads = 0;
_number_of_non_daemon_threads = 0;

// thread.cpp:4730-4740 — Threads::add() 中追踪 daemon 状态
bool daemon = true;
if ((!force_daemon) && !is_daemon((threadObj))) {
    _number_of_non_daemon_threads++;
    daemon = false;
}

// thread.cpp:4787-4795 — Threads::remove() 中触发退出条件
if (!is_daemon) {
    _number_of_non_daemon_threads--;
    if (number_of_non_daemon_threads() == 1) {
        Threads_lock->notify_all(); // 唤醒 destroy_vm 的等待者
    }
}

// thread.cpp:4613-4619 — destroy_vm 等待最后一个 non-daemon 死亡
while (Threads::number_of_non_daemon_threads() > 1)
    Threads_lock->wait(!Mutex::_no_safepoint_check_flag, 0,
                       Mutex::_as_suspend_equivalent_flag);
```

**JVM 退出协议的全流程**：

1. `main()` 方法返回 → `JavaThread::exit()` 被调用
2. `exit()` → `Threads::remove(this)` → `_number_of_non_daemon_threads` 减到 1
3. 唤醒 `destroy_vm` → 遍历所有线程 → 通知终止
4. WatcherThread::stop(), WorkerThread::stop(), G1ConcurrentMarkThread::stop()
5. 等所有线程退出 → `_exit(0)`

**如果 main 死循环不退出** → JVM 永不退出（其他 9 条是 daemon，它们的存在不影响退出条件）→ 需要 `kill -9`。

---

## §二 startup 5 线程 — `Threads::create_vm()` 走读

```
★★★ create_vm() 中线程创建的全时间线：

create_vm() 入口 (thread.cpp:3886):
  │
  ├─ L4034: main → new JavaThread() → 附加到当前 OS 线程
  │          ★ 唯一 non-daemon
  │
  ├─ L4107: VMThread → VMThread::create() → os::create_thread(vm_thread, os::vm_thread)
  │          ★ [07-VMThread] 详述 — 所有 VMOperation 的执行者
  │
  ├─ L4152: initialize_java_lang_classes() → L3854:
  │    initialize_class(java_lang_ref_Finalizer)
  │    → 类层级: Finalizer extends FinalReference extends Reference
  │    → ★ JVM 规范: 父类 <clinit> 先于子类
  │    → ① Reference.<clinit> → JVM_StartThread → "Reference Handler"
  │    → ② Finalizer.<clinit> → JVM_StartThread → "Finalizer"
  │
  ├─ L4181: SignalDispatcher → os::initialize_jdk_signal_support()
  │
  ├─ L4187: AttachListener (条件: -XX:+StartAttachListener 时才立即创建)
  │
  ├─ L4205: ServiceThread → ServiceThread::initialize()
  │
  ├─ L4227: CompileBroker::compilation_init_phase1()
  │    → L665: init_compiler_sweeper_threads() — ★ 这里就创建了!
  │      L890: sprintf("C2 CompilerThread%d") → C2 CompilerThread0
  │      L911: sprintf("C1 CompilerThread%d") → C1 CompilerThread0
  │      L935: create_thread_oop("Sweeper thread") → Sweeper
  │    → L4231: compilation_init_phase2() → _initialized=true (此时才接受编译请求)
  │
  └─ L4330: WatcherThread (条件: PeriodicTask::num_tasks() > 0)
       ★ NonJavaThread，[07] 详述
```

### 2.1 main — 唯一 non-daemon，JVM exit 的触发器

**创建入口**: `thread.cpp:4034`

```cpp
JavaThread *main_thread = new JavaThread();       // 默认构造函数
main_thread->set_thread_state(_thread_in_vm);
main_thread->initialize_thread_current();         // 绑定到当前 OS 线程
main_thread->record_stack_base_and_size();
main_thread->register_thread_stack_with_NMT();
main_thread->set_active_handles(JNIHandleBlock::allocate_block());
if (!main_thread->set_as_starting_thread()) {     // 创建 OSThread 并附加
    /* error handling */
}
main_thread->create_stack_guard_pages();
```

**关键差异**：main 线程**不是通过 JVM_StartThread 创建的**。

- 其他 9 条系统线程都走 `JVM_StartThread` 路径 → 先有 `java.lang.Thread` 对象，再关联 C++ `JavaThread`
- main 是 `create_vm` 在 JNI 调用的 OS 线程上原地构造 `JavaThread` C++ 对象 → 然后通过 `initialize_java_lang_classes()` 中调用 `create_initial_thread()` (thread.cpp:1191-1214) 创建 Java 层 `java.lang.Thread` 对象

**`create_initial_thread()` 的特殊之处** (thread.cpp:1191-1214):

```cpp
static oop create_initial_thread(Handle thread_group, JavaThread *thread, TRAPS) {
    InstanceKlass *ik = SystemDictionary::Thread_klass();
    instanceHandle thread_oop = ik->allocate_instance_handle(CHECK_NULL);

    // ★ 关键: 必须在调 Thread.<init>() 之前注入 C++ 对象
    // 因为 Thread.<init>() 内部会调用 Thread.current() → 需要返回已绑定的 JavaThread
    java_lang_Thread::set_thread(thread_oop(), thread);
    java_lang_Thread::set_priority(thread_oop(), NormPriority);
    thread->set_threadObj(thread_oop());

    // 然后调 Thread.<init>(ThreadGroup threadGroup, String name)
    JavaCalls::call_special(&result, thread_oop, ik,
        vmSymbols::object_initializer_name(),
        vmSymbols::threadgroup_string_void_signature(),
        thread_group, string, CHECK_NULL);
    return thread_oop();
}
```

这意味着 main 的 `JavaThread` C++ 对象先于 Java 层 `Thread` 对象存在，而其他 JavaThread 相反 — Java 层 Thread 对象先创建（通过 `new Thread()`），再在 `JVM_StartThread` 中创建 C++ `JavaThread`。

**daemon**: `false` — `java.lang.Thread._daemon` 默认就是 `false`，main 不需要显式设置

**main() 的执行入口**：`create_vm()` 返回 `JNI_OK` 后 → `java.c` 中的 `CallStaticVoidMethod(env, mainClass, mainID, mainArgs)` 通过 JNI 调用 `main(String[])`

**死亡后果**: JVM exit — 不可幸存

### 2.2 ReferenceHandler — ReferenceQueue 消费者

**创建入口（C++ 触发链）**: `thread.cpp:3854` `initialize_class(vmSymbols::java_lang_ref_Finalizer(), CHECK)` → 触发 `Finalizer` 类加载 → JVM 规范要求父类 `<clinit>` 先执行 → 触发 `Reference.<clinit>` → Java 层 `new Thread(new ReferenceHandler()).start()` → JVM 层 `JVM_StartThread` → `jvm.cpp:2934`

```java
// JDK 层伪代码 (java.lang.ref.Reference)
static {
    Thread handler = new ReferenceHandler(ThreadGroup, "Reference Handler");
    handler.setDaemon(true);
    handler.start();
}
```

**Java 入口**: `ReferenceHandler.run()` — 死循环

```
ReferenceHandler.run():
  while (true) {
    synchronized (ReferenceQueue.LOCK) {
      ReferenceQueue.removeLocked();    // 从 pending list 取出 Reference
      processPendingReferences();       // 入队到各自的 ReferenceQueue
    }
  }
```

**C++ 层 mapped 类**: `java_lang_ref_Reference` (`javaClasses.cpp`)

**daemon**: `true` — Java 层 `setDaemon(true)`

**为什么是 JavaThread？** → 全 Java 实现，无 C++ 特殊逻辑。Reference 处理需要访问 Java 堆上的 `ReferenceQueue` / `Reference` 对象。

**死亡后果**: **致命 — SoftRef 永远不入队 → IndirectBuffer 泄漏 → Native OOM！**

ReferenceHandler 是 Reference 入队的唯一入口。它死掉意味着：
1. `SoftReference` 对应的 Java 堆对象可以被 GC 回收，但 `SoftReference` 自身不会被 Cleaner 清理
2. `DirectByteBuffer` 的 cleaner 依赖于 `PhantomReference` 的入队机制
3. 结果：直接内存（堆外内存）永不释放 → 最终 OOM

### 2.3 Finalizer — finalize() 执行器

**创建入口（C++ 触发链）**: `thread.cpp:3854` `initialize_class(vmSymbols::java_lang_ref_Finalizer(), CHECK)` → `Finalizer.<clinit>` → Java 层 `new Thread(new FinalizerThread()).start()` → JVM 层 `JVM_StartThread`

```java
// JDK 层伪代码
static {
    Thread ft = new FinalizerThread(ThreadGroup);
    ft.setDaemon(true);
    ft.start();
}
```

**Java 入口**: `FinalizerThread.run()` — 死循环

```
FinalizerThread.run():
  while (true) {
    Finalizer f = (Finalizer) queue.remove();  // 从 ReferenceQueue 取
    f.get().finalize();                        // 调用对象的 finalize() 方法
  }
```

**为什么必须在 ReferenceHandler 之后创建？**

创建顺序 = start 顺序。ReferenceHandler 先把 Reference 从 pending list 入队到各自的 ReferenceQueue。Finalizer 从 `FinalizerReferenceQueue` 中取 Reference → 调用 `finalize()`。如果 Finalizer 先启动 → 队列为空 → 空转 → 等 ReferenceHandler 入队后才能工作。但这个"错误顺序"不会导致崩溃 — 只是因为入队没完成而多空转几个周期。

**daemon**: `true`

**JDK 9+ 变化**: Cleaner 机制渐取代 Finalizer
- Finalizer 不可控：用户重写 `finalize()` 可能卡住或抛异常
- Cleaner 是显式注册的 `Runnable` → 生命周期可管理
- Cleaner 用的是 PhantomReference，不是 FinalReference

**死亡后果**: `finalize()` 永不调用 — 但 Cleaner 已接管大部分职责，JDK 9+ 已逐步降低对 Finalizer 的依赖。

### 2.4 SignalDispatcher — 信号分发线程

**创建入口**: `thread.cpp:4181` → `os::initialize_jdk_signal_support()` → `os.cpp:477-524`

```cpp
// os.cpp:477-524 — SignalDispatcher 创建
void os::initialize_jdk_signal_support(TRAPS) {
  if (!ReduceSignalUsage) {
    const char thread_name[] = "Signal Dispatcher";
    // 创建 java.lang.Thread oop
    Handle thread_oop = JavaCalls::construct_new_instance(
        SystemDictionary::Thread_klass(), ...);
    // ...
    { MutexLocker mu(Threads_lock);
      JavaThread* signal_thread = new JavaThread(&signal_thread_entry);
      java_lang_Thread::set_thread(thread_oop(), signal_thread);
      java_lang_Thread::set_daemon(thread_oop());
      signal_thread->set_threadObj(thread_oop());
      Threads::add(signal_thread);
      Thread::start(signal_thread);
    }
  }
}
```

**C++ 循环**: `os.cpp:346-415` — `signal_thread_entry()`

```
signal_thread_entry():
  while (true) {
    sig = os::signal_wait();                    // 阻塞等待信号
    if (sig == sigexitnum_pd()) return;         // 终止信号
    switch (sig) {
      case SIGBREAK:                            // Ctrl-\ 或 kill -3
        if (AttachListener::transit_state(AL_INITIALIZING, AL_NOT_INITIALIZED) == AL_INITIALIZING)
          continue;                             // 触发 AttachListener 初始化
        VM_PrintThreads op;                     // 否则打印线程 dump
        VMThread::execute(&op);
        VM_PrintJNI jni_op;
        VMThread::execute(&jni_op);
        VM_FindDeadlocks op1(tty);
        VMThread::execute(&op1);
        Universe::print_heap_at_SIGBREAK();
        break;
    }
  }
```

**为什么是 JavaThread？** → `sun.misc.Signal.handle()` 在 Java 层注册回调 → native 层 `os::signal()` 捕获到信号后 → 通过 SignalDispatcher 线程分发 → 调用 Java 层的 `Signal.dispatch()` → 最终执行用户注册的 `SignalHandler.handle()`。这条调用链需要 Java 栈帧 → JNI HandleBlock → Java 调用约定 → 必须继承 JavaThread。

**daemon**: `true`

**死亡后果**: Ctrl+\ 或 `kill -3` 无响应 → 必须 `kill -9` 强制终止

### 2.5 ★ 创建顺序约束分析

```
create_vm 中线程创建的约束链:

① main: 必须先于一切 — 它是执行 create_vm 的线程，没有它就没有 create_vm
② VMThread: 必须在 Java 类初始化之前 — SignalDispatcher 的信号分发会用 VMThread::execute()
③ Reference.<clinit> 先于 Finalizer.<clinit>:
    → 触发点: thread.cpp:3854 initialize_class(java_lang_ref_Finalizer)
    → JVM 规范: 加载 Finalizer → 先初始化父类 FinalReference → 再初始化 Reference
    → 因此 Reference.<clinit> 先于 Finalizer.<clinit> 执行
    → ReferenceHandler 先入队 → Finalizer 后取用
④ SignalDispatcher: 必须在 VMInit 事件之前 — os.cpp 注释明确: "Signal Dispatcher
   needs to be started before VMInit event is posted"
⑤ ServiceThread: 必须在编译器之前 — JVMTI 编译事件通过 ServiceThread 入队，
   serviceThread.cpp:156 assert(_instance!=NULL) 验证此约束
⑥ CompileBroker::compilation_init_phase1(L4227) → init_compiler_sweeper_threads(L665):
   在此创建 C1/C2 CompilerThread + Sweeper (线程全创建，但编译请求等 phase2(L4231)
   设置 _initialized=true 后才处理)
```

**违反约束的最小后果**：Finalizer 先于 ReferenceHandler 创建不会崩溃，只会空转（ReferenceQueue 为空）。但如果 ServiceThread 晚于编译器创建 → JVMTI 编译方法加载事件丢失（`enqueue_deferred_event` 的 assert 触发）。

---

## §三 runtime 5 线程 — 延迟/按需创建

> ★ 注意: CompilerThread(C1/C2) 和 Sweeper 虽然在 `create_vm()` 中就创建了
> （见 §二时间线），但它们是在 `compilation_init_phase1()` 创建的，属于 JVM
> 初始化的后期阶段，不完全等同于"一启动就有"。且它们的生命周期是动态的：
> CompilerThread 在 `UseDynamicNumberOfCompilerThreads` 下可以被动态删除和重建。
> 因此这里仍然将它们放在 runtime 分类下，与真正的 startup 早期线程区分。

**都不创建行不行？**

- **CompilerThread 不创建** (`-Xint` / `!UseCompiler`) → 纯解释执行，程序不崩，但永远不 JIT → 性能退化 20-50x
- **Sweeper 不创建** (`-XX:-MethodFlushing` 或 `!UseCompiler`) → Zombie/NotEntrant nmethod 累积 → CodeCache 满 → JIT 编译被迫停止 → 纯解释
- **Cleaner 不创建** → DirectByteBuffer 永不释放 → Native OOM
- **AttachListener 不创建** → jcmd/jstack/jmap 连不上 — 但不影响 JVM 核心功能

### 3.1 ServiceThread — 低内存检测 + JVMTI 事件循环

**创建入口**: `thread.cpp:4205` → `ServiceThread::initialize()` → `serviceThread.cpp:51-88`

```cpp
// serviceThread.cpp:51-88
void ServiceThread::initialize() {
  const char* name = "Service Thread";
  // 创建 java.lang.Thread oop → 放入 system threadGroup
  Handle thread_oop = JavaCalls::construct_new_instance(
      SystemDictionary::Thread_klass(), ...);
  { MutexLocker mu(Threads_lock);
    ServiceThread* thread = new ServiceThread(&service_thread_entry);
    java_lang_Thread::set_daemon(thread_oop());       // daemon = true
    java_lang_Thread::set_priority(thread_oop(), NearMaxPriority);
    thread->set_threadObj(thread_oop());
    _instance = thread;                                // ★ 单例
    Threads::add(thread);
    Thread::start(thread);
  }
}
```

**C++ 循环**: `serviceThread.cpp:90-148` — `service_thread_entry()`

```
service_thread_entry():
  while (true) {
    // 持有 Service_lock, ThreadBlockInVM 状态 (可参与 safepoint)
    {
      ThreadBlockInVM tbivm(jt);
      MutexLockerEx ml(Service_lock, Mutex::_no_safepoint_check_flag);
      while (!任何工作)
        Service_lock->wait(Mutex::_no_safepoint_check_flag);
    }

    if (stringtable_work)     StringTable::do_concurrent_work(jt);
    if (has_jvmti_events)     jvmti_event->post();            // JVMTI 编译方法加载事件
    if (sensors_changed)      LowMemoryDetector::process_sensor_changes(jt);
    if (has_gc_notification)  GCNotifier::sendNotification(CHECK);
    if (has_dcmd_event)       DCmdFactory::send_notification(CHECK);
  }
```

**为什么是 JavaThread？** → `LowMemoryDetector::process_sensor_changes()` 需要创建 Java `OutOfMemoryError` 对象 → 对象在 Java 堆上 → 需要访问堆 → 必须 JavaThread。

**自愈机制分析**：

ServiceThread 在 `create_vm()` 尾部通过 `ServiceThread::initialize()` 创建一次。它**没有独立的 watchdog 做重启**。但它的循环结构天然具备"功能性自愈"：

1. 如果 ServiceThread 在处理 OOP 时 crash → JVM 整体 crash（因为所有 JavaThread 都受 safepoint 保护）
2. 如果 ServiceThread 只是死锁在 `Service_lock` 上 → LowMemoryDetector + JVMTI 事件不处理，但 JVM 不 crash
3. 对比 WorkerThread 的 crash（[08 §五]）：Worker 挂了 → `signal_task_done()` 不被调用 → GC hang

**daemon**: `true`

**死亡后果**: LowMemoryDetector 不触发, JVMTI 编译方法加载事件丢失, StringTable 不清理, GC 通知不发送。JVM 不崩溃但部分功能退化。

### 3.2 C1/C2 CompilerThread — ★ 为什么是 JavaThread？

**创建入口**: `create_vm()` → `compilation_init_phase1()` → `init_compiler_sweeper_threads()` → `compileBroker.cpp:864-938`

```cpp
// compileBroker.cpp:884-927 — C2 + C1 CompilerThread 创建
for (int i = 0; i < _c2_count; i++) {
    sprintf(name_buffer, "%s CompilerThread%d", _compilers[1]->name(), i);
    // → "C2 CompilerThread0"
    Handle thread_oop = create_thread_oop(name_buffer, CHECK);
    make_thread(thread_handle, _c2_compile_queue, _compilers[1], CHECK);
}
for (int i = 0; i < _c1_count; i++) {
    sprintf(name_buffer, "C1 CompilerThread%d", i);
    Handle thread_oop = create_thread_oop(name_buffer, CHECK);
    make_thread(thread_handle, _c1_compile_queue, _compilers[0], CHECK);
}
```

**make_thread() 内部**: `compileBroker.cpp:784-843`

```cpp
// compileBroker.cpp:784-843
JavaThread* CompileBroker::make_thread(jobject thread_handle, CompileQueue* queue,
                                       AbstractCompiler* comp, TRAPS) {
  JavaThread* thread = NULL;
  { MutexLocker mu(Threads_lock, THREAD);
    if (comp != NULL) {
      CompilerCounters* counters = new CompilerCounters();
      thread = new CompilerThread(queue, counters);      // ★ C1/C2 使用 CompilerThread
    } else {
      thread = new CodeCacheSweeperThread();              // ★ Sweeper 线程
    }
    if (thread != NULL && thread->osthread() != NULL) {
      java_lang_Thread::set_daemon(thread_handle);          // daemon = true
      java_lang_Thread::set_priority(thread_handle, NearMaxPriority);
      os::set_native_priority(thread, native_prio);         // 原生高优先级
      Threads::add(thread);
      Thread::start(thread);
    }
  }
  return thread;
}
```

**C++ 循环**: `compileBroker.cpp:1828-1901` — `compiler_thread_loop()`

```
compiler_thread_loop():
  // 初始化 ciObjectFactory (第一个到达的 CompilerThread 完成)
  { MutexLocker only_one(CompileThread_lock);
    if (!ciObjectFactory::is_initialized()) ciObjectFactory::initialize();
  }

  while (!is_compilation_disabled_forever()) {
    CompileTask* task = queue->get();        // 从 CompileQueue 取编译任务
    if (task == NULL) {
      if (UseDynamicNumberOfCompilerThreads && can_remove(this, true)) {
        // 空闲超时的 CompilerThread 可以被动态删除
        return;                              // ★ 线程自行退出
      }
    } else {
      thread->set_task(task);                // 设置当前任务
      task->compile();                       // ★ 执行 C1 或 C2 编译
      thread->set_task(NULL);
    }
  }
```

**★★★ 为什么是 JavaThread？（本文核心对比点）**

> 一个线程归 JavaThread 还是 NonJavaThread，**不取决于"是不是系统线程"**，而取决于 **「是否需要访问 Java 堆」**。

CompilerThread 需要访问：
- **类元数据 (InstanceKlass)** — 在 Java 堆上
- **常量池 (ConstantPool)** — 在 Java 堆上
- **方法数据 (Method/MethodData)** — 在 Java 堆上

GC 期间这些数据可能被移动（Evacuation / Compaction）。如果 CompilerThread 是 NonJavaThread：
- GC 移动对象 → CompilerThread 持有 dangling pointer → **CRASH**

所以 CompilerThread **必须是 JavaThread** → GC 前被 safepoint 暂停 → GC 完成后恢复 → 永远不会看到移动中的对象。

**代价**: 编译期间可能被 GC 卡住（但优先保证正确性）。

**为什么 CompilerThread 要 4MB 栈？** — 编译器栈帧深：
- IR 构建（理想图 IdealGraph → 递归遍历）
- 寄存器分配（Chaitin-Briggs 图着色 → 深度优先遍历）
- 内联分析（递归展开虚方法调用链）

**构造函数中的 ThreadType 判定**: `thread.cpp:3618-3635`

```cpp
CompilerThread::CompilerThread(CompileQueue *queue, CompilerCounters *counters)
    : JavaThread(&compiler_thread_entry) {     // ★ 传入 compiler_thread_entry 地址
  _env = NULL; _log = NULL; _task = NULL;
  _queue = queue; _counters = counters; _buffer_blob = NULL; _compiler = NULL;
  resource_area()->bias_to(mtCompiler);        // ResourceMark 偏向 mtCompiler
}
```

然后在 `JavaThread` 构造中：
```cpp
// thread.cpp:1861-1865
os::ThreadType thr_type = os::java_thread;
thr_type = entry_point == &compiler_thread_entry ? os::compiler_thread :
           os::java_thread;
```

`os::compiler_thread` 类型 → `os_linux_x86.cpp:760` → `4 * M` = 4MB 栈。

**默认数量**: Tiered Compilation 开启 → C1 × 1 + C2 × 1（可通过 `-XX:CICompilerCount=N` 调整）

**daemon**: `true`

**死亡后果**: 纯解释执行（性能退化 20-50x），但**程序不崩溃**！— 这是 CompilerThread 死亡和 ReferenceHandler 死亡的本质区别。

**对比 `-Xint`**: 纯解释模式下 `compilation_init_phase1()` 在 `!UseCompiler` 检查 (L618) 直接返回 → CompilerThread + Sweeper 都不创建 → 10 线程 → 8 线程

### 3.3 Sweeper — 被"冤枉"为 JavaThread 的扫雪工

**创建入口**: `create_vm()` → `compilation_init_phase1()` → `init_compiler_sweeper_threads()` → `compileBroker.cpp:933-937`

```cpp
// compileBroker.cpp:933-937 — Sweeper 线程创建
if (MethodFlushing) {
    Handle thread_oop = create_thread_oop("Sweeper thread", CHECK);
    jobject thread_handle = JNIHandles::make_local(THREAD, thread_oop());
    make_thread(thread_handle, NULL, NULL, CHECK);  // comp==NULL → CodeCacheSweeperThread
}
```

`make_thread` 中 `comp == NULL` 分支 → `new CodeCacheSweeperThread()`

**构造函数**: `thread.cpp:3647-3649`
```cpp
CodeCacheSweeperThread::CodeCacheSweeperThread()
    : JavaThread(&sweeper_thread_entry) {
  _scanned_compiled_method = NULL;
}
```

**C++ 循环**: `sweeper.cpp:265-275` — `NMethodSweeper::sweeper_loop()`

```
sweeper_loop():
  while (true) {
    {
      ThreadBlockInVM tbivm(JavaThread::current());
      MutexLockerEx waiter(CodeCache_lock, Mutex::_no_safepoint_check_flag);
      const long wait_time = 60*60*24 * 1000;     // 24 hours max wait
      timeout = CodeCache_lock->wait(..., wait_time);
    }
    if (!timeout) {
      possibly_sweep();                            // 遍历 CodeCache, 清理 zombie
    }
  }
```

**功能**: 遍历 CodeCache 中的所有 nmethod → 清理 zombie (无人用的死方法) → 回收 CodeCache 空间

**为什么是 JavaThread？** → 同 CompilerThread — 需要访问类元数据/方法数据。Sweeper 扫描 nmethod 时需要知道哪些 `Method*` 还活着，这些都指向 Java 堆。

**daemon**: `true`

**死亡后果**: zombie nmethod 累积 → CodeCache 满 → `CompilationPolicy::can_be_compiled()` 返回 false → JIT 停止 → 纯解释 → 性能退化

### 3.4 Common-Cleaner — JDK 9+ Finalizer 替代品

**创建入口**: JDK 层 `java.lang.ref.Cleaner` 机制驱动

```
JDK Cleaner 架构:
  Cleaner = PhantomReference + ReferenceQueue + CleanerThread

  Cleaner.create():
    → new Cleaner() → register PhantomReference
    → CleanerThread.run(): 死循环
        → cleaner.clean() → 执行清理 Runnable
```

**为什么新增？** → 替代 Finalizer:
- Finalizer 不可控（用户重写 `finalize()` 可能卡住或抛异常）
- Cleaner 是显式注册的 `Runnable` → 生命周期可管理
- Cleaner 用的是 PhantomReference，不是 FinalReference

**daemon**: `true`

**死亡后果**: DirectByteBuffer 泄漏 → Cleaner 挂了后，DirectByteBuffer 分配失败时会触发 fallback: `java.nio.Bits.reserveMemory()` → `System.gc()` 尝试回收，但这是最后手段。

### 3.5 AttachListener — UNIX socket → jcmd 命令解析

**创建入口**: `attachListener.cpp:435-487` — `AttachListener::init()`

```cpp
// attachListener.cpp:435-487
void AttachListener::init() {
  const char thread_name[] = "Attach Listener";
  // 创建 java.lang.Thread oop
  Handle thread_oop = JavaCalls::construct_new_instance(
      SystemDictionary::Thread_klass(), ...);
  { MutexLocker mu(Threads_lock);
    JavaThread* listener_thread = new JavaThread(&attach_listener_thread_entry);
    java_lang_Thread::set_daemon(thread_oop());
    listener_thread->set_threadObj(thread_oop());
    Threads::add(listener_thread);
    Thread::start(listener_thread);
  }
}
```

**触发机制**: 三种方式触发 AttachListener 创建：
1. `-XX:+StartAttachListener` — create_vm 中立即创建 (thread.cpp:4186-4187)
2. 信号触发 — `SignalDispatcher` 收到 SIGBREAK → 检查是否有 attach 请求 → `AttachListener::transit_state(AL_INITIALIZING, AL_NOT_INITIALIZED)` → `AttachListener::init()`
3. 延迟初始化 — `AttachListener::init_at_startup()` 返回 true → create_vm 中创建

**C++ 循环**: `attachListener.cpp:348-417`

```
attach_listener_thread_entry():
  os::set_priority(thread, NearMaxPriority);

  if (AttachListener::pd_init() != 0) {    // 创建 UNIX socket
    AttachListener::set_state(AL_NOT_INITIALIZED);
    return;
  }
  AttachListener::set_initialized();

  for (;;) {
    AttachOperation* op = AttachListener::dequeue();  // accept() + 读取命令
    if (op == NULL) return;

    // 命令分发:
    if (strcmp(op->name(), "detachall") == 0)        AttachListener::detachall();
    else if (strcmp(op->name(), "load") == 0)        ... // agent 加载
    else {
      // 在 funcs[] 数组中查找命令 → 执行:
      //   "threaddump" → print_threads()
      //   "dumpheap"   → heap_dumper()
      //   "inspectheap"→ heap_inspection()
      //   "setflag"    → set_bool_flag()
      //   "jcmd"       → jcmd()
      //   ...
      op->complete(res, &st);                      // 返回结果给客户端
    }
  }
```

**为什么是 JavaThread？** → jcmd 命令执行时需要触发 VMOperation（线程 dump 等）→ 需要在 JavaThread 上下文中才能正确切换线程状态 → `ThreadBlockInVM` / `ThreadInVMfromNative` 转换。

**daemon**: `true`

**死亡后果**: jcmd/jstack/jmap 连不上 — 但不影响 JVM 核心功能。超时后可通过 SIGBREAK 重新触发创建。

---

## §四 ★ 核心对比线 — CompilerThread(JavaThread) vs WatcherThread(NonJavaThread)

```
★★★ "凭什么两条都是系统线程，一条归 JavaThread、一条归 NonJavaThread？"

┌─────────────────────┬──────────────────────┬───────────────────────────┐
│ 维度                  │ CompilerThread       │ WatcherThread              │
│                      │ (JavaThread)         │ (NonJavaThread)            │
├─────────────────────┼──────────────────────┼───────────────────────────┤
│ 访问 Java 堆          │ ★ 是 — 类元数据/常量池│ 否 — 只访问 JVM C heap    │
│                      │ Method/MethodData     │ PeriodicTask 列表          │
│ safepoint 行为        │ ★ 被暂停 — GC 前必须  │ 不受影响 — 继续执行        │
│                      │   停止编译            │ 时间回调仍然精准            │
│ _thread_list 上?      │ ★ 是 — ThreadSMR 保护│ 否 — 自行管理              │
│ 执行 Java 代码        │ 否 — 全 C++ 代码    │ 否 — 全 C++ 代码           │
│ JNI handle block      │ 有 — AbstractCompiler│ 无                         │
│                      │   用 ciObjectFactory   │                           │
│ threadObj (Java层对象) │ 有                     │ 无                         │
│ 分类的本质原因         │ "需要访问 Java 堆"    │ "不需要，避免被 GC 卡住"    │
│ daemon 标记           │ true                  │ 不适用 (不是 JavaThread)   │
│ 挂了                  │ 纯解释(不崩溃)        │ PeriodicTask 不执行         │
│ stack_size            │ 4MB (compiler_thread) │ ~512KB (watcher_thread)    │
│ ThreadType            │ os::compiler_thread   │ os::watcher_thread         │
│ is_hidden_from_ext    │ true (!can_call_java)│ 不适用                     │
└─────────────────────┴──────────────────────┴───────────────────────────┘
```

### 4.1 核心认知 — "堆访问权 = safepoint 的负担"

这是 JVM 线程分类中**最关键的 tradeoff**：

```
如果你需要读取 Java 堆上的数据 (InstanceKlass, ConstantPool, MethodData):
  → 你必须继承 JavaThread
  → 你获得「堆访问权」
  → 但代价是「每次 GC 时必须被 safepoint 暂停」
  → 编译可能被 GC 卡住

如果你只需要访问 C heap 上的数据 (PeriodicTask 列表, 计数器):
  → 你可以继承 NonJavaThread
  → 你永远不需要被 GC 暂停
  → 但你不能访问任何 Java 堆上的 OOP
  → 你也不能持有 Java 层的线程对象
```

**CompilerThread 归 JavaThread 的本质原因**：不取决于"是不是 JVM 自己创建的"，而是 **GC 期间需要保证指针安全**。如果你看到 CompilerThread 是 NonJavaThread，GC 移动 `InstanceKlass` → CompilerThread 持有 dangling pointer → 下次访问 → SEGV。

**WatcherThread 归 NonJavaThread 的本质原因**：它只访问 C heap 上的 `PeriodicTask` 对象，不碰 Java 堆。作为 NonJavaThread 的好处是 GC 期间 PeriodicTask 回调仍然精准触发（不受 safepoint 卡顿影响）。

### 4.2 如果反过来设计会怎样？

```
场景 A: CompilerThread 是 NonJavaThread
  GC 移动 InstanceKlass → 编译器持有 dangling pointer
  → 下次 ciInstanceKlass::java_mirror() → SEGV → JVM CRASH
  → 结论: 不可行

场景 B: WatcherThread 是 JavaThread
  GC 期间 WatcherThread 被 safepoint 暂停
  → PeriodicTask 的 10ms 定时回调变成 10ms + GC 暂停时间
  → 时间敏感任务 (如 Profiling) 精度下降
  → 结论: 可用但精度降低，无必要
```

### 4.3 扩展：被"冤枉"的 JavaThread — ServiceThread 和 Sweeper

```
┌──────────────────────┬──────────────────────┬──────────────────────┐
│ ServiceThread        │ 必须 JavaThread       │ low_memory_detect    │
│                      │                      │ 需要创建 OOME 对象    │
│ Sweeper              │ 必须 JavaThread       │ 扫描 nmethod 时需要  │
│                      │                      │ 识别 live Method*    │
│ AttachListener       │ 必须 JavaThread       │ jcmd 执行 VMOperation │
│                      │                      │ 需要线程状态转换       │
│ SignalDispatcher     │ 必须 JavaThread       │ 分发 Java 层的        │
│                      │                      │ SignalHandler 回调    │
└──────────────────────┴──────────────────────┴──────────────────────┘
```

这些线程都有一个共同特征：它们不执行 Java 字节码，但它们的 C++ 代码**间接访问 Java 堆** → 必须继承 JavaThread → 受 safepoint 约束。

---

## §五 死亡后果分析矩阵

```
┌─────────────────┬──────────────────────────────────────────┬──────────┐
│ 线程             │ 死亡后果                                  │ 致命度    │
├─────────────────┼──────────────────────────────────────────┼──────────┤
│ main            │ JVM exit — 所有 non-daemon 死亡触发       │ ☠ 致命    │
│                 │ destroy_vm                                │          │
├─────────────────┼──────────────────────────────────────────┼──────────┤
│ ReferenceHandler│ SoftRef 永不入队 → DirectByteBuffer 泄漏  │ ☠ 致命    │
│                 │ → Native OOM                             │          │
├─────────────────┼──────────────────────────────────────────┼──────────┤
│ Finalizer       │ finalize() 永不调用                        │ ⚠ 退化    │
│                 │ 但 Cleaner 已接管大部分职责                 │          │
├─────────────────┼──────────────────────────────────────────┼──────────┤
│ SignalDispatcher│ Ctrl+\ / kill -3 无响应                    │ ⚠ 退化    │
│                 │ 必须 kill -9 终止                          │          │
├─────────────────┼──────────────────────────────────────────┼──────────┤
│ ServiceThread   │ LowMemoryDetector 不触发                   │ ⚠ 退化    │
│                 │ JVMTI 事件丢失, StringTable 不清理          │          │
│                 │ JVM 不 crash 但部分功能退化                 │          │
├─────────────────┼──────────────────────────────────────────┼──────────┤
│ C2 CompilerThr0 │ 纯解释执行 — 性能退化 20-50x               │ ⚠ 退化    │
│                 │ ★ 程序不崩溃!                              │          │
├─────────────────┼──────────────────────────────────────────┼──────────┤
│ C1 CompilerThr0 │ 纯解释执行 — 性能退化 20-50x               │ ⚠ 退化    │
│                 │ ★ 程序不崩溃!                              │          │
├─────────────────┼──────────────────────────────────────────┼──────────┤
│ Sweeper         │ Zombie nmethod 累积 → CodeCache 满         │ ⚠ 退化    │
│                 │ → JIT 被迫停止 → 纯解释 → 性能退化          │          │
├─────────────────┼──────────────────────────────────────────┼──────────┤
│ Common-Cleaner  │ DirectByteBuffer 泄漏                      │ ⚠ 退化    │
│                 │ fallback: System.gc() 尝试回收              │          │
├─────────────────┼──────────────────────────────────────────┼──────────┤
│ AttachListener  │ jcmd/jstack/jmap 连不上                    │ ✅ 无感    │
│                 │ JVM 核心功能完全不受影响                     │          │
│                 │ 超时后可通过 SIGBREAK 重新创建               │          │
└─────────────────┴──────────────────────────────────────────┴──────────┘
```

**致命 vs 退化 vs 无感 的分类维度**：
- **致命**: JVM exit 或 Native OOM → 程序无法继续
- **退化**: 功能退化但不 crash → 性能/部分功能受影响
- **无感**: 核心功能完全不受影响 → 可重新创建

---

## §六 GDB 验证 + 可证伪断言

### 断言 1 — 验证 create_vm 中 startup 线程创建

```
(gdb) break Threads::create_vm
(gdb) run ...
在 create_vm 内设置 watch 点:
(gdb) watch _number_of_threads
(gdb) continue
每触发一次, 用 bt 看调用栈 → 识别哪条线程被添加到 _thread_list

预期: 总计约 10 次触发 (含 NonJavaThread 的 VMThread)
     startup 阶段: main → ReferenceHandler → Finalizer → SignalDispatcher → ServiceThread
     运行时阶段: C1 Compiler → C2 Compiler → Sweeper → Cleaner → AttachListener
```

### 断言 2 — 验证 daemon 标记

```
(gdb) break ServiceThread::initialize
(gdb) p java_lang_Thread::is_daemon(main_thread->threadObj())
    → 预期: false
(gdb) p java_lang_Thread::is_daemon(ServiceThread::_instance->threadObj())
    → 预期: true
(gdb) p Threads::number_of_threads()
    → 预期: 启动后某个时间点 ≈ 17 (含 NonJavaThread)
(gdb) p Threads::number_of_non_daemon_threads()
    → 预期: 1 (只有 main)
```

### 断言 3 — 验证 CompilerThread stack_size

```
# 在 JavaThread(ThreadFunction, size_t) 构造中打条件断点
(gdb) break JavaThread::JavaThread if entry_point == &compiler_thread_entry
(gdb) p entry_point
    → 预期: &compiler_thread_entry = (某地址, 如 0x7ffff6xxxxxx)
(gdb) p thr_type
    → 预期: os::compiler_thread (枚举值 = 4)

验证最终栈大小:
(gdb) p /x stack_sz
    → 预期: 0x0 (req_stack_size==0 → 走 default_stack_size(thr_type) → 4MB)

对比普通 JavaThread (不走 compiler_thread_entry):
(gdb) break thread.cpp:1865 if entry_point != &compiler_thread_entry
(gdb) p thr_type
    → 预期: os::java_thread (枚举值 = 3)
```

### 断言 4 — 验证 _thread_list 上全是 JavaThread

```
(gdb) set $t = Threads::_thread_list
(gdb) while $t != 0
 >printf "name=%s isJavaThread=%d\n", ((JavaThread*)$t)->name(), $t->is_Java_thread()
 >set $t = ((JavaThread*)$t)->next()
 >end

预期输出示例:
  name=main isJavaThread=1
  name=Reference Handler isJavaThread=1
  name=Finalizer isJavaThread=1
  name=Signal Dispatcher isJavaThread=1
  name=Service Thread isJavaThread=1
  name=C2 CompilerThread0 isJavaThread=1
  name=C1 CompilerThread0 isJavaThread=1
  name=Sweeper thread isJavaThread=1
  name=Common-Cleaner isJavaThread=1
  name=Attach Listener isJavaThread=1
  → 共约 10 个, 全部 isJavaThread=1

NonJavaThread (VMThread, GC Worker, Watcher, ConcurrentGC) 不在 _thread_list 上
(它们在各自的 WorkGang / NamedThread 中管理)
```

### 断言 5 — 验证 -Xint 下 CompilerThread 不存在

```
(gdb) break CompileBroker::compile_method
→ 用 -Xint 启动 → 预期: 断点永不触发

或者:
$ java -Xint -XX:+PrintCompilation MyApp
→ 预期: 无任何编译输出

jstack 验证:
$ jstack <pid> | grep -c "Compiler"
→ 预期: 0
```

### 断言 6 — 验证 ThreadType 与 threadObj 一致性

```
(gdb) p os::java_thread         → 预期: 枚举值 0 或某个值
(gdb) p os::compiler_thread     → 预期: 与 java_thread 不同的枚举值
(gdb) p os::vm_thread           → 预期: 又一个不同值

对于 CompilerThread:
(gdb) p ((CompilerThread*)thread)->threadObj()
    → 预期: 非 NULL (JavaThread 有 threadObj)
(gdb) p ((CompilerThread*)thread)->osthread()->thread_type()
    → 预期: os::compiler_thread

对于 WatcherThread:
(gdb) p ((WatcherThread*)thread)->threadObj()
    → 预期: NULL (NonJavaThread 无 threadObj)
(gdb) p ((WatcherThread*)thread)->osthread()->thread_type()
    → 预期: os::watcher_thread
```

### 断言 7 — 验证 CompilerThread 构造函数中的 ThreadType 判定

```
(gdb) break thread.cpp:1861
# 在 JavaThread(ThreadFunction entry_point, size_t stack_sz) 构造中
(gdb) p entry_point
(gdb) p &compiler_thread_entry
当两者相等时:
(gdb) p thr_type
    → 预期: 已赋值为 os::compiler_thread

当两者不等时:
(gdb) p thr_type
    → 预期: 保持 os::java_thread
```

### 断言 8 — 验证 AttachListener 延迟创建

```
# 测试 1: 验证不自动创建
(gdb) break AttachListener::init
→ 启动 JVM 后（不加 -XX:+StartAttachListener）不执行 jcmd → 预期: 断点不触发

# 测试 2: 验证按需创建
→ 执行: jcmd <pid> VM.version → 预期: 断点触发

# 验证状态:
(gdb) p AttachListener::_state
    → 初始值: AL_NOT_INITIALIZED
    → jcmd 连接后值变为: AL_INITIALIZED (2)
```

### 断言 9 — 验证 daemon 计数在 main 退出时触发 destroy_vm

```
(gdb) break thread.cpp:4789  # Threads::remove() 中 _number_of_non_daemon_threads--
(gdb) p _number_of_non_daemon_threads
    → 预期: 从 1 减到 0

然后观察:
(gdb) p Threads_lock->notify_all() 被调用
    → destroy_vm 循环中的 wait() 被唤醒
    → destroy_vm 开始执行
```

### 断言 10 — 验证 ServiceThread 单例模式

```
(gdb) p ServiceThread::_instance
    → 预期: 非 NULL, 只出现一次赋值 (在 ServiceThread::initialize() 中)

(gdb) p ServiceThread::_instance->osthread()->thread_type()
    → 预期: os::java_thread (ServiceThread 继承 JavaThread)
```

---

## §七 总结 — 为什么需要这 10 条线程

```
┌──────────────────────────────────────────────────────────────────────┐
│                        10 条系统 JavaThread 存在的终极理由              │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. main          → JVM 需要一个入口来执行用户代码                     │
│                     (不是"守护"线程，它是被守护的)                       │
│                                                                      │
│  2. RefHandler    → GC 回收的 Reference 没人消费 = 内存泄漏             │
│  3. Finalizer     → finalize() 没人调用 = 资源泄漏                      │
│  4. SigDispatcher → OS 信号没人分发 = Ctrl+C 无效                      │
│                                                                      │
│  5. ServiceThread → 低内存检测 + JVMTI 事件 = 需要周期检查              │
│                                                                      │
│  6. C1 Compiler   → 字节码没人编译 = 纯解释, 慢 50x                    │
│  7. C2 Compiler   → 字节码没人编译 = 纯解释, 慢 50x                    │
│  8. Sweeper       → 编译后死代码没人清理 = CodeCache 满                 │
│                                                                      │
│  9. Cleaner       → DirectByteBuffer 没人释放 = Native OOM            │
│  10. AttachListener→ 运维工具没人接管 = jcmd/jstack 连不上              │
│                                                                      │
│  ★ 这些线程的存在不是"设计者的偏好"，                                  │
│     而是"如果不存在，JVM 会以什么方式失败"的反证。                       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**三条核心认知**：

1. **"系统线程" ≠ "NonJavaThread"** — CompilerThread 和 Sweeper 虽然是 JVM 自己创建的，但因为需要访问 Java 堆，被迫继承 JavaThread。代价是每次 GC 必须被 safepoint 暂停。

2. **daemon 标记是 JVM 的生命线** — main 是唯一 non-daemon → 它返回 → JVM 退出 → 所有守护线程自动结束。如果 AttachListener 是 non-daemon，JVM 永不退出（因为 attach_listener_thread_entry 是死循环）。

3. **10 条线程 = 10 个"如果挂了会怎样"的答案** — 这就是面试官追问的本质：不是问你"有哪些线程"，而是"为什么需要它们"和"挂了会怎样"。ReferentHandler 挂了会 OOM，CompilerThread 挂了只是变慢 — 这个差别就是设计权衡。
