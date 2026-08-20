# Ch7-03 出站与写缓冲区 — rewrite-plan

## 篇章定位

- 核心困惑：`ctx.write(msg)` 到底把数据写到哪里了？为什么还要再 `flush()`？如果 write 只是把消息挂起来，那什么时候真正落到 Socket？大量 write 如何避免每条消息一次 syscall？
- 一句话顿悟：Netty 把“提交写请求”和“真正触发 I/O”拆成两步：`write()` 只是把消息变成 `ChannelOutboundBuffer.Entry` 挂到 unflushed 链段，`flush()` 才把这段链整体标记为 flushed，并通过 `nioBuffers()` 组装批量写；高低水位和 `unwritable` 位掩码则把“还能不能继续写”反馈回 pipeline。
- 篇章边界：重点讲 `AbstractChannelHandlerContext.write/flush` 的传播、`ChannelOutboundBuffer` 三指针链、`addMessage/addFlush/remove/removeBytes`、`nioBuffers()`、高低水位和 `ChannelWritabilityChanged`；生命周期 pending callback 留 Ch7-04。

## 依赖

### HARD

- Ch7-01：Pipeline 骨架、tail 发起 outbound、head 落到 `unsafe`。
- Ch7-02：outbound handler 类型与 `read/write/flush` 的传播资格。
- Ch4 ByteBuf：`internalNioBuffer()`、聚集写、refCnt 释放。
- Ch6 Promise：`ChannelPromise`、`DefaultChannelProgressivePromise`、`VoidChannelPromise`。

### SOFT

- NIO gather write / writev 背景：正文用最小解释说明“收集多个 ByteBuffer 一次写出”。
- TCP 回压常识：辅助理解高低水位。

### NAV

- Ch7-04：ChannelInitializer、PendingHandlerCallback、生命周期回调。
- ChannelOutboundBuffer 更深层的 `WriteTask` / `ChannelOutboundBuffer` 反压与 ChannelOutboundInvoker 结合，可在后续 Channel/Transport 细节篇再展开。

## 素材事实卡片

### 卡片 A：出站传播不是直接写 Socket

- `AbstractChannelHandlerContext.java:736-841`：`write(msg, promise)` / `write(msg, flush, promise)` / `flush()` 的传播路径。
- `write` 先 `findContextOutbound(MASK_WRITE or MASK_WRITE|MASK_FLUSH)`，必要时 `pipeline.touch(msg, next)`，然后直接调用下一个 outbound handler 或封装成 `WriteTask` 切到对应 executor。
- `flush()` 独立传播到下一个 outbound context。
- 关键叙事：`write` 与 `flush` 是分开的两个事件；`writeAndFlush` 只是把两者串在一起。

### 卡片 B：ChannelOutboundBuffer 三指针

- `ChannelOutboundBuffer.java:76-85`：`flushedEntry` / `unflushedEntry` / `tailEntry` + `flushed` 计数。
- `addMessage`：新建 Entry，挂到 tail，必要时设 `unflushedEntry`，touch message，增加 pending bytes，见 `ChannelOutboundBuffer.java:114-140`。
- `addFlush`：从 `unflushedEntry` 开始整段转 flushed，`setUncancellable`，取消则回收 pending bytes，最后把 `unflushedEntry = null`，见 `ChannelOutboundBuffer.java:146-170`。
- 关键叙事：链表不是“已写/未写”两段，而是 flushed、unflushed、tail 三个游标界定的阶段。

### 卡片 C：Entry 与 Promise/释放

- `ChannelOutboundBuffer.java:826-898`：Entry 用 Recycler 复用；保存 `msg/promise/progress/total/pendingSize/count/cancelled`。
- `newInstance` 把 `pendingSize = size + ENTRY_OVERHEAD`。
- `cancel()` 释放 msg、置空缓存、返回 pending size；`unguardedRecycle()` 回收 entry。
- `remove()` / `remove(Throwable)`：从 flushed 段移除，成功/失败完成 promise，释放 msg，扣减 pending bytes，见 `ChannelOutboundBuffer.java:275-345`。
- `progress(long amount)`：对 progressive promise 更新进度，且对 `VoidChannelPromise` / `DefaultChannelPromise` 有 fast-path，见 `ChannelOutboundBuffer.java:247-268`。

### 卡片 D：`nioBuffers()` 和数组复用

- `ChannelOutboundBuffer.java:67-72`：`FastThreadLocal<ByteBuffer[]>` 初始 1024。
- `ChannelOutboundBuffer.java:414-496`：遍历 flushed 段，把 ByteBuf 提取成单个或多个 ByteBuffer，受 `maxCount/maxBytes` 约束。
- `ChannelOutboundBuffer.java:498-534`：`entry.bufs` / `entry.buf` 缓存，以及 `expandNioBufferArray()` 翻倍扩容。
- `ChannelOutboundBuffer.java:541-551`：`nioBufferCount/nioBufferSize` 结果缓存。
- 关键边界：这是“零新增数据复制”的聚集写准备，但不是所有消息都能走单一 ByteBuffer；也不是返回的新数组可逃逸到方法外长期持有。

### 卡片 E：高低水位与可写性

- `ChannelOutboundBuffer.java:92-104`：`totalPendingSize` 与 `unwritable` 字段。
- `ChannelOutboundBuffer.java:176-207`：超过 `highWaterMark` -> `setUnwritable`；低于 `lowWaterMark` -> `setWritable`。
- `ChannelOutboundBuffer.java:554-660`：bit0 表示系统水位不可写；1-31 位是用户自定义可写标记；切换时通过 `pipeline.fireChannelWritabilityChanged()` 通知。
- 关键叙事：这不是阻塞 write，而是通过可写性状态把反压反馈给上层 handler。

## 理解路径

1. **从“write 之后数据去哪了”切入**：写调用不会立即打到 Socket，它先进入 outbound buffer。
2. **先讲传播，再讲存储**：tail 发起 outbound，head 最终落到 `unsafe.write/flush`；中间 `write` 与 `flush` 是两次不同传播。
3. **再立三指针链图**：`flushedEntry -> ... -> unflushedEntry -> ... -> tailEntry`，解释 write/flush 分离。
4. **讲 Entry 为什么同时持有 msg/promise/size/progress**：因为真正写出、失败、取消、回收都在这里会合。
5. **讲 `nioBuffers()`**：为什么聚集写不等于复制大 buffer，而是收集 ByteBuffer 引用；FastThreadLocal 数组复用减少垃圾。
6. **讲高低水位与 unwritable 掩码**：写不是阻塞，而是通过 `isWritable` 与事件回调实现反压。
7. **收网**：出站路径的核心不是“write 调用链”，而是“消息先挂缓冲链，再由 flush 和可写性共同决定何时真正落到 Socket”。

## 失败方案推演

- 每次 `write(msg)` 都立即 syscall：大量小消息会产生大量系统调用，无法批量聚合。
- `write` 自动隐式 `flush`：用户失去攒批控制权，`write`/`flush` 语义被混淆。
- 不维护三指针链，只用一个 list：很难表达“已 write 未 flush”和“已 flush 待写出”两个阶段。
- `nioBuffers()` 每次新建数组：高频写路径产生 GC 压力。
- 没有高低水位：上层持续写入，直到内存/Socket 缓冲区失控，没有反压反馈。

## 文章结构与预算

1. `write` 之后数据去了哪（1000-1300 字）
2. 出站传播：tail -> outbound handlers -> head -> unsafe（1700-2200 字）
3. 三指针链：flushed / unflushed / tail（2200-2800 字）
4. Entry：消息、promise、释放与进度（1700-2200 字）
5. `nioBuffers()`：聚集写与数组复用（1700-2200 字）
6. 高低水位与可写性反压（1700-2200 字）
7. 误解澄清与 Ch7-04 桥接（1000-1300 字）

目标：删掉代码后的叙述性正文 9500-11000 字。

## 证据清单

- `AbstractChannelHandlerContext.java:736-841`
- `ChannelOutboundBuffer.java:67-140`
- `ChannelOutboundBuffer.java:146-170`
- `ChannelOutboundBuffer.java:176-207`
- `ChannelOutboundBuffer.java:247-345`
- `ChannelOutboundBuffer.java:348-399`
- `ChannelOutboundBuffer.java:414-551`
- `ChannelOutboundBuffer.java:554-660`
- `ChannelOutboundBuffer.java:826-898`

## 边界清单

- `write()` 本身不保证立刻触发实际 I/O；真正是否写出取决于 flush 和底层 transport。
- `nioBuffers()` 复用的是线程本地数组，不能把返回数组当长期持有对象。
- 聚集写减少系统调用和复制机会，但并不意味着所有消息都零复制或所有平台都走同一路径。
- 高低水位通过 writability 状态反馈反压，不是让写调用在用户线程里阻塞。
- 本篇不展开 PendingWriteQueue / ChannelOutboundBuffer 全部辅助类语义，只聚焦主链路。

## 深审预警

- [ ] 不把 `write` 和 `flush` 语义混在一起。
- [ ] 三指针链要用阶段语义讲清，不能只列字段名。
- [ ] 明确 `remove()` 成功路径会 release msg、success promise、扣减 pending bytes；失败路径走 `remove(Throwable)`。
- [ ] `nioBuffers()` 要说明 maxCount/maxBytes 约束和数组扩容，不要写成“永远固定 1024”。
- [ ] 高低水位是阈值反压，不是同步阻塞。
- [ ] 如果在出站缓冲路径里发现 promise 完成/释放顺序可能有真实缺陷候选，按方法论记录 issue 候选。
