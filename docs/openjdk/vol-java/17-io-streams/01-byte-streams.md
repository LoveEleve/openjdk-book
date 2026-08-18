# 01. 字节流与装饰器模式 — InputStream 层次、read 循环、缓冲

> **前置依赖**: [10-concurrent-collections/05 — 阻塞队列](../10-concurrent-collections/05-blocking-queues.md)(生产者-消费者对照)
> → **后续**: [02-reader-writer.md](02-reader-writer.md)
> 关联: 内部卷 01-os(read/write 系统调用路径)

## 字节流为什么长这样

Java IO 的字节流体系看起来类很多,但核心只有三件事: **EOF 语义、装饰器包装、批量缓冲**。

## 1. "read() 为什么返回 int 不是 byte?" — EOF 语义

### 1.1 -1 与 0xFF

`InputStream.read()`(`InputStream.java:169`)返回 `int`,不是 `byte`。原因很直接:

- 有效字节范围需要表达 `0..255`
- 还要额外表达 `-1` 表示 EOF
- `byte` 只有 `-128..127`,无法同时区分 `0xFF` 与 EOF

所以经典循环必须写成:

```java
// 用法示意(API 形式,非源码片段)
int b;
while ((b = in.read()) != -1) {
    // use b
}
```

### 1.2 默认实现与生产语义

`read(byte[], off, len)`(`InputStream.java:265`)在 **InputStream 默认实现** 里会反复调用 `read()`,其 Javadoc 明确写的是: 一直阻塞到读满请求长度、EOF 或异常。

但这不等于业务代码就能假设"一次调用一定拿到全部业务数据": 具体流类型完全可以覆盖该方法,底层文件/网络/管道的返回节奏也不同。生产代码仍应按返回值循环处理,而不是假设一次就读到想要的全部内容。

JDK 9+ 已把常见循环封装成 `readAllBytes()`(`:113`)和 `transferTo(OutputStream)`(`:142`)。

关键设计(斜体):*InputStream 的默认实现会尽量把请求长度读满,但可靠 IO 仍要按返回值驱动循环——不要把某个具体流的行为误当成所有流的契约。面试"read 一次读多少": 取决于具体实现与底层,不能写死假设。*

## 2. "装饰器模式长什么样?" — Filter* 包装链

### 2.1 透传基类

`FilterInputStream`(`FilterInputStream.java:46`)持有 `protected volatile InputStream in`(`:50`)。它自己不改变 IO 语义,而是把调用透传给被包装流。

### 2.2 包装链

典型链:

- `FileInputStream`——底层文件读取
- `BufferedInputStream`——缓冲层
- `DataInputStream`——结构化读取(跨到序列化/二进制协议场景)

所以 `new BufferedInputStream(new FileInputStream(f))` 不是继承叠加,而是**运行时组合职责**。

关键设计(斜体):*"装饰器 = 运行时组装职责"——底层读、缓冲、结构化解析可以按需叠加,不用为每种组合派生新类。面试"为什么 IO 用装饰器不用继承": 组合优于继承,避免类爆炸。*

## 3. "BufferedInputStream 怎么缓冲?" — 内存预读

### 3.1 缓冲字段

`BufferedInputStream` 的关键字段:

- `DEFAULT_BUFFER_SIZE = 8192`(`BufferedInputStream.java:54`)
- `buf`(`:85`)——缓冲数组
- `count`(`:96`)——有效字节数
- `pos`(`:113`)——当前位置

### 3.2 为什么更快

`read()`(`:269`)优先从 `buf` 取字节;只有缓冲耗尽时才调用 `fill()`(`:219`)从底层批量补 8KB。

逐字节读大文件时,如果不用缓冲,每个字节都可能触发底层读取;加了缓冲后,变成**一次系统调用 + 多次内存读取**。

关键设计(斜体):*"缓冲的本质是批量化系统调用"——把频繁的边界跨越换成大块预读。面试"Buffered 为什么快": 不是 Java 循环更快,而是系统调用次数更少。*

## 4. "内存流与管道流" — 无系统调用的流

### 4.1 ByteArray

`ByteArrayInputStream`(`ByteArrayInputStream.java:46`)和 `ByteArrayOutputStream`(`ByteArrayOutputStream.java:47`)都是纯内存流。它们适合测试、内存拼装与协议编解码,不经过文件/网络系统调用。

### 4.2 Piped

`PipedInputStream`(`PipedInputStream.java:50`)与 `PipedOutputStream`(`PipedOutputStream.java:47`)提供线程间字节管道:

- 写端把字节送入 `receive`(`PipedInputStream.java:200`)
- 满了就 `awaitSpace()`(`:266`)等待
- `synchronized` + `wait/notify` 形成阻塞的生产者-消费者模型

它和 `BlockingQueue` 的思想接近,只是传的是**字节流**而不是对象。

关键设计(斜体):*"流是数据管道抽象"——文件、内存、线程间传输都能统一成 InputStream/OutputStream。面试"Piped 与 BlockingQueue 区别": 字节流 vs 对象队列。*

## 核心悬念

字节流只有 0/1,但文本文件是字符——**字节怎么变成字符**?`InputStreamReader` 与 `StreamDecoder` 里发生了什么?——下一篇: 字符流与字节桥接。