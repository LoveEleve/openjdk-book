# grpc-java：Channel、Subchannel、Picker 与 Transport 状态诊断

> 基于 grpc-java v1.83.1

## 一、困惑开场：为什么“没报错但发不出去”最难排障

线上最难排查的一类 gRPC 问题，往往不是明确失败，而是“卡住”。

客户端没有立刻收到 `UNAVAILABLE`，也没有立刻收到 `DEADLINE_EXCEEDED`。调用看起来已经开始了，但迟迟没有真正发出去。你查日志，发现 channel 好像还在 `CONNECTING`；再看别的请求，甚至有人说 channel 已经 `READY` 了。你去抓 `SubchannelPicker`，发现它明明给了一个 subchannel。按直觉看，这个调用应该已经离开进程了，但事实上它还待在本地。

这类问题之所以难，不是因为 grpc-java 的状态太多，而是因为你在看错层级。一个调用从应用代码到真正拿到 socket，并不是“channel 一个状态说了算”。在 grpc-java 里，至少有四层状态共同决定这次 RPC 能不能出去：channel、subchannel、picker、transport。再往前一步，还有两层缓冲队列：`RealChannel.pendingCalls` 和 `DelayedClientTransport.pendingStreams`。

所以这篇文章要解决的，不是“ConnectivityState 枚举值是什么意思”这么浅的问题，而是一个更实战的问题：**当一个调用卡在本地进程里时，它到底卡在哪一层。**

## 二、前情回顾：主干篇讲过桥接，上一篇讲过判因，这一篇只问它为什么卡住

在 ch01/04 中，我们已经知道一次调用会经过 resolver、load balancer、picker 和 transport 这条主干桥接链。逻辑 target 先被解析成地址，地址再被 LB 组织成 subchannel，picker 决定某次 RPC 应该走哪个 subchannel，最终 transport 才真正把它送上 HTTP/2 连接。

在上一篇 ch05/01 中，我们又已经建立了“来源层 → 重试层 → 收敛层”的生产判因视角：看到一个最终 `Status`，不能直接把它当成原始来源，而要倒查 deadline、cancel、retry、hedging 和最终收敛。

这一篇跟上一篇正好互补。上一篇回答的是：**为什么失败会被改写。** 这一篇回答的是：**为什么调用甚至还没真正出去。**

也就是说，这一篇不是在重复讲 resolver/LB，而是在把主干篇里的桥接链路重新翻过来，当成一张“卡在哪一层”的排障地图来读。

## 三、先走三条失败的路

### 失败方案一：调用卡住就是 channel 断了

这是最常见的误判。看到请求 pending 很久，第一反应就是“channel 断了”或者“连接没建起来”。

但 grpc-java 里“卡住”可能发生在 transport 之前的两个位置。

第一个位置是 `ManagedChannelImpl.RealChannel.pendingCalls`。这时候调用甚至还没走到 picker，原因通常是初始 config selector 还没准备好，名字解析和 service config 还没落地。第二个位置是 `DelayedClientTransport.pendingStreams`。这时候调用已经到了 picker，但 picker 没给出一个真正可用的 transport，于是流被缓冲。

所以“卡住”不等于“断了”，更不等于“socket 没建起来”。你要先问：**这次调用卡在 picker 之前，还是 picker 之后？**

### 失败方案二：picker 返回了 subchannel，就说明请求一定已经发出

另一个特别容易出错的直觉是：只要 `SubchannelPicker` 返回的是 `PickResult.withSubchannel()`，请求就算已经选路成功了。

实际不是这样。`withSubchannel()` 只表示“这次应该尝试这个 subchannel”，不表示“这个 subchannel 当前一定有 active transport”。如果 subchannel 对象存在，但 `obtainActiveTransport()` 返回 null，`GrpcUtil.getTransportFromPickResult()` 最终还是拿不到真正的 transport，调用仍然会缓冲在 delayed transport 里。

所以 `withSubchannel()` 不是“调用已经离开进程”的证明，只是“方向已经选好了”的证明。

### 失败方案三：`withError()` 一定会让调用立刻失败

这也是一个典型误判。很多人看到 picker 返回 `withError()`，就认为调用一定会马上报错。

对于 fail-fast 调用，这个判断基本对；但对 wait-for-ready 调用，它未必会立刻失败。`GrpcUtil.getTransportFromPickResult()` 会根据 `CallOptions.isWaitForReady()` 决定：是立即造一个 failing transport，还是继续返回 null 让调用缓冲。

所以“同一个 picker 返回值，为何有时立即失败、有时只是一直 pending”——答案往往不在 picker 本身，而在这次调用是不是 wait-for-ready。

## 四、最小总图：一次调用在进程内要过五道门

这篇文章真正要建立的，不是一个状态机，而是一张“本地进程内的过门图”。

```
应用代码
   ↓
RealChannel.newCall()
   ↓
[门 1] pendingCalls（还没到 picker，通常是初始解析/config 未完成）
   ↓
DelayedClientTransport.newStream()
   ↓
[门 2] pendingStreams（已经到 picker，但还没拿到 transport）
   ↓
SubchannelPicker.pickSubchannel()
   ↓
[门 3] picker 结果（withSubchannel / withError / withNoResult）
   ↓
InternalSubchannel
   ↓
[门 4] subchannel 当前状态（READY / CONNECTING / IDLE / TF）
   ↓
ClientTransport
   ↓
[门 5] transport 是否 active
   ↓
真正离开进程
```

如果一条调用“没报错但发不出去”，它大概率是卡在这五道门中的某一处。后面所有细节，都是在回答：**到底是哪一道门没过。**

## 五、四层状态模型：channel、subchannel、picker、transport 各管什么

这里先做一个路标。下面这四层不是固定的函数流水线，也不是“上层决定下层”的单向链条，而是四个并行观察面：channel 讲的是对外总状态，subchannel 讲的是真实连接管理，picker 讲的是“这次 RPC 现在怎么办”，transport 讲的是“有没有真正可写的连接”。排障时你不是顺着它们执行，而是在这四个观察面之间来回切换，寻找哪一层给出了误导性的信号。

### 5.1 channel：面向外部的总状态，不是 socket 真相

channel 层的状态是 `ManagedChannelImpl` 对外提供的整体判断，由 `channelStateManager` 维护。这个状态会在 idle 退出、idle 进入、LB 调用 `updateBalancingState()`、panic、shutdown 等多个时点改变。

`ManagedChannelImpl.java:206` — channel state manager 字段
`ManagedChannelImpl.java:1374` — `updateBalancingState()` 最终更新 channel 状态

这里最重要的一点是：**channel 状态不是 transport 真相。** channel `READY` 只意味着当前对外发布的 picker 能代表“有可用路径”；不意味着所有 subchannel 都 READY，更不意味着每个请求都已经拿到 active transport。

### 5.2 subchannel：连接管理者，负责地址游标、backoff 和 active transport

subchannel 层的核心是 `InternalSubchannel`。它手里同时握着：

- 当前的 `ConnectivityStateInfo state`
- `activeTransport`
- `pendingTransport`
- reconnect/backoff 调度
- 地址游标

`InternalSubchannel.java:155` — `state`
`InternalSubchannel.java:161` — `activeTransport`
`InternalSubchannel.java:163` — `pendingTransport`

在生产诊断里，subchannel 是最关键的一层，因为它才真正知道“有没有 ready 的连接”“是不是正在 backoff”“是不是换地址重连”。

### 5.3 picker：这次 RPC 的裁决者，不是 transport 本身

picker 只是一次 RPC 的瞬时决策器。它不维护连接，只回答：“这次 RPC 现在该怎么处理？”

可能的回答有三种：

- `withSubchannel()`：尝试这个 subchannel
- `withError()`：返回错误
- `withNoResult()`：现在先别决定，再等等

`LoadBalancer.java:521` — `PickResult.withSubchannel()`
`LoadBalancer.java:695` — `PickResult.withError()`
`LoadBalancer.java:720` — `PickResult.withNoResult()`

所以 picker 不是状态本身，而是状态在“这次 RPC”上的投影。

### 5.4 transport：真正把字节送上去的那一层

只有当 subchannel 真正拿到了 `activeTransport`，调用才算离开了本地进程。`GrpcUtil.getTransportFromPickResult()` 会在最终一步把 picker 结果翻译成 `ClientTransport`。拿不到 transport，就还是留在本地。

`GrpcUtil.java:711` — `getTransportFromPickResult()`

这一层是最后的事实层：前面所有 READY / CONNECTING / withSubchannel / withNoResult，最终都要落实到“有没有 active transport”。

## 六、`DelayedClientTransport`：调用为什么会在本地排队

### 6.1 picker 之前的排队：`pendingCalls`

最早的一层排队不在 delayed transport，而在 `ManagedChannelImpl.RealChannel` 里。

如果 `configSelector == INITIAL_PENDING_SELECTOR`，说明初始解析和 service config 还没完成。此时 `RealChannel.newCall()` 不会立刻创建真正的 `ClientCall`，而是把它包成 `PendingCall` 放进 `pendingCalls`。

`ManagedChannelImpl.java:148` — `INITIAL_PENDING_SELECTOR`
`ManagedChannelImpl.java:866` — `configSelector == INITIAL_PENDING_SELECTOR` 时进入 `pendingCalls`
`ManagedChannelImpl.java:899` — `PendingCall` 入队

这一层的症状是：调用甚至还没走到 picker，就已经在本地等了。

### 6.2 picker 之后的排队：`pendingStreams`

当调用继续往下走，到 `DelayedClientTransport.newStream()` 时，才进入第二层缓冲。

`DelayedClientTransport.java:70` — `pendingStreams`
`DelayedClientTransport.java:125` — `newStream()` consult picker

这时 delayed transport 会拿当前的 picker 去做一次 `pickSubchannel()`，然后把 `PickResult` 交给 `GrpcUtil.getTransportFromPickResult()`。如果最终拿不到真正的 transport，就把这次流包成 `PendingStream` 放进 `pendingStreams`。

`DelayedClientTransport.java:141` — `PickResult` 转 transport
`DelayedClientTransport.java:157` — 拿不到 transport 时缓冲 `PendingStream`

这里需要特别强调：`pendingCalls` 和 `pendingStreams` 不能合并成一层。

- `pendingCalls` 卡的是“调用对象还没完成初始配置/选择器准备”，此时甚至还没到 picker。  
- `pendingStreams` 卡的是“流对象已经到了 picker，但 picker 还没产出可用 transport”。

如果把两层合并，你在线上就无法区分：这次卡住是 resolver/service config 还没准备好，还是 picker/transport 这条链出了问题。grpc-java 把它们拆成两层，正是为了把“还没开始选路”和“选路了但还没法发”这两类症状明确分开。

### 6.3 什么时候会重放这些 pending streams

一旦有新的 picker 到来，`ManagedChannelImpl.updateSubchannelPicker()` 会调用 `delayedTransport.reprocess(newPicker)`，把所有 pending streams 再过一遍新的 picker。

`ManagedChannelImpl.java:1368` — `delayedTransport.reprocess(newPicker)`
`DelayedClientTransport.java:286` — `reprocess(newPicker)`
`DelayedClientTransport.java:372` — `PendingStream.createRealStream()`

所以 delayed transport 的核心不是“缓存”，而是“缓存 + 重放”。生产上如果你看到调用长时间 pending，关键不只是问“为什么缓存了”，更要问“为什么后来一直没有一次成功的 reprocess”。

## 七、picker 三种结果的真实生产症状

### 7.1 `withSubchannel()`：方向选好了，但不等于已经出去了

最容易误解的就是 `withSubchannel()`。API 文档自己就专门提醒：它不保证这次 pick 一定能立即拿到 transport。

`LoadBalancer.java:580` — 文档明确说明 `withSubchannel()` 不保证立即可发

如果 picker 选中的 subchannel 现在没有 active transport，`GrpcUtil.getTransportFromPickResult()` 最终还是会拿到 null，调用继续缓冲。

这类线上症状通常是：你看日志发现 picker “已经成功选中了 subchannel”，但调用还是 pending，直到 subchannel 真正 READY 或下一个 picker 到来。

### 7.2 `withError()`：fail-fast 失败，wait-for-ready 可能继续等

`withError()` 本身不决定“立刻失败”还是“继续等待”，真正做这个判断的是 `GrpcUtil.getTransportFromPickResult()`。

`GrpcUtil.java:753` — `withError()` 在 fail-fast / wait-for-ready 上分叉

对 fail-fast 调用，它会返回一个 failing transport，用户很快看到错误；对 wait-for-ready 调用，它会返回 null，于是调用继续缓冲。这就是为什么同样一个 picker error，有的请求会立刻爆，有的请求只是卡到超时。

### 7.3 `withNoResult()`：不是错误，而是“先别决定”

`withNoResult()` 没有任何错误语义，它只是说：“我现在还没有结果。”

`GrpcUtil.java:763` — `withNoResult()` → null transport

这类症状最像“调用卡死了”：没有 immediate failure，也没有真正发出去，只是 pending。它通常对应 CONNECTING 中的 pick-first，或者 idle 模式下的 request-connection picker。

这里补一句最容易救命的误判提醒：**看到 `withNoResult()`，不要第一时间判定系统坏了。** 很多时候它只是“连接还在建立”或“刚从 IDLE 被唤醒，picker 还没拿到可用 transport”的正常等待语义。真正要紧的是：它是不是长期停留在 `withNoResult()`，以及后续为什么一直没有一次成功的 reprocess。

## 八、`InternalSubchannel`：READY / CONNECTING / IDLE / TF 是怎么来的

### 8.1 IDLE → CONNECTING：有人开始用它了

当调用真的尝试从 subchannel 拿 transport 时，`obtainActiveTransport()` 会把 IDLE subchannel 推进到 CONNECTING，并启动新的 transport 连接。

`InternalSubchannel.java:222` — `obtainActiveTransport()` idle→connecting
`InternalSubchannel.java:247` — `startNewTransport()`

这就是为什么 IDLE 不是错误状态。它只是“暂时没动”，一旦有需求就会尝试连接。

### 8.2 CONNECTING → READY：pendingTransport 真正 ready 了

当 `pendingTransport.transportReady()` 回调到来时，subchannel 才真正进入 READY，`pendingTransport` 晋升为 `activeTransport`。

`InternalSubchannel.java:593` — `transportReady()`

这时候 picker 才有机会真正给出一个能立即发出去的 `withSubchannel()`。

### 8.3 CONNECTING / READY → TRANSIENT_FAILURE：地址全失败，开始 backoff

如果当前所有候选地址都失败了，`InternalSubchannel.scheduleBackoff(status)` 会把 subchannel 送进 TRANSIENT_FAILURE，并安排重连。

`InternalSubchannel.java:296` — `scheduleBackoff(status)`

这里是生产排障里另一个容易搞错的点：**进入 TF 的时候，真正有诊断价值的是失败的 `Status` 和 backoff 是否开始，而不是“状态枚举值变了”。**

### 8.4 READY transport shutdown：为什么经常回到 IDLE，而不是 TF

很多人以为 READY 上的 transport 一旦 shutdown，subchannel 应该马上进 TF。其实 grpc-java 在不少场景下会把它送回 IDLE，而不是 TF。

`InternalSubchannel.java:637` — `transportShutdown()`
`InternalSubchannelTest.java:306` — READY transport shutdown 返回 IDLE

原因很简单：一个已经用完的 READY transport shutdown，不一定意味着“连接失败到需要 backoff”，也可能只是“当前活跃连接正常关闭，下一次有需求再连”。

## 九、常见“卡住”症状怎么从源码反推

### 9.1 no addresses：不是 transport 问题，是 resolver/LB 已经告诉你“没路可走”

如果 resolver 返回空地址，LB 的 `acceptResolvedAddresses()` 会把它转成 `UNAVAILABLE`，channel 往往进入 TRANSIENT_FAILURE，picker 返回 `withError()`。

`PickFirstLoadBalancerTest.java:491` — no addresses → `UNAVAILABLE` / TF

这类问题要先看 resolver 和 LB，不要先抓 transport。

### 9.2 stale picker：有健康 subchannel，但 picker 还没更新

这是最危险的一类症状。系统里可能已经有一个健康的 READY subchannel，但当前安装在 delayed transport 上的 picker 还是旧快照。于是 RPC 用旧 picker 去 pick，结果拿到的是过期的 subchannel 或 noResult，继续缓冲。

这种情况下，“系统其实是健康的，但这次请求还是卡住了”。真正的问题不在 transport，而在 **LB 没有及时发布新的 picker**。

### 9.3 `transportTerminated()` 不是主要转折点

线上抓日志时，很多人看到 `transportTerminated()` 就把它当成“状态变化发生的地方”。实际上它更像清理事件。真正有语义的状态变化，通常更早发生在 `transportShutdown()` 时。

`InternalSubchannel.java:674` — `transportTerminated()`
`InternalSubchannel.java:637` — `transportShutdown()`

如果你把 terminated 当成主要诊断点，会经常慢半拍。

## 十、误解澄清

### 误解一：channel `READY` 就等于这次请求一定能发出去

不是。channel `READY` 只是对外总状态，它说明“当前系统里存在可用路径”，不说明“这次具体请求已经拿到 active transport”。某次 RPC 仍可能卡在 stale picker、pendingStreams，或者选中了一个暂时没有 active transport 的 subchannel。

### 误解二：`withSubchannel()` 就等于已经离开进程

也不是。`withSubchannel()` 只说明 picker 选中了方向，不说明 transport 已经就绪。真正决定这次 RPC 能不能立刻出去的，是 `GrpcUtil.getTransportFromPickResult()` 最终有没有拿到 active transport。

### 误解三：`transportTerminated()` 才是主要状态转折点

很多日志分析会盯着 terminated，但它更像清理事件。真正有语义的转折通常更早发生在 `transportShutdown()`，因为那时 subchannel 的状态已经开始变化，picker 也可能据此重建。

## 十一、收网总结：卡住排障四问法

回到开头的困惑：为什么一个调用明明没报错，却也没有真正发出去？

因为 grpc-java 里“能不能发出去”不是 channel 一个状态决定的，而是五道门共同决定的：它可能还卡在 `pendingCalls`，可能卡在 `pendingStreams`，可能 picker 还没结果，可能 subchannel 还在 CONNECTING，可能 transport 根本还没 active。

真正有用的排障方法，可以收成四问：

1. **这次调用卡在哪个缓冲层？** 是 `pendingCalls` 还是 `pendingStreams`？
2. **picker 给了什么？** 是 `withSubchannel`、`withError` 还是 `withNoResult`？
3. **subchannel 当前是什么状态？** 是 READY、CONNECTING、IDLE 还是 TRANSIENT_FAILURE？
4. **transport 是否真的 active？** 如果没有 active transport，`withSubchannel()` 也只能继续等。

把这四问按顺序问下去，大多数“没报错但发不出去”的问题都会变得可定位：

- 一直 pending 且还没到 picker：看 `pendingCalls`，多半是初始解析/config 没完成。
- picker 有结果但还没出去：看 `pendingStreams` 和 `withSubchannel()` 是否只是选中了一个当前无 active transport 的 subchannel。
- 同一个 picker error，有时立即失败有时只是卡住：看是不是 wait-for-ready。
- channel `READY` 但某个调用仍然卡住：看是不是 stale picker 或 picker 没重建。

**三句话总结：**

1. channel、subchannel、picker、transport 是四层不同的状态视角，任何一层都不能替代另一层。
2. `withSubchannel()` 不是“已经发出”，`withError()` 也不一定“立刻失败”，真正的最终行为要看 `GrpcUtil.getTransportFromPickResult()` 和调用选项。
3. 生产上遇到“没报错但发不出去”，先问缓冲层、再问 picker、再问 subchannel、最后问 transport，顺序反过来几乎一定会误判。

**下篇预告：** 下一篇进入 `ch05/03-keepalive-flowcontrol-connection`，继续看 keepalive、流控与连接问题为什么会在生产上造成“慢、抖、断”。