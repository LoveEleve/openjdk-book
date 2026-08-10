# 02. Parse + GraphKit — 字节码→Ideal Graph

> 🔴 Deep | 16 KP 中的 2 个核心机制
> 读者处境: C2 开始编译——Parse 逐字节码→C2 Node——inline 决策——GraphKit 提供 node factory。

### 1. Parse — 字节码→Ideal

场景: iload_1→Parse::do_load(Bci)→LocalNode(value=Local(locals[1]))→push(value)。invokevirtual→do_call()→inline decision→build callee graph→c2 Node→push result。

**Parse** (`parse1.cpp + parse2.cpp + parse3.cpp`):
- `Parse::Parse(JVMState*, ciMethod*, ...)`: 遍历 bytecodes→每条→`bytecode()`→switch 调对应的 `do_X()`
- Inline: `do_call()`→`InlineTree::should_inline()`→check bytecode size/max inline depth/frequency→ok→`Parse::do_inline()`→build callee 的 graph→**此 graph 内联到此方法中**→callee 的 Node 变为此方法的 local Node
- [C++: Inline 的递归——`do_call()`→`should_inline()`→如果 yes→`Parse::do_inline()`→递归 `new Parse(callee_method, this)`→callee graph 构建→return——callee 的全部 Node 现在是 caller graph 的一部分。C2 inline 深度默认 9——递归 inline——最关键的性能优化]
- OSR: `Parse::do_osr()`——在循环中间 start——从 OSR bci 开始构建 graph——循环变量 from interpreter frame→Node

### 2. GraphKit — Node factory

**GraphKit** (`graphKit.hpp.cpp`):
- `GraphKit::add_node(Node*)`: add Node to current block→set control edge
- `GraphKit::gvn()`: IGVN 的当前实例——`transform()` 每个新 Node
- SafePoint: `GraphKit::add_safepoint()`——GC safepoint in graph→OopMap
- [C++: GraphKit 持有 Parse 的 state——current control node, memory state (MergeMem), i_o state→每个 new Node 自动连到这些 state。Parse 做高层语义——GraphKit 做底层 graph wiring]

---

### 核心悬念

**"Parse 逐字节码→C2 Node——Inline 9 层递归——GraphKit 做底层 wiring。"** — Parse 的 do_call() inline 决策基于 bytecode size/inline depth/frequency——C2 inline 远比 C1 激进。下一篇: IGVN——优化这个海量图。

> → [03-c2-optimizations.md](03-c2-optimizations.md)
