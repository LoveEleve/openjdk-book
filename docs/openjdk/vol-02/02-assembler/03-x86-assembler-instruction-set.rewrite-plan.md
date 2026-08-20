# 02-assembler/03-x86-assembler-instruction-set 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：把 x86 指令家族从编码目录重写成“JIT 如何用少量原语拼出 Java 运行时语义”的专题文

## 1. 选题判断

本篇值得独立成篇，但不应试图罗列 400 多条指令。

统一问题：

**Java 的赋值、算术、分支、调用、CAS、浮点运算和内存屏障，为什么最终都能压缩成一小组 x86 指令家族？Assembler 如何把这些家族组织成可复用的编码模板？**

主线：

- 数据搬运：mov / movzx / movsx / lea
- 算术与原子：emit_arith / lock / cmpxchg
- 控制流：jmp / call / 条件分支与 relocation
- SIMD 与屏障：SSE/AVX / mfence

## 2. 读者困惑

- `a = b`、`x++`、`if`、方法调用分别落成什么机器码
- 为什么同一语义有多个编码版本
- 为什么立即数宽度会改变指令长度
- `lock cmpxchg` 如何从两个发射动作变成 JVM CAS
- SSE 的破坏性操作数与 AVX 的三操作数有什么实际差异

## 3. 一句话顿悟

**Assembler 不是把 Java 语句逐句翻译成唯一指令，而是根据操作数宽度、地址形式、分支距离、CPU 能力和内存语义，从少数 x86 指令模板中选择最合适的编码。**

## 4. 结构大纲

### 第一节：事故开场——400 多条指令，JIT 为什么只反复用一小撮

- Java 语义多，但底层需求集中在搬运、算术、控制流、原子和屏障
- 指令集不是字典，而是模板族
- 本篇讲“选择逻辑”，不做指令百科

### 第二节：mov/lea——数据搬运与地址计算

- 宽度后缀 b/w/l/q
- movzx/movsx 如何把窄值扩展
- cmov 用执行换分支预测
- lea 不访问内存，只做 base + index*scale + disp
- 失败方案：所有条件都用 jcc、所有地址计算都用 mov/add

### 第三节：算术与原子——一条指令如何成为并发原语

- emit_arith 统一操作码家族
- imm8 与 imm32 选择
- imul/idiv 的隐含操作数约束
- lock 前缀 + cmpxchg
- 失败方案：软件锁/CAS 循环与硬件原子边界

### 第四节：jmp/call——控制流、距离和 relocation

- jmp rel8/rel32/寄存器间接
- 前向跳转为什么长格式
- jmpb/jccb 的手动短跳
- call rel32 + relocation 类型
- 与上一篇 Label/CodeBuffer 的关系

### 第五节：SSE/AVX 与屏障——硬件能力改变指令语义

- `addsd` 的 SSE 破坏性操作数
- AVX/VEX 的独立源操作数
- UseAVX/CPU capability 选择
- `mfence/lfence/sfence` 的 JVM 语义边界
- 不能把 x86 TSO 和所有平台内存模型混为一谈

### 第六节：收网——Assembler 是模板选择器，不是逐句翻译器

完整时间线：

```text
Java/JIT 语义
  → 选择操作数宽度、寻址、CPU 能力、控制流形式
  → Macro/Assembler 选择指令模板
  → emit opcode/prefix/ModR/M/imm
  → relocation/Label/CodeBuffer 托底
  → nmethod
```

## 5. 必须展开的失败方案

1. 每种 Java 语义只绑定一条固定 x86 指令
2. 所有立即数都使用最大宽度
3. 所有条件判断都用分支
4. CAS 只靠普通 load/store
5. SSE/AVX 不考虑 CPU 能力和破坏性操作数
6. 把 `mfence` 解释成所有平台通用屏障

## 6. 证据清单

- `assembler_x86.cpp:2289-2310`：mov 基础家族
- `:3023-3047`：movzx/movsx
- `:8105-8112`：lea
- `:1587-1600`：cmov
- `:257-269`：emit_arith
- `:2268-2270`：lock
- `:1646-1660` / `:8776`：cmpxchg
- `:2169-2199`：jmp
- `:1530-1552`：call
- `:1274-1283`：addsd
- `:2282-2287`：mfence

## 7. 版本与边界

- 仅讨论 OpenJDK 11u x86_64 HotSpot Assembler 实现
- 指令长度和性能数字是编码/量级示例，不是所有微架构固定延迟
- MacroAssembler 的运行时模板留给下一篇
- x86 TSO、mfence 和 JVM OrderAccess 的关系需分层说明

## 8. 字数预算

- 正文目标：`9000-13000`
- 叙述性正文目标：`6000+`

## 9. 完成后 review

- 删除代码后能否复述四类指令家族的选择逻辑
- 是否把指令写成模板/语义，而不是 opcode 目录
- 是否区分 Assembler 与 MacroAssembler
- 是否明确 x86 特例和 JVM 跨平台抽象边界
- 是否完成 file:line、禁用词、版本边界和总图检查
