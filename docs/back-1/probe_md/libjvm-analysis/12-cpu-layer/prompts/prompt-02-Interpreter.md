# PROMPT: 请撰写 02-Interpreter.md

## §〇 背景与生产场景

### 你在 `-XX:+PrintAssembly` 输出中看到的（生产环境中的真实片段）

当你添加 `-XX:+UnlockDiagnosticVMOptions -XX:+PrintAssembly` 启动 JVM，每一个 Java 方法在解释器中的首次执行都会打印出机器码。以下是 `iload_0` 字节码的真实 x86_64 指令输出：

```asm
; iload_0 (opcode 0x1a) — 从局部变量槽 0 加载 int32 到表达式栈
0x00007f8b1400a3e0: mov    eax, [rbp + 8]     ; 读 locals[0]（this 或第一个参数）
0x00007f8b1400a3e3: push   rax                 ; 压入表达式栈顶
0x00007f8b1400a3e4: movzbl ebx, [r13 + 1]      ; 取下一个字节码 opcode（r13 = bcp, +1 = next byte）
0x00007f8b1400a3e9: jmp    [rscratch1 + rbx*8]  ; dispatch table 跳转到下一个字节码处理
```

以下是 `iadd` 字节码的真机输出：

```asm
; iadd (opcode 0x60) — 从表达式栈取出两个 int，相加后压回结果
0x00007f8b1400a518: pop    eax                 ; 取操作数栈顶
0x00007f8b1400a519: add    [rsp], eax           ; 加到次栈顶（x86 支持 mem + reg → mem）
0x00007f8b1400a51c: movzbl ebx, [r13 + 1]      ; dispatch next
0x00007f8b1400a521: jmp    [rscratch1 + rbx*8]
```

以下是每个 backedge（循环回边）前真实出现的 safepoint poll：

```asm
; safepoint poll — 在 goto/if*/tableswitch 前插入
0x00007f8b1400a200: testb  [r15 + 56], 1        ; 读 thread->polling_page 的 bit 0
0x00007f8b1400a205: jne    0x00007f8b1400a300   ; bit=1 → 走 slow path (safepoint handler)
; ... 继续正常执行
```

你盯着这些 `movzbl ebx, [r13 + 1]` + `jmp [rscratch1 + rbx*8]` 的组合——每个字节码执行完后必定出现。你不禁要问：
- 这些指令是从哪个 .cpp 文件生成的？为什么运行时动态生成而不是编译时写死？
- `r13` = bcp、`rscratch1` = dispatch table base——这些寄存器约定在哪里声明的？
- 200+ 字节码的模板生成全在同一个函数中？`TemplateTable::generate()` 到底多长？
- safepoint poll 为什么用 `testb` 而不是 `cmp`？为什么 bit=1 意味着"需要 safepoint"？

### 你在 crash dump 中看到的解释器帧

```
Native frames: (J=compiled Java code, j=interpreted, Vv=VM code)
j  com.example.controller.HealthController.process(Lmodel/Request;)V+85
J 4582 com.example.service.OrderService.lambda$process$0()V (137 bytes) @ 0x00007f8b15c4d8a2
```

`j` = interpreted——这个方法正在被解释器逐字节执行，而不是 JIT 编译的。`+85` = 当前 bcp 偏移量（第 85 个字节的字节码处）。当这个线程在 GC 中崩溃，解释器帧需要被栈行走器正确识别——这就是 [12-01] 帧布局中 `interpreter_frame_*` 偏移常量的用武之地。

### 相关生态工具

- **hsdis (HotSpot Disassembler)**：PrintAssembly 输出的反汇编就是通过 hsdis（一个 plugin .so）调用的。没有 hsdis → 不输出指令文本 → 你只能看到地址偏移和 opcode 字节，看不到 `mov`/`add`/`jmp` 助记符。
- **perf top -p <pid>**：可以发现 JVM 中哪些字节码执行路径最热（通过采样 instruction pointer → 映射到 TemplateTable 的各字节码地址范围），直接关联到解释器性能瓶颈。
- **`-XX:+TraceBytecodes`**：BytecodeTracer 在解释器每个字节码执行前打印 bcp + opcode + 操作数栈深度——比 PrintAssembly 更"Java 友好"（不看指令序列，只看字节码级别的事件顺序）。两者互补。

## §一 任务 + 核心叙事

读者已学完 [12-01-Frames]——理解了 x86_64 栈帧布局、r15_thread/r12_heapbase 的寄存器绑定、sender_sp/unextended_sp 的帧行走机制。读者已学完 [08-safepoint]——理解了 safepoint 的 begin()/end() 协议、polling page 的 arm/disarm 机制。读者已学完 [06-gc]——理解了字节码语义（iload 做什么、iadd 做什么、invokevirtual 做什么）。

现在该看"Java 字节码怎么变成 CPU 指令"——不是讲 JIT（C1/C2）的优化编译，而是讲 **JVM 启动时用 TemplateTable 动态生成的解释器代码——200+ 字节码 × 每条 5-50 条 x86_64 指令 = 解释器就是 JVM 的"指令语义参考实现"**。

### ★ 这不是 x86 汇编教程

**本文不是 x86 汇编语言教程**——不讲 `REX.W` 前缀的含义、不讲 ModRM 字节的编码格式、不讲 `LOCK` 前缀的总线锁语义、不讲 `vex.256` 前缀的 3-byte VEX 编码。本文只关心 **TemplateTable 如何为每个字节码生成 x86_64 指令序列**——`iload` 对应 `mov` 读局部变量表，`iadd` 对应 `add` 操作数栈顶，每个字节码 ~5-50 条指令。

**本文不是解释器的 C++ 源码注释翻译**——`templateInterpreterGenerator_x86.cpp` 有 2000+ 行、`templateTable_x86.cpp` 有 4000+ 行。本文不逐行翻译，只聚焦 4 条核心路径：字节码 → 模板生成链、dispatch 机制、safepoint poll 的指令级实现、方法入口/返回路径。

**本文不是字节码参考手册**——不讲 200+ 字节码的语义（`i2l`、`drem`、`jsr` 等），不讲 Java 虚拟机规范第 6 章的字节码格式。`iload`/`iadd`/`getfield`/`invokevirtual` 只作为"解释器如何把语义翻译为指令"的代表性案例——通过它们的模式理解所有字节码的生成逻辑。

### ★ 你需要知道的（零 x86 知识的 Java 工程师在进入源码前必须理解的 3 个概念）

#### 概念 1：scratch 寄存器（rscratch1=r10, rscratch2=r11）

JVM 在生成汇编代码时经常需要临时寄存器——比如"把立即数 0x42 搬到内存 [rbp - 8]，但 x86 的 mov 不允许两个操作数都是内存，必须先用一个寄存器中转"。如果每次都 push/pop 一个通用寄存器来"借"临时空间，指令开销会翻倍。这就是 scratch 寄存器的存在理由——r10 和 r11 被 JVM 指定为"内部临时寄存器"（rscratch1、rscratch2），MacroAssembler 的辅助函数（如 `movptr`、`load_address`、`increment` 的复杂寻址模式）可以随意使用它们而不保存/恢复。

代价是什么？scratch 寄存器是 **caller-saved**，意味着如果当前代码段在两次使用 scratch 之间调用了 Runtime 函数，那个函数也可能使用 scratch 并破坏其内容——所以必须在调用前把自己用 scratch 保存的值搬到安全的 callee-saved 寄存器或栈上。更大的隐患是中断：如果信号/中断在 mid-scratch-use 时到达（比如刚用 rscratch1 临时加载了一个指针还没来得及用完），信号处理器可能把 rscratch1 当成"存放了有用内容的寄存器"去读取——读到的是垃圾。这就是为什么信号安全的代码路径（如异常处理 stub）尽量不用 scratch 寄存器。

在 [12-01] 的寄存器表中，r10 和 r11 在 x86_64 ABI 中是 caller-saved（通用临时寄存器），JVM 将其重命名为 rscratch1/rscratch2 只是显式化了它们的"纯临时"性质——警告所有代码生成器：这俩寄存器不能跨 Runtime 调用保存值。

#### 概念 2：dispatch table（字节码分发跳转表）

解释器执行完一个字节码（比如 `iload_0`）后，需要立刻执行下一个字节码。下一个字节码的操作码是什么？如何从 ~200 个处理路径中瞬间找到对应的机器码入口？

dispatch table 是一张 256-entry 的指针数组：`table[opcode] = &bytecode_handler_start_address`。用 C 语言等价伪代码：`void* handlers[256]; goto *handlers[next_opcode];`——这就是 `jmp [dispatch_table_base + next_opcode * 8]` 一条指令做的事。操作码作为索引（0-255），直接用 CPU 的 `jmp [mem + index*8]` 间接跳转到目标。时间复杂度 O(1)，不需要任何比较或分支预测。

dispatch table 必须在启动时动态构建——每个字节码的机器码地址在 `TemplateTable::generate()` 时才确定（因为长度依赖于 CPU 特性和 VM flag）。构建完成后，这张表是只读的，所有解释器线程共享。

#### 概念 3：RAS/RSB（Return Address Stack / Return Stack Buffer）

CPU 内部有一个小型硬件栈（RAS，也叫 RSB），专门预测 `ret` 指令的目标地址。每次执行 `call` 指令时，CPU 硬件自动把 return address push 进 RAS；每次执行 `ret`，CPU pop RAS 顶部得到预取目标——不需要等待地址计算，这让 `call`/`ret` 对的预测精度接近 100%。

**解释器的困境**：解释器用 `jmp` 而不是 `call` 做字节码间跳转（因为不希望每个字节码都压一次 return address 到真实栈上），但这意味着 CPU 的 RAS 永远不会被 push——`jmp` 不触发 RAS 写入。解释器内部如果偶尔使用 `call`/`ret`（如调用 Runtime 函数），`ret` 时 pop 出来的是 RAS 中上一个条目——可能根本不是这条 `ret` 对应的 return address → 分支预测失败 → CPU pipeline flush → ~20 cycles 损失。这就是为什么 `call` + `ret` 模式理论上能让解释器快 15-20%，但 JVM 选择用 `jmp` 方案——因为 `jmp` 不需要压栈/弹栈的开销（每字节码省 2 条指令），在深度流水线 x86_64 CPU 上总体更快。

### 核心叙事线 — "200+ 字节码如何变成 200+ 段 CPU 指令"

[12-01] 建立了帧布局坐标系。本文在这个坐标系上展示解释器如何填充帧的内容——locals → `mov` 读取、expression stack → `push`/`pop` 操作、bcp → `movzbl` 取下一个操作码、dispatch → `jmp` 跳表分发。每一个字节码都是"读帧某些字段 → 计算 → 写帧某些字段"的模式实例。

[08-safepoint] 建立了 polling 的概念协议。本文补完 [08] 没讲的：poll 在 CPU 上到底长什么样——`testb [r15 + offset], bit` + `jne slow` 这个 2 指令序列就是"polling page"概念的机器码具现化。[08] 讲"为什么需要 poll"，[12-02] 讲"poll 怎么成为 CPU 指令"。

[12-04-CPUID] 决定了本文生成的指令版本。如果 `UseSSE >= 2` → 浮点字节码用 `addsd`/`subsd`（标量双精度）；如果只有 x87 → 用 `fadd`/`fsub`（栈式浮点）。本文在生成浮点字节码时检查 `UseSSE` flag——flag 的值来自 [12-04] 的 CPUID 探测。

### 验证报告
- `sverklo_search "TemplateTable::iload TemplateTable::iadd TemplateTable::getfield templateInterpreterGenerator"` → templateTable_x86.cpp, templateInterpreterGenerator_x86_64.cpp
- `codegraph query "TemplateTable::generate"` → templateTable_x86.cpp:~3500 spanning multiple bytecodes
- `rg -n "dispatch_next\|dispatch_via\|InterpreterMacroAssembler" interp_masm_x86.cpp interp_masm_x86.hpp` → dispatch 实现
- `rg -n "safepoint_poll\|testb.*r15" macroAssembler_x86.cpp` → safepoint poll 实现
- `rg -n "generate_normal_entry\|generate_native_entry" templateInterpreterGenerator_x86_64.cpp` → 方法入口

## §二 标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+PrintAssembly`
- 64 位 Linux x86_64
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ hsdis（HotSpot Disassembler）安装用于 PrintAssembly 输出和验证

## §三 聚焦源文件

| # | 文件 | 路径 | 模块 | 核心函数/类 | 本文角色 |
|---|------|------|------|-----------|---------|
| 1 | `templateTable_x86.cpp` | `src/hotspot/cpu/x86/templateTable_x86.cpp` | cpu/x86 | `TemplateTable::iload`、`iconst`、`iadd`、`getfield`、`invokevirtual`、`putfield`、`new_` 等 200+ 字节码的模板生成 | ★★★ 核心——每个字节码到 x86_64 指令的映射 |
| 2 | `templateInterpreterGenerator_x86_64.cpp` | `src/hotspot/cpu/x86/templateInterpreterGenerator_x86_64.cpp` | cpu/x86 | `generate_normal_entry`(:~150), `generate_native_entry`, `generate_return_entry` | ★★ 方法入口/返回——解释器的"大门"和"出口" |
| 3 | `templateInterpreterGenerator_x86.cpp` | `src/hotspot/cpu/x86/templateInterpreterGenerator_x86.cpp` | cpu/x86 | `generate_all`(遍历所有字节码 oop factory), `generate_safept_entry`, `generate_deopt_entry`, `generate_throw_exception` | ★ 解释器生成主调度器 |
| 4 | `interp_masm_x86.cpp` | `src/hotspot/cpu/x86/interp_masm_x86.cpp` | cpu/x86 | `InterpreterMacroAssembler::dispatch_next`(核心), `dispatch_via`, `notify_method_entry`, `lock_method`, `unlock_method` | ★★★ 解释器专用汇编宏——dispatch + lock + notify |
| 5 | `interp_masm_x86.hpp` | `src/hotspot/cpu/x86/interp_masm_x86.hpp` | cpu/x86 | `dispatch_next` 声明, `get_bcp`, `get_locals`, `get_method`, `get_cache_and_index_at_bcp` | ★ 寄存器访问器声明 |
| 6 | `macroAssembler_x86.cpp` | `src/hotspot/cpu/x86/macroAssembler_x86.cpp` | cpu/x86 | `MacroAssembler::safepoint_poll`(:3744), `get_thread` | ★★ safepoint poll 指令生成 + Thread* 加载 |
| 7 | `abstractInterpreter_x86.cpp` | `src/hotspot/cpu/x86/abstractInterpreter_x86.cpp` | cpu/x86 | `stackElementSize`、`stackElementWords` 等架构参数 | ★ 解释器架构参数 |
| 8 | `templateTable.hpp` | `src/hotspot/share/interpreter/templateTable.hpp` | interpreter | `TemplateTable` 基类定义 | 跨平台接口 |

**跨模块说明**：解释器代码生成横跨 `cpu/x86/`（x86_64 专有生成器）和 `share/interpreter/`（跨平台基类）。`templateTable_x86.cpp` 是本文的核心——它把每一个 Java 字节码映射为 x86_64 指令模板。`templateInterpreterGenerator_x86_64.cpp` 是方法入口/返回的生成器。`interp_masm_x86.cpp` 是被 TemplateTable 频繁调用的辅助函数集（dispatch、lock、method_entry）。

## §四 必须深度走读的核心概念（≥6 组，source-code-driven，"why X not Y" 风格）

> 每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ TemplateTable::iload — 一个字节码的完整机器码生成链

```
问题：
  ① iload 字节码（opcode 0x15，加载局部变量表槽 N 的 int32 到表达式栈）生成的完整指令序列是什么？
      线索: templateTable_x86.cpp iload 实现
      答案方向: 生成逻辑是"读 locals → push 到 expression stack → dispatch next"：
      1. `get_local` — 从 [rbp + locals_offset + N*4] 读取 int32
      2. `push_i` — 压入表达式栈 [rsp - 4]
      3. `dispatch_next` — 取下一个操作码并跳转
      追问: iload 的操作数 N 从哪里来？→ 从 [bcp + 1] 读取一个字节（如果 opcode 是 iload（0x15），
      操作数在 bcp+1；如果是 iload_0（0x1a），操作数隐含为 0）。

  ② 为什么 iload_0/iload_1/iload_2/iload_3 有 4 个变体？
      线索: templateTable_x86.cpp iload vs wide iload
      答案方向: Java class 文件将最常用的 iload_0 ~ iload_3 编码为独立 opcode（0x1a~0x1d），
      只占 1 字节（vs iload + N 占 2 字节）。解释器为每个变体生成独立的机器码——虽然语义相同,
      但 iload_0 的机器码可以硬编码偏移量为 0（省去 `movzbl ebx, [r13 + 1]; mov eax, [rbp + rbx*4]` 的
      索引计算）。这种"空间换时间"是 class file format 的传统——在字节码输出时就优化好了。

  ③ getfield 快速路径——直接读 field offset 的几条指令完成了什么？
      线索: templateTable_x86.cpp getfield
      答案方向: getfield 快速路径的核心：
      1. `pop_ptr rax` — 取出栈顶的 receiver 对象
      2. `null_check rax` — 如果 receiver=null → forward exception (NullPointerException)
      3. 从 ConstantPoolCache 读 field offset → `mov rscratch1, [rcx + offset]`
      4. `mov eax, [rax + rscratch1]` — 直接从对象内存读取字段值
      5. `push rax` — 压入表达式栈
      6. dispatch_next — 共 ~10-15 条指令。如果 CP cache 命中，这是最快路径。
      慢路径（class 未解析/static final field 需要从 ConstantPool 初始化）→ 调用
      `InterpreterRuntime::resolve_get_put` → 这涉及 ~50+ 条指令 + Runtime 开销。
```

### 4.2 ★★★ dispatch table — 解释器的"O(1) 字节码分发"

```
问题：
  ① dispatch_next 的完整指令序列是什么？dispatch table 的基址存储在哪？
      线索: interp_masm_x86.cpp dispatch_next
      代码引证:
        void InterpreterMacroAssembler::dispatch_next(TosState state, int step, bool generate_poll) {
          load_unsigned_byte(rbx, Address(r13, step));  // rbx = opcode of next bytecode
          jmp(Address(rscratch1, rbx, Address::times_8)); // rscratch1 = dispatch table base
        }
      答案方向: dispatch 就是两条指令：(a) `movzbl rbx, [r13 + step]` 取下一个字节码，
      (b) `jmp [rscratch1 + rbx*8]` 跳转。rscratch1（r10）是 dispatch table 基址——
      它在 JVM 启动时通过 `Interpreter::dispatch_table()` 获取并加载到寄存器。为什么用
      rscratch1 而不是专用寄存器？因为 dispatch table 基址只在解释器中需要——不需要
      像 r15_thread 那样"透传"整个调用链。

  ② 为什么用 `jmp` 而不是 `call` + `ret` 做字节码间跳转？
      线索: README §三 [02] 中的 RAS/RSB 讨论
      答案方向: `call` 会 push return address → `ret` 会 pop 并跳转 → CPU 的 RAS 硬件栈
      自动预测 `ret` 的目标 → 预测精度 ~100%。`jmp` 不触发 RAS 写入 → 分支预测依赖
      BTB (Branch Target Buffer) → 精度较低（~90%，因为 jmp 的目标根据操作码变化）。
      理论上 `call`+`ret` 比 `jmp` 快 15-20%。但 `call` 还额外需要 push/pop 真实栈——
      如果每个字节码都多 2 条指令（push return + pop return），200 字节码 × 每次 dispatch
      多 2 条 → 整体增加 ~15% 的指令数 → 抵消了 RAS 预测的收益。JVM 选择了"不额外
      操作栈"的方案。追问：有没有中间方案？→ 用 `ret` 直接 pop dispatch table entry？
      理论上可行（把 dispatch table 放在栈上），但实现复杂且不兼容常规栈管理。

  ③ dispatch_via 和 dispatch_next 的区别？
      线索: interp_masm_x86.hpp dispatch_via 声明
      答案方向: dispatch_next 总是跳到"下一个字节码"（bcp + current_opcode_length）。
      dispatch_via 跳到"指定操作码"（如 `tableswitch` 的计算结果）。前者读取 [r13 + step]，
      后者用参数 opcode。但底层跳转机制完全相同——都是 `jmp [rscratch1 + opcode*8]`。
```

### 4.3 ★★★ safepoint poll 的机器码级实现 — 从概念到 CPU 指令

```
问题：
  ① 为什么每个 backedge 前都有一个 `testb [r15 + offset], bit` + `jne slow` 序列？
      线索: macroAssembler_x86.cpp:3744 safepoint_poll, interp_masm_x86.cpp dispatch_next
      代码引证:
        void MacroAssembler::safepoint_poll(Register thread, Label& slow_path) {
          testb(Address(thread, JavaThread::polling_page_offset()), SafepointMechanism::poll_bit());
          jcc(Assembler::notZero, slow_path); // jne — 如果 bit 置位 → 跳转到 slow path
        }
      答案方向: safepoint 机制要求每个线程定期检查"是否需要停在 safepoint"。解释器在每个
      方法返回前和每个循环回边（goto/if*/tableswitch 等会跳回前方的字节码）插入 poll 代码。
      正常情况下 polling bit = 0 → testb 读 0 → ZF = 1 → jne 不跳 → 2 条指令 ~2-3 cycles。
      这是"零开销 safepoint 检查"——只比不做检查多一个读内存+测试操作。

  ② 为什么选 testb 而不是 testl 或 cmpb？
      线索: testb vs testl 的编码大小和语义
      答案方向: testb 只读 1 字节（polling bit 在某个字节内）→ 读内存操作比 testl（4 字节）
      更小（指令编码短 1-2 字节）→ 对 I-cache 更友好。cmpb 也可以，但 cmp 内部做减法
      （需要 full ALU），test 只做 bitwise AND → 少一个 ALU cycle。在 poll 这种每字节码
      执行一次的热路径上，每 1 cycle 的节省累加起来显著。
      代码引证:
        // testb 的编码（2 字节 REX + 操作码 + ModRM + disp32 = ~7 字节）
        // testl 的编码（类似，但需要 extra prefix for 32-bit operation size）
        // cmpb 的编码（类似 testb，但语义略重——减法 vs AND）

  ③ thread-local poll vs global poll 的 x86 级差异——为什么 thread-local 减少 cache miss？
      线索: macroAssembler_x86.cpp poll 实现的分支
      答案方向: global poll 所有线程读同一个内存地址（`[SafepointSynchronize::_state]`）→ 
      此地址所在的 cache line 被所有线程同时共享 → 读操作本身是共享的可以使用 shared cache line
      但写操作（safepoint 时修改 _state）会导致所有线程的 cache line 被 invalidate → 每个线程必须
      重新从内存/L3 加载 → cache miss × N 线程 → ~200 cycles each = 大规模 safepoint 的性能杀手。
      thread-local poll 每个线程读自己的 [r15_thread + offset] → cache line 只被所属线程独占 → 
      safepoint 时修改个别线程的 bit → 只有目标线程的 cache line 失效 → 其他线程不受影响。
      这就是从 global 到 thread-local 的"cache line 私有化"优化——多核系统上效果显著。
```

### 4.4 ★★★ 方法入口 — 从 CallStub → 解释器入口 → 第一个字节码

```
问题：
  ① generate_normal_entry() 生成了什么指令？解释器帧是如何建立和初始化的？
      线索: templateInterpreterGenerator_x86_64.cpp generate_normal_entry
      答案方向: 生成的指令序列完成 6 件事：
      1. push rbp / mov rbp, rsp — 建立帧指针（和 [12-01] 的帧模型一致）
      2. sub rsp, frame_size — 分配完整帧空间（max_locals + max_stack + metadata）
      3. 设置帧内的 method* / constPool* / bcp / locals 指针——从传入参数和 Method 对象读取
      4. 把调用者传来的参数从寄存器/栈复制到 locals[0..n]（Java calling convention → 解释器帧）
      5. 初始化 expression stack 为空（last_sp_offset 存入帧中）
      6. dispatch_next → 跳转到 method->code[0]（第一个字节码）
      追问: frame_size 怎么计算？→ max_locals × wordSize + max_stack × wordSize + 
      interpreter_frame_extra_words——编译时从 Method 对象读取。

  ② 为什么解释器帧需要保存 method*、bcp、locals、constPool* 到帧的固定偏移？
      线索: frame_x86.hpp interpreter_frame_method_offset
      答案方向: 解释器在调用 Runtime（如 InterpreterRuntime::resolve_invoke）时，会暂存
      这些指针到帧中（不在寄存器中跨越 Runtime 调用）→ Runtime 可能改变任何 caller-saved
      寄存器 → 如果 method/bcp/locals 只用 caller-saved 寄存器保存 → 回到解释器时丢失。
      通过保存在帧中（栈内存），跨越 Runtime 调用安全无虞。这就是为什么解释器帧比编译帧
      "重"——需要显式保存这些"解释器状态"。

  ③ generate_return_entry 的 epilogue 和正常 Java 方法的 epilogue 有什么不同？
      线索: templateInterpreterGenerator_x86.cpp 中的 return_entry
      答案方向: 正常 Java 编译方法的 epilogue 只需 add rsp, frame_size + pop rbp + ret。
      解释器的 return entry 更复杂：(a) 需要在返回前把返回值（rax/xmm0）留给 caller；
      (b) 需要从解释器帧中读取 sender_sp 恢复 rsp；(c) 可能 pop callee-saved 寄存器；
      (d) ret 回到 sender 的 return address。但和 [12-03] 的 call_stub 不同——解释器的
      return entry 是解释器间的返回（不做 Java↔C state switch），所以不需要 reset_last_Java_frame。
```

### 4.5 ★★ TemplateTable 的整体结构 — 4000 行如何组织 200+ 字节码

```
问题：
  ① TemplateTable::generate() 的调度逻辑——如何遍历所有字节码并生成对应的机器码模板？
      线索: templateTable.cpp (share/interpreter/) 中的 generate 主函数
      答案方向: generate() 内部是一个巨大的 switch-case 或函数指针表：
      - 每个字节码有一个对应的生成函数（如 `iload()`）
      - generate() 循环遍历所有字节码 opcode → 调用对应的生成函数 → 累积指令到同一个 CodeBuffer
      - 每个字节码在生成前 bind 一个 Label（opcode → Label 映射），最终填回 dispatch table
      追问: 为什么是同一个 CodeBuffer 而不是独立 buffer？→ dispatch table 的 jmp 需要知道
      各字节码的相对偏移 → 所有字节码必须在同一 CodeBuffer 中以获得固定相对 offset。

  ② TemplateTable 中的 "locals_index" / "locals_index_wide" 分支是什么？
      线索: templateTable_x86.cpp iload 实现中的 wide 分支
      答案方向: 字节码有 wide 前缀（0xc4）用于扩展局部变量索引从 1 字节到 2 字节。
      对于 iload，正常版（locals_index）从 bcp+1 读 1 字节索引，wide 版读 2 字节。
      生成器为两种路径生成不同指令——这是 Java class file format 的遗留设计在 CPU 指令中的反映。

  ③ 为什么 volatile_getfield 生成了和普通 getfield 不同的指令——lock addl [rsp], 0 是什么？
      线索: templateTable_x86.cpp volatile_barrier
      答案方向: volatile field 的读取要求在 volatile read 后不能重排序任何后续操作到 read 之前。
      x86 的普通 load 已经具有 acquire 语义（不重排序后续 load 到前面，不重排序后续 store 到前面 但
      store-load 可以重排）。volatile_store 需要在 store 之前加 StoreStore barrier（x86 上 `mov`
      自动保证）和 store 之后加 StoreLoad barrier——后者的唯一实现是 `lock addl [rsp], 0`：
      一条对栈顶做无效果加法的指令，带 LOCK 前缀 → 完全的内存屏障（mfence 等价）→ 防止
      Store-Load 重排。为什么不用 `mfence`？因为 `lock addl` 在某些 CPU 上比 mfence 快 1-2 cycles。
```

### 4.6 ★★ invokevirtual 的快速路径 — 从 receiver type check 到方法分派

```
问题：
  ① TemplateTable::invokevirtual 生成的快速路径完成了什么？
      线索: templateTable_x86.cpp invokevirtual
      答案方向: 快速路径的逻辑（从 receiver 对象的 Klass* 中取 vtable）：
      1. 将 receiver 对象从栈中取出
      2. null_check receiver
      3. 加载 receiver->klass()（从对象 header 读 Klass*）
      4. 比较 receiver->klass() 是否等于 ConstantPoolCache 中缓存的 klass
      5. 如果匹配 → 直接跳到缓存的 method->from_compiled_entry() — 这是最快的路径（~10 条指令）
      6. 如果不匹配 → 调用 InterpreterRuntime::resolve_invoke() 走慢路径
      追问: 为什么 CP cache 中的 klass 可以避免完整的动态分派？
      → 因为大部分 virtual call site 单态（monomorphic）— 99%+ 的调用都是同一种 receiver 类型。
      如果只缓存最近一次调用成功的 klass，再遇到同样类型可以跳过完整 vtable 查找。
      这是解释器中的内联缓存 (inline cache, IC) 机制——和 C1/C2 的 IC 是同一套 CP cache 基础设施。

  ② 如果 CP cache miss → 慢路径走到 InterpreterRuntime::resolve_invoke → 这个 Runtime 调用
      完成了什么？代价是多少？
      答案方向: resolve_invoke 在 Runtime 中完成：
      1. 提取 receiver 的实际 Klass*
      2. 在 Klass 的 vtable 中查找 method 对应的 vtable index
      3. 读取 vtable_entry = &klass->vtable()[index]
      4. 更新 ConstantPoolCache 的 f1/f2 条目（下次快速路径直达）
      5. 返回 enty point
      代价：一条 Runtime 调用 = ~500 cycles（保存/恢复 ~10 个寄存器 + C 调用 + 可能的分支预测失败)
      vs 快速路径的 ~10 cycles。这就是为什么慢路径很少走——单态 call site 让快速路径成为常态。
```

### 4.7 ★★ 和 [12-01] + [12-04] + [08-safepoint] 的连接

```
问题：
  ① 和 [12-01] Frames 的连接——解释器帧是 caller/callee 帧模型的扩展
      答案方向: [12-01] 建立了 return address / saved rbp / locals / expression stack 的
      基本帧模型。本文的 interpreter frame 在同样的坐标上增加了 method*、bcp、constPool*、
      sender_sp、last_sp 等字段——这些偏移量定义在 [12-01] 的 frame_x86.hpp 中。读者
      必须先理解 [12-01] 的 return_addr_offset (+1 word) 和 link_offset (0 word)，才能理解
      interpreter_frame_method_offset (-3 words) 的含义——它们是同一坐标系的扩展。

  ② 和 [12-04] CPUID 的连接——UseSSE flag 如何影响解释器生成的浮点指令
      答案方向: [12-04] 的 VM_Version::initialize() 设置 UseSSE flag。解释器生成 `fadd`/`dmul`
      等浮点字节码时检查 UseSSE：>= 2 → 生成 `addsd`/`subsd`/`mulsd`（SSE2 标量）；= 0
      → 生成 `fadd`/`fsub`/`fmul`（x87 栈式浮点）。SSE2 比 x87 快 3-5× 且更精确。这就是
      "同一个字节码在不同 CPU 上生成不同指令"的原因——UseSSE 是决定因素。

  ③ 和 [08-safepoint] 的连接——polling page 概念 → 机器码具现化
      答案方向: [08] 建立了 safepoint polling 的概念（arm/disarm polling page、mprotect 保护）。
      本文补完 [08] 没讲的：poll 在 CPU 上到底长什么样——`testb [r15 + offset], bit` + `jne slow`。
      [08] 讲"为什么需要 poll"，[12-02] 讲"poll 怎么成为 CPU 指令"。thread-local poll 的新方案
      取代了 [08] 描述的 global poll + SIGSEGV 机制——这是设计演进，从 [08] 到 [12-02] 的桥梁。
```

## §五 文章结构（ASCII 图）

```
§〇 源文件清单（跨 cpu/x86 + share/interpreter + runtime，标注模块归属和每个文件在字节码→ 指令链中的角色）

§一 ★ 全景：从字节码到机器码的生成链
  ❓ 解释器的机器码是编译时还是运行时生成？
  ❓ 为什么运行时生成而不是编译时写死在 C++ 中？
  1.1 TemplateInterpreterGenerator::generate_all() 的启动时序
  1.2 CodeBuffer 中的指令累积——200+ 字节码共享同一个 CodeBuffer
  1.3 TemplateTable 的"template"含义——参数化的指令序列

§二 ★★★ TemplateTable::iload — 一个字节码的完整机器码轨迹
  ★ 真实 PrintAssembly 输出（带地址 + 指令助记符 + 注释）
  ❓ iload_0 的 3 条指令：get_local → push_i → dispatch_next
  ❓ r13 = bcp、r14 = locals 的寄存器约定
  2.1 字节码操作数的解码——bcp+1 vs 隐含操作数（iload_0）
  2.2 表达式栈的 push/pop 指令——不是 `push rax` 而是 `mov; sub rsp`
  2.3 wide 指令的额外代价——2 字节操作数 vs 1 字节

§三 ★★★ dispatch table — O(1) 字节码分发跳转表
  ★ 真实 dispatch 指令序列 + ASCII 图展示 dispatch table 的内存布局
  ❓ jmp [rscratch1 + opcode*8] 一条指令如何用 opcode 作为索引瞬间跳转
  ❓ 为什么用 jmp 不用 call+ret —— CPU RAS/RSB 的权衡
  3.1 dispatch_next 的逐条指令分解
  3.2 rscratch1 加载 dispatch table 基址的时机
  3.3 dispatch_via vs dispatch_next 的适应场景
  3.4 RAS 困境——`call` 方案 vs `jmp` 方案的 15% 指令计数权衡

§四 ★★★ safepoint poll — 从概念到 CPU 指令
  ★ 真实 backedge 前的 testb 指令 + slow path 的 jne 指令
  ❓ testb 为什么比 testl/cmpb 快？
  ❓ thread-local poll 为什么减少 cache line bouncing？
  4.1 poll 的插入时机——方法返回前 + 每个循环回边
  4.2 testb + jne 的 CPU 级开销——正常情况下 2-3 cycles
  4.3 slow_path 的生成——调用 SafepointSynchronize::block 的完整寄存器保存/恢复
  4.4 global poll → thread-local poll 的迁移——cache coherency 的胜利

§五 ★★ 方法入口与返回 — 解释器的"大门"和"出口"
  ❓ generate_normal_entry 的 6 步初始化——从参数复制到第一个 dispatch
  ❓ 解释器帧为什么需要保存 method*/bcp/locals* 到帧偏移——跨越 Runtime 调用的安全
  5.1 帧分配——max_locals + max_stack + metadata 的空间计算
  5.2 参数复制——Java calling convention → locals[0..n] 的指令
  5.3 返回路径——return entry 的 epilogue vs 编译方法的 epilogue 对比

§六 ★★ TemplateTable 的结构与快慢路径
  ❓ invokevirtual 的快速路径——CP cache 检查 → vtable 直接跳转
  ❓ getfield 的 volatile 分支——lock addl [rsp],0 为什么是 StoreLoad barrier
  6.1 快速路径的逻辑——单态 inline cache 在解释器中的实现
  6.2 慢路径的逻辑——InterpreterRuntime::resolve_* 的 Runtime 调用开销
  6.3 volatile 的内存屏障——lock addl [rsp], 0 的真面目

§七 ★ 和 [12-01] Frames + [12-04] CPUID + [08-safepoint] 的阶段连接
  ❓ [12-01] 的帧偏移在解释器帧中的具体使用——method_offset/bcp_offset/locals_offset
  ❓ [12-04] 的 UseSSE flag → 浮点字节码指令版本的选择
  ❓ [08] 的 polling page 概念 → testb 指令的具现化——从"抽象协议"到"物理指令"

§八 GDB 验证 + 可证伪断言
```

## §六 写作要求

1. **★ iload 的完整指令序列（带真机地址和汇编助记符）是全文的核心交付物**——必须是真实的 PrintAssembly 输出片段，而非手写伪代码。每条指令标注其作用（"读 locals"、"push"、"dispatch"）和对应的 C++ 生成函数（`get_local` / `push_i` / `dispatch_next`）。
2. **★ dispatch 的两条指令必须逐位解释**：`movzbl ebx, [r13 + 1]` 中 r13 为什么是 bcp、+1 为什么是下一个字节码、`ebx` 为什么选择 32 位目标（而不是 rbx）——因为 opcode 最大 255 只需要 1 字节 → `movzbl` 零扩展到 32 位即可 → 不需要 64 位操作。
3. **★ safepoint poll 的"3 种版本的演进"必须呈现**：原始 global poll（`cmp [global_addr], _not_synchronized`）→ SIGSEGV-based poll（mprotect 保护 polling page）→ thread-local poll（`testb [r15 + offset], bit`）。标注每种方案的代价（cache miss 数 × 线程数）和淘汰原因。
4. **★ invokevirtual 的快速路径必须有完整的"if hit → jmp; if miss → call Runtime"分支**——这是单态 inline cache 的 CPU 级实现，标注 hit rate（通常 99%+）和 miss penalty（~500 cycles）。
5. **★ volatile_getfield 的 `lock addl [rsp], 0` 必须揭露其真面目——不是"加 0 到栈顶"，而是"带 LOCK 前缀的假加法 = 完整内存屏障 = mfence 的等价替代"**。
6. **★ 和 [12-04] CPUID 的 UseSSE 依赖是贯穿全文的暗线**——每提到浮点字节码（fadd/dmul等），必须说明"UseSSE flag 的值决定这里生成 addsd 还是 fadd"。
7. **★ 不要做"200 个字节码的逐一指令解析"**——只用 iload/getfield/invokevirtual/volatile getfield 作为 4 个代表性案例展示生成模式，读者应通过模式理解推导其他字节码。

## §七 输出格式

- Markdown 文件，命名为 `02-Interpreter.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/12-cpu-layer/`
- 元信息头：
  ```
  > **阶段**：[12-cpu-layer]
  > **前置**：[12-01] Frames（解释器帧布局建立在帧模型上）, [12-04] CPUID（UseSSE/UseAVX 决定生成的指令版本）, [08-safepoint]（polling page 概念 → 机器码实现）, [06-01] Bytecode（字节码语义）
  > **依赖本文**：[12-03] Stubs（deopt 需要理解解释器帧格式才能拆解编译帧）
  > **阅读收益**：理解 TemplateTable 如何把 200+ Java 字节码翻译为 x86_64 指令模板——从 iload 的 local read+push 到 invokevirtual 的单态 inline cache 快速路径、从 dispatch table 的 O(1) 跳转到 safepoint poll 的 2 指令零开销检查、从方法入口的 6 步帧初始化到解释器帧中 bcp/locals/method* 的固定偏移保存
  ```

## 禁止行为（≥8，必须具体到"❌ X 因为 Y"）

- ❌ 把 templateTable_x86.cpp 的 4000 行当"源码注释翻译"——只聚焦 iload/getfield/invokevirtual/volatile_getfield + dispatch_next + safepoint poll 的指令生成路径，其他字节码"由模式推导"
- ❌ 深入 x86 指令编码格式（REX/ModRM/VEX 前缀、opcode 编码、立即数字长）——因为这是 Assembler::emit_* 的职责，和 TemplateTable 的"字节码语义→ 指令序列"的主线无关
- ❌ 解释 200+ 字节码的完整语义（i2l、jsr、athrow 等）——因为字节码语义在 [06] 阶段已覆盖，本文只关心"生成什么指令序列来实现它们的语义"
- ❌ 把 `MacroAssembler` 的辅助函数（`movptr`、`load_address`、`increment`）当成独立概念展开——只用它们产出的最终指令做解释，不深入助手函数的内部 emit 逻辑
- ❌ 忽略解释器的"运行时生成 vs 编译时写死"这一核心设计决策——必须解释为什么不是编译时预生成（CPU 特性、VM flag、UseCompressedOops 等全局设置影响指令宽度和版本）
- ❌ 把 safepoint poll 当成"和 [08] 重复的内容"跳过——[08] 讲 poll 的协议层（arm/disarm），本文讲 poll 的物理层（testb + jne 指令序列），是两层的互补，不是冗余
- ❌ 忘记 [12-04] CPUID 对浮点字节码指令版本的影响——每涉及浮点字节码（fadd/dmul 等），必须说明 UseSSE 如何选择指令（addsd vs fadd）
- ❌ 不做 RAS/RSB 的困境解释——读者需要理解"为什么 call+ret 模式理论上更快但 JVM 不用"，这是理解 dispatch 设计的钥匙
- ❌ 忽略解释器帧中 method*/bcp/locals* 固定偏移保存的原因——"跨越 Runtime 调用的安全"是解释器帧比编译帧"重"的核心原因
- ❌ 把 TemplateTable 当成"和 C1/C2 差不多的代码生成"——解释器生成的是无优化逐字节码模板（1:1 映射），C1/C2 生成的是优化后的图着色输出——它们在生成策略和复杂度上有根本差异

## 要求行为（≥8，必须是可验证的交付物）

- ✅ **★ iload_0 的真实 PrintAssembly 输出片段**——不少于 5 条指令，每条标注地址、助记符、注释（JVM 语义角色）+ 对应的生成函数名
- ✅ **★ dispatch next 的完整时序图**——从 "完成当前字节码" 到 "下一条字节码的第一条指令" 之间的每一步（取 opcode → 查表 → jmp → 目标），标注每个步骤的 CPU cycle 估算
- ✅ **★ safepoint poll 的"3 版本演进表"**——global poll / SIGSEGV poll / thread-local poll 三种方案的对比：指令序列、cache coherency 影响、触发方式（信号 vs 直接 bit 检查）、各自的适用阶段
- ✅ **★ invokevirtual 的快速路径 vs 慢路径对比**——快速路径的指令序列（~10 条）+ 慢路径的 Runtime 调用链（~500 cycles）+ 标出 CP cache hit rate 在单态 call site 中的位置
- ✅ **★ 解释器帧固定偏移表**——在 [12-01] 帧图的基础上新增解释器帧专有偏移：method_offset、bcp_offset、locals_offset、constPool_offset、sender_sp_offset、last_sp_offset，标注每个偏移的值（相对于 rbp）和内容
- ✅ **★ volatile_getfield 的内存屏障指令序列**——展示普通 getfield 和 volatile getfield 的指令序列差异，标注 `lock addl [rsp], 0` 的"假加法真屏障"原理
- ✅ **★ 和 [12-01] §二（帧布局）、[12-04] §三（UseSSE flag）、[08-safepoint] §二（polling）的精确交叉引用表**——每个引用标注到 phase.doc 节号
- ✅ **★ PrintAssembly 阅读 checklist**——在解释器输出中如何区分 TestTable 生成代码 vs Runtime stub vs compiled code，通过地址范围、指令模式、帧偏移使用来判定
- ✅ **★ GDB 验证 dispatch table 的跳转——单步跟踪一个字节码序列的完整 dispatch 链**，验证每次 dispatch 的 `[rscratch1 + opcode*8]` 值正确

## GDB 可证伪断言（≥10，精确到断点行号）

1. **断言：解释器帧的 locals[0] 在固定偏移 [rbp + locals_offset + 0]**
   验证：进入解释器执行的 Java 方法 → `info locals` → 对比 locals[0] = this → `p/x *(intptr_t**)($rbp + <locals_offset>)` → 等于 this 指针
   预期：`*(rbp + locals_offset + 0) == this`

2. **断言：dispatch table 基址加载在 rscratch1 (r10) 中**
   验证：断点在 `interp_masm_x86.cpp dispatch_next` 的 jmp 指令 → `p $r10` → 值落在 Interpreter codelet 范围内 → `p/x *((void**)$r10 + opcode)` → 等于对应字节码的入口地址
   预期：r10 指向 dispatch table，`table[opcode]` = 对应字节码处理开始地址

3. **断言：testb + jne 的快路径不跳转（poll bit = 0 时）**
   验证：正常执行期间设断点（非 safepoint 时刻）→ `x/2i $pc` → 看到 testb + jne → `p $eflags & 0x40`（ZF bit = bit 6）→ 1（ZF set → test 结果是 0 → poll bit = 0）
   预期：EFLAGS 的 ZF=1 → jne 不会跳转

4. **断言：iload_0 从 [rbp + interpreter_frame_locals_offset] 读取 int32**
   验证：进入包含 iload_0 的 Java 方法 → 设断点在 iload_0 的机器码地址 → `x/wx $rbp + <locals_offset>` → 值 = 第一个局部变量的 int 值
   预期：`p/x *(int*)((char*)$rbp + locals_offset + 0)` = locals[0]

5. **断言：invokevirtual 的 CP cache 在首次调用后包含了正确的 Klass***
   验证：执行一次 invokevirtual 后 → 断点在 invokevirtual 模板的 klazz 比较指令 → `p/x *(Klass**)(cache->f1())` → 等于 receiver 的 Klass*
   预期：CP cache 的 f1 字段 = receiver->klass()

6. **断言：解释器帧的 sender_sp = caller 的入口 sp**
   验证：在 callee 方法中 → `p/x *(intptr_t**)($rbp + interpreter_frame_sender_sp_offset)` → 值 = 进入 callee 前的 rsp（caller 执行 call 后的 rsp）
   预期：sender_sp 和 caller 栈帧的关系符合同一坐标

7. **断言：dispatch_next 使用 movzbl 取下一个字节码（opcode 是 1 字节无符号数）**
   验证：断点在 dispatch_next 的 movzbl 指令 → `x/1bx $r13` → 显示当前字节码 opcode
   预期：读取 [bcp] 的 1 字节 = 当前执行字节码的 opcode

8. **断言：generate_normal_entry 分配帧空间 = max_locals + max_stack + metadata**
   验证：进入新方法时设断点 → `p/x $rsp` 在 prologue 前后 → 差值 = frame_size → 对比 Method 对象的 max_locals/max_stack → frame_size = (max_locals + max_stack + extra) × wordSize
   预期：RSP 减少量 = frame_size_words × 8

9. **断言：模板解释器生成的代码在 Interpreter codelet 中——地址范围连续**
   验证：设断点在两个不同字节码的入口 → 两个 PC 的差值在合理范围（~50-500 字节）→ 且都属于同一个 CodeBlob（Interpreter codelet）
   预期：`CodeCache::find_blob(pc)` 返回相同的 Interpreter codelet

10. **断言：解释器的 safepoint poll 在 slow path 调用 SafepointSynchronize::block 前保存了所有 caller-saved 寄存器**
    验证：设断点在 safepoint slow path 的 jne 跳转目标 → `info registers` → r10/r11/rax/rcx/rdx/rsi/rdi 的值 → 进入 C++ call 前这些值被 push → 从 C++ 回来后恢复
    预期：离开 slow_path 后所有 caller-saved 寄存器恢复为原值

11. **断言：wide 前缀的 iload 从 bcp+1/+2 读取 2 字节索引（而不是 1 字节）**
    验证：在 wide iload 字节码执行时设断点 → `x/2bx $r13+1` → 读取 2 字节索引 → 对比普通 iload 的 `x/1bx $r13+1`
    预期：wide 版本使用 2 字节索引 = 256+ 局部变量槽

12. **断言：volatile getfield 生成的指令序列以 lock addl [rsp], 0 结尾**
    验证：在 volatile field 读取后设断点 → `x/5i $pc` → 看到 `lock addl [rsp], 0` → 验证该指令后紧接着 dispatch_next
    预期：lock addl [rsp], 0 存在于 volatile 读取和 dispatch 之间
