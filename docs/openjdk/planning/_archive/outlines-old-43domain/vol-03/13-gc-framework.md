# GC Framework — 文章大纲

> vol-03 · 域 13 · 🔴 A | 拓扑排序 #13 | 178 文件 share/ 抽象层
> 依赖：OS + OOPs + Threads + Safepoint
>
> **→ 从卷 02**：线程管好了、锁协调了——但 `new Object()` 创建的对象去哪了？堆上的内存怎么分配、怎么回收？GC Framework 篇。

## 叙事计划

**开篇场景**：`System.gc()` 不会直接调 G1 的收集代码——它先经过 `CollectedHeap::collect()` 的抽象层。HotSpot 的 GC 是可插拔的：`-XX:+UseG1GC` 和 `-XX:+UseSerialGC` 换 GC 不需要改 JVM 任何业务代码。这就是 GC Framework 做的事情——在所有 GC 算法之上定义统一接口，让上层代码不关心下面是哪个 GC 在运行。

**第一层：CollectedHeap——GC 的统一抽象**

`CollectedHeap`（`collectedHeap.hpp:104`）是所有堆实现的基类。`collect(GCCause cause)` 触发 GC，`is_in(void* p)` 判断对象是否在堆中，`supports_inline_contig_alloc()` 决定是否支持 TLAB 内联分配。`_total_collections` / `_total_full_collections` 计数器被 `jstat -gc` 读取。

`GCCause`（`:132`）枚举触发 GC 的原因：`_java_lang_system_gc`（显式调）`_heap_inspection`（jmap histo 触发）、`_allocation_profiler`、`_jvmti_force_gc`。每种原因在日志中显示不同前缀——`-Xlog:gc` 里看到的 `[gc,start]` 就是 GCCause。

**第二层：BarrierSet——GC 屏障的抽象**

`BarrierSet`（`barrierSet.hpp`）定义读/写屏障接口。不同 GC 需要不同屏障：Card Table（G1/Parallel）跟踪跨代引用——老年代引用新生代对象时需要记录，避免 minor GC 扫描整个老年代。SATB（G1）为并发标记保存"标记开始时"的对象快照。

屏障通过 Access API（OOPs 域）注入——写 `obj.field = val` 时，Access API 根据当前 GC 的 BarrierSet 决定是否执行屏障操作。换 GC 就是换 BarrierSet 实现——上层业务代码完全不变。

**第三层：WorkGang——并行 GC 的任务分发**

`WorkGang`（`workgroup.hpp`）是 GC 并行化的基础。`GangWorker` 是工作线程（不是 Java 线程——是 `NonJavaThread`）。`AbstractGangTask` 定义并行任务，`run_task(task)` 把任务分发给所有 GangWorker。G1 的并发标记、并行疏散都走 WorkGang——多个线程同时标记、同时复制对象。

**第四层：GCLocker——JNI Critical Section 的 GC 保护**

`GCLocker` 阻止 JNI `GetPrimitiveArrayCritical` 期间触发 GC——如果 GC 移动了数组，native 代码持有的指针就野了。`lock_critical()` / `unlock_critical()` 成对调用：lock 期间 GC 被延迟，unlock 后如果 GC 被延迟了则触发一次补偿 GC。

**第五层：SoftRefPolicy——软引用的 LRU 清理策略**

`SoftRefPolicy` 决定"什么情况下清理 SoftReference"——不是所有 soft reference 都在 GC 时清除，只有"最近最少使用"的才清。`should_clear_at_gc()` 根据堆使用率和 last_use 时间戳判断——这就是 `-XX:SoftRefLRUPolicyMSPerMB` 参数的生效位置。

**设计权衡**

一、抽象堆接口 vs 直接 GC 调用。统一接口使 GC 可插拔，但代价是 `is_in()` 这类高频操作走虚函数——虚表开销在堆扫描热路径上不可忽略。

二、Card Table vs 全堆扫描。Card table 用一小块位图跟踪跨代引用——避免 minor GC 扫描老年代。代价是每次引用赋值都要写 card mark——写屏障增加开销。

三、GCLocker 延迟 vs 拒绝。延迟 GC 保证 JNI critical section 安全完成，但延迟的补偿 GC 可能导致意外的长 pause。不如让 native 代码知道"GC 被推迟了"——但不修改 JNI 规范就无法实现。

## 核心悬念

**换 GC 只需改一个 `-XX` 参数——`CollectedHeap` / `BarrierSet` / `WorkGang` 三层抽象怎么让 G1 和 Serial GC 在上层看起来完全一样？**

## 预估

1 篇，5 层递进，预估 2200-2800 行。

**→ 下一域**：GC 框架定义了"垃圾怎么识别、怎么回收"的通用机制——但实际执行中，`SoftReference` 和 `WeakReference` 的清理策略完全不同。哪种软引用该回收、哪种该保留？Reference Processing 篇见。
