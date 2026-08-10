# PROMPT: 请撰写 00-libjsig-interposition.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

`SIGSEGV handler overwritten by native library` at `java.lang.NullPointerException`.

An agent library loaded via `-agentpath` calls `sigaction(SIGSEGV, &my_handler, NULL)` in its `Agent_OnLoad`. JVM had previously installed its own `SIGSEGV` handler for NullPointerException detection, safepoint polling, and stack overflow checking. The agent's `sigaction` silently overwrites the kernel-level signal handler — the JVM's handler is gone. Next NPE triggers the agent's handler instead of JVM's → agent handler doesn't understand the JVM's internal signal protocols → crashes with `SIGABRT` from the JVM's crash handler when it detects corrupted state.

**Fix**: Preload `libjsig.so` via `LD_PRELOAD`:
```bash
export LD_PRELOAD=$JAVA_HOME/lib/server/libjsig.so:$LD_PRELOAD
java -agentpath:myagent.so com.example.Main
```

With libjsig interposed, the agent's `sigaction(SIGSEGV, ...)` calls `libjsig::sigaction()`, not `libc::sigaction()`. Since `jvm_signal_installed=true` and `SIGSEGV` is in `jvmsigs` (Phase 3), libjsig stores the agent's handler in `sact[SIGSEGV]` without touching the kernel. When `SIGSEGV` arrives, JVM's handler runs first; if JVM decides the signal is not its responsibility, it calls `JVM_get_signal_action(SIGSEGV)` at jsig.c:335 → returns `&sact[SIGSEGV]` → JVM's chained_handler invokes the third-party handler. The JVM handler and agent handler coexist — the agent's `sigaction` call is transparently intercepted and re-routed.

**三步诊断**（直接写进 §〇）：

```bash
# 1. 确认 libjsig 是否被加载
LD_DEBUG=bindings java -version 2>&1 | grep jsig
# 期望输出: binding file libjsig.so [0] to libjsig.so [0]: normal symbol `sigaction'
# 如果无输出 → libjsig 未 preload → sigaction 未被拦截

# 2. 确认信号处理器未被覆盖（sigaction 拦截点 at jsig.c:248）
gdb -ex "break jsig.c:248" \
    -ex "run" \
    -ex "print sig" \
    -ex "print jvm_signal_installed" \
    -ex "print sigismember(&jvmsigs, sig)" \
    -ex "print sact[sig].sa_handler" \
    --args env LD_PRELOAD=libjsig.so java -agentpath:myagent.so com.example.Main
# 期望: jvm_signal_installed=true, sigismember=true, sact[SIGSEGV].sa_handler = myagent 的 handler 地址

# 3. strace 验证 sigaction syscall 被抑制
strace -e trace=sigaction java -agentpath:myagent.so com.example.Main 2>&1 | wc -l
# 无 libjsig: 每条 sigaction 产生 syscall → 数十行
# 有 libjsig: Phase 3 后 sigaction 不产生 syscall → 行数显著减少
```

**反事实**：如果 JVM 只依赖 `sigaction` 返回的 `oldact` 来保存链式处理器 → 多库竞争时每个库都以为自己是唯一处理器（因为 `oldact` 只返回前一个内核级处理器）→ 最后加载的库覆盖所有前面的处理器 → N 个库同时安装 SIGSEGV 处理器时只有最后加载的那个有效。libjsig 的 `sact[]` 数组在用户态保存所有链式处理器（内核始终只安装 JVM 的处理器），避免了这个覆盖问题。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces `libjsig.so` — the JVM's signal-chaining interception library — in source-code-specific detail. This is NOT a tutorial on "how to use LD_PRELOAD" — it's ENGINEERING documentation on HOW libjsig intercepts `sigaction`, `signal`, and `sigset` via `dlsym(RTLD_NEXT)` to prevent native libraries from overwriting JVM-installed signal handlers.

Reader completed **09-native-interface** (JNI_ENTRY/JVM_ENTRY macros, JNI parameter marshalling), **15-core-native** (native method implementation patterns). This doc: **how the JVM protects its signal handlers from hostile/ignorant native code** — from the `signal_lock()` mutex+condvar barrier at jsig.c:98 to the three-branch state-driven routing in `sigaction()` at jsig.c:248 that decides whether to store third-party handlers in user-space `sact[]` or forward to the real kernel `sigaction`.

### Interview Story Format Answer（必须出现在 §一 末尾）

"libjsig.so intercepts `sigaction(2)` via `dlsym(RTLD_NEXT, "sigaction")` at jsig.c:239 inside `call_os_sigaction()`, cached in the `os_sigaction` function pointer. Each interception function — `sigaction()` (:248) and `set_signal()` (:164) — enters `signal_lock()` (:98) which acquires the mutex AND conditionally blocks non-JVM threads on `pthread_cond_wait(&cond, &mutex)` (at :104) during the `jvm_signal_installing` phase. The TID bypass is in `signal_lock()` itself: `if (tid != pthread_self())` (:103) — only the JVM installing thread passes through during Phase 1, all others wait. After `signal_lock()` returns, `sigaction()` (:248) enters a **three-branch** decision:

1. `jvm_signal_installed && sigused` (:282): signal is in `jvmsigs` (JVM owns it) — store `*act` in `sact[sig]`, return `sact[sig]` as `*oact`, don't touch the kernel. `signal_unlock()` and return 0.

2. `jvm_signal_installing` (:294): JVM is installing — call `call_os_sigaction()` to really install at kernel level, save the old handler in `sact[sig]`, add signal to `jvmsigs` via `sigaddset`. `signal_unlock()` and return the real result.

3. `else` (:308): JVM has no relation to this signal yet — direct `call_os_sigaction()` passthrough to kernel. `signal_unlock()` and return.

The key insight: libjsig doesn't prevent native code from registering handlers — it transparently re-routes their registrations through a user-space chain, ensuring the JVM always gets first crack at every signal it owns. The barrier is `signal_lock()` with its built-in TID check and `cond_wait`, not scattered conditional logic inside `sigaction()`."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **LD_PRELOAD interposition**: `LD_PRELOAD` is the Linux dynamic linker's mechanism for overriding shared library symbols. When `libjsig.so` is in `LD_PRELOAD`, the linker resolves `sigaction` to libjsig's implementation before libc's — any code that calls `sigaction` (including JNI libraries loaded later) gets libjsig's version. This is NOT the same as `dlopen` — `LD_PRELOAD` affects ALL symbol resolutions in the process, not just a single library. Source: `man 8 ld.so`, `src/java.base/unix/native/libjsig/jsig.c`.

2. **dlsym(RTLD_NEXT) + lazy inline initialization**: `dlsym(RTLD_NEXT, "sigaction")` at jsig.c:239 (inside `call_os_sigaction()`) finds the NEXT definition of `sigaction` in the symbol search order — skipping the current library (libjsig) and returning libc's implementation. The function pointer is cached in `os_sigaction` (:78). There is NO separate `initialize()` function — each interposer does lazy inline init on first call: `call_os_sigaction()` (:238-239) resolves `os_sigaction`, `call_os_signal()` (:117-122) resolves `os_signal`, `allocate_sact()` (:85-96) dynamically allocates `sact` on Solaris. This ensures `dlsym` only runs when the dynamic linker is fully ready.

3. **Three-state protocol**: libjsig's state machine has two `static bool` flags (`jvm_signal_installing` at :80, `jvm_signal_installed` at :81) that define three states:
   - State 0 (before JVM): Neither flag set → `sigaction` calls pass through directly to `call_os_sigaction()` → kernel sigaction
   - State 1 (between begin/end): `jvm_signal_installing=true` → all threads enter `signal_lock()` (:98) but only the JVM thread (TID match at :103) passes through; non-JVM threads block on `pthread_cond_wait` (:104). JVM thread's sigaction calls go to branch 2 of the three-branch logic: real kernel install + save old handler to `sact[]` + `sigaddset(&jvmsigs, sig)`
   - State 2 (after JVM): `jvm_signal_installed=true` → if the signal is in `jvmsigs` (JVM owns it, checked via `sigismember` at :267), branch 1 stores third-party handlers in `sact[]` without kernel touch; if signal is NOT in `jvmsigs`, falls through to branch 3 (direct passthrough)
   This is NOT a two-phase commit — it's a barrier synchronization: `signal_lock()` gates access, `end_signal_setting` releases it with `pthread_cond_broadcast` (:331).

4. **sact[] array**: The user-space signal action table at jsig.c:58 — `static struct sigaction sact[MAX_SIGNALS]` where `MAX_SIGNALS` is `NSIG` on Linux (typically 65). Each entry preserves the full `struct sigaction` (handler, mask, flags) as originally registered by third-party code. After State 2, `sigaction(sig, act, oact)` stores `*act` in `sact[sig]` and returns the previous `sact[sig]` value as `*oact` — completely transparent to the caller but never touching the kernel.

5. **pthread mutex + condvar synchronization (signal_lock/signal_unlock)**: jsig.c:98-111 defines two functions that encapsulate ALL synchronization:
   - `signal_lock()` (:98-107): `pthread_mutex_lock(&mutex)` + conditional `pthread_cond_wait(&cond, &mutex)` when `jvm_signal_installing && tid != pthread_self()`. This atomic "lock-and-maybe-wait" ensures no lost wakeup.
   - `signal_unlock()` (:109-111): simply `pthread_mutex_unlock(&mutex)`.
   The mutex (`mutex` at :68) protects the state flags (`jvm_signal_installing`, `jvm_signal_installed`), `jvmsigs`, and `sact[]` array. The condvar (`cond` at :69) efficiently blocks non-JVM threads during State 1 without busy-spinning.

6. **TID-based bypass in signal_lock()**: The TID check is at jsig.c:103: `if (tid != pthread_self())` — this is INSIDE `signal_lock()`, not in `sigaction()` interception. During State 1 (`jvm_signal_installing=true`), when the JVM's signal-installing thread calls `sigaction` → `signal_lock()` acquires mutex → checks `tid != pthread_self()` → sees it IS the JVM thread → returns WITHOUT cond_wait → JVM's sigaction proceeds to install handlers at kernel level. Any other thread → `tid != pthread_self()` is true → `cond_wait` blocks until `JVM_end_signal_setting` calls `pthread_cond_broadcast`. This is elegant: the TID check is at the LOCK level, not in a separate branch — all non-JVM threads are blocked before they even reach the three-branch logic.

7. **signal vs sigaction interception (two parallel three-branch paths)**: libjsig intercepts THREE functions: `sigaction` (:248), `signal` (:213), and `sigset` (:222). `signal()` and `sigset()` both delegate to `set_signal()` (:164-211), which implements a **parallel three-branch logic** using `call_os_signal()` (not `call_os_sigaction()`). This means signal/sigset interception stays in the signal/sigset API family — they forward via `os_signal` to the real libc `signal()`/`sigset()`, not converted to `sigaction()` system calls. The three branches in `set_signal()` mirror those in `sigaction()`: installed+sigused → save to sact[] only; installing → real call+save old+add to jvmsigs; else → direct passthrough. `save_signal_handler()` (:144-162) is the helper that records signal()/sigset() dispatch into sact[] format.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/java.base/unix/native/libjsig/jsig.c` — libjsig.so 唯一源文件 (343行)
- `src/hotspot/os/linux/os_linux.cpp` — JVM 信号安装侧 (`:5329-5520` set_signal_handler, `:594-688` signal_sets_init)
- `src/hotspot/os/posix/os_posix.cpp` — `JVM_begin_signal_setting`/`JVM_end_signal_setting` 调用点
- `src/hotspot/share/runtime/globals.hpp` — `UseSignalChaining` 标志 (`:883-900`)

Build:
```bash
# libjsig.so 构建
make libjsig

# 完整 JDK 构建（包含 libjsig）
make jdk
```

Key binaries:
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjsig.so` — 信号拦截库
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — JVM 信号处理端

Syscall 速查表:

| Syscall | man | 用途 |
|---------|-----|------|
| sigaction | `man 2 sigaction` | 安装/查询信号处理器（libjsig 拦截的核心 syscall） |
| dlsym | `man 3 dlsym` | 获取 libc sigaction 的函数指针 (RTLD_NEXT) |
| pthread_mutex_lock | `man 3 pthread_mutex_lock` | signal_lock() 获取互斥锁 |
| pthread_cond_wait | `man 3 pthread_cond_wait` | signal_lock() 内阻塞非 JVM 线程 |
| pthread_cond_broadcast | `man 3 pthread_cond_broadcast` | JVM_end_signal_setting 唤醒所有等待线程 |
| pthread_equal | `man 3 pthread_equal` | signal_lock() 内 TID 比对 |

全局状态表:

| 变量 | 类型 | 位置 | 作用 |
|------|------|------|------|
| `jvm_signal_installing` | `static bool` | jsig.c:80 | State 1 标志（JVM 正在安装） |
| `jvm_signal_installed` | `static bool` | jsig.c:81 | State 2 标志（JVM 已完成安装） |
| `tid` | `static pthread_t` | jsig.c:70 | JVM 安装线程 TID（signal_lock :103 比对） |
| `sact[]` | `static struct sigaction[MAX_SIGNALS]` | jsig.c:58 | 用户态链式处理器存储（MAX_SIGNALS=NSIG） |
| `jvmsigs` | `static sigset_t` | jsig.c:61 | JVM 已安装的信号集合（sigset_t 位图） |
| `mutex` | `static pthread_mutex_t` | jsig.c:68 | 状态机互斥锁（PTHREAD_MUTEX_INITIALIZER） |
| `cond` | `static pthread_cond_t` | jsig.c:69 | 条件变量（PTHREAD_COND_INITIALIZER） |
| `os_sigaction` | `static sigaction_t` | jsig.c:78 | 真实 libc sigaction() 函数指针 |
| `os_signal` | `static signal_function_t` | jsig.c:77 | 真实 libc signal()/sigset() 函数指针 |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **jsig.c** | `src/java.base/unix/native/libjsig/jsig.c` | 343 | `signal_lock`(:98-107) — mutex+cond_wait barrier; `call_os_signal`(:113-142) — lazy init os_signal + signal/sigset passthrough; `save_signal_handler`(:144-162) — 保存 signal() 处理器到 sact[]; `set_signal`(:164-211) — signal/sigset 三路分支拦截; `signal`(:213-220) — signal() 拦截入口→委托 set_signal; `sigset`(:222-234) — sigset() 拦截入口→委托 set_signal; `call_os_sigaction`(:236-246) — lazy init os_sigaction + sigaction passthrough; `sigaction`(:248-316) — sigaction 三路分支拦截; `JVM_begin_signal_setting`(:319-325) — Phase 1 开始; `JVM_end_signal_setting`(:327-333) — Phase 3 开始; `JVM_get_signal_action`(:335-342) — sact[] 查询接口 | 🔥 核心 — libjsig.so 的全部逻辑 |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ 懒内联初始化 — os_sigaction/os_signal 函数指针获取

```
问题：
  ① libjsig 如何获取 libc 的真实 sigaction/signal 函数指针？
  没有独立的 initialize() 函数？答案方向:
    有 3 个函数各自做懒内联初始化:
    
    ① call_os_sigaction() (jsig.c:236-246):
       static int call_os_sigaction(int sig, const struct sigaction *act,
                                    struct sigaction *oact) {
         if (os_sigaction == NULL) {                          // :238
           os_sigaction = (sigaction_t)dlsym(RTLD_NEXT, "sigaction");  // :239
           if (os_sigaction == NULL) { printf(...); exit(0); }  // :240-243
         }
         return (*os_sigaction)(sig, act, oact);               // :245
       }
    
    ② call_os_signal() (jsig.c:113-142):
       if (os_signal == NULL) {                               // :117
         os_signal = (signal_function_t)dlsym(RTLD_NEXT, 
           is_sigset ? "sigset" : "signal");                    // :119-121
       }
       return (*os_signal)(sig, disp);                          // :135
    
    ③ allocate_sact() (jsig.c:85-96):
       仅在 SOLARIS 上动态 malloc sact 数组；Linux 上是编译期静态数组 → 空操作
    
    dlsym(RTLD_NEXT, "sigaction") 在动态链接器的符号搜索顺序中跳过
    当前库 (libjsig.so)，返回下一个定义 "sigaction" 的库中的地址 —
    即 libc.so.6 的 sigaction()。这个指针被缓存为 os_sigaction (:78)，
    所有需要真正执行 sigaction 系统调用的地方都通过它调用。
    
    追问: 为什么不写成统一 initialize() 函数？
    → ① 延迟到首次调用：libjsig.so 在进程启动早期加载，此时动态链接器
      可能未完全初始化。懒初始化将 dlsym 推迟到第一次真实调用时 — 
      此时所有符号都已解析。
      ② 分离关注点: call_os_sigaction 只需 sigaction, call_os_signal 只需
      signal/sigset, allocate_sact 只需 malloc(Solaris)。统一函数会把不相关
      的初始化耦合在一起。
      ③ 无竞态风险: dlsym 两次调用返回相同指针+幂等写入，无数据损坏。

  ② Counterfactual: 如果使用 .init 段集中初始化？
      答案方向: 需要在动态链接器早期调用 dlsym → 可能符号未解析 → 
      需要重试逻辑。.init 执行顺序在多个 LD_PRELOAD 库中不确定 —
      如果另一 preload 库依赖信号 → 初始化顺序问题。懒初始化
      将复杂度推迟到运行时，依赖就绪后再初始化。
```

### 4.2 ★★★ signal_lock() 屏障 — 核心同步机制

```
问题：
  ① signal_lock() (jsig.c:98-107) 如何实现统一的 TID bypass + 线程阻塞？
      答案方向: jsig.c:98-107:
        static void signal_lock() {
          pthread_mutex_lock(&mutex);            // :99  获取互斥锁
          if (jvm_signal_installing) {            // :102 仅在 State 1
            if (tid != pthread_self()) {          // :103 TID 比对
              pthread_cond_wait(&cond, &mutex);    // :104 非 JVM 线程阻塞
            }
          }
        }
      
      关键设计:
      - 在 State 0 和 State 2: jvm_signal_installing=false → 只 lock mutex → 返回
      - 在 State 1 (installing=true):
        * JVM 线程 (tid == pthread_self()) → lock mutex → 返回，不 cond_wait
        * 非 JVM 线程 → lock mutex → cond_wait 阻塞 → 等待 broadcast
    
      追问: 为什么 cond_wait 在 signal_lock() 内而不在 sigaction() 内？
      → ① 关注点分离: signal_lock 是唯一的入口屏障 — 所有拦截函数
        (sigaction, set_signal, begin/end) 都经过它，cond_wait 在屏障
        内意味着所有函数共享同一套阻塞语义，无重复代码。
        ② 原子性: cond_wait 原子释放 mutex 并等待 — 如果在 sigaction()
        内做 cond_wait，signal_lock() 已经返回持有 mutex，需要额外
        signal_unlock 再 signal_lock → 竞态窗口。

  ② JVM_begin_signal_setting() (jsig.c:319-325) 和 JVM_end_signal_setting() (jsig.c:327-333):
      答案方向: begin (jsig.c:319-325):
        void JVM_begin_signal_setting() {
          signal_lock();
          sigemptyset(&jvmsigs);           // 清空 JVM 信号集
          jvm_signal_installing = true;    // 进入 State 1
          tid = pthread_self();            // 记录 JVM 安装线程 TID
          signal_unlock();
        }
      
      end (jsig.c:327-333):
        void JVM_end_signal_setting() {
          signal_lock();
          jvm_signal_installed = true;     // 进入 State 2
          jvm_signal_installing = false;   // 退出 State 1
          pthread_cond_broadcast(&cond);   // 唤醒所有等待的非 JVM 线程
          signal_unlock();
        }
      
      追问: 为什么 begin 用 signal_lock/signal_unlock 包裹？
      → begin 修改 tid 和 jvm_signal_installing — 这些是共享状态，
        signal_lock 保证修改的原子性。而且 signal_lock 也保护了
        "清空 jvmsigs + 设置 installing + 记录 tid" 这三个操作
        作为一个原子事务。

  ③ Counterfactual: 如果在 sigaction() 内分别做 mutex_lock 和 cond_wait（而非统一的 signal_lock）？
      答案方向: 需要每个拦截点（sigaction, set_signal, begin, end）都重复
      mutex_lock + 条件检查 → 4 处重复代码。更危险的是: 如果某个拦截点
      忘记 cond_wait 逻辑 → 第三方线程在 State 1 期间直接操作内核处理器 →
      竞态窗口。signal_lock() 集中化屏障 → 一次写对，处处安全。
```

### 4.3 ★★★ sigaction() 三路分支拦截 — 核心路由逻辑

```
问题：
  ① jsig.c:248-316 的 sigaction() 拦截函数如何根据状态做三路分支？
      答案方向: jsig.c:248-316 sigaction() 拦截:
        int sigaction(int sig, const struct sigaction *act,
                      struct sigaction *oact) {
          int res;
          bool sigused;
          struct sigaction oldAct;

          if (sig < 0 || sig >= MAX_SIGNALS) { errno = EINVAL; return -1; }  // :253-256

          signal_lock();                          // :264 获取 mutex + 可能 cond_wait
          allocate_sact();                        // :266 Solaris 动态分配
          sigused = sigismember(&jvmsigs, sig);   // :267 检查信号是否 JVM 拥有

          /* 三路分支 — 不是四路: */
          if (jvm_signal_installed && sigused) {     // :282 分支 1
            // State 2 + JVM 拥有此信号
            // → 存入 sact[]，不透传到内核
            if (oact != NULL) *oact = sact[sig];     // :285-287
            if (act != NULL) sact[sig] = *act;       // :288-290
            signal_unlock();                          // :292
            return 0;                                  // :293
          } else if (jvm_signal_installing) {         // :294 分支 2
            // State 1 — JVM 正在安装处理器
            // → 真正调用内核 sigaction + 保存旧处理器 + 加入 jvmsigs
            res = call_os_sigaction(sig, act, &oldAct);  // :297
            sact[sig] = oldAct;                          // :298
            if (oact != NULL) *oact = oldAct;             // :299-301
            sigaddset(&jvmsigs, sig);                     // :304 记录到 JVM 信号集
            signal_unlock();                              // :306
            return res;                                    // :307
          } else {                                         // :308 分支 3
            // State 0 或信号不在 jvmsigs 中
            // → 直接透传到内核
            res = call_os_sigaction(sig, act, oact);      // :311
            signal_unlock();                               // :313
            return res;                                     // :314
          }
        }

      关键理解: 没有独立的 "Phase 2 TID bypass 分支" —
      TID bypass 已经在 signal_lock() (:103) 中完成了。
      所有进入三分支的代码都持有 mutex 且已通过 cond_wait 检查。
      
      追问: 为什么不是四路分支（"Phase 0 透传 / Phase 1 阻塞 / Phase 2 TID bypass / Phase 3 sact[]"）？
      → 原 prompt 错误地把 TID bypass 当作独立分支。实际架构中:
        · Phase 1 阻塞 → 在 signal_lock():104 cond_wait 处理
        · Phase 2 TID bypass → 在 signal_lock():103 tid!=pthread_self() 处理
        · 三路分支处理的是: 进入 sigaction() 之后的业务逻辑(sact[]/real+save/直接透传)
      分离关注点更清晰: signal_lock 管"谁可以进入"，三分支管"进入后做什么"

  ② Counterfactual: 如果 Phase 2（State 2）不做 sact[] 存储，而是直接透传到内核？
      答案方向: 第三方 sigaction(SIGSEGV, &my_handler) → call_os_sigaction
      → 内核用 my_handler 替换 JVM 的 handler → JVM 不再收到 SIGSEGV →
      NPE 检测失效 → 访问 null 对象时 my_handler 被调用 → my_handler
      不理解 JVM 的信号上下文 (siginfo, ucontext) → 未定义行为。
      而且 JVM 无法恢复 — 即使第三方调用了 sigaction(SIGSEGV, SIG_DFL)
      想"还原"，内核的 oldact 返回的是 my_handler（因为 JVM 的 handler
      已经被覆盖了），无法还原 JVM 的 handler。
```

### 4.4 ★★★ sact[] 数组结构 — 用户态信号处理器链

```
问题：
  ① sact[] 数组如何存储和检索链式处理器？
      答案方向: jsig.c:58 — static struct sigaction sact[MAX_SIGNALS];
      MAX_SIGNALS = NSIG 在 Linux x86_64 上通常是 65（信号 1-64，信号 0 保留）。
      sact[sig] 存储 struct sigaction，包含:
        - sa_handler / sa_sigaction: 处理器函数指针
        - sa_mask: 处理器执行期间要阻塞的信号集
        - sa_flags: SA_SIGINFO, SA_RESTART, SA_ONSTACK 等标志
      
      JVM_get_signal_action() (jsig.c:335-342) 读取 sact[]:
        struct sigaction *JVM_get_signal_action(int sig) {
          allocate_sact();
          if (sigismember(&jvmsigs, sig)) {
            return &sact[sig];
          }
          return NULL;
        }
      关键: 使用 sigismember(&jvmsigs, sig) 而非检查 sa_handler != NULL。
      只要信号在 jvmsigs 中就返回 sact[sig]，即使 handler 为 NULL。
      注释问 "Does race condition make sense here?" — 调用者(chained_handler)
      需自行检查返回的 sa_handler 是否有效。
      
      追问: 为什么 sact[] 是 struct sigaction 而非简单的函数指针？
      → sigaction 的 sa_mask 字段指定了处理器执行期间要阻塞的信号 —
        这对信号安全至关重要。如果处理器执行期间 SIGSEGV 再次到达，
        sa_mask 可以防止重入。简单的函数指针丢失了这个语义信息。
        libjsig 必须完整保存 sigaction 的所有字段以正确重现原始行为。

  ② Counterfactual: 如果 sact[] 不存储 sa_mask，只存储函数指针？
      答案方向: 第三方处理器执行期间如果 sa_mask 未设置 → 处理器
      执行期间同一信号再次到达 → 重入处理器 → 可能死锁或数据损坏。
      特别是 sa_mask 默认阻塞正在处理的信号（SA_NODEFER 除外）—
      丢失这个信息意味着重入保护失效。信号处理器的正确性依赖于
      sa_mask 的完整保留。
```

### 4.5 ★★★ call_os_sigaction 和 call_os_signal — 两种透传通道

```
问题：
  ① call_os_sigaction() (jsig.c:236-246) 和 call_os_signal() (jsig.c:113-142) 的区别是什么？
      答案方向:
      
      call_os_sigaction() (jsig.c:236-246):
        static int call_os_sigaction(int sig, const struct sigaction *act,
                                     struct sigaction *oact) {
          if (os_sigaction == NULL) {                                // :238
            os_sigaction = (sigaction_t)dlsym(RTLD_NEXT, "sigaction");  // :239
          }
          return (*os_sigaction)(sig, act, oact);                     // :245
        }
      
      call_os_signal() (jsig.c:113-142):
        static sa_handler_t call_os_signal(int sig, sa_handler_t disp,
                                           bool is_sigset) {
          if (os_signal == NULL) {                                    // :117
            if (!is_sigset)
              os_signal = (signal_function_t)dlsym(RTLD_NEXT, "signal");  // :119
            else
              os_signal = (signal_function_t)dlsym(RTLD_NEXT, "sigset");  // :121
          }
          return (*os_signal)(sig, disp);                              // :135
        }
      
      区别:
      - call_os_sigaction 被 sigaction() (:297, :311) 使用 — 操作 struct sigaction
      - call_os_signal 被 set_signal() (:195, :206) 使用 — 操作 signal handler + disp
      - 两者分离保证类型安全: sigaction 返回 int, signal 返回 sa_handler_t
      - 各自独立懒初始化: os_sigaction 和 os_signal 分别 lazy init
      
      追问: 为什么不统一用一个 "call_os" 函数？
      → ① 类型不同: sigaction 和 signal 的参数/返回值类型不同，统一需要
        void* 转换 → 类型不安全。
        ② 懒初始化独立: call_os_sigaction 需要 os_sigaction 指针，调用 call_os_signal 
        可能触发不必要的 dlsym("sigset") → 浪费。
        ③ macOS 差异: call_os_signal 有 reentry 防护 (:129-139)，call_os_sigaction 没有 —
        合并会污染逻辑。

  ② Counterfactual: 如果只有 call_os_sigaction，signal() 也转为 sigaction 调用？
      答案方向: signal() 和 sigaction() 的语义不同:
        - signal() 的 SA_RESTART 标志行为因平台而异 (BSD vs System V)
        - sigset() 是 System V API，用 SIG_HOLD 控制信号屏蔽
        如果强制转 sigaction → 丢失 API 原生语义 → 第三方代码行为
        可能与预期不符。而且 macOS 上 signal() 内部调用 sigaction →
        会触发 libjsig 自身的 sigaction 拦截 → 死锁 (call_os_signal 
        的 reentry 防护正是为此)。保持两个独立的透传通道更安全。
```

### 4.6 ★★★ signal()/sigset() 拦截 — 与 sigaction() 并行的三路分支

```
问题：
  ① signal() (jsig.c:213-220) 和 sigset() (jsig.c:222-234) 如何实现拦截？
      答案方向:
      
      signal() (jsig.c:213-220):
        sa_handler_t signal(int sig, sa_handler_t disp) {
          if (sig < 0 || sig >= MAX_SIGNALS) { errno = EINVAL; return SIG_ERR; }
          return set_signal(sig, disp, false);   // is_sigset=false
        }
      
      sigset() (jsig.c:222-234):
        sa_handler_t sigset(int sig, sa_handler_t disp) {
          if (sig < 0 || sig >= MAX_SIGNALS) { return (sa_handler_t)-1; }
          return set_signal(sig, disp, true);     // is_sigset=true
        }
      
      两者都委托给 set_signal() (jsig.c:164-211)，后者实现与 sigaction()
      并行的三路分支:
      
        static sa_handler_t set_signal(int sig, sa_handler_t disp, bool is_sigset) {
          sa_handler_t oldhandler;
          bool sigused;
          signal_lock();                            // :169
          allocate_sact();                          // :170
          sigused = sigismember(&jvmsigs, sig);    // :172

          if (jvm_signal_installed && sigused) {    // :173 分支 1
            oldhandler = sact[sig].sa_handler;      // :179
            save_signal_handler(sig, disp, is_sigset);  // :180
            signal_unlock();                        // :189
            return oldhandler;                      // :190
          } else if (jvm_signal_installing) {       // :191 分支 2
            oldhandler = call_os_signal(sig, disp, is_sigset);  // :195
            save_signal_handler(sig, oldhandler, is_sigset);    // :196
            sigaddset(&jvmsigs, sig);               // :199
            signal_unlock();                        // :201
            return oldhandler;                      // :202
          } else {                                   // :203 分支 3
            oldhandler = call_os_signal(sig, disp, is_sigset);  // :206
            signal_unlock();                        // :208
            return oldhandler;                      // :209
          }
        }
      
      关键设计: set_signal() 使用 call_os_signal() (不是 call_os_sigaction)，
      保持 signal/sigset 原生 API 语义。save_signal_handler() (:144-162)
      负责将 signal handler 数据填充到 sact[] (struct sigaction 格式)。
      
      追问: 为什么 signal() 和 sigset() 不直接转调 libjsig 自己的 sigaction()？
      → ① sigaction() 拦截会再次进入 signal_lock() → 死锁（mutex 不可重入）。
        ② macOS 上 signal() 本身内部调用 sigaction → 如果 libjsig::signal 转调
        libjsig::sigaction 再转调 call_os_sigaction → 可能触发 reentry 死锁
        (call_os_signal 的 reentry flag :129-139 正是为此设计)。
        ③ 语义保持: signal() 的 BSD/System V 行为差异通过 is_sigset 标志
        在 save_signal_handler() 中处理，不丢失信息。

  ② Counterfactual: 如果 libjsig 只拦截 sigaction() 而不拦截 signal()/sigset()？
      答案方向: 旧代码或保守的库可能使用 signal() 而非 sigaction()。
      如果 libjsig 只拦截 sigaction → signal(SIGSEGV, my_handler)
      直接调用 libc::signal() → 内核处理器被覆盖 → 拦截失效。
      更糟的是，开发者可能不知道 signal() 绕过了拦截 → 问题难以诊断
      （strace 显示 signal syscall 而非 sigaction → 调试线索缺失）。
      signal() 是 ANSI C 标准 API — 大量遗留代码依赖它。
```

### 4.7 ★★★ 懒内联初始化与线程安全

```
问题：
  ① 懒内联初始化如何保证线程安全？没有统一的 initialize() 函数。
      答案方向: 三个函数各自做懒初始化:
      
      ① call_os_sigaction() (:238-239):
         if (os_sigaction == NULL) {
           os_sigaction = (sigaction_t)dlsym(RTLD_NEXT, "sigaction");
         }
      
      ② call_os_signal() (:117-122):
         if (os_signal == NULL) {
           os_signal = (signal_function_t)dlsym(RTLD_NEXT, 
             is_sigset ? "sigset" : "signal");
         }
      
      ③ allocate_sact() (:85-96):
         #ifdef SOLARIS
         if (sact == NULL) {
           sact = (struct sigaction *)malloc(...);
           memset(sact, 0, ...);
         }
         #endif
      
      线程安全保证:
      - dlsym 两次调用返回相同的函数指针 → 幂等操作，无数据损坏
      - 函数指针写入在 x86_64 上是 8 字节对齐写 → 原子操作（指针大小 = 字长）
      - mutex 和 cond 使用 PTHREAD_MUTEX_INITIALIZER/PTHREAD_COND_INITIALIZER
        静态初始化 → 在进程启动时由 libc 完成，无竞态
      - allocate_sact() 始终在 signal_lock() 内调用 (:170, :266) → mutex 保护
      
      追问: 如果两个线程同时看到 os_sigaction == NULL 并同时执行 dlsym？
      → dlsym(RTLD_NEXT, "sigaction") 总是返回相同的函数指针（libc 的 sigaction）。
      两个线程各写一次 os_sigaction → 写入相同的值 → 最终一致。在 x86_64 上，
      8 字节指针写入是对齐的 → 不会出现部分写入（撕裂写）。

  ② Counterfactual: 如果在 .init_array 中集中初始化 os_sigaction 和 os_signal？
      答案方向: 需要在动态链接器的早期阶段调用 dlsym → 可能因为
      符号尚未完全解析而失败（dlsym 返回 NULL）→ 需要复杂的重试逻辑。
      .init_array 的执行顺序在多个 LD_PRELOAD 库中不确定 —
      如果另一个 preload 库也依赖信号操作 → 初始化顺序问题。
      懒内联初始化将复杂性推迟到运行时（首次 sigaction/signal 调用），
      此时所有依赖都已就绪。而且 libjsig.so 很小 (343行) — 集中初始化的
      组织收益远小于其引入的时序脆弱性。
```

### 4.8 ★★★ JVM_get_signal_action — 链式回退的查询接口

```
问题：
  ① JVM_get_signal_action() (jsig.c:335-342) 如何作为 libjsig 和 JVM 之间的桥梁？
      答案方向: jsig.c:335-342:
        struct sigaction *JVM_get_signal_action(int sig) {
          allocate_sact();
          if (sigismember(&jvmsigs, sig)) {
            return &sact[sig];
          }
          return NULL;
        }
      
      与旧 prompt 描述的差异:
      - 不检查 jvm_signal_installed — 通过 sigismember 隐式保证:
        信号只有在 State 1 (installing) 中被 sigaddset 加入 jvmsigs 后才存在
      - 不检查 sact[sig].sa_handler != NULL — 直接返回指针，
        调用者(chained_handler) 需自行检查
      - 注释 "Does race condition make sense here?" — 提示存在竞态:
        sact[] 可能在调用者读时被另一线程的 sigaction 修改
      - 不使用 signal_lock() — 无锁查询，性能优化但允许竞态
      
      追问: 为什么 JVM_get_signal_action 不加 signal_lock()？
      → 此函数被 JVM 的 chained_handler() 调用，chained_handler 本身
        在信号处理器上下文中执行 — 信号处理器中调用 pthread_mutex_lock 
        可能死锁（如果信号中断了持有 mutex 的线程）。无锁查询允许
        信号安全上下文中的调用。竞态风险是已知且文档化的（注释承认）。

  ② Counterfactual: 如果 JVM_get_signal_action 使用 jvm_signal_installed 守卫？
      答案方向: 在 State 0 阶段（installed=false 且 installing=false）→ 
      返回 NULL → 即使信号在 jvmsigs 中也不返回 sact[]。但实际上 State 0 
      期间 jvmsigs 为空（被 begin 的 sigemptyset 清空）→ jvmsigs 
      只在 State 2 之后有意义 → sigismember 检查本身就足够了。
      多余的 installed 检查是冗余的，只增加了一个可能在竞态中失效的守卫。
```

---

## §五 Article Structure

```
§〇 生产场景 — SIGSEGV handler overwritten by native library
  ★ 真实错误: agent library sigaction 覆盖 JVM SIGSEGV handler
  ★ Root cause: 无 libjsig 拦截 → sigaction 直接操作内核
  ★ 三步诊断: LD_DEBUG → GDB break jsig.c:248 → strace sigaction
  ★ 反事实: 仅靠 oldact 保存链式处理器 → 多库覆盖

§一 ★★★ libjsig 三状态全链路源码走读
  ❓ 这不是 LD_PRELOAD 教程 — 这是 libjsig 如何用 dlsym(RTLD_NEXT)+懒内联初始化拦截 sigaction
  1.1 懒内联初始化 — call_os_signal(:113-142), call_os_sigaction(:236-246), allocate_sact(:85-96)
  1.2 jsig.c:98-107 signal_lock() — mutex + TID cond_wait 屏障
  1.3 jsig.c:319-325 JVM_begin_signal_setting — installing=true, tid=pthread_self(), jvmsigs 清空
  1.4 jsig.c:248-316 sigaction 拦截 — 三路分支: installed+sigused→sact[] / installing→real+sact+jvmsigs / else→direct
  1.5 jsig.c:327-333 JVM_end_signal_setting — installed=true, installing=false, broadcast 唤醒
  1.6 jsig.c:164-234 set_signal/signal/sigset 拦截 — signal(:213)/sigset(:222)→set_signal(:164)三路分支(信号 API 并行路径)
  1.7 jsig.c:335-342 JVM_get_signal_action — sigismember(&jvmsigs,sig)→&sact[sig]
  1.8 ★ Mermaid: signal_lock 屏障 → 三状态转移图 — 4 lanes: Native Library / libjsig / libc Kernel / JVM Thread
      State 0→1→2，每个 sigaction 调用的路由决策（进入 signal_lock → cond_wait 或通过 → 三路分支）
  1.9 ★ 面试 Story Format 答案 — 从 LD_PRELOAD 到 sact[] 链式回退的完整叙事

§二 ★★★ 7 Beginner Callout 框
  2.1 LD_PRELOAD interposition
  2.2 dlsym(RTLD_NEXT) + lazy inline initialization
  2.3 Three-state protocol (not four-phase)
  2.4 sact[] array
  2.5 pthread mutex + condvar synchronization (signal_lock/signal_unlock)
  2.6 TID-based bypass in signal_lock()
  2.7 signal/sigset interception (parallel three-branch path)

§三 ★★ 并发安全性分析
  ❓ 多线程同时 sigaction 的安全保证
  ❓ cond_wait 死锁预防分析
  3.1 signal_lock() 统一屏障 — 所有拦截点共用一个入口，TID bypass 在 lock 层
  3.2 signal_lock():104 cond_wait 原子释放 mutex 语义 — 避免 lost wakeup
  3.3 State 1 竞态分析 — begin/end 之间的线程阻塞 + JVM 线程 bypass
  3.4 懒内联初始化的线程安全性 — 幂等 dlsym + 指针对齐写

§四 ★ GDB 断点验证 — 8 断点完整 libjsig trace
  断言 1: jsig.c:99  signal_lock() — 验证 mutex_lock 获取
  断言 2: jsig.c:103 signal_lock() TID 检查 — 验证 cond_wait 条件
  断言 3: jsig.c:239 call_os_sigaction() 懒初始化 — 验证 dlsym(RTLD_NEXT)
  断言 4: jsig.c:319 JVM_begin_signal_setting — 验证 installing=1, tid 记录
  断言 5: jsig.c:282 sigaction() 三路分支 — 验证 installed+sigused 分支选择
  断言 6: jsig.c:327 JVM_end_signal_setting — 验证 installed=1, broadcast 触发
  断言 7: jsig.c:289 sigaction() sact[] 存储 — 验证 Phase 3 sact[] 不回写内核
  断言 8: jsig.c:335 JVM_get_signal_action — 验证 sigismember 查询

§五 ★ Cross-Reference
  ❓ 01-signal-installation — set_signal_handler 调用 begin/end_signal_setting
  ❓ 02-signal-dispatch — chained_handler 调用 JVM_get_signal_action
  ❓ man 2 sigaction — 内核级信号处理器安装 API
  ❓ man 3 dlsym — RTLD_NEXT 符号搜索语义
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because native libraries can call sigaction() at any time during State 2, libjsig stores third-party handlers in user-space sact[] at jsig.c:288-289 WITHOUT calling call_os_sigaction() — the kernel-level handler (JVM's) remains untouched..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from jsig.c, do not describe it. Every function discussed must have its actual source code shown with file:line annotation.

3. **Mermaid** — 三状态协议状态转移图。4 lanes: Native Library (第三方代码) / libjsig (拦截层) / libc Kernel (内核 sigaction) / JVM Thread (JVM 安装线程)。完整流程：State 0 透传 → signal_lock(:98) 获取 mutex → State 1 begin_signal_setting(:319) → 非 JVM 线程 cond_wait(:104) / JVM 线程 bypass(:103) → sigaction 三路分支(:282/294/308) → State 2 end_signal_setting(:327) broadcast → State 2 sact[] 存储。每步标注 jsig.c 行号。

4. **GDB session** — 8 breakpoints with exact file:line numbers:
   - `jsig.c:99` signal_lock() entry — verify mutex_lock(&mutex)
   - `jsig.c:103` TID check in signal_lock() — verify tid != pthread_self() logic
   - `jsig.c:239` call_os_sigaction lazy init — verify os_sigaction = dlsym(RTLD_NEXT, "sigaction")
   - `jsig.c:319` JVM_begin_signal_setting — verify jvm_signal_installing=true, tid=pthread_self(), jvmsigs 清空
   - `jsig.c:282` sigaction installed+branch — verify jvm_signal_installed=true, sigused=true
   - `jsig.c:294` sigaction installing branch — verify jvm_signal_installing=true
   - `jsig.c:327` JVM_end_signal_setting — verify jvm_signal_installed=true, broadcast triggered
   - `jsig.c:335` JVM_get_signal_action — verify sigismember(&jvmsigs, sig) check
   Each with expected variable values to verify.

5. **7 Beginner callout boxes** — exact text from §一: LD_PRELOAD interposition, dlsym(RTLD_NEXT)+lazy inline init, Three-state protocol, sact[] array, pthread mutex+condvar (signal_lock/signal_unlock), TID-based bypass in signal_lock(), signal vs sigaction parallel three-branch paths.

6. **Cross-reference at three points**:
   - At `JVM_begin_signal_setting` → "→ 01-signal-installation for the JVM-side call sequence that triggers State 1"
   - At `JVM_get_signal_action` → "→ 02-signal-dispatch for how chained_handler uses this to invoke third-party handlers"
   - At `sigaction` syscall → "→ man 2 sigaction for the kernel-level signal handler API that libjsig protects"

7. **Story-format interview answer** — at §一末尾: 从 `LD_PRELOAD=libjsig.so` 到第三方处理器被链式调用的完整叙事。Three parts: "dlsym(RTLD_NEXT) lazy inline init" + "signal_lock() TID barrier + three-branch state machine" + "sact[] chain and JVM_get_signal_action sigismember bridge".

8. **"不要写成→应该写成"对照表**（必须出现在 §六 中）：

| 不要写成 | 应该写成 |
|---------|---------|
| "libjsig intercepts sigaction to protect JVM handlers" | "libjsig's sigaction() at jsig.c:248 enters signal_lock()(:264) → checks `jvm_signal_installed && sigismember(&jvmsigs, sig)` (:282) — if true, stores `*act` in `sact[sig]` (:289) and returns 0 (:293) WITHOUT calling `call_os_sigaction()`; the kernel never sees the third-party handler registration" |
| "Four phases control the interception behavior" | "Three states with signal_lock() barrier: State 0 (both flags false): `call_os_sigaction()` direct passthrough (:308-314). State 1 (installing=true): `signal_lock()` blocks non-JVM threads via `pthread_cond_wait` (:104) while JVM thread bypasses TID check (:103); sigaction's second branch (:294-307) calls `call_os_sigaction()` + saves old to `sact[]` + `sigaddset(&jvmsigs, sig)`. State 2 (installed=true): sigaction's first branch (:282-293) stores third-party handlers in `sact[]` without kernel touch. The TID bypass is in `signal_lock()`, NOT in a separate sigaction branch." |
| "dlsym is used in initialize() to get the real sigaction" | "Lazy inline initialization — no `initialize()` function. `call_os_sigaction()` (:238-239): `if (os_sigaction == NULL) { os_sigaction = dlsym(RTLD_NEXT, "sigaction"); }`. `call_os_signal()` (:117-122): `if (os_signal == NULL) { os_signal = dlsym(RTLD_NEXT, is_sigset?"sigset":"signal"); }`. `allocate_sact()` (:85-96): Solaris-only `malloc`. Each function initializes only what it needs, on first use." |
| "sact[] stores third-party handlers with sa_handler != NULL check" | "jsig.c:58 `static struct sigaction sact[MAX_SIGNALS]` — MAX_SIGNALS=NSIG on Linux. `JVM_get_signal_action` (:335-342) returns `&sact[sig]` when `sigismember(&jvmsigs, sig)` is true — does NOT check `sa_handler != NULL`. The code comment at :337 acknowledges possible race condition. Callers (chained_handler) must verify `sa_handler` before calling." |
| "signal() converts to sigaction() internally" | "signal() (:213-220) and sigset() (:222-234) delegate to `set_signal()` (:164-211) which implements a parallel three-branch logic using `call_os_signal()` (NOT `call_os_sigaction`). This preserves the signal/sigset API family semantics — forwarding via `os_signal` to real libc `signal()`/`sigset()`, not converting to sigaction syscalls. `save_signal_handler()` (:144-162) handles the sact[] storage." |

---

## §七 Output Format

- Markdown file, named `00-libjsig-interposition.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/19-signal-chaining/docs/`
- 元信息头:

```
> **阶段**：[19-signal-chaining]
> **前置**：[15-core-native]（native 方法实现模式）、[09-native-interface]（JNI_ENTRY/JVM_ENTRY 宏机制）
> **配套**：[01-signal-installation]（JVM 信号安装流程 — set_signal_handler 调用 begin/end_signal_setting）、[02-signal-dispatch]（信号分派 — chained_handler 调用 JVM_get_signal_action）
> **后续依赖本文**：[02-signal-dispatch]（chained_handler 通过 JVM_get_signal_action 获取 sact[] 链式处理器）
> **阅读收益**：追踪 libjsig.so 的三状态协议 — 理解 signal_lock() (:98) 统一屏障（mutex + TID-based cond_wait）如何消除四路分支伪概念、dlsym(RTLD_NEXT) 懒内联初始化替代集中 initialize() 的设计权衡、sigaction() (:248) 三路分支（installed+sigused→sact[] / installing→real+sact+jvmsigs / else→direct）的完整路由逻辑、set_signal() (:164) 对 signal/sigset 的并行拦截、sact[MAX_SIGNALS] 保留完整 struct sigaction（sa_mask）的设计理由；掌握 LD_PRELOAD + libjsig 的三步诊断方法
```

- 目标行数: 450+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "libjsig intercepts sigaction" 而不展示信号流 — 必须从 signal_lock(:98) 屏障入口到 sigaction(:248) 三路分支到 signal_unlock(:109) 的完整路径
- ❌ 描述 "四路分支" — 实际是三路分支（installed+sigused / installing / else），TID bypass 在 signal_lock() 中
- ❌ 使用旧变量名: `real_sigaction`(应为 os_sigaction)、`real_signal`(应为 os_signal)、`sig_signal_mutex`(应为 mutex)、`sig_signal_cv`(应为 cond)、`jvm_signal_thread`(应为 tid)
- ❌ 描述虚构的 `initialize()` 函数 — 必须是懒内联初始化: call_os_signal(:117-122)、call_os_sigaction(:238-239)、allocate_sact(:85-96)
- ❌ 说 signal() 转为 sigaction() 拦截 — 实际是 signal()→set_signal()→call_os_signal() 独立路径
- ❌ 不解释 signal_lock() 的统一屏障设计 — 必须展示 mutex + TID check + cond_wait 三位一体的锁逻辑
- ❌ 不展示 jvmsigs 的 sigset_t 类型和 sigismember/sigaddset/sigemptyset 操作 — 不是 int[] 数组
- ❌ 不做 GDB 断点 trace — 至少 8 个断点覆盖 signal_lock → lazy init → begin → sigaction 三路分支 → end → sact[] 存储 → get_signal_action
- ❌ 不对比有/无 libjsig 的行为差异 — 必须展示 strace 输出对比和 LD_DEBUG 验证方法
- ❌ 使用不存在的行号 — 所有行号必须从 jsig.c 源码验证: signal_lock(:98)、signal_unlock(:109)、call_os_signal(:113)、save_signal_handler(:144)、set_signal(:164)、signal 拦截(:213)、sigset(:222)、call_os_sigaction(:236)、sigaction 拦截(:248)、begin(:319)、end(:327)、get_signal_action(:335)
- ❌ 把 jvmsigs 描述为 `static int[]` — 它是 `static sigset_t jvmsigs` (:61)

---

## §九 Required（≥8）

- ✅ **★ Mermaid 三状态协议转移图** — 4 lanes: Native Library / libjsig / libc Kernel / JVM Thread — State 0→1→2 完整转移，含 signal_lock() 屏障
- ✅ **★ signal_lock() 源码展示** — jsig.c:98-107 统一屏障（mutex + TID check + cond_wait）
- ✅ **★ sigaction() 三路分支源码** — jsig.c:248-316 完整代码，stdc++ 注解三路决策
- ✅ **★ JVM_begin/end_signal_setting 源码** — jsig.c:319-325 / :327-333（含 broadcast）
- ✅ **★ dlsym(RTLD_NEXT) 懒内联初始化源码** — call_os_signal(:117-122) + call_os_sigaction(:238-239) + allocate_sact(:85-96)
- ✅ **★ set_signal() 三路分支源码** — jsig.c:164-211 signal/sigset 并行拦截路径
- ✅ **★ 7 Beginner Callout 框** — 精确文本来自 §一: LD_PRELOAD、dlsym+懒初始化、三状态协议、sact[]、signal_lock/signal_unlock、TID bypass in signal_lock()、信号 vs sigaction 拦截
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事: LD_PRELOAD → dlsym(RTLD_NEXT) lazy init → signal_lock barrier → Three-branch state machine → sact[] chain → JVM_get_signal_action sigismember bridge
- ✅ **★ GDB 断点 ≥8 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ "不要写成→应该写成"对照表** — 5 行，覆盖 sigaction 拦截、三状态协议、懒初始化、sact[]、signal 拦截

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: signal_lock() 入口 (jsig.c:99)
  (gdb) break jsig.c:99
  (gdb) run
  (gdb) print jvm_signal_installing → 期望: false (State 0) 或 true (State 1)
  (gdb) print jvm_signal_installed → 期望: false (State 1) 或 true (State 2)
  (gdb) next → 经过 pthread_mutex_lock
  (gdb) info threads → 观察持锁线程

断言 2: signal_lock() TID 检查 (jsig.c:103)
  (gdb) break jsig.c:103
  (gdb) continue → 在 State 1 期间第三方线程调用 sigaction
  (gdb) print jvm_signal_installing → 期望: true
  (gdb) print tid → 期望: JVM 安装线程的 pthread_t
  (gdb) print pthread_self() → 期望: 当前线程的 pthread_t
  (gdb) print (tid != pthread_self()) → 期望: 1 (非 JVM 线程 → 进入 cond_wait) 或 0 (JVM 线程 → 通过)
  (gdb) next → 如果 TID 不匹配 → 进入 pthread_cond_wait (:104)

断言 3: call_os_sigaction 懒初始化 (jsig.c:238-239)
  (gdb) break jsig.c:238
  (gdb) run → 触发首次 sigaction 调用
  (gdb) print os_sigaction → 期望: (sigaction_t) 0x0 (NULL，未初始化)
  (gdb) next → 经过 if (os_sigaction == NULL) 进入初始化
  (gdb) next → 经过 dlsym(RTLD_NEXT, "sigaction")
  (gdb) print os_sigaction → 期望: 非 NULL (libc sigaction 地址，如 0x7ffff7...)
  (gdb) next → 经过 (*os_sigaction)(sig, act, oact) 内核调用

断言 4: JVM_begin_signal_setting (jsig.c:319)
  (gdb) break jsig.c:319
  (gdb) continue → JVM 启动过程中触发
  (gdb) print jvm_signal_installing → 期望: false (进入前)
  (gdb) print jvmsigs → 期望: sigset_t (可能残存旧值)
  (gdb) next → 经过 signal_lock()
  (gdb) next → 经过 sigemptyset(&jvmsigs)
  (gdb) next → 经过 jvm_signal_installing = true
  (gdb) next → 经过 tid = pthread_self()
  (gdb) print jvm_signal_installing → 期望: true
  (gdb) print tid → 期望: 有效的 pthread_t (JVM 安装线程)
  (gdb) print jvmsigs → 期望: sigset_t 全 0

断言 5: sigaction() 三路分支 — installed+sigused (jsig.c:282)
  (gdb) break jsig.c:282
  (gdb) continue → State 2 后第三方调用 sigaction
  (gdb) print jvm_signal_installed → 期望: true
  (gdb) print sig → 期望: 信号编号 (如 SIGSEGV=11)
  (gdb) print sigismember(&jvmsigs, sig) → 期望: 1 (JVM 拥有此信号)
  (gdb) next → 进入分支 1: if (oact) *oact = sact[sig]
  (gdb) print sact[sig].sa_handler → 期望: 当前存储的 handler (可能为 NULL)
  (gdb) next → 经过 sact[sig] = *act
  (gdb) print sact[sig].sa_handler → 期望: 第三方的处理器函数指针
  (gdb) print sact[sig].sa_mask → 期望: 第三方指定的信号掩码
  (gdb) print sact[sig].sa_flags → 期望: 第三方指定的标志

断言 6: sigaction() 三路分支 — installing (jsig.c:294)
  (gdb) break jsig.c:294
  (gdb) continue → State 1 期间 JVM 线程调用 sigaction
  (gdb) print jvm_signal_installing → 期望: true
  (gdb) print tid → 期望: JVM 安装线程 TID
  (gdb) print pthread_self() → 期望: == tid (JVM 线程已通过 signal_lock)
  (gdb) next → 进入 call_os_sigaction(sig, act, &oldAct)
  (gdb) print oldAct.sa_handler → 期望: 内核层旧处理器
  (gdb) next → 经过 sact[sig] = oldAct
  (gdb) print sact[sig].sa_handler → 期望: = oldAct.sa_handler (保存旧处理器)
  (gdb) next → 经过 sigaddset(&jvmsigs, sig)
  (gdb) print sigismember(&jvmsigs, sig) → 期望: 1 (信号已加入 jvmsigs)

断言 7: JVM_end_signal_setting broadcast (jsig.c:327)
  (gdb) break jsig.c:327
  (gdb) continue → JVM 完成信号安装
  (gdb) print jvm_signal_installing → 期望: true (进入前)
  (gdb) print jvm_signal_installed → 期望: false (进入前)
  (gdb) next → 经过 signal_lock()
  (gdb) next → 经过 jvm_signal_installed = true
  (gdb) next → 经过 jvm_signal_installing = false
  (gdb) next → 经过 pthread_cond_broadcast(&cond)
  (gdb) print jvm_signal_installed → 期望: true
  (gdb) print jvm_signal_installing → 期望: false
  (gdb) info threads → 期望: 之前阻塞在 signal_lock:104 的线程现在 RUNNING

断言 8: JVM_get_signal_action sigismember 查询 (jsig.c:335)
  (gdb) break jsig.c:335
  (gdb) continue → chained_handler 调用时触发
  (gdb) print sig → 期望: 发生的信号编号
  (gdb) print sigismember(&jvmsigs, sig) → 期望: 1 (信号在 JVM 信号集中)
  (gdb) next → 经过 allocate_sact() (Linux 上无操作)
  (gdb) next → 进入 if (sigismember(...))
  (gdb) print sact[sig].sa_handler → 期望: 非 NULL (有链式处理器) 或 NULL (无链式处理器)
  (gdb) print 返回值 → 期望: &sact[sig] (非 NULL，即使 sa_handler 为 NULL)
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §二.1 承接**：本文展开 README 规划的 "00-libjsig-interposition.md — libjsig.so 拦截层"，覆盖 jsig.c 的全部 343 行源码，聚焦信号拦截的三状态协议、signal_lock() 统一屏障、sigaction/signal/sigset 三路分支拦截实现。

2. **同组边界**:
   - **01-signal-installation** 覆盖 JVM 侧如何调用 `JVM_begin_signal_setting`/`JVM_end_signal_setting` 来触发 State 1/2 — 本文从 libjsig 侧展示这些函数如何实现状态转移
   - **02-signal-dispatch** 覆盖 `chained_handler` 如何调用 `JVM_get_signal_action` 来获取 sact[] 中的链式处理器 — 本文展示 sact[] 的存储结构和 sigismember 查询接口

3. **全部文档共享 §一 开头语**: "Reader completed 15-core-native (native method implementation patterns), 09-native-interface (JNI_ENTRY/JVM_ENTRY macros). This doc: how libjsig intercepts sigaction via dlsym(RTLD_NEXT) to protect JVM signal handlers from native library overwrites — from signal_lock() barrier to three-branch state routing."

4. **跨文档引用**: 本文是 Phase 19 的入口文档 — 01 和 02 都依赖本文建立的 libjsig 拦截层概念。阅读顺序建议: 00 (拦截层) → 01 (安装流程) → 02 (分派路径)。
