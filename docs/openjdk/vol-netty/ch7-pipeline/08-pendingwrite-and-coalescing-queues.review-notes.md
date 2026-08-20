# Ch7-08 PendingWriteQueue 与 CoalescingBufferQueue — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `PendingWriteQueue` 当前类注释明确：它是一组待后续执行的写操作队列，并会把这些挂起写也纳入 channel writability 判断，证据：`transport/src/main/java/io/netty/channel/PendingWriteQueue.java:29`。  
2. `add(msg, promise)` 当前会创建 `PendingWrite` 节点、增加 `size/bytes`、通过 `PendingBytesTracker` 入账并 `touch(msg)`，证据：`transport/src/main/java/io/netty/channel/PendingWriteQueue.java:101`。  
3. `removeAndWriteAll()` 当前会通过 `PromiseCombiner` 聚合 promise，并允许 re-entrant write 复活队列，证据：`transport/src/main/java/io/netty/channel/PendingWriteQueue.java:141`。  
4. `removeAndFailAll()` 当前会 `safeRelease(write.msg)`、fail promise、回收节点，证据：`transport/src/main/java/io/netty/channel/PendingWriteQueue.java:178`。  
5. `PendingWrite` 当前是一个 Recycler 壳，只保存 `msg/size/promise/next` 元数据，证据：`transport/src/main/java/io/netty/channel/PendingWriteQueue.java:303`。  
6. `AbstractCoalescingBufferQueue` 当前内部维护的是 `bufAndListenerPairs`，不是纯 `Queue<ByteBuf>`，证据：`transport/src/main/java/io/netty/channel/AbstractCoalescingBufferQueue.java:34`。  
7. `add/addFirst` 当前会 `buf.touch()` 并同时保存 buffer 与 listener/promise 对应关系，证据：`transport/src/main/java/io/netty/channel/AbstractCoalescingBufferQueue.java:56`、`:96`。  
8. `remove(alloc, bytes, aggregatePromise)` 当前按字节长度取出、必要时 `readRetainedSlice`、`compose`，并把 listener/promise 延后挂到 aggregatePromise，证据：`transport/src/main/java/io/netty/channel/AbstractCoalescingBufferQueue.java:143`。  
9. `writeAndRemoveAll(ctx)` 当前会把剩余 ByteBuf 及其 promise/listener 顺次写出，证据：`transport/src/main/java/io/netty/channel/AbstractCoalescingBufferQueue.java:255`。  
10. `CoalescingBufferQueue` 当前是一个基于 Channel 的具体落地实现，可选择是否 `updateWritability`，证据：`transport/src/main/java/io/netty/channel/CoalescingBufferQueue.java:35`。  
11. `ChannelFlushPromiseNotifier` 当前通过 `writeCounter + FlushCheckpoint` 机制按已写字节推进 promise 完成，证据：`transport/src/main/java/io/netty/channel/ChannelFlushPromiseNotifier.java:25`、`:63`、`:80`。  
12. `PendingWriteQueueTest.shouldFireChannelWritabilityChangedAfterRemoval` 当前验证 remove 与 channelWritabilityChanged 的顺序必须避免 double release，证据：`transport/src/test/java/io/netty/channel/PendingWriteQueueTest.java:93`。  
13. `testRemoveAndWriteAllReentrantWrite` / `testRemoveAndFailAllReentrantFailAll` 当前验证 re-entrant write/fail 需要一直处理到队列空为止，证据：`transport/src/test/java/io/netty/channel/PendingWriteQueueTest.java:202`、`:221`。  
14. `CoalescingBufferQueueTest.testAggregateWithPartialRead` 当前验证 partial remove、aggregatePromise 和原始 promise/listener 的完成边界，证据：`transport/src/test/java/io/netty/channel/CoalescingBufferQueueTest.java:146`。  
15. `CoalescingBufferQueueTest.testWritabilityChanged` 当前验证在启用 `updateWritability` 时队列也会参与可写性主线，证据：`transport/src/test/java/io/netty/channel/CoalescingBufferQueueTest.java:255`。

### 深审发现

1. **高风险：容易把 `PendingWriteQueue` 和 `ChannelOutboundBuffer` 混成同一层。** 正文已明确前者站在正式托管区之前。  
2. **中风险：容易把挂起写阶段排除在 writability 账本之外。** 正文已补 `PendingBytesTracker` 入账语义。  
3. **中风险：容易把 `CoalescingBufferQueue` 写成按消息条数消费。** 正文已改成按字节长度聚合/切片视角。  
4. **中风险：容易漏掉部分读取与 retained slice 的引用计数边界。** 正文已在 `remove(...)` 一节强调。  
5. **低风险：容易忽略 re-entrant write/fail 测试。** 正文已用它们解释“这些队列不是纯容器，而是边界调度器”。

## 第二轮：因果审

- 还没正式 write 的消息若被挂起 -> 仍需先入 pending bytes / promise / ownership 主线：✅  
- `PendingWriteQueue` 批量写出 / 批量失败 -> 说明挂起层也必须拥有完整退出规则：✅  
- `CoalescingBufferQueue` 面对的是字节视角，不是消息条数视角：✅  
- partial remove + aggregatePromise -> 说明字节消费和完成语义必须同时维护：✅  
- `ChannelFlushPromiseNotifier` 解决的是写出字节进度到 promise 完成的对齐：✅

## 第三轮：结构审

正文结构按“补出站主线空白 -> PendingWriteQueue -> PendingWrite 与 Entry 的层级差异 -> 字节聚合队列 -> ChannelFlushPromiseNotifier -> 测试回读 -> 收网”推进，没有沿类文件顺序平铺。✅

失败方案已覆盖：
- 挂起写但不计入 pending bytes  
- 挂起写失败时不 release msg  
- 小块 ByteBuf 各写各的、不做字节聚合  
- 只按消息条数组织聚合队列  
- 不让这些队列参与 promise/listener 回调  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `PendingWriteQueue` 负责挂起写的预托管层  
- `PendingWrite` 与 `Entry` 站位不同  
- `AbstractCoalescingBufferQueue` / `CoalescingBufferQueue` 解决的是按字节组织写视图  
- `ChannelFlushPromiseNotifier` 负责写出进度到 promise 的对齐  
- 这些结构都不是纯容器，而是出站语义的辅助托管层  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重复展开 `ChannelOutboundBuffer` 三阶段和 watermarks 主线。✅  
- 未把 `CoalescingBufferQueue` 写成通用对象队列。✅  
- 未把 `ChannelFlushPromiseNotifier` 写成一般 promise 聚合器。✅  
- 未把 `PendingWriteQueue` 写成“已经进入传输层”的队列。✅

## 第六轮：依赖审

- 依赖 Ch7-05/06/07 的出站托管、writability、Entry/WriteTask 主线，真实存在。✅  
- 依赖 Ch4-06 ownership 前置，真实存在。✅  
- 依赖 Ch8-06 的局部回收面思路，只复用结论未重复实现。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 11,918。  
- 去掉常见 markdown 标记后的字符数：约 11,517。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经补上出站主线里最明显的断点：正式托管区之外的挂起写层与字节聚合层。Ch7-08 可作为后续大对象分块写出、HTTP/2 字节聚合写出和更细粒度 promise 对齐专题的直接前置篇。