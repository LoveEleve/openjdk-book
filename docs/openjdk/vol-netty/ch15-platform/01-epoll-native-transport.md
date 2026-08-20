# Ch15-01 epoll 原生传输：EpollEventLoop、AbstractEpollChannel、EpollSocketChannel

## 先把平台专题最容易写歪的一点钉死

一提到 Netty 的 epoll 原生传输，很多人的第一反应都是“这是 Linux 下更快的一套 EventLoop”。这个印象不算全错，但如果只停在这里，后面很容易把整篇写歪。因为平台专题最容易犯的错误，就是一上来就把 epoll 写成“又一套全新的 Netty 主线”，仿佛前面已经写过的 Channel、Pipeline、ChannelOutboundBuffer、Promise、HTTP/2 全都要重新学一遍。

真实情况要克制得多。epoll 原生传输真正替换的，不是这些上层语义，而是**I/O 承载层**：

- 注册和取消事件时，不再走 JDK NIO Selector；
- 事件掩码、文件描述符、Socket 选项、linger/fast-open 这些能力直接落到 Linux 原生语义；
- 连接、关闭、读写的某些边界因此需要换一种更贴近 epoll 的方式处理；
- 但 `Channel`、`Pipeline`、`Promise`、`ChannelOutboundBuffer`、甚至 HTTP/2 的大部分上层逻辑并没有因此换成另一套世界。

所以本篇真正要解决的核心困惑不是“epoll 比 NIO 快多少”，而是：**Netty 在 Linux 平台上，到底替换了哪一层承载逻辑，又保留了哪些上层主线不变。**

只要这条边界先立住，后面看到 `AbstractEpollChannel`、`EpollSocketChannel`、`SO_LINGER`、`tcpFastOpen`、`GlobalEventExecutor` 分支时，就不会再把它们误读成“又一套完全不同的网络框架”，而会明白它们只是把同一条主线落到了另一种底层承载方式上。

## `EpollEventLoop`：在 4.2 里它更像一个兼容壳，而不是全部逻辑中心

这篇里最容易误导人的类，其实是 `EpollEventLoop` 本身。因为名字太像“平台版 NioEventLoop”，很容易让人以为 Linux epoll 的全部逻辑都在这个类里。当前 4.2 源码恰好说明，事情没这么简单。

类注释一上来就写了：`EpollEventLoop` 已经被标记为 deprecated，推荐改用 `SingleThreadIoEventLoop + EpollIoHandler`，见 `transport-classes-epoll/src/main/java/io/netty/channel/epoll/EpollEventLoop.java:32`。这说明在当前实现里，Netty 已经把更多 epoll 逻辑下沉到 `IoHandler` 这条更通用的 I/O 抽象线上，而 `EpollEventLoop` 更像是一个兼容外壳。不过这不等于它已经没有分析价值；在当前分层里，它仍然承担着入口、适配和向旧使用方式过渡的角色。

它现在真正暴露出来的内容也很克制：

- 构造器只是把 parent、executor/threadFactory 和 `IoHandlerFactory` 交给 `SingleThreadIoEventLoop`；
- `registeredChannels()` 和 `registeredChannelsIterator()` 只是把查询转发给 `EpollIoHandler`；
- `setIoRatio()` 已经变成 no-op，并通过日志提醒这段逻辑被移除了。

见 `transport-classes-epoll/src/main/java/io/netty/channel/epoll/EpollEventLoop.java:40`、`:64`、`:77`。

这意味着，如果今天再写 epoll 专题时还把 `EpollEventLoop` 当作 Linux 原生传输的唯一核心点，很容易把当前 4.2 的分层写回旧结构里。更准确的理解应该是：**`EpollEventLoop` 仍然代表 epoll 这一支平台承载层的对外入口之一，但在当前版本里，真正的 I/O 处理逻辑已经更多收束到了 `EpollIoHandler` 和 `SingleThreadIoEventLoop` 组合模型里。**

所以这篇讲 `EpollEventLoop`，重点不是它有多少复杂逻辑，而是它在当前架构里说明了什么趋势：平台承载层在往统一 `IoHandler` 抽象靠拢，而不是每种平台都继续维护一整套完全平行的 EventLoop 实现。

## `AbstractEpollChannel`：平台承载层真正的核心状态机

如果说 `EpollEventLoop` 在当前版本里更像外壳，那 epoll 承载层真正的核心状态机就落在 `AbstractEpollChannel` 上。这个类一开场就能看出它和普通 `AbstractChannel` 的差别：它直接持有 `LinuxSocket`、`IoRegistration`、epoll `ops`、cached local/remote address、以及连接过程里的 promise/timeout 状态，见 `transport-classes-epoll/src/main/java/io/netty/channel/epoll/AbstractEpollChannel.java:66`。

这说明它承担的不是“上层消息怎么传播”，而是“一个 Linux file descriptor 怎样被纳入 Netty 的 Channel 生命周期”。这里最重要的几组状态是：

- `LinuxSocket socket`：承载真正的 native socket 句柄；
- `IoRegistration registration`：表示当前 channel 在 I/O 承载层的注册关系；
- `ops` 与 `initial`：表示当前 epoll 事件掩码状态；
- `connectPromise / connectTimeoutFuture / requestedRemoteAddress`：表示连接尚未完成时的中间状态；
- `local / remote`：缓存地址，避免频繁从 native 层回查。

这些状态放在一起，很清楚地说明：`AbstractEpollChannel` 不是上层 Pipeline 的替代物，而是 Linux socket 在 Netty 主线里的“承载层状态机”。

### epoll 事件掩码不是配置值，而是 runtime state

`setFlag(int flag)` 和 `clearFlag(int flag)` 最值得单独讲。它们不是简单地改一个字段，而是在 `ops` 改变后，如果 channel 已注册，就立即通过 `IoRegistration.submit(ops)` 把新的掩码提交到底层承载层，见 `transport-classes-epoll/src/main/java/io/netty/channel/epoll/AbstractEpollChannel.java:121`。

这说明 epoll `ops` 对 Netty 来说不是“某次初始化时配置一下”的静态属性，而是连接运行时会反复变化的 I/O 关注集合：

- 当前是否还要继续监听读；
- 某次 connect / write 是否需要关注 EPOLLOUT；
- 某些关闭边界是否要取消或重置特定事件掩码。

因此，这一层和前面 `ChannelOutboundBuffer`、writability 的关系是平行而不是重叠的：前者管理的是用户态托管区和出站压力，后者管理的是 Linux 承载层当前到底向 epoll 关注什么事件。这里的 epoll ops 只是 I/O 关注集合，不等于 Channel 在业务语义上的 active、writable 或 promise 完成状态。两个层级都属于“运行时状态”，但观察对象完全不同。

### 关闭时为什么要先处理 promise、timeout 和 deregister

`doClose()` 这段实现特别值得细看。它首先把 `active` 设为 false，并标记 `inputClosedSeenErrorOnRead`；然后依次处理：

- 如果 `connectPromise` 还在，就先 fail；
- 如果 `connectTimeoutFuture` 还在，就取消；
- 如果 channel 已注册，就看当前是不是在 EventLoop 线程里，是的话直接 `doDeregister()`，不是的话把 deregister 动作投递回去；
- 最后无论如何都 `socket.close()`。

见 `transport-classes-epoll/src/main/java/io/netty/channel/epoll/AbstractEpollChannel.java:173`。

这说明平台承载层的关闭绝不是“把 fd close 掉”这么简单。前面主线里和连接相关的 promise、超时、注册关系都得先被收尾，否则上层语义会悬挂。native fd 关闭只是最后一步，前面那些状态清理才是让 Linux 承载层和 Netty 上层主线继续一致的关键。

所以 `AbstractEpollChannel` 最重要的结论是：**它把 Linux socket 的原生状态变化重新收束成 `Channel` 能理解的连接、注册、关闭、掩码和地址状态机。**

## `EpollSocketChannel`：Linux stream socket 在 Netty 主线里的具体落点

`AbstractEpollChannel` 给了承载层骨架，`EpollSocketChannel` 则把 Linux stream socket 的具体语义挂上去。类注释第一句就说明，它是基于 Linux epoll 的 `SocketChannel` 实现，见 `transport-classes-epoll/src/main/java/io/netty/channel/epoll/EpollSocketChannel.java:40`。

最值得注意的是它并没有去重写前面已经讲过的 `Channel`、`Pipeline` 或 `ChannelOutboundBuffer` 主线，而是在更贴近 Linux 特性的地方做文章：

- `EpollSocketChannelConfig` 负责暴露 Linux socket 相关配置；
- `tcpInfo()` 直接读 `TCP_INFO`；
- `tcpFastOpenConnect` 影响 connect 路径；
- `SO_LINGER` 会改变关闭时的执行器边界；
- `tcpMd5SigAddresses` 这类 Linux 能力会和父 `EpollServerSocketChannel` 协同。

也就是说，这一层的变化主要集中在“平台特性能否接入”“连接/关闭/写出边界怎样被重写”，而不是上层消息托管语义本身。

### `doConnect0()`：为什么 fast open 会直接碰 `ChannelOutboundBuffer`

`doConnect0()` 的 fast open 分支特别能说明平台承载层和前面出站主线是怎样接上的。如果当前环境支持 TCP Fast Open，并且配置开启了 `tcpFastOpenConnect`，方法会先拿到 `ChannelOutboundBuffer`，手工调用 `outbound.addFlush()`，再看当前 `outbound.current()` 是否是 `ByteBuf`；如果是，就尝试通过 `doWriteOrSendBytes(...)` 把初始数据连同 connect 一起发出去，成功则直接 `removeBytes(localFlushedAmount)`，见 `transport-classes-epoll/src/main/java/io/netty/channel/epoll/EpollSocketChannel.java:135`。

这段逻辑非常关键，因为它说明 epoll 平台特性并不是绕开了出站托管区，而是反过来直接消费了它。也就是说，Linux fast open 虽然改变了“连接阶段是否能顺便发第一批数据”这个承载层行为，但它仍然尊重前面已经建立好的那条出站主线：数据仍然要从 `ChannelOutboundBuffer` 里拿，写掉多少就从托管区移除多少。

所以平台承载层并不是“另起炉灶”，而是“在同一条出站主线上换一种更贴近 Linux 能力的推进方式”。

### `prepareToClose()`：`SO_LINGER` 为什么会把关闭动作切到 `GlobalEventExecutor`

`EpollSocketChannel` 最容易被忽略、但对平台专题非常关键的一段，是内部 `EpollSocketChannelUnsafe.prepareToClose()`。如果 channel 还开着，并且 `SO_LINGER > 0`，它会先取消 registration，再返回 `GlobalEventExecutor.INSTANCE`；否则返回 null，见 `transport-classes-epoll/src/main/java/io/netty/channel/epoll/EpollSocketChannel.java:157`。

这说明什么？说明 `SO_LINGER` 不是一个纯 socket 配置小细节，它会直接影响关闭动作应该在哪个执行器上收尾。原因也写得很清楚：如果 linger 生效，close 可能会拖得更久；此时如果仍然把它牢牢绑在当前 EventLoop 上，可能导致 eventloop spin 或其他关闭时序问题。这里切到 `GlobalEventExecutor` 不是为了性能，而是为了把可能拖长甚至阻塞的关闭边界从 I/O 主线程隔离出去。

所以这里一定要把边界说清楚：

- 平台特性有时不仅改变 socket 行为；
- 还会反过来影响 Netty 应该用哪个执行器收尾这次 close；
- `GlobalEventExecutor` 在这里不是“随便找个线程”，而是平台关闭边界触发的低频辅助执行面。

这也再次把前面 `EventExecutor` 辅助体系那篇接了回来：平台承载层不是只依赖 native API，它也会依赖 Netty 自己的辅助执行面来完成某些边界收尾。

所以 `SO_LINGER` 在 epoll 专题里一定不能被写成“只是一个 socket 选项”。它是平台能力直接反过来影响 Netty 关闭路径的一个代表案例。

## 平台测试其实在反复验证“上层语义不变，承载层替换”

虽然这篇不准备把 epoll 的测试一条条展开，但测试族本身已经暴露出一个很重要的信号：`transport-native-epoll/src/test/java/io/netty/channel/epoll/` 下有大量关于 socket、datagram、file region、gathering write、shutdown、startTls、tcp md5、manual event loop 的测试。它们共同说明，平台专题真正要验证的不是“epoll 能不能跑起来”，而是**在承载层换成 epoll 之后，上层那些既有语义还能不能继续成立。**

比如：

- `EpollWriteBeforeRegisteredTest` 这类测试关心的是注册前写路径边界；
- `EpollSocketFileRegionTest` 关心的是文件区域写出行为；
- `EpollSocketGatheringWriteTest` 关心的是批量写语义；
- `ManualEventLoopTest` 关心的是 event loop 与 I/O handler 的关系；
- `EpollSocketTcpMd5Test` 则关心 Linux 特定能力怎样接到 channel 语义里。

这说明平台专题最稳的写法不是“epoll 有哪些系统调用”，而是“epoll 替换了承载层以后，哪些上层主线仍然保持，哪些平台边界被单独接进来了”。

也正因为如此，这一篇里对测试的使用方式应该始终克制：把它们当成“承载层替换但主线上层语义仍需成立”的证据，而不是把它们外推成某个平台在所有环境里必然更快或更稳的性能结论。

## 收网：epoll 替换的是 Linux 承载层，不是上层 Channel 主线

现在可以把整条平台主线收回来了。

- `EpollEventLoop` 在当前 4.2 里更多是兼容壳，真正的 I/O 处理逻辑已经往 `SingleThreadIoEventLoop + EpollIoHandler` 靠拢。  
- `AbstractEpollChannel` 是承载层状态机核心：它把 `LinuxSocket`、事件掩码、注册关系、地址缓存、connect/close 状态重新收束成 `Channel` 可理解的运行时状态。  
- `EpollSocketChannel` 则把 Linux stream socket 的能力接进来，包括 `tcpInfo`、fast open、`SO_LINGER`、tcp md5 等，并在必要时直接和 `ChannelOutboundBuffer` 或 `GlobalEventExecutor` 交叉。  
- 前面已经写过的 `Pipeline`、`Promise`、`ChannelOutboundBuffer`、writability、HTTP/2 API 与连接主链并没有因此作废；它们只是落在了另一种底层承载方式上。

所以本篇真正要留下来的结论是：**epoll 原生传输不是再发明一套新的 Netty 主线，而是在 Linux 平台上，用更贴近原生 socket 和事件掩码的承载层替换掉原先的 I/O 落点。**

有了这层理解，下一篇再看 `io_uring` 就不会再把它写成“另一种更快 epoll”了。真正该问的问题始终是同一个：它替换了哪一层承载方式，又保留了哪些上层主线不变。