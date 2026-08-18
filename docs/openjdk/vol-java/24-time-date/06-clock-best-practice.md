# 06. Clock 与时间最佳实践 — 可注入时钟、生产规范

> **前置依赖**: [24-time-date/05 — ZonedDateTime 与 OffsetDateTime](05-zoned-offset.md)(时区组合)、[24-time-date/04 — 格式化与解析](04-formatter-parse.md)(文本输出)
> → **后续**: 域 32 Unsafe 与本地内存(按写作顺序)
> 关联: 内部卷 01-os(时钟来源与系统调用)

## “现在”应该从哪里来

如果业务代码到处直接调用 `System.currentTimeMillis()`,时间逻辑很难测试。`Clock` 把“现在”变成一个可以注入的依赖。

## 1. "Clock 是什么?" — 时间源抽象

### 1.1 核心接口

`Clock` 的抽象入口是 `instant()`(`Clock.java:444`),实现必须提供当前时间点。

时区相关能力:

- `systemUTC()`(`:160`)——UTC 系统时钟
- `systemDefaultZone()`(`:183`)——系统默认区域时钟
- `system(ZoneId)`(`:202`)——指定区域的系统时钟
- `getZone()`/`withZone()`——读取或替换时区视图(具体实现方法锚点见 `:503/:507`)

`LocalDate.now(clock)`(`LocalDate.java:227`)、`Instant.now(clock)`(`Instant.java:287`)等 API 可以接收 Clock,业务代码因此不必直接依赖系统时间。

关键设计(斜体):*“时间源抽象成 Clock”是依赖注入的核心。面试"为什么不用直接调 System.currentTimeMillis": 直接调用不可替换,Clock 可以注入固定实现做确定性测试。*

## 2. "tick 时钟是什么?" — 取整时钟

### 2.1 工厂

- `tickMillis(zone)`(`Clock.java:231`)
- `tickSeconds(zone)`(`:255`)
- `tickMinutes(zone)`(`:278`)

这些工厂创建按指定粒度更新的时钟,内部等价于 `tick(system(zone), Duration.ofMillis/Seconds/Minutes(...))`。

### 2.2 语义

tick 时钟会把可见时间截断到粒度边界: 同一个 tick 内多次读取可以得到相同值,代价是精度损失与边界误差。

关键设计(斜体):*tick 时钟用精度换稳定读取: 适合缓存键、低精度刷新与测试;不适合要求每次读取都反映最细时间变化的场景。*

## 3. "时间最佳实践" — 生产规范

### 3.1 三层形态

- **存储**: `Instant`/UTC 时间点;数据库具体类型按驱动与语义确认
- **传输**: ISO-8601 带偏移字符串(`OffsetDateTime`)
- **展示**: `ZonedDateTime` + `DateTimeFormatter` 转本地时区

不要只保存“本地时间字符串”: 没有时区/偏移上下文时,它无法唯一还原时间点。

### 3.2 运算与测试

- 耗时/超时: `Duration` 或 `ChronoUnit`
- 日历运算: `Period`/`LocalDate`
- 测试: 注入 `Clock.fixed(...)` 与显式 `ZoneId`
- 生产: 关键服务统一 UTC 存储,展示边界再转区域时间

关键设计(斜体):*“一个时间,三种形态”: 存 UTC 确定,传 ISO 标准,显示本地可读。每层转换规则明确,最差实践是存无法还原的本地时间字符串。*

## 4. "全时间体系" — 选型地图

| 语义 | 类型 |
|---|---|
| 时间点 | `Instant` / 旧 `Date` |
| 本地日期/时间 | `LocalDate` / `LocalTime` / `LocalDateTime` |
| 带区域规则 | `ZonedDateTime` |
| 带固定偏移 | `OffsetDateTime` / `OffsetTime` |
| 时间线跨度 | `Duration` / `ChronoUnit` |
| 日历跨度 | `Period` |
| 格式化 | `DateTimeFormatter` / 旧 `SimpleDateFormat` |

关键设计(斜体):*选型口诀: “瞬时用 Instant,本地用 Local*,要规则用 Zoned,要偏移用 Offset,算物理时间用 Duration,算日历用 Period”。*

跨层标注: [内部卷 01-os——时钟来源与系统调用;域 03 System——时间戳门面;域 02 数字格式——格式化线程安全对照]

## 本域收官

时间体系收官——下一站进入 Unsafe 与本地内存: 对象如何被读取,DirectBuffer 如何申请堆外内存,`Unsafe` 的能力边界在哪里。