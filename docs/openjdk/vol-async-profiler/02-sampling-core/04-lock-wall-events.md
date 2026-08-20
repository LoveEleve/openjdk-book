# 04. CPU 不高，但请求还是慢 —— lock、wall-clock 与等待问题的来源语义

> **前置依赖**：[02 —— 既然后端已经统一，为什么前端还要分这么多路](./02-event-engines.md)、[03 —— JVM allocation 与 native malloc 的两大家族](./03-allocation-events.md)
> → **后续**：进入 AP-3 JVM 集成与 AP-4 栈行走/符号解析
>
> 本篇基于当前 async-profiler 源码。重点是“等待”与“墙钟流逝”这类来源语义，不把 lock、wall、proc、RateLimit、ThreadFilter 写成功能附录或配置清单。

## CPU 不高，但请求为什么还是慢

场景：CPU 火焰图并不高，线程也没有明显在某条纯计算路径上烧时间，但接口还是慢、超时还是在发生。此时继续盯着 `event=cpu`，很容易把“谁在运行”错当成“谁在等待”。

async-profiler 在这里会主动切换问题语义：

```text
CPU 不高但请求仍慢
  ├─ lock family: monitor contention + Unsafe.park waiting cost
  ├─ wall family: wall-clock state sampling + batched sleeping traces
  ├─ proc family: process CPU/RSS deltas
  └─ self-protection: RateLimit + ThreadFilter + per-tick throttling
```

这张图里最重要的不是“事件种类增加了”，而是：**当来源不再是“线程此刻在烧 CPU”，采样器就必须同时保留等待语义与自保护机制。** lock 和 wall 都比纯 CPU 采样更容易产生高频事件、状态累计和更重的筛选成本；如果还沿用“打一枪看一次栈”的单一模型，既看不准问题，也更容易把 profiler 本身变成负担。

*关键设计（斜体）：* *等待问题不是 CPU 问题的附录，而是另一套来源语义：谁在等锁、谁在睡、谁在堵。async-profiler 只有把这些语义与自保护机制一起保留，后面的火焰图才有解释力。* [模式: 等待语义 + 采样器自保护]

## 先推翻四个最容易把等待问题讲平的直觉

### 所有锁问题都能靠某个时刻的线程快照解释

这是最常见的误读。某个时刻的线程快照只能告诉你“现在谁堵住了谁”，但它回答不了“等待时间主要消耗在哪条路径”。等待本身是一种持续时间问题，不只是状态枚举问题。也正因此，`event=lock` 才需要 monitor contention 事件流与等待时长累计，而不是只读一次线程状态。

### wall 只是另一种 CPU 百分比

这也不成立。CPU 采样回答“线程在烧 CPU 时正在哪”；wall-clock 更关心“墙钟时间流逝时，线程处在 running、sleeping 还是被 syscall/IO 卡住”。如果把 wall 讲成“另一种 CPU timer”，你就解释不清为什么 sleeping 状态会被累计成外部样本、为什么 `CPU_ONLY` 只是 wall engine 的一种 fallback 语义。

### RateLimit、ThreadFilter 只是附属配置

当来源切到 lock 或 wall 后，采样器更容易面对高频事件和高线程数压力。`RateLimit`、`THREADS_PER_TICK`、`ThreadFilter` 不只是“让用户调一调”的参数，而是这类路径还能不能安全运行的基础保护。把它们写成附录，会让整篇只剩“来源说明”，却缺少“为什么这种来源需要特别保护”。

### `proc` 只是 JVM 线程视角放大版

也不是。`ProcessSampler` 看的不是 JVM 线程状态，而是系统进程 CPU/RSS 的两次样本差值。它回答的是“系统里哪些进程正在消耗 CPU 或 RSS”，而不是“JVM 里的哪个线程卡住了”。把它并入线程采样，会让系统进程视角和 JVM 线程视角混成一层。

## 第一层：LockTracer 盯的是等待代价，不是线程快照

### monitor contention 与 `Unsafe.park()` 为什么要放在一起

`src/lockTracer.cpp:38-64` 的 `LockTracer::start()` 先做三件关键事：

- 根据 `args._lock` 与 `TSC::frequency()` 计算等待阈值 `_interval`；
- 开启 `JVMTI_EVENT_MONITOR_CONTENDED_ENTER` 和 `JVMTI_EVENT_MONITOR_CONTENDED_ENTERED`；
- 调 `setUnsafeParkEntry(env, UnsafeParkHook)`，拦截 `Unsafe.park()`。

乍看这像两条不同来源：monitor contention 是 JVMTI 事件，`Unsafe.park()` 是 native hook。它们会被放进同一个 lock family，是因为它们都在回答同一类问题：**线程到底在为哪种锁等待付出时间代价。**

- Java monitor contention 负责内置监视器锁；
- `Unsafe.park()` + `parkBlocker` 负责当前实现明确识别出的 ReentrantLock、ReentrantReadWriteLock、Semaphore 等 ownable synchronizer 路径。

如果只看 monitor event，就会漏掉大量基于 `park()` 的 Java 并发库等待；如果只看 `park()`，又会错过内置监视器竞争。它们在来源机制上不同，但在观察问题上属于同一家族。

不过这里还要补一个实现边界：`LockTracer::start()` 在 `src/lockTracer.cpp:47-53` 中，即使 `initialize()` 失败，也只是记录 `ReentrantLock tracing unavailable` 并继续启动 monitor contention 事件。这意味着 lock family 可以退化成“只有 monitor contention、没有 park 路径”；`Unsafe.park()` 这条补盲链并不是任何 JVM 上都必然可用。

### LockTracer 真正测的是什么

`MonitorContendedEnter()` 与 `MonitorContendedEntered()` 位于 `src/lockTracer.cpp:153-185`。前者在竞争开始时记录 enter_time，64 位平台优先放入 pthread TLS，不能用 TLS 时再退到 JVMTI tag；后者在锁真正拿到时读取 enter_time，计算等待 duration。

真正触发 sample 的关键不在“竞争发生了”，而在 `src/lockTracer.cpp:178-184`：

```cpp
const u64 duration = entered_time - enter_time;
if (updateCounter(_total_duration, duration, _interval)) {
    recordContendedLock(...);
}
```

这说明 lock 路径观察的是等待时间代价，而不是“每次竞争都完整记一条栈”。竞争事件本身只是输入；累计等待时长越过阈值后，才会生成真正的 lock sample。

### `UnsafeParkHook` 并不是简单“看到 park 就记一条”

`UnsafeParkHook()`（`src/lockTracer.cpp:200-228`）会先读取当前线程的 `parkBlocker`，确认它属于 `isConcurrentLock()` 当前接受的对象范围后才记录等待。这个范围并不覆盖所有 blocker；当前实现只接受 Reentrant 系列与 Semaphore（`src/lockTracer.cpp:246-249`）。之后同样要计算 `park_start_time` 与 `park_end_time`，并经过 `updateCounter(_total_duration, duration, _interval)` 才调用 `recordContendedLock()`。

因此，lock 家族的真实语义不是：

```text
线程状态 = BLOCKED → 记样本
```

而是：

```text
竞争事件开始
  → 等待持续了一段时间
    → 这段时间的累计代价越过阈值
      → 才生成 lock sample
```

这也是 `thread -b` 无法替代它的根本原因。`thread -b` 回答的是“现在谁堵住最多人”；`event=lock` 回答的是“等待代价主要花在哪条调用路径”。

### stop 的边界也要写清

`LockTracer::stop()` 在 `src/lockTracer.cpp:67-75` 只会关闭两个 monitor contention notification。当前实现不会恢复 `Unsafe::park` hook，注释明确点名这是由于 JDK-8369219 的约束。也就是说，stop 并不等于“所有 lock 相关 hook 都恢复原状”。

*关键设计（斜体）：* *lock 家族统一的是等待代价语义：monitor contention 与 `Unsafe.park()` 只是两种不同来源，真正触发 sample 的是等待时间累计越阈值。* [模式: 竞争事件流 + 等待代价采样]

## 第二层：WallClock 不是另一个 CPU profiler，而是墙钟状态采样器

### wall 先回答“线程在墙钟时间里是什么状态”

`WallClock::getThreadState()` 位于 `src/wallClock.cpp:112-130`。它先根据 `ucontext` 拿到当前 PC，再用 syscall 指令与 EINTR 检查判断线程是否正处于 sleeping 状态；否则返回 `THREAD_RUNNING`。

这里的重点不是“它也会打信号”，而是**它打完信号之后，不是先问 CPU 烧了多少，而是先问线程当时在什么状态。**这就是 wall 与 CPU 采样在来源语义上的根本区别。

### `CPU_ONLY` / `WALL_BATCH` / `WALL_LEGACY` 在回答不同问题

`src/wallClock.h:19-23` 定义了三种模式，`WallClock::start()` 在 `src/wallClock.cpp:160-183` 决定它们：

- `args._wall >= 0` 或 `event=wall` 时，进入真正的 wall 模式；若 `_nobatch` 为真，则是 `WALL_LEGACY`，否则是 `WALL_BATCH`；
- 只有在 `args._wall < 0` 且事件也不是 wall 时，才进入 `CPU_ONLY`。

这不是“一个 engine 的三个实现细节”，而是三种不同观测语义：

- `CPU_ONLY`：WallClock engine 被复用为 CPU-only 的 fallback 线程采样器，它是 engine selection 的结果，不是运行中“wall 失败后自动退化”；
- `WALL_BATCH`：既当场 signal 采样，也累计 sleeping trace，再批量回灌；
- `WALL_LEGACY`：落在 `signalHandler()` 的 else 分支里，构造 `ExecutionEvent` 并走 `recordSample(EXECUTION_SAMPLE)`，保留较老的 wall 记录方式，不做 batch 聚合。

尤其要强调：`CPU_ONLY` 并不等于“完整的 wall 观察”。在 `signalHandler()` 里，`CPU_ONLY` 会把 `event._thread_state` 直接设成 `THREAD_UNKNOWN`（`src/wallClock.cpp:145-147`）；这说明它的重点已经不是线程状态语义，而只是借用这套线程 timer loop 去做 CPU-only fallback。

### 为什么 wall 既会 `recordSample()`，又会 `recordExternalSamples()`

`WallClock::signalHandler()`（`src/wallClock.cpp:133-149`）在 `WALL_BATCH` 模式下先构造 `WallClockEvent`，当场调用 `recordSample()`；如果线程状态被判为 sleeping 且 trace 非零，则把这条 trace 送进 `_thread_cpu_time_buf`。

后面 `recordWallClock()`（`src/wallClock.cpp:151-158`）再把累积起来的 sleeping 状态，通过：

```cpp
Profiler::instance()->recordExternalSamples(..., WALL_CLOCK_SAMPLE, &event);
```

送回统一后端。

所以 wall 的真实来源链是两层：

1. 当场 signal 命中线程，记录一条即时样本；
2. 对一段时间都处于 sleeping 的线程，再把同一 trace 累积成 batched wall-clock event。

而这条 batch 回灌并不只有一个触发点：在 `src/wallClock.cpp:237-247`，当 sleeping 计数达到 `MAX_IDLE_BATCH` 上限或状态不再满足累计条件时，就会立即 `recordWallClock()`；在 `flush()`（`:192-201`）和 `timerLoop()` 结束后的 `flush()`（`:277-280`）中，残留的 `tss.counter != 0` 也会被补刷出去。

这也意味着 wall 继承了上一章已经建立过的 `recordExternalSamples()` 失败语义：它并不总是“当场取栈 → 当场入 JFR”。一部分 wall 结果来自已有 trace 的批量外部样本回灌。

### timerLoop 为什么属于主线，而不是实现细节

`src/wallClock.cpp:204-281` 的 `timerLoop()` 里还埋着 wall 路径最重要的自保护逻辑：

- 每轮最多只给 `THREADS_PER_TICK = 8` 个线程发采样信号（`wallClock.cpp:17-21`、`:217-252`）；
- `MIN_INTERVAL` 防止线程遍历间隔被压得过低（`:23-25`、`:257-267`）；
- `CPU_ONLY` 模式下会跳过 sleeping 线程（`:227-230`）；
- `WALL_BATCH` 模式下会先检查 thread CPU time 的变化，再决定是继续累计 sleeping 计数，还是调用 `recordWallClock()` 把这一批样本回灌（`:231-247`）；
- 每轮结束还会 drain `_thread_cpu_time_buf`，同步 thread sleep state（`:272-274`）。

如果不把 timerLoop 放进主线，读者就无法理解：为什么 wall 不是“打一枪、记一条”的简单信号模型，而是一整套带状态机和批量回灌的墙钟采样器。

*关键设计（斜体）：* *wall 家族先保留线程状态，再决定是即时样本还是批量回灌；`CPU_ONLY`、`WALL_BATCH`、`WALL_LEGACY` 代表的是不同观测语义，而不是小参数。* [模式: 墙钟状态采样 + 批量回灌]

到这里可以先把主线收一下：lock 负责解释“等锁的代价”，wall 负责解释“墙钟流逝时线程停在什么状态”；后面要讲的 `RateLimit`、`THREADS_PER_TICK`、`ThreadFilter`，并不是附属优化，而是在防止这两类高频来源先把 profiler 自己打爆。

## 第三层：为什么这些高频等待路径会先把 profiler 自己打爆

### RateLimit 不是锦上添花，而是“别让等待事件把系统拖死”

`src/rateLimit.cpp:12-37` 的逻辑非常短，但在这篇里位置非常重。`enable()` 只为启用的事件类别设置 budget/limit；`refill()` 则允许最多 100% budget carryover：

```text
carryover = min(max(budget, 0), limit)
budget = limit + carryover
```

这说明 RateLimit 并不是“样本数永远恒定”的硬截断器，而是允许短时突发后再回到预算轨道。对 lock、wall、alloc 这类高频或可能成批出现的事件来说，这种预算/结转语义比 CPU 定期 sample 更重要，因为来源流量可能在短窗口里突然爆发。真正的消费点仍然回到上一章的统一记录入口：`recordSample()`、`recordExternalSamples()` 等在写入前会调用 `RateLimit::allow(event_type)`，因此预算是在样本进入统一后端之前被消耗的。

### `THREADS_PER_TICK` 与 `MIN_INTERVAL` 直接服务 wall 的稳定性

wall 并不是遍历所有线程就发信号。`THREADS_PER_TICK = 8` 和 `MIN_INTERVAL = 100000`（`src/wallClock.cpp:17-25`）直接限制了：

- 每一轮最多采多少线程；
- 当线程很多时，sleep 时间最低还能压到什么程度。

这两者不是 wall 实现的“参数细节”，而是等待路径的生死线：如果线程太多时仍然全量信号轰炸，wall 会先把 profiler 自己打成热点。

### ThreadFilter 是等待路径的范围控制器，而不是普通容器

`src/threadFilter.h:21-23` 明确写着：query operations must be lock-free and signal-safe。实现上，`ThreadFilter` 用大 bitmap 保存线程 id（`src/threadFilter.cpp:12-18`），`init()` 支持单个 id 与范围（`:28-54`），`accept()` 则是 lock-free 查询（`:75-78`）。

它在 `WallClock::timerLoop()` 中的角色很直接（`src/wallClock.cpp:206-224`）：如果 thread filter 启用且当前线程不在允许集合里，就直接跳过，不给它发采样信号。

这说明 ThreadFilter 并不是“输出后筛掉无关线程”，而是采样前就限制来源集合。更重要的是，它不是普通过滤容器：`threadFilter.h:21-22` 直接把 query operations 约束成 lock-free、signal-safe，`accept()` 也只是 bitmap 查位（`src/threadFilter.cpp:75-78`）。对等待路径来说，这种能在 timer/signal 查询场景里安全运行的过滤结构，和 RateLimit 一样，属于自保护主线，而不是附属配置。

*关键设计（斜体）：* *等待路径的来源天然更容易爆量，所以 async-profiler 必须在样本形成之前就加预算、线程数和过滤三道闸。* [模式: 预算限流 + 每 tick 节流 + 来源集合过滤]

## 第四层：为什么有时还要跳出 JVM，看系统进程 delta

`src/processSampler.cpp:9-79` 展示了完全不同的一条观察线：

- `MIN_CPU_THRESHOLD` 与 `MIN_RSS_THRESHOLD` 过滤低价值进程；
- `populateCpuPercent()` 用两次 process CPU total 与两次时间戳计算 delta（`:26-42`）；
- `sample()` 拉取 PID 列表并维护历史；
- `getProcessInfo()` 在 basic info、delta CPU percent、阈值过滤和 detailed info 全都满足时才产出结果。

这条路径关心的是系统里某个进程在一段时间内消耗了多少 CPU/RSS，而不是 JVM 内某条线程现在在哪个栈上。它和前面的 lock/wall 共享的只是“都属于 CPU 不高时还想继续缩小范围的辅助视角”，不共享采样对象。

因此更准确的说法是：

```text
lock / wall   → JVM 线程级等待语义
proc          → 系统进程级 delta 视角
```

把 ProcessSampler 纳入本篇，不是因为它和 lock/wall 来源相同，而是因为它帮助回答另一个很实际的问题：**如果你怀疑慢并不只发生在 JVM 内部，是否有其他进程正在一起吞 CPU 或 RSS。**它是等待问题排查中的旁路缩圈视角：当 JVM 线程级语义还不足以解释整体变慢时，proc 可以告诉你问题是不是已经扩散到系统进程层。

## 收网：等待问题的来源语义与采样器自保护，必须一起讲

把本篇压缩成一句话：

```text
lock 看的是竞争事件流的等待代价；
wall 看的是墙钟流逝时线程处于什么状态；
proc 提供系统进程级 delta 视角；
RateLimit / ThreadFilter / per-tick throttling 防止这些路径反过来压垮应用。
```

换一种不看图的复述方式：

- lock 回答“线程是不是因为竞争事件在等，而且等了多久”；
- wall 回答“线程是不是在墙钟时间里一直睡、一直堵、一直没往前走”；
- proc 回答“是不是系统里别的进程也在一起吃 CPU 或 RSS”；
- 自保护机制回答“这些等待语义能不能被安全地观测到”。

本篇的一句话困惑是：**当 CPU 火焰图不高但请求仍然慢时，为什么 async-profiler 还要再拆出 lock、wall、proc、RateLimit 和 ThreadFilter 这些路径？**

本篇的一句话顿悟是：**因为等待问题不是单一来源：lock 是竞争事件流，wall 是墙钟状态采样，proc 是系统进程 delta；而这些路径都比纯 CPU 采样更容易爆量，所以限流、线程过滤和每 tick 节流必须与来源语义一起进入主线。**

*关键设计（斜体）：* *CPU 看“谁在烧”，lock 看“谁在等”，wall 看“谁在睡/堵”，proc 看“系统里还有谁在拖后腿”；只有把这些语义和自保护一起讲，等待问题才不会被误扁平化。* [模式: 来源分家 + 自保护并讲]

[跨层标注：JVMTI monitor contention——锁竞争事件流；`Unsafe.park` / `parkBlocker`——ownable synchronizer 等待路径；WallClock modes——墙钟状态采样与外部样本回灌；RateLimit / `THREADS_PER_TICK` / ThreadFilter——来源侧自保护；ProcessSampler——系统进程 CPU/RSS delta 视角]

## 后续：从“样本从哪来”转向“样本怎么和 JVM/栈/符号接起来”

到这里，AP-2 的事件层已经收拢：

- CPU：周期性前端；
- alloc：对象创建、存活对象与 native malloc/free；
- lock：竞争事件流；
- wall：墙钟状态采样；
- proc/filter/ratelimit：范围控制与稳定性保护。

接下来不再问“样本从哪来”，而要开始问：

- JVM 集成层怎样把这些事件接进 HotSpot/OpenJ9；
- native/Java 栈怎样被走出来；
- 符号、帧名、存储和输出怎样把这些样本变成人能读懂的图。

**→ 后续：进入 AP-3 JVM 集成与 AP-4 栈行走/符号解析。**
