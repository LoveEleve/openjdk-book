# 02. Timer + Monitoring Services — 高精度计时 + JMX 统计

> **前置依赖**:[39-runtime-monitoring/01 — JVM 的后台线程做什么?— ServiceThread](01-service-thread.md):监控数据的消费线程;[38-perfdata/01 — PerfData 架构: jstat 的数据从哪来](openjdk/vol-02/38-perfdata/01-perfdata.md):三个 Monitoring Service 的计数器全部是 PerfData;[18-safepoint/01 — JVM 怎么让所有线程同时停住?— Safepoint 编排](openjdk/vol-02/18-safepoint/01-safepoint-orchestration.md):safepoint 统计是 RuntimeService 的数据源
> → **后续**:[46-sa-postmortem/01 — SA Postmortem — core dump + ptrace + ELF symbols](openjdk/vol-02/46-sa-postmortem/01-sa-postmortem.md)
> 关联域: 35-dcmd、25-gc(GC 计时)

`-Xlog:gc+phases` 输出 `GC(0) Phase 1: Mark live objects 3.412ms`——这个毫秒数是一个 RAII 计时器自动打的;而 `jstat -class` 显示的 `Loaded 1841` 则来自类加载服务的 PerfData 计数器。这篇回答两个问题：

1. **计时器家族**——`elapsedTimer` / `TimeStamp` / `TraceTime` / `GCTraceTimeImpl`，它们到底怎么从底层单调时钟长出来？
2. **Monitoring Service 家族**——`ClassLoadingService` / `RuntimeService` / `ThreadService` 究竟是不是数据源，还是只是 PerfData 的读口？

答案先压成一句话：**一切计时的底都是 `os::elapsed_counter()` 这条单调时钟；`elapsedTimer` / `TimeStamp` / `TraceTime` 只是不同形态的封装，GC 专用又另起 `GCTraceTimeImpl` 用 `Ticks` 走自己的日志链。三个 Monitoring Service 则不是数据源，而是对 PerfData 与事件钩子的读口——类加载、safepoint、线程数的真实更新点都在各自事件路径上。**

---

## 1. 开场困惑——GC 日志里的毫秒和 jstat 计数器从哪来

看起来,`-Xlog:gc+phases` 的毫秒和 `jstat -class` 的计数器只是“监控输出”里的两种格式。但它们的来源其实完全不同：

- GC phase 日志要解决的是**某段代码花了多久**；
- jstat / JMX 计数器要解决的是**某个系统状态现在是多少**。

前者属于计时器家族，后者属于 Monitoring Service 家族。它们在底层共享 `os::elapsed_counter()` 或 PerfData 计数器，但向上表现出来的语义完全不同：一个是瞬时 duration，一个是长期可查询的累计统计。

---

## 2. 两个朴素方案为什么都不对

### 朴素方案一：`TraceTime` 就是 GC phase 计时器

很多人先看到 `TraceTime` 的 RAII 结构，就会自然觉得 GC phase 也是靠它。毕竟“构造 start、析构 stop、顺手打日志”很像 GC phase 输出的样子。

但 GC 专门另起了一套 `GCTraceTimeImpl`（带 `Ticks` / `Tickspan`）链路，而不是直接复用普通 `TraceTime`。原因很简单：GC 日志不是普通模块日志，它还要接入 GC tracing、phase nesting、CPU time 等专用数据。

### 朴素方案二：三个 Monitoring Service 自己维护一份独立统计

`ClassLoadingService.loaded_class_count()`、`RuntimeService.safepoint_count()`、`ThreadService.get_live_thread_count()` 这些读起来像“服务自己维护的状态”。但源码不是这样：它们大多只是 **PerfData 计数器** 或 **事件钩子** 的读口。

真正的数据源分别在：

- 类加载/卸载事件路径；
- safepoint begin/end 记录；
- 线程创建/销毁计数更新。

也就是说，Monitoring Service 更像“管理视图的 API”，不是独立的统计系统。

---

## 3. 计时器——从 `os::elapsed_counter` 到 RAII

一切的底是 **`os::elapsed_counter`**。在 Linux 上它最后落到 `javaTimeNanos() - initial_time_count`：

- `javaTimeNanos()` 优先走 `CLOCK_MONOTONIC` 的 `clock_gettime`；
- `clock_gettime` 本身通过 `dlsym` 动态加载,兼容旧 glibc；
- `elapsed_frequency()` 返回 `NANOSECS_PER_SEC`。`os_linux.cpp:1435-1439`、`os_linux.cpp:1489-1491`、`os_linux.cpp:1555-1569`

**关键点**：`CLOCK_MONOTONIC` 不受 NTP 同步与管理员改时间影响。GC 日志、监控计时、线程计时要的都是线性前进的时钟，不是 wall clock。

### `elapsedTimer`

`elapsedTimer`(timer.hpp:32-50)是最朴素的累计计时器：

- `start()` 记 `_start_counter = os::elapsed_counter()`
- `stop()` 把差值累进 `_counter`
- `seconds()` / `milliseconds()` 再把 `_counter` 换算出来

它适合“多次 start/stop 累加同一件事”的场景。

### `TimeStamp`

`TimeStamp`(timer.hpp:53-73)不是累计，而是“记住某个时刻”。`update()` 记下当前 elapsed counter，之后查 `seconds()` / `ticks_since_update()`。

### `TraceTime`

`TraceTime` 不在 `timer.cpp` 里，而在独立的 `timerTrace.hpp`。它也是 RAII,但重点在**日志输出**：

```cpp
// timerTrace.hpp:57-68(截取核心,逐字)
TraceTime(const char* title,
          bool doit = true);

TraceTime(const char* title,
          elapsedTimer* accumulator,
          bool doit = true,
          bool verbose = false);

TraceTime(const char* title,
          TraceTimerLogPrintFunc ttlpf);
```

构造里 `_t.start()`，析构里 stop+打印。输出走统一日志框架，不是 `tty`。`_accum` 还允许把多次调用累计到同一个 `elapsedTimer`。

---

## 4. GC 专用计时——`Ticks` 与 `GCTraceTimeImpl`

GC phase 计时不是普通 `TraceTime`，而是 `GCTraceTimeImpl`(gcTraceTime.hpp:46-65)。这套体系的底层类型是 `Ticks` / `Tickspan`：

- `Ticks` = 某个时刻的计数值
- `Tickspan` = 一段时间差。`ticks.hpp:242-246`

GC 为什么不直接复用 `TraceTime`？因为 GC 计时除了 wall-duration，还经常需要：

- phase 嵌套关系；
- CPU 时间；
- 并发阶段和 STW 阶段分开统计；
- 与 GCTracer / GCTimer 体系联动。

所以 `GCTraceTimeImpl` 是“GC 世界自己的 RAII 计时器”。这就是 `-Xlog:gc+phases` 里 `Phase 1: Mark live objects 3.412ms` 的来源，不是普通 `TraceTime`。

---

## 5. Monitoring Services——PerfData 的读口

### `ClassLoadingService`

`ClassLoadingService.loaded_class_count()` 不是自己数一遍类表，而是 `_classes_loaded_count + _shared_classes_loaded_count` 两个 PerfCounter 的和。真正的更新点在类加载/卸载事件钩子：

- `notify_class_loaded` 在类加载完成时 `inc` 计数并累加字节；
- `notify_class_unloaded` 在类卸载时更新卸载计数。`classLoadingService.cpp:148-166`

所以 `jstat -class` 直接读 hsperf 文件得到的 `Loaded/Bytes`，和 JMX 读到的类加载统计是同源的。

### `RuntimeService`

`RuntimeService` 维护的是 safepoint 相关统计。它内部有：

- PerfCounter `_total_safepoints` / `_safepoint_time_ticks` / `_application_time_ticks`
- `TimeStamp _safepoint_timer` / `_app_timer`。`runtimeService.cpp:37-87`

`safepoint_begin/end` 时调用对应记录函数，更新 safepoint 次数与时间。所以 RuntimeService 不是定期扫描“现在是否在 safepoint”，而是**在事件发生的那一刻更新计数器**。

### `ThreadService`

`ThreadService` 里既有 PerfCounter/PerfVariable，也有原子计数：

- `_total_threads_count` / `_peak_threads_count` 用 PerfCounter 表示历史统计；
- `_atomic_threads_count` / `_atomic_daemon_threads_count` 用原子值表示当前 live 线程数。`threadService.hpp:53-101`

这样 `get_live_thread_count()` 等“当前值”读原子计数，不依赖 PerfData 是否启用；而总数/峰值等“历史值”仍通过 PerfCounter 暴露。

**关键设计**：三个 Service 都是**读口**，不是数据源。数据活在 PerfData 与各类事件钩子里；JMX、jstat、JFR 周期事件看到的是同一份底层计数器。

---

## 6. 组合起来——一条监控管线

把 01 篇和这篇拼起来，监控管线其实是：

**底层时钟/计数器** → **Service 读口** → **ServiceThread 串行消费通知** → **JMX / JFR / jstat / jcmd 对外暴露**。

- 时间来源：`os::elapsed_counter` / `Ticks`
- 数值来源：PerfCounter / PerfVariable / 原子计数 / 事件钩子
- 读口：`ClassLoadingService` / `RuntimeService` / `ThreadService`
- 通知消费：`ServiceThread`
- 外部消费者：JMX、JFR 周期事件、jstat、jcmd

所以 Monitoring Service 不是“又造一套统计系统”，而是把底层计数器和事件钩子组织成 JVM 可管理的监控视图。

---

## 7. 误解澄清与收网

1. **GC 日志 phase 计时就是 `TraceTime` 吗?** 不是。GC 走自己的 `GCTraceTimeImpl` + `Ticks` 体系。
2. **三个 Monitoring Service 自己维护统计吗?** 不是。它们主要是 PerfData 与事件钩子的读口。
3. **`elapsed_counter` 是 wall clock 吗?** 不是。Linux 上它基于 `CLOCK_MONOTONIC`。
4. **`ThreadService` 的 live thread count 也依赖 PerfData 吗?** 不完全。当前线程数走原子计数，历史/峰值走 PerfCounter。
5. **为什么 JMX / JFR / jstat 数据能对得上?** 因为底层读的是同一份 PerfData/事件钩子结果，只是出口不同。

把这一篇压成三句话：

- **底层时钟是 `os::elapsed_counter()`**，上面长出 `elapsedTimer` / `TimeStamp` / `TraceTime` / `GCTraceTimeImpl` 四类封装。
- **三个 Monitoring Service 不是数据源，而是读口**：类加载、safepoint、线程计数都在各自事件路径上更新。
- **JMX / JFR / jstat / jcmd 只是同一份底层计数器的不同出口**。

39 域收官。下一篇跳到 SA Postmortem——JVM 都死了(core dump)之后，怎么用 ptrace + ELF 符号把堆/线程挖出来。

> → [46-sa-postmortem/01 — SA Postmortem — core dump + ptrace + ELF symbols](openjdk/vol-02/46-sa-postmortem/01-sa-postmortem.md)