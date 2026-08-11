# 07. PhaseMacroExpand — 高层抽象→低层 MachNode 展开

> 🔴 Deep | Scalar Replacement + Lock Coarsening + Allocation Elimination
> 读者处境: EA 分析完毕后——AllocateNode(NoEscape)→Scalar Replacement 消除堆分配→拆为 per-field local vars。LockNode(嵌套 synchronized)→Coarsening 合并。AllocateArray→ArrayCopy→intrinsic memcpy。PhaseMacroExpand 是 C2 **优化→代码生成的最后一步**——在此之后 graph 只有纯 MachNode(可直接 emit 机码)。

### 1. "Scalar Replacement — 堆分配→local vars"

场景: `Point p = new Point(3, 4); return p.x + p.y;` — EA=NoEscape→PhaseMacroExpand 将 AllocateNode+InitializeNode 消除→`p.x` 还原为 ConI(3)→`p.y` 还原为 ConI(4)→`return 3+4→7`。**完全消除**: heap alloc + GC write barrier(VMOopStore) + memory load(LoadField)。

**PhaseMacroExpand::scalar_replacement** (`macro.cpp:100-400`):
```
PhaseMacroExpand::scalar_replacement(AllocateNode* alloc, SafePointNode* sfpt):
  → 检查 EA result: 如果 alloc->_is_scalar_replaceable == true
  → 遍历 alloc 的所有 SafePoint uses(InitializeNode 后的 field stores)
  → 对每个 Field Store: 创建 local SafePointScalarObjectNode → 记录 field→value 映射
  → 对每个 Field Load: 替换为 local value(SafePointScalarObjectNode->field(n))
  → 删除 alloc + init nodes → 消除 heap allocation
[C++: macro.cpp:2778行——scalar replacement 消除 Java 堆分配——转为 C2 local/register]
[x86: 消除后——field load→register load(movl reg,reg)——无内存访问——2-4x 加速]
```
- 源码: `macro.cpp:100-400` (scalar_replacement) + `macro.cpp:2645-2700` (expand_macro_nodes 主循环)

- 关键设计: **消除的是整个分配生命周期**——不只是 `new` 指令——还有 GC write barrier(`card mark` 操作 `movb $0, card_table[addr>>9]`)、内存 load(LoadField→`movl mem,reg` 现在变 `movl reg,reg`)。**SafePointScalarObjectNode** 在 safepoint 保留 field 的 current values——GC 仍可 trace 这些值(栈扫描)。

### 2. "Lock Coarsening — 嵌套 synchronized→合并为单锁"

场景: `synchronized(obj) { synchronized(obj) { doWork(); } }`——C1 产生两个 FastLockNode+两个 FastUnlockNode。C2 EA 分析: obj NoEscape→LockNode 可合并——内层 lock 与外层 lock 合并为一个。

**PhaseMacroExpand::eliminate_locking_nodes** (`macro.cpp:500-800`):
```
PhaseMacroExpand::eliminate_locking_nodes(AbstractLockNode* alock):
  → 检查 EA result: lock->_is_coarsenable
  → 扫描 nesting: if 外层 LockNode 已存在→内层 LockNode 消除(no-op)
  → Coarsened lock: 两个 FastLockNode→一个 CoarsenedLockNode
  → 展开: CoarsenedLockNode→FastLockNode + cmpxchg(biased locking) 或 CAS(thin lock)
[C++: macro.cpp:500-800——lock coarsening 消除嵌套 synchronized 的重复 lock 开销]
[x86: FastLockNode→lock cmpxchg(mark word CAS)→FastUnlockNode→mov qword(mark word, 0)]
```
- 源码: `macro.cpp:500-700` (eliminate_locking_nodes) + `macro.cpp:700-900` (expand_lock_node → CAS/biased)

- 关键设计: **Coarsening 的条件**: obj NoEscape(方法内)+ 两个 LockNode 嵌套+ 之间无 safepoint。如果 obj ArgEscape→不能 coarsen(其他线程可能也在 lock)。**Biased Locking** 在展开阶段处理——mark word 的 bias pattern 检测→快速路径(不 CAS)vs 慢路径(CAS to unbias)。

### 3. "ArrayCopy Expansion — from AllocateArray to memcpy"

场景: `System.arraycopy(src,0,dst,0,len)` → IGVN→LibraryCallKit::inline_arraycopy→ArrayCopyNode(copy type: disjoint/conjoint)。PhaseMacroExpand→ArrayCopyNode→`memcpy` intrinsic(rep movsq for x86) 或 分块 copy loop。

**PhaseMacroExpand::expand_arraycopy_node** (`macroArrayCopy.cpp:50-300`):
```
PhaseMacroExpand::expand_arraycopy_node(ArrayCopyNode* ac):
  → 检查 array type: object[] vs byte[] vs char[] vs int[]
  → 选择实现: small len→unrolled loop, large len→rep movsq(memcpy)
  → 生成 MachNode: LoadI→StoreI 或 MachMemCopyNode→rep movsq
  → 插入 bounds check: if (src_off+len > src_len) goto slow_path
[C++: macroArrayCopy.cpp——arraycopy 的展开策略基于 copy length→分 3 层(short/medium/long)]
[x86: rep movsq→RCX=count, RSI=src, RDI=dst→microcoded copy——快于 manual loop for >128B]
```
- 源码: `macroArrayCopy.cpp:50-200` (expand_arraycopy_node) + `macro.cpp:2000-2200` (AllocateArray→scalar replacement or real alloc)

- 关键设计: **Copy Type 判断**: `disjoint`(src 和 dst 不重叠)→全速 memcpy; `conjoint`(重叠)→先决定 copy 方向(forward/backward)避免覆盖。**Object arrays** 需要 write barrier(每个元素→card mark)→不能直接用 rep movsq→每个元素手动 copy。

---

### 核心悬念

**"PhaseMacroExpand: Scalar Replacement(堆分配→local vars, 消除 GC barrier)→Lock Coarsening(嵌套 synchronized→单锁, 消除重复 CAS)→ArrayCopy Expansion(AllocateArray→rep movsq intrinsic)。这是 C2 优化 pipeline 的最后一环——从此之后 graph 只有纯 MachNode→Output 直接 emit 机码。"** — 下一篇: library_call.cpp——6991 行的 intrinsic 集成。

> → [08-c2-library-calls.md](08-c2-library-calls.md)
