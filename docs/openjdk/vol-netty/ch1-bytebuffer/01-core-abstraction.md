# ByteBuffer 的四个位置：为什么一个缓冲区能完成读写切换

> 本文基于 JDK 11 NIO `Buffer`/`ByteBuffer` 设计，读者只需要具备 `byte[]` 和基本 IO 概念。本文先讲缓冲区的状态机；堆内/堆外分配见下一篇，共享视图与线程安全陷阱见第三篇。

## 一个 byte[]，为什么还需要 ByteBuffer

假设程序要接收一段网络数据。用 `byte[]` 时，数组只知道两件事：它有多大，以及每个位置存了什么。它不知道：

- 哪些字节已经写入？
- 哪些字节已经读出？
- 当前应该从哪里继续写？
- 当前应该从哪里继续读？

当然可以额外维护两个整数：`writeIndex` 和 `readIndex`。但如果每个 IO 调用方都自己维护，边界检查、读写切换和半包处理就会散落在业务代码里。

NIO `Buffer` 做了一个更基础的抽象：它不把“数据”和“数据当前处于什么阶段”分开到两个对象里，而是把状态压缩成四个字段：

```text
mark ───────┐
            ▼
-1 <= mark <= position <= limit <= capacity
                         ▲          ▲
                         │          │
                    当前边界     最大容量
```

这四个字段不是四个独立属性，而是一组必须同时成立的不变量。`capacity` 是容器总容量，`limit` 是当前可访问边界，`position` 是下一次相对读写的位置，`mark` 是一个可选的回退点。

`Buffer` 的构造状态是 `position=0`、`limit=capacity`、`mark=-1`（`Buffer.java:197-201`）。这意味着新缓冲区默认处于“从头开始写”的状态：空间全部可写，当前位置从 0 开始。

## 先看失败方案：为什么不维护三个对象

一个直觉方案是分别创建“写缓冲区”“读缓冲区”“重读缓冲区”。这样每种状态看起来都很简单，但状态切换需要复制数据或交换对象；网络半包到来时，又要在多个对象之间搬运未读数据。

另一个方案是仍然只保留一个 position，但把 limit、已读范围、可写范围全部放在调用方变量里。它避免了对象分裂，却把同一套边界规则复制到所有协议解析器中。

`Buffer` 的取舍是：只保留一个底层存储，把读写阶段压缩进四字段不变量，再用少数状态迁移方法改变边界。调用方不需要创建新对象来表达“现在从写切到读”。

## 一、四字段状态机

### 写入阶段：position 向前走

```text
新建 Buffer
position=0, limit=capacity
        │ put(data)
        ▼
position=已写入字节数, limit=capacity
```

相对写操作会从当前 `position` 开始，把数据写入底层存储，然后推进 `position`。`limit` 没有跟着每次写入移动，因为它表示当前模式下允许访问的上界，而不是“已经写了多少”。

### 写完准备读：flip 改变边界

假设写入了 100 字节：

```text
写入结束：position=100, limit=capacity
flip 之后：position=0,   limit=100
```

`flip()` 的语义不是翻转字节，而是把“写到哪里”转换成“读到哪里”。它把旧 position 变成新的 limit，把 position 归零，并丢弃 mark（`Buffer.java:449`）。

这三个动作必须作为一组状态迁移来理解。如果只把 position 设为 0，读取方会继续把 capacity 当成有效数据边界，把尚未写入的尾部也读出去；这里的“一起”是语义上的完整迁移，不是说三个普通字段赋值具备并发原子性。

### 读完准备继续写：compact 保留未读部分

真实网络读取通常不是一次得到完整消息。假设一次只拿到半个请求：

```text
[已经解析][还没解析........][空闲空间........]
          position       limit       capacity
```

此时不能调用 `clear()`，因为 clear 会把 position 归零，未解析部分就失去边界。`compact()` 做的是：把 `[position, limit)` 的未读数据搬到数组头部，然后让 position 移到这些数据之后，limit 恢复为 capacity。

```text
compact 之前：[已读][未读........][空闲]
compact 之后：[未读........][空闲................]
                         ▲
                      position
```

HeapBuffer 模板中的实现用 `System.arraycopy` 移动未读区间，再设置新的 position/limit（`Heap-X-Buffer.java.template:261-275`）。这是一次 O(N) 搬运，但换来的是不重新分配数组；对半包协议来说，数据连续性比避免一次复制更重要。

这也是 NIO Buffer 与后来的 Netty ByteBuf 之间的一条演进线：NIO 把读写状态压在一个 position 上，Netty 则把 readerIndex 和 writerIndex 分开，减少频繁 flip/compact 的模式切换。

## 二、relative 与 absolute：同一份数据的两种访问方式

解析协议头时，经常需要读取固定偏移的字段。例如当前位置正在解析 payload，但需要查看第 4 个字节的长度字段。如果所有读取都推进 position，查看动作就会改变主解析进度。

所以 Buffer 提供两种访问语义：

```text
relative get/put：使用当前 position，访问后推进 position
absolute get/put：使用显式 index，访问后不改变 position
```

模板代码中，relative `get()` 先通过 `nextGetIndex()` 检查并推进 position，再调用 `_get`；absolute `get(index)` 先检查显式 index，再直接 `_get(index)`（`X-Buffer.java.template:615-685`）。

这两种 API 的区别不是语法偏好，而是两种状态管理协议：

- relative 操作表达“消费/生产进度向前推进”
- absolute 操作表达“观察某个固定位置，但不改变主进度”

如果把 absolute 操作也设计成推进 position，协议解析器就无法安全地做 peek；如果所有操作都只接受 index，调用方又必须反复管理当前读写位置。两者并存，才同时覆盖顺序 IO 和随机字段访问。

## 三、clear、rewind、mark/reset：三个名字相似，状态不同

### clear：重新开始写

`clear()` 把 position 设为 0、limit 设为 capacity，并丢弃 mark（`Buffer.java:421`）。它不清零底层数据，也不保证旧字节消失；它只是告诉后续读写：“旧内容不再作为当前缓冲区的有效数据”。

因此 clear 适合“这批数据已经处理完，准备复用整个缓冲区”，不适合“还有半包数据没处理完”。

### rewind：重新读同一段

`rewind()` 只把 position 设为 0，同时保留 limit（`Buffer.java:471`）。它适合对已经确定的有效区间重新读取，例如重新计算校验和；它不是写模式复位，也不会把 limit 恢复为 capacity。

### mark/reset：临时保存读取位置

`mark()` 保存当前 position，`reset()` 把 position 恢复到 mark；如果 mark 不存在，reset 会抛出 `InvalidMarkException`（`Buffer.java:380,396`）。

它适合“先试读一段，再决定是否回退”的场景：解析器先读取消息头，发现当前分支还不能确认消息是否完整，就回到 mark，等待更多数据。

三个动作可以这样区分：

```text
clear   = 放弃当前有效区间，重新写
rewind  = 保留有效区间，从头再读
mark    = 记住当前位置；reset = 回到记忆点
```

## 四、读写边界的真正代价

四字段模型很紧凑，但它把读写切换责任交给调用方：调用方必须知道当前 position、limit 代表的是写边界还是读边界。这个设计适合 NIO 的基础 API，因为它提供了清晰而低层的控制；但在复杂 Pipeline 中，多个处理器共享一份数据时，单 position 会带来额外协调成本。

这也是 Netty ByteBuf 重新设计缓冲区抽象的动机之一：把读取进度和写入进度拆成两个独立索引，让一个 handler 消费数据时，不必用 flip 把整个对象切换到另一个模式。

但不能因此把 NIO Buffer 说成“设计失败”。它的四字段模型用很少的状态表达了固定容量、有效边界、当前进度和临时回退，代价是读写模式切换由调用方显式管理；Netty 的双指针则是在网络协议和 Pipeline 场景下，针对这个代价做出的另一种权衡。

## 结尾：从单 position 走向双指针

现在可以回看开头的问题：为什么一个 Buffer 能同时服务写入、读取、重读和半包追加？因为它没有把这些状态当成不同对象，而是用四字段不变量和状态迁移方法表达：

- position 表示当前相对访问位置
- limit 表示当前有效边界
- capacity 表示总容量
- mark 提供临时回退
- flip 在写读之间转换边界
- compact 保留未读数据并恢复写空间
- clear、rewind、mark/reset 分别处理不同的复位需求

这套模型解决了“一个对象如何管理一段数据的读写阶段”，但还没有解决“数据实际放在哪里”和“多个处理器如何共享读写进度”。下一篇进入 HeapBuffer 与 DirectBuffer；再之后，Ch4 ByteBuf 会把这里的单 position 演进成 readerIndex/writerIndex 双指针。
