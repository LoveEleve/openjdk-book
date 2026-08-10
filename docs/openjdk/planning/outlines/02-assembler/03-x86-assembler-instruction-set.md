# 03. 400+ 条 x86 指令 — JVM 用多少？150 条。

> 🔴 Deep | 15 KP 中的指令编码体系
> 读者处境: 你知道 x86 指令多。JVM 的 JIT 只用 120-150 条——其他都是死代码。

### 1. 数据传输 — mov / lea / cmovcc

**mov 家族** (`assembler_x86.hpp:260-520`):
- movb/w/l/q — 不同 operand size (8/16/32/64 bit)
- movzbl/movzwl/movslq — 零扩展/符号扩展
- [x86: movzbl — 取 1B (z=zero, b=byte)，扩展到 32-bit (l=long)。源=1B，目标=4B。类似 Java 的 `(int)(byte & 0xFF)` && 重排。符号扩展 movslq — do signed 32→64]
- cmovcc — 条件移动 (16 种条件), 消除 jmp → 消除分支预测失败 (`assembler_x86.hpp:520`)
- [x86: cmov 代价——2 cycle 执行 vs jmp (1-20 cycle 取决于预测)。cmov 总是 2 cycle, jmp 可能 1 cycle (正确预测) 或 20 cycle (错误)。用 cmov 消除不可预测的分支]

**lea — 不访内存的地址运算** (`assembler_x86.hpp:365`):
- `lea rax, [rbx + rcx*4 + 8]` = rax = rbx + rcx*4 + 8——3 cycle vs mov+add 的 5 cycle
- [x86: lea 算地址但不 load——AGU (Address Generation Unit) 计算完就返回。mov+add 需要两次 pass (先 mov 再 add)——lea 一次完成]

### 2. 算术 — add/sub/imul/idiv/cmp + lock

**算术指令** (`assembler_x86.hpp:380-450`):
- addq/subq: 64-bit 直接运算
- imulq: 有符号乘法 — rax*rdx = rA:rD (128-bit) (`assembler_x86.hpp:400`)
- idivq: 有符号除法 — quotient in rax, remainder in rdx (`assembler_x86.hpp:410`)
- [x86: imul vs mul — imul 的 3-operand form= dest, src1, src2。mul 总是 rax*src → rdx:rax。JIT 用 imul 省去 load rax 的开销]

**cmp + branch** — 编译器的 compareAndSwap:
- cmpq + conditional jump: 比较→分支 — 锁基础 (`assembler_x86.hpp:625`)

**lock prefix** (`assembler_x86.hpp:185`):
- lock cmpxchg: 原子 compare-and-swap
- [x86: LOCK prefix — 锁定内存总线 + cache line (MESI exclusive state)。其他 CPU 不能访问同一 cache line——直到 lock 释放。`lock cmpxchg` 是 JVM 所有 atomic 操作的唯一硬件原语]
- [x86: MESI protocol — Modified/Exclusive/Shared/Invalid。LOCK cmpxchg 把 cache line 置为 Exclusive (其他 CPU 被 Invalidated)。下次它们访问 → cache miss → 重新从内存读]

### 3. 控制流 — jmp / jcc / call / ret

**jmp 三种编码** (`assembler_x86.hpp:600`):
- jmp rel8 (2B): -128~+127 短跳 — 最常用
- jmp rel32 (5B): ±2GB — label 很远时
- jmp r/m (6B): 间接跳转 — computed goto (switch table)
- JIT 延迟选择: 先用 delayed_nop 占 5B，resolve 后短跳就缩短

**call / jmp indirect** — relocation 标记 (`assembler_x86.hpp:650`):
- call 到 stub → 后期 resolve 到具体运行时地址
- relocation 类型: runtime_call_reloc (调用 VM 函数), opt_virtual_call_reloc (优化虚调用)

### 4. SSE/AVX + membar

**SSE scalar** (`assembler_x86.hpp:810`):
- addsd/subss/mulsd/divss — 双精度/单精度浮点
- JIT 编译 double/float 的 `+ - * /` 用 SSE 指令——比 x87 快但精度是 64/32-bit

**AVX 3-operand**: vaddss/vmulss — dest, src1, src2 独立
- SSE: dest=dest op src (破坏性)——要保存 dest 的值用 `mov`
- AVX: dest=src1 op src2 (非破坏性)——省一条 mov

**membar** (`assembler_x86.hpp:190`):
- mfence/lfence/sfence — store/load fence
- [x86: mfence 代价 ~33-100 cycles——但 x86 TSO 内存模型意味着 loadload/loadstore/storestore 默认保证——只需 storeload barrier。mfence 是最重的——用 UseMembar=false 的序列化页替代]

---

### 核心悬念

**"为什么 JIT 选择 150 条而不是 400+ 条 x86 指令？"** — JIT 编译的范式: mov/算术/比较/跳转/SSE/avx/barrier 足够覆盖 95% 的 Java 代码。string operations, decimal adjust, x87 超越函数——没用。但 Assembler 必须编码全部——因为 Java native 代码可能用任何 x86 指令。下一章: MacroAssembler — 不只是单条指令，而是 call_VM / safepoint / AES 的完整代码模板。

> → [04-x86-macroassembler-runtime.md](04-x86-macroassembler-runtime.md)
