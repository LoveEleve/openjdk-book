# Ch12-05 WeightedFairQueueByteDistributor：HTTP/2 可发送额度的公平分配 — rewrite-plan

## 篇章定位

- 核心困惑：前一篇已经说明 remote flow controller 会决定“哪些 stream 现在有资格发送”，但多个 stream 同时都可发送时，Netty 又是怎么决定先给谁发、每次给多少、为什么 blocked parent 还能把额度让给子节点？`WeightedFairQueueByteDistributor`、priority tree、allocationQuantum、pseudoTime 到底在解决什么问题？
- 一句话顿悟：`WeightedFairQueueByteDistributor` 不负责决定窗口是否允许发送，而是建立在“某条 stream 已经 streamable”这个前提上，再按 HTTP/2 priority tree、权重和 pseudo time 把当前可发送额度分给多个 stream；它追求的不是绝对带宽公平，而是在连接级预算有限时，让活跃 stream 既遵守依赖关系，又避免一条流长期独占。
- 文章边界：本篇主讲 `WeightedFairQueueByteDistributor` 的状态树、stateOnlyMap、activeCountForTree、pseudoTimeQueue、allocationQuantum 与 `distribute/distributeToChildren` 主线，解释 blocked parent、empty frame、priority tree 变化、state-only stream 保留和 writer 异常边界；不重讲 flow controller 本身如何判定 streamable，不展开 UniformStreamByteDistributor 的实现对比细节。

## 依赖

### HARD

- Ch12-01 `ch12-http2/01-http2-codec.md`：理解 stream、优先级树、流控窗口这些协议地基。
- Ch12-03 `ch12-http2/03-connection-encoder-decoder.md`：理解 remote flow controller 先判断 stream 是否有资格发送，distributor 只是后续额度分配策略。
- Ch7-05 / Ch7-06：理解 write / flush / pending bytes 的 Netty 出站主线，避免把 distributor 误解成直接写 socket 的模块。

### SOFT

- Ch12-02：只复用 API 层 child channel/writability 局部视角，不承担硬依赖。

### NAV

- 后续：gRPC / Triple transport 调优中的 flow-control / priority 实际影响。
- 后续：UniformStreamByteDistributor 对照篇（如有需要）。

## 结构设计

### 1. 开场：窗口允许发送，不代表就知道该先发谁
- 回收前一篇：flow controller 负责“能不能发”。
- 引出新问题：当 A/B/C 都能发时，额度该如何在连接内分配。
- 预计 900-1200 字。

### 2. 失败方案：如果只按 streamId 顺序或轮询发，会卡在哪
- 失败方案 A：只按 streamId 轮询，忽视 priority tree。
- 失败方案 B：先到先发，先写满一个流再说，单流独占。
- 失败方案 C：只看权重，不看 blocked parent / empty frame / state-only stream。
- 预计 1500-1900 字。

### 3. 总图：state tree、stateOnlyMap、pseudoTimeQueue 与 allocationQuantum
- connection stream 是根节点。
- active stream 与仅保留优先级的 state-only stream 怎么共存。
- pseudoTimeQueue 和 totalQueuedWeights 如何服务分配。
- allocationQuantum 为什么是“最小分配块”而不是绝对带宽承诺。
- 预计 2200-2800 字。

### 4. `updateStreamableBytes`：为什么 distributor 不直接决定谁能发
- 它只接收 flow controller 传入的 streamableBytes / hasFrame / windowState。
- 强调“streamable”资格来自上游 flow controller，而不是 distributor 自己判断。
- 预计 1400-1800 字。

### 5. `distribute/distributeToChildren`：真正的额度分配主线
- active stream 直接写多少；blocked stream 如何把机会传播给子节点。
- `pseudoTimeToWrite`、`pseudoTime`、`totalQueuedWeights` 怎样形成“谁该先得到下一个额度”的近似顺序。
- empty frame / zero window / no progress 时为什么还要给一次机会。
- 预计 2400-3000 字。

### 6. priority tree 变化与 state-only stream
- `updateDependencyTree`、exclusive dependency、parent changed 事件。
- stream close/remove 后为什么还要保留一部分 priority state。
- `StateOnlyComparator` 的真实用途和边界。
- 预计 1800-2400 字。

### 7. 测试回读：blocked parent、minChunk、writer exception 到底证明了什么
- `minChunkShouldBeAllocatedPerStream`
- `blockedStreamNoDataShouldSpreadDataToChildren`
- `streamWithZeroFlowControlWindowAndDataShouldWriteOnlyOnce`
- `connectionErrorForWriterException`
- 预计 1800-2400 字。

### 8. 收网：它不是流控器，也不是带宽保证器
- 再次明确它和 remote flow controller 的边界。
- 回答为什么它是“可发送额度分配器”，不是“公平网络带宽控制器”。
- 预计 600-900 字。

## 证据清单

- `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:44-57`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:73-186`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:189-284`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:313-339`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:384-685`
- `codec-http2/src/test/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributorTest.java:61-124`
- `codec-http2/src/test/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributorTest.java:146-209`
- `codec-http2/src/test/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributorTest.java:236-314`
- `codec-http2/src/test/java/io/netty/handler/codec/http2/DefaultHttp2RemoteFlowControllerTest.java:157-220`

## 误解清单

1. 有了 remote flow controller，就已经自动决定了多个 stream 的公平发送顺序。
2. priority weight 直接等于固定带宽比例。
3. blocked parent 一旦不能写，子节点也应该全部卡住。
4. `allocationQuantum` 越大就一定越公平。
5. distributor 自己决定 stream 是否可写。
6. 只要 stream 被移除，优先级状态就立即完全不再重要。

## 边界清单

- 本篇不重新展开 remote flow controller 的 streamable 判定，只消费其结论。
- 本篇不把 pseudo time 算法写成精确带宽调度保证，只写当前实现的近似公平分配策略。
- 本篇不把测试里的 tree 形状外推成所有真实业务拓扑，只作为机制证据。
- 本篇不把 state-only stream 保留写成永久缓存，它仍受 maxStateOnlySize 限制与优先级比较约束。

## 深审预警

- [ ] 不把 distributor 写成完整流控器。
- [ ] 不把权重写成固定吞吐承诺。
- [ ] 不把 blocked parent 写成子树完全冻结。
- [ ] 不把 empty frame / zero window 的一次写机会写漏。
- [ ] 不把 stateOnlyMap 写成永久保留所有已移除 stream 的优先级状态。