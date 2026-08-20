# 02-assembler/04-x86-macroassembler-runtime 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：把 MacroAssembler 从“工具函数列表”重写成“如何把指令、ABI、线程状态、GC 和异常拼成运行时模板”的专题文

## 1. 选题判断

本篇值得独立成篇。

统一问题：

**单条 x86 指令只能做局部动作，JIT 生成的代码如何安全进入 C++ VM、让 GC 找到 Java 栈、在 safepoint 检查、处理压缩 oop，并把硬件 intrinsic 拼成完整运行时路径？**

## 2. 一句话顿悟

**MacroAssembler 不是更大的 Assembler，而是把“机器指令 + ABI + JavaThread 状态 + GC/异常协议”封装成可复用运行时模板的边界层。**

## 3. 结构大纲

### 第一节：为什么 Assembler 还不够

- 单条 mov/call 不等于安全的 Java→C++ 调用
- 进入 C land 前需要登记 last Java frame
- 运行时模板必须维护线程、栈、异常与 GC 约束

### 第二节：call_VM——JIT 到 C++ 的调用桥

- 中间 call 的返回地址作用
- JavaThread 作为参数
- set_last_Java_frame / reset_last_Java_frame
- ABI 与 caller/callee-saved 边界
- exception check 与 oop result
- call_VM 与 call_VM_leaf 的边界

### 第三节：safepoint 与栈保护模板

- thread-local poll 与全局 poll 的分支
- 方法入口/回边的低成本检查
- `verified_entry` 为什么至少 5 字节
- stack banging 与 shadow zone
- patch entry 与 safepoint 之间的不同职责

### 第四节：压缩 oop——数据表示如何变成指令模板

- zero-based 与 heapbase 两种模式
- encode/decode 的数学
- null 的特殊编码
- r12_heapbase 的长期寄存器约束
- load/store heap oop 与 GC barrier 的边界

### 第五节：硬件 intrinsic——MacroAssembler 如何拼 AES/SHA/Math 模板

- CPU capability → flag → 模板选择
- AES/SHA 指令展开
- Math intrinsic 与 StubRoutines 的关系
- “硬件加速”不是 Java API 变化，而是实现路径替换

### 第六节：收网——运行时模板的完整边界

```text
JIT 语义
  → MacroAssembler 模板
  → 保存寄存器/帧与 JavaThread 状态
  → 进入 VM/native
  → 恢复 last Java frame / 检查异常
  → 继续机器码或跳异常路径
```

## 4. 必须展开的失败方案

1. 直接 call C++，不登记 last Java frame
2. 直接把 JavaThread 之外的参数按普通 C ABI 传递
3. 每个入口都用复杂 safepoint 检查
4. 压缩 oop 只做 shift，不处理 heap base/null
5. 不检查 CPU 能力直接展开 AES/SHA
6. 把 MacroAssembler 的 debug verify 代码误认为生产路径

## 5. 证据清单

- `macroAssembler_x86.cpp:2311-2325`：`call_VM`
- `:2482-2526`：`call_VM_base`
- `:2579-2598`：`call_VM_helper`
- `:3744-3758`：`safepoint_poll`
- `:5839` 附近：`verified_entry`
- `assembler.cpp:121-151`：stack banging
- `macroAssembler_x86.cpp:5536-5624`：压缩 oop encode/decode
- `macroAssembler_x86_aes.cpp`：AES 模板
- `macroAssembler_x86_sha.cpp`：SHA 模板

## 6. 版本边界

- 基于 OpenJDK 11u x86_64 HotSpot
- thread-local poll 与旧全局 polling page 必须明确区分
- `call_VM` 的 ABI 描述限定 Linux System V AMD64
- 压缩 oop/null 编码依赖堆布局与 JVM flags
- AES/SHA/Math intrinsic 是否启用依赖 CPU 特性、flags 和调用路径

## 7. 字数预算

- 正文目标：`10000-14000`
- 叙述性正文目标：`7000+`

## 8. 完成后 review

- 删除代码后能否复述完整运行时调用链
- 是否区分 Assembler、MacroAssembler、StubRoutines 和 VM runtime
- 是否把 thread-local poll 写成当前实现而非沿用旧信号页模型
- 是否明确生产路径与 ASSERT/debug verify 路径
- 是否核实 ABI、压缩 oop、intrinsic 的版本和平台边界
