# 域 14: C1 Compiler — 知识规划

> 源码路径: hotspot/share/c1/ + hotspot/cpu/x86/c1_* | 源码量: ~65 文件 / ~51,750 行 | 大域
> 拆 4 篇

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| c1_GraphBuilder.hpp.cpp | **GraphBuilder — 字节码→HIR 图构建**: 逐 bytecode→c1_Instruction 节点, basic block 构建, 异常处理器, 循环 detection, 方法入口/OSR entry | High |
| c1_IR.hpp.cpp | **HIR (High-Level IR) — C1 中间表示**: BlockBegin/BlockEnd, c1_Instruction 层次 (Phi/Goto/If/Local/Constant/Arithmetic/Invoke/New/...), 控制流图 | High |
| c1_Canonicalizer.hpp.cpp | **Canonicalizer — 规范化优化**: 常量折叠, 代数简化 (Add 0→x+0=x), 条件简化 (if true→branch always), 内联 trivial methods, 多趟 (canonicalize/optimize) | High |
| c1_Optimizer.hpp.cpp | **Optimizer — HIR 优化**: global value numbering (c1_ValueMap), null check elimination, range check elimination | High |
| c1_ValueMap.hpp.cpp | **ValueMap — 值编号**: 全局值编号 (GVN), value→value_id 映射, 消除重复计算, ArrayIndex/FieldAccess 的 CSE | High |
| c1_LinearScan.hpp.cpp + cpu/x86/c1_LinearScan_x86.hpp.cpp | **LinearScan — 寄存器分配**: 区间 (Interval), register hint, split/spill, 线性扫描 O(n) 分配 (vs C2 的 Chaitin graph coloring), x86 spill/fpu stack | High |
| c1_LIRGenerator.hpp.cpp + cpu/x86/c1_LIRGenerator_x86.cpp | **LIRGenerator — HIR→LIR 转换**: c1_Instruction→LIR_Op (x86 machine-oriented), LIR_OpLabel/call/move/jump... | High |
| c1_LIRAssembler.hpp.cpp + cpu/x86/c1_LIRAssembler_x86.cpp | **LIRAssembler — LIR→机器码**: LIR_Op→x86 汇编, peephole optimization, emit_code, relocInfo 标记 | High |
| c1_Runtime1.hpp.cpp + cpu/x86/c1_Runtime1_x86.cpp | **Runtime1 — C1 runtime 支持**: new/checkcast/monitorenter/resolve_invoke——C1 stub→call C++。与 InterpreterRuntime 不同——C1 的 runtime 在编译代码中调用 | High |
| c1_Compiler.hpp.cpp | **Compiler — C1 入口**: Compile c1_compile_method(ciEnv, ...), 编译管线调度 (GraphBuilder→Optimizer→LIR→LinearScan→CodeGen) | High |
| c1_FrameMap.hpp.cpp | **FrameMap — C1 栈帧布局**: caller save/callee save, OopMap, bci 到 LIR 映射, monitor 分配 | Medium |

*11 个知识点*

## 02 聚合 — P1/P2/P3

### P1 (≥5文件)
| KP | 出现文件 |
|----|---------|
| C1 编译管线 (GraphBuilder→LIR→CodeGen) | c1_GraphBuilder.cpp, c1_LIRGenerator.cpp, c1_LIRAssembler.cpp, c1_LinearScan.cpp, c1_Runtime1.cpp, c1_Compiler.cpp |

### P2 (2-4文件)
| KP | 出现文件 |
|----|---------|
| C1 IR + 优化 (Canonicalizer/GVN) | c1_IR.cpp, c1_Canonicalizer.cpp, c1_Optimizer.cpp, c1_ValueMap.cpp |
| 栈帧 + 寄存器 | c1_FrameMap.cpp, c1_LinearScan.cpp |

### P3 (=1文件)
| KP | 出现文件 |
|----|---------|
| (全部 KPs 已在 P1/P2) | — |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (4 KP)
| KP | 为什么🔴 |
|----|---------|
| GraphBuilder — 字节码→HIR | 逐 bytecode 构建 c1_Instruction 图——每条字节码 (iload/invokevirtual/new) 对应一个 HIR 节点。字节码的隐式操作栈被转换为显式 SSA 变量 (值→local node)。basic block 边界 = branch target/exception handler/osr entry |
| Canonicalizer — 多趟规范化 | 为什么不用 C2 的 single-pass？C1 的目标是快速编译 (milliseconds)——多趟规范化 ——每趟只看相邻指令——不遍历全图——快速——牺牲极致优化换速度 |
| LinearScan — O(n) 寄存器分配 | C2 用 Chaitin graph coloring (O(n²))——C1 用 Linear scan (O(n))。Interval 按 start position 排序→依次分配→spill 冲突的。快速——精度损失可接受——因为 C1 目标不是 peak performance |
| Runtime1 — C1 特有的 runtime | C1 不可能为每条字节码生成 fast path + slow path——太慢。C1 把复杂操作 (new/checkcast/lock) delegate 到 C++ runtime——编译代码 call C1 stub→C++。与 InterpreterRuntime 共享部分逻辑 |

### 🟡 Working — 有设计但非核心 (4 KP)
| KP | 说明 |
|----|------|
| LIR — HIR→machine IR | 中间 IR 转换 |
| LIRAssembler — 代码生成 | x86 汇编输出 |
| Compiler entry — 管线调度 | 编译全流程入口 |
| FrameMap — 栈帧管理 | frame layout |

### 🟢 Surface — 了解即可 (3 KP)
| KP | 说明 |
|----|------|
| ValueMap — GVN/CSE | 值编号优化 |
| Optimizer — HIR 优化 | null check/range check |
| IR — HIR 节点层次 | 基本 IR 结构 |

## 03 聚类 — 教学顺序与文章拆分

### 教学顺序

```
1. C1 全景 — 编译管线 + IR
2. HIR 优化 — Canonicalizer + ValueMap + Optimizer
3. 寄存器与代码 — LinearScan + LIR + LIRAssembler
4. Runtime — Runtime1 + FrameMap + Compiler entry
```

### 文章拆分建议

4 篇:

- **01-c1-pipeline-ir.md** — C1 管线 + HIR (GraphBuilder + IR)
- **02-c1-optimizations.md** — Canonicalizer + ValueMap + Optimizer
- **03-c1-register-codegen.md** — LinearScan + LIR + LIRAssembler
- **04-c1-runtime-frame.md** — Runtime1 + FrameMap + Compiler entry
