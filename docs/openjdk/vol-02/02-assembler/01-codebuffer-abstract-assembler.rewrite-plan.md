# 02-assembler/01-codebuffer-abstract-assembler 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：把 CodeBuffer、AbstractAssembler、Label、对齐填充统一成“机器码生成器如何在未知最终地址时安全地产出代码”的专题文

## 1. 选题判断

本篇值得独立成篇，但不能写成类字段说明。

统一问题：

**JIT 还不知道最终代码要放到哪里、前向跳转目标在哪里、常量和 stub 要占多少空间，为什么已经可以逐字节生成一段最终可执行代码？**

统一主线：

- CodeBuffer 管理空间和 section
- AbstractAssembler 把抽象动作落成字节、位置和重定位
- Label 让未知目标先留下补丁点
- 对齐和 NOP 保证机器码布局可执行、可反汇编、可后续修补

## 2. 读者困惑

- `__ fast_sin()` 这样的 C++ DSL 最终写到哪里
- 为什么代码、常量、stub 要分区
- 生成时不知道跳转目标，为什么不需要先构建完整 CFG
- 机器码扩容或搬迁后，位置和重定位如何不失效
- 为什么 NOP 填充也要考虑 patch-safe

## 3. 一句话顿悟

**CodeBuffer 不是简单字节数组，而是一张带分区、位置身份证和重定位信息的机器码草稿纸；Assembler 写入字节，Label 记录未来补丁，最终这些中间位置才被解析成真实地址。**

## 4. 结构大纲

### 第一节：事故开场——机器码生成时，三个地址都还不知道

- 代码最终放入 CodeCache 的地址未定
- 常量与 stub 的最终位置未定
- 前向跳转目标未生成
- 但 JIT 不能停下来等所有信息齐全

### 第二节：CodeBuffer——不是数组，而是三节可扩容布局

- consts / insts / stubs 的角色
- CodeSection 的 start/end/limit 与 relocation 区
- locator 如何把 section 与 offset 编成稳定位置
- section freeze、空间分配、BufferBlob 扩容与搬迁
- 为什么不能只用一个连续字节数组

### 第三节：AbstractAssembler——平台无关的字节、位置和重定位层

- `emit_int8/16/32/64`
- `pc/offset/locator`
- 为什么 AbstractAssembler 不理解 x86 指令
- relocation 标记为什么必须在指令边界
- OopRecorder 与运行时 GC/链接消费关系

### 第四节：Label——未知前向目标如何先写后补

- unused/unbound/bound 三态
- 4 项 patch cache 与 GrowableArray 溢出
- 已绑定时立即计算短跳/长跳
- 未绑定时先发长格式和占位 displacement
- bind 时 `patch_instructions`
- 为什么不能直接发短跳：目标距离尚未证明

### 第五节：对齐与 NOP——填充字节也有机器码纪律

- CodeEntryAlignment
- debug 版单字节 NOP 与 product 版多字节 NOP
- 为什么 `0F 1F 00` 对 patch 不安全
- 对齐、反汇编、指令解码和修改安全的权衡

### 第六节：收网——从 DSL 到可执行机器码的完整时间线

```text
CodeBuffer 分区
  → AbstractAssembler 发射字节
  → relocation 记录外部引用
  → Label 登记未知跳转
  → bind 回填补丁
  → section 对齐/冻结
  → CodeCache/nmethod 接管最终代码
```

## 5. 必须展开的失败方案

1. 只用一个 byte array：无法表达 section 生命周期与重定位边界
2. 生成前先计算所有最终地址：与增量发射和动态 stub 不兼容
3. 前向跳转直接发短跳：目标距离未确定，可能溢出
4. 每个架构重新实现 buffer/label/relocation：基础设施重复且行为不一致
5. 对齐只填 `0x90` 或随便填零：可能影响解码和 patch-safe

## 6. 必须澄清的误解

- CodeBuffer 通常是 StackObj 描述器，不等于最终 CodeCache 内存本身
- `pc()` 是当前 section 的写入位置，不是最终 nmethod 的永久地址
- locator 不是裸偏移，而是 section + position 编码
- AbstractAssembler 不负责完整 x86 指令编码
- Label 的 patch cache 是优化，不是补丁语义本身
- 前向跳转先发长格式是保守策略，不代表最终一定只能长跳
- NOP 对齐不是纯空白填充，也受重定位/补丁约束

## 7. 证据清单

- `codeBuffer.hpp:353-373`：section 枚举和成员
- `codeBuffer.hpp:203`：`emit_int8`
- `codeBuffer.hpp:514-517`：locator 编码
- `codeBuffer.cpp:160-196`：section 分配/freeze
- `codeBuffer.hpp:449` 附近：expand
- `assembler.hpp:209-320`：AbstractAssembler 字节与位置
- `assembler.hpp:330-338`：relocate
- `assembler.hpp:64-93`：Label patch cache
- `assembler.hpp:78-83`：Label 状态
- `assembler_x86.cpp:2104-2135`：jcc 与前向补丁
- `assembler.cpp:111-119`：bind
- `assembler_x86.cpp:3111-3131`：NOP

## 8. 字数预算

- 正文目标：`9000-13000`
- 叙述性正文目标：`6000+`

## 9. 完成后 review

- 删除代码后能否复述“空间—字节—位置—补丁—最终代码”链路
- 是否把 CodeBuffer 写成机制而不是字段表
- 是否区分当前写入地址与最终执行地址
- 是否核实扩容/搬迁和 relocation 边界
- 是否明确 x86 特例与平台无关层边界
- 是否完成禁用词、版本边界、file:line 和总图检查
