# 02. ModR/M → REX → VEX → EVEX — 一个操作数的 40 年进化史

> 🟡 Working | 15 KP 中的 2 个编码机制
> 读者处境: 你知道 x86 有 rax/rbx/rcx。但 r8-r15 怎么来的？AVX 的 YMM 呢？

### 1. x86 寄存器文件 — 四种寄存器类型

**GPR 16 个** (`register_x86.hpp:32`): rax/rcx/rdx/rbx/rsp/rbp/rsi/rdi/r8-r15
- 32 位编码: 16-bit type + 16-bit number — `REGISTER_DEFINITION(r15, 15, 15, 15)` (`register_definitions_x86.cpp`)
- [x86: GPR 历史——8086 只有 ax/bx/cx/dx (16-bit)。386 扩展为 eax/ebx/ecx/edx (32-bit)。x86-64 增加 r8-r15 (64-bit)。rsp (stack pointer) 和 rbp (frame base) 有专属用途——JIT 不拿它们做通用寄存器]

**XMM 16 个** (`register_x86.hpp:90`): xmm0-xmm15 (128/256/512-bit)
- SSE/AVX 浮点和 SIMD——JIT 编译 double/float 操作使用

**ST 8 个**: st0-st7 — x87 浮点栈
- 仍然被 Math Intrinsics (sin/cos/log/exp) 使用——因为 80-bit 精度

**KRegister** (`register_x86.hpp:135`): k1-k7 — AVX-512 opmask
- 每条 AVX-512 指令可指定 mask——只有被 mask 的 lane 参与计算

**VMReg 转换** (`vmreg_x86.hpp:34`):
- VMReg: 正数=硬件寄存器，负数=栈槽 (`vmreg_x86.hpp:60`)
- XMM→2 个 VMReg: xmm 有 128-bit，一个 VMReg 只能存 64-bit → 需要两个 (`vmreg_x86.cpp:38`)

### 2. ModR/M — 1978 年的编码，2025 年还在用

**1 字节的编码** (`assembler_x86.hpp:110-130`):
- Mod (2bit): 0=无 displacement, 1=disp8, 2=disp32, 3=register
- Reg (3bit): 寄存器操作数——配合 prefix 的 REX.R 扩展到 4bit
- R/M (3bit): 基址/寄存器——配合 REX.B 扩展到 4bit
- [x86: ModR/M 的 8086 起源——1978 年 Intel 设计了 12 种寻址模式: [BX+SI], [BX+DI], [BP+SI], [BP+DI], [SI], [DI], [BP], [BX], direct, immediate。40 年后这些编码格式完全未变——所有扩展通过 prefix 而非改 ModR/M]

**SIB (Scale-Index-Base)** — ModR/M 需要更多时:
- S=1/2/4/8 (scale), I=index reg, B=base reg
- `[base + index*scale + displacement]` — 典型数组访问 a[i*4] (`assembler_x86.hpp:130`)
- R/M=100 (ESP) → 必须 SIB——即使 scale=1

### 3. REX → VEX → EVEX — 三层前缀的进化

**REX (0x40-0x4F, 1B)** (`assembler_x86.hpp:97`):
- 解决 r8-r15 的访问——ModR/M 的 Reg 和 R/M 字段只有 3bit (0-7)
- REX.R=高1bit Reg, REX.B=高1bit Base, REX.X=高1bit Index, REX.W=64-bit operand size
- [x86: 64-bit 模式默认 operand size=32-bit。`addl %eax, %ebx` 不需要 REX。`addq %r8, %r9` 需要 REX (W=1 + B=1 Reg=r8). REX prefix 只在操作 64-bit 或 r8-r15 时才有——节省 1 字节]

**VEX (0xC4/0xC5, 2-3B)** (`assembler_x86.hpp:104`):
- 256-bit YMM (__m256) + 3-operand (dest, src1, src2)
- ModR/M 只有 2 操作数——VEX 的额外字段编码 vvvv (源寄存器)
- vvvv 在 ModR/M 的空间之外——不破坏 40 年的兼容性

**EVEX (0x62, 4B)** (`assembler_x86.hpp`):
- AVX-512: 512-bit ZMM + mask (KRegister) + broadcast (复制一个值到所有 lane)
- [x86: EVEX 的 4 字节编码——aaa (opmask 寄存器=K1-K7)，b (broadcast/embedded rounding)，LL (vector length=128/256/512)。mm 位压缩 (compressed displacement)——disp8*N = 完整偏移]

---

### 核心悬念

**"为什么一条 `add %r8, %r9` 需要 3 字节而 `add %eax, %ebx` 只需 2 字节？"** — REX 前缀。x86 保留了 8086 的 1 字节 ModR/M 编码——所有扩展通过 prefix 而非改格式。这是 40 年二进制兼容的代价——每条 64-bit 或 r8+ 指令多花 1 字节。下一章: 400+ 条具体指令——mov/jmp/call/lock/sse/avx。

> → [03-x86-assembler-instruction-set.md](03-x86-assembler-instruction-set.md)
