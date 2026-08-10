# 07. PhaseMacroExpand — 高层→低层展开

> 🔴 Deep | scalar replacement + lock coarsening + allocation elimination

场景: EA 说了 `Point p = new Point(x,y)` NoEscape——AllocateNode→MacroExpand→消除——field per local variable。`synchronized(obj) { synchronized(obj) { ... } }`→lock coarsen——两个 lock→一个。

### 1. Scalar Replacement

`PhaseMacroExpand::scalar_replacement(AllocateNode*, SafePointNode*)`: AllocateNode→SafePointNode 在这。NoEscape→不分配堆对象→拆为 per-field local vars。LoadField→read local。StoreField→write local。**完全消除**: heap alloc+GC+write barrier+memory load。

### 2. Lock Coarsening + ArrayCopy

`macro.cpp`: `PhaseMacroExpand::eliminate_locking_nodes(AbstractLockNode*)`——coarsen。`macroArrayCopy.cpp`: `ArrayCopyNode`→`PhaseMacroExpand::expand_arraycopy_node()`→memcpy intrinsic。

---

### 核心悬念

**"Scalar replacement: 堆分配→local vars——完全消除 GC。"** — 下一篇: library_call.cpp。

> → [08-c2-library-calls.md](08-c2-library-calls.md)
