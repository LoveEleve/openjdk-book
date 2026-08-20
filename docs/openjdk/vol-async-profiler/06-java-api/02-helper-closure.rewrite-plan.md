# 02-helper-closure 重写规划

> 状态：现稿待回炉；本文件先做理解路径设计，不直接改正文
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“Instrument/LockTracer/Recording/Span/JfrSync 说明文”重写成一篇围绕“native 机制穿过 JVM 边界后，为什么 async-profiler 不把主逻辑搬进 Java，而是只创造一组极薄的 Java helper 作为收件箱、trusted 代理和时钟桥”的机制文章

## 1. 读者困惑

- native 已经能改字节码、hook JNI、写 JFR、发 span 事件了，为什么 Java 世界里还需要 `Instrument`、`LockTracer`、`Recording`、`Span`、`JfrSync` 这些 helper？
- 为什么字节码织进去的是普通 Java 静态调用，而不是“直接调 native 地址”？
- `LockTracer` 为什么看起来像个没业务逻辑的壳，却仍然必不可少？
- `Recording` 和 `Span` 为什么不是主 profiler API，而是 state/clock/sample bridge？
- `Span.endIfProfiled()` 判断的到底是什么，为什么要依赖 thread-local sample 信息？
- `JfrSync` 在 helper 全景里和 `Instrument`/`LockTracer`/`Recording` 的共同角色是什么？

## 2. 一句话顿悟

**async-profiler 在穿越 JVM 边界时的策略不是“把主逻辑搬到 Java”，而是始终保留 native 为核心，只在 Java 世界里创造最小 helper：让字节码改写有稳定收件人，让 trusted `RegisterNatives` 有合法上下文，让 JFR/span 与 profiler 时钟/线程局部样本对齐，让某些 JDK Java API 交互能由 Java 代理出面。**

## 3. 总图

```text
native 需要一个 Java 落点
  ├─ 字节码织入落点 → Instrument
  │    → native Instrument::recordEntry/recordExit0
  ├─ trusted JNI/loader 上下文 → LockTracer
  │    → native setEntry0 / RegisterNatives(Unsafe.park)
  ├─ clock/state/thread-local bridge → Recording
  │    → timestamp / state / getThreadLocalBuffer / emitSpan
  ├─ Java 业务 span façade → Span
  │    → Recording.* + native SpanEvent
  └─ JDK JFR API 代理 → JfrSync
       → master recording / listener / stopProfiler
```

## 4. 版本与边界

- 本篇聚焦“helper 如何充当 Java 落点/代理/桥”，不是重新讲一遍 AP-3 的 BytecodeRewriter、LockTracer hook 或 AP-5 的 JFR writer 全流程。
- `Instrument` 是字节码插桩的 Java 收件人，不是 Java 层性能分析器；真正记样本/方法事件的仍是 native `Instrument` 实现。
- `LockTracer` helper 的核心价值是 trusted `RegisterNatives` / bootstrap context，不是业务锁逻辑封装。
- `Recording` 不是主加载入口，而是已装载后的 state/clock/span bridge；静态初始化失败会落到 `UNAVAILABLE`。
- `Recording.getThreadLocalBuffer()` 暴露的是 native TLD 的 `DirectByteBuffer` 视图，不是稳定 Java 对象模型。
- `Span.endIfProfiled()` 当前判断的是该线程 span 期间是否出现过 profiling sample，不是“业务重要性”。
- virtual thread 在 `Span` 里有特判，不与 platform thread 完全共用同一条 sampled-only 判断路径。
- `JfrSync` 只在 `--jfrsync` 路径下作为 JDK JFR API 代理出现，不是普通 Java API 用户的常规入口。

## 5. 现稿方法论差距审计

- 现稿事实覆盖比较扎实，但主冲突还可以更集中：这些 helper 为什么必须存在、却又为什么必须保持极薄，而不是变成另一层 Java 主逻辑。
- `Instrument`、`LockTracer`、`Recording/Span`、`JfrSync` 现在更像四段并列说明，还需要压成“最小 Java 收件箱/代理/桥”一条统一主线。
- `LockTracer` 的 trusted context 角色已经写到，但可以更明确地打掉“只是设个函数指针”的误解。
- `Recording.getThreadLocalBuffer()` 与 `Span.endIfProfiled()` 的 thread-local 样本桥已经写到，但可以更强调“为什么不能每次都直接进 native，再让 native 自己判断”的失败方案。
- helper 的“共同结构”现在主要在结尾收网，仍可更早埋下，让读者从一开始就带着“这些 helper 各自都是 Java 收件箱”去读后文。
- 测试压力还可拉得更具体，例如 `SpanTests`、`SpanApiApp` 正在证明 before/during/after session 行为、sampled-only 过滤和 JFR 中 `profiler.Span` 事件落地结果。

## 6. 重写策略

1. 用“native 把调用织进去之后，总得有人在 Java 世界接电话”开场。
2. 推演并否定至少四个直觉：
   - 所有东西都直接碰 native，不需要 Java helper；
   - 每个 native 能力都该做一个厚重 Java façade；
   - `Recording`/`Span` 是另一套 Java profiler API；
   - helper 文件很薄，所以只是无关紧要的胶水。
3. 给出总图：字节码收件人 / trusted JNI 代理 / clock-state bridge / JDK API 代理。
4. 分层讲：
   - `Instrument` 为什么是插桩后的 Java 收件人，以及 Java 侧阈值过滤为什么先做；
   - `LockTracer` 为什么借 helper 获得 trusted `RegisterNatives` 上下文；
   - `Recording` 怎样提供 state/clock/DirectByteBuffer bridge；
   - `Span` 怎样利用 thread-local sample_counter 做 sampled-only 快速路径；
   - `JfrSync` 怎样充当 JDK JFR API 代理；
   - 最后再把几类 helper 收成同一种架构手法。
5. 收网时强调：helper 的价值不在于业务逻辑厚度，而在于它们让 native-first 架构以 JVM/Java 愿意接受的最小形状出现。

## 7. 结构大纲

### 第一节：事故开场——native 把能力织进 JVM 之后，Java 世界总得有人接电话

回答：为什么必须有最小 Java 收件箱，而不能只留 native 主逻辑裸奔或反过来把逻辑都搬进 Java。

预估字数：900-1200

### 第二节：先排除四个错误直觉——不需要 helper、helper 应该很厚、Recording/Span 是主 API、薄文件就说明不重要

预估字数：1800-2400

### 第三节：第一层——`Instrument` 为什么是字节码插桩真正调用到的 Java 收件人

证据：`src/helper/one/profiler/Instrument.java`、`src/instrument.cpp`。

回答：改写器织入普通 `invokestatic`、Java 侧阈值过滤、native `recordEntry/recordExit0` 才是事件记录主体。

### 第四节：第二层——`LockTracer` 为什么解决的是 trusted context，而不是业务锁逻辑

证据：`src/helper/one/profiler/LockTracer.java`、`src/lockTracer.cpp`。

回答：bootstrap class loader frame、`Unsafe.registerNatives` hook、helper 作为合法 Java 代理上下文。

### 第五节：第三层——`Recording` 为什么是 state/clock/thread-local bridge，而不是主 profiler façade

证据：`src/api/one/profiler/Recording.java`、`src/javaApi.cpp`、`src/threadLocalData.*`。

回答：`UNAVAILABLE/STOPPED/RUNNING`、时钟切换、DirectByteBuffer 暴露 TLD、主入口与辅助桥的边界。

### 第六节：第四层——`Span` 怎样利用 profiler 时钟和 thread-local sample 事实做 sampled-only 快速路径

证据：`src/api/one/profiler/Span.java`、`src/asprof.h`、`src/flightRecorder.cpp`、`src/javaApi.cpp`、`test/test/span/SpanApiApp.java`、`test/test/span/SpanTests.java`。

回答：`sample_counter` 的意义、before/during/after session 行为、`endIfProfiled` 的过滤语义、virtual thread 特判。

### 第七节：第五层——`JfrSync` 为什么是 helper 的另一种角色：JDK API 代理

证据：`src/helper/one/profiler/JfrSync.java`、`src/flightRecorder.cpp`。

回答：嵌入 class、listener、start/stop master recording、帮助 native 与 JDK JFR API 交互。

### 第八节：收网——把这些 helper 放在一起，才能看到 native-first 架构的完整闭环

桥接整卷收束：helper 让整个项目从 attach、采样、JFR/OTLP 到 Java 入口形成完整闭环。

## 8. 必须展开的失败方案

1. native 逻辑已经够强，所有事情都直接碰 native，就不需要 Java helper。
2. 既然进了 Java 世界，就应该做一个厚重的 Java façade，把主逻辑也搬过去。
3. `Instrument` / `LockTracer` 这些 helper 只是无足轻重的胶水文件。
4. `Recording` / `Span` 是另一套 Java profiler API，而不是辅助桥。
5. `Span.endIfProfiled()` 判断的是业务重要性，而不是 profiling sample 交集。
6. `JfrSync` 只是个特例，不体现 helper 的共同架构角色。

## 9. 证据清单

- `src/helper/one/profiler/Instrument.java`
- `src/instrument.cpp`
- `src/helper/one/profiler/LockTracer.java`
- `src/lockTracer.cpp`
- `src/api/one/profiler/Recording.java`
- `src/api/one/profiler/Span.java`
- `src/javaApi.cpp`
- `src/threadLocalData.h`
- `src/threadLocalData.cpp`
- `src/asprof.h`
- `src/flightRecorder.cpp`
- `src/helper/one/profiler/JfrSync.java`
- `test/test/span/SpanApiApp.java`
- `test/test/span/SpanTests.java`

## 10. 完成后检查

1. 删除代码块后，读者仍能复述“字节码收件人 / trusted JNI 代理 / clock-state bridge / JDK API 代理”这条主线。
2. 至少展开 4 个失败方案，而不是把 helper 类逐个平铺介绍。
3. 明确区分 `Instrument`、`LockTracer`、`Recording`、`Span`、`JfrSync` 各自的 helper 角色。
4. 不把 `Recording`/`Span` 写成主 profiler API，也不把 `LockTracer` 写成业务锁 façade。
5. 明确 `DirectByteBuffer` TLD 视图与 `sample_counter` 的桥接语义。
6. 把 helper 的共同架构模式收回成整卷闭环，而不是停留在分散的局部说明。
7. 每个 `file:line` 重新核对，链接、结构标记和禁用词通过。
