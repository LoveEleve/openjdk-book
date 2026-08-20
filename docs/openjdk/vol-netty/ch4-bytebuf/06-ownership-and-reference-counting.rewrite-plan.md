# Ch4-06 Netty 对象所有权与引用计数协议 — rewrite-plan

## 篇章定位

- 核心困惑：`ByteBuf` 已经有 `refCnt` 了，为什么业务里还是会反复踩到“谁该 release、何时 retain、为什么 HTTP/2 frame 读到手里还要我释放”这类坑？
- 一句话顿悟：Netty 的引用计数不是一个孤立 API，而是一套跨 `ByteBuf`、`ByteBufHolder`、codec、pipeline、出站缓冲、HTTP/2 frame 的对象所有权协议；`refCnt` 只负责回答“现在还活着吗”，不负责替你决定“归谁释放”。
- 文章边界：本篇主讲 `ReferenceCounted` / `ReferenceCountUtil` / `AbstractReferenceCounted` / `AbstractReferenceCountedByteBuf` / `ByteBufHolder` 这一层的 ownership 协议，主讲 retain/release/touch/deallocate/ensureAccessible 在跨 handler、跨 codec、跨 holder 对象中的责任分工；泄漏检测器、allocator leak-aware wrapper、HTTP/2 API 层、出站缓冲细节放到后续篇。

## 依赖

### HARD

- Ch2-01 `ch2-channel/01-read-write.md`：理解一次 read / write 不等于对象生命周期结束。
- Ch4-01 `ch4-bytebuf/01-dual-index-and-refcnt.md`：已有 `refCnt`、`deallocate()`、`ensureAccessible()` 的基础认知。
- Ch7-01 `ch7-pipeline/01-pipeline-structure.md`：理解消息会跨多个 handler 接力传递。
- Ch7-02 `ch7-pipeline/02-handler-types.md`：理解 inbound / outbound handler 的职责分工。

### SOFT

- Ch6-01 `ch6-promise/01-state-model-and-listeners.md`：这里只需要“异步完成不等于对象立刻可回收”的最小概念。
- Ch10-02 `ch10-codec/02-encoders-and-framedecoders.md`：这里只借用“codec 可能消费旧对象并生成新对象”的场景，不依赖具体实现细节。

### NAV

- Ch4-04：派生视图与零拷贝如何共享生命周期。
- 后续篇（待写）：内存泄漏检测与 leak-aware wrapper。
- Ch7-03：`ChannelOutboundBuffer` 如何在出站链路里托管对象。
- Ch12-02/03（待写）：HTTP/2 frame / stream 对象如何继续沿用同一套 ownership 协议。

## 素材事实卡片

### 卡片 A：引用计数的最小骨架

- `ReferenceCounted.java:23-75`：协议面只暴露 `refCnt/retain/release/touch`，没有“自动所有者”概念。
- `AbstractReferenceCounted.java:23-77`：通用对象的 retain/release 模板；归零时调用 `deallocate()`。
- `AbstractReferenceCountedByteBuf.java:24-102`：ByteBuf 版本的同构模板，`touch()` 默认是 no-op。
- 结论：引用计数回答的是“还能不能用、归零时怎么收尾”，不是“谁应该收尾”。

### 卡片 B：统一兜底入口不是只给 ByteBuf 用的

- `ReferenceCountUtil.java:31-32`：把 `touch` 从 leak detector 排除，避免干扰记录。
- `ReferenceCountUtil.java:39-82`：`retain/touch` 在对象实现了 `ReferenceCounted` 时才生效。
- `ReferenceCountUtil.java:88-115`：`release` / `release(int)` 是跨 holder / frame / message 的通用兜底入口。
- `ReferenceCountUtil.java` 后半段：`safeRelease` / `releaseLater` 表明 Netty 现实里默认承认“释放失败”和“延迟释放”都是常见场景。

### 卡片 C：ByteBufHolder 说明 ownership 不是只围绕裸 ByteBuf

- `ByteBufHolder.java`：内容对象和外层 holder 共用生命周期，`content()` 只是入口。
- `DefaultByteBufHolder.java`：`copy/duplicate/retainedDuplicate/replace/retain/release/touch` 全部要把 holder 和底层 content 一起考虑。
- 结论：HTTP 消息、HTTP/2 frame、WebSocket frame 这类对象的 release 责任并不会因为“我拿到的是 holder，不是 ByteBuf”而消失。

### 卡片 D：codec 和对象流会主动转移 ownership

- `MessageToMessageEncoder.java:82-125`：`encode()` 后主动 `ReferenceCountUtil.release(cast)`，说明“被编码的旧对象”默认已被消费。
- `MessageToByteEncoder` / `ByteToMessageDecoder`（只作辅助引用）：一个方向经常是“旧对象释放，新对象写出/传播”；另一个方向经常是“输入 ByteBuf 切片/聚合后把结果交给后续 handler”。
- 结论：一旦消息跨 codec 边界，ownership 往往已经改变，不能继续按“我最早创建它，所以永远归我释放”理解。

### 卡片 E：出站缓冲会接管一段生命周期，但不是永久接管

- `ChannelOutboundBuffer.java:114-140`：`addMessage` 时触摸消息并统计 pending bytes，说明 write 之后对象暂时被出站层接管。
- `ChannelOutboundBuffer.java:720-733`：channel 关闭时释放未刷出的消息并 fail promise。
- `PendingWriteQueue.java:30-33`：待写队列同样把可写性和 pending bytes 纳入生命周期管理。
- 结论：调用 `ctx.write(msg)` 之后，对象 ownership 已部分转交给出站链；但 transfer 只持续到写成功、写失败或 channel 关闭，不是“从此和业务无关”。

### 卡片 F：HTTP/2 API 明确把 release 责任继续交给应用

- `Http2FrameCodec.java:131-137`：frame codec 会在传播前 `retain()` 引用计数对象，因此应用消费后仍需 `release()`。
- `Http2MultiplexHandler.java:67-73`：multiplex child channel 同样沿用相同规则。
- 结论：协议层越高级，ownership 越不会自动消失；它只是换了一种载体继续存在。

## 理解路径

1. **从最常见事故开场**：同一个消息穿过两个 handler、一个 encoder、一个异步 write，业务最容易犯的错不是“不会调 API”，而是以为“谁创建谁销毁”在异步链路里仍然成立。
2. **先拆“活着”和“归谁”**：`refCnt` 只表示对象是否仍可访问；所有权协议才回答谁负责最后一次 `release()`。
3. **给出最小角色图**：创建者、转发者、消费者、包装者、缓冲者五类角色，各自面对不同责任。
4. **推演直觉但错误的方案**：只靠 GC、只靠谁创建谁释放、所有 handler 都不 release、所有 handler 都抢着 release，为什么都不行。
5. **讲模板骨架**：`ReferenceCounted` / `AbstractReferenceCounted` / `AbstractReferenceCountedByteBuf` 只提供“归零收尾”的底座。
6. **讲 ownership 的第一次复杂化**：`ByteBufHolder`、派生视图、codec 会让“看起来是新对象”的东西继续共享旧生命周期。
7. **讲异步链和缓冲区的接管边界**：出站缓冲、待写队列、Promise 失败路径为什么要代替业务释放对象。
8. **用 HTTP/2 收网**：说明这不是 ByteBuf 小技巧，而是 Netty 全栈共用协议。

## 失败方案推演

- 只靠 GC：GC 看不到业务何时完成，Direct 内存和池化对象的归还时机都会失控。
- 谁创建谁释放：异步 write、pipeline 转发、codec 包装都会打破“创建点 = 完成点”。
- 谁收到谁释放：消息可能还要继续向后传播，过早 release 会把后续 handler 变成 use-after-free。
- 永远不 release，只等 channel close：短链路也许能熬，长连接和池化内存会持续堆积，最后只剩 leak。
- 所有包装对象都当独立对象看：`ByteBufHolder`、slice、retainedDuplicate、HTTP/2 frame 会把同一底层内存包成不同外形，重复 release 或漏 release 都会出现。
- 把 retain 当成“复制一份”：retain 只是增加共享寿命，不会复制底层内容，也不会自动生成新的释放责任说明书。

## 文章结构与预算

1. 开场事故：为什么 Netty 里“谁该 release”总是说不清（1000-1400 字）
2. 先拆概念：对象活着，不等于 ownership 清楚（1400-1800 字）
3. 模板骨架：`ReferenceCounted` 到 `deallocate()` 到底负责什么（1800-2300 字）
4. ownership 协议：创建者、转发者、消费者、包装者、缓冲者五类角色（2200-2800 字）
5. `ByteBufHolder` 与包装对象：为什么外层对象不会抹掉 release 责任（1500-2000 字）
6. codec / write / async 边界：对象什么时候转交给 Netty 运行时（1800-2400 字）
7. 误解澄清：retain 不是 copy，refCnt 不是 ownership，channel write 不是立刻释放（1000-1400 字）
8. 收网：为 leak detector、ChannelOutboundBuffer、HTTP/2 API 层建立桥接（600-900 字）

目标：去掉代码块后的叙述性正文 9000-12000 字，最低不低于 8000 字。

## 证据清单

- `common/src/main/java/io/netty/util/ReferenceCounted.java`
- `common/src/main/java/io/netty/util/AbstractReferenceCounted.java:23-77`
- `common/src/main/java/io/netty/util/ReferenceCountUtil.java:26-209`
- `buffer/src/main/java/io/netty/buffer/AbstractReferenceCountedByteBuf.java:24-102`
- `buffer/src/main/java/io/netty/buffer/ByteBufHolder.java`
- `buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java`
- `codec-base/src/main/java/io/netty/handler/codec/MessageToMessageEncoder.java:82-125`
- `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:114-140`
- `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:720-733`
- `transport/src/main/java/io/netty/channel/PendingWriteQueue.java:30-33`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:131-137`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:67-73`

## 边界清单

- 本篇不把 leak detector 细节、采样级别、record 链路展开，只把 `touch()` 的 ownership 含义作为导航。
- 本篇不把 allocator / 池化 / thread cache 当作 ownership 的决定者；它们决定的是底层回收路径，不直接决定业务责任。
- 本篇不把 `retain/release` 原子更新写成“消息对象完全线程安全”；这里只讨论寿命协议，不把内容并发访问问题混入。
- 本篇不完整展开 slice / duplicate / retainedSlice 的派生视图矩阵，只建立“共享生命周期”的最低心智模型并桥到 Ch4-04。
- 本篇不把 HTTP/2 API 层细节提前写透，只用它证明 ownership 协议跨协议层延续。

## 深审预警

- [ ] 不把 `refCnt` 写成 ownership 本身；必须始终区分“存活状态”和“责任归属”。
- [ ] 不把 `retain()` 写成 copy。
- [ ] 不把 `ctx.write(msg)` 写成“立刻发送成功并立刻可释放”。
- [ ] 不把 `ByteBufHolder` 写成与底层 `ByteBuf` 生命周期分离。
- [ ] 不把 codec 自动 release 表述成“所有 codec 都总是替业务兜底”。要限定到当前类与当前调用路径。
- [ ] 不把 channel close 的释放路径写成正常成功路径的代表；它是兜底失败路径。
- [ ] 代码块出场前先交代它要证明哪种 ownership 转移。
- [ ] 删掉代码块后，文章仍要能用纯叙事解释“谁创建、谁传递、谁消费、谁缓冲、谁兜底”。