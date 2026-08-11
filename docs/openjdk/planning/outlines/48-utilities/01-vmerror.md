# 01. vmError — hs_err_pid.log 生成引擎

> 🔴 Deep | 1901行的 crash handler
> 读者处境: JVM crash→SIGSEGV→JVM signal handler→`VMError::report_and_die()`→hs_err_pid.log。这个文件包含: register dump, native stack trace, Java thread dump, loaded classes, VM version, memory maps, dmesg。

### 1. "Error reporting token — 防止多线程覆盖"

场景: 两个 Java 线程同时 SIGSEGV→signal handler 并发→谁写 hs_err_pid.log？`VMError::_first_error_tid` 记录第一个 crash 线程→第二个线程检测到已有 token→放弃写→infinite sleep→等 die。

**report_and_die** (`vmError.cpp:700-900`):
```
VMError::report_and_die():
  → if _first_error_tid == 0 → set to current thread(atomic CAS)
  → if _first_error_tid != current thread:
      step(40) → output "[thread %d also had an error]"
      os::infinite_sleep()  // 等第一个线程写完后 die
  → step(10): os::print_os_info(st) → OS name/version/kernel
  → step(30): os::print_cpu_info(st, buf, buflen) → CPU model/flags/frequency
  → step(110): os::print_summary_info(st) → ulimit/dmesg/sysinfo
  → write to hs_err_pid<pid>.log
[C++: vmError.cpp:1901行——~30 steps——每个 step 是独立设施(OS/CPU/栈/寄存器)]
```
- 源码: `vmError.cpp:700-850` (report_and_die→first error token + steps 10-40)

- 关键设计: **`_first_error_tid` 用 atomic CAS 抢锁** — 第一个 crash 线程抢到→写完整 log；后续 crash 线程看到已有 token→输出一行→无限 sleep→等第一个线程 `os::die()`→OS kill all threads。**step numbering(10/20/...)** — 不是顺序 1→2→...——留有间隙便于插入新 step(20/70 是空白)。

### 2. "Native stack + register + memory"

场景: hs_err_pid.log `Native frames`→`[0x00007f1234005678] Java_java_lang_Thread_start+0x20`→ELF decoder: dladdr→.dynsym→function name+offset。Register dump→RAX/RBX/RCX/RIP(crash位置)/RSP(栈指针)。

**Stack + registers** (`vmError.cpp:900-1100`):
```
step(50): os::print_native_stack(st, context_frame, thread)
  → decoder::decode(pc, buf, bufsize, &offset)→dladdr→.dynsym→function name+offset

step(80): os::print_register_info(st, context)
  → RAX/RBX/RCX/RDX, RIP(crash位置), RSP(栈指针)
  → XMM0-XMM15(SSE registers)→crash 时浮点状态

step(100): os::print_siginfo(st, siginfo)
  → si_signo(SIGSEGV=11/SIGBUS=7), si_addr(fault address)→crash 的内存地址
[C++: vmError.cpp:900-1100——native stack 用 decoder_elf 解析——如果 stripped→only raw addresses]
```
- 源码: `vmError.cpp:900-1000` (step 50 native stack) + `vmError.cpp:1000-1100` (step 80→100 registers + siginfo)

- 关键设计: **siginfo 提供 crash 原因** — `si_code=SEGV_MAPERR`→访问未映射内存(null pointer)→developer 从 RIP 找到 crash 指令→从 RSP 找到调用栈→定位 source code。**decoder_elf 回退** — 如果 libjvm.so stripped→stack trace 只显示 raw addresses→developer 用 `addr2line -e libjvm.so 0x...` 手动解析。

---

### 核心悬念

**"vmError::report_and_die: first-error-token(atomic CAS)→~30 steps(OS→CPU→stack(ELF decoder)→registers→memory maps→dmesg)→hs_err_pid.log。Secondary crash→one line→infinite sleep→wait die。"** — 下一篇: ConcurrentHashTable + BitMap。

> → [02-concurrent-bitmap.md](02-concurrent-bitmap.md)
