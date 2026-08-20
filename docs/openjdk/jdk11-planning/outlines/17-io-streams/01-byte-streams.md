# 01. 字节流与装饰器模式 — InputStream 层次、read 循环、缓冲

> 🔴 Deep | 域 17 IO 流体系第 1 篇 | Layer 2
> 读者处境: 面试"字节流怎么读文件/为什么用 Buffered"必考——流抽象、read 的 -1 语义、装饰器包装链一次讲透。

### 1. "read() 为什么返回 int 不是 byte？" — EOF 语义

场景: `while ((b = in.read()) != -1)` — 这个循环为什么必须这么写?

- `InputStream.java:169` `public abstract int read()` — 返回 0-255 的**无符号字节**或 **-1(EOF)**
- 为什么是 int: byte 是 -128..127,无法表示 -1(EOF)——**用 int 扩宽**,避免 -1 与 0xFF 混淆
- `InputStream.java:265` `read(byte[], off, len)` — **不保证读满 len**(可能部分读)——循环读的正确写法(经典面试陷阱)
- `InputStream.java:113` `readAllBytes()` / `142` `transferTo(OutputStream)` — JDK9+ 便捷方法(内部循环 readNBytes)
- 关键设计 (斜体): *"读不满"是流式 IO 的本质(底层系统调用可能部分返回)——所有可靠 IO 都要循环;readAllBytes 把循环封装进 JDK,生产优先用它*
- 面试: "read 一次读多少?"——取决于底层(文件流一次可读满,管道/网络流不一定)——所以必须循环

### 2. "装饰器模式长什么样？" — Filter* 包装链

场景: `new BufferedInputStream(new FileInputStream(f))` — 这个链条怎么工作?

- `FilterInputStream` — 装饰器基类: 持有 `protected volatile InputStream in`,**方法全部透传**
- 包装链: FileInputStream(底层读)→ BufferedInputStream(缓冲层)——**职责叠加**
- `FilterOutputStream` 对称;`DataInputStream`(域 18 关联)也是装饰器
- 关键设计 (斜体): *装饰器 vs 继承: 组合运行时组装,不产生类爆炸(若每组合一个类 = N×M 个类);Java IO 是装饰器模式的教科书——面试画"IO 类图"是经典题*
- 面试: "为什么 IO 用装饰器不用继承"——组合优于继承;追加功能不修改原类(开闭原则)

### 3. "BufferedInputStream 怎么缓冲？" — 内存预读

场景: 逐字节读大文件,为什么 Buffered 快 100 倍?

- `BufferedInputStream.java:85` — `protected volatile byte[] buf` / `96` `count`(有效字节数)/ `113` `pos`(当前位置)
- `BufferedInputStream.java:54` — `DEFAULT_BUFFER_SIZE = 8192`(默认 8KB)
- `BufferedInputStream.java:269` `synchronized read()` — **从内存 buf 读**;buf 空了才 `fill()`(`219`)底层一次读满 8KB
- 本质: 把"8KB 系统调用"变成"8KB 内存读 + 1 次系统调用"——**减少系统调用次数**
- 关键设计 (斜体): *缓冲的本质是"批量化系统调用"——每次 read(byte[]) 都是 JVM → OS 边界(域 03 的 native);8192 的来历源码无注释,一般认为与文件系统块大小(4KB)对齐;volatile 与 synchronized 因为 read 可能跨线程(close 并发)*
- [C++: 内部卷 01-os(read/write 系统调用路径);内核: 页缓存(page cache)与 read 的拷贝]
- 面试: "缓冲大小能改吗"——`new BufferedInputStream(in, 32768)`;生产大文件 IO 调大缓冲有效

### 4. "内存流与管道流" — 无系统调用的流

场景: 字符串转字节流做测试/拼接——ByteArray 与 Piped 的定位

- `ByteArrayInputStream/OutputStream`(292/337 行)— **纯内存操作,零系统调用**——测试/内存拼装用
- `PipedInputStream/PipedOutputStream`(449/179 行)— 线程间传递字节流: connect 配对;`receive` 满时 `awaitSpace`(**synchronized + wait/notify**,`PipedInputStream.java:200/266`)阻塞等待
- 关键设计 (斜体): *流是"数据管道抽象"——内存/文件/网络/线程间都是流;Piped 的阻塞语义是生产者-消费者模式的流式表达(与 BlockingQueue 殊途同归,域 10)*
- 面试: "Piped 与 BlockingQueue 区别"——流式(字节)vs 对象式;Piped 用管道数组实现
- [关联: 域 10 阻塞队列(生产者-消费者对照)]

---

### 核心悬念

字节流只有 0/1,但文本文件是"字符"——**字节怎么变成字符**?InputStreamReader 的 StreamDecoder 里发生了什么?FileReader 用的什么编码?——下一篇: 字符流与字节桥接。

> → [02-reader-writer.md](02-reader-writer.md)
