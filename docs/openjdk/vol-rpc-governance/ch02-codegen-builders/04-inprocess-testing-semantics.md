# 为什么官方不鼓励 mock stub：grpc-java 的 InProcess Transport、Testing 与真实测试语义

> 本文基于 `grpc-java v1.83.1` 当前源码。前几篇已经把 grpc-java 的主干运行时、codegen 装配桥、builder 装配桥和消息对象桥立住了。本文继续补完整卷里的集成层：为什么 grpc-java 官方不鼓励 mock stub，而是专门提供 `InProcessChannelBuilder`、`InProcessServerBuilder`、`InProcessTransport` 和 `GrpcCleanupRule` 这一整套路径。重点放在 InProcess 如何保留真实调用主线、去掉 socket/TCP 噪音，以及测试中的资源收尾为什么也属于 grpc 运行时纪律；不展开 JUnit 教程，不把 InProcess 夸成完全等价网络 transport。

## 为什么官方宁可给你 InProcess，也不鼓励你直接 mock stub

很多人第一次给 grpc-java 写测试时，直觉都会走向一条看起来最省事的路：

- 把 stub mock 掉
- 设一个返回值
- 调一下业务代码
- 断言结果

这条路短、快、没有网络，也不需要起 server。表面上看，它几乎满足了“测试应该简单”的一切诱惑。

但 grpc-java 官方对这件事的态度非常明确，甚至可以说相当强硬。

`examples/README.md` 里直接写了两条：

- 不允许覆盖 client stub
- 不支持 mock grpc-java 里的 final 方法

而且紧接着就给出判断：

- mock client stub 会带来一种 **false sense of security**

见 `examples/README.md:134`、`:141`。

这不是测试风格上的洁癖，而是在提醒一个更根本的问题：

- grpc-java 最值钱的那部分，从来不是“方法最后返回了什么”
- 而是调用主线本身：
  - stub
  - builder
  - method descriptor
  - marshaller
  - message framing
  - status / headers / deadline / cancellation
  - client/server dispatch

如果你直接 mock stub，等于从入口就把这一整条链掐断了。

于是你测到的其实不是：

- grpc-java 真实会怎么跑

而是：

- 你自己 hand-crafted 的那个假返回值世界会怎么跑

这就是为什么 README 里进一步点名了 mock stub 测不到的 bug：

- request 传 null
- 忘记 close
- header 非法
- 忽略 deadline
- 忽略 cancellation

见 `examples/README.md:146`。

换句话说，mock stub 最大的问题不是“不够优雅”，而是：

- 它绕开了 grpc-java 真正最复杂、也最容易出问题的运行时路径

所以本文真正要回答的问题不是：

- InProcess 好不好用
- `GrpcCleanupRule` 方不方便

而是：

**为什么 grpc-java 官方认为，测试里最该保留的不是“网络环境”，而是“真实调用语义”；而 InProcess 恰恰就是用来保留这条语义主线的。**

## 先看失败方案：为什么测试不能只追求“快和省事”

### 失败方案一：mock stub 最方便，所以足够好

这是最常见的误区。

因为从测试作者角度看，mock stub 的吸引力太大了：

- 不用起 server
- 不用建 channel
- 不用处理资源收尾
- 想让它返回什么就返回什么

但问题恰恰出在“想让它返回什么就返回什么”。

你可以很轻松地伪造：

- 一个不存在的正常响应
- 一个没有 headers/trailers 约束的成功路径
- 一个完全绕过 deadline / cancellation 的调用
- 一个从来不会经过 marshaller、message framing、method lookup 的假链路

所以表面上它测试的是“你的业务调用了 stub”，实际上它完全没有测试：

- grpc-java 真正的调用链有没有被正确用到

README 之所以说这会带来假安全感，就是因为这类测试太容易：

- 测试通过
- 真实系统却在运行时失败

并且失败点往往正落在你 mock 掉的那一层。

### 失败方案二：InProcess 只是“假的 transport”，没有真实意义

另一种常见误解，是反过来轻视 InProcess。

因为名字太容易让人觉得：

- 既然不走 socket/TCP
- 那就是个假的 transport
- 最多算测试玩具

这正好错了。

InProcess 的价值不是“模拟网络”，而是：

- **保留 grpc-java 运行时主线的大部分语义，同时删除真实网络噪音**

也就是说，它删掉的是：

- socket
- TCP
- 真正的远端进程

但它保留的是：

- builder 入口
- stub 入口
- method descriptor
- marshaller / streamRequest / parseRequest
- client/server stream 交互
- status / method lookup / cancellation 等运行时边界

这不是玩具，而是一种刻意设计出来的“真实语义近似桥”。

### 失败方案三：测试收尾只是 JUnit 小事，不属于 grpc 运行时

还有一种特别容易被忽视的问题，是测试资源清理。

很多人会觉得：

- channel/server 用完了关掉就行
- 这是测试框架的小事
- 跟 grpc-java 主体没什么关系

这个判断同样太轻了。

因为 grpc-java 的 channel 和 server 本来就是有生命周期的资源：

- `shutdown()`
- `shutdownNow()`
- `awaitTermination()`

这些动作本来就属于 runtime 纪律，而不是测试世界额外加上去的礼仪。

所以 `GrpcCleanupRule` 的真正价值不是“少写几行 finally”，而是：

- 把 grpc 运行时本来就要求的资源收尾纪律，在测试层显式固化下来

如果这一层不讲，测试就会天然倾向于：

- 只关心断言结果，不关心资源生命周期

而这恰恰会把很多真实问题藏起来。

### 失败方案四：InProcess 和真实网络 transport 完全等价

当然，也不能从一个极端跳到另一个极端。

InProcess 很重要，但它并不是“100% 等价于真实网络 transport”。

例如 builder 层就已经暴露出一些明确差异：

- `useTransportSecurity()` / `usePlaintext()` 在 InProcess 上是 no-op
- keepalive 相关配置在 InProcess 上也是 no-op
- 某些测试友好的行为会被显式打开，比如传播 cause 到 status

见：

- `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:139`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:155`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:224`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:208`

所以本篇必须同时守住两个边界：

- 不能把 InProcess 贬成玩具
- 也不能把它夸成完全等价网络 transport

## 先立最小总图：InProcess 在 grpc-java 体系里处于什么位置

如果先不抠细节，最值得先记住的是：InProcess 不是在主线外面另起一套测试体系，而是嵌在 grpc-java 运行时装配桥里的一个特殊分支。

```text
*Grpc / Stub / ImplBase
  -> InProcessChannelBuilder / InProcessServerBuilder
  -> InProcessTransport
  -> Client/Server runtime mainline
  -> no socket / no TCP / same process
```

如果换成人话，这条线回答的是三件事。

第一，**InProcess 仍然沿用正常入口**。

- 客户端仍然从 Stub 出发
- 服务端仍然从 `ImplBase` / `bindService()` 出发
- 仍然走 builder 装配桥

第二，**它把 transport 换成了 in-process transport**。

- 没有真实网络
- 没有 socket/TCP 噪音
- 但仍然有 stream、message、status、method lookup 这些语义

第三，**它在测试层把资源收尾显式制度化**。

- `GrpcCleanupRule` 保证 channel / server 生命周期不会被测试作者随手糊过去

所以 InProcess 的真实位置不是“测试附录”，而是：

- **grpc-java 集成层里专门为了保留主线语义而准备的一条测试/本地运行装配桥**

先有这张图，后面再去看具体 builder 和 transport，读者才不会把它误听成“没有网络的简化版 stub mock”。

## 第一层：examples/README 其实已经把 grpc-java 的测试哲学写死了

这层虽然不是源码类，但在方法论里属于很重要的“上层装配桥说明”。

`examples/README.md` 对测试路径的态度非常鲜明：

- 不鼓励 mock client stub
- 推荐使用 `InProcessTransport`
- 说清楚它为什么比 mock 更接近现实

见 `examples/README.md:134`。

这段文字真正值钱的，不是推荐用什么 API，而是它直接暴露了 grpc-java 作者如何定义“好的测试路径”：

- 好测试不是最少代码
- 好测试是尽量保留真实 grpc runtime 语义

所以 README 明确说：

- 用 mock stub 很难重现 grpc 客户端库的复杂性
- 更好的方式是用真实 stub + InProcessChannel / InProcessServer

见：

- `examples/README.md:141`
- `examples/README.md:154`

这说明 InProcess 的存在，不是偶然补的测试玩具，而是 grpc-java 官方认可的运行时近似桥。

而 `GrpcCleanupRule` 被一起推荐出来，也表明：

- 测试路径里不仅要保留真实调用语义，还要保留资源收尾纪律

见 `examples/README.md:164`。

所以从卷内结构上说，README 这层不是附属材料，而是当前集成层主题最重要的“设计立场证据”之一。

## 第二层：`InProcessChannelBuilder` 为什么不是普通 builder 别名

如果只从名字看，`InProcessChannelBuilder` 很容易被误解成：

- `ManagedChannelBuilder` 的测试版别名

但实现细看就会发现，它不是单纯换了个名字，而是在装配层做了一整套有意识的取舍。

### 它仍然保留了 builder 入口桥

`forName()`、`forTarget()`、`forAddress()` 这些静态入口依然存在，见 `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:43`、`:61`。

而内部仍然是通过：

- `ManagedChannelImplBuilder`

来完成装配，只不过塞进去的是自己的 `InProcessChannelTransportFactoryBuilder`，见 `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:109`。

这说明什么？

说明 InProcess 并没有绕过前面 builder 篇已经建立的第二座装配桥，而是：

- **沿用同一套 builder/runtime 结构，只在 transport factory 这一层换成 in-process 分支**

这就是它不是测试玩具、而是装配桥分支的最好证据。

### 它会主动修改一些默认运行时行为

构造器里还能看到两条很有意思的调整：

- 关闭 started/finished RPC stats 记录
- 在特定条件下禁用 retry 相关统计行为

见 `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:117`。

这说明 InProcess 不是“原样照抄普通 channel”，而是在保留主线语义的前提下，主动针对测试/本地进程场景修剪掉一些不必要或不合适的行为。

也就是说，它是：

- 有取舍地保留真实语义
- 不是盲目模拟整个网络 transport

### 为什么 TLS / plaintext / keepalive 在这里是 no-op

`useTransportSecurity()`、`usePlaintext()`、keepalive 相关方法在 InProcess builder 上都是 no-op，见：

- `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:139`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:155`

这说明 InProcess 的设计哲学很明确：

- 保留 grpc 调用主线与状态语义
- 去掉只有网络 transport 才真正需要的边界

所以它不是“网络 transport 的完整复制品”，而是一种：

- 只保留当前测试最该验证的 grpc 语义层
- 删掉 socket/TCP/安全协商噪音

### `propagateCauseWithStatus(true)` 为什么体现的是“测试友好偏置”，而不是“更接近生产”

`propagateCauseWithStatus(true)` 这类配置非常能说明 InProcess 的测试取向，见 `inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:224`。

真实网络 transport 往往会剥掉 cause，避免泄漏内部信息、语言细节或不该跨进程传播的实现内部状态；InProcess 则允许在测试场景里把 cause 继续往前传，目的是：

- 提高失败可见性
- 让测试更容易定位真正原因

这里必须把边界讲得更尖锐一点：

- **这不是说 InProcess 比生产 transport“更真实”**
- 恰恰相反，它说明 InProcess 在某些边界上是**故意偏向测试调试体验**的

也就是说，InProcess 的价值不是“逐位复制生产网络行为”，而是：

- 主调用语义尽量真实
- 调试可见性在局部地方有意识地更强

所以这一类能力应被理解成：

- 有利于测试定位问题的偏置设计
- 不是“更接近生产 transport”的证据

## 第三层：`InProcessServerBuilder` 为什么不是普通 server builder 别名

服务端这一边也一样。

`InProcessServerBuilder` 不是另写一套 server runtime，而是内部继续复用：

- `ServerImplBuilder`

见 `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:44`、`:130`。

这说明服务端 InProcess 路径也在坚持同一个原则：

- 不绕开 grpc-java 主线
- 而是在 builder 装配桥上换一个 in-process 的 transport server 分支

### 它为什么要禁用 handshake timeout 和 stats

构造器里可以直接看到两条典型取舍：

- 关闭 started/finished RPC stats
- 把 handshake timeout 设成极大值，避免无意义线程创建

见 `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:132`。

这说明服务端 InProcess 也不是机械复制，而是在保留核心调用语义的前提下，删掉：

- 对测试没有价值的网络协商噪音
- 可能污染测试环境的线程副作用

### 它为什么还支持 `deadlineTicker()`、`scheduledExecutorService()`、`maxInboundMetadataSize()`

更关键的是，InProcess server 并没有把所有东西都简化掉。

它还显式保留：

- `deadlineTicker()`
- `scheduledExecutorService()`
- `maxInboundMetadataSize()`

见：

- `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:157`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:177`
- `inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:195`

这说明 InProcess 要保留的不是“真实网络效果”，而是：

- 真实调用语义
- 真实 deadline/metadata 等逻辑边界

尤其 `deadlineTicker()` 的存在特别说明：

- 它就是为了让测试场景下还能真实驱动 deadline 行为，而不是把超时机制整个抹掉

所以 InProcess builder 的设计重点不是“更简单”，而是：

- **更适合验证 grpc 运行时语义，又不被真实网络噪音打断**

## 第四层：`InProcessTransport` 到底保留了哪些“真实语义”

现在来到最容易被误解的一层：

- InProcessTransport

如果只看名字，它很容易被轻视成“本地短路 transport”。

但 `InProcessTransportTest` 正好能说明它不是“直接跳过 grpc”，而是保留了相当多真实语义。

### 它仍然保留了 method lookup / status 语义

`methodNotFound()` 这组测试很关键：

- 就算在 InProcess 场景下，找不到方法仍然会走 `UNIMPLEMENTED`

见 `inprocess/src/test/java/io/grpc/inprocess/InProcessTransportTest.java:153`。

这说明 InProcess 并不是“同进程就直接调方法”，而是仍然经过 grpc-java 的正常服务端方法查找和错误语义路径。

### 它仍然保留了 message 对象桥

`basicStreamInProcess()` 更直接说明：

- client 侧写的是 `methodDescriptor.streamRequest(...)`
- server 侧收到后还会 `methodDescriptor.parseRequest(...)`
- response 同样走 `streamResponse(...)` 与 `parseResponse(...)`

见 `inprocess/src/test/java/io/grpc/inprocess/InProcessTransportTest.java:193`。

这说明 InProcess 并没有把前一篇消息对象桥抹掉；相反，它保留了：

- 对象 -> marshaller -> stream message
- stream message -> marshaller parse -> 对象

这也是为什么它比 mock stub 更接近真实语义。

### 它还保留了状态与错误传播边界

`causeShouldBePropagatedWithStatus()` 说明，在测试场景下还可以通过 `propagateCauseWithStatus(true)` 保留更强的错误可见性，见 `inprocess/src/test/java/io/grpc/inprocess/InProcessTransportTest.java:116`。

这再次说明 InProcess 不是什么都短路掉了；它仍然有：

- status
- cause
- method lookup
- stream listener
- message tracing size

只是这些语义发生在同进程、无 socket/TCP 噪音的环境里。

但反过来也必须讲清楚它**没有**在帮你验证什么。InProcess 明显会弱化或直接跳过：

- 真实 socket/TCP 行为
- TLS/ALPN/证书链与 authority 校验路径
- keepalive 与真实连接存活语义
- 真实网络抖动、分片、时延、内核缓冲、副本链路问题
- 跨进程/跨主机的安全和可见性边界

也就是说，它非常适合验证：

- grpc-java 主线语义有没有走通
- status、method lookup、message parse、deadline/cancel 等有没有被正确使用

但它并不适合替代：

- 网络 transport 差异验证
- TLS/keepalive 语义验证
- 真实链路上的性能和故障注入验证

所以第四层更精确的收束应该是：

- InProcessTransport 保留的不是“网络现实”，而是“grpc runtime 语义现实”；
- 而它主动删掉的，恰恰是网络级问题本身。

## 第五层：`GrpcCleanupRule` 为什么不是测试语法糖，而是运行时纪律的测试版封装

最后必须把 `GrpcCleanupRule` 单独讲一下。

如果不讲它，这一篇会很容易被误读成：

- “InProcess 更适合测试，顺便有个 rule 好用。”

这太轻了。

### 它真正封装的是 grpc 资源生命周期

`GrpcCleanupRule` 的类注释直接写得很清楚：

- 注册 grpc 资源
- 测试结束时自动 release
- 如果资源无法成功 release，测试应该失败

见 `testing/src/main/java/io/grpc/testing/GrpcCleanupRule.java:37`。

这说明它封装的不是 JUnit 语法，而是：

- channel/server 本来就有的生命周期纪律

`register(ManagedChannel)` 和 `register(Server)` 把资源登记起来，见 `testing/src/main/java/io/grpc/testing/GrpcCleanupRule.java:118`、`:133`。

`after()` 里则先尝试：

- graceful cleanup
- await termination

如果超时或异常，再做：

- force cleanup

见 `testing/src/main/java/io/grpc/testing/GrpcCleanupRule.java:165`。

也就是说，它在测试层重现的是：

- 先优雅关停
- 再等待释放
- 不行再强制收尾

这和前面几篇里 channel/server 的运行时纪律完全是一脉相承的。

### 为什么这属于“完整卷必须补的集成层”

方法论文档专门强调：

- 不能只讲主干怎么跑
- 还要讲真实生态里怎么被装起来、怎么被用起来

`GrpcCleanupRule` 和 InProcess 正好就在这条线上：

- 它们不是主干运行时
- 但它们决定了用户在真实测试与开发场景里，如何安全、真实地接近主干运行时

所以这一层如果缺失，读者会出现一个非常典型的断裂：

- 我懂了 grpc-java 主线
- 但我还是不知道“怎样在自己的测试里最真实地验证这条主线”

这正是集成层缺失时最常见的问题。

## 最后把整条 InProcess / Testing 主线收回来

现在可以把整篇文章的主线收回来了。

如果只记一句最短的人话答案，那就是：

**grpc-java 官方不鼓励 mock stub，不是因为它偏好某种测试风格，而是因为 mock 会直接绕开最关键的运行时语义；InProcess 路径的价值，在于它保留 builder、stub、marshaller、stream、status、method lookup、deadline/cancellation 等真实 grpc 主线，只删掉 socket/TCP 噪音；`GrpcCleanupRule` 则把资源收尾纪律显式固化到测试层。**

把它拆开，就是三层非常稳定的分工。

### 第一层：InProcess builder 负责“把主线语义带进同进程场景”

- 沿用 `ManagedChannelImplBuilder` / `ServerImplBuilder`
- 只对网络特有语义做 no-op 或测试友好调整

### 第二层：InProcessTransport 负责“保留真实 grpc 运行时语义”

- method lookup
- status/cause
- message parse/serialize
- stream listener
- message size tracing

### 第三层：GrpcCleanupRule 负责“把资源生命周期纪律带进测试”

- graceful cleanup
- await termination
- force cleanup fallback

## 这篇先立住的，不是测试技巧，而是 grpc-java 的测试语义桥

到这里为止，这篇文章故意没有展开：

- JUnit rule 的更细用法
- 各种 mocking 工具的优缺点对比
- 所有 InProcess 内部优化实现
- 真实网络 transport 与 InProcess 的完整能力矩阵

不是这些不重要，而是如果不先把 **InProcess / Testing 作为集成层桥接** 立住，前面的 codegen、builder、消息桥和客户端/服务端主线，在开发者真实最常接触的测试环境里就仍然是断开的。

所以这篇真正要留下来的心智模型只有一条：

```text
InProcess 不是 fake grpc
它是去掉网络噪音后，尽量保留 grpc 真实语义的测试/集成桥
```

只要这条线立住，后面再去看 InProcess 上的 deadline、cancellation、status、message framing、resource cleanup 或服务诊断能力，读者就不会再把它误当成“测试附录”。

而这，也正是 grpc-java 完整卷里必须补上的一层集成地基。