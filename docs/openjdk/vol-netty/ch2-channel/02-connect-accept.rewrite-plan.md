# Netty Ch2-02 Channel 连接与接受 — 正文写作规划

## 前置依赖

### HARD

- Ch1 ByteBuffer 三篇：理解 Buffer 的状态保存，但本篇不再展开其细节。
- Ch2-01 `01-read-write.md`：已经建立 `SocketChannel` 的读写返回值、阻塞/非阻塞的基本语义，以及同向互斥/异向并行的锁边界。

### SOFT

- TCP 三次握手与监听队列的基础概念：本篇会给最小解释，但不展开协议细节。
- `ServerSocket` / `Socket` 传统阻塞模型：有助于理解 NIO 为什么保留兼容性折中。

### NAV

- Ch2-03 blocking/nonblocking：本篇建立 connect/accept 的模式差异，下一篇系统收束两种模式的全局区别。
- Ch3 Selector：`OP_CONNECT` / `OP_ACCEPT` 如何接管“何时再试”的判断。
- Netty Ch5 EventLoop：后续用单线程事件循环托管这些就绪事件。
- Netty Ch9 Bootstrap：后续解释 `Bootstrap.connect()` 和 `ServerBootstrap` 如何抹平 JDK 原生 API 的粗糙边界。

## 一句话困惑

为什么同样是 NIO Channel，客户端 `connect()` 在非阻塞模式下会拆成两拍，而服务端 `accept()` 返回的新 `SocketChannel` 却又默认是阻塞的？

## 一句话顿悟

NIO 把“发起连接”和“确认连接完成”拆开，是为了让客户端不必在三次握手期间卡住线程；但 `accept()` 返回阻塞子 Channel 则是向旧 `Socket` 兼容的历史折中，所以真正的事件驱动框架必须在两端分别补上 `finishConnect()` 和 `configureBlocking(false)`。

## 理解路径

1. 先从一个非阻塞客户端困惑切入：`connect()` 为什么会返回 `false`。
2. 再解释两拍模型：第一拍发起，第二拍确认，为什么不能跳过 `finishConnect()`。
3. 然后补上 `bind()`：客户端可选，服务端必须，用它把本地地址和监听状态接进来。
4. 再切到 `accept()`：为什么 server 自己可以非阻塞，但收进来的子 Channel 却默认阻塞。
5. 最后把这几个折中收成一张图，并桥接 Selector / Netty Bootstrap。

## 失败方案

- 把非阻塞 `connect()` 当成同步成功：跳过 `finishConnect()`，后续读写会在“连接尚未完成”这一层直接失败。
- `connect()` 返回 `false` 后立刻忙等反复调用：把非阻塞编程重新写成 CPU 空转轮询。
- 以为 server 设成非阻塞后，`accept()` 出来的 child channel 也会自动非阻塞：注册 Selector 时才发现不满足前提。
- 把客户端 `bind()` 当成必须步骤：混淆了“显式绑定本地地址”和“让 OS 自动分配临时端口”。

## 误解清单

- `connect(false)` 不是失败，而是“连接正在进行”。
- `finishConnect()` 不是多余确认，而是非阻塞连接的第二拍。
- `finishConnect()` 在非阻塞模式下可能继续返回 `false`，它不是一次必定收敛的 API。
- `ServerSocketChannel.accept()` 在非阻塞模式下无连接时返回 `null`，不是抛异常。
- `accept()` 返回的新 `SocketChannel` 默认是阻塞模式，与监听 Channel 当前模式无关。
- 服务端 `bind()` 是进入监听前提；客户端 `bind()` 只是可选地固定本地地址与端口。

## 字数预算

- 开场困惑与前情回顾：800-1200 字
- `connect()` 第一拍：1400-1800 字
- `finishConnect()` 第二拍：1200-1600 字
- `bind()` 的客户端/服务端分叉：1000-1400 字
- `accept()` 的阻塞陷阱：1600-2200 字
- 误解澄清与总图回收：1000-1400 字

## 目标结构

1. 一个连接为什么会拆成两拍（开场 + 前情回顾）
2. `connect()`：发起，不等于完成
3. `finishConnect()`：确认，不等于总会立刻成功
4. `bind()`：客户端可选，服务端必须
5. `accept()`：监听可以非阻塞，子 Channel 却默认阻塞
6. 收网：Selector 和 Netty 为什么必须接管这几个拐点

## 证据清单

写作时重新核对当前 JDK 11 源码：

- `java/nio/channels/SocketChannel.java:327-445`：`connect()` / `finishConnect()` 的 API 语义与阻塞/非阻塞合同。
- `sun/nio/ch/SocketChannelImpl.java:572-599`：`bind()` 如何进入 `Net.bind`。
- `sun/nio/ch/SocketChannelImpl.java:621-698`：`beginConnect` / `connect()` 的状态迁移与 `Net.connect`。
- `sun/nio/ch/SocketChannelImpl.java:718-795`：`finishConnect()` 的 pending 检查与 `checkConnect`。
- `sun/nio/ch/ServerSocketChannelImpl.java:215-229`：服务端 `bind()` 之后进入 `Net.listen`。
- `sun/nio/ch/ServerSocketChannelImpl.java:274-311`：`accept()` 的返回值与 `IOUtil.configureBlocking(newfd, true)`。
- `java/nio/channels/ServerSocketChannel.java:228-274`：`accept()` 在非阻塞模式下返回 `null`、子 Channel 默认阻塞的 API 合同。
- `sun/nio/ch/Net.java:445-483`：`bind()` / `connect()` 进入 native 层的桥。

## 边界清单

- 本篇基于 JDK 11 `java.base` 的 NIO 实现；不外推到所有 JDK 版本与所有平台细节。
- `Net.connect` / `checkConnect` 的最终完成依赖 native 实现与 OS socket 语义；正文只写 JDK 这一层可证实的行为合同。
- 不把 `OP_CONNECT` / `OP_ACCEPT` 的事件循环细节提前写成既定事实，具体放到 Ch3 Selector。
- 不把 Netty 的 `Bootstrap` / `ServerBootstrap` 实现提前写成本篇机制证据，只作为后续桥接。

## 深审清单

- [ ] 不把 `connect()` 返回 `false` 写成失败
- [ ] 明确 `finishConnect()` 的前提是 `ST_CONNECTIONPENDING`
- [ ] 不把 `checkConnect` 解释成某个单一 OS 调用细节，除非当前源码能直接证明
- [ ] 明确 `accept()` 在非阻塞模式下可能返回 `null`
- [ ] 明确 `IOUtil.configureBlocking(newfd, true)` 作用在新接入 socket 上，而不是监听 socket 上
- [ ] 不把“默认阻塞”误写成“永远不能改成非阻塞”
- [ ] 桥接 Selector / Netty 时只做导航，不提前透支后文
