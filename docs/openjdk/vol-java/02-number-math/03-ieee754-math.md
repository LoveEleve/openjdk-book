# 浮点数表示与 Math — 为什么 0.1 打印正常，计算却不精确

> 基于 JDK 11 `java.base` 的 `Double`、`Math`、`StrictMath` 与 `FloatingDecimal` 实现；JDK 19+ 的浮点打印实现差异只作为版本边界说明。
> **前置依赖**: [BigDecimal 与精确计算](02-bigdecimal.md)(十进制精确性)、[02-number-math/01 — 包装类](01-wrapper-cache-boxing.md)(数值对象)
> → **后续**: 按写作顺序进入对象与系统

## 先看一个看似矛盾的日志

```java
double x = 0.1;
double y = 0.2;
System.out.println(x + y == 0.3); // false
System.out.println(x);             // 0.1
```

同一门语言里，为什么计算结果不等，打印出来却像精确的 `0.1`？因为这里其实有四个不同问题：

```text
位模式：double 实际存了什么
舍入：十进制如何进入二进制
打印：内部值如何选择可读字符串
比较：NaN、±0.0、误差如何参与业务判断
```

如果把这四层混成“浮点数不精确”，就只能背结论，不能排查问题。

## 一、位模式：double 不是连续实数

### 1. 64 位布局

IEEE-754 double 使用 64 位：

```text
sign(1) | exponent(11) | fraction(52)
```

有限精度意味着，很多十进制小数转换成二进制后会产生无限循环，只能截取有限位保存。`0.1` 在进入 double 时已经是最接近的二进制近似值，后续加法只是在近似值上继续运算。

`Double.doubleToLongBits(double)`(`Double.java:854`)可以把 double 的位模式读成 long；`doubleToRawLongBits(double)`(`:898`)保留 NaN 的原始位差异，而普通版本会规范化 NaN 表示。

特殊值的位模式也解释了日志里的异常值：

- 指数全 1、fraction 全 0 → `+Infinity/-Infinity`
- 指数全 1、fraction 非 0 → `NaN`
- 指数全 0、fraction 全 0 → `+0.0/-0.0`
- 指数全 0、fraction 非 0 → 次正规数

失败方案是把 double 当作“任意十进制小数都能精确容纳”的盒子；它实际上是有限位宽的二进制浮点模型。

关键设计(斜体):*浮点“精确”必须先问相对于哪种表示。double 对二进制运算规则精确,但不承诺每个十进制小数都有精确表示。*

## 二、打印：为什么 0.1 仍然显示成 0.1

### 1. 打印不是位模式展开

如果把 double 内部值完整展开成十进制，`0.1` 可能会出现很长的小数尾巴。但 `Double.toString(double)`(`Double.java:203`)委托给：

```text
Double.toString
    → FloatingDecimal.toJavaFormatString
    → 选择最短、可往返的十进制表示
```

“可往返”意味着：把输出字符串重新解析回 double，应该得到原来的同一个浮点值。于是打印算法不需要把所有隐藏误差展示出来，只需要找到足以唯一恢复原值的最短字符串。

### 2. 为什么不能把打印结果当真实十进制存储

`Double.toString(0.1)` 输出 `"0.1"`，只说明 `0.1` 是这个 double 的最短往返表示，不说明内部存储的二进制值等于数学意义上的十进制 0.1。

失败方案是把日志展示字符串重新当成精确金额依据。显示层的可读性和计算层的数值模型是两件事；金额计算应直接使用 BigDecimal 或整数单位。

关键设计(斜体):*打印算法解决的是“如何准确地把一个已存在的 double 展示出来”,不是“如何让 double 重新变精确”。JDK 11 仍使用 FloatingDecimal；不能把 JDK 19+ 的 Ryū 实现倒灌成 JDK 11 事实。*

## 三、Math 与 StrictMath：差异是语义承诺

### 1. 为什么有两个类

JDK 11 中，`Math` 的许多超越函数默认委托给 `StrictMath`，例如 `Math.log`(`Math.java:311`)直接返回 `StrictMath.log(a)`。

`StrictMath` 的文档和实现以 fdlibm 作为严格、可移植的数学实现基础。它关注的是跨平台结果的确定性承诺。

### 2. 不要简化成“一个快一个慢”

Math 与 StrictMath 的真实差异不能只背成“Math 快、StrictMath 慢”：

- StrictMath 更强调严格、可移植的结果语义。
- Math 提供常用数学 API，并允许实现根据平台/实现策略优化。
- JDK 11 中很多 Math 方法已经直接委托 StrictMath，因此具体性能差异不能脱离当前版本和平台测量。

关键设计(斜体):*两个类共存是“结果承诺与实现自由度”的边界。需要跨平台确定性时关注 StrictMath 语义,需要通用数学 API 时使用 Math,不要凭类名猜性能。*

## 四、比较与业务边界

### 1. `==` 不是通用浮点比较

浮点业务值直接用 `==` 很容易把表示误差当成业务不相等。工程上可以根据误差模型使用绝对/相对误差判断，或在需要十进制语义时直接使用 BigDecimal。

但 epsilon 也不是万能药：固定 `1e-9` 对非常大或非常小的数量级未必合理，必须根据业务量纲选择阈值。

### 2. NaN、±0.0 与包装对象

- `Double.NaN == Double.NaN` 为 false，这是浮点比较语义
- `Double.compare`(`Double.java:1016`)提供适合排序的总序处理
- `Double` 的 equals/hashCode 有自己的 NaN 规范化与有符号零规则，不能直接拿 primitive `==` 推导包装对象行为

### 3. 累加误差

大数与小数相加时，有限尾数可能让小数部分被舍去；长序列累加还会不断积累舍入误差。可以按数值规模选择求和算法，也可以切换到 BigDecimal/整数单位。

关键设计(斜体):*浮点问题最终都回到三件事：位模式、舍入、比较语义。把这三层分开，NaN、Infinity、-0.0、0.1 误差就不再是零散陷阱。*

## 收网：一张业务决策图

```text
需要二进制浮点性能
  → double，但接受近似与特殊值

需要十进制精确金额
  → BigDecimal(String) 或最小单位整数

需要跨平台数学结果承诺
  → 关注 StrictMath 语义

需要日志/JSON 展示 double
  → Double.toString 只负责可读且可往返

需要排序/集合键
  → 明确 NaN、±0.0、equals/hashCode 与 compare 规则
```

浮点数并不是“不能用”，而是必须先选对语义：计算性能、十进制精确、跨平台确定性、展示可读性，分别对应不同工具。