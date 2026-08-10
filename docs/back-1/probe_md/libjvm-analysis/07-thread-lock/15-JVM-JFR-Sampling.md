# 15-JVM-JFR-Sampling — JfrThreadSampler + JfrRecorderThread 的双线程采样-录制分离架构

> **"JFR 采了一整天，为什么应用几乎不受影响？"**
>
> 答案不是"它做了优化"四个字——这等于没说。
> 真正的问题是：采样线程为什么是 NonJavaThread？逐线程挂起为什么不是 STW？采样和录制为什么要分成两条线程？Chunk 轮转为什么需要 safepoint？

---

## 元信息

| 属性 | 值 |
|------|-----|
| **文档编号** | 15-JVM-JFR-Sampling |
| **标准环境** | OpenJDK 11 slowdebug, `-Xms8g -Xmx8g -XX:+UseG1GC`, 64-bit Linux x86 |
| **JFR 启动** | `-XX:StartFlightRecording=dumponexit=true,filename=recording.jfr` 或 `jcmd <pid> JFR.start` |
| **前提条件** | JFR 开启时 JfrThreadSampler + JfrRecorderThread 条件创建；未开启 JFR 则不存在 |
| **前置文档** | [05-JVM-Thread-Lifecycle], [06-JVM-Thread-Architecture], [07-JVM-VMThread], [09-JVM-JavaThread-System], [10-JVM-NonJavaThread], [12-JVM-ServiceThread] |
| **关联文档** | [14-JVM-CompilerThread] 条件创建线程设计 |
| **阅读收益** | 理解 JFR 如何在不可感知的开销下持续采集线程调用栈——非 STW 的逐线程挂起、采样-录制分离的热/冷路径隔离、检查点 safepoint 写入的全局一致性保证 |

---

## §〇 源文件清单

| # | 文件 | 完整路径 | 核心类/函数 | 本文角色 |
|---|------|---------|------------|---------|
| 1 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | `JfrThreadSampler`(L109) 继承 NonJavaThread | ★ 类层次定义 |
| 2 | `jfrThreadSampler.hpp` | `src/hotspot/share/jfr/periodic/sampling/jfrThreadSampler.hpp` | `JfrThreadSampling`(L35) | ★ 采样管理单例 |
| 3 | `jfrThreadSampler.cpp` | `src/hotspot/share/jfr/periodic/sampling/jfrThreadSampler.cpp` | `JfrThreadSampler::run()`(L452), `task_stacktrace()`(L503), `thread_state_in_java()`(L47), `thread_state_in_native()`(L70) | ★★★ 全文核心 |
| 4 | `jfrCallTrace.hpp` | `src/hotspot/share/jfr/periodic/sampling/jfrCallTrace.hpp` | `JfrGetCallTrace`(L34) | ★ 栈帧遍历 |
| 5 | `jfrRecorderThread.hpp` | `src/hotspot/share/jfr/recorder/service/jfrRecorderThread.hpp` | `JfrRecorderThread`(L36): `AllStatic` | ★ 录制线程管理器 |
| 6 | `jfrRecorderThread.cpp` | `src/hotspot/share/jfr/recorder/service/jfrRecorderThread.cpp` | `JfrRecorderThread::start()`(L80), `start_thread()`(L41) | ★ 录制线程创建（Java 层 Thread） |
| 7 | `jfrRecorderThreadLoop.cpp` | `src/hotspot/share/jfr/recorder/service/jfrRecorderThreadLoop.cpp` | `recorderthread_entry()`(L38-95) | ★★ 录制线程消息循环 |
| 8 | `jfrRecorderService.hpp` | `src/hotspot/share/jfr/recorder/service/jfrRecorderService.hpp` | `JfrRecorderService`(L37) | ★ Chunk 轮转引擎 |
| 9 | `jfrRecorderService.cpp` | `src/hotspot/share/jfr/recorder/service/jfrRecorderService.cpp` | `rotate()`(L310), `write()`(L381), `JfrVMOperation`(L200-209) | ★★★ Chunk 轮转三阶段 |
| 10 | `jfrCheckpointManager.hpp` | `src/hotspot/share/jfr/recorder/checkpoint/jfrCheckpointManager.hpp` | `JfrCheckpointManager`(L54) | ★ 检查点状态管理 |
| 11 | `jfrRecorder.hpp` | `src/hotspot/share/jfr/recorder/jfrRecorder.hpp` | `JfrRecorder`(L37) | ★★ 顶层录制器 — `create_thread_sampling()`(L362), `create_recorder_thread()`(L404) |
| 12 | `jfrRecorder.cpp` | `src/hotspot/share/jfr/recorder/jfrRecorder.cpp` | `create()`(L235), `create_components()`(L261) | ★★ JFR 组件创建全链路 |
| 13 | `jfrThreadLocal.hpp` | `src/hotspot/share/jfr/support/jfrThreadLocal.hpp` | `JfrThreadLocal`(L36) | ★★ 每线程 buffer 挂载点 |
| 14 | `jfrBuffer.hpp` | `src/hotspot/share/jfr/recorder/storage/jfrBuffer.hpp` | `JfrBuffer`(L48) | ★ buffer 数据结构 |
| 15 | `jfrOptionSet.hpp` | `src/hotspot/share/jfr/recorder/service/jfrOptionSet.hpp` | `JfrOptionSet`(L38) | JFR 参数配置 |
| 16 | `os.hpp` | `src/hotspot/share/runtime/os.hpp` | `os::SuspendedThreadTask`(L958), `os::SuspendResume`(L993) | ★ OS 线程挂起机制抽象 |
| 17 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | `SR_handler()`(L4918), `do_suspend()`(L5124), `do_resume()`(L5163), `internal_do_task()`(L6186), `sr_notify()`(L5110) | ★★★ Linux SIGUSR2 挂起实现 |
| 18 | `mutexLocker.cpp` | `src/hotspot/share/runtime/mutexLocker.cpp` | `JfrMsg_lock`(L331), `JfrStream_lock`(L333), `JfrThreadSampler_lock`(L335) | ★ JFR 专用锁定义 |

---

## §一 JFR 双线程架构全景 — 采样和录制为什么必须分离？

### ❓ 开启 JFR 后为什么多了两条线程？

```
jstack / pstack 输出:

pstack (NonJavaThread):
  "Unknown thread"                    ★ JfrThreadSampler — 继承 NonJavaThread 非 NamedThread
    → JfrThreadSampler::run()
      → task_stacktrace()
        → OSThreadSampler::take_sample()

jstack (JavaThread):
  "JFR Recorder Thread"               ★ JfrRecorderThread — 通过 JNI 创建 JavaThread
    → recorderthread_entry()
      → JfrRecorderService::rotate() / process_full_buffers()
```

**关键发现**：JfrThreadSampler 在 jstack 中**可能不可见**——因为它继承 `NonJavaThread` 而非 `NamedThread`（`thread.hpp:109`），`name()` 方法返回默认的 `"Unknown thread"`（`thread.hpp:428`）。但它在 `pstack` 中始终可见——`/proc/pid/task/` 不受 JVM 线程分类限制。

---

### 1.1 ★★★ 采样-录制分离的数据流图

```
┌────────────────★★★ 热路径: 采样 (μs 级, NonJavaThread) ────────────────────────┐
│                                                                                 │
│  JfrThreadSampler::run() [jfrThreadSampler.cpp:452]:                            │
│    while (true) {                                                               │
│      os::naked_short_sleep(sleep_to_next);  // 等 (interval - elapsed) ms       │
│                                                                                 │
│      task_stacktrace(JAVA_SAMPLE, &_last_thread_java) [503]:                    │
│        ThreadsListHandle tlh;  // ★ SMR snapshot, 遍历期间 JavaThread 可退出     │
│        MonitorLockerEx(Threads_lock);                                           │
│        for each JavaThread* jt in tlh.list():                                   │
│          if jt->thread_state() != _thread_in_Java → skip (跳过不安全状态)        │
│          if jt->is_hidden_from_external_view() → skip                           │
│          if jt->is_Compiler_thread() → skip                                     │
│                                                                                 │
│          ★ 逐线程挂起 (非 STW!)                                                  │
│          jt->set_trace_flag();                                                  │
│          OSThreadSampler sampler(jt); // 继承 os::SuspendedThreadTask            │
│          sampler.take_sample();         // → run() → internal_do_task()          │
│            ┌─ do_suspend(jt->osthread())                                        │
│            │    → sr.request_suspend() → SR_RUNNING→SR_SUSPEND_REQUEST           │
│            │    → sr_notify() → pthread_kill(tid, SIGUSR2)   ★ 发送信号          │
│            │    → 等待信号处理函数设置 SR_SUSPENDED                               │
│            │                                                                     │
│            ├─ do_task(context)  ★ 现在目标线程已 park                             │
│            │    → protected_task(): 检查 thread_state_in_java()                  │
│            │    → JfrGetCallTrace::get_topframe(ucontext, topframe)              │
│            │    → stacktrace.record_thread(jt, topframe)  ★ 从信号帧读栈          │
│            │    → 创建 EventExecutionSample → 记录 method_id[]                   │
│            │                                                                     │
│            └─ do_resume(jt->osthread())                                         │
│                 → sr.request_wakeup() → SR_SUSPENDED→SR_WAKEUP_REQUEST           │
│                 → sr_notify() → pthread_kill(tid, SIGUSR2)  ★ 唤醒               │
│                 → 等待 SR_handler 退出 sigsuspend → SR_RUNNING                   │
│                                                                                 │
│          ★ 恢复后: 写 stacktrace repository (线程已恢复，可 malloc)               │
│          JfrStackTraceRepository::add(stacktrace);                              │
│                                                                                 │
│          clear_transition_block(jt);                                            │
│        }                                                                        │
│        ★ commit: Event::commit() → JfrStorage 全局 buffer 池                     │
│           (EventExecutionSample 是栈分配的 — 挂起期间不分配堆内存)                 │
│           buffer 满 → full_list → post MSG_FULLBUFFER → notify JfrMsg_lock       │
│        sample_task.commit_events(type);                                         │
│    }                                                                            │
│                                                                                 │
└──────────────────────────────┬──────────────────────────────────────────────────┘
                               │ MSG_FULLBUFFER / MSG_ROTATE / MSG_STOP
                               │ 通过 JfrPostBox → JfrMsg_lock notify
                               ▼
┌────────────────★★★ 冷路径: 录制 (ms 级, JavaThread) ────────────────────────────┐
│                                                                                 │
│  recorderthread_entry() [jfrRecorderThreadLoop.cpp:38]:                         │
│    MutexLockerEx msg_lock(JfrMsg_lock);                                         │
│    while (!done) {                                                              │
│      JfrMsg_lock->wait();  // ★ 阻塞等待消息                                     │
│      msgs = post_box.collect();                                                 │
│      JfrMsg_lock->unlock();  // ★ 释放 Msg_lock 再处理（允许新消息入队）          │
│                                                                                 │
│      PROCESS_FULL_BUFFERS → service.process_full_buffers()                      │
│        → JfrStream_lock → _storage.write_full() → 序列化到 Chunk                 │
│                                                                                 │
│      SCAVENGE → service.scavenge()  // 紧急清扫死 buffer                        │
│                                                                                 │
│      ROTATE → service.rotate(msgs):                                             │
│        ┌─ chunk_rotation():                                                     │
│        │    finalize_current_chunk() → write():                                 │
│        │      ├─ pre_safepoint_write() [JfrStream_lock, 并发]                   │
│        │      │    → 写非 safepoint 类型: stacktrace checkpoint, string pool     │
│        │      │    → _storage.write() — 序列化 JfrStorage 全局 buffer 池内容      │
│        │      │                                                                 │
│        │      ├─ ★ invoke_safepoint_write() → JfrVMOperation                    │
│        │      │    → VMThread::execute(&safepoint_task)                         │
│        │      │    → ★ STW safepoint: safepoint_write()                         │
│        │      │       → _checkpoint_manager.write_safepoint_types()             │
│        │      │          (class names, method signatures, field types)          │
│        │      │       → _checkpoint_manager.shift_epoch()                       │
│        │      │                                                                 │
│        │      └─ post_safepoint_write() [JfrStream_lock, 并发]                  │
│        │           → write_type_set(), write metadata event, close chunk        │
│        │                                                                        │
│        └─ open_new_chunk()  ★ 创建新 Chunk → 下一轮写入开始                      │
│                                                                                 │
│      START → service.start() → clear() + open_new_chunk()                      │
│                                                                                 │
│      JfrMsg_lock->lock();  // 重新获取 → 下一轮 wait                             │
│    }                                                                            │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

### 1.2 JfrThreadSampler: 为什么必须是 NonJavaThread？— 三重论证

**第一重：不能挂起自己**

采样需要挂起目标线程来读栈帧。如果 JfrThreadSampler 是 JavaThread：
- `do_suspend()` → `pthread_kill(tid, SIGUSR2)` → 发给自己 → SR_handler 在自己栈上执行
- SR_handler 进入 `sigsuspend()` → 自己挂起 → 无人唤醒 → **死锁**

NonJavaThread 不受 SIGUSR2 挂起（见下文第三重），永远不会挂起自己。

**第二重：不受 safepoint 阻塞**

JfrThreadSampler 在 `task_stacktrace()` 中先 `MonitorLockerEx(Threads_lock)` 再创建 `ThreadsListHandle` 快照（`jfrThreadSampler.cpp:322-323`）。如果 JfrThreadSampler 是 JavaThread：
- GC 发起 safepoint → JfrThreadSampler 必须响应 → 释放 `Threads_lock` 并 park
- 其他线程在 safepoint 期间可能修改 thread list → `ThreadsListHandle` 持有的快照变成**过期快照**（指针可能指向被移除的线程，该线程在 safepoint 中被 `smr_delete` 但未释放？不——SMR 保证不释放，但线程的 `thread_state()` 可能在 safepoint 中被 GC 修改）
- 更根本的问题：`Threads_lock` 是保护 thread list 的互斥锁。safepoint 协议要求 JavaThread 释放关键锁后进入安全点。如果 JfrThreadSampler 在持锁时必须响应 safepoint → **锁持有的所有数据（ThreadsList 遍历进度、_cur_index）在 safepoint 回来后已无效**

NonJavaThread **不参与 safepoint**——`NonJavaThread::is_Java_thread()` 返回 `false`——不受 safepoint 阻塞，持 `Threads_lock` 遍历的整个过程不会被中断，快照始终有效。

**第三重：不响应 SIGUSR2 信号**

SR_handler（`os_linux.cpp:4918`）的线程检查逻辑：

```cpp
// os_linux.cpp:4934
assert(thread->is_VM_thread() || thread->is_Java_thread(), 
       "Must be VMThread or JavaThread");
```

SR_handler **只处理 VMThread 和 JavaThread**。如果 NonJavaThread 收到 SIGUSR2 → assert 失败。但关键是：**采样线程从不对自己发 SIGUSR2**——它只对遍历到的 JavaThread 发 `pthread_kill`。NonJavaThread 的"旁观者"身份是设计上的完美隔离。

---

### 1.3 JfrRecorderThread: 为什么必须是 JavaThread？

JfrRecorderThread 通过 JNI 从 Java 层创建（`jfrRecorderThread.cpp:80-117`）：

```cpp
// jfrRecorderThread.cpp:85-87
static const char klass[] = "jdk/jfr/internal/JVMUpcalls";
static const char method[] = "createRecorderThread";
// → Java 层创建 j.l.Thread 对象 → 再创建 JavaThread
```

**三道递进论证**：

**第一重（最核心）：safepoint 协调 — 必须提交 JfrVMOperation 触发 STW**

Chunk 轮转需要调用 `VMThread::execute(&safepoint_task)`（`jfrRecorderService.cpp:433`）触发全局 safepoint。`VMThread::execute()` 内部的 safepoint 协议要求：**所有 JavaThread 必须到达安全点**才能开始 STW。如果 JfrRecorderThread 是 NonJavaThread：
- 它提交 VMOperation 后继续运行（NonJavaThread 不响应 safepoint）
- 其他 JavaThread 停在安全点等 JfrRecorderThread 释放 `JfrStream_lock`
- 但 JfrRecorderThread 持有 `JfrStream_lock` 完成 `pre_safepoint_write()` 后才释放
- **死锁**。（或者走 `_no_safepoint` 模式提交 VMOperation → 不保证全局一致性 → 检查点数据不可靠）

作为 JavaThread：`VMThread::execute()` 期间 JfrRecorderThread 会进入 `_thread_blocked`（等待 VMOperation 完成）——这是标准 safepoint 协议的一部分。

**第二重：JfrRecorderThread 创建路径天然是 JavaThread**

`jfrRecorderThread.cpp:41-68`，`start_thread()` 通过 `new JavaThread(proc)` 创建。这是 Java 层 `jdk.jfr.internal.JVMUpcalls.createRecorderThread()` 的产物——Java 层 Thread 对象需要 OS 层的 JavaThread 作为镜像。改成 NonJavaThread 需要重写整个 JNI 创建路径。

**第三重：可以在 JfrMsg_lock->wait() 中安全参与 safepoint**

wait 期间线程处于 `_thread_in_vm` → 参与 safepoint → 不阻塞 GC。如果改成 NonJavaThread → wait 期间 GC 发起 safepoint → safepoint 等待 NonJavaThread 完成但它在 wait 上阻塞 → 潜在死锁（取决于锁 rank：`JfrMsg_lock` 是 leaf 级别，GC 可能持有更高 rank 的锁）。

**但栈不是 4MB**：不像 CompilerThread 需要深度递归编译复杂方法。JfrRecorderThread 的调用深度很浅（消息循环 → 序列化 → IO），使用默认栈大小（1MB）。

---

### 1.4 ★ 为什么 JFR 不走 ServiceThread？— 独立消息循环的工程决策

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     JFR 线程 vs ServiceThread                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ServiceThread [12] 处理:                                                │
│    StringTable::do_concurrent_work()     ~1-5ms    纯 C++               │
│    JvmtiDeferredEvent::post()            ~0.1-10ms JNI→agent            │
│    LowMemoryDetector::process_sensors()  ~0.1-1ms  JMX 通知             │
│    GCNotifier::sendNotification()        ~0.1-1ms  JMX 通知             │
│    DCmdFactory::send_notification()      ~0.1-1ms  JMX 通知             │
│                                                                         │
│  JfrRecorderThread 处理:                                                 │
│    PROCESS_FULL_BUFFERS                  10-100ms  磁盘 IO → JfrStream   │
│    SCAVENGE                              5-50ms    紧急清扫              │
│    START                                 1-5ms     初始化 Chunk          │
│    ★ ROTATE (含 safepoint)               50-500ms  三阶段+STW           │
│                                                                         │
│  ★ 如果 ROTATE 放在 ServiceThread:                                       │
│    → ServiceThread 处理 ROTATE (500ms) 时                                │
│    → 所有 JVMTI 事件阻塞 500ms                                           │
│    → JVMTI agent 超时 → agent 崩溃                                       │
│    → StringTable 不清理 → 内存泄漏                                       │
│                                                                         │
│  ★ 独立 JfrRecorderThread:                                               │
│    → 只有 JFR 自己的事件受影响                                            │
│    → ServiceThread 的 5 个子系统照常运转                                  │
│    → 这是「专用线程 > 多路复用」的经典工程决策                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## §二 ★★★ JfrThreadSampler — 采样循环逐行走读

### ❓ 如何在 N 条线程中，每个线程只停 ~10-50μs 就完成栈帧采集？

### 2.1 ★ 主循环的三个核心设计问题

主循环位于 `jfrThreadSampler.cpp:452-500`。不逐行翻译，只讲三个设计决策及其背后的"为什么"。

---

**设计 1：enroll/disenroll 协议 — 为什么用 Semaphore 而不是 bool flag？**

JFR 可以在运行时动态启停。当用户执行 `jcmd JFR.stop` → 采样线程需要立即停止遍历。一个简单的 `volatile bool _active` 不够——因为：

- 如果在 `task_stacktrace()` 中间（已经挂起了某个目标线程）收到 stop → 必须先 `do_resume()` 再退出，否则被挂起的线程永远不恢复
- `disenroll()` 调用 `_sample.wait()` 会**阻塞到采样线程回到循环顶部并完成一次 `_sample.trywait()`**——这保证了采样线程不在"挂起中"状态时才能停止
- `enroll()` 调用 `_sample.signal()` 唤醒阻塞的采样线程——重新开始采样

核心语义：Semaphore 的 `wait`/`signal` 在这里充当的是**同步点**而非计数信号量——disenroll 等待"循环顶部"，enroll 通知"可以开始"。

---

**设计 2：双间隔时间公式 — 为什么用 `next_j - sleep_to_next <= 0`？**

Java 采样间隔和 native 采样间隔独立。每轮循环需要计算"下次该采哪个"。直接写法：

```
now = time();
if (now >= last + interval) { sample(); }
```

问题：如果 native 采样先到期，sleep 了 8ms, 醒来时 Java 采样也已经过期——但上面的简单逻辑只会触发 native，Java 被饿死。

实际公式：`next_j = interval + (last_ms - now_ms)`，表示"距离下次 Java 采样还剩多少毫秒"（可能为负，表示已过期）。然后 `MIN2(next_j, next_n)` 取最近的 sleep 时间。醒来后 `next_j - sleep_to_next <= 0` 判断——Java 即使`next_j`为负（已过期），减去 sleep 后还是 ≤0 → 触发采样。**本质是"距离到期时间"而非"当前时间是否超过截止时间"**。

---

**设计 3：`os::naked_short_sleep()` — 为什么不用带 safepoint 检查的 sleep？**

JfrThreadSampler 是 NonJavaThread → 不参与 safepoint → `os::sleep()` 中多余的 safepoint poll 是浪费。`naked_short_sleep()` 直接调用 `os::naked_sleep(ms)` → 纯粹的 `nanosleep()` 或 `pthread_cond_timedwait()` → 零额外开销。采样线程的全部逻辑都在"尽快 sleeping 或尽快 sampling"，不碰任何可能触发 safepoint 的东西。

---

### 2.2 ★★ task_stacktrace() — 采样一次的主逻辑

```cpp
// jfrThreadSampler.cpp:503-548 — 实际源码（关键路径提取）
void JfrThreadSampler::task_stacktrace(JfrSampleType type, JavaThread** last_thread) {
  ResourceMark rm;
  EventExecutionSample samples[MAX_NR_OF_JAVA_SAMPLES];   // 最多 5 个 Java 采样
  EventNativeMethodSample samples_native[MAX_NR_OF_NATIVE_SAMPLES]; // 最多 1 个 native
  JfrThreadSampleClosure sample_task(samples, samples_native);

  const uint sample_limit = JAVA_SAMPLE == type ? MAX_NR_OF_JAVA_SAMPLES : MAX_NR_OF_NATIVE_SAMPLES;
  uint num_samples = 0;
  JavaThread* start = NULL;

  {
    MonitorLockerEx tlock(Threads_lock, Mutex::_allow_vm_block_flag);
    ThreadsListHandle tlh;  // ★ SMR 安全快照

    // ★ 从上次采样的线程位置继续（平衡器: 避免每次都从 index 0 开始）
    _cur_index = tlh.list()->find_index_of_JavaThread(*last_thread);
    JavaThread* current = _cur_index != -1 ? *last_thread : NULL;

    while (num_samples < sample_limit) {
      current = next_thread(tlh.list(), start, current);
      if (current == NULL) break;  // 遍历一圈回到起点
      if (start == NULL) start = current;  // 记录起点

      if (current->is_Compiler_thread()) continue;  // 跳过编译线程
      if (sample_task.do_sample_thread(current, _frames, _max_frames, type)) {
        num_samples++;
      }
    }
    *last_thread = current;  // ★ 保存位置供下次从这继续
  }
  if (num_samples > 0) {
    sample_task.commit_events(type);  // ★ commit → JfrStorage 全局池
  }
}
```

**关键设计**：

1. **每次只采最多 5 个 Java 线程 + 1 个 native 线程**——不是遍历所有线程！这保证了每次采样的耗时上限。**为什么是 5？** 单线程挂起→读栈→恢复 ~50μs。如果遍历所有 100 线程 → 5ms → 占 10ms 采样间隔的 50% → 采样开销过大（5% CPU）。5 线程 → 250μs → 占 2.5% → 可接受。5 是从"覆盖概率"和"开销上限"之间 trade-off 的结果。

2. **`_cur_index` 和 `*last_thread` 实现了 round-robin**：`next_thread()` 从上次位置继续遍历，到达列表尾后 wrap 回 0——所有线程有均等的采样机会。**覆盖保证**：对 100 线程，`100/5=20` 个采样周期 ≈ `20×10ms=200ms` 内所有线程被采一次。

3. **跳过 CompilerThread**（`jfrThreadSampler.cpp:532`）：不是因为"没什么可采的"。C2 编译线程的栈帧可能数百层（深度内联后的复杂方法），遍历栈帧成本远高于普通线程 → 采样延迟不可预测。更重要的是，CompilerThread 持有 `Compile_lock`（JIT 编译中）→ 挂起它 → 其他等待 CodeCache 的线程被阻塞 → **编译吞吐量下降**。且编译器代码的执行热点对用户无意义——JFR 关心的是用户代码的热点。

4. **`ThreadsListHandle` 提供 SMR 安全**：遍历期间 JavaThread 可能退出但不会被释放（见 §2.6）。

---

### 2.3 ★ do_sample_thread() — 状态安全检查的设计哲学

核心代码在 `jfrThreadSampler.cpp:354-377`。**不是逐行解释 if-else，而是追问：为什么 check-filter-sample 是这三步？**

**Step 1 — 身份过滤**：`is_hidden_from_external_view()` 和 `in_deopt_handler()`

- Hidden 线程（ServiceThread、ReferenceHandler 等）是 JVM 内部实现细节 → 采样它们的栈帧对用户无意义
- Deopt handler 中的线程正在重写栈帧 → 采样读到半成品帧 = crash

**Step 2 — `set_trace_flag()` + 内存屏障**

这是防 TOCTOU 的关键一步。`set_trace_flag()` 在挂起之前执行——即使目标线程此刻还没收到 SIGUSR2，它也被禁止做状态转换（见 §2.5 的两方协议）。`os::serialize_thread_states()` 确保 trace_flag 对目标线程可见。

**Step 3 — 状态白名单检查**

不是"检查哪些状态不安全"，而是**只认两个安全状态**：
- Java 采样：只认 `_thread_in_Java`（其他 10+ 个状态全部拒绝）
- Native 采样：只认 `_thread_in_native`

这是一个**白名单策略**。白名单的优势：新增一个线程状态（如`_thread_in_handshake`）不会自动变成"可采样"——必须显式加入白名单。黑名单的致命问题是：加了一个新状态忘记加到黑名单 → 采样线程挂起不该挂的状态 → 死锁。白名单更安全。

---

### 2.4 ★★ 线程状态白名单 — 为什么只认这两个状态？

源码在 `jfrThreadSampler.cpp:47-91`。不贴 switch-case，只讲分类逻辑：

**Java 采样白名单 `_thread_in_Java`：**
- 唯一安全状态。线程在解释器或 JIT 代码中执行 → 栈帧完整（RBP chain 可遍历）→ Java 栈帧中的 `Method*` 有效
- SIGUSR2 到达时线程正在执行 Java 代码 → 不会持有 JVM 内部锁 → 可以安全 park

**Native 采样白名单 `_thread_in_native`：**
- 线程在 JNI / native 库中 → 信号可以安全投递（async-signal-safe context）
- 不需要挂起——native 采样直接读 `last_frame()`（`jfrThreadSampler.cpp:226-230`），不触发 `do_suspend`
- `last_frame()` 是线程从 Java 进入 native 前保存的最后一帧——是**快照**而非实时数据

**所有其他状态被拒绝的原因**：

| 拒绝原因 | 涉及状态 |
|---------|---------|
| **在 safepoint 中** | `_thread_in_vm` — 挂起它 GC 永不完成 |
| **在状态转换中** | `_thread_*_trans` — 不稳定，可能持有临时锁 |
| **未完全初始化** | `_thread_new`, `_thread_uninitialized` — 无有效栈 |
| **阻塞中无执行** | `_thread_blocked` — 在等锁/IO，采样意义不大 |
| **类型不匹配** | Java 采样拒绝 `_thread_in_native`，Native 采样拒绝 `_thread_in_Java` |

最关键的一条：**`_thread_in_vm` 是绝对禁区**。挂起它 → 该线程正参与 GC safepoint → safepoint 协议被打断 → GC 永不完成 → JVM 卡死。不是"性能下降"——是**死锁**。

---

### 2.5 ★ os::SuspendedThreadTask — pthread_kill(SIGUSR2) 的 OS 层机制

```
挂起协议 (os_linux.cpp):

  do_suspend(osthread) [5124]:
    1. sr.request_suspend():  SR_RUNNING → SR_SUSPEND_REQUEST  (CAS)
    2. sr_notify(osthread):   pthread_kill(tid, SR_signum=SIGUSR2)  ★ 发送信号
    3. sr_semaphore.timedwait(2ms):  等待信号处理函数完成挂起
       → 收到 sr_semaphore.signal() → 确认 SR_SUSPENDED

  ★ 目标线程的信号处理函数 SR_handler() [4918]:
    → 检查 current == SR_SUSPEND_REQUEST
    → suspend_save_context(osthread, siginfo, ucontext)  // 保存 CPU 寄存器
    → osthread->sr.suspended():  SR_SUSPEND_REQUEST → SR_SUSPENDED
    → sr_semaphore.signal()  ★ 通知采样线程: 我已挂起
    → sigsuspend(&suspend_set):  ★★ 阻塞在此，等待 SR_signum 唤醒

  ★ 采样线程读栈帧: protected_task() [173]:
    → 检查 thread_state_in_java() (再次确认状态)
    → JfrGetCallTrace::get_topframe(ucontext, topframe)
       → 从 ucontext 中恢复 PC/SP/FP → frame walker 遍历栈帧

  do_resume(osthread) [5163]:
    1. sr.request_wakeup():  SR_SUSPENDED → SR_WAKEUP_REQUEST
    2. sr_notify(osthread):  pthread_kill(tid, SIGUSR2)  ★ 再发信号唤醒
    3. 等待 sigsuspend 中的线程收到信号 → 检查 result == SR_RUNNING → 退出
       → sr_semaphore.signal()  ★ 通知: 我已恢复
```

**★ 为什么是 SIGUSR2 而不是 SIGSTOP？**

| | SIGSTOP | SIGUSR2 (实际) |
|---|---|---|
| **粒度** | 进程级 → 整个进程停 | 线程级 → 只停一个 (`pthread_kill`) |
| **信号处理器** | 不能自定义 | `SA_SIGINFO` → 获取 `ucontext_t`（CPU 状态） |
| **采样可行性** | 采样线程也停了 → 无法读栈 | 只发目标线程 → 采样线程可自由读栈 |
| **上下文** | 无 | 三参数形式获取 `siginfo_t*` + `ucontext_t*` |

---

**★★ 采样期间 crash 不拖垮 JVM — `os::ThreadCrashProtection` 隔离墙**

`OSThreadSampler::protected_task()`（`jfrThreadSampler.cpp:169-195`）顶部有一条全文第二重要的注释：

```cpp
/* From this method and down the call tree we attempt to protect against crashes
 * using a signal handler / __try block. Don't take locks, rely on destructors or
 * leave memory (in case of signal / exception) in an inconsistent state. */
```

这意味着：**采样线程在目标线程已挂起的状态下，在目标线程的栈上执行栈帧遍历**。如果遍历过程中遇到损坏的栈帧（如 `Method*` 指向已被卸载的类 → SIGSEGV）→ **采样线程 crash**。但 JVM 其他部分不能 crash——所以需要 crash protection。

`do_task()`（`jfrThreadSampler.cpp:151-167`）的隔离机制：

```cpp
void OSThreadSampler::do_task(const os::SuspendedThreadTaskContext& context) {
  if (JfrOptionSet::sample_protection()) {  // ★ 默认开启
    OSThreadSamplerCallback cb(*this, context);
    os::ThreadCrashProtection crash_protection;
    if (!crash_protection.call(cb)) {       // ★ sigsetjmp/siglongjmp 包裹
      log_error(jfr)("Thread method sampler crashed"); // ★ 捕获 crash，打日志
    }
  } else {
    protected_task(context);  // ★ debug build 跳过保护，暴露 bug
  }
}
```

**设计约束**（从注释推导）：
1. `protected_task()` 内**不能加锁**——crash 后 siglongjmp 跳过析构 → 锁永不释放 → 死锁
2. `protected_task()` 内**不能依赖 RAII**——crash 后析构函数不被调用
3. `protected_task()` 内**不能在堆上分配需要 free 的内存**——crash 后没有清理机会

这也是为什么 `EventExecutionSample` 是**栈分配的**（`jfrThreadSampler.cpp:505`）：`EventExecutionSample samples[MAX_NR_OF_JAVA_SAMPLES]`——crash 后栈回滚，没有内存泄漏。

★ 这个隔离墙是"JFR crash ≠ JVM crash"的终极保证。

---

**★ 为什么需要 `set_trace_flag()` / `clear_transition_block()`？— 两方协议防 TOCTOU**

协议有两方：采样线程（主动方）和目标 JavaThread（被动方）。

**主动方 — 采样线程**（`do_sample_thread()`, `jfrThreadSampler.cpp:361-382`）：

```
Step 1: thread->set_trace_flag()     ★ 设置 _suspend_flags |= _trace_flag
Step 2: os::serialize_thread_states() ★ 内存屏障，确保看到稳定的 thread_state()
Step 3: if thread_state_in_java() → sample_thread_in_java()
Step 4: clear_transition_block(thread) ★ 清除 _trace_flag + notify transition_block()
```

**被动方 — 目标 JavaThread**（`on_javathread_suspend()`, `jfrThreadSampler.cpp:396-406`）：

```cpp
// ★ 目标线程尝试状态转换时被拦截
void JfrThreadSampler::on_javathread_suspend(JavaThread* thread) {
  JfrThreadLocal* const tl = thread->jfr_thread_local();
  tl->set_trace_block();    // ★ 标记"正在被 trace"
  {
    MutexLockerEx ml(transition_block(), Mutex::_no_safepoint_check_flag);
    while (thread->is_trace_suspend()) {  // ★ 等待采样线程完成
      transition_block()->wait(true);
    }
    tl->clear_trace_block();
  }
}
```

**完整的两方交互时序**：

```
┌─ 采样线程 ────────────────────┐   ┌─ 目标线程 ────────────────────────┐
│                               │   │                                  │
│ T0: set_trace_flag()          │   │ 正在执行 _thread_in_Java           │
│     (设置 _trace_flag)        │   │                                  │
│                               │   │                                  │
│ T1: serialize_thread_states() │   │ T1': 尝试 _thread_in_Java         │
│     读取 thread_state()       │   │   → _thread_blocked              │
│     == _thread_in_Java ✓      │   │   → check_safepoint_and_suspend  │
│                               │   │   → 检测到 _trace_flag!          │
│                               │   │   → on_javathread_suspend()      │
│                               │   │   → set_trace_block()            │
│                               │   │   → transition_block()->wait()   │
│                               │   │      ★ 被阻塞，停止状态转换        │
│                               │   │                                  │
│ T2: pthread_kill(SIGUSR2)     │   │ SR_handler → sigsuspend() ★ park │
│     do_task → 读栈帧          │   │                                  │
│                               │   │                                  │
│ T3: do_resume → SIGUSR2唤醒   │   │ sigsuspend 返回 → SR_RUNNING     │
│                               │   │                                  │
│ T4: clear_transition_block()  │   │ 清除 _trace_flag                 │
│     → notify transition_block │   │ → transition_block()->wait 返回  │
│                               │   │ → clear_trace_block()            │
│                               │   │ → 继续状态转换                   │
└───────────────────────────────┘   └──────────────────────────────────┘

★ T1' 是竞态窗口: 采样线程读了 state()=java → 目标线程即将转换
   但 _trace_flag 在 T0 已设置 → T1' 被拦截 → 目标线程的栈在采样期间不变
```

**如果没有 trace_flag 协议会怎样？** TOCTOU：采样线程读到 `_thread_in_Java` → 发送 SIGUSR2 → 目标线程恰在此时转换到 `_thread_blocked` → `protected_task()` 中二次检查 `thread_state_in_java()` 失败（`jfrThreadSampler.cpp:176`）→ 采样失败。但更严重的场景是 `_thread_in_Java → _thread_in_native` 转换——此时线程已经在 native 代码中但采样线程按 Java 栈帧解析 → **读到垃圾数据**。trace_flag 在 T0 设置，整个 T0-T4 窗口中目标线程的状态转换被拦截。

---

### 2.6 ★★ ThreadsListHandle SMR 并发安全 — 遍历期间线程退出了怎么办？

```
场景: JfrThreadSampler 正在遍历 ThreadsList，遍历到线程 T
      → 此时 T 执行完毕，退出
      → T 的 JavaThread 对象怎么办？采样线程手上的指针还安全吗？

★ ThreadsListHandle (SMR = Safe Memory Reclamation):

  1. JfrThreadSampler 创建 ThreadsListHandle tlh:
     → ThreadsListHandle() 构造:
       → 获取当前 _java_thread_list 的快照 (ThreadsList* 指针)
       → 发布 hazard pointer: current_thread->set_threads_hazard_ptr(list)

  2. 线程 T 退出:
     → JavaThread::exit() → ThreadsSMRSupport::smr_delete(this)
     → smr_delete() 不是立即 delete!
     → 检查所有线程的 hazard pointer → 如果还有线程持有包含 T 的 ThreadsList
       → 将 T 加入 _to_be_deleted 延迟释放链表
     → 等所有 hazard pointer 持有者释放后才真正 delete

  3. JfrThreadSampler 完成遍历:
     → tlh 析构 → clear hazard pointer
     → smr_delete() 检测到不再有持有者 → delete T

  ★ 结论: 遍历期间 JavaThread 对象永远不会被释放
    代价: smr_delete 有延迟，已退出线程的 JavaThread 对象可能暂留内存 ~ms
```

`ThreadsListHandle` 的定义在 `src/hotspot/share/runtime/threadSMR.hpp` 中，其核心是 Hazard Pointer 机制。已在 [06-JVM-Thread-Architecture] §4.3 详细分析过。

---

### 2.7 采样间隔的动态调整

```
配置: interval_java (默认 10ms), interval_native (默认 10ms)

★ JFR 参数名:
  -XX:FlightRecorderOptions:threadsamplingperiod=<ms>  (Java 线程采样间隔)
  -XX:FlightRecorderOptions:samplinginterval=<ms>      (native 线程采样间隔)
  也可在 jcmd JFR.start 中设置, 如:
    jcmd <pid> JFR.start settings=profile
    (profile 模板默认 threadsamplingperiod=10ms)

JfrThreadSampler 字段 [jfrThreadSampler.cpp:319-320]:
  size_t _interval_java;    // Java 线程采样间隔 (ms)
  size_t _interval_native;  // native 线程采样间隔 (ms)

调整 API:
  JfrThreadSampling::set_java_sample_interval(period) → set_sampling_interval(true, period)
    → _sampler->set_java_interval(interval)
    → _sampler->enroll()  // 唤醒采样线程

为什么 Java 和 native 分开?
  → Java 线程采样: 需要 SIGUSR2 挂起 → ~10-50μs → 10ms 间隔 → 0.1%-0.5% CPU
  → native 线程采样: 不需要挂起 → 直接 read last_frame → ~1-5μs → 10ms 间隔 → 可忽略

为什么默认 10ms 不是 1ms?
  → 1ms 间隔 → 每个线程每秒被挂起 1000 次 × 10-50μs = 1%-5% CPU 开销
  → 对延迟敏感的金融交易系统不可接受
  → 10ms = 每秒 100 次 × 10-50μs = 0.1%-0.5% → 可接受
  → 统计学上: 大数定律保证 10ms 间隔足够产生可靠的热点分析

---

### 2.8 ★ [sidebar] 分配采样 vs 线程采样 — 为什么分配采样不用独立线程？

```
JFR 有两种完全不同的采样子系统:

  ┌──────────────────────────────────────────────────────────────────────┐
  │ ❶ 线程采样 (ExecutionSample) — 本文重点                              │
  │                                                                      │
  │   触发者: JfrThreadSampler (NonJavaThread, 独立线程)                  │
  │   频率:   默认每 10ms 一次 (每个采样周期最多采 5 个线程)               │
  │   方法:   SIGUSR2 挂起 → 读栈帧 → 记录 method_id[]                    │
  │   数据:   "时刻 T, 线程 X 在执行 method_id[]"                          │
  │   用途:   火焰图、CPU 热点分析                                         │
  │                                                                      │
  ├──────────────────────────────────────────────────────────────────────┤
  │ ❷ 分配采样 (ObjectAllocationSample) — 不创建独立线程!                 │
  │                                                                      │
  │   触发者: 应用线程自己 (self-sampling)                                │
  │   频率:   每分配 TLAB_SIZE / ObjectAllocationSampleWeight 字节一次     │
  │   方法:   应用线程在分配新 TLAB 时检查计数器 → 记录当前调用栈           │
  │   数据:   "线程 X 在 method_id[] 上下文中分配了 Y 个对象"              │
  │   用途:   内存分配热点分析                                             │
  │                                                                      │
  │   ★ 为什么不用独立线程?                                                │
  │     → 分配频率太高 (10⁶~10⁹ 次/秒)                                    │
  │     → 独立采样线程无法实时感知每次分配                                  │
  │     → 改为在「分配热路径」上做 light-weight 采样                       │
  │     → 计数器在 TLAB 中 → 不需要跨线程同步                              │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## §三 ★★ JfrRecorderThread — 消息循环 + Chunk 轮转

### ❓ 录制线程等待的 4 种消息分别做什么？

### 3.1 ★ 消息循环的四个设计问题

源码在 `jfrRecorderThreadLoop.cpp:38-95`。不逐行翻译。讲四个设计决策。

---

**决策 1：为什么是 bitset 消息，不是消息队列？**

JFR RecorderThread 等待的是 4 种独立消息：`MSG_FULLBUFFER`、`MSG_DEADBUFFER`、`MSG_ROTATE`、`MSG_START`。这些消息可能**同时到达**（例如 buffer 满了的同时用户请求了 dump → MSG_FULLBUFFER + MSG_ROTATE 同时在 post_box 中）。

如果使用 FIFO 队列 → 先处理 FULLBUFFER（序列化到旧 Chunk），再处理 ROTATE（关闭旧 Chunk 并创建新 Chunk）→ 逻辑通但多了两次 Chunk 切换。

如果使用 bitset → `post_box.collect()` 返回**合并后的位掩码**（`jfrRecorderThreadLoop.cpp:43-44` 的宏定义就在做 bitset 合并）：

```cpp
#define ROTATE  (msgs & (MSGBIT(MSG_ROTATE)|MSGBIT(MSG_STOP)))
#define PROCESS_FULL_BUFFERS (msgs & (MSGBIT(MSG_ROTATE)|MSGBIT(MSG_STOP)|MSGBIT(MSG_FULLBUFFER)))
```

bitset 的语义是"迄今为止需要处理的所有事情"→ PROCESS_FULL_BUFFERS 包含了 ROTATE 需要的操作 → 处理和合并可以一次完成。ROTATE 内部自有 RotationLock 防止并发。

---

**决策 2：为什么 `JfrMsg_lock->unlock()` 后才处理消息？**

如果持锁处理 `PROCESS_FULL_BUFFERS` → 期间新的 buffer 满了 → 生产者尝试 `JfrMsg_lock->lock()` → 被阻塞 → 全局 JFR buffer 池的可用 buffer 数量减少 → 事件写入失败 → data loss。

释放锁后处理 → 新满的 buffer 可以入队 → 下一次 wait 醒来时一起处理。代价是"处理期间到达的消息会被延迟到下一轮"——但消息处理本身可能耗 100ms → 延迟不可避免。

---

**决策 3：消息优先级 — 为什么先 PROCESS_FULL_BUFFERS 后 ROTATE？**

处理顺序：`PROCESS_FULL_BUFFERS → SCAVENGE → evaluate_chunk_size → ROTATE → START`。

- **SCAVENGE 第二**：清扫 dead buffer 可以回收内存 → 释放 buffer 给 `process_full_buffers` 后续的重分配使用
- **ROTATE 在 FULL_BUFFERS 之后**：先把已经满的 buffer 数据写到当前 Chunk → 再执行 Chunk 轮转 → 旧 Chunk 包含完整数据
- **START 在最后**：如果同时收到 START + ROTATE → ROTATE 包含了关闭逻辑 → START 重置状态 → 新录制开始

---

**决策 4：`JfrRecorderService` 是 StackObj — 为什么每次循环重建而非复用？**

`service` 对象持有 `_chunkwriter`、`_storage` 等句柄——这些是全局单例的引用，重建成本为 0。但重建保证了：**每次进入消息处理时，看到的都是最新的全局状态**。如果复用——ROTATE 之后 `_chunkwriter` 已经 close → 下一次 PROCESS_FULL_BUFFERS 时 `_chunkwriter.is_valid()` 已经反映新 Chunk 状态 → 但 `_storage` 的引用也可能过期 → 用 StackObj 每次重建避免了"对象生命周期和全局状态同步"的 bug。

---

### 3.2 ★ PROCESS_FULL_BUFFERS — 消费满 buffer

```cpp
// jfrRecorderService.cpp:520-526
void JfrRecorderService::process_full_buffers() {
  if (_chunkwriter.is_valid()) {
    MutexLockerEx stream_lock(JfrStream_lock, Mutex::_no_safepoint_check_flag);
    _storage.write_full();  // ★ 将 full buffer 链表的内容序列化到当前 Chunk
  }
}
```

**★ 数据流纠正 — 采样线程不写目标线程的 buffer**：

```
采样线程: commit_events() [jfrThreadSampler.cpp:288]
  → _events[i].commit() → Event::commit()
  → 序列化到 JfrStorage 管理的全局 buffer 池 (不是目标线程的 buffer!)
  → JfrStorage 使用两级架构:
      ┌─ Thread-local cache: 每个线程从全局池租赁 buffer，lease 后独占写入
      │   (JfrThreadSampler 作为 NonJavaThread，也有自己的 thread-local 缓存)
      └─ Global list: buffer 满后归还到 full_list → post MSG_FULLBUFFER
  → JfrBuffer::acquire()/release() 用 CAS _identity 字段避免全局锁

录制线程: 被唤醒
  → process_full_buffers()
  → JfrStream_lock → _storage.write_full()
  → 遍历 full_buffer_list → 读 buffer 内容 → 序列化到 Chunk 文件
  → buffer 归还到空闲池 (reinitialize → 重新租赁)
```

**★ JfrStorage 的两级 buffer 架构（为什么不需要全局锁）**：

`JfrBuffer`（`jfrBuffer.hpp:48-168`）的核心设计：
- `_identity`（CAS 字段）：记录当前 holder，`try_acquire(id)` 用 CAS 设置 `NULL→id`
- `_pos`：写入位置（只有 holder 可写）
- `_top`：未 flush 位置（`volatile`，可能被其他线程并发读取以 flush）

**两级架构**：
1. **Thread-local 缓存**：每个线程从全局池租赁一个 buffer（CAS `acquire()`）→ 独占写入（只需更新 `_pos`，无锁）→ buffer 满时 `release()` 归还到 full_list
2. **Full list → RecorderThread**：JfrRecorderThread 获取 `JfrStream_lock` → 遍历 full_list → `_storage.write_full()` → 序列化 → `reinitialize()` 归还

**为什么这样设计？** 写入（热路径）是 CAS 获取 buffer 后独占写入 = 只有一条 CAS 指令的开销。消费（冷路径）在 `JfrStream_lock` 保护下进行，频率低（分钟级）→ 锁竞争可忽略

---
### 3.3 ★★ ROTATE — Chunk 轮转的三阶段设计

轮转入口在 `jfrRecorderService.cpp:310-330`（`rotate()`）。核心流程：`finalize_current_chunk()`（三阶段写入）→ `open_new_chunk()`。

**三阶段的"为什么分开"而非"写了什么"**：

```
write():
  pre_safepoint_write()    ← 可以并发的，先做
  invoke_safepoint_write() ← 必须 STW 的，提交 VMThread
  post_safepoint_write()   ← safepoint 后还能做的，继续并发
```

**阶段 1 — `pre_safepoint_write()`：持 `JfrStream_lock` 做并发写入**

这一步写的是**线程安全的数据**：StackTrace repository（内部有锁）、StringPool（内部 CAS）、Storage 全局 buffer（`JfrStream_lock` 保护）。这些数据结构可以一边被应用线程写、一边被 RecorderThread 读——不影响一致性。

**阶段 2 — `invoke_safepoint_write()`：提交 JfrVMOperation 到 VMThread**

`JfrVMOperation` (定义在 `jfrRecorderService.cpp:200-209`，类型 `VMOp_JFRCheckpoint`，mode `_safepoint`) 是 JFR 和 VMThread 的**唯一交互点**。`VMThread::execute(&task)` 触发全局 STW → VMThread 在 safepoint 中执行 `safepoint_write()`：

```
safepoint_write() 核心:
  write_safepoint_types()  ← 类名、方法签名、字段类型（从 Metaspace 读）
  write_at_safepoint()     ← safepoint 中驻留的 storage buffer
  shift_epoch()            ← 纪元切换（新 epoch 中首次出现的类型记录到下一检查点）
  JfrMetadataEvent::lock() ← 锁定元数据（防止 write_type_set 期间修改）
```

**为什么这部分必须 STW？** Metaspace 中的 `InstanceKlass::_name`、`Method::_constMethod` 等字段在运行时被类加载/卸载/RedefineClasses 并发修改。STW 暂停所有 JavaThread → Metaspace 不可变 → 读到的类型映射是**某时刻的全局一致快照**。没有 STW → 可能读到"一半已被 redefine 改过的类名 + 一半旧字段类型"的撕裂数据。

**阶段 3 — `post_safepoint_write()`：完成 Chunk 元数据并关闭**

SAFepoint 之后，`write_type_set()` 写类型集，`write_metadata_event()` 写 metadata descriptor。最后 `_repository.close_chunk()` 关闭旧 Chunk 文件 → `open_new_chunk()` 创建新 Chunk → 下一轮写入开始。

---

**★ RotationLock — 为什么重试获取时要区分 JavaThread / NonJavaThread？**

`RotationLock` 构造函数（`jfrRecorderService.cpp:80-133`）最多重试 1000 次获取全局 `rotation_thread` 指针的 CAS 锁。重试期间的等待策略因线程类型而异：

- **JavaThread**：`JfrMsg_lock->wait(false, 10ms)` → 释放 `JfrMsg_lock` + 进入 `_thread_in_vm` → GC 可以 safepoint → **不阻塞 GC**
- **NonJavaThread**：`os::naked_short_sleep(10ms)` → 不释放任何锁、不切换状态 → 更快但 GC 不友好

这个设计确保了即使 Chunk 轮转在另一个线程中正在进行、JfrRecorderThread 被阻塞在重试循环中，**GC 仍然可以正常发起 safepoint**——JfrRecorderThread 在 `wait(10ms)` 中处于 `_thread_in_vm` 状态，是安全的。

---

### 3.4 ★ 检查点的本质 — 为什么需要全局一致性快照？

```
JFR Chunk 结构:

┌──────────────────────────────────┐
│ Chunk Header                     │
│  └─ magic, version, size         │
├──────────────────────────────────┤
│ ★ Checkpoint Events (检查点)     │ ← 元数据: "method_id=1234 = HashMap::getNode"
│  └─ ClassLoader 列表              │
│  └─ Class → symbol_id 映射        │
│  └─ Method → signature 映射       │
│  └─ Thread → name 映射            │
│  └─ StackFrame 表                 │
├──────────────────────────────────┤
│ Events (事件数据)                │ ← 动态: "T=100ms, thread=5, stack=method_id[1234,5678]"
│  └─ ExecutionSample              │
│  └─ ObjectAllocationInNewTLAB    │
│  └─ JavaMonitorEnter             │
│  └─ ...                          │
└──────────────────────────────────┘

检查点 ≠ "保存进度"！
检查点 = 事件类型元数据的字典 —— 没有它，JFR 文件无法解析:
  "method_id=1234" → 哪个方法? → 查找检查点 → "java.util.HashMap::getNode(Object)"
  "thread_id=5"    → 哪个线程? → 查找检查点 → "main"

★ 检查点的增量写入模型（不是一次性全量）：

检查点不是"每个 Chunk 写一次完整的类型映射"。而是 **epoch 增量模型**：
- 每个 Chunk 可能包含多个检查点（多次轮转之间积累的新类型）
- `shift_epoch()`（safepoint_write 中 L457）标记纪元切换 → 新 epoch 中首次出现的类型写入下一个检查点
- 类加载 → 新类型出现 → 但不是立即写到检查点 → 等下一次 Chunk 轮转的 safepoint_write() 时才写入
- 这解释了为什么 `write_safepoint_types()` 只在 safepoint 中调用——如果并发追加新类型 → 同一检查点可能包含"epoch N 的类型"和"epoch N+1 的类型"混合 → 不一致
```

---

### 3.5 SCAVENGE 紧急清扫 — 何时触发？

```cpp
// jfrRecorderService.cpp:528-530
void JfrRecorderService::scavenge() {
  _storage.scavenge();  // 强制清扫所有 dead buffer
}
```

`SCAVENGE` 在 `MSG_DEADBUFFER` 触发。这是紧急机制：当系统有 dead buffer（线程已退出但 buffer 未回收）时强制回收，防止内存泄漏。比 `PROCESS_FULL_BUFFERS` 更激进——扫描所有 buffer 而不仅是 full buffer。

---

## §四 ★ 对比线: 三条遍历所有线程的线程

| 维度 | JfrThreadSampler | VMThread [07] | G1ConcurrentMarkThread [10] |
|------|-----------------|---------------|---------------------------|
| **线程身份** | NonJavaThread | NonJavaThread (NamedThread) | NonJavaThread (ConcurrentGCThread) |
| **遍历时机** | 任意时刻（采样间隔到） | safepoint 内 | concurrent marking（background） |
| **一致性保证** | 近似一致性（逐线程挂起） | 全局一致性（STW） | SATB 快照一致性 |
| **读取内容** | 栈帧 → method_id[] | oop → GC root | oop → marking bitmap |
| **单线程开销** | ~10-50μs (挂起+读栈) | 纳秒 (已 STW) | 纳秒 (SATB barrier) |
| **对应用影响** | 单次采样仅影响 1 线程 ~10-50μs | 全局停顿 ~ms-100ms | 无停顿 (~1-5% throughput) |
| **状态检查** | 逐线程检查 thread_state() | 所有线程已到 safepoint | 检查并发标记状态 |
| **如果崩溃** | 采样停止 → JFR 无新数据 | JVM crash | 并发标记回退 → Full GC |

---

## §五 ★ JfrRecorderThread vs ServiceThread — 专用 vs 通用

| 维度 | JfrRecorderThread | ServiceThread [12] |
|------|-------------------|-------------------|
| **线程身份** | JavaThread | JavaThread |
| **服务对象** | 仅 JFR (4 种消息) | 5 个子系统 (JVMTI + StringTable + LowMemory + GCNotifier + DCmd) |
| **等待锁** | JfrMsg_lock (leaf, safepoint_check_always) | Service_lock (special(4), safepoint_check_never) |
| **最长操作** | ROTATE (50-500ms) | 各操作均 < 100ms |
| **阻塞传染** | 仅影响 JFR 录制 | 影响所有 5 个子系统 |
| **创建时机** | JfrRecorder::create() → create_recorder_thread() | ServiceThread::initialize() (create_vm 尾部) |
| **生命周期** | 条件存在 (JFR 开启) | 永活线程 |
| **die 后果** | JFR 录制停止，buffer 积累 → OOM 风险 | JVMTI 事件丢失 → JVM crash |

**核心差异**：JfrRecorderThread 的 ROTATE 耗时 50-500ms。如果放在 ServiceThread → JVMTI 事件阻塞 500ms → agent 超时 → crash。独立线程 → 互不干扰。

---

## §六 GDB 验证 + 可证伪断言

### GDB 命令（≥12 条）

```
断言 1: 确认 JFR 双线程存在
  (gdb) info threads | grep -E "Jfr|Sampler|Recorder|Unknown"
  → 预期: 看到 "JFR Recorder Thread" (JavaThread) + "Unknown thread" (NonJavaThread JfrThreadSampler)

断言 2: 确认采样频率
  (gdb) p ((JfrThreadSampler*)...)->_interval_java
  → 预期: 10 (ms)

断言 3: 确认采样线程活跃
  (gdb) p ((JfrThreadSampler*)...)->_disenrolled
  → 预期: false (enrolled 时)

断言 4: 断点采样函数 — 验证调用链
  (gdb) break JfrGetCallTrace::get_topframe
  (gdb) continue
  (gdb) bt
  → 预期: #0 JfrGetCallTrace::get_topframe → #1 OSThreadSampler::protected_task → 
    #2 os::SuspendedThreadTask::internal_do_task → #3 JfrThreadSampler::task_stacktrace

断言 5: SIGUSR2 信号编号
  (gdb) p SR_signum
  → 预期: 12 (SIGUSR2 on x86_64 Linux)

断言 6: 断点挂起机制 — 验证 pthread_kill
  (gdb) break sr_notify
  (gdb) continue
  (gdb) p SR_signum
  → 预期: 12

断言 7: 断点信号处理函数
  (gdb) break SR_handler
  (gdb) continue
  (gdb) bt
  → 预期: 信号处理函数被中断线程调用（显示被中断的 JavaThread）

断言 8: 断点 Chunk 轮转 safepoint
  (gdb) break JfrRecorderService::safepoint_write
  (gdb) continue
  (gdb) p SafepointSynchronize::is_at_safepoint()
  → 预期: true

断言 9: 确认 VMThread 调用 JfrVMOperation
  (gdb) break VM_Operation::evaluate (设置条件: type == VMOp_JFRCheckpoint)
  (gdb) continue
  (gdb) bt
  → 预期: VMThread::loop → VM_Operation::evaluate

断言 10: 确认 JfrThreadSampler 是 NonJavaThread
  (gdb) ptype JfrThreadSampler
  → 预期: 继承自 NonJavaThread

断言 11: 确认 JfrRecorderThread 是 JavaThread
  (gdb) call ...->is_Java_thread()
  → 预期: true

断言 12: 确认 Java 线程采样只采 _thread_in_Java 状态
  (gdb) break thread_state_in_java
  (gdb) continue
  (gdb) p ((JavaThread*)$rdi)->thread_state()
  → 预期: _thread_in_Java (= 8)

断言 13: JFR 锁 rank
  (gdb) p JfrMsg_lock->rank()
  → 预期: leaf 级别
  (gdb) p JfrStream_lock->rank()
  → 预期: leaf+1
  (gdb) p JfrStream_lock->_safepoint_check_required
  → 预期: 0 (safepoint_check_never)

断言 14: Buffer 状态
  (gdb) p JfrBuffer::_pos
  (gdb) p JfrBuffer::_top
  → 预期: _pos >= _top (_pos 是写入位置, _top 是未 flush 位置)
```

### 可证伪断言（≥6 条）

```
可证伪断言 1: -XX:StartFlightRecording → JFR 开启 → 比 JFR 关闭时多 2 条线程
  验证: pstack <pid> | wc -l → JFR 开启时 +1 (JfrThreadSampler), jstack +1 (JfrRecorderThread)

可证伪断言 2: JfrThreadSampler crash → 采样停止 → JFR 文件无 ExecutionSample 事件 → JVM 不崩溃
  验证: kill -11 <Sampler_tid> → JVM 继续运行 → jcmd JFR.dump → 文件无新 sample

可证伪断言 3: JfrRecorderThread crash → buffer 积累 → OOM 风险 → JVM 可能崩溃
  验证: kill -11 <Recorder_tid> → 监控 native memory → buffer 持续增长

可证伪断言 4: 采样线程的挂起不是 STW — 单次只挂一个线程 (do_suspend 逐个调用)
  验证: strace -e kill -p <Sampler_tid> → 看到 tgkill(SIGUSR2) 逐个发不同 tid

可证伪断言 5: 关闭 JFR → 两条 JFR 线程都不存在 → pstack/jstack 中无它们
  验证: jcmd JFR.stop → pstack | grep -c "Sampler\|Recorder" → 0

可证伪断言 6: 检查点写入在 safepoint 中 — 断点 safepoint_write → bt 显示 VMThread
  验证: (gdb) break JfrRecorderService::safepoint_write → bt → VMThread::loop()

可证伪断言 7: 采样线程只对 _thread_in_Java 状态的线程做 Java 采样
  验证: 注释掉 thread_state_in_java() 的检查 → 对 _thread_in_vm 线程采样 → 死锁

可证伪断言 8: JfrRecorderThread 的消息循环等待 JfrMsg_lock
  验证: (gdb) p JfrMsg_lock->_owner → 预期: 0 (wait 时释放锁)

可证伪断言 9: 采样线程在 disenroll 后不采样 — 所有线程 state 不变
  验证: jcmd JFR.stop → (gdb) break task_stacktrace → 不再触发
```

---

## §七 三线程对比总结

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│              JfrThreadSampler vs JfrRecorderThread vs ServiceThread              │
├─────────────┬──────────────────┬──────────────────────┬──────────────────────────┤
│             │ JfrThreadSampler │ JfrRecorderThread     │ ServiceThread [12]       │
├─────────────┼──────────────────┼──────────────────────┼──────────────────────────┤
│ 身份        │ NonJavaThread    │ JavaThread            │ JavaThread                │
│ 循环        │ run() — 定时睡眠 │ recorderthread_entry │ service_thread_entry     │
│             │ → 采样任务       │ — JfrMsg_lock wait    │ — Service_lock wait       │
│ 触发        │ 时钟 (10ms)      │ PostBox 消息           │ 5 种条件任意满足          │
│ 耗时        │ ~μs (单线程)     │ ~ms-500ms (磁盘 IO)   │ ~μs-100ms                 │
│ 碰堆        │ 不碰 Java 堆(oops)│ 碰 (metadata 序列化)  │ 碰 (JMX/JNI 回调)         │
│ 死亡后果    │ 采样停止         │ buffer 积累→OOM        │ JVMTI 事件丢失→JVM crash  │
│ 创建时机    │ JFR.start →      │ JfrRecorder::create   │ create_vm() 尾部           │
│             │ start_sampler()  │ → create_recorder_thr │ ServiceThread::init       │
│ 和 VMThread │ 无直接交互       │ ★ JfrVMOperation(STW) │ 无直接交互                │
│ 交互        │ (采样在 safepoint│  通过 VMThread 执行    │                          │
│             │  外并发)         │   safepoint_write()    │                          │
│ 独立性      │ 完全独立         │ 完全独立               │ 通用多路复用器            │
└─────────────┴──────────────────┴──────────────────────┴──────────────────────────┘
```

**设计哲学总结**：

JFR 的双线程架构是"**热路径冷路径分离**"的典范：

- **热路径（采样）**：必须快、不可阻塞、不需要碰堆 → **NonJavaThread**，逐线程挂起读栈，Event 栈分配 + CAS 写入全局 buffer 池
- **冷路径（录制）**：允许慢、可阻塞、需要碰堆 → **JavaThread**，消息循环驱动，阶段分明的 Chunk 轮转
- **特殊点（检查点）**：必须全局一致性 → 通过 **JfrVMOperation** 提交给 **VMThread**，在 safepoint 中执行

这三层设计让 JFR 在"不可感知"和"数据完整"之间找到了精确的平衡点——这就是"JFR 采了一整天，应用几乎不受影响"的终极答案。

---

> **Next**: [16-JVM-Internal-Locks] — 80+ 锁为什么不死锁？Lock Ranking 体系全解析
> **Prev**: [14-JVM-CompilerThread] — C1/C2 CompilerThread + CodeCacheSweeperThread 的 Tiered 编译全周期
> **Cross-ref**: [07-JVM-VMThread](★VMThread 执行 JfrVMOperation), [12-JVM-ServiceThread](★vs ServiceThread 隔离), [09-JVM-JavaThread-System], [10-JVM-NonJavaThread](JfrThreadSampler 在 NonJavaThread 继承链)
