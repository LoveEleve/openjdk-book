# 域 24: 时间日期与格式化 — 知识规划

> 源码路径: java.base/share/classes/java/time/(86 文件 56,663 行) + java/text/{DateFormat,SimpleDateFormat,NumberFormat,DecimalFormat}.java(对照)
> 源码量: 86 文件 / ~57,000 行 | 🔴 巨型域
> 写作层: Layer 2(前置: 域 02 数字数学)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| LocalDate.java (2230) | **日期值类型**: year int(175)/month short(179)/day short(183) 紧凑字段、MIN/MAX(146/151)、of(267)、isLeapYear(854 委托 IsoChronology)、plusDays(1371)、不可变+value-based | High |
| LocalTime.java (1736) | **时间值类型**: hour/minute/second/nano 字段、范围校验、plus/minus | High |
| LocalDateTime.java (2013) | **日期+时间组合**: 持 LocalDate+LocalTime,无时区 | High |
| Instant.java (1370) | **时间点**: seconds long(253)+nanos int(258)、EPOCH(213)、ofEpochSecond(303)、与 LocalDate 转换(UTC) | High |
| Duration.java (1557) | **秒级跨度**: seconds(161)+nanos(166)、between(486)、plus(689)——基于秒的精确时长 | High |
| Period.java (1082) | **日历跨度**: 年/月/日字段,基于日历的跨度(与 Duration 对比) | Medium |
| ZonedDateTime.java (2265) | **带时区日期时间**: LocalDateTime+ZoneId+offset,重叠/间隙处理 | High |
| OffsetDateTime/OffsetTime (1953/1438) | **带偏移组合**: LocalDateTime+ZoneOffset | Medium |
| Clock.java (742) | **时钟抽象**: systemUTC(160)/systemDefaultZone(183)/tick 系列(231/255/278)——替代 System.currentTimeMillis 的可注入时钟 | High |
| ZoneId.java (664) | **时区 ID**: systemDefault(271)/of(355,解析+规则加载)/getId(487)/getRules(562) | High |
| ZoneOffset.java (800) | **固定偏移**: 秒为单位、UTC/最大/最小常量、解析 | Medium |
| zone/ZoneRules.java | **时区规则**: getOffset(490,按 Instant 查偏移)、DST 转换、重叠/间隙定义 | High |
| zone/ZoneRulesProvider.java | **规则供给**: ServiceLoader 加载(89-102)、系统属性指定、默认 TZDB 数据 | Medium |
| format/DateTimeFormatter.java | **格式化器**: ofPattern(563)、format(1815,经 DateTimeFormatterBuilder/PrintContext)、parse(1871/1912,经 Parsed)——不可变+线程安全 | High |
| format/DateTimeFormatterBuilder.java | **格式化构建器**: 解析器组合(模式字符→解析器节点链) | Medium |
| chrono/IsoChronology.java | **ISO 历法**: 闰年规则/日期算法实现(isLeapYear 委托点) | Medium |
| java/text/SimpleDateFormat (对照) | **旧格式化器**: 非线程安全(DateFormat 可共享字段)、模式字符串、与 DateTimeFormatter 对照 | Medium |

*17 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | 核心值类型(LocalDate/Time/DateTime/Instant) | 5 | 面试必考(不可变/线程安全/存储) |
| P1 | 时区体系(ZoneId/Offset/Rules) | 5 | 面试常问(时区/DST/数据库 datetime) |
| P1 | 格式化与解析 | 3 (DateTimeFormatter/Builder) | 面试常问(线程安全/与 SimpleDateFormat 对比) |
| P2 | Duration/Period | 2 | 面试偶尔(区别) |
| P2 | Clock | 1 | 生产(可测试性/时间注入) |
| P3 | ZonedDateTime 细节 | 2 | 面试低频 |
| P3 | 旧 API 对照 | 2 (DateFormat/SimpleDateFormat) | 面试对照用 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | 核心值类型与不可变 | 面试必考(为什么 java.time 线程安全/替代 Date/SimpleDateFormat 的理由) |
| 🔴 Deep | 时区与 DST | 面试高频(UTC/时区转换/闰秒概念);生产(跨时区业务/数据库存储) |
| 🔴 Deep | DateTimeFormatter 线程安全 | 面试常问(与 SimpleDateFormat 的对比是经典题) |
| 🟡 Working | Duration vs Period | 面试偶尔;生产(时长计算) |
| 🟡 Working | Clock 注入 | 生产(测试/时间敏感逻辑) |
| 🟢 Surface | ZonedDateTime 细节 | 面试低频;使用时查阅 |

## 04 聚类

### 依赖图(域内)
```
TemporalAccessor/Temporal(接口) ←── LocalDate/LocalTime/Instant/ZonedDateTime(值类型)
Instant(秒+纳秒) ←── 算术(Duration)
LocalDate ←── Period(日历跨度)/ChronoUnit
ZoneId ←── ZoneRules(规则) ←── ZoneRulesProvider(数据源)
LocalDateTime+ZoneId → ZonedDateTime;LocalDateTime+ZoneOffset → OffsetDateTime
DateTimeFormatter ←── Builder/Parsed(打印/解析上下文)
Clock ←── 各 now() 的默认时钟
```

### 教学顺序与文章拆分(6 篇,巨型域分段)

1. **核心值类型: LocalDate/LocalTime/LocalDateTime/Instant** — 不可变设计、字段存储、工厂方法、范围
2. **时间运算: plus/minus/Duration/Period** — 算术实现、Duration(秒)vs Period(日历)、between
3. **时区体系: ZoneId/ZoneOffset/ZoneRules** — 时区 ID、偏移、DST 转换、ZoneRulesProvider、数据库时区实践
4. **格式化与解析: DateTimeFormatter** — 模式、format/parse 流程、线程安全、与 SimpleDateFormat 对照
5. **组合类型: ZonedDateTime/OffsetDateTime** — 时区组合、DST 重叠/间隙、转换
6. **Clock 与时间最佳实践** — Clock 抽象、tick、测试注入、生产规范(UTC 存储/展示转换)

> 前置: 域 02(数学/精度)。跨层: Instant 与内部卷时间(epoch);时区数据(TZDB,内部卷 01-os 时间来源);SimpleDateFormat 线程安全对照域 11
