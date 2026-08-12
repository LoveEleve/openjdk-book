# 03. 400+ 条 x86 指令 — JVM 用多少？一个小子集。

> 🔴 Deep | 指令编码体系
> 读者处境: x86 指令数百条,JIT 编译 Java 只用其中一小撮: mov/add/cmp/jcc/call/jmp/lock/SSE/屏障。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/02-assembler/03 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **addsd 的 VEX 编码实证**: `simd_prefix_and_encode(dst, dst, src, VEX_SIMD_F2, VEX_OPCODE_0F, &attributes)` + `rex_w=VM_Version::supports_evex()`(assembler_x86.cpp:1274-1282)——vvvv 填 dst 保持破坏性语义;legacy 前缀是 **F2**(非 66)
> - **jmp 前向跳转固定 0xE9 rel32(5B)**,无 delayed_nop(注释 2188-2192:"forward jumps are always 32-bit displacements... use jmpb")——与 01 篇一致
> - **间接 jmp(Register)是 2B**(0xFF 0xE0|enc,2196-2199),非 6B
> - **"150 条" 无依据,删除**;cmov/jmp 的 cycle 数仅作 [x86:] 常识标注
> - 行号漂移: mov 家族 2289+/2815+、cmovl@1587、lea@8109、addq@8567、lock@2268、mfence@2282、addsd@1274

### 1. "mov 家族与 lea"

**搬数据**(`assembler_x86.cpp:2289-2320` + `3023-3057`):
```
mov(reg,reg)(2289-2291): LP64→movq / 32位→movl——宽度由类型决定
movzbl(3023, "movzxb"): 零扩展 1B→32B;movsbl(2905)/movslq(9057): 符号扩展
cmovl(1587-1598): 0F 40|cc——16 种条件移动,无分支
lea(8109→leal 2252): 地址运算当算术用(不访内存,不写 flags)
```
- 关键设计: **宽度后缀(b/w/l/q)映射 JVM 类型宽度**;cmov="用执行换分支"(不可预测分支比 jmp 稳)。

### 2. "算术与原子"

**算术**(`assembler_x86.cpp:246-269` + `8567-8573` + `8880-8906`):
```
emit_arith(257-269): 立即数统一路径——imm32 能缩 8 位时自动用 sign-ext imm8(op1|0x02, 261-264)省 3 字节
imulq(8886): 0F AF 两操作数;idivq(8880): 隐含操作数(商 rax/余 rdx)
lock(2268-2270): emit_int8(0xF0)——JVM 所有 CAS/fetch-add 的硬件根基(05域01)
```
- 关键设计: **指令即原语**——并发正确性的物理根基就是 lock()+cmpxchg 两个方法。

### 3. "控制流"

**jmp 三编码**(`assembler_x86.cpp:2169-2199`):
```
0xEB rel8(2B): ±127 短跳(bound 后才知道能否用)
0xE9 rel32(5B): 前向固定此格式(注释 2188-2192),bind 后回填——01 篇 Label 机制落地
0xFF /r(2B): 间接跳(Register)——switch table computed goto
call(1530-1552): 0xE8 rel32 + relocation 类型参数(runtime_call_reloc 等由调用方传)
```
- 关键设计: **距离决定编码,未知距离一律长格式**;jmpb/jccb 是手动省字节手段。

### 4. "SSE/AVX 与屏障"

**浮点与内存序**(`assembler_x86.cpp:1274-1282` + `2282-2287`):
```
addsd(1274-1282): 0x58 + VEX 编码——simd_prefix_and_encode(dst, dst, src, VEX_SIMD_F2, ...)
  → vvvv=dst(破坏性语义保持);rex_w=supports_evex()
addss(1294)/mulsd(3067): 同族
mfence(2282): 0F AE F0;lfence(2262): 0F AE E8——05域01 的四屏障字表
```
- 关键设计: **破坏性(SSE)→非破坏性(AVX)**——VEX vvvv 独立 src 省一条 mov;JIT 靠 UseAVX 编译期选择。

---

### 核心悬念

**"为什么 JIT 只用小子集?"** — mov/算术/比较/跳转/SSE/屏障覆盖 95% Java 代码;但 MacroAssembler 才是真正的'运行时': call_VM(挂 safepoint)、轮询页检查、卡表屏障、AES 模板——下一篇: MacroAssembler 运行时。

> → [04-x86-macroassembler-runtime.md](04-x86-macroassembler-runtime.md)
