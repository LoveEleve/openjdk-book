Write comprehensive 05-jit-compiler/README.md from scratch. Target: 600+ lines. This is the MOST COMPLEX phase — Sea of Nodes IR, Chaitin coloring, escape analysis — and the LEAST beginner-friendly by nature. It must be the most carefully crafted README in the entire series.

## Phase context (continuity MUST be explicit)
The reader just finished 04-interpreter. They know:
- How bytecodes are dispatched (256-entry jump table, O(1))
- How the interpreter triggers JIT (InvocationCounter + BackEdgeCounter → CompileBroker)
- How CP cache accelerates invokevirtual (Uninitialized→Resolved→Virtual)

05 must answer: "Now that the interpreter has decided 'compile this method', what ACTUALLY happens? How does a sequence of bytecodes become a sequence of x86 instructions that runs 100× faster?"

## Source material (read first)
- Current README: probe_md/libjvm-analysis/05-jit-compiler/README.md (82 lines — preserve all technical content: §一 compiler hierarchy, §二 compilation trigger flow, §三 C2 8-phase table, §四 probe coverage)
- Source indexes: source_index/07-compiler.md (24 files), source_index/14-opto.md (129 files), source_index/13-c1.md (49 files), source_index/15-ci.md (74 files)

## Templates (study format)
probe_md/libjvm-analysis/04-interpreter/README.md (528 lines, 11 sections) — the best README for structure
probe_md/libjvm-analysis/03-object-model/README.md — the best README for interview table format

---

## §〇 上手指南

### 0.1 本文档适合谁？

| 水平 | 特征 | 建议路径 |
|------|------|---------|
| 🟢 初级 | 知道 JIT 是"让 Java 变快的东西"，不知道内部怎么工作的 | 本节 → 01-Pipeline §一~§三 |
| 🟡 中级 | 理解 tiered compilation 和 CompileThreshold，想深入 C2 内部 | 01 全篇 → 02-Inline → 05-Deopt |
| 🔴 高级 | 读过 C2 源码，需要完整的 8 阶段参考手册 | 直接按需查阅各文档 §对应阶段 |

### 0.2 你需要什么基础？

| 必须 | 可选但更好 |
|------|-----------|
| 完成 04-interpreter 入门路径（知道字节码 dispatch + counter + JIT trigger） | 读过 Compiler Design 入门（知道什么是 IR / register allocation） |
| 理解"编译器把源代码翻译成机器码"的基本概念 | 了解图论基础（什么是 node / edge / DAG） |
| 能读 C++ 源码（pointer / virtual function / template） | 了解 x86 汇编基础（mov / add / cmp / jmp） |

### 0.3 JIT 编译的本质（三句话）

> 解释器一条条读字节码执行。C2 怎么做？

```
字节码序列 → Parse 阶段 → Ideal Graph (Sea of Nodes) → 8 个优化 Pass → 最后生成 x86 指令
```

C2 不是"看着字节码一条一条翻译"。它是：

1. **转成图**（0~5ms）：把 100 条字节码转化成一个包含 500+ 个 Node 的数据流图——每个 Node 代表一个操作（load / add / if）
2. **优化图**（5~80ms）：消除重复计算（4 次 load 合并为 1 次）、消除不必要的分配（逃逸分析发现对象不逃逸 → 栈上分配标量）、消除不执行的代码（死代码消除）
3. **输出机器码**（80~100ms）：把优化后的图映射到 x86 指令——哪个 Node 用哪个寄存器、哪个 Node 可以去掉（instruction selection）

**100 条字节码 → 500 个 Node → 优化后 200 个 Node → 10 条 x86 指令。这就是为什么 JIT 编译后能快 100 倍。**

### 0.4 核心术语速查表

| 术语 | 一句话解释 | 出现位置 |
|------|----------|---------|
| **Sea of Nodes** | C2 的中间表示——没有控制流，只有数据依赖边 + 控制依赖边。所有操作都可以自由浮动直到被固定 | 01-Pipeline §二 |
| **Node** | Ideal Graph 的基本单元——每个 Node 代表一个操作（AddI / LoadI / If / CallStaticJava） | 01 §二 |
| **GVN** (Global Value Numbering) | 消除重复计算——如果两个 AddINode 的操作数相同 → 合并为一个 | 01 §三 |
| **IGVN** (Iterative GVN) | GVN 的增强版——反复应用直到收敛。触发更多优化（AddI(0,x) → x） | 01 §三 |
| **InlineTree** | 内联决策树——caller → callee → callee 的 callee，递归决策 | 02-Inline |
| **CHA** (Class Hierarchy Analysis) | 运行时类的层次结构分析——如果只有一个子类 → invokevirtual 可以单态调用 | 02 |
| **Chaitin Register Allocation** | 将虚拟寄存器（∞个）映射到物理寄存器（16 个 x86_64 GPR）的着色算法 | 03-RegAlloc |
| **Live Range** | 一个值从"被定义"到"最后一次被使用"的区间——两个 Live Range 重叠 → 不能共享寄存器 → 可能 spill | 03 |
| **CodeCache** | JVM 存放所有编译后机器码的内存区域——默认 240MB（tiered） | 04-CodeCache |
| **nmethod** | 编译后的 Java 方法——包含 machine code + metadata (OopMap, ExceptionCache, deopt info) | 04 |
| **Uncommon Trap** | 优化假设被打破 → 触发去优化 → 从编译代码跳回解释器 | 05-Deopt |
| **OopMap** | 记录"编译器把哪些寄存器/栈位置存储了对象指针"——GC 需要这个来找到所有 live oop | 06-OopMap |
| **Deoptimization** | 从编译代码回退到解释器——栈帧重建，从 deopt point 继续解释执行 | 05 |

### 0.5 如何阅读本文档？三条路径

**🟢 入门路径** (2-3 小时):
```
1. README 本节（你在这里）
2. 01-Pipeline §一~§三（C2 8 阶段概览 → 建立"字节码怎么变成机器码"的认知）
3. 02-Inline §一~§二（内联为什么是 JIT 最重要的优化 → 不内联的代价）
4. 05-Deopt §一（去优化是什么 → 为什么 Java 能"回退"到解释器）
5. 06-OopMap §一（GC 怎么找到编译代码中的对象引用 → JIT 和 GC 的协作）
```

**🟡 进阶路径** (5-8 小时):
```
6. 01-Pipeline §四~§八（C2 完整 8 阶段深度走读）
7. 02-Inline §三~§五（InlineTree 递归决策 + CHA + inline policy）
8. 03-RegAlloc §一~§四（Chaitin 着色算法实现）
9. 04-CodeCache §一~§四（nmethod 生命周期 + Sweeper 策略）
10. 05-Deopt §二~§四（frame rebuild + interpreter re-entry + uncommon trap 逻辑）
```

**🔴 专家路径**（按需查阅）:
| 你想了解 | 直接看 |
|---------|--------|
| C2 的 Parse 阶段怎么把字节码转成 Node 的 | 01-Pipeline §二 |
| InlineTree 怎么决定"多深算深" | 02-Inline §三 |
| Chaitin 着色算法在 x86_64 上的实现 | 03-RegAlloc §三 |
| CodeCache 满了怎么办 | 04-CodeCache §三 |

### 0.6 环境准备
```bash
# JIT 编译日志（看到哪些方法被编译了）
java -XX:+PrintCompilation -XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining Demo

# 查看编译后的汇编代码
java -XX:+PrintAssembly -XX:+UnlockDiagnosticVMOptions Demo

# GDB 调试 C2 编译
gdb --args build/.../java -XX:+PrintCompilation -Xcomp Demo
(gdb) break CompileBroker::compile_method
(gdb) break PhaseIdealLoop::build_and_optimize
```

---

## §一 编译器体系（expand current §一）

Preserve the existing C1/C2/JVMCI ASCII tree and C2 8-phase table. ADD:

### CompileBroker → CompileQueue → CompilerThread lifecycle
```
JavaThread (interpreter) → frequency_counter_overflow()
  → CompileBroker::compile_method(method, CompLevel_Full_Optimization)
    → CompileTask::CompileTask(method, compile_id, osr_bci)
    → CompileQueue::add(task)
      → CompilerThread::loop()  [permanently running daemon thread]
        → CompileQueue::get()  [blocks if queue empty]
        → CompileBroker::invoke_compiler_on_method(task)
          → C2Compiler::compile_method()  if level >= CompLevel_Full_Optimization
            → Compile::Compile()  [C2's main entry]
              [— 8 phases —]
            → nmethod = CodeCache::allocate(...)
            → Method::set_code(nmethod)  [atomic swap — next call enters compiled code]
        → CompileTask::set_success()
```

### Tiered Compilation levels
| Level | Compiler | Description |
|:---:|----------|-------------|
| 0 | Interpreter | Pure interpretation, no compilation |
| 1 | C1 no profiling | Fast compile, no profiling data |
| 2 | C1 limited profiling | C1 with invocation+backedge counters only |
| 3 | C1 full profiling | C1 with full profile (type profile, branch profile) |
| 4 | C2 | Full optimization with profile data from L2/L3 |

Why tiered? C2 takes 80-100ms to compile a method. C1 takes 5-10ms. Hot methods get C1 first (immediate speedup) → after gathering profiles → C2 recompiles with real data. Cold methods never reach C2.

---

## §二 编译触发（expand current §二）

Preserve existing counter→compile flow. ADD:

### OSR vs Full Compilation
```
Full compilation: method called enough times → compile entire method
OSR (On-Stack Replacement): loop iterates enough times → compile the LOOP BODY only
```

OSR trigger: BackEdgeCounter hits 0 → `CompileBroker::compile_method(method, osr_bci=loop_header_bci)` → C2 generates code that REPLACES the interpreter frame mid-execution → from that point, loop runs compiled code.

### CompileCommand
```
-XX:CompileCommand=exclude,com.example.MyClass::hotMethod  → never compile
-XX:CompileCommand=inline,com.example.MyClass::helper       → force inline
-XX:CompileCommand=compileonly,com.example.MyClass::*       → only compile this
```

---

## §三 完整文件索引（expand current §四）

Preserve probe coverage table. ADD full file index:

| Directory | Files | Purpose |
|-----------|:---:|---------|
| `opto/` | 129 | C2 compiler — all 8 phases |
| `c1/` | 49 | C1 client compiler |
| `compiler/` | 24 | Shared compilation infrastructure |
| `ci/` | 74 | Compiler Interface — JVM → compiler communication |
| `code/` | 50+ | Compiled code management (nmethod, CodeCache, OopMap) |
| `runtime/` | 180+ | Runtime support (deoptimization, vtable stubs) |

### Key files per phase
| Phase | Key file(s) |
|-------|------------|
| Parse | `parse1.cpp`, `parse2.cpp`, `parseHelper.cpp` |
| Ideal/IGVN | `phaseX.cpp`, `loopnode.cpp`, `cfgnode.cpp`, `subnode.cpp` |
| Inline | `doCall.cpp`, `inline.cpp` |
| Escape Analysis | `escape.cpp`, `connectionGraph.cpp` |
| Macro Expansion | `macro.cpp`, `macroArrayCopy.cpp` |
| Matching | `matcher.cpp`, `output.cpp`, `reg_split.cpp` |
| Register Allocation | `chaitin.cpp`, `ifg.cpp`, `coalesce.cpp` |
| Code Generation | `output.cpp`, `block.cpp` |
| Code Installation | `nmethod.cpp`, `codeCache.cpp` |

---

## §四 关键数据结构

| Structure | File | Role |
|-----------|------|------|
| `Compile` | `opto/compile.hpp:52-1153` | C2 compilation context — holds Ideal graph, phase controller, debug info |
| `CompileTask` | `compiler/compileTask.hpp:77-403` | Queue entry — method, compile_id, OSR bci, hotness |
| `CompileQueue` | `compiler/compileBroker.hpp:238-295` | Priority queue — ordered by hotness |
| `Node` | `opto/node.hpp:108-200` | Base class for all Ideal Graph nodes — virtual methods: Ideal, Identity, Value |
| `PhaseGVN` | `opto/phaseX.hpp:218-388` | GVN hash table — maps (opcode, inputs) → unique Node |
| `PhaseIdealLoop` | `opto/loopnode.hpp:1100-1800` | Loop optimization — peeling, unrolling, range check elimination |
| `InlineTree` | `opto/doCall.cpp:54-528` | Recursive inline decision tree — max depth, max size, frequency |
| `PhaseChaitin` | `opto/chaitin.hpp:141-956` | Chaitin register allocator — IFG construction, coloring, spill |
| `nmethod` | `code/nmethod.hpp:28-836` | Compiled method — machine code + metadata + OopMaps + deopt info |
| `OopMap` | `code/oopMap.hpp:82-350` | GC root map — which registers/stack slots hold oop pointers |
| `CodeBlob` | `code/codeBlob.hpp:58-350` | Base class for all compiled code blobs (nmethod, stub, adapter) |
| `CodeCache` | `code/codeCache.hpp:43-140` | Global compiled code storage — heap of CodeBlobs |

---

## §五 探针覆盖（preserve current §四 — complete）

---

## §六 文档计划 (6 docs — expand from current §五)

### Dependency diagram
```
01-Pipeline (foundation — everything flows through C2's 8 phases)
├── 02-Inline (phase 2 — the biggest optimization lever)
├── 03-RegAlloc (phase 6 — register coloring from Ideal graph)
├── 04-CodeCache (post-compilation — where compiled code lives)
├── 05-Deopt (runtime fallback — when optimization assumptions break)
└── 06-OopMap (GC integration — how GC finds roots in compiled code)
```

Writing order: 01 → 02 → 03+04 → 05 → 06

---

## §七 文档逐篇详述

### 01-C2-Pipeline.md

**核心问题**: "C2 怎么把 100 条字节码变成 10 条 x86 指令？8 个阶段各自做什么？"

**生产场景**: "C2 编译 JVM 应用时 SIGSEGV——hs_err 显示 `V [libjvm.so+0x...] PhaseIdealLoop::build_and_optimize`。编译过程中的 bug 导致 JVM 崩溃——如何定位到 C2 的哪个阶段？"

**文档覆盖**:
1. Parse: `GraphKit` 字节码 → `Parse::do_one_bytecode()` → Node 创建（LoadI/StoreI/CallStaticJava/If/CatchNode）
2. Optimize: IGVN hash-consing (实现 `Node::Ideal()` → 恒等优化: `AddI(0,x) → x`, `AndI(x,-1) → x`)
3. Inline: InlineTree 递归决策 → `Compile::optimize_inlining()` (详见 02)
4. IGVN: hash table + worklist → iterate until no more changes
5. Loop Optimization: `PhaseIdealLoop::build_and_optimize()` → loop peeling + unrolling + range check elimination
6. Escape Analysis: ConnectionGraph → stream analysis → scalar replacement
7. Macro Expansion: `PhaseMacroExpand::expand()` → lock → CAS, allocation → TLAB
8. Matching: ADL (Architecture Description Language) file → x86_64.ad → instruction selection patterns
9. Register Allocation: Chaitin coloring (详见 03)
10. Output: `PhaseOutput::install_code()` → `CodeCache::allocate()` → OopMap generation

**关键文件表**: parse1.cpp/phaseX.cpp/loopnode.cpp/escape.cpp/chaitin.cpp/matcher.cpp

**前置**: 04-interpreter (knows bytecode dispatch + JIT trigger)
**回避声明**: "本文不是 C2 源码导读——不讲每个 Node 子类。Sea of Nodes 的理论基础（Click 1995）从简。"

### 02-Inline-Decision.md

**核心问题**: "C2 怎么决定内联还是不内联？内联的好处和代价？"

**生产场景**: "生产 JVM 启动慢 40 秒——-XX:+PrintInlining 显示 C2 在编译一个方法时内联了 2000+ 层。Inline 深度没限制导致单个 nmethod 达到 2MB——CodeCache 装满触发 emergency flushing。"

**文档覆盖**:
1. InlineTree: 递归数据结构的构建过程 → `GraphKit::try_inline()` → `InlineTree::should_inline()`
2. CHA (Class Hierarchy Analysis): `ciKlass::subklass_of()` → 如果只有一个子类 → invokevirtual → 单态调用
3. Inline Policy: `InlineTree::should_inline()` — max depth、max size、frequency、callee hotness 的决策逻辑
4. Late Inline: 在 IGVN 之后补的内联 (`PhaseIdealLoop::do_call()`)
5. Production: inline log 解读 (`(hot)`, `already compiled into a big method`, `callee is too large`)

**关键文件**: doCall.cpp/inline.cpp/ciMethod.cpp

**前置**: 01-Pipeline (knows Parse + Optimize phases)
**回避声明**: "本文不讲 C1 的内联策略。"

### 03-Chaitin-RegAlloc.md

**核心问题**: "C2 的虚拟寄存器怎么映射到 x86_64 的 16 个 GPR？什么时候 spill？"

**生产场景**: "JIT 编译后的代码在 perf 中显示大量 spill/fill mov 指令——C2 在寄存器压力大时 spill 到栈上。这导致编译代码比解释器快不了多少。"

**文档覆盖**:
1. Live Range: 每个 Node 的"从定义到最后一次使用的区间"→ `PhaseLive::compute()` 计算 → `PhaseIFG::PhaseIFG()` 构建干扰图
2. Interference Graph: 如果两个 Node 的 Live Range 重叠 → 连一条边 —— 不能用同一个寄存器
3. Spill Cost: `Node::_cnt` 作为 spill 代价的近似 → 循环内的 Node 有更高的 spill 代价
4. Chaitin Coloring: 迭代着色 → 无法着色（>= 16 个 邻居用满了所有 16 个寄存器）→ 选择 spill → 重新做
5. Coalesce: eliminate moves — `mov r1, r2` → 如果 r1 和 r2 不干扰 → 合并为同一个寄存器 → 直接 `copy`
6. Post-Allocation: `PhaseRegAlloc::fixup_spills()` — 为 spill slot 生成内存操作

**关键文件**: chaitin.cpp/ifg.cpp/coalesce.cpp/live.cpp

**前置**: 01-Pipeline (knows Ideal graph + Matching)

### 04-CodeCache-NMethodSweeper.md

**核心问题**: "编译后的代码存在哪？满了怎么办？没有用的 nmethod 怎么回收？"

**生产场景**: "CodeCache 97% full——CompileBroker 停止接收新的编译请求。热方法卡在解释器中——QPS 暴跌 80%。NMethodSweeper 太慢跟不上。"

**文档覆盖**:
1. CodeCache: 3 段布局——non-profiled(no nmethods), profiled(nmethods with profile data), non-method(adapters+stubs)。每段独立管理。
2. NMethodSweeper: 后台线程——标记未使用的 nmethod → 清空 flush queue → zombie handler → 释放 CodeCache
3. nmethod lifecycle: alive → not_entrant(有新的编译版本) → zombie(所有线程已迁出) → unloaded(类被卸载) → freed

**关键文件**: codeCache.cpp/nmethod.cpp/nmethodSweeper.cpp

**前置**: 01-Pipeline (compiled code goes here) + 03-RegAlloc

### 05-Deoptimization.md

**核心问题**: "C2 的优化假设被打破怎么回退到解释器？栈帧怎么重建？"

**生产场景**: "JIT 编译时假设接收者只有 final class A——后来 loadsClass(B) 首次出现→uncommon trap→去优化。200 次/s 的去优化 → GC 压力 → STW 暂停。"

**文档覆盖**:
1. Frame rebuild: 读取 OopMap → 为每个寄存器/栈 slot 读取 oop → 写入新解释器帧
2. Deoptimization blob: DeoptimizationBlob 的顺序——unpack_uncommon_trap → unpack_reexecute → interpreter re-entry

**关键文件**: deoptimization.cpp/sharedRuntime.cpp

**前置**: 01-Pipeline + 04-CodeCache + 12-cpu-layer (frame layout)

### 06-OopMap-GC-Roots.md

**核心问题**: "GC 怎么知道 JIT 编译后的代码中哪些寄存器/栈位置存储了对象指针？OopMap 怎么生成？"

**生产场景**: "GC 时 JVM crash——hs_err 'bad oop' at 'G1ParScanThreadState::copy_to_survivor'。因为 OopMap 记录的是死对象引用——被优化消除了但 GC 还需要它。"

**文档覆盖**:
1. OopMap 生成: `PhaseOutput::install_code()` → 每个 safepoint 都生成一个 OopMap——记录该点所有 live oop
2. OopMapBlock: 压缩的位掩码——每个栈 slot 1 bit：1 = oop pointer, 0 = non-oop
3. GC stack walking: `frame::oopmapreg_to_locationmap()` → 把 OopMap slot 映射到物理寄存器/栈槽

**关键文件**: oopMap.cpp/oopMap.hpp/codeBlob.cpp

**前置**: 01-Pipeline + 05-Deopt + 12-cpu-layer (register convention)

---

## §八 写作优先级

| Priority | Doc | Why |
|:---:|------|-----|
| **P0** | 01-C2-Pipeline | Foundation — everything flows through C2 |
| **P0** | 02-Inline-Decision | Biggest single optimization lever (can make 10× difference) |
| **P1** | 05-Deoptimization | Connects JIT back to interpreter — the "escape hatch" |
| **P1** | 06-OopMap | Connects JIT to GC — where the two largest subsystems meet |
| **P2** | 03-Chaitin-RegAlloc | Deep but narrow — only matters for compiler engineers |
| **P2** | 04-CodeCache-Sweeper | Important but well-understood by DevOps already |

---

## §九 和已学阶段的对比

| 04-interpreter 概念 | 05-JIT 对应 | 推进 |
|---------------------|-----------|------|
| 256 字节码 dispatch | Parse 阶段：每个字节码创建对应的 Node | 从 "O(1) dispatch" 到 "生成 O(1) 的 x86 指令" |
| TOS 状态机 (编译时类型安全) | C2 的 type flow — Node::bottom_type() 传播类型约束 | 从 "int/float/oop 状态" 到 "full type lattice (top→long→int→bottom)" |
| InvocationCounter → CompileBroker | CompileBroker → CompileQueue → CompilerThread | 从"触发点"到"完整编译管道" |
| Counter decay at safepoint | NMethodSweeper flush at safepoint | 从"计数器衰减"到"编译代码回收" |

| 08-safepoint 概念 | 05-JIT 对应 |
|-------------------|-----------|
| Safepoint poll (testl) | OopMap at safepoint (where GC finds roots in JIT code) |

---

## §十 显式排除（≥8）

| 排除主题 | 原因 |
|---------|------|
| **C1 编译器细节** | C2 是生产服务器编译器——C1 是快速低优化编译器 | 
| **JVMCI / Graal / Truffle** | 外部编译器接口——非 HotSpot 自带 |
| **x86 指令编码细节** | 见 12-cpu-layer |
| **Profile-guided optimization (PGO) 数学** | CI 基础设施——复杂到需要自己的 phase |
| **GC 在 JIT 编译时的交互** | 见 06-gc-memory |
| **IdealGraphVisualizer** | 工具文档——不是 JVM 内部 |
| **Chaitin 算法的数学证明** | 工程文档——不是理论论文 |
| **Interpreter-only mode 比较** | 04-interpreter 已覆盖 |
| **Bytecode 层级优化（提前编译器）** | Jaotc/jaotc-tiered — 属于部署工具 |
| **MethodHandle / Lambda 的内联路径** | 01-jvm-startup 和 09-native-interface 覆盖 |

---

## §十一 深度问题（≥15 题，每题从第一性原理出发）

### Tier 1: C2 架构
1. "如果你设计一个 JIT 编译器，你会用一个统一的 IR 还是多层次的 IR？C2 为什么只用一种 IR（Sea of Nodes）？→ 01 §二"
2. "Sea of Nodes 为什么没有控制流？没有控制流怎么表示 if/else 的顺序？→ 01 §二"
3. "C2 的 8 个阶段为什么是这个顺序？如果把 Escape Analysis 放在 IGVN 之前会怎样？→ 01 §三"

### Tier 2: 内联
4. "内联为什么是 JIT 最重要的优化？不内联的代码和内联后的代码差多少条指令？→ 02 §一"
5. "C2 怎么决定 '内联太深了要停止'？InlineTree 的 max_desired_size 和 frequency 是怎么 trade-off 的？→ 02 §三"
6. "CHA (Class Hierarchy Analysis) 和 Profiling (type profile from L2) 在内联决策中各起什么作用？哪个更可信？→ 02 §二"

### Tier 3: 寄存器分配
7. "Chaitin 着色算法为什么会 spill？什么情况下 spill 是理论上不可避免的？→ 03 §四"
8. "为什么 x86_64 只有 16 个 GPR 但对大多数方法已经够了？Chaitin 的'小寄存器集'假设在 RISC/ARM 上成立吗？→ 03 §三"
9. "Live Range splitting 和 Coalesce 有什么不同？为什么两者都需要？→ 03 §五"

### Tier 4: 去优化 + OopMap
10. "去优化时 JVM 怎么从 16 个机器寄存器中重建 Java 操作数栈？OopMap 只知道哪些寄存器有 oop——不知道 int/float 类型信息。怎么恢复类型？→ 05+06"
11. "为什么 OopMap 只在 safepoint 生成——和 safepoint poll 的关系？→ 06 §一"
12. "Uncommon trap 和 OSR deopt 有什么区别？OSR 需要重建什么额外信息？→ 05 §三"

### Tier 5: 全局
13. "如果 C1 先编译了热方法，C2 又重编译了——新 nmethod 怎么'接管'？旧的 C1 nmethod 怎么处理？→ 04 §二"
14. "为什么不用 C2 编译所有代码？每个方法都多花 100ms 编译提前，运行时应该更快才对？→ 01 §一"
15. "Escape Analysis 和 Scalar Replacement 是怎么互动的？为什么分配对象变成了标量变量？→ 01 §七"

---

## §十二 面试 + 生产场景

### 面试 8 问

| 面试问题 | 文档 | 核心洞察 |
|----------|------|---------| 
| "C2 怎么把字节码编译成机器码？" | 01 §一~§三 | Sea of Nodes IR → 8 passes → instruction selection → register alloc |
| "内联为什么是 JIT 最重要的优化？" | 02 §一 | Eliminates call overhead (4 args push + return + frame), enables downstream opts (GVN, EA) |
| "Chaitin 着色算法的核心思想？" | 03 §二 | IFG construction → coloring with 16 GPRs → spill if degree ≥ 16 at any point |
| "CodeCache 满了怎么办？" | 04 §三 | Emergency flush of zombie nmethods → stop compilation → methods stay in interpreter |
| "去优化是什么？什么时候发生？" | 05 §一 | Optimization assumption broken → frame rebuild → re-enter interpreter at deopt point |
| "GC 怎么找到 JIT 代码中的 live oop？" | 06 §一 | OopMap at each safepoint bitmasks register/stack oop pointers |
| "Tiered compilation 的优势？" | 01 §一 | C1 quick speedup (5-10ms) + profiling data for C2's deeper optimization |
| "Escape Analysis 做什么？不逃逸的对象怎么处理？" | 01 §七 | ConnectionGraph → stream analysis → scalar replacement → allocate on stack |

### 生产 6 场景

| 生产场景 | 症状 | 文档 | 诊断 |
|---------|------|------|------|
| C2 编译崩溃 | hs_err 有 `V [libjvm.so+...] PhaseIdealLoop` | 01 | `-XX:CompileOnly=...` exclude crashing method, report C2 bug |
| 启动慢——inline 过深 | CodeCache 100% full 在启动后 2min | 02 | `PrintInlining` → check depth >9 → `-XX:MaxInlineLevel=9` |
| CodeCache 满 | "CodeCache is full. Compiler has been disabled." 日志 | 04 | `-XX:ReservedCodeCacheSize=512m`, check Sweeper |
| 去优化风暴 | uncommon-trap 日志刷屏, GC 频率上升 | 05 | `-XX:+PrintDeoptimizationDetails`, identify unstable class hierarchy |
| Spill 风暴 | perf 显示大量 `mov` between reg and stack in compiled code | 03 | Reduce register pressure → inline less → fewer live ranges |
| OopMap 导致 GC 崩溃 | GC crash with 'bad oop' 引用 | 06 | Verify OopMap with `-XX:+VerifyOops`, check deopt point correctness |
