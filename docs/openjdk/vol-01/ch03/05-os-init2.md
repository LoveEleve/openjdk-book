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

开头 `HOTSPOT_VM_INIT_BEGIN()` 是 JVMTI（Java Virtual Machine Tool Interface，JVM 对外提供的 native 工具接口）的 VM 初始化事件回调点——调试器（jdb）、性能分析工具（async-profiler）等通过 JVMTI 注册回调来监控 JVM 的生命周期事件。`CAN_SHOW_REGISTERS_ON_ASSERT` 分支是调试功能，跳过不讲。

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

声明在 `os.hpp:173`，Linux 实现在 `os_linux.cpp:5588-5717`。和 Stage 1 的 `os::init()` 对比：

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
| `Linux::_libc_version` | const char* | `Linux::libc_version()` | **"glibc 2.38"**（本机 ldd 输出） |
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

- **`SR_initialize()`** —— 初始化线程挂起/恢复机制。GC 的 Stop-The-World 需要暂停所有 Java 线程，底层用信号实现。初始化失败直接 `return JNI_ERR`。

- **`install_signal_handlers()`** —— 向 Linux 内核注册 JVM 自定义的信号处理器。SIGSEGV 被注册为 `JVM_handle_linux_signal`。

这行注册的处理器是整个 JVM 信号体系统一的入口。它要处理三种 SIGSEGV：

1. **空指针访问** —— 隐式 null check，Java 代码中不执行 `if (o == null)`，直接用过 `o` 的地址 + offset 来读写。如果 `o` 是 null 地址 + offset 落入不可读取的页，触发 SIGSEGV。信号处理器的处理：直接从信号 handler 里往外抛 NullPointerException。

2. **栈溢出** —— Stage 2 的 `init_before_ergo` 设置了四个区域的尺寸。`create_stack_guard_pages` 调用 `mprotect(PROT_NONE)` 把栈底 16KB 变成保护页。一旦方法的调用太深，栈指针触及保护页，触发 SIGSEGV。处理器识别出是 `stack_overflow` 后抛出 StackOverflowError。

3. **安全点轮询** —— 本章接下来 `SafepointMechanism::initialize()` 会分配 `bad_page`（即将用 `mprotect` 保护）。线程如果触发了 bad_page 的 SIGSEGV，信号处理器识别出后把线程挂起，等待 GC 等全局操作完成。

同一个信号（SIGSEGV），同一个处理器入口（`JVM_handle_linux_signal`），根据哪个地址触发了来区分语义。本质上就是：CPU 发现了被保护的页，通知内核；内核把信号派发给 JVM；JVM 判断是什么操作碰到的，执行不同类型的分支。

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
