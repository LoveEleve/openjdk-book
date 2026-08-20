# 为什么“失败后再试一次”远远不够：grpc-java 的 Service Config、Retry 与 Hedging 运行时主线

> 本文基于 `grpc-java v1.83.1` 当前源码。前面的主干篇已经把 grpc-java 的客户端调用、服务端调用、横切面协议、NameResolver / LoadBalancer / transport 桥接，以及 codegen / builder / 消息对象桥立住了。本文继续补完整卷里的机制补深层：为什么有些调用会在失败后退避重试，有些会在延迟后并行做 hedging，有些又会被 throttle 或 buffer 预算卡住。这些行为并不是 transport 临时聪明一点，而是 service config、builder 配额、call options 与 `RetriableStream` 状态机共同决定的。重点放在 `ManagedChannelServiceConfig`、`MethodInfo`、`RetryPolicy`、`HedgingPolicy`、`ManagedChannelImplBuilder`、`ManagedChannelImpl.ChannelStreamProvider`、`RetriableStream` 这几层如何接力；不展开 xDS 全景，不重讲基础 NameResolver/LB 主线。

## 为什么“失败了再试一次”远远不够解释 retry/hedging

很多人第一次理解 grpc-java 的 retry 时，直觉会非常朴素：

- 调用失败了
- 再试一次
- 如果还失败，再看要不要继续

而 hedging 听起来也很容易被压成另一句：

- 多开几个并行请求，谁先成功用谁

这两句话都抓到了一点表面现象，但如果就停在这里，会把 grpc-java 里最关键的运行时结构全部擦掉。

因为只要你把问题问得再具体一点，这种“再试一次”的理解立刻就会散掉：

- 什么失败算可重试？
- 什么失败只允许终止，不允许重试？
- retry 和 hedging 的启动条件为什么不一样？
- retry 为什么要 backoff？hedging 为什么要 delay？
- 为什么有时会被 throttle？
- 为什么 channel 还要维护 per-RPC / per-channel buffer 预算？
- 为什么已经 shutdown 的 channel，定时中的 retry/hedging 仍然可能继续发生一小段？
- 为什么这些规则有时来自 service config，有时又受 builder 限制？

这些问题都说明：

- retry/hedging 不是 transport 收到错误后临时补一个 for-loop
- 而是一条完整的配置 -> 调用语义 -> transport 状态机

也就是说，真正要回答的问题不是：

- grpc-java 能不能重试
- grpc-java 支不支持 hedging

而是：

**为什么同样是一条调用，grpc-java 会先把 policy 写进 service config 和 builder 限额里，再把它们压成 `MethodInfo`，最后由 `RetriableStream` 统一承载重试、并发试探、pushback、throttle 和 budget 这整套运行时机制。**

如果先把最小总图压缩一下，它其实长这样：

```text
raw service config / builder limits
  -> ManagedChannelServiceConfig / MethodInfo
  -> CallOptions / ChannelStreamProvider
  -> RetriableStream
  -> retry / hedging substreams
  -> commit / cancel / drain / close
```

这条线一旦立住，后面你再看：

- service config 为什么不是普通配置表
- builder 限额为什么不是附属参数
- `RetriableStream` 为什么不是几个 stream 的集合
- retry 和 hedging 为什么不能只看成串行 / 并行

整条机制就不会再像 scattered feature list。

## 先看失败方案：为什么 retry/hedging 不能被简化成几个 if

### 失败方案一：retry / hedging 只是 transport 失败后的补救动作

这是最常见、也最容易误导人的理解。

因为从调用结果看，用户最容易观察到的现象确实就是：

- 失败了，后来成功了
- 或者同时发了多个尝试，后来有一个赢了

于是就很容易把整个问题压缩成：

- transport 出错时补一层重试逻辑就行

问题在于，这样理解解释不了：

- 重试资格是在哪里被决定的
- 哪些 status code 是 retryable，哪些只是 non-fatal for hedging
- builder 的 `enableRetry()` / `disableRetry()`、`maxRetryAttempts`、`maxHedgedAttempts`、buffer limit 为什么会影响 runtime
- pushback、throttle、commit、previous attempts header 这些信息为什么会出现在逻辑流里

这些都说明 retry/hedging 不是补救动作，而是：

- **从调用开始前就已经被参数化的一条逻辑流状态机**

### 失败方案二：service config 只是配置表，和调用主线关系不大

另一种常见误解，是承认 service config 存在，但只把它看成“配置值存储区”。

比如：

- 这里写一个 timeout
- 那里写一个 retry policy
- 运行时想用的时候拿一下

这种理解会低估 `ManagedChannelServiceConfig` 的地位。

因为它不是“原始配置数据的保存处”，而是：

- 已经解析、校验、分层匹配之后的运行时配置模型

它真正回答的是：

- default 级规则是什么
- service 级规则是什么
- method 级规则是什么
- 这次调用最终命中哪一层
- 命中的规则应该怎样写入 `MethodInfo`

也就是说，它不是 JSON 的镜像，而是已经被翻译过的 runtime 策略对象。

### 失败方案三：retry 和 hedging 只是一个串行、一个并行

这也是一种特别常见的“只看现象”的误解。

因为表面上看，二者好像只是：

- retry：一个失败后再来一个
- hedging：先后或同时开多个

但真正的差异远不只这些：

- retry 会受 retryable status code、backoff、pushback、previous attempts 等约束
- hedging 会受非致命状态、hedging delay、并发尝试上限和 buffer 预算约束
- commit 之后怎么清理其他 substream
- throttle 怎样抑制后续尝试
- transport 关闭或 channel shutdown 时已有计划任务怎样收口

这些都说明二者不只是“调度方式不同”，而是：

- **整个逻辑流状态机不同**

### 失败方案四：buffer / throttle 只是性能优化附属件

这条误解更隐蔽，但更危险。

很多人看到：

- `retryBufferSize`
- `perRpcBufferLimit`
- `Throttle`

会直觉觉得：

- 这是优化项，主线不理解也行

问题在于，grpc-java 里这些并不是“能更快一点”的附属细节，而是直接影响语义的硬约束：

- buffer 不够时，新的尝试不能无限继续派生
- throttle 降到阈值以下时，retry/hedging 就会被抑制

也就是说，它们不是性能注脚，而是：

- **逻辑流是否还能继续演化的边界条件**

## 先立最小总图：配置、限额和逻辑流状态机是怎样接起来的

如果先不抠代码细节，最值得先记住的是 retry/hedging 并不是一个单层 feature，而是一条从配置到流状态机的桥。

```text
builder / raw service config
  -> ManagedChannelServiceConfig
  -> MethodInfo
  -> ChannelStreamProvider
  -> RetriableStream
  -> Substream attempts
  -> commit / cancel / drain
```

如果换成人话，这条链其实只发生了五件事。

第一，**外部配置先被翻译成 channel 可理解的策略对象**。

第二，**每次具体调用会从这些策略里命中自己的 `MethodInfo` 快照**。

第三，**channel 决定这次调用到底走普通 stream，还是进入 retriable/hedging 逻辑流**。

第四，**真正的 retry/hedging 由一条逻辑 `RetriableStream` 来统一承载，而不是多个独立 stream 随机堆在一起**。

第五，**最终必须通过 commit、cancel、drain 把所有尝试收束成一次确定结果。**

所以这条机制最重要的地方不是“支持重试”，而是：

- 它如何把外部策略稳定压到一次具体调用里

先有这张图，后面再落代码，读者才不会把 retry 和 hedging 听成几个散乱参数。

## 第一层：`ManagedChannelServiceConfig` 为什么不是配置表，而是运行时策略模型

`ManagedChannelServiceConfig` 的类注释已经说得很明确：

- 它是 service configuration data 的 fully parsed and validated representation

见 `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:39`。

这说明从它出现开始，问题就已经不是“怎么存配置”了，而是：

- 如何把原始 service config 翻译成可供 runtime 直接消费的策略模型

### 它为什么要拆成 default / service / method 三层

类里最关键的结构不是 retry policy 本身，而是这三层：

- `defaultMethodConfig`
- `serviceMap`
- `serviceMethodMap`

见 `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:45`。

这说明 grpc-java 不是拿到 service config 就“整包套用”，而是先把规则拆成：

- 默认规则
- service 级规则
- 精确 method 级规则

这和真实 RPC 系统的配置方式完全一致：

- 绝大多数策略都不是“全局唯一一套”
- 而是不同 service / method 可以有不同约束

### `fromServiceConfig(...)` 真正值钱的是“翻译和校验”

`fromServiceConfig(...)` 做的关键工作是：

- 读取 `methodConfig`
- 提前完成尽量多的校验
- 解析 health checking、retry throttling、load balancing config
- 最后把 method/service/default 三层规则稳定装进一个对象

见 `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:89`。

这说明 service config 这层不是“原始 JSON 临时在调用时读一下”，而是：

- 在真正替换当前配置前，先翻译成受约束的 runtime 模型

所以这一层更像编译，不像存储。

### `getMethodConfig()` 说明真正命中的是一条具体调用的策略快照

`getMethodConfig(MethodDescriptor)` 会按顺序：

- 先查 full method name
- 再查 service name
- 最后回退到默认 config

见 `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:180`。

这一步非常关键。

因为它说明 service config 最终不是“挂在 channel 上的一团配置”，而是：

- 每次调用都要命中一份具体策略快照

这份快照，最后就体现在 `MethodInfo` 里。

## 第二层：`MethodInfo` 为什么是 service config 真正落到调用上的即时形态

`MethodInfo` 是这一篇最应该重点抓住的桥。

它不是一个附属小对象，而是一次调用在 runtime 里真正读到的配置形态。

类里直接保存了：

- timeoutNanos
- waitForReady
- maxInboundMessageSize
- maxOutboundMessageSize
- retryPolicy
- hedgingPolicy

见 `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:248`。

这说明 service config 这层并没有“停留在 channel 配置”，而是进一步压成了：

- 一次调用可直接消费的即时策略对象

### retry / hedging policy 是怎样进来的

`MethodInfo` 构造器里会根据 `retryEnabled`：

- 解析 `retryPolicy`
- 解析 `hedgingPolicy`
- 并套上 `maxRetryAttemptsLimit` / `maxHedgedAttemptsLimit`

见 `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:285`。

这说明两件事：

- service config 决定“原始策略想怎么配”
- builder 限额决定“runtime 最多允许到哪里”

也就是说，retry/hedging 不是单纯由 service config 决定的，而是 service config 与 channel 级上限共同裁决的。

### `RetryPolicy` 和 `HedgingPolicy` 为什么不是纯数据，而是行为约束集合

`MethodInfo.retryPolicy(...)` 会校验：

- `maxAttempts >= 2`
- backoff 必须大于 0
- `retryableStatusCodes` 和 `perAttemptRecvTimeout` 的组合是否合法

见 `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:333`。

`hedgingPolicy(...)` 则会校验：

- `maxAttempts >= 2`
- `hedgingDelay >= 0`
- non-fatal status code 集合

见 `core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:380`。

这说明 retry/hedging policy 不是“随手存几个字段”，而是被严格校验过的行为边界集合。

所以 `MethodInfo` 真正的价值不是“把配置存下来”，而是：

- 把外部策略压缩成这次调用真正可以执行的一组约束

### 测试怎么证明 MethodInfo 不是摆设

`ManagedChannelServiceConfigTest` 很能说明这一点。

它不仅测：

- retry policy 正常解析
- retry disabled 时 policy 应为 null
- 空 `retryableStatusCodes` 何时合法

还特别测了：

- `perAttemptRecvTimeout` 与 status code 的边界关系

见：

- `core/src/test/java/io/grpc/internal/ManagedChannelServiceConfigTest.java:148`
- `core/src/test/java/io/grpc/internal/ManagedChannelServiceConfigTest.java:211`

这说明 grpc-java 作者并不把这些看成简单配置，而是把它们当作容易出错、必须锁死的运行时契约边界。

## 第三层：builder 限额为什么不是附属参数，而是 runtime 行为边界

如果只看 service config，容易误以为 retry/hedging 已经被完全决定了。

但 `ManagedChannelImplBuilder` 里还有一组特别关键的参数：

- `maxRetryAttempts`
- `maxHedgedAttempts`
- `retryBufferSize`
- `perRpcBufferLimit`
- `retryEnabled`
- `defaultServiceConfig`
- `lookUpServiceConfig`

见 `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:191`、`:201`。

这些都说明：

- 重试/试探不是纯粹的服务端/配置问题
- 它还是 channel 侧资源预算与 feature 开关问题

### 为什么这些开关和配额属于 builder 语义

builder 里直接提供：

- `maxRetryAttempts(...)`
- `maxHedgedAttempts(...)`
- `retryBufferSize(...)`
- `perRpcBufferLimit(...)`
- `disableRetry()` / `enableRetry()`
- `defaultServiceConfig(...)`

见 `core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:539`、`:551`、`:566`、`:596`。

这说明 grpc-java 在设计上明确认为：

- retry/hedging 是否可用
- 最多可到什么程度
- 配置 lookup 是否开启
- 默认 config 是什么

这些都不应该只由远端或解析结果决定，而必须留给 channel 拥有者在 build 前表达。

也就是说，builder 不是“给已有逻辑调味”，而是在决定：

- 这条 channel 未来允许出现怎样的 retriable 行为

### 测试怎么证明这些不是小参数

`ManagedChannelImplBuilderTest` 里专门有：

- `maxRetryAttempts()`
- `maxHedgedAttempts()`
- `retryBufferSize()`
- `perRpcBufferLimit()`
- `defaultServiceConfig_*`
- `disableServiceConfigLookUp()`

这些测试，见：

- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:663`
- `core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:720`

这说明这些字段不是“以后也许会用到的可选配置”，而是明确属于 builder 装配语义的一部分。

## 第四层：`ChannelStreamProvider` 为什么是 retry/hedging 真正进入逻辑流的入口

现在终于来到把配置压进调用的切点了。

`ManagedChannelImpl.ChannelStreamProvider.newStream(...)` 是本篇最该记住的桥之一。

它会先看：

- `retryEnabled`

如果没开，就直接走普通 delayed transport `newStream(...)`；如果开了，就从 `CallOptions` 里拿到 `MethodInfo`，再取出：

- `RetryPolicy`
- `HedgingPolicy`

见 `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:461`、`:483`。

这说明 retry/hedging 的真正进入点不是 transport 深处，而是：

- channel 在为这次调用创建逻辑流时，就决定它是不是一条 `RetriableStream`

### 为什么它必须站在这里，而不是更底层

如果这个决定放到 transport 更深处，很多上层语义就会丢掉：

- `MethodInfo`
- `CallOptions`
- `Context`
- builder 预算
- 当前 call 的 tracing/executor 配置

但 `ChannelStreamProvider` 正好站在一个非常合适的位置：

- 上面还能看见调用语义和 config
- 下面已经能把逻辑流压给 delayed transport / real transport

所以 retry/hedging 在这里进入主线，是结构上最自然的选择。

## 第五层：`RetriableStream` 为什么不是多个 substream 的集合，而是一条逻辑流状态机

很多人看到 `RetriableStream` 的第一反应，会是：

- 哦，就是里面放了几个 substream，失败了再开新的

这太低估它了。

类注释一开始就说明：

- 这是一个逻辑 `ClientStream`
- 它本身就是 retriable 的

见 `core/src/main/java/io/grpc/internal/RetriableStream.java:54`。

这说明它不是“容器”，而是：

- **一条逻辑调用流**

substream 只是它内部某个时刻对 transport 的具体投影。

### 它为什么需要 lock、state、inFlightSubStreams、scheduledRetry、scheduledHedging

只看字段就能明白它不是简单列表：

- `lock`
- `state`
- `scheduledRetry`
- `scheduledHedging`
- `inFlightSubStreams`
- `throttle`
- `channelBufferUsed`
- `perRpcBufferLimit`
- `channelBufferLimit`

见 `core/src/main/java/io/grpc/internal/RetriableStream.java:88`。

这些字段共同说明：

- 它要同时管理 substream 派生、提交、取消、退避、并发尝试和预算

也就是说，`RetriableStream` 真正持有的是：

- 一条调用在多次 transport 尝试之间的总体命运

### commit 为什么是理解这条状态机的核心

`commit(...)` 是整篇最关键的动作之一。

它会：

- 只允许一个 winningSubstream 成为真正提交者
- 取消其他非获胜 substream
- 撤掉已调度的 retry / hedging future
- 回收 channel buffer used
- 触发 postCommit

见 `core/src/main/java/io/grpc/internal/RetriableStream.java:155`。

这说明 retry/hedging 不只是“多开几次试试”，而是必须最终被收束成：

- 只有一个真正获胜的 transport 尝试

没有这个 commit，整条逻辑流就无法关闭。

### `createSubstream()` 和 `updateHeaders()` 说明每次尝试不是完全独立匿名的

`createSubstream(...)` 会：

- 增加 in-flight 计数
- 创建 tracer
- 调 `updateHeaders(...)`
- 再调用 `newSubstream(...)`

见 `core/src/main/java/io/grpc/internal/RetriableStream.java:251`、`:286`。

而 `updateHeaders()` 会在 header 里写入：

- `grpc-previous-rpc-attempts`

见 `core/src/main/java/io/grpc/internal/RetriableStream.java:286`。

这说明不同尝试并不是“框架内部偷偷多打一枪”，而是：

- 逻辑上彼此有关联
- 还能在协议元数据上反映“这是第几次尝试”

所以 retry/hedging 是用户不可见但协议可感知的逻辑流机制。

### retry 和 hedging 在这条状态机里的真正差别

`RetriableStream` 构造器就明确区分：

- 只能有 retryPolicy 或 hedgingPolicy 其一
- `isHedging` 会改变后续调度与状态机语义

见 `core/src/main/java/io/grpc/internal/RetriableStream.java:127`。

retry 更像：

- 一次失败后，根据 backoff、status、pushback 决定是否继续派生下一次尝试

hedging 更像：

- 在允许的 delay、非致命状态和预算范围内，提前或并发开出多个尝试，然后由 commit 收束

也就是说，二者共用同一条逻辑流骨架，但状态机推进方向不同。

### throttle 和 buffer 预算为什么不是优化附属件

`RetriableStream` 同时持有：

- `Throttle`
- `channelBufferUsed`
- `perRpcBufferLimit`
- `channelBufferLimit`

见 `core/src/main/java/io/grpc/internal/RetriableStream.java:91`。

这说明重试/试探不是“想开多少次就开多少次”。

它始终受两类硬约束：

- throttle：全局失败密度太高时，不再允许继续激进尝试
- budget：channel 或单 RPC 的缓冲预算不够时，不允许无限制复制 payload 到更多 substream

所以它们不是性能注脚，而是逻辑流是否还能继续演化的边界。

### 测试怎么证明 `RetriableStream` 不是概念体操

`ManagedChannelImplTest.retryBackoffThenChannelShutdown_retryShouldStillHappen_newCallShouldFail()` 很好地证明了：

- retry policy 来自 config
- 调用触发 retry
- 即使 channel shutdown 了，已计划的 retry 还能继续跑到一个收口点
- 新调用则直接失败

见 `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3396`。

`hedgingScheduledThenChannelShutdown_hedgeShouldStillHappen_newCallShouldFail()` 则证明 hedging delay、shutdown 和后续尝试的交互，见 `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3512`。

`RetriableStreamTest` 还进一步覆盖了：

- throttle 如何抑制流
- normal retry
- hedging 多 substream 语义
- per-RPC / channel buffer limit 约束

见：

- `core/src/test/java/io/grpc/internal/RetriableStreamTest.java:1619`
- `core/src/test/java/io/grpc/internal/RetriableStreamTest.java:1903`
- `core/src/test/java/io/grpc/internal/RetriableStreamTest.java:2042`
- `core/src/test/java/io/grpc/internal/RetriableStreamTest.java:2724`

所以这不是概念体操，而是一条被大量测试锁死的真实运行时机制。

## 第六层：retry 和 hedging 到底怎样区别，失败又怎样收口

现在可以把 retry 和 hedging 的差别收束成更清楚的人话。

### retry 关心的是“失败后要不要继续”

retry 的关键问题是：

- 当前失败是不是 retryable
- backoff 多久
- pushback 有没有覆盖默认退避
- previous attempt 该怎样记录
- channel shutdown / transport close 后还能不能继续收尾

所以 retry 的核心是：

- **在失败之后，如何有条件地继续派生下一次尝试**

### hedging 关心的是“在还没完全失败前，要不要提前开更多尝试”

hedging 的关键问题则是：

- hedging delay 多久
- 哪些状态属于 non-fatal
- 当前 budget/throttle 允不允许多开尝试
- 多个 in-flight substream 何时由 commit 统一收束

所以 hedging 的核心是：

- **在尚未完全失败前，如何有条件地并行或延迟展开多个尝试**

### 失败收口为什么一定要回到逻辑流，而不是散在 substream 上

无论 retry 还是 hedging，最终都不能让每个 substream 自己决定整条调用的命运。

必须回到逻辑流这一层统一决定：

- 谁赢
- 谁取消
- 谁继续等
- 谁关闭 master listener
- 预算怎么回收

否则后面会出现最糟糕的局面：

- 多条 substream 分别认为自己在控制调用
- listener 收到重复关闭或重复成功
- buffer 预算无法回收

而 `RetriableStream.commit()`、`drain()`、`postCommit()` 这一套，正是在防止这种分裂。

## 最后把整条 service config / retry / hedging 主线收回来

现在可以把整篇文章的主线收回来了。

如果只记一句最短的人话答案，那就是：

**grpc-java 并不是在 transport 失败后临时补一个“再试一次”的小技巧，而是先把 service config 和 builder 限额翻译成 `MethodInfo`，再由 `ChannelStreamProvider` 把具体调用导向 `RetriableStream`，最终用一条逻辑流状态机统一承载 retry、hedging、pushback、throttle 和 buffer 预算。**

把它拆开，就是四层稳定职责。

### 第一层：`ManagedChannelServiceConfig` / `MethodInfo` 负责把外部策略压成调用快照

- default / service / method 三层匹配
- timeout / waitForReady / message size
- retryPolicy / hedgingPolicy

### 第二层：builder 负责给这套策略设 runtime 边界

- maxRetryAttempts
- maxHedgedAttempts
- retryBufferSize
- perRpcBufferLimit
- enable / disable retry
- default service config / lookup 开关

### 第三层：`ChannelStreamProvider` 负责把具体调用导向 retriable 逻辑流

- 普通 stream 路径
- retriable stream 路径
- `MethodInfo` 到 policy 的读取

### 第四层：`RetriableStream` 负责统一承载 retry / hedging 状态机

- substream 派生
- commit
- drain
- pushback
- throttle
- budget
- close / cancel / listener 收口

## 这篇先立住的，不是配置语法，而是策略如何进入逻辑流

到这里为止，这篇文章故意没有展开：

- xDS 如何重写这套 service config / routing 逻辑
- 生产环境里 retry/hedging 的全部排障套路
- 各种 LB 策略如何与 retry 更深交互
- transport 层细节如何进一步影响每次 substream

不是这些不重要，而是如果不先把 **service config -> MethodInfo -> RetriableStream** 这条线立住，前面第四篇里的发现/选址桥和后面的生产排障层之间，就会一直缺一块非常关键的机制骨架。

所以这篇真正要留下来的心智模型只有一条：

```text
retry/hedging 不是 transport 小技巧
它是外部策略、builder 限额和逻辑流状态机共同作用的结果
```

只要这条线立住，后面再去看 xDS、生产排障或更复杂的服务治理策略，读者就不会再把 retry/hedging 听成几个零散配置项。

而这，也正是 grpc-java 完整卷里必须补上的一层运行时机制地基。