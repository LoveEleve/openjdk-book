# 04. 一个 SIGSEGV, 五件事一起做 — 信号 + 安全点

> 🔴 Deep | 23 KP 中的 6 个信号/安全点/辅助机制
> 读者处境: 你以为 SIGSEGV = crash。JVM 把它变成了瑞士军刀——同一个信号处理五个完全不同场景。

### 1. SIGSEGV 五阶段 — 一个信号, 五种判决

场景: JIT 编译的代码在运行。`mov [0], rax`——SIGSEGV。Linus 想"地址无效"。JVM 的信号 handler 接过了接力棒——开始问五个问题。

**阶段 1 — 栈溢出？** (`os_linux_x86.cpp:268-350`):
- 检查 faulting address (siginfo->si_addr) 是否落在某个线程的 guard zone 内
- [内核: siginfo_t 结构——si_signo (信号号=SIGSEGV=11), si_errno, si_code (SEGV_MAPERR=地址未映射/SEGV_ACCERR=权限错误), si_addr (faulting address)。信号 handler 的第三个参数 (ucontext_t) 包含 fault 时的完整 CPU 状态]
- [man 2 sigaction] (SA_SIGINFO flag)
- Yellow zone→设置 `thread->set_stack_overflow()`→StackOverflowError (Java 异常)→可恢复
- Red zone→fatal error+hs_err——栈已用尽，连异常抛出的栈帧都没有

**阶段 2 — safepoint 轮询？** (`os_linux_x86.cpp:380-395`):
- 检查 faulting address 是否等于 `os::get_polling_page()`
- poll 触发→`SafepointSynchronize::block()`→线程阻塞在 safepoint
- [x86: test [polling_page], rax——正常时页面可读(1 cycle), mprotect(PROT_NONE)后不可读→SIGSEGV。为什么选 test 而不是 mov？— test 读但不修改 reg——数据被丢弃——唯一目的是触发 segfault]

**阶段 3 — implicit null check？** (`os_linux_x86.cpp:390-410`):
- 检查 faulting address 靠近 NULL (0~4096 范围)
- JIT 生成 `mov [0], rX`——当 rX==null→SIGSEGV→handler 识别→跳转 uncommon trap
- [x86: 为什么不用 `cmp rX, 0; jne null_handler`？— `mov [0], rX`=4 字节(2 字节 opcode+2 字节 ModR/M)，`cmp+jne`=7 字节(3+2+2)。节省 3B * 每个 null check * ~10 次每个方法——JIT 编译代码瘦 30B——少一次 icache miss]
- 这是 JVM 把 x86 缺乏硬件 null check 的劣势转化为 JIT 优化优势的范例——用信号异常替代显式分支

**阶段 4 — 序列化页？** (`os_linux_x86.cpp:415-425`):
- faulting address = memory_serialize_page → 这是 store-load barrier 替代
- 重执行触发的 load 指令——mprotect(RW→RO) 的 TLB shootdown 已经保证了全序——load 现在能看到之前所有 store

**阶段 5 — crash** (`os_linux_x86.cpp:430-512`):
- 以上全不是→真正的 crash→hs_err_pid.log + core dump
- hs_err 内容: 寄存器状态 (RAX/RBX/.../RIP/RFLAGS 全部 16 个 GPR+16 XMM)/栈帧 (前三层调用栈)/内存映射 (`/proc/self/maps`——所有 mmap 区域)/加载的动态库列表 (`dlerror()`)/线程列表 (每个线程的 native stack+Java stack)
- [C++: hs_err 是 production crash 唯一的线索——没有它，crash 完全不可调试。JVM 在 crash handler 中不调用 malloc (堆可能已损坏)——全部信息写到 pre-allocated static buffer→write(fd, buffer, len)]
- [man 5 proc] (proc/pid/maps)

### 2. libjsig 信号链 — 当 profiler 也想接管 SIGSEGV

**拦截 sigaction** (`os.cpp:810-831`):
- libjsig preload——拦截所有 `sigaction()` 调用——保存原始 handler→安装 JVM handler
- 链式调用: JVM handler 处理→若不处理(返回 false)→调下一个 handler
- [C++: LD_PRELOAD 机制——设置环境变量 `LD_PRELOAD=libjsig.so`——动态链接器在加载程序时**优先**加载 libjsig——libjsig 的 sigaction 符号被优先解析——所有 sigaction 调用被 libjsig 拦截——原始 glibc sigaction 被"劫持"]
- [C++: sigaction vs signal——sigaction 提供: signal mask (处理信号时自动屏蔽哪些信号)+ SA_RESTART (自动重启被中断的系统调用)+ SA_SIGINFO (handler 接收 siginfo_t 含 faulting address)。signal() 是简化版——不支持 SA_SIGINFO——不能用 siginfo_t]
- [man 2 sigaction] [man 7 signal]

**信号处理流程**:
- [内核: 内核返回到用户空间前→检查 pending signals (per-thread + per-process)→找到最高优先级的未屏蔽信号→如果注册了 handler: 设置 sigframe (保存返回地址/寄存器/signal mask)→返回到 handler→handler 返回→sigreturn 系统调用→恢复全部上下文]
- SIGPIPE/SIGXFSZ: 先链到原始 handler→再 install_ignored——双重保障 (`os_linux.cpp:4880`)
- SIGBREAK (SIGQUIT): signal_thread_entry→AttachListener::is_init_trigger()→thread dump (`os_linux.cpp:4938`)
- [内核: SIGQUIT (kill -3)——默认行为: core dump + terminate。JVM 注册 handler 替代——收到 SIGQUIT→打印全部线程栈→不 dump core、不 terminate。如果 JVM 没有注册 handler——kill -3 真的 dump→然后 kill JVM]

### 3. Safepoint 轮询页 — 4 字节控制全部 Java 线程

**polling page 机制** (`os.hpp:427-431`):
- 实现: 一个 4KB 内存页——mprotect(PROT_READ) 正常——mprotect(PROT_NONE) safepoint 请求
- [x86: JIT 生成的 poll check——`test [polling_page], rax` = 4 字节 (opcode 85 + ModR/M 05 + 32-bit offset)。正常路径: 读 1 cycle，不分支——零开销。vs flag 方案: `cmp [flag], 0; jne safepoint`=7 字节，分支预测失败 20 cycles]
- safepoint 请求后: mprotect(PROT_NONE) (`os_linux_x86.cpp:431`)→TLB shootdown IPI→所有 CPU 的 polling_page entry 被 invalidated→下一次 poll check→SIGSEGV→信号 handler 阶段 2→进入 safepoint

**Memory Serialize Page** (`os.hpp:437-484`):
- UseMembar=false→页面权限切换 (RW→RO→RW) 代替 mfence
- [x86: 为什么 mprotect 构成 barrier？— mprotect→TLB shootdown——kernel 发 IPI 到所有 CPU。所有 CPU 必须 invalidate 对应 TLB entry。shootdown 的物理顺序: CPU0 mprotect→send IPI→CPU1 receive IPI→CPU1 invalidate→CPU1 acknowledge。这保证了 CPU0 的 store 在 CPU1 的 load 之前可见——即 store-load barrier]
- 每线程独立 cache line 偏移: `thread >> shift & mask`→写不同的 cache line→避免所有线程写同一个 cache line 的 MESI 竞争

### 4. 辅助 — 时间 / DLL / malloc / 性能监控

**多层时间** (`os.hpp:188-218`):
- javaTimeMillis: wall clock (gettimeofday)→可被 NTP/手动调整影响
- javaTimeNanos: monotonic (clock_gettime CLOCK_MONOTONIC)→只增不减——不受 NTP 影响
- elapsed_counter: TSC/HPET→最高精度但不单调 (跨核心可能不同步)
- [man 2 clock_gettime] [man 2 gettimeofday]

**动态库** (`os.hpp:653-685`):
- dll_load→dlopen(RTLD_LAZY): 推迟符号解析——加载更快但运行时可能失败
- dll_lookup→dlsym: 按名字查找符号
- find_builtin_agent: 扫描已链接符号表——查找 `Agent_OnLoad_<name>`——判断 agent 是静态链接还是 dlopen 加载
- [man 3 dlopen] [man 3 dlsym]

**os::malloc** (`os.cpp:681-798`):
- NMT header 前置 64B (allocation site+size+flags)→MemTracker::record_malloc 记录→::malloc 实际分配→GuardedMemory canary (DEBUG: 头尾魔数检测 overflow)

**性能监控** (`os_perf.hpp:61-288` + `os_perf_linux.cpp`):
- /proc 解析: CPU 拓扑 (sockets/cores/threads 从 /proc/cpuinfo)、CPU 利用率 (/proc/stat)、网络字节 (/proc/net/dev)
- [man 5 proc] (proc/stat, proc/pid/stat)

---

### 核心悬念

**"一个 SIGSEGV——JVM 同时做 NullPointer + GC Safepoint + StackOverflow + Memory Barrier + Crash Dump。"** — x86 没有硬件 null check，JIT 用 `mov [0], rX`→SIGSEGV→handler 识别。safepoint poll = mprotect 切换→TLB shootdown→全局线程协调。同一个信号 handler——检查 faulting address 的五种可能值——决定整个 JVM 的下一步。这是利用 Linux page fault 做硬件加速的极致。

> → domain 2: [Assembler — `test [polling_page], rax` 这 4 字节指令是怎么生成的？](../02-assembler/01-codebuffer-abstract-assembler.md)
