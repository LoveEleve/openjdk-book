# 字符编码与 Unicode — 乱码如何从字节边界一路产生

> 基于 JDK 11 `java.base` 的 `StringCoding`、`StringLatin1`、`StringUTF16` 与 `Character` 实现。本文讨论的是 JDK 11 字符解码与存储链，不把这里的默认 charset 行为、U+FFFD 错误策略和 Compact Strings 双路径外推成所有 JDK 版本或所有文本处理的统一规范。
> **前置依赖**: [String 为什么是不可变的](01-storage-immutable.md)(byte[]+coder)、[字符串构建与拼接](03-build-concat.md)(coder/Unicode 写入)
> → **后续**: 按写作顺序进入异常体系

## 先看一次真实乱码

假设服务把文本按 UTF-8 写出，另一端却按 GBK 解码。接收方拿到的不是“带着文字的字节”，而是一串必须由某个 charset 解释的数值。解释规则错了，错误就已经发生在**字节 → 字符**的边界。

很多乱码排查最后只说“编码不一致”，却没有继续追：

```text
外部 byte[]
   → charset 选择
   → CharsetDecoder / 快路径
   → 字符序列
   → String 的 LATIN1/UTF16 内部表示
   → length/charAt 或 codePoint API
```

这条链上任意一层的假设错了，最终都可能表现成乱码、替代字符或 emoji 被截断。

## 一、StringCoding：字节怎样变成 String

### 1. 三个构造入口，最后汇到同一条边界

JDK 11 的字节构造有三种常见形态：

- `String(byte[], offset, length, charsetName)`(`String.java:461`)
- `String(byte[], offset, length, Charset)`(`:502`)
- `String(byte[], offset, length)`(`:590`)，使用默认 charset

它们的共同点不是“最后都创建了 String”，而是：**都要先决定用什么 charset 解释原始字节**。

### 2. charset 选择与快路径

`StringCoding.decode(String charsetName, ...)`(`StringCoding.java:225`)会先查找 charset。JDK 对高频字符集提供专门路径：

- UTF-8 → `decodeUTF8`
- ISO-8859-1 → `decodeLatin1`
- US-ASCII → `decodeASCII`
- 其他字符集 → `StringDecoder` 与通用 CharsetDecoder 路径

这不是“UTF-8 比 GBK 更特殊”的语义判断，而是 JDK 对常用路径的实现优化。ThreadLocal 中还缓存 SoftReference 包装的 decoder(`StringCoding.java:66-68`),减少反复创建解码器的成本。

### 3. 默认 charset 是事故放大器

无参 `new String(bytes)` 并没有凭空知道字节编码，它使用启动环境提供的默认 charset。开发机和生产机的默认值不同，同一组字节就可能得到不同字符。

生产边界很明确：文件、网络协议、消息队列等外部边界必须显式写明 charset，不能把默认 charset 当成协议。

关键设计(斜体):*乱码的第一嫌疑不是 String 内部存储，而是字节进入 String 时的 charset 选择。先确定协议编码,再讨论后面的 coder 和 Unicode。*

## 二、解码失败：替代字符从哪里来

### 1. 失败方案为什么危险

一个看似方便的方案是：遇到非法输入就替换成某个字符，然后继续把结果写入数据库或消息队列。这样程序可能“不报错”，但原始数据已经丢失，后面无法知道哪些字符是替代结果。

### 2. JDK 的默认处理

StringCoding 中的 decoder 会配置：

- `onMalformedInput(CodingErrorAction.REPLACE)`(`StringCoding.java:164`)
- `onUnmappableCharacter(CodingErrorAction.REPLACE)`(`:165`)

因此非法字节序列或无法映射的字符可能被替换为 U+FFFD，也就是常见的 `�`。

这解释了一个现象：乱码不一定表现为异常，有时表现为一个“看起来合法”的替代字符。需要严格数据时，业务应在更底层显式使用 `CharsetDecoder` 并选择 REPORT 策略，而不是接受默认替换。

关键设计(斜体):*REPLACE 保证了字符串管线继续运行,但牺牲了原始数据可恢复性。日志展示可以接受替换,协议/账务/持久化数据则应考虑报告错误并拒绝继续。*

## 三、解码结果：coder 如何选择内部存储

解码完成后，String 仍然不会把外部 UTF-8 字节原样保存进 `value`。它先得到字符语义，再按 JDK 11 Compact Strings 规则选择内部表示：

```text
字节 + charset
      ↓ decode
字符语义
      ↓ 能否全部用 Latin-1 表示
LATIN1 byte[]       或       UTF16 byte[]
```

因此这三个长度不能混为一谈：

- 外部 UTF-8 字节数
- Java `String.length()` 的 UTF-16 code unit 数
- 内部 `value.length` 的字节数

它们可能完全不同。比如一个补充平面 emoji 在 UTF-8 中占多个字节，在 Java 字符串里占两个 UTF-16 code unit，内部 Compact Strings 则使用 UTF16 表示。

关键设计(斜体):*UTF-8 是外部编码,Latin1/UTF16 是 JDK 当前内部存储路径,UTF-16 code unit 又是 Java API 的字符单位。乱码排查必须先问“我现在讨论的是哪一层长度”。*

## 四、字符与码点：emoji 为什么 length 不是 1

### 1. Java 的 char 视角

Java String 的很多基础 API 以 UTF-16 编码单元为单位：`length()` 统计 code unit 数，`charAt()` 取一个 `char`。补充平面字符通常使用高代理 + 低代理两个 `char`。

因此 emoji 可能出现：

```text
一个 Unicode code point
        ↓ UTF-16
两个 char/code unit
```

### 2. 正确的码点 API

`Character.isSurrogate(char)`(`Character.java:8177`)判断代理，`charCount(int)`(`:8219`)告诉你一个 code point 需要多少 code unit，`codePointAt(CharSequence, int)`(`:8267`)按码点读取。

失败方案是按 `char` 位置随意截断字符串。截在代理对中间，就会留下孤立代理，最终显示异常或在后续编码时失败。

生产中需要按 Unicode 字符遍历或截断时，应使用 code point 相关 API，而不是把 `length()` 当作用户可见字符数。

关键设计(斜体):*String 的基础存储与许多 API 是 UTF-16 code unit 视角,不是“一个可见字符一个位置”。需要处理 emoji/补充平面字符时,必须显式切换到 code point 视角。*

## 五、Character：分类为什么查表

`Character.isDigit/isLetter/isWhitespace` 不是用几个 ASCII 范围判断完成的。Unicode 字符分类本质上是数据问题：每个 code point 对应一组属性。

`CharacterData` 的抽象方法集合(`CharacterData.java:28-46`)定义了分类能力，`CharacterData.of(int)`(`:79-97`)再按 code point 区间选择相应实现，最后由数据表返回属性。这里的 `CharacterDataLatin1/00/01/02/0E` 等子类是构建阶段生成的数据，不应误读成一套手写的“万能判断算法”。

失败方案：

```text
ch >= '0' && ch <= '9'
```

这只能覆盖 ASCII 数字，不能代表 Unicode 的全部数字字符。需要 Unicode 语义时，应使用 `Character` 分类 API。

关键设计(斜体):*字符分类是“数据表 + 版本”的问题,不是简单字符算术。Unicode 数据更新时,分类结果也可能随 JDK 数据版本变化。*

## 六、五个最容易混掉的边界：UTF-8 不是内部存储，new String(bytes) 不跨平台稳定，U+FFFD 不是 JVM 改字，length() 不是字符数，isDigit 也不只看 ASCII

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，UTF-8 不是 String 的内部存储格式。它是外部字节层的编码；JDK 11 的 String 内部使用 LATIN1 或 UTF16 两套由 `coder` 选择的表示。把 UTF-8 当成内部存储，就会把“外部字节数”和“内部 value 长度”混为一谈。

第二，`new String(bytes)` 也不跨平台稳定。它使用启动环境的默认 charset，开发机和生产机默认值不同，同一组字节就可能解出不同字符。外部边界必须显式写明 charset，不能把默认值当成协议。

第三，看到 U+FFFD（``）也不是 JVM 随机改了字符。它通常来自 `CharsetDecoder` 的 `CodingErrorAction.REPLACE` 策略，是非法字节序列或不可映射字符被替换后的结果；如果需要保住原始数据，应改用 REPORT 策略并拒绝继续处理。

第四，`String.length()` 返回的也不是用户可见字符数。它返回 UTF-16 code unit 数，补充平面 emoji 通常算两个位置。要按 Unicode 字符遍历、截断或计数，必须使用 `codePointAt`/`codePointCount` 这类 code point API。

第五，`Character.isDigit` 更不是只认 ASCII 0-9。它依据 Unicode 字符分类数据表，`ch >= '0' && ch <= '9'` 只覆盖 ASCII 范围，无法代表 Unicode 的全部数字字符。

把这五条边界记稳，字符编码这一篇就不会重新塌回“乱码就是编码不一致”的表面结论。它真正想讲的是：乱码发生在字节 → 字符的解码边界，而 String 内部存储、UTF-16 视角和 Unicode 分类数据各是一层需要分清的问题。

## 收网：四步排查乱码

1. **确认字节来源**：文件、网络、数据库、消息协议到底规定了什么 charset。
2. **拒绝隐式默认值**：构造 String、Reader、Writer 时显式传 charset。
3. **检查错误策略**：U+FFFD 是替代结果，不要把数据损坏伪装成正常文本。
4. **区分长度单位**：byte 数、UTF-16 code unit 数、Unicode code point 数分别回答不同问题。

String 内部接收解码后的字符结果，再按照当前 JDK 的 Compact Strings 规则重新编码存储；真正决定“这串字节是什么意思”的，是进入 String 之前的 charset 边界。

下一步进入异常体系，但这篇的诊断结论可以独立复用：**先确认编码协议，再看解码策略，最后才看 String 内部存储和 Unicode 遍历。**