# 03. File 与平台文件系统 — 路径抽象、UnixFileSystem、操作语义

> **前置依赖**: [17-io-streams/01 — 字节流与装饰器](01-byte-streams.md)(字节/文件流)、[06-exceptions/01 — Throwable 结构](../06-exceptions/01-throwable-structure.md)(IO 异常处理)
> → **后续**: 域 18 序列化(按写作顺序)
> 关联: 内部卷 01-os(fd 与系统调用)

## File 到底是不是“文件”

`File` 最容易被误解成“一个已经存在的文件对象”。其实它首先只是**路径抽象**,真正触盘的是后续方法调用。

## 1. "File 到底代表什么?" — 路径抽象

### 1.1 构造不触盘

`new File(String)` 在 `File.java:276` 开始,核心只是把传入字符串规范化后存进 `path` 字段(`:280`)。

这一步不会检查磁盘上是否存在文件,也不会知道它将来代表的是普通文件、目录还是根本不存在的路径。

### 1.2 纯路径操作

- `getPath()`(`File.java:516`)——返回当前保存的路径字符串
- `getAbsoluteFile()`(`:576`)——将路径解析为绝对路径;相对路径以当前用户目录为基准

这些都属于路径层计算,不是磁盘 IO。

关键设计(斜体):*File = 路径的抽象表示,不是已打开的文件句柄。面试"new File 会不会失败": 一般不会,因为构造阶段只是在存字符串。*

## 2. "exists() 背后是什么?" — FileSystem 委托

### 2.1 Java 层入口

`exists()`(`File.java:823`)并不自己查磁盘,而是委托 `FileSystem` 抽象。`File` 内部持有平台文件系统单例 `fs`(`:155`)。

`length()`(`:989`)和 `createNewFile()`(`:1029`)也都是继续委托给 `fs`。

### 2.2 Unix 平台实现

在 unix 版本里:

- `getBooleanAttributes0(File)`(`UnixFileSystem.java:250`)——native 获取存在性/类型属性
- `getLength(File)`(`:261`)——native 取文件长度
- `createFileExclusively(String)`(`:266`)——native 原子创建

`createNewFile()` 走的是 `fs.createFileExclusively(path)`(`File.java:1035`),因此“已存在则失败”的语义来自底层原子创建,不是 Java 层先 `exists()` 再创建。

关键设计(斜体):*平台差异被封装在 FileSystem 抽象里——Java 层 API 一致,真正的 exists/length/create 由平台实现负责。面试"createNewFile 为什么原子": 因为它直接走底层独占创建,不是先查再建。*

## 3. "目录操作" — list/listFiles/mkdirs

### 3.1 列目录

- `list()`(`File.java:1137`)——返回目录项名字数组
- `listFiles()`(`:1257`)——在 `list()` 的结果上再包装成 `File[]`

所以 `listFiles()` 不是更底层的系统调用,而是 `list()` 结果的二次包装。

### 3.2 创建与删除

- `mkdirs()`(`:1390`)——逐级创建缺失父目录
- `delete()`(`:1056`)——删除文件或空目录,不会递归删除非空目录

这就是为什么删除目录常失败: Java 没有帮你自动做递归遍历与子项清理。

关键设计(斜体):*目录操作是“路径 API + 平台语义”的组合——list 是目录项读取,mkdirs 是逐级创建,delete 不是递归删除。面试"为什么删不掉目录": 因为目录必须先清空。*

## 4. "FileDescriptor" — fd 的 Java 影子

### 4.1 标准描述符

`FileDescriptor`(`FileDescriptor.java:48`)内部持有 `int fd`(`:50`)。

JDK 预置了三个标准描述符:

- `in`(`:150`) → fd 0
- `out`(`:158`) → fd 1
- `err`(`:167`) → fd 2

### 4.2 为什么要关流

`valid()`(`:176`)只是检查这个描述符是否仍然有效。真正稀缺的是底层操作系统资源: 打开的文件描述符数量是有上限的。

所以“关闭流”不是礼貌问题,而是避免 fd 泄漏。`FileInputStream/FileOutputStream` 最终都围绕 `FileDescriptor` 与 native open/close 运转。

关键设计(斜体):*FileDescriptor 是 OS 资源句柄在 Java 里的影子。面试"为什么必须关闭流": 不关就会泄漏 fd,最终耗尽进程的打开文件上限。*

## 核心悬念

文件路径和字节流都明白了——**对象怎么整体进出**?下一步进入序列化: `Serializable`、`ObjectOutputStream`、`serialVersionUID` 与反序列化风险。