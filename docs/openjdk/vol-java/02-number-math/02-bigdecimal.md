# BigDecimal 与精确计算 — 数值、scale 与舍入边界

> 基于 JDK 11 `java.math.BigDecimal/BigInteger` 实现。本文讨论的是 JDK 11 当前的紧凑存储路径、构造入口和大整数算法选择，不把这些内部布局、阈值或优化路径外推成所有 JDK 版本或所有语言库的统一规范。金额舍入规则仍由业务决定，不能把某一种 `RoundingMode` 当成通用财务答案。
> **前置依赖**: [包装类、缓存与装箱](01-wrapper-cache-boxing.md)(数值对象)、[01-string/04 — 字符编码](../01-string/04-encoding-unicode.md)(文本输入边界)
> → **后续**: [浮点数表示与 Math](03-ieee754-math.md)

## 先看一笔金额事故

```java
double price = 0.1;
double tax = 0.2;
System.out.println(price + tax == 0.3); // false
```

问题不在加法指令，而在 `0.1` 进入 double 时就已经不是精确的十进制 0.1：二进制浮点用有限位数保存一个无法有限表示的十进制小数，只能保存近似值。

于是金额计算至少有三个失败方案：

1. 直接用 double 累加金额，误差随着运算传播。
2. 误以为 `new BigDecimal(0.1)` 会“修复”double，实际上它会把那个已经近似的 double 继续转换进去。
3. 只换成 BigDecimal，却不定义除法 scale 和舍入，业务仍然没有明确结果。

BigDecimal 的顿悟是：**先用十进制输入建立精确模型，再显式管理 scale 和舍入；精确不等于自动替你决定业务规则。**

## 一、BigDecimal 内部存什么

### 1. 三个关键概念

`BigDecimal` 把一个十进制数拆成：

```text
数值 = unscaled value × 10^(-scale)
```

例如 `123.45` 可以理解为 unscaled value `12345`、scale `2`。

JDK 11 同时准备了两条存储路径：

- `intCompact`(`BigDecimal.java:280`)——数值能放进 long 时走紧凑路径
- `intVal`(`:240`)——需要大整数时走 BigInteger 路径
- `INFLATED`(`:271`)——`intCompact` 失效时的哨兵

小额金额通常能走 long 快路径，避免每次创建 BigInteger；超过 long 范围时，才依赖 `intVal`。

### 2. 构造入口决定精度

精确十进制输入应使用字符串构造：`BigDecimal(String)`(`BigDecimal.java:837`)。字符串里的“0.1”会被按十进制数字解析。

`new BigDecimal(0.1)`(`BigDecimal.java:903`)则不同：它接收到的是已经近似的 double，再把近似结果精确展开。这个构造没有把 double 的误差抹掉，只是把误差写得更完整。

`BigDecimal.valueOf(long)`(`:1261`)适合整数；`valueOf(double)`(`:1313`)会通过字符串化路径提供比直接 double 构造更符合直觉的十进制结果，但金额输入仍应优先来自字符串或最小货币单位整数。

关键设计(斜体):*BigDecimal 的精确性从构造入口开始。`String`/整数单位把十进制事实带进模型,`double` 则可能先把误差带进来。*

## 二、scale 不是纯显示格式

### 1. `10 / 3` 为什么需要舍入

十进制 `10/3` 是无限循环小数。若结果要求固定 scale，就必须决定截断、进位还是银行家舍入。

`divide(BigDecimal, scale, roundingMode)`(`BigDecimal.java:1601`)把结果 scale 与舍入策略一起交给调用者；不能先无限计算再期待类型自动替你选择。

常见模式包括：

- `HALF_UP`——常见四舍五入
- `HALF_EVEN`——银行家舍入
- `DOWN/UP`——朝零或远离零
- `CEILING/FLOOR`——朝正无穷或负无穷
- `UNNECESSARY`——不允许发生舍入

### 2. setScale 是表示调整

`setScale(int, RoundingMode)`(`:2837`)会创建指定 scale 的新 BigDecimal，并在需要时按规则舍入。它不是简单地给字符串补零：降低 scale 可能丢失数值信息，提高 scale 则可能只是补零。

金额系统要先确定单位策略：是用分作为 scale=0 的整数，还是用 `DECIMAL(18,2)` 这样的固定 scale；计算、存储和展示不能各自随意改变 scale。

### 3. equals 与 compareTo 的陷阱

`BigDecimal.compareTo`(`:3077`)比较数值大小；`equals`还把 scale 纳入对象相等判断。因此：

```text
new BigDecimal("1.0").compareTo(new BigDecimal("1.00")) == 0
new BigDecimal("1.0").equals(new BigDecimal("1.00")) == false
```

把 BigDecimal 放进 HashMap/HashSet 时，必须意识到它们使用 equals/hashCode 语义；需要数值等价时，先明确归一化 scale 或使用 compareTo。

关键设计(斜体):*scale 把“数值”和“表示精度”分开。金额的 1.0 与 1.00 可能数值相同、业务表示却不同；equals 与 compareTo 的差异正是这个设计的直接结果。*

## 三、BigInteger：溢出后的能力边界

### 1. 大数如何存

`BigInteger` 用独立符号与大端 `int[] mag` 保存大整数：`mag` 位于 `BigInteger.java:150`。

BigDecimal 的 `intCompact` 能处理大多数普通金额；当数值超出 long，才进入这条大整数路径。不要把 BigInteger 路径当成每次 BigDecimal 运算的默认成本。

### 2. 乘法为什么分档

`BigInteger.multiply`(`:1565`)按规模选择算法：

- 小规模：朴素乘法
- 中等规模：`multiplyKaratsuba`(`:1603`)，阈值 `KARATSUBA_THRESHOLD = 80`(`:213`)
- 更大规模：`multiplyToomCook3`(`:1662`)，阈值 `TOOM_COOK_THRESHOLD = 240`(`:222`)

分治算法减少大数乘法的渐进成本，但它自身有拆分、临时对象和组合开销，所以小规模仍然使用朴素路径。

失败方案是所有输入都使用同一算法：小数值会承担不必要的分治成本，大数值又会被 O(n²) 朴素乘法拖慢。

关键设计(斜体):*BigInteger 的算法选择是“规模驱动”。BigDecimal 的双存储路径也是同一思想：小值走紧凑快路径,真正的大数才支付大整数成本。*

## 五个最容易混掉的边界：BigDecimal 不是自动精确，scale 不是纯显示，equals 不是数值相等，BigInteger 不是默认成本，舍入也不是统一财务答案

第一，BigDecimal 不是自动精确。它只能忠实表示传入的值；如果入口已经是近似的 double，`new BigDecimal(double)` 会把近似值完整保留下来，不能把它恢复成调用者原本想写的十进制数。

第二，scale 不是纯显示格式。提高 scale 可能只是补零，但降低 scale 可能改变数值；它还参与 `equals` 与 `hashCode` 的对象语义，所以数据库金额精度、计算精度和展示格式不能混成一个概念。

第三，`compareTo` 相等不是 `equals` 相等。前者回答“数值大小是否相同”，后者回答“数值和 scale 是否都相同”。把 BigDecimal 放进 HashMap 或 HashSet 前，必须先决定容器需要哪一种等价关系。

第四，BigInteger 不是每次 BigDecimal 运算的默认成本。JDK 11 会优先让能放进 long 的值走 `intCompact`；只有数值超出紧凑范围，才进入 `BigInteger` 的 `mag` 数组和分治乘法路径。

第五，舍入模式不是统一财务答案。`HALF_UP`、`HALF_EVEN`、`CEILING` 和 `FLOOR` 对负数、边界值及累计结果的含义不同；真正的规则必须由金额单位、业务约定和合规要求共同决定，BigDecimal 只负责按指定规则执行。

把这五条边界记稳，BigDecimal 就不会重新被误解成“换个类型便自动正确”的魔法容器。它真正想讲的是：输入先决定你保留了什么事实，scale 再决定你如何表示它，运算显式决定舍入，比较明确决定等价关系，而存储实现只是在这些语义确定之后负责把成本压下来。

## 收网：金额计算的四条边界

1. **输入边界**：金额优先从字符串或最小货币单位整数进入，不从 double 误差开始。
2. **存储边界**：理解 scale，明确 intCompact 与 BigInteger 路径。
3. **运算边界**：除法显式指定 scale 与舍入模式。
4. **比较边界**：区分 BigDecimal 的数值比较与 equals/hashCode 表示比较。

BigDecimal 不是“用了就自动精确”的魔法类。它只是把十进制数值、精度表示和舍入选择交给调用者显式管理。

下一篇继续追问：double 本身的二进制表示与十进制转换算法，为什么 `Double.toString(0.1)` 又能打印出看起来干净的 `0.1`？