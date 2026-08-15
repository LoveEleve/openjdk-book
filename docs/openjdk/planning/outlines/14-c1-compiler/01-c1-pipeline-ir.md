# 01. C1 管线 + HIR — 字节码→编译图

> 🔴 Deep | 11 KP 中的 2 个核心机制
> 读者处境: 解释器→C1 编译 `ArrayList.add()`。第一步: GraphBuilder 逐字节码构建 c1_Instruction 图——字节码的隐式操作栈被转换为显式 SSA 变量。

> ⚠️ 写作期修正(2026-08-15, vol-02/14-c1-compiler/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"c1_Compiler::compile_method 6 步管线" 错(重要)**: 入口 `Compiler::compile_method`(c1_Compiler.cpp:246)**只构造 Compilation 对象**;管线在 **c1_Compilation.cpp**: compile_method(:429)→compile_java_method(:370)=**三大步**——①build_hir(:141-258: IR 构建(GraphBuilder)→optimize_blocks(UseC1Optimizations :179)→split_critical_edges→compute_code(块排序,"control flow must not be changed from here on")→**GVN**(UseGlobalValueNumbering)→**RangeCheckElimination**(非 OSR)→eliminate_null_checks→compute_use_counts)②emit_lir(:252-278: LIRGenerator(:256)+**LinearScan do_linear_scan**(:270-276))③emit_code_body(LIR_Assembler)+install_code(:410 env->register_method)——**非"6 步"**
> - **"Step 3: Canonicalizer::canonicalize() 独立阶段" 错(重要)**: Canonicalizer 在 **GraphBuilder::append_with_bci 内联即时调用**(c1_GraphBuilder.cpp:2299-2306,每 append 一条指令 canon.canonical());独立优化=optimize_blocks/GVN/RangeCheckElimination 三趟
> - **"iload_1→创建 LoadLocal" 错**: `load_local`(c1_GraphBuilder.cpp:935-940)=**`push(state()->local_at(index))` 直接取已有 Value**——局部变量槽里存的就是之前 store 的 Value(指令 result),load 零成本;Local 类只是占位(LEAF(Local, Instruction) c1_Instruction.hpp:697)
> - **"BlockBegin 类头 _state/_predecessors/_end" 半对**: BlockBegin=**LEAF(BlockBegin, StateSplit)**(c1_Instruction.hpp:1601),SSA 字段 _successors/_predecessors/_end(:1619-1625);类层次全用 **LEAF/BRANCH 宏**(grep "class X" 找不到)——Phi :641/Local :697/Constant :724/ArithmeticOp :1060/Invoke :1243/NewInstance :1292/Goto :1859/If :1970/Return :2149/Throw :2171/Base :2190;Value=typedef Instruction*(:117)
> - **行号漂移**: c1_GraphBuilder.cpp **4428 行**(大纲 200-1000);c1_GraphBuilder.hpp 427;c1_Instruction.hpp 2632
> - **缺机制(重要)**: ①BlockListBuilder 预扫描(所有分支目标/异常处理器 bci 先 make_block_at :152+);②append_with_bci 的 **LocalValueNumbering**(vmap find_insert :2308-2319)+**InstructionCountCutoff bailout**(:2328)+StateSplit 状态拷贝与 handle_exception 异常边(:2336-2351);③**Phi 创建=ValueStack::setup_phi_for_stack/setup_phi_for_local**(c1_ValueStack.cpp:178-191,块合并时 new Phi 替换,栈槽负索引 -index-1);④If/Goto/Return/Throw 创建(GraphBuilder :1227/:1208/:1599/:2275);⑤invoke(:1841);⑥bailout 家族(BailoutAfterHIR 等)——C1 随时可放弃编译回解释器
> - **实证**: 14-c1-pipeline-demo.txt(PrintCompilation "230 b 3 C1Demo::sum (23 bytes)"/231 % OSR/made not entrant;**PrintIR/PrintLIR 是 notproduct release 无**;jfr 日志等价 -Xlog:jit+compilation)
> - **悬念指向 02 ✓**(02-c1-optimizations.md "Canonicalizer + ValueMap + Optimizer")

### 1. C1 编译管线 — 6 步码生

场景: `CompileBroker`→`c1_Compiler::compile_method(ciEnv)`→C1 6 步管线正式启动。

**c1_Compiler** (`c1_Compiler.hpp.cpp`):
- Step 1: `GraphBuilder::build_graph()`→字节码→HIR 图 (BlockBegin+BlockEnd+c1_Instruction nodes)
- Step 2: Loop detection + builtin optimization
- Step 3: `Canonicalizer::canonicalize()` + `Optimizer::optimize()`→多趟规范化
- Step 4: `LIRGenerator::generate_lir()`→HIR→LIR (machine IR)
- Step 5: `LinearScan::allocate_registers()`→O(n) 寄存器分配
- Step 6: `LIRAssembler::emit_code()`→LIR→x86 机器码→CodeBuffer→nmethod
- [C++: C1 的目标——速度快——毫秒级编译。vs C2——分钟级。C1 牺牲了优化深度 (no escape analysis/loop unswitching/scalar replacement)——但有 profiling data——够给 C2 做输入]

### 2. GraphBuilder — 字节码→HIR 图

场景: `iload_1; aload_0; invokevirtual ArrayList.add;`——GraphBuilder 逐字节码处理: iload_1→BlockBegin 继承的输入状态 (ValueStack)→取 local[1]→创建 LoadLocal→push 到操作栈。aload_0→取出 local[0](this)→create LoadLocal→push。invokevirtual→pop receiver+args→create Invoke node→result→push。

**GraphBuilder** (`c1_GraphBuilder.hpp.cpp:200-1000`):
- `BlockList`: basic blocks——branch target 是 BlockBegin→new block→set next
- `Instruction`: 每条字节码对应一个 Instruction 子类——`LoadLocal/StoreLocal/Constant/Arithmetic/Invoke/Return/NewInstance/NewArray/...`
- [C++: GraphBuilder 的 key——从字节码的隐式操作栈 (implicit stack) 转换为 HIR 的显式变量 (explicit SSA variable)。字节码中 push 后 pop 的隐式传递——在 HIR 中变成 def-use chain。eliminating stack operations→node connects directly to consumer]
- Block splitting: 遇到 if/switch→`BlockBegin* tsux = block_at(bci + branch_target)`→`BlockEnd* end = new If(x, cond, tsux, fsux)`——前驱 block 结束→两个后继 block 创建
- Exception handler: try block→异常边→handler block→handler BCI→phi function (compute which exception type)

### 3. HIR — c1_Instruction 节点层次

**c1_Instruction** (`c1_Instruction.hpp`):
- `Value`→继承—`Instruction` (SSA node with operands)→`Phi` (block merge), `Constant` (int/long/...), `Arithmetic` (Add/Sub/...), `Logic` (And/Or/Xor), `Compare`, `Invoke`, `NewInstance`...
- `BlockBegin`: 基本块头——`_state` (ValueStack——这个块的输入状态)—`_predecessors`→`_end` (BlockEnd)
- `BlockEnd`: `Goto/If/Return/Throw`——控制流出口
- [C++: SSA——每个 Instruction 的 result 被 `ValueStack` 引用——后续 instruction 的 operand 指向此 result。`ValueStack::value_at(int index)`→返回 Value*——def-use chain——不需要显式的 `mov` 指令 (LIR 阶段才生成)]

---

### 核心悬念

**"iload_1→GraphBuilder→LoadLocal→operand stack→invokevirtual→Invoke node→push result。"** — C1 的 6 步管线从字节码到 x86 码。GraphBuilder 把隐式操作栈转换为显式 SSA 变量——消除字节码的 push/pop 开销。下一篇: Canonicalizer——多趟快速优化。

> → [02-c1-optimizations.md](02-c1-optimizations.md)
