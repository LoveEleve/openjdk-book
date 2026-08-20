# 39-runtime-monitoring/02-timer-stats 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JVM 里高精度计时从哪里来、GC 日志里的毫秒是谁打出来的、以及 ClassLoadingService / RuntimeService / ThreadService 为什么只是 PerfData 的读口

## 1. 选题判断

现稿事实基础已足够：
- `os::elapsed_counter` / `javaTimeNanos` / `CLOCK_MONOTONIC`
- `elapsedTimer` / `TimeStamp` / `TraceTime`
- `GCTraceTimeImpl` / `Ticks`
- `ClassLoadingService` / `RuntimeService` / `ThreadService`
- 与 PerfData / jstat / JMX / JFR 的关系

真正该打穿的困惑更集中：

**GC 日志里那句 `Phase 1: Mark live objects 3.412ms` 到底是谁量出来的？`jstat -class` 和 JMX 的类加载计数又是不是另一套数据？JVM 里这些 `*Service` 类到底是数据源，还是只是对 PerfData 的读口？**

## 2. 一句话顿悟

**一切计时的底都是 `os::elapsed_counter()` 这条单调时钟；`elapsedTimer` / `TimeStamp` / `TraceTime` 只是不同形态的封装，GC 专用又另起 `GCTraceTimeImpl` 用 `Ticks` 走自己的日志链。三个 Monitoring Service 则不是数据源，而是对 PerfData 与事件钩子的读口——类加载、safepoint、线程数的真实更新点都在各自事件路径上。**

## 3. 总图

```text
os::elapsed_counter / javaTimeNanos (CLOCK_MONOTONIC)
  ├─ elapsedTimer: start/stop 累计
  ├─ TimeStamp: 记录某个时刻
  ├─ TraceTime: RAII + 日志输出
  └─ GCTraceTimeImpl + Ticks: GC phase 专用

PerfData / 事件钩子
  ├─ ClassLoadingService: 类加载/卸载时更新计数器
  ├─ RuntimeService: safepoint begin/end 时更新计时
  └─ ThreadService: 线程创建/销毁时更新原子计数与 PerfCounter

消费端
  ├─ JMX / JMM
  ├─ jstat
  └─ JFR periodic events
```

## 4. 结构大纲

### 第一节：开场困惑——GC 日志里的毫秒和 jstat 计数器从哪来

- 从 `-Xlog:gc+phases` 和 `jstat -class` 两类现象切入
- 点出：一个是计时器家族，一个是 Monitoring Service 家族
- 埋主线：共享底层时钟与 PerfData

### 第二节：两个朴素方案为什么都不对

1. TraceTime 就是 GC phase 计时器
2. 三个 Service 自己维护一份独立统计

结论：GC 走 `GCTraceTimeImpl`，Service 只是读口，真正数据源在时钟与事件钩子/PerfData

### 第三节：计时器——从 `os::elapsed_counter` 到 RAII

- `CLOCK_MONOTONIC` / `javaTimeNanos`
- `elapsedTimer`
- `TimeStamp`
- `TraceTime` 在 `timerTrace.hpp`

### 第四节：GC 专用计时——`Ticks` 与 `GCTraceTimeImpl`

- 为什么 GC 不走普通 `TraceTime`
- `Ticks` / `Tickspan`
- `GCTraceTimeImpl` 的角色

### 第五节：Monitoring Services——PerfData 的读口

- `ClassLoadingService`
- `RuntimeService`
- `ThreadService`
- 更新点分别在哪

### 第六节：组合起来——一条监控管线

- 数据源
- Service 读口
- ServiceThread 消费通知
- JMX / JFR / jstat 暴露

### 第七节：误解澄清与收网

## 5. 失败方案

1. TraceTime 就是 GC phase 计时器
2. Monitoring Service 自己维护独立数据源

## 6. 证据清单

- `src/hotspot/os/linux/os_linux.cpp:1435-1439`
- `src/hotspot/os/linux/os_linux.cpp:1489-1491`
- `src/hotspot/os/linux/os_linux.cpp:1555-1569`
- `src/hotspot/share/runtime/timer.hpp:32-73`
- `src/hotspot/share/runtime/timerTrace.hpp:57-68`
- `src/hotspot/share/gc/shared/gcTraceTime.hpp:46-65`
- `src/hotspot/share/utilities/ticks.hpp:242-246`
- `src/hotspot/share/services/classLoadingService.cpp:148-166`
- `src/hotspot/share/services/runtimeService.cpp:37-87`
- `src/hotspot/share/services/threadService.hpp:53-101`

## 7. 完成后 review

- 删除代码后，能否复述“底层单调时钟 + 上层封装 + PerfData 读口”
- 是否讲清 TraceTime 与 GCTraceTimeImpl 的区别
- 是否讲清三大 Service 不是数据源
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验