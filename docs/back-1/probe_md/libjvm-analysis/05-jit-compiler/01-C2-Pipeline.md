# 01-C2-Pipeline — C2 编译管道：100 条字节码如何经过 9 个阶段变成 10 条 x86 指令

> **阶段**：[05-jit-compiler]
> **前置**：[04-interpreter] §五（InvocationCounter → CompileBroker 触发链）
> **配套**：[02-Inline-Decision]（第 3 阶段：内联决策）、[03-Chaitin-RegAlloc]（第 8/9 阶段：寄存器分配）、[04-CodeCache-Sweeper]（编译结果存储）、[05-Deoptimization]（逃生口）
> **后续依赖本文**：[02]（Parse + IGVN 后的 Inline 时机）、[03]（Ideal Graph → Matcher 后的 RegAlloc）、[06-OopMap-GC-Roots]（OopMap 在 Output 阶段生成）
> **阅读收益**：理解 C2 怎么用 Sea of Nodes 表示程序——从字节码→Node→优化→x86 指令的完整管道；每个阶段的入口函数、关键数据结构、优化前后对比；9 阶段时间分布和 17-100× 加速比

---

## §〇 生产场景——凌晨 3 点 JVM 崩溃，hs_err 指向 C2 编译管道

### 真实 hs_err 片段——C2 编译中 SIGSEGV

线上应用突然宕机。你在 `/data/logs/` 下打开 hs_err：

```
#
# A fatal error has been detected by the Java Runtime Environment:
#
#  SIGSEGV (0xb) at pc=0x00007f8b1a3c4d21, pid=12463, tid=12494
#
# J 16193 C2 java.util.HashMap::hash(I)I (40 bytes)
#
# Native frames: (J=compiled Java code, j=interpreted, Vv=VM code)
# V  [libjvm.so+0x8c4d21]  PhaseIdealLoop::build_and_optimize+0x341
# V  [libjvm.so+0x8c2a15]  PhaseIdealLoop::do_one_loop+0xf5
# V  [libjvm.so+0x7f1230]  Compile::Optimize+0x250
# V  [libjvm.so+0x6d0980]  Compile::Compile+0xa10
# V  [libjvm.so+0x5b18a0]  C2Compiler::compile_method+0xf0
# V  [libjvm.so+0x4a3b50]  CompileBroker::invoke_compiler_on_method+0x2b0
```

### 怎么读懂这份 hs_err

```
J 16193 C2 java.util.HashMap::hash(I)I (40 bytes)
│  │     │  └─ 正在被编译的方法 + 字节码大小
│  │     └─ C2 编译器（不是 C1）
│  └─ compile_id = 16193
└─ J = Java 方法（和 V (VM) / C (Native) 区分）

V  [libjvm.so+0x8c4d21]  PhaseIdealLoop::build_and_optimize+0x341
│                         └─ ★ 崩溃在循环优化阶段
└─ V = VM native code（libjvm.so）
```

**三步分析**：
1. `HashMap::hash` 正在被 C2 编译——这是触发崩溃的方法，不是崩溃原因
2. 崩溃在 `PhaseIdealLoop::build_and_optimize`——C2 Loop Optimization 阶段
3. 调用栈：`CompileBroker → C2Compiler → Compile::Compile → Compile::Optimize → PhaseIdealLoop`——完整经过 C2 8 阶段的调度器

**10 分钟应急**：
```bash
# Step 1: 从 hs_err 定位崩溃方法
grep "^# J.*C2" hs_err_pid12463.log
# → java.util.HashMap::hash

# Step 2: 排除此方法，让 JVM 跳过 C2 编译（回退到 C1 或解释器）
-XX:CompileCommand=exclude,java.util.HashMap::hash

# Step 3: 重启 JVM，验证不触发
-XX:+PrintCompilation -XX:+UnlockDiagnosticVMOptions
# 输出中不再出现 "C2" 标签 + HashMap::hash
```

**为什么崩溃发生在 Loop 优化而不是 Matching 或 Output？** Loop 优化是唯一一个会**删除 Node + 重连边**的阶段——如果删除逻辑有 bug，一个被删掉的 Node 还在被其他 Node 引用 → 后续阶段（如 Matcher）遍历到野指针 → SIGSEGV。但 hs_err 显示崩溃在 `build_and_optimize` 自身——这意味着 bug 就在 loop 变换本身，不是"删错了导致后续崩溃"。

---

## §一 ★★★ C2 编译管道全景——这不是源码 walkthrough，这是架构故事

### 1.0 本文不做什么

本文不是 C2 源码导读。不讲每个 Node 子类的实现细节，不列 switch-case 的 200 个字节码处理分支。本文是 **C2 的 ARCHITECTURE STORY**：一个 C2 编译新手需要理解的核心问题是——**100 条字节码如何经过 9 个阶段的变换变成 10 条 x86 指令**。

### 1.1 读者前提——你从哪里来

你刚从 [04-interpreter] §五学完：`frequency_counter_overflow()` 更新 `InvocationCounter` → 计数器归零时触发 `CompileBroker::compile_method()` → `CompileTask` 进入 `CompileQueue` 等待 CompilerThread 消费。**本文回答：`CompileBroker::invoke_compiler_on_method()` 之后，`Compile::Compile()` 构造器启动的 9 个阶段各自做了什么。**

```
[04-interpreter] §五                          本文从这里开始
     │                                              │
     ▼                                              ▼
InvocationCounter ──→ CompileBroker ──→ Compile::Compile() ──→ ① Parse
     counter=0           compile_method()      构造器入口         字节码→Node
                                                                    │
                                                                     ▼
                                  ┌──── ② IGVN ←────────────── ③ Inline
                                  │ hash-consing + worklist     callee→caller
                                  │                                 │
                                  │     ┌──── ④ LoopOpt ←──────────┘
                                  │     │  peeling + unrolling + RCE
                                  │     │
                                  │      ──── ⑤ EscapeAnalysis
                                  │     │  ConnectionGraph + scalar replace
                                  │     │
                                  │      ──── ⑥ MacroExpand
                                  │     │  lock→CAS, allocation→TLAB
                                  │     │
                                  │     └──→ ⑦ Matcher ──→ ⑧ RegAlloc ──→ ⑨ Output
                                  │          ADL 模式       Chaitin 着色    CodeCache
                                  └──── 反复迭代直到 worklist 为空
```

### 1.2 你需要知道的——5 个概念 callout 框

> **以下 5 个概念是理解 C2 的前提。每个不超过 200 字，自包含——不依赖本文其他部分。**

#### 概念 1：Sea of Nodes（节点之海）

传统编译器的 IR（中间表示）是线性的——指令按顺序排列：`a = b + c; d = a * 2; return d`。C2 不同——它使用 **Sea of Nodes**：没有指令顺序，只有**依赖边**。每个 Node 代表一个操作（add / load / if），边代表数据流（"这个 Node 的输出是那个 Node 的输入"）或控制流（"IfNode 控制 RegionNode 的执行"）。数据 Node 可以**自由浮动**——直到被控制依赖钉住。因为 Node 没有顺序——C2 可以重新排列计算来减少 live ranges——但指令选择在 DAG 上是 NP-hard。

#### 概念 2：Ideal Graph

C2 的优化 IR——由 Node 对象组成的图。每个 Node 有：`_in[]`（输入边——数据 + 控制依赖）、`_out[]`（输出边——谁依赖我）、`Opcode()`（操作类型：`Op_AddI`、`Op_LoadI`、`Op_If`）、`bottom_type()`（类型格值：`TypeInt::INT`、`TypePtr::NULL_PTR`）。核心方法 `Node::Ideal(PhaseGVN*, bool)` 是每个 Node 的"优化自己"方法：`AddINode::Ideal()` 发现 `AddI(0, x)` → 返回 `x`；`AndINode::Ideal()` 发现 `AndI(x, -1)` → 返回 `x`。

#### 概念 3：GVN vs IGVN

**GVN**（Global Value Numbering）：哈希-consing——如果两个 Node 的操作码相同、输入相同 → 它们是等价的 → 合并为一个。`PhaseGVN::transform()` 查询哈希表 `_table`——键 = `(Opcode, in(1), in(2))`——如果命中 → 返回已存在的 Node。**IGVN**（Iterative GVN）：GVN + worklist。一次优化暴露新的优化机会——`AddI(0,x) → x` 后，使用旧 AddI 的 Node 变成使用 `x` → 可能触发新的恒等优化 → 反复迭代直到 worklist 为空（收敛）。

#### 概念 4：ADL（Architecture Description Language）

ADL 文件（`x86_64.ad`，~12000 行）描述 x86_64 的寄存器集、指令模式、栈帧约定。它不是 C++ 源码——是 C2 专有的 DSL。Matcher 阶段读取 ADL → 把 Ideal Graph 的通用 Node 匹配到 x86 特定指令：`AddINode` → `instruct addI_reg_reg()` → `addl dst, src`。每条 ADL `instruct` 定义了 match 模式（Ideal Node 子树形状）、format（反汇编输出）、ins_encode（汇编器调用）。

#### 概念 5：Node 类型格（Type Lattice）

`Node::bottom_type()` 返回 Type 格值——不是"一定是 int"，而是"可能是 int、可能是 long、可能是 top（未初始化）、可能是 bottom（不可达）"。类型格：`top → long → int → bottom`。IGVN 用类型格做优化：如果 `AddINode(x, 0)` 的 `Value()` 推断出 `TypeInt(>=0)` → 可以替换为 `x`（因为加 0 不改变值）。CCP（Conditional Constant Propagation）更激进——初始所有类型 = TOP（"我还不知道"），然后迭代收紧：`x = phi(5, 10)` → TOP→INT→最终 INT—但如果是 `x = phi(5, 5)` → TOP→INT(=5)→常量 5。

---

## §二 标准环境

- OpenJDK 11 slowdebug build（`#ifdef ASSERT` 全部生效）
- `bash configure --with-debug-level=slowdebug`
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86_64
- 编译观察：`-XX:+PrintCompilation -XX:+PrintInlining -XX:+UnlockDiagnosticVMOptions`
- 汇编输出：`-XX:CompileCommand=print,*.hash`

---

## §三 源文件生态——12 个文件驱动 9 个阶段

| # | 文件 | 完整路径 | 模块 | 核心函数 | 阶段角色 |
|---|------|---------|------|---------|---------|
| 1 | `compile.cpp` | `src/hotspot/share/opto/compile.cpp` | opto | `Compile::Compile()`(:646)、`Compile::Optimize()`(:2241)、`Compile::Code_Gen()`(:2497) | ★★★ 9 阶段总调度器 |
| 2 | `parse1.cpp` | `src/hotspot/share/opto/parse1.cpp` | opto | `Parse::Parse()`(:390)、`Parse::do_all_blocks()`、`create_entry_map()`(:1111) | ★★★ 阶段① Parse — 字节码 → Node |
| 3 | `parse2.cpp` | `src/hotspot/share/opto/parse2.cpp` | opto | `Parse::do_one_bytecode()`(:1907) | ★★ 阶段① Parse — 200 条字节码的 switch |
| 4 | `phaseX.cpp` | `src/hotspot/share/opto/phaseX.cpp` | opto | `PhaseGVN::transform()`(:844)、`PhaseGVN::transform_no_reclaim()`(:851)、`PhaseIterGVN::optimize()`(:1210) | ★★★ 阶段② IGVN — hash-consing |
| 5 | `doCall.cpp` / `bytecodeInfo.cpp` | `src/hotspot/share/opto/doCall.cpp` | opto | `InlineTree::should_inline()`(:115)、`InlineTree::try_to_inline()`(:341) | ★★ 阶段③ Inline — 决策 |
| 6 | `loopnode.cpp` | `src/hotspot/share/opto/loopnode.cpp` | opto | `PhaseIdealLoop::build_and_optimize()`(:2862) | ★★★ 阶段④ LoopOpt |
| 7 | `loopTransform.cpp` | `src/hotspot/share/opto/loopTransform.cpp` | opto | `PhaseIdealLoop::do_peeling()`(:588) | ★★ 阶段④ LoopOpt — peeling |
| 8 | `escape.cpp` | `src/hotspot/share/opto/escape.cpp` | opto | `ConnectionGraph::compute_escape()`(:120)、`ConnectionGraph::do_analysis()`(:99) | ★★★ 阶段⑤ Escape Analysis |
| 9 | `macro.cpp` | `src/hotspot/share/opto/macro.cpp` | opto | `PhaseMacroExpand::eliminate_macro_nodes()`(:2568)、`PhaseMacroExpand::expand_macro_nodes()`(:2644)、`scalar_replacement()`(:760) | ★★★ 阶段⑥ Macro Expand |
| 10 | `matcher.cpp` | `src/hotspot/share/opto/matcher.cpp` | opto | `Matcher::match()`(:177) | ★★★ 阶段⑦ Matching |
| 11 | `chaitin.cpp` | `src/hotspot/share/opto/chaitin.cpp` | opto | `PhaseChaitin::Register_Allocate()`(:336) | ★★ 阶段⑧ RegAlloc（详参 [03]） |
| 12 | `output.cpp` | `src/hotspot/share/opto/output.cpp` | opto | `Compile::Output()`(:57) | ★★★ 阶段⑨ Output + OopMap |
| 13 | `x86_64.ad` | `src/hotspot/cpu/x86/x86_64.ad` | cpu/x86 | ADL 指令模式 | ★★ 阶段⑦ Matching — Ideal→x86 映射 |
| 14 | `compileBroker.cpp` | `src/hotspot/share/compiler/compileBroker.cpp` | compiler | `CompileBroker::compile_method()`(:1244)、`CompileBroker::invoke_compiler_on_method()`(:2100) | ★★ 入口 — 触发→C2 |

**跨模块说明**：C2 编译管道横跨 `opto/`（主编译逻辑）、`compiler/`（共享编译基础设施）、`cpu/x86/`（平台专有 ADL + 汇编器）。Parse 阶段还依赖 `ci/` 层读取类元数据。

---

## §四 ★★★ "hash(String s)" 的完整管道追踪——100 条字节码 → 10 条 x86 指令

### 4.0 选择一个具体方法

```java
int hash(String s) {
    return s == null ? 0 : s.hashCode();
}
```

字节码（12 条）：

```
aload_0          // 0: 加载 s
ifnonnull 10     // 1: s != null → 跳转到 bci 10
iconst_0         // 4: null 分支: push 0
ireturn          // 5: 返回 0
aload_0          // 6: (非 null 路径) 加载 s —— 但 bci 10 才是真正的非 null 入口
invokevirtual #2 // 10: String.hashCode() → 调用将被内联
ireturn          // 13: 返回 hashCode() 的结果
```

> **注意**：实际字节码偏移中，bci 10 是非 null 分支的真正入口。ifnonnull 吃掉 3 字节 → bci 4 是 null 分支开始。此处简化为展示 12 条字节码的处理流程。

---

### ★ Phase 0：CompileBroker → C2 入口

`CompileBroker::compile_method()` (`compileBroker.cpp:1244`) 接收 `methodHandle`（`HashMap::hash` 或我们的 `hash(String s)`）→ 创建 `CompileTask` → 提交到 `CompileQueue` → CompilerThread 取出 → `CompileBroker::invoke_compiler_on_method()` (:2100) → 创建 `ciEnv` → 调用 `C2Compiler::compile_method()` → **`Compile::Compile()` 构造器** (:646) 启动。

构造器（`:646-947`）初始化所有数据结构、创建 `PhaseGVN`（parse-time GVN）、构建 `InlineTree` root → 然后调用 `cg->generate(jvms)` 启动 Parse。

---

### ★ Phase 1：Parse——字节码 → Node 图（建造者）

**入口**：`Parse::Parse()` (`parse1.cpp:390`) → `Parse::do_all_blocks()` → `Parse::do_one_block()` (:1464) → `Parse::do_one_bytecode()` (`parse2.cpp:1907`)——一个巨大的 `switch(bc())` 覆盖 ~200 条 JVM 字节码。

**`hash(String s)` 的 Parse 过程**：

```
aload_0 (bci 0: 加载 "s")
  → load_local(0) → map()->local(0) → ★ 不创建新 Node！
  → 直接返回 map 中已存在的 ParmNode——"参数 s"
  → iload_0 同样。ParmNode 在方法入口时由 create_entry_map() 构造

ifnonnull 10 (bci 1: null check)
  → Parse::do_if() → kit->gen_if() → 3 个 Node:
    CmpPNode(s, null)    ← 比较 s 和 null
    BoolNode(CmpP, EQ)   ← 布尔编码: EQ == 0? → 0 (equal) or 1 (not equal)
    IfNode(BoolNode, 10) ← 控制流分支: True→bci 10, False→bci 4
    └─ IfTrue ProjNode → 非 null 路径 (bci 10)
    └─ IfFalse ProjNode → null 路径 (bci 4)

iconst_0 (bci 4: null 分支)
  → push(ConINode(0)) → expression stack ← ConINode = constant integer
  → SafePointNode 记录此时 map 状态

ireturn (bci 5)
  → ReturnNode(ConINode(0)) ← 返回常量 0

aload_0 (bci 10: 非 null 路径)
  → 再次 load_local(0) → ParmNode(s) —— ★ 和 bci 0 是同一个 Node！
  → hash-consing: GraphKit 不创建新 Node——返回 map 中已存在的 ParmNode

invokevirtual #2 (bci 10: 调用 String.hashCode())
  → Parse::do_call() → CallGenerator::generate() → CallStaticJavaNode(hashCode)
  → InlineTree::should_inline() 判断是否内联（callee < MaxInlineSize）
  → 如果是 late inline candidate → 存入 _late_inlines 列表

ireturn (bci 13)
  → ReturnNode(CallStaticJavaNode 的返回值)
```

**Parse 阶段的关键设计**：
- **iload/aload 不创建 Node**——返回值已经在 `map()->local()` 中（由 `create_entry_map()` 预置的 ParmNode 或之前的 store）
- **if 需要 3 个 Node**（Cmp + Bool + If）而非 1 个——分离比较、布尔编码、控制流——使每个子操作独立被 IGVN 优化
- **SafePointNode**：每个基本块边界创建——记录此刻的 JVM 状态（局部变量、表达式栈、持有锁）→ GC 扫描 oop 根、deopt 重建解释器帧

**Parse 后**：~15 个 Node。1 个 StartNode + 1 个 ParmNode(s) + 控制流（If/Catch/Return/Region/Phi）+ CallStaticJavaNode。

**优化前→优化后**：字节码序列（12 条）→ Ideal Graph（~15 Nodes）。准备进入 IGVN。

---

### ★ Phase 2：IGVN——hash-consing + worklist 迭代（化简者）

**入口**：`Compile::Optimize()` (:2268) → `PhaseIterGVN igvn(initial_gvn()); igvn.optimize()` → `PhaseIterGVN::optimize()` (`phaseX.cpp:1210`) 从 `_worklist` 取 Node，调用 `transform_old()`。

**核心算法**：`PhaseGVN::transform_no_reclaim()` (`phaseX.cpp:851`)：

```cpp
// 1. 反复应用 Ideal() 直到不再变化
while(1) {
    Node *i = apply_ideal(k, false);  // 调用 k->Ideal(this, false)
    if(!i) break;
    k = i;
}

// 2. 计算 type = k->Value(this)
const Type *t = k->Value(this);

// 3. 如果 type 是 singleton → 转为常量
if(t->singleton() && !k->is_Con()) return makecon(t);

// 4. 应用 Identity: k->Identity(this) — 代数简化
Node *i = apply_identity(k);

// 5. ★ 哈希-consing
i = hash_find_insert(k);       // hash key = (Opcode, in(1), in(2))
if(i && (i != k)) return i;    // 命中 → 复用已存在的等价 Node
```

**`hash(String s)` 的 IGVN 示例**：

```
① bci 0 aload_0 → ParmNode(s)
   bci 1 aload_0 → ParmNode(s)    ← 同一个 Node（hash-consed during Parse）
   → 已经节省 1 个 load

② ConINode(0) at bci 4:
   hash_find_insert → 没有重复 → 保留

③ CmpPNode(ParmNode, null):
   hash_find → 没有等价 → 保留
   Ideal() → 无优化空间 → 保留

④ CallStaticJavaNode(hashCode):
   Ideal() → 无优化 → 标记为 late inline candidate（InlineTree 已注册）
```

**IGVN 为什么需要迭代**？

```
第 1 轮: AddI(0, x) → Ideal() 返回 x → 替换
第 2 轮: 使用旧 AddI 的 Phi Node 现在看到 x → Phi 的 Ideal() 统一了两个分支的相同值 → 消除 Phi
第 3 轮: 消除 Phi 后 CmpI(phi_result, limit) → 变成 CmpI(constant, limit) → CCP 可以将 constant 传播
...
第 N 轮: worklist 为空 → 收敛
```

**IGVN 后**：Node 数 ~15（不变，inline 尚未发生）。`CallStaticJavaNode(hashCode)` 仍在图中，等待 Inline 阶段处理。

---

### ★ Phase 3：Inline——打破方法边界（统一者）

**入口**：`Compile::Optimize()` (:2281) → `inline_incrementally(igvn)` + `inline_boxing_calls(igvn)`。

**决策逻辑**：`InlineTree::should_inline()` (`bytecodeInfo.cpp:115`) 检查：
1. `@ForceInline` 注解 → 强制内联
2. `-XX:CompileCommand=inline,...` → 覆盖
3. callee 字节码大小：hot 方法 `< FreqInlineSize` (~325 bytes)，cold 方法 `< MaxInlineSize` (~35 bytes)
4. 递归检测 + inline depth limit
5. Class Hierarchy Analysis 单态检查

**`hash(String s)` 的 Inline**：

`String.hashCode()` 被频繁调用（`InlineFrequencyRatio` 阈值超过）→ `should_inline()` 返回 true。

```
hashCode() 的字节码（简化的 49 bytes）：
  aload_0           // this (String)
  getfield #value   // this.value → char[]
  aload_0
  getfield #hash    // this.hash → int cache
  ifne L_hash_is_cached
  // compute hash loop: for (int i=0; i<value.length; i++) { h = 31*h + value[i]; }
  // ... ~40 条字节码

Inline 过程:
  Parse::do_call() → InlineTree::try_to_inline()
  → 为 hashCode() 调用 Parse::Parse() → 解析其字节码 → ~40 Nodes
  → inject into caller's graph

  RegionNode 合并两个分支（hash cached vs compute）
  PhiNode 合并两个路径的返回值
  LoopNode + PhiNode 表示 compute hash 的 for 循环
  LoadINode 读取 this.value 和 this.hash
```

**Inline 后**：Node 数 ~55（caller 15 + callee ~40，减去调用开销）。

> **Inline 决策详见 [02-Inline-Decision] §三**：`should_inline()` vs `should_not_inline()` 的完整判断链、CHA (Class Hierarchy Analysis) 如何影响单态内联、late inline 的排队机制。

---

### Phase 2 再访：IGVN——跨内联边界的冗余消除

Inline 引入 `hashCode()` 的 Nodes → IGVN 重新运行（`:2342`）：

```
① hashCode() 内部: getfield #value → LoadINode(String, offset=value)
   如果 caller 中也有 getfield #value → 同一个对象、同一个 offset
   → hash_find 命中 → 合并为 1 个 LoadINode
   → 3 次 getfield(value) → 1 次

② if (hash != 0) 分支:
   如果在当前上下文中 hash 始终 = 0 → CCP 传播常量 → 消除 if → 死代码删除
   → compute hash 总是被执行（没有 cache 命中路径）

③ LoopNode 识别:
   CountedLoopNode ← 循环是标准 for i=0; i<len; i++ 形态
   → PhiNode(i) + PhiNode(h) + CmpI(i, len) + If(loop_back)
```

**IGVN 再迭代后**：Node 数 ~35（Load 合并 ~10 个冗余 + 常量折叠 + 死代码消除）。

**优化前→优化后→周期数变化**：
- 3 次 `getfield(value)` → 1 次 `mov 0xc(%rsi), %eax`
- 省 2 次 L1 cache load：`~8 cycles`（L1 hit）
- hash cache 分支消除：省 `cmp + jne` 分支预测失败 `~20 cycles`（如果 cache miss）

---

### ★ Phase 4：Loop Optimization——peeling + unrolling + RCE（重组者）

**入口**：`PhaseIdealLoop::build_and_optimize()` (`loopnode.cpp:2862`)。

**核心子步骤**（`:2862-3100+`）：

```
build_loop_tree()      ← 构造 IdealLoopTree 嵌套结构
  └─ 识别每个循环的头、尾、body nodes
beautify_loops()       ← 循环规范化
Dominators()           ← 构造 dominator tree
counted_loop()         ← 识别 counted loops（for i=0; i<len; i+=stride）
build_loop_early()     ← 计算 Node 的最早可能位置
build_loop_late()      ← 计算 Node 的最晚合法位置（pin 到控制依赖）
```

**Peeling**：`PhaseIdealLoop::do_peeling()` (`loopTransform.cpp:588`)

```
剥 1 次迭代 = 把循环体复制一份到循环之前，删除克隆的 backedge

Before peeling:
  i=0 → [body: h=31*h+value[i]; i++] → if i<len? → loop back

After peeling:
  i=0 → [body: h=31*h+value[0]; i=1] → if i<len? → loop entry
  [body: h=31*h+value[i]; i++] → if i<len? → loop back
                ↑ loop-invariant 代码可以被 IGVN 优化出循环体
```

**为什么只剥 1 次？** 每次剥离增加代码大小（CodeCache 压力）→ 1 次是最佳 tradeoff。1 次足以使循环不变代码显式化（BEFORE loop，而非 INSIDE loop）。

**Range Check Elimination**：`PhaseIdealLoop::rc_predicate()` (`loopPredicate.cpp:698`)

```
循环体内: if (i >= 0 && i < array.length) → bounds check
循环条件: i ∈ [0, len)

如果 len ≤ array.length → i < array.length 恒成立 → 消去 bounds check

RCE 的前提: 可证明的不等式关系
  → 循环边界 (init, limit, stride) 和数组长度之间的 static analysis
```

**`hash(String s)` 的 LoopOpt**：

```
hashCode() 的计算循环:
  for (int i = 0; i < value.length; i++) { h = 31*h + value[i]; }

① Peeling: 剥 1 次迭代 → 循环外执行一次 31*h + value[0]
   → value.length check 提升到循环外 → loop-invariant code motion

② 循环体瘦身: 12 Nodes → 8 Nodes
   → bounds check (i < value.length) 与循环终止条件相同 → RCE 消除

③ Unrolling: 如果循环次数 > UnrollLimit → 不展开（小循环展开收益不大）
```

**LoopOpt 后**：Node 数 ~30（消除 ~5 个 bounds check + invariant code 提升 + 循环体瘦身）。

**优化前→优化后→周期数变化**：bounds check 每迭代 1 次 → 0 次，`for i in [0,100)` 省 100 次 `cmp + jae` = ~200 cycles（2 cycles × 100）+ 分支预测收益 ~50 cycles。

> **Loop 优化的更多模式详见 [02-Inline-Decision] §四**：counted loop 的精确识别条件、pre/main/post loop 的 3-loop 结构、strip mining（层次展开）。

---

### ★ Phase 5：Escape Analysis——对象分配→标量替换（对象消除者）

**入口**：`ConnectionGraph::do_analysis(this, &igvn)` (`escape.cpp:99`) → `ConnectionGraph::compute_escape()` (`:120`)。

**三步算法**：

```
Step 1: Populate Connection Graph (:138-199)
  → 遍历所有 ideal_nodes → add_node_to_connection_graph(n, &delayed)
  → 分类: JavaObject (分配点) / LocalVar (局部变量) / Field (字段)
  → 收集 worklists: pt_nodes (points-to 分析) / field_worklist

Step 2: Complete Connection Graph (:235-240)
  → complete_connection_graph(ptnodes_worklist, ...)
  → 传播引用: 如果 JavaObject p 被传给方法 foo(p) 且 foo 没有内联
    → p 到达"逃逸点"→ 标记为 GlobalEscape

Step 3: Adjust scalar_replaceable (:242-262)
  → 遍历 AllocateNodes：如果 _is_non_escaping → scalar_replaceable
  → 是什么让对象"不逃逸"？
    ✅ 对象只在创建它的方法内使用
    ✅ 对象没有被传给非内联的调用（内联后可以"看穿"）
    ✅ 对象没有被存储到 static field
    ✅ 对象没有作为方法返回值
    ❌ 对象被 this.field = new Foo() 存储 → 逃逸到字段（全局可见）
    ❌ 对象作为参数传给未内联的调用 → 逃逸到 call 边界外
```

**`hash(String s)` 的 EA**：

```
String.hashCode() 内部有 int[] cache 吗？→ 不，String.hash 是一个 int 字段（不是对象）
没有新分配 → EA 不触发任何 scalar replacement
→ ConnectionGraph::has_candidates() 可能返回 false → EA 被跳过
```

**如果方法有 `new Point(x, y)` 会怎样**：

```
new Point(x, y) → AllocateNode(Point) + fields[x, y]

EA 判定 Point 不逃逸 → scalar_replaceable = true

PhaseMacroExpand::scalar_replacement() (macro.cpp:760):
  → 删除 AllocateNode
  → Point.x → LoadINode(offset=12) → 变成局部变量 x_val
  → Point.y → LoadINode(offset=16) → 变成局部变量 y_val
  → 零堆分配、零 GC 压力

优化前: new Point() → 堆分配 + GC 扫描 + GC 回收
优化后: 两次栈写入 → 零 GC
→ 省 ~100 cycles (分配) + ~200 cycles (GC 回收) = 300 cycles/对象
```

**EA 失败的三种常见模式**：
1. `this.field = new Foo()` → Foo 逃逸到对象的字段 → global escape
2. `return new Foo()` → Foo 返回给调用者 → arg escape
3. `collection.add(new Foo())` → `add()` 如果没有被内联 → Foo 逃逸到 call 外部 → global escape

如果 `add()` 被内联 → EA 可以"看穿"内联后的代码 → 发现 Foo 仍然没有逃逸到 `add()` 之外 → 仍然可以 scalar replace。

---

### ★ Phase 6：Macro Expansion——Lock + Allocation 的展开（展开者）

**入口**：`PhaseMacroExpand::eliminate_macro_nodes()` (`macro.cpp:2568`) + `PhaseMacroExpand::expand_macro_nodes()` (`:2644`)。

**两阶段处理**：

**阶段 A：Eliminate（消除）** (`:2568`)

```
eliminate_locking_node()    ← 非逃逸锁 → 删除（对象不逃逸 → 不需要锁）
eliminate_allocate_node()   ← 标量替换分配 → 删除 AllocateNode
eliminate_boxing_node()     ← autoboxing 消除 → Integer.valueOf() → 局部 int
```

**阶段 B：Expand（展开）** (`:2644`)

```
expand_lock_node()          ← 逃逸锁 → FastLockNode → CAS + slow path
expand_allocate_node()      ← 逃逸分配 → Allocate → TLAB bump pointer
expand_arraycopy_node()     ← System.arraycopy → Macro 实现
```

**Lock 展开的代码变换**：

```
Before MacroExpand:
  LockNode(obj)  ← 语义: synchronized(obj) 的进入

After MacroExpand:
  FastLockNode(box, obj)
    → mark = obj->mark();  if (mark == unlocked) obj->cas(mark, locked_mark);
    → if CAS 成功 → 快速路径: 继续执行 synchronized block
    → if CAS 失败 → slow path: 调用 OptoRuntime::complete_monitor_locking_C()
    → 展开为 ~10-20 x86 指令（CAS + cmp + jne）

FastUnlockNode → 类似的 CAS 释放
```

**Allocation 展开**：

```
Before MacroExpand:
  AllocateNode(klass=Point, size=24 bytes)

After MacroExpand (TLAB fast path):
  new_top = tlab_top + 24;
  if (new_top <= tlab_end)     ← bump pointer check
    tlab_top = new_top;         ← CAS 或 store（TLAB 是线程本地的）
    // 填零 (24 bytes)
    // 设置 mark word + klass pointer
  else
    // slow path: eden allocation or GC
```

**`hash(String s)` 的 Macro**：

没有分配、没有锁 → `eliminate_macro_nodes()` 无操作（`macro_count() == 0`）。

`expand_macro_nodes()` 展开 `Op_Opaque1` / `Op_Opaque2`（loop predicates 的标记 Node）→ 转换为 `If` 逻辑。

**优化前→优化后→周期数变化**（以 synchronized 方法为例）：
- `synchronized(this) { ... }` → FastLockNode + FastUnlockNode → CAS ×2
- 解释器 lock：~200 cycles（monitorenter 需要 heavy lock 查找）
- C2 展开后：~40 cycles（L1 CAS ×2）= 5× 加速

---

### ★ Phase 7：Matching——Ideal Node → x86 指令（翻译者）

**入口**：`Compile::Code_Gen()` (:2516) → `Matcher::match()` (`matcher.cpp:177`)。

**Matching 过程**：

```
Matcher::match() (:177):
  1. init_spill_mask(root->in(1))          ← 初始化寄存器掩码
  2. 设置 calling convention registers     ← 哪些寄存器传参数
  3. 设置 frame layout                    ← _old_SP, _in_arg_limit
  4. ★ 遍历 Ideal Graph → 每个 Node 调用 match_rule_supported(opcode)
     → 在 x86_64.ad 中查找第一个匹配的 instruct 模式
     → 创建对应的 MachNode → 分配虚拟寄存器
```

**ADL 模式匹配示例**（`x86_64.ad`）：

```
// x86_64.ad 中的 instruct 定义:
instruct addI_reg_reg(rRegI dst, rRegI src1, rRegI src2)
%{
  match(Set dst (AddI src1 src2));   ← 匹配 AddI Node
  format %{ "addl    $dst, $src2" %}  ← 反汇编输出
  ins_encode %{ __ addl($dst$$Register, $src2$$Register); %}  ← 汇编器调用
%}

// Matcher 做的事:
AddINode(LoadI, ConstI(5))  ← Ideal Graph 中的 Node
  ↕ 匹配到
instruct addI_reg_imm(rRegI dst, rRegI src, immI con)
  match(Set dst (AddI src con));  ← AddI + 常量的模式
  ins_encode %{ __ addl($dst$$Register, $con$$constant); %}
  → addl %eax, $5       ← x86 汇编
```

**`hash(String s)` 的 Matching**：

```
Ideal Node                     ADL Pattern            x86 指令
─────────────────────────     ────────────────       ────────────────
ParmNode(s)                    ─                      mov %rsi, %rdi  (参数→寄存器)
LoadINode(ParmNode, offset)   loadI                  mov 0xc(%rdi), %eax
AddINode(LoadI, ConstI(31))   addI_reg_imm           addl $31, %eax
MulINode(Phi, ConstI(31))     mulI_reg_imm           imull $31, %eax
CmpINode(i, len)              cmpI_reg_reg           cmpl %ebx, %ecx
BoolNode(CmpI, LT)            ─                      setl %al  (编码比较结果)
IfNode(BoolNode)              ─                      jl <loop_head>  /  jge <loop_exit>
ReturnNode(h_result)          ─                      mov %eax, %edx; ret
```

**Matching 的本质**：图匹配在 DAG 上是 NP-hard → HotSpot 用 ADL 模式 + 手动指令选择——**不做自动图同构匹配**。每个 `instruct` 手工定义了匹配的 Ideal Node 子树形状（`match()` 规则）。这是 Sea of Nodes 的代价——如果有指令顺序，用 `lcc` (linear code generation) 可以在 O(n) 时间内完成指令选择。

**Matching 后**：~30 个 Ideal Node → ~15 个 MachNode。Node 数减少是因为多个 Ideal Node 可以合并为 1 条 x86 指令（如 `LoadINode + AddINode` → `addl mem, reg` —— x86 的 CISC 特性允许内存-寄存器操作）。

---

### ★ Phase 8：Register Allocation——Chaitin 图着色（分配者）

**入口**：`PhaseChaitin::Register_Allocate()` (`chaitin.cpp:336`)。

**6 步着色流程**（`:336-430+`）：

```
1. PhaseLive live(...)               ← 计算 live ranges: 每个 vreg 从哪到哪活着
2. PhaseIFG ifg(...)                 ← 构建 Interference Graph: vreg A 和 B 冲突?
3. de_ssa()                          ← 退出 SSA 形式: Phi Node 的输入/输出分配同一 vreg
4. build_ifg_virtual()              ← 基于 live ranges 建立冲突边
5. PhaseAggressiveCoalesce::coalesce_driver()  ← 合并不冲突的 vreg 复制对
6. ★ Chaitin coloring               ← 图着色: K=16 GPR → 贪心分配 → spill if needed
```

**`hash(String s)` 的寄存器分配**：

```
虚拟寄存器: ~40 (来自 ~30 Ideal Nodes × 1.3 MachNode 膨胀系数)
物理 GPR:   16 (rax, rcx, rdx, rbx, rsp, rbp, rsi, rdi, r8-r15)

需要 ~8 个活跃寄存器（此方法小） → 无需 spill → 全部映射到物理寄存器

典型分配:
  vreg[0] → rax  (hash value, loop result)
  vreg[1] → rcx  (i, loop counter)
  vreg[2] → rbx  (this, String reference)
  vreg[3] → rsi  (value[] array base)
  vreg[4] → r8   (value.length, loop limit)
  vreg[5] → r9   (temporary for char load)
  vreg[6] → r10  (constant 31)
  vreg[7] → r11  (temporary for multiply)
```

**如果 spill 了怎么办**：

```
假设活跃寄存器数 > 16 → 选择 spill cost 最低的 vreg → 插入 spill code:
  store (spill): mov %vreg, [rsp + spill_slot_24]   ← 4 bytes
  load  (reload): mov [rsp + spill_slot_24], %vreg   ← 4 bytes
  → 每次 spill+reload 增加 ~4 cycles (L1) 到 200+ cycles (L3/memory)
```

> **Chaitin 着色详见 [03-Chaitin-RegAlloc] §二**：干涉图的构建、coalesce 的 Briggs/George 策略、spill code 的代价模型、和 Linear Scan（C1）的性能对比。

---

### ★ Phase 9：Output——CodeBuffer + OopMap + nmethod（序列化者）

**入口**：`Compile::Output()` (`output.cpp:57`)。

**4 步代码生成**：

```
1. Replace StartNode → MachPrologNode        ← 函数序言: push rbp; mov rbp, rsp
   Insert MachEpilogNode before Returns       ← 函数尾声: pop rbp; ret

2. ScheduleAndBundle() (:128)                ← 全局指令调度 → 基本块排序
   → 按 CFG 后序遍历 + 依赖关系排序

3. BuildOopMaps() (:150)                     ← ★ 遍历每个 safepoint →
   每个 SafePointNode → OopMap::set_oop(reg/vreg) → 编码为位掩码
   → ~10 bytes/safepoint → OopMapSet::add_gc_map(pc_offset)

4. fill_buffer(cb, blk_starts) (:156)        ← 填充机器码字节到 CodeBuffer
   → 每个 MachNode → MachNode::emit() → Assembler::emit_*()
   → 生成 relocation info (oop reloc, call reloc, etc)
```

**最终 nmethod 构造**：`Compile::Code_Gen()` 返回后 → `compile.cpp:947` 调用 `env()->register_method()` → **`CodeCache::allocate()`** 分配 CodeBlob 内存 → **`nmethod::nmethod()`** 构造函数填充 metadata：
- OopMapSet（GC 根扫描）
- ExceptionCache（异常处理表）
- deoptimization info（去优化时重建解释器帧）
- scopes data（调试信息）
- `Method::set_code(nmethod)` → **原子替换方法入口点** `_from_compiled_entry` → 下一次 `hash(String s)` 调用 → 直接跳转到 C2 生成的 x86 代码。

**`hash(String s)` 的最终输出**：~10 条 x86 指令，~200 bytes CodeCache。

```asm
# C2 compiled hash(String s) — 完整汇编输出
# prologue
  push   rbp
  mov    rbp, rsp

# null check: s == null ?
  test   %rsi, %rsi               # rsi = s (第二个参数, this 是 rdi)
  je     return_zero

# s.hashCode() — inlined
  mov    0xc(%rsi), %eax          # load String.value → char[] array
  mov    0x10(%rsi), %r8d         # load String.hash → int cache

  test   %r8d, %r8d               # hash != 0? (cache check)
  jne    return_hash

# compute hash loop
  mov    0xc(%rax), %ecx          # value.length → loop limit
  xor    %edx, %edx               # i = 0
loop_start:
  movzwl 0x10(%rax,%rdx,2), %r9d  # value[i] → zero-extend char → int
  imul   $31, %r8d, %r8d          # h = 31 * h
  add    %r9d, %r8d               # h += value[i]
  inc    %edx                     # i++
  cmp    %ecx, %edx               # i < len?
  jl     loop_start

return_hash:
  mov    %r8d, %eax               # return h
  pop    rbp
  ret

return_zero:
  xor    %eax, %eax               # return 0
  pop    rbp
  ret
```

**加速比计算**：

| 执行模式 | 指令数 | 每指令 cycles | 总 cycles | vs 解释器 |
|---------|--------|-------------|----------|----------|
| 解释器 (12 bytecodes) | ~12 bytecodes | ~40/bc | ~500 | 1× |
| 解释器 (含 hashCode 非内联) | ~80 bytecodes | ~40/bc | ~3000 | 0.16× |
| C2 编译后 (内联 hashCode) | ~10 x86 | ~3/instr | ~30 | **~17×** |
| C2 编译 (如 hashCode 未内联) | ~50 x86 | ~3/instr | ~150 | ~20× vs 解释器 hashCode |

**如果 hashCode 没被内联**：C2 的加速比更高——从 ~3000 cycles → ~150 cycles = **~20×**。但相对的，内联带来的额外 5× 来自跨方法边界的优化（Load 合并、常量传播、循环识别）。

---

## §五 "为什么这个顺序"——9 阶段的设计理由

| 当前阶段 | 为什么在此位置 | 如果放错位置会怎样 |
|---------|-------------|-----------------|
| **Parse 最先** | 必须先有 Node 才能优化它们 | IGVN 在 Parse 之前 = 空图上迭代 = 无意义 |
| **IGVN 在 Inline 前** | 缩小图后再 inline → 更快的内联决策（Node 数少→inline tree 处理更快） | Inline 在 IGVN 前 → 在大量冗余 Node 上做 inline 决策 → 更慢、更不准 |
| **Inline 在 LoopOpt 前** | 内联后的循环暴露给 LoopOpt —— 原来跨方法边界的循环变成 caller 内的循环 | LoopOpt 在 Inline 前 → 看不到 callee 中的循环 → 错失优化 |
| **Inline 在 EA 前** | 内联让 EA "看穿"方法边界 —— 被传给 `add(new Foo())` 的 Foo 在 add 内联后可被消除 | EA 在 Inline 前 → `add()` 的 call 边界是逃逸点 → EA 失败 |
| **EA 在 Macro 前** | EA 可能决定某些分配不逃逸 → 消除 → Macro 不用处理 | Macro 在 EA 前 → 对非逃逸分配仍然做 TLAB bump pointer → 浪费 CodeCache |
| **LoopOpt 在 EA 后** | RCE 和 peeling 需要 CCP 常量化后的精确类型信息 | 实际代码中 LoopOpt 在 EA 后运行（第二次 pass） |
| **Macro 在 Matching 前** | Lock/Allocation 需要图级展开（替换为 FastLockNode + CAS），不是指令级匹配 | Matching 在 Macro 前 → LockNode 无对应 ADL instruct → 匹配失败 |
| **Matching 在 RegAlloc 前** | 必须知道需要哪些 x86 指令及其操作数，才能分配物理寄存器 | RegAlloc 在 Matching 前 → vreg 不知道对应哪个 MachNode → 无法着色 |
| **RegAlloc 在 Output 前** | 着色后才能决定寄存器分配 → Output 编码指令时填入正确的寄存器编号 | Output 在 RegAlloc 前 → 不知道哪个 vreg 对应哪个物理寄存器 → 无法生成正确的机器码 |

**实际源码中的顺序**（与简化模型的差异）：

```
简化模型（本文教学用）:
  Parse → IGVN → Inline → IGVN → LoopOpt → EA → Macro → Match → RegAlloc → Output

实际 Compile::Optimize() 源码 (:2241-2492):
  Parse → IGVN → inline_incrementally → EA → MacroEliminate → IGVN
        → LoopOpt(pass1) → LoopOpt(pass2) → LoopOpt(pass3) → CCP → IGVN
        → LoopOpt(pass4) → MacroExpand → final_reshape
  Compile::Code_Gen() (:2497):
        → Match → Scheduler → RegAlloc → BlockOrdering → Peephole → Output
```

教学简化保留了每个阶段的**核心语义**，省略了迭代重排和次要 pass（CCP、Peephole、Scheduler）。理解简化模型后，再进入源码不会迷失。

---

## §六 ★ Mermaid 9 阶段管道图

```mermaid
graph TB
    BC[100 条字节码<br/>hash(String s)] --> P1

    subgraph Parse["① Parse — 建造者<br/>parse1.cpp:390 / parse2.cpp:1907"]
        P1["Parse::do_one_bytecode()"]
    end

    P1 -->|~15 Nodes| P2

    subgraph IGVN1["② IGVN — 化简者<br/>phaseX.cpp:844"]
        P2["PhaseGVN::transform()<br/>hash-consing + Ideal()"]
    end

    P2 -->|~15 Nodes| P3

    subgraph Inline["③ Inline — 统一者<br/>bytecodeInfo.cpp:115"]
        P3["InlineTree::should_inline()<br/>→ Parse hashCode() → merge"]
    end

    P3 -->|~55 Nodes| P4

    subgraph IGVN2["② IGVN (第二次)<br/>跨内联边界冗余消除"]
        P4["PhaseIterGVN::optimize()<br/>Load 合并 + 常量折叠"]
    end

    P4 -->|~35 Nodes| P5

    subgraph LoopOpt["④ Loop Optimization — 重组者<br/>loopnode.cpp:2862"]
        P5["PhaseIdealLoop::build_and_optimize()<br/>peeling + unrolling + RCE"]
    end

    P5 -->|~30 Nodes| P6

    subgraph EA["⑤ Escape Analysis — 对象消除者<br/>escape.cpp:99"]
        P6["ConnectionGraph::compute_escape()<br/>scalar replace / lock elision"]
    end

    P6 -->|~30 Nodes| P7

    subgraph Macro["⑥ Macro Expansion — 展开者<br/>macro.cpp:2568"]
        P7["PhaseMacroExpand::expand_macro_nodes()<br/>lock→CAS, alloc→TLAB"]
    end

    P7 -->|~30 Nodes| P8

    subgraph Match["⑦ Matching — 翻译者<br/>matcher.cpp:177"]
        P8["Matcher::match()<br/>Ideal Node 子树 → x86_64.ad instruct"]
    end

    P8 -->|~15 MachNodes| P9

    subgraph RegAlloc["⑧ Register Allocation — 分配者<br/>chaitin.cpp:336"]
        P9["PhaseChaitin::Register_Allocate()<br/>Chaitin 着色: vreg→phys reg"]
    end

    P9 -->|15 MachNodes, regs assigned| P10

    subgraph Output["⑨ Output — 序列化者<br/>output.cpp:57"]
        P10["Compile::Output()<br/>CodeBuffer + OopMap + nmethod"]
    end

    P10 -->|10 条 x86, ~200 bytes| END[CodeCache<br/>nmethod ready]
```

**Node 数变化轨迹**：20 → 15 → 55 → 35 → 30 → 30 → 30 → 15 MachNodes → 10 x86 指令

**时间分布**（典型 100-300 bytecodes 方法）：

| 阶段 | 耗时 (ms) | 占比 | 瓶颈 |
|------|----------|------|------|
| ① Parse | 3-5 | ~5% | 字节码逐条 switch |
| ② IGVN (×2) | 10-20 | ~15% | hash_find 查找 + Ideal() 递归 |
| ③ Inline | 5-15 | ~10% | callee 的 Parse 递归 |
| ④ LoopOpt | 15-40 | ~30% | peeling clone + dominator 计算 |
| ⑤ EA | 5-15 | ~10% | ConnectionGraph 传播 |
| ⑥ Macro | 3-5 | ~5% | lock/alloc 展开 |
| ⑦ Matching | 10-20 | ~15% | ADL 模式匹配 + label 重写 |
| ⑧ RegAlloc | 10-20 | ~10% | IFG 构建 + 图着色 |
| ⑨ Output | 5-10 | ~5% | CodeBuffer 填充 + OopMap |
| **总计** | **80-150** | **100%** | LoopOpt 是最大单一消耗者 |

---

## §七 GDB 验证——9 个阶段，每个阶段 1 个断点

### 断言 1：C2 入口 —— `Compile::Compile()` 构造器

```gdb
(gdb) br compile.cpp:646
(gdb) p target->holder()->name()->as_utf8()
# 预期: "java/lang/String"
(gdb) p target->name()->as_utf8()
# 预期: "hash"
(gdb) p ci_env->compile_id()
# 预期: compile_id > 0 (如 16193)
(gdb) p do_escape_analysis
# 预期: true (默认开启)
```

### 断言 2：Parse —— `Parse::do_one_bytecode()` 入口

```gdb
(gdb) br parse2.cpp:1911  # 在 switch(bc()) 处
(gdb) p bc()
# 预期: 当前字节码 (如 Bytecodes::_aload_0 = 42)
(gdb) p method()->name()->as_utf8()
# 预期: "hash"
(gdb) p _bci
# 预期: 当前字节码偏移 (0, 1, 4, 5, 10, 13...)
(gdb) p C->unique()
# 预期: Node 数随 Parse 进展递增
```

### 断言 3：IGVN —— `PhaseGVN::transform_no_reclaim()` 的 GVN

```gdb
(gdb) br phaseX.cpp:902  # line: i = hash_find_insert(k)
(gdb) p k->Name()
# 预期: 正在被 GVN 的 Node 名 (如 "AddI", "LoadI")
(gdb) p i
# 预期: NULL (新 Node) 或 != k (命中已有等价的 Node)
# 如果是 != NULL && != k → GVN 找到了等价 Node → 复用
(gdb) n
(gdb) p i
# 预期: return 的 Node 指针 (可能是已存在的等价 Node)
```

### 断言 4：Node::Ideal —— AddI 的代数优化

```gdb
(gdb) br addnode.cpp:30  # AddINode::Ideal() 内部
(gdb) p in(1)->is_Con()
# 预期: 检查第一个输入是否是常量
(gdb) p in(1)->get_int()
# 如果是 ConINode(0) → Ideal 返回 in(2) (AddI(0,x)→x)
(gdb) finish
(gdb) p $
# 预期: 返回值 != this → 优化发生
```

### 断言 5：Inline —— `should_inline()` 决策

```gdb
(gdb) br bytecodeInfo.cpp:126  # directive->should_inline() 检查
(gdb) p callee_method->name()->as_utf8()
# 预期: "hashCode" 或其他被 inline 的方法名
(gdb) p callee_method->code_size()
# 预期: hashCode 的字节码大小 (~49 bytes)
(gdb) finish
(gdb) p $  # should_inline 的返回值
# 预期: NULL (不内联) 或 WarmCallInfo* (内联决策对象)
```

### 断言 6：LoopOpt —— `build_and_optimize()` loop tree

```gdb
(gdb) br loopnode.cpp:2913  # build_loop_tree() 之后
(gdb) p _ltree_root
# 预期: != NULL (循环树根节点)
(gdb) p _ltree_root->_child
# 预期: 如果有循环 → != NULL (第一个嵌套循环)
(gdb) p C->has_loops()
# 预期: true/false (取决于方法是否包含循环)
```

### 断言 7：EA —— `ConnectionGraph::compute_escape()`

```gdb
(gdb) br escape.cpp:235  # complete_connection_graph 之后
(gdb) p _vertices.length()
# 预期: ConnectionGraph 的顶点数 (如 50-200)
(gdb) p _collecting
# 预期: true (正在收集引用信息)
(gdb) p C->congraph()
# 预期: != NULL (EA 成功后 congraph 被设置)
```

### 断言 8：Macro —— `PhaseMacroExpand::expand_macro_nodes()` 前

```gdb
(gdb) br macro.cpp:2646  # eliminate_macro_nodes() 调用
(gdb) p C->macro_count()
# 预期: 0 (无分配) 或 >0 (有分配/lock)
(gdb) p igvn._worklist.size()
# 预期: 当前 IGVN worklist 大小
```

### 断言 9：Matcher —— `Matcher::match()` Node 选择

```gdb
(gdb) br matcher.cpp:177  # match() 入口
(gdb) p C->root()
# 预期: RootNode 指针
(gdb) p C->unique()
# 预期: 当前 Ideal Graph 中的 Node 总数
# 在 match 完成后 (设置条件断点或逐步):
(gdb) p _new2old_map
# 预期: MachNode → 原始 Ideal Node 的映射表
```

### 断言 10：RegAlloc —— `Register_Allocate()` 着色前

```gdb
(gdb) br chaitin.cpp:373  # de_ssa() 调用
(gdb) p _lrg_map.max_lrg_id()
# 预期: 虚拟寄存器总数 (~40-100)
# 着色完成后:
(gdb) p _lrg_map.max_lrg_id()
# 预期: 值不变 (vreg→phys reg 映射存储在 lrg->reg())
```

### 断言 11：Output —— `CodeCache::allocate()` 返回

```gdb
(gdb) br output.cpp:156  # fill_buffer 之后
(gdb) p cb->insts_size()
# 预期: 机器码大小 (~150-400 bytes)
(gdb) p cb->stubs_size()
# 预期: stub 大小（~20-40 bytes，如异常处理 stub）
(gdb) p cb->oopmap_size()
# 预期: OopMap 段大小 (~20-80 bytes)
```

### 断言 12：nmethod —— 入口点替换

```gdb
(gdb) br compile.cpp:947  # env->register_method() 之后
(gdb) p method->code()
# 预期: != NULL — nmethod 已安装
(gdb) p ((nmethod*)method->code())->entry_point()
# 预期: 非零地址 — 编译代码的入口点
(gdb) p ((nmethod*)method->code())->insts_size()
# 预期: ~150-400 bytes
```

---

## §八 生产诊断——从 hs_err 到方法排除的完整 4 步流程

### Step 1：定位 C2 崩溃阶段

```bash
# hs_err 中找 native frames 中 opto/ 的函数
grep "^V.*opto" hs_err_pid12463.log

# 常见输出和对应阶段:
# PhaseIdealLoop::build_and_optimize  → LoopOpt (阶段 ④)
# ConnectionGraph::compute_escape     → EA (阶段 ⑤)
# PhaseMacroExpand::expand_macro_nodes → Macro (阶段 ⑥)
# Matcher::match                       → Matching (阶段 ⑦)
# PhaseChaitin::Register_Allocate      → RegAlloc (阶段 ⑧)
# Compile::Output                      → Output (阶段 ⑨)
```

### Step 2：识别触发崩溃的方法

```bash
# 在 hs_err 中找 "J ... C2" 标签
grep "^# J.*C2" hs_err_pid12463.log

# 输出示例:
# J 16193 C2 java.util.HashMap::hash(I)I (40 bytes)
#         └─ ★ 这是触发崩溃的方法 —— 不是崩溃原因
#            (崩溃在 C2 optimizer 处理此方法时)
```

### Step 3：排除方法——让 JVM 跳过 C2 编译

```bash
# 方法 1: 命令行参数（需要重启 JVM）
-XX:CompileCommand=exclude,java.util.HashMap::hash

# 方法 2: 动态排除（通过 jcmd，不需要重启）
jcmd <PID> Compiler.directives_add /tmp/exclude.json
# exclude.json:
# [
#   { match: "java/util/HashMap.hash",  // 精确匹配方法
#     c2: { Exclude: true }             // 不触发 C2
#   }
# ]

# 方法 3: 全局降级——全部方法不触发 C2（紧急止损）
-XX:TieredStopAtLevel=3    # 只到 C1, 不触发 C2 (Level 4)
-XX:TieredStopAtLevel=0    # 只解释执行, 不触发任何 JIT
```

### Step 4：验证恢复

```bash
# 重启后监控编译日志
-XX:+PrintCompilation -XX:+UnlockDiagnosticVMOptions

# 正常输出:
# 1234  161  b  3  java.util.HashMap::hash (40 bytes)   ← C1 (Level 3)
# 没有 "C2" 标签的 HashMap::hash 条目 → 排除成功

# 或者全局降级:
# 没有 "  4  " (Level 4 = C2) 的任何条目 → 全局排除成功
```

### 为什么排除能应急——C2 的失败模式

C2 编译失败不会让 JVM 崩溃（正常情况）——方法留在 Level 3 (C1) 或解释器。**但如果 C2 的 optimizer 访问了非法内存（SIGSEGV）或触发了 guarantee() 失败（SIGABRT）**，JVM 无法恢复——必须排除方法或降级。排除后该方法仍可通过 C1 编译执行（无优化 tradeoff = 被上层流量兜底）。

> **CodeCache 管理和去优化详见 [04-CodeCache-Sweeper] §二 和 [05-Deoptimization] §三**

---

## §九 ★ 面试 Story Format——"Walk me through C2's pipeline" (90 秒版)

C2 不是"一个把字节码翻译成机器码的编译器"。C2 是一个图优化器。它的中间表示叫 Ideal Graph——一个没有执行顺序的"节点之海"。数据 Node 浮动在图中，只被控制依赖钉住。

整个管道有 9 个阶段。第一个是 Parse——把 100 条字节码翻译成 ~20 个 Node：`iload_0` 不创建 Node——直接返回方法入口时预置的 ParmNode；`if_icmpne` 创建 3 个 Node——Cmp、Bool、If——分离比较、布尔编码和控制流，让后面的优化能独立处理每一个。

然后是 IGVN——这是 C2 的心脏。它用哈希表做 Global Value Numbering：操作码相同、输入相同的两个 Node → 合并为一个。然后反复迭代——因为一次优化会暴露下一次优化的机会。AddI(0,x) -> x -> 使用它的 Node 可能进一步简化。

Inline 打破方法边界——把 callee 的 Node 图嵌入 caller。这让所有优化看穿方法调用——Load 合并、常量传播、循环识别。

LoopOpt 做 peeling（剥 1 次迭代让 invariant 代码显式化）、unrolling（展开循环减少分支）、Range Check Elimination（证明 i<array.length 恒成立 → 消除 bounds check）。

Escape Analysis 分析对象引用流——如果对象不逃逸出方法 → 分配被 scalar replacement 消除 → 零堆分配。Macro Expand 把逃逸的锁展开成 CAS、把逃逸的分配展开成 TLAB bump pointer。

Matcher 读 ADL 文件——把 AddI Node 匹配到 `addl reg,reg`、LoadI Node 匹配到 `mov offset(reg),reg`。RegAlloc 用 Chaitin 图着色——几十个虚拟寄存器映射到 16 个物理 GPR。不够 → spill 到栈。

Output 把 MachNode 序列化为 CodeBuffer 中的字节——构造 nmethod、生成 OopMap、设置入口点。下一次调用这个方法——直接跳转到 C2 生成的 ~10 条 x86 指令。从 3000 个解释器周期 → 30 个 C2 周期 = 100 倍加速。

这就是 C2——不是编译器，是图优化器。

---

## 核心发现总结

| # | 发现 | 核心洞察 |
|---|------|--------|
| 1 | **Sea of Nodes 没有执行顺序** | 数据 Node 自由浮动直到被控制依赖钉住——C2 的核心哲学不同于所有线性 IR 编译器 |
| 2 | **IGVN 不是一次性的** | 反复迭代直到 worklist 为空——一次优化暴露另一次优化的机会（连锁反应） |
| 3 | **Inline 是 C2 最重要的优化** | 打破方法边界让 Load 合并、常量传播、循环识别"看穿"callee——Inline 使所有其他优化更强 |
| 4 | **EA + Macro 可以做到零分配** | `new Point(x,y)` → 两次栈写入——逃逸分析 + 标量替换 = 堆分配消失 |
| 5 | **ADL 是图匹配的代价** | Sea of Nodes 的 DAG 指令选择是 NP-hard → 手工 ADL 模式而非自动图同构 |
| 6 | **LoopOpt 是最大单一消耗者** | 占总编译时间 ~30%——peeling 的 clone + dominator 计算 = 最昂贵的阶段 |
| 7 | **9 阶段顺序不可重排** | Parse→IGVN→Inline→IGVN→LoopOpt→EA→Macro→Match→RegAlloc→Output——每个阶段为下一个准备输入 |
| 8 | **从 3000 cycles → 30 cycles** | C2 编译后的加速比达到 100×——不是"快了几倍"而是"从一个数量级跳到另一个数量级" |
