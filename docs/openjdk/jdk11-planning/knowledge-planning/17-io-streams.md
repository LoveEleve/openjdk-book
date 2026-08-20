# 域 17: IO 流体系 — 知识规划

> 源码路径: java.base/share/classes/java/io/(流层次 88 文件;核心: InputStream/OutputStream/Reader/Writer/Buffered*/Filter*/Data*/File*/Piped*/ByteArray*/Print*/FileDescriptor) + java.base/unix/classes/java/io/{UnixFileSystem,DefaultFileSystem}.java
> 源码量: ~90 文件 / ~25,000 行 | 非巨型域(序列化 ObjectInput/OutputStream 4,170+2,468 行归域 18)
> 写作层: Layer 2(前置: 域 01 字符串、03 对象系统)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| InputStream.java (710) | **字节流抽象**: abstract read()(169)、read(byte[],off,len)(265 循环读)、readAllBytes(113)/readNBytes、transferTo(142)、skip(136)、close(149)——read 返回 -1 的 EOF 语义 | High |
| OutputStream.java (195) | **字节写出**: write(int)/write(byte[],off,len)/flush/close | Medium |
| FilterInputStream.java | **装饰器基类**: 持被包装流,透传方法——装饰器模式骨架 | High |
| BufferedInputStream.java (495) | **缓冲读**: volatile byte[] buf/count/pos、fill()(219 底层读)、synchronized read(269)——减少系统调用 | High |
| BufferedOutputStream.java (145) | **缓冲写**: 数组攒批,flush 时写出 | Medium |
| FileInputStream.java (522) | **文件读**: fd(68)、open0 native(211)、readBytes native(243)——文件描述符边界 | High |
| FileOutputStream.java (554) | **文件写**: append 模式、fd 语义 | Medium |
| Reader.java (391)/Writer.java (421) | **字符流抽象**: read(char[])/write(String) 等字符单位操作 | Medium |
| InputStreamReader.java | **字节→字符桥**: CharsetDecoder 解码(域 01 编码衔接)——stream decoder 缓冲 | High |
| FileReader.java (122) | 快捷类: 默认 charset 的 InputStreamReader | Low |
| PrintStream.java (1213) | **格式化输出**: println/printf、synchronized、编码、异常吞掉语义(checkError) | Medium |
| PrintWriter.java (1153) | 字符版 print 输出,不抛 IOException(checkError) | Medium |
| PipedInputStream/OutputStream (449/179) | **管道流**: 线程间通信,读写配对/阻塞 | Low |
| ByteArrayInputStream/OutputStream (292/337) | 内存字节流: 无 IO 系统调用 | Low |
| File.java (2336) | **文件路径抽象**: 构造(276)、exists(823)、length(989)、createNewFile(1029,原子)、delete(1056)、list(1137)/listFiles(1257)、mkdirs(1390)、临时文件 | High |
| unix/UnixFileSystem.java | **平台文件系统**: native 方法族(getBooleanAttributes0 250/checkAccess 259/getLength 261/createFileExclusively 266)——Java 文件操作→系统调用边界 | High |
| FileDescriptor.java (369) | **文件描述符**: fd int + 三种标准流(STDIN/OUT/ERR) | Medium |
| FileSystem.java | 文件系统抽象接口(路径解析/列表/权限) | Medium |

*18 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | 字节流抽象与装饰器 | 8 (InputStream/OutputStream/Filter*/Buffered*/ByteArray*) | 面试必考(读循环/装饰器模式/Buffered 作用) |
| P1 | 字符流与桥接 | 5 (Reader/Writer/InputStreamReader/FileReader/PrintWriter) | 面试常问(字节 vs 字符/乱码桥接) |
| P1 | File 与平台文件系统 | 4 (File/FileSystem/UnixFileSystem/FileDescriptor) | 面试常问(File 本质/操作语义) |
| P2 | 格式化输出 | 2 (PrintStream/PrintWriter) | 面试偶尔(异常吞掉/编码) |
| P3 | 管道流 | 2 | 面试低频 |
| P3 | 内存流 | 2 | 使用层 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | 流抽象与装饰器模式 | 面试必考(read 返回 -1/while 循环/装饰器层级);框架(IO 包装链) |
| 🔴 Deep | 缓冲与性能 | 面试常问(Buffered 为什么快/缓冲区大小);生产(IO 性能调优) |
| 🔴 Deep | 字节↔字符桥接 | 面试常问(乱码/Charset);生产(文件编码处理) |
| 🟡 Working | File 与平台文件系统 | 面试偶尔;生产(文件操作语义/权限) |
| 🟡 Working | PrintStream/Writer | 面试偶尔(checkError 吞异常) |
| 🟢 Surface | Piped/ByteArray | 使用层 |

## 04 聚类

### 依赖图(域内)
```
InputStream/OutputStream(抽象) ←── Filter* ←── Buffered*(缓冲)/Data*(域 18 关联)
Reader/Writer(抽象) ←── InputStreamReader(字节→字符,CharsetDecoder) ←── FileReader
File(路径抽象) ←── UnixFileSystem(native 平台层) ←── FileDescriptor(fd)
PrintStream(格式化) ←── FileOutputStream
Piped*(线程间) ←── 流配对
```

### 教学顺序与文章拆分(3 篇)

1. **字节流与装饰器模式** — InputStream 层次、read 循环与 EOF、Buffered/Filter 包装、readAllBytes/transferTo
2. **字符流与字节桥接** — Reader/Writer、InputStreamReader 解码链路(域 01 衔接)、FileReader 默认编码、PrintStream/Writer
3. **File 与平台文件系统** — File 的路径抽象、UnixFileSystem native 边界、目录遍历、createNewFile 原子性、FileDescriptor

> 前置: 域 01(编码)、03(arraycopy/native 边界)。跨层: 文件 IO 的系统调用(read/write/open,内部卷 01-os);FileDescriptor 与 OS fd 对照;序列化(域 18)基于本域流
