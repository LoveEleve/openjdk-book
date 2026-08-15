# 04. Loop Optimization + SuperWord — 循环变换与向量化

> 🔴 Deep | LoopNode unrolling + Range Check Elimination + SIMD
> 读者处境: `for (int i = 0; i < 1000; i++) a[i] = b[i] + c[i];` — C2 将这个简单循环转变为什么？Loop unrolling 展开 4 次减少 branch、Range Check Predicate 将 bounds check 提升到循环外、SuperWord 自动向量化——4 个 int→1 个 SSE 128-bit ADDPS。

### 1. "IdealLoopTree — 循环识别与构建"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/04 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"build_and_optimize (loopnode.cpp:3062-3100)" 范围不全(重要)**: 真实流程 :3062-3431+: build_loop_tree(:3113)→beautify_loops(:3154 拆共享 header)→Dominators(:3180)→counted_loop(:3220)→reassociate_invariants(:3302)→split_if(:3330)→loop_predication(:3344)→**iteration_split(:3361)**→cleanup_loop_predicates(:3396)→SuperWord(:3405)
> - **"do_unroll/add_constraint/do_range_check/do_one_iteration_loop/do_peeling 直接调" 错**: 分发在 **iteration_split(loopTransform.cpp:3420)→iteration_split_impl(:3273)**: do_one_iteration_loop(:3283)/do_remove_empty_loop(:3287)/非计数 partial_peel(:3296)+policy_peeling→do_peeling(:3300-3302)/policy_unswitching→do_unswitching(:3303-3304)/计数 policy_maximally_unroll(:3326)/policy_unroll(:3349)+policy_range_check(:3350)→**insert_pre_post_loops(:3366-3371,:1396)**
> - **"add_constraint()" 编造**: 零命中;范围检查谓词=**loop_predication(loopPredicate.cpp:1505 递归树序)→loop_predication_impl(:1329)**+insert_loop_limit_check(loopnode.cpp:327,limit 溢出检查);谓词=Opaque1 保护的理想图条件分支,非"goto 解释器"
> - **CountedLoop 判定**: is_counted_loop(loopnode.cpp:372-500): Region 3 输入(Self/Entry/LoopBack)+IfTrue/IfFalse 回边+Bool(CmpI)(禁指针/浮点)+limit 循环不变量+incr 循环变量+Phi(region 匹配)+AddI 增量+**stride 常量**
> - **loopnode.cpp 5056 行** ✓(大纲"约5000行")


场景: Parse 产生 IfNode(backedge)→RegionNode(loop header)→PhiNode(i) → AddI(i,1)→IfNode——标准计数循环结构。PhaseIdealLoop 识别这个 pattern→构建 IdealLoopTree。

**PhaseIdealLoop::build_and_optimize** (`loopnode.cpp:3062-3100`):
```
PhaseIdealLoop::build_and_optimize():
  → 扫描全部 CountedLoopNode(backedge + control Phi + stride Phi)
  → build_loop_tree() → 嵌套循环→parent-child 树
  → 逐 loop 优化:
      • do_unroll(loop) — 展开循环体(4x/8x 减少 branch)
      • add_constraint() — Range Check Predicate 提升到循环前
      • do_range_check() — 消除 bounds check (若 stride 已知)
      • do_one_iteration_loop() — 单一迭代→完全展开
      • do_peeling() — 剥离 1 次迭代消除 first-iteration 的怪模式
[C++: loopnode.cpp 约5000行——IdealLoopTree 是 C2 循环优化的核心数据结构]
[x86: 循环展开用 SSE 128-bit / AVX 256-bit——SSE vec_length=4(int)/8(short)/16(byte); AVX2 翻倍=8/16/32]
```
- 源码: `loopnode.cpp:3062-3100` (build_and_optimize) + `loopTransform.cpp:1910-2000` (do_unroll)

- 关键设计: **CountedLoopNode** 检测——StrideType(±1/±2/±4/±8)→C2 知道循环访问模式→可以用 maddps 或 paddd 做向量化。**RCE (Range Check Elimination)**: bound check `if (i >= len) throw AIOOBE` 提升到循环前——用 stride=maxIter*vec_len 一次性验证整个循环不会越界。

### 2. "Loop Unrolling + Predicate"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/04 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"Loop Strip Mining: 外层 for(i+=4) 内层 for(j...)" 错(重要,概念错位)**: JDK11 strip mining=**OuterStripMinedLoopNode(loopnode.hpp:441)外层包 safepoint**;且 **LoopStripMiningIter 默认 0 关闭**(c2_globals.hpp:755);"主向量版本+尾标量版本"是 **pre/main/post 三循环拆分**(insert_pre_post_loops loopTransform.cpp:1396)的职责——pre-loop(对齐/剥皮剩余,注释 "RCE and alignment may change this later")/main-loop(do_unroll :1910 展开主体)/post-loop(零头收尾)
> - **"插入 Range Check Predicate: if (len < 25*4) goto slow_path" 简化错**: 无 goto;谓词=入口处 Opaque1 保护的条件分支(insert_loop_limit_check loopnode.cpp:327;zero-trip guard opaq loopTransform.cpp:1957-1959);循环优化后 remove_range_check_casts/remove_opaque4_nodes(compile.cpp:2421-2425/:2452-2455)清理
> - **"loop_pred blocks 在 x86.ad 中描述" 无据**: 谓词是理想图节点,非 .ad 指令
> - **"do_unroll (loopTransform.cpp:1910-2000)"** ✓(:1910);"small 4x/tiny 8x" → policy_unroll **factor=4 起步**(:782);**LoopUnrollLimit x86_64=60**(c2_globals_x86.hpp:55 AMD64);**LoopMaxUnroll=16**(c2_globals.hpp:179);limit/init/stride 重算(:1942-1945);update_main_loop_skeleton_predicates(:1972)
> - **补 do_range_check 定位**: do_range_check(loopTransform.cpp:2520)是 RCE 主体;policy_range_check(:3350)决策;build_and_optimize 里 policy_range_check 标记 _rce_candidate(loopnode.cpp:3321-3323)


场景: `for (int i = 0; i < 100; i++) sum += a[i];` — Unroll 4x→循环体有 4 个 `sum += a[i]; sum += a[i+1]; sum += a[i+2]; sum += a[i+3]`——i+=4→25 次迭代(原 100 次)→branch 减少 75%。

**do_unroll + Predicate** (`loopTransform.cpp:1910-2000 + loopPredicate.cpp`):
```
PhaseIdealLoop::do_unroll(loop):
  → 检查 unroll factor——small loop→4x, tiny loop→8x
  → 复制循环体 factor 次——每个 body 的 Phi 重新编号(i+1,i+2,i+3,i+4)
  → adjust_trip_count: old_trip = 100, new_trip = 100/4 = 25
  → 插入 Range Check Predicate: if (len < 25*4) goto slow_path (解释器)
[x86: loop_pred blocks 在 x86.ad 中描述——产生 cmpl+jcc 指令]
```
- 源码: `loopTransform.cpp:1910-1970` (do_unroll) + `loopPredicate.cpp:50-200` (predicate insertion)

- 关键设计: **Loop Strip Mining**: 循环拆分——外层 `for (i=0; i<100; i+=4)` 内层 `for (j=i; j<min(i+4,100); j+=1)`——主向量化版本 + 尾标量版本——当 n%4≠0 时不丢失最后几个元素。

### 3. "SuperWord — Auto-Vectorization (SLP)"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/04 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"transform_loop (superword.cpp:97-150)"** ✓(:97-191);**门控**: Matcher::vector_width_in_bytes(T_BYTE)<2 返回(:100)/main-loop 需 find_pre_loop_end(:153-164)/SuperWordLoopUnrollAnalysis 下 slp_max_unroll()==0 跳过(:125)/is_vectorized_loop/is_unroll_only 跳过(:149-151)
> - **"construct_bb→combine_packs→output" 链对但中间有**: SLP_extract(:450): construct_bb(:2793)→**dependence_graph→compute_max_depth**→combine_packs(:1552)→output(:2282)
> - **"output → emit x86 (2282-2320)"** ✓(:2282);**align_initial_loop_index(:2298,注释 "MUST ENSURE main loop's initial value is properly aligned")**+insert_extracts 解包
> - **指令映射实测(x86.ad)**: loadV4→**movd**(:3034)/loadV16→**movdqu**(:3098,**非大纲 movdqa**)/vadd2I→**paddd(UseAVX==0)/vpaddd(UseAVX>0)**(:6325-6345);"5-10% penalty"无源码依据删除
> - **"相邻内存检测 same base stride=4" 半对**: pack 寻找=同 base 连续偏移的 Load/Store 打包(combine_packs),非简单等差检测;对齐=align_initial_loop_index+pre-loop 保证
> - **superword.cpp 5218 行** ✓;**SuperWordLoopUnrollAnalysis x86_64 默认 true**(c2_globals_x86.hpp:84,unrolling_analysis :194);**UseSuperWord product 默认 true**(c2_globals.hpp:333)
> - **实证**: 计算密集循环(C1 慢 3.7 倍/-XX:-UseSuperWord +59%/-XX:LoopUnrollLimit=1 +70%,-Xbatch 超长运行)/OSR 事件/CITime IdealLoop 0.006s;TraceSuperWord notproduct(:348)/TraceLoopOpts develop(:228) 不可用


场景: `a[i] = b[i] + c[i]; a[i+1] = b[i+1] + c[i+1];` 循环展开后出现 4 对重复的 Load-Add-Store。SuperWord 识别相邻内存访问→组合为 128-bit 向量操作。

**SuperWord::transform_loop** (`superword.cpp:97-150`):
```
SuperWord::transform_loop(lpt):
  → 扫描 loop body 的 LoadNode/StoreNode——找相邻内存访问(same base, stride=4)
  → construct_bb() → 构建 SuperWord DAG
  → combine_packs() → 4 个 LoadI→1 个 LoadV (128-bit)
  → 4 个 AddI→1 个 AddVI (vector add)
  → 4 个 StoreI→1 个 StoreV
  → output() — 输出 x86 SSE/AVX 机器指令
[C++: superword.cpp:5218行——SLP(SIMD) 是 C2 最高级优化——从标量循环自动产生向量代码]
[x86: LoadV→movdqa(VectorXd)/vmovdqu(Unaligned), AddVI→paddd/psubd/vpaddd]
```
- 源码: `superword.cpp:97-150` (transform_loop) + `superword.cpp:2282-2320` (output → emit x86)

- 关键设计: **相邻内存检测**——所有 LoadNode 的 base+offset 构成等差数列(stride=4)→可组合为一次 16-byte load。**alignment 检查**——如果 base%16≠0 则用 misaligned load(vmovdqu→性能 penalty 5-10%)。`SuperWordLoopUnrollAnalysis` flag——真→C2 先做 loop unroll analysis 再决定 SLP 是否可行。

---

### 核心悬念

**"C2 循环: IdealLoopTree 识别→Unrolling 展开减少 branch→Range Check Predicate 提升到循环外→Strip Mining 处理尾部剩余→SuperWord SLP 自动向量化 128/256-bit SSE/AVX。"** — 下一篇: Chaitin——图着色寄存器分配 O(n²)。

> → [05-c2-register-alloc.md](05-c2-register-alloc.md)
