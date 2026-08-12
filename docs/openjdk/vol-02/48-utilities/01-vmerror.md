# 01. vmError — hs_err_pid.log 是怎么写出来的

> **前置依赖**:[45-math-library/02 — StubRoutines 生成管道](openjdk/vol-02/45-math-library/02-stubroutine-native.md):StubCodeDesc 名字链——本篇的崩溃现场打印会再遇到它;01-os/04 — 信号与安全点(SIGSEGV 从哪来)
> → **后续**:[02 — ConcurrentHashTable + BitMap](02-concurrent-bitmap.md)
> 关联域: 05-cpu-primitives(Atomic CAS——令牌抢占的原子性)、13-jit(CodeBlob/Disassembler)、18-safepoint(WatcherThread 的超时干预)

## 一条 SIGSEGV 之后,世界分成了两半

进程收到 SIGSEGV,信号处理器接管:这是 JVM 的最后一道防线。`VMError::report_and_die`(vmError.cpp:1272)负责把现场写进 `hs_err_pid<pid>.log`——这份文件包含寄存器、native 栈、Java 线程栈、内存统计、VM 版本与 flags,是崩溃后唯一的诊断来源。但写这份日志本身充满了危险:**崩溃线程还能安全地写文件吗?另一个线程同时崩了怎么办?报告写到一半再次崩溃怎么办?** 这篇拆开 vmError.cpp(1901 行)看它如何回答这三个问题。

## 1. 第一个错误令牌:谁有权写日志

### 1.1 场景:两个线程同时 SIGSEGV

两个线程同时崩溃,信号处理器并发执行——如果都去写日志,文件就花了。答案是一个全局"令牌":

```cpp
// vmError.cpp:1351-1352(逐字)
  intptr_t mytid = os::current_thread_id();
  if (first_error_tid == -1 &&
      Atomic::cmpxchg(mytid, &first_error_tid, (intptr_t)-1) == -1) {
```

`first_error_tid` 是 `volatile intptr_t VMError::first_error_tid = -1`(vmError.cpp:1208)。`Atomic::cmpxchg(mytid, &first_error_tid, -1)`:只有当前值还是 -1 时,才把 mytid 写进去,并返回旧值 -1——**CAS 成功 = 抢到令牌**,进入完整报告流程;抢不到(返回的不是 -1)= 已经有别的线程在写了,走另一条路:

```cpp
// vmError.cpp:1409-1420(截取核心,逐字)
    if (first_error_tid != mytid) {
      if (!SuppressFatalErrorMessage) {
        char msgbuf[64];
        jio_snprintf(msgbuf, sizeof(msgbuf),
                     "[thread " INTX_FORMAT " also had an error]",
                     mytid);
        out.print_raw_cr(msgbuf);
      }

      // Error reporting is not MT-safe, nor can we let the current thread
      // proceed, so we block it.
      os::infinite_sleep();
```

后到的线程只输出一行 `[thread %d also had an error]`,然后 **`os::infinite_sleep()` 无限睡眠**——注释说得很直白:"Error reporting is not MT-safe, nor can we let the current thread proceed"。等第一个线程把日志写完,`os::die()`(1634 行,abort 失败后的最终手段)结束进程,所有线程一起死。

同线程还有第三层保护:报告**过程中**再次崩溃(递归)超过 30 次,打印 `[Too many errors, abort]` 直接 `os::die()`(1423-1428)。

**关键设计 (斜体)**: *为什么用 CAS 而不是一把锁?信号处理器可能在任何指令处打断线程——如果崩溃线程正持有锁,而另一个线程在错误处理里又去拿这把锁,直接死锁,日志永远写不完。CAS 不需要任何锁、不分配内存、不依赖任何数据结构,是"最后的安全网"——正是第一篇(05-cpu)讲的 LOCK 原子操作,在这里的用法是"无锁的抢令牌"。*

- [x86: `Atomic::cmpxchg` 在 x86 上就是 `lock cmpxchg`(atomic_linux_x86.hpp:72)——上一篇 05-cpu 讲的 1 字节前缀,在这里是崩溃现场里唯一敢用的同步原语]

## 2. 几十个 STEP:一次串行的书写流水线

### 2.1 场景:日志里那一大段 "Current thread/Stack/Registers" 是谁排的序

拿到令牌的线程调用 `report()`(vmError.cpp:420),整份日志由 **STEP 宏**驱动的流水线构成:

```cpp
// vmError.cpp:422-425(逐字)
# define BEGIN if (_current_step == 0) { _current_step = __LINE__;
# define STEP(s) } if (_current_step < __LINE__) { _current_step = __LINE__; _current_step_info = s; \
  record_step_start_time(); _step_did_timeout = false;
# define END }
```

每个 `STEP("printing xxx")` 是流水线的一节:报告执行到 `if (_current_step < __LINE__)` 时记下**当前代码行号**作为 step 编号,再执行本节的打印代码。主要的 STEP 按顺序是:fatal message(432)、exception/signal name(531)、thread+pid(564)、Java version(582)、problematic frame(586)、core file info(598)、summary(618)、VM option summary(626)、machine/OS info(634)、date/time(641)、thread 段(647)、stack bounds(682)、**native stack(713)**、**Java stack(727)**、**siginfo(744)**、**register info(761)**、**registers/top of stack/instructions(769)**、code blob(795)、VM options(953)、flags(961)、signal handlers(993)、OS info(1013)、CPU info(1020)、**memory info(1026)**……每节独立失败。

报告写两份:先 `report(&out, false)` 把 '#' 摘要打到 stdout(1483-1495),再 `prepare_log_file(ErrorFile, "hs_err_pid%p.log", ...)`(1508)打开日志文件,`report(&log, true)` 写完整版(1524)。`prepare_log_file`(1225)按序尝试:用户指定的 `ErrorFile` 模式 → 当前目录的默认名 → 临时目录。

**关键设计 (斜体)**: *STEP 编号用 `__LINE__`(代码行号)而不是 1、2、3——意义在于:报告本身就是"最容易再崩溃"的代码,如果某一节写到一半再次 SIGSEGV,重入的 report 会打印 `[error occurred during error reporting (printing xxx, id 0x...)]`(1462 行),`_current_step_info` 的字符串直接告诉你是哪一节崩了——**step 名就是断点定位符**。配合超时:错误处理受 `ErrorLogTimeout`(默认 2×60 秒,globals.hpp:636)全局预算约束,每个 step 最多 `max(5 秒, 全局的 1/4)`(1755-1756 行;4:1 比例见 461-462 测试注释),WatcherThread 周期调用 `check_timeout()`(1715)检测:step 超时就跳过继续,全局超时就 `os::die()` 收场。*

## 3. Native frames:地址到名字的翻译

### 3.1 场景:hs_err 里那串 "V .../ C ..." 前缀

`print_native_stack`(vmError.cpp:234-280)输出崩溃线程的 native 栈,开头一行是帧分类的图例:

```cpp
// vmError.cpp:238(逐字)
    st->print_cr("Native frames: (J=compiled Java code, A=aot compiled Java code, j=interpreted, Vv=VM code, C=native code)");
```

每一帧由 `fr.print_on_error(st, buf, buf_size)`(242)打印,再尝试 `Decoder::get_source_info`(246)补充源文件行号。栈怎么走?对 JavaThread 用 `RegisterMap` + `fr.sender(&map)`(259-261)按 Java 帧链回溯;对 C 帧用 `os::get_sender_for_C_frame`(265-266)按帧指针回溯——两种帧的行走规则完全不同,打印时统一成一行。

- [C++: 地址 → 名字的翻译由 `Decoder`(decoder.cpp:99)完成。Linux 平台是 ELF 解码器(decoder_elf.cpp):直接读 libjvm.so 的 ELF 符号表,解析出 `函数名+偏移`;注意**不是 dladdr**——`Decoder` 自行解析 ELF,不依赖动态链接器的符号查询(还支持在 .so 被 strip 后回退成裸地址)]
- [man 1 addr2line:libjvm.so 被 strip 时,hs_err 里只有裸地址——用 `addr2line -e libjvm.so 0x...` 手动解析]

**关键设计 (斜体)**: *Decoder 在错误处理中有"安全模式":`Decoder::decode` 内部检查 `os::current_thread_id() == VMError::first_error_tid`(decoder.cpp:100)——只有持有令牌的错误处理线程才做完整的符号解析;其他场景(比如运行时别的线程想解码)走保守路径,避免在崩溃现场再次触发动态库操作。诊断代码自己也要能被诊断,这是"最后一道防线"的自觉。*

## 4. 崩溃现场:siginfo、寄存器、code blob

### 4.1 场景:从 si_addr 到 RIP 附近的指令字节

`report()` 的现场部分(744-819 行)依次输出四样东西,每一节一个独立 STEP:

**siginfo**(744-751)→ `os::print_siginfo`(os_posix.cpp:1315):

```cpp
// os_posix.cpp:1315-1330(截取核心,逐字)
void os::print_siginfo(outputStream* os, const void* si0) {

  const siginfo_t* const si = (const siginfo_t*) si0;
  ...
  const int sig = si->si_signo;
  os->print(" si_signo: %d (%s)", sig, os::Posix::get_signal_name(sig, buf, sizeof(buf)));
  enum_sigcode_desc_t ed;
  get_signal_code_description(si, &ed);
  os->print(", si_code: %d (%s)", si->si_code, ed.s_name);
```

`si_signo`(SIGSEGV=11)说明是什么信号,`si_code`(如 SEGV_MAPERR=1,访问未映射地址)说明怎么触发的,对同步错误信号(SIGSEGV/SIGBUS/SIGILL/SIGTRAP/SIGFPE)还会打 `si_addr`(os_posix.cpp:1361-1363)——**触发崩溃的内存地址**。空指针解引用 vs 悬垂指针,从这里一眼区分。

**寄存器**(769-775)→ `os::print_context`(os_linux_x86.cpp:747):打印 RAX-R15、RIP(crash 指令地址)、RSP、EFLAGS,然后两段"现场采样":

```cpp
// os_linux_x86.cpp:747-754(截取核心,逐字)
void os::print_context(outputStream *st, const void *context) {
  if (context == NULL) return;
  const ucontext_t *uc = (const ucontext_t*)context;
  st->print_cr("Registers:");
#ifdef AMD64
  st->print(  "RAX=" INTPTR_FORMAT, (intptr_t)uc->uc_mcontext.gregs[REG_RAX]);
  st->print(", RBX=" INTPTR_FORMAT, (intptr_t)uc->uc_mcontext.gregs[REG_RBX]);
```

`print_context` 尾部(795-805)打印 `Top of Stack`(sp 起 8 个 slot 的 hex dump,797 行)和 `Instructions:`(pc 附近的原始指令字节,804 行)——RIP 指向的那条指令长什么样,配合 objdump 就能对上源码。

**register info**(761-767)→ `os::print_register_info`(os_linux_x86.cpp:810):"Register to memory mapping"——把每个寄存器的值过一遍 `print_location`:如果值像一个有效指针,就翻译成"指向哪个对象/哪段代码/哪块堆"。

**code blob**(795-819):如果 RIP 落在 CodeCache 里,打印它属于谁:

```cpp
// vmError.cpp:808-811(逐字)
            StubCodeDesc* desc = StubCodeDesc::desc_for(_pc);
            if (desc != NULL) {
              desc->print_on(st);
              Disassembler::decode(desc->begin(), desc->end(), st);
```

**上一篇(45-02)的伏笔在这里兑现**:stub 生成时登记的 StubCodeDesc 名字链,让崩溃在 stub 代码里的现场直接显示 `StubRoutines::libmSin` 的名字并反汇编它的全部指令;解释器里崩了则打印具体 codelet(802-805);否则反汇编整个 nmethod。

**关键设计 (斜体)**: *hs_err 的哲学是"宁可多打不可漏打":寄存器值不是裸打印,而是尝试翻译成语义(指向哪);指令不是只有一条,而是把 pc 附近全部 dump;代码 blob 连名字带反汇编都给。每一步都假设"另一个组件可能也是坏的"——Decoder 有安全模式、report 有 step 超时、连打印本身都可能再崩。诊断系统对自身故障的防御,是它最被低估的设计。*

## 核心悬念

"hs_err_pid.log 是'崩溃后的慢速串行流水线'——一个线程抢令牌、几十个 STEP 依次写。而 JVM 正常运行时的并发结构完全是另一回事:`String.intern` 的 SymbolTable 要用无锁并发哈希表扛住高并发,GC 要用位图在 1 bit 里标记一个对象的状态。下一篇:ConcurrentHashTable + BitMap——lock-free 查找与位级标记。"

> → [02-concurrent-bitmap.md](02-concurrent-bitmap.md):ConcurrentHashTable 的 per-bucket mutex + CAS resize,BitMap 的位级标记
