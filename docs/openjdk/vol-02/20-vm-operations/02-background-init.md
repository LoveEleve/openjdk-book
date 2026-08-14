# 02. 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列

> **前置依赖**:[20-vm-operations/01 — "帮我做 GC"——VM_Operation 从提交到执行](openjdk/vol-02/20-vm-operations/01-vm-operation.md):本篇的部分周期任务干的事就是提交 VM 操作(EnableBiasedLockingTask),async 模式派上用场;[17-threads/01 — JVM 里有多少种线程?— Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md):WatcherThread 是 NonJavaThread 不是 JavaThread;[38-perfdata/02 — StatSampler — 谁在周期性刷新计数器](openjdk/vol-02/38-perfdata/02-stat-sampler.md):第一个 PeriodicTask 实例的采样细节
> → **后续**:[27-jni/01 — jobject 在 JVM 内部怎么存的?— JNI Handle 系统](01-handle-system.md)
> 关联域: 16-code-cache(sweeper 线程)、32-jfr(采样器线程)、39-runtime-mon

## 显式请求之外,还有一堆定时家务

上一篇拆完了 VM 操作链: 有请求提交,VMThread 执行。但 JVM 里还有另一类活动——**没有人请求,却周期性发生**的家务: 偏向锁什么时候生效、性能计数器谁在刷新、VM 操作超时了谁来喊停。谁在干这些活?答案是两颗"时钟"下的两批线程: 一批**共用一颗模拟定时器的线程**(WatcherThread + PeriodicTask),一批**自带睡眠循环的独立线程**(JFR 采样器、ServiceThread、CodeCache sweeper)。这篇先把第一颗时钟拆开,再回答一个顺带的问题: 这些后台组件是在启动的哪个时刻、按什么顺序被点亮的。

## 1. 一颗"模拟定时器中断"的线程: WatcherThread

线程转储里有一个叫 **"VM Periodic Task Thread"** 的线程:[实证:](planning/outlines/00-jvm-tools/materials/commands/20-background-init-demo.txt) `"VM Periodic Task Thread" ... waiting on condition`——它的学名叫 **WatcherThread**(thread.hpp:902 起,`name()` 返回 "VM Periodic Task Thread",thread.hpp:930),是 NonJavaThread 家族的一员(17 域),整个 JVM 只有一个实例。它存在的理由写在源码注释里(thread.cpp:1369-1371):

```cpp
// thread.cpp:1369-1371(逐字)
// The watcher thread exists to simulate timer interrupts.  It should
// be replaced by an abstraction over whatever native support for
// timer interrupts exists on the platform.
```

**设计意图: 模拟定时器中断**——HotSpot 选择自己养一个线程来模拟"定时器中断",而不是依赖某个平台的定时器信号机制: 周期醒来"滴答"一下,把时间分发给注册在案的任务。这个线程本身被当作"模拟中断"的抽象层(注释说它将来"should be replaced by an abstraction over whatever native support for timer interrupts exists on the platform")。

### 主循环: 睡到最近的任务到期

WatcherThread 的 `run()`(thread.cpp:1453)出奇地短:

```cpp
// thread.cpp:1453-1505(截取核心,逐字)
void WatcherThread::run() {
  assert(this == watcher_thread(), "just checking");

  this->set_native_thread_name(this->name());
  this->set_active_handles(JNIHandleBlock::allocate_block());
  while (true) {
    assert(watcher_thread() == Thread::current(), "thread consistency check");
    assert(watcher_thread() == this, "thread consistency check");

    // Calculate how long it'll be until the next PeriodicTask work
    // should be done, and sleep that amount of time.
    int time_waited = sleep();

    if (VMError::is_error_reported()) {
      // A fatal error has happened, the error handler(VMError::report_and_die)
      // should abort JVM after creating an error log file. However in some
      // rare cases, the error handler itself might deadlock. Here periodically
      // check for error reporting timeouts, and if it happens, just proceed to
      // abort the VM.
      ...
    }

    if (_should_terminate) {
      // check for termination before posting the next tick
      break;
    }

    PeriodicTask::real_time_tick(time_waited);
  }
  ...
```

两个环节值得注意。一是 **`sleep()` 的时长是算出来的,不是固定 50ms**(thread.cpp:1395-1451): 它先问任务表"离最近的到期任务还有多久"(`PeriodicTask::time_to_wait()`,task.cpp:80-92,取所有任务 `interval - counter` 的最小值),然后在 `PeriodicTask_lock` 上 `wait(remaining)` 精确睡到那个时刻;任务表为空时 `remaining == 0`,一直睡到有人 `enroll` 把它 `unpark`(task.cpp:124-129)。wait 被 spurious 唤醒或新任务插入时,循环重算 remaining 再睡(thread.cpp:1435-1446)。二是 **`real_time_tick(time_waited)` 把"这次睡了多久"当作参数传给任务表**——时间累积的职责在任务那边,WatcherThread 只负责报告。

### 优先级: 给到 Java 线程最高档

构造时 `os::set_priority(this, MaxPriority)`(thread.cpp:1388),注释说明理由(thread.cpp:1382-1387): 这是"除非创建了 `Thread.MAX_PRIORITY` 的 Java 线程,否则不该被用"的最高档(唯一同档的是引用处理器线程);而且 **VMThread 的优先级必须低于它**,否则 "profiling will be inaccurate"——WatcherThread 的滴答要当作时钟节拍用,调度器不能长期压制它。

## 2. PeriodicTask: 一张 10 个槽的任务表

`PeriodicTask` 不是链表,而是一张**静态定长数组**(task.cpp:32-33):

```cpp
// task.cpp:32-33(逐字)
int PeriodicTask::_num_tasks = 0;
PeriodicTask* PeriodicTask::_tasks[PeriodicTask::max_tasks];
```

`max_tasks = 10`,另有 `interval_gran = 10`、`min_interval = 10`、`max_interval = 10000`(task.hpp:45-48)——**interval 以毫秒为单位,且必须是 10 的倍数**。这个约束由启动时的 flag 校验函数强制执行:`PerfDataSamplingIntervalFunc`(jvmFlagConstraintsRuntime.cpp:122-131)与 `BiasedLockingStartupDelayFunc`(:78-87)都要求值能被 `PeriodicTask::interval_gran` 整除。任务的核心是 `execute_if_pending(delay_time)`(task.hpp:82-92,38-02 已逐字贴过): **把 delay 累加进 `_counter`,累计达到 `_interval` 就执行 `task()` 并清零**——注意是"累加时间"不是"倒数计数",`_counter` 记录的是"距上次执行已过了多少毫秒"。

### 滴答: real_time_tick

WatcherThread 每次醒来调 `PeriodicTask::real_time_tick(time_waited)`(task.cpp:49-78):

```cpp
// task.cpp:49-78(截取核心,逐字)
void PeriodicTask::real_time_tick(int delay_time) {
  assert(Thread::current()->is_Watcher_thread(), "must be WatcherThread");

#ifndef PRODUCT
  ...
#endif

  {
    // The WatcherThread does not participate in the safepoint protocol
    // for the PeriodicTask_lock because it is not a JavaThread.
    MutexLockerEx ml(PeriodicTask_lock, Mutex::_no_safepoint_check_flag);
    int orig_num_tasks = _num_tasks;

    for(int index = 0; index < _num_tasks; index++) {
      _tasks[index]->execute_if_pending(delay_time);
      if (_num_tasks < orig_num_tasks) { // task dis-enrolled itself
        index--;  // re-do current slot as it has changed
        orig_num_tasks = _num_tasks;
      }
    }
  }
}
```

注意两处: ① 持有 `PeriodicTask_lock` 且带 `_no_safepoint_check_flag`——**WatcherThread 不参与 safepoint 协议**(注释 "The WatcherThread does not participate in the safepoint protocol"),它停不停与 GC 无关;② 循环里处理**任务执行时自我注销**的情况(`_num_tasks` 变小后回退一个槽位重来)——下文的一次性任务正是这个模式。

### 注册: enroll / disenroll

`enroll()`(task.cpp:110-130)做三件事: ① 满 10 个直接 `fatal("Overflow in PeriodicTask table")`;② 尾部追加进数组;③ **唤醒或启动 WatcherThread**:

```cpp
// task.cpp:118-129(截取核心,逐字)
  if (_num_tasks == PeriodicTask::max_tasks) {
    fatal("Overflow in PeriodicTask table");
  } else {
    _tasks[_num_tasks++] = this;
  }

  WatcherThread* thread = WatcherThread::watcher_thread();
  if (thread != NULL) {
    thread->unpark();
  } else {
    WatcherThread::start();
  }
```

`disenroll()`(task.cpp:133-154)反向操作: 找到自己、把后面的槽整体左移(`_tasks[index] = _tasks[index+1]`)、`_num_tasks--`。这个"数组 + 移位"的朴素实现之所以够用,是因为任务总数被锁死在 10 以内,单次遍历成本可以忽略。

**关键设计 (斜体)**: *"时钟"与"任务"解耦——WatcherThread 只负责"睡到最近到期点 + 报告睡了多久",任务的调度策略(间隔、累加、自毁)全在 PeriodicTask 侧。好处是新增一个后台任务只需要 `new XxxTask(interval) + enroll()`,不改时钟本身;代价是单线程顺序执行,所以**任务必须短小**——任何 `task()` 里做重活都会拖慢整张表。*

## 3. 谁注册了什么: 任务清单

JDK11 里 `PeriodicTask` 的全部子类有七个(检索 `public PeriodicTask` 全树只有这七处):

| 任务 | 间隔 | 注册条件 | 干什么 |
|---|---|---|---|
| `StatSamplerTask` | `PerfDataSamplingInterval`=50ms | `UsePerfData` | 刷新采样型计数器(38-02 已详) |
| `EnableBiasedLockingTask` | 一次性(`BiasedLockingStartupDelay`) | `UseBiasedLocking` | 提交 async `VM_EnableBiasedLocking` 后自毁 |
| `VMOperationTimeoutTask` | 超时阈值/10 | `AbortVMOnVMOperationTimeout` | 检查 VM 操作是否超时,fatal |
| `ChunkPoolCleaner` | 5000ms | `CleanChunkPoolAsync`(默认 true) | 清理 arena chunk 空闲池 |
| `JniPeriodicCheckerTask` | 10ms | `CheckJNICalls` | 检查关键信号处理器是否被覆盖 |
| `RTMLockingCalculationTask` | 一次性(`RTMLockingCalculationDelay`) | `UseRTMLocking` | 置 RTM 计算 flag 后自毁 |
| `MemProfilerTask` | `MemProfilerInterval`=500ms | `MemProfiling`(develop,仅 debug 构建) | 内存剖面输出 |

逐个看点:

### EnableBiasedLockingTask: 一次性的"启动补偿"

大纲式的直觉会认为偏向锁的**批量撤销**是周期任务——错了。批量撤销是 `VM_BulkRevokeBias` 操作(biasedLocking.cpp:566),由**同类对象的撤销计数**驱动: 每次撤销都让 `update_heuristics`(biasedLocking.cpp:320-372)给该 Klass 计数,达到 `BiasedLockingBulkRebiasThreshold`(20,HR_BULK_REBIAS)或 `BiasedLockingBulkRevokeThreshold`(40,HR_BULK_REVOKE,globals.hpp:978/984)就当场提交一次批量操作(biasedLocking.cpp:727)——它是"热点换手"的被动响应,不是周期任务。挂在 WatcherThread 上的是**一次性**的 `EnableBiasedLockingTask`(biasedLocking.cpp:79-112):

```cpp
// biasedLocking.cpp:78-112(截取核心,逐字)
// One-shot PeriodicTask subclass for enabling biased locking
class EnableBiasedLockingTask : public PeriodicTask {
 public:
  EnableBiasedLockingTask(size_t interval_time) : PeriodicTask(interval_time) {}

  virtual void task() {
    // Use async VM operation to avoid blocking the Watcher thread.
    // VM Thread will free C heap storage.
    VM_EnableBiasedLocking *op = new VM_EnableBiasedLocking(true);
    VMThread::execute(op);

    // Reclaim our storage and disenroll ourself
    delete this;
  }
};


void BiasedLocking::init() {
  // If biased locking is enabled, schedule a task to fire a few
  // seconds into the run which turns on biased locking for all
  // currently loaded classes as well as future ones. This is a
  // workaround for startup time regressions due to a large number of
  // safepoints being taken during VM startup for bias revocation.
  // Ideally we would have a lower cost for individual bias revocation
  // and not need a mechanism like this.
  if (UseBiasedLocking) {
    if (BiasedLockingStartupDelay > 0) {
      EnableBiasedLockingTask* task = new EnableBiasedLockingTask(BiasedLockingStartupDelay);
      task->enroll();
    } else {
      VM_EnableBiasedLocking op(false);
      VMThread::execute(&op);
    }
  }
}
```

它把 20-01 的两个机制用了起来: 任务执行时提交的是 **async VM 操作**(`VM_EnableBiasedLocking(true)`——`evaluation_mode()` 返回 `_async_safepoint`,注释 "Use async VM operation to avoid blocking the Watcher thread"),然后 `delete this` 自我注销——`real_time_tick` 循环里的"task dis-enrolled itself"分支就是为它准备的。`BiasedLocking::init` 的注释交代了动机: 启动期大量偏向锁撤销 safepoint 拖慢启动,所以"延迟几秒再统一启用"。**JDK11 默认 `BiasedLockingStartupDelay = 0`**(globals.hpp:970,[实证:] 20-background-init-demo.txt),走 `else` 分支直接同步执行——20-01 素材里 `[0.024s] Adding/Evaluating VM operation: EnableBiasedLocking` 就是它;只有 `-XX:+AggressiveOpts` 时才改成 500ms(arguments.cpp:1986-1987)。

### VMOperationTimeoutTask: VM 操作的"秒表"

`AbortVMOnVMOperationTimeout`(diagnostic,默认 false,globals.hpp:528)开启时,VM 操作有了超时监控(vmThread.cpp:92,204-213):

```cpp
// vmThread.cpp:204-213(截取核心,逐字)
void VMOperationTimeoutTask::task() {
  assert(AbortVMOnVMOperationTimeout, "only if enabled");
  if (is_armed()) {
    jlong delay = (os::javaTimeMillis() - _arm_time);
    if (delay > AbortVMOnVMOperationTimeoutDelay) {
      fatal("VM operation took too long: " JLONG_FORMAT " ms (timeout: " INTX_FORMAT " ms)",
            delay, AbortVMOnVMOperationTimeoutDelay);
    }
  }
}
```

"armed" 由 VM 线程在 safepoint 操作的 begin/end 处开关(arm :544-546,disarm :590-592),任务只读 `_arm_time` 算差值。它的 interval 取 `AbortVMOnVMOperationTimeoutDelay/10`(vmThread.cpp:246-256,注释 "Try to make the interval 10% of the timeout delay, so that we miss the timeout by those 10% at max",并夹进 `[min_interval, max_interval]`)。这个任务在 `VMThread::create()` 里就注册(vmThread.cpp:246-256)——比大部队早。

### 其余四个: 各自领域的一行活

- **`ChunkPoolCleaner`**(arena.cpp:169-177): 枚举内定 `CleaningInterval = 5000`,干的事是 `ChunkPool::clean()`——**每个池只保留 5 块(`BlocksToKeep`),超出的空闲 chunk 用 `os::free` 真正还给 OS**(arena.cpp:99-120,141-147): arena 释放后 chunk 先进池子复用,周期清理防止池子无限膨胀。由 `Chunk::start_chunk_pool_cleaner_task()`(arena.cpp:237-246)在 create_vm 里注册(thread.cpp:3953-3955,`CleanChunkPoolAsync` 默认 true)。
- **`JniPeriodicCheckerTask`**(jniPeriodicChecker.cpp:33-37): 间隔 10ms,`task()` 是 `os::run_periodic_checks()`——Linux 实现是 `DO_SIGNAL_CHECK(SIGSEGV/SIGILL/SIGFPE/SIGBUS/SIGPIPE/SIGXFSZ)` 一组的**信号处理器完整性检查**(os_linux.cpp:5381-5394): 检测用户程序(JNI 代码)是否覆盖了 JVM 关键信号处理器。只在 `-Xcheck:jni`(`CheckJNICalls`)时注册(jniPeriodicChecker.cpp:55-66)。
- **`RTMLockingCalculationTask`**(rtmLocking.cpp:38-47): 与 EnableBiasedLockingTask 同款的一次性任务,到点置 `_calculation_flag = 1` 后自毁,`UseRTMLocking` 才注册。
- **`MemProfilerTask`**(memprofiler.cpp:47-52): 只在 debug 构建存在(`MemProfiling` 是 develop flag,globals.hpp:819,且整个 memprofiler.cpp 包在 `#ifndef PRODUCT` 里)——release 的 JDK 里没有它。

## 4. 另一批周期活: 自带时钟的线程

WatcherThread 之外,还有一批"周期性干活"的线程,它们**不是** PeriodicTask——各有各的睡眠与唤醒协议:

- **JFR 采样器**: `JfrThreadSampler`(jfrThreadSampler.cpp:311)是独立 `NonJavaThread`,`os::create_thread(this, os::os_thread)` 创建(:425),主循环 `run()`(:452-500)用自己的 semaphore(`_sample`)与 `os::naked_short_sleep` 睡到下一个采样点,Java/native 两档间隔独立计时,到点用 `os::SuspendedThreadTask` 挂起目标线程抓栈(31-02 提过 AGCT 与它的对比)。间隔由 Java 侧 ExecutionSample 事件阈值注入(`set_java_sample_interval`,jfrThreadSampler.hpp:50)——采样线程是"按需创建"的([实证:] 20-background-init-demo.txt 里默认配置的 JFR 录制,线程转储只有 "JFR Recorder Thread",没有采样线程)。细节归 32-jfr 域。
- **ServiceThread**: `JavaThread`,类注释自述职责 "A JavaThread for low memory detection support and JVMTI compiled-method-load events"(serviceThread.hpp:30),`service_thread_entry`(serviceThread.cpp:84)循环处理 JVMTI 延迟事件、GC 通知(GCNotifier)与 DCMD 通知(:107-139);create_vm :3960 启动,注释要求它"在编译器开始发事件之前启动"(thread.cpp:3957-3959)。
- **CodeCacheSweeperThread**(thread.hpp:2108): 独立 JavaThread,`sweeper_loop`(sweeper.cpp:265-278)睡在 `CodeCache_lock` 上(超时 24 小时),被 `notify` 唤醒后增量清扫 nmethod——16-code-cache/03 已详,这里不展开。
- **GC 线程族**(G1 Main Marker/Conc#/Refine#/Young RemSet Sampling...): [实证:](planning/outlines/00-jvm-tools/materials/commands/20-background-init-demo.txt) SIGQUIT 转储里的一排 runnable,各自有专门的唤醒协议,归 GC 域。

**关键设计 (斜体)**: *分界线是"活的大小"——毫秒级、几十行以内的轻活挂到 WatcherThread 上共享一颗时钟(任务 ≤10、单线程顺序执行、不参与 safepoint);要持续长时间运行、或者有强实时性要求的活(采样、清扫、GC)开独立线程,自持睡眠与唤醒协议,互不拖累。这个定位回到最初的注释: 周期任务的设计目标就是**模拟一个"定时器中断"**(thread.cpp:1369-1371)——它只负责把时间分发给短小的任务,而不是做一个多线程调度器。*

## 5. 启动序列: 这些后台组件何时被点亮

后台组件不是凭空出现的——它们全部由**唯一的启动函数** `Threads::create_vm`(thread.cpp:3702)依次点亮。调用链: java 启动器(域 40)→ `JNI_CreateJavaVM`(jni.cpp:4098)→ `JNI_CreateJavaVM_inner`(:3952)→ `Threads::create_vm`(:4012)。整个函数可以切成四段。

### 第一段: 参数与 OS(thread.cpp:3702-3801)

`os::init()`(:3721)→ 解析参数 `Arguments::parse`(:3743)→ `Arguments::apply_ergo`(:3748,自动调整)→ `os::init_2`(:3774)→ **`SafepointMechanism::initialize()`**(:3784,18 域轮询机制的种子)→ 启动 `-agentlib/-agentpath` 代理(:3798-3801)。注意此刻**没有任何 HotSpot 线程**(线程列表要到 :3804 才初始化,主线程对象更晚,在 :3821)——代理的 `Agent_OnLoad` 还跑在 `JNI_CreateJavaVM` 的调用者线程上。

### 第二段: 全局初始化(thread.cpp:3803-3862)

```cpp
// thread.cpp:3808-3862(截取核心,逐字)
  // Initialize global data structures and create system classes in heap
  vm_init_globals();
  ...
  // Attach the main thread to this os thread
  JavaThread* main_thread = new JavaThread();
  ...
  // Initialize Java-Level synchronization subsystem
  ObjectMonitor::Initialize();

  // Initialize global modules
  jint status = init_globals();
  ...
  { MutexLocker mu(Threads_lock);
    Threads::add(main_thread);
  }
```

**`vm_init_globals()`**(init.cpp:90-98)七步: `check_ThreadShadow()` / `basic_types_init()` / `eventlog_init()` / **`mutex_init()`** / `chunkpool_init()` / `perfMemory_init()`(38 域的共享内存) / `SuspendibleThreadSet_init()`——其中 `mutex_init` 建出全部全局锁,包括 §2 的 `PeriodicTask_lock`(mutexLocker.cpp:324)。随后建立主线程对象(:3821-3840)、`ObjectMonitor::Initialize()`(:3843),再进 **`init_globals()`**。

**`init_globals()`**(init.cpp:101-160)是真正的"全局构造",30 个调用按依赖排序(init.cpp 顶部有全部原型声明与依赖注释,init.hpp:30-36 说明设计动机: **用显式 init 函数取代 C++ 全局对象**,"gives explicit control over the sequence of initialization"):

```cpp
// init.cpp:101-125(截取核心,逐字)
jint init_globals() {
  HandleMark hm;
  management_init();
  bytecodes_init();
  classLoader_init1();
  compilationPolicy_init();
  codeCache_init();
  VM_Version_init();
  os_init_globals();
  stubRoutines_init1();
  jint status = universe_init();  // dependent on codeCache_init and
                                  // stubRoutines_init1 and metaspace_init.
  if (status != JNI_OK)
    return status;

  gc_barrier_stubs_init();   // depends on universe_init, must be before interpreter_init
  interpreter_init();        // before any methods loaded
  invocationCounter_init();  // before any methods loaded
  accessFlags_init();
  templateTable_init();
  InterfaceSupport_init();
  VMRegImpl::set_regName();  // need this before generate_stubs (for printing oop maps).
  SharedRuntime::generate_stubs();
  universe2_init();  // dependent on codeCache_init and stubRoutines_init1
  javaClasses_init();// must happen after vtable initialization, before referenceProcessor_init
  ...
```

后面还有 `referenceProcessor_init` / `jni_handles_init` / `vtableStubs_init` / `InlineCacheBuffer_init` / `compilerOracle_init` / `dependencyContext_init` / **`compileBroker_init()`**(:137,失败返回 JNI_EINVAL)/ `universe_post_init`("must happen after compiler_init",:141)/ **`stubRoutines_init2()`**("note: StubRoutines need 2-phase init",:144)/ `MethodHandles::generate_adapters`(:145)。**StubRoutines 的两阶段**: 两期都把桩生成进 CodeCache 的 BufferBlob,区别在内容——`stubRoutines_init1`(:110)生成 `generate_initial` 的基础桩(forward_exception/call_stub/原子操作等,stubGenerator_x86_64.cpp:5869),`stubRoutines_init2`(:144)生成 `generate_all` 的桩——它们要引用 SharedRuntime 的 C++ 函数地址并以 RuntimeStub 形式可重定位生成(注释 "These entry points require SharedInfo::stack0 to be set up in non-core builds and need to be relocatable, so they each fabricate a RuntimeStub internally",stubGenerator_x86_64.cpp:5974-5976),所以必须排在 `SharedRuntime::generate_stubs`(:123)之后。

**关键设计 (斜体)**: *大纲把它想象成"23 步",真实是 30 个函数,顺序不是拍脑袋——每个函数头顶的注释就是依赖声明(如 `interpreter_init` 的 "before any methods loaded"、`universe2_init` 声明注释里的 "loads primordial classes",init.cpp:68)。依赖的本质是**单向推进**: 类加载之前解释器要先就绪,解释器之前模板表要先生成,模板表之前 universe 要有……任何一步反序都会在运行时以诡异的方式爆掉。*

### 第三段: VMThread 点亮(thread.cpp:3868-3923)

init_globals 完成后,`VMThread::create()`(vmThread.cpp:242-275)才被调用。注意 **`create()` 本身只建对象不建线程**: `new VMThread()`、注册 `VMOperationTimeoutTask`(若开启)、建 `VMOperationQueue`、建 `_terminate_lock`、注册 `sun.threads.vmOperationTime` 计数器(vmThread.cpp:268-274)。真正的线程创建在 create_vm 里:

```cpp
// thread.cpp:3868-3888(截取核心,逐字)
  // Create the VMThread
  { TraceTime timer("Start VMThread", TRACETIME_LOG(Info, startuptime));

  VMThread::create();
    Thread* vmthread = VMThread::vm_thread();

    if (!os::create_thread(vmthread, os::vm_thread)) {
      vm_exit_during_initialization("Cannot create VM thread. "
                                    "Out of system resources.");
    }

    // Wait for the VM thread to become ready, and VMThread::run to initialize
    // Monitors can have spurious returns, must always check another state flag
    {
      MutexLocker ml(Notify_lock);
      os::start_thread(vmthread);
      while (vmthread->active_handles() == NULL) {
        Notify_lock->wait();
      }
    }
  }
```

就绪协议: VMThread::run 里 `set_active_handles(...)` 后 `Notify_lock->notify()`(vmThread.cpp:293-298),主线程等 `active_handles() != NULL` 才算启动完成。**此后主线程才敢提交第一个 VM 操作**——`VM_Verify`(VerifyDuringStartup 时,:3891-3895)。接着 `initialize_java_lang_classes`(:3914,加载 java.lang.Object 等核心类)、`StubCodeDesc::freeze()`(:3919,之后不许再生成桩)、`set_init_completed()`(:3923)。

### 第四段: 服务与后台启动(thread.cpp:3935-4078)

```cpp
// thread.cpp:4047-4078(截取核心,逐字)
  if (MemProfiling)                   MemProfiler::engage();
  StatSampler::engage();
  if (CheckJNICalls)                  JniPeriodicChecker::engage();

  BiasedLocking::init();
  ...
  {
    MutexLocker ml(PeriodicTask_lock);
    // Make sure the WatcherThread can be started by WatcherThread::start()
    // or by dynamic enrollment.
    WatcherThread::make_startable();
    // Start up the WatcherThread if there are any periodic tasks
    // NOTE:  All PeriodicTasks should be registered by now. If they
    //   aren't, late joiners might appear to start slowly (we might
    //   take a while to process their first tick).
    if (PeriodicTask::num_tasks() > 0) {
      WatcherThread::start();
    }
  }
```

这一段的顺序编排本身就是依赖关系的体现: 先 `os::initialize_jdk_signal_support`(:3936,信号分派线程)、AttachListener(:3939-3944)、ChunkPoolCleaner(:3953-3955)、`ServiceThread::initialize()`(:3960,注释 "Needs to start before the compilers start posting events")、编译器初始化(`CompileBroker::compilation_init_phase1/2`,:3980-3985,13 域)、JSR292 核心类(:3992)、`call_initPhase2`(:3996,模块系统)、JVMTI 阶段标记(:4002/:4029)、JFR(:3998/:4034)、`Management::initialize`(:4037)——然后才轮到周期任务的大登记(:4047-4055),最后 `WatcherThread::make_startable() + start()`(:4066-4078)。

**为什么 WatcherThread 要拖到最后**: `make_startable()`(thread.cpp:1524-1527)把 `_startable` 置 true,`start()`(:1514-1522)在 `_startable && watcher_thread()==NULL` 时才真正 `new WatcherThread()`。注释写得很直白(thread.cpp:4072-4074): **"所有 PeriodicTask 应该已经注册完毕——晚来的加入者第一个 tick 会慢"**。原因在 §2 的机制里: 任务的 `_counter` 从 0 起,enroll 之后第一次执行要等满一个 interval;启动前全部注册,start 时任务表一次就位,第一次 sleep 直接算到最早到期点。Enroll 顺序 vs 启动顺序的耦合,在这里被刻意压成一个"先全部注册、再解锁启动"的两步。

### 停机: 反向顺序

`before_exit`(java.cpp:445-546)按相反顺序收摊: 先 **`WatcherThread::stop()`**(java.cpp:503,thread.cpp:1529-1551: 置 `_should_terminate` → `unpark` → 在 `Terminator_lock` 上等退出;注释 "Stop the WatcherThread. We do this before disenrolling various",java.cpp:500-502)——**先把滴答的线程停掉,再注销挂在它身上的任务**(如 `StatSampler::disengage`,:507),避免任务表和时钟并发改。

## 核心悬念

后台的周期性家务拆完了: WatcherThread(线程转储里的 "VM Periodic Task Thread")是一颗"模拟定时器中断"的时钟,睡到任务表算出的最近到期点、报告睡了多久;`PeriodicTask` 是 10 个槽的静态数组,毫秒级累加、可自毁,JDK11 里七个实例(StatSampler 50ms / EnableBiasedLocking 一次性 / VMOperationTimeout 超时监控 / ChunkPoolCleaner 5s / JNI 检查 10ms / RTM / MemProfiler);更重的周期活(JFR 采样、ServiceThread、CodeCache sweeper、GC 线程)自带时钟,不走这张表。而这一切的点燃顺序是一条近 400 行的 `Threads::create_vm`: 参数→`vm_init_globals`(7 步)→`init_globals`(30 步,每步头顶注释就是依赖声明)→VMThread 创建+就绪握手→服务线程与编译器→**周期任务全部注册后才 make_startable 启动 WatcherThread**。

但 20-01 和本篇有一个反复出现的"提交者": GC 请求、偏向锁、Verify——它们通过 `VMThread::execute` 把工作交给 VM 线程,而 JNI 调用(`GetEnv`/`FindClass`/`NewGlobalRef`)走的是另一条完全不同的通道: **jobject 引用怎么在 Java 对象与 C 世界之间存活**?下一篇进入 JNI: Handle 系统。

> → [27-jni/01 — jobject 在 JVM 内部怎么存的?— JNI Handle 系统](01-handle-system.md)
