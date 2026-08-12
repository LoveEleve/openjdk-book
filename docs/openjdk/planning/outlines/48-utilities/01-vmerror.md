# 01. vmError — hs_err_pid.log 生成引擎

> 🔴 Deep | 1901行的 crash handler
> 读者处境: JVM crash→SIGSEGV→JVM signal handler→`VMError::report_and_die()`(vmError.cpp:1272)→hs_err_pid_pid.log。这个文件包含: register dump, native stack trace, Java thread dump, VM version+flags, memory info, siginfo, code blob 反汇编。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/48-utilities/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **step 编号体系过时**: jdk11u 用 `STEP(s)` 宏(vmError.cpp:422-425),`_current_step = __LINE__`(行号即编号)——旧版 JDK 的 step(10/20/30/40/110)编号不存在
> - **report_and_die 在 1272 行**(非 700-900);report()(420)内才是 STEP 流水线;print_siginfo 在 os_posix.cpp:1315、print_context/print_register_info 在 os_linux_x86.cpp:747/810
> - **dladdr 不对**: Linux 用 `Decoder`(decoder.cpp:99)+ ELF 解码器(decoder_elf.cpp)自行解析符号表
> - **XMM0-XMM15 打印不存在**(jdk11u linux_x86 的 print_context 只打通用寄存器 + Top of Stack + Instructions)
> - "memory maps/dmesg" 泛化描述 → 实际是 print_memory_info(内存统计,os_linux.cpp:2670)

### 1. "Error reporting token — 防止多线程覆盖"

场景: 两个 Java 线程同时 SIGSEGV→signal handler 并发→谁写 hs_err_pid.log?`first_error_tid`(vmError.cpp:1208,volatile intptr_t,初值 -1)记录第一个 crash 线程→第二个线程检测到已有 token→输出一行→infinite sleep→等第一个线程 die。

**report_and_die**(`vmError.cpp:1272+`):
```
VMError::report_and_die():
  → if first_error_tid == -1 && Atomic::cmpxchg(mytid, &first_error_tid, -1) == -1:  // 1351-1352 CAS 抢令牌
      抢到 → 完整报告流程(Part1 stdout 摘要 1483-1495 + Part2 日志文件 1497-1524)
      抢不到 && first_error_tid != mytid:  // 1409-1420
        "[thread %d also had an error]" → os::infinite_sleep()
      同线程递归 > 30 次 → "[Too many errors, abort]" → os::die()  // 1423-1428
  → 日志文件名: prepare_log_file(ErrorFile, "hs_err_pid%p.log", ...)  // 1225/1508
  → 尾部 os::abort 失败后 os::die()  // 1634
[C++: vmError.cpp:1901行——STEP 宏流水线(vmError.cpp:422-425,编号=__LINE__)——~30+ 个报告 STEP]
```
- 源码: `vmError.cpp:1351-1352` (CAS 抢锁) + `1409-1420` (其他线程分支) + `420` (report)

- 关键设计: **`first_error_tid` 用 atomic CAS 抢锁** — 信号处理器里不能依赖任何锁(崩溃线程可能正持有锁→死锁);CAS 是最后的安全网。**STEP 编号 = `__LINE__`(代码行号)** — 报告本身可能再次崩溃,重入时 `[error occurred during error reporting (printing xxx, id 0x...)]`(1462)用 `_current_step_info` 精确定位崩溃的 step;配合超时:ErrorLogTimeout(默认 2×60s,globals.hpp:636)全局预算 + step 超时 max(5s, 全局 1/4)(1755-1756),WatcherThread 调 check_timeout()(1715)干预。

### 2. "Native stack + register + memory"

场景: hs_err_pid.log `Native frames`→`v ~StubRoutines::libmSin` 或 `[0x...] Java_java_lang_Thread_start+0x20`→Decoder(ELF 符号表)→function name+offset。Register dump→RAX/RBX/RCX/RIP(crash位置)/RSP(栈指针)。

**Stack + registers**(`vmError.cpp:234-280` + os_posix/os_linux_x86):
```
print_native_stack(st, fr, t, buf, bufsize) (vmError.cpp:234-280):
  → "Native frames: (J=compiled Java code, A=aot, j=interpreted, Vv=VM code, C=native code)" (238)
  → fr.print_on_error + Decoder::get_source_info (242/246)
  → JavaThread: RegisterMap + fr.sender (259-261); C 帧: os::get_sender_for_C_frame (265-266)
  → Decoder(decoder.cpp:99)——ELF 解码器(decoder_elf.cpp),非 dladdr;错误处理线程安全模式(decoder.cpp:100)

STEP("printing siginfo") (744) → os::print_siginfo (os_posix.cpp:1315):
  → si_signo(SIGSEGV=11) + si_code(SEGV_MAPERR=1) + si_addr(同步错误信号,1361-1363)
STEP("printing register info") (761) → os::print_register_info (os_linux_x86.cpp:810):
  → "Register to memory mapping"——寄存器值→print_location(指向哪)
STEP("printing registers...") (769) → os::print_context (os_linux_x86.cpp:747):
  → RAX-R15/RIP/RSP/EFLAGS + Top of Stack hex (797) + Instructions (804)
STEP("printing code blob if possible") (795) → StubCodeDesc::desc_for + Disassembler::decode (808-811)
[C++: 崩溃现场部分 = report() 的 744-819; 内存统计 print_memory_info (os_linux.cpp:2670)]
```
- 源码: `vmError.cpp:234-280` (native stack) + `744-819` (siginfo/寄存器/code blob)

- 关键设计: **siginfo 提供 crash 原因** — `si_code=SEGV_MAPERR`→访问未映射内存(null pointer)→developer 从 RIP 找到 crash 指令→从 RSP 找到调用栈→定位 source code。**Decoder 安全模式** — 错误处理线程才做完整符号解析(decoder.cpp:100);libjvm.so 被 strip→裸地址→`addr2line -e libjvm.so 0x...` 手动解析。**code blob 现场** — 崩在 stub 里打印 StubCodeDesc 名字+反汇编(45 域 02 的伏笔兑现)。

---

### 核心悬念

**"vmError::report_and_die: first-error-token(atomic CAS)→STEP 流水线(编号=__LINE__)→native stack(Decoder ELF)→registers→memory info→code blob 反汇编→hs_err_pid_pid.log。Secondary crash→one line→infinite sleep→wait die。"** — 下一篇: ConcurrentHashTable + BitMap。

> → [02-concurrent-bitmap.md](02-concurrent-bitmap.md)
