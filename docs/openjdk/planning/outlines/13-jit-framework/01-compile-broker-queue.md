# 01. CompileBroker — 编译队列 + compiler 线程

> 🔴 Deep | 8 KP 中的 2 个核心机制
> 读者处境: 解释器跑了 10000 次 `ArrayList.add()`——InvocationCounter 归零——"该 JIT 了"。谁决定编译、怎么排队、谁执行？

> ⚠️ 写作期修正(2026-08-13, vol-02/13-jit-framework/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"compute_priority 按优先级排序" 编造**: 不存在;双 FIFO 队列 `_c1_compile_queue/_c2_compile_queue`(compileBroker.hpp:179-180),`compile_queue(comp_level)` 按级别分流(C1 1-3/C2 4);`CompileQueue::add` 队尾追加(:485 附近);NearMaxPriority(:803)是 OS 线程优先级非队列排序
> - **"状态机 in_queue→assigned→compiling→compiled→failed" 编造**: 只有 `_is_complete/_is_success/_is_blocking`(compileTask.hpp:83-85);"进行中"=CompileTaskWrapper 存活期(构造 assign :250/析构收尾 :262: set_task(NULL)+set_code_handle(NULL)+set_env(NULL)+阻塞任务 mark_complete+notify_all)
> - **"超时 2min 取消任务" 编造**: `_time_queued` 只在日志打印(compileTask.cpp:317);无超时取消;JVMCI 才有 wait_for_jvmci_completion(:1573,10×1s 无进展放弃)
> - **"c1 默认 1/c2 默认 2" 半对**: CI_COMPILER_COUNT=2(C2 构建,globals.hpp:104)但 LP64 默认 CICompilerCountPerCPU 按 CPU 自适应: count=MAX2(log2cpu×log2log2cpu×3/2,2)(tieredThresholdPolicy.cpp:214)+CodeCache 缓冲上限(:219-223);分配 c1=MAX2(count/3,1)/c2=MAX2(count-c1,1)(:244-245);实证本机 15(ergonomic)
> - **"Compiler threads 可 safepoint" ✓**: CompilerThread 是 JavaThread 子类(jcmd Thread.print 实证 "C2 CompilerThread0"/"C1 CompilerThread0"/"Sweeper thread");UseDynamicNumberOfCompilerThreads 默认 true 空闲可退出(:1836-1851)
> - **缺机制(大纲无)**: ①CompileReason 九种(compileTask.hpp:48-59: InvocationCount/BackedgeCount/Tiered/CTW/Replay/Whitebox/MustBeCompiled/Bootstrap)+can_become_stale(:124-133,非阻塞计数任务才可过期)+purge_stale_tasks("stale task" 失败原因,compileBroker.cpp:484-501);②compile_id 全局递增(assign_compile_id :1479,OSR 在 develop CICountOSR 下独立编号)+CIStart/CIStop 范围;③compile_method 拒绝链(compilation_is_in_queue :1080/compilation_is_complete :1062/method->is_old :1320/native 预查 :1307-1318/C2 签名类解析 :1295-1300);④执行段=12-ci 诞生现场: push_jni_handle_block(:2110,ci local handle 容器)→ciEnv ci_env(task)(:2150)→comp->compile_method(:2180)→post_compile;⑤第一个编译线程初始化 ciObjectFactory(:1802-1804);⑥阻塞编译(should_wait_for_compilation compileTask.hpp:135-147)
> - **"OopMap" 不属于本篇**: 消费侧(GC 扫描/RegisterMap)已在 24-03 讲过,生成侧属 C2 寄存器分配——本篇聚焦 broker 不写 OopMap
> - **实证**: 13-jit-broker-demo.txt(CICompilerCount=15 ergonomic;CIPrintCompileQueue 是 diagnostic flag release 可用,打印 C1/C2 compile queue;jcmd Thread.print 线程名;PrintCompilation compile_id 76/77/78 与 12-ci/03 DumpReplay 的 compid 同源对应)

### 1. CompileBroker — JIT 编译的总调度

场景: 解释器执行 `invokevirtual IncrementCounter`→counter: 10000→0→`InterpreterRuntime::frequency_counter_overflow()`→调 `CompilationPolicy::event()`→判断可编译→`CompileBroker::compile_method()`→创建 CompileTask→加入 compile queue→compiler thread 取出→执行编译。

**CompileBroker** (`compileBroker.hpp.cpp`):
- `_compile_queue`: `CompileQueue`——按优先级排序——`CompileTask::compute_priority()` = invocation_count + backedge_count×ratio——热点方法优先
- `_c1_compile_threads`: `CompileThread*`——默认 1 个 C1 thread
- `_c2_compile_threads`: `CompileThread*`——默认 2 个 C2 thread (C1 编译快——多 C2 做重优化)
- [C++: Compiler threads 是 `JavaThread` 子类——有 Java 栈——可以 safepoint (OC compilation 需要 safepoint 取 stack)。在 safepoint 外运行——不影响 Java 线程。编译期间 JVM 继续处理 Java 代码——解耦 queue management 和 execution]
- `invoke_compiler_on_method(CompileTask*)`: CompileTask→`_compiler->compile_method(ciEnv, ...)`→返回 nmethod* (存入 CodeCache)

**CompileTask** (`compileTask.hpp.cpp`):
- `_method`: Method*——要编译的方法
- `_osr_bci`: OSR 编译的 bytecode offset (普通编译=0)
- `_compile_id`: 全局递增 ID——编译日志 (jitwatch) 用
- 状态: `in_queue`→`assigned` (被 compiler thread 取走)→`compiling` (CI 中)→`compiled` (nmethod 生成)→`failed` (编译失败→解释器 fallback)
- [C++: compile task 超时——`_time_queued` 记录入队时间——`CompileBroker::_compilation_timeout` (默认 2min)——超时→任务被取消——方法继续解释器。防止死循环/JIT bug 导致编译永久卡住]

### 2. OopMap — 编译代码的 GC 栈映射

场景: GC 扫描编译栈帧——JIT 生成的方法没有解释器帧的 OopMapCache——OopMapSet 在编译时生成——每个 safepoint 的 live OOP 位置。

**OopMap** (`oopMap.hpp.cpp`):
- `OopMap`——每个 safepoint (call/loop head/osr entry) 一个 OopMap→描述该点的寄存器/栈槽中的 OOP
- `OopMapSet`——方法的全部 OopMap——`nmethod::oop_maps()` 返回
- [C++: OopMap 的 compile-time 生成——C2 的 register allocator (PhaseChaitin) 已知每个 virtual register 的类型 (OOP/int/long/float)→在 safepoint——记录哪些 physical register 和栈槽持有 OOP→`OopMap::set_oop(VMReg)`
- GC 扫描: 线程在 safepoint→`frame::oops_do(frame, reg_map, closure)`——如果 frame 是 compiled——取 nmethod→取 PC→查 OopMap→`oopmap->oops_do(frame, reg_map, closure)`→GC closure 处理每个 OOP

---

### 核心悬念

**"编译队列: 高优先级方法先编译——C2 threads 在 safepoint 外异步执行——编译超时 2min 防止卡死。"** — CompileBroker 管理编译资源——Java 线程不停歇——编译异步进行。OopMap 在编译时生成——每个 safepoint 的 live OOP 位置——GC 用它扫描编译帧。下一篇: 分层编译——什么时候 C1、什么时候 C2。

> → [02-tiered-compilation-policy.md](02-tiered-compilation-policy.md)
