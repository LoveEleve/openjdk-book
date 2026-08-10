# 02. C1 优化 — Canonicalizer + ValueMap + Optimizer

> 🟡 Working | 11 KP 中的 3 个优化机制
> 读者处境: GraphBuilder 产生了 naive HIR——`x+0` 还是 `x+0`。C1 的多趟规范化化简这些冗余。

### 1. Canonicalizer — 多趟规范化

场景: `int sum = a + 0 + b;`——GraphBuilder 产生: Add(Add(a, 0), b)。Canonicalizer: pass 1→Add(a, 0) 化简为 a。pass 2→Add(a, b)。

**Canonicalizer** (`c1_Canonicalizer.hpp.cpp`):
- 代数简化: x+0→x, x*1→x, x*0→0, x/x→1 (if constant), -(x)→Negate(x)
- 条件简化: `if (true) B1 else B2`→分支消除→Goto(B1)
- 常量折叠: Add(Constant(3), Constant(4))→Constant(7)——编译时计算
- [C++: Canonicalizer 的多趟——`canonicalize(BlockBegin*)`→遍历每个 block→`visit(Instruction*)`→针对 instruction type 调用简化规则。为什么多趟？— 一趟简化后可能产生新的可简化模式——比如 x+0+0→x+0→x。两趟保证收敛——不需要迭代到 fixpoint (C2 做更复杂的 GVN)]
- 方法内联: 简单的 getter/setter——`int getX() { return x; }`→Canonicalizer 直接替换为 field access——inline→消除 invoke 开销

### 2. ValueMap — 全局值编号

**ValueMap** (`c1_ValueMap.hpp.cpp`):
- GVN: `ValueMap::find_insert(Value*)`——如果是已见过的值 (相同的 opcode+operands)→返回已有 value
- CSE: `field = obj.value; tmp = obj.value;`——两次 field access→Canonicalizer 消除第二次——只 load 一次
- [C++: ValueMap 的 hash——`value->hash()` = opcode + operand1_hash + operand2_hash + ...。碰撞→linear probe→找到相同 value→替换。C1 的 GVN——每 instruction 只检一次——不迭代——快但不如 C2 精确]

### 3. Optimizer — null check + range check 消除

**Optimizer** (`c1_Optimizer.hpp.cpp`):
- Null check 消除: `obj != null` 已验证→后续 `obj.field` 不需要再 check——`NullCheckEliminator::eliminate()`→遍历 def-use→移除 redundant check
- Range check 消除: `for(i=0;i<arr.length;i++) arr[i]`——loop bound 已知→`RangeCheckEliminator::eliminate()`→loop 内的 bounds check 提到 loop 外 (或消除)

---

### 核心悬念

**"x+0+0→x+0→x——Canonicalizer 两趟化简。C1 不做 escape analysis/loop unswitching——因为 profiling data 留给 C2 做——牺牲优化深度换编译速度。"** — ValueMap GVN 消除重复计算——每 instruction 只检一次——快但不如 C2 精确。下一篇: LinearScan——O(n) 寄存器分配。

> → [03-c1-register-codegen.md](03-c1-register-codegen.md)
