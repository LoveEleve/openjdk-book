# PROMPT: 请撰写 03-Stubs.md

## §〇 背景与生产场景

### 你在 crash dump 中看到的真实 stub 调用

凌晨 3 点，线上 JVM 崩溃。hs_err 文件的 Native frames 段：

```
Native frames: (J=compiled Java code, j=interpreted, Vv=VM code)
V  [libjvm.so+0x1a3c4d]  Deoptimization::fetch_unroll_info_helper(JavaThread*, int)+0x2d
V  [libjvm.so+0x1a5b2a]  Deoptimization::unpack_frames(JavaThread*, int)+0x11a
V  [libjvm.so+0x8f1e00]  Deoptimization::uncommon_trap_inner(JavaThread*, int)+0xe0
v  ~DeoptimizationBlob
V  [libjvm.so+0x45a2b1]  SharedRuntime::generate_deopt_blob()
V  [libjvm.so+0x67c830]  InterpreterRuntime::throw_StackOverflowError(JavaThread*)
```

你注意到 `v  ~DeoptimizationBlob` ——这不是一个 C++ 函数名（前面没有 `::`）。这是一个 **stub blob**——运行时动态生成的机器码片段。反汇编这段地址：

```asm
; deoptimization blob 的 unpack 入口（真实 PrintAssembly 输出片段）
0x00007f8b16017000: push   rbp
0x00007f8b16017001: mov    rbp, rsp
0x00007f8b16017004: push   r15                          ; 保存 JavaThread*
0x00007f8b16017006: push   r14
0x00007f8b16017008: push   r13
...
0x00007f8b16017020: mov    rsi, r15_thread               ; 参数1 = JavaThread*
0x00007f8b16017023: call   0x00007f8b1a3c4a0             ; call Deoptimization::unpack_frames
0x00007f8b16017028: pop    r13
0x00007f8b1601702a: pop    r14
0x00007f8b1601702c: pop    r15
0x00007f8b1601702e: leave
0x00007f8b1601702f: ret
```

你会问：
- 这 30 条指令不在 libjvm.so 中——它们从哪里来？
- 谁负责生成 deopt blob 的 unpack 代码？在哪个 .cpp 文件的哪个函数？
- 为什么 deopt 这么昂贵（~5000 cycles vs 正常调用的 ~20 cycles）？
- `~DeoptimizationBlob` 和 `V [libjvm.so+...] Deoptimization::unpack_frames` 是什么关系？

### 在 `-XX:+PrintAssembly` 输出中看到的 call stub

```asm
; call_stub 的真实反汇编片段
0x00007f8b16000180: push   rbp
0x00007f8b16000181: mov    rbp, rsp
0x00007f8b16000184: sub    rsp, 0x50
0x00007f8b16000188: mov    [rbp - 8], rbx                ; 保存 C caller 的 callee-saved regs
0x00007f8b1600018c: call   0x00007f8b160000a0             ; set_last_Java_frame
0x00007f8b16000191: mov    rbx, [rsi + 0x10]             ; 加载 method 的 entry_point
0x00007f8b16000195: mov    rdi, [rsi + 0x20]             ; 加载参数
0x00007f8b16000199: call   rbx                           ; ★ 跳转到 Java 方法入口
0x00007f8b1600019b: call   0x00007f8b160000b0             ; reset_last_Java_frame
0x00007f8b160001a0: test   rax, rax                       ; 检查 exception?
0x00007f8b160001a3: jne    0x00007f8b160001c0             ; rax != NULL → forward exception
0x00007f8b160001a5: add    rsp, 0x50
0x00007f8b160001a9: pop    rbp
0x00007f8b160001aa: ret
```

这里面标注了 `set_last_Java_frame` → `call rbx`（跳转 Java 方法）→ `reset_last_Java_frame` 的三明治结构——这是 C→Java 调用的唯一入口。

### 你在 `perf top` 中看到的 deopt 热点

```
Overhead  Symbol
  2.34%   ~DeoptimizationBlob            # 去优化自身
  0.87%   Deoptimization::unpack_frames  # 帧拆解
  0.31%   Deoptimization::fetch_unroll_info  # 读取 deopt metadata
```

deopt 是 JVM 中最昂贵的单次操作——一次 deopt = ~5000-10000 cycles = 正常方法调用（~20 cycles）的 250-500 倍。这就是为什么 C2 编译器如此激进地避免 deopt——deopt 一次的代价可以买 500 次正常调用。

## §一 任务 + 核心叙事

读者已学完 [12-01-Frames]——理解了 x86_64 栈帧布局、r15_thread/r12_heapbase 的寄存器绑定、sender_sp/unextended_sp 的帧行走机制。读者已学完 [12-02-Interpreter]——理解了 TemplateTable 如何生成字节码模板、dispatch table 如何分发、safepoint poll 的指令实现。读者已学完 [11-os-layer]——理解了信号处理器 `JVM_handle_linux_signal` 的 6 路信号分流（polling page / implicit null / stack overflow / SIGBUS / JNI fast get field / crash）。

现在该看 **JVM 的"暗物质"——运行时动态生成但不在任何 .cpp 文件中能看到最终形态的 stub 机器码**。Exception stub 如何从抛出点跳转到异常处理器？Deoptimization stub 如何把 C1/C2 编译帧"拆解"回解释器帧？Call stub 如何实现 C→Java 的调用？Safepoint poll 的慢路径 stub 做了什么？

### ★ 这不是 x86 stub 实现教程

**本文不是 stub 函数实现教程**——不讲 `__attribute__((naked))` 的编译器差异、不讲手工汇编的技巧（手写 `emit_int8(0x50)` 的编码细节）、不讲 `CodeBuffer::expand()` 的内部实现。本文只关心 **JVM 运行时如何生成异常分发、去优化、safepoint 处理的机器码片段**——这些片段不在 C++ 编译器输出中，而是 JVM 在启动时用 `MacroAssembler` 动态生成的。

**本文不是 CodeCache 管理教程**——不讲 CodeHeap 的分配/分段/回收算法、不讲 nmethod 的 versioned dependency / zombie / unloaded 状态机、不讲 CodeCache sweeper 的周期性清理策略。本文只关心 **stub 生成时的 CodeBuffer→CodeCache 安装流程**和 **stub 在 CodeCache 中的存活周期（immortal—永不被 GC 回收）**。

**本文不是 deoptimization 的完整协议教程**——不讲 ScopeDesc 的编码格式（sender、bcp、method、locals 的 bitfield 布局）、不讲 `vframeArray` 的构造和释放、不讲 `VM_Deoptimize` 的 VM_Operation 框架。本文只关心 **deopt stub 的机器码——这 30+ 条指令的逐条分解**。

### ★ 你需要知道的（零 x86 知识的 Java 工程师在进入源码前必须理解的 4 个概念）

#### 概念 1：stub 在 CPU 层级到底是什么

在一个普通 C++ 程序中，`main()` → `foo()` → `bar()` 的每条指令都来自编译器的输出——你可以在 `objdump -d libfoo.so` 中找到每一字节的机器码。但 JVM 不是普通程序：它除了执行 C++ 编译后写入 `libjvm.so` 的指令，还在**运行时动态生成**大量机器码并跳转过去执行。

一个"stub"就是这样一段动态生成的机器码片段——它不在 `libjvm.so` 中，不在任何 C++ 编译单元的 `.text` 段，而是由 `StubGenerator`（继承自 `StubCodeGenerator`）在 JVM 启动时在堆内存中拼装字节流，然后被 CPU 当作指令执行。每个 stub 是一个"指令序列"——开头的 `push rbp; mov rbp, rsp` 和结尾的 `pop rbp; ret` 与你熟悉的 C 函数无异——只是没经过编译器。它不像 Java 方法（有 Method* 对象、有字节码），也不是解释器发出的单字节码模板——stub 是一个独立的"适配器"：连接不同执行模式（C↔Java、正常路径↔异常路径、编译↔解释）。

**为什么需要动态生成而不是编译时写死在 C++ 里？** 因为 stub 的指令宽度、SIMD 指令版本、寄存器使用取决于运行时才能确定的 CPU 特性（UseSSE/UseAVX/UseCompressedOops）。编译时写死在 C++ 中无法根据这些条件选择指令——而 `MacroAssembler` 在运行时检查 flag，生成对应的最优指令序列。

#### 概念 2：nmethod / CodeBuffer / CodeCache 的生命周期

JVM 生成的机器码（包括 stub 和编译后的 Java 方法）经历三个对象的生命周期：

1. **CodeBuffer**（代码缓冲区）— 指令"拼装台"：`MacroAssembler` 通过 `emit_int8(0x50)`（push）、`emit_int32(relative_offset)`（call relative）逐字节追加到 CodeBuffer。CodeBuffer 内部是一个可增长的字节数组，最终持有完整的 x86_64 指令二进制流。此阶段还没有地址——所有跳转目标都是占位符/标签（Label），通过 `bind(label)` 在最后才绑定到真实偏移。
2. **CodeCache**（代码缓存）— 指令"执行区"：CodeBuffer 的内容被复制/安装到 CodeCache（一片由 mmap 分配的可执行内存区域，属于 CodeHeap）。安装时所有标签被解析为真实 PC 地址，relocations（重定位信息）被写入，oop maps（GC 所需的栈引用位图）被编码。CodeCache 中的每个 blob 都以 `CodeBlob` 子类的形式管理——它是运行时"可执行机器码"的容器。
3. **nmethod**（编译方法）— 一个"完整包装"：当 C1/C2 编译完一个 Java 方法后，CodeBlob 被包装为 nmethod——它额外包含 exception handler table、deoptimization info（`ScopeDesc` 描述栈帧与源码变量的映射）、inline caches、编译级别标记、依赖记录（用于无效化）等。nmethod 是 CodeCache 中最"重"的实体（几 KB 到几 MB），而 bare stub（RuntimeStub）只有几百字节。Stub 也是 CodeBlob 但包装更轻。

为什么分层？CodeBuffer 是"工作区"（可丢弃重建），CodeCache 是"成品区"（持久、可执行），nmethod 是"带元数据的成品"（可被 GC 卸载、可被无效化）。

#### 概念 3：spill slot（在编译帧 deopt 语境中的含义）

在 [12-01] 的帧布局中，spill slot 是"编译器寄存器不够用时溢出到栈的槽"。在 deoptimization 语境中，spill slot 有一个额外的关键角色——它是**编译帧和解释器帧之间的"数据桥梁"**。

C2 编译的方法不维护"操作数栈"概念——所有中间值要么在寄存器中，要么在 spill slot 中（栈上固定偏移的槽）。当 C2 被 deopt 回到解释器时，deopt handler 需要把每个"活"的局部变量从它的"当前存放位置"（某个寄存器的值 或 某个 spill slot 的内存值）搬运到新构建的解释器帧的 locals 区域。寄存器的值可以直接 `mov`，spill slot 的值需要从栈上原编译帧位置读取再写入新解释器帧位置。这个"搬迁"是 deopt 最昂贵的部分——每个"活"变量都需要至少一条 `mov` 指令，对于大方法可能数百次内存操作。

#### 概念 4：epilogue（尾声——被生成例程的结尾汇编序列）

在汇编语境中，每个函数的完整执行序列分为三部分：**prologue**（序言——设置栈帧）、**body**（函数体——实际逻辑）、**epilogue**（尾声——拆帧并返回）。epilogue 是 prologue 的逆操作：

```asm
; Epilogue（退出时）
mov rsp, rbp        ; 回收局部变量空间（等价于 leave 指令）
pop rbp             ; 恢复 caller 的帧指针
ret                 ; 弹出栈顶 return address 并跳转回 caller
```

在 JVM stub / 编译方法的语境中，epilogue 不只是"恢复 rsp/rbp 然后 ret"——它还承担关键的状态清理：`reset_last_Java_frame(r15_thread)` 把 `_last_Java_sp/fp/pc` 清零（告诉 C++ 端"已离开 Java 执行"），恢复可能被方法体修改过的 callee-saved 寄存器（r12-r15），以及条件分支——如果异常发生则走不同的退出路径（跳转到 `forward_exception_entry` 而不是 `ret` 回正常 caller）。

在本文的 Exception stub 讨论中，"caller 的 epilogue 检查 rax"意味着：caller 的 epilogue 在恢复寄存器后、ret 之前，检查 rax 是否为 NULL——非 NULL = 异常 oop，需要跳过正常返回值处理并调用异常分发 stub。

### 核心叙事线 — "JVM 运行时生成的 4 类暗物质"

[12-01] 建立了帧布局坐标系。本文的 deopt stub 使用这个坐标系：从编译帧的 spill slot / 寄存器读值 → 写入新的解释器帧。**Deopt 本质上是一次"帧布局的转换"**——从编译帧的固定 spill slot 布局转换为解释器帧的 locals/monitor/expr 布局。

[12-02] 建立了字节码→机器码的生成链。本文的 exception stub + deopt handler 把自己的输出插入到这条链中——当编译帧被"拆解"回解释器时，重新执行字节码序列。

[11-os-layer] 的 `JVM_handle_linux_signal` 做 6 路信号分流。每个分流目标都是一个 **stub 入口**（12-03 生成的机器码）。[11] 讲 "if 分支"，[12-03] 讲 "每个分支里的机器码序列"——信号和机器码的"手递手接力"。

### 验证报告
- `sverklo_search "StubGenerator::generate_call_stub generate_deopt_blob generate_forward_exception generate_catch_exception"` → stubGenerator_x86_64.cpp, sharedRuntime_x86_64.cpp
- `codegraph query "SharedRuntime::generate_deopt_blob"` → sharedRuntime_x86_64.cpp:~2813
- `rg -n "set_last_Java_frame\|reset_last_Java_frame\|safepoint_poll" macroAssembler_x86.cpp` → 帧锚点 + poll
- `rg -n "StubGenerator\|StubCodeGenerator\|stubRoutines" stubGenerator_x86_64.cpp stubRoutines.cpp` → stub 工厂和注册中心
- `rg -n "NativeInstruction::is_safepoint_poll\|is_call\|is_nop" nativeInst_x86.cpp` → 指令反识别

## §二 标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+PrintAssembly`
- 64 位 Linux x86_64
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ hsdis（HotSpot Disassembler）安装用于 PrintAssembly 输出中 stub 段的反汇编

## §三 聚焦源文件

| # | 文件 | 路径 | 模块 | 核心函数/类 | 本文角色 |
|---|------|------|------|-----------|---------|
| 1 | `stubGenerator_x86_64.cpp` | `src/hotspot/cpu/x86/stubGenerator_x86_64.cpp` | cpu/x86 | `StubGenerator::generate_call_stub`(:~209), `generate_forward_exception`, `generate_catch_exception`, `generate_atomic_*`, `generate_arraycopy` | ★★★ Stub 总工厂——所有经典 stub 的生成器 |
| 2 | `sharedRuntime_x86_64.cpp` | `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp` | cpu/x86 | `SharedRuntime::generate_deopt_blob`(:~2813), `generate_uncommon_trap_blob`, `generate_native_wrapper`, `generate_handler_blob` | ★★★ 运行时 Stub——deopt + uncommon trap + JNI wrapper |
| 3 | `macroAssembler_x86.cpp` | `src/hotspot/cpu/x86/macroAssembler_x86.cpp` | cpu/x86 | `safepoint_poll`(:3744), `set_last_Java_frame`, `reset_last_Java_frame`, `get_thread` | ★★ Safepoint 慢路径 + 帧锚点——线程长驻操作 |
| 4 | `nativeInst_x86.cpp` | `src/hotspot/cpu/x86/nativeInst_x86.cpp` | cpu/x86 | `NativeInstruction::is_safepoint_poll`, `is_call`, `is_nop`, `is_jump`, `is_cond_jump` | ★ 指令识别——运行时反汇编读取（用于 safepoint 解析等） |
| 5 | `vtableStubs_x86_64.cpp` | `src/hotspot/cpu/x86/vtableStubs_x86_64.cpp` | cpu/x86 | `VtableStub` 生成——虚方法分派 | ★ 虚方法分派 stub |
| 6 | `stubCodeGenerator.cpp` | `src/hotspot/share/runtime/stubCodeGenerator.cpp` | runtime | `StubCodeGenerator` 基类——CodeBuffer 分配 + 接口 | ★ Stub 框架基类 |
| 7 | `stubRoutines.cpp` | `src/hotspot/share/runtime/stubRoutines.cpp` | runtime | `StubRoutines::initialize` + 所有 stub 入口存储 | ★ Stub 注册中心——存储每个 stub 的入口地址 |
| 8 | `sharedRuntime.cpp` | `src/hotspot/share/runtime/sharedRuntime.cpp` | runtime | `SharedRuntime::generate_stubs`（跨平台调度） | ★ 跨平台 stub 生成调度器 |

**跨模块说明**：Stub 生成横跨 `cpu/x86/`（x86_64 专有生成器）和 `share/runtime/`（跨平台基类）。`stubGenerator_x86_64.cpp`（6126 行）和 `sharedRuntime_x86_64.cpp`（4006 行）是本阶段的两个巨型文件——它们生成了除解释器模板之外的全部运行时机器码。`macroAssembler_x86.cpp`（10473 行）提供所有被 stub 生成器调用的汇编助手函数。

## §四 必须深度走读的核心概念（≥6 组，source-code-driven，"why X not Y" 风格）

> 每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ Stub 的 4 种类别和生成时机

```
问题：
  ① JVM 启动时生成了多少 stub？分为哪 4 类，各自的生成阶段是什么？
      线索: stubGenerator_x86_64.cpp + sharedRuntime_x86_64.cpp + stubRoutines.cpp
      答案方向: 4 类 stub 按生成阶段排列：
      1. Calling Convention Stubs（启动早期——VM 初始化阶段）：call_stub（C→Java）、catch_exception、
         forward_exception——启动时生成，永不修改，immortal。
      2. Exception/Deopt Stubs（SharedRuntime 初始化阶段）：deopt_blob、uncommon_trap_blob、
         exception_handler——在 SharedRuntime 初始化时生成。
      3. Safepoint Stubs（SafepointSynchronize 初始化）：poll 的慢路径——注册到 StubRoutines。
      4. GC Barrier Stubs（GC 子系统初始化时）：card table write barrier、G1 SATB barrier
         的快速路径——由各 GC 的 barrier Assembler 生成。
      追问: 总共约 40+ 个 stub。各自 100-10000 字节不等。

  ② 为什么 stub 是 immortal（永不被 GC 回收）？
      线索: RuntimeStub 的生命周期
      答案方向: stub 在 JVM 启动时一次性生成，之后整个进程期间持续使用。(a) 它们的入口地址存储在
      StubRoutines 类的 static 变量中——所有线程共享同一入口。(b) call_stub 是每个 Java 方法调用
      的唯一 C→Java 入口——如果被回收，JVM 无法调用任何 Java 方法。(c) exception stub 和 deopt
      stub 是异常/去优化的"逃生通道"——如果被回收，任何异常都会导致 JVM 无路可走 → 崩溃。
      所以 stub 被分配为 immortal CodeBlob（`is_immortal() == true`），可以安全地被所有线程
      随时引用——不需要 safepoint 来保证一致性。

  ③ StubRoutines 的作用是什么——为什么每个 stub 入口地址都存储在一个 static 变量中？
      线索: stubRoutines.cpp stubRoutines.hpp
      答案方向: StubRoutines 是一个"全局 stub 目录"——存储了所有运行时 stub 的入口函数指针。
      例如 `StubRoutines::x86::call_stub_entry`、`StubRoutines::x86::catch_exception_entry`、
      `StubRoutines::x86::atomic_cmpxchg_entry` 等。任何代码需要调用 stub 时，通过这个目录
      查找入口地址——不需要知道 stub 在 CodeCache 中的实际位置。这解耦了"谁是 stub 用户"
      和"stub 在哪"——stub 在 CodeCache 中的位置可以变化（因 CodeCache 分配算法），但入口
      指针不变（每次安装后更新 static 变量）。
```

### 4.2 ★★★ Deoptimization blob — 完整的 CPU 路径

```
问题：
  ① 编译代码如何触发 deoptimization？从 C2 插入的 UncommonTrap 到重建解释器帧的全过程是什么？
      线索: sharedRuntime_x86_64.cpp generate_deopt_blob ∼2813, deoptimization.cpp unpack_frames
      答案方向: 完整的 deopt 路径（从 CPU 指令角度）：
      1. C2 在编译时在 safepoint 位置插入 Deoptimize IR node → 生成 `int 3`（SIGTRAP）或
         `call deopt_blob_unpack_entry` ——两种触发方式
      2. CPU 执行到 deopt 点 → trap/call → 进入 JVM 信号处理器或直接进入 deopt blob
      3. deopt blob 保存所有 callee-saved 寄存器（push r15/r14/r13/rbx/rbp）
      4. 在 rsi 中传入 JavaThread* → call Deoptimization::unpack_frames(thread, mode)
      5. unpack_frames 从 nmethod 的 debugInfo 中读取每个变量位置（寄存器/spill slot）
      6. 为每个活变量生成 `mov` 指令：从 [spill_slot + offset] 或 register → 写入新解释器帧的 locals 槽
      7. 重建解释器帧的 method*/bcp/locals*/constPool* 指针
      8. pop callee-saved 寄存器 → jmp 到 deopt 后的解释器继续位置

  ② 为什么 deopt 在 CPU 层面这么昂贵？每一步的 cycle 计数是多少？
      答案方向: 分析每一步的 CPU 成本：
      1. Trap/信号 (如果通过 int 3 触发): ~1000 cycles — 信号上下文保存所有寄存器到栈 + 用户/内核切换
      2. 读取 deopt info: ~500 cycles — 从 nmethod 的 debugInfo 中解析 ScopeDesc 链
      3. Unpacking: ~2000 cycles — 遍历每个变量，对每个活变量执行 `从源位置读取 → 写入新帧位置`
         （如果有 100 个活局部变量 = 100 次 mov + lea）
      4. 帧重建: ~200 cycles — 重新构造 interpreter frame + 设置 method/bcp/locals/constPool 指针
      5. 跳转到解释器: ~20 cycles — 跳转 + 恢复执行
      总代价: ~5000-10000 cycles = 正常方法调用 (~20 cycles) 的 250-500 倍。
      ★ 关键洞察：deopt 的主要开销来自 unpack（2000+ cycles）不是因为 deopt 算法复杂——
      而是因为 C2 优化了太多后导致"死"变量变少、计算中间值变多→每个"活"变量都要搬运→O(live_vars)。

  ③ 为什么 C2 的 unpack 知道哪些变量是"活的"——nmeth 的 debug info 怎么编码这个信息？
      线索: ScopeDesc 编码格式, debugInfo.hpp
      答案方向: 每个 safepoint 位置的 debug info 包括：
      (a) 哪些局部变量在当前 bcp 是活的——一个 bitmask（和 JVMS 规范中的 LocalVariableTable 本质上一致）
      (b) 每个活变量的"物理存储位置"——寄存器号（如 rax=0, rcx=2, r8=5, xmm0=16）或 spill slot 偏移
      (c) 哪些 OOP 在栈/寄存器中——一个 bitmap 让 GC 扫描
      (d) 当前 bcp 偏移
      整个 ScopeDesc 链用压缩的 bit-field 编码存储——这就是 nmethod 中 metadata 区的核心数据。
      追问: 为什么不是数组而是 bitfield？→ ScopeDesc 链需要在运行时高效解析——bitfield 允许
      在位操作上在 <1 cycle 内提取信息（`and`/`shl`/`shr` → 比解压数组快）。

  ④ generate_deopt_blob 生成的 blob 有哪 3 段？各处理不同的 deopt 触发场景
      线索: sharedRuntime_x86_64.cpp generate_deopt_blob
      答案方向:
      1. `unpack` — UncommonTrap（编译时预期不执行的路径实际被命中了）
      2. `unpack_with_exception` — deopt 时还带着未处理的异常（从 nmethod 中抛出异常的同时需要 deopt）
      3. `unpack_uncommon_trap` — speculative 优化的回退路径（C2 做了激进内联/dead code elimination 后
         发现假设不成立）
      这 3 段的区别主要在于传入 Deoptimization::unpack_frames 的 mode 参数——不同 mode 对应
      不同的帧重建策略（是否同时重建 pending exception、是否保留当前帧中的 OOP）。
```

### 4.3 ★★★ call_stub — C → Java 的唯一入口

```
问题：
  ① call_stub 为什么是 C→Java 的唯一入口？
      线索: JavaCalls::call() → call_stub(JavaThread*, method, args, result), stubGenerator_x86_64.cpp:209
      答案方向: 任何 C++ 代码要调用 Java 方法都必须经过 call_stub——因为 C calling convention 和
      Java calling convention 不同（参数顺序/GPR/浮点等）。call_stub 充当适配器——从 C ABI 收参→
      转换为 JVM internal convention → 跳转到 Java 方法入口 → 返回值转回 C ABI。包括：
      (a) JVM 启动的 main() → 解释器或 C2
      (b) JVMTI agent 调 RedefineClasses → 重新执行类初始化器
      (c) GC 的 ReferenceProcessor → 调用 Reference.get() 等
      (d) JNI → 内部 native wrapper（但也通过 call_stub 的变体或 SharedRuntime::generate_native_wrapper）

  ② call_stub 的核心指令序列——为什么是"三明治"结构？
      线索: stubGenerator_x86_64.cpp generate_call_stub
      代码引证（逻辑等价，非精确源码）:
        set_last_Java_frame(r15_thread, rsp, rbp, return_pc)  // 1. 保存 Java 帧锚点
        call java_entry_point                                   // 2. 跳转到 Java 方法
        reset_last_Java_frame(r15_thread)                       // 3. 清除锚点
      答案方向: "三明治"结构：set → call Java → reset。set_last_Java_frame 告诉 C++ 端"Java 帧的边界在哪"——
      如果 GC 或信号在 Java 代码执行期间发生，栈行走器从这三个字段出发找到 Java 帧。
      reset_last_Java_frame 在 Java 方法返回后清除这个锚点——因为 Java 帧已经不存在了。
      如果 set 没清除 → GC 会继续认为有 Java 帧 → 可能扫描已经被回收的栈区域。

  ③ 为什么 call_stub 需要同时处理异常路径（test rax, rax → jne exception_dispatch）？
      答案方向: Java 方法可以通过 throw 抛出异常——在 CPU 层面，方法返回时 rax 存储返回值（如果正常返回）
      或 exception oop（如果异常）。call_stub 在 `call java_entry_point` 后检查 rax：
      - rax = NULL → 正常返回（void 方法）
      - rax = NON-NULL + 正常值 → 正常返回的返回值
      - rax = NON-NULL + exception oop → 异常返回
      区分方式：如果 rax 指向的对象是 exception oop，call_stub 调用 forward_exception stub——
      这个 stub 把 pending exception 重新抛出给 C++ 端。
```

### 4.4 ★★ Exception stub — 异常在 CPU 上的传播

```
问题：
  ① C2 编译方法 throw exception 后，CPU 怎么找到 handler？
      线索: 编译代码的 exception handler table（nmethod 中的 ExceptionCache），SharedRuntime::exception_handler_for_return_address
      答案方向: C2 编译方法中每个 call site 后都有 implicit exception check。当 callee 返回时：
      1. rax = exception oop（非 NULL）→ caller 的 epilogue 检测此
      2. caller 从 exception handler table 中查找 handler——table 按型如 (pc_offset, handler_pc_offset)
         的条目组织，其中 pc_offset 是抛出点的偏移
      3. 如果找到 handler → `jmp handler_pc` → caller 开始执行 catch 块
      4. 如果当前方法没有匹配的 handler → 重复上面过程到 caller 的 caller → 逐帧 unwind
      5. 如果遍历整个 Java 调用栈都没有 handler → JavaThread 检查自身是否有 handler
         （Thread 级别的未捕获异常 handler）→ 打印 stack trace

  ② StubGenerator 中的 generate_forward_exception 是干什么的？和正常异常处理有什么不同？
      线索: stubGenerator_x86_64.cpp generate_forward_exception, generate_catch_exception
      答案方向: forward_exception 是"C++ Runtime 检测到 pending exception 但不想立即处理"时的清理
      机制。当 Runtime 函数完成工作发现 Thread 中有 pending exception，它调用 forward_exception_entry
      这个 stub→ 把 pending exception 从 Thread 对象的 pending_exception 字段取出 → 放入 rax →
      设置标志位 → `jmp` 回到调用者（跳过了 Runtime 的剩余代码）。然后调用者看到 rax = exception oop
      → 走正常的异常分发路径。catch_exception 是另一个分支——它处理"在 Runtime 调用途中发生异常"的
      情况——原地捕获异常、进行清理后继续执行。
```

### 4.5 ★★ Safepoint poll 的慢路径 stub — 从 testb + jne 到 SafepointSynchronize::block

```
问题：
  ① poll 检测到 safepoint 请求后，slow path 的指令序列做了什么？
      线索: safept_poll 的 slow_path label, macroAssembler_x86.cpp safepoint_poll + SafepointSynchronize::block
      答案方向: 从 testb + jne slow_path 跳转到 slow_path 后的指令序列：
      1. push rax/rcx/rdx/rsi/rdi/r8-r11 等 caller-saved 寄存器（因为即将调用 C++ 函数，这些寄存器的内容可能被破坏）
      2. 保存 rsp/rbp 到 Thread 对象（如果还没保存——通常 set_last_Java_frame 已做）
      3. mov rdi, r15_thread — 传入 JavaThread* 参数
      4. call SafepointSynchronize::block(JavaThread*) — C++ 函数调用
      5. SafepointSynchronize::block 内部：设置线程状态为 _thread_blocked → 等待 safepoint 结束 → 恢复线程状态
      6. 返回后 pop 保存的 caller-saved 寄存器
      7. jmp 回到 poll 点之后继续执行（dispatch_next）
      这个 slow path 的代价：~500-1000 cycles。只在 safepoint 期间发生（通常几百 ms 一次 GC）——远比快路径贵，
      但频率低，所以总开销可接受。

  ② 为什么 slow path 是一个 stub 而不是 inline 代码？
      线索: macroAssembler_x86.cpp safepoint_poll 的生成逻辑
      答案方向: 如果 slow path 被 inline 在每个 poll 点——每个 backedge 和方法返回前都嵌入 ~30 条指令
      （push/pop/call）。这会显著增加解释器的 code size → I-cache 污染 → 反降性能。
      用 stub 方式：poll 点只生成 testb + jne 2 条指令（~7 字节），jne 跳转到一个共享的 slow_path
      stub（~100 字节，所有 poll 点共用）→ code size 从 ~30×N 降至 7×N + 100。
      这就是为什么 safepoint slow path 是 stub——空间效率。
```

### 4.6 ★★ JNI wrapper 的汇编实现 — SharedRuntime::generate_native_wrapper

```
问题：
  ① 当一个 Java 方法声明为 native 时，调用者怎么跳转到 native 实现？
      线索: sharedRuntime_x86_64.cpp generate_native_wrapper
      答案方向: 编译器（C1/C2）为 native 方法生成一个特殊的 wrapper stub：
      1. 从 Java 帧中复制参数到 C calling convention 寄存器（rdi/rsi/rdx/rcx/r8/r9 + 栈参数）
      2. mov [r15_thread + thread_state_offset], _thread_in_native — 线程状态切换
      3. call native_function — 调用实际的 native 实现
      4. mov [r15_thread + thread_state_offset], _thread_in_vm — 或 _thread_in_native_trans（如果 GC 需要 blocked）
      5. 如果有 pending exception in Thread → 处理异常
      6. 返回值转回 Java format（如果有返回值）
      7. safepoint check（如果 native 调用耗时较长）
      8. 返回调用者

  ② 如果 JVM 在线程状态切换到 _thread_in_native 后、call native_function 之前到达 safepoint——
      GC 能看到这个线程吗？它会怎么做？
      线索: 线程状态 _thread_in_native 对 GC 的含义
      答案方向: 当线程状态 = _thread_in_native，GC 的行为：
      - GC 看到这样的线程 → 线程被认为"在 native 中" → GC 不扫描它的栈（因为 native 帧没有 oop map）
      - 如果线程在 `call native_function` 之前（还没调用 but 状态已切换）→ native 函数的 oop 引用可能仍在
        栈上（但 GC 已经决定不扫描）→ ？不，JVM 在状态切换前必须确保所有 oops 已经保存在 "handles" 中
        （全局 root 可达）或在 safepoint 前被 GC 扫描的 Java 帧中。所以栈上的 oops 在 _thread_in_native
        切换前已经被"锚定"到全局 Handle → GC 能通过全局 root 找到它们。
```

### 4.7 ★★ 和 [12-01] + [12-02] + [11-os-layer] + [09-native-interface] 的连接

```
问题：
  ① 和 [12-01] Frames 的连接——deopt stub 使用帧布局做"帧拆解"
      答案方向: deopt 的解包算法需要从编译帧中读取变量值并写入新的解释器帧。这需要知道：
      (a) 编译帧中 spill slot 的偏移 → 来自 C2 编译时预定的 frame_size 和 spill 分配
      (b) 解释器帧中 locals/monitor/expr 的偏移 → 来自 [12-01] 的 interpreter_frame_* 偏移常量
      deopt unpack = 编译帧坐标系 → 解释器帧坐标系的转换——两个坐标系都定义在 [12-01] 中。

  ② 和 [12-02] Interpreter 的连接——deopt 从解释器帧重新执行字节码
      答案方向: deopt 完成后跳到解释器继续执行。这意味 deopt 重新进入 [12-02] 的模板解释器——从
      deopt 之后的 bcp 开始 dispatch 字节码。Deopt 的"产品"是一个完整的解释器帧——和 generate_normal_entry
      生成的初始帧有相同的格式——所以模板解释器的 dispatch_next 可以无缝接管。

  ③ 和 [11-os-layer] 的信号连接——信号处理器分发到异常/去优化 stub 入口
      答案方向: [11-01] 的 JVM_handle_linux_signal 做 6 路分流：
      - SIGSEGV on polling page → handle_polling_page_exception() → safepoint stub
      - SIGSEGV implicit null check → forward_exception_entry → NullPointerException
      - SIGTRAP → deopt stub → 帧重建
      - SIGBUS / SIGSEGV crash → VMError::report_and_die (无法恢复)
      每一路都对应 [12-03] 的一个 stub 入口——信号处理器的"if 分支"和 stub 的"机器码序列"是对应的两端。

  ④ 和 [09-native-interface] 的连接——JNI wrapper stub 和 native method 入口
      答案方向: [09-03] 讲解了 JNI 方法调用时需要穿越的线程状态转换模型（_thread_in_vm → _thread_in_native
      → _thread_in_vm）。本文的 generate_native_wrapper 生成了实际完成这些状态转换的机器码——
      `mov [r15_thread + thread_state_offset], _thread_in_native` 就是 [09-03] 描述的物理实现。
```

## §五 文章结构（ASCII 图）

```
§〇 源文件清单（跨 cpu/x86 + runtime，标注模块归属和每个文件在 stub 生成中的角色）

§一 ★ 全景：Stub 的 4 种类别和生成时机
  ❓ JVM 启动时生成了多少 stub？分为哪 4 类？
  ❓ 为什么 stub 是 immortal（永不被 GC 回收）？
  1.1 4 类 stub 的生成时序——启动早期 → SharedRuntime → Safepoint → GC
  1.2 StubRoutines——全局 stub 目录的 static 入口指针
  1.3 CodeBuffer → CodeCache → RuntimeStub 的安装流程

§二 ★★★ Deoptimization blob — 完整 CPU 路径
  ★ deopt_blob 的真实 PrintAssembly 输出（带地址 + 助记符 + 注释）
  ❓ 从 C2 插入 UncommonTrap 到重建解释器帧的 7 步过程
  ❓ 为什么 deopt 比正常调用贵 250-500 倍？（每一步的 cycle 计数）
  2.1 deopt 的 2 种触发方式——int 3 (SIGTRAP) vs call deopt_blob_entry
  2.2 deopt blob 的 3 段——unpack / unpack_with_exception / unpack_uncommon_trap
  2.3 unpack_frames 的逐变量搬运——从 spill slot/寄存器 → 新建解释器帧 locals
  2.4 ScopeDesc 如何编码"哪些变量是活的"——bitfield 压缩格式

§三 ★★ call_stub — C→Java 的唯一入口
  ★ call_stub 的真实 PrintAssembly 输出（三明治结构：set → call Java → reset）
  ❓ 为什么 call_stub 是 C→Java 的唯一入口？哪些场景需要它？
  ❓ set_last_Java_frame / reset_last_Java_frame 的"三明治"结构——为什么缺一不可？
  3.1 call_stub 的完整指令序列——从参数打包到异常检查
  3.2 JavaCalls::call() → call_stub 的调用路径
  3.3 异常路径——test rax, rax → jne forward_exception_entry

§四 ★★ Exception stub — 异常在 CPU 上的传播
  ❓ 编译方法 throw exception 后，CPU 怎么逐帧找到 handler？
  ❓ generate_forward_exception 和 generate_catch_exception 的区别？
  4.1 Exception handler table（nmethod 中的 ExceptionCache）的查找逻辑
  4.2 逐帧 unwind 的完整过程——从抛出点到最终 handler
  4.3 当 Java 栈中没有 handler → Thread::exception_handler_for_return_address 兜底

§五 ★★ Safepoint slow path stub — 从 testb+jne 到 SafepointSynchronize::block
  ★ slow path 的完整指令序列（push caller-saved → call block → pop restore → jmp back）
  ❓ 为什么 slow path 是共享 stub 而不是 inline 在 poll 点？——空间效率
  ❓ 进入 SafepointSynchronize::block 前后线程状态的变化
  5.1 caller-saved 寄存器的 push/pop 设计——哪些寄存器必须保存
  5.2 thread_state 的转换——block 内部设置 _thread_blocked
  5.3 和 [12-02] poll 快路径的对称——快路径 2 指令 vs slow path ~30 指令

§六 ★★ JNI wrapper — SharedRuntime::generate_native_wrapper 的汇编实现
  ❓ native 方法的调用者如何跳转到 native 实现——Java 参数 → C 参数的转换
  ❓ 线程状态转换的一瞬——_thread_in_vm → _thread_in_native 是几条 mov 指令
  6.1 generate_native_wrapper 的完整指令序列
  6.2 和 call_stub 的差异——native wrapper 是为已编译 native 方法服务，call_stub 是为 C→Java 调用服务
  6.3 safepoint check 在 native 调用前后的位置

§七 ★ 和 [12-01] Frames + [12-02] Interpreter + [11-os-layer] + [09-native-interface] 的阶段连接
  ❓ deopt 的帧拆解 = [12-01] 编译帧坐标系 → 解释器帧坐标系的转换
  ❓ deopt 后的解释器执行 = 重新进入 [12-02] 的模板解释器
  ❓ [11-01] 信号分流的 6 路 → [12-03] 的 6 个对应 stub 入口
  ❓ [09-03] 的 JNI 线程状态模型 → [12-03] 的 native wrapper 机器码实现

§八 GDB 验证 + 可证伪断言
```

## §六 写作要求

1. **★ deopt 的 7 步路径 + 每步 cycle 计数是全文的第一核心交付物**——不只是列出步骤，而是对每步分解"CPU 在执行哪些指令"并估算 cycle 数（基于 x86_64 微架构典型值）。标注最昂贵的步（unpack 的逐变量搬运，O(live_vars) + 内存读写）。
2. **★ call_stub 的"三明治"结构（set → call Java → reset）必须有完整的指令序列**——每条指令标注作用。特别强调 reset_last_Java_frame 在异常路径中也必须调用（否则 GC 栈行走会误读）。
3. **★ deopt 的"数据桥梁"——spill slot 的角色**——在 [12-01] 中的 spill slot 定义和本文中 deopt 的 spill slot 使用之间建立显式映射。标注"活变量"的数量如何影响 deopt 开销（O(live_vars)）。对标 README §八 问题 1。
4. **★ 和 [12-01] 的帧坐标系连接是本文的物理基础**——deopt 本质上是一次帧布局变换。在 deopt 讨论中显式引用 [12-01] §二 的帧图——标注从编译帧的哪个位置读值写入解释器帧的哪个位置。
5. **★ 和 [12-02] 的连接——deopt 后重新进入解释器 dispatch**——标注 deopt 完成后执行的第一个字节码和 [12-02] 中 dispatch 指令的连接
6. **★ native wrapper 的状态切换必须和 [09-03] 的线程状态模型对应**——`_thread_in_Java → _thread_in_native → _thread_in_Java` 的每一步是几条 `mov` 指令，哪几条指令
7. **★ 不要忘记 README §八 的第 4 个问题**——"如果 native wrapper 在状态切换后、call native 前到达 safepoint——GC 是否看到 _thread_in_native 的线程？"

## §七 输出格式

- Markdown 文件，命名为 `03-Stubs.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/12-cpu-layer/`
- 元信息头：
  ```
  > **阶段**：[12-cpu-layer]
  > **前置**：[12-01] Frames（帧布局是 deopt 帧重建的基础 + call_stub 的帧锚点）, [12-02] Interpreter（deopt 需要理解解释器帧格式 + 解释器 dispatch 是 deopt 后的执行者）, [11-os-layer]（信号→ stub 接力）, [09-native-interface]（JNI wrapper 的状态切换）, [08-safepoint]（safepoint poll 的慢路径）
  > **依赖本文**：无（本阶段最后写——结合全部前置的输出）
  > **阅读收益**：理解 JVM 运行时动态生成的所有 stub 机器码——deopt blob 如何从 C2 编译帧拆解回解释器帧（~5000-10000 cycles）、call_stub 如何用三明治结构（set/call/reset）完成 C→Java 调用、exception stub 如何逐帧 unwind + ExceptionCache 查找 handler、safepoint slow path 如何从 testb+jne 到 SafepointSynchronize::block
  ```

## 禁止行为（≥8，必须具体到"❌ X 因为 Y"）

- ❌ 把 stubGenerator_x86_64.cpp 的 6126 行当"源码注释翻译"——只聚焦 generate_call_stub、generate_forward_exception、generate_catch_exception 的三个核心 stub 生成函数，以及 generate_deopt_blob 的 3 段解包
- ❌ 深入 CodeCache 的分配/分段/回收算法——因为 CodeCache 管理是 GC + runtime 的内容，和 stub 指令本身无关
- ❌ 解释 ScopeDesc 的完整编码格式（bitfield 布局）——只需要解释"ScopeDesc 提供了变量位置映射"即可，不深入到 encoding/decoding 细节
- ❌ 忘记 [12-01] 的帧偏移——deopt 每提到"写 locals 到帧"必须引用 [12-01] §二 的帧图上的 locals_offset
- ❌ 忽略 deopt 的"昂贵原因"——必须逐步给出 cycle 估算，对比正常方法调用（~20 cycles），让读者看到 500x 的级差
- ❌ 不做 spill slot 在 deopt 语境中角色的详细解释——和 [12-01] 的通用 spill slot 定义区分：deopt 中 spill slot 是"编译帧→解释器帧"的数据桥梁
- ❌ 把 call_stub 当成"和 C 的 call 一样"——必须强调 set_last_Java_frame / reset_last_Java_frame 的三明治结构，以及为什么缺一不可（GC 会丢失 Java 帧边界）
- ❌ 忘记 [09-03] 的 JNI 线程状态模型——native wrapper 每提到状态切换，必须引用 [09-03] 的 _thread_in_Java → _thread_in_native 转换
- ❌ 忽略 safepoint slow path 的"共享 stub vs inline"权衡——必须解释为什么不是 inline（空间效率 × poll 点数），和 [12-02] 的快路径 2 指令 7 字节做对比
- ❌ 不做 stub 类别的完整分类（4 类 + 生成阶段）——读者需要一张"哪类 stub 什么时候生成"的时间表来定位每个 stub 在 JVM 启动过程中的位置

## 要求行为（≥8，必须是可验证的交付物）

- ✅ **★ deopt 的 7 步路径 + 每步 cycle 计数表**——步号 / 操作描述 / CPU 指令序列 / cycle 估算 / 内存读写次数 / 占总开销比例
- ✅ **★ call_stub 的真实 PrintAssembly 输出片段**——≥15 条指令，标准"三明治"结构：set_last_Java_frame 的指令 → call Java 方法入口 → reset_last_Java_frame → 异常检查 → epilogue → ret
- ✅ **★ deopt blot 的 3 段对比表**——unpack / unpack_with_exception / unpack_uncommon_trap 的触发场景、mode 参数、帧重建差异
- ✅ **★ deopt unpack 中的"数据搬运"示意图**——从编译帧的 spill slot N / register R → 复制到新解释器帧的 locals[M]，标注"活变量数 = N"时搬运的总指令数和内存读写量
- ✅ **★ 4 类 stub 的生成时序表**——类别 / 生成阶段（在哪个 init 函数中）/ 代表 stub / CodeCache 大小 / 是否 immortal
- ✅ **★ safepoint slow path stub 的完整指令序列**——push caller-saved → call SafepointSynchronize::block → pop restore → jmp back，标注每类指令的 cycle 估算
- ✅ **★ 和 [12-01] §二、[12-02] §三、[11-os-layer] §一、[09-03] §二 的精确交叉引用表**——每个引用标注到 phase.doc 节号
- ✅ **★ deopt unpack 的"变量位置映射"ASCII 图**——展示 ScopeDesc 链如何从 nmethod debug info 提供各变量的源位置（reg or spill slot offset）
- ✅ **★ 异常查找链的完整路径**——从 callee 返回 rax=exception oop → caller epilogue 检查 → ExceptionCache 查找 → 逐帧 unwind → 最终 handler 或 Thread 兜底
- ✅ **★ GDB 验证 deopt blob 在 CodeCache 中——确认 unpack_frames 的参数传入和帧重建前后的 sp/fp 变化**

## GDB 可证伪断言（≥10，精确到断点行号）

1. **断言：deopt blob 的 unpack 入口有完整的 prologue（push rbp; mov rbp, rsp; push callee-saved regs）**
   验证：在 `sa_deopt` 或 GDB 中设断点在 deopt_blob unpack 入口 → `x/10i $pc` → 看到 push rbp + 一系列 push（r15/r14/r13/rbx）
   预期：开头 5-8 条指令是 push

2. **断言：call_stub 在 call Java 方法后检查 rax == exception oop**
   验证：设断点在 `call rbx` 之后 → `ni` 单步进入 test rax, rax → `p/x $rax` → 如果异常值，接着 jne 跳转到 exception 路径
   预期：test rax, rax + jne 指令对在 call rbx 之后立即出现

3. **断言：set_last_Java_frame 写入 r15_thread 的 3 个偏移（sp=48, fp=56, pc=64）**
   验证：在 call_stub 的 set_last_Java_frame 之后 → `x/gx $r15+48` → _last_Java_sp → 等于当前 rsp；同理检查 fp 和 pc 偏移
   预期：`*(r15+48) = rsp, *(r15+56) = rbp, *(r15+64) = return_pc`

4. **断言：deopt unpack 创建的解释器帧包含 method* 和 bcp**
   验证：在 deopt 完成后设断点于解释器 dispatch_next → `p/x *(intptr_t**)($rbp + interpreter_frame_method_offset)` → Method* 对象 → `p/x *(int*)($rbp + interpreter_frame_bcp_offset)` → bcp 偏移
   预期：method 和 bcp 都是有效值，bcp 指向 method->code() 的特定偏移

5. **断言：forward_exception_entry 在 rax 中返回 exception oop**
   验证：触发 pending exception → 在 forward_exception_entry 返回后 → `p/x $rax` → 指向 exception oop → `p/x ((oopDesc*)$rax)->klass()` → 对应的 exception klass
   预期：rax 的值是非零指针，指向 heap 中的 exception 对象

6. **断言：safepoint slow path 在进入 block 前 push 了 caller-saved 寄存器（rax/rcx/rdx/rsi/rdi/r8-r11）**
   验证：断点在 slow_path 进入 SafepointSynchronize::block 前 → `info registers` → 对比 block 返回后的寄存器值
   预期：所有 caller-saved 寄存器在退出 slow path 后恢复原值

7. **断言：deopt blob 的 3 段有 3 个独立的 Label（不同入口跳转）**
   验证：在 sharedRuntime_x86_64.cpp generate_deopt_blob 中搜索 3 个 Label bind → `p/x &label_unpack`, `&label_unpack_with_exception`, `&label_unpack_uncommon_trap` → 确认地址不同
   预期：3 个 Label 绑定了 3 个不同的 CodeBuffer 偏移，对应 3 个不同的入口地址

8. **断言：generate_native_wrapper 在状态切换到 _thread_in_native 前保存了 Java Frame anchor**
   验证：在 native wrapper 的 mov [r15 + state_offset] 前设断点 → `p/x *(int*)($r15 + thread_state_offset)` → 确认当前是 _thread_in_Java → 单步一条指令后 → 确认已切换为 _thread_in_native
   预期：状态切换是一条 `mov` 指令完成的，之后紧接 `call native_function`

9. **断言：RuntimeStub（bare stub）在 CodeCache 中以 RuntimeStub CodeBlob 包装**
   验证：在 GDB 中 `p/x StubRoutines::call_stub_entry()` → 入口地址 → `p CodeCache::find_blob(addr)->is_runtime_stub()` → true
   预期：stub 的 CodeBlob 类型是 RuntimeStub

10. **断言：deopt unpack 的 Context 读取 nmethod 中 debug info 的 ScopeDesc —— 活变量信息来自此结构中**
    验证：设断点在 Deoptimization::fetch_unroll_info_helper → `p nmethod->scopes_data_begin()` → 此数组包含 bp/offset 和 variables 的位置映射
    预期：ScopeDesc 链的解析从 safepoint pc 对应的 indexed debug info 出发

11. **断言：call_stub 在 reset_last_Java_frame 后 JavaThread 的 _last_Java_sp = NULL**
    验证：在 call_stub reset_last_Java_frame 后设断点 → `p/x *(intptr_t**)($r15+48)` → 0
    预期：_last_Java_sp = 0（Java 帧锚点已清除）

12. **断言：ExceptionCache 表的查找通过依次迭代 pc 对查找匹配条目**
    验证：在一个有 3 个 try-catch 块的方法的 call site 后设断点 → `p nmethod->exception_begin()` → 在 callee 返回后跟踪 handler 表遍历
    预期：pc_offset 匹配后 handler 被找到，否则继续遍历直到表为空 → unwind 到 caller
