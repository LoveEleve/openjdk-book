# 域 24: 时间日期与格式化 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "为什么用 java.time 不用 Date(不可变/线程安全)" — 01 篇 §1/4(LocalDate.java:175-183, 值类型三原则)
- [x] "Instant 表示(秒+纳秒)/精度" — 01 篇 §2(Instant.java:253/258/213)
- [x] "Duration vs Period" — 02 篇 §2-3(Duration.java:161/166/486, Period 年月日)
- [x] "plusDays 怎么算" — 02 篇 §1(LocalDate.java:1371-1400 短路)
- [x] "时区/DST 怎么算(规则表)" — 03 篇 §3(ZoneRules.java:490/761)
- [x] "DateTimeFormatter 为什么线程安全" — 04 篇 §1-2(不可变+PrintContext)
- [x] "SimpleDateFormat 为什么不安全(可变 Calendar)" — 04 篇 §4
- [x] "parse 两阶段" — 04 篇 §3(441-457 注释)
- [x] "DST 间隙/重叠" — 05 篇 §2(146-183, withEarlierOffsetAtOverlap)
- [x] "ZonedDateTime vs OffsetDateTime 选型" — 05 篇 §3
- [x] "Clock 注入/tick" — 06 篇 §1-2(Clock.java:160/231/444)

## 身份 2: 生产工程师
- [x] 跨时区时间错 8 小时排查 — 03 篇
- [x] 时间存储规范(UTC/ISO/本地三层)— 06 篇 §3
- [x] 耗时统计 Duration — 02 篇 §2
- [x] DST 切换日 bug — 05 篇 §2
- [x] Date↔java.time 转换 — 05 篇 §4(Date.java:1358/1376)

## 身份 3: 框架工程师
- [x] 时间注入(Clock 可测试性)— 06 篇 §1
- [x] 序列化 ISO 格式 — 05 篇 §3
- [x] 数据库时间字段语义 — 06 篇 §3

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 LocalDate.java:146/151/175-183/267-271/854/1371-1400, LocalTime.java:221-229, Instant.java:213/253/258/303, Duration.java:161/166/486/689, ZoneId.java:271/355/487/562, ZoneOffset.java:151-164, ZoneRules.java:490/761/795, ZoneRulesProvider.java:89-102, DateTimeFormatter.java:563/1815/1841/1871/1987/2094, DateTimeFormatterBuilder.java:1706/1712, ZonedDateTime.java:138/175-183/292/366, OffsetDateTime.java:192/196, Clock.java:160/183/202/231/255/278/399/411/444, Date.java:1358/1376)/关键设计/跨层([内部卷]/[JLS]/[性能])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] 巨型域 6 篇分段写作:1-4 批自查(跨层补齐)→5-6 批

## 身份 5: 完整性缺口检查
- [x] 值类型(01)/运算(02)/时区(03)/格式化(04)/组合(05)/Clock(06)六篇覆盖域全部面试主战场
- [x] chrono(27 文件)/temporal(17)/zone(8) 子包已按机制并入各篇(IsoChronology 入 01/02,ChronoUnit 入 02,temporal 接口族入 01/05)
- [x] 旧 API(DateFormat/SimpleDateFormat/DecimalFormat)作对照并入 04 篇
- [x] 未覆盖确认: MonthDay/YearMonth/DayOfWeek 等辅助类(面试低频)不入篇,写作时可提
- [x] 二次 review 修正: 默认时区 Provider 类名为 **TzdbZoneRulesProvider**(zone/ 目录实测,非"DefaultZoneRulesProvider",后者是系统属性名 102);tick 实现为私有 TickClock(688,instant 用 Math.floorMod 取整 711);Duration.between 为 until(SECONDS)+NANO_OF_SECOND 字段差(486-503)
- [x] 验证通过: DateTimeFormatter 字段全 final(516-540,不可变成立);addExact 遍布(LocalDate 6/Instant 13/Duration 17 处);ZonedDateTime.ofLocal gap 用 getOffsetAfter/overlap 用 validOffsets.get(0)(366-395);Period 字段 int(158-166);ZoneRulesProvider ServiceLoader(89-102)
- [ ] 待办: 写作时验证 DateTimeFormatter 预定义常量(ISO_INSTANT 等)定义位置、ZoneRules 转换表内部结构(transition 列表格式)
