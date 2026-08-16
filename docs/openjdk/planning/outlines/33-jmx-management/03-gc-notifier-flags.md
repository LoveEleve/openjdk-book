# 03. 内存快满时怎么得到通知？— GC Notifier + LowMemory + Flags

> 🟡 Working | 2 KP 中的通知系统
> 读者处境: 应用需在 heap 达到 80% 时收到警告→初始化 cache eviction。LowMemoryDetector 在 threshold exceeded→send Java notification。

> ⚠️ 写作期修正(2026-08-16,33-jmx/03 完成,33 域收官):
> - **"只在 GC cycle 中检测" 错(重要)**: 检测**三入口**——①GC 后 track_memory_usage→detect_low_memory(memoryService.cpp:155);②**分配慢路径**(MemAllocator::notify_allocation_low_memory_detector memAllocator.cpp:232-236→detect_low_memory_for_collected_pools lowMemoryDetector.hpp:258-277,used>high 才查,头注释 :55-58 "detection will be performed when GC finishes and also in the slow path allocation");③GC 结束 gc_end 内 detect_after_gc_memory(memoryManager.cpp:274-278,**collection usage 阈值唯一检测点**)
> - **"GcNotifier::post_gc_notification" 编造**: 真实=**GCNotifier::pushNotification**(gcNotifier.cpp:45-54: **复制账本** new GCStatInfo+get_last_gc_stat,注释 "GC may occur between now and the creation of the notification";GCNotificationRequest 链表 Service_lock 尾插+notify :56-65)+**sendNotification**(:165-172 清异常)/sendNotificationInternal(:189-224: createGcInfo :99-163 构造 com.sun.management.GcInfo→GarbageCollectorExtImpl.createGCNotification GarbageCollectorExtImpl.java:93-114)
> - **"GC_NOTIFICATION" 编造**: 真实通知类型=**GARBAGE_COLLECTION_NOTIFICATION**(GarbageCollectorExtImpl.java:98)
> - **"clear_sensor() in GC begin" 编造**: 无;SensorInfo::clear(lowMemoryDetector.cpp:345-374)由 process_pending_requests(:283-291)按 pending_clear 分派;**无 GC begin 清除机制**
> - **"trigger_count/trigger_time" 半对**: 真实=**_sensor_on/_sensor_count/_pending_trigger_count/_pending_clear_count 状态机**(hpp:118-134);检测线程 Service_lock 下只改 pending 计数,ServiceThread 锁外 trigger/clear
> - **阈值通知两种语义(大纲漏,核心)**: **gauge**(set_gauge_sensor_level cpp:206-239,超 high 触发一次,降 low 以下才可再触发——**迟滞**;实证 threshold.exceeded 只报一次 count=1)vs **counter**(set_counter_sensor_level :261-277,**每次**超阈值都 pending;实证 collection.threshold.exceeded 每次 GC 报,count=1→2)
> - **trigger 落点**: JavaCalls 调 sun.management.Sensor.trigger(int, MemoryUsage)(Sensor.java:128-136)→triggerAction→PoolSensor(MemoryPoolImpl.java:297-300,发 MEMORY_THRESHOLD_EXCEEDED)/CollectionSensor(:325-331,MEMORY_COLLECTION_THRESHOLD_EXCEEDED)→MemoryImpl.createNotification(MemoryImpl.java:138-161,hasListeners 检查);**OOM 时降级 trigger(int)**(cpp:307-313)
> - **通知开关自动开启(大纲漏,重要)**: GarbageCollectorExtImpl.addNotificationListener(GarbageCollectorExtImpl.java:118-126)在从无监听器变有监听器时 setNotificationEnabled→jmm_SetGCNotificationEnabled(management.cpp:1893-1900)
> - **WriteableFlags**: 三入口同一函数——jmm_SetVMGlobal(management.cpp:1569-1580,MANAGEMENT origin)/attach setflag(attachListener.cpp:288,ATTACH_ON_DEMAND)/VM.set_flag DCmd(diagnosticCommand.cpp:282)→WriteableFlags::set_flag(writeableFlags.cpp:243-267: find_flag→**is_writeable() 检查**→setter);错误码 MISSING_NAME/MISSING_VALUE/NON_WRITABLE/INVALID_FLAG;"writeable"=manageable/product_rw 宏(globals.hpp:166-208 注释,编译期声明);实证: HeapDumpBeforeFullGC/MaxHeapFreeRatio 成功、PrintGC "only 'writeable' flags can be set"、NonExistingFlag "flag ... does not exist"
> - **悬念指向错**: "域34 NMT"过期(34 域第 5 批已完结)——正确 **43-nio-net**(第 6 批收官)
> - 素材: 33-jmx-notify-demo.txt(三类通知全触发: threshold.exceeded seq=1 count=1/collection seq=2,3 count=1→2/GC NOTIF 13 条含 young(G1 Humongous Allocation)+full(System.gc()))/33-jmx-flag-demo.txt(jcmd VM.set_flag 正反例)

### 1. "LowMemoryDetector — per-pool threshold"

场景: `MemoryPoolMXBean.setUsageThreshold(80% * max)` → LowMemoryDetector 跟踪各 pool 使用→超阈值→ `sendNotification(MEMORY_THRESHOLD_EXCEEDED)`。

**LowMemoryDetector** (`services/lowMemoryDetector.hpp/cpp`):
```
检测三入口(头注释 :33-62):
  GC 后      : MemoryService::track_memory_usage → detect_low_memory(memoryService.cpp:155)
  分配慢路径 : MemAllocator::notify_allocation_low_memory_detector(memAllocator.cpp:232-236)
              → detect_low_memory_for_collected_pools(hpp:258-277, used>high 才查)
  GC 结束    : gc_end 内 detect_after_gc_memory(memoryManager.cpp:274-278, collection 阈值)
detect_low_memory(:81-102): Service_lock 下遍历池→set_gauge_sensor_level(只记账)→pending→notify
SensorInfo 状态机: _sensor_on/_sensor_count/_pending_trigger_count/_pending_clear_count
  gauge  : set_gauge_sensor_level(:206-239) 超 high 触发一次,降 low 以下才可再触发(迟滞)
  counter: set_counter_sensor_level(:261-277) 每次超阈值都 pending(collection usage 用)
process_pending_requests(:283-291)→trigger(:293-343, JavaCalls 调 Sensor.trigger(int,MemoryUsage),OOM 降级 trigger(int))/clear(:345-374)
```
- 源码: `lowMemoryDetector.hpp:67-212`(ThresholdSupport/SensorInfo)+ `lowMemoryDetector.cpp:81-374` + 触发点(memoryService.cpp:155/memAllocator.cpp:236/memoryManager.cpp:277)
- 关键设计: 阈值检查是"采样"不是"通知"——检测线程在 Service_lock 下只更新 pending 计数,真正回调 Java 在 ServiceThread 上(39-01 的 5 条件之一);gauge 迟滞防止通知风暴
- [C++: `SensorInfo` 状态机;`trigger` 经 JavaCalls 调 `Sensor.trigger(int, MemoryUsage)`,Java 侧 PoolSensor.triggerAction(MemoryPoolImpl.java:297-300)→MemoryImpl.createNotification(MemoryImpl.java:138-161)]

### 2. "GC Notifier — GarbageCollectionNotification"

场景: `com.sun.management.GarbageCollectorMXBean` 添加 NotificationListener → 每次 GC 后 receive notification with GC info。

**GC Notifier** (`services/gcNotifier.hpp/cpp`):
```
触发: gc_end 里 if (is_notification_enabled()) GCNotifier::pushNotification(memoryManager.cpp:294-296)
pushNotification(gcNotifier.cpp:45-54): 复制账本(new GCStatInfo+get_last_gc_stat)→GCNotificationRequest 链表
has_event(:76-78)=链表非空;ServiceThread→sendNotification(:165-172 清异常)→sendNotificationInternal(:189-224)
createGcInfo(:99-163): before/after MemoryUsage 数组(survivor max==0 特例 :120-127)+GC 线程数→构造 com.sun.management.GcInfo
→GarbageCollectorExtImpl.createGCNotification(GarbageCollectorExtImpl.java:93-114, hasListeners 检查)
开启: addNotificationListener 首次挂监听器自动 setNotificationEnabled(Java:118-126)→jmm_SetGCNotificationEnabled(management.cpp:1893-1900)
```
- 源码: `services/gcNotifier.hpp:33-68` + `gcNotifier.cpp:45-224` + `memoryManager.cpp:294-296`
- 关键设计: GC notification 含 GC id/name/cause/duration + before/after MemoryUsage of each pool→JConsole 用此数据显示 GC history;账本深拷贝使通知与 GC 解耦
- [C++: GCNotificationRequest=timestamp/manager/action/cause/GCStatInfo 深拷贝;sendNotificationInternal 用 NotificationMark RAII 保证请求对象回收]

### 3. "WriteableFlags — 运行时改 JVM 参数"

场景: `jcmd <pid> VM.set_flag PrintGC true` → writeableFlags → 修改 JVM flag at runtime。

**WriteableFlags** (`services/writeableFlags.hpp/cpp`):
```
三入口: jmm_SetVMGlobal(management.cpp:1569-1580)/attach setflag(attachListener.cpp:288)/VM.set_flag DCmd(diagnosticCommand.cpp:282)
WriteableFlags::set_flag(writeableFlags.cpp:243-267):
  参数空→MISSING_NAME/MISSING_VALUE;find_flag 找不到→INVALID_FLAG;!is_writeable()→NON_WRITABLE
  通过→setter(set_flag_from_char :269 / set_flag_from_jvalue :298,按类型分派 bool/int/uint/intx/...)
"writeable"=manageable/product_rw 宏(globals.hpp:166-208 注释,编译期声明)
```
- 源码: `services/writeableFlags.hpp:32-86` + `writeableFlags.cpp:229-338` + 三入口
- 关键设计: flag 的可写性是编译期声明的(manageable/product_rw),运行时只检查不推导;实证: HeapDumpBeforeFullGC/MaxHeapFreeRatio 成功、PrintGC/PrintJNIResolving "only 'writeable' flags can be set"、NonExistingFlag "flag ... does not exist"

---

### 核心悬念

**"LowMemoryDetector 三入口检测(gc 后/分配慢路径/GC 结束)→SensorInfo 状态机(gauge 迟滞/counter)→ServiceThread 回调 Java Sensor→JMX 通知;GC Notifier 每次 GC 深拷贝账本发 GcInfo;WriteableFlags 编译期声明可写性+三入口一函数。"** — 33 域收官,下一篇: 43-nio-net。

> → 43-nio-net
