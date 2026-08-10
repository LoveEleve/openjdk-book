# 03. 内存快满时怎么得到通知？— GC Notifier + LowMemory + Flags

> 🟡 Working | 2 KP 中的通知系统
> 读者处境: 应用需在 heap 达到 80% 时收到警告→初始化 cache eviction。LowMemoryDetector 在 threshold exceeded→send Java notification。

### 1. "LowMemoryDetector — per-pool threshold"

场景: `MemoryPoolMXBean.setUsageThreshold(80% * max)` → LowMemoryDetector 跟踪各 pool 使用→超阈值→ `sendNotification(MEMORY_THRESHOLD_EXCEEDED)`。

**LowMemoryDetector** (`services/lowMemoryDetector.hpp/cpp:40-200`):
```
LowMemoryDetector::detect_low_memory():
  for each MemoryPool with threshold set:
    if (pool.used() > threshold) AND (previous was below threshold):
      → trigger sensor → notify listeners via JMX
      → post_event: ManagementFactory emits MemoryNotificationInfo
```
- 源码: `services/lowMemoryDetector.hpp:40-100` + `lowMemoryDetector.cpp:50-200`
- 关键设计: 只在 GC cycle 中检测——GC 后 usage 变→trigger sensor check。非 GC 期间不主动检查(减少 overhead)
- [C++: `SensorInfo` per sensor: trigger_count/trigger_time。`clear_sensor()` in GC begin(非 low memory)→`process_sensor()` in GC end(if usage > threshold)]

### 2. "GC Notifier — GarbageCollectionNotification"

场景: `com.sun.management.GarbageCollectorMXBean` 添加 NotificationListener → 每次 GC 后 receive notification with GC info。

**GC Notifier** (`services/gcNotifier.hpp/cpp:40-200`):
```
GcNotifier::post_gc_notification():
  → GcInfoBuilder create(GC details: start, end, before/after memory usage)
  → GarbageCollectionNotificationInfo::from(builder)
  → sendNotification(GC_NOTIFICATION)
```
- 源码: `services/gcNotifier.hpp:40-80` + `services/gcNotifier.cpp:50-200`
- 关键设计: GC notification 含 GC id/name/cause/duration + before/after MemoryUsage of each pool→JConsole 用此数据显示 GC history

### 3. "WriteableFlags — 运行时改 JVM 参数"

场景: `jcmd <pid> VM.set_flag PrintGC true` → writeableFlags → 修改 JVM flag at runtime。

**WriteableFlags** (`services/writeableFlags.hpp/cpp:40-150`):
```
WriteableFlags::set_flag(flag_name, value):
  → find flag → check writable(不是所有 flag 都可运行时改)
  → update: flag->set_bool / flag->set_int(value)
```
- 源码: `services/writeableFlags.hpp:30-80` + `writeableFlags.cpp:40-150`

---

### 核心悬念

**"LowMemoryDetector 在 GC 后检测 pool threshold→notify JMX listeners。GC Notifier 每次 GC 发 notification。WriteableFlags 允许运行时改 JVM 参数。"** — 下一篇: 域34 NMT。

> → 域34 NMT
