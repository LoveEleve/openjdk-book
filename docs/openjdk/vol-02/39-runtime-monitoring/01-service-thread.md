# 01. JVM 的后台线程做什么?— ServiceThread

> **前置依赖**:[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):ServiceThread 与 WatcherThread 都在后台线程族里,启动序列里有它的位置;[17-threads/01 — JVM 里有多少种线程?— Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md):ServiceThread 是 JavaThread(daemon)
> → **后续**:[39-runtime-monitoring/02 — Timer + Monitoring Services: 高精度计时 + JMX 统计](02-timer-stats.md)
> 关联域: 28-jvmti(JVMTI deferred events)、07-classfile(03 的 StringTable 在这篇做并发清理)

## 谁在 JVMTI 事件与 GC 通知之间穿梭

[实证](planning/outlines/00-jvm-tools/materials/commands/20-background-init-demo.txt)的线程转储里有一行不起眼的 `"Service Thread" #5 daemon prio=9 ... runnable`。它不跑周期任务(WatcherThread 的活),而是**事件驱动**——有人往队列里放东西才醒。它管五件事: JVMTI 的延迟事件(deferred events)、GC 结束的 JMX 通知、StringTable 的并发清理、内存压力传感器的回调、DCmd 的 JMX 通知。这篇拆两层: 主循环的"等-处理"机制(锁内检测、锁外干活),以及五类任务各自的触发源——顺带纠正大纲的两个想象: ServiceThread 是 **NearMaxPriority 高优先级**(不是低优先级),而且它**只有五类任务**,没有 JFR periodic、没有 OopStorage cleanup。

## 1. 主循环: 锁内检测,锁外干活

`ServiceThread::initialize`(serviceThread.cpp:45-82)创建名为 "Service Thread" 的 JavaThread: daemon、system thread group,并且——**`java_lang_Thread::set_priority(thread_oop(), NearMaxPriority)`(:74)——NearMaxPriority 高优先级**(prio=9,与实证素材的线程行 `prio=9` 一致)——不是大纲想象的"低优先级不抢 GC"。启动在 create_vm 里(thread.cpp:3960)。

主循环 `service_thread_entry`(:84-143):

```cpp
// serviceThread.cpp:102-119(截取核心,逐字)
      ThreadBlockInVM tbivm(jt);

      MutexLockerEx ml(Service_lock, Mutex::_no_safepoint_check_flag);
      while (!(sensors_changed = LowMemoryDetector::has_pending_requests()) &&
             !(has_jvmti_events = _jvmti_service_queue.has_events()) &&
              !(has_gc_notification_event = GCNotifier::has_event()) &&
              !(has_dcmd_notification_event = DCmdFactory::has_pending_jmx_notification()) &&
              !(stringtable_work = StringTable::has_work())) {
        // wait until one of the sensors has pending requests, or there is a
        // pending JVMTI event or JMX GC notification to post
        Service_lock->wait(Mutex::_no_safepoint_check_flag);
      }

      if (has_jvmti_events) {
        // Get the event under the Service_lock
        jvmti_event = _jvmti_service_queue.dequeue();
        _jvmti_event = &jvmti_event;
      }
```

`ThreadBlockInVM`(:102)先把线程置成阻塞态(注释 :94-96: safepoint 能正确处理这个线程);`Service_lock` 下**一次性检测全部 5 个条件**(:105-109)——内存传感器(`LowMemoryDetector::has_pending_requests`)/JVMTI 事件队列/GC 通知/DCmd 通知/StringTable 工作;没有就 `wait`。*关键设计: 检测与等待在同一把锁下*——新事件若在"检测完"与"进入 wait"之间到达,会被 notify 打断 wait,不会丢失唤醒。JVMTI 事件特殊: **在锁内 dequeue(:117)、锁外 post(:126-129)**——dequeue 保证不会两个线程抢同一事件,post 在锁外避免持锁回调。

## 2. 五类任务: 触发源与处理

**①JVMTI deferred events**。不是所有 JVMTI 事件都能在发生线程上直接回调(比如类重定义要在安全点外做复杂工作),于是入 `ServiceThread::_jvmti_service_queue`(ServiceThread 自己的静态队列,注释 :40-43 "Events can be posted before JVMTI vm_start...";`enqueue_deferred_event` :145-153 持锁入队+notify)。post 处理在锁外;事件对象本身被 GC 扫描**保持存活**直到处理完(`oops_do`/`nmethods_do`,:155-179 扫 `_jvmti_event` 与队列)。

**②GC 通知(JMX)**。GC 结束时 `GCMemoryManager::gc_end` 调 `GCNotifier::pushNotification`(memoryManager.cpp:295,带上 GC 起止时间/action/cause 与统计)→ 入 GCNotifier 的**请求链表**(gcNotifier.hpp:33-60,`first_request/last_request`);`has_event` 就是链表非空(:76-78);ServiceThread 调 `GCNotifier::sendNotification`(:136)→ `sendNotificationInternal` 构造 `sun.management.GarbageCollectorImpl` 的 JMX 通知并发出。**`sendNotification` 显式清 pending exception**(gcNotifier.cpp:165-172,注释 "Clearing pending exception to avoid premature termination of the service thread")——回调里抛的异常不能杀死这个线程。

**③StringTable 并发清理**。StringTable 的 weak 引用在 GC 标记后出现 dead entries,删除要动哈希表结构、不能在 GC 的 critical 区做,于是 GC 后 `check_concurrent_work` 按 dead/load 因子触发 `trigger_concurrent_work`(stringTable.cpp:520-535,Service_lock 下置 `_has_work`+notify);`try_rehash_table` 的 grow 分支里也会再触发(:587/:594)——与 32 域的 JFR、OopStorage 的清理都无关。ServiceThread 收到后 `StringTable::do_concurrent_work`→`concurrent_work`(:539-549): 看 load factor,**高于阈值且表未满就 grow(扩容顺带清 dead),否则 clean_dead_entries**。

**④内存压力传感器**。`LowMemoryDetector::has_pending_requests`(lowMemoryDetector.cpp:41-51)遍历所有 MemoryPool 的 usage_sensor(阈值触发的内存使用传感器,`sun.management.MemoryPool` 的 usage/collection usage 阈值);`process_sensor_changes` 在 ServiceThread 上回调 Java 侧的监听器。

**⑤DCmd 的 JMX 通知**。`DCmdFactory::has_pending_jmx_notification` + `send_notification`(diagnosticFramework.cpp:445-452,同样清 pending exception 保护 ServiceThread)——jcmd 之外通过 JMX 执行诊断命令后的通知。

*关键设计: 五类任务都是"队列/标志 + 通知"模式,ServiceThread 只负责串行消费*——与 WatcherThread 的周期轮询形成互补(20-02 域);它**不做** JFR 的周期采样(32 域: RequestEngine+os::SuspendedThreadTask)、**不做** OopStorage 清理(那是 GC/Storage 自己的生命周期)。

## 3. 与 WatcherThread 的分工

20-02 域拆过 WatcherThread(名字 "VM Periodic Task Thread"): 算 `time_to_wait()` 睡到**最近任务到期点**,周期执行 PeriodicTask 表里的任务(StatSampler 50ms 采样 PerfData、ChunkPoolCleaner 5s 等)。ServiceThread 完全相反: 没有周期,永远阻塞在 `Service_lock->wait`,被 **notify 唤醒**(enqueue_deferred_event/trigger_concurrent_work/gc 结束 pushNotification 都会 notify)。两个线程一个是"闹钟",一个是"门铃"——[实证](planning/outlines/00-jvm-tools/materials/commands/20-background-init-demo.txt)的转储里两者并存,`"Service Thread" #5 daemon prio=9` 与 `"VM Periodic Task Thread"` 各司其职。

## 核心悬念

ServiceThread 拆完: 事件驱动主循环(ThreadBlockInVM + Service_lock 下 5 条件检测、锁外处理),NearMaxPriority 高优先级(prio=9 实证);五类任务各有触发源——JVMTI deferred events(队列+oops_do 保活)、GC 通知(GCMemoryManager::gc_end → GCNotifier 链表 → JMX,清异常防线程死)、StringTable 并发清理(GC 后 trigger,load factor 高则 grow 否则 clean_dead)、内存传感器(MemoryPool usage_sensor)、DCmd JMX 通知;与 WatcherThread 是"闹钟 vs 门铃"的分工。但"运行时监控"这条线才开个头: **高精度计时**从哪来(os::elapsed_counter、JavaTimeNanos 的底层时钟),JMX 统计(MemoryPool/GCMemoryManager 的计数器)又怎么组织?下一篇: Timer 与 Monitoring Services。

> → [39-runtime-monitoring/02 — Timer + Monitoring Services: 高精度计时 + JMX 统计](02-timer-stats.md)
