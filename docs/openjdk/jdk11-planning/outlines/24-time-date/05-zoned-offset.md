# 05. 组合类型 — ZonedDateTime/OffsetDateTime 与 DST 重叠

> 🟢 Surface | 域 24 时间日期第 5 篇(巨型域 6 篇之五)| Layer 2
> 读者处境: 生产"夏令时切换那天时间对不上"——重叠/间隙时刻的处理;ZonedDateTime 与 OffsetDateTime 怎么选。

### 1. "ZonedDateTime 里有什么？" — 三字段组合

场景: `ZonedDateTime.of(2026, 3, 8, 2, 30, 0, 0, zoneUS)` — 这个"不存在的时刻"会怎样?

- `ZonedDateTime.java:175/179/183` — `LocalDateTime dateTime` + `ZoneOffset offset` + `ZoneId zone` — **三件套**(本地时间 + 当时的偏移 + 时区规则)
- `ZonedDateTime.java:292` `of(LocalDateTime, ZoneId)` — 用 zone 的规则把本地时间转成有效 offset
- `ofLocal`(366)— 可指定 preferredOffset(重叠时选哪个)
- 关键设计 (斜体): *offset 是"快照"(创建时刻的偏移),zone 是"规则"(未来计算的依据)——**两者都要存**;DST 切换时同一本地时间对应两个 offset(重叠),或不含任何 offset(间隙)*
- 面试: "ZonedDateTime 为什么同时存 offset 和 zone?"——offset 保证"这个时刻是多少",zone 保证"以后怎么算"

### 2. "不存在的时刻怎么办？" — 间隙与重叠

场景: 美国 2026-03-08 02:00-03:00 被跳过(spring forward)——怎么处理?

- **间隙(gap)**: 本地时间不存在——`of` 会**前移**到间隙后的有效时刻(偏移 +1 后)
- **重叠(overlap)**: 本地时间出现两次(回拨)——默认选较早偏移;`withEarlierOffsetAtOverlap()`/`withLaterOffsetAtOverlap()`(`ZonedDateTime.java:138` 注释 + 方法)可显式选择
- 关键设计 (斜体): *"时刻唯一、本地时间可歧义"是时区计算的本质——面试"DST 切换日 02:30 是什么"——要么不存在(前移)要么有两个(需选);生产: 这种时刻一律用 Instant 运算避免歧义*
- 面试: "怎么避免 DST bug?"——存储 Instant/UTC,展示时转本地;业务时间点别用"本地时间字符串"存

### 3. "OffsetDateTime vs ZonedDateTime" — 选型

场景: 存储"带时区的时间"用哪个?

- `OffsetDateTime.java:192/196` — `LocalDateTime` + `ZoneOffset`(两件套)——**固定偏移,无 DST 规则**
- ZonedDateTime: 三件套(带规则,可计算未来偏移)
- 关键设计 (斜体): *选型规则: ① 只要"偏移"(日志时间戳/API 传输)→ OffsetDateTime ② 需要"规则"(加一个月后偏移可能变)→ ZonedDateTime;传输用 OffsetDateTime(带偏移),存储用 Instant,展示用 ZonedDateTime*
- 生产: 序列化(JSON)推荐 ISO-8601 带偏移字符串(OffsetDateTime 输出);数据库 TIMESTAMP WITH TIME ZONE 语义接近 OffsetDateTime
- 面试: "DateTimeFormatter.ISO_OFFSET_DATE_TIME 与 ISO_ZONED_DATE_TIME"——前者只输出偏移

### 4. "转换链路" — 时间类型互转

场景: 面试"Date/LocalDateTime/ZonedDateTime 怎么互转"——全链路

- 时间点: `Date ↔ Instant`(`java/util/Date.java:1358` from / `1376` toInstant)
- 本地化: `Instant.atZone(zone)` → ZonedDateTime;`ZonedDateTime.toLocalDateTime()` → LocalDateTime;`toLocalDate()/toLocalTime()`
- 无时区→有时区: `LocalDateTime.atZone(zone)`(LocalDateTime.java:1799)
- 关键设计 (斜体): *转换矩阵的核心是 Instant(时间点枢纽)——"本地时间"必须先配时区才能变成时间点;面试"LocalDateTime 转 Date"——先 atZone 再 toInstant 再 Date.from,缺时区就是错*
- [C++: 内部卷 01-os(时钟/epoch);性能: 时区转换是查表运算(ZoneRules 预编译),无浮点]
- 生产: 工具类封装转换(避免每处手写 atZone);UTC 一致性规范

---

### 核心悬念

`LocalDate.now()` 的"现在"从哪来?——**Clock**。它比 System.currentTimeMillis 强在哪?测试怎么注入假时间?tick 时钟怎么用?——下一篇: Clock 与时间最佳实践(收官)。

> → [06-clock-best-practice.md](06-clock-best-practice.md)
