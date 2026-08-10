# Assembler（汇编器）— 文章大纲（Pass 1 修订版）

> vol-01 · 域 02 · 🔴 A（Hub 升级）| 拓扑排序 #2 | 基于 Pass 0+1 探索笔记修订
> Pass 1 产出：7 基本元素 / 4 层继承 / 7 标记问题

## 概念依赖

本域依赖 OS 抽象层（CodeBuffer 用 `os::malloc` 分配内存）。不依赖 JVM 内部其他域。

## 叙事计划

**开篇场景**：`javac` 把 `.java` 变成 `.class`，但 `.class` 里的 `iload`、`iadd` 还是给人看的符号。CPU 只认识一串字节：`83 C0 2A`（`add eax, 42`）。中间缺少一层翻译——Assembler 就是这个翻译器。HotSpot 里它有两层、1446 个方法、20000 行代码。

**第一层：继承体系——为什么有两层**

`AbstractAssembler`（管 CodeBuffer）→ `Assembler`（管指令编码，890 方法）→ `MacroAssembler`（管高层汇编，556 方法）。MacroAssembler 继承 Assembler，Assembler 继承 AbstractAssembler。

为什么分两层？890 个 `emit_byte/emit_word` 是"原子操作"——一条 x86 指令可能对应多字节编码，每个字节都是手工拼的。556 个 `movl/addl/jmp` 是"分子操作"——封装常见的指令组合和平台特定优化。上层调用方只通过 MacroAssembler 工作，不知道底层 `0x83` 是 `ADD r/m32, imm8`。

**第二层：寄存器与寻址——机器码的积木**

`Register`（`assembler_x86.hpp:354`）和 `Address`（`assembler_x86.hpp:389`）是组装机器码的最小积木。`Address(base, index, scale, disp)` 对应 x86 的 `base + index*scale + displacement` 寻址模式——`movl(rax, Address(rsp, rdi, 4, 16))` 变成 `8B 44 BC 10`。Register 定义区分调用约定角色：`c_rarg0` 是 C 调用约定第 0 个参数，`j_rarg0` 是 Java 调用约定第 0 个参数——名字不同但指向同一个物理寄存器。

**第三层：指令怎么变成字节**

`addl(Register dst, int32_t imm32)`（`assembler_x86.hpp:920`）内部：
1. 查 Intel 手册选操作码（`83` = ADD r/m32, imm8；`81` = ADD r/m32, imm32；`05` = ADD EAX, imm32）
2. 选最短编码——立即数 ≥ `-128` 且 ≤ `127` 时用 3 字节 `83` 版，不必用 6 字节 `81` 版
3. `emit_byte(opcode)` → `emit_byte(ModR/M)` → `emit_int32(imm)`
4. 每个 `emit_*` 把字节追加到 CodeBuffer 的 `SECT_INSTS` 段

x86 的变长编码给了选择空间——HotSpot 选最短的。但选择逻辑本身也有开销，所以在热路径上 MacroAssembler 有时直接跳过判断，用预知的编码。

**第四层：Label——补丁系统与踩过的坑**

`jmp(L)` 时 L 还没绑定（跳到后面还没生成的代码）：`jmp` 先写 `0xE9 00 00 00 00`（5 字节占位），把这条指令地址记到 `Label._patches[0..3]`。`PatchCacheSize=4`，超出放进 `GrowableArray<int>* _patch_overflow`。等 `bind(L)` 时，遍历所有 pending 引用，用 `patch_instruction()` 回填真实偏移。

这个系统是 bug 高发区——JDK-8206075/8208480/8209511 三次修复同一个问题模式：Label 被当作跳转目标用了但从未被 bind，导致 assert 崩溃。根因是生成的代码路径中有些分支在特定编译条件下不可达——但汇编器不知道该分支是否会被优化掉。

**第五层：CodeBuffer——三段式代码容器**

`CodeBuffer`（`codeBuffer.hpp:80-97`）管理 `SECT_INSTS`（指令）、`SECT_STUBS`（桩程序——outbound trampoline）、`SECT_CONSTS`（数据——浮点常量、跳转表）。每段独立地址空间和 `_frozen` 冻结状态。段之间预留间隙（slop）用于对齐 CPU 缓存行。

JDK-8284620：CodeBuffer 的 `_overflow_arena` 在扩展失败后未正确释放——内存泄漏。说明扩展路径是很少触发的边界 case。

**第六层：Relocation——机器码的元数据注释**

`RelocationInfo`（`relocInfo.hpp:37-56`）是压缩数组——用 halfword 编码节省空间。每条记录"代码地址 + 含义"：`runtime_call_type`（调用的 runtime 函数）、`external_word_type`（引用的外部地址）、`oop_type`（引用的对象指针）。`call_literal(entry.target(), entry.rspec())` 写 call 指令时同步追加 relocation。

JDK-8248901：signed immediate 在 relocation 编码中有 bug——立即数的符号位处理错误导致地址计算偏移。

**第七层：Java 调用约定的偏移技巧**

`j_rarg0` = `c_rarg1`（`assembler_x86.hpp:108`）——Java 参数寄存器故意偏移一位。`c_rarg0` 留给 `JNIEnv*`，Java 第 0 个参数对齐 C 第 1 个参数。Linux 有 6 个 c_rarg (`rdi/rsi/rdx/rcx/r8/r9`)，Windows 只有 4 个——`j_rarg3` 在 Windows 上是 `rdi`（借用一个不用的 c 寄存器）。

**设计权衡**

一、两遍汇编 vs 前向引用补丁。两遍汇编实现简单但慢。HotSpot 选补丁方案，代价是 Label 数据结构复杂，边界 case 是 bug 高发区。

二、MacroAssembler 分离。不只是一个命名便利层——封装了平台特定的优化（64 位立即数加载拆成两条 `mov`、特定条件下跳过编码选择判断）。调用方只调 MacroAssembler，不知道指令编码细节。

三、Relocation 压缩编码。省空间 vs 编解码开销。halfword 编码在常见 relocation 类型上足够——不需要完整 8 字节指针。

## 核心悬念

**Java 的 `a + b`，最后怎么变成 CPU 认识的 `83 C0 2A`？一个 1446 方法的翻译器是怎么把"给人看的指令"变成"CPU 认识的字节"的？**

**→ 下一域**：机器码有了，但操作的是谁？`movl(rax, Address(rsp, rdi, 4, 16))` 里的 `rax` 对应 Java 对象的哪个字段？偏移量 `16` 是怎么算出来的？要回答这些问题，先得理解 Java 对象在 JVM 眼里长什么样。OOPs 篇见。

## 预估

1 篇，7 层递进，预估 2500-3500 行。
