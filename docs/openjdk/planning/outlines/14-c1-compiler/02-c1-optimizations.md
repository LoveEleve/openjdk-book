# 02. C1 优化 — Canonicalizer + ValueMap + Optimizer

> 🟡 Working | 11 KP 中的 3 个优化机制
> 读者处境: GraphBuilder 产生了 naive HIR——`x+0` 还是 `x+0`。C1 的多趟规范化化简这些冗余。

> ⚠️ 写作期修正(2026-08-15, vol-02/14-c1-compiler/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"Canonicalizer 多趟/pass1→pass2" 错(重要)**: 真实=**单遍即时**——构造时 `if (CanonicalizeNodes) x->visit(this)`(c1_Canonicalizer.hpp:58-60)一次 visit 完成;`x+0+0` 是 GraphBuilder **两次 append 各即时化简一次**,不存在"两趟遍历";"两趟保证收敛"编造
> - **"x*1→x, x/x→1" 错**: x==y 恒等分支只有 isub/iand/ior/ixor(x-x=0/x&x=x/x|x=x/x^x=0,:78-91),**无 x/x**;imul 常量 1/2/4/8→**log2_scale 移位**(:960-977,LP64 仅 lmul,_LP64 下 imul 走 else return false),x*1 实际=移位 0,消除在 LIR 阶段
> - **"if(true) B1 else B2→Goto" 半对**: 真实=do_If(:712+): `If(a cond a)`→Goto(:719-737)/双常量比较→Goto(:739-749)/`If((a cmp b) cond rc)`→化简(:750+);"字面 if(true)" 不存在
> - **"getter/setter 方法内联" 编造**: Canonicalizer 里无任何内联;内联是 GraphBuilder/Compilation 的活
> - **"C1 不做 escape analysis" 错(重要)**: C1 **有浅层 escape 分析=bcEscapeAnalyzer**(12-02 域已证);C1 不做的是 loop unswitching/标量替换
> - **ValueMap ✓ 半对**: find_insert(c1_ValueMap.cpp:109-149): hash=0 排除(:110-112)/链表 is_equal 命中(:115-122)/**跨块值必须 pin**(:130-136,注释原文)/size_threshold 扩容(:139);Instruction::hash=**HASHING1/2/3 宏**(c1_Instruction.hpp:243-271);使用两处=append 的 LVN + build_hir 的全局 GVN(GlobalValueNumbering)
> - **Optimizer ✓**: eliminate_null_checks(c1_Optimizer.cpp:1155,NullCheckEliminator :553 ValueVisitor);RangeCheckElimination 在**独立文件 c1_RangeCheckElimination.cpp**(eliminate :46,**has_access_indexed 才做** :47)
> - **flag 盘点(实证关键)**: RangeCheckElimination=**product**(globals.hpp:1369,release 可关)/CanonicalizeNodes、UseLoopInvariantCodeMotion=product;**UseC1Optimizations(:90)/UseLocalValueNumbering(:105)/UseGlobalValueNumbering(:108)/EliminateNullChecks(:146) 全 develop**(release 不可开关)→优化趟次只能源码推演
> - **行号**: c1_Canonicalizer.cpp **1059 行**;c1_ValueMap.cpp 593;c1_Optimizer.cpp 1209
> - **实证**: 14-c1-optimizations-demo.txt(PrintAssembly 无 hsdis 只输出 nmethod header:C1 main code 352 > C2 224——未深度优化代价;PrintCompilation level 3 编译事件)
> - **悬念指向 03 ✓**(03-c1-register-codegen.md "LinearScan + LIR → x86 码")

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
