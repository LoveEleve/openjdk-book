# 03. 时区体系 — ZoneId/ZoneOffset/ZoneRules 与 DST

> 🔴 Deep | 域 24 时间日期第 3 篇(巨型域 6 篇之三)| Layer 2
> 读者处境: 生产"跨时区时间错了 8 小时""夏令时切换出 bug"——时区 ID、偏移、DST 规则链一次讲清。

### 1. "ZoneId 是什么？" — 时区标识

场景: `ZoneId.of("Asia/Shanghai")` — 字符串怎么变成时区?

- `ZoneId.java:487` `getId()` — 标识符("Asia/Shanghai" 区域名 / "+08:00" 固定偏移 / "Z" UTC)
- `ZoneId.java:355` `of(String)` — 解析: 区域名 → 加载 ZoneRules;偏移形式 → ZoneOffset
- `ZoneId.java:271` `systemDefault()` — 读 JVM 默认时区(域 03 时间来源)
- `ZoneId.java:562` `getRules()` — 返回该时区的**规则表**
- 关键设计 (斜体): *ZoneId 是"标识符",真正的偏移计算在 ZoneRules——**ID 与规则分离**: 同一 ID 的规则可随 TZDB 数据升级而变;时区数据(tzdata)由 JDK 携带,版本更新影响偏移结果*
- 面试: "Asia/Shanghai 和 +08:00 有区别吗?"——区域名带 DST 历史,固定偏移没有;上海 1986-1991 曾有夏令时

### 2. "ZoneOffset 是什么？" — 固定偏移

场景: `+08:00` 与 `Asia/Shanghai` 在计算上差什么?

- `ZoneOffset.java:164` — `private final int totalSeconds` — **偏移以秒为单位存储**(8 小时 = 28800 秒)
- `ZoneOffset.java:151/155/159` — UTC/MIN/MAX 常量(±18 小时)
- 语义: 固定偏移,**无 DST 历史**——"时刻"换算线性
- 关键设计 (斜体): *偏移秒存储避免浮点/字符串比较——"时间数学"全是整数运算;面试"时区为什么不用字符串存"——偏移是数值(可运算),ID 是名称(可解析)*
- 生产: 存储/传输用 UTC(带 Z)或固定偏移——**不要存区域名+本地时间**(无规则上下文无法还原)

### 3. "ZoneRules 怎么算偏移？" — DST 与转换

场景: 美国 DST 切换那天 `getOffset(instant)` 返回什么?

- `zone/ZoneRules.java:490` `getOffset(Instant)` — 查规则表返回当时有效偏移
- `ZoneRules.java:761` `getStandardOffset` / `795` 附近 `isDaylightSavings` — 标准偏移与夏令时偏移分离
- 规则数据: 转换点(transition)列表——何时切换、切到多少
- 关键设计 (斜体): *"一个时区的偏移"是**时间的函数**——DST 期间偏移 +1 小时;ZonedDateTime 用"instant → 规则 → offset"两次查表;面试"夏令时怎么算"——不是公式,是查预编译的转换表(tzdata 生成)*
- 生产: 跨时区业务必须用 Instant 存时间点;DST 切换日(3 月/11 月)是时间 bug 高发期
- [C++: 内部卷 01-os(系统时区获取);数据: tzdata(ZoneRulesProvider 加载)]

### 4. "规则数据从哪来？" — ZoneRulesProvider

场景: `ZoneId.of("Europe/Paris")` 的规则数据存在哪?

- `zone/ZoneRulesProvider.java` — **ServiceLoader 机制**(89-102): JDK 默认提供 `TzdbZoneRulesProvider`(`zone/TzdbZoneRulesProvider.java`,加载打包的 tzdb 数据)
- 可插拔: 系统属性 `java.time.zone.DefaultZoneRulesProvider`(`ZoneRulesProvider.java:102`)指定自定义 Provider 全限定名
- 数据: 打包在 JDK 的 tzdb.dat(二进制时区数据,ZoneRules 序列化格式)
- 关键设计 (斜体): *时区数据与代码分离——JDK 升级可更新规则(不重编译);Provider 模式让企业可定制时区源;面试"时区数据在哪"——TZDB 打包(与内部卷 41-zip-jimage 同思想)*
- 生产: JDK 版本间 tzdata 更新导致的历史偏移变化(如某些地区改时区)

---

### 核心悬念

时间点、时区、规则都有了——**怎么打印成 "2026-08-14 14:00:00"**?`DateTimeFormatter.ofPattern("yyyy-MM-dd")` 的模式字符怎么被解析?为什么它是线程安全的而 SimpleDateFormat 不是?——下一篇: 格式化与解析。

> → [04-formatter-parse.md](04-formatter-parse.md)
