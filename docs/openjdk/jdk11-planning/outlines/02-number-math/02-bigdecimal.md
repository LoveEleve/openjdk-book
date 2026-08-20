# 02. BigDecimal 与精确计算 — 存储结构、scale、舍入模式

> 🔴 Deep | 域 02 数字与数学第 2 篇 | Layer 1
> 读者处境: 金额计算必须用 BigDecimal——但 0.1+0.2 为什么不精确?BigDecimal 内部怎么存?divide 为什么不抛出但结果不对?

### 1. "0.1 + 0.2 为什么等于 0.30000000000000004？" — IEEE-754 根因

场景: 面试第一问——浮点数精度问题的根源

- 0.1 的二进制是无限循环小数(0.0001100110011...),IEEE-754 double 只有 53 位尾数 → 截断 → 存储的 0.1 本身就不精确
- 两个"不精确的 0.1"相加,误差叠加 → 0.30000000000000004
- 关键设计 (斜体): *浮点数的"精确"是相对二进制而言的——所有十进制小数转二进制无限循环的都不可精确表示;BigDecimal 的解法: 用十进制整数运算,不经过二进制转换*
- 面试话术: "浮点数存的是 2 的幂的近似和"——比背"0.1 不精确"有深度

### 2. "BigDecimal 内部怎么存？" — intVal + intCompact + scale 三件套

场景: `new BigDecimal("123.45")` — 这个对象里有什么?

- `BigDecimal.java:240` — `private final BigInteger intVal;` — 整数部分(含符号,大数场景)
- `BigDecimal.java:280` — `private final transient long intCompact;` — 紧凑整数(值在 long 范围时用;超范围置 `INFLATED = Long.MIN_VALUE` 哨兵,`BigDecimal.java:271`)
- `scale` — 小数点位置: `123.45` → intVal=12345, scale=2(表示 ×10⁻²)
- 双路径: 值小走 intCompact(快),值大走 intVal(BigInteger)——`valueOf` 静态工厂统一入口(`BigDecimal.java:1279`)
- 关键设计 (斜体): *intCompact 是性能优化——绝大多数金额在 long 范围,避免创建 BigInteger 对象;两路径一致性由 INFLATED 哨兵保证(值超 long 范围时 intCompact 失效、只用 intVal),setScale 等操作按需切换*
- `BigDecimal.java:837` `public BigDecimal(String val)` — **必须用字符串构造**: new BigDecimal(0.1) 会把"不精确的 double"完整转进来,而 new BigDecimal("0.1") 走十进制解析

### 3. "scale 到底是什么？" — 精度语义与 setScale/divide

场景: `10 / 3` 用 BigDecimal 怎么除?为什么必须指定舍入模式?

- `BigDecimal.java:1601` `divide(BigDecimal divisor, int scale, int roundingMode)` — 除法的正确用法: 指定结果 scale + 舍入
- `BigDecimal.java:2882` `setScale(int newScale, int roundingMode)` — 位数调整(金额分→元转换)
- `BigDecimal.java:3077` `compareTo` — 注意与 equals 的区别: **equals 比较 value+scale(1.0 ≠ 1.00),compareTo 只比较数值(相等)**——HashMap/Set 用 equals 会踩坑
- `RoundingMode.java` — 8 种模式:HALF_UP(四舍五入)/HALF_DOWN/HALF_EVEN(银行家舍入,会计标准)/UP/DOWN/CEILING/FLOOR/UNNECESSARY
- 关键设计 (斜体): *scale 是 BigDecimal 的灵魂——它把"数值"和"表示精度"分离;金额最佳实践: 存分(scale=0 int)或 DECIMAL(18,2),计算用 HALF_UP,展示用 setScale*
- 面试点: "BigDecimal 为什么不推荐 new BigDecimal(double)"

### 4. "大整数是怎么算的？" — BigInteger 存储与分治乘法

场景: 面试追问——BigInteger 内部用什么结构?乘法快吗?

- `BigInteger.java:150` — `final int[] mag;` — 大端序 int 数组(符号单独 signum)
- `BigInteger.java:1565` `multiply` — 分派策略:
  - 朴素乘法(小规模)→ Karatsuba(`multiplyKaratsuba`,1603,三位数分治 O(n^1.585))→ Toom-Cook 3 路(`multiplyToomCook3`,1662,更大规模 O(n^1.465))
  - 阈值: `KARATSUBA_THRESHOLD = 80`、`TOOM_COOK_THRESHOLD = 240`(`BigInteger.java:213/222`)
- 加法 `add` 逐 int 进位(carry),减法借位
- 关键设计 (斜体): *BigInteger 是教科书算法实战——面试可展开"为什么大数乘法要分治";但工程上 BigDecimal 的整数部分通常小,走 intCompact,multiply 只查 BigInteger 路径*
- [C++: 内部卷无直接对应;算法复杂度 O(n²) vs O(n^1.585) 是亮点]

---

### 核心悬念

十进制精确了,那 **double 本身怎么转成可读字符串**的?`Double.toString(0.1)` 为什么恰好输出 "0.1" 而不是那一长串?——这是浮点转十进制的经典算法问题。

> → [03-ieee754-math.md](03-ieee754-math.md)
