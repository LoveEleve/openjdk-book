# 02. BigDecimal 与精确计算 — 存储结构、scale、舍入模式

> **前置依赖**: [02-number-math/01 — 包装类、缓存与装箱](01-wrapper-cache-boxing.md)(Number 抽象与包装语义)
> → **后续**:[02-number-math/03 — 浮点数表示与 Math](03-ieee754-math.md)
> 关联: 域 36 JDBC(金额列类型 DECIMAL 与 BigDecimal 的映射)

## 金额系统的生死题

"钱怎么算才不出错"是每个后端工程师迟早要回答的问题。面试官的标准连招是: `0.1 + 0.2` 等于多少?为什么?BigDecimal 内部怎么存?`new BigDecimal(0.1)` 和 `new BigDecimal("0.1")` 有什么区别?`10 / 3` 为什么必须指定舍入模式?

这篇把四个问题对应的源码一次看全: 浮点误差的数学根因、BigDecimal 的三字段存储与双路径、scale 的语义与舍入、以及底层 BigInteger 的分治乘法。

## 1. "0.1 + 0.2 为什么等于 0.30000000000000004" — IEEE-754 根因

### 1.1 十进制小数转二进制:分母决定命运

十进制的 `0.1` 就是分数 `1/10`。二进制小数表示要求分母是 2 的幂——`1/2`、`1/4`、`1/8` 都是有限二进制小数,而 `1/10` 的分母 `10 = 2 × 5` 含有一个因子 5,**不是 2 的幂**,所以 0.1 的二进制展开是无限循环小数:

```
0.1₁₀ = 0.00011001100110011...₂    (0011 无限循环)
```

同理 `0.2` 也是无限循环小数。任何"十进制有限、但分母含非 2 因子"的小数(0.1、0.2、0.3、0.7…)在二进制里都是无限的。

### 1.2 double 的 53 位尾数:截断是宿命

IEEE-754 的 double 用 1 位符号 + 11 位指数 + **53 位有效位数**(52 位存储 + 1 位隐含)表示一个数。无限循环的 0.1 放进 53 位就必然截断——**double 里存的 0.1 从来不是 0.1**,而是最接近 0.1 的那个二进制可表示的近似值。两个近似值相加,误差叠加,结果就显示出 `0.30000000000000004` 这种尾巴。

关键设计(斜体):*浮点数的"精确"是相对二进制而言的——它精确表示"2 的幂的近似和",不保证十进制小数精确。面试话术: 说"浮点数存的是 2 的幂的近似和"比背"0.1 不精确"有深度。BigDecimal 的解法绕开整个问题: 永远用十进制整数做运算,数值从字符串/整数直接进十进制表示,不经过二进制转换。*

## 2. "BigDecimal 内部怎么存" — intVal + intCompact + scale 三件套

### 2.1 三个字段,两条路径

`BigDecimal` 的存储(`BigDecimal.java:240-280` 区间):

```java
// BigDecimal.java:240 + 248 + 271 + 280(截取核心,逐字)
private final BigInteger intVal;

private final int scale;

static final long INFLATED = Long.MIN_VALUE;

private final transient long intCompact;
```

- **intVal**(`BigDecimal.java:240`):无标度值,BigInteger 类型——装得下任意大整数
- **intCompact**(`BigDecimal.java:280`):同一个无标度值的 **long 快照**——绝大多数金额在 long 范围内,直接用 long 参与运算,不碰 BigInteger
- **scale**(`BigDecimal.java:248`):小数点位置——`new BigDecimal("123.45")` 存的是 `intVal=12345`(无标度值)+ `scale=2`,语义是 `12345 × 10⁻²`
- **INFLATED**(`BigDecimal.java:271`):哨兵。当无标度值超出 long 范围时,intCompact 置为 `Long.MIN_VALUE`,表示"别看我,去问 intVal"——这是双路径一致性的开关

配套的 `MAX_COMPACT_DIGITS = 18`(`BigDecimal.java:284`): 18 位十进制数一定能塞进 long,19 位不一定——注释(`BigDecimal.java:282-283`)把可紧凑存储的边界写得明明白白。

### 2.2 valueOf:统一入口 + 小值缓存

静态工厂 `valueOf(long, int)`(`BigDecimal.java:1239-1247`)是规范入口:

```java
// BigDecimal.java:1239-1247(截取核心,逐字)
public static BigDecimal valueOf(long unscaledVal, int scale) {
    if (scale == 0)
        return valueOf(unscaledVal);
    else if (unscaledVal == 0) {
        return zeroValueOf(scale);
    }
    return new BigDecimal(unscaledVal == INFLATED ?
                          INFLATED_BIGINT : null,
                          unscaledVal, scale, 0);
}
```

三个分支对应三种形态: scale=0 走 `valueOf(long)`(0-10 命中 `ZERO_THROUGH_TEN` 缓存,`BigDecimal.java:298`);值为 0 走 `zeroValueOf`(命中 `ZERO_SCALED_BY` 缓存,`BigDecimal.java:313`);常规值 new 一个——构造器收到 `unscaledVal == INFLATED` 时用 `INFLATED_BIGINT` 顶替,保证哨兵语义(见 2.1)。

### 2.3 构造陷阱:new BigDecimal(0.1) 与 new BigDecimal("0.1")

这是面试区分度最高的一问。两个构造的语义完全不同:

- `new BigDecimal(0.1)`(`BigDecimal.java:903`):**精确转换**——把 double 的完整二进制值搬进来。javadoc 警告原文(`BigDecimal.java:877-879`): *"the value that is being passed in to the constructor is not exactly equal to 0.1, appearances notwithstanding"*——`new BigDecimal(0.1)` 的值其实是 `0.1000000000000000055511151231257827...`,因为 0.1 这个 double 本身就带着二进制误差
- `new BigDecimal("0.1")`(`BigDecimal.java:837`):**十进制解析**——逐字符按十进制读入,得到精确的 `0.1`(intVal=1, scale=1)

还有一条中间路: `valueOf(double)`(`BigDecimal.java:1313`)先把 double 转成 `Double.toString(val)` 的规范字符串再解析——拿到的不是 double 的二进制全值,而是"double 打印出来的那个最短十进制表示",文档明确这是推荐的 double→BigDecimal 转换方式。

关键设计(斜体):*intCompact 是纯性能优化——金额对象 99% 都在 long 范围,能躲开 BigInteger 的对象分配和间接寻址;两条路径的一致性由 INFLATED 哨兵单点保证,所有运算方法(valueOf/add/divide)开头的四路分派都在消费这个设计。构造器层面则是"精确性"的分界线: 从 double 进来就是二进制语义,从 String 进来才是十进制语义。*

## 3. "scale 到底是什么" — 精度语义与舍入

### 3.1 scale:数值与表示精度的分离

scale 是 BigDecimal 的灵魂: 它把"数值"和"表示精度"拆成了两个维度。`1.0` 与 `1.00` 数值相等,但 scale 分别是 1 和 2——后者声明了"我精确到小数点后两位"。这就是金额场景 `setScale` 频繁出场的根源。

`setScale(int, RoundingMode)`(`BigDecimal.java:2837` 起)把无标度值乘/除以 10 的幂以维持数值不变,必要时按舍入模式收敛。

### 3.2 divide:必须指定结果 scale 和舍入模式

`10 / 3` 是无限小数,所以 `divide` 的正确形态是 `divide(divisor, scale, roundingMode)`(`BigDecimal.java:1601-1631`):

```java
// BigDecimal.java:1604-1631(截取核心,逐字)
if (this.intCompact != INFLATED) {
    if ((divisor.intCompact != INFLATED)) {
        return divide(this.intCompact, this.scale, divisor.intCompact, divisor.scale, scale, roundingMode);
    } else {
        return divide(this.intCompact, this.scale, divisor.intVal, divisor.scale, scale, roundingMode);
    }
} else {
    if ((divisor.intCompact != INFLATED)) {
        return divide(this.intVal, this.scale, divisor.intCompact, divisor.scale, scale, roundingMode);
    } else {
        return divide(this.intVal, this.scale, divisor.intVal, divisor.scale, scale, roundingMode);
    }
}
```

四路分派是 2.3 节哨兵设计的直接消费者: 被除数和除数的 intCompact/intVal 各两种状态,组合出四条路径,最终都汇聚到内部 `divide`——**同一个舍入算法,两套取值方式**。

8 种舍入模式(`RoundingMode` 枚举)里两个高频项:

- **HALF_UP**:四舍五入——最常见的业务模式
- **HALF_EVEN**:银行家舍入——"五成双"(.5 时取偶数,如 2.5→2、3.5→4),会计对账标准,消除统计偏差

### 3.3 equals 与 compareTo 的语义分裂

`compareTo`(`BigDecimal.java:3077`)和 `equals`(`BigDecimal.java:3161`)对 scale 的态度**相反**:

```java
// BigDecimal.java:3077-3091(截取核心,逐字)
public int compareTo(BigDecimal val) {
    // Quick path for equal scale and non-inflated case.
    if (scale == val.scale) {
        long xs = intCompact;
        long ys = val.intCompact;
        if (xs != INFLATED && ys != INFLATED)
            return xs != ys ? ((xs > ys) ? 1 : -1) : 0;
    }
    int xsign = this.signum();
    int ysign = val.signum();
    ...
    int cmp = compareMagnitude(val);
    return (xsign > 0) ? cmp : -cmp;
}
```

```java
// BigDecimal.java:3161-3170(截取核心,逐字)
public boolean equals(Object x) {
    if (!(x instanceof BigDecimal))
        return false;
    BigDecimal xDec = (BigDecimal) x;
    if (x == this)
        return true;
    if (scale != xDec.scale)
        return false;
    ...
}
```

- **compareTo**:scale 不同先统一数量级再比幅值——`1.0` 与 `1.00` 比较结果是 0(相等)
- **equals**:`instanceof` 与 `x == this` 之后,关键检查就是 `scale != xDec.scale → false`(`BigDecimal.java:3167`)——`1.0` 与 `1.00` **不相等**

这是生产里最阴的坑: `HashSet<BigDecimal>`/`HashMap` 用 equals 判等,`1.0` 和 `1.00` 会被当成两个 key;而 `TreeMap`/排序用 compareTo,又会认为相等。**同一对对象,两种容器给出相反的结论**。金额规范化(统一 scale)是规避它的唯一可靠手段。

关键设计(斜体):*scale 把"数值"和"表示精度"分离,equals 严格到连表示精度都要一致(否则哈希容器里同值不同精度会乱套),compareTo 宽松到只比数值(否则排序语义就坏了)。JDK 在这里刻意选择了"分裂"而不是统一——因为两种语义各有合法用途。金额最佳实践: 存储用分(scale=0 的整数)或 DECIMAL(18,2),计算统一 HALF_UP,输出用 setScale 收敛。*

## 4. "大整数是怎么算的" — BigInteger 存储与分治乘法

### 4.1 mag:大端序 int 数组

`BigInteger` 的核心是 `final int[] mag`(`BigInteger.java:150`)——大端序(最高位在前)的 32 位无符号 int 数组,符号由独立的 `signum` 字段携带。`2^64` 存成 `[1, 0]`,`123456789012345678901234567890` 按 32 位切块存。

### 4.2 multiply:三级分派

乘法 `multiply`(`BigInteger.java:1565`)按操作数规模分三级算法,阈值是编译期常量(`BigInteger.java:213`/`222`):

```java
// BigInteger.java:213 + 222(截取核心,逐字)
private static final int KARATSUBA_THRESHOLD = 80;
private static final int TOOM_COOK_THRESHOLD = 240;
```

分派逻辑(`BigInteger.java:1578-1606` 截取):

```java
// BigInteger.java:1578-1606(截取核心,逐字,省略细节分支)
if (val.signum == 0 || signum == 0)
    return ZERO;

int xlen = mag.length;
...
int ylen = val.mag.length;

if ((xlen < KARATSUBA_THRESHOLD) || (ylen < KARATSUBA_THRESHOLD)) {
    int resultSign = signum == val.signum ? 1 : -1;
    if (val.mag.length == 1) {
        return multiplyByInt(mag,val.mag[0], resultSign);
    }
    if (mag.length == 1) {
        return multiplyByInt(val.mag,mag[0], resultSign);
    }
    int[] result = multiplyToLen(mag, xlen,
                                 val.mag, ylen, null);
    result = trustedStripLeadingZeroInts(result);
    return new BigInteger(result, resultSign);
} else {
    if ((xlen < TOOM_COOK_THRESHOLD) && (ylen < TOOM_COOK_THRESHOLD)) {
        return multiplyKaratsuba(this, val);
    } else {
        ... // multiplyToomCook3
    }
}
```

三级递进:

1. **朴素乘法**(`multiplyToLen`):教科书逐位相乘,复杂度 **O(n²)**——n 是 mag 数组长度(32 位块数)
2. **Karatsuba**(`multiplyKaratsuba`,`BigInteger.java:1799`):两路分治——把 n 块拆成高/低两半,用三次乘法代替四次的朴素组合,复杂度 **O(n^1.585)**
3. **Toom-Cook 3 路**(`multiplyToomCook3`,`BigInteger.java:1857`):拆三段,五乘替代九乘,复杂度 **O(n^1.465)**——超大数才划算

阈值选择是"常数因子 vs 渐进收益"的权衡: 小规模时朴素法的常数最小,分治的拆装开销反而亏;规模过了阈值,分治的渐进优势才压过常数。

关键设计(斜体):*BigInteger 是教科书算法实战——"为什么大数乘法要分治"是面试可展开的深度题: 朴素 O(n²) 在 10 万位级别的乘法上是指数级的灾难,分治把指数从 2 降到 1.585/1.465。但工程现实是: BigDecimal 的整数部分通常很小,走 2 节的 intCompact 快路径,multiply 的 BigInteger 分治只在超大数(密码学/大数运算库)才真正被触发——所以它是"知道比用过重要"的机制。*

## 核心悬念

十进制精确了,浮点转十进制却还有个"魔法": `Double.toString(0.1)` 输出的恰好是 `"0.1"`,而不是 `0.10000000000000000555...`——明明 double 里存的不是 0.1,打印出来却"看起来是" 0.1。这是浮点转十进制的经典算法问题(最短往返表示): 怎么在"二进制数"和"十进制字符串"之间找到最短的、能往返不变的表示。下一篇把 IEEE-754 位模式、Double.toString 的机制讲清楚。

> → [02-number-math/03 — 浮点数表示与 Math](03-ieee754-math.md)
