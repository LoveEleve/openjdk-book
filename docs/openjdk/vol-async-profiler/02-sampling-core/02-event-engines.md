# 02. 既然后端已经统一，为什么前端还要分这么多路 —— CPU、alloc、lock、wall 与 native hooks 的来源语义

> **前置依赖**：[01 —— 信号响起的一瞬间](./01-sampling-core.md)：知道 `recordSample` / `recordExternalSample` 等后端记录入口已经存在。
> → **后续**：[03 —— 分配事件的两条轨道](./03-allocation-events.md)：继续展开 alloc 相关的 JVM 对象分配与 native 分配路径。
>
> 本篇基于当前 async-profiler 源码。重点是“样本从哪里来”，不是“样本到了以后怎么存”；也不把所有前端路径都硬塞进同一种 `Engine` 抽象里。

## 既然 `recordSample()` 已经统一，为什么样本来源还要拆成这么多路

场景：你已经知道 async-profiler 的后端记录链相当统一：无论样本是来自信号、JVMTI 回调还是其他入口，最后都会落到 `recordSample`、`recordExternalSample`、`recordExternalSamples` 或 `recordEventOnly`。这时最自然的疑问就是：**既然后端已经能统一记样本，前端为什么不干脆也统一成一个引擎？**

如果只从“把调用栈记下来”这个角度看，的确会觉得前端差异只是实现细节。但 async-profiler 不是只回答一个问题。它既要回答：

- CPU 时间主要烧在哪；
- 哪些对象分配最频繁；
- 哪些锁等待最重；
- 哪些线程在墙钟时间里一直睡着或阻塞；
- 哪些 native 资源正在被不断分配或竞争；

这些问题的共同点只是“最后都能变成样本”，不是“它们都能靠同一种触发方式发现”。样本来源一旦在进入 profiler 之前就被压平，后端再统一也救不回原本的语义差异。

因此，本篇要先建立一张不是按文件名、而是按来源语义组织的总图：

```text
统一后端
recordSample / recordExternalSample / recordExternalSamples / recordEventOnly
  ↑
  ├─ 周期性 CPU 家族：CpuEngine / PerfEvents / ITimer / CTimer
  ├─ JVM 分配家族：ObjectSampler / AllocTracer
  ├─ Java 锁家族：LockTracer
  ├─ 墙钟家族：WallClock
  └─ 更底层 native hooks：MallocTracer / NativeLockTracer / pthread/dlopen hooks
```

这张图最重要的不是“种类很多”，而是：**来源语义先分叉，记录后端再统一。**

*关键设计（斜体）：* *async-profiler 统一的是样本记录后端，不是样本来源前端。不同来源之所以保留到进入 profiler 之前，是因为它们代表的是不同的观测问题。* [模式: 来源语义先分叉，记录后端再统一]

## 先推翻三个最容易把事件来源讲平的直觉

### 所有事件都只是“定时撞到某段代码”

如果读者只熟悉 CPU profiler，很容易把所有事件都想成“隔一段时间打一次断点，正好撞上某个函数”。这个模型只适用于一部分周期性采样路径。allocation、monitor contention、native malloc/free 并不是靠“定时撞上”发现的；它们更接近 JVM 事件通知、trap/hook 或外部样本累加。

### 所有事件都只是“JVMTI 回调通知一下”

反过来，如果读者先看到 alloc 或 lock 的 JVMTI 回调，又会以为 async-profiler 的来源统一是“JVM 负责通知事件”。这同样不成立。`perf_event_open`、`setitimer`、`timer_create`、pthread/malloc hooks 都发生在 JVM 事件回调体系之外。

### 看到 `Engine` 抽象，就以为一切来源都严格继承同一模式

`src/engine.h:12-59` 确实给出了 `start()`、`stop()`、`title()`、`units()`、`interval()` 这些统一接口，但它只说明“某些采样来源可以抽象成一个 engine”，不说明所有来源都必须这样组织。ObjectSampler、LockTracer、MallocTracer、NativeLockTracer、hooks.cpp 这些路径，都没有必要被强行描述成同一种完整继承框架。

如果把以上三种直觉当真，后面就会出现一连串错误：CPU 被简化成 perf，alloc 被简化成 allocTracer，lock 被写成线程状态快照，wall 被写成另一种 CPU 定时器，native hooks 被写成“也是一种 JVM 事件”。本篇接下来要做的，就是把这些误解一一拆开。

## 第一层：`Engine` 抽象到底统一了什么，没统一什么

`src/engine.h:12-59` 的 `Engine` 基类非常薄：

- `type()`、`title()`、`units()` 提供输出与展示语义；
- `interval()` 提供这个引擎自己的计量粒度；
- `start(Arguments&)` / `stop()` 负责生命周期；
- `updateCounter()` 提供一个可被具体来源复用的“累加到阈值才触发” helper，但它不是所有 engine 都必须调用的统一触发协议。

这说明 `Engine` 抽象统一的，主要是“某一类样本来源如何启动、停止以及怎样给输出层描述自己”；它并没有承诺“所有来源都必须长成一个 start/stop + signalHandler 的类”。

因此，比较准确的说法是：

```text
Engine 统一的是若干来源家族的生命周期外壳；
真正的来源机制仍可能是 timer、perf、JVMTI、trap 或 libc hook。
```

这一层很重要，因为它决定了后面写作的骨架：

- CPU 家族确实更像一组 engine；
- alloc/lock/wall 有的更接近 JVMTI 通知或状态采样；
- malloc/native lock/hooks 更像底层 patch/hook 入口。

若把这一点讲清，读者就不会再问“为什么这篇既讲 engine，又讲 tracer/hook”。因为当前实现里，来源语义本来就不是严格同构的。

*关键设计（斜体）：* *`Engine` 抽象负责统一启动壳子和展示元信息，但不抹平样本来源本身的差异。* [模式: 生命周期外壳统一，来源机制保留异构]

## 第二层：为什么 `event=cpu` 不能等价成单一的 `perf_event_open`

### CPU 事件首先是一类问题，不是一条 syscall 名字

现稿里最容易被写平的一章就是 CPU。因为 perf 路径太显眼，读者很容易把“CPU 采样”理解成“async-profiler 就是 `perf_event_open` 的包装器”。源码并不是这么组织的。

`src/cpuEngine.cpp:21-83` 展示了 CPU 家族的核心公共逻辑：

- `onThreadStart()` / `onThreadEnd()` 让引擎能感知线程生命周期；
- `createForAllThreads()` 遍历现存线程建立 CPU 采样资源；
- `signalHandler()` 在普通 HotSpot 路径上构造 `ExecutionEvent` 并调用 `recordSample()`；
- OpenJ9 走 `signalHandlerJ9()`，先构造 native 地址帧，再交给 `J9StackTraces::checkpoint()`。

这已经说明：即便同样叫“CPU”，不同 JVM 和不同底层来源的处理形态也不一样。

### perf 路径：内核 PMU / 软件事件前端

`src/perfEvents_linux.cpp:602-654` 体现了 Linux perf 家族的特征：

- `attr.sample_period = _interval`，说明它按采样周期触发；
- `PERF_SAMPLE_CALLCHAIN` 与 `PERF_SAMPLE_CPU` 等位决定内核样本内容；
- `_alluser`、`_kernel_stack`、`_cstack` 继续影响 kernel/user callchain 的收集；
- 如果启用了 fdtransfer，获取 fd 的路径还会切换到 `FdTransferClient::requestPerfFd()`（`:627-628`）；
- 之后才是本地 `perf_event_open` 或 mmap ring buffer。

perf 路径更像“内核把周期性 CPU 事件推到 profiler 面前”。它与 JVMTI 最大的差别，是问题源头在 OS/PMU，而不是 JVM 事件回调。

### ITIMER 路径：进程级 CPU 计时器

`src/itimer.cpp:13-48` 则是另一类 CPU 前端。它通过 `setitimer(ITIMER_PROF, ...)` 周期性触发 `SIGPROF`，并在 start 阶段安装对应 signal handler。这里没有 perf ring buffer，也没有内核 event fd；它更像“用传统进程级 CPU 计时器来打周期信号”。

这一路径回答的是：即使没有 perf 家族那套前端，也仍然可以用定时器驱动 CPU 类样本产生。它与 perf 在触发来源、资源模型和精度边界上都不同。

### CTimer 路径：线程级 CPU 计时器

`src/ctimer_linux.cpp:31-120` 进一步说明 CPU 不是单一路径。它通过 `timer_create` 的 raw syscall 建 per-thread CPU clock timer：

- `thread_cpu_clock(tid)` 生成线程 CPU clock id；
- `SIGEV_THREAD_ID` 把信号定向到具体线程；
- `createForAllThreads()` 先为现存线程建 timer；
- `enableThreadEvents()` 让后续新线程也能自动接入；
- `_count_overrun = true` 还会影响信号处理时对 miss sample 的估算。

这比 ITIMER 更接近“每个线程单独有 CPU 采样时钟”，但又和 perf 完全不是同一资源模型。

### 为什么不能把三者写成“可任选实现细节”

perf、ITIMER、CTIMER 共享的只是“最终会构造 CPU 样本”，不同的却是：

- 触发是来自内核 perf、进程级 timer，还是线程级 timer；
- 资源是 event fd、itimerval，还是 per-thread timer；
- 新线程接入是借助 thread events 建资源，还是让单个进程级 timer 全局生效；
- OpenJ9 是否需要另外走 J9 stack trace 分支。

当前实现还存在一条必须写出来的选择优先级。`Profiler::selectEngine()` 在 `src/profiler.cpp:768-795` 中处理 `event=cpu` 时：只要 `_record_cpu`、`_target_cpu`、fdtransfer peer 或 `PerfEvents::supported()` 任一条件成立，就先选 `perf_events`；否则若 `CTimer::supported()`，选 `ctimer`；再否则才退到 `wall_clock`。显式的 `event=ctimer` 和 `event=itimer` 才直接选择对应 engine。

因此 `event=cpu` 不是用户直接指定某条 syscall，但也不是完全不可预测的“任意前端”：它由当前能力与参数条件经过选择器决定。写作时如果把 CPU=perf，会把多前端语义抹掉；如果把它写成三者任意并行，也会丢掉当前实现的优先级。

*关键设计（斜体）：* *CPU 是问题语义，不是某条 syscall 的别名；前端选择由 `selectEngine()` 按能力和参数条件完成。* [模式: 同问题，多周期前端 + 条件选择]

## 第三层：为什么 alloc 更像 JVM 事件通知，而不是“撞上分配点”

### ObjectSampler：JVM 主通知路径

`src/objectSampler.cpp:172-193` 展示了 alloc 章节真正应当站住的事实：

- `_interval` 从 `args._alloc` 或默认分配间隔取值；
- `SetHeapSamplingInterval(_interval)` 设置 heap sampling 粒度；
- 启用 `JVMTI_EVENT_SAMPLED_OBJECT_ALLOC`；
- 同时启用 `JVMTI_EVENT_GARBAGE_COLLECTION_START`；
- stop 时再关闭这些通知并在需要时 `dumpLiveRefs()`。

这条路径不是“定时器打中一段分配代码”，而是 JVM 自己按采样间隔/对象分配语义触发 allocation 相关通知。对读者最重要的结论是：alloc 的主要来源语义更接近“JVM 在分配事件发生时通知 profiler”，不是“CPU 中断正好撞到 malloc/new”。

### AllocTracer：native trap 辅助路径，不是 alloc 总入口

`src/allocTracer.cpp:21-80` 则代表另一条更底层的 allocation 路径。它通过查找 libjvm 中 `AllocTracer` 相关符号、布置 trap，并在 `trapHandler()` 中识别 `ALLOC_SAMPLE` / `ALLOC_OUTSIDE_TLAB`。一次 trap 命中只说明执行流撞到了目标 breakpoint；随后还要经过 `updateCounter(_allocated_bytes, total_size, _interval)`，累计字节达到阈值时才调用 `recordAllocation(...)`。trap 命中与最终 allocation sample 不是同一个动作。

真正决定 alloc 前端的选择在 `Profiler::selectAllocEngine()`（`src/profiler.cpp:798-805`）：非 TLAB 模式且成功取得 sample objects capability 时选 `object_sampler`；OpenJ9 选 `j9_object_sampler`；否则才退到 `alloc_tracer`。所以 ObjectSampler 是当前能力满足时的选择，不是所有 JVM/所有 alloc 模式的固定主入口；AllocTracer 也不是 alloc 总入口，而是选择器在特定条件下使用的 native tracer。

### 为什么 alloc 不能并入 CPU 家族

CPU 家族是“周期到了，我看看线程此刻在哪”；alloc 家族更像“分配事件发生了，我拿到一次对象分配通知或 trap”。两者的触发时机、输入上下文和计量单位都不同。

这也是为什么后端虽然都能落到样本记录链，来源前端却必须分开：如果在来源层就把 alloc 当成“另一种定时中断”，后面根本解释不清 heap sampling、live refs、outside-TLAB 和字节阈值。

## 第四层：lock 与 wall 都会进 profiler，却不是同一种来源

### LockTracer：锁竞争事件流，而不是线程快照

`src/lockTracer.cpp:56-75` 说明 lock 路径的来源语义：

- 启用 `JVMTI_EVENT_MONITOR_CONTENDED_ENTER` 与 `...ENTERED`；
- 记录 `_start_time`；
- 还会拦截 `Unsafe.park()`，为 ReentrantLock 路径补入口；
- stop 时关闭 monitor event，但当前实现不恢复 `Unsafe::park` hook。

这条路径不是“看到线程 BLOCKED 就记一条样本”，而是 JVM 在 monitor contention 发生时产生事件流，再由 profiler 记录等待时间与调用栈。它观察的是竞争过程，不是某个时刻的线程状态快照。当前 `stop()` 会关闭两个 monitor notification，但由于 JDK-8369219 约束，不恢复 `Unsafe::park` hook；因此“停止 lock engine”不等于把所有安装过的 hook 都恢复原状。

### WallClock：墙钟时间与线程状态采样

`src/wallClock.cpp:133-169` 则完全不是锁事件流。它在 signal handler 里先根据 `_mode` 分流：

- `WALL_BATCH` 模式下构造 `WallClockEvent`，调用 `recordSample()`；如果线程处于 sleeping，还把 trace 记进 `_thread_cpu_time_buf`；
- 其他模式构造 `ExecutionEvent`，再走 `recordSample()`；其中 `CPU_ONLY` 模式会把 thread state 设为 `THREAD_UNKNOWN`，它是 WallClock engine 被复用来承载 CPU-only 行为的边界，不等于完整的 wall 状态观察；
- 另外 `recordWallClock()` 还会把累积的 sleep/blocked 样本经 `recordExternalSamples()` 送回后端。

这说明 wall 路径里至少有两层来源：

1. 周期性墙钟信号当场打到线程，直接记一条样本；
2. 对 sleeping/blocked 这类状态，再把一段时间窗口累计成外部样本批量回灌。

这里还要和上一章建立一座桥：`recordWallClock()` 走的是 `recordExternalSamples()`，不是一次完整的 `recordSample()`。这意味着 wall 的一部分来源路径会继承“先累加已有 trace，再尝试写 JFR recorder”的失败语义，而不是 signal 当场取栈那条路径的失败语义。

### 为什么 lock 不能写成“另一种 wall”，wall 也不能写成“另一种 CPU”

lock 关心的是某次 monitor contention 或 park 等待的事件流；wall 关心的是墙钟时间经过后线程处于什么状态、是否还在同一路径上。两者都可能最终进入 `recordSample()` 或 `recordExternalSamples()`，但来源语义不同：

- lock 的关键词是“竞争事件发生”；
- wall 的关键词是“时间过去了，线程还在这里”。

所以不能因为它们都能导出火焰图，就把它们写成同一种来源模型。

*关键设计（斜体）：* *lock 是竞争事件流，wall 是墙钟状态采样；共享后端不代表共享来源。* [模式: 事件流 vs 状态采样]

## 第五层：native memory / native lock / hooks 为什么是更底层的来源链

### hooks.cpp 并不是一个“native 事件引擎”

`src/hooks.cpp:60-129` 里同时出现了至少三类不同角色：

- `pthread_create` / `pthread_exit` hook：通知 `CpuEngine::onThreadStart()` / `onThreadEnd()`，属于线程生命周期基础设施，帮助线程级 CPU 资源接入；
- `dlopen` hook：库加载后触发 `Profiler::updateSymbols(false)`，再让 `MallocTracer`、`NativeLockTracer` 重新 patch，属于动态库变化后的重新布线；
- 真正生成 native memory/native lock 事件的 malloc 与 pthread lock hook，则在 `mallocTracer.cpp`、`nativeLockTracer.cpp` 等文件中完成。

如果把 `hooks.cpp` 一概写成“native memory 事件来源”，会把线程生命周期、动态库重新 patch 和真正的 native 事件生成三件事误归到同一个问题域。

### MallocTracer：malloc/free 路径不是 JVM 事件

`src/mallocTracer.cpp:221-247` 体现的是另一条来源链：

- allocation 事件会走 `recordSample(NULL, size, MALLOC_SAMPLE, &event)`；
- free 则走 `recordEventOnly(MALLOC_SAMPLE, &event)`；
- start 时设置 `_interval`、`_nofree`，必要时 initialize，再 `patchLibraries()`。

这说明 native memory 既可能产生带样本的记录，也可能只写 event-only 条目；来源触发点在库 patch/hook，而不是 JVM 事件通知。

### NativeLockTracer：pthread 锁钩子不是 Java monitor 事件

`src/nativeLockTracer.cpp:15-80` 中的 `pthread_mutex_lock_hook`、`pthread_rwlock_rdlock_hook`、`pthread_rwlock_wrlock_hook` 先尝试 trylock，只有真正发生等待时才记录开始/结束 ticks，再调用 `recordNativeLock(...)`。这条路径处理的是 native pthread 锁等待，与 `LockTracer` 的 Java monitor contention 不是同一种来源。

所以“native memory / native lock / hooks”这组内容真正统一的，不是它们共享某个 super engine，而是：**它们都更靠近 libc / libjvm patch 与运行时 hook，而不是 JVM 自己的高层事件模型。**

## 收网：后端统一只保证样本能汇总，不保证来源语义能被抹平

把这篇压缩成一句话：

```text
同一个 profiler 可以统一存样本；
但 CPU、alloc、lock、wall、native hooks 这些来源语义，不能在进入 profiler 之前就被压平。
```

换一种不看图的复述方式：

- CPU 家族回答“时间片打到线程时，它正在哪”；
- alloc 家族回答“分配事件发生时，谁在分配”；
- lock 家族回答“竞争事件发生时，谁在等哪把锁”；
- wall 家族回答“墙钟时间过去后，线程还卡在哪种状态”；
- native hooks 家族回答“更底层的 malloc、pthread 锁和库加载如何把样本或基础设施送进 profiler”。

它们的共同点只是：最后都能进入统一记录后端。真正不同的，是**样本为什么会在这一刻出现**。

本篇的一句话困惑是：**既然后端记录链已经统一，为什么 async-profiler 还要保留这么多不同的事件前端？**

本篇的一句话顿悟是：**因为来源语义本身就是 profiler 要保留的信息：CPU 依赖周期性前端，alloc 更依赖 JVM 分配通知，lock 是竞争事件流，wall 是墙钟状态采样，native memory/native lock 则来自更底层的 hooks；只有这些差异先保留下来，统一后端才有意义。**

*关键设计（斜体）：* *统一记录后端只解决“样本怎么汇总”，来源前端必须继续保留“样本为什么出现”的语义。* [模式: 来源语义保真 + 后端汇总]

[跨层标注：`Engine`——生命周期外壳；perf/itimer/ctimer——周期性 CPU 前端；JVMTI allocation/monitor events——JVM 通知型前端；WallClock——状态采样与外部样本回灌；hooks/malloc/native lock——更底层 runtime patch 路径；`recordSample` / `recordExternal*`——统一记录后端]

## 下一篇：alloc 为什么会分成 JVM 分配与 native 分配两条轨道

这一篇先把“谁来送样本”拆开。下一篇继续进入 alloc 家族内部：

- `ObjectSampler` 和 `AllocTracer` 各自盯的到底是什么；
- JVM 对象分配、outside-TLAB 和 native 分配为什么不能混成一条线；
- live refs、GC start 和字节阈值怎样影响 allocation 观察。

**→ 下一篇：[分配事件的两条轨道](./03-allocation-events.md)。**
