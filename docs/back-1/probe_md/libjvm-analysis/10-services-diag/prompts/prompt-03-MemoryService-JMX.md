# PROMPT: 请撰写 03-MemoryService-JMX.md

## 〇、背景与使用场景

### 你在生产环境中每天都在经历的

你打开了 JConsole，连接到 `localhost:1099`，进入 MBeans 标签 → `java.lang` → `Memory` → Attributes：
```
HeapMemoryUsage:
  committed: 4194304 KB
  init:      8388608 KB
  max:       8388608 KB
  used:      2756488 KB  ← 就是这个数字！Heap 当前使用了 2.6 GB
```
然后切到 `java.lang` → `MemoryPool` → `G1 Eden Space` → Usage：
```
  used: 134217728  (128 MB)  ← Eden 当前使用
  committed: 268435456  (256 MB)
  max: 805306368  (768 MB)
```
→ JVM 内部发生了什么？JConsole 通过 JMX RMI 调用 `MemoryMXBean.getHeapMemoryUsage()` → JDK 层的 `MemoryImpl` 调用 native → `MemoryService::get_memory_manager("java.lang:type=Memory")` → `CollectedHeap::memory_pools()` 返回的 Pool 列表 → 对每个 Pool 调用 `get_memory_usage()` → 返回 `MemoryUsage` 对象（used/committed/max/init）。对于 `CollectedMemoryPool`（如 G1 Eden），`used` 的值来自 `_after_gc_usage` 字段——该字段只在 GC 结束时更新（`MemoryService::gc_end()` → `CollectedMemoryPool::record_collection_usage()`）。如果两次 GC 之间 Eden 的 `used` 从 128MB 涨到 256MB——JConsole 在下次 GC 之前每秒轮询看到的数字都是 128MB（旧值）！这是因为 `CollectedMemoryPool` 的 `used_in_bytes()` 返回缓存的 `_after_gc_usage`，不是实时查询 G1 的 `_allocated_bytes`。

你打开了 VisualVM → Monitor 标签 → 看到"GC Time %"曲线：
```
GC activity: 4.7% of total runtime
   Young GC: 1.2% (avg 42 ms, count: 3182)
   Full GC:  0.0% (count: 0)
```
→ JVM 内部发生了什么？VisualVM 读的是 `GarbageCollectorMXBean` 的 `CollectionCount` + `CollectionTime` 属性。每次 GC 后 `MemoryService::gc_end()` → `GCMemoryManager::gc_end()` → 更新 `_num_collections` 计数器 + `_accumulated_timer`（`_accumulated_timer->add(GC elapsed time)`）。VisualVM 计算 GC Time % = `CollectionTime / uptime`。如果看到 GC 时间 > 5%——说明 GC 压力大，需要调参。如果 Full GC 次数从 0 变成 1——线上告警就该亮了。

你执行了这个命令：
```bash
$ jcmd 12463 VM.native_memory summary
# 输出在 [10-02] 中已展示——Heap / Class / Thread / Code / GC / ...各区域
```
→ 和 VisualVM/JConsole 的数据源不同，NMT 的数据来自 `os::malloc()` 的原子计数器和 `mmap` 追踪。MemoryService 管理的是 Java 堆（`CollectedMemoryPool`）和非堆（`CodeHeapPool`、`MetaspacePool`）的 **逻辑视图**——用于 JMX 监控。NMT 追踪的是 JVM 在 C++ 层 `os::malloc()` / `os::realloc()` / `os::free()` / `mmap()` 的**物理内存使用**——用于排查 native 内存泄漏。

你部署了 Prometheus JMX Exporter，在 Grafana 面板上看到：
```
jvm_memory_bytes_used{area="heap"}      2.7 GB
jvm_memory_bytes_used{area="nonheap"}   142 MB
jvm_memory_pool_bytes_used{pool="G1 Eden Space"}   168 MB
jvm_memory_pool_bytes_used{pool="G1 Old Gen"}      2.1 GB
jvm_gc_collection_seconds_count{gc="G1 Young Generation"}  3241
jvm_gc_collection_seconds_sum{gc="G1 Young Generation"}    142.8
```
→ JVM 内部发生了什么？Prometheus JMX Exporter 启动一个 HTTP endpoint → 通过 JMX 读取所有 `java.lang:type=Memory` 和 `java.lang:type=MemoryPool` 的 MXBean 属性 → 转换成 Prometheus 格式 → Grafana 面板展示。和 JConsole 走的**完全同一条路径**——JMX → MXBean → MemoryService。唯一的区别是 Prometheus 每 15 秒采集一次（pull），JConsole 每秒轮询——数据源是同一个。

你安装了 Arthas，执行：
```bash
$ dashboard
ID   NAME                    GROUP          PRIORITY  STATE      %CPU     TIME
1    main                    main           5         WAITING    0.0      0:0.92
17   http-nio-8080-exec-1    main           5         RUNNABLE   23.1     0:45.21
...
Memory                    used     total    max      usage    GC
heap                      2756M    8192M    8192M    33.66%   G1 Young Generation
g1_eden_space             120M     256M     -1       46.87%
g1_survivor_space         16M      32M      -1       50.00%
g1_old_gen                2620M    7904M    8192M    33.13%
```
→ JVM 内部发生了什么？`arthas dashboard` 底层直接读取 `ManagementFactory.getMemoryMXBean()` 和 `ManagementFactory.getMemoryPoolMXBeans()` ——和 JConsole 是**同一个数据源**：都是 MemoryService 管理的 Pool 对象。`dashboard` 每秒刷新一次，但 `CollectedMemoryPool.used_in_bytes()` 只在 GC 后才更新——所以你看到的 Eden 使用量其实是**上一个 GC 结束时的快照**，不是"此时此刻"的精确值。

```bash
$ memory
Affect(row-cnt:1) cost in 15 ms.
  usage   max   used   total   memory_pool_name
  70.4%   N/A   90M    128M    g1_eden_space
  30.2%   8G    2.6G   8G      g1_old_gen
```
→ 同样，Arthas `memory` 命令也是直接读取 `MemoryPoolMXBean.getUsage()` → `getUsed()`，也就是 `CollectedMemoryPool._after_gc_usage` 的缓存值。Arthas 和 JConsole 在功能上镜像——区别是 Arthas 是命令行交互，JConsole 是 GUI 面板。

### 相关生态工具（本文分析的源码的"表兄弟"）

- **JConsole / VisualVM / Java Mission Control**：这三者都是 JMX Client，通过 `ManagementFactory.getPlatformMBeanServer()` 获取 `MBeanServer` 连接，读取 `java.lang:type=Memory` / `java.lang:type=MemoryPool` / `java.lang:type=GarbageCollector` 等 MXBean 的属性。它们的数据都来自 MemoryService 维护的 `_pools_list` 和 `_managers_list`。
- **Prometheus JMX Exporter / Jolokia**：Prometheus 通过 JMX Exporter 的 HTTP endpoint 读取 MXBean 数据；Jolokia 提供 JMX-to-REST 桥。两者都是 JMX → HTTP 的协议转换器——底层数据源仍然是 MemoryService。
- **Elastic APM / Datadog / NewRelic**：APM agent 通过 Instrumentation API (`premain`/`agentmain`) 加载到 JVM 中 → 直接调用 `ManagementFactory.getMemoryMXBean()` 或 `ManagementFactory.getMemoryPoolMXBeans()` → 将数据上报到 APM 后端。读取路径和 JConsole 完全相同。
- **Arthas `dashboard` / `memory` / `jvm`**：通过 Attach 加载 agent.jar → 在 JVM 内获取 MXBean 引用 → 格式化输出。和本文的 MemoryService 的关系：Arthas 读的是 MemoryService 暴露的 MXBean 接口——它是消费者，MemoryService 是生产者。

### 生产环境的实践要点

**Monitor 采样频率设置**：JConsole/VisualVM 默认每秒 1 次（1Hz）轮询 MemoryMXBean。对于 GC 压力不大的应用，这是合理的。但如果 GC 每秒 10 次以上（高吞吐低延迟场景），每秒 1 次的采样会漏掉大量 GC 事件——"GC Time %"曲线看起来比实际的低。传统的 JMX 轮询无法捕获高频 GC 事件的精确时序。JFR（Java Flight Recorder）能记录每次 GC 事件的精确时间戳——这就是为什么 JFR 更适合性能分析而 JMX 更适合容量监控。

**MemoryPool usage 更新是实时的还是轮询的？** 答案：**都不是——是事件驱动的，但不实时**。`CollectedMemoryPool` 的 `_after_gc_usage` 在每次 GC 结束的 `MemoryService::gc_end()` 中更新。但如果一次 Full GC 持续 30 秒——在这 30 秒内 GC 正在进行中，Eden 的 usage 还是 30 秒前的值。JMX client 在 GC 期间轮询到的 Eden usage 是过时的——因为 new `MemoryUsage` 还没有产生。这是 JMX 监测的一个重要限制——"GC 开始"到"JMX 看到新值"之间的窗口是 GC 持续时间 + pool usage 更新时间 + JMX 轮询间隔。

**`LowMemoryDetector` 的阈值预警**：你可以在 JConsole 的 `G1 Eden Space` → Notifications → `UsageThreshold` 设置为 80%。JConsole → `MemoryPoolMXBean.setUsageThreshold(0.8 * max)` → 底层调用 `MemoryPool::usage_threshold()->set_high_threshold(value)`。之后每次 GC 结束 → `LowMemoryDetector::detect_low_memory()` 检查 `usage.used() > threshold` → 如果超过 → `SensorInfo._pending_trigger_count++` → ServiceThread 处理 pending 通知 → 推送 JMX `MemoryNotificationInfo("memory usage exceeded threshold")` 给 JMX client。这比轮询等待 JConsole 发现异常要快——GC 一结束就触发了。

### 生产常见陷阱

- **`_gc_manager` 悬空指针——GC 配置变更后旧的 JMX 连接出错**：`MemoryPool` 持有 `GCMemoryManager* _gc_manager` 指针——指向管理该 Pool 的 GC 管理器。如果在运行中动态切换 GC 实现（目前 JDK 不支持，但未来可能支持），旧的 `_gc_manager` 指针可能悬空。JMX client 持有的 `ObjectName`（如 `java.lang:type=MemoryPool,name=G1 Eden Space`）也会失效——因为新的 GC 实现可能不用 G1，池名称不同。
- **JMX RMI 连接中断导致监控盲区**：JConsole/VisualVM 连接的 RMI 端口如果被防火墙阻断，监控面板会断开——此时 GC 事件仍在发生，MemoryService 仍在更新数据，但没有任何 JMX client 在关注。解决：使用本地 attach（通过 PID 直接连接，不走网络）或使用 JFR dump 事后分析。
- **Prometheus JMX Exporter 的高基数问题**：`jvm_memory_pool_bytes_used{pool="G1 Eden Space"}` 这样的指标——如果应用有多个类加载器（如 OSGi），MemoryPool 的数量可能随模块增加而增长 → Prometheus 时间序列数量爆炸。控制在合理的 Pool 数量以内（标准的 G1 是 4 个 Pool）。
- **非 GC Pool（CodeHeapPool/MetaspacePool）的"实时"查询假象**：`CodeHeapPool::used_in_bytes()` 每次调用都从 `CodeHeap` 实时查询——但 `CodeHeap` 的状态在并发编译器中不是原子的。如果你在 `CodeCache::allocate()` 过程中查询（非同步），`used_in_bytes()` 返回的值可能是瞬态不一致的（分配了一半）。对于 JConsole 监控面板来说无关紧要（偏差可忽略），但如果基于这个值做精确的 CodeCache 容量管理——需要额外的同步。

### 背景概念速览

- **MXBean (JMX 标准接口)**：`java.lang.management.MemoryMXBean`、`MemoryPoolMXBean`、`GarbageCollectorMXBean`——这些是 JSR 174 定义的 JMX 规范。JVM 通过 `MemoryService` 维护的数据结构来回答 MXBean 的 `getMemoryUsage()` / `getCollectionCount()` 查询。MXBean 是接口，MemoryService 是数据提供方。
- **MBeanServer (JMX 运行时注册中心)**：`ManagementFactory.getPlatformMBeanServer()` 返回的平台 MBeanServer——所有 JVM 内置的 MXBean（Memory/Thread/GC/OS/ClassLoading）都在这里注册。JMX client 连接的就是这个 MBeanServer 的 RMI 适配器或直接 attach 连接。
- **GarbageCollectorMXBean (GC 指标标准接口)**：暴露 `getCollectionCount()`（GC 次数）和 `getCollectionTime()`（GC 总耗时毫秒）。每个 GC 管理器有一个对应的 MXBean——G1 的 young/mixed collection 由 `G1 Young Generation` MXBean 覆盖，full GC 可能由 `G1 Old Generation` MXBean 覆盖。
- **LowMemoryDetector (阈值预警)**：不是持续轮询——是事件驱动——在每次 GC 结束的 `MemoryService::gc_end()` 中才检测。这意味着"两次 GC 之间 Eden 使用量飙升"的情况不会触发通知——只有等到下一次 GC 结束才会检查阈值。如果你的 Eden 在 GC 之间达到 99%，但没有触发 GC → LowMemoryDetector 不检测 → 没有通知。这正是为什么 LowMemoryDetector 不能替代 GC 策略调优的原因。


## 一、任务 + 核心故事线（禁止做源码翻译机！）

读者学完了 [06-gc]——知道了 G1 怎么分配、怎么回收、怎么把对象从 Eden 搬到 Survivor/Old。读者学完了 [10-02]——知道了 `GC.class_histogram` 诊断命令怎么注册执行。但这两个阶段中间缺了一环：**GC 的内存数据（Eden 用了 80%、Old 区回收了 N 次）怎么从 `CollectedHeap` 流到 `java.lang.management.MemoryPoolMXBean`？** JConsole/VisualVM/JMC 面板上的每个数字，是谁在什么时候更新的？

**本文不是 JMX MBean 注册指南**——不需要解释 `ManagementFactory.getPlatformMBeanServer()` 怎么创建 MBeanServer。**本文也不是 G1 GC 实现教程**——不展开 `G1CollectedHeap::do_collection()` 的内部流程。本文的唯一目标：**追踪 GC 事件从 `GCMemoryManager::gc_end()` 到 `MemoryPoolMXBean.getUsage()` 的完整数据流**——从 `TraceMemoryManagerStats` RAII 采样、到 `LowMemoryDetector` 的阈值触发、到 `GCNotifier` 的 JMX 通知发送。

更具体地说：读者看到 JConsole 的 Memory 标签页，Eden Space 的 "Used: 120MB" 这个数字是谁更新的？答案是 `MemoryService::gc_end()` → `GCMemoryManager::gc_end()` → `CollectedMemoryPool::record_collection_usage()` → `_after_gc_usage` 字段。`LowMemoryDetector` 的阈值监控在每次 `gc_end()` 后检测 `usage > threshold` → 如果超过 → 触发 JMX 通知。

### 验证报告
- `sverklo_investigate(MemoryPool GCMemoryManager GCNotifier LowMemoryDetector TraceMemoryManagerStats)` → 发现：MemoryService 中央调度 + gcNotifier 通知 + lowMemoryDetector 预警
- `codegraph query "TraceMemoryManagerStats"` → memoryService.hpp:117-134
- `codegraph query "MemoryService::gc_end"` → memoryService.cpp:182
- `grep -n "set_universe_heap" memoryService.cpp` → 行 70，GC → services 桥梁
- `grep -n "memory_managers\|memory_pools" collectedHeap.hpp` → 行 439-440，虚函数接口
- `grep -n "detect_low_memory\|SensorInfo" lowMemoryDetector.cpp` → 行 81/106，检测 + SensorInfo 行 116

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 路径 | 模块 | 核心函数/类（行号） | 本文角色 |
|---|------|------|------|-------------------|---------|
| 1 | `memoryService.cpp` | `src/hotspot/share/services/memoryService.cpp` | services | `MemoryService::gc_begin()`(:167), `gc_end()`(:182), `set_universe_heap()`(:70) | ★★★ 中央调度——GC 事件到 JMX |
| 2 | `memoryService.hpp` | `src/hotspot/share/services/memoryService.hpp` | services | `TraceMemoryManagerStats`(:117-134) | ★★★ RAII 桥——GC 事件采样点 |
| 3 | `memoryPool.cpp/.hpp` | `src/hotspot/share/services/memoryPool.{cpp,hpp}` | services | `MemoryPool`(:hpp:45), `CollectedMemoryPool`(:hpp:142), `CodeHeapPool`(:hpp:149), `MetaspacePool`(:hpp:158) | ★★ 数据模型——内存池抽象 |
| 4 | `memoryManager.cpp/.hpp` | `src/hotspot/share/services/memoryManager.{cpp,hpp}` | services | `GCMemoryManager`(:hpp:136), `gc_begin/gc_end`(:hpp:169-173) | ★★ 数据模型——GC 管理器 |
| 5 | `gcNotifier.cpp/.hpp` | `src/hotspot/share/services/gcNotifier.{cpp,hpp}` | services | `GCNotifier::sendNotification()`(:cpp:165), `sendNotificationInternal`(:cpp:189) | ★★ 通知——GC 事件 → JMX |
| 6 | `lowMemoryDetector.cpp/.hpp` | `src/hotspot/share/services/lowMemoryDetector.{cpp,hpp}` | services | `LowMemoryDetector::detect_low_memory()`(:cpp:81/106), `SensorInfo`(:hpp:116) | ★★ 预警——阈值检测 + 触发 |
| 7 | `collectedHeap.hpp` | `src/hotspot/share/gc/shared/collectedHeap.hpp` | gc/shared | `memory_managers()`(:439), `memory_pools()`(:440) 虚函数 | ★★ 接口——GC 提供池/管理器 |
| 8 | `genMemoryPools.hpp` | `src/hotspot/share/gc/shared/genMemoryPools.hpp` | gc/shared | `ContiguousSpacePool`(:34), `GenerationPool`(:65) | ★ GC 端的池实现 |
| 9 | `management.cpp` | `src/hotspot/share/services/management.cpp` | services | `Management::initialize()` → MemoryService 初始化 | ★ 初始化触发点 |

**跨模块说明**：GC 的内存管理器/内存池对象由 GC 实现（`gc/shared/`）创建，但它们的类型在 `services/` 中定义。`CollectedHeap::memory_pools()` 返回 `GrowableArray<MemoryPool*>`——这是 gc → services 的唯一桥梁。

## 四、必须深度走读的核心概念

> 每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ `set_universe_heap()`——GC 到 MemoryService 的唯一桥梁

```
问题：
  ① MemoryService 怎么知道有哪些内存池和 GC 管理器？
     线索: memoryService.cpp:70-95, collectedHeap.hpp:439-440
     代码引证:
       void MemoryService::set_universe_heap(CollectedHeap* heap) {
         GrowableArray<MemoryPool*> gc_mem_pools = heap->memory_pools();
         _pools_list->appendAll(&gc_mem_pools);
         GrowableArray<GCMemoryManager*> gc_memory_managers = heap->memory_managers();
         _managers_list->appendAll(&gc_memory_managers);
       }
     答案方向: `CollectedHeap` 的虚函数 `memory_pools()` / `memory_managers()` 由每个
     GC 实现（G1/Parallel/Serial）覆盖。GC 在初始化时创建 `services/` 的 MemoryPool/
     GCMemoryManager 对象，CollectedHeap 只是保管它们。`set_universe_heap()` 在
     `Universe::initialize_heap()` 完成后被调用——一次性的桥梁建立。

  ② 如果 GC 实现运行中切换，MemoryPool 列表需要重建吗？
     线索: memoryService.cpp:70 — 只调用一次
     答案方向: JEP 不涉及动态 GC 切换。当前代码不支持——`set_universe_heap()` 只在
     VM 初始化时调用一次。如果未来需要动态切换 GC → MemoryService 需要重建
     `_pools_list` / `_managers_list`。这是 README §八 的深层问题之一。

  ③ CodeHeapPool 和 MetaspacePool——两个非 GC 池也注册在 MemoryService 中
     线索: memoryService.cpp:70-95 后续行
     答案方向: 除了 GC 池，MemoryService 还添加 CodeHeapPool（编译代码缓存）和
     MetaspacePool（类元数据）。它们的更新不经过 GC——在编译/清理时直接调用
     MemoryPool 的方法。三种池共用 MemoryPool 基类，但触发方式不同。
```

### 4.2 ★★★ TraceMemoryManagerStats——GC 到 JMX 的桥梁 RAII

```
问题：
  ① GC 怎么通知 MemoryService "我开始回收了 / 我回收完了"？
     线索: memoryService.hpp:117-134
     代码引证:
       class TraceMemoryManagerStats : public StackObj {
         private:
           GCMemoryManager* _gc_memory_manager;
           bool _countCollection; GCCause::Cause _cause;
         public:
           TraceMemoryManagerStats(GCMemoryManager* gc_memory_manager,
                                   GCCause::Cause cause) {
             initialize(gc_memory_manager, cause, true, ...);
           }
           ~TraceMemoryManagerStats() {
             MemoryService::gc_end(_gc_memory_manager, ..., _cause, ...);
           }
       };
     答案方向: GC 在回收前构造 `TraceMemoryManagerStats` → ctor 调用 `MemoryService::gc_begin()`；
     回收完成后析构 → dtor 调用 `MemoryService::gc_end()`。GC 不需要知道
     MemoryService/JMX 的存在——RAII 自动跟踪生命周期。

  ② gc_begin() 和 gc_end() 内部分别做了什么？
     线索: memoryService.cpp:167-198
     答案方向: gc_begin() → GCMemoryManager::gc_begin() 记录开始时间 + 更新
     _num_collections 计数 + 记录 GC 前 pool 使用量；
     gc_end() → GCMemoryManager::gc_end() 更新 pool 使用量 + 调用
     gcNotifier::sendNotification() + 调用 LowMemoryDetector::detect_low_memory()。
     这就是 JConsole 面板更新的完整路径：gc_end → pool usage update → JMX 通知。

  ③ 并发 GC（G1 concurrent mark）的 TraceMemoryManagerStats 是在什么时候构造/析构？
     线索: 需要搜索 G1 concurrent mark 代码
     答案方向: G1 的 concurrent mark 不在 safepoint 中——不构造 TraceMemoryManagerStats。
     GCMemoryManager 的 gc_begin/gc_end 只对 safepoint GC（young/mixed/full）触发。
     README §八 的问题——concurrent mark 开始/结束时不发 JMX 通知（不需要 STW）。
```

### 4.3 ★★★ MemoryPool 类型层次——为什么需要三种池？

```
问题：
  ① CollectedMemoryPool / CodeHeapPool / MetaspacePool 的区别是什么？
     线索: memoryPool.hpp:142-172
     代码引证:
       class CollectedMemoryPool : public MemoryPool {
         bool is_collected_pool() { return true; }
       };
       class CodeHeapPool: public MemoryPool {
         MemoryUsage get_memory_usage();
         size_t used_in_bytes() { return _codeHeap->allocated_capacity(); }
       };
       class MetaspacePool : public MemoryPool { ... };
     答案方向: CollectedMemoryPool — GC 管理的堆（Eden/Survivor/Old/Humongous）,
     `is_collected_pool() == true` → 有 collection usage（GC 后的使用量）；
     CodeHeapPool — 编译代码缓存（CodeCache），`is_collected_pool() == false` →
     没有 collection usage，只在编译/清理时更新；
     MetaspacePool — 类元数据（Metaspace），`is_collected_pool() == false` →
     在类加载/卸载时更新。三者通过 JMX `MemoryPoolMXBean` 暴露——JConsole 看到的
     每个 tab 对应一个 MemoryPool 子类。

  ② get_memory_usage() 返回的数据是什么时候更新的？
     答案方向: CollectedMemoryPool — GC end 时更新（`record_collection_usage()`）；
     CodeHeapPool — 实时计算（`used_in_bytes()` 每次调用都从 CodeHeap 查询）；
     MetaspacePool — 实时计算（`used_in_bytes()` 每次调用都从 Metaspace 查询）。
     所以 JConsole 每秒轮询 `getUsage()` → 只有 GC 池在 GC 后才精确更新
     ——非 GC 池的值是"实时的近似"。
```

### 4.4 ★★ LowMemoryDetector——从"stateless pool"算出"即将 OOM"

```
问题：
  ① detect_low_memory() 是轮询还是事件驱动的？
     线索: lowMemoryDetector.cpp:81-105
     代码引证:
       void LowMemoryDetector::detect_low_memory() {
         MutexLockerEx ml(Service_lock, Mutex::_no_safepoint_check_flag);
         for (int i = 0; i < num_memory_pools; i++) {
           MemoryPool* pool = MemoryService::get_memory_pool(i);
           SensorInfo* sensor = pool->usage_sensor();
           if (sensor != NULL && pool->usage_threshold()->high_threshold() != 0) {
             MemoryUsage usage = pool->get_memory_usage();
             sensor->set_gauge_sensor_level(usage, pool->usage_threshold());
           }
         }
       }
     答案方向: 事件驱动——在 `MemoryService::gc_end()` 后被调用。GC 结束了意味着
     堆使用量变化了——这时候检查阈值才有意义。中间不轮询——没有 GC 就没有检查。

  ② threshold 是谁设的？SensorInfo 的触发机制是什么？
     线索: lowMemoryDetector.hpp:116-165
     答案方向: JMX client 通过 `MemoryPoolMXBean.setUsageThreshold(long)` → Java 层
     → native 层 `MemoryPool::usage_threshold()->set_high_threshold(value)` 设置。
     SensorInfo 持有 `_pending_trigger_count` 计数器——`set_gauge_sensor_level()`
     对比 `usage > threshold` → 如果超过则 `_pending_trigger_count++`。
     LowMemoryDetector 的 ServiceThread 后续处理 `_pending_trigger_count > 0` → 触发 JMX 通知。

  ③ `_pending_trigger_count` 有上界吗？会不会溢出？
     线索: lowMemoryDetector.hpp:127（int _pending_trigger_count）
     答案方向: 是 `int` 类型——理论上如果阈值一直不降到 usage 以下，每次 gc_end()
     都会 +1 → 可能溢出。但实际问题不大——因为 `_pending_trigger_count > 0` 就会触发
     通知，通知后 JMX client 应该处理（清除阈值或处理）。如果 client 不处理，通知
     积压→被 jmx 队列限制。README §八 的深层问题之一。
```

### 4.5 ★★ GCNotifier——GC 事件怎么变成 JMX 通知

```
问题：
  ① GCNotifier 是每次 GC 都发通知，还是有过滤/节流？
     线索: gcNotifier.cpp:165-195
     答案方向: 每次 `gc_end()` → `GCNotifier::sendNotification()` 被调用。但内部
     `sendNotificationInternal()` 检查 `GCMemoryManager::is_notification_enabled()`
     ——JMX client 可以关闭通知。如果 `_notification_enabled == false` → 不发通知。

  ② 并发 GC 的高频事件（G1 concurrent mark start/end）也发通知吗？
     答案方向: 不——只有 safepoint GC（young/mixed/full）构造 `TraceMemoryManagerStats`，
     所以只有这些事件触发 `gc_end()` → `sendNotification()`。concurrent mark/cleanup
     不经过这个通知路径。G1 的 `FullGCNotificationManager` 做了特殊处理——只对
     full GC 发通知，young/mixed 量太大不发。

  ③ GC 完成时间和通知到达 JMX client 之间有多大的时间窗口？
     答案方向: 时间窗口 = gc_end() 内 `sendNotification()` 的执行时间 + ServiceThread
     调度延迟（如果通知是由 ServiceThread 异步处理的）+ JMX 层的 RMI/HTTP 传输延迟。
     在这个窗口里如果又触发了一次 GC → gc_end 再次调用 → 第二次通知在第一次通知之前
     被处理吗？如果是同步发送（在 gc_end 线程上），第二次 GC 会等第一次通知完成后
     才进入 gc_begin()；如果是异步（ServiceThread），通知可能乱序到达。
```

### 4.6 ★ 和 [06-gc] + [10-02] 的连接

```
问题：
  ① [06-gc] 教会读者 GC 做了什么——本文解释那些数据怎么暴露出去
     答案方向: [06-gc] → "G1 回收了 200MB" → 本文 → "谁记录了这 200MB？怎么变成
     JConsole 面板上的数字？" → 答案是 GC → TraceMemoryManagerStats RAII
     → MemoryService::gc_end() → pool usage update → JMX polling。

  ② [10-02] 教会读者 DCmd 框架——本文的 MemoryService 也暴露 DCmd 吗？
     答案方向: 不是直接暴露。但 DCmd 命令可以查询 MemoryService 的数据：
     `GC.class_histogram`（[10-02]§五）通过 `SystemDictionary::classes_do()` 遍历
     类对象——不经过 MemoryService。但用户可以在 JConsole 的 MBean tab 中看到
     MemoryPoolMXBean 暴露的所有数据——那是 JMX 路径。
```

## 五、文章结构

```
§〇 源文件清单（跨 services + gc/shared，标注每文件的模块归属和池类型）

§一 ★★★ 从 GC 到 JMX 的数据流——全景图
  ❓ CollectedHeap 的 memory_pools() 返回的到底是什么？
  ❓ 为什么有三个种类（CollectedMemoryPool / CodeHeapPool / MetaspacePool）？
  1.1 set_universe_heap() — GC 到 MemoryService 的一次性桥梁（行 70）
  1.2 _pools_list / _managers_list — MemoryService 的全局注册表
  1.3 三类内存池的数据更新时机差异

§二 ★★★ TraceMemoryManagerStats — GC 事件的 RAII 采样
  ❓ GC 怎么通知 MemoryService "我开始了/我结束了"？
  ❓ concurrent GC 的周期事件也触发这个 RAII 吗？
  2.1 ctor → MemoryService::gc_begin() → 记录时间 + 计数
  2.2 dtor → MemoryService::gc_end() → 更新 pool usage + 通知 + 预警
  2.3 和 GC 代码的连接点——G1 在哪里构造 TraceMemoryManagerStats

§三 ★★★ MemoryService::gc_end() 内部——通知链
  ❓ gc_end() 里面到底发生了什么？
  3.1 GCMemoryManager::gc_end() → 更新 pool 计数器
  3.2 GCNotifier::sendNotification() → JMX 通知
  3.3 LowMemoryDetector::detect_low_memory() → 阈值检测
  3.4 三者的执行顺序和并发安全性

§四 ★★ LowMemoryDetector — 阈值检测的完整机制
  ❓ 检测是事件驱动的还是轮询的？如果两次 GC 之间 usage 一直超标会怎样？
  4.1 SensorInfo 的 _pending_trigger_count 计数器
  4.2 set_gauge_sensor_level() — usage vs threshold 比较
  4.3 ServiceThread 的后续处理 — JMX 通知触发
  4.4 threshold 从 JMX client 到 native MemoryPool 的设置路径

§五 ★★ GCNotifier — GC 事件到 JMX 通知
  ❓ 每次 GC 都发通知吗？有过滤机制吗？
  5.1 sendNotificationInternal() → GCMemoryManager::is_notification_enabled()
  5.2 FullGCNotificationManager 对 young/mixed GC 的过滤
  5.3 通知的异步性（ServiceThread）和乱序风险

§六 ★ 和 [06-gc] + [10-02] 的连接
  6.1 [06-gc] → 理解 GC 做了什么 → 本文理解数据怎么暴露
  6.2 [10-02] → DCmd 命令可以查询 GC 数据，但不经过 MemoryService 的池

§七 GDB 验证 + 可证伪断言
```

## 六、写作要求

1. **★ `set_universe_heap()` 是第一交付物**：读者必须理解"`CollectedHeap::memory_pools()` 返回的对象是在 GC 初始化时创建的 services/ 对象"——GC 和 services 的桥梁建立在这里。

2. **★ `TraceMemoryManagerStats` 是第二交付物**：RAII 自动跟踪 GC 生命周期。不要在 GC 代码中找显式的 `MemoryService::gc_end()` 调用——它藏在析构函数中。

3. **★ `MemoryService::gc_end()` 内部的三个步骤必须顺序展开**：(1) pool usage update → (2) GCNotifier 通知 → (3) LowMemoryDetector 检测。这个顺序决定了"数据先更新，再通知，后预警"的语义。

4. **★ `LowMemoryDetector` 的"事件驱动"本质必须强调**：不是轮询——只在 gc_end() 后检测。这和"JConsole 每秒轮询 getUsage()"是不同的层次。

5. **★ 三类池的"数据更新时机"差异必须对比**：CollectedMemoryPool（GC 后更新）vs CodeHeapPool（编译时实时查询）vs MetaspacePool（类加载时实时查询）。

6. **★ GDB 验证必须覆盖 gc_end → pool usage → JMX 通知的完整链**：不能只在 MemoryService 层断点——需要验证池的值确实变化了。

7. **★ 和 [06-gc] 的连接要具体**：不说"GC 学过了"——要指定"在 G1 young GC 的 do_collection_pause() 中 → TraceMemoryManagerStats → gc_end → pool usage 更新"。

## 七、输出格式

- Markdown 文件，命名为 `03-MemoryService-JMX.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/10-services-diag/`
- 元信息头：
  ```
  > **阶段**：[10-services-diag]
  > **前置**：[06-gc], [10-02]
  > **依赖本文**：无（01/02/04 都可能提到 MemoryService 但不依赖）
  > **阅读收益**：理解 JConsole/VisualVM/JMC 监控面板数据源头——GC 事件如何通过 MemoryService 变成 MemoryPoolMXBean 的计数器
  ```

## 禁止行为

- ❌ 解释 JMX MBean 的注册流程（`MBeanServer.registerMBean()`）——这属于 `management.cpp` 的 JMX 实现层，和本文的"GC 数据流到 JMX"主线不同
- ❌ 深入 G1 的 GC 实现细节（`G1CollectedHeap::do_collection_pause`）——只需标注 "G1 young GC 在回收前后构造/析构 TraceMemoryManagerStats" 即可
- ❌ 把 `memoryPool.hpp` 的三个子类当"类型字典"翻译——只解释"为什么需要三种"和"更新时机差异"
- ❌ 解释 `MemoryUsage` 类的 JMX 序列化格式（`CompositeData`、`OpenMBeanInfo`）——那属于 JDK 层
- ❌ 把 `LowMemoryDetector::detect_low_memory()` 当成"OOM 预防机制"宣传——它只是"阈值触发通知"，和实际的 OOM 决策（GC 是否触发 full GC）是两层
- ❌ 解释 `ServiceThread` 的全部功能——只提它处理 LowMemoryDetector 的 pending 通知 + GCNotifier 的通知转发
- ❌ 忘记 [06-gc] 的前置知识——如果读者不知道"GC 有 young/mixed/full 三种"就不能理解为什么 FullGCNotificationManager 要过滤
- ❌ 把非 GC 池（CodeHeapPool/MetaspacePool）当主要内容——本文的核心是 GC 池，CodeHeap 和 Metaspace 只在"池类型对比"中出现
- ❌ 不做 RAII 的"析构触发 gc_end"分析——`TraceMemoryManagerStats` 的实现细节是理解"GC 怎么通知 MemoryService"的唯一线索
- ❌ 忽略 GC → services 的跨模块桥梁——`collectedHeap.hpp:439-440` 的 `memory_pools()` / `memory_managers()` 虚函数是唯一接口，不能省略

## 要求行为

- ✅ **★ 一张 GC → JMX 数据流全景图**：GC 事件 → `TraceMemoryManagerStats` RAII → `gc_begin()` / `gc_end()` → pool usage update → GCNotifier → LowMemoryDetector → JMX MBean → JConsole。每步标注 `file:line`
- ✅ **★ `set_universe_heap()` 的精确行号和参数流**：`heap->memory_pools()` → `_pools_list->appendAll()` → 展示 G1 提供了哪些池（Eden/Survivor/Old/Humongous）
- ✅ **★ `TraceMemoryManagerStats` ctor/dtor 的完整代码**：展示 ctor 调用 `gc_begin()`（行 273），dtor 调用 `gc_end()`（行 278）
- ✅ **★ `MemoryService::gc_end()` 的三步展开**：(1) `GCMemoryManager::gc_end()` (2) `GCNotifier::sendNotification()` (3) `LowMemoryDetector::detect_low_memory()`——标注行号和调用顺序
- ✅ **★ 三类 MemoryPool 的对比表**：`PoolType` | 更新时机 | 是否有 collection usage | 数据来源 | 代码位置
- ✅ **★ `LowMemoryDetector` 的 SensorInfo 机制图**：`_pending_trigger_count` 增加 → ServiceThread 处理 → JMX 通知发送
- ✅ **★ 和 [06-gc] 的连接标注**：G1 young GC → `TraceMemoryManagerStats` RAII → gc_end() → pool usage update——从 GC 的 `do_collection_pause()` 到 JMX 面板
- ✅ **★ `collectedHeap.hpp:439-440` 虚函数接口展示**：这是 GC → services 的唯一桥梁，标注调用者（G1CollectedHeap 覆盖）和消费者（MemoryService::set_universe_heap）
- ✅ **★ `GCNotifier::sendNotificationInternal()` 的 `is_notification_enabled()` 检查**：解释"大部分 GC 不发通知——只有 full GC 和 young GC 如果开启了通知才发"
- ✅ **★ GDB 验证池值变化**：`br memoryService.cpp:182` → GC 触发 → 单步进入 gc_end → 打印池的 `_after_gc_usage` 前后值

## GDB 可证伪断言

1. **断言：`set_universe_heap()` 在 VM 初始化时被调用一次**
   验证：`br memoryService.cpp:70` → 启动 JVM → `bt` → 调用栈来自 `Universe::initialize_heap()` 或类似路径
   预期：断点只命中一次，`heap` 参数是 `G1CollectedHeap` 实例

2. **断言：`heap->memory_pools()` 返回的池列表包含 Eden、Survivor、Old、Humongous**
   验证：`br memoryService.cpp:73` → `p gc_mem_pools.length()` → `p gc_mem_pools.at(0)->name()` → 重复
   预期：至少有 3 个池，名称包含 "G1 Eden"、"G1 Survivor"、"G1 Old"、"G1 Humongous"

3. **断言：`TraceMemoryManagerStats` 构造时调用 `MemoryService::gc_begin()`**
   验证：`br memoryService.cpp:167` → G1 GC 触发 → `bt` → 确认由 `TraceMemoryManagerStats::TraceMemoryManagerStats` → `initialize` 调用
   预期：调用栈含 `TraceMemoryManagerStats::TraceMemoryManagerStats` 构造

4. **断言：`TraceMemoryManagerStats` 析构时调用 `MemoryService::gc_end()`**
   验证：`br memoryService.cpp:182` → 继续执行 GC → `bt` → 确认由 `TraceMemoryManagerStats::~TraceMemoryManagerStats` 调用
   预期：调用栈含 `TraceMemoryManagerStats::~TraceMemoryManagerStats` 析构

5. **断言：`gc_end()` 内部先更新 pool usage，后发送通知**
   验证：`br memoryService.cpp:182` → 单步进入 → 先调用 `manager->gc_end()` → 再调用 `GCNotifier::sendNotification()` → 再调用 `LowMemoryDetector::detect_low_memory()`
   预期：三者在同一个函数中顺序调用

6. **断言：`GCMemoryManager::gc_end()` 更新 `_num_collections` 和 `_accumulated_timer`**
   验证：`br memoryManager.cpp` gc_end 实现 → `p this->_num_collections` → 在 GC 前后值 +1
   预期：GC 次数递增

7. **断言：`CollectedMemoryPool` 在 gc_end 后 `_after_gc_usage` 被更新**
   验证：`br memoryPool.cpp` record_collection_usage → `p this->_after_gc_usage` → GC 后 Eden 使用量减少
   预期：GC 后 Eden pool 的 `used_in_bytes()` 显著小于 GC 前

8. **断言：`LowMemoryDetector::detect_low_memory()` 只在 gc_end() 后被调用**
   验证：`br lowMemoryDetector.cpp:81` → 手动触发 GC (`jcmd <PID> GC.run`) → `bt` → 确认由 `MemoryService::gc_end()` 调用
   预期：调用栈含 `MemoryService::gc_end`

9. **断言：`SensorInfo::set_gauge_sensor_level()` 比较 usage vs threshold**
   验证：设置 usage threshold（JConsole → Eden pool → setUsageThreshold(10MB)）→ 启动分配消耗 Edens → `br lowMemoryDetector.hpp` set_gauge_sensor_level → `p usage.used()` → `p threshold.high_threshold()` → usage 超过 threshold
   预期：通知被触发

10. **断言：`GCNotifier::sendNotification()` 检查 `is_notification_enabled()`**
    验证：`br gcNotifier.cpp:189` → `p GCMemoryManager::is_notification_enabled()` → 取决于配置
    预期：如果通知被禁用 → `sendNotificationInternal` 提前返回

11. **断言：`CodeHeapPool::get_memory_usage()` 和 GC 池不同——实时查询**
    验证：`br memoryPool.cpp` CodeHeapPool::get_memory_usage → 不等待 GC → 直接读 CodeHeap 状态
    预期：`_codeHeap->allocated_capacity()` 实时返回，不是最后一个 GC 的 snapshot

12. **断言：`collectedHeap.hpp:439-440` 的虚函数只有 GC 实现覆盖**
    验证：`grep -r "memory_pools()" src/hotspot/share/gc/` → 找到所有覆盖实现
    预期：G1/Parallel/Serial/Epsilon 各有覆盖，返回各自的 MemoryPool 列表
