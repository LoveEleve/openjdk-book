# 域 02: 数字与数学 — 知识规划

> 源码路径: java.base/share/classes/java/lang/{Number,Integer,Long,Double,Float,Short,Byte,Boolean,Math,StrictMath}.java + java/math/{BigInteger,BigDecimal,MathContext,RoundingMode}.java + jdk/internal/math/FloatingDecimal.java
> 源码量: ~22 文件 / ~24,000 行 | 非巨型域
> 写作层: Layer 1(前置: 域 01 字符串)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| Integer.java (1830 行) | **IntegerCache**: `private static class IntegerCache`(997),`cache` 数组(1000)——-128..127 缓存,valueOf 走缓存 | High |
| Integer.java | **parseInt 实现**: 进制转换算法(604)——字符→数值的逐位乘加,溢出检测 | High |
| Integer.java | **toString(int, radix)**: 数值→字符(137),`getChars` 查表优化(每位除 10 取余的优化版) | High |
| Integer.java | **位运算族**: highestOneBit(1585)/lowestOneBit/reverse/numberOfLeadingZeros——位操作工具 | Medium |
| Long.java (1959) | 同 Integer 的 long 版(LongCache -128..127,parseLong) | High |
| Double.java (1075) / Float.java (987) | **IEEE-754 封装**: doubleToLongBits/longBitsToDouble(位模式解析)、toString 的十进制转换(经 FloatingDecimal)、NaN/Infinity 语义 | High |
| Number.java (118) | **抽象数字**: intValue/longValue/floatValue/doubleValue/byteValue/shortValue——子类转换协议 | Medium |
| Short/Byte/Boolean.java | 缓存(ShortCache/ByteCache/TRUE/FALSE)+ 转换 | Medium |
| Math.java (2718) | **浮点数学函数**: log(311)/pow(669)/abs(1368)/max(1433)/sqrt 等——委托 StrictMath;strictfp 语义 | High |
| StrictMath.java (1951) | **可移植数学**: 各数学函数的"标准结果"实现(fdlibm 移植),保证跨平台一致 | Medium |
| BigInteger.java (4836) | **大整数**: `final int[] mag`(150)符号+幅值表示;add/subtract/multiply(Karatsuba/Toom-Cook 分段)的朴素算法与分治 | High |
| BigDecimal.java (5759) | **十进制小数**: `BigInteger intVal`(240)+ `intCompact`(280)+ `scale`(精度,scale 语义)、add(1330)/multiply/divide 舍入;toString 科学计数 | High |
| MathContext.java (326) | 精度与舍入模式的上下文封装(precision + RoundingMode) | Medium |
| RoundingMode.java (393) | 8 种舍入模式枚举(HALF_UP 等,from 兼容旧常量) | Medium |
| jdk/internal/math/FloatingDecimal.java | 浮点↔十进制的精确转换(与 Double.toString 关联) | Low |

*15 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | 包装类缓存与装箱 | 5 (Integer/Long/Short/Byte/Boolean) | 面试"== 比较陷阱"核心 |
| P1 | BigDecimal 精度语义 | 4 (BigDecimal/BigInteger/MathContext/RoundingMode) | 面试/生产金额计算核心 |
| P2 | parseInt/toString 算法 | 3 (Integer/Long) | 面试偶尔(进制转换) |
| P2 | IEEE-754 与浮点表示 | 4 (Double/Float/Number/FloatingDecimal) | 面试浮点精度问题 |
| P3 | 位运算工具 | 2 (Integer/Long) | 框架使用层(哈希扰动等) |
| P3 | Math/StrictMath | 2 | 使用层,实现是 native/fdlibm |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | 包装类缓存与装箱 | 面试必考(Integer == 陷阱, -128..127);框架处处涉及(集合泛型装箱成本) |
| 🔴 Deep | BigDecimal 精度与舍入 | 面试必考(0.1+0.2 问题);生产金额计算标准;实现细节(scale/intCompact)有区分度 |
| 🟡 Working | IEEE-754 浮点表示 | 面试常问(0.1 为什么不精确);Double 位模式解析 |
| 🟡 Working | parseInt/toString | 面试偶尔;理解进制转换与溢出 |
| 🟢 Surface | 位运算工具族 | 使用层(ConcurrentHashMap 等用到 spread 时提及) |
| 🟢 Surface | Math 内部 | fdlibm 移植,无 Java 算法价值;委托 StrictMath |

## 04 聚类

### 依赖图(域内)
```
Number ←── Integer/Long/Short/Byte/Float/Double/Boolean(包装类,缓存+转换)
BigInteger(纯 Java 大数算法) ←── BigDecimal(复用其整数运算,叠加 scale 语义)
Math ←── StrictMath(实现委托,保持可移植)
FloatingDecimal ←── Double/Float.toString
```

### 教学顺序与文章拆分(3 篇)

1. **包装类、缓存与装箱** — IntegerCache(-128..127)、valueOf、== 陷阱、equals、自动装箱
2. **BigDecimal 与精确计算** — 0.1+0.2 问题、scale/舍入模式、BigInteger 存储、add/divide 实现、金额最佳实践
3. **浮点数表示与 Math** — IEEE-754 位模式、Double.toString、Math vs StrictMath、常用数学函数语义

> 前置: 域 01(toString/parse 依赖字符处理)。跨层: Math 的 native 实现(内部卷), BigDecimal 面试点与域 36 JDBC 金额列类型关联
