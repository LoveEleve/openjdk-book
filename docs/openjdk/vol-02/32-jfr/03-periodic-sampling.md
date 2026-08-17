# 03. JFR 怎么 10ms 采一次全部线程栈?— Periodic Sampling

> **前置依赖**:[32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md):buffer 与写入链;[32-jfr/02 — JFR 有 130 种事件类型 — 它们怎么定义?— Event Types + Metadata](openjdk/vol-02/32-jfr/02-event-metadata.md):周期事件在 metadata.xml 的 period 属性;[31-unsafe/02 — WhiteBox 与 Forte](openjdk/vol-02/31-unsafe-whitebox/02-whitebox-forte.md):采样器的结构(SuspendedThreadTask 非 AGCT)
> → **后续**:[32-jfr/04 — .jfr 文件是什么格式?— Binary Writer + Chunk Format](04-binary-writer.md)
> 关联域: 17-threads(线程状态)、24-frame(栈遍历)、30-jvm-entry

## 采样事件从哪来

`ExecutionSample`/`NativeMethodSample` 不靠埋桩——它们是"到点自动发生"的周期事件。JFR 里"周期"其实是**两套机制**: ①**线程采样器**(高频,ExecutionSample 周期默认 20ms(default.jfc)、profile 10ms——轮着采样所有线程的栈,31-02 拆过它的挂起机制);②**周期事件**(录制/时间驱动,chunk 开始时的系统信息、周期性统计)。这篇把两套的"节拍从哪来"补齐: 采样间隔怎么定、栈怎么去重、45 个周期事件谁在驱动。

## 1. 线程采样: 间隔与循环

采样器的结构在 31-02 拆过(OSThreadSampler 用 `os::SuspendedThreadTask`,**不是大纲想象的 AsyncGetCallTrace**)。本篇补驱动的两处:

**间隔从哪来**: 没有 `-XX:JfrThreadSamplingInterval` 这类 flag——采样间隔由 **Java 侧 ExecutionSample 事件的周期设置**注入,经 `jfr_set_method_sampling_interval`(jfrJniMethod.cpp:248-261)落到 native:

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

Java 侧把 ExecutionSample 事件的周期(默认 20ms、profile 10ms,见 default.jfc/profile.jfc 的 period 设置)转为毫秒传入;**传 0 则采样线程停摆**(interval 为 0 时 run 循环里 `next_j = max_jlong`,jfrThreadSampler.cpp:467)。`JfrOptionSet` 另有 `sample_threads`/`sample_protection` 开关(jfrOptionSet.cpp:120-142,"Thread sampling enable / disable")。

**循环**在 31-02 已读(jfrThreadSampler.cpp:452-500): semaphore(`_sample`)唤醒 + Java/native 两档间隔独立计时(`next_j`/`next_n`),到点用 `task_stacktrace` 挂起目标线程抓栈——**每轮只采一批(MAX_NR_OF_JAVA_SAMPLES=5),轮转推进**(next_thread 游标),所以"10ms 采全部线程"是分摊的: 高频采样 + 每轮 5 个 + 游标循环。

## 2. 栈去重: 同一段栈,一个 id

每条采样事件都带完整栈会爆量——`JfrStackTraceRepository::add`(jfrStackTraceRepository.cpp:173-198)按栈内容哈希去重:

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

`add` 流程: 哈希 → 查表(`add_trace`);未命中 → **`resolve_linenos()`(解析行号)再查一次**(行号是后补的,补完可能命中已入库的栈);仍无则登记新 id。采样器每抓到一条栈,`add` 得到 `trace_id` 写进事件(`set_stackTrace(id)`,jfrThreadSampler.cpp:262)——**事件里只有 8 字节 id(`traceid`=u8,jfrTypes.hpp:30),完整栈只在 repository 里存一份**。reader 解析时从 chunk 的栈轨迹常量池按 id 取回完整栈([实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/32-jfr-sampling-demo.txt) `jfr print` 能还原完整 `stackTrace`)。

## 3. 周期事件: 45 个 requestXXX + Java 侧引擎

`metadata.xml` 里带 `period` 属性的事件(ExecutionSample/NativeMethodSample/ThreadDump 都是 `period="everyChunk"`,metadata.xml:709-724)在 native 侧的实现是 **45 个 `requestXXX` 函数**(jfrPeriodic.cpp:74 的宏 `TRACE_REQUEST_FUNC(id)`,展开成 `JfrPeriodicEventSet::request##id`)——JVMInformation/OSInformation/ModuleRequire/ModuleExport……**不是大纲的 "~20 个"**。它们**不自己跑**,由 Java 侧 `RequestEngine` 驱动:

- **RequestHook**: 32-02 的 `MetadataRepository` 给周期事件挂的钩子;`execute`(RequestEngine.java:66-85)对 **native 事件调 `jvm.emitEvent(id)`** → native `jfr_emit_event`(jfrJniMethod.cpp:218-221)→ `JfrPeriodicEventSet::requestEvent`(:220)分派到对应 requestXXX;
- **节拍**: `doPeriodic()`(:184)→`run_requests`(:191)——每个钩子累计 `delta`,`delta >= period` 才 execute(周期由 `PlatformEventType.getPeriod()` 决定,即 32-02 的 `@Period` 注解);`isEveryChunk` 的事件由 `doChunkBegin/doChunkEnd`(:160-177)在 chunk 边界执行(系统信息每 chunk 刷新一次);
- **user 事件**(用户自定义的周期事件)走另一分支: `executeSecure` 带 AccessControlContext 执行用户 Runnable。

## 核心悬念

周期机制拆完: 线程采样靠 Java 侧注入的间隔(无 JVM flag)+ semaphore 循环分摊采样,栈经 `JfrStackTraceRepository` 哈希去重(同栈同 id,事件只写 8 字节 id,栈数据经 repository::write 落进 chunk 的常量池,jfrStackTraceRepository.cpp:100);45 个周期事件由 Java 侧 `RequestEngine` 按 period 节拍驱动(native 只提供 requestXXX 实现,chunk 边界事件每 chunk 刷新)。[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/32-jfr-sampling-demo.txt)里 `jfr print` 的 ExecutionSample 实例带着完整栈——repository 的 id 已被还原成可读形式。

但还原依赖"栈轨迹、常量、字符串在文件里怎么编码"——事件 id 指向 repository,repository 数据又怎么落到 `.jfr` 的二进制流?下一篇: 二进制写出与 chunk 格式。

> → [32-jfr/04 — .jfr 文件是什么格式?— Binary Writer + Chunk Format](04-binary-writer.md)
