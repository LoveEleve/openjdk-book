# 域 15: C2 Compiler — 知识规划

> 源码路径: hotspot/share/opto/ + hotspot/cpu/x86/c2_* + cpu/x86/*.ad | 源码量: ~136 文件 / ~176,573 行 | 🔴 巨型域 (JVM 最大单个域)
> 拆 8 篇独立知识规划

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| type.hpp.cpp | **Type — C2 类型系统**: TypeInt/TypeLong/TypePtr/TypeOopPtr/TypeKlassPtr/..., meet/join 操作, Type::TOP/BOTTOM lattice | High |
| node.hpp.cpp + mulnode.hpp/cfgnode.hpp/... | **Node — Ideal Graph 节点**: 基类 Node, def-use edges, Opcode, Ideal() 优化 hook, Value() 类型推导, Identity() 化简 | High |
| parse1.cpp + parse2.cpp + parse3.cpp | **Parse — 字节码→Ideal Graph**: 逐 bytecode→Node 构建, GraphKit (node factory), do_call/do_field/do_array, inline decision | High |
| graphKit.cpp.hpp | **GraphKit — 图构建工具**: 安全点/异常/OopMap/JVMState/control edge | High |
| phaseX.cpp.hpp + igvn.cpp.hpp | **IGVN — 迭代全局值编号**: Idealize() + Value() + Identity() 三环, IGVN::transform() 迭代, dead code elimination | High |
| gvn.cpp.hpp | **GVN — 全局值编号**: value numbering, set_type, hash_find_insert | High |
| loopnode.cpp.hpp + loopopts.cpp + loopTransform.cpp + loopUnswitch.cpp + loopPredicate.cpp | **Loop 优化**: LoopNode, loop unrolling, loop unswitching, range check predicate, loop strip mining | High |
| escape.cpp.hpp | **Escape Analysis — 逃逸分析**: ConnectionGraph (比 C1 的 bcEscapeAnalyzer 更精确), scalar replacement, LockElision, allocation elimination | High |
| cfgnode.hpp + connode.cpp + divnode.cpp + ... | **CFG + Arithmetic 节点**: IfNode/CallNode/ReturnNode/SafePointNode, AddNode/SubNode/MulNode/DivNode/LShiftNode/RShiftNode/URShiftNode/AndNode/OrNode/XorNode/NegNode/SqrtNode | High |
| chaitin.hpp.cpp + ifg.cpp + coalesce.cpp | **Chaitin — 图着色寄存器分配**: IFG (Interference Graph), Chaitin-Briggs algorithm, bias coloring, split/spill | High |
| matcher.cpp + output.cpp + block.cpp + gcm.cpp | **Matcher — 模式匹配**: AD files→machine-specific DFA matcher, instruction selection, register VM | High |
| macro.hpp.cpp + macroArrayCopy.cpp + callnode.cpp | **Macro Expansion — 宏展开**: PhaseMacroExpand, scalar replacement, lock coarsening, allocation elimination, arraycopy optimization | High |
| compile.hpp.cpp | **Compile — C2 编译入口**: Compile constructor, Phase hook chain, time statistics | High |
| library_call.cpp (6991行!) | **Library Call Intrinsics**: library_call.cpp——最大的 C2 源文件——所有 intrinsic (String/Thread/Math/Unsafe/...) 的 idealization | High |
| superword.cpp.cpp (5218行) | **SuperWord — SIMD 向量化**: Auto-vectorization, SLP (Superword Level Parallelism), loop unrolling for vector length | High |
| memnode.cpp + loadnode.cpp + storenode.cpp | **Memory 节点**: LoadNode/StoreNode/MergeMemNode——memory graph, alias analysis, memory ordering | High |

*16 个知识点*

## 02 深度分类

### 🔴 Deep — 核心设计决策 (6 KP)
| KP | 为什么🔴 |
|----|---------|
| Ideal Graph (Node + Type) | C2 的核心 IR——`Value()` 返回类型 lattice, `Ideal()` 返回优化后的节点, `Identity()` 做代数化简。Node 的 `_in/_out` def-use edges 形成 sea-of-nodes——区别于 C1 的 basic block based IR |
| IGVN — 迭代优化 | `PhaseIterGVN::transform()`——反复调 `Ideal()+Value()+Identity()`——直到 fixpoint。每轮可能 create/delete nodes。迭代——vs C1 的 single-pass (多趟规范化)——C2 的效果深得多 |
| Parse + GraphKit — 字节码→Ideal | 字节码→Ideal 比 C1 复杂得多——Inline (call tree)→GraphKit 提供 node factory→Cal graph construction 递归 |
| Chaitin Register Allocation — 图着色 | C2 的寄存器分配——O(n²) graph coloring (IFG)——比 C1 的 linear scan O(n) 精确得多——但慢得多——适合 C2 优化编译 (秒级) |
| Escape Analysis — 逃逸+标量替换 | C2 的 EA 比 C1 的 bcEscapeAnalyzer 精确得多——ConnectionGraph+NFL (No Field Loads)—能 eliminate field loads+内存分配+锁 |
| Macro Expansion — 优化降层 | PhaseMacroExpand——把高层的 LockNode/AllocateNode/ArrayCopyNode 展开为 lower-level 节点——EA 消除为标量, lock coarsening 减少同步 |

### 🟡 Working — 有设计但非核心 (5 KP)
| KP | 说明 |
|----|------|
| Type System — meet/join | Type lattice 的数学基础 |
| Matcher — 指令选择 | ADL→DFA→x86 指令 |
| SuperWord — SIMD 向量化 | 自动向量化 |
| Loop optimization — unrolling/predicate | 循环体优化 |
| Library calls — intrinsics | 7000 行 intrinsic idealization |

### 🟢 Surface — 了解即可 (5 KP)
| KP | 说明 |
|----|------|
| CFG/Arithmetic 节点 | 标准节点定义 |
| Node::Identity 化简 | 代数化简 |
| Memory 节点 | memory graph |
| Compile 入口 | 全流程调度 |
| Block scheduling — GCM | 全局调度 |

## 03 聚类 — 教学顺序与文章拆分

### 教学顺序

```
1. C2 IR — Ideal Graph (Node + Type + IGVN)
2. Parse — 字节码→Ideal (Parse + GraphKit)
3. Optimization — GVN + IGVN + CCP + Escape Analysis
4. Loop — LoopNode + unrolling + predicate + vectorization
5. Register — Chaitin (IFG + coalesce + split)
6. Code Gen — Matcher (ADL→DFA→x86) + output
7. Macro — PhaseMacroExpand + intrinsics
8. Library Calls — library_call.cpp (String/Math/Unsafe/...)
```

### 文章拆分建议

8 篇 (巨型域 ~177K行):

- **01-c2-ideal-graph.md** — Ideal Graph (Node/Type/IGVN/GVN)
- **02-c2-parse-graphkit.md** — Parse (字节码→Ideal) + GraphKit
- **03-c2-optimizations.md** — GVN/IGVN/CCP/Escape Analysis
- **04-c2-loops.md** — LoopNode/loopopts/superword
- **05-c2-register-alloc.md** — Chaitin/IFG/coalesce
- **06-c2-codegen.md** — Matcher/ADL/output/block scheduling
- **07-c2-macro-intrinsics.md** — PhaseMacroExpand + scalar replacement
- **08-c2-library-calls.md** — library_call.cpp (String/Math/Unsafe intrinsics)
