# 04. 格式化与解析 — DateTimeFormatter 流程与线程安全

> **前置依赖**: [24-time-date/03 — 时区体系](03-zone-rules.md)(ZoneId/ZoneRules)、[01-string/04 — 编码与 Unicode](../01-string/04-encoding-unicode.md)(文本表示)
> → **后续**: 按写作顺序进入组合类型

## 模式字符串如何变成格式化器

`DateTimeFormatter` 的关键不是模式字符串本身,而是把模式编译成可复用的打印/解析节点组合。

## 1. "模式字符串怎么变成格式化器?" — Builder 节点链

### 1.1 构建链

`DateTimeFormatter.ofPattern(String)`(`DateTimeFormatter.java:563`)直接委托:

`new DateTimeFormatterBuilder().appendPattern(pattern).toFormatter()`。

`appendPattern`(`DateTimeFormatterBuilder.java:1706`)再进入 `parsePattern`(`:1712`),把 `yyyy/MM/dd/HH` 等模式片段转换成内部打印/解析节点。

节点可以表达数字、文本、字面符号、填充与可选段等组合。

### 1.2 为什么能复用

构建完成后,格式器保存的是不可变配置;每次 format/parse 使用自己的上下文,不会把本次操作的临时字段写回共享格式器。

关键设计(斜体):*"模式 → 节点组合"把格式化变成组合器流水线——打印与解析共享同一套结构。面试"DateTimeFormatter 为什么线程安全": 格式器不可变,每次操作使用独立上下文。*

## 2. "format 的流程?" — PrintContext 上下文

### 2.1 执行链

`format(TemporalAccessor)`(`DateTimeFormatter.java:1815`)创建输出缓冲并委托 `formatTo`(`:1837`)。格式化过程从 temporal 读取字段值,再把节点结果写入 Appendable。

字段缺失或无法按格式表达时,格式化过程抛出日期时间异常。

### 2.2 线程安全

共享一个静态 `DateTimeFormatter` 是安全的: formatter 保存配置,具体 temporal、输出缓冲与打印上下文属于当前调用。

关键设计(斜体):*PrintContext 是一次调用的只读上下文——格式器本身不保存某次 format 的可变状态,因此可以跨线程复用。面试"format 是纯函数吗": 对同一个 formatter 与 temporal,结果由输入决定,没有共享格式化游标。*

## 3. "parse 的两阶段" — 解析与 resolve

### 3.1 parse

`parse(CharSequence)`(`DateTimeFormatter.java:1871`)先把文本交给模式节点,收集字段值到解析上下文。

`parseBest`(`:1987`)可以按候选目标类型尝试转换;`parseUnresolved`(`:2094`)只完成文本解析,返回未 resolve 的结果。

### 3.2 resolve

普通 `parse` 会继续 resolve: 合并字段、补默认值、按目标类型校验。比如 `LocalDate` 需要年/月/日字段组合,非法日期会在解析/resolve 链路中失败。

关键设计(斜体):*parse = 文本转字段,resolve = 字段转语义对象。两阶段让可选字段与跨字段校验分开。面试"parse 与 parseUnresolved 区别": 后者停在字段解析,不做最终 resolve。*

## 4. "与 SimpleDateFormat 对照" — 经典面试题

### 4.1 为什么 SimpleDateFormat 不安全

`SimpleDateFormat` 继承的 `DateFormat` 持有可变 `Calendar`;多个线程共享同一 formatter 时,format/parse 会共同读写这份状态,可能相互污染。

### 4.2 DateTimeFormatter 的优势

- 不可变,可以安全做静态常量
- 预定义 ISO 格式
- 支持 Locale 与 `ofLocalizedDate`
- 支持 resolver style 等解析严格度控制

生产规范: 新代码优先 `DateTimeFormatter`;遗留 `SimpleDateFormat` 可用 ThreadLocal、局部实例,或统一替换。

关键设计(斜体):*SimpleDateFormat 的问题是共享可变 Calendar 状态,不是“格式化天然不安全”。面试"为什么不用 SimpleDateFormat": DateTimeFormatter 以不可变配置 + 独立上下文解决了共享状态问题。*