# 4.2 management_init — JVM 暴露自身状态的 C++ 侧地基

4.1 节给出了 `init_globals()` 的 30 项全貌。本节展开第一项 `management_init()`——它是 `HandleMark hm` 之后的第一行，注册 JVM 自身状态数据的"出口"。

`management_init()` 本身只有 10 行，但它背后是整个 JVM 可观测体系：为什么 `jstat` 能读到线程数？为什么 Java 代码里 `ManagementFactory.getRuntimeMXBean().getUptime()` 能拿到 VM 启动时间？为什么 `jcmd <pid> Thread.print` 能打出线程转储？这些工具/API 背后都需要 JVM 在 C++ 侧提前准备好数据。`management_init` 就是做这件事。

在进入源码之前，先把"读者为什么要看这个函数"建立清楚。

---

## 你遇到过的场景：观察一个跑着的 JVM

假设你写了一个 Java 程序：

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

`java MyApp` 启动后，进程在后台跑着。你作为运维/开发，想问它几个问题：

- 它跑了多久了？
- 加载了多少个类？
- 堆用了多少内存？
- 现在有多少线程？
- GC 触发了几次？每次多久？

这些信息 JVM 自己全都知道（它就是干这活的），但**外部怎么拿到**？JVM 是个独立进程，它的内存你直接读不到。

JDK 给了三类方式观察一个跑着的 JVM：

### 方式一：命令行工具

JDK 自带一批工具，在 `JAVA_HOME/bin/` 下：

| 工具 | 用途 | 典型用法 |
|------|------|---------|
| `jps` | 列出所有 Java 进程 | `jps -l` |
| `jstat` | 实时监控 GC / 类加载 / 编译 | `jstat -gc <pid> 1000`（每秒打印 GC） |
| `jcmd` | 万能诊断命令 | `jcmd <pid> Thread.print`（打线程转储） |
| `jstack` | 打印线程栈 | `jstack <pid>` |
| `jmap` | 堆转储 / 直方图 | `jmap -histo <pid>` |
| `jinfo` | 查看/修改 VM flag | `jinfo -flag PrintGC <pid>` |

这些工具**不需要目标 JVM 主动配合**——`jstat` 直接读共享内存文件，`jcmd`/`jstack`/`jmap` 通过 attach API 发信号给目标 JVM 让它执行命令。你完全可以在生产环境上 `jstat -gc <pid> 1000` 看 GC 情况，目标 JVM 不用改一行代码。

### 方式二：图形工具

| 工具 | 用途 |
|------|------|
| `jconsole` | JMX 图形监控（自带，JDK 9 后从 bin 移到 lib） |
| `jvisualvm` | 堆/CPU/线程图形分析（JDK 9 后独立下载） |
| `JMC` | Java Mission Control，飞行记录分析（Oracle 商业，OpenJDK 开源） |

这些都是 Java 写的图形程序，需要 X11 窗口系统才能显示。在 Linux 上有三种用法：

1. **本地有桌面环境**（如 GNOME/KDE）— 直接运行 `jconsole <pid>` 即可，连本地 JVM
2. **远程服务器无桌面** — 通过 `ssh -X user@server` 把图形转发到本地 X server，或在本机用 `jconsole` 通过 JMX 远程连接服务器的 `jmxremote.port`
3. **纯命令行服务器**（无 X11，无 forwarding）— 图形工具用不了，只能用方式一的命令行工具

`jconsole` 连上一个 JVM 后，会自动每秒采样一次堆/线程/类加载数据画曲线。它的数据来源和方式一不一样——走 JMX 远程协议（RMI），目标 JVM 要主动启动 JMX Agent（后面会讲怎么启动）。

### 方式三：Java 代码

Java 代码也能查询这些数据：

```java
import java.lang.management.*;

// 启动后多久（毫秒）
long uptime = ManagementFactory.getRuntimeMXBean().getUptime();

// 加载了多少个类
int loadedCount = ManagementFactory.getClassLoadingMXBean().getLoadedClassCount();

// 有多少个活线程
int threadCount = ManagementFactory.getThreadMXBean().getThreadCount();

// 堆用了多少
MemoryUsage heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
long used = heap.getUsed();
```

`ManagementFactory` 是 `java.lang.management` 包下的工具类，提供一系列 `getXxxMXBean()` 静态方法返回"MXBean"对象——每个 MXBean 对应一类 JVM 状态。这是规范 JSR 174（Java Management Monitor）定义的标准 API。

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

### 通道 B：jmm_interface 函数表（Java 代码 / jconsole / jcmd 走这条）

Java 代码里 `ManagementFactory.getThreadMXBean().getThreadCount()` 不是读共享内存——它走 JNI 调用链：

```
Java 代码
  ThreadMXBean.getThreadCount()
    ↓
  libmanagement.so 里的 native 实现
    ↓ JNI 调用
  JVM_GetManagement(JMM_VERSION)  ← 一次性拿到 jmm_interface 函数表
    ↓
  jmm_interface->GetLongAttribute(JMM_THREAD_COUNT)
    ↓
  ThreadService::_live_threads_count 的值
```

`jmm_interface` 是 HotSpot C++ 侧的一个**函数指针表**（约 40 个函数指针），定义在 `management.cpp`。Java 侧的 `libmanagement.so`（在 `java.management` 模块里）加载时通过 `JVM_GetManagement(JMM_VERSION)` 拿到这个表的指针，之后所有 MXBean 方法的调用都通过这个表的函数指针回调 HotSpot。

**和通道 A 的区别**：通道 B 是**主动的**——每次调用都要进 JVM 执行 C++ 代码，能做复杂逻辑（如死锁检测 `findDeadlocks`、堆转储 `dumpHeap`），但每次调用都有 JNI 开销。通道 A 只能读简单数值（计数器），通道 B 能做任何事。

`management_init` 同时为两条通道做准备：
- 注册 22 个 PerfData 计数器 → 给通道 A（被动读）
- 初始化能力位 + 注册 DCmd → 给通道 B（Java/jcmd 主动调）

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

这三个计数器记录 JVM 启动的三个关键时间戳（都是绝对时间，单位毫秒）：

| 计数器全名 | 写入时机 | 含义 |
|-----------|---------|------|
| `sun.rt.createVmBeginTime` | `TraceVmCreationTime::end()` | `Threads::create_vm` 开始时间 |
| `sun.rt.createVmEndTime` | 同上 | `Threads::create_vm` 结束时间 |
| `sun.rt.vmInitDoneTime` | `set_init_completed()` 之后 | VM 初始化完成时间 |

`RuntimeMXBean.getStartTime()` 返回的就是 `vmInitDoneTime`。`TraceVmCreationTime` 是 ch03/02 讲过的 RAII 计时器，析构时同时写入 PerfData 和 `-Xlog` 日志。

### 2. 9 个能力位（jmmOptionalSupport）

通道 B 的 Java 层（`VMManagementImpl`）在初始化时会问 HotSpot："你支持哪些监控能力？"——HotSpot 用 `_optional_support` 这个结构体回答。9 个布尔位：

| 能力位 | 设置条件 | 对应的 Java API |
|--------|---------|----------------|
| `isLowMemoryDetectionSupported` | 恒为 1 | `MemoryPoolMXBean.isUsageThresholdExceeded()` |
| `isCompilationTimeMonitoringSupported` | 恒为 1 | `CompilationMXBean.getTotalCompilationTime()` |
| `isThreadContentionMonitoringSupported` | 恒为 1 | `ThreadMXBean.isThreadContentionMonitoringEnabled()` |
| `isCurrentThreadCpuTimeSupported` | `os::is_thread_cpu_time_supported()` | `ThreadMXBean.getCurrentThreadCpuTime()` |
| `isOtherThreadCpuTimeSupported` | 同上 | `ThreadMXBean.getThreadCpuTime(id)` |
| `isObjectMonitorUsageSupported` | 恒为 1 | `ThreadMXBean.getThreadInfo(id, maxDepth)` |
| `isSynchronizerUsageSupported` | `INCLUDE_SERVICES` | `ThreadMXBean.findDeadlockedThreads()` |
| `isThreadAllocatedMemorySupported` | 恒为 1 | `ThreadMXBean.getThreadAllocatedBytes(id)` |
| `isRemoteDiagnosticCommandsSupported` | 恒为 1 | `DiagnosticCommandMBean` 是否可用 |

CPU 时间支持位取决于 OS——某些嵌入式平台 `os::is_thread_cpu_time_supported()` 返回 false，此时两个位为 0，对应的 `ThreadMXBean` 方法返回 -1。

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
