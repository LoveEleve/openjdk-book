# 第四卷：编译 — C1 与 C2 的 JIT 世界 — 详细写作规划

> 书籍规划 v2 中：第 17-21 章（5 章）
> 目标：~15,000 行，300-600 页（电子书）

---

## §〇 资产盘点

### 源码范围（总计 ~235,000 行 C++/HPP）

| 目录 | 文件数 | 源码行数 | 核心职责 |
|------|:---:|:---:|------|
| `src/hotspot/share/compiler/` | 50 | 11,808 | 编译触发：CompileBroker、CompilationPolicy、CompilerOracle |
| `src/hotspot/share/c1/` | 46 | 41,054 | C1 客户端编译器：GraphBuilder → LIR → LinearScan |
| `src/hotspot/share/ci/` | 74 | 20,918 | 编译器接口：ciEnv、ciMethod、ciKlass、类型流 |
| `src/hotspot/share/opto/` | 129 | 138,051 | C2 服务端编译器：Ideal Graph → 优化管道 → 代码生成 |
| `src/hotspot/share/code/` | 47 | ~25,000 | CodeCache、nmethod、调试信息、依赖管理 |

### 已完成的 Phase 分析

| Phase | 文档数 | 总行数 | 相关度 | 
|-------|:---:|:---:|------|
| Phase 01-jvm-startup | 3 篇 compiler | 2,785 | 中 — 编译基础设施（CompileBroker 初始化、IC stub） |
| Phase 22-c2-jit | 0 篇 doc | 0 | **空白 — 仅 README 规划 + 1 prompt** |
| Phase 28-code-extra | 3 篇 | 4,433 | 高 — nmethod 布局/生命周期/调试信息/依赖/IC ✓ 已完成 |

### libjvm-analysis 旧文档（4,125 行，需整合复用）

| 旧文档 | 行数 | 复用程度 | 映射到 |
|--------|:---:|:---:|------|
| 01-C2-Pipeline.md | 1,141 | 60% — 概念框架可复用 | 第19章 §19.1 |
| 02-Inline-Decision.md | 502 | 65% — 决策矩阵可复用 | 第19章 §19.4 |
| 03-Chaitin-RegAlloc.md | 453 | 60% — 算法骨架可复用 | 第20章 §20.6 |
| 04-CodeCache-Sweeper.md | 500 | ~50% — 已被 Phase 28 替代 | 第21章 |
| 05-Deoptimization.md | 467 | ~30% — 太浅 | 第21章 §21.6 |
| 06-OopMap-GC-Roots.md | 496 | 跨章节引用 | 第21章 §21.3 |
| 07-Profile-Data-Flow.md | 566 | 60% — profile 数据流可复用 | 第17章 §17.3 |

---

## §一 5 章详细规划

---

### 第17章: 编译触发与策略

> **源文件**: `src/hotspot/share/compiler/` + `src/hotspot/share/runtime/compilationPolicy.cpp`
> **关键源码**: compileBroker.cpp (2,879 行)、compilationPolicy.cpp、compileTask.cpp、abstractCompiler.cpp
> **已有资产**: Phase 01 三篇编译基础设施 doc (2,785 行) + libjvm-analysis/07-Profile-Data-Flow.md

#### 17.1 CompileBroker — 编译任务的调度中枢

```
源文件: src/hotspot/share/compiler/compileBroker.cpp (2,879 行)

核心函数:
  CompileBroker::compilation_init()              — compileBroker_init 入口
  CompileBroker::compiler_thread_loop()          — CompilerThread 主循环
  CompileBroker::compile_method()                — 提交编译任务
  CompileBroker::invoke_compiler_on_method()     — 调用 C1/C2 编译
  CompileBroker::wait_for_completion()           — 等待编译完成

关键数据结构:
  - CompileQueue _c1_compile_queue / _c2_compile_queue — 双队列
  - CompileTask _task 链表 — 任务的创建/提交/完成
  - AbstractCompiler * _compilers[] — C1 / C2 编译器实例

问题组:
  ① 编译请求如何从 Java 层到达 C++ 层？
  ② C1/C2 双队列的设计：任务窃取 vs 固定分配
  ③ CompileTask 生命周期：initing → uncompiled → being_compiled → compiled
  ④ OSR (On-Stack Replacement) 编译的入口差异
  ⑤ CompileBroker::compilation_init() 的 CompilerThread 创建与 CPU 绑定
  ⑥ 编译失败处理：Bailout → 编译拒收 → 解释执行回退

Counterfactual: 为什么用 CountedLoop 检测 OSR 触发，而不是方法入口计数器？
```

#### 17.2 InvocationCounter — 方法调用计数器

```
源文件: src/hotspot/share/runtime/invocationCounter.cpp/.hpp

核心字段:
  - _counter 32 位字：低 16 位 = 主计数，中 8 位 = state，高 8 位 = carry
  - 两个计数器：InvocationCounter（调用次数）+ BackedgeCounter（回边次数）

核心函数:
  InvocationCounter::set_carry()       — decay 半衰机制
  InvocationCounter::reached_InvocationLimit() — 是否达到编译阈值
  Method::invocation_counter()         — 获取方法计数器

关键 JVM 参数:
  -XX:TierXInvokeNotifyFreqLog  编译频率通知阈值
  -XX:TierXBackedgeNotifyFreqLog 回边频率阈值

问题组:
  ① 32 位字的 3 段编码：为什么 carry 位放在高位？
  ② decay（半衰）机制：set_carry() 的位操作详解
  ③ 回边计数器 vs 调用计数器的不同触发策略
  ④ 计数器溢出处理：carry 位的进位传播
```

#### 17.3 CompilationPolicy — 三种编译策略

```
源文件: src/hotspot/share/runtime/compilationPolicy.cpp
        src/hotspot/share/runtime/simpleThresholdPolicy.cpp
        src/hotspot/share/runtime/advancedThresholdPolicy.cpp

三种策略:
  SimpleCompPolicy     — 非分层编译：仅 C2
  StackWalkCompPolicy  — 调用栈深度感知的编译决策
  TieredThresholdPolicy — Tiered Compilation 的 5 级层次

Profile 数据流（复用 libjvm-analysis/07-Profile-Data-Flow.md）:
  MethodData (MDO) → ciMethodData → ProfileData → TypeProfile
  分支概率 → 循环次数 → 类型分布 → 内联决策

问题组:
  ① 三种策略的切换条件与实现差异
  ② TieredThresholdPolicy: 5 级编译层次的具体阈值
  ③ 编译队列优先级：热度 → 优先级排序
  ④ profile 数据如何收集 (InterpreterRuntime × MethodData)
  ⑤ -XX:CompileThreshold 的精确语义
```

#### 17.4 CompilerOracle — 编译指令系统

```
源文件: src/hotspot/share/compiler/compilerOracle.cpp

核心功能:
  CompileCommand 解析：CompileOnly / Exclude / BreakAtCompile / Log / PrintInlining
  文件读取：compilerOracle::parse_from_file()
  命令行解析：compilerOracle::parse_from_line()
  匹配逻辑：compilerOracle::has_option_value()

问题组:
  ① CompileCommand 的 12 种指令类型完整表
  ② 方法匹配规则：通配符 + 签名匹配
  ③ .hotspot_compiler 文件的格式与加载时机
  ④ 编译断点（BreakAtCompile）的实现：os::breakpoint()
```

#### 17.5 OSR (On-Stack Replacement) — 运行时编译切换

```
源文件: src/hotspot/share/runtime/sharedRuntime.cpp (osr)
        src/hotspot/share/opto/compile.cpp (Compile::Compile 的 OSR 路径)

核心概念:
  OSR nmethod 与普通 nmethod 的入口差异
  OSR entry point 的计算：osr_bci → entry_bci 映射
  OSR frame 的 deoptimization 回退

问题组:
  ① OSR 触发的 2 条路径：CountedLoop + BackedgeCounter
  ② OSR nmethod 的生成与入口设置
  ③ OSR → 普通方法的 transition 帧
  ④ 分层编译下的 OSR：Tier 3 vs Tier 4
```

#### 17.6 诊断工具
- `-XX:+PrintCompilation` — 编译日志解读（$、%、@、n 后缀）
- `-XX:+PrintInlining` — 内联决策树
- `jcmd <pid> Compiler.queue` — 实时编译队列
- `strace -p <compiler_thread_tid>` — CompilerThread 系统调用追踪

---

### 第18章: C1 编译器

> **源文件**: `src/hotspot/share/c1/`（46 文件, 41,054 行）
> **已有资产**: 无 — 这是**全新章节**，C1 此前从未被深度分析

#### 18.1 C1 架构总览: 三级编译管线

```
源文件: c1_Compiler.cpp, c1_Compilation.cpp, c1_IR.cpp

三级管线:
  HIR (High-level IR)  — 仍保留字节码结构
  LIR (Low-level IR)   — 虚拟寄存器 + 线性操作
  CodeGen (Machine IR) — 平台相关汇编

8 个编译 Phase（按执行顺序）:
  Phase 1: BUILD_HIR     — GraphBuilder: 字节码 → HIR 基本块
  Phase 2: OPTIMIZE_HIR  — 标准优化：CSE、寄存器分配前优化
  Phase 3: OPTIMIZE_LIR  — LIR 级优化：合并、消除
  Phase 4: ALLOCATE_LIR  — LinearScan: 虚拟寄存器 → 物理寄存器
  Phase 5: CONTROL_FLOW  — 基本块排序、fall-through 优化
  Phase 6: EMIT_LIR      — LIRAssembler: LIR 操作 → 汇编
  Phase 7: EMIT_STUBS    — CodeStub 生成
  Phase 8: EMIT_CODE     — CodeSection 写入

问题组:
  ① 8 Phase 的执行顺序与数据依赖 DAG
  ② C1 编译的主入口: Compiler::compile_method() → Compilation
  ③ 为什么 C1 是 "快速编译"：3 个关键简化 (无 GVN, 无图着色, 无向量化)
  ④ C1 vs C2 的编译速度对比（量化数据）
```

#### 18.2 HIR 构建 — GraphBuilder

```
源文件: c1_GraphBuilder.cpp (4,433 行)

核心职责:
  字节码 → 基本块 → HIR 指令图
  类型推断：c1_ValueType 的 TypeStack 状态传播
  控制流：if/goto/tableswitch → BlockBegin/BlockEnd

核心数据结构:
  - BlockBegin / BlockEnd: 基本块的入口与出口
  - BlockList: 线性 IR 基本块序列
  - ValueStack / ValueMap: 局部变量表状态

关键字节码处理:
  - 加载/存储: iload → LoadField, astore → StoreField
  - 方法调用: invokevirtual → Invoke
  - 对象创建: new → NewInstance, newarray → NewArray
  - 异常: ExceptionObject → ExceptionBlock

问题组:
  ① 从字节码偏移到基本块：GraphBuilder::iterate_bytecodes_for_block()
  ② 类型推断栈：ValueStack 的 push/pop 与 TypeCheck
  ③ 条件分支的分割：if → 两个后继 BlockBegin
  ④ 异常处理表的映射：ExceptionHandlerTable → XHandler 列表
  ⑤ GraphBuilder 的 state 保存/恢复机制 (ciMethod::blocks())
```

#### 18.3 HIR 优化

```
源文件: c1_Optimizer.cpp (1,209 行)
        c1_Canonicalizer.cpp
        c1_RangeCheckElimination.cpp (1,527 行)
        c1_ValueMap.cpp (593 行)

优化项目:
  ① CSE (Common Subexpression Elimination): ValueMap 哈希查找
  ② Canonicalizer: 常量折叠 + 代数简化
  ③ RangeCheckElimination: 数组边界检查消除
  ④ 死代码消除: block_do() 的 remove 标记
  ⑤ NullCheck 消除: 循环中的非空证明

问题组:
  ① C1 的 CSE 为什么是局部（per-block）而非全局？
  ② RangeCheckElimination 的边界证明算法
  ③ Canonicalizer 的 20+ 规范化规则表
  ④ 优化顺序：为什么 RCE 在 Canonicalizer 之后？
```

#### 18.4 LIR 生成与优化

```
源文件: c1_LIRGenerator.cpp (3,675 行)
        c1_LIR.cpp (2,064 行)
        c1_LIR.hpp

HIR → LIR 的映射:
  Instruction 访问者模式 → LIRGenerator::do_Phi / do_ArithmeticOp / do_NewInstance

LIR 指令集:
  - LIR_Op0 (无参数): label / nop / osr_entry
  - LIR_Op1 (单操作数): move / neg / return
  - LIR_Op2 (双操作数): add / sub / mul / cmp / cmove
  - LIR_OpBranch / LIR_OpCall / LIR_OpVisitState

问题组:
  ① LIRGenerator 的 visitor 模式分发：200+ 条字节码 → LIR 指令
  ② LIR 指令的 PhysicalRegister vs VirtualRegister
  ③ LIR 指令的 Operand 系统：register / stack / constant / address
  ④ LIR 级优化：move elimination / delay slot fill
```

#### 18.5 LinearScan 寄存器分配

```
源文件: c1_LinearScan.cpp (6,792 行)

算法 5 步:
  Step 1: 计算 live interval (live range)
  Step 2: 按起始位置排序
  Step 3: 线性扫描分配 (active list)
  Step 4: 溢出处理 (spill)
  Step 5: resolve (phi 移动 + 边界插入)

核心数据结构:
  - Interval: [from, to] 区间 + 分裂链表
  - IntervalUseKind: register / stack / fixed
  - BlockBegin::linear_scan_number

问题组:
  ① live interval 计算：LIR 指令的 use/def/temp 遍历
  ② active list 的 3 状态：active / inactive / free
  ③ spill 位置选择：最远的 next_use 距离
  ④ phi resolution: LIR_Op1::move 的边界插入
  ⑤ 为什么 C1 用 Linear Scan 而不是图着色？速度快 5-10x
```

#### 18.6 CodeGen — LIRAssembler

```
源文件: c1_LIRAssembler.cpp (867 行 share + x86 实现)
        c1_CodeStubs.hpp — 桩代码（异常、类型检查、慢路径入口）

核心职责:
  LIR_Op → x86 汇编的代码发射
  平台相关桩代码生成（c1_Runtime1.cpp）

关键调用:
  LIRAssembler::emit_lir_list(lir)  — 遍历 LIR 指令列表
  LIRAssembler::emit_op0/op1/op2/opBranch  — 指令分派
  LIRAssembler::emit_call(LIR_OpJavaCall) — 方法调用桩

桩代码体系:
  - NewInstanceStub / NewArrayStub — 对象分配慢路径
  - MonitorEnterStub / MonitorExitStub — 锁的慢路径
  - DivByZeroStub / ImplicitNullCheckStub — 异常处理桩
  - PatchingStub / DeoptimizeStub — 修复/去优化桩

问题组:
  ① LIRAssembler 的 4 级分派：op_type → emit_opX → 具体实现
  ② 函数调用的栈帧管理：caller_save/callee_save 寄存器
  ③ 异常表编码：ExceptionHandlerTable 的 LIR 级别映射
  ④ CodeStub 的"桩代码后挂"机制：after_c1_patching
```

#### 18.7 C1 与分层编译

```
C1 在 Tiered Compilation 中的角色:
  Tier 0: 解释执行（profiling）
  Tier 1: C1 + 无 profiling（简单方法的热路径）
  Tier 2: C1 + 调用计数 profiling
  Tier 3: C1 + 全 profiling（为 C2 准备数据）
  Tier 4: C2 激进优化

C1 → C2 升级条件:
  C1 生成的 profile 达到阈值
  CompilationPolicy::event() 触发升级
```

#### 18.8 诊断工具
- `-XX:+PrintC1Statistics` — C1 编译统计
- `-XX:+PrintLIR` — LIR 指令打印
- `-XX:+PrintCFG` — HIR 控制流图打印
- `-XX:+PrintAssembly` (with hsdis) — 最终机器码

---

### 第19章: C2 编译器 (I) — Ideal Graph 与优化管道

> **源文件**: `src/hotspot/share/opto/`（核心 12 文件 ~46,000 行）
> **已有资产**: libjvm-analysis/01-C2-Pipeline.md (1,141 行) 概念框架 + Phase 22 README 10 篇规划
> **Phase 22 待完成**: 10 篇文档，当前 0 篇完成 — 这是第4卷写作前必须补齐的

#### 19.1 C2 架构总览: Sea-of-Nodes IR

```
源文件: compile.cpp (5,024 行)、node.cpp (2,523 行)、phase.cpp

核心入口:
  Compile::Compile()                     — 编译构造函数
  Compile::Optimize()                    — 优化主入口（20+ Phase 遍历）
  Compile::Code_Gen()                    — 代码生成入口

编译阶段流水线（按顺序）:
  Parse (parse1 → parse2 → parse3)     → 字节码 → Ideal Graph
  IterGVN (phaseX)                       → 第一个优化遍
  Inline (doCall → callGenerator)        → 方法内联
  Remove_Useless                          → 死代码消除
  IdealLoop (loopnode → loopTransform)   → 循环优化 (3 轮)
  CCP (phaseX)                           → 条件常量传播
  ConnectionGraph (escape)                → 逃逸分析
  Macro_Expand (macro)                    → 宏节点展开
  Final_Code (output → matcher → chaitin) → 代码生成

核心数据结构:
  - Node: 所有 IR 节点的基类 (2,523 行)
  - Phase: Phase 迭代的基类
  - Compile::_phase: 当前 Phase 枚举

问题组:
  ① Sea-of-Nodes IR 的核心概念：Node + Edge = 计算图
  ② Node::hash() / cmp() — 节点的哈希一致性
  ③ Phase 迭代的 "fix-point" 语义：遍历直到不动点
  ④ Compile::_phase_arena 资源管理
  ⑤ Ideal Graph 的 6 层 Node 类型体系

Counterfactual: 为什么 HotSpot 选择 Sea-of-Nodes 而不是 SSA+CFG 的分离表示？
```

#### 19.2 Parse 阶段 — 字节码到 Ideal Graph

```
源文件: parse1.cpp (2,395 行)、parse2.cpp (2,868 行)、parse3.cpp
        graphKit.cpp (4,060 行)

核心流程:
  Parse::Parse(JVMState* caller) → Parse::do_all_blocks()
  Parse::do_one_block() → 遍历字节码 → Parse::do_one_bytecode()
  parse2.cpp → 200+ 字节码分发 switch

关键结构:
  - JVMState: 内联调用的调用栈表示
  - SafePointNode: safepoint 的 IR 表示
  - GraphKit: IR 构建的工具库 (C2 的"脚手架")

GraphKit 核心方法:
  - GraphKit::gen_stub() → 生成桩代码
  - GraphKit::make_slow_call() → 慢路径调用
  - GraphKit::set_map_clone() → 克隆控制流
  - GraphKit::access_store_at() → 字段存储

问题组:
  ① Parse::do_one_block() 的字节码遍历循环
  ② 200+ 字节码分发：parse2.cpp 的 switch 表
  ③ JVMState 的内联嵌套表示：callee → caller → ... → root
  ④ GraphKit::access_load_at() 的屏障插入（GC barrier）
  ⑤ 局部变量表到 SSI (Static Single Information) 的映射

Counterfactual: 为什么 C2 的 Parse 阶段不和 C1 共享？两个编译器的 IR 设计差异是什么？
```

#### 19.3 GVN / IGVN / CCP — 值编号与常量传播

```
源文件: phaseX.cpp (2,260 行)、node.cpp

三类优化:
  GVN (Global Value Numbering): 基于哈希的等价节点合并
  IGVN (Iterative GVN): 迭代应用 GVN + 增量更新
  CCP (Conditional Constant Propagation): 条件驱动的常量传播

核心算法:
  PhaseGVN::transform(node) → 查找等价的已存在节点 → 合并或新增
  PhaseIterGVN::optimize() → 反复 apply 直到不动点
  PhaseCCP::transform_once(node) → lattice 驱动的常量传播

Type 格体系:
  Type → TypeInt → TypeLong → TypeFloat → TypeDouble
  TypePtr → TypeInstPtr → TypeAryPtr → TypeKlassPtr

问题组:
  ① GVN 的哈希表：hashkey = Node::hash(), equality = Node::cmp()
  ② IGVN 的 worklist 机制：新节点 → 邻居重新计算
  ③ CCP 的 lattice: TOP → constant → BOTTOM 三态传播
  ④ TypeInt::_lo/_hi 的区间运算：add/mul/div 的紧缩区间
  ⑤ TypePtr::meet() 的格交运算：指针类型的精确 meet

诊断: -XX:+PrintIdealGraphLevel — 可视化 Ideal Graph
```

#### 19.4 内联决策系统

```
源文件: doCall.cpp (1,511 行)、bytecodeInfo.cpp (1,231 行)、callGenerator.cpp
        library_call.cpp (6,905 行 — Intrinsic 实现)

内联决策树:
  Compile::inline_incrementally() →
    InlineTree → InlineTree::should_inline() →
      InlineTree::try_to_inline() →
        InlineTree::attempt_inline()

决策因素:
  - 方法大小: MaxInlineSize / FreqInlineSize
  - 调用频率: profile → count / probability
  - 内联深度: MaxInlineLevel (default 9)
  - 已内联字节数: InlineSmallCode

intrinsic (内置):
  library_call.cpp → 300+ intrinsic 方法：
  System.arraycopy, Math.*, String.*, Unsafe.*, Thread.*, Class.*

问题组:
  ① InlineTree 的递归构建：ciMethod → InlineTree 的层级
  ② should_inline() 的 12 条决策规则
  ③ CHA (Class Hierarchy Analysis): 单态/双态/多态的内联策略
  ④ intrinsic 的 inline 优先级：为什么 library_call 在内联树之前
  ⑤ InlineTree::print_inlining() 的内联树输出

诊断: -XX:+PrintInlining 输出解读
```

#### 19.5 循环优化 — PhaseIdealLoop

```
源文件: loopnode.cpp (4,822 行)、loopTransform.cpp (3,909 行)、loopopts.cpp (3,541 行)

PhaseIdealLoop 的主要优化:
  Loop Unrolling — 循环展开（-XX:LoopUnrollLimit）
  Loop Peeling — 循环剥离（第一次迭代特殊处理）
  Loop Predication — 循环谓词（消除范围检查）
  Range Check Elimination — 范围检查消除
  Loop Inversion — 循环反转（do-while 变体）
  Counted Loop 识别 — 精确计数循环

核心数据结构:
  - IdealLoopTree: 嵌套循环树
  - CountedLoopNode: 计数循环节点
  - PhaseIdealLoop (15,397 行 3 文件) — C2 中最复杂的 Phase

问题组:
  ① CountedLoop 的识别条件：初始化 + 步进 + 条件 + Phi
  ② Loop Unrolling 的 3 种策略：完全展开/部分展开/不展开
  ③ Loop Peeling 的 safepoint 消除：第一次迭代的谓词检查
  ④ RCE 的边界证明：循环变量范围 → 数组索引合法
  ⑤ SuperWord (SLP) 自动向量化入口

Counterfactual: 为什么 C2 需要 3 轮 IdealLoop 迭代？什么场景下一轮不够？
```

---

### 第20章: C2 编译器 (II) — Matcher 与 CodeGen

> **源文件**: `src/hotspot/share/opto/`（输出 6 核心文件 ~15,000 行）

#### 20.1 逃逸分析 — ConnectionGraph

```
源文件: escape.cpp (3,650 行)

核心职责:
  ConnectionGraph 构建 → 逃逸状态判定 → 优化决策

逃逸状态 4 种:
  NoEscape      → 栈上分配 + 标量替换 + 锁消除
  ArgEscape     → 仅逃逸到参数（栈上分配仍可行）
  GlobalEscape  → 逃逸到静态字段或线程（无优化）

核心优化:
  - Scalar Replacement (标量替换): 对象字段 → 标量变量
  - Lock Elision (锁消除): 同步块消除
  - Stack Allocation (栈上分配): new → AllocateNode

问题组:
  ① ConnectionGraph 的 DFS 遍历构建
  ② Points-to 分析：对象 → 所有可能指向的位置
  ③ scalar_replacement: AllocateNode → SafePointScalarObjectNode
  ④ Lock Elision 的条件：NoEscape + 非 volatile
  ⑤ escape.cpp 的 20+ check_*() 辅助函数

诊断: -XX:+PrintEscapeAnalysis / -XX:+PrintEliminateAllocations
```

#### 20.2 宏展开 — Macro Expansion

```
源文件: macro.cpp (2,765 行)、stringopts.cpp (2,061 行)

核心流程:
  PhaseMacroExpand::expand_macro_nodes() →
    expand_lock_node()     → Lock → monitorenter CAS loop
    expand_allocate_node() → new → TLAB 分配 + slow path
    expand_arraycopy_node() → System.arraycopy → 离散操作

stringopts.cpp:
  StringBuilder.append → 链式优化 → 预分配 char[]

问题组:
  ① AllocateNode 展开：TLAB fast path + eden slow path
  ② LockNode 展开：fast_lock (CAS) → slow_lock (ObjectMonitor)
  ③ ArrayCopyNode 展开：disjoint/conjoint 的 memcpy vs element-wise
  ④ StringBuilder 优化的 3 阶段：识别 → 合并 → 替换

Counterfactual: 为什么 C2 不是一开始就生成机器指令，而是先保持宏节点？
```

#### 20.3 Matcher — 指令选择

```
源文件: matcher.cpp (2,696 行)、adlc (ADL 编译器)

核心职责:
  Ideal Node (C2 IR) → MachNode (平台相关机器节点)

关键流程:
  Matcher::match() →
    Label_Root → DUIter 遍历 →
    ReduceOper → State → Select

ADL 体系:
  x86.ad → adlc 编译 → 生成 *_MachNode 类
  Rule 格式: match(Set dst (AddI src1 src2)) → instruct addI_reg_reg

指令选择的关键决策:
  register vs memory operands
  addressing modes (base + index*scale + offset)
  flag-setting variants

问题组:
  ① Matcher::Label_Root() 的标签算法
  ② ReduceOper 的状态机：7 种 operand reduction 状态
  ③ ADL 规则的多态匹配：代价最小规则选择
  ④ Special case: 哪些 C2 节点直接在 Matcher 中"展开"而不生成 MachNode
  ⑤ x86 的 lea 指令：多义性匹配（add + shift + load）

诊断: -XX:+PrintOptoAssembly — 匹配后的汇编中间表示
```

#### 20.4 GCM — 全局代码移动

```
源文件: gcm.cpp (2,272 行)、block.cpp (1,795 行)、cfgnode.cpp (2,465 行)

核心职责:
  将 Sea-of-Nodes 线性化到基本块序列

核心算法 2 步:
  Step 1: Schedule_Early  — 早调度（找到最早合法位置）
  Step 2: Schedule_Late   — 延迟调度（找到最小寄存器压力的位置）

关键数据结构:
  PhaseCFG: 控制流图
  Block: 基本块 + 调度链表
  CFGEdge: 控制流边

问题组:
  ① Schedule_Early 的 dominator tree 遍历
  ② Schedule_Late 的 LCA (Lowest Common Ancestor) 计算
  ③ Serial_Block (CFGLoop): 循环的线性化限制
  ④ 投机指令的 Schedule_Late 约束
  ⑤ Register Pressure 感知的调度：为什么延迟比早调更好？

Counterfactual: 为什么不是构造 SSA 形式然后做寄存器分配？Sea-of-Nodes + GCM 的 trade-off 是什么？
```

#### 20.5 Output — 代码发射

```
源文件: output.cpp (2,914 行)、buildOopMap.cpp

核心职责:
  MachNode 序列 → CodeBuffer 的汇编字节

关键流程:
  PhaseOutput::Output() →
    Fill_buffer → 遍历所有块的 MachNode →
    MachNode::emit(cbuf, regalloc) → 最终代码

CodeBuffer 接口:
  MachNode::emit() 通过 assembler 写入 CodeBuffer
  padding / nop / trampoline call

问题组:
  ① PhaseOutput::Fill_buffer() 的块遍历顺序
  ② CodeBuffer 的 CodeSection 管理：insts / stubs / consts
  ③ alignment 与 nop 填充策略
  ④ trampoline call 的生成条件（地址范围 > 32-bit）
  ⑤ OopMap 的记录：OopFlow 的活跃对象追踪
```

#### 20.6 Chaitin 寄存器分配

```
源文件: chaitin.cpp (2,424 行)、ifg.cpp (973 行)、coalesce.cpp (554 行)
        reg_split.cpp、postaloc.cpp

8 个 Stage:
  Stage 1: Build IFG (Interference Graph) — 冲突图构建
  Stage 2: Coalesce — 复制合并（eliminate copies）
  Stage 3: Compute Degree — 度计算
  Stage 4: Simplify — 简化（low-degree spill）
  Stage 5: Select — 选择（pop + 检查冲突）
  Stage 6: Spill — 溢出处理（split live ranges）
  Stage 7: Post-Allocation Copy — 分配后复制消除
  Stage 8: Verify — ChaitinVerify

Chaitin LRG (Live Range Group):
  _reg: 分配的寄存器
  _cost: spill 成本
  _degree: IFG 度数

问题组:
  ① IFG 的构建算法：PhiNode → 同一个 LRG
  ② Coalesce 的 Briggs 算法（conservative merge）
  ③ Spill Cost 的计算：use 次数 × loop depth
  ④ Spill 后的 live range split：AtosB 的 Use/Def 分析
  ⑤ Chaitin 的收敛性：为什么需要 spill 循环？

Counterfactual: 为什么 C2 用 Chaitin 而不用更现代的 SSA-based 寄存器分配？
```

---

### 第21章: CodeCache 与编译产物管理

> **源文件**: `src/hotspot/share/code/` (47 文件, ~25,000 行)
> **已有资产**: Phase 28-code-extra 3 篇完成（4,433 行）
>              libjvm-analysis/04-CodeCache-Sweeper.md (500 行)、05-Deoptimization.md (467 行)

#### 21.1 CodeCache 架构 — 3 段堆管理

```
源文件: codeCache.cpp (1,768 行)、codeHeapState.cpp/.hpp (2,803 行)

核心结构:
  CodeCache: 全局单例 → 3 个 CodeHeap (non-nmethod / profiled / non-profiled)
  CodeHeap: 虚拟内存段 + free list
  CodeBlob: 所有编译代码的基类

3 段堆设计:
  Non-nmethod: 解释器 + stub (216KB min)
  Profiled: C1 + profiling C2 (Tier 2-3)
  Non-profiled: 优化 C2 (Tier 4)

CodeBlob 类型层次:
  CodeBlob → RuntimeStub / BufferBlob / AdapterBlob / MethodHandlesAdapterBlob
           → SingletonBlob → DeoptimizationBlob / ExceptionBlob / SafepointBlob
           → nmethod (编译方法) — 最核心

问题组:
  ① 3 段 CodeHeap 的分离动机：避免 Sweeper 遍历解释器代码
  ② CodeBlob::_code_begin / _code_end 与 CodeSection 的关系
  ③ CodeCache 内存满的处理：Emergency cleanup → Sweeper 激活 → OOM
```

#### 21.2 nmethod 内存布局 — 三段结构

```
源文件: nmethod.cpp (2,995 行) + compiledMethod.cpp (636 行) [Phase 28 doc-00]
        relocInfo.hpp/cpp (2,385 行)

完全复用 Phase 28 分析:
  doc-00-nmethod-Layout-Lifecycle.md (1,204 行)
  doc-01-Debug-Info-Metadata.md (1,643 行)
  doc-02-Dependencies-IC-Exceptions.md (1,586 行)

nmethod 3 段内存布局:
  ┌─────────────────────────────────┐
  │ [1] Header                      │  nmethod 对象自身 (C++ 对象)
  │     _method slot / entry_point   │
  ├─────────────────────────────────┤
  │ [2] Code Section                │  机器码
  │     _code_begin → _code_end      │  (instruction + stub section)
  ├─────────────────────────────────┤
  │ [3] Metadata Section            │  映射到 Java 栈帧
  │     - Exception Cache            │
  │     - Oop Map                    │
  │     - Scope Descriptors (PC→帧)  │
  │     - Pc Descriptors             │
  │     - Relocation Info            │
  │     - Dependencies               │
  │     - Implicit Null Check Table  │
  └─────────────────────────────────┘

本章重点聚焦：
  ○ nmethod 的整体架构和与 C1/C2 的关系（高层视角）
  ○ CodeCache 管理（Sweeper、满处理）
  ○ deoptimization 完整路径
  ○ 底层细节（Debug Info、Dependencies、IC 等）已由 Phase 28 文档深度覆盖
```

#### 21.3 nmethod 生命周期 — 状态机

```
源文件: nmethod.cpp + compiledIC.cpp (720 行) [Phase 28 doc-00/doc-02]

nmethod 状态机 5 态:
  alive (=in_use)   — 正常编译完成，可被调用
  not_entrant       — 标记为不可进入（make_not_entrant）
  not_installed     — 安装失败
  zombie            — 已失效，GC 可回收
  unloaded          — 类被卸载，nmethod 被清理

关键转换:
  make_not_entrant() — 反优化路径 → 替换 IC stub
  make_zombie()      — GC safepoint 安全清理
  flush()            — CodeBlob::flush() 释放 CodeCache 空间

nmethod 验证:
  verify() / verify_dependencies() / verify_oop_relocations()

问题组:
  ① alive → not_entrant: 何时触发？（反优化 / 类重定义 / 假设失败）
  ② not_entrant → zombie 转换：Sweeper vs GC 协作
  ③ IC stub 的 patching：make_not_entrant 后的 stub 重定向
  ④ nmethod::flush_dependencies() 的假设链断开
  ⑤ 1024 个 nmethod 状态转换的性能影响
```

#### 21.4 CodeCache Sweeper — 清扫器

```
源文件: codeCache.cpp 的 sweeper 部分 + compileBroker.cpp
        复用 libjvm-analysis/04-CodeCache-Sweeper.md 概念

核心职责:
  后台清理: 回收不再使用的 nmethod
  主动降级: Full CodeCache → 强制清理 + 丢弃 profiling

Sweeper 3 种模式:
  NMethodSweeper::sweep_code_cache() — 初始清理
  NMethodSweeper::handle_full_code_cache() — 满时强制清理
  NMethodSweeper::possibly_flush() — 低热度 nmethod 淘汰

JVM 参数:
  -XX:NMethodSweepActivity — Sweeper 活跃度
  -XX:+UseCodeCacheFlushing — 启用 CodeCache 清理
  -XX:+SegmentedCodeCache — 3 段 CodeHeap
  -XX:StartAggressiveSweepingAt — 激进清扫阈值

问题组:
  ① Sweeper 的 Hotness 判定：热度衰减公式
  ② 3 段 CodeHeap 的独立清扫策略
  ③ CodeCache 满触发: 编译被拒 → 降级 → GC → 清扫
  ④ Emergency cleanup: ShouldNotReachHere() 的极端路径
  ⑤ Sweeper 线程的调度频率与 CPU 占用
```

#### 21.5 Compiled IC (内联缓存) — 运行时补丁

```
源文件: compiledIC.cpp (720 行)、icBuffer.cpp (234 行) [Phase 28 doc-02]
        compiledIC.hpp

IC 的 3 种状态:
  MonomorphicIC  — 已知单一目标
  PolymorphicIC  — 双态缓存（两个目标）
  MegamorphicIC  — 多态，回退到 vtable/itable

核心操作:
  CompiledIC::set_to_megamorphic()    — 升级到多态
  CompiledIC::set_to_clean()          — 清理 IC
  CompiledIC::set_ic_destination()    — 修改跳转目标

IC stub 补丁:
  NativeJump::patch_verified_entry() — 原子修改跳转指令
  ICRefillVerificationMark — 验证标记

问题组:
  ① Monomorphic → Polymorphic → Megamorphic 的逐级升级触发条件
  ② IC stub 的原子修补机制 (NativeJump::patch_verified_entry)
  ③ icBuffer 的 stub 分配与回收
  ④ nmethod 卸载时 IC 的重定向：make_not_entrant → IC 指向 C2I adapter
```

#### 21.6 Deoptimization — 从编译代码回到解释执行 ★ 重点

```
源文件: src/hotspot/share/runtime/deoptimization.cpp
        src/hotspot/share/code/debugInfo.cpp + scopeDesc.cpp

这是第4卷最复杂的一节，需要追踪完整路径:

触发原因分类:
  Type 1: 逆优化 (Bailout / C2 假设失败)
  Type 2: GC safepoint (需要重建 GC roots)
  Type 3: 调试/Class Redefinition (强制回退)

完整路径 (6 阶段):
  Stage 1: 触发 — Deoptimization::deoptimize()
    ├── deoptimize_frame() — 从编译栈帧重建解释器状态
    └── Deoptimization::UnrollBlock — 展开块（多个帧）

  Stage 2: ScopeDesc 解析 — scopeDesc.cpp (396 行)
    ├── scopeDesc::decode() — 从 nmethod 元数据解析 scope
    ├── ScopeDesc 树 — 内联 → Java 栈帧映射
    └── ScopeValue — 局部变量/表达式栈值的编码

  Stage 3: vframeArray 构建 — deoptimization.cpp
    ├── create_vframeArray() — 从 scope 树构建栈帧数组
    ├── 每个 vframe: 局部变量 + 表达式栈 + 锁对象
    └── 内联帧的处理: 从最内层到最外层

  Stage 4: 栈帧重写 — deoptimization.cpp
    ├── fetch_unroll_info_helper() — 计算展开信息
    ├── UnrollBlock::_frame_sizes[] — 各帧的大小
    └── patch_return_address() — 修改返回地址

  Stage 5: 解释器入口 — templateInterpreterGenerator_x86.cpp
    ├── generate_deopt_entry() — 去优化入口
    └── 从 vframeArray 恢复寄存器/栈

  Stage 6: Java 执行恢复 — templateTable.cpp
    ├── 恢复字节码指针 (bcp)
    ├── 填充操作数栈
    └── dispatch_next() → 继续执行

Deoptimization 的 7 种 Action:
  Action_none (仅逆优化此帧)
  Action_make_not_entrant (标记 nmethod 不可进入)
  Action_make_not_compilable (禁止重新编译)
  Action_reinterpret (重新解释执行)
  Action_make_not_entrant_or_recompile (标记 + 重编译)
  Action_restart_compiler (重启编译器)
  Action_reset_recompile_counters (重置计数器)

Counterfactual 练习:
  如果去优化失败（如 vframeArray 内存不足），JVM 如何兜底？
  (Answer: ShouldNotReachHere() → VMError → hs_err 日志)

诊断工具:
  - -XX:+TraceDeoptimization: 去优化事件追踪
  - jcmd <pid> Compiler.codecache: 查看 nmethod 状态
  - nmethod::print_value_on() — 单 nmethod 状态检查
  - scopeDesc::print_on() — scope 树可视化
```

#### 21.7 GC 与编译代码的交互 — OopMap + GC Roots

```
源文件: buildOopMap.cpp (C2 生成) + oopMap.hpp/cpp + debugInfo.cpp [Phase 28 doc-00]
        复用 libjvm-analysis/06-OopMap-GC-Roots.md

核心概念:
  GC safepoint 时，nmethod 寄存器和栈槽中的 oop 引用
  OopMap → 位图编码（压缩）

关键交互:
  ✗ 解释执行: GC 直接扫描 Java 栈帧
  ✓ 编译执行: GC 必须通过 OopMap 找到编译帧中的 oop

OopMap 编码:
  OopMapValue: 位置 (register/stack slot) + 内容类型
  compressedOopMap: 单遍编码 OopMapSet

问题组:
  ① nmethod 注册 OopMap 的流程：ciEnv::register_method()
  ② GC root 扫描的 nmethod 遍历：CodeCache::oops_do()
  ③ OopMapSet::find_map_at_offset() — PC → OopMap 查找
  ④ compressedOopMap 的单遍解压算法
```

---

## §二 第4卷写作前必须补齐的分析 — Phase 22 缺口评估

### 缺口分级

| 优先级 | 缺口 | 影响章节 | 工作量 |
|:---:|------|---------|:---:|
| **P0** | C2 Parse 阶段 (parse1/parse2/graphKit) — 11,323 行源码 | 第19章 §19.2 | 8,000-10,000 行文档 |
| **P0** | C2 内联决策 (doCall/bytecodeInfo) — 2,742 行源码 | 第19章 §19.4 | 6,000-8,000 行文档 |
| **P0** | C2 GVN/IGVN/CCP (phaseX/node) — 4,783 行源码 | 第19章 §19.3 | 5,000-7,000 行文档 |
| **P0** | C2 循环优化 (loopnode/loopTransform/loopopts/superword) — 16,966 行 | 第19章 §19.5 | 10,000-14,000 行文档 |
| **P1** | C2 逃逸分析 (escape) — 3,650 行 | 第20章 §20.1 | 5,000-7,000 行文档 |
| **P1** | C2 宏展开 (macro/stringopts) — 4,826 行 | 第20章 §20.2 | 4,000-6,000 行文档 |
| **P1** | C2 Matcher+GCM (matcher/gcm/block) — 6,763 行 | 第20章 §20.3-20.4 | 6,000-8,000 行文档 |
| **P1** | C2 Output+Chaitin (output/chaitin/ifg/coalesce/reg_split) — 8,499 行 | 第20章 §20.5-20.6 | 6,000-8,000 行文档 |
| **P2** | C2 Pipeline 综述 (compile.cpp) — 5,024 行 | 第19章 §19.1 | 3,000-5,000 行文档 |

### 已有资产复用策略

| 复用什么 | 来源 | 映射到卷4 | 使用方式 |
|---------|------|---------|---------|
| Phase 28 doc-00 | nmethod 布局/生命周期 | 第21章 §21.2-21.3 | 深度细节在这里，本章只做高层概述 |
| Phase 28 doc-01 | Debug Info/Metadata | 第21章 §21.6 Stage 2 | scope 解码算法详细分析 |
| Phase 28 doc-02 | Dependencies/IC | 第21章 §21.3/21.5 | IC stub patching 和依赖链 |
| libjvm 01-C2-Pipeline | C2 管线概念 | 第19章 §19.1 | 概念框架+术语复用，需扩展 10x |
| libjvm 02-Inline-Decision | 内联决策矩阵 | 第19章 §19.4 | 决策树复用，需扩展 8x |
| libjvm 03-Chaitin | 寄存器分配骨架 | 第20章 §20.6 | 算法 8 步复用，需扩展 8x |
| libjvm 04-CodeCache | Sweeper 概念 | 第21章 §21.4 | 高层概念复用，Phase 28 替代底层 |
| libjvm 05-Deopt | Deopt 概念 | 第21章 §21.6 | 概念框架复用，需扩展 8x |
| libjvm 07-Profile | Profile 数据流 | 第17章 §17.3 | Profile 收集机制直接复用 |

### Phase 22-c2-jit 补齐计划

**当前状态**: README 规划 10 篇文档，但只写了 1 个 prompt (04-Escape-Analysis)，**0 篇文档完成**。

**补齐步骤**:
1. 按 Phase 22 README 的 10 篇方案，逐篇生成 prompt（另起会话）
2. 在新会话中生成文档（4-agent 并行 per 2 篇）
3. 质量审计 → 修复 → 确认达标

**对齐卷4的映射**:

| Phase 22 doc | C2 主题 | 映射到卷4章节 | 目标行数 |
|-------------|---------|-------------|:---:|
| doc-00 | Pipeline Overview | 第19章 §19.1 | 3,000+ |
| doc-01 | Parse 阶段 | 第19章 §19.2 | 4,000+ |
| doc-02 | GVN/IGVN/CCP | 第19章 §19.3 | 3,000+ |
| doc-03 | 内联决策 | 第19章 §19.4 | 3,500+ |
| doc-04 | 逃逸分析 | 第20章 §20.1 | 3,000+ |
| doc-05 | 循环优化 | 第19章 §19.5 | 5,000+ |
| doc-06 | SuperWord 向量化 | 第19章 §19.5 子节 | 3,000+ |
| doc-07 | 宏展开 | 第20章 §20.2 | 3,000+ |
| doc-08 | 指令选择+调度 | 第20章 §20.3-20.4 | 3,500+ |
| doc-09 | Chaitin 寄存器分配 | 第20章 §20.6 | 3,000+ |

**预计总文档量**: 10 篇 × 3,000-5,000 行 = **34,000-45,000 行**

---

## §三 各章源文件映射总表

| 卷4章节 | 源目录 | 核心源文件（行数） | 总源文件 | 总源码行数 |
|--------|--------|-------------------|:---:|:---:|
| 第17章 编译触发 | compiler/, runtime/ | compileBroker.cpp (2,879)、compilationPolicy.cpp、simpleThresholdPolicy.cpp、advancedThresholdPolicy.cpp、compilerOracle.cpp | 10+ | ~12,000 |
| 第18章 C1 编译器 | c1/ | GraphBuilder (4,433)、LinearScan (6,792)、LIRGenerator (3,675)、LIR (2,064)、Optimizer (1,209)、RCE (1,527)、Runtime1 (1,462)、LIRAssembler (867) | 46 | 41,054 |
| 第19章 C2 (I) | opto/ | parse1 (2,395)、parse2 (2,868)、graphKit (4,060)、phaseX (2,260)、node (2,523)、doCall (1,511)、bytecodeInfo (1,231)、library_call (6,905)、loopnode (4,822)、loopTransform (3,909)、loopopts (3,541)、superword (4,694) | 30+ | ~60,000 |
| 第20章 C2 (II) | opto/ | escape (3,650)、macro (2,765)、stringopts (2,061)、matcher (2,696)、gcm (2,272)、block (1,795)、cfgnode (2,465)、output (2,914)、chaitin (2,424)、ifg (973)、coalesce (554)、reg_split、postaloc | 25+ | ~45,000 |
| 第21章 CodeCache | code/ | nmethod (2,995)、compiledMethod (636)、codeCache (1,768)、compiledIC (720)、icBuffer (234)、oopMap、scopeDesc、pcDesc、debugInfo、relocInfo、deoptimization.cpp | 47 | ~25,000 |
| **合计** | — | — | **158+** | **~183,000** |

---

## §四 写作顺序与策略

### 推荐写作顺序

```
Step 1 (P0): Phase 22-c2-jit 全部 10 篇文档生成 — 卷4所有C2章节的基础
Step 2: 第17章 编译触发与策略 — 为后续C1/C2建立编译管道全景
Step 3: 第18章 C1 编译器 — 从简单编译器建立直觉
Step 4: 第19章 C2 (I) Ideal Graph — 基于 Phase 22 分析深入C2前半段
Step 5: 第20章 C2 (II) Matcher+CodeGen — C2 后半段（逻辑依赖第19章）
Step 6: 第21章 CodeCache — 编译产物管理（可提前书写，异步依赖）
```

### 卷4书籍化策略（从分析文档到章节）

每章从已有的分析文档中提取、重组、精简：

```
分析文档 (34K-45K 行 C2 + 4.4K CodeCache + 4.1K 旧文档)
              ↓ 重组 + 添加叙事 + 建立跨章引用
卷4书籍 (5 章, 目标 ~15,000 行)
```

**压缩策略**: 书籍行数约为分析文档的 30-40%：
- 保留: 核心机制解释、file:line 引用、诊断方法
- 精简: 分支旁路、极细节的位操作、重复的代码清单
- 增强: 叙事结构、章间引用、实际案例

---

## §五 关键风险与依赖

| 风险 | 影响 | 缓解 |
|------|------|------|
| Phase 22 10 篇文档无法在卷4写作前完成 | 第19-20章缺少深度细节 | 按优先级分 P0/P1，至少先完成 P0 的 4 篇 |
| C1 编译器完全无分析 | 第18章需要从零开始 | C1 相对简单（41K 行），可独立探索 |
| Phase 28 代码细节与卷4高层视角冲突 | 第21章可能出现冗余 | 明确分工：Phase 28 = 细节，卷4 = 全景 + 连接 |
| 5 章 15K 行难以覆盖 183K 源码的关键路径 | 可能超出版面预期 | 可接受扩展至 20K-25K 行（电子书无页数限制） |

---

## §六 当前资产完整性检查

| 资产 | 行数 | 卷4相关度 | 状态 |
|------|:---:|:---:|------|
| Phase 28 doc-00 (nmethod Layout) | 1,204 | 高 | ✅ 完成 |
| Phase 28 doc-01 (Debug Info) | 1,643 | 中 | ✅ 完成 |
| Phase 28 doc-02 (Dependencies/IC) | 1,586 | 高 | ✅ 完成 |
| Phase 01 doc-10 (CompileQueue) | 1,194 | 中 | 需整合到第17章 |
| Phase 01 doc-17 (VTable/IC/Compiler) | 913 | 中 | 需整合到第17/21章 |
| Phase 01 doc-20 (Compilation Pipeline) | 678 | 中 | 需整合到第17章 |
| libjvm 05-jit-compiler (7 篇) | 4,125 | 中 | 需整合，已被新分析超越 |
| Phase 22-c2-jit (10 篇计划) | **0** | **极高** | ❌ **空白 — 必须补齐** |
| C1 compiler 分析 | **0** | 极高 | ❌ **空白 — 需新建** |
| deoptimization 详细路径 | ~467 (旧) | 极高 | ❌ **太浅 — 需大幅扩展** |

---

## §七 计划可执行性总结

**卷4的 5 章依赖于两大类分析**:
1. **Phase 22-c2-jit** — C2 完整分析（10 篇, ~35K 行）— 当前进度 0%
2. **C1 编译器分析** — 新 Phase 规划（~5 篇, ~15K 行）— 当前进度 0%
3. **Phase 28-code-extra** — CodeCache/nmethod 分析（3 篇, 4.4K 行）— ✅ 100% 完成

**建议执行路径**:
```
Phase 22 (10 篇 C2 prompt + 文档) → 2 周
  → C1 新 Phase 规划 + 执行 → 1 周
  → 卷4写作 (5 章) → 1 周
```
