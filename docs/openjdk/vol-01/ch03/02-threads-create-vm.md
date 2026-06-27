# 3.2 Threads::create_vm 总览

`Threads::create_vm` 在 `/data/workspace/jdk11u-copy/src/hotspot/share/runtime/thread.cpp`，是 HotSpot 初始化的心脏函数。

本节只粗略看全貌——把 9 个阶段过一遍，知道每个阶段做了什么、各阶段之间的先后关系。不会深入到 `os::init`、`Arguments::parse`、`init_globals` 等函数内部，那些在后续章节逐一展开。

---
## 9 阶段骨架

`Threads::create_vm` 的 390 行可以归为 9 个逻辑阶段。以下骨架展示了每一阶段的关键调用和它们在函数内部的先后关系：

```
Threads::create_vm(JavaVMInitArgs* args, bool* canTryAgain)
│
├── [阶段 1] 前置初始化
│   ├── VM_Version::early_initialize()
│   ├── is_supported_jni_version(args->version)
│   ├── ThreadLocalStorage::init()
│   ├── ostream_init()
│   ├── Arguments::process_sun_java_launcher_properties(args)
│   ├── os::init()
│   └── create_vm_timer.start()          — 计时起点
│
├── [阶段 2] 参数解析与系统属性
│   ├── Arguments::init_system_properties()
│   ├── JDK_Version_init()
│   ├── Arguments::init_version_specific_system_properties()
│   ├── LogConfiguration::initialize()
│   ├── Arguments::parse(args)            — 核心：解析 -cp, -Xms, -XX:+ 等
│   ├── os::init_before_ergo()
│   ├── Arguments::apply_ergo()           — 核心：自动调优堆大小等
│   └── JVMFlag 范围/约束校验
│
├── [阶段 3] os::init_2 与安全点
│   ├── os::init_2()                      — 核心：信号处理器、线程栈等 OS 资源
│   ├── SafepointMechanism::initialize()
│   └── Arguments::adjust_after_os()
│
├── [阶段 4] Agent 与全局初始化
│   ├── ostream_init_log()
│   ├── convert/init -agentlib/-Xrun agents
│   └── vm_init_globals()                 — 核心：初始化全局数据结构
│
├── [阶段 5] 主线程附着
│   ├── new JavaThread()                  — 核心：把当前 OS 线程包装为 JavaThread
│   ├── initialize_thread_current()
│   ├── record_stack_base_and_size()
│   ├── set_active_handles()
│   ├── set_as_starting_thread()
│   └── create_stack_guard_pages()
│
├── [阶段 6] 全局模块与 VMThread
│   ├── ObjectMonitor::Initialize()
│   ├── init_globals()                    — 核心：初始化 Universe/Heap/SystemDictionary 等
│   ├── Threads::add(main_thread)
│   └── VMThread::create() + wait ready
│
├── [阶段 7] Java 类引导
│   ├── initialize_java_lang_classes()    — 核心：加载 java.lang.Object/String/Class 等
│   ├── quicken_jni_functions()
│   └── set_init_completed()
│
├── [阶段 8] 编译器与运行时服务
│   ├── os::initialize_jdk_signal_support()
│   ├── AttachListener init
│   ├── ServiceThread::initialize()
│   └── CompileBroker::compilation_init   — 核心：C1/C2 编译器初始化
│
└── [阶段 9] Java 世界诞生
    ├── call_initPhase2()                 — 核心：加载 java.base 模块
    ├── call_initPhase3()                 — 核心：安全管理器、系统类加载器
    ├── WatcherThread start
    ├── create_vm_timer.end()             — 计时终点
    └── return JNI_OK
```

9 个阶段不是平级的——阶段 1-3 是"纯 C++ 初始化"（还没进入 Java 世界），阶段 4-6 是"JavaThread 诞生与核心数据结构建立"，阶段 7-9 是"Java 类加载与模块系统初始化"。`init_globals`（阶段 6）和 `initialize_java_lang_classes`（阶段 7）是整个 Volume 1 的核心，会在第 4 章和第 5 章单独展开。

---

## 函数签名
函数签名接收两个参数：

| 参数 | 方向 | 类型 | 含义 |
|------|------|------|------|
| `args` | 输入 | `JavaVMInitArgs*` | 从 `InitializeJVM` 传下来的启动参数，包含 `nOptions` 和 `options` 数组 |
| `canTryAgain` | 输出 | `bool*` | 如果初始化失败但有重试可能则为 `true`，否则 `false` |

返回值 `JNI_OK`（`0`）表示创建成功，非零表示失败。这两个参数是从 `JNI_CreateJavaVM_inner` 直接透传下来的：

```c
// jni.cpp:4007
bool can_try_again = true;
result = Threads::create_vm((JavaVMInitArgs*) args, &can_try_again);
```

`args` 就是 `InitializeJVM` 里填好的参数（`-cp`、类名、`-version` 等），`can_try_again` 是 `JNI_CreateJavaVM_inner` 栈上的局部变量。到这行之前，启动参数已经被 Launcher 的 `CreateExecutionEnvironment` + `LoadJavaVM` + `InitializeJVM` 三个函数转手了三次，现在是第四次——终于进入 JVM 内部。

以 HelloWorld 程序为例，`args->nOptions` = 1，`args->options[0].optionString` = `"-Djava.class.path=/data/workspace"`。这些值会在阶段 2 被 `Arguments::parse` 解析。

---
## create_vm 计时器

计时从阶段 1 末尾开始。这行代码出现在 `os::init()` 之后：

```c
TraceVmCreationTime create_vm_timer;
create_vm_timer.start();
```

`create_vm_timer` 是栈上对象，类型是 `TraceVmCreationTime`。看它的实现（`management.hpp`）：

```c
class TraceVmCreationTime : public StackObj {
private:
  TimeStamp _timer;
  jlong     _begin_time;
public:
  void start()
  { _timer.update_to(0); _begin_time = os::javaTimeMillis(); }

  jlong begin_time() const { return _begin_time; }

  void end()
  { Management::record_vm_startup_time(_begin_time, _timer.milliseconds()); }
};
```

`start()` 做了两件事：
- `_timer.update_to(0)`：把内部的 `TimeStamp` 计数器设为起点（`_counter = 0`）。之后任何时候调用 `milliseconds()`，返回的就是从这次 `update_to(0)` 至今经过的毫秒数。约等于按了一下秒表的归零按钮
- `_begin_time = os::javaTimeMillis()` —— 记录系统时间戳。这个值会被 `LogConfiguration::initialize(create_vm_timer.begin_time())` 在阶段 2 开头取走，用于配置日志框架的基准时间

`StackObj` 是 HotSpot 的基类——标记这个对象只能在栈上分配，不能用 `new` 创建到堆。

接着看 `TimeStamp` 的完整实现（`timer.hpp` + `timer.cpp`）：

```c
// timer.hpp — 类定义
class TimeStamp {
private:
  jlong _counter;
public:
  TimeStamp()  { _counter = 0; }
  void clear() { _counter = 0; }
  bool is_updated() const { return _counter != 0; }
};

// timer.cpp — 方法实现
void TimeStamp::update_to(jlong ticks) {
  _counter = ticks;
  if (_counter == 0)  _counter = 1;     // 0 保留给"未启动"状态
}

void TimeStamp::update() {
  update_to(os::elapsed_counter());     // 记录当前 tick 数
}

jlong TimeStamp::milliseconds() const {
  jlong new_count = os::elapsed_counter();   // 读取当前的 tick 数
  return (jlong)TimeHelper::counter_to_millis(new_count - _counter);
}
```

`_counter` 存的是一个"tick 数"——CPU 时间戳计数器的值（x86 上来自 `rdtsc` 指令），不是毫秒。

`update_to(0)` 把 `_counter` 设为 1（不是 0），因为 `_counter == 0` 被 `is_updated()` 用来判断"计时器还没启动"。`start()` 调用它之后，`is_updated()` 返回 `true`。

`milliseconds()` 被调用时：读当前 tick 数（`os::elapsed_counter()`），减去 `_counter` 存的起点 tick 数，差值通过 `TimeHelper::counter_to_millis` 除以 CPU 频率得到毫秒数。

计时器的底层原理就是记录两个时刻的 tick 数，差值转时间。`os::elapsed_counter()` 是 `rdtsc`，`os::elapsed_frequency()` 是 CPU 频率（tick/秒），`counter_to_millis` 用这两个值做换算。

### TraceTime —— 第二个计时器

`Threads::create_vm` 内部不止 `create_vm_timer`。阶段 3 开头还有另一个 RAII 计时器：

```c
TraceTime timer("Create VM", TRACETIME_LOG(Info, startuptime));
```

这行代码构造了一个 `TraceTime` 对象，构造时自动开始计时。变量 `timer` 是栈上对象，当 `Threads::create_vm` 执行到它所在作用域的末尾（`HOTSPOT_VM_INIT_END` 附近）时，`timer` 析构——析构函数停止计时并输出耗时日志。

先看类的定义（`timerTrace.hpp`）：

```c
class TraceTime : public StackObj {
private:
  bool          _active;     // 是否实际计时
  bool          _verbose;    // 析构时是否输出
  elapsedTimer  _t;          // 内部计时器
  const char*   _title;      // 计时器名称（输出到日志）
  TraceTimerLogPrintFunc _print;  // 日志输出函数指针
};
```

`StackObj` 和 `create_vm_timer` 一样——只能在栈上分配。`_print` 是一个函数指针，如果非 NULL，析构时通过它输出日志；如果 NULL，输出到 `tty`。

再看构造函数（`timerTrace.cpp`）。`TraceTime` 有三个重载，这里用的是第三个：

```c
TraceTime::TraceTime(const char* title, TraceTimerLogPrintFunc ttlpf) {
  _active   = ttlpf != NULL;      // 如果日志开启则激活
  _verbose  = true;
  _title    = title;
  _print    = ttlpf;
  if (_active) {
    _accum = NULL;
    _t.start();                    // 开始计时——记录起点 tick 数
  }
}
```

`TRACETIME_LOG(Info, startuptime)` 是一个宏，展开后判断日志级别是否开启：

```c
log_is_enabled(Info, startuptime)
  ? &LogImpl<startuptime>::write<Info>   // 开了：返回日志函数指针
  : NULL                                   // 没开：返回 NULL
```

如果 `-Xlog:startuptime=info` 没开，`_active` 为 `false`，构造函数什么也不做，析构函数也直接返回。开了才计时。

`_t.start()` 内部调用 `elapsedTimer::start()`（`timer.cpp`）：

```c
void elapsedTimer::start() {
  if (!_active) {
    _active = true;
    _start_counter = os::elapsed_counter();  // 记录起点 tick 数
  }
}
```

和 `TimeStamp` 一样，底层也是 `os::elapsed_counter()`（`rdtsc`）拿到当前 tick 数存入 `_start_counter`。

析构函数（`timerTrace.cpp`）：

```c
TraceTime::~TraceTime() {
  if (!_active) return;
  _t.stop();                                // 停止计时，累加耗时
  if (_print) {
    _print("%s, %3.7f secs", _title, _t.seconds());  // 走日志框架输出
  }
}
```

`_t.stop()` 内部：

```c
void elapsedTimer::stop() {
  if (_active) {
    _counter += os::elapsed_counter() - _start_counter;  // 累加 tick 差
    _active = false;
  }
}
```

当前 tick 减去起点 tick，差值累加到 `_counter`。`_t.seconds()` 把 tick 差转为秒数。

最后 `_print(...)` 输出日志。在本机上用 `-Xlog:startuptime=info` 跑 `java -version` 的实际输出：

```
[0.561s][info][startuptime] Create VM, 0.5601185 secs
```

`"Create VM"` 是构造时传的 `_title`，`0.5601185` 是 `_t.seconds()` 的值——阶段 3-7（从 `os::init_2` 到 `set_init_completed`）的耗时。本机 debug build（slowdebug），release build 通常在 50ms 以内。

所以整个计时布局是：

```
create_vm_timer.start()                   — 全函数计时开始
  阶段 2 ~ 阶段 3 开头 ...
  TraceTime timer("Create VM")            — 核心段计时开始（RAII 构造）
    阶段 3 ~ 阶段 7 ...
    HOTSPOT_VM_INIT_END()
    timer 析构，输出 -Xlog 日志           — 核心段计时结束
  阶段 8 ~ 阶段 9 ...
create_vm_timer.end()                     — 全函数计时结束
```

两个计时器的数据流向不同——`create_vm_timer` 把结果写入 PerfData（生产环境 `jstat`/JMX 可读），`TraceTime` 输出到 `-Xlog` 日志（开发诊断用）。

PerfData 是 HotSpot 内部的一块共享内存区域，JVM 运行时的各种计数器（GC 次数、堆使用量、线程数、启动耗时等）都写在这里，外部工具通过 `/tmp/hsperfdata_<user>/<pid>` 文件读取。`jstat -gc`、`jstat -class`、JMX 监控都依赖它。这部分会在后续章节专门展开。

---
## 9 阶段速览

### 阶段 1：前置初始化

在开始任何实质性初始化之前，先完成几项不依赖其他子系统的基础工作：

- `VM_Version::early_initialize()` —— 提前初始化 CPU 特性检测（SIMD 指令集、cache 行大小等），因为后续很多模块依赖这些信息做平台优化
- `is_supported_jni_version(args->version)` —— 校验 JNI 版本号，不支持则直接返回 `JNI_EVERSION`
- `ThreadLocalStorage::init()` —— 初始化线程局部存储（`pthread_key_create`），HotSpot 用它实现 `Thread::current()` 的快速查找
- `ostream_init()` —— 初始化输出流模块，让 `tty`（`gclog_or_tty`）等日志通道可用
- `Arguments::process_sun_java_launcher_properties(args)` —— 处理 Launcher 传来的 Java 属性（如 `sun.java.launcher`）
- `os::init()` —— 操作系统抽象层的第一次初始化，包括页大小检测、`/proc` 信息收集等

**总结**：阶段 1 建立了后续所有工作依赖的最底层基础设施——CPU 特性、TLS、日志输出、OS 抽象。以 HelloWorld 为例，这些步骤全部成功执行，没有错误返回。

### 阶段 2：参数解析与系统属性

这是参数处理的集中阶段。Launcher 组装好的 `JavaVMInitArgs` 在这里被完整解析：

- `Arguments::init_system_properties()` —— 初始化系统属性（`java.home`, `java.class.path`, `user.dir` 等）
- `JDK_Version_init()` —— 初始化 JDK 版本号，后续参数解析用它作为版本判别的条件
- `Arguments::init_version_specific_system_properties()` —— 根据 JDK 版本补充特定属性
- `LogConfiguration::initialize()` —— 初始化统一日志框架，必须在参数解析之前完成，因为 `-Xlog` 参数需要日志系统已就绪
- `Arguments::parse(args)` —— 核心：解析 `JavaVMInitArgs`。`-Dxxx=yyy` 设系统属性，`-cp` 设 classpath，`-Xms/-Xmx` 设堆大小，`-XX:+/-` 设 VM flag
- `os::init_before_ergo()` —— OS 层在自动调优前需要完成的初始化
- `Arguments::apply_ergo()` —— 核心：根据机器硬件（CPU 核数、内存大小）自动计算未显式设置的 VM 参数。例如你不指定 `-Xms`，ergo 会根据系统内存算一个默认值
- 范围检查 (`check_ranges`) 和约束检查 (`check_constraints`) —— 验证所有 VM flag 的值在合法范围内、AfterErgo 约束满足

`HOTSPOT_VM_INIT_BEGIN()` 是一个宏，在 JFR 启用时记录 VM 初始化开始事件。JFR 禁用时展开为空。

**总结**：阶段 2 完成了所有命令行和系统属性的解析，自动调优了未指定的 VM 参数。`args->nOptions`（HelloWorld 中是 1）被遍历解析，`-Djava.class.path` 写入系统属性表。

### 阶段 3：os::init_2 与安全点

参数解析完成后，OS 层进行第二轮更深入的初始化：

- `os::init_2()` —— 核心：建立信号处理器（`SIGSEGV`、`SIGBUS` 等用于空指针检查和栈溢出检测），初始化线程栈大小，建立 NUMA 感知等。这是 OS 层最关键的初始化步骤
- `SafepointMechanism::initialize()` —— 初始化安全点机制。安全点是 GC 和去优化等 VM 操作同步所有 Java 线程的机制
- `Arguments::adjust_after_os()` —— OS 初始化完成后，部分参数可能需要根据 OS 实际能力调整

`#ifdef CAN_SHOW_REGISTERS_ON_ASSERT` 分支在标准 Linux x86_64 构建中启用，但只有启动参数包含 `ShowRegistersOnAssert` 时才执行 `initialize_assert_poison()`（初始化断言毒化页——一种调试特性，非生产路径）。标准 HelloWorld 运行时这个分支不执行。

**总结**：阶段 3 完成了信号处理器和安全点机制等 OS 级关键基础设施的初始化。`os::init_2()` 是本章 3.5 节的专题。

### 阶段 4：Agent 与全局初始化

`os::init_2` 之后是 agent 加载和全局数据结构的建立：

- `ostream_init_log()` —— 补全日志输出流的初始化（统一日志框架已在阶段 2 初始化，这里处理输出目标）
- `convert_vm_init_libraries_to_agents()` —— 把 `-Xrun` 参数转换为 `-agentlib` 格式（向后兼容 JDK 1.2 的调试接口）
- `create_vm_init_agents()` —— 加载并调用 agent 的 `Agent_OnLoad` 入口函数
- `vm_init_globals()` —— 核心：初始化全局数据结构，包括 JNI 句柄块、同步原语、SystemDictionary 等。这是 HotSpot 内部"注册表"的建立阶段

标准 HelloWorld 运行时没有 `-agentlib` 参数，所以 agent 相关分支不执行。`vm_init_globals()` 是主要的实际工作。

**总结**：阶段 4 加载了 agent（如果有），建立了全局数据结构。`vm_init_globals()` 是后续 `init_globals()` 的铺垫。

### 阶段 5：主线程附着

这是整个 `Threads::create_vm` 中标志性的一步——把当前 OS 线程包装成 HotSpot 的第一个 `JavaThread`：

```c
JavaThread* main_thread = new JavaThread();
main_thread->set_thread_state(_thread_in_vm);
main_thread->initialize_thread_current();
```

`new JavaThread()` 在 C++ 堆上创建 `JavaThread` 对象。`initialize_thread_current()` 把这个 C++ 对象和当前 OS 线程绑定——从此 `Thread::current()` 可以返回这个 `JavaThread*`。`record_stack_base_and_size()` 记录 OS 线程的栈底和大小（用于栈溢出检测）。

后续的 `set_active_handles()` 分配第一个 JNI 局部引用块，`set_as_starting_thread()` 完成最终绑定，`create_stack_guard_pages()` 建立栈守卫页。

注释解释为什么栈守卫页要放在这些操作之后：如果在 `os::create_main_thread()` 之前设置，会崩溃 Linux VM（参见 `os_linux.cpp` 注释）。

**总结**：阶段 5 把执行 `JavaMain` → `InitializeJVM` → `JNI_CreateJavaVM` 的 OS 线程包装成了 HotSpot 的第一个 `JavaThread`。这是 HotSpot 内部视角的"主线程"诞生时刻。

### 阶段 6：全局模块与 VMThread

主线程就绪后，初始化 Java 层的同步子系统、堆、方法区等核心模块，并启动 VMThread：

- `ObjectMonitor::Initialize()` —— 初始化 Java 层的 synchronized 锁实现（ObjectMonitor 缓存池）
- `init_globals()` —— 核心：初始化 Universe（包含 `java.lang.Object` 等核心类的 Klass 镜像）、堆（CollectedHeap）、SystemDictionary、符号表、StringTable 等。这是 Volume 1 第五章的专题
- `cache_global_variables()` —— 主线程缓存全局变量的引用，避免每次从 JNI 句柄查找
- `Threads::add(main_thread)` —— 把新创建的 `JavaThread` 加入全局线程列表
- `VMThread::create()` —— 创建 VMThread（VM 操作调度线程，处理 GC、去优化等需要在安全点执行的全局操作），然后阻塞等待它就绪

VMThread 的创建和等待是一个经典的 OS 线程创建模式：创建线程 → `os::start_thread()` 启动 → 循环等待 `active_handles() != NULL` 确认线程初始化完毕。

**总结**：阶段 6 建立了 Java 层的运行基础——ObjectMonitor、堆、SystemDictionary，并启动了 VM 操作调度线程。

### 阶段 7：Java 类引导

堆和方法区就绪后，加载 Java 语言最基础的类——这些类不是用 Java 源码编译的，而是用 C++ 代码直接创建的 Klass 对象：

- `initialize_java_lang_classes(main_thread, CHECK_JNI_ERR)` —— 核心：加载 `java.lang.Object`、`java.lang.String`、`java.lang.Class`、`java.lang.System`、`java.lang.Thread`、`java.lang.ThreadGroup` 等基础类
- `quicken_jni_functions()` —— 优化 JNI 函数表：把解析过的 JNI 函数指针直接写入表格，后续调用不再走查找路径
- `StubCodeDesc::freeze()` —— 冻结 Stub 代码生成——此后不允许再生成新的 Stub
- `set_init_completed()` —— 设置初始化完成标志，异常处理等依赖这个标志
- `LogConfiguration::post_initialize()` 和 `Metaspace::post_initialize()` —— 日志和 Metaspace 在类加载完成后的收尾初始化

**总结**：阶段 7 加载了 Java 程序的根基类。这之后 Java 代码才能在 JVM 上执行。`initialize_java_lang_classes` 内部会加载约 100 个基础 Klass，是 Volume 1 的核心主题之一。

### 阶段 8：编译器与运行时服务

Java 基础类就绪后，启动编译器和各种后台服务线程：

- `os::initialize_jdk_signal_support()` —— 启动 Signal Dispatcher 线程，处理操作系统信号
- `AttachListener` —— 启动 Attach 监听器（如果不是 `DisableAttachMechanism`），支持 `jcmd`、`jstack` 等工具的连接
- `ServiceThread::initialize()` —— 启动服务线程，处理 JVMTI 延迟事件和哈希表清理
- `CompileBroker::compilation_init_phase1()` —— 第一阶段：初始化 C1/C2 编译线程。phase2 在 JVMCI 初始化后调用（如果使用 Graal 编译器），标准 C2 编译器则在 JVMCI 分支不执行时立即调用 phase2

**总结**：阶段 8 启动了 VM 的后台服务线程——信号分发、Attach 监听器、服务线程、JIT 编译线程。这些线程在 Java 代码执行期间持续工作。

### 阶段 9：Java 世界诞生

最后一个阶段从 C++ 世界跨入 Java 世界——加载模块系统、系统类加载器，完成 VM 初始化的最后步骤：

- `initialize_jsr292_core_classes()` —— 预初始化 `java.lang.invoke` 核心类，避免类加载死锁
- `call_initPhase2(CHECK_JNI_ERR)` —— 初始化模块系统，加载 `java.base` 模块。phase2 之后只允许加载 `java.base` 的类
- `call_initPhase3(CHECK_JNI_ERR)` —— 初始化安全管理系统和系统类加载器。phase3 之后所有模块的类都可以加载
- `SystemDictionary::compute_java_loaders(CHECK_JNI_ERR)` —— 缓存系统和平台类加载器
- `JvmtiExport::enter_live_phase()` —— JVMTI 进入 Live 阶段（JVM 完全就绪）
- `WatcherThread::start()` —— 启动 WatcherThread（周期任务调度线程）
- `create_vm_timer.end()` —— 停止计时，把启动耗时写入 PerfData

最后的 `DumpSharedSpaces` 分支处理 CDS（Class Data Sharing）归档生成——普通启动这条路径不走。

**总结**：阶段 9 加载了 Java 模块系统、安全管理器、系统类加载器，切换到 JVMTI Live 阶段，启动 WatcherThread。`Threads::create_vm` 返回 `JNI_OK` 的那一刻，Java 虚拟机完全就绪。

---
## 本章覆盖范围

本章（3.3-3.5）覆盖阶段 1-3——HotSpot 初始化最前面的三个步骤：

| 章节 | 阶段 | 核心函数 | 行数范围 |
|------|------|----------|----------|
| 3.3 前置初始化 | 阶段 1 | `VM_Version::early_initialize`, `os::init` | 3702-3726 |
| 3.4 参数解析 | 阶段 2 | `Arguments::parse`, `Arguments::apply_ergo` | 3728-3768 |
| 3.5 os::init_2 | 阶段 3 | `os::init_2` | 3770-3786 |

阶段 4-9 在后续章节中覆盖：

| 章节 | 阶段 | 核心函数 | 说明 |
|------|------|----------|------|
| 第 4 章 | 阶段 5-6 | `new JavaThread`, `init_globals` | JavaThread 创建、堆初始化、VMThread 启动 |
| 第 5 章 | 阶段 7 | `initialize_java_lang_classes` | Java 基础类加载、Klass 模型 |
| 第 6 章 | 阶段 8-9 | 编译器、模块系统 | C1/C2 初始化、模块系统、系统类加载器 |

---
## 小结

`Threads::create_vm` 把 HotSpot 从一个静态的 C++ 函数调用变成运行中的 Java 虚拟机。390 行源码按执行顺序分为 9 个阶段：

- 阶段 1-3：OS 和参数层面的初始化——CPU 特性、TLS、参数解析、信号处理器、安全点
- 阶段 4-6：JVM 内部结构的建立——全局数据结构、线程对象、堆、方法区、VMThread
- 阶段 7-9：Java 世界的加载——基础类、模块系统、类加载器、编译器、后台服务

`create_vm_timer` 在阶段 1 尾部 `start()`，在阶段 9 结尾 `end()`——计时起止跨越整个函数。本机 HelloWorld 启动中这个计时器的实际值约为 200-300ms（debug build），release build 通常 < 50ms。

调用链更新：

```
main() → JLI_Launch() → JavaMain() → InitializeJVM()
       → ifn->CreateJavaVM() → JNI_CreateJavaVM()
       → JNI_CreateJavaVM_inner() → Threads::create_vm()
```

下一个节（3.3）进入阶段 1 的内部——从 `VM_Version::early_initialize` 开始，逐步展开 `Threads::create_vm` 的前置初始化过程。
