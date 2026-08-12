# 01. CodeBuffer + AbstractAssembler — JIT 怎么生成可用的机器码？

> 🔴 Deep | 基础设施: 代码缓冲、发射层、Label 补丁
> 读者处境: JIT 编译了 Java 方法——机器码写到 CodeBuffer(CodeBuffer 三节),发射靠 AbstractAssembler,前向跳转靠 Label 补丁系统。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/02-assembler/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"delayed_nop" 编造**: 前向跳转的机制是"先发长格式(rel32=0)+ `add_patch_at` 登记 + bind 后 `pd_patch_instruction` 回填"(assembler_x86.cpp:2104-2135);delayed 类机制实际是 **DelayedConstant**(assembler.cpp:205-258,运行时常量槽,20 个)
> - **Label 补丁不是链表**: 是 4 元素数组 `_patches[4]` + 溢出 GrowableArray(assembler.hpp:64-93 注释明说 "Instead of using a linked list");三态是 **unused/unbound/bound**(_loc 符号编码,78-83/129-131),不是 unbound/patched/bound;API 是 add_patch_at(144)非 link_to
> - **locator 不是 16+16**: `locator = pos << 2 | sect`(codeBuffer.hpp:514-517,sect_bits=2)
> - **NOP 3B 不是 0F 1F 00**: 是 `66 66 90`(assembler_x86.cpp:3129,"need patching safe padding");jcc 长跳 6B(0F 8x rel32)非 5B
> - 行号漂移: Label@assembler.hpp:74、AbstractAssembler@205、emit_int8@281、relocate@330;assembler.inline.hpp 只有 32 行(大纲的 :37/:72 不存在)

### 1. CodeBuffer — 三节一张纸

**三节结构** (`codeBuffer.hpp:340-373`):
- SECT_CONSTS(357): 非指令数据(浮点、跳转表)——GC 可见
- SECT_INSTS(358): 可执行指令(方法主体)
- SECT_STUBS(359): 调用点 trampoline、异常/deopt
- locator(514-517): `pos << 2 | sect`(低 2 位节号,高位节内偏移);CodeSection(86-245)每节有自己的代码区(_start/_end/_limit)+ 重定位区(_locs_*)
- emit_int8(203): `*((int8_t*) end()) = x; set_end(end()+1)`
- [x86: 对齐 alignment() = MAX2(jdouble, CodeEntryAlignment)(226);CodeEntryAlignment=32(globals_x86.hpp:49,icache line 一半)]
- CodeBuffer 是 StackObj(340);_blob(377)指向 CodeCache 的 BufferBlob;四种构造(455-479)
- initialize_section_size(codeBuffer.cpp:160-176)从 insts 尾部划节;freeze_section(178-196)冻结后空间给下一节;expand(449,"Creates a new, larger BufferBlob, and rewrites the code & relocs")

- 关键设计: **三节分离=按生命周期分工**(insts 执行/consts GC 扫/stubs 备胎);最终按 SECT 顺序拼接(consts→insts→stubs,354-356 注释 "The order reflects the final layout")。

### 2. AbstractAssembler — 平台无关发射层

**抽象层** (`assembler.hpp:205-457`):
- emit_int8/16/32/64(281-284): 内联非虚,直接写当前节
- pc()(318)= code_section()->end();offset()(319);locator()(320)
- relocate(330-338): 在指令边界打重定位标记(InstructionMark 226-238 强制边界)
- 整个类只有两个纯虚: delayed_value_impl(432)/bang_stack_with_offset(441)
- [C++: 发射路径零虚函数;delayed_value 机制 = DelayedConstant(assembler.cpp:205-258,20 槽,运行时算值)]

- 关键设计: **AbstractAssembler 只做"字节+位置+标记",不做指令**——指令编码在 cpu/ 的 Assembler 子类(下一篇);Label/重定位/CodeBuffer 基础设施只写一次。

### 3. Label 补丁 — 前向跳转的事后回填

**Label 三态** (`assembler.hpp:74-170`):
- _loc 符号编码(78-83): >=0 bound / ==-1 unbound;is_unused 是 _loc==-1 && _patch_index==0(129-131)
- 补丁存储(64-93): `_patches[PatchCacheSize=4]` 数组缓存 + 溢出 GrowableArray(注释:"handles over 99.5% of the cases")
- add_patch_at(144)/patch_instructions(150)→ pd_patch_instruction(平台实现)

**前向跳转**(`assembler_x86.cpp:2104-2160`):
```
jcc(cc, L)(2104): L 已 bound → 当场算偏移选短(2B 0x70|cc rel8)/长(6B 0F 0x8x rel32)
                  L 未 bound → add_patch_at + 先发 6B 长格式(rel32=0),bind 后回填
jccb(2138): 显式 8 位短跳版本
```
- 关键设计: **"先发长格式、绑定后回填"**——向前跳永远 6B,生成器不用回头;短跳是绑定后的福利。4 元素数组缓存代替链表:绝大多数 Label 只有 1-2 个引用点。

### 4. 对齐与 NOP

**多字节 NOP**(`assembler_x86.cpp:3111-3131`):
- ASSERT 版: 一律 0x90(好反汇编);生产版 UseAddressNop+Intel: 1:0x90 2:66 90 3:**66 66 90**(不用 0F 1F 00!)4:0F 1F 40 00 5:0F 1F 44 00 00
- 关键设计: **patching safe padding**——0F 1F 00 的 0x00 会被跳转目标回填误伤;对齐填充要"对补丁/重定位不可见"。

---

### 核心悬念

**"CodeBuffer(三节+locator)/AbstractAssembler(字节+位置+标记)/Label(数组补丁回填)——纸笔就位。但具体一条指令怎么写,由 x86 编码规则决定: ModR/M 怎么编码寄存器与内存操作数?为什么有 REX/VEX 前缀?"** — 下一篇: ModR/M → REX → VEX。

> → [02-x86-register-operand-encoding.md](02-x86-register-operand-encoding.md)
