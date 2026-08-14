# 03. JFR 怎么 10ms 采一次全部线程栈？— Periodic Sampling

> 🔴 Deep | 3 KP 中的采样引擎
> 读者处境: JFR 每 ~10ms 做一次 ExecutionSample——采样所有 Java 线程的栈(安全点外 async trace)→生成 stack trace event→reader 显示热点方法。

> ⚠️ 写作期修正(2026-08-14, vol-02/32-jfr/03 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"AsyncGetCallTrace 采样" 错(重要)**: 31-02 已证 JDK11 JFR 采样用 **os::SuspendedThreadTask**(jfrThreadSampler.cpp:114 OSThreadSampler),不用 AGCT;采样循环 :452-500(semaphore _sample+Java/native 双间隔 next_j/next_n),每轮 5 个(MAX_NR_OF_JAVA_SAMPLES :285)+next_thread 游标分摊
> - **"-XX:JfrThreadSamplingInterval" 编造**: 不存在;间隔由 Java 侧 ExecutionSample 事件周期注入(jfrJniMethod.cpp:250-261 jfr_set_java_sample_interval+set_enabled);默认 20ms(default.jfc)/10ms(profile.jfc);传 0 停摆(next_j=max_jlong :467);JfrOptionSet::sample_threads/sample_protection(:120-142)
> - **"JfrStackTrace::record" 名字差**: 真实=JfrStackTraceRepository::add(jfrStackTraceRepository.cpp:173-198)→add_trace(:200: 哈希 % TABLE_SIZE 查表,equals 命中回 id;未命中 resolve_linenos 后再查 :208-213);**trace_id=u8 8 字节**(jfrTypes.hpp:30,非大纲"4 bytes")
> - **"~20 periodic events" 错**: 真实 **45 个 TRACE_REQUEST_FUNC**(jfrPeriodic.cpp:74 宏→JfrPeriodicEventSet::request##id: JVMInformation/OSInformation/ModuleRequire/ModuleExport...)
> - **"JfrRecorder 在 loop 中周期调用" 错**: 周期驱动在 **Java 侧 RequestEngine**(jdk.jfr/internal/RequestEngine.java): RequestHook.execute(:66-85: native 事件 jvm.emitEvent→jfr_emit_event jfrJniMethod.cpp:218-221→requestEvent :220);doPeriodic(:184)→run_requests(:191 delta>=period);isEveryChunk 事件 doChunkBegin/End(:160-177)每 chunk 执行;user 事件 executeSecure(AccessControlContext)
> - **ExecutionSample/NativeMethodSample/ThreadDump**: period="everyChunk"(metadata.xml:709-724);字段 sampledThread/stackTrace/state
> - **悬念指向 04 ✓**(正确,保留)
> - **实证**: 32-jfr-sampling-demo.txt(jfr print ExecutionSample 实例: sampledThread/state/stackTrace;采样器结构;45 个 requestXXX)

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
