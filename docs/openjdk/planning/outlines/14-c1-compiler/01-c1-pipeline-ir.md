# 01. C1 管线 + HIR — 字节码→编译图

> 🔴 Deep | 11 KP 中的 2 个核心机制
> 读者处境: 解释器→C1 编译 `ArrayList.add()`。第一步: GraphBuilder 逐字节码构建 c1_Instruction 图——字节码的隐式操作栈被转换为显式 SSA 变量。

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
