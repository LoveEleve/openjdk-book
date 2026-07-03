# 4.2 management_init — JVM 管理 API 的 C++ 侧地基

4.1 节给出了 `init_globals()` 的 30 项全貌。本节展开第一项 `management_init()`——它是 `HandleMark hm` 之后的第一行，为 JVM 的"管理 API"铺 C++ 侧地基。

`management_init()` 本身只有 10 行，但它背后是一整个"JVM 管理"子系统。在进入源码之前，必须先搞清楚一个根本问题：**"management" 这个词在 HotSpot 里到底是什么意思？**

---

## "management" 到底是干什么的

这不是 HotSpot 自己发明的概念，而是一个正式的 Java 规范——**JSR 174：Monitoring and Management Specification for the Java Virtual Machine**（2004 年 9 月最终发布，从 J2SE 5.0 开始进入 JDK）。

### JSR 174 官方定义

JSR 174 的标题是 "Monitoring and Management Specification for the Java Virtual Machine"。官方在 "Request" 章节把 management 的职责明确分为**两大类**：

> **Health Indicators（健康指标）** —— 让 Java 应用、系统管理工具、RAS 工具能监控 JVM 的健康状态：
> - Class load/unload（类加载/卸载）
> - Memory allocation statistics（内存分配统计）
> - Garbage collection statistics（GC 统计）
> - Monitor info & statistics（监视器信息和统计）
> - Thread info & statistics（线程信息和统计）
> - Just-in-Time statistics（JIT 编译统计）
> - Object info（堆中对象信息，show/count all objects）
> - Underlying OS and platform info（底层 OS 和平台信息）
>
> **Run-Time Control（运行时控制）** —— 让工具能动态调整 JVM 的运行时行为：
> - Minimum heap size（最小堆大小）
> - Verbose GC on demand（按需打开 GC verbose）
> - Garbage collection control（GC 控制，如触发 System.gc）
> - Thread creation control（线程创建控制）
> - Just-in-Time compilation control（JIT 编译控制）

JSR 174 还规定了几个**设计原则**：
- **Very low performance impact**——即使监控事件开启，性能影响也要极低
- **Restricted to low frequency events**——只支持低频事件，不做高频采样
- **Interface should be self describing**——接口自描述，不需要静态绑定
- **Mandatory and optional set**——分为强制支持和可选支持的能力

### Java 侧的 API：java.lang.management 包

JSR 174 在 Java 侧落地为 `java.lang.management` 包（Oracle 官方文档原文）：

> "Provides the management interfaces for monitoring and management of the Java virtual machine and other components in the Java runtime. It allows both local and remote monitoring and management of the running Java virtual machine."
>
> —— `java.lang.management` package summary

这个包提供 9 个标准 MXBean 接口（每个对应 JVM 的一个子系统）：

| MXBean 接口 | 管 JVM 的哪部分 |
|-------------|----------------|
| `ClassLoadingMXBean` | 类加载系统 |
| `MemoryMXBean` | 内存系统 |
| `ThreadMXBean` | 线程系统 |
| `RuntimeMXBean` | 运行时系统 |
| `OperatingSystemMXBean` | 底层操作系统 |
| `CompilationMXBean` | JIT 编译系统 |
| `GarbageCollectorMXBean` | 垃圾收集器 |
| `MemoryManagerMXBean` | 内存管理器 |
| `MemoryPoolMXBean` | 内存池 |

用户代码通过 `ManagementFactory.getClassLoadingMXBean()` 等静态方法获取这些 MXBean。

### 三类能力对应 JSR 174 的两大类

把 JSR 174 的 "Health Indicators" 和 "Run-Time Control" 拆到代码层面，对应三类操作：

| 能力类型 | JSR 174 分类 | 做什么 | 典型例子 |
|---------|-------------|--------|---------|
| **读**（查询） | Health Indicators | 查询 JVM 当前状态，返回数据，不改变任何东西 | `getThreadCount()` 查线程数 / `getHeapMemoryUsage()` 查堆使用量 / `getLoadedClassCount()` 查类加载数 |
| **写**（修改配置） | Run-Time Control | 修改 JVM 运行时配置/开关，返回旧值 | `setVerbose(true)` 打开详细输出（verbose 是"啰嗦"的意思，让 JVM 多打印日志，如 `-verbose:gc` 每次都打印 GC 详情） / `setThreadCpuTimeEnabled(true)` 开启 CPU 时间统计 / `setUsageThreshold(N)` 设置内存告警阈值 |
| **触发动作**（执行一次性操作） | Run-Time Control | 让 JVM 立即干一件事，有副作用 | `gc()` 触发一次 GC / `dumpHeap()` 堆转储到文件 / `findDeadlockedThreads()` 死锁检测 / `resetPeakThreadCount()` 重置峰值 |

读者第一反应往往是"监控/观察 JVM"——这只覆盖了 "Health Indicators"（读）那一类。读到后面出现的"操作 JVM"其实属于 "Run-Time Control"（写+触发动作）——这两类都是 JSR 174 规范定义的 management 的职责。`management_init` 同时为这三类能力铺地基。

### 一个具体的场景：你作为运维和开发会做什么

假设你写了个 Java 程序跑着：

```java
public class MyApp {
    public static void main(String[] args) throws Exception {
        while (true) {
            Thread.sleep(1000);
            System.out.println("running...");
        }
    }
}
```

`java MyApp` 启动后进程在后台跑。你作为运维/开发会对这个 JVM 做**三类不同的事**（对应 JSR 174 的两大类）：

**1. 想知道它现在状态如何（读 → Health Indicators）**：
- 它跑了多久了？
- 加载了多少个类？
- 堆用了多少内存？
- 现在有多少线程？
- GC 触发了几次？每次多久？

**2. 想调整它的运行时配置（写 → Run-Time Control）**：
- 打开 `-XX:+PrintGC` 让它打印每次 GC 信息
- 打开线程竞争监控看哪些线程在锁上等待
- 给老年代设一个使用率阈值，超过 80% 就告警

**3. 想让它立即干件事（触发动作 → Run-Time Control）**：
- 强制触发一次 GC（`System.gc()`）
- 把整个堆转储到文件分析内存泄漏
- 打印所有线程的栈看有没有死锁
- 重置线程数峰值统计

这三类操作对应 HotSpot management 子系统提供的 40+ 个 jmm 接口函数（读/写/触发动作）和 40+ 个 DCmd 诊断命令。`management_init` 就是给这些能力的 C++ 侧铺地基。

### 三类操作各自走哪条通道

上面三类操作，JDK 给了多种工具和 API 让你能发起：

**方式一：命令行工具**（`JAVA_HOME/bin/` 下）

| 工具 | 用途 | 典型用法 | 能力类型 |
|------|------|---------|---------|
| `jps` | 列出所有 Java 进程 | `jps -l` | 读 |
| `jstat` | 实时监控 GC / 类加载 / 编译 | `jstat -gc <pid> 1000` | 读 |
| `jcmd` | 万能诊断命令（可读可写可触发） | `jcmd <pid> Thread.print`（触发） / `jcmd <pid> VM.flags`（读） / `jcmd <pid> VM.set_flag PrintGC true`（写） | 三类都有 |
| `jstack` | 打印线程栈 | `jstack <pid>` | 触发 |
| `jmap` | 堆转储 / 直方图 | `jmap -histo <pid>` | 触发 |
| `jinfo` | 查看/修改 VM flag | `jinfo -flag PrintGC <pid>`（读） / `jinfo -flag +PrintGC <pid>`（写） | 读+写 |

这些工具不需要目标 JVM 改代码——`jstat` 直接读 PerfData 共享内存（本章下文会讲），`jcmd`/`jstack`/`jmap` 通过 attach API 让目标 JVM 执行命令。attach API 的底层原理（`AttachListener` 线程、UNIX socket 通信、`/tmp/.attach_pid<pid>` 握手文件）后续章节会详细展开。

**方式二：图形工具**

| 工具 | 用途 |
|------|------|
| `jconsole` | JMX 图形监控（自带，JDK 9 后从 bin 移到 lib） |
| `jvisualvm` | 堆/CPU/线程图形分析（JDK 9 后独立下载） |
| `JMC` | Java Mission Control，飞行记录分析 |

这些都是 Java 写的图形程序，需要 X11 窗口系统才能显示。Linux 上有三种用法：

1. **本地有桌面环境**（如 GNOME/KDE）— 直接运行 `jconsole <pid>` 即可
2. **远程服务器无桌面** — 通过 `ssh -X user@server` 把图形转发到本地 X server，或在本机用 `jconsole` 通过 JMX 远程连接服务器的 `jmxremote.port`
3. **纯命令行服务器**（无 X11，无 forwarding）— 图形工具用不了，只能用方式一的命令行工具

`jconsole` 连上 JVM 后能自动每秒采样数据画曲线（读）、能打开/关闭 verbose 开关（写）、能点按钮触发堆转储（触发动作）。

**方式三：Java 代码**

Java 代码通过 `java.lang.management` 包（JSR 174 规范）查询和操作 JVM：

```java
import java.lang.management.*;

// === 读操作（Health Indicators）===
long uptime = ManagementFactory.getRuntimeMXBean().getUptime();
int loadedCount = ManagementFactory.getClassLoadingMXBean().getLoadedClassCount();
int threadCount = ManagementFactory.getThreadMXBean().getThreadCount();
MemoryUsage heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();

// === 写操作（Run-Time Control）===
ManagementFactory.getClassLoadingMXBean().setVerbose(true);   // 打开类加载 verbose
ManagementFactory.getThreadMXBean().setThreadCpuTimeEnabled(true);  // 开启 CPU 时间统计

// === 触发动作（Run-Time Control）===
ManagementFactory.getMemoryMXBean().gc();                       // 触发一次 GC
long[] deadlocked = ManagementFactory.getThreadMXBean().findDeadlockedThreads();  // 死锁检测
ManagementFactory.getThreadMXBean().resetPeakThreadCount();     // 重置峰值
```

`ManagementFactory` 提供 `getXxxMXBean()` 静态方法返回 "MXBean" 对象——每个 MXBean 对应一类 JVM 状态（ThreadMXBean 管线程、MemoryMXBean 管内存、ClassLoadingMXBean 管类加载等）。

---

## management_init 在这个体系里扮演什么角色

上面三种方式——命令行工具、图形工具、Java 代码——它们的**数据从哪里来**？

答案：**全部最终来自 HotSpot 的 C++ 层**。

但具体怎么从 C++ 传到 Java / 外部工具，有两条不同的通道：

### 通道 A：PerfData 共享内存（ch03/05 已创建，management_init 来填数据）

ch03/05 的 `perfMemory_init` 创建了一个文件 `/tmp/hsperfdata_<user>/<pid>`（在 `tmpdir` 下，名字是 JVM 进程 PID），用 `mmap` 映射到 JVM 进程的虚拟地址空间。这个文件就是 PerfData 共享内存——JVM 往里写数据，外部工具 mmap 同一个文件读出来。

```
JVM 进程                                外部工具（jstat）
┌──────────────────────────┐           ┌──────────────────┐
│ management_init()        │           │                  │
│ 注册 22 个计数器          │           │  open + mmap     │
│   ↓ PerfDataManager      │           │   /tmp/hsperf..  │
│   ↓ create_counter       │           │     ↑            │
│   ↓ 写入共享内存地址      │←──────────│  读同一片内存     │
│                          │  共享内存  │                  │
│ /tmp/hsperfdata_xxx/12345│           │  零系统调用      │
└──────────────────────────┘           └──────────────────┘
```

**关键点**：通道 A 是**被动的**——JVM 往共享内存写完就完事，外部工具随时来读，**不需要 JVM 进程配合**。这就是 `jstat` 高频采样不卡 JVM 的原因。

但 PerfData 共享内存里目前还是空的——`perfMemory_init` 只建了"仓库"（文件 + mmap），还没往里放数据。`management_init` 就是第一批往里放数据的——22 个 PerfData 计数器（线程数、类加载数、safepoint 统计等）。后续 `universe_post_init`、`compileBroker_init` 等还会继续往里加。

### 通道 A 解决不了的问题

通道 A 看起来很完美——零开销、被动读、不卡 JVM。但它有根本限制：**共享内存里只能放简单数值**。

考虑这几个用例：

| 用例 | 通道 A 能做吗？ | 为什么 |
|------|----------------|--------|
| 读当前活线程数 | 能（一个 int） | 计数器就是简单数值 |
| 读当前堆使用了多少字节 | 能（一个 long） | 计数器 |
| 检测当前有没有死锁 | **不能** | 要遍历所有线程的锁关系图，不是读一个数 |
| 打印所有线程的栈 | **不能** | 要遍历线程 + 读每个线程的栈帧，输出大段文本 |
| 触发一次 GC | **不能** | 这是"让 JVM 干件事"，不是"读个数" |
| 转储整个堆到文件 | **不能** | 复杂操作 + 大量数据 |

通道 A 是"被动的、只读的、单值查询"——它把 JVM 状态压扁成一个个数字。但监控和诊断经常需要"让 JVM 主动干件事"或"查询复杂结构化数据"——这就要求**每次操作都进 JVM 执行 C++ 代码**，按需返回结果。

### 通道 B：Java 代码主动调 JVM 干活

通道 B 解决的就是"让 JVM 干件事"。它不是走共享内存，而是**走函数调用**——Java 代码发起调用，进 JVM 执行 C++ 函数，返回结果。

还是用前面"观察 JVM"的 Java 代码例子：

```java
int threadCount = ManagementFactory.getThreadMXBean().getThreadCount();
```

这行代码背后发生了什么？`getThreadCount()` 不是读共享内存——它最终调用到 HotSpot C++ 侧的 `ThreadService`，读取那个 `_live_threads_count` 计数器（就是通道 A 注册的同一个计数器）返回。

具体调用链（简化）：

```
你的 Java 代码
  └─ ThreadMXBean.getThreadCount()                      Java 接口方法
       └─ ThreadImpl.getThreadCount()                     Java 实现类
            └─ native getThreadCount()                    JNI native 方法
                 └─ libmanagement.so 里的 C 函数          JVM 入口
                      └─ 通过 jmm_interface 函数表查表     函数指针调用
                           └─ jmm_GetLongAttribute(...)   HotSpot C++ 函数
                                └─ 读 _live_threads_count 的值  最终数据源
```

前 4 层都是 Java/JNI 世界的常规代码——Java 接口、Java 实现类、native 方法、JNI 入口。关键是第 5 步那个"**jmm_interface 函数表**"——这是 Java 世界和 C++ 世界之间的桥梁。

**为什么需要函数表？** Java 代码不能直接调 C++ 函数（JNI 规范决定的）。`libmanagement.so`（JDK 自带的 native 库）在加载时通过 `JVM_GetManagement()` 一次性拿到 HotSpot 提供的函数指针表，之后每次调用都通过这个表的某个函数指针进 JVM。`jmm_interface` 就是这个函数指针表——约 40 个函数指针，每个对应一类操作（读计数器、读线程信息、找死锁、堆转储等）。

**为什么叫"主动"通道？** 和通道 A 对比就清楚了：

| 维度 | 通道 A（PerfData 共享内存） | 通道 B（jmm_interface 函数表） |
|------|---------------------------|------------------------------|
| 谁发起 | 外部工具主动读 | Java 代码主动调 |
| 是否进 JVM | 不进，直接读 mmap | 进 JVM 执行 C++ 函数 |
| 能做什么 | 只能读简单数值 | 任何事（死锁检测、堆转储、触发 GC） |
| 开销 | 零（读内存） | JNI 调用开销 |
| 谁走这条路 | jstat、jcmd PerfCounter.print | jconsole、Java 代码、jcmd（大部分命令） |

**management_init 同时为两条通道做准备**：
- 注册 22 个 PerfData 计数器 → 给通道 A（让 jstat 能读到数）
- 初始化能力位 + 注册 DCmd → 给通道 B（让 Java/jcmd 能调命令）

通道 A 的数据已经讲清楚了（22 个计数器）。通道 B 涉及的能力位和 DCmd 在下文 `Management::init()` 详解里展开。

---

## management_init 全貌源码

```cpp
/* === src/hotspot/share/services/management.cpp === */

void management_init() {
  Management::init();
  ThreadService::init();
  RuntimeService::init();
  ClassLoadingService::init();
}
```

四个 `init()` 的分工：

| 函数 | 职责 | 注册的 PerfData 数 |
|------|------|-------------------|
| `Management::init()` | 3 个时间戳 PerfVariable + 9 个能力位 + 40+ DCmd 注册 | 3 |
| `ThreadService::init()` | 线程计数（live/peak/daemon/started） | 4 |
| `RuntimeService::init()` | safepoint 统计 + jvmVersion 常量 + jvmCapabilities 串 | 6 |
| `ClassLoadingService::init()` | 类加载/卸载计数 + 字节数 | 9 |
| **合计** | | **22** |

这 22 个 PerfData 计数器就是通道 A 第一批填进共享内存的数据，也是后续 `jstat` 能读到的东西。`Management::init()` 还额外做了能力位和 DCmd 注册（给通道 B）。下面逐个展开。

---

## Management::init() — 时间戳 + 能力位 + DCmd 注册

```cpp
/* === src/hotspot/share/services/management.cpp === */

void Management::init() {
  EXCEPTION_MARK;

  // 1. 创建 3 个 PerfVariable 计时器
  _begin_vm_creation_time =
            PerfDataManager::create_variable(SUN_RT, "createVmBeginTime",
                                             PerfData::U_None, CHECK);
  _end_vm_creation_time =
            PerfDataManager::create_variable(SUN_RT, "createVmEndTime",
                                             PerfData::U_None, CHECK);
  _vm_init_done_time =
            PerfDataManager::create_variable(SUN_RT, "vmInitDoneTime",
                                             PerfData::U_None, CHECK);

  // 2. 初始化 _optional_support（9 个能力位）
  _optional_support.isLowMemoryDetectionSupported = 1;
  _optional_support.isCompilationTimeMonitoringSupported = 1;
  _optional_support.isThreadContentionMonitoringSupported = 1;
  if (os::is_thread_cpu_time_supported()) {
    _optional_support.isCurrentThreadCpuTimeSupported = 1;
    _optional_support.isOtherThreadCpuTimeSupported = 1;
  } else {
    _optional_support.isCurrentThreadCpuTimeSupported = 0;
    _optional_support.isOtherThreadCpuTimeSupported = 0;
  }
  _optional_support.isObjectMonitorUsageSupported = 1;
#if INCLUDE_SERVICES
  _optional_support.isSynchronizerUsageSupported = 1;
#endif
  _optional_support.isThreadAllocatedMemorySupported = 1;
  _optional_support.isRemoteDiagnosticCommandsSupported = 1;

  // 3. 注册诊断命令
  DCmdRegistrant::register_dcmds();
  DCmdRegistrant::register_dcmds_ext();
  uint32_t full_export = DCmd_Source_Internal | DCmd_Source_AttachAPI
                         | DCmd_Source_MBean;
  DCmdFactory::register_DCmdFactory(
      new DCmdFactoryImpl<NMTDCmd>(full_export, true, false));
}
```

三件事：创建计时器、声明能力位、注册 DCmd。

### 1. 3 个 PerfVariable 计时器

这三个计数器记录 JVM 启动的三个关键时间戳（都是绝对时间，单位毫秒）。创建方式和 ch03/06 节讲过的 `ObjectMonitor::Initialize()` 完全一样——都是调用 `PerfDataManager::create_variable()`，在 ch03/05 创建的 PerfData 共享内存里分配一个 `PerfDataEntry`（填头部 + 数据区），`_valuep` 直接指向共享内存数据区，后续写入零系统调用。本节不再重复 PerfDataEntry 的创建细节，只列计数器清单和运行时含义：

| 计数器全名 | 写入时机 | 含义 |
|-----------|---------|------|
| `sun.rt.createVmBeginTime` | `TraceVmCreationTime::end()` | `Threads::create_vm` 开始时间 |
| `sun.rt.createVmEndTime` | 同上 | `Threads::create_vm` 结束时间 |
| `sun.rt.vmInitDoneTime` | `set_init_completed()` 之后 | VM 初始化完成时间 |

`RuntimeMXBean.getStartTime()` 返回的就是 `vmInitDoneTime`。`createVmBeginTime` 和 `createVmEndTime` 这两个计数器的值由 `TraceVmCreationTime` 填入——ch03/02 讲过，`Threads::create_vm` 末尾会显式调用 `create_vm_timer.end()`（`thread.cpp:4080`），`end()` 调用 `Management::record_vm_startup_time(begin, duration)`（`management.cpp:200`），把启动开始时间和总耗时写到对应的 PerfVariable：

```cpp
/* === src/hotspot/share/services/management.cpp:200-208 === */

void Management::record_vm_startup_time(jlong begin, jlong duration) {
  if (_begin_vm_creation_time == NULL) return;   // PerfData 未初始化（vm init 失败）
  _begin_vm_creation_time->set_value(begin);              // 写入 createVmBeginTime
  _end_vm_creation_time->set_value(begin + duration);    // 写入 createVmEndTime
  PerfMemory::set_accessible(true);                       // 允许外部工具 mmap 读
}
```

注意最后一行 `PerfMemory::set_accessible(true)`——直到这一刻，PerfData 共享内存才对外部工具开放读取。ch03/05 创建了共享内存文件，但直到这里（`create_vm` 末尾，`end()` 被调用）才标记可读——保证外部工具读到的是完整的、已填好的计数器。

### 2. 9 个能力位（jmmOptionalSupport）

通道 B 的 Java 层（`VMManagementImpl`）在初始化时会问 HotSpot："你支持哪些监控能力？"——HotSpot 用 `_optional_support` 这个结构体回答。9 个布尔位：

| 能力位 | 设置条件 | 提供的能力 | 对应的 Java API |
|--------|---------|----------|----------------|
| `isLowMemoryDetectionSupported` | 恒为 1 | **低内存告警**：给内存池设一个使用率阈值（如老年代 80%），超过后自动触发通知。背后的 `LowMemoryDetector` 在 Service 线程中检查阈值，通过 `Sensor`（Java 侧的告警器）通知注册的监听器 | `MemoryPoolMXBean.setUsageThreshold(long)` / `isUsageThresholdExceeded()` |
| `isCompilationTimeMonitoringSupported` | 恒为 1 | **JIT 编译耗时查询**：能查到 JVM 累计花了多少毫秒做 JIT 编译 | `CompilationMXBean.getTotalCompilationTime()` |
| `isThreadContentionMonitoringSupported` | 恒为 1 | **线程竞争统计**：开启后能查到每个线程在锁上等待了多久、多久进过 synchronized 块。默认关闭，开启有性能开销 | `ThreadMXBean.setThreadContentionMonitoringEnabled(true)` / `getThreadInfo(id).getBlockedTime()` |
| `isCurrentThreadCpuTimeSupported` | `os::is_thread_cpu_time_supported()` | **当前线程 CPU 时间**：查当前线程累计用了多少 CPU 时间（纳秒）。依赖 OS 支持——某些嵌入式平台不支持 | `ThreadMXBean.getCurrentThreadCpuTime()` |
| `isOtherThreadCpuTimeSupported` | 同上 | **其他线程 CPU 时间**：查任意指定线程的 CPU 时间，不只是当前线程。同样依赖 OS | `ThreadMXBean.getThreadCpuTime(long id)` |
| `isObjectMonitorUsageSupported` | 恒为 1 | **ObjectMonitor 使用情况**：`dumpAllThreads` 时能带上每个线程持有了哪些 synchronized 锁（ObjectMonitor）的信息 | `ThreadMXBean.dumpAllThreads(lockedMonitors=true, ...)` |
| `isSynchronizerUsageSupported` | `INCLUDE_SERVICES` | **JSR-166 同步器使用情况**：`dumpAllThreads` 时能带上每个线程持有了哪些 `ReentrantLock`/`ReentrantReadWriteLock` 等 JSR-166 同步器。同时是 `findDeadlockedThreads()`（找死锁，含 Lock 锁的）的前提 | `ThreadMXBean.findDeadlockedThreads()` |
| `isThreadAllocatedMemorySupported` | 恒为 1 | **线程分配内存统计**：查每个线程在 Java 堆上累计分配了多少字节（TLAB 分配量累加）。用于排查哪个线程分配对象最多 | `ThreadMXBean.getThreadAllocatedBytes(long id)` |
| `isRemoteDiagnosticCommandsSupported` | 恒为 1 | **远程诊断命令**：能通过 JMX 远程连接执行 DCmd 诊断命令（如 `Thread.print`、`GC.heap_dump`）。否则只能本地 attach | `DiagnosticCommandMBean` 是否可用 |

几个需要说明的：

**`isCurrentThreadCpuTimeSupported` / `isOtherThreadCpuTimeSupported` 依赖 OS**：HotSpot 调用 `os::is_thread_cpu_time_supported()` 判断——Linux/Windows/macOS 都支持，某些嵌入式平台（如纯 RTOS 移植）可能返回 false。此时两个位为 0，对应的 `ThreadMXBean` 方法返回 -1。这两个位通常同时为 1 或同时为 0。

**`isSynchronizerUsageSupported` 依赖 `INCLUDE_SERVICES`**：这是一个编译期宏，控制是否编译 heap inspector 等服务。标准 JDK 构建都启用，裁剪版可能关闭。它是 `findDeadlockedThreads()`（查找包括 `ReentrantLock` 在内的死锁）的前提——`findMonitorDeadlockedThreads()`（只查 synchronized 锁死锁）不需要这个位。

**`isLowMemoryDetectionSupported` 是个完整子系统**：不是简单的位查询，背后是 `LowMemoryDetector` + `Sensor` 机制——内存池设阈值后，Service 线程定期检查，超过阈值就触发 Java 侧的 `Sensor.trigger()`，`Sensor` 通知所有注册的监听器（如 `MemoryMXBean` 发 `Notification`）。这让 Java 代码能收到"老年代快满了"的主动告警，而不是自己轮询查询。

### 3. DCmd 注册

DCmd（Diagnostic Command，诊断命令）就是 `jcmd` 工具能执行的命令。`jcmd <pid> <命令名>` 背后的执行者就是 DCmd。`DCmdRegistrant::register_dcmds()` 在这里注册了 40+ 个内置命令，例如：

| 命令 | 作用 | 典型调用 |
|------|------|---------|
| `VM.version` | 打印 JVM 版本 | `jcmd <pid> VM.version` |
| `VM.flags` | 打印所有 VM flag | `jcmd <pid> VM.flags` |
| `Thread.print` | 打线程转储（等同 jstack） | `jcmd <pid> Thread.print` |
| `GC.heap_info` | 打印堆信息 | `jcmd <pid> GC.heap_info` |
| `GC.class_histogram` | 堆对象直方图 | `jcmd <pid> GC.class_histogram` |
| `GC.heap_dump` | 堆转储（等同 jmap -dump） | `jcmd <pid> GC.heap_dump /tmp/heap.hprof` |
| `VM.system_properties` | 系统属性 | `jcmd <pid> VM.system_properties` |
| `VM.native_memory` | NMT 内存跟踪 | `jcmd <pid> VM.native_memory summary` |

`Management::init()` 最后还单独注册了 `NMTDCmd`——Native Memory Tracking 命令，因为 NMT 是独立的子系统，不在 `DCmdRegistrant` 里注册。

后面会专门讲 DCmd 的工作机制（谁调用、怎么解析参数、怎么执行）。

---

## ThreadService::init() — 4 个线程计数器

```cpp
/* === src/hotspot/share/services/threadService.cpp === */

void ThreadService::init() {
  EXCEPTION_MARK;

  if (UsePerfData) {
    _total_threads_count =
      PerfDataManager::create_counter(JAVA_THREADS, "started",
                                      PerfData::U_Events, CHECK);

    _live_threads_count =
      PerfDataManager::create_variable(JAVA_THREADS, "live",
                                        PerfData::U_None, CHECK);

    _peak_threads_count =
      PerfDataManager::create_variable(JAVA_THREADS, "livePeak",
                                       PerfData::U_None, CHECK);

    _daemon_threads_count =
      PerfDataManager::create_variable(JAVA_THREADS, "daemon",
                                       PerfData::U_None, CHECK);
  }
}
```

注册 4 个线程相关计数器：

| 计数器全名 | 类型 | 更新时机 |
|-----------|------|---------|
| `java.threads.started` | Counter（单调递增） | 每次新线程加入 `Threads::_thread_list` 时 `inc()` |
| `java.threads.live` | Variable（可增减） | 线程加入时 inc / 线程退出时 dec |
| `java.threads.livePeak` | Variable | 线程加入时若 `count > peak` 则更新 |
| `java.threads.daemon` | Variable | daemon 线程加入/退出时增减 |

Counter 和 Variable 的区别：Counter 只能递增（如累计启动过的线程总数），Variable 可增可减（如当前活着的线程数）。

读者运行 `jstat -threads <pid>` 看到的 Live、Peak、Daemon、Started 列就是这 4 个计数器的值。Java 代码 `ThreadMXBean.getThreadCount()` 返回 `java.threads.live`。

> **注意**：ThreadService 内部还有两个原子计数 `_atomic_threads_count` / `_atomic_daemon_threads_count`（`volatile int`），不写 PerfData，用于 `Thread.join()` 返回前的精确计数——`current_thread_exiting` 提前递减原子计数，PerfData 的 `live` 延迟到 `remove_thread` 才递减。这是 PerfData 路径有延迟，不能用作强同步的例子。

---

## RuntimeService::init() — safepoint 统计

```cpp
/* === src/hotspot/share/services/runtimeService.cpp === */

void RuntimeService::init() {
  if (UsePerfData) {
    EXCEPTION_MARK;

    _sync_time_ticks =
      PerfDataManager::create_counter(SUN_RT, "safepointSyncTime",
                                      PerfData::U_Ticks, CHECK);

    _total_safepoints =
      PerfDataManager::create_counter(SUN_RT, "safepoints",
                                      PerfData::U_Events, CHECK);

    _safepoint_time_ticks =
      PerfDataManager::create_counter(SUN_RT, "safepointTime",
                                     PerfData::U_Ticks, CHECK);

    _application_time_ticks =
      PerfDataManager::create_counter(SUN_RT, "applicationTime",
                                      PerfData::U_Ticks, CHECK);

    PerfDataManager::create_constant(SUN_RT, "jvmVersion",
                                     PerfData::U_None,
                                     Abstract_VM_Version::jvm_version(), CHECK);

    char capabilities[65];
    capabilities[0] = AttachListener::is_attach_supported() ? '1' : '0';
    capabilities[1] = INCLUDE_SERVICES ? '1' : '0';
    for (int i = 2; i<64; i++) capabilities[i] = '0';
    capabilities[64] = '\0';
    PerfDataManager::create_string_constant(SUN_RT, "jvmCapabilities",
                                            capabilities, CHECK);
  }
}
```

| 计数器全名 | 类型 | 单位 | 更新时机 |
|-----------|------|------|---------|
| `sun.rt.safepointSyncTime` | Counter | Ticks | 安全点同步阶段耗时累加 |
| `sun.rt.safepoints` | Counter | Events | 每次进入安全点时 `inc()` |
| `sun.rt.safepointTime` | Counter | Ticks | 整个安全点耗时累加 |
| `sun.rt.applicationTime` | Counter | Ticks | 两次安全点之间应用代码执行时间 |
| `sun.rt.jvmVersion` | Constant | — | 创建时赋值，不变 |
| `sun.rt.jvmCapabilities` | StringConstant | — | 创建时赋值，64 字符二进制串 |

前 4 个单位是 **Ticks**（时钟周期），不是毫秒——`RuntimeMXBean.getUptime()` 会通过 `Management::ticks_to_ms()` 换算。

safepoint 是 JVM 暂停所有应用线程做全局操作的机制（GC、去优化、Thread.dump 等都需要安全点）。这 4 个计数器让外部能观察安全点的频率和耗时——`jstat -gccause` 的 CGC 列就是 `safepoints` 计数。

`jvmCapabilities` 是 64 字符的二进制串，第 0 位表示 attach 是否支持（决定 `jcmd` 能不能连进来），第 1 位表示 `INCLUDE_SERVICES` 是否启用。

---

## ClassLoadingService::init() — 类加载统计

```cpp
/* === src/hotspot/share/services/classLoadingService.cpp === */

void ClassLoadingService::init() {
  EXCEPTION_MARK;

  _classes_loaded_count =
    PerfDataManager::create_counter(JAVA_CLS, "loadedClasses",
                                    PerfData::U_Events, CHECK);
  _classes_unloaded_count =
    PerfDataManager::create_counter(JAVA_CLS, "unloadedClasses",
                                    PerfData::U_Events, CHECK);
  _shared_classes_loaded_count =
    PerfDataManager::create_counter(JAVA_CLS, "sharedLoadedClasses",
                                    PerfData::U_Events, CHECK);
  _shared_classes_unloaded_count =
    PerfDataManager::create_counter(JAVA_CLS, "sharedUnloadedClasses",
                                    PerfData::U_Events, CHECK);

  if (UsePerfData) {
    _classbytes_loaded =
      PerfDataManager::create_counter(SUN_CLS, "loadedBytes",
                                     PerfData::U_Bytes, CHECK);
    _classbytes_unloaded =
      PerfDataManager::create_counter(SUN_CLS, "unloadedBytes",
                                     PerfData::U_Bytes, CHECK);
    _shared_classbytes_loaded =
      PerfDataManager::create_counter(SUN_CLS, "sharedLoadedBytes",
                                     PerfData::U_Bytes, CHECK);
    _shared_classbytes_unloaded =
      PerfDataManager::create_counter(SUN_CLS, "sharedUnloadedBytes",
                                     PerfData::U_Bytes, CHECK);
    _class_methods_size =
      PerfDataManager::create_variable(SUN_CLS, "methodBytes",
                                       PerfData::U_Bytes, CHECK);
  }
}
```

| 计数器全名 | 类型 | 单位 | 更新时机 |
|-----------|------|------|---------|
| `java.cls.loadedClasses` | Counter | Events | 类加载完成时 `inc()` |
| `java.cls.unloadedClasses` | Counter | Events | 类卸载时 `inc()` |
| `java.cls.sharedLoadedClasses` | Counter | Events | CDS 共享类加载时 `inc()` |
| `java.cls.sharedUnloadedClasses` | Counter | Events | CDS 共享类卸载时 `inc()` |
| `sun.cls.loadedBytes` | Counter | Bytes | 类加载时累加字节 |
| `sun.cls.unloadedBytes` | Counter | Bytes | 类卸载时累加字节 |
| `sun.cls.sharedLoadedBytes` | Counter | Bytes | CDS 共享类字节累加 |
| `sun.cls.sharedUnloadedBytes` | Counter | Bytes | CDS 共享类卸载字节 |
| `sun.cls.methodBytes` | Variable | Bytes | 类加载时累加方法字节 |

前 4 个用 `JAVA_CLS` 前缀（标准接口，`jstat -class` 优先读这些），后 5 个用 `SUN_CLS` 前缀（HotSpot 扩展）。

读者运行 `jstat -class <pid>` 看到的 Loaded / Bytes / Unloaded 就是这几个计数器的值。Java 代码 `ClassLoadingMXBean.getLoadedClassCount()` 返回 `loadedClasses`。

---

## PerfData 命名空间与共享内存写入

上面看到每个计数器名都有个前缀（`sun.rt`、`java.threads`、`java.cls`、`sun.cls`），这是 PerfData 的命名空间。HotSpot 用前缀区分稳定性：

| 前缀 | 含义 | 稳定性 | 例子 |
|------|------|--------|------|
| `java.*` | JSR 174 标准接口 | 稳定，外部工具可依赖 | `java.threads.live` |
| `com.sun.*` | Oracle 提交扩展 | 不稳定但支持 | `com.sun.cls.*`（实际少见） |
| `sun.*` | HotSpot 内部扩展 | 不稳定，可能版本间改名 | `sun.rt.safepoints` |

`jstat` 优先读 `java.*` 前缀的；`jcmd PerfCounter.print` 全部输出。

写入共享内存的机制：`PerfDataManager::create_counter` 底层调用 `PerfData::create_entry`，从 ch03/05 创建的共享内存里分配一段空间，写入一个 `PerfDataEntry` 结构（含名字、类型、单位、可变性、数据区）。`_valuep` 指针指向数据区——后续 `inc()` / `set_value()` 直接写共享内存，**零系统调用、零拷贝**。这就是 jstat 能每秒采样还不卡 JVM 的原因。

---

## DCmd 的工作机制（通道 B 详解）

上面说 `Management::init()` 注册了 40+ DCmd。这里讲它们怎么被调用。

### 三种调用来源

每个 DCmd 注册时声明接受哪些来源（位掩码）：

```cpp
enum DCmdSource {
  DCmd_Source_Internal  = 0x01U,  // JVM 自身调用
  DCmd_Source_AttachAPI = 0x02U,  // jcmd 工具调用（attach API）
  DCmd_Source_MBean     = 0x04U   // JMX 客户端调用（jconsole/Java 代码）
};
```

大部分命令对三种来源都开放（`full_export = Internal | AttachAPI | MBean`）。例外：

- `ManagementAgent.start` / `stop` / `status` 故意只导出给 `Internal | AttachAPI`，不给 MBean——防止远程 JMX 客户端控制 Agent 启停（安全考虑）。
- 部分 debug 专用命令只给 Internal。

### jcmd 的完整调用链

```
用户执行: jcmd <pid> Thread.print
    │
    ▼
jcmd 工具(Java 程序) → VirtualMachine.attach(pid)
    │  创建 /tmp/.attach_pid<pid> 文件
    │  发 SIGQUIT 信号给目标 JVM
    │  轮询等待 /tmp/.java_pid<pid> UNIX socket
    │  connect(socket) 发送命令字符串
    ▼
目标 JVM 的 AttachListener 线程收到请求
    │  → 在命令表里找到 "jcmd" 入口
    ▼
DCmd::parse_and_execute(DCmd_Source_AttachAPI, "Thread.print", ...)
    │  → DCmdFactory::factory() 查找 "Thread.print" → ThreadDumpDCmd
    ▼
ThreadDumpDCmd::execute() → 打印所有线程栈
    │
    ▼
输出通过 socket 返回给 jcmd 工具
```

注意路径上 `jcmd` 是通过 attach API（UNIX socket）和 JVM 通信的，目标 JVM 的 AttachListener 线程要参与。这和 `jstat` 直接读共享内存完全不同——`jstat` 不需要 JVM 配合。

### jcmd PerfCounter.print 是个例外

`jcmd <pid> PerfCounter.print` 看起来像普通 DCmd，但它走的是 `jstat` 同款路径——直接 mmap PerfData 共享内存读出来打印。不走 attach API。这是为什么 `jcmd PerfCounter.print` 即使目标 JVM 卡在 safepoint 也能用，但 `jcmd Thread.print` 不行（AttachListener 线程也要在 safepoint 暂停）。

---

## JMX Agent 启动

`jconsole`、VisualVM 远程连接一个 JVM 时，目标 JVM 必须启动 JMX Agent（监听 RMI 端口）。Agent 不是 `management_init` 启动的——`management_init` 只铺 C++ 侧地基，Agent 是 Java 层的，要等 JNI 就绪后才能启动。

三种启动方式：

```
方式1: 启动时加参数
  java -Dcom.sun.management.jmxremote.port=9999 MyApp
  → 在 create_vm 末尾由 Management::initialize() 启动 Agent

方式2: 运行时通过 jcmd 启动
  jcmd <pid> ManagementAgent.start jmxremote.port=9999
  → JMXStartRemoteDCmd::execute() → Agent.startRemoteManagementAgent()

方式3: 只启动本地 JMX（jconsole 本地连接）
  jcmd <pid> ManagementAgent.start_local
  → JMXStartLocalDCmd::execute()
```

这三种都不在 `management_init` 里——`management_init` 只负责注册 DCmd（包括 `ManagementAgent.start` 这个 DCmd 本身）和创建 PerfData 计数器，让 Agent 启动后有数据可读。

---

## 完整数据流向图

把这一节所有东西放到一张图里：

```
╔══════════════════════════════════════════════════════════════╗
║  目标 JVM 进程 — C++ 侧（HotSpot 内部）                        ║
║                                                                ║
║  management_init()                                             ║
║  ├── Management::init()      → 3 计时器 + 9 能力位 + 40+ DCmd  ║
║  ├── ThreadService::init()   → 4 线程计数器                     ║
║  ├── RuntimeService::init()  → 6 safepoint 计数器               ║
║  └── ClassLoadingService::init() → 9 类加载计数器             ║
║         │                                                      ║
║    ┌────┴──────────────────┐                                   ║
║    ▼                       ▼                                   ║
║  通道 A                   通道 B                                ║
║  PerfData 共享内存         jmm_interface 函数表（40 函数指针）   ║
║  /tmp/hsperfdata_.../<pid>  ← JVM_GetManagement(JMM_VERSION)   ║
║  22 个计数器在这里          DCmd 注册表在这里                    ║
╚══════════════════════════════════════════════════════════════╝
       │                              │
       │ mmap 读                     │ JNI 边界
       ▼                              ▼
╔═══════════════════════╗  ╔══════════════════════════════════╗
║  外部工具(被动读)      ║  ║  Java 侧                          ║
║                       ║  ║  libmanagement.so                 ║
║  jstat -gc <pid>      ║  ║   ↓ JNI_OnLoad                    ║
║  jcmd PerfCounter     ║  ║   jmm_interface = JVM_GetMgmt()   ║
║    .print <pid>       ║  ║   ↓                               ║
║                       ║  ║  ClassLoadingImpl / ThreadImpl /  ║
║  零系统调用            ║  ║   RuntimeImpl / MemoryImpl ...   ║
║  不需要 JVM 配合       ║  ║   ↓                               ║
║                       ║  ║  java.lang.management.*MXBean     ║
╚═══════════════════════╝  ║   ↓                               ║
                           ║  ManagementFactory.getXxxMXBean() ║
                           ║   ↓                               ║
                           ║  用户 Java 代码                    ║
                           ╚══════════════════════════════════╝
                                       │
                                       │ JMX 远程(RMI)
                                       ▼
                           ╔══════════════════════════════════╗
                           ║  jconsole / VisualVM / JMC       ║
                           ╚══════════════════════════════════╝

           另外：jcmd <其他命令> 走 attach API
                 ↓ UNIX socket
                 AttachListener 线程 → DCmd::execute()
                 （这条路径目标 JVM 必须配合）
```

---

## gdb 验证点

```bash
# 1. 在 management_init 打断点
break management_init

# 2. 验证 3 个时间戳 PerfVariable 创建
break PerfDataManager::create_variable
# 检查 name 参数依次为 "createVmBeginTime"、"createVmEndTime"、"vmInitDoneTime"

# 3. 验证 jmmOptionalSupport 能力位
break Management::init
# 单步到 _optional_support 赋值处，检查 9 个位

# 4. 运行时验证 PerfData 共享内存
# 启动 JVM 后查看文件
ls -la /tmp/hsperfdata_$(whoami)/
# 用 jcmd 读取
jcmd $(pidof java) PerfCounter.print | grep "sun.rt\|java.threads\|java.cls"
```

---

## 小结

`management_init()` 是 JVM 可观测体系的 C++ 侧地基，做了三件事：

1. **注册 22 个 PerfData 计数器** — 3 个时间戳 + 4 个线程计数 + 6 个 safepoint 统计 + 9 个类加载统计。写入 ch03/05 创建的 PerfData 共享内存，`jstat` 和 `jcmd PerfCounter.print` 可零开销读取。

2. **声明 9 个能力位** — `jmmOptionalSupport` 结构体，告诉 Java 层 JVM 支持哪些监控能力（如 CPU 时间支持取决于 OS）。

3. **注册 40+ 诊断命令** — 让 `jcmd <pid> <命令>` 能工作。包括 `Thread.print`、`GC.heap_dump`、`VM.native_memory` 等。

`management_init` **不**负责：
- 创建 PerfData 共享内存（`perfMemory_init` 在 `vm_init_globals` 中已做）
- 启动 JMX Agent（`Management::initialize` 在 `create_vm` 末尾按需启动）
- 创建 PlatformMBeanServer（Java 侧按需创建）
- 注册 MemoryService / CompileBroker 的 PerfData（在 `universe_post_init` / `compileBroker_init` 中各自注册）

下一节（4.3）讲 `bytecodes_init()`——它只有 3 行，但背后是 JVM 字节码规范 + `_flags`/`_lengths` 编码体系 + Bytecode class 体系（12 子类）+ Rewriter 改写机制 + `fast`/`nofast` 变体字节码。
