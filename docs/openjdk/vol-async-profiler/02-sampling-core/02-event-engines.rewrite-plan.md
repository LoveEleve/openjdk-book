# 02-event-engines 重写规划

> 状态：正文已重写，待 deep review
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“CPU / alloc / lock / wall / native memory 路径盘点”重写成一篇围绕“同一个 profiler 为什么必须把样本来源拆成多种事件引擎，而不是让 recordSample 自己包办所有触发路径”的机制文章

## 1. 选题判断

这篇值得独立成篇，但不能继续写成“CPU 有 perf/itimer/ctimer，alloc 有 objectSampler，lock 有 lockTracer”的并列说明文。真正的闭环问题是：**既然后端记录链已经统一了，为什么前端样本来源不能也统一成一个入口；不同事件的触发时机、成本模型和 JVM/OS 依赖分别是什么；以及这些差异为什么必须落实成多种 engine。**

本篇要用“来源语义”而不是“文件名归类”牵骨架。要特别避免把 CPU/perf、ITIMER、CTIMER、wall、alloc、native hooks 混成“都只是信号或回调”这种泛化描述。

## 2. 读者困惑

- 既然 `recordSample()` 已经能统一记样本，为什么 async-profiler 还需要这么多前端 engine？
- `event=cpu` 为什么不能等价成单一的 `perf_event_open`？
- `alloc` 为什么不是“定时撞上分配代码”，而是另走 JVMTI 事件路径？
- `lock` 与 `wall` 为什么虽然都可能最终到 `recordSample()`，却不能被讲成同一种来源？
- native memory 和 native lock 为什么又需要 hooks，而不是沿用 Java 事件机制？
- 哪些路径是“采样时钟”，哪些路径是“业务/运行时事件通知”？

## 3. 一句话顿悟

**async-profiler 统一的是样本记录后端，不是样本来源前端。CPU、allocation、monitor contention、wall clock、native malloc/native lock 这些问题的触发语义完全不同：有的靠内核或定时器周期中断，有的靠 JVMTI 事件回调，有的靠 libc/HotSpot hooks。把它们压成一个单引擎，只会在记录前就失去语义。**

总图：

```text
统一后端
recordSample / recordExternalSample / recordEventOnly
  ↑
  ├─ CPU family: CpuEngine / PerfEvents / ITimer / CTimer
  ├─ alloc family: ObjectSampler / AllocTracer / MallocTracer
  ├─ lock family: LockTracer / NativeLockTracer
  ├─ wall family: WallClock / recordExternalSamples
  └─ native hooks family: pthread/dlopen/malloc/native lock hooks
```

## 4. 版本与范围边界

- 基于当前 async-profiler 源码，重点是“样本从哪来”，不是“样本到了之后怎么记”。
- `Engine` 抽象本身很薄，不要把所有事件都夸写成完整继承体系；有些路径是 engine，有些是 tracer/hook 再进入 profiler。
- `event=cpu` 不是固定等于 perf；ITimer、CTimer、OpenJ9/J9StackTraces 都可能参与当前实现。
- `allocTracer` 不能写成 alloc 主路径，只能写成某些 allocation/native 分支的辅助 tracer。
- `lockTracer` 处理的是 monitor contention 与 Unsafe.park 相关路径，不等于任意线程阻塞状态快照。
- `wallClock` 的 CPU_ONLY/WALL_BATCH/WALL_LEGACY 模式要以源码分支为准，不能泛化成“只是另一种 timer”。
- `hooks.cpp` 里线程、dlopen、malloc、native lock 等 hook 作用不同，不能混写成单一“native 事件”。

## 5. 现稿方法论差距审计

- 开篇已经有“谁来送样本”，但整体仍偏引擎列表，没有形成“为什么不能统一成一个前端”的主冲突。
- CPU 章节把 perf/itimer/ctimer 并列列出，但缺少条件和成本差异，容易被读成“实现可任选”。
- `Engine` 抽象被讲得偏完整继承式，而实际有大量路径通过 tracer/hook/JVMTI 回调进入后端，不应全叫 engine。
- alloc 章节只点了 `objectSampler`/`allocTracer`，缺少“JVMTI 事件 vs native tracer”边界。
- lock 章节有快照 vs 事件流对比，但缺少 `Unsafe.park` hook 与 monitor 事件的组合说明。
- wall 章节没有把 `recordSample` 与 `recordExternalSamples` 的双路径差异收进主线。
- native hooks 章节仍偏“还能继续往下沉”，缺少 hooks 如何参与线程、符号、malloc/native lock 的具体角色边界。

## 6. 重写策略

1. 用“为什么不能只靠 `recordSample()` + 一个统一前端”开场，建立来源语义冲突。
2. 推演并否定：所有事件都定时中断、所有事件都靠 JVMTI、所有事件都能抽象成一个 engine 类。
3. 给出来源类型总图：周期性中断 / JVMTI 通知 / runtime hooks / 批量外部样本。
4. 分层讲：
   - `Engine` 抽象到底统一了什么，没统一什么；
   - CPU 家族为什么会分成 perf、itimer、ctimer；
   - alloc/lock/wall 为什么分别绑定 JVMTI 事件、monitor+park 路径和 wall-clock 状态采样；
   - native memory/native lock/hooks 为什么是另一条更底层来源链。
5. 收网时明确：统一后端 ≠ 统一来源；语义在进入 `recordSample()` 之前就已经分叉。

## 7. 结构大纲

### 第一节：事故开场——既然记录后端统一，为什么样本来源还要拆成这么多路

回答：同一个 profiler 需要回答不同问题，来源语义如果提前丢掉，后端再统一也救不回来。

预估字数：900-1100

### 第二节：先排除三个错误直觉——所有事件都靠定时中断、所有事件都靠 JVMTI、所有路径都能收成一个 engine 类

预估字数：1500-1900

### 第三节：第一层——`Engine` 抽象统一的是启动/停止与标题单位，不是所有来源机制

证据：`engine.h:12-59`。

回答：哪些是 engine，哪些是 tracer/hook；`updateCounter()` 的节流语义属于什么层。

预估字数：1400-1700

### 第四节：第二层——CPU 为什么要分 perf、ITIMER、CTIMER 三条家族路径

证据：`cpuEngine.cpp:21-83`、`perfEvents_linux.cpp:602-654`、`itimer.cpp:13-48`、`ctimer_linux.cpp:31-120`。

回答：周期来源、线程粒度、kernel/用户调用链、OpenJ9 分支、资源限制与新线程接入。

预估字数：1900-2300

### 第五节：第三层——alloc 为什么更像 JVM 事件通知，而不是“撞上分配点”

证据：`objectSampler.cpp:172-193`、相关 alloc tracer 路径。

回答：HeapSamplingInterval、SampledObjectAlloc、GC start、live refs；allocTracer 只是辅助分支，不是总入口。

预估字数：1500-1900

### 第六节：第四层——lock 与 wall 为什么都到 profiler，却不是同一种来源

证据：`lockTracer.cpp:56-75`、`wallClock.cpp:133-169`。

回答：monitor contention/Unsafe.park 事件流 vs 墙钟时间/线程状态采样；`recordSample` 与 `recordExternalSamples` 在 wall 中如何共存。

预估字数：1800-2200

### 第七节：第五层——native memory / native lock / hooks 为什么是更底层的来源链

证据：`hooks.cpp:60-129`、malloc/native lock 相关调用点。

回答：pthread 钩子、dlopen 符号更新、malloc/native lock hook 各自作用；不要混成一个“native 事件引擎”。

预估字数：1500-1900

### 第八节：收网——后端统一只保证样本能汇总，不保证来源语义能被抹平

桥接下一篇 allocation 细节或后续 lock/wall 篇。

预估字数：800-1000

## 8. 必须展开的失败方案

1. 把所有事件都想成“定时撞到某段代码”。
2. 把所有事件都想成“JVMTI 回调通知一下”。
3. 看到 `Engine` 抽象就以为所有来源都严格继承同一模式。
4. 把 wall 和 lock 因为都能进入 `recordSample()` 就当成同一来源。
5. 把 malloc/native lock/hooks 写成与 Java 事件完全等价的路径。

## 9. 证据清单

- `src/engine.h:12-59`
- `src/cpuEngine.cpp:21-83`
- `src/perfEvents_linux.cpp:602-654`
- `src/itimer.cpp:13-48`
- `src/ctimer_linux.cpp:31-120`
- `src/objectSampler.cpp:172-193`
- `src/lockTracer.cpp:56-75`
- `src/wallClock.cpp:133-169`
- `src/hooks.cpp:60-129`
- 必要时补 `allocTracer.cpp`、`mallocTracer.cpp`、`nativeLockTracer.cpp` 消费锚点

## 10. 完成后检查

1. 删除代码块后，读者仍能复述“来源语义先分叉，记录后端再统一”。
2. 至少展开 4 个失败方案。
3. 不把 CPU=perf、alloc=allocTracer、lock=线程快照、wall=另一种 CPU 采样。
4. 不把 `Engine` 抽象夸写成覆盖全部来源机制的单一框架。
5. 交代 wall 的双路径和 hooks 的不同角色。
6. 每个 `file:line` 重新核对，链接与禁用词通过。
