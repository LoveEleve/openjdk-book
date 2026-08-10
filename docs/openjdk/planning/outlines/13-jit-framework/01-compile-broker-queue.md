# 01. CompileBroker — 编译队列 + compiler 线程

> 🔴 Deep | 8 KP 中的 2 个核心机制
> 读者处境: 解释器跑了 10000 次 `ArrayList.add()`——InvocationCounter 归零——"该 JIT 了"。谁决定编译、怎么排队、谁执行？

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
