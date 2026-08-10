# PROMPT: 请撰写 15-JVM-JFR-Sampling.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**"JFR 如何在不拖垮应用的前提下捕获每一帧？" — JfrThreadSampler + JfrRecorderThread 的双线程采样-录制分离架构**

### 核心故事线（禁止做源码翻译机！）

前十四篇文章已经覆盖了锁膨胀 [01-04]、线程生命周期/架构 [05-06]、VMThread [07]、WorkerThread [08]、10 个 JavaThread [09]、4 个 NonJavaThread [10]、AttachListener [11]、ServiceThread [12]、ReferenceHandler+Finalizer [13]、CompilerThread+Sweeper [14]。现在要回答一个面试级问题：**JFR 采了一整天，为什么应用几乎不受影响？**

答案不是"它做了优化"这四个字——这等于没说。真正的问题是：

1. **采样线程为什么是 NonJavaThread，而不是 JavaThread？**— 采样需要遍历 `ThreadsList` 并挂起 JavaThread 来读栈帧。如果自己也是 JavaThread，被自己挂起 → 死锁。更深层的原因是：`os::SuspendedThreadTask` 使用 `pthread_kill(SIGUSR2)` 挂起目标线程，而信号处理函数在目标线程自己的栈上执行——如果采样线程也响应信号，它就无法读自己的栈帧。NonJavaThread 不参与 safepoint、不受 SIGUSR2 挂起 → 完美的"旁观者"身份。

2. **采样和挂起为什么不导致 STW？**— 采样是**逐线程、逐个挂起**的，不是 `Stop-The-World`。`JfrThreadSampler` 遍历 `ThreadsList`，对每个 JavaThread 依次：发送 SIGUSR2 → 目标线程在信号处理函数中 `park()` → 采样线程读栈帧（此时只有这一个线程被挂起，其他线程照常运行）→ `unpark()` 恢复。从应用视角看，单次采集只影响一个线程的 ~10-50μs——几乎不可感知。

3. **采样数据和录制数据为什么分离？**— `JfrThreadSampler`（NonJavaThread）只负责**采集**——挂起线程、读栈帧、写 method_id 数组到 thread-local buffer。`JfrRecorderThread`（JavaThread）负责**录制**——从 full buffer 中取数据、序列化到 JFR Chunk、触发检查点写入。采集是**低延迟、不可阻塞**的热路径（每个线程每 10ms 一次），录制是**高延迟、可阻塞**的冷路径（磁盘 IO、锁竞争）。分离后采集不受录制阻塞影响。

4. **★ Chunk 轮转为什么需要 safepoint？**— JFR 的每次 Chunk 轮转包含三个阶段：`pre_safepoint_write()`（并发写入线程安全的元数据）、`safepoint_write()`（STW 期间写入需要全局一致性的数据，如所有线程的栈帧快照）、`post_safepoint_write()`（并发完成）。`safepoint_write()` 通过 `JfrVMOperation` 提交到 `VMThread` 执行——这是 JFR 和 [07-VMThread] 的**直接交互点**。不经过 safepoint，就无法获得全局一致的线程状态快照。

5. **★ 为什么采样间隔默认 10ms 而不是 1ms？**— `pthread_kill` + `park` + 读栈帧 + `unpark` 的单次成本约 10-50μs。10ms 间隔 → 采样开销约 0.1%-0.5%。1ms 间隔 → 开销 1%-5% → 对延迟敏感的金融交易系统不可接受。10ms 是「统计学足够（大数定律）+ 开销可接受」的平衡点。

6. **★ JfrRecorderThread 为什么是 JavaThread 而不是 NonJavaThread？**— 检查点写入时需要调用 Java 层代码（`jdk.jfr.internal.MetadataRepository` 等）来序列化事件类型元数据。JavaThread 身份允许它通过 JNI 进入 Java 层。但它的栈大小不是 4MB（不像 CompilerThread 需要深度递归）——JfrRecorderThread 的调用深度很浅（消息循环 → 序列化 → IO）。

7. **★ 采样数据如何从 NonJavaThread 传递到 JavaThread？**— 不是通过队列或共享变量！而是通过 **thread-local buffer**：每个 JavaThread 有自己的 JFR buffer（在 Java 堆上）。采样线程 `JfrThreadSampler` 直接写目标线程的 buffer → 不需要加锁（buffer 是 thread-local 的）→ buffer 满了 → `JfrRecorderThread` 被唤醒 → 读取 buffer 内容序列化到 Chunk。这里的精妙之处：**采集线程（NonJavaThread）和消费线程（JavaThread）操作不同的 buffer——采集写当前 thread-local buffer，消费处理已满的 full buffer**。用「生产者-消费者但不同 buffer」避免了锁竞争。

8. **与 [12-ServiceThread] 的关键区别**：JFR 完全不走 ServiceThread！JfrRecorderThread 是 JFR 自己创建的独立线程，在 `JfrMsg_lock` 上等待消息循环。这是有意为之——JFR 的 Chunk 轮转和检查点写入可能耗时数百毫秒，如果放在 ServiceThread 中会阻塞 JVMTI 事件和 StringTable 清理。

9. **★★ 如果目标线程正在 safepoint 中，采样线程怎么办？**— 采样线程遍历 `ThreadsList` 时，每个目标 JavaThread 有不同的 `thread_state()`：`_thread_in_Java`（可以安全挂起）、`_thread_in_native`（也响应信号）、`_thread_in_vm`（可能在 GC safepoint 中！）、`_thread_blocked`（等待锁）。采样线程必须检查目标线程的状态 → 如果目标线程在 `_thread_in_vm` 或不安全状态 → 跳过这个线程 → 不挂起。这避免了采样线程和 GC 的冲突。

10. **★★ 采样遍历期间 JavaThread 退出了怎么办？**— 遍历使用 `ThreadsListHandle`（Hazard Pointer / SMR 机制）。`ThreadsListHandle` 构造函数获取当前 `ThreadsList` 的快照指针并发布 hazard pointer。如果某 JavaThread 在遍历期间退出 → 它的 `JavaThread` 对象不会被立即释放（SMR 延迟释放）→ 采样线程访问指针安全。退出线程的 `JavaThread` 对象在 `ThreadsSMRSupport::smr_delete()` 中延迟释放——等所有 hazard pointer 持有者释放后才真正 delete。

11. **★★ JfrRecorderThread 处理消息时处于什么 safepoint 状态？**— 在 `JfrMsg_lock->wait()` 期间 → `_thread_in_vm` → 参与 safepoint。在 `PROCESS_FULL_BUFFERS` 序列化写磁盘期间 → 可能处于 `_thread_in_native`（IO 操作）→ 不阻塞 safepoint。在 ROTATE 提交 `JfrVMOperation` 后 → 等待 VMThread 执行 safepoint → 线程在等待锁/条件变量 → 允许 safepoint。这个状态机是 JfrRecorderThread 必须为 JavaThread 的核心原因——它需要和 GC 协调。

### 禁止行为

- ❌ 把 JfrThreadSampler 的循环写成"每 10ms 采样一次"— 这是 API 文档，不是源码分析
- ❌ 忽略 NonJavaThread 身份选择的深层原因 — 要追问"如果改成 JavaThread 会怎样？"→ 信号处理的递归、safepoint 死锁
- ❌ 忽略采样和录制的物理隔离 — buffer 所有权、锁竞争分析、热路径冷路径分离
- ❌ 忽略 Chunk 轮转的 safepoint 依赖 — `JfrVMOperation` 是 JFR 和 VMThread 的唯一交互点
- ❌ 忽略「逐线程挂起」和「STW」的本质区别 — 前者是 O(N) 的增量开销，后者是 O(1) 的全暂停
- ❌ 忽略目标线程状态检查 — 目标线程可能在 `_thread_in_vm`（GC safepoint）、`_thread_blocked`（锁等待）、`_thread_in_native` 等不同状态，不是所有状态都能安全挂起
- ❌ 忽略 `ThreadsListHandle` 的 SMR 并发安全机制 — 遍历期间线程退出了怎么办？不解释 Hazard Pointer 就是漏掉了核心安全设计
- ❌ 不画"采样→buffer→消费→Chunk→检查点"的完整数据流图
- ❌ 不解释 thread-local buffer 为什么不需要加锁
- ❌ 混淆 `JfrRecorderThread`（JavaThread）和 `JfrThreadSampler`（NonJavaThread）— 两条线程身份不同、职责不同、生命周期不同
- ❌ 将 §4.1 中的概念性伪代码当成真实源码引用 — 所有函数名必须从实际源码文件验证

### 要求行为

- ✅ **★★★ JFR 双线程架构全景图**：画出 JfrThreadSampler → 遍历 ThreadsList → 逐线程挂起/读栈/恢复 → 写 thread-local buffer → buffer 满 → JfrRecorderThread 消费 → 序列化到 Chunk 的完整数据流
- ✅ **★★ os::SuspendedThreadTask 挂起机制**：`pthread_kill(SIGUSR2)` → 信号处理函数 `park()` → 采样线程读栈帧 → `unpark()` 恢复。解释为什么不是 `SIGSTOP`（太粗暴，进程级）而是 `SIGUSR2`（线程级，精确控制）
- ✅ **★ 为什么 JfrThreadSampler 是 NonJavaThread**：三个递进层次 — (1) 不能挂起自己，(2) 不受 safepoint 影响，(3) 不响应 SIGUSR2 信号
- ✅ **★ JfrRecorderThread 的消息循环**：等待 `JfrMsg_lock` → 处理 `PROCESS_FULL_BUFFERS` / `SCAVENGE` / `START` / `ROTATE` 四种事件
- ✅ **★★ Chunk 轮转的三阶段**：`pre_safepoint_write()` → `JfrVMOperation(STW safepoint)` → `post_safepoint_write()`，解释每阶段写入的数据类型（为什么有些数据需要 STW，有些不需要）
- ✅ **★ 检查点的作用**：不是"保存进度"！检查点是**事件类型元数据的快照**——类的名称、方法的签名、字段的类型。没有检查点，JFR 文件中的事件数据无法被解析（不知道 method_id=1234 对应什么方法）
- ✅ **★ Thread-local buffer 设计**：为什么 buffer 在线程本地 → 不需要锁 → 为什么满了才通知 RecorderThread → 批处理减少锁竞争和 IO
- ✅ **★ 目标线程状态安全检查**：采样线程如何检查目标线程的 `thread_state()`？哪些状态可以安全挂起（`_thread_in_Java`、`_thread_in_native`），哪些必须跳过（`_thread_in_vm`）？不跳过会导致什么？
- ✅ **★ ThreadsListHandle 并发安全**：SMR/Hazard Pointer 机制如何保证采样遍历期间不访问已释放的 JavaThread？`smr_delete()` 的延迟释放协议
- ✅ **★ 和 ServiceThread 的隔离**：JFR 线程完全独立，不走 ServiceThread。为什么？→ JFR chunk rotation 可能耗时数百 ms → 放在 ServiceThread 会阻塞 JVMTI
- ✅ **★ 采样间隔的动态调整**：`interval_java` vs `interval_native`（对 Java 线程和 native 线程不同的采样频率），`JfrThreadSampler::sample_interval()` 的 tunable 机制
- ✅ **★ 分配采样 vs 线程采样**：两种完全不同的采样子系统的架构对比
- ✅ **GDB 验证**：≥12 条 GDB 命令，验证两条 JFR 线程的存在性、采样间隔、buffer 状态、Chunk 轮转
- ✅ **三线程对比线**：JfrThreadSampler vs VMThread（都遍历所有线程，但一个在 safepoint 外、一个在 safepoint 内）vs JfrRecorderThread vs ServiceThread（都处理异步事件，但一个专用、一个通用）

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- JFR 通过 `-XX:StartFlightRecording=dumponexit=true,filename=recording.jfr` 或 `jcmd <pid> JFR.start` 启动
- ★ JfrThreadSampler 在 `JfrRecorder::start()` 时创建（条件创建，不开启 JFR 则不存在）
- ★ JfrRecorderThread 在 `JfrRecorder::create_threads()` 时创建（同上，条件创建）
- ★ 创建时机追踪：从 `create_vm()` 开始 → 搜索调用链 `JfrRecorder::create_threads()` → 确认在 G1 线程创建之后、SystemDictionary 初始化之后（JFR 需要类元数据已就绪）
- ★ JFR 线程名需从源码确认（实际名称可能为 `"JFR Thread Sampler"` / `"JFR Recorder"` 等变体，不能假设）

## 三、聚焦源文件

> ★★★ **读码顺序铁律**（违反必翻车）:
> 1. 先读 `thread.hpp` — 理解 `JfrThreadSampler`、`JfrRecorderThread` 类定义 — 继承链 + 字段含义
> 2. 再读 `jfrThreadSampler.hpp/.cpp` — 理解 `JfrThreadSampler` 采样循环 — 全文核心
> 3. 再读 `jfrRecorderThread.hpp` + `jfrRecorderThreadLoop.cpp` — 理解录制线程消息循环
> 4. 再读 `jfrRecorderService.hpp` — 理解 `JfrRecorderService` 和 Chunk 轮转
> 5. 再读 `jfrCheckpointManager.hpp` — 理解检查点的数据结构和写入时机
> 6. 再读 `os::SuspendedThreadTask` — 理解 OS 层挂起机制

| # | 文件 | 完整路径 | 核心类/函数 | 本文角色 |
|---|------|---------|------------|---------|
| 1 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | JfrThreadSampler 继承链, JfrRecorderThread 继承链 | ★ 类定义 — 身份、字段、继承关系 |
| 2 | `jfrThreadSampler.hpp` | `src/hotspot/share/jfr/periodic/sampling/jfrThreadSampler.hpp` | `JfrThreadSampling`(:35), `JfrThreadSampler` | ★★★ 采样线程类定义 — 采样间隔、采样模式 |
| 3 | `jfrThreadSampler.cpp` | `src/hotspot/share/jfr/periodic/sampling/jfrThreadSampler.cpp` | `JfrThreadSampler::run()`(:311), `JfrThreadSampling::start_thread()`(:550) | ★★★ 全文核心 — 采样循环实现 |
| 4 | `jfrCallTrace.hpp` | `src/hotspot/share/jfr/periodic/sampling/jfrCallTrace.hpp` | `JfrGetCallTrace`(:34) | ★ 调用栈追踪 — 如何读栈帧 |
| 5 | `jfrRecorderThread.hpp` | `src/hotspot/share/jfr/recorder/service/jfrRecorderThread.hpp` | `JfrRecorderThread`(:36) | ★ 录制线程类定义 |
| 6 | `jfrRecorderThreadLoop.cpp` | `src/hotspot/share/jfr/recorder/service/jfrRecorderThreadLoop.cpp` | `recorderthread_entry()`(:38-95) | ★ 录制线程消息循环 |
| 7 | `jfrRecorderService.hpp` | `src/hotspot/share/jfr/recorder/service/jfrRecorderService.hpp` | `JfrRecorderService`(:37) | ★ Chunk 轮转引擎 |
| 8 | `jfrRecorderService.cpp` | `src/hotspot/share/jfr/recorder/service/jfrRecorderService.cpp` | `rotate()` / `write()` | Chunk 轮转实现 |
| 9 | `jfrCheckpointManager.hpp` | `src/hotspot/share/jfr/recorder/checkpoint/jfrCheckpointManager.hpp` | `JfrCheckpointManager`(:54) | ★ 检查点状态管理 + 写入时机 |
| 10 | `jfrCheckpointManager.cpp` | `src/hotspot/share/jfr/recorder/checkpoint/jfrCheckpointManager.cpp` | `write_checkpoint()` | 检查点写入实现 |
| 11 | `os.hpp` | `src/hotspot/share/runtime/os.hpp` | `os::SuspendedThreadTask`(:948) | ★ OS 线程挂起机制抽象 |
| 12 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | `SuspendThread` / `ResumeThread` | ★ Linux SIGUSR2 挂起实现 |
| 13 | `jfrOptionSet.hpp` | `src/hotspot/share/jfr/recorder/storage/jfrOptionSet.hpp` | JFR 参数配置（采样间隔等） | JFR 启动参数 |
| 14 | `mutexLocker.cpp` | `src/hotspot/share/runtime/mutexLocker.cpp` | `JfrMsg_lock`, `JfrBuffer_lock` | ★ JFR 专用锁 — 和 [16] 的关联 |
| 15 | `jfrThreadLocal.hpp` | `src/hotspot/share/jfr/recorder/storage/jfrThreadLocal.hpp` | `JfrThreadLocal` | ★★ buffer 挂载点 — 采样线程写入目标线程的 buffer 入口 |
| 16 | `jfrBuffer.hpp` | `src/hotspot/share/jfr/recorder/storage/jfrBuffer.hpp` | `JfrBuffer` | ★ buffer 数据结构 — 满了如何通知 RecorderThread |
| 17 | `jfrRecorder.hpp` | `src/hotspot/share/jfr/recorder/jfrRecorder.hpp` | `JfrRecorder` | ★★ 顶层录制器 — `create_threads()` 入口, JFR 线程创建调用链起点 |
| 18 | `jfrVMOperations.hpp` | `src/hotspot/share/jfr/recorder/service/jfrVMOperations.hpp` | `JfrVMOperation` | ★ VMThread 交互接口 — JFR 和 [07] 的直接桥梁 |

## 四、必须深度走读的核心概念

### 4.1 ★★★ JFR 双线程架构全景 — 全文核心

> ★★★ 以下为概念性伪代码！所有函数名（`JfrThreadSampler::run()`、`ThreadsListHandle`、`os::Linux::SuspendThread`、`jfr_write_call_trace`、`JfrGetCallTrace::doit()`、`JfrRecorderService::rotate()` 等）和行号必须从实际源码文件中逐一定位验证，禁止将伪代码直接复制为文档中的"源码引用"！

```
┌─★★★ 采样线程 (JfrThreadSampler, NonJavaThread) ────────────────────────────┐
│                                                                             │
│  JfrThreadSampler::run() 主循环:                                            │
│    while (_active) {                                                        │
│      // Step 1: 睡眠等待采样间隔 (默认 10ms Java, 10ms Native)              │
│      os::sleep(this, _sample_interval_java, false);     // Java 线程采样    │
│                                                                             │
│      // Step 2: 遍历所有 JavaThread                                          │
│      ThreadsListHandle tlh;  // ★ SMR snapshot, 安全遍历                     │
│      for (JavaThread* jt = tlh.list()->threads(); jt != NULL; jt = next) {  │
│                                                                             │
│        // Step 3: ★ 逐个挂起目标线程                                         │
│        //         不是 STW! 其他线程继续跑                                    │
│        JfrGetCallTrace trace(thread, _stackdepth);                          │
│        os::SuspendedThreadTask task(thread, trace);                         │
│        os::Linux::SuspendThread(thread);  // pthread_kill(SIGUSR2)           │
│        // → 目标线程在信号处理函数中 park()                                   │
│                                                                             │
│        // Step 4: ★ 在目标线程的栈上读取栈帧                                  │
│        task.run();  // JfrGetCallTrace::doit(): 遍历栈帧, 记录 method_id[]   │
│                                                                             │
│        // Step 5: 恢复目标线程                                               │
│        os::Linux::ResumeThread(thread);  // unpark()                         │
│                                                                             │
│        // Step 6: ★ 写采样结果到目标线程的 thread-local buffer               │
│        //         注意: 不是写自己的 buffer! 是写被采样线程的 buffer           │
│        jfr_write_call_trace(trace, thread);                                 │
│        // 内部:                                                             │
│        //   获取 thread->jfr_thread_local()->data_buffer()                   │
│        //   写入 method_id 数组 → 不需要加锁! buffer 是 thread-local 的         │
│        //   buffer 满了? → 加入 full_buffer_list → notify JfrRecorderThread │
│      }                                                                      │
│                                                                             │
│      // Step 7: Native 线程采样 (如果启用)                                    │
│      os::sleep(this, _sample_interval_native, false);                       │
│      // 类似逻辑, 但只读栈顶帧 (不全量 walk)                                   │
│    }                                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │  buffer 满了 → notify
                                      ↓
┌─★★★ 录制线程 (JfrRecorderThread, JavaThread) ───────────────────────────────┐
│                                                                             │
│  recorderthread_entry() 消息循环:                                            │
│    while (true) {                                                           │
│      // ★ 在 JfrMsg_lock 上等待消息                                          │
│      MonitorLockerEx msg_lock(JfrMsg_lock, _no_safepoint_check_flag);       │
│      while (!has_messages()) {                                              │
│        msg_lock.wait();                                                     │
│      }                                                                      │
│                                                                             │
│      switch (msg_type) {                                                    │
│        case PROCESS_FULL_BUFFERS:  // ★ 消费满 buffer                       │
│          → 遍历 full_buffer_list                                             │
│          → 对每个 buffer: 序列化事件到当前 Chunk                              │
│          → 归还 buffer 到空闲池                                              │
│          break;                                                             │
│                                                                             │
│        case SCAVENGE:               // ★ 紧急清扫                            │
│          → 强制所有线程 flush local buffer                                   │
│          → 类似 PROCESS_FULL_BUFFERS 但更激进                                 │
│          break;                                                             │
│                                                                             │
│        case START:                  // ★ 开始录制                            │
│          → 初始化 Chunk 管理                                                │
│          → 创建 JfrThreadSampler (如果还没有)                                │
│          break;                                                             │
│                                                                             │
│        case ROTATE:                // ★ Chunk 轮转                           │
│          → JfrRecorderService::rotate():                                     │
│            ┌─ pre_safepoint_write():                                        │
│            │   写入线程安全的元数据 (thread-local, 不需要 STW)                │
│            │   → 当前所有活跃线程的 buffer 内容                               │
│            │                                                                 │
│            ├─ ★ JfrVMOperation (STW safepoint):                             │
│            │   VMThread 执行 safepoint_write():                              │
│            │   → 检查点写入: 类名、方法签名、字段类型 (全局一致性快照)         │
│            │   → 所有线程的完整栈帧快照 (线程状态)                            │
│            │   → 为什么需要 STW? 因为读取的元数据可能被并发修改               │
│            │                                                                 │
│            └─ post_safepoint_write():                                       │
│               完成 Chunk 元数据, 关闭旧 Chunk → 创建新 Chunk                  │
│          break;                                                             │
│      }                                                                      │
│    }                                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**★★★ 追问：为什么采样线程写的是目标线程的 buffer，而不是自己的 buffer？**

```
如果写采样线程自己的 buffer:
  → 所有采样数据汇集到一条线程的 buffer
  → buffer 满了 → 必须加锁通知 RecorderThread
  → 采样期间可能触发 buffer 满 → 需要锁 → 采样延迟不稳定

如果写目标线程的 buffer (实际设计):
  → 每条线程有自己的 thread-local buffer
  → 采样线程直接写入 → 不需要锁 (buffer 有唯一 owner)
  → buffer 满 → 目标线程自己负责通知 RecorderThread
  → ★ 关键: 采样线程只在「采样间隔」期间活跃 → buffer 满在目标线程的下次安全点检查中处理
  → 采样路径零锁! 这才是 "不影响应用" 的关键
```

### 4.2 ★★ os::SuspendedThreadTask — Linux 线程挂起机制

```
为什么是 pthread_kill(SIGUSR2) 而不是 SIGSTOP?

SIGSTOP:
  → 进程级信号 → 整个进程被挂起 → 采样线程自己也停了 → 无法读栈帧
  → 目标线程没有机会在挂起前做清理

SIGUSR2:
  → 线程级信号 → 只发特定线程 (pthread_kill)
  → 目标线程在信号处理函数中 park() → 调用栈完整
  → 采样线程调用栈在信号处理函数之上 → 从信号帧开始 read stack
  → park() 后的线程 = 一个活的但不再推进的线程 → 采样线程安全访问其所有寄存器+栈

挂起流程 (os_linux.cpp):
  os::Linux::SuspendThread(JavaThread* thread):
    → pthread_kill(thread->osthread()->thread_id(), SIGUSR2)  ★ 发送信号
    → 等待 _suspend_flags & _external_suspend_equivalent 被设置
    → 确认线程已 park

  信号处理函数 (JavaThread::check_special_condition_for_native_trans()):
    → 收到 SIGUSR2 → 设置 suspend flag
    → thread->java_suspend() → 内部调用 park() → 线程停止

  os::Linux::ResumeThread(JavaThread* thread):
    → thread->java_resume() → unpark() → 线程继续

★★★ 追问: 如果目标线程正在执行 native 代码（不在 Java 层），怎么采集调用栈？

  → native 线程也响应 SIGUSR2!
  → 但 native 的方法栈在 native call stack (libc, libjvm, etc.)
  → JfrGetCallTrace::doit() 通过 frame::sender() 遍历:
      先从 signal frame 中恢复 pc/sp/fp
      → 分辨每个帧是 Java 帧还是 native 帧
      → Java 帧 → 读 Method* → 记录 method_id
      → native 帧 → 读共享库名称 + PC offset
  → 这是 JFR 支持 native 采样的关键: 不依赖 safepoint, 而是直接用 frame walker
```

### 4.3 ★ Chunk 轮转的三阶段 — 为什么需要 safepoint？

```
JFR Chunk 结构:
  ┌──────────────────────────────┐
  │ Chunk Header                 │
  │  └─ magic, version, size     │
  ├──────────────────────────────┤
  │ ★ Checkpoint (检查点)        │ ← 事件类型元数据(n次写入,每次追加)
  │  └─ ClassLoader 列表         │
  │  └─ 类名→symbol_id 映射      │
  │  └─ 方法签名映射              │
  │  └─ 线程名称映射              │
  │  └─ StackFrame 表            │
  ├──────────────────────────────┤
  │ Events (事件数据)            │ ← 原始采样/分配/IO/锁事件
  │  └─ ExecutionSample          │
  │  └─ ObjectAllocationInNewTLAB│
  │  └─ JavaMonitorEnter         │
  │  └─ ...                      │
  └──────────────────────────────┘

★ 检查点和事件数据的本质区别:
  检查点 = 静态元数据 ("method_id=1234 对应 java.util.HashMap::getNode")
  事件数据 = 动态时间序列 ("时刻 T, 线程 5 在执行 method_id=1234")

  如果没有检查点 → JFR 文件中的事件数据只是一个 method_id 数组 → 无法解析
  这就是为什么检查点在 safepoint 中写入: 需要全局一致的类型系统快照

旋转三阶段:

  阶段 1: pre_safepoint_write() — 并发写入
    → 读取所有线程的 thread-local buffer → 不需要 STW (锁保护)
    → 写入 thread states、GC 引用、constant pool entries

  阶段 2: ★ JfrVMOperation → safepoint_write() — STW 写入
    → VMThread 执行 → 全局 safepoint
    → 写入需要"此时此刻所有线程都不变"才能保证一致性的数据:
      - 检查点: 类名、方法签名、字段类型 (ClassLoader 可能并发修改)
      - 线程状态快照: 所有线程的栈帧快照、线程名→id 映射
    → 没有 STW 就无法保证: 类 A 的名字在写之前被 redefine → 撕裂

  阶段 3: post_safepoint_write() — 并发完成
    → 关闭旧 Chunk → flush 到磁盘
    → 创建新 Chunk → 初始化 header
    → 通知 agent

★★ 追问: 如果不用 safepoint, 能不能原子性地写入检查点?

  不能。因为检查点包含的数据分散在 Metaspace (类名、方法签名)、
  线程数据结构 (线程名)、全局表 (symbol table) 中。这些数据在运行时
  被并发修改——没有 STW 就无法保证「看到的是某个时刻的全局一致性快照」。
```

### 4.4 ★ JfrRecorderThread 消息循环 — 为什么不是 ServiceThread？

```
JfrRecorderThread 的消息处理:

  Msg Type         | 做什么                         | 耗时      | 频率
  ─────────────────────────────────────────────────────────────────
  PROCESS_FULL_    | 消费 full buffer → Chunk       | ~10-100ms | 每 ~min
  BUFFERS          |                                |           |
  SCAVENGE         | 强制所有线程 flush buffer       | ~5-50ms   | 紧急时
  START            | 初始化 Chunk → 启动采样线程     | ~1-5ms    | 录制开始时
  ROTATE           | 三阶段 Chunk 轮转 (含 safepoint)| ~50-500ms | 每 Chunk
  ─────────────────────────────────────────────────────────────────

★ 为什么不能放在 ServiceThread 中?

  如果 ROTATE 在 ServiceThread 中执行:
    → ServiceThread 同时管理 JVMTI + StringTable + LowMemory + GCNotifier + DCmd
    → ROTATE 需要 50-500ms (含 safepoint 等待)
    → 期间所有 JVMTI 事件、StringTable 清理、低内存告警全部阻塞
    → JVMTI agent 可能超时 → agent 错误

  如果 JfrRecorderThread 有自己独立的消息循环:
    → 只有 JFR 自己的操作受影响
    → 其他 JVM 后台服务照常运行
    → 这是「专用线程 > 多路复用」的经典应用

★★ 那为什么不和 JfrThreadSampler 合并?

  合并 → 采样线程还要做磁盘 IO → 采样延迟剧增
  采样是 μs 级别的热路径，录制是 ms 级别的冷路径
  合并后的线程在采样间隔内做 IO → 下一个采样周期延迟
```

### 4.5 ★ 补充: 线程采样 vs 分配采样 — 为什么分配采样不用独立线程？

```
本文聚焦 JFR 的线程架构，分配采样并非本文重点（它不创建独立线程），
此处仅作简要对比以凸显线程采样的设计合理性:

JFR 有两种完全不同的采样:

  1. 线程采样 (Execution Sample):
     触发者: JfrThreadSampler (NonJavaThread)
     频率: 默认每 10ms 一次
     方法: 挂起线程 → 读栈帧 → 记录 method_id[]
     数据: "时刻 T, 线程 X 在执行 method_id[]"
     用途: 火焰图、CPU 热点分析

  2. 分配采样 (Object Allocation Sample):
     触发者: 应用线程自己 (不是采样线程!)
     频率: 每分配 TLAB_SIZE / ObjectAllocationSampleWeight 字节一次
     方法: 应用线程在分配新 TLAB 时检查计数器 → 记录当前调用栈
     数据: "线程 X 在 method_id[] 的上下文中分配了 Y 个对象"
     用途: 内存分配热点分析

★ 为什么分配采样不用独立的采样线程?
  → 因为分配的频率太高 (每秒 10^6~10^9 次)
  → 独立线程无法跟上这个频率
  → 改为在应用线程的「分配热路径」上做 light-weight 采样
  → 计数器在 TLAB 头中 → 不需要跨线程同步
```

### 4.6 ★ 与已有文档的关键对比

```
JfrThreadSampler (NonJavaThread)
  vs VMThread (NonJavaThread, [07]):
    都遍历所有线程 + 读状态
    但: VMThread 在 safepoint 中读 → 全局一致但不并发
        JfrThreadSampler 在 safepoint 外读 → 并发但有概率不一致（可接受）
    这叫「consistency vs availability」的取舍

JfrThreadSampler (NonJavaThread)
  vs G1ConcurrentMarkThread (NonJavaThread, [10]):
    都遍历线程 + 读栈
    但: G1ConcurrentMarkThread 用 SATB 读 oop (并发安全)
        JfrThreadSampler 直接用裸指针 + signal handler (不是 oop, 是栈帧)
    遍历理由相同：要读每个线程的局部状态

JfrRecorderThread (JavaThread)
  vs ServiceThread (JavaThread, [12]):
    都处理异步事件
    但: ServiceThread 是通用多路复用器 (5 种事件)
        JfrRecorderThread 是专用处理器 (只有 JFR 的 4 种消息)
    独立 = 不可阻塞 = JFR 不影响其他 JVM 功能
```

## 五、文章结构

```
§〇 源文件清单（跨 jfr/periodic/sampling + jfr/recorder/service + os）

§一 JFR 双线程架构全景 — 采样和录制为什么必须分离？
  ★ 开头即贴 jstack 和 pstack 输出中两条 JFR 线程
  ❓ 开启 JFR 后为什么多了两条线程？
  1.1 ★★★ 采样-录制分离的数据流图（采样线程→buffer→录制线程→Chunk→检查点）
  1.2 JfrThreadSampler: NonJavaThread 的设计原因（三重论证）
  1.3 JfrRecorderThread: JavaThread 的设计原因（为什么需要 JNI）
  1.4 ★ 为什么 JFR 不走 ServiceThread？— 独立消息循环的工程决策

§二 ★★★ JfrThreadSampler — 采样循环逐行走读
  ❓ 如何在 N 条线程中，每个线程只停 10μs 就完成栈帧采集？
  2.1 ★ 主循环：sleep → 遍历 ThreadsList → 逐个 Suspend/Read/Resume
  2.2 ★ os::SuspendedThreadTask — pthread_kill(SIGUSR2) 的 OS 层机制
  2.3 ★ JfrGetCallTrace — 栈帧遍历：如何不受 safepoint 约束读栈
  2.4 ★ Thread-local buffer: 为什么不需要加锁
  2.5 ★★ 目标线程状态安全检查 — 哪些状态能挂？哪些必须跳过？
  2.6 ★★ ThreadsListHandle SMR 并发安全 — 遍历期间线程退出了怎么办？
  2.7 采样间隔的动态调整：interval_java vs interval_native
  2.8 ★ [sidebar] 分配采样 vs 线程采样: 为什么分配不走独立线程

§三 ★★ JfrRecorderThread — 消息循环 + Chunk 轮转
  ❓ 录制线程等待的 4 种消息分别做什么？
  3.1 ★ 消息循环：JfrMsg_lock 上的 4 状态等待 + 处理（含 safepoint 状态分析）
  3.2 ★ PROCESS_FULL_BUFFERS — 从 thread-local buffer 到 Chunk
  3.3 ★★ ROTATE — Chunk 轮转三阶段：pre_safepoint → JfrVMOperation(STW) → post_safepoint
  3.4 ★ 检查点的本质 — 为什么需要全局一致性快照
  3.5 SCAVENGE 紧急清扫 — 何时触发？为什么力度更激进？

§四 ★ 对比线: JfrThreadSampler vs VMThread vs G1ConcurrentMarkThread
  ❓ 三条线程都遍历所有线程，为什么设计完全不同？
  4.1 遍历方式对比: safepoint 内 vs safepoint 外 vs concurrent
  4.2 读取内容对比: oop vs 栈帧 vs Method*
  4.3 一致性 vs 可用性 的取舍

§五 ★ JfrRecorderThread vs ServiceThread — 专用 vs 通用
  ❓ 为什么 JFR 坚持要自己的线程？
  5.1 耗时对比: ROTATE (50-500ms) vs JVMTI event (~1μs)
  5.2 阻塞传染分析: 如果放在 ServiceThread 会怎样
  5.3 独立线程的代价: 多一条线程的栈空间 (~1MB) + 锁

§六 GDB 验证 + 可证伪断言（≥12 条 GDB + ≥6 条断言）

  断言 1: (gdb) info threads | grep -E "Jfr|jfr|Sampler|Recorder"
    → 预期: JFR 开启时看到两条线程（名称需从源码确认）
  断言 2: (gdb) p JfrThreadSampler::_instance → 预期: 非 NULL (JFR 开启时)
  断言 3: (gdb) p JfrRecorderThread::_instance → 预期: 非 NULL
  断言 4: (gdb) p ((JfrThreadSampler*)...)->_sample_interval_java
    → 预期: 10 (ms)
  断言 5: (gdb) p ((JfrThreadSampler*)...)->_active → 预期: true
  断言 6: (gdb) break JfrGetCallTrace::doit → (gdb) continue
    → 预期: 在每次采样时断住 → bt 显示调用链来自 JfrThreadSampler
  断言 7: (gdb) p JfrRecorderService::_chunkwritten → 预期: 非 0
  断言 8: (gdb) break JfrRecorderService::rotate → (gdb) continue
    → 预期: 在 Chunk 轮转时触发
  断言 9: (gdb) break JfrVMOperation::doit → (gdb) continue
    → 预期: 在 safepoint 检查点写入时触发 → bt 显示 VMThread 调用
  断言 10: (gdb) p SIGUSR2 → 预期: 常量值 (通常 12, x86_64 Linux)
    → ★ 验证: JFR 使用的挂起信号是否为 SIGUSR2（需从源码确认函数/字段名）
  断言 11: (gdb) break os::Linux::SuspendThread → (gdb) continue
    → 预期: 被 JfrThreadSampler 的循环调用
  断言 12: (gdb) info threads | grep -c "Jfr" → 预期: 2 (Sampler + Recorder)

  可证伪断言 1: -XX:StartFlightRecording → JFR 开启 → 比 JFR 关闭时多 2 条线程
  可证伪断言 2: JfrThreadSampler crash → 采样停止 → JFR 文件无 ExecutionSample 事件 → JVM 不崩溃
  可证伪断言 3: JfrRecorderThread crash → buffer 积累 → OOM 风险 → JVM 可能崩溃 (内存耗空)
  可证伪断言 4: 采样线程的挂起不是 STW — 单次只挂一个线程，其他线程照常运行
  可证伪断言 5: 关闭 JFR → 两条 JFR 线程都不存在 → pstack 中无它们
  可证伪断言 6: 检查点写入在 safepoint 中 — 断点 JfrVMOperation::doit → bt 显示 VMThread
```

## 六、写作要求

1. **★ 双线程分离是全文灵魂**：解释为什么采样（热路径、μs 级、NonJavaThread）和录制（冷路径、ms 级、JavaThread）必须分离
2. **★ OS 挂起机制**：`pthread_kill(SIGUSR2)` → 信号处理函数 `park()` → 采样线程读栈 → `unpark()` 恢复 — 每步都要解释"为什么不能跳过"
3. **★ Chunk 轮转的三阶段**：`pre_safepoint → safepoint(VMThread) → post_safepoint` — 解释每阶段写什么数据 + 为什么需要/不需要 STW
4. **检查点的本质**：不是"保存进度"！是**事件类型元数据的快照** — 没有检查点，JFR 文件无法解析
5. **非 STW 的线程遍历**：和 [07-VMThread] 的 safepoint 内遍历对比 — JfrThreadSampler 选择了一致性不完全但并发的方案
6. **和 ServiceThread 的隔离**：JFR 线程不走 ServiceThread — 防止 JFR 操作阻塞 JVMTI
7. **Thread-local buffer 的零锁设计**：采样线程直接写目标线程的 buffer → 不需要锁 → 采样路径无阻塞
8. **分配采样 vs 线程采样**：两种完全不同的采样机制 — 一个在采样线程、一个在应用线程
9. **三线程对比**：JfrThreadSampler vs VMThread vs G1ConcurrentMarkThread — 都遍历线程，但设计完全不同
10. **GDB 验证**：≥12 条（含 OS 挂起机制断点 + 检查点 safepoint 断点）；可证伪断言 ≥6 条
11. **交叉引用**：[07] VMThread + [10] NonJavaThread + [12] ServiceThread + [09] JavaThread 系统

## 七、输出格式

- Markdown 文件，命名为 `15-JVM-JFR-Sampling.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/07-thread-lock/`
- 元信息头（标准环境 + 源文件 + 前置 [09][10][07][12] + 关联 [14] 条件创建线程 + 阅读收益）
