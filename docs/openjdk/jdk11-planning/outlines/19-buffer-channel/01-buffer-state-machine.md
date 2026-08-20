# 01. Buffer 抽象与状态机 — mark/position/limit/capacity 与翻转

> 🔴 Deep | 域 19 Buffer 与 Channel 第 1 篇 | Layer 3
> 读者处境: 面试"ByteBuffer 的 flip 干什么"是 NIO 必考——四状态字段与读写切换语义一次讲透。

### 1. "Buffer 的四个状态是什么？" — 字段与语义

场景: `buffer.flip()` 之前 position 在尾部,flip 之后怎么就能读了?

- `Buffer.java:198-201` — `mark = -1` / `position = 0` / `limit` / `capacity` — **四状态字段**
- `capacity`: 固定容量;`limit`: 可读/可写边界;`position`: 当前读写位置;`mark`: 书签(重置用)
- 不变量: `0 <= mark <= position <= limit <= capacity`(`Buffer.java:218` 包私有构造校验)
- `Buffer.java:274` `position()` 查询/设置
- 关键设计 (斜体): *Buffer 是"读写游标 + 边界"的状态机——所有操作(position/flip/clear)都是改状态不改底层数据;面试画"四状态坐标图"是区分度*
- 面试: "Buffer 和数组区别"——带游标语义的数组封装;免手动记下标

### 2. "flip/clear/rewind 区别？" — 三个翻转操作

场景: 写完后 flip,读完想重写 clear——每次操作改了什么?

- `Buffer.java:449` `flip()`: **写→读**: limit = position;position = 0;mark = -1
- `Buffer.java:421` `clear()`: **重写**: position = 0;limit = capacity(不清数据,只是重置游标)
- `Buffer.java:471` `rewind()`: **重读**: position = 0;limit 不变(mark 清除)
- `Buffer.java:380/396` `mark()/reset()`: 书签与恢复
- 关键设计 (斜体): *三操作的本质: flip 设置"已写边界"、clear 恢复"全容量"、rewind 回到"已写起点"——都是 O(1) 字段操作;面试手写读写循环(while(buffer.hasRemaining()))是基本功*
- 面试: "flip 和 clear 什么时候用"——写→读 flip;读→写 clear;重读 rewind

### 3. "remaining/hasRemaining" — 剩余语义

场景: 遍历 Buffer 的循环条件——怎么判断还有数据?

- `Buffer.java:483` `remaining()` = limit - position
- `Buffer.java:495` `hasRemaining()` = position < limit
- 配合: 读循环 `while (buffer.hasRemaining()) buffer.get()`
- 关键设计 (斜体): *"剩余 = 边界 - 游标"是状态机的核心查询;flip 的价值正在于把 limit 设为"真实数据长度"——hasRemaining 才准确;面试"为什么 flip 后才知道读多少"——position 记录了实际写入数*
- 生产: 解析协议帧(读 header 长度 → flip → 读 body)是标准模式

### 4. "堆内 vs 堆外" — isDirect 语义

场景: `allocate` vs `allocateDirect`——Buffer 的两类存储

- `Buffer.java:580` — `public abstract boolean isDirect()` — 抽象判定
- 堆内(Heap-X-Buffer.java.template): byte[] hb(模板 271)+ offset(55)——GC 管理,拷贝风险(IO 时 JVM 需把数据拷到堆外或固定)
- 堆外(Direct-X-Buffer.java.template): 地址直存(域 32 的 allocateMemory+Cleaner)——IO 零拷贝的前提
- 关键设计 (斜体): *"直接缓冲区"直接持有本机地址——系统调用直接读写该内存(免中间拷贝);堆内缓冲在 IO 时必须临时拷贝/固定;面试"为什么 Direct 快"——少一次拷贝(GC 对象移动风险)*
- 生产: 大 IO/网络高频用 Direct(注意堆外泄漏,域 32)
- [关联: 域 32 堆外内存与 Cleaner;域 17 IO]

---

### 核心悬念

Buffer 有 8 种基本类型版本——它们从哪来?`ByteBuffer.wrap`、视图、字节序怎么处理?模板生成体系长什么样?——下一篇: ByteBuffer 家族与生成体系。

> → [02-bytebuffer-family.md](02-bytebuffer-family.md)
