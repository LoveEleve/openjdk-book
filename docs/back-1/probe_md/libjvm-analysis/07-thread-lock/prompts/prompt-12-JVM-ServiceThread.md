# PROMPT: 请撰写 12-JVM-ServiceThread.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**"一条线程服务 5 个子系统" — ServiceThread 的 `ThreadBlockInVM` + `Service_lock` 5 条件等待循环与 JVMTI 延迟事件流水线**

### 核心故事线（禁止做源码翻译机！）

前十一篇文章 [05]～[11] 已经覆盖了线程全生命周期、VMThread、WorkerThread、10 个 JavaThread、4 条 NonJavaThread、AttachListener。在 [09] 中你第一次见到了 ServiceThread —— 一条在 `create_vm()` 尾部通过 `ServiceThread::initialize()` 创建的 JavaThread，"Service Thread"是它的 jstack 名称。

现在要回答一个面试级的问题：**ServiceThread 在一个 `while(true)` 循环里同时服务 5 个完全不相关的子系统——JVMTI 延迟事件、低内存检测、GC 通知、DCmd 通知、StringTable 并发清理。为什么把这 5 个任务塞给一条线程？多线程不行吗？**

这条线程是 JVM 中最"忙碌"的 JavaThread（仅次于 VMThread），但它不被 GC safepoint 卡住——通过 `ThreadBlockInVM` + `Service_lock`（`_safepoint_check_never`）实现"可被通知但不被阻塞"的巧妙设计。

**本文的核心叙事线**是一条从"为什么需要这条线程"到"它怎么同时做 5 件事"的追溯链：

1. **为什么要单独一条 ServiceThread？**— [09] 中你知道 ServiceThread 在 `create_vm()` 尾部创建。但为什么不把这 5 个任务分散到已有的线程？CompilerThread 不能发 JVMTI 编译事件（持有 Compile_lock → 死锁）。GC 线程不能触发 JMX 通知（GC 线程不是 JavaThread → 不能调用 Java 层代码）。低内存检测需要 JavaThread（需要创建 OutOfMemoryError 对象）。所以需要一个**专门的 JavaThread**来承揽这些"需要 JavaThread 身份但不需要 safepoint 阻塞"的任务。
2. **为什么 5 个任务不做成 5 条独立线程？**— 如果 5 个任务各自一条线程 → 5 倍栈开销（5 × 1MB = 5MB）→ 5 倍 pthread_create 开销 → 更关键的是：这 5 个任务都是"低频率、低延迟"的类型（可能几秒才触发一次）→ 单独线程大部分时间在空等 → 资源浪费。合并到一条线程 → 1 个 Service_lock + 5 条件 wait() → 被任意一个条件唤醒后立即处理。
3. **★★★ service_thread_entry() 的 5 条件等待循环**— 这是全文核心（`serviceThread.cpp:90-149`）。`ThreadBlockInVM` 先于 `MutexLockerEx` 构造 → 线程进入 `_thread_blocked` → 获取 `Service_lock`（rank=special(4), safepoint_check_never）→ while(!cond1 && !cond2 && ...) → Service_lock->wait() → 被通知后按固定顺序处理 5 个任务。**为什么 ThreadBlockInVM 在外面而不是里面？**— 这是全文最精妙的设计：析构顺序 = 逆构造顺序 → 锁先释放、状态后恢复 → 不在持有锁时处于 `_thread_in_vm` 状态 → 避免 safepoint 死锁。
4. **JVMTI 延迟事件流水线**— CompilerThread 编译完成 → 创建 `JvmtiDeferredEvent` → `ServiceThread::enqueue_deferred_event()` → 入队 → notify_all() 唤醒 ServiceThread → dequeue（锁内）→ 释放锁 → post()（锁外）→ JVMTI agent。**为什么延迟？** 因为 CompilerThread 持有 Compile_lock → 如果直接调用 JVMTI agent，agent 可能反过来触发编译 → 尝试获取 Compile_lock → 死锁。ServiceThread 作为第三方解耦。
5. **StringTable 并发清理为什么第一个处理？**— 5 个任务的处理顺序是：StringTable → JVMTI → LowMemory → GCNotifier → DCmd。为什么 StringTable 排第一？因为它是纯 C++ 操作（遍历 hashtable 清理 dead entry），不触发 Java 层回调 → 快速完成 → 不阻塞后续任务。JVMTI 排第二因为需要 JNI → 可能慢 → 在快任务之后。
6. **ServiceThread 是 is_hidden_from_external_view() 的线程**— JFR、JVMTI GetAllThreads、Thread.getAllStackTraces() 都**看不到** ServiceThread → 保持 JVM 的"黑盒"性。本文需要解释哪些具体接口受这个标志影响。
7. **ServiceThread 的鲁棒性 — 挂了怎么办？**— [09] 中提到 ServiceThread 有"自愈机制"。真的是"自愈"吗？重新读 `ServiceThread::initialize()` 源码：它只被调用**一次**（`Threads::create_vm()` 尾部），没有 watchdog 重启逻辑。如果 ServiceThread crash → `_instance == NULL` → 下一次 `enqueue_deferred_event()` 的 assert 失败 → **JVM crash**。这个 [09] 中的错误结论必须在本文中纠正。

### 禁止行为

- ❌ 把 5 个子系统写成"定义 + 用途"的流水账 — 这是字典，不是分析
- ❌ 忽略 ThreadBlockInVM + MutexLockerEx 的**构造/析构顺序** — 这是全文最精妙的设计，必须用反例分析
- ❌ 忽略"为什么不开 5 条线程"的资源分析 — 1MB×5 vs 1MB×1 的栈开销差异
- ❌ 忽略 is_hidden_from_external_view() 的语义 — 外部工具为什么看不到它？
- ❌ 不画 5 条件等待循环的时序图 — Producer→Service_lock→ServiceThread→5 tasks 全链路
- ❌ 不纠正 [09] 中"自愈机制"的错误结论 — 必须用源码证明"没有自愈"

### 要求行为

- ✅ **★ 核心 5 条件循环深度走读**：`serviceThread.cpp:90-149` 是全文最重要的代码——每行的语义、为什么 ThreadBlockInVM 在外面、为什么 _no_safepoint_check_flag、为什么 dequeue() 在锁内而 post() 在锁外
- ✅ **★ ThreadBlockInVM + MutexLockerEx 构造/析构顺序分析**：两者在同一匿名 scope {} 内 → 构造顺序=声明顺序（TBIVM 先，ML 后）→ 析构顺序=反向（ML 先释放锁，TBIVM 后恢复状态）。**必须用反例（如果顺序颠倒会怎样）证明当前顺序的唯一正确性。**
- ✅ **★ JVMTI 延迟事件全链路**：CompilerThread enqueue → Service_lock notify_all → ServiceThread dequeue（锁内）→ post（锁外）→ JVMTI agent。必须解释"为什么锁外 post"（防止 agent 回调触发 enqueue → 死锁）
- ✅ **★ 纠正 [09] 中"自愈机制"的错误结论**：源码证明 `ServiceThread::initialize()` 只调用一次 → 没有 watchdog → crash = 致命
- ✅ **★ StringTable 并发清理为什么第一个处理**：纯 C++ vs JNI → 快的先做，慢的后做
- ✅ **★ 对比 AttachListener（[11]）vs ServiceThread（[12]）**：都是 JavaThread，都是 daemon，都是 _no_safepoint_check_flag，但一个"按需创建"，一个"永活"——为什么？
- ✅ GDB 验证：info threads 看 ServiceThread、b service_thread_entry 看入口、p Service_lock 看锁 rank、p _jvmti_service_queue 看队列内容、p is_hidden_from_external_view() 验证隐藏标记
- ✅ 交叉引用 [09 §3.5] ServiceThread 创建入口 + [11] AttachListener 按需机制 + [06] JavaThread 生命周期 + [10] NonJavaThread 对比

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 默认 mixed mode（Tiered Compilation 开启）
- 64 位 Linux x86
- ★ ServiceThread 在 create_vm() 尾部创建，是永活线程。不依赖任何 JVM flag——永远存在。
- ★ Service_lock rank=special(4), safepoint_check_never → 获取锁时不做 safepoint 检查
- ★ is_hidden_from_external_view() = true → jstack/JFR 默认不可见

## 三、聚焦源文件

> ★★★ **读码顺序铁律**（违反必翻车）:
> 1. 先读 serviceThread.hpp — 理解 ServiceThread 继承 JavaThread + _jvmti_service_queue + is_hidden_from_external_view()
> 2. 再读 serviceThread.cpp — 理解 service_thread_entry() 的 5 条件循环 + enqueue_deferred_event() 生产者
> 3. 再读 jvmtiImpl.hpp — 理解 JvmtiDeferredEvent 的 5 种类型 + JvmtiDeferredEventQueue 的链表结构
> 4. 再读 lowMemoryDetector.hpp — 理解 SensorInfo::has_pending_requests() 的触发条件 + 滞后机制
> 5. ★ 最后理解 ThreadBlockInVM + MutexLockerEx 构造/析构顺序 → 这是全文设计精髓

| # | 文件 | 完整路径 | 核心类/函数 | 本文角色 |
|---|------|---------|------------|---------|
| 1 | `serviceThread.hpp` | `src/hotspot/share/runtime/serviceThread.hpp` | `ServiceThread`(:35), `_jvmti_service_queue`(:40), `is_hidden_from_external_view()`(:49) | ★ 类定义 + 单例 + 隐藏标记 |
| 2 | `serviceThread.cpp` | `src/hotspot/share/runtime/serviceThread.cpp` | `service_thread_entry()`(:90-149), `initialize()`(:51-88), `enqueue_deferred_event()`(:151-159) | ★★★ 全文核心 — 5 条件等待循环 + 创建入口 + 生产者 |
| 3 | `jvmtiImpl.hpp` | `src/hotspot/share/prims/jvmtiImpl.hpp` | `JvmtiDeferredEvent`(:454-510), `JvmtiDeferredEventQueue`(:514) | ★★ JVMTI 延迟事件的 5 种类型 + 队列结构 |
| 4 | `lowMemoryDetector.hpp` | `src/hotspot/share/services/lowMemoryDetector.hpp` | `LowMemoryDetector`(:214), `SensorInfo`(:116) | ★ 低内存检测 — 生产者（应用线程 → SensorInfo） |
| 5 | `stringTable.hpp` | `src/hotspot/share/classfile/stringTable.hpp` | `StringTable::has_work()`, `do_concurrent_work()` | StringTable 并发清理 — 唯一纯 C++ 任务 |
| 6 | `gcNotifier.hpp` | `src/hotspot/share/services/gcNotifier.hpp` | `GCNotifier::has_event()`, `sendNotification()` | GC 完成 → JMX GarbageCollectionNotificationInfo |
| 7 | `diagnosticFramework.hpp` | `src/hotspot/share/services/diagnosticFramework.hpp` | `DCmdFactory::has_pending_jmx_notification()` | DCmd JMX 通知 — 诊断命令的 MBean 注册 |
| 8 | `interfaceSupport.inline.hpp` | `src/hotspot/share/runtime/interfaceSupport.inline.hpp` | `ThreadBlockInVM`(:297) | ★★ 状态转换 — _thread_in_vm → _thread_blocked |
| 9 | `mutexLocker.cpp` | `src/hotspot/share/runtime/mutexLocker.cpp` | `Service_lock`(:249) | ★ Service_lock 的 rank + safepoint_check 声明 |
| 10 | `threadSMR.hpp` | `src/hotspot/share/runtime/threadSMR.hpp` | `is_hidden_from_external_view()` 接口 | 隐藏标记对 JFR/JVMTI/Thread API 的影响 |

## 四、必须深度走读的核心概念

### 4.1 ★★★ 5 条件等待循环 — 全文核心 (serviceThread.cpp:90-149)

```
★★★ 主循环完整代码（带标注）:

void ServiceThread::service_thread_entry(JavaThread* jt, TRAPS) {
  while (true) {                              // 永活线程，永不退出
    bool sensors_changed = false;
    bool has_jvmti_events = false;
    bool has_gc_notification_event = false;
    bool has_dcmd_notification_event = false;
    bool stringtable_work = false;
    JvmtiDeferredEvent jvmti_event;

    {                                         // ★ 匿名 scope — 控制 RAII 析构顺序
      // "so that this thread will be handled by safepoint correctly
      //  when this thread is notified at a safepoint"
      ThreadBlockInVM tbivm(jt);              // (A) _thread_in_vm → _thread_blocked
      MutexLockerEx ml(Service_lock, Mutex::_no_safepoint_check_flag); // (B)

      while (!(sensors_changed = LowMemoryDetector::has_pending_requests()) &&
             !(has_jvmti_events = _jvmti_service_queue.has_events()) &&
             !(has_gc_notification_event = GCNotifier::has_event()) &&
             !(has_dcmd_notification_event = DCmdFactory::has_pending_jmx_notification()) &&
             !(stringtable_work = StringTable::has_work())) {
        Service_lock->wait(Mutex::_no_safepoint_check_flag);  // (C) wait 释放锁
      }

      if (has_jvmti_events) {
        jvmti_event = _jvmti_service_queue.dequeue();  // (D) 锁内 dequeue
        _jvmti_event = &jvmti_event;
      }
    }                                         // (E) 析构: ml 先（释放锁）→ tbivm 后（恢复状态）

    // 处理顺序: StringTable → JVMTI → LowMemory → GCNotifier → DCmd
    if (stringtable_work) {
      StringTable::do_concurrent_work(jt);          // ⑤ 纯 C++，最快
    }
    if (has_jvmti_events) {
      _jvmti_event->post();                         // ② 锁外 post → 安全
      _jvmti_event = NULL;
    }
    if (sensors_changed) {
      LowMemoryDetector::process_sensor_changes(jt); // ① 可能上抛 OOME
    }
    if (has_gc_notification_event) {
      GCNotifier::sendNotification(CHECK);           // ③ JMX 通知
    }
    if (has_dcmd_notification_event) {
      DCmdFactory::send_notification(CHECK);         // ④ JMX 通知
    }
  }
}
```

**★★★ 构造/析构顺序精读**：

```
匿名 scope { } 内的 RAII 顺序:

  构造 (从上到下):
    (A) ThreadBlockInVM tbivm(jt);       // state: _thread_in_vm → _thread_blocked
    (B) MutexLockerEx ml(Service_lock,...); // acquire Service_lock

  wait:
    (C) Service_lock->wait(...);          // 释放锁 → 阻塞等待 notify

  被唤醒后:
    (C') wait() 返回 → 重新获取 Service_lock
    (D) dequeue() / 读取标志

  析构 (从下到上, 逆序):
    (E1) ml.~MutexLockerEx()             // 释放 Service_lock
    (E2) tbivm.~ThreadBlockInVM()        // state: _thread_blocked → _thread_in_vm
```

**❓ 追问 1：为什么 ThreadBlockInVM 必须在外层（先构造后析构）？**

```
如果 ThreadBlockInVM 在内层：
  (B) MutexLockerEx ml(Service_lock);     // 先构造 → 获取锁
  (A) ThreadBlockInVM tbivm(jt);          // 后构造 → 切换状态（OK，先锁后切换合法）
  ...
  (A1) tbivm.~ThreadBlockInVM()           // 先析构 → _thread_blocked → _thread_in_vm
  ★ 此时仍在持有 Service_lock！
  ★ Safepoint 检查: 线程在 _thread_in_vm 状态 + 持有锁
     → 如果 GC 此时需要 safepoint → 检查 Service_lock 的 _safepoint_check_never
     → 但线程状态是 _thread_in_vm → safepoint 协议会尝试阻塞这个线程
     → 其他线程在 safepoint 中需要 Service_lock → 死锁！
  (B1) ml.~MutexLockerEx()               // 后析构 → 释放锁（但已经太晚）

正确顺序（当前代码）:
  (A) ThreadBlockInVM tbivm(jt);          // 先构造 → _thread_blocked
  (B) MutexLockerEx ml(Service_lock);     // 后构造 → 获取锁
  ...
  (B1) ml.~MutexLockerEx()               // 先析构 → 释放锁 ★
  (A1) tbivm.~ThreadBlockInVM()           // 后析构 → _thread_blocked → _thread_in_vm
  → 锁已释放 → 状态恢复安全
```

**❓ 追问 2：为什么 _no_safepoint_check_flag？**

Service_lock 定义（`mutexLocker.cpp:249`）：`def(Service_lock, PaddedMonitor, special, true, Monitor::_safepoint_check_never)`

`_safepoint_check_never` → `Monitor::lock()` 会 assert fail → 必须用 `lock_without_safepoint_check()` → `_no_safepoint_check_flag` 就是 `MutexLockerEx` 的构造参数，指示使用 `lock_without_safepoint_check()`。

**为什么 _safepoint_check_never？** ServiceThread 在 safepoint 期间可能需要被唤醒处理 JVMTI 事件——如果 Service_lock 允许 safepoint 检查 → 线程进入 safepoint 前会被要求释放 Service_lock → 但 wait() 本身就依赖这个锁 → 逻辑矛盾。

---

### 4.2 ★★ JVMTI 延迟事件流水线 — 为什么需要第三方？

```
生产者: CompilerThread
  1. 编译完成 → JvmtiDeferredEvent::compiled_method_load_event(nm)
  2. ServiceThread::enqueue_deferred_event(&event)
     → MutexLockerEx(Service_lock, _no_safepoint_check_flag)
     → _jvmti_service_queue.enqueue(event)
     → Service_lock->notify_all()

消费者: ServiceThread
  3. Service_lock 内被唤醒
  4. jvmti_event = _jvmti_service_queue.dequeue()  // 锁内取（链表保护）
  5. }  // 释放 Service_lock
  6. jvmti_event->post()                            // 锁外执行
     → JvmtiExport::post_compiled_method_load()
     → JVMTI agent 回调

为什么 (4) 在锁内、(6) 在锁外？
  (4) 锁内: _jvmti_service_queue 是普通链表，不是线程安全的 → 需要锁保护
  (6) 锁外: post() 调用 JVMTI agent → agent 可能触发新编译 → CompilerThread
            enqueue → 需要 Service_lock → 如果不释放锁 → 死锁
```

**❓ 追问：为什么 JVMTI agent 可能触发新编译？**

因为 agent 可以在 `CompiledMethodLoad` 回调中调用 `RetransformClasses` 或 `RedefineClasses` → 触发 JIT 重新编译 → 需要 Compile_lock → Compile_lock 被 CompilerThread 持有 → 如果 ServiceThread 不释放 Service_lock → 死锁。

---

### 4.3 ★ 5 个任务的处理顺序 — 为什么 StringTable 第一？

```
处理顺序: StringTable → JVMTI → LowMemory → GCNotifier → DCmd

设计原理:
  StringTable: 纯 C++ (hashtable 遍历 + dead entry 清理) → 无 Java 回调 → 最快
  JVMTI:      post() → JNI → agent 代码 → 可能慢 → 在最快任务之后
  LowMemory:  可能上抛 OutOfMemoryError → Java 异常处理
  GCNotifier: JMX MBean 通知 → Java 层回调
  DCmd:       JMX MBean 注册 → Java 层回调
```

---

### 4.4 ★ 低内存检测全链路

```
生产者: 应用线程（任何 JavaThread）
  → new TLAB / allocate outside TLAB → 跨越 MemoryPool 阈值
  → LowMemoryDetector::detect_low_memory()
  → SensorInfo::_pending_trigger_count++
  → Service_lock->notify_all()

消费者: ServiceThread
  → 被唤醒 → sensors_changed = true
  → LowMemoryDetector::process_sensor_changes(jt)
  → SensorInfo::trigger(count, THREAD)
  → 创建 javax.management.Notification 对象
  → MemoryMXBean.sendNotification()
  → Java 层 javax.management.NotificationListener 回调
```

**滞后机制（hysteresis）**：`SensorInfo` 有高阈值和低阈值 → 只在跨越阈值时触发一次 → 避免频繁震荡触发通知。

---

### 4.5 ★★★ 纠正 [09] 的错误结论 — ServiceThread 没有自愈机制

[09 §3.5] 提到"ServiceThread 挂了能自动重新创建"。

**实际源码证明**：`ServiceThread::initialize()` 只被调用一次：

```cpp
// thread.cpp（简化）— Threads::create_vm() 中:
ServiceThread::initialize();  // ★ 只调用一次！

// serviceThread.cpp:51 — initialize() 没有 watchdog:
void ServiceThread::initialize() {
  ...
  _instance = thread;          // ★ 设置单例
  Threads::add(thread);
  Thread::start(thread);
}
// 没有 while(_instance==NULL) 重新创建 的逻辑！
```

如果 ServiceThread crash → `_instance = NULL` → 下一次 `enqueue_deferred_event()`:
```cpp
void ServiceThread::enqueue_deferred_event(JvmtiDeferredEvent* event) {
  assert(_instance != NULL, "cannot enqueue events...");
  // ★ _instance == NULL → assert fail → JVM crash
}
```

**结论**：ServiceThread **没有自愈机制**。crash = 致命。

---

### 4.6 ★ `is_hidden_from_external_view()` 的语义与影响范围

`ServiceThread::is_hidden_from_external_view()` 返回 `true`（`serviceThread.hpp:49`）。

**❓ 追问 1：哪些接口受这个标志影响？**

```
JFR 录制:    ThreadsList::threads_do() → 遍历 _thread_list → 过滤 hidden 线程
JVMTI:       GetAllThreads() → jvmtiEnv::GetAllThreads() → 检查 is_hidden
Java API:    Thread.getAllStackTraces() → JVM_GetAllThreads() → 过滤 hidden
jstack:      Threads::print_on() → ALL_JAVA_THREADS 宏 → 不过滤 hidden（jstack 可见！）
pstack:      直接读取 /proc/pid/task/ → 不受 JVM 控制 → 总可见
```

**❓ 追问 2：为什么 ServiceThread 要 hidden，AttachListener 不用？**

ServiceThread 是纯 JVM 内部线程 → 用户不需要知道它的存在 → 隐藏避免噪音。

AttachListener 是用户交互线程 → jcmd/jmap/jstack 的入口 → 用户需要知道它 → 不隐藏。

```
对比:
  ServiceThread:    is_hidden = true   → jstack 不可见，JFR 不可见
  AttachListener:   is_hidden = false  → jstack 可见，JFR 可见
  ReferenceHandler: is_hidden = true   → 同 ServiceThread
  Finalizer:        is_hidden = true   → 同 ServiceThread
```

**❓ 追问 3：如果 ServiceThread crash，JFR/JVMTI 会怎样？**

JFR 录制中如果尝试遍历 `_thread_list` → 过滤 hidden → 遍历到 ServiceThread → `_instance = NULL` → 不会 crash（因为只读 `_thread_list`）。

但 JVMTI 事件入队 `enqueue_deferred_event` → `assert(_instance != NULL)` → **JVM crash**。

---

## 五、文章结构

```
§〇 源文件清单（跨 runtime/prims/services/classfile）
  → 搜索不到时回退到 source_index/ 索引

§一 ServiceThread 全景 — 为什么一条线程服务 5 个子系统？
  ★ 开头即贴 jstack 输出 "Service Thread" → 溯源到 create_vm 源码
  ❓ 为什么 5 个任务不开 5 条独立线程？
  ❓ 什么任务需要 JavaThread 身份？
  1.1 ServiceThread 的创建入口 (serviceThread.cpp:51-88)
  1.2 5 个子系统全景: producer → Service_lock → consumer 映射表
  1.3 ★ 对比: 如果 5 条独立线程 → 5MB 栈 vs 1MB 栈 → 资源分析
  1.4 Service_lock 声明 (mutexLocker.cpp:249) — rank=special(4), _safepoint_check_never

§二 ★★★ 5 条件等待循环深度走读 (serviceThread.cpp:90-149)
  ❓ ThreadBlockInVM 在外层 → 为什么？
  ❓ _no_safepoint_check_flag → 为什么？
  ❓ dequeue 在锁内 / post 在锁外 → 为什么？
  2.1 完整代码走读 — 每行语义 + 为什么这么写
  2.2 ★ RAII 构造/析构顺序图 — tbivm 和 ml 的生命周期
  2.3 ★ 反例分析: 如果 ThreadBlockInVM 在内层 → 死锁场景
  2.4 5 个条件标志语义 + 处理顺序

§三 ★★ JVMTI 延迟事件流水线
  ❓ 为什么 CompilerThread 不能自己发 JVMTI 事件？
  ❓ dequeue 锁内 / post 锁外 — 为什么？
  3.1 生产者: CompilerThread → enqueue_deferred_event
  3.2 JvmtiDeferredEvent 5 种类型 (jvmtiImpl.hpp:457-463) + union 结构
  3.3 消费者: ServiceThread → dequeue (锁内) → post (锁外)
  3.4 ★ 死锁分析: Compile_lock 持有 → JVMTI agent → 编译 → 死锁

§四 ★ StringTable 并发清理 + 低内存检测 + GC 通知 + DCmd 通知
  ❓ StringTable 为什么第一个处理？
  4.1 StringTable::do_concurrent_work() — 纯 C++，无 Java 回调
  4.2 LowMemoryDetector 滞后机制 — 高/低阈值 hysteresis
  4.3 GCNotifier::sendNotification() — GarbageCollectionNotificationInfo
  4.4 DCmdFactory::send_notification() — MBean 注册

§五 ★ 纠正 [09] 的"自愈机制"结论 — ServiceThread crash = 致命
  ❓ [09] 为什么误判？
  5.1 源码证明: initialize() 只调用一次 — 没有 watchdog
  5.2 _instance = NULL → enqueue_deferred_event assert 致命
  5.3 ★ 对比: AttachListener 按需创建 vs ServiceThread 永活

§六 ★ 对比线: AttachListener（[11]）vs ServiceThread（[12]）
  ❓ 都是 JavaThread, daemon, _no_safepoint_check_flag → 为什么一个"按需"一个"永活"？
  6.1 创建时机: 首次 jcmd vs create_vm() 启动
  6.2 死亡后果: jcmd 连不上（可重生） vs JVMTI 事件丢失（致命 crash）
  6.3 is_hidden_from_external_view(): ServiceThread=true vs AttachListener=false

§七 GDB 验证 + 可证伪断言（≥10 条 GDB + ≥5 条断言）

  断言 1: (gdb) info threads | grep "Service Thread" → 预期: Service Thread 存在
  断言 2: (gdb) p ServiceThread::_instance->is_hidden_from_external_view() → 预期: true
  断言 3: (gdb) p Service_lock->rank() → 预期: 4; (gdb) p Service_lock->_safepoint_check_required → 预期: 0
  断言 4: (gdb) br serviceThread.cpp:111 (gdb) c (gdb) p sensors_changed ... → 预期: 至少一个 true
  断言 5: (gdb) p 'ServiceThread::_jvmti_service_queue' → 预期: _queue_head == NULL（空闲时）
  断言 6: (gdb) call java_lang_Thread::is_daemon(ServiceThread::_instance->threadObj()) → 预期: true
  断言 7: (gdb) br ServiceThread::enqueue_deferred_event (gdb) c (gdb) bt → 预期: 从 CompilerThread 调用
  断言 8: (gdb) br service_thread_entry (gdb) c (gdb) bt → 预期: 入口在 Threads::create_vm 路径
  断言 9: java -Xlog:jvmti+events=debug MyApp → 预期: JVMTI 事件入/出队日志
  断言 10: (gdb) p ServiceThread::_instance → 预期: 非 NULL（永活）

  可证伪断言 1: ServiceThread crash → _instance=NULL → 下一个 JVMTI 事件入队 → assert fail → JVM crash
  可证伪断言 2: ServiceThread 的 is_hidden_from_external_view()=true → JFR 录制中看不到它
  可证伪断言 3: Service_lock rank=special(4) → 获取 Service_lock 后可以获取 rank<4 的锁（如 tty=3）
  可证伪断言 4: ServiceThread 处理 StringTable 清理时不触发任何 Java 层代码（纯 C++ 遍历）
  可证伪断言 5: initialize() 只被调用一次 → 源码搜索无递归/retry 逻辑
```

## 六、写作要求

1. **★ 5 条件循环是全文灵魂**: serviceThread.cpp:90-149 的每行都要解释——为什么这样设计、不这样设计会怎样
2. **★ ThreadBlockInVM + MutexLockerEx 构造/析构顺序**：用反例（如果顺序颠倒）证明当前顺序的唯一正确性
3. **JVMTI 延迟事件全链路**: 从 CompilerThread 到 JVMTI agent，每一步的锁持有分析
4. **★ 纠正 [09] 自愈错误**: 引用 initialize() 源码证明没有 watchdog
5. **资源对比**: 5 条独立线程 vs 1 条 ServiceThread 的栈开销 + 锁开销对比
6. **GDB 验证**: ≥10 条，每条含命令 + 预期值；可证伪断言 ≥5 条
7. **交叉引用**: [09 §3.5] ServiceThread 概览 + [11] AttachListener 按需机制 + [06] 生命周期 + [10] NonJavaThread 对比

## 七、输出格式

- Markdown 文件，命名为 `12-JVM-ServiceThread.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/07-thread-lock/`
- 元信息头（标准环境 + 源文件 + 前置 [09][11] + 关联 [06][10] + 阅读收益）
