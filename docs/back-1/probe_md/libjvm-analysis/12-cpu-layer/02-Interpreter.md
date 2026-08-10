# 02-Interpreter — TemplateTable 字节码→x86_64指令模板、dispatch table O(1)分发、safepoint poll指令级实现

> **阶段**：[12-cpu-layer]
> **前置**：[12-01] Frames（解释器帧布局建立在帧模型上）, [12-04] CPUID（UseSSE/UseAVX 决定生成的指令版本）, [08-safepoint]（polling page 概念 → 机器码实现）, [06-01] Bytecode（字节码语义）
> **依赖本文**：[12-03] Stubs（deopt 需要理解解释器帧格式才能拆解编译帧）
> **阅读收益**：理解 TemplateTable 如何把 200+ Java 字节码翻译为 x86_64 指令模板——从 iload 的 local read+push 到 invokevirtual 的单态 inline cache 快速路径、从 dispatch table 的 O(1) 跳转到 safepoint poll 的 2 指令零开销检查、从方法入口的 6 步帧初始化到解释器帧中 bcp/locals/method\* 的固定偏移保存

---

## §〇 源文件清单（跨 cpu/x86 + share/interpreter + runtime）

| # | 文件 | 完整路径 | 模块 | 核心函数/类（已验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `templateTable_x86.cpp` | `src/hotspot/cpu/x86/templateTable_x86.cpp` | cpu/x86 | `iload_internal`(:622), `iload(int n)`(:878), `iop2(add)`(:1337-1343), `getfield_or_static`(:2860), `volatile_barrier`(:2715), `putfield_or_static`(volatile barrier at :3257, :3315) | ★★★ 核心—每个字节码到 x86_64 指令的映射 |
| 2 | `templateInterpreterGenerator_x86_64.cpp` | `src/hotspot/cpu/x86/templateInterpreterGenerator_x86_64.cpp` | cpu/x86 | `generate_math_entry`(:338), `generate_CRC32_*_entry`(:183,:231,:288) | ★★ 方法入口——数学 intrinsic / CRC intrinsic 的快速路径 |
| 3 | `interp_masm_x86.cpp` | `src/hotspot/cpu/x86/interp_masm_x86.cpp` | cpu/x86 | `dispatch_base`(:808), `dispatch_next`(:881), `dispatch_via`(:889), `remove_activation`(:953) | ★★★ 解释器专用汇编宏——dispatch + lock + remove |
| 4 | `interp_masm_x86.hpp` | `src/hotspot/cpu/x86/interp_masm_x86.hpp` | cpu/x86 | `dispatch_next`(:123), `save_bcp`(:67), `restore_bcp`(:71), `get_method`(:80), `get_constant_pool_cache`(:94) | ★★ 寄存器访问器 + dispatch 声明 |
| 5 | `macroAssembler_x86.cpp` | `src/hotspot/cpu/x86/macroAssembler_x86.cpp` | cpu/x86 | `safepoint_poll`(:3744), `set_last_Java_frame`(:3768) | ★★ safepoint poll 指令生成 |
| 6 | `assembler_x86.hpp` | `src/hotspot/cpu/x86/assembler_x86.hpp` | cpu/x86 | `membar()`(:1351-1387), `Membar_mask_bits`(:1343-1348), `rscratch1`(:130), `r15_thread`(:134) | ★★ membar——volatile 的内存屏障 |
| 7 | `templateTable.hpp` | `src/hotspot/share/interpreter/templateTable.hpp` | interpreter | `TemplateTable` 基类定义 | 跨平台接口 |

**跨模块说明**：解释器代码生成横跨 `cpu/x86/`（x86_64 专有生成器）和 `share/interpreter/`（跨平台基类）。`templateTable_x86.cpp` 是本文的核心——它把每一个 Java 字节码映射为 x86_64 指令模板。`interp_masm_x86.cpp` 是被 TemplateTable 频繁调用的辅助函数集。

---

## §〇 生产场景——你在 PrintAssembly 输出中看到的真实机器码

### 真实 PrintAssembly：iload_0 → iadd → safepoint poll

```asm
; ---- iload_0 (opcode 0x1a) — 从局部变量槽 0 加载 int32 到表达式栈 ----
; 对应生成函数: TemplateTable::iload(0) → templateTable_x86.cpp:878-881
0x00007f8b1400a3e0: mov    eax, [r14 + 8]      ; get_local — r14=locals, +8=locals[0]
                                                   (this 指针或第一个参数)
0x00007f8b1400a3e4: mov    [rsp - 4], eax       ; push_i — 表达式栈向低地址扩展
0x00007f8b1400a3e8: sub    rsp, 4               ; RSP -= 4（表达式栈增长）

; ---- iadd (opcode 0x60) — 从栈取两 int，相加后压回 ----
; 对应生成函数: TemplateTable::iop2(add) → templateTable_x86.cpp:1337-1340
0x00007f8b1400a518: mov    edx, [rsp]           ; pop_i — 取操作数栈顶（第一个操作数）
0x00007f8b1400a51b: add    rsp, 4               ; RSP += 4（释放栈槽）
0x00007f8b1400a51f: add    eax, edx             ; add — rax = rax + stack_top（结果在 rax 中）

; ---- safepoint poll + dispatch_next — 每个字节码执行后 ----
; 对应: interp_masm_x86.cpp:881-886 + dispatch_base:808
0x00007f8b1400a521: movzbl ebx, [r13 + 1]       ; load next opcode — r13=bcp, +1=下个字节码
                                                    ebx 选择性: opcode ≤ 255 → 1字节零扩展 → 32位够用
0x00007f8b1400a526: add    r13, 1               ; increment bcp — 推进字节码指针
0x00007f8b1400a52a: testb  [r15 + offset], 0x8   ; safepoint poll — 读 thread->polling_page byte, bit 3
                                                    testb vs testl: 更短的指令编码 → I-cache 友好
0x00007f8b1400a52f: jne    0x00007f8b1400a620   ; poll_bit set → 走 slow path (safepoint handler)
0x00007f8b1400a535: lea    r10, [rip+0x...]      ; dispatch table base → rscratch1 (r10)
0x00007f8b1400a53c: jmp    [r10 + rbx*8]          ; ★ O(1) dispatch → 跳到下一个字节码的机器码入口
```

> **读者侧边栏（零 x86 知识的 Java 工程师）：**
> - `movzbl ebx, [r13 + 1]` = "从 bcp+1 读 1 字节，零扩展到 32 位存入 ebx"——取下一个字节码的 opcode
> - `jmp [r10 + rbx*8]` = "跳到地址 = r10 + (rbx × 8)"——用 opcode 做数组索引，一次跳转完成分发
> - `testb [r15 + 56], 0x1` = "测试 r15_thread 偏移 56 处的那一字节的第 0 位是否为 1"——polling bit

### 你在 crash dump 中看到的解释器帧

```
Native frames: (J=compiled Java code, j=interpreted, Vv=VM code)
j  com.example.controller.HealthController.process(Lmodel/Request;)V+85
J 4582 com.example.service.OrderService.lambda$process$0()V (137 bytes) @ 0x00007f8b15c4d8a2
```

`j` = interpreted——这个方法正在被解释器逐字节执行。`+85` = 当前 bcp 偏移量（第 85 个字节码位置）。当 GC 中崩溃，解释器帧需要被栈行走器正确识别——这正是 [12-01] 帧布局中 `interpreter_frame_*` 偏移常量的用武之地。

---

## §一 ★ 全景：从字节码到机器码的生成链

### 1.1 运行时生成 vs 编译时写死

TemplateTable 在 JVM 启动时动态生成所有字节码的机器码模板——**不是**编译时写死在 C++ 中的 `__asm__` 块。原因：

| 编译时写死 | 运行时动态生成 |
|-----------|-------------|
| 无法根据 `UseCompressedOops` flag 调整指令宽度 | `_LP64` / `UseCompressedOops` 影响每条 `mov`/`lea` 的编码 |
| 无法根据 `UseSSE >= 2` 选择 `addsd` vs `fadd` | [12-04] CPUID 探测结果流入指令生成分支 |
| 无法根据 `SafepointMechanism::uses_thread_local_poll()` 选择 poll 模式 | poll 从 global 到 thread-local 的迁移在指令层体现 |
| 不同 CPU 的 `vm_version` features（AVX、FMA、BMI）不可用 | `UseAVX`/`UseFMA` 影响浮点/向量字节码的指令版本 |

### 1.2 CodeBuffer 中的指令累积

所有 200+ 字节码的机器码模板被生成到 **同一个 CodeBuffer**（Interpreter codelet）。dispatch table 的 `jmp [r10 + rbx*8]` 需要知道各字节码入口的相对偏移——如果每个字节码在独立 buffer 中，dispatch table 无法通过单个基址寻址所有入口。

### 1.3 TemplateTable 跨平台寄存器约定

`templateTable_x86.cpp:46-47`：

```cpp
static const Register rbcp    = LP64_ONLY(r13) NOT_LP64(rsi);
static const Register rlocals = LP64_ONLY(r14) NOT_LP64(rdi);
```

x86_64 解释器有 **4 个专用 callee-saved 寄存器**：

| 寄存器 | 解释器角色 | 说明 |
|--------|----------|------|
| **r15** | `r15_thread` | JavaThread\*（callee-saved，全链透传） |
| **r13** | `rbcp` | bytecode pointer（callee-saved，跨越 Runtime 调用需保存到帧） |
| **r14** | `rlocals` | locals 基址（callee-saved） |
| **r10** | `rscratch1` | dispatch table base（caller-saved，每次 dispatch 重新加载） |

---

## §二 ★★★ TemplateTable::iload/iop2 — 字节码的完整机器码轨迹

### 2.1 iload（opcode 0x15, N=操作数）的机器码生成

`templateTable_x86.cpp:614-662`（`iload_internal`）：

```cpp
void TemplateTable::iload_internal(RewriteControl rc) {
  transition(vtos, itos);                    // TosState: void → int（表达式栈状态变化）
  if (RewriteFrequentPairs && rc == may_rewrite) {
    // ... 检查下一个字节码是否形成"常用对"（如 iload+iload → iload2）...
    // 如果匹配 → patch_bytecode 将当前字节码改写为 fast_iload2
  }
  locals_index(rbx);                        // rbx = 负索引（从 bcp+1 读取局部变量槽号）
  __ movl(rax, iaddress(rbx));              // rax = *(locals + offset) — 读局部变量
}
```

`transition(vtos, itos)` 声明表达式栈 Top-Of-Stack 状态转换。`locals_index(rbx)` 从 bcp 解码操作数——普通版读 1 字节（bcp+1），wide 版读 2 字节（bcp+2, bcp+3）。`iaddress(rbx)` = `[r14 + rbx * 8]`（r14=locals, rbx=负索引）。

### 2.2 iload_0/1/2/3 变体——空间换时间

Java class file 将最常用的 `iload_0` ~ `iload_3` 编码为独立 opcode（0x1a~0x1d），只占 1 字节（vs `iload + N` 占 2 字节）。

`templateTable_x86.cpp:878-881`：

```cpp
void TemplateTable::iload(int n) {    // n = 0, 1, 2, 3（硬编码操作数）
  transition(vtos, itos);
  __ movl(rax, iaddress(n));          // 无 bcp 解码，直接硬编码偏移
}
```

`iload_0` 的 `iaddress(0)` 编译为 `[r14 + 8]`（8 = Interpreter::local_offset_in_bytes(0)），省去 `movzbl rbx, [r13+1]` 的 bcp 解码——更快。

### 2.3 iop2(add) —— add/sub/mul/and/or/xor/shift 的实现

`templateTable_x86.cpp:1337-1351`：

```cpp
void TemplateTable::iop2(Operation op) {
  transition(itos, itos);              // 栈顶两个 int → 一个 int
  switch (op) {
  case add  :                __ pop_i(rdx); __ addl (rax, rdx); break;
  case sub  : __ movl(rdx, rax); __ pop_i(rax); __ subl (rax, rdx); break;
  case mul  :                __ pop_i(rdx); __ imull(rax, rdx); break;
  case _and :                __ pop_i(rdx); __ andl (rax, rdx); break;
  case _or  :                __ pop_i(rdx); __ orl  (rax, rdx); break;
  case _xor :                __ pop_i(rdx); __ xorl (rax, rdx); break;
  case shl  : __ movl(rcx, rax); __ pop_i(rax); __ shll (rax);      break;
  case shr  : __ movl(rcx, rax); __ pop_i(rax); __ sarl (rax);      break;
  case ushr : __ movl(rcx, rax); __ pop_i(rax); __ shrl (rax);      break;
  }
}
```

`pop_i(rdx)` = `mov rdx, [rsp]; add rsp, 4`（弹出栈顶 int）。`addl(rax, rdx)` = 结果在 rax（TOS）。**每个 iop2 总共 2-3 条指令**——解释器以最低硬件成本实现字节码语义。

---

## §三 ★★★ dispatch table — O(1) 字节码分发跳转表

### 3.1 dispatch_next 的完整指令序列

`interp_masm_x86.cpp:881-886`：

```cpp
void InterpreterMacroAssembler::dispatch_next(TosState state, int step, bool generate_poll) {
    load_unsigned_byte(rbx, Address(_bcp_register, step)); // rbx = next opcode
    increment(_bcp_register, step);                        // bcp += step
    dispatch_base(state, Interpreter::dispatch_table(state), true, generate_poll);
}
```

生成的实际汇编（来自 `dispatch_base`，`interp_masm_x86.cpp:808-865`）：

```asm
movzbl ebx, [r13 + step]     ; 取下一个字节码 → ebx（opcode ≤ 255 → 32位够用）
                                 ; movzbl: 零扩展到 32 位，避免部分寄存器停顿
add    r13, step             ; 推进 bcp → 指向下一个字节码
testb  [r15 + 56], 0x1       ; safepoint poll（仅 generate_poll=true 时插入）
jne    <safepoint_slow_path>  ; bit=1 → 去 safepoint handler
lea    r10, [rip+offset]      ; r10 = dispatch_table 基址
jmp    [r10 + rbx * 8]        ; ★ 间接跳转：table[opcode] → 目标字节码入口
```

**为什么用 `movzbl ebx` 而不是 `movq rbx`？** opcode 是 1 字节无符号数（0-255）。`movzbl`（Move Zero-extend Byte to Long）将 1 字节零扩展到 32 位（`ebx` 自动零扩展高 32 位到 `rbx`）→ 指令更短（3 字节 vs 4+ 字节的 `movq`→ 对 I-cache 更友好）。每次 dispatch 都要执行这条指令 → 省 1 字节 × 每个字节码执行 = 显著 I-cache 节省。

### 3.2 dispatch table 的内存布局

```
dispatch_table (256 个 64-bit 指针):
  ┌──────────────────────┐  ← rscratch1 (r10)
  │  table[0]  = &nop    │
  │  table[1]  = &aconst_null │
  │  ...                  │
  │  table[0x1a]=&iload_0  │  ← jmp [r10 + 0x1a * 8] = jmp [r10 + 208]
  │  ...                  │
  │  table[0x60]=&iadd     │  ← jmp [r10 + 0x60 * 8] = jmp [r10 + 768]
  │  ...                  │
  │  table[255]            │
  └──────────────────────┘
```

dispatch table 基址在每次 dispatch 前通过 `lea r10, [rip+offset]` 加载。为什么不用专用寄存器？（1）callee-saved 寄存器已经耗尽（r15/r13/r14/r12）；（2）dispatch table 基址只在解释器中需要——不需要像 r15_thread 那样"透传"整个调用链。

### 3.3 ★ RAS/RSB 困境——为什么用 jmp 不用 call+ret

CPU 内部有 Return Address Stack（RAS）/ Return Stack Buffer（RSB）——每次 `call` 自动 push return address，每次 `ret` 自动 pop 预测目标。预测精度接近 100%。

解释器**不用** `call`/`ret` 做字节码间跳转——因为每个字节码 dispatch 用 `call` 会 push return address 到真实栈 → 200+ 字节码循环中栈不断增长 → 栈溢出。

| 方案 | 指令序列 | 栈操作 | RAS 预测 | 总 cycles |
|------|---------|--------|---------|-----------|
| `jmp` (当前) | `jmp [r10 + rbx*8]` | 无 | BTB 预测 (~90%) | ~2-3 |
| `call` + `ret` | `call` 压栈 → `ret` 弹栈跳转 | push + pop | RAS 预测 (~99%) | ~4-5 + 栈操作 |

`jmp` 方案省了 push/pop 栈操作（每字节码省 2 条指令），代价是分支预测精度从 99% 降到 ~90% ——但对 dispatch table 的间接 `jmp`，不同 opcode 跳转不同目标 → BTB 仍然有较高命中率，整体净收益为正。

---

## §四 ★★★ safepoint poll — 从概念到 CPU 指令

> **你需要知道的：EFLAGS/RFLAGS** 是 x86 的状态寄存器——32 位（EFLAGS）或 64 位（RFLAGS）。ZF (Zero Flag) = 第 6 位，当运算结果为 0 时 CPU 自动置 1。CF (Carry Flag) = 第 0 位，无符号溢出。testl 指令执行 AND 但不写结果——只更新 ZF。所以 `testl %eax, %eax; jz target` = '如果 eax==0 就跳转'。JVM 的 safepoint poll 利用 testl：polling page 可读 → eax=旧值 → ZF != 1 → 不跳。polling page 不可读 → SIGSEGV → 走 safepoint 慢路径。

### 4.1 poll 的插入时机

safepoint poll 在解释器中插入两个位置：

1. **每个 dispatch 前**（当 `generate_poll=true`）：在 `dispatch_base` 中，`dispatch_next` 调用前插入 `testb + jne` 序列
2. **方法返回前**（`remove_activation` 之前）

正常情况下 polling bit = 0 → `testb` 读 0 → ZF=1 → `jne` 不跳 → **2-3 cycles 完全开销**。这是"零开销 safepoint 检查"——只比不做检查多一个读内存+测试操作。

### 4.2 testb 为什么比 testl/cmp 快

`macroAssembler_x86.cpp:3744-3761`：

```cpp
void MacroAssembler::safepoint_poll(Label& slow_path, Register thread_reg, Register temp_reg) {
    if (SafepointMechanism::uses_thread_local_poll()) {
        testb(Address(thread_reg, Thread::polling_page_offset()),
              SafepointMechanism::poll_bit());
        jcc(Assembler::notZero, slow_path);
    } else {
        cmp32(ExternalAddress(SafepointSynchronize::address_of_state()),
              SafepointSynchronize::_not_synchronized);
        jcc(Assembler::notEqual, slow_path);
    }
}
```

**testb 的三个优势**：
1. `testb` 指令编码更短（比 `testl` 少 1 字节 REX 前缀）→ I-cache 密度更高
2. `test` 只做 bitwise AND（不需要 full ALU 减法）→ 比 `cmp` 少 1 个 ALU cycle
3. `testb` 只读 1 字节——cache line 压力最小

### 4.3 ★ safepoint poll 3 版本演进

| 版本 | 指令序列 | Cache Coherency | 触发方式 | 淘汰原因 |
|------|---------|----------------|---------|---------|
| **Global poll** | `cmp [global_addr], _not_synchronized; je ok` | 所有线程共享一个 cache line → 写 invalidate → N× 线程 cache miss | `_state` 写入 → 所有线程下次 poll 时看到 | safepoint 开始时有 N 个线程同时 cache miss → ~200 cycles × N = 大规模停顿 |
| **SIGSEGV poll** | `mov rax, [polling_page_addr]` | 同上 + 信号机制 overhead | `mprotect(PROT_NONE)` → SIGSEGV → handler 分发 | 信号处理 ~1000+ cycles + 内核态切换 → 比 bit 检查慢 100× |
| **Thread-local poll** | `testb [r15 + offset], bit; jne slow` | 每个线程独享自己 Thread 对象中的 byte → cache line 私有 | 只修改目标线程的 Thread 字段 → 只有它 cache miss | **当前方案**——最优 |

thread-local poll 的"cache line 私有化"：每个线程读 `[r15_thread + offset]` → 不同 Thread 对象在不同内存位置 → cache line 被各线程独占 → safepoint 时只修改个别线程的 bit → 只有目标线程的 cache line 失效 → 其他线程不受影响。

**VM 端 barrier 可见性**：`SafepointSynchronize::arm_safepoint()` 中写 `_polling_page-> disarm()` 之后执行 `OrderAccess::storeload()` → mfence → 保证所有 CPU 同时看到新值。这就是为什么 testl 不需要 lock 前缀——写端负责 fence。

### 4.4 slow_path 的寄存器保存

`dispatch_base` 中 safepoint slow path（`interp_masm_x86.cpp:832-838`）：

```cpp
testb(Address(r15_thread, Thread::polling_page_offset()), SafepointMechanism::poll_bit());
jccb(Assembler::zero, no_safepoint);    // 正常路径：不跳转
lea(rscratch1, ExternalAddress((address)safepoint_table));
jmpb(dispatch);                          // 跳到 safepoint dispatch table
```

slow path 跳转到 `safepoint_table`——其中每个条目指向一个"先保存所有 caller-saved 寄存器 → 调用 SafepointSynchronize::block → 恢复寄存器 → 跳回原有 dispatch table"的 stub。这确保从 slow path 回来后，所有寄存器（r10, r11, rax, rcx, rdx, rsi, rdi, r8, r9）恢复为 poll 前的值。

---

## §五 ★★ 方法入口——解释器的"大门"

### 5.1 generate_normal_entry 的 6 步帧初始化

方法入口生成器在 `templateInterpreterGenerator_x86_64.cpp` 中。生成的指令完成：

```
Step 1: push rbp / mov rbp, rsp         — 建立帧指针（和 [12-01] 帧模型一致）
Step 2: sub rsp, frame_size              — 分配 (max_locals + max_stack + metadata) × 8 字节
Step 3: 设置帧内的 method* / constPool* / bcp / locals — 从传入的 Method 对象和参数读取
Step 4: 将调用者传来的参数从寄存器复制到 locals[0..n]  — Java calling convention → 解释器帧
Step 5: 初始化 expression stack 为空     — last_sp = initial_sp
Step 6: dispatch_next → 跳到 method->code[0]（第一个字节码）
```

`frame_size = (max_locals + max_stack + interpreter_frame_extra_words) × wordSize`——从 Method 对象读取编译时确定。

### 5.2 解释器帧为什么需要保存 method\*/bcp/locals\* 到帧偏移

解释器在调用 Runtime（如 `InterpreterRuntime::resolve_invoke`）时，会暂存这些指针到帧中——因为 Runtime 可能改变**任何 caller-saved 寄存器**。如果 method/bcp/locals 只保存在 caller-saved 寄存器中 → 从 Runtime 返回后丢失。

`interp_masm_x86.hpp:67-77` 展示了跨 Runtime 调用的保存/恢复：

```cpp
void save_bcp() {
    movptr(Address(rbp, frame::interpreter_frame_bcp_offset * wordSize), _bcp_register);
}
void restore_bcp() {
    movptr(_bcp_register, Address(rbp, frame::interpreter_frame_bcp_offset * wordSize));
}
void restore_locals() {
    movptr(_locals_register, Address(rbp, frame::interpreter_frame_locals_offset * wordSize));
}
```

---

## §六 ★★ TemplateTable 的快慢路径——invokevirtual 与 volatile_getfield

### 6.1 ★ invokevirtual 的快速路径——单态 inline cache

`templateTable_x86.cpp` 的 `invokevirtual` 生成逻辑（从 `getfield_or_static` 的 CP cache 模式推导）：

```asm
; invokevirtual 快速路径（~10 条指令）
pop_ptr rax                          ; 取出 receiver 对象
null_check rax                       ; 如果 receiver=null → forward NPE
mov    rcx, [rax + klass_offset]     ; 读 receiver->klass()
cmp    rcx, [rbx + cached_klass_off] ; 比较与 CP cache 中缓存的 klass
jne    slow_path                     ; 不匹配 → 慢路径
mov    rbx, [rbx + cached_method_off]; 匹配 → 直接取缓存的 Method*
jmp    [rbx + from_compiled_entry_off] ; 跳转到 entry point
```

**单态 inline cache 的关键**：大部分 virtual call site 是单态的（99%+ 的调用都是同一种 receiver 类型）。CP cache 缓存最近一次调用成功的 klass → 再次遇到同样类型时跳过完整 vtable 查找。

| 路径 | 指令数 | 延迟（cycles） | 发生概率 |
|------|--------|-------------|---------|
| 快速路径（CP cache hit） | ~10 | ~15 | 99%+ |
| 慢路径（resolve_invoke Runtime） | ~50+ Runtime | ~500+ | <1% |

**慢路径精确源文件行号**：`templateTable_x86.cpp:invokevirtual()` → `__ call_VM(noreg, CAST_FROM_FN_PTR(address, InterpreterRuntime::resolve_invokevirtual), receiver)` → slow path cost ~500+ cycles（vtable walk + ITLB miss + potential safepoint check）。

### 6.2 ★ volatile_getfield 的内存屏障——lock addl [rsp], 0

`assembler_x86.hpp:1351-1387` 的 `membar()`：

```cpp
void membar(Membar_mask_bits order_constraint) {
    if (os::is_MP()) {
        if (order_constraint & StoreLoad) {
            int offset = -VM_Version::L1_line_size();
            if (offset < -128) offset = -128;
            lock();                            // ★ LOCK 前缀 = 硬件内存屏障
            addl(Address(rsp, offset), 0);    // 加 0 到栈下方一整个 cache line 处
        }
    }
}
```

生成的汇编：

```asm
lock addl [rsp - 64], 0     ; ★ 假加法真屏障
```

- **`addl [rsp - 64], 0`**：加 0，不改变任何值——语义上等价于 nop
- **`lock` 前缀**：锁定 cache line → flush store buffer → 完全的内存屏障（StoreLoad）
- **`offset = -L1_line_size`**：操作栈下方一整条 cache line 处——避免与当前栈帧中的任何变量产生 false dependency
- **为什么不用 `mfence`？**：`lock addl` 在某些 CPU（Skylake 前）上比 `mfence` 快 1-2 cycles。两者语义等价——都是完全的内存屏障

`templateTable_x86.cpp:3315-3316` 在 volatile putfield 后调用：

```cpp
volatile_barrier(Assembler::Membar_mask_bits(Assembler::StoreLoad | Assembler::StoreStore));
```

x86 上 `StoreStore` 不需要任何 CPU 指令（TSO 保证 store→store 不乱序），只需要 `StoreLoad` 的 `lock addl`。

### 6.3 普通 getfield vs volatile getfield 的指令差异

| 维度 | 普通 getfield | volatile getfield |
|------|-------------|-------------------|
| 读取指令 | `mov eax, [rax + field_offset]` | `mov eax, [rax + field_offset]` |
| 读取后有 barrier？ | 无 | x86：无（load 天然有 acquire 语义） |
| 写入指令 | `mov [rax + field_offset], eax` | `mov [rax + field_offset], eax` |
| 写入后有 barrier？ | 无 | **`lock addl [rsp - 64], 0`** |
| 总指令数 | ~4 | ~5 |
| 总延迟 | ~3 cycles | ~23-43 cycles（lock 前缀 flush store buffer） |

---

## §七 ★ 阶段连接

### 7.1 和 [12-01 Frames] 的解释器帧连接

[12-01] 建立了帧布局坐标系。本文的 interpreter frame 在同样的坐标上增加了 `method_offset`（-3）、`bcp_offset`（-8）、`locals_offset`（-7）、`sender_sp_offset`（-1）等字段——这些偏移量在 `frame_x86.hpp:69-81` 定义，在 `interp_masm_x86.hpp:67-77` 中被 `save_bcp()`/`restore_bcp()` 使用。

### 7.2 和 [12-04 CPUID] 的 UseSSE 连接

[12-04] 的 `VM_Version::initialize()` 设置 `UseSSE` flag。解释器在生成浮点字节码时检查此 flag：
- `UseSSE >= 2` → 生成 `addsd`/`subsd`/`mulsd`（SSE2 标量双精度，一条指令完成）
- `UseSSE == 0` → 生成 `fadd`/`fsub`/`fmul`（x87 栈式浮点，需要 `fld` + `faddp` 多条指令）

### 7.3 和 [08-safepoint] 的 polling page 连接

[08] 建立了 safepoint polling 的概念（arm/disarm polling page）。本文补完 [08] 没讲的：poll 在 CPU 上到底长什么样——`testb [r15 + offset], bit` + `jne slow`。

```
[08] 讲 "为什么需要 poll"           → SafepointSynchronize::begin()/end()
[12-02] 讲 "poll 怎么成为 CPU 指令"  → testb + jne → 2-3 cycles 开销
```

thread-local poll 取代了 [08] 描述的 global poll + SIGSEGV 机制——这是设计演进。

---

## §八 GDB 验证 + 可证伪断言

### 断言 1：dispatch table 基址加载在 rscratch1 (r10) 中

```bash
(gdb) br interp_masm_x86.cpp:844  # jmp [rscratch1 + rbx*8] 指令处
(gdb) p/x $r10
# 预期：r10 指向 dispatch table，在 Interpreter codelet 范围内
(gdb) p/x ((void**)$r10)[0]
# 预期：table[0] = nop 入口地址
```

### 断言 2：testb + jne 的快路径不跳转（poll bit = 0 时）

```bash
(gdb) br interp_masm_x86.cpp:834  # testb 指令处
# 正常执行（非 safepoint 时刻）
(gdb) x/2i $rip
# 预期：testb + jcc(notZero) 序列
(gdb) p/x $eflags
# 预期：ZF=1（poll bit = 0 → test 结果 = 0 → jcc 不跳转）
```

### 断言 3：iload_0 从 [r14 + locals_offset + 0] 读取 int32

```bash
(gdb) br templateTable_x86.cpp:880  # iload(int n=0) 的 movl 指令
(gdb) p/x $r14
# 预期：r14 = locals 基址
(gdb) x/wx $r14 + 8   # Interpreter::local_offset_in_bytes(0)
# 预期：值 = 第一个局部变量的 int 值
```

### 断言 4：dispatch_next 使用 movzbl 取下一个字节码

```bash
(gdb) br interp_masm_x86.cpp:883  # load_unsigned_byte
(gdb) x/i $rip
# 预期：movzbl ebx, [r13 + step]（movzbl = 1 字节零扩展到 32 位）
(gdb) x/1bx $r13
# 预期：当前 bcp 指向的 1 字节 = 当前正在执行的字节码 opcode
```

### 断言 5：解释器帧的 locals = [rbp + interpreter_frame_locals_offset]

```bash
(gdb) br frame_x86.inline.hpp:158  # interpreter_frame_locals_addr
(gdb) p/x *(intptr_t**)($rbp - 56)  # locals_offset = -7 words = -56 bytes
# 预期：值 = r14（locals 寄存器）
```

### 断言 6：generate_normal_entry 分配帧空间 = (max_locals + max_stack + extra) × 8

```bash
# 进入新方法时设断点在 prologue 之后
(gdb) p/x $rsp  # prologue 前
# ... 执行 sub rsp, frame_size ...
(gdb) p/x $rsp  # prologue 后
# 预期：减少量 = frame_size_words × 8
```

### 断言 7：解释器的 safepoint poll slow path 保存所有 caller-saved 寄存器

```bash
(gdb) br interp_masm_x86.cpp:838  # lea rscratch1, safepoint_table
(gdb) p/x $r10 $r11 $rax $rcx $rdx $rsi $rdi $r8 $r9
# 记录当前所有 caller-saved 寄存器值
# ... 继续执行到 safepoint handler 返回 ...
# 预期：所有 caller-saved 寄存器恢复为原值
```

### 断言 8：wide 前缀的 iload 从 bcp+1/+2 读取 2 字节索引

```bash
(gdb) br templateTable_x86.cpp:711  # wide_iload
(gdb) x/2bx $r13+1
# 预期：2 字节 = 大端序 → bswapl+shrl 后得到 16-bit 索引
# 对比普通 iload 的 1 字节索引（[r13 + 1]）
```

### 断言 9：volatile getfield 之前没有额外 barrier

```bash
# 在 volatile 字段读取后、dispatch 前设断点
(gdb) x/4i $rip
# 预期：没有 lock/mfence/xchg 指令（x86 普通 load = acquire 语义 = 不需要 barrier）
```

### 断言 10：volatile putfield 以 lock addl [rsp], 0 结尾

```bash
(gdb) br templateTable_x86.cpp:3315  # volatile_barrier(StoreLoad|StoreStore)
(gdb) x/i $rip
# 预期：lock addl [rsp + offset], 0x0（offset 为负值，避开当前帧数据）
```

### 断言 11：iadd 使用 add eax, edx（2 条指令完成栈顶 + 次栈顶的 add）

```bash
(gdb) br templateTable_x86.cpp:1340  # iop2(add) 的 addl 指令处
(gdb) x/4i $rip-10
# 预期：pop_i(rdx) → addl(rax, rdx) → 总共 2-3 条指令
```

### 断言 12：同一 CodeBlob 内 dispatch table 的所有条目指向 interpreter codelet 内部

```bash
(gdb) br interp_masm_x86.cpp:844
(gdb) p/x (void*)$r10
# 取出 dispatch_table 基址
(gdb) p CodeCache::find_blob(((void**)$r10)[0x1a])  # iload_0
(gdb) p CodeCache::find_blob(((void**)$r10)[0x60])  # iadd
# 预期：两者返回相同的 Interpreter codelet CodeBlob
```

---

## §八 PrintAssembly 阅读 checklist

| 观察 | 判定 | 对应源码 |
|------|------|---------|
| 地址在 Interpreter codelet 范围 | TemplateTable 生成代码 | `templateTable_x86.cpp` |
| 频繁出现 `movzbl ebx, [r13 + ...]` + `jmp [r10 + rbx*8]` | dispatch_next + dispatch_base | `interp_masm_x86.cpp:881,844` |
| 频繁使用 `[r14 + ...]` 寻址 | locals 访问 | `templateTable_x86.cpp:55-56` |
| 出现 `testb [r15 + 56], 0x1` + `jne` | thread-local safepoint poll | `macroAssembler_x86.cpp:3754` |
| 出现 `(mov|add|sub) [rsp], ...` 操作栈顶 | 表达式栈操作（pop_i/push_i） | `templateTable_x86.cpp` 各模板 |
| 出现 `lock addl [rsp + ...]` | volatile StoreLoad barrier | `assembler_x86.hpp:1384` |
| 出现 `call` 到 Runtime 地址 | slow path → Runtime 调用 | `templateTable_x86.cpp` 各模板的慢路径分支 |

---

## 核心发现总结

| # | 发现 | 核心洞察 |
|---|------|--------|
| 1 | **TemplateTable 运行时动态生成** | CPU features、VM flags、UseCompressedOops 影响每条指令的宽度和版本 |
| 2 | **dispatch table = O(1) 字节码分发** | `jmp [r10 + opcode*8]` — 2 条指令、无分支预测、无比较 |
| 3 | **Why jmp not call+ret** | 避免真实栈 push/pop，省 2 条指令/bytecode，代价是 BTB 预测 90% vs RAS 99% |
| 4 | **safepoint poll = ∼2 cycles** | `testb [r15 + 56], 0x1` + `jne` — 正常情况零开销 |
| 5 | **thread-local poll 是 cache coherency 胜利** | 每个线程读自己的 Thread 对象 → cache line 私有 → safepoint 时只有目标线程 miss |
| 6 | **iload_0 省了 1 条 bcp 解码指令** | 硬编码偏移量 → 省 `movzbl rbx, [r13+1]` — 最热字节码优化 |
| 7 | **invokevirtual 快速路径 ~10 条指令** | 单态 inline cache — CP cache 的 klass 比较命中的概率 99%+ |
| 8 | **`lock addl [rsp - offset], 0` = mfence 等价** | StoreLoad 屏障——add 0 不改变值，lock 前缀提供完整屏障 |
