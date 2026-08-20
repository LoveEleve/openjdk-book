# Ch4-06 Netty 对象所有权与引用计数协议 — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `ReferenceCounted` 当前只定义 `refCnt/retain/release/touch`，并明确新对象初始引用计数为 1、归零后显式释放，证据：`common/src/main/java/io/netty/util/ReferenceCounted.java:19`。 
2. `AbstractReferenceCounted` 当前通过 `RefCnt.release(...) -> deallocate()` 建立通用对象的释放模板，证据：`common/src/main/java/io/netty/util/AbstractReferenceCounted.java:57`。  
3. `AbstractReferenceCountedByteBuf` 当前通过同样模式建立 ByteBuf 版本释放模板，证据：`buffer/src/main/java/io/netty/buffer/AbstractReferenceCountedByteBuf.java:82`。  
4. `ReferenceCountUtil` 当前对任意实现了 `ReferenceCounted` 的对象提供 `retain/touch/release/safeRelease/refCnt` 兜底入口，证据：`common/src/main/java/io/netty/util/ReferenceCountUtil.java:39`、`:88`、`:114`、`:172`。  
5. `ReferenceCountUtil.releaseLater(...)` 当前明确标注为面向单元测试的简化工具，不建议泛化到正常业务，证据：`common/src/main/java/io/netty/util/ReferenceCountUtil.java:140`。  
6. `ByteBufHolder` 当前本身继承 `ReferenceCounted`，说明 holder 没有脱离引用计数协议，证据：`buffer/src/main/java/io/netty/buffer/ByteBufHolder.java:23`。  
7. `DefaultByteBufHolder` 当前把 `refCnt/retain/release/touch` 全部委托给底层 `ByteBuf`，证据：`buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:80`、`:86`、`:109`。  
8. `DefaultByteBufHolder.content()` 当前先执行 `ByteBufUtil.ensureAccessible(data)`，证据：`buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:34`。  
9. `DefaultByteBufHolder.copy/duplicate/retainedDuplicate` 当前分别走 `data.copy()/duplicate()/retainedDuplicate()`，证据：`buffer/src/main/java/io/netty/buffer/DefaultByteBufHolder.java:44`、`:54`、`:64`。  
10. `MessageToMessageEncoder.write()` 当前在 `encode(...)` 之后会 `ReferenceCountUtil.release(cast)`，证据：`codec-base/src/main/java/io/netty/handler/codec/MessageToMessageEncoder.java:82`、`:95`。  
11. `ChannelOutboundBuffer.addMessage(...)` 当前在加入 entry 后会 `touch(msg)` 并增加 pending bytes，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:114`、`:127`、`:139`。  
12. `ChannelOutboundBuffer.nioBuffers(...)` 当前使用 `InternalThreadLocalMap` / `FastThreadLocal<ByteBuffer[]>` 组织写出数组，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:432`、`:437`。  
13. `ChannelOutboundBuffer.close(...)` 当前会释放未 flush 消息并 fail promise，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:720`。  
14. `PendingWriteQueue` 当前类注释明确它既缓存待写消息，也把这些消息纳入 writability 判断，证据：`transport/src/main/java/io/netty/channel/PendingWriteQueue.java:30`。  
15. `PendingWriteQueue.add(...)` 当前会统计 pending bytes 并 `touch(msg)`，证据：`transport/src/main/java/io/netty/channel/PendingWriteQueue.java:120`。  
16. `PendingWriteQueue.removeAndFailAll(...)` 当前会 `safeRelease(write.msg)`，证据：`transport/src/main/java/io/netty/channel/PendingWriteQueue.java:182`。  
17. `Http2FrameCodec` 当前明确说明：传播前会 `retain()` 引用计数 frame，应用消费后仍需 release，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:131`。  
18. `Http2MultiplexHandler` 当前对 child stream channel 同样沿用这条规则，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:67`。

### 深审发现

1. **中风险：容易把 `refCnt` 直接写成 ownership。** 正文已反复区分“存活状态”和“责任归属”，避免偷换概念。  
2. **中风险：容易把 `ctx.write(msg)` 写成“立刻发送成功”。** 正文已改成“进入 Netty 出站托管区”的表述，并用 `ChannelOutboundBuffer` / `PendingWriteQueue` 证据支撑。  
3. **低风险：`ByteBufHolder` 容易被写成‘只是普通外壳’。** 正文已补 `ByteBufHolder extends ReferenceCounted` 与 `DefaultByteBufHolder.release -> data.release()` 事实。  
4. **低风险：`retain()` 容易被误说成 copy。** 正文已专门澄清并借 `copy/duplicate/retainedDuplicate` 对照说明。

## 第二轮：因果审

- 只靠 GC -> 无法确定业务完成时刻 -> 显式释放协议需要存在：✅  
- `refCnt` 只描述对象是否存活 -> 不能自动决定谁最终 release：✅  
- holder / codec / write / async buffer 会打破“谁创建谁释放”：✅  
- `ChannelOutboundBuffer` / `PendingWriteQueue` 接管一段托管生命周期 -> write 之后 ownership 阶段性转交给运行时：✅  
- HTTP/2 API 层继续要求应用释放 frame -> ownership 协议并未停留在 `ByteBuf` 层：✅

未发现把设计推断直接冒充源码事实的高风险段落。

## 第三轮：结构审

正文结构按“事故场景 -> 概念拆分 -> 失败方案 -> 模板骨架 -> 五类角色 -> holder -> codec -> write 托管 -> HTTP/2 收网 -> 误解澄清 -> 篇末桥接”推进，没有沿源码文件顺序平铺。✅

失败方案已覆盖：
- 只靠 GC  
- 谁创建谁释放  
- 谁收到谁释放  
- 永远不 release 等 close 兜底  
- 把 retain 当 copy  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `refCnt` 解决的是“活着没有”  
- ownership 协议解决的是“归谁负责”  
- `ByteBufHolder` 不会切断底层生命周期  
- codec 会消费旧对象 ownership 并产出新对象  
- write 之后对象会进入 Netty 的托管区  
- HTTP/2 frame 仍沿用同一套 release 规则  

当前正文用纯叙事已能保留这条主线。✅

## 第五轮：边界审

- 未把 leak detector 细节提前写透，只作为后续桥接。✅  
- 未把 allocator / 池化写成 ownership 决定者。✅  
- 未把 `retain/release` 原子更新写成对象内容全线程安全。✅  
- 未把 `ChannelOutboundBuffer.close` 写成正常成功路径，只写成失败兜底。✅  
- 未把 HTTP/2 API 层细节提前展开为完整后续章节。✅

## 第六轮：依赖审

- 依赖 Ch4-01 的 `refCnt/deallocate/ensureAccessible` 基础，真实存在。✅  
- 依赖 Ch7 Pipeline 的消息接力场景，真实存在。✅  
- Ch7-03 出站缓冲、泄漏检测、HTTP/2 API 扩展都只作导航，没有把后文结论当作本篇前提。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 15,856。  
- 去掉常见 markdown 标记后的字符数：约 15,398。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已完成事实、因果、结构、边界、依赖与机械检查。Ch4-06 可作为后续 `leak detector` 与 `ChannelOutboundBuffer / writability` 两篇的前置篇。