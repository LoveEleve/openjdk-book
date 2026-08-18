# 02. 时间运算 — plus/minus、Duration vs Period、between

> **前置依赖**: [24-time-date/01 — 核心值类型](01-core-value-types.md)(LocalDate/Instant/LocalTime)、[01-string/04 — 编码与 Unicode](../01-string/04-encoding-unicode.md)(值语义)
> → **后续**: 按写作顺序进入时区体系

## 时间“加法”为什么有两种

`plusDays(1)`、`Duration`、`Period` 看起来都在表示“加一段时间”,但它们处理的是不同语义: 时间线上的秒数,还是日历上的年月日。

## 1. "plusDays(1) 怎么算?" — 日期内部算术

### 1.1 LocalDate 的快路径

`LocalDate.plusDays(long)`(`LocalDate.java:1371`)先计算 `dom = day + daysToAdd`:

- `dom <= 28` 时,可以直接在当前月构造新日期
- `dom <= 59` 时,再结合 `lengthOfMonth()` 处理当前月/下一个月/跨年
- 其他跨度转成 `epochDay`,通过 `Math.addExact(toEpochDay(), daysToAdd)`(`:1397`)再由 `ofEpochDay` 重建日期

它不创建 `Duration`,也不调用 `Calendar`。这是 `LocalDate` 自己的日历字段/epoch-day 算术。

`isLeapYear()`(`LocalDate.java:854`)负责闰年判断。

关键设计(斜体):*`plusDays` 先走小跨度快路径,大跨度再转 epoch-day;不是“逐月循环”。面试"plusDays 与 Duration.ofDays(1) 一样吗": 结果可能相同,但操作语义与内部路径不同。*

## 2. "Duration 是什么?" — 秒 + 纳秒

### 2.1 存储与 between

`Duration` 保存:

- `seconds`(`Duration.java:161`)——秒
- `nanos`(`:166`)——纳秒调整量

`Duration.between(start, end)`(`:486`)以时间对象支持的秒/纳秒字段计算时间线差值,最终归一化为 Duration。它适合耗时、超时与固定时间量。

`plus(Duration)`(`:689`)把秒与纳秒分别相加,再处理纳秒进位。

### 2.2 语义

`Duration.ofDays(1)`表示固定的 86400 秒,与日历月份、夏令时规则无关。它是时间线上的物理时长,不是“当地日历上的一天”。

关键设计(斜体):*Duration = 秒/纳秒的物理时间。面试"Duration 适合什么": 耗时统计与超时控制;纳秒是表示粒度,不等于系统时钟实际精度。*

## 3. "Period 是什么?" — 年月日跨度

### 3.1 日历单位

`Period` 的核心字段是 `years`(`Period.java:158`)、`months`、`days`,表达日历跨度而不是固定秒数。

`Period.between(LocalDate, LocalDate)`(`:386`)计算两个日期之间的年月日差异。

### 3.2 与 Duration 的区别

- `Period.ofDays(1)`是日历上的一天
- `Duration.ofDays(1)`是固定 86400 秒
- 将它们应用到带时区的日期时间时,夏令时切换可能让“加一个日历日”和“加 24 小时”产生不同本地时间

“相差多少秒/耗时多久”通常用 Duration;“相差几年几月”用 Period。

关键设计(斜体):*Duration = 时间线跨度,Period = 日历跨度。面试"Duration 和 Period 区别": 一个以秒纳秒为核心,一个以年/月/日为核心;选错类型会把业务语义算错。*

## 4. "运算的安全" — 溢出与边界

### 4.1 溢出不是静默回绕

java.time 的很多运算使用 `Math.addExact`/`Math.multiplyExact` 一类检查,越过类型范围时抛出异常而不是静默回绕。`LocalDate.plusDays` 的 epoch-day 路径就调用 `Math.addExact`(`LocalDate.java:1397`)。

### 4.2 生产边界

LocalDate 的年份范围约为 ±9.99 亿年,Instant 也有明确的最大/最小范围。时间戳和大数值相加时,应在业务边界处理 `DateTimeException`/`ArithmeticException`。

关键设计(斜体):*java.time 的边界策略是“宁可抛异常,不静默产生错误日期”。面试"日期运算会不会越界": 会,应捕获或提前校验。*

## 核心悬念

“本地时间”没有时区,但业务要表达 `Asia/Shanghai` 的 14:00。夏令时切换那天 02:30 是否存在?下一篇: 时区体系。