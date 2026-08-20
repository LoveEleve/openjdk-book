# 24-time-date/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ZoneId`、`ZoneOffset`、`ZoneRules`、`ZoneOffsetTransition`、`ZonedDateTime`。本文聚焦时区标识、固定偏移、规则查询、Gap/Overlap 歧义与规则数据来源；格式化与解析放到后续篇章。
> 目标：把“时区体系”改写成一篇围绕“时区不是一个字符串标签，也不是一个恒定偏移值；真正决定某一刻偏移多少的，是一张随时间变化的规则表”展开的机制文章。

## 1. 读者困惑

- 为什么 `Asia/Shanghai` 和 `+08:00` 看起来都像“时区”，语义却完全不同？
- `ZoneId.of(...)` 拿到的到底是什么，为什么它还不等于最终偏移？
- 为什么同一个地区在不同年份、不同日期的偏移可能不同？
- 为什么某些本地时间在 DST 切换日根本不存在，或者会出现两次？
- 为什么保存“本地时间 + 区域名”仍然不一定能唯一确定一个时间点？

## 2. 一句话顿悟

**时区真正值钱的不是 ID 字符串，而是 ID 背后的 `ZoneRules`。`ZoneId` 负责标识“查哪套规则”，`ZoneOffset` 只表示某一刻已经算出来的固定偏移秒数，`ZoneRules` 才负责根据时间点或本地时间把规则翻译成具体偏移，并处理夏令时切换造成的不存在时刻与重复时刻。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `ZoneId` / `ZoneOffset` / `ZoneRules` 的角色分工。
- 已抓住 DST 的 Gap/Overlap 与 `getValidOffsets` / `getTransition` 这些关键入口。
- 已指出规则数据来自 provider 与 tzdata，这对生产边界非常重要。

### 必须重写

- 旧稿偏“概念分栏”，需要先立住总问题：为什么时区不是字符串替换，而是规则查询。
- `ZoneId` 与 `ZoneOffset` 的区别要放到“标识符 vs 计算结果”主线上统一讲。
- Gap/Overlap 要讲成“本地时间映射到时间点时出现歧义”，而不是孤立术语表。
- provider/tzdata 要服务于“规则与代码分离”的结论，不宜单独知识卡片化。

## 4. 理解路径

### 第一节：从“为什么 `Asia/Shanghai` 不等于 `+08:00`”开场

先用最常见误解开场。用户以为时区就是偏移字符串，但区域时区真正携带的是历史与未来规则。立住总问题：时区不是常量，而是时间的函数。

### 第二节：ZoneId 为什么只是规则入口，不是最终偏移

证据：
- `ZoneId.java:271`：`systemDefault`
- `ZoneId.java:355`：`of`
- `ZoneId.java:487`：`getId`
- `ZoneId.java:562`：`getRules`

主线：
- `ZoneId` 首先是标识符对象。
- 区域 ID 指向一套规则；固定偏移 ID 可直接规约成 `ZoneOffset`。
- 这解释了为什么相同 API 入口背后可能落到不同复杂度的规则体系。

### 第三节：ZoneOffset 为什么只是某一刻已经算出的偏移结果

证据：
- 旧稿已使用 `ZoneOffset.java:151/155/159/164`

主线：
- `ZoneOffset` 只是 UTC 相对秒数，不携带 DST 历史。
- 它适合表达“这一刻最终采用了多少偏移”，不适合代表整个区域时区语义。

### 第四节：ZoneRules 为什么才是真正的时区引擎

证据：
- `ZoneRules.java:490`：`getOffset(Instant)`
- `ZoneRules.java:597`：`getValidOffsets(LocalDateTime)`
- `ZoneRules.java:640`：`getTransition(LocalDateTime)`
- `ZoneRules.java:761`：`getStandardOffset(Instant)`
- `ZoneRules.java:814`：`isDaylightSavings(Instant)`

主线：
- 对时间点，规则表负责查出当时有效偏移。
- 对本地时间，规则表负责判断它是唯一、缺失还是重叠。
- DST 不是算法常量，而是数据驱动的时间函数。

### 第五节：Gap / Overlap 为什么说明“本地时间不天然唯一”

证据：
- `ZoneRules.java:597/640`
- `ZonedDateTime.java:366`：`ofLocal`
- `ZonedDateTime.java:406`：`ofInstant`
- `ZoneOffsetTransition.java:99`

主线：
- 本地时间映射到时间点时，可能没有合法偏移，也可能有两个合法偏移。
- `ofInstant` 从时间点出发通常无歧义；`ofLocal` 从本地时间出发就必须面对规则分叉。
- 这解释了为什么“本地时间 + 区域名”并不总是天然唯一。

### 第六节：规则数据为什么必须与代码分离

证据：
- 旧稿中的 `TzdbZoneRulesProvider.java:86` 线索
- `ZoneId.getRules()` 的 provider 角色

主线：
- 时区规则会因 tzdata 更新而变化。
- 规则数据独立于业务代码，JDK 升级即可带来新规则。
- 生产上要意识到同一历史日期的偏移结果可能随规则版本变化。

## 5. 失败方案清单

1. 把区域时区当成固定偏移字符串处理。
2. 保存本地时间后默认认为它已经唯一代表了某个时间点。
3. 用手写“夏令时加一小时”规则替代 `ZoneRules` 查询。
4. 忽略 Gap/Overlap，在 DST 切换窗口按普通时间处理。
5. 假设 JDK 升级不会影响历史时间换算结果。

## 6. 误解清单

1. `ZoneId` 就是偏移值的另一种写法。
2. `Asia/Shanghai` 与 `+08:00` 只差显示形式。
3. 一个地区的偏移永远固定，只要知道国家就够了。
4. 只要给出 `LocalDateTime` 和 `ZoneId`，就一定唯一对应一个时间点。
5. 夏令时就是简单的“多一小时/少一小时”数学运算。

## 7. 证据清单

- `ZoneId.java:271/355/487/562`
- `ZoneOffset.java:151/155/159/164`
- `ZoneRules.java:490/597/640/761/814`
- `ZonedDateTime.java:366/406`
- `ZoneOffsetTransition.java:99`
- `TzdbZoneRulesProvider.java:86`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇只讲时区标识、规则与歧义，不展开格式化输出模式字符。
- 不把 tzdb 数据结构本身展开成二进制格式分析，只讲 provider 分层与规则来源。
- 不全面展开 `OffsetDateTime`，仅在必要处借它对照偏移与区域语义。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么时区不是字符串替换 → ZoneId / ZoneOffset / ZoneRules 各自负责什么 → 为什么偏移是时间的函数 → Gap/Overlap 如何让本地时间失去唯一性 → 为什么规则数据必须和代码分离”。
- 必须把 `Asia/Shanghai` vs `+08:00` 讲清。
- 必须自然引到 `04-formatter-parse.md`。
