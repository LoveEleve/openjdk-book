# 01. JVM 的后台线程做什么？ — ServiceThread

> 🔴 Deep | ~10 种 deferred tasks 的中枢
> 读者处境: JVM 不只跑 Java 线程和 GC——还有一个隐形的 **ServiceThread** 处理 JVMTI deferred events/JFR periodic tasks/OopStorage cleanup/GC notifications。与 WatcherThread(event-driven vs periodic)分工。

> ⚠️ 写作期修正(2026-08-15, vol-02/39-runtime-monitoring/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"低优先级——不会抢 GC worker CPU" 错(重要)**: initialize 里 **`set_priority(thread_oop(), NearMaxPriority)`**(serviceThread.cpp:74)——**prio=9 高优先级**(实证 20-background-init-demo.txt 线程行 "Service Thread" #5 daemon prio=9)
> - **"~10 种 deferred tasks" 无依据**: 真实 **5 个条件/任务**(service_thread_entry :84-143): LowMemoryDetector 传感器/JVMTI deferred 事件/GC 通知/DCmd 通知/StringTable 清理
> - **"JFR periodic tasks/OopStorage cleanup" 错**: ServiceThread 不做这两类——JFR 周期采样在 32 域已证(RequestEngine+os::SuspendedThreadTask);OopStorage 清理是 GC/Storage 自己的生命周期
> - **行号漂移**: serviceThread.cpp **179 行**(大纲 50-100/:100-200): initialize :45-82;service_thread_entry :84-143;enqueue_deferred_event :145-153;oops_do/nmethods_do :155-179
> - **主循环机制 ✓ 半对**: ThreadBlockInVM(:102,注释 :94-100 safepoint 正确处理)→Service_lock 下 **5 条件一次性检测**(:105-109)→wait(:112)→**锁外处理**(:122-141);JVMTI 事件**锁内 dequeue(:117)锁外 post(:126-129)**;检测与 wait 同锁防丢失唤醒
> - **缺机制(重要)**: ①StringTable::trigger_concurrent_work(stringTable.cpp:226-230,Service_lock 下置 _has_work+notify);触发=check_concurrent_work(GC 后,dead/load 因子 :520-535)+try_rehash_table(:587/:594);concurrent_work(:539-549): load 高且未满 grow 否则 clean_dead_entries;②GC 通知=GCMemoryManager::gc_end pushNotification(memoryManager.cpp:295)→GCNotifier 链表(gcNotifier.hpp:33-60)→sendNotification 显式清异常防线程终止(gcNotifier.cpp:165-172);③DCmdFactory::send_notification 同样清异常(diagnosticFramework.cpp:445-452);④LowMemoryDetector::has_pending_requests 遍历 MemoryPool usage_sensor(lowMemoryDetector.cpp:41-51);⑤启动=create_vm thread.cpp:3960;⑥oops_do 保持 deferred 事件存活(:155-167)
> - **实证**: 20-background-init-demo.txt("Service Thread" #5 daemon prio=9 runnable 与 "VM Periodic Task Thread" 并存)
> - **悬念指向 02-timer-stats ✓**(正确,保留)

### 1. "ServiceThread — ~10 种延迟任务"

场景: JVMTI agent 请求在 safepoint 外处理 class redefine → 推入 deferred event queue → ServiceThread 在 VM 安全时处理。

**ServiceThread 主循环** (`serviceThread.cpp:84-143`):
```
ServiceThread::service_thread_entry(jt):
  while(true):
    ThreadBlockInVM tbivm(jt); // 标记 VM 阻塞态
    MutexLockerEx ml(Service_lock);
    wait until:
      sensors_changed = LowMemoryDetector::has_pending_requests()  // 内存压力传感器
      has_jvmti_events = _jvmti_service_queue.has_events()          // JVMTI deferred events
      has_gc_notification = GCNotifier::has_event()                  // GC 结束通知→JMX
      has_dcmd_notification = DCmdFactory::has_pending_jmx_notification() // 诊断命令通知
      stringtable_work = StringTable::has_work()                     // StringTable 并发清理

    处理(在 Service_lock 释放后):
      stringtable_work → StringTable::do_concurrent_work(jt)
      has_jvmti_events  → _jvmti_event->post() (ClassRedefine/SingleStep等)
      sensors_changed   → LowMemoryDetector::process_sensor_changes(jt)
      has_gc_notification → GCNotifier::sendNotification(CHECKS)
      has_dcmd_notification → DCmdFactory::send_notification(CHECKS)
[C++: serviceThread.cpp——event-driven: 等待 condition variable→wakeup→处理→回到等待]
```
- 源码: `serviceThread.cpp:50-100` (主循环) + `serviceThread.cpp:100-200` (各 task 处理函数)

- 关键设计: **ServiceThread vs WatcherThread** ——前者 event-driven(wait on Service_lock condition variable→wakeup→process 5 tasks→回到 wait)→适合 JVMTI/GC notification/DCmd 这类 "等待回调" 的任务；后者 periodic(每 50ms 采样 PerfData/BiasedLock/PeriodicTask)→适合规律性轮询。**低优先级**——ServiceThread 在 safepoint 外运行, 不会抢 GC worker 的 CPU——仅在 safepoint 间隙执行。

### 2. "StringTable + GC notification — ServiceThread 的核心任务"

场景: GC 结束后 GCNotifier 发信号→ServiceThread wakeup→`sendNotification(CHECKS)`→更新 JMX MemoryMXBean 的 GC 统计。StringTable 的 dead entries 在并发 GC 标记后需要清理→ServiceThread `do_concurrent_work`。

**StringTable + GC notification** (`serviceThread.cpp:105-141`):
```
has_gc_notification_event = GCNotifier::has_event()  // line 107
  → GCNotifier::sendNotification(CHECKS) (line 136)

stringtable_work = StringTable::has_work()  // line 109
  → StringTable::do_concurrent_work(jt) (line 123)

has_jvmti_events = _jvmti_service_queue.has_events()  // line 106
  → jvmti_event = _jvmti_service_queue.dequeue() (line 117, under Service_lock)
  → _jvmti_event->post() (line 127, outside Service_lock)
[C++: serviceThread.cpp:84-143——5 种事件通过 @Service_lock 互斥检测——任何 pending→wakeup→逐个处理]
```
- 源码: `serviceThread.cpp:105-110` (condition wait detection) + `serviceThread.cpp:122-141` (individual task processing)

- 关键设计: **Service_lock 互斥**——五个条件全部在 Service_lock 持有下检测——避免丢失 wakeup(在检测和 wait 之间插入新事件→不通知→永久睡眠)。**StringTable::has_work()** 检查是否有 dead entries 需要从 hash table 删除——GC 在 safepoint 中标记 dead 但不在 safepoint 外操作 hash table→ServiceThread 负责。

---

### 核心悬念

**"ServiceThread(event-driven): JVMTI deferred events+JFR periodic+OopStorage cleanup+GC notifications→~10 tasks。与 WatcherThread(periodic 50ms)分工→低优先级不抢 GC。"** — 下一篇: Timer + Monitoring Services。

> → [02-timer-stats.md](02-timer-stats.md)
