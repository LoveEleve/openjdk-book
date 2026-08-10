# 00 — 什么是 JMX？为什么 JVM 需要它？

> **阶段**：[17-jmx-management]
> **前置**：[03-object-model]（oop、Klass、JavaCalls）、[06-gc-core]（GC 生命周期）、[09-native-interface]（JNI_ENTRY/JVM_ENTRY 宏机制）
> **配套**：[01-management-jmm-interface]（jmm_interface vtable 深入）、[02-memory-pool-threshold]（MemoryPool/ThresholdSupport）、[03-thread-monitoring]（线程 dump 双路径）、[04-os-flag-diagnostic]（Flag/DCmd/OS metrics）
> **阅读收益**：理解 JMX 三层桥接架构（Java MBean → Native .so → HotSpot C++）的全景——掌握 10+ MXBean 的能力矩阵、3 个 .so 的角色分工、Management 初始化三阶段、jconsole 连接 → HeapMemoryUsage 的 8 步端到端数据流、JMX Connector vs Attach API 的两条通路差异。

> **一句话**: JMX 是 JVM 的"仪表盘接口"——它把 JVM 内部状态（内存用量、GC 次数、线程数、CPU 时间）暴露为标准化的 MBean，让 jconsole/jcmd/jinfo/jstack 这些工具可以读取和控制 JVM。没有 JMX，你只能看 GC 日志猜测 JVM 状态——有了 JMX，你可以实时查询每个内存池的精确用量。

---

## §〇 先看一个生产场景——你就懂了

### 生产场景: jconsole 连接后 MBean 树为空

你通过 jconsole 连接生产 JVM，发现 MBean 树为空——只有 `java.lang:type=OperatingSystem` 可见，`Memory`/`Threading`/`ClassLoading` MXBean 全部缺失。jconsole 日志显示 `Connection failed` 但 RMI 端口可达。

**Root cause**: JVM 启动时 `-Dcom.sun.management.jmxremote` 未设置。`Management::initialize()` (management.cpp:174) 只在 `ManagementServer` 标志为 `true` 时执行 JMX Agent 初始化——`ManagementServer` 由 `-Dcom.sun.management.jmxremote` 或 `-Dcom.sun.management.jmxremote.port` 设置 (arguments.cpp:2831-2833)。没有这个参数 → `Management::initialize()` 整个函数是 no-op → `jdk.internal.agent.Agent.startAgent()` 从未被调用 → JMX RMI Connector 未启动。

**为什么 ManagementServer 默认为 false？** `globals.hpp:2458` 声明 `product(bool, ManagementServer, false, ...)` —— product 构建默认关闭。只有在 arguments.cpp:2831 解析到 `-Dcom.sun.management` 前缀时才通过 `FLAG_SET_CMDLINE(bool, ManagementServer, true)` 设为 true。这意味着开发者的 `java HelloWorld` 不会启动 JMX Agent——只有显式配置的 JVM 才会。

**核心认知**: JMX 有两层启动：
- **第一层**（`management_init()` → `Management::init()`）— 在 VM 早期始终执行，创建 PerfData 计数器、注册 jcmd 命令、填充可选能力位图
- **第二层**（`Management::initialize()` → `Agent.startAgent()` → `ConnectorBootstrap.startRemoteConnectorServer()`）— 需要显式开启

**三步诊断**:

```bash
# 1. 确认 JMX Agent 是否已启动
jcmd <pid> ManagementAgent.status
# 输出示例: "JMX Remote is disabled" → Agent 未启动
# 输出示例: "Connection refused" for local → local connector 未启动

# 2. 确认启动参数中是否有 jmxremote
jcmd <pid> VM.flags | grep jmxremote
# 如果没有输出 → -Dcom.sun.management.jmxremote 未设置
# 如果有 -Dcom.sun.management.jmxremote.port=9999 → 远程 JMX 应可用

# 3. 运行时动态启动（无需重启 JVM）
jcmd <pid> ManagementAgent.start jmxremote.port=9999
# 验证
jcmd <pid> ManagementAgent.status
# 预期: JMX Connector at service:jmx:rmi:///jndi/rmi://<host>:9999/jmxrmi
```

> **Counterfactual**: 如果 `Management::initialize()` 无条件启动 JMX Agent → 每个 JVM 进程都启动 RMI Connector → 增加启动时间（RMI registry 绑定 + SSL 配置）+ 占用一个端口（端口冲突）→ 开发者的 `java HelloWorld` 也会启动 JMX RMI server → 安全风险（默认无认证的 JMX connector 暴露所有 MBean，参考 CVE-2016-3427）。设计选择"默认不启动"是用便利性换取安全性——显式开启确保用户明确选择了监控。

---

### 场景 1: 你在 jconsole 里看到的"堆内存使用量"从哪来？

```
打开 jconsole → 连接 JVM → 点击 "Memory" 标签
  → 看到蓝色曲线: Heap Memory Usage: 200MB / 1024MB
```

**这一行数字背后的完整路径**:

```
jconsole (GUI, 客户端)
  → RMI 连接 (man 2 socket, man 2 connect) → JMXConnectorServer
    → MBeanServerConnection.getAttribute(
        ObjectName("java.lang:type=Memory"),    ← 查找注册的 MemoryImpl 实例
        "HeapMemoryUsage")                      ← 属性名映射
      → MemoryImpl.java: getHeapMemoryUsage()
        → 调用 private native getMemoryUsage0(true)  ← 跨越 JNI 边界
          → MemoryImpl.c:45-47:
              "return jmm_interface->GetMemoryUsage(env, heap);"  ← 仅 1 行！
            → management.cpp:738: jmm_GetMemoryUsage()
              → JVM_ENTRY 宏: _thread_in_native → _thread_in_vm (支持 safepoint)
              → 遍历 MemoryService::num_memory_pools() (line 749)
                → Eden 区: 80MB used, 100MB committed
                → Survivor 区: 20MB used, 24MB committed
                → Old 区: 100MB used, 900MB committed
                → 累加: used=200MB, committed=1024MB (lines 753-754)
              → 处理 -1 哨兵值: 任意 pool 的 init_size/max_size == -1 → 全部设为 -1 (lines 756-776)
              → MemoryUsage usage(...) 构造 C++ 对象 (lines 781-784)
              → MemoryService::create_MemoryUsage_obj(usage) (line 786)
                → 构造 Java CompositeData{init:512MB, used:200MB, committed:1024MB, max:4096MB}
              → return JNIHandles::make_local(env, obj()) (line 787)
                → jconsole 接收 CompositeData → 解析 4 个字段 → 画蓝色曲线
```

**关键理解**: 你看到的不是 GC 日志，而是 JVM **实时**从内存池读取的数据。每次 jconsole 轮询（默认每 4 秒），`jmm_GetMemoryUsage` 重新遍历所有 heap pools 并累加。它使用 `JVM_ENTRY` 宏（非 `JVM_LEAF`），因为需要 `ResourceMark` + `HandleMark` 来安全地构造 Java 对象。

### 场景 2: 你用的 jcmd、jinfo、jstack 和 JMX 是什么关系？

| 工具 | 功能 | 底层路径 | 和 JMX 的关系 |
|------|------|---------|-------------|
| **jconsole** | 图形化监控 | RMI → JMX MBeanServer → native JNI → jmm_interface | **纯 JMX** — 所有数据走 JMX MBean |
| **jcmd** | 诊断命令 | Attach API (SIGQUIT → UNIX socket) → DCmd | **有 JMX 对等物** — `DiagnosticCommandMBean.execute()` 暴露相同命令 |
| **jinfo** | 读写 VM flag | Attach API → JVMFlag::find_flag() | **有 JMX 对等物** — `HotSpotDiagnosticMXBean.getVMOption()` / `setVMOption()` |
| **jstack** | 线程 dump | Attach API → VM_ThreadDump (safepoint) | **有 JMX 对等物** — `ThreadMXBean.dumpAllThreads()` → `jmm_DumpThreads()` |
| **jstat** | GC 统计 | 读 PerfData 共享内存文件 (`/tmp/hsperfdata_<user>/<pid>`) | **不走 JMX** — 直接 mmap 读取，零 JNI 开销 |
| **jmap** | Heap dump | Attach API → JVM_DumpHeap | **有 JMX 对等物** — `HotSpotDiagnosticMXBean.dumpHeap()` |

**核心理解**: jconsole 走 JMX 协议（RMI over TCP），jcmd/jinfo/jstack 走 Attach API（SIGQUIT 信号 + UNIX domain socket），但它们在 JVM 内部**共享同一套 C++ 实现**。比如修改 VM flag：

- `jinfo -flag +PrintGC <pid>` → Attach API → `WriteableFlags::set_flag(name, value, ATTACH_ON_DEMAND)`
- `jconsole → HotSpotDiagnosticMXBean.setVMOption("PrintGC", "true")` → JMX → `jmm_SetVMGlobal()` (management.cpp:1601) → **同一个** `WriteableFlags::set_flag(name, value, MANAGEMENT)`

区别仅在于 `FlagOrigin` 枚举值不同（`ATTACH_ON_DEMAND` vs `MANAGEMENT`），底层实现完全相同。

### 场景 3: 你的监控系统（Prometheus/Zabbix）怎么拿到 JVM 数据？

```
Prometheus JMX Exporter (Java agent 模式)
  → 通过 JMX 连接本地 JVM (无需 RMI，直接访问 Platform MBeanServer)
    → 定时查询 MBean (默认每 10 秒):
        java.lang:type=Memory.HeapMemoryUsage.used → jvm_memory_bytes_used{area="heap"} 指标
        java.lang:type=GarbageCollector,name=G1 Young Generation.CollectionCount → jvm_gc_collection_seconds_count 指标
        java.lang:type=Threading.ThreadCount → jvm_threads_current 指标
        java.lang:type=ClassLoading.LoadedClassCount → jvm_classes_loaded 指标
```

几乎所有 JVM 监控工具都基于 JMX。你看到的 Grafana 面板上的 JVM 指标——底层都是 JMX MBean 的属性值，通过 jmm_interface vtable 跨越 JNI 边界到达 management.cpp 的 C++ 实现。

---

## §一 JMX 三层桥接全景

### 1.1 JMX 到底是什么？——官方定义 vs 直观类比

**官方定义**: Java Management Extensions (JMX) 是 Java 的管理和监控标准——它定义了如何将可管理资源暴露为 MBean（Managed Bean），通过 MBeanServer 统一访问。JSR-174 定义了 JMX 规范。

**直观类比**: 把 JVM 想象成一辆汽车：

| 汽车 | JVM |
|------|-----|
| 仪表盘（速度表、油量表、水温表） | MBean（MemoryMXBean, ThreadMXBean, GCMXBean） |
| 仪表盘背后的传感器（速度传感器、油位传感器） | native JNI 函数（`getMemoryUsage0`, `getThreadCpuTime0`） |
| OBD-II 诊断接口（修车工插上去读故障码） | JMX Connector（jconsole 通过 RMI 连接读取 JVM 状态） |
| ECU 控制单元（调整发动机参数） | WriteableFlags（jinfo 修改 VM flag） |

**JMX 就是 JVM 的 OBD-II 接口**——它定义了一套标准协议，让外部工具可以：
1. **读取** JVM 内部状态（内存、线程、GC、类加载、编译）
2. **控制** JVM 行为（触发 GC、修改 flag、dump heap、设置阈值）
3. **订阅** JVM 事件（GC 完成通知、内存阈值告警、线程死锁检测）

### 1.2 三个核心概念

```
┌──────────────────────────────────────────────────────────────────┐
│                     MBeanServer (注册中心)                         │
│   ManagementFactory.getPlatformMBeanServer() — 单例, JVM 启动创建  │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│  │ MemoryMXBean    │  │ ThreadMXBean    │  │ GCMXBean         │ │
│  │ ObjectName:     │  │ ObjectName:     │  │ ObjectName:      │ │
│  │ java.lang:      │  │ java.lang:      │  │ java.lang:       │ │
│  │   type=Memory   │  │   type=Threading│  │   type=GC,       │ │
│  │                 │  │                 │  │   name=G1..      │ │
│  │ getHeapMemory   │  │ getThreadCount()│  │ getCollection    │ │
│  │ Usage()         │  │ getThreadCpu..  │  │ Count()          │ │
│  └────────┬────────┘  └────────┬────────┘  └──────┬───────────┘ │
│           │                    │                    │             │
└───────────┼────────────────────┼────────────────────┼─────────────┘
            │                    │                    │
            ▼                    ▼                    ▼
       native 调用           native 调用           native 调用
       (libmanage-           (libmanage-           (libmanage-
        ment.so)              ment.so)              ment.so)
```

1. **MBean** (Managed Bean): 一个可管理的 JVM 部件。每个 MBean 有:
   - **ObjectName**: 唯一地址，如 `java.lang:type=Memory`（像 URL，格式 `domain:key=value`）
   - **Attributes**: 可读属性，如 `HeapMemoryUsage`（返回 CompositeData）
   - **Operations**: 可执行操作，如 `gc()`（触发 Full GC）
   - **Notifications**: 可订阅事件，如 `javax.management.Notification`（GC 完成）

2. **MBeanServer**: MBean 的注册中心。`ManagementFactory.getPlatformMBeanServer()` 返回单例——所有 Platform MBean 在 JVM 启动时注册到这里。工具通过 MBeanServer 的 `queryNames()` 列出所有 MBean，通过 `getAttribute()` 读取属性值。

3. **JMX Connector**: 远程访问协议。让 jconsole 可以从你的笔记本电脑连接到生产服务器的 JVM。最常见的是 RMI connector（`-Dcom.sun.management.jmxremote.port=9999`）。Connector 层负责序列化 MBeanServer 调用为 RMI 调用——对客户端透明。

### 1.3 JMX 在 JVM 中的位置 — 4 层架构

```
┌───────────────────────────────────────────────────────────────────────┐
│                        外部工具层                                      │
│  jconsole (GUI)  │  jcmd (CLI)  │  Prometheus  │  你的程序            │
└────────┬─────────┴──────┬───────┴──────┬───────┴──────┬──────────────┘
         │                │              │              │
         │ RMI/JMX        │ Attach API   │ JMX Exporter │ JMX API
         ▼                ▼              ▼              ▼
┌───────────────────────────────────────────────────────────────────────┐
│                    Java 层 (JDK 类库)                                  │
│                                                                       │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │              MBeanServer (java.lang.management)                 │   │
│  │                                                                │   │
│  │  MemoryMXBean  ThreadMXBean  GCMXBean  RuntimeMXBean ...       │   │
│  │       │              │           │           │                 │   │
│  │       ▼              ▼           ▼           ▼                 │   │
│  │  MemoryImpl    ThreadImpl   GCImpl    VMManagementImpl         │   │
│  │   .java          .java        .java       .java                │   │
│  │   (getMemory     (getThread   (getCollect  (getVersion0         │   │
│  │    Usage0)        Info1)       ionCount)   , 28+ native)        │   │
│  └───────┬────────────┬───────────┬───────────┬───────────────────┘   │
│          │            │           │           │                        │
└──────────┼────────────┼───────────┼───────────┼────────────────────────┘
           │            │           │           │
           │ native     │ native    │ native    │ native
           ▼            ▼           ▼           ▼
┌───────────────────────────────────────────────────────────────────────┐
│               Native 库层 (3 个 .so — 本 Phase 核心)                    │
│                                                                       │
│  libmanagement.so       libmanagement_ext.so    libmgmt_agent.so      │
│  (标准 MXBean JNI,       (扩展 MXBean JNI,       (agent 权限检查,       │
│   10 源文件)              8+ 源文件)              1 源文件)             │
│                                                                       │
│  每个函数 = 1 行: jmm_interface->Xxx(env, ...)                         │
│  JNI_OnLoad: JVM_GetManagement(JMM_VERSION) → 获取 jmm_interface       │
└─────────────────────────────┬─────────────────────────────────────────┘
                              │
                              │ jmm_interface (36 函数 vtable, 37 slots)
                              ▼
┌───────────────────────────────────────────────────────────────────────┐
│                HotSpot VM 层 (编译进 libjvm.so)                         │
│                                                                       │
│  management.cpp (2283行) — 36 个 jmm_* 函数实现                         │
│  memoryService.cpp (281行) — 内存池/管理器注册 + GC 回调                 │
│  lowMemoryDetector.cpp (387行) — 阈值检测 + Sensor 回调                 │
│  threadService.cpp (~900行) — 线程 dump + 死锁检测                     │
│  writeableFlags.cpp (~300行) — Flag 动态写入                           │
│  gcNotifier.cpp (~200行) — GC 事件通知队列                             │
│                                                                       │
│  真正的逻辑在这里——读取 JVM 内部数据结构，返回数据                        │
└───────────────────────────────────────────────────────────────────────┘
```

**关键理解**: JMX 是一个 4 层架构：
1. **工具层** — jconsole/jcmd/Prometheus — 用户想看到的数据
2. **Java MBean 层** — MemoryMXBean/ThreadMXBean — 标准化的数据接口（open types）
3. **Native JNI 层** — 3 个 .so — 跨越 Java↔C++ 边界的薄包装
4. **HotSpot C++ 层** — management.cpp + memoryService.cpp — 真正的数据来源

本 Phase 17 覆盖的是**第 3 和第 4 层**——JMX 的底层实现。第 1 和第 2 层是 JMX 规范层面的内容，不在这里深入。

### 1.4 面试 Story Format 答案

> "JMX is NOT a single API — it's a 3-tier bridge connecting external monitoring tools to JVM internals. At the top: Java MBeans (MemoryMXBean, ThreadMXBean, etc.) registered in a Platform MBeanServer. In the middle: 3 native shared libraries — `libmanagement.so` (standard MXBean JNI bridges), `libmanagement_ext.so` (extended diagnostics like Flag/DCmd/OS metrics), `libmanagement_agent.so` (file permission check only). At the bottom: HotSpot's `management.cpp` (2283 lines) implementing 36 `jmm_*` functions behind a C-style vtable `jmm_interface` (management.cpp:2232-2272). The bridge is a single pointer: `libmanagement.so`'s `JNI_OnLoad` (management.c:47) calls `JVM_GetManagement(JMM_VERSION)` → `Management::get_jmm_interface(version)` (management.cpp:2275) → returns `(void*) &jmm_interface`. Every subsequent JNI call is ONE line: `return jmm_interface->GetMemoryUsage(env)`. The initialization is two-phase: `management_init()` at init.cpp:119 (early VM boot, PerfData counters) and `Management::initialize()` at thread.cpp:4291 (post-heap, loads MXBean Java classes, starts Agent if `-Dcom.sun.management.jmxremote` is set). jcmd and jconsole both talk to the same Platform MBeanServer — but jcmd can also bypass JMX entirely through the Attach API for commands like `VM.flags`."

---

### 1.5 Beginner Callout Boxes

> **1. MBean vs MXBean** — MBean requires custom types; MXBean uses standard open types (CompositeData, TabularData) so ANY JMX client (jconsole, Zabbix, Nagios) can understand the data without loading custom classes. All Platform MBeans are MXBeans. `MemoryMXBean.getHeapMemoryUsage()` returns `CompositeData` with exactly 4 fields: `init` (jlong), `used` (jlong), `committed` (jlong), `max` (jlong). No custom `MemoryUsage.class` required on the client side — this is why you can write `new JMXConnectorFactory().connect(url).getMBeanServerConnection().getAttribute(new ObjectName("java.lang:type=Memory"), "HeapMemoryUsage")` in any JMX client without importing `java.lang.management.MemoryUsage`. The underlying C++ implementation in management.cpp:738-788 constructs a `CompositeData` object via `MemoryService::create_MemoryUsage_obj()` — not a custom `MemoryUsage` Java object. This is the key to JMX interoperability.

> **2. MBeanServer — the registration directory** — `ManagementFactory.getPlatformMBeanServer()` returns a singleton `MBeanServer` — NOT a new one per call. All Platform MXBeans are registered here at JVM startup via `ManagementFactoryHelper` (ManagementFactoryHelper.java:67-81 creates static final MXBean instances). jconsole queries this MBeanServer through RMI — it sends `getAttribute(ObjectName("java.lang:type=Memory"), "HeapMemoryUsage")` over the wire as a serialized JMX call. The MBeanServer looks up the registered `MemoryImpl` instance in its internal registry (a `HashMap<ObjectName, DynamicMBean>`) and invokes `getHeapMemoryUsage()` via reflection. The result (`CompositeData`) is serialized back over RMI. The MBeanServer itself runs inside the JVM — jconsole connects to it through `JMXConnectorServer` which wraps the MBeanServer with RMI semantics.

> **3. ObjectName format** — `java.lang:type=Memory` — `java.lang` is the domain (package-like namespace), `type` is the only key for simple MXBeans. All Platform MXBeans use this convention: `java.lang:type=Threading`, `java.lang:type=Runtime`, etc. For multiple-instance MXBeans: `java.lang:type=MemoryPool,name=G1 Eden Space` — the `name` key distinguishes instances. For GC MXBeans: `java.lang:type=GarbageCollector,name=G1 Young Generation`. HotSpot internal MBeans use `sun.management:type=HotspotMemory`. The ObjectName format supports wildcard queries: `new ObjectName("java.lang:type=MemoryPool,name=*")` matches all memory pools. jconsole's MBean tree is built by calling `MBeanServer.queryNames(null, null)` to get all ObjectNames, then grouping by domain for the tree structure.

> **4. jmm_interface pointer storage** — `management.c:34` declares `const JmmInterface* jmm_interface = NULL` — a C file-scope variable. `management.h:34` declares it `extern const JmmInterface* jmm_interface` — making it visible to ALL JNI source files compiled into the same .so (MemoryImpl.c, ThreadImpl.c, VMManagementImpl.c, etc.). After `JNI_OnLoad` (management.c:39-55) succeeds, EVERY JNI function in libmanagement.so dereferences this single pointer. The critical path: `management.c:47` — `jmm_interface = (JmmInterface*) JVM_GetManagement(JMM_VERSION)` → if returns NULL → `JNU_ThrowInternalError(env, "Unsupported Management version")` → returns `JNI_ERR` → `System.loadLibrary("management")` throws `UnsatisfiedLinkError` → ALL JMX MXBeans become unavailable. `jmm_interface` is NEVER modified after JNI_OnLoad — it's effectively read-only for the lifetime of the .so.

> **5. Two initialization phases** — Phase 1 (`management_init()` at init.cpp:119) runs before the Java heap exists (before `Universe::genesis()`). It calls `Management::init()` (management.cpp:97-172) which: creates 3 PerfData counters (createVmBeginTime/EndTime/vmInitDoneTime at lines 107-117), fills 9 boolean flags in `_optional_support` bitfield (lines 121-139), registers jcmd diagnostic commands via `DCmdRegistrant::register_dcmds()` (line 148), and registers NMT tracking command (line 171). Phase 2 (`Management::initialize(THREAD)` at thread.cpp:4291) runs after the Java heap is ready. It checks `ManagementServer` flag (management.cpp:175) → if true, loads `jdk.internal.agent.Agent` class via `SystemDictionary::resolve_or_null()` (lines 182-184) → calls `Agent.startAgent()` via `JavaCalls::call_static()` (lines 191-194). This split exists because Phase 1 creates PerfData (pre-heap) while Phase 2 loads Java classes (requires heap).

> **6. JMX Connector vs Attach API** — JMX Connector (jconsole) connects via RMI over TCP — requires network port, optional authentication (jmxremote.password + jmxremote.access), optional SSL. Attach API (jcmd) connects via UNIX domain socket (Linux) or Windows named pipe — no network, no authentication (same machine, same user only), lower overhead. Both can read/write VM flags, execute diagnostic commands, and trigger heap dumps. The Attach API path bypasses JMX entirely for most operations — `jcmd <pid> VM.flags` goes through `AttachListener::dequeue()` → `DCmd::parse_and_execute()` → `WriteableFlags::set_flag()` without touching any MBean or jmm_interface. JMX Connector is the "planned monitoring infrastructure" (pre-configured ports and auth), Attach API is the "emergency diagnostic channel" (zero config, signal-triggered).

> **7. PerfData counters** — `Management::init()` creates 3 PerfData counters in the `sun.rt` namespace (management.cpp:107-117): `createVmBeginTime` (VM creation start timestamp), `createVmEndTime` (VM creation end timestamp), `vmInitDoneTime` (VM initialization complete timestamp). These are `PerfVariable` objects backed by shared memory via `mmap()` (man 2 mmap) — written to `/tmp/hsperfdata_<user>/<pid>` as a binary file. `jstat` reads these counters by mmapping the same file — zero JNI overhead, zero VM thread interaction, pollable from outside the JVM process. This is the lowest-overhead monitoring mechanism in HotSpot. The counters are created even if `-XX:-UsePerfData` is set (then allocated on C heap instead of shared memory).

### 1.6 jmm_interface vtable — 36 槽位总览

jmm_interface 是 HotSpot 暴露给 .so 的 C 风格函数指针表。定义在 management.cpp:2232-2272，类型为 `const struct jmmInterface_1_`（定义在 jmm.h:221-342）。37 个槽位（含 2 个 reserved NULL 槽位），每个槽位是一个函数指针。

```
management.cpp:2232-2272:
const struct jmmInterface_1_ jmm_interface = {
  NULL,                                    // [ 0] reserved
  jmm_GetOneThreadAllocatedMemory,         // [ 1]
  jmm_GetVersion,                          // [ 2]
  jmm_GetOptionalSupport,                  // [ 3]
  jmm_GetThreadInfo,                       // [ 4]
  jmm_GetMemoryPools,                      // [ 5]
  jmm_GetMemoryManagers,                   // [ 6]
  jmm_GetMemoryPoolUsage,                  // [ 7]
  jmm_GetPeakMemoryPoolUsage,              // [ 8]
  jmm_GetThreadAllocatedMemory,            // [ 9]
  jmm_GetMemoryUsage,                      // [10]
  jmm_GetLongAttribute,                    // [11]
  jmm_GetBoolAttribute,                    // [12]
  jmm_SetBoolAttribute,                    // [13]
  jmm_GetLongAttributes,                   // [14]
  jmm_FindMonitorDeadlockedThreads,        // [15]
  jmm_GetThreadCpuTime,                    // [16]
  jmm_GetVMGlobalNames,                    // [17]
  jmm_GetVMGlobals,                        // [18]
  jmm_GetInternalThreadTimes,              // [19]
  jmm_ResetStatistic,                      // [20]
  jmm_SetPoolSensor,                       // [21]
  jmm_SetPoolThreshold,                    // [22]
  jmm_GetPoolCollectionUsage,              // [23]
  jmm_GetGCExtAttributeInfo,              // [24]
  jmm_GetLastGCStat,                       // [25]
  jmm_GetThreadCpuTimeWithKind,            // [26]
  jmm_GetThreadCpuTimesWithKind,           // [27]
  jmm_DumpHeap0,                           // [28]
  jmm_FindDeadlockedThreads,               // [29]
  jmm_SetVMGlobal,                         // [30]
  NULL,                                    // [31] reserved
  jmm_DumpThreads,                         // [32]
  jmm_SetGCNotificationEnabled,            // [33]
  jmm_GetDiagnosticCommands,               // [34]
  jmm_GetDiagnosticCommandInfo,            // [35]
  jmm_GetDiagnosticCommandArgumentsInfo,   // [36]
  jmm_ExecuteDiagnosticCommand,            // [37]
  jmm_SetDiagnosticFrameworkNotificationEnabled // [38]
};
```

**关键设计点**:
- 槽位 0 和 31 是 reserved (NULL) — 历史兼容槽位
- 每个 JNI 函数通过索引访问: `jmm_interface->GetMemoryUsage(env, heap)` 实际上是 `(jmm_interface[10])(env, heap)`
- `Management::get_jmm_interface(version)` (management.cpp:2275) 做精确版本匹配 — 只接受 `JMM_VERSION` (即 `JMM_VERSION_2` = 0x20020000)
- 版本不匹配 → 返回 NULL → `JNI_OnLoad` 失败 → `System.loadLibrary("management")` 抛出 `UnsatisfiedLinkError`

**为什么用 vtable 而不是直接函数调用？**
直接函数调用的方案: 每个 .so 编译时链接 `libjvm.so` → 调用 `jmm_GetMemoryUsage(env, heap)` → 需要知道函数的符号地址。问题:
1. 符号绑定发生在加载时 — 如果 libjvm.so 重命名或移除函数 → .so 加载失败
2. 不能版本化 — 无法区分 JMM v1 和 JMM v2 的接口差异
3. 编译耦合 — .so 必须用与 libjvm.so 相同的编译器 + ABI 编译

vtable 方案:
1. 符号绑定通过单一入口 `JVM_GetManagement(JMM_VERSION)` — 返回整个 vtable
2. 版本化 — `get_jmm_interface(version)` 可返回不同 vtable（当前只支持精确匹配）
3. ABI 隔离 — .so 只依赖函数指针类型，不依赖具体实现符号

**VMManagementImpl 30 个函数如何使用这个 vtable**:
每个 JNI 函数只调用 vtable 中的 1 个槽位:
- `getTotalClassCount()` → `jmm_interface->GetLongAttribute(env, NULL, JMM_CLASS_LOADED_COUNT)` — 槽位 [11]
- `getVerboseGC()` → `jmm_interface->GetBoolAttribute(env, JMM_VERBOSE_GC)` — 槽位 [12]
- `initOptionalSupportFields()` → `jmm_interface->GetOptionalSupport(env, &mos)` — 槽位 [3]
这种设计使 VMManagementImpl.c 中 30 个函数看起来几乎一模一样 — 只有参数不同。

### 1.7 JMX 能做什么？— 10+ MBean 能力矩阵

#### 1.7.1 标准 MXBean（`java.lang.management` 包，8 个）

| MXBean | ObjectName | 你能读什么 | 你能做什么 | Native 方法 → jmm_interface |
|--------|-----------|----------|----------|---------------------------|
| **MemoryMXBean** | `java.lang:type=Memory` | HeapMemoryUsage (init/used/committed/max), NonHeapMemoryUsage | `gc()` 触发 Full GC | `MemoryImpl.getMemoryUsage0(heap)` → `jmm_interface->GetMemoryUsage(env, heap)` — MemoryImpl.c:45-47 |
| **MemoryPoolMXBean** | `java.lang:type=MemoryPool,name=*` | Usage, PeakUsage, CollectionUsage, UsageThreshold | `setUsageThreshold(count)` — 超过时告警 | `MemoryPoolImpl.getUsage0()` → `jmm_interface->GetMemoryPoolUsage(env, pool)` — MemoryPoolImpl.c |
| **GarbageCollectorMXBean** | `java.lang:type=GarbageCollector,name=*` | CollectionCount, CollectionTime | — | `GarbageCollectorImpl.getCollectionCount()` → `jmm_interface->GetLongAttribute(JMM_GC_COLLECTION_COUNT)` |
| **ThreadMXBean** | `java.lang:type=Threading` | ThreadCount, PeakThreadCount, DaemonThreadCount | `getThreadInfo(ids, maxDepth)` — 线程信息; `dumpAllThreads()` — 线程 dump; `findDeadlockedThreads()` — 死锁检测 | `ThreadImpl.getThreadInfo1()` → `jmm_interface->GetThreadInfo(env, ids, maxDepth, ...)` — ThreadImpl.c |
| **ClassLoadingMXBean** | `java.lang:type=ClassLoading` | LoadedClassCount, TotalLoadedClassCount, UnloadedClassCount | `setVerbose(true)` — 打印类加载日志 | `VMManagementImpl.getTotalClassCount()` → `jmm_interface->GetLongAttribute(JMM_CLASS_LOADED_COUNT)` — VMManagementImpl.c:108-116 |
| **CompilationMXBean** | `java.lang:type=Compilation` | Name (编译器名), TotalCompilationTime (ms) | — | `VMManagementImpl.getTotalCompileTime()` → `jmm_interface->GetLongAttribute(JMM_COMPILE_TOTAL_TIME_MS)` — VMManagementImpl.c:177-183 |
| **RuntimeMXBean** | `java.lang:type=Runtime` | VmName, VmVersion, StartTime, Uptime, InputArguments | — | `VMManagementImpl.getVmArguments0()` → `JVM_GetVmArguments(env)` — 直接 JVM 入口 |
| **OperatingSystemMXBean** | `java.lang:type=OperatingSystem` | Name, Arch, AvailableProcessors, SystemLoadAverage | — | `VMManagementImpl.getAvailableProcessors()` → `JVM_ActiveProcessorCount()` — 直接 JVM 入口 |

**MemoryPool 的完整列表**（以 G1 GC 为例）:

| Pool 名称 | 类型 | 对应内存区域 | 支持阈值 |
|-----------|------|-------------|:---:|
| `G1 Eden Space` | Heap | Eden 区 | UsageThreshold |
| `G1 Survivor Space` | Heap | Survivor 区 | UsageThreshold |
| `G1 Old Gen` | Heap | Old 区 | UsageThreshold + CollectionUsageThreshold |
| `CodeHeap 'non-nmethods'` | Non-heap | 编译的 nmethod 外的代码 | — |
| `CodeHeap 'profiled nmethods'` | Non-heap | C1 编译的方法 | — |
| `CodeHeap 'non-profiled nmethods'` | Non-heap | C2 编译的方法 | — |
| `Metaspace` | Non-heap | 类元数据 | UsageThreshold (Gauge 模式) |
| `Compressed Class Space` | Non-heap | 压缩的 Klass 指针 | UsageThreshold (Gauge 模式) |

#### 1.7.2 扩展 MXBean（`com.sun.management` 包，`jdk.management` 模块，5 个）

| MXBean | ObjectName | 额外提供 | Native 方法 → jmm_interface |
|--------|-----------|---------|---------------------------|
| **HotSpotDiagnosticMXBean** | `com.sun.management:type=HotSpotDiagnostic` | `dumpHeap(file)` — Heap dump; `getVMOption(name)` — 读 flag; `setVMOption(name, value)` — 写 flag | `HotSpotDiagnostic.dumpHeap0()` → `jmm_interface->DumpHeap0(env, file)`; `Flag.setLongValue/setBooleanValue` → `jmm_interface->SetVMGlobal(env, name, v)` (management.cpp:1601) |
| **DiagnosticCommandMBean** | `com.sun.management:type=DiagnosticCommand` | `execute(cmd)` — 执行 jcmd 命令 | `DiagnosticCommandImpl.executeDiagnosticCommand()` → `jmm_interface->ExecuteDiagnosticCommand(env, cmd)` (management.cpp:1780) |
| **OperatingSystemMXBean** (扩展) | 同上 | CPU 负载、物理内存、Swap、打开文件描述符数 | `OperatingSystemImpl.getCommittedVirtualMemorySize0()` → 解析 `/proc/self/stat` 字段 23; `getOpenFileDescriptorCount0()` → 遍历 `/proc/self/fd` |
| **GarbageCollectorMXBean** (扩展) | 同上 | `getLastGcInfo()` — 上次 GC 的详细统计 | `GcInfoBuilder.getLastGcInfo0()` → `jmm_interface->GetLastGCStat(env, mgr)` |
| **ThreadMXBean** (扩展) | 同上 | 线程分配内存、JSR-166 synchronizer 死锁检测 | `ThreadImpl.getThreadAllocatedMemory0()` → `jmm_interface->GetThreadAllocatedMemory(env, id)` |

### 1.8 JMX 监控完整代码示例

以下代码展示 JMX 的核心使用模式 — 从获取 MBeanServer 到订阅通知:

```java
import java.lang.management.*;
import javax.management.*;
import javax.management.remote.*;
import com.sun.management.*;

public class JMXDemo {
    public static void main(String[] args) throws Exception {
        // === 模式 1: 本地 JMX (零配置) ===
        // 获取 Platform MBeanServer — JVM 启动时自动创建
        MBeanServer server = ManagementFactory.getPlatformMBeanServer();
        
        // 列出所有 MBean
        System.out.println("=== All MBeans ===");
        for (ObjectName name : server.queryNames(null, null)) {
            System.out.println("  " + name);
        }
        
        // === 模式 2: 查询 MBean 属性 ===
        // 查询堆内存
        ObjectName memory = new ObjectName("java.lang:type=Memory");
        CompositeData heapUsage = (CompositeData) server.getAttribute(memory, "HeapMemoryUsage");
        long heapUsed = (Long) heapUsage.get("used");
        long heapMax = (Long) heapUsage.get("max");
        System.out.printf("Heap: %d / %d MB (%.1f%%)%n",
            heapUsed / 1024 / 1024, heapMax / 1024 / 1024,
            100.0 * heapUsed / heapMax);
        
        // 查询 GC 次数
        ObjectName gc = new ObjectName(
            "java.lang:type=GarbageCollector,name=G1 Young Generation");
        Long gcCount = (Long) server.getAttribute(gc, "CollectionCount");
        Long gcTime = (Long) server.getAttribute(gc, "CollectionTime");
        System.out.printf("G1 Young GC: %d collections, %d ms%n", gcCount, gcTime);
        
        // 查询线程
        ObjectName threading = new ObjectName("java.lang:type=Threading");
        Integer threadCount = (Integer) server.getAttribute(threading, "ThreadCount");
        Integer peakThreads = (Integer) server.getAttribute(threading, "PeakThreadCount");
        System.out.printf("Threads: %d current, %d peak%n", threadCount, peakThreads);
        
        // === 模式 3: 执行 MBean 操作 ===
        // 触发 Full GC (谨慎!)
        // server.invoke(memory, "gc", null, null);
        
        // === 模式 4: 读写 VM Flag ===
        ObjectName diag = new ObjectName("com.sun.management:type=HotSpotDiagnostic");
        // 读 flag
        CompositeData flagInfo = (CompositeData) server.invoke(diag, "getVMOption",
            new Object[]{"PrintGC"}, new String[]{"java.lang.String"});
        System.out.println("PrintGC = " + flagInfo.get("value"));
        // 写 flag (需要 writeable flag)
        // server.invoke(diag, "setVMOption",
        //     new Object[]{"PrintGC", "true"}, new String[]{"java.lang.String", "java.lang.String"});
        
        // === 模式 5: 订阅 MBean 通知 (异步 push) ===
        // 订阅 GC 完成通知
        server.addNotificationListener(gc, (notification, handback) -> {
            if (notification.getType().equals(
                    "com.sun.management.gc.notification")) {
                CompositeData cd = (CompositeData) notification.getUserData();
                System.out.printf("GC: %s, duration=%s%n",
                    cd.get("gcAction"), cd.get("gcInfo"));
            }
        }, null, null);
        
        // === 模式 6: 远程 JMX 连接 ===
        // JMXServiceURL url = new JMXServiceURL(
        //     "service:jmx:rmi:///jndi/rmi://localhost:9999/jmxrmi");
        // JMXConnector connector = JMXConnectorFactory.connect(url);
        // MBeanServerConnection remoteServer = connector.getMBeanServerConnection();
        // CompositeData remoteHeap = (CompositeData) remoteServer.getAttribute(
        //     new ObjectName("java.lang:type=Memory"), "HeapMemoryUsage");
        
        // 保持 JVM 运行以便观察通知
        Thread.sleep(60000);
    }
}
```

**代码映射到 JMM 底层**:
- `server.getAttribute(memory, "HeapMemoryUsage")` → `MemoryImpl.getMemoryUsage0(true)` [native] → `jmm_interface->GetMemoryUsage(env, JNI_TRUE)` (MemoryImpl.c:45-47) → `jmm_GetMemoryUsage()` (management.cpp:738-788)
- `server.getAttribute(gc, "CollectionCount")` → `GarbageCollectorImpl.getCollectionCount()` [native] → `jmm_interface->GetLongAttribute(JMM_GC_COLLECTION_COUNT)` → `jmm_GetLongAttribute()` (management.cpp:829-870)
- `server.invoke(diag, "getVMOption", ...)` → `Flag.getFlag()` → `jmm_interface->GetVMGlobals(env, names, count)` → `jmm_GetVMGlobals()` (management.cpp:1536-1599)
- `server.addNotificationListener(gc, ...)` → `jmm_interface->SetGCNotificationEnabled(env, mgr, JNI_TRUE)` → `GCNotifier::addRequest()` → ServiceThread → Java 回调

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux (TencentOS Server 4.2, kernel 5.4.119).

### 2.1 Source Roots — 完整路径映射

| Root | Full Path | Key Files | Role |
|------|-----------|-----------|------|
| **Java MBean impl** | `src/java.management/share/classes/sun/management/` | VMManagementImpl.java (275 lines), MemoryImpl.java, ThreadImpl.java, ManagementFactoryHelper.java (580 lines), GarbageCollectorImpl.java | Java 层 MXBean 实现 — native 方法声明 + MBean 注册 |
| **Native libmanagement** | `src/java.management/share/native/libmanagement/` | management.c (62 lines), VMManagementImpl.c (324 lines), MemoryPoolImpl.c (~145 lines), MemoryImpl.c (49 lines), ThreadImpl.c (~151 lines), GarbageCollectorImpl.c, HotspotThread.c, ClassLoadingImpl.c, MemoryManagerImpl.c | 标准 MXBean JNI 桥接 — 每个函数 1 行 jmm_interface 调用 |
| **Native libmanagement_ext** | `src/jdk.management/share/native/libmanagement_ext/` | management_ext.c (~60 lines), Flag.c (244 lines), DiagnosticCommandImpl.c (~130 lines), HotSpotDiagnostic.c, GarbageCollectorExtImpl.c, GcInfoBuilder.c, OperatingSystemImpl.c (unix, 470 lines), UnixOperatingSystem.c (linux, ~200 lines) | 扩展诊断 JNI 桥接 — Flag/DCmd/OS metrics/Heap dump |
| **Native libmanagement_agent** | `src/jdk.management.agent/unix/native/libmanagement_agent/` | FileSystemImpl.c (74 lines) | Agent 文件权限检查 — stat64 + 权限位 |
| **Java Agent** | `src/jdk.management.agent/share/classes/jdk/internal/agent/` | Agent.java (711 lines), ConnectorBootstrap.java (~600 lines) | JMX Agent 生命周期管理 + RMI Connector 启动 |
| **HotSpot Services** | `src/hotspot/share/services/` | management.cpp (2283 lines), management.hpp, memoryService.cpp (281 lines), memoryService.hpp, lowMemoryDetector.cpp (387 lines), lowMemoryDetector.hpp, threadService.cpp (~900 lines), gcNotifier.cpp (~200 lines), writeableFlags.cpp (~300 lines), classLoadingService.cpp, runtimeService.cpp | JMM 核心实现 — 36 个 jmm_* 函数 + 内存/线程/GC 服务 |
| **JMM Interface** | `src/hotspot/include/` | jmm.h (~400 lines — JmmInterface struct :221-342, 37 slots) | JMM ABI 定义 — .so 和 libjvm.so 之间的二进制接口契约 |
| **VM Init** | `src/hotspot/share/runtime/` | init.cpp (:119 — `management_init()`), thread.cpp (:4291 — `Management::initialize(THREAD)`), arguments.cpp (:2831 — `-Dcom.sun.management` 解析), globals.hpp (:2458 — `ManagementServer` flag 声明) | VM 启动入口 — 两阶段初始化调用点 |
| **Memory Manager** | `src/hotspot/share/services/` | memoryManager.cpp (~280 lines), memoryPool.cpp (~300 lines) | GC 管理器 + 内存池基类 |
| **Diagnostic Command** | `src/hotspot/share/services/` | diagnosticCommand.cpp (~800 lines), diagnosticFramework.cpp | DCmd 命令实现 — jcmd 底层 + JMX DiagnosticCommandMBean |

### 2.2 Build & Binaries

**构建命令**: `make jdk`

**关键二进制路径**:

| Binary | Full Path | .so 内的核心符号 |
|--------|-----------|----------------|
| `libmanagement.so` | `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libmanagement.so` | `DEF_JNI_OnLoad` (management.c:39), `jmm_interface` (management.c:34), 28+ JNI 函数 (VMManagementImpl.c) |
| `libmanagement_ext.so` | `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libmanagement_ext.so` | `DEF_JNI_OnLoad`, `getFlags`, `executeDiagnosticCommand`, `dumpHeap0` |
| `libmanagement_agent.so` | `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libmanagement_agent.so` | `DEF_JNI_OnLoad` (FileSystemImpl.c:40, 返回 JNI_VERSION_10), `isAccessUserOnly0` (FileSystemImpl.c:56) |
| `libjvm.so` | `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` | `management_init()` (management.cpp:84), `jmm_interface` vtable (management.cpp:2232), `Management::init/initialize/get_jmm_interface` |

**JMX Agent 配置文件**: `${JAVA_HOME}/conf/management/management.properties`

**JMX 相关模块**: `java.management` (标准 MXBeans), `jdk.management` (扩展 MXBeans), `jdk.management.agent` (JMX Agent)

### 2.3 全局状态表 — JVM 启动时的关键数据结构

| 变量 | 定义位置 | 类型 | 初始化时机 | 用途 |
|------|---------|------|----------|------|
| `jmm_interface` | management.c:34 | `const JmmInterface*` (初始 NULL) | JNI_OnLoad (management.c:47) | 全局 JMM vtable 指针 — 所有 JNI 函数通过它调用 HotSpot C++ 实现 |
| `jvm` | management.c:35 | `JavaVM*` (初始 NULL) | JNI_OnLoad (management.c:42) | JVM 实例指针 — 用于 GetEnv 等 JNI 调用 |
| `jmm_version` | management.c:36 | `jint` (初始 0) | JNI_OnLoad (management.c:53) | JMM 协议版本号 — 通过 `GetVersion` 获取，用于版本检查 |
| `_optional_support` | management.cpp:81 | `jmmOptionalSupport` (初始 {0}) | Management::init() (management.cpp:121-139) | 9 个 boolean 标志 — 告诉 Java 层哪些监控功能可用 |
| `ManagementServer` | globals.hpp:2458 | `bool` (默认 false) | arguments.cpp:2833 (CMD line) | JMX Agent 启动开关 — 由 `-Dcom.sun.management.jmxremote` 设置 |
| `_begin_vm_creation_time` | management.cpp:66 | `PerfVariable*` (初始 NULL) | Management::init() (management.cpp:107) | sun.rt.createVmBeginTime — VM 创建开始时间戳 |
| `_end_vm_creation_time` | management.cpp:67 | `PerfVariable*` (初始 NULL) | Management::init() (management.cpp:111) | sun.rt.createVmEndTime — VM 创建结束时间戳 |
| `_vm_init_done_time` | management.cpp:68 | `PerfVariable*` (初始 NULL) | Management::init() (management.cpp:115) | sun.rt.vmInitDoneTime — VM 初始化完成时间戳 |

### 2.4 系统调用速查表

| 系统调用 | man 引用 | 使用位置 | 调用方式 | 用途 |
|---------|----------|---------|---------|------|
| `stat64` | man 2 stat | FileSystemImpl.c:64 | `stat64(path, &sb)` — 获取文件元数据 | 检查 jmxremote.password 文件权限位 (S_IRGRP/S_IWGRP/S_IROTH/S_IWOTH) |
| `mmap` | man 2 mmap | PerfData 共享内存创建 | `mmap(NULL, size, PROT_READ\|PROT_WRITE, MAP_SHARED, fd, 0)` | PerfData 计数器共享内存 — jstat 通过 mmap 同一文件读取 |
| `socket` | man 2 socket | RMI Connector (Java 层) | `socket(PF_INET, SOCK_STREAM, 0)` | JMX RMI TCP 通信 socket 创建 |
| `bind` | man 2 bind | RMI Connector (Java 层) | `bind(sockfd, &addr, sizeof(addr))` | JMX RMI 端口绑定 (jmxremote.port) |
| `listen` | man 2 listen | RMI Connector (Java 层) | `listen(sockfd, backlog)` | JMX RMI 连接监听 |
| `accept` | man 2 accept | RMI Connector (Java 层) | `accept(sockfd, &client_addr, &addrlen)` | 接受 jconsole RMI 连接 |
| `kill` | man 2 kill | Attach API (LinuxAttachListener) | `kill(pid, SIGQUIT)` | jcmd/jinfo 触发 Attach Listener 线程 |
| `SIGQUIT` | man 7 signal | Attach API 信号协议 | 信号 #3 | Attach API 进程间通信信号 — 唤醒 AttachListener 线程 |

---

## §三 Source Files Table — 完整清单

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **management.c** | `src/java.management/share/native/libmanagement/management.c` | 62 | `const JmmInterface* jmm_interface = NULL`(:34), `JavaVM* jvm = NULL`(:35), `jint jmm_version = 0`(:36), `DEF_JNI_OnLoad`(:39, →`JVM_GetManagement(JMM_VERSION)` at :47, →`GetVersion` at :53) | Entry — libmanagement.so 初始化，获取 jmm_interface 全局指针 |
| 2 | **management.h** | `src/java.management/share/native/libmanagement/management.h` | 38 | `extern const JmmInterface* jmm_interface`(:34) | Bridge header — 全局 jmm_interface 指针 extern 声明，所有 .c 文件通过它访问 |
| 3 | **VMManagementImpl.c** | `src/java.management/share/native/libmanagement/VMManagementImpl.c` | 324 | `getVersion0`(:35-49), `initOptionalSupportFields`(:62-99), 28+ native methods | JNI 桥接 — 30 个 native 方法 → jmm_interface (22 GetLongAttribute + 5 GetBoolAttribute + 1 GetOptionalSupport + 2 direct JVM) |
| 4 | **VMManagementImpl.java** | `src/java.management/share/classes/sun/management/VMManagementImpl.java` | 275 | 静态初始化(:61-67, →`initOptionalSupportFields()`), `getVersion0()`(:68), 10 optional support fields(:48-58) | Java 层 VMManagement 接口实现 — 10 个 boolean 可选支持标志 |
| 5 | **MemoryImpl.c** | `src/java.management/share/native/libmanagement/MemoryImpl.c` | 49 | `setVerboseGC`(:30, →`jmm_interface->SetBoolAttribute(JMM_VERBOSE_GC)`), `getMemoryPools0`(:35), `getMemoryManagers0`(:40), `getMemoryUsage0`(:45, →`jmm_interface->GetMemoryUsage(env, heap)` at :47) | MemoryMXBean JNI 桥接 — 4 个 native 方法 |
| 6 | **MemoryPoolImpl.c** | `src/java.management/share/native/libmanagement/MemoryPoolImpl.c` | ~145 | `getMemoryManagers0`, `getUsage0`, `getPeakUsage0`, `setUsageThreshold0`, `setCollectionThreshold0`, `resetPeakUsage0`, `setPoolUsageSensor`, `setPoolCollectionSensor`, `getCollectionUsage0` | MemoryPoolMXBean JNI 桥接 — 9 个 native 方法 |
| 7 | **ThreadImpl.c** | `src/java.management/share/native/libmanagement/ThreadImpl.c` | ~151 | `getThreadInfo1`, `getThreads`, `getThreadTotalCpuTime0/1`, `getThreadUserCpuTime0/1`, `getThreadAllocatedMemory0/1`, `findMonitorDeadlockedThreads0`, `findDeadlockedThreads0`, `dumpThreads0`, `setThreadContentionMonitoringEnabled0`, `setThreadCpuTimeEnabled0`, `setThreadAllocatedMemoryEnabled0`, `resetPeakThreadCount0`, `resetContentionTimes0` | ThreadMXBean JNI 桥接 — 16 个 native 方法 |
| 8 | **GarbageCollectorImpl.c** | `src/java.management/share/native/libmanagement/GarbageCollectorImpl.c` | ~50 | `getCollectionCount`, `getCollectionTime` | GarbageCollectorMXBean JNI 桥接 |
| 9 | **HotspotThread.c** | `src/java.management/share/native/libmanagement/HotspotThread.c` | ~60 | `getInternalThreadCount`, `getInternalThreadTimes0` | 内部线程统计 — VMThread/ConcurrentGCThread 等 |
| 10 | **ClassLoadingImpl.c** | `src/java.management/share/native/libmanagement/ClassLoadingImpl.c` | ~40 | `setVerboseClass` | ClassLoadingMXBean JNI 桥接 |
| 11 | **MemoryManagerImpl.c** | `src/java.management/share/native/libmanagement/MemoryManagerImpl.c` | ~60 | `getMemoryPools0` | MemoryManagerMXBean JNI 桥接 |
| 12 | **management.cpp** | `src/hotspot/share/services/management.cpp` | 2283 | `management_init`(:84), `Management::init`(:97), `Management::initialize`(:174), `jmm_interface` vtable(:2232-2272, 37 slots), `get_jmm_interface`(:2275), `jmm_GetMemoryUsage`(:738-788), `jmm_GetLongAttribute`(:829), `jmm_GetBoolAttribute`(:791), `jmm_SetBoolAttribute`(:810), `jmm_GetLongAttributes`(:872), `jmm_GetThreadInfo`(:1077), `jmm_DumpThreads`(:1173), `jmm_SetVMGlobal`(:1601), `jmm_ExecuteDiagnosticCommand`(:1780) | Core — JMM vtable 定义 + 36 个 jmm_* 函数实现 + 两阶段初始化 |
| 13 | **jmm.h** | `src/hotspot/include/jmm.h` | ~400 | `jmmInterface_1_` struct(:221-342, 37 slots: 1 reserved + 36 function pointers), `jmmOptionalSupport`(:57-68, 9 boolean fields), `jmmLongAttribute`(:70-107, 30+ enum values), `jmmBoolAttribute`(:109-119, 5 enum values) | Interface contract — JMM ABI 定义 (.so 和 libjvm.so 之间的二进制接口) |
| 14 | **FileSystemImpl.c** | `src/jdk.management.agent/unix/native/libmanagement_agent/FileSystemImpl.c` | 74 | `DEF_JNI_OnLoad`(:40, →`JNI_VERSION_10` at :48), `isAccessUserOnly0`(:56-73, →`stat64(path, &sb)` at :64, →`S_IRGRP\|S_IWGRP\|S_IROTH\|S_IWOTH` at :65) | Agent 权限检查 — 无 JMM interface, 纯 POSIX |
| 15 | **init.cpp** | `src/hotspot/share/runtime/init.cpp` | ~200 | `init_globals()` → `management_init()`(:119), →`ThreadService::init()`, →`RuntimeService::init()`, →`ClassLoadingService::init()` | Init — 早期 VM 启动，Java 堆创建前调用 |
| 16 | **thread.cpp** | `src/hotspot/share/runtime/thread.cpp` | ~4300 | `Threads::create_vm()` → `Management::initialize(THREAD)`(:4291) | Init — Java 堆就绪后调用，加载 MXBean 类 |
| 17 | **Agent.java** | `src/jdk.management.agent/share/classes/jdk/internal/agent/Agent.java` | 711 | `startAgent()`(:590-638), `startLocalManagementAgent()`(:313-332), `startRemoteManagementAgent()`(:338-399) | JMX Agent 生命周期 — 本地/远程 connector 启动 |
| 18 | **ConnectorBootstrap.java** | `src/jdk.management.agent/share/classes/sun/management/jmxremote/ConnectorBootstrap.java` | ~600 | `startRemoteConnectorServer()`(:330-510), `startLocalConnectorServer()`(:516-564) | RMI Connector 启动 — 创建 RMI registry + JMXConnectorServer |
| 19 | **ManagementFactoryHelper.java** | `src/java.management/share/classes/sun/management/ManagementFactoryHelper.java` | 580 | 创建 Platform MXBean 单例(:67-81), `registerInternalMBeans()`(:496-514) | MBean 工厂 — 单例创建所有 MXBean + HotSpot Internal MBeans |
| 20 | **arguments.cpp** | `src/hotspot/share/runtime/arguments.cpp` | ~3060 | `-Dcom.sun.management` 解析 → `FLAG_SET_CMDLINE(bool, ManagementServer, true)`(:2831-2833), `jdk.module.addmods=jdk.management.agent`(:2837) | 命令行参数解析 — ManagementServer 标志 + 模块添加 |
| 21 | **globals.hpp** | `src/hotspot/share/runtime/globals.hpp` | ~2500 | `product(bool, ManagementServer, false, ...)`(:2458) | VM Flag 声明 — ManagementServer 默认值定义 (product flag) |
| 22 | **memoryService.cpp** | `src/hotspot/share/services/memoryService.cpp` | 281 | `set_universe_heap`(:70-91), `add_code_heap_memory_pool`(:93-108), `add_metaspace_memory_pools`(:110-124), `gc_begin`(:167-180), `gc_end`(:182-190), `create_MemoryUsage_obj` | 内存池/管理器注册 + GC 回调 — 被 management.cpp 调用 |

---

## §四 Deep Dive Question Groups — 6 组深度问答

### 4.1 JMX 三层桥接架构 — 从 jconsole 到 management.cpp

**问题**:
1. jconsole 的 `getAttribute("HeapMemoryUsage")` 如何跨越 Java→Native→C++ 三层？每层做什么？每层不做什么？
2. **Counterfactual**: 如果 jconsole 直接通过 JNI 调用 management.cpp（跳过 MBeanServer）？

**答案方向** (≥8 行):
```
Layer 1 — Java MBean 层 (入口):
  jconsole 通过 RMI 发送: MBeanServerConnection.getAttribute(
    ObjectName("java.lang:type=Memory"), "HeapMemoryUsage")
  → RMI connector 反序列化请求 → MBeanServer 内部 HashMap 查找 ObjectName
  → 找到 MemoryImpl 实例 (ManagementFactoryHelper.java:67-81 创建的单例)
  → 反射调用 MemoryImpl.getHeapMemoryUsage()
  → 方法体: MemoryUsage u = getMemoryUsage0(true); // native 声明
  Java 层不访问任何 JVM 内部数据结构 — 只做 RMI 反序列化 + 方法分发。
  file:line: ManagementFactoryHelper.java:67-81 (MXBean 单例创建)

Layer 2 — Native JNI 层 (桥接):
  MemoryImpl.c:45-47:
    JNIEXPORT jobject JNICALL Java_sun_management_MemoryImpl_getMemoryUsage0
      (JNIEnv *env, jobject dummy, jboolean heap) {
        return jmm_interface->GetMemoryUsage(env, heap);  // ← 只有 1 行！
    }
  JNI 层不做任何业务逻辑 — 只做参数转发。heap 参数直接透传给 jmm_interface。
  jmm_interface 在 management.c:34 定义为全局指针，在 JNI_OnLoad (management.c:47)
  通过 JVM_GetManagement(JMM_VERSION) 获取。
  file:line: MemoryImpl.c:45-47, management.c:34-47

Layer 3 — HotSpot C++ 层 (实现):
  management.cpp:738-788: jmm_GetMemoryUsage()
  → JVM_ENTRY 宏: _thread_in_native → _thread_in_vm (支持 safepoint)
  → for (i=0; i < MemoryService::num_memory_pools(); i++) (line 749)
  → pool->is_heap()? 过滤: 只累加 heap pools (Eden/Survivor/Old)
  → total_used += u.used(); total_committed += u.committed(); (lines 753-754)
  → 处理 -1 哨兵值: init_size==-1 → has_undefined_init_size=true (lines 756-769)
  → MemoryUsage usage(...) (lines 781-784)
  → MemoryService::create_MemoryUsage_obj(usage) (line 786) → 构造 Java CompositeData
  → return JNIHandles::make_local(env, obj()) (line 787)
  file:line: management.cpp:738-788, MemoryImpl.c:45-47

追问: JVM_ENTRY 和 JVM_LEAF 的区别？
  → JVM_ENTRY 做线程状态转换 + ResourceMark + HandleMark — 可以访问 Java 堆
  → JVM_LEAF 不做转换 — 不能访问 Java 堆，只能读 C 全局变量
  → jmm_GetMemoryUsage 需要构造 Java CompositeData → 必须用 JVM_ENTRY
  → jmm_GetBoolAttribute 只读全局标志 → 可以用 JVM_LEAF
  file:line: interfaceSupport.inline.hpp:558 (JVM_ENTRY), :603 (JVM_LEAF)
```

**Counterfactual**: 如果 jconsole 直接通过 JNI 调用 management.cpp（跳过 MBeanServer）→ 需要在 jconsole 中链接 libmanagement.so → jconsole 变成 native 应用（平台相关，JNI 绑定 OS 特定）→ 失去 JMX 的"任何 JMX 客户端都能连接"的互操作性优势。MBeanServer 提供三层价值: (a) 注册/发现机制 — `queryNames(null, null)` 列出所有 MBean 而不硬编码名称 (b) 远程透明性 — RMI connector 序列化参数和返回值 (c) 安全控制 — MBeanPermission 限制对特定 MBean/操作的访问。没有 MBeanServer，每个监控工具都需要硬编码 JNI 函数名和参数类型。

### 4.2 10+ MXBean 能力矩阵 — 标准 8 + HotSpot Internal 5

**问题**:
1. 标准 Platform MXBeans（8 个）各自暴露什么 JVM 内部状态？native 方法如何映射到 jmm_interface？
2. HotSpot Internal MXBeans（5 个）和标准 MXBeans 的区别是什么？
3. **Counterfactual**: 如果所有数据都放在一个巨型 MXBean 中？

**答案方向** (≥8 行):
```
标准 Platform MXBeans — 8 个，ObjectName 域 java.lang:

1. ClassLoadingMXBean (ObjectName: java.lang:type=ClassLoading)
  属性: LoadedClassCount, TotalLoadedClassCount, UnloadedClassCount, Verbose
  native: VMManagementImpl.getTotalClassCount() → jmm_interface->GetLongAttribute(JMM_CLASS_LOADED_COUNT)
    VMManagementImpl.c:108-116
  追问: 为什么 loaded 和 unloaded 分开计数？
    → JMM_CLASS_LOADED_COUNT 是所有历史累计 (只增不减)
    → JMM_CLASS_UNLOADED_COUNT 是卸载计数 (GC 回收类时增加)
    → 当前加载 = loaded - unloaded (Java 层计算)

2. CompilationMXBean (ObjectName: java.lang:type=Compilation)
  属性: Name (编译器名称, 如 "HotSpot 64-Bit Tiered Compilers"), TotalCompilationTime (ms)
  native: VMManagementImpl.getTotalCompileTime() → jmm_interface->GetLongAttribute(JMM_COMPILE_TOTAL_TIME_MS)
    VMManagementImpl.c:177-183
  追问: 为什么只有一个时间，没有编译次数？
    → 编译次数可通过 jcmd <pid> Compiler.CodeHeap_Analytics 间接查看
    → JMM 接口设计时认为编译时间比次数更有监控价值

3. MemoryMXBean (ObjectName: java.lang:type=Memory)
  属性: HeapMemoryUsage, NonHeapMemoryUsage, ObjectPendingFinalizationCount, Verbose
  操作: gc() — 触发 Full GC (System.gc() 的 JMX 对等物)
  native: MemoryImpl.getMemoryUsage0(heap) → jmm_interface->GetMemoryUsage(env, heap)
    MemoryImpl.c:45-47 → management.cpp:738-788
  返回值: CompositeData{init: jlong, used: jlong, committed: jlong, max: jlong}
  → 这是 MXBean 的关键设计: open type 使任何 JMX 客户端都能解析

4. ThreadMXBean (ObjectName: java.lang:type=Threading)
  属性: ThreadCount, PeakThreadCount, DaemonThreadCount, TotalStartedThreadCount
  操作: getThreadInfo(ids, maxDepth), findDeadlockedThreads(), dumpAllThreads()
  native: ThreadImpl.c 16 JNI 函数 → jmm_interface->GetThreadInfo/DumpThreads/FindDeadlockedThreads
  追问: getThreadInfo maxDepth==0 vs maxDepth!=0 的区别？
    → maxDepth==0: 仅线程基本信息 (name, state, blockedTime) — 无需 safepoint
    → maxDepth!=0: 含栈帧 (stackTrace) — 需要 VM_ThreadDump safepoint

5. RuntimeMXBean (ObjectName: java.lang:type=Runtime)
  属性: VmName, VmVersion, StartTime, Uptime, InputArguments, SystemProperties
  native: VMManagementImpl.getVmArguments0() → JVM_GetVmArguments(env) (非 jmm_interface)
    VMManagementImpl.c:102-105 — 直接 JVM 入口，不走 jmm_interface
  追问: 为什么 getVmArguments0 不走 jmm_interface？
    → JVM_GetVmArguments 是标准 JVM 入口函数 (定义在 jvm.h)
    → 不需要 JMM 版本管理 — 所有 JVM 版本都支持

6. OperatingSystemMXBean (ObjectName: java.lang:type=OperatingSystem)
  属性: Name, Arch, AvailableProcessors, SystemLoadAverage, Version
  native: VMManagementImpl.getAvailableProcessors() → JVM_ActiveProcessorCount()
    VMManagementImpl.c:232-235 — 直接 JVM 入口

7. GarbageCollectorMXBean (ObjectName: java.lang:type=GarbageCollector,name=*)
  属性: CollectionCount, CollectionTime, MemoryPoolNames[]
  native: GarbageCollectorImpl.c → jmm_interface->GetLongAttribute(JMM_GC_COLLECTION_COUNT/EXTENT)
  实例: 每个 GC 算法一个实例 — G1 Young Generation, G1 Old Generation 等

8. MemoryPoolMXBean (ObjectName: java.lang:type=MemoryPool,name=*)
  属性: Usage, PeakUsage, CollectionUsage, UsageThreshold, CollectionUsageThreshold
  操作: setUsageThreshold(count), setCollectionUsageThreshold(count)
  native: MemoryPoolImpl.c 9 JNI 函数 → jmm_interface
  实例: G1 Eden Space, G1 Survivor Space, G1 Old Gen, CodeHeap 'non-nmethods', Metaspace 等
```

```
HotSpot Internal MXBeans — 5 个，ObjectName 域 sun.management:
由 ManagementFactoryHelper.registerInternalMBeans() (line 496-514) 注册。
它们在 jconsole 默认不展开（需要点击 sun.management 域）。

- HotspotRuntime: getSafepointCount(), getTotalSafepointTime(), getSafepointSyncTime()
  → VMManagementImpl.c:238-260 → jmm_interface->GetLongAttribute(JMM_SAFEPOINT_COUNT/TIME)
- HotspotClassLoading: getLoadedClassSize(), getUnloadedClassSize(), getClassLoadingTime(),
    getInitializedClassCount(), getClassInitializationTime(), getClassVerificationTime()
  → VMManagementImpl.c:270-324 → jmm_interface->GetLongAttribute
- HotspotThread: getInternalThreadCount(), getInternalThreadTimes()
  → HotspotThread.c → jmm_interface
- HotspotCompilation: JIT 编译统计 (通过 CompilationMXBean 扩展)
- HotspotMemory: GC 统计 (GcInfo — 通过 GarbageCollectorMXBean 扩展)
```

**Counterfactual**: 如果所有数据放在一个巨型 MXBean → `getMemoryUsage` 时也会触发 `getThreadInfo` → 不必要的 safepoint（线程 dump）→ 性能耦合（查内存导致 STW）。分拆为多个 MXBean 允许: (a) 按需查询 — 只查内存不触发线程 safepoint (b) 权限控制 — 限制对 ThreadMXBean 的访问而不影响 MemoryMXBean (c) MBean 树清晰 — jconsole 按 ObjectName domain 分组 (d) 独立开发 — 不同 MXBean 由不同团队维护。

### 4.3 3 个 .so 的角色分工 — JNI_OnLoad 差异详解

**问题**:
1. libmanagement.so、libmanagement_ext.so、libmanagement_agent.so 各自的 JNI_OnLoad 有什么区别？
2. **Counterfactual**: 如果把 3 个 .so 合并为一个？

**答案方向** (≥8 行):
```
libmanagement.so — 标准 MXBean JNI 桥接 (927 行, 10 源文件):
  JNI_OnLoad (management.c:39-55):
    Step 1: (*vm)->GetEnv(vm, &env, JNI_VERSION_1_2) → 获取 JNI 环境 (line 43)
    Step 2: jmm_interface = (JmmInterface*) JVM_GetManagement(JMM_VERSION) (line 47)
      → 如果返回 NULL: JNU_ThrowInternalError → return JNI_ERR (lines 48-50)
      → 返回 JNI_ERR → System.loadLibrary("management") 抛出 UnsatisfiedLinkError
      → 后果: 所有 JMX MXBeans 不可用 — JVM 无法启动或降级运行
    Step 3: jmm_version = jmm_interface->GetVersion(env) (line 53)
    Step 4: return (*env)->GetVersion(env) (line 54)
  核心源文件: VMManagementImpl.c (324行, 30 JNI函数), MemoryPoolImpl.c (9函数),
    MemoryImpl.c (4函数), ThreadImpl.c (16函数), GarbageCollectorImpl.c,
    HotspotThread.c, ClassLoadingImpl.c, MemoryManagerImpl.c
  关键: 每个 JNI 函数只有 1 行: return jmm_interface->Xxx(env, ...)
  这保证了 .so 的 JNI 层是纯粹的转发层 — 不包含任何业务逻辑。

libmanagement_ext.so — 扩展诊断 JNI 桥接 (1851 行, 9 源文件):
  JNI_OnLoad: 同样调用 JVM_GetManagement(JMM_VERSION) → 获取同一个 jmm_interface 实例
  核心源文件:
    Flag.c (244行): getFlags, setLongValue, setBooleanValue, setStringValue — jinfo 底层
    DiagnosticCommandImpl.c (130行): executeDiagnosticCommand — jcmd 的 JMX 接口
    HotSpotDiagnostic.c: dumpHeap0 — Heap dump 触发
    OperatingSystemImpl.c (unix, 470行): 物理内存/Swap/FD 查询 — /proc 文件系统解析
    UnixOperatingSystem.c (linux, ~200行): CPU load — /proc/stat 解析
  关键: 与 libmanagement.so 共享同一个 jmm_interface — 两个 .so 调用同一套 C++ 实现

libmanagement_agent.so — Agent 文件权限检查 (74 行, 1 源文件):
  JNI_OnLoad (FileSystemImpl.c:40-49):
    Step 1: (*vm)->GetEnv(vm, &env, JNI_VERSION_1_2) (line 44)
    Step 2: return JNI_VERSION_10 (line 48) — 仅此而已！
    注意: 不调用 JVM_GetManagement — 没有 jmm_interface 指针
  唯一函数: isAccessUserOnly0 (FileSystemImpl.c:56-73)
    → stat64(path, &sb) (line 64) — man 2 stat
    → 检查: (sb.st_mode & (S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH)) == 0 (line 65)
    → 纯 POSIX 操作 — 不访问 JVM 内部状态
  为什么不需要 jmm_interface？因为它只检查文件系统权限 —
  不读取任何 JVM 内部数据结构。stat64 是 Linux 系统调用，完全独立于 JVM。
```

**Counterfactual**: 如果把 3 个 .so 合并为一个 → 单个 .so 包含所有 JNI 函数 → 加载时必须全部初始化（OS 指标查询需要平台特定代码 — 470 行 OperatingSystemImpl.c 含 Linux/macOS/Solaris/AIX 差异）→ 平台无关的 .so 包含大量 #ifdef → 维护复杂度上升 → 二进制体积增大。拆分为 3 个 .so 允许: (a) 按需加载 — 不使用 jdk.management 模块时 libmanagement_ext.so 不加载 (b) 独立构建 — platform-specific 代码隔离在 libmanagement_ext.so (c) 独立版本管理 — agent 接口很少变化，management 接口随 JMM 版本变化 (d) 独立失败域 — libmanagement.so 加载失败不影响 libmanagement_agent.so。

### 4.4 Management 初始化三阶段 — 时间线详解

**问题**:
1. `management_init()` → `Management::init()` → `Management::initialize()` 各自在什么时机、什么条件下执行？各自做了什么？
2. **Counterfactual**: 如果 Phase 2（`Management::init()`）延迟到 Phase 3（堆创建后）？

**答案方向** (≥8 行):
```
Phase 1 — management_init() (management.cpp:84-93):
  调用点: init_globals() (init.cpp:119), 在 Threads::create_vm() 中
  时机: Java 堆尚未创建 — 在 Universe::genesis() 之前，codeCache_init() 之后
  条件: 无条件执行（不受 ManagementServer 标志影响）
  操作:
    Management::init() — JMX 核心初始化
    ThreadService::init() — 线程监控服务初始化
    RuntimeService::init() — 运行时服务初始化 (safepoint 时间追踪)
    ClassLoadingService::init() — 类加载监控初始化
  #if INCLUDE_MANAGEMENT 条件编译保护
  如果不编译 management 模块 → 仅调用 ThreadService::init()
  file:line: init.cpp:119, management.cpp:84-93

Phase 2 — Management::init() (management.cpp:97-172):
  调用点: management_init() → Management::init()
  时机: Java 堆尚未创建 — 不能加载 Java 类，不能访问 oop
  条件: 无条件执行（#if INCLUDE_MANAGEMENT 内）
  操作:
    1. 创建 3 个 PerfData 计数器 (lines 107-117):
       sun.rt.createVmBeginTime → _begin_vm_creation_time (PerfVariable*)
       sun.rt.createVmEndTime   → _end_vm_creation_time (PerfVariable*)
       sun.rt.vmInitDoneTime    → _vm_init_done_time (PerfVariable*)
       即使 -XX:-UsePerfData 也会创建 (分配在 C heap)
       存储位置: /tmp/hsperfdata_<user>/<pid> (mmap 共享内存文件)
       读取工具: jstat — 通过 mmap 同一文件读取，零 JNI 开销
    2. 填充 _optional_support 位域 (lines 121-139):
       9 个 boolean 标志告诉 Java 层哪些监控功能可用:
         isLowMemoryDetectionSupported = 1
         isCompilationTimeMonitoringSupported = 1
         isThreadContentionMonitoringSupported = 1
         isCurrentThreadCpuTimeSupported (依赖 os::is_thread_cpu_time_supported())
         isOtherThreadCpuTimeSupported (同上)
         isObjectMonitorUsageSupported = 1
         isSynchronizerUsageSupported = 1 (#if INCLUDE_SERVICES)
         isThreadAllocatedMemorySupported = 1
         isRemoteDiagnosticCommandsSupported = 1
       Java 层通过 VMManagementImpl.initOptionalSupportFields() 读取 (VMManagementImpl.c:62-99)
    3. 注册 jcmd 命令 (line 148):
       DCmdRegistrant::register_dcmds() — 注册基础/VM/GC/类/线程/编译器/JMX Agent 命令
       DCmdRegistrant::register_dcmds_ext() — 扩展命令 (默认空)
    4. 注册 NMTDCmd (line 171):
       DCmdFactory::register_DCmdFactory<NMTDCmd>(full_export, true, false)
       导出范围: DCmd_Source_Internal | DCmd_Source_AttachAPI | DCmd_Source_MBean
       → 可通过 jcmd <pid> VM.native_memory 和 DiagnosticCommandMBean.execute() 访问
  file:line: management.cpp:97-172

Phase 3 — Management::initialize(TRAPS) (management.cpp:174-198):
  调用点: thread.cpp:4291 — Threads::create_vm() 中，Java 堆已就绪
  时机: Universe::genesis() 之后，Java 类系统可用
  条件: if (ManagementServer) — 由 -Dcom.sun.management.jmxremote 设置
    如果 ManagementServer == false → 整个函数是 no-op → 直接返回
  操作 (仅当 ManagementServer == true):
    1. SystemDictionary::resolve_or_null("jdk/internal/agent/Agent") (line 182-184)
       → 加载 jdk.internal.agent.Agent 类
       → 如果 k == NULL: vm_exit_during_initialization (line 186-188)
         → JVM 终止启动 — 因为用户明确要求 JMX 但 Agent 类不可用
    2. JavaCalls::call_static(result, k, "startAgent", "()V", CHECK) (lines 191-194)
       → 调用 Agent.startAgent() (Agent.java:590-638)
         → startLocalManagementAgent() (Agent.java:313-332) — 始终启动本地 connector
         → 如果 jmxremote.port 设置:
           startRemoteManagementAgent() (Agent.java:338-399)
           → ConnectorBootstrap.startRemoteConnectorServer() (ConnectorBootstrap.java:330)
             → 创建 RMI registry + JMXConnectorServer + 绑定端口
             → jconsole 可以连接
  file:line: thread.cpp:4291, management.cpp:174-198
```

**Counterfactual**: 如果 Phase 2 延迟到 Phase 3 之后（堆创建后）→ PerfData 计数器 `createVmBeginTime` 无法记录 VM 创建开始时间（因为它创建在 `Universe::genesis()` 之后）→ jstat 显示 `sun.rt.createVmBeginTime` 为 0 或 N/A → 启动耗时监控失效。jcmd 命令在堆创建前不可用 → 早期启动阶段的诊断命令（如 VM.uptime）无法执行 → 如果 VM 在 Phase 2 之前卡住（如 CodeCache 分配失败），无法通过 jcmd 诊断。此外，`_optional_support` 位域在 Java 层 `VMManagementImpl` 静态初始化时需要读取 — 如果 Phase 2 延迟，`initOptionalSupportFields()` 返回的位域可能是未初始化的 {0} → Java 层认为所有监控功能都不支持 → MXBean 降级。

### 4.5 jconsole 连接 → HeapMemoryUsage 端到端 8 步追踪

**问题**:
1. 从 jconsole RMI 连接到 `getHeapMemoryUsage()` 返回的完整 8 步数据流？每步涉及哪些函数、哪些线程状态转换？
2. **Counterfactual**: 如果 MemoryImpl.java 直接访问 C++ 全局变量（不走 jmm_interface）？

**答案方向** (≥8 行):
```
Step 1 — RMI 连接建立:
  jconsole 发起 RMI 连接到 JMXConnectorServer (ConnectorBootstrap 创建)
  → JMXConnectorServer 在 jmxremote.port 上监听 (man 2 listen)
  → jconsole 获取 MBeanServerConnection 代理对象
  涉及 syscall: socket() → bind() → listen() → accept() (Java RMI 层)
  file:line: ConnectorBootstrap.java:330-510

Step 2 — MBeanServer 查询分发:
  jconsole 发送: MBeanServerConnection.getAttribute(
    ObjectName("java.lang:type=Memory"), "HeapMemoryUsage")
  → RMI 序列化 ObjectName + 属性名 → 传输到 JVM 端
  → RMI connector 反序列化 → 调用 Platform MBeanServer.getAttribute()
  → MBeanServer 内部 HashMap 查找 ObjectName → 找到 MemoryImpl 实例
  → 反射调用 MemoryImpl.getHeapMemoryUsage()
  file:line: ManagementFactoryHelper.java:67-81 (单例注册)

Step 3 — Java 层 native 声明:
  MemoryImpl.getHeapMemoryUsage() 方法体:
    MemoryUsage u = getMemoryUsage0(true);  // private native
    return u;
  → 编译为 JNI 调用 → 查找注册的 native 方法
  file:line: MemoryImpl.java (sun.management 包, JDK 内部类)

Step 4 — JNI 桥接 (1 行):
  MemoryImpl.c:45-47:
    JNIEXPORT jobject JNICALL
    Java_sun_management_MemoryImpl_getMemoryUsage0
      (JNIEnv *env, jobject dummy, jboolean heap) {
        return jmm_interface->GetMemoryUsage(env, heap);
    }
  → 线程状态: _thread_in_native (JNI 调用自动设置)
  → jmm_interface 是在 JNI_OnLoad 中获取的全局函数指针表
  → GetMemoryUsage 是 vtable 中的第 8 个函数指针 (management.cpp:2243)
  file:line: MemoryImpl.c:45-47, management.cpp:2243

Step 5 — JVM_ENTRY 线程状态转换:
  management.cpp:738: JVM_ENTRY(jobject, jmm_GetMemoryUsage(JNIEnv* env, jboolean heap))
  → JVM_ENTRY 宏展开:
    Thread* THREAD = Thread::current();
    JavaThread* jt = (JavaThread*)THREAD;
    ThreadStateTransition::transition_from_native(jt, _thread_in_vm);
    // ... 函数体 ...
    ThreadStateTransition::transition_from_vm(jt, _thread_in_native);
  → 线程状态: _thread_in_native → _thread_in_vm
  → 此时可以安全访问 Java 堆 + 支持 safepoint 检查
  → ResourceMark rm(THREAD) — 临时内存分配
  file:line: management.cpp:738, interfaceSupport.inline.hpp:558

Step 6 — 遍历内存池累加:
  management.cpp:749-770:
    for (int i = 0; i < MemoryService::num_memory_pools(); i++) {
      MemoryPool* pool = MemoryService::get_memory_pool(i);
      if ((heap && pool->is_heap()) || (!heap && pool->is_non_heap())) {
        MemoryUsage u = pool->get_memory_usage();
        total_used += u.used();
        total_committed += u.committed();
        // 处理 -1 哨兵值 (表示未定义)
        if (u.init_size() == (size_t)-1) has_undefined_init_size = true;
        if (u.max_size() == (size_t)-1) has_undefined_max_size = true;
      }
    }
  → G1 GC 下遍历的 pools: G1 Eden Space, G1 Survivor Space, G1 Old Gen
  → 每个 pool->get_memory_usage() 返回 MemoryUsage{init, used, committed, max}
  → 如果任意 pool 的 init_size 或 max_size 为 -1 → 全部设为 -1 (lines 774-779)
  file:line: management.cpp:749-779

Step 7 — 构造 Java CompositeData:
  management.cpp:781-787:
    MemoryUsage usage((heap ? InitialHeapSize : total_init),
                      total_used, total_committed,
                      (heap ? Universe::heap()->max_capacity() : total_max));
    Handle obj = MemoryService::create_MemoryUsage_obj(usage, CHECK_NULL);
  → MemoryUsage 是 C++ 结构体 (4 个 size_t 字段)
  → create_MemoryUsage_obj 构造 Java CompositeData:
    CompositeDataSupport(CompositeType, {"init","used","committed","max"},
                         {512MB, 200MB, 1024MB, 4096MB})
  → 注意: heap=true 时 init 使用 InitialHeapSize (JVM flag)
    max 使用 Universe::heap()->max_capacity() (堆上限)
    而非遍历累加值 — 因为 init 和 max 是全局属性而非 per-pool 累加
  file:line: management.cpp:781-787

Step 8 — 返回 + 序列化:
  management.cpp:787: return JNIHandles::make_local(env, obj());
  → JNI local reference → 返回给 Java 层
  → MemoryImpl.getHeapMemoryUsage() 收到 MemoryUsage 对象
  → RMI connector 序列化 MemoryUsage (CompositeData) → 返回 jconsole
  → jconsole 解析 CompositeData 的 4 个字段 → 更新 GUI 曲线
  → 线程状态: _thread_in_vm → _thread_in_native → _thread_in_Java
  全程耗时: ~2ms (正常情况, 无 safepoint 阻塞, 无 GC 并发)
```

**Counterfactual**: 如果 MemoryImpl.java 直接访问 C++ 全局变量（不走 jmm_interface）→ 需要 JNI 直接访问 C++ 对象（如 `MemoryService::_pools_list` 成员）→ 破坏 JMM ABI 隔离 → .so 和 libjvm.so 编译耦合（必须同版本编译器、同内存布局）→ HotSpot 内部重构（如修改 MemoryPool 结构体）会破坏所有已编译的 .so → 需要重新编译所有 .so 才能升级 JVM。jmm_interface vtable 的设计就是为了避免这种耦合 — .so 只依赖函数指针表，不依赖任何 C++ 对象的内存布局。

### 4.6 JMX Connector vs Attach API — 两条数据通路对比

**问题**:
1. JMX Connector (jconsole) 和 Attach API (jcmd) 的底层差异是什么？各自适合什么场景？
2. **Counterfactual**: 如果去掉 Attach API，只用 JMX Connector？

**答案方向** (≥8 行):
```
JMX Connector (jconsole 路径):
  协议层: RMI over TCP — 远程可用
    syscall: socket() (man 2 socket) → bind() (man 2 bind) → listen() (man 2 listen) → accept()
  认证: 支持 jmxremote.password + jmxremote.access 文件认证 + SSL
  数据格式: JMX 序列化 — CompositeData, TabularData (open types)
  接口: MBeanServer.getAttribute() → native JNI → jmm_interface vtable
  生命周期: 持续连接 — jconsole 保持 RMI 连接，定期轮询 MBean
  使用场景: 远程监控面板 (jconsole), 告警系统 (Prometheus JMX Exporter), 生产环境持续监控
  优点: 远程可用, 标准化, 支持通知订阅 (addNotificationListener)
  缺点: 需要配置端口+认证, 网络开销, 默认不安全 (无认证时任何能连上端口的客户端都能读取所有 MBean)

Attach API (jcmd 路径):
  协议层: SIGQUIT 信号 + UNIX domain socket (Linux) / Windows named pipe — 仅本机
    syscall: kill(pid, SIGQUIT) (man 2 kill) → 触发 AttachListener 线程
    → UNIX socket 握手 → 传输命令 → 接收结果
  认证: OS 用户匹配 — 同机同用户才能 attach, 无额外配置
  数据格式: 文本 (jcmd 命令输出) — 人类可读
  接口: AttachListener → DCmd::parse_and_execute() → 直接 C++ 函数调用
  生命周期: 一次性命令 — jcmd 发送命令 → 等待结果 → 断开
  使用场景: 紧急诊断 (jcmd <pid> GC.heap_dump), 调优 (jinfo -flag), 线程分析 (jstack)
  优点: 零配置, 低开销, 安全 (仅本机同用户)
  缺点: 不可远程, 不支持持续监控, 不支持通知订阅

汇合点 — WriteableFlags::set_flag():
  三条路径最终走到同一个 C++ 函数 (writeableFlags.cpp:238):
    Path 1 (JMX): Flag.c → jmm_interface->SetVMGlobal() → jmm_SetVMGlobal (management.cpp:1601)
      → WriteableFlags::set_flag(name, value, JVMFlag::MANAGEMENT)
    Path 2 (jcmd): attachListener.cpp → DCmd::parse_and_execute()
      → WriteableFlags::set_flag(name, value, JVMFlag::ATTACH_ON_DEMAND)
    Path 3 (DCmd JMX): DiagnosticCommandImpl.c → jmm_interface->ExecuteDiagnosticCommand
      → DCmd::parse_and_execute()
      → WriteableFlags::set_flag(name, value, JVMFlag::MANAGEMENT)
  FlagOrigin 区分调用来源 — 用于审计和权限控制
  file:line: writeableFlags.cpp:238, management.cpp:1601, Flag.c:83-203
```

**Counterfactual**: 如果去掉 Attach API，只用 JMX Connector → jcmd/jinfo/jstack 工具必须通过 JMX RMI 连接 → 需要配置 `jmxremote.port` + 认证 → 生产环境的零配置诊断通道消失 → 紧急情况下（JVM OOM、死锁、高 CPU）无法用 `jcmd <pid> Thread.print` 快速诊断 → 必须在 JVM 启动时就配好 JMX 端口。Attach API 的 UNIX socket 提供"后门"访问 — 即使 JVM 没有配 JMX 也能通过 SIGQUIT 信号触发诊断。但失去远程监控能力 — Attach API 仅本机可用。

---

## §五 VMManagementImpl — 30 个 JNI 函数映射表

VMManagementImpl.c 是 libmanagement.so 中最大的 JNI 桥接文件（324 行）。每个函数都是 1-3 行代码：调用 jmm_interface 函数指针 → 返回结果。所有 30 个方法共享同一个 jmm_interface 指针（在 management.c:34 定义，management.h:34 声明为 extern）。

**30 个方法中**: 22 个走 `GetLongAttribute` (73%)，5 个走 `GetBoolAttribute` (17%)，1 个走 `GetOptionalSupport` (3%)，2 个直接调用 JVM 入口 (7%)。这种高度一致性是 jmm_interface vtable 设计的成功证明。

| # | Java Method | Native C Function | jmm_interface Call | JMM Constant | VMManagementImpl.c |
|---|------------|-------------------|--------------------|--------------|:---:|
| 1 | `getVersion0()` | `Java_..._getVersion0` | 读取全局 `jmm_version` (management.c:36) | 版本拆解: major = (v & 0x0FFF0000)>>16, minor = (v & 0xFF00)>>8 | :35-49 |
| 2 | `initOptionalSupportFields()` | `Java_..._initOptionalSupportFields` | `GetOptionalSupport(env, &mos)` | `jmmOptionalSupport` struct (9 boolean fields) | :62-99 |
| 3 | `getVmArguments0()` | `Java_..._getVmArguments0` | `JVM_GetVmArguments(env)` — 直接 JVM 调用 | 非 jmm_interface — 标准 JVM 入口 | :101-106 |
| 4 | `getTotalClassCount()` | `Java_..._getTotalClassCount` | `GetLongAttribute(env, NULL, ...)` | `JMM_CLASS_LOADED_COUNT` | :108-116 |
| 5 | `getUnloadedClassCount()` | `Java_..._getUnloadedClassCount` | `GetLongAttribute(env, NULL, ...)` | `JMM_CLASS_UNLOADED_COUNT` | :118-126 |
| 6 | `getVerboseGC()` | `Java_..._getVerboseGC` | `GetBoolAttribute(env, ...)` | `JMM_VERBOSE_GC` | :128-133 |
| 7 | `getVerboseClass()` | `Java_..._getVerboseClass` | `GetBoolAttribute(env, ...)` | `JMM_VERBOSE_CLASS` | :135-140 |
| 8 | `getTotalThreadCount()` | `Java_..._getTotalThreadCount` | `GetLongAttribute(env, NULL, ...)` | `JMM_THREAD_TOTAL_COUNT` | :142-148 |
| 9 | `getLiveThreadCount()` | `Java_..._getLiveThreadCount` | `GetLongAttribute(env, NULL, ...)` | `JMM_THREAD_LIVE_COUNT` | :150-157 |
| 10 | `getPeakThreadCount()` | `Java_..._getPeakThreadCount` | `GetLongAttribute(env, NULL, ...)` | `JMM_THREAD_PEAK_COUNT` | :159-166 |
| 11 | `getDaemonThreadCount()` | `Java_..._getDaemonThreadCount` | `GetLongAttribute(env, NULL, ...)` | `JMM_THREAD_DAEMON_COUNT` | :168-175 |
| 12 | `getTotalCompileTime()` | `Java_..._getTotalCompileTime` | `GetLongAttribute(env, NULL, ...)` | `JMM_COMPILE_TOTAL_TIME_MS` | :177-183 |
| 13 | `getStartupTime()` | `Java_..._getStartupTime` | `GetLongAttribute(env, NULL, ...)` | `JMM_JVM_INIT_DONE_TIME_MS` | :185-191 |
| 14 | `getUptime0()` | `Java_..._getUptime0` | `GetLongAttribute(env, NULL, ...)` | `JMM_JVM_UPTIME_MS` | :193-198 |
| 15 | `isThreadContentionMonitoringEnabled()` | `Java_..._isThreadContentionMonitoringEnabled` | `GetBoolAttribute(env, ...)` | `JMM_THREAD_CONTENTION_MONITORING` | :200-206 |
| 16 | `isThreadCpuTimeEnabled()` | `Java_..._isThreadCpuTimeEnabled` | `GetBoolAttribute(env, ...)` | `JMM_THREAD_CPU_TIME` | :208-213 |
| 17 | `isThreadAllocatedMemoryEnabled()` | `Java_..._isThreadAllocatedMemoryEnabled` | `GetBoolAttribute(env, ...)` | `JMM_THREAD_ALLOCATED_MEMORY` | :215-220 |
| 18 | `getProcessId()` | `Java_..._getProcessId` | `GetLongAttribute(env, NULL, ...)` | `JMM_OS_PROCESS_ID` | :222-229 |
| 19 | `getAvailableProcessors()` | `Java_..._getAvailableProcessors` | `JVM_ActiveProcessorCount()` — 直接 JVM 调用 | 非 jmm_interface — 标准 JVM 入口 | :231-236 |
| 20 | `getSafepointCount()` | `Java_..._getSafepointCount` | `GetLongAttribute(env, NULL, ...)` | `JMM_SAFEPOINT_COUNT` | :238-244 |
| 21 | `getTotalSafepointTime()` | `Java_..._getTotalSafepointTime` | `GetLongAttribute(env, NULL, ...)` | `JMM_TOTAL_STOPPED_TIME_MS` | :246-252 |
| 22 | `getSafepointSyncTime()` | `Java_..._getSafepointSyncTime` | `GetLongAttribute(env, NULL, ...)` | `JMM_TOTAL_SAFEPOINTSYNC_TIME_MS` | :254-260 |
| 23 | `getTotalApplicationNonStoppedTime()` | `Java_..._getTotalApplicationNonStoppedTime` | `GetLongAttribute(env, NULL, ...)` | `JMM_TOTAL_APP_TIME_MS` | :262-268 |
| 24 | `getLoadedClassSize()` | `Java_..._getLoadedClassSize` | `GetLongAttribute(env, NULL, ...)` | `JMM_CLASS_LOADED_BYTES` | :270-276 |
| 25 | `getUnloadedClassSize()` | `Java_..._getUnloadedClassSize` | `GetLongAttribute(env, NULL, ...)` | `JMM_CLASS_UNLOADED_BYTES` | :278-284 |
| 26 | `getClassLoadingTime()` | `Java_..._getClassLoadingTime` | `GetLongAttribute(env, NULL, ...)` | `JMM_TOTAL_CLASSLOAD_TIME_MS` | :285-291 |
| 27 | `getMethodDataSize()` | `Java_..._getMethodDataSize` | `GetLongAttribute(env, NULL, ...)` | `JMM_METHOD_DATA_SIZE_BYTES` | :294-300 |
| 28 | `getInitializedClassCount()` | `Java_..._getInitializedClassCount` | `GetLongAttribute(env, NULL, ...)` | `JMM_CLASS_INIT_TOTAL_COUNT` | :302-308 |
| 29 | `getClassInitializationTime()` | `Java_..._getClassInitializationTime` | `GetLongAttribute(env, NULL, ...)` | `JMM_CLASS_INIT_TOTAL_TIME_MS` | :310-316 |
| 30 | `getClassVerificationTime()` | `Java_..._getClassVerificationTime` | `GetLongAttribute(env, NULL, ...)` | `JMM_CLASS_VERIFY_TOTAL_TIME_MS` | :318-324 |

**模式观察**: 30 个方法高度统一 — 28 个走 jmm_interface 桥接，2 个直接调用 JVM 入口。这种一致性是设计意图 — jmm_interface vtable 让所有 JNI 函数可以用同一模式编写（`return jmm_interface->Xxx(env, ...)`），不依赖具体 JVM 实现细节。GetLongAttribute 接受 NULL 作为第一个参数（表示查询全局属性而非 per-object 属性）— 这是 JMM 接口的设计约定。

> **Counterfactual**: 如果每个 MXBean 独立注册 JNI 方法（不使用 jmm_interface）→ 30 个 JNI 方法需要 30 个独立的 JNI 注册点 → .so 的 JNI_OnLoad 需要注册 30 个函数 → JVM 内部函数必须暴露为 JNI 入口（public API 约束）→ 无法内部重构（修改 management.cpp 会影响 .so 的 JNI 绑定）→ jmm_interface vtable 的版本化接口避免了这个问题 — 新增函数只需在 vtable 末尾添加，老 .so 不访问新 slot。

---

## §六 边缘场景

### 6.1 RMI Connector 端口已被占用

**现象**: JVM 启动时报 `java.io.IOException: Port already in use: 9999`，JMX Agent 启动失败但 JVM 继续运行。

**根因**: `-Dcom.sun.management.jmxremote.port=9999` 指定的端口已被其他进程占用。`ConnectorBootstrap.startRemoteConnectorServer()` 尝试创建 `JMXConnectorServer` 并 `bind()` (man 2 bind) → 系统返回 `EADDRINUSE` → Java 层抛出 IOException → `Agent.startAgent()` 捕获异常 → JVM 继续运行，但远程 JMX 不可用。

**为什么 JVM 不终止？** 端口占用是运行时错误（非配置错误），发生在 Java 层（`Agent.startAgent()` 内部的 try-catch）。对比 §〇 场景：类加载失败发生在 C++ 层（`Management::initialize()` 中 `SystemDictionary::resolve_or_null` 返回 NULL → `vm_exit_during_initialization`）— C++ 层无异常处理 → JVM 终止。端口占用是 Java 异常，可捕获 → JVM 继续。

**诊断**:
```bash
# 检查端口占用
ss -tlnp | grep 9999
lsof -i :9999

# 确认 JMX Agent 状态
jcmd <pid> ManagementAgent.status
# 预期: JMX Remote is disabled (port conflict)

# 检查 JVM 是否正常运行
jcmd <pid> VM.uptime
```

**修复**: 更换端口或运行时动态启动:
```bash
# 方案 1: 重启 JVM 用新端口
java -Dcom.sun.management.jmxremote.port=9998 -jar app.jar

# 方案 2: 运行时启动（无需重启）
jcmd <pid> ManagementAgent.start jmxremote.port=9998
```

### 6.2 JMX Agent 类加载失败时 JVM 行为

**场景**: `-Dcom.sun.management.jmxremote` 设置了但 `jdk.internal.agent.Agent` 类不可用（模块路径问题）。

**行为**: `Management::initialize()` (management.cpp:182-184) 中:
```cpp
Klass* k = SystemDictionary::resolve_or_null(
    vmSymbols::jdk_internal_agent_Agent(), loader, Handle(), THREAD);
if (k == NULL) {
    vm_exit_during_initialization(
        "Management agent initialization failure: "
        "class jdk.internal.agent.Agent not found.");
}
```
→ **JVM 终止启动** — `vm_exit_during_initialization()` 是致命错误，不可恢复。

**原因**: `ManagementServer == true` 说明用户明确要求 JMX → Agent 类加载失败是配置错误（模块缺失）→ JVM 不静默降级 → 终止启动让用户修正配置。

**对比**: 端口占用（6.1）发生在 `Agent.startAgent()` 内部的 Java 层 → IOException 被 Java 异常处理捕获 → JVM 继续运行。类加载失败发生在 C++ 层 → 无法通过 Java 异常机制恢复 → 终止。

**诊断**:
```bash
# 检查模块是否可用
java --list-modules | grep jdk.management.agent
# 预期: jdk.management.agent@11

# 确认类路径
java -Dcom.sun.management.jmxremote.port=9999 -Xlog:class+load=info -jar app.jar 2>&1 | grep Agent
```

### 6.3 jmxremote.password 文件权限检查失败

**现象**: 远程 JMX 连接被拒绝，日志显示 `Error: Password file read access must be restricted: /path/to/jmxremote.password`。

**根因**: `FileSystemImpl.isAccessUserOnly0()` (FileSystemImpl.c:56-73) 检查 password 文件权限:
```c
struct stat64 sb;
if (stat64(path, &sb) == 0) {  // man 2 stat
    res = ((sb.st_mode & (S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH)) == 0)
          ? JNI_TRUE : JNI_FALSE;
}
```
要求文件权限为 `0600` 或 `0400` — owner 可读写或只读，group 和 other 不能有任何权限。`chmod 644 jmxremote.password` → group 有读权限 → 检查失败 → Agent 拒绝启动远程 JMX。

**这是安全特性**: 防止其他用户读取 password 文件中的明文密码。`FileSystemImpl.c` 是 libmanagement_agent.so 中唯一的源文件 — 整个 .so 就做这一件事。

**诊断**:
```bash
# 检查文件权限
ls -la $JAVA_HOME/conf/management/jmxremote.password
# 预期: -rw------- 1 root root ... jmxremote.password (0600)

# strace 验证 stat64 调用
strace -e stat64 -f java -Dcom.sun.management.jmxremote.port=9999 \
  -Dcom.sun.management.jmxremote.password.file=/path/jmxremote.password \
  -jar app.jar 2>&1 | grep jmxremote.password
# 预期: stat64("/path/jmxremote.password", {st_mode=S_IFREG|0600, ...}) = 0
```

**修复**: `chmod 600 jmxremote.password` 或 `chmod 400 jmxremote.password` → 确保只有 owner 有权限。

### 6.4 本地 JMX 与远程 JMX 同时启用

**场景**: 同时配置 `-Dcom.sun.management.jmxremote.port=9999`（远程）但未禁用本地 JMX。

**行为**: `Agent.startAgent()` (Agent.java:590-638) 同时启动两个 connector:
1. `startRemoteManagementAgent()` (Agent.java:338-399):
   → 绑定 `jmxremote.port` (9999) → RMI registry + JMXConnectorServer + SSL
   → 远程 jconsole 通过 `service:jmx:rmi:///jndi/rmi://host:9999/jmxrmi` 连接
2. `startLocalManagementAgent()` (Agent.java:313-332):
   → 绑定本地 UNIX socket → 仅本机同用户可连接
   → 本地 jconsole 自动发现（扫描 `/tmp/hsperfdata_<user>/<pid>`）
   → 使用 local connector — 无密码/SSL 要求

**本地 JMX 的特殊性**: 本地 jconsole 自动发现 JVM 进程通过 Attach API 扫描 `/tmp/hsperfdata_<user>/` 目录 → 找到 PID → 通过 Attach API 注入 JMX agent（如果 agent 未启动）→ 然后通过 local JMX connector 连接。这意味着即使没有配置远程 JMX 端口，本地 jconsole 也能监控 JVM — 前提是 Attach API 可用（同机同用户）。

**安全注意**: 本地 JMX 仅限同机同用户 → `FileSystemImpl.isAccessUserOnly0()` 确保 agent 配置文件不被其他用户篡改 → local connector 不需要认证。

---

## §七 诊断工具实战

### 7.1 strace — 追踪系统调用

```bash
# 1. 追踪 jconsole 的网络系统调用
strace -e trace=network jconsole 2>&1 | head -50
# 预期: socket(PF_INET, SOCK_STREAM, IPPROTO_TCP) = ...
#       connect(...) → send(...) → recv(...)

# 2. 追踪 JMX Agent 启动时的 stat64 调用
strace -e stat64 -f java -Dcom.sun.management.jmxremote.port=9999 \
  -Dcom.sun.management.jmxremote.password.file=/path/password \
  -jar app.jar 2>&1 | grep jmxremote
# 预期: stat64("/path/jmxremote.password", {st_mode=S_IFREG|0600, ...}) = 0
#       stat64("/path/jmxremote.access", {st_mode=S_IFREG|0644, ...}) = 0

# 3. 追踪 jcmd 的 Attach API 信号和 socket
strace -e kill,write,read,socket,connect jcmd <pid> VM.uptime
# 预期:
#   kill(<pid>, SIGQUIT) = 0           ← 发送信号唤醒 AttachListener
#   socket(AF_UNIX, SOCK_STREAM, 0)    ← 创建 UNIX socket
#   connect(...)                         ← 连接到 JVM 的 AttachListener socket
#   write(... "VM.uptime\n")            ← 发送命令
#   read(... "12345 ms\n")              ← 读取结果

# 4. 追踪 JVM 端 AttachListener 的文件系统操作
strace -e openat,stat,mkdir -p <pid>
# 预期: mkdir("/proc/<pid>/cwd/.attach_pid<pid>", 0700)
#       openat(..., ".attach_pid<pid>/attach", O_RDONLY)

# 5. 追踪 PerfData 的 mmap 操作 (jstat 读取路径)
strace -e openat,mmap,close jstat -gc <pid>
# 预期: openat(..., "/tmp/hsperfdata_<user>/<pid>", O_RDONLY)
#       mmap(NULL, 32768, PROT_READ, MAP_SHARED, fd, 0)
```

### 7.2 GDB — 断点验证关键路径

```bash
# 断言 1: JNI_OnLoad 获取 jmm_interface (management.c:47)
(gdb) break management.c:47
(gdb) run -Dcom.sun.management.jmxremote.port=9999 Test
(gdb) print JMM_VERSION
# 期望: 0x20020000
(gdb) continue
(gdb) print jmm_interface
# 期望: 非 NULL 指针 (如 0x7ffff7a1b000)
(gdb) print jmm_interface->GetVersion
# 期望: 非 NULL 函数指针
(gdb) print jmm_interface->GetMemoryUsage
# 期望: 非 NULL 函数指针

# 断言 2: management_init 调用 (init.cpp:119)
(gdb) break init.cpp:119
(gdb) run Test
(gdb) step
# 进入 management_init() → management.cpp:84
(gdb) next
# 进入 Management::init() → management.cpp:97

# 断言 3: Management::initialize 条件检查 (management.cpp:175)
(gdb) break management.cpp:175
(gdb) run -Dcom.sun.management.jmxremote.port=9999 Test
(gdb) print ManagementServer
# 期望: true (因为设置了 -Dcom.sun.management)
(gdb) step
# 进入 if 块 → SystemDictionary::resolve_or_null

# 断言 4: jmm_interface vtable 验证 (management.cpp:2232)
(gdb) print &jmm_interface
(gdb) print jmm_interface.GetVersion
(gdb) print jmm_interface.GetMemoryUsage
(gdb) print jmm_interface.GetThreadInfo
(gdb) print jmm_interface.SetVMGlobal
# 期望: 所有函数指针非 NULL (除 reserved slots: [0]=NULL, [31]=NULL)

# 断言 5: HeapMemoryUsage 查询路径 (management.cpp:738)
(gdb) break management.cpp:738
(gdb) continue
# 在另一个终端: jconsole 连接 → Memory 标签 → 等待轮询
(gdb) print heap
# 期望: 1 (JNI_TRUE — 查询 heap usage)
(gdb) next
# 进入 for 循环 → MemoryService::num_memory_pools()
(gdb) print MemoryService::num_memory_pools()
# 期望: 7-9 (G1 默认: 3 heap + 4 non-heap)

# 断言 6: VMManagementImpl 初始化 (VMManagementImpl.c:62)
(gdb) break VMManagementImpl.c:62
(gdb) continue
# 进入 initOptionalSupportFields
(gdb) print mos.isCompilationTimeMonitoringSupported
# 期望: 1 (true)
(gdb) print mos.isThreadContentionMonitoringSupported
# 期望: 1 (true)
```

### 7.3 用 Java 代码验证 JMX 数据流

以下代码可以直接在 jshell 或任何 Java 程序中运行，验证 JMX 数据流:

```java
import java.lang.management.*;
import javax.management.*;
import com.sun.management.*;

// 1. 获取 Platform MBeanServer (单例)
MBeanServer server = ManagementFactory.getPlatformMBeanServer();

// 2. 列出所有 Platform MXBean
System.out.println("=== All Platform MXBeans ===");
for (ObjectName name : server.queryNames(null, null)) {
    System.out.println("  " + name);
}

// 3. 查询堆内存 — 完整 CompositeData
ObjectName memory = new ObjectName("java.lang:type=Memory");
CompositeData heapUsage = (CompositeData) server.getAttribute(memory, "HeapMemoryUsage");
System.out.println("\n=== HeapMemoryUsage ===");
System.out.println("  init:      " + heapUsage.get("init") + " bytes");
System.out.println("  used:      " + heapUsage.get("used") + " bytes");
System.out.println("  committed: " + heapUsage.get("committed") + " bytes");
System.out.println("  max:       " + heapUsage.get("max") + " bytes");
// 每行对应 jmm_GetMemoryUsage() 累加的 4 个字段 (management.cpp:753-754, 781-784)

// 4. 查询 GC 统计
ObjectName gc = new ObjectName("java.lang:type=GarbageCollector,name=G1 Young Generation");
Long gcCount = (Long) server.getAttribute(gc, "CollectionCount");
Long gcTime = (Long) server.getAttribute(gc, "CollectionTime");
System.out.println("\n=== G1 Young GC ===");
System.out.println("  count: " + gcCount);
System.out.println("  time:  " + gcTime + " ms");
// 底层: jmm_interface->GetLongAttribute(JMM_GC_COLLECTION_COUNT/EXTENT)

// 5. 查询线程信息
ObjectName threading = new ObjectName("java.lang:type=Threading");
Integer threadCount = (Integer) server.getAttribute(threading, "ThreadCount");
System.out.println("\n=== Threading ===");
System.out.println("  threadCount: " + threadCount);
// 底层: jmm_interface->GetLongAttribute(JMM_THREAD_LIVE_COUNT)

// 6. 触发 Full GC (谨慎使用!)
// server.invoke(memory, "gc", null, null);

// 7. 订阅 GC 通知 (异步 push)
server.addNotificationListener(gc, (notification, handback) -> {
    String type = notification.getType();
    if (type.equals("com.sun.management.gc.notification")) {
        CompositeData cd = (CompositeData) notification.getUserData();
        System.out.println("  GC completed: " + cd.get("gcAction") +
                           " duration=" + cd.get("gcInfo"));
    }
}, null, null);
// 底层: gcNotifier.cpp → pushNotification → ServiceThread → sendNotification → Java 回调

// 8. 使用 HotSpotDiagnostic MXBean 读写 VM flag
ObjectName diag = new ObjectName("com.sun.management:type=HotSpotDiagnostic");
String printGC = (String) server.invoke(diag, "getVMOption",
    new Object[]{"PrintGC"}, new String[]{"java.lang.String"});
System.out.println("\n=== VM Flag ===");
System.out.println("  PrintGC = " + printGC);
// 底层: jmm_interface->GetVMGlobals() → management.cpp:1536
```

### 7.4 /proc 文件系统引用

| /proc 文件 | 关联 JMM 功能 | 使用位置 | 读取方式 |
|-----------|-------------|---------|---------|
| `/proc/self/stat` | 虚拟内存大小 (字段 23) | OperatingSystemImpl.c:127 — `getCommittedVirtualMemorySize0()` | `fopen("/proc/self/stat")` → `fscanf(..., "%*d ... %lu", &vsize)` |
| `/proc/self/fd` | 打开文件描述符计数 | OperatingSystemImpl.c:220-250 — `getOpenFileDescriptorCount0()` | `opendir("/proc/self/fd")` → `readdir()` 遍历计数 |
| `/proc/stat` | CPU ticks 统计 | UnixOperatingSystem.c — `getSystemCpuLoad0()` / `getProcessCpuLoad0()` | `fopen("/proc/stat")` → `fscanf(..., "cpu %lu %lu ...")` |
| `/proc/sys/kernel/pid_max` | 最大 PID | OperatingSystemImpl.c — `getMaxFileDescriptorCount0()` 间接相关 | `fopen` → `fscanf` |
| `/proc/meminfo` | 物理内存/Swap 信息 | OperatingSystemImpl.c — `getFreePhysicalMemorySize0()` / `getTotalSwapSpaceSize0()` | `fopen("/proc/meminfo")` → 逐行解析 `MemTotal:` `SwapTotal:` `SwapFree:` |
| `/tmp/hsperfdata_<user>/<pid>` | PerfData 共享内存文件 | jstat 读取 — `management.cpp:107-117` 创建 | mmap (man 2 mmap) — 零 JNI 开销 |

### 7.5 jcmd 诊断命令速查

```bash
# JMX Agent 管理
jcmd <pid> ManagementAgent.status       # 查看 JMX Agent 状态
jcmd <pid> ManagementAgent.start jmxremote.port=9999  # 运行时启动远程 JMX
jcmd <pid> ManagementAgent.stop         # 停止远程 JMX

# VM 信息
jcmd <pid> VM.uptime                    # JVM 运行时间
jcmd <pid> VM.flags                     # 所有 VM flag (含 ManagementServer)
jcmd <pid> VM.system_properties         # 系统属性 (含 jmxremote 配置)
jcmd <pid> VM.version                   # JVM 版本信息
jcmd <pid> VM.command_line              # 启动命令行

# 线程
jcmd <pid> Thread.print                 # 线程 dump (等同 jstack)
jcmd <pid> VM.safepoint_statistics      # Safepoint 统计

# 内存
jcmd <pid> GC.heap_dump /tmp/heap.hprof # Heap dump (等同 jmap -dump)
jcmd <pid> GC.run                       # 触发 Full GC

# PerfData
jcmd <pid> PerfCounter.print            # 打印所有 PerfData 计数器
# 查找 sun.rt 命名空间的计数器:
jcmd <pid> PerfCounter.print | grep "sun.rt"
```

### 7.6 JMX Agent 三种启动方式配置详解

JMX Agent 可以通过三种方式启动，每种方式对应不同的安全级别和使用场景:

**方式 1: 本地监控（默认，零配置）**

```
无需任何 JVM 参数
→ jconsole 自动发现本地 JVM 进程
→ 通过 Attach API 扫描 /tmp/hsperfdata_<user>/<pid>
→ 注入 JMX agent (如果 agent 未启动)
→ 通过 local JMX connector (UNIX socket) 连接
```

底层流程: `Attach API` → `Agent.startLocalManagementAgent()` (Agent.java:313-332) → 创建 `LocalJMXConnectorServer` → 绑定本地 UNIX socket。仅同机同用户可连接 — 通过 OS 用户匹配保证安全。不需要任何认证配置。

**方式 2: 远程 JMX — 开发/测试（简单配置）**

```bash
java \
  -Dcom.sun.management.jmxremote.port=9999 \
  -Dcom.sun.management.jmxremote.authenticate=false \
  -Dcom.sun.management.jmxremote.ssl=false \
  -jar app.jar
```

参数说明:
- `jmxremote.port=9999`: RMI registry + JMX connector 端口
- `jmxremote.authenticate=false`: 禁用认证（仅开发环境！）
- `jmxremote.ssl=false`: 禁用 SSL（仅开发环境！）

底层流程: `arguments.cpp:2831` 解析 `-Dcom.sun.management` → `FLAG_SET_CMDLINE(bool, ManagementServer, true)` → `Management::initialize()` (management.cpp:174) → `Agent.startAgent()` → `ConnectorBootstrap.startRemoteConnectorServer(9999)` → 创建 RMI registry + JMXConnectorServer + 绑定 9999 端口。

**方式 3: 远程 JMX — 生产（完整安全配置）**

```bash
java \
  -Dcom.sun.management.jmxremote.port=9999 \
  -Dcom.sun.management.jmxremote.ssl=true \
  -Dcom.sun.management.jmxremote.authenticate=true \
  -Dcom.sun.management.jmxremote.password.file=/path/jmxremote.password \
  -Dcom.sun.management.jmxremote.access.file=/path/jmxremote.access \
  -Djavax.net.ssl.keyStore=/path/keystore \
  -Djavax.net.ssl.keyStorePassword=changeit \
  -jar app.jar
```

jmxremote.password 文件格式:
```
# 用户名 密码
monitorRole  monitoring123
controlRole  control456
```

jmxremote.access 文件格式:
```
# 用户名 权限
monitorRole  readonly
controlRole  readwrite
```

权限检查流程:
1. `FileSystemImpl.isAccessUserOnly0()` (FileSystemImpl.c:56-73):
   → `stat64(password_file, &sb)` — man 2 stat
   → 检查 `(sb.st_mode & (S_IRGRP|S_IWGRP|S_IROTH|S_IWOTH)) == 0`
   → 要求文件只能被 owner 访问 (chmod 600 或 400)
2. 如果检查失败 → Agent 拒绝启动远程 JMX → 日志报错 "Password file read access must be restricted"

**运行时动态启动（零重启）**:

```bash
# 即使 JVM 启动时没有 -Dcom.sun.management.jmxremote
# 也可以通过 jcmd 在运行时启动 JMX Agent
jcmd <pid> ManagementAgent.start jmxremote.port=9999

# 可以动态设置认证
jcmd <pid> ManagementAgent.start \
  jmxremote.port=9999 \
  jmxremote.authenticate=true \
  jmxremote.password.file=/path/jmxremote.password

# 停止远程 JMX
jcmd <pid> ManagementAgent.stop

# 查看状态
jcmd <pid> ManagementAgent.status
```

运行时启动绕过 `Management::initialize()` 中的 `ManagementServer` 检查 — 直接调用 `Agent.startRemoteManagementAgent()` (Agent.java:338-399)。这意味着即使 `ManagementServer` 为 false（启动时未设置 jmxremote），运行时也可以启动 JMX Agent。

---

## §八 设计决策 Counterfactual

### 8.1 为什么用 RMI 而不是 HTTP/gRPC？

**事实**: JMX Connector 使用 RMI over TCP 作为远程通信协议。

**反事实**: 如果选择 HTTP REST API → 工具端只需 `curl http://host:9999/jmx/java.lang:type=Memory/HeapMemoryUsage` → 不需要 JMX 客户端库 → 调试更简单，任何语言都能访问。但 HTTP 是无状态的 → 需要轮询（不能 push 通知）→ 每个请求都需要认证（不是连接级）→ 不支持 MBean 订阅（`addNotificationListener` 需要持久连接 push 模型）。

**为什么 RMI**: RMI 提供对象级别的远程调用透明性 — `MBeanServerConnection.getAttribute()` 在客户端看起来像本地方法调用，但底层 RMI 自动序列化参数和返回值（Java 序列化）。JMX Notification（push 模型）需要持久连接 — RMI 通过长连接支持而 HTTP 需要 WebSocket 额外工作。历史原因：2003 年 JMX 设计时（JSR-174），RMI 是 Java 标准远程调用方案，gRPC/HTTP2 尚未出现（gRPC 2015 年，HTTP/2 2015 年）。如果今天重新设计，可能会选择 gRPC（双向流、protobuf 序列化、多语言支持）。

**量化对比**: RMI 调用开销约 0.5-2ms（序列化 + 网络），HTTP REST 类似。RMI 的优势在 Java 生态内（类型安全、自动序列化），劣势在跨语言互操作（需要 Java RMI 客户端）。

### 8.2 为什么分 JMX Connector + Attach API 两条通路？

**事实**: JVM 暴露两套接口给外部工具：JMX Connector (RMI) 和 Attach API (UNIX socket)。

**反事实**: 如果只用 Attach API → 只能本机访问（UNIX socket 不可远程）→ 所有远程监控工具（Prometheus JMX Exporter, jconsole 远程模式, Zabbix JMX 监控）无法工作 → 必须每台机器部署监控 agent。如果只用 JMX Connector → `jcmd <pid> VM.flags` 需要配置 RMI 端口 + 认证 → 生产环境零配置诊断不可用 → 紧急情况下（JVM OOM、死锁）无法快速诊断。

**为什么两条**: 两条通路服务不同场景 — JMX Connector 是"规划好的监控基础设施"（提前配端口、SSL、密码文件），Attach API 是"紧急诊断通道"（零配置、仅本机、信号触发、一次性命令）。它们共享同一套 C++ 实现（WriteableFlags, management.cpp, DCmd）但入口不同 — 这是"多入口、单实现"架构。FlagOrigin 枚举区分调用来源（MANAGEMENT vs ATTACH_ON_DEMAND vs ERGONOMIC）用于审计和调试。

### 8.3 为什么 MBean 用 ObjectName 字符串而不是数字 ID？

**事实**: 每个 MBean 通过 ObjectName 字符串标识（如 `java.lang:type=Memory`），格式为 `domain:key=value`。

**反事实**: 如果用数字 ID（如 enum MBeanId { MEMORY=0, THREADING=1, GC=2 }）→ 查找 O(1)（直接数组索引或 hash map int key）→ 不需要字符串解析 → 性能更高（微秒级节省）。但数字 ID 不可读 → 工具开发者需要查映射表才能知道 ID=3 是什么 MBean → 调试时无法从日志判断哪个 MBean 出问题 → 新增 MBean 需要协调分配 ID。

**为什么字符串**: JMX 的设计目标是互操作性 — 任何 JMX 客户端（jconsole, Zabbix, Nagios, 自定义工具）都应该能列出和访问 MBean 而不需要硬编码映射表。ObjectName 使用 `domain:key=value` 格式允许: (a) 层次化组织 — domain 分组、key=value 过滤 (b) 通配符查询 — `new ObjectName("java.lang:type=MemoryPool,name=*")` 匹配所有内存池 (c) 自描述 — `java.lang:type=Memory` 一眼就知道是内存监控 (d) 可扩展 — 新增 MBean 不需要修改现有代码。

### 8.4 为什么 libmanagement.so 和 libmanagement_ext.so 分开编译？

**事实**: 标准 MXBean JNI 桥接在 libmanagement.so，扩展诊断 JNI 桥接在 libmanagement_ext.so。

**反事实**: 如果合并为一个 .so → 减少一次 `System.loadLibrary()` 调用 → 减少一个 `JNI_OnLoad` 执行 → 减少一个全局 `jmm_interface` 副本（目前每个 .so 都有自己的 `jmm_interface` 副本，但都指向同一个 C++ vtable）。但所有功能耦合在一个 .so → 不需要扩展诊断功能的应用也加载 Flag.c + OperatingSystemImpl.c（470 行含平台特定 #ifdef）→ 增加内存占用和加载时间。

**为什么分开**: 按 Java 模块划分 — `java.management` 模块需要 libmanagement.so，`jdk.management` 模块需要 libmanagement_ext.so。模块化允许: (a) 按需加载 — 不使用 `jdk.management` 模块时 libmanagement_ext.so 不加载 (b) 独立构建 — platform-specific 代码隔离（OperatingSystemImpl.c 有 Linux/macOS/Solaris/AIX 四个版本）(c) 独立版本管理 — agent 接口很少变化，management 接口随 JMM 版本变化 (d) 安全边界 — libmanagement_agent.so 甚至不需要 jmm_interface，完全独立的权限模型。

---

## §九 总结——你应该带走什么

### 9.1 三个核心认知

1. **JMX = JVM 的 OBD-II 接口** — 标准化的状态读取和控制协议。三层桥接：Java MBean（open types, CompositeData）→ Native .so（jmm_interface vtable, 1 行桥接）→ HotSpot management.cpp（2283 行, 36 个 jmm_* 函数实现）。

2. **两条数据通路** — JMX Connector (jconsole, RMI/TCP, 远程可用, 持续连接) + Attach API (jcmd/jinfo/jstack, UNIX socket, 仅本机, 一次性命令)。在 C++ 层汇合于 `WriteableFlags::set_flag()` 和 `DCmd::parse_and_execute()`。FlagOrigin 区分调用来源。

3. **3 个 .so 是 JNI 桥接层** — 薄包装，每个函数 1 行代码。libmanagement.so (标准 MXBean), libmanagement_ext.so (扩展诊断), libmanagement_agent.so (权限检查)。真正的逻辑在 management.cpp 的 36 个 jmm_* 函数中。libmanagement_agent.so 例外 — 纯 POSIX stat64 检查，不需要 jmm_interface。

### 9.2 关键 file:line 速查

| 你想理解什么 | 看哪里 |
|------------|--------|
| jmm_interface 全局指针定义 | management.c:34 |
| JNI_OnLoad 获取 jmm_interface | management.c:47 |
| jmm_interface vtable (36 函数指针) | management.cpp:2232-2272 |
| get_jmm_interface 版本检查 | management.cpp:2275-2282 |
| jmm_GetMemoryUsage 实现 | management.cpp:738-788 |
| Management::init (PerfData + 可选支持) | management.cpp:97-172 |
| Management::initialize (Agent 启动) | management.cpp:174-198 |
| ManagementServer flag 设置 | arguments.cpp:2831-2833 |
| VMManagementImpl 30 个 JNI 函数 | VMManagementImpl.c:35-324 |
| MemoryImpl JNI 桥接 | MemoryImpl.c:30-48 |
| Agent 权限检查 (stat64) | FileSystemImpl.c:56-73 |
| MXBean 单例创建 | ManagementFactoryHelper.java:67-81 |

### 9.3 如果你只想记住 3 个 ObjectName

| ObjectName | 提供 | 用途 |
|-----------|------|------|
| `java.lang:type=Memory` | HeapMemoryUsage + NonHeapMemoryUsage | 判断是否要 OOM — used vs committed vs max |
| `java.lang:type=Threading` | ThreadCount, DeadlockedThreads, ThreadCpuTime | 判断线程池是否耗尽，是否有死锁 |
| `java.lang:type=GarbageCollector,name=*` | CollectionCount + CollectionTime | 判断 GC 是否正常 — 次数和耗时趋势 |

### 9.4 下一步阅读

| 如果你想... | 读这篇 |
|------------|--------|
| 理解 jmm_interface 的 36 个函数是怎么实现的 | [01-management-jmm-interface.md](./01-management-jmm-interface.md) |
| 理解内存池阈值检测和 GC 通知机制 | [02-memory-pool-threshold.md](./02-memory-pool-threshold.md) |
| 理解线程 dump 和死锁检测的实现 | [03-thread-monitoring.md](./03-thread-monitoring.md) |
| 理解 Flag 动态修改和 OS 指标查询 | [04-os-flag-diagnostic.md](./04-os-flag-diagnostic.md) |
| 理解 3 层架构的完整源文件映射 | [README.md §三](./README.md) |
