# 02. ByteBuffer 家族与生成体系 — 模板、wrap、视图、字节序

> 🟡 Working | 域 19 Buffer 与 Channel 第 2 篇 | Layer 3
> 读者处境: 面试"ByteBuffer 怎么创建/字节序怎么处理"— 8 种 Buffer 的生成体系与常用操作。

### 1. "8 种 Buffer 从哪来？" — 模板生成体系

场景: ByteBuffer/CharBuffer/DoubleBuffer... 8 个类几乎一样——代码怎么组织的?

- 源码是 **模板文件**: `X-Buffer.java.template`(类型参数 $type$ 占位)——构建期 GensrcBuffer 生成 8 个类
- `X-Buffer.java.template:271` — `final $type$[] hb` — 堆内存储(模板里一处定义,8 类共用)
- 同理: Heap-X-Buffer(堆内)/Direct-X-Buffer(堆外)/X-Buffer-bin(字节序变体)/ByteBufferAs-X-Buffer(视图)
- 关键设计 (斜体): *"模板生成"是 JDK 对付"8 个近同类"的工程手法——一份模板多份产出,避免手写 8 份复制;这与域 24 的模块化是不同层面的复用;面试"为什么源码找不到 ByteBuffer 的实现"——模板生成*
- [构建: GensrcBuffer.gmk 模板展开(X-Buffer.java.template → 8 个 Buffer 类);关联: 域 08 subList(视图共享同思想)]
- 面试: "ByteBuffer 的类层次"——Buffer → ByteBuffer(抽象)→ HeapByteBuffer/DirectByteBuffer(模板生成)

### 2. "wrap 与创建" — 数组包装

场景: 已有 byte[] 想当 Buffer 用——wrap 的语义

- `X-Buffer.java.template:389` `wrap(byte[], offset, length)` — **包装现有数组**(不复制,共享底层)——`new HeapByteBuffer(array, offset, length)`,容量=array.length、limit=length、position=0(offset 存入内部偏移字段,访问时 ix(offset+position) 计算)
- 注意: wrap 的修改**直接影响原数组**(共享)——与 copyOf 相反(域 08)
- 关键设计 (斜体): *wrap 是"零拷贝视图"——数组与 Buffer 互操作不复制;面试"wrap 会复制吗"——不会;安全注意: 包装后原数组暴露给读写方*
- 生产: 协议解析把接收数组 wrap 成 ByteBuffer 免复制

### 3. "视图与字节序" — asXBuffer/order

场景: ByteBuffer 里放 int——字节序怎么处理?

- 字节序: `order(ByteOrder.LITTLE_ENDIAN)`(模板 1665)— **初始恒 BIG_ENDIAN**(模板 javadoc 141-142),大/小端(网络序即大端)
- 视图: `asIntBuffer()`/`asCharBuffer()` 等——**同一内存的另一种视角**(ByteBufferAs-X-Buffer 模板)
- `putInt/getInt` — 按当前字节序读写多字节
- 关键设计 (斜体): *视图 = "同一块内存的多类型解释"——网络协议固定大端(Java 默认),本地文件常小端(需 order 切换);面试"网络字节序"——Java 默认大端即网络序*
- 生产: 报文解析(读 4 字节转 int/读 UTF 字符串)用 getInt/getChar 族

### 4. "slice/duplicate" — 子视图

场景: 大缓冲区里取一段——slice 与 duplicate 的区别

- `slice()`: 从当前 position 到 limit 的**新视图**(共享底层,独立游标)
- `duplicate()`: 整个缓冲区的共享副本(同底层,独立游标)
- 均不复制数据(共享数组/地址)——与域 08 subList 同思想
- 关键设计 (斜体): *"视图"家族(wrap/slice/duplicate/asXBuffer)全部共享底层——修改互相可见;生产大 Buffer 分帧解析用 slice 免复制*
- 面试: "slice 与 duplicate 区别"——范围 vs 全量;共享语义相同

---

### 核心悬念

Buffer 讲完——**通道**呢?`FileChannel` 怎么把文件映射进内存?`map()` 的 mmap 是什么?`transferTo` 的零拷贝怎么做到"三次拷贝变一次"?MappedByteBuffer 的 load/force 干什么?——下一篇: FileChannel 与 mmap 零拷贝。

> → [03-filechannel-mmap.md](03-filechannel-mmap.md)
