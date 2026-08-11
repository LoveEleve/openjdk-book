# 02. Parse + GraphKit — 字节码→Ideal Graph

> 🔴 Deep | 16 KP 中的 2 个核心机制——字节码到 C2 IR
> 读者处境: C2 开始编译→Parse 逐 bytecode 构建 C2 Node。inline 决策——`do_call()`→`should_inline()`→递归 `new Parse(callee_method)`→callee 的 Node 内联到此方法。GraphKit 提供 node factory——每个 new Node 自动连 control/memory/i_o state。

### 1. "Parse — 逐字节码→C2 Node"

场景: bytecode `iload_1`→`Parse::do_load(Bci)→LocalNode(value=locals[1])→push(value)`。`invokevirtual`→`do_call()`→inline decision→build callee graph→C2 Node→push result。整个方法从 Bci 0 开始逐条 bytecode→构建 Node→直到 RETURN。

**Parse** (`parse1.cpp:390-800 + parse2.cpp`):
```
Parse::Parse(caller, parse_method, expected_uses) (line 390):
  → 遍历 bytecodes with RawBytecodeStream
  → switch(opcode):
      iload_1      → do_load() → LocalNode → push(Local)
      iadd         → do_arith() → AddINode → pop+pop+push
      invokevirtual → do_call() → inline decision
      ifeq         → do_if() → IfNode → split control flow(True/False paths)
      return       → ReturnNode → finalize graph

Inline 递归 (parse1.cpp:800-1200):
  do_call():
    → InlineTree::should_inline(method, caller) — 检查 bytecode size(<MaxInlineSize=35)
    → check max inline depth(default 9) + frequency
    → if ok: Parse::do_inline() → new Parse(callee_method, this)
    → 返回——callee 的全部 Node 现在是 caller graph 的一部分
[C++: parse1.cpp+parse2.cpp+parse3.cpp——三个文件按 bytecode 类型分: load/store/arithmetic→call/invoke/new→branch/return/exception]
```
- 源码: `parse1.cpp:390-600` (Parse constructor→bytecode loop) + `parse1.cpp:800-1200` (do_call→inline decision) + `parse2.cpp:200-500` (do_field/do_array→LoadNode/StoreNode)

- 关键设计: **C2 inline 远比 C1 激进**——C1 只 inline tiny methods(bytecode size < 35, depth ≤ 2)。C2 inline: MaxInlineSize=35(默认), MaxInlineDepth=9, 高频方法优先。递归 inline——`do_call()`→`should_inline()`→如果 yes→`Parse::do_inline()`→递归 `new Parse(callee_method, this)`→callee graph 构建→merge 到 caller graph。**OSR(On-Stack Replacement)**: from interpreter→compile at loop bci→从 OSR entry 开始构建 graph→循环变量 from interpreter frame。

### 2. "GraphKit — Node factory + state wiring"

场景: Parse 做高层语义(bytecode→什么 Node 类型)→GraphKit 做底层 graph wiring——`add_node(n)` 自动连 control edge + memory edge + i_o edge 到当前 state。每次 new Node→`gvn().transform(n)`→IGVN 优化。

**GraphKit** (`graphKit.hpp:100-300 + graphKit.cpp:100-400`):
```
GraphKit 核心功能:
  add_node(Node*) → add to current block → set_preferences(control/mem/io edges)
  gvn() → PhaseIterGVN& → transform() each new Node(immediate IGVN pass)

State 保持:
  control()    → 当前 control node(最近的分支/merge)
  memory(idx)  → 当前 memory state(MergeMem——每个 alias category 一个 memory slice)
  i_o()        → I/O state(最近的可观测操作→safepoint/System call)

SafePoint: add_safepoint() → OopMap recording 在 GC 时需要的寄存器/oops
[C++: graphKit.hpp——GraphKit 持有 Parse 的 JVMState——当前 bci/method/callee/locals/monitors——自动附加到 safe point]
```
- 源码: `graphKit.hpp:100-250` (GraphKit 类定义) + `graphKit.cpp:100-300` (add_node/safepoint/OopMap) + `graphKit.cpp:300-500` (memory slice management)

- 关键设计: **MergeMem = multi-slice memory state**——不同于 C1 的单一 memory state。MergeMem 为每个 Java 内存别名类别(Java heap/static fields/instance fields/array elements)保持独立 memory slice——load/store 操作匹配相应 slice→修改局部 slice→不影响其他类别。Alias Analysis(将两个内存访问归入同一 slice 或不同 slice)→决定是否可以 reorder load/store。**add_safepoint**——GC 需要知道 compiled code 中哪些寄存器/栈位置含有 oop→SafePointNode 记录当前 OopMap→GC 扫描时通过它找到 oops。

---

### 核心悬念

**"Parse(bytecode→Node, 逐条构建)→Inline(递归 do_call, depth 9, size 35)→GraphKit(add_node 自动 wiring control+memory+io state, gvn transform 即时优化)。C2 inline 将 callee graph 内联到 caller→海量 Node 网→等待 IGVN 优化。"** — 下一篇: IGVN + CCP + Escape Analysis——优化这个海量图。

> → [03-c2-optimizations.md](03-c2-optimizations.md)
