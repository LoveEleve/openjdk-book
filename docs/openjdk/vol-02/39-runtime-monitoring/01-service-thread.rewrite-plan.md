# 39-runtime-monitoring/01-service-thread 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 ServiceThread 的角色——它不是周期任务线程，而是事件驱动的“后台通知/清理线程”；以及它如何在 Service_lock 下检测 5 类工作，在锁外串行处理

## 1. 选题判断

现稿事实基础很强：
- `ServiceThread::initialize`
- `service_thread_entry`
- JVMTI deferred events
- GCNotifier
- LowMemoryDetector
- StringTable::do_concurrent_work
- DCmdFactory::send_notification

真正该打穿的困惑更集中：

**JVM 里这个不起眼的 `"Service Thread"` 到底做什么？它和 WatcherThread 的区别是什么？为什么 JVMTI 事件、GC 通知、StringTable 清理、内存传感器、DCmd 通知都要绕到它这里？它为什么必须“锁内检测、锁外干活”？**

## 2. 一句话顿悟

**ServiceThread 不是“后台周期任务线程”，而是一个高优先级、事件驱动的串行消费线程。它在 `Service_lock` 下统一检测 5 条工作源（JVMTI、GC 通知、内存传感器、StringTable 并发清理、DCmd 通知），没有就 wait；一旦有活，就把需要串行化、需要安全线程状态、或需要 Java 回调的工作放到锁外逐项处理。它和 WatcherThread 的关系是“门铃 vs 闹钟”：WatcherThread 按时间点醒，ServiceThread 只有被 notify 才醒。**

## 3. 总图

```text
ServiceThread::initialize
  └─ JavaThread("Service Thread")
       ├─ daemon
       ├─ NearMaxPriority
       └─ Threads::add + Thread::start

service_thread_entry
  ThreadBlockInVM
    ↓
  Service_lock 下 while 检测 5 条件:
    - LowMemoryDetector::has_pending_requests()
    - _jvmti_service_queue.has_events()
    - GCNotifier::has_event()
    - DCmdFactory::has_pending_jmx_notification()
    - StringTable::has_work()
    ↓
  锁外处理:
    1. StringTable::do_concurrent_work
    2. _jvmti_event->post
    3. LowMemoryDetector::process_sensor_changes
    4. GCNotifier::sendNotification
    5. DCmdFactory::send_notification
```

## 4. 结构大纲

### 第一节：开场困惑——谁在 JVMTI 事件与 GC 通知之间穿梭

- 从线程转储里的 `"Service Thread"` 切入
- 点出它不是 WatcherThread 那类 PeriodicTask 线程
- 埋主线：事件驱动、五类任务、锁内检测锁外处理

### 第二节：两个朴素方案为什么都不对

1. 把它当低优先级杂役线程
2. 把它当 WatcherThread 的另一个名字

结论：它是高优先级事件线程，不跑周期任务。

### 第三节：主循环——锁内检测,锁外干活

- `initialize` 建 JavaThread/daemon/NearMaxPriority
- `ThreadBlockInVM`
- `Service_lock` 下 5 条条件检测
- 锁内 dequeue JVMTI,锁外 post

### 第四节：五类任务——触发源与处理

- JVMTI deferred events
- GC 通知
- StringTable 并发清理
- 内存压力传感器
- DCmd JMX 通知

### 第五节：与 WatcherThread 的分工

- 闹钟 vs 门铃
- 一个按 `time_to_wait()` 周期醒，一个被 notify 唤醒

### 第六节：误解澄清与收网

## 5. 失败方案必须写进正文

1. ServiceThread 是低优先级“善后线程”
2. ServiceThread 和 WatcherThread 都是“后台定时线程”

## 6. 证据清单

- `src/hotspot/share/runtime/serviceThread.cpp:45-82`
- `src/hotspot/share/runtime/serviceThread.cpp:84-143`
- `src/hotspot/share/runtime/serviceThread.cpp:145-179`
- `src/hotspot/share/runtime/serviceThread.hpp:31-58`
- `src/hotspot/share/services/gcNotifier.cpp:45-224`
- `src/hotspot/share/services/lowMemoryDetector.cpp:81-147`
- `src/hotspot/share/classfile/stringTable.cpp`（`has_work` / `do_concurrent_work`）
- `src/hotspot/share/services/diagnosticFramework.cpp:445-452`

## 7. 完成后 review

- 删除代码后，能否复述“门铃 vs 闹钟”
- 是否讲清 5 条工作源
- 是否讲清为什么锁内检测、锁外处理
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验