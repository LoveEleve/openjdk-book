# Ch12-05 WeightedFairQueueByteDistributor：HTTP/2 可发送额度的公平分配 — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `WeightedFairQueueByteDistributor` 当前明确是 `StreamByteDistributor` 实现，对 stream priority 敏感，并以 Weighted Fair Queueing 方式分配字节，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:44`。  
2. 该分配器当前维护 `stateKey`、`stateOnlyMap`、`stateOnlyRemovalQueue`、`connectionState` 和 `allocationQuantum`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:73`。  
3. connection listener 当前会在 stream added/active/closed/removed 时维护状态树与 state-only state，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:115`。  
4. `updateStreamableBytes(...)` 当前只接收 flow controller 已计算好的 streamableBytes / hasFrame / windowState，并写入本地 `State`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:189`。  
5. `updateDependencyTree(...)` 当前会处理新 state 创建、exclusive dependency、父子重连以及 state-only 数量限制，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:196`。  
6. `distribute(...)` 当前以 `connectionState.activeCountForTree` 为入口，在有活跃节点时持续分配可发送额度，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:257`。  
7. `distributeToChildren(...)` 当前通过 `pseudoTimeQueue`、`pseudoTimeToWrite`、权重和 `allocationQuantum` 决定下一次应该给哪个 child 多少额度，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:313`。  
8. active stream 当前可直接写；若写出 0 字节但仍 active，会在本轮后被暂时置为 inactive，直到下一次 `updateStreamableBytes`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:286`。  
9. `StateOnlyComparator` 当前按“是否曾 activate/reserve、树深、streamId”决定 state-only 状态的保留优先级，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:384`。  
10. `WeightedFairQueueByteDistributorTest.minChunkShouldBeAllocatedPerStream` 当前验证每条活跃流至少得到一块 `allocationQuantum` 机会，证据：`codec-http2/src/test/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributorTest.java:182`。  
11. `blockedStreamNoDataShouldSpreadDataToChildren` 等测试当前证明 blocked parent 不会冻结整个子树，证据：`codec-http2/src/test/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributorTest.java:264`。  
12. `emptyFrameAtHeadIsWritten` 和 `streamWithZeroFlowControlWindowAndDataShouldWriteOnlyOnce` 当前证明 empty frame / zero-window stream 仍会得到一次推进机会，证据：`codec-http2/src/test/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributorTest.java:236`、`:301`。  
13. `connectionErrorForWriterException` 当前证明 writer 异常被提升成 connection 级 `INTERNAL_ERROR`，证据：`codec-http2/src/test/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributorTest.java:146`。  
14. `DefaultHttp2RemoteFlowControllerTest` 当前证明 distributor 是在 remote flow controller 调用 `writePendingBytes()` 时被真正消费使用，证据：`codec-http2/src/test/java/io/netty/handler/codec/http2/DefaultHttp2RemoteFlowControllerTest.java:157`。

### 深审发现

1. **高风险：容易把 distributor 写成完整流控器。** 正文已明确它建立在上游 flow controller 已判定 streamable 的前提上。  
2. **中风险：容易把 priority weight 写成固定带宽比例。** 正文已限定它是额度分配策略，不是吞吐承诺。  
3. **中风险：容易把 blocked parent 写成整棵子树冻结。** 正文已结合递归分配和测试说明让权语义。  
4. **低风险：容易把 stateOnlyMap 写成永久保留历史节点。** 正文已补 `maxStateOnlySize` 与 comparator 约束。

## 第二轮：因果审

- flow controller 先决定谁 streamable -> distributor 再决定这些 stream 如何分预算：✅  
- 只按 streamId/先到先发 -> 无法表达 priority tree、公平性和 blocked parent 让权：✅  
- allocationQuantum 负责最小分配块 -> 避免预算过碎时某些活跃流完全拿不到机会：✅  
- parent 写不动时递归把额度传播给子树 -> 避免子树被错误饿死：✅  
- state-only stream 暂存 priority state -> 避免 stream 对象消失后树结构立即塌缩：✅

## 第三轮：结构审

正文结构按“先与流控器分边界 -> 失败方案 -> 总图 -> updateStreamableBytes -> distribute 主线 -> blocked/empty frame -> priority tree/state-only -> 测试回读 -> 收网”推进，没有按类内方法顺序平铺。✅

失败方案已覆盖：
- 只按 streamId 轮询  
- 先到先发  
- 只看权重不看树和状态边界  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- distributor 不是流控器，而是额度分配器  
- 总图里的 state tree / pseudoTimeQueue / allocationQuantum 各自负责什么  
- blocked parent、empty frame、zero-window stream 为什么仍然可能得到一次机会  
- state-only stream 为什么会被有限暂存  
- 这套策略最终如何影响一条连接里多条流争用写出预算  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把 distributor 写成完整流控器。✅  
- 未把权重写成固定带宽承诺。✅  
- 未把测试树形结构外推成所有业务拓扑。✅  
- 未把 state-only stream 写成永久缓存。✅

## 第六轮：依赖审

- 依赖 Ch12-01 的优先级树与流控地基，真实存在。✅  
- 依赖 Ch12-03 的 remote flow controller 与连接主链前置，真实存在。✅  
- 依赖 Ch7-05/06 的 write/flush 前置，真实存在。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 10,410。  
- 去掉常见 markdown 标记后的字符数：约 10,198。  
- 目标定位：重大专题篇，满足篇幅要求。✅

## 结论

当前正文已经建立 WeightedFairQueueByteDistributor 的核心边界：它不是流控器，而是可发送额度分配器。Ch12-05 可作为后续 gRPC / Triple 传输调优和 priority tree 专题的直接前置篇。