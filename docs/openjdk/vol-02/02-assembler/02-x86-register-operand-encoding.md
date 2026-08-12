# 02. ModR/M → REX → VEX — 一个操作数的编码史

> **前置依赖**:[02-assembler/01 — CodeBuffer 与 AbstractAssembler](01-codebuffer-abstract-assembler.md):发射层与 CodeBuffer——本篇讲"字节怎么写"
> → **后续**:[03 — x86 指令集](03-x86-assembler-instruction-set.md)
> 关联域: 05-cpu-primitives(指令级基础)、45-math-library(SSE2 指令)、13-jit

## 为什么 `add %r8, %r9` 比 `add %eax, %ebx` 多 1 字节?

`add %eax, %ebx` 是 2 字节,`add %r8, %r9` 是 3 字节——差别是一个 **REX 前缀**。x86 的指令编码从 1978 年的 8086 一路继承下来:操作数编码(ModR/M)只有 3 位寄存器号,装不下 r8-r15,于是后来的每一次扩展——64 位、AVX、AVX-512——都是**在指令前面加前缀**,而不是改编码格式。这篇拆 JVM 视角的寄存器"号码簿"、ModR/M 与 SIB、REX/VEX/EVEX 三层前缀。

## 1. 寄存器文件:JVM 的"号码簿"

### 1.1 场景:C++ 代码里的 rax 是什么

在 HotSpot 里,`rax` **就是整数 0 的类型化指针**——没有映射表,没有结构体:

```cpp
// register_x86.hpp:34-41、66(截取核心,逐字)
// Use Register as shortcut
class RegisterImpl;
typedef RegisterImpl* Register;

// The implementation of integer registers for the ia32 architecture
inline Register as_Register(int encoding) {
  return (Register)(intptr_t) encoding;
}
  ...
  int   encoding() const                         { assert(is_valid(), "invalid register"); return (intptr_t)this; }
```

`as_Register(5)` 返回的指针值就是 5;`encoding()` 就是 `(intptr_t)this`——**指针值即寄存器号**。x86-64 的 16 个 GPR(register_x86.hpp:51-53、77-93):

```cpp
// register_x86.hpp:51-53、77-84(截取核心,逐字)
    number_of_registers      = 16,
    number_of_byte_registers = 16,
    max_slots_per_register   = 2
  ...
CONSTANT_REGISTER_DECLARATION(Register, rax,    (0));
CONSTANT_REGISTER_DECLARATION(Register, rcx,    (1));
CONSTANT_REGISTER_DECLARATION(Register, rdx,    (2));
CONSTANT_REGISTER_DECLARATION(Register, rbx,    (3));
CONSTANT_REGISTER_DECLARATION(Register, rsp,    (4));
CONSTANT_REGISTER_DECLARATION(Register, rbp,    (5));
CONSTANT_REGISTER_DECLARATION(Register, rsi,    (6));
CONSTANT_REGISTER_DECLARATION(Register, rdi,    (7));
```

- **XMM 寄存器:AMD64 下 32 个**(xmm0-xmm31,153 行)——jdk11u 支持 AVX-512,所以比经典 16 个多一倍
- **KRegister(k0-k7,8 个)**(235-265):AVX-512 的 opmask 寄存器
- **MMX(mmx0-mmx7)**:只在 32 位 stubGenerator 用(211-213 注释:"can't be described by vmreg... can't be used by the compilers")
- x87 的 st0-st7 **没有**对应类——JVM 的寄存器抽象不建模 x87(64 位代码已不用它,45-01 篇讲过)

**VMReg 是"寄存器+栈槽"的统一编号**(share/code/vmreg.hpp:44-78):

```cpp
// vmreg.hpp:67-78(截取核心,逐字)
  static VMReg  as_VMReg(int val, bool bad_ok = false) { assert(val > BAD_REG || bad_ok, "invalid"); return (VMReg) (intptr_t) val; }
  ...
  static VMReg Bad() { return (VMReg) (intptr_t) BAD_REG; }
  bool is_valid() const { return ((intptr_t) this) != BAD_REG; }
  bool is_stack() const { return (intptr_t) this >= (intptr_t) stack0; }
  bool is_reg()   const { return is_valid() && !is_stack(); }
```

注意 `is_stack()` 的判断:**栈槽不是负数,而是从 `stack0` 开始的正数**——`stack0` 是寄存器总数向上对齐 8(vmreg.cpp:30:`(ConcreteRegisterImpl::number_of_registers + 7) & ~7`)。编号体系:0~寄存器数-1 是硬件寄存器,之后全是栈槽;`-1`(BAD_REG)是无效。VMReg 在 OopMap、重定位、帧里统一描述"这个值在寄存器还是栈上"。

**关键设计 (斜体)**: *"指针值即编号"是 HotSpot 寄存器抽象的极致简化:寄存器操作没有任何映射表查找,`encoding()` 就是一次指针强转。C2 的寄存器分配器拿到的也是同一套编码。VMReg 把"寄存器/栈槽"统一成一条数轴,栈槽编号从寄存器数之后开始——GC 扫描、栈回溯、OopMap 都用这一条数轴说话。*

## 2. ModR/M 与 SIB:1978 年的 1 字节

### 2.1 场景:操作数编码只有 3 位

x86 用 **ModR/M 字节**描述操作数:Mod(2 位,寻址模式)+ Reg(3 位,寄存器操作数)+ R/M(3 位,寄存器或内存)。寄存器号只有 3 位(0-7)。JVM 的编码实现在 `emit_operand`(assembler_x86.cpp:479-515)——注释直接把编码写在代码里:

```cpp
// assembler_x86.cpp:487-515(截取核心,逐字)
  int regenc = encode(reg) << 3;
  int indexenc = index->is_valid() ? encode(index) << 3 : 0;
  int baseenc = base->is_valid() ? encode(base) : 0;

  if (base->is_valid()) {
    if (index->is_valid()) {
      assert(scale != Address::no_scale, "inconsistent address");
      // [base + index*scale + disp]
      if (disp == 0 && rtype == relocInfo::none  &&
          base != rbp LP64_ONLY(&& base != r13)) {
        // [base + index*scale]
        // [00 reg 100][ss index base]
        assert(index != rsp, "illegal addressing mode");
        emit_int8(0x04 | regenc);
        emit_int8(scale << 6 | indexenc | baseenc);
      } else if (emit_compressed_disp_byte(disp) && rtype == relocInfo::none) {
        // [base + index*scale + imm8]
        // [01 reg 100][ss index base] imm8
        assert(index != rsp, "illegal addressing mode");
        emit_int8(0x44 | regenc);
        emit_int8(scale << 6 | indexenc | baseenc);
        emit_int8(disp & 0xFF);
      } else {
        // [base + index*scale + disp32]
        // [10 reg 100][ss index base] disp32
        assert(index != rsp, "illegal addressing mode");
        emit_int8(0x84 | regenc);
        emit_int8(scale << 6 | indexenc | baseenc);
        emit_data(disp, rspec, disp32_operand);
      }
```

三个分支对应 Mod 的三种位移:00 无位移、01 disp8、10 disp32。Mod=11(寄存器操作数)是另一条路径。注意 **SIB 字节**(ss index base)的介入:`[base + index*scale + disp]` 这种组合寻址需要第二个编码字节——甚至**没有 index 也要 SIB**:`base == rsp` 时强制 SIB(517-523 行,[00 reg 100][00 100 100]——R/M=100 被 SIB 占用,纯 rsp 寻址反而要写 SIB 才能表达)。scale 是 1/2/4/8(Address::ScaleFactor)。

- [x86: ModR/M 的 3 位字段是 8086 的遗产:当年 8 个寄存器、8 种寻址组合刚好够用;x86-64 加了 8 个寄存器后,3 位不够了——这就是 REX 前缀的由来(下节)]

**关键设计 (斜体)**: *"编码注释写在代码里"是这段代码的鲜明风格:`// [00 reg 100][ss index base]` 直接画出字节布局,assert 同时把"index != rsp"这类编码约束焊死在旁边。对 JIT 而言,编译一个方法时这条路径要被调用成千上万次,注释与断言零成本,而"rsp 不能当 index""rbp 无位移需要特判"这些 40 年的坑,靠 assert 而不是靠人记。*

## 3. REX:第 4 位从哪来

### 3.1 场景:3 位不够,加前缀

REX 前缀(0x40-0x4F,assembler_x86.hpp:521-537)把 Reg/RM/Index 各扩出第 4 位:

```cpp
// assembler_x86.hpp:521-537(截取核心,逐字)
    REX        = 0x40,
    REX_B      = 0x41,
    REX_X      = 0x42,
    REX_XB     = 0x43,
    REX_R      = 0x44,
    ...
    REX_W      = 0x48,
    ...
    REX_WRB    = 0x4F,
```

REX.W=64 位操作数、REX.R=Reg 字段第 4 位、REX.B=RM/Base 第 4 位、REX.X=Index 第 4 位。JVM 侧的生成逻辑(assembler_x86.cpp:8340-8357):

```cpp
// assembler_x86.cpp:8340-8357(截取核心,逐字)
void Assembler::prefix(Register reg) {
  if (reg->encoding() >= 8) {
    prefix(REX_B);
  }
}

void Assembler::prefix(Register dst, Register src, Prefix p) {
  if (src->encoding() >= 8) {
    p = (Prefix)(p | REX_B);
  }
  if (dst->encoding() >= 8) {
    p = (Prefix)( p | REX_R);
  }
  if (p != Prefix_EMPTY) {
    // do not generate an empty prefix
    prefix(p);
  }
}
```

**规则极简:操作数编码 >= 8 就置对应 REX 位;没有高编号寄存器就不发前缀**("do not generate an empty prefix")。所以 `add %eax, %ebx`(都 < 8)2 字节,`add %r8, %r9`(都 >= 8,加 REX.W 64 位)需要 REX.WRB = 0x4F。

- [x86: 64 位模式下默认操作数是 32 位——`addl %eax,%ebx` 不需要 REX;`addq %r8,%r9` 需要 REX.W(64 位)+ REX.R/B(高编号)——这正是"前缀即补丁":编码格式 40 年不变,信息量靠前缀叠加]

**关键设计 (斜体)**: *REX 的设计哲学是"按需付费":每个扩展位都是可选的,能省则省。代价是解码器要处理"前缀可能来也可能不来"的组合——这正是后面 VEX 想解决的历史包袱:VEX 用固定格式一次打包,换来更可预测的解码。*

## 4. VEX 与 EVEX:三操作数与 512 位

### 4.1 场景:AVX 需要第三个操作数

ModR/M 只有两个操作数位(Reg + RM),AVX 的三操作数指令(dest, src1, src2)要把 src2 塞进 **VEX 前缀**:

```cpp
// assembler_x86.hpp:541-575(截取核心,逐字)
    VEX_3bytes = 0xC4,
    VEX_2bytes = 0xC5,
    EVEX_4bytes = 0x62,
    ...
  enum VexPrefix {
    VEX_B = 0x20,
    VEX_X = 0x40,
    VEX_R = 0x80,
    VEX_W = 0x80
  };
  ...
  enum VexSimdPrefix {
    VEX_SIMD_NONE = 0x0,
    VEX_SIMD_66   = 0x1,
    VEX_SIMD_F3   = 0x2,
    VEX_SIMD_F2   = 0x3
  };

  enum VexOpcode {
    VEX_OPCODE_NONE  = 0x0,
    VEX_OPCODE_0F    = 0x1,
    VEX_OPCODE_0F_38 = 0x2,
    VEX_OPCODE_0F_3A = 0x3,
    VEX_OPCODE_MASK  = 0x1F
  };

  enum AvxVectorLen {
    AVX_128bit = 0x0,
    AVX_256bit = 0x1,
    AVX_512bit = 0x2,
    AVX_NoVec  = 0x4
  };
```

VEX 有 2 字节(0xC5)和 3 字节(0xC4)两种:3 字节版的前缀字节里打包 R/X/B、vvvv(第三个操作数)、simd 前缀(66/F3/F2 折叠进 VEX,不再单独发)、opcode 映射(0F/0F38/0F3A)、以及 LL 向量长度(AvxVectorLen)。**VEX 还把原本独立的前缀(66/F3/F2)折叠成一个字段**——少几个字节,代价是解码复杂度。

EVEX(0x62,4 字节)在 VEX 之上再加:opmask(aaa,对应 k0-k7)、broadcast/rounding(b 位)、以及 **压缩位移**——EVEX 的 tuple 类型(EvexTupleType,578-600)决定 disp8 的缩放(compressed displacement)。这正是 45-01 篇里 mulsd 那条指令的完整前缀家族。

**关键设计 (斜体)**: *三层前缀是"向后兼容"的教科书:ModR/M 40 年不动,扩展全部走前缀——REX 按需加 1 字节,VEX 打包成 2-3 字节并折叠旧前缀,EVEX 再叠 4 字节。每一次扩展都在"解码器复杂度"和"指令密度"之间重新权衡;而 JVM 侧看到的只是 `Assembler` 里的一串 `emit_int8(0xC5)...`——上一篇的发射层在这里体现价值:编码的历史包袱被隔离在 cpu/ 目录,上层 C2/C1 完全无感。*

## 核心悬念

"ModR/M 的 3 位、REX 的第 4 位、VEX 的三操作数、EVEX 的 mask——前缀家族到齐。下一篇:400 多条具体指令怎么组织——mov/jmp/call 的变体家族、lock 前缀、SSE/AVX 指令的发射,以及 JVM 怎么用 MacroAssembler 把这些指令拼成'运行时'。"

> → [03-x86-assembler-instruction-set.md](03-x86-assembler-instruction-set.md)
