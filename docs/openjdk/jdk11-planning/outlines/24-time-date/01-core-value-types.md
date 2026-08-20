# 01. 核心值类型 — LocalDate/LocalTime/Instant 的不可变设计

> 🔴 Deep | 域 24 时间日期第 1 篇(巨型域 6 篇之一)| Layer 2
> 读者处境: 面试"为什么用 java.time 不用 Date"——从存储字段到不可变语义,核心值类型的设计一次讲透。

### 1. "LocalDate 里存了什么？" — 紧凑字段与工厂

场景: `LocalDate.of(2026, 8, 14)` — 这个对象内存里是什么?

- `LocalDate.java:175/179/183` — `private final int year` / `private final short month` / `private final short day` — **字段级压缩**(month/day 用 short,省 4 字节)
- `LocalDate.java:267` `of(year, month, day)` — **先校验再创建**(YEAR/MONTH_OF_DAY ValueRange.checkValidValue,267-271)——工厂模式保证不变量
- `LocalDate.java:146/151` MIN/MAX 常量(Year.MIN_VALUE=-999999999..MAX)——范围极大
- 关键设计 (斜体): *"值类型"三原则: ① final 字段(不可变)② 工厂校验(不变量)③ value-based(可缓存);对比 Date 的可变字段,这就是线程安全的根基*
- 面试: "LocalDate 线程安全吗?"——不可变 ⇒ 线程安全(无需同步);面试答"因为 final 字段+无 setter"比背结论强

### 2. "Instant 怎么表示时间点？" — 秒 + 纳秒

场景: `Instant.now()` 的时间戳在内存里是什么?为什么比 Date 精确?

- `Instant.java:253/258` — `private final long seconds`(epoch 秒,可负)+ `private final int nanos`(0-999999999)
- `Instant.java:213` EPOCH = Instant(0, 0);`ofEpochSecond`(303)构造
- 精度: 纳秒(9 位)——取决于系统时钟实际精度(域 03 nanoTime 讨论)
- 与 LocalDate 关系: Instant = UTC 视角的时间点;LocalDate = 本地视角的日期(需时区才能互转)
- 关键设计 (斜体): *"时间点"必须是全局唯一的表示——秒+纳秒(UTC 纪元)是标准;Date 内部也是 long 毫秒(epoch)——java.time 是"重设计",不是新算法*
- 面试: "Instant vs Date"——Instant 精度纳秒+不可变;Date 毫秒+可变
- [C++: 内部卷 01-os(epoch 时间来源);域 03 currentTimeMillis 对照]

### 3. "LocalTime 的范围" — 时分秒纳秒

场景: `LocalTime.of(23, 59, 59)` 是合法值吗?校验边界在哪?

- `LocalTime.java:221/225/229` — `private final byte hour/minute/second` + `private final int nanos`
- 校验: hour 0-23, minute/second 0-59, nanos 0-999999999——构造时 ValueRange 检查
- 注意: 没有"24:00"概念(23:59:59.999999999 是最大)——与数据库 TIME 语义一致
- 关键设计 (斜体): *LocalTime 是"墙上时间"不含时区——只描述"一天内的时刻";与 Instant(时间点)是两种语义: 面试"LocalTime 和 Instant 的区别"——前者无日期无时区,后者有时区基准*
- 面试: "LocalDateTime 为什么不是时间点?"——无时区 ⇒ 不能转 epoch;必须配合 ZoneId(第 5 篇)

### 4. "为什么不用 Date/SimpleDateFormat 了？" — 新旧对比

场景: 面试"java.time 解决了 Date 的什么问题"——三大痛点

- Date: 可变(可被 setTime 改)、语义混乱(year 1900 起算)、毫秒精度、线程不安全格式化
- Calendar: 可变+复杂+线程不安全
- java.time: 不可变 + 清晰语义(瞬时/日期/时间/时长分离)+ 纳秒 + 线程安全格式化(第 4 篇)
- 关键设计 (斜体): *面试标准答法分四点: 不可变、语义分层(Instant/Duration 瞬时 vs Local* 本地)、时区体系、格式化线程安全——每点对应一个 JDK 类*
- 生产: 遗留代码 Date ↔ java.time 转换(Date.toInstant/Date.from,Java 8 起)

---

### 核心悬念

日期能"加一天"了——但**怎么加**?`plusDays(1)` 是纯字段算术还是查表?`Duration` 和 `Period` 的"一天"有什么区别?——下一篇: 时间运算。

> → [02-duration-period.md](02-duration-period.md)
