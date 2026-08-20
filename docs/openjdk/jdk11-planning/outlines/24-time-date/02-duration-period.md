# 02. 时间运算 — plus/minus、Duration vs Period、between

> 🔴 Deep | 域 24 时间日期第 2 篇(巨型域 6 篇之二)| Layer 2
> 读者处境: 面试"Duration 和 Period 区别";生产"两个时间相差多少天/多少毫秒"——算术实现与跨度类型选型。

### 1. "plusDays(1) 怎么算的？" — 域内算术

场景: `2026-02-28.plusDays(1)` 返回什么?算法走哪条路?

- `LocalDate.java:1371` `plusDays(long)` — **不走 Duration/Calendar**——纯字段算术:
  - `dom = day + daysToAdd`;若 dom ≤ 28 直接 new LocalDate(年内短路,1382-1383)
  - 否则按月份天数(monthLen,含闰年判断)逐月/逐年进位(1385-1400)
- `isLeapYear`(`LocalDate.java:854`)委托 `IsoChronology.INSTANCE.isLeapYear`
- 关键设计 (斜体): *性能设计: "+1 天"的 99% 场景不跨月——先短路(≤28 直接构造);闰年判断只在边界月份触发;面试"plusDays 复杂度"——O(1) 字段运算*
- 面试: "plusDays 与 plus(Duration.ofDays(1)) 一样吗?"——结果相同但路径不同(Period/ChronoUnit 走 Temporal.addTo)

### 2. "Duration 是什么？" — 秒+纳秒的精确时长

场景: `Duration.between(t1, t2)` 计算耗时——内部结构与精度

- `Duration.java:161/166` — `private final long seconds` + `private final int nanos` — **秒级精度**(可纳秒)
- `Duration.java:486` `between(Temporal, Temporal)` — `start.until(end, SECONDS)` 秒差 + `NANO_OF_SECOND` 纳秒差 → `ofSeconds`(486-503)——基于字段差值(时间点差)
- `Duration.java:689` `plus(Duration)` — 秒/纳秒分别相加再归并(纳秒进位)
- 语义: 基于"秒"的精确时间量(24 小时固定 = 86400 秒,**与日历无关**)
- 关键设计 (斜体): *Duration 是"物理时间"(秒/毫秒/纳秒),不受时区/夏令时影响;到毫秒的转换 `toMillis` 是精确的(对秒+纳秒线性换算)*
- 生产: 耗时统计/超时控制用 Duration;精度够用毫秒场景也可用 System.nanoTime(域 03)
- [C++: 内部卷 01-os(系统时钟与时间源);关联: 域 03 System.nanoTime/currentTimeMillis]

### 3. "Period 是什么？" — 年/月/日的日历跨度

场景: 生日计算"age 差几年几月"——Duration 能算吗?

- `Period`(1082 行): `private final int years/months/days` — **日历单位**(年/月/日)
- 语义: "1 年"可能是 365 或 366 天(取决于起点)——**日历时长不是固定秒数**
- 与 Duration 对照: `Period.ofDays(1)` vs `Duration.ofDays(1)`——前者跨 DST 可能不是 24 小时
- 关键设计 (斜体): *面试核心区分: Duration=秒(物理时间,确定),Period=年月日(日历时间,不定);"相差多少天"要用 ChronoUnit.DAYS.between 或 Duration,"相差几岁"用 Period——选错类型是生产 bug 源头*
- 面试: "Duration.between(LocalDate, LocalDate) 报错吗?"——LocalDate 无秒,需要 toEpochDay 先转(ChronoUnit 方案)

### 4. "运算的安全" — 溢出与边界

场景: `Instant.MAX.plusSeconds(1)` 会发生什么?

- 算术溢出: `Math.addExact`/`Math.multiplyExact` 检测——溢出抛 ArithmeticException(而非静默回绕)
- 范围: LocalDate 支持 ±999,999,999 年;Instant ±10 亿年
- 关键设计 (斜体): *java.time 全系用 addExact 类显式溢出检测——"宁可抛异常不静默错"与 BigDecimal 同哲学;面试"日期运算会不会越界"——会抛 ArithmeticException*
- 生产: 时间戳 + 大数值时要预判溢出(epoch 秒在 2262 年才溢出 int——毫秒在 2038 问题,秒级 long 安全)

---

### 核心悬念

"本地时间"没有时区——但业务要"Asia/Shanghai 的 14:00"。**ZoneId 怎么把字符串变成时区规则?夏令时切换那天 02:30 存在吗?**——下一篇: 时区体系。

> → [03-zone-rules.md](03-zone-rules.md)
