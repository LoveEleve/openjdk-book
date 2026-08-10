# 07-thread-lock — 线程体系全部 17 篇文章规划

> **标准环境**：OpenJDK 11 slowdebug build, `-Xms8g -Xmx8g -XX:+UseG1GC`, 64-bit Linux x86
> **已有文档**：[01-04] 锁膨胀全链路 | [05-06] 线程生命周期/架构 | [07-10] 线程体系
> **待补**：[11-16] 线程深度拆解 + [17] 内部锁收尾

---

## 一、全部 JVM 线程清单（标准环境）

```
═══════════════════════════════════════════════════════════════════
JavaThread（jstack 可见）: 10+1 个类型
───────────────────────────────────────────────────────────────────
  main                    ✅ [09] 浅（入口，非系统线程）
  ReferenceHandler        → [13] 深度
  Finalizer               → [13] 深度
  SignalDispatcher        ✅ [09] 浅（够用，逻辑简单）
  ServiceThread           → [12] 深度（最复杂的 JavaThread）
  C1 CompilerThread       → [14] 深度（Tiered 编译）
  C2 CompilerThread       → [14] 深度（Tiered 编译）
  CodeCacheSweeperThread  → [14] 深度
  AttachListener          → [11] 深度（jcmd/jmap/jstack 入口）
  Cleaner                 ✅ [09] 浅（够用，JDK 层实现简单）
  JFR Recorder Thread     → [15] 深度（JFR 录制线程，条件创建）

═══════════════════════════════════════════════════════════════════
NonJavaThread（pstack 可见）: 7+1 个类型
───────────────────────────────────────────────────────────────────
  VMThread                ✅ [07] P9 深度（~550 行）
  WorkerThread × N        ✅ [08] P9 深度（~500 行，共享机制一篇合理）
  WatcherThread           ✅ [10] 深度（PeriodicTask 调度全链路）
  G1ConcurrentMarkThread  ✅ [10] 深度（250 行 + Reference 边界分析，可接受）
  G1ConcurrentRefineThr × N ✅ [10] 深度（card_idx 永恒稳定性数学证明）
  G1YoungRemSetSampThr    ✅ [10] 深度（采样器 vs 驱动器数据流）
  JfrThreadSampler        → [15] 深度（JFR 采样线程，条件创建，NonJavaThread）

═══════════════════════════════════════════════════════════════════
收尾
───────────────────────────────────────────────────────────────────
  Lock Ranking 体系       → [16] 内部锁死锁预防
═══════════════════════════════════════════════════════════════════
```

---

## 二、已完成文档清单

| # | 文档 | 主题 | 行数 | 深度 |
|---|------|------|------|------|
| 01 | `01-ObjectMonitor.md` | 重量级锁 enter/exit 全路径 | ~750 | ✅ P9 |
| 02 | `02-BiasedLocking.md` | 偏向锁全机制 | ~610 | ✅ P9 |
| 03 | `03-BasicLock-Synchronizer.md` | 轻量锁 + inflate + hashCode | ~680 | ✅ P9 |
| 04 | `04-Synchronized-Full-Path.md` | synchronized 全链路 | ~460 | ✅ P9 |
| 05 | `05-JVM-Thread-Lifecycle.md` | Java 线程生命周期 | ~770 | ✅ P9 |
| 06 | `06-JVM-Thread-Architecture.md` | 线程架构全景 | ~790 | ✅ P9 |
| 07 | `07-JVM-VMThread.md` | VMThread 单线程大脑 | ~1100 | ✅ P9 |
| 08 | `08-JVM-WorkerThread.md` | WorkerThread 并行军团 | ~1040 | ✅ P9 |
| 09 | `09-JVM-JavaThread-System.md` | 10 个系统 JavaThread 概览 | ~1080 | ⚠️ 需拆解成 P0-09 详细版 |
| 10 | `10-JVM-NonJavaThread.md` | 4 条 NonJavaThread 深度 | ~1440 | ✅ P9 |

---

## 三、待补文档详细规划

---

### [11] JVM-AttachListener — jcmd/jmap/jstack 的入口线程

#### 核心叙事
用户执行 `jcmd <pid> Thread.print` → 发往哪个进程？怎么连接的？谁来处理？
答案是一条 JavaThread——"Attach Listener"。它通过 Unix Domain Socket 监听
`/tmp/.java_pid<pid>`，收到连接后解析协议，派发到 10 个内置命令。

#### 聚焦源文件

| # | 文件 | 完整路径 | 核心类/函数 | 角色 |
|---|------|---------|------------|------|
| 1 | `attachListener.hpp` | `src/hotspot/share/services/attachListener.hpp` | `AttachListener`(:62), `AttachOperation`(:136) | ★ Attach 协议核心 |
| 2 | `attachListener.cpp` | `src/hotspot/share/services/attachListener.cpp` | `attach_listener_thread_entry()`(:348), `AttachListener::init()`(:435), `funcs[]`(:328) | ★ 10 个命令的调度表 + 线程主循环 |
| 3 | `attachListener_linux.cpp` | `src/hotspot/os/linux/attachListener_linux.cpp` | `LinuxAttachListener::init()`(:182), `dequeue()`(:347) | ★ Linux 平台相关的 socket 实现 |
| 4 | `diagnosticArgument.hpp` | `src/hotspot/share/services/diagnosticArgument.hpp` | `DCmd`, `DCmdFactory` | jcmd 的命令分发 |
| 5 | `threadSMR.cpp` | `src/hotspot/share/runtime/threadSMR.cpp` | ThreadSMR 线程列表 | threaddump 如何遍历线程 |

#### 必须深度走读的核心概念

```
1. ★ Attach 协议全链路:
   jcmd 客户端 → 创建 signal file (.attach_pid<pid>)
   → 目标 JVM 的 SignalDispatcher 线程收到 SIGQUIT（或 AttachListener 轮询检测）
   → AttachListener::init() 创建 "Attach Listener" JavaThread（daemon, NearMaxPriority）
   → LinuxAttachListener::init() 创建 Unix Domain Socket 绑定到 /tmp/.java_pid<pid>
   → 客户端 connect() → 发送 "<ver>0<cmd>0<arg1>0<arg2>0<arg3>0"
   → dequeue() → accept() + SO_PEERCRED 权限检查（uid/gid 必须匹配）
   → 解析协议 → 在 funcs[] 表中查找命令名
   → 执行命令（如 jcmd → DCmd::parse_and_execute）
   → LinuxAttachOperation::complete() 将结果写回 socket

2. 为什么 AttachListener 是 JavaThread 而不是 NonJavaThread?
   → jcmd 的某些诊断命令需要读 Java 堆上的对象（如 GC.class_histogram）
   → heap_inspection() 需要遍历所有 Klass → InstanceKlass 在 Metaspace
   → 但实际上很多命令不碰堆！那为什么还选 JavaThread？
   → 因为 threaddump 需要走 ThreadsSMR → _thread_list → 而 NonJavaThread 只管理 _the_list
   → jstack 形式的外部入口天然需要 JavaThread 身份

3. 10 个内置命令:
   load, properties, agentProperties, datadump, threaddump,
   dumpheap, inspectheap, setflag, printflag, jcmd

4. ★ 安全机制:
   SO_PEERCRED → 验证连接方的 uid/gid → 只有同用户才能 attach
   DisableAttachMechanism → JVM flag 可禁用 attach
```

#### 交叉引用
- [09 §3.8] AttachListener 的创建入口
- [09 §3.3] SignalDispatcher 线程 → SIGQUIT 触发 attach
- [10 §1.2] 线程分类矩阵
- [07] VMThread → jcmd 可能触发 VM operations

---

### [12] JVM-ServiceThread — JVMTI + OopStorage + 低内存的多面手

#### 核心叙事
ServiceThread 是 JVM 中最"忙碌"的 JavaThread——它在一个 `while(true)` 循环里
同时服务 5 个完全独立的子系统。它不是"处理一件事"，而是"等待 5 个条件中任意一个触发"。
这篇文章的核心追问：**为什么把这 5 个不相关的任务塞给一条线程？多线程不行吗？**

#### 聚焦源文件

| # | 文件 | 完整路径 | 核心类/函数 | 角色 |
|---|------|---------|------------|------|
| 1 | `serviceThread.hpp` | `src/hotspot/share/runtime/serviceThread.hpp` | `ServiceThread`(:35) | ★ 类定义 + 单例 |
| 2 | `serviceThread.cpp` | `src/hotspot/share/runtime/serviceThread.cpp` | `service_thread_entry()`(:90-149) | ★★★ 主事件循环（5 条件等待 + 4 处理） |
| 3 | `jvmtiImpl.hpp` | `src/hotspot/share/prims/jvmtiImpl.hpp` | `JvmtiDeferredEvent`(:454), `JvmtiDeferredEventQueue`(:514) | ★ JVMTI 延迟事件队列 |
| 4 | `lowMemoryDetector.hpp` | `src/hotspot/share/services/lowMemoryDetector.hpp` | `LowMemoryDetector`(:214), `SensorInfo`(:116) | ★ 低内存检测 + JMX 通知 |
| 5 | `stringTable.hpp` | `src/hotspot/share/classfile/stringTable.hpp` | `StringTable::has_work()`, `do_concurrent_work()` | StringTable 并发清理 |
| 6 | `gcNotifier.hpp` | `src/hotspot/share/services/gcNotifier.hpp` | `GCNotifier` | GC 完成事件 → JMX 通知 |
| 7 | `diagnosticFramework.hpp` | `src/hotspot/share/services/diagnosticFramework.hpp` | `DCmdFactory` | 诊断命令的 JMX 通知 |

#### 必须深度走读的核心概念

```
1. ★★★ 5 条件等待循环 (serviceThread.cpp:90-149) — 全文核心:

   while (!(① LowMemoryDetector::has_pending_requests()) &&
          !(② _jvmti_service_queue.has_events()) &&
          !(③ GCNotifier::has_event()) &&
          !(④ DCmdFactory::has_pending_jmx_notification()) &&
          !(⑤ StringTable::has_work())) {
       Service_lock->wait(Mutex::_no_safepoint_check_flag);
   }
   // 唤醒后按顺序处理:
   // ⑤ StringTable::do_concurrent_work()
   // ② JvmtiDeferredEvent::post()
   // ① LowMemoryDetector::process_sensor_changes()
   // ③ GCNotifier::sendNotification()
   // ④ DCmdFactory::send_notification()

2. ★ 为什么顺序是先 StringTable 再 JVMTI?
   → StringTable 清理是纯 C++ 操作，不触发 Java 层回调 → 快速完成
   → JVMTI 事件需要调用 JNI 进入 agent 代码 → 可能慢 → 先做快的

3. JVMTI 延迟事件流水线:
   生产: CompilerThread → JvmtiDeferredEvent::compiled_method_load_event(nm)
         → ServiceThread::enqueue_deferred_event()
   消费: ServiceThread → dequeue → post() → JvmtiExport::post_compiled_method_load()
   为什么延迟? 因为编译器线程持有 Compile_lock → 不能递归进入 JVMTI agent
   → ServiceThread 解耦生产者和消费者

4. ★ 重要澄清: 什么不在 ServiceThread 中?
   - OopStorage 清理 → GC 线程负责（G1ConcurrentMark 期间的 delete_empty_blocks_concurrent）
   - JFR 检查点 → 专用 JfrRecorderThread 负责
   - Cleaner 执行 → ReferenceHandler 线程负责

5. 低内存检测:
   应用线程分配 → 跨越阈值 → LowMemoryDetector::detect_low_memory()
   → 设置 SensorInfo::_pending_trigger_count → notify Service_lock
   → ServiceThread → process_sensor_changes() → Sensor::trigger()
   → Java 层 javax.management.NotificationListener 回调
```

#### 交叉引用
- [09 §3.5] ServiceThread 的创建入口 + 死亡后果
- [06] JavaThread 生命周期
- [10] NonJavaThread → 对比"为什么 ServiceThread 不是 NonJavaThread"

---

### [13] JVM-Reference-Finalizer — 引用处理 C++/Java 双层流水线

#### 核心叙事
`new WeakReference(obj, queue)` 之后发生了什么？obj 被 GC 回收 → WeakReference 入队 → 
queue.remove() 解除阻塞。这中间经历了一条 C++ 和 Java 双层流水线：
GC 线程 → ReferenceProcessor::discover_reference() → pending list → 
ReferenceHandler(JavaThread) → ReferenceQueue → 用户代码。

Finalizer 更特殊——它不走 ReferenceQueue，而是用 `unfinalized` 双向链表 +
独立的 `FinalizerThread`。

#### 聚焦源文件

| # | 文件 | 完整路径 | 核心类/函数 | 角色 |
|---|------|---------|------------|------|
| 1 | `Reference.java` | `src/java.base/share/classes/java/lang/ref/Reference.java` | `ReferenceHandler`(:190), `processPendingReferences()`(:236), native `getAndClearReferencePendingList()`(:221) | ★ Java 层 Reference 处理 |
| 2 | `Finalizer.java` | `src/java.base/share/classes/java/lang/ref/Finalizer.java` | `FinalizerThread`(:146), `unfinalized` 双向链表(:41), `register()`(:65) | ★ Finalizer 的 Java 层实现 |
| 3 | `referenceProcessor.hpp` | `src/hotspot/share/gc/shared/referenceProcessor.hpp` | `ReferenceProcessor` | ★ C++ 层 reference discovery + processing |
| 4 | `referenceProcessor.cpp` | `src/hotspot/share/gc/shared/referenceProcessor.cpp` | `process_discovered_references()` | ★ 4 种引用类型的处理顺序 |
| 5 | `interpreterRuntime.cpp` | `src/hotspot/share/interpreter/interpreterRuntime.cpp` | `InterpreterRuntime::register_finalizer()`(:308), `SharedRuntime::register_finalizer()`(:1005) | Finalizer.register() 的 VM 入口 |
| 6 | `referencePolicy.hpp` | `src/hotspot/share/gc/shared/referencePolicy.hpp` | SoftReference 的 LRU 时钟策略 | SoftReference 的特殊存活规则 |

#### 必须深度走读的核心概念

```
1. ★★★ 引用处理全链路 (3 层流水线):

   ┌─ Layer 1: GC 线程 (C++) ─────────────────────────────────┐
   │ GC → ReferenceProcessor::discover_reference(ref)          │
   │   → 将 ref 加入 DiscoveredList                           │
   │   → later: process_discovered_references()               │
   │     → 判断 referent 是否存活                              │
   │     → 如果已死 → ref 被加入 pending list                 │
   │     → ReferenceProcessor::add_to_pending_list(ref)        │
   │       → ref.discovered = _pending_list_head              │
   │       → _pending_list_head = ref (头插法)                 │
   └──────────────────────────────────────────────────────────┘
                              ↓
   ┌─ Layer 2: ReferenceHandler (JavaThread) ─────────────────┐
   │ processPendingReferences():                               │
   │   → native: getAndClearReferencePendingList()            │
   │     → 原子性地获取 _pending_list_head 并清空              │
   │   → 遍历 pending list → 对每个 Reference:                │
   │     → 如果是 Cleaner → 直接调用 clean() (不经过队列)      │
   │     → 如果关联了 ReferenceQueue → queue.enqueue(ref)     │
   │     → 其他 → 直接丢弃                                     │
   └──────────────────────────────────────────────────────────┘
                              ↓
   ┌─ Layer 3: 用户代码 (Java) ───────────────────────────────┐
   │ ReferenceQueue.remove() / poll():                         │
   │   → 从队列头取 Reference                                    │
   │   → 用户调用 ref.get() → 返回 null (referent 已被 GC)     │
   │   → 用户执行清理逻辑                                       │
   └──────────────────────────────────────────────────────────┘

2. ★ Finalizer 的不同路径:
   - 不走 ReferenceHandler → 走独立的 FinalizerThread
   - 对象创建时: JVM 检测到类有 finalize() 方法
     → InterpreterRuntime::register_finalizer() 被调用 (或 SharedRuntime::register_finalizer())
     → new Finalizer(obj) → Finalizer 加入 unfinalized 双向链表头
   - GC 后发现 Finalizer 的 referent 已死:
     → Finalizer 从 unfinalized 链表移除
     → Finalizer 被加入 FinalizerThread 的 queue
     → FinalizerThread.remove() 阻塞等待
     → 取出 Finalizer → 调用 finalize() → 清除 referent
```

#### 交叉引用
- [09 §3.1-3.2] ReferenceHandler + Finalizer 的创建入口
- [06] JavaThread 生命周期 + daemon 标记
- [10 §3] G1ConcurrentMark → Reference 发现在并发标记中的边界
- [04] synchronized 锁 → Finalizer 中的 wait/notify

---

### [14] JVM-CompilerThread — C1/C2 编译 + Sweeper + Tiered 全周期

#### 核心叙事
方法从解释执行→编译执行，中间经历了什么？CompileBroker 如何调度 C1/C2 两种编译器？
编译线程如何从 CompileQueue 拉取任务？Sweeper 线程如何决定废弃一个 nmethod？
Tiered Compilation 4 级策略如何协同？

#### 聚焦源文件

| # | 文件 | 完整路径 | 核心类/函数 | 角色 |
|---|------|---------|------------|------|
| 1 | `compileBroker.hpp` | `src/hotspot/share/compiler/compileBroker.hpp` | `CompileBroker`(:139), `CompileQueue`(:80) | ★ 编译系统核心 |
| 2 | `compileBroker.cpp` | `src/hotspot/share/compiler/compileBroker.cpp` | `compiler_thread_loop()`(:1828), `make_thread()`(:784), `invoke_compiler_on_method()`(:2100) | ★★★ 编译线程主循环 + 任务调度 |
| 3 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | `CompilerThread`(:2130), `CodeCacheSweeperThread`(:2109) | ★ 类定义 |
| 4 | `compilerDefinitions.hpp` | `src/hotspot/share/compiler/compilerDefinitions.hpp` | `CompLevel` enum(:53) | ★ Tiered 编译级别定义 |
| 5 | `abstractCompiler.hpp` | `src/hotspot/share/compiler/abstractCompiler.hpp` | `AbstractCompiler`(:73) | C1/C2 公共基类 |
| 6 | `compilationPolicy.hpp` | `src/hotspot/share/runtime/compilationPolicy.hpp` | CompilationPolicy | 编译策略 "什么方法值得编译" |
| 7 | `nmethod.hpp` | `src/hotspot/share/code/nmethod.hpp` | nmethod | 编译产物的数据结构 |

#### 必须深度走读的核心概念

```
1. ★★★ 编译线程主循环 (compileBroker.cpp:1828-1928):

   compiler_thread_loop():
     while (true) {
       // 步骤 1: 从 CompileQueue 获取下一个任务
       task = queue->get();  // 内部 wait 在 MethodCompileQueue_lock 上
       
       // 步骤 2: 检查是否有更高优先级的编译请求
       // 步骤 3: 调用编译器
       invoke_compiler_on_method(task);
         → C1: Compiler::compile_method() → 快速编译
         → C2: Compiler::compile_method() → 深度优化
       
       // 步骤 4: 安装编译结果 (nmethod)
       // 步骤 5: 通知等待者 (如果有线程在 wait_for_completion)
     }

2. Tiered Compilation 4 级策略:
   Level 0: 解释器
   Level 1: C1, 无 profiling (纯 C1, 快速)
   Level 2: C1, 有简单 profiling (方法调用计数)
   Level 3: C1, 有完整 profiling (分支预测 + 类型 feedback)
   Level 4: C2, 基于 profiling data 深度优化

   Transition: 0→3→4 (默认路径: 解释→C1+profiling→C2)

3. CodeCache Sweeper:
   - 独立线程: CodeCacheSweeperThread (JavaThread)
   - 职责: 扫描所有 nmethod, 标记/清除不再使用的编译方法
   - 触发条件: CodeCache 使用率超过阈值
   - 清除策略: 先清除 not_entrant, 再清除 zombie, 最后清除未使用的

4. ★ 编译系统为什么用 JavaThread?
   → 核心原因同 [09 §四]: 编译器需要读 InstanceKlass/MethodData
   → 这些数据在 Java 堆 → 需要 safepoint 保护
   → 编译器栈 4MB (vs 普通线程 1MB) → 深递归编译复杂方法
```

#### 交叉引用
- [09 §四] CompilerThread 为什么是 JavaThread 而不是 NonJavaThread
- [09 §3.7] CompilerThread 创建入口
- [10 §6.3] WatcherThread(NonJavaThread) vs CompilerThread(JavaThread) 对比
- [06] JavaThread 生命周期

---

### [15] JVM-JFR-Sampling — JfrThreadSampler + JfrRecorderThread

#### 核心叙事
JFR (Java Flight Recorder) 开启后，创建了哪些额外线程？JfrThreadSampler（NonJavaThread）
如何挂起 Java 线程来采样调用栈？JfrRecorderThread（JavaThread）如何管理 Chunk 轮转和
检查点写入？这篇文章揭示 JFR 背后的双线程架构——采样线程和录制线程的分工。

#### 聚焦源文件

| # | 文件 | 完整路径 | 核心类/函数 | 角色 |
|---|------|---------|------------|------|
| 2 | `jfrThreadSampler.hpp` | `src/hotspot/share/jfr/periodic/sampling/jfrThreadSampler.hpp` | `JfrThreadSampling`(:35) | ★ 采样管理类 |
| 1 | `jfrThreadSampler.cpp` | `src/hotspot/share/jfr/periodic/sampling/jfrThreadSampler.cpp` | `JfrThreadSampler`(:311), `JfrThreadSampling`(:550) | ★★★ 采样线程实现 |
| 3 | `jfrCallTrace.hpp` | `src/hotspot/share/jfr/periodic/sampling/jfrCallTrace.hpp` | `JfrGetCallTrace`(:34) | 调用栈追踪 |
| 4 | `jfrRecorderThread.hpp` | `src/hotspot/share/jfr/recorder/service/jfrRecorderThread.hpp` | `JfrRecorderThread`(:36) | ★ 录制线程 |
| 5 | `jfrRecorderThreadLoop.cpp` | `src/hotspot/share/jfr/recorder/service/jfrRecorderThreadLoop.cpp` | `recorderthread_entry()`(:38-95) | ★ 录制线程消息循环 |
| 6 | `jfrRecorderService.hpp` | `src/hotspot/share/jfr/recorder/service/jfrRecorderService.hpp` | `JfrRecorderService`(:37) | ★ 检查点引擎 |
| 7 | `jfrCheckpointManager.hpp` | `src/hotspot/share/jfr/recorder/checkpoint/jfrCheckpointManager.hpp` | `JfrCheckpointManager`(:54) | 检查点状态管理 |
| 8 | `os.hpp` | `src/hotspot/share/runtime/os.hpp` | `os::SuspendedThreadTask`(:948) | ★ OS 线程挂起机制 |

#### 必须深度走读的核心概念

```
1. ★★★ JFR 双线程架构:

   JfrThreadSampler (NonJavaThread):
     → 每 interval_java/interval_native ms 执行一次采样
     → Java 线程采样:
       → 遍历 Threads::_thread_list (JavaThread)
       → 对每个运行中的 Java 线程:
         → os::SuspendedThreadTask → OS 层面挂起线程 (SIGSTOP)
         → 读取线程的栈帧 → JfrCallTrace → 记录方法 id 数组
         → 恢复线程 (SIGCONT)
     → 本地线程采样 (native sampler):
       → 类似但只读栈顶帧 (没有 full stack walk)
     → 挂起/恢复的代价很高 → 采样间隔 10-20ms → 限制对应用的影响

   JfrRecorderThread (JavaThread):
     → 在 JfrMsg_lock 上等待消息
     → 处理事件: PROCESS_FULL_BUFFERS, SCAVENGE, START, ROTATE
     → ROTATE 时触发 Chunk 轮转:
       → pre_safepoint_write() (并发写入非 safepoint 类型)
       → JfrVMOperation(JFRCheckpoint) → STW safepoint_write()
       → post_safepoint_write() (并发完成写入)

2. ★ 为什么 JfrThreadSampler 是 NonJavaThread?
   → 采样需要遍历并挂起 JavaThread → 如果自己也是 JavaThread → 如何挂起自己？
   → NonJavaThread 不受 safepoint 影响 → 可以在 safepoint 中继续运行
   → 但实际采样也是 NON-safepoint 并发进行的

3. ★ 挂起 Java 线程的原理:
   os::SuspendedThreadTask ↗ os::Linux::SuspendThread(task)
     → pthread_kill(tid, SIGUSR2) → 目标线程收到信号
     → 信号处理函数中 park() → 线程挂起
     → 采样线程读取栈帧
     → os::Linux::ResumeThread() → unpark → 线程继续

4. 加入 PostBoxServiceThread:
   →   JFR 内部还有一个独立的 JfrRecorderThread 在 post-box 上等消息
  → 用途: 处理 JFR internal events 的分发
  → 与 ServiceThread 完全无关
  → 实际类名: `JfrRecorderThread` (在 `jfrRecorderThread.cpp` 中)
```

#### 交叉引用
- [10 §1.1] JfrThreadSampler 在 NonJavaThread 继承链中的位置
- [07] VMThread → JFR 的 safepoint 检查点写入
- [12] ServiceThread → 与之独立的 JFR 自有线程
- [09] JfrRecorderThread 作为条件 JavaThread

---

### [16] JVM-Internal-Locks — 80+ 锁为什么不死锁

#### 核心叙事
21+ 条线程用 80+ 把内部锁协调，为什么不会死锁？答案：Lock Ranking——每把锁一个整数 rank，
线程获取锁必须按 rank **严格降序**。违反 → `fatal("possible deadlock")`。

#### 聚焦源文件

| # | 文件 | 完整路径 | 核心类/函数 | 角色 |
|---|------|---------|------------|------|
| 1 | `mutex.hpp` | `src/hotspot/share/runtime/mutex.hpp` | `Monitor`(:82), `Mutex`(:297), `lock_types` enum(:106) | ★ 基类 + rank 枚举 |
| 2 | `mutex.cpp` | `src/hotspot/share/runtime/mutex.cpp` | `set_owner_implementation()`(:1280), `lock()`(:878) | ★★★ rank 强制 + fatal 断言 |
| 3 | `mutexLocker.hpp` | `src/hotspot/share/runtime/mutexLocker.hpp` | `MutexLocker`(:182), `MutexLockerEx`(:223), `MonitorLockerEx`(:250) | ★ RAII 三层封装 |
| 4 | `mutexLocker.cpp` | `src/hotspot/share/runtime/mutexLocker.cpp` | `mutex_init()`(:194) | ★ 80+ 锁创建 + rank 注入 |

(完整规划见 `prompt-11-JVM-Internal-Locks.md`)

#### 交叉引用
- [07] VMThread 的锁使用
- [08] WorkerThread 的锁使用
- [09] JavaThread 系统的锁
- [10] NonJavaThread 的锁（PeriodicTask_lock, CGC_lock, etc.）

---

## 四、写作规范速查

| 规范 | 说明 |
|------|------|
| **标题格式** | `编号-英文名 — 中文副标题` |
| **元信息头** | 标准环境 + 源文件 + 前置 + 阅读收益 |
| **源码引用** | `文件名:行号`（如 `thread.cpp:1614`） |
| **GDB 断言** | ≥10 条，每条含命令 + 预期值 |
| **交叉引用** | `[编号-英文名]` 格式，如 `[10-NonJavaThread]` |
| **核心标注** | `★★★` 核心代码，`★` 关键发现，`❓` 问题驱动 |
| **深度要求** | 不写"定义+用途"流水账；每条线程 6 问（创建/循环/状态/碰堆/死亡/分类） |
| **禁止行为** | 不编造函数名；先查 source_index；先读 .hpp 再读 .cpp |
