# 02. 字符流与字节桥接 — Reader/Writer、StreamDecoder、编码链路

> **前置依赖**: [17-io-streams/01 — 字节流与装饰器](01-byte-streams.md)(字节流基础)、[01-string/04 — 编码与 Unicode](../01-string/04-encoding-unicode.md)(Charset/编码)
> → **后续**: 按写作顺序进入 File 与平台文件系统

## 字节怎么变成字符

字符流不是另一套独立 IO,而是**字节流 + 编码解码器**的桥接封装。乱码问题几乎都出在这条桥上。

## 1. "Reader 和 InputStream 什么关系?" — 字符单位 vs 字节单位

### 1.1 抽象差异

- `Reader`(`Reader.java:54`)处理字符单元,抽象的子类契约是 `read(char[], int, int)`
- `Writer`(`Writer.java:51`)处理字符输出,核心写接口是 `write(char[], int, int)`/`write(int)`/`write(String)`(`Writer.java:193/248`)
- `InputStream`/`OutputStream` 处理的是原始字节

选择标准很简单:

- 数据是**二进制协议/图片/压缩包** → 字节流
- 数据是**文本** → 字符流

### 1.2 为什么不能混用

字符流一定要经过 charset 解释字节;如果拿字符流去读二进制文件,解码器会按编码规则重组字节,数据语义就被破坏了。

关键设计(斜体):*字符流不是独立 IO,而是字节流上叠了一层解码器。面试"字符流和字节流区别": 文本语义 vs 原始字节。*

## 2. "InputStreamReader 怎么转码?" — StreamDecoder 桥

### 2.1 桥接对象

`InputStreamReader`(`InputStreamReader.java:62`)内部持有 `StreamDecoder`:

- 默认编码构造: `StreamDecoder.forInputStreamReader(..., Charset.defaultCharset())`(`:73-74`)
- 指定 charsetName: `:96`
- 指定 `Charset`: `:112`
- 指定 `CharsetDecoder`: `:128`

### 2.2 实际流程

`InputStreamReader` 的读取最终委托给 `sun.nio.cs.StreamDecoder`(`StreamDecoder.java:37`)。

流程是:

1. 底层字节流读入字节缓冲
2. `CharsetDecoder` 解释字节序列
3. 产出 `char`/`char[]`

这就是“字节桥接成字符”的真实位置。

关键设计(斜体):*桥接层 = 底层读字节 + 上层做解码。面试"InputStreamReader 做了什么": 它本质上是 StreamDecoder 的门面。*

## 3. "FileReader 的坑" — 默认编码

### 3.1 快捷类本质

`FileReader`(`FileReader.java:46`)只是 `InputStreamReader` 的快捷包装:

- `new FileReader(String)` → `super(new FileInputStream(fileName))`(`:60`)
- `new FileReader(File)` → `super(new FileInputStream(file))`(`:75`)

也就是说,无显式 charset 的 FileReader 会走默认编码链路。

### 3.2 为什么会乱码

默认 charset 依赖运行环境。相同文件在不同机器/区域设置下,默认 charset 可能不同,于是同样字节会被解释成不同字符。

生产上更稳妥的写法是显式指定 `StandardCharsets.UTF_8`。

关键设计(斜体):*FileReader/FileWriter 的问题不是“不能用”,而是编码不可控。面试"FileReader 有什么坑": 默认编码跨平台不一致。*

## 4. "PrintStream/PrintWriter 的异常去哪了?" — checkError 语义

### 4.1 吞异常设计

`PrintStream` 内部有 `trouble` 标志(`PrintStream.java:68`),`checkError()`(`:469`)用来查询写入错误状态。

这类 API 的设计取向是: `println/printf/format` 等调用不把 `IOException` 暴露给调用者,而是把失败记录到内部状态。

### 4.2 代价

好处是调用方便,尤其适合 `System.out` 这类控制台输出;代价是写失败可能变成静默问题,必须额外检查 `checkError()` 才能发现。

关键设计(斜体):*PrintStream/PrintWriter 把“写失败”从显式异常改成可查询状态。面试"System.out 为什么不抛 IOException": 为了简化打印场景,代价是可能静默失败。*

## 核心悬念

流处理的是内容,但文件本身——路径、存在性、删除、权限——是 `File`/文件系统 API 的问题。下一步看 File 与平台文件系统。