# 02. C1 优化 — Canonicalizer + ValueMap + Optimizer

> **前置依赖**:[14-c1-compiler/01 — C1 管线 + HIR: 字节码→编译图](01-c1-pipeline-ir.md):管线三大步与 HIR 图;[12-ci/02 — ciTypeFlow 与 escape 分析](openjdk/vol-02/12-ci/02-ci-typeflow-escape.md):C1 的浅层 escape 分析(bcEscapeAnalyzer)在这里
> → **后续**:[14-c1-compiler/03 — LinearScan + LIR → x86 码](03-c1-register-codegen.md)
> 关联域: 12-ci(编译期镜像与 escape)、08-interpreter(字节码语义)

## naive HIR 怎么变干净

01 篇的 GraphBuilder 产出"naive HIR"——`a + 0 + b` 会先建 `Add(Add(a, 0), b)`。C1 用三样东西把它变干净: **Canonicalizer**(代数/常量简化)、**ValueMap**(值编号消除重复计算)、**Optimizer**(null/range check 消除)。这篇拆三层,并纠正大纲三个想象: Canonicalizer **不是多趟**而是 append 时单遍即时;"x/x→1" 不存在;getter 内联不是 Canonicalizer 的活。**C1 的 escape 分析也不是没有**——12-02 域的 bcEscapeAnalyzer 就是 C1 的(只是很浅)。

## 1. Canonicalizer: 单遍即时,不是多趟

Canonicalizer 的调用点就是 01 篇的 `append_with_bci`——构造它时**一次性 visit 完成全部简化**(c1_Canonicalizer.hpp:58-60,`CanonicalizeNodes` flag 门控):

```cpp
// c1_Canonicalizer.hpp:56-61(截取核心,逐字)
    NOT_PRODUCT(x->set_printable_bci(bci));
    if (CanonicalizeNodes) x->visit(this);
  }
  Value canonical() const                        { return _canonical; }
```

**"多趟"是误解**: `a + 0 + 0` 的情形是 GraphBuilder 两次 append,每次都即时化简(`Add(a,0)→a` 后第二次 `Add(a,0)→a`),不存在"一遍遍历后再来一遍";"两趟保证收敛"是编造。简化规则集中在 `do_Op2`(c1_Canonicalizer.cpp:77-180+)的三段: **①操作数恒等**(x==y): `x-x→0`、`x&x→x`、`x|x→x`、`x^x→0`(:78-91);**②双常量折叠**: int/long 的 add/sub/mul/div/rem/and/or/xor 全部编译期算掉(除法除 0 保护,:93-156);**③单常量**(y==0): `x+0→x`、`x-0→x`、`x*0→0`、`x&0→0`、`x|0→x`(:160-180+)。`x*1` 不在消除列表里——**imul 常量 1/2/4/8 转成移位**(`:960-977`,返回 `log2_scale`,`x*1` 变成移位 0,真正消除发生在 LIR 阶段)。

**控制流简化在 `do_If`**(:712+): `If(a cond a)`→**直接替换成 Goto**(:719-737,`a==a` 恒真/`a<a` 恒假选择后继);`If(常量1 cond 常量2)`→编译期定真值→Goto(:739-749);`If((a cmp b) cond rc)`→按比较结果化简(:750+)。**方法内联的澄清**: Canonicalizer 里没有任何 getter/setter 内联——内联是 GraphBuilder/Compilation 层的活(12-02 域的内联器),大纲把它安在 Canonicalizer 头上是编造。

## 2. ValueMap: 值编号

`ValueMap::find_insert`(c1_ValueMap.cpp:109-149)是 GVN 的核心: `hash=0` 的值排除在外(:110-112);哈希桶**链表遍历**,`hash` 相同且 **`is_equal`**(操作相同+操作数相同)则**复用已有值**(:115-122);未命中则插入(:140-145),表满 `size_threshold` 扩容(:139)。**跨基本块的值有讲究**: 命中另一个块的非常量值时必须 **`pin()`**(:130-136,注释 "non-constant values of another block must be pinned, otherwise it is possible that they are not evaluated")——否则那个值可能根本没执行到。`Instruction::hash` 由 **HASHING1/2/3 宏**按操作数个数生成(c1_Instruction.hpp:243-271)——就是"opcode + 操作数哈希"的组合。

使用点两处: ①01 篇的 **append_with_bci**(UseLocalValueNumbering,局部值编号——同块内 CSE);②build_hir 的**全局趟**(UseGlobalValueNumbering,`GlobalValueNumbering gvn(_hir)`)——这就是"每指令只检一次、不迭代"的 GVN。

## 3. Optimizer: null check 与 range check 消除

`Optimizer::eliminate_null_checks`(c1_Optimizer.cpp:1155-1161)跑 `NullCheckEliminator`(:553,ValueVisitor 遍历): 沿 def-use 传播"已验证非空"的集合,后续对同一对象的字段访问/null check 就省掉。`RangeCheckElimination::eliminate`(c1_RangeCheckElimination.cpp:46-52)是另一个文件:**只有方法里有 AccessIndexed 才做**(:47 `has_access_indexed`),内部 `RangeCheckEliminator` 用 predicate 传播数组边界信息。

**flag 盘点决定实证手段**: `RangeCheckElimination` 是 **product**(globals.hpp:1369,release 可关),`CanonicalizeNodes`/`UseLoopInvariantCodeMotion` 是 product;而 **UseC1Optimizations/UseLocalValueNumbering/UseGlobalValueNumbering/EliminateNullChecks 全是 develop**(c1_globals.hpp:90/:105/:108/:146)——release 关不掉,优化趟次只能源码推演。[实证](planning/outlines/00-jvm-tools/materials/commands/14-c1-optimizations-demo.txt)里 PrintAssembly 因缺 hsdis 只输出 nmethod 布局(可见 C1 的 main code 352 字节 > C2 的 224——**未深度优化的代价**)。*关键设计: 大纲"C1 不做 escape analysis"是错的——C1 有浅层 escape 分析(bcEscapeAnalyzer,12-02 域),只是不做 loop unswitching/标量替换这类深度优化;profiling 数据留给 C2(13-02 域)*。

## 核心悬念

优化三件套拆完: Canonicalizer 是 append 时**单遍即时**简化(x==y 恒等/双常量折叠/y=0 特例/if 化简为 Goto/imul 幂转移位,无内联无多趟);ValueMap 的 find_insert 是哈希+is_equal+**跨块 pin** 的值编号(局部 LVN + 全局 GVN 两处使用);Optimizer 消除 null/range check(RangeCheckElimination 是 release 可关的 product flag)。HIR 至此干净了,但机器码还没影——**下一步是把 HIR/LIR 分配到寄存器**: 线性扫描分配器(LinearScan)与代码生成(emitter/LIR_Assembler)。下一篇: LinearScan 与 LIR → x86 码。

> → [14-c1-compiler/03 — LinearScan + LIR → x86 码](03-c1-register-codegen.md)
