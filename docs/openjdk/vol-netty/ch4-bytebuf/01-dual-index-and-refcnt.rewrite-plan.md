# Ch4-01 ByteBuf 双指针与引用计数 — rewrite-plan

## 篇章定位

- 核心困惑：JDK `ByteBuffer` 已经能承载网络数据，Netty 为什么还要重新设计一个 `ByteBuf`？
- 一句话顿悟：`ByteBuffer` 把读写共用一个 position，迫使调用者反复切换模式；ByteBuf 把读进度、写进度和资源寿命分别显式化，用 `readerIndex/writerIndex` 管数据，用 `refCnt` 管内存寿命。
- 文章边界：本篇讲 ByteBuf 的核心抽象、索引回收、可写容量、引用计数和释放多态；分配器、堆/直接内存、派生视图、Composite、leak-aware wrapper 留给后续篇。

## 依赖

### HARD

- Ch1 ByteBuffer：`position/limit/capacity`、`flip/compact/clear`、DirectBuffer 的 Cleaner 生命周期问题。
- Ch2 Channel：read/write 与 ByteBuffer 协作、半包和部分进度。
- Ch3 Selector：事件驱动场景、多个 Handler/阶段共同消费同一个缓冲区的上下文。

### SOFT

- Netty Pipeline：这里只用“多个处理阶段接力”作场景，不依赖 Pipeline 实现细节。
- Java CAS/volatile：正文给最小解释，不把并发原理单独展开。

### NAV

- Ch4-02：Allocator 如何创建并选择 ByteBuf，`calculateNewCapacity` 的策略与 4 MiB 边界。
- Ch4-03：Heap/Direct 的底层存储与访问路径。
- Ch4-04：slice/duplicate/retainedSlice 的生命周期边界。
- Ch5：EventLoop 如何驱动 ByteBuf 的读写。

## 素材事实卡片

### 卡片 A：三区域与双指针

- `ByteBuf.java:59-74` 定义 readerIndex/writerIndex 和 discardable/readable/writable 三段。
- `AbstractByteBuf.java:110-115` 约束 `0 <= readerIndex <= writerIndex <= capacity`。
- `AbstractByteBuf.java:156-184`：readable/writable bytes 的计算与判断。
- `ByteBuf.java:458-467`：`clear()` 只重置索引，不擦除内容，且语义不同于 NIO `clear()`。
- `ByteBuf.java:78-104`：read 操作推进 readerIndex，write 操作推进 writerIndex。

### 卡片 B：discardReadBytes / discardSomeReadBytes

- `AbstractByteBuf.java:216-233`：完整压缩，把 `[readerIndex, writerIndex)` 搬到 0，调整 writerIndex/markers，O(可读数据长度) 拷贝。
- `AbstractByteBuf.java:235-255`：只有 readerIndex >= capacity/2 才压缩，否则保留现状；若读完则直接清零。
- `ByteBuf.java:505-521`：接口合同明确“可能丢弃部分、全部或不丢弃”，用带宽换内存。
- 本篇不展开 Composite 的 component 级回收，避免越过 Ch4-05。

### 卡片 C：可写容量与 ensureWritable

- `ByteBuf.java:407-430`：readable/writable/maxWritable/maxFastWritable 的定义。
- `ByteBuf.java:524-556`：无状态码版本可能抛异常；带 `force` 的版本返回 0/1/2/3。
- `AbstractByteBuf.java:279-335`：先检查当前空间，再看 maxCapacity，再计算新 capacity；状态码 3 表示扩到 maxCapacity 仍不够，而不是“扩容成功后一定可写满请求”。
- 本篇讲状态语义和调用者决策，不展开 allocator 的增长算法。

### 卡片 D：引用计数分层

- `AbstractReferenceCountedByteBuf.java:24-43`：ByteBuf 持有 `RefCnt`，`refCnt()` 委托给它，`isAccessible()` 使用 non-volatile best-effort 判断。
- `AbstractReferenceCountedByteBuf.java:59-69`：retain 委托 `RefCnt.retain`。
- `AbstractReferenceCountedByteBuf.java:82-101`：release 委托 `RefCnt.release`，只有归零才调用抽象 `deallocate()`。
- `RefCnt.java:34-46`：按 Unsafe / VarHandle / AtomicIntegerFieldUpdater 选择实现。
- `RefCnt.java:50-58`：内部 raw value 使用偶数表示活跃引用数、奇数表示归零状态；不是直接把业务 refCnt 原样存入字段。
- `RefCnt.java:254-295`：Atomic fallback 的 retain/release 与 CAS/原子加减；`RefCnt.java:359-373`：VarHandle CAS 释放；Unsafe 变体同样走原子更新。
- `AbstractByteBuf.java:1474-1482`：ensureAccessible 入口检查，可由 `io.netty.buffer.checkAccessible` 控制。
- 本篇不把“CAS 让 ByteBuf 任意多线程安全”写成事实；引用计数更新可并发，ByteBuf 内容和索引仍须遵守更高层线程模型。

### 卡片 E：释放多态

- `AbstractReferenceCountedByteBuf.java:91-101`：归零后调用子类 `deallocate()`。
- `UnpooledHeapByteBuf.java:548`：堆实现清理底层数组引用/状态，具体回收仍由 GC 管理。
- `UnpooledDirectByteBuf.java:781`：Direct 实现释放 direct buffer 资源。
- `PooledByteBuf.java:174`：池化实现归还 arena/池结构。
- 本篇只讲“同一 release 入口对应不同底层释放策略”，不深入 allocator 内部。

## 理解路径

1. **从 Pipeline 接力中的状态错位切入**：Handler A 写、Handler B 读、Handler C 继续写，展示单 position 必须 flip/compact 的冲突。
2. **给出双指针最小心智图**：readerIndex/writerIndex 将“已消费、可读、可写”三区域分开，读写不再切换模式。
3. **处理空间回收的反例**：双指针不等于空间自动回收；discardReadBytes 和 discardSomeReadBytes 是“拷贝换空间”与“保留空间换带宽”的两种策略。
4. **处理容量上限**：writableBytes 不够时，ensureWritable 的四种结果让调用者分辨“够了、没扩、扩了、到顶”。
5. **从 DirectBuffer 生命周期转向引用计数**：GC/Cleaner 不能提供业务完成时刻，ByteBuf 需要显式 ownership 协议。
6. **拆 retain/release/deallocate/ensureAccessible**：引用数更新、归零动作、底层释放和访问守卫各自负责什么。
7. **收网**：ByteBuf 不是“更好用的 byte[]”，而是把数据进度、容量边界、资源寿命拆成三个可验证的协议。

## 失败方案推演

- 继续使用单 position：每个处理阶段必须接管 flip/compact，状态转换责任扩散，半包和多阶段协作容易错。
- 只调用 clear()：把未处理的 readable 数据一并抹掉，不能代替 discard。
- 每次空间不足都立刻压缩：频繁 O(N) 拷贝，吞吐下降；完全不压缩又会过早扩容。
- 只用 GC 回收 Direct 内存：回收时机与业务 ownership 无关，峰值外存不可控。
- 用 synchronized 包住 retain/release：增加锁竞争；更关键的是，锁只保护引用数，不会自动解决内容访问与生命周期协议。
- 关闭 ensureAccessible 后继续允许不受约束的 release：性能开关只改变检查，不改变 ownership 责任，失误会从立即异常变成更晚的内存/状态问题。

## 文章结构与预算

1. 开场：ByteBuffer 的模式切换为什么在多阶段处理里失控（1200-1500 字）
2. 双指针：把读写进度从模式切换改成并行状态（1800-2300 字）
3. 回收：discard 两种策略与 O(N) 代价（1400-1800 字）
4. 容量：ensureWritable 四状态与 maxCapacity 边界（1500-1900 字）
5. 寿命：为什么 ByteBuf 不能只等 GC（1200-1600 字）
6. 引用计数：retain/release/deallocate/ensureAccessible（2200-2800 字）
7. 误解澄清与总图收网（1000-1400 字）

目标：去掉代码块后的叙述性正文 9000-11000 字；若实际机制闭环更紧，最低不低于 8000 字。

## 证据清单

- `ByteBuf.java:59-74`
- `ByteBuf.java:78-110`
- `ByteBuf.java:407-430`
- `ByteBuf.java:458-467`
- `ByteBuf.java:505-556`
- `AbstractByteBuf.java:110-184`
- `AbstractByteBuf.java:216-269`
- `AbstractByteBuf.java:279-335`
- `AbstractByteBuf.java:1474-1482`
- `AbstractReferenceCountedByteBuf.java:24-43`
- `AbstractReferenceCountedByteBuf.java:59-101`
- `RefCnt.java:34-73`
- `RefCnt.java:242-312`
- `RefCnt.java:315-390`
- `RefCnt.java:393-476`
- `UnpooledHeapByteBuf.java:548`
- `UnpooledDirectByteBuf.java:781`
- `PooledByteBuf.java:174`

## 边界清单

- 基于当前 Netty 源码，不把实现细节外推为所有 Netty 版本的稳定 API 内部结构。
- 基于 Java Heap/Direct 与 Netty Pooled/Unpooled 的当前实现；本篇不比较所有平台 allocator 差异。
- `refCnt` 的原子更新不等于 ByteBuf 内容、readerIndex、writerIndex 可以无锁并发访问。
- `isAccessible()` 的 non-volatile read 仅是 best-effort guard，不能当作严格生命周期同步。
- 引用计数能确定“归零时触发 deallocate”，不能自动推断业务 ownership；漏 release 仍会泄漏，过早 release 仍会失效。
- `ensureWritable` 状态码 0/1/2/3 只描述容量动作结果，不替调用者决定是否等待、丢弃或报错。
- 本篇只导航 slice/duplicate、allocator、heap/direct、Composite、leak detector，不提前把后文结论当作前提。

## 深审预警

- [ ] 不把大纲中“CAS 让多线程共享 ByteBuf 不需要 synchronized”原样写入；需要限定为引用计数更新层面的并发安全。
- [ ] 不把 `ensureWritable` 状态 2 写成“扩容后一定满足全部请求”，严格按接口合同表述。
- [ ] 不把 `discardSomeReadBytes` 固定写成“过半必然压缩”的跨实现规范；当前 AbstractByteBuf 实现如此，接口只保证可能部分/全部/不丢弃。
- [ ] 不把 `clear()` 写成擦除数据。
- [ ] 不把 DirectBuffer Cleaner 和 ByteBuf deallocate 写成同一套释放机制。
- [ ] 不把 `deallocate()` 的 Heap 实现写成“立即释放 byte[]”；准确说是取消/释放 ByteBuf 对底层数组的持有，数组最终仍由 GC 管理。
- [ ] 每个代码块先交代问题和证明目标。
- [ ] 删码后主线仍完整。
