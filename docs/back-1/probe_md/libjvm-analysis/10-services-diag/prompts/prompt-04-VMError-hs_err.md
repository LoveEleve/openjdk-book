# PROMPT: 请撰写 04-VMError-hs_err.md

## 〇、背景与使用场景

### 你在生产环境中每天都在经历的

线上应用突然宕机了。你登录服务器，在 `/data/logs/` 下看到了这个文件：
```bash
$ ls -lh hs_err_pid12463.log
-rw-r--r-- 1 app app 187K Jun 4 15:42 hs_err_pid12463.log
```
打开文件第一行：
```
#
# A fatal error has been detected by the Java Runtime Environment:
#
#  SIGSEGV (0xb) at pc=0x00007f8b1a3c4d21, pid=12463, tid=12494
#
# JRE version: OpenJDK Runtime Environment (11.0.22+9) (build 11.0.22+9-LTS)
# Java VM: OpenJDK 64-Bit Server VM (11.0.22+9-LTS, mixed mode, sharing, tiered, compressed oops, g1 gc, linux-amd64)
# Problematic frame:
# V  [libjvm.so+0x8c4d21]  G1ParScanThreadState::copy_to_survivor(InCSetState, oopDesc*, markOopDesc*)+0x61
```
→ JVM 内部发生了什么？JVM 在 G1 young GC 的并行拷贝阶段，某个 GC 线程访问了一个无效的对象指针（可能是已经被回收的对象引用未清除）→ CPU MMU 触发 page fault → 内核发送 SIGSEGV (signal 11) 给 JVM → JVM 的 `JVM_handle_linux_signal()` 信号处理器捕获 → 判断不是 implicit null check（sp != 页大小范围外的零页）→ 调用 `VMError::report_and_die()` → 开始生成 hs_err 报告。整个生成过程在**信号上下文中**执行——这意味着不能用 malloc（不是 AS-safe）、不能持有锁、不能用 `fprintf`（内部需要 FILE* 锁）。所有输出通过 `::write(fd, buf, len)` 直接系统调用来写——这就是你看到的文本内容。

往下翻到 `Current thread` 段：
```
---------------  T H R E A D  ---------------

Current thread (0x00007f8b24083800):  GCTaskThread "G1 Young RemSet Sampling" [stack: 0x00007f8b1ebfb000,0x00007f8b1ecfe000] [id=12494]

Stack: [0x00007f8b1ebfb000,0x00007f8b1ecfe000],  sp=0x00007f8b1ecfcb80,  free space=1030k
Native frames: (J=compiled Java code, A=aot compiled Java code, j=interpreted, Vv=VM code, C=native code)
V  [libjvm.so+0x8c4d21]  G1ParScanThreadState::copy_to_survivor(InCSetState, oopDesc*, markOopDesc*)+0x61
V  [libjvm.so+0x8c5a8b]  G1ScanEvacuatedObjClosure::do_oop_work<unsigned long>(unsigned long*)+0x15b
V  [libjvm.so+0xb8d0f5]  G1OopClosures::_static_G1ParCopyClosure<G1BarrierNone, false>::do_oop(oopDesc**)+0x75
V  [libjvm.so+0x107cd41] oopDesc::oop_iterate(OopIterateClosure*)+0x41
V  [libjvm.so+0x8c57e1]  G1ScanEvacuatedObjClosure::do_object_b(unsigned char*)+0x141
...
```
→ JVM 内部发生了什么？崩溃线程 `tid=12494` 就是第一行提到的 `tid=12494`。`Native frames` 告诉你这个线程在 C++ 层的调用栈——从 `G1ParScanThreadState::copy_to_survivor` 往上回溯到对象拷贝、引用扫描的完整路径。如果你编译了 debuginfo 包，可以用 `addr2line -e /usr/lib/jvm/java-11-openjdk/lib/server/libjvm.so 0x8c4d21` 得到精确的源文件行号（或者用 `gdb` 的 `info line *0x8c4d21`）。如果只有 `+0x61` 偏移但没有符号化信息——说明 JVM 没有安装 debuginfo 包，hs_err 只有偏移量。

继续往下，`Java frames` 段：
```
Java frames: (J=compiled Java code, j=interpreted, Vv=VM code)
J 4582  com.example.service.OrderService.processBatch(Ljava/util/List;)V (137 bytes) @ 0x00007f8b15c4d8a2 [0x00007f8b15c4d2c0+0x5e2]
j  com.example.controller.MainController.handle(Ljavax/servlet/http/HttpServletRequest;Ljavax/servlet/http/HttpServletResponse;)V+85
...
```
→ JVM 内部发生了什么？虽然崩溃发生在 GC 线程中（不是 Java 应用线程），但 hs_err 仍然输出所有 Java 线程的栈帧。`print_stack_trace()` 在信号上下文中不走 safepoint——直接从 `StackFrameStream` 读取，不需要线程合作。`J 4582` 表示这是 JIT 编译的代码（地址 `0x00007f8b15c4d2c0`），`137 bytes` 是方法字节码大小。虽然崩溃线程是 GC 线程（不执行 Java 代码），但 `Java frames` 可以帮助你定位——GC 发生时哪个 Java 线程在运行什么方法，是否和崩溃有关。

再往下，`Process` 和 `System` 段：
```
---------------  P R O C E S S  ---------------

Threads class SMR info:
_java_thread_list=0x00007f8b240d8000, length=281, elements={
0x00007f8b24083800, 0x00007f8b24084000, 0x00007f8b24084800, ...
}

---------------  S Y S T E M  ---------------

OS: Red Hat Enterprise Linux 8.8 (Ootpa)
uname: Linux 4.18.0-477.27.1.el8_8.x86_64 #1 SMP ...
libc: glibc 2.28
rlimit: STACK 8192k, CORE 0k, NPROC infinity, NOFILE 65536, AS infinity, ...
load average: 2.47 3.12 2.89
cpu: 16 cores, sockets: 2, cores per socket: 8, threads per core: 1, family 6 model 85 stepping 4, cmov, cx8, fxsr, mmx, sse, sse2, sse3, ssse3, sse4.1, sse4.2, popcnt, avx, avx2, aes, clmul, tsc, tscinvbit, tscinv, bmi1, bmi2, adx
Memory: 4k page, physical 32768000k(3281832k free), swap 0k(0k free)
vm_info: OpenJDK 64-Bit Server VM (11.0.22+9-LTS) for linux-amd64 JRE (1.8.0_202-b08), built on ...
```
→ JVM 内部发生了什么？`Process` 段的 `_java_thread_list` 直接从 `ThreadsSMR` 的 `_java_thread_list` 读取——列出所有 JavaThread 对象指针。`System` 段的 `Memory` 数据来自 `os::Linux::print_memory_info()` → 读取 `/proc/meminfo` 并格式化输出。`rlimit` 来自 `getrlimit()` 系统调用。`cpu` 信息来自 `/proc/cpuinfo` 解析。**这些都是自动采集的——不需要你在线上手动 `cat /proc/meminfo`**。hs_err 已经帮你收集了崩溃时刻的内存、CPU、系统限制信息。

### 线上事故分析第一步——你怎么读 hs_err

1. **看第一行**：`SIGSEGV` 还是 `SIGBUS`？`si_addr` 是多少？
   - `si_addr=0x0000000000000000` → 十有八九是 NPE（NullPointerException）。空指针解引用 access 零页 → SIGSEGV。这里可能是 JVM 的 implicit null check（在 `0x00` 读取标记位）故意造成，不是真正的 bug。
   - `si_addr=0x00007f8b1a3c4d21`（非零地址）→ 访问了无效的内存地址。这个地址如果落在 `[heap]` 范围 → 堆损坏。如果落在 `[stack]` 范围 → 栈溢出。如果落在 `libjvm.so` 的 mmap 范围 → JVM 自身的内存访问错误（c++ use-after-free 或 wild pointer）。
   - `SIGBUS` + `si_addr` 指向 DirectByteBuffer 的映射区域 → DirectByteBuffer 的底层文件被截断，mmap 访问超出文件大小的页。
2. **看 `Problematic frame`**：`V [libjvm.so+0x8c4d21]` 还是 `C [libfoo.so+0x1234]`？
   - `V` → 崩溃在 JVM 自身代码中 → 可能是 JVM bug，或你的 JNI 代码向 JVM 传了非法参数。
   - `C` → 崩溃在 Native 代码中（JNI 库、系统库）→ 你的 JNI 代码有 bug（use-after-free、buffer overflow 损坏了相邻内存）。
   - `J` → 崩溃在 JIT 编译的 Java 代码中 → 可能是 JIT 编译器生成了错误代码（JDK 的 JIT bug），或你的 Java 代码触发了 Unsafe 操作。
3. **看 `Current thread` 的线程类型**：是 `GCTaskThread`（GC 线程）、`JavaThread`（应用线程）、`VMThread`（JVM 系统线程）、`Attach Listener`（诊断线程）？这决定了后续分析方向——GC 线程崩溃 → 排查 G1 堆状态和 GC 配置；JavaThread 崩溃 → 排查 JIT 编译或 JNI 调用；VMThread 崩溃 → 排查 safepoint 协调逻辑。

### 常见的信号分类——你知道每一种表示什么吗？

| 信号 | 典型原因 | 排查方向 |
|------|----------|----------|
| **SIGSEGV (11)** | NPE（零页访问）、栈溢出（访问 guard page）、implicit null check（JVM 故意）、native 代码访问非法地址 | 看 `si_addr`——是零页吗？是栈边界吗？是对象地址吗？ |
| **SIGBUS (7)** | DirectByteBuffer 映射的文件被截断、Unsafe.putX 向已释放的 DirectByteBuffer 写入、mmap 文件超过实际大小 | 检查是否有代码在 DirectByteBuffer 分配后删除了底层文件；Unsafe.freeMemory() 之后又访问 |
| **SIGSEGV in CompilerThread** | JIT 编译器在编译时访问了非法 IR node | 和普通 SIGSEGV 不同——这是 JVM 编译器的 bug（通常在 JDK 升级后出现）。排查：回退 `-XX:-UseAVX` 或 `-XX:CompileCommand=exclude` |
| **SIGILL (4)** | JIT 生成了非法指令（如 AVX512 指令在不支持的 CPU 上执行） | 检查 CPU flags 和 JIT 使用的 SIMD 扩展是否匹配 (avx/avx2/avx512) |
| **SIGFPE (8)** | 除零——但 Java 层面除零抛 `ArithmeticException`，只有 JIT 绕过了 Java 除零保护才会到 SIGFPE | JIT 对整数除法做了 unsafe 优化（跳过除零检查）→ JIT bug |
| **SIGABRT (6)** | `guarantee()/assert()` 失败 → JVM 调用 `os::abort()` | 看 hs_err 中的 `# Internal Error` 段 → assert 的文件名:行号 |

### hs_err 常见分析误区

- **混淆 SIGSEGV 的来源**：看到 `SIGSEGV` 就下结论"JVM 有 bug"——但绝大部分生产环境的 SIGSEGV 来自 a) 应用程序的 JNI 库（自己写的 C/C++ 代码 use-after-free / wild pointer）；b) Unsafe 误用（在对象被 GC 回收后仍通过 Unsafe 访问其地址）；c) 第三方 native 库（如 tcnative/netty-transport 的不兼容版本）。真正的 JVM bug 导致的 SIGSEGV 相对少见——通常伴随特定的 JDK 版本和 JIT 编译参数。
- **忽视 hs_err 的 Dynamic libraries 段**：文件末尾的 `Dynamic libraries:` 列出了加载的所有 `.so` 文件——如果看到 `libfoo.so` 的版本和预期不一致（比如预期 2.1 但加载了 3.0），原生的库的 ABI 不兼容可能就是崩溃根源。
- **关闭 core dump 导致丢失现场**：`rlimit: CORE 0k` 说明 `ulimit -c 0`——崩溃后不生成 core dump。这意味着你只有 hs_err，不能用 `gdb core-file` 回溯完整的寄存器/内存/线程状态。生产环境建议 `ulimit -c unlimited`（或至少 2GB），否则丢失大量现场信息。
- **hs_err 报告缺失最后几行**：JVM 崩溃时可能恰好在 `write()` 中间——最后几条日志行可能在 `static buffer[O_BUFLEN]` 中但未 flush 到 fd。这是因为 `fdStream::write()` 虽然直接 `::write()`，但如果 JVM 在 `write()` 调用**之前**的格式化阶段崩溃（如 `sprintf` 到 `buffer` 过程中触发信号），这些数据永远不会写入文件。你在文件末尾看到不完整的行——就是这个原因。

### 相关生态工具（本文分析的源码的"表兄弟"）

- **async-profiler `status`**：如果 JVM 在 async-profiler 采样期间崩溃，`profiler.sh status` 会报告 profiler 状态——`perf_event_open()` 的 fd 可能仍然存在，采样数据在循环缓冲区中但未回吐。hs_err 的 `Threads class SMR info` 段可能列出 async-profiler 的 `PerfEventThread`——帮助你确认崩溃时 profiler 是否在运行（没有 profiler 地址无关的副作用影响 GC）。
- **Arthas `thread -n 3`**（崩溃后执行）：JVM 崩溃后 arthas 的 `attach` 会失败——`/tmp/.java_pid<PID>` 套接字文件可能随进程退出被删除（`listener_cleanup()` 的 `unlink()`）。这时你需要回到 hs_err 的 `Threads` 段查看线程信息——hs_err 是 JVM 崩溃后的唯一消息源。
- **gdb + core dump**：hs_err 的 `Native frames` 只有函数名 + 偏移量（如果没有 debuginfo 则只有偏移量）。真正的寄存器值、线程执行到哪条指令、内存内容是 core dump + gdb 的专属。hs_err 和 core dump 互补——hs_err 给人看（格式化的文本），core dump 给分析工具看（二进制状态）。
- **strace -p**（崩溃前）：如果有周期的 SIGSEGV 问题，可以在问题 JVM 上 `strace -p <PID> -o /tmp/strace.log`——在崩溃时刻，`strace` 会记录最后一条系统调用（通常是 `write()` 或 `futex()`）。配合 hs_err 的 `vm_info` 段，可以看到崩溃时的确切换过到内核还是在内核等待。

### 背景概念速览

- **信号安全（Async-Signal-Safe / AS-safe）**：POSIX 定义的一组可以在信号处理器中安全调用的系统调用（`write`/`read`/`open`/`close`/`time`/`getpid`/`_exit` 等）。**不能用的**包括 `malloc`（需要 arena 锁）、`fprintf`（FILE* 需要 `_IO_lock`）、`fork`（在信号处理器中 fork → 子进程可能死锁）。`VMError::report_and_die()` 的所有数据输出必须只用 AS-safe 函数——这就是为什么 hs_err 不用 `fprintf`、不用 `malloc`、不用 `fileStream`。
- **`write()` vs `fprintf()`**：`write()` 是系统调用（直接进内核）——不需要任何用户态锁。`fprintf()` 操作的是 `FILE*` 结构（用户态缓冲），内部有 `flockfile`/`_IO_lock` 锁——如果信号处理器打断了正在持有同一个锁的正常代码路径 → 死锁。
- **`/proc/self/maps`**：hs_err 的 `Memory map` 段的数据源——通过 `read()` 读取 `/proc/self/maps`（AS-safe）获得虚拟地址空间布局。每行 `<start>-<end> <perms> <offset> <dev> <inode> <path>` 展示一个内存映射区域——帮助你确定崩溃地址 `si_addr` 落在哪个区域（堆/栈/代码段/libjvm.so 的哪个段）。
- **Decoder（native 帧符号化）**：`Decoder::get_source_info(pc, buf, buflen, &line)` 在崩溃时对 native 帧做符号化——把 PC 地址变成 "函数名 + 源文件:行号"。默认的 stub 返回 false（没有符号化能力），需要 `libdecoder_<platform>.so` 或抽象类的子类提供真正的 DWARF/ELF 解析。在信号上下文中不能用 `fork+exec` 调用 `addr2line`（fork 在信号上下文中不安全）——所以 Decoder 必须在进程内完成符号化。
- **strace 排查**：`strace -f -p <PID>` 能追踪 JVM 崩溃前的最后系统调用序列——如果你怀疑 hs_err 中的 SIGSEGV 来自某次特定的 syscall 返回错误 → strace 是直接的验证工具。

## 一、任务 + 核心故事线（禁止做源码翻译机！）

读者学完了 [08-safepoint]——理解了 `SafepointSynchronize::begin()` 中，VMThread 用 `arm_safepoint_poll()`（信号机制）协调所有线程到达安全点，信号处理器的约束是"最短路径"——改状态、返回。读者学完了 [10-01]——知道了 `AttachListener` 怎么作为外部接口工作。读者学完了 [07-thread]——知道 `JavaThread::print_on_error()` 和正常的 `ThreadService::dump_all_threads()` 有什么本质不同。

现在该最极端的情况了：**JVM 崩溃了——SIGSEGV、assert 失败、unreachable 到达——`VMError::report_and_die()` 怎么在信号上下文中安全地输出 2000 行 hs_err_pid\<pid\>.log？** 2000 行文本格式化、线程栈遍历、native 栈符号化——而这些操作在信号上下文中面对"不能持有锁、不能 malloc、不能执行非 AS-safe 函数"的严苛约束。

**本文不是信号处理教程**——不需要解释 `sigaction()` vs `signal()` 的区别。**本文不是 gdb/addr2line 使用手册**——不展开 ELF/DWARF 格式。**本文也不是 Linux 内核 crash dump 指南**——不讨论 core_pattern。本文的唯一目标：**追踪 `report_and_die()` 从 `first_error_tid` 的原子 cmpxchg 开始、到 `os::abort()` 结束的完整崩溃报告生成流程**。关键是：为什么只能用 `fdStream.write()` 而不是 `fprintf`？`_steps[]` 分步机制怎么保证"至少输出一部分"？如果崩溃报告自身也崩溃了（递归 `report_and_die`）——怎么检测并防止无限循环？

### 核心叙事线——"信号安全的极限"

[08-safepoint] 的 safepoint begin() 中，信号处理器约束是"最短路径"——改状态、返回。VMError 的 `report_and_die()` 在同一套信号约束下做"最长的安全路径"——输出完整崩溃报告、打印所有线程栈、调用 Decoder 符号化 native 帧。08 和 10 是"信号安全"这一思想的两极：**最短路径 vs 最长安全路径**。

### 验证报告
- `sverklo_investigate(VMError report_and_die _steps ErrorLog write())` → 发现：8 个 overload → 1 个 master 实现，BEGIN/STEP/END 宏分步，`fdStream` unbuffered 输出
- `codegraph query "VMError::report_and_die"` → vmError.cpp:1307（master）
- `grep -n "fdStream\|fd_out\|fd_log" vmError.cpp` → 行 1333/1337，方两个独立的 fdStream（一路 stdout 一路 hs_err 文件）
- `grep -n "print_stack_trace\|print_native_stack" vmError.cpp` → 行 195/231
- `grep -n "recursive_error_count\|first_error_tid" vmError.cpp` → 行 1341/1350，防止并发 + 防止无限递归
- `grep -n "::write" vmError.cpp` → 确认输出只用 `::write()` 而非 `fprintf`

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 路径 | 模块 | 核心函数/类（行号） | 本文角色 |
|---|------|------|------|-------------------|---------|
| 1 | `vmError.cpp` | `src/hotspot/share/utilities/vmError.cpp` | utilities | `VMError::report_and_die()`(:1307 master), `report()`(:417), `print_stack_trace()`(:195), `print_native_stack()`(:231), `check_timeout()`(:1697) | ★★★ 核心——崩溃报告的完整实现 |
| 2 | `vmError.hpp` | `src/hotspot/share/utilities/vmError.hpp` | utilities | `VMError` 类(:34), 8 个 report_and_die 重载声明(:125-170), `_current_step`/`_current_step_info`(:63-64) | ★★ 接口——多场景入口 + 分步状态 |
| 3 | `debug.cpp` | `src/hotspot/share/utilities/debug.cpp` | utilities | `report_vm_error()`(:237), `report_fatal()`(:259), `report_should_not_reach_here()`(:292) | ★★ 入口——assert/guarantee → VMError |
| 4 | `debug.hpp` | `src/hotspot/share/utilities/debug.hpp` | utilities | `vmassert`(:54-64), `guarantee`(:100-107), `fatal`(:109-114), `ShouldNotReachHere`(:130-135) | ★★ 触发——代码中触发崩溃的宏 |
| 5 | `decoder.cpp/.hpp` | `src/hotspot/share/utilities/decoder.{cpp,hpp}` | utilities | `Decoder::get_source_info()`(:cpp:135), `AbstractDecoder`(:hpp:34) | ★ 符号化——native 栈解码 |
| 6 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | runtime | `Threads::print_on_error()`(:5064), `JavaThread::print_on_error()`(:3231) | ★★ 线程——所有线程栈的崩溃打印 |
| 7 | `os.cpp` | `src/hotspot/share/runtime/os.cpp` | runtime | `os::print_location()`(:1086) | ★ 地址解析——pc→库名+符号 |
| 8 | `ostream.hpp` | `src/hotspot/share/utilities/ostream.hpp` | utilities | `fdStream`(:250-263) — unbuffered I/O, directly calls `::write()` | ★★ 输出——信号安全的 fdStream |

**跨模块说明**：VMError 在 `utilities/` 中——但它依赖 `runtime/`（thread.cpp 的 `print_on_error()`）、`os/`（`print_location()`）、甚至 `services/` 的 `AttachListener::is_initialized()`（状态查询——虽然当前源码中未实际引用，但设计预期如此）。这是 10-services-diag 阶段最意外的跨模块依赖。

**补充说明**：当前源码中，`vmError.cpp` 没有直接引用 `AttachListener`。README §一 和 §七 中描述的"VMError::report 检查 AttachListener 状态"是设计预期——如果 hs_err 输出不包含 attach 状态，那也是值得记录的发现。

## 四、必须深度走读的核心概念

> 每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ 为什么 hs_err 必须用 `write()`？信号安全约束的全景

```
问题：
  ① fprintf/stderr 和 write() 的本质区别是什么？
     线索: ostream.hpp:250-263 (fdStream 定义), vmError.cpp:1333-1338 (fdStream 使用)
     代码引证:
       class fdStream : public outputStream {
         int _fd;
         virtual void write(const char* c, size_t len) {
           ::write(_fd, c, len);  // 直接系统调用——无缓冲、无锁
         }
       };
     答案方向: fprintf → 内部 FILE* 结构体需要锁（`flockfile` / `_IO_lock`）+
     内部 malloc（缓冲区扩展）→ 信号上下文中如果已经持有锁 → 死锁。write() → 直接
     syscall → 不需要任何用户态锁。fdStream 不缓冲——每次 write() 输出原始字节。

  ② 那怎么做到格式化输出？（不使用 fprintf）
     答案方向: VMError 使用带 `set_scratch_buffer()` 的 fdStream——先将格式化字符串
     写入栈上的 `static char buffer[O_BUFLEN]` → 再 `::write(fd, buffer, len)` 整块输出。
     VSprintf 在栈上格式化——不需要动态分配。这需要谨慎管理栈深度。

  ③ `fdStream` 为什么用 `static` 局部变量而不是全局实例？
     线索: vmError.cpp:1333-1337, 注释提到 JDK-8214975
     答案方向: 全局实例的初始化依赖动态初始化——可能在信号上下文中未完成。
     局部 `fdStream out(fd_out)` 是 trivially constructible——只是存 fd。
     避免 ctor 调用 malloc 或任何非 AS-safe 操作。
```

### 4.2 ★★★ `report_and_die()` 的主入口——8 重载 → 1 master 实现

```
问题：
  ① 8 个 overload 分别覆盖什么场景？
     线索: vmError.hpp:125-170, vmError.cpp:1269-1312
     答案方向:
     (1) signal crash: report_and_die(thread, sig, pc, siginfo, context, ...) → SIGSEGV 等
     (2) assert/guarantee 失败: report_and_die(filename, lineno, message, ...) → INTERNAL_ERROR
     (3) fatal: report_and_die(error_type, message, detail_fmt, ...) → OOM_MALLOC_ERROR 等
     (4) OOM: report_and_die(message) → OOM_MALLOC_ERROR 或 OOM_MMAP_ERROR
     所有重载最终收敛到 master 重载（:1307）——传入完整参数集合。

  ② 不同场景触发的 master report_and_die 有行为差异吗？
     答案方向: 核心逻辑一致。但 OOM 场景省略堆 dump（可能再次 OOM）；
     信号场景触发原因由 siginfo 提供（`os::exception_name(_id, buf)` 行 533）；
     assert 场景有 filename + lineno（行 547-554——PRODUCT 模式截断路径）。

  ③ first_error_tid 的 Atomic::cmpxchg 防止了什么？
     线索: vmError.cpp:1350-1351
     代码引证:
       if (first_error_tid == -1 &&
           Atomic::cmpxchg(mytid, &first_error_tid, (intptr_t)-1) == -1) {
     答案方向: 多线程同时触发 fatal error——只有一个线程拿到"报告权限"。其他线程
     进入 waiting 循环（后续代码中 `os::infinite_sleep()` 或 wait）。防止并发输出
     混淆 hs_err 文件。
```

### 4.3 ★★★ STEP/BEGIN/END 宏——_current_step 分步机制的真相

```
问题：
  ① "分步"的实际实现是什么？有没有 _steps[] 数组？
     线索: vmError.cpp:417-422
     代码引证:
       # define BEGIN if (_current_step == 0) { _current_step = __LINE__;
       # define STEP(s) } if (_current_step < __LINE__) { _current_step = __LINE__; \
         _current_step_info = s; record_step_start_time(); _step_did_timeout = false;
       # define END }
     答案方向: **没有 _steps[] 数组**。STEP 宏用 `__LINE__` 作为步标识——不是 enum 常量。
     首进入时 `_current_step == 0` → 所有 STEP 都被执行。递归进入时 `_current_step == 上次
     崩溃的行号` → 小于 `_current_step` 的 STEP 被跳过 → "崩溃发生在 step X 时"。
     这是一个巧妙的设计——步骤名是字符串 `_current_step_info`，步号是 `__LINE__`。

  ② 如果崩溃报告的某一步触发 SIGSEGV（如栈损坏导致 print_stack_trace 访问非法地址），
     递归 `report_and_die()` 怎么检测并防止无限循环？
     线索: vmError.cpp:1341 (recursive_error_count), :1350 (first_error_tid)
     答案方向: (1) first_error_tid 的 cmpxchg 只让一个线程进入；
     (2) recursive_error_count 计数递归次数——最多允许一定深度；
     (3) _current_step 跳过已执行的步——第二步只输出 "Error occurred during ..."；
     (4) 如果递归超过一定深度 → 放弃输出 → 直接 abort。
     代码在递归进入时检查 `recursive_error_count > 30` 或类似限制。

  ③ check_timeout() 的超时检测用什么时钟？
     线索: vmError.cpp:1697-1738
     代码引证:
       const jlong now = get_current_timestamp();
       if (reporting_start_time_l > 0) {
         const jlong end = reporting_start_time_l + (jlong)ErrorLogTimeout * TIMESTAMP_TO_SECONDS_FACTOR;
         if (end <= now) { ... }
       }
     答案方向: `ErrorLogTimeout` 默认 2 分钟——如果某步执行时间超过这个值 → 超时跳过。
     超时有全局（整个 report 超时）和局部（单步超时 = ErrorLogTimeout / 4）两种。
     `os::elapsedTime()` 或 `os::javaTimeNanos()` 用于计时——通常是 `clock_gettime()`
     （syscall 安全的）或 TSC。READ  §八 的问题：TSC 在 SMP 下跨 NUMA 是否有偏移？
     → 时钟选择影响超时精度。如果是 TSC 且跨 NUMA → 可能有微秒级偏差 → 不影响安全。
```

### 4.4 ★★★ `report()` 内部的内容生成顺序——信号约束下的"最小可行输出"

```
问题：
  ① hs_err 文件的内容顺序为什么是这个？
     线索: vmError.cpp:417 → report() 按固定顺序输出：
     1. printing fatal error message (行 429) — 基本信息
     2. printing type of error (行 491) — signal/OOM/Internal
     3. printing exception/signal name (行 528) — 信号名称
     4. printing current thread and pid (行 561)
     5. printing error message (行 568)
     6. printing Java version string (行 579)
     7. printing problematic frame (行 583) — 崩溃帧
     8. printing core file information (行 595)
     9. ... 更多 STEP

  ② 和 ThreadService::dump_all_threads() 的线程栈有什么不同？
     线索: vmError.cpp:195 (print_stack_trace) vs ThreadService 的正常 dump
     答案方向: hs_err 的线程栈打印在信号上下文中——不走 safepoint。它直接遍历
     `ThreadsListSMR`（`ALL_JAVA_THREADS(thread)` 宏——thread.cpp:5064），从栈帧中
     读取数据——不需要线程合作。精度可能低但不需要 STW。正常的 ThreadService::dump
     需要 safepoint（一致性要求）→ 精度更高但需要所有线程暂停。

  ③ native stack（print_native_stack）和 Java stack 的打印顺序？
     线索: vmError.cpp:231 (print_native_stack)
     答案方向: 先 Java frames（`StackFrameStream` → `sfs.current()->print_on_error`）
     后 native frames（`os::get_sender_for_C_frame()` 遍历 → Decoder::get_source_info）。
     如果 frame pointer 被 `-fomit-frame-pointer` 优化掉（x86 上 rbp 重用为 GP 寄存器）,
     native 栈解码可能失败——只有栈顶一帧。输出时 `st->print("Native frames: ...")` 标记。
```

### 4.5 ★★★ print_native_stack() 与 Decoder 的协作——信号上下文的符号化

```
问题：
  ① Decoder 是什么？为什么不在 hs_err 里用 addr2line？
     线索: decoder.cpp:135 (get_source_info stub), decoder.hpp:102-137
     代码引证:
       bool Decoder::get_source_info(address pc, char* buf, size_t buflen, int* line) {
         return false; // 默认实现——Linux 上需要子类提供
       }
     答案方向: Decoder 是进程内 C++ 栈符号化器——通过解析 ELF/DWARF 或 dladdr() 
     在进程崩溃时把 PC 地址变成 "函数名 + 文件:行号"。不能用 addr2line（外部进程）因为：
     (1) 信号上下文不能 fork/exec——fork 在信号上下文中可能导致死锁（其他线程持有锁）；
     (2) ASLR 下需要进程内地址映射——外部工具不知道实际加载地址。
     默认的 `get_source_info()` 返回 false（stub）——真正的实现需要 `libdecoder` 或
     平台特定的 `AbstractDecoder` 子类。

  ② 如果 frame pointer 被 `-fomit-frame-pointer` 优化掉，怎么继续解 native 栈？
     线索: print_native_stack() 使用 `os::get_sender_for_C_frame()`
     答案方向: 如果 rbp 被重用为 GP 寄存器 → frame pointer 链断裂 → 
     `os::get_sender_for_C_frame()` 只能解一帧（当前的）。后续帧返回 NULL →
     `print_native_stack()` 输出 "..." 标记失败。
     在现代编译器中（-fomit-frame-pointer 默认），精确 native 栈解码需要 DWARF
     展开表——由 Decoder 提供。如果 Decoder 不可用 → 只能输出一帧或垃圾帧。
     README §八 的问题：解码会默默失败还是输出错误信息？
     → `st->print("(%s:%d)", buf, line_no)` 只在 `Decoder::get_source_info()` 返回 true 时输出，
     如果返回 false → 只是没有源文件信息而已，帧本身仍然输出。
```

### 4.6 ★★ 和 [08-safepoint] + [10-01] + [07-thread] 的连接

```
问题：
  ① 和 [08-safepoint] 的"最短路径 vs 最长安全路径"对偶
     答案方向: [08] 的 safepoint begin() 中，信号处理器只改 1 个状态（_thread_state）
     然后返回——这是"信号安全的最短路径"。VMError 的 report_and_die() 在同一个约束下
     输出 2000 行文本、遍历所有线程栈（200+ stack frames）、调用 Decoder 符号化——
     这是"信号安全的最长路径"。两者展示了一对极端——同一个约束，最短和最长的实现。

  ② 和 [10-01] AttachListener 的连接——崩溃时检查 attach 管道状态
     答案方向: 设计预期——VMError::report() 的 VM state 部分检查 `AttachListener::is_initialized()`
     是否 active、socket 文件是否存活。这帮助诊断"为什么 jcmd 连不上"——可能因为崩溃
     遗留了中断状态。当前源码中是否有这个检查需要在写作时验证——如果没有，也是值得记录的发现。

  ③ 和 [07-thread] 的连接——Threads::print_on_error() 的特殊性
     答案方向: [07] 的 JavaThread::print_on_error() (thread.cpp:3231-3252) 比正常
     ThreadService::dump_all_threads() 更原始——直接从栈帧读取数据，不经过 safepoint。
     这在崩溃场景中是必需的——线程已经冻结在信号上下文中，不可能做 STW。
```

### 4.7 ★★ `should_report_bug()` 和多场景分类

```
问题：
  ① 哪些 _id 值需要 "report bug"（输出详细信息），哪些不需要？
     答案方向: OOM 相关的 id（OOM_MALLOC_ERROR, OOM_MMAP_ERROR）→ `should_report_bug() == false`
     → 只输出简要信息 → 因为 OOM 是"可预期"的——不是 JVM bug。INTERNAL_ERROR（assert/guarantee
     失败）和信号崩溃 → `should_report_bug() == true` → 输出完整信息 + 建议提交 bug 报告。

  ② `_verbose` 参数什么时候为 false？
     答案方向: report() 被调用两次（master report_and_die 中）——第一次 `_verbose = false` 输出到
     stdout（fd_out=1，行 1319），第二次 `_verbose = true` 输出到 hs_err 文件（fd_log）。
     stdout 只打印简要错误——"A fatal error has been detected..."；hs_err 包含所有细节。
```

## 五、文章结构

```
§〇 源文件清单（跨 utilities + runtime + os，标注每个文件的模块归属和在崩溃报告中的角色）

§一 ★★★ 为什么 hs_err 必须用 write()？信号安全全景
  ❓ fprintf 和 write() 的本质区别——锁、malloc、AS-safe
  ❓ fdStream 的设计——unbuffered、直接系统调用、局部变量
  1.1 AS-safe 函数清单——什么可以做、什么不可以
  1.2 fdStream vs fileStream vs stringStream——三种输出流的信号安全性对比
  1.3 static buffer[O_BUFLEN] 的栈分配 vs 动态分配

§二 ★★★ report_and_die() 的主入口——8 重载 → 1 master 实现
  ❓ 8 个重载分别覆盖什么场景？（signal / assert / fatal / OOM）
  ❓ first_error_tid 的 cmpxchg 怎么防止并发崩溃？
  2.1 多线程同时触发 fatal error 的竞态处理
  2.2 8 个 overload 的参数流——各层的默认值
  2.3 从 debug.cpp 到 vmError.cpp 的完整调用链

§三 ★★★ STEP/BEGIN/END 宏——_current_step 分步机制
  ❓ "分步"怎么实现的？_steps[] 数组在哪？（原来没有——是宏 + __LINE__）
  ❓ 递归崩溃怎么检测并防止无限循环？
  3.1 STEP 宏的实现——__LINE__ 作为步号
  3.2 recursive_error_count 的防无限循环
  3.3 check_timeout() 的超时机制（全局 vs 步骤级）
  3.4 ★ 如果崩溃报告自身崩溃——第二次进入怎么跳过已执行的步

§四 ★★★ report() 的内容生成顺序
  ❓ 线程栈打印为什么不走 safepoint？
  ❓ native 栈怎么符号化？如果 frame pointer 被优化掉会怎样？
  4.1 report 的 STEP 序列——从"fatal error message"到"system info"
  4.2 Java stack vs native stack 的打印机制差异
  4.3 _verbose=false（stdout）vs _verbose=true（hs_err 文件）的内容差异
  4.4 Decoder::get_source_info() — 源码行号定位

§五 ★★ print_native_stack() 与 Decoder 的协作
  ❓ 为什么不能用外部 addr2line？信号上下文不能 fork/exec
  ❓ -fomit-frame-pointer 下怎么继续解栈？
  5.1 os::get_sender_for_C_frame() 的 frame pointer 链
  5.2 DWARF 展开的替代方案（libdecoder）
  5.3 解码失败的表现——不会崩溃，只是缺符号信息

§六 ★★ 和 [08-safepoint] + [10-01] + [07-thread] 的交叉连接
  ❓ "最短路径 vs 最长安全路径"对偶是什么？
  ❓ 崩溃时怎么检查 AttachListener 状态？
  ❓ 线程栈的崩溃打印和正常 dump 有什么区别？
  6.1 [08-safepoint] 的信号安全思想——最短 vs 最长
  6.2 [07-thread] 的 JavaThread::print_on_error() —— 不走 safepoint 的线程栈
  6.3 [10-01] 的 AttachListener 状态查询 —— 崩溃时的 attach 管道诊断
  6.4 ★ 和 [10-02] DCmd 的关系 —— VMInfoDCmd 也用 print_vm_info() 但路径不同

§七 GDB 验证 + 可证伪断言
```

## 六、写作要求

1. **★ "为什么必须用 write()" 是本文的第一基石**：不是回答"write 更快"——是回答"fprintf 需要 FILE* 锁 + malloc → 信号上下文中如果已有锁 → 死锁"。对"AS-safe"的精确解释。

2. **★ `_steps[]` 的真相是本文最大的"预期反转"**：读者可能预期一个数组 `_steps[] = {step_print_log, step_report, ...}`——但实际是 `STEP()` 宏 + `__LINE__`。这是精妙的 C 预处理器技巧——必须在 §三 揭晓。

3. **★ 和 [08-safepoint] 的"最短 vs 最长"对偶是全文的叙事锚点**：安全点 begin() 中，信号处理器只改 1 个状态；VMError 在同样约束下输出 2000 行文本。两个极端用同一套 AS-safe 约束。

4. **★ `first_error_tid` 的 cmpxchg 机制必须解释清楚**：多线程同时触发 fatal → 只有一个拿到报告权限。这和 [08-safepoint] 的 `_state` cmpxchg 同一模式。

5. **★ `recursive_error_count` + `_current_step` 的防无限循环**：如果报告自身崩溃 → 第二次进入 → 跳过已执行的步 → 只输出"Error during step X" → 超过深度 → 直接 abort。

6. **★ `fdStream` vs `fileStream` 的代码对比**：fdStream 的 write() 直接 `::write(fd, buf, len)`；fileStream 的 write() 内部 `fwrite()` → 致命差异。

7. **★ 不要忘记"AttachListener 状态查询"的验证**：在 source 中确认 VMError::report() 是否真的调用了 `AttachListener::is_initialized()`。如果源码中没有——需要记录为"设计预期但未实现"或"通过其他路径查询"。

## 七、输出格式

- Markdown 文件，命名为 `04-VMError-hs_err.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/10-services-diag/`
- 元信息头：
  ```
  > **阶段**：[10-services-diag]
  > **前置**：[08-safepoint], [10-01], [07-thread]
  > **依赖本文**：无（最终篇——组合全阶段能力）
  > **阅读收益**：理解 JVM 崩溃报告 hs_err_pid<pid>.log 的信号安全生成全链路——为什么只能用 write()、_steps 分步机制的 __LINE__ 宏实现、递归崩溃的防无限循环、和 safepoint 信号安全思想的极端对偶
  ```

## 禁止行为

- ❌ 把 `vmError.cpp` 的 1870 行当"源码注释翻译"——只聚焦 `report_and_die()` master、`report()` STEP 序列、`print_stack_trace/native_stack` 三条核心路径
- ❌ 解释 Linux 信号机制（`sigaction`、信号屏蔽字、SA_SIGINFO）——这属于 OS 教材，和本文的"崩溃报告输出"主线无关
- ❌ 深入 Decoder 的 ELF/DWARF 解析算法——只需解释 "Decoder 提供符号化能力，但不能用外部 addr2line 因为信号上下文不能 fork"
- ❌ 解释 `debug.cpp` 的 error_suppression 机制（`error_is_suppressed`）——那是 assert 抑制的调试特性，非崩溃报告主线
- ❌ 忘记 [08-safepoint] 的信号安全约束——每提一次 write() 的安全性，必须引用 [08-safepoint] 中 safepoint begin 的同样约束
- ❌ 把 `os::print_location()` 当成"堆检查"展开——它的角色只是把 PC 地址变成库名+符号，对 hs_err 日志输出提供上下文
- ❌ 不做信号安全的"负清单"解释——必须列出 `fprintf`、`malloc`、`fopen`、`fork`、`exec` 在信号上下文中为什么不能用
- ❌ 忽略 `recursive_error_count` 的防无限循环机制——这是"崩溃报告自己崩溃"的唯一防线
- ❌ 把 `first_error_tid` 的 cmpxchg 当成"简单的原子操作"一笔带过——对多线程同时触发 fatal 的精确分析必须做
- ❌ 不做 `fdStream` vs `fileStream` 的代码对比——两者的 write() 实现差异是 "为什么 hs_err 不用普通文件输出" 的唯一答案

## 要求行为

- ✅ **★ 一张"为什么必须写 write()"的负清单**：列出 5 类非 AS-safe 操作 + 具体风险（fprintf→FILE*锁→死锁，malloc→arena锁→死锁，fopen→路径解析→malloc...）
- ✅ **★ fdStream vs fileStream 的代码对比**：fdStream::write() → `::write(_fd, c, len)`；fileStream::write() → `fwrite(buf, len, 1, _file)` — 标注为什么后者不能用在信号上下文中
- ✅ **★ 8 个 report_and_die 重载的参数流表格**：scenario / 调用方 / _id 值 / 特殊的省略内容
- ✅ **★ STEP 宏的完整展开示例**：选取 3 个 STEP，展示预处理后的等价代码——`_current_step` 的值如何从 `__LINE__` 变成屏障
- ✅ **★ `recursive_error_count` 的有限状态机**：`depth 0 → normal report`、`depth 1 → skip completed steps`、`depth ≥ N → abort only`
- ✅ **★ report() STEP 序列的完整列表**：15+ 个 STEP，按内容分组（header → thread stack → native stack → VM state → memory map → system info），每组标注"输出理由"
- ✅ **★ 和 [08-safepoint] 的信号安全对比**：a) 约束相同（AS-safe）；b) 路径相反（最短 vs 最长）；c) 输出量相反（1 变量 vs 2000 行）；d) 机制相同（Atomic cmpxchg 保证单线程）
- ✅ **★ `Threads::print_on_error()` 和正常 dump 的对比**：safepoint required / stack walk method / completeness / signal safety
- ✅ **★ check_timeout() 的双层超时表**：全局超时（ErrorLogTimeout）+ 步骤超时（ErrorLogTimeout / 4）+ 时钟选择讨论（TSC vs clock_gettime）
- ✅ **★ GDB 验证 `recursive_error_count` 递增**：在 report_and_die 中手动触发 SIGSEGV → 观察 `recursive_error_count` 变化 → `_current_step` 跳过已执行步

## GDB 可证伪断言

1. **断言：`fdStream::write()` 直接调用 `::write()` 系统调用，不经过 buffered I/O**
   验证：`br` 在 `ostream.hpp` fdStream::write → `disass` → 确认调用 `::write@plt`
   预期：无 `fwrite`、`fprintf`、`puts` 等 libc buffered I/O 调用

2. **断言：`report_and_die()` master 入口使用 `static char buffer[O_BUFLEN]` 栈缓冲区**
   验证：`br vmError.cpp:1315` → `p buffer` → 确认在 `.bss` 或 `.data` 段（static）
   预期：buffer 地址在全局区域，不是堆分配（无 malloc 调用）

3. **断言：`first_error_tid` 的 cmpxchg 防止多线程并发崩溃**
   验证：在两个线程中几乎同时触发 assert → `br vmError.cpp:1351` → 第一个线程 cmpxchg 成功（返回 -1）→ 第二个线程 cmpxchg 失败（返回 != -1）→ 第二个线程等待
   预期：只有一个线程进入报告逻辑，第二个在 infinite_sleep 或 wait

4. **断言：`recursive_error_count` 在递归崩溃中递增**
   验证：`br vmError.cpp:1341` → 在某个 STEP 中手动写坏地址触发 SIGSEGV → 递归进入 report_and_die → `recursive_error_count` 从 0 → 1
   预期：第二次进入时 `recursive_error_count == 1`，且前面的 STEP 被跳过

5. **断言：`STEP` 宏的 `__LINE__` 赋值正确**
   验证：`br vmError.cpp:429`（第一个 STEP "printing fatal error message"）→ `p _current_step` → 值 = 429 → `p _current_step_info` → "printing fatal error message"
   预期：`_current_step` 等于当前 STEP 的 `__LINE__`

6. **断言：`_verbose = false` 时 stdout 只打印简要错误**
   验证：`br vmError.cpp:519-521` → 条件 `if (_verbose) { ... } else { return; }` → 在 `_verbose == false` 时提前返回
   预期：stdout（fd_out=1）在 `_verbose == false` 路径中被截断

7. **断言：`print_stack_trace()` 不使用 safepoint——直接从 StackFrameStream 读取**
   验证：`br vmError.cpp:195` → `bt` → 调用栈不含任何 VMThread 或 safepoint 同步函数
   预期：栈上只有 `VMError::report → print_stack_trace → StackFrameStream` 无 safepoint begin

8. **断言：`print_native_stack()` 使用 `os::get_sender_for_C_frame()` 遍历 frame pointer 链**
   验证：`br vmError.cpp:231` → 单步进入 → 观察 `fr.sender_pc()` 调用 → 确认通过 frame pointer 遍历
   预期：如果 frame pointer 为 NULL → `os::get_sender_for_C_frame()` 返回无效帧 → print_native_stack 输出 "..."

9. **断言：`Decoder::get_source_info()` 默认返回 false（没有可用的 Decoder）**
   验证：`br decoder.cpp:135` → `return false;` → 调用后 print_native_stack 的输出没有 "(file:line)" 后缀
   预期：默认情况下 native 栈只有函数名和偏移，没有源文件信息

10. **断言：`Threads::print_on_error()` 不会触发 safepoint——直接遍历 ThreadsSMR**
    验证：`br thread.cpp:5064` → 单步进入 → 确认 `ALL_JAVA_THREADS(thread)` 直接在调用线程上遍历，不经过 VMThread
    预期：无 safepoint check、无 ThreadBlockInVM 包装

11. **断言：`check_timeout()` 在长时间 STEP 后返回 true**
    验证：设置 `-XX:ErrorLogTimeout=1`（1 秒）→ 在某个 STEP 前加 `os::sleep(2000)` → `br vmError.cpp:1716` → 观察 `_reporting_did_timeout == true`
    预期：2 秒后超时，STEP 被跳过，日志中显示 "Error occurred during ..."

12. **断言：`os::abort()` 是 report_and_die 的最终步骤**
    验证：在 `br vmError.cpp` 查找 `os::abort()` 调用 → `bt` → 确认在最后一个 STEP 之后执行
    预期：`CreateCoredumpOnCrash` 决定是否生成 core dump，之后进程终止
