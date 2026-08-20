# 04-lock-wall-events 重写规划

> 状态：deep review 完成，待修订同步
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“lock / wall / proc / filter / rate limit 说明文”重写成一篇围绕“CPU 不高但请求仍然慢时，async-profiler 怎样把‘等待’和‘墙钟流逝’拆成不同来源语义，并用限流与过滤机制避免这些高频路径反过来压垮应用”的机制文章

## 1. 选题判断

这篇值得独立成篇，但不能继续写成 lock、wall、RateLimit、ProcessSampler、ThreadFilter 五块功能说明。真正的统一问题是：**当 CPU 看不出问题时，profiler 怎样区分‘线程在等锁’和‘线程在墙钟时间里睡着/阻塞’，又怎样用限流、进程采样和线程过滤把高开销路径约束在可接受范围内。**

本篇要避免把 lock、wall、proc、thread filter 写成彼此独立的附录；它们实际围绕同一条主线：当来源不再是“线程此刻在烧 CPU”，采样器本身必须更重视状态语义与自保护。

## 2. 读者困惑

- CPU 火焰图不高时，为什么还要看 lock 或 wall？
- `thread -b` 和 `event=lock` 都看锁，为什么不能互相替代？
- `Unsafe.park()` 与 monitor contention 为什么会被放进同一个 lock 观察家族？
- wall-clock 为什么既会走 `recordSample()`，又会走 `recordExternalSamples()`？
- `RateLimit`、`ThreadFilter`、`ProcessSampler` 为什么放在同一篇，而不是纯附录？
- `CPU_ONLY` / `WALL_BATCH` / `WALL_LEGACY` 到底在回答什么不同问题？

## 3. 一句话顿悟

**lock 观察的是竞争事件流与等待代价，wall 观察的是墙钟时间里线程处于什么状态；两者都比 CPU 采样更容易产生高频、重路径或状态累计语义，所以 async-profiler 必须同时引入限流、线程过滤和进程级采样辅助，才能在“等待问题”上既保留语义，又不把应用拖垮。**

总图：

```text
CPU 不高但请求仍慢
  ├─ lock family: monitor contention + Unsafe.park waiting cost
  ├─ wall family: wall-clock state sampling + batched sleeping traces
  ├─ proc family: process CPU/RSS deltas
  └─ self-protection: RateLimit + ThreadFilter + per-tick throttling
```

## 4. 版本与范围边界

- 基于当前 async-profiler 源码，重点是等待/阻塞来源语义，不展开 JVM 栈行走细节。
- `thread -b` 属于 Arthas/ThreadMXBean 快照问题，这里只用来做对比，不混入实现主线。
- `LockTracer::stop()` 不恢复 `Unsafe::park` hook，这是当前实现边界，不外推为所有版本行为。
- `WallClock` 的 `CPU_ONLY`、`WALL_BATCH`、`WALL_LEGACY` 代表不同观测语义；不能简单写成“不同 wall 采样模式”。
- `ProcessSampler` 观察的是系统进程 CPU/RSS，不是 JVM 线程采样的延伸。
- `ThreadFilter` 是无锁/信号安全查询结构，不是普通容器；正文要体现它为何适合 timerLoop/signal 场景。

## 5. 现稿方法论差距审计

- 现稿已经区分 CPU 与 lock/wall，但整体仍偏功能清单，缺少“为什么 CPU 不高时问题要改换观察语义”的主冲突。
- lock 章节没有把 monitor contention 与 `Unsafe.park` 的统一问题说透，只是并列列出。
- wall 章节提到了 batch/ExecutionEvent，但没有把 `CPU_ONLY` / `WALL_BATCH` / `WALL_LEGACY` 放进问题主线。
- `recordWallClock()` 的外部样本回灌没有和上一章 `recordExternalSamples()` 失败语义建立桥。
- `RateLimit`、`ProcessSampler`、`ThreadFilter` 像附录，还没被收进“等待路径比 CPU 更需要自保护”的同一主线。
- `ProcessSampler` 和 `ThreadFilter` 需要更明确地区分“观察对象”和“采样器自保护范围控制”两种角色。

## 6. 重写策略

1. 用“CPU 不高但接口一直慢”的事故场景开篇。
2. 推演并否定：锁问题都能靠快照看、wall 只是另一种 CPU 百分比、过滤和限流只是附属配置。
3. 给出总图：等待语义分成竞争事件流、墙钟状态采样、进程视角和自保护机制。
4. 分层讲：
   - LockTracer 如何统一 monitor contention 与 park；
   - WallClock 如何区分 CPU_ONLY/WALL_BATCH/WALL_LEGACY，并在批量模式下回灌外部样本；
   - RateLimit/THREADS_PER_TICK/ThreadFilter 如何共同限制高频路径；
   - ProcessSampler 为什么是系统进程视角，而不是 JVM 线程视角。
5. 收网时强调：等待问题的观察成本更高，因此语义与自保护必须一起讲。

## 7. 结构大纲

### 第一节：事故开场——CPU 不高，但请求为什么还是慢

回答：从“谁在烧 CPU”切换到“谁在等待/谁在睡”的必要性。

预估字数：900-1100

### 第二节：先排除四个错误直觉——锁都能靠快照看、wall 只是另一种 CPU、过滤/限流只是附属配置、proc 只是线程视角放大

预估字数：1500-1900

### 第三节：第一层——LockTracer 统一的是 monitor contention 与 park 等待代价

证据：`lockTracer.cpp:38-75`、`:153-271`。

回答：TSC 阈值、TLS/tag 保存 enter_time、`Unsafe.park` hook、JDK-8369219 stop 边界。

预估字数：1800-2200

### 第四节：第二层——WallClock 不是另一个 CPU profiler，而是墙钟状态采样器

证据：`wallClock.cpp:112-281`。

回答：`CPU_ONLY` / `WALL_BATCH` / `WALL_LEGACY`、sleeping 判定、timer thread、`recordWallClock()` 外部样本回灌。

预估字数：2000-2400

### 第五节：第三层——为什么等待路径更需要 RateLimit、THREADS_PER_TICK 和 ThreadFilter

证据：`rateLimit.cpp`、`wallClock.cpp:17-32`、`:204-281`、`threadFilter.cpp:12-126`。

回答：预算/结转、每 tick 限制、位图过滤、signal-safe 查询。

预估字数：1800-2200

### 第六节：第四层——ProcessSampler 观察的是进程 delta，不是 JVM 线程快照

证据：`processSampler.cpp:9-79`。

回答：CPU/RSS 阈值、两次样本差值、系统进程与 JVM 线程边界。

预估字数：1300-1700

### 第七节：收网——等待问题的来源语义与采样器自保护必须一起讲

桥接 AP-3 JVM 集成或后续更底层栈/符号。

预估字数：800-1000

## 8. 必须展开的失败方案

1. 所有锁问题都能靠某个时刻的线程快照解释。
2. wall 只是另一种 CPU 百分比或另一种 timer。
3. `RateLimit`/`ThreadFilter` 只是锦上添花，不影响主线。
4. `proc` 只是 JVM 线程采样的放大版。
5. stop 之后所有 lock hook 都恢复原状。

## 9. 证据清单

- `src/lockTracer.cpp:38-75`
- `src/lockTracer.cpp:153-271`
- `src/wallClock.cpp:112-281`
- `src/processSampler.cpp:9-79`
- `src/threadFilter.cpp:12-126`
- `src/rateLimit.cpp` 关键预算/结转逻辑

## 10. 完成后检查

1. 删除代码块后，读者仍能复述“竞争事件流 vs 墙钟状态采样 vs 进程 delta”。
2. 至少展开 4 个失败方案。
3. 不把 lock 写成线程快照，不把 wall 写成另一种 CPU 采样。
4. 明确 `CPU_ONLY` / `WALL_BATCH` / `WALL_LEGACY` 边界。
5. 明确 `recordWallClock()` 与 `recordExternalSamples()` 的关系。
6. 把 RateLimit / ThreadFilter / THREADS_PER_TICK 收进主线，而不是附录。
7. 每个 `file:line` 重新核对，链接与禁用词通过。
