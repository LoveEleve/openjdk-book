# 03. 内存快满时怎么得到通知？— GC Notifier + LowMemory + Flags

> **前置依赖**:[33-jmx/01 — JConsole 怎么知道 Eden 用了多少？— MemoryService + MemoryPool](openjdk/vol-02/33-jmx/01-memory-service.md):池上的 `_usage_sensor`/`_gc_usage_sensor` 与 ThresholdSupport 的数据结构在这篇;[33-jmx/02 — JDK 怎么查询 JVM 内存状态？— JMM 接口 + JDK Management](openjdk/vol-02/33-jmx/02-jmm-interface.md):SetPoolSensor/SetPoolThreshold/SetGCNotificationEnabled 三个"写"接口把传感器挂到池上;[39-runtime-monitoring/01 — JVM 的后台线程做什么?— ServiceThread](openjdk/vol-02/39-runtime-monitoring/01-service-thread.md):传感器请求与 GC 通知都由 ServiceThread 串行消费
> → **后续**:[43-nio-net/01 — TCP Socket — PlainSocketImpl + ServerSocket + epoll](openjdk/vol-02/43-nio-net/01-tcp-epoll.md):33 域收官,离开 VM 内部管理,进入网络 I/O 域
> 关联域: 39-runtime-monitoring(ServiceThread)、37-heap-dumper(OOM 触发)、03-arguments-flags(flag 系统)

## 三种通知,一张脉络

[JMX 通知实证](planning/outlines/00-jvm-tools/materials/commands/33-jmx-notify-demo.txt)在 G1 上设了两个 8MB 阈值、挂了一个 GC 监听器,然后分配 200MB:

```
== MEM NOTIF type=java.management.memory.threshold.exceeded seq=1 pool=G1 Old Gen used=10170368 count=1
== GC NOTIF seq=1 name=G1 Young Generation action=end of minor GC cause=G1 Humongous Allocation duration=4ms oldBefore=238759936 oldAfter=239639976
== MEM NOTIF type=java.management.memory.collection.threshold.exceeded seq=2 pool=G1 Old Gen used=421159456 count=1
...
== GC NOTIF seq=11 name=G1 Old Generation action=end of major GC cause=System.gc() duration=3ms oldBefore=418081464 oldAfter=421159456
== MEM NOTIF type=java.management.memory.collection.threshold.exceeded seq=3 pool=G1 Old Gen used=421224720 count=2
```

三个值得记住的事实: ①**usage 阈值只报一次**(threshold.exceeded 只有 seq=1,count=1)——超阈值后必须降回去才再报;②**collection usage 阈值每次 GC 都报**(seq=2、seq=3,count=1→2);③**GC 通知每次都带完整账本**(oldBefore/oldAfter 逐次变化,13 次通知覆盖 young 与 full)。这篇拆三层: 谁检查阈值(检测入口)、传感器怎么"跳闸"(SensorInfo 的迟滞语义)、通知怎么发出(GC Notifier 与 WriteableFlags)。

## 1. 检测入口: GC 后、分配慢路径、GC 结束

阈值检查有三个触发点,lowMemoryDetector.hpp:33-62 的头注释是权威概述——"For heap memory, detection will be performed when GC finishes and also in the slow path allocation. For Code cache, detection will be performed in the allocation and deallocation"——**大纲"只在 GC cycle 中检测"是错的,分配慢路径也会检测**:

- **GC 之后**(`MemoryService::track_memory_usage`,01 篇拆过): gc_epilogue 里遍历所有池 `LowMemoryDetector::detect_low_memory()`(memoryService.cpp:155);
- **分配慢路径**: TLAB 外/慢分配结束时 `MemAllocator::Allocation::notify_allocation_low_memory_detector`(memAllocator.cpp:232-236,注释 "support low memory notifications (no-op if not enabled)")→ `detect_low_memory_for_collected_pools`(lowMemoryDetector.hpp:258-277): 遍历 collected 池,`used > high_threshold` 才 `detect_low_memory(pool)`——**快路径分配零开销,慢路径才查**;
- **GC 结束的 gc_end 内**(`LowMemoryDetector::detect_after_gc_memory`): memoryManager.cpp:274-278(gc_end 里 set_last_collection_usage 后)——**这是 collection usage 阈值的唯一检测点**(语义不同,见下节)。

`detect_low_memory()`(lowMemoryDetector.cpp:81-102)是总入口: Service_lock 下遍历所有池,对"有 sensor 且支持高阈值且阈值非 0"的池,把当前 usage 喂给 `sensor->set_gauge_sensor_level(...)`——**这一步只"记账"(算要不要触发),不调 Java**;有 pending 请求才 `Service_lock->notify_all()` 唤醒 ServiceThread。`is_enabled(pool)`(hpp:235-246)判断"检测对这个池是否开启": sensor 非空且 high_threshold > 0。

*关键设计: 检测是"采样"不是"通知"*——阈值检查只更新传感器状态机的 pending 计数,真正调 Java 在 ServiceThread 上(39-01 的 5 条件之一),与 GC 自身完全解耦。

## 2. SensorInfo: 迟滞与两种语义

`class SensorInfo`(lowMemoryDetector.hpp:116-212)是每个池传感器的状态机,头注释(hpp:154-203)定义了两种监控语义:

**gauge 语义**(`set_gauge_sensor_level`,cpp:206-239): usage 升到 high 阈值以上触发一次,**之后即使仍在高位也不触发**,除非降到 low 阈值以下再升回来——高/低双阈值构成**迟滞(hysteresis)**,防止 usage 在阈值附近抖动造成通知风暴。实证的 threshold.exceeded 只报一次就是它。

**counter 语义**(`set_counter_sensor_level`,cpp:261-277): **每次** usage 超阈值都记一次 pending(注释 "will be triggered whenever the usage is crossing the threshold to keep track of the number of times")——实证的 collection.threshold.exceeded 每次 GC 都报、count 递增(1→2)就是它。

两个方法的差异只在触发条件,共同点是**pending 计数**:

```cpp
// lowMemoryDetector.cpp:215-230(截取核心,逐字)
  if (is_over_high &&
        ((!_sensor_on && _pending_trigger_count == 0) ||
         _pending_clear_count > 0)) {
    // low memory detected and need to increment the trigger pending count
    // if the sensor is off or will be off due to _pending_clear_ > 0
    // Request to trigger the sensor
    _pending_trigger_count++;
    _usage = usage;

    if (_pending_clear_count > 0) {
      // non-zero pending clear requests indicates that there are
      // pending requests to clear this sensor.
      // This trigger request needs to clear this clear count
      // since the resulting sensor flag should be on.
      _pending_clear_count = 0;
    }
```

`_pending_trigger_count`/`_pending_clear_count`/`_sensor_on`/`_sensor_count` 四个状态(hpp:118-134): 检测线程(VM 线程/分配线程)在 Service_lock 下**只改 pending 计数**,真正的 trigger/clear 由 ServiceThread 在锁外执行(39-01 已拆 `process_sensor_changes`)。`process_pending_requests`(:283-291)按 pending_clear>0 分派到 `clear`/`trigger`。

**trigger 的落点**(:293-343)是 Java 侧 `sun.management.Sensor` 对象——`JavaCalls::call_virtual` 调 `Sensor.trigger(int, MemoryUsage)`(:305-324,先构造 MemoryUsage 对象);**OOM 时降级为 `trigger(int)`**(注释 :307-309 "When OOME occurs and fails to allocate MemoryUsage object, call Sensor::trigger(int) instead")。回调后回到锁内更新 `_sensor_on=true`/`_sensor_count+=count`(:335-342)。Java 侧 `Sensor.trigger(int, MemoryUsage)`(Sensor.java:128-136)置 on/count 后调 `triggerAction(usage)`——`PoolSensor.triggerAction`(MemoryPoolImpl.java:297-300)发 `MEMORY_THRESHOLD_EXCEEDED` 通知,`CollectionSensor.triggerAction`(:325-331)发 `MEMORY_COLLECTION_THRESHOLD_EXCEEDED`;`MemoryImpl.createNotification`(MemoryImpl.java:138-161)检查 `hasListeners()`(没监听器直接不发)后构造 Notification + MemoryNotificationInfo 的 CompositeData 发出。*全链路: C++ 检测→pending 计数→ServiceThread 回调→Java 发 JMX 通知*。

## 3. GC 通知: 一次 GC 一份完整账

内存阈值通知是"条件触发";GC 通知是"每次 GC 必发"(开启时)。触发点在 01 篇拆过的 gc_end 尾部: `if (is_notification_enabled()) GCNotifier::pushNotification(...)`(memoryManager.cpp:294-296)。**开关的开启不是 JVM 侧的事,而是 Java 侧 addNotificationListener 自动做的**: `GarbageCollectorExtImpl.addNotificationListener`(GarbageCollectorExtImpl.java:118-126)在"从无监听器变为有监听器"时调 `setNotificationEnabled(this, true)`→ native → 02 篇的 `jmm_SetGCNotificationEnabled`(management.cpp:1893-1900)置 `_notification_enabled`;removeNotificationListener 对称关闭。所以"挂了监听器通知就来"——实证里 demo 只 addNotificationListener 就收到了 13 条通知,无需任何额外配置。

`pushNotification`(gcNotifier.cpp:45-54)做两件事: ①**复制账本**——new 一个 GCStatInfo 并 `mgr->get_last_gc_stat(stat)`(注释 "GC may occur between now and the creation of the notification"),这是 01 篇双缓冲账本的一次深拷贝,通知与 GC 之间隔了多少都无所谓;②构造 `GCNotificationRequest`(gcNotifier.hpp:33-54: timestamp/manager/action/cause/stat)入链表(Service_lock 下尾插+notify,:56-65)。`has_event()`(:76-78)就是链表非空——39-01 的 GCNotifier::has_event 条件。

消费端还是 ServiceThread: 锁内 `getRequest()`(:67-74)取头,锁外 `sendNotification`(:165-172,清 pending exception 防线程死,39-01 已拆)→ `sendNotificationInternal`(:189-224):

```cpp
// gcNotifier.cpp:195-222(截取核心,逐字)
    Handle objGcInfo = createGcInfo(request->gcManager, request->gcStatInfo, CHECK);

    Handle objName = java_lang_String::create_from_str(request->gcManager->name(), CHECK);
    Handle objAction = java_lang_String::create_from_str(request->gcAction, CHECK);
    Handle objCause = java_lang_String::create_from_str(request->gcCause, CHECK);
    InstanceKlass* gc_mbean_klass = Management::com_sun_management_internal_GarbageCollectorExtImpl_klass(CHECK);

    instanceOop gc_mbean = request->gcManager->get_memory_manager_instance(THREAD);
    instanceHandle gc_mbean_h(THREAD, gc_mbean);
    if (!gc_mbean_h->is_a(gc_mbean_klass)) {
      THROW_MSG(vmSymbols::java_lang_IllegalArgumentException(),
                "This GCMemoryManager doesn't have a GarbageCollectorMXBean");
    }

    JavaValue result(T_VOID);
    JavaCallArguments args(gc_mbean_h);
    args.push_long(request->timestamp);
    args.push_oop(objName);
    args.push_oop(objAction);
    args.push_oop(objCause);
    args.push_oop(objGcInfo);
```

`createGcInfo`(:99-163)把账本变成 Java 对象: before/after 两个 MemoryUsage 数组(每池各一,与 02 篇 jmm_GetLastGCStat 相同,含 survivor max==0 特例 :120-127)+ GC 线程数扩展参数 → `JavaCalls::construct_new_instance` 构造 `com.sun.management.GcInfo`(builder+index+起止毫秒+before/after+扩展)。最后调 `GarbageCollectorExtImpl.createGCNotification`(GarbageCollectorExtImpl.java:93-114): `hasListeners()` 检查(没人听就不发)→ 构造 `GARBAGE_COLLECTION_NOTIFICATION` 类型的 Notification + `GarbageCollectionNotificationInfo` 的 CompositeData。实证里 13 条 GC NOTIF 就是这条链——young GC(cause=G1 Humongous Allocation)与 full GC(cause=System.gc())各有 action("end of minor GC"/"end of major GC",来自 GCMemoryManager 构造参数 g1CollectedHeap.cpp:1424-1425)。

## 4. WriteableFlags: 运行时可改的 flag

第三条线不是通知而是**反向控制**——运行时改 JVM 参数。`jcmd VM.set_flag` [实证](planning/outlines/00-jvm-tools/materials/commands/33-jmx-flag-demo.txt):

```
[HeapDumpBeforeFullGC true]
Command executed successfully
[MaxHeapFreeRatio 60]
Command executed successfully
[PrintGC true]
only 'writeable' flags can be set
[NonExistingFlag true]
flag NonExistingFlag does not exist
```

**三个入口,同一个函数**: `jmm_SetVMGlobal`(management.cpp:1569-1580,HotSpotDiagnosticMXBean.setVMOption 走这里,JVMFlag::MANAGEMENT origin)、attach 的 setflag 操作(attachListener.cpp:288,JVMFlag::ATTACH_ON_DEMAND)、VM.set_flag DCmd(diagnosticCommand.cpp:282)。都汇到 `WriteableFlags::set_flag`(writeableFlags.cpp:243-267):

```cpp
// writeableFlags.cpp:243-267(截取核心,逐字)
JVMFlag::Error WriteableFlags::set_flag(const char* name, const void* value, JVMFlag::Error(*setter)(JVMFlag*,const void*,JVMFlag::Flags,FormatBuffer<80>&), JVMFlag::Flags origin, FormatBuffer<80>& err_msg) {
  if (name == NULL) {
    err_msg.print("flag name is missing");
    return JVMFlag::MISSING_NAME;
  }
  if (value == NULL) {
    err_msg.print("flag value is missing");
    return JVMFlag::MISSING_VALUE;
  }

  JVMFlag* f = JVMFlag::find_flag((char*)name, strlen(name));
  if (f) {
    // only writeable flags are allowed to be set
    if (f->is_writeable()) {
      return setter(f, value, origin, err_msg);
    } else {
      err_msg.print("only 'writeable' flags can be set");
      return JVMFlag::NON_WRITABLE;
    }
  }

  err_msg.print("flag %s does not exist", name);
  return JVMFlag::INVALID_FLAG;
}
```

三段检查: 参数空(MISSING_NAME/MISSING_VALUE)→ `find_flag` 找不到(INVALID_FLAG,实证 "flag NonExistingFlag does not exist")→ **is_writeable() 检查**(NON_WRITABLE,实证 PrintGC/PrintJNIResolving 被拒)。"writeable" 是 flag 定义时的宏属性(globals.hpp:166-208 注释): `manageable`(如 HeapDumpBeforeFullGC/HeapDumpOnOutOfMemoryError,可经管理接口改)与 `product_rw`(内部可写)两类;其余 flag 一律拒绝——**flag 系统的"可写性"是编译期声明的,不是运行期推导的**。写值经 set_flag_from_char/set_flag_from_jvalue(:269/:298)按 flag 类型分派(bool/int/uint/intx/...)。

## 核心悬念

33 域收官。通知系统闭环: 检测入口三处(GC 后/分配慢路径/GC 结束)→ SensorInfo 状态机(gauge 迟滞与 counter 两种语义,pending 计数与 ServiceThread 分离)→ Java 侧 Sensor→JMX 通知;GC 通知每次 GC 复制一份账本(GCStatInfo 深拷贝+链表),由 ServiceThread 构造 GcInfo 发出;WriteableFlags 让运行时改参数(manageable/product_rw 编译期声明,三入口一函数)。整个 JMX 域至此完整: 池/账本(01)→ 函数表/交付(02)→ 订阅与通知(03)。下一个域离开 VM 内部管理——**网络 I/O**: TCP Socket 从 Java 到 epoll 的链路。

> → [43-nio-net/01 — TCP Socket — PlainSocketImpl + ServerSocket + epoll](openjdk/vol-02/43-nio-net/01-tcp-epoll.md)
