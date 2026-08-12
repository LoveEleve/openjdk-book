# 04. 一个 SIGSEGV,五件事一起做 — 信号与安全点

> **前置依赖**：[02 — 虚拟内存](02-virtual-memory.md)：栈保护区的 PROT_NONE 与 guard 页；[03 — 线程](03-threads-and-sync.md)：safepoint 的线程待遇
> → **后续**：域 02 [Assembler — `test [polling_page], rax` 这 4 字节怎么生成](openjdk/vol-02/02-assembler/01-codebuffer-abstract-assembler.md)
> 关联域: 18-safepoint(轮询页消费方)、24-frame(栈遍历)、22-deopt(implicit null 的 uncommon trap)

## 你以为 SIGSEGV = 崩溃。JVM 把它变成了瑞士军刀。

对普通程序,SIGSEGV 意味着段错误、core dump、程序结束。但 JVM 的信号处理器 `JVM_handle_linux_signal`(`os_linux_x86.cpp:268`)接住 SIGSEGV 后,会**依次问五个问题**——每个问题对应一种完全不同的合法场景:

```
① 是栈溢出吗?      → StackOverflowError(Java 异常,可恢复)
② 是安全点轮询吗?  → 进入 safepoint(全局协作)
③ 是隐式空指针吗?  → 跳转 uncommon trap(JIT 优化)
④ 是内存序列化页吗?→ 内存屏障替代(store-load barrier)
⑤ 都不是?          → 真崩溃 → hs_err + core dump
```

同一个信号、同一个 handler,靠**检查 faulting address(si_addr)落在哪**来判决。这一篇把五阶段逐个拆开,再看两个支撑机制:信号链(libjsig)和轮询页。

## 1. SIGSEGV 五阶段:一个信号,五种判决

### 阶段 1:栈溢出?(os_linux_x86.cpp:357-397)

handler 先检查 faulting address 是否落在**当前线程的栈保护区**里(`in_stack_yellow_reserved_zone`,:364):

- 落在 **yellow zone** → `thread->disable_stack_yellow_reserved_zone()` + 设栈溢出状态 → 构造 `StackOverflowError` 抛出——**可恢复**(第二章的四级保护区在这里派上用场)
- 落在 **red zone**(:393 `in_stack_red_zone`)→ yellow 都用完了,连抛异常都不够 → "An irrecoverable stack overflow has occurred"(:397)→ fatal

- [内核: siginfo_t 结构——si_signo(信号号,SIGSEGV=11)、si_code(SEGV_MAPERR=地址未映射/SEGV_ACCERR=权限错误)、si_addr(出错地址)。handler 第三个参数 ucontext_t 保存 fault 时完整 CPU 状态]
- [man 2 sigaction](SA_SIGINFO flag)

### 阶段 2:安全点轮询?(os_linux_x86.cpp:431)

第二个问题:`si_addr` 是不是**轮询页**(`os::is_poll_address`,os.hpp:429)?

```cpp
// os_linux_x86.cpp:431 —— poll 判决(截取,核心语句逐字)
if (sig == SIGSEGV && os::is_poll_address((address)info->si_addr)) {
  stub = SharedRuntime::get_poll_stub(pc);   // 跳转到 poll stub → 阻塞到 safepoint 结束
}
```

机制(详见第三节):JIT 代码里每个方法入口有 `test [polling_page], rax`(4 字节,正常 1 cycle);safepoint 请求时把轮询页设成不可读(`make_polling_page_unreadable`,os_linux.cpp:5720)→ 下一次 test 触发 SIGSEGV → 这里收网:设好 poll stub 跳转目标,进入 safepoint 阻塞逻辑(`SafepointSynchronize::block` 在 poll stub 里)。

- [x86: 为什么选 test 而不是 mov?test 只读不写寄存器——数据被丢弃,唯一目的是触发 fault]

### 阶段 3:隐式空指针?(os_linux_x86.cpp:483-485)

第三个问题:si_addr 是不是接近 0(小地址)?

```cpp
// os_linux_x86.cpp:483 —— 隐式 null 判决(截取,核心语句逐字)
} else if (sig == SIGSEGV &&
         !MacroAssembler::needs_explicit_null_check((intptr_t)info->si_addr)) {
    // Determination of interpreter/vtable stub/compiled code null exception
    stub = SharedRuntime::continuation_for_implicit_exception(thread, pc, SharedRuntime::IMPLICIT_NULL);
}
```

JIT 编译 `obj.field` 时,不生成显式判空分支,而是直接 `mov [rX+off], val`——**rX 为 null 时,这条指令访问地址 0 附近,触发 SIGSEGV**,handler 认出这是隐式 null check,跳转 uncommon trap(域 22)。

- [x86: 为什么不用 `cmp rX, 0; jne null_handler`?mov 方案 4 字节(2 字节 opcode + 2 字节 ModR/M),cmp+jne 方案 7 字节。每个方法里约 10 次 null check → 每方法省 30B 机器码 → 少一次 icache miss]

**关键设计 (斜体)**: *这是 JVM 把 x86"没有硬件 null check"的劣势转成优化优势的范例——用信号异常替代显式分支,用罕见的 fault 换常态路径的瘦身。代价是信号处理的开销(只有真 null 时付),收益是每个方法的常态路径小 30B。*

### 阶段 4:内存序列化页?(os_linux_x86.cpp:508-510)

第四个问题:si_addr 是不是**序列化页**(`is_memory_serialize_page`)?是 → `block_on_serialize_page_trap()`(:510)阻塞到页面权限恢复。

- [x86: 为什么 mprotect 构成内存屏障?mprotect → TLB shootdown → 内核向所有 CPU 发 IPI → 各 CPU 失效对应 TLB 条目并回执。这个"全 CPU 确认"的物理顺序,天然保证 CPU0 的 store 在 CPU1 的 load 之前可见——即 store-load barrier。`UseMembar=false` 时用页面权限切换(RW→RO→RW)代替 mfence]
- 每线程独立 cache line 偏移(`thread >> shift & mask`)——避免所有线程写同一个 cache line 的 MESI 竞争

### 阶段 5:崩溃?(os_linux_x86.cpp:617)

以上都不是 → `VMError::report_and_die(t, sig, pc, info, ucVoid)`——真正的崩溃现场:寄存器状态(16 个 GPR + XMM)、栈帧、`/proc/self/maps` 内存映射、动态库列表、全线程栈——写进 `hs_err_pid.log`。

- [C++: hs_err 是 production crash 唯一的线索。crash handler 里**不调用 malloc**(堆可能已损坏)——全部信息写进预分配静态缓冲区 → write(fd, buffer, len)]
- [man 5 proc]

## 2. libjsig 信号链:当 profiler 也想接管 SIGSEGV

### 拦截 sigaction

JVM 不是唯一想处理信号的——profiler、agent 也想。如果各装各的,后来的会覆盖先来的。解法是 **libjsig**(signal-chaining library),通过 `LD_PRELOAD` 预加载:

- [C++: LD_PRELOAD 机制——设置 `LD_PRELOAD=libjsig.so`,动态链接器优先加载它,它的 sigaction 符号被优先解析——所有 sigaction 调用被拦截,原始 glibc 实现被"劫持"]

JVM 启动时检测 libjsig 是否加载(`os_linux.cpp:5177` 的 `install_signal_handlers`):

```cpp
// os_linux.cpp:5177 起(截取核心)
begin_signal_setting = CAST_TO_FN_PTR(..., dlsym(RTLD_DEFAULT, "JVM_begin_signal_setting"));
if (begin_signal_setting != NULL) {
  libjsig_is_loaded = true;         // libjsig 在,启用信号链
}
if (libjsig_is_loaded) {
  (*begin_signal_setting)();        // 告诉 libjsig: JVM 要设 handler 了,先保存旧的
}
set_signal_handler(SIGSEGV, true);  // JVM 装自己的 handler
set_signal_handler(SIGPIPE, true);
set_signal_handler(SIGBUS, true);
set_signal_handler(SIGILL, true);
set_signal_handler(SIGFPE, true);
set_signal_handler(SIGXFSZ, true);
```

**链式调用**:JVM 的 handler 处理完自己的事后,若事件不属于 JVM(比如 profiler 的 SIGSEGV)→ 调 `chained_handler`(os_linux.cpp:5100)把控制权交给链上的下一个 handler。SIGPIPE/SIGXFSZ 在 `JVM_handle_linux_signal` 开头就优先走链(os_linux_x86.cpp:283-290)——**先问别人要不要,再自己处理**。

- [man 2 sigaction][man 7 signal]

### SIGBREAK:kill -3 为什么是线程转储

- [内核: SIGQUIT(kill -3)默认行为是 core dump + 终止。JVM 注册 handler 替代——收到 SIGQUIT 打印全部线程栈,不 dump core 不终止]

JVM 里 `SIGBREAK` 就是 `SIGQUIT` 的别名(os.cpp:339 `#define SIGBREAK SIGQUIT`),处理在 os.cpp:361 的 case 分支——`ThreadDump` 输出全线程栈。**这也是 `kill -3` 能拿到 jstack 的原因**:不是 jstack 在跑,是 JVM 自己收到了信号。

## 3. Safepoint 轮询页:4 字节控制全部 Java 线程

### 一个页,两个状态

轮询页是 JVM 全局协调的核心(`os.hpp:427-431`):

```cpp
// os.hpp:427-431(截取)
// Safepoint support
static address _polling_page;
static bool    is_poll_address(address addr) {
  return addr >= _polling_page && addr < (_polling_page + os::vm_page_size());
}
```

- 正常:页面 `PROT_READ`——JIT 代码里的 `test [polling_page], rax` 读它,1 cycle,零开销
- safepoint 请求:`make_polling_page_unreadable()`(os_linux.cpp:5720,内部就是 `guard_memory` = mprotect PROT_NONE)→ TLB shootdown IPI → 所有 CPU 的轮询页条目失效 → 下一次 poll check → SIGSEGV → 信号 handler 阶段 2 → `SafepointSynchronize::block()`

- [x86: JIT 生成的 poll check——`test [polling_page], rax` = 4 字节(opcode 85 + ModR/M 05 + 32-bit 偏移)。正常路径:读 1 cycle,不分支——零开销。vs flag 方案:`cmp [flag], 0; jne safepoint` = 7 字节,且分支预测失败 20 cycles]

**关键设计 (斜体)**: *为什么用"页面权限"而不是"变量标志"?两种方案的常态开销差一个数量级:变量方案每次 poll 都是一次带分支的读(预测失败 20 cycles);页面方案正常时是 1 cycle 的 test,只有真正要 safepoint 时才让 poll 失败。用"罕见异常"换"常态零成本"——和阶段 3 的隐式 null check 是同一个哲学。*

- [内核: 信号处理全流程——内核返回到用户空间前检查 pending signals → 找到最高优先级未屏蔽信号 → 有 handler:设置 sigframe(保存返回地址/寄存器/mask)→ 返回 handler → handler 返回 → sigreturn 恢复全部上下文]

### 记忆串联:五阶段就是一个 if-else 链

回头看第一节的五阶段,它们在 `JVM_handle_linux_signal` 里就是**一串 si_addr 判断**:

```
si_addr 在栈保护区?      → 栈溢出(357-397)
si_addr 是轮询页?        → safepoint(431)
si_addr < heap_top 且非显式检查? → 隐式 null → uncommon trap(483-485)
si_addr 是序列化页?      → 内存屏障(508-510)
都不是?                 → crash(617)
```

这就是"一个 SIGSEGV,五件事一起做"的全部秘密:**先到先判,判中即走**。

## 看见:信号处理器的实物

`jcmd <pid> VM.info` 的输出里有一段信号处理器列表(域 02 实测):

```
Signal Handlers:
   SIGSEGV: javaSignalHandler in libjvm.so, mask=11100100010111111101111111111110,
            flags=SA_RESTART|SA_SIGINFO, unblocked
    SIGBUS: javaSignalHandler in libjvm.so, ... flags=SA_RESTART|SA_SIGINFO, unblocked
   SIGPIPE: javaSignalHandler in libjvm.so, ... flags=SA_RESTART|SA_SIGINFO, unblocked
```

每行两个要点: handler 名(`javaSignalHandler`——JVM 信号处理入口)和 **flags=SA_RESTART|SA_SIGINFO**——正是本节讲的"带 siginfo 的链式处理"的两个开关。下次看到 `kill -3` 打出线程栈、看到 JIT 代码里隐式 null check 不 crash,你就知道背后是同一个函数在按 si_addr 做五次判决。

## 核心悬念

"一个 SIGSEGV——JVM 同时做 NullPointer + GC Safepoint + StackOverflow + Memory Barrier + Crash Dump。" x86 没有硬件 null check,JIT 用 `mov [0], rX`;safepoint 用 mprotect + TLB shootdown 做全局协调。这些都是**利用 Linux page fault 做硬件加速**。而这一切的起点,是 JIT 生成的 4 字节指令——`test [polling_page], rax`。它怎么被生成?汇编器怎么把一条抽象指令变成机器码?这就是域 02 Assembler 的故事。

> → 域 02 [Assembler — `test [polling_page], rax` 这 4 字节指令是怎么生成的?](openjdk/vol-02/02-assembler/01-codebuffer-abstract-assembler.md)
