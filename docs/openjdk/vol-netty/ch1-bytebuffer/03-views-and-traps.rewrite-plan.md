# Netty Ch1-03 视图与陷阱 — 正文写作规划

## 文章定位

- 写作卷：`vol-netty`
- 章节：Ch1 NIO ByteBuffer
- 篇：03 视图、字节序与 API 陷阱
- 正文目标：`vol-netty/ch1-bytebuffer/03-views-and-traps.md`
- 当前状态：篇级规划完成，正文未写

## 前置依赖

### HARD

- Ch1-01：Buffer 四字段与 position/limit 状态机
- Ch1-02：Heap/Direct 分配差异与 wrap 共享数组语义

### SOFT

- Ch2 Channel：用于协议解析、批量 IO 和 TCP 流场景
- Ch4 ByteBuf：只用于结尾对照 reader/writer index、引用计数和 LE API

### NAV

- Ch2 Channel：ByteBuffer 如何进入 SocketChannel read/write
- Ch4 ByteBuf：Netty 如何重做视图、索引和生命周期管理

## 一句话困惑

多个 Buffer 视图明明像独立对象，为什么修改一个会影响另一个；同一段字节又为什么会因为 position、byte order 或 Heap/Direct 类型不同而得到不同结果？

## 一句话顿悟

NIO 的视图复制的是状态，不是数据；API 的比较、字节序和数组访问也都依赖当前视图状态，因此“共享存储 + 独立游标”既是零拷贝能力，也是所有权和边界陷阱的来源。

## 读者理解路径

1. 从“切分协议消息但不想复制”引出共享视图。
2. 对比 slice、duplicate、asReadOnlyBuffer：共享什么、独立什么、禁止什么。
3. 讲 hasArray/array 的 Heap/Direct 分叉。
4. 讲 equals/compareTo 为什么只看 remaining。
5. 讲 order 的状态污染与多字节解码边界。
6. 讲 bulk get/put 的边界检查和批量路径。
7. 收束 mark/reset 的单层快照，再桥接 Channel 和 Netty ByteBuf。

## 失败方案推演

- 视图创建时复制全部数据：安全但破坏零拷贝并增加分配/复制。
- 所有 Buffer 都调用 `array()`：Direct/ReadOnly 路径直接失败。
- equals 比较整个 capacity：无法表达当前可读区间语义。
- order 由每次方法传参：调用方复杂度上升，或共享状态污染。

## 必须澄清的误解

1. slice/duplicate 是共享底层存储，不是深复制。
2. slice 与 duplicate 的边界和初始 position/limit 不同。
3. read-only view 共享数据但禁止写操作。
4. `hasArray()==false` 不等于数据不可读，只表示没有可暴露的 byte[]。
5. equals/compareTo 比较的是 remaining 区间，不是全部 capacity。
6. order 是多字节访问语义，不是数据实际转换或重排。
7. bulk get/put 仍然推进 position；批量不等于 absolute。
8. mark/reset 只有一个 mark，不是多层事务回滚。

## 文章结构与字数预算

1. 共享视图的选择困惑（900-1100 字）
2. slice/duplicate/read-only 三种视图（1700-2200 字）
3. hasArray/array 的类型陷阱（900-1200 字）
4. equals/compareTo 的 remaining 语义（1000-1300 字）
5. order 与 bulk get/put（1500-1900 字）
6. mark/reset 与所有权边界收束（900-1200 字）
7. 误解清单与 Ch2/Ch4 桥接（700-900 字）

目标叙述性正文：7000-9000 字；以闭环质量为准，不把字数作为硬门槛。

## 证据清单

写作时重新验证当前 JDK 源码：

- `X-Buffer.java.template`：slice/duplicate/asReadOnlyBuffer/hasArray/array/equals/compareTo/order/bulk get/put
- `Heap-X-Buffer.java.template`：heap view 的 offset 与数组共享
- `Direct-X-Buffer.java.template`：direct view 与 read-only 分支
- `Buffer.java`：mark/reset 状态迁移
- Netty Ch4 大纲：只用于桥接，不替代 JDK 证据

## 深审清单

- [ ] 证明 view 共享底层存储但独立状态
- [ ] 区分 slice/duplicate/read-only 的边界差异
- [ ] 不把 hasArray/array 说成所有 Buffer 通用能力
- [ ] equals/compareTo 明确 remaining 区间
- [ ] order 与 bulk 操作不混成同一问题
- [ ] 不提前展开 Channel/ByteBuf 实现
- [ ] 通过六轮正文 review
