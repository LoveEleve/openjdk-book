# 11 — 操作系统层（OS Layer）

> 源码索引：`source_index/12-os-cpu.md`（os/ 55文件 + cpu/ 112文件）
> 插桩覆盖：`-Xlog:probe_runtime=debug`（os/linux 1cpp, os/posix 1cpp, os_cpu 1cpp），6 探针
> **前置阶段**：[10-services-diag], [09-native-interface], [08-safepoint], [07-thread-lock]
> **阅读收益**：理解每一个线程、每一个信号、每一个 mmap 页在 OS 层面如何被创建/分发/映射；掌握 libjsig 信号链的拦截与委托；看懂 hs_err 寄存器 dump 的信号安全输出；理解 RSS 为什么超过 -Xmx

---

## 一、阶段定位 — 这是 JVM 的"物理地基"

前 10 个阶段都在 JVM 内部——GC 怎么回收、safepoint 怎么协调、JNI 怎么穿越、Attach 怎么监听。**本阶段才是地基**。每一个线程不是凭空出现的，它背后是 `pthread_create` + `clone()` + LWP；每一个信号不是抽象的"通知"，它背后是 CPU 陷阱 → 内核信号投递 → JVM handler → 可能 crash；每一个堆页不是直接可用，它背后是 `mmap` reserve → `mprotect` commit → page fault lazy allocation。

**本阶段和 10 形成"内/外对称"的另一面**：10 解释了"外部工具如何到达 JVM"（jcmd 通过套接字），11 解释"OS 如何构建 JVM"（线程/信号/内存的物理实现）。如果说 10 是 JVM 对外的 API 面，11 就是 JVM 对 OS 的消费面。

### ★ 生产场景接地

每个文档必须从读者在凌晨 3 点被报警唤醒时的体验出发：

| 文档 | 你经历了什么 | 本文回答什么 |
|------|------------|-------------|
| **01-Signals** | `SIGSEGV (0xb) at pc=0x00007f...` — JVM 崩溃了也没打印线程栈 | 信号从 CPU 陷阱到 `JVM_handle_linux_signal()` 的全路径；libjsig 信号链为什么能让你的 native agent 也注册 handler 而不冲突 |
| **02-Threads** | `-Xss256k` 在 Docker 里报错但裸金属上没问题 | `os::create_thread` → `pthread_attr_setstacksize` 的完整参数链；`thread_native_entry` 醒来后做了什么 |
| **03-Memory** | `top` 显示 RSS 2GB 但 `-Xmx` 只有 1GB | reserve vs commit 的两阶段模型；mmap/MAP_NORESERVE 的 overcommit 语义；glibc `malloc_trim` 为什么不释放回 OS |
| **04-Crash** | hs_err 里 `siginfo: si_addr: 0x0000000000000010` 下面一堆寄存器但没线程名 | `os::print_context` 在信号上下文中的寄存器 dump；为什么 hs_err 可以打印 `RAX=0x...` 但不能调 `pthread_getname_np` |

### ★ 本文不是 Linux 系统编程教程

以下误解必须在每篇文档开头破除：

- **01** 不是 Linux 信号编程教程——不讲 `sigset_t` 的类型定义、不讲 `SA_NODEFER` vs `SA_ONSTACK` 的内核差异。本文只关心 JVM 为什么需要 `sigaction` + libjsig 链，以及 `signalHandler` 到 `report_and_die` 的决策树。
- **02** 不是 pthread 手册——不讲 `PTHREAD_CREATE_JOINABLE` vs `DETACHED` 的区别来源、不讲 `PTHREAD_STACK_MIN` 的 POSIX 标准演变。本文只关心 JVM 怎么把 Java 线程的 -Xss 参数正确喂给 `pthread_attr_setstacksize`。
- **03** 不是 mmap 手册——不讲 `MAP_ANONYMOUS` vs `MAP_SHARED` 的内核页表差异、不讲 overcommit 的三态 `/proc/sys/vm/overcommit_memory`。本文只关心 JVM 的 reserve→commit→uncommit→release 四态虚拟内存生命周期。
- **04** 不是汇编教程——不讲 x86 寄存器的 ABI 角色（`rsp` 栈顶、`rbp` 基址）。本文只关心 ARM/x86 上下文提取、`os::print_context` 怎么在只允许 `write()` 的信号约束下 dump 全套寄存器。

---

## 二、文档计划（4篇，带依赖链）

```
                         ┌──── 前置依赖 ────┐
                         │ 10-services-diag │
                         │ 09-native        │
                         │ 08-safepoint     │
                         │ 07-thread-lock   │
                         └───────┬──────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ 01-Signals      │   │ 02-Threads      │   │ 03-Memory       │
│ 信号处理+libjsig│   │ pthread→        │   │ mmap/mprotect/  │
│                 │   │ JavaThread      │   │ Commit          │
└───────┬─────────┘   └───────┬─────────┘   └───────┬─────────┘
        │                     │                     │
        └──────────┬──────────┘                     │
                   ▼                                │
        ┌─────────────────┐                         │
        │ 04-Crash        │◄──── 信号上下文 ────────┘
        │ hs_err+寄存器   │◄──── 03 的内存映射用于
        │ dump            │     hs_err 的 memory map
        └─────────────────┘
```

### 写作顺序（按依赖链）

```
01 → 02 / 03 (并行) → 04
```

- **01 必须先写**：信号是 02/04 的物理基础。02 的线程创建后要初始化信号屏蔽字（`hotspot_sigmask`），04 的 `os::print_context` 必须在信号上下文中执行——不理解信号链就无法理解为什么 04 只能用 `write()`。
- **02 和 03 对 01 有弱依赖**，可并行
- **04 依赖 01**（`JVM_handle_linux_signal` → `report_and_die` 的调用链就是 04 的入口）和 **03**（hs_err 打印 `/proc/self/maps` 的解析依赖对 reserve/commit 的理解）

---

## 三、逐篇详述

### [01] Signals — 信号处理与 libjsig.so 信号链

**核心问题**：SIGSEGV 怎么从 CPU 页故障变成 JVM 的 NullPointerException 或崩溃？JVM 如何用 `sigaction` 注册 handler、libjsig 如何用 `LD_PRELOAD` 拦截 `sigaction()` 形成信号链？`JVM_handle_linux_signal()` 的 6 路分流（polling page / implicit null / stack overflow / SIGBUS / JNI fast get field / crash）各走到哪个 stub？

**为什么放在第一**：信号是 JVM 的"primitive 事件源"。02 的线程醒来后初始化信号屏蔽字；03 的 commit memory 触发 page fault 时靠 SIGSEGV 分发到正确的处理器；04 的 hs_err 在信号上下文中生成。不理解信号链 = 不理解 JVM 为什么不会崩溃在 native agent 的信号处理器上。

**覆盖内容**：

```
§〇 源文件清单
  - os/linux/os_linux.cpp (signalHandler, set_signal_handler, libjsig_is_loaded, get_chained_signal_action)
  - os_cpu/linux_x86/os_linux_x86.cpp (JVM_handle_linux_signal — ★ 核心分流逻辑)
  - os/posix/os_posix.cpp (信号屏蔽字初始化 hotspot_sigmask)
  - runtime/os.cpp (SIGBREAK 触发 AttachListener lazy init)
  - runtime/globals.hpp (UseSignalChaining, ReduceSignalUsage 等标志)

§一 ★ 全景：CPU 陷阱 → 内核 → JVM handler → 6 路分流
  ❓ SIGSEGV 的 si_addr 值如何决定是 polling page、implicit null 还是真正的 crash？
  → JVM_handle_linux_signal() 检查 thread_state + si_addr 的组合:
    _thread_in_Java + si_addr 在 polling page 范围 → safepoint polling（跳转 StubRoutines）
    _thread_in_Java + si_addr 在零页 → implicit null check（跳转 forward_exception_entry）
    _thread_in_vm + si_addr 不在零页 → 可能是 unsafe 访问 → 继续检查
    _thread_in_native → 不可能发生（native 线程不执行 Java，不碰 polling page）
  ❓ StackOverflow 的 guard page 也是 SIGSEGV，如何和 implicit null 区分？
  → JVM_handle_linux_signal 先检查 si_addr 是否在栈保护区（yellow/red/reserved zone）→ 如果在 yellow zone → 抛 StackOverflowError stub；red zone → 直接 fatal。栈区检测优先于 implicit null 检测。
  ❓ libjsig 为什么需要 begin/end_signal_setting 的两阶段协议？
  → 竞态：如果另一个线程在 JVM 装 handler 过程中也调用了 sigaction，libjsig 需要知道"当前 sigaction 是 JVM 的还是其他人的"。begin_signal_setting() 设置 libjsig 的全局标记，告诉它"接下来的是 JVM handler，请直接安装到内核，不要加入链"。

§二 ★★★ libjsig.so 信号链的完整协议：4 步时序
  1. JVM 启动 → dlsym(RTLD_DEFAULT, "JVM_begin_signal_setting") 查找注入的 libjsig
  2. begin_signal_setting() → libjsig 内设置 jvm_installing=true
  3. sigaction(SIGSEGV, &jvm_handler) → libjsig 拦截，看到 jvm_installing，直接装到内核
  4. end_signal_setting() → libjsig 内设 jvm_installing=false
  ❓ 如果 libjsig 未加载（没有 LD_PRELOAD=libjsig.so），信号怎么处理？
  → 直接 sigaction 交给内核。但没有信号链——如果后续 native agent 也 sigaction(SIGSEGV)，会覆盖 JVM handler。这是 JNI 开发中常见的"我们的 profiling agent 让 JVM 不崩溃了" bug 的根源。
  ❓ get_signal_action 获取的"链上的下一个 handler"是非 JVM 的 —— 什么时候调用它？
  → JVM_handle_linux_signal() 末尾（line ~632）：如果 JVM 无法识别这个信号（不是自己的 polling page / null / stack / 等），调用 get_chained_signal_action(sig) 获取链上 handler → call_chained_handler() 委托给下一个。这保证 native agent 的信号处理器不会被 JVM 吃掉。

§三 ★★ set_signal_handler 的 3 种结果：全新安装 / 链式委托 / 跳过三方处理器
  ❓ 什么情况下 JVM 跳过某个信号的安装？
  → set_signal_handler 读取当前 handler：如果是 SIG_DFL 或 SIG_IGN → 全新安装 JVM handler。如果已有其他 handler 且该 handler 是已知的三方库（如 ASAN/TSAN 的地址消毒器）→ 不安装，让三方库独占。如果是普通库 → 加入信号链。
  ❓ 为什么 SIGPIPE 和 SIGXFSZ 被特殊处理（不插桩、不打印）？
  → 这两个信号极其频繁且无信息量——SIGPIPE（写关闭的 pipe）用户态忽略就行，SIGXFSZ（文件过大）同理。插桩会导致日志爆炸。

§四 ★ 和 08-safepoint 的连接：polling page → mprotect → SIGSEGV → handler 分流
  08 讲解了 mprotect 让 polling page 不可读 → 线程访问触发 SIGSEGV → handler 调用 handle_polling_page_exception()。本文追溯这个链路中"信号"的部分：sigaction 怎么安装的、信号到达后怎么从 signalHandler 传参到 JVM_handle_linux_signal、怎么分流到 polling page 分支。08 讲"为什么需要 polling"，11 讲"polling 怎么在信号层运作"。

§五 ★ 和 10-services 的连接：hs_err 的信号安全 write() → 现在解释信号处理器本身
  10 的 VMError::report_and_die() 用 write() 代替 fprintf。本文解释这个约束的根源——signalHandler 和 JVM_handle_linux_signal 在线程栈上被中断，上下文是信号上下文，不能用锁、不能 malloc。这就是 10 和 11 的"信号安全"叙事统一。

§六 ★ 和 09-native 的连接：JNI FastGetField 的 SIGSEGV slowcase
  09 的 JNI FastGetField 尝试无 Safepoint 读字段，如果字段在只读保护区（memory serialize page），触发 SIGSEGV → JVM_handle_linux_signal 中 _thread_in_native + 特定 PC 范围 → 跳转 slowcase stub。这是"信号作为优化手段"的典型案例——正常情况下无信号开销，异常时回退到慢路径。
```

**关键文件**（跨 os/linux + os_cpu/linux_x86 + os/posix + runtime）：

| 文件 | 完整路径 | 模块 | 核心函数/类 | 本文角色 |
|------|---------|------|-----------|---------|
| `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | os/linux | `signalHandler`(:5221), `set_signal_handler`(:5329), `libjsig_is_loaded`(:5234), `get_chained_signal_action`(:5240) | ★ 信号安装——sigaction + libjsig 协议 |
| `os_linux_x86.cpp` | `src/hotspot/os_cpu/linux_x86/os_linux_x86.cpp` | os_cpu/linux_x86 | `JVM_handle_linux_signal`(:271) | ★★★ 核心分流——6 路信号分发 |
| `os_posix.cpp` | `src/hotspot/os/posix/os_posix.cpp` | os/posix | `hotspot_sigmask` 初始化 | 信号屏蔽字——线程醒来时设置 |
| `os.cpp` | `src/hotspot/share/runtime/os.cpp` | runtime | `signalHandler` 中的 SIGBREAK 触发 | 信号触发——SIGBREAK → AttachListener lazy init |
| `globals.hpp` | `src/hotspot/share/runtime/globals.hpp` | runtime | `UseSignalChaining`, `ReduceSignalUsage` | 标志控制 |

**前置**：[08-safepoint]（理解 polling page + SIGSEGV 的用途）, [10-04]（理解 hs_err 的信号安全约束）

---

### [02] Threads — JVM 线程模型（pthread → JavaThread）

**核心问题**：`os::create_thread()` 中 `pthread_attr_init` → `pthread_attr_setdetachstate` → `pthread_attr_setstacksize` → `pthread_create` 的完整参数链是什么？`thread_native_entry()` 醒来后依次做了什么（TLS 绑定 / 栈地址记录 / 信号屏蔽字 / handshake 同步 / `call_run()`）？`ThreadCreate()` 的线程类型枚举（java_thread / compiler_thread / gc_thread / watcher_thread）各用多大的默认栈？

**为什么重要**：每个 JavaThread 在 OS 层面都是一个 LWP。07 讲了 JavaThread 在 JVM 内的生命周期，本文是 07 的 OS 补完——`JavaThread::JavaThread()` 构造函数内部调用 `os::create_thread()`，这是 JavaThread 从 JVM 数据结构变成内核调度实体的唯一路径。此外，-Xss 参数最终落到 `pthread_attr_setstacksize`——设小了就 OOM、设大了就 RSS 爆炸。

**覆盖内容**：

```
§〇 源文件清单
  - os/linux/os_linux.cpp (os::create_thread, thread_native_entry, pd_start_thread)
  - os/linux/osThread_linux.cpp (OSThread 构造/析构)
  - os/linux/osThread_linux.hpp (OSThread::thread_state 枚举)
  - os/posix/os_posix.cpp (pthread 初始化, ThreadCritical)
  - os/share/runtime/os.hpp (ThreadType 枚举: java_thread/compiler_thread/gc_thread/watcher_thread)
  - runtime/thread.cpp (Threads::create_vm → 创建线程; JavaThread::run → thread_main_inner)
  - runtime/osThread.hpp (OSThread 基类——_thread_id, _state)

§一 ★ 全景：JavaThread 怎么变成 OS 线程
  ❓ JavaThread 构造函数的哪一行触发了 pthread_create？
  → JavaThread::JavaThread() → os::create_thread(this, thr_type, stack_size) → pthread_create(&tid, &attr, thread_native_entry, this)。注意：此时 JavaThread 对象已分配完毕（包括 JavaThread 自身和其 OSThread 成员），但线程尚未执行。
  ❓ 为什么需要 handshake（sync_with_child barrier）？
  → 父子同步。父线程调用 os::create_thread 后必须等待子线程调用 set_native_priority + 完成初始化 → 子线程信号通知父线程。如果在握手完成前返回，父线程可能修改还未初始化的 thread 字段 → 竞态崩溃。

§二 ★★★ os::create_thread() 逐行走读（os_linux.cpp:965-1190）
  ❓ pthread_attr 的 4 个属性各是什么，不设会怎样？
  → (1) pthread_attr_init → 初始化属性对象
    (2) pthread_attr_setdetachstate(DETACHED) → 线程结束后自动释放资源，不设则必须 pthread_join
    (3) pthread_attr_setstacksize(-Xss) → Java 栈大小，不设使用 OS 默认（通常 8MB）→ 线程多了 RSS 爆炸
    (4) pthread_attr_setguardsize → 栈保护页大小，用于检测 StackOverflow
  ❓ pthread_create 失败 EAGAIN 时为什么重试 3 次？
  → EAGAIN = 系统线程数超限（`/proc/sys/kernel/threads-max`）。重试给了短时间窗口让其他线程退出释放 slot。
  ❓ create_thread 返回后，子线程一定在运行吗？
  → 不一定。pthread_create 保证子线程被创建但未调度。handshake 等待子线程初始化完成才返回——此时子线程已通过 INITIALIZED 状态但尚未调用 call_run()。

§三 ★★ thread_native_entry() — 所有 JVM 线程的醒来入口（os_linux.cpp:885-963）
  ❓ 醒来后按什么顺序初始化？
  → (1) Thread::current() TLS 绑定 (os::thread_local_storage_at_put)
    (2) stack_base_and_size 记录（用于后续栈溢出检测）
    (3) hotspot_sigmask 设置信号屏蔽字（阻塞某些信号）
    (4) FPU 状态初始化
    (5) sync_with_child->notify() → 通知父线程"我已初始化"
    (6) sync_with_child->wait() → 等待父线程 os::start_thread() 完成
    (7) call_run() → 虚函数分发到 JavaThread::run() / CompilerThread::run() / VMThread::run() 等
  ❓ 为什么信号屏蔽字要在子线程中设置而不是继承？
  → 屏蔽字是 per-thread 的。fork 继承父线程屏蔽字，但 pthread_create 不继承——新线程从父线程的默认屏蔽字开始。JVM 必须显式设置（block SIGINT/SIGQUIT 等非 JVM 内部信号）。

§四 ★ 4 种 ThreadType 的默认栈大小和用途
  从 `os::create_thread(large)` 的 switch(thr_type):
  - java_thread: 1MB（可被 -Xss 覆盖）
  - compiler_thread: 4MB（C1/C2 编译器的递归调用栈深）
  - gc_thread: 512KB（GC 并行线程栈浅，但数量多——`-XX:ParallelGCThreads=N`）
  - watcher_thread: 512KB（定时任务线程，栈极浅）
  ❓ 为什么 compiler_thread 要 4MB？
  → C2 编译器的递归优化遍历（如 IGVN/CCP/LoopOpt）栈深度可达数千帧。128KB 的默认 Linux 栈不够。
  ❓ -Xss256k 在 Docker 里为什么报错？
  → Docker 的默认 ulimit 可能比裸金属更严。此外，glibc 的 pthread 在创建时需要保证栈空间连续映射——小 -Xss 可能低于 glibc 内部要求的最小栈（`__pthread_get_minstack` 返回的值）。

§五 ★ 和 07-thread-lock 的连接：JavaThread 生命周期 vs OS 实现
  07 建立了 JavaThread 的 JVM 内生命周期模型。本文补上它没讲的 OS 层：
  - 07 讲 JavaThread::run → thread_main_inner → entry_point，本文讲 thread_native_entry → call_run → JavaThread::run
  - 07 讲 delete JavaThread 在 SMR 确认安全后，本文讲 pthread 的 DETACHED 状态让 OS 自动回收 LWP 资源
  - 07 没有讲 pthread_create 调用本身，本文把创建参数链完整展开

§六 ★ 和 09-native 的连接：JNI AttachCurrentThread 的特殊路径
  09 的 JNI AttachCurrentThread 走的是 os::create_attached_thread() —— 线程已经被 OS 创建了（是外部 native 线程），JVM 只创建 JavaThread 数据结构并绑定到已有的 pthread。这条路径和 os::create_thread 不同：它不创建 LWP，只是关联已有 LWP。
```

**关键文件**（跨 os/linux + os/posix + os_cpu + runtime）：

| 文件 | 完整路径 | 模块 | 核心函数/类 | 本文角色 |
|------|---------|------|-----------|---------|
| `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | os/linux | `os::create_thread`(:965-1190), `thread_native_entry`(:885-963), `pd_start_thread` | ★★★ 线程创建全链路——pthread_create + 子线程初始化 |
| `osThread_linux.cpp` | `src/hotspot/os/linux/osThread_linux.cpp` | os/linux | `OSThread::OSThread()` | OS 线程数据结构——tid/state |
| `osThread_linux.hpp` | `src/hotspot/os/linux/osThread_linux.hpp` | os/linux | `OSThread::thread_state` 枚举 | 线程状态——ZOMBIE/ALLOCATED/INITIALIZED/RUNNING |
| `os_posix.cpp` | `src/hotspot/os/posix/os_posix.cpp` | os/posix | pthread 初始化, `ThreadCritical` | POSIX 基础设施——信号屏蔽字/mutex |
| `os.hpp` | `src/hotspot/share/runtime/os.hpp` | runtime | `ThreadType` 枚举, `os::create_thread` 声明 | 接口定义——4 种线程类型 |
| `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | runtime | `Threads::create_vm`, `JavaThread::run` | VM 线程创建 + run() 虚函数 |
| `sharedRuntimeTrig.cpp` | `src/hotspot/os_cpu/linux_x86/sharedRuntimeTrig.cpp` | os_cpu | 线程 call_stub 入口 | 栈帧入口——build Java call stub |

**前置**：[07-thread-lock]（JavaThread 生命周期 + ThreadSMR）, [09-04]（JNI AttachCurrentThread 的 OS 绑定路径）

---

### [03] Memory — 堆内存映射（mmap / mprotect / Commit）

**核心问题**：Java 堆不是 `new` 出来的，它的每个页是怎么从"虚拟地址空间的一个承诺"变成"物理内存的一个页框"的？`reserve_memory()` → `commit_memory()` → `uncommit_memory()` → `release_memory()` 的四态生命周期各调用什么系统调用？为什么 RSS 经常超过 -Xmx？Linux overcommit 和 `MAP_NORESERVE` 怎么影响 OOM Killer 的行为？

**为什么重要**：这是 RSS 爆炸、OOM Killer 误杀、GC 性能回归的物理根源。08 的 GC 讲"Eden 区满了"，03 的 memory service 讲"pool usage 上升"，但没有一篇讲这些页从哪里来。本文是 JVM 内存管理的"第一公里".

**覆盖内容**：

```
§〇 源文件清单
  - os/linux/os_linux.cpp (pd_reserve_memory, pd_commit_memory, pd_uncommit_memory, pd_release_memory,
                          commit_memory_impl, mmap 包装函数, reserve_memory_special 大页)
  - os/linux/os_linux.hpp (os::Linux::commit_memory_impl 声明)
  - os/posix/os_posix.cpp (reserve_memory_aligned, map_memory_to_file)
  - runtime/os.hpp (reserve/commit/uncommit/release_memory 声明, ExecMem 标志)
  - runtime/virtualspace.cpp (ReservedSpace::initialize, Commit 到 VirtualSpace 映射)
  - runtime/virtualspace.hpp (ReservedSpace, VirtualSpace 类)
  - runtime/globals.hpp (UseNUMA, UseSHM, UseLargePages, LargePageSizeInBytes 等标志)
  - gc/shared/collectedHeap.hpp (reserved_region → 堆的 VirtualSpace)

§一 ★ 全景：reserve → commit 两阶段模型
  ❓ 为什么 JVM 不一步到位把堆一次性 mmap 进来？
  → (1) 灵活 GC 策略——G1 需要 reserve 大范围但只 commit 当前 region。
    (2) Overcommit——Linux 默认允许 mmap 超过物理内存。reserve 时内核不实际分配页（只在 VMA 里记账），commit 时才建立页表映射。
    (3) RSS 可控——只有 commit 的页计入 RSS，reserve 但不 commit 的页不计入。
  ❓ 两阶段的系统调用对应关系？
  → reserve_memory → mmap(NULL, size, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE, -1, 0)
    commit_memory  → mmap(addr, size, PROT_READ|PROT_WRITE, MAP_FIXED|MAP_PRIVATE|MAP_ANONYMOUS, -1, 0)
    uncommit_memory→ mmap(addr, size, PROT_NONE, MAP_FIXED|MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE, -1, 0)
    release_memory → munmap(addr, size)
    注意：commit 重复了 mmap，利用 MAP_FIXED 在同一虚拟地址上覆盖映射。这不是 bug——Linux 允许 MAP_FIXED 在同一 VMA 内建立新 prot 映射。

§二 ★★★ commit_memory_impl() 与 Linux overcommit（os_linux.cpp:3291-3309）
  ❓ mmap 返回成功就说明物理内存已分配吗？
  → 不。Linux 默认 overcommit（/proc/sys/vm/overcommit_memory=0）。mmap 成功只是 VMA 记账成功，物理页在第一次访问时才分配（page fault → do_anonymous_page）。如果此时物理内存不足 → OOM Killer 杀进程。
  ❓ recoverable_mmap_error 枚举了什么错误？
  → ENOMEM: 虚拟地址空间不足（最严重）→ 直接 vm_exit_out_of_memory
    EAGAIN: 暂时性失败（锁冲突等）→ 可重试
    EINVAL: 参数错误（如非对齐地址）→ 不可恢复
  ❓ JVM 怎么应对 overcommit 风险？
  → (1) commit 阶段立即 touch 所有页（`Prefetch::read` / madvise），强制 page fault 发生。
    (2) `-XX:+AlwaysPreTouch` → 启动时 touch 所有堆页 → OOM 发生在启动而非运行时。
    (3) `-XX:-UseContainerSupport` → 如果检测到 cgroup 限制，JVM 可以用 cgroup limit 而非物理内存做 commit 决策。

§三 ★ 大页（Huge Pages）的两条路径
  ❓ `-XX:+UseLargePages` 做了什么？
  → 两条路径：
    (1) SHM (SysV shared memory): `shmget(IPC_PRIVATE, ...)` + `SHM_HUGETLB` → 从 hugetlbfs 池分配。
    (2) THP (Transparent Huge Pages): `madvise(MADV_HUGEPAGE)` → 内核后台合并 4KB 页为 2MB 页。
    JVM 优先使用 SHM（确定性），回退到 THP（尽力而为）。
  ❓ 为什么 G1 对大页有特殊优化？
  → G1 的 Humongous region 可以被对齐到 2MB 边界。`os::reserve_memory_special()` 返回对齐的大页地址 → G1 在 `G1PageBasedVirtualSpace` 里用 `os::commit_memory` 逐个 commit。

§四 ★ ReservedSpace → VirtualSpace → Commit 的 3 层抽象
  ❓ ReservedSpace、VirtualSpace、commit_memory() 的职责分别是什么？
  → ReservedSpace: 一个连续的虚拟地址范围（已 reserve，未必 commit），可以分割成多个 VirtualSpace。
    VirtualSpace: ReservedSpace 的一个子范围，有独立的 commit/uncommit 状态跟踪（low/high water mark）。
    commit_memory(): OS 层的调用——mmap/MAP_FIXED → 让内核建立页表。
    这三层的好处是 GC 可以在不释放虚拟地址的情况下动态收缩/扩展堆（G1 的 heap expansion/shrinking）。

§五 ★ 为什么 RSS 超过 -Xmx？
  ❓ 常见超出场景：
  → (1) 非堆内存: Metaspace (mmap 独立区域), CodeCache (mmap 分配), 线程栈 (每个线程 ~1MB)，NMT 追踪的 malloc 区域
    (2) GC 数据结构: G1 的 remembered set 位图、SATB 队列、卡表（CardTable）——都占用 mmap 区域
    (3) 未释放: glibc malloc 不会主动 munmap——`malloc_trim` 只释放堆顶，不释放中间的碎片
    (4) CompressedOops base: 如果堆不能映射到 32GB 以下的地址范围，JVM 需要额外的 mmap 做 class space
  ❓ RSS 超过 2×-Xmx 时怎么排查？
  → (1) `pmap -x <pid>` → 按 anonymous 段排序 → 找最大的非堆段
    (2) `jcmd <pid> VM.native_memory summary` → 如果启用了 NMT
    (3) hs_err 的 `/proc/self/maps` 段 → 解析 address range → 匹配 JVM 日志中的 heap/codecache 地址

§六 ★ 和 08-safepoint 的连接：CardTable 的 mmap 创建
  08 的 GC barrier 写到 CardTable，但 CardTable 本身是一块 mmap 内存。`os::reserve_memory()` 为 card table 预留空间 → `os::commit_memory()` 让页可读写。card_size 和 page_size 决定了 card table 占用多少内存。
```

**关键文件**（跨 os/linux + os/posix + runtime + gc/shared）：

| 文件 | 完整路径 | 模块 | 核心函数/类 | 本文角色 |
|------|---------|------|-----------|---------|
| `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | os/linux | `commit_memory_impl`(:3291-3309), `pd_reserve_memory`, `pd_commit_memory`, `pd_release_memory`, `reserve_memory_special`(:4577) | ★★★ 内存操作——所有系统调用的 Linux 实现 |
| `os_linux.hpp` | `src/hotspot/os/linux/os_linux.hpp` | os/linux | `os::Linux::commit_memory_impl`, `reserve_memory_special_*` | 接口——Linux 平台声明 |
| `os_posix.cpp` | `src/hotspot/os/posix/os_posix.cpp` | os/posix | `reserve_memory_aligned`(:288), `map_memory_to_file`(:248) | POSIX——对齐分配 + 文件映射 |
| `os.hpp` | `src/hotspot/share/runtime/os.hpp` | runtime | `reserve/commit/uncommit/release_memory` 声明, `ExecMem` | ★ 接口——四态生命周期声明 |
| `virtualspace.cpp` | `src/hotspot/share/runtime/virtualspace.cpp` | runtime | `ReservedSpace::initialize`, `VirtualSpace::expand_by/commit` | ★ 堆抽象——3 层封装 |
| `collectedHeap.hpp` | `src/hotspot/share/gc/shared/collectedHeap.hpp` | gc/shared | `reserved_region()`, java heap 的 VirtualSpace | GC 接口——GC 端对 VirtualSpace 的消费 |

**前置**：[08-safepoint]（GC 期间内存操作 + CardTable）, [06-gc]（理解堆结构和回收）

---

### [04] Crash — 崩溃诊断（hs_err 与寄存器 dump）

**核心问题**：JVM 崩溃时，`JVM_handle_linux_signal()` 怎么从"无法处理的信号"进入 `VMError::report_and_die()`？`os::print_context` 如何从 `ucontext_t` 提取 x86/ARM 寄存器并在信号上下文中安全输出？`os::print_register_info` 怎么把保存的 PC 地址解析为"库名+符号+偏移"？

**为什么放在最后**：04 是"最后一公里"——它组合了 01 的信号链（崩溃来自信号）、02 的线程模型（线程栈打印）、03 的内存映射（hs_err 的 memory map 段），以及 10-04 的 `VMError::report_and_die` 框架。这是对 11 阶段全部知识的生产级检验。

**覆盖内容**：

```
§〇 源文件清单
  - os_cpu/linux_x86/os_linux_x86.cpp (os::print_context, os::print_register_info, get_pc_from_context)
  - os_cpu/linux_x86/frame_linux_x86.cpp (frame::sender_for_compiled_frame)
  - os/linux/os_linux.cpp (JVM_handle_linux_signal → report_and_die 的触发点, os::print_memory_info)
  - utilities/vmError.cpp (VMError::report_and_die → _steps[] → step_report)
  - utilities/decoder.cpp (Decoder——native 栈符号化)
  - runtime/os.cpp (os::print_location, os::print_hex_dump)
  - os/linux/os_linux.hpp (ucontext 相关辅助函数)

§一 ★ 为什么 hs_err 能打印寄存器但不能打印线程名？
  ❓ hs_err 的输出顺序是什么，背后各用了什么接口？
  → (1) header (reason, siginfo, pc, si_addr) —— 直接在信号上下文中记录
    (2) registers (RAX=..., RBX=..., RCX=..., RDX=..., RSP=..., RBP=..., RSI=..., RDI=..., R8-R15, RIP, EFLAGS) —— os::print_context 从 ucontext 读
    (3) top of stack —— 从 RSP 开始的 64/128 字节 hex dump
    (4) instructions at pc —— 从 RIP 附近的 64 字节反汇编/os::print_hex_dump
    (5) register to memory mapping —— os::print_register_info: 尝试把寄存器值解释为指针，dereference 附近的 32 字节
    (6) thread stack —— 走 os::print_stack_trace（需要解码 frame pointer）
    (7) /proc/self/maps —— os::print_memory_info
    (8) loaded shared libs —— os::print_dll_info
  ❓ 为什么能做到寄存器 dump 但做不到线程名打印？
  → 寄存器值直接从 ucontext_t 结构体读——这是内核在信号投递时压到用户栈上的。零系统调用、零 malloc，完全信号安全。
    线程名需要 `pthread_getname_np` → 内部持有 glibc 锁 → 信号不安全。如果 JVM 在持有 glibc 内部锁时崩溃 → 二次调用 pthread_getname_np → 死锁。

§二 ★★★ os::print_context — 从 ucontext 提取寄存器（os_linux_x86.cpp:770-835）
  ❓ x86_64 的 ucontext 结构里存着什么？
  → ucontext_t 包含：
    uc_mcontext.gregs[REG_RAX] → %rax
    uc_mcontext.gregs[REG_RBX] → %rbx
    ... 
    uc_mcontext.gregs[REG_RIP] → 指令指针
    uc_mcontext.gregs[REG_RSP] → 栈指针
    uc_mcontext.gregs[REG_RBP] → 帧指针
    uc_mcontext.gregs[REG_EFL] → 标志寄存器
    每个寄存器值以 16 进制格式输出：`RAX=0x00007f8b1a003c00, RBX=0x0000000000000001`。
  ❓ ARM/aarch64 平台怎么处理？
  → 不同的 cpu/ 子目录有各自的 `os_linux_aarch64.cpp`。print_context 模式相同——读 `uc_mcontext.regs[i]` → 输出。差异只在寄存器名（X0-X30 vs RAX-R15）和 frame pointer 的 convention（X29 是 ARM 的 FP）。

§三 ★ os::print_register_info — 寄存器值作为指针的解释（os_linux_x86.cpp:835-900+）
  ❓ 怎么判断一个寄存器值"可能是指针"？
  → os::print_register_info 对每个非零寄存器值调用 os::print_location() → 如果值落在已知的映射地址范围（堆/CodeCache/metaspace/library）内，打印"该地址附近的内容"。
  ❓ 如果寄存器值碰巧是 GC 正在移动的对象引用的旧值，输出的"附近内容"还有意义吗？
  → 可能无意义。hs_err 在信号上下文中生成，不保证 GC 不发生。但 This 信息仍然有用——即使值是 stale 的，它至少告诉你是"类型的对象指针"。完全不知道型就完全无法调试。

§四 ★ JVM_handle_linux_signal → report_and_die 的过渡
  ❓ JVM_handle_linux_signal 在什么条件下决定"这个信号我处理不了"？
  → 最后一层判定（os_linux_x86.cpp:~640-644）：
    走到了信号处理函数末尾 → 信号不被识别为 polling page / implicit null / stack overflow / SIGBUS with safe address / JNI fast get field。`abort_if_unrecognized == true` → 调用 `VMError::report_and_die(sig, info, ucVoid)`。
  ❓ abort_if_unrecognized 何时为 false？
  → JVM 的 signalHandler 包装传入 true；第三方通过 `os::Linux::signal_handlers_are_installed` 标记后转发信号时可能传 false——允许三方工具"试试看 JVM 能不能处理这个信号，不能就算了"。

§五 ★ 和 10-04 的连接：report_and_die 的信号安全输出 + _steps[] 框架
  10-04 解释了 `VMError::report_and_die` 怎么用 `_steps[]` 分步执行。本文解释 10-04 没覆盖的 OS 部分：
  - _steps 中 `step_print_register_info` → `os::print_context` + `os::print_register_info`
  - _steps 中 `step_print_memory_info` → `os::print_memory_info` → /proc/self/maps
  - _steps 中 `step_print_dll_info` → `os::print_dll_info` → /proc/self/smaps
  本文完整走读这些 step 调用的 OS 函数——它们如何从内核接口提取数据并格式化。

§六 ★ hs_err 的 /proc/self/maps 段怎么对应 03 的 reserve/commit 区域
  ❓ 怎么从 hs_err 的 maps 段里识别出 Java 堆？
  → Java heap 在 maps 中的特征：
    (1) 连续的大地址范围（通常是 GB 级）
    (2) Permission pattern: heap 内部既有 rwxp（CodeCache 内嵌在 heap？不——通常是 rw-p 为 commit 区域，---p 为 reserve 但未 commit 区域）
    (3) 文件名列为空（anonymous mapping）——Java heap 从不文件映射
  ❓ 未 commit 区域（PROT_NONE）在 maps 里怎么显示？
  → "---p" 权限标记，size 是 reserve 但大小（地址差），但不占用物理内存。这就是 reserve→commit 不相等的可视化证据。
```

**关键文件**（跨 os_cpu/linux_x86 + os/linux + utilities + runtime）：

| 文件 | 完整路径 | 模块 | 核心函数/类 | 本文角色 |
|------|---------|------|-----------|---------|
| `os_linux_x86.cpp` | `src/hotspot/os_cpu/linux_x86/os_linux_x86.cpp` | os_cpu/linux_x86 | `os::print_context`(:770), `os::print_register_info`(:835), `get_pc_from_context` | ★★★ 寄存器 dump——ucontext → 可读文本 |
| `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | os/linux | `JVM_handle_linux_signal` 末尾 report_and_die 触发点, `os::print_memory_info`, `os::print_dll_info` | ★ 崩溃入口 + maps/libraries 输出 |
| `vmError.cpp` | `src/hotspot/share/utilities/vmError.cpp` | utilities | `VMError::report_and_die`(:1307), `_steps[]` 框架 | ★ 崩溃报告框架——step 调度 |
| `decoder.cpp` | `src/hotspot/share/utilities/decoder.cpp` | utilities | `Decoder::get_source_info` | 符号化——PC → 函数名+偏移 |
| `os.cpp` | `src/hotspot/share/runtime/os.cpp` | runtime | `os::print_location`(:1086), `os::print_hex_dump` | 地址解析——寄存器值 → 内存解释 |

**前置**：[11-01], [11-03], [10-04]

---

## 四、写作优先级与预估篇幅

| 优先级 | 文档 | 预估篇幅 | 理由 |
|--------|------|---------|------|
| **P0** | 01-Signals | ~580行 | 信号是全阶段的物理基础——02/04 都依赖信号上下文的理解。独立价值最高，每篇 JVM crash 调试的读者最先需要。 |
| **P0** | 02-Threads | ~520行 | `os::create_thread` → `thread_native_entry` 是从 JVM 到 OS 的唯一线程创建路径。07 讲 JavaThread 生命周期，本文是 OS 端补完。生产中最常见的 -Xss 问题根源在此。 |
| **P1** | 03-Memory | ~550行 | RSS 爆炸是生产中最常见的性能/运维问题。reserve→commit 两阶段模型是理解堆内存行为的唯一钥匙。跨度最大（os/linux → os/posix → runtime/virtualspace → gc/shared）。 |
| **P1** | 04-Crash | ~500行 | 对 01+02+03+10-04 的综合检验。hs_err 的每一段输出都有对应的 OS 函数——理解这些能让你从寄存器 dump 里挖出崩溃根源。 |

---

## 五、和已学阶段的对比

| 维度 | 08-safepoint | 09-native-interface | 10-services-diag | **11-os-layer** |
|------|-------------|-------------------|-----------------|----------------|
| 核心文件 | ~6 | ~79（聚焦 ~25） | ~56（聚焦 ~20） | **~167（聚焦 ~15）** |
| 文档数 | 5 | 7 | 4 | **4** |
| 模块跨度 | 2 模块 (runtime + gc) | 7 模块 (prims + runtime + gc + os_cpu + interpreter + oops + os) | 5 模块 (services + os + utilities + gc/shared + runtime) | **5 模块** (os/linux + os/posix + os_cpu/linux_x86 + runtime + utilities) |
| 核心叙事 | 一个机制层层深挖 | 多个子系统+线程状态 | 两个管道(Attach+JMX)+底线(VMError) | **OS 三原语(信号/线程/内存)+崩溃出口** |
| 与前置的连接 | 自包含（依赖07） | 强烈依赖 08（01桥梁 + 03直接复用） | 依赖 09（内外对称）+ 08（信号安全）+ 07（线程） | ★ 依赖 10（信号安全输出）+ 08（polling page SDS）+ 07（JavaThread 创建）+ 09（JNI 线程绑定） |
| 最大价值 | begin/end 双层门禁 | JNI线程状态 + VM_Operation | 面向生产——线上诊断全链路 | ★ 面向物理层——每个线程/信号的 OS 实现 |

### 和 10-services-diag 的内外对称：管道 vs 地基

| | 10 (外部管道) | 11 (OS 地基) |
|---|---|---|
| 调用方向 | 外部工具 → 套接字 → JVM 内部 | OS 内核 → 信号/线程/内存 → JVM 消费 |
| 核心抽象 | AttachListener（JVM 创建的监听器） | signalHandler（内核中断入口） |
| 线程模型 | AttachListener 是 JavaThread 但不跑 Java | 所有线程通过 thread_native_entry 从 pthread 映射 |
| 安全机制 | SO_PEERCRED 身份验证 | mmap/MAP_FIXED 虚拟地址保护 + signal chain 不覆盖 |
| 数据面 | DCmd → MXBean → 监控工具 | ucontext → print_context → hs_err |

### 和 08-safepoint 的关系：信号的两极——协调 vs 崩溃

08 的 polling page 用 SIGSEGV 实现线程协作——mprotect 让页不可读 → 线程访问触发 SIGSEGV → handler 调 SafepointSynchronize::handle_polling_page_exception() → 进去后迅速返回。这是"最短信号路径"。

11 的 JVM_handle_linux_signal 处理更复杂的信号分流——同一个 SIGSEGV 要根据 si_addr + thread_state 分成 6 条路径。其中 crash 路径走到 report_and_die，这是"最长信号路径"——在同一个信号上下文中输出完整崩溃报告。

短 vs 长、协作 vs 崩溃——08 和 11 是"信号安全编程"的两个极端。

### 和 09-native-interface 的关系：JNI 线程状态 vs OS 线程创建

09 讲解了 JNI 的线程状态转换（_thread_in_native ↔ _thread_in_vm），本文解释线程本身的创建——pthread_create 的参数链、thread_native_entry 的初始化步骤。09 讲"状态在边界怎么切换"，11 讲"实体在 OS 怎么创建".

此外，09-03 的 JNI AttachCurrentThread 走 `os::create_attached_thread()` —— 这是一条不创建 LWP 的特殊路径（线程已存在，JVM 只绑定 JavaThread 结构），正好和 11-02 的 `os::create_thread`（创建新 LWP）形成对照。

### 和 07-thread-lock 的关系：JavaThread 生命周期 vs pthread 映射

07 建立了 JavaThread 从创建到销毁的 JVM 内模型。本文的 02 是 07 的 OS 端补完——JavaThread::JavaThread() 调用 os::create_thread() 的那一刻才真正变成内核可调度的实体。07 讲 delete 在 SMR 确认安全后进行，11 讲 pthread 的 DETACHED 属性让 LWP 在退出时自动释放资源。两阶段配合：SMR 保护 JVM 数据结构，DETACHED 保护 OS 资源。

---

## 六、跨模块依赖矩阵

| | os/linux | os/posix | os_cpu/linux_x86 | runtime | utilities |
|---|---|---|---|---|---|
| **01** Signals | os_linux.cpp (signalHandler, set_signal_handler, libjsig) | os_posix.cpp (hotspot_sigmask) | os_linux_x86.cpp (JVM_handle_linux_signal) | os.cpp (SIGBREAK trigger), globals.hpp | — |
| **02** Threads | os_linux.cpp (create_thread, thread_native_entry), osThread_linux.cpp | os_posix.cpp (pthread init) | — | os.hpp (ThreadType), thread.cpp (Threads::create_vm) | — |
| **03** Memory | os_linux.cpp (commit_memory_impl, reserve_memory_special), os_linux.hpp | os_posix.cpp (reserve_memory_aligned) | — | os.hpp (reserve/commit/uncommit/release), virtualspace.cpp | — |
| **04** Crash | os_linux.cpp (print_memory_info, JVM_handle_linux_signal 末尾) | — | os_linux_x86.cpp (print_context, print_register_info) | os.cpp (print_location) | vmError.cpp, decoder.cpp |

★ 注意：
- `os_cpu/linux_x86/os_linux_x86.cpp` 同时被 01（`JVM_handle_linux_signal` 分流）和 04（`os::print_context` 寄存器 dump）重度依赖——这是本阶段最关键的单文件，全阶段 4 篇文档中 2 篇围绕它展开
- `os/linux/os_linux.cpp` 是 7000+ 行的巨头文件——01 用它的信号部分、02 用它的线程部分、03 用它的内存部分、04 用它的崩溃入口和 maps 输出。4 篇文档各取文件的不同段落
- `os/posix/os_posix.cpp` 提供 POSIX 通用层——`reserve_memory_aligned` 和 `hotspot_sigmask` 被 02 和 03 共享，是 Linux 各平台的公共基座
- `utilities/vmError.cpp` 在 04 中被依赖——但 VMError 在 utilities/ 而非 os_cpu/ 中调用 `os::print_context`，这是本阶段最远的跨模块调用（os_cpu → utilities → os_cpu 的回调模式）

---

## 七、显式排除的主题（为什么不做）

以下主题有各自的价值，但本阶段刻意不包含：

| 主题 | 排除原因 |
|------|---------|
| **NUMA 感知分配**（`numa_make_global`, `UseNUMAInterleaving`, `libnuma` 绑定） | NUMA 是内存管理策略层面，不是 OS 基础原语。在 `commit_memory_impl` 中调用 `numa_make_global` 是条件性的——把 NUMA 讲解留给更深入的内存管理专题（可能阶段从不独立写，因为它是对 `os::commit_memory` 的策略注入，不是独立机制） |
| **Huge Pages 的 THP/shmget 内核实现细节**（`/sys/kernel/mm/hugepages`, `hugetlbfs` 挂载、页表共享） | Huge Pages 是 GC 性能调优的配置层面。03 只讲 JVM 怎么调用 `reserve_memory_special` ——两条路径（SHM/THP）的入口和回退逻辑。内核如何合并/拆分大页、`khugepaged` 的扫描周期属于 Linux 内核文档 |
| **cgroups v1 vs v2 内部实现**（cgroupSubsystem_linux.cpp, `memory.limit_in_bytes` vs `memory.max`） | 容器感知是"JVM 怎么知道自己被限制"的软限制层——cgroup 文件解析在 `osContainer_linux.cpp` 中独立存在。虽然 `os::commit_memory` 可能用到 cgroup limit（`-XX:+UseContainerSupport`），但 cgroup fs 的 `/sys/fs/cgroup` 遍历逻辑不是 OS 原语层——它是对 OS 资源的"读取"，不是"消费". 留到容器专题 |
| **perf_events / perfMemory**（`perfMemory_linux.cpp`, `os_perf_linux.cpp`, `rdtsc_x86.cpp`） | 性能计数器是 profiling 基础设施。`perfMemory_linux.cpp` 用 mmap 创建共享内存区域在父子进程间传递性能数据——这和 JVM 的堆内存 mmap 是完全不同的用途。`rdtsc` 是 CPU 时间戳计数器，不是 OS 层 |
| **LD_PRELOAD 机制本身**（`dlopen`, `RTLD_NEXT`, 动态链接器符号解析） | libjsig 通过 `LD_PRELOAD` 注入，但 `LD_PRELOAD` 的 ELF linker 插桩机制是 Linux 动态链接器的功能，不是 JVM 代码。01 只讲 libjsig 暴露的 `JVM_begin/end_signal_setting` + `sigaction` 拦截——不讲 linker 怎么决定先加载哪个 .so |
| **Decoder / ELF 符号解码**（`decoder_linux.cpp`, DWARF/elfutils 解析） | Decoder 在 04 中被调用（`os::print_location` 查符号），但 ELF 格式解析 + DWARF 行号表解码是独立主题。10-04 的 prompt 中已把 Decoder 作为独立章节走读——本阶段只在 04 中提到 Decoder 被调用的接口位置，不展开 .eh_frame / .debug_info 的字节级解析 |
| **OS 信号量的 JVM 包装**（`semaphore_posix.cpp`, `Semaphore::wait/timedwait/signal`） | POSIX semaphore 是 JVM 内部同步原语的一个实现选择（其他还有 `Parker`/`PlatformEvent`）。和 07 的锁体系高度耦合——信号量本身是工具，不是"OS 层是什么"这个叙事的一部分。07 的 lock 章节已覆盖 |
| **os::abort() 和 os::exit() 的不同死亡路径** | `os::abort()` 调 `abort()` → SIGABRT → 走信号处理器？`os::exit()` 跳过信号处理器直接 `_exit()`。这两条路径的差异对 10-04 的 VMError 更重要，在 04 中提到即可，不作为独立内容展开 |
| **JVM_handle_linux_signal 中 SIGTRAP 的特殊处理** | SIGTRAP 用于 JIT 的反优化陷阱（deoptimization trap），属于 JIT 编译机制，不是"信号作为 OS 原语"这个叙事的主线。01 中只提到 SIGTRAP 被注册但不展开——JIT deopt 在 05 阶段 |

---

## 八、每篇文档的深度问题（写 prompt 时必须覆盖）

以下问题不要求在 README 中回答——它们用于驱动每篇文档的 prompt，确保文档不只是"解释代码"，而是"追问为什么"。

### [01] Signals

1. `JVM_handle_linux_signal()` 中对 SIGBUS 的处理区分了 `_thread_in_Java`（MappedByteBuffer 场景）和 `_thread_in_vm`（unsafe 访问场景）。为什么这两种场景需要不同处理？`si_code`（BUS_ADRALN vs BUS_ADRERR）的差异是否足以覆盖所有分支？
2. `signalHandler` 包装 `JVM_handle_linux_signal` 前后保存/恢复 errno。如果 `JVM_handle_linux_signal` 内部调用 `report_and_die`（永不返回），那 errno 的保存还有什么意义——这是给什么场景留下的？
3. libjsig 的 `begin_signal_setting` / `end_signal_setting` 是一个全局标记。如果两个 JVM 线程同时调用 `sigaction`（一个在设置 SIGSEGV，另一个在设置 SIGBUS），begin/end 协议会不会因为不是 per-thread 而产生竞态？当前代码怎么避免？
4. `os::Linux::signal_handlers_are_installed` 这个 bool 被设置后，外部代码可以通过吗？`JVM_handle_linux_signal` 转发信号。这个"外部转发"功能是谁在用——DTrace？JVMTI agent？它的安全性怎么保证（恶意代码发送假信号给 JVM）？

### [02] Threads

1. `os::create_thread()` 中的 `sync_with_child` 用 `PlatformEvent` 实现父子握手。如果子线程初始化中触发 SIGSEGV 崩溃（例如 `hotspot_sigmask` 写坏了栈），父线程在 `sync_with_child->wait()` 上会永久阻塞——有什么超时保护？
2. `thread_native_entry` 中 `Thread::current()` 的实现依赖 `pthread_getspecific` 读 TLS。如果 native 线程（非 JVM 创建）调用了 `Thread::current()`，返回什么？是 NULL 还是 crash？
3. `pthread_attr_setstacksize` 传入的大小会被 glibc 内部调整（`__pthread_get_minstack` + guard page 对齐）。如果调整后的实际栈大于 JVM 预期的 -Xss 值，JVM 怎么发现这个差异（栈基址/栈顶由 `pthread_attr_getstack` 读出）？会不会导致 StackOverflow guard page 的 yellow zone 定位错误？
4. `pd_start_thread()` 最终设置线程优先级。`set_native_priority` 用了 `setpriority(PRIO_PROCESS, tid, priority)`——如果 Linux 的 `CONFIG_RT_GROUP_SCHED` cgroup 限制了这个进程的优先级范围，`setpriority` 调用会静默失败还是返回错误？

### [03] Memory

1. `commit_memory_impl` 用 `mmap(MAP_FIXED|MAP_ANONYMOUS)` 把 reserve 区域的 PROT_NONE 页"覆盖"为 PROT_READ|PROT_WRITE。Linux 的 MAP_FIXED 会**先删除**旧映射再创建新映射——这中间有原子性 gap。如果另一个线程在这两个操作之间访问了这个地址，会触发 SIGSEGV → JVM_handle_linux_signal → 这可能被误判为 crash 吗？JVM 的调用模式（单线程 commit 期间无并发访问）是否保证了安全？
2. `recoverable_mmap_error` 中 ENOMEM 直接 `vm_exit_out_of_memory`——但 ENOMEM 也可能是虚拟地址空间不足（不是物理内存不足）。在 64 位系统上虚拟地址空间几乎无限，什么场景会触发 ENOMEM（vm.max_map_count 限制？）？JVM 应该区分这两者吗？
3. `reserve_memory` 用 `MAP_NORESERVE` 标记，意味着 overcommit 发生时 OOM Killer 不会为这个映射预留交换空间。但 commit memory 时改用不带 MAP_NORESERVE 的 mmap——新映射的 overcommit 行为是否由 `/proc/sys/vm/overcommit_memory` 的值重新决定？
4. VirtualSpace 的 expand_by 使用 `low/high water mark` 跟踪 commit 范围。如果 `os::uncommit_memory` 只释放了中间的一段（不是从 high 往 low 收缩），VirtualSpace 的 watermark 会被"空洞"破坏吗——即是否存在"commit / uncommit / re-commit 交替导致 high/low watermark 不一致"的 bug？

### [04] Crash

1. `os::print_context` 在信号上下文中调用 `os::print_location` 解析地址。`os::print_location` 内部可能调用 `Decoder::get_source_info` → 如果 Decoder 的缓冲区分支包含未被预加载的 DWARF 数据，可能触发 mmap 换入新页（demand paging from disk）。在信号上下文中，demand paging 是 AS-safe 的吗（内核 `handle_mm_fault` → `filemap_fault` 可以等待 I/O）？
2. `os::print_register_info` 把寄存器值当指针去 dereference（`os::print_hex_dump(addr, ...)`）。如果寄存器中包含指向已 unmmap 区域的地址（野指针），`print_hex_dump` 的 `mincore`/直接读操作会触发第二次 SIGSEGV。JVM 怎么保护自己不被嵌套 SIGSEGV 递归吞掉？
3. `JVM_handle_linux_signal` 调 `report_and_die` 前设置了哪些"放弃抢救"的标记（`Thread::_vm_abort_called`、`ErrorLogFile` 的打开状态）？如果 `report_and_die` 内部又触发了 SIGSEGV（`_steps[]` 的 `step_dump_core` 写坏了栈），递归进入 `JVM_handle_linux_signal` → 再次 `report_and_die`——怎么检测"我正在报告错误"的递归？
4. hs_err 输出中 `Instructions: (pc=0x...):` 后面的机器码是用什么方式反汇编的？`os::print_hex_dump` 只是 hex dump 不是反汇编。如果 JVM 内嵌了 Disassembler（基于 hsdis 插件），在信号上下文中 load 这个 .so 是否安全（dlopen 不是 AS-safe）？

---

(End of file)
