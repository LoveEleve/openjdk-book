# 3.5 Stage 3：OS 后初始化

> os::init_2 / SafepointMechanism / agent 转换

上一节完成了参数解析，现在参数已经全部到位（包括命令行传入的、ergo 自动调整的、以及约束检查通过的），JVM 需要做 OS 层面的第二轮初始化。

---

## Stage 3 全貌

`Threads::create_vm` 中 Stage 3 的源码：

```cpp
/* === src/hotspot/share/runtime/thread.cpp === */

  HOTSPOT_VM_INIT_BEGIN();

  // Timing (must come after argument parsing)
  TraceTime timer("Create VM", TRACETIME_LOG(Info, startuptime));

  // Initialize the os module after parsing the args
  jint os_init_2_result = os::init_2();
  if (os_init_2_result != JNI_OK) return os_init_2_result;

#ifdef CAN_SHOW_REGISTERS_ON_ASSERT
  // Initialize assert poison page mechanism.
  if (ShowRegistersOnAssert) {
    initialize_assert_poison();
  }
#endif // CAN_SHOW_REGISTERS_ON_ASSERT

  SafepointMechanism::initialize();

  jint adjust_after_os_result = Arguments::adjust_after_os();
  if (adjust_after_os_result != JNI_OK) return adjust_after_os_result;

  // Initialize output stream logging
  ostream_init_log();

  // Convert -Xrun to -agentlib: if there is no JVM_OnLoad
  // Must be before create_vm_init_agents()
  if (Arguments::init_libraries_at_startup()) {
    convert_vm_init_libraries_to_agents();
  }

  // Launch -agentlib/-agentpath and converted -Xrun agents
  if (Arguments::init_agents_at_startup()) {
    create_vm_init_agents();
  }
```

七个步骤按顺序执行，每一步失败都会直接 `return` 退出 VM 创建：

| 步骤 | 函数 | 职责 |
|------|------|------|
| 1 | `os::init_2()` | OS 第二阶段初始化（信号、NUMA、线程优先级） |
| 2 | `SafepointMechanism::initialize()` | 分配全局安全点轮询页面 |
| 3 | `Arguments::adjust_after_os()` | OS 就绪后最终调整 flag |
| 4 | `ostream_init_log()` | 初始化日志输出流 |
| 5 | `convert_vm_init_libraries_to_agents()` | 将 `-Xrun` 库转为 agent |
| 6 | `create_vm_init_agents()` | 调用 Agent_OnLoad 启动 agents |

注意开头还有 `HOTSPOT_VM_INIT_BEGIN()` —— 这是 JVMTI 的 VM 初始化事件回调点，通知已注册的 JVMTI agent VM 初始化正式开始。`TraceTime timer` 启动 `"Create VM"` 计时器，用于最终输出 VM 创建耗时。

`CAN_SHOW_REGISTERS_ON_ASSERT` 分支是调试功能：`ShowRegistersOnAssert` 是一个开发用 flag，默认 false，普通用户不会触发。此处跳过不讲解。

---

## 1. `os::init_2()` —— OS 第二阶段初始化

`os::init_2()` 声明在 `os.hpp:173`：

```cpp
/* === src/hotspot/share/runtime/os.hpp === */

  static jint init_2(void);                    // Called after command line parsing
```

注释说明这不是通用的 OS 初始化，而是需要参数解析完成之后才能做的事情。Linux 实现位于 `os_linux.cpp:5588-5717`：

```cpp
/* === src/hotspot/os/linux/os_linux.cpp === */

jint os::init_2(void) {

  os::Posix::init_2();

  Linux::fast_thread_clock_init();

  // initialize suspend/resume support - must do this before signal_sets_init()
  if (SR_initialize() != 0) {
    perror("SR_initialize failed");
    return JNI_ERR;
  }

  Linux::signal_sets_init();
  Linux::install_signal_handlers();
  // Initialize data for jdk.internal.misc.Signal
  if (!ReduceSignalUsage) {
    jdk_misc_signal_init();
  }

  // Check and sets minimum stack sizes against command line options
  if (Posix::set_minimum_stack_sizes() == JNI_ERR) {
    return JNI_ERR;
  }

#if defined(IA32) && !defined(ZERO)
  // Need to ensure we've determined the process's initial stack to
  // perform the workaround
  Linux::capture_initial_stack(JavaThread::stack_size_at_create());
  workaround_expand_exec_shield_cs_limit();
#else
  suppress_primordial_thread_resolution = Arguments::created_by_java_launcher();
  if (!suppress_primordial_thread_resolution) {
    Linux::capture_initial_stack(JavaThread::stack_size_at_create());
  }
#endif

  Linux::libpthread_init();
  Linux::sched_getcpu_init();
  log_info(os)("HotSpot is running with %s, %s",
               Linux::libc_version(), Linux::libpthread_version());

#ifdef __GLIBC__
  // Check if we need to adjust the stack size for glibc guard pages.
  init_adjust_stacksize_for_guard_pages();
#endif

  if (UseNUMA) {
    if (!Linux::libnuma_init()) {
      UseNUMA = false;
    } else {
      if ((Linux::numa_max_node() < 1) || Linux::isbound_to_single_node()) {
        // If there's only one node (they start from 0) or if the process
        // is bound explicitly to a single node using membind, disable NUMA.
        UseNUMA = false;
      }
    }

    if (UseParallelGC && UseNUMA && UseLargePages && !can_commit_large_page_memory()) {
      // With SHM and HugeTLBFS large pages we cannot uncommit a page, so there's no way
      // we can make the adaptive lgrp chunk resizing work. If the user specified both
      // UseNUMA and UseLargePages (or UseSHM/UseHugeTLBFS) on the command line - warn
      // and disable adaptive resizing.
      if (UseAdaptiveSizePolicy || UseAdaptiveNUMAChunkSizing) {
        warning("UseNUMA is not fully compatible with SHM/HugeTLBFS large pages, "
                "disabling adaptive resizing (-XX:-UseAdaptiveSizePolicy -XX:-UseAdaptiveNUMAChunkSizing)");
        UseAdaptiveSizePolicy = false;
        UseAdaptiveNUMAChunkSizing = false;
      }
    }

    if (!UseNUMA && ForceNUMA) {
      UseNUMA = true;
    }
  }

  if (MaxFDLimit) {
    // set the number of file descriptors to max. print out error
    // if getrlimit/setrlimit fails but continue regardless.
    struct rlimit nbr_files;
    int status = getrlimit(RLIMIT_NOFILE, &nbr_files);
    if (status != 0) {
      log_info(os)("os::init_2 getrlimit failed: %s", os::strerror(errno));
    } else {
      nbr_files.rlim_cur = nbr_files.rlim_max;
      status = setrlimit(RLIMIT_NOFILE, &nbr_files);
      if (status != 0) {
        log_info(os)("os::init_2 setrlimit failed: %s", os::strerror(errno));
      }
    }
  }

  // Initialize lock used to serialize thread creation (see os::create_thread)
  Linux::set_createThread_lock(new Mutex(Mutex::leaf, "createThread_lock", false));

  // at-exit methods are called in the reverse order of their registration.
  // atexit functions are called on return from main or as a result of a
  // call to exit(3C). There can be only 32 of these functions registered
  // and atexit() does not set errno.

  if (PerfAllowAtExitRegistration) {
    if (atexit(perfMemory_exit_helper) != 0) {
      warning("os::init_2 atexit(perfMemory_exit_helper) failed");
    }
  }

  // initialize thread priority policy
  prio_init();

  if (!FLAG_IS_DEFAULT(AllocateHeapAt)) {
    set_coredump_filter(DAX_SHARED_BIT);
  }

  if (DumpPrivateMappingsInCore) {
    set_coredump_filter(FILE_BACKED_PVT_BIT);
  }

  if (DumpSharedMappingsInCore) {
    set_coredump_filter(FILE_BACKED_SHARED_BIT);
  }

  return JNI_OK;
}
```

这个函数按逻辑分 10 段。逐一展开。

### 1.1 Posix 公共层：时钟与信号集

```cpp
  os::Posix::init_2();
```

`os::Posix::init_2()` 在 `os_posix.cpp:1837-1847`。它做的事情就是打三条日志，报告当前平台对各种时钟的支持情况。

Linux 上 `SUPPORTS_CLOCK_MONOTONIC` 宏为 true（该宏通过 `#ifdef CLOCK_MONOTONIC` 判断），所以走以下分支：

```cpp
/* === src/hotspot/os/posix/os_posix.cpp === */

void os::Posix::init_2(void) {
  log_info(os)("Use of CLOCK_MONOTONIC is%s supported",
               (_clock_gettime != NULL ? "" : " not"));
  log_info(os)("Use of pthread_condattr_setclock is%s supported",
               (_pthread_condattr_setclock != NULL ? "" : " not"));
  log_info(os)("Relative timed-wait using pthread_cond_timedwait is associated with %s",
               _use_clock_monotonic_condattr ? "CLOCK_MONOTONIC" : "the default clock");
#ifndef SOLARIS
  sigemptyset(&sigs);
#endif
}
```

`CLOCK_MONOTONIC` 是 Linux 提供的一种不受系统时间调整影响的时钟源。`_use_clock_monotonic_condattr` 在 `os::Posix::init()` 阶段（即 `os::init()` 调用时）已经根据 `dlopen("librt.so")` 的结果确定了——如果能拿到 `clock_gettime` 和 `pthread_condattr_setclock` 两个函数指针，就用单调时钟。`sigemptyset(&sigs)` 清空全局信号集 `sigs`，该信号集后续会被信号处理器使用。

本机运行 `java -Xlog:os=info -version` 时这三行日志的输出是：

```
[0.004s][info][os] Use of CLOCK_MONOTONIC is supported
[0.004s][info][os] Use of pthread_condattr_setclock is supported
[0.004s][info][os] Relative timed-wait using pthread_cond_timedwait is associated with CLOCK_MONOTONIC
```

### 1.2 fast_thread_clock_init

```cpp
  Linux::fast_thread_clock_init();
```

这是 Linux 特有的优化，尝试用 `clock_gettime(CLOCK_THREAD_CPUTIME_ID)` 替代昂贵的系统调用来获取线程 CPU 时间。

### 1.3 挂起/恢复与信号处理

```cpp
  if (SR_initialize() != 0) {
    perror("SR_initialize failed");
    return JNI_ERR;
  }

  Linux::signal_sets_init();
  Linux::install_signal_handlers();
  if (!ReduceSignalUsage) {
    jdk_misc_signal_init();
  }
```

四步依次初始化 Linux 的信号体系：

- `SR_initialize()` —— 初始化线程挂起/恢复机制。JVM 的 Stop-The-World 安全点机制需要能挂起所有 Java 线程，底层依赖 Linux 信号来实现。失败直接返回 `JNI_ERR`。
- `Linux::signal_sets_init()` —— 初始化信号集。JVM 对各种信号（SIGSEGV、SIGBUS、SIGILL 等）有自定义处理器，这一步建立屏蔽字。
- `Linux::install_signal_handlers()` —— 将信号处理器注册到内核。比如 SIGSEGV 注册为 `JVM_handle_linux_signal`，这是 JVM 实现隐式空指针检查（implicit null check）的基础——访问空指针触发 SIGSEGV，JVM 捕获后转换为 Java 的 NullPointerException。
- `jdk_misc_signal_init()` —— 仅当 `!ReduceSignalUsage` 时执行（默认会执行），初始化 `jdk.internal.misc.Signal` 类所需的 native 数据，让 Java 代码能注册信号处理器（`Signal.handle()`）。

`ReduceSignalUsage` 是 JVM flag `-XX:+ReduceSignalUsage`，默认 false。当用户显式设为 true 时跳过 `jdk_misc_signal_init()`，减少 JVM 占用的信号数量，这对嵌入式场景（进程数量大、信号资源有限）有用。

### 1.4 最小栈尺寸校验

```cpp
  if (Posix::set_minimum_stack_sizes() == JNI_ERR) {
    return JNI_ERR;
  }
```

根据参数解析阶段得到的 `-Xss`（ThreadStackSize）和 OS 默认值 `_vm_default_page_size`，设置 `_java_thread_min_stack_allowed` 等全局变量，确保 JVM 创建的每个线程栈都不会小于 OS 允许的最小值。

### 1.5 原始线程栈捕获

```cpp
#if defined(IA32) && !defined(ZERO)
  Linux::capture_initial_stack(JavaThread::stack_size_at_create());
  workaround_expand_exec_shield_cs_limit();
#else
  suppress_primordial_thread_resolution = Arguments::created_by_java_launcher();
  if (!suppress_primordial_thread_resolution) {
    Linux::capture_initial_stack(JavaThread::stack_size_at_create());
  }
#endif
```

这段分两个编译路径。IA32 平台走 `#if` 分支，x86_64 走 `#else` 分支。本机是 x86_64，只讲解 `#else` 路径。

`Arguments::created_by_java_launcher()` 判断 JVM 是否由 `java` 启动器创建（通过检查 `sun.java.launcher` 系统属性是否为 `"SUN_STANDARD"`）。标准 Java 命令行启动时，JVM 在 `JavaMain` 函数中创建，原始线程的栈信息已由 `os::init()` 阶段捕获，这里可以跳过。

但对于通过 JNI `CreateJavaVM()` 嵌入 JVM 的程序（比如 Tomcat 的 jsvc、idea.sh），JVM 运行在调用者的线程上，必须在 `init_2()` 阶段捕获当前线程的栈地址和大小。这就是 `!suppress_primordial_thread_resolution` 分支的作用。

### 1.6 pthread / libc 版本与 NUMA

```cpp
  Linux::libpthread_init();
  Linux::sched_getcpu_init();
  log_info(os)("HotSpot is running with %s, %s",
               Linux::libc_version(), Linux::libpthread_version());

#ifdef __GLIBC__
  init_adjust_stacksize_for_guard_pages();
#endif
```

`libpthread_init()` 用 `dlsym(RTLD_DEFAULT, ...)` 查找 `pthread_condattr_setclock` 等函数指针。`sched_getcpu_init()` 查找 `sched_getcpu()` 用于获取当前 CPU 的 NUMA node ID。`__GLIBC__` 分支调整 glibc 的 guard page 对栈尺寸的影响。

接下来是 NUMA 初始化：

```cpp
  if (UseNUMA) {
    if (!Linux::libnuma_init()) {
      UseNUMA = false;
    } else {
      if ((Linux::numa_max_node() < 1) || Linux::isbound_to_single_node()) {
        UseNUMA = false;
      }
    }

    if (UseParallelGC && UseNUMA && UseLargePages && !can_commit_large_page_memory()) {
      if (UseAdaptiveSizePolicy || UseAdaptiveNUMAChunkSizing) {
        warning("UseNUMA is not fully compatible with SHM/HugeTLBFS large pages, "
                "disabling adaptive resizing ...");
        UseAdaptiveSizePolicy = false;
        UseAdaptiveNUMAChunkSizing = false;
      }
    }

    if (!UseNUMA && ForceNUMA) {
      UseNUMA = true;
    }
  }
```

NUMA（Non-Uniform Memory Access）是多路服务器上的一种内存架构：每个 CPU socket 有自己"近端"的内存区域，访问远端内存延迟更高。JVM 的 NUMA 感知意味着分配堆内存时优先使用当前线程所在 CPU socket 的本地内存。

`Linux::libnuma_init()` 通过 `dlopen("libnuma.so")` 加载 NUMA 库。如果 NUMA 初始化成功但机器只有一个 NUMA node（`numa_max_node() < 1`，注意 node 编号从 0 开始，0 号 node 是第一个）或进程已被绑定到单个 node，NUMA 也没有意义，关闭它。

然后是一个兼容性警告：SHM/HugeTLBFS 大页不能 uncommit，所以和 NUMA 的自适应 chunk 大小调整冲突。如果两者同时存在，禁用自适应策略。

`ForceNUMA`（flag `-XX:+ForceNUMA`）允许强制启用 NUMA，即使前面的检查认为应该禁用。

### 1.7 文件描述符上限

```cpp
  if (MaxFDLimit) {
    struct rlimit nbr_files;
    int status = getrlimit(RLIMIT_NOFILE, &nbr_files);
    if (status != 0) {
      log_info(os)("os::init_2 getrlimit failed: %s", os::strerror(errno));
    } else {
      nbr_files.rlim_cur = nbr_files.rlim_max;
      status = setrlimit(RLIMIT_NOFILE, &nbr_files);
      if (status != 0) {
        log_info(os)("os::init_2 setrlimit failed: %s", os::strerror(errno));
      }
    }
  }
```

`MaxFDLimit` 对应 flag `-XX:+MaxFDLimit`，默认 false。当用户显式启用时，JVM 将进程的文件描述符软限制提升到硬限制。`getrlimit(RLIMIT_NOFILE)` 获取当前限制，`setrlimit` 将 `rlim_cur` 设为 `rlim_max`。

### 1.8 线程创建锁 / atexit / 优先级

```cpp
  Linux::set_createThread_lock(new Mutex(Mutex::leaf, "createThread_lock", false));
```

`os::create_thread()` 创建操作系统线程时需要互斥保护（多线程并发创建线程时防止竞争），这里初始化一个 `leaf` 级别的 Mutex。

```cpp
  if (PerfAllowAtExitRegistration) {
    if (atexit(perfMemory_exit_helper) != 0) {
      warning("os::init_2 atexit(perfMemory_exit_helper) failed");
    }
  }
```

`atexit()` 是 C 标准库函数，注册进程退出时的回调。`perfMemory_exit_helper` 负责清理 JVM 性能监控使用的共享内存文件。`PerfAllowAtExitRegistration` 默认 true。

```cpp
  prio_init();
```

根据 `-XX:ThreadPriorityPolicy` 初始化线程优先级策略。

### 1.9 coredump 过滤器

```cpp
  if (!FLAG_IS_DEFAULT(AllocateHeapAt)) {
    set_coredump_filter(DAX_SHARED_BIT);
  }

  if (DumpPrivateMappingsInCore) {
    set_coredump_filter(FILE_BACKED_PVT_BIT);
  }

  if (DumpSharedMappingsInCore) {
    set_coredump_filter(FILE_BACKED_SHARED_BIT);
  }
```

`AllocateHeapAt` 是 `-XX:AllocateHeapAt=<path>`，将 Java 堆分配在指定文件系统的 DAX（Direct Access）设备上。DAX 是一种绕过 page cache 直接访问持久内存的方式。这种情况需要将 DAX 共享页面包含到 core dump 中。

`DumpPrivateMappingsInCore` 和 `DumpSharedMappingsInCore` 分别控制是否在 core dump 中包含匿名/文件映射的私有/共享映射。这些 flag 主要用于诊断。

**小结** —— `os::init_2()` 是参数就绪后的 OS 深层初始化。它不做一件事，而在 10 个领域各做一点：时钟日志、快速线程时钟、信号体系（挂起/恢复/处理器注册）、栈尺寸校验、原始线程栈捕获、pthread/libc 信息、NUMA 库初始化、文件描述符上限、atexit 注册、线程优先级、coredump 过滤。完成后返回 `JNI_OK`。

---

## 2. `SafepointMechanism::initialize()` —— 全局安全点轮询页面

```cpp
/* === src/hotspot/share/runtime/safepointMechanism.cpp === */

void SafepointMechanism::initialize() {
  pd_initialize();
  initialize_serialize_page();
}
```

`pd_initialize()` 是平台相关初始化，在 `safepointMechanism.hpp:57` 声明：

```cpp
/* === src/hotspot/share/runtime/safepointMechanism.hpp === */

  static void pd_initialize() NOT_AIX({ default_initialize(); });
```

`NOT_AIX(...)` 是一个宏：在 AIX 平台上什么都不做，在其他平台（包括 Linux）执行 `default_initialize()`。看这个函数：

```cpp
/* === src/hotspot/share/runtime/safepointMechanism.cpp === */

void SafepointMechanism::default_initialize() {
  if (ThreadLocalHandshakes) {
    set_uses_thread_local_poll();

    // Poll bit values
    intptr_t poll_armed_value = poll_bit();
    intptr_t poll_disarmed_value = 0;

#ifdef USE_POLL_BIT_ONLY
    if (!USE_POLL_BIT_ONLY)
#endif
    {
      // Polling page
      const size_t page_size = os::vm_page_size();
      const size_t allocation_size = 2 * page_size;
      char* polling_page = os::reserve_memory(allocation_size, NULL, page_size);
      os::commit_memory_or_exit(polling_page, allocation_size, false, "Unable to commit Safepoint polling page");
      MemTracker::record_virtual_memory_type((address)polling_page, mtSafepoint);

      char* bad_page  = polling_page;
      char* good_page = polling_page + page_size;

      os::protect_memory(bad_page,  page_size, os::MEM_PROT_NONE);
      os::protect_memory(good_page, page_size, os::MEM_PROT_READ);

      log_info(os)("SafePoint Polling address, bad (protected) page:" INTPTR_FORMAT ", good (unprotected) page:" INTPTR_FORMAT, p2i(bad_page), p2i(good_page));
      os::set_polling_page((address)(bad_page));

      // Poll address values
      intptr_t bad_page_val  = reinterpret_cast<intptr_t>(bad_page),
               good_page_val = reinterpret_cast<intptr_t>(good_page);
      poll_armed_value    |= bad_page_val;
      poll_disarmed_value |= good_page_val;
    }

    _poll_armed_value    = reinterpret_cast<void*>(poll_armed_value);
    _poll_disarmed_value = reinterpret_cast<void*>(poll_disarmed_value);
  } else {
    const size_t page_size = os::vm_page_size();
    char* polling_page = os::reserve_memory(page_size, NULL, page_size);
    os::commit_memory_or_exit(polling_page, page_size, false, "Unable to commit Safepoint polling page");
    os::protect_memory(polling_page, page_size, os::MEM_PROT_READ);
    MemTracker::record_virtual_memory_type((address)polling_page, mtSafepoint);

    log_info(os)("SafePoint Polling address: " INTPTR_FORMAT, p2i(polling_page));
    os::set_polling_page((address)(polling_page));
  }
}
```

这个函数是 JVM 安全点机制的核心基础。JDK 11 引入了两种安全点轮询模式：

**`ThreadLocalHandshakes` 为 true（默认路径）**—— 每个线程有自己的安全点轮询位置（thread-local poll bit），同时保留全局轮询页面作为 fallback：

- `set_uses_thread_local_poll()` 设置 `_polling_type` 为 `_thread_local_poll`
- `poll_bit()` 返回一个用于线程本地轮询的 bit 模式
- 分配 2 个页面（bad_page + good_page），bad_page 设为 `MEM_PROT_NONE`（不可访问），good_page 设为 `MEM_PROT_READ`
- JVM 需要安全点时，将线程的轮询地址指向 bad_page；任何线程访问它都会触发 SIGSEGV，被 JVM 信号处理器拦截，进入安全点阻塞
- `poll_armed_value` 编码了 bad_page 地址 + poll_bit，`poll_disarmed_value` 编码了 good_page 地址

**`ThreadLocalHandshakes` 为 false** —— 只分配一个 `MEM_PROT_READ` 页面。通过修改页面的保护属性来控制安全点：需要安全点时将页面设为不可读。

`p2i()` 是 HotSpot 内部的指针到整数转换宏，`INTPTR_FORMAT` 是 `intptr_t` 的跨平台格式化宏。`os::vm_page_size()` 在本机 x86_64 Linux 上返回 4096（4KB）。

然后是 `initialize_serialize_page()`：

```cpp
/* === src/hotspot/share/runtime/safepointMechanism.cpp === */

void SafepointMechanism::initialize_serialize_page() {
  if (!UseMembar) {
    const size_t page_size = os::vm_page_size();
    char* serialize_page = os::reserve_memory(page_size, NULL, page_size);
    os::commit_memory_or_exit(serialize_page, page_size, false, "Unable to commit memory serialization page");
    log_info(os)("Memory Serialize Page address: " INTPTR_FORMAT, p2i(serialize_page));
    os::set_memory_serialize_page((address)(serialize_page));
  }
}
```

Memory Serialize Page 是一个用于内存屏障（memory barrier）的页面。当 JVM 需要确保在所有 CPU 上的内存写操作都完成时（比如 GC 之后），向这个页面写入一个值。`UseMembar` 默认 false，所以会分配这个页面。

**小结** —— `SafepointMechanism::initialize()` 为 JVM 的安全点机制分配内存页面：默认模式分配 2 页（1 保护 + 1 可读）+ 1 个序列化页，供后续 Stop-The-World GC 和线程握手使用。

---

## 3. `Arguments::adjust_after_os()` —— OS 就绪后最终调整

```cpp
/* === src/hotspot/share/runtime/arguments.cpp === */

jint Arguments::adjust_after_os() {
  if (UseNUMA) {
    if (!FLAG_IS_DEFAULT(AllocateHeapAt)) {
      FLAG_SET_ERGO(bool, UseNUMA, false);
    } else if (UseParallelGC || UseParallelOldGC) {
      if (FLAG_IS_DEFAULT(MinHeapDeltaBytes)) {
         FLAG_SET_DEFAULT(MinHeapDeltaBytes, 64*M);
      }
    }
    // UseNUMAInterleaving is set to ON for all collectors and
    // platforms when UseNUMA is set to ON. NUMA-aware collectors
    // such as the parallel collector for Linux and Solaris will
    // interleave old gen and survivor spaces on top of NUMA
    // allocation policy for the eden space.
    // Non NUMA-aware collectors such as CMS, G1 and Serial-GC on
    // all platforms and ParallelGC on Windows will interleave all
    // of the heap spaces across NUMA nodes.
    if (FLAG_IS_DEFAULT(UseNUMAInterleaving)) {
      FLAG_SET_ERGO(bool, UseNUMAInterleaving, true);
    }
  }
  return JNI_OK;
}
```

这个函数只做一件事：处理 NUMA 相关 flag 的最终调整。它必须在 `os::init_2()` 之后调用，因为 `os::init_2()` 可能已经把原本 `UseNUMA = true` 禁用了（NUMA 初始化失败）。

逻辑展开：

- `AllocateHeapAt`（`-XX:AllocateHeapAt=<path>`）指定了堆文件后，NUMA 没有意义（堆在文件上，不在内存节点上），关闭 NUMA。
- 如果使用 ParallelGC，将 `MinHeapDeltaBytes`（堆最小扩展粒度）设为 64MB。这是因为 NUMA 感知的并行 GC 以 lgrp（locality group）为单位扩展堆，粒度需要足够大。
- `UseNUMAInterleaving` 自动设为 true，让堆内存在所有 NUMA node 间交错分配。G1/CMS/Serial 在整个堆范围交错，ParallelGC 只对 old gen 和 survivor 做交错。

**小结** —— `Arguments::adjust_after_os()` 只有 22 行，检查 `UseNUMA` 并自动联动设置 `MinHeapDeltaBytes`（64MB）和 `UseNUMAInterleaving`（true）。

---

## 4. `ostream_init_log()` —— 日志输出流初始化

```cpp
/* === src/hotspot/share/utilities/ostream.cpp === */

void ostream_init_log() {
  // Note : this must be called AFTER ostream_init()

#if INCLUDE_CDS
  // For -XX:DumpLoadedClassList=<file> option
  if (DumpLoadedClassList != NULL) {
    const char* list_name = make_log_name(DumpLoadedClassList, NULL);
    classlist_file = new(ResourceObj::C_HEAP, mtInternal)
                         fileStream(list_name);
    FREE_C_HEAP_ARRAY(char, list_name);
  }
#endif

  // If we haven't lazily initialized the logfile yet, do it now,
  // to avoid the possibility of lazy initialization during a VM
  // crash, which can affect the stability of the fatal error handler.
  defaultStream::instance->has_log_file();
}
```

这个函数做两件事：

`INCLUDE_CDS` 分支（默认 true）—— 处理 `-XX:DumpLoadedClassList=<file>`。CDS（Class Data Sharing）是类数据共享机制，可以 dump 已加载类的列表用于后续创建共享归档。`fileStream(list_name)` 创建一个文件输出流，后续类加载信息写入此文件。

`defaultStream::instance->has_log_file()` —— `defaultStream` 是 `tty`（标准输出流）的内部实现。`has_log_file()` 触发日志文件的惰性初始化（lazy initialization）。注释说得清楚：在 VM 崩溃时做惰性初始化可能导致 fatal error handler 不稳定，所以在初始化阶段主动触发。

**小结** —— `ostream_init_log()` 在 OS 就绪后初始化日志文件流和 CDS 类列表文件，确保后续 VM 运行期间日志输出的稳定性。

---

## 5. `convert_vm_init_libraries_to_agents()` —— -Xrun 兼容转换

JDK 有两个原生的库加载机制：`-Xrun`（Java 1.x 时代）和 `-agentlib:/-agentpath:`（JVMTI 引入后）。`-Xrun` 库可以有 `JVM_OnLoad` 入口，也可以有 `Agent_OnLoad` 入口。这里的逻辑是：遍历所有 `-Xrun` 库，先找 `JVM_OnLoad`（有的话后面会单独调用），没有 `JVM_OnLoad` 但有 `Agent_OnLoad` 的，把库从 `-Xrun` 列表移到 agent 列表。

```cpp
/* === src/hotspot/share/runtime/thread.cpp === */

void Threads::convert_vm_init_libraries_to_agents() {
  AgentLibrary* agent;
  AgentLibrary* next;

  for (agent = Arguments::libraries(); agent != NULL; agent = next) {
    next = agent->next();  // cache the next agent now as this agent may get moved off this list
    OnLoadEntry_t on_load_entry = lookup_jvm_on_load(agent);

    // If there is an JVM_OnLoad function it will get called later,
    // otherwise see if there is an Agent_OnLoad
    if (on_load_entry == NULL) {
      on_load_entry = lookup_agent_on_load(agent);
      if (on_load_entry != NULL) {
        // switch it to the agent list -- so that Agent_OnLoad will be called,
        // JVM_OnLoad won't be attempted and Agent_OnUnload will
        Arguments::convert_library_to_agent(agent);
      } else {
        vm_exit_during_initialization("Could not find JVM_OnLoad or Agent_OnLoad function in the library", agent->name());
      }
    }
  }
}
```

`Arguments::libraries()` 返回 `-Xrun` 库链表。注意 `next = agent->next()` 必须在处理前缓存——因为 `convert_library_to_agent()` 会把当前 agent 从 library 链表移到 agent 链表，导致链断开。

`lookup_jvm_on_load()` 查找 `JVM_OnLoad` 符号：

```cpp
/* === src/hotspot/share/runtime/thread.cpp === */

static OnLoadEntry_t lookup_jvm_on_load(AgentLibrary* agent) {
  const char *on_load_symbols[] = JVM_ONLOAD_SYMBOLS;
  return lookup_on_load(agent, on_load_symbols, sizeof(on_load_symbols) / sizeof(char*));
}
```

`JVM_ONLOAD_SYMBOLS` 在 `jvm_md.h:42` 定义：

```cpp
/* === src/hotspot/os/posix/include/jvm_md.h === */

#define JVM_ONLOAD_SYMBOLS      {"JVM_OnLoad"}
#define AGENT_ONLOAD_SYMBOLS    {"Agent_OnLoad"}
```

`lookup_on_load()` 是公共的库加载和符号查找函数：

```cpp
/* === src/hotspot/share/runtime/thread.cpp === */

static OnLoadEntry_t lookup_on_load(AgentLibrary* agent,
                                    const char *on_load_symbols[],
                                    size_t num_symbol_entries) {
  OnLoadEntry_t on_load_entry = NULL;
  void *library = NULL;

  if (!agent->valid()) {
    char buffer[JVM_MAXPATHLEN];
    char ebuf[1024] = "";
    const char *name = agent->name();
    const char *msg = "Could not find agent library ";

    // First check to see if agent is statically linked into executable
    if (os::find_builtin_agent(agent, on_load_symbols, num_symbol_entries)) {
      library = agent->os_lib();
    } else if (agent->is_absolute_path()) {
      library = os::dll_load(name, ebuf, sizeof ebuf);
      if (library == NULL) {
        const char *sub_msg = " in absolute path, with error: ";
        size_t len = strlen(msg) + strlen(name) + strlen(sub_msg) + strlen(ebuf) + 1;
        char *buf = NEW_C_HEAP_ARRAY(char, len, mtThread);
        jio_snprintf(buf, len, "%s%s%s%s", msg, name, sub_msg, ebuf);
        vm_exit_during_initialization(buf, NULL);
        FREE_C_HEAP_ARRAY(char, buf);
      }
    } else {
      // Try to load the agent from the standard dll directory
      if (os::dll_locate_lib(buffer, sizeof(buffer), Arguments::get_dll_dir(),
                             name)) {
        library = os::dll_load(buffer, ebuf, sizeof ebuf);
      }
      if (library == NULL) {
        if (os::dll_build_name(buffer, sizeof(buffer), name)) {
          library = os::dll_load(buffer, ebuf, sizeof ebuf);
        }
        if (library == NULL) {
          const char *sub_msg = " on the library path, with error: ";
          const char *sub_msg2 = "\nModule java.instrument may be missing from runtime image.";

          size_t len = strlen(msg) + strlen(name) + strlen(sub_msg) +
                       strlen(ebuf) + strlen(sub_msg2) + 1;
          char *buf = NEW_C_HEAP_ARRAY(char, len, mtThread);
          if (!agent->is_instrument_lib()) {
            jio_snprintf(buf, len, "%s%s%s%s", msg, name, sub_msg, ebuf);
          } else {
            jio_snprintf(buf, len, "%s%s%s%s%s", msg, name, sub_msg, ebuf, sub_msg2);
          }
          vm_exit_during_initialization(buf, NULL);
          FREE_C_HEAP_ARRAY(char, buf);
        }
      }
    }
    agent->set_os_lib(library);
    agent->set_valid();
  }

  on_load_entry =
    CAST_TO_FN_PTR(OnLoadEntry_t, os::find_agent_function(agent,
                                                          false,
                                                          on_load_symbols,
                                                          num_symbol_entries));
  return on_load_entry;
}
```

加载 .so 的查找顺序：

1. 检查是否已内置链接（static link）—— `os::find_builtin_agent()` 使用 `dlsym(RTLD_DEFAULT, symbol)` 在主程序符号表中查找
2. 绝对路径 —— `os::dll_load()` 实际上调用 `dlopen(path, RTLD_LAZY)`
3. 标准 JVM dll 目录 —— `os::dll_locate_lib()` 在 `$JAVA_HOME/lib/` 下拼接 `lib<name>.so`
4. 系统库路径 —— `os::dll_build_name()` 拼接 `lib<name>.so`，然后用 `dlopen()` 让系统的 `LD_LIBRARY_PATH` 和 `/etc/ld.so.conf` 来解析

注意 `RTLD_LAZY`：符号解析延迟到第一次使用时。这和常规的 `RTLD_NOW` 不同，允许库先加载进来，符号找不到时推迟报错。

加载成功后用 `os::find_agent_function()` 查询 `Agent_OnLoad` / `JVM_OnLoad` 符号地址。

**小结** —— `convert_vm_init_libraries_to_agents()` 向后兼容旧版 `-Xrun` 库：没有 `JVM_OnLoad` 但有 `Agent_OnLoad` 的库自动转为 agent 处理。

---

## 6. `create_vm_init_agents()` —— 启动 agents

```cpp
/* === src/hotspot/share/runtime/thread.cpp === */

// Create agents for -agentlib:  -agentpath:  and converted -Xrun
// Invokes Agent_OnLoad
// Called very early -- before JavaThreads exist
void Threads::create_vm_init_agents() {
  extern struct JavaVM_ main_vm;
  AgentLibrary* agent;

  JvmtiExport::enter_onload_phase();

  for (agent = Arguments::agents(); agent != NULL; agent = agent->next()) {
    OnLoadEntry_t  on_load_entry = lookup_agent_on_load(agent);

    if (on_load_entry != NULL) {
      // Invoke the Agent_OnLoad function
      jint err = (*on_load_entry)(&main_vm, agent->options(), NULL);
      if (err != JNI_OK) {
        vm_exit_during_initialization("agent library failed to init", agent->name());
      }
    } else {
      vm_exit_during_initialization("Could not find Agent_OnLoad function in the agent library", agent->name());
    }
  }
  JvmtiExport::enter_primordial_phase();
}
```

`Arguments::agents()` 返回的链表包含三类来源：命令行 `-agentlib:<name>=<options>`、`-agentpath:<path>=<options>`、以及上面 `convert_vm_init_libraries_to_agents()` 转换过来的 `-Xrun` 库。

每个 agent 的 `Agent_OnLoad(JavaVM *vm, char *options, void *reserved)` 被调用。`&main_vm` 是全局 `JavaVM_` 结构体，即 JNI 调用接口——agent 通过它注册 capabilities、设置回调。`agent->options()` 是 `=` 后面的参数字符串。

`enter_onload_phase()` 和 `enter_primordial_phase()` 控制 JVMTI 的生命周期阶段（phase），确保 agent 在正确的阶段调用特定 JVMTI 函数。

**小结** —— `create_vm_init_agents()` 遍历所有 agent，调用 `Agent_OnLoad()` 启动。agent 可能是用户显式指定的 `-agentlib`/`-agentpath`，也可能是从 `-Xrun` 转换来的。这一步完成后，JVMTI agent 进入 primordial 阶段。

---

## Stage 3 总结

Stage 3 是 OS 参数就绪后的初始化，7 个步骤构建了 JVM 在 OS 之上的最后一层基础：

1. **`os::init_2()`** —— 10 项 OS 深层初始化：信号体系注册（SIGSEGV 处理器、挂起/恢复机制）、NUMA 库加载、文件描述符上限、atexit 回调、线程优先级
2. **`SafepointMechanism::initialize()`** —— 分配安全点轮询页面（2 页：保护页 + 可读页）+ 内存序列化页
3. **`Arguments::adjust_after_os()`** —— NUMA 相关 flag 最终联动（MinHeapDeltaBytes=64M, UseNUMAInterleaving=true）
4. **`ostream_init_log()`** —— 日志文件流初始化、CDS 类列表文件创建
5. **`convert_vm_init_libraries_to_agents()`** —— `-Xrun` 向后兼容转换
6. **`create_vm_init_agents()`** —— 调用所有 agent 的 `Agent_OnLoad`

至此 OS 层面完全就绪。下一个阶段 `vm_init_globals()` 将进入 JVM 内部——初始化全局数据结构、加载系统类。
