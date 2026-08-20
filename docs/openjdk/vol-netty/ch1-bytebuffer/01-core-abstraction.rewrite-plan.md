# Netty Ch1-01 核心抽象 — 正文写作规划

## 文章定位

- 写作卷：`vol-netty`
- 章节：Ch1 NIO ByteBuffer
- 篇：01 核心抽象
- 参考大纲：`source-analysis/netty/outlines/ch1-bytebuffer/01-core-abstraction.md`
- 文章类型：基础机制篇
- 正文状态：未开始

## 前置依赖

### HARD

- Java `byte[]` 基础读写：读者需要知道数组本身没有独立的读游标和写游标。
- Ch1 是 NIO 上卷第一章，本篇不要求读者先懂 Channel/Selector；它只用“生产者写入、消费者读取”作为抽象场景。

### SOFT

- Ch2 Channel：本篇用 `channel.read/write` 说明 Buffer 的生产/消费切换，但不展开 Channel API。
- Ch3 Selector：本篇只保留“网络数据可能分批到达”的场景，不展开 select 循环。

### NAV

- Ch1-02 HeapBuffer vs DirectBuffer：四字段状态机之后，进入数据实际存放位置。
- Ch1-03 views/traps：进入共享存储、视图、equals 和线程安全陷阱。
- Ch4 ByteBuf：用 NIO 单 position 与 Netty readerIndex/writerIndex 做后续对照。

## 一句话困惑

一个缓冲区为什么能在写入、读取、重读和半包追加之间切换，而不需要为每种状态创建不同对象？

## 一句话顿悟

`mark/position/limit/capacity` 不是四个零散字段，而是一组不变量；`flip/compact/rewind/mark-reset` 是这组状态机的合法迁移。

## 读者理解路径

1. 从 `byte[]` 的“只有数据、没有读写边界”开始。
2. 先建立四字段和不变量的总图。
3. 解释 relative/absolute 两种访问为什么必须并存。
4. 解释 flip 如何把生产边界转换成消费边界。
5. 用 TCP 半包场景解释 compact 为什么保留未读区间。
6. 最后区分 clear/rewind/mark-reset，并把单 position 的限制桥接到 Netty 双指针。

## 失败方案推演

- 只维护一个 position，读写切换时无法同时保留生产边界和消费边界。
- 每轮 IO 都新建数组，半包追加产生分配和复制成本。
- 用 flip 代替 compact，未消费数据会被覆盖。

## 必须澄清的误解

1. `flip()` 不是“翻转字节”，而是重置边界和 position。
2. `clear()` 不清零底层数据，只重置状态。
3. `rewind()` 保留 limit，不会重新进入写模式。
4. relative get/put 推进 position，absolute get/put 不推进。
5. `compact()` 保留的是 `[position, limit)`，不是已经读过的区间。
6. NIO 单 position 与 Netty 双 reader/writer index 只存在演进关系，不能写成实现相同。

## 文章结构与字数预算

1. 事故/困惑开场：为什么一个 position 不够（800-1000 字）
2. 四字段与不变量总图（1200-1500 字）
3. relative/absolute 访问（1000-1300 字）
4. flip：生产边界变消费边界（1200-1500 字）
5. compact：半包数据不丢失（1400-1700 字）
6. clear/rewind/mark/reset 复位族（1200-1500 字）
7. 误解澄清、总图与 Ch1-02/Ch4 桥接（800-1000 字）

目标叙述性正文：8000 字左右；代码块不计入目标。

## 证据清单

写作时逐条重新验证，不直接信任大纲行号：

- `Buffer.java:197-201`
- `Buffer.java:380,396`
- `Buffer.java:421`
- `Buffer.java:449`
- `Buffer.java:471`
- `Buffer.java:483`
- `X-Buffer.java.template:615-685`
- `Heap-X-Buffer.java.template:164-207,261-275`

## 写作后检查

- [ ] 代码块均来自当前 JDK 源码
- [ ] 每段代码前有问题/动机
- [ ] 删除代码后主线仍成立
- [ ] 至少三处失败方案/误解澄清
- [ ] 不提前依赖 Ch2/Ch3 实现细节
- [ ] 结尾明确桥接 Ch1-02、Ch1-03 和 Ch4
- [ ] 通过事实、因果、结构、读者、边界、依赖六轮 review
