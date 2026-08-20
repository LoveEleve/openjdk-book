# Ch15-01 epoll 原生传输：EpollEventLoop、AbstractEpollChannel、EpollSocketChannel — rewrite-plan

## 篇章定位

- 核心困惑：前面 EventLoop、Channel、write/flush、HTTP/2 主线都已经以“抽象层”讲清楚了，但切到 Linux 原生传输时，Netty 为什么还要再搞一套 `epoll` 族实现？`EpollEventLoop`、`AbstractEpollChannel`、`EpollSocketChannel` 到底是怎样把 Linux epoll、socket 标志位和 Netty 的通道主线接起来的？
- 一句话顿悟：Netty 的 epoll 原生传输不是重写一遍整个 Channel 框架，而是把“注册、事件掩码、连接/关闭、读写和 Linux socket 选项”替换成更贴近 epoll 的 I/O 承载层，同时尽量保持上层 `Channel`、`Pipeline`、`ChannelOutboundBuffer`、Promise 和 write/flush 主线不变。它是“承载层替换”，不是“上层语义重写”。
- 文章边界：本篇主讲 `EpollEventLoop` 的定位、`AbstractEpollChannel` 的注册/关闭/掩码管理、`EpollSocketChannel` 的连接/写出/linger 关闭边界，以及为什么 4.2 已经把更多逻辑下沉到 `EpollIoHandler` / `SingleThreadIoEventLoop`；不展开 JNI C 代码全部细节，不展开每个 SocketOption。

## 依赖

### HARD

- Ch5 EventLoop 主线：理解 EventLoop/IoEventLoop 的调度模型。
- Ch2 Channel / Ch7 出站主线：理解 Channel 状态、托管区、write/flush 和 Promise。
- Ch4 ownership：理解关闭/失败路径上的 release 边界。

### SOFT

- Ch12 HTTP/2：只复用“上层协议主线不因为承载层变化而被重写”的思路。

### NAV

- 下一篇：io_uring 原生传输。
- 后续：EpollIoHandler 深入或 JNI/native 细节专题。

## 结构设计

### 1. 开场：epoll 不是“另一个 EventLoop 名字”，而是 Linux 原生承载层
- 说明它不是重写 Channel 语义，而是重写 I/O 承载方式。
- 引出 `EpollEventLoop` 已在 4.2 退化成 `SingleThreadIoEventLoop + EpollIoHandler` 包装层这一事实。
- 预计 900-1200 字。

### 2. `EpollEventLoop`：为什么它在 4.2 更像兼容壳
- deprecated 原因与 `SingleThreadIoEventLoop + EpollIoHandler` 替代关系。
- `registeredChannels()` / `registeredChannelsIterator()` 的落点。
- `setIoRatio()` 已被移除，说明什么变化。
- 预计 1200-1600 字。

### 3. `AbstractEpollChannel`：epoll 承载层的核心状态机
- `LinuxSocket`、`IoRegistration`、`ops`、`active`、cached local/remote address。
- `setFlag/clearFlag` 如何把 epoll 事件掩码与 channel 生命周期接起来。
- `doClose()` 为什么要处理 connectPromise、timeout、deregister 和跨 executor close。
- 预计 2200-2800 字。

### 4. `EpollSocketChannel`：Linux stream socket 在 Netty 里的具体落点
- config、tcpInfo、tcpFastOpen、md5Sig、parent/child 构造路径。
- `doConnect0()` 与 fast open 的特殊分支。
- `prepareToClose()` 为什么在 `SO_LINGER > 0` 时要切到 `GlobalEventExecutor`。
- 预计 2200-2800 字。

### 5. 测试回读：平台承载层到底验证了哪些边界
- EventLoop / config / socket close / file region / gathering write / startTls / tcp md5 等测试族说明承载层范围很广。
- 挑核心测试说明“语义不变，承载层替换”。
- 预计 1600-2200 字。

### 6. 收网：epoll 替换的是底层承载，不是上层主线
- 连接、写出、promise、pipeline、HTTP/2 仍沿用前文主线。
- 变化的是事件掩码、socket 能力、关闭边界和 Linux 特性接入。
- 桥到 io_uring 对照篇。
- 预计 700-1000 字。

## 证据清单

- `transport-classes-epoll/src/main/java/io/netty/channel/epoll/EpollEventLoop.java:32-89`
- `transport-classes-epoll/src/main/java/io/netty/channel/epoll/AbstractEpollChannel.java:66-240`
- `transport-classes-epoll/src/main/java/io/netty/channel/epoll/EpollSocketChannel.java:40-185`
- `transport-native-epoll/src/test/java/io/netty/channel/epoll/EpollEventLoopTest.java`
- `transport-native-epoll/src/test/java/io/netty/channel/epoll/EpollSocketChannelConfigTest.java`
- `transport-native-epoll/src/test/java/io/netty/channel/epoll/EpollWriteBeforeRegisteredTest.java`
- `transport-native-epoll/src/test/java/io/netty/channel/epoll/ManualEventLoopTest.java`

## 误解清单

1. epoll 原生传输等于重写整个 Netty 上层主线。
2. `EpollEventLoop` 仍然是全部 epoll 逻辑真正所在。
3. 切到 epoll 以后，`ChannelOutboundBuffer`、Promise、Pipeline 的行为逻辑都要重学。
4. `SO_LINGER` 关闭只是一个 socket 选项，不会影响执行器与关闭路径。

## 边界清单

- 本篇不展开全部 JNI/native C 细节。
- 本篇不把 epoll 写成“天然更快”的平台结论，只讲承载层和能力边界。
- 本篇不枚举所有 socket option，只抓 tcpInfo / fast open / linger / md5 等代表点。
- 本篇不重讲上层主线，只强调哪些没变、哪些换了承载层。

## 深审预警

- [ ] 不把 epoll 原生传输写成上层主线重写。
- [ ] 不把 `EpollEventLoop` 误写成 4.2 的唯一核心实现点。
- [ ] 不把 `prepareToClose()` 的 `GlobalEventExecutor` 分支写漏，它是 close 边界关键点。
- [ ] 不把平台特性写成普适性能结论。