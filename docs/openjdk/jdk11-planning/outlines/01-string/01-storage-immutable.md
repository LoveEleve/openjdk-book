# 01. 为什么 String 是不可变的？— 存储与不可变设计

> 🔴 Deep | 域 01 字符串体系第 1 篇 | Layer 0
> 读者处境: 每个面试官都问"String 为什么不可变",但没人讲过它内部到底怎么存、不可变是如何被 JVM 强制保证的。

### 1. "String 里到底存了什么？" — byte[] + coder 双字段

场景: 面试官问 String 的存储结构——JDK8 及之前是 char[],JDK9+ 为什么改了?

- `String.java:140` — `private final byte[] value;` — 从 JDK8 的 char[] 改成 byte[] 的核心动机: JEP 254 紧凑字符串(Compact Strings)
- `String.java:153` — `private final byte coder;` — 编码标记: LATIN1=0 / UTF16=1(`String.java:3269-3270`)
- 存储规则: 字符串内容全部是 ISO-8859-1 可表示字符 → 单字节存储(内存减半);否则 UTF-16 双字节
- 代价: 每次访问要判断 coder 分支 → 访问变慢,但内存省(典型应用字符串 80%+ 是 Latin-1)
- 关键设计 (斜体): *Java 用"空间换时间"的惯例在这里反转——用"时间换空间"。取舍依据是字符串在典型应用中占堆内存比例高,GC 压力是主要矛盾。*
- [C++: 内部卷 StringTable 中 Symbol 也用 UTF-8 紧凑存储,同一设计哲学]

### 2. "不可变是怎么保证的？" — final + 不暴露 + 不修改

场景: 面试"为什么 String 不可变"——答"因为有 final"会被追问:真的吗?

- `String.java:125` `public final class String` — 类不可继承
- `String.java:140` `private final byte[] value` — 数组引用不可变 + private 不暴露
- `String.java:153` `private final byte coder` — 编码标记
- 关键设计 (斜体): *真正不可变的保证是"数组对象本身不被修改"——String 的所有操作(substring/concat/replace)都返回新 String,从不 in-place 修改 value;arraycopy 创建副本(`String.java:1835` substring 用 `Arrays.copyOfRange`)*
- 不可变带来: ① hash 可缓存(见第 2 篇)② 常量池可共享 intern(见第 2 篇)③ 线程安全 ④ 安全场景(类名/URL 不被篡改)
- 关键设计 (斜体): *面试标准答案的四点: 缓存/共享/线程安全/安全——但要能说出对应代码位置才有区分度*
- [JVM Spec: §4.2 字符串常量池;内部卷 stringTable: intern 查入]

### 3. 构造与解码 — 字符串从哪来

场景: `new String(byte[], charset)` 乱码排查——字节是怎么变成字符的?

- `String.java:3252` 包私有构造 `String(byte[] value, byte coder)` — 所有构造的汇聚点
- 由 `StringCoding.decode` 完成字符集解码(详见第 4 篇)
- 关键设计 (斜体): *JDK11 的 String 构造不复制数组——`new String(char[])` 在 JDK8 就改成复制,但 `new String(byte[])` 相关内部构造允许共享数组(包内访问,外部拿不到数组引用),兼顾安全与性能*

---

### 核心悬念

**"String 不可变"是被依赖的基石,那它依赖什么?** — String 是 Map 的 key、常量池的条目、锁的载体——这一切都建立在 equals/hashCode 的正确性上。下一篇: 两个 String 怎么判断"相等"?`equals` 逐字符比还是先比 hash?

> → [02-equals-hashcode-compare.md](02-equals-hashcode-compare.md)
