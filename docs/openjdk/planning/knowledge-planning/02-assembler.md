# 域 02: Assembler — 知识规划

> 源码路径: hotspot/share/asm/ + hotspot/cpu/x86/assembler* + macroAssembler* + register*
> 源码量: share/asm 9 + cpu/x86 ~29 = ~38 文件 / ~28,200 行
> 接近巨型域阈值 (≥30,000行)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| asm/codeBuffer.hpp:73-370 + codeBuffer.cpp | **CodeBuffer — 代码生成三段布局**: 三节(sect_stubs/sect_consts/sect_code)+locator编码(16位sect+16位pos)+段间对齐+relocation表+OOP/narrow OOP记录 | High |
| asm/assembler.hpp + assembler.cpp + assembler.inline.hpp | **AbstractAssembler — 汇编器抽象层**: code_section管理+Label(patched/unpatched三种)+offset()+pc()抽象+relocation发射+delayed_nop(不提交指令直到知道长度) | High |
| asm/register.hpp:32-133 + register.cpp | **RegisterImpl — 32位寄存器编码**: AbstractRegister→ConcreteRegister→RegisterImpl链, 32位编码(16位type+16位number), max_gpr/max_xmm/max_fpr等max系列常量 | High |
| cpu/x86/register_x86.hpp + register_x86.cpp | **x86 寄存器文件 — GPR/ST/XD/Float/KRegister/掩码**: 16个GPR(rax-r15), 16个XMM(xmm0-15), 8个ST(浮点栈), K1-K7+掩码, register definitions注册表 | High |
| cpu/x86/vmreg_x86.hpp + vmreg_x86.cpp | **VMReg — 栈槽/寄存器统一编号**: ConcreteRegister↔VMReg双向转换, stack0/stack_bias, xmm寄存器对齐处理 | High |
| cpu/x86/assembler_x86.hpp:250-3500 + assembler_x86.cpp:1-9500 | **x86 Assembler — 400+条指令编码**: 前缀(REX/VEX/EVEX/Legacy/address-size/operand-size), ModR/M+SIB寻址模式, 指令组分类(mov/arithmetic/jmp/call/logical/bswap/cmov/string/sse/avx/lock/mfence) | High |
| cpu/x86/assembler_x86.hpp:94-249 | **x86 操作数编码体系**: Address/Operand/Register/Immediate, 4种scale(1/2/4/8), base+index+disp组合, RIP相对寻址 | High |
| cpu/x86/macroAssembler_x86.hpp + macroAssembler_x86.cpp:1-10000 | **x86 MacroAssembler — 运行时支持**: call_VM(调用C++函数), safepoint_poll(轮询页检查), verified_entry(已验证入口), frame管理(enter/leave/setup/teardown), stack_bang(栈溢出探针), OOP压缩(encode/decode heap oop) | High |
| cpu/x86/macroAssembler_x86_sin/cos/tan/log/log10/exp/pow.cpp | **Math Intrinsics — 超越函数代码生成**: 6个超越函数(sin/cos/tan/log/log10/exp/pow), 基于C2Call/MacroAssembler, 精度vs速度权衡 | High |
| cpu/x86/macroAssembler_x86_aes.cpp + _sha.cpp | **Crypto Intrinsics — AES/SHA指令**: AES-NI(enc/dec/keygen), SHA-1/SHA-256, 固定时序(constant-time)实现 | High |
| asm/codeBuffer.hpp:160-186 | **Label体系 — 前向/后向分支**: patched(unbound)/bound状态, link/unlink/location/address, 列表式链式patch(patched状态) | High |
| cpu/x86/assembler_x86.inline.hpp + assembler_x86.hpp:60-93 | **Relocation集成 — 可重定位标记**: emit_operand→relocInfo::polling_page_reloc()标记, movq→oop_reloc, call→runtime_call_reloc, 后续CodeCache链接时resolve | High |
| cpu/x86/register_definitions_x86.cpp | **寄存器使用约定 — ABI映射**: RSP(stack pointer), RBP(frame base), RAX(返回值), R10-R15, RDI(systemV第一参数), 调用约定分配 | Medium |
| cpu/x86/codeBuffer_x86.hpp | **CodeBuffer x86扩展 — NOP填充**: 最优NOP序列(1-byte nop→多字节推荐编码), alignment padding策略 | Medium |
| cpu/x86/bytes_x86.hpp + copy_x86.hpp + globalDefinitions_x86.hpp + globals_x86.hpp + icache_x86.cpp | **平台基础 — 字节序/原子操作/icache刷新**: bytes_swap, 原子copy, CPU feature检测, 指令缓存刷新(对于self-modifying code) | Low |

*15 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识 (≥5 文件)

| KP | 出现文件 |
|----|---------|
| x86 指令编码 (ModR/M+SIB+REX+VEX) | assembler_x86.hpp.cpp, macroAssembler_x86.hpp.cpp, assembler_x86.inline.hpp, register_x86.hpp, codeBuffer_x86.hpp, +6 C1/C2/解释器文件中引用 |
| AbstractAssembler + CodeBuffer 三层布局 | codeBuffer.hpp.cpp, assembler.hpp.cpp.inline.hpp, assembler_x86.hpp.cpp, codeBuffer_x86.hpp, +C1/C2/StubGenerator 大量引用 |

### P2 — 局部重要 (2-4 文件)

| KP | 出现文件 |
|----|---------|
| RegisterImpl → x86 具体寄存器文件 | register.hpp.cpp, register_x86.hpp.cpp, register_definitions_x86.cpp |
| MacroAssembler 运行时支持 (call_VM/safepoint_poll/locking) | macroAssembler_x86.hpp.cpp.inline.hpp |
| Math Intrinsics (6个超越函数) | macroAssembler_x86_sin/cos/tan/log/log10/exp/pow.cpp |
| Crypto Intrinsics (AES/SHA) | macroAssembler_x86_aes.cpp, _sha.cpp |
| VMReg — 栈槽/寄存器统一编号 | vmreg_x86.hpp.cpp.inline.hpp |
| Label 系统 — 前向/后向分支 | assembler.hpp.cpp, assembler_x86.hpp |
| Relocation 集成 | assembler_x86.hpp.inline.hpp, assembler.hpp |

### P3 — 孤立 (1 文件/小系统)

| KP | 文件 |
|----|------|
| bytes/copy/globalDef/icache 平台基础 | bytes_x86.hpp, copy_x86.hpp, globalDefinitions_x86.hpp, globals_x86.hpp, icache_x86.cpp |
| 调用约定/ABI | register_definitions_x86.cpp |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (5 KP)

| KP | 为什么 🔴 |
|----|---------|
| CodeBuffer 三段布局 + locator 编码 | **数据结构选择**: 为什么 code/stubs/consts 三节分离而不是一个平坦缓冲区？→ 指令和数据需要不同的 relocation 类型和不同的 GC 可见性。locator 16+16=32位编码为什么不溢出？→ 每节内偏移≤16位(64KB)足够单条编译单元 |
| x86 操作数编码体系 (ModR/M+SIB+REX+VEX+EVEX) | **编码策略**: REX 前缀解决 r8-r15 的访问(前32位只有ModR/M里3+3=6bit→最多8个GPR)。VEX 前缀为256位__m256/YMM做3地址操作数。EVEX 前缀为 AVX-512 的 mask+广播。四级前缀演进是x86复杂指令集的编码史 |
| 400+ 条 x86 指令编码 | **架构决策**: 为什么不是JIT直写机器码？→ 400+条指令的编码规则(MovR/MovA/ArithO/JccD/CallX/SSE_AVX/Lock...)需要统一验证和relocation标记。每条Instruction方法生成1-15字节不等的x86机器码 |
| MacroAssembler — 运行时桥接 | **跨组件交互**: call_VM(call_stub→C++函数调用)的传参(c_rarg0-5)+保存volatile寄存器+OOPMap(NMethod GC扫描); safepoint_poll=test[polling_page]%rax; verified_entry=方法入口屏障(栈检查/编译优化) |
| Math/Crypto Intrinsics | **性能权衡**: sin/cos/log/exp为什么用FYL2X/F2XM1等x87指令？→ x87的80位精度vs SSE的64位，过去Tradeoff:精度(9 ULP) vs 速度(10x)。AES-NI/SHA-NI:硬件指令消除Timing Attack, constant-time实现无分支无表查 |

### 🟡 Working — 有设计但非核心 (5 KP)

| KP | 说明 |
|----|------|
| AbstractAssembler 抽象层 | 接口定义(emit/pc/relocate/label)但对share/层很薄——x86占了硬编码的95% |
| Label 系统 (patched/unpatched) | 精巧但模式固定——无特别设计决策 |
| Relocation 集成 | 标记哪些指令位置需后期修正(oop_reloc/opt_virtual_call_reloc/...) |
| RegisterImpl 32位编码 | bit-packing 技巧——但16位type+16位number足够注册所有类型 |
| VMReg — 栈槽/寄存器统一编号 | 栈槽负数+寄存器正数的编号空间划分技巧 |

### 🟢 Surface — 了解即可 (5 KP)

| KP | 说明 |
|----|------|
| bytes/copy/globalDef 平台基础 | 薄包装 |
| icache 刷新 | 极少触发(self-modifying code), 现代JIT不用 |
| 调用约定/ABI | reference材料——不需要深度分析 |

*注: 15KP → 🔴5 + 🟡5 + 🟢5 (math/crypto合并为一个🔴)*

## 04 聚类 — 教学顺序与文章拆分

### 依赖图

```
A: CodeBuffer + AbstractAssembler ← 无前置(抽象层)
  ├─ B: x86 寄存器编码 (GPR/ST/XMM/KRegister) ← 依赖? (RegisterImpl 在抽象层)
  ├─ C: x86 操作数编码 (ModR/M→REX→VEX→EVEX) ← 依赖 B (寄存器是操作数)
  │    └─ D: x86 400+ 指令编码 ← 依赖 C (操作数编码是每条指令的共同需求)
  │         └─ E: MacroAssembler 运行时 ← 依赖 D (生成call_VM等高级模式)
  │              └─ F: Math/Crypto Intrinsics ← 依赖 E (使用MacroAssembler生成代码)
  └─ G: Label + Relocation ← 依赖 A (CodeBuffer中的补丁/重定位)
```

### 教学顺序

```
1. CodeBuffer + AbstractAssembler (A+G) — 生成机器码的容器+抽象
2. x86 寄存器编码 (B) — 编码之前先看懂寄存器文件
3. x86 操作数编码 + 指令集 (C+D) — 编码的核心
4. MacroAssembler + Math/Crypto (E+F) — 运行时支持层
```

### 文章拆分建议

4 篇（~28K行接近巨型域，拆分保证指令集不被压缩）：

- **01-codebuffer-abstract-assembler.md** — CodeBuffer + AbstractAssembler + Label + Relocation
- **02-x86-register-operand-encoding.md** — 寄存器文件 + 操作数编码 (ModR/M→REX→VEX→EVEX)
- **03-x86-assembler-instruction-set.md** — 400+ 条指令分类编码
- **04-x86-macroassembler-runtime.md** — MacroAssembler + Math/Crypto
