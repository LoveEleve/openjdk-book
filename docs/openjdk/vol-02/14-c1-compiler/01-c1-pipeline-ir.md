# 01. C1 管线 + HIR — 字节码→编译图

> **前置依赖**:[13-jit-framework/02 — 为什么先 C1 再 C2?— TieredThresholdPolicy 5 层编译策略](openjdk/vol-02/13-jit-framework/02-tiered-compilation-policy.md):C1 是分层编译的中间层;[08-interpreter/01 — 一条字节码的"档案"在哪?— Bytecode 定义表](openjdk/vol-02/08-interpreter/01-bytecodes-definition.md):GraphBuilder 逐字节码构建;[12-ci/01 — JIT 怎么看到 Java 类?— ciObject 镜像体系](openjdk/vol-02/12-ci/01-ci-overview-mirror.md):C1 读的是 ci 镜像
> → **后续**:[14-c1-compiler/02 — C1 优化: Canonicalizer + ValueMap + Optimizer](02-c1-optimizations.md)
> 关联域: 12-ci(编译期镜像)、24-frame(栈帧)

## 字节码怎么变成一张图

C1 的第一步是把字节码(隐式操作栈)翻译成一张**显式的数据流图**——HIR(High-level Intermediate Representation): 局部变量和操作栈变成图节点之间的引用,`push`/`pop` 消失,`iadd` 的两个操作数直接指向产出它们的指令。这张图之后一路下降: LIR(机器相关中间表示)→ 寄存器分配 → x86 机器码。这篇拆三层: **管线的真实结构**(不是六步,是三大步)、**GraphBuilder 怎么逐字节码建图**、**HIR 的节点层次**。[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/14-c1-pipeline-demo.txt)用 PrintCompilation 看到 C1 编译事件,而 PrintIR/PrintLIR 是 debug-only——HIR 图只能靠源码推演。

## 1. 管线真相: 三大步,不是六步

入口 `Compiler::compile_method`(c1_Compiler.cpp:246)只做一件事——**构造 `Compilation` 对象**,管线全在 `c1_Compilation.cpp`。`Compilation::compile_method`(:429)→ `compile_java_method`(:370-405)是三步:

```cpp
// c1_Compilation.cpp:385-406(截取核心,逐字)
  {
    PhaseTraceTime timeit(_t_buildIR);
    build_hir();
  }
  if (BailoutAfterHIR) {
    BAILOUT_("Bailing out because of -XX:+BailoutAfterHIR", no_frame_size);
  }


  {
    PhaseTraceTime timeit(_t_emit_lir);

    _frame_map = new FrameMap(method(), hir()->number_of_locks(), MAX2(4, hir()->max_stack()));
    emit_lir();
  }
  CHECK_BAILOUT_(no_frame_size);

  {
    PhaseTraceTime timeit(_t_codeemit);
    return emit_code_body();
  }
```

①**build_hir()**(:141-258)远不止"GraphBuilder + 优化": IR 构建(内部才调 GraphBuilder)→ `optimize_blocks`(UseC1Optimizations 门控,:179)→ `split_critical_edges` → `compute_code`(块排序,注释 "the control flow must not be changed from here on")→ **GVN**(UseGlobalValueNumbering)→ **RangeCheckElimination**(非 OSR 时)→ `eliminate_null_checks` → `compute_use_counts`。②**emit_lir()**(:252-278): `LIRGenerator` 按线性扫描序生成 LIR(`hir()->iterate_linear_scan_order(&gen)`,:256)+ **`LinearScan::do_linear_scan`** 寄存器分配(:270-276,`_max_spills` 统计)。③**emit_code_body()**: `LIR_Assembler` 发 x86 码;随后 `install_code`(:410)`env->register_method` 注册 nmethod。*关键设计: 大纲的"Step 3 Canonicalizer 独立阶段"不存在——Canonicalizer 在 GraphBuilder 每次 append 时即时内联调用(见 §2);独立优化四趟(optimize_blocks/GVN/RangeCheckElimination/eliminate_null_checks),全在 UseC1Optimizations 门控下,可开关*。C1 全程以"快"为纲: bailout 机制(InstructionCountCutoff、BailoutAfterHIR 等)随时放弃编译回到解释器。

## 2. GraphBuilder: 逐字节码建图

GraphBuilder 的输入是 ciMethod(12 域镜像),输出是 `IR`(含 BlockBegin 图)。**第一步不是建指令,是预扫描**: `BlockListBuilder` 先扫一遍字节码,把**所有分支目标/异常处理器**的 bci 都生成 BlockBegin(`make_block_at`,c1_GraphBuilder.cpp:152+,if/switch 的目标 bci 都在预扫描里登记)——这样后面遇到分支可以直接接上目标块。

主循环逐字节码分派,每条指令经 `append_with_bci`(:2299-2352)入链:

```cpp
// c1_GraphBuilder.cpp:2300-2311(截取核心,逐字)
  Canonicalizer canon(compilation(), instr, bci);
  Instruction* i1 = canon.canonical();
  if (i1->is_linked() || !i1->can_be_linked()) {
    // Canonicalizer returned an instruction which was already
    // appended so simply return it.
    return i1;
  }

  if (UseLocalValueNumbering) {
    // Lookup the instruction in the ValueMap and add it to the map if
    // it's not found.
    Instruction* i2 = vmap()->find_insert(i1);
```

**Canonicalizer 在这里即时跑**(:2300-2302)——常量折叠/冗余消除在 append 时立刻发生,这也是为什么它不占独立 step;接着 **LocalValueNumbering**(vmap 查重,:2308-2319,相同输入相同操作直接复用);指令数超 `InstructionCountCutoff` 就 bailout(:2328);StateSplit 指令(Invoke/NewInstance 等)保存状态拷贝、可 trap 的指令挂异常边(`handle_exception`,:2336-2351)。

**局部变量与操作栈都是 Value 引用**——关键误解纠正: `iload` 并不创建 "LoadLocal" 指令(`load_local`,:935-940)就是 `push(state()->local_at(index))`——**局部变量槽里存的就是之前 store 的 Value(某条指令的 result),load 只是把它压栈**,零成本;`iadd` 变成 `new ArithmeticOp(Add, x, y)`(两个操作数指向图节点);`invokevirtual` 走 `invoke()`(:1841)建 `Invoke` 节点;控制流: `if` 建 `new If(x, cond, ..., tsux, fsux)`(:1227)、`goto` 建 `new Goto(...)`(:1208)、`return` 建 `new Return(x)`(:1599)、`athrow` 建 `new Throw(...)`(:2275)。**块合并处插入 Phi**: `ValueStack::setup_phi_for_stack/setup_phi_for_local`(c1_ValueStack.cpp:178-191)在基本块入口把栈槽/局部槽的值替换成 `new Phi(t, block, index)`(栈槽用负索引 -index-1 区分)——这就是 HIR 的 SSA 形态。

## 3. HIR 节点层次

`c1_Instruction.hpp` 用 **LEAF/BRANCH 宏**声明全部节点类(所以 grep "class X" 找不到): `Value = Instruction*`(:117)。继承树(:48-90): `Instruction` → `Phi`(:641,块合并选择)/`Local`(:697,局部变量占位)/`Constant`(:724)/`AccessField`(LoadField/StoreField)/`AccessArray`(ArrayLength/LoadIndexed/StoreIndexed)/`NegateOp`/`Op2`(`ArithmeticOp` :1060/ShiftOp/LogicOp/CompareOp/IfOp)/`Convert`/`NullCheck`/`TypeCast`/`StateSplit`(`Invoke` :1243/`NewInstance` :1292/NewArray/TypeCheck/MonitorEnter 等)/`BlockBegin`/`BlockEnd`(`Goto` :1859/`If` :1970/`Return` :2149/`Throw` :2171/`Base` :2190)。

**BlockBegin 是 StateSplit**(:1601)——块头记录 `_successors/_predecessors/_end`(:1619-1625,注释 "SSA specific fields")与 ValueStack 输入状态;BlockEnd 是块的最后一条指令(控制流出口)。*关键设计: 图里的数据流是 def-use 链*——一条指令的结果被后续指令直接引用,`push/pop` 的搬运开销在 HIR 里消失,到 LIR 阶段(02 篇与后续)才需要显式 mov。

## 核心悬念

C1 前端拆完: 管线是三大步(build_hir 内含 GraphBuilder+三趟优化+bailout 机制 / emit_lir 的 LIRGenerator+LinearScan / emit_code_body+install_code),Canonicalizer 是 append 时的即时动作而非独立阶段;GraphBuilder 预扫描建块、逐字节码 append(Canonicalizer+LVN 即时消除)、局部变量与操作栈是 Value 引用(iload 零成本)、块合并插 Phi;HIR 节点用 LEAF/BRANCH 宏组织,BlockBegin(StateSplit)连接 BlockEnd(Goto/If/Return/Throw)。[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/14-c1-pipeline-demo.txt)的 PrintCompilation 记录 `230 b 3 C1Demo::sum` 就是这条管线的产物。但"快"还不够——**append 时已经顺手做了常量折叠,正式的优化趟次**(optimize_blocks/GVN/RangeCheckElimination/空检查消除,共四趟)在下一篇展开。下一篇: Canonicalizer 与优化趟次。

> → [14-c1-compiler/02 — C1 优化: Canonicalizer + ValueMap + Optimizer](02-c1-optimizations.md)
