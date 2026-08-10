# PROMPT: 请撰写 01-signal-installation.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

`SIGBUS handler not installed` at `java.lang.InternalError: a fault occurred in a recent unsafe memory access operation in compiled Java code`.

A production service crashes with `SIGBUS (7)` when a `MappedByteBuffer`'s underlying file is truncated by another process. The JVM log shows:
```
# A fatal error has been detected by the Java Runtime Environment:
#  SIGBUS (0x7) at pc=0x00007f8a3c012340, pid=12345, tid=12346
# Problematic frame: V [libjvm.so+0x...] 
```

The error occurs because the JVM's `install_signal_handlers()` at os_linux.cpp:5413 was called, but `SIGBUS` was NOT included in the signal set passed to `set_signal_handler()`. The service started with `-XX:-UseMembar` (or an older JVM version) that skipped SIGBUS registration. When the mapped file is truncated, the kernel delivers SIGBUS → no handler registered → default action (terminate with core dump).

**Fix**: Ensure the JVM is started without flags that disable standard signal handlers. Check which signals are registered:
```bash
# Verify JVM signal handlers are installed
gdb -ex "break os_linux.cpp:5520" \
    -ex "run" \
    -ex "print sig" \
    -ex "print sigAct.sa_sigaction" \
    --args java -cp app.jar com.example.Main
```

**三步诊断**（直接写进 §〇）：

```bash
# 1. 检查 JVM 启动时注册了哪些信号处理器
strace -e trace=sigaction java -cp app.jar com.example.Main 2>&1 | grep SIG
# 期望输出: sigaction(SIGSEGV, ...), sigaction(SIGBUS, ...), sigaction(SIGFPE, ...), sigaction(SIGPIPE, ...), sigaction(SIGXFSZ, ...)
# 如果缺少某个信号 → 该信号的处理器未安装

# 2. 查看 JVM 的信号掩码配置
jcmd <pid> VM.signal_handlers
# 输出: 列出每个信号及其当前处理器状态

# 3. 检查 UseSignalChaining / AllowUserSignalHandlers 标志
java -XX:+PrintFlagsFinal -version 2>&1 | grep -E "UseSignalChaining|AllowUserSignalHandlers|ReduceSignalUsage"
# UseSignalChaining=true → JVM 使用 libjsig 链式机制
# AllowUserSignalHandlers=true → 允许应用注册处理器（JVM 跳过安装）
# ReduceSignalUsage=true → JVM 不安装某些信号处理器（减少信号使用）
```

**反事实**：如果 JVM 为所有 32+ 标准信号都安装处理器 → 每多一个信号处理器增加一次 sigaction 系统调用（~10µs）+ 信号掩码注册 → 启动时间增加 ~0.5ms。但关键是某些信号（SIGTERM、SIGINT）在 JVM 安装处理器后会覆盖用户的处理器 → 用户代码中 `signal(SIGINT, my_handler)` 失效 → 这破坏了 POSIX 兼容性。`AllowUserSignalHandlers` 和 `UseSignalChaining` 正是为平衡"JVM 需要处理的信号"和"用户需要处理的信号"而设计的。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the JVM's signal handler installation pipeline — from `signal_sets_init()` that builds the signal mask, through `set_signal_handler()` that makes the three-way decision (overwrite/SKIP/CHAIN/FATAL), to `install_signal_handlers()` that orchestrates the installation sequence. This is NOT a tutorial on "what signals the JVM handles" — it's ENGINEERING documentation on HOW the JVM decides which signals to handle, HOW it installs the handlers, and HOW it interacts with libjsig's three-phase protocol.

Reader completed **15-core-native** (native method implementation patterns), **09-native-interface** (JNI_ENTRY/JVM_ENTRY macros), and **00-libjsig-interposition** (libjsig.so 拦截层, three-phase protocol, sact[] chain). This doc: **how the JVM side calls `JVM_begin_signal_setting` and `JVM_end_signal_setting` to bracket the installation phase** — the code that triggers the state machine transitions documented in prompt-00.

### Interview Story Format Answer（必须出现在 §一 末尾）

"JVM signal handler installation begins in `os::Linux::signal_sets_init()` at os_linux.cpp:594, which populates two signal sets: `unblocked_sigs` (signals JVM handles — SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGTRAP, SR_signum, ±SIGPIPE/SIGXFSZ if !ReduceSignalUsage) and `vm_sigs` (signals for internal VM operations — SIGBREAK for thread suspend/resume). Then `install_signal_handlers()` at os_linux.cpp:5413 iterates through a curated list of signals (SIGSEGV, SIGBUS, SIGFPE, SIGPIPE, SIGXFSZ, SIGILL, SIGTRAP) and calls `set_signal_handler()` for each. `set_signal_handler()` at os_linux.cpp:5329 makes a three-way decision: if the pre-installed handler is SIG_DFL or SIG_IGN, it installs `signalHandler` (the JVM's unified C signal handler function); if `AllowUserSignalHandlers` is true or `set_installed` is false, it SKIPs the signal (leaving the user's handler in place); if `UseSignalChaining` is true, it records the pre-installed handler via `save_preinstalled_handler()` (stored in `sigact[NSIG]` at os_posix.cpp:1718) and installs `signalHandler` with CHAIN semantics. Any other case is FATAL — the JVM refuses to start. The actual sigaction call is wrapped between `JVM_begin_signal_setting()` and `JVM_end_signal_setting()`, triggering libjsig's Phase 1 and Phase 3 transitions. Three JVM flags control this behavior: `ReduceSignalUsage` at globals.hpp:883 (install fewer signal handlers), `AllowUserSignalHandlers` at globals.hpp:896 (defer to user handlers), and `UseSignalChaining` at globals.hpp:900 (enable libjsig chain integration)."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **signal_sets_init() — 两类信号集**: JVM 使用 `sigset_t` 管理两类信号集。`unblocked_sigs` 是 JVM 需要处理的信号（SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGTRAP, SR_signum，以及当 `!ReduceSignalUsage` 时的 SIGPIPE/SIGXFSZ）— 这些信号不在任何线程中被阻塞，确保 JVM 始终能收到它们。`vm_sigs` 是 VM 内部操作信号（SIGBREAK 用于线程 suspend/resume，当 `!ReduceSignalUsage` 时包含 BREAK_SIGNAL）— 这些信号被阻塞在普通 Java 线程中，只在 VM 线程中不被阻塞。Source: os_linux.cpp:594-688。

2. **set_signal_handler 三路决策**: 这个函数不只是"安装信号处理器"——它在 os_linux.cpp:5329 处做出三路决策：如果 preinstalled handler 是 SIG_DFL/IGN → OVERWRITE（安装 JVM handler）；如果 `AllowUserSignalHandlers=true` → SKIP（保留用户处理器）；如果 `UseSignalChaining=true` → CHAIN（记录 preinstalled handler 到 `sigact[]`，安装 JVM handler 并在不需要时链式调用 preinstalled handler）。其他情况 → FATAL（JVM 拒绝启动，因为已有未知处理器占用信号）。这是 JVM 启动时的关键安全检查。

3. **libjsig 三阶段协议集成**: JVM 的信号安装发生在 libjsig 的 Phase 2 中。安装前调用 `JVM_begin_signal_setting()` 进入 Phase 1（设置 `jvm_signal_installing=true`），安装后调用 `JVM_end_signal_setting()` 进入 Phase 3（设置 `jvm_signal_installed=true` + broadcast 唤醒等待线程）。在 Phase 2 中，JVM 线程的 sigaction 调用通过 TID 检查 bypass 拦截 → 直接安装到内核。Source: os_posix.cpp:1717-1731。

4. **sigact[] — JVM 侧的链式处理器存储**: 当 `UseSignalChaining=true` 但 libjsig 未被 preload 时，JVM 使用 `os_posix.cpp:1718` 中定义的 `sigact[NSIG]` 静态数组存储 pre-installed 处理器。这与 libjsig 的 `sact[]` 是独立的存储——`chained_handler()` 在 os_linux.cpp:5301 先尝试 libjsig 的 `JVM_get_signal_action()`（通过 `(*get_signal_action)(sig)` 查询 sact[]），失败时 fallback 到 JVM 自己的 `sigact[]`（通过 `os::Posix::get_preinstalled_handler(sig)` 查询）。

5. **信号掩码与 sigprocmask**: 信号安装不仅是 `sigaction`——还需要用 `sigprocmask`（或 `pthread_sigmask`）管理哪些线程接收哪些信号。`signal_sets_init()` 构建信号集后，JVM 在创建每个新线程时应用 `unblocked_sigs` 确保 JVM 信号不被阻塞。`man 2 sigprocmask`, `man 3 pthread_sigmask`。

6. **SA_SIGINFO 标志**: JVM 安装信号处理器时使用 `SA_SIGINFO` 标志（在 `sigAct.sa_flags` 中设置）。这告诉内核在信号到达时提供 `siginfo_t` 结构体——包含故障地址（`si_addr`）、信号来源（`si_code`）和发送者 PID（`si_pid`）。JVM 用这些信息区分 NPE（`si_addr=NULL`）和 StackOverflow（`si_addr` 在栈附近）。sigAct 的设置发生在 os_linux.cpp:5388-5395（sigfillset + sa_handler + sa_sigaction + sa_flags）。Source: `man 2 sigaction`, os_linux.cpp:5388-5395。

7. **save/get_preinstalled_handler**: 在安装 JVM 处理器之前，必须先保存原有的处理器（通过 `sigaction(sig, NULL, &oldAct)` 读取当前设置）。`save_preinstalled_handler()` 在 os_posix.cpp:1727 存储 `oldAct` 到静态数组 `sigact[NSIG]`（定义在 os_posix.cpp:1718）。`get_preinstalled_handler()` 在 os_posix.cpp:1720 读取这个数组。这用于 `set_signal_handler` 的三路决策和 `chained_handler` 的链式回退。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/os/linux/os_linux.cpp` — 信号安装主逻辑 (`:594-688` signal_sets_init, `:5329-5408` set_signal_handler, `:5413-5520` install_signal_handlers)
- `src/hotspot/os/posix/os_posix.cpp` — `save_preinstalled_handler` (`:1727`), `get_preinstalled_handler` (`:1720`)
- `src/hotspot/share/runtime/os.hpp` — `os::signals` 枚举（信号列表）
- `src/hotspot/share/runtime/globals.hpp` — `ReduceSignalUsage` (`:883`), `AllowUserSignalHandlers` (`:896`), `UseSignalChaining` (`:900`)
- `src/java.base/unix/native/libjsig/jsig.c` — `JVM_begin_signal_setting`/`JVM_end_signal_setting` 的实现侧

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — 包含所有信号安装代码

Syscall 速查表:

| Syscall | man | 用途 |
|---------|-----|------|
| sigaction | `man 2 sigaction` | 安装/查询信号处理器 |
| sigprocmask | `man 2 sigprocmask` | 修改线程信号掩码 |
| pthread_sigmask | `man 3 pthread_sigmask` | 线程级信号掩码（POSIX 线程安全替代 sigprocmask）|
| sigfillset | `man 3 sigfillset` | 初始化信号集为"全部信号" |
| sigemptyset | `man 3 sigemptyset` | 初始化信号集为"空" |
| sigaddset | `man 3 sigaddset` | 向信号集添加信号 |
| sigdelset | `man 3 sigdelset` | 从信号集删除信号 |
| sigismember | `man 3 sigismember` | 测试信号是否在信号集中 |

全局状态表:

| 变量 | 类型 | 位置 | 作用 |
|------|------|------|------|
| `unblocked_sigs` | `sigset_t` | os_linux.cpp:594 | JVM 不阻塞的信号集 |
| `vm_sigs` | `sigset_t` | os_linux.cpp:594 | VM 内部操作信号集 |
| `sigact[]` | `struct sigaction[NSIG]` | os_posix.cpp:1718 | 安装前保存的原始处理器 |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **os_linux.cpp** | `src/hotspot/os/linux/os_linux.cpp` | ~7500 | `signal_sets_init`(:594-688) — 构建两类信号集; `set_signal_handler`(:5329-5408) — 三路决策 + sigaction 安装; `install_signal_handlers`(:5413-5520) — 编排安装序列 | 🔥 核心 — 信号安装的全部逻辑 |
| 2 | **os_posix.cpp** | `src/hotspot/os/posix/os_posix.cpp` | ~3000 | `save_preinstalled_handler`(:1727) — 保存原始处理器到 sigact[NSIG]; `get_preinstalled_handler`(:1720) — 查询原始处理器 | 保存/恢复原始信号状态 |
| 3 | **globals.hpp** | `src/hotspot/share/runtime/globals.hpp` | ~3000 | `ReduceSignalUsage`(:883) — 减少信号安装; `AllowUserSignalHandlers`(:896) — 跳过用户信号; `UseSignalChaining`(:900) — 启用 libjsig 集成 | JVM 标志定义 |
| 4 | **os.hpp** | `src/hotspot/share/runtime/os.hpp` | ~700 | `os::signals` 枚举 — 信号编号定义 | 信号语义定义 |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ signal_sets_init — 两类信号集的构建逻辑

```
问题：
  ① signal_sets_init() 如何构建两类信号集？每类的用途是什么？
      答案方向: os_linux.cpp:594-688 signal_sets_init():
        void os::Linux::signal_sets_init() {
          // 1. unblocked_sigs: JVM 需要处理的信号
          sigemptyset(&unblocked_sigs);
          sigaddset(&unblocked_sigs, SIGILL);
          sigaddset(&unblocked_sigs, SIGSEGV);
          sigaddset(&unblocked_sigs, SIGBUS);
          sigaddset(&unblocked_sigs, SIGFPE);
          sigaddset(&unblocked_sigs, SR_signum);
          if (!ReduceSignalUsage) {
            sigaddset(&unblocked_sigs, SIGPIPE);  // 管道断裂
            sigaddset(&unblocked_sigs, SIGXFSZ);  // 文件大小超限
          }
          
          // 2. vm_sigs: VM 内部线程控制信号
          sigemptyset(&vm_sigs);
          if (!ReduceSignalUsage) {
            sigaddset(&vm_sigs, BREAK_SIGNAL);  // 线程 suspend/resume
          }
          
          signal_sets_initialized = true;
        }
      
      追问: 为什么 SIGPIPE 和 SIGXFSZ 受 ReduceSignalUsage 控制？
      → 这两个信号在"正常"JVM 操作中可能被触发（管道写入、文件写入），
        但不是所有应用都需要 JVM 处理它们。在某些容器环境中，
        ReduceSignalUsage=true 可以减少信号安装数量，降低启动时间。
        同时这两个信号的默认行为是终止进程，如果应用期望自己处理它们，
        JVM 安装处理器会干扰应用的信号处理逻辑。

  ② Counterfactual: 如果所有信号都放入 unblocked_sigs？
      答案方向: unblocked_sigs 控制哪些信号不被阻塞在线程中。
      如果 SIGTERM 被加入 unblocked_sigs → JVM 线程收到 SIGTERM 而非
      主线程 → JVM 的 shutdown hook 可能在线程池线程中执行而非主线程
      → 应用级的 shutdown 逻辑错位。而且每个不阻塞的信号都意味着
      内核需要在信号到达时检查更多线程的掩码 → 信号投递性能下降。
```

### 4.2 ★★★ set_signal_handler 三路决策 — 核心安装逻辑

```
问题：
  ① set_signal_handler() (os_linux.cpp:5329) 的三路决策逻辑是什么？
      答案方向: os_linux.cpp:5329-5408 set_signal_handler():
        - 先调用 sigaction(sig, NULL, &oldAct) 获取当前处理器
        - 调用 save_preinstalled_handler(sig, &oldAct) 保存原始状态
        
        决策 1 (OVERWRITE): 如果 oldAct.sa_handler == SIG_DFL 或 SIG_IGN
          或 oldAct.sa_handler == signalHandler (JVM 自己的处理器)
          → 安装 signalHandler (JVM 的统一 C 信号处理器)
          → sigaction(sig, &sigAct, NULL) 直接安装
          → 这是最常见的情况: JVM 启动时系统信号处理器为默认值
        
        决策 2 (SKIP): 如果 AllowUserSignalHandlers == true 或 !set_installed
          → 不安装 JVM handler → 保留用户的处理器
          → 记录日志: "User signal handler is used for signal %d"
          → 风险: 用户处理器可能不理解 JVM 的信号上下文
        
        决策 3 (CHAIN): 如果 UseSignalChaining == true
          → 调用 save_preinstalled_handler(sig, &oldAct) 保存到 os_posix.cpp:1718 sigact[NSIG]
          → 安装 signalHandler → sigaction(sig, &sigAct, NULL)
          → 当信号到达且 JVM 不处理时 → chained_handler 从 sigact[] 读取并调用
        
        决策 4 (FATAL): 以上都不满足
          → vm_exit_during_initialization("Signal already used by VM or OS")
          → JVM 拒绝启动
      
      追问: 为什么 SIG_DFL/SIG_IGN 要区分处理？
      → SIG_DFL 表示"使用系统默认行为"（通常是终止或忽略）。SIG_IGN
        表示"忽略该信号"。两者都意味着没有有效的用户处理器 → JVM 可以
        安全覆盖。但如果 oldAct 是其他值（非 DFL/IGN/用户处理器），
        说明系统或其他库已安装了特殊处理器 → JVM 不能覆盖 → FATAL。

  ② Counterfactual: 如果 JVM 不做三路决策，总是覆盖所有信号处理器？
      答案方向: 用户代码 `signal(SIGINT, my_ctrl_c_handler)` → 被 JVM
      的 install_signal_handlers 覆盖 → 用户按 Ctrl+C 时 JVM handler
      执行而非用户的 handler → 用户无法优雅关闭资源。更糟的是：
      `signal(SIGALRM, my_timer_handler)` → 被覆盖 → 定时器触发时
      JVM handler 执行 → 用户的定时器逻辑失效 → 应用行为异常。
      三路决策的 SKIP 路径正是为了保持与用户信号处理代码的兼容性。
```

### 4.3 ★★★ install_signal_handlers — 安装序列编排

```
问题：
  ① install_signal_handlers() (os_linux.cpp:5413) 的安装顺序和逻辑是什么？
      答案方向: os_linux.cpp:5413-5520 install_signal_handlers():
        - 一次性守卫检查（signal_handlers_are_installed）
        - dlsym probe 查找 libjsig 符号 (RTLD_DEFAULT)
        - 调用 JVM_begin_signal_setting() → 进入 Phase 1
        - 对每个关键信号调用 set_signal_handler():
          * SIGSEGV → 覆盖/SKIP/CHAIN (取决于三路决策)
          * SIGPIPE → 同上
          * SIGBUS   → 同上
          * SIGILL   → 同上
          * SIGFPE   → 同上
          * SIGXFSZ  → 同上 (受 ReduceSignalUsage 影响)
          * SIGTRAP  → 仅 PPC64 上安装
        - 调用 JVM_end_signal_setting() → 进入 Phase 3
        - signal_data 和 signal_thread_entry 初始化

        实际安装顺序（按 os_linux.cpp:5467-5495）:
        SIGSEGV → SIGPIPE → SIGBUS → SIGILL → SIGFPE → SIGXFSZ → (SIGTRAP on PPC64 only)
      
      追问: 为什么 SIGTRAP 只在 PPC64 上安装？
      → PPC64 架构使用 SIGTRAP 实现某些 JIT 编译器同步原语（trap-based
        poll）。x86-64 使用内存屏障（mfence/lfence）而不是陷阱指令
        → 不需要 SIGTRAP 处理器。

  ② Counterfactual: 如果安装顺序不同（例如 SIGBUS 在 SIGSEGV 之前安装）？
      答案方向: 安装顺序对正确性无影响——sigaction 是独立的系统调用，
      每个信号的安装不依赖其他信号。但逻辑顺序影响代码可读性：
      SIGSEGV 是最关键信号（NPE, StackOverflow, Safepoint 全部依赖它）
      → 放在第一位安装 → 如果后续信号安装失败（FATAL），至少 SIGSEGV
      已就位，可以提供更好的崩溃诊断信息。这是防御性编程而非功能需求。
```

### 4.4 ★★★ 与 libjsig 三阶段协议的集成 — begin/end_signal_setting

```
问题：
  ① JVM 如何与 libjsig 的 begin/end_signal_setting 交互？
      答案方向: install_signal_handlers() 的调用模式:
        JVM_begin_signal_setting();  // → libjsig Phase 1: installing=true, 记录 TID
        set_signal_handler(SIGSEGV, ...);
        set_signal_handler(SIGBUS, ...);
        // ... 更多信号 ...
        JVM_end_signal_setting();    // → libjsig Phase 3: installed=true, broadcast
        
      在 Phase 2 中，JVM 线程调用 sigaction 时，libjsig 通过 TID 检查
      (pthread_equal) 识别为 JVM 安装线程 → bypass 拦截 → 直接调用
      real_sigaction 安装到内核。同时 jvmsigs[] 记录 JVM 安装了哪些信号。
      
      如果 libjsig 未被 preload: JVM_begin_signal_setting 和 
      JVM_end_signal_setting 是 weak symbol → 如果 libjsig.so 未加载，
      这些函数为 NULL → JVM 直接调用 sigaction 无拦截。
      os_posix.cpp:1717 使用 dlsym(RTLD_DEFAULT, "JVM_begin_signal_setting")
      查找这些符号 → 如果找到则调用，否则跳过。
      
      追问: 如果 libjsig 加载了但 JVM 忘记调用 begin/end_signal_setting？
      → sigaction 调用进入 Phase 0 (installing=false, installed=false)
        → 直接透传到 libc sigaction → 处理器安装到内核 → 工作正常。
        但第三方后续的 sigaction 也会直接透传（因为 installed=false）
        → 可能覆盖 JVM 处理器。begin/end_signal_setting 的主要价值
        是启用 Phase 3 的保护——而非使安装本身工作。

  ② Counterfactual: 如果 JVM 不使用 libjsig，如何保护信号处理器？
      答案方向: 无保护。每次第三方库调用 sigaction 都可能覆盖 JVM 处理器。
      JVM 只能在崩溃时检测到问题（信号到达但处理器不是 JVM 的 → 行为异常）。
      没有 libjsig，JVM 无法阻止覆盖——因为 sigaction 是内核级操作，
      内核只知道当前处理器，不知道"链式"语义。libjsig 在用户态实现
      链式语义——这是 JVM 信号保护的唯一有效机制。
```

### 4.5 ★★★ 三个 JVM 标志的作用和交互

```
问题：
  ① UseSignalChaining、AllowUserSignalHandlers、ReduceSignalUsage 三个标志如何影响信号安装？
      答案方向: globals.hpp:883-900:
        ReduceSignalUsage (默认 false, globals.hpp:883):
          - 如果为 true: 减少安装的信号数量
          - 跳过 SIGPIPE, SIGXFSZ (可能被正常 I/O 操作触发)
          - 某些容器/云环境中启用以减少信号开销
        
        AllowUserSignalHandlers (默认 false, globals.hpp:896):
          - 如果为 true: set_signal_handler 中的 SKIP 路径
          - JVM 不安装该信号的处理器，完全交给用户
          - 风险: 用户处理器不理解 JVM 的信号上下文
        
        UseSignalChaining (默认 true, globals.hpp:900):
          - 启用与 libjsig 的集成
          - set_signal_handler 中的 CHAIN 路径: 保存 old handler 到 sigact[NSIG]
          - 安装后信号分派时 chained_handler 会尝试链式调用
      
      追问: 这三个标志的优先级是什么？
      → ReduceSignalUsage 最高优先级（决定是否安装某个信号）
      → AllowUserSignalHandlers 次之（决定安装还是跳过）
      → UseSignalChaining 最低（决定安装方式: 覆盖 vs 链式）
      即: ReduceSignalUsage 说"不安装"→ 不会进入后续判断；
          AllowUserSignalHandlers 说"跳过"→ 不安装 JVM handler；
          UseSignalChaining 说"链式"→ 安装 JVM handler + 保存旧 handler。

  ② Counterfactual: 如果 AllowUserSignalHandlers 默认为 true？
      答案方向: 新用户可能不知道需要手动处理 SIGSEGV → JVM 不安装
      SIGSEGV handler → 第一次 NPE 触发 SIGSEGV → 默认行为: 进程终止
      (core dump) → 用户看到 "Segmentation fault (core dumped)"
      而非 "java.lang.NullPointerException" → 完全不同的错误信息，
      诊断方向从 Java 异常变为 C 信号 → 混淆。默认 false 是安全选择:
      JVM 默认处理关键信号，用户需要显式 opt-in 来接管。
```

### 4.6 ★★★ save/get_preinstalled_handler — 原始处理器保存

```
问题：
  ① save_preinstalled_handler() 如何保存和检索原始处理器？
      答案方向: os_posix.cpp:1717-1731:
        static sigset_t sigs;
        static struct sigaction sigact[NSIG];
        
        void save_preinstalled_handler(int sig, struct sigaction* oldAct) {
          sigaddset(&sigs, sig);
          sigact[sig] = *oldAct;
        }
        
        struct sigaction* get_preinstalled_handler(int sig) {
          if (sigismember(&sigs, sig)) {
            return &sigact[sig];
          }
          return NULL;
        }
      
      sigset_t sigs 追踪哪些信号的原始处理器已被保存（替代 initialized 标记数组）。
      sigact[NSIG] 存储原始的 struct sigaction。
      
      追问: 为什么用 sigset_t sigs 而不是 initialized 布尔数组？
      → sigset_t sigs 有两个优势：① 线性搜索效率更高（sigismember 是位操作）；
        ② 与 POSIX 信号编程模型一致（sigaddset/sigismember 是标准 API）。
        sigset_t 隐含了 "最多 NSIG 位" 的约束，不会越界。

  ② Counterfactual: 如果不用 sigset_t 追踪，每次都读取当前值？
      答案方向: 信号安装后再次检查 → 读到 JVM 自己的 signalHandler →
      误判为"已有未知处理器"→ 可能的 FATAL 错误。而且 preinstalled
      语义就是"安装前"的状态 — 不应该随时间变化。
      sigset_t sigs 通过 sigaddset/sigismember 实现高效的"已保存"追踪，
      优于布尔数组的手动边界检查。
```

### 4.7 ★★★ 信号处理器标志位设置 — SA_SIGINFO, SA_ONSTACK 等

```
问题：
  ① JVM 安装信号处理器时设置了哪些 sa_flags？为什么？
      答案方向: os_linux.cpp:5388-5395 set_signal_handler() 中:
        struct sigaction sigAct;
        sigfillset(&(sigAct.sa_mask));
        sigAct.sa_handler = SIG_DFL;
        sigAct.sa_sigaction = signalHandler;  // JVM 的统一信号处理器
        sigAct.sa_flags = SA_SIGINFO           // 需要 siginfo_t 信息
                         | SA_RESTART          // 自动重启被中断的系统调用
                         | SA_ONSTACK;         // 使用独立的信号栈 (sigaltstack)
        
        SA_SIGINFO: 内核提供 siginfo_t → si_addr (故障地址),
          si_code (SEGV_MAPERR vs SEGV_ACCERR), si_pid (发送者)
        SA_RESTART: 被信号中断的慢系统调用（read/write/select）
          自动重启而非返回 EINTR
        SA_ONSTACK: 信号处理器在 sigaltstack 上执行 → 如果信号
          由栈溢出触发，主栈已满 → 信号处理器仍可在备用栈上运行
      
      追问: 为什么 sa_mask 用 sigfillset 阻塞所有信号？
      → 信号处理器执行期间不应被其他信号中断。如果 SIGSEGV 处理器
        执行期间又收到 SIGSEGV → 重入 → 栈帧叠加 → 可能死循环。
        阻塞所有信号是最安全的做法。代价：信号处理期间其他信号被
        排队（pending），处理器返回后投递。对 JVM 来说这是可接受的
        ——信号处理应该快速返回。

  ② Counterfactual: 如果不设置 SA_ONSTACK？
      答案方向: StackOverflow 触发 SIGSEGV → 处理器尝试在主栈上执行
      → 主栈已满 → 处理器执行 push 指令 → 再次 SIGSEGV → 内核通常
      终止进程（不能从信号处理器中的 SIGSEGV 恢复）→ 无 Java 层
      StackOverflowError → 进程崩溃。SA_ONSTACK + sigaltstack 确保
      即使主栈已满，信号处理器仍有可用的栈空间。
```

### 4.8 ★★★ JVM 启动顺序中的信号初始化位置

```
问题：
  ① 信号初始化在 JVM 启动序列中的位置和依赖关系是什么？
      答案方向: JVM 启动顺序:
        os::init() → 调用 os::Linux::signal_sets_init() (构建信号集)
          ↓
        os::init_2() → 调用 install_signal_handlers() (安装处理器)
          ↓  (在 Threads::create_vm() 之前)
        
      信号集必须在安装处理器之前构建（因为 set_signal_handler
      依赖信号掩码配置）。安装处理器必须在创建 Java 线程之前完成
      （因为新线程的创建依赖于 unblocked_sigs 的正确配置）。
      
      追问: 为什么 install_signal_handlers 在 Threads::create_vm() 之前？
      → Java 线程创建时需要知道哪些信号被阻塞（通过 unblocked_sigs）。
        如果信号处理器尚未安装 → 线程创建时的信号掩码可能不正确
        → 某些 JVM 信号无法到达 Java 线程 → 功能异常。
        而且 install_signal_handlers 可能在创建线程之前设置 sigaltstack
        → 所有线程共享同一个备用信号栈。

  ② Counterfactual: 如果在创建线程之后才安装信号处理器？
      答案方向: 已创建的线程有错误的信号掩码 → 需要用 pthread_sigmask
      逐个修正 → 复杂且易遗漏。而且在多线程环境中修改信号处理器
      （sigaction）的行为是"未指定"的（POSIX 标准未定义多线程中
      sigaction 的行为）→ 可能导致竞态条件。在单线程阶段安装
      避免了所有这些问题。
```

---

## §五 Article Structure

```
§〇 生产场景 — SIGBUS handler not installed
  ★ 真实错误: MappedByteBuffer 文件截断 → SIGBUS → 无处理器 → core dump
  ★ Root cause: install_signal_handlers 未安装 SIGBUS 处理器
  ★ 三步诊断: strace sigaction → jcmd VM.signal_handlers → PrintFlagsFinal
  ★ 反事实: 如果为所有信号安装处理器 → 覆盖用户处理器

§一 ★★★ JVM 信号安装全链路源码走读
  ❓ 这不是信号处理教程 — 这是 JVM 如何决定、安装、保护信号处理器的工程文档
  1.1 os_linux.cpp:594-688 signal_sets_init — 两类信号集构建
  1.2 os_linux.cpp:5329-5408 set_signal_handler — 三路决策: OVERWRITE/SKIP/CHAIN/FATAL
  1.3 os_linux.cpp:5413-5520 install_signal_handlers — 安装序列编排
  1.4 os_posix.cpp:1717-1731 save/get_preinstalled_handler — 原始处理器保存到 sigact[NSIG]
  1.5 globals.hpp:883-900 三个 JVM 标志: ReduceSignalUsage(:883), AllowUserSignalHandlers(:896), UseSignalChaining(:900)
  1.6 libjsig 集成: JVM_begin/end_signal_setting 触发 Phase 1/3
  1.7 sa_flags 设置: SA_SIGINFO + SA_RESTART + SA_ONSTACK 的原因 (os_linux.cpp:5388-5395)
  1.8 ★ Mermaid: 信号安装决策树 — 从 signal_sets_init 到 sigaction 系统调用
      Lanes: JVM Init / os::Linux / libjsig / Linux Kernel
  1.9 ★ 面试 Story Format 答案 — 从 os::Linux::signal_sets_init() 到 install_signal_handlers() 的完整叙事

§二 ★★★ 7 Beginner Callout 框
  2.1 signal_sets_init — 两类信号集
  2.2 set_signal_handler 三路决策
  2.3 libjsig 三阶段协议集成
  2.4 sigact[] — JVM 侧的链式处理器存储
  2.5 信号掩码与 sigprocmask
  2.6 SA_SIGINFO 标志
  2.7 save/get_preinstalled_handler

§三 ★★ 三路决策的边界条件和交互
  ❓ UseSignalChaining + AllowUserSignalHandlers 同时为 true 的语义
  ❓ ReduceSignalUsage 对线程信号掩码的影响
  3.1 三路决策优先级: ReduceSignalUsage > AllowUserSignalHandlers > UseSignalChaining
  3.2 标志组合矩阵 — 4 种组合的行为差异表
  3.3 信号掩码继承 — 新线程如何从父线程继承掩码并应用 unblocked_sigs

§四 ★ GDB 断点验证 — 7 断点完整信号安装 trace
  断言 1: os_linux.cpp:594 signal_sets_init → verify unblocked_sigs and vm_sigs contents
  断言 2: os_linux.cpp:5329 set_signal_handler entry → verify oldAct handler type
  断言 3: os_linux.cpp:5388 sigAct setup → verify SA_SIGINFO|SA_RESTART|SA_ONSTACK
  断言 4: os_linux.cpp:5400 sigaction call → verify kernel-level installation
  断言 5: os_linux.cpp:5413 install_signal_handlers entry → verify begin_signal_setting
  断言 6: os_linux.cpp:5520 install_signal_handlers exit → verify end_signal_setting
  断言 7: os_posix.cpp:1727 save_preinstalled_handler → verify handler saved to sigact[NSIG]

§五 ★ Cross-Reference
  ❓ 00-libjsig-interposition — JVM_begin/end_signal_setting 的实现侧
  ❓ 02-signal-dispatch — signalHandler 和 chained_handler 的信号处理路径
  ❓ man 2 sigaction — 内核级信号处理器安装 API
  ❓ man 3 pthread_sigmask — 线程信号掩码管理
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because JVM needs to distinguish between its own signals and user-registered signals, set_signal_handler makes a three-way decision based on the pre-installed handler state and JVM flags..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C++ code from os_linux.cpp / os_posix.cpp / globals.hpp, do not describe it. Every function discussed must have its actual source code shown with file:line annotation.

3. **Mermaid** — 信号安装决策树。4 lanes: JVM Init (os::init/init_2) / os::Linux (set_signal_handler) / libjsig (begin/end_signal_setting) / Linux Kernel (sigaction syscall)。完整流程：signal_sets_init → install_signal_handlers → begin_signal_setting (Phase 1) → set_signal_handler 三路决策 (OVERWRITE/SKIP/CHAIN/FATAL) → sigaction 内核安装 → end_signal_setting (Phase 3)。每步标注 os_linux.cpp 行号。

4. **GDB session** — 7 breakpoints with exact file:line numbers:
   - `os_linux.cpp:594` signal_sets_init — verify sigset_t contents (SIGSEGV, SIGBUS, SIGFPE present)
   - `os_linux.cpp:5329` set_signal_handler entry — verify oldAct.sa_handler (SIG_DFL/IGN/user handler)
   - `os_linux.cpp:5388` sigAct.sa_flags — verify SA_SIGINFO|SA_RESTART|SA_ONSTACK are set
   - `os_linux.cpp:5400` sigaction call — verify kernel-level installation with expected handler
   - `os_linux.cpp:5413` install_signal_handlers entry — verify JVM_begin_signal_setting is called
   - `os_linux.cpp:5520` install_signal_handlers exit — verify JVM_end_signal_setting is called
   - `os_posix.cpp:1727` save_preinstalled_handler — verify oldAct stored in sigact[NSIG]
   Each with expected variable values to verify.

5. **7 Beginner callout boxes** — exact text from §一: signal_sets_init, set_signal_handler 三路决策, libjsig 三阶段协议集成, sigact[], 信号掩码与 sigprocmask, SA_SIGINFO 标志, save/get_preinstalled_handler.

6. **Cross-reference at three points**:
   - At `JVM_begin_signal_setting` → "→ 00-libjsig-interposition for the Phase 1 state machine implementation in jsig.c:245"
   - At `set_signal_handler CHAIN path` → "→ 02-signal-dispatch for how chained_handler uses sigact[] to invoke pre-installed handlers"
   - At `sigaction` syscall → "→ man 2 sigaction for the kernel-level signal handler registration API"

7. **Story-format interview answer** — at §一末尾: 从 `os::Linux::signal_sets_init()` 到 `install_signal_handlers()` 的完整叙事。Three parts: "signal_sets_init builds two signal sets" + "set_signal_handler makes three-way decision based on pre-installed handler state" + "libjsig begin/end_signal_setting brackets the installation phase".

8. **"不要写成→应该写成"对照表**（必须出现在 §六 中）：

| 不要写成 | 应该写成 |
|---------|---------|
| "signal_sets_init builds the signal sets" | "os_linux.cpp:594 signal_sets_init() populates two sigset_t: `unblocked_sigs` (SIGILL, SIGSEGV, SIGBUS, SIGFPE, SR_signum, ±SIGPIPE/SIGXFSZ if !ReduceSignalUsage) and `vm_sigs` (±BREAK_SIGNAL if !ReduceSignalUsage). Each set is built with sigemptyset + sigaddset calls." |
| "set_signal_handler decides whether to install JVM's handler" | "os_linux.cpp:5329 set_signal_handler(sig, sigAct, ...) reads pre-installed handler via sigaction(sig, NULL, &oldAct) at :5358. Three-way decision at :5366-5385: if oldhand is SIG_DFL/SIG_IGN/signalHandler → OVERWRITE (install signalHandler). If AllowUserSignalHandlers||!set_installed → SKIP. If UseSignalChaining → CHAIN (save_preinstalled_handler to sigact[NSIG] at os_posix.cpp:1718, install signalHandler). Else → FATAL. The actual installation at :5400: sigaction(sig, &sigAct, &oldAct) where sigAct.sa_sigaction=signalHandler, sa_flags=SA_SIGINFO|SA_RESTART|SA_ONSTACK, sa_mask=sigfillset (os_linux.cpp:5388-5395)." |
| "JVM uses SA_SIGINFO to get fault information" | "os_linux.cpp:5388-5395 `sigfillset(&(sigAct.sa_mask))` then `sigAct.sa_handler = SIG_DFL`, `sigAct.sa_sigaction = signalHandler`, `sa_flags = SA_SIGINFO | SA_RESTART | SA_ONSTACK`. SA_SIGINFO causes the kernel to provide `siginfo_t` with `si_addr` (faulting address), `si_code` (SEGV_MAPERR=unmapped vs SEGV_ACCERR=permission denied), and `si_pid` (sender PID). SA_RESTART auto-restarts interrupted syscalls. SA_ONSTACK ensures the handler runs on sigaltstack — critical for StackOverflow detection where the main stack is full. sa_flags stored to sigflags[sig] at :5398." |
| "Three flags control signal installation" | "globals.hpp:883 `ReduceSignalUsage` (default false) removes SIGPIPE/SIGXFSZ from unblocked_sigs and vm_sigs, skips their installation. globals.hpp:896 `AllowUserSignalHandlers` (default false) enables SKIP path in set_signal_handler — JVM defers to user-registered handlers. globals.hpp:900 `UseSignalChaining` (default true) enables CHAIN path: save_preinstalled_handler + libjsig integration. Priority: ReduceSignalUsage > AllowUserSignalHandlers > UseSignalChaining." |

---

## §七 Output Format

- Markdown file, named `01-signal-installation.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/19-signal-chaining/docs/`
- 元信息头:

```
> **阶段**：[19-signal-chaining]
> **前置**：[00-libjsig-interposition]（libjsig 拦截层 — JVM_begin/end_signal_setting 的实现侧）、[15-core-native]（native 方法实现模式）
> **配套**：[00-libjsig-interposition]（JVM_begin/end_signal_setting 的调用侧）、[02-signal-dispatch]（signalHandler 和 chained_handler 的处理路径）
> **后续依赖本文**：[02-signal-dispatch]（信号分派 — signalHandler 是在本文中安装的处理器）
> **阅读收益**：追踪 JVM 信号处理器的完整安装管道 — 理解 signal_sets_init 构建的 sigset_t (unblocked_sigs + vm_sigs) 及其用途、set_signal_handler 的三路决策逻辑（OVERWRITE/SKIP/CHAIN/FATAL）及其与 JVM 标志的交互、install_signal_handlers 的安装序列编排、与 libjsig 三阶段协议的集成点（begin/end_signal_setting 触发 Phase 1/3）、SA_SIGINFO+SA_RESTART+SA_ONSTACK 标志位的设计理由；掌握 JVM 信号安装的诊断方法（strace sigaction + jcmd VM.signal_handlers + PrintFlagsFinal）
```

- 目标行数: 450+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "JVM installs signal handlers" 而不展示 os_linux.cpp 的源码 — 必须从 signal_sets_init(:594) 到 install_signal_handlers(:5520) 完整展示安装管道
- ❌ 不解释三路决策的每个分支 — 必须展示 OVERWRITE/SKIP/CHAIN/FATAL 的触发条件和源码
- ❌ 不解释三个 JVM 标志的交互 — 必须展示 ReduceSignalUsage(:883)/AllowUserSignalHandlers(:896)/UseSignalChaining(:900) 的优先级和组合行为
- ❌ 不展示 libjsig 集成 — 必须展示 begin/end_signal_setting 如何触发 Phase 1/3
- ❌ 不解释信号掩码的构建和继承 — 必须展示 unblocked_sigs/vm_sigs 的用途和线程继承
- ❌ 不解释 SA_SIGINFO/SA_RESTART/SA_ONSTACK 标志 — 必须展示每个标志的具体作用和设计理由
- ❌ 不做 GDB 断点 trace — 至少 7 个断点覆盖 signal_sets_init → set_signal_handler → sigaction → install_signal_handlers
- ❌ 不展示 save/get_preinstalled_handler — 必须展示 sigset_t sigs + sigact[NSIG] 的保存机制
- ❌ 忽略启动顺序的依赖 — 必须展示信号安装为什么在 Threads::create_vm() 之前
- ❌ 不要解释 C 语言基础（sigaction 系统调用本身的基础用法）

---

## §九 Required（≥8）

- ✅ **★ Mermaid 信号安装决策树** — 4 lanes: JVM Init / os::Linux / libjsig / Linux Kernel — signal_sets_init → install_signal_handlers → begin_signal_setting → set_signal_handler 三路决策 → sigaction → end_signal_setting
- ✅ **★ signal_sets_init 源码展示** — os_linux.cpp:594-688 两类信号集构建
- ✅ **★ set_signal_handler 三路决策源码** — os_linux.cpp:5329-5408 OVERWRITE/SKIP/CHAIN/FATAL 完整逻辑
- ✅ **★ install_signal_handlers 安装序列源码** — os_linux.cpp:5413-5520 编排逻辑
- ✅ **★ 三个 JVM 标志的定义和交互** — globals.hpp:883-900 + 优先级分析
- ✅ **★ 7 Beginner Callout 框** — exact text from §一
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事：os::Linux::signal_sets_init → block/unblock signal sets → install_signal_handlers → set_signal_handler 三路决策
- ✅ **★ GDB 断点 ≥7 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ "不要写成→应该写成"对照表** — 4 行，覆盖 signal_sets_init(2 sets), set_signal_handler(3-way), SA_SIGINFO, 三个标志(correct order)
- ✅ **★ 交叉引用** — 00-libjsig-interposition (begin/end_signal_setting 实现), 02-signal-dispatch (signalHandler 使用), man 2 sigaction, man 3 pthread_sigmask

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: signal_sets_init 信号集构建 (os_linux.cpp:594)
  (gdb) break os_linux.cpp:594
  (gdb) run
  (gdb) print unblocked_sigs → 期望: 空 sigset_t
  (gdb) next → 经过 sigaddset(SIGSEGV) 等调用
  (gdb) print sigismember(&unblocked_sigs, SIGILL) → 期望: 1
  (gdb) print sigismember(&unblocked_sigs, SIGSEGV) → 期望: 1
  (gdb) print sigismember(&unblocked_sigs, SIGBUS) → 期望: 1
  (gdb) print sigismember(&unblocked_sigs, SIGFPE) → 期望: 1
  (gdb) print sigismember(&unblocked_sigs, SR_signum) → 期望: 1

断言 2: set_signal_handler entry — 读取 pre-installed handler (os_linux.cpp:5329)
  (gdb) break os_linux.cpp:5358
  (gdb) continue
  (gdb) print sig → 期望: 信号编号 (如 SIGSEGV=11)
  (gdb) next → 经过 sigaction(sig, NULL, &oldAct)
  (gdb) print oldAct.sa_handler → 期望: SIG_DFL (0) 或 SIG_IGN (1)
  (gdb) print oldAct.sa_flags → 期望: 0 (默认无标志)

断言 3: set_signal_handler — sigAct 标志位设置 (os_linux.cpp:5388)
  (gdb) break os_linux.cpp:5388
  (gdb) continue
  (gdb) next → 经过 sigfillset(&(sigAct.sa_mask))
  (gdb) print sigAct.sa_sigaction → 期望: &signalHandler (JVM 的统一信号处理器)
  (gdb) print sigAct.sa_flags & SA_SIGINFO → 期望: 非 0 (SA_SIGINFO 已设置)
  (gdb) print sigAct.sa_flags & SA_RESTART → 期望: 非 0 (SA_RESTART 已设置)
  (gdb) print sigAct.sa_flags & SA_ONSTACK → 期望: 非 0 (SA_ONSTACK 已设置)
  (gdb) print sigismember(&sigAct.sa_mask, SIGSEGV) → 期望: 1 (所有信号被阻塞)

断言 4: sigaction 内核安装 (os_linux.cpp:5400)
  (gdb) break os_linux.cpp:5400
  (gdb) continue
  (gdb) print sig → 期望: 信号编号
  (gdb) print sigAct.sa_sigaction → 期望: &signalHandler
  (gdb) next → 经过 sigaction 系统调用
  (gdb) print ret → 期望: 0 (成功)

断言 5: install_signal_handlers — begin_signal_setting (os_linux.cpp:5413)
  (gdb) break os_linux.cpp:5413
  (gdb) continue
  (gdb) next → 进入一次性守卫检查 (signal_handlers_are_installed)
  (gdb) next → dlsym(RTLD_DEFAULT) probe 查找 libjsig 符号
  (gdb) print libjsig_is_loaded → 期望: 如果 libjsig 已 preload 则为 true
  (gdb) next → 进入 JVM_begin_signal_setting()

断言 6: install_signal_handlers — 安装序列 (os_linux.cpp:5467)
  (gdb) break os_linux.cpp:5467
  (gdb) continue
  (gdb) print sig → 期望: SIGSEGV → SIGPIPE → SIGBUS → SIGILL → SIGFPE → SIGXFSZ
  (gdb) continue → 重复直到所有信号安装完毕
  (gdb) print 已安装信号计数 → 期望: 6-7 (取决于 PPC64 SIGTRAP)

断言 7: install_signal_handlers — end_signal_setting (os_linux.cpp:5497)
  (gdb) break os_linux.cpp:5497
  (gdb) continue
  (gdb) next → 进入 JVM_end_signal_setting()
  (gdb) print → 如果 libjsig 已加载: 进入 jsig.c → broadcast 唤醒等待线程
  (gdb) print → 确认所有信号已安装完成

断言 8: save_preinstalled_handler (os_posix.cpp:1727)
  (gdb) break os_posix.cpp:1727
  (gdb) continue
  (gdb) print sig → 期望: 信号编号
  (gdb) print oldAct->sa_handler → 期望: SIG_DFL (0)
  (gdb) next → 经过 sigact[sig] = *oldAct
  (gdb) print sigact[sig].sa_handler → 期望: SIG_DFL (0)
  (gdb) print sigismember(&sigs, sig) → 期望: 1 (sigaddset 已生效)
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §二.2 承接**：本文展开 README 规划的 "01-signal-installation.md — JVM 信号安装流程"，覆盖 signal_sets_init + set_signal_handler + install_signal_handlers + save/get_preinstalled_handler + 3 个 JVM 标志，聚焦启动时的信号处理器安装决策和与 libjsig 的集成。

2. **同组边界**:
   - **00-libjsig-interposition** 覆盖 libjsig 侧的 begin/end_signal_setting 实现 — 本文展示 JVM 侧如何调用这些函数来触发 Phase 1/3
   - **02-signal-dispatch** 覆盖信号发生后的处理路径 — 本文安装的 signalHandler 是信号分派的入口点

3. **全部文档共享 §一 开头语**: "Reader completed 15-core-native (native method implementation patterns), 09-native-interface (JNI_ENTRY/JVM_ENTRY macros), and 00-libjsig-interposition (libjsig.so interception layer, three-phase protocol, sact[] chain). This doc: how the JVM side calls JVM_begin_signal_setting/JVM_end_signal_setting to bracket the installation phase — the code that triggers libjsig's Phase 1 and Phase 3 transitions."

4. **跨文档引用**: 本文是 Phase 19 的中间文档 — 00 建立拦截层概念，01 展示安装流程，02 展示分派路径。阅读顺序建议: 00 (拦截层) → 01 (安装流程) → 02 (分派路径)。
