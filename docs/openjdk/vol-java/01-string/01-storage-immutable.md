# 为什么 String 是不可变的？— 从共享风险到 JDK 11 存储边界

> 基于 JDK 11 `java.base` 的 `java.lang.String` 实现。本文讨论的是 HotSpot/JDK 11 当前实现，不把 `byte[] + coder` 当成 Java 语言规范要求。
> → **后续**: [String 的相等、哈希与比较](02-equals-hashcode-compare.md)
> 关联: 内部卷 07-classfile-classloader/03-symbol-string-table(字符串驻留)

## 先别回答“因为 final”

假设有一段代码：

```java
Map<String, Integer> map = new HashMap<>();
String key = new String("user");
map.put(key, 1);
```

如果 `key` 的内容后来能够变化，`HashMap` 会发生什么？它放入数据时按旧内容计算了桶位置，查找时却可能按新内容计算另一套哈希。对象还在，值却像“丢了”。

这不是 `HashMap` 的特殊问题。字符串常量池、类名、URL、协议字段、跨线程共享，都默认相信一件事：**一个 String 的值在发布后不会偷偷变化**。

所以真正的问题不是“String 有没有 `final`”，而是：

> JDK 如何保证外部输入不会继续污染 String，内部数组不会被改写，String 的变换不会破坏所有共享者？

本文的答案先给出来：

```text
外部 byte[]/char[]
        │ 复制或解码
        ▼
受控的 byte[] + coder
        │ private/final，不暴露数组
        ▼
substring/concat 等只返回新值
        │
        ▼
String 可以安全共享、缓存、驻留和跨线程读取
```

接下来每看一段源码，都只问一个问题：它在这条边界上承担什么责任？

## 一、最直觉的三个方案，为什么都不够

### 1. 让 String 可继承：值对象会失去统一语义

如果字符串类型可以被继承，子类就可能改变 `equals`、比较甚至内容访问的行为。调用方以为拿到的是稳定的值对象，实际拿到的却可能是带有不同规则的对象。

JDK 11 直接把这条路堵上了：

```java
// String.java:125-126(截取,逐字)
public final class String
    implements java.io.Serializable, Comparable<String>, CharSequence {
```

`final class` 不是 String 不可变的全部原因，但它先保证了：**String 的行为不能通过子类替换**。

### 2. 只把数组引用声明为 final：数组内容仍然能变

下面这个判断是错的：

```text
final byte[] value  ⇒  byte[] 内容不可变
```

`final` 只限制 `value` 这个引用不能指向另一块数组，并不禁止 `value[0] = ...`。因此 String 还必须满足第二个条件：内部数组不能被外部拿到，也不能被自身的公开操作原地修改。

### 3. 直接保存调用方传入的数组：外部修改会穿透边界

如果 `new String(char[])` 直接保存调用方数组，调用方只要继续修改原数组，String 的内容就会跟着变。于是构造方法必须在“不可信输入”和“内部存储”之间建立隔离：外部数组复制，外部字节按 charset 解码，只有内部已经受控的数组才允许走共享路径。

到这里可以先收网一次：String 的不可变不是一个关键字单独完成的，而是**类边界、字段边界、数组边界和操作边界**共同完成的。

## 二、JDK 11 的 String 到底存什么

### 1. `char[]` 为什么变成 `byte[] + coder`

JDK 8 及以前的典型 String 存储模型是 `char[]`。JDK 9 引入 Compact Strings 后，JDK 11 的核心存储变成两个字段：

```java
// String.java:140-153(截取,逐字)
    private final byte[] value;

    /** The identifier of the encoding used to encode the bytes in {@code value}. */
    private final byte coder;
```

`value` 是存储本体，`coder` 告诉 String 应该用哪条解释路径读取这组字节。两个编码标志在源码中是：

```java
// String.java:3269-3270(截取,逐字)
    @Native static final byte LATIN1 = 0;
    @Native static final byte UTF16  = 1;
```

于是存储策略变成：

- 内容全部能用 Latin-1 表示：使用单字节数组，`coder = LATIN1`。
- 内容需要更宽的字符表示：使用 UTF-16 路径，`coder = UTF16`。

这是一笔明确的交易：访问路径多了编码分支，数组却可能缩小一半。注意这里优化的是**内部表示**，不是把 Java 的字符语义改成“字节语义”。调用者仍然看到字符、长度和 Unicode 行为，只有 String 内部根据 `coder` 选择读取算法。

### 2. Compact Strings 不是不可变性的来源

`byte[] + coder` 解决的是“怎么省空间”，不可变边界解决的是“谁能修改它”。这两个问题不能混为一谈：

```text
Compact Strings：减少 value 的空间
不可变设计：阻止 value 的内容被污染
```

如果 `value` 是 `char[]`，它也可以不可变；如果 `value` 是 `byte[]`，它也可能被错误地共享而变得可变。JDK 11 的设计是把两件事叠在一起：用紧凑编码存储，同时严格控制数组生命周期。

## 三、不可变的四层防线

### 第一层：类不能被替换

`String` 是 final 类，子类无法改写它的核心行为。这个防线解决的是“行为一致性”，还没有解决数组内容问题。

### 第二层：字段不能被外部直接拿到

```java
// String.java:140-153(字段证据)
    private final byte[] value;
    private final byte coder;
```

`private` 让普通调用者拿不到内部数组，`final` 让 String 自己不能把 `value` 引用换成另一块数组。这里仍然要强调：数组元素是否改变，还要看所有内部方法是否遵守“不原地修改”的约束。

### 第三层：变换操作返回新值

看 `substring`。它有一个容易被忽视的快路径：从下标 0 开始取整个剩余内容时，可以直接返回当前对象；真正截取一段内容时，则走 Latin-1/UTF-16 对应的创建路径。

```java
// String.java:1835-1846(截取,逐字)
    public String substring(int beginIndex) {
        if (beginIndex < 0) {
            throw new StringIndexOutOfBoundsException(beginIndex);
        }
        int subLen = length() - beginIndex;
        if (subLen < 0) {
            throw new StringIndexOutOfBoundsException(subLen);
        }
        if (beginIndex == 0) {
            return this;
        }
        return isLatin1() ? StringLatin1.newString(value, beginIndex, subLen)
                          : StringUTF16.newString(value, beginIndex, subLen);
    }
```

这段代码证明了两个判断：

1. 结果与当前 String 完全相同，可以直接复用 `this`。
2. 结果是原内容的子集时，交给编码专用实现创建新值，而不是修改原数组。

以 Latin-1 路径为例：

```java
// StringLatin1.java:714-716(截取,逐字)
    public static String newString(byte[] val, int index, int len) {
        return new String(Arrays.copyOfRange(val, index, index + len), LATIN1);
    }
```

`Arrays.copyOfRange` 建立了新的数组。原 String 的 `value` 没有被改写，原 String 的其他共享者也不会看到变化。

这也解释了一个历史变化：早期 JDK（典型如 JDK 6 及 JDK 7 的早期更新）里的 substring 曾经共享底层大数组，小字符串可能长期拖住一整块巨大数组；后来的实现改成复制有效区间，用复制成本换取更可控的内存保留行为。这个历史差异不能拿来解释 JDK 11 当前路径。

### 第四层：共享只发生在可信内部路径

String 的包私有构造器允许内部实现把已经可信的数组直接接进来：

```java
// String.java:3252-3255(截取,逐字)
    String(byte[] value, byte coder) {
        this.value = value;
        this.coder = coder;
    }
```

它没有复制数组，但这是包内实现之间的约定：调用者必须保证数组之后不会被修改，外部代码也拿不到这个包私有入口。这个构造器不能被拿来证明“String 构造都不复制”，恰恰相反，它证明了 JDK 把**可信内部数组**和**不可信外部数组**分开处理。

## 四、外部输入怎样进入 String

### 1. 已经是 String：可以共享

`new String(String original)`(`String.java:235`) 的实现直接复用 `original.value/coder/hash`。由于原对象本身已经遵守不可变边界，内部实现可以共享受控数组，而不需要担心调用方通过原对象修改它。

### 2. 字节数组：先解码，再选择存储格式

带 charset 的字节输入会进入 StringCoding 解码链。JDK 11 的多个构造路径最终分别调用 `StringCoding.decode`，例如：

- `String.java:467`：按 charset 名称解码
- `String.java:507`：按 Charset 解码
- `String.java:592`：字节数组到内部结果的解码路径

心智图是：

```text
外部 byte[]
   → CharsetDecoder/StringCoding
   → 得到字符内容与编码结果
   → 选择 LATIN1 或 UTF16
   → 放入受控 value + coder
```

这条链把“外部字节如何解释”和“内部如何压缩存储”连接起来。编码错了，得到的是错误内容；存储 coder 错了，得到的则是错误的内部解释。两层都必须正确。

### 3. 外部 char[]：不能直接借用

外部数组可能在构造完成后继续被调用方修改，所以公开构造路径必须把它转换为自己的内部表示。String 的不可变性不是对调用者的善意假设，而是通过复制/解码把风险挡在构造边界之外。

这也是为什么“外部数组”和“内部可信数组”不能混为一谈：公开构造要防御性复制，包内构造(`String.java:3252`)才允许共享。

## 五、不可变性为什么值得复制成本

回到开头的 HashMap key。现在可以完整回答了：

```text
String 类不能被子类替换
        ↓
value/coder 是 private final
        ↓
外部输入先复制或解码
        ↓
substring/concat 等不原地改数组
        ↓
内容发布后可安全缓存、共享和比较
```

由此得到四个直接收益：

1. **哈希缓存可靠**：内容不变，缓存过的 hash 不会与内容脱节；`String.java:156` 的 `hash` 字段正是下篇要展开的入口。
2. **共享可靠**：常量池驻留和 String 复用不必担心某个调用者改掉共享对象。
3. **跨线程读取可靠**：只读对象不需要为每次访问加同步。
4. **安全边界可靠**：类名、URL、路径、协议字段等被检查后不会被中途改写。

这里最后再澄清四个误解：

- `final byte[]` 不等于数组内容不可变。
- `byte[] + coder` 是 JDK 11 的存储实现，不是 Java 规范要求的唯一布局。
- String 的所有构造不都复制数组；包内可信路径可以共享，外部输入必须隔离。
- substring 不总是复制；`beginIndex == 0` 时可以直接返回当前对象，其余截取路径创建新值。

## 收网

String 能成为 Map key、常量池条目和跨线程共享值，不是因为它“天生特殊”，而是因为它把可变性挡在了对象边界之外：外部数据进入时被复制或解码，内部数组不向外暴露，公开变换返回新值，编码压缩也不改变值语义。

下一篇继续追问：**如果两个 String 的内容不变，JDK 又怎样判断它们相等、计算 hash，并让它们在 Map 中正确工作？**