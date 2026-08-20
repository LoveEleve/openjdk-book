# grpc-java：Channel、Subchannel、Picker 与 Transport 状态诊断 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `ManagedChannelImpl.RealChannel` 在初始 `configSelector == INITIAL_PENDING_SELECTOR` 时会把调用缓存在 `pendingCalls`，这层缓冲发生在 picker 之前，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:148`、`:866`、`:899`、`:921`。
2. `DelayedClientTransport` 内部维护 `pendingStreams`，当 picker 不能产出真实 transport 时，流会被缓存在这里，证据：`core/src/main/java/io/grpc/internal/DelayedClientTransport.java:70`、`:125`、`:141`、`:157`。
3. `DelayedClientTransport.reprocess(newPicker)` 会在新 picker 到来时重放所有 pending streams，`PendingStream.createRealStream()` 才真正创建 transport stream，证据：`DelayedClientTransport.java:286`、`:372`。
4. `PickResult.withSubchannel()` 不保证调用立即拿到 transport；API 文档明确说明如果 subchannel 无 active transport，RPC 仍可缓冲，证据：`api/src/main/java/io/grpc/LoadBalancer.java:521`、`:580`。
5. `PickResult.withError()` 对 fail-fast 与 wait-for-ready 的效果不同，真正分叉发生在 `GrpcUtil.getTransportFromPickResult()`，证据：`core/src/main/java/io/grpc/internal/GrpcUtil.java:753`。
6. `PickResult.withNoResult()` 返回 null transport，症状通常是调用继续 pending，证据：`LoadBalancer.java:720`、`GrpcUtil.java:763`。
7. `InternalSubchannel` 的关键状态与连接事实由 `state`、`activeTransport`、`pendingTransport` 三个变量共同决定，证据：`core/src/main/java/io/grpc/internal/InternalSubchannel.java:155`、`:161`、`:163`。
8. `obtainActiveTransport()` 会把 IDLE subchannel 推进到 CONNECTING，并触发 `startNewTransport()`，证据：`InternalSubchannel.java:222`、`:247`。
9. `transportReady()` 把 `pendingTransport` 提升为 `activeTransport`，subchannel 才真正 READY，证据：`InternalSubchannel.java:593`。
10. 候选地址全部失败时，`scheduleBackoff(status)` 使 subchannel 进入 TRANSIENT_FAILURE 并安排重连，证据：`InternalSubchannel.java:296`。
11. `ManagedChannelImpl.LbHelperImpl.updateBalancingState()` 一边安装新 picker（`delayedTransport.reprocess(newPicker)`），一边更新 channel 总状态（`channelStateManager.gotoState(newState)`），说明 channel 状态与 picker 安装是相关但分离的两个动作，证据：`ManagedChannelImpl.java:1359`、`:1368`、`:1374`。
12. pick-first 中 CONNECTING → `withNoResult`，READY → `withSubchannel`，TRANSIENT_FAILURE → `withError`，证据：`core/src/main/java/io/grpc/internal/PickFirstLoadBalancer.java:130`、`:141`、`:144`。

### 测试证据已核对

1. `ManagedChannelImplTest.java:844` — buffered before leaving process due to no picker result。
2. `ManagedChannelImplTest.java:873` — `PendingCall` reprocess after config selector available。
3. `DelayedClientTransportTest.java:148` — pending stream later reprocessed to real transport。
4. `DelayedClientTransportTest.java:405` — `withError()` fail-fast vs wait-for-ready 差异。
5. `DelayedClientTransportTest.java:748` — wait-for-ready timeout 包含 last picker error 线索。
6. `InternalSubchannelTest.java:235` — all addresses failed → backoff / TRANSIENT_FAILURE。
7. `InternalSubchannelTest.java:306` — READY transport shutdown 返回 IDLE。
8. `PickFirstLoadBalancerTest.java:491` — no addresses → `UNAVAILABLE` / TRANSIENT_FAILURE。

### 深审发现

1. **高风险：容易把 channel 状态当成全部真相。** 当前正文已强调 channel 只是对外总状态，不能替代 subchannel/transport 真相。  
2. **高风险：容易把 `withSubchannel()` 误解成“请求已经离开进程”。** 当前正文已压回 `GrpcUtil.getTransportFromPickResult()` 这一层的真实 transport 获取。  
3. **中风险：容易把 `withError()` 统一理解成立即失败。** 当前正文已补 fail-fast 与 wait-for-ready 的分叉行为。  
4. **中风险：容易混淆 `pendingCalls` 和 `pendingStreams`。** 当前正文已把两层缓冲明确拆开，分别对应 picker 前与 picker 后。  
5. **低风险：容易把 `transportTerminated()` 当成主要状态跳变。** 当前正文已强调真正有诊断价值的转折点通常发生在更早的 `transportShutdown()`。  

## 第二轮：因果审

- 调用卡住不能只看 channel 状态，因为调用可能还卡在 `pendingCalls` 或 `pendingStreams`，根本没到 transport：✅  
- `withSubchannel()` 不能等于“立即发出”，因为 subchannel 仍可能没有 active transport：✅  
- `withError()` 不能简单等于“立刻失败”，因为 wait-for-ready 会把它转成继续等待：✅  
- IDLE 不是失败状态，而是“当前无活跃连接、等待需求”或 READY transport 正常关闭后的懒重连状态：✅  
- stale picker 会让健康系统看起来像卡住，因为 RPC 使用的是旧 picker 快照而非当前最优 subchannel：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → 最小总图 → 四层状态模型 → 两层缓冲 → picker 三种结果 → subchannel 状态转换 → 常见卡住症状 → 卡住排障四问法总结”推进，没有退化成状态枚举清单。

失败方案已覆盖：
- 调用卡住就是 channel 断了  
- picker 返回了 subchannel 就说明请求一定已经发出  
- `withError()` 一定会让调用立刻失败  

每一层拆解均包含：线上症状 → 状态层级 → 源码证据 → 诊断结论，符合生产诊断卷定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- `pendingCalls` 与 `pendingStreams` 两层缓冲的差异  
- `withSubchannel` / `withError` / `withNoResult` 的真实生产症状  
- `InternalSubchannel` 的 READY / CONNECTING / IDLE / TF 关键转换  
- 为什么 channel `READY` 仍不等于某次调用一定发出去  
- 卡住排障四问法  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未扩入 xDS / grpclb / round_robin 的全量策略实现。✅  
- 未扩入 Netty transport 的 ByteBuf / HTTP/2 细节。✅  
- 未扩入 keepalive / flow-control / connection 耗尽（留给 ch05/03）。✅  
- 重点仍压在 channel / subchannel / picker / transport 四层状态诊断与缓冲队列，边界收得住。✅

## 第六轮：依赖审

- 已直接承接 ch01/04：主干桥接链已知，本篇改成生产排障地图。✅  
- 已承接 ch05/01：deadline/cancel/retry 的状态收敛已知，本篇补充“调用为何还没真正出去”的另一类卡住问题。✅  
- `ManagedChannelImplTest`、`DelayedClientTransportTest`、`InternalSubchannelTest`、pick-first tests 的组合足以支撑“四层状态 + 两层缓冲 + picker 结果”的论断。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：使用少量文字图，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验 `ManagedChannelImpl`、`DelayedClientTransport`、`InternalSubchannel`、`LoadBalancer`、`GrpcUtil`、`PickFirstLoadBalancer`。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数（不含代码块与空白行）：约 `17,062`。  
- 目标定位：生产诊断卷第二篇，篇幅与结构均满足要求。✅

## 结论

当前三件套的目标明确：这一篇应把“调用没报错但发不出去”从模糊的症状提升到“pendingCalls / pendingStreams / picker / subchannel / transport 五道门”的排障模型，讲清 `withSubchannel`、`withError`、`withNoResult` 的真实语义，以及为什么 channel `READY` 也不等于请求已经离开进程。