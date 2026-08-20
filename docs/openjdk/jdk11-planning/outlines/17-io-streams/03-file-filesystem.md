# 03. File 与平台文件系统 — 路径抽象、UnixFileSystem、操作语义

> 🟡 Working | 域 17 IO 流体系第 3 篇 | Layer 2
> 读者处境: 生产"删不掉文件/创建失败"——File 的每个操作背后是平台层 native;面试"File 是文件吗?"的答案在类设计里。

### 1. "File 到底代表什么？" — 路径抽象

场景: `new File("/tmp/a.txt")` — 这个对象是文件吗?

- `File.java:276` `public File(String pathname)` — **只是路径字符串的封装**(String path 字段),不访问磁盘
- "文件"语义: 可能指向文件/目录/不存在路径——**存在性需要 exists() 确认**
- `File.java:516` `getPath()` / `576` `getAbsoluteFile()` — 路径字符串操作(纯计算)
- 关键设计 (斜体): *File = "路径的抽象表示"(lazy,不触盘);所有磁盘操作(exists/length/delete)都走平台层 native——面试"new File 会失败吗?"——不会,构造只是存字符串*
- 对照: 域 20 已裁剪的 NIO.2 Path(JDK7+ 更完整的路径模型);File 是遗留 API 但仍在生产使用
- 面试: "File vs Path"——File 功能弱(NIO.2 有 WatchService 等);面试偶尔问

### 2. "exists() 背后是什么？" — UnixFileSystem native 边界

场景: `file.exists()` 返回 false——它真的查了磁盘吗?查的什么?

- `File.java:823` `exists()` → `fs.getBooleanAttributes(this)` — **委托 FileSystem 抽象**
- unix 平台实现: `UnixFileSystem.java:250` `getBooleanAttributes0(File)` — **native 方法** → stat 系统调用
- `File.java:989` `length()` → `UnixFileSystem.getLength(261)` native
- `File.java:1029` `createNewFile()` → `createFileExclusively`(`UnixFileSystem.java:266`)— **原子创建**(O_CREAT|O_EXCL,已存在则失败——并发安全)
- 关键设计 (斜体): *平台差异封装在 FileSystem 抽象(Windows/NTFileSystem vs Unix)——Java 层用同一套 API;createNewFile 的原子性是"文件锁"的廉价替代(进程间互斥标记)*
- [内核: stat(2)/open(2) O_EXCL 语义;man 2 stat / man 2 open]
- 面试: "怎么实现进程间互斥?"——createNewFile 原子创建(存在即失败)是经典方案

### 3. "目录操作" — list/listFiles/mkdirs

场景: 遍历目录/创建多级目录——内部怎么工作?

- `File.java:1137` `list()` → `UnixFileSystem.list0`(native,读目录项)
- `File.java:1257` `listFiles()` — list() + File 包装(过滤 FilenameFilter/FileFilter)
- `File.java:1390` `mkdirs()` — 逐级创建缺失父目录(与 mkdir 单级区别)
- `File.java:1056` `delete()` — 文件直接删,**目录必须空**(非递归)
- 关键设计 (斜体): *"目录必须空才能删"是 POSIX 语义(rmdir 要求);Java 没有内置递归删除——生产自己写递归(注意符号链接陷阱)或用 NIO.2 walk;list 返回 null 的三种情况(不存在/非目录/IO 错误)是经典坑(Javadoc 契约,`File.java:1137` list → normalizedList)*
- [内核: opendir/readdir(3);rmdir(2) 空目录限制]
- 面试: "删除非空目录?"——递归或 Files.walk(域 20 已裁剪,此处提到即可)

### 4. "FileDescriptor" — fd 的 Java 视图

场景: `System.in/out/err` 的本质——文件描述符怎么进 Java?

- `FileDescriptor.java:369` — 封装 int fd + `in/out/err` 三个标准流实例
- 文件流构造: FileInputStream(FileDescriptor)→ 持有 fd;`fd.valid()` 检查
- 与 OS 关系: fd = 进程内打开文件表的索引(0/1/2 = stdin/out/err)
- 关键设计 (斜体): *FileDescriptor 是"OS 资源句柄"的 Java 影子——close 它 = 释放系统资源;文件流的 fd 由 native 打开(open0),由 finalize/Cleaner 兜底(域 03 Cleaner)与 try-with-resources 显式关闭*
- [C++: 内部卷 01-os(fd 与系统调用);内核: 文件描述符表(进程级)]
- 面试: "为什么必须关闭流"——fd 泄漏(进程打开文件上限);try-with-resources 自动关(域 06 suppressed)

---

### 核心悬念

IO 是字节进字节出——但对象怎么整体进出?"对象 → 字节"的序列化是 RPC/缓存/消息队列的地基。`Serializable` 接口怎么工作?`serialVersionUID` 为什么必须?反序列化漏洞怎么来的?——下一篇: 域 18 序列化。

> → 下一篇: 域 18 序列化(18-serialization 系列) | 关联: 域 06(异常链)、域 04(反射构造)
