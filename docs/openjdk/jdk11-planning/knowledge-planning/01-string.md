# 域 01: 字符串体系 — 知识规划

> 源码路径: java.base/share/classes/java/lang/{String,StringBuilder,StringBuffer,AbstractStringBuilder,StringJoiner,StringCoding,StringUTF16,StringLatin1,Character,CharSequence,StringConcatHelper}.java + java/lang/invoke/StringConcatFactory.java
> 源码量: 14 文件 / ~21,000 行 | 非巨型域
> 写作层: Layer 0(无前置,一切的地基)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| String.java (3347 行) | **String 存储与不可变**: `byte[] value` + `byte coder`(String.java:140-141),紧凑字符串存储(ISO-8859-1 vs UTF-16 双路径),final 类 + final 数组 → 不可变设计 | High |
| String.java | **hash 缓存**: `private int hash`(String.java:156),首次 hashCode() 计算后缓存,后续 O(1) 返回 — 配合 HashMap 性能 | High |
| String.java | **equals 实现**: `public boolean equals`(String.java:1002) — 先指针比较→类型检查→长度检查→逐字符比较;`equalsIgnoreCase`(1143) | High |
| String.java | **compareTo**: 字典序(1194),与 equals 不同(不要求内容完全相同),排序语义 | High |
| String.java | **intern**: native 方法(3310 附近),字符串常量池查入,面试常量池重头 | High |
| String.java | **substring**: JDK7+ 复制新数组(不再共享 char[]),O(n) — 内存泄漏问题已解决 | Medium |
| String.java | **split/join**: 正则 split + String.join(join 用 StringJoiner) | Medium |
| String.java | **valueOf/format**: 静态工厂 + Formatter 委托 | Medium |
| AbstractStringBuilder.java (1728 行) | **动态扩容**: `ensureCapacityInternal`(约 240 行),`newCapacity` 算法 — 老容量 ×2 + 2,溢出保护 | High |
| StringBuilder.java (495) | **StringBuilder 非同步**: 直接继承 AbstractStringBuilder,无 synchronized — 单线程最优 | High |
| StringBuffer.java (783) | **StringBuffer 同步**: 所有方法 synchronized(方法级锁),toString 有缓存机制 | High |
| StringCoding.java (1154) | **字符集编解码**: decode/encode,处理 ISO-8859-1/US-ASCII/UTF-8/UTF-16,默认 charset 探测;JDK11 新增 UTF-8 快路径 | High |
| StringUTF16.java (1485) | **UTF-16 存储路径**: getChar/putChar 字节序处理,与 byte[] 低层交互,decodeUTF16/compress | High |
| StringLatin1.java (793) | **Latin-1 存储路径**: 单字节快速路径,equals/hashCode/compareTo 的紧凑版 | High |
| StringJoiner.java | **拼接器**: 分隔符/前缀/后缀,merge(内部用 Stream 支持),配合 String.join | Medium |
| Character.java (10715) | **Unicode 支持**: codePoint/surrogate 代理对处理,isLetter/isDigit 分类(经 CharacterData 查表),getType | Medium |
| CharacterData.java (100) | **Unicode 数据查表**: 单例 + getProperties(数据类,Table 由 generate 工具生成) | Low |
| StringConcatHelper.java (359) | **拼接辅助**: prepend 系列方法,直接写 byte[],避免中间 String | Low |
| StringConcatFactory.java (invoke,约 900) | **JEP 280 拼接策略**: 编译期常量折叠→StringBuilder→StringConcat.makeConcat 动态调用 | Low |

*20 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | String 存储/不可变/hash/equals/compareTo | 6 (String/UTF16/Latin1/CharSequence/Character/CharacterData) | 核心行为,面试主战场 |
| P1 | 构建器(扩容/sync) | 3 (AbstractStringBuilder/StringBuilder/StringBuffer) | 面试高频"三者的区别" |
| P2 | 编解码 | 3 (StringCoding/UTF16/Latin1) | 字符集处理,生产乱码问题 |
| P2 | 拼接优化 | 2 (StringConcatHelper/Factory) | JEP 280,面试偶尔 |
| P2 | 拼接工具 | 1 (StringJoiner) | join 实现 |
| P3 | Unicode 细节 | 2 (Character/CharacterData) | 面试低频,查表实现 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | String 不可变与存储(byte[]+coder) | 面试必考"为什么 String 不可变";紧凑字符串是 JDK9+ 内存优化的关键;框架(缓存 key、常量池)处处依赖 |
| 🔴 Deep | equals/hashCode/compareTo 语义 | 面试必考(String 作为 Map key 的前提);equals 与 == 区别 |
| 🔴 Deep | intern 与常量池 | 面试必考(new String vs 字面量);JVM 调优/字符串驻留 |
| 🔴 Deep | StringBuilder/StringBuffer 扩容 | 面试常问扩容机制、初始容量(16)、两者区别 |
| 🟡 Working | 紧凑字符串双路径 | 理解 StringUTF16/Latin1 分工;面试偶尔问"JDK9 String 内存优化" |
| 🟡 Working | StringCoding 编解码 | 生产乱码排查;默认字符集探测流程 |
| 🟡 Working | StringJoiner/join | 使用层为主 |
| 🟢 Surface | Character Unicode 查表 | 面试低频;数据驱动,无设计逻辑 |
| 🟢 Surface | StringConcatFactory 策略 | 实现细节,面试几乎不问 |

## 04 聚类

### 依赖图(域内)
```
String(存储/不可变) ─┬─→ equals/hashCode/compareTo(语义)
                     ├─→ intern(常量池)
                     └─→ substring/split/join(视图与分割)
StringUTF16 + StringLatin1(双路径实现) ←── String 的每个操作委托
AbstractStringBuilder(扩容) ←── StringBuilder(非同步) / StringBuffer(同步)
StringCoding(编解码) ←── String(构造/getBytes)
Character/CharacterData(Unicode) ←── 独立支撑(编码单元/码点概念)
```

### 教学顺序与文章拆分(4 篇)

1. **String 的存储与不可变性** — byte[]+coder、final、常量池入口、为什么不可变
2. **String 的相等、哈希与比较** — equals/hashCode/compareTo 的逐行实现、String 作 Map key
3. **字符串构建与拼接** — AbstractStringBuilder 扩容算法、StringBuilder vs StringBuffer、StringJoiner/join、concat 优化
4. **字符编码与 Unicode** — StringCoding 编解码流程、UTF-16/Latin-1 双路径、Character codePoint

> 下一篇(域 06 异常)前先读:无前置。跨层: intern 涉及内部卷 stringTable;编码涉及内部卷 07 符号表
