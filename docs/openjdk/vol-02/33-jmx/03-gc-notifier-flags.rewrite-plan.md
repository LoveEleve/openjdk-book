# 33-jmx/03-gc-notifier-flags 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释内存阈值通知、GC 通知、以及运行时可写 flags 三条管理面通道——谁检测、谁记账、谁通知、谁真正把消息发给 Java

## 1. 选题判断

现稿已有很强事实基础：
- `LowMemoryDetector` 三个检测入口
- `SensorInfo` 的 gauge/counter 状态机
- `GCNotifier` 深拷贝账本 + ServiceThread 发送通知
- `WriteableFlags::set_flag` 三入口一实现

真正该打穿的困惑更集中：

**内存快满时，JMX 通知是谁、在什么时候决定触发的？为什么 usage threshold 只报一次，而 collection threshold 会累计？GC 通知和内存阈值通知为什么可能乱序出现？运行时改 flag 又怎么和这套通知面挂在一起？**

## 2. 一句话顿悟

**检测、记账、发通知是三件分离的事。`LowMemoryDetector` 只在 VM 线程/分配慢路径下更新传感器 pending 状态，真正调 Java `Sensor.trigger(...)` 的是 ServiceThread；GC 通知也不是 GC 线程直接发，而是 `GCNotifier` 把 GCStatInfo 深拷贝成请求排队，ServiceThread 再构造 `GcInfo` 通知 Java。WriteableFlags 则是反向控制面：JMX/attach/DCmd 三条入口最后都汇到同一个 `set_flag`。**

## 3. 总图

```text
检测入口
  1) GC 后 track_memory_usage -> detect_low_memory()
  2) 分配慢路径 -> detect_low_memory_for_collected_pools()
  3) gc_end -> detect_after_gc_memory()

状态机
  SensorInfo
    gauge  : 高阈值触发一次,低阈值以下才清除
    counter: 每次越过高阈值都累计
    pending_trigger / pending_clear

发送
  ServiceThread
    process_sensor_changes -> Sensor.trigger(...)
    GCNotifier::sendNotificationInternal -> GarbageCollectorExtImpl.createGCNotification(...)

反向控制
  JMX / attach / DCmd
    -> WriteableFlags::set_flag(...)
```

## 4. 结构大纲

### 第一节：开场困惑——“谁在什么时候发现内存快满”

- 从 threshold.exceeded / collection.threshold.exceeded / GC notification 三种通知切入
- 点出：检测、排队、发送不是一回事
- 埋主线：ServiceThread 是真正通知发送者

### 第二节：两个朴素方案为什么都不对

1. 每次分配都立刻发 Java 通知
2. 所有阈值都按同一种“超过就报”语义处理

结论：检测必须轻量、通知必须异步；gauge/counter 两套语义解决“只报一次”和“累计报”两种需求。

### 第三节：检测入口——GC 后、分配慢路径、gc_end

- `LowMemoryDetector` 头注释
- `detect_low_memory()`
- `detect_low_memory_for_collected_pools()`
- `detect_after_gc_memory()`
- 慢路径才查,快路径零开销

### 第四节：SensorInfo——迟滞与两种语义

- `set_gauge_sensor_level`
- `set_counter_sensor_level`
- pending 计数、clear/trigger 分离
- `Sensor.trigger(int, MemoryUsage)` 与 OOME 降级路径

### 第五节：GC 通知——每次 GC 一份完整账本

- `GCNotifier::pushNotification`
- `GCNotifier::sendNotificationInternal`
- `createGcInfo`
- 深拷贝账本 + ServiceThread 发送
- 与 01/02 篇账本/JMM 链路对齐

### 第六节：WriteableFlags——运行时反向控制面

- `jmm_SetVMGlobal`
- `WriteableFlags::set_flag`
- JMX / attach / DCmd 三入口一实现
- `manageable` / `product_rw` / `NON_WRITABLE`

### 第七节：误解澄清与收网

## 5. 失败方案

1. 每次检测都直接调 Java 通知
2. usage / collection usage 共用同一种触发语义

## 6. 证据清单

- `src/hotspot/share/services/lowMemoryDetector.hpp:33-62`
- `src/hotspot/share/services/lowMemoryDetector.hpp:116-212`
- `src/hotspot/share/services/lowMemoryDetector.hpp:235-277`
- `src/hotspot/share/services/lowMemoryDetector.cpp:81-147`
- `src/hotspot/share/services/lowMemoryDetector.cpp:206-277`
- `src/hotspot/share/services/lowMemoryDetector.cpp:283-360`
- `src/hotspot/share/services/gcNotifier.cpp:45-224`
- `src/hotspot/share/services/management.cpp:1569-1593`
- `src/hotspot/share/services/management.cpp:1831-1900`
- `src/hotspot/share/runtime/flags/writeableFlags.cpp:243-266`

## 7. 完成后 review

- 删除代码后，能否复述“检测/记账/通知三分离”
- 是否讲清 gauge / counter 两种语义
- 是否讲清 GC 通知深拷贝账本再排队
- 是否讲清 WriteableFlags 三入口一实现
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验