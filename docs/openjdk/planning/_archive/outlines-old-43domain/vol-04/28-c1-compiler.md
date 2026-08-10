# C1 Compiler — 文章大纲

> vol-04 · 域 28 · 🔴 A | 基于 Pass 0+1 探索笔记
> Pass 1 产出：10 基本元素 / 9 标记问题
>
> **→ 从 SharedRuntime**：SharedRuntime 提供了 i2c/c2i 桥接和 IC miss 解析——编译代码最终可以在解释器和编译代码之间自由切换。但编译代码本身从哪来？C1 编译器是怎么把一段字节码变成 CPU 能直接跑的机器指令的？C1 篇见。

## 概念依赖

先修：Interpreter（字节码语义，才知道 GraphBuilder 在翻译什么）、ci（通过 ciBytecodeStream 读字节码，通过 ciMethod 读 profiling 数据）、SharedRuntime（生成的机器码中 call 到 SharedRuntime 的 runtime stub 做 resolve/monitor/exception）。

C1 是 JIT 分层编译中工作最重的编译器——它编译 Level 1-3 的方法，必须在"快"和"好"之间取舍。它用两级 IR（HIR→LIR）和线性扫描寄存器分配来实现"够快 + 够好"。

## 叙事计划

**开篇场景**：一个方法被解释器调了 2000 次，`TieredThresholdPolicy` 判定该编译了。CompileBroker 分配了一个 C1 编译器线程。现在，这个线程拿到了方法的字节码（通过 ciBytecodeStream），需要把它们变成 x86 机器码——但直接翻译机器码的难度太大。C1 选择了一个捷径：分三步走。

**第一层：C1 编译流水线 — 从 CompileBroker 到三阶段管道**

C1 的入口是 `Compiler::compile_method()`（`c1_Compiler.cpp:238`）——`AbstractCompiler` 的子类。CompileBroker 持有 `_compilers[0] = new Compiler()`，调用 `comp->compile_method(ciEnv*, ciMethod*, ...)`。这个方法的实现出奇地简单：在栈上创建一个 `Compilation` 对象（`c1_Compiler.cpp:247`），编译在构造函数中同步完成。

`Compilation` 的构造函数（`c1_Compilation.cpp:542-598`）在初始化完成后立即调用 `compile_method()` → `compile_java_method()`（line 584）。编译成功则 install_code() 在构造函数内注册 nmethod；编译失败（bailout）则调用 `record_method_not_compilable()`（line 586）标记方法。构造函数返回时，编译已完全结束——栈上对象和 ResourceArena 中的 IR 节点随作用域结束时析构函数自动回收。

`Compilation::compile_java_method()`（`c1_Compilation.cpp:370`）展示了 C1 的标准三阶段流水线：

```
PhaseTraceTime _t_buildIR  → build_hir()    → 字节码 → HIR (CFG + Instructions)
PhaseTraceTime _t_emit_lir → emit_lir()     → HIR → LIR (virtual regs + ops)
PhaseTraceTime _t_codeemit → emit_code_body() → LIR → 机器码 (CodeBuffer)
```

每个阶段完成后都有 `CHECK_BAILOUT()` ——如果 OOM 或任何问题，C1 可以优雅地放弃。bailout 语义取决于编译模式：分层编译下（`TieredCompilation=true`），C1 bailout 只标记临时不可编译——方法仍可从 Level 0 重新尝试或交给 C2；非分层模式（`-Xcomp`）bailout 才标记永久 `not_compilable`（`c1_Compilation.cpp:586`）。C1 的 bailout 很便宜，因为它的 IR 在 ResourceArena 中——丢弃即回收，不需要逐节点释放。

为什么不是一步到位（字节码→机器码）？两步中间表示的设计来自"关注点分离"：HIR 承载了 Java 语义（字段访问/方法调用/数组/异常），LIR 承载了机器语义（寄存器/内存地址/条件码）。HIR 上的优化（常量折叠/GVN/范围检查消除）在"理解 Java"的层面操作，LIR 上的优化（register allocation/instruction selection）在"理解 x86"的层面操作。混合在一起两边的优化都无法充分执行。

三步走中还有一个隐藏的细节：HIR→LIR 之前先创建 FrameMap（`compile_java_method:397`），提前确定栈帧布局——LIRGenerator 在生成 LIR 时就知道每个参数/局部变量在栈上的位置。

**第二层：GraphBuilder — 逐字节码翻译成 HIR CFG**

`GraphBuilder`（`c1_GraphBuilder.hpp:38`）是流水线的第一站。核心循环：扫描 `ciBytecodeStream` 的每一个字节码 → 调用对应的 `visit_*()` → 产出 HIR `Instruction` 节点。不同字节码产出不同指令：`iload` → `LoadLocal`，`iadd` → `ArithmeticOp`，`invokevirtual` → `Invoke` + 可能的内联展开。

GraphBuilder 内设内联控制参数：`InlineSmallCode`（被内联方法字节码上限）、`MaxInlineSize`（内联后总字节量上限）、`MaxInlineLevel`（最大嵌套深度）。`try_inline()` 在每次遇到 invoke 时评估：(1) 方法字节码大小是否在限制内？(2) 嵌套层次是否已达上限？(3) 是否被 CompileCommand 或 Directive 排除？只有三个条件都满足才 push 新的 ScopeData。

关键数据结构——`ScopeData` 栈。当 GraphBuilder 决定内联时，push 新 ScopeData（含新方法的 ciBytecodeStream + bci→block 映射），内联完成后 pop 回到调用者。这支持多层内联——每层有独立的优化上下文。

另一个关键数据结构——`BlockList _bci2block`。字节码中的跳转目标映射到 HIR 中的 BlockBegin。同一 bci 只对应一个 BlockBegin——`SubstitutionResolver` 在结束时处理 Phi 函数：所有需要 Phi 的变量在 BlockBegin 入口处汇集多条路径到达的值。

GraphBuilder 还有一个设计精巧的场景：**未加载类的字段访问 patching**。如果 C1 要编译引用一个尚未加载的类的方法（如 `obj.unknownField`），字段偏移量未知——GraphBuilder 不 bailout，而是生成一个 `PatchingStub`：先用标称偏移量 0 访问，如果类后来被加载且实际偏移量不同→触发 `Runtime1::access_field_patching()` 回调→修正代码中的偏移量→继续执行。

**内置的异常建模**：GraphBuilder 在翻译每个可能抛异常的操作时（如 `invokevirtual`、`getfield`、`new`），为该操作创建 `XHandler` 异常处理器链（`c1_IR.hpp:36`）并存入 `XHandlers` 表。每个 HIR Instruction 都持有一个的 `_exception_state`（`Instruction.hpp:302`）——"如果这条指令抛了异常，在抛出点的解释器状态是什么"。后续 LIRGenerator 把这些信息转为 `CodeEmitInfo`（deoptimization 回滚点），LIRAssembler 转成 `ExceptionHandlerTable`——异常处理完整地穿越了三阶段管道。

**第三层：HIR 优化 — 在"理解 Java"的层面做优化**

C1 在 HIR 上运行的优化通道：

1. **Canonicalizer**（`c1_Canonicalizer.cpp`）：做局部简化。`Const 0 + x → x`、`x << 0 → x`、`if (true) → goto`。每个 HIR Instruction 的 `canonicalize()` 方法返回简化后的等价 Instruction。

2. **Optimizer**（`c1_Optimizer.cpp`）：做块级优化。消除不可达块（控制流优化）、合并连续的相同操作、检测不变量移出循环。使用 `iterate_preorder` 遍历 CFG。

3. **ValueMap**（`c1_ValueMap.hpp`）：全局值编号（GVN）。`x = a+b` 和 `y = a+b` 如果 a 和 b 未改变，可以合并为同一个值。去重后在 LIR 中只生成一次计算代码。

4. **RangeCheckElimination**（`c1_RangeCheckElimination.cpp`）：专攻数组边界检查消除。如果代码是 `for (int i=0; i<arr.length; i++) { arr[i] = ...; }`，第一次迭代时会做 bounds check——但 RCE 分析后发现 i 的值范围在 [0, arr.length) 内（来自循环条件 i < arr.length），可以消除后续迭代的边界检查。

关键设计：这些优化都是在 HIR 上运行的——操作的对象是 BlockBegin/Instruction/Phi，而不是寄存器/内存地址。这意味着优化算法可以用 Java 层面的概念推理（"这个字段访问读到的是什么值？"而不是"这个寄存器从哪个内存地址读的？"）。

**第四层：LIRGenerator — HIR→LIR 的降维翻译**

`LIRGenerator::emit_lir()` 遍历 HIR blocks，逐个指令翻译：

```
HIR:  LoadField(field, obj) → LIR:  LIR_Op2(move) + 内存 load
HIR:  ArithmeticOp(+, a, b) → LIR:  LIR_Op2(add, a_reg, b_reg)
HIR:  Invoke(method, args)  → LIR:  参数 move + LIR_OpCall(call_target)
```

LIR 与 HIR 的根本区别：HIR 的指令在"虚拟值"层面操作（每个 Instruction 产出 Value），LIR 的指令在"虚拟寄存器"层面操作（每个操作数是一个 `LIR_Opr`——物理寄存器或虚拟寄存器或栈槽）。

LIRGenerator 的两大职责：(1) 虚拟寄存器分配——在 `_vreg_base` 基础上新增临时 LIR_Opr，保持与 FrameMap 的不冲突。(2) deoptimization 信息生成——每个可能触发出优化的 LIR 操作都附带 `CodeEmitInfo`，记录"出优化时需要还原哪些解释器栈帧状态"。

**第五层：LinearScan — 线性时间的寄存器分配**

`LinearScan`（`c1_LinearScan.hpp:101`）是 C1 最独特的设计选择——线性扫描寄存器分配器 vs C2 的图着色。算法分三步：

1. **build_intervals**：为每个虚拟寄存器建立一个 `Interval`——记录它在 LIR 中的 live range（从最早 def 到最后 use，以 `Range` 列表表示）。`Range` = `{from_op_id, to_op_id}`。

2. **allocate_registers**：按 Interval.start 排序后线性扫描。维护一个 active 列表（当前"活的"intervals）。每遇到一个新 Interval，检查 active 中哪些 intervals 的 end 在当前 start 之前→过期→释放寄存器。为新 Interval 分配第一个可用的物理寄存器。如果没有可用的→选择一个 active interval spill（溢出到栈）。

3. **resolve_data_flow**：在控制流 join 点（Phi 函数），如果变量的寄存器分配在两条边不同→插入 `Move` 操作确保一致性。

LinearScan 在分配过程中还会更新 `_interpreter_frame_size`——所有因 spill 而占用栈槽的变量，如果发生去优化，解释器需要足够的栈空间来恢复这些变量。这意味着编译帧的实际大小必须 ≥ 解释器帧大小，剩余空间就是 LinearScan 可以"借用"给 spill 的——如果不够（spill 太多），bailout。

C1 选线性扫描的原因：图着色构建干涉图是 O(n²)（n = 虚拟寄存器数量），而线性扫描是 O(n log n)（排序开销）。C1 编译 Level 1-3 的方法——这些方法跑的时间短，完美寄存器分配的收益不足以抵消编译时间的成本。

**第六层：LIRAssembler — LIR→机器码的最终发射**

`LIRAssembler` 遍历 LIR_List，每条 `LIR_Op*` 调用对应的 `emit_*()` 方法。`C1_MacroAssembler`（平台相关，x86）提供底层汇编 helper——`addl(reg1, reg2)`、`movl(Address(reg, offset), reg)`、`call_opt_virtual(entry)` 等。

最终产出写入 `CodeBuffer` 中。同时产出：(1) OopMap——记录每条 GC 安全点上的对象引用位置；(2) ExceptionHandlerTable——记录每个 try 块对应的 catch handler 代码偏移；(3) ImplicitExceptionTable——如果采用隐式异常。

`Compilation::install_code()` 调用 `ciEnv::register_method()` 将 CodeBuffer 注册为 nmethod 对象——C1 的编译结果正式进入 CodeCache。

**第六层半：CodeStubs — "出界"代码的延迟发射**

LIRAssembler 在遍历 LIR_List 时不会一次性发射完所有代码——有些代码是"出界"的（out-of-line），不应该插入主流执行路径中。这些是 `CodeStub`（`c1_CodeStubs.hpp:46`）：异常处理入口（throw_NPE/throw_div0）、patching stub（访问未加载类的字段需要运行时修正偏移量）、deoptimization 出口（uncommon trap→退回到解释器）。

CodeStub 在主流代码中是一个 `jmp` 到 stub label——CodeStub 的代码推迟到 nmethod 末尾发射。这样做的好处：主流执行路径紧凑（没有异常处理代码碎片），分支预测友好（uncommon path 不污染 L1 icache）。

**第七层：Runtime1 — C1 编译代码的 30+ C++ 回调**

C1 生成的机器码不是"纯汇编"——它大量依赖回调 C++ 的 Runtime1 stubs。所有在汇编层面无法高效表达的操作（new_instance/fast_new_instance/new_type_array/monitorenter/monitorexit/deoptimize/exception throw）通过 `call Runtime1::xxx_entry()` 回调到 C++。

`Runtime1`（`c1_Runtime1.hpp:86`）的 stub 列表（`c1_Runtime1.hpp:40-74`）包含 30+ 个入口，分四类：

| 类别 | 示例 stub | 调用场景 |
|------|------|------|
| 对象创建 | `new_instance` /`fast_new_instance`/`new_type_array` | `new` 字节码→需要分配堆内存 |
| 同步 | `monitorenter`/`monitorexit`/`nofpu` 变体 | monitor enter/exit→在 slow path 时才调 |
| 异常 | `throw_null_pointer_exception`/`throw_div0`/`handle_exception` | 隐式或显式异常→从 compiled code 跳入异常处理 |
| Patching | `access_field_patching`/`load_klass_patching`/`load_mirror_patching` | 未加载类的字段/类引用→运行时代码修正 |

为什么有 `nofpu` 变体（如 `monitorenter_nofpu`）？`monitorenter` stub 需要保存/恢复所有 FPU 寄存器（因为 monitorenter 可能触发 safepoint，safepoint 需要所有寄存器状态）。`nofpu` 变体不保存 FPU 寄存器——前提是调用点没有活跃的浮点值。C1 跟踪 `_has_fpu_code` 标志（`Compilation:79`）——如果方法不使用浮点，LIRGenerator 生成 `monitorenter_nofpu` 调用，省去 256 字节的 xmm 寄存器 save/restore。

Runtime1 和 SharedRuntime 的关系：Runtime1 的 stubs 是 C1 编译代码专用的——它们是**同步调用**（`call` 指令跳入、`ret` 指令返回），而 SharedRuntime 的 RuntimeStub 是**异步桩**（用于 resolve/IC miss→patch 调用点）。Runtime1 的调用者很清楚"这是一个 new_instance"且期望特定语义，SharedRuntime 的调用者是"这是一个 call，但我不知道目标是谁"。

**第八层：C1 的 profiling 支持 — 为自己也为 C2**

C1 在 Level 2（limited profile）和 Level 3（full profile）时插入 profiling 代码，写入 MethodData：

- Level 2：每个方法入口增加 invocation counter++，每个回边增加 backedge counter++
- Level 3（full profile）：额外为每个虚调点插入 ReceiverTypeData 记录（记录 receiver 的实际类型）、每个分支插入 BranchData 记录（记录 taken/not-taken 频率）

这些 profiling 数据有两个用途：(1) 被 TieredThresholdPolicy 读取——决定 Level 3→4 的过渡时机；(2) 被 C2 读取——做激进的内联和去虚拟化决策。换句话说，C1 的 Level 3 编译是为 C2 做"数据采集"——C1 编译的代码跑得慢但有 profiling，C2 消费这些 profiling 数据做激进优化。

## C1 有意不做的事 — 负面设计空间

理解 C1 的设计哲学，不只靠"它做了什么"——还要看"它选择不做什么"。C1 有意避开这些 C2 的特性：

| 不做的优化 | 为什么不做 | C2 是否做 |
|------|------|:--:|
| 循环展开（loop unrolling） | 大幅增加代码量+C1 代码本就不应该跑久——Level 1-3 的代码会被 C2 重编译 | ✅ |
| 逃逸分析（escape analysis） | 需要全方法分析，对代码大小和编译时间影响大——"够快够好"的 C1 不需要 | ✅ |
| 向量化（auto-vectorization） | 需要复杂的依赖分析，在 C1 的简单 CFG 上做收益有限 | ✅ |
| 去虚拟化（devirtualization） | C1 不读 profiling 数据做激进推断——profiling 是 C2 的工作（C1 只负责采集） | ✅ |
| 代数重写（algebraic reassociation） | 超越 Canonicalizer 的简单 fold 范围——需要表达式树分析 | ✅ |
| 分支预测注入（branch profiling hints） | 不使用 MethodData 中的分支频率做代码布局优化 | ✅ |
| 深度内联（>2 层） | C1 的内联简单且浅——复杂的内联 tree 留给 C2（Sea-of-Nodes 天然支持） | ✅ |

这个"负面空间"定义了 C1 的哲学边界：**C1 是为 C2 做前站工作的快速编译器**——它不求编译出最优代码，只求编译出"比解释器快 10x 且能在需要时被 C2 安全替换"的代码。去优化（deoptimization）是这个哲学的基石——C1 的代码可以被安全地回退到解释器，给 C2 腾出 CodeCache 空间重新编译。

一、**HIR+LIR 两级 IR vs 单级 IR**。两级 IR 增加了设计复杂度（需要两个翻译器、两套数据结构）但分离了 Java 语义优化和机器优化。单级 IR（如 Graal 的 Sea-of-Graph）理论上可以做更深层次的优化（如 Java 层和机器层交叉优化），但实现复杂度爆炸。C1 的取舍：够用就好，不要全功能。

二、**线性扫描 vs 图着色**。线性扫描 O(n log n) 但寄存器使用率 ~70-80%，可能产生溢出；图着色 O(n²) 但寄存器使用率 ~90-95%，几乎无溢出。C1 选线性扫描的理由：Level 1-3 代码的时间短，溢出开销 < 编译时间节省。但有一个微妙的地方：栈溢出（spill）在 x86 上不贵（L1 cache 命中 ~4 cycles），但在运行时可能导致额外的 load/store pipeline stall。C1 的策略是"如果 spill 太多，交给 C2 处理"。

三、**显式 null check vs 隐式异常**。C1 混合使用两种策略：对于小偏移量的访问（offset < 4095，在 x86 的 zero page 范围内），C1 用隐式异常（直接 load [obj+offset]，依赖 SIGSEGV→signal handler）。对于大偏移或特定模式（如访问字段的字段），`MacroAssembler::needs_explicit_null_check()` 返回 true → 显式插 null check。这比 C2 更保守——C1 编译的代码短，显式检查的代码膨胀可接受，且不需要依赖 signal handler 的复杂恢复逻辑。

四、**ScopeData 内联 vs 递归 IR 构建**。C1 用 ScopeData 栈做内联——简单直接但有不规则开销（每个内联层独立的 ciBytecodeStream、新的 bci2block 映射）。C2 用更复杂的 inlining tree（允许多层内联的深度优化如类型传播跨内联边界）。C1 的取舍：内联深度 1-2 层足够 Level 1-3 的代码——C1 不是用来编译内联森林的。

## 核心悬念

**C1 编译器怎么把一段字节码变成机器码——不直接翻译，而是经过 HIR→LIR 两级 IR 的逐步降维，每一步做"这一层能做的最好优化"？三阶段流水线 + 线性扫描分配器 = "够快够好"的编译——C1 成功的秘诀是"不做不该做的事"。**

**→ 下一域**：C1 编译的代码很快但不够激进——虚调用假设只有一种 receiver、循环展开 64 次、逃逸分析把堆分配变成栈分配——这些是 C2 的领域。C2 编译器篇见。

## 预估

1 篇，8 层递进 + "C1 不做的事"负面空间 + 4 个设计权衡，预估 3500-4500 行。
