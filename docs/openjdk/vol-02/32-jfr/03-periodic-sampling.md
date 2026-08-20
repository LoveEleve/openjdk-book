# 03. JFR 怎么 10ms 采一次全部线程栈?— Periodic Sampling

> **前置依赖**:[32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md):buffer 与写入链;[32-jfr/02 — JFR 有 130 种事件类型 — 它们怎么定义?— Event Types + Metadata](openjdk/vol-02/32-jfr/02-event-metadata.md):周期事件在 metadata.xml 的 period 属性;[31-unsafe/02 — WhiteBox 与 Forte](openjdk/vol-02/31-unsafe-whitebox/02-whitebox-forte.md):采样器的结构(SuspendedThreadTask 非 AGCT)
> → **后续**:[32-jfr/04 — .jfr 文件是什么格式?— Binary Writer + Chunk Format](04-binary-writer.md)
> 关联域: 17-threads(线程状态)、24-frame(栈遍历)、30-jvm-entry

`ExecutionSample`/`NativeMethodSample` 不靠埋桩——它们是"到点自动发生"的周期事件。JFR 里"周期"其实是**两套机制**:

1. **线程采样器**(高频,ExecutionSample 周期默认 20ms,profile 10ms): 轮着采样所有线程的栈;
2. **普通周期事件**(录制/时间驱动): chunk 开始时的系统信息、周期性统计。

本篇要回答的核心问题:

- 线程采样的间隔从哪来?谁在 native 侧敲节拍?
- 为什么一条采样事件里只有一个 8 字节 id,却能还原完整栈?
- 普通周期事件和线程采样是不是同一个驱动器?

答案会反复落到一句话:**JFR 的“周期”其实是两套不同机制：高频线程采样由 Java 侧把 period 注入 native，`JfrThreadSampling` 自己按毫秒循环抓一批线程栈；普通周期事件由 Java 侧 `RequestEngine` 按 `@Period`/everyChunk 驱动，native 只提供 `requestXXX` 实现。线程栈之所以不直接写进每条事件，是因为 `JfrStackTraceRepository` 先按栈内容去重，事件体里只写一个 `traceid`。**

---

## 1. 开场困惑——"周期"是谁在驱动

`ExecutionSample`/`NativeMethodSample` 不靠代码埋桩。JFR 要“每 10ms 采一次全部线程栈”，那节拍是谁敲的?直觉会想到 20-02 那类 `PeriodicTask`。但 JFR 的“周期”不是同一套机制。

线程采样是**高频**、跟线程状态强相关的周期动作,需要 native 侧自己维护 millisecond 级循环;而 `JVMInformation`/`OSInformation`/`ThreadDump` 这种普通周期事件是**低频**、按录制配置触发,适合 Java 侧用统一调度器 `RequestEngine` 驱动。两者都叫“periodic”，但不是同一个引擎。

---

## 2. 两个朴素方案为什么都不对

### 方案一: 所有周期事件都由同一个 PeriodicTask 驱动

如果把 `ExecutionSample` 也塞进 `PeriodicTask`,采样线程就得定时挂起所有 JavaThread,收集栈,再往 per-thread buffer 里写事件。高频采样会和 WatcherThread 的其它任务竞争,而且 `ExecutionSample` 需要区分 Java/native 两档间隔、按批次轮转线程,不是简单的每次 tick 调一个回调。

### 方案二: 每条采样事件都直接带完整栈

一条栈几十个 frame,每个 frame 至少要写方法 id、BCI、行号……如果每 10ms 采样一次,几千条事件把完整栈都塞进事件体,文件体积会爆炸。JFR 选择把完整栈移进一个 repository 去重存一份,事件体只写 `traceid`。

---

## 3. 线程采样——间隔怎么注入、循环怎么跑

### 间隔从哪来

没有 `-XX:JfrThreadSamplingInterval` 这类 flag——采样间隔由 **采样事件的 period 设置**注入,经 `jfr_set_method_sampling_interval`(jfrJniMethod.cpp:250-261)落到 native: ExecutionSample 对应 Java 采样,NativeMethodSample 对应 native 采样。

```cpp
// jfrJniMethod.cpp:250-261(截取核心,逐字)
  if (intervalMillis > 0) {
    JfrEventSetting::set_enabled(typed_event_id, true); // ensure sampling event is enabled
  }
  if (EventExecutionSample::eventId == type) {
    JfrThreadSampling::set_java_sample_interval(intervalMillis);
  } else {
    JfrThreadSampling::set_native_sample_interval(intervalMillis);
  }
```

Java 侧把 ExecutionSample 事件的周期(默认 20ms、profile 10ms)转为毫秒传入;**传 0 则采样线程停摆**(interval 为 0 时 run 循环里 `next_j = max_jlong`)。`JfrOptionSet` 另有 `sample_threads`/`sample_protection` 开关。

### 循环

`JfrThreadSampling::run`(jfrThreadSampler.cpp:452-500)用 semaphore(`_sample`)唤醒 + Java/native 两档间隔独立计时(`next_j`/`next_n`),到点用 `task_stacktrace` 挂起目标线程抓栈。**每轮只采一批(MAX_NR_OF_JAVA_SAMPLES=5),轮转推进**(next_thread 游标),所以"10ms 采全部线程"是分摊的: 高频采样 + 每轮 5 个 + 游标循环。

---

## 4. 栈去重——同一段栈,一个 id

每条采样事件都带完整栈会爆量——`JfrStackTraceRepository::add_trace`(jfrStackTraceRepository.cpp:200-211)按栈内容哈希去重:

```cpp
// jfrStackTraceRepository.cpp:200-211(截取核心,逐字)
traceid JfrStackTraceRepository::add_trace(const JfrStackTrace& stacktrace) {
  MutexLockerEx lock(JfrStacktrace_lock, Mutex::_no_safepoint_check_flag);
  const size_t index = stacktrace._hash % TABLE_SIZE;
  const JfrStackTrace* table_entry = _table[index];

  while (table_entry != NULL) {
    if (table_entry->equals(stacktrace)) {
      return table_entry->id();
    }
    ...
```

`add` 流程:

1. 哈希 → 查表(`add_trace`);
2. 未命中 → **`resolve_linenos()` 再查一次**(行号是后补的,补完可能命中已入库的栈);
3. 仍无则登记新 id。

采样器每抓到一条栈,`add` 得到 `trace_id` 后不是直接把整条栈写进事件体,而是把 repository 分配的 id 写进事件(`set_stackTrace(id)`,jfrThreadSampler.cpp:261)——**事件里只有 8 字节 id(`traceid` 是 JFR 内部的 `u8` 类型别名,jfrTypes.hpp:30),完整栈只在 repository 里存一份**。reader 解析时从 chunk 的栈轨迹常量池按 id 取回完整栈。

---

## 5. 普通周期事件——45 个 requestXXX + Java RequestEngine

`metadata.xml` 里带 `period` 属性的**普通周期事件**(如 ThreadDump、各类系统信息与统计事件)在 native 侧的实现是 **45 个 `requestXXX` 函数**(jfrPeriodic.cpp:74 的宏 `TRACE_REQUEST_FUNC(id)`,展开成 `JfrPeriodicEventSet::request##id`)——**不是大纲的 `~20 个`**。ExecutionSample/NativeMethodSample 属于线程采样通道,不走 `everyChunk` 这一类 requestXXX 驱动。

它们**不自己跑**,由 Java 侧 `RequestEngine` 驱动:

- **RequestHook**: `MetadataRepository` 给周期事件挂的钩子;
- **execute**: `RequestEngine::execute`(RequestEngine.java:66-85)对 **native 事件调 `jvm.emitEvent(id)`** → native `jfr_emit_event`(jfrJniMethod.cpp:218-221)→ `JfrPeriodicEventSet::requestEvent`(:220)分派到对应 `requestXXX`;
- **节拍**: `run_requests`——每个钩子累计 `delta`,`delta >= period` 才 execute;`isEveryChunk` 的事件由 `doChunkBegin/doChunkEnd` 在 chunk 边界执行(系统信息每 chunk 刷新一次);
- **user 事件**(用户自定义的周期事件)走另一分支: `executeSecure` 带 AccessControlContext 执行用户 Runnable。

所以**线程采样和普通周期事件不是一个调度器**: 线程采样由 native 侧 `JfrThreadSampling::run` 自己打毫秒级节拍,普通周期事件由 Java 侧 `RequestEngine` 驱动。

---

## 6. 误解澄清与收网

1. **ExecutionSample 靠什么驱动?** 不是 PeriodicTask,而是 Java 侧 period 配置 → native `jfr_set_method_sampling_interval` 注入 → `JfrThreadSampling::run` 自己的循环。
2. **为什么事件里只有一个 `traceid`?** 因为完整栈在 `JfrStackTraceRepository` 里去重存一份,事件体只写 8 字节 id。
3. **普通周期事件由谁驱动?** Java 侧 `RequestEngine`,native 只实现 `requestXXX`。
4. **everyChunk 的事件什么时候发生?** chunk 边界(`doChunkBegin`/`doChunkEnd`)。
5. **线程采样和普通周期事件是不是一套机制?** 不是。一个是 native 侧循环,一个是 Java 侧调度器。

把这一篇压成三句话:

- **线程采样靠 Java 侧注入 period + native 侧 millisecond 循环**,每轮抓一批线程栈。
- **栈先去重,事件只写 `traceid`**——同一段栈,一个 id。
- **普通周期事件靠 Java 侧 `RequestEngine` 驱动**,native 只提供 `requestXXX`。

下一篇: 二进制写出与 chunk 格式——repository 里的栈、常量、字符串怎么落进 `.jfr` 流。

> → [32-jfr/04 — .jfr 文件是什么格式?— Binary Writer + Chunk Format](04-binary-writer.md)