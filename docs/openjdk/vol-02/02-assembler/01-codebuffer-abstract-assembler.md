# 01. JIT 还不知道终点，为什么已经能写机器码？— CodeBuffer、Assembler 与 Label

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论
> **前置依赖**：[45-math-library/02 — StubRoutines 生成管道](openjdk/vol-02/45-math-library/02-stubroutine-native.md)：`CodeBuffer` 与 `__ fast_sin(...)` 的使用场景
> → **后续**：[02 — x86 寄存器/操作数编码](02-x86-register-operand-encoding.md)
> 关联域：16-codecache、23-stub、13-jit

## 先看一个奇怪的生成现场

在 JIT 或 StubRoutines 的 C++ 代码里，经常能看到这种写法：

```cpp
CodeBuffer buffer(_code1);
MacroAssembler masm(&buffer);
__ fast_sin(...);
```

表面上，这像是在调用一个普通 C++ 方法；实际上，`fast_sin` 里面的 `__` 宏会不断向一块缓冲区写入机器码。

问题来了：

- 这段代码最终要放进 CodeCache 的什么地址，现在可能还不知道
- 常量区和 stub 区最终要占多大，现在可能还不知道
- 一个向前跳转的目标，甚至还没有生成
- 代码后面可能还要扩容、搬迁、重定位

如果机器码生成器必须等所有最终地址都确定之后才开始写，那么增量生成、前向跳转和动态 stub 都会变得非常麻烦。

HotSpot 的办法是把“生成”和“最终落位”拆开：

```text
CodeBuffer       先管理空间、分区和位置
AbstractAssembler 先把字节写进去
Label            先记住未知目标和补丁位置
relocation       先记录以后需要修正的外部引用

生成阶段完成后，再由后续 CodeCache/nmethod 管道接管这些代码、数据和重定位信息
```

所以本篇真正要回答的不是“CodeBuffer 有几个字段”，而是：

**JIT 如何在最终地址、跳转目标和代码布局尚未完全确定时，仍然逐步生成一段以后可以修补、搬迁和执行的机器码？**

---

## 一、CodeBuffer 不是 byte 数组，而是一张分区的草稿纸

### 1.1 为什么不能所有东西都写进同一段空间

最直觉的实现是准备一个 `byte[]`：

```text
指令写进去
常量写进去
stub 也写进去
最后整体交给 CodeCache
```

但机器码生成阶段至少有三类内容，它们的生命周期和权限都不同：

- 指令：最终要被 CPU 执行
- 常量：最终要被指令引用，也要能被运行时识别和重定位
- stub：为调用、异常、去优化等慢路径提供支撑代码

如果三类内容混在一起，生成器就会不断面对这些问题：

- 哪一段可以执行，哪一段只是数据
- 哪一段需要对齐
- 哪一段的重定位信息属于哪类内容
- stub 增长时，如何不破坏已经生成的指令
- 最终复制到 nmethod 时，如何恢复稳定布局

所以 CodeBuffer 一开始就把空间拆成 section。

### 1.2 三个 section，各自承担一种责任

`codeBuffer.hpp:353-361` 定义了可能的 section：

```cpp
// codeBuffer.hpp:353-361
SECT_CONSTS = SECT_FIRST,
SECT_INSTS,
SECT_STUBS,
SECT_LIMIT,
SECT_NONE = -1
```

最终布局顺序由这个枚举顺序决定：

```text
consts → insts → stubs
```

三者不是随意起的名字。

#### `consts`：指令旁边的只读材料

这里放浮点常量、跳转表等非指令数据。

它们不被 CPU 当成指令执行，但指令可能通过地址或位移引用它们。因此常量不仅是“数据”，还需要重定位信息告诉运行时：这里嵌着一个地址或对象引用。

#### `insts`：方法主体和正常控制流

这是 JIT 生成的主要机器指令区域。

它负责正常路径上的计算、分支、调用和返回，是最终 nmethod 中最核心的可执行部分。

#### `stubs`：从正常路径跳出去的支撑代码

stub 负责承接一些不适合塞进主指令流的路径：

- 慢速调用
- 异常处理
- 去优化
- 运行时调用
- 调用点所需的 trampoline

把 stub 单独放出来，主指令区就不需要为了每个慢路径预留一大块连续空间。

### 1.3 CodeSection 管理的不只是字节

每个 section 都是一个 `CodeSection`。它至少要知道：

```text
_start   当前区域起点
_end     下一次写入的位置
_limit   当前区域容量边界

_locs_start / _locs_end / _locs_point
         这一段代码对应的重定位记录范围
```

因此 CodeBuffer 同时管理两条平行信息：

```text
机器码/常量/stub 字节流
        +
这些字节里哪些位置需要未来修补的 relocation 流
```

如果只有字节，没有 relocation，代码搬到新地址后，嵌在指令里的对象地址、常量地址和外部调用地址就无法修正。

这也是为什么“机器码已经写进内存”不等于“代码已经可以永久执行”。生成阶段还要保留它的地址关系。

### 1.4 `emit_int8`：纸张上的最小落笔动作

`CodeSection::emit_int8` 的核心实现极其朴素：

```cpp
// codeBuffer.hpp:203
void emit_int8(int8_t x) {
  *((int8_t*)end()) = x;
  set_end(end() + sizeof(int8_t));
}
```

它只做两件事：

1. 把一个字节写到当前 `end()`
2. 把 `end` 向后移动一个字节

这就是机器码发射的最底层动作。

上层生成一条 x86 指令，本质上就是多次调用这种动作，把 opcode、ModR/M、立即数、位移依次写入 section。

这里要记住一个重要边界：

**CodeBuffer 不理解“这是一条什么指令”；它只知道当前位置、容量和要写入的字节。**

### 1.5 locator：为什么裸偏移不够

如果 CodeBuffer 只有一节，位置可以用一个 offset 表示。

但现在有 `consts`、`insts`、`stubs` 三个 section，同一个 offset 在不同 section 中可能指向完全不同的地址。

因此 HotSpot 用 locator 把 section 和节内位置合在一起：

```cpp
// codeBuffer.hpp:514-517
static int locator_pos(int locator)   { return locator >> sect_bits; }
static int locator_sect(int locator)  { return locator &  sect_mask; }
static int locator(int pos, int sect) { return (pos << sect_bits) | sect; }
```

当前实现里 `sect_bits = 2`，所以可以理解为：

```text
locator = section 内偏移 << 2 | section 编号
```

这样 Label、重定位和补丁记录拿到的就不是一个容易歧义的裸 offset，而是一个带有 section 身份的位置编号。

```text
locator
  ├─ 高位：section 内位置
  └─ 低 2 位：属于哪一节
```

这就是“位置身份证”。生成阶段的补丁和重定位先保存 locator；后续在 section 布局确定、BufferBlob 或 nmethod 地址确定后，再根据 section 和偏移换算成具体地址。locator 本身不是搬迁后的绝对地址，而是参与后续地址换算的中间位置编码。

### 1.6 section 如何分配和扩容

CodeBuffer 的空间并不是三个完全独立、互不相干的数组。

`initialize_section_size` 会从整体空间中安排各 section；实现的关键策略是：后面的 section 会从 `insts` 区域可用空间中划出。

当某个 section 被 `freeze` 后，它的布局被固定，剩余空间可以交给后续 section 使用。

这个过程体现了一个现实约束：

- 指令区通常最先增长
- 常量和 stub 的最终大小在生成过程中逐渐明确
- 一旦某节冻结，布局就不能随便再改

如果空间不够，`CodeBuffer::expand` 会创建临时的更大 CodeBuffer，并把已有代码和 relocation 资料复制到新的存储区域；`codeBuffer.hpp:449` 的接口注释把它概括为“创建更大的 BufferBlob，并重写 code & relocs”。

这里还有一个不能省略的细节：`codeBuffer.cpp:913-921` 会保留扩容前的旧 CodeBuffer，并通过 `_before_expand` 串成历史链。源码注释说明，这条历史链会在最终装配到 CodeCache 时帮助修正“过去某次 CodeBuffer 中生成过的内部地址”。

这就带来一个必须解决的问题：

> 代码搬家后，原来记录的位置还能用吗？

答案是：不能把“绝对地址”当作生成阶段的唯一身份。

section 内位置、locator、relocation，以及扩容前后的 CodeBuffer 历史共同参与后续地址修正；新 BufferBlob 的起点只是最终换算的一部分。

还要区分 CodeBuffer 对象本身和它管理的底层存储。

CodeBuffer 通常是生成阶段的 `StackObj` 描述器，内部可以指向 CodeCache 中的 `BufferBlob`；真正承载字节的是 blob 的内存，CodeBuffer 负责描述 section、当前位置和 relocation 如何组织。这样生成阶段的描述器可以短生命周期存在，而代码存储仍由 CodeCache 管理。

因此 CodeBuffer 的核心能力不是“有一块内存”，而是：

**即使底层存储需要扩容搬迁，代码位置和重定位关系仍能被重新解释。**

---

## 二、AbstractAssembler：它不是 x86 汇编器，而是统一发射层

### 2.1 为什么要先有平台无关层

x86、ARM、AArch64 的指令编码完全不同：

- opcode 规则不同
- 寄存器编码不同
- 内存操作数格式不同
- 分支和立即数宽度不同

如果 CodeBuffer、Label 和 relocation 也分别在每个架构里重写，基础设施会重复很多份，而且不同架构很容易出现语义漂移。

HotSpot 把共性抽出来，形成 `AbstractAssembler`：

```text
平台无关层：
  往当前 section 写整数
  查询 pc / offset / locator
  记录 relocation
  管理 Label 的共同行为

平台相关层：
  把 mov/jcc/test 等具体指令编码成字节
```

所以 AbstractAssembler 的角色不是“知道一条 x86 指令长什么样”，而是提供一支所有平台都能使用的笔。

### 2.2 `emit_int*`：统一的字节发射接口

`assembler.hpp:209-320` 附近定义了这些基础操作：

```cpp
void emit_int8(int8_t x)   { code_section()->emit_int8(x); }
void emit_int16(int16_t x) { code_section()->emit_int16(x); }
void emit_int32(int32_t x) { code_section()->emit_int32(x); }
void emit_int64(int64_t x) { code_section()->emit_int64(x); }

address pc() const { return code_section()->end(); }
int offset() const { return code_section()->size(); }
int locator() const { return CodeBuffer::locator(offset(), sect()); }
```

这几组接口把“写字节”和“问当前位置”统一起来：

- 平台汇编器决定写哪些字节
- AbstractAssembler 决定这些字节写进当前 section 的什么位置
- `pc()` 给出当前写入地址
- `offset()` 给出当前 section 内偏移
- `locator()` 给出带 section 身份的位置

一条 x86 指令最终可能调用多个 `emit_int8` 和 `emit_int32`；但这些调用不需要虚函数分派，可以直接内联到字节写入路径。

### 2.3 relocation：代码里的地址不是普通立即数

JIT 生成的机器码里可能嵌着：

- Java 对象地址
- 元数据地址
- 字符串或常量地址
- 外部函数入口
- CodeCache 内部的跳转目标

这些地址在生成时、搬迁时、链接时甚至 GC 期间可能需要处理。

如果生成器只把它们当普通 `int32` 写进去，运行时就不知道哪些字节代表一个需要修补的引用。

`AbstractAssembler` 还持有 `OopRecorder`，用于为代码中的 oop/metadata 引用建立记录，让 relocation 不只是“某个偏移需要修补”，还带着引用类型和记录编号。后续代码安装与 relocation 处理阶段会使用这些记录；具体 GC 如何扫描和更新已安装代码，属于后续 CodeCache/GC 主题，不在这里把两者合并成一个步骤。

所以 Assembler 提供 `relocate`：

```cpp
// assembler.hpp:330-338
void relocate(RelocationHolder const& rspec, int format = 0) {
  assert(!pd_check_instruction_mark()
      || inst_mark() == NULL || inst_mark() == code_section()->end(),
      "call relocate() between instructions");
  code_section()->relocate(code_section()->end(), rspec, format);
}
```

它做的不是立即修正地址，而是在当前位置留下一个“这里以后需要处理”的记录。

`assert` 还强制 relocation 在指令边界调用。

原因很现实：如果 relocation 标记落在一条指令中间，后续搬迁或 patch 很难知道它对应的是哪一个地址字段，也可能误改 opcode 或 ModR/M 字节。

因此：

```text
发射指令
  → 在正确的指令边界登记 relocation
  → 运行时根据 relocation 类型处理内部地址/对象/调用
```

### 2.4 AbstractAssembler 的边界

AbstractAssembler 刻意不实现完整指令。

它不知道：

- x86 的 REX 前缀怎么编码
- ModR/M 的 reg/rm 字段怎么填
- AArch64 的立即数如何拼进指令
- 某个架构的分支位移是多少

这些由平台汇编器完成。

它只负责稳定的共性：

- 字节落在哪里
- 当前 PC 是什么
- 当前 section 是什么
- 当前位置有哪些 relocation
- Label 如何记录和绑定

这条边界让下一篇可以专门讨论 x86 操作数编码，而不用重新解释 CodeBuffer 的生命周期。

---

## 三、Label：目标还没生成，前向跳转如何先写出去

### 3.1 先看最笨的办法

假设 JIT 正在生成：

```text
if (x > 0) goto L
```

但 `L` 对应的代码要在后面才生成。

最笨的办法是：

1. 先暂停生成
2. 先把所有后续代码生成完
3. 计算目标地址
4. 回到原来的位置写跳转指令

这会让生成器需要维护大量“回头写”的状态，也会和 section 增长、代码扩容、嵌套 stub 发生复杂交互。

更自然的办法是：

```text
现在先把跳转指令写出去
在位移字段留下占位值
把这个位置登记到 Label 的补丁列表
等目标绑定时再回填
```

这就是 Label。

### 3.2 Label 的三种状态

`assembler.hpp:78-83` 用 `_loc` 和 `_patch_index` 表达 Label 状态：

```cpp
// _loc >= 0：已绑定，loc 编码目标位置
// _loc == -1：尚未绑定
bool is_bound() const  { return _loc >= 0; }
bool is_unbound() const { return _loc == -1 && _patch_index > 0; }
bool is_unused() const { return _loc == -1 && _patch_index == 0; }
```

三种状态分别是：

```text
unused
  没有任何跳转引用

unbound
  已经有人跳向它，但目标位置尚未生成

bound
  目标位置已经确定
```

把 `unused` 和 `unbound` 分开很有用：

- unused 的 Label 不需要分配补丁空间
- unbound 的 Label 必须保存所有等待回填的位置
- bound 的 Label 可以立即提供目标 locator

### 3.3 为什么 patch cache 只有 4 个

Label 的注释给出了一个很有代表性的优化：

- 先在对象里内嵌 4 个 patch 位置
- 超过 4 个后，再分配 `GrowableArray`
- 注释声称这个小缓存覆盖绝大多数场景

这不是改变语义，而是优化常见路径的内存分配。

绝大多数 Label 只有一两个前向引用。如果每个 Label 一创建就分配堆数组，短生命周期的机器码生成会平白增加分配和释放压力。

所以设计是：

```text
少量补丁点 → 对象内置数组
补丁点溢出 → GrowableArray 接管剩余位置
```

小对象走快路径，复杂对象仍然保留完整能力。

### 3.4 已绑定时：立即选择短跳或长跳

x86 的条件跳转 `jcc` 在 `assembler_x86.cpp:2104-2135` 附近处理两种情况。

如果 Label 已绑定，目标地址已知，生成器可以直接计算位移：

```text
目标已知
  → 计算 dst - pc
  → 距离落在 8 位范围
      → 选择短跳，约 2 字节
  → 否则
      → 选择长跳，使用 rel32
```

短跳的优势是机器码更小，但它只能在目标距离已经可证明时使用。

### 3.5 未绑定时：为什么先发长格式

如果目标还没有绑定，生成器不能证明未来距离一定落在 `-128..127`。

因此未绑定分支会：

1. 调用 `L.add_patch_at(code(), locator())`
2. 发出长格式 `jcc rel32`
3. 先把 displacement 槽位填成 0

等目标位置通过 `bind` 确定后，再由 `assembler.cpp:117-118` 调用 `patch_instructions` 遍历补丁位置，最终交给平台相关的 `pd_patch_instruction` 回填真实位移。

这套策略的关键权衡是：

- 向前跳第一次发射时可能多占空间
- 但生成器不需要暂停，也不需要预先知道未来布局
- 绑定后只回填位移字段，不需要重建整段代码

因此“先发长格式”不是因为最终一定需要长跳，而是因为它在目标未知时最稳妥。

### 3.6 `bind`：把位置和补丁链真正闭合

当生成器走到目标位置，会调用 `bind(L)`：

```text
当前 section 的 locator
    ↓
写入 Label 的绑定位置
    ↓
遍历所有 patch 位置
    ↓
根据目标 locator 计算位移
    ↓
回填每一条前向跳转
```

到这里，Label 的生命周期才真正结束：

```text
unbound → bind → bound
```

### 3.7 失败方案：前向跳转强行只用短跳

如果一开始就发 2 字节短跳，目标后来超过 `-128..127`，就没有足够空间存放正确位移。

这时只能：

- 重新移动后面的整段代码
- 修改指令长度并修正所有后续位置
- 重新计算更多 relocation 和 patch

JIT 的增量生成会被复杂的“指令长度变化”拖住。

先发长格式的策略牺牲少量空间，换来稳定的布局和简单的后补丁。

---

## 四、对齐与 NOP：空白字节也必须能安全执行

### 4.1 为什么机器码之间需要填充

代码 section、stub section 和某些入口需要满足对齐要求。

当前 x86 平台的 `CodeEntryAlignment` 等参数会影响入口对齐。对齐的目的通常包括：

- 让入口落在更合适的指令边界
- 减少指令跨 cache line 或取指边界的情况
- 让后续布局和反汇编更容易处理

对齐产生的空档不能填任意数据。

CPU 可能从这些位置开始取指，调试器也可能反汇编这些字节，后续 patch 逻辑还必须不能把填充误认为立即数字段。

### 4.2 x86 为什么有多字节 NOP

`assembler_x86.cpp:3111-3131` 附近根据需要的长度选择 NOP 序列：

```text
1 字节：90
2 字节：66 90
3 字节：66 66 90
4 字节：0F 1F 40 00
5 字节：0F 1F 44 00 00
```

Debug 构建通常使用传统单字节 NOP，方便调试器和反汇编器识别；产品构建可以使用更适合处理器解码的多字节 NOP。

但多字节并不是随便拼字节。

注释特别说明，3 字节场景不使用 `0F 1F 00`，而使用 `66 66 90`。源码明确把前一种形式标为不适合作为 patch-safe padding；本文只保留这个实现事实，不把它扩展成某个具体补丁算法的通用扫描规则。

这说明 NOP 并不是“无意义空白”：

```text
NOP 必须满足：
  能安全执行
  长度准确
  解码明确
  不干扰后续 patch/relocation
```

### 4.3 收尾失败方案：对齐区随便填零

如果对齐区直接填 `0x00`：

- CPU 从错误位置开始执行时可能触发异常
- 反汇编结果难以阅读
- 某些补丁扫描可能把它误认为立即数字段

如果所有长度都只填单字节 `0x90`，通常能工作，但可能放弃处理器对多字节 NOP 的解码与取指优势。

所以对齐填充也是机器码生成协议的一部分。

---

## 五、收网：从 C++ DSL 到最终机器码的完整时间线

现在把整篇重新串起来。

```text
JIT/Stub 生成器
    │ 调用平台相关 Assembler/MacroAssembler
    ▼
AbstractAssembler
    │ 写入字节、查询 pc/offset/locator、登记 relocation
    ▼
CodeBuffer
    │ 管理 consts / insts / stubs 与各自的重定位记录
    │ 空间不足时扩容并搬迁
    ▼
Label
    │ 未知目标先登记 patch，bind 时回填位移
    ▼
对齐与 NOP
    │ 让入口和 section 满足布局与 patch 约束
    ▼
后续 CodeCache / nmethod 管道
    │ 接管代码、常量、stub、重定位并形成最终可执行布局
```

这篇真正讲清的不是三个类的字段，而是机器码生成为什么可以“边走边写”：

- CodeBuffer 把不稳定的最终布局拆成可管理 section
- locator 把“位置”变成带 section 身份的相对编号
- AbstractAssembler 把平台差异压到字节发射边界
- relocation 保存未来还要处理的地址关系
- Label 把未知目标转成可回填的补丁点
- NOP 让对齐空档也遵守执行和修改安全

如果压缩成三句话：

1. CodeBuffer 管理的是“机器码 + 区域 + 位置 + 重定位”，不是一条普通 byte 数组。
2. AbstractAssembler 不负责理解 x86，它负责把平台汇编器产出的字节安全地落到当前 section。
3. Label 和 relocation 让 JIT 可以先生成、后绑定、再搬迁和修补，而不用提前知道所有最终地址。

下一篇才进入真正的 x86 编码细节：

- 一个寄存器为什么要占 3 个 bit
- ModR/M 的 reg、rm、mod 分别表达什么
- x86-64 为什么需要 REX
- 地址和立即数如何被拼进最终指令

> → [02-x86-register-operand-encoding.md](02-x86-register-operand-encoding.md)
