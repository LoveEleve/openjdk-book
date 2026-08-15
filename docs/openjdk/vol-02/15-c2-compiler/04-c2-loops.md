# 04. Loop Optimization + SuperWord — 循环变换与向量化

> **前置依赖**:[15-c2-compiler/01 — C2 Ideal Graph: Node + Type + IGVN](openjdk/vol-02/15-c2-compiler/01-c2-ideal-graph.md):Node/Type/IGVN 是循环变换的底层;[15-c2-compiler/02 — Parse + GraphKit: 字节码→Ideal Graph](openjdk/vol-02/15-c2-compiler/02-c2-parse-graphkit.md):回边 safepoint 与 Phi 在这里出生;[15-c2-compiler/03 — IGVN + CCP + Escape Analysis: C2 优化三引擎](openjdk/vol-02/15-c2-compiler/03-c2-optimizations.md):循环优化的邻居与调度环境;[13-jit-framework/02 — 为什么先 C1 再 C2?— TieredThresholdPolicy 5 层编译策略](openjdk/vol-02/13-jit-framework/02-tiered-compilation-policy.md):OSR 编译在回边触发
> → **后续**:[15-c2-compiler/05 — Chaitin: 图着色寄存器分配 O(n²)](openjdk/vol-02/15-c2-compiler/05-c2-register-alloc.md)
> 关联域: 13-jit-framework(OSR/回边)、16-code-cache(nmethod)、24-frame(帧)

## 循环值得一整章

`for (int i = 0; i < n; i++) a[i] = b[i] + c[i]`——C2 为它做的事比整个 C1 还多: 先**识别**这是计数循环(induction variable 结构),建**循环树**(嵌套层次),然后逐循环做**迭代拆分**(剥皮/展开/范围检查消除),最后 **SuperWord 向量化**把 4 个 int 操作合并成一条 SSE 指令。而且这套体系在编译期管线里占了比 EA 更长的篇幅(compile.cpp:2344-2372 的 IdealLoop 阶段 + :2399 的 optimize_loops 多轮)。这篇拆三块: 循环识别、迭代拆分、向量化。顺带纠正大纲三处: `add_constraint()` 不存在(范围检查谓词是 loop_predication/insert_loop_limit_check 家族);"Loop Strip Mining = 主向量+尾标量"是概念错位——那是 **pre/main/post 循环拆分**,strip mining 在 JDK11 是外层 safepoint 剥离且 **默认关闭**(LoopStripMiningIter=0);大纲的指令映射 `movdqa` 实测是 `movdqu`(x86.ad:3098)。

## 1. 识别: 从回边到 CountedLoop

Parse 产出的循环只是一团控制流: 回边 IfTrue/IfFalse、Region(loop header)、Phi(i)、AddI(i,1)、比较。`PhaseIdealLoop::is_counted_loop`(loopnode.cpp:372)按**严格形状**判定它是不是"计数循环":

```cpp
// loopnode.cpp:372-395(截取核心,逐字)
bool PhaseIdealLoop::is_counted_loop(Node* x, IdealLoopTree*& loop) {
  PhaseGVN *gvn = &_igvn;

  // Counted loop head must be a good RegionNode with only 3 not NULL
  // control input edges: Self, Entry, LoopBack.
  if (x->in(LoopNode::Self) == NULL || x->req() != 3 || loop->_irreducible) {
    return false;
  }
  Node *init_control = x->in(LoopNode::EntryControl);
  Node *back_control = x->in(LoopNode::LoopBackControl);
  if (init_control == NULL || back_control == NULL)    // Partially dead
    return false;
  // Must also check for TOP when looking for a dead loop
  if (init_control->is_top() || back_control->is_top())
    return false;
```

后面还要验证回边是 IfTrue/IfFalse、测试是 Bool(Cmp(...))、phi 是 `init + stride*iter` 形式——**只有 stride 是编译期常量、边界可算的循环才是 CountedLoopNode**,因为后续所有变换(展开、谓词、向量化)都依赖"循环次数可知"。识别出的循环组织成 **IdealLoopTree**(嵌套树,parent-child 关系),由 `build_loop_tree`(loopnode.cpp:3810)构建。`PhaseIdealLoop::build_and_optimize`(loopnode.cpp:3062)是循环优化的总入口,流程比大纲写的长得多: `build_loop_tree`(:3113)→ `beautify_loops`(:3154,拆共享 header)→ `Dominators`(:3180)→ `counted_loop`(:3220,树上的计数循环识别)→ 不变量重结合(:3302)→ split-if(:3330)→ `loop_predication`(:3344)→ **`iteration_split`(:3361,迭代拆分的入口)** → 谓词清理(:3396)→ **SuperWord(:3405)**。

*关键设计: 循环优化全部押注在"计数循环"这个形状上——stride 常量、trip count 可算、单回边。非计数循环只配剥皮(partial_peel);计数循环才能获得展开、范围检查消除、向量化的全套待遇。*

## 2. 变换: iteration_split 与 pre/main/post 三循环

真正的优化分发在 `iteration_split`(loopTransform.cpp:3420)→ `iteration_split_impl`(:3273),按策略逐级下探:

```cpp
// loopTransform.cpp:3282-3308(截取核心,逐字)
  // Convert one iteration loop into normal code.
  if (do_one_iteration_loop(phase)) {
    return true;
  }
  // Check and remove empty loops (spam micro-benchmarks)
  if (do_remove_empty_loop(phase)) {
    return true;  // Here we removed an empty loop
  }

  AutoNodeBudget node_budget(phase);

  // Non-counted loops may be peeled; exactly 1 iteration is peeled.
  // This removes loop-invariant tests (usually null checks).
  if (!_head->is_CountedLoop()) { // Non-counted loop
    if (PartialPeelLoop && phase->partial_peel(this, old_new)) {
      // Partial peel succeeded so terminate this round of loop opts
      return false;
    }
    if (policy_peeling(phase)) {    // Should we peel?
      if (PrintOpto) { tty->print_cr("should_peel"); }
      phase->do_peeling(this, old_new);
    } else if (policy_unswitching(phase)) {
      phase->do_unswitching(this, old_new);
      return false; // need to recalculate idom data
    }
    return true;
  }
```

计数循环继续: 校验有效性、跳过 pre/post 循环本身(:3311-3314)、策略门 `policy_unswitching`/`policy_maximally_unroll`(完全展开,:3321-3332)、剥皮评估(:3334),然后 `policy_unroll`(展开策略,`_local_loop_unroll_factor=4` 起步,:782)与 `policy_range_check`(:3350)共同决定是否走 **pre/main/post 三循环模型**(:3365-3371 `insert_pre_post_loops`,:1396):

- **pre-loop**: 循环前先跑 0~N 次,把主循环的起点对齐(向量化需要)或消化剥皮剩余;
- **main-loop**: 展开后的主体——`do_unroll`(loopTransform.cpp:1910)按因子复制循环体,调整 limit(`init/limit/stride` 重算,:1942-1945),并更新谓词(`update_main_loop_skeleton_predicates`,:1972);
- **post-loop**: 收尾处理"main 循环没跑完的零头"(比如 n%4≠0 的最后 1-3 个元素)。

大纲的"Loop Strip Mining: 外层 for(i+=4) 内层 for(j=i...)"是这个模型的误解——JDK11 的 **strip mining 是另一回事**: `OuterStripMinedLoopNode`(loopnode.hpp:441)在计数循环外包一层外壳放 safepoint,让主循环体不含轮询点,而且 `LoopStripMiningIter` 默认 **0 = 关闭**(c2_globals.hpp:755)。"尾标量版本"是 post-loop 的职责,不是 strip mining。

**范围检查的两种命运**: ①`insert_loop_limit_check`(loopnode.cpp:327)——预循环入口的 **limit 溢出检查**(防止 init/limit 加减溢出,用 `Opaque1` 节点保护,loopTransform.cpp:1957-1959 的 zero-trip guard 同族);②`loop_predication`(loopPredicate.cpp:1505 递归树序)→ `loop_predication_impl`(:1329)——把循环体内"每迭代都做"的检查(典型: 数组下标范围检查 `if (i < len)`)**提升为循环入口的一次性谓词**: 入口处验证"整个循环的所有迭代都不会越界",成立则循环体里不再检查。大纲说的 `add_constraint()` 不存在,谓词也不是"goto 解释器",而是理想图里 `Opaque1` 保护的条件分支。循环优化跑完后 `remove_range_check_casts`/`remove_opaque4_nodes`(compile.cpp:2421-2425/:2452-2455)再把这些临时保护节点清掉。

*关键设计: 三循环模型是"分期付款"——pre 付对齐成本、main 全速跑、post 收拾零头;每个循环的 trip count 独立重算,谓词在入口一次性验证整轮安全。这比"展开 4 次"这个表面动作深得多: 展开只是手段,让 main-loop 变成"可向量化、无检查、对齐"的干净循环才是目的。*

## 3. SuperWord — 把 4 条标量指令合并成 1 条向量

`UseSuperWord`(product,c2_globals.hpp:333)默认开。`SuperWord::transform_loop`(superword.cpp:97-191)的入口门控: **架构向量宽度**(`Matcher::vector_width_in_bytes(T_BYTE) < 2` 直接返回,:100)、只处理计数循环、**main-loop 必须能找到 pre-loop 的终点**(`find_pre_loop_end`,:153-164)、`SuperWordLoopUnrollAnalysis` 下 `slp_max_unroll()==0` 的循环跳过(:125)。通过后 `SLP_extract`(:450)走完整流水线:

```cpp
// superword.cpp:450-472(截取核心,逐字)
void SuperWord::SLP_extract() {
  ...
  // Ready the block
  if (!construct_bb()) {
    return; // Exit if no interesting nodes or complex graph.
  }

  // build    _dg, _disjoint_ptrs
  dependence_graph();

  // compute function depth(Node*)
  compute_max_depth();
```

`construct_bb`(:2793)把循环体组织成块,`dependence_graph` 做依赖分析,随后 `combine_packs`(:1552)把**内存地址相邻**(同 base、连续偏移)的 Load/Store 与对应的算术节点打包成 pack(4 个 LoadI → 1 个 LoadVector、4 个 AddI → 1 个 AddVI、4 个 StoreI → 1 个 StoreVector),`output`(:2282)做对齐处理(`align_initial_loop_index`,:2298)并插入解包节点,最后经 Matcher 匹配成 x86 指令——实测指令映射(x86.ad): `loadV4`→`movd`(:3034)、`loadV16`→`movdqu`(:3098,**不是大纲说的 movdqa**)、`vadd2I`→`paddd`/`vpaddd`(UseAVX 0/1 分派,:6325-6345)。

**对齐是向量化的命门**: 主循环的初始索引必须对齐到向量宽度(`align_initial_loop_index` 注释 "MUST ENSURE main loop's initial value is properly aligned",:2297-2298)——这正是 pre-loop 的职责之一: pre-loop 跑掉不对齐的迭代,让 main-loop 从对齐地址开始。大纲"base%16≠0→vmovdqu 性能 penalty 5-10%"的机制对(JDK11 用 movdqu 统一处理),但 5-10% 是经验值没有源码依据,删除。

**实证**([素材](planning/outlines/00-jvm-tools/materials/commands/15-c2-loops-demo.txt)): 计算密集循环(每元素 8 次乘加)的层层对照——①**C1 vs C2**: 仅 C1(level 3)比 C2 慢 **3.7 倍**(9649ms vs 2613ms,素材第 2 段)——C2 循环优化的整体量级;②**flag 拆分**(-Xbatch 超长运行,素材第 3 段): `-XX:-UseSuperWord` 慢 **59%**(3822 vs 2410ms),`-XX:LoopUnrollLimit=1` 慢 **70%**(4105ms)——向量化与展开各自贡献显著,且展开的贡献甚至更大(它喂给向量化的 pack 需要展开后的相邻指令);③**OSR 事件**(素材第 1 段): `1 % 3 run @ 6`——循环回边触发的 OSR 编译(13-jit/02 域的机制在这里落地);④**CITime**(素材第 4 段): `IdealLoop: 0.006s` 占 Optimize 0.006s 的全部——这个方法的编译时间几乎全花在循环优化上。`TraceSuperWord` 是 notproduct(c2_globals.hpp:348)、`TraceLoopOpts` 是 develop(:228)——release 都不可用,所以循环变换本身无法直接打印,行为对照是唯一实证通道。

*关键设计: 向量化不是独立魔法,而是"三循环模型 + 展开 + 依赖分析 + 对齐"的最终兑现——main-loop 干净(无检查、无谓词残留)、展开后出现相邻指令、对齐由 pre-loop 保证,SLP 才有 pack 可打。任何一个前提缺失(`slp_max_unroll()==0`、找不到 pre-loop、架构无向量),SuperWord 就安静地跳过(return,不报错)。这也是 C2 循环体系"多层依赖、层层铺垫"的缩影。*

## 核心悬念

循环体系至此完整: **识别**(is_counted_loop 形状判定 + IdealLoopTree 嵌套树)→ **变换**(iteration_split 分发: 单迭代/空循环/剥皮/完全展开/非计数剥皮;pre/main/post 三循环模型让展开与 RCE 各得其所;loop_predication 把逐迭代检查提升为入口谓词)→ **向量化**(SLP_extract: 依赖图 + 打包 + 对齐 + 指令映射,实证 C2 比 C1 快 3.7 倍、向量化 +59%、展开 +70%)。图到这一步已经"理想"到极致——但离机器码还差最后一公里: 数万个节点要放进有限的寄存器,冲突的生存期要分家。C2 用**图着色**解决(Chaitin 算法,O(n²) 精确分配),那是与 C1 线性扫描完全不同的另一套分配哲学。下一篇: 寄存器分配。

> → [15-c2-compiler/05 — Chaitin: 图着色寄存器分配 O(n²)](openjdk/vol-02/15-c2-compiler/05-c2-register-alloc.md)
