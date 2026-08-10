# 04. C2 Loops — LoopNode + unrolling + SuperWord SIMD

> 🔴 Deep | 16 KP 中的 2 个核心机制
> 读者处境: `for(i=0;i<N;i++) arr[i]++`——最频繁的 CPU 时间在这里。C2 做 loop unrolling (拆 4 次 body)、range check predicate、SuperWord SIMD 向量化。

### 1. PhaseIdealLoop — Loop 优化器

场景: C2 parse 后 graph 包含 `CountedLoop` (有 init/stride/limit 的 for 循环)。PhaseIdealLoop::build_and_optimize()——对每个 loop 做 unrolling/unswitching/predicate/strip mining。

**Loop 优化器** (`loopnode.cpp + loopopts.cpp`):
- `PhaseIdealLoop::build_and_optimize()`: 找到所有 `CountedLoop`→遍历→`do_unroll(loop, unroll_factor)`→`do_unswitch(loop)`→`do_range_check_predicate(loop)`→`do_strip_mine(loop)→`do_peeling(loop)`
- Loop unrolling: unroll_factor——默认 4——loop body 重复 4 次——4 次 iterations→1 iteration body——4x 吞吐——减少 branch count
- [C++: `PhaseIdealLoop::policy_unroll(CountedLoopNode*)`——检查: loop body instruction count < `LoopUnrollLimit` (默认 200)——trip_count 是否已知→decide unroll_factor。Small loop→full unroll (eliminate loop completely)。Large loop→partial unroll (4x)]
- Loop unswitching: invariant condition (loop 内不变)——`if (flag) { ... } else { ... }`——flag 在 loop 外已知→将 if 提到 loop 外——loop switch→两个 loop 版本 (fast/slow)

**Range Check Predicate** (`loopPredicate.cpp`):
- 场景: `for(i=0;i<arr.length;i++) arr[i]++`——每次迭代 check `i<arr.length`。C2 证明: loop init i=0, stride=+1, limit=arr.length——因为 `i` 单调递增+limit 是 arr.length——数组访问 `arr[i]` 在范围内——可以消除 check
- `PhaseIdealLoop::rc_predicate(IdealLoopTree*, Node*, Node*, ...)`: 在循环入口设 predicate——`if (i < arr.length)`——如果 predicate true→进入 fast loop (无 bounds check)→false→slow loop (有 bounds check)→消除 main loop 的 check

### 2. SuperWord — SIMD 向量化

**SuperWord** (`superword.cpp` (5218行)):
- SLP (Superword Level Parallelism): 并行化 loop 内的 scalar 操作→识别连续内存访问→pack 为 vector operations
- 步骤: `find_adjacent_refs()`→找一对连续内存访问 (arr[i], arr[i+1])→扩展到 4-8 pairs→`extend_packlist()`→形成 vector pack→`combine_packs()`→合并同宽度的 packs→`implement()`→用 x86 SIMD 指令替代
- [C++: `SuperWord::output()`——生成 vector Node——`VectorNode` (LoadVector/StoreVector/AddVF/MulVF...)——宽度 128-bit (SSE, 4×int) 或 256-bit (AVX, 8×int) 或 512-bit (AVX-512, 16×int)。对应 x86: vmovdqu/vaddd/vmulps——由 Assembler domain 02 生成]
- [C++: SuperWord 的限制——只处理简单循环 (increment counter)——memory access 必须 aligned (8/16/32B)——interleaving patterns 检查——浮点操作比整数更容易 vectorize (fadd→vaddss)]
- `memops_aligned`: memory alignment——如果 base address 已知 aligned→可以 load/store aligned (vmovdqa vs vmovdqu) aligned 更快

---

### 核心悬念

**"Loop unrolling (4x body)+predicate (消除 bounds check)→SuperWord SIMD (4 int adds→1 vaddd)。"** — C2 的 loop 优化深度远超过 C1——C1 不做 unroll/predicate/SIMD——之所以快——牺牲优化。下一篇: Chaitin 图着色寄存器分配。

> → [05-c2-register-alloc.md](05-c2-register-alloc.md)
