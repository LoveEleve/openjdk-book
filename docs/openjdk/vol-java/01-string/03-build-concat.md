# 字符串构建与拼接 — 可变缓冲、扩容与 JEP 280

> 基于 JDK 11 `java.base` 的 `AbstractStringBuilder`、`StringBuffer`、`StringConcatFactory` 与 `StringJoiner` 实现。
> **前置依赖**: [String 为什么是不可变的](01-storage-immutable.md)(byte[]+coder 与不可变边界)、[String 的相等、哈希与比较](02-equals-hashcode-compare.md)(值对象收益)
> → **后续**: [字符编码与 Unicode](04-encoding-unicode.md)

## 先看一个会慢到失控的循环

假设程序要拼接一百万个片段。最直觉的写法是每次都生成一个新的 String；稍微聪明一点的写法是复用 StringBuilder，但如果缓冲区每次只增长固定大小，旧内容仍会被反复搬家。

这两个方案分别浪费了什么？前者不断创建短命对象，后者不断复制越来越长的数组。JDK 的设计因此分成三层：

```text
可变构建器 → 指数扩容，摊平复制成本
共享构建器 → 锁保护可变状态，换取线程安全
语言级 a+b → invokedynamic，把拼接策略推迟给运行时
```

本文不是先列类，而是追踪同一个问题：**一段字符串内容怎样以尽可能少的复制，从可变输入变成不可变 String？**

## 1. 可变缓冲区的骨架: AbstractStringBuilder

### 1.1 三个字段:比 String 多一个 count

`StringBuilder` 和 `StringBuffer` 都不自己存数据——它们继承自 `AbstractStringBuilder`,存储字段和 String 完全同构(`AbstractStringBuilder.java:60-70`):

```java
// AbstractStringBuilder.java:60-70(截取核心,逐字)
byte[] value;

byte coder;

int count;
```

`value` + `coder` 就是第 1 篇里 String 的那套紧凑字符串存储,不再重复。多出来的 `count` 是**已用字符数**。于是这里出现了一对容易混淆的概念:

- **length**(`AbstractStringBuilder.java:124-126`):`count`,已经写进去的字符数
- **capacity**(`AbstractStringBuilder.java:135-137`):`value.length >> coder`,数组能容纳的字符数——注意这个 `>> coder`:coder 为 0(LATIN1)时数组长度就是容量;coder 为 1(UTF16)时数组长度是容量的两倍

`capacity - length` 就是"还能塞多少字符而不用重新分配"。append 的每一步都在消耗这个余量。

构造时(`AbstractStringBuilder.java:84-92`):

```java
// AbstractStringBuilder.java:84-92(截取核心,逐字)
AbstractStringBuilder(int capacity) {
    if (COMPACT_STRINGS) {
        value = new byte[capacity];
        coder = LATIN1;
    } else {
        value = StringUTF16.newBytesFor(capacity);
        coder = UTF16;
    }
}
```

默认容量 16 来自 `StringBuilder` 的无参构造(`StringBuilder.java:102-104` 的 `super(16)`);带字符串的构造是 `str.length() + 16`(`StringBuilder.java:127-130`)。面试题的"默认容量 16"就在这。

关键设计(斜体):*新构建器初始全是 LATIN1——绝大多数先拼接英文再碰到中文的场景,缓冲区一直保持单字节,直到 `putStringAt` 发现 coder 不一致才整体升级(见 1.2)。这就是紧凑字符串在构建器里的延续: 能用 1 字节存,绝不用 2 字节。*

### 1.2 append 的三步走

以最常用的 `append(String)` 为例(`AbstractStringBuilder.java:533-542`):

```java
// AbstractStringBuilder.java:533-542(截取核心,逐字)
public AbstractStringBuilder append(String str) {
    if (str == null) {
        return appendNull();
    }
    int len = str.length();
    ensureCapacityInternal(count + len);
    putStringAt(count, str);
    count += len;
    return this;
}
```

三步: **① 保证容量 → ② 写数据 → ③ 更新 count**。第二步 `putStringAt`(`AbstractStringBuilder.java:1663-1668`)里藏着 coder 的处理:

```java
// AbstractStringBuilder.java:1663-1668(截取核心,逐字)
private final void putStringAt(int index, String str) {
    if (getCoder() != str.coder()) {
        inflate();
    }
    str.getBytes(value, index, coder);
}
```

待追加的字符串是 UTF16 而缓冲区还是 LATIN1 时,`inflate()`(`AbstractStringBuilder.java:224-232`)先把整个旧数组从单字节展开成双字节(`StringLatin1.inflate`),再继续写。**升级是整体性的、一次性的**——之后缓冲区就一直是 UTF16 了,不会反复横跳。这也是"拼接一串中文后构建器变慢"的机制原因: 这个构建器后续的每次写入、读取,每字符占位都从 1 字节变成 2 字节。

### 1.3 扩容算法:×2 + 2

第一步的 `ensureCapacityInternal`(`AbstractStringBuilder.java:168-175`)和核心的 `newCapacity`(`AbstractStringBuilder.java:197-208`):

```java
// AbstractStringBuilder.java:168-175(截取核心,逐字)
private void ensureCapacityInternal(int minimumCapacity) {
    // overflow-conscious code
    int oldCapacity = value.length >> coder;
    if (minimumCapacity - oldCapacity > 0) {
        value = Arrays.copyOf(value,
                newCapacity(minimumCapacity) << coder);
    }
}
```

```java
// AbstractStringBuilder.java:197-208(截取核心,逐字)
private int newCapacity(int minCapacity) {
    // overflow-conscious code
    int oldCapacity = value.length >> coder;
    int newCapacity = (oldCapacity << 1) + 2;
    if (newCapacity - minCapacity < 0) {
        newCapacity = minCapacity;
    }
    int SAFE_BOUND = MAX_ARRAY_SIZE >> coder;
    return (newCapacity <= 0 || SAFE_BOUND - newCapacity < 0)
        ? hugeCapacity(minCapacity)
        : newCapacity;
}
```

面试题"扩容一次扩多少"的答案是 **`(oldCapacity << 1) + 2`,即 ×2 再加 2**。两个细节:

- **只会在"不够"时扩**:`minimumCapacity - oldCapacity > 0` 才触发,`Arrays.copyOf` 分配新数组并整体搬移旧数据——这次搬移就是扩容的成本
- **溢出保护**:`MAX_ARRAY_SIZE = Integer.MAX_VALUE - 8`(`AbstractStringBuilder.java:183`)是数组分配的安全上限(VM 要在数组头上留字);`newCapacity` 超过它就转 `hugeCapacity`(`AbstractStringBuilder.java:210-218`),连安全上限都超就直接抛 `OutOfMemoryError`

至于为什么 +2——`ensureCapacity` 的文档(`AbstractStringBuilder.java:146-147`)只说"两倍旧容量加 2",没有解释。常见说法是 JDK 早期为字符串尾部余量(NUL 结尾时期)的遗留,面试答"历史原因"即可,不必深究。

关键设计(斜体):*×2 是指数扩容,换来的是**均摊 O(1)**——每次复制都把数组翻倍,总复制量是几何级数,前 n 次 append 的总代价是 O(n),均摊到每次 O(1)。如果改成每次固定 +16,总代价就是 O(n²)(16+32+48+... 等差数列),在循环 append 场景直接退化。这就是"构建器别在循环里 new"的数学依据: 复用同一个 StringBuilder,前 1 万个字符的复制成本已经被翻倍策略摊薄了。*

### 1.4 主动扩容与收缩

两个配套方法:

- `ensureCapacity(int)`(`AbstractStringBuilder.java:155-159`):公开的预分配入口,`minimumCapacity > 0` 才动作。生产上预估了最终长度(比如拼 SQL、拼 JSON)时先 `new StringBuilder(1024)`,能把扩容从"可能 4-5 次"压到"0 次"
- `trimToSize()`(`AbstractStringBuilder.java:241-246`):反过来,把数组收缩到刚好装下 `count` 个字符——大型拼接结束后释放多余内存用

### 1.5 toString:复制,绝不共享数组

`StringBuilder` 的 toString(`StringBuilder.java:448-454`):

```java
// StringBuilder.java:448-454(截取核心,逐字)
@Override
@HotSpotIntrinsicCandidate
public String toString() {
    // Create a copy, don't share the array
    return isLatin1() ? StringLatin1.newString(value, 0, count)
                      : StringUTF16.newString(value, 0, count);
}
```

注释把设计意图写得很直白:**"Create a copy, don't share the array"**。对比第 1 篇讲的 String 包私有构造 `String(byte[], coder)`——那个不复制数组,因为只有 String 家族内部在用,数组不可能被改;而 StringBuilder 是公共类,调用方手里攥着这个可变对象,如果 toString 返回的 String 共享了缓冲区数组,下次 append 就把已返回的 String "改"了——不可变就破了。所以必须复制。

另外注意两处 `@HotSpotIntrinsicCandidate`:这里(`StringBuilder.java:449`)和 `append(String)`(`StringBuilder.java:176-177`)。这个注解是给 HotSpot 的钩子:JIT 编译时把方法调用替换成手写的快速实现(内部卷的宏内联机制),Java 层代码是"保底正确实现"。

关键设计(斜体):*"内部构造零拷贝、公共方法必须拷贝"这条边界,第 1 篇在 String 里讲过,这里在构建器里再次出现——只是分界变了: String 按包边界分,构建器按"对象是否仍可变"分。String 不可变所以内部随便共享;StringBuilder 可变,toString 那一刻就必须断干净。*

## 2. StringBuffer:同步与 toString 缓存

### 2.1 同一份逻辑,只加 synchronized

`StringBuffer.append(String)`(`StringBuffer.java:313-319`):

```java
// StringBuffer.java:313-319(截取核心,逐字)
@Override
@HotSpotIntrinsicCandidate
public synchronized StringBuffer append(String str) {
    toStringCache = null;
    super.append(str);
    return this;
}
```

它和 `StringBuilder.append` 的差别,肉眼可见:**只有方法修饰符 `synchronized` 和一行 `toStringCache = null`**。真正的逻辑在 `super.append`——两份子类共用 `AbstractStringBuilder` 里同一份代码。线程安全的实现方式,就是 JDK1.0 时代最简单粗暴的那一种:**方法级锁**。整个类从 `compareTo`(`StringBuffer.java:203`)到 `reverse`(`StringBuffer.java:709`),绝大多数公开方法都是 `public synchronized`;七处特例自己不加锁——`insert(int, CharSequence)`(`StringBuffer.java:580`)与 `insert(int, int/long/float/double)` 四个重载(`StringBuffer.java:627`/`639`/`651`/`663`),以及 `indexOf(String)`(`StringBuffer.java:675`)、`lastIndexOf(String)`(`StringBuffer.java:692`)。它们靠转调同步方法获得同步:源码注释写得很清楚——`indexOf` 是 `"synchronization achieved via invocations of other StringBuffer methods"`,insert 系是 `"synchronization achieved via invocation of StringBuffer insert(int, String) after conversion of ... to String by super class method"`——先在父类里把参数转成 String,再走进同步的 `insert(int, String)`(`StringBuffer.java:559`),连 `toStringCache` 的清理也一并省了(注释里的 `"Ditto for toStringCache clearing"`)。

关键设计(斜体):*方法级锁的粒度最粗——一次 `append("a").append("b")` 链式调用要加两次锁。线程安全的正确性没问题,代价是每次方法调用都有 monitor 的进入/退出开销,再加上锁竞争,这就是"StringBuffer 慢"的机制来源。面试能说出"慢在方法级锁粒度,而不是什么玄学",就已经超过背答案的人了。*

### 2.2 toString 缓存:改少读多的补偿

`StringBuffer` 比 `StringBuilder` 多了一个字段(`StringBuffer.java:120`):

```java
// StringBuffer.java:120
private transient String toStringCache;
```

以及每个修改方法里的 `toStringCache = null`(比如 2.1 里的 `StringBuffer.java:316`,`setLength` 的 `StringBuffer.java:237`,`reverse` 的 `StringBuffer.java:710`)——**任何修改都让缓存失效**。toString(`StringBuffer.java:715-724`):

```java
// StringBuffer.java:715-724(截取核心,逐字)
@Override
@HotSpotIntrinsicCandidate
public synchronized String toString() {
    if (toStringCache == null) {
        return toStringCache =
                isLatin1() ? StringLatin1.newString(value, 0, count)
                           : StringUTF16.newString(value, 0, count);
    }
    return new String(toStringCache);
}
```

两条路径:

- **首次调用**:`StringLatin1.newString` 复制出独立数组(和 StringBuilder.toString 同款),**结果自己存进 cache 并返回**
- **后续调用**:`new String(toStringCache)`——走 `String.java:235` 的拷贝构造(`this.value = original.value`),**共享缓存数组,零复制**

注意第二条路径返回的仍是新对象,只是底层数组共享。因为缓存里的 String 是私有的、数组没人会再改,共享绝对安全。缓存的意义: **"改少读多"场景**(比如日志模板频繁 `sb.toString()` 取当前值)下,后续读取不再付出 O(n) 复制;代价是修改时必须清缓存,而修改本来就慢(还带着锁),多一行赋值无所谓。

关键设计(斜体):*缓存的是"不可变快照",不是数组本身——第一次复制出独立副本后才敢缓存。这和第 1 篇的不可变设计是同一套逻辑的复用: 快照不可变,所以后续可以零拷贝共享;而 `new String` 的包装让返回对象与缓存对象解耦,调用方拿到的每个 String 都不受 StringBuffer 后续状态变化影响。*

### 2.3 什么时候真的用 StringBuffer

结论很干脆:生产代码里 StringBuffer 几乎只出现在"历史代码"和"面试题"里。单线程用 `StringBuilder`;确有多线程共享同一个构建器、并且需要每次看到一致快照的场景才轮到它。绝大多数并发场景的正确姿势是"各自构建、最后合并",而不是共享一个缓冲器。

## 3. `a + b + c` 在 JDK11 里编译成什么

### 3.1 从 StringBuilder 到 invokedynamic

JDK8 及以前,`String s = a + b + c;` 被 javac 编译成:

```
new StringBuilder().append(a).append(b).append(c).toString()
```

这有两个浪费点:**append 途中可能要扩容复制**,以及 **toString 还要再复制一次**。JDK9 的 JEP 280 改写了这一切——javac 不再生成 StringBuilder 调用,而是生成一条 `invokedynamic`,引导方法指向 `StringConcatFactory.makeConcat`(`StringConcatFactory.java:451-459`):

```java
// StringConcatFactory.java:451-459(截取核心,逐字)
public static CallSite makeConcat(MethodHandles.Lookup lookup,
                                  String name,
                                  MethodType concatType) throws StringConcatException {
    ...
    return doStringConcat(lookup, name, concatType, true, null);
}
```

**注意一个前提**:如果 `a`、`b`、`c` 全是编译期常量(字面量),javac 在编译期就把 `"a" + "b" + "c"` 折叠成一个字符串塞进常量池了——**根本不会生成任何拼接字节码**。面试经典题"`"a"+"b"+"c"` 创建了几个对象"的现代答案第一句就是:字面量拼接在编译期就完成了,运行时没有任何拼接动作(那个折叠后的字面量对象在类加载时驻留一次,见第 2 篇 intern——那是"常量池驻留",不是"拼接")。JEP 280 只对**运行期才知道值的变量拼接**生效。

关键设计(斜体):*invokedynamic 的精髓是**把拼接策略推迟到运行时**——字节码里只有一条 indy 指令,具体怎么做由 JVM 决定。好处: 以后 JDK 想换拼接实现,老字节码不需要重新编译。面试对比题: JDK8 的答案是"编译成 StringBuilder",JDK9+ 的答案是"编译成 indy,常量折叠除外"——答错版本就是踩了 JDK 版本差异的坑。*

### 3.2 六个策略,默认值是什么

拼接"怎么做"的选择落在 `Strategy` 枚举里(`StringConcatFactory.java:138-173`),一共六档:

| 策略 | 做法 |
|------|------|
| `BC_SB` / `BC_SB_SIZED` / `BC_SB_SIZED_EXACT` | 运行时生成字节码,调 StringBuilder(后两档预判容量,EXACT 档精确计算) |
| `MH_SB_SIZED` / `MH_SB_SIZED_EXACT` | MethodHandle 组合,最终仍调 StringBuilder |
| `MH_INLINE_SIZED_EXACT` | MethodHandle 组合,自己建 byte[],**不碰 StringBuilder** |

默认值是 `MH_INLINE_SIZED_EXACT`(`StringConcatFactory.java:136`),也就是 JDK11 实际默认走的那条路。用户可以用系统属性 `-Djava.lang.invoke.stringConcat=BC_SB` 强制切回老式 StringBuilder 字节码(`StringConcatFactory.java:205-217` 读取该属性)——这个开关常被拿来对比两种实现的开销。

### 3.3 默认策略:一次分配,从后往前写

`MH_INLINE_SIZED_EXACT` 的实现拆在 `StringConcatHelper` 里,思路和 StringBuilder 完全不同:**先精确算出总长度,一次分配,然后从后往前填**。

第一步,算总长度和 coder——`mixLen`(`StringConcatHelper.java:57-119` 的一堆重载)把每个参数的长度累加,`mixCoder`(`StringConcatHelper.java:127-194`)把各段的 coder 逐段或起来(只要有一段是 UTF16,结果就是 UTF16):

```java
// StringConcatHelper.java:117-119 + 137-139(截取核心,逐字)
static int mixLen(int current, String value) {
    return checkOverflow(current + value.length());
}

static byte mixCoder(byte current, String value) {
    return (byte)(current | value.coder());
}
```

第二步,写入——`prepend` 系列**从缓冲区末尾往前写**(所以叫 prepend,追加的顺序是反的,先放最后一段)。以最常用的字符串段为例(`StringConcatHelper.java:330-334`):

```java
// StringConcatHelper.java:330-334(截取核心,逐字)
static int prepend(int index, byte[] buf, byte coder, String value) {
    index -= value.length();
    value.getBytes(buf, index, coder);
    return index;
}
```

`index` 以字符计、从末尾递减;整数段直接 `Integer.getChars(value, index, buf)`(`StringConcatHelper.java:294-300`)把数字转字符写进数组——**连中间 String 都不创建**。

第三步,收尾(`StringConcatHelper.java:343-349`):

```java
// StringConcatHelper.java:343-349(截取核心,逐字)
static String newString(byte[] buf, int index, byte coder) {
    // Use the private, non-copying constructor (unsafe!)
    if (index != 0) {
        throw new InternalError("Storage is not completely initialized, " + index + " bytes left");
    }
    return new String(buf, coder);
}
```

这就是第 1 篇讲过的 `String(byte[], coder)` 包私有构造——**不复制数组,直接把刚填好的缓冲区交给 String**。注释里的 "(unsafe!)" 和后一行检查点明了前提: 只有确认 buffer 被填满了(index 归零)才敢这么干。

对比一下两种方案的完整成本:

```
JDK8 StringBuilder 方案:  分配(可能多次,含扩容复制) + toString 再复制一次
JEP 280 MH_INLINE 方案:   算长度(纯算术) + 分配一次 + 从后往前填 + 零拷贝构造
```

关键设计(斜体):*从后往前写是这套方案的点睛之笔——数组尾端是确定的,每段写完 index 前移,不需要像 append 那样维护"已用位置 + 可能扩容"。精确长度 + 零拷贝构造,把一次拼接的复制次数压到最低。而这一切对 Java 开发者透明: 你写的还是 `a + b + c`,策略由 JVM 在运行时选。*

### 3.4 面试怎么答

一题三层的标准答案:

1. **全字面量**:编译期折叠成常量池字面量,运行时无拼接动作
2. **变量拼接**:javac 生成 `invokedynamic` → `StringConcatFactory` 选策略,JDK11 默认 `MH_INLINE_SIZED_EXACT`——精确算长、一次分配、从后往前写、零拷贝构造
3. **兜底**:老 JDK 或显式切属性时,才退回 StringBuilder 字节码方案

跨层标注: [JVM Spec: §6.5 invokedynamic];[内部卷: 07-classfile-classloader 03-symbol-string-table(常量池 CONSTANT_String 与字符串驻留)]

## 4. StringJoiner:分隔符拼接的正确封装

### 4.1 结构:存数组,不是存 StringBuilder

`List<String>` 转 `"a,b,c"` 是生产里最常见的字符串操作之一。JDK8 提供了 `StringJoiner`(`java.util.StringJoiner.java`),注意它**并不持有 StringBuilder**——字段(`StringJoiner.java:66-84`)是前缀/分隔符/后缀三个 String,加一个存元素的 `String[] elts`:

```java
// StringJoiner.java:66-84(截取核心,逐字)
private final String prefix;
private final String delimiter;
private final String suffix;

/** Contains all the string components added so far. */
private String[] elts;

/** The number of string components added so far. */
private int size;

/** Total length in chars so far, excluding prefix and suffix. */
private int len;
```

`add`(`StringJoiner.java:198-210`)只做三件事:**转成 String、塞进 elts 数组(满则翻倍)、累计长度**:

```java
// StringJoiner.java:198-210(截取核心,逐字)
public StringJoiner add(CharSequence newElement) {
    final String elt = String.valueOf(newElement);
    if (elts == null) {
        elts = new String[8];
    } else {
        if (size == elts.length)
            elts = Arrays.copyOf(elts, 2 * size);
        len += delimiter.length();
    }
    len += elt.length();
    elts[size++] = elt;
    return this;
}
```

注意 `len += delimiter.length()` 的位置:**在 `elts == null` 分支之外**——也就是只有第二个元素起才计入分隔符长度。这就是"分隔符只在元素之间出现"的机制保证:3 个元素 2 个分隔符,而不是 3 个。

关键设计(斜体):*整个拼接是**惰性**的——add 只是记账(存引用、累计长度),真正的字符搬运发生在 toString。对比自己写 `for` 循环拼: 最容易错的就是分隔符位置(多了首尾各一个)和空集合的处理(不该输出分隔符)。StringJoiner 把这两个边界条件封装死,是标准库"消灭低级错误"的典型设计。*

### 4.2 toString:一次精确分配

真正的拼接在 `toString`(`StringJoiner.java:164-188`)里完成:

```java
// StringJoiner.java:164-188(截取核心,逐字)
@Override
public String toString() {
    final String[] elts = this.elts;
    if (elts == null && emptyValue != null) {
        return emptyValue;
    }
    final int size = this.size;
    final int addLen = prefix.length() + suffix.length();
    if (addLen == 0) {
        compactElts();
        return size == 0 ? "" : elts[0];
    }
    final String delimiter = this.delimiter;
    final char[] chars = new char[len + addLen];
    int k = getChars(prefix, chars, 0);
    if (size > 0) {
        k += getChars(elts[0], chars, k);
        for (int i = 1; i < size; i++) {
            k += getChars(delimiter, chars, k);
            k += getChars(elts[i], chars, k);
        }
    }
    k += getChars(suffix, chars, k);
    return new String(chars);
}
```

`len` 字段在 add 时已经精确累计好,这里直接 `new char[len + addLen]` **一次分配,不多不少**,然后按"前缀 + 元素(分隔符 + 元素)… + 后缀"的顺序填,最后 `new String(chars)`。空值策略由 `setEmptyValue`(`StringJoiner.java:144-148`)提供:没有 add 过任何元素且设置了 emptyValue 时,返回你指定的字符串(比如集合表示 `"{}"`);未设置时,toString 默认返回 `prefix + suffix`。

### 4.3 String.join:一层薄薄的委托

`String.join(delimiter, elements)` 的实现(`String.java:2392-2401`)就是 `StringJoiner` 的一层皮:

```java
// String.java:2392-2401(截取核心,逐字)
public static String join(CharSequence delimiter, CharSequence... elements) {
    Objects.requireNonNull(delimiter);
    Objects.requireNonNull(elements);
    // Number of elements not likely worth Arrays.stream overhead.
    StringJoiner joiner = new StringJoiner(delimiter);
    for (CharSequence cs: elements) {
        joiner.add(cs);
    }
    return joiner.toString();
}
```

源码注释(`String.java:2395`)甚至解释了为什么不用 Stream:`"Number of elements not likely worth Arrays.stream overhead"`——元素不多时,手写 for 循环比 Stream 便宜。这个判断也提醒我们:`Collectors.joining`(Stream 里的版本)在底层同样用的是 StringJoiner。

关键设计(斜体):*String.join 和 JEP 280 的 `+` 是两条独立的路径: `+` 走 invokedynamic 拼接策略,join 走显式的 StringJoiner——一个是语言运算符,一个是显式 API,互不干扰。面试若问"join 内部用什么",答案是 StringJoiner(以及它自己的 char[] 拼接),不是 StringBuilder。*

## 核心悬念

这一篇里,构建器从一开始的 LATIN1 单字节缓冲区,到 append 中文时整体 inflate 成 UTF16;`StringConcatHelper` 写字节时也要按 coder 决定每字符占 1 字节还是 2 字节——**所有编码判断都在,但"编码从哪来"还没被正面回答**。`"a"` 存 1 字节、`"中"` 存 2 字节,那 `"中".getBytes()` 和 `new String(bytes)` 中间到底发生了什么?为什么同一段字节在 Windows 上是乱码、Linux 上不是?乱码问题的根源就藏在 StringCoding 的解码链里。

> → [01-string/04 — 字符编码与 Unicode](04-encoding-unicode.md)
