# PROMPT: 请撰写 01-Signals.md

## 〇、背景与使用场景

### 你在凌晨 3 点被报警唤醒时经历了什么

线上 JVM 崩溃了。你登录服务器，看到 hs_err 文件第一行：

```
#
# A fatal error has been detected by the Java Runtime Environment:
#
#  SIGSEGV (0xb) at pc=0x00007f8b1a3c4d21, pid=12463, tid=12494
```

你往下翻，想找崩溃线程栈——但是 `Native frames` 只有 1 帧，`Java frames` 全空，`Current thread` 显示的是 `VMThread` 而不是你的应用线程。更诡异的是：你在 `LD_PRELOAD=libjsig.so` 后面挂了一个第三方 native profiler agent——现在 profiler 的日志显示它收到了 SIGSEGV 但 JVM 没收到，profiler 的 handler 自己 abort 了。

发生了什么？JVM 的信号处理器 `signalHandler` 和你的 profiler 的 `sigaction(SIGSEGV, ...)` 之间，有一个你不知道的"信号链（signal chaining）"协议在运行。libjsig.so 拦截了所有 `sigaction()` 调用，决定谁先收到信号。如果这条链搭错了——你的 profiler 吃掉了属于 JVM 的 polling page SIGSEGV（用于 safepoint 协调），结果 JVM 永远进不了 safepoint → 看起来像死锁 → 但实际上是信号链断裂。

或者另一个常见场景：你的 JNI 代码在 `_thread_in_native` 状态里收到了 SIGSEGV（用 Unsafe 写了一个已释放的 DirectByteBuffer）。你期望 JVM 打印 hs_err 崩溃——但 JVM 没有。你翻源码，发现 `JVM_handle_linux_signal()` 的 `_thread_in_native` 分支里，只有 `JNI_FastGetField::find_slowcase_pc()` 和 SIGBUS unsafe access 两条特殊路径——大部分 SIGSEGV 在 `_thread_in_native` 中直接走到末尾的 `chained_handler()` → 如果链上没有 handler → `report_and_die()`。但如果你的 agent 恰好注册了一个全局 SIGSEGV handler → 这个信号被它吃掉了 → JVM 静默。

### 背景概念速览

- **`sigaction()`**：Linux 信号注册系统调用。每个信号只能有一个 kernel-level handler——不是"追加"，是"覆盖"。JVM 要做信号链，必须在用户态拦截所有 `sigaction()` 调用。
- **libjsig.so**：通过 `LD_PRELOAD` 注入的动态库。它导出了 `sigaction()` 的 wrapper——拦截所有对 `sigaction()` 的调用（无论是 JVM 自己的还是三方 agent 的），在用户态维护一条 handler 链表，保证所有 handler 都被依次调用。
- **信号安全（AS-safe）**：在信号处理器中只能调用 POSIX 列出的 AS-safe 系统调用。不能 `malloc`（需要 arena 锁）、不能 `fprintf`（FILE* 需要锁）、不能 `fork`（子进程可能死锁）。`signalHandler` 的调用者在内核中断上下文中——严格受限于此。
- **`si_addr`**：`siginfo_t` 结构中的故障地址。对于 SIGSEGV，这是 CPU 试图访问的无效地址。`JVM_handle_linux_signal()` 的核心分流逻辑就是读 `si_addr`——判断它是 polling page 地址（→ safepoint）、零页地址（→ implicit null）、还是真正的 wild pointer（→ crash）。

### 相关生态工具

- **`LD_PRELOAD=libjsig.so`**：JVM 启动脚本（`java` wrapper）自动注入。如果你手动设了 `LD_PRELOAD` 覆盖它——信号链断裂。
- **`-Xlog:probe_runtime=debug`**：本阶段插桩覆盖的 OS 探针——跟踪 `signalHandler` 进入/退出、`JVM_handle_linux_signal` 的分流决策、libjsig 的 `begin/end_signal_setting` 标记切换。在信号上下文中用 `write()` 直接写 inst log buffer。
- **`/proc/<pid>/status`**：信号屏蔽字 `SigBlk: 0000000000000000` ——验证线程是否正确屏蔽了非 JVM 内部信号。
- **`strace -e trace=signal -p <pid>`**：追踪所有 `sigaction()` / `sigprocmask()` 调用 → 验证 libjsig 链是否正确安装。

## 一、任务 + 核心故事线（禁止做源码翻译机！）

读者学完了 [08-safepoint]——理解了 `SafepointSynchronize::begin()` 中 `mprotect` 让 polling page 不可读 → 线程访问触发 SIGSEGV → `JVM_handle_linux_signal()` 调用 `handle_polling_page_exception()` → 线程进入安全点。这是**"信号作为协作最短路径"**——改一个状态就返回。

读者学完了 [10-services-diag]——理解了 `VMError::report_and_die()` 怎么在信号上下文中用 `write()` 输出 2000 行 hs_err 报告。这是**"信号作为崩溃最长安全路径"**——同一个约束下做最复杂的输出。

但是，这两篇文章有一个巨大的空白地带：**信号是怎么从 CPU 页故障 → 内核信号投递 → JVM handler 的？** 为什么同一个 SIGSEGV 有时是 NPE、有时是 safepoint、有时是 crash？**libjsig.so 到底是什么——它不是 JVM 的 .cpp 文件，它是独立编译的 .so，但它怎么在 JVM 和 native agent 之间建立信号链？**

**本文不是 Linux 信号编程教程**——不讲 `sigset_t` 的类型定义、不讲 `SA_NODEFER` vs `SA_ONSTACK` 的内核差异、不讲 `sigwaitinfo()` vs `sigtimedwait()` 的区别。本文也不是 libjsig 的独立手册——不讲 `LD_PRELOAD` 的 ELF linker 插桩机制本身（linker 怎么决定先加载哪个 .so 是 Linux 动态链接器的功能，不是 JVM 代码）。

**本文的唯一目标是：追踪从 CPU 陷阱 → 内核投递 → `signalHandler`（`os_linux.cpp:5221`）→ `JVM_handle_linux_signal`（`os_linux_x86.cpp:271`）的 6 路分流 → `report_and_die()` 崩溃出口 的完整路径。** 关键是：`si_addr` + `thread_state` 的组合怎么决定走哪条分路？为什么 StackOverflow 的 guard page SIGSEGV 优先于 implicit null check？libjsig 的 `begin_signal_setting`/`end_signal_setting` 两阶段协议为什么存在？

### 核心叙事线——"信号是 JVM 的 primitive 事件源"

08 讲"polling page 怎么用 SIGSEGV 实现协作"，10 讲"hs_err 怎么在信号上下文中生成"，本文填补两者之间的物理鸿沟：**SIGSEGV 从 CPU MMU 的 page fault 开始，经过内核的 `force_sig_info()` → 用户态的 `signalHandler` → `JVM_handle_linux_signal` 的 6 路分流 → 如果是 crash → `VMError::report_and_die()`。** 同一条信号管线承载了三种完全不同的语义——协作（safepoint）、优化（implicit null / FastGetField）、崩溃（report_and_die）——全由 `si_addr + thread_state` 这一组合决定。

### 和 README §V 的关系

[11-os-layer README](README.md) §五的对比表列出了 11 阶段和 08/09/10 的维度差异。本文的"信号是 JVM 的 primitive 事件源"叙事线正是该对比表中"OS 三原语（信号/线程/内存）"的第一原语。读者读完本文后应该能在脑中将 08 的 polling page 路径和 10 的 report_and_die 路径连接为一根连续的信号管线。

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ 需要 `libjsig.so`（从 JDK `lib/` 目录加载或通过 `-XX:+UseSignalChaining` 启用）

## 三、聚焦源文件

| # | 文件 | 路径 | 模块 | 核心函数/类（行号） | 本文角色 |
|---|------|------|------|-------------------|---------|
| 1 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | os/linux | `signalHandler`(:5221), `set_signal_handler`(:5329), `libjsig_is_loaded`(:5234), `get_chained_signal_action`(:5240), `chained_handler`(:5301), `call_chained_handler`(:5255), `signal_sets_init`(:594), `hotspot_sigmask`(:704) | ★★★ 信号安装全链路——sigaction + libjsig 协议 + 信号屏蔽字 |
| 2 | `os_linux_x86.cpp` | `src/hotspot/os_cpu/linux_x86/os_linux_x86.cpp` | os_cpu/linux_x86 | `JVM_handle_linux_signal`(:271), `ucontext_get_pc`(:116) | ★★★ 核心分流——6 路信号分发逻辑 |
| 3 | `os_posix.cpp` | `src/hotspot/os/posix/os_posix.cpp` | os/posix | `save_preinstalled_handler`, `get_preinstalled_handler` | ★ 信号链回退——预安装 handler 保存 |
| 4 | `os.cpp` | `src/hotspot/share/runtime/os.cpp` | runtime | `signal_thread_entry`(:346), SIGBREAK 触发 AttachListener(:362-388) | ★★ SIGBREAK 处理——AttachListener lazy init + thread dump |
| 5 | `globals.hpp` | `src/hotspot/share/runtime/globals.hpp` | runtime | `UseSignalChaining`(:900), `ReduceSignalUsage`(:883), `AllowUserSignalHandlers`(:896) | ★★ 标志控制——信号链开关 + 用户 handler 豁免 |

**跨模块说明**：信号处理跨越 os/linux、os_cpu/linux_x86、os/posix 三个模块。`os_linux_x86.cpp` 中的 `JVM_handle_linux_signal` 是本阶段最关键的单函数——它被 01（信号分流）和 04（崩溃触发点）双重依赖。`os_linux.cpp` 是 7000+ 行的巨头文件——信号部分集中在线 5221-5460 区间。

**前置**：[08-safepoint]（理解 polling page + SIGSEGV 的用途）, [10-services-diag]（理解 hs_err 的信号安全约束）

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。★ 必须覆盖 README §八 的全部 4 个深度问题。

### 4.1 ★★★ 信号从 CPU 陷阱到 JVM handler 的完整路径

```
问题：
  ① signalHandler 的 wrapper 做了什么？为什么需要保存/恢复 errno？
    线索: os_linux.cpp:5221-5226
    代码引证:
      static void signalHandler(int sig, siginfo_t *info, void *uc) {
        assert(info != NULL && uc != NULL, "it must be old kernel");
        int orig_errno = errno;  // Preserve errno value over signal handler.
        JVM_handle_linux_signal(sig, info, uc, true);
        errno = orig_errno;
      }
    答案方向: signalHandler 是 sigaction 注册的唯一入口——所有信号先到这里。
    errno 保存/恢复的意义：JVM_handle_linux_signal 内部可能调用非 AS-safe 函数
    （如 write()/sprintf 到 inst log buffer）→ 这些调用可能 clobber errno →
    如果 signalHandler 不恢复 errno → 被中断的正常代码看到错误的 errno →
    导致不可调试的 "resource temporarily unavailable" 误报。
    ★ README §八 问题 2: 如果 JVM_handle_linux_signal 内部调了 report_and_die
    （永不返回），errno 的保存还有意义吗？→ 这是给"信号被 JVM 成功处理后返回正常
    代码路径"准备的——polling page、implicit null、StackOverflow 抛异常等路径都会
    return true → 回到 signalHandler → 恢复 errno → 被中断的代码继续执行。

  ② JVM_handle_linux_signal 是怎么调用的？为什么它声明在 os_linux.cpp 但定义在 os_linux_x86.cpp？
    线索: os_linux.cpp:5216-5219 (extern "C" 声明), os_linux_x86.cpp:271 (定义)
    答案方向: JVM_handle_linux_signal 是 extern "C" 函数——
    跨 os/linux 和 os_cpu/linux_x86 的 CPU 特定实现。
    声明在 os_linux.cpp 因为它需要被 signalHandler 调用（os/linux），
    定义在 os_linux_x86.cpp 因为分流逻辑依赖 x86 特定的 PC 检测
    （如 `os::is_poll_address(si_addr)`、`pc >= code_start && pc < code_end`）。
    ARM/aarch64 有各自 os_cpu 子目录中的等价位实现。

  ③ `signal_handlers_are_installed` 这个 bool（os_linux.cpp:5231）有什么用？
    线索: os_linux.cpp:5231, JVM_handle_linux_signal 内部检查
    答案方向: 在 JVM_handle_linux_signal 中，线程查找（`Thread::current()`）
    依赖 OSThread TLS → 但 TLS 只在 JVM 初始化后才有效。初始启动阶段
    （比如在 os::init() 调用 sigaction 安装 handler 的过程中），如果信号到达→
    JVM_handle_linux_signal 不能安全调用 Thread::current() →
    signal_handlers_are_installed 为 false 时跳过线程查找。
    ★ README §八 问题 4: 外部代码可以通过吗？→ JVMTI agent 可以通过
    os::Linux::set_signal_handler 间接触发再安装。但恶意代码直接
    sigaction() 绕过 JVM → signal_handlers_are_installed 保护不了。
```

### 4.2 ★★★ JVM_handle_linux_signal 的 6 路分流逻辑

```
问题：
  ① 6 路分流的完整决策树是什么？
    线索: os_linux_x86.cpp:309-656
    答案方向: 按信号类型 × thread_state × si_addr × pc 组合分流:
    (1) SIGPIPE/SIGXFSZ → 先试 chained_handler，不行就 ignore（行 309-316）
    (2) 栈溢出 SIGSEGV → yellow zone → StackOverflowError stub；red zone → fatal（行 380-445）
    (3) _thread_in_Java + SIGSEGV + si_addr 在 polling page 范围 → safepoint polling（行 457-459）
    (4) _thread_in_Java + SIGBUS + compiled method with unsafe_access → MappedByteBuffer（行 460-471）
    (5) _thread_in_Java + SIGFPE → implicit divide by zero（行 474-484）
    (6) _thread_in_Java + SIGSEGV + si_addr 在零页范围 → implicit null check → NPE（行 511-516）
    (7) _thread_in_vm + SIGBUS + doing_unsafe_access → unsafe in VM（行 517-523）
    (8) JNI_FastGetField slowcase → 特定 PC 范围 → 跳转 slowcase stub（行 527-532）
    (9) 都不能识别 → chained_handler → 如果链上没有 → report_and_die（行 631-656）
    追问: 为什么栈溢出检测优先于 implicit null？→ 栈 guard page 的 si_addr 也
    可能在零页附近 → 如果先检查 null → 栈溢出的 SIGSEGV 被误判为 NPE → 
    StackOverflowError 变成 NullPointerException → 应用逻辑完全错乱。
    所以 JVM_handle_linux_signal 在行 380-445 **最优先**检查栈区。

  ② SIGBUS 在 _thread_in_Java 和 _thread_in_vm 中处理有什么不同？
    线索: os_linux_x86.cpp:460-471 (Java), 517-523 (VM)
    代码引证:
      if (sig == SIGBUS && thread->thread_state() == _thread_in_Java) {
        // MappedByteBuffer scenario: si_code == BUS_ADRERR means the
        // mapping was invalidated (file truncated). Throw InternalError.
        ...
      }
      if (sig == SIGBUS && thread->thread_state() == _thread_in_vm) {
        // Unsafe access inside VM code (e.g., GC copying). 
        // Check doing_unsafe_access flag.
        ...
      }
    ★ README §八 问题 1: si_code (BUS_ADRALN vs BUS_ADRERR) 的差异是否
    足以覆盖？→ BUS_ADRERR 覆盖了 MappedByteBuffer 文件截断场景；BUS_ADRALN
    是未对齐访问——走到 chained_handler。如果硬件发出 BUS_ADRALN 给
    _thread_in_Java 线程 → 它不会匹配行 460 的检查（那里匹配 BUS_ADRERR）→
    → 最终走到 report_and_die。这是正确行为——未对齐访问不应该在 JVM 内部发生。

  ③ JNI_FastGetField 的 SIGSEGV slowcase 路径是怎么工作的？
    线索: os_linux_x86.cpp:527-532
    答案方向: JNI FastGetField 是一段无 safepoint 检查的汇编 stub → 尝试直接读
    字段 → 如果字段在 memory serialize page 上（G1 barrier 期间标记为不可读）
    → 访问触发 SIGSEGV → pc 落在 FastGetField stub 的已知地址范围 →
    JVM_handle_linux_signal 调用 JNI_FastGetField::find_slowcase_pc() →
    返回 slowcase 入口 → 修改 ucontext 中的 PC 寄存器 → 信号返回后线程跳转到
    slowcase → 走完整 JNI 路径（带 safepoint 检查）。
    追问: 为什么不是信号 handler 直接完成字段读取？→ 信号上下文中不能持有锁、
    不能分配 Handle → 必须"跳回正常代码"执行——修改 PC 是最干净的方案。
```

### 4.3 ★★★ libjsig.so 信号链的完整协议

```
问题：
  ① libjsig 是怎么注入到 JVM 进程中的？JVM 如何发现它？
    线索: os_linux.cpp:5431-5442
    代码引证:
      begin_signal_setting = CAST_TO_FN_PTR(signal_setting_t,
        dlsym(RTLD_DEFAULT, "JVM_begin_signal_setting"));
      if (begin_signal_setting != NULL) {
        end_signal_setting = CAST_TO_FN_PTR(signal_setting_t,
          dlsym(RTLD_DEFAULT, "JVM_end_signal_setting"));
        get_signal_action = CAST_TO_FN_PTR(get_signal_t,
          dlsym(RTLD_DEFAULT, "JVM_get_signal_action"));
        libjsig_is_loaded = true;
      }
    答案方向: JVM 启动时 `dlsym(RTLD_DEFAULT, ...)` 在全局符号空间中搜索
    `JVM_begin_signal_setting`——如果 libjsig.so 通过 LD_PRELOAD 注入 →
    这个符号存在 → libjsig_is_loaded = true → 之后所有 sigaction 调用
    都会经过 libjsig 的 chain 管理。

  ② begin_signal_setting/end_signal_setting 的两阶段协议解决什么问题？
    线索: os_linux.cpp: set_signal_handler 内部 (lines 5378+/5387+)
    ★ README §八 问题 3: 如果两个 JVM 线程同时调 sigaction → 全局标记有竞态吗？
    答案方向: begin/end 协议的核心竞态是：libjsig 的 sigaction() wrapper 被
    所有线程调用（JVM 线程装 handler，native agent 线程也装 handler）。当一个
    线程在装 JVM handler 过程中，另一个线程也可能调 sigaction → 如果 libjsig
    不区分"当前 sigaction 来自谁"→ 它可能把 JVM handler 加入链而不是直接装到
    内核。begin/end 设置全局 jvm_installing 标记来解决——但这确实有竞态。
    当前代码怎么避免？→ set_signal_handler 在调用 begin/end/中间 sigaction 的
    整个序列在**单线程启动阶段**（os::init() 中）执行——此时没有并发。生产运行时
    如果有 JVMTI agent 调 sigaction → 走 UseSignalChaining 分支 → os::Posix::
    save_preinstalled_handler → 不和 JVM handler 竞争。

  ③ chained_handler 怎么把信号委托给链上的下一个 handler？
    线索: os_linux.cpp:5301-5309, 5255-5290
    代码引证:
      bool os::Linux::chained_handler(int sig, siginfo_t* siginfo, void* context) {
        if (UseSignalChaining) {
          struct sigaction* actp = get_chained_signal_action(sig);
          if (actp != NULL) {
            chained = call_chained_handler(actp, sig, siginfo, context);
          }
        }
      }
    答案方向: get_chained_signal_action 先查 libjsig 的 get_signal_action 函数指针
    → 如果 libjsig 维护了链 → 从链上取下一个 handler。如果 libjsig 没有（未加载）
    → 回退到 os::Posix::get_preinstalled_handler → JVM 自己保存的"安装前已存在的
    handler"。call_chained_handler 检查 sa_flags 决定是调 sa_handler 还是
    sa_sigaction → 执行这个 handler → 如果它返回了 → JVM 继续（说明链上 handler
    处理不了）→ 最终 report_and_die。

  ④ 如果 libjsig 未加载（没有 LD_PRELOAD），信号怎么处理？
    答案方向: 直接 sigaction 交给内核——没有信号链。如果后续 native agent 也
    sigaction(SIGSEGV) → 内核用新 handler 覆盖 JVM 的 signalHandler →
    JVM 永远收不到 SIGSEGV → polling page 失效 → safepoint 死锁；null check
    失效 → NPE 变成 SIGSEGV crash。这就是 JNI 开发中"profiler 让 JVM 不崩溃了
    但线程全卡死" bug 的根源。
```

### 4.4 ★★ set_signal_handler 的 3 种安装决策

```
问题：
  ① set_signal_handler 面对已有 handler 时的 3 条路径是什么？
    线索: os_linux.cpp:5362-5400
    代码引证:
      if (oldhand != SIG_DFL && oldhand != SIG_IGN && oldhand != signalHandler) {
        if (AllowUserSignalHandlers || !set_installed) {
          INST_LOG_SIGNAL("SKIP third_party_handler");
          return;  // 路径 1: 跳过
        } else if (UseSignalChaining) {
          INST_LOG_SIGNAL("CHAIN third_party_handler");
          os::Posix::save_preinstalled_handler(sig, oldAct);  // 路径 2: 链式
        } else {
          fatal("Encountered unexpected pre-existing sigaction handler...");
        }
      }
    答案方向: 路径 1（跳过）→ ASAN/TSAN 等地址消毒器独占信号，不加入链。
    路径 2（链式）→ 保存 old handler，以后 JVM handler 不能识别信号时委托给它。
    路径 3（fatal）→ 出现意料之外的预安装 handler → JVM 拒绝启动——因为不知道该
    handler 的行为（可能吃信号不转发 → 死锁 JVM）。

  ② SIGPIPE 和 SIGXFSZ 为什么被特殊处理？
    答案方向: 这两个信号极其频繁（SIGPIPE 在写关闭的 pipe/socket 时发生，
    SIGXFSZ 在写超出文件大小限制时发生）但无信息量——用户态忽略就行。
    信号处理器中如果对它们做完整分流 → 日志爆炸。JVM 给它们最简单的路径：
    先尝试链式委托 → 不行就 return false（signalHandler 中 abort_if_unrecognized
    可能是 true 的情况？→ 不——这两个信号在 JVM_handle_linux_signal 开头
    就返回了，不检查 abort_if_unrecognized）。

  ③ ReduceSignalUsage 关了哪些信号？
    线索: os_linux.cpp: 信号安装列表行 5467-5495
    答案方向: 如果 -XX:+ReduceSignalUsage → 不安装 SHUTDOWN1/2/3_SIGNAL 和
    BREAK_SIGNAL 的用户态 handler → 让内核默认行为生效。
    BREAK_SIGNAL (=SIGQUIT) 的特殊之处：它触发 AttachListener lazy init →
    如果 ReduceSignalUsage → AttachListener 只能走套接字连接触发，不能走 SIGQUIT。
```

### 4.5 ★★ hotspot_sigmask —— 信号屏蔽字的 per-thread 设置

```
问题：
  ① 为什么信号屏蔽字必须在每个线程中显式设置而不能继承？
    线索: os_linux.cpp:585-590, 704-733
    代码引证:
      static sigset_t unblocked_sigs, vm_sigs;
      // unblocked_sigs: SIGILL, SIGSEGV, SIGBUS, SIGFPE, SR_signum, SHUTDOWN signals
      // vm_sigs: BREAK_SIGNAL (= SIGQUIT)
      void os::Linux::hotspot_sigmask(Thread* thread) {
        pthread_sigmask(SIG_UNBLOCK, unblocked_signals(), NULL);
        if (!ReduceSignalUsage) {
          if (thread->is_VM_thread()) {
            pthread_sigmask(SIG_UNBLOCK, vm_signals(), NULL);
          } else {
            pthread_sigmask(SIG_BLOCK, vm_signals(), NULL);
          }
        }
      }
    答案方向: fork 继承父线程屏蔽字，但 pthread_create 不继承——新线程从
    glibc 的默认屏蔽字开始（通常全解禁）。JVM 必须显式设置——解禁 SIGSEGV
    等 JVM 内部信号（所有线程都需要）；仅 VMThread 解禁 BREAK_SIGNAL
    （其他线程阻塞它——因为 SIGQUIT 应该由 VMThread 统一处理 → 
    见 os.cpp:362-388 signal_thread_entry 中 SIGBREAK 的处理）。
```

### 4.6 ★ 信号在三个阶段的连接：08（polling）+ 10（hs_err）+ 09（FastGetField）

```
问题：
  ① 08-safepoint 的 polling page → SIGSEGV → handler 调用 handle_polling_page_exception
    这是哪条分流路径？为什么"最短"？
    答案方向: os_linux_x86.cpp:457-459（第 3 条路径）。polling page 的 si_addr
    在 os::_polling_page 地址范围 → handler 调 StubRoutines::SafepointBlob →
    修改 ucontext 的 PC 跳转过去 → 返回。整个过程无锁、无 malloc、无输出——最短路径。

  ② 10-services-diag 的 report_and_die 是信号管线的末端——为什么"最长"？
    答案方向: 这是第 9 条路径（不能识别 → report_and_die）。从 CPU 陷阱到
    hs_err 文件的 2000 行输出——所有操作在同一个信号上下文中完成。
    08 的"最短"和 10 的"最长"展示了信号安全编程的两个极端——两者都受
    同样的 AS-safe 约束，但一个只改 PC 就返回，另一个输出完整崩溃报告。

  ③ 09-native 的 JNI FastGetField 用 SIGSEGV 做优化——信号作为"跳转"而不是"错误"
    答案方向: 正常路径无信号（fast path）→ 只在 memory serialize page 保护时
    触发 SIGSEGV → handler 改 PC 跳转 slowcase。这是"信号作为控制流机制"的
    经典案例——类比 user-level 的 page fault handling。
```

## 五、文章结构

```
§〇 源文件清单（跨 os/linux + os_cpu/linux_x86 + os/posix + runtime，标注每个文件的模块归属）

§一 ★★★ 信号从 CPU 陷阱到 JVM handler 的完整路径
  ❓ signalHandler 的 errno 保存/恢复——为什么重要？
  ❓ JVM_handle_linux_signal 为什么跨两个文件声明？
  1.1 CPU 陷阱 → 内核 force_sig_info → sigaction dispatch → 用户态 handler
  1.2 signalHandler 包装——errno + abort_if_unrecognized=true
  1.3 signal_handlers_are_installed 的门禁作用

§二 ★★★ JVM_handle_linux_signal 的 6 路分流逻辑
  ❓ si_addr 值怎么决定走 polling page、implicit null、还是 crash？
  ❓ StackOverflow guard page 的 SIGSEGV 为什么优先于 implicit null？
  2.1 信号类型前置过滤——SIGPIPE/SIGXFSZ 的特殊处理
  2.2 ★ 栈溢出检测——yellow/red/reserved zone 的地址空间布局
  2.3 _thread_in_Java 内的 5 条子路径 + 决策条件表
  2.4 JNI_FastGetField slowcase——信号作为控制流跳转
  2.5 ★ SIGBUS 的 _thread_in_Java vs _thread_in_vm 双分支差异

§三 ★★★ libjsig.so 信号链的完整协议
  ❓ begin/end_signal_setting 的两阶段协议解决什么竞态？
  ❓ 如果两个线程同时装 handler → 全局标记安全吗？
  3.1 dlsym(RTLD_DEFAULT, "JVM_begin_signal_setting") 的发现过程
  3.2 ★ 4 步时序：begin → sigaction → end → 链管理
  3.3 chained_handler 的委托逻辑——libjsig 链 vs 预安装 handler 回退
  3.4 无 libjsig 时的危险场景——native agent 覆盖 JVM handler

§四 ★★ set_signal_handler 的 3 种安装决策
  ❓ 什么情况下跳过信号安装（AllowUserSignalHandlers）？
  ❓ ReduceSignalUsage 关了哪些信号？
  4.1 3 路径：跳过 vs 链式 vs fatal
  4.2 SIGPIPE/SIGXFSZ 特殊处理的原因
  4.3 信号注册列表——SIGSEGV/SIGBUS/SIGILL/SIGFPE/SIGTRAP/SIGPIPE/SIGXFSZ

§五 ★★ hotspot_sigmask —— 信号屏蔽字的 per-thread 设置
  ❓ 为什么 pthread_create 不继承屏蔽字？
  ❓ 为什么只有 VMThread 解禁 BREAK_SIGNAL？
  5.1 unblocked_sigs vs vm_sigs 两个信号集
  5.2 thread_native_entry(:924) 和 attach(:1177) 两个调用点

§六 ★ 和 [08-safepoint] + [10-services-diag] + [09-native] 的交叉连接
  ❓ polling page → SIGSEGV → handler 分流——最短路径 vs 最长安全路径对偶
  ❓ 信号安全约束的统一——08 的 begin() 和 10 的 report_and_die 都是信号上下文中
  6.1 [08-safepoint] polling page 路径——"最短路径"的精确调用栈
  6.2 [10-services-diag] report_and_die——"最长安全路径"的信号上下文约束
  6.3 [09-native] JNI FastGetField——"信号作为控制流"
  6.4 ★ README §五 阶段对比表——信号是 11 的第一原语

§七 GDB 验证 + 可证伪断言
```

## 六、写作要求

1. **★ "6 路分流决策树" 是本文的第一交付物**：读者看完后必须能根据 `si_addr` + `thread_state` + `sig` 的组合说出会走哪条分支。用 ASCII 决策树图。

2. **★ libjsig 的 4 步协议不是"源码翻译"——是"为什么需要这个协议"的答案**：begin/end 不是多余的包装，它是为了解决"多个线程可以同时调用 sigaction 安装不同信号的 handler" 的竞态。

3. **★ 信号安全约束的统一叙事**：08 的 begin()、10 的 report_and_die、本文的 signalHandler——三者共享同一套 AS-safe 约束。这是贯穿 08→10→11 的隐藏主题。

4. **★ 栈溢出优先于 implicit null——一个设计决策的精确推理**：yellow zone 的 si_addr 本质上是 guard page 地址 —— 如果不优先检查栈 → 扔 NPE → 用户完全无法理解为什么一个 `void foo(int x)` 的入参 `x=5` 抛出 NullPointerException。

5. **★ 不要忽略 `ReduceSignalUsage` 和 `AllowUserSignalHandlers`**：这两个标志直接改变信号处理器的行为——线上排查时 `-XX:ReduceSignalUsage` 可能导致 `jcmd` 无法通过 SIGQUIT 触发 AttachListener。

6. **★ 和 08-safepoint 的连接必须精确到行号**：`JVM_handle_linux_signal` 行 457 → `os::is_poll_address(si_addr)` → `handle_polling_page_exception()` → [08-02] 的行号引用。

7. **★ 和 10-services-diag 的信号安全约束对比**：`signalHandler` 用 `int orig_errno = errno`（保存单变量），`VMError::report_and_die` 用 `static char buffer[O_BUFLEN]` + `::write()`（全套 AS-safe 输出）——两个尺度，同一约束。

## 七、输出格式

- Markdown 文件，命名为 `01-Signals.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/11-os-layer/`
- 元信息头：
  ```
  > **阶段**：[11-os-layer]
  > **前置**：[08-safepoint]（polling page + SIGSEGV）, [10-services-diag]（hs_err 信号安全）, [09-native-interface]（JNI FastGetField slowcase）
  > **依赖本文**：[11-02]（线程的信号屏蔽字初始化）, [11-04]（crash 出口 = 信号路径末端的 report_and_die）
  > **阅读收益**：理解 SIGSEGV 从 CPU 页故障到 JVM handler 分流的全路径——为什么同一个信号既是 safepoint 的协作机制又是崩溃的报警管道；掌握 libjsig.so 的信号链协议如何让 JVM 和 native agent 共享信号处理器而不冲突
  ```

## 禁止行为

- ❌ 解释 Linux 内核的信号投递机制（`force_sig_info`、`do_signal`、`handle_signal`）——这属于 Linux 内核文档，和本文的"JVM 怎么消费信号"主线无关
- ❌ 把 `sigaction()` 的 API 手册抄一遍——不讲 `SA_NODEFER` vs `SA_ONSTACK` vs `SA_RESETHAND` 的内核差异
- ❌ 展开 libjsig.so 的 LD_PRELOAD 注入机制——不讲 ELF 动态链接器怎么决定加载顺序。只讲 JVM 怎么用 `dlsym` 发现 libjsig 并和它交互
- ❌ 深入 `JNI_FastGetField` 的汇编 stub 实现——只讲它的 SIGSEGV slowcase 在分流中的位置，不讲 stub 的机器码
- ❌ 忘记 [08-safepoint] 的 polling page 路径——每提到 SIGSEGV 分流到 polling，必须引用 [08-02] 的 `handle_polling_page_exception` 行号
- ❌ 把信号屏蔽字（sigmask）当成"信号处理器的补充"轻描淡写——`hotspot_sigmask` 是线程初始化的一环，和 [11-02] 的 `thread_native_entry` 有直接依赖
- ❌ 不做 libjsig 未加载时的危险场景分析——必须描述"native agent 覆盖 JVM handler → 死锁/误判"的完整因果链
- ❌ 忽略 `signal_handlers_are_installed` 这个 bool 的门禁作用——它在启动早期信号到达时保护了未初始化完毕的 TLS
- ❌ 不覆盖 README §八 的全部 4 个深度问题——每个问题必须在 §四 中有一个问题组明确对应

## 要求行为

- ✅ **★ 一张完整的"信号分流决策表"**：行 = 信号类型 × 线程状态，列 = si_addr 条件 + pc 条件 + 处理方式（stub 跳转 / 抛异常 / fatal / 委托）
- ✅ **★ 6 路分流的 ASCII 决策树图**——从 `JVM_handle_linux_signal` 入口开始，每个分支标注条件（行号）和结果（跳转 stub / 抛异常 / crash）
- ✅ **★ libjsig 4 步时序的 UML 序列图**：纵轴 = 时间，横轴 = JVM / libjsig / Kernel / native agent，标注 begin/end 标记的切换点和 `sigaction` 拦截点
- ✅ **★ signalHandler → JVM_handle_linux_signal → (6 路) → report_and_die 的完整调用链图**：ASCII 箭头标注每个跳转的精确行号
- ✅ **★ errno 保存/恢复的"有用"vs"无用"场景对照表**：列出 6 路分流中哪些 return true→errno 有意义，哪些永不 return→errno 无意义
- ✅ **★ 和 [08-02] polling page 路径的精确连接**：`JVM_handle_linux_signal:457` → `handle_polling_page_exception()` → [08-02]§二
- ✅ **★ 和 [10-04] report_and_die 的精确连接**：`JVM_handle_linux_signal:656` → `VMError::report_and_die()` → [10-04]§二
- ✅ **★ `set_signal_handler` 决策树 + 每个信号的安装状态表**：SIGSEGV/SIGBUS/SIGILL/SIGFPE/SIGTRAP/SIGPIPE/SIGXFSZ/SIGQUIT——标注每个信号的 SA_SIGINFO 标志状态
- ✅ **★ 【11-os-layer README §五 阶段对比表】的引用**——在 §一 或 §六 中引用该表，说明本文的"信号"是 OS 三原语的第一原语
- ✅ **★ GDB 可证伪断言 ≥10 条**——覆盖 signalHandler 触发、JVM_handle_linux_signal 分流、libjsig dlsym 发现、chained_handler 委托

## GDB 可证伪断言

1. **断言：`signalHandler` 是所有 JVM 信号的唯一入口**
   验证：`br os_linux.cpp:5221` → 发送 `kill -SEGV <pid>` → GDB 在 `signalHandler` 中断
   预期：调用栈底部是 `__restore_rt`（内核信号 return frame），无其他 JVM 函数包装

2. **断言：`signalHandler` 传入 `abort_if_unrecognized=true`**
   验证：`br os_linux.cpp:5224` → `p abort_if_unrecognized`（寄存器 `%ecx` = 1）→ 确认值为 1
   预期：rdx/rcx = 1（true）

3. **断言：polling page SIGSEGV 在 `JVM_handle_linux_signal:457` 被识别**
   验证：`br os_linux_x86.cpp:457` → 访问 polling page → `p os::is_poll_address(si_addr)` → true
   预期：进入 `handle_polling_page_exception()`，不走到 `report_and_die`

4. **断言：implicit null check SIGSEGV 在 `JVM_handle_linux_signal:511` 被识别**
   验证：`br os_linux_x86.cpp:511` → 故意触发 NPE → `p si_addr` → 值在零页附近（如 `0x0000000000000004`）
   预期：`p needs_explicit_null_check(si_addr)` → false → 进入 `IMPLICIT_NULL` stub

5. **断言：StackOverflow SIGSEGV 先于 implicit null 被检查**
   验证：`br os_linux_x86.cpp:380` (栈检测入口) → 触发 StackOverflow → 断点命中 → `br os_linux_x86.cpp:511` → 断点**不**命中（栈检测先处理了）
   预期：在行 380 就被 `StackOverflowError` stub 处理，不到行 511

6. **断言：libjsig 的 `dlsym` 发现 `JVM_begin_signal_setting`**
   验证：`br os_linux.cpp:5431` → 设置 `LD_PRELOAD=libjsig.so` → GDB 在 `dlsym` 调用处 → `p libjsig_is_loaded` → 变为 true
   预期：`begin_signal_setting != NULL` → `libjsig_is_loaded = true`

7. **断言：`chained_handler` 在 JVM handler 无法识别信号时被调用**
   验证：`br os_linux.cpp:5301` → 发送 JVM 不识别的信号（如 `SIGUSR1`）→ `p UseSignalChaining` → true → 进入 `get_chained_signal_action`
   预期：链上有 handler → 调用它；链上无 handler → 回到 `JVM_handle_linux_signal` → `report_and_die`

8. **断言：`hotspot_sigmask` 在 `thread_native_entry` 中被调用**
   验证：`br os_linux.cpp:924` → 启动任何新 Java 线程 → 断点命中 → `p thread->osthread()->thread_id()` → 确认新线程
   预期：新线程的屏蔽字被设置为 JVM 的 `unblocked_sigs`

9. **断言：只有 VMThread 解禁 BREAK_SIGNAL**
   验证：`br os_linux.cpp:717-722` → `p thread->is_VM_thread()` → 对比 VMThread 和 JavaThread → VMThread 调 `SIG_UNBLOCK`，JavaThread 调 `SIG_BLOCK`
   预期：VMThread: vm_sigs 解禁；JavaThread: vm_sigs 阻塞

10. **断言：`SIGBREAK` 触发 `AttachListener` lazy init**
    验证：`br os.cpp:362` → `kill -QUIT <pid>` → 断点命中 → `p AttachListener::transit_state(AL_INITIALIZING, AL_NOT_INITIALIZED)` → 观察状态切换
    预期：如果 AttachListener 未初始化 → 触发 `AttachListener::is_init_trigger()`

11. **断言：JVM_handle_linux_signal 末尾触发 `report_and_die`**
    验证：`br os_linux_x86.cpp:656` → 故意触发无法处理的 SIGSEGV（如 `*(volatile int*)0xdeadbeef = 0`）→ 断点命中 → `p sig` → 确认 SIGSEGV
    预期：进入 `VMError::report_and_die()` → 生成 hs_err 文件
