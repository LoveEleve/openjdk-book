# grpc-java：Deadline、Cancel、Retry 的线上排障

> 基于 grpc-java v1.83.1

## 一、困惑开场：同样失败，为什么看到的状态码完全不同

假设你在排查一个线上 RPC 失败。客户端日志里看到的是 `DEADLINE_EXCEEDED`，服务端日志里看到的却是 `CANCELLED`。再看另一条调用，服务端已经返回了 `OK`，客户端最终却报了 `CANCELLED`。再往后一层看，某个调用明明已经 `shutdown()` 之后还在继续重试，另一个调用却在 `shutdownNow()` 后立刻死掉。

这些现象如果只看最终 `Status`，会非常像“状态码有时不准”。但 grpc-java 并不是随机给你一个码。它做的是另一件事：**先让各种来源在本地形成自己的终止理由，再在收敛点决定最终交给应用层哪个 Status。**

线上排障最容易犯的错，就是把“最终看到的码”当成“最初发生的原因”。这两者经常不是一回事。

## 二、前情回顾：前面几篇已经讲了机制，这一篇只问线上怎么判因

在 ch03/01 我们已经知道 retry 和 hedging 不是 transport 的小技巧，而是 `RetriableStream` 中的一整套逻辑流机制。在 ch04/02 我们已经知道 Status 是怎么被编码进 trailers、再被客户端解码出来的。在 ch04/03 我们又知道 half-close、cancel、deadline、Context 取消这些路径最后都会收敛到 `closedInternal()` 和 `onClose()`。

但这些篇章回答的是“机制是什么”。生产排障关心的是另一件事：**如果我在线上只看到一个 `DEADLINE_EXCEEDED` 或 `CANCELLED`，我怎么反推出真正的来源？**

## 三、先走三条失败的路

### 失败方案一：最终看到的 Status，就等于最初来源

这是最常见的误判。你在客户端最后看到 `DEADLINE_EXCEEDED`，于是推断“服务端肯定超时了”；你看到 `CANCELLED`，于是推断“肯定是业务代码主动 cancel 了”。

但 grpc-java 有两个改写最终 Status 的关键机制。

第一个是 deadline 双检。客户端在 `closedInternal()` 里会检查：如果服务端送来的状态是 `CANCELLED`，但本地 effective deadline 其实已经过期，那最终交给应用层的状态会被改写成 `DEADLINE_EXCEEDED`。这意味着：**你最终看到的是本地视角更有解释力的状态，不一定是远端原样返回的状态。**

第二个是 `exceptionStatus` 覆盖。假如客户端 listener 在 `onMessage()`、`onHeaders()` 或 `onReady()` 里自己抛了异常，grpc-java 会本地取消调用，并在最终收敛时用这个本地异常对应的 `CANCELLED` 覆盖服务端已经返回的 `OK` 或其他状态。于是你在日志里看到的就不再是“服务端返回了什么”，而是“客户端自己已经处理不下去了”。

所以，最终 Status 不是原始事实，而是收敛结果。

### 失败方案二：retry 只看状态码

另一个特别常见的误判是：看到 `UNAVAILABLE` 就以为会自动重试，看到别的码就以为不会。

实际实现复杂得多。`RetriableStream` 决定要不要 retry，并不是看一个 status code 就完事。它还要同时检查：

- 当前逻辑流是不是已经 commit 到某个 winner substream 了
- 这次关闭时的 `RpcProgress` 是 `REFUSED`、`DROPPED`、`PROCESSED` 哪一种
- retry policy 里是否允许这个 status code
- attempt 次数是否超过上限
- channel 级 throttle 是否已经把 retry 冻住了
- pushback 是否要求延迟，甚至明确要求不要再试

所以线上排障时，不能把“最终码”和“是否 retry”直接画等号。真正要看的是：**当时那一刻，逻辑流还是否允许继续演化。**

### 失败方案三：`shutdown()` 和 `shutdownNow()` 都会把重试中的调用立刻杀掉

很多人看到 channel shutdown，就自然以为“所有调用都应该立刻结束”。但 grpc-java 对已经开始的 retriable RPC 不是这么做的。

`shutdown()` 的语义是：拒绝新调用，但允许已经启动的逻辑 RPC 把自己跑完。对于一个还在 backoff、还没真正 commit 的 retriable stream，它甚至会故意保护 delayed transport，不让它过早终止。你在线上看到“channel 都 shutdown 了，这个调用怎么还在 retry”，这不是 bug，而是语义设计。

真正会强制把未提交 retriable streams 和 pending calls 直接杀掉的是 `shutdownNow()`。

所以看到“shutdown 后调用还在继续”时，不要先怀疑泄漏，先确认调用是在 `shutdown()` 还是 `shutdownNow()` 之后发生的。

## 四、最小总图：来源层、重试层、收敛层

这篇文章要抓住的不是一条函数调用链，而是三层心智图。

```
来源层（6 类）：
  1) deadline
  2) 显式 cancel
  3) Context cancel
  4) transport error
  5) 服务端错误
  6) listener 异常
        ↓
重试层：
  RetriableStream 判断是否还有资格继续（retry / hedge / commit / throttle / pushback）
        ↓
收敛层：
  transportReportStatus() → closeListener() → closedInternal() → onClose(Status, Metadata)
```

注意这里先把口径钉死：本篇统一按 **6 类终止来源** 来讲。后面如果说“取消的四类来源”，那指的是最终更常表现成 `CANCELLED` 的 4 类；如果说“超时的三条来源链”，那指的是最终更常表现成 `DEADLINE_EXCEEDED` 的 3 条。它们不是并列分类体系，而是同一张图上的不同观察切面。

线上排障时，真正有用的问题不是“最终是什么码”，而是下面三个：

1. **谁先发起了终止？** 是本地 deadline、显式 cancel、Context 取消，还是 transport、服务端、listener 异常？
2. **这个逻辑 RPC 当时是否已经 commit？** 如果还没 commit，就不能只看当前 substream 的关闭；它可能还会 retry 或 hedge。
3. **本地 effective deadline 是否已经过期？** 如果过期，即使远端送来的是 `CANCELLED`，本地最终也可能显示为 `DEADLINE_EXCEEDED`。

后面所有细节，都是在回答这三个问题。

## 五、`DEADLINE_EXCEEDED` 的三条来源链

### 5.1 start 之前 deadline 就已经过期

这里先做一个路标。下面这一节讲的三条链，核心都不是“服务端返回了超时”，而是**客户端本地怎样合成出 `DEADLINE_EXCEEDED`**。这对排障非常关键：很多超时根本没有等到远端任何最终状态，就已经在本地被判死了。

这是最容易忽略的一种情况：调用甚至还没真正创建 stream，就已经注定失败。

`ClientCallImpl.startInternal()` 会先算 effective deadline，也就是 `CallOptions` deadline 和 `Context` deadline 的最小值。如果这个 deadline 在 start 时已经过期，它不会去创建真实 transport stream，而是直接创建一个 `FailingClientStream`，状态就是 `DEADLINE_EXCEEDED`。

`ClientCallImpl.java:244` — 计算 effective deadline 并创建 `CancellationHandler`
`ClientCallImpl.java:248` — deadline 已过期 → `FailingClientStream(DEADLINE_EXCEEDED)`

排障上这意味着：**有些超时根本不是“请求发出去之后超了”，而是“调用启动时预算已经没了”。**

### 5.2 start 之后，本地 deadline 定时器触发

如果 effective deadline 不是来自 Context，而是来自 `CallOptions`，`CancellationHandler.setUp()` 会自己挂一个定时器。定时器到期后，`run()` 直接调用 `stream.cancel(formatDeadlineExceededStatus())`。

`ClientCallImpl.java:352` — `CancellationHandler.setUp()` 挂定时器和 Context listener
`ClientCallImpl.java:392` — 定时器触发 → `stream.cancel(formatDeadlineExceededStatus())`
`ClientCallImpl.java:396` — `formatDeadlineExceededStatus()` 生成 `DEADLINE_EXCEEDED`

这里要注意：这个 `DEADLINE_EXCEEDED` 是**本地合成**出来的，不需要等服务端回复，也不需要 transport 把 trailers 带回来。

### 5.3 Context deadline 触发

如果 effective deadline 来自 Context，就不是 `CancellationHandler` 的独立定时器在工作，而是 Context 自己的 deadline 机制触发一个 `TimeoutException` 取消。

`Context.java:696` — deadline 到期通过 `TimeoutException` 取消 Context
`ClientCallImpl.java:382` — `CancellationHandler.cancelled(Context)` 响应 Context 取消
`Contexts.java:128` — `statusFromCancelled()` 把 Context 取消翻译成 Status

`statusFromCancelled()` 里专门把 `TimeoutException` 翻译成 `DEADLINE_EXCEEDED`，而不是 `CANCELLED`。所以从结果上看，Context deadline 和 CallOptions deadline 最终都能得到 `DEADLINE_EXCEEDED`，但源码来源不同。

## 六、`CANCELLED` 的四类来源链

这里先做一个路标。上一节讲的是“为什么会超时”，这一节讲的是“为什么会取消”。它们最后都可能走到 `stream.cancel(...)`，但语义来源完全不同。

### 6.1 显式 `ClientCall.cancel()`

最直接的来源就是应用代码自己调了 `cancel()`。

`ClientCallImpl.cancelInternal()` 会构造一个 `Status.CANCELLED`，带上可选的 description/cause，然后调用 `stream.cancel(status)`，同时清理 deadline 定时器和 Context listener。

`ClientCallImpl.java:459` — `cancelInternal()` 入口
`ClientCallImpl.java:481` — 调用 `stream.cancel(status)`

排障上，这类 `CANCELLED` 最容易识别：通常会带调用方传入的 message，且取消点在业务代码附近。

### 6.2 Context 非超时取消

Context 被取消不一定是 deadline。父 Context 主动 cancel、某个上游逻辑中止，都会传播到当前调用。

如果 `statusFromCancelled()` 看到的不是 `TimeoutException`，也不是某个已经包装好的 `StatusRuntimeException`，它最终会回落到 `CANCELLED`。

`Contexts.java:128` — `statusFromCancelled()` 入口
`Contexts.java:138` — `TimeoutException` 特判为 `DEADLINE_EXCEEDED`

所以排障时看到 `CANCELLED`，不能只想“是不是有人调了 `ClientCall.cancel()`”，还要问“是不是上层 Context 先被取消了”。

### 6.3 transport 级 cancel / reset

HTTP/2 的 `CANCEL`、RST_STREAM、协议错误等 transport 问题，也可能最后表现成 `CANCELLED` 或其他非 OK 状态。

在 grpc-java 里，HTTP/2 `CANCEL` 会映射到 gRPC `CANCELLED`；`REFUSED_STREAM` 更接近 `UNAVAILABLE`；各种协议违规则更可能是 `INTERNAL`。

`GrpcUtil.java:347` — HTTP/2 `CANCEL` → `CANCELLED`
`GrpcUtil.java:340` — 其他 HTTP/2 错误映射

所以看到 `CANCELLED`，不要自动假设“业务 cancel”。有时候它只是 transport 告诉你“这条流被远端 reset 了”。

### 6.4 listener 异常导致的本地取消

这是最容易误诊的一类。客户端 listener 在 `onHeaders()`、`onMessage()`、`onReady()` 中抛了异常，grpc-java 会把这个异常变成本地取消路径。

`ClientCallImpl.java:589` — `exceptionThrown()` 记录 `exceptionStatus` 并 cancel stream
`ClientCallImpl.java:623` — `onHeaders()` 异常 → `CANCELLED.withCause(t)`
`ClientCallImpl.java:671` — `onMessage()` 异常 → `CANCELLED.withCause(t)`
`ClientCallImpl.java:774` — `onReady()` 异常 → `CANCELLED.withCause(t)`

这类问题在线上很迷惑：服务端明明返回了 `OK`，客户端最终却看到了 `CANCELLED`。真正原因不是网络，也不是服务端，而是客户端自己的回调代码炸了。

## 七、`closedInternal()` 如何改写最终状态

### 7.1 先收敛，再决定交付哪个结果

所有这些来源，最后都不会直接把结果交给应用层，而是先经过 `transportReportStatus()`、`closeListener()`，最终进入 `ClientStreamListenerImpl.closedInternal()`。

`AbstractClientStream.java:401` — `transportReportStatus()`
`AbstractClientStream.java:456` — `closeListener()` 里的 `listenerClosed` 保证只交付一次
`ClientCallImpl.java:689` — `closedInternal()` 最终收敛点

这条链路的意义是：不管来源是 trailers、cancel、deadline 还是 transport error，最后都要过一个统一的裁决点。

### 7.2 deadline 双检：为什么远端 `CANCELLED` 最终可能变成本地 `DEADLINE_EXCEEDED`

`closedInternal()` 第一条关键规则是：如果当前拿到的是 `CANCELLED`，而本地 effective deadline 其实已经过期，那就把它改写成 `DEADLINE_EXCEEDED`。

`ClientCallImpl.java:692` — deadline 双检改写逻辑

这条规则直接解释了最常见的线上困惑：**为什么服务端日志是 `CANCELLED`，客户端最终却是 `DEADLINE_EXCEEDED`。**

答案不是“谁错了”，而是“双方看的是不同视角”。服务端看到的是“流被取消了”；客户端看到的是“我这边的时间预算已经耗尽，所以最终原因以 deadline 为准”。

### 7.3 `exceptionStatus` 覆盖：为什么服务端 `OK` 也可能被本地 `CANCELLED` 覆盖

`closedInternal()` 第二条关键规则是：如果 listener 侧已经记录了 `exceptionStatus`，它会覆盖服务器送来的最终状态。

`ClientCallImpl.java:723` — `exceptionStatus` 覆盖

这条规则解释的是另一类常见困惑：**为什么服务端说成功了，客户端却说取消了。**

根本原因是客户端应用代码已经在回调里炸掉了，grpc-java 认为“服务端说成功”这件事已经没有意义，因为客户端本地已经不能继续消费这次调用结果了。

## 八、`RetriableStream`：retry 和 hedging 不是只看状态码

这里再做一个路标。到前面为止，我们讲的是“一个 attempt 为什么会结束”；这一节要讲的是“这个逻辑 RPC 在一个 attempt 结束后，还会不会继续演化出新的 attempt”。

### 8.1 policy 在哪里选

retry policy 和 hedging policy 不是在失败发生时临时拍脑袋决定的，而是在 service config 进入 channel 运行时后就已经被解析好了。

`ManagedChannelServiceConfig.java:333` — retry policy 解析与 attempt 上限裁剪
`ManagedChannelServiceConfig.java:380` — hedging policy 解析与 attempt 上限裁剪
`ManagedChannelImpl.java:483` — 创建 `RetryStream extends RetriableStream`

### 8.2 逻辑 RPC 的 deadline 不会因为新 attempt 重置

这是线上特别容易误诊的一点。retry 不是“每次重试再给你一轮完整 timeout”。在 grpc-java 里，deadline 是绝对时间。`RetriableStream.setDeadline()` 会把同一个 absolute deadline replay 到每个新 substream 上。

`RetriableStream.java:753` — deadline replay 到每个 substream

所以 backoff 吃掉的时间，后续 attempt 也要一起承担。你在线上看到“第一次 attempt 花了 900ms，第二次一上来就超时”，这不是 bug，而是因为整条逻辑 RPC 的预算已经被前面的 attempt 吃光了。

### 8.3 retry 的决定点

attempt 关闭后，`RetriableStream.Sublistener.closed()` 会进入 retry/hedging 决策路径。这里真正决定“要不要 retry”的不是某个码，而是一组条件。

`RetriableStream.java:950` — `Sublistener.closed()` 开始决策
`RetriableStream.java:1006` — `makeRetryDecision()`
`RetriableStream.java:1065` — retry 需要 policy + retryable code + 次数未满 + 未被 throttle

也就是说，同样一个 `UNAVAILABLE`，可能会 retry，也可能不会。关键差别不在状态码本身，而在当时那一刻它是否仍然满足 retry 的全部上下文条件。

### 8.4 hedging 的决定点

hedging 也一样，不是“配了 hedging policy 就一定多发”。它还要看 pushback、throttling、attempt 上限、是否已经 commit。

`RetriableStream.java:1099` — `makeHedgingDecision()`

所以线上排障看到“为什么这个请求没 hedge”，别先问“policy 有没有开”，先问“在它原本应该 hedge 的那个时刻，逻辑流是不是已经被冻结或 commit 了”。

这里再补一个事故视角的提醒：如果你在线上看到了 `UNAVAILABLE`，却没有看到任何新 attempt，不要马上怀疑“重试配置没生效”。更高概率的情况是：

- 这个逻辑 RPC 已经 commit，后续不允许再长出新 attempt
- channel throttle 已经把 retry/hedging 冻住了
- pushback 要求延迟，甚至明确告诉客户端别再试
- attempt budget 已经被前面的失败吃光了

也就是说，**“没重试”本身不是结论，它只是 `RetriableStream` 决策之后的结果。** 生产排障时要追问的是：它为什么在那个时刻失去了继续演化的资格。

## 九、cancel 如何影响未提交 attempts 和 scheduled retries

### 9.1 cancel 一个逻辑 RPC，不只是 cancel 当前 substream

如果一个 retriable call 还没 commit 到某个 winner substream，用户 cancel 的不是“当前正在跑的某个 attempt”，而是整个逻辑 RPC。

这时 `RetriableStream.cancel()` 会先把一个 noop substream 提交成 winner，再做 post-commit 清理，最后关闭 master listener。

`RetriableStream.java:526` — cancel 未提交逻辑 RPC 时 commit noop winner 并关闭 master listener

### 9.2 commit 之后，剩下的定时任务和 loser attempts 都会被清理

一旦 commit 发生，所有 scheduled retry、scheduled hedge，以及其他 loser substreams 都会被取消。

`RetriableStream.java:167` — commit 后取消 scheduled retry/hedge 与 loser substreams

这也是为什么你在线上常看到类似 “Stream thrown away because RetriableStream committed” 这样的日志线索。它不是新的业务错误，也不表示远端主动 cancel 了你，而是逻辑 RPC 已经选出了 winner，于是其他 loser attempts 被内部回收。

### 9.3 `shutdown()` 和 `shutdownNow()` 为什么给你完全不同的线上感觉

`shutdown()` 和 `shutdownNow()` 的差别，是生产排障里最容易误判的一点。

`shutdown()` 只拒绝新调用，但会允许已经启动的逻辑 RPC 继续跑完。对还处于 backoff、尚未 commit 的 retriable stream，grpc-java 甚至会故意保护 delayed transport，不让它提前终止。

`ManagedChannelImpl.java:1264` — `shutdown()` 路径
`ManagedChannelImpl.java:1286` — 未提交 retriable streams 保护 delayed transport

所以你在线上看到“channel 都 shutdown 了，这个调用怎么还在 retry”，第一反应不应该是怀疑线程泄漏，而是先确认：这是不是一个已经开始、但还没 commit 的逻辑 RPC。

而 `shutdownNow()` 的语义不同。它会强制取消未提交 retriable streams 和 pending calls。

`ManagedChannelImpl.java:959` — `shutdownNow()` 路径
`ManagedChannelImpl.java:1299` — `shutdownNow()` 强杀 uncommitted retriable streams

## 十、误解澄清

### 误解一：最终 `Status` 就是最初来源

不是。最终 `Status` 是 `closedInternal()` 收敛之后的结果。deadline 双检会把远端 `CANCELLED` 改写成 `DEADLINE_EXCEEDED`，`exceptionStatus` 覆盖会把服务端 `OK` 改写成本地 `CANCELLED`。所以最终码首先是“本地视角下最有解释力的结论”，其次才是“远端原样返回的事实”。

### 误解二：`CANCELLED` 一定是业务主动 cancel

也不是。显式 `ClientCall.cancel()` 当然会产生 `CANCELLED`，但 transport reset、Context 非超时取消、listener 回调异常都可能最终表现成 `CANCELLED`。如果你只看到 `CANCELLED` 就断定“业务主动取消了”，很容易把 transport 问题或客户端回调 bug 误诊成业务行为。

### 误解三：`shutdown()` 之后还在 retry 就一定泄漏了

也不对。`shutdown()` 的语义是拒绝新调用，但允许已经启动的逻辑 RPC 跑完。未 commit 的 retriable stream 仍可能继续 backoff、retry 或 hedge。真正会强制打断这些未提交逻辑 RPC 的是 `shutdownNow()`。所以排障时先分清 shutdown 模式，再谈是不是泄漏。

## 十一、收网总结：排障三问法

回到开头的困惑：为什么同样是失败，最后看到的状态码会完全不同？

因为 grpc-java 不是把“失败”当成一个扁平事件来处理的。它先让不同来源形成各自的局部终止理由，再经过 retry/hedging 层判断逻辑 RPC 是否还能继续演化，最后再在 `closedInternal()` 里收敛成唯一的最终状态。最终看到的码，常常是**排障最有解释力的结果**，不一定是最初来源的原样回放。

真正有用的排障方法，可以收成三问：

1. **谁先发起了终止？** 是 deadline、显式 cancel、Context、transport、服务端错误，还是 listener 异常？
2. **这个逻辑 RPC 当时是否已经 commit？** 如果没 commit，当前失败未必是最终失败，后面还可能 retry 或 hedge。
3. **本地 effective deadline 是否已经过期？** 如果过期，远端的 `CANCELLED` 很可能在本地被改写成 `DEADLINE_EXCEEDED`。

把这三问套上去，很多线上“诡异现象”都会变得可解释：

- 服务端 `CANCELLED`、客户端 `DEADLINE_EXCEEDED`：看第三问，本地 deadline 已经过期。
- 服务端 `OK`、客户端 `CANCELLED`：看第一问，客户端 listener 自己抛异常了。
- `UNAVAILABLE` 却没 retry：看第二问和 policy，上下文条件没满足。
- `shutdown()` 之后调用还在跑：看第二问，这个逻辑 RPC 还没 commit，channel 在故意保它跑完。

**三句话总结：**

1. `DEADLINE_EXCEEDED`、`CANCELLED`、retry、hedging、transport error 不是同一类失败，它们分别来自来源层、重试层和收敛层的不同决策点。
2. 最终 `Status` 不是原始事实，而是 grpc-java 在 `closedInternal()` 中经过 deadline 双检、`exceptionStatus` 覆盖等规则后的最终交付结果。
3. 生产排障要先问“谁先终止、是否已 commit、本地 deadline 是否过期”，再看最终码；顺序反过来，几乎一定会误判。

**下篇预告：** 下一篇进入 `ch05/02-channel-subchannel-picker-diagnosis`，继续从生产视角看 channel、subchannel、picker 与 transport 的状态诊断。