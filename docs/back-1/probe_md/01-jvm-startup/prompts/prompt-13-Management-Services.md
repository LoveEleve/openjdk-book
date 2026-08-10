# PROMPT: 请撰写 13-Management-Services.md

## §〇 Production Scenario

### 场景 1: jcmd 命令不可用

```
$ jcmd 12345 help
12345:
Error: Diagnostic commands not available
```

用户启动 JVM 时用了 `-XX:-INCLUDE_MANAGEMENT` 构建选项（或嵌入式构建），`management_init()` 在 `init_globals()` 阶段跳过了 `Management::init()`，导致 `DCmdRegistrant::register_dcmds()` 从未被调用。`_DCmdFactoryList` 全局链表为空 — `jcmd <pid> help` 遍历链表返回空列表。

**三步诊断**：

```bash
# 1. 确认 management 是否可用
jcmd <pid> VM.version
# 若返回 "Command not available" → management 未初始化

# 2. 检查构建选项
java -XX:+PrintFlagsFinal -version 2>&1 | rg INCLUDE_MANAGEMENT
# 期望: INCLUDE_MANAGEMENT = true（若为 false 则 jcmd 不可用）

# 3. GDB 断点验证 management_init 是否执行
gdb -ex "break management.cpp:84" \
    -ex "run" \
    -ex "continue" \
    --args java -jar app.jar
# 若断点未触发 → #if INCLUDE_MANAGEMENT 为假
```

**反事实**：如果 JVM 在 management 不可用时仍然尝试暴露 JMX MBean → `ManagementFactory.getPlatformMBeanServer()` 在 Java 层返回 null → JDK 代码在调用 `getThreadMXBean()` 时触发 NPE → 症状在 JDK 层而非 JVM 层。JVM 通过 `_optional_support` 位域中的 9 个布尔位告知 Java 层每个具体能力是否可用，使 Java 层能做细粒度的 fallback（例如 jconsole 可以显示"CPU 时间监控不可用"而非 crash）。

### 场景 2: jstat 输出中缺少 sun.rt 计数器

```
$ jstat -J-Djstat.showUnsupported=true -snap 12345
sun.rt.safepointTime = 0   # ← 应该 >0
sun.rt.applicationTime = 0 # ← 应该 >0
```

JVM 以 `-XX:-UsePerfData` 启动。`RuntimeService::init()` 整个函数体在 `if (UsePerfData)` 内——条件为假时跳过所有 `create_counter()` 调用。后续 `RuntimeService::record_safepoint_begin()` 中的 `if (UsePerfData)` 门控也跳过计数器更新。但 `log_info(safepoint)` 日志仍工作——日志独立于 PerfData。

### 场景 3: jconsole 无法获取 Thread CPU 时间

```
$ jconsole → Threads 标签页 → "CPU Time" 列显示 "Unsupported"
```

`ThreadService::init()` 调用 `os::is_thread_cpu_time_supported()` — 在容器环境中（cgroup v1, no `CLOCK_THREAD_CPUTIME_ID`）返回 false。`Management::_optional_support.isCurrentThreadCpuTimeSupported` 被设为 0。jconsole 通过 JMM 接口 `jmm_GetOptionalSupport()` 读取此位域 → 发现能力不可用 → 显示 "Unsupported" 而非假数据。

**反事实**：如果 JVM 在容器中假装 CPU 时间可用 → `getThreadCpuTime()` 返回 `clock_gettime(CLOCK_THREAD_CPUTIME_ID)` 的结果 → 但 cgroup v1 的 `CLOCK_THREAD_CPUTIME_ID` 返回的是 host 级时间而非 cgroup 内时间 → 值严重偏差（host 的 10s CPU 时间可能是 cgroup 内的 2s）→ 监控告警系统误报 CPU 使用率 500%。

---

## §一 Task + Narrative + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces `management_init()` — the JVM's JMX/jcmd/jstat monitoring infrastructure initialization. This is the FIRST call in `init_globals()` at `init.cpp:119`, running immediately after `perfMemory_init()` and before `bytecodes_init()`. It creates ~20 PerfData counters, initializes a 9-bit capability negotiation bitfield, registers ~39 jcmd diagnostic commands, and sets up 4 independent monitoring services (Management, ThreadService, RuntimeService, ClassLoadingService).

Reader completed **07-PerfMemory** (PerfData storage in mmap'd shared memory) and **11-Stages5-10** (VMThread + Live Phase where JMX is queried). This doc: **how the JVM's entire monitoring facade is built — from the 4-line management_init() dispatcher to the 39 DCmd factories that power `jcmd <pid> help`**.

### Interview Story Format Answer（必须出现在 §一 末尾）

"`management_init()` at `management.cpp:84` is a 4-line dispatcher under `#if INCLUDE_MANAGEMENT` — the key build-time switch that gates the entire JMX stack. It calls `Management::init()` (76 lines) which does 3 things: creates 3 PerfData timestamps in `sun.rt.*` namespace, initializes `_optional_support` — a 9-bit capability negotiation struct defined at `jmm.h:57` that tells the JDK's `java.lang.management` package which MXBean features are available — and calls `DCmdRegistrant::register_dcmds()` to register ~39 diagnostic commands (Thread.print, GC.run, VM.flags, etc.) into a global linked list `_DCmdFactoryList` at `diagnosticFramework.cpp:381`. Then `ThreadService::init()` creates 4 `java.threads.*` PerfCounters (started/live/livePeak/daemon) unconditionally — this is the minimal management subset that runs even without INCLUDE_MANAGEMENT. `RuntimeService::init()` creates 4 `sun.rt.*` safepoint counters only if `UsePerfData=true` — explaining why `jstat -snap` shows zeros with `-XX:-UsePerfData`. `ClassLoadingService::init()` creates 4 unconditional `java.cls.*` counters (loaded/unloaded/sharedLoaded/sharedUnloaded) for the ClassLoadingMXBean, plus 5 `sun.cls.*` byte-count counters gated by `UsePerfData`. The key architectural insight: `_optional_support` is a 4-byte C struct with 9 1-bit fields and 22 bits of padding, transmitted via `memcpy` through the JMM interface to Java — this is the JVM's capability advertisement protocol that lets jconsole gracefully degrade instead of crash when features are unavailable."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **INCLUDE_MANAGEMENT vs UsePerfData**: `INCLUDE_MANAGEMENT` is a **compile-time** switch (`macros.hpp:122`), gates entire JMX stack at build time — set to 0 for embedded/minimal JVM builds. `UsePerfData` is a **runtime** flag (`-XX:+/-UsePerfData`), gates PerfData counter creation at runtime — jcmd still works with `-XX:-UsePerfData` because DCmd registration is unconditional. Two different levels of gating: build-time (code doesn't exist in binary) vs runtime (code exists but creates no counters).

2. **jmmOptionalSupport 位域**: The `jmmOptionalSupport` struct at `jmm.h:57-68` is a 4-byte C struct with 9 1-bit boolean fields and 22 bits of padding. Each bit corresponds to one MXBean capability: bit 0 = low memory detection, bit 3 = current thread CPU time, bit 8 = remote diagnostic commands. Set at `Management::init()` (`management.cpp:121-139`) and read by JDK's `ManagementFactoryHelper` via `JVM_GetManagement()` → `jmm_GetOptionalSupport()`. This is the C++ → Java capability negotiation protocol.

3. **PerfDataManager::create_* 四种工厂方法**: `create_counter()` = monotonic counter (like `java.threads.started` — only increases). `create_variable()` = read-write variable (like `java.threads.live` — goes up and down). `create_constant()` = read-only constant (like `sun.rt.jvmVersion` — set once, never changes). `create_string_constant()` = read-only string (like `sun.rt.jvmCapabilities` — 65-char bitmask string). Each allocates a `PerfDataEntry` (~32B) in PerfMemory (or C-Heap if `!UsePerfData`).

4. **DCmdFactory 单向链表**: All ~39 diagnostic commands are stored in `_DCmdFactoryList` — a global singly-linked list at `diagnosticFramework.cpp:381`. Each `register_DCmdFactory()` call does a head-insert (`factory->_next = _DCmdFactoryList; _DCmdFactoryList = factory`). `jcmd <pid> help` walks this list. No duplicate check — registering the same command twice means the newer one shadows the older one because `find()` walks from head. Protected by `DCmdFactory_lock` with `_no_safepoint_check_flag`.

5. **export flags 三层权限模型**: Each DCmd has 3 export bits: `DCmd_Source_Internal` (jcmd), `DCmd_Source_AttachAPI` (JVM attach mechanism), `DCmd_Source_MBean` (JMX). Most commands export all 3. `HeapDumpDCmd` omits `DCmd_Source_MBean` — heap dump writes to disk, needs filesystem permissions JMX doesn't guarantee. `JMXStartRemoteDCmd` omits `DCmd_Source_MBean` — "until an appropriate permission is created" per source comment. `DebugOnCmdStartDCmd` has `hidden=true` — excluded from `jcmd help` listing.

6. **Management::init() 的三阶段**: Phase 1 (L107-117): Create 3 VM lifecycle timestamps in `sun.rt.*`. Phase 2 (L120-139): Set `_optional_support` bitfield — the capability advertisement that Java's `ManagementFactory` reads. Phase 3 (L148-171): Register ~39 DCmd factories + NMT command. Phase 2 is where `os::is_thread_cpu_time_supported()` is called — the runtime OS probe that determines if ThreadMXBean CPU time features work.

7. **ThreadService 是最小管理子集**: `management_init()`'s `#else` branch (when `!INCLUDE_MANAGEMENT`) still calls `ThreadService::init()`. This means thread counting (started/live/livePeak/daemon) is the absolute minimum monitoring the JVM guarantees — even embedded builds track thread counts. `RuntimeService` and `ClassLoadingService` are entirely skipped without `INCLUDE_MANAGEMENT`.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/services/management.cpp` — management_init() (:84) + Management::init() (:97)
- `src/hotspot/share/services/management.hpp` — Management class + 11 Klass caches + friend declarations
- `src/hotspot/share/services/threadService.cpp` — ThreadService::init() (:67)
- `src/hotspot/share/services/threadService.hpp` — ThreadService class + ThreadSnapshot
- `src/hotspot/share/services/runtimeService.cpp` — RuntimeService::init() (:46)
- `src/hotspot/share/services/runtimeService.hpp` — RuntimeService class
- `src/hotspot/share/services/classLoadingService.cpp` — ClassLoadingService::init() (:80)
- `src/hotspot/share/services/classLoadingService.hpp` — ClassLoadingService class
- `src/hotspot/share/services/diagnosticCommand.cpp` — DCmdRegistrant::register_dcmds() (:69)
- `src/hotspot/share/services/diagnosticFramework.hpp` — DCmdFactory + DCmdRegistrant class
- `src/hotspot/share/services/diagnosticFramework.cpp` — DCmdFactory::register_DCmdFactory() (:513)
- `src/hotspot/share/include/jmm.h` — jmmOptionalSupport struct (:57) + JMM interface

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjvm.so` — all management code compiled into libjvm.so

**Syscall 速查**：

| Syscall | man | 用途 |
|---------|-----|------|
| `mmap` | man 2 mmap | PerfMemory 共享内存映射（PerfData 物理存储） |
| `clock_gettime` | man 2 clock_gettime | `os::is_thread_cpu_time_supported()` 探测 CLOCK_THREAD_CPUTIME_ID |
| `open` | man 2 open | `AttachListener::is_attach_supported()` 检查 /tmp/.java_pid 文件 |

**PerfData 命名空间速查**：

| 命名空间 | C++ 宏 | jstat 显示 | 对应 MXBean |
|---------|--------|-----------|------------|
| `sun.rt` | `SUN_RT` | `sun.rt.*` | RuntimeMXBean |
| `java.threads` | `JAVA_THREADS` | `java.threads.*` | ThreadMXBean |
| `java.cls` | `JAVA_CLS` | `java.cls.*` | ClassLoadingMXBean |
| `sun.cls` | `SUN_CLS` | `sun.cls.*` | Sun 扩展（仅 UsePerfData） |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **management.cpp** | `src/hotspot/share/services/management.cpp` | 2282 | `management_init()`(:84), `Management::init()`(:97), `jmm_GetOptionalSupport()`(:490), `jmm_interface`(:2232) | JMX 初始化总入口 + JMM 函数表 |
| 2 | **management.hpp** | `src/hotspot/share/services/management.hpp` | 137 | `_optional_support` 静态成员(:41), 11 Klass 缓存, friend DCmdRegistrant | Management 类声明 |
| 3 | **threadService.cpp** | `src/hotspot/share/services/threadService.cpp` | 1058 | `ThreadService::init()`(:67), `add_thread()`(:98), `remove_thread()`(:131) | 线程监控 PerfData + 线程列表 |
| 4 | **runtimeService.cpp** | `src/hotspot/share/services/runtimeService.cpp` | 162 | `RuntimeService::init()`(:46), `record_safepoint_begin()`(:89) | Safepoint + 应用时间计数器 |
| 5 | **classLoadingService.cpp** | `src/hotspot/share/services/classLoadingService.cpp` | 210 | `ClassLoadingService::init()`(:80), `notify_class_loaded()`(:142) | 类加载/卸载计数器 |
| 6 | **diagnosticCommand.cpp** | `src/hotspot/share/services/diagnosticCommand.cpp` | 1118 | `DCmdRegistrant::register_dcmds()`(:69) | 注册 ~39 个 jcmd 诊断命令 |
| 7 | **diagnosticFramework.hpp** | `src/hotspot/share/services/diagnosticFramework.hpp` | 442 | `DCmdFactory` 基类, `DCmdFactoryImpl<>` 模板(:404), `DCmdRegistrant` 类(:433) | DCmd 框架 |
| 8 | **diagnosticFramework.cpp** | `src/hotspot/share/services/diagnosticFramework.cpp` | ~600 | `DCmdFactory::register_DCmdFactory()`(:513), `_DCmdFactoryList`(:381) | DCmdFactory 注册实现 |
| 9 | **jmm.h** | `src/hotspot/share/include/jmm.h` | 348 | `jmmOptionalSupport` 结构体(:57), `JMM_VERSION_2`(:39) | C++ ↔ Java JMM 接口定义 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 ★★★ management_init() — 顶层调度器的条件分支

```
问题：
  ① management_init() (management.cpp:84-93) 如何通过 #if INCLUDE_MANAGEMENT 决定初始化范围？
      答案方向: 源码展示 10 行调度器：
        void management_init() {
        #if INCLUDE_MANAGEMENT
          Management::init();          // Phase 1: PerfData + optional_support + DCmd
          ThreadService::init();       // Phase 2: 线程计数
          RuntimeService::init();      // Phase 3: safepoint 计数 (UsePerfData gated)
          ClassLoadingService::init(); // Phase 4: 类加载计数
        #else
          ThreadService::init();       // 最小子集 — 线程计数始终可用
        #endif
        }
      INCLUDE_MANAGEMENT 在 macros.hpp:122-124 默认=1。
      #else 分支仅保留 ThreadService — 这是 JVM 对监控能力的最低保证：
      即使在嵌入式/最小构建中，线程计数（started/live/livePeak/daemon）始终可用。
      
      追问: 为什么 ThreadService 是"最小子集"？
      → 线程计数是唯一不需要额外系统调用的监控数据（Threads::number_of_threads()
        只需遍历内部 ThreadsList，而 RuntimeService 需要 clock_gettime、
        ClassLoadingService 需要 SystemDictionary 遍历）。

  ② Counterfactual: 如果 management_init 返回错误码而非无条件 void？
      答案方向: init_globals() 中对 management_init 的调用 (init.cpp:119) 无错误检查。
      如果 management 初始化失败（PerfData 创建 OOM），EXCEPTION_MARK + CHECK 宏
      通过挂起 Java 异常实现——init_globals 继续执行（返回 JNI_OK），但后续
      Threads::create_vm 在 Stage 10 的 has_pending_exception 检查中捕获。
      这意味着 management 初始化失败不会阻止 VM 启动——JMX 不可用但 JVM 仍运行。
      如果改为返回错误码 → init_globals 返回 JNI_ERR → create_vm 返回 false →
      JNI_CreateJavaVM 返回 JNI_ERR → 整个 JVM 无法启动 → 对 JMX 监控的依赖
      变成了对 JVM 启动的硬阻塞。
```

### 4.2 ★★★ Management::init() — 三阶段初始化

```
问题：
  ① Management::init() (management.cpp:97-172) 的三个阶段各做了什么？
      答案方向:
        Phase 1 (L107-117): 创建 3 个 VM 时间戳 PerfVariable
          _begin_vm_creation_time = create_variable(SUN_RT, "createVmBeginTime", U_None)
          _end_vm_creation_time   = create_variable(SUN_RT, "createVmEndTime",   U_None)
          _vm_init_done_time       = create_variable(SUN_RT, "vmInitDoneTime",   U_None)
          这些时间戳在 Threads::create_vm 中分别于 init_globals 前后赋值。
        
        Phase 2 (L120-139): 设置 _optional_support 位域
          9 个布尔位，每个对应一个 MXBean 能力：
          - bit 0: isLowMemoryDetectionSupported = 1（无条件）
          - bit 1: isCompilationTimeMonitoringSupported = 1（无条件）
          - bit 2: isThreadContentionMonitoringSupported = 1（无条件）
          - bit 3-4: isCurrent/OtherThreadCpuTimeSupported = os::is_thread_cpu_time_supported()
          - bit 5: isObjectMonitorUsageSupported = 1（无条件）
          - bit 6: isSynchronizerUsageSupported = 1（仅 #if INCLUDE_SERVICES）
          - bit 7: isThreadAllocatedMemorySupported = 1（无条件）
          - bit 8: isRemoteDiagnosticCommandsSupported = 1（无条件）
          bits 9-31: 22 bits padding + 1 bit implicit = 23 bits reserved
          sizeof(jmmOptionalSupport) = 4 bytes（1 unsigned int）
        
        Phase 3 (L148-171): 注册诊断命令
          DCmdRegistrant::register_dcmds() — ~36 个 DCmd
          DCmdRegistrant::register_dcmds_ext() — 空实现（扩展点）
          DCmdFactory::register_DCmdFactory(NMTDCmd) — VM.native_memory 命令
      
      追问: 为什么 os::is_thread_cpu_time_supported() 只在 Phase 2 调用一次？
      → 它的结果被缓存到两个位域字段中（isCurrentThreadCpuTimeSupported 和
        isOtherThreadCpuTimeSupported），后续通过 memcpy 从 _optional_support
        传递给 Java 层。无需每次 JMX 查询时重新探测 OS 能力——一次探测，
        整个 JVM 生命周期共享。

  ② Counterfactual: 如果 _optional_support 不存在，Java 层如何知道能力？
      答案方向: JDK 代码会对每个 MXBean 方法做 try-catch UnsupportedOperationException。
      但 UOE 的构造涉及 Java 异常对象分配 → 每次 getThreadCpuTime() 调用触发
      ~200ns 异常分配 + ~500ns 栈遍历 → 高频监控（每秒 1000 次查询）浪费 ~0.7ms CPU/s。
      位域方案: jmm_GetOptionalSupport() 是 JVM_LEAF（无 safepoint check），
      memcpy 4 bytes → ~1ns → 700x faster。而且位域允许 JDK 在构造 MXBean 时就
      决定暴露哪些方法（而非每次调用时检查）→ compile-time safety vs runtime checks。
```

### 4.3 ★★★ ThreadService::init() — 线程计数的 PerfData 布局

```
问题：
  ① ThreadService::init() (threadService.cpp:67-95) 创建了哪 4 个 PerfData？
      答案方向:
        _total_threads_count = create_counter(JAVA_THREADS, "started",  U_Events)  — 累计启动
        _live_threads_count  = create_variable(JAVA_THREADS, "live",      U_None)    — 当前存活
        _peak_threads_count  = create_variable(JAVA_THREADS, "livePeak",  U_None)    — 峰值
        _daemon_threads_count= create_variable(JAVA_THREADS, "daemon",    U_None)    — 守护线程
        
        started 用 counter（只增不减），live/daemon 用 variable（可增可减），
        livePeak 用 variable（只在超过历史峰值时更新）。
        
        此外还有两个 bool 静态成员：
        _thread_cpu_time_enabled = os::is_thread_cpu_time_supported()
        _thread_allocated_memory_enabled = true
        这两个是 BSS 段静态变量（非 PerfData），控制 ThreadMXBean 的高级功能。
      
      追问: 为什么 started 用 counter 而 live 用 variable？
      → counter 是 V_Monotonic（单调递增），底层实现是 jlong 的原子增量——
        jstat 读取时无需锁，直接读内存。variable 是 V_Variable（可变），
        需要 paired PerfLongVariant::sample() 在每次采样时记录当前值——
        因为 live 在 add_thread/remove_thread 中频繁增减。

  ② Counterfactual: 如果 ThreadService 不跟踪 livePeak 而是让 jstat 自己计算？
      答案方向: jstat 是周期性采样（默认 1s 间隔），可能在两次采样之间错过线程峰值。
      例如：线程数从 10 → 500 → 10 在 100ms 内发生 → jstat 采样间隔 1s 完全错过。
      JVM 内部跟踪 livePeak 是 O(1) 检查（每次 add_thread 时比较并 CAS 更新），
      零采样间隔 → 100% 准确。代价：每次线程创建额外 1 次 CAS（~5ns）。
```

### 4.4 ★★★ RuntimeService::init() — UsePerfData 门控

```
问题：
  ① RuntimeService::init() (runtimeService.cpp:46-86) 为什么整个函数体在 if (UsePerfData) 内？
      答案方向: 源码展示条件门控：
        void RuntimeService::init() {
          INST_LOG_SERVICE("RuntimeService::init START");
          if (UsePerfData) {
            EXCEPTION_MARK;
            _sync_time_ticks      = create_counter(SUN_RT, "safepointSyncTime", U_Ticks);
            _total_safepoints     = create_counter(SUN_RT, "safepoints",        U_Events);
            _safepoint_time_ticks = create_counter(SUN_RT, "safepointTime",     U_Ticks);
            _application_time_ticks = create_counter(SUN_RT, "applicationTime", U_Ticks);
            create_constant(SUN_RT, "jvmVersion", (jlong)Abstract_VM_Version::jvm_version());
            create_string_constant(SUN_RT, "jvmCapabilities", capabilities);
          }
        }
      
      UsePerfData=false → 跳过所有 create_* 调用 → 后续 record_safepoint_begin()
      中的 if (UsePerfData) 门控也跳过 → jstat 显示全部为零。
      但 log_info(safepoint) 仍工作（不依赖 PerfData）→ GC 日志中 safepoint 信息完整。
      
      jvmCapabilities 字符串（65 bytes）:
        capabilities[0] = '1' if AttachListener::is_attach_supported() else '0'
        capabilities[1] = '1' if INCLUDE_SERVICES else '0'
        capabilities[2..64] = '0'（未来扩展保留位）
      
      追问: 为什么 RuntimeService 使用 UsePerfData 门控而 ThreadService 不用？
      → ThreadService 的 4 个 JAVA_THREADS 计数器在 INCLUDE_MANAGEMENT=false 时
        仍需工作（是最小管理子集），所以不能依赖 UsePerfData。RuntimeService 的
        SUN_RT 计数器是"增值"监控（safepoint 分析），UsePerfData=false 时
        PerfMemory 未初始化，无法分配 PerfDataEntry → 只能跳过。

  ② Counterfactual: 如果 RuntimeService 无条件创建 PerfData？
      答案方向: UsePerfData=false 时 PerfMemory 未初始化（没有 mmap'd 共享内存），
      PerfDataManager::create_counter 会 fallback 到 C-Heap 分配（mtInternal）。
      但 C-Heap 分配的 PerfData 无法被外部进程（jstat/jcmd）读取——因为没有
      共享内存文件描述符。所以即使创建了计数器，外部工具也看不到。
      额外代价：4 个 PerfCounter + 1 PerfConstant + 1 PerfStringConstant ≈ 465B
      的 C-Heap 分配被浪费（因为没有消费者）。
```

### 4.5 ★★★ ClassLoadingService::init() — 双层命名空间

```
问题：
  ① ClassLoadingService::init() (classLoadingService.cpp:80-122) 为什么分为 JAVA_CLS 和 SUN_CLS 两层？
      答案方向:
        JAVA_CLS 层（无条件）— 4 个 counter，对应 java.lang.management.ClassLoadingMXBean：
          loadedClasses, unloadedClasses, sharedLoadedClasses, sharedUnloadedClasses
        这是 JDK 标准 API，通过 JMM 接口暴露给所有 JMX 客户端。
        
        SUN_CLS 层（if UsePerfData）— 5 个 counter，对应 Sun 扩展指标：
          loadedBytes, unloadedBytes, sharedLoadedBytes, sharedUnloadedBytes, methodBytes
        这些不是标准 API，仅在 -XX:+UsePerfData（默认）时可用，通过 jstat 读取。
      
      追问: 为什么字节计数在 SUN_CLS 而非 JAVA_CLS？
      → ClassLoadingMXBean 的规范只定义了类数量（getLoadedClassCount），不包含
        字节数。字节计数是 HotSpot 特有实现细节——放在 SUN_CLS 命名空间避免与
        规范冲突，同时允许 Sun 的 jstat 工具利用这些扩展数据。

  ② Counterfactual: 如果 SUN_CLS 计数器也放到 JAVA_CLS 命名空间？
      答案方向: JDK 的 ManagementFactoryHelper 在初始化时会遍历 JAVA_CLS 命名空间
      的所有 PerfData 并注册到 ClassLoadingMXBean。如果 loadedBytes 也在 JAVA_CLS
      下 → 它会出现在 MXBean 的 CompositeData 中 → 但 ClassLoadingMXBean 的
      MBeanInfo 中没有对应的 getter 方法 → JMX 客户端调用 getAttributes() 时
      返回的 AttributeList 包含未知属性 → 严格 JMX 实现会抛出 IntrospectionException。
      SUN_CLS 隔离确保标准 API 的 MBean 描述符与运行时数据一致。
```

### 4.6 ★★★ DCmdRegistrant::register_dcmds() — jcmd 命令注册

```
问题：
  ① register_dcmds() (diagnosticCommand.cpp:69-133) 如何注册 ~39 个诊断命令？
      答案方向: 源码展示注册模式：
        DCmdFactory::register_DCmdFactory(
          new DCmdFactoryImpl<HelpDCmd>(full_export, true, false));
        DCmdFactory::register_DCmdFactory(
          new DCmdFactoryImpl<VersionDCmd>(full_export, true, false));
        ...
        // 条件注册
        #if INCLUDE_SERVICES
          DCmdFactory::register_DCmdFactory(
            new DCmdFactoryImpl<HeapDumpDCmd>(heapdump_export, true, false));
        #endif
      
      full_export = DCmd_Source_Internal | DCmd_Source_AttachAPI | DCmd_Source_MBean
      heapdump_export = DCmd_Source_Internal | DCmd_Source_AttachAPI  // 无 MBean!
      jmx_agent_export = DCmd_Source_Internal | DCmd_Source_AttachAPI  // 无 MBean!
      
      DCmdFactoryImpl 模板（diagnosticFramework.hpp:404-427）:
        template <class DCmdClass>
        class DCmdFactoryImpl : public DCmdFactory {
          DCmd* create_resource_instance(outputStream* out) const {
            return new DCmdClass(out, false);  // ResourceArea 分配，非 C-Heap
          }
          // name(), description(), impact() 全部委托给 DCmdClass 静态方法
        };
      
      register_DCmdFactory() (diagnosticFramework.cpp:513-522):
        MutexLockerEx ml(DCmdFactory_lock, Mutex::_no_safepoint_check_flag);
        factory->_next = _DCmdFactoryList;   // 头插法
        _DCmdFactoryList = factory;
        if (_send_jmx_notification && !factory->_hidden
            && (factory->_export_flags & DCmd_Source_MBean)) {
          DCmdFactory::push_jmx_notification_request();  // 通知 JMX 有新 MBean
        }
      
      追问: 为什么 HeapDumpDCmd 不导出到 MBean？
      → heap dump 将堆内容写入磁盘文件——需要文件系统写入权限。
        JMX MBean 可能通过网络暴露（RMI connector），远程触发 heap dump
        写入服务器文件系统是安全风险。Internal + AttachAPI 限制为本地访问。

  ② Counterfactual: 如果 register_dcmds() 在 DCmdFactory_lock 之外执行？
      答案方向: jcmd 和 JMX MBean 注册是并发路径——`jcmd <pid> help` 在
      AttachListener 线程中遍历 _DCmdFactoryList，而 Management::init() 在
      main 线程中注册。无锁并发 → 可能遍历到半初始化的链表（_next 指针未设置）
      → SIGSEGV。DCmdFactory_lock 的 _no_safepoint_check_flag 保证注册期间
      不触发 safepoint——因为 safepoint 可能在 AttachListener 线程持有锁时
      请求遍历链表。
```

### 4.7 ★★★ jmmOptionalSupport — C++ → Java 能力协商协议

```
问题：
  ① _optional_support 位域如何从 C++ 传递到 Java 的 ManagementFactory？
      答案方向: 完整传递路径：
        C++ 侧 (management.cpp:81):
          jmmOptionalSupport Management::_optional_support = {0};  // BSS 段，4 bytes
        
        C++ 侧 (management.cpp:121-139):
          Management::init() 设置 9 个位域字段
        
        读取路径 (management.cpp:200-205):
          void Management::get_optional_support(jmmOptionalSupport* support) {
            memcpy(support, &_optional_support, sizeof(jmmOptionalSupport));
          }
        
        JNI 入口 (management.cpp:490-493):
          JVM_LEAF(jint, jmm_GetOptionalSupport(JNIEnv *env, jmmOptionalSupport* support))
            Management::get_optional_support(support);
            return 0;
          JVM_LEAF_END
        
        函数表注册 (management.cpp:2232):
          jmm_interface.GetOptionalSupport = jmm_GetOptionalSupport;  // 第 3 个槽位
        
        JVM 入口 (jvm.cpp:3727):
          JVM_ENTRY_NO_ENV(void*, JVM_GetManagement(jint version))
            return Management::get_jmm_interface(version);
          JVM_END
        
        Java 侧 (sun.management.ManagementFactoryHelper):
          通过 JNI 调用 JVM_GetManagement(JMM_VERSION_2) 获取函数表指针
          → 调用 →GetOptionalSupport(env, &support)
          → 位域映射到 MXBean 行为
        
      追问: 为什么用 JVM_LEAF 而非 JVM_ENTRY？
      → get_optional_support 是纯读取——无 Java 堆分配、无锁获取、无 safepoint 参与。
        JVM_LEAF 省略 safepoint check（~20ns）→ 每次 JMX 查询节省 20ns。

  ② Counterfactual: 如果 _optional_support 用 Java boolean 数组传递？
      答案方向: 需要创建 jbooleanArray → 在 Java 堆中分配 9 个 jboolean（9 bytes
      + 12 bytes array header = 21 bytes）→ 每个 JMX 客户端连接时触发 GC 压力。
      而且 JNI SetBooleanArrayRegion 涉及 safepoint check + oop 跨越 JNI boundary。
      memcpy 4 bytes → JVM_LEAF → ~1ns。jbooleanArray → ~200ns → 200x slower。
      对于 jconsole 每秒数百次能力查询的负载，这个差距不可忽视。
```

### 4.8 ★★★ 四个子服务的 PerfData 命名空间设计

```
问题：
  ① 为什么 management 使用 4 个独立的命名空间（SUN_RT / JAVA_THREADS / JAVA_CLS / SUN_CLS）？
      答案方向: 命名空间对应 JMX 规范中的 4 个 MXBean：
        - SUN_RT (sun.rt) → RuntimeMXBean
        - JAVA_THREADS (java.threads) → ThreadMXBean
        - JAVA_CLS (java.cls) → ClassLoadingMXBean
        - SUN_CLS (sun.cls) → Sun 扩展（不在规范中）
      
      PerfMemory 文件中按命名空间分层组织：
        /tmp/hsperfdata_<user>/<pid>:
          sun.rt.createVmBeginTime = 1234567890123
          sun.rt.safepointTime = 15000000
          java.threads.started = 42
          java.threads.live = 15
          java.cls.loadedClasses = 8192
          sun.cls.loadedBytes = 524288000
      
      jstat 读取时按命名空间前缀过滤——jstat -class 只读 java.cls.*，
      jstat -gc 只读 sun.gc.*。命名空间是 jstat 的数据源路由机制。
      
      追问: 为什么不把所有计数器放在一个扁平命名空间？
      → 扁平命名空间需要每个计数器名全局唯一 → 命名冲突风险。
        分层命名空间允许不同 MXBean 使用相同计数器名（如多个 "started"）
        而无需前缀混淆。而且 jstat 可以按前缀高效过滤。

  ② Counterfactual: 如果使用单一 sun.rt.* 命名空间？
      答案方向: jstat -class 需要遍历所有计数器名做字符串前缀匹配（而非命名空间
      索引过滤）→ 每次 jstat 查询从 O(4) 变为 O(20+) → 对于高频监控（每秒查询）
      增加 ~16 次额外的字符串比较。而且 PerfDataEntry 的 name 字段是变长字符串——
      每次比较需要 strcmp 而非整数命名空间 ID 比较。
```

---

## §五 Article Structure

```
§〇 生产场景
  ★ 场景 1: jcmd 命令不可用 (INCLUDE_MANAGEMENT=false)
  ★ 场景 2: jstat 输出缺少 sun.rt 计数器 (UsePerfData=false)
  ★ 场景 3: jconsole 无法获取 Thread CPU 时间 (容器 cgroup v1)
  每个场景: 真实错误消息 + 三步诊断 + 反事实讨论

§一 ★★★ management_init 全链路源码走读
  ❓ 这不是 JMX 教程 — 这是 JVM 如何用 4 个命名空间 + 位域 + 链表构建监控基础设施
  1.1 management_init() 顶层调度器 — #if INCLUDE_MANAGEMENT 分支
  1.2 Management::init() Phase 1 — 3 个 VM 时间戳 PerfVariable
  1.3 Management::init() Phase 2 — _optional_support 位域设置 (jmm.h:57)
  1.4 Management::init() Phase 3 — DCmdRegistrant::register_dcmds() ~39 命令注册
  1.5 ThreadService::init() — 4 个 JAVA_THREADS PerfData + 2 个 bool 开关
  1.6 RuntimeService::init() — UsePerfData 门控 + jvmCapabilities 65-char 字符串
  1.7 ClassLoadingService::init() — JAVA_CLS vs SUN_CLS 双层设计
  1.8 DCmdFactory::register_DCmdFactory() — 头插法链表 + export flags 三层权限
  1.9 jmmOptionalSupport C++ → Java 传递 — memcpy + JVM_LEAF + 函数表槽位 3
  1.10 ★ Mermaid: management_init 初始化序列图
      Lanes: init_globals / Management / ThreadService / RuntimeService / ClassLoadingService / DCmdFramework
  1.11 ★ 面试 Story Format 答案

§二 ★★★ 7 Beginner Callout 框
  2.1 INCLUDE_MANAGEMENT vs UsePerfData (编译时 vs 运行时开关)
  2.2 jmmOptionalSupport 位域 (9 bits + 22 padding = 4 bytes)
  2.3 PerfDataManager::create_* 四种工厂方法
  2.4 DCmdFactory 单向链表 (头插法 + DCmdFactory_lock)
  2.5 export flags 三层权限模型 (Internal/AttachAPI/MBean)
  2.6 Management::init() 三阶段 (时间戳 → 位域 → DCmd)
  2.7 ThreadService 最小管理子集

§三 ★★★ PerfData 命名空间设计 + 诊断命令权限模型
  ❓ 4 个命名空间的 MXBean 映射关系
  ❓ 39 个 DCmd 的完整 export flags 表
  3.1 命名空间 → MXBean 映射表（SUN_RT→RuntimeMXBean 等）
  3.2 39 个 DCmd 的 export flags 完整清单表（含条件编译列）
  3.3 HeapDumpDCmd 为何排除 MBean（安全分析）
  3.4 JMX Agent 命令为何排除 MBean（权限注释解读）
  3.5 DebugOnCmdStartDCmd 的 hidden=true 设计

§四 ★★ 条件分支完整展开 + 内存开销
  4.1 条件分支矩阵表（INCLUDE_MANAGEMENT × UsePerfData × INCLUDE_SERVICES × INCLUDE_JVMTI）
  4.2 每种条件组合下的 PerfData 创建清单
  4.3 总内存开销估算（默认 ~2964B，最小 ~1894B）
  4.4 BSS 段静态变量清单

§五 ★ GDB 断点验证 — 8 断点
  断言 1: management.cpp:84 — 验证 management_init 入口
  断言 2: management.cpp:108 — 验证 createVmBeginTime PerfVariable 创建
  断言 3: management.cpp:121 — 验证 _optional_support.isLowMemoryDetectionSupported = 1
  断言 4: diagnosticCommand.cpp:76 — 验证第一个 DCmd (HelpDCmd) 注册
  断言 5: diagnosticFramework.cpp:514 — 验证 DCmdFactory_lock 获取
  断言 6: threadService.cpp:75 — 验证 java.threads.started counter 创建
  断言 7: runtimeService.cpp:48 — 验证 UsePerfData 条件分支
  断言 8: classLoadingService.cpp:103 — 验证 SUN_CLS 条件门控

§六 ★ Cross-Reference
  ❓ 07-PerfMemory — PerfDataManager::create_* 的存储后端（mmap vs C-Heap）
  ❓ 11-Stages5-10 — Management::initialize() 在 Stage 7 启动 JMX Agent
  ❓ 06-Mutex — DCmdFactory_lock 的 rank 和 safepoint check 标志
  ❓ 00-JNI-CreateJavaVM — init_globals 在 create_vm Stage 4 中的位置

§七 诊断工具
  ❓ jcmd <pid> help — 验证注册的 DCmd 列表
  ❓ jstat -snap <pid> — 验证 sun.rt.* / java.threads.* / java.cls.* 计数器
  ❓ jconsole → Threads 标签页 — 验证 CPU 时间可用性
  ❓ strace -e clock_gettime — 验证 os::is_thread_cpu_time_supported 探测
  ❓ GDB: print Management::_optional_support — 验证位域值
```

---

## §六 Writing Requirements

### 必须遵循的写作原则

1. **Every paragraph opens with WHY** — "Because JMX MBean capability queries are high-frequency operations, `jmm_GetOptionalSupport()` is declared `JVM_LEAF` to skip safepoint checks..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C++ code from management.cpp / threadService.cpp / runtimeService.cpp / classLoadingService.cpp / diagnosticCommand.cpp / jmm.h, do not describe it.

3. **Mermaid sequence diagram** — management_init initialization sequence. 6 lanes: init_globals / Management / ThreadService / RuntimeService / ClassLoadingService / DCmdFramework. Complete flow: `management_init()` → `Management::init()` (3 PerfVariable → _optional_support bitfield → register_dcmds ~39 factories) → `ThreadService::init()` (4 PerfData) → `RuntimeService::init()` (UsePerfData gated) → `ClassLoadingService::init()` (JAVA_CLS + SUN_CLS). Annotate every step with file:line.

4. **GDB session** — 8 breakpoints with exact file:line numbers (see §五). Each with expected variable values to verify.

5. **7 Beginner callout boxes** — exact text from §一.

6. **"不要写成→应该写成"对照表**：

| 不要写成 | 应该写成 |
|---------|---------|
| "management_init() 初始化 JMX 管理接口" | "management_init() at management.cpp:84 是一个 4 行 #if INCLUDE_MANAGEMENT 调度器——编译时开关控制整个 JMX 栈的存在性，运行时开关 UsePerfData 控制 PerfData 计数器的创建" |
| "Management::init() 创建 PerfData 计数器" | "Management::init() Phase 1 (management.cpp:107-117) 调用 PerfDataManager::create_variable(SUN_RT, ...) 3 次——每个创建在 PerfMemory 中分配一个 PerfDataEntry (~32B header + 8B jlong value)，通过 bump-pointer 写入 mmap'd 共享内存" |
| "_optional_support 设置支持能力" | "_optional_support 是 jmm.h:57 定义的 4-byte C 结构体——9 个 1-bit 位域字段 + 22 bits padding + 1 bit implicit = 32 bits。Management::init() Phase 2 (management.cpp:121-139) 逐位设置——bit 3-4 的值来自 os::is_thread_cpu_time_supported() 的运行时 OS 探测（clock_gettime CLOCK_THREAD_CPUTIME_ID），其余为编译时常量" |
| "register_dcmds() 注册诊断命令" | "register_dcmds() at diagnosticCommand.cpp:69 通过 new DCmdFactoryImpl<XXXDCmd>(flags, true, false) + DCmdFactory::register_DCmdFactory() 注册 ~39 个 DCmd 到全局单向链表 _DCmdFactoryList (diagnosticFramework.cpp:381)——头插法，DCmdFactory_lock 保护，_no_safepoint_check_flag 防止注册期间 safepoint 死锁" |
| "ThreadService 创建线程计数器" | "ThreadService::init() at threadService.cpp:67 创建 4 个 JAVA_THREADS 命名空间 PerfData——started 用 PerfCounter（V_Monotonic，原子增量），live/daemon 用 PerfVariable（V_Variable，需要 paired PerfLongVariant::sample()），livePeak 用 PerfVariable（CAS 更新，只在超过历史峰值时写入）" |
| "RuntimeService 只在 UsePerfData 时初始化" | "RuntimeService::init() at runtimeService.cpp:46 整个函数体包裹在 if (UsePerfData) 内——UsePerfData=false 时跳过 4 个 PerfCounter + 1 PerfConstant + 1 PerfStringConstant 的创建，后续 record_safepoint_begin() 中的 if (UsePerfData) 门控也跳过更新——但 log_info(safepoint) 日志独立于 PerfData，GC 日志中 safepoint 信息始终完整" |
| "ClassLoadingService 使用两层命名空间" | "ClassLoadingService::init() at classLoadingService.cpp:80 在 JAVA_CLS 命名空间无条件创建 4 个 counter（对应标准 ClassLoadingMXBean），在 SUN_CLS 命名空间 if (UsePerfData) 创建 5 个 counter（Sun 扩展字节计数）——SUN_CLS 隔离确保标准 MBean 描述符不与扩展数据冲突" |

7. **Cross-reference at four points**:
   - At PerfDataManager::create_variable → "→ 07-PerfMemory for PerfDataEntry allocation in mmap'd shared memory"
   - At Management::initialize() → "→ 11-Stages5-10 for JMX Agent startup in Stage 7"
   - At DCmdFactory_lock → "→ 06-Mutex for rank system and safepoint check flags"
   - At init_globals() → "→ 00-JNI-CreateJavaVM for create_vm Stage 4 context"

8. **完整 DCmd export flags 表** — 必须列出全部 ~39 个 DCmd 的名称、export flags、hidden 状态、条件编译宏。格式：
   | DCmd 类名 | Internal | AttachAPI | MBean | hidden | 条件 |
   |-----------|----------|-----------|-------|--------|------|

9. **条件分支矩阵表** — 4 个条件维度（INCLUDE_MANAGEMENT × UsePerfData × INCLUDE_SERVICES × INCLUDE_JVMTI）的 16 种组合中，每种组合下的 PerfData 创建清单和 DCmd 注册清单。

10. **命名空间映射表** — 4 个命名空间 → MXBean → jstat 选项 → 计数器清单的完整映射。

---

## §七 Output Format

- Markdown file, named `13-Management-Services.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/`
- 元信息头:

```
> **Phase**: 01-jvm-startup
> **前置**: [07-PerfMemory]（PerfData 在 mmap 共享内存中的存储）、[06-Mutex]（DCmdFactory_lock 的 rank 系统）
> **配套**: [00-JNI-CreateJavaVM]（init_globals 在 create_vm 中的位置）
> **后续依赖本文**: [11-Stages5-10]（Management::initialize() 在 Stage 7 启动 JMX Agent）
> **阅读收益**: 追踪 management_init() 的完整 4 服务初始化链——理解 #if INCLUDE_MANAGEMENT 编译时开关与 UsePerfData 运行时开关的双层门控、jmmOptionalSupport 4-byte 位域的能力协商协议、DCmdRegistrant::register_dcmds() 的 ~39 命令链表注册、4 个命名空间（SUN_RT/JAVA_THREADS/JAVA_CLS/SUN_CLS）的 MXBean 映射关系、export flags 三层权限模型（Internal/AttachAPI/MBean）；掌握 "jcmd 不可用" 和 "jstat 计数器为零" 的诊断路径
```

- 目标行数: 800-1000 lines
- Section 编号: `## §一` 到 `## §七`（连续无跳号）

---

## §八 Prohibited（≥8）

- ❌ 只说 "management_init() 初始化 JMX" 而不展示 4 行调度器中的 #if INCLUDE_MANAGEMENT 分支 — 必须从 management.cpp:84 源码开始
- ❌ 不解释 _optional_support 位域结构 — 必须展示 jmm.h:57-68 的完整 struct 定义 + 每个位的赋值逻辑
- ❌ 不展示 DCmdFactory::register_DCmdFactory 的头插法实现 — 必须展示 diagnosticFramework.cpp:513-522 源码 + _DCmdFactoryList 全局链表
- ❌ 忽略 UsePerfData 门控 — 必须展示 RuntimeService::init() 和 ClassLoadingService::init() 中的 if (UsePerfData) 条件分支 + 无 UsePerfData 时的行为差异
- ❌ 不做条件分支矩阵 — 必须展开 INCLUDE_MANAGEMENT × UsePerfData × INCLUDE_SERVICES × INCLUDE_JVMTI 的所有组合
- ❌ 忽略 HeapDumpDCmd 排除 MBean 的安全原因 — 必须展示 heapdump_export = Internal | AttachAPI（无 MBean）并解释文件系统权限风险
- ❌ 不做 PerfData 命名空间 → MXBean 映射 — 必须展示 SUN_RT→RuntimeMXBean 等的完整映射关系
- ❌ 不做 GDB 断点 trace — 至少 8 个断点覆盖 management_init → Management::init 三阶段 → ThreadService → RuntimeService → ClassLoadingService
- ❌ 忽略 management_init 是 init_globals 第一个调用的事实 — 必须说明此时 PerfMemory 已就绪、锁系统已就绪、主线程已绑定
- ❌ 不要解释 JMX 是什么（这是 JVM 文档，不是 Java 教程）

---

## §九 Required（≥8）

- ✅ **★ Mermaid management_init 序列图** — 6 lanes: init_globals / Management / ThreadService / RuntimeService / ClassLoadingService / DCmdFramework — management_init() → 4 服务初始化 → ~39 DCmd 注册
- ✅ **★ management_init() 完整源码** — management.cpp:84-93，含 #if/#else/#endif 分支
- ✅ **★ Management::init() 完整源码** — management.cpp:97-172，含三阶段标注
- ✅ **★ jmmOptionalSupport struct 完整定义** — jmm.h:57-68，含逐位注释
- ✅ **★ DCmdFactory::register_DCmdFactory 源码** — diagnosticFramework.cpp:513-522，头插法 + 锁
- ✅ **★ 39 个 DCmd 完整 export flags 表** — 名称 / Internal / AttachAPI / MBean / hidden / 条件宏
- ✅ **★ 条件分支矩阵表** — INCLUDE_MANAGEMENT × UsePerfData × INCLUDE_SERVICES × INCLUDE_JVMTI
- ✅ **★ 命名空间 → MXBean 映射表** — SUN_RT / JAVA_THREADS / JAVA_CLS / SUN_CLS
- ✅ **★ 7 Beginner Callout 框** — exact text from §一
- ✅ **★ 面试 Story Format 答案** — §一末尾
- ✅ **★ GDB 断点 ≥8 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ "不要写成→应该写成"对照表** — §六 中至少 7 行对照
- ✅ **★ 总内存开销估算** — 默认 ~2964B，最小 ~1894B，含 BSS 段

---

## §十 GDB Verification（≥8 assertions）

```
断言 1: management_init 入口 (management.cpp:84)
  (gdb) break management.cpp:84
  (gdb) run
  (gdb) print INCLUDE_MANAGEMENT → 期望: 1 (默认构建)
  (gdb) continue → 进入 Management::init()

断言 2: Management::init() Phase 1 — PerfVariable 创建 (management.cpp:108)
  (gdb) break management.cpp:108
  (gdb) print PerfDataManager::_has_PerfMemory → 期望: true (PerfMemory 已初始化)
  (gdb) continue
  (gdb) print _begin_vm_creation_time → 期望: 非 NULL PerfVariable 指针

断言 3: Management::init() Phase 2 — _optional_support 位域 (management.cpp:121)
  (gdb) break management.cpp:139
  (gdb) print _optional_support.isLowMemoryDetectionSupported → 期望: 1
  (gdb) print _optional_support.isCurrentThreadCpuTimeSupported → 期望: 取决于 OS
  (gdb) print sizeof(_optional_support) → 期望: 4

断言 4: DCmd 注册 — 第一个 HelpDCmd (diagnosticCommand.cpp:76)
  (gdb) break diagnosticCommand.cpp:76
  (gdb) print full_export → 期望: 7 (Internal|AttachAPI|MBean)
  (gdb) continue → 进入 DCmdFactory::register_DCmdFactory

断言 5: DCmdFactory 链表插入 (diagnosticFramework.cpp:514)
  (gdb) break diagnosticFramework.cpp:514
  (gdb) print factory->_name() → 期望: "help"
  (gdb) print factory->_export_flags → 期望: 7
  (gdb) continue
  (gdb) print _DCmdFactoryList → 期望: 非 NULL (链表头已更新)

断言 6: ThreadService::init — started counter (threadService.cpp:75)
  (gdb) break threadService.cpp:75
  (gdb) continue → 跳过 Management::init
  (gdb) print JAVA_THREADS → 期望: "java.threads" 命名空间 ID
  (gdb) continue
  (gdb) print _total_threads_count → 期望: 非 NULL PerfCounter 指针

断言 7: RuntimeService::init — UsePerfData 门控 (runtimeService.cpp:48)
  (gdb) break runtimeService.cpp:48
  (gdb) print UsePerfData → 期望: true (默认)
  (gdb) continue
  (gdb) print _sync_time_ticks → 期望: 非 NULL PerfCounter 指针

断言 8: ClassLoadingService::init — SUN_CLS 门控 (classLoadingService.cpp:103)
  (gdb) break classLoadingService.cpp:103
  (gdb) print UsePerfData → 期望: true
  (gdb) continue
  (gdb) print _classbytes_loaded → 期望: 非 NULL PerfCounter 指针
```

---

## §十一 与 README 和同组文档的连续性

1. **从 README §init_globals 调用清单承接**：本文展开 init_globals 的第 1 次调用 `management_init()`——从 4 行调度器到 ~2964B 总内存开销的完整代码级解答。

2. **与 07-PerfMemory 的连接**：`PerfDataManager::create_*` 创建的计数器存储在 07 文档的 PerfMemory 中。本文是 07 的"第一个大规模消费者"——management_init 创建 ~20 个 PerfData 条目，占 JVM 启动阶段 PerfData 创建的 ~60%。

3. **与 06-Mutex 的连接**：`DCmdFactory::register_DCmdFactory` 获取 `DCmdFactory_lock`（_no_safepoint_check_flag），该锁在 06 文档的 ~90 锁列表中定义。DCmdFactory_lock 的 rank 决定了它可以在 safepoint 上下文中被获取。

4. **与 11-Stages5-10 的连接**：`Management::initialize()` 在 create_vm Stage 7 调用（`management.cpp:174`），加载 `jdk.internal.agent.Agent` 类并启动 JMX Agent。本文的 `Management::init()` 是 JMX Agent 启动的前置条件——Agent 需要 _optional_support 和 DCmdFactory 链表已就绪。

5. **同组边界**：本文覆盖 management_init 调用的 4 个服务（Management/ThreadService/RuntimeService/ClassLoadingService）；后续 14 覆盖 bytecodes_init/interpreter_init/templateTable_init 等解释引擎初始化；16 覆盖 universe2_init/universe_post_init/javaClasses_init 等 Universe 下半场。
