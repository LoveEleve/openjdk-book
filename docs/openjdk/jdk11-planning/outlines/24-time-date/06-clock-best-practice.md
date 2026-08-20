# 06. Clock 与时间最佳实践 — 可注入时钟、生产规范

> 🟢 Surface | 域 24 时间日期第 6 篇(巨型域 6 篇之六)| Layer 2
> 读者处境: 生产"时间逻辑怎么测试""时间从哪里来"——Clock 抽象与全套时间使用规范收官。

### 1. "Clock 是什么？" — 时间源抽象

场景: `LocalDate.now()` 的"现在"是怎么来的?

- `Clock.java:444` — `public abstract Instant instant()` — **时间源抽象**(唯一的"现在"入口)
- `Clock.java:399/411` — `getZone()`/`withZone()` — 时区绑定
- 工厂: `systemUTC()`(`Clock.java:160`)/`systemDefaultZone()`(183)/`system(zone)`(202)— 真实系统时钟
- 关键设计 (斜体): *"时间"从具体实现(System.currentTimeMillis)抽象成接口——**依赖注入的核心**: 业务代码只依赖 Clock,测试注入固定时钟;对比直接调 System.currentTimeMillis 的不可测性*
- 生产: `LocalDate.now(clock)` 全方法族支持 Clock 参数(默认走 systemDefaultZone)

### 2. "tick 时钟是什么？" — 取整时钟

场景: 需要"秒级/分钟级"时间——tick 系列怎么取整?

- `Clock.java:231/255/278` — `tickMillis(zone)`/`tickSeconds`/`tickMinutes` — 内部 `new TickClock(system(zone), NANOS_PER_MILLI)`(`Clock.java:232-233`,私有 TickClock 类)返回**向下取整**到 tick 单位的时钟
- 实现: 内部包固定时钟(tick(Clock, Duration)),取整 = epoch 毫秒对 tick 取模
- 关键设计 (斜体): *tick 时钟的价值: ① 缓存友好(同一 tick 内返回同值)② 测试确定性;代价是精度损失(秒级 tick 在边界处有误差)——生产按需选择*
- 面试: "tickSeconds 的实现"——`tick(system(zone), Duration.ofSeconds(1))`——用 Duration 组合

### 3. "时间最佳实践" — 生产规范汇总

场景: 生产时间处理的完整规范——存储/传输/展示/测试

- 存储: **UTC Instant**(时间点)— 无时区歧义;数据库 TIMESTAMP(UTC)或 BIGINT epoch 毫秒
- 传输: ISO-8601 带偏移(OffsetDateTime 输出)— 可解析可比较
- 展示: 本地时区格式化(DateTimeFormatter + ZonedDateTime)
- 计算: 耗时用 Duration/ChronoUnit(与日历无关);日历运算用 Period
- 测试: Clock 注入 + 固定时区(ZoneId.of("Asia/Shanghai") 显式)
- 关键设计 (斜体): *"一个时间,三种形态": 存 UTC(确定)、传 ISO(标准)、显示本地(人看)——每层转换规则明确;最差实践: 存本地时间字符串(无时区上下文,不可还原)*
- 面试: "数据库时间字段类型建议"——TIMESTAMP WITH TIME ZONE(语义含偏移)/BIGINT epoch;避免 TIMESTAMP WITHOUT TIME ZONE(会话时区依赖)

### 4. 收官对照 — 全时间体系地图

场景: 面试"java.time 全景"——类型选择决策树

- 时间点: Instant / Date(旧)
- 本地视图: LocalDate / LocalTime / LocalDateTime(无时区)
- 带时区: ZonedDateTime(规则)/ OffsetDateTime(偏移)/ OffsetTime
- 跨度: Duration(秒)/ Period(年月日)/ ChronoUnit
- 格式化: DateTimeFormatter(线程安全)/ SimpleDateFormat(旧,非安全)
- 关键设计 (斜体): *选型口诀: "瞬时用 Instant,本地用 Local*,要规则用 Zoned,要偏移用 Offset,算物理时间用 Duration,算日历用 Period"——每类对应一个类,面试画决策树收尾*
- [C++: 内部卷 01-os(时钟来源系统调用);关联: 域 02 数字格式(DecimalFormat 对照)]
- [关联: 域 03 System 门面(时间戳 API)]

---

### 核心悬念

时间体系收官——但**时间与内存**: JVM 里的对象怎么被读取、DirectBuffer 怎么申请堆外内存?`Unsafe` 的能力边界在哪?——下一站: 域 32 Unsafe 与本地内存。

> → 下一篇: 域 32 Unsafe 与本地内存(32-unsafe 系列) | 关联: 域 03 System 门面
