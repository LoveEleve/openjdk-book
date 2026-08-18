# 05. 组合类型 — ZonedDateTime/OffsetDateTime 与 DST 重叠

> **前置依赖**: [24-time-date/03 — 时区体系](03-zone-rules.md)(ZoneRules/GAP/Overlap)、[24-time-date/01 — 核心值类型](01-core-value-types.md)(Instant/LocalDateTime)
> → **后续**: 按写作顺序进入 Clock 与时间最佳实践

## 本地时间怎样变成时间点

`LocalDateTime` 只有墙上时间。要把它变成可比较、可存储的时间点,必须补上偏移或时区规则。

## 1. "ZonedDateTime 里有什么?" — 三字段组合

### 1.1 三件套

`ZonedDateTime` 保存三个核心字段:

- `dateTime`(`ZonedDateTime.java:175`)——本地日期时间
- `offset`(`:179`)——当前有效偏移快照
- `zone`(`:183`)——区域 ID 与规则

`of(LocalDateTime, ZoneId)`(`:292`)委托 `ofLocal`(`:366`),由 zone 规则决定有效 offset;`preferredOffset` 可参与重叠时的选择。

关键设计(斜体):*offset 是“此刻采用的偏移快照”,zone 是“未来计算的规则来源”。两者都保存,才能同时表达当前时间点与所属区域。*

## 2. "不存在的时刻怎么办?" — Gap 与 Overlap

### 2.1 Gap

DST 向前跳时,一段本地时间根本不存在。`ZonedDateTime.of` 的默认本地解析策略会把 Gap 中的本地时间向前调整到 Gap 之后的有效时间。

### 2.2 Overlap

DST 向后拨时,一段本地时间对应两个有效偏移。默认策略选择较早的偏移,也可以显式调用:

- `withEarlierOffsetAtOverlap()`(`ZonedDateTime.java:891`)
- `withLaterOffsetAtOverlap()`(`:919`)

面试"DST 切换日 02:30 是什么": 可能不存在,也可能有两个对应时间点;不要把本地字符串当成唯一时间点。

关键设计(斜体):*“时间点唯一,本地时间可歧义”是 DST 的本质。生产存储优先使用 Instant/UTC,展示时再转换到区域时间。*

## 3. "OffsetDateTime vs ZonedDateTime" — 选型

### 3.1 两件套与三件套

`OffsetDateTime` 保存:

- `dateTime`(`OffsetDateTime.java:192`)——本地日期时间
- `offset`(`:196`)——固定偏移

它没有区域规则,不会根据未来日期自动推导 DST。`ZonedDateTime` 才保存 ZoneId 与 ZoneRules。

### 3.2 选型规则

- 只需要明确偏移(日志时间戳、API 传输) → `OffsetDateTime`
- 需要按区域规则计算未来时间 → `ZonedDateTime`
- 持久化绝对时间点 → `Instant`
- 用户展示 → `ZonedDateTime`

生产 JSON/协议可使用 ISO-8601 带偏移表示;数据库具体 TIMESTAMP WITH TIME ZONE 语义仍需按数据库实现确认,不能简单等同某一个 Java 类型。

关键设计(斜体):*选型先问“需要偏移还是需要规则”: OffsetDateTime 表示带偏移的值,ZonedDateTime 表示带区域规则的值,Instant 表示时间线上的点。*

## 4. "转换链路" — 时间类型互转

### 4.1 Instant 枢纽

- `Date ↔ Instant`: `Date.from`(`java/util/Date.java:1358`) / `toInstant`(`:1376`)
- `Instant.atZone(zone)` → `ZonedDateTime`
- `ZonedDateTime.toLocalDateTime()` → `LocalDateTime`
- `LocalDateTime.atZone(zone)`(`LocalDateTime.java:1799`) → `ZonedDateTime`

### 4.2 转换原则

`LocalDateTime → Date` 不能直接完成: 必须先 `atZone(zone)`→`toInstant()`→`Date.from(...)`。缺少 ZoneId 就缺少把本地时间定位到时间线的规则。

关键设计(斜体):*Instant 是转换矩阵的时间点枢纽。“本地时间”必须先补时区/偏移才能成为可比较的时间点。生产把转换集中在工具层,统一 UTC 与区域规则。*

## 核心悬念

`LocalDate.now()` 的“现在”从哪来?——**Clock**。它比直接调用系统时间更适合测试与注入吗?tick 时钟怎么用?下一篇: Clock 与时间最佳实践。