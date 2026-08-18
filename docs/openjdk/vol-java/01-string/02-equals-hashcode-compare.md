# 02. String 的相等、哈希与比较 — equals/hashCode/compareTo 逐行实现

> **前置依赖**: [01-string/01 — 为什么 String 是不可变的?](01-storage-immutable.md):不可变是 hash 缓存的前提(本篇第 2 节直接用到)
> → **后续**:[01-string/03 — 字符串构建与拼接(JEP 280)](03-build-concat.md)
> 关联: 内部卷 06-oops(Symbol::equals 同款惯例)、07-classfile-classloader 03-symbol-string-table

## 面试题人人会背,代码没人看过

"`==` 和 `equals` 的区别""hashCode 为什么用 31"——这两道题的答案你在任何面试指南里都背过。但背答案和读源码之间隔着一层:equals 里**为什么先比长度**?hashCode 的缓存字段**存哪**?compareTo 返回的**为什么是差值不是 0/1**?这些细节才是面试官追问下去的地方。

这篇把 `String.java` 里三个最常被问到的方法逐行拆开,顺带把 intern 和常量池的关系讲清楚。

## 1. equals: 四个检查的顺序

`String.java:1002` 的 `equals`,逐字看:

```java
// String.java:1002-1011(截取核心,逐字)
public boolean equals(Object anObject) {
    if (this == anObject) {                       // ① 指针相等,直接 true
        return true;
    }
    if (anObject instanceof String) {             // ② 类型检查
        String aString = (String)anObject;
        if (coder() == aString.coder()) {         // ③ coder 相同才可能相等
            return isLatin1() ? StringLatin1.equals(value, aString.value)
                              : StringUTF16.equals(value, aString.value);
        }
    }
    return false;
}
```

这个实现和"先比长度"的说法对不上——**coder 判断取代了显式长度检查**(coder 相同才可能相等)。真正的长度检查在双路径里:`StringLatin1.equals`(`StringLatin1.java:93`):

```java
// StringLatin1.java:93-100(截取核心,逐字)
public static boolean equals(byte[] value, byte[] other) {
    if (value.length == other.length) {           // 长度不同直接 false
        for (int i = 0; i < value.length; i++) {
            if (value[i] != other[i]) {
                return false;
            }
        }
        return true;
    }
    return false;
}
```

`StringUTF16.equals`(`StringUTF16.java:269`)是同样的骨架,只是按 16 位单元比较。

把四个检查按顺序列出来:

1. **指针相等**(`this == anObject`)——同一个对象,内容必然相同,最快的短路
2. **类型检查**(`instanceof String`)——注意不是 `getClass()` 比较:instanceof 允许子类,但 String 是 final 类没有子类,两者在这里等价
3. **coder 检查**(JDK11 新引入)——coder 不同(一个 LATIN1 一个 UTF16)必然不相等
4. **逐字节/逐单元比较**——循环里遇到第一个不同即返回 false

关键设计(斜体):*"先做能快速失败的检查,再做逐内容比较"——指针(1 次操作)> 类型(1 次)> coder(1 次)> 长度(1 次)> 内容(最慢)。长度检查放在内容比较前: hash 相同不代表相等,但长度不同一定不相等——用 O(1) 的检查过滤掉大部分不相等的字符串。JDK11 把长度检查挪进双路径,是因为 coder 判断比长度判断信息量更大(还隐含了后续走哪条路径)。*

跨层标注: [C++: 内部卷 06-oops Symbol::equals 同样先比长度——JVM 内部字符串也是同一惯例]

## 2. hashCode: 为什么是 31,以及缓存放哪

`String.java:1501`:

```java
// String.java:1501-1507(截取核心,逐字)
public int hashCode() {
    int h = hash;
    if (h == 0 && value.length > 0) {
        hash = h = isLatin1() ? StringLatin1.hashCode(value)
                              : StringUTF16.hashCode(value);
    }
    return h;
}
```

缓存字段(`String.java:156`):

```java
// String.java:156
private int hash; // Default to 0
```

**缓存逻辑**:第一次调用才计算,算完存回 `hash` 字段,后续直接返回。两个细节:

- **空串不缓存**:`value.length > 0` 条件——空串 hash 恒为 0,没必要算
- **hash 恰好为 0 的串**:每次进来 `h == 0` 都会重算一次——可接受,hash 为 0 的字符串极罕见

计算本身(`StringUTF16.java:346` 的 `hashCode`):

```java
// StringUTF16.java:346-360(截取核心,逐字)
public static int hashCode(byte[] value) {
    int h = 0;
    int length = value.length >> 1;
    for (int i = 0; i < length; i++) {
        h = 31 * h + getChar(value, i);
    }
    return h;
}
```

**`h = 31 * h + val[i]`**——这就是面试题"为什么用 31"的代码位置。两个理由:

1. **31 = 32 - 1 = (x << 5) - x**:编译器把它优化成移位+减法,比乘法快
2. **31 是奇素数**:乘法哈希的经典选择——奇素数乘数在溢出时低位信息保留得更好,冲突分布更均匀(偶乘数会把信息"洗掉")

关键设计(斜体):*乘 31 的完整答案有两层: 性能(移位优化)和分布(奇素数)。面试说"因为 31 是奇素数"只对了一半。而缓存机制依赖一个前提——**String 不可变**。hash 算一次存起来永远有效,因为内容不会变。这就是第 1 篇"不可变"最直接的回报: HashMap 拿 String 当 key 时,hash 只算一次。*

## 3. compareTo: 字典序与全序

`String.java:1194`:

```java
// String.java:1194-1197(截取核心)
public int compareTo(String anotherString) {
    byte v1[] = value;
    byte v2[] = anotherString.value;
    byte coder = coder();
    if (coder == anotherString.coder()) {
        return coder == LATIN1 ? StringLatin1.compareTo(v1, v2)
                               : StringUTF16.compareTo(v1, v2);
    }
    return coder == LATIN1 ? StringLatin1.compareToUTF16(v1, v2)
                           : StringUTF16.compareToLatin1(v1, v2);
}
```

字典序的实现(`StringLatin1.compareTo`,`StringLatin1.java:106` 包装 → 112 核心):

```java
// StringLatin1.java:106-123(截取核心,逐字)
public static int compareTo(byte[] value, byte[] other) {
    int len1 = value.length;
    int len2 = other.length;
    return compareTo(value, other, len1, len2);
}

public static int compareTo(byte[] value, byte[] other, int len1, int len2) {
    int lim = Math.min(len1, len2);
    for (int k = 0; k < lim; k++) {
        if (value[k] != other[k]) {
            return getChar(value, k) - getChar(other, k);
        }
    }
    return len1 - len2;
}
```

两个关键语义:

1. **返回的是差值**:第一个不同字符的 char 差值(不是 0/1/-1)。这个值是给排序用的——`Collections.sort` 靠它判断任意两个字符串的顺序
2. **前缀相同返回长度差**:`"abc"` 与 `"abcd"` 比较,循环走完没差异,返回 3-4 = -1

这保证了 **equals 与 compareTo 的一致性**:equals 为 true 时 compareTo 必为 0。这是 TreeMap/TreeSet(按键排序的容器)正确性的前提——它们内部只依赖 compareTo,如果 compareTo 说"相等"而 equals 说"不等",容器就乱套了。

`equalsIgnoreCase`(`String.java:1143`)先比长度再逐字符 case-fold;`compareToIgnoreCase`(`String.java:1257`)委托 `CASE_INSENSITIVE_ORDER.compare`——一个静态比较器实例,内部走 `compareToCI`(同样先比长度再大小写折叠)。

关键设计(斜体):*compareTo 返回"差值"而非"布尔"——它是全序比较器,不是相等判断。面试能说出"返回值用于排序、equals 与 compareTo 必须一致"两层,比背"字典序"三个字有区分度。*

## 4. intern: 常量池的门

`String.java:3127`:

```java
// String.java:3127
public native String intern();
```

native 实现,查入 JVM 的字符串常量池。语义一句话:**池里有就返回池里的引用,没有就放进去再返回**——近似"字符串单例化"。

经典面试题"`new String("a") == "a"` 是 false,intern 之后呢":

```java
String s1 = new String("a");   // 运行期 new 的,新的对象
String s2 = "a";                // 字面量,编译期进常量池
s1 == s2;                       // false: 两个对象
s1.intern() == s2;              // true: intern 返回池里的那个 "a"
```

要区分两条路:

- **字面量**(`"a"`):javac 编译时把字符串塞进 class 文件常量池,类加载时驻留进 JVM 字符串池
- **运行期 new**(`new String("a")`):堆上新对象,不进池

生产上的应用场景很窄:极少数"大量重复字符串"场景用 intern 省内存。但注意——JDK7 之后常量池在堆里,滥用 intern 会导致堆膨胀,不是免费的。

关键设计(斜体):*面试"new String 创建几个对象"的标准答案必须分情况: 字面量 `"a"` 是编译期进池(0 个运行期对象),`new String("a")` 至少创建 1 个堆对象(可能 2 个,如果字面量还在)。intern 的驻留机制在 VM 侧,Java 侧只是把动作暴露出来。*

跨层标注: [内部卷: 07-classfile-classloader 03-symbol-string-table(stringTable::intern 与符号驻留)]

## 核心悬念

equals/hashCode 保证 String 能当 key、能驻留池子——那 String 是怎么**被创建**的?面试官爱问的下一题是:`String s = "a" + "b" + "c";` 在 JDK11 里创建了几个对象?还是 JDK8 那个"编译成 StringBuilder"的答案吗?——JEP 280 已经把答案改写了。

> → [01-string/03 — 字符串构建与拼接](03-build-concat.md)
