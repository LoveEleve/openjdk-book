# 04. 格式化与解析 — DateTimeFormatter 流程与线程安全

> 🔴 Deep | 域 24 时间日期第 4 篇(巨型域 6 篇之四)| Layer 2
> 读者处境: 面试"SimpleDateFormat 为什么线程不安全 / DateTimeFormatter 为什么安全"——解析器节点链与上下文模型一次讲清。

### 1. "模式字符串怎么变成格式化器？" — Builder 节点链

场景: `ofPattern("yyyy-MM-dd HH:mm:ss")` — 字符串如何被解释?

- `format/DateTimeFormatter.java:563` `ofPattern(String)` — 委托 `DateTimeFormatterBuilder.appendPattern`(`format/DateTimeFormatterBuilder.java:1706`)→ `parsePattern`(1712)
- 模式字符 → **解析器节点链**: 每个模式片段(yyyy/M/d/HH/...)生成一个打印/解析节点,链式组合
- 节点类型: 文本/数字/符号/填充/可选段等(DateTimeFormatterBuilder 内部类)
- 关键设计 (斜体): *"模式 → 节点树"把格式化变成**组合器流水线**(打印时正向走,解析时反向走同一棵树);这就是"一次构建、反复使用"线程安全的基础——**格式化器是不可变对象**(构建后无状态变化)*
- 面试: "DateTimeFormatter 为什么线程安全"——不可变(所有字段 final,构建后无修改);SimpleDateFormat 有可变的 Calendar 字段

### 2. "format 的流程？" — PrintContext 上下文

场景: `formatter.format(localDateTime)` — 内部发生了什么?

- `DateTimeFormatter.java:1815` `format(TemporalAccessor)` → `formatTo`(1841 附近)创建 `DateTimePrintContext`(持 temporal + formatter)→ 遍历节点链逐个打印
- 每个节点从 temporal 取字段值 → 按格式输出到 StringBuilder
- 失败语义: 字段缺失/非法值 → DateTimeException
- 关键设计 (斜体): *PrintContext 是"只读上下文"——打印过程中不改任何状态;格式化器可被任意线程同时 format(各自持有自己的 PrintContext 实例)*
- 面试: "format 是纯函数吗?"——是(输入 temporal+formatter,输出 String);纯函数 ⇒ 天然线程安全

### 3. "parse 的两阶段" — 解析 + 解析

场景: `"2026-08-14".parse(LocalDate::from)` — 字符串怎么变对象?

- `DateTimeFormatter.java:1871` `parse(CharSequence)` → 两阶段(类注释 441-457 明确说明):
  1. **parse 阶段**: 节点链反走,文本 → 字段值集合(Parsed 对象)
  2. **resolve 阶段**: 校验/合并字段(LocalDate 需要 year+month+day 齐)→ 目标类型转换
- `parseBest`(1987)/`parseUnresolved`(2094,只 parse 不 resolve)
- 关键设计 (斜体): *两阶段分离的原因: ① 解析容忍字段缺失(可选段)② resolve 才做跨字段校验(2 月 30 日在此失败);面试"parse 和 parseUnresolved 区别"——后者不 resolve*
- 生产: 解析失败抛 DateTimeParseException(域 06 异常链);宽松/严格解析选项(ResolverStyle)

### 4. "与 SimpleDateFormat 对照" — 经典面试题

场景: 面试"为什么不用 SimpleDateFormat"——除了线程安全还有什么?

- SimpleDateFormat: 内部共享 `Calendar` 字段(可变状态)→ 并发 format 相互污染(域 11 线程问题)
- DateTimeFormatter: 不可变 + 纯上下文 → 线程安全,可静态常量
- 其他优势: ISO 预定义格式(ISO_INSTANT 等)、本地化(DateTimeFormatter.ofLocalizedDate)、解析严格度控制
- 关键设计 (斜体): *"SimpleDateFormat 线程不安全"的准确原因: format/parse 共用可变的 Calendar 实例(calendar 字段在 parse 中被 set)——“面试答'它内部有可变 Calendar'比'它不安全'有区分度”;修复方案: ThreadLocal/局部实例/DateTimeFormatter*
- [JLS §17: 共享可变对象的并发访问属未定义行为(SimpleDateFormat 污染的规范层面解释)]
- [关联: 域 11 ThreadLocal(旧方案用 ThreadLocal<SimpleDateFormat>);域 02 数字格式化 DecimalFormat 同源问题]
- 面试: "格式化器最佳实践"——DateTimeFormatter 静态常量(线程安全)+ ofPattern 或 ISO 预定义

---

### 核心悬念

本地时间+时区规则合体——**ZonedDateTime 怎么处理"不存在的时刻"**?DST 切换日的 02:30 不存在时,`of` 会怎样?OffsetDateTime 和 ZonedDateTime 怎么选?——下一篇: 组合类型。

> → [05-zoned-offset.md](05-zoned-offset.md)
