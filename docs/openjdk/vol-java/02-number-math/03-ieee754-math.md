# 03. 浮点数表示与 Math — IEEE-754、Double.toString、Math vs StrictMath

> **前置依赖**: [02-number-math/02 — BigDecimal 与精确计算](02-bigdecimal.md)(0.1 的二进制误差是本文 1 节的背景)
> → **后续**:域 03 对象与系统(03-object-system 系列,下一篇)
> 关联: [IEEE 754-2008 双精度布局];[JLS §4.2.3 浮点语义];内部卷 45-math-library(native 数学库)

## 日志里的 "Infinity" 与打印出来的 "0.1"

线上日志偶尔出现 `Infinity`/`NaN` 字样,大多数人扫一眼就过;`Double.toString(0.1)` 输出 "0.1" 也习以为常——但这两个现象背后的机制,正好是浮点语义的两端: 位模式如何决定特殊值,以及"二进制数转十进制字符串"为什么能做到最短且无损。

这篇把三件事讲清楚: IEEE-754 的位布局与特殊值、`Double.toString` 的最短往返表示算法、以及 Math/StrictMath 的双轨数学体系。

## 1. "double 在内存里是什么样" — IEEE-754 位模式

### 1.1 位布局:1 + 11 + 52

IEEE-754 双精度(double)用 64 位表示:

```
64 位 double:  1 位符号 | 11 位指数 | 52 位尾数
32 位 float:   1 位符号 | 8 位指数  | 23 位尾数
```

值 = `(-1)^符号 × 1.尾数 × 2^(指数-1023)`(double 的指数偏置 1023)。尾数部分有"1.xxx"的**隐式前导 1**——所以 52 位存储、53 位有效精度(第 2 篇的"53 位尾数"就是这么来的)。

### 1.2 位模式直读:doubleToLongBits

`Double.doubleToLongBits`(`Double.java:854-858`)把 double 的 64 位原样搬进 long:

```java
// Double.java:854-858(截取核心,逐字)
public static long doubleToLongBits(double value) {
    if (!isNaN(value)) {
        return doubleToRawLongBits(value);
    }
    return 0x7ff8000000000000L;
}
```

`doubleToRawLongBits`(`Double.java:898`)是 native——JVM 直接取位模式。注意上面这个方法**对 NaN 做了手脚**: 任何 NaN(尾数可以是任意非零值)都规范化为固定的 `0x7ff8000000000000L`。

### 1.3 特殊值:指数与尾数的极端组合

位模式的极端组合定义了特殊值:

| 指数 | 尾数 | 含义 |
|------|------|------|
| 全 1 | 全 0 | ±Infinity(符号位决定正负) |
| 全 1 | 非 0 | NaN(Not a Number) |
| 全 0 | 全 0 | ±0(有符号零!) |
| 全 0 | 非 0 | 次正规数(无隐式前导 1,表示极小的数) |
| 其他 | 任意 | 常规数(带隐式前导 1) |

两个反直觉点:

- **有符号零**:`-0.0` 和 `+0.0` 位模式不同,`1.0 / 0.0 = +Infinity` 而 `1.0 / -0.0 = -Infinity`;但 `-0.0 == 0.0` 比较结果是 true——所以 Math 的 max/min 才要专门处理负零(第 3 节)
- **次正规数**:指数全 0 时放弃隐式前导 1,用 `0.尾数 × 2^-1022` 表示最接近零的那一档小数——精度下降但能表示更小的绝对值,避免直接下溢到 0

### 1.4 为什么 NaN 要规范化:哈希契约

`Double.hashCode`(`Double.java:771-775`)是 `doubleToLongBits` 规范化的直接消费者:

```java
// Double.java:771-775(截取核心,逐字)
public static int hashCode(double value) {
    long bits = doubleToLongBits(value);
    return (int)(bits ^ (bits >>> 32));
}
```

如果 `doubleToLongBits` 不规范化,那 2^52 种不同的 NaN 位模式就有 2^52 种 hashCode——而 equals(`Double.java:815-819`:`doubleToLongBits` 比较)会把它们视为相等。**equals 相等但 hashCode 不同直接违反哈希契约**,HashMap 里就乱套了。所以 NaN 必须塌缩成一个规范位模式: 所有 NaN 的 hashCode 相同、equals 相同。

关键设计(斜体):*"NaN 规范化"是 IEEE-754 位语义与 Java 哈希契约之间的桥梁——语言让 NaN 的比较("NaN != NaN")符合 IEEE 数学语义,但哈希结构需要"相等则同 hash",于是 equals/hashCode 走位模式(规范化),比较运算走原始语义。面试问"Double 的 hashCode 为什么特殊处理 NaN",答案就是这个契约冲突的调和。*

## 2. "为什么 toString(0.1) 是 0.1" — 最短往返表示

### 2.1 入口:委托给 FloatingDecimal

`Double.toString`(`Double.java:203-204`):

```java
// Double.java:203-204(截取核心,逐字)
public static String toString(double d) {
    return FloatingDecimal.toJavaFormatString(d);
}
```

实现全在 `jdk/internal/math/FloatingDecimal.java`(`toJavaFormatString` 在 `FloatingDecimal.java:69`)——**JDK11 仍用这套从 JDK8 沿用至今的经典实现**(JDK9 模块化后从 sun.misc 落到 jdk.internal.math 包),不是 JDK19 之后的新算法。

### 2.2 契约:最短且往返一致

打印规则不是"按位展开"——`Double.toString` 的 javadoc(`Double.java:187-189`)把契约写得很精确: *"as many, but only as many, more digits as are needed to uniquely distinguish the argument value from adjacent values of type double"*——**输出恰好是最短的、能把这个 double 与相邻 double 区分开的十进制字符串**。

两个推论:

- **往返一致**:`Double.parseDouble(s)` 得到的 double 必须与 `Double.toString(d)` 的原值完全相同——字符串是"无损编码"
- **不是四舍五入**:`0.1` 打印成 "0.1" 不是因为"保留一位小数",而是因为"0.1"这个字符串往返后恰好回到这个 double(它是最接近 0.1 的 double,所以 "0.1" 合法);`0.100000000000000005551115123125782702...` 这种全展开反而**更长**,不符合最短原则

### 2.3 实现:精确大数运算求往返边界

FloatingDecimal 的做法: 把 double 的二进制值换算成精确的十进制大数,再通过试算确定"最短且仍能往返"的位数。核心工具是 `FDBigInteger`(`FDBigInteger.java:34` 起,1508 行)——javadoc 自述 "A simple big integer package specifically for floating point base conversion"(`FDBigInteger.java:32`),浮点进制转换专用的大整数,用精确算术处理 `2^a × 5^b` 的换算,而不是 float/double 的近似运算。

关键设计(斜体):*"最短且往返一致"是打印可读性与信息无损的平衡——JSON 序列化、日志、配置文件都要靠它: 序列化 double 再读回来必须原值;同时没人想在日志里看到 40 位小数。这个问题的通用解法(最短往返)后来成了行业标准算法,JDK19 用 Ryū 算法的 `DoubleToDecimal` 替换 FloatingDecimal,纯粹是性能(省掉大整数运算),**输出契约不变**。面试点: "toString 输出的是存储值的最短十进制表示",不是"四舍五入到 N 位"。*

## 3. "Math 和 StrictMath 有什么区别" — strictfp 与可移植性

### 3.1 Math 的浮点方法:清一色委托

`Math.pow`(`Math.java:669-671`)的完整实现:

```java
// Math.java:669-671(截取核心,逐字)
public static double pow(double a, double b) {
    return StrictMath.pow(a, b); // default impl. delegates to StrictMath
}
```

源码注释自己都写了 "delegates to StrictMath"。Math 里这样的委托共有 **23 处**(`return StrictMath.` 模式实测计数),覆盖全部浮点超越函数(log@311、exp、sin、cos…);`abs`/`max`/`min` 这类整数运算则自己实现。

### 3.2 StrictMath:fdlibm 的纯 Java 移植

`StrictMath` 的 javadoc(`StrictMath.java:43-55`)交代了血统: 算法移植自 **fdlibm 5.3**(Sun 的 Free Distributable Math Library,`ftp.netlib.org/fdlibm`),并且"to be understood as executed with all floating-point operations following the rules of Java floating-point arithmetic"——即**纯 Java 语义的逐位可复现实现**,没有任何平台自由度。

### 3.3 为什么要有两套:历史与语义承诺

历史背景: 早期 JVM 在 x86 上允许 Math 的非 strictfp 方法使用 x87 浮点单元的 **80 位扩展精度**做中间运算——同样的算式在 x86 和别的平台结果可能不同(最后一位)。StrictMath 强制"严格 IEEE 语义": 每个中间步骤都按 double 舍入,结果**在所有平台逐位一致**。JDK17 起 strictfp 语义已被默认化,Math/StrictMath 的实现也趋于一致——区别只剩语义承诺本身。

关键设计(斜体):*"可移植数学"的价值在确定性: 分布式系统的校验和、科学计算的交叉验证、游戏的地图种子——同一算式在 x86/ARM/新老 JDK 上必须产出完全相同的 double。现代平台两者的结果已经几乎一致,选 StrictMath 是买"逐位一致"的保险,选 Math 是买"可能更快的平台专用实现"(某些平台的 intrinsics)。面试答"两者现在结果一样,区别是承诺",比背"一个快一个慢"准确。*

### 3.4 Math.max 的边界:NaN 与负零

`Math.max(double, double)`(`Math.java:1497` 起)是浮点边界的教科书:

```java
// Math.java:1497-1503(截取核心,逐字)
public static double max(double a, double b) {
    if (a != a)
        return a;   // a is NaN
    if ((a == 0.0d) &&
        (b == 0.0d) &&
        (Double.doubleToRawLongBits(a) == negativeZeroDoubleBits)) {
        // Raw conversion ok since NaN can't map to -0.0.
```

- **NaN 传播**:`a != a` 就是 `isNaN(a)`——NaN 参与 max 返回 NaN(数学语义: NaN 不是数,没有大小);所以 `Math.max(Double.NaN, 1.0)` 返回 NaN,不是 1.0
- **负零保真**:`-0.0` 与 `0.0` 数值相等,但位模式不同——max 要用 `doubleToRawLongBits` 检查负零,保证 `Math.max(-0.0, 0.0)` 返回 `0.0`(正零)而不是负零。注释里 "Raw conversion ok since NaN can't map to -0.0" 解释了为什么这里敢用 raw 转换(前面已排除了 NaN)

跨层标注: [内部卷: 45-math-library(native 数学函数与 intrinsics)]

## 4. 常用陷阱清单 — 浮点比较与哈希

### 4.1 比较:== 禁止,三选一

- 绝对值差:`Math.abs(a - b) < 1e-9`——工程近似比较
- `Double.compare(a, b)`(`Double.java:1016`):排序语义——先 `d1 < d2` 判断,再用 `doubleToLongBits` 比较位模式。**NaN 在 compare 里大于一切**(包括 +Infinity),且所有 NaN 相互 equal——TreeSet/TreeMap 里 NaN 只有一个
- `Double.equals`:注意它认为 `NaN.equals(NaN)` 为 true(`doubleToLongBits` 规范化后相等),与 `NaN == NaN` 的 false 相反——第 1 节的契约调和在这里兑现

### 4.2 Double 作 HashMap key:NaN 安全吗

安全。因为 hashCode 走 `doubleToLongBits`(NaN 固定 hash),equals 走位模式(NaN 相等),哈希契约成立。真正要防的是**有符号零**: `-0.0` 与 `0.0` 的位模式不同、hashCode 不同、equals 返回 false——它们会**同时存在**于 HashMap,而 `==` 又认为相等。序列化/反序列化路径里 ±0 是真实出现的,规范化的做法是入库前统一 `+ 0.0`。

### 4.3 累加误差:大数吃小数

`1e16 + 1.0` 还是 `1e16`——double 的指数差距太大时,小数的尾数位被挤掉(1e16 的数量级下,最小可表示增量约 2.0)。数组求和时先加小值、后加大值,误差更小(每个中间结果更接近最终量级);要求精确就用 BigDecimal。

关键设计(斜体):*浮点面试题的共同底层就三件事: 位模式(表示)、舍入(运算)、比较语义(判等/排序)——任何变体(0.1+0.2、NaN、±0、Infinity)都能拆到这三件套里。能把"NaN 在 compare 里大于一切"和"±0 在 HashMap 里是两个 key"讲出来,就说明不是背的。*

## 核心悬念

数字讲完了——但"数字对象"和"字符串"在**对象模型**层面是怎么被 JVM 创建和管理的?`new Double(1.0)` 的对象头里有什么?`System.out.println` 从哪开始?所有对象的起点是 `Object`,而 JVM 启动后运行的第一个 Java 类是 `System` 的依赖链。下一站进入对象与系统域: Object 的 native 方法、System 的初始化顺序、以及 `main` 之前的 JVM 世界里发生了什么。

> → 下一篇: 域 03 对象与系统(03-object-system 系列)| 关联: 内部卷 30-jvm-entry(启动)、06-oops(对象模型)
