# 包装类、缓存与装箱 — 一个数字为什么有两种身份

> 基于 JDK 11 `java.base` 的包装类实现，并区分 JLS 装箱最低保证与 JDK 当前缓存策略。
> **前置依赖**: [01-string/01 — String 不可变](../01-string/01-storage-immutable.md)(值对象与共享)、[03-object-system/01 — Object 契约](../03-object-system/01-object-contract-references.md)(equals 基础)
> → **后续**: [BigDecimal 与精确计算](02-bigdecimal.md)

## 先看 100 和 200

```java
Integer a = 100;
Integer b = 100;
Integer c = 200;
Integer d = 200;
```

很多人第一次看到：

```text
a == b  可能为 true
c == d  可能为 false
```

如果把 `==` 当成数字比较，这个现象像随机 bug；如果把 `Integer` 看成对象，就会发现它其实同时存在两套语义：

```text
int 数值
   ↓ 自动装箱 / Integer.valueOf
Integer 对象
   ├─ ==       → 比对象身份
   └─ equals  → 比 int 数值
```

缓存只是装箱过程中的优化，不能把身份比较变成值比较。

## 一、IntegerCache：规范下限不是实现上限

### 1. 装箱入口

自动装箱最终会落到类似 `Integer.valueOf(int)` 的入口。JDK 11 的实现是：

```java
// Integer.java:1056-1059(截取,逐字)
    public static Integer valueOf(int i) {
        if (i >= IntegerCache.low && i <= IntegerCache.high)
            return IntegerCache.cache[i + (-IntegerCache.low)];
        return new Integer(i);
    }
```

这里已经回答了 100/200 现象：命中缓存时返回同一个引用，越过缓存范围时创建新的 Integer 对象。但“200 一定不缓存”也不严谨，因为缓存上限可以配置。

### 2. 缓存如何建立

`IntegerCache` 的核心字段位于 `Integer.java:997-999`：

```java
    private static class IntegerCache {
        static final int low = -128;
        static final int high;
        static final Integer[] cache;
```

静态初始化从 `VM.getSavedProperty("java.lang.Integer.IntegerCache.high")`(`:1007`)读取上限属性，默认从 127 开始，并限制在合法数组范围内。缓存是在类初始化阶段集中构建的，不是每次 `valueOf` 临时创建。

因此要分开两句话：

- `-128..127` 是装箱语义的最低缓存保证。
- JDK 实现可以通过 `IntegerCache.high`/启动配置扩大上限。

失败方案是：在测试机上碰巧看到 `200 == 200` 为 true，就把这个行为写进业务逻辑。换机器、换启动参数、换对象来源后，身份结果就可能变化。

关键设计(斜体):*IntegerCache 是“小整数对象池”,解决的是重复对象分配,不是比较契约。面试"为什么 100==100": 因为命中缓存;面试"为什么不能用 ==": 因为缓存范围与对象来源都不是业务值语义。*

## 二、为什么 `==` 会踩坑

### 1. `==` 和 equals 问的不是同一个问题

`==` 对两个引用类型比较的是对象身份；`equals` 才是对象定义的值相等。

`Integer.equals` 的源码直接比较内部 int 值：

```java
// Integer.java:1212-1217(截取核心,逐字)
    public boolean equals(Object obj) {
        if (obj instanceof Integer) {
            return value == ((Integer)obj).intValue();
        }
        return false;
    }
```

所以业务代码的规则很简单：

```text
包装类比较数值 → equals 或先拆箱
包装类比较身份 → 才使用 ==，但通常不是业务需求
```

### 2. 为什么数据库/反序列化更容易暴露问题

`Integer.valueOf` 只是其中一条对象产生路径。数据库驱动、反序列化框架、反射或显式构造，都可能生成不与缓存共享的 Integer 对象。于是同一个数值可能来自不同引用，`==` 的偶然正确性就消失了。

关键设计(斜体):*缓存命中只是实现路径,不是值相等的证据。面试标准答案必须包含三层: 缓存范围、`==` 是身份比较、`equals` 是值比较。*

## 三、包装对象背后的数字算法

包装类不只是缓存容器，它还负责把字符串变成数字、把数字变成字符串。

### 1. parseInt：先控制边界，再累加

`Integer.parseInt(String, int)`(`Integer.java:604`)不能先把所有字符乘加完再检查溢出，因为溢出发生后信息可能已经丢失。实现会维护负数形式的中间结果和边界，逐字符校验 radix 与数字，并在下一次乘加前判断是否还能安全继续。

这是一种通用的解析原则：**边界检查必须发生在危险算术之前**。

### 2. toString：照顾 MIN_VALUE

`Integer.toString(int)`(`Integer.java:437`)先计算输出长度，再根据 Compact Strings 分配 Latin1 或 UTF16 缓冲区。负数尤其是 `Integer.MIN_VALUE` 不能简单先取正数，因为正数范围比负数少一个单位；实现通过负数路径避免这个陷阱。

两位数字查表位于 `DigitTens/DigitOnes`(`Integer.java:499-500`)，把常见的两位输出转换成查表，减少逐位除法路径。

关键设计(斜体):*解析是“先乘后加 + 预先防溢出”,格式化是“先定大小 + 反向填充/查表”。包装类的性能边界也来自这些看似小的整数算法。*

## 四、其他包装类与收网

- `Long/Short/Byte` 也有各自的缓存实现，但不能只凭 Integer 推导所有范围。
- `Boolean.TRUE/FALSE` 是固定的两个单例对象。
- `Number`(`Number.java:55`)定义 `intValue/longValue/floatValue/doubleValue` 等数值转换协议；`byteValue/shortValue` 是基于 `intValue` 的默认截断实现。

现在回到最初的事故：

```text
装箱 → 可能命中缓存
==   → 比身份，结果依赖实现路径
存值 → equals/拆箱，结果依赖数值
```

缓存省的是对象分配与 GC 压力，equals 守护的才是业务正确性。下一篇继续处理另一个更危险的数字问题：浮点数为什么无法精确表示 0.1，以及金额计算为什么需要 BigDecimal。