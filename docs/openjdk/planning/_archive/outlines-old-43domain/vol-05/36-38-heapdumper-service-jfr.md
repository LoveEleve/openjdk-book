# HeapDumper / ServiceThread / JFR — 三合一快速大纲

> vol-05 · 域 36-38 · 🟡 B/B/C

## 域 36 HeapDumper 🟡 B

**→ 从 Attach API**：`jmap -dump:live` 通过 Attach API 触发 heap dump——HeapDumper 把整个 Java 堆序列化为 HPROF 文件。

**HPROF 格式**：二进制格式，header（"JAVA PROFILE 1.0.2"）+ record 序列。每条 record：tag(1byte) + time(4bytes) + length(4bytes) + data。关键 record 类型：`HEAP_DUMP`（包含所有对象+类的完整堆快照）、`CPU_SAMPLES`（采样 profiling）、`ALLOC_SITES`（分配热点）。`heapDumper.cpp:2112` 生成 dump。

**并行转储**：`HeapDumper::dump()` 在 safepoint 中执行——所有 Java 线程暂停。为了减少暂停时间，使用 `ParallelObjectIterator` 多线程遍历堆（G1 的 heap region 可以并行遍历每个 region 内的对象）→ 多个线程并发写 HPROF。大堆（100GB+）的 dump 时间仍然可能秒级（主要是遍历开销+磁盘 IO）。

**设计权衡**：`live` 选项触发 Full GC 后再 dump——只有 GC 可达对象出现在 dump 中。代价是 Full GC 暂停额外时间。非 `live` dump 包含死对象——文件更大但不用 GC。

## 域 37 ServiceThread 🟡 C

**→ 从 HeapDumper**：HeapDumper 的 low memory detection 触发 MemoryNotification——这个通知的投递不发生在 safepoint 内，由 ServiceThread 延迟执行。

**单后台线程出队任务**：`ServiceThread` 是 JVM 的后台任务执行器——一个永不退出的循环等待任务队列中的任务。典型任务：JVMTI 延迟事件投递、GC 通知、hidden class cleanup、JFR 检查点写入。每个任务是一个 `ServiceThread::Task` 对象——入队→ServiceThread 唤醒→执行→done。

**为什么需要独立线程**：这些任务不能在触发线程中直接执行——触发线程可能持有锁（如 JVMTI 事件在 safepoint 期间，不能调 agent 函数可能引起死锁）。ServiceThread 在一个干净的上下文中执行——无锁、无 safepoint 冲突。

## 域 38 JFR (Flight Recorder) 🟡 B

**→ 从 ServiceThread**：JFR 的磁盘刷新和 checkpoint 写入由 ServiceThread 调度——这是可观测性栈中最上层的工具。

**事件驱动录制**：不是轮询——JVM 在所有关键点主动 throw JFR 事件。每个事件是一个 `JfrEvent` 子类——包含时间戳、线程、栈追踪。事件写入线程本地的 `ThreadLocalBuffer`（无锁），buffer 满后 flush 到全局 `GlobalBuffer`，后台线程写出到 `.jfr` 文件。

**JFR 的事件类型**：Java 层事件（`jdk.jfr.Event` 子类——应用自定义事件）、JVM 事件（类加载/线程启动/GC 暂停/JIT 编译/异常/锁竞争/IO——开箱即用 124 种事件，定义在 `metadata.xml`）。每个事件带 metadata（描述、字段类型、阈值过滤）。

**Chunk 文件格式**：`.jfr` 文件由多个 chunk 组成——每个 chunk 是独立的（可被 JDK Mission Control 单独解析）。chunk 包含 metadata（事件类型定义）、checkpoint（常数池——类名/方法名/线程名映射到 ID）、事件数据。chunk 化设计支持无限录制——旧 chunk 可被丢弃（`maxsize` 限制下）而不影响新数据。

**系统开销**：正常配置下 ~1-2% CPU 开销。大部分开销来自栈追踪收集（`AsyncGetCallTrace`）和 I/O（磁盘写入）。`-XX:StartFlightRecording` 可在生产环境默认开启——JFR 被设计为"always-on"的可观测性工具。

## 核心悬念

**三合一的核心问题：怎么在一个运行中的 JVM 上，"拍照"整个堆的状态（HeapDumper → HPROF）、"订阅"后台任务的通知（ServiceThread）、"录制"数千个事件的连续流（JFR → .jfr 文件）——三个可观测性工具共用一个基础设施却服务完全不同的场景。**

→ vol-05 完。OpenJDK 源码分析全书 38 域结束。

## 预估

36-38 共 3 篇，3000-4000 行。
