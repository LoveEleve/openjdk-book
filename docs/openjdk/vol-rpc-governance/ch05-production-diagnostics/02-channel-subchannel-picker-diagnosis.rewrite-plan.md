# grpc-java：Channel、Subchannel、Picker 与 Transport 状态诊断 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch05-production-diagnostics`
- 篇：`02 Channel、Subchannel、Picker 与 Transport 状态诊断`
- 对应主题：`G-PROD-2 Channel / Subchannel / Picker / Transport 状态诊断`
- 文章类型：生产诊断专题篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：线上最让人困惑的一类问题，不是明确报错，而是“调用卡住了”。客户端没有立即失败，但请求也没有真正离开进程；channel 看起来是 `READY` 或 `CONNECTING`，但某个调用就是一直 pending；有时 picker 返回了 subchannel，调用仍然发不出去；有时 LB 明明收到了地址，channel 却还在 `TRANSIENT_FAILURE`。这些现象背后，真正起作用的是 channel、subchannel、picker、transport 四层状态如何传导。
- 一句话顿悟：grpc-java 的“调用卡住/失败/恢复”不是单层状态决定的，而是四层共同作用：`ManagedChannelImpl` 维护 channel 级状态与两层缓冲（`pendingCalls` / `DelayedClientTransport.pendingStreams`），`InternalSubchannel` 维护真实连接状态与 backoff，`SubchannelPicker` 决定这次 RPC 是立即拿 transport、立即失败还是继续等待，`DelayedClientTransport` 负责把“还不能走”的流缓存起来并在新 picker 到来时重放；线上诊断时必须先区分“还没到 picker”“picker 没结果”“picker 有 subchannel 但无 active transport”“transport 已 shutdown/terminated”。
- 文章边界：本篇重点解释调用在本地进程内“卡住”或“失败”时，channel/subchannel/picker/transport 四层状态如何协作，以及 `withSubchannel` / `withError` / `withNoResult` 的实际症状；不展开 xDS、grpclb、round_robin 全量策略实现，不深入 Netty transport 细节。

## 前置依赖

### HARD

- `ch01/04-nameresolver-loadbalancer-netty-transport.md`：已经知道 resolver/LB/transport 的主干位置。
- `ch05/01-deadline-cancel-retry-troubleshooting.md`：已经知道 deadline/cancel/retry 的生产排障视角。
- `ch03/01-service-config-retry-hedging.md`：已经知道 `RetriableStream` 与 delayed transport 的关系。

### SOFT

- 不要求先懂 pick-first 全部细节。
- 不要求先懂 NameResolver 全量状态机。

### NAV

- 后续可接：`ch05/03-keepalive-flowcontrol-connection`
- 后续可接：xDS/LB 进阶篇

## 一句话困惑

为什么一个 gRPC 调用明明没有立刻报错，却也没有真正发出去？为什么 picker 已经给了 subchannel，调用仍然卡住？为什么 channel 显示 `READY`，但某个请求还是 pending？

## 一句话顿悟

诊断这类问题时，不能只看 channel 状态。grpc-java 有四层需要区分：调用可能还卡在 `RealChannel.pendingCalls`（还没到 picker），可能卡在 `DelayedClientTransport.pendingStreams`（已经到 picker，但没拿到 transport），也可能 picker 返回了 subchannel 却拿不到 active transport，于是再次缓冲；最终能不能发出去，不是 channel 一个状态说了算，而是 channel / subchannel / picker / transport 四层同时决定。

## 读者理解路径

1. 先否定“调用卡住就是 channel 断了”这种单层直觉。
2. 建立最小总图：调用创建 → `pendingCalls` → `DelayedClientTransport.pendingStreams` → picker → subchannel → transport。
3. 解释四层状态模型：channel / subchannel / picker / transport 各自负责什么。
4. 解释 `DelayedClientTransport` 如何缓存并重放 pending streams。
5. 解释 `PickResult.withSubchannel` / `withError` / `withNoResult` 在生产上的不同症状。
6. 解释 `InternalSubchannel` 的 READY / CONNECTING / IDLE / TRANSIENT_FAILURE 转换与 backoff。
7. 解释为什么 `withSubchannel()` 不等于“调用已经离开进程”。
8. 解释 `shutdown()`、idle 模式、stale picker、no addresses 等典型症状。
9. 收束到“卡住排障四问法”：卡在哪个缓冲层？picker 给了什么？subchannel 当前什么状态？transport 是否真的 active？

## 失败方案推演

### 失败方案一：调用卡住就是 channel 断了

- 这是最常见的误判。
- 实际上调用可能根本还没走到 transport 层，甚至还没走到 picker。
- `ManagedChannelImpl.RealChannel` 自己就有 `pendingCalls`，`DelayedClientTransport` 还有 `pendingStreams`，这两层都可能让调用“卡在本地”。
- 所以“卡住”不等于“断了”，先问调用现在卡在哪一层。

### 失败方案二：picker 返回了 subchannel，就说明请求一定已经发出

- `PickResult.withSubchannel()` 的语义只是“用这个 subchannel 试试看”，不是“已经拿到可写 transport”。
- 如果 subchannel 当前没有 active transport，`GrpcUtil.getTransportFromPickResult()` 仍然会返回 null，调用继续缓冲。
- 所以 `withSubchannel()` 不是“成功发出”的证明，只是“方向已经选好”的证明。

### 失败方案三：`withError()` 一定会让调用立刻失败

- 对 fail-fast 调用，`withError()` 会快速失败。
- 但对 wait-for-ready 调用，`withError()` 不一定失败，而可能继续缓冲等待。
- 所以同一个 picker 结果，对不同调用选项可能产生完全不同的线上症状。

## 必须澄清的误解

1. channel 级 `READY` 不等于所有 subchannel / transport 都 READY。
2. `withSubchannel()` 不等于请求已经离开进程。
3. `withNoResult()` 不是错误，而是“还没法决定”，症状通常是 pending。
4. `transportTerminated()` 不是主要状态转折点，真正的状态变化通常发生在更早的 `transportShutdown()`。
5. Name-resolution 卡住和 delayed transport 卡住是两层不同的缓冲队列。

## 文章结构与字数预算

1. 困惑开场：为什么“没报错但发不出去”最难排障（800-1000 字）
2. 最小总图：调用在进程内的四层状态流（1000-1400 字）
3. 四层状态模型：channel / subchannel / picker / transport（1400-2000 字）
4. `DelayedClientTransport`：调用如何被缓存与重放（1600-2200 字）
5. picker 三种结果的生产症状（1400-2000 字）
6. `InternalSubchannel` 的状态转换与 backoff（1600-2200 字）
7. 常见卡住症状：no addresses / resolving / stale picker / noResult / transport terminated（1600-2200 字）
8. 收网总结：卡住排障四问法（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### channel / pre-pick buffering
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:148` — `INITIAL_PENDING_SELECTOR`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:866` — `RealChannel.newCall()` 在 `configSelector == INITIAL_PENDING_SELECTOR` 时进入 `pendingCalls`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:899` — `PendingCall` 构造与入队
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:921` — `PendingCall.reprocess()`

### delayed transport buffering
- `core/src/main/java/io/grpc/internal/DelayedClientTransport.java:70` — `pendingStreams`
- `core/src/main/java/io/grpc/internal/DelayedClientTransport.java:125` — `newStream()` consult picker
- `core/src/main/java/io/grpc/internal/DelayedClientTransport.java:141` — `PickResult` 转 transport
- `core/src/main/java/io/grpc/internal/DelayedClientTransport.java:157` — 拿不到 transport 时缓冲 `PendingStream`
- `core/src/main/java/io/grpc/internal/DelayedClientTransport.java:286` — `reprocess(newPicker)`
- `core/src/main/java/io/grpc/internal/DelayedClientTransport.java:372` — `PendingStream.createRealStream()`

### picker semantics
- `api/src/main/java/io/grpc/LoadBalancer.java:521` — `PickResult.withSubchannel()`
- `api/src/main/java/io/grpc/LoadBalancer.java:580` — docs: `withSubchannel()` 不保证立即发出
- `api/src/main/java/io/grpc/LoadBalancer.java:695` — `withError()`
- `api/src/main/java/io/grpc/LoadBalancer.java:720` — `withNoResult()`
- `core/src/main/java/io/grpc/internal/GrpcUtil.java:711` — `getTransportFromPickResult()`
- `core/src/main/java/io/grpc/internal/GrpcUtil.java:753` — `withError()` 在 fail-fast vs wait-for-ready 的差异
- `core/src/main/java/io/grpc/internal/GrpcUtil.java:763` — `withNoResult()` → null transport

### subchannel / transport state
- `core/src/main/java/io/grpc/internal/InternalSubchannel.java:155` — `state`
- `core/src/main/java/io/grpc/internal/InternalSubchannel.java:161` — `activeTransport`
- `core/src/main/java/io/grpc/internal/InternalSubchannel.java:163` — `pendingTransport`
- `core/src/main/java/io/grpc/internal/InternalSubchannel.java:222` — `obtainActiveTransport()` idle→connecting
- `core/src/main/java/io/grpc/internal/InternalSubchannel.java:247` — `startNewTransport()`
- `core/src/main/java/io/grpc/internal/InternalSubchannel.java:296` — `scheduleBackoff(status)`
- `core/src/main/java/io/grpc/internal/InternalSubchannel.java:357` — `gotoState()`
- `core/src/main/java/io/grpc/internal/InternalSubchannel.java:593` — `transportReady()`
- `core/src/main/java/io/grpc/internal/InternalSubchannel.java:637` — `transportShutdown()`
- `core/src/main/java/io/grpc/internal/InternalSubchannel.java:674` — `transportTerminated()`

### LB → picker → channel state
- `core/src/main/java/io/grpc/internal/PickFirstLoadBalancer.java:130` — CONNECTING → picker `withNoResult`
- `core/src/main/java/io/grpc/internal/PickFirstLoadBalancer.java:141` — READY → picker `withSubchannel`
- `core/src/main/java/io/grpc/internal/PickFirstLoadBalancer.java:144` — TRANSIENT_FAILURE → picker `withError`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1359` — `LbHelperImpl.updateBalancingState()`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1368` — `delayedTransport.reprocess(newPicker)`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1374` — `channelStateManager.gotoState(newState)`

## 测试证据清单

- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:844` — buffered before leaving process due to no picker result
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:873` — pending call reprocess after config selector available
- `core/src/test/java/io/grpc/internal/DelayedClientTransportTest.java:148` — buffered stream later reprocessed to real transport
- `core/src/test/java/io/grpc/internal/DelayedClientTransportTest.java:405` — `withError()` fail-fast vs wait-for-ready
- `core/src/test/java/io/grpc/internal/DelayedClientTransportTest.java:748` — wait-for-ready timeout includes last picker error hint
- `core/src/test/java/io/grpc/internal/InternalSubchannelTest.java:235` — all addresses failed → backoff / TRANSIENT_FAILURE
- `core/src/test/java/io/grpc/internal/InternalSubchannelTest.java:306` — READY transport shutdown returns subchannel to IDLE
- `core/src/test/java/io/grpc/internal/PickFirstLoadBalancerTest.java:491` — no addresses → `UNAVAILABLE` / TRANSIENT_FAILURE

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇重点放在 core 默认实现（ManagedChannelImpl / DelayedClientTransport / InternalSubchannel / pick-first 风格 picker），不展开 xDS / grpclb / round_robin 全景。
- 某些 READY / IDLE / TF 的具体节奏和 picker 策略会受具体 LB 实现影响，本文不把 pick-first 行为外推成所有 LB 的统一语义。

## 与其他篇的边界

### 本篇要讲清

- channel / subchannel / picker / transport 四层状态的分工。
- `pendingCalls` 与 `pendingStreams` 两层缓冲的差异。
- `withSubchannel` / `withError` / `withNoResult` 的真实生产症状。
- `InternalSubchannel` 的关键状态转换与 backoff。
- 常见“调用卡住”症状的定位思路。

### 本篇不深讲

- xDS / grpclb / round_robin 的全部策略实现。
- Netty transport 的 ByteBuf / HTTP/2 读写细节。
- keepalive / flow-control / connection 耗尽（留给 ch05/03）。

## 写作后检查

- [ ] 开篇先抓“没报错但发不出去”这个生产痛点，而不是直接讲 ConnectivityState。
- [ ] 至少展开 3 个失败方案，且包含“withSubchannel=已发出”“withError=一定失败”。
- [ ] 明确给出“pendingCalls → pendingStreams → picker → subchannel → transport”的总图。
- [ ] 不把本篇写成状态枚举清单。
- [ ] 每个状态诊断结论都要落到具体 file:line。
- [ ] 删除代码块后，读者仍能复述卡住排障四问法。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。