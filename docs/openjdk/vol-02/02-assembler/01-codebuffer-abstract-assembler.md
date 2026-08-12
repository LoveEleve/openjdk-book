# 01. CodeBuffer 与 AbstractAssembler — JIT 的"草稿纸"和"笔"

> **前置依赖**:[45-math-library/02 — StubRoutines 生成管道](openjdk/vol-02/45-math-library/02-stubroutine-native.md):`generate_libmSin` 里的 `CodeBuffer buffer(_code1)` 与 `__ fast_sin(...)`——本篇拆这两个东西的内部
> → **后续**:[02 — x86 寄存器/操作数编码](02-x86-register-operand-encoding.md)
> 关联域: 16-codecache(BufferBlob 的归属)、23-stub、13-jit(nmethod 生成)

## JIT 的"草稿纸"

45-02 篇里,`__ fast_sin(...)` 把 2443 行 C++ 调用变成了机器码——写进的就是 **CodeBuffer**。它是一块内存,上面叠了三层东西:指令、常量、stub;而 **AbstractAssembler** 是握在手里的笔:emit 一个字节,pc 前进一点。这篇拆:纸(CodeBuffer 三节)、笔(AbstractAssembler)、以及 JIT 最狡猾的设计——**Label 补丁**(生成代码时还不知道跳转目标,怎么先写下去)。

## 1. CodeBuffer:三节一张纸

### 1.1 场景:一段代码、一摞常量、几个 stub,挤在同一块内存

CodeBuffer 的类注释(316-338)把它讲得很全——内存分几个 **section**,每节独立累积代码/数据与重定位信息,节可以增长(代价是重分配 BufferBlob 重拷贝),最终写入 nmethod 时各节按对齐拼接。三节是枚举定义的(codeBuffer.hpp:353-361):

```cpp
// codeBuffer.hpp:353-361(截取核心,逐字)
  enum {
    // Here is the list of all possible sections.  The order reflects
    // the final layout.
    SECT_FIRST = 0,
    SECT_CONSTS = SECT_FIRST, // Non-instruction data:  Floats, jump tables, etc.
    SECT_INSTS,               // Executable instructions.
    SECT_STUBS,               // Outbound trampolines for supporting call sites.
    SECT_LIMIT, SECT_NONE = -1
  };
```

- **consts**:非指令数据(浮点常量、跳转表)
- **insts**:可执行指令(方法主体)
- **stubs**:调用点支撑的 trampoline、异常/deopt 处理

三节作为成员嵌在 CodeBuffer 里(371-373),各是一个 `CodeSection`(86-245)——每节有自己的 `_start/_end/_limit`(代码区)和 `_locs_start/_locs_end/_locs_point`(重定位区,90-93)。`emit_int8` 就是两行(codeBuffer.hpp:203):

```cpp
// codeBuffer.hpp:203(逐字)
  void emit_int8 ( int8_t  x)  { *((int8_t*)  end()) = x; set_end(end() + sizeof(int8_t)); }
```

**位置与节的编码——locator**(514-517)是整个系统的"地址身份证":

```cpp
// codeBuffer.hpp:514-517(逐字)
  // A stable mapping between 'locators' (small ints) and addresses.
  static int locator_pos(int locator)   { return locator >> sect_bits; }
  static int locator_sect(int locator)  { return locator &  sect_mask; }
  static int locator(int pos, int sect) { return (pos << sect_bits) | sect; }
```

`sect_bits = 2`(365 行):**locator = 节内偏移 << 2 | 节号**——低 2 位是节号,高位是偏移。整个 CodeBuffer 只有 3 节,2 位足够;偏移左移 2 位后仍是整数。Label 绑定、重定位、补丁链全都用 locator 说话。

- [C++: CodeBuffer 本身是 **StackObj**(340 行,栈上分配),`_blob`(377)指向 CodeCache 里的 BufferBlob——"纸"通常借用 BufferBlob 的内存,CodeBuffer 只是描述怎么用;四种构造(455-479)覆盖:预分配内存、现成 CodeBlob、懒初始化、按代码+重定位大小分配]
- [x86: 各节对齐要求(222-226):指令区和 stub 区按 `CodeEntryAlignment`(x86 平台默认 32,globals_x86.hpp:49),consts 区按 `sizeof(jdouble)`——32B 是 icache line(64B)的一半,减少跨行取指]

**节怎么从 insts 里"抠"出来**:`initialize_section_size`(codeBuffer.cpp:160-176)从 insts 区尾部划一块给 consts/stubs(注意注释:先划后面的节,每节都从 insts 偷空间);`freeze_section`(178-196)把节冻结,剩余空间转给下一节——**先 freeze 的节一旦定型,空间就被下一节接管**。

**空间不够怎么办**:`expand`(449 行声明,注释 "Creates a new, larger BufferBlob, and rewrites the code & relocs")——整体搬进更大的 BufferBlob 重来。

**关键设计 (斜体)**: *三节分离是"按生命周期分工":insts 是最终执行的指令,consts 是 GC 要扫的数据(重定位让 GC 看见),stubs 是异常/去优化的"备胎代码"。它们在最终 nmethod 里按固定顺序拼接(consts→insts→stubs,354-356 注释 "The order reflects the final layout")。locator 用 2 位节号 + 移位偏移,让"位置"自带"在哪个区"的信息——补丁和重定位拿到 locator 就知道去哪找。*

## 2. AbstractAssembler:一支"会写字的笔"

### 2.1 场景:emit 一个字节,世界前进一点

`AbstractAssembler`(assembler.hpp:205-457)是平台无关的发射层——它不知道 x86 指令长什么样,只负责"往当前节的当前位置写字":

```cpp
// assembler.hpp:209-210、281-284、318-320(截取核心,逐字)
  CodeSection* _code_section;          // section within the code buffer
  OopRecorder* _oop_recorder;          // support for relocInfo::oop_type
  ...
  void emit_int8(   int8_t  x) { code_section()->emit_int8(   x); }
  void emit_int16(  int16_t x) { code_section()->emit_int16(  x); }
  void emit_int32(  int32_t x) { code_section()->emit_int32(  x); }
  void emit_int64(  int64_t x) { code_section()->emit_int64(  x); }
  ...
  address       pc()           const   { return code_section()->end();   }
  int           offset()       const   { return code_section()->size();  }
  int           locator()      const   { return CodeBuffer::locator(offset(), sect()); }
```

`emit_int*` 是**内联的普通成员函数**,直接调用 CodeSection 的 emit(也就是往内存写字节 + 推进 end)——`pc()` 就是当前节的 end。上层 x86 的 `Assembler` 在此基础上实现具体指令(`emit_int8(0x0F); emit_int8(0x80|cc); emit_int32(...)`,下一篇拆)。

另一个关键接口是重定位:

```cpp
// assembler.hpp:330-338(截取核心,逐字)
  // Constants in code
  void relocate(RelocationHolder const& rspec, int format = 0) {
    assert(!pd_check_instruction_mark()
        || inst_mark() == NULL || inst_mark() == code_section()->end(),
        "call relocate() between instructions");
    code_section()->relocate(code_section()->end(), rspec, format);
  }
  void relocate(   relocInfo::relocType rtype, int format = 0) {
    code_section()->relocate(code_section()->end(), rtype, format);
  }
```

`relocate` 在当前指令末尾打一个**重定位标记**——告诉运行时"这里嵌着的东西(对象/地址/字符串)需要 GC 或链接器处理"。assert 强制它在指令边界调用(InstructionMark,226-238)。

**关键设计 (斜体)**: *AbstractAssembler 刻意不做"指令",只做"字节 + 位置 + 标记"。这样 x86/ARM 的指令编码可以完全不同(下一篇),而 Label、重定位、CodeBuffer 这些基础设施只写一次。逐字节发射路径零虚函数——`emit_int8` 是非虚内联,直接写内存;整个类只有两个纯虚(`delayed_value_impl`@432、`bang_stack_with_offset`@441,平台提供),它们与发射热点无关。一条指令的发射成本就是一次内存写。*

## 3. Label 补丁:前向跳转的"事后回填"

### 3.1 场景:向前跳,目标还不知道在哪

JIT 生成 `if (x > 0) goto L` 时,`L` 在后面的代码里——**生成时不知道偏移**。Label 系统解决这个。它的设计注释(assembler.hpp:64-69)直接否定了最直觉的做法:

```cpp
// assembler.hpp:64-69(注释逐字)
 * Instead of using a linked list of unresolved instructions, a Label has
 * an array of unresolved instruction code offsets.  _patch_index
 * contains the total number of forward references.  If the Label's array
 * overflows (i.e., _patch_index grows larger than the array size), a
 * GrowableArray is allocated to hold the remaining offsets.  (The cache
 * size is 4 for now, which handles over 99.5% of the cases)
```

**不是链表,是 4 个元素的数组缓存 + 溢出时 GrowableArray**(76-93 行: `_patches[PatchCacheSize=4]`、`_patch_index`、`_patch_overflow`)。Label 的状态由 `_loc` 一个整数编码(78-83):

```cpp
// assembler.hpp:78-83、129-131(截取核心,逐字)
  // _loc encodes both the binding state (via its sign)
  // and the binding locator (via its value) of a label.
  //
  // _loc >= 0   bound label, loc() encodes the target (jump) position
  // _loc == -1  unbound label
  int _loc;
  ...
  bool is_bound() const    { return _loc >=  0; }
  bool is_unbound() const  { return _loc == -1 && _patch_index > 0; }
  bool is_unused() const   { return _loc == -1 && _patch_index == 0; }
```

三态:**unused**(没人引用)、**unbound**(有前向引用待补丁)、**bound**(已绑定到某位置)。前向跳转的生成——看 x86 的 `jcc`(assembler_x86.cpp:2104-2135):

```cpp
// assembler_x86.cpp:2107-2135(截取核心,逐字)
  if (L.is_bound()) {
    address dst = target(L);
    ...
    const int short_size = 2;
    const int long_size = 6;
    intptr_t offs = (intptr_t)dst - (intptr_t)pc();
    if (maybe_short && is8bit(offs - short_size)) {
      // 0111 tttn #8-bit disp
      emit_int8(0x70 | cc);
      emit_int8((offs - short_size) & 0xFF);
    } else {
      // 0000 1111 1000 tttn #32-bit disp
      ...
      emit_int8(0x0F);
      emit_int8((unsigned char)(0x80 | cc));
      emit_int32(offs - long_size);
    }
  } else {
    // Note: could eliminate cond. jumps to this jump if condition
    //       is the same however, seems to be rather unlikely case.
    // Note: use jccb() if label to be bound is very close to get
    //       an 8-bit displacement
    L.add_patch_at(code(), locator());
    emit_int8(0x0F);
    emit_int8((unsigned char)(0x80 | cc));
    emit_int32(0);
  }
```

机制一目了然:**目标已绑定 → 当场算偏移,还能选 2 字节短跳;目标未绑定 → 登记 `add_patch_at` + 先发 6 字节长格式(rel32 槽位填 0)**。等 `L.bind(...)` 时,`patch_instructions`(assembler.hpp:150)遍历补丁数组,逐个调 `pd_patch_instruction`(汇编器平台实现)回填真实偏移。`jccb`(2138)是显式短跳版本,同样登记后回填。

**关键设计 (斜体)**: *"先发长格式、绑定后回填"是前向跳转的通用答案——代价是向前跳永远占 6 字节,换来的是生成器永远不用回头。短跳(2 字节)是**绑定后**的福利:只有目标已知才能确认偏移在 -128~+127 内,所以短跳只出现在"往回跳"或"先绑后跳"。用 4 元素数组缓存代替链表(注释明说覆盖 99.5% 情况)是典型的"小就是快"——绝大多数 Label 只有 1-2 个引用点,为它们分配堆内存是浪费。*

## 4. 收尾:对齐与 NOP

### 4.1 场景:代码要按 32B 对齐,空档用什么填

节之间、跳转目标处要对齐(CodeEntryAlignment=32)。x86 的 NOP 不是只有 `0x90`(assembler_x86.cpp:3111-3131):

```cpp
// assembler_x86.cpp:3112-3131(截取核心,逐字)
#ifdef ASSERT
  assert(i > 0, " ");
  // The fancy nops aren't currently recognized by debuggers making it a
  // pain to disassemble code while debugging. If asserts are on clearly
  // speed is not an issue so simply use the single byte traditional nop
  // to do alignment.

  for (; i > 0 ; i--) emit_int8((unsigned char)0x90);
  return;

#endif // ASSERT

  if (UseAddressNop && VM_Version::is_intel()) {
    //
    // Using multi-bytes nops "0x0F 0x1F [address]" for Intel
    //  1: 0x90
    //  2: 0x66 0x90
    //  3: 0x66 0x66 0x90 (don't use "0x0F 0x1F 0x00" - need patching safe padding)
    //  4: 0x0F 0x1F 0x40 0x00
    //  5: 0x0F 0x1F 0x44 0x00 0x00
```

调试版(ASSERT)一律 `0x90`(好反汇编);生产版用 Intel 多字节 NOP 序列——注意 3 字节**故意不用** `0F 1F 00`,注释解释了原因:"need patching safe padding"——`0F 1F 00` 的两个 0x00 会被"跳转目标回填"误伤(如果把指令中间的 0x00 当 imm 槽位,补丁会写进 NOP 里),而 `66 66 90` 全是无害操作码。

- [x86: 1: 0x90(单字节)、2: 66 90、3: 66 66 90、4: 0F 1F 40 00、5: 0F 1F 44 00 00——按长度选编码,让解码器对齐处理;`UseAddressNop` 是开关(默认按平台)]

**关键设计 (斜体)**: *对齐填充也是"语义"的一部分:NOP 不只是占位,它要满足① 执行无害② 解码无歧义③ **对重定位/补丁不可见**——这就是 0F 1F 00 被否决的原因:指令字节里不能出现会被事后回填误认的 0x00 槽位。一个 3 字节 NOP 的选择背后是"代码自修改"的约束,这也是 JIT 世界里所有 padding 的共同纪律。*

## 核心悬念

"CodeBuffer 是纸、AbstractAssembler 是笔、Label 是贴纸——但具体一条指令怎么写,完全由 x86 的编码规则决定:ModR/M 字节怎么编码寄存器/内存操作数?为什么 x86-64 的指令动不动就有 REX 前缀,AVX 又有 VEX?下一篇:ModR/M → REX → VEX——一条指令的前缀家族。"

> → [02-x86-register-operand-encoding.md](02-x86-register-operand-encoding.md)
