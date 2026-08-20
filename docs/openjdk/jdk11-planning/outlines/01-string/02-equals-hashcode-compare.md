# 02. String 的相等、哈希与比较 — equals/hashCode/compareTo 逐行实现

> 🔴 Deep | 域 01 字符串体系第 2 篇 | Layer 0
> 读者处境: "== 和 equals 的区别"人人会背,但 equals 里为什么先比长度?hashCode 为什么用 31?这些代码细节才是面试区分点。

### 1. "两个 String 什么时候相等？" — equals 的实现顺序

场景: HashMap 里 get(key) 时,JDK 到底怎么判断 key 相等?

- `String.java:1002` `public boolean equals(Object anObject)`:
  1. 指针相等 `this == anObject` → 直接 true(短路,最快)
  2. `instanceof String` 类型检查(注意: 不是 getClass 比较——`instanceof` 允许子类,但 String 是 final 无子类,等价)
  3. 长度检查 `anObject.length() != length()` → false(比内容比对快,O(1))
  4. 分派 coder: 都是 LATIN1 → `StringLatin1.equals`;否则 → `StringUTF16.equals`(`String.java:1009`)
- `StringLatin1.java:93` — `equals(byte[] value, byte[] other)` 逐字节比较
- `StringUTF16.java:269` — equals 逐 16 位单元比较
- 关键设计 (斜体): *长度检查放在内容比较前——hashCode 相同不代表相等,但长度不同一定不相等;双路径分派避免对每个字符做 coder 判断,一次分支走到底*
- [C++: 内部卷 06-oops Symbol::equals 同样先比长度,同一惯例]

### 2. "为什么 hashCode 用 31？" — 缓存与乘数

场景: String 作 HashMap key——hashCode 每次都要算吗?

- `String.java:1501` `public int hashCode()`:
  - `String.java:156` `private int hash; // Default to 0` — 字段缓存
  - 首次调用才计算: `h = 31 * h + val[i]`(LATIN1 走 `StringLatin1.hashCode` / UTF16 走 `StringUTF16.hashCode`,`StringUTF16.java:346`)
  - 0 的歧义: hash 缓存初值 0 —— 若字符串 hash 恰好为 0,每次重算(可接受,概率低)
- 关键设计 (斜体): *乘 31 = (x << 5) - x,编译器优化为移位+减法;31 是奇素数——避免乘法溢出后信息丢失的分布问题;有效 32 位中的低 5 位受乘数低位影响,奇素数的低位包含更多信息*
- 缓存不可变假设: 只有 String 不可变才能安全缓存 hash——再次回到第 1 篇的结论

### 3. "字典序是怎么比的？" — compareTo 与排序

场景: TreeMap/Collections.sort 按字典序排字符串——实现是逐字符比吗?

- `String.java:1194` `public int compareTo(String anotherString)`:
  1. 按 coder 分派(`StringLatin1.compareTo` / `StringUTF16.compareTo`)
  2. 逐字符(逐字节)比较,返回第一个差异字符的差值
  3. 前缀相同 → 返回长度差
- `compareToIgnoreCase`(`String.java:1257`): 委托 `CASE_INSENSITIVE_ORDER.compare(this, str)`(CaseInsensitiveComparator,内部走 StringLatin1/StringUTF16 的 compareToCI,逐字符 case-fold)
- 关键设计 (斜体): *返回的是字符差值而非 0/±1——是给排序用的"全序"语义,不是布尔相等;equals 与 compareTo 的一致性(equals 为 true 则 compareTo 为 0)是 TreeMap 正确性的前提*
- `equalsIgnoreCase`(`String.java:1143`): 先比长度,再逐字符 case-fold

### 4. intern — 常量池的门

场景: "new String("a") == "a" 是 false,intern 之后呢?"— 面试必考

- `String.java:3127` `public native String intern()` — native 实现,查入 JVM 字符串常量池
- 语义: 池中有 → 返回池中引用;没有 → 加入池并返回(近似"单例"化)
- 生产应用: 极少数场景(大量重复字符串做 key)可省内存;但常量池在 JDK7+ 在堆中,滥用会导致永久代/堆膨胀
- 关键设计 (斜体): *面试"new String 创建几个对象"的标准答案必须区分字面量(编译期进常量池)与运行期 new;intern 的语义与常量池驻留机制详见内部卷 stringTable*
- [内部卷: 07-classfile-classloader 03-symbol-string-table(stringTable::intern 与符号驻留)]

---

### 核心悬念

equals/hashCode 保证 String 可以作为 key、可以驻留池中——但 String 是怎么**被创建**的?面试官接着问: `"a"+"b"+"c"` 在 JDK11 里到底创建了几个对象?是 StringBuilder 吗?JEP 280 改变了答案。

> → [03-build-concat.md](03-build-concat.md)
