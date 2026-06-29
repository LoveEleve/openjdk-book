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

先搞懂几个基本概念——不然后面每行代码都看不懂。

**`sigset_t` —— 信号的"集合"**

`sigset_t` 是一个位图（bitmap），每一位代表一个信号编号。在 Linux x86_64 上它通常是 `unsigned long sig[2]`（128 位，足够覆盖 1-64 号信号）。第 `n` 位为 1 表示信号 `n` 在集合中，为 0 表示不在。

操作它的三个函数都是普通的 C 库函数，不走系统调用——它们只是读写用户态内存里的位图：

| 函数 | 作用 | 等价伪代码 |
|------|------|-----------|
| `sigemptyset(sigset_t *set)` | 清空集合（所有位设 0） | `memset(set, 0, sizeof(sigset_t))` |
| `sigaddset(sigset_t *set, int signum)` | 把信号 `signum` 加入集合（对应位设 1） | `set->sig[word] |= 1 << bit` |
| `sigfillset(sigset_t *set)` | 填满集合（所有位设 1，包含所有信号） | `memset(set, 0xFF, sizeof(sigset_t))` |

真正跟内核交互的是以下两个系统调用：

**sigaction -- 向内核注册"信号来了调哪个函数"**

```c
int sigaction(int signum,                     // 要处理的信号编号
              const struct sigaction *act,     // 新处理器配置（NULL 表示只查询）
              struct sigaction *oldact);       // 旧处理器配置（可为 NULL）
```

`act` 是一个 `struct sigaction`，告诉内核三件事：调哪个函数、要不要附带额外信息、处理期间屏蔽哪些信号：

```c
struct sigaction {
    void (*sa_handler)(int);                      // 简单版：只拿到信号号
    void (*sa_sigaction)(int, siginfo_t *, void *); // 完整版：拿到 siginfo + ucontext
    sigset_t sa_mask;                              // 处理该信号期间内核自动屏蔽的信号集
    int      sa_flags;                             // SA_SIGINFO / SA_RESTART / SA_NODEFER
};
```

三个字段的作用用代码演示最直观。写一个简单的 C 程序：

```c
/* ===== 本机 demo: sigaction_demo.c ===== */
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

void handler(int sig, siginfo_t *info, void *ucontext) {
    printf("信号到达: sig=%d\n", sig);
    printf("  si_signo = %d\n", info->si_signo);    // 信号编号(和 sig 相同)
    printf("  si_code  = %d\n", info->si_code);     // 0=SI_USER(kill发送)
    printf("  si_addr  = %p\n", info->si_addr);     // 触发地址(硬件信号时有值)
    printf("  si_pid   = %d\n", info->si_pid);      // 发送者 PID
    printf("  ucontext = %p\n", ucontext);          // 寄存器快照指针
    _exit(0);
}

int main() {
    struct sigaction act = {0};
    act.sa_sigaction = handler;      // 用完整版处理器(三个参数)
    act.sa_flags = SA_SIGINFO;       // 要求内核填充 siginfo_t

    sigaction(SIGUSR1, &act, NULL);  // 注册: 信号 10 -> handler
    printf("PID=%d\n", getpid());

    kill(getpid(), SIGUSR1);         // 给自己发信号 10
}
```

编译运行（本机 x86_64，glibc 2.38）：

```
PID=995043
信号到达: sig=10 (User defined signal 1)
  si_signo = 10
  si_code  = 0 (SI_USER, 由 kill 发送)
  si_addr  = 0xf2ee3 (非硬件信号时为 NULL)
  si_pid   = 995043 (发送者 PID)
  ucontext = 0x7ffd92a82840 (寄存器快照)
```

关键观察：`si_code = SI_USER(0)` 说明信号由 `kill()` 发送。如果是硬件异常（SIGSEGV），`si_code` 会是 `SEGV_ACCERR` 或 `SEGV_MAPERR`，`si_addr` 指向触发地址。

那 HotSpot 在自己的信号处理器里具体怎么用这些字段的？它是注册了一个统一的入口 `signalHandler` → `JVM_handle_linux_signal`，然后在 `os_linux_x86.cpp` 里根据 `si_addr` 做三层分发：

```c
// === os_linux_x86.cpp (HotSpot 的 SIGSEGV 处理核心) ===
JVM_handle_linux_signal(int sig, siginfo_t* info, void* ucVoid, ...) {
  // ...
  if (sig == SIGSEGV) {
    address addr = (address) info->si_addr;   // 拿到触发地址

    // 第 1 层: 地址在线程栈上？
    if (thread->on_local_stack(addr)) {
      if (thread->in_stack_yellow_reserved_zone(addr)) {
        // → StackOverflowError: 先解开 yellow zone 保护,
        //   让异常处理代码有栈空间, 然后抛异常
      } else if (thread->in_stack_red_zone(addr)) {
        // → 致命 red zone 违反: 不可恢复, 打印错误
      }
    }

    // 第 2 层: 地址是安全点轮询页？
    if (sig == SIGSEGV && os::is_poll_address((address)info->si_addr)) {
      // → 安全点: 阻塞当前线程, 等待 GC 完成
    }

    // 第 3 层: 隐式空指针?
    if (!MacroAssembler::needs_explicit_null_check((intptr_t)info->si_addr)) {
      // → NullPointerException: si_addr 在零页附近,
      //   JIT 没有生成 if(o==null) 检查, 直接抛 NPE
    }
  }
}
```

三层检查的顺序是关键：先查栈溢出（最紧急，需要立即处理），再查安全点（不能阻塞在 GC 里抛 NPE），最后查空指针。三个分支都靠 `info->si_addr` 这一个字段来区分——这就是为什么 `SA_SIGINFO` 是必须的。

`sa_mask` 的作用：如果 handler 执行期间不希望被某些信号打断（比如正在处理 SIGSEGV 时又来一个 SIGSEGV），把这些信号放进 `sa_mask`，内核自动屏蔽。`sa_flags = SA_SIGINFO` 是必须的——没有它，内核不填充 `siginfo_t`，handler 只能拿到信号号，拿不到 `si_addr`。

**`pthread_sigmask` —— 修改当前线程的信号掩码（阻塞/解除阻塞）**

```c
int pthread_sigmask(int how,                    // SIG_BLOCK 加阻塞 / SIG_UNBLOCK 解阻塞 / SIG_SETMASK 替换
                    const sigset_t *set,         // 要操作的新信号集
                    sigset_t *oldset);           // 旧掩码（可为 NULL）
```

每个线程有自己的信号掩码位图。内核在投递信号前检查目标线程的掩码——如果信号位为 1（阻塞），信号挂起不投递。`pthread_sigmask` 不阻塞调用线程自身——它只是一个读写掩码的原子操作（futex 保护）。HotSpot 用它实现"只有 VMThread 能收到 Ctrl-Break"（所有普通线程阻塞 BREAK_SIGNAL，只有 VMThread 解除阻塞）。

有了这些基础，看信号的投递规则：

| 信号类型 | 产生方式 | 投递目标 | 例子 |
|---------|---------|---------|------|
| 同步信号 | 当前线程自身触发的硬件异常（页错误、除零、非法指令） | **只投递给触发线程**——和线程掩码无关，内核必须让它处理 | SIGSEGV、SIGBUS、SIGFPE、SIGILL |
| 异步信号 | 外部事件（用户按 Ctrl-C、`kill` 命令、定时器到期） | 内核从"不阻塞该信号的线程"中**任选一个**投递 | SIGINT、SIGTERM、SIGALRM |
| 定向信号 | `pthread_kill(thread_id, sig)` | **只投递给指定线程**，不受掩码限制 | HotSpot 的 `SR_signum` |

这个区别至关重要：同步信号没有"挑选"的过程，触发线程必须处理它。如果触发线程阻塞了该信号，内核直接杀进程。

每线程有自己的信号掩码（signal mask），函数 `pthread_sigmask(SIG_BLOCK/SIG_UNBLOCK/SIG_SETMASK, &set, &old)` 控制阻塞哪些信号。同步信号的触发线程如果阻塞了该信号，行为是未定义的——通常导致进程被内核杀死。

`signal_sets_init()` 准备两张掩码表，后续创建线程时分别应用。三步按运行时顺序讲解：

**第一步：线程挂起/恢复信号注册**

Stop-The-World 需要暂停所有 Java 线程。JVM 不是用 pthread_kill(SIGSTOP)，而是用自己的信号 SR_signum。

首先看完整源码，再拆开解释：

```
// === os_linux.cpp ===
static int SR_signum = SIGUSR2;   // 默认信号号：12（SIGUSR2）

static int SR_initialize() {
  struct sigaction act;

  // 可通过环境变量覆盖信号号，但必须 > max(SIGSEGV=11, SIGBUS=7)
  if ((s = ::getenv("_JAVA_SR_SIGNUM")) != 0) {
    SR_signum = strtol(s, 0, 10);
  }

  sigemptyset(&SR_sigset);
  sigaddset(&SR_sigset, SR_signum);       // 把 SR_signum 加入集合，方便后续用 sigismember 检查

  act.sa_flags = SA_RESTART | SA_SIGINFO;
  act.sa_handler = (void (*)(int)) SR_handler;   // 收到信号时调 SR_handler

  // 把当前线程（主线程）的阻塞信号集读到 act.sa_mask 里。
  // SR_signum 此时被阻塞，所以 act.sa_mask 包含 SR_signum。
  // sigaction 注册后，任何线程收到 SR_signum 时，内核自动
  // 在 handler 执行期间屏蔽 act.sa_mask 中的信号，防止重入。
  pthread_sigmask(SIG_BLOCK, NULL, &act.sa_mask);

  sigaction(SR_signum, &act, 0);           // 向内核注册信号处理器
  return 0;
}

// === 使用场景（不在此刻调用，后续 Stop-The-World 时调用）===
static int sr_notify(OSThread* osthread) {
  int status = pthread_kill(osthread->pthread_id(), SR_signum);
}
```

逐行拆解——每行为什么这样写：

`SR_signum = SIGUSR2` 默认取 POSIX 的用户自定义信号 2（编号 12）。为什么不用 SIGSTOP（19）？因为 SIGSTOP 不能被捕获或忽略——内核收到 SIGSTOP 直接暂停线程，不给 JVM 任何执行 handler 的机会。而 Stop-The-World 的需求是：线程收到信号后，要先进 handler 检查安全点状态、判断自己是否需要阻塞、记录 JFR 事件——这些逻辑必须在 handler 里跑。所以不能

`getenv("_JAVA_SR_SIGNUM")` 允许环境变量覆盖信号号。有些嵌入式场景（比如 JVM 被嵌入到一个已经用了 SIGUSR2 的 C 程序里），可以换个不冲突的号。但必须 > max(SIGSEGV=11, SIGBUS=7)，因为低编号信号被 JVM 的业务信号占用了（见第三步的 `install_signal_handlers`）。

`sigemptyset(&SR_sigset)` 和 `sigaddset(&SR_sigset, SR_signum)` 把信号 12 单独放进 `SR_sigset` 位图里。后续代码用 `sigismember(&SR_sigset, sig)` 检查"这个信号是不是 suspend/resume 信号"——判断一次位图和判断一次整数 `sig == SR_signum` 等效，但位图方式在批量检查多个信号时更高效。

`act.sa_handler = SR_handler` 告诉内核：收到信号 12 时，调 `SR_handler`。和第三步 `install_signal_handlers()` 注册的 `signalHandler` 是**两个不同的处理器**——`signalHandler` 统一处理 SIGSEGV/SIGBUS 等业务信号，`SR_handler` 只处理 suspend/resume 信号。suspend/resume 不需要知道"哪个地址触发的"，只需要知道"有线程要我停下来"，所以这里用 `sa_handler` 而非 `sa_sigaction`。

`pthread_sigmask(SIG_BLOCK, NULL, &act.sa_mask)` 是最容易被误解的一行。它的作用是读当前线程（主线程）的阻塞信号集，写入 `act.sa_mask`。然后 `sigaction` 把这个集合告诉内核：**以后任何线程进入 `SR_handler` 时，内核自动屏蔽 `act.sa_mask` 中的所有信号**（相当于在处理期间临时 `SIG_BLOCK` 这些信号，handler 返回时自动恢复）。

这行代码的关键在于：`SR_signum` 默认是被阻塞的（注释写着 "SR_signum is blocked by default"），所以它一定在阻塞集中，也就一定在 `act.sa_mask` 里。效果：线程 A 正在 `SR_handler` 里处理 suspend 请求时，如果 VMThread 又对它发了另一个 `SR_signum`——第二个信号被内核自动屏蔽，不会重入打断正在执行的 handler。handler 结束后屏蔽自动解除。

`sigaction(SR_signum, &act, 0)` 把上面的全部配置注册到内核。从此整个进程里任何线程收到信号 12，内核都会：屏蔽 `act.sa_mask` 中的信号 → 调 `SR_handler` → handler 返回后恢复原掩码。

**使用时间线：**

此刻（os::init_2）— 只做注册。内核记录了"信号 12 -> SR_handler"的映射，但没有任何线程收到这个信号。

Stop-The-World 时（未来某个 GC 触发点）— VMThread 对目标线程调 `pthread_kill(thread_id, SR_signum)`。目标线程被内核打断，进入 `SR_handler`：

```c
// === os_linux.cpp (SR_handler 核心逻辑) ===
static void SR_handler(int sig, siginfo_t* siginfo, ucontext_t* context) {
  OSThread* osthread = Thread::current()->osthread();

  os::SuspendResume::State current = osthread->sr.state();
  if (current == os::SuspendResume::SR_SUSPEND_REQUEST) {
    suspend_save_context(osthread, siginfo, context);   // 保存 CPU 上下文
    osthread->sr.set_state(os::SuspendResume::SR_SUSPENDED);  // 告诉 VMThread "已挂起"
    sigset_t suspend_set;
    sigemptyset(&suspend_set);
    sigaddset(&suspend_set, SR_signum);
    sigsuspend(&suspend_set);                           // 阻塞等待唤醒
    osthread->sr.set_state(os::SuspendResume::SR_RUNNING);   // 被唤醒,恢复执行
  }
}
```

> 这里只展示了基本骨架。`SuspendResume` 状态机的完整生命周期（`SR_RUNNING` → `SR_SUSPEND_REQUEST` → `SR_SUSPENDED` → `SR_RUNNING`）、`sigsuspend` 的工作机制、以及 VMThread 如何遍历线程协调 Stop-The-World——这些将在后续 Stop-The-World 章节单独详细讲解。眼下只需知道：此刻 `os::init_2()` 只负责注册这个处理器，为后面的使用做好准备。

为什么线程能收到？— `signal_sets_init` 把 `SR_signum` 放进了 `unblocked_sigs`，每个 Java 线程创建时都会 `pthread_sigmask(SIG_UNBLOCK, &unblocked_sigs, ...)` 解除对它的阻塞。

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
  sigAct.sa_sigaction = signalHandler;       // 业务信号的统一入口（非第一步的 SR_handler）
  sigAct.sa_flags = SA_SIGINFO | SA_RESTART;
  sigaction(sig, &sigAct, &oldAct);
}
```

关键参数 `SA_SIGINFO` 让内核在信号到达时提供 `siginfo_t` 结构体（包含触发地址 `si_addr`）。同一个信号处理器 `signalHandler`、同一种信号 SIGSEGV，通过 `si_addr` 区分三种触发源：

- `si_addr` 在零页附近 → NullPointerException（隐式 null check）
- `si_addr` 在栈保护页范围 → StackOverflowError（Stage 2 的 `mprotect(PROT_NONE)`）
- `si_addr` 在安全点轮询页 → 线程挂起等待 GC（本章后续的 `SafepointMechanism::initialize()`）

总结一下——内核根据信号编号查表来调用不同的处理器，分拣逻辑在信号号一层就已经分开了：

| 信号编号 | 信号名 | 处理器 | 注册步骤 |
|---------|--------|--------|---------|
| 12 | SIGUSR2 (SR_signum) | `SR_handler` | 第一步 |
| 11 | SIGSEGV | `signalHandler` | 第三步 |
| 7 | SIGBUS | `signalHandler` | 第三步 |
| 4 | SIGILL | `signalHandler` | 第三步 |
| 8 | SIGFPE | `signalHandler` | 第三步 |

`SR_handler` 和 `signalHandler` 互不干扰——不是因为代码里做了判断，而是因为它们被注册到了不同的信号号上。内核收到信号时，直接根据信号号查进程的 `sighand` 表，找到对应的 `struct sigaction`，执行里面的函数指针。

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

### 1.3 线程创建锁 + 优先级策略

`set_createThread_lock` 创建一个 HotSpot 的 Mutex：

```c
// === os_linux.cpp (os::init_2 中) ===
Linux::set_createThread_lock(new Mutex(Mutex::leaf, "createThread_lock", false));
```

`Mutex` 的构造函数（`mutex.cpp`）：

```c
Mutex::Mutex(int Rank, const char * name, bool allow_vm_block,
             SafepointCheckRequired safepoint_check_required) {
  ClearMonitor((Monitor *) this, name);   // 清零全部字段, 设锁名
#ifdef ASSERT
  _allow_vm_block = allow_vm_block;       // VMThread 能否阻塞在此锁上
  _rank           = Rank;                 // 死锁检测的 rank
  NOT_PRODUCT(_safepoint_check_required = safepoint_check_required;)
#endif
}
```

三个参数逐一解释：

| 参数 | 传入值 | 含义 |
|------|--------|------|
| `Rank` | `Mutex::leaf` | rank = leaf（约 15），位于 `suspend_resume` 和 `safepoint` 之间。debug 构建中，持有此锁后只能获取 rank > leaf 的锁。 |
| `allow_vm_block` | `false` | VMThread 不允许在此锁上阻塞。防止 safepoint 期间 VMThread 等锁、锁持有者在等 safepoint 的死锁。 |
| `safepoint_check_required` | `_safepoint_check_always`（默认） | 加锁时强制检查 safepoint——如果 GC 正在进行，Java 线程会主动停下。VMThread 用 `lock_without_safepoint_check()` 跳过。 |

构造函数内部调用 `ClearMonitor` 把整个 `Monitor` 清空——包括 `_LockWord=0`（锁空闲、无人排队）、`_owner=NULL`、`_EntryList/_WaitSet` 全部空。之后这个锁就可以用了：`MutexLocker ml(lock)` 拿锁干活，析构自动释放。

`prio_init()` 初始化 Java 线程优先级到 OS 优先级的映射表。

先补一点 Linux 的背景。Linux 调度器用 nice 值控制线程的相对优先级，man 手册 `nice(1)` 的定义：

> "Niceness values range from -20 (most favorable to the process) to 19 (least favorable to the process)."

nice 越小，调度器分给线程的 CPU 时间片越多。普通线程默认 `nice=0`，root 用户可以把线程降到 `nice=-20`（最高优先级）。HotSpot 预定义了这条映射表，`os_linux.cpp`：

```c
// === os_linux.cpp ===
int os::java_to_os_priority[CriticalPriority + 1] = {
  19,   //  0  Entry (未使用)
   4,   //  1  MinPriority        ← Java 最低优先级映射
   3,   //  2
   2,   //  3
   1,   //  4
   0,   //  5  NormPriority       ← Java 普通优先级 = nice 0
  -1,   //  6
  -2,   //  7
  -3,   //  8
  -4,   //  9  NearMaxPriority
  -5,   // 10  MaxPriority        ← Java 最高优先级 = nice -5
  -5    // 11  CriticalPriority   ← 和 MaxPriority 相同（nice -5）
};
```

`ThreadPriorityPolicy` 控制这套映射是否生效：

| 值 | 含义 | 生产环境用吗？ |
|----|------|--------------|
| 0 | 关闭：所有线程优先级相同（`nice=0`）。最安全，没有权限问题 | 极少用，吞吐量可能下降 |
| 1 | 激进：直接使用上表映射，对 Java 线程调 `setpriority()` 设置 nice 值。需要 root 或 `CAP_SYS_NICE` | 只在专用物理机上`以 root 运行 JVM 时使用` |
| 2 | **默认**：只在操作系统支持且当前用户有权限时才启用映射。Linux 上非 root 用户运行等价于策略 0 | **绝大多数生产环境就是此值** |

`UseCriticalJavaThreadPriority`（flag `-XX:+UseCriticalJavaThreadPriority`，默认 false）打开时，`MaxPriority` 被升级到 `CriticalPriority` 的值——两者默认都是 nice=-5，所以开启后 MaxPriority 不变。但如果管理员手动调高了 `CriticalPriority`（比如 nice=-10），GC 线程、CompilerThread 等关键线程就能获得更高调度优先级。

**生产环境上的实际情况**：绝大多数部署直接用默认 `ThreadPriorityPolicy=2`。非 root 下映射不生效，所有 Java 线程都是 `nice=0`。只有在以 root 运行的专用 JVM 上（比如某些金融交易系统、高频计算场景），管理员才会手动设 `-XX:ThreadPriorityPolicy=1`，让垃圾收集线程获得更高的 CPU 调度优先级。

### 1.4 最小栈尺寸 — 和 Stage 2 的栈守卫区联动

```c
// === os_posix.cpp ===
if (Posix::set_minimum_stack_sizes() == JNI_ERR) {
    return JNI_ERR;
}
```

这个函数计算 `_java_thread_min_stack_allowed`——JVM 允许创建 Java 线程的最小栈大小。计算公式：

```
最小栈 = 守卫区总大小 (red+yellow+reserved) + shadow zone + OS 要求的额外空间
```

这正好和 Stage 2 的 `init_before_ergo` 连接起来——Stage 2 设置了 `_stack_red_zone_size` 等四个静态变量，这里把它们加起来，再加上 OS 的默认线程栈最小值（通过 `pthread_attr_getstacksize` 获取），作为 Java 线程的最小栈限制。如果用户通过 `-Xss` 指定的值小于这个最小值，线程创建时会拒绝。

**Linux 底层机制：** 每个 Linux 线程的栈由 `pthread_create` 调用时 `clone(CLONE_VM|CLONE_FS|...)` 系统调用分配。glibc 维护一个线程栈缓存池——线程退出后栈空间被回收重用，避免频繁的 `mmap/munmap`。HotSpot 计算的最小值就是在和 glibc 协商"给我至少这么大的空间，不然守卫区放不下"。

### 1.5 获取当前线程的栈边界

> **正常流程下这里什么都不做。** 标准 `java MyClass` 启动时，`Arguments::created_by_java_launcher()` 返回 true，`if` 条件不成立，这段代码直接跳过。只有当 JVM 被嵌入到其他 C 程序（Tomcat jsvc、IDE 插件等）时才需要执行。以下内容了解即可。

```c
// === os_linux.cpp ===
if (!Arguments::created_by_java_launcher()) {   // 不是标准 java 命令启动
    Linux::capture_initial_stack(JavaThread::stack_size_at_create());
}
```

Stage 2 的 `init_before_ergo` 已经算好了栈守卫区的大小，但那些值要能工作，必须先知道当前线程的栈到底在哪——从哪个地址开始，到哪个地址结束。这个问题看似简单，实际上分成两种情况：

**标准 `java` 启动时：** 进程是 `java` 命令，`main` 线程是第一个线程。Stage 1 的 `os::init()` 阶段已经通过 `record_stack_base_and_size()` 拿到了栈的起止地址（当时程序刚启动，栈指针就在栈顶附近，直接读 `%rsp` 即可）。这里不需要再捕获，直接跳过。

**非标准启动时：** 进程可能是 Tomcat（C 程序内加载 libjvm.so）、可能是 IDE（内嵌 JVM 插件）、可能是 `jsvc`（daemon 方式启动）。调用 `JNI_CreateJavaVM()` 的线程根本不是 `java` 命令的主线程——HotSpot 不知道这个线程的栈有多大，但后续必须在这上面画守卫区、做溢出检测。

`capture_initial_stack` 就是解决这个问题的。它要得到两个值：栈的**顶部**（起始地址，高地址端）和栈的**大小**。大小相对简单——直接 `getrlimit(RLIMIT_STACK)` 读当前进程的栈软限制（`ulimit -s`）。难的是找栈顶部，源码（`os_linux.cpp`）按三层优先级尝试：

```
1. dlsym(RTLD_DEFAULT, "__libc_stack_end")
     ↑ glibc 的私有变量, 进程启动时保存了初始栈指针位置

2. 如果 __libc_stack_end 为空:
     解析 /proc/self/stat 的 start_stack 字段(第 28 个字段)
     ↑ 内核记录的这个进程的 stack_start, 和真正的栈顶非常接近

3. 如果 /proc 也没挂载(如 chroot 环境):
     直接用当前栈指针 %rsp + RLIMIT_STACK 估算
     ↑ 最简单也最不可靠的 fallback, 但在大部分情况够用
```

拿到栈顶后还要做一个兼容性处理：glibc 的 `ld.so`（动态链接器）有个 bug（JDK bug 6308388）——它会把自身的 `.data` 段重定位到原始栈的低端。如果 HotSpot 直接在栈底画守卫页（`mprotect(PROT_NONE)`），可能会把 `ld.so` 的数据页一起保护掉，导致进程崩溃。所以实测栈大小减去 2 页再做保护。减去 2 页是因为 ld.so 的重定位数据和 guard page 顶多占用这么多空间。

### 1.6 glibc 守卫页兼容性 — HotSpot 与 glibc 的协商

```c
// === os_linux.cpp (__GLIBC__ 分支) ===
static void init_adjust_stacksize_for_guard_pages() {
  _get_minstack_func = (GetMinStack)dlsym(RTLD_DEFAULT, "__pthread_get_minstack");
  if (_get_minstack_func != NULL) {
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    size_t min_stack = _get_minstack_func(&attr);           // guard=0 时的最小栈
    pthread_attr_setguardsize(&attr, 16 * K);               // 设一个 guard 值
    size_t min_stack2 = _get_minstack_func(&attr);          // 有 guard 时的最小栈
    pthread_attr_destroy(&attr);
    _adjustStackSizeForGuardPages = (min_stack2 != min_stack);  // 不同则需调整
  }
}
```

glibc 的 `pthread_create` 会在每个线程栈底自动加一个 guard page（通过 `mprotect(PROT_NONE)`）。如果 glibc 在计算最小栈大小时已经把 guard page 算在内了，HotSpot 就不需要再加一份——否则栈会多浪费一页。`__pthread_get_minstack` 是 glibc 的私有函数（命名以双下划线开头，不对外公开 API），HotSpot 通过 `dlsym(RTLD_DEFAULT, "__pthread_get_minstack")` 动态查找。比较"设了 guard"和"没设 guard"的最小栈值，如果两者不同说明 glibc 已经算进去了，HotSpot 就不额外加。

注意 HotSpot 在 `os::create_thread()` 中把 glibc guard 设为 0（`pthread_attr_setguardsize(&attr, 0)`）——因为 HotSpot 有自己的四层守卫区，不需要 glibc 再画一个。

### 1.7 其余步骤

```
os::init_2() 其余步骤：
├── fast_thread_clock_init        -- 用 CLOCK_THREAD_CPUTIME_ID 替代 clock_gettime, 快 10 倍以上
├── libpthread_init               -- dlsym(RTLD_DEFAULT) 查找 pthread_condattr_setclock
├── sched_getcpu_init             -- dlsym(RTLD_DEFAULT) 查找 sched_getcpu, 用于 NUMA node 判断
├── MaxFDLimit 处理              -- setrlimit(RLIMIT_NOFILE) 把文件描述符上限提到硬限制
```

### 1.8 PerfData 共享内存退出清理

PerfData 是 HotSpot 内置的性能监控数据区，`jstat`、`jcmd PerfCounter.print` 等命令通过它读取 JVM 运行指标。它的实现涉及四个 Linux 系统调用，先逐一铺垫。

**`mmap` —— 虚拟内存映射**

`mmap` 是 Linux 上最核心的内存分配原语，JVM 从堆、code cache 到 PerfData 共享内存全用它。man 手册 `mmap(2)` 给出了完整签名：

```c
void *mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset);
```

六个参数逐一拆解：

`addr` —— 期望映射到哪个虚拟地址。传 `NULL` 让内核自己选（最常用）；传非 `NULL` 是 hint，内核会选一个接近的地址；加 `MAP_FIXED` 则强制精确地址。man 原文：*"If addr is NULL, then the kernel chooses the (page-aligned) address at which to create the mapping; this is the most portable method."*

`length` —— 映射的字节数。必须大于 0，内核会向上取整到页大小。

`prot` —— 页的访问权限，按位 OR 组合：

| 值 | 含义 |
|----|------|
| `PROT_READ` | 可读 |
| `PROT_WRITE` | 可写 |
| `PROT_EXEC` | 可执行（JIT 编译的代码需要这个） |
| `PROT_NONE` | 不可访问 |

JVM 对 code cache 设置 `PROT_READ | PROT_WRITE | PROT_EXEC`（编译后先写代码再执行），对安全点页面 set `PROT_NONE`（故意让其不可访问来触发 SIGSEGV）。

`flags` —— 控制映射行为的核心参数，分为两类：

第一类是共享策略，**必须选其一**：

| flag | 含义 | HotSpot 哪里用 |
|------|------|---------------|
| `MAP_SHARED` | 对映射的修改对其他进程可见，且写回底层文件。man："Updates to the mapping are visible to other processes mapping the same region" | PerfData 共享内存（`jstat` 进程需要读到 JVM 进程写的数据） |
| `MAP_PRIVATE` | 私有写时复制（copy-on-write）。修改对其他进程不可见，不写回文件。man："Updates to the mapping are not visible to other processes" | JVM 堆、code cache、metaspace（不需要跨进程共享） |

第二类是附加标志，可以 OR 在第一类之上：

| flag | 含义 | HotSpot 哪里用 |
|------|------|---------------|
| `MAP_ANONYMOUS` | 不关联任何文件，`fd` 被忽略，内容初始化为零。man："The mapping is not backed by any file; its contents are initialized to zero." | 所有不需要文件支撑的内存分配（堆、code cache 等） |
| `MAP_NORESERVE` | 不为映射预留 swap 空间。man："Do not reserve swap space for this mapping." | JVM 堆——避免为 GB 级堆预留 swap |
| `MAP_HUGETLB` | 使用大页（2MB/1GB）。和 `MAP_HUGE_2MB` 等配合指定大小 | large page 堆（`-XX:+UseLargePages`） |
| `MAP_FIXED` | 精确地址——强制在 addr 处映射，可能覆盖已有映射。man："place the mapping at exactly that address. If the specified address cannot be used, mmap() will fail." | code cache 需要固定地址的极少场景 |

`fd` —— 文件描述符。如果是 `MAP_ANONYMOUS`，fd 被忽略（可传 -1）。手动 `mmap(2)` 原文：*"After the mmap() call has returned, the file descriptor, fd, can be closed immediately without invalidating the mapping."* —— mmap 返回后就可以 `close(fd)`，内核通过 inode 引用计数保持文件存活。

`offset` —— 文件内的起始偏移，必须是页大小的倍数（`sysconf(_SC_PAGE_SIZE)`）。

**PerfData 的用法：** 先 `open()` 创建 `/tmp/hsperfdata_<user>/<pid>`，然后 `mmap(NULL, 32KB, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0)`，然后立刻 `close(fd)`。`MAP_SHARED` 确保 JVM 写入的值对 `jstat` 的 `mmap` 可见。

**`msync` —— 把内存变更强制刷回磁盘**

man 手册 `msync(2)`:

> "msync() flushes changes made to the in-core copy of a file that was mapped into memory using mmap(2) back to the filesystem. Without use of this call, there is no guarantee that changes are written back before munmap(2) is called."

`mmap` 的变更是"懒写入"的——内核可能延迟把脏页写回磁盘。进程退出时，如果直接 `munmap`，最近的一些计数器更新可能丢在页缓存里没落盘。`msync(MS_SYNC)` 强制立刻刷入。PerfData 在清理前会先 msync。

**`munmap` —— 解除内存映射**

释放 `mmap` 分配的虚拟地址空间，对应的物理页被回收。man 手册 `munmap(2)`：`"The munmap() system call deletes the mappings for the specified address range"`。

**`unlink` —— 删除文件**

`unlink(2)` 从文件系统中移除文件名。注意：即使 `unlink` 成功返回，文件内容不会立刻从磁盘消失——它只删除"目录项"（文件名到 inode 的链接）。如果仍有进程打开了这个文件（有 fd 或 mmap 映射），inode 和数据块会保留到最后一个引用关闭后才真正释放。这就是为什么先 msync → munmap → 再 unlink 的顺序不能颠倒。

**`atexit` —— 注册进程退出回调**

man 手册 `atexit(3)`:

> "The atexit() function registers the given function to be called at normal process termination. Functions so registered are called in the reverse order of their registration."

`exit()` 或 `main` 返回时，C 运行时库按注册的倒序依次调用所有 `atexit` 回调。PerfData 用这个机制确保不管 JVM 从哪个代码路径退出（正常退出、`System.exit()`、甚至某些信号触发的 `_exit`），清理函数都会被调用。

有了这些基础，看 HotSpot 代码：

```c
// === os_linux.cpp ===
extern "C" {
  static void perfMemory_exit_helper() {
    perfMemory_exit();              // → msync + munmap + unlink
  }
}

if (PerfAllowAtExitRegistration) {
    if (atexit(perfMemory_exit_helper) != 0) {
        warning("os::init_2 atexit(perfMemory_exit_helper) failed");
    }
}
```

`perfMemory_exit_helper` 只做一件事：调用 `perfMemory_exit()`。后者内部的清理顺序就是上面铺垫的 `msync` → `munmap` → `unlink`。`PerfAllowAtExitRegistration` 默认 true，生产环境总是注册这个清理回调。

### 1.9 coredump 过滤器

```c
if (DumpPrivateMappingsInCore) {
    set_coredump_filter(FILE_BACKED_PVT_BIT);
}
if (DumpSharedMappingsInCore) {
    set_coredump_filter(FILE_BACKED_SHARED_BIT);
}
```

Linux 内核在进程崩溃时生成 core dump 文件，默认包含该进程的大部分内存映射。但 JVM 进程的内存占用通常很大（GB 级别的堆、code cache、metaspace），全量 core dump 不仅慢，还占用巨大磁盘空间。

> Linux 的 core dump 完整机制——信号如何触发内核生成 core、`kernel.core_pattern` 如何配置输出路径、systemd-coredump 如何处理、以及 JVM 自身的 `hs_err_pid<pid>.log` 和 core dump 的关系——将在后续 Linux 内核与 JVM 联动章节单独详细讲解。这里只需了解 HotSpot 如何通过 `/proc/self/coredump_filter` 控制被 dump 的内存映射类型。

`/proc/self/coredump_filter` 是一个按位控制的过滤器，man 手册 `core(5)` 逐项定义了每一位的含义：

| bit | 含义 | 默认值 |
|-----|------|--------|
| 0 | dump 匿名私有映射（JVM 堆、栈） | 1（默认 dump） |
| 1 | dump 匿名共享映射 | 1 |
| 2 | dump 文件映射私有映射 | 1 |
| 3 | dump 文件映射共享映射 | 1 |
| 4 | dump ELF 头 | 1 |
| 5 | dump 私有大页（HugeTLB） | 1 |
| 6 | dump 共享大页 | 1 |
| 7 | dump 私有 DAX 页面 | 0 |
| 8 | dump 共享 DAX 页面 | 0 |

HotSpot 读当前值、按位 OR 上去、再写回 `/proc/self/coredump_filter`——选择性地增加需要 dump 的映射类型。`DumpPrivateMappingsInCore` 和 `DumpSharedMappingsInCore` 都是诊断 flag（默认 false），只在需要完整 core dump 分析内存布局时手动开启。

**小结**：`os::init_2()` 的核心产出是信号处理器注册——后续所有 SIGSEGV（空指针、栈溢出、安全点）都由这一个入口处理。附带验证了 NUMA 可用性，可能修改 `UseNUMA` 的值。

---

## HotSpot 内部锁机制

`os::init_2()` 第 8 步创建的 `new Mutex(Mutex::leaf, "createThread_lock", false)` 只是 HotSpot 锁体系中的一个实例。要理解每个参数的含义，需要从底层向上逐层理解锁的设计。

HotSpot 的锁是一个**四层堆积**的结构：从最简单的 pthread 原语开始，每层加一种能力，最终形成 JVM 专属的全功能锁。

---

### 第 1 层：PlatformEvent —— 阻塞/唤醒的基本单元

最底层是一个 park/unpark 原语——只做一件事：让当前线程睡眠，或被唤醒。它用到了两个 pthread 对象，但它们的角色完全不同。

先理清 `pthread_mutex_t` 和 `pthread_cond_t` 的配合方式。

**`pthread_mutex_t`** —— 互斥锁，保护一段共享数据。在这个上下文中，它保护的是 `_nParked` 计数器——确保"检查是否有人在等"和"修改这个计数器"之间不被其他线程打断。

**`pthread_cond_t`** —— 条件变量，让线程"等一个条件变为真"。和 `pthread_mutex_t` 配合使用的标准模式：

```c
pthread_mutex_lock(&mutex);           // 1. 拿锁保护共享状态
while (!condition) {                  // 2. 检查条件
    pthread_cond_wait(&cond, &mutex); // 3. 条件不满足 → 释放锁 + 睡眠（原子操作）
}                                     // 4. 被唤醒 → 重新拿锁 → 再检查条件
// 条件满足, 执行业务逻辑
pthread_mutex_unlock(&mutex);         // 5. 释放锁
```

唤醒端：

```c
pthread_mutex_lock(&mutex);
condition = true;
pthread_cond_signal(&cond);           // 唤醒一个等待者（或 broadcast 唤醒全部）
pthread_mutex_unlock(&mutex);
```

`pthread_cond_wait` 的关键动作是**原子地**释放 mutex 并进入睡眠——如果这两步不原子，可能出现在"释放锁后、睡眠前"的窗口期被 signal 唤醒，信号丢失。内核保证这个原子性。

**这里的 `pthread_mutex_t` 不是"锁"本身**——它不是 Monitor 的 `_LockWord`（那个才是真正的锁）。它只是保护 `PlatformEvent` 内部计数器 `_nParked` 的短时互斥锁，只在 park/unpark 的慢路径中短暂持有。

带着这个理解看 `PlatformEvent` 的代码（`os_posix.hpp`、`os_posix.cpp`）：

```c
// === os_posix.hpp, os_posix.cpp ===
class PlatformEvent {
  volatile int _event;             // 三态信号量: 1(有许可) / 0(无许可) / -1(已阻塞)
  volatile int _nParked;          // 是否有人在 cond_wait 上
  pthread_mutex_t _mutex[1];      // 保护内部状态
  pthread_cond_t  _cond[1];       // 真正的睡眠原语

  void park() {
    // 原子递减 _event: 1→0(直接返回), 0→-1(进入阻塞)
    int v;
    for (;;) {
      v = _event;
      if (Atomic::cmpxchg(v - 1, &_event, v) == v) break;
    }
    if (v == 0) {                  // 无许可, 需要阻塞
      pthread_mutex_lock(_mutex);
      ++_nParked;
      while (_event < 0) {
        pthread_cond_wait(_cond, _mutex);    // ← 最终在这里睡眠
      }
      --_nParked;
      _event = 0;
      pthread_mutex_unlock(_mutex);
    }
  }

  void unpark() {
    // 原子将 _event 设为 1; 如果原来是 -1, 需要 pthread_cond_signal
    if (Atomic::xchg(1, &_event) >= 0) return;  // 没人等, 直接返回
    pthread_mutex_lock(_mutex);
    int anyWaiters = _nParked;
    pthread_mutex_unlock(_mutex);
    if (anyWaiters != 0) pthread_cond_signal(_cond);
  }
};
```

`_event` 的三态信号量是这个设计的核心——`park()` 先做无锁 CAS 尝试"消费"一个许可，只有没许可时才走 `pthread_mutex_lock` + `pthread_cond_wait` 的慢路径。

---

### 第 2 层：ParkEvent —— 可链接的 ParkEvent

`ParkEvent`（`park.hpp`）继承 `PlatformEvent`，加了链表能力：

```c
class ParkEvent : public os::PlatformEvent {
  ParkEvent* volatile ListNext;       // 单链表指针
  Thread* AssociatedWith;             // 所属线程
  static Allocate/Release;            // 对象池：分配&回收, 从不销毁
  // operator new 强制 256 字节对齐 — 保证地址低 8 位始终为 0
};
```

每个线程在创建时预先分配一个 ParkEvent（`Thread::_MutexEvent`）。锁竞争时，这个 ParkEvent 被插入 Monitor 的等待队列中。256 字节对齐是后面的 `SplitWord` 能够工作的关键前提。

---

### 第 3 层：Monitor —— 这把锁到底在锁什么

先回答最基本的问题"HotSpot 内部使用的锁是什么意思"——具体例子。

JVM 启动时有好几条线程同时跑：Java 业务线程在解释字节码，CompilerThread 在后台把热点方法编译成机器码。如果一条线程用 `tty->print_cr("[GC info]")` 往 stdout 打印日志，另一条线程也在同一时刻打印编译日志——两行输出会搅在一起，变成乱码。

所以 `tty` 对象内部有一个 Monitor 锁：

```c
// JVM 代码中：
void gc_print(const char* msg) {
    MutexLocker ml(tty_lock);     // 获取锁 —— 同一时刻只有一条线程能进
    tty->print_cr("%s", msg);     // 安全打印
}                                  // ml 析构, 自动释放锁
```

`tty_lock` 就是这个 `Monitor` 的实例。100 个 Monitor 保护 100 个共享资源——stdout 一个、线程列表一个、代码缓存一个、符号表一个。JVM 代码里满屏的 `MutexLocker xxx(some_lock)` 就是在说"我要动这个资源了，别人别碰"。

**对标 Java 的 ReentrantLock：** HotSpot 的 `Monitor` 就是 C++ 版的 `ReentrantLock`。概念几乎一一对应：

| Java `ReentrantLock` | HotSpot `Monitor` |
|---|---|
| `lock.lock()` | `Monitor::lock()` |
| `lock.unlock()` | `Monitor::unlock()` |
| `Condition.await()` | `Monitor::wait()` |
| `Condition.signal()` | `Monitor::notify()` |
| `AQS` 的 CLH 同步队列 (Node 链表) | cxq + `_EntryList` (ParkEvent 链表) |
| `AQS` 的 Condition Queue | `_WaitSet` (ParkEvent 链表) |
| `LockSupport.park()` | `PlatformEvent::park()` |
| `LockSupport.unpark(thread)` | `PlatformEvent::unpark()` |
| `AbstractQueuedSynchronizer.Node` | ParkEvent |

`Monitor` 和 `ReentrantLock` 本质上做了同样的事：一个状态字（AQS 用 `int state`，Monitor 用 `_LockWord`），无竞争时 CAS 改状态直接拿锁，有竞争时把等待线程推入队列并 park 睡眠，释放时唤醒下一个。理解 `ReentrantLock` 就理解了 `Monitor` 的骨架。

但实现层面有九个重要差异，正是 JVM 场景特有的需求：

| 设计点 | Java AQS (ReentrantLock) | HotSpot Monitor | 差异原因 |
|--------|------------------------|-----------------|---------|
| 状态表示 | `int state`，0=空闲，>0=持有/重入 | `_LockWord` 一个 8 字节字：最低位=锁(0/1)，高位=cxq 指针 | Monitor 不需要重入计数，但需要将锁状态和队列指针合并为一个 CAS 操作 |
| 重入支持 | 支持，`state++` 计数 | **不支持**，再次 lock 同一 Monitor 会死锁 | JVM 内部锁没有重入需求——拿到 tty_lock 的代码不会再次请求 tty_lock |
| 排队数据结构 | 单一 CLH 队列(head/tail 指针) | **三队列**：cxq(CAS 头插入队) → EntryList(批量搬运) → OnDeck(唯一候选人) | CLH 简单，但 unlock 时 AQS 唤醒后继者后大概率立即重新竞争，产生 futex 惊群；三队列让持有者控制"谁下一个"，避免不必要的唤醒 |
| 自旋策略 | AQS 自身不自旋，留给调用方 | `TrySpin()` 指数退避自旋(20 轮)，中间检测 safepoint | JVM 内部锁持有时间极短(几微秒)，自旋成功率远高于 AQS 的 Java 业务场景 |
| Safepoint 协调 | 不感知 safepoint | `lock()` 中检测 safepoint 请求，Java 线程主动 `ThreadBlockInVM` 状态切换，VMThread 用 `lock_without_safepoint_check` | JVM 的 GC 必须能暂停所有线程，锁等待期间也必须响应——AQS 没有这个需求 |
| Rank 死锁检测 | 无 | 每个锁分配整数 rank，只能从小往大加锁，违反在 debug 构建 assert | 40+ 个全局锁的 JVM 需要预防 C++ 层死锁，AQS 只被业务代码按需使用 |
| 线程唤醒策略 | `unparkSuccessor` 直接唤醒 head 的下一个 | **OnDeck 传承**：释放者选一个 OnDeck，被选者被唤醒后自己竞争 | 减少唤醒次数，同时让释放者可以"偷"锁(sneak) |
| 伪共享防护 | AQS 无 | `PaddedMonitor/PaddedMutex` 加 cache line 填充 | JVM 内部大量锁对象相邻分配，不填充会导致 cache 颠簸 |
| 节点生命周期 | AQS.Node 跟随线程创建/销毁 | ParkEvent 对象池复用，**从不销毁**(immortal) | 避免在信号处理器、safepoint 等无法分配内存的上下文中创建新对象 |
| SplitWord 共享 | state 和 head/tail 独立字段 | **lockByte 和 cxq 在同一字**(利用 ParkEvent 256 对齐) | 单次 CAS 原子完成"检查锁空闲+入队"，无 TOCTOU 竞态 |

AQS 的结点有一个 `waitStatus` 状态机（`CANCELLED/SIGNAL/CONDITION/PROPAGATE`），用于协调唤醒。Monitor 没有这个——它通过 `_OnDeck` 直接指定"下一个该拿锁的是谁"，不靠 waitStatus 传递信号。这是两种唤醒策略的根本差异：AQS 让等待者自己标记"我准备好了被唤醒"（`SIGNAL`），Monitor 让释放者直接选定下一个（`OnDeck`）。

现在看这个锁怎么实现的。`Monitor` 内部的全部状态就这几个字段：

```
Monitor
  ├─ SplitWord   _LockWord      ← 锁状态(最低位) + 等待队列指针(高位)
  ├─ Thread*     _owner         ← 当前持有者 (NULL=空闲)
  ├─ ParkEvent*  _EntryList     ← 等待获取锁的 ParkEvent 链表
  ├─ ParkEvent*  _OnDeck        ← 下一个继承人 (最多一个)
  └─ ParkEvent*  _WaitSet       ← 条件变量的等待集合（仅 Monitor 使用，Mutex 禁用）
```

> **不是两套锁机制——Mutex 就是 Monitor 的子类。** JVM 里只有一套锁体系。`Monitor` 是基类（有 `lock/unlock` + `wait/notify`），`Mutex` 继承了它但把 `wait/notify` 禁用了：
>
> ```c
> class Mutex : public Monitor {     // degenerate Monitor（退化版管程）
>   bool notify()     { ShouldNotReachHere(); }   // 调用就崩溃
>   bool notify_all() { ShouldNotReachHere(); }
>   bool wait(...)    { ShouldNotReachHere(); }
> };
> ```
>
> JVM 里绝大多数锁——包括 `createThread_lock`——都是 `Mutex`。它只有 `lock/unlock`，没有等待/唤醒功能。`_WaitSet` 字段虽然存在（继承的），但在 Mutex 上永远是空的——因为没人能调它的 `wait()`。

关键设计：`_LockWord` 这一个整数同时记录了两件事——**锁状态**（最低位）和**排队队列的头指针**（高位）。为什么能这样？因为等待者的 ParkEvent 地址是 256 字节对齐的，低 8 位永远是 0。

用具体数值演示完整过程。假设两个线程竞争同一个 Monitor：

**线程 A 获取锁：**

```
Monitor 初始状态:  _LockWord = 0x0000000000000000   (空闲, 没人排队)
                   _owner    = NULL

A 调 lock() → TryFast():
   CAS: 把 _LockWord 从 0 改成 1
        成功! _LockWord 变成 0x0000000000000001
        _owner = A

此时 Monitor:     _LockWord = 0x0000000000000001   (最低位=1, 表示被 A 持有)
                   _owner    = A
```

**线程 B 尝试获取锁（被阻塞）：**

```
B 调 lock() → TryFast():
   CAS: 想把 _LockWord 从 0 改成 1
        失败! _LockWord 已经是 1 (被 A 持有)
   
   TrySpin() 自旋 20 圈... 还是拿不到

   AcquireOrPush(B 的 ParkEvent):
     B 持有的 ParkEvent 是从 Thread 对象里来的—每个线程创建时预分配一个 `_MutexEvent`,
     终身绑定。地址 0x7f1234567800（ParkEvent 强制 256 字节对齐）
     CAS: 把 _LockWord 从 0x0000000000000001 
          改成        0x7f1234567801     (地址 + 最低位=1)
          成功!

此时 Monitor:     _LockWord = 0x7f1234567801   (最低位=1, 高位指向 B 的排队记录)
                   _owner    = A              (A 还没放锁)

cxq 不是一个独立的字段——它就是 `_LockWord` 的高 56 位。这里只有 B 一个在排队,
所以高位指向 B 的 ParkEvent,B 既是头也是尾。
```

**线程 A 释放锁，B 获得锁：**

```
A 调 unlock():
   release_store: 把 _LockWord.Bytes[0] 从 1 改成 0   (只清最低位)
                   _LockWord 变成 0x7f1234567800
 
   发现 cxq 里有 B 在等 → B 设为 _OnDeck → unpark(B)

此时 Monitor:     _LockWord = 0x7f1234567800   (锁空闲, 指针还在原位)
                   _OnDeck   = B

B 被唤醒:
   TrySpin() 看到 _LockWord 最低位=0 → CAS 把它设成 1
         成功! _LockWord = 0x7f1234567801
         _owner = B
         _OnDeck = NULL
```

整个过程里，`_LockWord` 这一个整数承载了全部同步状态。加锁是 CAS 把最低位从 0 改成 1，放锁是直接写最低位为 0，排队是把排队者地址写到高位。这就是 SplitWord 设计的全部意义——不需要独立的"锁状态"和"队列表头"，一个 CAS 操作原子地修改两者。

### 为什么需要 cxq 和 EntryList 两个队列

AQS 只需要一个 CLH 队列。HotSpot 的 Monitor 和 ObjectMonitor 都需要两个：cxq + EntryList。为什么？用三个线程同时竞争一把锁的场景来看。

```
时刻 0: 锁被线程 A 持有。_LockWord = 0x...01, _owner = A, cxq 空, EntryList 空

时刻 1: 线程 B、线程 C、线程 D 同时调 lock()，TryFast 全部失败
        它们需要排队。但 B、C、D 谁都没拿到锁——不能要求它们"先拿把内层锁再去排队"。
        所以它们只能 CAS: 把自己的 ParkEvent 推入 _LockWord 的高位。

时刻 2: B 的 CAS 先成功。_LockWord 高位指向 B。
        C 的 CAS 接着成功。_LockWord 高位指向 C（C.ListNext = B）。
        D 的 CAS 接着成功。_LockWord 高位指向 D（D.ListNext = C）。
        
        此时 cxq: D → C → B （后到的排前面，LIFO）

时刻 3: 线程 A 调 unlock()
        A 看到 cxq 非空，需要选一个人唤醒。
        
        问题: 如果从 D 唤醒（cxq 头部=LIFO，D 最近到的），
        B 最先到却最后被唤醒——不公平。
        而且 A 操作 cxq 时，E、F 可能还在 CAS 往 cxq 头部推自己——
        A 需要 CAS 摘下整个 cxq 才能安全遍历。这就是批量搬迁的动机。

时刻 4: A 用 CAS 把 cxq 从 D 改成 NULL（原子摘下整条链）。
        现在 cxq 归 A 独占了——不会再有其他线程往里面写。
        A 把 D→C→B 整条链搬到 EntryList，在 EntryList 里重新排序（FIFO: B→C→D），
        设 B 为 _OnDeck，unpark(B)。

时刻 5: B 被唤醒，抢到锁。EntryList 里还有 C 和 D。
        下次有人 unlock 时，直接从 EntryList 取 C——不需要再搬 cxq。
```

**关键就是一次 CAS 交接。** cxq→NULL 的 CAS 成功后，整条链就归释放者独占了——没有并发读写问题。之后释放者可以安全地遍历、排序、选人。AQS 没有这个"cxq 全部摘下来"的操作——它必须在并发读写的单一链表上工作，所以需要 `waitStatus` 状态机来标记每个节点的状态。

**补充两个容易混淆的点：**

1. 两队列的根本目的就是**避免持有锁的线程（操作 EntryList）和获取锁失败的线程（CAS 写入 cxq）之间的并发冲突**。持有者独占 EntryList，失败者 CAS 写入 cxq——各写各的，互不干扰。

2. 获取锁失败的线程**不是在 cxq 里阻塞的**。cxq 只是一个 ParkEvent 链表——记录"我在排队"。线程把自己 ParkEvent 推入 cxq 后，调用 `ParkEvent::park()`（底层 `pthread_cond_wait`）睡眠。阻塞发生在 park 里，不在 cxq 里。cxq 里只是排队记录。

**ObjectMonitor 用了完全相同的双队列设计，但节点类型不同。** Monitor 的队列直接存 `ParkEvent*`——每个线程有私有的 `_MutexEvent`，锁竞争时拿它去排队。ObjectMonitor 的队列存的是 `ObjectWaiter*`——一个栈上分配的包装对象，内部包含了指向线程私有 ParkEvent 的指针（`ObjectWaiter::_event`）和前后链表指针。注释里写道 `"TODO: Eliminate ObjectWaiter and use ParkEvent instead"`——设计者自己也觉得两套节点应该统一，但 JVMTI 的 `GetObjectMonitorUsage` API 依赖 ObjectWaiter 结构暴露给外部工具，无法直接替换。

`ObjectMonitor::enter()` 中 `EnterI` 把 `ObjectWaiter` 推入 `_cxq`（CAS），`ObjectMonitor::exit()` 用 `Atomic::cmpxchg(NULL, &_cxq, w)` 原子摘下整个 cxq，追加到 `_EntryList`，然后从 EntryList 中 `ExitEpilog` 唤醒一个。

---

### 第 4 层：Mutex 和 Padded 变体

`Mutex` 继承 `Monitor`，把 `wait()`、`notify()`、`notify_all()` 全部覆盖为 `ShouldNotReachHere()`——拿了锁就只能干活、放锁，不能在里面等条件。JVM 里绝大多数锁都是 `Mutex`。

`PaddedMutex` / `PaddedMonitor` 在 `Mutex` / `Monitor` 的基础上加了 cache line 对齐，防止相邻锁在同一 cache line 上导致伪共享（false sharing）——一个 CPU 核修改锁 A 时另一个核持有的锁 B 被迫刷新缓存。

---

### 为什么不用 `pthread_mutex_t`

现在可以回答最初的问题了——在 `PlatformEvent` 已经提供了全部阻塞原语的前提下，HotSpot 为什么还要在上面堆三层（ParkEvent → Monitor → Mutex）：

1. **Rank 死锁预防** —— 给每个锁分配整数 rank，只能从小往大加锁。debug 构建中反向加锁直接 assert。这是对 pthread 的全序关系增强。

2. **Safepoint 协调** —— `lock()` 过程中自动检查是否有 safepoint 请求。Java 线程检测到 safepoint 时主动 `ThreadBlockInVM` 转换状态，让 VMThread 知道"我已停下"。VMThread 自己则用 `lock_without_safepoint_check()` 避免死锁。

3. **三队列公平调度** —— pthread_mutex 的等待队列是内核管理的，HotSpot 控制不了。自建的 cxq → EntryList → OnDeck 三队列让 JVM 可以控制唤醒顺序、支持"偷锁"（VMThread sneak）、精确追踪 JFR 锁竞争事件。

> **注意：这是 HotSpot 的 C++ 内部锁，不是 Java `synchronized` 的底层实现。** Java 代码中 `synchronized(obj) { }` 使用的是另一个独立类 `ObjectMonitor`（`objectMonitor.hpp`，同样有 cxq/EntryList/WaitSet 结构但设计不同）。`ObjectMonitor` 的膨胀机制、偏向锁（BiasedLocking）、轻量级锁（BasicLock）以及 `synchronized` 的完整实现将在后续同步机制章节单独详细讲解。

加锁使用 RAII 包装：

```c
MutexLocker ml(some_mutex);             // 构造 lock(), 析构 unlock()
MutexLockerEx mle(some_mutex, true);    // true = 跳过 safepoint 检查
```

现在回到 `createThread_lock`：它是一个 `Mutex(leaf, "createThread_lock", false)`——leaf 级别 rank（防止和 barrier 等高层锁形成死锁），不允许 VMThread 阻塞（`allow_vm_block=false`），默认需要 safepoint 检查。

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

JDK 11 默认开启 `ThreadLocalHandshakes`（JEP 312）——每个线程有独立的轮询指针，不再共用一个全局页面。`default_initialize()` 做的第一件事就是分配这个轮询页。

`set_uses_thread_local_poll()` 设 `_polling_type = _thread_local_poll`。后续每创建一个 `JavaThread`，`initialize_header()` 把该线程的 polling page 指针初始化为 "disarmed" 状态。

"disarmed 状态"就是指针指向 `good_page`——这一页被 `mprotect(PROT_READ)` 保护，可以正常读取。JIT 编译的代码在读它时不会触发信号，线程正常运行。相对的 "armed 状态"是指针指向 `bad_page|8`——不可读，一碰就 SIGSEGV，线程被停住。类比安防系统：disarmed = 关警，armed = 开警。新线程初始一定 disarmed——刚创建的线程还没开始干活，不需要被 GC 拦截。

接下来分配两页内存。`os::reserve_memory` 内部调用 `mmap(NULL, 8KB, ..., MAP_ANONYMOUS|MAP_PRIVATE, -1, 0)` 预留虚拟地址空间，`os::commit_memory_or_exit` 内部调 `mprotect` 提交物理页。两页共 8KB，前 4KB 是 `bad_page`，后 4KB 是 `good_page`。直接读分配结果的代码：

```c
char* polling_page = os::reserve_memory(2 * page_size, NULL, page_size);
os::commit_memory_or_exit(polling_page, 2 * page_size, false, ...);
char* bad_page  = polling_page;
char* good_page = polling_page + page_size;
```

然后分别设保护属性。`os::protect_memory(MEM_PROT_NONE)` 底层是 `mprotect(PROT_NONE)`——和第 3.4 节 Stage 2 的 `create_stack_guard_pages()` 完全相同的系统调用。区别在于 Stage 2 保护的是栈底页（检测栈溢出），这里保护的是独立分配的页（检测安全点）：

```c
os::protect_memory(bad_page,  page_size, os::MEM_PROT_NONE);   // 不可读→触发 SIGSEGV
os::protect_memory(good_page, page_size, os::MEM_PROT_READ);  // 可读→正常通过
os::set_polling_page((address)(bad_page));                     // 存到 os::_polling_page
```

`os::_polling_page` 是一个**全局变量**，但它的作用不是让线程直接读——它只用于信号处理器的**范围校验**。当 SIGSEGV 到达时，`is_poll_address(addr)` 检查故障地址是否在 `[_polling_page, _polling_page + page_size)` 内，判断这个 SIGSEGV 是不是碰了安全点轮询页。

而线程自己读的是**私有的** `JavaThread._polling_page` 字段——每个 JavaThread 对象里有一个 `void*` 指针，`arm_local_poll` 把它设为 `bad_page|8`，`disarm_local_poll` 把它恢复为 `good_page`。JIT 代码用 `mov r10, [r15 + offset]` 加载的是这个私有字段，不是全局变量。所有线程共享同一块 `bad_page` 内存，但每个线程有自己的指针独立切换。

`_poll_armed_value` 和 `_poll_disarmed_value` 是两个**全局静态变量**——它们是模板。"armed 时指针该设成什么值"存在 `_poll_armed_value` 里，"disarmed 时指针该设成什么值"存在 `_poll_disarmed_value` 里。每个线程的私有指针在这两个值之间切换。

用具体数值来讲。假设 `mmap` 返回的 bad_page 地址是 `0x7f1234500000`（页对齐，低 12 位全是 0），good_page 紧跟其后是 `0x7f1234501000`：

```c
_poll_disarmed_value = (void*)0x7f1234501000;        // 全局模板：disarmed 状态
_poll_armed_value    = (void*)0x7f1234500008;        // 全局模板：armed 状态
```

某线程 A 被 `arm_local_poll(A)` 调用后，A 的私有 `polling_page` 字段被写成 `0x7f1234500008`。A 继续执行，在方法返回处遇到 JIT 插入的 `test` 指令——CPU 尝试读地址 `0x7f1234500008`。这个地址处在 bad_page（`0x...0000` 到 `0x...0FFF`）内，被 `PROT_NONE` 保护。MMU 报告页错误，内核投递 SIGSEGV 给线程 A。

**这里直接连回了第 1.1 节注册的信号处理器。** 线程 A 的 `signalHandler`（第 1.1 节 `install_signal_handlers()` 注册的）被调用。`JVM_handle_linux_signal` 拿到 `si_addr = 0x7f1234500008`，调用 `is_poll_address(0x7f1234500008)`——检查故障地址是否落在 `[bad_page, bad_page + page_size)` 也就是 `[0x7f1234500000, 0x7f1234501000)` 区间内。在这个区间内 → 这是安全点触发，不是空指针，也不是栈溢出。走 `SafepointSynchronize::block()` 挂起自己。

"范围检查"的作用正好在此处体现——SIGSEGV 的来源有三种（空指针、栈溢出、安全点），唯一的区分手段就是逐个检查 `si_addr` 落在哪个范围内。

当 A 被 `disarm_local_poll(A)` 恢复后，A 的私有指针换回 `0x7f1234501000`。后续 `test` 指令读这个地址——good_page 是 `PROT_READ`，读成功，线程继续运行。

### 2.3 arm/disarm —— 怎么让线程停下

现在有了好页和坏页。JIT 编译器在方法返回处和循环回边插入检查指令。在 x86-64 上大致是：

```asm
mov  r10, QWORD PTR [r15 + offset_in_thread]   ; 加载本线程的 polling page 地址
test QWORD PTR [r10], rax                        ; 尝试读这个地址
```

HotSpot 用两个 inline 方法控制切换：

```c
void SafepointMechanism::arm_local_poll(JavaThread* thread) {
  thread->set_polling_page(_poll_armed_value);     // 换成 bad_page→SIGSEGV
}
void SafepointMechanism::disarm_local_poll(JavaThread* thread) {
  thread->set_polling_page(_poll_disarmed_value);   // 换回 good_page→正常
}
```

如果轮询指针是 `good_page`（_poll_disarmed_value），内存读成功，线程继续执行。如果轮询指针被改成 `bad_page|8`（_poll_armed_value），读触发 SIGSEGV——因为 `bad_page` 用 `mprotect(PROT_NONE)` 保护了。`is_poll_address` 检查故障地址是否在 `[_polling_page, _polling_page + page_size)` 内，是的话说明轮询页被碰触，调用 `SafepointSynchronize::block()` 挂起线程。

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

> **标准 JDK 11（无 NUMA）下，此函数是空函数。** 本机只有 1 个 NUMA node，`os::init_2()` 中 `UseNUMA` 已设为 false，`if (UseNUMA)` 条件不成立，直接 `return JNI_OK`。以下代码仅当机器有多 NUMA node 时才执行——但不影响理解下面的 flag 联动逻辑。

`os::init_2()` 可能修改 `UseNUMA`，flag 的最终调整必须放在它之后：

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

三个决策全部在 `UseNUMA=true` 的前提下才执行——本机只有 1 个 NUMA node（`os::init_2()` 中 `numa_max_node() < 1` 导致 `UseNUMA` 被设为 false），所以 `if (UseNUMA)` 条件不成立，整个函数直接 `return JNI_OK`，一行都没执行。标准 JDK 11 部署场景（无 NUMA）下，这里就是一个空函数，了解即可。

| 变量 | 设置条件 | 值 |
|------|---------|-----|
| `UseNUMA` | `AllocateHeapAt` 被指定 | false（ergo） |
| `MinHeapDeltaBytes` | NUMA + ParallelGC + 未显式指定 | **64M**（default） |
| `UseNUMAInterleaving` | NUMA + 未显式指定 | **true**（ergo） |

**衔接 Stage 2**：`apply_ergo` 设的 `UseNUMA` 可能被 `os::init_2` 和这里两次修改——flag 生命周期从 parse 到 ergo 到 init_2 到 adjust_after_os，每步都可能改变。`FLAG_SET_ERGO` 标记为"ergo 推算"（用户可覆盖），`FLAG_SET_DEFAULT` 标记为"默认值"（用户显式指定时优先）。

---

## 4. 收尾步骤 ★

**`ostream_init_log()`** —— 唯一的作用是提前创建 `tty` 的日志文件。

正常情况下 `tty` 往 stdout/stderr 写。但 `defaultStream`（`tty` 的内部实现）还有一个可选的 `_log_file` 成员——如果用户传了 `-XX:LogFile=hotspot.log`，`tty` 的每次输出也会写一份到这个文件。这个文件的创建原本是**惰性**的——第一次真正需要写日志时才 `fopen`。

问题在于：如果 VM 在惰性创建之前就崩溃了，fatal error handler 调 `tty->print_cr` 写 crash 信息时，文件还没打开，crash 信息就丢了。

`has_log_file()` 在这里主动触发惰性初始化。它的调用链（`ostream.cpp`）：

```
has_log_file()
  ├─ 如果 VM 已崩溃（VMError::is_error_reported()）→ 直接返回 false
  ├─ 如果还没初始化：
  │     init() → init_log()
  │       └─ open_file(LogFile ? LogFile : "hotspot_%p.log")
  │            └─ fopen(log_name, "w")          ← 提前创建文件
  │            └─ 如果成功: new xmlStream(file)  ← 日志写 XML 格式
  │            └─ 如果失败: LogVMOutput = false  ← 放弃日志文件
  └─ 返回 _log_file != NULL
```

用户可以传 `-XX:LogFile=myapp.log` 指定日志文件名，不传的话默认名是 `hotspot_<pid>.log`。`fopen(name, "w")` 会创建这个文件——所以 `os::init_2()` 执行完毕后，当前工作目录下会多一个空的 `hotspot_<pid>.log` 文件（约 0 字节）。后续任何 `tty->print_cr(...)` 输出都会同时写一份到这个文件里。如果 `fopen` 失败（比如没有写权限），`_log_file` 保持 NULL，`LogVMOutput` 被设为 false，后续输出不写文件，也不影响正常运行。

`ostream_init_log` 还有第一行 CDS 相关的代码：`DumpLoadedClassList` 是 CDS（Class Data Sharing）训练阶段用的 flag——先跑一次 JVM 把加载过的类列表 dump 出来，再用这个列表创建共享归档。**默认不传，这个 `if` 直接跳过。** 真正的核心就一行：`has_log_file()`。

两个动作：如果用户传了 `-XX:DumpLoadedClassList=<file>`（CDS 类列表 dump），创建对应的文件流；然后调 `defaultStream::instance->has_log_file()` 主动触发日志文件的惰性初始化——在 VM 崩溃前把文件打开，避免崩溃后 fatal error handler 因惰性初始化而出错。

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
