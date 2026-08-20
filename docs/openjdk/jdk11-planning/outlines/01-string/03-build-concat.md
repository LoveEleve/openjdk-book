# 03. 字符串构建与拼接 — StringBuilder 扩容、StringBuffer 同步、JEP 280

> 🔴 Deep | 域 01 字符串体系第 3 篇 | Layer 0
> 读者处境: 面试"StringBuilder 和 StringBuffer 区别"太初级,追问"默认容量多少?扩容怎么扩?"才是拉开差距的地方。

### 1. "StringBuilder 扩容一次扩多少？" — newCapacity 算法

场景: 循环 append 100 万次,JDK 是怎么避免频繁复制数组的?

- `AbstractStringBuilder.java:84` 构造 `AbstractStringBuilder(int capacity)` — 默认容量 16(`StringBuilder.java:103` `super(16)`)
- `AbstractStringBuilder.java:168` `ensureCapacityInternal` → `AbstractStringBuilder.java:197` `newCapacity`:
  - `AbstractStringBuilder.java:200` — `int newCapacity = (oldCapacity << 1) + 2;` — **×2 + 2**
  - 为什么 +2: 源码无官方注释;常见解释是 JDK 早期为字符串尾部留余量(NUL 结尾时期遗留),面试答"历史原因"即可
  - 溢出保护: 超过 `MAX_ARRAY_SIZE = Integer.MAX_VALUE - 8`(`AbstractStringBuilder.java:183`)时走 `hugeCapacity` 抛 OOME
  - `Arrays.copyOf` 复制旧数组 — 扩容成本 O(n),均摊 O(1)
- 关键设计 (斜体): *×2 是指数扩容——均摊复杂度 O(n)(每次复制都是前一次的两倍,几何级数);若固定 +16 每次,均摊 O(n²)。知道"扩容均摊"是加分项*
- 预分配: `ensureCapacity(min)`(`AbstractStringBuilder.java:155`)可提前扩容避免多次复制——生产上预估长度时用

### 2. "StringBuffer 怎么保证线程安全？" — 方法级锁 + toString 缓存

场景: 面试问 StringBuffer 为什么慢——慢在哪?

- `StringBuffer.java:203` 起 — 每个 public 方法都是 `public synchronized`
- `StringBuffer.java:120` `private transient String toStringCache;` — **toString 缓存**:
  - `StringBuffer.java:717` `public synchronized String toString()`: 首次生成 byte[] 表示并缓存,后续 `new String(toStringCache)` **共享缓存数组零拷贝**(String 构造直接引用数组)
  - 任何修改操作都会 `toStringCache = null`(`StringBuffer.java:237`)使缓存失效
- 关键设计 (斜体): *方法级 synchronized 粒度粗——append 链式调用每个方法都加锁;toString 缓存让"修改频繁+偶读"场景不必每次复制;但每次 toString 仍 new 一个新 String 对象(共享底层数组),避免调用方拿到内部数组引用*
- 继承关系: StringBuffer/Builder 都 extends AbstractStringBuilder——线程安全差异只在方法修饰符,核心逻辑同一份代码

### 3. "a+b+c 在 JDK11 里怎么编译？" — JEP 280 拼接策略

场景: `String s = "a" + "b" + "c";` 编译成什么?面试官想听的不再是 StringBuilder

- JDK8: javac 编译为 new StringBuilder().append("a").append("b").append("c").toString()
- JDK9+ (JEP 280): javac 生成 `invokedynamic` → `StringConcatFactory.makeConcat` 引导方法
- 策略(运行时按需选择): `StringConcatHelper.java:97` `mixLen(int)` 系列(57-158 重载)— 在 `prepend` 系列把各段从后往前写入预分配的 byte[](`StringConcatHelper.java` 后半部分),避免 StringBuilder 的多次扩容+toString 复制
- 常量折叠: 编译期常量(`"a"+"b"+"c"` 全是字面量)仍会在 javac 阶段直接折叠为一个字符串(常量池),**不经过任何运行时拼接**
- 关键设计 (斜体): *invokedynamic 把拼接策略推迟到运行时——JVM 升级可换实现而不改字节码;面试点: 字面量拼接零开销,变量拼接走 indy*
- [JEP 280: Indify String Concatenation — JDK9 动机: StringBuilder 方案每次拼接两次复制(扩容+toString),indy 方案直接写入目标数组]
- [内部卷: 07-classfile-classloader 03-symbol-string-table(常量池 CONSTANT_String 与字符串驻留);域 01 第 2 篇 intern 关联]
- 注意: String.join / StringJoiner(分隔符拼接)仍走显式 StringBuilder/Stream 路径(`String.java:2392` join 用 StringJoiner)

### 4. StringJoiner — 分隔符拼接的封装

场景: List<String> 转 "a,b,c" — JDK 提供的工具内部怎么工作?

- `StringJoiner.java:198` `add(CharSequence)` — 内部持有 StringBuilder + 分隔符
- 特性: 前缀/后缀/空值策略(`setEmptyValue`),`merge` 合并另一个 Joiner
- `String.java:2392` `String.join(delimiter, elements)` = 内部 new StringJoiner + add 循环
- 关键设计 (斜体): *StringJoiner 的价值在"只在元素间放分隔符"(不是分隔符+元素+分隔符)与空集合不输出分隔符——自己写循环容易错,这是标准库封装的意义*

---

### 核心悬念

拼接出来的字节,是从什么**字符编码**变来的?——"a" 存 1 字节,"中" 存 2 字节,那 `"中".getBytes()` 和 `new String(bytes)` 中间发生了什么?乱码问题从这里开始。

> → [04-encoding-unicode.md](04-encoding-unicode.md)
