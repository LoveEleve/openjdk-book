# 01. 包装类、缓存与装箱 — IntegerCache 与 == 陷阱

> **前置依赖**: [01-string/03 — 字符串构建与拼接](../01-string/03-build-concat.md)(StringConcatHelper 里已经见过 `Integer.getChars` 的影子)
> → **后续**:[02-number-math/02 — BigDecimal 与精确计算](02-bigdecimal.md)
> 关联: [JLS §5.1.7 装箱转换];内部卷 07-classfile-classloader 03-symbol-string-table(字符串驻留,与包装类缓存的对照)

## 一道面试题,三层的答案

`Integer a = 100, b = 100; a == b` 是 true,`Integer a = 200, b = 200; a == b` 是 false——这道题背答案容易,但被追问"为什么是 -128 到 127""缓存是什么时候建的""能不能扩大"时,大多数人就卡住了。更麻烦的是它在生产里是实打实的 bug 源: 两个值用 `==` 比较的代码,数据量小的时候跑得好好的,一越界就偶发错误。

这篇把缓存机制的源码逐行拆开,顺带把 `parseInt`/`toString` 这两个天天用的算法也看了——你会发现它们和域 01 的字符串操作共享同一套优化哲学。

## 1. "-128 到 127 是怎么来的" — IntegerCache 静态块

### 1.1 入口:valueOf 的一行判断

自动装箱的规范入口是 `valueOf(int)`(`Integer.java:1055-1060`):

```java
// Integer.java:1055-1060(截取核心,逐字)
@HotSpotIntrinsicCandidate
public static Integer valueOf(int i) {
    if (i >= IntegerCache.low && i <= IntegerCache.high)
        return IntegerCache.cache[i + (-IntegerCache.low)];
    return new Integer(i);
}
```

两行判断:命中缓存直接返回**缓存数组里的既有引用**,否则 new。面试题的全部秘密就在第一行——`IntegerCache.low` 和 `IntegerCache.high` 是什么。

### 1.2 缓存类:静态块里的三件事

`IntegerCache`(`Integer.java:997-1035`)是 Integer 的私有静态内部类:

```java
// Integer.java:997-1035(截取核心,逐字,省略中间空行/注释)
private static class IntegerCache {
    static final int low = -128;
    static final int high;
    static final Integer[] cache;
    ...
    static {
        // high value may be configured by property
        int h = 127;
        String integerCacheHighPropValue =
            VM.getSavedProperty("java.lang.Integer.IntegerCache.high");
        if (integerCacheHighPropValue != null) {
            try {
                int i = parseInt(integerCacheHighPropValue);
                i = Math.max(i, 127);
                // Maximum array size is Integer.MAX_VALUE
                h = Math.min(i, Integer.MAX_VALUE - (-low) -1);
            } catch( NumberFormatException nfe) {
                // If the property cannot be parsed into an int, ignore it.
            }
        }
        high = h;
        ...
        int size = (high - low) + 1;
        ...
        Integer[] c = new Integer[size];
        int j = low;
        for(int k = 0; k < c.length; k++)
            c[k] = new Integer(j++);
        ...
        cache = archivedCache;
        // range [-128, 127] must be interned (JLS7 5.1.7)
        assert IntegerCache.high >= 127;
    }
    ...
}
```

三件事:

1. **下限固定 -128**(`Integer.java:998`)——JLS 强制语义,不可配置
2. **上限默认 127,可配置**:静态块读系统属性 `java.lang.Integer.IntegerCache.high`(`Integer.java:1006-1007`),解析后 `Math.max(i, 127)` 保证 high 至少 127(即 JLS 要求的 -128..127 完整覆盖)、`Math.min(i, Integer.MAX_VALUE - (-low) -1)`(=MAX_VALUE-129)防数组超界。这个属性由 JVM 启动参数 `-XX:AutoBoxCacheMax=<size>` 写入——类注释(`Integer.java:986-995`)写得很清楚: VM 初始化期间把该属性存进私有系统属性,`VM.getSavedProperty` 取回
3. **类加载时一次性填充**:`for` 循环 new 出 (high - low + 1) 个 Integer 对象;JDK11 还多了 CDS 存档(`VM.initializeFromArchive(IntegerCache.class)` @1021,类注释在 1020)——归档缓存够大就直接复用,省去重新创建

### 1.3 关键设计:为什么是 -128..127

[JLS §5.1.7] 是法律的来源: 装箱规范强制规定——对 -128..127 范围内的 int/short 装箱,任意两次装箱结果 `r1 == r2` 必须成立。也就是说: **这个下限不是性能决定,是语言规范决定**;上限 127 是规范的最低要求,JDK 往上扩(可配)是空间换时间。

关键设计(斜体):*小整数是高频值——循环计数、索引、状态码,缓存后每次装箱省一次对象分配和一次 GC 压力。这层缓存画在"语言规范强制"和"实现可扩展"之间: 规范只保证最低范围,JDK 用可配置上限把这个范围扩大,同时还用 CDS 把缓存本身也归档起来(JVM 启动免重建)。面试答"为什么 100==100 true"时能说出"JLS 5.1.7 强制 -128..127,上限可配 AutoBoxCacheMax",就比背结论高一个段位。*

## 2. "为什么 == 会踩坑" — 引用比较 vs 值比较

### 2.1 机制:一行的差别

`a == b` 对引用类型比较的是**引用是否同一**。缓存命中范围内(比如 100),两个装箱操作都返回 `IntegerCache.cache[228]` 同一个对象 → true;范围外(200),两次 `new Integer(200)` 是两个对象 → false。同一段代码,结果随数据值变化——这就是"偶发错误"的根源。

注意 `new Integer(i)` 构造(`Integer.java:1082-1084`)是不走缓存的,JDK9 起已标 `@Deprecated(since="9")`(`Integer.java:1081`)——"要对象用 valueOf"是这个废弃的直接理由。

### 2.2 equals 才是值比较

`Integer.equals`(`Integer.java:1212-1217`)自己实现了值语义,不是继承 Object 的引用比较:

```java
// Integer.java:1212-1217(截取核心,逐字)
public boolean equals(Object obj) {
    if (obj instanceof Integer) {
        return value == ((Integer)obj).intValue();
    }
    return false;
}
```

`instanceof` 类型检查 + 拆箱后比原始值——这正是 `equals` 与 `==` 的分野。

### 2.3 最容易踩的边界:不走 valueOf 的路径

缓存只在 `valueOf` 生效,有三条常见路径绕开它:

- **反序列化**:`readObject` 直接建对象,不走缓存
- **数据库/ORM 映射**:MyBatis 等框架对 Integer 列大多直接构造或反射赋值,缓存不生效
- **显式 `new Integer`**:废弃构造,但老代码还在

所以"缓存边界问题"在序列化/持久化场景最阴险: 数据从库里读出来比,范围外的值必 false。生产规范: 包装类型比较一律 `equals`(或 `Objects.equals`),`==` 只用于基本类型。

关键设计(斜体):*面试标准答法三层: ① 缓存范围 -128..127(可配上限)② `==` 是引用比较 ③ `equals` 才是值比较。能补上"反序列化不走缓存"和"构造已废弃"两个细节,就说明你真的读过源码而不是背的。*

## 3. "Integer 里还有什么" — parseInt 与 toString 算法

### 3.1 parseInt:负数累加 + 溢出预检

`Integer.parseInt("12345")`(`Integer.java:604-664`)的循环核心:

```java
// Integer.java:646-660(截取核心,逐字)
int multmin = limit / radix;
int result = 0;
while (i < len) {
    // Accumulating negatively avoids surprises near MAX_VALUE
    int digit = Character.digit(s.charAt(i++), radix);
    if (digit < 0 || result < multmin) {
        throw NumberFormatException.forInputString(s);
    }
    result *= radix;
    if (result < limit + digit) {
        throw NumberFormatException.forInputString(s);
    }
    result -= digit;
}
return negative ? result : -result;
```

两个设计点:

1. **负数累加**:`result` 一路是负数(`result -= digit`),最后按符号翻转。源码注释(`Integer.java:649`)说得明白:"Accumulating negatively avoids surprises near MAX_VALUE"——如果按正数累加,"2147483648" 这种值会先溢出成负数再被误判为合法,负数累加让溢出方向与边界检查一致
2. **溢出预检在运算前**:`result < multmin` 在 `result *= radix` **之前**检查——因为 Java 的整数溢出是静默回绕(没有溢出标志位,也不像 Python 那样任意精度),乘完才知道溢没溢,所以必须在乘之前用"下限除 radix"判断下一步必然溢出的情况。两道检查(`result < multmin` 防乘法溢出 + `result < limit + digit` 防减法下溢)构成完整的边界防护

关键设计(斜体):*"先检查、后运算"是 Java 数值算法的通用纪律: 语言层面没有溢出标志位,所有可能溢出的运算都得靠不等式在操作前拦截。面试问 parseInt 的边界处理,能说出"负数累加 + multmin 预检"两个词就够深了。*

### 3.2 toString:查表替代除法

`toString(int)`(`Integer.java:436-448`)是 JEP 254 之后的形态——直接写 byte[](COMPACT_STRINGS 分支):

```java
// Integer.java:436-448(截取核心,逐字)
@HotSpotIntrinsicCandidate
public static String toString(int i) {
    int size = stringSize(i);
    if (COMPACT_STRINGS) {
        byte[] buf = new byte[size];
        getChars(i, size, buf);
        return new String(buf, LATIN1);
    } else {
        byte[] buf = new byte[size * 2];
        StringUTF16.getChars(i, size, buf);
        return new String(buf, UTF16);
    }
}
```

`getChars`(`Integer.java:485-517`)的核心是**两位一取 + 查表**:

```java
// Integer.java:485-517(截取核心,逐字)
static int getChars(int i, int index, byte[] buf) {
    int q, r;
    int charPos = index;

    boolean negative = i < 0;
    if (!negative) {
        i = -i;
    }

    // Generate two digits per iteration
    while (i <= -100) {
        q = i / 100;
        r = (q * 100) - i;
        i = q;
        buf[--charPos] = DigitOnes[r];
        buf[--charPos] = DigitTens[r];
    }

    // We know there are at most two digits left at this point.
    q = i / 10;
    r = (q * 10) - i;
    buf[--charPos] = (byte)('0' + r);

    // Whatever left is the remaining digit.
    if (q < 0) {
        buf[--charPos] = (byte)('0' - q);
    }

    if (negative) {
        buf[--charPos] = (byte)'-';
    }
    return charPos;
}
```

- **负数化**:和 parseInt 呼应——统一按负数处理,`i = -i` 后 -2147483648 也安全(MIN_VALUE 取正会溢出);`DigitOnes`/`DigitTens` 查表(`Integer.java:399`/`412`): 0-99 的个位/十位字符表,一次除法取两位,把"逐位除 10"的代价砍半
- **从后往前写**:`buf[--charPos]`——最低位先写,最后整体是正序;这和域 01 第 3 篇 `StringConcatHelper.prepend` 的"从后往前填"是同一套路

配套的 `stringSize`(`Integer.java:534-547`)用线性查 `sizeTable`(`Integer.java:520-521` 的 `{9, 99, 999, ...}`)估数字位数——注释说明为什么不用二分: "values are biased heavily towards zero, and therefore linear search wins"(`Integer.java:529-531`),而且循环展开后常被内联。

关键设计(斜体):*toString/parseInt 的优化是"时间换空间"的变体——用查表(内存)换除法(CPU)。除法是整数指令里最贵的之一,把"除 10 取余"换成"一次除法 + 两次查表",对高频的数字格式化收益显著。这套技巧在 JDK 里反复出现: 域 01 的 StringConcatHelper 直接复用 `Integer.getChars` 写缓冲区,`AbstractStringBuilder.append(int)` 也是直接调 `Integer.getChars` 把数字写进自己的 byte[](`AbstractStringBuilder.java:777`)——数字格式化被收敛到这一处优化实现上。*

## 4. Long/Short/Byte/Boolean 缓存与 Number 抽象

### 4.1 三兄弟:同一个 -128..127

`LongCache`(`Long.java:1147-1155`)和 Integer 的差别值得注意——**没有 high 配置**:

```java
// Long.java:1147-1155(截取核心,逐字)
private static class LongCache {
    private LongCache(){}

    static final Long cache[] = new Long[-(-128) + 127 + 1];

    static {
        for(int i = 0; i < cache.length; i++)
            cache[i] = new Long(i - 128);
    }
}
```

固定 256 个,静态块填充,`valueOf(long)`(`Long.java:1175-1181`)用 `final int offset = 128` 换算下标。`ShortCache`(`Short.java:205-214`)、`ByteCache`(`Byte.java:79-88`)是同一模板的复制——Byte 更彻底,byte 的全部 256 个值都在缓存里(javadoc:"all byte values are cached",`Byte.java:97`)。只有 Integer 因为范围过大允许调高上限,Long/Short/Byte 不需要: Long 的装箱频率远低于 Integer,Short/Byte 全范围缓存也才几百个对象。

### 4.2 Boolean:两个单例

`Boolean` 没有数组缓存——只有两个字段(`Boolean.java:52`/`58`):

```java
// Boolean.java:52 + 58(截取核心,逐字)
public static final Boolean TRUE = new Boolean(true);

public static final Boolean FALSE = new Boolean(false);
```

`valueOf`(`Boolean.java:161-164`)就是三元选择:

```java
// Boolean.java:161-164(截取核心,逐字)
public static Boolean valueOf(boolean b) {
    return (b ? TRUE : FALSE);
}
```

boolean 只有两个值,单例就是最优缓存。

### 4.3 Number 抽象:转换协议

`Number`(`Number.java:55`)定义包装类的统一转换协议——4 个抽象方法:

```java
// Number.java:55 + 62 + 98-100 + 112-114 + 118(截取核心,逐字)
public abstract class Number implements java.io.Serializable {

    public abstract int intValue();

    public byte byteValue() {
        return (byte)intValue();
    }

    public short shortValue() {
        return (short)intValue();
    }
}
```

`intValue`/`longValue`/`floatValue`/`doubleValue` 是抽象方法,由子类按自己的精度实现;`byteValue`/`shortValue` 是**默认实现**——直接 `intValue()` 强转截断(javadoc 原话: "This implementation returns the result of {@link #intValue} cast to a {@code byte}",`Number.java:91-92`)。`floatValue`/`doubleValue` 对 Integer 是精确的,对 BigInteger/BigDecimal 才可能有舍入——这个协议的设计意图: 所有数字类型统一"能转成四种基本数字类型",集合/框架只用 Number 接口就能处理任意数字。

关键设计(斜体):*包装类缓存是"小整数常量池"的 Java 层实现——和域 01 的 String intern 是同一个驻留思想: 小值高频、不可变、驻留共享。区别在位置: 字符串池在 JVM 里(VM 管理),IntegerCache 在 Java 静态区(Java 管理);字符串池是懒查入,IntegerCache 是类加载时一次建齐。能说出这个对照,就是把两个面试高频点串成了一条线。*

跨层标注: [JLS §5.1.7 装箱转换: -128..127 范围内的两次装箱结果必须 ==];[内部卷: 07-classfile-classloader 03-symbol-string-table(字符串驻留,与包装类缓存的对照)]

## 核心悬念

包装类解决了"基本类型进不了集合",但也把"相等"变成了一个需要小心的概念——而浮点数更狠: 它连**精确相等都做不到**。`0.1 + 0.2 == 0.3` 为什么是 false?面试官下一问就是它,而生产上"钱怎么算才不出错"是金额系统的生死题。下一篇: BigDecimal 的精确十进制——`scale` 语义、舍入模式、以及 `0.1` 到底存成了什么。

> → [02-number-math/02 — BigDecimal 与精确计算](02-bigdecimal.md)
