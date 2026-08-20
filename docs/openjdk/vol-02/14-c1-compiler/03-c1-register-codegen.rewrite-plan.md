# 14-c1-compiler/03-c1-register-codegen 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C1 后端如何在“虚拟值无限、物理寄存器有限、还要保留 GC/异常/去优化语义”的约束下，用 LIR + LinearScan 快速落到机器码

## 1. 选题判断

现稿已经抓到关键事实：
- LinearScan 的流程
- Interval/Range 链
- spill 与 split
- LIRAssembler 发码
- EdgeMoveOptimizer / ControlFlowOptimizer
- x86 peephole 不是主要优化点

但仍偏“实现清单”。真正读者困惑应更集中：

**HIR 里的 Value 数量没有硬上限，真实 CPU 寄存器却很少；C1 还不能简单把多余值扔掉，因为 GC、异常、调用和去优化都要求状态可恢复。它如何在极短编译时间里，把虚拟值安置到寄存器或栈，并最终安全地发成机器码？**

## 2. 一句话顿悟

**C1 后端不是把每个 HIR 值直接“塞进寄存器”，而是先把 LIR 操作数的生命周期压成 Interval/Range，再用 LinearScan 按线性位置快速分配寄存器；冲突时选择下次使用更晚的占用者 spill，并通过 split、spill slot、block edge move 把值在寄存器与栈之间接起来。随后 LIR_Assembler 只负责把已经解决资源位置的低层操作逐条发成机器码，同时保留 oopmap、异常、patching、去优化等 JVM 运行时接口。**

## 3. 总图

```text
HIR
  │
  ├─ LIRGenerator
  │    └─ HIR value -> LIR operand/op
  │
  ├─ LinearScan
  │    ├─ live sets
  │    ├─ Interval/Range
  │    ├─ register allocation
  │    ├─ spill/split
  │    ├─ data-flow resolve moves
  │    └─ EdgeMove/ControlFlow cleanup
  │
  └─ LIR_Assembler
       ├─ LIR op -> target instruction
       ├─ call/patch/safepoint info
       ├─ exception/deopt/unwind stubs
       └─ CodeBuffer -> nmethod
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——虚拟值无限，CPU 寄存器有限

目标约 1300 字。

- 从 HIR/LIR 的 Value 与物理寄存器冲突开场
- 点出寄存器分配不是简单编号映射
- 引出 spill/split 与 JVM 运行时状态约束

### 第二节：两个朴素办法为什么都不行

目标约 1800 字。

必须推演：
1. 每个虚拟值永久占一个物理寄存器
2. 冲突时随便选一个值丢掉/统一全部 spill

结论：
- 寄存器数量有限，永久绑定不可能
- 全 spill 会破坏 C1 快速代码质量与性能
- 正确答案需要生命周期分析与启发式安排

### 第三节：LIR 为什么是必要的中间层

目标约 1500 字。

- `LIRGenerator`
- HIR 仍是高层语义，机器码还太早
- LIR 把操作、寄存器/栈操作、调用、barrier、patching 约束显式化
- 线性扫描只对这种低层操作序列工作

### 第四节：LinearScan 的全流程——先知道谁活着，再决定放哪

目标约 2200 字。

- `do_linear_scan`
- instruction numbering
- local/global live sets
- build/sort intervals
- allocate registers
- resolve data flow
- spill slots/frame size
- EdgeMoveOptimizer / ControlFlowOptimizer

### 第五节：Interval 为什么不是一个简单 `[start,end]`

目标约 1900 字。

- Range 链
- 分支造成的非连续活跃区间
- split children
- register/spill 交替
- 为什么区间结构是 spill 成本可控的关键

### 第六节：寄存器冲突时怎么选 spill 对象

目标约 1900 字。

- free register / locked register 两条路径
- `_use_pos` 而不是单纯 end
- 下次使用越晚，当前占用者越适合被挤走
- spill 与 reload 的代价

### 第七节：为什么 block edge move 是必需的

目标约 1500 字。

- 同一 Value 在不同块落在不同位置
- resolve_data_flow
- edge move 合并与冗余消除
- 异常处理器独立 resolve

### 第八节：LIR_Assembler 发码——后端不是简单 opcode 翻译

目标约 1900 字。

- `emit_code` / `emit_block` / `emit_lir_list`
- LIR 操作数形态决定目标指令形态
- 调用、patch、oopmap、CodeEmitInfo
- x86 peephole 空实现边界

### 第九节：快发码仍要保留 JVM 语义

目标约 1400 字。

- slow stubs / exception / deopt / unwind
- patching 与 reexecute
- C1 后端为什么不能只关注算术指令

### 第十节：误解清单与收网

目标约 1200 字。

至少回答：
1. LinearScan 是否只是一趟简单顺序分配
2. Interval 是否简单 `[first,last]`
3. spill 是否等于永久放栈
4. LIRAssembler 是否只是 opcode 翻译器
5. x86 peephole 是否负责主要 LIR 优化

## 5. 失败方案必须写进正文

1. 每个虚拟值永久占一个物理寄存器
2. 冲突时所有值统一 spill 到栈
3. LIR 发码阶段再临时解决全部寄存器与运行时状态问题

## 6. 证据清单

- `share/c1/c1_Compilation.cpp:253-274`：LIR 生成与 LinearScan 调用
- `share/c1/c1_LinearScan.cpp:3100-3162`：完整 LinearScan 流程
- `share/c1/c1_LinearScan.cpp:...`：Interval/Range/allocate/spill 具体实现，正文沿现稿有效引用补齐
- `share/c1/c1_IR.cpp:1223-1224`：线性扫描顺序
- `share/c1/c1_LIRAssembler.cpp:102-112`：LIRAssembler 状态
- `share/c1/c1_LIRAssembler.cpp:...`：emit_code/emit_block/emit_lir_list
- `share/c1/c1_LIR.cpp:33-41`：LIR operand 到物理寄存器映射
- `share/c1/c1_Runtime1.hpp:48-65`：Runtime1 stubs 入口类别

## 7. 必须明确的边界

- 基于 JDK 11u C1 + x86_64；x87 FPU stack 只作为非主路径边界说明
- 本篇聚焦寄存器分配、LIR 与发码，不深入 Runtime1/FrameMap（下一篇）
- 不把 LinearScan 写成通用寄存器分配理论教程，只解释 C1 的具体权衡
- x86 peephole 空实现与 EdgeMove/ControlFlow 优化的边界要明确

## 8. 完成后 review

- 删除代码后，能否复述“LinearScan 解决的是有限寄存器下的生命周期安置，不是简单编号映射”
- 是否把 Interval、spill/split、edge move、LIRAssembler 收回到同一个约束上
- 是否明确区分了资源位置解决与机器码发出两个阶段
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
