# JMX / Management — 文章大纲

> vol-05 · 域 33 · 🟡 B
>
> **→ 从 JVMTI**：JVMTI 是面向 agent 的可编程底层接口。JMX 是面向人/监控系统的标准化运维接口——通过 jconsole/jmxterm 直接查看 JVM 运行状态。

## 叙事计划

**开篇场景**：线上 JVM 内存快满了——你打开 jconsole，连接远程 JVM 的 JMX 端口，看到 HeapMemoryUsage.used=3.8GB/4GB。你点"执行 GC"按钮——JVM 触发 Full GC——内存降到 1.2GB。这就是 JMX：运维人员通过标准 MBean 读取/操作 JVM 状态。

**MBean 架构**：`PlatformManagedObject` → 一系列平台 MXBeans：
- `MemoryMXBean`：堆/非堆内存使用、GC 触发
- `ThreadMXBean`：线程数、CPU 时间、死锁检测
- `ClassLoadingMXBean`：已加载类数、总加载类数
- `RuntimeMXBean`：JVM 启动时间、输入参数
- `GarbageCollectorMXBean`：每个 GC 的收集次数+时间
- `OperatingSystemMXBean`：系统 CPU/内存/swap

每个 MXBean 的 C++ 实现（如 `memoryService.hpp`、`threadService.hpp`）通过 JNI 或直接内存访问读取对应的 JVM 内部计数器。JMX 查询路径：JMX connector → MBeanServer → Platform MXBean 实现 → JVM 内部数据结构。

**通知机制**：`MemoryNotification` 在内存超过阈值时推送到监听器（不是轮询）——`LowMemoryDetector` 线程周期检查。为支持低内存检测而设计——轮询的时延可能导致 OOM 时来不及通知。

**连接器**：RMI connector（默认）、JMXMP。jconsole 通过 RMI stub 连接 JVM 的 JMX agent（在 `-Dcom.sun.management.jmxremote.port=7091` 指定的端口监听）。

**设计权衡**：JMX 的轮询开销——每次 jconsole 刷新调用 10+ MXBeans 的 getter，每个 getter 可能需要获取锁（如 MemoryMXBean 的 `getHeapMemoryUsage()` 需要 GC 统计数据的一致性快照）。对于频繁监控（每秒查询），这可能成为 CPU 开销源。

## 核心悬念

**运维人员不读源码、不用命令——怎么通过 jconsole 的连接按钮"看到"JVM 堆的大小、线程的数量、GC 的次数？答案藏在 Platform MXBeans 的 C++ 实现里——它们是对 JVM 内部计数器的标准化包装。**

→ 下一域：JMX 是"主动查询"——运维人员/监控系统问 JVM "你的堆多大"。NMT 是"被动记录"——JVM 自己记录每次 malloc/mmap，等你想查时再看。

## 预估

1 篇，3 层递进，1200-1600 行。
