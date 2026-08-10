# PROMPT: 请撰写 02-DCmd-Diagnostic-Commands.md

## 〇、背景与使用场景

### 你在生产环境中每天都在经历的

你敲了这一行：
```bash
$ jcmd 12463 Thread.print -l
"http-nio-8080-exec-3" #39 daemon prio=5 tid=0x00007f8b24111800 nid=0x5cee waiting for monitor entry [0x00007f8b1f5fb000]
   java.lang.Thread.State: BLOCKED (on object monitor)
        at com.example.service.LockService.methodB(LockService.java:47)
        - waiting to lock <0x0000000714d8af80> (a java.lang.Object)
        - locked <0x0000000714d8af90> (a java.lang.Object)
        at com.example.controller.MainController.handle(MainController.java:23)

"http-nio-8080-exec-1" #37 daemon prio=5 tid=0x00007f8b24110000 nid=0x5cec waiting for monitor entry [0x00007f8b1f7fc000]
   java.lang.Thread.State: BLOCKED (on object monitor)
        at com.example.service.LockService.methodA(LockService.java:35)
        - waiting to lock <0x0000000714d8af90> (a java.lang.Object)
        - locked <0x0000000714d8af80> (a java.lang.Object)

Found one Java-level deadlock:
=============================
"http-nio-8080-exec-3":
  waiting for ownable synchronizer 0x0000000714d8af80,
  which is held by "http-nio-8080-exec-1"
"http-nio-8080-exec-1":
  waiting for ownable synchronizer 0x0000000714d8af90,
  which is held by "http-nio-8080-exec-3"
```
→ JVM 内部发生了什么？`jcmd Thread.print -l` 的字符串被包装为 `AttachOperation` → `jcmd()` 传给 `DCmd::parse_and_execute("Thread.print -l", DCmd_Source_AttachAPI)` → `factory("Thread.print")` 在 `_DCmdFactoryList` 单向链表中线性搜索 → 找到 `DCmdFactoryImpl<ThreadDumpDCmd>` → `create_resource_instance()` new 出 `ThreadDumpDCmd` → `DCmdMark` RAII 构造 → `parse("-l")` 将 `-l` 解析为 `_locks = true` → `execute()` → `ThreadService::dump_all_threads()` → **需要 safepoint** → VMThread 协调所有线程暂停 → 遍历全部线程栈 → 检测锁占用关系 → 输出等待链 → `DCmdMark::~DCmdMark()` cleanup + delete。`-l` 参数触发的就是 "Found one Java-level deadlock" 这一段——它在 `dump_all_threads()` 中额外做了 `ObjectSynchronizer::find_deadlocks()`。

你敲了这一行：
```bash
$ jcmd 12463 GC.class_histogram | head -20
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:       1283952       225975552  [B (java.base@11.0.22)
   2:        513680        12328320  java.util.HashMap$Node (java.base@11.0.22)
   3:        502446        12058704  java.lang.String (java.base@11.0.22)
   4:        298774         9560768  java.util.concurrent.ConcurrentHashMap$Node (java.base@11.0.22)
   5:        156860         7529280  com.example.entity.Order (app)
   6:         89420         7153600  [Ljava.lang.Object; (java.base@11.0.22)
   7:        150342         4810944  java.util.LinkedHashMap$Entry (java.base@11.0.22)
   ...
```
→ JVM 内部发生了什么？`jcmd GC.class_histogram` → `DCmd::parse_and_execute` → `factory("GC.class_histogram")` → `ClassHistogramDCmd` → `execute()` → `SystemDictionary::classes_do()` → **需要 safepoint**（SystemDictionary 必须在安全点中遍历以避免 C++ 迭代器失效）→ 遍历所有 loaded Class → 每个 Class 调用 `Klass::oop_iterate()` 统计实例数和字节数 → 按字节量降序排列输出。这是排查内存泄漏的第一步：`#bytes` 最大的类如果不符合预期（比如 `Order` 对象有 15 万），就找到了泄漏嫌疑。

你敲了这一行：
```bash
$ jcmd 12463 VM.system_properties
#Wed Jun 04 15:22:31 CST 2025
java.runtime.name=OpenJDK Runtime Environment
java.vm.version=11.0.22+9-LTS
java.vm.vendor=Red Hat, Inc.
file.encoding=UTF-8
sun.jnu.encoding=UTF-8
java.class.path=/app/app.jar
java.library.path=/usr/local/lib:
java.io.tmpdir=/tmp
```
→ JVM 内部发生了什么？`jcmd VM.system_properties` → `DCmd::parse_and_execute` → `factory("VM.system_properties")` → `VMInfoDCmd` / 相关 DCmd → `execute()` → `SystemProperty::print()` → 从 `SystemDictionary::_system_properties` 遍历——**不需要 safepoint**（只读静态 HashMap，不遍历堆或线程栈）。

你敲了这一行：
```bash
$ jcmd 12463 VM.native_memory summary
12463:

Native Memory Tracking:

Total: reserved=6511781KB, committed=2968489KB
-                 Java Heap (reserved=4194304KB, committed=2294144KB)
                            (mmap: reserved=4194304KB, committed=2294144KB)

-                     Class (reserved=1142447KB, committed=92383KB)
                            (classes #22245)
                            (  instance classes #20765, array classes #1480)
                            (malloc=2423KB #36142)
                            (mmap: reserved=1140024KB, committed=89960KB)
                            (  Metadata:   )
                            (    reserved=1140024KB, committed=89960KB)

-                    Thread (reserved=281438KB, committed=281438KB)
                            (thread #272)
                            (stack: reserved=278528KB, committed=278528KB)

-                      Code (reserved=264158KB, committed=81326KB)
                            (malloc=8188KB #13865)
                            (mmap: reserved=255970KB, committed=73138KB)

-                        GC (reserved=512324KB, committed=205372KB)
...
```
→ JVM 内部发生了什么？`jcmd VM.native_memory` → `DCmd::parse_and_execute` → `factory("VM.native_memory")` → `NMTDCmd` → `execute()` → `MemTracker::report()` → **不需要 safepoint**（只读 NMT 的原子计数器——每次 `os::malloc()` 调用都已更新了 `MallocMemorySummary::_snapshot`）。NMT 依赖 Java 启动时加 `-XX:NativeMemoryTracking=summary` 参数——底层用 `MallocTracker::record_malloc()` 在每次 `os::malloc()` 中增量更新计数器。`detail` 级别（`VM.native_memory detail`）会输出每个 malloc 调用点的调用栈——相应地需要 `-XX:NativeMemoryTracking=detail` 并记录调用栈（有一定性能开销）。

你敲了这一行：
```bash
$ jcmd 12463 GC.run
```
→ 生产慎用！`jcmd GC.run` → `DCmd::parse_and_execute` → `GCHeapDumpDCmd` / GC 相关 → `GenCollectedHeap::collect(GCCause::_jcmd)` → Full GC。DCmd 框架本身只是字符串解析和命令调度——它不判断这个命令是否危险。危险性是命令实现决定的——`GC.run` 的实现直接调 GC，和你在代码里 `System.gc()` 效果一致，区别是通过 DCmd 从外部触发。

### 相关生态工具（本文分析的源码的"表兄弟"）

- **Arthas `thread -b`**（查死锁）：Arthas 不通过 DCmd 框架执行——它通过 Instrumentation API 直接访问 `ThreadMXBean.findDeadlockedThreads()`——但展示的结果和 `jcmd Thread.print -l` 的 "Found one Java-level deadlock" 段落完全一致。两者最终都走到 `ThreadService::find_deadlocks()`。
- **Arthas `jvm`**（JVM 信息）：`arthas jvm` 输出 JVM 的内存/GC/线程/OS 信息——功能上和 `jcmd VM.info` + `jcmd VM.flags` + `jcmd VM.uptime` 的组合镜像。不走 DCmd 框架，而是直接从 `ManagementFactory` 的 MXBean 读取——但 MXBean 的数据源和 DCmd 是同一套底层数据结构（`MemoryService`、`ThreadService` 等）。
- **JMX `DiagnosticCommandMBean`**：JVM 除了通过 Attach 管道暴露 DCmd，还通过 JMX 暴露了一个 `com.sun.management.DiagnosticCommandMBean`——它的 `invoke()` 方法接收命令名字符串（如 `"Thread.print -l"`）并转发给 `DCmd::parse_and_execute()` ——只是 `source = DCmd_Source_MBean`。这意味着同一个 `Thread.print` 命令，可以通过 `jcmd`、通过 JConsole MBeans 标签、通过 JMX REST API 三种方式执行——底层都是用 `DCmd::parse_and_execute()`。

### 生产环境的实践要点

**命令注册表的设计哲学**：40+ 命令不是 `if-else` / `switch-case` 分发的——那是一篇 500 行的巨函数。DCmd 框架用的是"工厂注册链表"模式：每个命令的 `DCmdFactory` 在 VM 启动时通过 `DCmdRegistrant::register_dcmds()` 批量注册到一个单向链表中，运行时 `factory(name)` 线性查找（`while (factory != NULL) { if (strncmp(name, factory->name(), len) == 0) return factory; factory = factory->_next; }`）。为什么是链表而不是 hash map？40 个命令 × O(1) 查找 vs 维护 hash table 的内存开销：对于不频繁的诊断操作（jcmd 通常由人工触发，不是每秒几百次的高频调用），线性搜索已经够快了。这和 JVM 的 "简单性 > 极致性能" 设计哲学一致。

**JMX `DiagnosticCommandMBean` 的权限差异**：从 JMX 执行 DCmd 命令时，`source = DCmd_Source_MBean`，这影响了两个行为：a) JMX 路径只允许单命令——用 `\n` 分隔的多命令语法被显式禁止（`THROW_MSG("Invalid syntax")`）；b) `export_flags` 过滤——有些命令只在 Attach 路径可用（`DCmd_Source_AttachAPI`），有些在 JMX 路径也可用。这是因为 JMX 通过网络暴露（RMI/HTTP），安全性要求更严格。

**`jcmd` 频繁调用的性能开销**：每次 `jcmd <PID> <command>` 是一条完整的 Attach 连接生命周期——创建 Unix 域套接字客户端 → `connect()` → 写入请求 → 等待回应 → `close()`。命令解析和执行在 JVM 的 AttachListener 线程上进行（非应用线程）。对应用线程的唯一影响是某些命令需要 safepoint（`Thread.print`、`GC.class_histogram` 等）——此时所有 Java 线程暂停。如果监控脚本每 10 秒执行一次 `jcmd Thread.print`，每 10 秒就有一次短暂的 STW（遍历线程栈的时间通常在几十毫秒）。高频率的 `jcmd GC.class_histogram` 在生产中尤其致命——它需要遍历整个 SystemDictionary + 统计所有 Class 的实例数，STW 时间可能上秒。

### 生产常见陷阱

- **`GC.run` 触发 Full GC**——已在上面描述。DCmd 框架无法阻止你执行危险命令——它只负责解析和执行。`GC.run` 在生产中只应该作为最后手段（例如 CMS 并发失败后的紧急回收），不应作为定期清理的工具。
- **`Thread.print` 超时降级**：`Thread.print -l` 检测死锁需要遍历所有 monitor——如果某些线程在 JNI 临界区中长时间不返回（持有 monitor），`find_deadlocks()` 可能阻塞在 `ObjectSynchronizer::read_stable_lock()` 上，导致整个 DCmd 命令超时（`ErrorLogTimeout` 相关机制）。超时后输出不完整的线程 dump——缺少部分锁信息。
- **DCmdFactory 注册顺序依赖**：命令的查找顺序由注册顺序决定（`DCmdRegistrant::register_dcmds()` 中的调用顺序）。如果有两个命令同名（正常情况下不会），后注册的会因为头插法先被找到。`help` 命令的输出按链表顺序排列——这就是 `jcmd help` 输出命令列表的顺序。
- **DisableAttachMechanism 不阻止 JMX 的 DCmd 调用**：`-XX:+DisableAttachMechanism` 关闭的是 AttachListener——套接字文件不会创建，AttachListener 线程不启动。但 JMX 的 `DiagnosticCommandMBean` 通过 `MBeanServer.invoke()` 调用 `DCmd::parse_and_execute()` 仍然有效——除非 JMX 本身被禁用（`-XX:+DisableAttachMechanism` 无法阻止通过 RMI/JMX 执行 DCmd 命令）。

### 背景概念速览

- **命令注册表（DCmdFactoryList）**：不是 `switch-case`，是单向链表 + 头插法的工厂模式。每个命令在 VM 启动时通过 `register_DCmdFactory(new DCmdFactoryImpl<ThreadDumpDCmd>(...))` 注册，`DCmdFactoryImpl<T>` 模板在编译期绑定命令名字符串和实现类 `T`。
- **DCmdFactory 模板化注册**：`DCmdFactoryImpl<ThreadDumpDCmd>` 是 `DCmdFactory` 的模板子类——它在构造时就绑定了 `name = "Thread.print"`（来自 `ThreadDumpDCmd::name()` 静态方法）、`enabled = true`、`description = "..."`。工厂的 `create_resource_instance()` 方法简单地 `new (ResourceObj::RESOURCE_ARENA, mtInternal) ThreadDumpDCmd(out, parser)`——这就是"工厂"的实质：从命令名字符串到命令对象的一个 new。
- **JMX DiagnosticCommandMBean**：`com.sun.management.DiagnosticCommandMBean` 是 JDK 层的 MBean——它的 `invoke(String cmdline)` 方法把 JMX 调用转发给 `DCmd::parse_and_execute(cmdline, DCmd_Source_MBean, ...)`。MBean 的注册信息（包括所有可用命令列表）通过 `DCmdFactory::send_notification()` 推送给 JMX client——当新的 DCmd 注册后，JMX client 会收到 MBean 变更通知。

## 一、任务 + 核心故事线（禁止做源码翻译机！）

读者刚学完 [10-01]——一个外部 jcmd 请求通过 `/tmp/.java_pid<PID>` 套接字到达 `attach_listener_thread_entry()`，然后 `jcmd()` 函数把 `op->arg(0)` 原样传给 `DCmd::parse_and_execute()`。但这里发生了什么？40+ 诊断命令（`Thread.print`、`GC.class_histogram`、`VM.info`）是怎么注册的？运行时怎么查找和执行的？`DCmdFactory` 的单向链表为什么不用 hash map？`DCmdMark` RAII 如果被 GC 打断会怎样？

**本文不是 jcmd 使用手册**——不需要解释 `jcmd <PID> help` 怎么用。**本文也不是 JMX MBean 注册指南**——`DiagnosticCommandImpl` 的 `javax.management` 绑定属于 JDK 层。本文的唯一目标：**从 `DCmdFactory` 的单向链表注册链开始，到 `DCmd::parse_and_execute()` 的 `DCmdMark` RAII 保护结束——追踪命令"从字符串到执行"的完整框架机制**。读者学完后，看到一个 `jcmd <PID> Thread.print -l` 请求时，脑中能自动展开一条调用链：`parse_and_execute → DCmdIter → create_local_DCmd → factory() 线性搜索 → new ThreadDumpDCmd → DCmdMark 构造 → parse → execute → DCmdMark 析构 cleanup → delete`。

### 验证报告
- `sverklo_investigate(DCmdFactory parse_and_execute DCmdRegistrant)` → 发现：单向链表 `_DCmdFactoryList` + `register_DCmdFactory` 头插法 + `factory()` 线性搜索
- `codegraph query "DCmdFactory::register_DCmdFactory"` → diagnosticFramework.cpp:513-522
- `codegraph query "DCmd::parse_and_execute"` → diagnosticFramework.cpp:384-413
- `grep -n "factory(" diagnosticFramework.cpp` → 行 496-511，Mutex 保护，线性遍历
- `grep -n "register_dcmds" diagnosticCommand.cpp` → 行 69，~40 个命令注册
- `grep -n "register_dcmds" management.cpp` → 行 148，Management::initialize 调用点

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 路径 | 模块 | 核心函数/类（行号） | 本文角色 |
|---|------|------|------|-------------------|---------|
| 1 | `diagnosticFramework.hpp` | `src/hotspot/share/services/diagnosticFramework.hpp` | services | `DCmd`(:277), `DCmdFactory`(:345), `DCmdParser`(:203), `DCmdMark`(:326), `DCmdWithParser`(:310) | ★★★ 框架核心——引擎 + 工厂 + RAII |
| 2 | `diagnosticFramework.cpp` | `src/hotspot/share/services/diagnosticFramework.cpp` | services | `DCmd::parse_and_execute()`(:384), `DCmdFactory::factory()`(:496), `register_DCmdFactory()`(:513), `create_local_DCmd()`(:524) | ★★★ 主入口 + 注册/查工厂引擎 |
| 3 | `diagnosticCommand.hpp` | `src/hotspot/share/services/diagnosticCommand.hpp` | services | `HelpDCmd`, `VersionDCmd`, `ThreadDumpDCmd`(:448), `ClassHistogramDCmd`(:359), `VMInfoDCmd`(:243), 等 30+ 子类 | ★★ 命令定义——所有 DCmd 子类声明 |
| 4 | `diagnosticCommand.cpp` | `src/hotspot/share/services/diagnosticCommand.cpp` | services | `DCmdRegistrant::register_dcmds()`(:69), 各命令 execute() 实现 | ★★ 注册表 + 命令实现 |
| 5 | `diagnosticArgument.hpp` | `src/hotspot/share/services/diagnosticArgument.hpp` | services | `GenDCmdArgument`(:62), `DCmdArgument<T>`(:109) | ★ 参数类型系统 |
| 6 | `management.cpp` | `src/hotspot/share/services/management.cpp` | services | `Management::initialize()` → `register_dcmds()`(:148-150) | ★ 注册触发点 |
| 7 | `attachListener.cpp` | `src/hotspot/share/services/attachListener.cpp` | services | `jcmd()`(:202-216) — 调用 `DCmd::parse_and_execute(DCmd_Source_AttachAPI, ...)` | ★ 入口——Attach → DCmd 桥接 |

## 四、必须深度走读的核心概念

> 每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ DCmdFactory 单向链表——注册、查找、性能

```
问题：
  ① DCmdFactory 的全链表 _DCmdFactoryList 怎么构建的？
     线索: diagnosticFramework.cpp:513-522
     代码引证:
       int DCmdFactory::register_DCmdFactory(DCmdFactory* factory) {
         MutexLockerEx ml(DCmdFactory_lock, Mutex::_no_safepoint_check_flag);
         factory->_next = _DCmdFactoryList;
         _DCmdFactoryList = factory;
       }
     答案方向: 头插法——每次注册插入链表头部。DCmdRegistrant::register_dcmds() 一次性
     注册 ~40 个工厂，顺序取决于静态构造顺序。Mutex::_no_safepoint_check_flag 说明
     注册可以在 safepoint 中发生（Management::initialize 在 VM 启动阶段）。

  ② ★★★ 为什么 factory() 用线性搜索而不是 hash map？
     线索: diagnosticFramework.cpp:496-511
     代码引证:
       DCmdFactory* DCmdFactory::factory(DCmdSource source, const char* name, size_t len) {
         DCmdFactory* factory = _DCmdFactoryList;
         while (factory != NULL) {
           if (strlen(factory->name()) == len && strncmp(name, factory->name(), len) == 0) { ... }
           factory = factory->_next;
         }
       }
     答案方向: (a) 命令数 ~40，线性扫描 O(40) < O(1)+常量——hash map 的
     内存开销和碰撞处理不值得；(b) jcmd 是低频诊断操作——不需要极致性能；
     (c) 单向链表不依赖 malloc/free——信号安全（和 [04-VMError] 的理念相同）；
     (d) 代码简单——不需要 STL/C++ 标准库依赖。

  ③ register_DCmdFactory 为什么不检查重复注册？
     线索: diagnosticFramework.cpp:521（注释）
     代码引证: `return 0; // Actually, there's no checks for duplicates`
     答案方向: 注册是静态的（`DCmdRegistrant::register_dcmds()` 只执行一次），
     每个命令只注册一个工厂。设计信任没有重复。
```

### 4.2 ★★★ `DCmd::parse_and_execute()` 全路径——从字符串到执行

```
问题：
  ① 入口到执行的完整调用链是什么？
     线索: diagnosticFramework.cpp:384-413
     答案方向: parse_and_execute(cmdline, ' ', THREAD)
       → DCmdIter 按 '\n' 分割多命令
       → 对每个命令：
         → DCmdFactory::create_local_DCmd(source, line, out)
           → factory(source, cmd_name, len)         // 搜索链表
           → f->create_resource_instance(out)       // new DCmdClass(resource)
         → DCmdMark mark(command)                    // RAII 保护
         → command->parse(&line, delim)             // 解析参数
         → command->execute(source)                  // 执行
       → DCmdMark::~DCmdMark → cleanup() + delete

  ② JMX 路径和 Attach 路径有什么不同的行为？
     线索: diagnosticFramework.cpp:392-398
     代码引证:
       if(source == DCmd_Source_MBean && count > 0) {
         THROW_MSG(..., "Invalid syntax");
       }
     答案方向: JMX 每次只执行一个命令（权限检查要求），Attach 可以多命令用 '\n' 分隔。

  ③ DCmdSource 的三种值分别影响什么？
     答案方向: DCmd_Source_AttachAPI (0x2) — 来自 jcmd；DCmd_Source_MBean (0x4) — 来自 JMX；
     DCmd_Source_Internal (0x1) — VM 内部调用。影响：JMX 限制单命令 + 不同权限模型；
     factory() 中检查 export_flags() & source 过滤可见命令。
```

### 4.3 ★★★ DCmdMark RAII——cleanup 保证和 GC 嵌套风险

```
问题：
  ① DCmdMark 的 RAII 保护了什么？
     线索: diagnosticFramework.hpp:326-337
     代码引证:
       class DCmdMark : public StackObj {
         DCmd* const _ref;
         public:
           DCmdMark(DCmd* cmd) : _ref(cmd) {}
           ~DCmdMark() { if (_ref != NULL) { _ref->cleanup(); if (_ref->is_heap_allocated()) delete _ref; } }
       };
     答案方向: DCmdMark 在栈上构造——即使 execute() 抛出异常（THROW_MSG → longjmp）,
     栈展开会调用 ~DCmdMark() → cleanup() 回收参数资源 + delete 命令对象。
     没有 DCmdMark → exception path 泄漏 ResourceObj 和参数内存。

  ② ★ 如果 DCmd::execute() 触发 GC（safepoint），DCmdMark 析构会被跳过吗？
     答案方向: 不会。GC 在 safepoint 内执行——VMThread 在 safepoint 中调用 VM_Operation::
     doit()。JavaThread 在 safepoint 阻塞——调用栈完整保留。GC 完成 → VMThread 释放
     safepoint → JavaThread 继续 execute() → 返回 → 栈展开 → ~DCmdMark() 执行。
     GC 不破坏栈——DCmdMark 在栈上安全。

  ③ DCmdMark 和 VM_Operation 的 Scope 级别对比？
     答案方向: DCmdMark 在 JavaThread 栈帧层——比 VM_Operation 轻两级。VM_Operation
     需要入队 + ticket + safepoint 同步；DCmdMark 只是本地 RAII。
```

### 4.4 ★★ DCmdParser 参数解析——为什么不用 strtok？

```
问题：
  ① DCmdParser vs strtok 的根本差异是什么？
     线索: diagnosticFramework.hpp:203-226
     答案方向: DCmdParser 提供类型化参数校验：
     - DCmdArgument<T> 模板支持 DT_STRING, DT_INT, DT_BOOL, DT_VMFLAG 等类型
     - 可选参数、必填参数、默认值的声明式配置
     - 参数名 → 值的映射（不是位置索引）
     - 错误信息包含参数名和期望类型——对 jcmd 用户友好
     strtok 只能做纯字符串分割，无类型校验、无默认值。

  ② parse() 内部做了什么？
     线索: diagnosticFramework.hpp:217-218
     答案方向: DCmdParser::parse(CmdLine* line, char delim, TRAPS)
     → 按 delim 分割 tokens → 对每个 token 匹配参数名（-name=value 或 value）
     → 调用 GenDCmdArgument::parse_value() 做类型转换 → 标记 _is_set = true
     → check(TRAPS) 验证所有必填参数已 set。
```

### 4.5 ★★ 典型 DCmd 走读——4 个代表性命令

```
问题：
  ① ThreadDumpDCmd (Thread.print) 的执行路径是什么？
     线索: diagnosticCommand.hpp:448-470, diagnosticCommand.cpp（实现）
     答案方向: ThreadDumpDCmd::execute() → ThreadService::dump_all_threads()
     → ★ 需要 safepoint（遍历所有线程栈需要一致性）→ VMThread 介入。

  ② ClassHistogramDCmd (GC.class_histogram) 的执行路径是什么？
     线索: diagnosticCommand.hpp:359-380
     答案方向: ClassHistogramDCmd::execute() → SystemDictionary::classes_do()
     → ★ 需要 safepoint（SystemDictionary 必须不改变）

  ③ VMInfoDCmd (VM.info) 的执行路径是什么？
     线索: diagnosticCommand.hpp:243-255
     答案方向: VMInfoDCmd::execute() → VMError::print_vm_info(outputStream*)
     → ★ 不需要 safepoint——只打印 VM 配置和内存布局

  ④ NMTDCmd (VM.native_memory) 的执行路径是什么？
     线索: nmtDCmd.hpp:38-72
     答案方向: NMTDCmd::execute() → MemTracker::report()
     → 不需要 safepoint——只读统计计数器（原子操作保护）

  ⑤ 哪些命令需要 safepoint？为什么？
     遍历 SystemDictionary、线程栈 dump → 需要 safepoint（数据一致性）
     打印配置、读统计 → 不需要 safepoint
```

### 4.6 ★ 和 JMX DiagnosticCommandMBean 的对接——同一框架两个入口

```
问题：
  ① DiagnosticCommandImpl MXBean 怎么转发到 DCmd？
     线索: management.cpp → DCmd::parse_and_execute(DCmd_Source_MBean, ...)
     答案方向: JMX MBean 的 invoke() 方法调用 DCmd::parse_and_execute()，
     和 Attach 路径共用完全同一套框架——只有 source 标签不同。
     DCmd_Source_MBean 决定：(a) 只允许单命令；(b) 不同 export_flags 过滤。

  ② DCmdFactory::send_notification() 是什么？
     线索: diagnosticFramework.cpp:445-492
     答案方向: 新命令注册后 → push_jmx_notification_request()
     → ServiceThread 唤醒 → send_notification_internal() → 通过
     JavaCalls::call_virtual 调用 DiagnosticCommandImpl 的
     createDiagnosticFrameworkNotification() → JMX client 收到 MBean 变更通知。
```

## 五、文章结构

```
§〇 源文件清单（跨 services 模块，标注每文件在 DCmd 框架中的角色）

§一 ★★★ DCmdFactory 注册链——单向链表 + 头插法
  ❓ 为什么 40+ 命令用线性搜索而不是 hash map？
  ❓ 注册时机是什么？静态构造顺序有保证吗？
  1.1 _DCmdFactoryList 全局链表结构
  1.2 register_DCmdFactory() 的头插法（行 513-522）
  1.3 DCmdRegistrant::register_dcmds() 批量注册（行 69）
  1.4 DCmdFactoryImpl<T> 模板——编译期绑定命令名和实现类

§二 ★★★ DCmd::parse_and_execute() 全路径——9 步命令执行
  ❓ JMX 和 Attach 路径有什么行为差异？
  ❓ 多命令（'\n' 分隔）和单命令的区别？
  2.1 DCmdIter 分割多命令
  2.2 create_local_DCmd → factory() 线性搜索（行 496-511）
  2.3 DCmdMark RAII 保护（行 326-337）
  2.4 command->parse() → DCmdParser 参数解析
  2.5 command->execute() → 具体命令逻辑

§三 ★★ DCmdMark RAII——为什么不能省略
  ❓ 如果 execute() 触发 GC，DCmdMark 析构会被跳过吗？
  ❓ 和 VM_Operation 的 Scope 级别对比
  3.1 StackObj 基类——栈分配保证
  3.2 cleanup() + delete 的异常安全
  3.3 GC 嵌套不会破坏栈——DCmdMark 始终析构

§四 ★★ DCmdParser 参数解析模型
  ❓ 为什么需要类型化参数系统？strtok 不够吗？
  4.1 GenDCmdArgument + DCmdArgument<T> 模板
  4.2 parse() / check() — 解析 + 必填验证
  4.3 和 attach 协议层（\0 分隔）的对比——两个分层

§五 ★★ 4 个代表性 DCmd 走读
  ❓ 哪些命令需要 safepoint？为什么？
  5.1 ThreadDumpDCmd → ThreadService::dump_all_threads() ★ safepoint
  5.2 ClassHistogramDCmd → SystemDictionary::classes_do() ★ safepoint
  5.3 VMInfoDCmd → print_vm_info() 不需要 safepoint
  5.4 NMTDCmd → MemTracker::report() 不需要 safepoint

§六 ★ JMX MBean 对接 + 和 [10-01] 的连接
  ❓ DiagnosticCommandImpl 怎么和 DCmd 共用一套框架？
  6.1 DCmd_Source_MBean vs DCmd_Source_AttachAPI
  6.2 send_notification() 的 JMX 事件推送
  6.3 和 [10-01] jcmd() 调用点的精确连接

§七 GDB 验证 + 可证伪断言
```

## 六、写作要求

1. **★ `factory()` 的线性搜索是第一个"意外"**：读者可能预期 hash map——回答"为什么不"比搜索本身更重要。把"40 个命令 × 线性扫描 vs hash map O(1) + 内存开销"的权衡说清楚。

2. **★ `DCmdMark` RAII 是第二关键交付物**：必须解释异常路径（THROW_MSG → longjmp → 栈展开 → ~DCmdMark）和正常路径的 cleanup 等效性。这是 C++ 异常安全的核心模式。

3. **★ `DCmd::parse_and_execute()` 的 9 步调用链必须可视化**：ASCII 流程图，每步标注线程身份（JavaThread vs VMThread）和是否持有锁。

4. **★ 和 [10-01] 的桥梁必须精确**：`jcmd()` (:202) → `DCmd::parse_and_execute(DCmd_Source_AttachAPI, ...)` → 这是两篇文档的连接点。

5. **★ `DCmdFactoryImpl<T>` 模板的角色不能省略**：`register_DCmdFactory(new DCmdFactoryImpl<ThreadDumpDCmd>(...))` 是静态构造 + 模板实例化——不解释这个，注册链就不完整。

6. **★ 4 个代表命令只展示执行路径**：不需要解释 ThreadService 的内部实现（那是 [07-thread] 或后续服务的）。只标注 "这个命令触发了什么系统调用，需要 safepoint 吗？"

7. **★ `DCmdRegistrant` 是 `Management` 的 friend 这一耦合点**：为什么命令注册必须和 Management 绑定？能不能在 AttachListener 启动时独立注册？这是 README §八 的深层问题之一，必须在 §一 或 §六 回答。

## 七、输出格式

- Markdown 文件，命名为 `02-DCmd-Diagnostic-Commands.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/10-services-diag/`
- 元信息头：
  ```
  > **阶段**：[10-services-diag]
  > **前置**：[10-01], [08-safepoint]
  > **依赖本文**：[10-03], [10-04]
  > **阅读收益**：理解 jcmd 40+ 诊断命令的注册/调度全链路——DCmdFactory 链表注册、parse_and_execute 的 9 步流程、DCmdMark RAII 异常安全
  ```

## 禁止行为

- ❌ 解释 jcmd 命令行的语法（`jcmd <PID> <command> [options]`）——那是 jcmd 使用手册的内容，和本文的"DCmd 框架机制"无关
- ❌ 深入每个 DCmd 命令的业务逻辑（ThreadDumpDCmd 怎么遍历线程栈）——只需标注"调用 ThreadService::dump_all_threads()"和"需要 safepoint"，内部细节是 [07-thread] 或 JMX 层的内容
- ❌ 解释 JMX MBean Server 的注册机制（`ManagementFactory.getPlatformMBeanServer()` 怎么注册 MBean）——那属于 `management.cpp` 的 JMX 层，本文只关心 JMX 怎么转发到 DCmd
- ❌ 把 `diagnosticCommand.cpp` 的 40+ `register_DCmdFactory` 调用当列表翻译——分类即可（诊断类、GC 类、线程类、VM 配置类、NMT 类），一行一个同类
- ❌ 深入解析 `DCmdArgument<T>` 模板的每个类型特化（DT_VMFLAG 怎么解析、DT_STRING 怎么转义）——这些是参数系统的实现细节，不是框架主线
- ❌ 忘记 [10-01] 的 `jcmd()` 桥接——不从 `jcmd()` (:202) 开始讲 DCmd，直接讲 `parse_and_execute()` 是不完整的
- ❌ 把 `DCmdMark` 当成"只是 RAII"一笔带过——必须解释异常路径（THROW_MSG → longjmp）和正常路径的等效 cleanup 行为
- ❌ 不做 `factory()` 的 O(n) vs hash map 对比——这个问题涉及"诊断框架的设计哲学"（简单性 > 极致性能），比源码注释更重要
- ❌ 忽略 `DCmdFactoryImpl<T>` 模板的角色——`register_DCmdFactory(new DCmdFactoryImpl<ThreadDumpDCmd>(...))` 如果不解释，注册链就不完整
- ❌ 不做 DCmd 和 VM_Operation 的对比——部分 DCmd 命令需要 safepoint（通过 VM_Operation 的间接路径），本文需要标注但引用 [08-safepoint]

## 要求行为

- ✅ **★ `_DCmdFactoryList` 单向链表图**：ASCII 图展示 40+ factory 节点的 `_next` 指针链，标注头插法和遍历方向
- ✅ **★ `DCmd::parse_and_execute()` 9 步调用流程图**：ASCII 流程图，每步标注线程身份 + 持有锁 + 行号
- ✅ **★ `DCmdMark` 的异常安全示意图**：正常路径→cleanup→delete 和异常路径→栈展开→~DCmdMark→cleanup→delete 对比
- ✅ **★ `DCmdFactory::factory()` 线性搜索代码**：展示 `while (factory != NULL) { strlen + strncmp }` 循环，标注 O(n)
- ✅ **★ 和 [10-01] §五 jcmd() 的精确连接**：行 202-216 → `DCmd_Source_AttachAPI` → `parse_and_execute()`，标注"这是 Attach 管道到 DCmd 的桥梁"
- ✅ **★ 4 个代表命令表**：`Thread.print / GC.class_histogram / VM.info / VM.native_memory` → 各标注 (a) 调用链终点 (b) 需要 safepoint? (c) 影响级别
- ✅ **★ `DCmdSource` 三值的行为差异表**：`DCmd_Source_AttachAPI / DCmd_Source_MBean / DCmd_Source_Internal` → 能否多命令、权限检查、export_flags 过滤
- ✅ **★ `DCmdParser` 参数类型表**：`DT_STRING, DT_INT, DT_BOOL, DT_VMFLAG, DT_MEM_TYPE` 等，标注各类型的校验方式
- ✅ **★ 注册时机的时间线**：`Management::initialize() → DCmdRegistrant::register_dcmds() → 40+ register_DCmdFactory → send_notification() → JMX MBean 更新`
- ✅ **★ 和 [10-01] + [10-03] 的连接标注**：`jcmd()` 入口来自 [10-01]；`ThreadDumpDCmd` 的 sink 流到 ThreadService（与 [10-03] 的 MemoryService 同为服务层）

## GDB 可证伪断言

1. **断言：`_DCmdFactoryList` 是有效的单向链表**
   验证：`jcmd <PID> help` → 挂上 `br diagnosticFramework.cpp:381` → `p DCmdFactory::_DCmdFactoryList` → 确认非 NULL → `p DCmdFactory::_DCmdFactoryList->_next` 遍历链表
   预期：链表至少有 20+ 节点，包含已知命令名

2. **断言：`factory()` 线性搜索成功返回匹配的 factory**
   验证：`br diagnosticFramework.cpp:499` → `p name` → 确认命令名字符串 → `finish` 继续 → 循环出口 `factory != NULL`
   预期：`strncmp(name, factory->name(), len) == 0` 成功匹配

3. **断言：`register_DCmdFactory()` 头插法成功**
   验证：`br diagnosticFramework.cpp:515` → `p factory->_next` → 存储旧的 `_DCmdFactoryList` → `p DCmdFactory::_DCmdFactoryList` → 现在等于新 factory
   预期：`factory->_next == old_list_head` 且 `_DCmdFactoryList == factory`

4. **断言：`DCmd::parse_and_execute()` 多命令 '\n' 分隔生效**
   验证：`br diagnosticFramework.cpp:391` → `p iter.has_next()` → 第 1 次 true（第一个命令）→ 第 2 次 true（第二个命令）→ 第 3 次 false
   预期：`while(iter.has_next())` 循环次数 = 命令数

5. **断言：JMX 路径拒绝多命令**
   验证：通过 JMX MBean 发送两个 '\n' 分隔的命令 → `br diagnosticFramework.cpp:392` → `source == DCmd_Source_MBean` 且 `count > 0` → THROW_MSG
   预期：exception "Invalid syntax" 抛出

6. **断言：`DCmdMark` 在正常执行后析构**
   验证：`br diagnosticFramework.hpp:331` （~DCmdMark 的第一行） → `p _ref` → 非 NULL → `bt` → 确认是从 `parse_and_execute` 栈展开调用
   预期：`_ref` 指向刚才 create 的 DCmd 对象，cleanup() 被调用

7. **断言：`ThreadDumpDCmd::execute()` 需要 safepoint**
   验证：`br <ThreadDumpDCmd::execute 行号>` → 单步进入 → 观察是否触发 `VMThread::execute()` → `bt` 展示 VMThread 执行栈
   预期：执行路径经过 VM_Operation 或 safepoint 同步

8. **断言：`DCmdFactory::create_local_DCmd()` 返回的是 ResourceObj（非堆分配）**
   验证：`br diagnosticFramework.cpp:532` → `p f->is_heap_allocated()` → 查看 `DCmdFactoryImpl<T>::create_resource_instance` 是否调用 `new (ResourceObj::C_HEAP, mtInternal) T(...)`
   预期：根据命令不同，`is_heap_allocated()` 可能为 false（ResourceObj）——由 DCmdMark 的析构决定 delete 还是忽略

9. **断言：`Management::initialize()` 中 `register_dcmds()` 被调用**
   验证：`JVM -XX:+PauseAtStartup` → attach gdb → `br management.cpp:148` → `continue` → 断点命中 → `n` 单步进入 `DCmdRegistrant::register_dcmds()`
   预期：断点在 VM 初始化阶段命中

10. **断言：`DCmdFactory::send_notification()` 通知 JMX MBean**
    验证：`br diagnosticFramework.cpp:464`（`Management::com_sun_management_internal_DiagnosticCommandImpl_klass` 调用） → 确认 JavaCall 成功 → `p m` 非 NULL
    预期：`dcmd_mbean_h->is_a(k)` 返回 true

11. **断言：`DCmdParser::parse()` 按 delim 分割参数**
    验证：`br` 在 `DCmdParser::parse` → 发送 `jcmd <PID> Thread.print -l=true` → `p tokens` → 展示 `["-l=true"]` 已分割
    预期：`-l` 映射到 `DCmdArgument<bool> _locks` 并设置 `_locks._value = true`

12. **断言：`DisableAttachMechanism=true` 时 jcmd 仍可通过 JMX 执行 DCmd**
    验证：启动 JVM `-XX:+DisableAttachMechanism` → 通过 JMX MBean 执行 `GC.class_histogram` → `br diagnosticFramework.cpp:385` → 断点命中（Attach 路径不可用但 JMX 路径可用）
    预期：`source == DCmd_Source_MBean` 的断点命中，`source == DCmd_Source_AttachAPI` 不命中
