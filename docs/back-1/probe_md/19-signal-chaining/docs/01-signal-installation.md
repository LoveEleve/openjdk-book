# 01-signal-installation — JVM 信号处理器安装

---
> **阶段**：[19-signal-chaining]
> **前置**：[00-libjsig-interposition]（libjsig 拦截层 — JVM_begin/end_signal_setting 的实现侧）、[15-core-native]（native 方法实现模式）
> **配套**：[00-libjsig-interposition]（JVM_begin/end_signal_setting 的调用侧）、[02-signal-dispatch]（signalHandler 和 chained_handler 的处理路径）
> **后续依赖本文**：[02-signal-dispatch]（信号分派 — signalHandler 是在本文中安装的处理器）
> **阅读收益**：追踪 JVM 信号处理器的完整安装管道 — 理解 signal_sets_init 构建的 sigset_t (unblocked_sigs + vm_sigs) 及其用途、set_signal_handler 的三路决策逻辑（OVERWRITE/SKIP/CHAIN/FATAL）及其与 JVM 标志的交互、install_signal_handlers 的安装序列编排、与 libjsig 三阶段协议的集成点（begin/end_signal_setting 触发 Phase 2/3）、SA_SIGINFO+SA_RESTART+SA_ONSTACK 标志位的设计理由；掌握 JVM 信号安装的诊断方法（strace sigaction + jcmd VM.signal_handlers + PrintFlagsFinal）

## Source Files Table

| 源文件 | 关键行号 | 角色 |
|-------|---------|------|
| `src/hotspot/os/linux/os_linux.cpp` | :5210-5520（signalHandler, set_signal_handler, install_signal_handlers）; :594-734（signal_sets_init, hotspot_sigmask） | 信号安装核心：全局 C handler、三路决策、安装编排、信号集构建、每线程掩码应用 |
| `src/hotspot/os/posix/os_posix.cpp` | :1717-1731 | JVM 侧 pre-installed handler 存储：sigact[NSIG] 数组 + save/get 访问器 |
| `src/hotspot/os/linux/os_linux.hpp` | :400-440（signal_sets_init, install_signal_handlers, hotspot_sigmask 声明） | Linux 平台信号安装接口声明 |
| `src/hotspot/share/runtime/thread.hpp` | :2313-2325 | SignalHandlerMark — 信号处理器中 RAII 防递归标记 |
| `src/hotspot/share/runtime/globals.hpp` | :883, 896, 900 | ReduceSignalUsage, AllowUserSignalHandlers, UseSignalChaining 标志定义 |

## §〇 生产场景

**SIGBUS handler 未安装导致核心转储**。

一个生产服务在运行时崩溃，JVM 日志显示：

```
# A fatal error has been detected by the Java Runtime Environment:
#  SIGBUS (0x7) at pc=0x00007f8a3c012340, pid=12345, tid=12346
# Problematic frame: V [libjvm.so+0x...]
```

**根因**：该服务使用 `MappedByteBuffer` 直接映射了一个外部文件。另一个进程（日志轮转工具）截断了该文件，JVM 尝试访问已截断的文件映射区域时，内核投递 SIGBUS 信号。然而 `install_signal_handlers()` (os_linux.cpp:5413) 虽然安装了 SIGBUS handler (os_linux.cpp:5477)，但启动参数中误用了 `-XX:-UseMembar` 或其他禁用标准信号处理器的标志，导致 SIGBUS 处理器未成功安装。无 handler 注册 → 默认动作（核心转储）。

**五步诊断**：

```bash
# 1. 检查 JVM 启动时注册了哪些信号处理器
strace -e trace=sigaction java -cp app.jar com.example.Main 2>&1 | grep SIG
# 期望输出: sigaction(SIGSEGV, ...), sigaction(SIGBUS, ...), sigaction(SIGFPE, ...)
# 如果缺少 SIGBUS → 该信号的处理器未安装到内核 (man 2 sigaction)

# 2. 查看 JVM 的信号处理器当前状态
jcmd <pid> VM.signal_handlers
# 输出列出每个信号及其当前处理器状态

# 3. 检查 UseSignalChaining / AllowUserSignalHandlers / ReduceSignalUsage 标志值
java -XX:+PrintFlagsFinal -version 2>&1 | grep -E "UseSignalChaining|AllowUserSignalHandlers|ReduceSignalUsage"
# UseSignalChaining=true  → JVM 使用 libjsig 链式机制（默认）
# AllowUserSignalHandlers=true → 允许应用注册处理器，JVM 跳过安装
# ReduceSignalUsage=true  → -Xrs 模式，减少信号安装

# 4. 检查每个 Java 线程的信号掩码
grep -E "^(Sig|Shd)" /proc/${PID}/status
# SigCgt (caught) 应包含 SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGXFSZ
# SigBlk (blocked) 不应包含 SIGSEGV — JVM 在所有线程中 unblock 这些信号
# SigIgn (ignored) 为 0 或仅 SIGPIPE bit — JVM 不应忽略除 SIGPIPE 外的任何关键信号
# 参考: man 5 proc — /proc/PID/status 格式文档

# 5. 通过 jstack 验证信号处理器上下文正常
jstack ${PID} | head -5
# 验证：线程 dump 可正常获取（依赖 BREAK_SIGNAL handler 和 hotspot_sigmask 的 VMThread 特殊处理）
# 如果挂起 → 检查 SIGQUIT (信号 3) 是否被 SigIgn 或 SigBlk
```

**反事实**：如果 JVM 为所有 32+ 标准信号都安装处理器 → 每个额外信号增加一次 sigaction 系统调用（~10µs）+ 信号掩码注册 → 启动时间增加 ~0.5ms。但关键问题是某些信号（SIGTERM、SIGINT）在 JVM 安装处理器后会覆盖用户的处理器 → 用户代码中 `signal(SIGINT, my_handler)` 失效 → 破坏 POSIX 兼容性。`AllowUserSignalHandlers` 和 `UseSignalChaining` 正是为平衡"JVM 需要处理的信号"和"用户需要处理的信号"而设计的。

## §一 核心走读 — 信号安装全链路

Reader completed 15-core-native (native method implementation patterns), 09-native-interface (JNI_ENTRY/JVM_ENTRY macros), and 00-libjsig-interposition (libjsig.so interception layer, three-phase protocol, sact[] chain). This doc: how the JVM side calls `JVM_begin_signal_setting`/`JVM_end_signal_setting` to bracket the installation phase — the code that triggers libjsig's Phase 2 and Phase 3 transitions.

### 1.1 signal_sets_init() — 构建两类信号集

`os_linux.cpp:594-688` `signal_sets_init()` 是 JVM 信号安装的前提步骤：在安装任何处理器之前，必须先定义哪些信号 JVM 需要感知。只有 2 个信号集，不存在第三类：

```cpp
// os_linux.cpp:594-688
void os::Linux::signal_sets_init() {
    assert(!signal_sets_initialized, "Already initialized");

    // === 第一类: unblocked_sigs — 所有 Java 线程都接收的信号 ===
    sigemptyset(&unblocked_sigs);           // man 3 sigemptyset
    sigaddset(&unblocked_sigs, SIGILL);     // :614 — 非法指令; man 3 sigaddset
    sigaddset(&unblocked_sigs, SIGSEGV);    // :634 — NPE/StackOverflow/Safepoint 轮询
    sigaddset(&unblocked_sigs, SIGBUS);     // :635 — MappedByteBuffer 访问
    sigaddset(&unblocked_sigs, SIGFPE);     // :636 — ArithmeticException
#if defined(PPC64)
    sigaddset(&unblocked_sigs, SIGTRAP);    // PPC64 专用 trap-based poll
#endif
    sigaddset(&unblocked_sigs, SR_signum);  // :641 — SIGUSR2 线程挂起/恢复

    if (!ReduceSignalUsage) {               // :655
        sigaddset(&unblocked_sigs, SIGPIPE);    // 管道断裂
        sigaddset(&unblocked_sigs, SIGXFSZ);    // 文件大小超限
        // 添加 SHUTDOWN1/2/3_SIGNAL 用于 shutdown hook
        if (!os::Posix::is_sig_ignored(SHUTDOWN1_SIGNAL))
            sigaddset(&unblocked_sigs, SHUTDOWN1_SIGNAL);
        // ... SHUTDOWN2, SHUTDOWN3 同理
    }

    // === 第二类: vm_sigs — 仅 VMThread 不阻塞的信号 ===
    sigemptyset(&vm_sigs);                  // :680
    if (!ReduceSignalUsage) {
        sigaddset(&vm_sigs, BREAK_SIGNAL);  // SIGQUIT — Thread Dump
    }
    debug_only(signal_sets_initialized = true);
}
```

**设计意图**：`unblocked_sigs` 中的信号在所有 Java 线程中不被阻塞（通过 `pthread_sigmask` (`man 3 pthread_sigmask`) 确保），使得任何线程发生 SIGSEGV/NPE 都能立即被捕获。`vm_sigs` 中的信号仅 VMThread 不阻塞——普通 Java 线程阻塞 BREAK_SIGNAL 意味着 Thread Dump 请求只唤醒 VMThread 来执行，避免干扰 Java 线程的正常执行。

> **两类信号集（unblocked_sigs + vm_sigs）**
>
> JVM 使用 `sigset_t` 管理两类信号集。`unblocked_sigs` 是 JVM 需要处理的信号（SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGTRAP on PPC64, SR_signum，以及当 `!ReduceSignalUsage` 时的 SIGPIPE/SIGXFSZ/SHUTDOWN1/2/3）——这些信号不在任何线程中被阻塞，确保 JVM 始终能收到它们。`vm_sigs` 是 VM 内部操作信号（BREAK_SIGNAL 用于 Thread Dump，当 `!ReduceSignalUsage` 时包含）——这些信号被阻塞在普通 Java 线程中，只在 VMThread 中不被阻塞。两类信号集在 `hotspot_sigmask()` (os_linux.cpp:704) 中被每线程应用到实际掩码。Source: os_linux.cpp:594-688。

### 1.2 set_signal_handler() — 三路决策核心

`os_linux.cpp:5329-5408` `set_signal_handler()` 不是简单地"安装信号处理器"——它是一道决定信号控制权的安全门禁：

```cpp
// os_linux.cpp:5329-5408 (关键逻辑萃取)
void os::Linux::set_signal_handler(int sig, bool set_installed) {
    // Step 1: 读取当前处理器状态
    struct sigaction oldAct;
    sigaction(sig, NULL, &oldAct);  // :5358 — 只查询不安装 (man 2 sigaction)

    void *oldhand = oldAct.sa_sigaction
                    ? CAST_FROM_FN_PTR(void*, oldAct.sa_sigaction)
                    : CAST_FROM_FN_PTR(void*, oldAct.sa_handler);  // :5362-5364

    // Step 2: 三路决策
    if (oldhand != CAST_FROM_FN_PTR(void*, SIG_DFL) &&        // :5366
        oldhand != CAST_FROM_FN_PTR(void*, SIG_IGN) &&
        oldhand != CAST_FROM_FN_PTR(void*, (sa_sigaction_t)signalHandler)) {

        if (AllowUserSignalHandlers || !set_installed) {       // :5371
            return;  // === 路1: SKIP — 用户自行管理 ===
        } else if (UseSignalChaining) {                        // :5375
            os::Posix::save_preinstalled_handler(sig, oldAct); // :5378 — 路2: CHAIN
        } else {
            fatal("Encountered unexpected pre-installed signal handler"); // 路3: FATAL
        }
    }

    // Step 3: 构造并安装 JVM 的 sigaction
    struct sigaction sigAct;
    sigfillset(&(sigAct.sa_mask));      // :5388 — 处理器执行期间阻塞所有信号 (man 3 sigfillset)
    sigAct.sa_handler = SIG_DFL;        // :5389 — 复位 sa_handler
    sigAct.sa_sigaction = signalHandler; // :5393 — JVM 统一信号处理入口 (定义于 os_linux.cpp:5221)
    sigAct.sa_flags = SA_SIGINFO | SA_RESTART | SA_ONSTACK; // :5394 (man 2 sigaction)

    sigflags[sig] = sigAct.sa_flags;    // :5398 — 存储标志位供后续诊断
    int ret = sigaction(sig, &sigAct, &oldAct); // :5400 — 真正安装到内核 (man 2 sigaction)
    assert(ret == 0, "check");          // :5401 — 非 Production 版本断言成功
}
```

**三路决策总表**：

| 分支 | 触发条件 | 动作 | 后果 |
|------|---------|------|------|
| **OVERWRITE** (默认路径) | oldhand 为 SIG_DFL/SIG_IGN/signalHandler | 直接安装 JVM handler | JVM 完全控制该信号 |
| **SKIP** | `AllowUserSignalHandlers==true` 或 `set_installed==false` | 不做任何安装，直接返回 | 用户处理器保留，JVM 失去对该信号的感知 |
| **CHAIN** | `UseSignalChaining==true` 且 oldhand 为有效的用户处理器 | `save_preinstalled_handler()` → 调用 `sigaction()` (`man 2 sigaction`) 安装 JVM handler | JVM 处理器优先，用户处理器通过 `sigact[]` 保留 |
| **FATAL** | oldhand 是未知的有效处理器，且未启用 SKIP/CHAIN | `vm_exit_during_initialization` 终止 JVM | JVM 拒绝启动（信号已被占用） |

> **set_signal_handler 三路决策**
>
> 这个函数不只是"安装信号处理器"——它在 os_linux.cpp:5329 处做出三路决策：如果 preinstalled handler 是 SIG_DFL/IGN → OVERWRITE（安装 JVM handler）；如果 `AllowUserSignalHandlers=true` → SKIP（保留用户处理器）；如果 `UseSignalChaining=true` → CHAIN（记录 preinstalled handler 到 `sigact[]`，安装 JVM handler 并在不需要时链式调用 preinstalled handler）。其他情况 → FATAL（JVM 拒绝启动，因为已有未知处理器占用信号）。这是 JVM 启动时的关键安全检查。

### 1.3 install_signal_handlers() — 总控编排

`os_linux.cpp:5413-5520` `install_signal_handlers()` 是信号安装的总入口，编排安装序列：

```cpp
// os_linux.cpp:5413-5520 (关键逻辑)
void os::Linux::install_signal_handlers() {
    if (!signal_handlers_are_installed) {   // :5415 — 一次性守卫
        signal_handlers_are_installed = true;

        // === Phase: dlsym 探测 libjsig (man 3 dlsym) ===
        begin_signal_setting = CAST_TO_FN_PTR(signal_setting_t,
            dlsym(RTLD_DEFAULT, "JVM_begin_signal_setting")); // :5432-5433
        if (begin_signal_setting != NULL) {
            end_signal_setting = dlsym(RTLD_DEFAULT, "JVM_end_signal_setting"); // :5436-5437
            get_signal_action = dlsym(RTLD_DEFAULT, "JVM_get_signal_action");   // :5438-5439
            libjsig_is_loaded = true; // :5440
        }

        if (libjsig_is_loaded) {
            (*begin_signal_setting)(); // :5458 — libjsig Phase 2
        }

        // === 6 个信号逐个安装 (os_linux.cpp:5467-5495) ===
        set_signal_handler(SIGSEGV, true);  // :5467 — NPE/StackOverflow/Safepoint
        set_signal_handler(SIGPIPE, true);  // :5472 — 管道断裂
        set_signal_handler(SIGBUS, true);   // :5477 — MappedByteBuffer 访问
        set_signal_handler(SIGILL, true);   // :5482 — 非法指令
        set_signal_handler(SIGFPE, true);   // :5487 — 除零/算术异常
#if defined(PPC64)
        set_signal_handler(SIGTRAP, true);  // PPC64 专用 JIT 同步
#endif
        set_signal_handler(SIGXFSZ, true);  // :5495 — 文件大小超限

        if (libjsig_is_loaded) {
            (*end_signal_setting)(); // :5499 — libjsig Phase 3
        }
    }
}
```

**安装顺序的设计意图**：SIGSEGV 排在第一位安装（os_linux.cpp:5467）是防御性编程——如果后续信号安装因 FATAL 终止 JVM，至少 SIGSEGV handler 已就位，可以提供更好的崩溃诊断（NPE、StackOverflow 的精确错误信息而非 `SIGSEGV` 核心转储）。功能上，sigaction (`man 2 sigaction`) 是独立系统调用，安装顺序不影响正确性。

### 1.4 dlsym(RTLD_DEFAULT) 探测 libjsig

`os_linux.cpp:5432-5443` 用 `dlsym(RTLD_DEFAULT, ...)` (`man 3 dlsym`) 探测 libjsig 的三个符号，这是 JVM 与 libjsig 集成的入口判断：

```cpp
begin_signal_setting = CAST_TO_FN_PTR(signal_setting_t,
    dlsym(RTLD_DEFAULT, "JVM_begin_signal_setting")); // :5432-5433
if (begin_signal_setting != NULL) {  // 非 NULL → libjsig 已加载
    end_signal_setting = dlsym(RTLD_DEFAULT, "JVM_end_signal_setting");
    get_signal_action  = dlsym(RTLD_DEFAULT, "JVM_get_signal_action");
    libjsig_is_loaded  = true;
}
```

**为什么用 `RTLD_DEFAULT` 而非 `RTLD_NEXT`**：`RTLD_DEFAULT` 在全局符号表中搜索（包括主程序 + 所有已加载的 .so），不关心符号来自哪个库。`RTLD_NEXT`（libjsig 内部使用）是"在当前库之后搜索"——适合拦截场景中获取原始符号。JVM 需要检查"libjsig 是否被加载"，用 `RTLD_DEFAULT` 是最直接的方式。详见 `man 3 dlsym`。

> **libjsig 三阶段协议集成**
>
> JVM 的信号安装发生在 libjsig 的 Phase 2 中。安装前调用 `JVM_begin_signal_setting()` 进入 Phase 2（设置 `jvm_signal_installing=true`），安装后调用 `JVM_end_signal_setting()` 进入 Phase 3（设置 `jvm_signal_installed=true` + broadcast 唤醒等待线程）。在 Phase 2 中，JVM 线程的 sigaction 调用通过 TID 检查 bypass 拦截 → 直接安装到内核 (`man 2 sigaction`)。Source: os_linux.cpp:5413-5520, jsig.c:319-340。

### 1.5 6 个信号逐个安装 — 每个信号的 JVM 用途

| # | 信号 | 安装位置 | 处理器 | JVM 用途 | 平台 |
|---|------|:---:|--------|---------|------|
| 1 | SIGSEGV | os_linux.cpp:5467 | `signalHandler()` → `JVM_handle_linux_signal()` | NPE 检测、StackOverflow 检测、Safepoint 轮询、Implicit Null Check | 全部 |
| 2 | SIGPIPE | os_linux.cpp:5472 | `signalHandler()` → `JVM_handle_linux_signal()` | 向已关闭的 socket/pipe 写入时，由 JVM_handle_linux_signal 内部决定处理策略（SA_RESTART 标志在 sigAct 中设置，见 os_linux.cpp:5394） | 全部 |
| 3 | SIGBUS | os_linux.cpp:5477 | `signalHandler()` → `JVM_handle_linux_signal()` | MappedByteBuffer 文件截断后的错误访问、Unsafe 内存操作 | 全部 |
| 4 | SIGILL | os_linux.cpp:5482 | `signalHandler()` → `JVM_handle_linux_signal()` | C2 编译器生成的 CPU 特性探测（如 AVX-512 测试指令）、插桩断点 | 全部 |
| 5 | SIGFPE | os_linux.cpp:5487 | `signalHandler()` → `JVM_handle_linux_signal()` | 整数除零 → `ArithmeticException` | 全部 |
| 6 | SIGTRAP | os_linux.cpp:5489 | `signalHandler()` → `JVM_handle_linux_signal()` | JIT 编译器 trap-based poll 同步原语 | **仅 PPC64** |
| 7 | SIGXFSZ | os_linux.cpp:5495 | `signalHandler()` → `JVM_handle_linux_signal()` | 写入文件超出文件大小限制时捕获错误而非终止 | 全部 |

**SIGTRAP 只在 PPC64 上安装的原因**：x86-64 使用内存屏障（`mfence`/`lfence`）实现 JIT 编译器同步，不需要 trap 指令。PPC64 的弱内存模型需要基于陷阱的同步原语来保证正确性。

**注意**：所有信号的处理器统一为 `signalHandler()` (os_linux.cpp:5221)，它调用 `JVM_handle_linux_signal(sig, info, uc, true)` (:5224)。不同信号的处理路径在 `JVM_handle_linux_signal()` 内部根据 `sig` 编号分发——这不是 sigaction 级别的区分，而是后续分派阶段的责任（→ 02-signal-dispatch）。

### 1.6 begin/end_signal_setting — 触发 libjsig 三阶段协议

`install_signal_handlers()` 的调用模式（os_linux.cpp:5458-5499）精确对应 libjsig 的三阶段协议：

```
JVM_begin_signal_setting();    → 进入 Phase 2: jvm_signal_installing = true, jvm_signal_installed = false
  set_signal_handler(SIGSEGV); → Phase 2 进行中: sigaction 通过 TID 检查 bypass libjsig 拦截
  set_signal_handler(SIGBUS);
  set_signal_handler(SIGFPE);
  ... (6 个信号)              → Phase 2 进行中: 持续安装
JVM_end_signal_setting();      → 进入 Phase 3: jvm_signal_installed = true + broadcast
```

**Phase 2 期间的保护机制**：libjsig 在 `sigaction()` (`man 2 sigaction`) 插桩函数中检查当前 TID 是否等于 JVM 安装线程的 TID——如果相等则直接透传到 `real_sigaction`（不存入 `sact[]`），因为 JVM 自身的安装不应该被"保护"。同时 `jvmsigs[]` 记录 JVM 安装了哪些信号，用于 Phase 3 之后的判断（test for JVM signal at jsig.c）。

→ 00-libjsig-interposition 了解 Phase 0/2/3 状态机的完整实现（jsig.c:245-340）。

### 1.7 os::Posix::save/get_preinstalled_handler — sigact[] 后备存储

`os_posix.cpp:1717-1731` 维护 JVM 侧的 preinstalled handler 存储——一个与 libjsig 的 `sact[]` 独立的备份机制：

```cpp
// os_posix.cpp:1717-1731
static sigset_t sigs;                                     // :1717 — 追踪哪些信号的处理器已保存
static struct sigaction sigact[NSIG];                      // :1718 — 原始 sigaction 存储

struct sigaction* os::Posix::get_preinstalled_handler(int sig) {
    if (sigismember(&sigs, sig)) return &sigact[sig];      // :1720-1722 (man 3 sigismember)
    return NULL;  // 未保存 → 该信号的原始处理器未被 JVM 记录
}

void os::Posix::save_preinstalled_handler(int sig, struct sigaction& oldAct) {
    sigact[sig] = oldAct;                                  // :1728 — 保存完整的 sigaction 结构
    sigaddset(&sigs, sig);                                 // :1729 — 标记"已保存" (man 3 sigaddset)
}
```

**为什么用 `sigset_t sigs` 而非布尔数组追踪**：`sigset_t` 两个优势：① `sigismember` (`man 3 sigismember`) 是位操作，O(1) 查询；② 与 POSIX 信号编程模型一致（`sigaddset`/`sigismember` 是标准 API），隐含 NSIG 边界约束，不会越界。

**调用链**：`set_signal_handler()` CHAIN 路径 (os_linux.cpp:5378) → `save_preinstalled_handler(sig, oldAct)` → 存入 `sigact[sig]`。后续 `call_chained_handler()` (os_linux.cpp:5255) → `get_preinstalled_handler(sig)` → 从 `sigact[]` 读出并调用原始处理器。

→ 02-signal-dispatch 了解 `chained_handler` 如何读取 `sigact[]` 执行链式回退。

> **sigact[] — JVM 侧的链式处理器存储**
>
> 当 `UseSignalChaining=true` 但 libjsig 未被 preload 时，JVM 使用 `os_posix.cpp:1718` 中定义的 `sigact[NSIG]` 静态数组存储 pre-installed 处理器。这与 libjsig 的 `sact[]` 是独立的存储——`chained_handler()` 在 os_linux.cpp:5301 先尝试 libjsig 的 `JVM_get_signal_action()`（通过 `(*get_signal_action)(sig)` 查询 sact[]），失败时 fallback 到 JVM 自己的 `sigact[]`（通过 `os::Posix::get_preinstalled_handler(sig)` 查询）。

### 1.8 三个 JVM 标志的交互矩阵

`globals.hpp:883-900` 定义三个控制信号安装行为的标志：

| 标志 | 类型 | 默认值 | globals.hpp 行号 | 语义 |
|------|------|:---:|:---:|------|
| `ReduceSignalUsage` | `product(bool)` | `false` | :883 | 减少信号安装：跳过 SIGPIPE/XFSZ/SHUTDOWN/BREAK |
| `AllowUserSignalHandlers` | `product(bool)` | `false` | :896 | 允许用户接管：`set_signal_handler()` SKIP 路径 |
| `UseSignalChaining` | `product(bool)` | `true` | :900 | 启用链式回退：`set_signal_handler()` CHAIN 路径 + libjsig 集成 |

**标志优先级**（从高到低）：

```
ReduceSignalUsage → 决定"是否安装该信号"（信号级）
  ↓
AllowUserSignalHandlers → 决定"安装还是跳过"（全局级）
  ↓
UseSignalChaining → 决定"安装方式：覆盖 vs 链式"（安装级）
```

**4 种标志组合的行为差异**：

| ReduceSignalUsage | AllowUserSignalHandlers | UseSignalChaining | 行为 |
|:---:|:---:|:---:|------|
| false | false | true | **默认**：安装 7 个信号（SIGSEGV/BUS/ILL/FPE/PIPE/XFSZ + SHUTDOWN1/2/3/BREAK），已存在的用户处理器通过 CHAIN 保留 |
| false | false | false | 安装 7 个信号，直接覆盖任何已存在的处理器（不保留） |
| false | true | * | 不安装任何信号（完全 SKIP），所有信号保留用户设置 |
| true | false | true | 安装核心 5 个信号（SIGSEGV/BUS/ILL/FPE/SR_signum），跳过 PIPE/XFSZ/SHUTDOWN/BREAK |

> **SA_SIGINFO 标志位**
>
> JVM 安装信号处理器时使用 `SA_SIGINFO` 标志（在 `sigAct.sa_flags` 中设置）。这告诉内核在信号到达时提供 `siginfo_t` 结构体——包含故障地址（`si_addr`）、信号来源（`si_code`）和发送者 PID（`si_pid`）。JVM 用这些信息区分 NPE（`si_addr=NULL`）和 StackOverflow（`si_addr` 在栈附近）。sigAct 的设置发生在 os_linux.cpp:5388-5395（`sigfillset` + `sa_handler` + `sa_sigaction` + `sa_flags`）。Source: `man 2 sigaction`, os_linux.cpp:5388-5395。

### 1.9 信号安装决策树

```
┌──────────────────┬─────────────────┬──────────────┬──────────────────┐
│   JVM Init       │   os::Linux      │   libjsig    │   Linux Kernel   │
├──────────────────┼─────────────────┼──────────────┼──────────────────┤
│                  │                 │              │                  │
│ os::init()       │                 │              │                  │
│  │               │                 │              │                  │
│  ├──────────────►│ signal_sets_    │              │                  │
│  │               │ init()          │              │                  │
│  │               │ :594            │              │                  │
│  │               │ ┌───────────┐   │              │                  │
│  │               │ │unblocked_ │   │              │                  │
│  │               │ │sigs [SEGV,│   │              │                  │
│  │               │ │BUS,FPE,   │   │              │                  │
│  │               │ │ILL,SR_SIG]│   │              │                  │
│  │               │ │vm_sigs    │   │              │                  │
│  │               │ │[BREAK_SIG]│   │              │                  │
│  │               │ └───────────┘   │              │                  │
│  │               │                 │              │                  │
│ os::init_2()     │                 │              │                  │
│  │               │                 │              │                  │
│  ├──────────────►│ install_signal_ │              │                  │
│  │               │ handlers()      │              │                  │
│  │               │ :5413           │              │                  │
│  │               │ ┌───────────┐   │              │                  │
│  │               │ │dlsym(RTLD_│   │              │                  │
│  │               │ │DEFAULT,   │   │              │                  │
│  │               │ │"JVM_begin │   │              │                  │
│  │               │ │_signal_   │   │              │                  │
│  │               │ │setting")  │   │              │                  │
│  │               │ └─────┬─────┘   │              │                  │
│  │               │       │         │              │                  │
│  │               │       └────────►│ begin_signal_│                  │
│  │               │                 │ setting()    │                  │
│  │               │                 │ :319 进入 Phase 2 │                  │
│  │               │                 │ installing=  │                  │
│  │               │                 │ true         │                  │
│  │               │       ◄─────────│              │                  │
│  │               │                 │              │                  │
│  │               │ set_signal_     │              │                  │
│  │               │ handler(SIGSEGV)│              │                  │
│  │               │ :5329           │              │                  │
│  │               │ ┌───────────┐   │              │                  │
│  │               │ │读 oldAct  │   │              │                  │
│  │               │ │三路决策:  │   │              │                  │
│  │               │ │ OVERWRITE │   │              │                  │
│  │               │ │ (SIG_DFL) │   │              │                  │
│  │               │ │ SKIP      │   │              │                  │
│  │               │ │ (AllowUsr)│   │              │                  │
│  │               │ │ CHAIN     │   │              │                  │
│  │               │ │ (UseSigCh)│   │              │                  │
│  │               │ │ FATAL     │   │              │                  │
│  │               │ └─────┬─────┘   │              │                  │
│  │               │       │         │              │                  │
│  │               │       └─────────┼──────────────►│ sigaction(SIGSEGV,│
│  │               │                 │              │  &jh, &oldAct)   │
│  │               │                 │              │ :5400            │
│  │               │       ◄─────────┼──────────────┤ 安装 signalHandler│
│  │               │                 │              │                 │
│  │               │ ... repeat for  │              │                 │
│  │               │ SIGBUS :5477... │              │ sigaction(SIGBUS)│
│  │               │ SIGFPE :5487... │              │ sigaction(SIGFPE)│
│  │               │ SIGXFSZ :5495   │              │ sigaction(SIGXFSZ)│
│  │               │                 │              │                 │
│  │               │                 │              │                 │
│  │               │       ┌─────────►│ end_signal_  │                 │
│  │               │       │         │ setting()    │                 │
│  │               │       │         │ :327 Phase 3 │                 │
│  │               │       │         │ installing=  │                 │
│  │               │       │         │ false,       │                 │
│  │               │       │         │ installed=   │                 │
│  │               │       │         │ true         │                 │
│  │               │       │         │ broadcast()  │                 │
│  │               │       ◄─────────│              │                 │
│  │               │                 │              │                 │
│  │               ▼                 │              │                 │
│  │ Threads::     │                 │              │                 │
│  │ create_vm()   │                 │              │                 │
│  │ (signal       │                 │              │                 │
│  │  handlers     │                 │              │                 │
│  │  installed ✓) │                 │              │                 │
│                  │                 │              │                  │
└──────────────────┴─────────────────┴──────────────┴──────────────────┘
```

### 1.10 面试 Story Format 答案

> **面试官**：JVM 是如何安装信号处理器的？
>
> **回答**：JVM signal handler installation begins in `os::Linux::signal_sets_init()` at os_linux.cpp:594, which populates two signal sets: `unblocked_sigs` (signals JVM handles — SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGTRAP on PPC64, SR_signum, ±SIGPIPE/SIGXFSZ/SHUTDOWN if !ReduceSignalUsage) and `vm_sigs` (signals for internal VM operations — BREAK_SIGNAL for Thread Dump). Then `install_signal_handlers()` at os_linux.cpp:5413 first probes libjsig via `dlsym(RTLD_DEFAULT)` (`man 3 dlsym`), calls `JVM_begin_signal_setting()` to enter Phase 2, then iterates through a curated list of signals (SIGSEGV → SIGPIPE → SIGBUS → SIGILL → SIGFPE → SIGXFSZ → SIGTRAP on PPC64) and calls `set_signal_handler()` for each.
>
> `set_signal_handler()` at os_linux.cpp:5329 makes a three-way decision: it first reads the pre-installed handler via `sigaction(sig, NULL, &oldAct)` (`man 2 sigaction`) at :5358. If the pre-installed handler is SIG_DFL or SIG_IGN, it installs `signalHandler` (the JVM's unified C signal handler function, defined at os_linux.cpp:5221) with `sigAction.sa_flags = SA_SIGINFO | SA_RESTART | SA_ONSTACK`. If `AllowUserSignalHandlers` is true or `set_installed` is false, it SKIPs the signal (leaving the user's handler in place). If `UseSignalChaining` is true and there's a pre-existing unknown handler, it records the pre-installed handler via `save_preinstalled_handler()` (stored in `sigact[NSIG]` at os_posix.cpp:1718) and installs `signalHandler` with CHAIN semantics. Any other case is FATAL — the JVM refuses to start because an unknown handler occupies the signal.
>
> After installation, `hotspot_sigmask()` (os_linux.cpp:704) applies the signal masks per-thread — unblocking `unblocked_sigs` on all threads, and selectively unblocking `vm_sigs` only on VMThread via `pthread_sigmask` (`man 3 pthread_sigmask`). Three JVM flags control this behavior: `ReduceSignalUsage` (globals.hpp:883, skip non-essential signals), `AllowUserSignalHandlers` (globals.hpp:896, defer to user handlers), and `UseSignalChaining` (globals.hpp:900, enable libjsig chain integration). The entire installation happens in a single-threaded phase before `Threads::create_vm()`, avoiding POSIX-unspecified multi-threaded sigaction (`man 2 sigaction`) behavior.

### 1.11 hotspot_sigmask() — 每线程信号掩码应用

`os_linux.cpp:704-734` `hotspot_sigmask(Thread* thread)` 是每线程信号掩码设置的**唯一**入口。`signal_sets_init()` 只定义了"哪些信号 JVM 关心"，但不把它们应用到任何线程——`hotspot_sigmask()` 在每个 Java 线程创建时（包括 VMThread）执行实际应用：

```cpp
// os_linux.cpp:704-734
void os::Linux::hotspot_sigmask(Thread *thread) {
    sigset_t caller_sigmask;
    pthread_sigmask(SIG_BLOCK, NULL, &caller_sigmask);  // :711 — 保存原始掩码
    osthread->set_caller_sigmask(caller_sigmask);       // :713 — 存储供诊断

    pthread_sigmask(SIG_UNBLOCK, os::Linux::unblocked_signals(), NULL); // :715 — unblock JVM 信号

    if (!ReduceSignalUsage) {                           // :718
        if (thread->is_VM_thread()) {                   // :720
            pthread_sigmask(SIG_UNBLOCK, vm_signals(), NULL); // :722 — VMThread unblock BREAK
        } else {
            pthread_sigmask(SIG_BLOCK, vm_signals(), NULL);   // :727 — Java 线程 block BREAK
        }
    }
}
```

**VMThread vs Java Thread 分叉设计**：所有线程都 unblock `unblocked_sigs` (:715)，确保 SIGSEGV 等异步信号可在任意线程递送。但 `vm_sigs` 中的 BREAK_SIGNAL 被 Java 线程主动阻塞 (:727)——只有 VMThread 解除阻塞。原因：Thread Dump (SIGQUIT) 只需唤醒 VMThread 执行 GC 安全点采集，阻塞在 Java 线程中避免无关中断打断正常执行流。

**调用于** `thread_native_entry()` (os_linux.cpp:~4815)，即线程启动后、进入 Java 世界前的时机。

**系统调用**：`pthread_sigmask` (`man 3 pthread_sigmask`) 三次调用——SIG_BLOCK 保存 (:711)，SIG_UNBLOCK 解除 JVM 信号 (:715)，SIG_UNBLOCK 或 SIG_BLOCK 根据线程类型处理 vm_sigs (:722/:727)。

> **hotspot_sigmask — 每线程信号掩码应用**
>
> os_linux.cpp:704 `hotspot_sigmask(Thread*)` 在每条 Java 线程创建时调用，是信号掩码设置的唯一入口。先 `pthread_sigmask(SIG_BLOCK, NULL, ...)` (`man 3 pthread_sigmask`) 保存调用者掩码 (:711)，然后 unblock `unblocked_sigs` (:715)，最后根据线程类型决定 unblock 还是 block `vm_sigs` (:720-728)。VMThread 接收 BREAK_SIGNAL 执行 Thread Dump，Java 线程阻塞它避免被打断。每线程掩码差异是 `signal_sets_init()` (os_linux.cpp:594) 定义的"信号集"在"线程"维度的实际体现。

### 1.12 SignalHandlerMark — 信号处理中的 RAII 防递归标记

`thread.hpp:2313-2325` `SignalHandlerMark` 是一个 `StackObj`，在信号处理器入口创建、借助 RAII 自动管理"正在处理信号"的标志位：

```cpp
// thread.hpp:2313-2325
class SignalHandlerMark: public StackObj {
 private:
  Thread* _thread;
 public:
  SignalHandlerMark(Thread* t) {
    _thread = t;
    if (_thread) _thread->enter_signal_handler();  // :2319 — 设置"在信号处理器中"标志
  }
  ~SignalHandlerMark() {
    if (_thread) _thread->leave_signal_handler();  // :2322 — 清除标志
    _thread = NULL;
  }
};
```

**关键设计**：
- **StackObj**：分配在栈上而非堆上，构造和析构严格对应作用域，RAII 语义保证
- **enter/leave 机制**：`enter_signal_handler()` (:2319) 在 `Thread` 中设置 `_in_signal_handler` 标志，防止同一线程递归进入信号处理器。确保 `signalHandler()` (os_linux.cpp:5221) 在信号递归场景下能被安全终止
- **RAII 保证 longjmp 安全**：即使信号处理器通过 crash protection 的 `longjmp` 异常退出，析构函数在栈展开时仍被调用——标志不会被泄漏

**使用位置**：在 `os_cpu/linux_x86/os_linux_x86.cpp` 的 `JVM_handle_linux_signal()` 中：

```cpp
SignalHandlerMark shm(thread);  // 创建时 enter(:2319)，作用域结束时 leave(:2322)
```

**与信号安装的关系**：`SignalHandlerMark` 不在安装阶段使用——它在信号递送后的处理阶段使用（02-signal-dispatch 范畴）。但它是理解"为什么 JVM 能安全地安装统一的 signalHandler 而不担心递归"的关键——`_in_signal_handler` 标志防止因信号在处理器执行期间再次到达导致的递归问题。

> **SignalHandlerMark — RAII 防递归标记**
>
> `thread.hpp:2313` 的 `SignalHandlerMark` 在信号处理器入口构建 → `enter_signal_handler()` (:2319) 设置 `_in_signal_handler` 标志，析构时 → `leave_signal_handler()` (:2322) 清除。StackObj + RAII 双重保证：即使 `longjmp` 异常退出（crash protection），析构函数也会被调用。这个标志使统一的 `signalHandler` (os_linux.cpp:5221) 能安全处理信号递归——如果标志已设置，处理器可直接跳过或链式回退。

## §二 边缘场景与反事实分析

### 2.1 单线程启动保证

信号安装发生在 `os::init_2()` 阶段（`install_signal_handlers()` 在此调用），此时 `Threads::create_vm()` 尚未执行——整个 JVM 仍处于**单线程**状态。这意味着：

- `set_signal_handler()` 内部的所有 `sigaction()` (`man 2 sigaction`) 调用没有竞态条件
- `save_preinstalled_handler()` 写入 `sigact[NSIG]` 无需加锁
- `signal_sets_init()` 初始化全局 `sigset_t` 是安全的

### 2.2 信号掩码继承

Linux 进程创建时（fork→execve），子进程继承父进程的信号掩码、处理器和忽略状态。如果启动 JVM 的父进程（如 shell、容器运行时）阻塞了某些关键信号，JVM 在启动初期会继承这些被阻塞的信号。具体场景：

1. **父进程阻塞 SIGSEGV**：shell 脚本中 `trap '' SIGSEGV` 后启动 Java → JVM 进程继承 blocked SIGSEGV → 任何 NPE 都会导致默认动作（核心转储），而非 JVM 的优雅处理。JVM 对策：`hotspot_sigmask()` (os_linux.cpp:704) 在每个线程创建后主动 unblock `unblocked_sigs` (:715)
2. **父进程忽略 SIGQUIT**：如果父进程设置了 `SIGQUIT → SIG_IGN`，JVM fork+exec 后继承 SIG_IGN 状态 → 即使 `hotspot_sigmask()` unblock 该信号，内核仍会静默丢弃 → Thread Dump (Ctrl+\) 失效
3. **systemd 信号清理**：systemd 启动服务时会重置信号掩码和处理方式，JVM 通常获得干净状态。但 `PrivateTmp=true` 或自定义 `IgnoreSIGPIPE=false` 等 systemd 选项可能改变行为

**验证**：
```bash
# 检查 JVM 进程继承的信号状态
grep -E "^Sig" /proc/${PID}/status
# SigBlk: 应从 hotspot_sigmask 之后变为非零 JVM 信号位
# SigCgt: 应包含 SIGSEGV(11), SIGBUS(7), SIGFPE(8), SIGILL(4), SIGXFSZ(25)
# SigIgn: 通常为 0 或仅 SIGPIPE(13) bit
```

### 2.3 一致性断言

`os_linux.cpp:5404-5407` 在 `sigaction()` (`man 2 sigaction`) 安装完成后，验证内核返回的 `oldAct` 与之前读取的一致：

```cpp
// os_linux.cpp:5404-5407
assert(oldAct.sa_sigaction == signalHandler, "expected just-installed handler");
// 或 (取决于 oldhand 类型):
assert(oldAct.sa_handler == CAST_FROM_FN_PTR(void(*)(int), signalHandler), "...");
```

这个断言确保在单线程启动期间，没有其他库的 `sigaction()` 调用插入到 JVM 的"读取 → 安装"之间——本质上是检测 LD_PRELOAD 的 libjsig 是否正确工作（Phase 2 期间 TID 检查应该透传 JVM 调用）。

### 2.4 libjsig 未加载时的 fallback 路径

`install_signal_handlers()` 在 os_linux.cpp:5432 通过 `dlsym(RTLD_DEFAULT, "JVM_begin_signal_setting")` (`man 3 dlsym`) 探测 libjsig。如果 libjsig 未被 preload（`LD_PRELOAD` 未设置或 libjsig.so 不存在），`begin_signal_setting` 为 NULL，`libjsig_is_loaded` 保持 false。此时的回退路径：

- **libjsig 已加载** → `begin_signal_setting`/`end_signal_setting` 被调用 → 三阶段协议保护
- **libjsig 未加载** → Phase 2/3 跳过 → `set_signal_handler()` 直接 `sigaction()` (`man 2 sigaction`) 到内核 → 无 Phase 2 TID bypass → 但仍有三路决策保护

**CHAIN 路径的两个 fallback 源**（`get_chained_signal_action()` 在 os_linux.cpp:5240-5253）：
1. libjsig 已加载 → 从 `sact[]` 获取（通过 `(*get_signal_action)(sig)`）
2. libjsig 未加载 → 从 JVM 自己的 `sigact[NSIG]` (os_posix.cpp:1718) 获取

两个 fallback 并行存在，确保链式回退在有无 libjsig 时都能工作。

### 2.5 libjsig Phase 2 期间的竞态保护

Phase 2 期间（`begin_signal_setting` 之后、`end_signal_setting` 之前），libjsig 的 `sigaction()` (`man 2 sigaction`) 拦截函数通过 TID 检查识别 JVM 安装线程：

```c
// jsig.c:260-270 (简化逻辑)
if (jvm_signal_installing && pthread_equal(pthread_self(), jvm_installing_tid)) {
    return call_os_sigaction(sig, act, oact);  // bypass，直接透传
}
// 非安装线程在 Phase 2 中被阻塞于 cond_wait，Phase 3 时被 broadcast 唤醒
```

由于 JVM 在 `Threads::create_vm()` 之前（单线程）调用 `install_signal_handlers()`，理论上不存在第三方线程的并发 `sigaction()` 调用。libjsig 的 TID 检查在此场景中是完全冗余的保护——它真正有价值是在 Agent（JVMTI Agent、JFR、DTrace）在 JVM 启动过程中并发注册信号处理器时。这是一个"最多一次"的 guard：即使 JVM opts runner（如 JDK Flight Recorder initializer）在另一个线程中启动，该线程的 sigaction 调用也会被 libjsig 正确拦截。

### 2.6 sigaction() 系统调用失败场景

`set_signal_handler()` 在 os_linux.cpp:5400 调用 `sigaction(sig, &sigAct, &oldAct)` (`man 2 sigaction`)。虽然 JVM 用 `assert(ret == 0)` (:5401) 断言成功（Production 构建中 `assert` 被编译为空），但仍存在理论失败场景：

- **EINVAL** (`man 2 sigaction`)：`sig` 超出有效信号编号（`NSIG` 控制上限），或 `sa_flags` 包含无效值。JVM 内部使用 `NSIG` 宏（`<signal.h>`）边界，正常不会触发
- **EFAULT**：`&sigAct` 或 `&oldAct` 指向无效内存。在 JVM 单线程启动阶段不存在（栈上分配 struct，未损坏）
- **SIGKILL/SIGSTOP 不可覆盖**：`man 7 signal` 明确这两个信号不可被 `sigaction()` 改变处理器。JVM 不会尝试安装——它们不在 `install_signal_handlers()` 的安装列表中

**实际影响**：这些场景在 JVM 正常启动中不会触发。但在极端情况下（如启动早期段错误损坏栈）→ 信号处理器未被安装 → 后续 SIGSEGV 执行默认动作（核心转储）→ 失去精确错误报告。

### 2.7 反事实分析

#### Counterfactual 1: 如果不用 libjsig，只用 JVM 内部的 sigact[] 链式

**实际设计**：`UseSignalChaining=true` 时，`install_signal_handlers()` 先探测 libjsig (os_linux.cpp:5432)，再通过 `begin_signal_setting` / `end_signal_setting` 进入三阶段协议。libjsig 提供两个关键功能：
1. **拦截第三方 sigaction 调用**：应用代码和 JNI 库的 `signal(SIGINT, my_handler)` 调用不会绕过 JVM handler——libjsig 的 `sigaction()` 插桩函数将它们存入 `sact[]`（而非直接安装到内核）
2. **三阶段状态机保护**：Phase 2 (TID bypass + 非JVM阻塞)、Phase 3 (broadcast 唤醒) 确保 JVM 安装期间无竞态

**如果只用 JVM 内部的 sigact[]**（不加载 libjsig）：JVM handler 安装到内核后，任何 `signal(SIGSEGV, my_handler)` 调用直接覆盖 JVM 的 `signalHandler`——没有 libjsig 拦截层保护。后果：用户代码的无意操作破坏 JVM 的 NPE/StackOverflow 检测 → JVM 崩溃但无精确错误信息。

**为什么会设计两套存储**：`sigact[]` (os_posix.cpp:1718) 和 `sact[]` (jsig.c) 服务于不同目的：
- `sact[]` (jsig.c) → 拦截外部 sigaction 调用，保护 JVM handler 不被覆盖
- `sigact[]` (os_posix.cpp) → JVM 保存 pre-installed handler，用于 CHAIN 路径的回退调用 + libjsig 未加载时的 fallback

权衡：libjsig 需要 `LD_PRELOAD`（破坏 pristine 部署模型），但提供完整的拦截保护。`sigact[]` 不需要 preload（更轻量），但无法拦截用户代码的 `signal()` 调用。

#### Counterfactual 2: 如果 `save_preinstalled_handler()` 不保存 sigact[]，直接丢弃原始处理器

**实际设计**：`set_signal_handler()` CHAIN 路径 (os_linux.cpp:5378) 调用 `save_preinstalled_handler(sig, oldAct)` 将原始处理器存入 `sigact[sig]`。

**如果丢弃**：`chained_handler()` 执行时，`get_preinstalled_handler()` 返回 NULL → 无法链式调用原始处理器。处理路径退化为：
1. `SIG_DFL` → JVM 执行默认动作（通常终止进程）
2. 跳过 → 信号被吞掉，应用对已注册信号毫无感知

**代价分析**：保存 `sigact[NSIG]` 的内存开销是 `NSIG × sizeof(struct sigaction)` ≈ 64 × 152 = 9.7KB（x86-64）。这个代价换取信号向后兼容性，对于常驻内存 1GB+ 的 JVM 来说完全可以忽略。

#### Counterfactual 3: 如果所有信号都强制安装（不检查 oldhand）

**实际设计**：`set_signal_handler()` 在 os_linux.cpp:5366 检查 `oldhand` 是否为 `SIG_DFL`/`SIG_IGN`/`signalHandler`——只有已知状态才 OVERWRITE。

**如果强制安装**：假设用户在 JVM 启动前通过 `LD_PRELOAD` 加载了自定义 SIGSEGV handler（如 AddressSanitizer 的 SIGSEGV handler）：
- 正常路径：检测到非 DFL/IGN/JVM 处理器 → `UseSignalChaining=true` → CHAIN → `save_preinstalled_handler()` → 用户处理器保留 → `signalHandler` 安装
- 强制安装路径：直接覆盖自定义 handler → ASAN 的 SIGSEGV 检测完全失效 → 内存错误不被报告 → 假阴性

**FATAL 路径设计价值**：当 `AllowUserSignalHandlers=false` **且** `UseSignalChaining=false` **且** 存在未知处理器 → `vm_exit_during_initialization()` (:5382)。这是"fail fast"策略——与其静默覆盖导致难以调试的运行时问题，不如立即拒绝启动、让用户在启动参数中解决信号冲突。

#### Counterfactual 4: 如果不使用 SA_ONSTACK

**实际设计**：`sigAct.sa_flags = SA_SIGINFO | SA_RESTART | SA_ONSTACK` (os_linux.cpp:5394)。

`SA_ONSTACK` (`man 2 sigaction`) 告诉内核在 `sigaltstack` (备用栈) 上执行信号处理器，而非当前线程的常规栈。JVM 设置备用栈的代码不在安装阶段（在 `os::Linux::install_signal_handlers()` 之外），但 `SA_ONSTACK` 标志在安装时就已设置。

**如果不用 SA_ONSTACK**：当线程的主栈已满（StackOverflow 场景），SIGSEGV 到达时：
- 无 SA_ONSTACK → 内核尝试在已满的栈上执行 signalHandler → 栈溢出 → 内核投递第二个 SIGSEGV → 无限循环或混乱崩溃
- 有 SA_ONSTACK → 内核切换到 sigaltstack 备用栈执行 signalHandler → JVM 可安全检测 StackOverflow → 抛出 `StackOverflowError`

SA_ONSTACK 是 JVM 能够精确检测 StackOverflow（而非核心转储）的关键机制。没有它，StackOverflow 的默认行为是 SIGSEGV + 核心转储 → 用户无法通过 try-catch 处理递归深度问题。

## §三 GDB 断点验证

### 断言 1: signal_sets_init 信号集构建 (os_linux.cpp:594)

```
(gdb) break os_linux.cpp:594
(gdb) run
(gdb) print unblocked_sigs → 期望: sigset_t (未初始化的空集)
(gdb) break os_linux.cpp:688
(gdb) continue
(gdb) print sigismember(&unblocked_sigs, SIGILL) → 期望: 1
(gdb) print sigismember(&unblocked_sigs, SIGSEGV) → 期望: 1
(gdb) print sigismember(&unblocked_sigs, SIGBUS) → 期望: 1
(gdb) print sigismember(&unblocked_sigs, SIGFPE) → 期望: 1
(gdb) print sigismember(&unblocked_sigs, SR_signum) → 期望: 1
(gdb) print sigismember(&vm_sigs, SIGQUIT) → 期望: 如果 !ReduceSignalUsage 则为 1
```

### 断言 2: set_signal_handler — pre-installed handler 读取 (os_linux.cpp:5358)

```
(gdb) break os_linux.cpp:5358
(gdb) continue
(gdb) print sig → 期望: SIGSEGV (11) — 第一个安装的信号
(gdb) next → 经过 sigaction(sig, NULL, &oldAct) (man 2 sigaction)
(gdb) print oldAct.sa_handler → 期望: SIG_DFL (0x0)
(gdb) print oldAct.sa_flags → 期望: 0 (默认无标志)
```

### 断言 3: set_signal_handler — sigAct 标志位设置 (os_linux.cpp:5388)

```
(gdb) break os_linux.cpp:5388
(gdb) continue
(gdb) next → 经过 sigfillset(&(sigAct.sa_mask)) (man 3 sigfillset)
(gdb) next → sigAct.sa_handler = SIG_DFL
(gdb) next → sigAct.sa_sigaction = signalHandler
(gdb) next → sigAct.sa_flags = SA_SIGINFO|SA_RESTART|SA_ONSTACK
(gdb) print sigAct.sa_sigaction → 期望: &signalHandler
(gdb) print sigAct.sa_flags & SA_SIGINFO → 期望: 非 0
(gdb) print sigAct.sa_flags & SA_RESTART → 期望: 非 0
(gdb) print sigAct.sa_flags & SA_ONSTACK → 期望: 非 0
(gdb) print sigismember(&sigAct.sa_mask, SIGSEGV) → 期望: 1
```

### 断言 4: sigaction 内核安装 (os_linux.cpp:5400)

```
(gdb) break os_linux.cpp:5400
(gdb) continue
(gdb) print sig → 期望: 当前正在安装的信号编号
(gdb) print sigAct.sa_sigaction → 期望: &signalHandler (定义于 os_linux.cpp:5221)
(gdb) next → 经过 sigaction(sig, &sigAct, &oldAct) 系统调用 (man 2 sigaction)
(gdb) print ret → 期望: 0 (成功)
(gdb) print sigflags[sig] → 期望: SA_SIGINFO|SA_RESTART|SA_ONSTACK
```

### 断言 5: install_signal_handlers — begin_signal_setting (os_linux.cpp:5458)

```
(gdb) break os_linux.cpp:5413
(gdb) continue
(gdb) print signal_handlers_are_installed → 期望: false (首次调用)
(gdb) next → 进入 dlsym(RTLD_DEFAULT) probe (man 3 dlsym)
(gdb) print begin_signal_setting → 期望: 如果 LD_PRELOAD=libjsig.so 则为非 NULL
(gdb) print libjsig_is_loaded → 期望: 如果 libjsig 存在则为 true
(gdb) break os_linux.cpp:5458
(gdb) continue
(gdb) print *begin_signal_setting → 期望: 函数指针指向 jsig.c:319
```

### 断言 6: install_signal_handlers — 安装序列 (os_linux.cpp:5467)

```
(gdb) break os_linux.cpp:5467
(gdb) continue
(gdb) print sig → 期望: 第一次为 SIGSEGV
(gdb) continue
(gdb) print sig → 期望: SIGPIPE
(gdb) continue
(gdb) print sig → 期望: SIGBUS
(gdb) continue
(gdb) print sig → 期望: SIGILL
(gdb) continue
(gdb) print sig → 期望: SIGFPE
(gdb) continue
(gdb) print sig → 期望: SIGXFSZ (非 PPC64)
(gdb) 预期总安装数: 6 (x86-64) 或 7 (PPC64 包含 SIGTRAP)
```

### 断言 7: install_signal_handlers — end_signal_setting (os_linux.cpp:5499)

```
(gdb) break os_linux.cpp:5499
(gdb) continue
(gdb) print libjsig_is_loaded → 期望: 与断言 5 一致
(gdb) next → 进入 JVM_end_signal_setting()
(gdb) 确认 → libjsig 收到 Phase 3 触发，jvm_signal_installed = true
```

### 断言 8: save_preinstalled_handler (os_posix.cpp:1727)

```
(gdb) break os_posix.cpp:1727
(gdb) continue
(gdb) print sig → 期望: 信号编号（仅在 UseSignalChaining=true 且 oldhand 非 DFL/IGN 时触发）
(gdb) print oldAct.sa_handler → 期望: 非 SIG_DFL/IGN 的有效处理器
(gdb) next → 经过 sigact[sig] = oldAct
(gdb) print sigact[sig].sa_handler → 期望: 与 oldAct.sa_handler 相同
(gdb) print sigismember(&sigs, sig) → 期望: 1 (man 3 sigismember)
```

### 断言 9: hotspot_sigmask — VMThread vs Java Thread 分叉 (os_linux.cpp:715)

```
(gdb) break os_linux.cpp:715
(gdb) continue
(gdb) print thread->is_VM_thread() → 期望: 取决于当前线程类型
(gdb) next → 经过 pthread_sigmask(SIG_UNBLOCK, unblocked_signals(), NULL) (man 3 pthread_sigmask)
(gdb) break os_linux.cpp:722
(gdb) continue
(gdb) print thread->is_VM_thread() → 期望: true（仅 VMThread 到达此断点）
(gdb) next → 经过 pthread_sigmask(SIG_UNBLOCK, vm_signals(), NULL)
(gdb) break os_linux.cpp:727
(gdb) continue
(gdb) print thread->is_VM_thread() → 期望: false（仅 Java Thread 到达此断点）
(gdb) next → 经过 pthread_sigmask(SIG_BLOCK, vm_signals(), NULL)
```

### 断言 10: SignalHandlerMark 构造/析构 (thread.hpp:2319/2322)

```
(gdb) break JVM_handle_linux_signal
(gdb) continue
# 触发信号（如 NPE），到达断点后:
(gdb) break thread.hpp:2319
(gdb) continue
(gdb) print _thread → 期望: 当前 Thread* (非 NULL)
(gdb) next → 经过 _thread->enter_signal_handler()
(gdb) print _thread->_in_signal_handler → 期望: 1 (已设置)
(gdb) break thread.hpp:2322
(gdb) continue
(gdb) print _thread → 期望: 即将清除标志
(gdb) next → 经过 _thread->leave_signal_handler()
(gdb) print _thread->_in_signal_handler → 期望: 0 (已清除)
```

## §四 交叉引用

| 目标 | 路径 | 内容 |
|------|------|------|
| **00-libjsig-interposition** | `docs/00-libjsig-interposition.md` | libjsig.so 三阶段协议状态机实现（`JVM_begin_signal_setting`, `JVM_end_signal_setting`, `JVM_get_signal_action` 的完整实现 + `sact[]` 拦截存储） |
| **02-signal-dispatch** | `docs/02-signal-dispatch.md` | 信号分派路径：`JVM_handle_linux_signal()` → `chained_handler()` → `call_chained_handler()` 如何消费本文安装的 `signalHandler` 及 `sigact[]` |
| **man 2 sigaction** | `man 2 sigaction` | 内核级信号处理器注册：`sigaction()` 系统调用的参数（`struct sigaction`, `SA_SIGINFO`, `SA_RESTART`, `SA_ONSTACK`）、返回值（0/`-1`）、错误码（`EINVAL`, `EFAULT`） |
| **man 3 dlsym** | `man 3 dlsym` | 动态符号查找：`RTLD_DEFAULT` 全局符号表搜索、`RTLD_NEXT` 当前库之后搜索、`dlerror()` 错误诊断 |
| **man 3 pthread_sigmask** | `man 3 pthread_sigmask` | 线程信号掩码管理：POSIX 线程安全替代 `sigprocmask` (man 2 sigprocmask)，`SIG_BLOCK`/`SIG_UNBLOCK`/`SIG_SETMASK` 三种操作模式 |
| **man 3 sigsetops** | `man 3 sigsetops` | 信号集操作：`sigemptyset`/`sigfillset`/`sigaddset`/`sigdelset`/`sigismember` — 构建 `sigset_t` 的标准 API |
| **man 5 proc** | `man 5 proc` | `/proc/PID/status` 文档：`SigCgt`/`SigBlk`/`SigIgn`/`SigPnd` 字段含义，用于无侵入式诊断 JVM 线程的信号掩码 |
| **man 7 signal** | `man 7 signal` | 信号概述：标准信号列表（SIGSEGV=11, SIGBUS=7, SIGFPE=8, SIGILL=4, SIGQUIT=3, SIGPIPE=13, SIGXFSZ=25）、默认动作、SIGKILL/SIGSTOP 不可覆盖规则 |

## §五 "不要写成→应该写成"对照表

| 不要写成 | 应该写成 |
|---------|---------|
| "signal_sets_init builds the signal sets" | "os_linux.cpp:594 `signal_sets_init()` populates two sigset_t: `unblocked_sigs` (SIGILL, SIGSEGV, SIGBUS, SIGFPE, SR_signum, ±SIGPIPE/SIGXFSZ if !ReduceSignalUsage) and `vm_sigs` (±BREAK_SIGNAL if !ReduceSignalUsage). Each set is built with `sigemptyset` + `sigaddset` calls (man 3 sigsetops). There are exactly two signal sets — no third category exists." |
| "set_signal_handler decides whether to install JVM's handler" | "os_linux.cpp:5329 `set_signal_handler(sig, set_installed)` reads pre-installed handler via `sigaction(sig, NULL, &oldAct)` (man 2 sigaction) at :5358. Three-way decision at :5366-5385: if `oldhand` is `SIG_DFL`/`SIG_IGN`/`signalHandler` → OVERWRITE (install `signalHandler`). If `AllowUserSignalHandlers||!set_installed` → SKIP. If `UseSignalChaining` → CHAIN (`save_preinstalled_handler` to `sigact[NSIG]` at os_posix.cpp:1718, then install `signalHandler`). Else → FATAL. The actual installation at :5400: `sigaction(sig, &sigAct, &oldAct)` where `sigAct.sa_sigaction=signalHandler` (defined at os_linux.cpp:5221), `sa_flags=SA_SIGINFO|SA_RESTART|SA_ONSTACK`, `sa_mask=sigfillset` (os_linux.cpp:5388-5395)." |
| "JVM uses SA_SIGINFO to get fault information" | "os_linux.cpp:5388-5395 `sigfillset(&(sigAct.sa_mask))` then `sigAct.sa_handler = SIG_DFL`, `sigAct.sa_sigaction = signalHandler` (:5221), `sa_flags = SA_SIGINFO | SA_RESTART | SA_ONSTACK`. `SA_SIGINFO` causes the kernel to provide `siginfo_t` with `si_addr` (faulting address), `si_code` (SEGV_MAPERR=unmapped vs SEGV_ACCERR=permission denied), and `si_pid` (sender PID). `SA_RESTART` auto-restarts interrupted syscalls. `SA_ONSTACK` ensures the handler runs on `sigaltstack` — critical for StackOverflow detection where the main stack is full. `sa_flags` stored to `sigflags[sig]` at :5398. All flag documentation: `man 2 sigaction`." |
| "Three flags control signal installation" | "globals.hpp:883 `ReduceSignalUsage` (default false) removes SIGPIPE/SIGXFSZ from `unblocked_sigs` and `vm_sigs`, skips their installation. globals.hpp:896 `AllowUserSignalHandlers` (default false) enables SKIP path in `set_signal_handler` — JVM defers to user-registered handlers. globals.hpp:900 `UseSignalChaining` (default true) enables CHAIN path: `save_preinstalled_handler` + libjsig integration. Priority: `ReduceSignalUsage` > `AllowUserSignalHandlers` > `UseSignalChaining`." |
| "hotspot_sigmask applies signal masks per thread" | "os_linux.cpp:704 `hotspot_sigmask(Thread*)` calls `pthread_sigmask` (man 3 pthread_sigmask) three times: save caller mask via SIG_BLOCK (:711), unblock `unblocked_sigs` via SIG_UNBLOCK (:715), then either unblock `vm_sigs` for VMThread (:722) or block `vm_sigs` for Java threads (:727). Called from `thread_native_entry()` (os_linux.cpp:~4815) before the thread enters Java code. This is the only entry point for per-thread signal mask application — `signal_sets_init()` (os_linux.cpp:594) only defines the sets, it doesn't apply them." |
| "SignalHandlerMark prevents recursion" | "thread.hpp:2313 `SignalHandlerMark` is a StackObj RAII helper. Constructor at :2319 calls `enter_signal_handler()` setting `_in_signal_handler` flag on the Thread. Destructor at :2322 calls `leave_signal_handler()` clearing the flag. Used in `JVM_handle_linux_signal()` (os_cpu/linux_x86/os_linux_x86.cpp) to ensure the unified `signalHandler` (os_linux.cpp:5221) doesn't re-enter the signal handler if a signal arrives during processing. RAII guarantees flag cleanup even through `longjmp` (crash protection)." |
