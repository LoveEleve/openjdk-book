# 24-time-date/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Duration`、`Period`、`TemporalAmount`、`LocalDate.plusDays`。本文聚焦时间线时长与日历跨度的语义差异、plus/minus/between、TemporalAmount 应用、闰年/月长与溢出边界；时区/DST 放到下一篇。
> 目标：把“时间运算”改写成一篇围绕“为什么‘加一天’有时是 86400 秒，有时只是日历向后翻一天；Duration 和 Period 不是两种 API 写法，而是两种完全不同的时间语义”的机制文章。

## 1. 读者困惑

- `plusDays(1)`、`Duration.ofDays(1)`、`Period.ofDays(1)` 看起来都在“加一天”，为什么不能随便替换？
- Duration 为什么按秒/纳秒表示，Period 却按年/月/日表示？
- `between` 计算的到底是物理时长还是日历差异？
- 日期加法遇到月末、闰年时，为什么不能简单按固定秒数处理？
- 为什么 java.time 运算溢出会抛异常，而不是像整数那样静默回绕？

## 2. 一句话顿悟

**时间运算首先要选语义：`Duration` 表示时间线上的固定秒/纳秒距离，`Period` 表示日历上的年/月/日跨度，`LocalDate.plusDays` 则是在日历坐标系里做日期运算。它们都叫“加时间”，但一个回答“经过了多少物理时间”，另一个回答“日历翻过了多少格”；选错类型，代码可能完全合法，业务含义却已经错了。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 LocalDate.plusDays、Duration 秒纳秒、Period 年月日、between 与溢出边界。
- 已指出 Duration.ofDays(1) 是固定 86400 秒，而 Period.ofDays(1) 是日历一天，这是本文核心。
- 已把时区/DST 留给下一篇，边界正确。

### 必须重写

- 旧稿偏类型说明，需要先用“加一天到底是多少”这个真实困惑建立主线。
- Duration/Period 要围绕“时间线 vs 日历”统一对照，而不是各自介绍后再比较。
- LocalDate.plusDays 的实现细节要服务于“日历算法不是逐秒加法”，不宜独立成源码导读。
- 溢出与边界要讲成 java.time 的事实纪律：宁可异常，不静默制造错误时间。

## 4. 理解路径

### 第一节：从“加一天到底是 24 小时还是明天”开场

用业务场景开场：超时控制要加 24 小时，账期要加一个日历日，二者不能混为一谈。先立总问题：时间运算必须先选坐标系。

### 第二节：LocalDate.plusDays 为什么是日历内部运算，不是 Duration 创建

证据：
- `LocalDate.java:1371`：`plusDays`
- `LocalDate.java:1397`：epochDay 与 `Math.addExact`
- `LocalDate.java:854`：`isLeapYear`

主线：
- 小跨度可走日期字段快路径；大跨度转 epochDay 再重建。
- 它不会创建 Duration，也不是逐秒循环。
- 这说明 LocalDate 的 plusDays 首先遵守日历规则。

### 第三节：Duration 为什么表达固定时间线距离

证据：
- `Duration.java:133`：类定义
- `Duration.java:161/166`：`seconds/nanos`
- `Duration.java:180/223/246`：工厂
- `Duration.java:486`：`between`
- `Duration.java:689`：`plus`
- `Duration.java:1100`：`addTo`

主线：
- Duration 是秒 + 纳秒，适合耗时、超时和固定时间量。
- `ofDays(1)` 是 86400 秒，与月份、日历规则无关。
- TemporalAmount 接口让它能被应用到 Temporal，但具体语义仍由 Duration 自己决定。

### 第四节：Period 为什么表达日历跨度

证据：
- `Period.java:133`：类定义
- `Period.java:218`：`ofDays`
- `Period.java:386`：`between`
- `Period.java:894`：`addTo`

主线：
- Period 的核心是 years/months/days，不是秒数。
- `Period.ofDays(1)` 表示日历一天；月份长度、闰年等由目标日期规则解释。
- 它适合账期、年龄、日历区间，不适合精确超时。

### 第五节：为什么 TemporalAmount 让两种跨度都能应用到时间对象

证据：
- `TemporalAmount.java:99`
- `TemporalAmount.java:117/134/176/218`

主线：
- TemporalAmount 统一提供 get/getUnits/addTo/subtractFrom 这类应用协议。
- 接口统一的是“如何应用”，不抹平 Duration 和 Period 的语义差异。
- 这解释了为什么同一个 `temporal.plus(amount)`，具体结果仍取决于 amount 类型和目标时间类型。

### 第六节：溢出为什么必须抛异常，而不是静默回绕

证据：
- `LocalDate.java:1397`：`Math.addExact`
- Duration 中 `Math.multiplyExact` 等路径

主线：
- 时间值有明确范围，越界不是合法时间。
- 静默回绕会把错误日期/时长继续传播到业务。
- java.time 选择抛 `DateTimeException` / `ArithmeticException`，把错误前置暴露。

## 5. 失败方案清单

1. 用 Duration.ofDays(1) 替代所有 plusDays(1) / Period.ofDays(1)。
2. 用 Period 做网络超时或耗时统计。
3. 把月份、闰年日期运算当作固定秒数加法。
4. 认为 between 的结果类型只影响格式，不影响语义。
5. 依赖整数溢出回绕处理超大时间范围。

## 6. 误解清单

1. Duration 和 Period 只是精度不同，一个纳秒一个天。
2. Duration.ofDays(1) 和 Period.ofDays(1) 永远等价。
3. LocalDate.plusDays 内部会逐天循环。
4. TemporalAmount 统一了 API，所以它也统一了时间语义。
5. 时间越界时自动回绕是方便的容错行为。

## 7. 证据清单

- `LocalDate.java:854`：`isLeapYear`
- `LocalDate.java:1371`：`plusDays`
- `LocalDate.java:1397`：`Math.addExact`
- `Duration.java:133`：类定义
- `Duration.java:161/166`：字段
- `Duration.java:180/223/246`：工厂
- `Duration.java:486`：`between`
- `Duration.java:689`：`plus`
- `Duration.java:1100`：`addTo`
- `Period.java:133`：类定义
- `Period.java:218`：`ofDays`
- `Period.java:386`：`between`
- `Period.java:894`：`addTo`
- `TemporalAmount.java:99`：接口定义
- `TemporalAmount.java:117/134/176/218`：应用协议

## 8. 版本与边界

- 基于 JDK 11。
- 本篇暂不展开时区与 DST；只在必要处说明这会进一步放大 Duration/Period 差异。
- 不把 ChronoUnit 全部枚举展开，只用它支撑时间量应用语义。
- 不把溢出异常扩展成完整异常体系教程。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么加一天要先选时间线还是日历坐标系 → LocalDate.plusDays 如何遵守日历 → Duration 为什么是秒纳秒固定时长 → Period 为什么是年月日跨度 → TemporalAmount 如何统一应用协议但不抹平语义 → 越界为什么抛异常”。
- 必须把 Duration vs Period 讲成本文主对照。
- 必须自然引到 `03-zone-rules.md`。
