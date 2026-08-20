# 02-number-math/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Double/Math/StrictMath/FloatingDecimal` 实现；JDK 19+ Ryū 替换仅作为版本边界对照。
> 目标：把浮点数专题从“位布局知识点”重写成一篇解释表示、打印、比较和数学库选择的文章。

## 1. 读者困惑

- `0.1 + 0.2` 为什么不是精确 `0.3`？
- `Double.toString(0.1)` 为什么又能打印出看起来干净的 `0.1`？
- `NaN/Infinity/-0.0` 为什么会出现在日志里？
- `Math` 和 `StrictMath` 为什么共存？
- 浮点数在比较、排序、哈希和序列化时有哪些边界？

## 2. 一句话顿悟

**浮点数问题分四层：位模式决定它能表示什么，舍入决定近似误差如何产生，打印算法决定人看到什么，比较与数学库语义决定业务怎么用。**

## 3. 旧稿问题

- 旧稿容易按“位布局 → toString → Math → 陷阱”平铺，缺少一个事故主线。
- `toString(0.1)` 与 `0.1 + 0.2` 的矛盾感没有被充分利用。
- `Math vs StrictMath` 容易写成历史知识点，缺少“为什么还要两个 API”的现实语义。
- 浮点比较、`NaN`、有符号零、hash/排序需要收束成一张可操作的规则图。

## 4. 理解路径

### 第一节：事故开场——0.1、NaN 与 -0.0 同时出现的日志

- 用一段看似矛盾的日志开场：`0.1+0.2 != 0.3`，但打印 `0.1` 却很正常。
- 引出四层问题：表示、打印、运算、比较。

### 第二节：位模式——double 到底怎么编码

- `doubleToLongBits/raw`、sign/exponent/mantissa。
- 特殊值：Infinity、NaN、±0.0、subnormal。
- 失败方案：把浮点数当连续实数而非离散位模式。

### 第三节：打印——为什么 0.1 显示成 0.1

- `Double.toString` → `FloatingDecimal.toJavaFormatString`。
- “最短且可往返”的打印目标。
- 失败方案：以为打印输出就是“把内部位模式完整展开”。

### 第四节：Math vs StrictMath——语义承诺不同

- JDK 11 大量 `Math.*` 委托 `StrictMath.*`。
- StrictMath 的可移植承诺 vs Math 的语义/性能定位。
- 失败方案：把两个类当成“一个快一个慢”的八股结论。

### 第五节：比较与收网——业务为什么总踩坑

- `==`、`Double.compare`、epsilon 比较、NaN、hashCode、排序边界。
- 什么时候该换 BigDecimal。
- 收束为“位模式/打印/比较”三张规则卡。

## 5. 失败方案清单

1. 用 `==` 比较所有浮点业务值。
2. 把 `Double.toString` 输出当成内部完整十进制展开。
3. 忽略 NaN 与 ±0.0 的排序/哈希语义。
4. 用固定 epsilon 处理所有数量级比较。
5. 把 Math 和 StrictMath 简化成“功能重复”。

## 6. 误解清单

1. `0.1` 在 double 里是精确值——错误。
2. `Double.toString(0.1)` 说明存储值就是十进制 0.1——错误。
3. `Double.NaN == Double.NaN` 为 true——错误。
4. `Math` 一定比 `StrictMath` 不准确——错误，它们差的是语义承诺与实现路径。
5. 所有金额问题都能用 epsilon 解决——错误，很多场景应直接换 BigDecimal。

## 7. 证据清单

- `Double.java:854`：`doubleToLongBits`。
- `Double.java:203`：`toString(double)` → `FloatingDecimal`。
- `jdk/internal/math/FloatingDecimal.java`：打印实现。
- `Math.java` 中 `pow/log/...` 对 `StrictMath` 的委托。
- `StrictMath.java`：fdlibm/严格语义说明。

## 8. 版本与边界

- 基于 JDK 11，`Double.toString` 仍走 `FloatingDecimal`。
- JDK 19+ 改为 Ryū 仅作为边界对照，不混写成 JDK 11 事实。
- “epsilon 比较”是工程经验，不是 JDK 规范。

## 9. 验收标准

- 开头先出现“0.1+0.2 与 0.1 打印正常”的矛盾场景。
- 至少展开五个失败方案。
- 必须把表示、打印、比较、数学库四层串成一条线。
- 结尾形成可执行的业务比较/选型规则。
- 删除代码后主线仍成立，所有锚点与禁用词检查全绿。
