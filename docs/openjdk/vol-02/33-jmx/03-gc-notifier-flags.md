# 03. 内存快满时怎么得到通知？— GC Notifier + LowMemory + Flags

> **前置依赖**:[33-jmx/01 — JConsole 怎么知道 Eden 用了多少？— MemoryService + MemoryPool](openjdk/vol-02/33-jmx/01-memory-service.md):池上的 `_usage_sensor`/`_gc_usage_sensor` 与 ThresholdSupport 的数据结构在这篇;[33-jmx/02 — JDK 怎么查询 JVM 内存状态？— JMM 接口 + JDK Management](openjdk/vol-02/33-jmx/02-jmm-interface.md):SetPoolSensor/SetPoolThreshold/SetGCNotificationEnabled 三个“写”接口把传感器挂到池上;[39-runtime-monitoring/01 — JVM 的后台线程做什么？— ServiceThread](openjdk/vol-02/39-runtime-monitoring/01-service-thread.md):传感器请求与 GC 通知都由 ServiceThread 串行消费
> → **后续**:[43-nio-net/01 — TCP Socket — PlainSocketImpl + ServerSocket + epoll](openjdk/vol-02/43-nio-net/01-tcp-epoll.md):33 域收官,离开 VM 内部管理,进入网络 I/O 域
> 关联域: 39-runtime-monitoring(ServiceThread)、37-heap-dumper(OOM 触发)、03-arguments-flags(flag 系统)

JMX 的管理面有三类看起来相近、实际不同的信号:

- **usage threshold**：当前池使用量超过阈值;
- **collection usage threshold**：一次 GC 完成后,GC 后使用量仍超过阈值;
- **GC notification**：一次 GC 完成,带 before/after 完整账本。

本篇要回答的核心问题:

1. 谁在什么时候检查“内存快满”?
2. 为什么 usage threshold 只报一次,collection threshold 却能累计多次?
3. GC 通知为什么不是 GC 线程直接发给 Java?
4. 运行时改 flag 又怎么进入同一个管理面?

答案会反复落到一句话:**检测、记账、发通知是三件分离的事。`LowMemoryDetector` 只更新传感器的 pending 状态，ServiceThread 才调 Java `Sensor.trigger(...)`；`GCNotifier` 先复制 GC 账本入队，再由 ServiceThread 构造并发送通知；JMX/attach/DCmd 改 flag 则统一落到 `WriteableFlags::set_flag`。**

---

## 1. 开场困惑——“谁在什么时候发现内存快满”

一次压力测试可能同时出现三种输出:

```text
MEM NOTIF type=java.management.memory.threshold.exceeded pool=G1 Old Gen count=1
GC NOTIF name=G1 Young Generation action=end of minor GC
MEM NOTIF type=java.management.memory.collection.threshold.exceeded pool=G1 Old Gen count=1
GC NOTIF name=G1 Old Generation action=end of major GC
```

它们不是同一个触发器:

- usage threshold 看的是**当前 usage**;
- collection usage threshold 看的是**最近一次 GC 后 usage**;
- GC notification 看的是**GC 事件本身**。

更容易混淆的是时间顺序:GC 结束后,VM 线程可能已经把多个请求放进 pending/队列,真正发 Java 回调的是 ServiceThread。因此日志里“先看到内存通知、后看到对应 GC 通知”并不代表检测早于 GC,只代表消费顺序不同。

---

## 2. 两个朴素方案为什么都不对

### 方案一:检测到就直接调 Java 通知

如果分配线程或 GC 线程每次检测到超阈值就直接构造 `MemoryUsage`、调用 Java `Sensor.trigger`,那么热点分配路径会承担 JavaCalls、对象分配和线程状态切换;GC 线程也会被通知处理拖住。

正确做法是:检测线程只在锁内更新 pending 计数,有请求就唤醒 ServiceThread;Java 回调在独立线程上串行完成。

### 方案二:所有阈值都“超过就报”

当前 usage 可能在阈值附近上下抖动。如果每次超过 high 都报通知,会形成通知风暴;但 collection usage 又确实需要记录每次 GC 后仍然超标的次数。

所以 JFR/JMX 使用两套 SensorInfo 语义:

- **gauge**：高阈值触发一次,必须低于 low 阈值清除后才能再次触发;
- **counter**：每次越过 high 都累计 pending trigger。

---

## 3. 检测入口——GC 后、分配慢路径、gc_end

`lowMemoryDetector.hpp:33-62` 的注释直接给出边界:

- heap memory 在 GC 完成时和分配慢路径检测;
- Code Cache 在分配和释放时检测;
- threshold 为 -1 表示不支持;
- threshold 为 0 表示不执行检测。

### 当前 usage：GC 后与分配慢路径

`detect_low_memory()`(lowMemoryDetector.cpp:81-102)遍历池,读取 `pool->get_memory_usage()`,把 usage 喂给 `set_gauge_sensor_level`。有 pending request 才 `Service_lock->notify_all()`。

分配慢路径走 `detect_low_memory(MemoryPool*)`(lowMemoryDetector.cpp:104-125),同样只检查启用了 sensor 且 high threshold 非零的池。TLAB 快路径不做这件事,所以**快路径分配零开销,慢路径才承担检测成本**。

### collection usage：只在 gc_end 检测

`detect_after_gc_memory()`(lowMemoryDetector.cpp:127-147)读取的是 `pool->get_last_collection_usage()`,并调用 `set_counter_sensor_level`。它由 `GCMemoryManager::gc_end` 在设置 last collection usage 后调用,所以 collection threshold 的语义天然绑定“某次 GC 结束”。

三处入口因此各有语义:

1. `detect_low_memory()`：批量扫描当前 usage;
2. `detect_low_memory(pool)`：分配慢路径检查当前池;
3. `detect_after_gc_memory(pool)`：GC 结束检查最近一次 collection usage。

这一步只改变 SensorInfo 状态,**不直接调 Java**。

---

## 4. SensorInfo——迟滞与两种语义

`SensorInfo`(lowMemoryDetector.hpp:116-212)保存四类状态:

- `_sensor_on`：Java 传感器当前是否 on;
- `_sensor_count`：已经触发的累计次数;
- `_pending_trigger_count`：等待 ServiceThread 处理的 trigger 数;
- `_pending_clear_count`：等待处理的 clear 数。

### gauge：高低阈值形成迟滞

`set_gauge_sensor_level`(lowMemoryDetector.cpp:206-239):

- usage crossing high 且 sensor off → pending trigger++;
- usage crossing low 且 sensor on → pending clear++;
- 处于 high/low 之间 → 不变;
- 已经触发但仍在 high 以上 → 不重复触发。

所以 usage threshold 的“只报一次”不是偶然,而是高/低双阈值形成的 hysteresis。

### counter：每次越过 high 都累计

`set_counter_sensor_level`(:261-277)的规则更直接:

- usage crossing high → `_pending_trigger_count++`,无论 sensor 当前是否 on;
- usage crossing low → 允许 clear。

这正是 collection usage threshold 的需求:每次 GC 后仍然超过阈值,都应让 Java 侧的 count 递增。

### pending 由 ServiceThread 消费

`process_pending_requests`(:283-291)根据 pending clear/trigger 分派 `clear` 或 `trigger`。真正的 `trigger`(lowMemoryDetector.cpp:293-343)会:

1. 构造 Java `MemoryUsage`;
2. 用 `JavaCalls::call_virtual` 调 `Sensor.trigger(int, MemoryUsage)`;
3. Java 侧 `PoolSensor` / `CollectionSensor` 再构造 JMX Notification;
4. 回到锁内更新 `_sensor_on`、`_sensor_count`、pending 计数。

如果构造 `MemoryUsage` 时发生 OOME,源码降级调用 `Sensor.trigger(int)`(注释 :307-309),本次 pending 仍被处理,但不发送带 usage 的通知。

全链路是:

```text
VM/分配线程检测
  → Service_lock 下更新 pending
  → 唤醒 ServiceThread
  → Java Sensor.trigger(...)
  → PoolSensor/CollectionSensor
  → JMX Notification
```

---

## 5. GC 通知——每次 GC 一份完整账本

内存阈值通知是“条件触发”;GC 通知则是“每次 GC 必发”(开启时)。GC 结束时的入口是:

```cpp
if (is_notification_enabled()) {
  GCNotifier::pushNotification(this, _gc_end_message, GCCause::to_string(cause));
}
```

### 开关由监听器自动打开

Java 侧 `GarbageCollectorExtImpl.addNotificationListener` 在从“没有监听器”变为“有监听器”时调用 `setNotificationEnabled(this, true)`,再通过 JMM 的 `jmm_SetGCNotificationEnabled`(management.cpp:1893-1898)设置 `_notification_enabled`。移除最后一个监听器时对称关闭。

所以应用只要 addNotificationListener,GC notification 就开始产生,不需要额外手动开 flag。

### 先复制账本,再入队

`GCNotifier::pushNotification`(gcNotifier.cpp:45-54)先 new 一个 `GCStatInfo`,调用 `mgr->get_last_gc_stat(stat)`复制最近一次完成的 GC 账本,再构造 `GCNotificationRequest` 入链表。源码注释特别提醒:复制账本时下一次 GC 可能已经开始,所以通知必须持有自己的深拷贝。

请求在 `Service_lock` 下尾插并唤醒 ServiceThread。消费端 `sendNotificationInternal`(gcNotifier.cpp:189-224)锁外构造 Java 对象:

- before/after 每池一个 `MemoryUsage`;
- GC manager 名称、action、cause;
- `com.sun.management.GcInfo`;
- 最后 `GarbageCollectorExtImpl.createGCNotification` 发 JMX Notification。

因此 GC 通知包含的是一次完整账本,不会随着后续 GC 改写。

---

## 6. WriteableFlags——运行时反向控制面

第三条线不是通知,而是**运行时改 JVM 参数**。`jcmd VM.set_flag`、JMX `HotSpotDiagnosticMXBean.setVMOption`、`VM.set_flag` DCmd 都汇到 `WriteableFlags::set_flag`:

```cpp
// writeableFlags.cpp:243-266(截取核心,逐字)
JVMFlag::Error WriteableFlags::set_flag(const char* name, const void* value,
                                        JVMFlag::Error(*setter)(...),
                                        JVMFlag::Flags origin,
                                        FormatBuffer<80>& err_msg) {
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

三段检查:

1. 参数为空 → `MISSING_NAME` / `MISSING_VALUE`;
2. `find_flag` 找不到 → `INVALID_FLAG`;
3. 找到但 `is_writeable()` 为 false → `NON_WRITABLE`。

“writeable”不是运行时猜出来的,而是 flag 定义时通过 `manageable` 或 `product_rw` 等宏属性声明的。`PrintGC` 这类不可写 flag 即使存在也会被拒绝;`HeapDumpBeforeFullGC` 等 manageable flag 才能通过管理面修改。

---

## 7. 误解澄清与收网

1. **内存阈值检测是不是只在 GC 后发生?** 不是。还有分配慢路径;Code Cache 还有分配/释放路径。
2. **usage threshold 与 collection usage threshold 是同一种语义吗?** 不是。前者 gauge + 迟滞,后者 counter + 每次 GC 后检测。
3. **GC 线程直接调 Java 通知吗?** 不是。GCNotifier 复制账本入队,ServiceThread 再构造 GcInfo 并回调 Java。
4. **GC 通知是不是默认一直开启?** 不是。Java 侧添加监听器时才打开 `_notification_enabled`。
5. **所有 flag 都能运行时改吗?** 不是。只有定义为 manageable/product_rw 等可写属性的 flag 能改。

把这一篇压成三句话:

- **检测只更新状态,通知由 ServiceThread 发送**；gauge 和 counter 分别解决“只报一次”和“累计报多次”。
- **GC 通知先深拷贝 GCStatInfo 再排队**,Java 侧收到的是完整、稳定的 GcInfo。
- **WriteableFlags 是反向控制面**,JMX、attach、DCmd 三条入口统一经过 `set_flag` 的可写性检查。

33 域收官。下一个域离开 VM 内部管理——网络 I/O: TCP Socket 从 Java 到 epoll 的链路。

> → [43-nio-net/01 — TCP Socket — PlainSocketImpl + ServerSocket + epoll](openjdk/vol-02/43-nio-net/01-tcp-epoll.md)