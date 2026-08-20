# 24-time-date/05 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `LocalDateTime`、`OffsetDateTime`、`ZonedDateTime`。本文聚焦本地时间如何落到时间点、偏移与区域规则的分工、DST overlap/gap 下的歧义与类型选型；Clock 放到下一篇。
> 目标：把“组合类型”改写成一篇围绕“`LocalDateTime` 只是墙上时间，只有补上固定偏移或区域规则，它才可能落成唯一时间点；`OffsetDateTime` 与 `ZonedDateTime` 看起来都‘带时区’，但一个保存偏移结果，一个保存规则来源”展开的机制文章。

## 1. 读者困惑

- 为什么 `LocalDateTime` 看起来已经有年月日时分秒了，却仍然不是一个可比较、可存储的唯一时间点？
- `OffsetDateTime` 和 `ZonedDateTime` 都像“带时区的时间”，到底差在哪？
- 为什么同一个 `LocalDateTime.atZone(zone)` 在 DST 切换窗口会出现不存在时刻或重复时刻？
- 为什么存储和传输时经常推荐 `Instant` / `OffsetDateTime`，而业务展示又常落到 `ZonedDateTime`？
- 为什么 `LocalDateTime -> Date` 不能直接完成，必须先补 Zone/Offset？

## 2. 一句话顿悟

**`LocalDateTime` 只描述本地墙上时间，不携带它在时间线上的定位信息；`OffsetDateTime` 通过固定偏移把它锚定到唯一时间点，`ZonedDateTime` 则通过“本地时间 + 当前偏移快照 + 区域规则来源”同时保留当前定位和未来规则语义。前者适合明确偏移的传输值，后者适合需要按地区规则解释和继续运算的业务时间。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `ZonedDateTime` 的三字段、Gap/Overlap、`OffsetDateTime` vs `ZonedDateTime`、以及以 `Instant` 为枢纽的转换链。
- 已抓住 `withEarlierOffsetAtOverlap` / `withLaterOffsetAtOverlap` 这些关键处理点。
- 选型建议方向正确：传输偏向 `OffsetDateTime` / `Instant`，展示与规则计算偏向 `ZonedDateTime`。

### 必须重写

- 旧稿偏信息卡片，需要先立住总问题：为什么本地时间不等于时间点。
- `OffsetDateTime` 与 `ZonedDateTime` 的区别要放到“固定偏移结果 vs 区域规则来源”主线上统一讲。
- Gap/Overlap 要作为“本地时间落点失败或歧义”的证明，不宜只列术语。
- 转换链要服务于“Instant 是时间点枢纽”的结论，而不是简单 API 清单。

## 4. 理解路径

### 第一节：从“为什么完整的本地年月日时分秒仍然不够”开场

用 `LocalDateTime` 最容易误导人的地方开场：它看起来信息很多，但依旧不知道自己在 UTC 时间线上落在哪。立住总问题：时间值的“完整外观”不等于时间点唯一性。

### 第二节：LocalDateTime 为什么只停在墙上时间

证据：
- `LocalDateTime.java:135`：类定义
- `LocalDateTime.java:1765`：`atOffset`
- `LocalDateTime.java:1799`：`atZone`

主线：
- `LocalDateTime` 自身不保存 offset / zone。
- 正因为缺少定位信息，才需要 `atOffset` 或 `atZone` 把它投射到时间线。

### 第三节：OffsetDateTime 为什么是“本地时间 + 固定偏移”

证据：
- `OffsetDateTime.java:128`：类定义
- `OffsetDateTime.java:323`：`ofInstant`
- `OffsetDateTime.java:1760`：`toInstant`

主线：
- 只要 offset 已知，这个值就能唯一落到 `Instant`。
- 它适合协议、日志、接口边界这种“明确偏移即可”的值。
- 它不携带区域规则，因此不能代表某地区未来规则语义。

### 第四节：ZonedDateTime 为什么要同时保存本地时间、当前偏移快照和区域 ID

证据：
- 旧稿使用的字段位置：`ZonedDateTime.java:175/179/183`
- `ZonedDateTime.java:292/366`：`of` / `ofLocal`
- `ZonedDateTime.java:406/432`：`ofInstant`
- `ZonedDateTime.java:2167`：转 `OffsetDateTime`

主线：
- zone 负责规则来源，offset 负责当前这一刻采用的偏移结果。
- 两者一起保存，才能既表达“现在是哪一刻”，又保留“按哪个地区规则理解它”。
- 这解释了为什么 ZonedDateTime 比 OffsetDateTime 更适合业务展示和未来规则计算。

### 第五节：Gap / Overlap 为什么证明“本地时间到时间点”的映射并不总是直线

证据：
- `ZonedDateTime.java:366`：`ofLocal`
- `ZonedDateTime.java:891/919`：overlap 选择方法
- 结合上一章 `ZoneRules` 结论

主线：
- gap 表示某段本地时间根本不存在；overlap 表示同一本地时间可能对应两个时间点。
- `atZone`/`ofLocal` 不是机械附加 zone，而是在做规则驱动的消歧与修正。
- 这说明存储优先 `Instant` / UTC 不是教条，而是为了避免本地时间歧义。

### 第六节：为什么 Instant 是转换枢纽

证据：
- `OffsetDateTime.java:1760`
- `ZonedDateTime.java:406`
- `LocalDateTime.java:1765/1799`

主线：
- 绝大多数组合类型互转，本质都是“先落到时间线，再重新投影到另一种本地表示”。
- 没有 offset/zone 的本地时间不能直接变成 `Date` 或其他绝对时间类型。
- 这把所有转换规则收束到同一张图上。

## 5. 失败方案清单

1. 把 `LocalDateTime` 直接当成唯一时间点持久化或跨系统传输。
2. 用 `OffsetDateTime` 代替所有地区规则相关业务时间。
3. 忽略 DST overlap/gap，把 `atZone` 当作机械附加字符串。
4. 存储只保留本地时间和区域名，却假设它总能唯一还原事实时间。
5. 直接尝试 `LocalDateTime -> Date`，不先补 offset / zone。

## 6. 误解清单

1. 年月日时分秒已经完整，所以 `LocalDateTime` 天然唯一。
2. `OffsetDateTime` 和 `ZonedDateTime` 只差一个字段名。
3. 只要保存 `ZoneId`，就不必关心当前偏移。
4. `atZone` 一定只是把 zone 字符串贴上去。
5. 所有时间类型之间都可以直接互转，不需要先落到 `Instant`。

## 7. 证据清单

- `LocalDateTime.java:135/1765/1799`
- `OffsetDateTime.java:128/323/1760`
- `ZonedDateTime.java:175/179/183`
- `ZonedDateTime.java:292/366/406/432/891/919/2167`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦组合类型与时间点定位，不展开数据库类型实现细节。
- `Date` 只作为旧接口桥接对象点到为止，不展开完整遗留兼容专题。
- Clock 与“当前时间来源”留到下一篇。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 `LocalDateTime` 不足以唯一定位时间点 → `OffsetDateTime` 如何靠固定偏移落到时间线 → `ZonedDateTime` 为什么同时保存 offset 与 zone → Gap/Overlap 如何打破直觉 → 为什么 `Instant` 是转换枢纽”。
- 必须把 `OffsetDateTime` vs `ZonedDateTime` 讲清。
- 必须自然引到 `06-clock-best-practice.md`。
