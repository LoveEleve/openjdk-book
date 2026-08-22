# 14-c1-compiler/03-c1-register-codegen 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C1 后端如何把 LIR 虚拟值安置到有限寄存器/栈槽：LinearScan 的生命周期分析、spill/split/reload、边 move 修正，以及 LIR_Assembler 为什么只负责编码不再做资源决策

## 1. 核心困惑

**HIR 已经降成 LIR 了，为什么还不能直接发码？为什么寄存器分配必须先把“谁在什么时候活着”算清楚？spill/split 与边 move 到底在修什么？LIR_Assembler 又为什么不能顺手把这些资源冲突都临时解决掉？**

## 2. 一句话顿悟

**C1 先把 HIR 操作降成 LIR，再把每个 LIR 操作数的生命周期压成 Interval/Range；LinearScan 按线性位置快速分配寄存器，冲突时用 spill、split 和 reload 把值暂时放到栈上；最后 LIR_Assembler 只负责把已经解决资源位置的低层操作逐条发成机器码，并补齐 patch、oopmap、异常和去优化接口。**

## 3. 结构

1. 开场：虚拟值怎么落到机器
2. 三个错误办法：永久占寄存器 / 全丢栈 / 发码时临时解决
3. LIR 是必要的中间层
4. LinearScan 全流程
5. Interval/Range 与 split
6. 冲突选择与 spill slot
7. block edge move
8. LIR_Assembler 与 JVM 语义
9. 收网

## 4. 证据清单

- `src/hotspot/share/c1/c1_Compilation.cpp:253-270`
- `src/hotspot/share/c1/c1_LinearScan.cpp:3100-3154`
- `src/hotspot/share/c1/c1_LinearScan.cpp:5504-5522`
- `src/hotspot/share/c1/c1_LinearScan.cpp:5792-5826`
- `src/hotspot/share/c1/c1_LinearScan.cpp:214-260`
- `src/hotspot/share/c1/c1_FrameMap.cpp:54-97`
- `src/hotspot/share/c1/c1_FrameMap.cpp:186-214`
- `src/hotspot/share/c1/c1_LIRAssembler.cpp:37-97`
- `src/hotspot/share/c1/c1_LIRAssembler.cpp:214-275`
- `src/hotspot/cpu/x86/c1_MacroAssembler_x86.cpp`

## 5. 完成后 review

- 能否复述“资源位置先于发码被解决”
- 是否讲清 Interval/Range + split + edge move
- 是否讲清 LIR_Assembler 不是第二个分配器
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验