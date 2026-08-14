# 02. 后台任务与启动序列 — PeriodicTask + Init

> 🟡 Working | 2 KP 中的后台基础设施
> 读者处境: JVM 不仅执行显式请求的 VM 操作——还有一堆周期性后台任务: 检查 biased lock 批量撤销、JFR 采样、性能计数器刷新。谁在执行这些？

> ⚠️ 写作期修正(2026-08-14, vol-02/20-vm-operations/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"task.hpp:35-80 代码块" 全错**: execute_if_ready 不存在(真实 execute_if_pending,task.hpp:82-92);无 is_enrolled();_tasks 是**静态数组 max_tasks=10**(task.hpp:45-48,task.cpp:32-33)非链表;enroll=尾部追加+满 10 fatal+unpark/start(task.cpp:110-130),disenroll=整体左移(:133-154)
> - **"WatcherThread 主循环 vmThread.cpp:500-550" 文件错**: WatcherThread 在 thread.cpp(:1453 run);vmThread.cpp 是 VMThread;睡眠**非固定 50ms**——sleep()(thread.cpp:1395-1451)先算 time_to_wait()(task.cpp:80-92,min(interval-counter)),PeriodicTask_lock->wait(remaining),无任务睡到 enroll 被 unpark
> - **"递减 counter→复位 interval" 反**: execute_if_pending **累加** delay_time,>=interval 执行并清零;counter=距上次执行的毫秒数;time_to_wait 里的真实时间源=WatcherThread 报告的 time_waited
> - **"JFR 是 PeriodicTask" 编造**: 文件=jfrThreadSampler.cpp(share/jfr/periodic/sampling),JfrThreadSampler 是独立 NonJavaThread(os::create_thread :425+自己 semaphore),**不 enroll 到 WatcherThread**;默认配置采样事件关闭无此线程(实证转储只有 JFR Recorder Thread)
> - **"PerfDataSampler perfData.cpp:180-230" 错**: 真实 StatSamplerTask(statSampler.cpp:42-46)+StatSampler::engage(:78-90,PerfDataSamplingInterval=50ms)——38-02 已详,本篇只列名
> - **"BiasedLocking::check_bulk_rebias 周期检查" 编造**: 真实 EnableBiasedLockingTask(biasedLocking.cpp:79-92)**一次性**(interval=BiasedLockingStartupDelay 默认 0=立即执行,globals.hpp:970;AggressiveOpts 500,arguments.cpp:1986-1987),task 提交 async VM_EnableBiasedLocking 后 delete this;批量撤销=VM_BulkRevokeBias(biasedLocking.cpp:566),由 update_heuristics 同类撤销计数(20/40 阈值,:321-372)被动触发(:727),非周期任务
> - **"NMTSweeper" 编造**: 无 NMT 周期任务;NMT_stack_walkable 只是 init_globals 一行(init.cpp:150)
> - **缺 4 个真实任务**: VMOperationTimeoutTask(vmThread.cpp:92,204-226;AbortVMOnVMOperationTimeout 时,interval=delay/10,:246-256)、ChunkPoolCleaner(arena.cpp:169-177,5000ms,BlocksToKeep=5 其余 os::free)、JniPeriodicCheckerTask(jniPeriodicChecker.cpp:33-37,10ms,CheckJNICalls,os::run_periodic_checks=DO_SIGNAL_CHECK)、RTMLockingCalculationTask(rtmLocking.cpp:38-47 一次性)+MemProfilerTask(memprofiler.cpp:47,develop-only)
> - **"VM init 23 步 init.cpp:80-250" 全错**: init.cpp 共 190 行;真实 init_globals=init.cpp:101-160(**30 个函数**,顺序即依赖注释),vm_init_globals=:90-98(7 步);"jintArgumentProlog/10_initPhase2/30_runPhase2" 是 JDK8 旧版编造;StubRoutines 真实顺序=codeCache_init(:107)→stubRoutines_init1(:110)→universe_init(:111),非"StubRoutines 在 CodeCache 前";两阶段是 generate_initial/generate_all 内容差异(stubGenerator_x86_64.cpp:5869/:5974-5977)
> - **"Threads::create_vm 是 init_globals 一步" 反**: Threads::create_vm(thread.cpp:3702,jni.cpp:4012 调用)调用 vm_init_globals(:3809)+init_globals(:3846);"SystemDictionary::initialize/Universe::genesis/Interpreter::initialize_stub/ClassLoader::initialize/SignalHandlerMark::on/Management::init" 均不存在(真实: management_init/classLoader_init1/codeCache_init/universe_init/interpreter_init/compileBroker_init)
> - **"VMThread::create 内部等 loop(VMOperationLock)" 错**: create(vmThread.cpp:242-275)只建对象(timeout task/队列/terminate lock/perf counter);线程创建+就绪等待在 create_vm(thread.cpp:3871-3887: os::create_thread+start_thread+**Notify_lock 等 active_handles**,run 里 set_active_handles 后 notify :293-298);"vm_during_initialization flag" 不存在
> - **"两阶段=数据就绪/服务启动" 错**: vm_init_globals/init_globals 是全局数据两段(init.hpp:38-39 注释),服务启动(VMThread/ServiceThread/编译器/周期任务)在 create_vm 第三四段(:3868-4078);WatcherThread **最后 make_startable+start**(:4066-4078,注释 "All PeriodicTasks should be registered by now",晚注册者第一个 tick 慢)
> - **停机**: before_exit 先 WatcherThread::stop(java.cpp:503)再 StatSampler::disengage(:507)——先停时钟再注销任务
> - **悬念指向 21-shared-runtime 错**: 正确=27-jni(层 4,00-domain-writing-order.md:76)
> - **实证**: 20-background-init-demo.txt(SIGQUIT "VM Periodic Task Thread" waiting on condition/BiasedLockingStartupDelay=0/PerfDataSamplingInterval=50;20-vmops-demo.txt [0.024s] EnableBiasedLocking 立即执行)

### 1. "我不停地跑" — WatcherThread + PeriodicTask

场景: JVM 启动后 WatcherThread 不停循环——每 ~50ms 执行一次 enrolled periodic tasks。这些 task 在初始化时注册。

**PeriodicTask 框架** (`task.hpp:35-80`):
```cpp
class PeriodicTask : public CHeapObj<mtInternal> {
  int _counter;  // 倒数计数器
  int _interval; // 在 WatcherThread 的间隙数
public:
  void enroll();  // 注册到 WatcherThread
  void disenroll();
  bool is_enrolled() const;
  void execute_if_ready(int delay_time);
  virtual void task() = 0;  // 实际工作
};
```
- 源码: `task.hpp:35-80` PeriodicTask 定义
- 关键设计: counter-based 非 timer——不依赖 OS 定时器(ITIMER/SIGALRM)。WatcherThread sleep ~50ms→醒来→对每个 enrolled task 递减 counter→counter=0→执行 task()→counter 复位为 interval。优点: 时序可预测(50ms 粒度)、不受 wall clock 调整影响(monotonic sleep)
- [C++: `enroll` 把 task 插入全局 `WatcherThread::_tasks` 链表——不排序。执行时 WatcherThread 顺序遍历——O(N) per wake。因为 enrolled tasks 很少(<10)→线性遍历够用]

**WatcherThread 主循环** (`vmThread.cpp:500-550`):
```
WatcherThread::run():
  while (!_should_terminate) {
    sleep(50ms)  // os::sleep 非 busy-wait
    for each enrolled PeriodicTask:
      task->execute_if_ready(delay_time)
      → if (--_counter == 0) { task(); _counter = _interval; }
    // 额外: biased lock bulk revoke check, JFR sampling
  }
```
- 源码: `vmThread.cpp:500-550` WatcherThread::run
- [C++: `os::sleep(50ms)` = `os::javaTimeMillis()` + `os::NakedSleep()` → pthread_cond_timedwait 或 nanosleep。不依赖 ITIMER——ITIMER 有信号队列溢出风险且维护复杂]

**典型 PeriodicTask**:
```
JFR:      JfrThreadSampling::sample_threads() — 采样 Java 线程栈(~100ms)
          源码: jfrThreadSampling.cpp:120-180  enroll + task()
PerfData: PerfDataSampler::task() — 刷新性能计数器
          源码: perfData.cpp:180-230  _sampler_task->enroll()
Biased Lock: BiasedLocking::check_bulk_rebias() — 批量撤销/重偏向
          源码: biasedLocking.cpp:500-550  PeriodicTask::enroll() 注册
NMTSweeper: 如果 NMT 开启 — 周期性清理过期数据
          源码: nmtCommon.cpp:50-80  MemTracker::NMT_stack_walker
```
- 关键设计: interval 设置不同——JFR sampling 可能 ~100ms, BiasedLocking check 可能 ~2000ms。WatcherThread 的 50ms 是基础时钟——interval=4→200ms→每 4 次唤醒执行一次

### 2. "看谁先初始化" — VM init 23 步序列

场景: JVM 启动时——先把所有子系统按依赖顺序初始化。代码缓存缺内存不行——先初始化内存。编译器需要代码缓存——先初始化代码缓存。

**init_globals() 23步顺序** (`init.cpp:80-250`):
```
1.  os_init()                    // OS 子系统
2.  Threads::create_vm()         // 创建 VM 原生线程
3.  init_globals() 第二阶段
4.  StubRoutines::initialize1()  // 运行时 stub (fence/math/crypto intrinsic)
5.  Universe::genesis()          // 创建基本 oop/Klass
6.  Interpreter::initialize_stub() // C++ interpreter forward stub
...
10. SystemDictionary::initialize() // 类加载字典
11. ClassLoader::initialize()      // bootstrap classloader
12. CodeCache::initialize()        // 代码缓存(Groups 16-19)
13. StubRoutines::initialize2()    // 依赖 CodeCache 的后续 stub
14. Interpreter::initialize()      // 主解释器(模板表/BytecodeInterpreter)
15. CompileBroker::compilation_init() // JIT 编译器(C1/C2 线程启动)
...
20. Management::init()             // JMX 管理
21. JvmtiExport::enter_start_phase() // JVMTI agent 加载
22. SignalHandlerMark::on()        // signal handler 就绪
23. VMThread::create()             // VMThread 最后初始化
```
- 源码: `init.cpp:80-250` init_globals + vm_init_globals
- 关键设计: init 顺序反映依赖图——StubRoutines 在 CodeCache 之前(需要存生成的 stub)，CodeCache 在 Interpreter 之前(解释代码存在 CodeHeap)，Interpreter 在 Compiler 之前(JIT 需要 fallback to interpreter)。VMThread 最后——因为 VM 操作依赖所有子系统。不能并行——单线程依次初始化

**vm_init_globals 第二阶段** (`init.cpp:250-350`):
```
vm_init_globals():
  jintArgumentProlog()       // 解析 -XX: 参数
  10_initPhase2()            // 第二层初始化: GC policy, compiler oracle
  30_runPhase2()             // 启动 VMThread, start compiler threads
```
- 源码: `init.cpp:250-350` 第二阶段三步骤
- 关键设计: 两阶段分离——init_globals 做"数据就绪"(分配内存/创建结构), vm_init_globals 做"服务启动"(启动 VMThread/Compiler threads)。分离原因: 第二阶段依赖第一阶段完成——第一阶段中 VMThread 还没活，不能提交 VM 操作

**VMThread 的启动特殊处理** (`vmThread.cpp:60-100`):
```
VMThread::create():
  1. thread->set_osthread(os::create_thread(...))
  2. os::start_thread(thread)
  3. 等待 thread 进入 loop — Mutex::wait on VMOperationLock
```
- [C++: vm_during_initialization() flag——在 VMThread 启动前提交的 VM 操作不能排队→会直接在本线程同步执行。这是 startups 的安全保障——如果某个 init 步骤触发了 VM 操作(如 init_globals 中 GC)→不需要 VMThread→直接执行]

---

### 核心悬念

**"WatcherThread 每 50ms 循环执行 PeriodicTask——counter-based 非 timer-based——JFR 采样/BiasedLock 批量撤销都由它驱动。VM init 按依赖关系串行初始化 23 步，VMThread 最后启动。"** — 下一篇: 域21 SharedRuntime——Java 和 VM 的调用桥。

> → 域21 SharedRuntime
