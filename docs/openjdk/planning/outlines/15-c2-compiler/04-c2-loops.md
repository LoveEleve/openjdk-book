# 04. Loop Optimization + SuperWord — 循环变换与向量化

> 🔴 Deep | LoopNode unrolling + Range Check Elimination + SIMD
> 读者处境: `for (int i = 0; i < 1000; i++) a[i] = b[i] + c[i];` — C2 将这个简单循环转变为什么？Loop unrolling 展开 4 次减少 branch、Range Check Predicate 将 bounds check 提升到循环外、SuperWord 自动向量化——4 个 int→1 个 SSE 128-bit ADDPS。

### 1. "IdealLoopTree — 循环识别与构建"

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
