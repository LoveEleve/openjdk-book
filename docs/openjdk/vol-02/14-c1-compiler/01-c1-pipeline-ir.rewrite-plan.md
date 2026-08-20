# 14-c1-compiler/01-c1-pipeline-ir 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C1 为什么能比 C2 更快出结果，以及它如何把“隐式栈机器字节码”迅速降成“显式数据流图 → LIR → 机器码”的低延迟流水线

## 1. 选题判断

现稿已经覆盖关键事实：
- 真正主流程在 `Compilation::compile_method` / `compile_java_method`
- 三大步：`build_hir` / `emit_lir` / `emit_code_body`
- `GraphBuilder` 逐字节码建图
- `append_with_bci` 里 `Canonicalizer + LocalValueNumbering`
- `ValueStack` 用 `Value` 引用而不是“真正装值”
- `Phi`、`BlockBegin`、`Instruction` 层次

但主线仍偏“结构说明书”：先列三步、再列 GraphBuilder、再列 HIR 节点层次。读者可能知道部件名，却未必真正打通这两个问题：

**Tiered 策略说“现在该去 C1”之后，C1 为什么能比 C2 快一个量级？以及，基于栈式字节码的 Java 方法，怎么会被 C1 很快翻成一张可优化、可寄存器分配、可发机器码的图？**

这是本篇真正的核心困惑。

## 2. 一句话顿悟

**C1 的速度不是“少做一点优化”这么简单，而是来自一条为低延迟量身设计的三段式降级流水线：先把字节码的隐式栈语义显式化成 HIR 图，在建图时顺手做最便宜的规范化与局部去重；再把图线性化成 LIR，并用速度优先的 LinearScan 做寄存器分配；最后由 LIR_Assembler 直接发机器码并补齐异常、去优化和安装入口。它不是小号 C2，而是一台围绕“快出结果、必要时立刻 bailout”设计的编译器。**

## 3. 总图

```text
字节码（隐式栈机器）
  │
  ├─ build_hir
  │    ├─ GraphBuilder 预扫块边界 + 逐字节码建图
  │    ├─ Canonicalizer / LVN 即时生效
  │    └─ HIR：显式 def-use + Block/Phi/StateSplit
  │
  ├─ emit_lir
  │    ├─ LIRGenerator 线性扫描序生成 LIR
  │    └─ LinearScan 分配寄存器
  │
  └─ emit_code_body
       ├─ LIR_Assembler 发码
       ├─ 补慢路径/异常/去优化/展开入口
       └─ install_code -> nmethod
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么 Tiered 一选 C1，结果很快就能出来

目标约 1300 字。

- 从上一篇“下一跳到 level 3”接过来
- 点出：C1 快不只是“优化少”，而是管线更短、表示切换更早、随时可 bailout
- 埋主线：先显式化，再快速降级

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. C1 只是“删减版 C2”
2. 字节码到机器码只是顺序翻译

结论：
- C1 的快来自整体架构，不是简单阉割 C2
- 栈式字节码必须先显式化成图，否则连基本数据流都不利于后续处理

### 第三节：真实管线——核心不是“六步”，而是三大步

目标约 1800 字。

- `compile_method` / `compile_java_method`
- `build_hir`
- `emit_lir`
- `emit_code_body`
- bailout 点分布的意义

### 第四节：`build_hir` 不只是建图，它是 C1 前端的大部分实质工作

目标约 2100 字。

- `IR(this, method(), osr_bci)`
- `optimize_blocks`
- `split_critical_edges`
- `compute_code`
- GVN / RCE / null-check elimination / use counts
- 强调：这些仍属于“把图准备到可以后端消费”的前端整理阶段

### 第五节：GraphBuilder 的本质——把隐式操作数栈翻成显式 def-use 图

目标约 2300 字。

- 预扫基本块边界
- 控制流节点：goto/if/return/throw
- `append_with_bci`
- Canonicalizer 即时生效
- Local Value Numbering 即时生效
- InstructionCountCutoff bailout
- StateSplit / exception handlers

### 第六节：为什么 `iload` 看起来几乎“不生成指令”——`ValueStack` 才是真翻译器

目标约 1900 字。

- locals/stack 里装的是 `Value`（`Instruction*`）
- load/store 只是搬引用，不是一定生成 IR 节点
- `Phi` 在块入口建立 SSA 风格合流
- 让读者真正看懂“栈机器 → 图机器”的转变

### 第七节：HIR 图上到底长什么——节点层次与 Block/StateSplit 的位置

目标约 1700 字。

- `Instruction.hpp` 层次
- `Value = Instruction*`
- `BlockBegin` / `BlockEnd`
- `StateSplit` / `Invoke` / `If` / `Goto` / `Return` / `Throw`
- 图不是 AST，而是数据流+控制流混合体

### 第八节：LIR 与 LinearScan——为什么 C1 后半程选择“够快”的表示与分配器

目标约 1700 字。

- `emit_lir`
- `hir()->iterate_linear_scan_order(&gen)`
- `LinearScan::do_linear_scan`
- 强调其角色：为速度服务，而不是追求最强寄存器分配质量

### 第九节：发码与收尾——快编译器也得补齐异常、去优化和安装

目标约 1400 字。

- `emit_code_body`
- `emit_code_epilog`
- slow stubs / exception / deopt / unwind
- `install_code`
- 说明 C1 快，但不是粗糙

### 第十节：误解清单与收网

目标约 1200 字。

至少回答：
1. C1 是否只是关掉一些优化的 C2
2. GraphBuilder 是否只是线性翻译字节码
3. Canonicalizer 是否是独立阶段
4. `iload`/`istore` 是否总要生成 IR 节点
5. LinearScan 是否只是一个后端细节，与 C1 快慢无关

## 5. 失败方案必须写进正文

1. 把 C1 理解成“小号 C2”
2. 认为字节码可以直接顺序翻成机器码，不需要先图化
3. 认为所有规范化/去重都发生在 HIR 全部建完之后

## 6. 证据清单

- `share/c1/c1_Compilation.cpp:141-250`：`build_hir`
- `share/c1/c1_Compilation.cpp:253-282`：`emit_lir`
- `share/c1/c1_Compilation.cpp:340-367`：`emit_code_body`
- `share/c1/c1_Compilation.cpp:370-405`：`compile_java_method`
- `share/c1/c1_Compilation.cpp:408-425`：`install_code`
- `share/c1/c1_IR.cpp:125-159`：`IRScope::build_graph` / `GraphBuilder` 入口
- `share/c1/c1_GraphBuilder.cpp:1207-1296`：控制流节点示例
- `share/c1/c1_GraphBuilder.cpp:2299-2358`：`append_with_bci`
- `share/c1/c1_GraphBuilder.cpp:2374-2405`：`NullCheck` / exception handlers
- `share/c1/c1_ValueStack.cpp:176-191`：`Phi` 构造
- `share/c1/c1_Instruction.hpp:48-117`：节点层次与 `Value`
- `share/c1/c1_IR.cpp:1223`：`iterate_linear_scan_order`
- `share/c1/c1_LIRAssembler.cpp:102-112`：`LIR_Assembler` 角色
- `share/c1/c1_LinearScan.cpp` 与 `do_linear_scan` 调用位：后端分配角色

## 7. 必须明确的边界

- 基于 JDK 11u C1 实现
- 本篇聚焦前端表示转换和总体流水线，不深入 C1 优化细节（放到下一篇）
- 不把 LIR/LinearScan 讲成完整后端教材，只讲它们在“快编译”设计中的位置
- PrintIR/PrintLIR 等若只在 debug 或特定构建下可用，要明确边界

## 8. 完成后 review

- 删除代码后，能否复述“C1 快在显式化+快速降级流水线，不是简单少做优化”
- 是否把“隐式操作数栈 → 显式 def-use 图”的转变讲透
- 是否区分清楚了：建图期即时规范化、HIR 后续整理、LIR 降级、发码安装 各自的角色
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
