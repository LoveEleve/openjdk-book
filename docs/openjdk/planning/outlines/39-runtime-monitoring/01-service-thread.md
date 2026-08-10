# 01. JVM 的后台线程做什么？— ServiceThread

> 🔴 Deep | 1 KP 中的后台中枢
> 读者处境: JVM 不只跑 Java 线程和 GC——还有一个隐形的 ServiceThread 处理 ~10 种延迟任务。

### 1. "ServiceThread — 10 种任务"

场景: JVMTI agent 请求在 safepoint 外处理事件→JVMTI deferred event→ServiceThread handle。

**ServiceThread** (`runtime/serviceThread.hpp:40-120 + serviceThread.cpp:50-200`):
```
ServiceThread::run():
  while (true) {
    process JVMTI deferred events (dynamic code, single step)
    process GC notifications (memory usage update)
    process OopStorage cleanup (delete stale entries)
    process JFR periodic events
    process jvmti object tagging
    process JFR checkpoint requests
    resolve JVMTI method entry/exit
    update class loading stats
    update thread stats
    sleep if no work
  }
```
- 源码: `runtime/serviceThread.hpp:40-120` + `serviceThread.cpp:50-200`
- 关键设计: ServiceThread 处理 deferred tasks——不同于 WatcherThread 的 periodic sampling。ServiceThread 是 event-driven——task 被 push 到 queue→wakeup thread→process。低优先级线程(不抢 GC worker)——仅在 GC 空闲时推进

### 2. "与 WatcherThread 分工"

场景: WatcherThread(域20)处理 PeriodicTask——每 50ms 采样一次。ServiceThread 处理 "等待回调" 的任务——如 OopStorage 清理需要等 GC cycle 结束才触发。

| ServiceThread | WatcherThread |
|:--|:--|
| event-driven(handles deferred tasks) | periodic(always polls) |
| process pending requests | runs periodic sampling |
| JVMTI/JFR/OopStorage | PerfData/BiasedLock/PeriodicTask |
| wait on queue | sleep(50ms) and poll |
```
- 源码: `runtime/serviceThread.hpp:40-120` task types + `runtime/task.hpp:30-80` WatcherThread tasks

---

### 核心悬念

**"ServiceThread 处理 ~10 种 deferred tasks — JVMTI/JFR/GC notifications/OopStorage。与 WatcherThread(event vs periodic)分工。"** — 下一篇: Timer + Stats。

> → [02-timer-stats.md](02-timer-stats.md)
