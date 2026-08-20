# 域 17: IO 流体系 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "read() 为什么返回 int / EOF -1 语义" — 01 篇 §1(InputStream.java:169/265)
- [x] "读不满问题/read 循环" — 01 篇 §1(265)
- [x] "装饰器模式(IO 类图)" — 01 篇 §2(FilterInputStream)
- [x] "Buffered 为什么快(8KB)" — 01 篇 §3(BufferedInputStream.java:54/85/219/269)
- [x] "字节流 vs 字符流" — 02 篇 §1(Reader.java:391/Writer.java:421)
- [x] "乱码/桥接(CharsetDecoder)" — 02 篇 §2(InputStreamReader.java:64/163, StreamDecoder.java:37/234)
- [x] "FileReader 默认编码坑" — 02 篇 §3(FileReader.java:122)
- [x] "File 是文件吗/new File 会失败吗" — 03 篇 §1(File.java:276)
- [x] "createNewFile 原子性/进程互斥" — 03 篇 §2(UnixFileSystem.java:266)
- [x] "为什么必须关闭流(fd)" — 03 篇 §4(FileDescriptor.java:369)

## 身份 2: 生产工程师
- [x] 逐字节读慢/缓冲调优 — 01 篇 §3
- [x] FileReader 乱码(显式 UTF-8)— 02 篇 §3
- [x] 删除非空目录/目录操作 — 03 篇 §3
- [x] fd 泄漏排查 — 03 篇 §4

## 身份 3: 框架工程师
- [x] IO 包装链(装饰器)理解 — 01 篇 §2
- [x] 流式协议(序列化/RPC 基础)— 01 篇 §4 关联

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 InputStream.java:113/136/142/149/169/265, BufferedInputStream.java:54/85/96/113/219/269, FileInputStream.java:68/211/243, InputStreamReader.java:64/163/180, StreamDecoder.java:37/234, FileReader.java:122, PrintStream.java:1213, PrintWriter.java:1153, PipedInput/Output 449/179, ByteArray 292/337, File.java:276/516/576/823/853/989/1029/1056/1137/1257/1390/2099, UnixFileSystem.java:250-266, FileDescriptor.java:369)/关键设计/跨层([内核]/[man]/[内部卷])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] BufferedInputStream buf 字段实测: protected volatile byte[] buf(85)

## 身份 5: 完整性缺口检查
- [x] 字节流(01)/字符桥接(02)/文件系统(03)三篇覆盖域全部面试主战场
- [x] ObjectInputStream/OutputStream(4,170+2,468 行)归域 18,不在本域拆篇
- [x] DataInputStream/Output 在域 18(序列化配套)提及
- [x] 未覆盖确认: 内存流/管道流(🟢)已并入 01 篇 §4;LineNumber*/CharArray* 等遗留类不入篇
- [x] 二次 review 修正: Reader.read() 返回 int(0-65535 或 -1,208),非 char;8192 来历弱化为"源码无注释,一般认为与块大小对齐"(防推测编造);Piped 阻塞机制精确锚定(synchronized receive 200 + awaitSpace 266);FileReader 的"JDK 后续废弃"改为如实表述(JDK11 无 Deprecated 注解);list null 语义锚定 Javadoc 契约(1137)
- [x] 验证通过: InputStream.read(byte[],off,len) 循环实现(265-281)、File.exists→fs.getBooleanAttributes & BA_EXISTS(823-833)、mkdirs 递归(1390-1407)、PrintStream trouble(68)/checkError(469)、FileDescriptor in/out/err(150/158/167)
- [ ] 待办: 写作时验证 createTempFile 的实现细节(2099)、StreamDecoder 内部缓冲大小
