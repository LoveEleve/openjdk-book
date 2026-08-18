# 01. 核心值类型 — LocalDate/LocalTime/Instant 的不可变设计

> **前置依赖**: [01-string/04 — 编码与 Unicode](../01-string/04-encoding-unicode.md)(值与文本表示)、[03-object-system/01 — Object 契约](../03-object-system/01-object-contract-references.md)(不可变对象基础)
> → **后续**: 按写作顺序进入时间运算
> 关联: 内部卷 01-os(epoch 时间来源)

## java.time 的核心思路

`java.time` 不是把旧 `Date` 换个名字,而是把**日期、墙上时间、时间点、时长**拆成不同的值类型,每个类型都尽量保持不可变。

## 1. "LocalDate 里存了什么?" — 紧凑字段与工厂

### 1.1 字段布局

`LocalDate` 用三个 final 字段保存日期:

- `year`(`LocalDate.java:175`)——`int`
- `month`(`:179`)——`short`
- `day`(`:183`)——`short`

`LocalDate` 的边界常量是 `MIN`(`:146`)与 `MAX`(`:151`),年份范围覆盖 `Year.MIN_VALUE` 到 `Year.MAX_VALUE`。

### 1.2 工厂校验

`LocalDate.of(year, month, dayOfMonth)`(`:267`)不会直接暴露构造器,而是先验证字段范围,再创建对象。日期对象一旦创建,字段没有 setter 可改。

关键设计(斜体):*值类型的三原则是: final 字段保证不可变,工厂校验保证不变量,值语义让对象可以安全复用。面试"LocalDate 线程安全吗": 不可变对象可以安全共享。*

## 2. "Instant 怎么表示时间点?" — 秒 + 纳秒

### 2.1 存储模型

`Instant` 用两个 final 字段表示 UTC 纪元时间点:

- `seconds`(`Instant.java:253`)——epoch 秒,可为负
- `nanos`(`:258`)——纳秒调整量

`EPOCH`(`:213`)是 `(0, 0)`;`ofEpochSecond(long)`(`:303`)是构造入口。

纳秒是**表示精度**,不等于系统时钟每次都真的能提供纳秒级变化。实际精度取决于时钟源与操作系统。

### 2.2 Instant 与 LocalDate

- `Instant` 是 UTC 纪元上的唯一时间点
- `LocalDate` 是不含时区的本地日期
- 两者互转必须引入时区,因为同一个 Instant 在不同时区可能落到不同日期

关键设计(斜体):*时间点用"epoch 秒 + 纳秒"统一表示。面试"Instant vs Date": Instant 不可变且纳秒字段更细,Date 是 epoch 毫秒模型;但更高的表示精度不代表硬件时钟一定更精确。*

## 3. "LocalTime 的范围" — 时分秒纳秒

### 3.1 字段与边界

`LocalTime` 用四个字段保存一天内的时间:

- `hour`(`LocalTime.java:221`)——`byte`
- `minute`(`:225`)——`byte`
- `second`(`:229`)——`byte`
- `nano`(`:233`)——`int`

合法范围是 hour `0-23`、minute/second `0-59`、nano `0-999999999`。构造工厂负责检查这些范围。

### 3.2 语义边界

`LocalTime` 是墙上时间,不含日期与时区。它描述“一天中的时刻”,不是一个全球唯一的时间点;`24:00` 不是 `LocalTime` 的普通取值。

关键设计(斜体):*LocalTime 与 Instant 是两种不同语义: 前者描述本地一天内的时刻,后者描述 UTC 基准上的时间点。面试"LocalDateTime 为什么不是时间点": 没有时区偏移,不能单独映射到 epoch。*

## 4. "为什么不用 Date/SimpleDateFormat 了?" — 新旧对比

### 4.1 旧 API 痛点

- `Date`: 可变时间值、epoch 毫秒语义不够清晰
- `Calendar`: 可变且 API 复杂
- `SimpleDateFormat`: 有可变内部状态,并发共享时不安全

### 4.2 java.time 的分层

`java.time` 把 Instant、LocalDate、LocalTime、Duration、Period、ZoneId 等概念分开: 类型本身表达语义,不可变设计便于共享,格式化器也能安全复用。

生产上遗留转换可使用 `Date.toInstant()` 与 `Date.from(instant)`。

关键设计(斜体):*java.time 的改进不只是“精度更高”,而是不可变 + 语义分层 + 时区模型 + 可复用格式化器。面试"java.time 比 Date 好在哪": 先答语义与可变性,再答精度与线程安全。*