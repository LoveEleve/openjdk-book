# 02-number-math/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.math.BigDecimal/BigInteger` 与 IEEE-754 double 语义。
> 目标：从金额错误事故出发，解释二进制浮点、十进制表示、scale、舍入和大数存储的边界。

## 1. 读者困惑

- 为什么 `0.1 + 0.2` 不是精确的 `0.3`？
- 为什么 `new BigDecimal(0.1)` 仍然不精确？
- BigDecimal 里的数值和 scale 到底是什么关系？
- `10 / 3` 为什么必须指定舍入？
- `1.0.equals(1.00)` 为什么是 false，而 `compareTo` 却相等？
- BigInteger 为什么小数值和大数值走不同存储/乘法路径？

## 2. 一句话顿悟

**BigDecimal 解决的不是“所有数字都更精确”，而是把十进制数值、表示 scale 和舍入规则显式保留下来；正确性取决于构造入口、scale 语义和运算边界，而不是类名本身。**

## 3. 旧稿问题

- 旧稿按 IEEE-754 → BigDecimal 字段 → scale → BigInteger 介绍，缺少真实金额事故开场。
- 没有先推演 double、`new BigDecimal(double)`、无舍入 divide 等失败方案。
- `intCompact/intVal/INFLATED` 双路径与 scale 的关系需要组织成“精确性 + 性能”的一条线。
- equals/compareTo 的 scale 差异需要放回 Map/Set 使用场景，而不是孤立 API 差异。
- BigInteger 算法不能只列复杂度，需要解释为什么 BigDecimal 大多数时候根本不进入大数路径。

## 4. 理解路径

### 第一节：金额事故——0.1、double 和错误构造

- `0.1+0.2` 的二进制表示问题。
- 失败方案：double 直接算金额、`new BigDecimal(double)`。
- 顿悟：必须从十进制字符串/整数单位进入十进制模型。

### 第二节：BigDecimal 内部——值、scale、双存储路径

- `intVal/intCompact/INFLATED/scale`。
- `new BigDecimal(String)` 与 `valueOf`。
- 小值 long 快路径，大值 BigInteger 路径。

### 第三节：scale、divide、舍入与 equals

- `10/3` 的不终止十进制展开。
- divide 指定 scale/rounding。
- setScale 不是简单格式化，而是数值表示调整。
- equals 比 value+scale，compareTo 比数值；Map/Set 选型误区。

### 第四节：BigInteger——大数路径为什么需要分治

- signum + mag[]。
- 小规模朴素乘法、Karatsuba、Toom-Cook 阈值。
- 失败方案：所有数都用 BigInteger/所有乘法都用 O(n²)。
- 收网：BigDecimal 多数金额走 intCompact，BigInteger 是溢出后的能力边界。

## 5. 失败方案清单

1. 用 double 保存金额。
2. `new BigDecimal(double)` 以为自动恢复十进制。
3. divide 不指定舍入，遇到非终止小数失败或产生错误表示。
4. 把 scale 当成纯展示格式。
5. 用 equals 判断 BigDecimal 数值等价，忽略 scale。
6. 所有大数乘法都使用同一算法。

## 6. 误解清单

1. BigDecimal 构造后所有运算自动符合业务舍入——错误。
2. `new BigDecimal(0.1)` 与 `new BigDecimal("0.1")` 一样——错误。
3. scale 只是小数点显示位数——错误，它参与表示语义与 equals。
4. compareTo 相等意味着 equals 相等——BigDecimal 不是这样。
5. BigInteger 每次都创建大型 int 数组——BigDecimal 小值可走 intCompact。

## 7. 证据清单

- `BigDecimal.java:240/271/280/837/1279`：intVal/intCompact/INFLATED/String/valueOf。
- `BigDecimal.java:1601/2882/3077`：divide/setScale/compareTo。
- `RoundingMode.java`：舍入模式。
- `BigInteger.java:150/1565/1603/1662`：mag/multiply/Karatsuba/Toom-Cook。
- `BigInteger.java:213/222`：乘法阈值。

## 8. 版本与边界

- 基于 JDK 11 `java.math` 实现。
- IEEE-754 double 的具体格式是标准语义，BigDecimal 存储路径是 JDK 实现细节。
- Karatsuba/Toom-Cook 阈值是当前实现常量，不能外推到所有语言库或未来 JDK。
- 金额舍入规则由业务决定，`HALF_UP` 不是所有财务场景的默认答案。

## 9. 验收标准

- 开头先出现金额/0.1 事故。
- 至少展开六个失败方案。
- 解释构造入口、scale、舍入、equals/compareTo、intCompact 与大整数分治。
- 明确区分数值、表示精度和对象比较语义。
- 删除代码后主线仍成立，所有锚点和禁用词检查全绿。
