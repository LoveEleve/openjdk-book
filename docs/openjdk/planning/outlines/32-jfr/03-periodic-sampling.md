# 03. JFR 怎么 10ms 采一次全部线程栈？— Periodic Sampling

> 🔴 Deep | 3 KP 中的采样引擎
> 读者处境: JFR 每 ~10ms 做一次 ExecutionSample——采样所有 Java 线程的栈(安全点外 async trace)→生成 stack trace event→reader 显示热点方法。

### 1. "JfrThreadSampler — 线程采样"

场景: 100 个线程 → 每 10ms → 每线程 100 samples/sec → 10K samples/sec → JFR overhead ~2%。

**JfrThreadSampler** (`jfr/periodic/sampling/jfrThreadSampler.cpp:40-200`):
```
JfrThreadSampler::run():
  while (recording_active) {
    sleep(10ms)  // configurable via -XX:JfrThreadSamplingInterval
    for each Java Thread:
      → AsyncGetCallTrace(trace, depth)  // 安全点外栈采样
      → JfrStackTrace::record(trace)     // dedup stack trace via repository
      → EventExecutionSample::commit(thread, trace_id, timestamp)
  }
```
- 源码: `jfr/periodic/sampling/jfrThreadSampler.cpp`
- 关键设计: AsyncGetCallTrace(域31 Forte)在安全点外读栈——可能读到 partial/inconsistent trace→JFR 标记为 `TRUNCATED`——但不影响性能(无 STW)
- [C++: stack trace dedup via `JfrStackTraceRepository`——hash table: trace→trace_id。相同 stack trace 存一次 trace_id——后续 commit 只写 trace_id(4 bytes)而非完整栈(>200 bytes)]

### 2. "Periodic events — GC/CPU/Memory"

**~20 periodic events** (`jfr/periodic/`):
```
JfrGCHeapSummaryEvent     — 每次 GC 后 heap 使用情况
JfrThreadDumpEvent        — 周期性 thread dump
JfrCPULoadEvent           — CPU 负载
JfrNativeMemoryUsageEvent — Native memory 使用
JfrClassLoadingStatistics — 类加载统计
```
- 源码: `jfr/periodic/jfrPeriodicEvents.cpp` 事件注册
- 关键设计: 每个 periodic event 有自己的 interval(GC:per-GC; CPU:1s; Memory:10s)。通过 `JfrPeriodicEventSet` 注册——JfrRecorder 在 loop 中周期调用

---

### 核心悬念

**"JfrThreadSampler 每 10ms 安全点外采全线程栈—dedup via hash table(trace_id)。~20 periodic events 各有间隔(GC/CPU/Memory/Class)。"** — 下一篇: Binary Writer + Chunk Format。

> → [04-binary-writer.md](04-binary-writer.md)
