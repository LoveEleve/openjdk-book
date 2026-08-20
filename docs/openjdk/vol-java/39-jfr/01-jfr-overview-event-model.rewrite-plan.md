# 39-jfr/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `jdk.jfr.Event`、`Recording`、`FlightRecorder`、`RecordingState`。本文聚焦 JFR 的三物件模型、事件生命周期和低开销设计动机；注解与配置留到后续篇章。
> 目标：把“JFR 全景与事件模型”改写成一篇围绕“JFR 不是另一种 dump 工具，也不是普通 profiler 的改名版，而是把 JVM 运行行为持续压成一条可低开销写入、可事后分析的事件流”展开的机制文章。

## 1. 读者困惑

- JFR 和 `jstack`、heap dump、常规 profiler 到底本质差在哪？
- 为什么 JFR 说自己是“事件录制”，而不是快照或周期采样？
- `FlightRecorder`、`Recording`、`Event` 这三个对象各自负责什么？
- `begin/end/commit` 为什么是事件生命周期的核心三步？
- JFR 为什么能在未启用时几乎零成本、启用后又保持较低开销？

## 2. 一句话顿悟

**JFR 的核心不是“收集更多信息”，而是把 JVM 和应用运行时的重要行为组织成一条持续事件流：`Event` 负责定义一次事件，`Recording` 负责界定一段录制窗口，`FlightRecorder` 负责承载全局录制引擎。与快照工具只截一瞬、采样工具周期性偷看不同，JFR 关心的是“事件发生时再写入”，再配合启用判断、阈值判断和环形缓冲，把长期录制的成本压到足够低。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 JFR 与 jstack/profiler 的对照、三物件模型、`begin/end/commit`、`shouldCommit` 和低开销动机。
- 已指出 `Event.java` 公开方法很多是空实现/注入点，这是理解 JFR 成本模型的关键。
- 已把事件未启用时的 no-op 特征讲出来，方向正确。

### 必须重写

- 旧稿偏卡片化，需要先立住总问题：JFR 为什么要把运行时信息做成事件流，而不是继续靠快照或采样。
- `FlightRecorder` / `Recording` / `Event` 要放到“事件流记录系统”这条主线上统一讲。
- `begin/end/commit` 和 `shouldCommit` 要讲成“事件写入协议”，而不是单独 API 清单。
- 低开销设计要回扣“未启用零成本、启用后低开销”的成本纪律。

## 4. 理解路径

### 第一节：从“为什么还需要 JFR,难道 jstack/jmap/profiler 不够吗”开场

用快照、采样和持续事件记录三种信息形态对照开场。先立住总问题：JFR 解决的是“保留一段时间窗口里的运行行为”，不是某个瞬时截面。

### 第二节：为什么 `FlightRecorder` / `Recording` / `Event` 刚好组成事件流系统

证据：
- `FlightRecorder.java:59/176`
- `Recording.java:63/168/209/640/658`
- `Event.java:91/102/110/121/144`
- `RecordingState.java:33`

主线：
- `FlightRecorder` 是全局录制引擎入口；
- `Recording` 是一段可配置录制窗口；
- `Event` 是单次事件载体。
- 三者合起来才构成“持续录制”的系统，而不是单个工具对象。

### 第三节：为什么 `begin/end/commit` 是事件生命周期的最小协议

证据：
- `Event.java:102/110/121/144`

主线：
- `begin/end` 负责定义事件时间范围；
- `commit` 才是真正把事件交给录制系统；
- `shouldCommit` 让调用者在提交前先做阈值和启用判断。
- 这解释了“事件不是构造出来就自动写”的协议边界。

### 第四节：为什么 Recording 代表的是“会话”,而不是全局唯一录制状态

证据：
- `Recording.java:168/209/602/623/640/658`
- `FlightRecorder.java:98/176`

主线：
- 录制可以 start/stop，也可以按事件类 enable/disable。
- 多个 recording 可以并存，代表不同观察窗口与配置策略。
- 这说明 JFR 天生是会话化的，而不是单一全局开关。

### 第五节：为什么 JFR 的开销控制首先来自“未启用几乎零成本”

证据：
- `Event.java:121/144`
- 旧稿中的 `isEnabled` / 空实现线索

主线：
- 事件未启用时，提交路径应尽量退化成 no-op 或极少判断。
- 只有启用并满足阈值时，才值得真正进入写入路径。
- 这就是 JFR 能长期挂着却不必像重型 profiler 那样时刻付费的根本原因。

### 第六节：为什么事件流比日志/快照/采样多了一种“事后分析窗口”

主线：
- 快照只保留某个时刻；
- 采样只保留定期观察点；
- 事件流保留的是“发生过哪些值得记录的行为”。
- 这解释了 JFR 为什么在生产问题复盘里有独特价值。

## 5. 失败方案清单

1. 把 JFR 当成另一种线程 dump 或 heap dump 工具。
2. 认为事件对象一创建就自动被记录，不理解 commit 协议。
3. 把 `FlightRecorder`、`Recording`、`Event` 混成同一层对象。
4. 只强调 JFR 能看什么，不解释它为什么能低开销长期录制。
5. 把 JFR 和普通日志混为“都是输出信息”的机制。

## 6. 误解清单

1. JFR 只是更轻量的 profiler。
2. `Recording` 等于全局唯一录制状态，不能并存多个会话。
3. `begin/end` 只是装饰 API，不影响事件协议。
4. `shouldCommit()` 只是优化小技巧，不影响设计本体。
5. 事件没启用时仍然会走完整写入路径，只是写得更少。

## 7. 证据清单

- `FlightRecorder.java:59/98/176`
- `Recording.java:63/168/209/602/623/640/658`
- `Event.java:91/102/110/121/144`
- `RecordingState.java:33`
- 旧稿中的 `Event.java` Javadoc 线索（`commit` / `shouldCommit` 的语义说明）

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 JFR 事件模型，不展开注解元数据和自定义事件字段定义。
- 不深入 native 环形缓冲实现，只把其作为低开销设计背景点到为止。
- JFR 消费 API、配置模板和生产策略放到后续篇章。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 JFR 不是快照/采样工具 → 三物件如何组成持续事件流系统 → `begin/end/commit` 和 `shouldCommit` 如何构成事件协议 → Recording 为什么是会话 → JFR 低开销为什么先来自未启用几乎零成本”。
- 必须把 JFR 讲成‘低开销持续事件记录系统’，而不是工具对比表。
- 必须自然引到 `02-custom-event-annotation.md`。
