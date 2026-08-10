# PROMPT: 请撰写 02-Threads.md

## 〇、背景与使用场景

### 你在凌晨 3 点被报警唤醒时经历了什么

Docker 容器里的 Java 应用突然无法创建新线程。日志显示：

```
java.lang.OutOfMemoryError: unable to create new native thread
```

但你检查 `top`：物理内存剩余 8GB，堆使用率 45%。不是 OOM。

你降低 `-Xss` 从 1m 到 256k——重启，又崩了，这次是 `SIGSEGV`。hs_err 显示 `si_addr` 落在栈底部附近，`Current thread` 是一个刚创建的 `JavaThread`，连 `thread_main_inner` 都还没调。

你检查 `ulimit -u`（max user processes）——4096。你检查 `/proc/sys/kernel/threads-max`——63794。你检查 `cat /proc/<pid>/limits`——`Max processes` 确实是 4096，但容器里这个值来自 cgroup pids.max，不是宿主机的 ulimit。

另一个场景：线上 GC 线程数量突然少了 3 个。日志显示 `os::create_thread` 返回了 `EAGAIN` 但重试 3 次后放弃了。GC 在缺少线程的情况下继续跑——Full GC 时间从 200ms 变成 3s，RT 警报炸了。

发生了什么？每一个 Java 线程（无论是你的 `new Thread()` 还是 JVM 内部的 CompilerThread/GCThread/WatcherThread）都通过 `os::create_thread()` 从 JVM 数据结构变成内核可调度的 LWP。这条路径上有 4 个 `pthread_attr_*` 调用、一个 `sync_with_child` 握手、一个 `EAGAIN` 重试循环——每一个都可以在你不知道的时候失败。

### 背景概念速览

- **LWP（Light-Weight Process）**：Linux 上 `pthread_create` → `clone()` 创建的内核调度实体。`ps -eLf` 能看到每个 LWP。一个 Java 进程的 LWP 数 = Java 线程 + GC 线程 + JIT 线程 + VMThread + 其他 JVM 内部线程。
- **`PTHREAD_CREATE_DETACHED`**：线程结束后自动释放资源——不需要 `pthread_join`。JVM 所有线程都用 DETACHED——因为 JVM 的线程管理走 ThreadSMR（Safe Memory Reclamation），不需要 OS 层的 `join`。
- **`sync_with_child` 握手**：父子同步屏障。父线程调用 `pthread_create` 后必须等待子线程完成 TLS 绑定 + 信号屏蔽字设置 + 栈基址记录——否则父线程可能访问未初始化的 `OSThread` 字段（如 `thread_id()`）。
- **`-Xss` → `pthread_attr_setstacksize()`**：Java 线程栈大小最终落到 `pthread_attr_setstacksize(&attr, stack_size)`。设小了线程不够用 → StackOverflow；设大了 → 每个线程占更多虚拟地址空间 → RSS 爆炸 → 容器里 `pids.max` 先到上限。

### 相关生态工具

- **`jstack -l <pid>` / `jcmd <pid> Thread.print`**：能看到线程名、状态、栈。但看不到内核 LWP ID → 需要 `ps -eLf` 补充。
- **`/proc/<pid>/task/<tid>/status`**：每个 LWP 的 `SigBlk` 字段——验证 `hotspot_sigmask` 是否正确设置。
- **`pmap -x <pid>`**：按线程栈排序 → 每个线程的 `[stack:<tid>]` 段就是 `pthread_attr_setstacksize` 分配的区域。
- **`strace -f -e trace=clone -p <pid>`**：追踪每个线程的 `clone()` 系统调用 → 验证栈大小和失败时的 errno。

## 一、任务 + 核心故事线（禁止做源码翻译机！）

读者学完了 [07-thread-lock]——理解了 `JavaThread` 的 JVM 内生命周期：从 `Threads::create_vm` 创建 VMThread，到 `JavaThread::run()` 调 `thread_main_inner`，到 `ThreadsSMR` 确认安全后 `delete`。07 建立了"线程在 JVM 内是什么"的完整模型。

但是，07 有一个巨大的空白地带：**JavaThread 怎么变成 OS 线程？** `JavaThread::JavaThread()` 构造函数里哪一行触发了 `pthread_create`？`os::create_thread` 把 `-Xss` 参数传给了 `pthread_attr_setstacksize`——中间经过了什么换算？`thread_native_entry` 醒来后最先做的 7 件事是什么？为什么 `sync_with_child` 握手失败会导致 `os::create_thread` 永久阻塞？

**本文不是 pthread 手册**——不讲 `PTHREAD_CREATE_JOINABLE` vs `DETACHED` 的 POSIX 标准演变、不讲 `PTHREAD_STACK_MIN` 的 glibc 内部实现（`__pthread_get_minstack`）。本文也不是 Linux 调度器教程——不讲 CFS、nice 值、cgroup cpu.shares 如何影响线程优先级。

**本文的唯一目标是：追踪 `os::create_thread()`（`os_linux.cpp:965`）→ `pthread_create` → `thread_native_entry`（`os_linux.cpp:885`）醒来的完整参数链和初始化序列。** 关键是：4 种 `ThreadType`（java_thread / compiler_thread / gc_thread / watcher_thread）各用多大默认栈？`pthread_attr_setstacksize` 失败时 JVM 怎么处理？`sync_with_child` 握手用什么锁？如果子线程初始化中 SIGSEGV 崩溃——父线程会永久阻塞吗？

### 核心叙事线——"JavaThread 从 JVM 数据结构变成内核调度实体的唯一路径"

07 建立了 JavaThread 的 JVM 内模型——本文是 07 的 OS 补完。`JavaThread::JavaThread()` 调 `os::create_thread()` → `pthread_create` → 内核 `clone()` → 新 LWP 出现。这是 JavaThread 从"JVM 内的 C++ 对象"变成"内核调度实体"的**唯一路径**（除 JNI AttachCurrentThread 的特殊路径外——见 §四）。读者读完本文后应该在脑中将 07 的 JavaThread 生命周期和本文的 OS 线程创建连接为完整链条。

### 和 [11-01-Signals] 的连接

[11-01] 讲解了 `hotspot_sigmask`——`thread_native_entry` 醒来后的第 3 步初始化就是调 `os::Linux::hotspot_sigmask(thread)`（`os_linux.cpp:924`）。不理解 [11-01] 的 `unblocked_sigs`/`vm_sigs` 信号集，就无法理解为什么 `thread_native_entry` 要在子线程中显式设置信号屏蔽字。

### 和 README §V 的关系

[11-os-layer README](README.md) §五的对比表列出了 11 阶段和 07/08/09/10 的维度差异。本文的"线程创建"是 OS 三原语的第二原语——它是 07（JavaThread 生命周期）的物理实现层。读者读完本文后应能理解 07 的 JavaThread 创建和本文的 `pthread_create` 如何形成"数据结构层 ↔ OS 实现层"的对称。

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -Xss1m`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 路径 | 模块 | 核心函数/类（行号） | 本文角色 |
|---|------|------|------|-------------------|---------|
| 1 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | os/linux | `os::create_thread`(:965-1098), `thread_native_entry`(:885-963), `pd_start_thread`(:1185-1191), `os::create_attached_thread`(:1109-1183) | ★★★ 线程创建全链路——pthread_create + 子线程初始化 |
| 2 | `osThread_linux.cpp` | `src/hotspot/os/linux/osThread_linux.cpp` | os/linux | `OSThread::pd_initialize`(:32-46) — `_startThread_lock` 分配 | ★★ Monitor 屏障对象创建 |
| 3 | `osThread_linux.hpp` | `src/hotspot/os/linux/osThread_linux.hpp` | os/linux | `_startThread_lock`(:114), `startThread_lock()`(:118) | ★★ 握手锁声明 |
| 4 | `osThread.hpp` | `src/hotspot/share/runtime/osThread.hpp` | runtime | `ThreadState` 枚举(:44-54): ALLOCATED/INITIALIZED/RUNNABLE/ZOMBIE | ★★ 线程状态——握手状态机 |
| 5 | `os.hpp` | `src/hotspot/share/runtime/os.hpp` | runtime | `ThreadType` 枚举(:487-495): vm_thread/cgc_thread/pgc_thread/java_thread/compiler_thread/watcher_thread | ★★ 接口——6 种线程类型的默认栈大小 |
| 6 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | runtime | `JavaThread::run`(:1927-1964), `Threads::create_vm`(:3886-4338), `JavaThread::JavaThread` 构造函数 | ★★ VM 线程创建——从构造函数到 run() 的完整路径 |
| 7 | `os_posix.cpp` | `src/hotspot/os/posix/os_posix.cpp` | os/posix | `get_initial_stack_size`(:187+) | ★ 栈大小计算——ThreadType → 默认栈大小的映射 |

**跨模块说明**：线程创建跨越 os/linux、os/posix、runtime 三个层次。`os/linux/os_linux.cpp` 的 `create_thread` 和 `thread_native_entry` 是本阶段最关键的线程函数——前者映射 JVM ThreadType 到 pthread 参数，后者是所有 JVM 线程（无论 JavaThread/CompilerThread/GCThread/VMThread）醒来的统一入口。

**前置**：[07-thread-lock]（JavaThread 生命周期 + ThreadSMR）, [11-01-Signals]（hotspot_sigmask 信号屏蔽字设置）, [09-native-interface]（JNI AttachCurrentThread 的 OS 绑定路径）

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。★ 必须覆盖 README §八 的全部 4 个深度问题。

### 4.1 ★★★ 全景：JavaThread 怎么变成 OS 线程

```
问题：
  ① JavaThread 构造函数的哪一行触发了 pthread_create？
    线索: thread.cpp JavaThread::JavaThread() 构造函数 → os::create_thread 调用
    答案方向: JavaThread 构造函数（或其调用者 Threads::create_vm / JVM_StartThread）
    调用 `os::create_thread(this, thr_type, stack_size)`。注意：此时 JavaThread 对象
    已分配完毕（包括 JavaThread 自身和其 `OSThread` 成员），但线程尚未执行。
    `os::create_thread` 首先 `new OSThread(NULL, NULL)`（os_linux.cpp:973）→ 
    设置 `ALLOCATED` 状态（:984）→ 然后 `pthread_create`（:1031）。
    
  ② 为什么 create_thread 返回后线程一定没开始执行？
    答案方向: `pthread_create` 只保证 LWP 被创建——调度由内核决定。
    但 `sync_with_child` 握手保证了"子线程已完成 TLS 绑定 + INITIALIZED 状态"
    之后父线程才从 `create_thread` 返回。在此之前父线程被阻塞在
    `sync_with_child->wait()`（os_linux.cpp:1079）。
    
  ③ 父子握手用的是什么同步原语？
    线索: os_linux.cpp:1074-1079, 909, 933-944
    代码引证:
      Monitor *sync_with_child = osthread->startThread_lock();
      MutexLockerEx ml(sync_with_child, Mutex::_no_safepoint_check_flag);
      while ((state = osthread->get_state()) == ALLOCATED) {
        sync_with_child->wait(Mutex::_no_safepoint_check_flag);
      }
    答案方向: 用的是 `Monitor`（JVM 的 PlatformEvent 包装）——不是 `pthread_mutex`、
    不是 `pthread_cond`。关键：`Mutex::_no_safepoint_check_flag` 确保在等待时不触发
    safepoint——因为此时父线程可能不在 `_thread_in_vm` 状态。
```

### 4.2 ★★★ os::create_thread() 逐行走读

```
问题：
  ① pthread_attr 的 4 个属性各是什么，不设会怎样？
    线索: os_linux.cpp:990-1010
    代码引证:
      pthread_attr_t attr;
      pthread_attr_init(&attr);
      pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
      // stack_size from os::Posix::get_initial_stack_size(thr_type, req_stack_size)
      // + guard_size for stack overflow detection
      pthread_attr_setstacksize(&attr, stack_size);
      // guard_size NOT set via pthread_attr_setguardsize — JVM manages its own guard pages
      pthread_create(&tid, &attr, (void*(*)(void*)) thread_native_entry, thread);
    答案方向: (1) init——分配属性对象内存；(2) setdetachstate(DETACHED)——线程结束
    后 OS 自动释放资源；(3) setstacksize——Java 栈大小（-Xss），thread 类型默认栈
    + guard_size；(4) 注意 JVM **不设** `pthread_attr_setguardsize`——JVM 的 guard page
    （yellow/red/reserved zone）是用户态管理的（`create_stack_guard_pages` → `mprotect`），
    不依赖内核的 guard page。

  ② pthread_create 失败 EAGAIN 时为什么重试 3 次？
    线索: os_linux.cpp:1022-1032
    代码引证:
      int limit = 3;
      do {
        ret = pthread_create(&tid, &attr, (void*(*)(void*)) thread_native_entry, thread);
      } while (ret == EAGAIN && limit-- > 0);
    答案方向: EAGAIN = 系统线程数超限（`/proc/sys/kernel/threads-max` 或 cgroup pids.max）。
    短时间窗口内其他线程可能退出释放 slot → 重试有可能成功。3 次是经验值——如果 3 次
    EAGAIN → 大概率是系统真的满了（不是瞬时尖峰）。

  ③ ★ README §八 问题 1: sync_with_child 有超时保护吗？
    线索: os_linux.cpp:1079 — `sync_with_child->wait()` **没有超时参数**
    答案方向: Monitor::wait(Mutex::_no_safepoint_check_flag) 是**无限等待**——
    如果子线程初始化中 SIGSEGV 崩溃（如 `hotspot_sigmask` 写坏栈）→ 子线程
    `sync->notify_all()`(行 938) 永远不会被调用 → 父线程永久阻塞。
    **当前代码没有超时保护**。这是已知设计选择——因为子线程初始化在 `thread_native_entry`
    开头，此时线程在 `ALLOCATED → INITIALIZED` 转换中，崩溃概率极低。
    但如果真的崩溃 → 整个 JVM 进程挂起（create_thread 调用者是 JMX 或 VMThread→ 连锁阻塞）。

  ④ get_initial_stack_size 怎么算出最终栈大小？
    线索: os_posix.cpp get_initial_stack_size, os_linux.cpp:996-1006
    答案方向: ThreadType 默认栈 → 如果 req_stack_size > 0（-Xss）→ 覆盖默认。
    再加 guard_size（os::Linux::default_guard_size）→ 对齐到 `os::vm_page_size()`。
    ThreadType 默认值：
    - java_thread: 1MB（被 -Xss 覆盖）
    - compiler_thread: 4MB（C2 编译器递归遍历的栈深度）
    - gc_thread: 512KB
    - watcher_thread: 512KB
    - vm_thread: 512KB
```

### 4.3 ★★★ thread_native_entry — 所有 JVM 线程的统一醒来入口

```
问题：
  ① 醒来后按什么顺序初始化？
    线索: os_linux.cpp:885-963
    答案方向: 7 步序列（精确行号）:
    (1) `record_stack_base_and_size()`(:888) — 栈基址+大小记录，用于后续栈溢出检测
    (2) `initialize_thread_current()`(:906) — TLS 绑定：`pthread_setspecific(key, thread)`
         → `Thread::current()` 从此返回该线程的 Thread 指针
    (3) `os::Linux::hotspot_sigmask(thread)`(:924) — 信号屏蔽字（★ 引用 [11-01]§五）
    (4) `os::Linux::init_thread_fpu_state()`(:927) — FPU 状态初始化
    (5) `sync->notify_all()`(:938) — 通知父线程"我已初始化"（状态: ALLOCATED→INITIALIZED）
    (6) `sync->wait()`(:944) — 等待父线程 `pd_start_thread()` 唤醒
    (7) `thread->call_run()`(:952) — 虚函数分发 → `JavaThread::run()`/`CompilerThread::run()` 等

  ② ★ README §八 问题 2: Thread::current() 怎么工作？如果 native 线程调了它返回什么？
    线索: os_linux.cpp:906 — `thread->initialize_thread_current()` → 调用
    `os::thread_local_storage_at_put(thread_index(), thread)` → `pthread_setspecific`
    答案方向: `Thread::current()` 内部调 `pthread_getspecific` 读 TLS。如果是 native 线程
    （非 JVM 创建的 pthread）→ TLS key 从未被 `pthread_setspecific` → 返回值是 NULL。
    JVM 代码中常用 `Thread::current()` 检查是否在 JVM 线程上下文——返回 NULL 表示是
    外部 native 线程（例如 JNI AttachCurrentThread 调用之前的 native 线程）。

  ③ ★ README §八 问题 3: stack_size 被 glibc 内部调整后，JVM 怎么发现差异？
    线索: os_linux.cpp:888 — `record_stack_base_and_size()` → 调 
    `pthread_attr_getstack(&attr, &stack_base, &stack_size)` 读回实际值
    答案方向: glibc 的 `pthread_attr_setstacksize` 可能内部调整（加上 guard、
    对齐到 `__pthread_get_minstack` 的倍数）。JVM 通过 `pthread_attr_getstack`
    **读回实际分配的栈基址和大小**，用这些值来定位 yellow/red zone 的 `mprotect`
    边界。如果 JVM 用 -Xss 值替代实际栈大小 → yellow zone 的 `mprotect` 地址
    可能落在实际栈外 → StackOverflow 检测失败 → 真正的栈溢出变成 wild SIGSEGV。

  ④ step (5)→(6) 的两阶段握手必要性？
    代码引证:
      // Point A — child (thread_native_entry)
      sync->notify_all();  // wake parent blocked at create_thread:1079
      while (osthread->get_state() == INITIALIZED) {
        sync->wait(...);   // wait until pd_start_thread() calls notify()
      }
      // Point B — parent (create_thread:1079)
      sync_with_child->wait(...);   // woken by child's notify_all()
      // ... (returns to caller, which may call pd_start_thread)
      // Point C — parent (pd_start_thread:1188-1190)
      sync_with_child->notify();    // wake child, child state no longer INITIALIZED
    答案方向: 从 `pthread_create` 返回到 `pd_start_thread` 之间有父线程逻辑
    （如设置 thread_id、记录到列表）——如果子线程不等 pd_start_thread 就调
    call_run → 竞态。两阶段保证：init 阶段（A→B）确认子线程已创建；start 阶段
    （C）确保父线程所有簿记完成 → 子线程才开始跑用户代码。
```

### 4.4 ★★ 4 种 ThreadType 的默认栈大小

```
问题：
  ① 为什么 compiler_thread 要 4MB？
    答案方向: C2 编译器的优化遍历（IGVN/CCP/LoopOpt）递归深度可达数千帧——
    128KB 的默认 Linux 栈不够。4MB 是经验值。如果编译器栈溢出 → SIGSEGV →
    JVM crash → hs_err 显示 CompilerThread → 排查方向: 加 `-XX:CompilerThreadStackSize=`。

  ② -Xss256k 在 Docker 里为什么报错？
    答案方向: Docker cgroup pids.max 可能限制了 LWP 总数 → 每个线程栈 + guard 
    占用虚拟地址空间（但不一定吃物理内存）→ 小 -Xss 使更多线程可以存在于
    虚拟地址空间 → 但容器内的其他限制（如 vm.max_map_count = 65530）可能
    先触发。此外，glibc 的 `__pthread_get_minstack` 返回的最小栈可能超过
    256k → pthread_attr_setstacksize 被 glibc 内部提升到最小值 → JVM 不知道
    这个提升 → 认为栈是 256k 但实际是 min_stack。
    ★ README §八 问题 3: 这个差异影响 StackOverflow guard page 定位吗？
    → 如果 JVM 用自己记录的 256k 定位 yellow zone → mprotect 的地址在
    实际栈内偏上 → yellow zone 比设计的小 → StackOverflow 提前触发（过早抛错）
    或更糟——red zone 不在栈底 → 真正的溢出越过 guard 损坏邻居内存。

  ③ gc_thread 为什么只需 512KB？
    答案方向: GC 线程是固定模式的 worker——每个任务（如 scan 一个 region）
    调用栈浅且可预测。G1 有 ~N 个 GC 线程（ParallelGCThreads），每个 512KB
    → N×512KB 总计不大。如果 512KB 不够 → GC 线程栈溢出 → JVM fatal → 
    排查方向: GC 递归 bug（如 RSet scanning 有循环引用导致无限递归）。
```

### 4.5 ★★ 和 [11-01] 的连接：hotspot_sigmask 在 thread_native_entry 中

```
问题：
  ① 为什么线程创建后要在子线程中重新设置信号屏蔽字？
    答案方向: pthread_create 不继承父线程的信号屏蔽字——新线程从 glibc 的
    默认屏蔽字开始（全解禁）。JVM 必须显式解禁 SIGSEGV/SIGBUS 等内部信号、
    阻塞 BREAK_SIGNAL（如果非 VMThread）。[11-01]§五 详细解释了 
    unblocked_sigs/vm_sigs 的构成——本文引用它并说明调用点（os_linux.cpp:924）
    在线程初始化序列中的位置。

  ② 如果 hotspot_sigmask 在 thread_native_entry 中失败了——会怎样？
    答案方向: `pthread_sigmask` 极少失败。如果失败（如 EINVAL = 无效 sigset_t）
    → assert fire → JVM crash。但此时子线程还没有 notify_all —— 父线程在 
    create_thread:1079 永久阻塞。
    ★ README §八 问题 1 的根源就在这里——没有超时保护的 wait。
```

### 4.6 ★ JNI AttachCurrentThread 的特殊路径：os::create_attached_thread

```
问题：
  ① create_attached_thread 和 create_thread 有什么本质不同？
    线索: os_linux.cpp:1109-1183 vs 965-1098
    答案方向: create_attached_thread 不走 pthread_create——
    线程已经被 OS 创建（是外部 native 线程）。它只做：
    (1) new OSThread + 绑定已有 pthread（:1116-1129）
    (2) 直接 set_state(RUNNABLE)（:1137）——跳过 ALLOCATED/INITIALIZED 握手！
    (3) hotspot_sigmask + FPU init（:1177）
    不需要 sync_with_child 因为不存在"父线程等子线程初始化"的关系——
    调用方本身就是这个线程。

  ② 为什么这条路径不走 sync_with_child？
    答案方向: JavaThread 对象由调用方（当前线程）自己创建并关联到自己的 pthread——
    不需要"等待另一个线程初始化"。不存在竞态——你总是能访问自己的 Thread 对象。

  ③ 这和 [09-native] 的 JNI AttachCurrentThread 是什么关系？
    答案方向: [09] 讲 JNI AttachCurrentThread 的规范语义——线程状态转换、
    JNIEnv 分配等。本文讲 OS 层——JavaThread 数据结构怎么和已有 pthread 绑定。
    09 是"JNI 规范层"，11 是"OS 实现层"。
```

## 五、文章结构

```
§〇 源文件清单（跨 os/linux + os/posix + runtime，标注每个文件的模块归属和在线程创建中的角色）

§一 ★★★ 全景：JavaThread 怎么变成 OS 线程
  ❓ JavaThread 构造函数的哪一行触发了 pthread_create？
  ❓ 为什么需要 sync_with_child 握手？
  ❓ 父子同步的 Monitor 是什么——它和 pthread_mutex 有什么区别？
  1.1 ★ 从 JavaThread::JavaThread() 到 os::create_thread() 的完整调用链
  1.2 OSThread 的生命周期——从 new 到 ALLOCATED 到 INITIALIZED 到 RUNNABLE
  1.3 sync_with_child 的三阶段状态机——ALLOCATED → INITIALIZED → RUNNABLE

§二 ★★★ os::create_thread() 逐行走读
  ❓ pthread_attr 的 4 个属性各是什么？不设会怎样？
  ❓ pthread_create 失败 EAGAIN 为什么重试 3 次？
  2.1 ★ pthread_attr_init → setdetachstate(DETACHED) → setstacksize → pthread_create
  2.2 stack_size 的计算——get_initial_stack_size(thr_type, req_stack_size) + guard_size
  2.3 EAGAIN 重试 3 次的"slot 窗口"语义
  2.4 ★ sync_with_child->wait() 没有超时保护——如果子线程 SIGSEGV → 永久阻塞

§三 ★★★ thread_native_entry — 所有 JVM 线程的统一醒来入口
  ❓ 醒来后按什么顺序初始化？（7 步序列 + 精确行号）
  ❓ 信号屏蔽字为什么要在子线程中设置？（引用 [11-01]§五）
  3.1 ★ 7 步初始化序列——每步的"如果失败会怎样"分析
  3.2 record_stack_base_and_size → pthread_attr_getstack 读回实际栈信息
  3.3 ★ Thread::current() 的 TLS 绑定——initialize_thread_current
  3.4 两阶段握手：notify_all → wait → 被 pd_start_thread 唤醒 → call_run
  3.5 call_run → 虚函数分发到各 ThreadType 的 run()

§四 ★★ 4 种 ThreadType 的默认栈大小
  ❓ 为什么 compiler_thread 要 4MB？
  ❓ -Xss256k 在 Docker 里为什么报错？
  4.1 ThreadType 枚举（os.hpp:487）→ 默认栈大小映射表
  4.2 compiler_thread 的 4MB 理由——C2 递归深度分析
  4.3 gc_thread 512KB——worker 模式的栈需求
  4.4 ★ README §八 问题 3: glibc 调整后的实际栈 vs JVM 预期栈的差异

§五 ★★ 和 [07-thread-lock] + [11-01-Signals] + [09-native] 的交叉连接
  ❓ 07 的 JavaThread 生命周期 → 本文的 pthread_create 如何"补完"？
  ❓ 11-01 的 hotspot_sigmask 在 thread_native_entry 的调用点（:924）
  ❓ 09 的 JNI AttachCurrentThread → create_attached_thread 的特殊路径
  5.1 [07-thread-lock] JavaThread::run → thread_main_inner vs thread_native_entry → call_run → JavaThread::run
  5.2 ★ [11-01] signalHandler 依赖的信号屏蔽字——由本文的 thread_native_entry(:924) 设置
  5.3 [09-native] JNI AttachCurrentThread 的 OS 绑定——不创建 LWP，只绑定 JavaThread 数据结构
  5.4 ★ README §五 阶段对比表——线程是 11 的第二原语

§六 ★ pd_start_thread + set_native_priority
  ❓ setpriority(PRIO_PROCESS, tid, priority) 在内核 cgroup 限制下会静默失败吗？
  ❓ ★ README §八 问题 4: CONFIG_RT_GROUP_SCHED 下的优先级设置行为？
  6.1 pd_start_thread 的 notify 唤醒子线程——第三阶段握手完成
  6.2 set_native_priority 的调用链——JavaThread::prepare → Thread::set_priority → os::set_priority
  6.3 cgroup rt 组调度 vs setpriority——优先级可能被静默截断

§七 GDB 验证 + 可证伪断言
```

## 六、写作要求

1. **★ "7 步初始化序列" 是本文的第一交付物**：每一步标注行号、用途、"如果失败会怎样"。读者看完后能在 GDB 中断在任一步骤。

2. **★ sync_with_child 的"没有超时保护"是本文最大的生产风险点**：必须明确指出 `Monitor::wait` 无超时参数——如果子线程在 notify 前 SIGSEGV → 父线程永久阻塞 → JVM hang。这是 README §八 问题 1 的核心。

3. **★ glibc 调整后的实际栈 vs JVM 预期栈的差异**：`pthread_attr_getstack` 读回的实际值 ≠ `-Xss` 传入值 → yellow/red zone 边界偏移 → StackOverflow 检测不准。这是 README §八 问题 3 的核心。

4. **★ 和 [11-01] 的信号屏蔽字连接不能省略**：`hotspot_sigmask` 在 `thread_native_entry:924` 被调用——这是 [11-01]§五 的"线程醒来时设置信号屏蔽字"的具体实现。

5. **★ 4 种 ThreadType 的栈大小表**：java_thread 1MB / compiler_thread 4MB / gc_thread 512KB / watcher_thread 512KB——每个的"为什么这么大/小"有精确推理。

6. **★ 不要忽略 create_attached_thread**：这是 JNI AttachCurrentThread 的 OS 实现——和 create_thread 形成"创建 vs 绑定"的对照。

7. **★ 和 [07-thread-lock] 的连接必须精确到概念**：07 的 JavaThread::run → thread_main_inner → entry_point，本文的 thread_native_entry → call_run → JavaThread::run。两层调用链的对接。

## 七、输出格式

- Markdown 文件，命名为 `02-Threads.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/11-os-layer/`
- 元信息头：
  ```
  > **阶段**：[11-os-layer]
  > **前置**：[07-thread-lock]（JavaThread 生命周期）, [11-01-Signals]（hotspot_sigmask 信号屏蔽字）, [09-native-interface]（JNI AttachCurrentThread 的 OS 绑定）
  > **依赖本文**：[11-04]（crash 报告的线程栈打印依赖 os::create_thread 分配的栈信息）
  > **阅读收益**：理解 JavaThread 从 JVM 数据结构变成内核调度实体的唯一路径——pthread_create 的完整参数链、thread_native_entry 的 7 步初始化序列、sync_with_child 握手的安全边界（以及没有超时保护的风险）
  ```

## 禁止行为

- ❌ 把 `pthread_attr_*` 的 glibc 手册抄一遍——不讲 `pthread_attr_setinheritsched`、`pthread_attr_setscope`、`pthread_attr_setaffinity_np` 等 JVM 不设的属性
- ❌ 解释 Linux `clone()` 的 flags（CLONE_VM/CLONE_FS/CLONE_FILES/CLONE_SIGHAND）——这属于 Linux 内核，和本文的"JVM 怎么调 pthread_create"主线无关
- ❌ 深入 `set_native_priority` 的 cgroup 优先级映射算法——只讲"setpriority 可能被 cgroup 静默截断"，不讲 cfs_period_us / cpu.shares 的计算
- ❌ 忘记 [11-01] 的 `hotspot_sigmask`——每提到 `thread_native_entry:924`，必须引用 [11-01]§五 的信号屏蔽字详解
- ❌ 把 `JavaThread::run()` 的完整实现展开——那属于 [07-thread-lock]，本文只讲它是 `thread_native_entry → call_run → JavaThread::run` 的末端
- ❌ 忽略 JNI AttachCurrentThread 的 `create_attached_thread` 路径——它和 `create_thread` 的对比是理解"创建 vs 绑定"的钥匙
- ❌ 不做 sync_with_child 的失败模式分析——必须列出"子线程 SIGSEGV / OOM / 锁冲突 → 父线程永久阻塞"的因果链
- ❌ 忽略 `record_stack_base_and_size` 中的 `pthread_attr_getstack`——这是 JVM 知道"实际栈大小"的唯一方式
- ❌ 不覆盖 README §八 的全部 4 个深度问题——每个问题必须在 §四 中有一个问题组明确对应

## 要求行为

- ✅ **★ 7 步初始化序列的完整表格**：步号 / 行号 / 操作 / 用的系统调用或 JVM 函数 / 如果失败会怎样
- ✅ **★ sync_with_child 三阶段状态机的序列图**：横轴 = 父线程 / 子线程，纵轴 = 时间，标注 ALLOCATED→INITIALIZED→RUNNABLE 的转换点和对应的 notify/wait
- ✅ **★ 4 种 ThreadType 的栈大小决策表**：ThreadType / 默认栈 / 可被 -Xss 覆盖 / 大小理由 / 不够时的症状
- ✅ **★ create_thread vs create_attached_thread 的对照表**：pthread_create 调用 / sync_with_child 握手 / 线程状态 / 信号屏蔽字 / FPU 初始化
- ✅ **★ 和 [07-thread-lock] 的两层调用链对接图**：07 层 JavaThread::run → thread_main_inner 和 11 层 thread_native_entry → call_run → JavaThread::run 的 ASCII 对照
- ✅ **★ 和 [11-01] 的 precise 连接**：`thread_native_entry:924` → `os::Linux::hotspot_sigmask(thread)` → [11-01]§五 的信号集定义
- ✅ **★ 【11-os-layer README §五 阶段对比表】的引用**——在 §一 或 §五 中引用该表
- ✅ **★ 和 [09-native] 的 create_attached_thread 对比**
- ✅ **★ GDB 可证伪断言 ≥10 条**

## GDB 可证伪断言

1. **断言：`pthread_create` 在内核中创建 LWP，新线程不一定立即调度**
   验证：`br os_linux.cpp:1031` → `stepi` 单步进入 `pthread_create` → `p $rax` 返回 tid → `br thread_native_entry:885` → 可能在第一条指令前有延迟
   预期：两个断点之间的时间差 != 0——新线程可能未立即被调度

2. **断言：`sync_with_child` 握手期间父线程状态为 ALLOCATED**
   验证：`br os_linux.cpp:1078` → `p osthread->get_state()` → 确认首次为 ALLOCATED → 子线程初始化完成后变为 INITIALIZED → while 退出
   预期：`state` 从 ALLOCATED 变为 INITIALIZED 时 `wait()` 返回

3. **断言：子线程在 `thread_native_entry` 中 `notify_all` 后自旋等待父线程**
   验证：`br os_linux.cpp:938` (notify) → `br os_linux.cpp:944` (wait) → 两者都被同一子线程命中
   预期：子线程在 944 阻塞 → 直到 `pd_start_thread:1190` 调用 `notify()`

4. **断言：`os::create_attached_thread` 不调 `pthread_create`**
   验证：`br os_linux.cpp:1109` → 单步执行到函数末尾 → 确认没有任何 `pthread_create` 调用
   预期：OSThread 直接设为 RUNNABLE（行 1137）

5. **断言：4 种 ThreadType 在 `os::create_thread` 中得到不同的 stack_size**
   验证：`br os_linux.cpp:1010` → 在不同 ThreadType 下触发（JavaThread / CompilerThread / GCThread）→ `p stack_size` → 对比值
   预期：compiler_thread stack_size ≈ 4MB, gc_thread ≈ 512KB, java_thread ≈ 1MB

6. **断言：EAGAIN 重试循环第 3 次失败后不再重试**
   验证：`br os_linux.cpp:1031` → 设置条件（内核 threads-max 已满）→ `p limit` → 观察递减到 0
   预期：第 4 次不进入循环 → 函数返回 false

7. **断言：`record_stack_base_and_size` 读回的实际栈大小可能 > -Xss**
   验证：`br os_linux.cpp:888` → `stepi` 进入 `record_stack_base_and_size` → 读 `pthread_attr_getstack` 返回值 → 对比传入的 -Xss 值
   预期：实际值 ≥ 传入值（glibc 上调了栈大小）

8. **断言：`Thread::current()` 在 thread_native_entry 的 `initialize_thread_current` 前返回 NULL**
   验证：`br os_linux.cpp:906` → 在 `p initialize_thread_current` 未调用前 → `p (Thread*)pthread_getspecific(key)` → 值 = NULL
   预期：initialize 后 `Thread::current()` 返回新线程指针

9. **断言：`hotspot_sigmask` 在子线程中解禁 SIGSEGV**
   验证：`br os_linux.cpp:924` → `stepi` 单步进入 `hotspot_sigmask` → `p sigismember(&unblocked_sigs, SIGSEGV)` → true → 验证 `pthread_sigmask(SIG_UNBLOCK, ...)`
   预期：信号屏蔽字不包含 SIGSEGV（SIGSEGV 不在 SigBlk 中）

10. **断言：`pd_start_thread` 唤醒子线程后子线程开始 `call_run`**
    验证：`br os_linux.cpp:1190` (pd_start_thread notifies) → `br os_linux.cpp:952` (call_run) → 两断点先后命中（1190 先、952 后）
    预期：子线程在 944 的 wait 返回 → 进入 call_run → JavaThread::run

11. **断言：`create_thread` 返回 false 时 `thread->osthread()` 可能仍为非 NULL（部分初始化）**
    验证：在 EAGAIN 场景下 `br os_linux.cpp:1032` → 返回 false → `p thread->osthread()` → 非 NULL（行 986 set_osthread 已完成）
    预期：调用方需检查返回值并清理 osthread
