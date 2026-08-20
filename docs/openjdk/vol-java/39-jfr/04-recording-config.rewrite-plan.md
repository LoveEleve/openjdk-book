# 39-jfr/04 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Recording`、`Configuration`、`EventSettings`、`PlatformRecording`。本文聚焦录制会话生命周期、预置配置模板、事件级别开关与保留策略；消费者 API放到下一篇。
> 目标：把“录制与配置”改写成一篇围绕“JFR 录制真正要控制的不是‘有没有写文件’，而是哪些事件在什么时间窗口里、以什么阈值和保留策略被记录下来；`Recording`、`Configuration` 和 `EventSettings` 分别承担会话、模板和事件级规则”展开的机制文章。

## 1. 读者困惑

- `Recording` 到底只是一个文件句柄，还是一段可配置的录制会话？
- 为什么 JFR 还要区分 `Configuration` 模板和 `EventSettings` 链式设置，两者各自解决什么问题？
- `default` 和 `profile` 这类配置差别到底落在哪，为什么问题定位时会选不同模板？
- `setDestination`、`setToDisk`、`setMaxAge`、`setMaxSize` 控制的分别是什么？
- JFR 录制为什么不是简单“开了就一直写”，而是明确强调窗口、保留和淘汰策略？

## 2. 一句话顿悟

**JFR 录制的本质不是“把事件写到文件”，而是“在一段 Recording 会话里，按某套 Configuration 模板和 EventSettings 规则决定哪些事件值得被保留、保留多久、最终落到哪里”。`Recording` 决定时间窗口和输出边界，`Configuration` 给出一组预置录制策略，`EventSettings` 再把事件级开关、阈值、周期和栈策略调细。保留策略如 `setMaxAge` / `setMaxSize` 则进一步说明，JFR 追求的是可控、可长期运行的记录面，而不是无限制堆积数据。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 Recording 构造、生命周期、Configuration 预置模板、EventSettings 链式配置和 toDisk/maxAge/maxSize 这些关键点。
- 已把 default/profile 区分成场景选择，而不是只背名字。
- 已点出默认落盘与 oldest chunk 淘汰语义，这对理解长期录制很重要。

### 必须重写

- 旧稿偏配置卡片，需要先立住总问题：JFR 真正控制的是录制窗口和保留策略，不只是导出文件。
- `Recording`、`Configuration`、`EventSettings` 要统一到“会话 → 模板 → 事件级规则”这条主线上。
- default/profile 的差别要讲成“成本预算不同的录制策略”，而不是预置文件介绍。
- 磁盘/内存/淘汰策略要服务于“长期录制可控性”的结论。

## 4. 理解路径

### 第一节：从“JFR 录制要控制的到底是什么”开场

承接前三篇：事件已经能写入。继续追问——真实系统里不可能把所有事件无限期开着无限制写，所以必须控制窗口、启用范围、阈值和保留边界。

### 第二节：为什么 `Recording` 代表的是会话,而不是文件句柄

证据：
- `Recording.java:63/96/120/150`
- `Recording.java:168/209/374/462/531`
- `Recording.java:409/432`

主线：
- 构造只是建立会话对象；
- start/stop 定义录制窗口；
- dump/destination/toDisk/maxAge/maxSize 决定输出与保留边界；
- 这说明 Recording 的本体是“一段录制策略正在生效的会话”。

### 第三节：为什么 `Configuration` 是模板，而不是运行时状态

证据：
- `Configuration.java:48/49/57/75/181/191/195`

主线：
- Configuration 本质是一组 settings 和元数据；
- `getConfiguration(name)` / `getConfigurations()` 说明它是预置模板集合；
- default/profile 的差别在于事件启用集和阈值预算不同。

### 第四节：为什么 `EventSettings` 要单独存在：模板还不够,你还需要事件级细调

证据：
- `EventSettings.java:56/69/103/114`
- `Recording.java:602/623/640/658`

主线：
- 模板给的是整体预算；
- EventSettings 用 enable/disable/withThreshold/withPeriod/withStackTrace 细调某类事件；
- 这形成“全局模板 + 局部微调”的双层配置模型。

### 第五节：为什么 `toDisk` / `maxAge` / `maxSize` 体现的是长期运行的保留纪律

证据：
- `Recording.java:409/432/462/531`
- `PlatformRecording.java:58/70/437`

主线：
- 默认落盘意味着 JFR 天生支持持续记录；
- `setToDisk(false)` 说明也可以只留内存窗口；
- `setMaxAge` / `setMaxSize` 体现的是受控淘汰最旧 chunk，而不是无限增长。
- 这回扣 JFR 作为长期录制系统的可控性设计。

### 第六节：为什么 default/profile 的选择本质上是“你愿意为观察支付多少成本”

主线：
- default 适合低干扰、常驻背景录制；
- profile 适合更强诊断、更多事件、可能更高成本；
- 这不是功能有无，而是成本预算不同。

## 5. 失败方案清单

1. 把 Recording 当成“最终输出文件”的别名，而不是录制会话。
2. 录制时只想着 start/stop，不考虑事件启用范围和阈值。
3. 不区分模板配置和事件级微调，所有场景都手写一套大配置。
4. 长期开启录制却不设保留边界，默认期待数据无限堆着没问题。
5. 在低干扰场景直接上 profile，而不考虑成本预算。

## 6. 误解清单

1. `Configuration` 就是 Recording 当前实时状态快照。
2. default/profile 的区别主要在输出文件格式，而不是事件集和阈值策略。
3. `setDestination` 只是 stop 之后才相关，和录制会话本身无关。
4. `setToDisk(false)` 等于“不再录制”，而不是只留内存窗口。
5. `setMaxAge`/`setMaxSize` 是导出文件之后的清理选项，而不是录制期间生效的保留策略。

## 7. 证据清单

- `Recording.java:63/96/120/150/168/209/374/409/432/462/531/602/623/640/658`
- `Configuration.java:48/49/57/75/181/191/195`
- `EventSettings.java:56/69/103/114`
- `PlatformRecording.java:58/70/437`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦录制会话和配置，不展开消费 API 与文件解析细节。
- 不把 JFC XML 文件语法本身展开成配置语言教程。
- 缓冲与刷盘内部线程只作为背景，不深入实现。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 Recording 是会话而不是文件 → Configuration 为什么是模板 → EventSettings 为什么负责事件级微调 → toDisk/maxAge/maxSize 如何体现长期录制保留策略 → default/profile 本质上是成本预算选择”。
- 必须把录制配置讲成‘会话+模板+事件级规则’三层模型。
- 必须自然引到 `05-consumer-api.md`。
