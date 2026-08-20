# 04. 字符编码与 Unicode — StringCoding 编解码、双路径存储、codePoint

> 🟡 Working | 域 01 字符串体系第 4 篇 | Layer 0
> 读者处境: 线上乱码问题——"UTF-8 存,GBK 读"为什么会产生 �?从 String 的构造/编码流程找答案。

### 1. "字节 → 字符串" 的入口 — StringCoding.decode

场景: `new String(byte[], "UTF-8")` — 字节流怎么变成字符?

- `String.java:3252` 构造汇聚 → `StringCoding.decode(charsetName, bytes, offset, length)`
- `StringCoding.java:416` `encode(String charsetName, byte coder, byte[] val)` / decode 镜像
- 流程: `Charset.forName(name)` → `CharsetDecoder.decode` → 按解码结果选择存储 coder:
  - 解码结果全是 Latin-1 可表示 → LATIN1 单字节存储(compact)
  - 否则 → UTF16 双字节存储
- 快路径: `decodeASCII`(`StringCoding.java:543`,ASCII 透明传输)、`decodeLatin1`(`StringCoding.java:593`)与编码侧 `encode8859_1`(`StringCoding.java:615`)——绕过完整 CharsetDecoder 流水线,直接查表/按字节截断
- 关键设计 (斜体): *默认 charset(File.encoding)在 JVM 启动时探测(内部卷 OS 抽象),`new String(bytes)` 无参版本用默认 charset——生产乱码根因之一: 不同环境默认字符集不同*
- 替代/修复语义: decode 遇到非法序列用 U+FFFD 替换——`StringDecoder`(`StringCoding.java:348`,ThreadLocal 缓存解码器)配置 `CodingErrorAction.REPLACE`(`StringCoding.java:164-165`)——这就是"�"的来源

### 2. "为什么有 StringUTF16 和 StringLatin1 两个类？" — 紧凑字符串双路径

场景: 面试"JDK9 之后 String 内存省一半"——省在哪、怎么省的?

- `String.java:3269-3270` — `LATIN1=0 / UTF16=1` 两个 coder 常量
- `StringLatin1.java`(793 行): 单字节数组操作——getChar 就是 val[i],equals/hashCode/compareTo 全部单字节快路径
- `StringUTF16.java`(1485 行): 双字节操作——`getChar(byte[] val, int index)` 处理字节序(`StringUTF16.java:1351-1360` native `isBigEndian()` 静态块决定 HI/LO_BYTE_SHIFT),`compress`(`StringUTF16.java:159`)把 UTF16 压缩成 Latin1
- 分派点: String 的每个操作 `isLatin1() ? StringLatin1.xxx : StringUTF16.xxx`(如 `String.java:1009`)
- 关键设计 (斜体): *没有用"一个方法内判断"而是"两个类各实现一遍"——避免热点循环里每次迭代做 coder 分支预测;代价是代码翻倍(两个类 ~2,300 行)。性能 vs 维护性的取舍*
- [JEP 254: Compact Strings — JDK9 官方动机: 典型应用字符串大多 Latin-1 可表示,内存减半]

### 3. "一个字符可能占两个 char" — codePoint 与代理对

场景: 😀(emoji,U+1F600)在 char[] 里占几个位置?`String.length()` 返回 2

- UTF-16 编码: 补充平面字符(U+10000 以上)用**代理对**(surrogate pair)——高位代理 + 低位代理两个 char 表示一个码点
- `Character.java:8267` `codePointAt(CharSequence seq, int index)` — 解析代理对
- `Character.java:8219` `charCount(int codePoint)` — 返回 1 或 2
- `Character.java:8177` `isSurrogate(char)` — 判断孤立代理
- 陷阱: `String.charAt`/`length` 是**编码单元**(char)视角;`codePointAt`/`codePointCount` 是**码点**视角——遍历含 emoji 的字符串必须用码点 API,否则乱码/截断(生产 emoji 截断 bug 的根源)
- 关键设计 (斜体): *Java 的 String 本质是 UTF-16 编码单元序列(JLS 定义 char=16bit),不是码点序列——所有字符串 API 默认 char 视角,这是历史包袱(Java 早于 Unicode 3.1)*
- [Unicode 规范: U+10000 以上用代理对编码;JLS §3.1]

### 4. Character 的分类 — 查表而非算法

场景: `Character.isDigit('１')` 全角数字返回 true——怎么实现的?

- `Character.java`(10,715 行,域内最大): `getType(char)`(`Character.java:10312`)→ `CharacterData.of` 查表
- `CharacterData.java:29` — 抽象方法 `getProperties(int ch)`;分发点 `of(int)`(`CharacterData.java:79-91`)按码点区间选 CharacterDataLatin1/00/01/02/0E 实例——**这些子类由构建工具生成**(`make/gensrc/GensrcCharacterData.gmk`),不在源码树,查表实现按 Unicode 数据自动产出
- 分类: isLetter/isDigit/isWhitespace 全部基于 type 字段(按 Unicode General Category)
- 关键设计 (斜体): *字符分类是数据问题不是算法问题——Unicode 版本升级只需重新生成数据表(CharacterData 由 generate 工具产出),Java 每个版本随 Unicode 版本同步更新*
- 面试点: 不要用 char 运算判断数字(`ch >= '0' && ch <= '9'` 只覆盖 ASCII),用 Character.isDigit

---

### 核心悬念

字符进了 String,字符串进了常量池、HashMap、线程栈——**如果这个 String 是类名、是 URL、是 SQL,它可能根本不该是 String**。但更紧迫的是: 字符编码问题在 NIO(ByteBuffer 与 Charset)里还会以更底层的形式出现。先转向第 2 篇目标域——但在此之前,异常体系是所有代码的"错误通道",下一篇先把 Throwable 讲清楚。

> → 下一篇: 域 06 异常体系(06-exceptions 系列) | 关联: 域 19 BufferChannel(CharsetEncoder/Decoder)
