# 32-jfr/03-periodic-sampling 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JFR 的周期事件和线程采样各自由谁驱动、采样间隔怎么注入、栈怎么去重，以及 why 事件里只存 8 字节 trace id

## 1. 选题判断

现稿已有很强事实基础：
- `jfr_set_method_sampling_interval`
- `JfrThreadSampling` 的 run 循环
- `JfrStackTraceRepository::add` 去重
- `jfrPeriodic.cpp` 的 `requestXXX`
- Java 侧 `RequestEngine`

但当前正文仍偏“线程采样一节 + 栈去重一节 + 周期事件一节”的机制并列。真正该打穿的读者困惑更集中：

**JFR 的“周期”到底是谁在敲节拍？为什么 `ExecutionSample` 这种高频采样不靠 `PeriodicTask`，而 `JVMInformation` 这类事件又能按 chunk 刷新？事件里为什么只存一个 8 字节 id，不直接存整条栈？**

## 2. 一句话顿悟

**JFR 的“周期”其实是两套不同机制：高频线程采样由 Java 侧把 period 注入 native，`JfrThreadSampling` 自己按毫秒循环抓一批线程栈；普通周期事件由 Java 侧 `RequestEngine` 按 `@Period`/everyChunk 驱动，native 只提供 `requestXXX` 实现。线程栈之所以不直接写进每条事件，是因为 `JfrStackTraceRepository` 先按栈内容去重，事件体里只写一个 `traceid`，完整栈单独存进常量池。**

## 3. 总图

```text
ExecutionSample / NativeMethodSample
  Java 侧 period 配置
    ↓ jfr_set_method_sampling_interval
  JfrThreadSampling::run
    ├─ semaphore 唤醒
    ├─ next_j / next_n 两档计时
    ├─ 每轮抓一批线程栈
    └─ 栈 -> JfrStackTraceRepository::add -> traceid

普通周期事件 (JVMInformation / ThreadDump / ...)
  Java 侧 RequestEngine
    ├─ delta >= period -> execute
    ├─ everyChunk -> doChunkBegin / doChunkEnd
    └─ native 事件 -> jvm.emitEvent(id)
         ↓ jfr_emit_event
         ↓ JfrPeriodicEventSet::requestEvent
         ↓ requestXXX
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——"周期"是谁在驱动

目标约 900 字。

- 从 ExecutionSample/NativeMethodSample 不靠埋桩切入
- 点出“周期”不是一套机制，而是线程采样和普通周期事件两套驱动
- 埋主线：线程采样靠 native 循环，普通周期事件靠 Java RequestEngine

### 第二节：两个朴素方案为什么都不对

目标约 1100 字。

必须推演：
1. 所有周期事件都由同一个 PeriodicTask 驱动
2. 每条采样事件都直接带完整栈

结论：
- 线程采样与普通周期事件的节拍来源不同
- 栈必须去重，否则文件体积爆炸

### 第三节：线程采样——间隔怎么注入、循环怎么跑

目标约 1800 字。

- `jfr_set_method_sampling_interval`（jfrJniMethod.cpp:250-261）
- 无 JVM flag，period 来自 Java 侧配置
- `JfrThreadSampling::run` 两档间隔 + 每轮抓一批线程
- `sample_threads` / `sample_protection` 开关

### 第四节：栈去重——同一段栈，一个 id

目标约 1600 字。

- `JfrStackTraceRepository::add_trace`（jfrStackTraceRepository.cpp:200-211）
- `resolve_linenos()` 再查一次
- 事件里只写 `traceid`（u8）
- 常量池恢复完整栈

### 第五节：普通周期事件——45 个 requestXXX + Java RequestEngine

目标约 1900 字。

- `jfrPeriodic.cpp` 的 `TRACE_REQUEST_FUNC` / `requestXXX`
- `RequestHook` / `RequestEngine::execute` / `run_requests`
- `everyChunk` 与普通 period 的分流
- `jvm.emitEvent(id)` → `jfr_emit_event` → `JfrPeriodicEventSet::requestEvent`

### 第六节：误解澄清与收网

目标约 1000 字。

## 5. 失败方案

1. 所有周期事件都由同一个 PeriodicTask 驱动
2. 每条采样事件都直接带完整栈

## 6. 证据清单

- `src/hotspot/share/jfr/jni/jfrJniMethod.cpp:250-261`
- `src/hotspot/share/jfr/periodic/sampling/jfrThreadSampler.cpp:452-500`
- `src/hotspot/share/jfr/recorder/repository/jfrStackTraceRepository.cpp:200-211`
- `src/hotspot/share/jfr/recorder/repository/jfrStackTraceRepository.cpp:100`
- `src/hotspot/share/jfr/periodic/jfrPeriodic.cpp:74`
- `src/hotspot/share/jfr/periodic/jfrPeriodic.cpp:220`
- `src/hotspot/share/jfr/jni/jfrJniMethod.cpp:218-221`

## 7. 完成后 review

- 删除代码后，能否复述“两套周期机制 + 栈去重”
- 是否讲清线程采样 interval 来自 Java 侧配置
- 是否讲清 RequestEngine 驱动普通周期事件
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验