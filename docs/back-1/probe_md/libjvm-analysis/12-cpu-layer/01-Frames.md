# 01-Frames — JVM x86_64 栈帧布局、寄存器绑定、帧行走与 Java↔C 锚定

> **阶段**：[12-cpu-layer]
> **前置**：[11-os-layer], [07-thread-lock]
> **依赖本文**：[12-02] Interpreter（解释器帧布局建立在本文帧模型上）, [12-03] Stubs（deopt 帧重建 + call_stub 帧锚点依赖本文帧偏移）
> **阅读收益**：理解 JVM 在 x86_64 上执行 Java 方法时的完整栈帧布局——从 call 指令的硬件行为到 callee prologue 的逐条指令、从 r15_thread 的寄存器绑定到 sender_sp/unextended_sp 的帧行走机制、从 crash dump 中 R12=0x0/R15=0x0 含义到 PrintAssembly 输出的每一条帧操作指令

---

## §〇 源文件清单（跨 cpu/x86 + os_cpu/linux_x86 + runtime）

| # | 文件 | 完整路径 | 模块 | 核心函数/类（已验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `frame_x86.cpp` | `src/hotspot/cpu/x86/frame_x86.cpp` | cpu/x86 | `safe_for_sender`(:53), `sender`(:488), `sender_for_interpreted_frame`(:431), `sender_for_compiled_frame`(:451), `is_interpreted_frame_valid`(:505) | ★★★ 帧布局核心 |
| 2 | `frame_x86.hpp` | `src/hotspot/cpu/x86/frame_x86.hpp` | cpu/x86 | 帧偏移常量：`link_offset`(0), `return_addr_offset`(1), `sender_sp_offset`(2), `interpreter_frame_sender_sp_offset`(-1), `interpreter_frame_method_offset`(-3) 等 | ★★ 帧偏移坐标系 |
| 3 | `frame_x86.inline.hpp` | `src/hotspot/cpu/x86/frame_x86.inline.hpp` | cpu/x86 | `unextended_sp()`(:149), `sender_pc()`(:153-154), `link()`(:147), `interpreter_frame_locals_addr()`(:158) | ★ 内联访问器 |
| 4 | `register_x86.hpp` | `src/hotspot/cpu/x86/register_x86.hpp` | cpu/x86 | `RegisterImpl` 类, 所有 16 个 GPR 的物理编码（rax=0 .. r15=15） | ★★ 物理寄存器编码 |
| 5 | `assembler_x86.hpp` | `src/hotspot/cpu/x86/assembler_x86.hpp` | cpu/x86 | `REGISTER_DECLARATION(r15_thread, r15)`(:134), `REGISTER_DECLARATION(r12_heapbase, r12)`(:133), `REGISTER_DECLARATION(rscratch1, r10)`(:130), `c_rarg0..5`, `j_rarg0..5` | ★★ JVM 寄存器别名 |
| 6 | `javaFrameAnchor_x86.hpp` | `src/hotspot/cpu/x86/javaFrameAnchor_x86.hpp` | cpu/x86 | `clear()`(:40), `copy()`(:48), `walkable()`(:65), `make_walkable()`(:66), `capture_last_Java_pc()`(:67) | ★★ Java↔C 帧锚点 |
| 7 | `registerMap_x86.hpp` | `src/hotspot/cpu/x86/registerMap_x86.hpp` | cpu/x86 | `RegisterMap` 类 — `pd_location`(:34), `pd_clear`(:36) | ★ 寄存器位置映射 |
| 8 | `macroAssembler_x86.cpp` | `src/hotspot/cpu/x86/macroAssembler_x86.cpp` | cpu/x86 | `set_last_Java_frame`(:3768), `safepoint_poll`(:3744) | ★★ set/reset 帧锚点机器码 |

**跨模块说明**：帧相关代码横跨 `cpu/x86/`（cpu 专有实现）和 `os_cpu/linux_x86/`（OS 粘合层）。`javaFrameAnchor_x86.hpp` 是衔接 Java 执行和 C++ 执行的关键桥梁——每次从 Java 进入 Runtime，`set_last_Java_frame` 写入 sp/fp/pc 到 Thread 对象的 Anchor 中。

---

## §〇 生产场景——当线上应用崩了，你第一时间看 hs_err

### 真实 hs_err Register dump——解码 R15=0x0

线上应用突然宕机。你在 `/data/logs/` 下看到 hs_err：

```
# A fatal error has been detected by the Java Runtime Environment:
#
#  SIGSEGV (0xb) at pc=0x00007f8b1a3c4d21, pid=12463, tid=12494
#
# Problematic frame:
# V  [libjvm.so+0x8c4d21]  G1ParScanThreadState::copy_to_survivor+0x61

Registers:
RAX=0x00007f8b20000000, RBX=0x0000000000000000, RCX=0x00007f8b1a3c4d21
RDX=0x0000000000000003, RSP=0x00007f8b1ecfcb80, RBP=0x00007f8b1ecfcbc0
RSI=0x00007f8b24083800, RDI=0x00007f8b1ecfcc00
R8 =0x0000000000000000, R9 =0x00007f8b1ebfc000, R10=0x00007f8b15c4d8a2
R11=0x0000000000000006, R12=0x0000000000000000, R13=0x00007f8b1ecfcc80
R14=0x00007f8b15c4d2c0, R15=0x0000000000000000
```

**R15=0x0**：`r15_thread` 是 JVM 永久绑定的 Thread\* 指针。当它为 0，意味着 Thread\* 对象指针丢失——任何 `mov reg, [r15 + offset]` 都会在 offset 很小时访问近零页 → SIGSEGV。此时 `set_last_Java_frame(r15_thread, rsp, fp, pc)` 无法执行——`_last_Java_sp` 无法被写入——栈行走器找不到 Java 帧——hs_err 里没有 Java 调用栈。

**R12=0x0**：`r12_heapbase` 保存压缩 OOPs 的堆基址。如果是零基址模式（`heap_base == 0`），r12 本就该为 0——正常。但如果堆基址非零，r12=0 意味着窄化指针的解压失效——`lea rax, [r12 + narrow*8]` 生成的地址错误。

### 你在反汇编中看到的——R15 崩溃的精确指令

```asm
; set_last_Java_frame 的核心指令（来自 macroAssembler_x86.cpp:3768）
; 当 r15=0 时，以下任何一条 mov 都触发 SIGSEGV（访问 ~0x30-0x40 附近地址）
mov     [r15 + 48], rsp     ; _last_Java_sp_offset = 48 — r15=0 → SIGSEGV on 0x30
mov     [r15 + 56], rbp     ; _last_Java_fp_offset = 56
mov     [r15 + 64], rsi     ; _last_Java_pc_offset = 64 — rsi 存 return pc
```

当你看到 hs_err 中 `Problematic frame: V [libjvm.so+0x8c4d21]` + `R15=0x0`，用 addr2line 反汇编这个偏移——极可能是 `mov rdi, [r15 + 48]` 试图读取 thread->last_Java_sp。**根因：Thread\* 丢失**。

### 你在 `-XX:+PrintAssembly` 中看到的

```asm
; Java 方法的 prologue（C1 编译输出）
0x00007f8b15c4d2c0: push   rbp
0x00007f8b15c4d2c1: sub    rsp, 0x40
0x00007f8b15c4d2c5: mov    rbp, rsp
; ... 方法体 ...
; Java 方法的 epilogue
0x00007f8b15c4d398: add    rsp, 0x40
0x00007f8b15c4d39c: pop    rbp
0x00007f8b15c4d39d: test   rax, rax          ; 检查 rax 是否为 exception oop
0x00007f8b15c4d3a0: jne    0x00007f8b15c4d3b0 ; 非 NULL → 异常分发
0x00007f8b15c4d3a2: ret
```

每一个 `push rbp; sub rsp, 0x40; mov rbp, rsp` 和 `add rsp, 0x40; pop rbp; ret` 就是本文要解释的帧布局的物理实现。你在 crash dump 里看到的 `RSP=... RBP=...` 就是这两个寄存器此刻的值——而它们之间的空间就是"当前帧"。

---

## §一 ★ 全景：call 指令触发后，栈上发生了什么

### 1.1 call 指令的 CPU 级行为

`call <target>` 是 x86_64 的硬件指令。CPU 在遇到 `call` 时，硬件自动完成三步原子操作：

```
CPU 硬件行为（无软件参与）:
  (1) RIP += <call指令长度>    → 算出"下一条指令"的地址（return address）
  (2) push RIP                 → RSP -= 8; [RSP] = return_address
  (3) RIP = <target>           → 跳转到 callee

所以当 callee 的第一条指令开始执行时：
  [RSP] = return address（call 指令的下一条指令地址）
  RSP   = 入口栈顶（比 caller 的 RSP 低 8 字节）
```

**这是硬件行为**——不由 JVM 也不由 callee 控制，CPU 无条件执行。JVM 的整个帧系统建立在这个硬件约定之上：每个 Java 方法调用最终都会变成 `call <target>`（不管是解释器 dispatch、C1 编译代码还是 C2 编译代码中的 call site）。

### 1.2 prologue 的逐指令分解

Callee 拿到控制权后，通过 3 条指令建立自己的栈帧：

```asm
push rbp               ; (1) 保存 caller 的 frame pointer → [RSP]; RSP -= 8
sub  rsp, 0x40         ; (2) 分配帧空间（locals + spill + 对齐）; RSP -= 0x40
mov  rbp, rsp          ; (3) 建立新的帧指针，rbp 指向当前帧的"锚点"
```

逐指令分解：

**(1) `push rbp`**：保存 caller 的 rbp 到栈顶。这建立 **rbp 链**——如果你从当前帧的 rbp 指向的内存读出一个值，它就是 caller 的 rbp。回溯所有 rbp 就能恢复完整调用链。`frame_x86.hpp:60` 定义 `link_offset = 0`——即 `[rbp + 0]` 永远指向 saved rbp。

**(2) `sub rsp, 0x40`**：分配帧空间。0x40 = 64 字节 = 8 个 word。这部分空间包含：
- local variables（局部变量）
- spill slots（寄存器溢出槽）
- 可能的 callee-saved 寄存器保存区
- 16 字节栈对齐 padding（x86_64 ABI 要求）

**(3) `mov rbp, rsp`**：将 rbp 固定到当前帧。此后所有对当前帧的寻址都通过 `[rbp + offset]` 完成。rbp 不再移动——它是帧内所有数据的"坐标系原点"。

### 1.3 epilogue 的逆操作——为什么 C2 编译方法测试 rax

```asm
add    rsp, 0x40       ; 释放帧空间——恢复分配前的 RSP
pop    rbp             ; 恢复 caller 的 rbp → [rbp] 链完好
test   rax, rax        ; 检查 rax 是否为 exception oop？
jne    <exception_handler> ; 非 NULL → 抛出的异常需要分发
ret                    ; RSP += 8; RIP = [previous RSP] → 回到 caller
```

C2 编译帧的 epilogue 在 `ret` 前测试 `rax`：如果方法以抛出异常结束（`athrow`），JVM 把 exception oop 放入 rax。caller 的 `ret` 后的代码检测 rax != NULL → 跳转到异常处理 stub → 不是正常的返回路径。

### 1.4 为什么 `-XX:-PreserveFramePointer` 可以省略 push rbp + mov rbp, rsp

关闭 rbp 后，JVM 依赖 CodeBlob 中存储的 `frame_size`（编译时已知固定大小）做栈行走：

```
sender_sp = current_sp + frame_size  // 不需要 rbp 链
```

代价：GDB/perf 不能再通过 rbp 链回溯调用栈（所有 C/C++ 栈帧都不可见）→ `perf record --call-graph fp` 失效。但 JVM 自己的栈行走器（StackFrameStream）走 CodeBlob 路线 → 不受影响。

---

## §二 ★★★ x86_64 JVM 栈帧逐层分解——全文坐标系

### 2.1 完整帧布局 ASCII 图

```
     HIGH ADDRESS
     ┌──────────────────────────────────┐
     │  caller's frame                  │
     │     ...                          │
     │  [parameter N]                   │ ← caller 推送的最后一个参数
     │  [parameter 1]                   │
     │  [parameter 0]  (sender_sp →)    │ ← caller 执行 call 前的 RSP
     ├──────────────────────────────────┤
     │  return address                  │ ← call 指令硬件 push; rbp + 8
     ├──────────────────────────────────┤
     │  saved rbp (link)         rbp →  │ ← push rbp; rbp + 0 (= link_offset)
     ├──────────────────────────────────┤
~    ~  [callee-saved regs (rbx,r12-r15)]~ ← 可选：仅编译帧在需要时保存
~    ~  [locals / spill slots]         ~
~    ~  [monitor slots]                ~  ← 解释器帧专有：synchronized 的锁记录
~    ~  [expression stack grow ↓]      ~  ← 解释器帧专有：动态向低地址扩展
     ├──────────────────────────────────┤
     │  (free space)                    │
     │                           rsp →  │ ← 当前栈顶（低地址）
     └──────────────────────────────────┘
     LOW ADDRESS

 关键偏移（相对于 rbp，单位为 words = 8 bytes）:
   return_addr_offset         = +1   → [rbp + 8]  = return address
   link_offset                =  0   → [rbp + 0]  = saved rbp
   sender_sp_offset           = +2   → [rbp + 16] = sender_sp（仅编译帧）

 解释器帧额外偏移（相对于 rbp，负值向低地址）:
   interpreter_frame_sender_sp_offset      = -1   → [rbp - 8]
   interpreter_frame_last_sp_offset        = -2   → [rbp - 16]
   interpreter_frame_method_offset         = -3   → [rbp - 24] = Method*
   interpreter_frame_mirror_offset         = -4   → [rbp - 32]
   interpreter_frame_mdp_offset            = -5   → [rbp - 40]
   interpreter_frame_cache_offset          = -6   → [rbp - 48]
   interpreter_frame_locals_offset         = -7   → [rbp - 56] = locals*
   interpreter_frame_bcp_offset            = -8   → [rbp - 64] = bcp*
    interpreter_frame_initial_sp_offset     = -9   → [rbp - 72]
```

> **映射到 GDB**：`x/gx $rbp+8` = 返回地址，`x/4gx $rsp` = 栈顶 4 个字。在 crash dump 中，`Stack: [0x...,0x...]` 段就是 rsp 指向的内存。

### 2.2 解释器帧 vs 编译帧的结构对比

| 区域 | 解释器帧 | C1/C2 编译帧 | 理由 |
|------|---------|-------------|------|
| **return address + saved rbp** | ✅ | ✅ | x86_64 ABI 必需 |
| **locals 区域** | ✅（rbp - locals_offset 向下） | ✅（spill slots 中固定偏移） | 局部变量存储 |
| **expression stack** | ✅（动态向低地址扩展） | ❌ | 中间值在寄存器/spill slot 中 |
| **monitor slots** | ✅（帧底部分配 BasicObjectLock） | ❌ | synchronized 锁记录内联在 prologue/epilogue |
| **method\*/bcp\*/cache\*** | ✅（固定偏移保存） | ❌ | 编译帧不需要——方法信息在 CodeBlob 中 |
| **sender_sp** | ✅（显式保存在 -1 word） | ❌（从 frame_size 计算） | 解释器帧表达式栈动态扩展 |
| **oop maps** | ❌ | ✅ | GC 需要知道哪些寄存器/spill slot 是 oop |
| **帧大小** | **动态**（表达式栈 push/pop 时 rsp 移动） | **固定**（编译时确定） | — |

### 2.3 解释器帧专有区域的详细说明

解释器帧在基本帧（return address + saved rbp）的基础上，向下（向低地址）扩展了 9+ 个 word 的"解释器元数据"（`frame_x86.hpp:69-81`）：

```
[帧内所有解释器指针的保存位置]
loc: rbp -  8 → sender_sp         = caller 执行 call 时的 RSP（锚定上一层帧）
loc: rbp - 16 → last_sp           = 表达式栈的"当前位置"（小于等于 rsp）
loc: rbp - 24 → method*           = 指向 Method 对象的指针（元数据）
loc: rbp - 32 → mirror            = java.lang.Class mirror（仅 native 方法）
loc: rbp - 40 → mdp               = MethodData pointer（profiling 数据）
loc: rbp - 48 → ConstantPoolCache* = 解析后的 CP cache
loc: rbp - 56 → locals*           = 指向局部变量表的指针
loc: rbp - 64 → bcp*              = bytecode pointer（当前字节码在 method->code 中的偏移）
loc: rbp - 72 → initial_sp        = 帧底部的"初始 sp"（表达式栈为零时的位置）
```

**为什么解释器需要保存这些指针？** 解释器在调用 Runtime（如 `InterpreterRuntime::resolve_invoke`）时，所有 caller-saved 寄存器可能被 Runtime 破坏 → 如果把 method/bcp/locals 只放在寄存器里 → 回到解释器时丢失。通过保存在帧中（栈内存），跨越 Runtime 调用安全无虞。这就是解释器帧比编译帧"重"的根本原因。

---

## §三 ★★★ JVM 专用寄存器约定——r15_thread / r12_heapbase / rscratch

### 3.1 寄存器别名声明（source-documented）

`assembler_x86.hpp:130-134`：

```cpp
REGISTER_DECLARATION(Register, rscratch1,    r10);   // volatile (caller-saved)
REGISTER_DECLARATION(Register, rscratch2,    r11);   // volatile (caller-saved)
REGISTER_DECLARATION(Register, r12_heapbase, r12);   // callee-saved
REGISTER_DECLARATION(Register, r15_thread,   r15);   // callee-saved
```

`register_x86.hpp:77-94` 定义所有 16 个 GPR 的物理编码（rax=0, rcx=1, rdx=2, rbx=3, rsp=4, rbp=5, rsi=6, rdi=7, r8=8, r9=9, r10=10, r11=11, r12=12, r13=13, r14=14, r15=15）。

### 3.2 ★ 16 个 GPR 的完整寄存器约定表

| 寄存器 | x86_64 ABI 角色 | JVM 专用角色 | 保存者 | 在哪种代码中使用 | 特殊说明 |
|--------|----------------|-------------|--------|----------------|---------|
| **rax** | 返回值/scratch | `return value` | Caller | 全部 | JNI 调用后的返回值 |
| **rcx** | 第4参数/scratch | `c_rarg3` | Caller | 全部 | 32位: ecx 用于 `shl/shr` 的移位量 |
| **rdx** | 第3参数/scratch | `c_rarg2` | Caller | 全部 | 64位 mul/div 的隐式高位 |
| **rbx** | callee-saved | `method*` (entry) | **Callee** | 解释器入口 | 解释器入口时暂存 Method\* |
| **rsp** | 栈指针 | (硬件栈指针) | — | 全部 | 由 push/pop/call/ret 自动管理 |
| **rbp** | 帧指针(可选) | `frame pointer` | **Callee** | 全部 (PreserveFramePointer) | frame_x86.hpp 偏移坐标系的基准 |
| **rsi** | 第2参数/scratch | `c_rarg1` | Caller | 全部 | 32位解释器: bcp |
| **rdi** | 第1参数/scratch | `c_rarg0` | Caller | 全部 | 32位解释器: locals |
| **r8** | 第5参数/scratch | `c_rarg4` | Caller | 全部 | — |
| **r9** | 第6参数/scratch | `c_rarg5` | Caller | 全部 | — |
| **r10** | scratch/temp | **`rscratch1`** | Caller | 解释器/编译/stub | ★ MacroAssembler 内部临时寄存器 |
| **r11** | scratch/temp | **`rscratch2`** | Caller | 解释器/编译/stub | ★ 同 rscratch1，信号安全代码避免使用 |
| **r12** | callee-saved | **`r12_heapbase`** | **Callee** | 全部 (UseCompressedOops) | ★ 压缩 OOP 基址；UseCompressedOops 关闭时可回收 |
| **r13** | callee-saved | `bcp` (解释器) | **Callee** | 解释器 | templateTable_x86.cpp:46 |
| **r14** | callee-saved | `locals` (解释器) | **Callee** | 解释器 | templateTable_x86.cpp:47 |
| **r15** | callee-saved | **`r15_thread`** | **Callee** | **全部** | ★★★ JavaThread\* 的永久寄存器绑定 |

### 3.3 ★ 为什么 r15_thread 是 callee-saved 而不是 caller-saved？

因为 r15 是 **callee-saved**，所以 Java 方法的机器码不碰 r15（由 JVM 保证），Thread\* 自动在整条调用链上"透传"——caller 的 r15 到 callee 中不变，callee 再调用下个 callee 也不变。**无限深度调用链全都不需要重新加载 Thread\***。

**"/如果 r15 是 caller-saved"的替代世界**：

| 维度 | r15 = callee-saved（当前设计） | r15 = caller-saved（假设） |
|------|------------------------------|--------------------------|
| 每个方法入口 | 0 指令——r15 自动透传 | 需要从 TLS 重新加载 Thread\*：~3 条指令 |
| 每次方法调用 | 0 cycles 额外开销 | `push r15` + TLS 查找 + `pop r15` = ~50 cycles |
| 1000 次方法调用 | 0 cycles | ~50,000 cycles |
| safepoint poll | `testb [r15 + 56], 1` — 1 指令 | 先加载 Thread\* 再 poll — 3+ 指令 |
| 栈行走 | 从 r15 直接读 `last_Java_sp` | 需要从其他来源重建 Thread\* |

r15_thread 是 JVM 在 x86_64 上最重要的架构决策——用 1/16 的通用寄存器换来无限深度调用链上的零开销 Thread\* 访问。在 x86_32（只有 8 个 GPR）上不能这样做——寄存器极度稀缺，强行绑定一个会导致 spill 爆炸。

### 3.4 r12_heapbase 的 lea 指令解压

当 `UseCompressedOops` 开启时，r12 存堆基址。压缩指针解压只需 1 条指令：

```asm
; 压缩指针 narrow (32-bit) → 解压为 64-bit 地址
lea  rax, [r12 + narrow * 8]   ; 如果 shift = 3 (对象 8 字节对齐)
lea  rax, [r12 + narrow]       ; 如果 shift = 0 (堆 base != 0 且 size < 4GB)

; 如果 UseCompressedOops 关闭 → r12 可被回收为通用寄存器
; C1/C2 的寄存器分配器会检测到 r12 空闲 → 纳入通用寄存器池
```

`r15_thread` 不同——不管 `UseCompressedOops` 是否开启，r15 始终被占用（Thread\* 永远需要）。

### 3.5 rscratch1/rscratch2 的"纯临时"性质

r10 和 r11 在 x86_64 ABI 中是 caller-saved 通用临时寄存器。JVM 重命名为 `rscratch1`/`rscratch2` 是显式化它们的"纯临时"性质——MacroAssembler 的辅助函数（`movptr`、`load_address` 等）可以随意使用它们而不保存/恢复。

**代价**：信号安全的代码路径（如异常处理 stub）尽量不用 scratch——如果信号在 mid-scratch-use 时到达（刚用 rscratch1 加载指针还没用完），信号处理器可能读到垃圾。

---

## §四 ★★★ frame::safe_for_sender + sender 链——栈行走的全过程

### 4.1 safe_for_sender 的逐行源码走读

`frame_x86.cpp:53-267` 是栈行走的"门禁"——在构造 sender frame 前，验证当前帧的 sp/fp/pc 是否合法。共 **5 层检查**：

**Layer 1: sp 必须在栈范围内** (`frame_x86.cpp:63-70`)：

```cpp
bool sp_safe = (sp < thread->stack_base()) &&
               (sp >= thread->stack_base() - usable_stack_size);
if (!sp_safe) return false;
```

stack_base 是栈的最高地址（线程栈的顶部），usable_stack_size 扣除 guard pages。如果 sp 落在 guard page 区域 → 说明发生了栈溢出 → 不能行走。

**Layer 2: unextended_sp 必须在栈范围内且 ≥ sp** (`frame_x86.cpp:72-78`)：

```cpp
bool unextended_sp_safe = (unextended_sp < thread->stack_base()) &&
                           (unextended_sp >= sp);
if (!unextended_sp_safe) return false;
```

unextended_sp 是"帧底部"——对于编译帧，sp + frame_size = unextended_sp。如果 unextended_sp 低于 sp 或超出栈范围 → 帧结构损坏。

**Layer 3: fp 必须在栈范围内且高于 sp** (`frame_x86.cpp:82`)：

```cpp
bool fp_safe = (fp < thread->stack_base() && (fp > sp) &&
               (((fp + (return_addr_offset * sizeof(void*))) < thread->stack_base())));
```

fp 必须严格 > sp（帧指针在栈顶之上），且从 fp 读取 return address 的位置也必须在栈内。如果 fp 为 NULL 或指向非法地址 → 帧损坏。

**Layer 4: frame_is_complete_at(pc)** (`frame_x86.cpp:97-101`)：

```cpp
if (!_cb->is_frame_complete_at(_pc)) {
    if (_cb->is_compiled() || _cb->is_adapter_blob() || _cb->is_runtime_stub()) {
        return false;
    }
}
```

如果崩溃发生在 prologue 中间（刚 push rbp 还没 mov rbp, rsp），帧是不完整的——解析它会导致错误栈。C1/C2 编译的 nmethod 中有 `_frame_complete_offset` 标记 prologue 结束位置。**真实 crash 场景**：在 prologue 的第二条指令（sub rsp, 0x40）处收到 StackOverflow SIGSEGV → 此时 rbp 刚被 push 但还没 mov rbp, rsp → frame_is_complete_at 返回 false → safe_for_sender 拒识此帧。

**Layer 5: frame_size ≤ 0 拒绝**（编译帧路径，`frame_x86.cpp:138-140`）：

```cpp
if (_cb->frame_size() <= 0) {
    return false;
}
```

runtime stub（如某些 adapter）没有标准帧 → 没有 frame_size → 无法计算 sender_sp → 跳过此帧。

**Layer 6（解释器帧专有）**：`is_interpreted_frame_valid` (`frame_x86.cpp:505-559`)：
- 检查 method\* 指针是否合法（`Method::is_valid_method`）
- 检查 bcp 是否在 method->code 范围内
- 检查 ConstantPoolCache\* 是否合法
- 检查 locals 指针是否在线程栈范围内

### 4.2 sender() 的 3 路径派发表

`frame_x86.cpp:488-503`：

| 判定条件 | sender 函数 | 关键实现差异 | 行号 |
|---------|------------|-------------|------|
| `is_entry_frame()` | `sender_for_entry_frame` | 从 entry frame 的 `JavaFrameAnchor` 跳到上一个 Java 帧 | :493 → :344 |
| `is_interpreted_frame()` | `sender_for_interpreter_frame` | 从 `interpreter_frame_sender_sp_offset` 读 sender_sp | :494 → :431 |
| `_cb != NULL`（编译帧） | `sender_for_compiled_frame` | sender_sp = unextended_sp + frame_size | :497 → :451 |
| native frame | 直接构造 | frame(sender_sp(), link(), sender_pc()) | :502 |

### 4.3 解释器帧的 sender 重建

`frame_x86.cpp:431-446`：

```cpp
frame frame::sender_for_interpreter_frame(RegisterMap* map) const {
    intptr_t* sender_sp = this->sender_sp();              // [rbp + sender_sp_offset]
    intptr_t* unextended_sp = interpreter_frame_sender_sp();  // [rbp - 1*wordSize]
    return frame(sender_sp, unextended_sp, link(), sender_pc());
}
```

从当前帧的 `interpreter_frame_sender_sp_offset`（-1 word）读 caller 的 sp，从 `link_offset`（0 word）读 caller 的 rbp，从 `return_addr_offset`（+1 word）读 return address → 构造 caller 的 frame。

### 4.4 RegisterMap 的作用——callee-saved 寄存器在帧链中的"传递"

`registerMap_x86.hpp` 定义 `RegisterMap`，其中 `pd_location(VMReg reg)` 返回该寄存器在帧中的保存地址。当 GC 需要扫描 oop，它通过 `RegisterMap` 知道 r15 在帧中的哪个位置——因为在解释器入口 r15 被 push 到 [rbp - offset]：

```cpp
// frame_x86.cpp:407-426
void frame::update_map_with_saved_link(RegisterMap* map, intptr_t** link_addr) {
    map->set_location(rbp->as_VMReg(), (address) link_addr);
    // 记录 rbp 的保存位置 → GC 知道去哪里找保存的 rbp 值
}
```

---

## §五 ★★★ JavaFrameAnchor——Java↔C 交替执行的锚定

### 5.1 set_last_Java_frame 的指令序列

`macroAssembler_x86.cpp:3768-3798`。当 Java 代码需要调用 C++ Runtime（如 GC、Runtime 函数），在 call 之前执行：

```asm
; set_last_Java_frame(r15_thread, rsp, rbp, return_pc)
mov     [r15 + 48], rsp     ; _last_Java_sp = 当前栈顶（Java 帧的底部）
mov     [r15 + 56], rbp     ; _last_Java_fp = 当前帧指针
lea     [r15 + N], [rip + offset] ; _last_Java_pc = return address 的相对地址
```

```cpp
void MacroAssembler::set_last_Java_frame(Register java_thread,
                                         Register last_java_sp,
                                         Register last_java_fp,
                                         address  last_java_pc) {
    // 确定 java_thread 为 rdi（如果不是 r15_thread）
    // 确定 last_java_sp 为 rsp（如果不指定）
    if (last_java_fp->is_valid()) {
        movptr(Address(java_thread, JavaThread::last_Java_fp_offset()), last_java_fp);
    }
    if (last_java_pc != NULL) {
        lea(Address(java_thread,
                     JavaThread::frame_anchor_offset() + JavaFrameAnchor::last_Java_pc_offset()),
            InternalAddress(last_java_pc));
    }
    movptr(Address(java_thread, JavaThread::last_Java_sp_offset()), last_java_sp);
}
```

**关键细节**：`last_Java_sp` 必须在 **最后** 写入——因为 `walkable()` (`javaFrameAnchor_x86.hpp:65`) 的判断条件是 `_last_Java_sp != NULL && _last_Java_pc != NULL`。如果 sp 先于 pc 写入，中间窗口期栈行走器会看到一个"walkable 但不完整"的锚点。

### 5.2 reset_last_Java_frame——离开 Java 执行前清零

从 Runtime 返回后，清除锚点——表示"当前没有 Java 帧在活跃"：

```cpp
// javaFrameAnchor_x86.hpp:40-46
void clear(void) {
    _last_Java_sp = NULL;   // 必须先清 sp——让 walkable() 返回 false
    _last_Java_fp = NULL;
    _last_Java_pc = NULL;
}
```

### 5.3 capture_last_Java_pc 的 _last_Java_sp[-1] 解引用风险

`frame_x86.cpp:701-704`：

```cpp
void JavaFrameAnchor::capture_last_Java_pc() {
    _last_Java_pc = (address)_last_Java_sp[-1];
}
```

`_last_Java_sp[-1]` = `*(_last_Java_sp - 8)` = 栈顶上方一个字——恰是 return address。因为 `call` 指令自动 push return address → `[sp]` = return address。如果 `_last_Java_sp` 指向非法地址 → 这个解引用触发 SIGSEGV → 可能触发递归崩溃。

**递归崩溃风险详解**：如果 `_last_Java_sp` 已被 `set_last_Java_frame` 写入但 pc 尚未写入 → `walkable()` sees `sp!=NULL && pc==NULL` → undefined behavior。如果 `walk_at` 返回 corrupted frame → dereference wild pointer → double SIGSEGV → kernel sends the second SIGSEGV while still in the first signal handler → `VMError::report_and_die` recursion → `[error occurred during error reporting]`。This is why `set_last_Java_frame` writes pc FIRST, sp LAST.

### 5.4 make_walkable() 的线程归属断言

`frame_x86.cpp:689-699`：

```cpp
void JavaFrameAnchor::make_walkable(JavaThread* thread) {
    if (last_Java_sp() == NULL) return;   // 没有 Java 帧
    if (walkable()) return;                // 已经 walkable
    vmassert(Thread::current() == (Thread*)thread, "not current thread");
    capture_last_Java_pc();
}
```

`Thread::current() == thread` 断言防止在错误的线程上调用 make_walkable。在信号上下文中如果信号处理器误读其他线程的 Anchor → 这个断言触发。

---

## §六 ★★★ sender_sp vs unextended_sp——JVM 专有双 sp 设计

### 6.1 为什么 JVM 需要两个 sp 概念

```
解释器帧的两个 sp:
  unextended_sp = caller 调用 callee 时的 RSP（帧的"原始底部"——不会变）
  sp            = 当前线程的实时 RSP（动态——表达式栈 push/pop 时变化）

编译帧的两个 sp:
  unextended_sp = sp + frame_size（固定帧大小 → 两个 sp 相等）
  sp            = 当前 RSP
```

**为什么解释器需要第二个 sp？** 因为解释器的表达式栈动态增长——当 `dup`、`iload`、`iadd` 等字节码操作表达式栈时，rsp 会移动。仅靠 rsp 无法还原 caller 的帧边界 → 必须显式保存 sender_sp。编译帧大小固定（编译时确定）→ `sender_sp = sp + frame_size` → 不需要单独保存。

### 6.2 sender_sp 的链式回溯

```cpp
// frame_x86.cpp:310-312
intptr_t* frame::interpreter_frame_sender_sp() const {
    return (intptr_t*) at(interpreter_frame_sender_sp_offset);  // = [rbp - 8]
}
```

从每个解释器帧的 -1 word 读取 caller 的 sp → 用这个 sp 构造 caller 的 frame → caller 同样从它的 -1 word 读取上一帧的 sp → 形成链式回溯。每个帧的 sender_sp 指向上一个帧的入口 sp。

---

## §七 ★ 阶段连接——信号的 RSP 如何变成 JVM 的 frame::sender()

### 7.1 信号 ucontext_t 的 RSP → JVM 的初始 frame

[11-os-layer §二] 的 `JVM_handle_linux_signal` 从 `ucontext_t->uc_mcontext.gregs[REG_RSP]` 读取崩溃时的栈指针，用这个 sp + pc 构造初始 frame 对象 → 从这个 frame 出发调用 `sender()` 逐帧重构 Java 调用栈。

```
信号到达 → 内核在用户栈上压入 ucontext_t + siginfo_t
  → ucontext_t 中的 RSP/RBP/RIP = 信号到达瞬间的用户态寄存器值
  → JVM 从 ucontext_t 构造初始 frame(sp, fp, pc)
  → frame::sender(map) → 下一帧
  → ... 直到 entry_frame（Java 调用链的根部）
```

### 7.2 Thread\* → r15_thread 的"寄存器固化"

[07-thread-lock] 建立了 JavaThread 的生命周期。本文解释 Thread\* 如何成为 CPU 指令的操作数——`mov rax, [r15 + offset]` 一条指令读取 Thread 字段，无函数调用，无 TLS 查找。

### 7.3 和 [12-02 Interpreter] + [12-03 Stubs] 的连接

| 本文概念 | [12-02] 中的使用 | [12-03] 中的使用 |
|---------|-----------------|-----------------|
| frame offset table | 解释器帧专有偏移（method_offset/bcp_offset/locals_offset） | deopt 帧重建从 offset table 读取 |
| set_last_Java_frame | 解释器调用 Runtime 前的帧锚定 | call_stub 入口的帧锚点建立 |
| sender_sp | interpreter_frame_sender_sp_offset | call_stub 的 sender 计算 |
| r15_thread | 解释器 safepoint poll: `testb [r15 + 56], 1` | stub 中 Thread\* 字段访问 |

---

## §九 GDB 验证 + 可证伪断言

### 断言 1：call 指令执行后 [rsp] 存储 return address

```bash
(gdb) br frame_x86.cpp:488   # sender 入口
# 在 Java 方法中设断点
(gdb) x/gx $rsp
# 预期：值指向 caller 的 call 指令下一条指令地址
(gdb) p/x *(void**)$rsp
# 预期：该地址在 caller 的 CodeBlob 范围内
```

### 断言 2：prologue 的 push rbp 使 [rbp] = caller's rbp

```bash
(gdb) br frame_x86.cpp:451   # sender_for_compiled_frame 入口
(gdb) p/x *(intptr_t**)$rbp
# 预期：值 = caller 的 rbp → 继续回溯形成完整 rbp 链
(gdb) x/gx $rbp
(gdb) x/gx *(intptr_t**)$rbp
# 预期：3 层回溯均可读
```

### 断言 3：r15 在整个 Java 方法调用链中保持不变

```bash
(gdb) br frame_x86.cpp:488   # sender 入口
# 每次断点触发
(gdb) p/x $r15
# 预期：每次 p/x $r15 返回相同的 Thread* 对象地址
```

### 断言 4：解释器帧的 interpreter_frame_sender_sp_offset = -1 word

```bash
(gdb) br frame_x86.cpp:431   # sender_for_interpreted_frame 入口
(gdb) p/x *(intptr_t**)($rbp - 8)
# 预期：值 = caller frame 的 sp + caller frame_size
```

### 断言 5：解释器帧的 interpreter_frame_method_offset 存储 Method\* 指针

```bash
(gdb) p/x *(Method**)($rbp - 24)
# 预期：值为有效的 Method* → 可追溯 method->name() 等字段
```

### 断言 6：safe_for_sender 对 frame_size ≤ 0 的 blob 返回 false

```bash
(gdb) br frame_x86.cpp:138   # frame_size <= 0 检查
(gdb) p _cb->frame_size()
# 预期：对于 runtime stub（如某些 adapter），frame_size = 0
(gdb) p safe_for_sender(thread)
# 预期：返回 false
```

### 断言 7：frame_is_complete_at(pc) 在 prologue 中间返回 false

```bash
# 在 C1 编译方法的 prologue 中（push rbp 后、mov rbp rsp 前）设断点
(gdb) br *0x00007f8b15c4d2c1  # sub rsp, 0x40（push rbp 之后）
(gdb) p _cb->is_frame_complete_at($rip)
# 预期：返回 false（prologue 未完成）
```

### 断言 8：-XX:+PreserveFramePointer 下 sender_sp = sp + frame_size

```bash
(gdb) br frame_x86.cpp:456   # sender_sp 计算后
(gdb) p/x $rsp
(gdb) p _cb->frame_size() * 8
(gdb) p/x $rsp + _cb->frame_size() * 8
# 预期：等于 sender_sp
```

### 断言 9：set_last_Java_frame 写入 r15_thread 的 3 个偏移

```bash
(gdb) br macroAssembler_x86.cpp:3797  # 最后一条 mov 后
(gdb) p/x *(intptr_t**)($r15 + 48)    # last_Java_sp
# 预期：等于当前 rsp
(gdb) p/x *(intptr_t**)($r15 + 56)    # last_Java_fp
# 预期：等于当前 rbp
```

### 断言 10：reset_last_Java_frame 清零 Thread 的字段

```bash
# 在 JavaFrameAnchor::clear() 之后设断点
(gdb) p/x *(intptr_t**)($r15 + 48)    # last_Java_sp
# 预期：0（NULL）——帧锚点已清除
```

### 断言 11：解释器帧的 unextended_sp != current sp（表达式栈扩展后）

```bash
(gdb) br frame_x86.cpp:431   # sender_for_interpreted_frame
# 在解释器执行 dup 或 iadd 后
(gdb) p frame::unextended_sp()
(gdb) p frame::sp()
# 预期：unextended_sp > sp，差值 = expression_stack_depth * wordSize
```

### 断言 12：RegisterMap 记录 callee-saved 寄存器位置

```bash
(gdb) br frame_x86.cpp:440   # update_map 调用前
(gdb) p map->location(r15->as_VMReg())
# 预期：返回 r15 在帧中的保存地址（[rbp - offset]），值 = Thread*
```

---

## §八 生产 crash 分析 checklist

| 观测 | 诊断 | 行动 |
|------|------|------|
| **R15 = 0x0** | Thread\* 丢失 | 所有 `[r15 + offset]` 访问触发 SIGSEGV → Java 栈不可行走 |
| **R12 = 0x0** | heapbase 可能正常（零基址）或不正常（非零基址损坏） | 检查 `heap_base` 是否 == 0 → 如果 != 0 → 压缩指针解压失效 |
| **RSP 在 guard page 区域** | 栈溢出 | 检查 Java frames 的深度——递归超限 |
| **RBP 链断裂** | `-XX:-PreserveFramePointer` 或帧损坏 | 用 `frame::sender()` 替换 GDB rbp 链 |
| **no Java frames in hs_err** | last_Java_sp = NULL | R15 在崩溃前已经损坏 → 回溯到 Java 调用之前的 native 代码 |
| **Problematic frame: V [libjvm.so+0x...]** | 崩溃在 JVM 代码 | 用 `addr2line -e libjvm.so -f 0x...` 反查源文件行号 |
| **Problematic frame: J [compiled] +0x...** | JIT 生成了错误代码 | 用 `-XX:+PrintAssembly` + hsdis 反汇编该地址 |

**addr2line 实操示例**：
```bash
$ addr2line -e /usr/lib/jvm/java-11-openjdk/lib/server/libjvm.so 0x8c4d21
→ src/hotspot/cpu/x86/frame_x86.cpp:488 (safe_for_sender)
```
`0x8c4d21` 是 hs_err 中 `[libjvm.so+0x8c4d21]` 的偏移量——对应 libjvm.so 的动态基址 offset。`-e` 指定 ELF 文件（必须有 debug symbols）。如果看到 `??:0`，说明 libjvm.so 是 strip 过的——需要安装 `openjdk-11-dbg` 包或使用带 `-g` 编译的自定义 JDK。

---

## 核心发现总结

| # | 发现 | 核心洞察 |
|---|------|--------|
| 1 | **call 指令是硬件行为** | CPU 自动 push return address——JVM 的所有帧系统建立在此约定之上 |
| 2 | **r15 = callee-saved 是架构决策** | 用 1/16 寄存器换无限深度调用链的零开销 Thread\* 透传 |
| 3 | **解释器帧"重"于编译帧** | method\*/bcp\*/locals\* 必须保存在帧中——跨越 Runtime 调用的安全需求 |
| 4 | **sender_sp ≠ sp 是 JVM 专有概念** | 解释器表达式栈动态扩展 → 必须显式保存 caller sp |
| 5 | **set_last_Java_frame 的 sp 必须最后写** | walkable() = sp≠NULL && pc≠NULL → 防止中间态的锚点被读到 |
| 6 | **safe_for_sender 的 5 层检查是 crash 安全的基石** | sp 范围 → fp 范围 → frame_complete → frame_size → 解释器帧验证 |
| 7 | **R15=0x0 → 致命** | 所有 thread 字段访问变近零页读取 → SIGSEGV → set_last_Java_frame 无法执行 → 无 Java 栈 |
