# 01. 为什么 String 是不可变的?— 存储结构、不可变保证、构造链

> **前置依赖**: 无(本卷开篇第一篇,直接从源码看起)
> → **后续**:[01-string/02 — equals/hashCode/compareTo 逐行实现](02-equals-hashcode-compare.md)
> 关联: 内部卷 07-classfile-classloader 03-symbol-string-table(stringTable 与字符串驻留)

## 从"面试必背"到"源码依据"

"String 为什么不可变"是每个 Java 面试的开场题,标准答案背得出四件事:缓存、共享、线程安全、安全。但被追问"不可变到底怎么保证的?JDK9 之后它内部存的是什么?"时,大多数人就停在"因为有 final"上了。

这篇从 `String.java` 的字段开始,把"存储结构 → 不可变保证 → 构造与解码"拆开讲。你会发现"不可变"不是一个 final 关键字,而是一整套设计:字段布局、操作语义、包私有构造的共享数组——每一层都在回答"为什么能安全地把 String 当值用"。

## 1. String 里到底存了什么

### byte[] + coder 双字段

先看 JDK11 里 String 的两个核心字段(`String.java:140` 起,逐字):

```java
// String.java:140-153(截取核心)
private final byte[] value;    // 存储本体
private final byte coder;      // 编码标记: LATIN1=0 / UTF16=1
```

JDK8 及之前,String 存的是 `char[]`——每个字符两个字节,哪怕内容全是一个字节就够的 ASCII。JDK9 的 JEP 254(Compact Strings)把它改成 `byte[]` + `coder`:

- **coder = LATIN1(0)**: 字符串里所有字符都是 ISO-8859-1 可表示的(典型的英文/数字/常见符号)——**每字符 1 字节**,内存减半
- **coder = UTF16(1)**: 出现了需要双字节的字符——回到每字符 2 字节

代价是每次操作都要判断 coder 分支(取 `value[0]` 到底是 1 字节还是 2 字节?),换来的是典型应用里字符串占堆内存的比例——省一半内存意味着 GC 压力显著下降。这是一个"用时间换空间"的决定,和 Java 惯用的"空间换时间"正好相反。选择依据在 JEP 254 的动机里写得很清楚:典型业务字符串绝大多数是 Latin-1 可表示的。

两个常量在 `String.java:3269-3270`:

```java
// String.java:3269-3270
@Native static final byte LATIN1 = 0;
@Native static final byte UTF16  = 1;
```

`isLatin1()` 就是 `coder == LATIN1` 的判断,后面几乎所有方法的第一步都是它。

### 为什么访问变慢了还要这么做

关键设计(斜体):*Java 惯用"空间换时间"(比如 HashMap 扩容、缓存),这里反过来了——因为 String 在堆里的体量太大,内存是第一矛盾。JDK9 的取舍是: 访问路径多一次分支判断(慢一点),但堆占用减半(GC 压力大降)。面试如果能把"取舍"讲成"内存 vs 速度",而不是背"JEP 254"四个字母,就过关了。*

## 2. 不可变到底怎么保证的

### final 只是表面

回到面试题。`String.java:125` 是 `public final class String`——类不能继承。`String.java:140` 的 `value` 是 `final` + `private`——引用不能改、外部拿不到。但这两条加起来还不够:final 只保证"引用不换",不保证"数组内容不被改"。如果某个方法对 `value[0]` 写了新值,不可变就破了。

真正的保证是第三层:**String 的所有操作都不修改 value 数组本身**。拿最典型的一个——substring(`String.java:1835`):

```java
// String.java:1835-1846(截取核心)
public String substring(int beginIndex) {
    if (beginIndex < 0) {
        throw new StringIndexOutOfBoundsException(beginIndex);
    }
    int subLen = length() - beginIndex;
    ...
    if (beginIndex == 0) {
        return this;                       // 从头截: 直接返回自己,零拷贝
    }
    return isLatin1() ? StringLatin1.newString(value, beginIndex, subLen)
                      : StringUTF16.newString(value, beginIndex, subLen);
}
```

`StringLatin1.newString`(`StringLatin1.java:714`)是:

```java
// StringLatin1.java:714-716
public static String newString(byte[] val, int index, int len) {
    return new String(Arrays.copyOfRange(val, index, index + len), LATIN1);
}
```

`Arrays.copyOfRange` 复制出一段新数组。也就是说:**substring 返回的是"新数组的新 String",原数组碰都没碰**。JDK7 之前 substring 是共享数组的(数组 + offset 偏移字段),结果一个 1MB 的字符串 sub 出 1KB 的小串,那个小串还攥着 1MB 的数组——内存泄漏。JDK7 移除了共享设计(offset 字段取消),改成复制,把"共享"的坑填了。

concat、replace、toUpperCase 同理——全是"新数组 + 新 String",没有一个是原地改的。

关键设计(斜体):*不可变 = final(不能继承、引用不变)+ private(拿不到数组)+ 操作全部返回新对象(数组内容不变)。三件事缺一不可。面试答"因为有 final"会被追问"final 能防数组内容被改吗"——能说出第三层才算真懂。*

### 不可变带来的四个收益

- **哈希可缓存**: 内容不变 → hash 算一次存下来永远有效(`String.java:156` 的 `private int hash` 就是干这个的,下一篇展开)。如果 String 可变,缓存就失效了——这是"不可变"最直接的性能收益
- **常量池可共享**: 相同内容可以安全地驻留为同一个对象(intern,下一篇),因为没人能改它
- **线程安全**: 无需同步,任何线程读同一个 String 都看到同一内容
- **安全**: 类名、URL、文件路径这些会被安全检查的字符串,不怕调用方中途改掉

关键设计(斜体):*四个收益里,缓存和共享是性能,线程安全和安全是正确性。面试把四点背全不难,难的是能指着 `String.java:156` 说"这个字段就是不可变换来的"。*

### 和 JVM 的关系

`String.java:3127` 的 intern 是 native:

```java
// String.java:3127
public native String intern();
```

它查入的是 JVM 的字符串常量池——JDK7 之后这个池在堆里。驻留机制本身在 VM 侧(stringTable),Java 侧只是把"驻留"这个动作暴露出来。

跨层标注: [JVM Spec: §4.2 字符串常量池];[内部卷: 07-classfile-classloader 03-symbol-string-table(stringTable::intern 与符号驻留)]

## 3. 字符串从哪来——构造与解码

### 构造的复制规则

`new String("abc")`(拷贝构造,`String.java:235`)共享原数组:`this.value = original.value`——因为 original 也是不可变的,共享安全。`new String(bytes, "UTF-8")` 走 `StringCoding.decode`(`String.java:592`,返回 `Result` 含 value+coder)后直接赋值。真正会复制的是外部传入的数组:`new String(char[])` 的三参构造(`String.java:275` → `String.java:3207` 的四参内部构造)会 `StringUTF16.toBytes(value, off, len)`(`String.java:3224`)——把调用方的 char[] 拷成内部 byte[]。

而 `StringLatin1/StringUTF16` 内部用的 `String(byte[], coder)`(`String.java:3252`)是另一个包私有构造:**不复制数组**。以它为例:

```java
// String.java:3252(截取)
String(byte[] value, byte coder) {
    this.value = value;
    this.coder = coder;
}
```

注意:**这里不复制数组**。这个构造是包私有的(只有 String 家族内部在用),外部代码拿不到数组引用,所以共享是安全的。

关键设计(斜体):*"内部共享数组、外部必须复制"——同一套不可变,对内零拷贝,对外防御性复制。分界线画在包边界上: 包内的数组来源可信(不会改),包外的调用方数组不可信(可能继续改),必须拷。*

### 字节怎么变成字符

`new String(byte[], charset)` 走的是 `StringCoding.decode`(`StringCoding.java:225` 的 `decode(String charsetName, byte[] ba, int off, int len)`):

```
字节数组 → CharsetDecoder.decode → 按解码结果选 coder → 存入 value
```

解码结果全是 Latin-1 可表示 → coder=LATIN1;否则 UTF16。这条链的细节(快路径、替代符、乱码)在第 4 篇展开,这里只要建立"构造 = 字节 → 解码 → 选存储格式"的心智模型。

关键设计(斜体):*无参的 `new String(bytes)` 用默认 charset——默认 charset 是 JVM 启动时探测的,换环境(Windows GBK/Linux UTF-8)结果就不同。生产乱码的一大来源就是这里: 你以为是"文件编码问题",其实是"默认 charset 探测问题"。*

## 核心悬念

"String 不可变"是块基石——Map 敢拿它当 key、常量池敢驻留它、锁敢用它当载体,全都建立在"内容不会变"之上。但"内容不会变"要成立,还差最后一环:**两个 String 怎么才算相等?`equals` 先比什么后比什么?`hashCode` 为什么用 31?** 如果 equals 和 hashCode 的契约有瑕疵,HashMap 里拿 String 当 key 就是灾难。下一篇: equals/hashCode/compareTo 的逐行实现。

> → [01-string/02 — String 的相等、哈希与比较](02-equals-hashcode-compare.md)
