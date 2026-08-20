# 03. 浮点数表示与 Math — IEEE-754、Double.toString、Math vs StrictMath

> 🟡 Working | 域 02 数字与数学第 3 篇 | Layer 1
> 读者处境: 线上日志里 "Infinity"/"NaN" 怎么来的?为什么 `0.1` 打印出来是 "0.1"?浮点数的二进制结构一次看清。

### 1. "double 在内存里是什么样？" — IEEE-754 位模式

场景: 面试"float 几个字节,怎么表示"——要能画出位布局

- 64 位 double = 1 符号位 + 11 指数位 + 52 尾数位;float = 1+8+23
- `Double.java:854` `doubleToLongBits(double)` — 位模式直读;`longBitsToDouble` 反向
- 特殊值: 指数全 1 尾数全 0 = ±Infinity;指数全 1 尾数非 0 = NaN;指数全 0 尾数 0 = 0/±0(有符号零!)
- 规范化 vs 非规范化(次正规数): 指数为 0 时无隐式前导 1
- 关键设计 (斜体): *`doubleToLongBits` 与 `doubleToRawLongBits` 的区别: 前者把 NaN 规范化为固定位模式(便于 hash),后者保留原始位——面试点: 为什么 Double 的 hashCode 要特殊处理 NaN*
- [IEEE 754-2008: 双精度位布局 1+11+52;JLS §4.2.3 浮点语义]

### 2. "为什么 toString(0.1) 是 0.1？" — 浮点→十进制的最短表示

场景: 日志/JSON 里 double 的打印——为什么不会输出 0.100000000000000005551115...

- `Double.java:203` `toString(double)` → `FloatingDecimal.toJavaFormatString(d)` — **JDK11 仍用旧 FloatingDecimal 实现**
- 算法: **最短十进制表示**——在"转回 double 与原始值相同"的前提下找最短字符串;FloatingDecimal 内部用 FDBigInteger(`jdk/internal/math/FDBigInteger.java:34`,精确大数分治)计算往返边界
- 实现位置: `jdk/internal/math/FloatingDecimal.java`(JDK8 起在 java.base)
- 关键设计 (斜体): *打印规则不是"按位展开"(会得到 0.1000000000000000055511151231257827021181583404541015625),而是"最短且往返一致"——JSON 序列化/日志可读性的基础;JDK19 的 DoubleToDecimal(Ryū 算法)替换 FloatingDecimal 提速*
- 面试点: "toString 输出的就是存储值的十进制最短表示"——不是"四舍五入到多少位"

### 3. "Math 和 StrictMath 有什么区别？" — strictfp 与可移植性

场景: 面试偶问——为什么有两个 Math?

- `Math.java:669` `pow` 等浮点方法委托 `StrictMath.pow`(JDK11 的 Math 共 23 处 `return StrictMath.*` 委托;整数方法如 abs/max/min 自行实现)
- `StrictMath.java` — fdlibm 算法移植(纯 Java 实现 sin/cos/exp/log 等),保证**所有平台结果逐位一致**
- 历史: 早期 Math 的许多方法标注 non-strictfp,允许平台用 80 位 x87 扩展精度;StrictMath 强制 IEEE 严格语义
- 关键设计 (斜体): *"可移植数学"的价值: 分布式系统的确定性——同一算式在 x86/ARM 结果必须一致(游戏/科学计算校验和);现代平台 Math 与 StrictMath 结果已趋于一致,区别仅在语义承诺*
- `Math.java:311` log / `Math.java:1433` max 等——max/min/abs 注意: `Math.max(Double.NaN, 1.0)` 返回 NaN 的坑

### 4. 常用陷阱清单 — 浮点比较与哈希

场景: 生产/面试常见浮点坑一次收齐

- 比较: `==` 禁止(0.1+0.2);用 `Math.abs(a-b) < 1e-9` 或 Double.compare(处理 NaN 排序)
- HashMap key: 用 Double 作 key 注意 NaN——`Double.NaN == Double.NaN` false,但 NaN 的 hashCode 固定(位模式规范化),equals 语义特殊
- 累加误差: 大数加小数,小数被吃掉(指数差距过大)——求和先小后大或 BigDecimal
- 关键设计 (斜体): *浮点面试题的共同底层: 位模式 + 舍入 + 比较语义——把这三件事讲清楚,任何变体都能拆*

---

### 核心悬念

数字终于讲完了——但"数字对象"和"字符串"在**类加载与对象模型**层面是怎么被 JVM 创建的?下一站: Object 与 System——所有对象的起点,以及 JVM 启动后的第一个 Java 类。

> → 下一篇: 域 03 对象与系统(03-object-system 系列)
