# String 的相等、哈希与比较 — 一个值如何成为可靠的容器键

> 基于 JDK 11 `java.base` 的 `String`、`StringLatin1`、`StringUTF16` 实现。
> **前置依赖**: [String 为什么不可变](01-storage-immutable.md)(内容稳定是 hash 缓存的前提)
> → **后续**: [字符串构建与拼接](03-build-concat.md)
> 关联: 内部卷 07-classfile-classloader/03-symbol-string-table(字符串驻留)

## 先看两个事故

### 事故一：HashMap 里的 key“消失”

如果一个 key 放入 Map 后内容还能变化，Map 放入时按旧内容定位桶，查找时按新内容计算哈希。对象明明还在，查找却可能再也找不到它。

### 事故二：TreeMap 的顺序不可信

如果排序比较器把两个值说成“相等”，但等值判断又说它们“不相等”，有序容器的查找和去重语义就会出现裂缝。

所以 String 的比较体系不能只回答“两个对象是不是同一个引用”。它必须同时提供：

```text
稳定内容
  ├─ equals      → 值是否相同
  ├─ hashCode    → 哈希容器如何定位
  ├─ compareTo   → 有序容器如何排序
  └─ intern      → JVM 是否复用池中引用
```

接下来每个 API 都围绕这张图展开。

## 一、equals：先拒绝不可能，再比较内容

最简单的错误方案是直接使用 `==`。它只比较对象身份：两个内容完全相同、但分别创建出来的 String，也会被判定为不相等。String 必须改问“内容是否相同”。

### 1. JDK 11 的入口顺序

```java
// String.java:1002-1011(截取核心,逐字)
    public boolean equals(Object anObject) {
        if (this == anObject) {
            return true;
        }
        if (anObject instanceof String) {
            String aString = (String)anObject;
            if (coder() == aString.coder()) {
                return isLatin1() ? StringLatin1.equals(value, aString.value)
                                  : StringUTF16.equals(value, aString.value);
            }
        }
        return false;
    }
```

这段代码的主线不是“逐字符比较”，而是先用便宜条件排除不可能：

1. `this == anObject`：同一个对象，直接成功。
2. `instanceof String`：不是 String，直接失败。
3. `coder()` 不同：JDK 11 的两个内部编码路径不同，不可能走同一条内容比较。
4. coder 相同：进入对应的 Latin-1 或 UTF-16 专用实现。

### 2. 长度检查为什么在专用实现里

旧稿容易把“equals 先比长度”说得过于简单。JDK 11 的 `String.equals` 主体没有单独写 `length()` 判断；长度检查被下沉到了编码专用路径。

Latin-1 路径的实现是：

```java
// StringLatin1.java:93-100(截取核心,逐字)
    public static boolean equals(byte[] value, byte[] other) {
        if (value.length == other.length) {
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

长度不同一定不相等，因此先做 O(1) 长度判断，再进入逐字节比较。UTF-16 路径采用同样的结构，只是按 16 位字符单元解释数组。

这里有一个重要的边界：**hash 相同不代表 equals 相同**。哈希只是定位和分桶的快速摘要，最终是否相等仍然要靠内容比较。

关键设计(斜体):*equals 的顺序体现“先便宜失败,再昂贵比较”：身份、类型、coder、长度，最后才逐内容检查。coder 分派还能让一次判断决定后续整条路径。*

## 二、hashCode：为什么能缓存，31 又是什么

### 1. 只比较 hash 也会失败

第二个直觉方案是：既然 hashCode 快，那就只比较 hash。问题在于不同字符串可以产生相同哈希，碰撞是哈希容器必须允许的情况。正确流程是：先用 hash 定位候选桶，再用 equals 做最终确认。

### 2. 缓存建立在不可变之上

String 的 hash 缓存字段在 `String.java:156`：

```java
// String.java:156
    private int hash; // Default to 0
```

计算入口是：

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

第一次调用时计算并写回 `hash`，之后直接返回缓存。这个设计只有在 String 内容不会变化时才安全：如果 String 可变，缓存就可能对应旧内容，Map 的定位会随之失效。

空字符串的 hash 本来就是 0，因此 `value.length > 0` 让它不必写缓存。非空字符串如果恰好算出 0，后续调用仍可能重复计算；这是用极少数重复计算换取简单状态表示的取舍。

### 3. 31 不是魔法数字

递推式落在编码专用 hash 实现中：Latin1 路径位于 `StringLatin1.java:193`,UTF16 路径位于 `StringUTF16.java:346`;两条路径都体现同一个公式：

```text
h = 31 * h + 当前字符
```

31 的常见解释有两层：

- 算术上 `31 * h = (h << 5) - h`，具备移位/减法优化空间。
- 31 是奇数素数，作为乘数有较好的混合特性。

第二点是算法分析，不是“JDK 保证 31 一定最优”。String 需要的是一个稳定、简单、分布可接受的 32 位递推哈希，而不是密码学哈希。

关键设计(斜体):*hashCode 的真正设计点不是“31 这个答案”,而是“不可变内容 + 一次计算缓存 + equals 做最终确认”。31 只是这条递推哈希的乘数选择。*

## 三、compareTo：排序需要全序，不是相等布尔值

### 1. 比较不能只返回“相等/不相等”

排序需要知道谁在前、谁在后。只返回布尔值无法表达三种关系；只返回 `-1/0/1`虽然满足很多比较器的符号语义，但实现可以直接返回第一个差异字符的差值。

String 的入口是：

```java
// String.java:1194-1203(截取核心,逐字)
    public int compareTo(String anotherString) {
        byte v1[] = value;
        byte v2[] = anotherString.value;
        if (coder() == anotherString.coder()) {
            return isLatin1() ? StringLatin1.compareTo(v1, v2)
                              : StringUTF16.compareTo(v1, v2);
        }
        return isLatin1() ? StringLatin1.compareToUTF16(v1, v2)
                          : StringUTF16.compareToLatin1(v1, v2);
    }
```

它先按 coder 选择同编码或跨编码路径，然后由专用实现逐个字符比较：遇到第一个差异就返回字符差值；如果一方只是另一方的前缀，就返回长度差。

在同一编码路径的直观例子中：

- `"abc"` 小于 `"abd"`，因为第一个差异字符决定结果为负。
- `"abc"` 小于 `"abcd"`，因为前缀相同，长度更短。
- 返回值的重点是负/零/正的顺序语义，不应把它当作精确距离；跨 Latin1/UTF16 时由专用跨编码实现完成比较。

### 2. equals 与 compareTo 的边界

对 String 来说，如果 `equals` 为 true，`compareTo` 必须返回 0。这个一致性让 String 可以同时作为 HashMap 的 key 与 TreeMap 的排序键。

但不能把这个结论泛化成“所有 Comparable 类型的 compareTo 都必须与 equals 完全一致”；那是具体类型的契约设计问题。

`equalsIgnoreCase(:1143)`与 `compareToIgnoreCase(:1257)`是另一组语义：它们做大小写折叠，不等同于普通 equals/compareTo，也不自动纳入 locale 规则。

关键设计(斜体):*compareTo 返回差值不是为了表达“差了多少”,而是为了提供有序关系。面试"compareTo 为什么不是 0/1": Comparable 关心负/零/正,实现可以返回更具体的差值。*

## 四、intern：值相等如何变成引用共享

### 1. `==` 与池引用

`intern` 是 String 进入 JVM 字符串池的 native 门：

```java
// String.java:3127(截取,逐字)
    public native String intern();
```

它的语义是：池中已有相同值，就返回池中引用；没有则把当前值纳入池并返回池引用。

因此：

```java
String s1 = new String("a");
String s2 = "a";

s1 == s2;          // false：s1 是新的堆对象
s1.intern() == s2; // true：返回池中的引用
```

这里必须区分：

- `equals` 比较值。
- `==` 比较引用。
- `intern` 把值连接到 JVM 池中的引用共享机制。

### 2. 为什么不能把所有字符串都 intern

intern 不是免费的去重开关。大量动态字符串全部进入池，会增加池与堆的管理压力；只有在重复率高、生命周期和收益可控的场景下才值得评估。

关键设计(斜体):*intern 是“稳定值 → 共享引用”的桥,不是 equals 的替代品。只有使用 `intern()` 的返回值，调用方才拿到了池引用。*

## 收网：四个 API 如何协作

现在回到开头的两个事故：

- HashMap 先用 `hashCode` 找候选位置，再用 `equals` 确认值；String 不可变让 hash 缓存不会过期。
- TreeMap 用 `compareTo` 建立顺序；String 的全序比较让前缀、coder 和内容差异都能落到负/零/正关系。
- 常量池与字符串池通过 `intern` 复用稳定值的引用。

所以这四个 API 不是四张孤立的知识卡片：

```text
不可变内容
   ├─ equals      → 值相等
   ├─ hashCode    → 哈希定位
   ├─ compareTo   → 全序排序
   └─ intern      → 池引用共享
```

下一篇继续追问：字符串是怎么构建和拼接的？`"a" + "b" + "c"` 在 JDK 11 中为什么不该再用 JDK 8 的 `StringBuilder` 答案解释。