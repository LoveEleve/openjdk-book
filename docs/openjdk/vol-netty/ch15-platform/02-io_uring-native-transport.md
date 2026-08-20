# Ch15-02 io_uring 原生传输：IoUringIoHandler、AbstractIoUringChannel、IoUringSocketChannel

## 先把它和 epoll 的边界钉死：这不是“更快 epoll”

平台专题最容易写歪的地方，就是把不同承载层简单排成一个速度排行榜：NIO、epoll、io_uring，谁更现代谁更快。这个视角对理解源码帮助不大，甚至会直接把真正重要的分层写丢。

前一篇已经说明，epoll 替换的是 Linux 的 I/O 承载层，但它仍然属于一种 readiness-oriented 模型：底层告诉你“这个 fd 现在可以读/可以写/有错误”，然后 Netty 再围绕事件掩码、注册关系和 socket 边界把上层 Channel 主线跑起来。

`io_uring` 不一样。它真正替换的，不只是 epoll 的事件通知器，而是把 I/O 承载层改成了另一套心智模型：**先提交操作，再收取完成。**也就是说，系统不只是告诉你“现在可以写了”，它还会告诉你“你之前提交的那次 read/write/connect/poll 现在完成了，结果是多少，附加标志是什么”。

所以本篇一开始必须把边界讲死：`io_uring` 不是“更快 epoll”，而是把承载层从 readiness-oriented 改成了 completion-oriented。前者更像“现在轮到你做系统调用了”，后者更像“系统调用已经帮你做完，回来领结果”。

这条分层差异直接决定了后面几个类为什么会长成现在这样：

- epoll 时代你更关心的是 event mask、fd 注册和 socket 当前该关注什么；
- io_uring 时代你更关心的是 ring buffer、completion queue、pending operation token，以及某个操作是不是已经提交、完成、取消或还挂着。

也正因为如此，`IoUringIoHandler` 才会成为真正的中心，而 `AbstractIoUringChannel` 也必须显式跟踪大量“已经提交但尚未完成”的 I/O 状态位。它们不是实现噪声，而是 completion-oriented 承载层的直接后果。

所以本篇真正要解决的核心困惑不是“io_uring 怎么更先进”，而是：**Netty 切到 io_uring 以后，替换掉的是提交/完成模型的哪一层，而前面已经写过的 Channel、Pipeline、Promise、ChannelOutboundBuffer、HTTP/2 主线里又有哪些东西仍然保持不变。**

## `IoUringIoHandler`：ring、completion queue 和 pendingOps 才是这个承载层的中心

如果 epoll 专题里真正的核心状态机落在 `AbstractEpollChannel`，那 io_uring 这一篇的中心首先就要前移到 `IoUringIoHandler`。因为它不再只是“帮 EventLoop 看看现在有哪些 fd ready”，而是直接掌控了一整套 ring/completion 世界。

类一开头就把这点暴露得很明显：它持有 `RingBuffer`、已注册的 `IoUringBufferRing`、`registrations`、eventfd、timeout memory、`IovArray`、`MsgHdrMemoryArray`、`PendingOpMap`，以及一组和 wakeup / shutdown 相关的状态，见 `transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringIoHandler.java:51`。

这说明它不只是“事件轮询器”，而是 completion-oriented 承载层的资源与状态中心。对它来说，真正重要的问题不再是“哪个 fd 当前可读可写”，而是：

- ring 里当前挂了多少提交请求；
- completion queue 里回来多少结果；
- 哪些 result 对应 eventfd、ringfd、自定义 token 或某个具体 channel 操作；
- 哪些 buffer ring 已经注册；
- 哪些 pending operation 还挂着，等着 completion 回来。

这种状态中心化是 io_uring 模型的直接体现。因为一旦操作是“先提交、后完成”，系统核心就不再是一个个 fd 当前的 ready 位，而是“你之前提交了哪些操作，它们现在回来什么结果”。

### 初始化阶段已经不是普通 EventLoop 可以类比的

构造器里最能说明这种差异。它会先 `IoUring.ensureAvailability()`，再根据配置决定 `setupFlags`、completion queue 大小、是否注册 iowq worker、是否初始化 buffer rings，然后创建 ring buffer、eventfd、用于 timeout 的 native-order direct buffer、I/O 向量数组和消息头数组，见 `transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringIoHandler.java:93`。

这条初始化链说明，io_uring 承载层从一开始就不是“拿到一个 selector 或 epoll fd 就可以开始跑”的轻量状态。它必须先把提交队列、完成队列、wakeup 机制、timeout 内存和批量 I/O 辅助结构一起准备好，后续所有 channel 的 read/write/connect/poll 都会在这套基础设施上运行。

所以如果要给 `IoUringIoHandler` 一个准确定位，最合适的说法不是“Linux 下的另一个 IoHandler”，而是：**它是 Netty 在 io_uring 模型下的操作提交与完成收割中心。**同时也别忘了，它并没有绕开前面已经建立的统一 I/O 抽象，而是正通过 `IoHandler` 这个接口接入 `SingleThreadIoEventLoop` 那条更高层执行面。

## `run(context)`：EventLoop 现在不只是“等事件”，而是在“等已提交操作的完成结果”

`IoUringIoHandler.run(context)` 是这篇最值得单独讲的一段，因为它直接把 io_uring 和 epoll 的差异压成了一条运行时路径。

在没有完成结果且 `context.canBlock()` 为 true 时，它会确保 eventfd 读请求已提交，然后根据 deadline 算出超时时间，调用 `submitAndWaitWithTimeout(...)`；否则就尝试 `submitAndClearNow(...)` 继续推进已提交队列，见 `transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringIoHandler.java:151`。

这说明 EventLoop 在这里等的不是“哪个 fd ready 了”，而是“已经在 submission queue 里的那些操作，什么时候有 completion queue 结果回来”。这是一个非常本质的差别。

后面的 `processCompletionsAndHandleOverflow(...)` 会反复从 completion queue 里拿结果，并在必要时继续提交新操作；实际每个 completion 则交给 `handle(...)` 去区分 eventfd、ringfd、fast path token 或 slow path token，见 `transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringIoHandler.java:200`、`:280`。

也就是说，这里的主循环不是：

- 等 ready
- 读/写/accept/connect

而是：

- 提交操作
- 等完成
- 处理 completion
- 必要时继续提交下一批

所以如果把 epoll 和 io_uring 两篇并排看，最该记住的一句对照就是：

- epoll 主循环围绕“当前关心哪些事件”组织；
- io_uring 主循环围绕“之前提交了哪些操作、现在回来哪些结果”组织。

这也解释了为什么 `IoUringIoHandler` 必须额外维护 `PendingOpMap`、`eventfdReadSubmitted`、`registeredIoUringBufferRing` 和 `msgHdrMemoryArray` 这些东西。它们不是额外功能，而是 completion-oriented 主循环的基本材料。

## `AbstractIoUringChannel`：completion-oriented 模型逼着 Channel 显式记住“还有哪些 I/O 在路上”

有了 `IoUringIoHandler` 这个中心，再看 `AbstractIoUringChannel` 就会发现，它和 epoll 那篇里的 `AbstractEpollChannel` 最大的差别，并不只是调用了不同 native 方法，而是多了一整套“还有哪些操作尚未完成”的状态位。

类里一开始就定义了 `POLL_IN_SCHEDULED`、`POLL_OUT_SCHEDULED`、`POLL_RDHUP_SCHEDULED`、`WRITE_SCHEDULED`、`READ_SCHEDULED`、`CONNECT_SCHEDULED` 这些位，以及 `numOutstandingWrites`、`numOutstandingReads`、`connectId`、`pollInId`、`pollOutId`、`delayedClose` 等字段，见 `transport-classes-io_uring/src/main/java/io/netty/channel/uring/AbstractIoUringChannel.java:73`。

这套状态在 epoll 那篇里几乎不存在，因为 readiness-oriented 模型下，你主要关心的是“下次等到这个 fd 可读/可写时我要做什么”。而 io_uring 里不一样：你已经可能把 read、write、connect、poll 操作都提交给内核了，此时最重要的不是“要不要发起操作”，而是“这条操作是不是已经在路上、回来没有、能不能取消、完成以后该清哪一位状态”。

这也是为什么 `autoReadCleared()` 这类逻辑在 io_uring 里更显眼。autoRead 从 true 切到 false 后，`AbstractIoUringChannel` 不只是把本地 `readPending` 清掉，还要取消所有 outstanding reads，见 `transport-classes-io_uring/src/main/java/io/netty/channel/uring/AbstractIoUringChannel.java:162`。这说明在 completion-oriented 模型里，关闭某个兴趣点不只是“不再注册下次事件”，还可能意味着“把已经飞出去的操作主动撤回来”。这里的 outstanding I/O 状态位既不是上层 promise 的完成状态，也不是 `ChannelOutboundBuffer` 的待写账本状态；它们描述的是 native 操作本身是否仍在内核侧挂起。

所以 `AbstractIoUringChannel` 的核心价值，不是“另一个平台版 AbstractChannel”，而是：**它把 completion-oriented 模型下那些“已经提交但尚未完成”的 I/O 操作，重新翻译回 Channel 能理解的连接/读/写/关闭状态。**

如果没有这层桥接，上层 `Channel` 主线就根本不知道自己当前到底是“还没提交 write”，还是“write 已经发给内核但还没回来 completion”。

## `IoUringSocketChannel`：zero-copy 和延迟 release 在这里更显眼，不是偶然

`IoUringSocketChannel` 最值得单独讲的，不只是它是 stream socket，而是它让“已提交但未完成”的写路径后果变得更显眼，尤其是 zero-copy 相关分支。

在 `IoUringSocketUnsafe.scheduleWriteSingle(...)` 里，如果平台支持 `send_zc` 且当前 buffer 长度达到 zero-copy 阈值，就会直接构造 `IoUringIoOps.newSendZc(...)` 并提交，而不是走普通写路径，见 `transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringSocketChannel.java:79`。

`scheduleWriteMultiple(...)` 也类似：如果满足 `sendmsg_zc` 条件，它会把多个 `ByteBuf` 收进 `IovArray`，构造消息头，再提交一个 `newSendmsgZc(...)`，见 `transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringSocketChannel.java:109`。

这说明在 io_uring 承载层里，zero-copy 不是外围小优化，而是直接嵌在“怎么提交 write 操作”这一步里的。也正因为如此，后续完成路径就不能再把“write 提交成功”和“消息现在可以 release 了”简单画等号。

`handleWriteCompleteZeroCopy(...)` 把这点说明得非常透。若 completion 标志带着 `IORING_CQE_F_MORE`，说明还会有后续 notification，此时当前写虽然已经有结果，但内核仍可能持有这些 buffer 的引用，所以代码会把对应 `ByteBuf` retain 一次，放进内部 `zcWriteQueue`，等后续 notification 真正到来再 release，见 `transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringSocketChannel.java:191`。

这条延迟 release 边界非常关键，因为它说明 completion-oriented 模型并不自动简化 ownership，反而在 zero-copy 场景下会把“什么时候真的能 release buffer”这件事变得更敏感。提交已经完成、写结果已经回来，并不代表内核已经彻底不再持有用户缓冲区引用。换句话说，这里的延迟 release 不是额外保守，而是对“内核仍持有用户缓冲区引用”这件事实的补偿语义。

所以第四层心智模型应该这样立：**在 io_uring 里，zero-copy 更显眼，不是因为它只是一个平台能力开关，而是因为 completion-oriented 模型把“提交成功”和“缓冲区彻底可释放”分成了更细的阶段。**

这也再次把 ownership 和出站主线接了回来：哪怕平台承载层换了，`ChannelOutboundBuffer`、ByteBuf 引用计数和延迟 release 的语义仍然必须被正确维护。

## 测试真正证明的，是“主线没变，承载模型换了”

虽然这一篇不打算展开所有 io_uring 测试，但几个代表测试已经足够说明问题。

`IoUringEventLoopTest` 证明：

- 任务提交、schedule、graceful shutdown 这些高层语义仍然成立；
- `MultiThreadIoEventLoopGroup + IoUringIoHandler.newFactory()` 仍然是对外入口；
- event loop 不是因为承载层换了就失去 Netty 的执行面语义。

见 `transport-native-io_uring/src/test/java/io/netty/channel/uring/IoUringEventLoopTest.java:36`。

`CombinationOfEpollAndIoUringTest` 则说明 epoll 和 io_uring 可以共存加载，证明这两条平台线不是互斥重写，而是并列承载实现，见 `transport-native-io_uring/src/test/java/io/netty/channel/uring/CombinationOfEpollAndIoUringTest.java:24`。

`IoUringSocketConditionalWritabilityTest` 又把它和前面写过的出站主线接上：即使承载层换成 io_uring，条件可写性测试仍然继续跑，说明 `ChannelOutboundBuffer`、watermark 和 writability 这些上层语义并没有被推翻，只是落在了新的完成模型上，见 `transport-native-io_uring/src/test/java/io/netty/channel/uring/IoUringSocketConditionalWritabilityTest.java:28`。

所以测试给出的总信号很统一：**主线没变，承载模型换了。**

也正因为如此，这一篇最该避免的写法就是把 io_uring 渲染成“更快 epoll”或“全新框架”。源码和测试都在提醒：变化集中在操作提交与完成模型、pending op 状态、zero-copy completion 边界；而前面已经讲过的 Promise、Pipeline、HTTP/2、writability、ownership 主线仍然全部还在。

## 收网：io_uring 替换的是“怎么提交/收割 I/O”，不是“上层主线怎么工作”

现在可以把整条平台对照线收回来了。

- epoll 篇里，真正变化的是 readiness-oriented 承载层：谁被关注、哪些事件 ready、什么时候切换掩码。  
- io_uring 篇里，真正变化的是 completion-oriented 承载层：先提交哪些操作、如何用 ring 和 completion queue 收割结果、哪些操作还在路上、什么时候真正能释放相关缓冲区。  
- `IoUringIoHandler` 负责的是 ring / completion / pendingOps 中心；`AbstractIoUringChannel` 负责的是把 outstanding I/O 状态重新收束成 Channel 可理解的运行时状态；`IoUringSocketChannel` 则把 zero-copy、send_zc/sendmsg_zc 这些 Linux 新能力接进同一条出站主线。  
- 前面已经写过的 `Pipeline`、`Promise`、`ChannelOutboundBuffer`、writability、HTTP/2 API 和连接主链都没有因此被替换；它们只是落在了另一种提交/完成模型上。

所以本篇真正要留下来的结论是：**io_uring 不是“更快 epoll”，而是“另一种 I/O 提交与完成模型”。**

有了这层理解，这一轮平台专题就完整了：你不会再把 epoll 和 io_uring 当成上层主线的替代物，而会知道它们真正替换的只是承载层。至于哪种承载层在你的 Linux、内核版本、zero-copy 能力和 workload 上更合适，那已经不是这篇源码结构专题要替你下的判决，而是下一阶段平台调优和实测验证要回答的问题。