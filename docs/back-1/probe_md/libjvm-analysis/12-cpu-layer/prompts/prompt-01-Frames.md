# PROMPT: 请撰写 01-Frames.md

## §〇 背景与生产场景

### 你在线上真实经历的

凌晨 3 点，应用宕机。hs_err 文件第一段：

```
# A fatal error has been detected by the Java Runtime Environment:
#
#  SIGSEGV (0xb) at pc=0x00007f8b1a3c4d21, pid=12463, tid=12494
#
# JRE version: OpenJDK Runtime Environment (11.0.22+9) (build 11.0.22+9-LTS)
# Java VM: OpenJDK 64-Bit Server VM (11.0.22+9-LTS, mixed mode, sharing, tiered, compressed oops, g1 gc, linux-amd64)
# Problematic frame:
# V  [libjvm.so+0x8c4d21]  G1ParScanThreadState::copy_to_survivor+0x61
```

往下翻到 Register 段：

```
Registers:
RAX=0x00007f8b20000000, RBX=0x0000000000000000, RCX=0x00007f8b1a3c4d21
RDX=0x0000000000000003, RSP=0x00007f8b1ecfcb80, RBP=0x00007f8b1ecfcbc0
RSI=0x00007f8b24083800, RDI=0x00007f8b1ecfcc00
R8 =0x0000000000000000, R9 =0x00007f8b1ebfc000, R10=0x00007f8b15c4d8a2
R11=0x0000000000000006, R12=0x0000000000000000, R13=0x00007f8b1ecfcc80
R14=0x00007f8b15c4d2c0, R15=0x0000000000000000
```

你盯着 `R12=0x0000000000000000` 和 `R15=0x0000000000000000`——但你不懂这两个寄存器在 JVM 中意味着什么。

→ **R15=0x0**：`r15_thread` 是 JVM 永久绑定的 Thread* 指针。当它为 0，意味着 Thread* 对象指针丢失——任何 `mov reg, [r15 + offset]` 都会在 offset 很小（如 `Thread::polling_page_offset` = 56）时访问 0x38 附近地址 → SIGSEGV。此时 `set_last_Java_frame(r15_thread, sp, fp, pc)` 无法执行——`_last_Java_sp` 无法被写入——栈行走器找不到 Java 帧——hs_err 里没有 Java 调用栈。

→ **R12=0x0**：`r12_heapbase` 保存压缩 OOPs 的堆基址。如果是零基址模式（`heap_base == 0`），r12 本就该为 0——正常。但如果堆基址非零（堆不在虚拟地址 0 起始），r12=0 意味着窄化指针的解压失效——`lea rax, [r12 + narrow*8]` 生成的地址错误。

你在真实的 crash 中会看到这样的 x86 指令：

```asm
; set_last_Java_frame 的核心指令（来自 macroAssembler_x86.cpp:3768）
mov     [r15 + 48], rsp     ; _last_Java_sp_offset = 48 — 如果 r15=0 则 SIGSEGV on 0x30
mov     [r15 + 56], rbp     ; _last_Java_fp_offset = 56
mov     [r15 + 64], rsi     ; _last_Java_pc_offset = 64  — rsi 存 return pc
```

当你看到 hs_err 中 `Problematic frame: V [libjvm.so+0x8c4d21]` + `R15=0x0`，你去反汇编这个偏移：

```asm
; libjvm.so+0x8c4d21 可能是：
mov     rdi, [r15 + 48]    ; 试图读取 thread->last_Java_sp
```

这就是根因——Thread* 丢失导致任何 thread 字段访问都变成近零页访问。

### 你在 `-XX:+PrintAssembly` 中看到的

```
; Java 方法的 prologue（C1 编译输出）
0x00007f8b15c4d2c0: push   rbp
0x00007f8b15c4d2c1: sub    rsp, 0x40
0x00007f8b15c4d2c5: mov    rbp, rsp
...
; Java 方法的 epilogue
0x00007f8b15c4d398: add    rsp, 0x40
0x00007f8b15c4d39c: pop    rbp
0x00007f8b15c4d39d: test   rax, rax          ; 检查 rax 是否为 exception oop
0x00007f8b15c4d3a0: jne    0x00007f8b15c4d3b0 ; 非 NULL → 异常分发
0x00007f8b15c4d3a2: ret
```

每一个 `push rbp; sub rsp, 0x40; mov rbp, rsp` 和 `add rsp, 0x40; pop rbp; ret` 都是本文要解释的帧布局的物理实现。你在 crash dump 里看到的 `RSP=... RBP=...` 就是这两个寄存器此刻的值——而它们之间的空间就是"当前帧"。

## §一 任务 + 核心叙事

读者已学完 [11-os-layer]——理解了信号处理器如何分发 SIGSEGV/SIGBUS、os::create_thread 如何创建线程并绑定 TLS、mmap/mprotect 如何管理虚拟内存等 OS 层三原语。读者已学完 [07-thread-lock]——知道 JavaThread 对象在 JVM 内部的生命周期模型。

现在该把抽象拉回到硬件：**当 Java 方法被执行时，x86_64 CPU 的栈上到底长什么样？call 指令触发后 CPU 硬件做了什么？callee 的 prologue 如何建立帧指针链？为什么 r15 被永久绑定到 JavaThread*？**

### ★ 这不是 x86 汇编教程

**本文不是 x86_64 System V ABI 参考手册**——不讲 `_start` 到 `main` 的 CRT 调用链、不讲 `__attribute__((ms_abi))` 的 Windows 兼容性、不讲 x86 保护模式/长模式的段寄存器。本文只关心 **JVM 的栈帧布局**——return address 下方为什么是 saved rbp、locals、monitor slots、expression stack，以及 `sender_sp` / `unextended_sp` 的 JVM 专有概念。

**本文不是 x86 寄存器全览**——不讲 `xmm0-xmm15` 的浮点调用约定、不讲 `st(0)-st(7)` 的 x87 寄存器栈、不讲 `mxcsr` 控制寄存器的舍入模式。本文只关心 **JVM 专用的寄存器绑定**——`r15_thread`、`r12_heapbase`、`rscratch1`/`rscratch2`，以及它们为什么从通用寄存器变成了"专用寄存器"。

**本文不解释 JVM 之外的任何栈帧**——不讲 C 标准库的 `setjmp/longjmp` 缓冲区、不讲 signal handler 的内核栈帧（`ucontext_t` → `sigframe`）、不讲 Go 的分段栈、不讲 Rust 的 `#[inline(never)]` 枚举布局。本文的 1000 行只回答一个问题：**JVM 在 x86_64 上执行 Java 方法时，CPU 栈上的 1 和 0 怎么排列。**

### ★ 你需要知道的（零 x86 知识的 Java 工程师在进入源码前必须理解的 4 个概念）

#### 概念 1：caller-saved vs callee-saved 寄存器

当函数 A 调用函数 B 时，寄存器是共享资源——只有一个 rax，只有一个 rbx。"谁负责在调用前后保护寄存器里的值"是约定的核心：

- **caller-saved**（调用者保存）：A 在调用 B 前如果某个寄存器的值之后还要用，A 自己先 push 到栈上。B 可以随意破坏这些寄存器（rax、rcx、rdx、rsi、rdi、r8-r11）而不保存。为什么这么设计？因为 A 知道自己还"活"着什么值，只在必要时才保存；B 不知道 A 的状态，如果强制 B 保存所有寄存器会浪费指令。
- **callee-saved**（被调者保存）：B 如果要用这些寄存器（rbx、rbp、r12-r15），必须先 push 旧值到栈、返回前 pop 恢复。A 不需要保存这些——它信任 B 不会破坏。为什么这么设计？因为 call/ret 非常频繁，caller-saved 让 A 有可能避免在每次 call 前都保存（如果在 A 内某个寄存器的值已经"死"了就不需要保存），callee-saved 让"跨越多个 call 的长寿变量"（如循环变量、基址指针）不需要在每个 call 点反复保存/恢复。

**JVM 为什么把 r15 永久绑定到 Thread\***：因为 r15 是 callee-saved——Java 方法的机器码不碰 r15（由 JVM 保证），所以 Thread* 自动在整条调用链上"透传"——caller 的 r15 到 callee 中不变，callee 再调用下个 callee 也不变，无限深度调用链全都不需要重新加载 Thread*。如果 r15 是 caller-saved，每个方法入口都要重新从 TLS 加载 Thread*，每次方法调用多 50+ cycles。这不是"多了一个优化"——这是"把热路径从每次调用 50 cycles 压到 0 cycles"的架构决策。

#### 概念 2：spill slot（溢出槽）

x86_64 有 16 个通用寄存器，但其中 rsp/rbp 是栈管理、r15_thread/r12_heapbase 被 JVM 抢占、r10/r11 是 scratch——实际留给编译器自由分配的只有 ~10 个。当一个方法有 20 个局部变量、10 个中间计算结果时，编译器物理寄存器不够了——必须把某些值临时写入栈上预留的位置，即 spill slot。

典型的 spill 操作：`mov [rbp - 8], eax`（把 eax 的值"溢出"到栈上），之后 eax 可以用于其他计算。需要时再 `mov eax, [rbp - 8]`（从栈上"装回"）。spill 的成本是内存读写（~200 cycles），远比寄存器操作（~1 cycle）贵——所以寄存器分配是编译器优化的核心。C2 编译帧中的 spill slot 区域在帧底部（靠近 rsp），为所有"可能溢出的虚拟寄存器"预留固定偏移，C2 的寄存器分配器（Chaitin-Briggs 图着色算法）的目标就是最小化 spill 次数。

#### 概念 3：帧锚点（frame anchor）— sender_sp / last_Java_sp 机制

JVM 中 Java 代码和 C++ 代码交替执行。当执行从 Java 进入 C++（如 GC、Runtime 函数），C++ 端的栈行走器需要知道"Java 最后一帧的边界在哪里"——这就是帧锚点的作用。两层机制：

1. **sender_sp**（帧间锚点）：每个 Java 帧在构造时记录 caller 的 sp（即 callee 入口时的 rsp）。值保存在帧的固定偏移处（`interpreter_frame_sender_sp_offset`）。当 `frame::sender()` 需要重建 caller 帧时，从这个偏移读取 caller 的 sp，然后用 return address 反查 caller 的 CodeBlob → 得到 caller 帧的完整布局。这形成了一条从当前帧向高地址"链式回溯"的帧链表。
2. **last_Java_sp**（Java↔C 锚点）：当 Java 代码调用 C++ Runtime 函数时，`set_last_Java_frame(r15_thread, rsp, rbp, return_pc)` 把当前的 sp/fp/pc 写入 `JavaThread::_last_Java_sp/fp/pc`（三个字段在 Thread 对象中）。C++ 端的栈行走器从这些字段出发，开始逐帧遍历 Java 帧。

#### 概念 4：x86 栈的"向下生长"

x86 栈从高地址向低地址生长。`push` = `sub rsp, 8; mov [rsp], value`（先减栈指针再写值）。`pop` = `mov value, [rsp]; add rsp, 8`。所以"栈顶"是低地址，"栈底"是高地址。ASCII 帧图中"高地址在上方"反映的就是这个物理现实——rsp 永远指向当前帧的最低地址（栈顶方向）。

### 核心叙事线 — "JVM 在 x86_64 上的栈帧坐标系"

[11-os-layer] 的 `JVM_handle_linux_signal` 从 `ucontext_t` 中读取 crasher 的寄存器——`uc_mcontext.gregs[REG_RIP]` 是崩溃指令地址，`uc_mcontext.gregs[REG_RSP]` 是崩溃时的栈顶。要重建调用链，需要从 RSP 出发逐帧解码——这就是本文的帧布局知识。11 解决了"信号从哪里来"，12-01 解决"信号到达时栈上有什么"。

[07-thread-lock] 建立了 JavaThread 的 JVM 内生命周期模型。本文解释 Thread* 如何被"固化"到 CPU 硬件中——`r15_thread` 是 Thread 在指令级别的代理。每当 JVM 生成的代码需要读取 `thread->safepoint_state`、`thread->last_Java_sp` 或 `thread->polling_page`，它用 `mov reg, [r15 + offset]`——不需要函数调用，不需要查 TLS，一条指令完成。

### 验证报告
- `sverklo_search "frame::safe_for_sender sender_for_interpreted_frame frame layout"` → frame_x86.cpp, frame_x86.hpp
- `codegraph query "frame::sender"` → cpu/x86/frame_x86.cpp:488
- `rg -n "r15_thread\|r12_heapbase\|rscratch1\|rscratch2" assembler_x86.hpp` → 寄存器别名声明
- `rg -n "interpreter_frame_sender_sp_offset\|link_offset\|return_addr_offset" frame_x86.hpp` → 帧偏移常量
- `rg -n "set_last_Java_frame\|reset_last_Java_frame\|JavaFrameAnchor" macroAssembler_x86.cpp javaFrameAnchor_x86.hpp` → 帧锚点实现

## §二 标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+PrintAssembly`
- 64 位 Linux x86_64
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ `-XX:+PreserveFramePointer` 默认开启以保留 rbp 链

## §三 聚焦源文件

| # | 文件 | 路径 | 模块 | 核心函数/类 | 本文角色 |
|---|------|------|------|-----------|---------|
| 1 | `frame_x86.cpp` | `src/hotspot/cpu/x86/frame_x86.cpp` | cpu/x86 | `frame::safe_for_sender`(:53), `frame::sender`(:488), `frame::sender_for_interpreted_frame`(:431), `frame::sender_for_compiled_frame`(:451), `frame::is_interpreted_frame_valid`(:199) | ★★★ 帧布局核心——所有栈帧的构建和行走 |
| 2 | `frame_x86.hpp` | `src/hotspot/cpu/x86/frame_x86.hpp` | cpu/x86 | 帧偏移常量：`interpreter_frame_sender_sp_offset`(-1), `link_offset`(0), `return_addr_offset`(1), `interpreter_frame_bcp_offset`, `interpreter_frame_locals_offset` | ★★ 帧偏移——帧内寻址的坐标常数 |
| 3 | `frame_x86.inline.hpp` | `src/hotspot/cpu/x86/frame_x86.inline.hpp` | cpu/x86 | 内联访问器：`frame::sender_pc()`, `frame::unextended_sp()`, `frame::interpreter_frame_bcp()` | ★ 快速访问——帧字段的内联读取 |
| 4 | `register_x86.hpp` | `src/hotspot/cpu/x86/register_x86.hpp` | cpu/x86 | `RegisterImpl` 类, r15_thread 宏, r12_heapbase 宏 | ★★ 寄存器声明——JVM 专用寄存器别名和物理寄存器映射 |
| 5 | `assembler_x86.hpp` | `src/hotspot/cpu/x86/assembler_x86.hpp` | cpu/x86 | `REGISTER_DECLARATION(r15_thread, r15)`, `REGISTER_DECLARATION(r12_heapbase, r12)`, `c_rarg0..3`, `rscratch1`/`rscratch2` | ★ 寄存器别名 + C 调用约定寄存器 + scratch 寄存器 |
| 6 | `javaFrameAnchor_x86.hpp` | `src/hotspot/cpu/x86/javaFrameAnchor_x86.hpp` | cpu/x86 | `JavaFrameAnchor::capture_last_Java_pc`, `make_walkable`, `copy` | ★★ Java→C 帧锚点的 CPU 实现 |
| 7 | `registerMap_x86.hpp` | `src/hotspot/cpu/x86/registerMap_x86.hpp` | cpu/x86 | `RegisterMap` 类——栈行走时的寄存器定位映射 | ★ 栈行走辅助——saved register 位置映射 |
| 8 | `frame_linux_x86.cpp` | `src/hotspot/os_cpu/linux_x86/frame_linux_x86.cpp` | os_cpu/linux_x86 | `frame::sender_for_native_frame` | ★ OS 层帧发送器——native 帧参与帧链 |

**跨模块说明**：帧相关代码横跨 `cpu/x86/`（cpu 专有实现）和 `os_cpu/linux_x86/`（OS 粘合层）。cpu/x86/ 定义通用的寄存器约定和帧访问器，os_cpu/linux_x86/ 处理 Linux 信号上下文到帧对象的转换。`javaFrameAnchor_x86.hpp` 是衔接 Java 执行和 C++ 执行的关键桥梁。

## §四 必须深度走读的核心概念（≥6 组，source-code-driven，"why X not Y" 风格）

> 每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ `call` 指令触发后，栈上发生了什么？——帧建立的完整物理过程

```
问题：
  ① call 指令的硬件语义是什么？CPU 在 call 指令执行时做了哪两步自动操作？
      线索: x86 指令集手册（概念引用，非教学）
      答案方向: `call 0x...` → CPU 硬件：(1) `RIP += instruction_length`（这是"下一条指令"的地址）
      → (2) `push RIP`（RSP -= 8; [RSP] = RIP）→ (3) `RIP = target`（跳转到目标）。
      所以当 callee 的第一条指令执行时，栈顶已经有一个 return address。
      这是**硬件行为**——不由 JVM 也不由 callee 控制，CPU 无条件执行。

  ② callee 的 prologue 如何建立帧？
      线索: C1/C2 编译输出的固定模式，frame_x86.cpp prologue 识别
      代码引证:
        // 典型 C1 编译方法的 prologue（来自实际 -XX:+PrintAssembly 输出）
        push rbp               ; 保存 caller 的帧指针 → [rsp]; rsp -= 8
        sub  rsp, 0x40         ; 分配帧空间（locals + spill + 对齐）; rsp -= 0x40
        mov  rbp, rsp          ; 建立新帧指针 → rbp 指向当前帧的"锚点"
      答案方向: prologue 的 3 条指令完成帧建立：(a) push rbp 建立 rbp 链（rbp 指向的内存放前一个帧的 rbp）；
      (b) sub rsp 分配帧空间；(c) mov rbp, rsp 将帧指针固定到当前帧。

  ③ 为什么 -XX:-PreserveFramePointer 可以省略 push rbp + mov rbp, rsp？
      线索: frame_x86.cpp safe_for_sender 中对编译帧的判断分支
      答案方向: 关闭 rbp 后，JVM 依赖 CodeBlob 中存储的 frame_size（编译时已知固定大小）做栈行走：
      sender_sp = current_sp + frame_size。不再需要 rbp 链。代价：GDB/perf 不能再通过 rbp 链回溯
      调用栈（所有栈帧都不可见）→ frame pointer unwinding 失败 → `perf record --call-graph fp` 失效。
      但 JVM 自己的栈行走器（StackFrameStream）走 CodeBlob 路线 → 不受影响。
```

### 4.2 ★★★ JVM 专用寄存器约定——为什么 r15 必须是 Thread*？

```
问题：
  ① r15_thread 的绑定在 JVM 启动的哪个阶段完成？它的值从哪来？
      线索: register_x86.hpp 别名声明, thread.cpp Thread 创建
      答案方向: r15_thread 不是一个"变量"——它是寄存器别名的 C++ 声明（`REGISTER_DECLARATION(r15_thread, r15)`）。
      它的"绑定"在语义层面：所有 JVM 生成的机器码都遵守"r15 = current JavaThread*"的约定。
      每次线程切换时（如 os::create_thread），新线程在进入 Java 方法前通过 `MacroAssembler::get_thread(r15)`
      把当前 Thread* 加载到 r15。之后所有 Java 方法入口不需要再加载——因为 r15 是 callee-saved。
      代码引证:
        // assembler_x86.hpp
        REGISTER_DECLARATION(r15_thread, r15);
        // register_x86.hpp
        CONSTANT_REGISTER_DECLARATION(Register, r15_thread, (RegisterImpl*)&r15_RegisterImpl);

  ② 为什么不在 x86_32 上绑定 Thread* 到寄存器？
      线索: x86_32 只有 8 个 GPR (eax/ecx/edx/ebx/esp/ebp/esi/edi)
      答案方向: 32 位上寄存器极度稀缺——esp 是栈指针、ebp 是帧指针（可省略）、ebx 是 C1/C2 的常用本地变量。
      如果强行绑定一个 Thread*，编译器只剩 4 个自由寄存器——spill 爆炸 → 性能反降。
      所以 32 位上 Thread* 只能通过 pthread_getspecific 从 TLS 获取——每次方法入口 ~50 cycles 开销。
      64 位的 16 GPR 让"浪费一个"变得划算——r15_thread 的"浪费"换来每个方法入口省 50 cycles。

  ③ 如果 UseCompressedOops 关闭，r12 能被 C1/C2 回收利用吗？
      线索: assembler_x86.hpp 中 r12 的条件声明, c1/c2 寄存器分配逻辑
      答案方向: 是的。汇编层 r12_heapbase 宏始终指向 r12 物理寄存器，但 UseCompressedOops==false 时
      r12_heapbase 实际上被设为 NULL 或不使用。C1/C2 的寄存器分配器（LinearScan / Chaitin-Briggs）
      会检测到 r12 空闲 → 将其纳入通用寄存器池。r15_thread 不同——不管 UseCompressedOops 是否
      开启，r15 始终被占用（Thread* 永远需要）。
```

### 4.3 ★★★ x86_64 JVM 栈帧逐层分解——所有文档的坐标系

```
问题：
  ① 解释器帧和编译帧（C1/C2）在栈结构上有什么本质区别？
      线索: frame_x86.cpp sender_for_interpreted_frame vs sender_for_compiled_frame
      答案方向:
      - 解释器帧: 有明确的 locals / monitor slots / expression stack 分区。sender_sp 保存在固定偏移。
        帧内有 method*、bcp、locals、constPool 等指针。帧大小动态（表达式栈扩展时变化）。
      - C1 编译帧: 有 spill slots 为 locals /中间值预留固定偏移。帧大小在编译时确定（固定）。
        没有 "monitor slots" synchronized 的锁记录内联在 prologue/epilogue 中，不占用帧槽。
        没有 "expression stack" — 中间值在寄存器或 spill slot 中。
      - C2 编译帧: 类似 C1，但帧内有更复杂的结构——oop maps、deoptimization metadata。
        更大的 spill 区域（C2 生成更多虚拟寄存器），且可能包含 caller/callee saved 区域。

  ② 为什么解释器帧要保留 sender_sp 而编译帧不需要？
      线索: frame_x86.hpp interpreter_frame_sender_sp_offset = -1 word
      答案方向: 解释器帧内 execution stack 动态扩展（从 high addr 向 low addr grow），所以当前 rsp
      低于 caller 看到的入口 sp → 仅靠 rsp 无法还原 caller 的帧边界 → 必须显式保存 sender_sp。
      编译帧大小固定（编译时确定）→ sender_sp = current_sp + frame_size → 不需要单独保存。

  ③ frame::unextended_sp() 的返回值是什么？为什么不直接用 sp()？
      线索: frame_x86.inline.hpp unextended_sp()
      代码引证:
        inline intptr_t* frame::unextended_sp() const {
          return (intptr_t*)((intptr_t)fp() + _cb->frame_size() * wordSize);
        }
      答案方向: unextended_sp 是帧的"参数区域起始地址"——即 caller 看到 callee 入口时的 sp。
      对于编译帧: sp + frame_size = unextended_sp（因为帧大小固定，两者差值为固定帧大小）。
      对于解释器帧: sp 因为表达式栈扩展而低于 sender 入口 sp，所以 unextended_sp > sp。
      "unextended"的意思就是"没有包含栈扩展的原始帧底部"。
```

### 4.4 ★★★ 帧行走（stack walking）——sender 链如何回溯

```
问题：
  ① frame::safe_for_sender() 检查了什么条件下 sp/fp 是"安全的"？
      线索: frame_x86.cpp:53 safe_for_sender
      代码引证:
        // 判定 sender(callee) 给的这个 frame(sp,fp,pc) 是否合法：
        bool frame::safe_for_sender(JavaThread *thread) {
          if (!thread->is_in_full_stack((address)_sp)) return false; // sp 在线程栈范围内
          if (_fp && !thread->is_in_stack_range((address)_fp)) return false; // fp 在栈范围
          if (_cb != NULL) {
            if (_cb->frame_size() <= 0) return false; // runtime stub 无帧
            if (!_cb->is_frame_complete_at(_pc)) return false; // prologue 中间崩溃
          }
          return true;
        }
      答案方向: 4 层检查：(a) sp 必须在线程栈范围内——防止野指针；(b) fp 如果有且不为 null 必须在
      栈范围内——损坏的帧指针链会导致无限循环或 segfault；(c) CodeBlob 的 frame_size > 0（runtime
      stub 没有标准帧）；(d) frame_is_complete_at(pc)——如果崩溃发生在 prologue 中间（刚 push rbp
      还没 mov rbp, rsp），帧是不完整的——解析它会导致错误栈。

  ② frame::sender_for_interpreted_frame 如何从当前解释器帧恢复 caller 帧？
      线索: frame_x86.cpp:431
      代码引证:
        frame frame::sender_for_interpreted_frame(RegisterMap* map) const {
          intptr_t* sender_sp = addr_at(interpreter_frame_sender_sp_offset); // 读 -1 word
          address   sender_pc = (address)sender_sp[return_addr_offset];     // 读 return address
          CodeBlob* sender_cb = CodeCache::find_blob(sender_pc);
          return frame(sender_sp, sender_sp, (intptr_t*)*(sender_sp - 1), sender_pc, sender_cb);
        }
      答案方向: (1) 从当前帧的 sender_sp_offset 读 caller 的 sp；(2) 从 caller sp 上方读 return address；
      (3) 用 return address 查找 CodeBlob → frame_size；(4) 构造 caller 的 frame 对象；
      (5) RegisterMap 参与把当前帧中的 callee-saved 寄存器值"传递"给 caller 帧。

  ③ Native frame 为什么更难 walk？os::get_sender_for_C_frame() 的局限是什么？
      线索: frame_linux_x86.cpp sender_for_native_frame
      答案方向: native frame（C/C++ 代码帧）的栈布局没有被 JVM 管理——它们由编译器生成。如果
      `-fomit-frame-pointer` 打开（现代编译器默认），rbp 被重用为通用寄存器→ rbp 链断裂→
      只能用 DWARF unwind table 反解。get_sender_for_C_frame() 从 return address 和 rbp 链出发，
      如果 rbp 为非法值→ 返回无效帧→ 栈行走终止。所以 hs_err 中 native frames 常常不完整。
```

### 4.5 ★★★ JavaFrameAnchor——Java↔C 交替执行的"锚定"机制

```
问题：
  ① set_last_Java_frame 写入 Thread 对象的哪几个字段？为什么必须在 call Java 方法前调用？
      线索: macroAssembler_x86.cpp:3768 set_last_Java_frame
      代码引证:
        void MacroAssembler::set_last_Java_frame(Register thread, Register sp, Register fp, Register pc) {
          movptr(Address(thread, JavaThread::last_Java_sp_offset()), sp);
          movptr(Address(thread, JavaThread::last_Java_fp_offset()), fp);
          movptr(Address(thread, JavaThread::last_Java_pc_offset()), pc);
        }
      答案方向: 写入 3 个字段：(a) _last_Java_sp — Java 帧的栈顶（用于栈行走的起点）；
      (b) _last_Java_fp — Java 帧的帧指针（用于验证）。sp/fp/pc 三者共同定位"最后一帧"的完整坐标。
      必须在进入 Java 方法前调用——因为进入后 r15_thread 的偏移就变了。更重要的是，写入必须在
      "Java 帧存在"的瞬间——如果方法执行中途才写，GC 会漏扫描此帧的 oops。

  ② 为什么 capture_last_Java_pc 从 _last_Java_sp[-1] 读取 return address？
      线索: javaFrameAnchor_x86.hpp capture_last_Java_pc
      答案方向: 因为 return address 恰好在 caller 帧的 sp 所指位置（高一个字），即 caller 的栈顶。
      push return address 后 rsp -= 8, [rsp] = return address——所以 _last_Java_sp[-1] 就是 return address。
      如果 _last_Java_sp 指向野地址→ 这次读会 segfault→ 可能触发递归 SIGSEGV。
      代码引证:
        inline void JavaFrameAnchor::capture_last_Java_pc() {
          _last_Java_pc = (address)_last_Java_sp[-1];
        }

  ③ make_walkable() 中的 assert(Thread::current() == (Thread*)thread) 防止了什么？
      线索: javaFrameAnchor_x86.hpp make_walkable
      答案方向: 防止在错误的线程上调用 make_walkable。如果当前线程不是锚点所属的线程→ 
      说明调用方线程读的是其他线程的 Anchor——数据不安全。这个 assert 在信号上下文中特别关键——
      如果信号处理器误读了其他线程的 Anchor → 栈行走会产生垃圾结果。
```

### 4.6 ★★★ sender_sp vs unextended_sp——JVM 专有双 sp 设计

```
问题：
  ① 为什么 JVM 需要两个 sp 概念而不是一个？
      线索: frame_x86.hpp 中两个偏移常量, frame_x86.cpp 中的使用场景
      答案方向: 因为解释器帧的表达式栈动态增长——callee 的 current sp 随时间变化。
      "sender 调用 callee 时的 rsp"是一个历史快照——它不会变。所以需要两个 sp：
      - unextended_sp = sender 调用时的 rsp（固定——帧的"原始底部"）
      - sp = 当前线程的实时栈指针（动态——随时间向低地址增长）
      编译帧由于帧大小固定，两个 sp 相等（没有动态扩展）→ 所以编译帧没有 unextended_sp 概念。

  ② C2 编译帧调用解释器方法时，C2 怎么知道解释器帧的 sender_sp 放在哪？
      线索: frame_x86.cpp sender_for_compiled_frame
      答案方向: sender_for_compiled_frame 从 C2 帧的底部（sp + frame_size = 参数区域）找到 return
      address，然后用这个 return address 反查 CodeBlob。如果发现 caller 是解释器帧→ 走
      sender_for_interpreted_frame 分支。C2 不需要区分 sender_sp / unextended_sp——它只知道
      "当前帧结束地址 = sp + frame_size"，这个地址就是下一个帧（callee）的 sender 看到的 sp。
```

### 4.7 ★★ 和 [11-os-layer] 的信号上下文帧布局连接

```
问题：
  ① 信号到达时内核写入 ucontext_t 的 RSP 和 JVM 的 sender_sp 是什么关系？
      线索: 11-01 的 JVM_handle_linux_signal 中 ucontext_t 使用
      答案方向: 信号到达时 CPU 切到内核栈执行信号处理器→ 内核在用户栈上写下 sigframe（包含
      ucontext_t）→ 其中 RSP/RBP/RIP 是信号到达瞬间的用户态值。如果信号发生在 Java 代码中→
      RSP = Java 帧中的某个位置（取决于是否在 prologue/epilogue 中崩溃）→ JVM 从 ucontext_t
      构造初始 frame → 从这个 frame 出发调用 sender() 重建 Java 调用栈。

  ② 为什么 hs_err 的 Register dump（RAX=... R15=...）直接来自 ucontext_t 的 gregs？
      线索: 11-04 hs_err 生成中 os::print_context 的实现
      答案方向: hs_err 的 Register 段是 os::print_context() 从 ucontext_t->uc_mcontext.gregs[]
      直接读取并格式化输出——这些值是真·实时的——信号到达瞬间的完整寄存器快照。所以你在 hs_err
      中看到的 R15=0x0 是真实的崩溃瞬间状态——不是 post-mortem 推测。
```

### 4.8 ★★ 和 [07-thread-lock] + [12-02/12-03] 的连接

```
问题：
  ① [07] 的 Thread 对象 → r15 寄存器的物理绑定如何实现"零开销 Thread* 访问"？
      答案方向: [07] 建立了 JavaThread 的 in-JVM 生命周期。12-01 解释 Thread* 如何成为 CPU 指令的
      第一个操作数——`mov rax, [r15 + offset]` 一条指令读取 Thread 字段，无函数调用，无 TLS 查找。
      对于 safepoint poll（12-02）、set_last_Java_frame（12-03 的 call_stub）、GC 的 oop scan——r15
      是所有 Thread 字段访问的"寄存器捷径"。

  ② 和 12-02 Interpreter 的连接——解释器帧是 caller/callee 帧模型的扩展
      答案方向: 12-02 的 interpreter frame 建立在 12-01 的 caller/callee 帧模型上。12-01 的
      return_addr_offset、link_offset、sender_sp_offset 在 12-02 中直接使用——interpreter frame
      只是增加了额外的固定偏移（bcp_offset、locals_offset、method_offset）。读者必须先理解 12-01
      的"基本帧"，才能理解 12-02 的"扩展帧"。
```

## §五 文章结构（ASCII 图）

```
§〇 源文件清单（跨 cpu/x86 + os_cpu/linux_x86 + runtime，标注每个文件的模块归属和在帧体系中的角色）

§一 ★ 全景：call 指令触发后，栈上发生了什么
  ❓ call 指令的硬件语义
  ❓ prologue 的 3 条指令（push rbp / sub rsp / mov rbp, rsp）
  ❓ 为什么每个 Java 方法调用最终都会变成 call <target>？
  1.1 call 指令的 CPU 级行为——硬件自动 push return address
  1.2 prologue 的逐指令分解——从物理栈到逻辑帧
  1.3 epilogue 的逆操作——为什么 C2 编译方法测试 rax 是否为 exception oop

§二 ★★★ x86_64 JVM 栈帧逐层分解——全文坐标系
  ★ ASCII 图（HIGH ADDRESS → LOW ADDRESS）——逐字节标注每个区域的名字和作用
  ❓ 关键偏移量表——return_addr_offset / link_offset / sender_sp_offset / last_sp_offset
  ❓ 解释器帧 vs 编译帧的结构对比——什么区域有、什么区域没有
  2.1 从 rbp 寻址的固定偏移——所有帧共同部分
  2.2 解释器帧专有区域——locals / monitor slots / expression stack
  2.3 编译帧专有区域——spill slots / oop maps / deopt metadata
  2.4 -XX:-PreserveFramePointer 对帧结构的影响

§三 ★★ JVM 专用寄存器约定——r15_thread / r12_heapbase / rscratch
  ★ 寄存器约定表——ABI 角色 vs JVM 角色 vs 保存者 vs 说明
  ❓ 为什么 r15_thread 是 callee-saved 而不是 caller-saved？
  ❓ r12_heapbase 在 UseCompressedOops 关闭后能做什么？
  3.1 r15_thread 的"透传"——callee-saved 的零开销 Thread* 访问
  3.2 r12_heapbase 的 lea 指令解压——一条指令完成窄化指针→ 64 位地址
  3.3 rscratch1/rscratch2 的"纯临时"性质——为什么信号安全代码尽量不用
  3.4 caller-saved vs callee-saved 的完整分类——所有 16 个 GPR 的表格

§四 ★★★ frame::safe_for_sender + sender 链——栈行走的全过程
  ❓ safe_for_sender 的 4 层检查——为什么 frame_size <= 0 是不安全的？
  ❓ sender_for_interpreted_frame vs sender_for_compiled_frame 的路径分支
  4.1 safe_for_sender 的逐行源码走读——每个检查的保护目的
  4.2 sender() 的主派发逻辑——如何从 pc 判断走哪个 sender 分支
  4.3 RegisterMap 的作用——callee-saved 寄存器在帧链中的"传递"
  4.4 frame_is_complete_at(pc) 的 prologue 中间崩溃保护

§五 ★★ JavaFrameAnchor——Java↔C 交替执行的锚定
  ❓ set_last_Java_frame 为什么写入 3 个字段？
  ❓ capture_last_Java_pc 的 _last_Java_sp[-1] 解引用风险
  5.1 set_last_Java_frame 的指令序列——3 条 mov 完成锚定
  5.2 reset_last_Java_frame——离开 Java 执行前清零锚点
  5.3 make_walkable 的安全保障——线程归属检查

§六 ★★ sender_sp vs unextended_sp——JVM 专有双 sp 设计
  ❓ 为什么需要两个 sp 概念而不是合并？
  ❓ C2 编译帧为什么没有 unextended_sp 概念？
  6.1 解释器帧的表达式栈动态扩展——current sp < unextended_sp
  6.2 编译帧的固定大小——current sp = unextended_sp = sp + frame_size
  6.3 sender_sp 的链式回溯——逐帧重建 caller 坐标

§七 ★ 和 [11-os-layer] + [07-thread-lock] + [12-02] + [12-03] 的阶段连接
  ❓ 信号 ucontext_t 的 RSP → JVM 的 frame::sender() 的完整接力
  ❓ Thread* → r15_thread 的"寄存器固化"——[07] 和 [12-01] 的抽象→ 物理映射
  ❓ 12-02 interpreter frame → 12-01 基本帧的扩展关系
  ❓ 12-03 call_stub → set_last_Java_frame 的帧锚点建立

§八 GDB 验证 + 可证伪断言
```

## §六 写作要求

1. **★ 帧的 ASCII 图是全文的核心交付物**：每个后续文档（02/03）都引用这个图上的偏移。必须标注每个区域的名字、物理偏移（相对于 rbp）、在哪种帧中出现。图必须覆盖 caller frame → return address → callee frame 的完整链条。
2. **★ 寄存器约定表是"理解 PrintAssembly 输出的钥匙"**：必须包含 16 个 GPR 的完整分类——ABI 角色、JVM 角色、保存者（caller/callee）、在哪些场景中被使用。r15_thread 和 r12_heapbase 必须特殊高亮。
3. **★ caller-saved vs callee-saved 的解释是全文的第一块基石**：如果不能理解为什么 r15 必须是 callee-saved，读者就无法理解为什么 JVM 能"免费"获得 Thread* 透传。必须用"假设 r15 是 caller-saved"的替代世界对比来说明决策的必然性。
4. **★ safe_for_sender 的 4 层检查必须逐行深入**：不只是列出条件，而是解释"如果某个条件不满足会导致什么后果"。例如 `frame_size <= 0` → runtime stub 没有标准帧 → sender 无法确定参数区域 → 跳过此帧。
5. **★ sender_sp vs unextended_sp 是区分"理解 JVM"和"只会看代码"的试金石**：大部分 x86 教材只讲一个 sp 概念。本文必须解释"为什么解释器需要第二个 sp"——因为表达式栈动态扩展是一个教材不会覆盖的 JVM 专有问题。
6. **★ 和 [11-os-layer] 的信号上下文帧布局连接是全文的叙事锚点**：每讲到帧的某个字段（如 return address、sender_sp），必须连接 [11-01] 中信号处理器读 ucontext_t 的对应使用。这不是两个独立的概念——是信号处理的"输入"和帧系统的"输出"的对应关系。
7. **★ 不要忘记和 [12-02] + [12-03] 的依赖声明**：12-02 的 interpreter frame 建立在 12-01 上，12-03 的 call_stub 使用 set_last_Java_frame。在 §七 中显式列出这些连接 + 精确的 README 章节引用。

## §七 输出格式

- Markdown 文件，命名为 `01-Frames.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/12-cpu-layer/`
- 元信息头：
  ```
  > **阶段**：[12-cpu-layer]
  > **前置**：[11-os-layer], [07-thread-lock]
  > **依赖本文**：[12-02] Interpreter（解释器帧布局建立在本文帧模型上）, [12-03] Stubs（deopt 帧重建 + call_stub 帧锚点依赖本文帧偏移）
  > **阅读收益**：理解 JVM 在 x86_64 上执行 Java 方法时的完整栈帧布局——从 call 指令的硬件行为到 callee prologue 的逐条指令、从 r15_thread 的寄存器绑定到 sender_sp/unextended_sp 的帧行走机制、从 crash dump 中 R12=0x0/R15=0x0 含义到 PrintAssembly 输出的每一条帧操作指令
  ```

## 禁止行为（≥8，必须具体到"❌ X 因为 Y"）

- ❌ 深入 x86 指令编码格式（ModRM/SIB/REX 前缀字节）——因为这是"汇编器手册"级别的内容，和本文的"帧布局"主线无关
- ❌ 解释 `_start` → `main` → `__libc_start_main` 的 CRT 启动调用链——因为这是 C 运行时初始化的内容，和本文的"Java 方法帧"无关
- ❌ 把 System V ABI 的所有寄存器约定列成全表（包括 xmm0-xmm15 浮点、mxcsr 控制寄存器）——因为本文只关心 JVM 专用的通用寄存器绑定，浮点和向量寄存器属于 [12-02] 和 [12-03] 的代码生成范围
- ❌ 展开 `-XX:-PreserveFramePointer` 对 GDB/perf 的完整影响分析——因为 frame pointer 省略的替代方案（DWARF unwind、eh_frame）是 OS 层和诊断工具的内容，本文只需要说明 JVM 使用 CodeBlob 替代方案即可
- ❌ 解释 Native frame 的完整 DWARF CFI 解析（CIE/FDE/CFA 表达式）——因为这是 ELF 格式的内容，不属于 JVM 帧设计
- ❌ 把 `frame::sender()` 当成"简单的链式遍历"一笔带过——必须区分 3 条路径（interpreted / compiled / native）的派发逻辑，并解释为什么不能合并为一条
- ❌ 忽略 `frame::is_interpreted_frame_valid()` 的验证逻辑——因为它在 safe_for_sender 的 4 层检查中是第 5 层（解释器帧专有验证：method/bcp/locals 指针的有效性），crash 分析中这一层经常触发
- ❌ 不做 "如果 r15=0 崩溃后的调用栈为什么没有 Java frames" 的完整推理——因为这是生产 crash 分析的入口问题，读者需要理解 r15_thread → set_last_Java_frame → _last_Java_sp → 栈行走的完整因果链
- ❌ 把 sender_sp 和 unextended_sp 当成"两个可互换的概念"——必须强调 sender_sp 是 caller 保存的（不会变），unextended_sp 是从帧大小计算的（也不会变但用途不同——用于参数定位），而 current sp 是动态的
- ❌ 不做 `RegisterMap` 在帧行走中作用的解释——因为读者需要知道 "为什么 caller 帧能看到 callee 帧的 r15 值"——答案是 `RegisterMap::set_location(r15, addr)` 记录了 callee-saved 寄存器在栈上的保存位置

## 要求行为（≥8，必须是可验证的交付物）

- ✅ **★ 一张完整的 x86_64 JVM 栈帧 ASCII 图**：从 HIGH ADDRESS 到 LOW ADDRESS，标注 caller frame / return address / saved rbp / saved callee-saved regs / locals / monitor slots / expression stack / spill slots / free space → rsp。每个区域标注"解释器帧专有"或"编译帧专有"
- ✅ **★ 16 个 GPR 的完整寄存器约定表**：列包括 寄存器名 / x86_64 ABI 角色 / JVM 专用角色 / 保存者(Caller/Callee) / 在哪种代码中使用(解释器/编译/stub) / 特殊说明。r15_thread 和 r12_heapbase 行必须加粗高亮
- ✅ **★ 关键偏移量参考表**：从 rbp 寻址的 5+ 个偏移常量（return_addr_offset / link_offset / sender_sp_offset / last_sp_offset / bcp_offset / locals_offset）的值 + 说明 + 在哪个头文件定义
- ✅ **★ frame::safe_for_sender 的 4 层检查逐行走读**：每一层的检查条件 + 被拒绝的帧的危害 + 真实 crash 场景案例
- ✅ **★ sender() 的 3 路径派发表**：interpreted / compiled / native 每条路径的判定条件 + sender 函数名 + 关键实现差异
- ✅ **★ caller-saved vs callee-saved 的"替代世界"对比**：假设 r15 是 caller-saved——每次方法调用的开销对比（push/pop + TLS 查找 vs 零开销）
- ✅ **★ set_last_Java_frame / reset_last_Java_frame 的时序图**：标注在 Java 方法执行前后两个锚点写入的位置 + 如果 r15=0 时崩溃的精确错误链
- ✅ **★ 和 [11-os-layer] §五（信号上下文）+ [12-02] §二（解释器帧）+ [12-03] §一（call_stub）的精确交叉引用表**——每个引用标注到 phase.doc 节号
- ✅ **★ 生产 crash 分析 checklist**：R15=0x0 → Thread* 丢失的完整后果链 + R12=0x0 → 如何判断是零基址还是 heapbase 丢失 + RSP/RBP 的值如何定位当前帧的边界
- ✅ **★ GDB 验证 safe_for_sender 的每一层检查**：设置 4 个不同断点（如 prologue 中间、epilogue 中间、野 sp、野 fp），分别触发 safe_for_sender 的不同返回路径

## GDB 可证伪断言（≥10，精确到断点行号）

1. **断言：call 指令执行后 [rsp] 存储 return address**
   验证：`br frame_x86.cpp:488`（sender 入口）→ 在 Java 方法中设断点 → `x/gx $rsp` → 验证值指向 caller 的 call 下一条指令
   预期：`x/gx $rsp` 的值落在 caller 的 CodeBlob 范围内

2. **断言：prologue 的 push rbp 使 [rbp] = caller's rbp**
   验证：在 `sender_for_compiled_frame` 入口 → `p *((intptr_t**)$rbp)` → 值 = caller 的 rbp → 继续回溯形成完整 rbp 链
   预期：rbp 链可连续回溯 3+ 帧

3. **断言：r15 在整个 Java 方法调用链中保持不变**
   验证：设置 `br` 在 frame::sender 的 3 次回调 → 每次 `p $r15` → 值相同
   预期：3 次 frame::sender 调用中 `p $r15` 返回相同 Thread* 对象地址

4. **断言：解释器帧的 interpreter_frame_sender_sp_offset = -1 word**
   验证：进入解释器执行某个方法 → `p/x *(intptr_t**)($rbp - 8)` → 值 = caller 的原始 sp
   预期：`p/x *(intptr_t**)($rbp - 8)` = caller frame 的 sp + caller frame_size

5. **断言：解释器帧的 interpreter_frame_method_offset 存储 Method* 指针**
   验证：进入解释器帧 → `p/x *(intptr_t**)($rbp - 24)`（method_offset = -3 words）→ 值指向 Method 对象
   预期：反引用该地址→ 能看到 Klass::_java_mirror 等 Method 字段

6. **断言：safe_for_sender 对 frame_size <= 0 的 CodeBlob 返回 false**
   验证：找到一个 runtime stub（如 call_stub，frame_size = 0）→ `p _cb->frame_size()` → 0 → `p frame::safe_for_sender(t)` → false
   预期：safe_for_sender 返回 false 且栈行走跳过此帧

7. **断言：frame_is_complete_at(pc) 在 prologue 中间返回 false**
   验证：在 C1 编译方法的 prologue 中（push rbp 后、mov rbp rsp 前）设断点 → `p _pc` → 是在 push 和 mov 之间 → `p _cb->is_frame_complete_at(_pc)` → false
   预期：is_frame_complete_at 返回 false，safe_for_sender 的断言触发

8. **断言：在 -XX:+PreserveFramePointer 下 sender_for_compiled_frame 的 sender_sp = sp + frame_size**
   验证：进入一个 C1 编译的方法 → `p $rsp` + `p _cb->frame_size()` × 8 → 计算预期 sender_sp → 断点在 sender_for_compiled_frame return → 对比计算值和实际 sender_sp
   预期：sender_sp = sp + frame_size × wordSize（8 字节）

9. **断言：set_last_Java_frame 写入 r15_thread 的 3 个偏移**
   验证：在 call_stub 的 set_last_Java_frame 之后设断点（gdb 中定位到 macroAssembler_x86.cpp:3768 生成的三条 mov）→ `p/x *(intptr_t**)($r15 + 48)` → Thread::last_Java_sp → 等于当前 rsp
   预期：`[r15 + 48] = rsp`, `[r15 + 56] = rbp`, `[r15 + 64] = return pc`

10. **断言：reset_last_Java_frame 清零 Thread 的字段**
    验证：在 Java 方法执行完成后、reset_last_Java_frame 之后设断点 → `p/x *(intptr_t**)($r15 + 48)` → 0
    预期：`[r15 + 48] = 0`, `[r15 + 56] = 0`（帧锚点已清除）

11. **断言：解释器帧的 unextended_sp != current_sp（因为表达式栈扩展）**
    验证：在解释器执行 `dup` 或 `iadd` 等压栈字节码后 → `p frame::unextended_sp()` → 值 > `p frame::sp()` → 计算差值等于当前的表达式栈深度 × 字长
    预期：unextended_sp - sp = expression_stack_depth × wordSize

12. **断言：RegisterMap 记录 callee-saved 寄存器位置——r15 在解释器帧中始终在 loc 中**
    验证：从解释器方法入口到执行 10 个字节码 → `p map->location(r15)` → 返回 r15 在帧中的保存偏移 → `p/x *(intptr_t**)($rbp - 偏移)` → 等于当前 r15
    预期：RegisterMap 中 r15 的保存地址 = rbp - offset，值 = Thread*
