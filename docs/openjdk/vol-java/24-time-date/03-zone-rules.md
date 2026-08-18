# 03. 时区体系 — ZoneId/ZoneOffset/ZoneRules 与 DST

> **前置依赖**: [24-time-date/01 — 核心值类型](01-core-value-types.md)(Instant/LocalDate)、[24-time-date/02 — 时间运算](02-duration-period.md)(时间线与日历跨度)
> → **后续**: 按写作顺序进入格式化与解析
> 关联: 内部卷 01-os(系统时区与时间来源)

## 字符串时区背后是什么

`ZoneId.of("Asia/Shanghai")` 得到的首先是一个**标识符对象**。真正回答“某一时刻偏移多少”的，是它背后的 `ZoneRules`。

## 1. "ZoneId 是什么?" — 时区标识

### 1.1 ID 与规则

- `ZoneId.of(String)`(`ZoneId.java:355`)解析区域名或偏移形式
- `getId()`(`:487`)返回标识符
- `systemDefault()`(`:271`)读取 JVM 默认时区
- `getRules()`(`:562`)取得规则表

区域 ID 如 `Asia/Shanghai` 携带历史规则语义;固定偏移如 `+08:00` 只表示一个恒定秒数,没有 DST 历史。

关键设计(斜体):*ZoneId = 标识符,ZoneRules = 偏移计算规则。ID 与规则分离,因此 tzdata 更新可能改变某些历史/未来偏移结果。面试"Asia/Shanghai 和 +08:00 有什么区别": 区域名有规则历史,固定偏移没有。*

## 2. "ZoneOffset 是什么?" — 固定偏移

### 2.1 秒存储

`ZoneOffset` 用 `totalSeconds`(`ZoneOffset.java:164`)保存相对 UTC 的偏移秒数:

- `UTC`(`:151`) = 0 秒
- `MIN`(`:155`) / `MAX`(`:159`) = ±18 小时边界

固定偏移的换算就是整数秒运算,不包含夏令时切换。

### 2.2 生产语义

存储/传输时间点时,优先使用 UTC/Instant 或明确的固定偏移。单独存“区域名 + 本地时间”还不足以确定一个唯一时间点,还需要该区域的规则版本与歧义处理策略。

关键设计(斜体):*偏移是数值,ID 是可解析名称。面试"时区为什么不是字符串运算": 偏移需要参与时间数学,所以最终落成秒数。*

## 3. "ZoneRules 怎么算偏移?" — DST 与转换

### 3.1 时间是偏移的输入

`ZoneRules.getOffset(Instant)`(`ZoneRules.java:490`)根据时间点查出当时有效偏移。

标准偏移与夏令时偏移分开:

- `getStandardOffset(Instant)`(`:761`)返回标准偏移
- `isDaylightSavings(Instant)`(`:814`)比较标准偏移与当前偏移

规则内部保存转换点与未来转换规则;DST 不是固定公式,而是规则数据驱动的时间函数。

### 3.2 本地时间的歧义

把 `LocalDateTime` 映射到时区时,可能出现:

- **Gap**: 时钟向前跳,某些本地时间不存在
- **Overlap**: 时钟向后拨,某些本地时间对应两个偏移

`getValidOffsets(LocalDateTime)`(`:597`)可以查询合法偏移数量,`getTransition(LocalDateTime)`(`:640`)可以取得转换信息。

关键设计(斜体):*“一个时区的偏移”是时间的函数。面试"夏令时怎么算": 查规则转换,不是手写加一小时公式;生产: DST 切换日要显式测试 Gap/Overlap。*

## 4. "规则数据从哪来?" — ZoneRulesProvider

### 4.1 Provider 链

`TzdbZoneRulesProvider`(`jdk/time/zone/TzdbZoneRulesProvider.java:86`)是 JDK 默认的 TZDB provider,负责加载打包的时区数据。`ZoneId.of` 解析区域后,最终通过 provider 获取 `ZoneRules`。

时区规则与 Java 代码分离,JDK 升级可以携带新的 tzdata,不需要重新编译业务代码。

### 4.2 生产边界

不同 JDK 版本的 tzdata 可能不同,同一历史日期的偏移结果也可能随规则更新而变化。跨时区系统应保存明确的时间点、区域 ID 与业务需要的本地显示信息。

关键设计(斜体):*时区数据与代码分离——Provider 负责规则来源,ZoneRules 负责查询。面试"时区数据在哪": JDK 携带的 TZDB 数据;生产: 升级 JDK 时回归关键历史时间。*

## 核心悬念

时间点、时区、规则都有了——**怎么打印成文本**?`DateTimeFormatter` 的模式字符如何解析,为什么它能安全复用?下一篇: 格式化与解析。