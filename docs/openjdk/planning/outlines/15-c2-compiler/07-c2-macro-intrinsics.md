# 07. PhaseMacroExpand — 高层抽象→低层 MachNode 展开

> 🔴 Deep | Scalar Replacement + Lock Coarsening + Allocation Elimination
> 读者处境: EA 分析完毕后——AllocateNode(NoEscape)→Scalar Replacement 消除堆分配→拆为 per-field local vars。LockNode(嵌套 synchronized)→Coarsening 合并。AllocateArray→ArrayCopy→intrinsic memcpy。PhaseMacroExpand 是 C2 **优化→代码生成的最后一步**——在此之后 graph 只有纯 MachNode(可直接 emit 机码)。

### 1. "Scalar Replacement — 堆分配→local vars"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/07 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"scalar_replacement (macro.cpp:100-400)" 行号错(重要)**: 真实 **macro.cpp:759**(03 篇已引用);mechanism 03 篇已详拆(eliminate_allocate_node 四道门 :1091→scalar_replacement→process_users_of_allocation store 删除+屏障消除),本篇聚焦 expand 侧
> - **"对每个 Field Store 创建 SafePointScalarObjectNode→记录 field→value 映射" 半对**: SafePointScalarObjectNode(callnode.hpp:492-503)是**安全点/deopt 数据**载体(_first_index/_n_fields,注释 "states of the scalarized object fields are collected"),不是字段替换的通用机制;字段 load/store 的替换=split_unique_types(03 篇)+IGVN
> - **"消除 GC write barrier+memory load"** ✓(process_users_of_allocation :946+eliminate_gc_barrier,03 篇已证)
> - **"field load→register load 2-4x 加速" 无据**: 删
> - **macro.cpp 2778 行** ✓;**expand_macro_nodes 编排(重要)**: :2645: 最后消除(:2647)→节点预算 macro_count*300(:2653,注释 "Worst case...about 200 nodes")→Opaque/LoopLimit/MaxL-MinL→CMoveL 清理(:2656-2721)→**arraycopy 先行**(:2723-2740,注释 "For ReduceBulkZeroing...before the allocate nodes are expanded")→主循环(:2744-2771 expand_allocate(:1981)/expand_allocate_array(:1987)/expand_lock_node(:2259)/expand_unlock_node(:2497))→_igvn.optimize+BarrierSet(:2773-2777)
> - **expand_allocate_common(:1286)**: fast/slow Region 合并+initial_slow_test(too-big,dtrace/!UseTLAB 强制慢 :1321-1326)+TLAB bump 快路径——与 14-c1/04 Runtime1 同构;-XX:-UseTLAB 间接观察


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
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/07 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"eliminate_locking_nodes (macro.cpp:500-800)" 函数名错+行号错(重要)**: 真实 **eliminate_locking_node(单数)(macro.cpp:2182)**——is_eliminated() 检查(标记来自 EA non_esc_obj,03 篇)+连 MemBarAcquireLock/ReleaseLock 一起删(:2223-2236/:2240-2250)+FastLock 唯一用户删除(:2232-2236);mark_eliminated_locking_nodes(:2577)
> - **"CoarsenedLockNode→cmpxchg(biased)或 CAS" 无据(重要)**: 展开产物=**fast_lock_region+slow_path 分支结构**(expand_lock_node :2259,:2266-2272 有偏锁模式检测快速路径),不是直接发 cmpxchg;真正发码在运行时/汇编 stub(23-stub 域 SharedRuntime 锁助手)
> - **"嵌套 synchronized 合并为单锁" 偏**: 嵌套锁主要靠**消除**(对象不逃逸全消,is_eliminated);"coarsening"=mark_eliminated_locking_nodes 对合并锁标记再处理,非"两个 FastLockNode 合并成一个"
> - **"expand_lock_node (macro.cpp:700-900)" 行号错**: :2259


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
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/07 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"expand_arraycopy_node (macroArrayCopy.cpp:50-300)" 行号错(重要)**: 真实 **macroArrayCopy.cpp:1106**;generate_arraycopy :278;文件 1308 行
> - **"small len→unrolled loop, large len→rep movsq" 简化**: 分派=generate_arraycopy 内部按类型/形态(clonebasic→clone_at_expansion/copyof-cloneoop 带屏障/arraycopy 编译期检查 :1154-1157 "Compile time checks...we do not make a fast path for this call"+disjoint/conjoint 特化);大块拷贝实现在 23-stub 域 stub 生成器(向量拷贝循环,23-stub/02 已拆;JDK11 x86_64 用向量循环非 rep movsq)
> - **"插入 bounds check goto slow_path" 半对**: 编译期静态检查+运行时检查;慢路径=保留原调用
> - **"Object arrays write barrier 不能 rep movsq"** ✓ 方向对(对象数组拷贝带屏障)
> - **"AllocateArray→scalar replacement or real alloc (macro.cpp:2000-2200)" 行号错**: expand_allocate_array :1987;AllocateArray 消除也在 eliminate_allocate_node(:1091,is_AllocateArray 分支 :2610-2612)
> - **实证**: PrintInlining 显示 System.arraycopy→intrinsic(素材第 1 段);CITime Macro Expand 阶段(素材第 2 段);PrintEliminateLocks notproduct(c2_globals.hpp:508)/ReduceBulkZeroing product(:263)


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
