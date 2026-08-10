# PROMPT: 请撰写 04-Crash.md

## 〇、背景与使用场景

### 你在凌晨 3 点被报警唤醒时经历了什么

hs_err 文件里有这一行：

```
#  SIGSEGV (0xb) at pc=0x00007f8b1a3c4d21, pid=12463, tid=12494
#
# siginfo: si_signo: 11 (SIGSEGV), si_code: 1 (SEGV_MAPERR), si_addr: 0x0000000000000010
```

然后往下翻到 `Registers` 段：

```
Registers:
RAX=0x00007f8b2c003c00, RBX=0x00007f8b1a000000, RCX=0x0000000000000000, RDX=0x0000000000000010
RSP=0x00007f8b1ecfcb80, RBP=0x00007f8b1ecfcc20, RSI=0x00007f8b1a00a400, RDI=0x00007f8b24000000
...
RIP=0x00007f8b1a3c4d21, EFLAGS=0x0000000000010206

Top of Stack: (sp=0x00007f8b1ecfcb80)
0x00007f8b1ecfcb80:   00007f8b1ecfcc20 00007f8b1a3c4d21
0x00007f8b1ecfcb90:   00007f8b1a00a400 00007f8b24000000

Instructions: (pc=0x00007f8b1a3c4d21)
0x00007f8b1a3c4d01:   e8 9a 42 f3 ff 48 8b 43 10 48 8b 00 48 8b 40 10
0x00007f8b1a3c4d11:   48 85 c0 74 08 48 8b 80 a0 00 00 00 eb 02 31 c0
0x00007f8b1a3c4d21:   48 8b 40 10 48 85 c0 0f 84 3c fe ff ff 48 8b 80
```

`si_addr=0x0000000000000010` 接近零页——像是 NullPointerException？不对——`Current thread` 是 `GCTaskThread`（GC 线程），`si_addr` 是 `0x10` 不是 `0x00`。你用 `addr2line -e libjvm.so 0x1a3c4d21` 解析 `RIP` → 得到 `G1ParScanThreadState::copy_to_survivor+0x61`。用 gdb 反汇编 `RIP` 附近：

```asm
0x1a3c4d21:  mov    0x10(%rax), %rax   ; %rax = 0x00007f8b2c003c00 → 读 %rax+0x10
```

`RAX=0x00007f8b2c003c00` — 这是一个合法堆指针。但 `0x00007f8b2c003c00 + 0x10 = 0x00007f8b2c003c10` 不是 `si_addr=0x10`。仔细看——`RCX=0x0000000000000000`。前面有指令 `mov %rcx, %rax` 的可能性。`si_addr` 是 0x10——这是一个"恶意地址"，说明 `%rax` 在 `mov %rax, 0x10(%rax)` 之前变成了 0x0 → 取 `0x0 + 0x10 = 0x10`。真凶是 `RAX` 在两条指令之间被清零。

`Register to memory mapping` 段（`os::print_register_info` 的输出）显示：

```
RAX=0x00007f8b2c003c00 is an oop
  [error occurred during error reporting (printing register info), id 0xb, SIGSEGV]
```

JVM 在解析 `RAX` 的过程中又 crash 了——二次崩溃被 `recursive_error_count` 检测到，打印了一条 `[error occurred during error reporting]` 消息。这说明 `os::print_register_info` 在尝试解引用 `RAX` 指向的对象时，对象的 GC 位被损坏 → 触发了嵌套 SIGSEGV → JVM 跳过了这个 step → 继续输出剩余的 hs_err 内容。

### 背景概念速览

- **`ucontext_t`**：内核在信号投递时压到用户栈上的结构体——包含完整 CPU 上下文（所有通用寄存器、标志寄存器、指令指针）。`os::print_context` 直接从这里读——零系统调用、零 malloc、完全信号安全。
- **`si_addr`**：`siginfo_t` 中的故障地址。由 CPU MMU 在 page fault 时填入——MMU 检测到访问无效地址 → 生成 page fault exception → 内核在 `siginfo_t.si_addr` 中填入被访问的地址。
- **`print_register_info` 的二次崩溃风险**：`os::print_register_info` 尝试把寄存器值当指针解引用 → 如果寄存器是野指针（指向已 unmmap 的区域）→ 访问触发第二次 SIGSEGV → `recursive_error_count` +1 → `_current_step` 跳过 → 打印 `[error occurred during error reporting]`。
- **`write()` 作为唯一安全输出**：[10-04] 讲 `fdStream::write()` 直接 `::write(fd, buf, len)` 系统调用——无锁、无缓冲、无 malloc。所有 hs_err 输出必须通过 `write()`，因为在信号上下文中不能持有 FILE* 锁。

### 相关生态工具

- **`addr2line -e libjvm.so <pc_offset>`**：从 hs_err 的 `Problematic frame` 中的偏移量反查源文件行号。需要 debuginfo 包。
- **`gdb -p <pid> -ex 'thread apply all bt'`**：在生产 JVM 崩溃前 attach gdb → 获取比 hs_err 更详细的所有线程寄存器 + 完整 native 栈（DWARF 展开）。
- **`objdump -d libjvm.so | grep -A 10 <pc_offset>`**：从 hs_err 的 `Instructions` hex dump 中验证是哪个指令崩溃。
- **`coredumpctl list` / `gdb <binary> core`**：如果 `ulimit -c unlimited` → core dump 比 hs_err 包含更完整的内存状态——hs_err 是格式化的文本，core dump 是二进制的全内存快照。

## 一、任务 + 核心故事线（禁止做源码翻译机！）

读者学完了 [11-01-Signals]——理解了 `SIGSEGV` 从 CPU 陷阱到 `JVM_handle_linux_signal`（`os_linux_x86.cpp:271`）的 6 路分流。当所有 8 条分流路径都不匹配时 → `abort_if_unrecognized==true` → 信号走到 `chained_handler` → 链上无 handler → `VMError::report_and_die(t, sig, pc, info, ucVoid)`（行 656）。**这就是 04 的入口**——信号被判定为"无法处理的崩溃"。

读者学完了 [11-02-Threads]——理解了 `os::create_thread` → `thread_native_entry` 如何创建线程栈。hs_err 的 `Native frames` / `Java frames` 打印依赖线程栈的 layout——`frame::sender_for_compiled_frame` 需要 frame pointer chain → 如果 rbp 被编译器优化为 GP 寄存器 → native 栈解码失败。

读者学完了 [11-03-Memory]——理解了 reserve/commit 两阶段模型。hs_err 的 `Memory map` 段（`/proc/self/maps`）中的 `---p` 就是 reserve 未 commit 区域，`rw-p` 就是 commit 区域——从 maps 中能直接看出堆的 reserve/commit 布局。

读者学完了 [10-services-diag]——理解了 `VMError::report_and_die` 的 `_steps[]` STEP 宏框架和 `fdStream::write()` 的信号安全输出。但是 [10-04] 只解释了 STEP 宏本身和输出框架——没深入 OS 层：`_steps` 中 `step_print_register_info` → `os::print_context` + `os::print_register_info`；`step_print_memory_info` → `os::print_memory_info`；`step_print_dll_info` → `os::print_dll_info`。**这些 OS 函数如何从内核接口提取数据并格式化——是本文要回答的。**

**本文不是汇编教程**——不讲 x86 寄存器的 ABI 角色（`rsp` 栈顶、`rbp` 基址、System V AMD64 calling convention 的参数传递）。**本文不是 gdb/addr2line 使用手册**——不展开 ELF/DWARF/Trace 格式。**本文也不是 Linux 内核 crash dump 指南**——不讨论 `/proc/sys/kernel/core_pattern`。

**本文的唯一目标是：追踪 hs_err 文件中每一段 OS 层输出的生产者。** 寄存器 dump → `os::print_context`（`os_linux_x86.cpp:770`）。寄存器作为指针的解释 → `os::print_register_info`（`os_linux_x86.cpp:835`）。`/proc/self/maps` → `os::print_dll_info`（`os_linux.cpp:2270`）。系统内存信息 → `os::print_memory_info`（`os_linux.cpp:2749`）。PC 地址符号化 → `os::print_location` + `Decoder::get_source_info`。**关键是：这些函数都在信号上下文中执行——怎么在只能用 `write()` 的约束下提取和输出数据？**

### 核心叙事线——"hs_err 的每一行都有一个 OS 函数在背后"

[10-04] 解释了 hs_err 输出的宏观框架（STEP 宏、write() 安全性、recursive_error_count），但没有解释 hs_err 中具体数据的来源。本文是 10-04 的 OS 端补完——把 `_steps[]` 中每个 `step_print_*` 调用的 OS 函数走读一遍。读者读完本文后，看到 hs_err 的任一段落都能说出它背后是哪个 OS 函数、用了什么系统调用、在什么约束下执行的。

### 和 [11-01]、[11-02]、[11-03]、[10-04] 的连接

- ★ **[11-01]** 的信号链 → `JVM_handle_linux_signal:656` → `report_and_die` 是 04 的入口。不理解信号分流 → 不理解什么情况下会到达 report_and_die。
- ★ **[11-02]** 的线程模型 → hs_err 的线程栈打印 → `JavaThread::print_on_error` → 需要线程的栈基址/大小信息（由 `os::create_thread` 的 `record_stack_base_and_size` 记录）。
- ★ **[11-03]** 的内存映射 → hs_err 的 Memory map 段 → 读者能从 maps 的权限标记中识别 reserve vs commit 区域。
- ★ **[10-04]** 的 `VMError::report_and_die` 框架 → 本文是 10-04 的 OS 端补完。

### 和 README §V 的关系

[11-os-layer README](README.md) §五的对比表。本文的"崩溃诊断"是 OS 三原语的最终出口——它组合了 01 的信号链（崩溃来源）、02 的线程模型（栈打印）、03 的内存映射（maps 输出）、以及 10-04 的 VMError 框架（输出框架）。读者读完本文后应能完整追踪"从 SEGSEGV 到 hs_err 文件的最后一行"。

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ `-XX:ErrorFile=hs_err_pid%p.log` 默认配置
- ★ `ulimit -c unlimited`（推荐——否则 core dump 被抑制）

## 三、聚焦源文件

| # | 文件 | 路径 | 模块 | 核心函数/类（行号） | 本文角色 |
|---|------|------|------|-------------------|---------|
| 1 | `os_linux_x86.cpp` | `src/hotspot/os_cpu/linux_x86/os_linux_x86.cpp` | os_cpu/linux_x86 | `os::print_context`(:770-833), `os::print_register_info`(:835-878), `ucontext_get_pc`(:116) | ★★★ 寄存器 dump——ucontext → 可读文本 |
| 2 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | os/linux | `os::print_memory_info`(:2749-2764), `os::print_dll_info`(:2270-2278), `JVM_handle_linux_signal` 末尾 report_and_die 触发(:638-656) | ★★ 崩溃入口 + memory/maps 输出 |
| 3 | `vmError.cpp` | `src/hotspot/share/utilities/vmError.cpp` | utilities | `VMError::report_and_die` master(:1307), `report()`(:417), `print_stack_trace`(:195), `print_native_stack`(:231), STEP 宏(:419-422), `first_error_tid`(:1205), `recursive_error_count`(:1341) | ★★★ 崩溃报告框架——step 调度 + 反递归保护 |
| 4 | `os.cpp` | `src/hotspot/share/runtime/os.cpp` | runtime | `os::print_location`(:1086-1150), `os::print_hex_dump`(:908-929) | ★★ 地址解析——寄存器值 → CodeBlob/oop/JNIHandle/Thread |
| 5 | `decoder.cpp` | `src/hotspot/share/utilities/decoder.cpp` | utilities | `Decoder::get_source_info`(:135) | ★ 符号化——PC → 函数名+偏移 |

**跨模块说明**：崩溃报告跨越 os_cpu/linux_x86、os/linux、utilities、runtime 四个模块。`os_linux_x86.cpp` 的 `print_context` 和 `print_register_info` 是本阶段的关键 OS 函数——它们从 `ucontext_t` 提取数据并格式化输出。`vmError.cpp` 的 STEP 框架调度这些 OS 函数——但 VMError 在 utilities/ 中调用 os_cpu/ 中的函数——这是本阶段最远的跨模块调用（utilities → os_cpu → utilities 的回调模式）。

**前置**：[11-01-Signals], [11-02-Threads], [11-03-Memory], [10-services-diag]

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。★ 必须覆盖 README §八 的全部 4 个深度问题。

### 4.1 ★★★ 为什么 hs_err 能打印寄存器但不能打印线程名？

```
问题：
  ① 寄存器值从哪里来？为什么能做到信号安全？
    答案方向: 寄存器值直接从 `ucontext_t` 结构体读——这是内核在信号投递时
    通过 `setup_rt_frame` 压到用户栈上的。零系统调用（不需要 `ptrace`）、
    零 malloc（不需要分配缓冲区）、零锁（不需要持有任何 glibc 锁）。
    ★ 完全信号安全。
    
  ② 线程名为什么不能打印？
    答案方向: 线程名需要 `pthread_getname_np(pthread_self(), buf, size)` →
    内部持有 glibc 的 `__thread_list_lock` 或等价的内部锁 → 如果 JVM 在
    持有该锁时崩溃 → 二次调用 `pthread_getname_np` → 死锁。
    这就是为什么 hs_err 的 `Current thread` 行只显示 `Thread*` 指针值
    （`0x00007f8b24083800`）和栈范围——不显示用 `pthread_getname_np` 获取的名字。
    JVM 自己维护的线程名（`JavaThread::_name`）可以直接读——但也可能被损坏。

  ③ hs_err 的输出顺序是什么？背后各用了什么接口？
    答案方向: [10-04]§四 详细解释了 STEP 序列。本文补上 OS 层：
    (1) header (reason, siginfo, pc, si_addr) → 信号上下文中直接记录
    (2) registers (RAX=...R15, RIP, EFLAGS) → os::print_context (:770)
    (3) top of stack → os::print_hex_dump (os.cpp:908) → 从 RSP 开始 hex dump
    (4) instructions at pc → os::print_hex_dump → 从 RIP 附近的 64 字节 hex dump
    (5) register to memory mapping → os::print_register_info (:835) → 
        尝试把寄存器值当指针解释
    (6) thread stack → JavaThread::print_on_error + print_native_stack
    (7) /proc/self/maps → os::print_dll_info (:2270) → 调用 `_print_ascii_file`
    (8) loaded shared libs → 同上
    (9) memory info → os::print_memory_info (:2749) → sysinfo() 系统调用
```

### 4.2 ★★★ os::print_context — 从 ucontext 提取寄存器

```
问题：
  ① x86_64 的 ucontext 结构里存着什么？怎么提取？
    线索: os_linux_x86.cpp:774-798
    代码引证:
      const ucontext_t *uc = (const ucontext_t*)context;
      st->print(  "RAX=" INTPTR_FORMAT, uc->uc_mcontext.gregs[REG_RAX]);
      st->print(", RBX=" INTPTR_FORMAT, uc->uc_mcontext.gregs[REG_RBX]);
      ...
      st->print(  "RIP=" INTPTR_FORMAT, uc->uc_mcontext.gregs[REG_RIP]);
      st->print(", EFLAGS=" INTPTR_FORMAT, uc->uc_mcontext.gregs[REG_EFL]);
    答案方向: ucontext_t 的 uc_mcontext.gregs[] 是一个寄存器数组——按 x86-64
    的 reg 编号索引（REG_RAX=0, REG_RBX=1, ..., REG_RIP=16, REG_EFL=17...）。
    每个寄存器值以 `INTPTR_FORMAT` 格式化为 16 进制。16 个通用寄存器 + RIP + 
    EFLAGS + CSGSFS + ERR + TRAPNO + OLDMASK + CR2 = 约 24 个寄存器（取决于 glibc 
    版本定义的 REG_* 数量）。

  ② 除了寄存器还输出什么？
    线索: os_linux_x86.cpp:799-833
    答案方向: 3 个子输出：
    (1) Top of Stack: 从 RSP 开始的 16×8 字节 hex dump —— 显示栈顶的内容
        （通常能找到返回地址、函数参数）
    (2) Instructions near PC: 从 RIP 附近的 16 字节 hex dump —— 显示崩溃的位置
        的机器码（不是反汇编——只是 hex 字节）
    (3) Thread context: `st->print_cr("Thread context switch was 1 counter ...")`
        标记线程上下文切换。

  ③ ARM/aarch64 平台怎么处理？
    答案方向: 不同的 cpu/ 子目录有各自的 `os_linux_aarch64.cpp`。
    `print_context` 模式相同——读 `uc_mcontext.regs[i]` → 输出。差异只在
    寄存器名（X0-X30 vs RAX-R15）和 frame pointer 的 convention
    （X29 是 ARM 的 FP，LR=X30 是链接寄存器——没有独立的 FP/RSP 对）。
```

### 4.3 ★★ os::print_register_info — 寄存器值作为指针的解释

```
问题：
  ① 怎么判断一个寄存器值"可能是指针"？
    线索: os_linux_x86.cpp:850-865 → 调 `os::print_location(st, reg_value)`
    答案方向: `os::print_location`（os.cpp:1086）按顺序检查：
    (1) CodeCache → CodeBlob::dump_for_addr → 输出 "StubRoutines::xxx" 或 "nmethod ..."
    (2) Universe::heap()->is_in(addr) → oopDesc::oop_or_null → 输出 "is an oop"
    (3) JNIHandle 检查 → "is a global jni handle"
    (4) Thread 检查 → "points into the stack of thread: ..."
    (5) 如果都不匹配 → 只输出地址和 hex dump
    关键：`print_location` 内部**不会**对野指针做全量检查——如果地址在 heap
    范围内但对象已损坏 → 解引用时可能二次 SIGSEGV。

  ② ★ README §八 问题 2: 如果寄存器值指向已 unmmap 的区域——怎么保护自己不嵌套 SIGSEGV？
    线索: os.cpp: print_location 的 `is_readable_pointer` 检查
    答案方向: `os::print_hex_dump` (os.cpp:908-929) 在解引用前调
    `is_readable_pointer(p)` → 这个函数通常用 `/proc/self/maps` 检查地址是否在
    有效映射内 → 或直接 `write(pipefd, addr, 1)` 测试。但这不能防止所有场景——
    地址在有效 VMA 内但页不可读（PROT_NONE overcommit 区域没有 commit）→ 访问
    触发 SIGSEGV → recursive_error_count + 1 → _current_step 跳过此 step。
    JVM **不尝试完美保护**——它接受"print_register_info 可能触发二次崩溃"并依赖
    recursive_error_count 机制捕获。

  ③ 如果寄存器值是 GC 移动中的对象的旧引用——输出的"解读"还有意义吗？
    答案方向: 可能无意义——但仍然是信息。假设 RAX=0x00007f8b2c003c00 是
    GC 移动前的旧 oop → `print_location` 试图解引用 → 可能触发 SIGSEGV →
    → 输出 "[error occurred during error reporting]" → 至少告诉了你
    "RAX 是个指针，指向堆，但无法安全读取"。不知道型 → 完全不知道 → 
    这是有信息 vs 无信息的区别。
```

### 4.4 ★★ JVM_handle_linux_signal → report_and_die 的过渡

```
问题：
  ① JVM_handle_linux_signal 在什么条件下决定"这个信号我处理不了"？
    线索: os_linux_x86.cpp:631-656
    答案方向: 走到了信号处理函数末尾 → 所有 8 条分流路径都不匹配 → 
    `chained_handler(sig, info, ucVoid)` 返回 false（链上无 handler）→
    `abort_if_unrecognized == true` → `VMError::report_and_die(t, sig, pc, info, ucVoid)`。
    [11-01]§二 详细解释了 6 路分流——本文引用它并聚焦"最后一步：分流失败 → crash"。

  ② abort_if_unrecognized 何时为 false？
    答案方向: JVM 的 `signalHandler` 包装（os_linux.cpp:5224）总是传 `true`——
    所以从 JVM handler 出发的信号总是"不能识别就 crash"。`false` 留给外部调用者——
    通过 `os::Linux::signal_handlers_are_installed` 标记后，第三方可以调用
    `JVM_handle_linux_signal(sig, info, uc, false)` → "试试看 JVM 能不能处理
    这个信号，不能就算了"。JVMTI agent 可能通过这种路径间接触发 JVM handler。

  ③ 调 report_and_die 前做了什么准备？
    线索: os_linux_x86.cpp:646-655
    代码引证:
      if (pc == NULL && uc != NULL) {
        pc = os::Linux::ucontext_get_pc(uc);  // fill PC from context
      }
      sigset_t newset;
      sigemptyset(&newset);
      sigaddset(&newset, sig);
      sigprocmask(SIG_UNBLOCK, &newset, NULL);  // unmask current signal
      VMError::report_and_die(t, sig, pc, info, ucVoid);
    答案方向: (1) 确保 PC 非 NULL（从 ucontext 读取）；(2) 解禁当前信号
    ——如果 JVM 在 report 过程中再次触发同一信号 → 可以递归进入 handler →
    recursive_error_count 机制处理。(3) 传入完整的 `t/sig/pc/info/ucVoid`→
    report_and_die 从中提取 siginfo、si_addr、PC 等信息。
```

### 4.5 ★★★ report_and_die 的 STEP 框架 — OS 层视角

```
问题：
  ① ★ README §八 问题 3: report_and_die 内部又 SIGSEGV——怎么检测递归？
    线索: vmError.cpp:1341-1425
    代码引证:
      static int recursive_error_count;
      if (first_error_tid != mytid) {
        // Different thread also crashed
        os::infinite_sleep();  // block this thread
      } else {
        if (recursive_error_count++ > 30) {
          out.print_raw_cr("[Too many errors, abort]");
          os::die();
        }
      }
    答案方向: 同一线程的递归崩溃 → `recursive_error_count++` → 如果
    超过 30 → 直接 `os::die()`（不生成 hs_err）。同时 `_current_step` 记录
    上次崩溃的 `__LINE__` → 第二次进入时 `_current_step < __LINE__` 条件
    使已完成的 step 被跳过 → 只从"上次崩溃的 step 之后"开始执行。
    这就是为什么 hs_err 中会出现 `[error occurred during error reporting (step N)]`。

  ② ★ README §八 问题 1: os::print_location 内部调用 Decoder::get_source_info → 
    如果 DWARF 数据未预加载 → mmap 换入新页（demand paging from disk）→ 
    信号上下文中，demand paging 是 AS-safe 的吗？
    答案方向: 内核 `handle_mm_fault` → `filemap_fault`（读取磁盘 I/O）→ 
    等待磁盘 I/O。理论上信号上下文中**可以** `wait_for_completion()` → 
    因为内核中断上下文已经完成（信号处理器在用户态执行）。但实际中——
    如果 I/O 不可中断（D state）→ 永久阻塞 → 崩溃报告永远写不完 →
    check_timeout 在超时后跳过 → 输出不完整。
    Decoder 的默认实现返回 false——所以现代 JVM 中这个路径通常不被触发。
    JVM 自己的符号化信息（通过 dladdr/dlsym）已经在内存中——不需要磁盘 I/O。

  ③ STEP 宏和 [10-04] 的关系是什么？
    答案方向: [10-04]§三 详细解释了 STEP 宏的 `__LINE__` 机制。本文不重复——
    只引用它并说明 OS 层的 step 实现：
    - step "printing register info" → os::print_context + os::print_register_info
    - step "printing native stack" → os::get_sender_for_C_frame + Decoder
    - step "printing Java stack" → JavaThread::print_on_error
    - step "printing dynamic libraries" → os::print_dll_info
    - step "printing memory info" → os::print_memory_info
    - step "printing CPU info" → 读 /proc/cpuinfo
```

### 4.6 ★★ hs_err 的 Memory map 段 — 和 [11-03] 的连接

```
问题：
  ① 怎么从 hs_err 的 maps 段里识别出 Java 堆？
    答案方向: Java heap 的特征：
    (1) 连续的大地址范围（GB 级）——通常在 CompressedOops base 附近（32GB 以下）
    (2) Permission pattern: 堆内部有 rw-p（commit 区域）和 ---p（reserve 未 commit）
    (3) 文件名列为空（anonymous mapping）——Java heap 从不文件映射
    与 [11-03]§一 中 reserve→commit 两阶段模型的对应：
    ---p → PROT_NONE + MAP_NORESERVE → reserve 了未 commit
    rw-p → PROT_READ|PROT_WRITE → commit 了可读写

  ② 未 commit 区域（PROT_NONE）在 maps 里怎么显示？
    答案方向: "---p" 权限标记，size 是 reserve 的大小（地址差），
    但不占用物理内存（RSS=0）。这就是 reserve→commit 不相等的可视化证据——
    从 maps 段一眼就能看出 JVM reserve 了 2GB 但只 commit 了 800MB。

  ③ os::print_dll_info 怎么读 /proc/self/maps？
    线索: os_linux.cpp:2270-2278
    代码引证:
      void os::print_dll_info(outputStream *st) {
        st->print_cr("Dynamic libraries:");
        char fname[32];
        pid_t pid = os::Linux::gettid();
        jio_snprintf(fname, sizeof(fname), "/proc/%d/maps", pid);
        if (!_print_ascii_file(fname, st)) {
          st->print("Can not get library information for pid = %d\n", pid);
        }
      }
    答案方向: `_print_ascii_file` 用 `open()+read()+write()` 直接系统调用——
    AS-safe。不是 `fopen()`（那需要 FILE* 锁）。读取 `/proc/<pid>/maps` 并将其
    内容原样写入 hs_err 的 st 输出流（即 hs_err 文件）。
```

### 4.7 ★★ print_native_stack — 信号上下文中的栈遍历

```
问题：
  ① native 栈怎么遍历？为什么可能只有一帧？
    线索: vmError.cpp:231-252
    答案方向: `os::get_sender_for_C_frame(&fr)` 跟随 frame pointer chain →
    如果 `-fomit-frame-pointer`（x86-64 上 rbp 被重用为通用寄存器）→
    frame pointer chain 断裂 → 只能解当前帧 → 输出 "..." 标记失败。
    现代编译器（gcc -O2）默认 `-fomit-frame-pointer` → native 栈解码
    精度受限于 DWARF 展开表（Decoder 提供）→ 如果 Decoder 不可用 →
    大多数 native 帧只有偏移量，没有函数名。

  ② ★ README §八 问题 4: hs_err 中 `Instructions:` 后面的 hex dump 是怎么反汇编的？
    答案方向: **没有反汇编**——`os::print_hex_dump` 输出的是 raw hex 字节 ——
    不是反汇编。查看 `os_linux_x86.cpp:824` → `print_instructions`（实际上也是
    hex dump + 简单的字节解释，不是反汇编器）。如果需要真正的反汇编 →
    需要 hsdis 插件（`-XX:+PrintAssembly`）或 gdb。hs_dis 通过 `dlopen("hsdis-amd64.so")`
    加载——但在信号上下文中 `dlopen` 不安全（需要持有 dynamic linker 锁 + 可能
    触发 mmap → 二次崩溃风险）→ 所以 hs_err 不反汇编，只输出 hex bytes。
    读者需要用 `objdump -d libjvm.so | grep -A 5 <offset>` 自行反汇编。

  ③ 和 [10-04]§四 的 `print_native_stack` 有何不同？
    答案方向: [10-04] 讲 STEP 框架中的 print_native_stack 调用位置和 Decoder 协作。
    本文补上 OS 层——`os::get_sender_for_C_frame` 的 frame pointer chain 实现 +
    当 rbp 被优化掉时的降级策略。10-04 讲"怎么调用"，11-04 讲"在什么约束下工作"。
```

## 五、文章结构

```
§〇 源文件清单（跨 os_cpu/linux_x86 + os/linux + utilities + runtime）

§一 ★★★ 为什么 hs_err 能打印寄存器但不能打印线程名？
  ❓ 寄存器值为什么是信号安全的？——从 ucontext_t 直接读，零系统调用
  ❓ 线程名为什么不能用 pthread_getname_np？——需要 glibc 内部锁
  1.1 hs_err 完整输出顺序 + 每个段背后的 OS 函数映射
  1.2 ucontext_t 结构——内核在信号投递时压栈的内容
  1.3 signalHandler + JVM_handle_linux_signal → report_and_die 的入口链（引用 [11-01]§一）

§二 ★★★ os::print_context — 从 ucontext 提取寄存器
  ❓ x86_64 vs ARM/aarch64 的 ucontext 格式差异？
  2.1 ★ 16 个通用寄存器 + RIP + EFLAGS 的提取——逐行代码走读
  2.2 Top of Stack hex dump——从 RSP 开始的 256 字节
  2.3 Instructions near PC——从 RIP 附近的 64 字节 hex dump
  2.4 ARM 对照——X0-X30 + FP(X29) + LR(X30)

§三 ★★ os::print_register_info — 寄存器值作为指针的解释
  ❓ 怎么判断一个寄存器值"可能是指针"？——os::print_location 的 5 层检查
  ❓ ★ README §八 问题 2: 野指针解引用触发嵌套 SIGSEGV——怎么保护？
  3.1 print_location 的检查链——CodeBlob → oop → JNIHandle → Thread → hex dump
  3.2 is_readable_pointer 的 guard——不能完全防御
  3.3 ★ 二次崩溃的检测——recursive_error_count + _current_step 跳过
  3.4 [error occurred during error reporting] 消息的含义

§四 ★★ JVM_handle_linux_signal → report_and_die 的过渡
  ❓ abort_if_unrecognized 何时为 true/false？
  ❓ ★ README §八 问题 3: report_and_die 内部又 SIGSEGV——怎么检测递归？
  4.1 ★ 从 JVM_handle_linux_signal:638 到 report_and_die:656 的完整调用链（引用 [11-01]§二）
  4.2 abort_if_unrecognized 的双重语义——JVM handler (true) vs 外部调用 (false)
  4.3 调 report_and_die 前的准备——PC 补全 + 信号解禁
  4.4 recursive_error_count + first_error_tid 的双层防递归

§五 ★★★ report_and_die 的 STEP 框架 — OS 层视角
  ❓ ★ README §八 问题 1: Decoder 触发 demand paging → AS-safe 吗？
  ❓ 和 [10-04]§三 的 STEP 宏是什么关系？
  5.1 6 个关键 OS 相关 step 的走读——register / native stack / maps / dll / memory / cpu
  5.2 check_timeout 的超时保护——防止某 step 永久阻塞
  5.3 [10-04] 的 STEP 宏框架 → 本文补上 OS 实现

§六 ★★ hs_err 的 Memory map 段 — 和 [11-03] 的连接
  ❓ ---p 和 rw-p 权限标记分别对应 reserve 和 commit？
  ❓ os::print_dll_info 怎么读 /proc/self/maps？
  6.1 ★ maps 段的 heap 识别——地址范围 + 权限模式 + anonymous mapping
  6.2 os::print_memory_info 的 sysinfo() 调用——物理内存/swap 统计
  6.3 [11-03] 的 reserve→commit 两阶段在 maps 中的可视化

§七 ★★ 和 [11-01] + [11-02] + [11-03] + [10-04] 的全局连接
  ❓ 01 的信号链 → crash 入口；02 的线程模型 → 栈打印；03 的内存映射 → maps 输出；10-04 的框架 → step 调度
  7.1 ★ [11-01] → JVM_handle_linux_signal:656 → 崩溃入口
  7.2 ★ [11-02] → thread stack print → thread_native_entry 记录的栈信息
  7.3 ★ [11-03] → reserve/commit → hs_err 的 maps 解析
  7.4 ★ [10-04] → VMError::report_and_die + _steps[] → OS 函数调用
  7.5 ★ README §五 阶段对比表——04 是 11 的最后一公里，综合检验

§八 GDB 验证 + 可证伪断言
```

## 六、写作要求

1. **★ "hs_err 每一段 → OS 函数映射表" 是本文的第一交付物**：每段输出标注 OS 函数、行号、系统调用、AS-safe 分析。

2. **★ print_register_info 的二次崩溃风险是本文的"aha moment"之一**：解释"为什么 hs_err 中有时出现 [error occurred during error reporting]"——不是 JVM bug，是 print_register_info 解引用野指针触发了嵌套 SIGSEGV，但 recursive_error_count 机制保护了输出继续。

3. **★ 和 [10-04] 的关系必须是"扩展"而不是"重复"**：本文不重复 STEP 宏机制——引用 [10-04]§三 后直接跳到 OS 实现。10-04 讲框架，11-04 讲 OS 数据源。

4. **★ ★ 和 [11-01]、[11-02]、[11-03] 的精确连接**：崩溃来自 01 的信号链（`JVM_handle_linux_signal:656`）、线程栈来自 02（`thread_native_entry → record_stack_base_and_size`）、maps 解析来自 03（reserve/commit 两阶段）。

5. **★ print_context 的 x86 vs ARM 对比表**：寄存器名对照 + frame pointer convention（rbp vs x29）—体现跨平台视角。

6. **★ Decoder + demand paging 的 AS-safe 分析**：虽然理论上可能（I/O wait），但 JVM 的符号信息已常驻内存→通常不触发。

## 七、输出格式

- Markdown 文件，命名为 `04-Crash.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/11-os-layer/`
- 元信息头：
  ```
  > **阶段**：[11-os-layer]
  > **前置**：[11-01-Signals]（崩溃信号来源）, [11-02-Threads]（线程栈信息）, [11-03-Memory]（maps 解析）, [10-services-diag]（VMError 框架）
  > **依赖本文**：无（11 阶段最终篇——组合全阶段能力）
  > **阅读收益**：理解 hs_err 文件中每一段 OS 层输出的生产者——寄存器 dump 如何从 ucontext_t 安全提取、寄存器值作为指针的解释如何防范二次崩溃、/proc/self/maps 的输出如何对应 reserve/commit 两阶段模型
  ```

## 禁止行为

- ❌ 深入 x86/ARM 汇编指令格式（`mov %rax, 0x10(%rbx)` 的 AT&T vs Intel 语法差异）——这属于汇编教程
- ❌ 展开 ELF/DWARF 的 .eh_frame / .debug_info 字节级解析——Decoder 只在"被调用"的接口层级讲
- ❌ 把 [10-04] 的 STEP 宏重复解释——只引用 [10-04]§三 的 STEP 机制，然后跳到 OS 实现
- ❌ 把 `/proc/self/maps` 的格式解析当成"procfs 手册"抄一遍——只讲 maps 中 "---p" 和 "rw-p" 与 reserve/commit 的对应
- ❌ 忽略 recursive_error_count 的防无限循环机制——这是"崩溃报告自己崩溃"的唯一防线
- ❌ 忘记 [11-01] 的信号链——每提到 JVM_handle_linux_signal:656，必须引用 [11-01]§二 的 6 路分流
- ❌ 忘记 [11-02] 的线程栈——`thread_native_entry:888` 的 `record_stack_base_and_size` 是栈打印的基础
- ❌ 忘记 [11-03] 的 reserve/commit——hs_err 的 maps 中 "---p" = reserve、"rw-p" = commit
- ❌ 不覆盖 README §八 的全部 4 个深度问题——每个问题必须在 §四 中有一个问题组明确对应

## 要求行为

- ✅ **★ hs_err 输出段 → OS 函数映射表**：每段 / STEP 名 / OS 函数 / 行号 / 系统调用 / AS-safe 分析
- ✅ **★ print_register_info 的 5 层地址检查流程图**：CodeBlob → oop → JNIHandle → Thread → hex dump
- ✅ **★ recursive_error_count 的有限状态机**：depth 0 → normal report；depth 1 → skip completed steps；depth ≥ 30 → abort only
- ✅ **★ x86 vs ARM 的 ucontext 寄存器对照表**：x86 RAX-R15 → ARM X0-X30，x86 RBP → ARM X29，x86 RIP → ARM PC
- ✅ **★ 和 [10-04] 的精确连接**：STEP "printing register info" → os::print_context + os::print_register_info；STEP "printing memory info" → os::print_memory_info
- ✅ **★ 和 [11-01] 的精确连接**：`JVM_handle_linux_signal:656` → `VMError::report_and_die`（崩溃入口 = 信号分流失败）
- ✅ **★ 和 [11-02] 的精确连接**：thread stack print → `record_stack_base_and_size`（:888）记录的栈信息
- ✅ **★ 和 [11-03] 的精确连接**：Memory map 的 "---p" = PROT_NONE = reserve / "rw-p" = PROT_READ|PROT_WRITE = commit
- ✅ **★ 【11-os-layer README §五 阶段对比表】的引用**
- ✅ **★ GDB 可证伪断言 ≥10 条**

## GDB 可证伪断言

1. **断言：`os::print_context` 从 `ucontext_t` 读取寄存器——零系统调用**
   验证：`br os_linux_x86.cpp:770` → 触发 SIGSEGV → `bt` → 调用栈底是 `__restore_rt` → `stepi` 单步执行 → `strace -p <pid>` 观察 → 无 read/write/mmap 系统调用
   预期：print_context 内部只有计算 + 字符串格式化，无系统调用

2. **断言：`os::print_register_info` 可能触发二次 SIGSEGV**
   验证：`br os_linux_x86.cpp:835` → 构造一个场景让 RAX 指向 PROTNONE 区域（未 commit 的堆段）→ 单步到 `print_location(rax)` → 触发 SIGSEGV → 二次进入 report_and_die
   预期：`recursive_error_count` 从 0 → 1，输出 `[error occurred during error reporting]`

3. **断言：`recursive_error_count > 30` 时直接 `os::die()`**
   验证：设置 `recursive_error_count = 30`（GDB `set recursive_error_count=30`）→ 触发 SIGSEGV → `br vmError.cpp:1424` → 断点命中
   预期：os::die() 被调用，不生成 hs_err

4. **断言：`first_error_tid` 的 cmpxchg 保证只有一个线程生成 hs_err**
   验证：两个线程同时 `br os_linux_x86.cpp:656` → 第一个线程到达 `br vmError.cpp:1351`（cmpxchg 成功）→ 第二个线程 cmpxchg 失败 → 进入 `os::infinite_sleep()`
   预期：只有一个线程执行 report，另一个 sleep

5. **断言：`os::print_dll_info` 用 `open()+read()+write()` 而非 `fopen()` 读 `/proc/self/maps`**
   验证：`br os_linux.cpp:2275` → `stepi` 进入 `_print_ascii_file` → `strace -p <pid>` 观察 → 只看到 `open("/proc/<pid>/maps", O_RDONLY)` + `read()` + `write()`
   预期：无 `fopen` 调用，无 `FILE*` 锁

6. **断言：`os::print_location` 把寄存器值解析为 CodeBlob**
   验证：`br os.cpp:1086` → 在 CompilerThread 上触发 SIGSEGV → `p addr` → 落在 CodeCache 范围内 → `p b->dump_for_addr(addr, ...)` → 输出 "nmethod" 或 "StubRoutines"
   预期：输出 "is a CodeBlob at ..."

7. **断言：`os::print_location` 把寄存器值解析为 oop**
   验证：`br os.cpp:1086` → 在 JavaThread 上触发 SIGSEGV → `p addr` → 落在堆范围内 → `p Universe::heap()->is_in(addr)` → true → 输出 "is an oop"
   预期：输出 "is an oop"

8. **断言：`print_native_stack` 依赖 frame pointer chain → 如果 rbp 优化掉 → 只有一帧**
   验证：编译 `libjvm.so` 时加 `-fomit-frame-pointer` → 触发 SIGSEGV → `br vmError.cpp:246` → 观察 `os::get_sender_for_C_frame` 返回 → 可能返回 NULL（只有一帧）
   预期：Native frames 列表只有 1-2 帧，其余显示 "..."

9. **断言：`os::print_memory_info` 通过 `sysinfo()` 获取系统内存信息**
   验证：`br os_linux.cpp:2754` → 触发 SIGSEGV → `stepi` 单步 `sysinfo(&si)` → `p si.totalram` → 确认 sysinfo 返回值
   预期：sysinfo() 成功返回，totalram ≈ 物理内存

10. **断言：`JVM_handle_linux_signal` 的 `chained_handler` 返回 false 后才调 `report_and_die`**
    验证：`br os_linux.cpp:5301`（chained_handler 入口）→ `br os_linux_x86.cpp:656`（report_and_die 调用）→ 先命中 5301 → chained_handler 返回 false → 再命中 656
    预期：信号被判定为不可识别 → chained_handler 也无法处理 → crash

11. **断言：hs_err 输出期间 `write()` 可能被中断导致最后几行缺失**
    验证：在 `br vmError.cpp` 的 STEP "printing end marker" 后设断点 → 监控 fd → 如果 JVM 在此 step 中崩溃 → hs_err 文件缺少 "[END]" 标记
    预期：最后一行不是 `[END]`，而是某个 step 的部分输出
