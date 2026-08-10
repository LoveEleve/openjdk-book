# VM Operations — 文章大纲

> vol-02 · 域 11 · 🟡 B | 拓扑排序 #11
> 依赖：Threads（VMThread）+ Safepoint（执行上下文）

## 叙事计划

**开篇场景**：你调了 `System.gc()`——JVM 不会在 `System.gc()` 的调用栈上直接开始 GC。它创建一个 `VM_GC_Operation`，提交给 `VMThread`，请求全局 safepoint，在 safepoint 中执行操作，执行完释放 safepoint。所有"需要 Java 线程都停才能做的事"都走这个通道——80+ 种操作，从 GC 到偏向锁撤销到线程 dump。

**第一层：VM_Operation——操作的基类**

`VM_Operation`（`vmOperations.hpp`）定义三个核心方法：`evaluate_at_safepoint()`（评估是否需要 safepoint）、`doit()`（执行操作）、`doit_epilogue()`（清理）。`VM_OPS_DO` 宏（`:48-111`）枚举 80+ 种操作类型：`VM_GC_Operation`、`VM_RevokeBias`、`VM_ThreadDump`、`VM_PrintThreads`、`VM_FindDeadlocks`、`VM_Exit`、`VM_Deoptimize` 等。

每个操作的 `evaluate_at_safepoint()` 决定了它需要什么级别的 safepoint——有些操作可以在 non-safepoint 执行（如 `VM_Exit`），有些必须全局暂停。

**第二层：VMThread——操作的执行者**

`VMThread`（`vmThread.hpp:114`，全局唯一实例）的 `loop()` 从 `VMOperationQueue` 取操作 → 如果操作要求 safepoint 则调 `SafepointSynchronize::begin()` → 执行 `doit()` → `SafepointSynchronize::end()` → 调 `doit_epilogue()`——循环往复。如果操作不需要 safepoint，跳过暂停步骤直接执行。

**第三层：VMOperationQueue——双优先级防饿死**

`VMOperationQueue`（`vmThread.cpp:180-191`）维护高优先级和低优先级两个队列。safepoint 类操作（GC、deoptimization）高优先级，non-safepoint 类操作（JVMTI 事件、print threads）低优先级。每次取操作时先看高优先级队列，空了再看低优先级。`_queue_counter` 轮换机制防止低优先级操作永远等不到——每 N 次高优先级操作后强制取一个低优先级操作。

超时 watchdog（`VMOperationTimeoutTask`，`vmThread.cpp:204-226`）：如果 VMThread 在执行操作中卡住超过 `GuaranteedSafepointInterval`（默认 1000ms），watchdog 打 warning 日志。

**设计权衡**

一、全局 VMThread vs 多操作线程。单线程执行序列化所有 VM 操作——简单可靠，不需要锁协调多个操作线程。代价是并发性为零——一个慢操作阻塞后面的。

二、safepoint vs non-safepoint 操作。不是所有操作都需要全局暂停——`VM_Exit` 直接杀进程，不需要安全点。`evaluate_at_safepoint()` 让每个操作声明自己的需求，避免不必要的 safepoint。

## 核心悬念

**`System.gc()` 怎么从你的 Java 线程跑到 JVM 的独生子 VMThread 上——穿过 safepoint、执行 GC、再安全返回？**

**→ 下一域**：线程都在跑了、safepoint 也能停了——但 `synchronized(obj)` 背后发生了什么？不是每次都是重量级互斥锁——JVM 用了三级自适应：偏向锁、轻量锁、重量锁。Synchronization 篇见。

## 预估

1 篇，3 层递进，预估 1200-1600 行。
