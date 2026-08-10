# PROMPT: 请撰写 00-JNI-CreateJavaVM.md

## ⚠️ 关键：本 prompt 是导航地图，不是预制答案。你必须亲自读源码。

- **本 prompt 的 §四 答案方向是"指引"** —— 告诉你去源码里找什么、从哪个角度分析。你不能把"答案方向"里的文字直接抄到文档里。
- **你必须用 codegraph_explore 或 Read 工具逐个读取 §三 列出的每一个源文件**（至少读核心段落），基于自己的源码理解来写文档。读源码是你写文档的证据输入，prompt 只是你的导航。
- **没有读源码 = 不合格**。行为标志：文档段落和 prompt §四 答案方向文字雷同 → prompt 翻译 → 打回重做。
- 源码是证据（20%），你基于源码的分析洞察是正文（80%）。prompt 告诉你去找什么，不替你写答案。

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

```
$ java -Xmx256m -agentlib:jdwp=transport=dt_socket,server=y,suspend=n MyApp
Error occurred during initialization of VM
Could not find agent library jdwp on the library path, with error:
  libjdwp.so: cannot open shared object file: No such file or directory
```

这是一个经典的"JVM 启动了但没起来"的生产诊断场景。用户看到这个错误时，JVM 内部已经执行了以下步骤但在此处失败：`os::init()` — 页大小和 CPU 检测完成 → `Arguments::parse()` — JVM 参数解析完成 → `create_vm_init_agents()` — Agent 加载失败（找不到 `libjdwp.so`）。

关键诊断问题：JVM 在哪个点上死的？死之前创建了什么、没创建什么？如果你知道 JVM 初始化顺序，就知道此时 `vm_init_globals()` 还没执行——全局锁（~90 个 Mutex）不存在，Java 堆（G1）不存在，CodeCache 不存在。此时 `Threads::current()` 返回 `NULL`，没有 Java 线程对象。整个 JVM 还只是一堆 OS 资源和已解析的参数字符串。

**反事实**：如果 Agent 加载阶段放在 init_globals 之后（即先建好堆再加载 Agent），`libjdwp.so` 能正常加载但 Agent_OnLoad 可能触发类加载 → 类加载需要 SystemDictionary_lock → 但这个锁在 mutex_init() 中创建 → 而 mutex_init() 在 vm_init_globals 中，在 init_globals 之前 → 所以 Agent 加载必须在 mutex_init 之后但可以在 init_globals 之前。当前设计（Stage 3）是合理的——Agent 可以看 JVM 的完整资源库但不能做触发 GC 的事情（还没有堆）。

**三步诊断**：

```bash
# 1. 确认 Agent 路径
find /usr -name "libjdwp.so" 2>/dev/null
java -agentlib:jdwp=help  # 快速验证 jdwp 是否可用

# 2. strace 确认 JVM 在哪里停止
strace -f -e trace=openat java -agentlib:jdwp=server=y MyApp 2>&1 | grep "libjdwp"
# 期望: openat(AT_FDCWD, "/usr/lib/jvm/.../libjdwp.so", O_RDONLY) = -1 ENOENT

# 3. GDB 断点定位初始化阶段
gdb -ex "break JNI_CreateJavaVM" \
    -ex "break Threads::create_vm" \
    -ex "break vm_init_globals" \
    -ex "break init_globals" \
    -ex "run" \
    --args java -agentlib:jdwp=server=y MyApp
# 如果断在三号（vm_init_globals 之前）就死了 → Agent 加载阶段失败
```

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the first half of JVM startup: from `JNI_CreateJavaVM` (JNI entry point) through `Threads::create_vm` Stages 0-4, ending at the invocation of `init_globals()`. This is NOT a high-level "JVM starts up" tutorial — it's ENGINEERING documentation on HOW the JVM builds its internal infrastructure, source-code-specific detail at every step.

Reader completed **13-launcher** (JLI_Launch → LoadJavaVM → ifn->CreateJavaVM). This doc: **what happens AFTER CreateJavaVM is called — the phase that turns OS threads into JVM threads, creates 90+ global locks, and sets up the environment for heap allocation**.

### Key Narrative Arc

The story of JVM startup from `JNI_CreateJavaVM` to `init_globals()` is a story of **graduated capability building**:

1. **Stage 0 (Pre-init)**: We can print to stdout and know which CPU we're on. That's all.
2. **Stage 1 (OS + Args)**: We know the system (page size, CPU count, kernel version) and what the user wants (parsed flags).
3. **Stage 2 (Signals + Safepoint)**: We can handle segfaults and coordinate thread stopping.
4. **Stage 3 (Agents)**: External tools can hook into our lifecycle.
5. **Stage 4 (Globals)**: We build the skeleton of the JVM — 90+ locks → PerfMemory → MainThread → and then we're ready for init_globals to build the body.

### Interview Story Format Answer（必须出现在 §一 末尾）

"`JNI_CreateJavaVM` at jni.cpp:4143 is a thin wrapper around `JNI_CreateJavaVM_inner` (jni.cpp:3984) which adds atomic `vm_created` guard to prevent double initialization. `JNI_CreateJavaVM_inner` calls `Threads::create_vm()` (thread.cpp:3886), the 460-line function that orchestrates all 10 startup stages. Stages 0-3 handle pre-initialization: `os::init()` detects page size and CPU count via `sysconf()`, `Arguments::parse()` validates JVM flags, `os::init_2()` installs signal handlers for SIGSEGV/SIGBUS/SIGFPE, `SafepointMechanism::initialize()` mmaps the polling page for cooperative safepoint. `create_vm_init_agents()` loads native agents via dlopen and calls Agent_OnLoad. Then Stage 4 begins: `vm_init_globals()` at init.cpp:95 creates the lock hierarchy — `mutex_init()` defines ~90 PaddedMutex/PaddedMonitor objects via the def() macro, each assigned a rank (tty→special→safepoint→barrier→nonleaf→max_nonleaf) that enforces lock ordering to prevent deadlock. `perfMemory_init()` mmaps a 32KB shared memory file at `/tmp/hsperfdata_<user>/<pid>` for jstat. The main `JavaThread` is created (`new JavaThread()` at thread.cpp:4034) and bound to the current OS thread via `Thread::set_current()`, making `Thread::current()` functional for the first time. A `JNIHandleBlock` (64 slot, bump-pointer allocated) is attached for native→Java object references. Stack guard pages are installed via `mprotect`. At this point, `init_globals()` is called — and that's where Document 02 takes over."

### Beginner Callout Boxes（文档中必须出现的 ≥7 个 callout 框）

1. **JNI_CreateJavaVM vs JNI_CreateJavaVM_inner**: JNI public entry at jni.cpp:4143 uses atomic `vm_created` flag (CompareAndExchange) to ensure single-threaded initialization. The `_inner` variant at jni.cpp:3984 does the real work. Source: `src/hotspot/share/prims/jni.cpp`.

2. **sysconf vs /proc**: `os::init()` at os_linux.cpp calls `sysconf(_SC_PAGESIZE)` and `sysconf(_SC_NPROCESSORS_CONF)` to get system parameters. `_SC_PAGESIZE` returns `getpagesize()` — typically 4096 on x86_64. `_SC_NPROCESSORS_CONF` returns total logical CPUs including hyperthreads. This is the kernel's `getconf` interface, not `/proc/cpuinfo` parsing. 

3. **Polling Page (Safepoint Mechanism)**: `SafepointMechanism::initialize()` allocates one page (4KB) via `os::reserve_memory()` then `os::commit_memory()`. During normal execution the page is readable. When the VM wants a safepoint, it calls `os::make_polling_page_unreadable()` which uses `mprotect(PROT_NONE)` to make it inaccessible. All Java threads periodically read this page — the SIGSEGV handler recognizes the fault as a safepoint request and suspends the thread.

4. **Lock Ranking (Lock Hierarchy)**: JVM mutexes are assigned integer ranks: `tty` (lowest), `special`, `vmweak`, `leaf` (with +1/+2 variants), `safepoint`, `barrier`, `nonleaf` (with +1…+6 variants), `max_nonleaf`, `native` (highest). A thread may only acquire locks in ascending rank order. Acquiring a lower-rank lock while holding a higher-rank one is detected by `assert_locked_rank()` and triggers a fatal assert. This catches potential deadlocks at development time rather than deadlocking mysteriously in production. Source: `mutexLocker.cpp:194-354`.

5. **PerfMemory**: A `mmap(NULL, 32KB, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0)` at perfMemory.cpp creates a shared memory file at `/tmp/hsperfdata_<user>/<pid>`. `jstat -gc <pid>` reads this file via `attach()` to get GC statistics without any ActiveSocket-based RPC. Internal counters include heap usage, GC pause times, compilation activity, class loading count. The layout is: header (magic + version + byte ordering) → counter namespace tree → raw PerfData entries.

6. **JNIHandleBlock**: Created at thread.cpp:4047 via `JNIHandleBlock::allocate_block()`. Each block contains 64 `jobject` slots — indices into an OopStorage-based table. When JNI code needs to hold a reference to a Java object (e.g., `jobject obj = env->GetObjectField(...)`), a slot is allocated. The handle prevents GC from collecting the object. Local handles (default) are freed when the JNI call returns. Global handles persist until explicitly freed. The block uses bump-pointer allocation within each block and a linked list of blocks.

7. **Stack Guard Pages**: After creating the main thread, `create_stack_guard_pages()` at thread.cpp:4067 calls `os::guard_memory()` which uses `mprotect(PROT_NONE)` on the lowest page(s) of the thread's stack. When a thread overflows its stack, it hits this protected page → SIGSEGV → the signal handler in os_linux.cpp recognizes it as stack overflow (by comparing fault address to thread's stack bounds) → throws StackOverflowError in Java, or aborts with a native stack overflow error. Without guard pages, stack overflow would corrupt adjacent memory with no detection.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/prims/jni.cpp:3984-4143` — JNI_CreateJavaVM (_inner and public entry)
- `src/hotspot/share/runtime/thread.cpp:3886-4084` — Threads::create_vm Stages 0-4
- `src/hotspot/share/runtime/init.cpp:95-103` — vm_init_globals (7 sub-steps)
- `src/hotspot/share/runtime/mutexLocker.cpp:194-354` — mutex_init (~90 global locks)
- `src/hotspot/share/runtime/mutex.hpp` — Mutex/Monitor class hierarchy
- `src/hotspot/share/runtime/mutexLocker.hpp` — MutexLocker RAII + lock declarations
- `src/hotspot/share/runtime/perfMemory.hpp` — PerfMemory class (mmap shared memory)
- `src/hotspot/share/runtime/perfMemory.cpp` — PerfMemory::create_memory_region()
- `src/hotspot/os/linux/os_linux.cpp` — os::init(), os::init_2() Linux implementation
- `src/hotspot/share/runtime/os.cpp` — os::init_globals, os::initialize_jdk_signal_support
- `src/hotspot/share/runtime/arguments.cpp` — Arguments::parse, apply_ergo
- `src/hotspot/share/runtime/safepointMechanism.hpp` — SafepointMechanism::initialize (polling page)

Build: `make jdk`

Key binaries:
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — compiled from all of src/hotspot
- `build/linux-x86_64-normal-server-slowdebug/jdk/bin/java` — the launcher that loads libjvm.so

System calls used in startup path:
| Stage | Syscall | man | Purpose |
|-------|---------|-----|---------|
| 0 | `pthread_key_create` | man 3 | TLS key creation |
| 1 | `sysconf(_SC_PAGESIZE)` | man 3 | Page size detection |
| 1 | `sysconf(_SC_NPROCESSORS_CONF)` | man 3 | CPU count |
| 1 | `mlockall(MCL_CURRENT|MCL_FUTURE)` | man 2 | Lock pages (if -XX:+UseLargePages) |
| 2 | `sigaction(SIGSEGV, ...)` | man 2 | Segfault handler install |
| 2 | `sigaction(SIGBUS, ...)` | man 2 | Bus error handler |
| 2 | `sigprocmask(SIG_BLOCK, ...)` | man 2 | Thread signal mask |
| 4 | `mmap(MAP_SHARED, /tmp/hsperfdata_...)` | man 2 | PerfMemory shared memory |
| 4 | `pthread_getattr_np(...)` | man 3 | Stack base/size query |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **jni.cpp** | `src/hotspot/share/prims/jni.cpp` | ~5000 | `JNI_CreateJavaVM`(:4143, public entry + atomic guard), `JNI_CreateJavaVM_inner`(:3984, real impl → Threads::create_vm) | 🔥 JNI 入口 — 薄封装 + vm_created 原子保证 |
| 2 | **thread.cpp** | `src/hotspot/share/runtime/thread.cpp` | ~6300 | `Threads::create_vm`(:3886, 460-line orchestrator), `initialize_java_lang_classes`(:3822, 17 classes), `call_initPhase1/2/3` | 🔥 启动编排 — Stages 0-10 全流程 |
| 3 | **init.cpp** | `src/hotspot/share/runtime/init.cpp` | ~300 | `vm_init_globals`(:95, 7 sub-steps), `init_globals`(:109, 31 sub-steps) | 🔥 全局初始化 — 锁 + PerfMemory + 所有模块 |
| 4 | **mutexLocker.cpp** | `src/hotspot/share/runtime/mutexLocker.cpp` | ~400 | `mutex_init`(:194, ~90 PaddedMutex/Monitor via def() macro), `print_owned_locks_on_error`(:368) | 锁系统 — 等级排序 + 死锁防护 |
| 5 | **mutex.hpp** | `src/hotspot/share/runtime/mutex.hpp` | ~350 | `Mutex`(:297), `Monitor` (extends Mutex with wait/notify), `PlatformMonitor` (OS wrapper) | 锁定义 — 等级检查 + safepoint 感知 |
| 6 | **os_linux.cpp** | `src/hotspot/os/linux/os_linux.cpp` | ~6000 | `os::init` (sysconf + cgroup detection + large page), `os::init_2` (signal handlers + SR_init) | OS 适配 — Linux 平台初始化 |
| 7 | **perfMemory.hpp/cpp** | `src/hotspot/share/runtime/perfMemory.hpp` | ~200 | `create_memory_region` (mmap 32KB), `attach/detach` (jstat 访问) | 性能监控 — 共享内存计数器 |
| 8 | **arguments.cpp** | `src/hotspot/share/runtime/arguments.cpp` | ~4000 | `parse` (JVM flag parsing), `apply_ergo` (auto-tuning: heap size, GC selection, thread count) | 参数系统 — 解析 + 自动调优 |
| 9 | **safepointMechanism.hpp/cpp** | `src/hotspot/share/runtime/safepointMechanism.hpp` | ~80 | `initialize` (mmap + mprotect polling page), `poll` (inline read of polling page) | Safepoint — 协作式线程停止 |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ JNI_CreateJavaVM — 入口与原子保证

```
问题：
  ① JNI_CreateJavaVM (jni.cpp:4143) 和 JNI_CreateJavaVM_inner (jni.cpp:3984) 的区别？
      答案方向: jni.cpp:4143 的 public JNI_CreateJavaVM 做三件事:
        (a) ThreadToNativeFromVM 装饰器 — 表示我们将从 VM 模式转为 native 模式
        (b) Atomic::cmpxchg 检查 vm_created 全局标志 — 防止重复初始化
        (c) 调用 JNI_CreateJavaVM_inner() → Threads::create_vm()
      _inner 版本 (jni.cpp:3984) 是真正的实现，包括:
        - 设置 vm_created = true（在 create_vm 成功之后）
        - 异常处理: 如果 create_vm 失败 → canTryAgain 机制
        - JVMTI early start 事件的触发
      
      追问: 为什么需要两层？为什么不在 public 入口就做所有事情？
      → 两层设计实现了关注点分离: outer 层处理 JNI 规范要求的原子性和线程安全；
        inner 层处理 JVM 内部逻辑。而且异常路径不同: outer 失败 → 返回 JNI_ERR；
        inner 失败 → 可能设置 canTryAgain 为 false（如内存不足时不允许重试）。

  ② Counterfactual: 如果 JNI_CreateJavaVM 允许多次调用？
      答案方向: 第一次调用创建 VM → 第二次调用如果成功创建第二个 VM → 
        两个 VM 共享同一个进程、同一套文件描述符和信号处理器 →
        第一个 VM 的 sigaction(SIGSEGV) 被第二个 VM 的覆盖 →
        第一个 VM 的 NullPointerException 触发第二个 VM 的 handler →
        信号处理彻底混乱。hotspot 设计为单进程单 VM。vm_created 是硬开关。
```

### 4.2 ★★★ Threads::create_vm Stages 0-1 — OS 检测与参数系统

```
问题：
  ① os::init() (os_linux.cpp) 到底获取了哪些 OS 参数？为什么这些参数必须在参数解析之前获取？
      答案方向: os::init() 获取:
        - sysconf(_SC_PAGESIZE) → os::vm_page_size() (4096 on x86_64)
        - sysconf(_SC_NPROCESSORS_CONF) → os::processor_count (供 GC 线程数自动计算)
        - sysconf(_SC_PHYS_PAGES) → 物理内存大小 (供 -Xms/-Xmx 自动计算)
        - clock_tics_per_sec (CLK_TCK, 通常 100)
        - Linux::_main_thread (记录主 OS 线程, 通过 pthread_self())
        - 随机种子 (用于 identity hash 生成, /dev/urandom)
        - 内核版本 (uname, 用于特性兼容性检查)
      Arguments::parse() 依赖于物理内存大小来计算 -Xms/-Xmx 默认值。
      Arguments::apply_ergo() 需要 CPU 数量来确定 ParallelGCThreads/ConcGCThreads。
      
      追问: sysconf vs 读取 /proc —— JVM 为什么用 sysconf 而不是直接读 /proc/cpuinfo？
      → sysconf 是 glibc 的缓存抽象，比文件 I/O 快且是 POSIX 标准接口。
        直接读 /proc 在容器环境下可能读到宿主机的值（取决于 cgroup 配置），
        而 sysconf 在某些 glibc 版本中会考虑 cgroup 限制。

  ② Counterfactual: 如果先解析参数再检测 OS 信息？
      答案方向: 用户指定 -Xms128m -Xmx256m → Arguments::apply_ergo() 
        不知道物理内存是 4GB 还是 512MB → 不能验证"堆大小 < 物理内存" →
        发现不了 -Xmx256m 在 512MB 机器上不合理 →
        GC 时 OOM killer 可能杀死进程而非优雅抛出 OutOfMemoryError。
```

### 4.3 ★★★ Stage 2 — Signals + Safepoint

```
问题：
  ① os::init_2() (os_linux.cpp) 安装了哪些信号处理器？为什么这些必须在 vm_init_globals 之前？
      答案方向: os::init_2 安装的核心信号处理器:
        - SIGSEGV: 区分 NullPointerException (地址 < os::vm_page_size()) vs 
          implicit null check (address in first page, JVM expects this) vs 
          real segfault (print hs_err_pid.log + abort)
        - SIGBUS: 内存总线错误 (mmap 文件被截断, unaligned access on some archs)
        - SIGFPE: 除零异常 → ArithmeticException
        - SIGPIPE: 写入已关闭的 pipe → 忽略 (EPIPE, JDK-6353785)
        - SIGQUIT: Thread dump (kill -3) → print_stack_traces()
        - SIGILL: 非法指令 (CPU 不支持当前编译的代码) → abort + hs_err
      还调用 SR_initialize() 初始化 Suspend/Resume 机制（用于 stop-the-world）。
      必须在 vm_init_globals 之前因为: mutex_init() 创建的锁可能在信号处理上下文中被触碰。
      
      追问: 为什么 SIGQUIT 的 handler 可以安全地 print_stack_traces？
      → SIGQUIT handler (signalHandler.hpp) 使用异步安全操作: POSIX write() 写文件
        (不是 fprintf/printf), 并使用 Threads::owning_thread_from_monitor_owner() 
        从原始 Monitor owner 字段读取线程信息。整个 handler 不取任何锁 —— 
        如果在信号上下文中尝试取 Threads_lock 会死锁（因为被信号打断的线程可能正持有它）。

  ② Counterfactual: 如果 JVM 不处理 SIGSEGV 而让内核默认处理？
      答案方向: 内核默认 action for SIGSEGV: 终止进程 + core dump。
        NullPointerException → SIGSEGV → core dump → 进程死。没有任何 Java 异常。
        StackOverflowError → 栈溢出触发 SIGSEGV → core dump → 进程死。
        JVM 的 SIGSEGV handler 通过检查 fault address 和线程上下文来决定:
        - 是 null check → 构建并抛出 Java NullPointerException
        - 是栈溢出 → 构建并抛出 Java StackOverflowError  
        - 是 polling page (safepoint) → 挂起线程等待 safepoint 结束
        - 其他 → 认为是真正的 crash → hs_err_pid.log + abort
      没有这个 handler，JVM 无法将硬件异常转化为 Java 异常——Java 的异常语义完全依赖信号处理。
```

### 4.4 ★★★ Stage 4 — vm_init_globals: mutex_init() (~90 全局锁)

```
问题：
  ① def() 宏展开后具体做了什么？一个锁从 def() 调用到可以被 lock() 的路径？
      答案方向: def() 宏定义在 mutexLocker.hpp，展开约等于:
        "PaddedMutex##LockName = new PaddedMutex(rank, name, allow_vm_block, safepoint_check_type);"
      PaddedMutex 继承自 Mutex，添加了 padding 防止 false sharing (cache line 独占)。
      new 操作在 C-Heap 上分配 operator new + placement new。
      Mutex 构造函数初始化 PlatformMonitor (底层 OS 互斥原语):
        - Linux 上 PlatformMonitor 是 pthread_mutex_t + pthread_cond_t 包装
        - 或 futex-based (更快的用户态/内核混合锁)
        - 构造函数设置 _rank, _name, _allow_vm_block, _safepoint_check_required
      Mutex 对象被追加到全局 _mutex_array[] 数组，_num_mutex 递增。
      此后任何线程可以: `MutexLocker ml(LockName)` → RAII lock → mutex->lock().
      
      追问: lock ranking 检查在哪里触发？
      → Mutex::lock() 内部调用 assert_locked_rank()，它检查:
        if (this->_rank <= Thread::current()->_last_lock_rank && this->_rank != no_rank) → assert fail
        即当前锁的 rank 必须大于上一个持有的锁的 rank。
        在调试模式下 (slowdebug build) 每次 lock 都检查，product build 跳过。

  ② Counterfactual: 如果 JVM 没有 lock ranking —— 死锁如何发生？
      答案方向: Thread A: Compile_lock → MethodCompileQueue_lock (rank nonleaf+3 → nonleaf+4, OK)
        Thread B: MethodCompileQueue_lock → Compile_lock (rank nonleaf+4 → nonleaf+3, VIOLATION)
      → A 持有 Compile_lock 等待 MethodCompileQueue_lock
      → B 持有 MethodCompileQueue_lock 等待 Compile_lock
      → 经典 deadlock。进程永久挂起，无任何错误输出，需要 gcore 才能分析。
      lock ranking 在 Thread B 第二次 lock 时就触发 assert 崩溃并打印 hs_err_pid.log
      而不是静默死锁。开发者修复顺序问题，而非运营工程师半夜被 page。
```

### 4.5 ★★★ Stage 4 — perfMemory_init() (mmap 共享内存)

```
问题：
  ① PerfMemory::create_memory_region() 如何创建共享内存？jstat 如何读取它？
      答案方向: perfMemory.cpp 中创建流程:
        1. 使用 open() 在 /tmp/hsperfdata_<user>/ 创建文件 (O_CREAT|O_EXCL, 0600)
        2. ftruncate(fd, size) 设置大小 (默认 ~32KB, PerfMemorySize)
        3. mmap(NULL, size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0)
        4. close(fd) —— mmap 后文件描述符不需要保持打开
        5. 初始化 header: magic (0xc0c0feca), byte_order, major/minor version
      之后所有 PerfCounter 的创建都在这个 mmap 区域内通过 PerfDataManager 管理。
      
      jstat 读取路径:
        jstat → PerfMemory::attach(pid) → 打开 /tmp/hsperfdata_<user>/<pid> →
        读取 header 验证 magic → mmap 文件到自己的地址空间 →
        通过 namespace tree 找到 specific counter → 读取 value。
        纯共享内存读取，无 socket、无 RPC、无序列化。延迟 ~1µs per counter。
      
      追问: mmap MAP_SHARED + ftruncate → JVM 写入计数器需要通过 msync 吗？
      → Linux 上 MAP_SHARED 的 write 最终由内核 page cache 写回磁盘。
        但 jstat 读取不需要 msync —— jstat 也 mmap 同一文件，
        Linux 内核保证 MAP_SHARED mappings 看到同一页缓存（同一物理页帧）。
        写入直接修改内核 page cache 中的页，jstat 读取同一页 → 无需 flush。

  ② Counterfactual: 如果 PerfMemory 改用 socket-based RPC (如 JMX/Attach API)？
      答案方向: jstat 需要 TCP 连接 → 需要知道端口号 → 需要某种发现机制 →
        JVM 需要 accept() 线程 → 增加线程模型复杂度 →
        每次 jstat 调用需要序列化/反序列化 → 延迟 ~100µs vs 当前 ~1µs。
        更重要的是: JVM 崩溃时 socket 不可用，无法获取最后的计数器快照。
        PerfMemory 的关键设计优势是 post-mortem: JVM crash 后, 
        文件仍然存在于 /tmp, jstat 仍然能读取最终状态 —— 
        这需要 mmap+dumpable 文件（不是 socket）。
```

### 4.6 ★★★ Stage 4 — Main JavaThread 创建与绑定

```
问题：
  ① `new JavaThread()` (thread.cpp:4034) 做了什么？为什么此时 Thread::current() 返回 NULL？
      答案方向: `new JavaThread()` 仅仅是 C++ heap 上的对象分配:
        - 构造函数初始化: _thread_state = _thread_new, _active_handles = NULL,
          _osthread = NULL, _stack_base = NULL, _stack_size = 0
        - 此时这个 JavaThread 对象尚未绑定到任何 OS 线程
        - ThreadLocalStorage 中的 thread pointer = NULL → Thread::current() 返回 NULL
      
      然后 `main_thread->initialize_thread_current()` (thread.cpp:4036):
        - 调用 ThreadLocalStorage::set_thread(main_thread)
        - 将 C++ JavaThread* 指针存入 TLS (通过 pthread_setspecific 或 __thread 变量)
        - 此后任何调用 Thread::current() 都返回 main_thread
        - 这是 JVM 中最重要的时刻之一 —— 首次建立了 "C++ Thread 对象 ↔ OS 线程" 的绑定
      
      追问: 为什么要分两步 (new + initialize) 而不是构造函数里就绑定？
      → 构造函数只分配资源（可重试），绑定到 OS 线程是不可逆操作。
        如果构造函数中绑定 → 构造失败 → OS 线程"脏"状态 → 难以清理。
        Java 中 Thread.start() 也是两步: new Thread() + .start()。

  ② Counterfactual: 如果 Thread::current() 在初始化之前被调用？
      答案方向: 返回 NULL → 任何 dereference 导致 SIGSEGV →
        但此时信号处理器已安装 (Stage 2) → SIGSEGV handler 调用 Thread::current() 
        (尝试获取当前线程来处理异常) → 再次 NULL dereference → 
        递归 SIGSEGV → 栈溢出 → 进程被 kernel 杀死 (SIGKILL)。
        这就是为什么 Stage 2 的信号处理器必须在 Stage 4 主线程创建之前安装
        但不能依赖于 Thread::current() —— Stage 2 handler 必须使用 raw pthread_self()。
```

### 4.7 ★★★ 依赖拓扑 — 为什么是这个顺序？

```
问题：
  ① 如果把 Stages 0-4 的初始化步骤画成有向无环图，依赖链是什么？
      答案方向:
        os::init() (页大小/CPU/内存) ──→ Arguments::parse/apply_ergo() (需要系统资源信息)
             │                                    │
             │                           os::init_2() (需要栈大小参数)
             │                                    │
             │                           SafepointMechanism::initialize()
             │                                    │
             └────────────┬───────────────────────┘
                          │
                   vm_init_globals()
                   ├─ mutex_init()      ← 阻塞: 所有后续步骤都持有锁
                   ├─ perfMemory_init() ← 依赖: C-Heap allocation (operator new)
                   └─ SuspendibleThreadSet_init()
                          │
                   new JavaThread()     ← 依赖: TLS 可用 (Stage 0)
                   initialize_thread_current()
                   set_active_handles()
                   set_as_starting_thread()
                          │
                   init_globals()       ← 依赖: 所有以上资源 + 锁就绪
      
      追问: 哪些步骤可以并行？
      → 几乎不能。初始化是高度串行的。mutex_init 是所有锁创建的单一入口。
        但 os::init() 内部的多个 sysconf 调用可以并行（不依赖彼此）。
```

---

## §五 Article Structure

```
§〇 生产场景 — Agent 加载失败
  ★ 真实错误: "Could not find agent library jdwp"
  ★ Root cause: JNI_CreateJavaVM → create_vm_init_agents → dlopen 失败 → 在 vm_init_globals 之前就 shutdown
  ★ 三步诊断: find libjdwp.so → strace openat → GDB 断点定位初始化阶段
  ★ 反事实: Agent 放在 init_globals 之后 → 可加载但 Agent_OnLoad 可能触发类加载 → 需要 SystemDictionary_lock

§一 ★★★ JNI_CreateJavaVM → Threads::create_vm Stages 0-4 全链路走读
  ❓ 这不是 API 教程 — 这是 JVM 如何从裸 OS 线程构建 Java 运行时
  1.1 jni.cpp:4143 JNI_CreateJavaVM 公共入口 — atomic vm_created + JNI 模式切换
  1.2 jni.cpp:3984 JNI_CreateJavaVM_inner — 真正的实现
  1.3 Stage 0 (thread.cpp:3886-3908): 预初始化 — VM_Version::early_initialize + TLS + ostream
  1.4 Stage 1 (thread.cpp:3908-3960): os::init (sysconf) + Arguments::parse + apply_ergo
  1.5 Stage 2 (thread.cpp:3962-3988): os::init_2 (signals) + SafepointMechanism (polling page)
  1.6 Stage 3 (thread.cpp:3990-4009): create_vm_init_agents (Agent_OnLoad)
  1.7 Stage 4 (thread.cpp:4011-4084): vm_init_globals (mutex + perfMemory) + MainThread 创建
  1.8 mutex_init() 展开 — def() 宏 + ~90 全局锁 + rank 系统
  1.9 perfMemory_init() 展开 — mmap 32KB + jstat 读取路径
  1.10 MainThread 创建展开 — new JavaThread → initialize_thread_current → JNIHandleBlock → set_as_starting_thread → guard pages
  1.11 ★ 依赖拓扑图 (Mermaid DAG) — 显示 Stage 0→4 的依赖关系
  1.12 ★ 面试 Story Format 答案 — 从 JNI_CreateJavaVM 到 init_globals() 被调用

§二 ★★★ 7 Beginner Callout 框
  2.1 JNI_CreateJavaVM vs JNI_CreateJavaVM_inner
  2.2 sysconf vs /proc
  2.3 Polling Page (Safepoint Mechanism)
  2.4 Lock Ranking (Lock Hierarchy)
  2.5 PerfMemory (mmap shared memory)
  2.6 JNIHandleBlock
  2.7 Stack Guard Pages

§三 ★★ 异常路径分析
  ❓ JNI_CreateJavaVM 在 10 个不同的失败点如何优雅 shutdown
  3.1 JNI_EVERSION (不支持的 JNI 版本)
  3.2 JNI_EINVAL (参数校验失败, flag range violation)
  3.3 JNI_ENOMEM (mutex_init 或 perfMemory_init 内存分配失败)
  3.4 Agent 加载失败 (dlopen → dlerror)
  3.5 每个失败点: 创建了什么, 需要清理什么, canTryAgain = ?

§四 ★ GDB 断点验证 — 8 断点完整 trace
  断言 1: JNI_CreateJavaVM entry → verify atomic vm_created
  断言 2: os::init() sysconf → verify page_size/processor_count
  断言 3: Arguments::parse() → verify parsed flags
  断言 4: os::init_2() sigaction → verify signal handlers installed
  断言 5: SafepointMechanism::initialize() → verify polling page mmap'd
  断言 6: mutex_init() → verify _num_mutex and Threads_lock rank
  断言 7: perfMemory_init() → verify mmap'd file at /tmp/hsperfdata_*  
  断言 8: Thread::current() before/after initialize_thread_current → verify NULL → non-NULL

§五 ★ Cross-Reference
  ❓ 13-launcher — JLI_Launch → LoadJavaVM → CreateJavaVM (本文入口的调用者)
  ❓ 01-Universe-Init — init_globals() 的内部 (本文结束时调用的函数)
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because JNI spec requires single-VM-per-process enforcement, JNI_CreateJavaVM uses atomic cmpxchg on vm_created..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C++ code from jni.cpp / thread.cpp / init.cpp / mutexLocker.cpp, do not describe it.

3. **Mermaid** — 依赖拓扑 DAG 图。必须是 DAG（有向无环图），显示每个初始化步骤的依赖关系。节点用 file:line 标注。箭头标注依赖原因（例如 `SafepointMechanism::initialize() ──需要栈大小→ os::init_2()`）。

4. **GDB session** — 8 breakpoints with exact file:line numbers, each with expected variable values. 覆盖 JNI entry → OS init → arg parse → signal install → polling page → locks → PerfMemory → Thread binding.

5. **≥7 Beginner callout boxes** — exact text from §一: JNI_CreateJavaVM_inner, sysconf, Polling Page, Lock Ranking, PerfMemory, JNIHandleBlock, Stack Guard Pages.

6. **Cross-reference at THREE points**:
   - At `JNI_CreateJavaVM` entry: "→ 13-launcher for the JLI_Launch → LoadJavaVM → CreateJavaVM call chain"
   - At `init_globals()` invocation: "→ 01-Universe-Init for what happens inside init_globals"
   - At `os::init_2()`: "→ 15-core-native (signal handling) for detailed signal handler mechanics"

7. **Story-format interview answer** — at §一末尾: 从 `java -jar app.jar` 命令行到 `init_globals()` 被调用的完整叙事。必须包含: ① 谁在调用 CreateJavaVM（13-launcher）→ ② JNI entry 薄封装 → ③ Stage 0-3 系列化初始化 → ④ Stage 4 mutex_init + MainThread → ⑤ 接力给 init_globals 的 Moment.

### 不要写成 → 应该写成对照表

| 不要写成 | 应该写成 |
|---------|---------|
| "JNI_CreateJavaVM 创建 JVM" — 太笼统，什么都没说 | "jni.cpp:4143 用 Atomic::cmpxchg 检查 vm_created 确保单 VM，然后调用 _inner 版本 → thread.cpp:3886 Threads::create_vm 执行 10 阶段序列" |
| "os::init 初始化操作系统" — 无意义重复 | "os_linux.cpp 的 os::init() 调用 sysconf(_SC_PAGESIZE) → 4096, sysconf(_SC_NPROCESSORS_CONF) → 8 (含超线程), sysconf(_SC_PHYS_PAGES) → 供应商计算 -Xms/-Xmx 默认值, 记录 clock_tics_per_sec = 100" |
| "mutex_init 创建锁" — 没讲做了什么 | "def() 宏展开为 new PaddedMutex(rank, name, allow_vm_block, safepoint_check)，PlatformMonitor 底层用 pthread_mutex (或 futex)，rank 从 tty(最低) 到 native(最高)，每次 lock() 检查 rank 递增" |
| "SafepointMechanism::initialize 初始化安全点" — 不懂什么意思 | "mmap 分配一页 (4KB)，正常时 PROT_READ，需要 safepoint 时 mprotect → PROT_NONE，所有 Java 线程周期性读此页 → 触发的 SIGSEGV 被 handler 识别为 safepoint request → 线程自挂起" |
| "创建了 PerfMemory 共享内存" — 没说是怎么建的 | "open(/tmp/hsperfdata_user/pid, O_CREAT|O_EXCL) + ftruncate(32KB) + mmap(MAP_SHARED, 32KB) + 写 header magic 0xc0c0feca → jstat 通过 attach() 打开并 mmap 同一文件 → 零序列化读取" |

---

## §七 Output Format

- Markdown file, named `00-JNI-CreateJavaVM.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/`

元信息头:
```
> **Phase**：[01-jvm-startup]
> **前置**：[13-launcher]（JLI_Launch → LoadJavaVM → ifn->CreateJavaVM 调用）
> **配套**：[01-Universe-Init]（init_globals() 内部 31 次子调用）、[02-Execution-Engine]（init_globals 第14-31步）、[03-VM-Activation]（Stages 5-10）
> **后续依赖本文**：[01-Universe-Init]（从 init_globals() 执行开始，依赖本文创建的所有基础设施）
> **阅读收益**：追踪 JNI_CreateJavaVM 到 init_globals() 的完整 4 阶段启动——理解 JVM 如何从一无所有（裸 OS 线程）到拥有 90+ 全局锁、PerfMemory 共享内存、主线程绑定、栈保护——为 init_globals 的 31 步安全初始化铺路。掌握每个失败点的错误处理策略和锁层级系统的死锁防护机制。
```

- 目标行数: 550+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说"JNI_CreateJavaVM 是 JVM 入口"而不展示 Atomic::cmpxchg 的原子保证 — 必须展示 vm_created 标志和单 VM 强制执行
- ❌ 不解释 mutex_init() 的 ~90 个锁的 rank 系统 — 必须列出关键锁的 rank 顺序和死锁防护机制
- ❌ 不解释 SafepointMechanism 的 polling page 机制 — 必须展示 mmap + mprotect 的用法和 SIGSEGV handler 的分发逻辑
- ❌ 不解释 perfMemory_init() 的 mmap 布局 — 必须展示文件创建 + ftruncate + mmap + jstat 读取的完整路径
- ❌ 不展示 `Thread::current()` 从 NULL 变为有效指针的关键时刻 — 必须展示 initialize_thread_current() 中 TLS 绑定的实现
- ❌ 不说每个失败点的清理策略 — 必须列出 5 个以上失败点及其 canTryAgain 决策
- ❌ 不做 GDB 断点 trace — 至少 8 个断点覆盖从 JNI entry 到 init_globals 调用
- ❌ 不画依赖 DAG — 必须有 Mermaid DAG 图展示 Stage 0→4 的依赖关系
- ❌ 忽略 JNIHandleBlock 的创建 — 必须展示 allocate_block 和 64 slot 的 bump-pointer 分配
- ❌ 不解释 Stage 2 信号处理器为什么在 vm_init_globals 之前 — 必须解释 mutex_init 前安装信号处理器的必要性

---

## §九 Required（≥8）

- ✅ **★ JNI_CreateJavaVM 完整源码** — jni.cpp:4143 + jni.cpp:3984 两级 entry 的源码展示
- ✅ **★ Threads::create_vm Stages 0-4 源码** — thread.cpp:3886-4084 逐行注释
- ✅ **★ mutex_init() 展开** — mutexLocker.cpp:194-354 中 def() 宏的定义 + ~90 个锁的 rank 分组表
- ✅ **★ Lock Ranking 层级图** — tty→special→safepoint→barrier→nonleaf→max_nonleaf 的完整顺序和每组代表锁
- ✅ **★ SafepointMechanism 源码** — polling page mmap + mprotect + 线程 poll 检查
- ✅ **★ PerfMemory mmap 布局** — file creation + ftruncate + mmap + header magic + jstat 读取路径
- ✅ **★ Thread::current() 绑定 Moment** — initialize_thread_current() 源码 + before/after TLS 值对比
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事: 命令行 → CreateJavaVM → 10 阶段 → init_globals 接力
- ✅ **★ 依赖 DAG Mermaid 图** — 展示每个初始化步骤的依赖关系
- ✅ **★ GDB 断点 ≥8 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ 交叉引用** — 13-launcher (调用者), 01-Universe-Init (后续), 15-core-native (信号处理)

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: JNI_CreateJavaVM entry (jni.cpp:4143)
  (gdb) break jni.cpp:4143
  (gdb) run
  (gdb) print args->version → 期望: 0x00010008 (JNI_VERSION_1_8, 或 0x00010002 for 1.2)
  (gdb) print vm_created → 期望: false (初始化前)
  (gdb) continue → 进入 JNI_CreateJavaVM_inner

断言 2: os::init() sysconf (os_linux.cpp, os::init 函数内)
  (gdb) break os_linux.cpp (os::init 中 sysconf 调用行)
  (gdb) print os::vm_page_size() → 期望: 4096
  (gdb) print os::processor_count() → 期望: ≥1 (CPU 数量)
  (gdb) print Arguments::_no_java_home → 期望: 标志已正确设置

断言 3: Arguments::parse() 完成 (thread.cpp:3938 之后)
  (gdb) break thread.cpp:3938 (parse_result 赋值后)
  (gdb) print parse_result → 期望: JNI_OK (0)
  (gdb) print Arguments::_java_class → 期望: 用户指定的主类名
  (gdb) print UseG1GC → 期望: true (JDK 11 default)
  (gdb) print MaxHeapSize → 期望: 自动计算的堆最大值

断言 4: os::init_2() signal handlers (os_linux.cpp)
  (gdb) break os_linux.cpp (sigaction 调用之后)
  (gdb) shell grep SigCgt /proc/$(pidof java)/status
  # 期望: SigCgt (caught signal bitmap) 中包含 SIGSEGV(11), SIGBUS(7), SIGFPE(8)

断言 5: SafepointMechanism::initialize() polling page (safepointMechanism.cpp)
  (gdb) break safepointMechanism.cpp (initialize 函数末尾)
  (gdb) print SafepointMechanism::_polling_page → 期望: 非 NULL (已分配)
  (gdb) shell cat /proc/$(pidof java)/maps | grep "---p"  # 未读/写/执行 pages
  # 期望: 找到 polling page (PROT_NONE)

断言 6: mutex_init() 完成 (mutexLocker.cpp:353)
  (gdb) break mutexLocker.cpp:353
  (gdb) print _num_mutex → 期望: >60 (~90)
  (gdb) print Threads_lock->_rank → 期望: barrier
  (gdb) print Safepoint_lock->_rank → 期望: safepoint
  (gdb) print tty_lock->_rank → 期望: tty (最低 rank)

断言 7: perfMemory_init() mmap (perfMemory.cpp, create_memory_region 之后)
  (gdb) break perfMemory.cpp (mmap 调用之后, close(fd) 之前)
  (gdb) print PerfMemory::_start → 期望: 非 NULL mmap 地址
  (gdb) print *(int*)PerfMemory::_start → 期望: 0xc0c0feca (magic)
  (gdb) shell ls -la /tmp/hsperfdata_$(whoami)/$(pidof java)
  # 期望: 文件存在, 大小 = PerfMemorySize

断言 8: Thread::current() 绑定 Moment (thread.cpp:4036)
  (gdb) break thread.cpp:4035 (initialize_thread_current 之前)
  (gdb) print Thread::current() → 期望: NULL (还未绑定)
  (gdb) next  # 执行 initialize_thread_current
  (gdb) print Thread::current() → 期望: 非 NULL (JavaThread*)
  (gdb) print Thread::current()->name() → 期望: "main"
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 13-launcher README §10 承接**：13-launcher 覆盖了 `JLI_Launch()` → `LoadJavaVM()` → `ifn->CreateJavaVM()` 的 Java 启动器层面。13-launcher README line 218 明确标注: "从这一行开始，进入 01-jvm-startup §一，即 JNI_CreateJavaVM() 内部"。本文正是这个 anchor 点的展开——JNI_CreateJavaVM 内部发生的一切。

2. **同组边界**:
   - 00-JNI-CreateJavaVM（本文）：JNI_CreateJavaVM → Stages 0-4 → 停在 `init_globals()` 调用
   - 01-Universe-Init：从 `init_globals()` 的 `management_init()` 开始 → 到 `universe_init()` 返回
   - 02-Execution-Engine：`gc_barrier_stubs_init()` → `stubRoutines_init2()` + `MethodHandles::generate_adapters()`
   - 03-VM-Activation：Stage 5 VMThread → Stage 10 LIVE Phase + return JNI_OK

3. **全部文档共享叙事弧**: "13-launcher handed us a loaded libjvm.so and a function pointer to CreateJavaVM. 00 builds the skeleton (locks, signals, threads). 01 builds the body (heap, metaspace, tables). 02 builds the engine (interpreter, stubs, compiler). 03 activates the organism (threads + class loading + LIVE)."
