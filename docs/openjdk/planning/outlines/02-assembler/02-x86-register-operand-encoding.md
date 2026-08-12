# 02. ModR/M → REX → VEX → EVEX — 一个操作数的 40 年进化史

> 🟡 Working | 寄存器文件 + 操作数编码
> 读者处境: rax/rbx 是 JVM 里的整数指针;r8-r15 靠 REX;AVX 三操作数靠 VEX;AVX-512 靠 EVEX。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/02-assembler/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **XMM 是 32 个不是 16 个**(register_x86.hpp:153,xmm0-xmm31,jdk11u 支持 AVX-512)
> - **KRegister 是 k0-k7 共 8 个**(register_x86.hpp:257-265),不是 k1-k7
> - **寄存器 = 指针编码**: `as_Register(enc) = (Register)(intptr_t)enc`、`encoding() = (intptr_t)this`(register_x86.hpp:39-41/66)——无映射表
> - **VMReg 栈槽是正数不是负数**: `is_stack() = value >= stack0`(vmreg.hpp:76),stack0 = 寄存器数向上对齐 8(vmreg.cpp:30);VMReg 类在 share/code/vmreg.hpp:47(非 vmreg_x86)
> - **x87 ST 寄存器无对应类**(JVM 不建模);"8086 只有 4 个寄存器" 错误(8 个:ax bx cx dx si di bp sp)
> - "REGISTER_DEFINITION(r15, 15, 15, 15)" → 实际两参数 REGISTER_DEFINITION(Register, r15)(register_definitions_x86.cpp:31 起)
> - 行号漂移: register_x86.hpp:32 是 typedef;ModR/M 编码在 assembler_x86.cpp:479-515(emit_operand,注释即编码图)

### 1. "寄存器文件 — 指针即编号"

**寄存器抽象**(`register_x86.hpp:34-93` + `235-265`):
```
Register = RegisterImpl*(35); as_Register(enc) = (Register)(intptr_t)enc(39-41); encoding() = (intptr_t)this(66)
GPR 16(51-53, AMD64): rax(0)...r15(15)(77-93); max_slots=2
XMM 32(153): xmm0-xmm31(176-208)
KRegister 8(237-240): k0-k7(257-265)——AVX-512 opmask
MMX 8(216-224): 仅 32 位 stubGenerator(211-213 注释)
x87 ST: 无类(JVM 不建模)
VMReg(share/code/vmreg.hpp:44-78): is_reg = value < stack0; is_stack = value >= stack0; BAD_REG=-1
  stack0 = (寄存器总数+7)&~7(vmreg.cpp:30)——栈槽从正数开始
```
- 关键设计: **指针值即编号**——寄存器操作零映射表;VMReg 把"寄存器/栈槽"统一成一条数轴,GC/OopMap/栈回溯共用。

### 2. "ModR/M 与 SIB"

**编码**(`assembler_x86.cpp:479-515`):
```
ModR/M: Mod(2bit 寻址模式) + Reg(3bit) + R/M(3bit)——寄存器号只有 3 位(0-7)
emit_operand 三分支(注释即编码图):
  [00 reg 100][ss index base]            无位移(500-501)
  [01 reg 100][ss index base] imm8       disp8(506-508)
  [10 reg 100][ss index base] disp32     disp32(513-515)
SIB(ss index base): [base + index*scale + disp]; base==rsp/r12 强制 SIB(517-523,[00 reg 100][00 100 100])
```
- 关键设计: **编码注释写在代码里**——`// [00 reg 100][ss index base]` 直接画字节布局;assert 焊死 "index != rsp" 等 40 年编码约束。

### 3. "REX → VEX → EVEX"

**前缀**(`assembler_x86.hpp:521-600`):
```
REX(0x40-0x4F): W=64位操作数/R=Reg第4位/X=Index第4位/B=RM第4位
  生成规则(assembler_x86.cpp:8340-8357): encoding>=8 置对应位;无高编号不发前缀("do not generate an empty prefix")
VEX(0xC4 3B/0xC5 2B): vvvv=第三操作数; 折叠 66/F3/F2(VexSimdPrefix)+opcode 映射(VexOpcode 0F/0F38/0F3A)+LL 向量长度(AvxVectorLen)
EVEX(0x62 4B): opmask(aaa,k0-k7)+broadcast/rounding(b 位)+压缩位移(EvexTupleType 578-600, disp8 缩放)
```
- 关键设计: **向后兼容=前缀叠加**——ModR/M 40 年不动,扩展全走前缀(按需 1B / 打包 2-3B / 再叠 4B);编码历史包袱隔离在 cpu/,上层 C2/C1 无感。

---

### 核心悬念

**"为什么 add %r8,%r9 比 add %eax,%ebx 多 1 字节?"** — REX 前缀;x86 保留 8086 的 ModR/M,扩展靠前缀。下一篇: 400+ 条具体指令——mov/jmp/call/lock/SSE/AVX 怎么组织,MacroAssembler 怎么拼出"运行时"。

> → [03-x86-assembler-instruction-set.md](03-x86-assembler-instruction-set.md)
