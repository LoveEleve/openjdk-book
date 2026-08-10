# 12 — CPU 平台层（x86_64 JVM 指令层）

> 源码索引：`source_index/12-os-cpu.md`（cpu/x86 112文件 + os_cpu 2文件）
> 插桩覆盖：cpu/x86 5cpp + os_cpu 2cpp，6 探针
> **前置阶段**：[11-os-layer], [10-services-diag], [09-native-interface], [08-safepoint], [07-thread-lock], [06-gc]
> **阅读收益**：看懂 JVM 如何在 x86_64 CPU 上执行每一字节的 Java 代码；理解 `-XX:+PrintAssembly` 输出中每一个指令后缀的含义；知道 crash dump 里 `r12=0x0` 为什么意味着 Thread 指针丢失 → segfault；理解 safepoint poll 为什么是 `testl` 而不是 `cmp`；掌握 CPUID 探测如何在没有文档的情况下安全识别 SSE/AVX 指令集

---

## 一、阶段定位 — 这是 12 层之巅，JVM 的"硬件执行面"

前 11 个阶段逐层向上构建抽象：Class 文件 → 对象布局 → 方法链接 → 字节码解释 → GC 回收 → 线程调度 → Safepoint 协调 → JNI 穿越 → Attach 诊断 → OS 信号/线程/内存。**每一层最终都要落到 CPU 指令上执行**。本阶段是终点——所有抽象在 CPU 层面被"坍缩"为 `mov`、`jmp`、`call`、`testl` 序列。

如果你把 JVM 比作一个编译器+运行时，前 11 阶段是"IR 到 IR 的变换"（从 class 到 oop、从 oop 到 GC 标记、从字节码到模板），**本阶段是 IR 到机器码的终极降级**。这是唯一一个"你说什么 CPU 就执行什么"的层——没有抽象可以再帮你兜底。

### 本阶段和 11-os-layer 形成"软/硬对称"的另一面

- 11 解释"OS 如何把资源给 JVM"（信号/线程/内存的系统调用面）
- 12 解释"JVM 如何在拿到资源后生成 CPU 指令"（寄存器/栈帧/指令序列的物理执行面）
- 11 的 `JVM_handle_linux_signal` 分发信号 → 12 的 stub 代码是最终处理信号的**机器码**
- 11 的 `os::create_thread` 创建线程 → 12 的 `r15_thread` 寄存器是线程在 CPU 上的**常驻代理**

如果说 11 是 OS 的"系统调用手册"，12 就是 CPU 的"指令集手册"——但它只解释 JVM 用到的指令，不是 Intel 手册的翻译。

### ★ 生产场景接地

每个文档从读者在凌晨 3 点被报警唤醒时的体验出发：

| 文档 | 你经历了什么 | 本文回答什么 |
|------|------------|-------------|
| **01-Frames** | crash dump 里 `RSP=0x00007f... RBP=0x00007f...` 但你不知道 `r12` 为什么是 `0x0` | x86_64 栈帧从 Caller 到 Callee 的逐字节布局；`r12` 为什么必须是 Thread*——丢失它就是丢失整个 JVM 的线程上下文 |
| **02-Interpreter** | `-XX:+PrintAssembly` 里每个字节码后面都跟着一长串 `mov/add/cmp/jmp` 但你不知道这些指令是从哪个文件生成的 | `TemplateTable` 如何把 200+ 字节码翻译成 x86_64 指令模板；`templateInterpreterGenerator` 如何生成方法入口/返回路径；safepoint poll 的 `testl` 指令为什么出现在每个 backedge 前 |
| **03-Stubs** | `V [libjvm.so+0x...]` 的崩溃栈里出现了 `deopt_blob` 但你不懂"去优化"在 CPU 上到底做了什么 | Exception stub、Deoptimization stub、Safepoint poll stub、Call stub 的完整机器码生成流程；deopt 为什么比正常方法调用贵 100 倍 |
| **04-CPUID** | 同一份 JVM 二进制在旧服务器上跑得好好，在新服务器上 `SIGILL` (非法指令) | `VM_Version::initialize()` 如何用 CPUID 指令探测 CPU 特性；`UseSSE`、`UseAVX` 等 flag 如何从 CPUID 的 bit 位自动设置——以及为什么你的旧 CPU 不支持的指令集不会被生成 |

### ★ 本文不是 x86 汇编教程

以下误解必须在每篇文档开头破除：

- **01** 不是 x86_64 System V ABI 参考手册——不讲 `_start` 到 `main` 的 CRT 调用链、不讲 `__attribute__((ms_abi))` 的 Windows 兼容性。本文只关心 **JVM 的栈帧布局**——return address 下方为什么是 saved rbp、locals、monitor slots、expression stack，以及 sender_sp / unextended_sp 的 JVM 专有概念。
- **02** 不是 x86 汇编语言教程——不讲 `REX.W` 前缀的含义、不讲 ModRM 字节的编码格式、不讲 `LOCK` 前缀的总线锁语义。本文只关心 **TemplateTable 如何为每个字节码生成 x86_64 指令序列**——`iload` 对应 `mov` 读局部变量表，`iadd` 对应 `add` 操作数栈顶，每个字节码 ~5-50 条指令。
- **03** 不是 stub 函数实现教程——不讲 `__attribute__((naked))` 的编译器差异、不讲手工汇编的技巧。本文只关心 **JVM 运行时如何生成异常分发、去优化、safepoint 处理的机器码片段**——这些片段不在 C++ 编译器输出中，而是 JVM 在启动时用 `MacroAssembler` 动态生成的。
- **04** 不是 Intel CPUID 指令集参考——不讲 CPUID leaf 0x80000001 的 EDX bit 29 是"Long Mode"、不讲 leaf 0x07 sub-leaf 0 的 EBX 映射。本文只关心 **JVM 怎么调 CPUID 以及为什么调**——`VM_Version::initialize()` 中 20+ 次 CPUID 调用各探测什么特性、结果如何影响 `UseSSE`/`UseAVX`/`UseBMI` 等 flag。

---

## 二、文档计划（4篇，带依赖链）

```
                         ┌──────── 前置依赖 ────────┐
                         │ 11-os-layer (信号/线程)   │
                         │ 10-services-diag          │
                         │ 09-native-interface       │
                         │ 08-safepoint              │
                         │ 07-thread-lock            │
                         │ 06-gc                     │
                         └──────────┬───────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         ▼                          ▼                          ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ 01-Frames        │    │ 04-CPUID         │    │ 02-Interpreter   │
│ x86_64 栈帧布局  │    │ CPU 特性检测     │◄───│ 模板解释器机器码 │
│ sender_sp / fp   │    │ VM_Version init  │    │ TemplateTable    │
│ locals / monitor │    │ 独立于其他文档   │    │ safepoint poll   │
└────────┬─────────┘    └──────────────────┘    └────────┬─────────┘
         │                                               │
         │                    ┌──────────────────────────┘
         │                    ▼
         │  ┌──────────────────────────────────────┐
         └─►│ 03-Stubs                              │
            │ 异常分发 / 去优化 / safepoint / call │
            │ SharedRuntime::generate_deopt_blob()  │
            │ StubGenerator::generate_call_stub()   │
            │ MacroAssembler::safepoint_poll()      │
            └──────────────────────────────────────┘
```

### 写作顺序（按依赖链）

```
01 → 02 / 04 (并行) → 03
```

- **01 必须先写**：栈帧布局是所有后续文档的物理基础。02 的 interpreter frame 建立在 01 的 caller/callee 帧模型上；03 的 deopt stub 需要理解帧布局才能重建栈帧；所有文档讨论的"局部变量表""操作数栈"都是帧内部的区域。
- **04 可与 02 并行**：CPUID 探测在 VM 启动最早期完成，不依赖帧布局或解释器。但它是理解 02/03 中"为什么生成 SSE 版本而非 x87 版本"的前提。
- **02 依赖 01**（解释器帧是 caller/callee 模型的扩展），**02 依赖 04**（解释器生成的指令是否包含 SSE 指令取决于 CPU 特性）
- **03 依赖 01**（需要理解帧布局才能生成 deopt 的帧重建代码）和 **02**（deopt 需要理解解释器帧格式才能把编译帧"解包"为解释器帧）

---

## 三、逐篇详述

### [01] Frames — x86_64 JVM 栈帧布局

**核心问题**：JVM 在 x86_64 上执行 Java 方法时，CPU 栈上到底长什么样？Caller 的 `call` 指令压入 return address 后，Callee 的 prologue 如何布置 saved rbp、locals、monitor slots、expression stack？`sender_sp` vs `unextended_sp` 的区别是什么——为什么 C2 编译帧没有 `unextended_sp` 概念但解释器有？

**为什么放在第一**：栈帧是所有后续文档的坐标系统。02 的 interpreter frame 是 01 的扩展；03 的 deoptimization 本质是"编译帧 → 解释器帧"的帧布局转换；crash dump 里的 `RSP=... RBP=...` 需要 01 的坐标系才能还原调用链。不理解帧 = 看不懂任何 `-XX:+PrintAssembly` 输出。

**覆盖内容**：

```
§〇 源文件清单
  - cpu/x86/frame_x86.cpp (frame::safe_for_sender, frame::sender, frame::is_interpreted_frame)
  - cpu/x86/frame_x86.hpp (栈帧偏移常量: interpreter_frame_sender_sp_offset, link_offset, return_addr_offset)
  - cpu/x86/frame_x86.inline.hpp (内联访问器)
  - cpu/x86/registerMap_x86.hpp (RegisterMap 用于栈行走时定位 saved registers)
  - cpu/x86/javaFrameAnchor_x86.hpp (JavaFrameAnchor——Java→C 调用的帧锚点)
  - os_cpu/linux_x86/frame_linux_x86.cpp (sender_for_compiled_frame, frame::sender_for_native_frame)

§一 ★ 全景：`call` 指令触发后，栈上发生了什么
  ❓ 为什么 Java 方法调用（`invokevirtual`）最终会变成 `call 0x7f...`？
  → C1/C2 编译后的方法调用与 C 调用完全一致：caller 设置参数寄存器（C calling convention: rdi/rsi/rdx/rcx/r8/r9），执行 `call <target>`。CPU 硬件自动将 `RIP+instruction_length` 压入栈（这就是 return address，指向 call 的下一条指令）。然后 callee 的 prologue 通过 `push rbp; mov rbp, rsp` 建立帧指针链。
  ❓ 每个 Java 方法调用都有一个 CALL 指令吗？
  → 不一定。解释器的 invokevirtual 通过 `TemplateTable::invokevirtual` 生成指令序列，最终通过 `call_VM` 调用 Runtime，期间会多次 `push return_addr; jmp target`。编译代码中确实每个 invoke 对应一个 `call` 到编译后入口。

> **★ 你需要知道的：caller-saved vs callee-saved 寄存器**
>
> 当函数 A 调用函数 B 时，寄存器是共享资源——只有一个 rax，只有一个 rbx。"谁负责在调用前后保护寄存器里的值"是约定的核心：
>
> - **caller-saved**（调用者保存）：A 在调用 B 前如果某个寄存器的值之后还要用，A 自己先 push 到栈上。B 可以随意破坏这些寄存器（rax、rcx、rdx、rsi、rdi、r8-r11）而不保存。为什么这么设计？因为 A 知道自己还"活"着什么值，只在必要时才保存；B 不知道 A 的状态，如果强制 B 保存所有寄存器会浪费指令。
> - **callee-saved**（被调者保存）：B 如果要用这些寄存器（rbx、rbp、r12-r15），必须先 push 旧值到栈、返回前 pop 恢复。A 不需要保存这些——它信任 B 不会破坏。为什么这么设计？因为 call/ret 非常频繁，caller-saved 让 A 有可能避免在每次 call 前都保存（如果在 A 内某个寄存器的值已经"死"了就不需要保存），callee-saved 让"跨越多个 call 的长寿变量"（如循环变量、基址指针）不需要在每个 call 点反复保存/恢复。
>
> **JVM 为什么把 r15 永久绑定到 Thread\***：因为 r15 是 callee-saved——Java 方法的机器码不碰 r15（由 JVM 保证），所以 Thread* 自动在整条调用链上"透传"——caller 的 r15 到 callee 中不变，callee 再调用下个 callee 也不变，无限深度调用链全都不需要重新加载 Thread*。如果 r15 是 caller-saved，每个方法入口都要重新从 TLS 加载 Thread*，每次方法调用多 50+ cycles。这不是"多了一个优化"——这是"把热路径从每次调用 50 cycles 压到 0 cycles"的架构决策。
>
> **★ 你需要知道的：spill slot（溢出槽）**
>
> x86_64 有 16 个通用寄存器，但其中 rsp/rbp 是栈管理、r15_thread/r12_heapbase 被 JVM 抢占、r10/r11 是 scratch——实际留给编译器自由分配的只有 ~10 个。当一个方法有 20 个局部变量、10 个中间计算结果时，编译器物理寄存器不够了——必须把某些值临时写入栈上预留的位置，即 spill slot。
>
> 典型的 spill 操作：`mov [rbp - 8], eax`（把 eax 的值"溢出"到栈上），之后 eax 可以用于其他计算。需要时再 `mov eax, [rbp - 8]`（从栈上"装回"）。spill 的成本是内存读写（~200 cycles），远比寄存器操作（~1 cycle）贵——所以寄存器分配是编译器优化的核心。C2 编译帧中的 spill slot 区域在帧底部（靠近 rsp），为所有"可能溢出的虚拟寄存器"预留固定偏移，C2 的寄存器分配器（Chaitin-Briggs 图着色算法）的目标就是最小化 spill 次数。
>
> **★ 你需要知道的：帧锚点（frame anchor）—— sender_sp / last_Java_sp 机制**
>
> JVM 中 Java 代码和 C++ 代码交替执行。当执行从 Java 进入 C++（如 GC、Runtime 函数），C++ 端的栈行走器需要知道"Java 最后一帧的边界在哪里"——这就是帧锚点的作用。两层机制：
>
> 1. **sender_sp**（帧间锚点）：每个 Java 帧在构造时记录 caller 的 sp（即 callee 入口时的 rsp）。值保存在帧的固定偏移处（`interpreter_frame_sender_sp_offset`）。当 `frame::sender()` 需要重建 caller 帧时，从这个偏移读取 caller 的 sp，然后用 return address 反查 caller 的 CodeBlob → 得到 caller 帧的完整布局。这形成了一条从当前帧向高地址"链式回溯"的帧链表。
> 2. **last_Java_sp**（Java↔C 锚点）：当 Java 代码调用 C++ Runtime 函数时，`set_last_Java_frame(r15_thread, rsp, rbp, return_pc)` 把当前的 sp/fp/pc 写入 `JavaThread::_last_Java_sp/fp/pc`（三个字段在 Thread 对象中）。C++ 端的栈行走器从这些字段出发，开始逐帧遍历 Java 帧。crash dump 里 `r15=0x0` 意味着 Thread* 丢失 → `_last_Java_sp` 无法被写入 → 栈行走器找不到 Java 帧 → hs_err 里没有 Java 调用栈。

§二 ★★★ x86_64 JVM 栈帧逐层分解（ASCII 图——必须记住，之后所有文档都用这个坐标）
  ```
        HIGH ADDRESS (栈底)
  ┌──────────────────────────────┐
  │  Caller Frame                │
  │  ┌──────────────────────────┐│
  │  │ ... locals / exprs ...   ││  ← caller's rsp 在调用前的位置
  │  │ 参数 7+ (栈上传递)       ││  ← 前6个参数在寄存器，第7个开始在栈上
  │  │ 参数 slot N              ││
  │  ├──────────────────────────┤│
  │  │ Return Address           ││  ← `call` 压入，指向 caller 的下一条指令
  │  └──────────────────────────┘│  ← 此时 rsp 指向这里 (callee 的入口 rsp)
  ├──────────────────────────────┤
  │  Callee Frame                 │
  │  ┌──────────────────────────┐│
  │  │ [saved rbp]               ││  ← `push rbp` (可选，-XX:-PreserveFramePointer 会省略)
  │  │ [saved r12/r13/r14/...]   ││  ← callee-saved 寄存器 (callee 负责保存/恢复)
  │  │ [locals 局部变量]         ││  ← Java 方法局部变量 (包括 this in slot 0)
  │  │ [monitor slots]           ││  ← synchronized 方法的锁记录 (BasicObjectLock*)
  │  │ [expression stack 顶]     ││  ← 操作数栈 (解释器使用，编译帧可能复用为 spill slots)
  │  │ [expression stack 底]     ││
  │  ├──────────────────────────┤│
  │  │ (空闲空间)                ││  ← 编译帧预留的 spill/callee-save 区域
  │  └──────────────────────────┘│  ← rsp 指向此处 (帧底)
        LOW ADDRESS (栈顶)
  ```
  
  关键偏移量（从 rbp/FP 寻址）：
  - `return_addr_offset` = +1 word ← call 压入的返回地址，在 rbp 上方
  - `link_offset` = 0 word ← saved rbp 的地址（在 rbp 指向的内存中）
  - `interpreter_frame_sender_sp_offset` = -1 word ← 解释器帧专有：caller 的 sp
  - `interpreter_frame_last_sp_offset` = -2 word ← 解释器帧专有：表达式栈底

  ❓ 编译帧为什么没有 "monitor slots" 和 "expression stack"？
  → 编译帧（C1/C2）将 Java 变量映射到寄存器或固定 spill slot。synchronized 的锁记录内联在 prologue/epilogue 的代码中，不占用固定帧槽。操作数栈在编译时完全消除——所有中间值都在寄存器或 spill slot 中。

§三 ★ 调用约定（x86_64 System V ABI，JVM 的专用化）
  
  寄存器约定表（JVM 专用——这是理解 `-XX:+PrintAssembly` 输出的钥匙）：
  
  | 寄存器 | x86_64 ABI 角色 | JVM 专用角色 | 保存者 | 说明 |
  |--------|-----------------|-------------|--------|------|
  | rax | 返回值 | 返回值 + 临时 | Caller | 方法返回的 int/float/long/oop |
  | rcx | 参数4 (C) | c_rarg0 (Windows) | Caller | 系统调用也是参数1 |
  | rdx | 参数3 (C) | c_rarg1 (Windows) | Caller | |
  | rbx | Callee-saved | Callee-saved | Callee | C1/C2 常用作本地变量缓存 |
  | **rsp** | **栈指针** | **栈指针** | — | 永远指向当前帧的最低地址 |
  | **rbp** | **帧指针（可选）** | **帧指针** | Callee | push rbp; mov rbp, rsp |
  | rsi | 参数2 (C) | c_rarg1 (Linux) | Caller | |
  | rdi | 参数1 (C) | c_rarg0 (Linux) | Caller | |
  | r8 | 参数5 (C) | c_rarg2 (Linux) / rscratch1? | Caller | |
  | r9 | 参数6 (C) | c_rarg3 (Linux) | Caller | |
  | **r10** | 临时 | **rscratch1** | Caller | MacroAssembler 内部临时寄存器 |
  | **r11** | 临时 | **rscratch2** | Caller | MacroAssembler 内部临时寄存器 |
  | **r12** | Callee-saved | **r12_heapbase** ★ | Callee | **压缩 OOPs 基址**（UseCompressedOops 时使用） |
  | r13 | Callee-saved | Callee-saved | Callee | C1/C2 可用 |
  | r14 | Callee-saved | Callee-saved | Callee | C1/C2 可用 |
  | **r15** | Callee-saved | **r15_thread** ★ | Callee | **永远指向当前 JavaThread\*** |
  
  ★ **r15_thread = JavaThread\***：这是 JVM 在 x86_64 上最重要的性能决策。正常 x86 ABI 中 r15 是通用 callee-saved 寄存器。JVM 把它永久绑定到当前线程的 JavaThread 对象指针——这意味着任何需要访问 `thread->polling_page`、`thread->safepoint_state`、`thread->last_Java_sp` 的代码都只需一条 `mov` 指令（`mov rax, [r15 + offset]`），不需要先 `call pthread_getspecific` 或读 TLS。在 x86_32 上只有 8 个寄存器，JVM 无法奢侈地独占一个——TLS 是唯一选择。64 位上的 16 个 GPR 让这种"寄存器常驻"策略可行。
  
  ★ **r12_heapbase**：当启用压缩 OOPs 时，r12 保存堆的基址（narrow klass 的解压基址）。对象指针的编码/解码只需要一条 `add` 指令：`lea rax, [r12 + narrow_oop * 8]`（shift-and-add 一条指令完成解压）。如果 `UseCompressedOops` 关闭，r12 作为普通 callee-saved 寄存器被 C1/C2 使用。
  
  ❓ 为什么 r15_thread 是 callee-saved 而不是 caller-saved？
  → 因为 r15_thread 的值在 Java 代码执行的整个生命周期中不变。如果它是 caller-saved，每个方法入口都要重新从 TLS 加载 Thread* → 每次方法调用的开销增加。作为 callee-saved，只要方法不修改 r15（JVM 保证 Java 代码不碰 r15），它的值自动在调用链中传播——零开销。

§四 ★★ sender_sp vs unextended_sp — JVM 专有概念
  ❓ sender_sp 和 unextended_sp 有什么区别？
  → `sender_sp` = callee 入口时的 rsp（即 return address 被 push 后 rsp 的值）。在解释器中，由于局部变量在帧内部扩展（通过 `sub rsp, N`），callee 的当前 sp 不等于 sender 看到的 sp。`unextended_sp` 记录 sender 的原始 sp（即 callee 参数列表的起始地址）。
  ❓ 为什么需要两个 sp 概念？
  → 栈行走（stack walking）时需要一个"锚点"来定位 caller 的帧。对于编译帧，`sender_sp = unextended_sp = sp + frame_size`。对于解释器帧，局部变量的动态扩展使当前 sp 低于入口 sp，所以 `interpreter_frame_sender_sp_offset` 专门保存了这个原始值。
  ❓ `-XX:-PreserveFramePointer` 关闭 rbp 后栈怎么行走？
  → 关闭 rbp 后，JVM 依赖 CodeBlob 中存储的 `frame_size` 和 `oop_maps` 来做栈行走。每个编译后方法（nmethod）都有一个固定大小的帧，`sender_sp = current_sp + nm->frame_size()`，不需要 rbp 链。但解释器帧仍然需要 rbp 来定位 method/bcp/locals——所以即使 `-XX:-PreserveFramePointer`，解释器仍然使用 rbp。

§五 ★ 和 11-os-layer 的连接：信号上下文的帧布局
  11-01 的 `JVM_handle_linux_signal` 在信号到达时从 `ucontext_t` 中读取寄存器。此时 `uc_mcontext.gregs[REG_RIP]` 是崩溃指令地址，`uc_mcontext.gregs[REG_RSP]` 是崩溃时的栈顶。要重建调用链，需要从 RSP 出发逐帧解码——这就是本文的帧布局知识。11-04 的 hs_err 输出 `RAX=... RBX=... R12=... R15=...`，理解 r12=0x0 = 丢失 heapbase、r15=0x0 = 丢失 Thread* 是诊断 JVM 崩溃的第一步。

§六 ★ 和 07-thread-lock 的连接：Thread 对象 → r15 寄存器
  07 建立了 JavaThread 的 in-JVM 生命周期。本文解释 Thread* 如何被"固化"到 CPU 硬件中——`r15_thread` 是 Thread 在指令级别的代理。每当 JVM 生成的代码需要读取 `thread->safepoint_state`、`thread->last_Java_sp` 或 `thread->polling_page`，它用 `mov reg, [r15 + offset]`——不需要函数调用，不需要查 TLS，一条指令完成。这是一个编译器级别的优化：把"最热"的指针永久钉在寄存器上。
```

**关键文件**（跨 cpu/x86 + os_cpu/linux_x86 + runtime）：

| 文件 | 完整路径 | 模块 | 核心函数/类 | 本文角色 |
|------|---------|------|-----------|---------|
| `frame_x86.cpp` | `src/hotspot/cpu/x86/frame_x86.cpp` | cpu/x86 | `frame::safe_for_sender`(:53), `frame::sender`(:488), `frame::sender_for_interpreted_frame`(:431), `sender_for_compiled_frame`(:451) | ★★★ 帧布局核心——所有栈帧的构建和行走 |
| `frame_x86.hpp` | `src/hotspot/cpu/x86/frame_x86.hpp` | cpu/x86 | 帧偏移常量, `frame::sender_sp_offset` | 帧偏移常量定义 |
| `register_x86.hpp` | `src/hotspot/cpu/x86/register_x86.hpp` | cpu/x86 | `RegisterImpl`, `r12_heapbase`, `r15_thread`, `rscratch1`, `rscratch2` | ★ 寄存器声明——JVM 专用寄存器别名 |
| `assembler_x86.hpp` | `src/hotspot/cpu/x86/assembler_x86.hpp` | cpu/x86 | `REGISTER_DECLARATION(r15_thread, r15)`, `REGISTER_DECLARATION(r12_heapbase, r12)`, `c_rarg0..3` | ★ 寄存器别名 + C 调用约定寄存器 |
| `javaFrameAnchor_x86.hpp` | `src/hotspot/cpu/x86/javaFrameAnchor_x86.hpp` | cpu/x86 | `JavaFrameAnchor` | Java→C 帧锚点 |
| `registerMap_x86.hpp` | `src/hotspot/cpu/x86/registerMap_x86.hpp` | cpu/x86 | `RegisterMap` | 栈行走时的寄存器定位映射 |
| `frame_linux_x86.cpp` | `src/hotspot/os_cpu/linux_x86/frame_linux_x86.cpp` | os_cpu/linux_x86 | `frame::sender` OS 派发 | OS 层帧发送器 |

**前置**：[11-01]（信号上下文理解帧布局的用途）, [07-thread-lock]（Thread* 的来源——r15_thread 指向什么）

**需要为新读者解释的概念**（针对零 x86 知识的 Java 工程师）：
- **x86 vs x86_64**：x86（32 位模式）只有 8 个通用寄存器（eax/ecx/edx/ebx/esp/ebp/esi/edi），x86_64（64 位 AMD64 扩展）增加到 16 个（rax/rcx/rdx/rbx/rsp/rbp/rsi/rdi + r8-r15），且寄存器宽度从 32 位扩展到 64 位
- **System V ABI**：Linux x86_64 上的标准调用约定。定义了参数怎么传（前 6 个整型在 rdi/rsi/rdx/rcx/r8/r9，浮点在 xmm0-xmm7）、返回值在 rax/xmm0、哪些寄存器 callee 必须保存（rbx/rbp/r12-r15）、哪些可以随意破坏（rax/rcx/rdx/rsi/rdi/r8-r11）
- **寄存器 vs 内存**：寄存器是 CPU 内部的"零延迟变量"（~1 cycle 访问），内存需要走总线（~200 cycles）。编译器的核心工作就是把"热"变量留在寄存器里。JVM 的 r15_thread 就是把最热的指针"钉"在寄存器上
- **caller-saved vs callee-saved**：caller-saved = caller 在调用前后不保证寄存器值不变（callee 可以随意破坏）；callee-saved = callee 如果要用必须先 push 到栈上、返回前 pop 恢复。为什么这样设计？caller 可能把"活"变量放在 caller-saved 寄存器中但知道 callee 会破坏它，所以在调用前自己保存；callee 不知道 caller 在 callee-saved 中放了什么，所以如果要修改必须先保存
- **压缩 OOPs（Compressed OOPs）**：64 位指针太浪费（堆通常 <32GB），JVM 把 64 位对象指针压缩为 32 位。解压时用基址 + offset 的方式：`actual_address = heap_base + (compressed_oop << 3)`。r12 保存 `heap_base`（如果是零基址则不用），`lea` 指令一条完成

---

### [02] Interpreter — 模板解释器 x86 代码生成

**核心问题**：Java 字节码最终怎么变成 x86_64 机器码？`TemplateTable` 如何把 200+ 字节码（`iload`/`iadd`/`getfield`/`invokevirtual`等）映射为机器码模板？每个字节码的指令序列从哪里开始生成、在哪个文件中？safepoint poll 的 `testl` 指令为什么插在每个 backedge（循环回边）和方法返回之前？

**为什么重要**：JVM 启动时用解释器执行 Java 代码（直到 C1/C2 编译热点方法）。解释器的每个字节码处理路径是 C1/C2 的"语义参考实现"——理解解释器的机器码输出 = 理解 C1/C2 在优化什么。此外，`-XX:+PrintAssembly` 输出中解释器部分最规则、最可预测，是学习 x86_64 JVM 指令的最佳起点。

**覆盖内容**：

```
§〇 源文件清单
  - cpu/x86/templateInterpreterGenerator_x86.cpp (方法入口/返回/deopt 入口的代码生成)
  - cpu/x86/templateInterpreterGenerator_x86_64.cpp (64 位专用：参数处理、慢速签名处理器)
  - cpu/x86/templateTable_x86.cpp (★ 200+ 字节码的指令模板生成——本文核心)
  - cpu/x86/interp_masm_x86.cpp (解释器专用的 MacroAssembler 扩展)
  - cpu/x86/interp_masm_x86.hpp (dispatch_next, dispatch_via, notify_method_entry)
  - cpu/x86/abstractInterpreter_x86.cpp (抽象解释器参数: stackElementSize 等)
  - share/interpreter/templateInterpreterGenerator.hpp (跨平台基类)
  - share/interpreter/templateTable.hpp (跨平台基类)

§一 ★ 全景：从字节码到机器码的生成链
  ❓ 解释器的机器码是在 JVM 编译时（C++ 编译）还是运行时动态生成的？
  → 运行时动态生成。JVM 启动时，`TemplateInterpreterGenerator::generate_all()` 遍历所有字节码，为每个字节码调用 `TemplateTable::generate()` → 在 CodeBuffer 中不断追加机器码。最终所有字节码的机器码组成一个连续的 BufferBlob（Interpreter codelet）——`Interpreter::code()` 返回其基址。
  ❓ 为什么在运行时生成而不是编译时写死？
  → (1) 根据 CPU 特性（SSE/AVX）生成不同的指令版本——同一个字节码在旧 CPU 上生成 x87 浮点指令，在新 CPU 上生成 SSE 指令
  (2) 根据 JVM flag（-XX:+ProfileInterpreter, -XX:+CountBytecodes）条件编译不同路径
   (3) 根据 UseCompressedOops 等全局设置确定对象操作的指令宽度（32-bit vs 64-bit load）

> **★ 你需要知道的：scratch 寄存器（rscratch1=r10, rscratch2=r11）**
>
> JVM 在生成汇编代码时经常需要临时寄存器——比如"把立即数 0x42 搬到内存 [rbp - 8]，但 x86 的 mov 不允许两个操作数都是内存，必须先用一个寄存器中转"。如果每次都 push/pop 一个通用寄存器来"借"临时空间，指令开销会翻倍。这就是 scratch 寄存器的存在理由——r10 和 r11 被 JVM 指定为"内部临时寄存器"（rscratch1、rscratch2），MacroAssembler 的辅助函数（如 `movptr`、`load_address`、`increment` 的复杂寻址模式）可以随意使用它们而不保存/恢复。
>
> 代价是什么？scratch 寄存器是 **caller-saved**，意味着如果当前代码段在两次使用 scratch 之间调用了 Runtime 函数，那个函数也可能使用 scratch 并破坏其内容——所以必须在调用前把自己用 scratch 保存的值搬到安全的 callee-saved 寄存器或栈上。更大的隐患是中断：如果信号/中断在 mid-scratch-use 时到达（比如刚用 rscratch1 临时加载了一个指针还没来得及用完），信号处理器可能把 rscratch1 当成"存放了有用内容的寄存器"去读取——读到的是垃圾。这就是为什么信号安全的代码路径（如异常处理 stub）尽量不用 scratch 寄存器。
>
> 在 01-Frames 的寄存器表中，r10 和 r11 在 x86_64 ABI 中是 caller-saved（通用临时寄存器），JVM 将其重命名为 rscratch1/rscratch2 只是显式化了它们的"纯临时"性质——警告所有代码生成器：这俩寄存器不能跨 Runtime 调用保存值。
>
> **★ 你需要知道的：dispatch table（字节码分发跳转表）**
>
> 解释器执行完一个字节码（比如 `iload_0`）后，需要立刻执行下一个字节码。下一个字节码的操作码是什么？如何从 ~200 个处理路径中瞬间找到对应的机器码入口？
>
> dispatch table 是一张 256-entry 的指针数组：`table[opcode] = &bytecode_handler_start_address`。用 C 语言等价伪代码：`void* handlers[256]; goto *handlers[next_opcode];`——这就是 `jmp [dispatch_table_base + next_opcode * 8]` 一条指令做的事。操作码作为索引（0-255），直接用 CPU 的 `jmp [mem + index*8]` 间接跳转到目标。时间复杂度 O(1)，不需要任何比较或分支预测。
>
> dispatch table 必须在启动时动态构建——每个字节码的机器码地址在 `TemplateTable::generate()` 时才确定（因为长度依赖于 CPU 特性和 VM flag）。构建完成后，这张表是只读的，所有解释器线程共享。
>
> **★ 你需要知道的：RAS/RSB（Return Address Stack / Return Stack Buffer）**
>
> CPU 内部有一个小型硬件栈（RAS，也叫 RSB），专门预测 `ret` 指令的目标地址。每次执行 `call` 指令时，CPU 硬件自动把 return address push 进 RAS；每次执行 `ret`，CPU pop RAS 顶部得到预取目标——不需要等待地址计算，这让 `call`/`ret` 对的预测精度接近 100%。
>
> **解释器的困境**：解释器用 `jmp` 而不是 `call` 做字节码间跳转（因为不希望每个字节码都压一次 return address 到真实栈上），但这意味着 CPU 的 RAS 永远不会被 push——`jmp` 不触发 RAS 写入。解释器内部如果偶尔使用 `call`/`ret`（如调用 Runtime 函数），`ret` 时 pop 出来的是 RAS 中上一个条目——可能根本不是这条 `ret` 对应的 return address → 分支预测失败 → CPU pipeline flush → ~20 cycles 损失。这就是为什么 `call` + `ret` 模式理论上能让解释器快 15-20%，但 JVM 选择用 `jmp` 方案——因为 `jmp` 不需要压栈/弹栈的开销（每字节码省 2 条指令），在深度流水线 x86_64 CPU 上总体更快。

§二 ★★★ TemplateTable::iload — 一个字节码的完整机器码轨迹
  以 `iload_0`（加载局部变量槽 0 的 int 到操作数栈）为例，解释器生成的指令序列（简化但反映核心结构）：
  ```
  mov    ecx, [rbp + locals_offset + 0*4]   ; 从局部变量表加载 int32
  mov    [rsp + expr_offset], ecx           ; 压入操作数栈顶
  ; 然后 dispatch 到下一个字节码
  movzbl ebx, [r13 + r12 + 1]              ; 取下一个字节码的操作码（r13=bcp, r12=1 = 下一字节偏移）
  jmp    [rscratch1 + rbx*8]               ; 跳转到 TemplateTable 中对应字节码的指令地址（dispatch table）
  ```
  
  ❓ r13 是什么？为什么 r13+r12 是下一个字节码？
  → 在解释器中，r13 固定为 `bcp`（bytecode pointer，指向当前字节码的地址）。每个字节码执行完后，`bcp += bytecode_length` 指向下一个字节码。r12 被复用于存储偏移量（但要注意 r12 在解释器中不再是 heapbase——解释器帧有自己的寄存器约定）。
  
  ❓ dispatch table 是什么？为什么用 `jmp` 而不是 `call`？
  → Dispatch table 是一个 256-entry 的跳转表，每个 entry 是指向对应字节码机器码的地址。`jmp [table + opcode*8]` 完成字节码间的控制流转移。用 `jmp` 而非 `call` 是因为字节码之间是"尾调用"——上一个字节码完成工作后直接跳转到下一个，不留下 return address。这避免了每个字节码都 push/pop return address 的开销，但也意味着 CPU 的 return address predictor（RAS）不被使用——解释器的分支预测是个永恒的痛点。

§三 ★★ safepoint poll 的机器码级实现
  ❓ 为什么 `-XX:+PrintAssembly` 输出中每个 backedge 前都有一段 `testl`？
  → JVM 的 safepoint 机制要求每个线程定期检查"是否需要停在 safepoint"。解释器在每个方法返回前和每个循环回边（goto/if*/tableswitch 等会跳回前方的字节码）插入一段 poll 代码。生成的指令（来自 `macroAssembler_x86.cpp:3744`）：
  ```
  // 使用 thread-local poll（现代 HotSpot 默认）
  testb  [r15_thread + Thread::polling_page_offset], SafepointMechanism::poll_bit()
  jne    slow_path   ; 如果 bit 置位 → 跳转到 safepoint handler
  ```
  注意：这里用的是 `testb`（测试字节），不是 `testl`（测试双字）。`testb` 读一个字节，如果该 bit 被设置则 ZF=0 → `jne` 走慢路径。
  
  ❓ 为什么选择 `testb` + `jne` 而不是 `cmp` + `je`？
  → `testb` 是读内存后做 AND（不保存结果，只设标志位），比 `cmp`（读内存后做减法）少一次 ALU 操作。最关键的是：poll bit 0 = 不需要 safepoint（最常见情况），此时 `testb` 读到的字节为 0 → ZF=1 → `jne` 不跳 → 总共 2 条指令 ~2-3 cycles。这是"零开销 safepoint 检查"——只比不做检查多一个读内存+测试操作。
  
  ❓ Thread-local poll vs global poll 的区别？
  → Global poll：所有线程读同一个内存地址 `SafepointSynchronize::_state`，当该值 != `_not_synchronized` 时进入 safepoint。Thread-local poll（新方案）：每个线程有自己的 polling page，safepoint 时修改该线程的 `JavaThread::_polling_page` 的 bit。Thread-local poll 的优势是避免了所有线程争抢同一个 cache line——在现代多核 CPU 上这是巨大的性能差异。

§四 ★★ 方法入口：从 CallStub → 解释器入口 → 字节码执行
  ❓ `templateInterpreterGenerator_x86_64.cpp:generate_normal_entry` 做了什么？
  → 这是 Java 方法的解释器入口。当 CallStub 调用 `invoke(JavaThread*, method, args...)`，最终跳转到此：
  1. 设置 rbp 帧指针，保存 callee-saved 寄存器
  2. 从 Method* 中读取 max_locals / max_stack → 分配帧空间（sub rsp, frame_size）
  3. 设置 r13 = bcp（指向 code[0]——字节码开始）
  4. 设置 r14 = locals（局部变量表基址）
  5. 把参数从调用者寄存器/栈复制到 locals[0..n]
  6. `dispatch_next` → 跳转到第一个字节码
  
  ❓ 为什么解释器使用 `r13=bcp` 和 `r14=locals` 但没有像 r15_thread 那样"永久钉死"？
  → 解释器的寄存器约定是软性的（在 `InterpreterMacroAssembler` 中通过 `get_bcp()` / `get_locals()` 访问），因为解释器帧中 bcp 和 locals 保存在帧的固定偏移位置（`interpreter_frame_bcp_offset`、`interpreter_frame_locals_offset`）。在某些 Runtime 调用（如 `InterpreterRuntime::resolve_invoke`）中 bcp 和 locals 可能被修改——不能永久钉在寄存器上。r15_thread 不同：Thread* 在 Java 执行期间绝对不会变。

§五 ★ 和 08-safepoint 的连接：polling page 概念 → 机器码实现
  08 解释了 safepoint polling 的概念（arm/unarm polling page 的 mprotect 机制）。本文补完 08 没讲的：poll 在 CPU 上到底长什么样。`testb [r15 + offset], bit` + `jne slow` 这个 2 指令序列就是"polling page"概念的机器码具现化。08 讲"为什么需要 poll"，12 讲"poll 怎么成为 CPU 指令"。

§六 ★ 和 04-CPUID 的连接：解释器生成的指令取决于 CPU 特性
  04 的 `VM_Version::initialize()` 设置了 `UseSSE`、`UseAVX`、`UseBMI` 等 flag。解释器在生成浮点字节码（`fadd`/`fsub`/`dmul` 等）时检查这些 flag——如果有 SSE2 就用 `addsd`/`subsd`（标量双精度），如果只有 x87 就用 `fadd`/`fsub`（栈式浮点）。这解释了为什么同一份 JVM 在不同 CPU 上生成不同的解释器代码。
```

**关键文件**（跨 cpu/x86 + share/interpreter + os_cpu）：

| 文件 | 完整路径 | 模块 | 核心函数/类 | 本文角色 |
|------|---------|------|-----------|---------|
| `templateTable_x86.cpp` | `src/hotspot/cpu/x86/templateTable_x86.cpp` | cpu/x86 | `TemplateTable::iload`, `iconst`, `iadd`, `getfield`, `invokevirtual` 等 200+ 字节码 | ★★★ 核心——每个字节码到 x86_64 指令的映射 |
| `templateInterpreterGenerator_x86_64.cpp` | `src/hotspot/cpu/x86/templateInterpreterGenerator_x86_64.cpp` | cpu/x86 | `generate_normal_entry`(:~150), `generate_native_entry`, `generate_return_entry` | ★ 方法入口/返回——解释器的"大门" |
| `templateInterpreterGenerator_x86.cpp` | `src/hotspot/cpu/x86/templateInterpreterGenerator_x86.cpp` | cpu/x86 | `generate_all`(遍历所有字节码), `generate_safept_entry`, `generate_deopt_entry` | 解释器生成的主调度器 |
| `interp_masm_x86.cpp` | `src/hotspot/cpu/x86/interp_masm_x86.cpp` | cpu/x86 | `InterpreterMacroAssembler::dispatch_next`, `dispatch_via`, `notify_method_entry`, `lock_method` | ★ 解释器专用汇编宏——dispatch + lock |
| `macroAssembler_x86.cpp` | `src/hotspot/cpu/x86/macroAssembler_x86.cpp` | cpu/x86 | `MacroAssembler::safepoint_poll`(:3744), `get_thread` | safepoint poll 指令生成 |
| `abstractInterpreter_x86.cpp` | `src/hotspot/cpu/x86/abstractInterpreter_x86.cpp` | cpu/x86 | 解释器架构参数 | 栈元素大小、寄存器约定 |
| `templateTable.hpp` | `src/hotspot/share/interpreter/templateTable.hpp` | interpreter | `TemplateTable` 基类定义 | 跨平台接口 |

**前置**：[12-01]（帧布局）, [12-04]（CPU 特性决定生成的指令版本）, [08-safepoint]（为什么需要 polling）, [06-01]（字节码语义）

**需要为新读者解释的概念**（针对零 x86 知识的 Java 工程师）：
- **mov/add/cmp/jmp/test 指令的意义**：`mov dst, src` = 赋值 `dst = src`；`add dst, src` = `dst += src`；`cmp a, b` = 计算 `a-b` 只设标志位（不保存结果）；`jmp addr` = goto；`je/jne` = 条件跳转（相等/不等）；`test a, b` = 计算 `a & b` 只设标志位
- **操作数寻址模式**：`[reg + offset]` = 间接寻址 (读 reg+offset 处的内存)；`[reg1 + reg2*scale + offset]` = SIB 寻址 (常用于数组索引)
- **Stack 的"向下生长"**：x86 栈从高地址向低地址生长。`push` = `sub rsp, 8; mov [rsp], value`（先减栈指针再写值）。`pop` = `mov value, [rsp]; add rsp, 8`。所以"栈顶"是低地址，"栈底"是高地址。
- **标志位寄存器 (EFLAGS/RFLAGS)**：`cmp`/`test`/`add`/`sub` 等算术指令会设置 CPU 标志位（ZF=零标志, CF=进位标志, OF=溢出标志, SF=符号标志）。条件跳转（`je`/`jne`/`jg`/`jl`）读取这些标志来决定跳转方向。
- **dispatch table**：一种"跳转表"优化——用操作码索引一个指针数组，直接跳到目标。等价于 `void* handlers[256]; goto *handlers[opcode];`。比 if-else 或 switch 快两个数量级（O(1) vs O(n)）。

---

### [03] Stubs — Stub 代码生成（异常 / 去优化 / safepoint / call）

**核心问题**：JVM 运行时在哪些场景需要动态生成"不是方法体"的机器码片段（stub）？Exception stub 如何从抛出点跳转到异常处理器？Deoptimization stub 如何把 C1/C2 编译帧"拆解"回解释器帧？`StubGenerator::generate_call_stub` 如何实现 C → Java 的调用？为什么 deopt 在 CPU 层面如此昂贵？

**为什么重要**：Stub 是 JVM 的"暗物质"——你看不到它生成的代码在哪个 .cpp 文件中（它是在运行时动态写入 CodeBuffer 的），但它在 crash dump 中大量出现（`deopt_blob`、`uncommon_trap`、`exception_blob`）。理解 stub 的机器码 = 理解 JVM 如何在"正常执行路径"和"异常/去优化路径"之间跳转。

**什么是 Stub**：在 JVM 中，"stub"是一段动态生成的小型机器码片段，用于连接两种不同的执行模式（如解释器 ↔ 编译代码、Java ↔ C、正常路径 ↔ 异常路径）。它不是方法（没有 Method*），不是解释器字节码，而是一个"适配器"——短小、高频、必须快。所有 stub 都由 `StubCodeGenerator` 的子类在运行时生成。

**覆盖内容**：

```
§〇 源文件清单
  - cpu/x86/stubGenerator_x86_64.cpp (★ 所有 stub 的生成器: call_stub, exception_handler, 数组拷贝, atomic 等)
  - cpu/x86/sharedRuntime_x86_64.cpp (generate_deopt_blob, generate_uncommon_trap_blob, generate_native_wrapper)
  - cpu/x86/macroAssembler_x86.cpp (safepoint_poll, set_last_Java_frame, reset_last_Java_frame)
  - cpu/x86/nativeInst_x86.cpp (is_safepoint_poll, is_call 等 Native 指令识别)
  - cpu/x86/vtableStubs_x86_64.cpp (虚方法分派 stub)
  - runtime/stubCodeGenerator.cpp (StubCodeGenerator 基类——分配 CodeBuffer)
  - runtime/stubRoutines.cpp (StubRoutines 存储所有生成的 stub 入口地址)

> **★ 你需要知道的：stub 在 CPU 层级到底是什么**
>
> 在一个普通 C++ 程序中，`main()` → `foo()` → `bar()` 的每条指令都来自编译器的输出——你可以在 `objdump -d libfoo.so` 中找到每一字节的机器码。但 JVM 不是普通程序：它除了执行 C++ 编译后写入 `libjvm.so` 的指令，还在**运行时动态生成**大量机器码并跳转过去执行。
>
> 一个"stub"就是这样一段动态生成的机器码片段——它不在 `libjvm.so` 中，不在任何 C++ 编译单元的 `.text` 段，而是由 `StubGenerator`（继承自 `StubCodeGenerator`）在 JVM 启动时在堆内存中拼装字节流，然后被 CPU 当作指令执行。每个 stub 是一个"指令序列"——开头的 `push rbp; mov rbp, rsp` 和结尾的 `pop rbp; ret` 与你熟悉的 C 函数无异——只是没经过编译器。它不像 Java 方法（有 Method* 对象、有字节码），也不是解释器发出的单字节码模板——stub 是一个独立的"适配器"：连接不同执行模式（C↔Java、正常路径↔异常路径、编译↔解释）。
>
> **为什么需要动态生成而不是编译时写死在 C++ 里？** 因为 stub 的指令宽度、SIMD 指令版本、寄存器使用取决于运行时才能确定的 CPU 特性（UseSSE/UseAVX/UseCompressedOops）。编译时写死在 C++ 中无法根据这些条件选择指令——而 `MacroAssembler` 在运行时检查 flag，生成对应的最优指令序列。
>
> **★ 你需要知道的：nmethod / CodeBuffer / CodeCache 的生命周期**
>
> JVM 生成的机器码（包括 stub 和编译后的 Java 方法）经历三个对象的生命周期：
>
> 1. **CodeBuffer**（代码缓冲区）— 指令"拼装台"：`MacroAssembler` 通过 `emit_int8(0x50)`（push）、`emit_int32(relative_offset)`（call relative）逐字节追加到 CodeBuffer。CodeBuffer 内部是一个可增长的字节数组，最终持有完整的 x86_64 指令二进制流。此阶段还没有地址——所有跳转目标都是占位符/标签（Label），通过 `bind(label)` 在最后才绑定到真实偏移。
> 2. **CodeCache**（代码缓存）— 指令"执行区"：CodeBuffer 的内容被复制/安装到 CodeCache（一片由 mmap 分配的可执行内存区域，属于 CodeHeap）。安装时所有标签被解析为真实 PC 地址，relocations（重定位信息）被写入，oop maps（GC 所需的栈引用位图）被编码。CodeCache 中的每个 blob 都以 `CodeBlob` 子类的形式管理——它是运行时"可执行机器码"的容器。
> 3. **nmethod**（编译方法）— 一个"完整包装"：当 C1/C2 编译完一个 Java 方法后，CodeBlob 被包装为 nmethod——它额外包含 exception handler table、deoptimization info（`ScopeDesc` 描述栈帧与源码变量的映射）、inline caches、编译级别标记、依赖记录（用于无效化）等。nmethod 是 CodeCache 中最"重"的实体（几 KB 到几 MB），而 bare stub（RuntimeStub）只有几百字节。Stub 也是 CodeBlob 但包装更轻。
>
> 为什么分层？CodeBuffer 是"工作区"（可丢弃重建），CodeCache 是"成品区"（持久、可执行），nmethod 是"带元数据的成品"（可被 GC 卸载、可被无效化）。

§一 ★ 全景：Stub 的 4 种类别和生成时机
   ❓ JVM 启动时生成了多少 stub？
   → `StubGenerator::generate_all()` 在 VM 初始化阶段生成约 40+ 个 stub，分为 4 类：
  - **Calling convention stubs**：`call_stub`（C→Java）、`catch_exception`、`forward exception`。启动时生成，永不修改。
  - **Exception stubs**：`exception_handler`、`deopt_handler`、`uncommon_trap`。在 SharedRuntime 初始化阶段生成。
  - **Safepoint stubs**：poll 的慢路径（进入 safepoint 的调用序列）。在 SafepointSynchronize 初始化时注册。
  - **GC barrier stubs**：card table write barrier、G1 SATB barrier 的快速路径。由 GC 子系统在初始化时注册。
  ❓ stub 存在哪里？有 GC 吗？
  → 所有 stub 在 CodeCache 中分配为 RuntimeStub 或 BufferBlob。它们是 immortal（不会被 GC 回收）——JVM 启动时分配后一直存活到进程退出。大小固定，通常在 1KB~100KB 范围内。

> **★ 你需要知道的：spill slot（在编译帧 deopt 语境中的含义）**
>
> 在 01-Frames 的帧布局中，spill slot 是"编译器寄存器不够用时溢出到栈的槽"。在 deoptimization 语境中，spill slot 有一个额外的关键角色——它是**编译帧和解释器帧之间的"数据桥梁"**。
>
> C2 编译的方法不维护"操作数栈"概念——所有中间值要么在寄存器中，要么在 spill slot 中（栈上固定偏移的槽）。当 C2 被 deopt 回到解释器时，deopt handler 需要把每个"活"的局部变量从它的"当前存放位置"（某个寄存器的值 或 某个 spill slot 的内存值）搬运到新构建的解释器帧的 locals 区域。寄存器的值可以直接 `mov`，spill slot 的值需要从栈上原编译帧位置读取再写入新解释器帧位置。这个"搬迁"是 deopt 最昂贵的部分——每个"活"变量都需要至少一条 `mov` 指令，对于大方法可能数百次内存操作。

§二 ★★★ Deoptimization blob 的完整 CPU 路径
  ❓ 编译代码如何触发 deoptimization？
  → C1/C2 在编译时在某些点插入 `UncommonTrap` 或 `Deoptimize` 节点。编译后的机器码在 trap 点执行 `int 3`（SIGTRAP）或 `call deopt_blob_entry`。CPU 中断 → 信号处理器转发 → `fetch_unroll_info` 从 nmethod 获取 deopt 信息 → `unpack` 把编译帧转换为解释器帧 → 跳转到解释器重新执行。
  
  ❓ 为什么 deoptimization 在 CPU 层面这么昂贵？
  → 一个 deopt 涉及的操作（每一步都是 CPU 指令代价）：
  1. **Trap/信号** (~1000 cycles)：CPU pipeline flush + 信号上下文保存（保存所有寄存器到栈上）
  2. **读取 deopt info** (~500 cycles)：从 nmethod 的 debugInfo 中读取每个局部变量/OOP 的保存位置（寄存器号或栈偏移）
  3. **Unpacking** (~2000 cycles)：遍历每个变量，从 nmethod 的 spill slot / 寄存器 → 写入新的解释器帧的 locals 槽。对于有 100 个局部变量的方法，这是 100 次 `mov` 操作
  4. **帧重建** (~200 cycles)：重新构造 interpreter frame（分配帧空间、设置 method/bcp/locals/constPool 指针）
  5. **跳转到解释器**：跳到字节码重新执行
  
  总代价：~5000-10000 cycles = 正常方法调用（~20 cycles）的 250-500 倍。这就是为什么 C2 编译器如此努力避免 deopt——deopt 一次相当于 500 次正常方法调用的开销。
  
  ❓ `generate_deopt_blob()` 生成的 blob 分成几段？
  → sharedRuntime_x86_64.cpp:2813 的 `generate_deopt_blob()` 生成 3 段（对应 3 种不同的 deopt 触发方式）：
  1. `unpack` — UncommonTrap（编译时预期不执行的路径实际被命中了）→ 重建解释器帧并跳转
  2. `unpack_with_exception` — deopt 时还带着未处理的异常 → 同时重建帧和设置 pending exception
  3. `unpack_uncommon_trap` — 运行时 speculative 优化的回退路径

> **★ 你需要知道的：epilogue（尾声——被生成例程的结尾汇编序列）**
>
> 在汇编语境中，每个函数的完整执行序列分为三部分：**prologue**（序言——设置栈帧）、**body**（函数体——实际逻辑）、**epilogue**（尾声——拆帧并返回）。epilogue 是 prologue 的逆操作：
> ```
> ; Prologue（进入时）
> push rbp
> mov rbp, rsp
> sub rsp, 48         ; 分配局部变量空间
> ; Body
> ...                 ; 实际计算
> ; Epilogue（退出时）
> mov rsp, rbp        ; 回收局部变量空间（等价于 leave 指令）
> pop rbp             ; 恢复 caller 的帧指针
> ret                 ; 弹出栈顶 return address 并跳转回 caller
> ```
>
> 在 JVM stub / 编译方法的语境中，epilogue 不只是"恢复 rsp/rbp 然后 ret"——它还承担关键的状态清理：`reset_last_Java_frame(r15_thread)` 把 `_last_Java_sp/fp/pc` 清零（告诉 C++ 端"已离开 Java 执行"），恢复可能被方法体修改过的 callee-saved 寄存器（r12-r15），以及条件分支——如果异常发生则走不同的退出路径（跳转到 `forward_exception_entry` 而不是 `ret` 回正常 caller）。
>
> 在 03 的 Exception stub 讨论中，"caller 的 epilogue 检查 rax"意味着：caller 的 epilogue 在恢复寄存器后、ret 之前，检查 rax 是否为 NULL——非 NULL = 异常 oop，需要跳过正常返回值处理并调用异常分发 stub。

§三 ★★ Exception stub 的生成和执行
  ❓ 编译代码 throw 一个 Exception 后 CPU 怎么找到 handler？
  → C1/C2 编译的方法中，每个 call site 后都有 exception handler table。当 callee 返回时 rax 为 exception oop（非 NULL），caller 的 epilogue 检查 rax → 如果非 NULL，跳过正常返回值处理 → 从 exception table 中查找 handler 的 PC 偏移 → `jmp handler`。
  
  ❓ 如果当前方法没有 handler？
  → 逐帧 unwind：当前帧的异常处理 stub 调用 `SharedRuntime::exception_handler_for_return_address` → 解码 return address 找到 caller → 检查 caller 是否有 handler → 如果没有就继续 unwind → 直到找到 handler 或到达栈顶（JavaThread::exception_handler_for_return_address 兜底）。
  
  ❓ StubGenerator 中的 `generate_forward_exception` 是干什么的？
  → 当 JVM Runtime（C++ 代码）检测到 pending exception 但不想立即处理时，它调用 `forward_exception_entry`。这个 stub 把 pending exception 从 Thread 对象 rax 中取出，设置 rax = exception oop，然后 `ret` —— callee 看到 rax != NULL 就知道有异常需要处理。

§四 ★★ call_stub — C → Java 的唯一入口
  ❓ C++ 代码怎么调用 Java 方法？
  → `JavaCalls::call()` → `call_stub(JavaThread*, method, args, result)` → 这个 `call_stub` 是一个动态生成的 stub（stubGenerator_x86_64.cpp:209 `generate_call_stub`）：
  1. 在栈上设置 JavaCalls 参数
  2. `set_last_Java_frame(r15_thread, rsp, rbp, return_pc)` — 保存 Java 栈帧锚点
  3. 跳转到 method 的入口点（解释器的 `entry_point` 或编译后的 `verified_entry_point`）
  4. 方法返回后 `reset_last_Java_frame(r15_thread)` — 清除锚点
  5. 恢复 C 调用者的寄存器，返回结果
  
  ❓ 为什么需要 `set_last_Java_frame`？这直接回答 crash dump 中 `r12=0x0` 的含义！
  → 当 JVM 在 C 代码中崩溃（例如在 GC 中访问了坏指针），栈行走器需要知道"最后执行的 Java 帧在哪里"。`JavaThread::_last_Java_sp` 和 `_last_Java_fp` 存储了 Java 帧的边界。`set_last_Java_frame` 把当前 rsp/rbp 写入 `[r15_thread + last_Java_sp_offset]`。如果这个写入因为 r15=0 而 segfault——就会出现"crash dump 里 r12=0x0 / r15=0x0"的经典场景：Thread* 指针丢失了。
  
  ❓ 为什么 call_stub 不用普通的 C `call` 指令调用 Java 方法？
  → C calling convention 和 Java calling convention 不同（参数顺序、浮点参数、返回类型）。call_stub 充当"适配器"——从 C ABI 收参 → 转换为 JVM internal convention → 跳转到 Java 方法 → 返回值转回 C ABI。

§五 ★ Safepoint poll 的慢路径 stub
  ❓ poll 检测到 safepoint 请求后，CPU 执行什么？
  → 从 `testb + jne slow_path` 跳转到 slow_path 后：
  1. 保存当前帧的所有必要状态（sp/fp/pc 写入 r15_thread）
  2. 调用 `SafepointSynchronize::block(JavaThread*)` ——这是一个 C++ 函数
  3. C++ 函数内部：设置线程状态为 `_thread_blocked` → 等待 safepoint 结束 → 恢复状态
  4. 返回后恢复寄存器 → `jmp` 回到 poll 点之后继续执行
  
  这个 slow path 的代价：~500-1000 cycles（保存/恢复寄存器 + C 调用开销 + 可能的线程睡眠）。但这只发生在 safepoint 期间（GC 等），正常情况下 poll 只走 2 指令快路径。

§六 ★ 和 11-os-layer 的连接：信号 → stub 的接力
  11-01 的 `JVM_handle_linux_signal` 分发信号到不同的处理路径。其中：
  - SIGSEGV on polling page → `handle_polling_page_exception()` → 直接跳转到 safepoint stub（不返回）
  - SIGSEGV implicit null check → `forward_exception_entry` stub → 抛出 NullPointerException
  - SIGTRAP (int 3) → deoptimization stub → 帧重建
  
  11 讲"信号识别"，12 讲"信号识别的结果——跳转到哪个 stub、stub 里有什么指令"。这是信号和机器码的"手递手接力"。

§七 ★ 和 09-native-interface 的连接：JNI wrapper 的汇编实现
  09-03 的 JNI 方法调用穿越 `_thread_in_native` 状态切换。本文补完 09 没讲的：`SharedRuntime::generate_native_wrapper`（sharedRuntime_x86_64.cpp）生成的机器码如何包装一个 native 方法调用——从 Java 参数解包（从 Java calling convention 到 C calling convention）、状态切换（mov 设置 thread_state）、调用 native 函数、返回值打包、状态恢复。
```

**关键文件**（跨 cpu/x86 + os_cpu + runtime）：

| 文件 | 完整路径 | 模块 | 核心函数/类 | 本文角色 |
|------|---------|------|-----------|---------|
| `stubGenerator_x86_64.cpp` | `src/hotspot/cpu/x86/stubGenerator_x86_64.cpp` | cpu/x86 | `StubGenerator::generate_call_stub`(:209), `generate_forward_exception`, `generate_catch_exception`, `generate_atomic_*` | ★★★ Stub 总工厂——所有经典 stub |
| `sharedRuntime_x86_64.cpp` | `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp` | cpu/x86 | `SharedRuntime::generate_deopt_blob`(:2813), `generate_uncommon_trap_blob`, `generate_native_wrapper` | ★★★ Deopt + UncommonTrap + JNI wrapper |
| `macroAssembler_x86.cpp` | `src/hotspot/cpu/x86/macroAssembler_x86.cpp` | cpu/x86 | `safepoint_poll`(:3744), `set_last_Java_frame`(:3768), `reset_last_Java_frame` | ★ Safepoint poll + 帧锚点 |
| `nativeInst_x86.cpp` | `src/hotspot/cpu/x86/nativeInst_x86.cpp` | cpu/x86 | `NativeInstruction::is_safepoint_poll`, `is_call` | Native 指令反识别 |
| `stubCodeGenerator.cpp` | `src/hotspot/share/runtime/stubCodeGenerator.cpp` | runtime | `StubCodeGenerator` 基类 | CodeBuffer 分配 + 接口 |
| `stubRoutines.cpp` | `src/hotspot/share/runtime/stubRoutines.cpp` | runtime | `StubRoutines::initialize` + 所有 stub 入口存储 | Stub 注册中心 |

**前置**：[12-01]（帧布局是 deopt 帧重建的基础）, [12-02]（deopt 需要理解解释器帧格式）, [11-01]（信号→stub 接力）, [09-03]（JNI wrapper 的状态切换）, [08-safepoint]（polling 需要做什么）

**需要为新读者解释的概念**（针对零 x86 知识的 Java 工程师）：
- **什么是"stub"**：在 JVM 语境中，stub 是一段动态生成的小型机器码片段，用于两种执行模式之间的"协议转换"（如 C↔Java、Java↔Native、正常路径↔异常路径）。它不是 Java 方法，没有对应的 Method* 对象，只存在于 CodeCache 中。类比 Java 中的"适配器模式"——stub 就是机器码层的适配器。
- **什么是"去优化 (deoptimization)"**：C1/C2 在编译时做了激进的假设（如"这个 if 分支永远不会走"、"这个对象类型一定是 HashMap"）。当假设被打破时，不能继续执行编译后的代码——必须"去优化"回解释器，用解释器重新执行。在 CPU 层面，这意味着把一个编译帧的内容（寄存器 + spill slot）解包重组为一个解释器帧（method/bcp/locals/stack 一套全新布局），然后跳转到解释器入口。
- **int 3 (SIGTRAP)**：x86 的"断点指令"。CPU 执行 `int 3` 时触发 trap → 内核发送 SIGTRAP 信号。JVM 在 deopt 点插入 `int 3` 作为"调用 deopt stub"的替代方案（因为 trap 比 call 更紧凑——1 字节 vs 5 字节）。代价是信号处理的开销更大。

---

### [04] CPUID — CPU 特性检测（VM_Version::initialize + CPUID 指令）

**核心问题**：JVM 如何在不依赖任何操作系统 API 的情况下，精确知道当前 CPU 支持哪些指令集（SSE/SSE2/SSE3/SSSE3/SSE4.1/SSE4.2/AVX/AVX2/AVX-512/BMI1/BMI2/FMA 等）？`VM_Version::initialize()` 中 20+ 次 CPUID 调用各探测什么？什么情况下会 `SIGILL`（非法指令）崩溃？

**为什么重要**：这是 JVM 的"安全底线"——如果 CPUID 探测失败或误判，JVM 可能生成 CPU 不支持的指令 → `SIGILL` → JVM 直接崩溃（连 hs_err 都来不及写）。此外，CPUID 的探测结果决定了 JIT 编译器可以生成多高效的代码——AVX2 的 256-bit SIMD 比 SSE2 的 128-bit 快 2-3 倍。

**覆盖内容**：

```
§〇 源文件清单
  - cpu/x86/vm_version_x86.cpp (★ VM_Version::initialize + VM_Version_StubGenerator + CPU 特性 flag)
  - cpu/x86/vm_version_x86.hpp (CpuidInfo 结构体、所有 CPU 特性 flag)
  - cpu/x86/vm_version_ext_x86.cpp (扩展 CPU 信息——品牌字符串、缓存拓扑)
  - cpu/x86/assembler_x86.cpp (Assembler::cpuid 助手函数)
  - cpu/x86/macroAssembler_x86.cpp (各种 SSE/AVX 指令——由 UseSSE/UseAVX 条件编译)
  - runtime/vm_version.cpp (VM_Version 基类——跨平台接口)
  - runtime/globals.hpp (UseSSE, UseAVX, UseBMI 等 experimental/develop flag)

§一 ★ 全景：`VM_Version::initialize()` 的启动时序
  ❓ CPU 探测在 JVM 启动的哪个阶段执行？
  → 极早期——甚至在堆初始化之前。调用链：`Threads::create_vm()` → `VM_Version::initialize()` → 这是 JVM 启动的步骤之一。CAPID 探测需要在任何代码生成之前完成（包括解释器 stub、C1/C2 初始化、GC barrier stub），因为这些模块的代码生成都依赖 `UseSSE`/`UseAVX` 等全局 flag。
  ❓ 如果 CPUID 指令不存在（真正的 386/486），JVM 怎么处理？
  → `VM_Version_StubGenerator::generate_get_cpu_info()` 先用"修改 EFLAGS 的 ID 位 (bit 21)"的方法检测 CPU 是否支持 CPUID 指令——这是 x86 上最底层的 CPU 能力探测，不依赖任何 OS API。

  **EFLAGS 是什么？** EFLAGS（在 64-bit 长模式下为 RFLAGS）是 x86 CPU 的"条件码寄存器"——一个 32-bit 的特殊寄存器。每条算术/逻辑指令（`add`、`sub`、`cmp`、`test`、`and`、`or` 等）执行后都会根据结果自动更新其中的标志位：CF (bit 0, 进位标志)、PF (bit 2, 奇偶标志)、ZF (bit 6, 零标志)、SF (bit 7, 符号标志)、OF (bit 11, 溢出标志) 等。条件跳转指令（`je`/`jne`/`jg`/`jl` 等）就是读这些标志位来决定跳转方向——例如 `je` 跳转当且仅当 ZF=1。

  **ID bit (bit 21)——CPUID 能力的"开关"：** 在 EFLAGS 的第 21 位（掩码 `0x200000`），存在一个特殊的 bit：ID (Identification) flag。Intel 从晚期 486 / Pentium 开始定义：**如果软件能成功翻转 EFLAGS 的第 21 位，说明 CPU 支持 CPUID 指令**。386 和早期 486 上这个 bit 是硬连线为 0 的（无法修改），这就是检测原理——不依赖 CPUID 来检测 CPUID（因为如果 CPUID 不存在，执行它会触发 `SIGILL`）。

  **翻转测试 (toggle test) 的完整步骤：**
  ```
  pushfd                  ; 步骤1: 把 EFLAGS 压入栈（x86 没有"mov eax, eflags"指令，必须通过栈中转）
  pop eax                 ; 步骤2: 弹出到 EAX（现在 EAX 持有当前 EFLAGS 的完整值）
  mov ecx, eax            ; 步骤3: 保存原始值到 ECX（用于后续对比）
  xor eax, 0x200000       ; 步骤4: 翻转 ID bit (bit 21)——如果 CPU 支持 CPUID，这个 bit 可写
  push eax                ; 步骤5: 把修改后的值压回栈
  popfd                   ; 步骤6: 从栈弹出写入 EFLAGS（如果 ID bit 可写，EFLAGS 现在变了）
  pushfd                  ; 步骤7: 再次把 EFLAGS 压栈（读回确认，而非信任刚才的写入）
  pop eax                 ; 步骤8: 弹出到 EAX（现在 EAX 持有"尝试写入后"的 EFLAGS 实际值）
  xor eax, ecx            ; 步骤9: XOR 原始值 vs "尝试写入后"的值——如果 bit 21 真的变了，结果的 bit 21 = 1
  ```
  如果 `eax ^ ecx` 的结果中 bit 21 = 1（即该位确实发生了变化），说明 CPU 支持 CPUID 指令，可以安全调用 `cpuid` 进行后续详细探测。如果 bit 21 没变（结果中该位 = 0），说明 CPU 不支持 CPUID——386 上 bit 21 硬连线为 0 无法修改，早期 486 虽然有 bit 21 可读写但不支持 CPUID 指令本身。这两种情况都意味着不能执行 `cpuid`，JVM 设置 `_cpu = CPU_FAMILY_386` 或 `_cpu = CPU_FAMILY_486`，禁用所有现代特性。
  ❓ CPUID 探测结果存哪里？
  → `VM_Version::_cpuid_info`（类型 `CpuidInfo`）存储了所有 CPUID leaf 的原始返回值（EAX/EBX/ECX/EDX 寄存器值）。`VM_Version::initialize()` 解析这些 bit — 例如 `_cpuid_info.std_cpuid1_ecx.bits.avx` → 设置 `UseAVX = true`。

§二 ★★★ CPUID 指令的工作原理（零 x86 知识的 Java 工程师友好版）
  CPUID 是 x86 的一个特殊指令——你可以把它理解为 CPU 的"自我介绍函数"：
  ```
  // 伪代码：
  mov eax, <question_number>     // 选择问什么 (leaf)
  mov ecx, <sub_question_number> // 子问题编号 (sub-leaf)
  cpuid                          // CPU 回答 → 结果在 eax/ebx/ecx/edx 中
  ```
  
  JVM 问的问题（核心 leaf）：
  
  | CPUID Leaf | EAX 输入 | ECX 输入 | 返回（EAX/EBX/ECX/EDX 各 32 bits） | 探测什么 |
  |-----------|----------|----------|--------------------------------------|---------|
  | **0** | 0 | — | EAX: max basic leaf, EBX/ECX/EDX: "GenuineIntel" | 厂商字符串（"GenuineIntel" vs "AuthenticAMD"） |
  | **1** | 1 | — | ECX: SSE3/SSSE3/SSE4.1/SSE4.2/AVX/FMA/AES, EDX: SSE/SSE2/HTT | ★ 核心特性——所有 SSE/AVX flag |
  | **7** | 7 | 0 | EBX: AVX2/BMI1/BMI2/SHA, ECX: AVX512_* | ★ 扩展特性——AVX2/AVX-512/BMI |
  | **0x80000001** | 0x80000001 | — | EDX: 3DNow!/64-bit/LahfSahf | ★ AMD 扩展——区分 Intel vs AMD |
  | **0x80000008** | 0x80000008 | — | EAX: 物理地址宽度 / 虚拟地址宽度 | 内存寻址能力 |
  | **4** | 4 | 0..N | EAX: cache 参数 (type/level/ways/sets) | Cache 拓扑 |
  
  ❓ 为什么需要区分 Intel 和 AMD？
  → 某些功能在两个厂商之间有不同行为。例如 LZCNT (leading zero count) 在 AMD 上是真正的 LZCNT，在 Intel 上 `lzcnt` 会 fallback 到 `bsr`（如果 input=0 则结果不同）。JVM 需要根据厂商身份选择正确的指令序列。
  ❓ CPUID 探测会不会导致 `SIGILL`？
  → 会——这就是为什么 `VM_Version_StubGenerator` 需要提前用 EFLAGS 测试确认 CPUID 指令可用。在真正的 386/486 上执行 `cpuid` 会 `SIGILL`。现代 CPU（2005+）都支持，所以这个保护主要是理论上的。

§三 ★★ 关键 flag 的设置逻辑：UseSSE → UseAVX → UseAVX512 的级联
  ❓ 如果 CPU 支持 AVX2，但 `-XX:UseAVX=0`，C2 会生成什么？
  → `VM_Version::initialize()` 中 flag 的设置是级联的：
  ```
  if (UseSSE < 4 && supports_sse4_1()) UseSSE = 4;
  if (UseAVX < 1 && supports_avx())    UseAVX = 1;
  if (UseAVX < 2 && supports_avx2())   UseAVX = 2;
  if (UseAVX < 3 && supports_avx512()) UseAVX = 3;
  ```
  如果用户设置 `-XX:UseAVX=0`，则 `UseAVX` 不会被自动提升——即使 CPU 支持 AVX2，C2 也只用 SSE4.2。这用于规避某些 CPU 的 AVX bug（如某些 Skylake 的 AVX-512 降频严重）。
  
  ❓ `UseSSE=4` 意味着什么？
  → UseSSE 的值反映最高支持的 SSE 级别：0=无 SSE, 1=SSE, 2=SSE2, 3=SSE3, 4=SSE4.1+SSE4.2。当 UseSSE >= 2 时，浮点运算用 SSE 标量指令（`addsd`/`subsd`），不再用 x87 栈指令（`fadd`/`fsub`）。UseSSE >= 4 时允许使用 SSE4.1 的 blend/insert/extract 等高级 SIMD 操作。

§四 ★★ 为什么 CPUID 首先生成一个"stub"再调用它？
  ❓ `VM_Version_StubGenerator::generate_get_cpu_info()` 为什么不在 `VM_Version::initialize()` 中直接内联汇编？
  → 因为 CPUID 执行时有一些微妙的状态约束：
  1. 需要精确的寄存器保存/恢复——CPUID 会破坏 EAX/EBX/ECX/EDX，而 JVM 需要多次 CPUID 调用（每次不同参数）的完整结果
  2. AVX/AVX-512 探测需要在 `xsave`/`xrstor` 的上下文中执行——需要测试 XSAVE 区域能否保存 YMM/ZMM 寄存器
  3. Stub 隔离了"危险区"——如果 CPUID 调用因为特殊原因触发了某种保护（某些虚拟化环境），stub 内部可以做信号安全处理
  
  所以 JVM 在 CodeBuffer 中生成一段短小的"探测 stub"（~2000 字节），然后强转为函数指针调用它：`get_cpu_info_stub(&_cpuid_info)`。

§五 ★ SIGILL 的保护机制：`_cpuinfo_segv_addr` 和 `_cpuinfo_cont_addr`
  ❓ 如果 CPU 报告支持 AVX，但 JVM 执行 AVX 指令时 segfault（虚拟机的 CPU 特性暴露问题），怎么处理？
  → `VM_Version_StubGenerator` 在 stub 内设置了"哨兵"——`_cpuinfo_segv_addr` 记录可能出错的指令地址，`_cpuinfo_cont_addr` 记录错误后的恢复地址。如果 SIGILL 发生在探测 stub 内部，信号处理器识别出 pc 在探测 stub 范围内 → 跳过该特性 → 继续探测。这防止了"CPU 说支持但实际不支持"的虚拟化环境 bug。
  ❓ 类似问题也发生在 AVX-512 频率调节上——探测到了但不一定好用？
  → 是的。某些 Skylake-X 的 AVX-512 执行时 CPU 降频严重（因为 AVX-512 功耗高），实际吞吐量可能低于 AVX2。JVM 提供 `-XX:UseAVX=2` 强制降级到 AVX2。CPUID 只能告诉你"CPU 有这个功能"，不能告诉你"用了之后会不会更好"。

§六 ★ 和 12-02 (Interpreter) + 12-03 (Stubs) 的连接：探测结果决定生成什么指令
  04 的 CPUID 探测结果是 02/03 代码生成的输入。`TemplateTable::fadd` 生成 `addsd`（SSE2）还是 `fadd`（x87）取决于 `UseSSE`；`StubGenerator::generate_arraycopy` 生成 `rep movsq`（普通拷贝）还是 `vmovdqu`（AVX 256-bit 拷贝）取决于 `UseAVX`。04 是 02/03 的"开关控制层"。

§七 ★ 和 11-os-layer 的连接：OS 不参与 CPU 能力报告
  这是 CPU 层和 OS 层的"独立宣言"——CPUID 直接访问 CPU 硬件，无需系统调用，无需 `/proc/cpuinfo`。`/proc/cpuinfo` 是 OS 读了 CPUID 后格式化的文本，JVM 不走这个路径——直接调 CPUID 更快、更精确（没有 OS 内核的过滤/缓存/误报）。
```

**关键文件**（跨 cpu/x86 + runtime）：

| 文件 | 完整路径 | 模块 | 核心函数/类 | 本文角色 |
|------|---------|------|-----------|---------|
| `vm_version_x86.cpp` | `src/hotspot/cpu/x86/vm_version_x86.cpp` | cpu/x86 | `VM_Version::initialize()`, `VM_Version_StubGenerator::generate_get_cpu_info`(:65), `get_processor_features` | ★★★ CPU 探测核心——整个探测流程 |
| `vm_version_x86.hpp` | `src/hotspot/cpu/x86/vm_version_x86.hpp` | cpu/x86 | `CpuidInfo` 结构体, `std_cpuid1_ecx`, `ext_cpuid7_ebx` 等 bitfield | ★ CPUID 返回值的 bit 位定义 |
| `vm_version_ext_x86.cpp` | `src/hotspot/cpu/x86/vm_version_ext_x86.cpp` | cpu/x86 | 品牌字符串提取、缓存信息 | 扩展信息提取 |
| `assembler_x86.cpp` | `src/hotspot/cpu/x86/assembler_x86.cpp` | cpu/x86 | `Assembler::cpuid` 助手 | CPUID 指令封装 |
| `vm_version.cpp` | `src/hotspot/share/runtime/vm_version.cpp` | runtime | `VM_Version` 基类、跨平台接口 | 抽象基类 |
| `globals.hpp` | `src/hotspot/share/runtime/globals.hpp` | runtime | `UseSSE`, `UseAVX`, `UseBMI`, `UseFMA` 等 flag 声明 | 所有 CPU 特性 flag |

**前置**：[12-02]（探测结果决定解释器的指令版本）, [12-03]（stub 代码生成也依赖 CPU 特性 flag）

**需要为新读者解释的概念**（针对零 x86 知识的 Java 工程师）：
- **CPUID 指令**：x86 CPU 内建的一个特殊指令。你设置 EAX = 问题编号，执行 `cpuid`，CPU 把答案放在 EAX/EBX/ECX/EDX 4 个寄存器中返回。可以理解为硬件层面的 `Map<Integer, CpuAnswer> getCapabilities()`
- **SSE/AVX 是什么**：SIMD (Single Instruction Multiple Data) 指令集。一条指令同时操作 128-bit (SSE) / 256-bit (AVX2) / 512-bit (AVX-512) 的数据。对于 Java，这在数组拷贝、String 操作、Math 函数、GC 卡表扫描中有显著加速
- **SIGILL**：`SIGnal ILLegal instruction`。当 CPU 遇到它不认识的机器码时发出。常见原因：(1) CPU 太旧不支持该指令，(2) 虚拟化环境暴露的 CPU 特性有误，(3) 代码生成器生成了错误指令
- **XSAVE/XSAVEC**：保存/恢复扩展寄存器状态（YMM/ZMM）的指令。AVX 探测不是只调 CPUID——还需要测试 XSAVE 区域能否实际容纳 256/512-bit 的寄存器，因为某些旧 BIOS/虚拟化可能不完整支持

---

## 四、写作优先级与预估篇幅

| 优先级 | 文档 | 预估篇幅 | 理由 |
|--------|------|---------|------|
| **P0** | 01-Frames | ~600行 | 栈帧是所有后续文档的坐标系。crash dump 解读、stack walking、deopt 帧重建全部依赖帧布局理解。每一行 -XX:+PrintAssembly 输出都隐含帧偏移。**
| **P0** | 02-Interpreter | ~650行 | 解释器是 C1/C2 的"黄金参考实现"。读者第一次在指令级理解 Java 代码如何执行的最好起点。字节码 ↔ 汇编的直观对应关系是 x86 JVM 学习的最佳入门。**
| **P1** | 03-Stubs | ~650行 | Deopt 是 JVM 中最昂贵但最必要的操作——理解它为什么贵、在 CPU 上经历了什么。Exception stub 和 call stub 覆盖了所有"非正常执行"的路径，是生产 crash 分析的核心。**
| **P1** | 04-CPUID | ~500行 | 篇幅最小但自主性最强——独立于其他 3 篇。`SIGILL` 是 JVM 最恐怖的崩溃（没有 hs_err），而根本原因几乎都是 CPUID 探测失效。每个 JVM 工程师都应理解这个 "自检" 流程。 |

---

## 五、和已学阶段的对比

| 维度 | 08-safepoint | 09-native-interface | 10-services-diag | 11-os-layer | **12-cpu-layer** |
|------|-------------|-------------------|-----------------|-------------|------------------|
| 核心文件 | ~6 | ~79（聚焦 ~25） | ~56（聚焦 ~20） | ~167（聚焦 ~15） | **~112（聚焦 ~15）** |
| 文档数 | 5 | 7 | 4 | 4 | **4** |
| 模块跨度 | 2 (runtime + gc) | 7 | 5 | 5 (os/linux + os/posix + os_cpu + runtime + utilities) | **4** (cpu/x86 + os_cpu/linux_x86 + runtime + interpreter) |
| 核心叙事 | 一个机制深挖 | 多子系统+线程状态 | 两管道+底线 | OS三原语+崩溃 | **CPU 指令层——4 类运行时机器码生成** |
| 与前置的连接 | 自包含（依赖07） | 强烈依赖08 | 依赖09+08+07 | 依赖10+08+07+09 | ★ 依赖11（信号→stub）+08（poll→指令）+07（Thread→r15）+06（字节码→模板）+09（JNI wrapper asm） |
| 最大价值 | begin/end 双层门禁 | JNI线程状态 + VM_Operation | 线上诊断全链路 | 物理层——信号/线程/内存 OS 实现 | ★ 执行层——所有 Java 代码的 CPU 指令具现 |

### 和 11-os-layer 的硬/软对称：信号处理者 → 被信号触发的机器码

| | 11 (OS 层) | 12 (CPU 层) |
|---|---|---|
| 核心抽象 | `signalHandler` — 信号是由内核投递的 | `MacroAssembler` — 指令是由 JVM 生成的 |
| 线程代理 | `pthread_t` — LWP ID | `r15_thread` — 寄存器中的 Thread* |
| 栈模型 | `ucontext_t` — 信号帧（内核写的） | `frame` — Java 帧（JVM 自己布局的） |
| 崩溃处理 | `os::print_context` — 读 ucontext | `generate_deopt_blob` — 帧重建 |
| 内存映射 | `mmap` — OS 提供的虚拟内存 | `CompressedOops` — 32-bit 窄化指针解压 |
| 安全底线 | `mprotect` — 页保护 | `VM_Version::initialize` — CPUID 探测 |

### 和 11-os-layer 的具体技术连线

- **11-01 signal handler → 12-03 stub 执行**：11 的 `JVM_handle_linux_signal` 做 6 路信号分流（polling page / implicit null / stack overflow / SIGBUS / JNI fast get field / crash），每个分流目标都是一个 **stub 入口**（12-03 生成的机器码）。11 讲 "if 分支"，12 讲 "每个分支里的机器码序列"。
- **11-02 pthread → 12-01 r15_thread**：11 的 `os::create_thread` 创建线程 + 绑定 TLS，12 的 `r15_thread` 是线程在 CPU 上的"热缓存"——`mov reg, [r15 + offset]` 一条指令替代 `pthread_getspecific` 的函数调用开销
- **11-03 mmap → 12 C1/C2 生成的 compressed oops 读写**：11 的 `commit_memory` 分配堆内存，12 的 `r12_heapbase` 让对象指针的压缩/解压只需 1 条 `lea` 指令（`lea rax, [r12 + narrow*8]`）

### 和 08-safepoint 的关系：polling page → testl 指令

08 建立了 safepoint 的协调协议（arm/disarm polling page、mprotect 保护、线程状态阻塞）。12 展示这个协议的 CPU 级实现：
- 08：“线程到达 safepoint 时访问 polling page”
- 12：`testb [r15_thread + offset], bit` + `jne slow` — 这 2 条指令就是"访问 polling page"的机器码
- 08：“JVM arm polling page 让访问触发 SIGSEGV”
- 12：当使用 thread-local poll 时不再用 SIGSEGV——而是直接设置 bit（不触发信号），进一步降低 safepoint 开销

### 和 09-native-interface 的关系：JNI 线程状态 → 汇编 wrapper

09-03 讲解了 JNI 方法调用时的线程状态转换（`_thread_in_vm → _thread_in_native → _thread_in_vm`）。12-03 的 `SharedRuntime::generate_native_wrapper` 生成实际完成这个转换的机器码——`mov [r15_thread + thread_state_offset], _thread_in_native` 这条指令就是状态转换的物理实现。

### 和 07-thread-lock 的关系：Thread 对象 → 寄存器常驻

07 建立了 JavaThread 的 JVM 内生命周期模型。12-01 解释 Thread* 如何被"固化"到硬件：`r15_thread` 是 JavaThread 在 CPU 上的常驻代理。为什么这是一个性能决策？因为在 x86_64 上一条 `mov` 指令读 `[r15 + offset]` 只需 ~3 cycles，而 `pthread_getspecific` → TLS 查找 → 函数调用 → 返回需要 ~50 cycles。对于 JVM 这种每一纳秒都重要的运行时，把最热指针"钉"在寄存器上是 15 倍的加速。

---

## 六、跨模块依赖矩阵

| | cpu/x86 | os_cpu/linux_x86 | runtime (share) | interpreter (share) |
|---|---|---|---|---|
| **01** Frames | frame_x86.cpp, register_x86.hpp, assembler_x86.hpp, registerMap_x86.hpp, javaFrameAnchor_x86.hpp | frame_linux_x86.cpp (sender_for_compiled_frame) | frame.hpp (跨平台 FrameValues) | — |
| **02** Interpreter | templateTable_x86.cpp, templateInterpreterGenerator_x86*.cpp, interp_masm_x86.cpp, macroAssembler_x86.cpp | — | — | templateTable.hpp, templateInterpreterGenerator.hpp |
| **03** Stubs | stubGenerator_x86_64.cpp, sharedRuntime_x86_64.cpp, macroAssembler_x86.cpp, nativeInst_x86.cpp, vtableStubs_x86_64.cpp | — | stubCodeGenerator.cpp, stubRoutines.cpp, sharedRuntime.cpp | — |
| **04** CPUID | vm_version_x86.cpp, vm_version_x86.hpp, vm_version_ext_x86.cpp, assembler_x86.cpp | — | vm_version.cpp, globals.hpp | — |

★ 注意：
- **`cpu/x86/macroAssembler_x86.cpp`** 是唯一被 3/4 篇文档重度引用的文件——02 用它做 safepoint poll + dispatch，03 用它做帧锚点设置 + stub 内联，04 通过 assembler 间接依赖。这是 cpu/x86 模块的核心枢纽文件（10473 行）。
- **`cpu/x86/assembler_x86.hpp`** 定义所有寄存器别名（`r15_thread`/`r12_heapbase`/`rscratch1`/`rscratch2`/`c_rarg0..3`）——这些别名是理解所有 x86_64 JVM 代码的前提，01/02/03/04 全部依赖。
- **`os_cpu/linux_x86/`** 只有 `frame_linux_x86.cpp` 在本文范围内——它是 OS 和 CPU 的粘合层（把 OS 层的信号上下文转换为 CPU 层的帧构建）。`os_linux_x86.cpp` 的 `JVM_handle_linux_signal` 已经在 11 阶段详细覆盖，12 只引用其"stub 入口"部分。
- **`cpu/x86/stubGenerator_x86_64.cpp`**（6126 行）和 **`cpu/x86/sharedRuntime_x86_64.cpp`**（4006 行）是本阶段的巨型文件——03 依赖它们。这两个文件是所有 stub 和 deopt/uncommon trap/JNI wrapper 的生成器。
- **`cpu/x86/vm_version_x86.cpp`**（1749 行）是 04 的核心——它独立于其他 3 篇，但它的输出（`UseSSE`/`UseAVX` flag）是 02/03 代码生成的全局条件。

---

## 七、显式排除的主题（为什么不做）

以下主题有各自的价值，但本阶段刻意不包含：

| 主题 | 排除原因 |
|------|---------|
| **C1/C2 完整代码生成**（`c1_LIRAssembler_x86.cpp`, `c2 的 x86_64.ad` 文件） | C1/C2 的完整代码生成策略属于"编译器阶段"（未包含在当前 12 阶段计划中）。每个编译器有独立的寄存器分配、指令选择、指令调度策略——这需要 2-3 篇独立文档。本阶段只用 C1/C2 的 deopt/uncommon trap/poll 生成的接口——不展开完整的 `mach` 指令选择 |
| **x86 指令编码格式**（ModRM/SIB/REX/VEX/EVEX 前缀字节） | 指令编码是"汇编器手册"级别的内容——`Assembler::emit_int8` / `emit_int16` / `emit_int32` 如何拼装前缀+操作码+ModRM+SIB+位移+立即数。这属于 CPU 厂商的指令编码文档——JVM 只是消费者。本阶段只关心"生成了什么指令的序列"，不关心"每个指令的二进制编码长什么样" |
| **ARM/AArch64 架构对照**（`cpu/aarch64/` 目录） | AArch64 有完全不同的寄存器约定（X28=thread, X29=FP, X30=LR）、不同的调用约定（AAPCS64）、不同的原子操作语义（LDAXR/STLXR vs LOCK CMPXCHG）。并行讲解两个架构会使文档膨胀 2 倍且降低焦点。x86_64 是生产主流，单独聚焦 |
| **微架构优化**（流水线、分支预测、缓存预取、µop 融合） | `MacroAssembler::prefetch`、`rdtsc` 计时、循环展开策略、指令对齐（`.align 16`）——这些是 profile-guided optimization (PGO) 级别的内容。本阶段聚焦"正确性"（生成对的东西）而非"微调"（生成快的东西） |
| **ELF 对象文件格式**（CodeBuffer → nmethod → 写入 CodeCache 的二进制格式） | nmethod 的结构（header + relocation info + oop maps + metadata + instructions + exception handler table）属于"代码缓存管理"专题——和 OS 层的 mmap + CodeBlob 分配耦合更紧，不属于"CPU 指令层"的叙事 |
| **jvmciCodeInstaller_x86.cpp**（Graal/JVMCI 编译器接口） | JVMCI 是 Graal 编译器的接口层——它把 Graal 生成的机器码安装到 CodeCache。JVMCI 本身是一个独立的子系统（c1_LIRAssembler 的"外部平替"），不属于"HotSpot 自己的 CPU 层"叙事 |
| **GC barrier 的汇编实现**（`gc/x86/cardTableBarrierSetAssembler_x86.cpp`, `g1BarrierSetAssembler_x86.cpp` 等 15 文件） | GC barrier 的汇编实现虽然在 cpu/x86 目录下，但其语义完全由 GC 策略决定（CardTable、G1 SATB、Shenandoah Brooks pointer、ZGC 的 colored pointer）。属于 GC 阶段的 x86 扩展，已在 06-gc 和 08-safepoint 中覆盖其逻辑层——本阶段不展开其指令层 |
| **32 位 x86 代码生成**（`*_x86_32.cpp` 文件） | x86_32 在 2024+ 的生产环境中几乎绝迹（JVM 在 JDK 10+ 已不再提供 32-bit 预构建包）。寄存器极度稀缺（8 个 GPR vs 64-bit 的 16 个）、没有 `r15_thread` 常驻、必须用 TLS 查 Thread*——和 64-bit 的设计差异巨大。保留到可能的"历史架构"专题 |
| **方法句柄 + Lambda Form 的汇编适配器**（`methodHandles_x86.cpp`） | MethodHandle 的 invoke adapters（argument shuffling / boxing / unboxing / filtering）是 `java.lang.invoke` 的底层运行时，由一个独立的代码生成器（`MethodHandles::generate_adapter`）生成。虽然它在 cpu/x86 目录下，但它是"MethodHandle 子系统"的 x86 实现，不是"CPU 层基础机制" |
| **模板解释器的全字节码遍历**（所有 200+ 字节码的逐一指令解析） | 02 只用 `iload`/`iadd`/`getfield` 作为代表性示例来讲解模板生成模式。逐一解析 200+ 字节码是"字节码参考手册"，不属于"CPU 层架构"叙事——读者应通过模式理解自行推导其他字节码的生成逻辑 |
| **Vector API 的 SIMD 代码生成**（`VectorSupport` → `macroAssembler_x86_*.cpp` 中的 sin/cos/exp 等超越函数） | `macroAssembler_x86_sin.cpp` 等数学函数文件（sin/cos/log/exp/pow 等）是 Vector API 的运行时库。这些是"Java 标准库的 JIT intrinsic"，不是"JVM CPU 层的架构机制" |

---

## 八、每篇文档的深度问题（写 prompt 时必须覆盖）

以下问题不要求在 README 中回答——它们用于驱动每篇文档的 prompt，确保文档不只是"解释代码"，而是"追问为什么"。

### [01] Frames

1. `frame::safe_for_sender` 检查了什么条件下 sp/fp 是"安全的"？为什么 `frame::frame_size` <= 0 的 CodeBlob 被标记为不安全？`_cb->is_frame_complete_at(_pc)` 的含义是什么——如果一个方法在 prologue 中间崩溃（刚 `push rbp` 还没 `mov rbp, rsp`），`safe_for_sender` 怎么处理？
2. 解释器帧有 `sender_sp` 和 `unextended_sp` 两个概念——为什么不统一？C2 编译帧只有一个 sp——如果 C2 在调用解释器方法时也需要区分这两个 sp（因为解释器帧的局部变量扩展改变了 sp），C2 的 `sender_for_compiled_frame` 怎么应对？
3. `r15_thread` 在 x86_32 上是不可行的——为什么？如果 JVM 在 32 位上用 `rscratch1` 代替 r15_thread，每次方法入口都要从 TLS 重新 load Thread*——这个代价在 64 位上省掉了。但 64 位上的 `r12_heapbase` 也是专用的——如果 `UseCompressedOops` 关闭，r12 能否还给寄存器分配器使用？
4. `JavaFrameAnchor::capture_last_Java_pc` 中 `_last_Java_pc = (address)_last_Java_sp[-1]`——这是读 return address。如果栈被破坏了（`_last_Java_sp` 指向野地址），这次解引用会不会触发第二次 SIGSEGV → 递归崩溃？`make_walkable` 中的 `Thread::current() == (Thread*)thread` assert 能在什么程度上防止这种场景？

### [02] Interpreter

1. 解释器的 dispatch table 用 `jmp [rscratch1 + opcode*8]` 做字节码间跳转。这和 CPU 的返回地址预测器（RSB）有什么关系——为什么 `call` + `ret` 模式会让解释器快 20%，但 HotSpot 不用？
2. `TemplateTable::invokevirtual` 生成的代码中有一大段"快速路径"（检查 receiver 类型是否等于 ConstantPoolCache 中缓存的类型）——如果类型匹配失败走慢路径（调用 `InterpreterRuntime::resolve_invoke`），慢路径的代价是多少？快速路径用了几条指令完成了"虚方法分派"的最常见情况？
3. Safepoint poll 的 thread-local 版本用 `testb [r15_thread + poll_offset], bit` 替代了旧的 global poll（`cmp [global_addr], _not_synchronized`）。为什么这个改动减少了多核系统的 cache line bouncing？poll bit 设置者（safepoint coordinator）怎么保证 bit 的写入对所有线程可见（memory fence 的时机）？
4. `TemplateTable::getfield` 生成的代码中有一个"快速路径"——直接从 ConstantPoolCache 中的 field offset 做 `mov`。但如果 field 是 volatile，同一个 `getfield` 字节码会走到 `TemplateTable::volatile_barrier` 分支——这段指令和普通 `getfield` 的区别在哪几条指令？`lock addl [rsp], 0` 这个"假加法"为什么能充当即时的 StoreLoad barrier？

### [03] Stubs

1. Deopt 的 `unpack` 过程要把编译帧的每个局部变量从 nmethod 的 spill slot / 寄存器搬运到新创建的解释器帧。如果源码中有 200 个局部变量，但 C2 优化后只剩 30 个"活"变量——`unpack` 怎么知道哪些变量已经死了（不需要重建）？nmethod 的 debug info（`ScopeDesc`）如何编码这个信息——是位图还是索引表？
2. `StubGenerator::generate_call_stub` 中 `set_last_Java_frame` 之后、`call` 到 Java 方法之前如果发生了某些不可恢复的错误（如 r15_thread 被破坏），崩溃时会留下什么痕迹在 hs_err 中？`reset_last_Java_frame` 未被调用的后果是什么——下次 GC 栈行走是否会误读已释放的栈区域？
3. Exception handler 的查找通过 `ExceptionCache` 表（一个从 PC 偏移映射到 handler PC 偏移的哈希表）。如果一个方法有 50 个 try-catch 块（嵌套+并排），这个表的查找在 CPU 上需要多少条指令？有没有可能异常处理器查找本身比重新抛异常更贵？
4. `SharedRuntime::generate_native_wrapper` 中线程状态从 `_thread_in_Java` 切换到 `_thread_in_native` 是通过一条 `mov` 指令写入 `[r15_thread + state_offset]`。如果 JVM 在这条 `mov` 之后、`call native_function` 之前的瞬间发生 safepoint——GC 是否看到一个 _thread_in_native 的线程？GC 怎么处理它（不扫描它的栈 oop map 因为 native 代码无 oop map）？

### [04] CPUID

1. `VM_Version_StubGenerator::generate_get_cpu_info` 通过修改 EFLAGS 的 AC 位来检测 CPU 是否支持 CPUID——如果 AC 位修改失败 = 386，如果 ID 位修改失败 = 486 不支持 CPUID。但在虚拟化环境中（如某些云服务器的 CPUID 模拟），guest 看到的 EFLAGS 行为可能与真实 CPU 不同——哪些虚拟化技术会让 EFLAGS 检测给出错误结果？
2. CPUID leaf 7 sub-leaf 0 返回了 AVX2/BMI1/BMI2 的支持情况。但 Intel 在某些移动版 CPU 上硬件支持 AVX2，BIOS 却在 boot 时禁用了 `xsave` 的 YMM 状态保存——JVM 在探测 AVX2 时只检查 CPUID 的 bit，还是也检查 `xgetbv` 的 XCR0 寄存器来确认 OS 支持？
3. `UseAVX=3` 并不是简单地"有了 AVX-512 就用"——JVM 内部检查了一个叫做 `avx512_cpu_features()` 的函数，它额外验证了 AVX-512 的三个子集（F/CD/BW/DQ/VL 等）。为什么需要这么细粒度的检查？是不是因为某些早期 Skylake-SP 只支持 AVX-512F 但不支持 AVX-512BW（字节/字操作）？
4. SIGILL 的恢复机制：`_cpuinfo_segv_addr` 和 `_cpuinfo_cont_addr` 之间跳转。如果 SIGILL 发生在 `_cpuinfo_cont_addr` 恢复路径本身——比如恢复指令也触发了 SIGILL（因为恢复逻辑依赖的寄存器状态被第一个 SIGILL 破坏了）——有没有"双层 SIGILL"的防护？

---

(End of file)
