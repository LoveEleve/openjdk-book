# 14-c1-compiler/01-c1-pipeline-ir 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C1 为什么快——它不是少做一点优化的 C2，而是一条从栈机显式化到 HIR/LIR/机器码、随时允许 bailout 的低延迟流水线

## 1. 核心困惑

**C1 为什么不是“小号 C2”，却仍然能完成从字节码到机器码的整条管线？Java 字节码是隐式操作数栈机器，C1 又怎么把它翻成显式数据流图，并在不拖慢编译的前提下处理 Phi、异常、去优化和寄存器分配？**

## 2. 一句话顿悟

**C1 的快不是简单少做优化，而是从表示选择开始就为低延迟设计：`GraphBuilder` 用 `ValueStack` 把隐式栈翻成显式 HIR，建图时即时做便宜规范化和局部值编号；`emit_lir` 把图线性化并交给 LinearScan；`emit_code_body` 发码并补齐异常、去优化、unwind，然后必要时随时 bailout。**

## 3. 结构

1. 开场：C1 快的真正问题
2. 两个错误理解：小号 C2、顺序直译
3. `build_hir`：前端建图与即时整理
4. `GraphBuilder` / `ValueStack`：栈机到显式 def-use 图
5. HIR：控制流、数据流、状态快照的混合图
6. `emit_lir` / LinearScan：低延迟后端
7. `emit_code_body`：快但不省正确性设施
8. 收网：显式化 + 快速降级

## 4. 证据清单

- `src/hotspot/share/c1/c1_Compilation.cpp:370-403`
- `src/hotspot/share/c1/c1_Compilation.cpp:153-242`
- `src/hotspot/share/c1/c1_GraphBuilder.cpp:2299-2356`
- `src/hotspot/share/c1/c1_ValueStack.cpp:176-190`
- `src/hotspot/share/c1/c1_Instruction.hpp:116-117`
- `src/hotspot/share/c1/c1_Compilation.cpp:253-270`
- `src/hotspot/share/c1/c1_Compilation.cpp:340-352`
- `src/hotspot/share/c1/c1_Compilation.cpp:285-316`
- `src/hotspot/share/c1/c1_Compilation.cpp:408-422`

## 5. 完成后 review

- 能否复述 C1 快在“先显式化，再快速降级”
- 是否讲清 ValueStack / Phi / HIR/LIR 分工
- 是否讲清 LinearScan 与 bailout
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验