# 17-io-streams/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `InputStream`、`FilterInputStream`、`BufferedInputStream` 及常见内存/管道字节流。本文聚焦 `read()` / `read(byte[],off,len)`、EOF 表示、装饰器链、缓冲补充机制与典型流种类；字符解码与 NIO 通道分离到后续篇章。
> 目标：把“字节流与装饰器模式”改写成一篇围绕“为什么字节流体系虽然类很多，但本质上都在围绕 EOF 语义、职责叠加和批量缓冲这三件事组织”的机制文章。

## 1. 读者困惑

- `InputStream.read()` 为什么返回 `int` 而不是 `byte`？
- 为什么 `read(byte[], off, len)` 的默认实现明明像批量读，业务代码却仍然不能假设“一次就读满”？
- `BufferedInputStream` 到底快在哪里，为什么不是 Java 循环本身更快？
- `FilterInputStream` 这种透传包装类为什么值得存在，为什么 IO 不直接靠继承组合所有功能？
- `ByteArrayInputStream`、`PipedInputStream` 这种“不连文件、不连网络”的流，为什么仍然放在同一套字节流体系里？

## 2. 一句话顿悟

**Java 字节流体系真正的统一点，不是“类层次很多”，而是三条边界：EOF 必须被编码进返回语义，所以 `read()` 用 `int`；不同职责（底层读取、缓冲、结构化解析）不预先硬绑死，而是通过装饰器在运行时叠加；频繁小读会被系统调用成本拖垮，所以缓冲流会把底层读取批量化，再把元素级读取留在内存里完成。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `read()` 返回 `int` 的 EOF 语义、FilterInputStream 的装饰器角色、BufferedInputStream 的缓冲字段与补充逻辑、ByteArray/Piped 流的统一抽象。
- 已指出“业务代码不能假设一次 read 就拿到全部数据”，这是实战关键点。
- 已把字符流桥接放到下一篇，边界划分合理。

### 必须重写

- 旧稿偏概念并列，需要先建立总问题：字节流为什么看似类很多，实际上都围绕 EOF、职责叠加、批量缓冲展开。
- `read()` 返回 int 应该从“0xFF 与 EOF 如何共存”这个失败方案切入，而不是直接给结论。
- 缓冲部分要更明确讲成“减少系统调用次数”，而不是泛泛说快。
- 内存流/管道流要回扣“流是统一数据管道抽象”，而不是收尾式列举。

## 4. 理解路径

### 第一节：从“为什么 read 不直接返回 byte”开场

用 0xFF 与 EOF 冲突开场：如果返回 byte，就无法同时无歧义表达 0..255 的有效字节和 -1 的结束标记。引出 EOF 语义是字节流 API 设计的第一块基石。

### 第二节：默认批量 read 为什么仍然不能替业务循环

证据：
- `InputStream.java:50`：类定义
- `InputStream.java:204`：`read(byte[])`
- `InputStream.java:265`：`read(byte[], int, int)`
- `InputStream.java:113` / `332`：`readAllBytes()`
- `InputStream.java:142` / `699`：`transferTo()`

主线：
- 默认批量 read 通过循环单字节 read 尽量读，但它只是 InputStream 的保底实现。
- 具体流可以覆盖它，底层文件/网络/管道返回节奏也不同。
- 生产代码要按返回值驱动循环，不能把某个具体流的行为误当全体契约。

### 第三节：装饰器为什么比继承更适合字节流职责叠加

证据：
- `FilterInputStream.java:46`：类定义
- `FilterInputStream.java:50`：`protected volatile InputStream in`

主线：
- 底层读取、缓冲、结构化读取是可组合职责，不该靠预先派生出所有类组合。
- FilterInputStream 说明“包装一个已有输入流，再附加新职责”是字节流体系的核心组织方式。
- 这把 FileInputStream / BufferedInputStream / DataInputStream 等组合拉回同一主线。

### 第四节：BufferedInputStream 为什么快——它真正批量化的是系统调用

证据：
- `BufferedInputStream.java:52`：类定义
- `BufferedInputStream.java:54`：默认缓冲大小
- `BufferedInputStream.java:85`：`buf`
- `BufferedInputStream.java:96`：`count`
- `BufferedInputStream.java:113`：`pos`
- `BufferedInputStream.java:219`：`fill()`
- `BufferedInputStream.java:269`：单字节 `read()`
- `BufferedInputStream.java:282`：`read1()`

主线：
- 无缓冲逐字节读取会频繁跨到下层流甚至系统调用。
- BufferedInputStream 先 fill 大块读入内存，后续单字节 read 只是内存数组索引推进。
- `read1()` 说明“够大且无 mark 约束时甚至绕开内部缓冲直读目标数组”，进一步强调缓冲是系统调用策略而不是“所有字节都先进 buf”的教条。

### 第五节：为什么内存流和管道流也属于同一套抽象

证据：
- 字节流正文可继续引用现有源码位置（ByteArray / Piped），必要时后续补精确锚点

主线：
- ByteArray 流说明“数据源/数据汇”不一定连操作系统外设，也可以纯内存。
- Piped 流说明“流”还可以表达线程间字节管道，用 wait/notify 或阻塞语义做生产者-消费者。
- 这样就能把文件、内存、线程管道统一收回到“字节流 = 数据管道抽象”主线上。

## 5. 失败方案清单

1. 让 `read()` 返回 byte，并拿 -1 同时表达 EOF。
2. 以为 `read(byte[], off, len)` 一次返回就一定读满业务所需字节。
3. 频繁逐字节读底层流却不用缓冲，还把性能问题怪到 Java 循环本身上。
4. 试图用继承预先组合所有 IO 职责，制造类爆炸。
5. 把内存流、管道流看成“小众例外”，不纳入统一抽象理解。

## 6. 误解清单

1. 字节流类多，所以体系必然复杂而零散。
2. BufferedInputStream 的快主要来自 Java 代码优化，而不是系统调用批量化。
3. FilterInputStream 只是形式主义透传层。
4. 只要是文件流，就能把“单次 read 返回值”经验外推到所有流。
5. ByteArray/Piped 流和普通字节流没有统一思想。

## 7. 证据清单

- `InputStream.java:50`：类定义
- `InputStream.java:204`：`read(byte[])`
- `InputStream.java:265`：`read(byte[], int, int)`
- `InputStream.java:113` / `332`：`readAllBytes()`
- `InputStream.java:142` / `699`：`transferTo()`
- `FilterInputStream.java:46`：类定义
- `FilterInputStream.java:50`：包装字段 `in`
- `BufferedInputStream.java:52`：类定义
- `BufferedInputStream.java:54`：`DEFAULT_BUFFER_SIZE`
- `BufferedInputStream.java:85`：`buf`
- `BufferedInputStream.java:96`：`count`
- `BufferedInputStream.java:113`：`pos`
- `BufferedInputStream.java:219`：`fill()`
- `BufferedInputStream.java:269`：单字节 `read()`
- `BufferedInputStream.java:282`：`read1()`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦字节流抽象与缓冲，不展开字符解码链、NIO Channel 或 FileSystem 语义。
- ByteArray/Piped 的源码锚点若正文深入补充，可后续按需再精确补读。
- 不把所有 InputStream 子类逐个百科化，重点是抽象统一性。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 read 返回 int 才能容纳 EOF → 默认批量 read 不能替代业务循环 → 装饰器如何让读取、缓冲、结构化职责运行时叠加 → BufferedInputStream 为什么是在减少系统调用而不是优化 Java 循环 → 内存流和管道流怎样回扣到统一的数据管道抽象”。
- 必须把三条主线（EOF、装饰器、缓冲）讲成同一篇的统一逻辑。
- 必须自然引到字符流桥接的下一篇。
