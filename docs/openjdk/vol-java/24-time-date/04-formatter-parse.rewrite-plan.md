# 24-time-date/04 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `DateTimeFormatter`、`DateTimeFormatterBuilder`、`DateTimeParseContext`、`ResolverStyle`。本文聚焦模式编译、格式化与解析两阶段、不可变配置与线程安全；`SimpleDateFormat` 只作为对照，不展开旧 API 全史。
> 目标：把“格式化与解析”改写成一篇围绕“`DateTimeFormatter` 真正可复用、可线程安全共享的关键，不是它支持模式字符串，而是它先把模式编译成一套不可变的打印/解析节点，再让每次调用各自携带上下文运行”展开的机制文章。

## 1. 读者困惑

- 为什么 `DateTimeFormatter` 能安全做静态常量，而 `SimpleDateFormat` 却经常出线程安全事故？
- 模式字符串如 `yyyy-MM-dd HH:mm:ss` 到底是怎样变成一个可执行格式器的？
- `format` 和 `parse` 为什么能共用同一套 formatter 结构？
- 为什么 `parse` 不是“读完字符就结束”，还要经历 resolve 阶段？
- `ResolverStyle` 为什么会影响“同一串字符是否合法”的结论？

## 2. 一句话顿悟

**`DateTimeFormatter` 的本体不是一段模式字符串，而是一棵由 `DateTimeFormatterBuilder` 预先编译出来的打印/解析节点组合。格式器对象只保存不可变配置；每次 `format`/`parse` 都创建本次调用自己的上下文。这样，打印和解析可以复用同一套结构，而线程之间又不会共享可变中间状态。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 `ofPattern -> DateTimeFormatterBuilder.appendPattern -> parsePattern -> toFormatter` 这条核心链路。
- 已把 parse 分成“文本转字段”和 resolve 两阶段，这是关键机制。
- 已正确把线程安全落到“不可变配置 + 每次调用独立上下文”，方向是对的。

### 必须重写

- 旧稿偏知识点拆栏，需要先立住总问题：为什么新格式器能共享而旧格式器共享会出事。
- Builder 编译链、format、parse、resolve、ResolverStyle 要落到一条“预编译结构 + 运行期上下文”主线上。
- `SimpleDateFormat` 对照要服务于共享可变状态这个核心结论，不宜单独列优缺点清单。
- 需要更明确说明：parse 结束字符扫描后，为什么还不能立刻认定获得了目标时间对象。

## 4. 理解路径

### 第一节：从“为什么一个 formatter 可以放心做静态常量”开场

用经典线程安全对照开场。先立住总问题：真正差异不在“会不会格式化”，而在“共享对象里是否保留某次调用的可变状态”。

### 第二节：模式字符串为什么会先被编译成节点组合

证据：
- `DateTimeFormatter.java:563/587`：`ofPattern`
- `DateTimeFormatterBuilder.java:1706`：`appendPattern`
- `DateTimeFormatterBuilder.java:1712`：`parsePattern`
- `DateTimeFormatterBuilder.java:1421/1436`：`appendLiteral`
- `DateTimeFormatterBuilder.java:398/452/493`：`appendValue`
- `DateTimeFormatterBuilder.java:2189/2210`：`toFormatter`

主线：
- 模式字符串不会每次调用时重新解释。
- Builder 会把模式拆成数值、字面量、可选段等 printer/parser 节点。
- `toFormatter` 把这套结构冻结成可复用配置。

### 第三节：format 为什么可以共享同一个 formatter

证据：
- `DateTimeFormatter.java:1815`：`format`
- `DateTimeFormatter.java:1837`：`formatTo`

主线：
- formatter 自己不持有本次 temporal 或输出缓冲。
- 每次 format 都是“拿配置 + 创建本次上下文 + 执行节点链”。
- 这解释了线程安全不是魔法，而是没有共享调用态。

### 第四节：parse 为什么天然是两阶段

证据：
- `DateTimeFormatter.java:1871`：`parse`
- `DateTimeFormatter.java:1987`：`parseBest`
- `DateTimeFormatter.java:2094`：`parseUnresolved`
- `DateTimeParseContext.java:92`

主线：
- 第一阶段先按模式把字符读成字段集合。
- 第二阶段再 resolve：补默认值、合并字段、做跨字段校验并尝试生成目标对象。
- 这解释了为什么 parseUnresolved 和普通 parse 结果不同。

### 第五节：ResolverStyle 为什么会改变“同一串字符是否合法”

证据：
- `DateTimeFormatter.java:1682`：`withResolverStyle`
- `ResolverStyle.java:77`
- `DateTimeFormatterBuilder.java:2211/2221`

主线：
- resolve 不是机械拼字段，而是要按严格度做合法性判断。
- 不同 resolver style 会影响非法日期、宽松进位等场景的接受方式。
- 解析正确性不仅取决于模式，还取决于 resolve 策略。

### 第六节：为什么 `SimpleDateFormat` 共享会出事，而 `DateTimeFormatter` 不会

主线：
- 旧格式器问题不在“解析天然危险”，而在共享对象里保存了会被本次调用读写的可变状态。
- 新格式器把配置和调用态拆开，所以静态常量可安全复用。
- 这应回扣本文总问题，而不是仅作 API 宣传。

## 5. 失败方案清单

1. 每次 format/parse 都重新解析模式字符串。
2. 以为线程安全来自 synchronized，而不是无共享调用态。
3. 把 parse 当作“字符读完就结束”，忽略 resolve 阶段。
4. 认为模式字符串匹配成功就一定能构造成合法时间对象。
5. 把 `DateTimeFormatter` 和 `SimpleDateFormat` 的差异归结为新旧 API 风格，而不是状态模型差异。

## 6. 误解清单

1. `DateTimeFormatter` 线程安全只是因为内部做了锁。
2. `ofPattern` 每次 format 都会重新解释一遍模式。
3. `parseUnresolved` 和 `parse` 只是返回类型不同。
4. `ResolverStyle` 只影响性能，不影响语义。
5. `SimpleDateFormat` 不安全是因为日期格式化本身没法共享。

## 7. 证据清单

- `DateTimeFormatter.java:563/587/1682/1815/1837/1871/1987/2094`
- `DateTimeFormatterBuilder.java:398/452/493/1421/1436/1706/1712/2189/2210/2221`
- `DateTimeParseContext.java:92`
- `ResolverStyle.java:77`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇只讲 `DateTimeFormatter` 体系，不展开 `java.text` 全部格式化 API。
- 不把所有模式字符清单全文展开，只在必要处说明它们会被编译成不同节点。
- Locale 本地化与预定义 ISO formatter 只作辅助说明，不成为主线。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 formatter 能安全共享 → 模式如何先编译成节点 → format 为什么只读配置并使用本次上下文 → parse 为什么分字符解析与 resolve 两阶段 → ResolverStyle 为什么会改变合法性判断 → 为什么 `SimpleDateFormat` 会因共享可变状态出事”。
- 必须把线程安全落到状态模型，而不是停留在结论口号。
- 必须自然引到 `05-zoned-offset.md`。
