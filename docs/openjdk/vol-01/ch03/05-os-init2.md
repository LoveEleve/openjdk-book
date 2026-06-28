# 3.5 Stage 3：OS 后初始化

Stage 2 结束时，200+ 个 flag 已经全部确定——GC 选好了、堆大小算好了、栈守卫区大小算好了。但这些东西还只是"数值"，真正依赖它们的 OS 级基础设施还没建——信号处理器还没注册、安全点轮询页面还没分配、NUMA 库还没加载。

Stage 3 就是做这件事：依赖 Stage 2 的 flag 值，完成 OS 层最后的基础设施初始化。

---

## Stage 3 全貌

`Threads::create_vm` 中 Stage 3 的源码：

```cpp
/* === src/hotspot/share/runtime/thread.cpp === */

  HOTSPOT_VM_INIT_BEGIN();

  TraceTime timer("Create VM", TRACETIME_LOG(Info, startuptime));

  jint os_init_2_result = os::init_2();
  if (os_init_2_result != JNI_OK) return os_init_2_result;

  SafepointMechanism::initialize();

  jint adjust_after_os_result = Arguments::adjust_after_os();
  if (adjust_after_os_result != JNI_OK) return adjust_after_os_result;

  ostream_init_log();

  if (Arguments::init_libraries_at_startup()) {
    convert_vm_init_libraries_to_agents();
  }
  if (Arguments::init_agents_at_startup()) {
    create_vm_init_agents();
  }
```

`HOTSPOT_VM_INIT_BEGIN()` 是一个 DTrace 探针标记——DTrace 是 Solaris 系统上的动态追踪框架，允许在不重启进程的情况下插入观测点。Linux 内核不原生支持 DTrace，所以标准 JDK 11 构建（包括本机）使用 `dtrace_disabled.hpp`，在 `#if !defined(DTRACE_ENABLED)` 分支中定义 `#define HOTSPOT_VM_INIT_BEGIN()` 为空宏——编译后完全不存在。本机 `-XX:+PrintFlagsFinal` 输出中也确认所有 DTrace 相关 flag（`DTraceAllocProbes`、`DTraceMethodProbes` 等）均为 false。

Linux 上当前主流的动态追踪是 eBPF 及其前端工具 `bpftrace`，但同样依赖 JDK 编译时开启 USDT 探针才能捕获 JVM 内部事件。标准构建中探针不存在，`bpftrace -l 'libjvm.so:*'` 没有输出。作为替代，JVM 内置了 **JFR**（Java Flight Recorder），通过 `-XX:StartFlightRecording` 即可在生产环境零开销采集 GC、编译、锁竞争等数据。JFR 和动态追踪框架的对比将在后续章节详细展开。

6 个步骤的重要度分三层：

| 步骤 | 重要度 | 函数 | 一句话 |
|------|--------|------|--------|
| 1 | ★★ | `os::init_2()` | 信号处理器注册、NUMA 可用性确定 |
| 2 | ★★★ | `SafepointMechanism::initialize()` | 分配安全点轮询页面，GC 的 Stop-The-World 基础 |
| 3 | ★★ | `Arguments::adjust_after_os()` | NUMA 相关 flag 的最终联动调整 |
| 4 | ★ | `ostream_init_log()` | 日志文件初始化（收尾） |
| 5-6 | ★ | agent 转换与启动 | `-Xrun` 兼容 + `Agent_OnLoad`（通常路径直接跳过） |

---

## 1. os::init_2() —— OS 第二阶段初始化 ★★

声明在 `os.hpp`，Linux 实现在 `os_linux.cpp`。和 Stage 1 的 `os::init()` 对比：

| | `os::init()` (Stage 1) | `os::init_2()` (Stage 3) |
|---|---|---|
| 依赖参数 | 不需要 | 依赖 `Arguments::parse()` 的 flag（`UseNUMA`、`ReduceSignalUsage` 等） |
| 主要工作 | 创建 TLS key、检测页大小、采集 CPU/内存信息 | 注册信号处理器、加载 NUMA 库、校验栈尺寸 |

`os::init_2()` 的变量赋值汇总：

| 变量 | 类型 | 由谁设置 | 本机值 |
|------|------|---------|--------|
| `UseNUMA` | bool | `Linux::libnuma_init()` | **false**（本机只有 1 个 NUMA node，被关闭） |
| `UseAdaptiveSizePolicy` | bool | `os::init_2()` 内部 | false（如果 NUMA+Parallel+LargePages 冲突） |
| `UseAdaptiveNUMAChunkSizing` | bool | `os::init_2()` 内部 | false（同上） |
| `Linux::_libc_version` | const char* | `Linux::libc_version()` | `glibc 2.38`（本机 ldd 输出） |
| `Linux::_libpthread_version` | const char* | `Linux::libpthread_version()` | "NPTL 2.38" |

下面拆解四个核心动作，其余用树形图略过。

### 1.1 信号体系注册 —— 核心段落

这是 `os::init_2()` 最重要的产出。四行源码：

```c
if (SR_initialize() != 0) {
    perror("SR_initialize failed");
    return JNI_ERR;
}
Linux::signal_sets_init();
Linux::install_signal_handlers();
```

### 1.1 信号体系初始化 —— 核心段落

这是 `os::init_2()` 最重要的产出，三步搭建 JVM 的完整信号体系。

先搞清楚 Linux 信号的投递规则。信号的**产生方式**决定了它投递给谁：

| 信号类型 | 产生方式 | 投递目标 | 例子 |
|---------|---------|---------|------|
| 同步信号 | 当前线程自身触发的硬件异常（页错误、除零、非法指令） | **只投递给触发线程**——和线程掩码无关，内核必须让它处理 | SIGSEGV、SIGBUS、SIGFPE、SIGILL |
| 异步信号 | 外部事件（用户按 Ctrl-C、`kill` 命令、定时器到期） | 内核从"不阻塞该信号的线程"中**任选一个**投递 | SIGINT、SIGTERM、SIGALRM |
| 定向信号 | `pthread_kill(thread_id, sig)` | **只投递给指定线程**，不受掩码限制 | HotSpot 的 `SR_signum` |

这个区别至关重要：同步信号没有"挑选"的过程，触发线程必须处理它。如果触发线程阻塞了该信号，内核直接杀进程。

每线程有自己的信号掩码（signal mask），函数 `pthread_sigmask(SIG_BLOCK/SIG_UNBLOCK/SIG_SETMASK, &set, &old)` 控制阻塞哪些信号。同步信号的触发线程如果阻塞了该信号，行为是未定义的——通常导致进程被内核杀死。

`signal_sets_init()` 准备两张掩码表，后续创建线程时分别应用。三步按运行时顺序讲解：

**第一步：线程挂起/恢复信号注册**


Stop-The-World 需要暂停所有 Java 线程。JVM 不是用 `pthread_kill(SIGSTOP)`，而是用自己的信号 `SR_signum`：

```c
// === os_linux.cpp ===
static int SR_initialize() {
  struct sigaction act;

  // 信号号：环境变量 _JAVA_SR_SIGNUM 可覆盖，默认取 > max(SIGSEGV, SIGBUS) 的可用信号
  if ((s = ::getenv("_JAVA_SR_SIGNUM")) != 0) {
    SR_signum = strtol(s, 0, 10);
  }

  sigemptyset(&SR_sigset);
  sigaddset(&SR_sigset, SR_signum);

  act.sa_flags = SA_RESTART | SA_SIGINFO;
  act.sa_handler = (void (*)(int)) SR_handler;   // 处理器：SR_handler
  sigaction(SR_signum, &act, 0);                 // 向内核注册

  return 0;
}
```

`SR_handler` 是挂起等待的处理函数。当 VMThread 需要 Stop-The-World 时，对每个 Java 线程调 `pthread_kill(thread_id, SR_signum)` 发送此信号。收到信号的线程在 `SR_handler` 中检查自己是否需要暂停，如果需要就阻塞等待。

`_JAVA_SR_SIGNUM` 环境变量允许嵌入式场景自定义信号号（避免冲突）。


**第二步：信号集初始化**


```c
// === os_linux.cpp ===
void os::Linux::signal_sets_init() {
  sigemptyset(&unblocked_sigs);
  sigaddset(&unblocked_sigs, SIGILL);    // 非法指令
  sigaddset(&unblocked_sigs, SIGSEGV);   // 段错误
  sigaddset(&unblocked_sigs, SIGBUS);    // 总线错误
  sigaddset(&unblocked_sigs, SIGFPE);    // 浮点异常
  sigaddset(&unblocked_sigs, SR_signum); // suspend/resume 信号
  // ... SHUTDOWN 信号（Ctrl-C 等，ReduceSignalUsage=false 时）
}
```

两张掩码的用途：

- `unblocked_sigs` —— 后续创建每个线程时，用 `pthread_sigmask(SIG_UNBLOCK, &unblocked_sigs, NULL)` 解除对这些信号的阻塞。SIGSEGV/SIGBUS/SIGFPE/SIGILL 是同步信号，触发线程必须能接收，否则内核直接杀进程。`SR_signum` 虽然会被 `pthread_kill` 定向发送，但收到信号的线程也需要不被阻塞才能进入 `SR_handler`。
- `vm_sigs` —— 包含 `BREAK_SIGNAL`。创建线程时普通 Java 线程阻塞它，只有 VMThread 解除阻塞。BREAK_SIGNAL 是异步信号（用户按 Ctrl-Break），内核从不阻塞它的线程中选一个——因为只有 VMThread 不阻塞，所以始终投递给 VMThread，由它输出线程 dump。


**第三步：业务信号处理器注册**

```c
// === os_linux.cpp ===
void os::Linux::install_signal_handlers() {
  if (!signal_handlers_are_installed) {
    signal_handlers_are_installed = true;

    set_signal_handler(SIGSEGV, true);   // 段错误
    set_signal_handler(SIGPIPE, true);   // 管道破裂
    set_signal_handler(SIGBUS,  true);   // 总线错误
    set_signal_handler(SIGILL,  true);   // 非法指令
    set_signal_handler(SIGFPE,  true);   // 浮点异常
    set_signal_handler(SIGXFSZ, true);   // 文件大小超限
  }
}
```

`set_signal_handler` 内部调用 Linux 的 `sigaction()`：

```c
void os::Linux::set_signal_handler(int sig, bool set_installed) {
  struct sigaction sigAct;
  sigfillset(&(sigAct.sa_mask));
  sigAct.sa_sigaction = signalHandler;       // 统一入口函数
  sigAct.sa_flags = SA_SIGINFO | SA_RESTART;
  sigaction(sig, &sigAct, &oldAct);
}
```

关键参数 `SA_SIGINFO` 让内核在信号到达时提供 `siginfo_t` 结构体（包含触发地址 `si_addr`）。同一个信号处理器 `signalHandler`、同一种信号 SIGSEGV，通过 `si_addr` 区分三种触发源：

- `si_addr` 在零页附近 → NullPointerException（隐式 null check）
- `si_addr` 在栈保护页范围 → StackOverflowError（Stage 2 的 `mprotect(PROT_NONE)`）
- `si_addr` 在安全点轮询页 → 线程挂起等待 GC（本章后续的 `SafepointMechanism::initialize()`）

**综合时间线——空指针怎么变成 NullPointerException：**

一台机器的 Java 方法拿到了一个 `null` 对象引用。对它的`field`字段进行写操作。HotSpot 不会先生成 `if (o == null)` 的检查代码——而是直接计算`o+field_offset`的地址，向这个地址写入一个新值。计算时`o = null`加上偏移量，得到的是一个位于`0x00`附近的极低地址。

CPU 的 MMU 查找页表，发现这个地址所在的页面被映射为了`PROT_NONE`。内存控制器向 CPU 报告一个 page fault。内核从中断向量表中查找对应的处理程序，把page fault转换为一个 SIGSEGV 信号——`si_addr` 记录了那个触发的地址。

内核检查自己维护的进程信号掩码和线程信号掩码，确定这个信号要发送给当前正在运行的线程。kill系统调用的 `signo=SIGSEGV`, `si_code=SEGV_ACCERR`, `si_addr=<那个极低地址>` 组成的 `siginfo_t` 被压入当前线程的内核栈。调度器选择此线程作为下一次运行的候选后，在返回用户空间之前把信号帧推入用户栈，然后跳转到 HotSpot 注册的 `signalHandler(sig=11, info=包含故障地址的siginfo_t, uc=用户态上下文)`。

`signalHandler` 拿到 `si_addr` —— 一个极低地址，检查是零页附近。走NullPointer的逻辑，从当前栈帧中获取被中断的Java方法，为该帧创建一个NullPointerException对象，然后直接修改 `uc->uc_mcontext.gregs[REG_RIP]` 指向异常抛出桩——返回到 Java 层的异常处理代码。

**`sigaction` 结构体——HotSpot 为什么选 `SA_SIGINFO | SA_RESTART`：**

```c
struct sigaction {
    void     (*sa_handler)(int);                              // 简单版：只有信号号
    void     (*sa_sigaction)(int, siginfo_t *, void *);       // 完整版：带 siginfo + ucontext
    sigset_t   sa_mask;                                       // 处理该信号时额外屏蔽的信号
    int        sa_flags;
};
```

两个处理器字段二选一：如果 `sa_flags` 包含 `SA_SIGINFO`，用 `sa_sigaction`（三个参数，能拿到 `si_addr`）；否则用 `sa_handler`（只有一个信号号）。HotSpot 必须用 `SA_SIGINFO`——没有 `si_addr` 就无法区分三种 SIGSEGV 的触发源。

`SA_RESTART` 的作用：当 `signalHandler` 处理 SIGSEGV 时，内核会自动重启当时被中断的可中断系统调用（`futex`、`read` 等），避免返回 `EINTR`。没有这个 flag，每次信号处理完，线程上正在进行的 `pthread_cond_wait`、`epoll_wait` 都会报 `EINTR` 错误。

### 1.2 NUMA 初始化

Stage 2 的 `apply_ergo` 可能已设置 `UseNUMA = true`，但 NUMA 是否真的可用，需要 `os::init_2()` 在运行时验证：

```c
if (UseNUMA) {
    if (!Linux::libnuma_init()) {
        UseNUMA = false;
    } else {
        if ((Linux::numa_max_node() < 1) || Linux::isbound_to_single_node()) {
            UseNUMA = false;
        }
    }
}
```

`libnuma_init()` 通过 `dlopen("libnuma.so")` 加载 NUMA 库。加载失败或机器只有 1 个 NUMA node（本机就是 1 个 node，所以 `UseNUMA` 被设为 false），NUMA 就没有意义，关闭它。

这解释了为什么 `Arguments::adjust_after_os()` 必须放在 `os::init_2()` 之后——`os::init_2()` 可能改变 `UseNUMA`，`adjust_after_os()` 必须在最终值上做联动。

### 1.3 其余步骤 —— 树形图略过

```
os::init_2() 其余步骤：
├── Fast thread clock 初始化      -- Linux 特有优化，用 CLOCK_THREAD_CPUTIME_ID 替代昂贵系统调用
├── set_minimum_stack_sizes       -- 校验 -Xss 不小于 OS 允许的线程栈最小值
├── capture_initial_stack         -- 非 java launcher 场景下捕获原始线程栈地址
├── libpthread_init / sched_getcpu_init  -- dlsym 查找 pthread 函数指针
├── glibc guard page 调整         -- __GLIBC__ 分支：调整 glibc 默认 guard page 对栈尺寸的影响
├── MaxFDLimit 处理              -- getrlimit/setrlimit 提升文件描述符上限
├── new Mutex("createThread_lock") -- 线程创建互斥锁
├── atexit(perfMemory_exit_helper) -- 进程退出时清理性能监控共享内存
├── prio_init()                  -- 线程优先级策略初始化（ThreadPriorityPolicy）
└── set_coredump_filter()        -- core dump 过滤器（AllocateHeapAt/DAX 相关）
```

**小结**：`os::init_2()` 的核心产出是信号处理器注册——后续所有 SIGSEGV（空指针、栈溢出、安全点）都由这一个入口处理。附带验证了 NUMA 可用性，可能修改 `UseNUMA` 的值。

---

## 2. SafepointMechanism::initialize() —— 安全点轮询页面 ★★★

这是 Stage 3 最核心的部分。安全点（Safepoint）是 JVM 最基本的同步机制：当 JVM 需要执行 GC、偏向锁撤销、去优化等全局操作时，必须让所有 Java 线程停在安全点上。

实现方式：每个 Java 线程在"安全点检查位置"（方法返回、循环回边）读取一个"是否需要停止"的标志。JDK 11 引入了 `ThreadLocalHandshakes`（JEP 312）——每个线程有自己的安全点轮询位置（thread-local poll），替代旧的纯全局页面方式。

### 2.1 入口与数据结构

```c
// === safepointMechanism.cpp ===
void SafepointMechanism::initialize() {
  pd_initialize();              // Linux 上展开为 default_initialize()
  initialize_serialize_page();  // 内存序列化页
}

// === safepointMechanism.hpp ===
class SafepointMechanism : public AllStatic {
  enum PollingType { _global_page_poll, _thread_local_poll };
  static PollingType _polling_type;
  static void* _poll_armed_value;       // "需要停"的值
  static void* _poll_disarmed_value;    // "不用停"的值
};
```

### 2.2 核心：分配受保护的安全点页面

只展示 JDK 11 默认的 `ThreadLocalHandshakes=true` 路径：

```c
void SafepointMechanism::default_initialize() {
  if (ThreadLocalHandshakes) {
    set_uses_thread_local_poll();         // 设 _polling_type = _thread_local_poll
    intptr_t poll_armed_value   = poll_bit();  // = 8
    intptr_t poll_disarmed_value = 0;

    // 分配 2 页：bad_page (PROT_NONE) + good_page (PROT_READ)
    const size_t page_size = os::vm_page_size();            // 本机 4096
    const size_t allocation_size = 2 * page_size;           // 8192
    char* polling_page = os::reserve_memory(allocation_size, NULL, page_size);
    os::commit_memory_or_exit(polling_page, allocation_size, false, ...);

    char* bad_page  = polling_page;
    char* good_page = polling_page + page_size;

    os::protect_memory(bad_page,  page_size, os::MEM_PROT_NONE);
    os::protect_memory(good_page, page_size, os::MEM_PROT_READ);

    os::set_polling_page((address)(bad_page));

    poll_armed_value    |= reinterpret_cast<intptr_t>(bad_page);
    poll_disarmed_value |= reinterpret_cast<intptr_t>(good_page);

    _poll_armed_value    = reinterpret_cast<void*>(poll_armed_value);
    _poll_disarmed_value = reinterpret_cast<void*>(poll_disarmed_value);
  }
}
```

逐层解释：

**`set_uses_thread_local_poll()`** —— 设 `_polling_type = _thread_local_poll`。后续每创建一个 `JavaThread`，`initialize_header()` 把该线程的 polling page 指针初始化为 disarmed 状态。

**`poll_bit() = 8`** —— 为什么是 8？`bad_page` 地址按 4KB 对齐（低 12 位全 0），`| 8` 不冲突任何合法地址。JIT 编译器生成的 `test` 指令根据这个 bit 判断是否应该停下。

**两页分配 + `protect_memory(MEM_PROT_NONE)`** —— 这个操作和第 3.4 节 Stage 2 的 `create_stack_guard_pages()` 用的是同一套机制：底层都是 `mprotect(PROT_NONE)`。区别在于：

- Stage 2：保护的页面是**栈的一部分**（栈底 16KB），检测栈溢出
- 这里：保护的页面是**独立分配的两页**，检测安全点请求

**编码 tricks** —— `poll_armed_value = 8 | bad_page_addr`。线程需要被停止时，`arm_local_poll` 把线程的轮询指针设为此值。线程在方法返回处执行 `test` 指令读取此地址——bad_page 被 `PROT_NONE` 保护，读取触发 SIGSEGV。信号处理器调用 `os::is_poll_address()` 检查"地址是否在 bad_page 范围内"，如果是安全点请求，调用 `SafepointSynchronize::block()` 阻塞线程。

### 2.3 arm/disarm 机制

安全点的工作流用两个 inline 方法控制：

```c
// === safepointMechanism.inline.hpp ===
void SafepointMechanism::arm_local_poll(JavaThread* thread) {
  thread->set_polling_page(poll_armed_value());     // 指向 bad_page
}
void SafepointMechanism::disarm_local_poll(JavaThread* thread) {
  thread->set_polling_page(poll_disarmed_value());   // 指向 good_page
}
```

**完整工作流**：JVM 需要 GC --> `arm_local_poll(所有 JavaThread)` --> 线程下次检查时读取 bad_page --> SIGSEGV --> 信号处理器识别为安全点 --> `SafepointSynchronize::block()` --> GC 完成 --> `disarm_local_poll(所有线程)` --> 线程读取 good_page --> 正常通过。

### 2.4 内存序列化页

```c
void SafepointMechanism::initialize_serialize_page() {
  if (!UseMembar) {
    const size_t page_size = os::vm_page_size();
    char* serialize_page = os::reserve_memory(page_size, NULL, page_size);
    os::commit_memory_or_exit(serialize_page, page_size, false, ...);
    os::set_memory_serialize_page((address)(serialize_page));
  }
}
```

向此页写入一个值，利用 x86 的 store-load 屏障语义，确保之前所有 CPU 的内存写操作对其它 CPU 可见。GC 之后使用。`UseMembar` 默认 false，所以会分配。

### 2.5 本机状态

| 变量 | 本机值 | 含义 |
|------|--------|------|
| `_polling_type` | `_thread_local_poll` | JDK 11 默认线程本地轮询 |
| `_poll_armed_value` | `0x7f...0008` | bad_page 地址 `| 0x8` |
| `_poll_disarmed_value` | `0x7f...1000` | good_page 地址 |
| `os::_polling_page` | `0x7f...0000` | 全局轮询页地址（指向 bad_page） |
| `os::_mem_serialize_page` | `0x7f...2000` | 内存序列化页地址 |

**衔接汇总**：

- Stage 1 的 `install_signal_handlers()` 注册的 SIGSEGV 处理器 —— 安全点 SIGSEGV 由此拦截
- Stage 1 的 `ThreadLocalStorage::init()` 创建的 TLS key —— 信号处理器用 `Thread::current()` 识别当前线程
- Stage 2 的 `create_stack_guard_pages()` 的 `mprotect(PROT_NONE)` —— 和这里保护 bad_page 是同一机制
- 后续 Stage 4+ 每创建一个 `JavaThread`，`initialize_header()` 设 `polling_page = _poll_disarmed_value`

---

## 3. Arguments::adjust_after_os() —— 最终 flag 调整 ★★

`os::init_2()` 可能修改 `UseNUMA`（本机就被改成了 false），所以 flag 的最终调整必须放在它之后。函数只有 22 行：

```c
/* === src/hotspot/share/runtime/arguments.cpp === */
jint Arguments::adjust_after_os() {
  if (UseNUMA) {
    if (!FLAG_IS_DEFAULT(AllocateHeapAt)) {
      FLAG_SET_ERGO(bool, UseNUMA, false);          // 堆在文件上，NUMA 无意义
    } else if (UseParallelGC || UseParallelOldGC) {
      if (FLAG_IS_DEFAULT(MinHeapDeltaBytes)) {
         FLAG_SET_DEFAULT(MinHeapDeltaBytes, 64*M); // ParallelGC+NUMA：堆最小扩展粒度 64MB
      }
    }
    if (FLAG_IS_DEFAULT(UseNUMAInterleaving)) {
      FLAG_SET_ERGO(bool, UseNUMAInterleaving, true); // 堆内存在所有 node 交错分配
    }
  }
  return JNI_OK;
}
```

三个决策全部在 `UseNUMA=true` 的前提下才执行——本机 `UseNUMA=false`，这个函数直接 return，什么也不做。

| 变量 | 设置条件 | 值 |
|------|---------|-----|
| `UseNUMA` | `AllocateHeapAt` 被指定 | false（ergo） |
| `MinHeapDeltaBytes` | NUMA + ParallelGC + 未显式指定 | **64M**（default） |
| `UseNUMAInterleaving` | NUMA + 未显式指定 | **true**（ergo） |

**衔接 Stage 2**：`apply_ergo` 设的 `UseNUMA` 可能被 `os::init_2` 和这里两次修改——flag 生命周期从 parse 到 ergo 到 init_2 到 adjust_after_os，每步都可能改变。`FLAG_SET_ERGO` 标记为"ergo 推算"（用户可覆盖），`FLAG_SET_DEFAULT` 标记为"默认值"（用户显式指定时优先）。

---

## 4. 收尾步骤 ★

**`ostream_init_log()`** —— 和第 3.4 节 Stage 2 的 `LogConfiguration::initialize()` 互补。Stage 2 初始化了 UL（统一日志框架）的 `StdoutLog/StderrLog`，这里初始化的是通用输出（`tty`/`defaultStream`）的日志文件。触发 `defaultStream::instance->has_log_file()` 完成惰性初始化，确保 VM 崩溃时日志文件已就绪。

**agent 转换与启动** —— `convert_vm_init_libraries_to_agents()` 遍历 `-Xrun` 库，有 `Agent_OnLoad` 无 `JVM_OnLoad` 的转为 agent（历史兼容）。`create_vm_init_agents()` 调用所有 agent 的 `Agent_OnLoad(JavaVM*, options, NULL)`。两个 `if` 守卫保证只有用户显式传了 `-Xrun`/`-agentlib`/`-agentpath` 时才执行，通常路径直接跳过。

---

## Stage 3 总结

**主题一：OS 信号体系统一就绪。** 从 Stage 1 注册的 SIGSEGV 处理器，到 Stage 2 用 `mprotect` 保护的栈守卫区，到本章用 `mprotect` 保护的安全点 bad_page——整个 JVM 的信号体系在此刻统一就绪。后续所有 SIGSEGV——空指针、栈溢出、安全点——都通过同一个入口 `JVM_handle_linux_signal` 分发到各自的处理路径。

**主题二：flag 的最终锁定。** `UseNUMA` 从 Stage 2 的"声明启用"到 `os::init_2()` 的"运行时验证"再到 `adjust_after_os()` 的"联动设置"，经历了完整的生命周期。本机因为只有 1 个 NUMA node，最终 `UseNUMA = false`，`adjust_after_os()` 直接跳过。此时 200+ 个 flag 全部确定，后续不会再被修改。

**Stage 3 结束时 JVM 的状态：**
- 信号处理器就绪（SIGSEGV/SIGBUS/SIGILL）
- 安全点轮询机制就绪（bad_page + good_page + arm/disarm 值）
- 日志文件就绪（tty 可安全写入文件）

下一阶段 `vm_init_globals()` 开始用这些配置搭建 JVM 的运行时数据结构。
