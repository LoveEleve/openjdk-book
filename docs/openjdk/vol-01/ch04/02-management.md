# 4.2 management_init — JMX 子系统的 C++ 侧地基

4.1 节给出了 `init_globals()` 的 30 项全貌。本节开始逐项展开，第一个就是 `management_init()`——它是 `init_globals()` 的第一行（`HandleMark hm` 之后），注册 JMX 子系统的 PerfData 计数器、声明监控能力位、注册诊断命令。

`management_init()` 本身只有 10 行，但它背后是整个 JMX/JMM 监控体系：PerfData 共享内存、jmm_interface 函数表、9 个标准 MXBean、40+ 诊断命令、jstat/jcmd 工具链、JMX Agent 启动。这些知识在后续章节中会被反复引用，所以本节系统性梳理一遍。

---

## management_init() 全貌源码

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

这 22 个 PerfData 计数器被写入 PerfData 共享内存（`/tmp/hsperfdata_<user>/<pid>` 文件，由 ch03/05 的 `perfMemory_init` 创建），`jstat`、`jcmd PerfCounter.print` 等外部工具可以直接读取。

---

## 背景：这些计数器最终是给谁用的？

上一节说 management_init 注册的 22 个 PerfData 计数器会被写入共享内存，`jstat` 和 `jcmd PerfCounter.print` 可以直接读取。但日常开发中更常用的是 Java 代码里的 `ManagementFactory.getThreadMXBean()`、`RuntimeMXBean.getUptime()` 这样的 API——它们返回的不是原始计数器，而是结构化的 Java 对象。那 Java 层是怎么读到 HotSpot C++ 侧注册的这些数据的？

这就需要梳理 JMX 监控体系的完整架构，理解 management_init 在其中的位置。

### 三层架构

整个 JMX 监控体系分为三层：

```
┌─────────────────────────────────────────────────────────┐
│  外部工具层                                              │
│  jstat / jcmd / jconsole / VisualVM / JMC               │
│  ├── jstat, jcmd PerfCounter.print: 直接读 PerfData     │
│  │   共享内存(零开销,不需要 JVM 配合)                    │
│  └── jconsole, VisualVM: 走 JMX 远程协议(RMI)           │
└─────────────────────────────────────────────────────────┘
                    ▲
                    │ JNI 边界
                    ▼
┌─────────────────────────────────────────────────────────┐
│  Java 层                                                 │
│  java.lang.management 包                                 │
│  ├── ThreadMXBean     ← 用户调 getThreadCount()         │
│  ├── RuntimeMXBean    ← 用户调 getUptime()              │
│  ├── ClassLoadingMXBean ← 用户调 getLoadedClassCount()  │
│  ├── MemoryMXBean / MemoryPoolMXBean / ...              │
│  └── ManagementFactory.getXxxMXBean()                   │
│      ↓ native 调用                                       │
│  libmanagement.so (JNI) ← jmm_interface 函数表         │
└─────────────────────────────────────────────────────────┘
                    ▲
                    │ jmm_interface 函数指针
                    │
┌─────────────────────────────────────────────────────────┐
│  HotSpot C++ 层                                          │
│  management_init() 注册的:                              │
│  ├── 22 个 PerfData 计数器 → PerfData 共享内存          │
│  ├── 9 个能力位 (jmmOptionalSupport)                   │
│  ├── 40+ DCmd 诊断命令                                 │
│  └── jmm_interface 函数表 ← libmanagement.so 拿走指针  │
└─────────────────────────────────────────────────────────┘
```

**关键点**：C++ 侧有两条数据出口：

1. **PerfData 共享内存** — jstat/jcmd 直接 mmap 读取，不经过 Java 层。这条路径 management_init 只是往共享内存写数据，不需要做任何额外工作。

2. **jmm_interface 函数表** — Java 层的 `libmanagement.so` 在 `JNI_OnLoad` 时调用 `JVM_GetManagement(JMM_VERSION)` 拿到这个函数表指针，之后 Java 层的 MXBean 方法都走这个表里的函数指针回调 HotSpot。

management_init 同时为这两条路径做准备：注册 PerfData 计数器（给路径 1）、初始化能力位和 DCmd（给路径 2）。

### JSR 174 与 9 个标准 MXBean

**JSR 174**（Java Management Monitor）规范定义了 `java.lang.management` 包，是 JMX（JSR 3）的监控子集。它提供 9 个标准 MXBean 接口，让用户代码和外部工具能查询 JVM 运行时状态：

| MXBean 接口 | 对应的 HotSpot C++ 类 | management_init 注册的计数器 |
|-------------|----------------------|----------------------------|
| `ClassLoadingMXBean` | `ClassLoadingService` | `java.cls.loadedClasses` 等 9 个 |
| `ThreadMXBean` | `ThreadService` | `java.threads.live` 等 4 个 |
| `RuntimeMXBean` | `RuntimeService` | `sun.rt.safepoints` 等 6 个 |
| `MemoryMXBean` | `MemoryService`（在 universe_post_init 注册） | — |
| `MemoryPoolMXBean` | `MemoryPool`（在 universe_post_init 注册） | — |
| `GarbageCollectorMXBean` | `MemoryService` 注册的 GC manager | — |
| `MemoryManagerMXBean` | `MemoryManager` | — |
| `CompilationMXBean` | `CompileBroker`（在 compileBroker_init 注册） | — |
| `OperatingSystemMXBean` | `os` 模块 | — |

注意右列：management_init 只负责前 3 个 Service 的注册（ClassLoading/Thread/Runtime）。Memory 和 Compilation 相关的 MXBean 在后续的 `universe_post_init` 和 `compileBroker_init` 里注册——management_init 只是开了个头，不是 JMX 的全部。

用户代码通过 `ManagementFactory.getClassLoadingMXBean()` 等静态方法获取这些 MXBean。这些 MXBean 的方法底层走 `libmanagement.so` → `jmm_interface` 函数表 → HotSpot C++ 侧的 Service 类。例如 `ThreadMXBean.getThreadCount()` 最终调用的是 `jmm_GetLongAttribute(JMM_THREAD_COUNT)`，后者读取 `ThreadService::_live_threads_count` 这个 PerfData 计数器。

### jmm.h — HotSpot 内部接口

`jmm.h` 是 HotSpot 与 `libmanagement.so` 之间的**私有接口**（注释明确写着 "private interface used by JDK for JVM monitoring and management"），不属于公开 Java API。它定义在 `src/hotspot/share/include/jmm.h`，核心是一个包含约 40 个函数指针的结构体 `jmmInterface_1_`。

`JMM_VERSION` 当前是 `JMM_VERSION_2 = 0x20020000`（JDK 10+），用于 ABI 兼容协商。注意 `JMM_VERSION_*` 是版本号枚举，不是能力位——能力位是 `jmmOptionalSupport` 结构体的 9 个布尔字段。

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

三个职责：创建计时器、声明能力位、注册 DCmd。

### 3 个 PerfVariable 计时器

| 计数器全名 | 写入时机 | 用途 |
|-----------|---------|------|
| `sun.rt.createVmBeginTime` | `TraceVmCreationTime::end()` 调用 `record_vm_startup_time` | VM 创建开始时间戳 |
| `sun.rt.createVmEndTime` | 同上 | VM 创建结束时间戳 |
| `sun.rt.vmInitDoneTime` | `set_init_completed` 后调用 `record_vm_init_completed` | VM 初始化完成时间戳 |

这三个时间戳记录了 JVM 启动的三个关键节点。`RuntimeMXBean.getStartTime()` 返回的就是 `vmInitDoneTime`。`TraceVmCreationTime` 是 RAII 计时器（ch03/02 已讲），析构时同时写入 PerfData 和日志。

### 9 个能力位（jmmOptionalSupport）

`_optional_support` 是 `jmmOptionalSupport` 结构体（`jmm.h`），9 个布尔字段声明 JVM 支持哪些监控能力。Java 侧的 `VMManagementImpl` 在 static 块中通过 `jmm_interface->GetOptionalSupport` 读取这些位，决定哪些 MXBean 方法可用：

| 能力位 | 设置条件 | 对应的 MXBean 方法 |
|--------|---------|-------------------|
| `isLowMemoryDetectionSupported` | 恒为 1 | `MemoryPoolMXBean.isUsageThresholdExceeded()` |
| `isCompilationTimeMonitoringSupported` | 恒为 1 | `CompilationMXBean.getTotalCompilationTime()` |
| `isThreadContentionMonitoringSupported` | 恒为 1 | `ThreadMXBean.isThreadContentionMonitoringEnabled()` |
| `isCurrentThreadCpuTimeSupported` | `os::is_thread_cpu_time_supported()` | `ThreadMXBean.getCurrentThreadCpuTime()` |
| `isOtherThreadCpuTimeSupported` | 同上 | `ThreadMXBean.getThreadCpuTime(id)` |
| `isObjectMonitorUsageSupported` | 恒为 1 | `ThreadMXBean.getThreadInfo(id, maxDepth)` |
| `isSynchronizerUsageSupported` | `INCLUDE_SERVICES` | `ThreadMXBean.findDeadlockedThreads()` |
| `isThreadAllocatedMemorySupported` | 恒为 1 | `ThreadMXBean.getThreadAllocatedBytes(id)` |
| `isRemoteDiagnosticCommandsSupported` | 恒为 1 | `DiagnosticCommandMBean` 是否可用 |

CPU 时间支持位取决于 OS——某些嵌入式平台不支持 `thread_cpu_time`，此时两个位为 0，`ThreadMXBean.getThreadCpuTime()` 会返回 -1。

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

| 计数器全名 | 类型 | 变体 | 更新时机 |
|-----------|------|------|---------|
| `java.threads.started` | Counter | V_Monotonic（单调递增） | `add_thread` 时 `inc()` |
| `java.threads.live` | Variable | V_Variable（可增减） | `add_thread` 时 inc / `remove_thread` 时 dec |
| `java.threads.livePeak` | Variable | V_Variable | `add_thread` 时若 `count > peak` 则 `set_value(count)` |
| `java.threads.daemon` | Variable | V_Variable | daemon 线程 add/remove 时 inc/dec |

Counter 和 Variable 的区别：Counter 只能递增（如累计启动线程数），Variable 可增可减（如当前活跃线程数）。

`ThreadMXBean.getThreadCount()` 返回 `java.threads.live`，`getTotalStartedThreadCount()` 返回 `java.threads.started`，`getPeakThreadCount()` 返回 `java.threads.livePeak`，`getDaemonThreadCount()` 返回 `java.threads.daemon`。

> **注意**：ThreadService 还有两个原子计数 `_atomic_threads_count` / `_atomic_daemon_threads_count`（`volatile int`），不写 PerfData，用于 `Thread.join()` 返回前的精确计数——`current_thread_exiting` 提前递减原子计数，PerfData 的 `live` 计数延迟到 `remove_thread` 时才递减。

---

## RuntimeService::init() — safepoint 统计 + jvmCapabilities

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

    // jvmVersion 常量
    PerfDataManager::create_constant(SUN_RT, "jvmVersion",
                                     PerfData::U_None,
                                     Abstract_VM_Version::jvm_version(), CHECK);

    // jvmCapabilities 64 位串
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
| `sun.rt.safepointSyncTime` | Counter | Ticks | `record_safepoint_synchronized` 时 `inc(sync_time)` |
| `sun.rt.safepoints` | Counter | Events | `record_safepoint_begin` 时 `inc()` |
| `sun.rt.safepointTime` | Counter | Ticks | `record_safepoint_end` 时 `inc(total_time)` |
| `sun.rt.applicationTime` | Counter | Ticks | `record_safepoint_begin` 时 `inc(app_time)` |
| `sun.rt.jvmVersion` | Constant | None | 创建时赋值，不变 |
| `sun.rt.jvmCapabilities` | StringConstant | String | 创建时赋值，不变 |

前 4 个计数器单位是 **Ticks**（时钟周期），不是毫秒。`RuntimeMXBean.getUptime()` 会通过 `Management::ticks_to_ms()` 转换为毫秒。

`safepointSyncTime` 是安全点同步阶段耗时（所有线程到达安全点的时间），`safepointTime` 是整个安全点耗时（同步+执行 VM 操作），`applicationTime` 是两次安全点之间应用代码执行时间。`jstat -gc` 的 GCT 列就是 `safepointTime` 转毫秒后的值。

`jvmCapabilities` 是一个 64 字符的二进制串，便于 Java 端按位解析：位 0 表示 attach 是否支持，位 1 表示 `INCLUDE_SERVICES` 是否启用。

---

## ClassLoadingService::init() — 类加载统计

```cpp
/* === src/hotspot/share/services/classLoadingService.cpp === */

void ClassLoadingService::init() {
  EXCEPTION_MARK;

  // 即使 -XX:-UsePerfData 也会创建（落在 C heap）
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
| `java.cls.loadedClasses` | Counter | Events | `notify_class_loaded` 时 `inc()` |
| `java.cls.unloadedClasses` | Counter | Events | `notify_class_unloaded` 时 `inc()` |
| `java.cls.sharedLoadedClasses` | Counter | Events | CDS 共享类加载时 `inc()` |
| `java.cls.sharedUnloadedClasses` | Counter | Events | CDS 共享类卸载时 `inc()` |
| `sun.cls.loadedBytes` | Counter | Bytes | 类加载时 `inc(class_size)` |
| `sun.cls.unloadedBytes` | Counter | Bytes | 类卸载时 `inc(class_size)` |
| `sun.cls.sharedLoadedBytes` | Counter | Bytes | CDS 共享类加载时 `inc(size)` |
| `sun.cls.sharedUnloadedBytes` | Counter | Bytes | CDS 共享类卸载时 `inc(size)` |
| `sun.cls.methodBytes` | Variable | Bytes | `add_class_method_size` 时 `inc(size)` |

前 4 个使用 `JAVA_CLS` namespace（稳定支持，jstat 优先使用），后 5 个使用 `SUN_CLS` namespace（HotSpot 内部扩展）。`jstat -class` 的 Loaded 列 = `loadedClasses + sharedLoadedClasses`，Bytes 列 = `loadedBytes + sharedLoadedBytes`。

> **注意**：前 4 个计数器即使 `-XX:-UsePerfData` 也会创建（注释说 "even if -XX:-UsePerfData is set, they will be allocated on C heap"），因为 JVMTI 也需要这些统计。

---

## PerfData 共享内存机制

ch03/05 的 `perfMemory_init` 创建了 PerfData 共享内存（`/tmp/hsperfdata_<user>/<pid>` 文件）。`management_init` 注册的 22 个计数器就是往这个共享内存里写。这里回顾写入机制。

### PerfDataManager 与 namespace

`PerfDataManager` 是 PerfData 的工厂类，`create_counter` / `create_variable` / `create_constant` 都是工厂方法。第一个参数是 `CounterNS` 枚举，决定计数器名的前缀：

| 枚举值 | 前缀 | 含义 | 稳定性 |
|--------|------|------|--------|
| `JAVA_NS` | `java` | JSR174 标准接口 | 稳定支持 |
| `COM_NS` | `com.sun` | Oracle 提交 | 不稳定但支持 |
| `SUN_NS` | `sun` | HotSpot 内部扩展 | 不稳定且不支持 |
| `JAVA_THREADS` | `java.threads` | 线程系统 | 稳定 |
| `SUN_RT` | `sun.rt` | 运行时 | 不稳定 |
| `JAVA_CLS` | `java.cls` | 类加载 | 稳定 |
| `SUN_CLS` | `sun.cls` | 类加载内部 | 不稳定 |

"不稳定"意味着 HotSpot 版本间可能改名或删除，外部工具不应强依赖。`jstat` 优先使用 `java.*` 前缀的计数器。

### create_entry — 写入共享内存

`PerfDataManager::create_counter` 底层调用 `PerfData::create_entry`，在 PerfData 共享内存中分配一个 `PerfDataEntry`：

```cpp
/* === src/hotspot/share/runtime/perfData.cpp === */

void PerfData::create_entry(BasicType dtype, size_t dsize, size_t vlen) {
  // 计算所需大小：entry 头 + 名称 + 填充 + 数据
  size_t size = sizeof(PerfDataEntry) + namelen + pad_length + data_size;

  // 从 PerfData 共享内存分配
  char* psmp = PerfMemory::alloc(size);
  if (psmp == NULL) {
    // 共享内存耗尽，回退到 C heap（外部工具读不到）
    psmp = NEW_C_HEAP_ARRAY(char, size, mtInternal);
    _on_c_heap = true;
  }

  // 填充 PerfDataEntry 头部
  PerfDataEntry* pdep = (PerfDataEntry*)psmp;
  pdep->entry_length = (jint)size;
  pdep->name_offset = ...;
  pdep->vector_length = (jint)vlen;
  pdep->data_type = (jbyte)type2char(dtype);  // T_LONG -> 'J'
  pdep->data_units = units();
  pdep->data_variability = variability();
  pdep->data_offset = (jint)data_start;

  _valuep = (void*)(psmp + data_start);  // _valuep 直接指向共享内存数据区
  PerfMemory::mark_updated();  // 更新 prologue 的 mod_time_stamp
}
```

关键点：`_valuep` 直接指向共享内存中的数据区。后续 `inc()` / `set_value()` 直接写共享内存，零拷贝、零系统调用。这就是 jstat 能高频采样的原因——每次采样只是读 mmap 的内存，不进 JVM。

### PerfData 的三种变体

| 变体 | Variability | 含义 | 典型例子 |
|------|------------|------|---------|
| Constant | V_Constant | 创建时写入一次，永不改变 | `jvmVersion`、`jvmCapabilities` |
| Counter | V_Monotonic | 单调递增 | `loadedClasses`、`safepoints` |
| Variable | V_Variable | 任意变化 | `live`线程数、`createVmBeginTime` |

---

## DCmd 注册机制

`Management::init()` 最后调用 `DCmdRegistrant::register_dcmds()` 注册诊断命令。这是 `jcmd` 工具能执行命令的基础。

### DCmdSource — 三种来源

```cpp
/* === src/hotspot/share/services/diagnosticFramework.hpp === */

enum DCmdSource {
  DCmd_Source_Internal  = 0x01U,  // JVM 自身调用
  DCmd_Source_AttachAPI = 0x02U,  // jcmd 工具调用
  DCmd_Source_MBean     = 0x04U   // JMX 客户端调用
};
```

每个 DCmd 注册时声明接受哪些来源（位掩码）。`factory()` 查找时用位与检查：

```cpp
if (factory->export_flags() & source) {
  return factory;  // 允许此 source
} else {
  return NULL;    // 命令存在，但不允许此 source
}
```

### 40+ DCmd 完整清单

`DCmdRegistrant::register_dcmds()` 注册了 40+ 个诊断命令，按来源分组：

**full_export（Internal | AttachAPI | MBean）— 所有来源可用**：

| 命令名 | DCmd 类 | 用途 |
|--------|---------|------|
| `help` | HelpDCmd | 列出/显示命令帮助 |
| `VM.version` | VersionDCmd | JVM 版本信息 |
| `VM.command_line` | CommandLineDCmd | 启动命令行 |
| `VM.system_properties` | PrintSystemPropertiesDCmd | 系统属性 |
| `VM.flags` | PrintVMFlagsDCmd | 打印 VM flag |
| `VM.set_flag` | SetVMFlagDCmd | 设置 VM flag |
| `VM.dynlibs` | VMDynamicLibrariesDCmd | 加载的动态库 |
| `VM.uptime` | VMUptimeDCmd | VM 运行时间 |
| `VM.info` | VMInfoDCmd | JVM 环境信息 |
| `GC.run` | SystemGCDCmd | 调用 System.gc() |
| `GC.run_finalization` | RunFinalizationDCmd | 调用 System.runFinalization() |
| `GC.heap_info` | HeapInfoDCmd | 堆信息 |
| `GC.finalizer_info` | FinalizerInfoDCmd | finalizer 队列信息 |
| `GC.class_histogram` | ClassHistogramDCmd | 堆直方图 |
| `GC.class_stats` | ClassStatsDCmd | 类元数据统计 |
| `VM.class_hierarchy` | ClassHierarchyDCmd | 类层次结构 |
| `VM.systemdictionary` | SystemDictionaryDCmd | 系统字典统计 |
| `VM.symboltable` | SymboltableDCmd | 符号表转储 |
| `VM.stringtable` | StringtableDCmd | 字符串表转储 |
| `VM.metaspace` | MetaspaceDCmd | Metaspace 统计 |
| `Thread.print` | ThreadDumpDCmd | 线程转储 |
| `VM.classloader_stats` | ClassLoaderStatsDCmd | ClassLoader 统计 |
| `VM.classloaders` | ClassLoaderHierarchyDCmd | ClassLoader 层次 |
| `Compiler.queue` | CompileQueueDCmd | 编译队列 |
| `Compiler.codelist` | CodeListDCmd | CodeCache 方法列表 |
| `Compiler.codecache` | CodeCacheDCmd | CodeCache 布局 |
| `Compiler.CodeHeap_Analytics` | CodeHeapAnalyticsDCmd | CodeHeap 分析 |
| `Compiler.directives_print` | CompilerDirectivesPrintDCmd | 打印编译指令 |
| `Compiler.directives_add` | CompilerDirectivesAddDCmd | 添加编译指令 |
| `Compiler.directives_remove` | CompilerDirectivesRemoveDCmd | 移除编译指令 |
| `Compiler.directives_clear` | CompilerDirectivesClearDCmd | 清除编译指令 |
| `VM.print_touched_methods` | TouchedMethodsDCmd | 触摸过的方法 |
| `VM.native_memory` | NMTDCmd | NMT 内存跟踪 |

**不含 MBean（Internal | AttachAPI）— JMX Agent 控制**：

| 命令名 | DCmd 类 | 用途 |
|--------|---------|------|
| `ManagementAgent.start` | JMXStartRemoteDCmd | 启动远程 JMX Agent |
| `ManagementAgent.start_local` | JMXStartLocalDCmd | 启动本地 JMX Agent |
| `ManagementAgent.stop` | JMXStopRemoteDCmd | 停止 JMX Agent |
| `ManagementAgent.status` | JMXStatusDCmd | 打印 Agent 状态 |

这 4 个命令故意不导出给 MBean——注释说 "until an appropriate permission is created for them"，防止远程 JMX 客户端控制 Agent 的启停（安全考虑）。

### DCmdFramework — 参数解析

DCmd 有两种风格：
- **直接继承 DCmd** — 无参数或手动解析（如 `VersionDCmd`、`SystemGCDCmd`）
- **继承 DCmdWithParser** — 使用 `DCmdParser` 自动解析参数（如 `NMTDCmd` 有 8 个参数）

`NMTDCmd` 的 8 个参数：`summary` / `detail` / `baseline` / `summary_diff` / `detail_diff` / `shutdown` / `statistics` / `scale`。

`DCmd::parse_and_execute` 是执行入口：

```cpp
/* === src/hotspot/share/services/diagnosticFramework.cpp === */

void DCmd::parse_and_execute(DCmdSource source, outputStream* out,
                             const char* cmdline, char delim, TRAPS) {
  DCmdIter iter(cmdline, '\n');  // 按 \n 分割多命令
  while (iter.has_next()) {
    if (source == DCmd_Source_MBean && count > 0) {
      // MBean source 只允许一条命令（权限检查需要）
      THROW_MSG(vmSymbols::java_lang_IllegalArgumentException(), "Invalid syntax");
    }
    CmdLine line = iter.next();
    if (line.is_stop()) break;
    if (line.is_executable()) {
      ResourceMark rm;
      DCmd* command = DCmdFactory::create_local_DCmd(source, line, out, CHECK);
      DCmdMark mark(command);  // RAII 清理
      command->parse(&line, delim, CHECK);
      command->execute(source, CHECK);
    }
    count++;
  }
}
```

---

## jcmd 工具链

### jcmd 的完整调用链

```
用户执行: jcmd <pid> VM.version
    │
    ▼
jcmd 工具 (Java) → VirtualMachine.attach(pid)
    │                  → 创建 /tmp/.attach_pid<pid> 文件
    │                  → 发送 SIGQUIT 信号给目标 JVM
    │                  → 轮询等待 /tmp/.java_pid<pid> UNIX socket 出现
    │                  → connect(socket)
    ▼
目标 JVM 的 AttachListener 线程 dequeue() 收到请求
    │                  → 在 funcs[] 表中找到 "jcmd" → jcmd() 函数
    ▼
jcmd() 调用 DCmd::parse_and_execute(DCmd_Source_AttachAPI, ...)
    │                  → DCmdFactory::factory() 查找 "VM.version" → VersionDCmd
    ▼
VersionDCmd::execute() → 打印版本信息
    │
    ▼
输出通过 op->complete(res, &st) 返回给 jcmd 工具
```

### jcmd PerfCounter.print 的特殊路径

`jcmd <pid> PerfCounter.print` 走的是和 `jstat` 完全相同的路径——直接 mmap PerfData 共享内存，不通过 attach API：

```
jcmd 工具 → listCounters(pid)
    │       → JStatLogger.printSnapShot("\\w*", ...)
    │       → MonitoredVm → PerfDataBuffer → perf.attach(pid)
    ▼
mmap /tmp/hsperfdata_<user>/<pid> 文件
    │       → 解析 PerfDataPrologue + PerfDataEntry 链表
    ▼
输出 name = value 列表
```

| 特性 | jstat | jcmd PerfCounter.print | jcmd <其他命令> |
|------|-------|------------------------|----------------|
| 数据源 | PerfData 共享内存 | PerfData 共享内存 | attach API → DCmd |
| 是否 attach | 否 | 否 | 是（UNIX socket） |
| 目标 JVM 是否参与 | 否（被动暴露） | 否（被动暴露） | 是（AttachListener 线程） |
| 性能影响 | 极小（只读 mmap） | 极小 | 取决于命令 |

---

## JMX 客户端路径

### DiagnosticCommandMBean

`DiagnosticCommandMBean` 是一个 `DynamicMBean`（不是 MXBean），ObjectName 为 `com.sun.management:type=DiagnosticCommand`。它把所有 `DCmd_Source_MBean` 可见的 DCmd 暴露为 MBean 操作。

命令名通过 `transform()` ��换为 Java 方法名：
- `VM.version` → `vmVersion`
- `GC.heap_dump` → `gcHeapDump`
- `Thread.print` → `threadPrint`

规则：第一个点之前全小写，每个点或下划线后的字符大写。

### Wrapper — 权限检查

每个 DCmd 在 MBean 侧包装为 `Wrapper`，构造时根据 DCmd 声明的 `JavaPermission` 创建对应的 `Permission` 对象，`execute` 时检查：

```java
/* === DiagnosticCommandImpl.java === */

public String execute(String[] args) {
    if (permission != null) {
        SecurityManager sm = System.getSecurityManager();
        if (sm != null) {
            sm.checkPermission(permission);  // Java Permission 检查
        }
    }
    return executeDiagnosticCommand(sb.toString());  // native 调用
}
```

权限分两级：
- `ManagementPermission("monitor")` — 只读操作（如 `VM.version`、`Thread.print`）
- `ManagementPermission("control")` — 修改操作（如 `VM.set_flag`、`JVMTI.agent_load`）

### JMX 通知机制

当运行时注册新的 DCmd 时，`DiagnosticCommandMBean` 会发送 `jmx.mbean.info.changed` 通知。C++ 侧通过 `DCmdFactory::push_jmx_notification_request()` 触发，唤醒 Service 线程执行 `send_notification_internal`。

---

## Agent 启动路径

### Management::initialize() vs Management::init()

这两个函数容易混淆，但职责完全不同：

| 函数 | 调用时机 | 职责 | 需要 JNI？ |
|------|---------|------|-----------|
| `Management::init()` | `init_globals()` 早期 | C++ 侧铺地基（PerfData + 能力位 + DCmd） | 否 |
| `Management::initialize()` | `create_vm()` 末尾 | Java 侧启动 Agent | 是 |

`Management::initialize()` 只在 `ManagementServer` flag 为 true 时执行：

```cpp
/* === src/hotspot/share/services/management.cpp === */

void Management::initialize(TRAPS) {
  if (ManagementServer) {
    // 加载 jdk.internal.agent.Agent 类
    Klass* k = SystemDictionary::resolve_or_null(
        vmSymbols::jdk_internal_agent_Agent(), loader, Handle(), THREAD);
    // 调用 Agent.startAgent() 静态方法
    JavaCalls::call_static(&result, k,
        vmSymbols::startAgent_name(),
        vmSymbols::void_method_signature(), CHECK);
  }
}
```

### 三种 Agent 启动方式

**方式1：`-Dcom.sun.management.jmxremote`（启动时）**
```
java -Dcom.sun.management.jmxremote MyApp
```
→ `arguments.cpp` 设置 `ManagementServer=true` + 添加 `jdk.management.agent` 模块
→ `create_vm` 末尾调用 `Management::initialize()` → `Agent.startAgent()`

**方式2：`-Dcom.sun.management.jmxremote.port=N`（启动时远程）**
```
java -Dcom.sun.management.jmxremote.port=9999 MyApp
```
→ 同方式1，但 `Agent.startAgent()` 会读取 port 属性启动远程 RMI

**方式3：`jcmd ManagementAgent.start`（运行时）**
```
jcmd <pid> ManagementAgent.start jmxremote.port=9999
```
→ `JMXStartRemoteDCmd::execute()` → 加载模块 → `Agent.startRemoteManagementAgent(props)`

### 分离设计的原因

```
init_globals() 早期 — C++ 侧铺地基
├── management_init()
│   ├── 创建 PerfData 计数器
│   ├── 初始化能力位
│   └── 注册 DCmd
└── ... 其他 init

create_vm() 末尾 — Java 侧启动（JNI 已就绪）
├── Management::initialize()
│   └── if (ManagementServer) → Agent.startAgent()

运行时 — 用户触发
├── jcmd ManagementAgent.start → Agent.startRemote...
├── jcmd ManagementAgent.stop → Agent.stopRemote...
└── jcmd ManagementAgent.status → Agent.getStatus()
```

1. **时序约束** — `management_init` 在 `init_globals()` 早期调用，此时 JNI 尚未就绪，无法加载 Java 类。Agent 必须在 `create_vm()` 后期（JNI 就绪后）启动。
2. **可选性** — C++ 侧的 DCmd 注册是必须的（jcmd 需要工作）。Agent 启动是可选的。
3. **动态性** — 通过 `jcmd` 可以运行时启动/停止 Agent，无需重启 JVM。

---

## 完整数据流向图

```
╔══════════════════════════════════════════════════════════════════╗
║          目标 JVM 进程 — C++ 侧（HotSpot 内部）                    ║
║                                                                    ║
║  management_init()                                                 ║
║  ├── Management::init()      → 3 计时器 + 9 能力位 + 40+ DCmd      ║
║  ├── ThreadService::init()   → 4 线程计数器                         ║
║  ├── RuntimeService::init()  → 6 safepoint 计数器                   ║
║  └── ClassLoadingService::init() → 9 类加载计数器                  ║
║         │                                                          ║
║         ▼ PerfDataManager::create_counter                          ║
║  ┌─────────────────────────────────────────┐                        ║
║  │ PerfData 共享内存                        │                        ║
║  │ /tmp/hsperfdata_<user>/<pid>           │                        ║
║  │ ┌──────────────────┐                    │                        ║
║  │ │ PerfDataPrologue │ magic=0xcafec0c0  │                        ║
║  │ ├──────────────────┤                    │                        ║
║  │ │ Entry: sun.rt.*   │                    │                        ║
║  │ │ Entry: java.threads.* │                 │                        ║
║  │ │ Entry: java.cls.* │                    │                        ║
║  │ │ ... 200+ entries │                     │                        ║
║  │ └──────────────────┘                    │                        ║
║  └─────────────────────────────────────────┘                        ║
║                                                                    ║
║  ┌─────────────────────────────────────────┐                        ║
║  │ jmm_interface 函数表（40 个函数指针）    │                        ║
║  │ ← JVM_GetManagement(JMM_VERSION)        │                        ║
║  └─────────────────────────────────────────┘                        ║
╚══════════════════════════════════════════════════════════════════╝
                    │ JNI 边界
                    ▼
╔══════════════════════════════════════════════════════════════════╗
║          目标 JVM 进程 — Java 侧                                    ║
║                                                                    ║
║  libmanagement.so          libmanagement_ext.so                   ║
║  (java.management 模块)     (jdk.management 模块)                 ║
║         │                          │                              ║
║  VMManagementImpl          DiagnosticCommandImpl                  ║
║  ClassLoadingImpl          HotSpotDiagnostic                      ║
║  ThreadImpl                OperatingSystemImpl                    ║
║  MemoryImpl                GarbageCollectorExtImpl                ║
║  RuntimeImpl                                                       ║
║  CompilationImpl                                                   ║
║         │                          │                              ║
║         ▼                          ▼                              ║
║  java.lang.management.*MXBean   com.sun.management.*MXBean        ║
║         │                          │                              ║
║         └──────────┬───────────────┘                              ║
║                    ▼                                               ║
║         ManagementFactory.getPlatformMBeanServer()                ║
║                    │                                               ║
║         PlatformMBeanServer (MBeanServer)                         ║
║         ├── java.lang:type=ClassLoading                            ║
║         ├── java.lang:type=Memory                                  ║
║         ├── java.lang:type=Threading                                ║
║         ├── java.lang:type=Runtime                                  ║
║         ├── com.sun.management:type=DiagnosticCommand              ║
║         └── com.sun.management:type=HotSpotDiagnostic             ║
║                    │                                               ║
║                    ▼ JMX Connector (RMI)                           ║
╚══════════════════════════════════════════════════════════════════╝
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
╔═══════════╗ ╔═══════════╗ ╔═══════════════════╗
║ jstat     ║ ║ jcmd      ║ ║ jconsole/VisualVM ║
║ (mmap     ║ ║ PerfCounter║ ║ (JMX 远程)        ║
║  共享内存) ║ ║ .print    ║ ║                   ║
║           ║ ║ (mmap)    ║ �║                   ║
╚═══════════╝ ╚═══════════╝ ╚═══════════════════╝
        │           │
        │           ▼
        │   jcmd <其他命令>
        │   (attach API + UNIX socket
        │    → AttachListener 线程
        │    → DCmd 框架)
        ▼
   直接读 mmap 文件
   零系统调用
   不需要目标 JVM 配合
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

# 4. 验证 DCmd 注册
break DCmdRegistrant::register_dcmds
# 单步进入，观察 40+ 个 DCmdFactory::register_DCmdFactory 调用

# 5. 运行时验证 PerfData 共享内存
# 启动 JVM 后查看文件
ls -la /tmp/hsperfdata_$(whoami)/
# 用 jcmd PerfCounter.print 读取
jcmd $(pidof java) PerfCounter.print | grep "sun.rt\|java.threads\|java.cls"
```

---

## 小结

`management_init()` 是 JMX 子系统的 C++ 侧地基，做了三件事：

1. **注册 22 个 PerfData 计数器**——3 个时间戳 + 4 个线程计数 + 6 个 safepoint 统计 + 9 个类加载统计。这些计数器写入 PerfData 共享内存，`jstat` 和 `jcmd PerfCounter.print` 可以零开销读取。

2. **声明 9 个能力位**——`jmmOptionalSupport` 结构体，告诉 Java 层 JVM 支持哪些监控能力。CPU 时间支持位取决于 OS。

3. **注册 40+ 诊断命令**——`DCmdRegistrant::register_dcmds()` 注册所有内置 DCmd，加上 NMTDCmd。这些命令通过 `jcmd` 工具或 `DiagnosticCommandMBean` 调用。

`management_init` **不**负责：
- 创建 PlatformMBeanServer（Java 侧 `ManagementFactory.getPlatformMBeanServer` 按需创建）
- 创建 MXBean 实例（`ManagementFactoryHelper` 按需创建）
- 启动 JMX Agent（`Management::initialize` 在 `create_vm` 末尾按需启动）
- 创建 PerfData 共享内存（`perfMemory_init` 在 `vm_init_globals` 中更早完成）

下一节（4.3）讲解 `bytecodes_init()`——它只有 3 行，但背后是 JVM 字节码规范 + `_flags`/`_lengths` 编码体系 + Bytecode class 体系（12 子类）+ Rewriter 改写机制 + `fast`/`nofast` 变体字节码。
