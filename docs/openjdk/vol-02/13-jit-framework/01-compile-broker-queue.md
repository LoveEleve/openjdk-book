# 01. 谁决定编译、怎么排队、谁执行？— CompileBroker 编译队列

> **前置依赖**:[08-interpreter/03 — 解释器怎么安全地调 C++？— InterpreterRuntime](openjdk/vol-02/08-interpreter/03-interpreter-runtime.md):计数器与溢出处理是编译请求的源头;[12-ci/03 — 编译的"一次性生命"怎么收场？— ciObjectFactory + ciReplay](openjdk/vol-02/12-ci/03-ci-factory-runtime.md):ciEnv 的创建点就在这里——`invoke_compiler_on_method`;[16-code-cache/02 — nmethod 结构 — 一段编译方法里装了什么](openjdk/vol-02/16-code-cache/02-nmethod-structure.md):编译产物,任务的终点
> → **后续**:[13-jit-framework/02 — TieredThresholdPolicy — 5 层编译策略](02-tiered-compilation-policy.md):本篇的"谁决定编译"里最复杂的部分——级别怎么选
> 关联域: 17-threads(编译器线程)、24-frame(编译帧与 GC)、25-gc

## 一条编译请求的旅程

解释器里一个方法跑到第 10000 次,`IncrementCounter` 溢出了——[08-03](openjdk/vol-02/08-interpreter/03-interpreter-runtime.md) 拆过这一步: `InterpreterRuntime::frequency_counter_overflow`(interpreterRuntime.cpp:1059)把控制交给 `CompilationPolicy::policy()->event(...)`——**策略**决定"编不编、编哪层";再往下就是本篇的主角 **CompileBroker**: 策略说编,它就造一个编译任务、扔进队列;编译器线程从队列取出任务、创建 ciEnv、调 C2/C1 编译、把 nmethod 装进 CodeCache。这一篇拆这条链的中段: 任务、队列、线程。

## 1. CompileTask: 一条任务的完整档案

`CompileTask` 是请求的化身。字段一览(compileTask.hpp:76-103): `_compile_id`、`_method`、`_osr_bci`(普通编译 = `standard_entry_bci`)、`_comp_level`、`_is_complete/_is_success/_is_blocking`、`_time_queued/_time_started`、`_hot_method/_hot_count`(哪个方法用多大热度触发了我)、`_compile_reason`、`_failure_reason`。

最值得注意的字段是 **`_compile_reason`——编译原因枚举**(compileTask.hpp:48-59),九种: `Reason_InvocationCount`(方法调用计数)、`Reason_BackedgeCount`(回边计数→OSR)、`Reason_Tiered`(分层策略主动升级)、`Reason_CTW`/`Reason_Replay`/`Reason_Whitebox`(调试工具)、`Reason_MustBeCompiled`(VM 要求,如 LinkResolver 需要)、`Reason_Bootstrap`。原因不是装饰: `can_become_stale`(compileTask.hpp:124-133)判断**任务会不会过期**——只有非阻塞的计数触发任务(InvocationCount/BackedgeCount/Tiered)会过期;过期的任务(`remove_and_mark_stale`/`purge_stale_tasks`,compileBroker.hpp:86/104)会被队列清掉——**方法可能已经卸载或有了新结果,排队里的旧请求就不值得编译了**。

**compile_id 从哪来**: `assign_compile_id`(compileBroker.cpp:1479)——一个全局递增计数器(`_compilation_id`,`Atomic::add`),release 构建下普通与 OSR 共用;develop 构建的 `CICountOSR` 会给 OSR 单独编号。它同时出现在三处: PrintCompilation 的第二个数字、DumpReplay 文件名里的 `compid%d`(12-ci/03 的实证: compid76/77/78)——**同一个编译的三副面孔**;还有 `CIStart/CIStop` 可以限定编译 id 范围(调试用)。

**任务会"变旧"**: `can_become_stale`(compileTask.hpp:124-133)定义条件——只有非阻塞的计数触发任务可能过期;取任务时(`select_task`)检查两件事: 方法被卸载、或 **排队期间毫无新事件**(`is_stale`,距上次测量超 `TieredCompileTaskTimeout`=50ms 且事件数为 0,tieredThresholdPolicy.cpp:509-520)——满足就 `remove_and_mark_stale` 移出队列,最终被 `purge_stale_tasks`(compileBroker.cpp:484-501)清掉,失败原因记 `"stale task"`。另外 `is_old`(计数超 5 万/回边超 50 万)的方法不移出队列但 rate 清零(:523-527)——任务在排队期间,世界在变。

**任务生命周期**: `create_compile_task`(compileBroker.cpp:1532)——`CompileTask::allocate()`(空闲列表复用)+ `initialize` + `queue->add`;编译线程 `queue->get()` 取走;`CompileTaskWrapper`(compileBroker.hpp:129-133)把任务"分配"给当前编译线程,编译完成时 wrapper 析构负责收尾:

```cpp
// compileBroker.cpp:262-274(截取核心,逐字)
CompileTaskWrapper::~CompileTaskWrapper() {
  CompilerThread* thread = CompilerThread::current();
  CompileTask* task = thread->task();
  CompileLog*  log  = thread->log();
  if (log != NULL && !task->is_unloaded())  task->log_task_done(log);
  thread->set_task(NULL);
  task->set_code_handle(NULL);
  thread->set_env(NULL);
  if (task->is_blocking()) {
    bool free_task = false;
    {
      MutexLocker notifier(task->lock(), thread);
      task->mark_complete();
```

收尾三件事: 清线程上的任务指针、丢代码句柄、`set_env(NULL)`(12-ci/03 讲过的 env 清理在此触发);阻塞任务 `mark_complete()` + `notify_all()`(等它的线程被唤醒)。

**关键设计 (斜体)**: *大纲写的"状态机 in_queue→assigned→compiling→compiled→failed"并不存在——真实只有两个布尔(`_is_complete`/`_is_success`)+ 一个"谁在编译"指针(`thread->task()`);"进行中"这个状态是 CompileTaskWrapper 的存活期隐含的。任务的生命周期归 wrapper 管: 构造即分配、析构即完成登记。*

## 2. 队列与线程: 两个 FIFO,一群 JavaThread

大纲说队列"按优先级排序,compute_priority = invocation_count + backedge_count×ratio"——**编造**。真相:

**两个队列,按编译级别分流**。`_c1_compile_queue`/`_c2_compile_queue`(compileBroker.hpp:179-180),`compile_queue(comp_level)`(compileBroker.cpp)按级别选: C2 级别(4)进 C2 队列,C1 级别(1-3)进 C1 队列。`CompileQueue::add`(compileBroker.cpp:485 附近)把任务**追加到队尾**——链表是 FIFO 结构,但**取任务不是 FIFO**: `CompileQueue::get` 内部调 `CompilationPolicy::policy()->select_task`(compileBroker.cpp:464)——Tiered 策略遍历队列,算每个任务的 **weight**((rate+1)×(计数+1)×(回边+1),tieredThresholdPolicy.cpp:529-533),**weight 最高的先编译**(rate 是方法的热度变化率: 每毫秒新增的计数事件,`update_rate` :471-500,25ms 无事件清零);顺带在这里清理 stale 任务(上一节)。大纲说的 "compute_priority = invocation_count + backedge_count×ratio" 函数不存在,但"热点优先"的精神以 rate/weight 的形式真实存在。"优先级"的另一层是 OS 线程优先级: 编译线程以 `NearMaxPriority`(compileBroker.cpp:803)被调度,高于普通 Java 线程。

**编译线程是 JavaThread 子类**(`CompilerThread`,17 域线程层级): 有自己的 Java 栈、可以进 safepoint、被 GC 阻塞——所以编译可以"安全地挂起"。线程数不是硬编码 1+2: `TieredThresholdPolicy::initialize`(tieredThresholdPolicy.cpp:202-247)按 CPU 数**自适应**(LP64 默认 `CICompilerCountPerCPU`): `count = MAX2(log2(cpu) * log2(log2(cpu)) * 3/2, 2)`(:214,log n × log log n 的增速),还要受 CodeCache 缓冲容量的上限约束(:219-223),然后 **C1 拿 1/3、C2 拿 2/3**(`c1_count = MAX2(count/3,1)`,:244-245)。[实证:](planning/outlines/00-jvm-tools/materials/commands/13-jit-broker-demo.txt) 本机 `CICompilerCount = 15 (ergonomic)`;`jcmd Thread.print` 能看到活的 `"C2 CompilerThread0"`/`"C1 CompilerThread0"`(daemon,prio=9)与 `"Sweeper thread"`(CodeCache 清扫器,16 域)。`UseDynamicNumberOfCompilerThreads` 默认开——编译线程空闲够久可以自己退出(compiler_thread_loop 里 `can_remove`,compileBroker.cpp:1836-1851)。

**编译线程的主循环** `compiler_thread_loop`(compileBroker.cpp:1790): 第一个到场的线程先做一件大事——`ciObjectFactory::initialize()`(:1802-1804,**01 篇的全局共享镜像就是在这里诞生的**,注释还强调这个 ResourceMark 要持有共享对象);然后无限循环: `queue->get()` 取任务(空队列 `wait` 5 秒,:449;取到任务前先 `purge_stale_tasks` 清过期任务,:478)→ `CompileTaskWrapper ctw(task)`(:1864,注释: "keeps the `Method*` from being deallocated if redefinition occurs")→ 编译。**代码缓存满时编译会暂停**: `UseCodeCacheFlushing` 开启时 `set_should_compile_new_jobs(stop_compilation)`(sweeper 腾出空间后可恢复),否则 `disable_compilation_forever()`(:2319-2329)——编译资源与代码缓存同进退。

## 3. 执行: 从任务到 nmethod

`invoke_compiler_on_method`(compileBroker.cpp:2062)是执行段:

- **PrintCompilation 在这里打印**(:2064-2067)——实证里 `29 76 % 3 CiDemo::work @ 5 (45 bytes)` 一行: 时间戳/compile_id/`%`=OSR/级别/方法 `@ 5`=osr_bci/字节数,全来自任务字段;
- **`push_jni_handle_block()`**(:2110)——开一个新的 JNI handle block: 这是 ci 对象(01 篇)的 local handle 们的容器,编译结束 pop 掉,handle 随之一并释放(03 篇说过的"handle 随线程 handle block 清理"就是这里);
- **`ciEnv ci_env(task)`**(:2150)——**ciEnv 的创建点**(12-ci 全系的入口): 编译线程在此进入 VM 状态,之后 `ciEnv::get_method_from_handle` 拿 ciMethod、`comp->compile_method(&ci_env, target, osr_bci, directive)`(:2180)进入 C1 的 `Compilation` 或 C2 的 `Compile`(12-ci/01 的 `Compile::Compile` 构造);
- 完成后 `post_compile` 登记结果: 成功则 `mark_success` + 记录内联字节数(ciEnv.cpp 侧的 `register_method` 早已把 nmethod 装进 CodeCache 并挂到 task,`task->code()` 可查;这里只检查 `task->code() != NULL`(:2174)并记账),失败则 `record_method_not_compilable` 记录原因;
- `CompileTaskWrapper` 析构收尾(上一节代码块): 清任务指针、丢代码句柄、`set_env(NULL)`、阻塞任务 `mark_complete()` + `notify_all()`。

**阻塞编译**: `_is_blocking` 的任务(CTW/Replay/WhiteBox/MustBeCompiled 等)会让请求线程**等结果**而不是提交完就走——JVMCI 有专门的 `wait_for_jvmci_completion`(compileBroker.cpp:1573,10 次×1 秒无进展才放弃)。普通计数触发的编译都是非阻塞的: 请求线程把任务扔进队列立刻返回,继续跑解释器——**这就是"编译异步进行"的全部含义**。

## 4. 触发侧与拒绝侧

任务从哪来?两条主线: ①解释器计数溢出(`frequency_counter_overflow` → `CompilationPolicy::event`,interpreterRuntime.cpp:1059,08-03 已拆计数机制);②VM 内部要求(MustBeCompiled——如 `LinkResolver` 需要即时编译、WhiteBox 测试、CTW)。`compile_method`(compileBroker.cpp:1220)在入队前有大量"拒绝检查": 方法不可编译(flag)、已在队列(防重复,`compilation_is_in_queue`,:1080)、已有同层结果(`compilation_is_complete`,:1062)、被重定义(`method->is_old()`,:1320)、native 方法先查好函数地址(:1307-1318)、C2 还要先解析签名类(:1295-1300)。

## 核心悬念

CompileBroker 拆完了: 请求(CompileTask——compile_id/级别/原因/过期机制)入**双 FIFO 队列**(C1/C2 分流,无优先级,OS 线程高优先级是另一回事);编译线程(JavaThread 子类,按 CPU 自适应 1:2 分配,第一个线程顺手初始化 ciObjectFactory)循环取任务;执行段就是 12-ci 的诞生现场(push_jni_handle_block → ciEnv → C1/C2 → post_compile),wrapper 析构完成收尾;代码缓存满则编译暂停。一句话: **编译是"异步流水线"——解释器负责生产请求,策略负责分级,broker 负责调度,编译器线程负责消费。**

但本篇开头那句话留了一半: `CompilationPolicy::event()` 的"编不编、编哪层"是**策略**的事——为什么 `CiDemo::work` 先 tier3 再 `%`tier4 再 tier4?为什么 `made not entrant`?下一篇: TieredThresholdPolicy,5 层编译阶梯。

> → [13-jit-framework/02 — TieredThresholdPolicy — 5 层编译策略](02-tiered-compilation-policy.md)
