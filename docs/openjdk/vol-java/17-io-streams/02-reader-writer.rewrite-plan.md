# 17-io-streams/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Reader`、`Writer`、`InputStreamReader`、`OutputStreamWriter`、`sun.nio.cs.StreamDecoder`、`StreamEncoder`。本文聚焦字符流抽象、字节/字符桥接、默认编码风险、Reader/Writer 与字节流边界，以及 PrintWriter/PrintStream 的错误处理语义；不展开 NIO Charset API 全景。
> 目标：把“字符流与字节桥接”改写成一篇围绕“字符流不是另一套 IO，而是字节流上叠加编码解码器的桥；乱码、默认编码和吞异常问题都发生在这座桥附近”的机制文章。

## 1. 读者困惑

- `Reader`/`Writer` 和 `InputStream`/`OutputStream` 到底是两套独立体系，还是同一体系的不同视角？
- 为什么文本文件一定要经过 charset 才能从字节变成字符，乱码为什么总出在桥接层？
- `InputStreamReader`、`OutputStreamWriter` 到底在帮你做什么，它们为什么都把真正工作交给 `StreamDecoder/StreamEncoder`？
- `FileReader` / `FileWriter` 为什么经常被说“方便但危险”？
- `PrintWriter` / `PrintStream` 为什么喜欢把写错误吞成内部状态，而不是直接抛 IOException？

## 2. 一句话顿悟

**字符流不是另一套完全独立的 IO，而是“字节流 + 编码解码器”的桥接封装：Reader/Writer 把读写单位提升成字符，但底层仍要靠字节输入输出；`InputStreamReader` / `OutputStreamWriter` 只是门面，真正把 bytes ↔ chars 交给 `StreamDecoder` / `StreamEncoder` 与 CharsetDecoder/Encoder。也正因为如此，默认编码、桥接方向和错误处理方式一旦选错，乱码或静默失败就会立刻暴露出来。**

## 3. 旧稿优点与问题

### 保留

- 已抓住“字符流 = 字节流 + 编码解码器”这条主线。
- 已覆盖 InputStreamReader / StreamDecoder、FileReader 默认编码风险，以及 PrintStream/PrintWriter 的 checkError 语义。
- 已把文件系统和 Reader/Writer 分开，篇章边界合理。

### 必须重写

- 旧稿仍偏概念条目，需要更强开场问题：乱码和默认编码为什么总发生在桥上而不是流两端。
- Reader/Writer 的“抽象单位不同”要回扣到桥接层，而不是只做对照表。
- FileReader 风险需要更明确地讲成“默认编码把环境差异隐藏起来”的失败方案。
- PrintStream/PrintWriter 的异常处理要回到“为什么控制台友好 API 选择内部状态而非显式异常”这条设计取舍上。

## 4. 理解路径

### 第一节：从“为什么文本一换机器就乱码”开场

用 UTF-8 文件在默认编码不同机器上读出乱码的场景开场。先立住总问题：文本问题并不发生在磁盘字节本身，而是发生在“这些字节被解释成字符”的桥接层。

### 第二节：Reader/Writer 为什么不是独立 IO，而是提升了处理单位

证据：
- `Reader.java:54`
- `Writer.java:51`
- `Writer.java:71-72`（写接口概览注释）

主线：
- Input/OutputStream 关心字节；Reader/Writer 关心字符单元。
- 但字符不会凭空存在，必须从字节按 charset 解出来，写出时再编码回字节。
- 因此字符流是桥接视角，不是另一套物理通道。

### 第三节：InputStreamReader / OutputStreamWriter 为什么只是门面

证据：
- `InputStreamReader.java:62-64`
- `InputStreamReader.java:73/96/112/128`
- `OutputStreamWriter.java:76-78`
- `OutputStreamWriter.java:99/109/129/148`
- `StreamDecoder.java:37/60/75/82/248`
- `StreamEncoder.java:36/49/64/71/193`

主线：
- Reader/Writer 桥接类本身不直接实现编码细节，它们只是持有 `StreamDecoder` / `StreamEncoder`。
- 真正的字节缓冲、CharsetDecoder/Encoder 交互都在后者里完成。
- 这解释了为什么“字节怎么变字符”不是 InputStreamReader 一行代码的事，而是桥内部完整解码状态机的事。

### 第四节：默认编码为什么是 FileReader/FileWriter 最大的隐藏风险

证据：
- `InputStreamReader.java:73`：默认 charset 构造
- `InputStreamReader.java:96/112/128`：显式指定编码三种入口
- （若正文需要可补 FileReader/FileWriter 具体构造源码，但核心风险已能靠桥接入口讲清）

主线：
- 无显式 charset 时，桥会回落到环境默认编码。
- 这让“同一份字节”在不同机器/区域设置下被解释成不同字符，乱码于是发生。
- 所以 FileReader/FileWriter 的问题不是不能用，而是它把编码选择交给了环境。

### 第五节：PrintStream / PrintWriter 为什么把错误变成可查询状态

证据：
- PrintStream / PrintWriter 相关源码位置在现有旧稿已有方向；正文先讲设计取舍，再按需补精确锚点

主线：
- 控制台/日志打印类 API 优先追求“调用方少写 try/catch”。
- 代价是把 IOException 转成内部 `trouble` 状态，再由 `checkError()` 暴露。
- 这不是更安全，只是更偏向易用；在真正需要可靠写错误处理的路径上就不该无脑依赖它们。

## 5. 失败方案清单

1. 把文本文件按字节流直接拼成字符，忽略 charset 解码。
2. 依赖默认编码读取/写出跨平台文本。
3. 以为 InputStreamReader/OutputStreamWriter 自己就完成了全部字符处理逻辑，不用关心内部解码/编码器。
4. 用 PrintWriter/PrintStream 打印关键输出，却从不检查错误状态。
5. 看到 Reader/Writer 就以为它们天然更适合任何数据，包括二进制协议。

## 6. 误解清单

1. Reader/Writer 是和 InputStream/OutputStream 平行的另一套独立 IO 世界。
2. 乱码问题主要发生在文件内容本身，而不是字节到字符的解释过程。
3. 默认编码大多数时候都一样，可以忽略。
4. PrintWriter/PrintStream 不抛 IOException 说明写出一定安全。
5. InputStreamReader 只是“给 InputStream 起个字符别名”。

## 7. 证据清单

- `Reader.java:54`：类定义
- `Writer.java:51`：类定义
- `Writer.java:71-72`：写接口注释概览
- `InputStreamReader.java:62-64`：类与 `StreamDecoder` 字段
- `InputStreamReader.java:73/96/112/128`：不同编码入口
- `OutputStreamWriter.java:76-78`：类与 `StreamEncoder` 字段
- `OutputStreamWriter.java:99/109/129/148`：不同编码入口
- `StreamDecoder.java:37/60/75/82/248`：类与工厂入口 / 解码器字段
- `StreamEncoder.java:36/49/64/71/193`：类与工厂入口 / 编码器字段

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦桥接角色与编码边界，不展开 Charset/CharsetDecoder 全部 API 与错误恢复策略。
- PrintStream/PrintWriter 部分强调设计取舍，不替代完整控制台 IO 专题。
- File 系统路径、权限与平台差异留给下一篇文件系统专题。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“字符流为什么是字节流上的桥 → 字节如何经 StreamDecoder/Encoder 变成字符/再编码回字节 → 默认编码为什么会埋跨平台乱码风险 → PrintWriter/PrintStream 为什么把错误转成可查询状态”。
- 必须把乱码风险讲成桥接层问题。
- 必须自然引到 `03-file-filesystem.md`。
