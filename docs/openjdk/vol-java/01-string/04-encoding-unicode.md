# 04. 字符编码与 Unicode — StringCoding 编解码链、双路径存储、代理对与查表

> **前置依赖**: [01-string/01 — 存储与不可变](01-storage-immutable.md)(byte[]+coder 模型)、[01-string/02 — equals/hashCode](02-equals-hashcode-compare.md)、[01-string/03 — 构建与拼接](03-build-concat.md)(inflate 的机制)
> → **后续**:域 06 异常体系(06-exceptions 系列,下一篇)
> 关联: [JEP 254: Compact Strings];内部卷 07-classfile-classloader 03-symbol-string-table(符号驻留);域 19 BufferChannel(CharsetEncoder/Decoder 在 NIO 的形态)

## 乱码,从哪一行代码开始

"UTF-8 存,GBK 读"产生 �——这是每个线上工程师都撞过的墙。前 3 篇里,`byte[] value` + `byte coder` 这个存储模型反复出现,但有一件事一直没被正面回答:**字节和字符之间到底是怎么互相转换的?** `"中".getBytes()` 出来的是几个字节?`new String(bytes)` 又是凭什么把字节认成字符的?乱码不是玄学,它发生在每一行具体的代码里。

这一篇把转换的完整链路挖开:`StringCoding` 的编解码流水线(以及它的快路径)、`StringLatin1`/`StringUTF16` 双路径存储的字节序细节、代理对与码点视角的差别、最后是 `Character` 那张庞大的查表。

## 1. 字节 → 字符串:StringCoding 的编解码链

### 1.1 入口:所有构造汇聚到一个 decode

`new String(byte[], ...)` 三个形态的构造,全部委托给 `StringCoding.decode`:

```java
// String.java:461-470(截取核心,逐字)
public String(byte bytes[], int offset, int length, String charsetName)
        throws UnsupportedEncodingException {
    if (charsetName == null)
        throw new NullPointerException("charsetName");
    checkBoundsOffCount(offset, length, bytes.length);
    StringCoding.Result ret =
        StringCoding.decode(charsetName, bytes, offset, length);
    this.value = ret.value;
    this.coder = ret.coder;
}
```

带 `Charset` 对象的版本(`String.java:502-510`)与无参版本(`String.java:590-595`)是同样的骨架——区别只在第三个参数怎么来:显式名字、显式 Charset 对象、或者**默认 charset**(`String.java:613-615` 的 `new String(byte[])` 转调无参构造)。`getBytes` 是镜像的编码路径:`getBytes(String charsetName)`(`String.java:938-941`)→ `StringCoding.encode(charsetName, coder(), value)`,无参 `getBytes()`(`String.java:980-981`)→ `StringCoding.encode(coder(), value)`——同样的"名字/对象/默认"三种取法。

### 1.2 decode 的分派:三个内置快路径

`decode(String charsetName, ...)`(`StringCoding.java:225-253`)拿到名字后,先 `lookupCharset` 解析,然后**优先撞内置三件套**:

```java
// StringCoding.java:234-246(截取核心,逐字)
Charset cs = lookupCharset(csn);
if (cs != null) {
    if (cs == UTF_8) {
        return decodeUTF8(ba, off, len, true);
    }
    if (cs == ISO_8859_1) {
        return decodeLatin1(ba, off, len);
    }
    if (cs == US_ASCII) {
        return decodeASCII(ba, off, len);
    }
    sd = new StringDecoder(cs, csn);
}
```

UTF-8、ISO-8859-1、US-ASCII 是三个最高频字符集,各自走专属实现(**不经过完整的 CharsetDecoder 流水线**);其余字符集(GBK、UTF-16、Shift_JIS…)才构造通用 `StringDecoder`。这些快路径有多"裸"?看 decodeLatin1(`StringCoding.java:593-600`):

```java
// StringCoding.java:593-600(截取核心,逐字)
private static Result decodeLatin1(byte[] ba, int off, int len) {
   Result result = resultCached();
   if (COMPACT_STRINGS) {
       return result.with(Arrays.copyOfRange(ba, off, off + len), LATIN1);
   } else {
       return result.with(StringLatin1.inflate(ba, off, len), UTF16);
   }
}
```

ISO-8859-1 是单字节一一映射,解码就是**复制字节数组**——连查表都不用。decodeASCII(`StringCoding.java:543-556`)更直接:字节全是非负(ASCII 范围)就直接复制为 LATIN1 存储;有负字节(高位为 1)才逐字节处理,非法字节替换成 U+FFFD。

关键设计(斜体):*编码解码是 String 构造里最热的路径之一,而内置三件套覆盖了绝大多数真实流量。把最高频的三个字符集从通用流水线里拆出来,每个省掉一次 CharsetDecoder 对象创建 + Buffer 状态机推进——这是标准库里"按频次拆快路径"的经典案例。*

### 1.3 StringDecoder:ThreadLocal 缓存 + REPLACE 替换语义

其余字符集走 `StringDecoder`。它的构造(`StringCoding.java:160-169`)里有两件关键配置:

```java
// StringCoding.java:160-169(截取核心,逐字)
StringDecoder(Charset cs, String rcn) {
    this.requestedCharsetName = rcn;
    this.cs = cs;
    this.cd = cs.newDecoder()
        .onMalformedInput(CodingErrorAction.REPLACE)
        .onUnmappableCharacter(CodingErrorAction.REPLACE);
    ...
}
```

- **REPLACE 替换语义**:解码遇到非法字节序列(字节流不符合该字符集规范)时,不是抛异常,而是替换成替代字符——`StringCoding.java:727` 的 `private static char repl = '\ufffd';`,即 U+FFFD。**"�"就是从这里来的**:`"UTF-8 存,GBK 读"` 时,GBK 解码器把 UTF-8 的多字节序列读成非法字节组合,每个坏序列换成 U+FFFD,屏幕上就全是 �。替换动作被打开注解为有意为之——`decode` 里注释写着 `"Substitution is always enabled, so this shouldn't happen"`(`StringCoding.java:217-219`)
- **ThreadLocal 缓存**:`StringCoding.java:66-68` 用 `ThreadLocal<SoftReference<StringDecoder>>` 缓存解码器——CharsetDecoder 是有状态对象(内部有 ByteBuffer/CharBuffer 进度),new 一个不便宜;每个线程缓存一个,换 charset 才重建

编码侧同理:`StringEncoder`(`StringCoding.java:348` 起)也配置 REPLACE,编码时无法表示的字符(比如把中文 "中" 编码进 ISO-8859-1)替换成 `'?'`——`encode8859_1`(`StringCoding.java:619-649`)里 `dst[dp++] = '?'`(`StringCoding.java:641`)。所以乱码的"长相"取决于方向:解码侧坏字节变 �,编码侧不可表示变 ?。

### 1.4 解码结果决定 coder:Result 的两次尝试

decode 返回的不是 String,而是 `Result`(`StringCoding.java:111-140`),里面装着 `value` 和 `coder`。核心是 `with(char[], off, len)`(`StringCoding.java:121-133`):

```java
// StringCoding.java:121-133(截取核心,逐字)
Result with(char[] val, int off, int len) {
    if (String.COMPACT_STRINGS) {
        byte[] bs = StringUTF16.compress(val, off, len);
        if (bs != null) {
            value = bs;
            coder = LATIN1;
            return this;
        }
    }
    coder = UTF16;
    value = StringUTF16.toBytes(val, off, len);
    return this;
}
```

解码出来的字符数组,先**尝试压缩成单字节**(`StringUTF16.compress`:逐字符检查是否 ≤0xFF,有一个超界就整体放弃)——成功则 LATIN1 存储、省一半内存;失败才落到 UTF16。这就是第 1 篇说的"解码结果决定 coder"的机制位置:不是调用方指定,是**解码器自己探测出来的**。

关键设计(斜体):*compress 是"试一把"的乐观策略——先按最好的情况分配,碰到越界字符立刻放弃重来,而不是先扫描一遍再决定。对纯 ASCII/Latin 数据(绝大多数日志、协议文本),压缩一次成功,省掉第二次遍历;对含中文的数据,多付一次失败的压缩遍历,换来的是内存减半的收益在"等全部解码完再判断"的复杂度对比下依然划算。*

### 1.5 默认 charset:乱码的第一嫌疑犯

无参 `new String(byte[])` 走 `decode(byte[], off, len)`(`StringCoding.java:328-329`):

```java
// StringCoding.java:328-329(截取核心,逐字)
static Result decode(byte[] ba, int off, int len) {
    Charset cs = Charset.defaultCharset();
```

`Charset.defaultCharset()` 的值是 JVM 启动时从平台探测的(原生编码 → file.encoding 系统属性):Windows 常见 GBK,Linux 常见 UTF-8。**同一个 byte[],同一份代码,换台机器解码结果就不同**——这就是"本地好好的,上线就乱码"的机制解释: 开发机 UTF-8 解出正常中文,生产 Windows 上 GBK 把同样的字节解成乱码串,或者反过来。

跨层标注: [内部卷: 01-os-abstraction(平台探测域,原生编码探测)];[关联: 域 19 BufferChannel——CharsetDecoder/Encoder 在 NIO 里以更低层的 Buffer 形态出现]

## 2. 为什么有两个类:StringLatin1 与 StringUTF16

### 2.1 coder 常量与分派点

第 1 篇引过两个常量(`String.java:3269-3270` 的 `LATIN1 = 0` / `UTF16 = 1`),这里看它们的消费方式。每个 String 操作的第一步都是 `isLatin1()`(`String.java:3265-3267`):

```java
// String.java:3265-3267(截取核心,逐字)
private boolean isLatin1() {
    return COMPACT_STRINGS && coder == LATIN1;
}
```

然后按结果分派到两个类的同名方法——以 equals 为例(`String.java:1009-1010`,第 2 篇逐行拆过):

```java
// String.java:1009-1010(截取核心,逐字)
return isLatin1() ? StringLatin1.equals(value, aString.value)
                  : StringUTF16.equals(value, aString.value);
```

**String 自己只做"选哪条路",具体实现全在两边**。这是紧凑字符串架构的决定性结构。

### 2.2 StringLatin1:单字节直读

`StringLatin1`(793 行)的所有操作都建立在一个事实上:**一个数组槽就是 1 个字符**。所以 equals 就是逐槽比较(`StringLatin1.java:93-100`,第 2 篇贴过全文),hashCode 就是 `31 * h + (value[i] & 0xff)`(`StringLatin1.java:193` 起),compareTo 直接比字节值——没有任何"组装"动作。charAt 更是退化成 `(char)(value[index] & 0xff)`。

### 2.3 StringUTF16:字节序的唯一处理点

`StringUTF16`(1485 行)的核心是 getChar/putChar——**UTF16 模式下,1 个字符占 2 个数组槽,字节序决定了哪一槽是高位**:

```java
// StringUTF16.java:66-71(截取核心,逐字)
static char getChar(byte[] val, int index) {
    assert index >= 0 && index < length(val) : "Trusted caller missed bounds check";
    index <<= 1;
    return (char)(((val[index++] & 0xff) << HI_BYTE_SHIFT) |
                  ((val[index]   & 0xff) << LO_BYTE_SHIFT));
}
```

`index <<= 1` 把"字符下标"换算成"字节下标";`HI_BYTE_SHIFT`/`LO_BYTE_SHIFT` 两个常量在静态块里按平台字节序决定(`StringUTF16.java:1353-1363`):

```java
// StringUTF16.java:1353-1363(截取核心,逐字)
static final int HI_BYTE_SHIFT;
static final int LO_BYTE_SHIFT;
static {
    if (isBigEndian()) {
        HI_BYTE_SHIFT = 8;
        LO_BYTE_SHIFT = 0;
    } else {
        HI_BYTE_SHIFT = 0;
        LO_BYTE_SHIFT = 8;
    }
}
```

`isBigEndian()` 是 native 方法(`StringUTF16.java:1351`),JVM 启动时探测一次,结果固化进静态常量——之后所有 getChar/putChar 不再做任何判断,直接按常量移位。同一份 String 数据在大端机和小端机上的字节布局不同,但 Java 层的所有 API 行为完全一致:**字节序差异被封装在 StringUTF16 这一处**,这正是"Java 一次编写处处运行"在字符层面的落地。

关键设计(斜体):*字节序问题用"两个静态常量 + 一处 native 探测"解决,而不是运行时每次判断——JVM 把平台差异全部收敛到启动期,运行期零成本。对比第 3 篇的 StringConcatHelper 同样直接 `StringUTF16.putChar` 写字节,所有 UTF16 字节操作最终都收敛到这 20 行。*

### 2.4 compress:从 UTF16 缩回 Latin1

第 1 篇只讲了"构造时选 coder",但 String 内部还有一条**从 UTF16 往回压**的路——`StringUTF16.compress`(`StringUTF16.java:159-189`):

```java
// StringUTF16.java:159-165 + 177-189(截取核心,逐字)
public static byte[] compress(char[] val, int off, int len) {
    byte[] ret = new byte[len];
    if (compress(val, off, ret, 0, len) == len) {
        return ret;
    }
    return null;
}

// compressedCopy char[] -> byte[]
@HotSpotIntrinsicCandidate
public static int compress(char[] src, int srcOff, byte[] dst, int dstOff, int len) {
    for (int i = 0; i < len; i++) {
        char c = src[srcOff];
        if (c > 0xFF) {
            len = 0;
            break;
        }
        dst[dstOff] = (byte)c;
        srcOff++;
        dstOff++;
    }
    return len;
}
```

1.4 节刚在 Result 里见过它的消费者。压缩失败的返回 `null`(`StringUTF16.java:164`)或者返回 `len = 0`(`StringUTF16.java:181`),上层据此决定回退 UTF16——"试一把,不行就换"的乐观策略在源码里是明摆着的。

关键设计(斜体):*JEP 254 的核心取舍: 用"每类操作写两遍"(StringLatin1 + StringUTF16 合计约 2,300 行)换"热点循环里没有 coder 分支"。如果只写一份、循环内每次判断 coder,equals/hashCode/compareTo 这些每字符迭代的方法就要在循环体里做分支预测——数据一多分支预测就是灾难。代价是代码翻倍、维护面扩大,换来内存减半 + 单字节路径无分支。面试答"JDK9 内存省一半"时能讲出这个取舍,比背"JEP 254"高一个段位。*

## 3. "一个 emoji 占两个 char" — 代理对与码点视角

### 3.1 为什么是代理对

Unicode 的码点范围到 U+10FFFF,而 Java 的 `char` 只有 16 位。方案是:**基本多文种平面(BMP,U+0000~U+FFFF)的码点一个 char 装;补充平面(U+10000 以上)用两个 char 组成的代理对(surrogate pair)表示**——一个高位代理 + 一个低位代理。`MIN_SUPPLEMENTARY_CODE_POINT = 0x010000`(`Character.java:600`)。

所以 😀(U+1F600)在 Java 里 `String.length()` 返回 2——length 数的是 **char(UTF-16 编码单元)**,不是码点。`String.length()`(`String.java:657-660`):

```java
// String.java:657-660(截取核心,逐字)
public int length() {
    return value.length >> coder();
}
```

UTF16 模式下一个字符占 2 字节,`>> coder()` 恰好把字节数折半回 char 数——注意是"编码单元数",emoji 会数出 2。

### 3.2 码点视角的 API:codePointAt

想看"真字符"要用码点 API。`Character.codePointAt(CharSequence)`(`Character.java:8267-8276`):

```java
// Character.java:8267-8276(截取核心,逐字)
public static int codePointAt(CharSequence seq, int index) {
    char c1 = seq.charAt(index);
    if (isHighSurrogate(c1) && ++index < seq.length()) {
        char c2 = seq.charAt(index);
        if (isLowSurrogate(c2)) {
            return toCodePoint(c1, c2);
        }
    }
    return c1;
}
```

逻辑:当前 char 是高位代理,且紧跟的低位代理合法 → 合并成码点返回;否则原样返回当前 char。配套的三个判断/换算:

- `charCount(int codePoint)`(`Character.java:8219-8221`):`codePoint >= MIN_SUPPLEMENTARY_CODE_POINT ? 2 : 1`——一个码点占几个 char
- `isSurrogate(char)`(`Character.java:8177-8179`):`ch >= MIN_SURROGATE && ch < (MAX_SURROGATE + 1)`——是否是代理区(不管高低)
- String 侧的反向聚合:`StringUTF16.codePointCount`(`StringUTF16.java:122-137`)——遍历时发现"高代理 + 低代理"相邻就 `count--`,把编码单元数折成码点数

### 3.3 生产陷阱:emoji 截断与孤立代理

所有按 char 截断的操作都有风险:`substring` 按 char 下标切,如果切点落在代理对中间,就产生一个**孤立代理**(孤零零的高位或低位)——它不构成任何合法字符,显示为 �,序列化/传输时还可能直接报错。生产上"用户昵称截断 10 个字符"的需求,用 `s.substring(0, 10)` 就可能切坏表情。

正确姿势是码点视角:

- 遍历:`codePointAt` 返回码点 + `Character.charCount` 推进下标
- 截断:用 `offsetByCodePoints` / `codePointCount` 先数出安全的 char 边界再切
- 反向:1 个码点 → 1-2 个 char(`toChars`/`StringUTF16.toBytesSupplementary`,`StringUTF16.java:241` 起)

关键设计(斜体):*Java 的 String 本质是 UTF-16 编码单元序列,不是码点序列——所有字符串 API 默认 char 视角,这是历史包袱: Java 设计于 1995 年,当时 Unicode 只有 BMP 的 65,536 个码点,char=16bit 是够用的;Unicode 3.1(2001)引入补充平面后,char 不够用了,但 API 已经定型。面试能说出"length 数的是编码单元"这个视角差异,就避开了'emoji 占几个 char'这类题的所有坑。*

跨层标注: [Unicode 规范: U+10000 以上码点用代理对编码];[JLS §3.1: char 是 16 位 Unicode 编码单元]

## 4. Character.isDigit('１') 为什么是 true — 查表而非算法

### 4.1 分发链:一路委托到 CharacterData

`Character.isDigit('１')`(全角数字一,U+FF11)返回 true。实现不在 Character 里——它在数据表里。看调用链(`Character.java:9038` 的 `isDigit(char)` → `Character.java:9072` 的 `isDigit(int)`):

```java
// Character.java:9072-9074(截取核心,逐字)
public static boolean isDigit(int codePoint) {
    return CharacterData.of(codePoint).isDigit(codePoint);
}
```

`isLetter`、`getType`(`Character.java:10312` 的 `getType(char)` 同样转 int 版本)、`isWhitespace` 全是同一骨架:`CharacterData.of(codePoint)` 取数据源,再调数据源的方法。分类标准是 Unicode General Category——`isDigit` 的文档写着"general category type 是 DECIMAL_DIGIT_NUMBER"(`Character.java:9038` 附近),而 U+FF11 在 Unicode 数据里的分类正是 Nd(十进制数字),所以 true——和 ASCII 的 `'0'~'9'` 无关。

### 4.2 of(int):按码点区间选表

`CharacterData.of`(`CharacterData.java:79-99`)是分发中枢:

```java
// CharacterData.java:79-99(截取核心,逐字)
static final CharacterData of(int ch) {
    if (ch >>> 8 == 0) {     // fast-path
        return CharacterDataLatin1.instance;
    } else {
        switch(ch >>> 16) {  //plane 00-16
        case(0):
            return CharacterData00.instance;
        case(1):
            return CharacterData01.instance;
        case(2):
            return CharacterData02.instance;
        case(14):
            return CharacterData0E.instance;
        case(15):   // Private Use
        case(16):   // Private Use
            return CharacterDataPrivateUse.instance;
        default:
            return CharacterDataUndefined.instance;
        }
    }
}
```

按码点的高位字节 `ch >>> 8` 或 `ch >>> 16` 快速落到一个数据实例:Latin1 区间(0-255)最快,其余按 Unicode 平面(plane)切块。每个实例都是一张**属性表**,`CharacterData.java:29` 的抽象方法 `getProperties(int ch)` 就是查表入口,`getType`/`isDigit`/`isWhitespace`/`toLowerCase` 全部基于这张表。

### 4.3 表从哪来:构建期生成,不在源码树

`CharacterDataLatin1`/`CharacterData00` 这些子类**不在源码树里**——它们由构建工具生成:`make/gensrc/GensrcCharacterData.gmk`(`SetupCharacterData` 宏,`GensrcCharacterData.gmk:57-58`)读 Unicode 官方数据文件,按版本产出一张张属性表 Java 文件,编译进 java.base。

关键设计(斜体):*字符分类是"数据问题"不是"算法问题"——Java 每升一个版本跟随 Unicode 版本更新,只是重新跑一遍生成工具,Character.java 的逻辑一行都不用改。数据与算法分离、数据由工具产出,这也是为什么你永远不该手写"`ch >= '0' && ch <= '9'`"判断数字: 那只是 ASCII 子集,而 Character.isDigit 背后是整个 Unicode 数据表。*

## 核心悬念

字符编码这层更深的形态,藏在 NIO 里: `ByteBuffer` 与 `CharsetDecoder` 把"字节↔字符"搬进了显式管理的 Buffer 状态机(关联: 域 19 BufferChannel)。但编码问题的另一面——**"编解码出错时怎么办"**——已经在这篇出现过了: `CodingErrorAction.REPLACE`、`UnsupportedEncodingException`、`StringIndexOutOfBoundsException`……异常不是边角料,它是所有代码的"错误通道"。下一篇离开字符串,把 `Throwable` 从头拆开:异常对象在 JVM 里怎么被创建、怎么传播、为什么 catch 之后堆栈会"断"。

> → 下一篇: 域 06 异常体系(06-exceptions/01-throwable-structure)
