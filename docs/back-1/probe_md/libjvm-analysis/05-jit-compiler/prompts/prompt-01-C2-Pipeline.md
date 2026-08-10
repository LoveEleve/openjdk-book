# PROMPT: 请撰写 01-C2-Pipeline.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**C2 编译管道 — 100 条字节码如何经过 8 个阶段变成 10 条 x86 指令**。

### 核心故事线（禁止做源码翻译机！）

凌晨 3 点线上 JVM 崩溃——hs_err 有 `V [libjvm.so+0x...] PhaseIdealLoop::build_and_optimize+0x...`。Native frames 全在 libjvm.so 的 opto/ 目录函数中。这是 C2 编译过程的 bug——用户代码触发了编译器的 corner case。如何在 10 分钟内定位到 C2 的哪个阶段？排除哪个方法可以让 JVM 继续运行？

这不是 C2 源码 walkthrough。这是 **C2 8 个阶段的故事**——每个阶段是一个角色：

- **Parse**（建造者）：把字节码翻译成 Node 图——`iload_0`→`ParmNode`，`iadd`→`AddINode`，`if_icmpne`→`IfNode+BoolNode+CmpNode`
- **IGVN**（化简者）：hash-consing 消除重复——`AddI(0,x)`→`x`，4 次 `hashCode()`→1 次。反复迭代直到收敛
- **Inline**（统一者）：把 callee 的 Node 图嵌入 caller——打破方法边界，让 IGVN "看见"更多代码
- **LoopOpt**（重组者）：loop peeling/unrolling/range check elimination——`PhaseIdealLoop::build_and_optimize()`
- **EscapeAnalysis**（对象消除者）：`ConnectionGraph::compute_escape()`→不逃逸对象→scalar replacement→零分配
- **MacroExpand**（展开者）：`PhaseMacroExpand::expand()`→lock→CAS，allocation→TLAB bump pointer
- **Matcher**（翻译者）：ADL 模式匹配——`AddI`→`addl reg,reg`（x86_64.ad）
- **RegAlloc**（分配者）：Chaitin 着色——∞ 虚拟寄存器→16 GPR。冲突→spill 到栈
- **Output**（序列化者）：`PhaseOutput::install_code()`→CodeCache::allocate()→nmethod 构造→OopMap 生成

**读者前提**：刚从 [04-interpreter] §五学完 InvocationCounter→CompileBroker 触发链。知道 `frequency_counter_overflow()` 产生 `CompileTask` 进入 `CompileQueue`。**本文回答：CompileTask 进入 `CompileBroker::invoke_compiler_on_method()` 之后发生了什么。**

### 你需要知道的（零编译器背景的 Java 工程师在进入源码前必须理解的 6 个概念）

#### 概念 1：Sea of Nodes（节点之海）

传统编译器 IR（中间表示）是线性的——指令按顺序排列：`a = b + c; d = a * 2; return d;`。C2 不同——它使用 **Sea of Nodes**：没有指令顺序，只有**依赖边**。每个 Node 代表一个操作（add / load / if），边代表数据流（"这个 Node 的输出是那个 Node 的输入"）或控制流（"这个 IfNode 控制那个 RegionNode 的执行"）。

线性 IR 中 `a = b + c` 必须在 `d = a * 2` **之前**执行——即使不需要。Sea of Nodes 中 `d = a * 2` 只依赖 `a = b + c` 的输出——没有"顺序"约束。这意味着 Node 可以**自由浮动**——直到被控制依赖"钉住"。控制 Node（If、Start、Return）是唯一的"图钉"。

#### 概念 2：Ideal Graph

Ideal Graph 是 C2 的 IR——由 Node 对象组成的 DAG（有向无环图，控制边可能有环）。每个 Node 有：
- `_in[]`：输入边数组——数据依赖 + 控制依赖
- `_out[]`：输出边数组——谁依赖我
- `Opcode()`：操作类型（`Op_AddI`、`Op_LoadI`、`Op_If`...）
- `bottom_type()`：类型格值（`TypeInt::INT`、`TypePtr::NULL_PTR`...）

Node 通过 `add_req(Node* n)` 添加输入边。`Compile::root()` 是根 Node——所有其他 Node 从它可达。

#### 概念 3：GVN vs IGVN

**GVN**（Global Value Numbering）：哈希-consing——如果两个 Node 的操作码相同、输入相同、类型相同 → 它们是"等价的"→ 合并为一个。`PhaseGVN::transform()` 查询哈希表 `_table`——如果找到等价 Node → 返回已存在的 Node 引用。

**IGVN**（Iterative GVN）：GVN + worklist。一次优化可能暴露新的优化机会——例如 AddI(0,x) → x 后，使用旧 AddI 的 Node 变成使用 x——可能触发新的恒等优化。IGVN 反复迭代直到 worklist 为空（收敛）。

#### 概念 4：ADL（Architecture Description Language）

ADL 文件（`x86_64.ad`）描述 x86_64 的寄存器集、指令模式、栈帧约定。它不是 C++ 源码——是 C2 专有的 DSL（领域特定语言）。Matcher 阶段读取 ADL → 把 Ideal Graph 的通用 Node 匹配到 x86 特定指令。`AddINode` → `instruct addI_reg_reg()` → `addl dst, src`。

#### 概念 5：HIR / LIR（C1 概念，本文对比用）

C1 有两层 IR：HIR（High-level IR = SSA 形式，带 SEAF 节点）和 LIR（Low-level IR = 线性 IR，接近机器码，用于 Linear Scan 寄存器分配）。C2 只用一种 IR（Sea of Nodes）贯穿始终——没有 HIR→LIR 转换开销。这是 C1 vs C2 的核心架构差异。

#### 概念 6：Node 类型格（Type Lattice）

Node::bottom_type() 返回此 Node 可能产生的值的**类型格**——不是"这个 Node 一定是 int"，而是"这个 Node 可能是 int、可能是 long、可能是 top（未初始化）、可能是 bottom（不可达）"。类型格是有向偏序集：`top → long → int → bottom`（更精确 = 更下层）。IGVN 用类型格做优化——如果 `AddINode(x, 0)` 的 bottom_type 是 `int:>=0`→ 可以替换为 `x`（因为加 0 不改变类型下界）。

---

**本文是 05-jit-compiler 阶段的基础文档。前置：[04-interpreter] §五（计数器→CompileBroker 触发）。配套文档：02（Inline 决策——C2 的第一个优化阶段）、03（RegAlloc——C2 的第 6 个阶段）、04（CodeCache——编译结果存放处）、05（Deopt——优化假设破灭的逃生口）。**

### 核心叙事线 — "100 字节码 → 10 条 x86 指令的完整旅程"

1. **★ Parse 阶段：字节码→Node** — `parse1.cpp:do_one_bytecode()` 逐条处理字节码。`iload_0` → `ParmNode`（this 指针）、`iload_1` → 另一个 `ParmNode`（第一个参数）、`iadd` → `AddINode`、`if_icmpne` → `IfNode + BoolNode + CmpNode`、`new` → `AllocateNode`、`invokevirtual` → `CallStaticJavaNode`。GraphKit 提供高层 API（`kit->load_local()`、`kit->store_local()`），内部调用 Node 构造函数。Parse 还在每个基本块边界创建 `SafePointNode`——记录此刻的 JVM 状态（局部变量 + 表达式栈 + 锁状态）→ 供 GC 和 deopt 使用。

2. **★★ IGVN：hash-consing + worklist 迭代** — `phaseX.cpp:transform()`：`_table.hash_find(opcode, in(1), in(2))` → 如果命中 → 返回已存在的 Node。`Node::Ideal(PhaseGVN*, bool)` 是虚函数——每个 Node 子类重写它来定义自己的优化规则。例如 `AddINode::Ideal()`：如果 `in(1)` 是 `ConINode(0)` → 返回 `in(2)`（AddI(0,x)→x）；如果两个输入都是常量 → fold 为 ConINode。IGVN 为什么迭代？因为一次优化暴露新的优化机会——Inline 引入新 Node → IGVN 合并冗余 → 再次触发 Inline → 循环直到收敛。

3. **★★ Sea of Nodes 的设计理由** — 线性 IR（如 LLVM IR）有指令顺序——优化需要"移动"指令。Sea of Nodes **没有顺序**——Node 浮在"节点之海"中，只被控制依赖钉住。`Node::is_CFG()` 返回 true 的控制 Node（If、Start、Return）是仅有的"固定点"。数据 Node 随意浮动到任何地方——由 Matcher 决定最终位置。代价：图匹配（instruction selection）在 DAG 上是 NP-hard → HotSpot 用 ADL 模式 + 手动 Node 选择，不做自动图同构匹配。

4. **★★ Loop Optimization** — `PhaseIdealLoop::build_and_optimize()` (`loopnode.cpp`) 做三件事：(a) Peeling：剥 1 次迭代——使循环不变代码显式化（IGVN 随后优化它）；(b) Unrolling：展开循环体减少分支；(c) Range Check Elimination：比较循环变量边界——如果 `i >= 0 && i < array.length` 是 loop-invariant → 提升到循环外。

5. **★ Escape Analysis** — `ConnectionGraph::compute_escape()` 分析对象引用流。如果对象从未被其他线程或函数外部"看见"→ 不逃逸 → `PhaseMacroExpand::scalar_replacement()` 把分配 Node 删除，字段变成局部变量。`new Point(x,y)` → 两次栈写入（无堆分配、无 GC 开销）。什么时候 EA 失败：对象存储到 static field（全局可见）→ 逃逸；对象传给非内联的调用（call 边界外）→ 逃逸。

6. **★ Matching + Output** — `Matcher::match()` 遍历 Ideal Graph，每个 Node 查 `x86_64.ad` 的 `match_rule_supported()` → 找到对应的 `instruct` 模式。`PhaseOutput::install_code()` → `CodeCache::allocate()` 分配 CodeBlob 内存 → `nmethod::nmethod()` 构造函数填 metadata（OopMap、ExceptionCache、deopt info）→ `Method::set_code(nmethod)` 原子替换入口点。

7. **★★ 全文核心：完整管道追踪** — 选取具体方法 `int hash(String s) { return s == null ? 0 : s.hashCode(); }`，展示：字节码序列 → 每个阶段创建的 Node → 优化前后的 Node 计数 → 最终 x86 输出。每个阶段的"优化前伪代码"→"优化后伪代码"→ 周期数变化。

### 验证报告
- `sverklo_search "C2 pipeline parse IGVN loop optimize matcher output"` → parse1.cpp, phaseX.cpp, loopnode.cpp, matcher.cpp, output.cpp
- `codegraph query "Compile::Compile Compile::Optimize PhaseIdealLoop::build_and_optimize"` → compile.cpp
- `rg -n "do_one_bytecode\|do_one_block\|SafePointNode" parse1.cpp parse2.cpp` → Parse 实现
- `rg -n "transform\|hash_find\|Ideal" phaseX.cpp` → IGVN 实现

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+PrintCompilation -XX:+PrintInlining`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ `-XX:CompileCommand=print,*.hash` 输出指定方法的汇编

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心方法/类（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `compile.cpp` | `src/hotspot/share/opto/compile.cpp` | opto | `Compile::Compile()`(构造器)、`Compile::Optimize()`、`Compile::Code_Gen()` | ★★★ C2 入口——8 阶段调度器 |
| 2 | `parse1.cpp` | `src/hotspot/share/opto/parse1.cpp` | opto | `Parse::Parse()`(构造器)、`Parse::do_one_bytecode()`、`Parse::do_all_blocks()` | ★★★ Parse 阶段——字节码→Node |
| 3 | `parse2.cpp` | `src/hotspot/share/opto/parse2.cpp` | opto | `Parse::do_one_block()`、`Parse::do_if()`、`Parse::do_call()` | ★★ Parse 续——控制流+调用 |
| 4 | `phaseX.cpp` | `src/hotspot/share/opto/phaseX.cpp` | opto | `PhaseGVN::transform()`、`PhaseIGVN::optimize()`、`PhaseCCP::transform_once()` | ★★★ IGVN——hash-consing + worklist |
| 5 | `loopnode.cpp` | `src/hotspot/share/opto/loopnode.cpp` | opto | `PhaseIdealLoop::build_and_optimize()`、`do_peeling()`、`rc_predicate()` | ★★★ Loop 优化——peel/unroll/RCE |
| 6 | `escape.cpp` | `src/hotspot/share/opto/escape.cpp` | opto | `ConnectionGraph::compute_escape()`、`ConnectionGraph::split_unique_types()` | ★★★ Escape Analysis |
| 7 | `macro.cpp` | `src/hotspot/share/opto/macro.cpp` | opto | `PhaseMacroExpand::expand()`、`scalar_replacement()`、`expand_lock_node()` | ★★★ Macro Expansion |
| 8 | `matcher.cpp` | `src/hotspot/share/opto/matcher.cpp` | opto | `Matcher::match()`、`Matcher::match_tree()`、`Matcher::Label_Root()` | ★★★ Instruction Selection |
| 9 | `output.cpp` | `src/hotspot/share/opto/output.cpp` | opto | `PhaseOutput::install_code()`、`PhaseOutput::init_buffer()` | ★★★ Code Generation + OopMap |
| 10 | `chaitin.cpp` | `src/hotspot/share/opto/chaitin.cpp` | opto | `PhaseChaitin::Register_Allocate()` | ★★ RegAlloc（详参 03） |
| 11 | `doCall.cpp` | `src/hotspot/share/opto/doCall.cpp` | opto | `InlineTree::should_inline()`、`InlineTree::try_to_inline()` | ★★ Inline 决策（详参 02） |
| 12 | `compileBroker.cpp` | `src/hotspot/share/compiler/compileBroker.cpp` | compiler | `CompileBroker::compile_method()`、`CompileBroker::invoke_compiler_on_method()` | ★★ 编译触发→C2 入口 |
| 13 | `x86_64.ad` | `src/hotspot/cpu/x86/x86_64.ad` | cpu/x86 | ADL 指令模式定义 | ★★ 指令选择——Ideal→x86 映射 |

**跨模块说明**：C2 编译管道横跨 opto/（主编译逻辑）、compiler/（共享编译基础设施）、cpu/x86/（平台专有 ADL + 汇编器）。Parse 阶段还依赖 ci/ 层读取类元数据（详参 07-Profile-Data-Flow）。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ Parse：字节码→Node 转换

```
问题：
  ① parse1.cpp:do_one_bytecode() 如何将 iload_0 变成 ParmNode？
      线索: parse1.cpp 中 GraphKit 的 load_local() → map()->local(java_index)
      答案方向: iload_0 不创建新 Node——直接返回 map 中已存在的 ParmNode（方法入口时 Parse 构造的）。
      iload_1 同样。iadd 才创建新 Node——AddINode(in(1)=ParmNode(this), in(2)=ParmNode(arg1))。
      追问: 为什么是 ParmNode 而不是 LocalNode？→ ParmNode = parameter input，是方法的外部输入；
      方法内部不需要"加载参数"——参数已经在 map 的 local 槽中。

  ② parse2.cpp:do_one_block() 如何将 IF_ICMPNE 变成 IfNode+BoolNode+CmpNode？
      答案方向: Parse::do_if() → kit->gen_if()→ 创建 CmpINode(比较两个值) + BoolNode(比较结果编码为 0/1)
      + IfNode(根据 Bool 值分支)。IfNode 有两个 ProjNode 子节点——True 路径和 False 路径。
      追问: 为什么是 3 个 Node 而不是 1 个？→ 分离比较操作(CmpI)、布尔编码(Bool)和控制流分支(If)
      ——这使得每个子操作可以独立被 IGVN 优化。例如 CmpI(a,b) 和 CmpI(b,a) 可以通过 Bool 的翻转发现等价。

  ③ 为什么 Parse 在每个基本块边界创建 SafePointNode？
      线索: parse1.cpp 中 SafePointNode 构造
      答案方向: SafePointNode 记录此刻的 JVM 状态快照——局部变量值、表达式栈值、持有的 monitor。
      GC 需要 SafePointNode 找到 oop 根（哪些寄存器/栈槽有对象指针）；deopt 需要它重建解释器帧。
      不在每个字节码创建——只在基本块边界（因为基本块内部 GC 不会发生——safepoint poll 只在循环回边和
      方法返回处）。
```

### 4.2 ★★★ IGVN：hash-consing + 迭代优化

```
问题：
  ① PhaseGVN::transform() 的哈希表查询怎么工作？
      线索: phaseX.cpp:transform()
      代码引证:
        Node* PhaseGVN::transform(Node* n, bool delay) {
          Node* k = _table.hash_find(n->Opcode(), n->in(1), n->in(2));
          if (k) return k;  // 已存在等价 Node → 复用
          ...
        }
      答案方向: 哈希键 = (opcode, in(1)索引, in(2)索引)。如果找到 → 返回已存在的 Node（hash-consing）。
      如果未找到 → 调用 n->Ideal() 看有没有代数优化 → 如果有 → 对新 Node 递归 transform() →
      最后插入哈希表。追问: 为什么哈希键只含 opcode + 前 2 个输入？→ 多数 Node 只有 1-2 个输入；
      3+ 输入的 Node 通过额外的 `hash()` 虚函数自定义哈希键。

  ② Node::Ideal(PhaseGVN*, bool) 返回什么？以 AddI(0,x)→x 为例。
      答案方向: Ideal() 返回优化后的 Node。如果返回 this → 无优化，保持原样。
      如果返回另一个 Node → 替换。AddINode::Ideal() 检查 in(1) 是否是 ConINode(0) → 是 → 返回 in(2)（即 x）。
      追问: 为什么不在构造函数中处理？→ 构造时可能还不知道输入的具体值（输入 Node 还没被 transform）。
      IGVN 的 worklist 机制保证：输入被优化后 → 依赖 Node 重新进 worklist → Ideal() 重新调用。

  ③ 为什么 IGVN 需要迭代直到收敛？
      答案方向: 一次优化的输出可能是另一次优化的输入——连锁反应。例如：Inline 引入 callee 的 Node →
      IGVN 发现这些新 Node 中 3 个 hashCode() 等价 → 合并为 1 个 → 这导致 hashCode() 的结果被常量折叠 →
      触发后续 if 的常量分支消除 → 死代码消除 → ... 反复进行直到 worklist 为空。
      追问: 最大迭代次数？→ 有上限（防止无限循环），默认 ~20 轮。
```

### 4.3 ★★ Sea of Nodes 设计理由

```
问题：
  ① 为什么叫"Sea of Nodes"？和线性 IR 的本质区别是什么？
      答案方向: 线性 IR = 指令序列——"第 1 条指令在第 2 条之前"。Sea of Nodes = 无顺序——
      只有数据依赖边 + 控制依赖边。Node 可以自由浮动到任何位置直到被"钉住"。
      Node::is_CFG() 返回 true 的控制 Node 是仅有的固定点（If、Start、Return、Region）。
      追问: 自由浮动的代价？→ 图匹配（instruction selection）在 DAG 上是 NP-hard。
      HotSpot 用 ADL 模式 + 手动选择，不做自动图同构。

  ② 如果不用 Sea of Nodes 而用线性 IR——会失去什么优化？
      答案方向: 失去"指令重排的自由度"。线性 IR 中 `a = b + c; d = e + f; return a + d;`
      两条加法有顺序——不能交换。Sea of Nodes 中两者无依赖关系 → 可以任意重排 →
      寄存器分配时可以交错使用寄存器 → 减少 spill。更有价值的是——线性 IR 中跨基本块的
      公共子表达式消除（GCSE）需要复杂的数据流分析；Sea of Nodes 中直接通过哈希表查找等价 Node。

  ③ Node::is_CFG() 的意义——为什么只有控制 Node 被钉住？
      答案方向: 控制流决定"哪些 Node 会执行"——IfNode 钉住两个分支的 ProjNode；
      RegionNode 合并多个控制流。数据 Node 只依赖其输入的数据和控制——不关心"在第几条执行"。
      但最终 Matcher 阶段需要把 Node 映射到有顺序的机器码 → 控制 Node 的 CFG 边决定了基本块的
      排列顺序（block.cpp）。
```

### 4.4 ★★ Loop Optimization：peeling + unrolling + RCE

```
问题：
  ① PhaseIdealLoop::do_peeling() 为什么剥 1 次迭代？
      线索: loopnode.cpp 中 do_peeling
      答案方向: 剥 1 次迭代 = 把循环的第一次迭代"展平"到循环之前。为什么？第一次迭代中有大量
      loop-invariant 代码——但 JVM 还没"看见"它们是 invariant（因为变量在循环头定义）。剥离后
      这些代码在循环外部执行一次——IGVN 随后可以将它们优化掉。追问: 为什么不多剥几次？
      → 每次剥离增加代码大小（CodeCache 压力）→ 1 次是最佳的 tradeoff。

  ② PhaseIdealLoop::rc_predicate() 如何消除范围检查？
      答案方向: 如果循环变量 i 的范围是 [0, n)，且每次迭代都检查 i >= 0 && i < array.length →
      分析循环条件可以证明：如果 array.length > n → 所有迭代中 i < array.length 恒成立 →
      消除循环体内的 bounds check。RCE 的前提：循环边界和数组长度之间存在可证明的不等式关系。

  ③ 循环优化的"错误代价"：如果 RCE 错误地消除了一个必要的检查？
      答案方向: C2 的 RCE 是"安全"的——它只消除可证明冗余的检查。但如果有 bug → 数组越界访问
      不会触发 ArrayIndexOutOfBoundsException → 程序读取非法内存 → SIGSEGV。
      这就是 hs_err 中 `PhaseIdealLoop::build_and_optimize` 崩溃的原因之一——LoopOpt 生成了越界的
      内存访问。
```

### 4.5 ★ Escape Analysis：对象分配→标量替换

```
问题：
  ① ConnectionGraph::compute_escape() 怎么判断对象"不逃逸"？
      线索: escape.cpp 中 compute_escape
      答案方向: 从分配点出发，追踪对象引用流——通过参数传递、字段存储、返回值——
      形成 ConnectionGraph。如果对象的信息（引用、字段）从未到达以下"逃逸点"→ 不逃逸：
      (a) static field 写入（全局可见），(b) 方法返回值（caller 可见），
      (c) 传递给没有内联的调用（call 边界外——无法跨方法分析）。
      追问: 如果另一个线程可能访问 → 什么条件？→ 只有当对象引用被存储到 static field 或
      传递给 Thread.start() 的 Runnable。

  ② PhaseMacroExpand::scalar_replacement() 怎么消除分配？
      答案方向: 分配 Node（AllocateNode）被删除 → 对象的每个字段变成独立局部变量 → 
      字段读取变成局部变量读取 → 字段写入变成局部变量写入。最终 Matcher 决定这些局部变量
      在寄存器中还是栈上。零堆分配 = 零 GC 压力。

  ③ 什么时候 EA 失败——最常见的"假逃逸"模式？
      答案方向: (a) `this.field = new Foo()` → 存储到字段 → 对象逃逸（字段可能被任何方法读取）；
      (b) `return new Foo()` → 返回给 caller → 逃逸；(c) `list.add(new Foo())` → 参数传递
      给非内联的 add() → 逃逸。追问: 如果 add() 被内联了呢？→ EA 可以"看穿"内联后的代码 →
      可能发现 Foo 最终也没有逃逸到 add() 之外 → 仍然不逃逸——这就是为什么内联对 EA 至关重要。
```

### 4.6 ★★ Matching + Output：Ideal Node → x86 指令

```
问题：
  ① Matcher::match() 如何将 AddINode 映射到 x86 指令？
      线索: matcher.cpp + x86_64.ad
      答案方向: ADL 文件 `x86_64.ad` 中定义了 `instruct addI_reg_reg()`——
      `match(AddI dst src)` → `format %{ "addl $dst, $src" %}` → `ins_encode %{ __ addl($dst$$Register, $src$$Register); %}`。
      Matcher 遍历 Ideal Graph → 对每个 Node 调用 `match_rule_supported(node->Opcode())` →
      找到第一个匹配的 ADL instruct → 创建对应的 MachNode → 分配虚拟寄存器 → 放入基本块。

  ② PhaseOutput::install_code() 做了什么？
      答案方向: (1) CodeCache::allocate() 分配 CodeBlob 内存；(2) 填充机器码字节 + relocations +
      metadata；(3) 构造 nmethod 对象——把 OopMap、ExceptionCache、deopt info 写入 nmethod 的
      各个 section；(4) Method::set_code(nmethod) 原子替换方法入口点。
      追问: 如果 CodeCache 满了 → allocate() 返回 NULL → compile 失败 → 方法留在解释器。

  ③ OopMap 在这个阶段怎么生成？
      答案方向: 每个 safepoint（SafePointNode）→ `OopMapSet::add_gc_map(pc_offset)` →
      遍历 SafePointNode 的 oop 槽 → 为每个 oop 在 OopMap 中设置 bit → 生成位掩码（~10 bytes/safepoint）。
      详参 06-OopMap-GC-Roots。
```

### 4.7 ★★★ 全文核心：完整管道追踪（"100 字节码→10 指令" walk）

```
问题：
  选取具体方法：
    int hash(String s) {
      return s == null ? 0 : s.hashCode();
    }

  ① 字节码序列（~12 条）：
    aload_0         // 加载 s
    ifnonnull L1    // 如果 s != null 跳转 L1
    iconst_0        // 返回 0
    ireturn
  L1:
    aload_0
    invokevirtual #2 java/lang/String.hashCode:()I
    ireturn

  ② Parse 阶段创建的 Node：
    ParmNode(s) → IfNode(BoolNode(CmpP(s, null), EQ)) → ProjTrue → ConINode(0) → ReturnNode
                                                     → ProjFalse → CallStaticJavaNode(hashCode) → ReturnNode
    Node 数：~15

  ③ IGVN 后：
    - CallStaticJavaNode(HashCode) 被 IGVN 标记待 inline（InlineTree 注册为 late inline candidate）
    Node 数不变（inline 还未发生）

  ④ Inline 后：
    - String.hashCode() 的字节码被 Parse 成 ~40 个 Node → 融入 caller 图
    - hashCode() 内部：this.value.length hashCode 计算变成循环（LoopNode + PhiNode）
    Node 数：~60

  ⑤ IGVN 再迭代后：
    - hashCode() 内部 3 次 getfield(value) 合并为 1 次
    - LoopNode 的 CountedLoop 识别（因为循环是标准的 for i=0; i<len; i++）
    Node 数：~40（合并冗余、常量折叠）

  ⑥ LoopOpt 后：
    - Peeling：循环外提 1 次（invariant 代码提升）
    - 循环体从 12 个 Node 减少到 8 个
    Node 数：~35

  ⑦ EA 后：
    - String.hashCode() 内部分配了一个 int[] 缓存 → EA 发现不逃逸 → scalar replacement
    Node 数：~30（分配消除）

  ⑧ Matcher + RegAlloc + Output 后：
    - ~30 个 Ideal Node → ~10 条 x86 指令
    - 包括：mov + test + jne + lea + add + cmp + jle + movsxd + imul + add
    x86 指令数：~10

  ★ 周期数变化：
    解释器执行 12 条字节码：~500 cycles（每条字节码 ~40 cycles dispatch 开销）
    C2 编译后执行 10 条 x86：~30 cycles（每条 ~3 cycles，现代 x86 superscalar）
    加速比：500/30 ≈ 17×
    如果 hashCode() 没有被内联：解释器执行 12 + ~80 条（hashCode 字节码）≈ 3000 cycles
    → C2 加速比约 100×
```

## 五、文章结构

```
§〇 生产场景 — hs_err 崩溃定位 + C2 阶段排除 CompileCommand 工作流
  ★ 真实 hs_err 输出 —— V [libjvm.so+...] PhaseIdealLoop::build_and_optimize
  ★ 10 分钟定位流程：hs_err native frames → 定位 C2 阶段 → CompileCommand exclude 方法

Actual hs_err output from a C2 compilation crash:

```
# A fatal error has been detected by the Java Runtime Environment:
#  SIGSEGV (0xb) at pc=0x00007f8b1a3c4d21, pid=12463, tid=12494
#
# J 16193 C2 java.util.HashMap::hash(I)I (40 bytes)
#
# Native frames: (J=compiled Java code, j=interpreted, Vv=VM code)
# V  [libjvm.so+0x8c4d21]  PhaseIdealLoop::build_and_optimize+0x341
# V  [libjvm.so+0x8c2a15]  PhaseIdealLoop::do_one_loop+0xf5
# V  [libjvm.so+0x7f1230]  Compile::Optimize+0x250
# V  [libjvm.so+0x6d0980]  Compile::Compile+0xa10
```

Reading this output:
- "J ... C2 java.util.HashMap::hash" = HashMap::hash was BEING COMPILED when the crash happened. This is the method that TRIGGERED the C2 bug — exclude it to restore production.
- "PhaseIdealLoop::build_and_optimize+0x341" = crash inside loop optimization. The crash was NOT in user code — it was in C2's optimizer processing the user's bytecodes.
- "libjvm.so+0x8c4d21" = use addr2line to map to exact source: `addr2line -e libjvm.so 0x8c4d21` → loopnode.cpp:1234 (example)
- Workflow: hs_err native frames → locate C2 phase → identify crash method (Compile_id + method) → `-XX:CompileCommand=exclude,com.example.Class::method` → JVM resumes

§一 ★★★ C2 编译管道全景 — 8 阶段 Mermaid 图 + 时间分布
  ❓ 为什么不是 5 个阶段也不是 12 个阶段？
  ❓ 每个阶段的关键文件 + 入口函数
  1.1 Compile::Compile() 构造器 — 阶段调度器
  1.2 ★ Mermaid 图：8 阶段完整管道，标注每个 Phase 名、入口文件、Node 数变化
  1.3 时间分布：Parse(0-5ms) → IGVN+Inline+LoopOpt(5-80ms) → Matcher+RegAlloc+Output(80-100ms)
  1.4 ★ 和 [04-interpreter] §五 的连接 —— 计数器→CompileBroker→Compile::Compile()

§二 ★★★ Parse 阶段 — 字节码→Node 的逐条转换
  ❓ iload_0 为什么不创建新 Node？
  ❓ if_icmpne 为什么需要 3 个 Node？
  2.1 parse1.cpp:do_one_bytecode() — GraphKit 的高层 API
  2.2 parse2.cpp:do_one_block() — 控制流 + 调用处理
  2.3 SafePointNode 的创建时机 — 为什么在基本块边界？
  2.4 ★ "优化前字节码" vs "优化后 Node 图" — 12 条字节码 → 15 个 Node

§三 ★★★ IGVN 阶段 — hash-consing + worklist 迭代
  ❓ 为什么 hash-consing 不是一次完成？
  ❓ AddI(0,x) → x 之后还能触发什么优化？
  3.1 PhaseGVN::transform() — 哈希表查找
  3.2 Node::Ideal() — 虚函数多态优化
  3.3 ★ IGVN 迭代收敛过程 — worklist 的 push-pop 循环
  3.4 ★ 连锁反应案例 — Inline → 新 Node → IGVN → 合并 → 旧 Node 死亡 → 更多优化

§四 ★★ Sea of Nodes 设计理由
  ❓ 为什么 Sea of Nodes 没有顺序？
  ❓ 如果改用线性 IR 会失去什么？
  4.1 Node::is_CFG() — 仅有的固定点
  4.2 数据 Node 的自由浮动 — 寄存器分配的收益
  4.3 图匹配的 NP-hard 代价 — ADL 模式 vs 自动图同构

§五 ★★ Loop Optimization
  ❓ 为什么剥 1 次循环而不是 3 次？
  ❓ RCE 的"安全性"——消除 bounds check 的前提是什么？
  5.1 PhaseIdealLoop::build_and_optimize() — build_loop_tree + optimize
  5.2 Peeling — 使 invariant 代码显式化
  5.3 Range Check Elimination — 不等式证明

§六 ★★ Escape Analysis + Macro Expansion
  ❓ "不逃逸"的精确定义——什么条件下对象一定不逃逸？
  ❓ 如果 EA 错误判断"不逃逸"→ 会有什么后果？
  6.1 ConnectionGraph::compute_escape() — 引用流追踪
  6.2 PhaseMacroExpand::scalar_replacement() — 分配→标量
  6.3 EA 失败的三模式 — static field / return / non-inlined call

§七 ★★ Matching + Output
  ❓ ADL 文件 (.ad) 怎么被读取和执行？
  ❓ 如果 CodeCache 满了——nmethod 去哪了？
  7.1 Matcher::match() + x86_64.ad instruct 模式
  7.2 PhaseOutput::install_code() + CodeCache::allocate()
  7.3 nmethod 构造 + OopMap 生成（详参 06）

§八 ★★★ 完整管道追踪 — "hash(String)" 的 100 字节码→10 指令 全流程
  ★ 8 个阶段的 Node 数变化表（BEFORE / AFTER）
  ★ 8 个阶段的 x86 伪代码输出
  ★ 周期数加速比：解释器 3000 vs C2 30 cycles = 100×

§九 GDB 验证 + 可证伪断言 (≥12 条)
  断言 1: Compile::Compile() 入口 — 验证 compile_id + method name → _compile_id > 0
  断言 2: Parse::do_one_bytecode() — 验证 iload_0 → map 本地变量 → ParmNode(this)
  断言 3: PhaseGVN::transform() — 验证 hash_find 命中 → 已存在的等价 Node
  断言 4: Node::Ideal() — 验证 AddI(0,x)→x 替换 → callee 被优化
  断言 5: InlineTree::should_inline() — 验证 callee name + decision → inline (hot)
  断言 6: PhaseIdealLoop::build_and_optimize() — 验证 loop tree 构建 → _ltree_root != NULL
  断言 7: ConnectionGraph::compute_escape() — 验证连接图节点数 → _nodes.length()
  断言 8: PhaseMacroExpand::expand() — 验证锁→CAS 替换 → fast_lock() Node
  断言 9: Matcher::match() — 验证 Ideal AddI→MachNode addI_reg_reg
  断言 10: PhaseChaitin::Register_Allocate() — 验证 vreg 数变化 → vreg < 50
  断言 11: PhaseOutput::install_code() — 验证 CodeCache::allocate 返回 != NULL
  断言 12: Method::set_code() — 验证入口点替换 → _from_compiled_entry 更新

§十 生产诊断 — 方法排除 workflow
  从 hs_err 的 native frames → 定位 C2 阶段 → 识别崩溃方法（Compile_id + method）
  → CompileCommand exclude → JVM 恢复运行
  ★ -XX:CompileCommand=exclude,com.example.Class::method
  ★ -XX:CompileCommand=quiet（排除后验证编译不再触发）
  ★ -XX:+PrintCompilation（监控编译队列）
```

## 六、写作要求

1. **★ 8 阶段 Mermaid 图是全文的核心交付物**——标注每个 Phase 名、入口文件、输入 Node 数 → 输出 Node 数。读者应能打印此图作为 C2 的"地铁图"参考。
2. **★ "你需要知道的" callout 框必须在 § 一出现**——覆盖 Sea of Nodes、Ideal Graph、GVN vs IGVN、ADL、HIR/LIR、Type Lattice。每个概念的 callout 不超过 200 字。
3. **★ 阶段连续性**：§ 一显式声明 "Reader 来自 [04-interpreter] §五 — 已知道 InvocationCounter → CompileBroker 触发链。本文继续旅程：CompileBroker → Compile::Compile() 之后的 8 个阶段。"
4. **★ 每个阶段必须有"优化前伪代码→优化后伪代码→周期数变化"**——用具体例子说明优化的价值。不能只说"IGVN 做了优化"——必须说"从 4 次 hashCode() 调用 → 1 次 → 省 60 cycles"。
5. **★ 全文核心：hash(String s) 的完整管道追踪（§八）**——这是面试中"C2 怎么把字节码编译成机器码？"的标准答案。必须包含每个阶段的具体 Node 数和最终的 x86 指令序列。
6. **★ 8 个 GDB 断点（§九）**——每个阶段 1 个断点。每个断点：函数名 + 行号 + 验证内容 + 预期输出。必须在 slowdebug build 中可执行。
7. **★ 生产诊断 workflow（§十）**——从 hs_err 到方法排除的完整 4 步流程：定位阶段 → 识别方法 → CompileCommand exclude → 验证恢复。
8. **★ 和 02（Inline）、03（RegAlloc）、04（CodeCache）的交叉引用**——在每个相关阶段结束时标注："Inline 决策详见 02-Inline-Decision §X"、"RegAlloc 详见 03-Chaitin-RegAlloc §X"。

## 七、输出格式

- Markdown 文件，命名为 `01-C2-Pipeline.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/05-jit-compiler/`
- 元信息头：
  ```
  > **阶段**：[05-jit-compiler]
  > **前置**：[04-interpreter] §五（InvocationCounter → CompileBroker 触发链）
  > **配套**：[02-Inline-Decision]（第 3 阶段：内联决策）、[03-Chaitin-RegAlloc]（第 6 阶段：寄存器分配）、[04-CodeCache-Sweeper]（编译结果存储）、[05-Deoptimization]（逃生口）
  > **后续依赖本文**：[02]（Parse + IGVN 后的 Inline 时机）、[03]（Ideal Graph → Matcher 后的 RegAlloc）、[06]（OopMap 在 Output 阶段生成）
  > **阅读收益**：理解 C2 怎么用 Sea of Nodes 表示程序——从字节码→Node→优化→x86 指令的完整管道；每个阶段的入口函数、关键数据结构、优化前后对比；8 阶段时间分布和加速比
  ```

## 禁止行为

- ❌ 把 C2 源码当"注释翻译"跑一遍——只聚焦 8 个阶段的**入口函数 + 关键数据结构 + 阶段间数据流**
- ❌ 只列 Node 子类名不解释"为什么这个子类存在于那个阶段"——每个阶段名字必须解释"它解决什么问题、为什么不是别的阶段做这件事情"
- ❌ 忽略 Sea of Nodes 和线性 IR 的对比——读者如果只有线性 IR 的背景知识，需理解为什么 C2 选择了完全不同的 IR
- ❌ 跳过 `PhaseMacroExpand`——lock→CAS 和 allocation→TLAB 是理解"synchronized 在 JIT 后多快"的关键
- ❌ 忽略 `SafePointNode`——每个基本块边界创建它，是 OopMap 和 deopt 的基础，是 JIT 和 GC/deopt 的桥梁
- ❌ 不做"优化前→优化后"的具体数据对比——必须用 Node 计数、x86 指令数、周期数来量化每个阶段的价值
- ❌ 忘记和 [04-interpreter] 的连接——读者已经知道 InvocationCounter 触发 CompileBroker；本文从 `CompileBroker::invoke_compiler_on_method()` 开始
- ❌ 不解释 IGVN 为什么要迭代——只说"迭代直到收敛"不解释"一次优化暴露另一次优化的机会"
- ❌ 不解释 EA 失败的常见模式——读者需要知道"什么代码模式会让 EA 失效"
- ❌ 不解释 ADL 文件是什么——这是 Java 工程师最陌生的概念之一

## 要求行为

- ✅ **★ 一张 Mermaid 8 阶段管道图**——标注 Phase 名、入口文件、Node 数变化（输入/输出）
- ✅ **★ "你需要知道的" 6 概念 callout 框**——Sea of Nodes、Ideal Graph、GVN vs IGVN、ADL、HIR/LIR、Type Lattice
- ✅ **★ 8 个阶段的表**——阶段名 + 入口函数 + 源文件 + 优化类型 + 时间占比
- ✅ **★ hash(String s) 的完整管道追踪**——每个阶段的 Node 数 BEFORE/AFTER + x86 输出
- ✅ **★ 8 个 GDB 断点**——每个阶段 1 个，精确到函数名 + 行号 + 预期输出
- ✅ **★ 生产诊断 workflow**——hs_err→C2 阶段定位→CompileCommand exclude→验证恢复
- ✅ **★ 交叉引用表**——每个阶段末尾标注关联文档（02/03/04/05/06 的具体 §号）
- ✅ **★ 面试 Story Format 答案**——§ 一末尾的叙事式回答模板：C2 8 阶段的故事线，读者可背诵
- ✅ **★ 和 [04-interpreter] 的显式连接**——阶段进入点和触发来源的精确对应
- ✅ **★ 每个阶段的"优化前伪代码→优化后伪代码→周期数变化"**——量化价值
