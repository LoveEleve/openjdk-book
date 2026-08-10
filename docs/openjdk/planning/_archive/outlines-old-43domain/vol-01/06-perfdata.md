# PerfData/jstat — 文章大纲

> vol-01 · 域 06 · 🟡 B | 2026-08-07 | 拓扑排序 #6
> 依赖：OS 抽象层（mmap 共享内存）+ Arguments（-XX:+UsePerfData 控制开关）

## 叙事计划

**开篇场景**：你敲 `jstat -gc <pid> 1000`，每秒钟看到 GC 统计——但 jstat 没连 JMX、没走 socket、没调 JVMTI。它只是读了一个 mmap 共享内存文件：`/tmp/hsperfdata_<user>/<pid>`。这个文件是 JVM 在启动时用 `mmap` 创建的——性能计数器直接写进共享内存，jstat 直接读，零 RPC 开销。

**第一层：PerfData——性能计数器的类型系统**

`PerfData`（`perfData.hpp:244`）是计数器的基类。命名空间 `CounterNS`（`:39`）分门别类：`java.ci` / `java.cls` / `java.gc` / `java.property` / `java.rt`。四种变体：`PerfLongConstant`（不可变常量）、`PerfLongVariant`（可变值）、`PerfLongCounter`（只增计数）、`PerfStringConstant`（字符串常量）。不同 GC 每次 collection 只 `set_value(new_count)`，不分配内存、不加锁——共享内存里已经是最终位置。

**第二层：PerfMemory——mmap 共享内存文件**

`PerfMemory::create_memory_region()`（`perfMemory.hpp:126`）用 `mmap` 创建 `hsperfdata` 共享文件（`perfMemory.cpp:43`）。文件头 `PerfDataPrologue`（`perfMemory.hpp:61-72`）：魔数 `0xcafec0c0`（`:62`）、字节序、版本号、条目数、`accessible` 标志（控制 jstat 是否可读——初始为 0，JVM 初始化完成后设为 1）。

**第三层：StatSampler——周期性采样**

`StatSampler`（`statSampler.hpp:41`）在后台周期任务中运行。不是每个计数器都实时更新——只有注册到 `_sampled` 列表的才被定期 `sample()`。采样频率 `PerfDataSamplingInterval` 默认 50ms（`globals.hpp:2431`）。负责把 JVM 内部状态（堆使用量、线程数、类加载数）同步到 PerfData 计数器中。

**第四层：jstat 怎么读到这些数据**

jstat 是纯 Java 工具——它找到目标进程的 `/tmp/hsperfdata_<user>/<pid>` 文件，`mmap` 到自己的地址空间，解析 `PerfDataPrologue` 头部，遍历计数器表，匹配用户请求的计数器名（如 `sun.gc.collector.0.time`），输出格式化结果。整个过程不受 JVM safepoint 影响——共享内存读不阻塞目标进程。

**设计权衡**

一、共享内存 vs RPC。JMX 需要网络调用和序列化，jstat 直接 mmap 读——性能差距巨大。代价是文件格式必须跨进程兼容（字节序、结构体对齐）。

二、常量 vs 计数器 vs 变量。`PerfLongConstant` 只在初始化时写一次，之后只读——不需要锁。`PerfLongCounter` 用原子递增。`PerfLongVariant` 需要加锁写。分层减少同步开销。

## 核心悬念

**jstat 没连 JMX、没走 socket，怎么拿到别的进程的 JVM 性能数据？一个 mmap 共享内存文件怎么被 JVM 写、jstat 读——互不阻塞？**

**→ 下一域**：计数器告诉了你 JVM 在做什么，但你想看更本质的东西——`java.lang.Class` 对象在 JVM 里到底存在哪里？`System.identityHashCode()` 的值怎么和对象头关联？Java 语言类型在 C++ 中怎么表示？Java Class Mirrors 篇见。

## 预估

1 篇，4 层递进，预估 1000-1500 行。
