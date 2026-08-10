# Phase 17: JMX Management — libmanagement.so + libmanagement_ext.so + libmanagement_agent.so

> **JMX 不是简单的 getter/setter——它是一个 3 层桥接架构，将 JVM 内部状态暴露为 MBean。** `jmm_interface` 是一个 36 个函数指针的 vtable（37 个槽位含 2 个 reserved）——每个函数跨越 JNI 边界，从 libmanagement.so 的薄包装（`jmm_interface->GetMemoryPoolUsage(env, pool)`）下沉到 HotSpot 的 `management.cpp`（2283 行）核心实现。`GCMemoryManager::gc_end()` 在 safepoint 内触发——`LowMemoryDetector` 检查阈值，`GCNotifier::pushNotification()` 入队——但真正的 Java 回调在 ServiceThread 中异步执行。`jmm_SetVMGlobal` 让 jinfo 可以动态修改 VM flag——与 attach API 和 DiagnosticCommand 共享同一代码路径。

> **本文档范围**: JMX Management 子系统完整覆盖。友好介绍 (📖 1 篇) 从 jconsole/jcmd 工具视角解释 JMX 是什么；深度分析 (✅ 4 篇) 聚焦 jmm_interface vtable + MemoryPool/Threshold + Thread Monitoring + Flag/OS/DiagnosticCommand；源文件清单覆盖 (📋 30+ 个) 含 3 个 .so 的 native JNI 桥接层 + HotSpot services 后端；排除范围 (🔲) 为 libattach.so (Phase 18)、JVM TI agent (Phase 19)、RMI connector Java 层 (纯 Java 实现)、javax.management MBeanServer 框架。

---

## §〇 上手指南

### 3-Tier Reading Path

| Tier | 读者 | 阅读量 | 重点 |
|------|------|:---:|------|
| 🥉 Bronze | 想理解 JMX 是什么、jconsole 数据从哪来 | 00-what-is-jmx.md | 30min |
| 🥈 Silver | 想理解完整 JMX 数据链路和 JMM 接口实现 | 00 + §二 + §三 + 01/02/03/04 五篇 | 3h |
| 🥇 Gold | 想诊断 JMX 性能问题或自定义 MBean | §六 + §二.2 GC 热路径 + 全部源码 | 1天 |

### 前置阅读

| Phase | 需要理解的内容 | 本 Phase 用到 | 重要性 |
|-------|---------------|-------------|:---:|
| 09-native-interface | JNI_ENTRY/JVM_ENTRY/JVM_LEAF 宏, 线程状态转换 | management.cpp 所有 JMM 函数使用 JVM_ENTRY | 必需 |
| 03-object-model | oop, Klass, instanceOop 的内存布局 | management.cpp 中 JavaCalls::call_virtual 操作 oop | 必需 |
| 15-core-native | JVM_* bridge 模式, RegisterNatives | JVM_GetManagement → Management::get_jmm_interface | 必需 |
| 06-gc-core | G1/Parallel GC 的 do_collection 入口 | GC 回调 → gc_begin/gc_end 的数据来源 | 必需 |
| 11-os-layer | sysconf/getrlimit/readdir/proc/self/fd | OperatingSystemImpl.c 的 OS 指标查询 | 背景 |
| 05-jit-compiler | CompilerBroker 编译统计接口 | jmm_GetTotalCompileTime 读取编译数据 | 背景 |

### 3 句话本质

JMX Management 是一个 3 层桥接：Java MBean → native JNI 薄包装（3 个 .so）→ `jmm_interface` 函数指针表 → HotSpot `management.cpp` 实现。每个 JNI 函数只有 1 行：`return jmm_interface->Xxx(env, ...)`——真正的逻辑在 management.cpp 的 36 个 `jmm_*` 函数中。GC 结束到 JMX 通知的路径分为两段：safepoint 内（入队，轻量）和 ServiceThread 异步（Java 回调，重量）。

### 核心术语

| 术语 | 定义 | 出现位置 |
|------|------|---------|
| **JMM (Java Management Monitor)** | JMX 的 native 接口规范，定义在 jmm.h 中的 36 函数 vtable (37 槽位含 2 reserved) | jmm.h:221-342 |
| **jmm_interface** | 全局 `struct jmmInterface_1_` 实例，36 个函数指针 (37 槽位) | management.cpp:2232-2272 |
| **JVM_ENTRY** | 完整 VM 进入宏 — 线程 _thread_in_native → _thread_in_vm，支持 safepoint + HandleMark | interfaceSupport.inline.hpp:558 |
| **JVM_LEAF** | 轻量 VM 进入宏 — 不做线程状态转换，不能访问 Java 堆 | interfaceSupport.inline.hpp:603 |
| **SensorInfo** | 阈值传感器 — trigger/clear + 滞回机制，ServiceThread 异步回调 Java Sensor | lowMemoryDetector.hpp:116 |
| **ThresholdSupport** | 高低阈值对 — 超过高阈值触发，低于低阈值清除，中间滞回 | lowMemoryDetector.hpp:67 |
| **Gauge vs Counter** | Gauge: 持续检测 usage 是否超阈值；Counter: 仅在 GC 后检测 collection usage | lowMemoryDetector.hpp:185/203 |
| **GCNotifier** | GC 完成事件 → JMX Notification 的异步队列 — 入队在 safepoint，发送在 ServiceThread | gcNotifier.hpp:33 |
| **ServiceThread** | JVM 内部守护线程 — 处理 GC 通知、Sensor 回调、DiagnosticFramework 通知 | serviceThread.cpp:90 |
| **WriteableFlags** | 运行时修改 VM flag 的入口 — 被 JMX/jcmd/attach API 三个入口共享 | writeableFlags.cpp:238 |
| **VM_ThreadDump** | VM Operation — 在 safepoint 遍历所有线程栈帧，生成 ThreadInfo[] | vmOperations.cpp:273 |
| **TraceMemoryManagerStats** | RAII 对象 — 构造时 gc_begin()，析构时 gc_end() | memoryService.hpp:117 |
| **ThreadsListHandle** | 线程列表的轻量快照 — 不需要全局 safepoint | threadSMR.hpp |
| **/proc/self/stat** | Linux procfs 文件 — 字段 23 是虚拟内存大小，OperatingSystemImpl.c 读取 | OperatingSystemImpl.c:127 |
| **MBean / MXBean** | JMX 管理 Bean — MXBean 是 MBean 的子类型，使用开放类型（CompositeData）而非自定义类 | java.management module |
| **VM Operation** | JVM 内部操作队列机制 — 需要在 safepoint 执行的操作（如 ThreadDump）排入 VMOperationQueue，由 VMThread 在 safepoint 取出执行 | vmOperations.hpp |
| **safepoint** | JVM 全局安全点 — 所有 Java 线程暂停，GC/JMX dump 等操作在此执行。不在 safepoint 内的操作不能遍历 Java 堆/栈 | safepoint.hpp |

---

**C 导航 — 开始读源码前需要认识的 3 个模式:**

这 3 个 C 模式贯穿整个 17 阶段——认识它们，代码就透明了。

1. **`jmm_interface->Xxx(env, ...)`** — JMM vtable 调用模式。每个 native JNI 函数只有 1 行：`return jmm_interface->GetMemoryPoolUsage(env, pool)`。`jmm_interface` 是 `management.c:34` 定义的全局 `JmmInterface*` 指针，在 `JNI_OnLoad` 中通过 `JVM_GetManagement()` 获取。36 个函数指针通过 vtable 间接调用——JVM 内部实现变更不影响 .so。

2. **`JVM_ENTRY` vs `JVM_LEAF`** — 线程状态转换。`JVM_ENTRY` 做 `_thread_in_native → _thread_in_vm` 转换，支持 safepoint 检查和 HandleMark——可以安全访问 Java 堆和抛 Java 异常。`JVM_LEAF` 不做线程状态转换——不能访问 Java 堆，只能读 C 层全局变量。`jmm_SetBoolAttribute` 用 JVM_ENTRY（需要修改全局状态 + MutexLocker），`jmm_GetBoolAttribute` 用 JVM_LEAF（只读全局标志）。

3. **`JavaCalls::call_virtual()`** — C++ → Java 回调。当 C 层需要调用 Java MBean 的方法时（如 Sensor.trigger），使用 `JavaCalls::call_virtual(callee, THREAD)` 来构造 Java 调用帧。这个调用在 ServiceThread 中执行——不在 safepoint 内，不会阻塞应用线程。

---

## §一 3 个 .so 架构全景图

### 端到端追踪: `jconsole` 连接 → HeapMemoryUsage 查询

```
jconsole 连接 JMX agent (RMI)
  → MBeanServerConnection.getAttribute("java.lang:type=Memory", "HeapMemoryUsage")
    → sun.management.MemoryImpl.getMemoryUsage0()      [native 调用]
      → MemoryImpl.c: jmm_interface->GetMemoryUsage(env) [1 行 JNI 桥接]
        → management.cpp:738 jmm_GetMemoryUsage()      [vtable 分发]
          → 遍历 MemoryService::num_memory_pools()     [memoryService.cpp]
          → 每个 pool: pool->is_heap()? 累加 used/committed/init/max
          → MemoryService::create_MemoryUsage_obj()    [构造 Java CompositeData]
            → return jobject → jconsole 显示
```

### 架构全景图 (3 层)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              Java 层 (JMX MBeans)                                  │
│                                                                                   │
│  ┌───────────────────────┐  ┌───────────────────────┐  ┌────────────────────────┐ │
│  │ java.management        │  │ jdk.management         │  │ jdk.management.agent   │ │
│  │                        │  │                        │  │                        │ │
│  │ MemoryPoolImpl         │  │ Flag / DiagnosticCmd   │  │ FileSystemImpl         │ │
│  │ MemoryImpl             │  │ HotSpotDiagnostic      │  │  .isAccessUserOnly0()  │ │
│  │ ThreadImpl             │  │ GarbageCollectorExt    │  │                        │ │
│  │ GarbageCollectorImpl   │  │ OperatingSystemImpl    │  │                        │ │
│  │ VMManagementImpl       │  │ GcInfoBuilder          │  │                        │ │
│  │ ClassLoadingImpl       │  │                        │  │                        │ │
│  │ HotspotThread          │  │                        │  │                        │ │
│  └───────────┬────────────┘  └───────────┬────────────┘  └───────────┬────────────┘ │
│              │                           │                           │             │
│              │ native methods             │ native methods             │ native      │
└──────────────┼───────────────────────────┼───────────────────────────┼─────────────┘
               │                           │                           │
               ▼                           ▼                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                              Native 库层 (3 个 .so)                                    │
│                                                                                       │
│  ┌────────────────────────┐ ┌────────────────────────┐ ┌────────────────────────┐   │
│  │  libmanagement.so      │ │  libmanagement_ext.so  │ │  libmanagement_agent.so │   │
│  │  (10 源文件)            │ │  (8+ 源文件)            │ │  (2 源文件)             │   │
│  │                        │ │                        │ │                        │   │
│  │  JNI_OnLoad:           │ │  JNI_OnLoad:           │ │  JNI_OnLoad:           │   │
│  │   jmm_interface =      │ │   jmm_interface =      │ │   纯 JNI 版本检查       │   │
│  │   JVM_GetManagement()  │ │   JVM_GetManagement()  │ │   无 JMM interface     │   │
│  │                        │ │                        │ │                        │   │
│  │  每个 JNI 函数 = 1 行:  │ │  每个 JNI 函数 = 1 行:  │ │  stat64() + 权限位检查  │   │
│  │   jmm_interface->Xxx() │ │   jmm_interface->Xxx() │ │                        │   │
│  └───────────┬────────────┘ └───────────┬────────────┘ └────────────────────────┘   │
│              │                          │                                             │
│              │ jmm_interface 函数指针表   │  (同一个 jmm_interface 实例)                │
└──────────────┼──────────────────────────┼─────────────────────────────────────────────┘
               │                          │
               ▼                          ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                         HotSpot VM 层 (编译进 libjvm.so)                                │
│                                                                                       │
│  ┌──────────────────────────────────────────────────────────────────────────────┐    │
│  │  management.cpp (2283 行) — jmm_interface vtable + 36 JMM 函数实现               │    │
│  │  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐   │    │
│  │  │ GetMemoryPools │ │ GetThreadInfo  │ │ SetPoolThreshold│ │ SetVMGlobal    │   │    │
│  │  │ GetMemoryUsage │ │ DumpThreads    │ │ SetPoolSensor  │ │ GetVMGlobals   │   │    │
│  │  │ GetMemoryMgrs  │ │ FindDeadlocks  │ │ GetLastGCStat  │ │ ExecuteDCCmd   │   │    │
│  │  └───────┬────────┘ └───────┬────────┘ └───────┬────────┘ └───────┬────────┘   │    │
│  └──────────┼──────────────────┼──────────────────┼──────────────────┼────────────┘    │
│             │                  │                  │                  │                  │
│             ▼                  ▼                  ▼                  ▼                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                  │
│  │ memoryService│ │ threadService│ │lowMemoryDetec│ │writeableFlags│                  │
│  │ .cpp (281行) │ │ .cpp         │ │ .cpp (387行) │ │ .cpp         │                  │
│  │              │ │              │ │              │ │              │                  │
│  │ MemoryPool   │ │ ThreadSnap   │ │ SensorInfo   │ │ JVMFlag      │                  │
│  │ MemoryMgr    │ │ DeadlockCyc  │ │ ThresholdSup │ │ .find_flag() │                  │
│  │ gc_begin/end │ │ ThreadDump   │ │ detect_low_  │ │ .set_*()     │                  │
│  └──────────────┘ └──────────────┘ │ memory()     │ └──────────────┘                  │
│                                    └──────────────┘                                    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                                   │
│  │ gcNotifier   │ │classLoadingSv│ │runtimeService│                                   │
│  │ .cpp         │ │ .cpp         │ │ .cpp         │                                   │
│  │              │ │              │ │              │                                   │
│  │ push/send    │ │ notify_      │ │ safepoint    │                                   │
│  │ Notification │ │ class_loaded │ │ time tracking│                                   │
│  └──────────────┘ └──────────────┘ └──────────────┘                                   │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## §二 First-Principles Design Decisions

### 1. Why a vtable (jmm_interface) instead of direct JNI calls?

```
方案 A (直接 JNI): 每个 .so 独立注册 JNI 方法 → JVM 内部函数暴露为 JNI 入口
  问题: JNI 入口是 public API，JVM 内部实现变更会破坏所有 .so
        36 个函数 × 3 个 .so = 108 个 JNI 注册点，维护灾难

方案 B (vtable): 一个 jmm_interface 指针表 → .so 只调用函数指针
  优势: 接口与实现分离 → JVM 内部重构不影响 .so
        新增函数 = 在 vtable 末尾加一项 → 老 .so 不访问新项，二进制兼容
        JVM_GetManagement(version) → 版本检查 → 未来可返回 v2 表
```

**验证** — `management.c:47`:
```c
jmm_interface = (JmmInterface*) JVM_GetManagement(JMM_VERSION);
if (jmm_interface == NULL) {
    JNU_ThrowInternalError(env, "Unsupported Management version");
    return JNI_ERR;
}
```

`Management::get_jmm_interface(int version)` (management.cpp:2275-2282):
```cpp
if (version == JMM_VERSION) {
    return (void*) &jmm_interface;
}
return NULL;
```

**注意**: 当前 JDK 版本只接受精确的 `JMM_VERSION` (即 `JMM_VERSION_2`)，不做旧版本的向后兼容——这与 README 中 "版本检查 → 未来可返回 v2 表" 的设计意图一致，但实现上只支持当前版本。

### 2. Why GC notifications are two-phase (safepoint enqueue + async delivery)?

```
GC epilogue (safepoint 内)           ServiceThread (无 safepoint)
┌─────────────────────────┐          ┌──────────────────────────┐
│ gc_end()                │          │ sendNotification()       │
│   ├── update pool usage │          │   ├── createGcInfo()     │
│   ├── detect_after_gc() │          │   │   (构造 Java 对象)    │
│   └── pushNotification()│  入队    │   └── JavaCalls::call_   │
│       (仅入队, <1μs)    │─────────→│       virtual()          │
└─────────────────────────┘          │       (回调 MBean)       │
                                     └──────────────────────────┘
```

**原理**: safepoint 内所有 Java 线程暂停——做重量操作（构造 Java 对象、JNI 回调）会延长 STW 时间。`pushNotification()` 只在 C++ 层把 `GCNotificationRequest` 插入链表——O(1) 操作。真正的 `JavaCalls::call_virtual()` 在 ServiceThread 中执行——此时 safepoint 已结束，应用线程正常运行。

**验证** — `gcNotifier.cpp:45-60` (pushNotification — 仅链表操作):
```cpp
void GCNotifier::pushNotification(GCMemoryManager *mgr, const char *action, ...) {
    GCNotificationRequest *request = new GCNotificationRequest();
    // 填充 request 字段（纯 C++ 数据）
    addRequest(request);  // 链表插入
}
```

### 3. Why two threshold modes (Gauge vs Counter)?

```
方案 A (只用 Gauge — 每次分配后检查):
  CodeCache 分配: 每次 JIT 编译都分配 → 每秒数百次分配
  → 每次分配都遍历 pool 检查阈值 → 热路径开销不可接受
  但适合非 GC 管理的池 (CodeCache/Metaspace) — 因为它们的 usage 变化只在分配时

方案 B (只用 Counter — 仅 GC 后检查):
  CodeCache 不会 GC → Counter 模式永远不会触发 → CodeCache 满时才抛 OOM
  但适合 GC 管理的池 (Eden/Old) — GC 后 usage 才变化

方案 C (Gauge + Counter 双模式):
  Gauge → CodeCache/Metaspace (非 GC 池) → 分配热路径检查, 但频率可控
  Counter → Eden/Old (GC 池) → 仅在 GC 后检查, 开销可忽略
```

**验证** — `SensorInfo::set_gauge_sensor_level()` (lowMemoryDetector.cpp:206-239):
```
Gauge 模式: 每次 pool->record_peak_memory_usage() 后调用
  → 检查 usage.used() > high_threshold
  → 高阈值/低阈值/滞回区 三段判断
  → 在分配路径上，但仅当 pool 启用了 threshold 时才执行

Counter 模式: GC 后调用 (lowMemoryDetector.cpp:128-147)
  → 使用 pool->get_last_collection_usage() 而非 get_memory_usage()
  → 仅在 GC epilogue 中执行，开销可忽略
```

**滞回机制 (Hysteresis)** — `SensorInfo::set_gauge_sensor_level()` (lowMemoryDetector.cpp:206-239):
```
高阈值 = 80%, 低阈值 = 50%
  使用量 85% → 触发 (超过高阈值)
  使用量 60% → 无变化 (在滞回区间)
  使用量 45% → 清除 (低于低阈值)
```

没有滞回的话，使用量在 80% 上下波动时会产生通知风暴——每次 GC 或分配都会反复触发/清除。

### 4. Why two threshold types (High vs Low) on the same pool?

```
方案 A (单阈值): 只设一个阈值，如 80%
  问题: 使用量在 79%→81%→79% 振荡时 → 每次穿越 80% 都触发/清除
        → 通知风暴（10 次/秒的 minor GC × 每次触发 → 每秒数十次 JMX 通知）
        如果只触发不清除 → 应用不知道内存已恢复安全 → 持续降级

方案 B (High+Low 对): 高阈值触发 + 低阈值清除 = 滞回区间
  优势: 使用量在 79%→81%→79% 振荡时 → 仅在首次 81% 触发，降回 50% 以下才清除
        中间 50%-80% 为滞回区 → 无通知
        应用在触发时降级，清除时恢复全功能
```

**验证** — `ThresholdSupport` (lowMemoryDetector.hpp:67-70):
```cpp
class ThresholdSupport {
  size_t _high_threshold;   // 超过此值触发
  size_t _low_threshold;    // 低于此值清除
  bool   _support_high_threshold;
  bool   _support_low_threshold;
};
```

**验证** — `SensorInfo::set_gauge_sensor_level()` 中的 High/Low 逻辑 (lowMemoryDetector.cpp:206-239):
```cpp
// 触发条件: 超过高阈值 && sensor 当前 off
if (usage.used() > high_threshold && !_sensor_on) { trigger(); }
// 清除条件: 低于低阈值 && sensor 当前 on
if (usage.used() < low_threshold && _sensor_on) { clear(); }
// 滞回区: low < usage < high → 无操作
```

### 5. Why `libmanagement_agent.so` has no JMM interface?

`libmanagement_agent.so` 只包含一个 JNI 函数：`FileSystemImpl.isAccessUserOnly0()`。它检查 JMX agent 的配置文件（`management.properties`）权限——确保只有 owner 可读写。这是一个纯 POSIX 操作 (`stat64` + 权限位)，不需要访问任何 JVM 内部状态。

**验证** — `FileSystemImpl.c:42-58`:
```c
struct stat64 sb;
if (stat64(path, &sb) == 0) {
    return (sb.st_mode & (S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH)) == 0;
}
```

---

## §三 源文件总表 — 完整清单

### 3.1 libmanagement.so — 10 个源文件

**路径**: `src/java.management/share/native/libmanagement/`

| 文件 | 行数 | 核心 JNI 函数 | 功能 |
|------|:---:|------|------|
| `management.c` | ~60 | `DEF_JNI_OnLoad` | 库入口，获取 jmm_interface 指针 |
| `management.h` | ~40 | — | 公共头文件 + jmm_interface 全局指针声明 |
| `MemoryPoolImpl.c` | ~145 | `getMemoryManagers0`, `getUsage0`, `getPeakUsage0`, `setUsageThreshold0`, `setCollectionThreshold0`, `resetPeakUsage0`, `setPoolUsageSensor`, `setPoolCollectionSensor`, `getCollectionUsage0` | MemoryPoolMXBean JNI 桥接 (9 函数) |
| `MemoryManagerImpl.c` | ~60 | `getMemoryPools0` | MemoryManagerMXBean JNI 桥接 |
| `MemoryImpl.c` | ~130 | `setVerboseGC`, `getMemoryPools0`, `getMemoryManagers0`, `getMemoryUsage0` | MemoryMXBean JNI 桥接 |
| `GarbageCollectorImpl.c` | ~50 | `getCollectionCount`, `getCollectionTime` | GarbageCollectorMXBean JNI 桥接 |
| `ThreadImpl.c` | ~151 | `getThreadInfo1`, `getThreads`, `getThreadTotalCpuTime0`, `getThreadTotalCpuTime1`, `getThreadUserCpuTime0`, `getThreadUserCpuTime1`, `getThreadAllocatedMemory0`, `getThreadAllocatedMemory1`, `findMonitorDeadlockedThreads0`, `findDeadlockedThreads0`, `dumpThreads0`, `setThreadContentionMonitoringEnabled0`, `setThreadCpuTimeEnabled0`, `setThreadAllocatedMemoryEnabled0`, `resetPeakThreadCount0`, `resetContentionTimes0` | ThreadMXBean JNI 桥接 (16 函数) |
| `HotspotThread.c` | ~60 | `getInternalThreadCount`, `getInternalThreadTimes0` | 内部线程统计 |
| `ClassLoadingImpl.c` | ~40 | `setVerboseClass` | ClassLoadingMXBean JNI 桥接 |
| `VMManagementImpl.c` | ~200 | `getVersion0`, `initOptionalSupportFields`, `getVmArguments0`, `getTotalClassCount`, `getUnloadedClassCount`, `getVerboseGC`, `getVerboseClass`, `getTotalThreadCount`, `getLiveThreadCount`, `getPeakThreadCount`, `getDaemonThreadCount`, `getTotalCompileTime`, `getStartupTime`, `getUptime0`, `isThreadContentionMonitoringEnabled`, `isThreadCpuTimeEnabled`, `isThreadAllocatedMemoryEnabled`, `getProcessId`, `getAvailableProcessors`, `getSafepointCount`, `getTotalSafepointTime`, `getSafepointSyncTime`, `getTotalApplicationNonStoppedTime`, `getLoadedClassSize`, `getUnloadedClassSize`, `getClassLoadingTime`, `getMethodDataSize`, `getInitializedClassCount`, `getClassInitializationTime`, `getClassVerificationTime` | VMManagement MXBean (28 函数) |

### 3.2 libmanagement_ext.so — 8+ 个源文件

**路径**: `src/jdk.management/share/native/libmanagement_ext/` + 平台目录

| 文件 | 行数 | 核心 JNI 函数 | 功能 |
|------|:---:|------|------|
| `management_ext.c` | ~60 | `DEF_JNI_OnLoad` | 库入口 |
| `management_ext.h` | ~40 | — | 公共头文件 |
| `Flag.c` | ~244 | `getInternalFlagCount`, `initialize`, `getFlags`, `setLongValue`, `setDoubleValue`, `setBooleanValue`, `setStringValue` | VM flag 读写 (jinfo 底层) |
| `DiagnosticCommandImpl.c` | ~130 | `getDiagnosticCommands`, `getDiagnosticCommandInfo`, `setNotificationEnabled`, `executeDiagnosticCommand` | jcmd 命令的 JMX 接口 (4 函数) |
| `HotSpotDiagnostic.c` | ~60 | `dumpHeap0` | Heap dump 触发 |
| `GarbageCollectorExtImpl.c` | ~50 | `setNotificationEnabled` | GC 通知开关 |
| `GcInfoBuilder.c` | ~120 | `getNumGcExtAttributes`, `fillGcAttributeInfo`, `getLastGcInfo0` | GC 扩展属性 |
| `OperatingSystemImpl.c` (unix) | ~470 | `initialize0`, `getCommittedVirtualMemorySize0`, `getTotalSwapSpaceSize0`, `getFreeSwapSpaceSize0`, `getProcessCpuTime0`, `getFreePhysicalMemorySize0`, `getTotalPhysicalMemorySize0`, `getOpenFileDescriptorCount0`, `getMaxFileDescriptorCount0` | OS 指标查询 — Linux/macOS/Solaris/AIX 共享 |
| `OperatingSystemImpl.c` (windows) | ~300 | `initialize0`, `getCommittedVirtualMemorySize0`, `getTotalSwapSpaceSize0`, `getFreeSwapSpaceSize0`, `getProcessCpuTime0`, `getFreePhysicalMemorySize0`, `getTotalPhysicalMemorySize0`, `getOpenFileDescriptorCount0`, `getMaxFileDescriptorCount0`, `getSystemCpuLoad0`, `getProcessCpuLoad0` | OS 指标查询 — Windows (CPU load 内联) |
| `UnixOperatingSystem.c` (linux) | ~200 | `getSystemCpuLoad0`, `getProcessCpuLoad0`, `getSingleCpuLoad0`, `getHostConfiguredCpuCount0`, `getHostTotalCpuTicks0`, `getHostOnlineCpuCount0` | CPU load — Linux `/proc/stat` 解析 |
| `UnixOperatingSystem.c` (macosx) | ~150 | 同上 | CPU load — macOS `host_processor_info` |
| `UnixOperatingSystem.c` (aix) | ~150 | 同上 | CPU load — AIX `perfstat_cpu` |
| `UnixOperatingSystem.c` (solaris) | ~150 | 同上 | CPU load — Solaris `kstat` |

### 3.3 libmanagement_agent.so — 2 个源文件

**路径**: `src/jdk.management.agent/`

| 文件 | 行数 | 核心 JNI 函数 | 功能 |
|------|:---:|------|------|
| `unix/native/libmanagement_agent/FileSystemImpl.c` | ~75 | `isAccessUserOnly0` | `stat64` 检查文件权限 — 无 JMM interface |
| `windows/native/libmanagement_agent/FileSystemImpl.c` | ~60 | `isAccessUserOnly0` | Windows 版权限检查 |

### 3.4 HotSpot Services 层 (编译进 libjvm.so)

| 文件 | 行数 | 核心符号 | 功能 |
|------|:---:|------|------|
| `src/hotspot/share/services/management.cpp` | 2283 | `management_init`, `Management::init/initialize/get_jmm_interface/get_optional_support/record_vm_startup_time`, `jmm_interface`, `jmm_GetMemoryPools`, `jmm_GetThreadInfo`, `jmm_SetPoolThreshold`, `jmm_SetVMGlobal`, `jmm_DumpThreads`, `jmm_ExecuteDiagnosticCommand` | JMM 接口核心实现 — 36 个 jmm_* 函数 + 初始化入口 |
| `src/hotspot/share/services/memoryService.cpp` | 281 | `MemoryService::set_universe_heap`, `gc_begin`, `gc_end`, `add_code_heap_memory_pool`, `add_metaspace_memory_pools`, `track_memory_usage`, `set_verbose` | 内存池/管理器注册 + GC 回调 |
| `src/hotspot/share/services/lowMemoryDetector.cpp` | 387 | `SensorInfo::set_gauge_sensor_level`, `set_counter_sensor_level`, `trigger`, `clear`, `process_pending_requests`, `LowMemoryDetector::detect_low_memory`, `detect_after_gc_memory`, `recompute_enabled_for_collected_pools` | 阈值检测 + Sensor 回调 |
| `src/hotspot/share/services/memoryManager.cpp` | ~280 | `GCMemoryManager::gc_begin`, `gc_end`, `initialize_gc_stat_info` | GC 管理器实现 |
| `src/hotspot/share/services/memoryPool.cpp` | ~300 | `MemoryPool::get_memory_usage`, `record_peak_memory_usage`, `set_threshold` | 内存池基类 |
| `src/hotspot/share/services/threadService.cpp` | ~900 | `ThreadService::dump_stack_traces`, `find_deadlocks_at_safepoint`, `ThreadSnapshot`, `DeadlockCycle` | 线程 dump + 死锁检测 |
| `src/hotspot/share/services/classLoadingService.cpp` | ~100 | `ClassLoadingService::notify_class_loaded/unloaded`, `compute_class_size` | 类加载计数 |
| `src/hotspot/share/services/runtimeService.cpp` | ~100 | `RuntimeService::record_safepoint_begin/end` | Safepoint 时间追踪 |
| `src/hotspot/share/services/gcNotifier.cpp` | ~200 | `GCNotifier::pushNotification`, `sendNotification`, `sendNotificationInternal` | GC 事件通知 |
| `src/hotspot/share/services/writeableFlags.cpp` | ~300 | `WriteableFlags::set_flag`, `set_flag_from_jvalue` | Flag 动态写入 |
| `src/hotspot/share/services/diagnosticCommand.cpp` | ~800 | `DCmdRegistrant::register_dcmds`, `DCmd::parse_and_execute` | DCmd 命令实现 (被 jmm_ExecuteDiagnosticCommand 调用) |

### 3.5 头文件 (接口定义)

| 文件 | 关键定义 |
|------|---------|
| `src/hotspot/share/services/management.hpp` | `Management` 类声明 |
| `src/hotspot/share/services/memoryService.hpp` | `MemoryService`, `TraceMemoryManagerStats`, `MemoryPool` 子类 |
| `src/hotspot/share/services/memoryPool.hpp` | `MemoryPool`, `CollectedMemoryPool`, `CodeHeapPool`, `MetaspacePool` |
| `src/hotspot/share/services/memoryManager.hpp` | `MemoryManager`, `GCMemoryManager`, `GCStatInfo` |
| `src/hotspot/share/services/lowMemoryDetector.hpp` | `ThresholdSupport`, `SensorInfo`, `LowMemoryDetector`, `LowMemoryDetectorDisabler` |
| `src/hotspot/share/services/threadService.hpp` | `ThreadService`, `ThreadSnapshot`, `ThreadStackTrace`, `DeadlockCycle` |
| `src/hotspot/share/services/gcNotifier.hpp` | `GCNotificationRequest`, `GCNotifier` |
| `src/hotspot/share/services/classLoadingService.hpp` | `ClassLoadingService` |
| `src/hotspot/share/services/runtimeService.hpp` | `RuntimeService` |
| `src/hotspot/include/jmm.h` | `JmmInterface` struct (36 函数指针, 37 槽位含 2 reserved), `jmmOptionalSupport`, `jmmLongAttribute`, `jmmBoolAttribute`, `jmmVMGlobal` |

---

## §四 文档规划

### 文档拆分方案 (5 篇)

```
17-jmx-management/
├── README.md                          ← 总览 + 架构 + 规划 (本文档)
├── 00-what-is-jmx.md                  ← JMX 是什么？从 jconsole/jcmd 工具视角切入
├── 01-management-jmm-interface.md     ← jmm_interface vtable + management.cpp 完整分析
├── 02-memory-pool-threshold.md        ← MemoryPool/MemoryService/LowMemoryDetector
├── 03-thread-monitoring.md            ← ThreadImpl + ThreadService + deadlock detection
└── 04-os-flag-diagnostic.md           ← Flag/DiagnosticCommand/OS metrics + libmanagement_agent
```

### 文档内容映射

#### 00-what-is-jmx.md — JMX 是什么？

| 章节 | 内容 |
|------|------|
| 工具场景 | jconsole 查询 HeapMemoryUsage 的端到端路径、jcmd/jinfo/jstack 和 JMX 的关系 |
| JMX 核心概念 | MBean/MBeanServer/JMX Connector 的直观类比（汽车仪表盘 → OBD-II 接口） |
| 10 个 MBean 能力矩阵 | 标准 MXBean (8 个) + 扩展 MXBean (5 个) 的属性和操作 |
| JVM 启动初始化 | management_init → Management::init → Management::initialize 的 Java 层加载 |
| jconsole 连接流程 | RMI 握手 → 轮询 MBean → native 调用 → C++ 数据返回 |
| 两条数据通路 | JMX Connector (jconsole) vs Attach API (jcmd) — 区别和汇合点 |
| 3 个 .so 角色 | libmanagement.so (标准仪表盘) / libmanagement_ext.so (高级诊断) / libmanagement_agent.so (权限检查) |

#### 01-management-jmm-interface.md — JMM 接口核心

| 章节 | 内容 | 源文件 |
|------|------|--------|
| 架构 | jmm_interface vtable 完整表 (36 函数指针, 37 槽位) | management.cpp:2232-2272, jmm.h:221-342 |
| JVM_ENTRY vs JVM_LEAF | 两种进入宏的线程状态转换对比 | interfaceSupport.inline.hpp:558-603 |
| JNI_OnLoad 流程 | 3 个 .so 如何获取 jmm_interface | management.c:39-55, management_ext.c |
| GetMemoryPools/Managers | pool/manager 的双向查找实现 | management.cpp:502-584 |
| GetMemoryUsage | 堆/非堆聚合使用量计算 | management.cpp:738-788 |
| GetBoolAttribute/SetBoolAttribute | VerboseGC/VerboseClass/Thread monitoring 开关 | management.cpp:791-826 |
| GetLongAttribute | JMM_VM_GLOBAL_COUNT/JMM_JAVA_VM_INIT_DONE 等 | management.cpp:829-870 |
| GetLongAttributes | 批量获取 long 属性 (性能优化) | management.cpp:872-940 |
| initOptionalSupportFields | 可选能力位图填充 | VMManagementImpl.c:55-80 |
| Management::initialize | 加载 Java MXBean 类 + 注册 DCmd | management.cpp:174-220 |

#### 02-memory-pool-threshold.md — 内存池与阈值

| 章节 | 内容 | 源文件 |
|------|------|--------|
| 内存池类型体系 | MemoryPool → CollectedMemoryPool/CodeHeapPool/MetaspacePool/CompressedKlassSpacePool | memoryPool.hpp:45-180 |
| 内存管理器 | MemoryManager → GCMemoryManager (count + time + notification) | memoryManager.hpp:47-155 |
| MemoryService 初始化 | set_universe_heap → add_code_heap_pool → add_metaspace_pools | memoryService.cpp:70-124 |
| GC 回调机制 | gc_begin/gc_end + TraceMemoryManagerStats RAII | memoryService.cpp:167-280 |
| 阈值设置 | jmm_SetPoolThreshold → ThresholdSupport | management.cpp:676-734 |
| Sensor 绑定 | jmm_SetPoolSensor → pool->set_usage_sensor_obj | management.cpp:633-665 |
| 滞回检测 | SensorInfo::set_gauge_sensor_level / set_counter_sensor_level | lowMemoryDetector.cpp:206-277 |
| 通知触发 | SensorInfo::trigger/clear → JavaCalls::call_virtual → Sensor.trigger/clear | lowMemoryDetector.cpp:283-374 |
| 禁用机制 | LowMemoryDetectorDisabler RAII | lowMemoryDetector.hpp:280-291 |
| GC 通知 | GCNotifier::pushNotification/sendNotification | gcNotifier.cpp:45-200 |
| JNI 桥接层 | MemoryPoolImpl.c / MemoryImpl.c / GarbageCollectorImpl.c | 全部 native 源文件 |

#### 03-thread-monitoring.md — 线程监控

| 章节 | 内容 | 源文件 |
|------|------|--------|
| ThreadImpl JNI 桥接 | 15 个 JNI 函数 → jmm_interface 映射 | ThreadImpl.c:1-151 |
| getThreadInfo 双路径 | maxDepth==0 (无需 safepoint) vs maxDepth!=0 (VM_ThreadDump) | management.cpp:1077-1160 |
| 全部线程 dump | jmm_DumpThreads → VM_ThreadDump → safepoint | management.cpp:1173-1303 |
| 栈帧遍历 | 提取 locked monitors + JNI locked monitors + synchronizers | management.cpp:1204-1290 |
| CPU 时间查询 | jmm_GetThreadCpuTime → OSThread 的 cpu_time() | management.cpp:960-1020 |
| 线程分配内存 | jmm_GetThreadAllocatedMemory → ThreadService | management.cpp:1030-1060 |
| 死锁检测 | FindMonitorDeadlockedThreads vs FindDeadlockedThreads | threadService.cpp |
| 内部线程 | getInternalThreadCount/Times → VMThread/ConcurrentGCThread 等 | HotspotThread.c |
| ThreadSnapshot/DeadlockCycle | 数据结构与算法 | threadService.hpp:191-420 |

#### 04-os-flag-diagnostic.md — Flag/OS/诊断命令/Agent

| 章节 | 内容 | 源文件 |
|------|------|--------|
| Flag 管理 | getFlags/setLongValue/setBooleanValue → jmm_interface | Flag.c:1-244 |
| jmmVMGlobal 结构 | type/origin/value/writeable 字段映射 | jmm.h:161-220, Flag.c:83-203 |
| WriteableFlags | set_flag → 类型分发 → JVMFlag::set_* | writeableFlags.cpp:238-350 |
| Flag Origin 枚举 | DEFAULT/COMMAND_LINE/ENVIRON_VAR/CONFIG_FILE/MANAGEMENT/ERGONOMIC/ATTACH_ON_DEMAND | Flag.c:34-42 |
| OS 指标查询 | 物理内存/Swap/文件描述符/CPU load → 5 平台差异 | OperatingSystemImpl.c (unix, 470行) |
| /proc/self/stat 解析 | 虚拟内存字段 (字段 23) | OperatingSystemImpl.c:127 |
| /proc/self/fd 遍历 | 打开文件描述符计数 | OperatingSystemImpl.c:220-250 |
| sysinfo() 调用 | Swap 空间查询 | OperatingSystemImpl.c:170-195 |
| CPU load 查询 | /proc/stat 解析 + 差值计算 | UnixOperatingSystem.c |
| 诊断命令 | getDiagnosticCommands/executeDiagnosticCommand → DCmd | DiagnosticCommandImpl.c |
| Heap dump | dumpHeap0 → JVM_DumpHeap | HotSpotDiagnostic.c |
| GC 扩展属性 | GcInfoBuilder → getLastGcInfo0 | GcInfoBuilder.c |
| Agent 权限检查 | stat64 + S_IRGRP/S_IWGRP/S_IROTH/S_IWOTH | FileSystemImpl.c (unix) |

---

## §五 关键调用链

### 5.1 jmm_interface 获取与调用链

```
Java: MBeanServer.getAttribute(objectName, "HeapMemoryUsage")
  → sun.management.MemoryImpl.getMemoryUsage0()    [native]
    → MemoryImpl.c: getMemoryUsage0()              [JNI]
      → jmm_interface->GetMemoryUsage(env)         [vtable 调用]
        → jmm_GetMemoryUsage()                     [management.cpp:738]
          → MemoryService::get_memory_pool()       [遍历 _pools_list]
          → pool->get_memory_usage()               [返回 MemoryUsage 结构]
          → MemoryService::create_MemoryUsage_obj() [构造 Java MemoryUsage]
            → return jobject (HeapMemoryUsage)
```

### 5.2 GC 结束到 JMX 通知完整路径

```
GC epilogue (safepoint 内):
  ~TraceMemoryManagerStats                       [memoryService.cpp:277]
    → MemoryService::gc_end()                    [memoryService.cpp:182]
      → GCMemoryManager::gc_end()                [memoryManager.cpp:244]
        ├── GCStatInfo::set_after_gc_usage()      [记录 GC 后 usage — memoryManager.cpp:269]
        ├── detect_after_gc_memory(pool)         [lowMemoryDetector.cpp:128]
        │     → set_counter_sensor_level()       [检查 GC 后阈值]
        │     → Service_lock->notify_all()       [唤醒 ServiceThread]
        └── if (countCollection):                [memoryManager.cpp:285 — 仅完整 GC]
              GCNotifier::pushNotification()       [gcNotifier.cpp:45]
              → addRequest()                     [链表插入 — O(1)]

异步 (ServiceThread):
  ServiceThread::service_thread_entry()          [serviceThread.cpp:90]
    ├── GCNotifier::sendNotification()           [gcNotifier.cpp:165]
    │     → sendNotificationInternal()           [gcNotifier.cpp:189]
    │       → createGcInfo()                     [构造 GcInfo Java 对象]
    │       → JavaCalls::call_virtual()          [回调 MBean]
    └── LowMemoryDetector::process_sensor_changes() [lowMemoryDetector]
          → SensorInfo::trigger() / clear()      [Java 回调]
            → JavaCalls::call_virtual → Sensor.trigger/clear
              → MemoryPoolImpl.triggerAction()   [Java 层]
                → MemoryImpl.createNotification() → sendNotification
```

### 5.3 Flag 设置三条路径汇合

```
JMX (com.sun.management):
  Flag.setLongValue(name, value)
    → Flag.c: jmm_interface->SetVMGlobal(env, name, v)
      → jmm_SetVMGlobal()                        [management.cpp:1601]

jcmd (attach API):
  AttachListener: jcmd <pid> VM.set_flag name value
    → attachListener.cpp:292
      → WriteableFlags::set_flag(name, value, ATTACH_ON_DEMAND)

DiagnosticCommand (JMX):
  DiagnosticCommandImpl.executeDiagnosticCommand("VM.set_flag name value")
    → diagnosticCommand.cpp:277
      → WriteableFlags::set_flag(name, value, MANAGEMENT)

                          ↓ 三路汇合
  WriteableFlags::set_flag()                     [writeableFlags.cpp:238]
    → JVMFlag::find_flag(name)                   [全局 flags[] 数组查找]
    → JVMFlag::is_writeable()                    [权限检查]
    → set_flag_from_jvalue()                     [writeableFlags.cpp:298]
        → 类型分发:
            is_bool  → set_bool_flag()
            is_intx  → set_intx_flag()
            is_ccstr → set_ccstr_flag()
            ...
```

### 5.4 线程 dump 的双路径

```
指定线程 ID (无需全局 safepoint):
  jmm_GetThreadInfo(ids, maxDepth)
    → do_thread_dump()                           [management.cpp:1026]
      → ThreadsListHandle (轻量线程列表快照)
      → 逐个: Thread::find_java_thread_from_java_tid()
      → JavaThread::stack_trace_snapshot()       [单线程栈快照]

全部线程 (需要 safepoint):
  jmm_DumpThreads(NULL, ...)                     [management.cpp:1173]
    → VM_ThreadDump op                           [vmOperations.cpp:273]
      → VMThread::execute(&op)                   [进入 VMOperationQueue]
        → safepoint → VM_ThreadDump::doit()
          → Threads::threads_do()                [遍历所有线程]
            → JavaThread::stack_trace_snapshot()  [逐线程栈快照]
          → 提取 locked monitors / JNI monitors / synchronizers
```

### 5.5 Management 初始化流程 (VM 启动时)

```
JVM 启动 — 早期初始化 (init.cpp:119):
  management_init()                               [management.cpp:84]
    → Management::init()                          [management.cpp:97]
      ├── PerfDataManager::create_long_counter()  [创建性能计数器]
      │     ├── sun.rt.createVmBeginTime
      │     ├── sun.rt.createVmEndTime
      │     └── sun.rt.vmInitDoneTime
      ├── _optional_support 位域填充
      └── DCmdRegistrant::register_dcmds()        [注册 jcmd 命令]

JVM 启动 — Java 层初始化 (thread.cpp:4291):
  Management::initialize(THREAD)                  [management.cpp:174]
    ├── Management::load_and_initialize_klass()   [management.cpp:204]
    │     → SystemDictionary::resolve()           [加载 MXBean 类]
    │         ├── java.lang.management.MemoryMXBean
    │         ├── java.lang.management.ThreadMXBean
    │         └── ... (全部 MXBean 接口)
    ├── Management::initialize_klass()            [management.cpp:217]
    │     → InstanceKlass::initialize()           [执行 <clinit>]
    └── 如果启用 JMX agent:
          → JavaCalls::call_static()              [调用 Java 层]
            → jdk.internal.agent.Agent.startAgent()
              → ConnectorBootstrap.startRemoteConnectorServer()
                → JMX RMI Connector 启动
```

---

## §六 生产场景诊断

### 场景 1: JMX 调用导致 STW 时间异常

**现象**: GC 日志显示 safepoint 时间增加，与 JMX 轮询频率相关。

**根因**: `jmm_GetThreadInfo` 指定 `maxDepth > 0` 时触发 `VM_ThreadDump`，需要全局 safepoint。如果监控系统每秒调用 `ThreadMXBean.getThreadInfo()` 获取所有线程栈，每次 dump 在 safepoint 内遍历所有线程栈帧。

**诊断**:
```bash
# 检查 safepoint 时间
jcmd <pid> VM.safepoint_statistics

# 查看线程 dump 频率
jstack <pid> | grep "at sun.management.ThreadImpl.dumpThreads0"

# 检查 JMX 连接数
jcmd <pid> ManagementAgent.status
```

**缓解**:
- 使用 `maxDepth=0` (仅获取线程信息，不获取栈帧 — 无需 safepoint)
- 减小轮询频率
- 使用 `jmm_DumpThreads(指定IDs)` 替代全量 dump

### 场景 2: MemoryPool 阈值通知风暴

**现象**: 应用频繁收到 `MemoryNotificationInfo` 通知，CPU 使用率升高。

**根因**: 阈值设置不当——high threshold 和 low threshold 之间没有足够的滞回区间，或者阈值设置得太接近正常使用量，导致每次 minor GC 都在边界振荡。

**诊断**:
```bash
# 查看阈值设置
jcmd <pid> VM.flags | grep -E "GCHeapFreeLimit|GCTimeLimit"

# JMX 查看 pool 使用量
jconsole → MBeans → java.lang → MemoryPool → UsageThreshold
```

**修复**:
- 增大 high-low 阈值差距（滞回区间）
- 设置 `UsageThreshold` 为 `MaxHeapSize * 0.9`（仅真正危险时才触发）

### 场景 3: /proc/self/fd 遍历开销

**现象**: `OperatingSystemMXBean.getOpenFileDescriptorCount()` 调用耗时异常。

**根因**: Linux 上通过 `readdir("/proc/self/fd")` 遍历目录条目计数。如果进程打开了大量文件描述符（如 10,000+），每次调用都要遍历所有条目。

**诊断**:
```bash
# 查看当前 fd 数量
ls /proc/<pid>/fd | wc -l

# 检查 ulimit
ulimit -n

# strace 验证
strace -e readdir jcmd <pid> VM.system_properties 2>&1 | grep "/proc/self/fd"
```

### 场景 4: jinfo 修改 flag 失败

**现象**: `jinfo -flag +PrintGCDetails <pid>` 返回错误。

**根因**: Flag 是 `develop` 或 `notproduct` 类型 → `JVMFlag::is_constant_in_binary()` 在 product 构建中返回 true → `WriteableFlags::set_flag` 返回 `NOT_WRITEABLE`。注意: product 类型 flag (如 `PrintGCDetails`) 在 product 构建中是可写的——只有 develop/notproduct flag 不可写。

**诊断**:
```bash
# 检查 flag 类型
jcmd <pid> VM.flags -all | grep TraceClassLoading

# product 构建中 develop/notproduct flag 不可见
java -XX:+UnlockDiagnosticVMOptions -XX:+PrintFlagsFinal | grep TraceClassLoading
```

---

## §七 文档质量审计矩阵

| 审计项 | 标准 | 状态 |
|--------|------|:---:|
| 源文件全覆盖 | 3 个 .so 的所有 native 源文件 + HotSpot services 层全部列在 §三 | ✅ |
| 关键函数覆盖 | 36 个 jmm_* 函数 + 9 个 SensorInfo 方法 + 5 个 GCNotifier 方法 + 10 个 WriteableFlags 方法 | ⬜ |
| 所有 syscall | stat64, fcntl, getrlimit, sysinfo, sysconf, readdir, times, pipe | ⬜ |
| 所有 /proc | /proc/self/stat (字段23), /proc/self/fd (遍历计数), /proc/stat (CPU ticks) | ⬜ |
| 边缘场景 | 线程已终止时 ThreadInfo=NULL, sensor 竞态, flag 锁保护 | ⬜ |
| 诊断工具 | jcmd/jinfo/jstack/jconsole 与 JMM 的对应关系 | ⬜ |
| 反事实 | 如果没有 ServiceThread 异步化 → STW 时间, 如果没有滞回 → 通知风暴 | ⬜ |

---

## §八 深层问题 (12 题，5 层)

| 层 | 编号 | 问题 | 难度 |
|---|:---:|------|:---:|
| **1. jmm_interface** | Q1 | `jmm_interface` 为什么设计成 C 风格 vtable 而不是 C++ 虚函数？如果改成虚函数会有什么问题？ | 🥉 |
| | Q2 | `JVM_ENTRY` 和 `JVM_LEAF` 的区别是什么？为什么 `jmm_SetBoolAttribute` 用 `JVM_ENTRY` 而 `jmm_GetBoolAttribute` 用 `JVM_LEAF`？ | 🥉 |
| | Q3 | `management.c:47` 的 `JVM_GetManagement(JMM_VERSION)` 版本号有什么用？如果版本不匹配会怎样？ | 🥉 |
| **2. 内存池阈值** | Q4 | `MemoryPool` 的 4 个子类在阈值行为上有什么不同？哪个子类同时支持 UsageThreshold 和 CollectionUsageThreshold？ | 🥈 |
| | Q5 | `SensorInfo::set_gauge_sensor_level` 和 `set_counter_sensor_level` 的滞回逻辑有什么不同？为什么需要两种模式？ | 🥈 |
| | Q6 | `LowMemoryDetectorDisabler` 在什么场景下使用？GC 过程中禁用检测会导致阈值漏触发吗？ | 🥈 |
| **3. 线程监控** | Q7 | `jmm_GetThreadInfo` 在 `maxDepth==0` 时为什么不需要 safepoint？`ThreadsListHandle` 如何保证线程列表一致性？ | 🥇 |
| | Q8 | `FindDeadlockedThreads` 和 `FindMonitorDeadlockedThreads` 的区别是什么？JSR-166 synchronizer 死锁检测怎么实现的？ | 🥇 |
| | Q9 | `jmm_DumpThreads` 中 locked monitors 的深度如何确定？JNI locked monitors 为什么深度是 -1？ | 🥇 |
| **4. 跨系统集成** | Q10 | `WriteableFlags::set_flag` 被 JMX / attach / DCmd 三个入口共享，各自的 `JVMFlag::FlagOrigin` 值是什么？有什么安全含义？ | 💎 |
| | Q11 | `jmm_GetThreadInfo` 的 `maxDepth==0` 和 `maxDepth==-1` 的区别是什么？为什么 C 层用 jint 而不是 enum？ | 💎 |
| **5. 运行时影响** | Q12 | `GCNotifier::pushNotification` 只在 safepoint 内插入链表——如果通知处理失败（ServiceThread OOME），通知会丢失还是阻塞？GC 会继续吗？ | 🔮 |

---

## §九 跨 Phase 连接

### 数据流向

```
Phase 06 (GC Core)
  └── CollectedHeap::do_collection() → gc_begin/gc_end 回调
        └── Phase 17: MemoryService::gc_begin/gc_end
              └── LowMemoryDetector::detect_after_gc_memory
              └── GCNotifier::pushNotification

Phase 03 (Object Model)
  └── oop → instanceOop → JavaCalls::call_virtual
        └── Phase 17: SensorInfo::trigger → JavaCalls → Sensor.trigger(MemoryUsage)

Phase 09 (JNI Interface)
  └── JNI_ENTRY / JVM_ENTRY / JVM_LEAF 宏
        └── Phase 17: management.cpp 所有 jmm_* 函数

Phase 15 (Core Native)
  └── JVM_GetManagement → Management::get_jmm_interface
        └── Phase 17: management.c JNI_OnLoad

Phase 18 (Agent & Instrument)
  └── libattach.so → AttachListener → WriteableFlags::set_flag
        └── Phase 17: jmm_SetVMGlobal → WriteableFlags::set_flag (共享路径)
```

### 输入 (Phase 17 依赖)
| 依赖 Phase | 依赖内容 |
|-----------|---------|
| 06-gc-core | CollectedHeap::do_collection 调用 gc_begin/gc_end |
| 05-jit-compiler | CompilerBroker 的编译统计 (jmm_GetTotalCompileTime 读取) |
| 07-runtime | SafepointSynchronize 统计 (jmm_GetSafepointCount/Time 读取) |
| 03-object-model | oop 操作，JavaCalls::call_virtual |
| 09-native-interface | JVM_ENTRY/JVM_LEAF 宏定义 |
| 15-core-native | JVM_GetManagement 入口函数 |

### 输出 (Phase 17 提供给后续)
| 后续 Phase | 提供内容 |
|-----------|---------|
| 18-agent-instrument | WriteableFlags::set_flag 共享路径，jmm_interface |
| 19-jvmti | jmm_interface 与 JVMTI 的对比 (两者都暴露 JVM 状态) |
| 诊断工具链 | jcmd/jinfo/jstack/jconsole 的 native 底层 |

---

## §十 文档编写清单 — 5 篇子文档的源文件映射

### 00-what-is-jmx.md

| 源文件 | 关键内容 |
|--------|---------|
| `MemoryImpl.java` | getHeapMemoryUsage() → native getMemoryUsage0 (jconsole 查询入口) |
| `Agent.java` | startAgent() → ConnectorBootstrap.startRemoteConnectorServer (JMX agent 启动) |
| `PlatformMBeanProviderImpl.java` | 注册 5 个 PlatformComponent (MXBean 注册入口) |
| `module-info.java` | java.management 模块导出包 (sun.management 仅对 jdk.jconsole/jdk.management 导出) |
| `ConnectorBootstrap.java` | RMI connector 创建 (jmxremote.port 配置) |
| `VMManagement.java` | VMManagement 接口 — 57+ JVM 内部状态查询方法 |

### 01-management-jmm-interface.md

| 源文件 | 关键内容 |
|--------|---------|
| `management.cpp` | jmm_interface vtable (2232-2272), get_jmm_interface (2275-2282), jmm_GetMemoryPools (502-584), jmm_GetMemoryManagers (546-584), jmm_GetMemoryUsage (738-788), jmm_GetBoolAttribute (791-826), jmm_GetLongAttribute (829-870), Management::initialize (174-220) |
| `management.h` | Management 类声明, _optional_support 字段 |
| `jmm.h` | JmmInterface struct (221-342), jmmOptionalSupport (57-68), jmmLongAttribute (70-107), jmmBoolAttribute (109-119) |
| `management.c` | JNI_OnLoad → JVM_GetManagement (39-55) |
| `management_ext.c` | JNI_OnLoad → JVM_GetManagement |
| `interfaceSupport.inline.hpp` | JVM_ENTRY (558-580), JVM_LEAF (603-620) |

### 02-memory-pool-threshold.md
|--------|---------|
| `memoryService.cpp` | set_universe_heap (70-91), add_code_heap_memory_pool (93-108), add_metaspace_memory_pools (110-124), gc_begin (167-180), gc_end (182-190), set_verbose (205-216), TraceMemoryManagerStats (234-280) |
| `memoryPool.cpp` | get_memory_usage, record_peak_memory_usage, set_threshold |
| `memoryManager.cpp` | GCMemoryManager::gc_begin, gc_end, initialize_gc_stat_info |
| `lowMemoryDetector.cpp` | detect_low_memory (81-147), set_gauge_sensor_level (206-239), set_counter_sensor_level (261-277), trigger (293-343), clear (345-374), process_pending_requests (283-291), recompute_enabled (150-161) |
| `gcNotifier.cpp` | pushNotification (45-60), sendNotification (165-185), sendNotificationInternal (189-200) |
| `management.cpp` | jmm_SetPoolSensor (633-665), jmm_SetPoolThreshold (676-734), jmm_GetPoolCollectionUsage (588-630) |
| `MemoryPoolImpl.c` | getUsage0, getPeakUsage0, setUsageThreshold0, setCollectionThreshold0, setPoolUsageSensor, setPoolCollectionSensor, getCollectionUsage0 |
| `MemoryImpl.c` | setVerboseGC, getMemoryPools0, getMemoryManagers0, getMemoryUsage0 |
| `GarbageCollectorImpl.c` | getCollectionCount, getCollectionTime |

### 03-thread-monitoring.md

| 源文件 | 关键内容 |
|--------|---------|
| `management.cpp` | jmm_GetThreadInfo (1077-1160), jmm_DumpThreads (1173-1303), jmm_GetThreadCpuTimeWithKind (960-1000), jmm_GetThreadAllocatedMemory (1030-1060), jmm_FindDeadlockedThreads (1310-1360), jmm_FindMonitorDeadlockedThreads (1370-1420), create_thread_info_instance (helper 函数) |
| `threadService.cpp` | dump_stack_traces, find_deadlocks_at_safepoint, ThreadSnapshot, ThreadStackTrace, DeadlockCycle |
| `ThreadImpl.c` | 全部 15 个 JNI 函数 |
| `HotspotThread.c` | getInternalThreadCount, getInternalThreadTimes0 |
| `vmOperations.cpp` | VM_ThreadDump::doit (273-320) |

### 04-os-flag-diagnostic.md

| 源文件 | 关键内容 |
|--------|---------|
| `Flag.c` | getFlags (83-203), setLongValue/setDoubleValue/setBooleanValue/setStringValue, initialize → Origin 枚举 (34-42) |
| `writeableFlags.cpp` | set_flag (238-295), set_flag_from_jvalue (298-350) |
| `management.cpp` | jmm_GetVMGlobals (1536-1599), jmm_SetVMGlobal (1601-1625), jmm_GetVMGlobalNames (1420-1452), jmm_ExecuteDiagnosticCommand (1780-1850), jmm_DumpHeap0 (1860-1890) |
| `DiagnosticCommandImpl.c` | getDiagnosticCommands, getDiagnosticCommandInfo, executeDiagnosticCommand |
| `HotSpotDiagnostic.c` | dumpHeap0 |
| `GcInfoBuilder.c` | getNumGcExtAttributes, fillGcAttributeInfo, getLastGcInfo0 |
| `GarbageCollectorExtImpl.c` | setNotificationEnabled |
| `OperatingSystemImpl.c` (unix, 470行) | 全部 OS 指标查询 — Linux/macOS/Solaris/AIX 平台差异 |
| `UnixOperatingSystem.c` | CPU load 查询 |
| `FileSystemImpl.c` (unix, 75行) | isAccessUserOnly0 — stat64 + 权限位检查 |

---

### 统计

| 指标 | 数值 |
|------|:---:|
| .so 数量 | 3 |
| native 源文件总数 | ~22 |
| HotSpot services 源文件 | 10 |
| 头文件 | 10 |
| JMM 函数 (jmm_interface) | 36 |
| JNI 桥接函数 | ~60 |
| 平台差异实现 | 5 (Linux/macOS/Solaris/AIX/Windows) |
| 预计文档行数 | 5 篇 × 2000-3000 行 = 10000-15000 行 |
