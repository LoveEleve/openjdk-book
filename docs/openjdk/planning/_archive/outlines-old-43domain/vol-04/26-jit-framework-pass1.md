# JIT Framework 第一遍产出：JIT 编译框架

> vol-04 · 域 26 · 🔴 A | Pass 1 扫描完成
> 源码路径：`compiler/` 24 文件 + `runtime/tieredThresholdPolicy.*` + `oops/methodData.hpp`

## 继承树/调用图

```
                     ┌─────────────────────────┐
                     │     CompileBroker        │  ← AllStatic 编排器
                     │  (compileBroker.hpp:138) │
                     │                          │
                     │ _compilers[2]            │──→ AbstractCompiler
                     │ _c1_compile_queue        │──→ CompileQueue
                     │ _c2_compile_queue        │──→ CompileQueue
                     │ compile_method()         │    入口总控
                     │ compiler_thread_loop()   │    编译器线程循环
                     └─────────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
┌──────────────────┐   ┌──────────────────┐   ┌───────────────────────┐
│  AbstractCompiler│   │   CompileQueue   │   │ CompilationPolicy      │
│  (abstractCompi- │   │  (compileBroker. │   │ (compilationPolicy.hpp)│
│   ler.hpp:73)    │   │   hpp:79)        │   │                        │
│                  │   │                  │   │        ┌──────────────┐│
│ _compiler_state  │   │ _first/_last     │   │        │TieredThres-  ││
│ _num_threads     │   │ __first_stale    │   │        │holdPolicy    ││
│ _type(c1/c2/     │   │ _size            │   │        │(tieredThres- ││
│   jvmci)         │   │ add()/get()      │   │        │holdPolicy.   ││
│ compile_method() │   │ purge_stale_tasks│   │        │hpp:165)      ││
│ is_intrinsic_    │   └──────────────────┘   │        └──────────────┘│
│   available()    │                          │───────────────────────│
└──────────────────┘                          │ comp_level()          │
          △                                   │ call_event()          │
          │                                   │ loop_event()  (OSR)   │
  ┌───────┴───────┐                           │ submit_compile()      │
  │   C1 Compiler │    │  C2 Compiler │       │ is_trivial()          │
  │   (c1/)       │    │  (opto/)     │       └───────────────────────┘
  └───────────────┘    └──────────────┘
          │
          ▼
┌───────────────────────────────────────────┐
│              MethodData                    │
│         (oops/methodData.hpp:2495行)       │
│                                            │
│ DataLayout  ── 变长行编码                   │
│ ProfileData ── 基类                        │
│   ├── BitData                              │
│   │    └── CounterData                     │
│   │         ├── ReceiverTypeData           │
│   │         │    └── VirtualCallData        │
│   │         │         └── VirtualCallType   │
│   │         │              Data            │
│   │         ├── RetData                    │
│   │         └── CallTypeData               │
│   ├── JumpData                             │
│   │    └── BranchData                      │
│   └── ArrayData                            │
│        ├── MultiBranchData                 │
│        ├── ArgInfoData                     │
│        ├── ParametersTypeData              │
│        └── SpeculativeTrapData             │
└───────────────────────────────────────────┘

                      CompLevel (compilerDefinitions.hpp:54)
                      ┌─────────────────────────────────┐
                      │ 0  CompLevel_none            解释器│
                      │ 1  CompLevel_simple          C1简略│
                      │ 2  CompLevel_limited_profile C1+计数器│
                      │ 3  CompLevel_full_profile    C1+MDO│
                      │ 4  CompLevel_full_optimization C2 │
                      └─────────────────────────────────┘

                      CompileReason (compileTask.hpp:48)
                      ┌─────────────────────────────────┐
                      │ Reason_InvocationCount  调用计数触发 │
                      │ Reason_BackedgeCount    回边计数触发 │
                      │ Reason_Tiered           分层编译触发 │
                      │ Reason_CTW              CompileTheWorld│
                      │ Reason_MustBeCompiled   LinkResolver│
                      │ Reason_Whitebox         API触发    │
                      └─────────────────────────────────┘
```

## 基本元素分解

1. **CompileBroker** — 编译调度中心，AllStatic 无实例。持有两个 AbstractCompiler（C1/C2），两个 CompileQueue，管理编译器线程生命周期。提供 `compile_method()` 作为唯一外部入口。`compileBroker.hpp:138`
2. **AbstractCompiler** — 编译器抽象基类。`CHeapObj` 子类。持有 compiler state 机（uninitialized→initializing→initialized→failed→shut_down），线程计数，CompilerType 枚举。`abstractCompiler.hpp:73`
3. **CompileTask** — 单个编译任务的封装。链表节点（`_next`/`_prev`），含编译 ID/方法/osr_bci/comp_level/reason/failure。支持 stale 检测（`can_become_stale()`）。`compileTask.hpp:39`
4. **CompileQueue** — 编译等待队列。双向链表 + `_first_stale` 指针。`add()`/`remove()`/`get()`/`purge_stale_tasks()`。`compileBroker.hpp:79`
5. **CompLevel** — 5 级编译层：0 解释器→1 C1 无 profiling→2 C1+计数器→3 C1+full profiling(MDO)→4 C2。`compilerDefinitions.hpp:54`
6. **TieredThresholdPolicy** — 核心分层策略。基于调用计数和回边计数决定升层。含队列长度反馈（Tier3DelayOn/Off）、事件率优先级（淘汰 stale 方法）、threshold 动态伸缩。`tieredThresholdPolicy.hpp:165`
7. **MethodData** — Profiling 数据容器（2495 行）。`DataLayout` 用变长行编码省内存。ProfileData 层级含 CounterData/BranchData/ReceiverTypeData/VirtualCallData 等。`methodData.hpp:75+`
8. **CompilationPolicy** — 策略抽象接口。`event()` 是主通知入口（解释器通知策略"方法被调用了/回边被执行了"）。`NonTieredCompPolicy` 和 `TieredThresholdPolicy` 为实现。`compilationPolicy.hpp:40`
9. **CompilerConfig** — 阈值伸缩计算。`scaled_compile_threshold()` 乘 CompileThresholdScaling。`compilerDefinitions.hpp:116`
10. **CompileTask::CompileReason** — 8 种编译触发原因（InvocationCount/BackedgeCount/Tiered/CTW/MustBeCompiled/Whitebox...）。`compileTask.hpp:48`

## 标记问题（至少 5 个）

1. **[设计决策] 5 级编译层分的粒度选择** — Level 1（C1 无 profiling）和 Level 2（C1+计数器无 MDO）的区别只有计数器，但 1→2 的过渡只在 C2 队列很长时发生（Tier3Delay 机制）。为什么设计成 5 级而不是 3 级（interpreter→C1→C2）？精细粒度带来的收益是什么？`compilerDefinitions.hpp:54-63`、`tieredThresholdPolicy.hpp:37-83`

2. **[设计决策] C2 队列拥堵的自动降级反馈循环** — Tier3DelayOn/Off 机制：C2 队列长度超过 `Tier3DelayOn × c2_count` 时，跳过 0→3 改走 0→2。这个反馈回路如何工作？为什么用滞后（hysteresis，Tier3DelayOff < Tier3DelayOn）防止 jitter？`tieredThresholdPolicy.hpp:127-142`

3. **[数据结构] MethodData 的变长行编码设计** — `DataLayout` 用一个 intptr_t 数组实现变长行（header + cells），不同 ProfileData 子类的行宽不同。为什么不用 C++ 多态类+虚函数？这种编码如何保证内存效率？`methodData.hpp:80-254`

4. **[并发策略] 编译队列的锁机制** — `CompileTask` 自带 `Monitor* _lock`（`nonleaf+2` 级别）。为什么每个 Task 一把锁而不是整个 Queue 一把锁？这与 `CompileQueue::get()` 的 lock-free 部分如何配合？`compileTask.hpp:78`、`CompileQueue::get()` 在 `compileBroker.cpp`

5. **[设计决策] OSR 与普通编译的区别** — OSR 编译有独立的 `_osr_compilation_id` 计数器、独立的 `_osr_bci`、独立的 `_osr_compile_queue`（？不对，同一个队列）。`CompileReason_BackedgeCount` 触发 OSR。OSR 为什么需要和普通编译不同的阈值策略？`compileBroker.hpp:172-173`、`tieredThresholdPolicy.hpp:110`

6. **[调度策略] 编译队列的优先级排序** — `CompileQueue::get()` 遍历队列找到 `compute_rate()` 最高的任务（event rate = d(i+b)/dt），而非 FIFO。为什么用速率而不是等待时间？当速率掉到 0 一定时间后会如何被标记为 stale？`tieredThresholdPolicy.hpp:143-148`、`TieredCompileTaskTimeout`

7. **[内存管理] compiler thread 懒初始化** — `possibly_add_compiler_threads()` 懒创建编译线程，通过 `UseDynamicNumberOfCompilerThreads` 开关控制。为什么不是一次性创建固定数量？懒创建和栈上编译（`-Xcomp` blocking）之间如何协调？`compileBroker.cpp:927`

8. **[跨域] CompileBroker 与 Interpreter 的交互** — `TieredThresholdPolicy::event()` 是解释器通知策略的唯一入口。解释器在哪些点调用这个入口？`InvocationCounter::_counter` 和 MethodData counter 是同一回事吗？`compilationPolicy.hpp:77`

9. **[跨域] CompileBroker 与 ci 的交互** — `CompileBroker::invoke_compiler_on_method()` 在调用 `comp->compile_method(ciEnv*, ciMethod*, ...)` 时创建 ciEnv。ci 给了编译器看 VM 状态的窗口——但 CompileBroker 自己不关心 ci 内部细节，只负责调度和生命周期。`compileBroker.hpp:252`
