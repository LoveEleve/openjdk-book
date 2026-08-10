**[DEPRECATED — 已被 Phase 31 合并]** 所有新 prompt/文档统一写入 `probe_md/31-c1-c2-jit/`。

# Phase 22: C2 JIT 优化管道 — libjvm.so (opto/)

**C2 编译器** 是 HotSpot 的 Server Compiler，负责 Tier 4 最高编译层的激进优化。它使用 **Sea-of-Nodes IR**（理想图），执行 20+ 个优化 Phase（内联、逃逸分析、循环变换、GVN、CCP、SuperWord 向量化、Chaitin 寄存器分配），是决定 Java 应用峰值性能的最核心子系统。

---

## .so 映射

C2 的 `opto/` 源码编译进 `libjvm.so`，无独立 `.so`。通过 `compiler2` JVM Feature 控制：

```bash
# 构建配置
grep -rn "compiler2\|COMPILER2" make/ | head -5
```

```makefile
# JvmFeatures.gmk
ifeq ($(call check-jvm-feature, compiler2), true)
  JVM_CFLAGS_FEATURES += -DCOMPILER2
else
  JVM_EXCLUDE_PATTERNS += opto/
endif
```

---

## 源码范围

**目录**: `src/hotspot/share/opto/`
**规模**: 73 `.cpp` + 56 `.hpp` = **129 文件**, **138,051 行**

### 核心文件 Top 20

| 文件 | 行数 | 职责 |
|------|------|------|
| `library_call.cpp` | 6,905 | Intrinsic 实现: System.arraycopy, Math.*, String.* |
| `type.cpp` | 5,360 | Type 格体系: TypeInt/TypePtr/TypeOopPtr |
| `compile.cpp` | 5,024 | 编译总控: Compile::Compile, Optimize(), Code_Gen() |
| `memnode.cpp` | 4,937 | 内存访问 IR 节点 |
| `loopnode.cpp` | 4,822 | 循环 IR + PhaseIdealLoop 核心 |
| `superword.cpp` | 4,694 | SLP 自动向量化 |
| `graphKit.cpp` | 4,060 | Parse 阶段 IR 构建工具库 |
| `loopTransform.cpp` | 3,909 | 循环变换: peeling/unrolling/RCE |
| `escape.cpp` | 3,650 | 逃逸分析 + 标量替换 |
| `loopopts.cpp` | 3,541 | 循环优化辅助 |
| `output.cpp` | 2,914 | 代码发射 |
| `parse2.cpp` | 2,868 | 200+ 字节码分发 |
| `macro.cpp` | 2,765 | 宏节点展开 |
| `matcher.cpp` | 2,696 | 指令选择 |
| `node.cpp` | 2,523 | Node 基类 |
| `cfgnode.cpp` | 2,465 | 控制流 IR |
| `chaitin.cpp` | 2,424 | Chaitin 寄存器分配 |
| `parse1.cpp` | 2,395 | Parse 入口 |
| `gcm.cpp` | 2,272 | 全局代码移动 |
| `phaseX.cpp` | 2,260 | GVN/IGVN/CCP 引擎 |

---

## 文档拆分方案（10 篇）

| # | 文档 | 主题 | 核心文件 | 复用旧文档 |
|:---:|------|------|---------|:---:|
| 00 | C2 Pipeline Overview | 编译管线总览: Compile→Optimize→Code_Gen | `compile.cpp` | ✅ 01-C2-Pipeline (60%) |
| 01 | Parse 阶段 | 字节码→Ideal Graph, 200+ 字节码分发 | `parse1.cpp`, `parse2.cpp`, `graphKit.cpp` | 全新 |
| 02 | GVN/IGVN/CCP | 全局值编号 + 条件常量传播 | `phaseX.cpp`, `node.cpp` | 全新 |
| 03 | 内联决策 | InlineTree + CHA + Type Profile | `doCall.cpp`, `bytecodeInfo.cpp` | ✅ 02-Inline-Decision (65%) |
| 04 | 逃逸分析 | ConnectionGraph + 标量替换 + 锁消除 | `escape.cpp` | 全新 |
| 05 | 循环优化 | PhaseIdealLoop 3 轮变换 + RCE | `loopnode.cpp`, `loopTransform.cpp`, `loopopts.cpp` | 全新 |
| 06 | SuperWord 向量化 | SLP 自动向量化 | `superword.cpp` | 全新 |
| 07 | 宏展开 | Lock→CAS, Allocation→TLAB, String | `macro.cpp`, `stringopts.cpp` | 全新 |
| 08 | 指令选择+调度 | Matcher + ADL + GCM | `matcher.cpp`, `gcm.cpp`, `block.cpp` | ✅ 01-Pipeline §七 (30%) |
| 09 | Chaitin 寄存器分配 | 图着色算法 8 步骤 | `chaitin.cpp`, `ifg.cpp`, `coalesce.cpp` | ✅ 03-Chaitin (60%) |

**10 篇中: 6 篇全新 + 4 篇复用旧文档概念框架**

---

## 与旧文档关系

```
libjvm-analysis/05-jit-compiler/
├── 01-C2-Pipeline.md          → Phase 22 doc00 (复用60%)
├── 02-Inline-Decision.md      → Phase 22 doc03 (复用65%)
├── 03-Chaitin-RegAlloc.md     → Phase 22 doc09 (复用60%)
├── 04-CodeCache-Sweeper.md    → 移至 Phase 23 (code/)
├── 05-Deoptimization.md       → 跨 Phase 主题
├── 06-OopMap-GC-Roots.md      → 跨 Phase 主题
└── 07-Profile-Data-Flow.md    → 移至 Phase 23 (ci/)
```

旧文档中的 3 篇（04 CodeCache, 05 Deoptimization, 06 OopMap, 07 Profile）不属于 C2 opto/ 范围，将迁移到后续 Phase。

---

## 构建命令

```bash
# 完整构建
make images

# 或仅编译 HotSpot
make hotspot
```

---

## Prompt 写作计划

10 个 prompt 文件写入 `prompts/` 目录，命名 `prompt-00-C2-Pipeline-Overview.md` ~ `prompt-09-Chaitin-RegAlloc.md`。

目标每篇 ≥450 行（含 12 个 §），总 prompt 量 ≥4,500 行。

## 文档计划

10 篇文档写入 `docs/` 目录，命名 `00-C2-Pipeline-Overview.md` ~ `09-Chaitin-RegAlloc.md`。

目标每篇 2,000-4,000 行，总文档量 ≥25,000 行。
