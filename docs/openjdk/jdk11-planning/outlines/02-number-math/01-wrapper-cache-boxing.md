# 01. 包装类、缓存与装箱 — IntegerCache 与 == 陷阱

> 🔴 Deep | 域 02 数字与数学第 1 篇 | Layer 1
> 读者处境: "Integer a=100, b=100; a==b 是 true,但 a=200 就是 false"——这个经典面试题背后的缓存机制逐行看。

### 1. "-128 到 127 是怎么来的？" — IntegerCache 静态块

场景: 面试题第一问——为什么 100==100 true,200==200 false?

- `Integer.java:1056` `public static Integer valueOf(int i)` — 装箱的规范入口
- `Integer.java:998-1000` — `IntegerCache.low = -128`、`high`、`Integer[] cache`:
  - 缓存范围: 固定 -128(Java 规范下限),上限默认 127,**可配**——静态块读取 `VM.getSavedProperty("java.lang.Integer.IntegerCache.high")` 系统属性(`Integer.java:1004` 附近,属性注释提及 `-XX:AutoBoxCacheMax`)
  - 静态初始化: 类加载时一次性填充 256 个 Integer 对象,valueOf 范围内直接返回缓存引用
- 关键设计 (斜体): *为什么是 -128..127: 规范最低要求,保证 JLS 语义一致(赋值/装箱结果);再大的范围纯属空间换时间——小整数高频使用,省去每次 new 对象与 GC 压力*
- 配置入口: JVM flag `-XX:AutoBoxCacheMax` 会写入该属性(`Integer.java:991` 注释),静态块 `Integer.java:1003-1012` 读取并填充缓存

### 2. "为什么 == 会踩坑？" — 引用比较 vs 值比较

场景: 生产 bug——`Integer` 比较用 `==` 偶发错误,根因就在缓存边界

- `==` 比较的是引用(缓存内命中同一对象→true;越界→new 新对象→false)
- `equals()` 才是值比较——`Integer.java:1212` `equals(Object obj)`: `instanceof Integer` 后比较 `value == ((Integer)obj).intValue()`(Integer 自带实现,非继承)
- 触发场景: 反序列化/数据库取值的 Integer 不走 valueOf,缓存不生效,边界最易踩
- 关键设计 (斜体): *面试标准答法分三层: ① 缓存范围 ② ==是引用比较 ③ equals 是值比较——但能说出 `-XX:AutoBoxCacheMax` 与静态初始化时机才算有源码依据*
- [JLS §5.1.7: 装箱规范强制 -128..127 缓存]

### 3. "Integer 里还有什么？" — parseInt 与 toString 算法

场景: `Integer.parseInt("12345")` — 字符串怎么变成数字的?

- `Integer.java:604` `parseInt(String s, int radix)`: 逐字符 `digit = Character.digit(...)`,结果 `result = result * radix + digit`,每次迭代检查 `result < multmin` 溢出
- `Integer.java:437` `toString(int)`: 负数边界处理(取负数累加,避免 MIN_VALUE 取正溢出),`getChars` 查表优化
- `Integer.java:499-500` — DigitTens/DigitOnes 查表: 一次取两位数字(避免逐位除 10 的除法代价)
- 关键设计 (斜体): *parseInt 用"先乘后加 + 边界检测"而非先算出结果再判溢出——Java 无溢出检测指令(对比 C 的 UB),必须在运算前检查;toString 用查表把每次除法变成两次查表+减法*
- [C++: 内部卷 StringTable 的十进制转换同类技巧]

### 4. Long/Short/Byte/Boolean 缓存与 Number 抽象

场景: 面试追问——Long 也缓存吗?Boolean 呢?

- LongCache 同样 -128..127(`Long.java` 缓存类);ShortCache/ByteCache 同理;Boolean.TRUE/FALSE 单例
- `Number.java:55` — 抽象类,定义 intValue/longValue/floatValue/doubleValue 转换协议;byteValue/shortValue 是默认实现(intValue 截断)
- 关键设计 (斜体): *包装类缓存是"小整数常量池"的 Java 层实现——与域 01 String intern 同构(驻留思想);但字符串池在 JVM(堆),IntegerCache 在 Java 静态区*

---

### 核心悬念

包装类解决"基本类型不能进集合",但**浮点数连"精确相等"都做不到**——`0.1 + 0.2 == 0.3` 为什么是 false?钱要怎么算才不出错?下一篇: BigDecimal 的精确十进制。

> → [02-bigdecimal.md](02-bigdecimal.md)
