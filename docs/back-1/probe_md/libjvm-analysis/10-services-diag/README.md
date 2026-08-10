# 10 — 服务与诊断（Services & Diagnostics）

> 源码索引：`source_index/10-services.md`（56文件，30 .hpp + 26 .cpp）
> 插桩覆盖：`-Xlog:probe_runtime=debug`（6cpp）
> **前置阶段**：[09-native-interface], [08-safepoint], [07-thread-lock]
> **阅读收益**：理解 jcmd/jstack/jmap 的套接字全链路、40+ 诊断命令的注册/调度机制、MemoryPool/GCMemoryManager 的 JMX MXBean 桥接、hs_err 崩溃日志的信号安全输出

---

## 一、阶段定位 — Attach 是 JVM 的"外部诊断管道"

本阶段的独特价值在于：

1. **和 09 阶段形成"内/外"对称**：09 的 JNI 是 JVM 的内部接口（native 方法从 Java 调用 C++），而本阶段的 Attach 是 JVM 的外部接口（外部工具突破进程边界向 JVM 发送命令）。两条管道在 `attach_listener_thread_entry()` 汇合——来自外部的 `jcmd` 请求进入 DCmd 框架，和来自 JNI 的 JVM_* 入口形成对照。

2. **MemoryService/JMX 是 GC 子系统对外的"数据面"**：GC 产生内存事件（回收、低内存预警），MemoryService 把这些事件转成 JMX 通知并更新 MXBean 计数器。读者刚学完 06/08 的 GC 机制，现在看它们怎么被"暴露"出去。

3. **VMError 是"最后一公里"的紧急出口**：安全点、JNI、锁——所有子系统都可能触发 fatal error。VMError 的 `report_and_die()` 在信号上下文中只用 `write()` 输出，是对 08-safepoint 信号安全思想的极端实践。

### ★ 和 09 阶段的本质区别：向外开口

09 阶段的核心文件在 `prims/`，通过 `runtime/` 的 `interfaceSupport` 和 `safepoint.cpp` 桥接。**本阶段的核心文件在 `services/`，但致命依赖 `os/`（套接字）、`utilities/`（VMError）、`gc/shared/`（MemoryPool 的 GC 端），跨模块更硬**：

```
services/ (attachListener, diagnosticCommand, memoryService, threadService...)
  ├── 调用 ──→ os/linux/    (LinuxAttachListener — Unix 域套接字)
  ├── 调用 ──→ runtime/     (thread.cpp — AttachListener 启动；globals.hpp — StartAttachListener 标志)
  ├── 调用 ──→ utilities/   (vmError — 崩溃日志；decoder — native 栈解码)
  ├── 引用 ──→ gc/shared/   (collectedHeap — 声明 memory_managers/pools 虚函数)
  └── 引用 ──→ prims/       (jvmtiEnv.cpp — JVMTI agent 加载入口共享 Attach)
```

这意味着：
- 每篇文档需标注文件所属模块，关键函数需给出跨模块行号
- 01 (Attach) 的 GDB 验证需要跨模块断点（`services/` → `os/linux/` 两个 `dequeue()`）
- 04 (hs_err) 必须在信号上下文约束下理解，不能用普通调试思路

---

## 二、文档计划（4篇，带依赖链）

```
                         ┌── 前置依赖 ──┐
                         │  09-native    │
                         │  08-safepoint │
                         │  07-thread    │
                         └──────┬───────┘
                                │
               ┌────────────────┼────────────────┐
               ▼                ▼                ▼
      ┌────────────────┐ ┌──────────────┐ ┌──────────────┐
      │  01-Attach     │ │ 02-DCmd      │ │ 03-Memory    │
      │   机制         │ │  诊断命令     │ │  Service     │
      └───────┬────────┘ └──────┬───────┘ └──────┬───────┘
              │                 │                │
              ▼                 ▼                ▼
      ┌────────────────┐                                   
      │ 04-hs_err      │←── 依赖 01（VMError 内测 Attach
      │  崩溃日志       │    是否 active，检查 socket 存活）
      └────────────────┘    
```

### 写作顺序（按依赖链）

```
01 → 02 / 03 (并行) → 04
```

- **01 必须先写**：Attach 是全阶段的入口管道。所有 jcmd 命令流经此管道到达 DCmd（02），JMX agent 通过此管道加载（和 03 弱相关），hs_err 在崩溃时会检查 attach listener 状态（04）
- **02 和 03 对 01 有弱依赖**，可并行
- **04 依赖 01**（VMError::report 内部检查 `AttachListener::is_initialized()`），必须在 01 之后

---

## 三、逐篇详述

### [01] Attach-Mechanism — jcmd/jstack/jmap 的 Unix 域套接字全链路

**核心问题**：外部工具（jcmd/jstack/jmap）如何打破进程边界，向正在运行的 JVM 发送命令？`/tmp/.java_pid<PID>` 套接字是谁创建的、何时创建、怎么被监听到？AttachListener 线程是 JVM 内部线程，它和 JavaThread 有什么不同？

**为什么放在第一**：这是 10 阶段和 09 阶段形成"内/外对称"的桥梁文档。09 的 JNI 线程穿越边界，本文的 AttachListener 把边界开口。读者刚学完 `JavaThread` 的生命周期（07），现在看到第一个"纯内部"的 JVM 线程——`attach_listener_thread_entry()`。

**覆盖内容**：

```
§〇 源文件清单
  - services/attachListener.cpp (AttachListener, attach_listener_thread_entry)
  - services/attachListener.hpp (AttachOperation, AttachOperationFunctionInfo)
  - os/linux/attachListener_linux.cpp (LinuxAttachListener, LinuxAttachOperation)
  - runtime/thread.cpp (Threads::create_vm → AttachListener::vm_start)
  - runtime/os.cpp (SIGBREAK 信号 → AttachListener 触发)
  - runtime/globals.hpp (StartAttachListener, DisableAttachMechanism)

§一 ★ 全景：一张图展示 jcmd → 套接字 → AttachListener → DCmd 的完整链路
  ❓ 为什么 Attach 选择 Unix 域套接字而不是 TCP？
  → 权限模型：SO_PEERCRED 验证 euid/egid 相同 → 只有同用户才能 attach。
    TCP 没有这个保证。Signal (SIGQUIT) 是备选路径，用于动态启动 attach 监听器。
  ❓ attach 机制是何时初始化的？
  → 两条路径：(1) 启动参数 -XX:+StartAttachListener → VM 启动时直接init
    (2) SIGBREAK/SIGQUIT 信号 → os::signalHandler 触发 AttachListener::is_init_trigger()
   ❓ DisableAttachMechanism=true 时整个代码路径都跳过吗？
   → 是。thread.cpp:4183 跳过 vm_start()，os.cpp 信号处理跳过触发逻辑。

§二 ★★★ attach_listener_thread_entry() 逐行走读
  ❓ 这个线程是什么类型？是 JavaThread 还是 os::thread？
  → 是 JavaThread（thread.cpp 创建），但永远在 _thread_in_native 状态。
    它不需要 safepoint check——它永远不执行 Java 字节码。
  ❓ dequeue() 内部做了什么？为什么有两层 dequeue（AttachListener + LinuxAttachListener）？
  → AttachListener::dequeue() 做 ThreadBlockInVM 包装后调用 LinuxAttachListener::dequeue()
    LinuxAttachListener::dequeue() → accept() 等待客户端连接 → getsockopt(SO_PEERCRED)
    验证 → read_request() 解析协议字符串 → 返回 AttachOperation。

§三 ★★ 协议解析：read_request() 与 write_fully()
  ❓ 协议格式是什么？为什么用 \0 分隔？
  → <ver>\0<cmd>\0<arg0>\0<arg1>\0<arg2>\0
    最多 3 个参数。\0 分隔避免参数值嵌入分隔符（NUL 不出现在合法参数中）。
  ❓ write_fully() 的 EINTR 重试循环和信号安全性？
  → os::write() 被 RESTARTABLE 宏包裹，被信号中断后自动重试。
    但 VMError 路径不用 write_fully——它直接用 os::write()（见 04）。

§四★ funcs[] 调度表 — 命令名到处理函数的映射
  ❓ 10 个内置命令分别做什么？jcmd 为什么是"最复杂"的？
  → funcs[] = {dumpheap, threaddump, jcmd, load, properties, inspectheap, setflag, printflag,
    datadump, agentProperties}。jcmd 复用 DCmd::parse_and_execute() → 40+ 子命令。
  ❓ jstack 不是直接命令——它怎么工作的？
  → jstack 实际发送 threaddump（平台线程 dump）或 jcmd Thread.print（文本格式）。

§五 ★★ 和 09-JNI 的"内/外"对称性
  AttachListener 线程 vs JNI 线程:
    相同: 都是 JavaThread，都在 _thread_in_native 中运行，都不执行 Java 字节码
    不同: AttachListener 受外部驱动（accept 阻塞等待），JNI 线程是从 Java 调用的
    更深层: 两者都是 JVM 的"接口线程"——内部(09) vs 外部(10)

§六 GDB 验证 + 可证伪断言
  - 断点 `LinuxAttachListener::dequeue()` → 单步到 `getsockopt(SO_PEERCRED)` → `p ucred.uid` 和 `p ucred.gid` 验证调用方身份
  - `read_request()` 中 `strncpy(arg, p, arg_length_max)` 执行后 → `p arg` 验证缓冲区内容无越界（buffer overflow 边界：arg_length_max=1024）
  - `AttachListener::dequeue()` 中 `ThreadBlockInVM` 包装前后 → `p thread->_thread_state` 验证 `_thread_in_vm(6)` → `_thread_blocked(10)` → 恢复 `_thread_in_vm(6)`
  - 断点 `attach_listener_thread_entry` → `bt` 验证调用栈不经过任何 Java 方法（纯 native 路径）
  - `ls -la /tmp/.java_pid<PID>` 验证 Unix 域套接字文件存在 → `stat` 验证 inode 与 AttachListener::_listener 引用一致
```

**关键文件**（跨 services + os + runtime）：

| 文件 | 模块 | 核心函数/类 | 本文角色 |
|------|------|-----------|---------|
| `attachListener.cpp` | services | `AttachListener`, `attach_listener_thread_entry()`, `funcs[]` | ★ 中央调度——收到命令后分发 |
| `attachListener.hpp` | services | `AttachOperation`, `AttachOperationFunctionInfo` | 数据结构——操作/函数映射 |
| `attachListener_linux.cpp` | os/linux | `LinuxAttachListener::init()`, `dequeue()`, `read_request()`, `write_fully()` | ★ 平台实现——套接字 I/O |
| `thread.cpp` | runtime | `Threads::create_vm` (:4183-4189) | 启动入口——AttachListener::vm_start/init |
| `os.cpp` | runtime | `signalHandler` (:362-387) | 信号触发——SIGBREAK → lazy init |
| `globals.hpp` | runtime | `StartAttachListener`, `DisableAttachMechanism` | 标志控制 |

**前置**：[09-01], [07-thread]（JavaThread 创建和生命周期）

---

### [02] DCmd-Diagnostic-Commands — register/deregister + parse_and_execute

**核心问题**：40+ 诊断命令（`Thread.print`、`GC.class_histogram`、`VM.info`）是怎么注册到 JVM 的、运行时怎么查找和执行的？DCmd 框架和 JMX MBean 的 `DiagnosticCommandImpl` 怎么对接？

**为什么重要**：jcmd 是线上诊断的第一工具。理解 DCmd 框架 == 理解为什么 jcmd 的 40+ 子命令可以在不重启 JVM 的情况下动态注册。

**覆盖内容**：

```
§〇 源文件清单
  - services/diagnosticCommand.cpp (DCmdRegistrant + 40+ DCmd 子类注册)
  - services/diagnosticCommand.hpp (~30 DCmd 子类声明)
  - services/diagnosticFramework.cpp (DCmd, DCmdFactory, parse_and_execute)
  - services/diagnosticFramework.hpp (DCmdParser, DCmdWithParser, DCmdFactoryImpl)
  - services/management.cpp (DCmdRegistrant::register_dcmds 调用点)
  - services/attachListener.cpp (jcmd 入口 → DCmd::parse_and_execute)
  - services/diagnosticArgument.cpp/hpp (DiagnosticArgument)

§一 ★★ DCmdFactory 注册链
  ❓ DCmdFactory 的全局链表 _DCmdFactoryList 是什么结构？
  → 单向链表——每个注册的 DCmdFactory 插入到链表头部。
    DCmdFactoryImpl<T> 用模板在编译期绑定命令名和 impl 类。
    register_DCmdFactory() → _next = _DCmdFactoryList; _DCmdFactoryList = this。
  ❓ 注册时机是什么？
  → Management::initialize() → DCmdRegistrant::register_dcmds() → 批量注册 ~40 个 DCmdFactory

§二 ★★★ DCmd::parse_and_execute() 全路径
  ❓ 入口到执行的完整调用链？
  → DCmd::parse_and_execute(DCmdSource, outputStream*, cmdline, delim)
    → DCmdIter 按 delim 分割多命令
    → DCmdFactory::create_local_DCmd() → factory() 搜索 _DCmdFactoryList
    → DCmdFactoryImpl::create_resource_instance() → new DCmdClass
    → DCmdMark RAII 保护
    → cmd->parse(cmdline) 解析参数
    → cmd->execute(source) 执行命令
    → DCmdMark::~DCmdMark → cleanup() + delete
  ❓ DCmdSource 的值影响执行行为吗？
  → 影响权限检查。DCmd_Source_AttachAPI 和 DCmd_Source_MBean 有不同的权限模型。

§三 ★ 典型命令走读（挑选 4 个代表性命令）
  1. Thread.print → ThreadDumpDCmd → ThreadService::dump_all_threads() ★ 需要 safepoint
  2. GC.class_histogram → ClassHistogramDCmd → SystemDictionary::classes_do() ★ 需要 safepoint
  3. VM.info → VMInfoDCmd → VMError::print_vm_info(outputStream*)
  4. VM.native_memory → NMTDCmd → MemTracker::report()
  ❓ 哪些命令需要 safepoint？为什么？
  → 遍历 SystemDictionary、线程栈 dump 需要 safepoint（一致性要求）
    VM.info 不需要——它只是打印 VM 配置和内存布局

§四 DCmdWithParser → DCmdParser 的参数解析模型
  ❓ 为什么参数解析用 DCmdParser 而不是简单的 strtok？
  → 支持类型化校验：DT_VMFLAG、DT_INT、DT_BOOL、DT_STRING
    支持可选参数、重复参数、带默认值的参数
    错误信息包含参数名和期望类型——这对 jcmd 用户友好

§五 ★ 和 JMX MBean 的对接
  ❓ DiagnosticCommandImpl MXBean 怎么转发到 DCmd？
  → management.cpp:2077 → DCmd::parse_and_execute(DCmd_Source_MBean, ...)
    和 Attach 路径共用完全同一套 DCmd 框架，只有来源标签不同
```

**关键文件**（跨 services + runtime + utilities）：

| 文件 | 模块 | 核心类/函数 | 本文角色 |
|------|------|-----------|---------|
| `diagnosticFramework.hpp` | services | `DCmd`, `DCmdFactory`, `DCmdParser` | ★ 框架核心——解析+执行引擎 |
| `diagnosticFramework.cpp` | services | `DCmd::parse_and_execute()` (:384) | ★ 主入口——命令解析调度 |
| `diagnosticCommand.hpp` | services | 30+ DCmd 子类声明 | 命令注册——所有诊断命令类 |
| `diagnosticCommand.cpp` | services | `DCmdRegistrant::register_dcmds()` (:69) | 注册表——40+ 命令工厂注册 |
| `management.cpp` | services | `Management::initialize()` (:148) | 触发点——注册调用位置 |
| `attachListener.cpp` | services | `jcmd()` (:208) | 入口——jcmd → DCmd 桥接 |

**前置**：[10-01], [08-safepoint]（部分 DCmd 需要 safepoint 执行）

---

### [03] MemoryService-JMX — MemoryPool/GCMemoryManager/MemoryUsage 的 JMX 桥接

**核心问题**：GC 的内存数据（Eden 使用量、Old 区回收次数）怎么从 `CollectedHeap` 流到 `java.lang.management.MemoryPoolMXBean`？`GCMemoryManager` 在 GC 的什么时候被通知？`LowMemoryDetector` 怎么从"stateless pool"算出"即将 OOM"？

**为什么重要**：这是 JConsole/VisualVM/JMC 等监控工具的底层数据来源。理解这条链 = 理解监控面板上每个数字是从哪里来的。

**覆盖内容**：

```
§〇 源文件清单
  - services/memoryService.cpp (MemoryService — 全局内存监控)
  - services/memoryService.hpp (TraceMemoryManagerStats RAII)
  - services/memoryPool.cpp/hpp (MemoryPool, CollectedMemoryPool 派生)
  - services/memoryManager.cpp/hpp (MemoryManager, GCMemoryManager)
  - services/gcNotifier.cpp/hpp (GCNotifier — GC 事件 → JMX 通知)
  - services/lowMemoryDetector.cpp/hpp (LowMemoryDetector + SensorInfo)
  - services/management.cpp (Management::initialize → MemoryService 初始化)
  - gc/shared/collectedHeap.hpp (memory_managers/memory_pools 虚函数)
  - gc/shared/genMemoryPools.hpp (ContiguousSpacePool, GenerationPool — GC 端实现)

§一 ★★ 从 GC 到 JMX 的数据流
  ❓ CollectedHeap 的 memory_managers() 和 memory_pools() 返回的是 services/ 的类吗？
  → 是的。每个 GC 实现（G1/Parallel/Serial）在初始化时创建 services/ 的
    MemoryPool/GCMemoryManager 对象。CollectedHeap 提供虚函数接口来返回它们。
    MemoryService::set_universe_heap() (:70) 调用 heap->memory_pools/managers()，
    把它们 append 到自己的 _pools_list / _managers_list 中。

§二 ★★★ TraceMemoryManagerStats — GC 到 JMX 的桥梁 RAII
  ❓ GC 怎么通知 MemoryService "我开始回收了"？
  → GC 在回收前后构造/析构 TraceMemoryManagerStats RAII 对象:
    TraceMemoryManagerStats(GCMemoryManager*, GCStatInfo*, ...)
      → MemoryService::gc_begin() → 记录开始时间
    ~TraceMemoryManagerStats()
      → MemoryService::gc_end() → 更新计数器 + 触发通知
   ❓ gc_begin/gc_end 内部做了什么？
   → gc_begin: 更新 GC 计数、记录时间戳
     gc_end: 更新 pool 使用量、调用 gcNotifier::sendNotification()
             检查 lowMemoryDetector::check_sensor()

§三 ★ MemoryPool 的类型层次
  ❓ 为什么有 CollectedMemoryPool / CodeHeapPool / MetaspacePool 三种？
  → CollectedMemoryPool — GC 管理的堆（Eden/Survivor/Old/Humongous）
    CodeHeapPool — 编译代码缓存（CodeCache）
    MetaspacePool — 类元数据（Metaspace）
    三者共用 MemoryPool 基类的 get_usage() / get_peak_usage() / get_collection_usage()，
    但触发方式不同：GC 池在 GC 后更新；CodeHeap 在编译/清理时更新；Metaspace 在类加载/卸载时更新。

§四 ★★ LowMemoryDetector 的工作原理
  ❓ "低内存检测"是轮询还是事件驱动的？
  → 事件驱动。MemoryService::gc_end() 调用 LowMemoryDetector::detect_low_memory()
    检测每个被监控的 MemoryPool 是否超过 usage threshold 或 collection usage threshold
  ❓ threshold 是谁设的？
  → JMX client 通过 MemoryPoolMXBean.setUsageThreshold(long) 设置。
    SensorInfo 对象持有阈值和触发计数器。如果 usage > threshold → 触发 JMX 通知。

§五 ★ GCNotifier — GC 事件 → JMX 通知
  ❓ GCNotifier 是每次 GC 都发通知，还是有过滤/节流机制？
  → 追踪 `gc_end` 回调 → GCNotifier 的 `sendNotification()` 是否检查 isNotificationEnabled
     → 通知是否有队列大小限制？如果 JMX client 断开，积压的通知怎么处理？
  ❓ 并发 GC 的高频周期事件（如 G1 concurrent mark start/end/cleanup）也发通知吗？
  → G1 的 FullGCNotificationManager 为此做了特殊处理——只对 full GC 发通知，young/mixed 不发
  ❓ GC 完成时间和通知到达 JMX client 之间有多大的时间窗口？在这个窗口里又触发了一次 GC 会怎样？
  → 这是一个并发安全的问题：gcNotifier 和 MemoryService 的 pool 更新是否在同一个锁保护下？

§六 ★ 和 06-GC 的连接
  → 06 理解为"GC 做了什么"，本文理解为"GC 的数据怎么对外暴露"
  → set_universe_heap 是 GC → services 的桥梁
  → TraceMemoryManagerStats 是 GC 周期内的数据采样点
```

**关键文件**（跨 services + gc/shared）：

| 文件 | 模块 | 核心类/函数 | 本文角色 |
|------|------|-----------|---------|
| `memoryService.cpp` | services | `MemoryService::gc_begin/gc_end`, `set_universe_heap` | ★ 中央调度——GC 事件到 JMX |
| `memoryPool.cpp` | services | `MemoryPool`, `CollectedMemoryPool` | 数据模型——内存池抽象 |
| `memoryManager.cpp` | services | `GCMemoryManager` | 数据模型——GC 管理器 |
| `gcNotifier.cpp` | services | `GCNotifier::sendNotification()` | 通知——GC 事件 → JMX |
| `lowMemoryDetector.cpp` | services | `LowMemoryDetector::detect_low_memory()` | 预警——阈值检测 |
| `collectedHeap.hpp` | gc/shared | `memory_managers/pools` 虚函数 (lines 439-440) | 接口——GC 提供池/管理器 |
| `genMemoryPools.hpp` | gc/shared | `ContiguousSpacePool`, `GenerationPool` | 实现——GC 端的具体池 |

**前置**：[06-gc]（理解 GC 的堆结构和回收过程）, [10-01]（JMX agent 通过 Attach 加载）

---

### [04] VMError-hs_err — VMError::report_and_die 的信号安全 write() 输出

**核心问题**：JVM 崩溃时（SIGSEGV / assert 失败 / unreachable），怎么在信号上下文中安全地生成 hs_err_pid<pid>.log？为什么只能用 `write()` 不能用 `fprintf`？VMError 的 `_steps[]` 分步机制怎么保证"至少输出一部分"？

**为什么放在最后**：VMError 是"最后一公里"。它组合了前面的线程栈打印（07）、信号处理（08的安全点思想）、AttachListener 状态检查（10-01）、native 栈解码（跨 os 和 utilities），是对全阶段能力的检验。

**覆盖内容**：

```
§〇 源文件清单
  - utilities/vmError.cpp (VMError::report_and_die, report, print_stack_trace, print_native_stack)
  - utilities/vmError.hpp (VMError 类 + 6 个 report_and_die 重载)
  - utilities/debug.cpp (report_vm_error, report_fatal, report_should_not_reach_here)
  - utilities/debug.hpp (vmassert, guarantee, fatal, ShouldNotReachHere 宏)
  - utilities/decoder.cpp/hpp (Decoder — native 栈符号化)
  - runtime/thread.cpp (Threads::print_on_error, JavaThread::print_on_error)
  - runtime/os.cpp (os::print_location — 地址解析)
  - services/attachListener.cpp (VMError 内检查 attach listener 状态)

§一 ★★★ 为什么 hs_err 必须用 write()？信号安全约束
  ❓ fprintf/stderr 和 write() 的本质区别是什么？
  → 信号上下文中不能持有锁、不能调用 malloc、不能执行非异步信号安全(AS-safe)操作。
    fprintf → 内部需要 FILE* 的锁 + 可能触发 malloc
    write() → 直接系统调用 → 不需要任何用户态锁
  ❓ 那怎么做到格式化输出？
  → VMError 自己实现了带缓冲的 outputStream。VSprintf 在栈上格式化，
    然后 write(fd, buf, len) 整块输出。不需要动态分配。

§二 ★★★ VMError::report_and_die() 的 3 层入口 + 场景分类
  ❓ 6 个 report_and_die 重载分别覆盖什么场景？
  → (1) 信号崩溃：SIGSEGV/SIGBUS/SIGFPE → 从 JVM 信号处理器调用
    (2) assert/guarantee 失败 → vmassert(cond) 展开为 report_vm_error
    (3) fatal/ShouldNotReachHere → 开发者断言
    (4) OOM → report_java_out_of_memory → VMError::report_and_die
  ❓ 不同场景触发的 report_and_die 有行为差异吗？
  → 核心逻辑一致，但 OOM 场景省略堆 dump（可能再次 OOM），
    信号场景触发原因由 siginfo 提供。

§三 ★★ _steps[] 分步执行 — "尽可能输出"
  ❓ 为什么设计步骤列表？一步失败会怎样？
  → _steps[] = {step_print_log_file, step_report, step_dump_core, step_abort, ...}
    每个 step 在执行前记录 `_current_step`。如果某步超时或失败，递归调用
    report_and_die → 但重新触发时会跳过当前 step → 输出"Error occurred during step X"
  ❓ 超时检测是什么机制？
  → check_timeout() — 计时从进入 report_and_die 开始，
    ErrorLogTimeout (默认 2 分钟) 到期则跳过当前步骤

§四 ★ report() 内部的内容生成顺序
  ❓ hs_err 文件的内容顺序为什么是这个？
  → report() 按固定顺序输出:
    (1) header (reason, error msg, thread, siginfo)
    (2) current thread stack — print_stack_trace()
    (3) all thread stacks — Threads::print_on_error()
    (4) native stack — print_native_stack() → Decoder::get_source_info()
    (5) VM state: safepoint状态, AttachListener状态, heap状态
    (6) memory map — os::print_memory_info()
    (7) loaded shared libraries — os::print_dll_info()
    (8) system info — os::print_summary_info()
  ❓ 和 ThreadService::dump_all_threads() 的线程栈有什么不同？
  → hs_err 的线程栈打印在信号上下文中，不走 safepoint。
    它直接遍历 ThreadsListSMR，从栈帧中读取数据——不需要线程合作。
    精度可能低但不需要 STW。

§五 ★ print_native_stack() 与 Decoder 的协作
  ❓ Decoder 是什么？为什么不在 hs_err 里用 addr2line？
  → Decoder 是进程内 C++ 栈符号化器，通过解析 ELF/DWARF 或 dladdr() 
    在进程崩溃时把 PC 地址变成"函数名 + 文件:行号"。
    不能用 addr2line（外部进程）是因为：
    (1) 信号上下文不能 fork/exec
    (2) ASLR 下需要进程内地址映射

§六 ★ 和 08-safepoint 的关系：信号安全输出的极限
  08 的 safepoint begin() 用 polling page (mprotect+SIGSEGV) 做线程同步，
  它的信号处理器必须非常安全（不能阻塞、不能分叉）。VMError 的 report_and_die
  继承了同样的"信号安全"要求，但做得更极端：
  - 没有第二线程协助（vs safepoint 有 VMThread 协调）
  - 必须输出大量文本（vs safepoint 只是改状态）
  - 如果自身失败还要递归重试

§七 ★ 和 10-01 的连接：崩溃时检查 AttachListener
  ❓ 为什么 hs_err 要输出 attach listener 的状态？
  → VMError::report() 的 VM state 部分检查 AttachListener::is_initialized()。
    如果 attach 管道因为崩溃遗留中断状态，有助于诊断"为什么 jcmd 连不上"。
  ❓ 兼容性：VMError 本身能调用 AttachListener 吗？
  → AttachListener 的状态是 Atomic::load 的简单 bool 检查——信号安全。
```

**关键文件**（跨 utilities + runtime + os + services）：

| 文件 | 模块 | 核心函数/类 | 本文角色 |
|------|------|-----------|---------|
| `vmError.cpp` | utilities | `VMError::report_and_die()` (:1307), `report()` (:417), `print_stack_trace()`, `print_native_stack()` | ★ 核心——崩溃报告的完整实现 |
| `vmError.hpp` | utilities | `VMError` 类 (:34) + 6 个重载 | 接口——多场景入口 |
| `debug.cpp` | utilities | `report_vm_error()` (:237) | 入口——assert/guarantee → VMError |
| `debug.hpp` | utilities | `vmassert`, `guarantee`, `fatal` 宏 | 触发——代码中触发崩溃的方式 |
| `decoder.cpp` | utilities | `Decoder` (:102), `AbstractDecoder` | 符号化——native 栈解码 |
| `thread.cpp` | runtime | `Threads::print_on_error()` (:5064), `JavaThread::print_on_error()` | 线程——所有线程栈打印 |
| `os.cpp` | runtime | `os::print_location()` (:1086) | 地址解析——pc 地址→库名+符号 |
| `attachListener.cpp` | services | `AttachListener::is_initialized()` | 状态查询——崩溃时检查 attach 管道 |

**前置**：[10-01], [08-safepoint], [07-thread-lock]

---

## 四、写作优先级与预估篇幅

| 优先级 | 文档 | 预估篇幅 | 理由 |
|--------|------|---------|------|
| **P0** | 01-Attach-Mechanism | ~550行 | 全阶段入口管道 + 09 对称文档。独立价值最高。 |
| **P0** | 04-VMError-hs_err | ~500行 | "最后一公里"——综合 07/08/10 的多阶段知识，能力检验 |
| **P1** | 02-DCmd-Diagnostic-Commands | ~480行 | jcmd 是线上诊断的第一工具，框架设计模式（Factory 链表注册）有教学价值 |
| **P1** | 03-MemoryService-JMX | ~450行 | GC 到 JMX 的桥接——监控工具的数据源头 |

---

## 五、和已学阶段的对比

| 维度 | 08-safepoint | 09-native-interface | 10-services-diag |
|------|-------------|-------------------|-----------------|
| 核心文件 | ~6 | ~79（聚焦 ~25） | ~56（聚焦 ~20） |
| 文档数 | 5 | 7 | **4** |
| 模块跨度 | **2 模块** (runtime + gc) | **7 模块** (prims + runtime + gc + os_cpu + interpreter + oops + os) | **5 模块** (services + os + utilities + gc/shared + runtime) |
| 核心叙事 | 一个机制层层深挖 | 多个子系统+线程状态 | 两个管道(Attach+JMX)+一条底线(VMError) |
| 与前置的连接 | 自包含（依赖07） | 强烈依赖 08（01桥梁 + 03直接复用） | ★ 依赖 09（内外对称）+ 08（信号安全）+ 07（线程） |
| 最大价值 | begin/end 双层门禁 | JNI线程状态 + VM_Operation应用 | ★ 面向生产——线上诊断全链路 |

### 和 09-native-interface 的关系：内外对称

| | 09 (内部接口) | 10 (外部接口) |
|---|---|---|
| 调用方向 | Java → JNI → C++ | 外部工具 → 套接字 → C++ |
| 入口线程 | JNI 线程（从 Java 调用） | AttachListener 线程（JVM 内部线程） |
| 线程状态 | _thread_in_native ↔ _thread_in_vm 转换 | 永远 _thread_in_native |
| 安全机制 | JNI 引用管理 | SO_PEERCRED 身份验证 |
| 和 safepoint 互动 | transition_from_native→poll | 不需要——不执行 Java 字节码 |

### 和 08-safepoint 的关系：信号安全的极限

08 的 safepoint begin() 中，VMThread 用信号协调所有线程。但这个信号处理器的约束是"最短路径"——改状态、返回。VMError 的 report_and_die 在同样的信号约束下做"最长的安全路径"——输出完整崩溃报告、打印所有线程栈、调用 Decoder 符号化 native 帧。8 和 10 是"信号安全"这一思想的两极。

### 和 07-thread-lock 的关系：attach_listener_thread_entry 作为 JVM 内部线程

07 建立了 JavaThread 的完整生命周期模型。本文的 `attach_listener_thread_entry()` 是第一个"永不执行 Java 代码"的 JavaThread——它立即进入 `_thread_in_native` 并永不返回。这是对 07 线程模型的扩展。

---

## 六、跨模块依赖矩阵

| | services | os/linux | utilities | gc/shared | runtime |
|---|:---:|:---:|:---:|:---:|:---:|
| **01** Attach | attachListener.cpp/hpp | attachListener_linux.cpp | — | — | thread.cpp, os.cpp, globals.hpp |
| **02** DCmd | diagnosticFramework, diagnosticCommand | — | — | — | — |
| **03** MemoryService | memoryService, memoryPool, memoryManager | — | — | collectedHeap.hpp, genMemoryPools | — |
| **04** VMError | attachListener.cpp（状态查询） | — | vmError.cpp, debug.cpp, decoder.cpp | — | thread.cpp, os.cpp |

★ 注意：
- `attachListener_linux.cpp` 包含 **2 个 dequeue()**：`AttachListener::dequeue()`（services/ 桥接层）和 `LinuxAttachListener::dequeue()`（平台套接字层）。01 文档必须分清这两层
- `collectedHeap.hpp` 声明了 `memory_managers()` / `memory_pools()` 虚函数，但实现在各个 GC 实现中——这是 gc → services 的唯一桥梁
- `vmError.cpp` 依赖 `attachListener.cpp` 的状态查询，但 VMError 在 utilities/ 而非 services/——这是本阶段最意外的跨模块依赖

---

## 七、显式排除的主题（为什么不做）

以下主题有各自的价值，但本阶段刻意不包含：

| 主题 | 排除原因 |
|------|---------|
| **NMT (Native Memory Tracking)** — MemTracker / MallocTracker / MemReporter | 虽然 NMT 有诊断命令（NMTDCmd），但核心机制是 `MallocHeader` + `ThreadCritical` 锁的 per-call 追踪，属于"内存追踪基础设施"而非"诊断管道"。本系列不独立覆盖 NMT（和 JVM 内核机制的关联限于 dcmp 命令和 VM.native_memory 入口——这些在 [02-DCmd] 中作为命令映射提及即可） |
| **HeapDumper / HPROF 格式** | dumpheap 是 Attach 的一个分支命令，但 HPROF 格式解析 + HeapDumperCompression 是独立内容。在 01-Attach 中提到 dumpheap 的调度路径即可，不展开二进制格式 |
| **JVMTI Agent 生命周期**（Agent_OnLoad/Attach, JvmtiAgentThread） | 属于 JVMTI API 实现层面，不在本阶段"诊断管道"主线上。load agent 作为 Attach 命令的一行式调度 |
| **ThreadService 线程 dump 细节**（ThreadStackTrace, ConcurrentLocksDump） | 线程 dump 在 01-Attach 和 04-hs_err 中都用到，但 ThreadService 自身的 ThreadSnapshot/DeadlockCycle 数据结构属于 JMX 线程监控层面。本阶段不把 ThreadService 独立成篇 |
| **ClassLoadingService / RuntimeService** | 它们的 JMX MXBean 接口模式和 MemoryService 类似，但"类加载监控"属于 classfile（04）的边界，"运行时监控"内容太少。读者理解 MemoryService 一篇后，其他 *Service 的模式是一致的 |
| **Management.java 层的 JMX Agent** | Management::initialize() 只是调用入口。JMX 的 MBeanServer 注册、javax.management 协议属于 JDK 层，不属于 hotspot 分析 |
| **DTrace Attacher**（DTraceAttacher） | 平台特定且 Linux 不常用。在 01-Attach 中提一句即可 |

---

## 八、每篇文档的深度问题（写 prompt 时必须覆盖）

以下问题不要求在 README 中回答——它们用于驱动每篇文档的 prompt，确保文档不只是"解释代码"，而是"追问为什么"。

### [01] Attach-Mechanism

1. `LinuxAttachListener::dequeue()` 中 `accept()` 阻塞时，如果 JVM 正在 shutdown，这个线程怎么被唤醒？是靠 `listener_cleanup()` 的 `shutdown()` 还是靠别的机制？
2. `read_request()` 读到的协议字符串 `ver\0cmd\0arg0\0arg1\0arg2\0` — 如果攻击者发送了一个 `cmd` 中含有 `\0` 的请求（不可能，因为 `read()` 返回的是实际字节数），但更微妙的问题：如果参数长度超过 arg_length_max (1024) 会怎样？
3. `AttachListener::transit_state()` 用 `Atomic::cmpxchg` 做三态转换（AL_NOT_INITIALIZED → AL_INITIALIZING → AL_INITIALIZED）。为什么需要中间态 AL_INITIALIZING？如果只有两个状态（未初始化/已初始化）会有什么竞态？

### [02] DCmd-Diagnostic-Commands

1. `DCmdFactory::factory()` 的搜索是线性遍历 `_DCmdFactoryList`。40+ 命令每次 jcmd 都要遍历——为什么不考虑 hash map？什么时候性能会变差？
2. `DCmdMark` RAII 的目的是保证 `cleanup()` 被调用。如果 DCmd::execute() 触发 GC（在 safepoint 中执行 VM_Operation），DCmdMark 的析构是否可能被跳过——GC 能嵌套在 DCmd 执行里吗？
3. `DCmdRegistrant` 是 `Management` 的 friend。为什么命令注册必须和 Management 耦合？能不能在 AttachListener 启动时独立注册？

### [03] MemoryService-JMX

1. `MemoryService::set_universe_heap()` 只用调用一次。如果 GC 实现在运行中切换（JEP 不涉及但理论上 Epsilon → Serial 可以发生），MemoryService 的内存池列表需要重建——当前代码支持吗？
2. `LowMemoryDetector::detect_low_memory()` 在每次 `gc_end()` 后被调用。如果两次 GC 之间堆一直没降到阈值以下，SensorInfo 的 `_trigger_count` 会继续增加——这个计数器有上界吗？会不会溢出？
3. `GCMemoryManager` 的 `gc_begin/gc_end` 对和 GC 实际回收的并发 GC（G1 concurrent mark）——通知是在 concurrent mark 开始/结束时发的，还是在 final remark safepoint 时发的？

### [04] VMError-hs_err

1. `VMError::report_and_die()` 中调用 `check_timeout()` — 超时检测需要读取时钟。`os::elapsedTime()` / `os::javaTimeMillis()` 在信号上下文中是否安全？它们内部用 `clock_gettime()`（syscall）还是读 TSC？如果是 TSC，在 SMP 下跨 NUMA 节点读会不会有微妙的偏移？
2. 如果 `report_and_die()` 自身触发 SIGSEGV（例如栈被破坏导致 print_stack_trace 访问非法地址），递归调用 `report_and_die()` — 第二次进入怎么检测到"我正在报告错误"？靠什么防止无限递归？
3. `print_native_stack()` 使用 `os::get_sender_for_C_frame()` 遍历 native 栈帧。如果栈被 `-fomit-frame-pointer` 编译，frame pointer 在 x86 上可能被重用为 GP 寄存器——怎么继续解 native 栈？解码会默默失败还是输出错误信息？
