# 03. x86 指令不是字典，而是一组 JIT 运行时模板

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论
> **前置依赖**：[02 — x86 寄存器/操作数编码](02-x86-register-operand-encoding.md)：ModR/M、REX、VEX/EVEX
> → **后续**：[04 — MacroAssembler 运行时](04-x86-macroassembler-runtime.md)：把指令模板拼成完整运行时路径
> 关联域：05-cpu-primitives、13-jit、19-sync、45-math-library

## 400 多条指令，JIT 为什么只反复用一小撮

x86 指令手册里有几百条指令：

- 字符串操作
- 系统指令
- MMX/SSE/AVX
- 浮点与整数算术
- 原子与内存序列化
- 跳转、调用和返回

但 Java 方法编译成机器码时，并不是把这几百条指令平均用一遍。

JIT 最常反复做的事情其实很集中：

```text
搬数据       → mov / movzx / movsx / lea
算术         → add / sub / imul / idiv
比较与分支   → cmp / test / jcc / cmov
调用与返回   → call / jmp / ret
并发原语     → lock + cmpxchg
浮点/SIMD    → SSE / AVX
内存序       → mfence / lfence / sfence
```

所以本篇不做 x86 指令百科。

真正的问题是：

**Java 的赋值、算术、分支、方法调用、CAS、浮点运算和内存屏障，为什么都能压缩成这么一小组指令家族？Assembler 又如何根据操作数宽度、地址形式、分支距离和 CPU 能力，从家族中挑出具体编码？**

先记住一个总判断：

**Assembler 不是把每条 Java 语句绑定到唯一一条 x86 指令，而是在一组指令模板中做选择。**

选择依据包括：

- 操作数是 8/16/32/64 位
- 源和目标在寄存器还是内存
- 立即数是否能缩短
- 跳转目标距离是否已知
- CPU 是否支持 SSE2、AVX、EVEX
- 这条操作需要普通计算、原子性还是内存序

上一篇讲的是“操作数如何编码成 ModR/M、REX、VEX 和 EVEX”。这一篇往上走一层，观察这些编码如何被组织成 Java 运行时真正需要的指令模板。

---

## 一、mov/lea：数据搬运和地址计算不是一回事

### 1.1 `a = b` 为什么通常从 mov 开始

Java 代码里的赋值、参数搬运、字段读写、对象引用转移，都会大量落到数据移动。

最基础的 x86 语义就是：

```text
源操作数 → 目标操作数
```

HotSpot 的 `mov` 并不是一条固定编码，而是一整个家族：

- 寄存器到寄存器
- 内存到寄存器
- 寄存器到内存
- 立即数到寄存器
- 不同数据宽度

源码里高层的 `mov(Register dst, Register src)` 会根据平台选择 `movq` 或 `movl`：

```cpp
// assembler_x86.cpp:2289-2291
void Assembler::mov(Register dst, Register src) {
  LP64_ONLY(movq(dst, src)) NOT_LP64(movl(dst, src));
}
```

这里已经出现一个重要的选择点：

- x86_64 下，寄存器宽度可以按 64 位路径处理
- 32 位模式下，走 32 位路径

Assembler 的职责不是解释 Java 类型，而是接收上层已经决定好的寄存器和宽度，然后发出对应编码。

### 1.2 宽度后缀不是装饰

x86 指令名里的后缀直接表达操作宽度：

```text
b  → byte，8 位
w  → word，16 位
l  → long，在 AT&T 命名习惯里通常表示 32 位
q  → quadword，64 位
```

这里的 `l` 是 x86/AT&T 命名，不是 Java 的 `long`；Java `long` 在 x86_64 上通常对应 `q` 宽度。JVM 需要处理 Java 的 byte、short、char、int、long、引用和指针，这些值的宽度不同，不可能都用同一个 `mov`。

例如从内存取一个 byte，再放进更宽的寄存器，不能只说“把它搬过来”，还要回答：

- 高位补 0，还是补符号位
- 最终结果是 32 位，还是 64 位
- 源操作数来自内存，还是已经在寄存器里

这就进入 `movzbl`、`movsbl`、`movslq` 等扩展类指令。

### 1.3 `movzx` 与 `movsx`：取窄值时顺手完成类型扩展

`movzbl` 的语义是：

```text
读取 8 位值 → 零扩展到 32 位
```

可以把它理解成接近 Java 里的：

```java
int x = byteValue & 0xff;
```

符号扩展版本 `movsbl` 则会保留符号位。

`movslq` 进一步完成：

```text
32 位整数 → 符号扩展到 64 位
```

这些指令的价值在于：

- 不需要先 load 再单独写扩展逻辑
- 扩展规则直接包含在硬件指令语义里
- JIT 可以根据 Java 类型和后续使用宽度选择对应模板

所以“mov 家族”真正表达的是一张数据转换表，而不只是“复制数据”。

### 1.4 `lea`：名字里有 load，实际上不访问内存

`lea` 很容易被初学者误解成“加载内存”。

它真正做的是把地址表达式当作算术表达式：

```text
lea dst, [rbx + rcx*4 + 8]

32 位 `leal`：低 32 位结果写入 `dst`，在 x86_64 下写入 32 位寄存器会零扩展到对应 GPR
64 位 `leaq`：`dst = rbx + rcx*4 + 8`
```

HotSpot 的入口会根据编译目标选择 `leal` 或 `leaq`。在 32 位实现中，`lea` 包装 `leal`；在 LP64 实现中，`lea` 包装 `leaq`，对应源码分别位于 `assembler_x86.cpp:8109-8111` 和 `:8938-8946`。

```cpp
// 非 LP64 路径
void Assembler::lea(Register dst, Address src) {
  leal(dst, src);
}

// LP64 路径
void Assembler::lea(Register dst, Address src) {
  leaq(dst, src);
}
```

`leal` 和 `leaq` 都不会读取 `[rbx + rcx*4 + 8]` 指向的内存，但结果宽度不同：x86_64 的 `leaq` 计算 64 位地址表达式，`leal` 使用地址大小前缀形成 32 位结果，并受 x86_64 32 位写寄存器的零扩展规则影响。因此不能只用一个不带宽度条件的 `rax = ...` 公式概括两条路径。

它们都使用 x86 地址编码里的三部分：

- base
- index * scale
- displacement

因此 `lea` 可以把多个加法和乘以 `2/4/8` 的操作压进一条指令，而且不修改 flags。

这和 `add` 有一个重要差异：

- `add` 是算术运算，会修改条件标志
- `lea` 是地址表达式计算，不读内存，也不改变 flags

所以 JIT 会根据后面是否需要 flags 选择两者。

### 1.5 `cmov`：用无条件执行换掉不可预测分支

条件选择有两种常见实现：

```text
比较
  → jcc 跳到 true/false 两条路径

比较
  → cmov 根据条件选择结果
```

HotSpot 的 `cmovl` 编码很短：

```cpp
// assembler_x86.cpp:1587-1598
void Assembler::cmovl(Condition cc, Register dst, Register src) {
  NOT_LP64(guarantee(VM_Version::supports_cmov(),
                     "illegal instruction"));
  int encode = prefix_and_encode(dst->encoding(), src->encoding());
  emit_int8(0x0F);
  emit_int8(0x40 | cc);
  emit_int8((unsigned char)(0xC0 | encode));
}
```

`0x40 | cc` 中的 `cc` 表示条件码，因此同一编码模板可以派生出 `cmove`、`cmovne`、`cmovg`、`cmovl` 等家族成员。

`cmov` 的设计取舍是：

- 条件选择通常要求候选值在选择点已经可用
- 但不需要为选择本身执行跳转
- 因此不会因为这条选择分支发生预测失败

它不是无条件更快。

如果分支高度可预测，`jcc` 可能更便宜；如果分支很难预测，`cmov` 的固定执行路径可能更稳定。

真正的选择需要结合 JIT 的 profile 和上下文，不能写成“cmov 永远优于 jmp”。

### 1.6 这一族指令的失败方案

如果所有地址计算都用：

```text
mov 临时寄存器
add 临时寄存器
imul 临时寄存器
```

就会产生更多指令和临时寄存器压力。

如果所有条件选择都用 `jcc`，不可预测分支会产生错误预测成本。

如果所有窄值读取都拆成 load + 手工扩展，编码更长，模板也更复杂。

所以 mov/lea/cmov/movzx/movsx 不是零散指令，而是围绕“数据移动、数据宽度和控制流代价”形成的一组基础模板。

---

## 二、算术与原子：从一张 opcode 表到 JVM 的 CAS

### 2.1 `emit_arith`：多个算术操作共享一套编码骨架

加法、减法、按位运算经常具有相似的 x86 编码结构。

HotSpot 不为每个变体复制一大段编码逻辑，而是用统一的 `emit_arith` 处理操作码和操作数形式。

例如 `addq(Register dst, int32_t imm32)`：

```cpp
// assembler_x86.cpp:8567-8573
void Assembler::addq(Register dst, int32_t imm32) {
  (void)prefixq_and_encode(dst->encoding());
  emit_arith(0x81, 0xC0, dst, imm32);
}
```

这里的 `0x81`、`0xC0` 和 `imm32` 共同组成一个“寄存器加立即数”的编码模板。

### 2.2 为什么立即数有时只占 8 位

`emit_arith` 会根据立即数范围选择不同形式：

```text
立即数可以用符号扩展 imm8 表示
    → 使用短格式
否则
    → 使用 imm32 格式
```

短格式的意义很直接：

- 指令更短
- 代码密度更高
- 取指和 I-cache 压力可能更小

但它有边界：只有能正确符号扩展到目标宽度的立即数，才能使用 imm8。

因此“算术指令长度”并不是只由操作类型决定，还由立即数值本身决定。

### 2.3 `imul` 与 `idiv`：操作数不总是对称的

`imul` 有多种形式：

- 两操作数寄存器形式
- 立即数形式
- 三操作数形式

而 `idiv` 更特殊，它使用隐含寄存器：

```text
被除数涉及 rdx:rax
商和余数也有固定寄存器约束
```

这意味着上层 JIT 不能只说“我要做除法”，还必须安排：

- 被除数放到哪里
- 除数放到哪里
- 结果从哪里取出
- 需要不要提前扩展 `rax` 到 `rdx:rax`

所以指令模板还会把寄存器约束传给寄存器分配器和调用约定。

### 2.4 `lock` 只是一个前缀，但不是普通前缀

HotSpot 的 `lock()` 实现只有一条字节发射：

```cpp
// assembler_x86.cpp:2268-2270
void Assembler::lock() {
  emit_int8((unsigned char)0xF0);
}
```

但它的语义不能只看这一行。

真正的原子操作通常是：

```text
lock + cmpxchg
lock + xadd
lock + add/sub
```

例如 CAS 的核心结构是：

```text
比较内存位置与期望值
    │ 相等
    ▼
写入新值，并报告成功

    │ 不相等
    ▼
保留实际值，并报告失败
```

`lock` 让这组读—比较—条件写入具备跨线程原子性。

因此 JVM 的 `Atomic`、锁实现中的 CAS、各种无锁数据结构，最后都可能落到这类指令模板。

但不能写成“JVM 所有 CAS 都固定是 `lock cmpxchg`”：

- 单线程或特定对齐场景可能有不同优化
- 不同宽度对应不同 cmpxchg 变体
- x86 的原子语义还要结合内存模型和具体指令

更准确的说法是：

**在 OpenJDK x86_64 的通用硬件原子路径中，`lock` 前缀与 cmpxchg/xadd 等指令构成了重要的底层原语。**

### 2.5 失败方案：普通 load/store 不能替代 CAS

假设两个线程同时做：

```text
读取 old
计算 new
写回 new
```

如果中间没有原子比较，两个线程可能都读到同一个 old，最后一个写入覆盖前一个结果。

软件锁可以解决这个问题，但会引入：

- 锁竞争
- 阻塞和唤醒
- 内核调度
- 更大的临界区

硬件 CAS 把“比较”和“条件写入”压到一个原子指令语义里，JVM 的并发抽象才能在很多短操作上避免完整锁路径。

---

## 三、jmp/call：控制流编码由距离和重定位共同决定

### 3.1 `jmp` 不是一个固定长度

x86 的无条件跳转至少有三类重要形式：

```text
rel8        短位移跳转
rel32       长位移跳转
寄存器/内存间接跳转
```

HotSpot 的 `jmp(Label&, bool maybe_short)` 位于 `assembler_x86.cpp:2169-2199` 附近。

当目标已经绑定时，它可以计算距离：

```text
0xEB + rel8    约 2 字节，短跳
0xE9 + rel32   约 5 字节，长跳
0xFF /r        间接跳转，目标来自寄存器或内存
```

短跳更紧凑，但只能在目标距离已经确定且落在 8 位位移范围内时使用。

### 3.2 前向跳转为什么默认使用长格式

如果 Label 尚未绑定，JIT 不知道后面会生成多少代码，也不知道目标会落在哪个 section。

所以前向跳转默认先发长格式：

```text
登记 patch 位置
    ↓
发出 E9
    ↓
写入 32 位零位移占位
    ↓
bind 时回填
```

源码注释明确说明：前向跳转默认使用 32 位 displacement，因为生成时不知道 Label 最终在哪里绑定。

只有调用者明确使用 `jmpb`，并且自己能够证明目标足够近时，才强制走短位移。

这和上一篇 Label 的补丁机制直接接上：

- Assembler 决定具体 `jmp` 编码
- Label 保存未绑定跳转的位置
- CodeBuffer 保存这些字节和 locator
- bind 时回填位移

### 3.3 `call`：控制流之外还要告诉 relocation 系统“调用谁”

相对调用通常使用：

```text
E8 + rel32
```

但 Java/JVM 运行时调用目标可能在生成阶段尚未固定，或者需要根据调用类型在最终 nmethod 中修正。

因此 HotSpot 的 `call` 不只是发 `0xE8` 和一个位移，还接收 relocation 类型：

- runtime call
- optimized virtual call
- static call
- 其他调用点类型

这让后续代码安装阶段知道：

- 这里是一处调用点
- 它当前的位移如何解释
- 最终目标是否需要重定位或修补

所以 `call` 是“机器码控制流 + JVM 运行时链接信息”的结合点。

### 3.4 失败方案：所有跳转都预留最大格式

如果所有已知很近的跳转都使用长格式，功能上通常没问题，但代码会变大。

如果所有跳转都强制短格式，又会因为目标距离变化而溢出。

HotSpot 的折中是：

- 目标已知且足够近：可以选择短格式
- 目标未知：保守使用长格式
- 调用者确实知道前向目标很近：显式使用 `jmpb/jccb`

这说明 Assembler 不是单纯编码器，它还承载了一部分“什么时候可以用更短形式”的布局判断。

---

## 四、SSE/AVX 与屏障：CPU 能力改变指令模板

### 4.1 `addsd`：SSE 的破坏性操作数

SSE 浮点指令通常采用破坏性二操作数语义：

```text
addsd dst, src
    dst = dst + src
```

HotSpot 的实现位于 `assembler_x86.cpp:1274-1283` 附近：

```cpp
void Assembler::addsd(XMMRegister dst, XMMRegister src) {
  NOT_LP64(assert(VM_Version::supports_sse2(), ""));
  InstructionAttr attributes(...);
  int encode = simd_prefix_and_encode(
      dst, dst, src, VEX_SIMD_F2, VEX_OPCODE_0F, &attributes);
  emit_int8(0x58);
  emit_int8((unsigned char)(0xC0 | encode));
}
```

注意这里 `dst` 出现两次：

- 一次代表目的操作数
- 一次作为 VEX 编码中源操作数 1

这是为了保持 SSE 的破坏性语义。

### 4.2 VEX/EVEX 编码路径不等于这条 API 已经变成三操作数

AVX 指令集可以表达：

```text
vaddsd dst, src1, src2
    dst = src1 + src2
```

这种形式让源和目的不必重合。

但本文引用的 `Assembler::addsd(XMMRegister dst, XMMRegister src)` 仍然是二参数 API，并且源码调用：

```cpp
simd_prefix_and_encode(dst, dst, src, ...)
```

第一个 `dst` 是目的寄存器，第二个 `dst` 作为 VEX/EVEX 的第一个源操作数，因此它保持 `dst = dst + src` 的破坏性语义。也就是说：**使用 VEX/EVEX 编码路径，不自动等于这条 HotSpot API 已经利用了独立的第三个源操作数。**

真正使用非破坏性三操作数时，Assembler/MacroAssembler 必须提供或调用带有独立 `src1`、`src2` 的接口。

AVX 的独立源操作数仍然有实际收益：如果上层确实使用三操作数形式，就可能省掉为了保留原目的寄存器而额外插入的 `mov`。

但这条路径有前提：CPU 必须支持相应 AVX 能力，JIT 也必须根据 `VM_Version` 和相关开关选择正确编码。

所以阅读 HotSpot 浮点发射代码时，必须同时看：

```text
前缀编码族：SSE / VEX / EVEX
操作数 API：二操作数还是三操作数
语义：目的寄存器是否同时承担源操作数
```

### 4.3 `mfence`：机器指令不是 JVM 内存模型本身

HotSpot 的 `mfence` 发射很直接：

```cpp
// assembler_x86.cpp:2282-2287
void Assembler::mfence() {
  NOT_LP64(assert(VM_Version::supports_sse2(), "unsupported");)
  emit_int8(0x0F);
  emit_int8((unsigned char)0xAE);
  emit_int8((unsigned char)0xF0);
}
```

最终字节是：

```text
0F AE F0
```

`lfence`、`sfence` 也有对应编码。

但必须区分三层语义：

1. x86 指令本身提供什么硬件顺序约束
2. HotSpot `OrderAccess` 在 x86 上选择什么实现
3. Java Memory Model 对 volatile、锁和原子操作要求什么语义

不能看到 `mfence` 就说“JVM 的所有内存屏障都是 mfence”。x86 TSO 允许很多 JVM 屏障在特定场景下只需要编译器屏障或更轻的硬件动作；具体选择由 `OrderAccess` 和调用语义决定。

同样，也不能把 x86 的 TSO 结论外推到 ARM、RISC-V 等架构。

### 4.4 失败方案：不看 CPU 能力，直接发 AVX/EVEX

如果 JVM 不先探测 CPU 能力，直接生成 AVX 或 EVEX 指令，旧 CPU 可能触发非法指令。

如果为了兼容所有机器只使用最保守 SSE，又会放弃支持新 CPU 的非破坏性操作数、更宽向量和 mask 能力。

所以平台探测和 Assembler 之间形成了闭环：

```text
VM_Version 探测能力
    ↓
Assembler/MacroAssembler 选择编码族
    ↓
CPU 执行对应指令
```

---

## 五、收网：Assembler 是模板选择器，不是逐句翻译器

现在把本篇的四条指令家族主线收回来：

```text
Java/JIT 语义
    │
    ├─ 搬数据/扩展宽度 → mov / movzx / movsx / lea
    ├─ 算术/原子       → add / sub / imul / idiv / lock+cmpxchg
    ├─ 控制流/调用     → jmp / jcc / call + Label/relocation
    └─ 浮点/内存序     → SSE / AVX / mfence
          │
          ▼
根据宽度、操作数、距离、CPU 能力和内存语义选模板
          │
          ▼
Assembler 发射 opcode / 前缀 / ModR/M / 位移 / 立即数
          │
          ▼
CodeBuffer、Label、relocation 托底
          │
          ▼
nmethod 中的最终机器码
```

这篇真正讲清的不是 `mov`、`add`、`jmp` 各有多少种 opcode，而是：

- 数据搬运指令族处理宽度、扩展和地址计算
- 算术模板根据立即数宽度压缩编码
- 原子模板把 `lock` 与比较交换组合成 JVM 并发原语
- 控制流模板根据目标距离和 relocation 需求选择形式
- SSE/AVX 模板根据 CPU 能力和操作数破坏性选择编码
- 屏障指令必须放回 JVM 内存模型和具体架构边界里解释

如果压缩成三句话：

1. x86 指令不是 Java 语义的一对一翻译，而是一组可按条件选择的编码模板。
2. `Assembler` 负责具体指令字节，`MacroAssembler` 才负责把这些字节组织成 JVM 运行时动作。
3. 指令编码、CPU 能力、CodeBuffer、Label、relocation 和 JVM 内存语义共同决定最终机器码。

下一篇进入 `MacroAssembler`：

- `call_VM` 如何保存 Java 状态并调用 VM runtime
- safepoint polling 如何嵌入运行时模板
- 对象头、卡表、异常和慢路径如何组合成完整机器码

> → [04-x86-macroassembler-runtime.md](04-x86-macroassembler-runtime.md)
