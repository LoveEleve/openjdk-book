# 05 - JIT 编译器

> 源码索引：`source_index/07-compiler.md`(24) + `14-opto.md`(129) + `13-c1.md`(49) + `15-ci.md`(74) + `08-code.md`(47) + `02-runtime.md`(173, deopt/vtable)
> 插桩覆盖：`-Xlog:probe_jit=debug`（5cpp share + opto 3 + c1 1）
> 前置专题：[04-interpreter](../04-interpreter/)
> 如需速览：**直接看 §0.3 JIT 编译的本质（三句话）**，已包含 Sea of Nodes / GVN / Chaitin 核心概念

---

## §〇 上手指南 ⭐（新手必读）

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
| **ADL** (Architecture Description Language) | C2 的描述文件——通过 `x86_64.ad` 定义 x86_64 的寄存器集、指令模式、栈帧约定。Matcher 阶段读取 ADL 文件来将 Ideal Graph Node 匹配到具体的 x86 指令 | 01-Pipeline |
| **HIR / LIR** | C1 的两层 IR：HIR (High-level IR) = C1 的优化 IR (SEAF nodes)；LIR (Low-level IR) = C1 的线性 IR（接近机器码，用于 Linear Scan 寄存器分配）。这是 C1 独有的概念——C2 使用 Sea of Nodes | 01-Pipeline
| **CodeCache** | JVM 存放所有编译后机器码的内存区域——默认 240MB（tiered） | 04-CodeCache |
| **nmethod** | 编译后的 Java 方法——包含 machine code + metadata (OopMap, ExceptionCache, deopt info) | 04 |
| **Uncommon Trap** | 优化假设被打破 → 触发去优化 → 从编译代码跳回解释器 | 05-Deopt |
| **OopMap** | 记录"编译器把哪些寄存器/栈位置存储了对象指针"——GC 需要这个来找到所有 live oop | 06-OopMap |
| **Deoptimization** | 从编译代码回退到解释器——栈帧重建，从 deopt point 继续解释执行 | 05 |

### 0.5 如何阅读本文档？三条路径

**🟢 入门路径**（2-3 小时）:
```
1. README 本节（你在这里）
2. 01-Pipeline §一~§三（C2 8 阶段概览 → 建立"字节码怎么变成机器码"的认知）
3. 02-Inline §一~§二（内联为什么是 JIT 最重要的优化 → 不内联的代价）
4. 05-Deopt §一（去优化是什么 → 为什么 Java 能"回退"到解释器）
5. 06-OopMap §一（GC 怎么找到编译代码中的对象引用 → JIT 和 GC 的协作）
```

**🟡 进阶路径**（5-8 小时）:
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
JAVA=/data/workspace/openjdk-cut-new/build/linux-x86_64-normal-server-slowdebug/jdk/bin/java
gdb --args $JAVA -XX:+PrintCompilation -Xcomp Demo
(gdb) break CompileBroker::compile_method
(gdb) break PhaseIdealLoop::build_and_optimize
```

---

## §一 编译器体系

### 1.1 三层编译器架构

```
AbstractCompiler
  ├── C1 (c1/)     ← Client Compiler（快速/简单）
  │     ├── GraphBuilder → HIR → LIR → RegAlloc → CodeEmit
  │     └── c1_LinearScan.cpp（线性扫描寄存器分配）
  ├── C2 (opto/)   ← Server Compiler（深度优化）
  │     ├── IDEAL IR（Sea of Nodes）
  │     │   ├── Parse → BuildGraph → GVN → IGVN
  │     │   ├── InlineTree（内联）
  │     │   ├── EscapeAnalysis（逃逸分析）
  │     │   └── LoopTransform（循环优化）
  │     ├── MATCH（指令选择）
  │     ├── REGALLOC（Chaitin 着色）
  │     └── CODE（代码生成 → CodeBlob）
  └── JVMCI (jvmci/) ← Graal 编译器接口

CompileBroker: 编译任务调度器 (compileBroker.cpp)
CompileTask: 编译任务 (compileTask.cpp)
CompilerThread: 编译线程
```

### 1.2 Tiered Compilation 层级

| Level | Compiler | Description |
|:---:|----------|-------------|
| 0 | Interpreter | Pure interpretation, no compilation |
| 1 | C1 no profiling | Fast compile, no profiling data |
| 2 | C1 limited profiling | C1 with invocation+backedge counters only |
| 3 | C1 full profiling | C1 with full profile (type profile, branch profile) |
| 4 | C2 | Full optimization with profile data from L2/L3 |

**为什么分层？** C2 编译一个方法需要 80-100ms，C1 只需 5-10ms。热方法先 C1（立即加速）→ 收集 profile → C2 用真实数据重编译。冷方法永远不会走到 C2。

### 1.3 CompileBroker → CompileQueue → CompilerThread 生命周期

```
JavaThread (interpreter) → frequency_counter_overflow()
  → CompileBroker::compile_method(method, CompLevel_Full_Optimization)
    → CompileTask::CompileTask(method, compile_id, osr_bci)
    → CompileQueue::add(task)
      → CompilerThread::loop()  [permanently running daemon thread]
        → CompileQueue::get()   [blocks if queue empty]
        → CompileBroker::invoke_compiler_on_method(task)
          → C2Compiler::compile_method()  if level >= CompLevel_Full_Optimization
            → Compile::Compile()  [C2's main entry]
              [— 8 phases —]
            → nmethod = CodeCache::allocate(...)
            → Method::set_code(nmethod)  [atomic swap — next call enters compiled code]
        → CompileTask::set_success()
```

---

## §二 编译触发

### 2.1 计数器触发流程

```
InvocationCounter count = method->invocation_counter()
  到达 CompileThreshold (10000)
    → CompileBroker::compile_method()
      → CompileQueue::add(task)
        → CompilerThread::loop()
          → C1::compile()  or  C2::compile()
            → CodeCache::allocate → nmethod
              → method->set_code(nmethod)
```

### 2.2 OSR vs Full Compilation

```
Full compilation: method called enough times → compile entire method
OSR (On-Stack Replacement): loop iterates enough times → compile the LOOP BODY only
```

OSR trigger: BackEdgeCounter hits 0 → `CompileBroker::compile_method(method, osr_bci=loop_header_bci)` → C2 generates code that REPLACES the interpreter frame mid-execution → from that point, loop runs compiled code.

### 2.3 CompileCommand

```
-XX:CompileCommand=exclude,com.example.MyClass::hotMethod  → never compile
-XX:CompileCommand=inline,com.example.MyClass::helper       → force inline
-XX:CompileCommand=compileonly,com.example.MyClass::*       → only compile this
```

---

## §三 C2 编译阶段

| 阶段 | Phase | 源文件 | 说明 |
|:---:|-------|------|------|
| 1 | Parse | `parse1.cpp`, `parse2.cpp`, `parseHelper.cpp` | 方法解析→IR 图（GraphKit 逐条字节码创建 Node） |
| 2 | Optimize | `phaseX.cpp`, `loopnode.cpp`, `cfgnode.cpp`, `subnode.cpp` | IDEAL(GVN/IGVN)、内联、循环优化 |
| 3 | EscapeAnalysis | `escape.cpp`, `connectionGraph.cpp` | 逃逸分析+标量替换（ConnectionGraph→stream analysis） |
| 4 | MacroExpand | `macro.cpp`, `macroArrayCopy.cpp` | 宏展开（锁→CAS, 分配→TLAB） |
| 5 | Matcher | `matcher.cpp`, `output.cpp`, `reg_split.cpp` | 指令选择（x86 特定，ADL→x86_64.ad 描述） |
| 6 | RegAlloc | `chaitin.cpp`, `ifg.cpp`, `coalesce.cpp` | Chaitin 图着色寄存器分配 |
| 7 | BlockOrder | `block.cpp` | 基本块排序 |
| 8 | CodeGen | `output.cpp`, `buildOopMap.cpp` | 代码生成→CodeBlob→OopMap 生成→CodeCache 安装 |

---

## §四 完整文件索引

### 4.1 按目录

| Directory | Files | Purpose |
|-----------|:---:|---------|
| `opto/` | 129 | C2 compiler — all 8 phases |
| `c1/` | 49 | C1 client compiler |
| `compiler/` | 24 | Shared compilation infrastructure |
| `ci/` | 74 | Compiler Interface — JVM → compiler communication |
| `code/` | 47 | Compiled code management (nmethod, CodeCache, OopMap) |
| `runtime/` | 173 | Runtime support (deoptimization, vtable stubs, frame) |

### 4.2 按编译阶段

| 阶段 | 关键文件 |
|-------|------------|
| Parse | `parse1.cpp`, `parse2.cpp`, `parseHelper.cpp`, `graphKit.cpp` |
| Ideal/IGVN | `phaseX.cpp`, `loopnode.cpp`, `cfgnode.cpp`, `subnode.cpp` |
| Inline | `doCall.cpp`, `callGenerator.cpp`, `bytecodeInfo.cpp` |
| Escape Analysis | `escape.cpp`, `connectionGraph.cpp` |
| Macro Expansion | `macro.cpp`, `macroArrayCopy.cpp` |
| Matching | `matcher.cpp`, `ad.hpp` |
| Register Allocation | `chaitin.cpp`, `ifg.cpp`, `coalesce.cpp`, `live.cpp`, `reg_split.cpp` |
| Code Generation | `output.cpp`, `buildOopMap.cpp`, `block.cpp` |
| Code Installation | `nmethod.cpp`, `codeCache.cpp`, `oopMap.cpp` |

---

## §五 关键数据结构

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

### CodeBlob 继承体系

```
CodeBlob
  ├── RuntimeBlob
  │     ├── BufferBlob（AdapterBlob/VtableBlob/MethodHandlesAdapterBlob）
  │     ├── RuntimeStub
  │     └── SingletonBlob（DeoptimizationBlob/UncommonTrapBlob/ExceptionBlob/SafepointBlob）
  └── CompiledMethod
        └── nmethod
```

### nmethod 内存布局

```
┌────────────────────────────┐ ← header_begin()
│  nmethod header            │
├────────────────────────────┤ ← code_begin() / _entry_point
│  机器码（指令）              │
├────────────────────────────┤ ← stub_begin()
│  Stub 代码                  │
├────────────────────────────┤ ← oops_begin()
│  Oop 表（GC 根）            │
├────────────────────────────┤ ← metadata_begin()
│  元数据表                   │
├────────────────────────────┤ ← scopes_data_begin()
│  调试信息数据               │
├────────────────────────────┤ ← scopes_pcs_begin()
│  PC 描述符表                │
├────────────────────────────┤ ← dependencies_begin()
│  依赖表                     │
├────────────────────────────┤ ← handler_table_begin()
│  异常处理器表               │
├────────────────────────────┤ ← nul_chk_table_begin()
│  空检查表                   │
└────────────────────────────┘
```

---

## §六 探针覆盖

| 探针 | 数据 |
|------|------|
| `C2 Compile START` | ★ this=地址, method, compile_id, osr_bci |
| `C2 Compile SUCCESS` | ★ this=地址, frame_size, java_calls, inner_loops |
| `InlineTree::should_inline` | callee/caller/callee_size |
| `InlineTree::try_to_inline` | callee/caller@bci/inline_level |
| `InlineTree::try_to_inline PASS` | reason/inline_level/forced |
| `C2 call_generator` | callee/vtable_index/does_dispatch |
| `CompileTask::allocate` | 编译任务分配 |
| `CompileBroker::compile_method` | method/hot_count/reason |
| `NMethodSweeper DONE` | swept/flushed/zombified |
| `CompiledMethod CREATED` | 每16次采样 |
| `VtableStubs::create` | is_vtable/index |
| `OopMapSet::add_gc_map` | 每128次采样 |
| `BufferBlob::create` | name/size |

### 探针分布

| 文件 | 数量 | 关键探针 |
|------|:--:|------|
| compileBroker.cpp | 2 | compile_method, CompilerThread loop |
| compileTask.cpp | 1 | allocate |
| c2compiler.cpp | 2 | compile_method entry + success |
| doCall.cpp | 4 | should_inline, try_to_inline, try_to_inline PASS, call_generator |
| nmethodSweeper.cpp | 1 | sweep DONE |
| nmethod.cpp | 1 | CompiledMethod CREATED (sampled) |
| vtableStubs.cpp | 1 | create vtable/itable stub |
| oopMap.cpp | 1 | add_gc_map (sampled) |
| codeBlob.cpp | 1 | BufferBlob create |

---

## §七 文档计划（7 docs）

### Dependency diagram

```
01-Pipeline (foundation — everything flows through C2's 8 phases)
├── 02-Inline (phase 2 — the biggest optimization lever)
│     └── 04-CodeCache (inline depth → nmethod size → CodeCache capacity)
├── 03-RegAlloc (phase 6 — register coloring from Ideal graph)
├── 04-CodeCache (post-compilation — where compiled code lives)
├── 05-Deopt (runtime fallback — when optimization assumptions break)
│     └── 06-OopMap (OopMaps consumed by deopt for frame rebuild: scope→reg→oop)
├── 06-OopMap (GC integration — how GC finds roots in compiled code)
└── 07-Profile-Data-Flow (ci/ layer — how C2 reads C1's profiling data)
      ├── 01-Pipeline (Parse uses ciMethod for type decisions)
      └── 02-Inline (InlineTree uses ciCallProfile for inline decisions)
```

Writing order: 01 → 02 → 03+04 → 05 → 06 → 07

---

## §八 文档逐篇详述

### 01-C2-Pipeline.md

**核心问题**: "C2 怎么把 100 条字节码变成 10 条 x86 指令？8 个阶段各自做什么？"

**生产场景**: "C2 编译 JVM 应用时 SIGSEGV——hs_err 显示 `V [libjvm.so+0x...] PhaseIdealLoop::build_and_optimize`。编译过程中的 bug 导致 JVM 崩溃——如何定位到 C2 的哪个阶段？"

**文档覆盖**:
1. Parse: `GraphKit` 字节码 → `Parse::do_one_bytecode()` → Node 创建（LoadI/StoreI/CallStaticJava/If/CatchNode）
2. Optimize: IGVN hash-consing（实现 `Node::Ideal()` → 恒等优化：`AddI(0,x) → x`, `AndI(x,-1) → x`）
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

**生产场景**: "生产 JVM 启动慢 40 秒——`-XX:+PrintInlining` 显示 C2 在编译一个方法时内联了 2000+ 层。Inline 深度没限制导致单个 nmethod 达到 2MB——CodeCache 装满触发 emergency flushing。"

**文档覆盖**:
1. InlineTree: 递归数据结构的构建过程 → `GraphKit::try_inline()` → `InlineTree::should_inline()`
2. CHA (Class Hierarchy Analysis): `ciKlass::subklass_of()` → 如果只有一个子类 → invokevirtual → 单态调用
3. Inline Policy: `InlineTree::should_inline()` — max depth、max size、frequency、callee hotness 的决策逻辑
4. Late Inline: 在 IGVN 之后补的内联 (`PhaseIdealLoop::do_call()`)
5. Production: inline log 解读 (`(hot)`, `already compiled into a big method`, `callee is too large`)

**关键文件**: doCall.cpp/callGenerator.cpp/bytecodeInfo.cpp

**前置**: 01-Pipeline (knows Parse + Optimize phases)
**回避声明**: "本文不讲 C1 的内联策略。"

### 03-Chaitin-RegAlloc.md

**核心问题**: "C2 的虚拟寄存器怎么映射到 x86_64 的 16 个 GPR？什么时候 spill？"

**生产场景**: "JIT 编译后的代码在 perf 中显示大量 spill/fill mov 指令——C2 在寄存器压力大时 spill 到栈上。这导致编译代码比解释器快不了多少。"

**文档覆盖**:
1. Live Range: `PhaseLive::compute()` (chaitin.cpp:418) — 每个 Node 的"从定义到最后一次使用"的区间
2. IFG_virtual: 构建虚拟干扰图 — Live Range 重叠的 Node 连边，不能共享寄存器
3. AggressiveCoalesce: `aggressive_coalesce.coalesce_driver()` (chaitin.cpp:425) — 消除 mov 指令：如果 src 和 dst 不干扰 → 合并为一个虚拟寄存器
4. IFG_physical: 在 coalesce 之后构建物理干扰图 — 真正对阵 16 个 GPR
5. Simplify: (chaitin.cpp:515) — 迭代移除低度节点（degree < 16）→ 压入着色栈
6. Select: (chaitin.cpp:519) — 从栈中弹出，分配颜色。若某步发现 degree ≥ 16 → 着色失败 → 选节点 spill
7. Split + ConservativeCoalesce: (chaitin.cpp:546-575) — 若 Select 失败 → 分裂 Live Range（split）+ 保守合并 → 回 Step 1 重做

> **这是实际 HotSpot 的顺序，与 Chaitin 1982 论文的标准顺序略有不同**——HotSpot 在 IFG 构建后会立即进行 AggressiveCoalesce，消除尽可能多的 mov 指令，之后再构建物理干扰图。

**关键文件**: chaitin.cpp/ifg.cpp/coalesce.cpp/live.cpp/reg_split.cpp

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

### 07-Profile-Data-Flow.md

**核心问题**: "C2 怎么读取 C1 收集的类型 profile、调用计数和分支 profile？ciMethod/ciKlass/ciTypeFlow 是什么？"

**生产场景**: "生产性能回归——C2 内联了不需要的方法导致 CodeCache 爆满。因为 C1 的类型 profile 被污染了（一次调用了罕见的子类），C2 基于错误数据决定内联。`-XX:+PrintInlining` 显示 `@ 1 java.lang.Object::hashCode` — 单型陷阱。"

**文档覆盖**:
1. ciMethod: method metadata + profile 数据 (`ciMethod::has_profiles()` → `MethodData::invocation_count()` / `receiver_type_data()`）
2. ciKlass: class hierarchy + profiling data (`ciKlass::subklass_of()` — 用于 CHA 决策)
3. ciTypeFlow: 类型传播 (`ciTypeFlow::flow_types()` — 分析字节码的类型流)
4. ciCallProfile: 调用计数 + 接收者类型 (`ciCallProfile::count()` / `receiver_count()` → 决策 monomorphic/polymorphic)
5. ProfileData 消费: `Parse::Parse()` 在解析时读取 profile → `InlineTree::should_inline()` 用 profile 做 inline 决策

**关键文件**: ci/ciMethod.cpp, ci/ciKlass.cpp, ci/ciTypeFlow.cpp, ci/ciCallProfile.cpp

**前置**: 01-Pipeline + 02-Inline (Parse + Inline 使用 ci 做决策)

---

## §九 写作优先级

| Priority | Doc | Why |
|:---:|------|-----|
| **P0** | 01-C2-Pipeline | Foundation — everything flows through C2 |
| **P0** | 02-Inline-Decision | Biggest single optimization lever (can make 10× difference) |
| **P1** | 05-Deoptimization | Connects JIT back to interpreter — the "escape hatch" |
| **P1** | 06-OopMap | Connects JIT to GC — where the two largest subsystems meet |
| **P2** | 03-Chaitin-RegAlloc | Deep but narrow — only matters for compiler engineers |
| **P2** | 04-CodeCache-Sweeper | Important but well-understood by DevOps already |
| **P2** | 07-Profile-Data-Flow | ci/ layer — supports 01 and 02, needed for profile pollution debugging |

---

## §十 和已学阶段的对比

| 04-interpreter 概念 | 05-JIT 对应 | 推进 |
|---------------------|-----------|------|
| 256 字节码 dispatch | Parse 阶段：每个字节码创建对应的 Node | 从 "O(1) dispatch" 到 "生成 O(1) 的 x86 指令" |
| TOS 状态机 (编译时类型安全) | C2 的 type flow — Node::bottom_type() 传播类型约束 | 从 "int/float/oop 状态" 到 "full type lattice (top→long→int→bottom)" |
| InvocationCounter → CompileBroker | CompileBroker → CompileQueue → CompilerThread | 从"触发点"到"完整编译管道" |
| Counter decay at safepoint | NMethodSweeper flush at safepoint | 从"计数器衰减"到"编译代码回收" |

| 08-safepoint 概念 | 05-JIT 对应 |
|-------------------|-----------|
| Safepoint poll (testl) | OopMap at safepoint (where GC finds roots in JIT code) |

### 阶段连接

| 前一阶段 | 传递给 05 什么 | 05 如何消费 |
|----------|-------------|------------|
| 01-jvm-startup | CompileBroker 在 `init_globals()` 中初始化 | §一 CompileBroker → CompileQueue → CompilerThread 全链路 |
| 02-class-loading | InstanceKlass/Method/ConstantPool 的完整结构 | 05 的 ciMethod/ciKlass 是 Method/InstanceKlass 的只读包装 |
| 03-object-model | oop/Klass 二分模型 + markOop 编码 | 05 逃逸分析判断对象是否可栈上分配；OopMap 记录 GC root |
| 04-interpreter | invocation_counter + BackEdgeCounter | 05 的编译触发（计数器 → CompileBroker::compile_method） |
| 12-cpu-layer | x86 指令集 + 寄存器规范 | 05 Matcher→ADL 模式匹配为 x86 指令；RegAlloc 使用 16 GPR |

---

## §十一 显式排除

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

## §十二 深度问题（15 题，从第一性原理出发）

### Tier 1: C2 架构

| # | 问题 | 答案方向 | 文档 |
|---|------|---------|------|
| Q1 | 如果你设计一个 JIT 编译器，你会用一个统一的 IR 还是多层次的 IR？C2 为什么只用一种 IR（Sea of Nodes）？ | 统一 IR = 所有优化共享同一张图 → 无需 phase 间转换开销。代价：某些优化（如 instruction selection）在图表示中不够自然 | 01 §二 |
| Q2 | Sea of Nodes 为什么没有控制流？没有控制流怎么表示 if/else 的顺序？ | 控制流不是"线"而是"控制依赖边"。IfNode→ProjNode(true/false)→RegionNode→PhiNode。数据流 = def-use 边，控制流 = control-edge（也存为 Node._in[]） | 01 §二 |
| Q3 | C2 的 8 个阶段为什么是这个顺序？如果把 Escape Analysis 放在 IGVN 之前会怎样？ | 顺序：粗优化→细优化→机器相关。IGVN 先做（消除冗余 Load → Escape Analysis 看到更少别名 → 更精确）。反过来 EA 看到的图噪音大 | 01 §三 |

### Tier 2: 内联

| # | 问题 | 答案方向 | 文档 |
|---|------|---------|------|
| Q4 | 内联为什么是 JIT 最重要的优化？不内联的代码和内联后的代码差多少条指令？ | 不内联：push args(4) + call(1) + prologue(3) + epilogue(2) + ret(1) = 11 条指令/调用。内联：0 breakpoint。还 enable 下游优化（GVN 看穿 callee 内部、EA 消除分配） | 02 §一 |
| Q5 | C2 怎么决定 '内联太深了要停止'？InlineTree 的 max_desired_size 和 frequency 是怎么 trade-off 的？ | `InlineTree::should_inline()` — max_depth(9) + max_size(desired_size/freq_inline_size) + frequency 加权。高频调用 → 允许更深的 inline | 02 §三 |
| Q6 | CHA (Class Hierarchy Analysis) 和 Profiling (type profile from L2) 在内联决策中各起什么作用？哪个更可信？ | CHA = 静态分析（看已加载的类层次）。L2 profile = 运行时类型采样。静态 > 动态（type profile 可能采样偏差），但 CHA 对已加载类之外的子类盲区 | 02 §二 |

### Tier 3: 寄存器分配

| # | 问题 | 答案方向 | 文档 |
|---|------|---------|------|
| Q7 | Chaitin 着色算法为什么会 spill？什么情况下 spill 是理论上不可避免的？ | 当 live range 干扰图中有 ≥16 个相互重叠邻居（K=16 GPR on x86_64）→ 需要 spill。理论上：如果 unit interval graph 的 clique 大小 > K → spill unavoidable | 03 §四 |
| Q8 | 为什么 x86_64 只有 16 个 GPR 但对大多数方法已经够了？Chaitin 的'小寄存器集'假设在 RISC/ARM 上成立吗？ | CISC 内存操作数（add reg, [mem]）减少了寄存器压力——很多操作可以直接在内存上。RISC(ARM/RISC-V) 有 31 GPR，live range 更少重叠 → spill 更少 | 03 §三 |
| Q9 | Live Range splitting 和 Coalesce 有什么不同？为什么两者都需要？ | Splitting = 把一个 live range 切成多块 → 同一值用不同寄存器在不同代码区 → 减少干扰边。Coalesce = 两个不相干扰的 live range 合并为一个 → 消除 mov 指令。Split→reduce pressure, Coalesce→eliminate copies | 03 §五 |

### Tier 4: 去优化 + OopMap

| # | 问题 | 答案方向 | 文档 |
|---|------|---------|------|
| Q10 | 去优化时 JVM 怎么从 16 个机器寄存器中重建 Java 操作数栈？OopMap 只知道哪些寄存器有 oop——不知道 int/float 类型信息。怎么恢复类型？ | DebugInfo 存储了 ScopeValue（寄存器/栈 slot 的类型：T_INT/T_OBJECT/T_LONG 等）。OopMap 只标记 oop vs non-oop，DebugInfo 补全类型信息 → 帧重建时逐个 slot 按类型写入解释器帧 | 05+06 |
| Q11 | 为什么 OopMap 只在 safepoint 生成——和 safepoint poll 的关系？ | safepoint 是唯一 GC 可以发生的地方。编译代码在 safepoint poll（testl 轮询）处有可能停止 → 此时所有 live oop 都在 OopMap 中有记录 → GC 可以遍历 roots。非 safepoint 处不需要 OopMap | 06 §一 |
| Q12 | Uncommon trap 和 OSR deopt 有什么区别？OSR 需要重建什么额外信息？ | Uncommon trap = 优化假设破灭 → 从 JIT 的任意处回退到相同 bci 的解释器。OSR deopt = 从编译的循环体回退到解释器的 loop entry → 需要重建循环变量和栈状态（解析 bci + 局部变量比 uncommon trap 多） | 05 §三 |

### Tier 5: 全局

| # | 问题 | 答案方向 | 文档 |
|---|------|---------|------|
| Q13 | 如果 C1 先编译了热方法，C2 又重编译了——新 nmethod 怎么'接管'？旧的 C1 nmethod 怎么处理？ | `Method::set_code(new_nmethod)` 是 atomic swap。旧 nmethod → `make_not_entrant()`（标记为 not_entrant）。已进入旧 nmethod 的线程可以执行完毕，下一次调用走 `_from_compiled_entry` → `VerifiedEntryPoint` → transition 到新 nmethod | 04 §二 |
| Q14 | 为什么不用 C2 编译所有代码？每个方法都多花 100ms 编译提前，运行时应该更快才对？ | 冷方法在解释器中的总执行时间 < 100ms。100ms 编译时间打水漂。C1 5-10ms 编译+profile 收集 → 只有真正热的才值得 C2。用 `-Xcomp` 启动时间 +5-10s | 01 §一 |
| Q15 | Escape Analysis 和 Scalar Replacement 是怎么互动的？为什么分配对象变成了标量变量？ | ConnectionGraph 分析对象引用流 → 不逃逸对象 = 从未被其他线程或函数外部看到。Scalar Replacement = 对象的字段变成栈上的独立变量（`x=obj.f1`, `y=obj.f2`）。No allocation → no heap write → no GC → 寄存器友好 | 01 §七 |

---

## §十三 面试 + 生产场景

### 13.1 面试 8 问

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

### 13.1.2 叙事式回答（面试 Story Format）

**"C2 怎么把字节码编译成机器码？"**

> C2 不是一条流水线——它是一个图形优化器。第一步 Parse：字节码 → Node。iload_0 变成 ParmNode（this 指针），iload_1 变成另一个 ParmNode（第一个参数），iadd 变成 AddINode。100 条字节码 → 500 个 Node。第二步 Optimize：IGVN 发现 hashCode() 被调用了 4 次——合并成 1 次。Escape Analysis 发现对象不逃逸——分配操作被删除，字段变成标量变量。Inline Tree 将 5 个方法内联——消除了 20 次调用开销。第三步 Output：优化后的 200 个 Node 被映射到 x86 指令——Matcher 读取 x86_64.ad 找到对应的指令模式（AddI → addl），RegAlloc 将虚拟寄存器映射到 16 个 GPR，最后 CodeGen 输出指令字节到 CodeCache。

**"内联为什么是 JIT 最重要的优化？"**

> 内联是 JIT 的基石——没有内联，其他优化几乎无效。每次方法调用成本：push 参数（4 条 mov）+ call 指令（5 bytes）+ 帧设置（push rbp; mov rbp,rsp）+ 返回（ret）= ~40 周期。C2 的 IGVN 只能优化方法**内部**——它看不到跨调用的冗余。但一旦内联：HashMap.get() 内联到你的 process() 中 → 10 次 hashCode() 调用都可见 → IGVN 消除 9 次重复计算 → 再内联 hashCode() → 字段读取消除 → from 10 loads to 1。这是**瀑布效应**：1 次内联触发 10 次下游优化。

**"Chaitin 着色算法的核心思想？"**

> 编译器有无数个虚拟寄存器（每个 Node 占一个），但 x86_64 只有 16 个 GPR。着色就是把寄存器看作颜色——每个 Node 要分配一种颜色，但相邻（live range 重叠）的 Node 不能用同色。算法先计算 live range，构建干扰图（重叠=edge），然后迭代移除度 < 16 的节点（一定能着色），压栈。若某个时刻所有剩余节点的度 ≥ 16 → 必须挑一个 node spill 到栈上。HotSpot 的巧思：在着色**之前**先做 AggressiveCoalesce（把不干扰的 src/dst 寄存器合并），消除大量 mov 后再构建物理干扰图——这样 spill 概率大幅降低。

### 13.2 生产 10 场景

| 生产场景 | 症状 | 文档 | 诊断 |
|---------|------|------|------|
| C2 编译崩溃 | hs_err 有 `V [libjvm.so+...] PhaseIdealLoop` | 01 | `-XX:CompileOnly=...` exclude crashing method, report C2 bug |
| 启动慢——inline 过深 | CodeCache 100% full 在启动后 2min | 02 | `PrintInlining` → check depth >9 → `-XX:MaxInlineLevel=9` |
| 预热延迟 | 启动后前 5 分钟 P99 居高不下——C2 编译耗时 80-100ms/方法，200 个热方法 × 100ms = 20s 累积延迟 | 01 | `-XX:+PrintCompilation` 显示编译时间 → `-XX:CICompilerCount=4` (from cgroup CPU) + `-XX:TieredCompileTaskTimeout=100` |
| 重编译循环 | perf 显示 50% CPU 在 CompileBroker——方法 编译→去优化→重编译→再去优化 循环，因为不稳定的类层次 | 05 | `-XX:+PrintDeoptimizationDetails` → 同一方法 recompile >5 次 → CompileCommand exclude |
| 遗漏内联 | 热点方法性能只有预期的 40%——`PrintInlining` 显示 `@ 12 java.util.HashMap::hash invoked = 100000, hot method too big` | 02 | 检查 callee 大小 (`-XX:MaxInlineSize=400` → 500) 或 inline 深度 (`-XX:MaxInlineLevel=9` → 12) |
| CodeCache 满 | "CodeCache is full. Compiler has been disabled." 日志 | 04 | `-XX:ReservedCodeCacheSize=512m`, check Sweeper |
| 去优化风暴 | uncommon-trap 日志刷屏, GC 频率上升 | 05 | `-XX:+PrintDeoptimizationDetails`, identify unstable class hierarchy |
| 容器 JIT 资源不足 | CICompilerCount 从 cgroup CPU 限制自动推导——2 核 → CICompilerCount=2 → 500 个方法排队 → 编译队列积压 | 01 | `-XX:+PrintCompilation \| wc -l` 显示编译数远低于预期 → 加容器 CPU 限制或 `-XX:CICompilerCount=4` |
| Spill 风暴 | perf 显示大量 `mov` between reg and stack in compiled code | 03 | Reduce register pressure → inline less → fewer live ranges |
| OopMap 导致 GC 崩溃 | GC crash with 'bad oop' 引用 | 06 | Verify OopMap with `-XX:+VerifyOops`, check deopt point correctness |

### 13.3 评审矩阵（7 docs）

| # | 文档 | 生产故障可直接参考？ | 面试题可直接回答？ | "为什么这样设计"？ | GDB？ | 评级 |
|---|------|:---:|:---:|:---:|:---:|:---:|
| 01 | 01-C2-Pipeline | ⚠️ C2 崩溃 hs_err 定位 | ✅ 8 阶段 + JIT 原理 | ⚠️ Sea of Nodes why | ⚠️ 待补 | 🟡 |
| 02 | 02-Inline-Decision | ✅ inline 过深/CodeCache 满 | ✅ 内联决策全部 | ✅ CHA vs Profile why | ⚠️ 待补 | 🟢 |
| 03 | 03-Chaitin-RegAlloc | ⚠️ spill 风暴 perf 定位 | ✅ 着色算法 | ✅ 小寄存器集假设 why | ⚠️ 待补 | 🟡 |
| 04 | 04-CodeCache-Sweeper | ✅ CodeCache 满 | ✅ nmethod 生命周期 | ⚠️ 3 段布局 why | ⚠️ 待补 | 🟢 |
| 05 | 05-Deoptimization | ✅ 去优化风暴 + frame rebuild | ✅ deopt 全流程 | ✅ 为什么不是 persistent 假设 | ⚠️ 待补 | 🟢 |
| 06 | 06-OopMap | ⚠️ GC crash 'bad oop' | ✅ OopMap 原理 | ⚠️ bitmask vs 其他编码 | ⚠️ 待补 | 🟡 |
| 07 | 07-Profile-Data-Flow | ✅ profile 污染诊断 | ✅ ciMethod/ciKlass | ✅ static CHA vs dynamic profile | ⚠️ 待补 | 🟢 |

---

## §十四 内容审计自检

> 对照 04-interpreter README §十的审计标准，本 README 自检如下：

| 检查项 | 状态 | 说明 |
|--------|:---:|------|
| 显式 reader persona（初级/中级/高级） | ✅ | §0.1 三档 persona 表 |
| 入门/进阶/专家三条路径 | ✅ | §0.5 三条路径 + 时间预估 |
| 环境准备（JVM 参数 + GDB 断点） | ✅ | §0.6 完整命令 |
| 核心术语速查表（≥12） | ✅ | §0.4 15 个术语 |
| 三句话总结 | ✅ | §0.3 C2 三步骤 |
| 前置概念速览（跨专题链接） | ✅ | §0.2 + §十 阶段连接表 |
| 面试 8 问 | ✅ | §13.1 |
| 生产 10 场景 | ✅ | §13.2 |
| 深度问题 ≥15 | ✅ | §十二 15 题 |
| 显式排除 ≥8 | ✅ | §十一 10 项 |
| 评审矩阵自评 | ✅ | §13.3 |
| 全数据源自源码 | ✅ | 源码索引 + hpp 文件位置 + GDB 断点 |
| 为什么这样设计 ≥5 | ✅ | Q1/Q3/Q7/Q8/Q14 等 |
| 和上一阶段的对比表 | ✅ | §十 04-interpreter ↔ 05-JIT |
| 依赖关系图 | ✅ | §七 dependency diagram |
| 不能只说"它做什么"——必须说"为什么" | ✅ | §一 1.2 为什么分层、§十二 全部带 why |
| C2 核心不该囫囵吞枣——完整 8 阶段 | ✅ | §三 8 阶段表 + §八 10 步覆盖 |
| Chaitin 着色不是空洞术语——IFG/coloring/spill 三步骤 | ✅ | §八 03 §覆盖 Live Range→IFG→Coloring→Spill→Coalesce |
| Escape Analysis 不能被跳过 | ✅ | §八 01 §6 步 + Q15 |
