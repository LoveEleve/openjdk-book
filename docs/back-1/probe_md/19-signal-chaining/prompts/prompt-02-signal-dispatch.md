# PROMPT: 请撰写 02-signal-dispatch.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

`StackOverflowError not caught` at `java.lang.StackOverflowError` in production with hs_err showing wrong signal.

A recursive computation triggers stack overflow → SIGSEGV with `si_addr` near the stack guard page. The JVM's `JVM_handle_linux_signal()` at os_linux_x86.cpp:271 should detect this as StackOverflow (not NPE) and throw `StackOverflowError`. But in production, the error appears as:
```
# A fatal error has been detected by the Java Runtime Environment:
#  SIGSEGV (0xb) at pc=0x00007f..., pid=12345, tid=12346
# JRE version: OpenJDK Runtime Environment (11.0)
# Problematic frame: V [libjvm.so+0x...] JVM_handle_linux_signal+0x...
```

The hs_err log shows SIGSEGV was received but `JVM_handle_linux_signal` (:380-409) failed to classify it as stack overflow. The root cause: the application uses a custom thread with a non-standard stack size → `thread->on_local_stack(addr)` at :384 returns false → `in_stack_yellow_reserved_zone` (:386) fails → the signal proceeds past the stack overflow branch → eventually falls through to `chained_handler` at :632-636 → classified as "unknown SIGSEGV" → the JVM's crash handler terminates the process instead of throwing `StackOverflowError`.

**Fix**: Ensure custom threads use JVM-managed stack creation:
```java
// Wrong: custom thread without JVM stack guard
new Thread(null, task, "worker", 1024 * 1024).start();

// Correct: let JVM manage the stack
new Thread(task, "worker").start();
```

**三步诊断**（直接写进 §〇）：

```bash
# 1. 检查 hs_err 中的信号信息
grep -A 5 "SIGSEGV" hs_err_pid*.log
# 查看 siginfo: si_addr, si_code — 判断是 NPE (si_addr=0x0) 还是 StackOverflow (si_addr near stack)

# 2. 检查栈地址和 guard page — 断点设在 StackOverflow 检测入口
gdb -ex "break os_linux_x86.cpp:380" \
    -ex "run" \
    -ex "print info->si_addr" \
    -ex "print thread->on_local_stack(addr)" \
    -ex "print thread->in_stack_yellow_reserved_zone(addr)" \
    -ex "print thread->in_stack_red_zone(addr)" \
    --args java -cp app.jar com.example.Main

# 3. 检查信号识别树各分支断点
gdb -ex "break os_linux_x86.cpp:380" \
    -ex "break os_linux_x86.cpp:457" \
    -ex "break os_linux_x86.cpp:470" \
    -ex "break os_linux_x86.cpp:460" \
    -ex "run" \
    -ex "print sig" \
    -ex "print info->si_signo" \
    --args java -cp app.jar com.example.Main
```

**反事实**：如果 JVM 对所有 SIGSEGV 统一抛出 NullPointerException → StackOverflow 被误诊为 NPE → 开发者检查代码中的 null 引用 → 找不到 null → 花费数小时在错误的方向上调试。更糟的是：如果 StackOverflow 触发了 NPE handler → NPE handler 尝试分配异常对象 → 又触发 StackOverflow → 再次 SIGSEGV → 信号重入 → 进程被内核终止 → 无 hs_err 日志 → 生产环境黑盒。信号识别树（SIGSEGV→NPE/StackOverflow/Safepoint, SIGBUS→InternalError/Unsafe, SIGFPE→ArithmeticException）的价值在于精确诊断——将原始 OS 信号映射为有意义的 Java 异常。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the JVM's signal dispatch path — from `signalHandler()` (the thin C++ wrapper at os_linux.cpp:5221-5226) through `JVM_handle_linux_signal()` (the signal identification tree at os_linux_x86.cpp:271-660) to `chained_handler()` (the orchestrator at os_linux.cpp:5301-5312 that uses `get_chained_signal_action` :5240-5253 and `call_chained_handler` :5255-5299 to invoke third-party handlers). This is NOT a tutorial on "what signals mean" — it's ENGINEERING documentation on HOW the JVM classifies incoming signals, HOW it maps OS signals to Java exceptions, and HOW it chains to third-party handlers when the signal is not the JVM's responsibility.

Reader completed **15-core-native** (native method implementation patterns), **09-native-interface** (JNI_ENTRY/JVM_ENTRY macros), **00-libjsig-interposition** (libjsig.so 拦截层, sact[] chain) and **01-signal-installation** (JVM signal handler installation, three-way decision). This doc: **how the installed signalHandler processes signals when they arrive** — the runtime dispatch path that connects signal reception to Java exception throwing or third-party handler invocation.

### Interview Story Format Answer（必须出现在 §一 末尾）

"When a signal arrives at a JVM process, the kernel invokes the function registered by sigaction — which is `signalHandler()` at os_linux.cpp:5221. This is a `static` C++ function, but it is NOT a C++ member function — there's no implicit `this` pointer — which makes it compatible with the kernel's plain function pointer expectation from `sigaction.sa_sigaction`. `signalHandler` is a thin wrapper (only 6 lines, :5221-5226): it asserts `info != NULL && uc != NULL`, saves errno, delegates entirely to `JVM_handle_linux_signal(sig, info, uc, true)` at os_linux_x86.cpp:271, then restores errno.

`JVM_handle_linux_signal` is where ALL the dispatch logic lives — a cascade of checks that classify the signal:

1. **Setup** (:294-300): `Thread* t = Thread::current_or_null_safe()` (:294), `ThreadCrashProtection::check_crash_protection(sig, t)` (:298), `SignalHandlerMark shm(t)` for reentry protection (:300).
2. **SIGPIPE/SIGXFSZ fast path** (:309-311): immediately calls `chained_handler` and returns true — these are normal I/O errors in Java context.
3. **StackOverflow detection** (:380-409): for SIGSEGV, checks `thread->on_local_stack(addr)` (:384), then `in_stack_yellow_reserved_zone` / `in_stack_reserved_zone` / `in_stack_red_zone` (:386). If any zone matches → `disable_stack_yellow_reserved_zone` + STACK_OVERFLOW stub dispatch (:409).
4. **In-Java branch** (:453): enters when `thread->thread_state() == _thread_in_Java`.
   - SIGSEGV at safepoint poll address → Safepoint stub (:457)
   - SIGBUS with `has_unsafe_access` → `handle_unsafe_access` (:460)
   - SIGSEGV needing explicit null check → IMPLICIT_NULL stub (:470)
5. **SIGFPE** (:474): `FPE_INTDIV` / `FPE_FLTDIV` → ArithmeticException.
6. **JNI_FastGetField trap** (:527), **memory serialize page** (:539), **stub dispatch** (:622-629).
7. **chained_handler fallback** (:632-636): when JVM can't handle the signal, calls `chained_handler` which works through `get_chained_signal_action` — (1) `(*get_signal_action)(sig)` → libjsig's sact[] (:5243-5245), (2) `os::Posix::get_preinstalled_handler(sig)` → JVM's sigact[] fallback (:5249). Then `call_chained_handler` (:5288-5291) invokes with signal mask management.
8. **Final failure** (:638-660): signal not handled by JVM or any chained handler → crash."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **signalHandler — 薄包装器而非复杂逻辑**: `signalHandler()` at os_linux.cpp:5221-5226 is only 6 lines long. It asserts `info != NULL && uc != NULL`, saves/restores errno, and delegates entirely to `JVM_handle_linux_signal(sig, info, uc, true)` at os_linux_x86.cpp:271. It is NOT where the identification logic lives — that's inside `JVM_handle_linux_signal`. The function is `static` (not `extern "C"`) but it's a free function (not a member function), which makes it compatible with the kernel's function pointer expectation. Source: os_linux.cpp:5221-5226.

2. **SignalHandlerMark — RAII 守卫在 JVM_handle_linux_signal 内部**: `SignalHandlerMark` is set inside `JVM_handle_linux_signal` at os_linux_x86.cpp:300 — NOT in `signalHandler`. Constructor at thread.hpp:2316 increments `_num_nested_signal++` on the current Thread, destructor at :2321 decrements. This provides reentry detection at the Thread level (not OSThread level). Source: `src/hotspot/share/runtime/thread.hpp:2313-2325`.

3. **信号识别树 — 实际执行顺序**: `JVM_handle_linux_signal()` at os_linux_x86.cpp:271 does NOT use a simple switch-case. The checks are interleaved with thread-state guards: (1) SIGPIPE/SIGXFSZ → chained first (:309), (2) SIGSEGV → StackOverflow via `on_local_stack` + zone checks (:380-409), (3) In thread_in_Java: safepoint poll (:457), unsafe SIGBUS (:460), NPE implicit null check (:470), (4) SIGFPE (:474). The key insight: StackOverflow check (:380) comes BEFORE safepoint/NPE (:457/:470) because it uses `on_local_stack` which depends only on the thread's stack geometry, not on the thread state.

4. **si_addr 的多重语义**: `siginfo_t.si_addr` 的含义取决于信号类型和 `si_code`。对于 SIGSEGV (SEGV_MAPERR): si_addr 是访问的无效地址——0x0 表示 NPE，非零地址可能是 StackOverflow 或其他内存访问错误。对于 SIGBUS (BUS_ADRERR): si_addr 是导致总线错误的物理地址——可能与 Unsafe 内存访问相关。对于 SIGFPE: si_addr 是导致异常的指令地址（不是数据地址）。理解 si_addr 的上下文相关语义是正确分类信号的关键。Source: `man 2 sigaction` 的 siginfo_t 文档。

5. **chained_handler 三层架构**: 分派链式处理器不是单一函数，而是三层协作：(1) `chained_handler()` (:5301-5312) — 总调度器，检查 `UseSignalChaining` 标志；(2) `get_chained_signal_action()` (:5240-5253) — 两层查询：(a) `(*get_signal_action)(sig)` → libjsig sact[]， (b) `os::Posix::get_preinstalled_handler(sig)` → JVM sigact[]；(3) `call_chained_handler()` (:5255-5299) — 实际调用处理器，处理 SA_NODEFER/SA_RESETHAND 标志、信号掩码管理、通过 SA_SIGINFO 区分 sa_sigaction/sa_handler。

6. **信号上下文 (ucontext_t)**: 信号处理器的第三个参数 `void *uc` (在 JVM_handle_linux_signal 签名中为 `void *ucVoid`) 包含信号发生时 CPU 的完整状态——寄存器值（包括 PC、SP、BP）、信号掩码和栈信息。JVM 用 `uc->uc_mcontext.gregs[REG_PC]` 获取崩溃时的指令地址（写入 hs_err 的 Problematic frame），用 `uc->uc_mcontext.gregs[REG_SP]` 验证栈地址。这个结构体是机器相关的——x86_64 和 aarch64 的 `gregs` 数组索引不同。Source: `man 2 sigaction`, `man 3 ucontext`。

7. **信号处理中的异常抛出 — Stub 分派而非直接 throw**: JVM 的信号处理器不是"返回异常对象"——它通过 stub 分派机制间接抛异常。例如 `JVM_handle_linux_signal` :409 调用 `disable_stack_yellow_reserved_zone` + STACK_OVERFLOW stub → stub 代码在 safepoint 安全的上下文中设置 pending exception → 信号处理器正常返回 → 内核恢复被中断的代码 → 下一次 safepoint 检查或方法返回时，异常投递到 Java 代码。`SignalHandlerMark` 析构恰好在 JVM_handle_linux_signal 返回前，保证信号处理标记在异常投递前已清除。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/os/linux/os_linux.cpp` — `signalHandler` (`:5221-5226`), `get_chained_signal_action` (`:5240-5253`), `call_chained_handler` (`:5255-5299`), `chained_handler` (`:5301-5312`)
- `src/hotspot/os_cpu/linux_x86/os_linux_x86.cpp` — `JVM_handle_linux_signal` (`:271-660`)
- `src/hotspot/share/runtime/thread.hpp` — `SignalHandlerMark` (`:2313-2325`), `_num_nested_signal` field
- `src/hotspot/share/runtime/osThread.hpp` — OSThread 信号状态字段（`_current_signal` 等）
- `src/java.base/unix/native/libjsig/jsig.c` — `get_signal_action` 函数指针目标, `sact[]` 数组
- `src/hotspot/os/linux/os_linux.cpp` — `sigact[]` 数组（通过 `os::Posix::get_preinstalled_handler` 访问）
- `src/hotspot/share/runtime/globals.hpp:883` — `ReduceSignalUsage` flag
- `src/hotspot/share/runtime/globals.hpp:896` — `AllowUserSignalHandlers` flag
- `src/hotspot/share/runtime/globals.hpp:900` — `UseSignalChaining` flag (used at os_linux.cpp:5304)

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so`

Syscall 速查表:

| Syscall | man | 用途 |
|---------|-----|------|
| sigaction | `man 2 sigaction` | 信号处理器注册（安装侧）|
| sigreturn | `man 2 sigreturn` | 信号处理器返回时内核恢复上下文 |
| rt_sigaction | `man 2 sigaction` | Linux 实际使用的 sigaction 实现 |
| pthread_sigmask | `man 3 pthread_sigmask` | 信号掩码管理（call_chained_handler :5284-5285, :5295）|

信号信息结构体:

| 结构体 | man | 内容 |
|--------|-----|------|
| siginfo_t | `man 2 sigaction` | si_signo, si_code, si_addr, si_pid |
| ucontext_t | `man 3 ucontext` | uc_mcontext (寄存器), uc_stack, uc_sigmask |
| struct sigaction | `man 2 sigaction` | sa_handler/sa_sigaction, sa_mask, sa_flags |

全局状态表:

| 变量 | 类型 | 位置 | 作用 |
|------|------|------|------|
| `sigact[]` | `static struct sigaction[]` | os_linux.cpp | JVM 侧 pre-installed 处理器后备存储 |
| `libjsig_is_loaded` | `bool` | os_linux.cpp | 控制 get_chained_signal_action 是否查 libjsig (:5243) |
| `get_signal_action` | `real_sigaction_t* (*)(int)` | os_linux.cpp | libjsig 函数指针，指向 jsig.c sact[] 查询 |
| `_num_nested_signal` | `int` | thread.hpp | 信号嵌套计数（SignalHandlerMark RAII 管理）|

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **os_linux.cpp** | `src/hotspot/os/linux/os_linux.cpp` | ~7500 | `signalHandler`(:5221-5226) — 薄包装，save/restore errno; `get_chained_signal_action`(:5240-5253) — libjsig sact[] → sigact[] 两层查询; `call_chained_handler`(:5255-5299) — 调用链式处理器 + 掩码管理; `chained_handler`(:5301-5312) — UseSignalChaining 守卫的总调度器 | 🔥 信号入口 + 三层链式回退架构 |
| 2 | **os_linux_x86.cpp** | `src/hotspot/os_cpu/linux_x86/os_linux_x86.cpp` | ~1000 | `JVM_handle_linux_signal`(:271-660) — 信号识别树 (SETUP→SIGPIPE/XFSZ→StackOverflow→In-Java分支→SIGFPE→stubs→chain→failure) | 🔥 核心 — 全部分类与 stub 分派 |
| 3 | **thread.hpp** | `src/hotspot/share/runtime/thread.hpp` | ~3000 | `SignalHandlerMark`(:2313-2325) — RAII 守卫, `_num_nested_signal++` / `_num_nested_signal--` | 线程级信号嵌套检测 |
| 4 | **osThread.hpp** | `src/hotspot/share/runtime/osThread.hpp` | ~300 | `_current_signal`, `_current_siginfo` | OSThread 信号状态字段 |
| 5 | **jsig.c** | `src/java.base/unix/native/libjsig/jsig.c` | 342 | `sact[]` — libjsig 链式处理器存储（被 `(*get_signal_action)(sig)` 查询） | chained_handler 的第一层回退 |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ signalHandler — 薄包装入口

```
问题：
  ① signalHandler() (os_linux.cpp:5221-5226) 在信号到达时做了什么？
      答案方向: os_linux.cpp:5221-5226 signalHandler():
        static void signalHandler(int sig, siginfo_t* info, void* uc) {
          assert(info != NULL && uc != NULL);     // :5222
          int orig_errno = errno;                 // :5223
          JVM_handle_linux_signal(sig, info, uc, true);  // :5224
          errno = orig_errno;                     // :5225
        }
      
      这是全部 6 行代码。signalHandler 只是保存/恢复 errno 的薄包装。
      errno 保存的原因是：JVM_handle_linux_signal 内部可能调用任何
      C 库函数 → 可能覆盖 errno → 信号到达时被中断代码的 errno 会被
      破坏 → 保存/恢复确保被中断代码在信号返回后看到正确的 errno。
      
      追问: signalHandler 为什么是 static 函数而非 extern "C"？
      → static 限制作用域到 os_linux.cpp 编译单元。extern "C" 用于
        JVM_handle_linux_signal 的前向声明 (:5216-5219)，因为它是
        extern "C" JNIEXPORT 函数。signalHandler 不需要外部可见性——
        它只作为函数指针传递给 sigaction，不需要符号导出。
        而且 static 允许编译器内联优化。

  ② Counterfactual: 如果 signalHandler 包含全部业务逻辑（不拆分）？
      答案方向: 全部 ~400 行逻辑挤在一个函数 → 无法共享执行上下文
      → 错误处理代码重复 → 调试时栈帧更深。当前设计将逻辑集中在
      JVM_handle_linux_signal 中 → signalHandler 只是透明代理 →
      平台相关代码（os_linux_x86.cpp）和平台无关代码（os_linux.cpp）
      分离清晰。而且 JVM_handle_linux_signal 可以被其他上下文调用
      （如测试框架），不限于信号投递路径。
```

### 4.2 ★★★ JVM_handle_linux_signal 信号识别树 — SIGSEGV 分支

```
问题：
  ① JVM_handle_linux_signal() (os_linux_x86.cpp:271) 如何区分 StackOverflow、Safepoint 和 NPE？
      答案方向: os_linux_x86.cpp:271-660 的实际执行顺序:
      
      SETUP 阶段 (:294-300):
        Thread* t = Thread::current_or_null_safe();         // :294
        ThreadCrashProtection::check_crash_protection(sig, t); // :298
        SignalHandlerMark shm(t);                           // :300 RAII
        
      FAST PATH — SIGPIPE / SIGXFSZ (:309-311):
        if (sig == SIGPIPE || sig == SIGXFSZ) {
          chained_handler(sig, info, ucVoid);  // :311 → os_linux.cpp:5301
          return true;
        }
      
      STACK OVERFLOW (:380-409) — 最先检查:
        if (sig == SIGSEGV) {
          if (thread->on_local_stack(addr)) {          // :384
            if (thread->in_stack_yellow_reserved_zone(addr)) {  // :386
              disable_stack_yellow_reserved_zone(thread);       // :409
              // dispatch STACK_OVERFLOW stub
            } else if (thread->in_stack_reserved_zone(addr)) {  // :386
              // fatal error — reserved zone exhausted
            } else if (thread->in_stack_red_zone(addr)) {       // :386
              // fatal error — red zone violated
            }
          }
        }
      
      THREAD_IN_JAVA 分支 (:453+):
        if (thread->thread_state() == _thread_in_Java) {
          if (sig == SIGSEGV && is_poll_address(addr)) {  // :457
            // Safepoint stub — thread state transition
          }
          if (sig == SIGBUS && thread->has_unsafe_access()) { // :460
            handle_unsafe_access();  // MappedByteBuffer SIGBUS
          }
          if (sig == SIGSEGV && needs_explicit_null_check(...)) { // :470
            // IMPLICIT_NULL stub — NullPointerException
          }
        }
      
      注意：StackOverflow (:380) 检查在 safepoint (:457) 和 NPE (:470) 之前！
      
      追问: 为什么 StackOverflow 检查优先于 safepoint 和 NPE？
      → StackOverflow 使用 `thread->on_local_stack(addr)` (:384) 判定，
        这不需要线程处于 thread_in_Java 状态。而 safepoint 和 NPE 检查
        (:457, :470) 都在 `thread_state == _thread_in_Java` 门内——
        它们需要线程在 Java 代码中执行才有意义（safepoint 轮询页只在
        Java 方法中使用，隐式 null 检查只在 JIT 编译的 Java 代码中）。
        StackOverflow 可以发生在任何线程状态（包括 VM 操作），所以
        必须先检查。

  ② Counterfactual: 如果 StackOverflow 检查在 safepoint 之后？
      答案方向: 栈溢出发生在 VM 操作中（例如 GC 需要一些栈空间）→
      thread_state 不是 _thread_in_Java → 跳过 safepoint/NPE 检查
      (:453 门) → 也跳过 StackOverflow 检查（如果它在 :453 之后）→
      信号无法被识别 → chained_handler 也没有对应的处理器 → 
      进程 crash 而不是恢复。StackOverflow 的无条件位置确保它捕获
      所有线程状态下的栈溢出。
```

### 4.3 ★★★ JVM_handle_linux_signal — SIGBUS / SIGFPE / Stub 分派

```
问题：
  ① JVM_handle_linux_signal 如何处理 SIGBUS (:460) 和 SIGFPE (:474)？
      答案方向: os_linux_x86.cpp:
      
      SIGBUS 分支 (:460，在 thread_in_Java 门内):
        if (sig == SIGBUS && thread->has_unsafe_access()) {
          handle_unsafe_access();  
          // → InternalError: "a fault occurred in an unsafe memory access"
          return true;
        }
      注意：函数名是 `has_unsafe_access()` (不是 `doing_unsafe_access()`)。
      thread_in_Java 门 (:453) 是前提——只有 Java 线程执行 JIT 编译的
      Unsafe 代码时才尝试处理 SIGBUS。
      
      SIGFPE 分支 (:474+):
        if (sig == SIGFPE) {
          // AMD64: FPE_INTDIV (整数除零) → ArithmeticException
          // AMD64: FPE_FLTDIV (浮点除零) → ArithmeticException
          return true;
        }
      
      Stub 分派 (:622-629):
        // 上述各分支不直接抛异常——
        // 都通过 shared runtime stubs 分派
        // STACK_OVERFLOW stub, IMPLICIT_NULL stub, Safepoint stub
        // stub 代码在安全上下文中设置 pending exception
      
      chained_handler 回退 (:632-636):
        // JVM 无法处理的信号 → 尝试链式处理器
        if (chained_handler(sig, info, ucVoid)) {
          return true;  // 第三方处理器已处理
        }
      
      Final failure (:638-660):
        // 信号未被任何处理器处理 → crash + hs_err dump
      
      追问: 为什么 SIGBUS 只在 thread_in_Java 中处理？
      → SIGBUS 可能来自多种源：(1) JIT 编译的 Unsafe 代码 → 可恢复；
        (2) GC 访问损坏的堆外内存 → 不可恢复；(3) JVM 内部的 SIGBUS → 
        不可恢复。thread_in_Java 门确保只在可恢复场景（Java 代码执行
        Unsafe 操作）中处理，其他场景自然 fall through → chained_handler
        → crash，符合 crash-fast 原则。

  ② Counterfactual: 如果在所有线程状态都处理 SIGBUS？
      答案方向: GC 线程（thread_state != _thread_in_Java）的 SIGBUS
      被"处理"→ InternalError 被设置 → JVM 继续运行 → GC 数据结构
      已损坏 → 后续 GC 周期 crash 在不可预测的位置 → hs_err 指向
      错误的根因。crash-fast 在第一个故障点停止，保留准确的根因信息。
```

### 4.4 ★★★ chained_handler 三层架构

```
问题：
  ① chained_handler() (os_linux.cpp:5301-5312) 的完整架构是什么？
      答案方向: 
      
      [第一层] chained_handler — 总调度器 (:5301-5312):
        bool os::Linux::chained_handler(int sig, siginfo_t* siginfo, void* context) {
          bool chained = false;                          // :5302
          if (UseSignalChaining) {                       // :5304 — globals.hpp:900
            struct sigaction *actp = get_chained_signal_action(sig);  // :5305
            if (actp != NULL) {                          // :5306
              chained = call_chained_handler(actp, sig, siginfo, context);  // :5307
            }
          }
          return chained;                                // :5311
        }
      
      [第二层] get_chained_signal_action — 两层查询 (:5240-5253):
        struct sigaction *os::Linux::get_chained_signal_action(int sig) {
          struct sigaction *actp = NULL;                 // :5241
          if (libjsig_is_loaded) {                       // :5243
            actp = (*get_signal_action)(sig);            // :5245 → jsig.c sact[]
          }
          if (actp == NULL) {                            // :5247
            actp = os::Posix::get_preinstalled_handler(sig);  // :5249 → JVM sigact[]
          }
          return actp;                                    // :5252
        }
      
      [第三层] call_chained_handler — 实际调用 (:5255-5299):
        static bool call_chained_handler(struct sigaction* actp, int sig,
                                          siginfo_t *siginfo, void *context) {
          if (actp->sa_handler == SIG_DFL) return false;   // :5258
          else if (actp->sa_handler != SIG_IGN) {           // :5262
            // SA_NODEFER handling (:5263-5266)
            // extract sa_sigaction or sa_handler based on SA_SIGINFO (:5268-5276)
            // SA_RESETHAND — restore SIG_DFL if set (:5278-5280)
            sigemptyset(&oset);                              // :5283
            pthread_sigmask(SIG_SETMASK, &(actp->sa_mask), &oset);  // :5284-5285
            // call (*sa)(sig, siginfo, context) or (*hand)(sig) (:5288-5291)
            pthread_sigmask(SIG_SETMASK, &oset, NULL);       // :5295 restore
          }
          return true;                                       // :5298
        }

      追问: 为什么 call_chained_handler 需要管理信号掩码？
      → actp->sa_mask 包含链式处理器期望被阻塞的信号集合。调用前必须
        用 pthread_sigmask 设置 (:5284-5285)，调用后恢复 (:5295)。
        如果不设置 → 嵌套信号可能中断链式处理器 → 处理器可能不是
        可重入的 → 数据损坏或死锁。

  ② Counterfactual: 如果只有一层查询（只用 libjsig，没有 sigact[] fallback）？
      答案方向: libjsig 未 preload → libjsig_is_loaded==false →
      get_signal_action == NULL → 所有非 JVM 信号都无法被链式处理 →
      SIGALRM/SIGUSR1/SIGUSR2 等第三方信号直接 crash → 破坏了
      set_signal_handler CHAIN 路径的承诺（"如果 JVM 不处理，原处理器
      会被调用"）。两层设计确保无论 libjsig 是否加载，pre-installed
      处理器都能工作。
```

### 4.5 ★★★ SignalHandlerMark — 信号嵌套检测

```
问题：
  ① SignalHandlerMark 如何检测信号嵌套？
      答案方向: thread.hpp:2313-2325 SignalHandlerMark:
        class SignalHandlerMark: public StackObj {
          Thread* _thread;                               // :2314
         public:
          SignalHandlerMark(Thread* t) {                 // :2316
            _thread = t;
            if (_thread) {
              _thread->set_num_nested_signal(
                _thread->num_nested_signal() + 1);       // _num_nested_signal++
            }
          }
          ~SignalHandlerMark() {                         // :2321
            if (_thread) {
              _thread->set_num_nested_signal(
                _thread->num_nested_signal() - 1);       // _num_nested_signal--
            }
          }
        };
      
      注意：这是 thread.hpp:2313–2325，使用 Thread 级别的 `_num_nested_signal`
      计数器（不是 OSThread 的 `_handling_signal` bool）。追踪方式是
      递增/递减计数器，不是 set/clear 标志。这使得它可以处理多层嵌套
      (例如信号处理器中触发 safepoint → 又触发信号)。
      
      追问: 为什么用计数器而非 bool？
      → bool 只能表示"在信号中/不在信号中"两层。计数器支持多层嵌套：
        (1) SIGSEGV → SignalHandlerMark 计数=1 → 处理中触发 SIGBUS 
        → SignalHandlerMark 计数=2 → SIGBUS 处理完 计数=1 → 
        SIGSEGV 处理完 计数=0。这使嵌套检测更精确——
        可以区分"单层信号处理"和"递归信号"。

  ② Counterfactual: 如果不追踪嵌套计数？
      答案方向: 无法区分"第一次进入信号处理器"和"在信号处理器中再次
      触发信号"→ 错误地跳过异常抛出（以为重入了）→ 合法信号未被
      处理 → 进程 crash。或者反过来：在真正重入时尝试抛异常 → 
      在信号栈上分配异常对象 → 触发 GC → 死锁。
```

### 4.6 ★★★ 信号上下文中抛出 Java 异常的机制 — Stub 分派

```
问题：
  ① JVM_handle_linux_signal 为什么不直接创建异常对象，而是使用 stub 分派？
      答案方向: 信号处理器运行在受限上下文中：
        - 可能在 sigaltstack 上执行（SA_ONSTACK 设置后）
        - 部分信号被阻塞（由 sa_mask 控制）
        - 可能不在 safepoint 中（其他线程可能在 GC）
        
        JVM_handle_linux_signal 不直接创建 Java 异常对象，而是：
        1. 分类信号（StackOverflow/NPE/Safepoint 等）
        2. 分派到对应的 shared runtime stub (:622-629)
        3. Stub 代码在安全的上下文中：
           - 确保线程在 safepoint
           - 创建异常对象（可安全分配）
           - 设置 pending exception 到线程
        4. JVM_handle_linux_signal 返回 true → signalHandler 返回
        5. 内核恢复被中断的代码 → 在下一个 safepoint 检查点或
           方法返回时，pending exception 投递到 Java 代码
        
        这比 pending exception 更安全——stub 代码可以访问完整的
        JVM 基础设施（GC、锁、类加载），而信号处理器不能。
      
      追问: 为什么 stub 可以而信号处理器不可以？
      → Stub 代码运行在正常的 Java 线程上下文中（不是信号栈），
        信号已被解除阻塞，线程可以在 safepoint 中。Stub 生成代码
        （在 compiler 中定义）知道所有寄存器保存/恢复约定——
        它完整地从信号上下文恢复执行状态，然后才抛出异常。

  ② Counterfactual: 如果直接在信号处理器中 new NullPointerException？
      答案方向: new 触发 GC（TLAB 分配不足时）→ GC 需要 safepoint
      → 当前线程在信号处理器中，可能不在 safepoint → 死锁。
      即使 TLAB 足够（不需要 GC），信号处理器运行在 sigaltstack
      上 → 异常对象的句柄可能在信号处理器返回后变得无效。
      Stub 方案虽然延迟稍高，但保证了正确性。
```

### 4.7 ★★★ 信号默认行为回退 — 不存在的 "chained_handler_default_action"

```
问题：
  ① 当 chained_handler 返回 false（无链式处理器）时，JVM_handle_linux_signal 如何处理？
      答案方向: os_linux_x86.cpp:638-660 final failure 路径:
        — 不调用任何单独的 "chained_handler_default_action" 函数
        — 直接在 final failure path (:638-660) 中:
          1. 打印致命错误信息
          2. 生成 hs_err 核心转储
          3. os::abort() 或直接 crash
        chained_handler 返回值 (:5311) 只是告诉调用者是否有处理器
        被调用。如果 false，调用者 (JVM_handle_linux_signal :632-636)
        继续执行到 final failure 路径。
        
      注意：不存在独立的 `chained_handler_default_action` 函数。
      信号默认行为（SIG_DFL）从未被重新安装——JVM 直接 crash。
      JVM 不会重新发送信号给内核做默认处理。
      
      追问: 为什么不重新安装 SIG_DFL 并 re-raise？
      → 重新发送信号可能：(1) 覆盖 JVM 已有的 crash 信息（hs_err），
        (2) 产生重复的 core dump，(3) 信号可能被重新安装的处理器
        再次捕获（竞态条件）。直接 crash 确保 JVM 控制崩溃信息
        的完整性和准确性。

  ② Counterfactual: 如果重新安装 SIG_DFL 并 kill(getpid(), sig)？
      答案方向: sigaction(SIG_DFL) + kill(getpid(), sig) 后：
        内核投递信号 → SIG_DFL 处理 → 产生 core dump → 但 core dump
        的上下文是 signalHandler 返回后，不是原始故障点 → si_addr
        等 siginfo 已被修改 → 事后分析失去原始故障信息。JVM 选择
        在 JVM_handle_linux_signal 内直接 crash —— 在故障现场
        生成精确的 hs_err，包含原始 siginfo 和线程状态。
```

### 4.8 ★★★ 信号处理与线程状态 — Safepoint 轮询

```
问题：
  ① JVM 的 safepoint 轮询为何使用 SIGSEGV 而非显式检查？
      答案方向: os_linux_x86.cpp:457:
        if (sig == SIGSEGV && is_poll_address(addr)) {
          // Safepoint stub — thread state transition
        }
      
      机制: 每个 Java 线程周期性读取一个保留内存页地址。
      正常路径: 页可读 → 读取成功 → 零开销（~0.5ns 本地 cache 读取）
      Safepoint 需要时: JVM 修改该页保护 → 读取触发 SIGSEGV →
      signalHandler → JVM_handle_linux_signal → :457 检测到
      poll address → Safepoint stub → 线程进入安全状态。
      
      追问: 为什么不用原子标志？
      → 每次方法返回都检查原子标志 → 每次 cache miss (标志在
        其他 CPU 上) → ~50ns → 每秒数十亿次 → 5-10% 吞吐量损失。
        内存保护页方案: 正常路径零开销——只在 safepoint 发生时
        付出信号处理代价。这是"让常见路径零开销"的经典优化。

  ② Counterfactual: 如果用条件变量 + 显式检查？
      答案方向: 每次方法返回时:
        if (SafepointSynchronize::is_synchronizing()) {
          SafepointSynchronize::block(thread);
        }
      这增加条件分支 + 内存读取到每个方法返回路径 → 微基准测试
      中可能 5-10% 吞吐量损失。信号方案将全部开销移到 safepoint
      发生时的少数线程上——牺牲 safepoint 延迟换取总吞吐量。
```

---

## §五 Article Structure

```
§〇 生产场景 — StackOverflowError not caught
  ★ 真实错误: 递归 → SIGSEGV near stack guard → JVM_handle_linux_signal :380-409 未识别 → crash
  ★ Root cause: 自定义线程栈 → on_local_stack(:384)/in_stack_*_zone(:386) 返回 false
  ★ 三步诊断: hs_err siginfo → GDB break :380 check zones → GDB break :457/:470 check other branches
  ★ 反事实: 所有 SIGSEGV 统一抛 NPE → StackOverflow 误诊

§一 ★★★ 信号分派全链路源码走读
  ❓ 这不是信号处理教程 — 这是 JVM 如何分类信号、映射异常、链式回退的工程文档
  1.1 os_linux.cpp:5221-5226 signalHandler — 薄包装入口 (6行), save/restore errno
  1.2 os_linux_x86.cpp:294-300 JVM_handle_linux_signal SETUP — Thread + CrashProtection + SignalHandlerMark
  1.3 os_linux_x86.cpp:309-311 SIGPIPE/SIGXFSZ fast path — chained_handler 先于识别树
  1.4 os_linux_x86.cpp:380-409 SIGSEGV StackOverflow — on_local_stack + yellow/red/reserved zone 检查
  1.5 os_linux_x86.cpp:453-470 thread_in_Java 分支 — Safepoint(:457) / SIGBUS(:460) / NPE(:470)
  1.6 os_linux_x86.cpp:474-539 SIGFPE + JNI_FastGetField + memory serialize page
  1.7 os_linux_x86.cpp:622-629 Stub 分派 — shared runtime stubs 安全上下文抛异常
  1.8 os_linux_x86.cpp:632-636 chained_handler fallback — JVM 无法处理时
  1.9 os_linux.cpp:5301-5312 chained_handler — UseSignalChaining 守卫的总调度器
  1.10 os_linux.cpp:5240-5253 get_chained_signal_action — (1)(*get_signal_action)(sig)→sact[] (2)get_preinstalled_handler→sigact[]
  1.11 os_linux.cpp:5255-5299 call_chained_handler — SA_NODEFER/SA_RESETHAND + 信号掩码管理 + sa_sigaction/sa_handler 调用
  1.12 thread.hpp:2313-2325 SignalHandlerMark — _num_nested_signal++/-- RAII 嵌套检测
  1.13 ★ Mermaid: 信号分派决策树 — 从内核投递到 stub 分派或链式回退
      Lanes: Kernel / signalHandler / JVM_setup / StackOverflow / thread_in_Java /
             Stub_dispatch / chained_handler / get_chained_action / call_chained
  1.14 ★ 面试 Story Format 答案 — 从 signalHandler 薄包装到 stub 分派的完整叙事

§二 ★★★ 7 Beginner Callout 框
  2.1 signalHandler — 薄包装器 (6行, :5221-5226)
  2.2 SignalHandlerMark — RAII 守卫在 JVM_handle_linux_signal 内部 (:300)
  2.3 信号识别树 — 实际执行顺序: StackOverflow(:380) → Safepoint(:457) → NPE(:470)
  2.4 si_addr 的多重语义
  2.5 chained_handler 三层架构 (chained_handler / get_chained_signal_action / call_chained_handler)
  2.6 信号上下文 (ucontext_t / ucVoid)
  2.7 信号处理中的 Stub 分派 — 不是直接抛异常

§三 ★★ 信号处理的安全性分析
  ❓ 信号处理器中可以安全做什么操作？
  ❓ 为什么不能直接调用 Java 代码？
  3.1 信号安全函数列表 — POSIX 异步信号安全函数
  3.2 JVM 的扩展安全操作 — pending exception 设置、Stub 分派
  3.3 信号重入的危险 — _num_nested_signal 计数器的检测和处理
  3.4 信号栈 vs 主栈 — SA_ONSTACK 的隔离保证

§四 ★ GDB 断点验证 — 7 断点完整信号分派 trace
  断言 1: os_linux.cpp:5221 signalHandler entry → verify sig, info, uc, errno
  断言 2: os_linux_x86.cpp:300 SignalHandlerMark 构造 → verify _num_nested_signal++
  断言 3: os_linux_x86.cpp:380 StackOverflow 检查 → verify on_local_stack/in_stack_*_zone
  断言 4: os_linux_x86.cpp:460 SIGBUS 检查 → verify has_unsafe_access
  断言 5: os_linux_x86.cpp:470 NPE 检查 → verify needs_explicit_null_check → IMPLICIT_NULL stub
  断言 6: os_linux.cpp:5301 chained_handler entry → verify UseSignalChaining
  断言 7: os_linux.cpp:5240 get_chained_signal_action entry → verify two-tier fallback (libjsig sact[] → sigact[])

§五 ★ Cross-Reference
  ❓ 00-libjsig-interposition — (*get_signal_action)(sig) 函数指针源 (jsig.c sact[])
  ❓ 01-signal-installation — signalHandler 的注册 + sigact[] 的填充 (os::Posix::get_preinstalled_handler)
  ❓ man 2 sigaction — siginfo_t 字段 (si_addr, si_code) 语义
  ❓ man 3 ucontext — uc_mcontext 寄存器访问
  ❓ man 3 pthread_sigmask — 信号掩码管理 (call_chained_handler :5284-5285, :5295)
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because stack overflow can occur in any thread state (including VM operations), `JVM_handle_linux_signal` checks `on_local_stack` at :384 before the `thread_in_Java` guard at :453..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C++ code from os_linux.cpp / os_linux_x86.cpp / thread.hpp, do not describe it. Every function discussed must have its actual source code shown with file:line annotation.

3. **Mermaid** — 信号分派决策树。5+ lanes: Kernel (signal delivery) / signalHandler (save errno, delegate) / JVM_handle_linux_signal SETUP (:294-300) / StackOverflow (:380-409) / thread_in_Java (:453-470) / Stub dispatcher (:622-629) / chained_handler (:632-636 → :5301) / get_chained_signal_action (:5240-5253) / call_chained_handler (:5255-5299) / Third-party Handler。完整流程：信号到达 → signalHandler → JVM_handle_linux_signal → 识别树 (SIGPIPE/XFSZ→chain first, SIGSEGV→StackOverflow→zone checks, thread_in_Java→Safepoint/NPE/SIGBUS, SIGFPE→ArithmeticException) → Stub 分派 或 chained_handler 三层回退。每步标注 file:line。

4. **GDB session** — 7 breakpoints with exact file:line numbers:
   - `os_linux.cpp:5221` signalHandler entry — verify sig, info->si_signo, info->si_addr, errno
   - `os_linux_x86.cpp:300` SignalHandlerMark constructor — verify _num_nested_signal increment
   - `os_linux_x86.cpp:380` StackOverflow check — verify on_local_stack, in_stack_*_zone results
   - `os_linux_x86.cpp:460` SIGBUS check — verify has_unsafe_access
   - `os_linux_x86.cpp:470` NPE check — verify needs_explicit_null_check → IMPLICIT_NULL stub
   - `os_linux.cpp:5301` chained_handler entry — verify UseSignalChaining flag
   - `os_linux.cpp:5240` get_chained_signal_action entry — verify libjsig_is_loaded, (*get_signal_action)(sig) vs get_preinstalled_handler fallback
   Each with expected variable values to verify.

5. **7 Beginner callout boxes** — exact text from §一: signalHandler 薄包装, SignalHandlerMark RAII, 信号识别树(实际执行顺序), si_addr 多重语义, chained_handler 三层架构, ucontext_t 上下文, Stub 分派(非直接抛异常).

6. **Cross-reference at three points**:
   - At `get_chained_signal_action` → "→ 00-libjsig-interposition for the sact[] storage and `(*get_signal_action)(sig)` query in jsig.c"
   - At `signalHandler` (the function registered in prompt-01) → "→ 01-signal-installation for how this function pointer was installed via sigaction"
   - At `siginfo_t` fields → "→ man 2 sigaction for the complete siginfo_t structure documentation (si_signo, si_code, si_addr, si_pid, etc.)"

7. **Story-format interview answer** — at §一末尾: 从信号到达内核到 Stub 分派的完整叙事。Four parts: "signalHandler thin wrapper (6 lines)" + "JVM_handle_linux_signal SETUP + SignalHandlerMark" + "Signal identification tree (StackOverflow→thread_in_Java→SIGFPE→stubs)" + "chained_handler three-layer fallback or Stub dispatch".

8. **"不要写成→应该写成"对照表**（必须出现在 §六 中）：

| 不要写成 | 应该写成 |
|---------|---------|
| "signalHandler handles incoming signals" | "os_linux.cpp:5221 `static void signalHandler(int sig, siginfo_t* info, void* uc)` — a thin 6-line wrapper (:5221-5226). Asserts `info != NULL && uc != NULL` (:5222), saves errno (:5223), delegates to `JVM_handle_linux_signal(sig, info, uc, true)` at os_linux_x86.cpp:271 (:5224), restores errno (:5225). No identification logic lives here — all work is in JVM_handle_linux_signal." |
| "JVM classifies SIGSEGV into NPE or StackOverflow" | "os_linux_x86.cpp:271 `JVM_handle_linux_signal()` runs a cascading check sequence, NOT a simple if-else tree. SETUP (:294-300): `Thread::current_or_null_safe()` → `ThreadCrashProtection::check_crash_protection(sig, t)` → `SignalHandlerMark shm(t)`. SIGPIPE/XFSZ (:309-311) → `chained_handler` first, return true. StackOverflow (:380-409): `thread->on_local_stack(addr)` (:384) → `in_stack_yellow_reserved_zone` / `in_stack_reserved_zone` / `in_stack_red_zone` (:386) → `disable_stack_yellow_reserved_zone` + STACK_OVERFLOW stub (:409). thread_in_Java gate (:453): safepoint `is_poll_address` (:457), SIGBUS `has_unsafe_access` (:460), NPE `needs_explicit_null_check` (:470). SIGFPE (:474). Stub dispatch (:622-629). chained_handler fallback (:632-636). Final failure (:638-660)." |
| "chained_handler calls third-party handlers" | "os_linux.cpp:5301 `chained_handler(sig, siginfo, context)` is the orchestrator: checks `UseSignalChaining` (:5304), calls `get_chained_signal_action(sig)` (:5305), then `call_chained_handler(actp, sig, siginfo, context)` (:5307). `get_chained_signal_action` (:5240-5253) has two-tier priority: (1) `(*get_signal_action)(sig)` → libjsig's sact[] (:5245, if `libjsig_is_loaded` :5243), (2) `os::Posix::get_preinstalled_handler(sig)` → JVM's sigact[] fallback (:5249). `call_chained_handler` (:5255-5299) handles SA_NODEFER (:5263-5266), SA_RESETHAND (:5278-5280), signal mask via `pthread_sigmask` (:5284-5285 setup, :5295 restore), and calls `(*sa_sigaction)(sig, siginfo, context)` or `(*sa_handler)(sig)` based on SA_SIGINFO (:5288-5291)." |
| "SignalHandlerMark prevents reentry" | "thread.hpp:2313 `SignalHandlerMark` constructor (:2316) calls `_num_nested_signal++`, destructor (:2321) calls `_num_nested_signal--`. This uses a Thread-level counter (not OSThread bool) to support multi-level nesting: a signal handler can be interrupted by another signal → counter goes 1→2→1, accurately tracking nesting depth. The counter is set inside `JVM_handle_linux_signal` at os_linux_x86.cpp:300 (NOT in `signalHandler`). It provides reentry detection and diagnostic info in hs_err logs." |

---

## §七 Output Format

- Markdown file, named `02-signal-dispatch.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/19-signal-chaining/docs/`
- 元信息头:

```
> **阶段**：[19-signal-chaining]
> **前置**：[00-libjsig-interposition]（libjsig 拦截层 — sact[] 链式处理器存储, `(*get_signal_action)(sig)` 函数指针源）、[01-signal-installation]（JVM 信号安装 — signalHandler 的注册和 sigact[] 的填充）
> **配套**：[00-libjsig-interposition]（get_chained_signal_action 的 libjsig 侧查询）、[01-signal-installation]（signalHandler 是在 01 中安装的处理器, get_preinstalled_handler 访问 01 填充的 sigact[]）
> **后续依赖本文**：无（本文是 Phase 19 的终端文档）
> **阅读收益**：追踪信号从内核投递到 Java 异常抛出的完整分派路径 — 理解 signalHandler 的薄包装入口 (6行, :5221-5226) + JVM_handle_linux_signal 的信号识别树 (SETUP→SIGPIPE/XFSZ→StackOverflow→thread_in_Java (Safepoint/NPE/SIGBUS)→SIGFPE→Stub分派→chain→failure) + SignalHandlerMark _num_nested_signal 嵌套计数 (:300) + chained_handler 三层架构 (总调度器:5301 / 两层查询:5240-5253 / 处理器调用:5255-5299) + safepoint 轮询使用内存保护而非显式检查的零开销优化
```

- 目标行数: 450+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "JVM handles signals" 而不展示分派路径的源码 — 必须从 signalHandler(:5221-5226) 到 JVM_handle_linux_signal(:271-660) 到 chained_handler(:5301-5312) 完整展示
- ❌ 不展示信号识别树的实际执行顺序 — 必须展示 SETUP→PIPE/XFSZ→StackOverflow(:380)→thread_in_Java(:453)→Safepoint(:457)→SIGBUS(:460)→NPE(:470)→SIGFPE(:474)→Stubs→Chain→Failure 的完整序列
- ❌ 不展示 chained_handler 的三层架构 — 必须展示 chained_handler(:5301) + get_chained_signal_action(:5240, 含 (*get_signal_action)(sig) vs get_preinstalled_handler) + call_chained_handler(:5255, 含 SA_NODEFER/SA_RESETHAND/pthread_sigmask)
- ❌ 不解释为什么信号处理器使用 Stub 分派而非直接抛 Java 异常 — 必须展示 stub 分派机制和安全限制
- ❌ 不解释 SignalHandlerMark 的 _num_nested_signal 计数器机制 — 必须展示 ++/-- 和嵌套深度追踪
- ❌ 不解释 safepoint 轮询为何使用 SIGSEGV — 必须展示 is_poll_address(:457) 和内存保护页 vs 显式条件检查的性能对比
- ❌ 不做 GDB 断点 trace — 至少 7 个断点覆盖 signalHandler → JVM_handle_linux_signal → get_chained_signal_action → chained_handler
- ❌ 不展示 call_chained_handler 的信号掩码管理 — 必须展示 pthread_sigmask(:5284-5285 + :5295) + SA_NODEFER(:5263-5266) + SA_RESETHAND(:5278-5280)
- ❌ 忽略 si_addr 的上下文相关语义 — 必须展示 si_addr 在 SIGSEGV/SIGBUS/SIGFPE 中的不同含义
- ❌ 不要解释 C 语言基础（函数指针、RAII 基础概念）— signalHandler 是 static 不是 extern "C"，SignalHandlerMark 用计数器不是 bool
- ❌ 不要说 "chained_handler_default_action" — 此函数不存在，JVM 在 JVM_handle_linux_signal :638-660 final failure 路径中直接 crash

---

## §九 Required（≥8）

- ✅ **★ Mermaid 信号分派决策树** — 5+ lanes: Kernel / signalHandler / JVM_setup / StackOverflow / thread_in_Java / Stub_dispatch / chained_handler / get_chained_action / call_chained — 信号到达 → Stub 分派或链式回退的完整决策树
- ✅ **★ signalHandler 源码展示** — os_linux.cpp:5221-5226 完整 6 行源码 + JVM_handle_linux_signal extern "C" 前向声明 (:5216-5219)
- ✅ **★ JVM_handle_linux_signal 完整识别序列源码** — SETUP(:294-300) → SIGPIPE/XFSZ(:309-311) → StackOverflow(:380-409) → thread_in_Java(:453-470) → SIGFPE(:474) → Stubs(:622-629) → Chain(:632-636) → Failure(:638-660)
- ✅ **★ chained_handler 三层架构源码** — chained_handler(:5301-5312) + get_chained_signal_action(:5240-5253) + call_chained_handler(:5255-5299)
- ✅ **★ 7 Beginner Callout 框** — exact text from §一
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事：信号到达 → signalHandler 薄包装 → JVM_handle_linux_signal SETUP + 识别树 → Stub 分派或链式回退
- ✅ **★ GDB 断点 ≥7 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ "不要写成→应该写成"对照表** — 4 行，覆盖 signalHandler 薄包装, JVM_handle_linux_signal 实际执行序列, chained_handler 三层架构, SignalHandlerMark 计数器
- ✅ **★ 交叉引用** — 00-libjsig-interposition (sact[], get_signal_action 函数指针), 01-signal-installation (signalHandler 安装, get_preinstalled_handler), man 2 sigaction (siginfo_t), man 3 ucontext, man 3 pthread_sigmask

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: signalHandler 入口 (os_linux.cpp:5221)
  (gdb) break os_linux.cpp:5221
  (gdb) run → 触发一个信号 (例如访问 null)
  (gdb) print sig → 期望: 11 (SIGSEGV)
  (gdb) print info->si_signo → 期望: 11
  (gdb) print info->si_code → 期望: 1 (SEGV_MAPERR)
  (gdb) print info->si_addr → 期望: 0x0 (NPE) 或非零地址
  (gdb) print uc → 期望: 非 NULL (ucontext_t)
  (gdb) print errno → 期望: 信号到达时的 errno 值

断言 2: SignalHandlerMark 构造 (os_linux_x86.cpp:300 — JVM_handle_linux_signal 内)
  (gdb) break os_linux_x86.cpp:300
  (gdb) continue
  (gdb) print t → 期望: 当前 Thread 指针 (可能 NULL)
  (gdb) next → 经过 SignalHandlerMark 构造
  (gdb) print t->num_nested_signal() → 期望: ≥1 (已递增)

断言 3: StackOverflow 检测 (os_linux_x86.cpp:380)
  (gdb) break os_linux_x86.cpp:380
  (gdb) continue → 触发栈溢出
  (gdb) print sig → 期望: 11 (SIGSEGV)
  (gdb) print info->si_addr → 期望: 接近栈保护页的地址
  (gdb) print thread → 期望: 当前 JavaThread 指针
  (gdb) next → 经过 on_local_stack 检查 (:384)
  (gdb) print thread->on_local_stack(addr) → 期望: true
  (gdb) next → 经过 zone 检查 (:386)
  (gdb) print thread->in_stack_yellow_reserved_zone(addr) → 期望: true

断言 4: SIGBUS 检测 (os_linux_x86.cpp:460 — thread_in_Java 门内)
  (gdb) break os_linux_x86.cpp:460
  (gdb) continue → 触发 MappedByteBuffer SIGBUS (在 Java 线程中执行 Unsafe)
  (gdb) print sig → 期望: 7 (SIGBUS)
  (gdb) print thread->thread_state() → 期望: _thread_in_Java
  (gdb) print thread->has_unsafe_access() → 期望: true (function name is has_unsafe_access)
  (gdb) next → 经过 handle_unsafe_access()
  (gdb) print thread->has_pending_exception() → 期望: true (InternalError)

断言 5: NPE 检测 (os_linux_x86.cpp:470 — thread_in_Java 门内)
  (gdb) break os_linux_x86.cpp:470
  (gdb) continue → 触发 null 指针访问 (在 JIT 编译的 Java 代码中)
  (gdb) print sig → 期望: 11 (SIGSEGV)
  (gdb) print info->si_addr → 期望: 0x0
  (gdb) print thread->thread_state() → 期望: _thread_in_Java
  (gdb) next → 经过 needs_explicit_null_check → IMPLICIT_NULL stub
  (gdb) print thread->has_pending_exception() → 期望: true (NullPointerException)

断言 6: chained_handler 入口 (os_linux.cpp:5301)
  (gdb) break os_linux.cpp:5301
  (gdb) continue → 触发 JVM 不处理的信号 (例如 SIGALRM 当 UseSignalChaining 为 true)
  (gdb) print sig → 期望: 信号编号
  (gdb) print UseSignalChaining → 期望: true (flag from globals.hpp:900, checked at :5304)
  (gdb) next → 经过 UseSignalChaining 检查 → 进入 get_chained_signal_action (:5305)

断言 7: get_chained_signal_action 两层查询 (os_linux.cpp:5240)
  (gdb) break os_linux.cpp:5240
  (gdb) continue
  (gdb) print sig → 期望: 信号编号
  (gdb) print libjsig_is_loaded → 期望: true 或 false
  (gdb) next → 如果 libjsig_is_loaded: 经过 (*get_signal_action)(sig) (:5245)
  (gdb) print actp → 期望: libjsig sact[] 返回的 sigaction* 或 NULL
  (gdb) next → 经过 actp==NULL 检查 (:5247)
  (gdb) next → 经过 os::Posix::get_preinstalled_handler(sig) (:5249)
  (gdb) print actp → 期望: JVM sigact[] 返回的 sigaction* 或 NULL
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §二.3 承接**：本文展开 README 规划的 "02-signal-dispatch.md — 信号分派与链式回退"，覆盖 signalHandler (6行薄包装) + JVM_handle_linux_signal (~400行识别树) + chained_handler 三层架构 (get_chained_signal_action + call_chained_handler) + SignalHandlerMark (_num_nested_signal 计数器)，聚焦信号发生后的运行时处理路径。

2. **同组边界**:
   - **00-libjsig-interposition** 覆盖 libjsig 侧的 sact[] 存储和 `get_signal_action` 函数指针实现 — 本文在 `get_chained_signal_action` (:5245) 中通过 `(*get_signal_action)(sig)` 调用
   - **01-signal-installation** 覆盖 `signalHandler` 的注册和 `sigact[]` 的填充 — 本文的 `signalHandler` 是 01 中安装的处理器，`os::Posix::get_preinstalled_handler(sig)` (:5249) 访问 01 中填充的 `sigact[]`

3. **全部文档共享 §一 开头语**: "Reader completed 15-core-native (native method implementation patterns), 09-native-interface (JNI_ENTRY/JVM_ENTRY macros), 00-libjsig-interposition (libjsig.so interception layer, sact[] chain) and 01-signal-installation (JVM signal handler installation, three-way decision). This doc: how the installed signalHandler processes signals when they arrive — the runtime dispatch path that connects signal reception to Java exception throwing or third-party handler invocation."

4. **跨文档引用**: 本文是 Phase 19 的终端文档 — 00 建立拦截层概念，01 展示安装流程，02 展示分派路径。阅读顺序建议: 00 (拦截层) → 01 (安装流程) → 02 (分派路径)。本文依赖 00 的 `(*get_signal_action)(sig)` 和 01 的 `signalHandler`/`sigact[]`。
