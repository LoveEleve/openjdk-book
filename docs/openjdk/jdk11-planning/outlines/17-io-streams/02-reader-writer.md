# 02. 字符流与字节桥接 — Reader/Writer、StreamDecoder、编码链路

> 🔴 Deep | 域 17 IO 流体系第 2 篇 | Layer 2
> 读者处境: 面试"字节流和字符流区别"+"FileReader 乱码"——桥接层的 CharsetDecoder 是答案核心,衔接域 01 编码。

### 1. "Reader 和 InputStream 什么关系？" — 字符单位 vs 字节单位

场景: 面试"字节流和字符流的区别"——标准答案怎么组织?

- `Reader.java:391` — 抽象字符流: `read()`(208)返回 **int(0-65535 的 char 值或 -1 EOF)**(UTF-16 编码单元,域 01),`read(char[])`
- `Writer.java:421` — `write(int)/write(String)/write(char[])`
- 分工: InputStream/OutputStream = 二进制;Reader/Writer = 文本——**选择依据: 数据是文本还是二进制**
- 字符流内部最终还是要字节——**桥接层**负责转换
- 关键设计 (斜体): *字符流不是"独立 IO",是"字节流 + 解码器"的封装——面试答"字符流处理文本避免手动转码"只是表面,能说出桥接层才完整*
- 面试: "二进制文件用什么?"——字节流(字符流会按编码解码破坏数据)

### 2. "InputStreamReader 怎么转码？" — StreamDecoder 桥

场景: `new InputStreamReader(fis, "UTF-8")` — 读到 char 前发生了什么?

- `InputStreamReader.java:64` — `private final StreamDecoder sd` — 核心委托给 StreamDecoder(`sun/nio/cs/StreamDecoder.java:37`)
- `InputStreamReader.java:163` `read()` / `180` `read(char[], off, len)` → `StreamDecoder.read` — 内部 `CharsetDecoder`(`StreamDecoder.java:234`)解码
- 流程: 底层读字节(内部缓冲)→ CharsetDecoder.decode → char
- 关键设计 (斜体): *StreamDecoder 自带内部字节缓冲(把"解码前的字节读取"也批量化了);乱码排查链路: 字节来源(文件/网络)→ 解码器(Charset)→ String(域 01 StringCoding)——两层解码,错一层就乱码*
- [C++: 内部卷 01-os(底层 read 系统调用路径);关联: 域 01 StringCoding(同一 CharsetDecoder 体系)]

### 3. "FileReader 的坑" — 默认编码

场景: 生产"FileReader 读出来乱码"——为什么推荐指定编码?

- `FileReader.java:122` — 只是 `InputStreamReader` 的快捷类: `new FileReader(f)` = `new InputStreamReader(new FileInputStream(f))` — **用默认 charset**
- 默认 charset = 启动时探测(域 01)——**换环境(Windows GBK/Linux UTF-8)行为不同**
- 关键设计 (斜体): *FileReader/FileWriter 是"方便但有陷阱"的快捷类: 编码不可控;生产规范: 显式 `new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8)`*
- 面试: "FileReader 有什么问题?"——默认编码跨平台不一致;JDK11 无参构造仍存在(后续 JDK 版本才标记废弃,JDK11 源码中无 Deprecated 注解)
- [关联: 域 01 默认 charset 探测(File.encoding)]

### 4. "PrintStream/PrintWriter 的异常去哪了？" — checkError 语义

场景: `System.out.println("x")` 写失败为什么不抛 IOException?

- `PrintStream.java:1213` / `PrintWriter.java:1153` — println/printf/format 全家;**写方法不抛 IOException**(内部捕获)
- 异常状态: 内部 `trouble` 标志 + `checkError()` 查询——"吞异常"但可查询
- `System.out` 就是 PrintStream(域 03 System 门面)——自动 flush 配置
- 关键设计 (斜体): *设计动机: println 用于 UI/日志场景,"写失败"不应中断业务;代价: 静默丢数据——生产日志写入失败难发现,checkError 定期检查或换 Logback(域外)*
- 面试: "System.out 为什么吞异常"——可读性优先于可靠性;日志框架用字节流(域外)

---

### 核心悬念

流处理的是"数据内容",但文件**本身**——路径、存在性、删除、权限——是 `File` 类的事。`File` 到底是不是文件?`createNewFile` 为什么是原子的?平台差异怎么藏的?——下一篇: File 与平台文件系统。

> → [03-file-filesystem.md](03-file-filesystem.md)
