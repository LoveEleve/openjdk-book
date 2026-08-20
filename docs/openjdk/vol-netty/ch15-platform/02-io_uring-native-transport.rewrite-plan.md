# Ch15-02 io_uring 原生传输：IoUringIoHandler、AbstractIoUringChannel、IoUringSocketChannel — rewrite-plan

## 篇章定位

- 核心困惑：在已经有 epoll 原生传输的前提下，Netty 为什么还要再做一套 io_uring 承载层？它和 epoll 的关系到底是“另一种更快 epoll”，还是完全不同的 I/O 模型？`IoUringIoHandler`、`AbstractIoUringChannel`、`IoUringSocketChannel` 分别替换了哪一层？
- 一句话顿悟：io_uring 不是“换个事件掩码 API”，而是把 I/O 承载从“等事件再同步做系统调用”改成“先提交操作，再收取完成结果”的 completion-oriented 模型。Netty 因此把平台核心从 `EpollEventLoop + epoll ops` 改成 `IoUringIoHandler + ringBuffer + pendingOps`，而 `AbstractIoUringChannel` / `IoUringSocketChannel` 负责把多种 outstanding read/write/connect/poll 状态重新接回 `Channel` 主线。
- 文章边界：本篇主讲 `IoUringIoHandler` 的 ring/completion 驱动模型、`AbstractIoUringChannel` 的 outstanding I/O 状态、`IoUringSocketChannel` 的 zero-copy/send_zc 等 Linux 特性，以及它与 `epoll` 的承载层差异；不深入全部 native ring/CQE/SQE C 代码细节，不把 `io_uring` 写成普适性能结论。

## 依赖

### HARD

- Ch15-01 `01-epoll-native-transport.md`：作为平台承载层对照前置。
- Ch5 EventLoop 主线：理解 `IoHandler` / `SingleThreadIoEventLoop` 的分层方向。
- Ch7 出站主线：理解 `ChannelOutboundBuffer`、writability、write/flush。
- Ch4 ownership：理解 zero-copy / retain / delayed release 边界。

### SOFT

- Ch12 HTTP/2：只复用“上层主线不因为承载层变化而重写”的思路。

### NAV

- 后续：`io_uring` buffer ring / zero-copy / send_zc 深入专题。
- 后续：平台对照总结（NIO / epoll / io_uring）。

## 结构设计

### 1. 开场：io_uring 不是“更快 epoll”，而是 completion-oriented 承载层
- 对照 epoll：关注集合 vs 提交操作/收取完成。
- 引出 `IoUringIoHandler` 是真正中心，而不是 EventLoop 外壳。
- 预计 900-1200 字。

### 2. `IoUringIoHandler`：ring buffer、completion queue 与 pendingOps 的中心承载层
- ringBuffer、registered buffer rings、eventfd、timeout memory、iovArray、pendingOps。
- `run(context)` 的节奏：submit/wait -> process completions -> report active I/O time。
- fast path / slow path completion 处理。
- 预计 2200-2800 字。

### 3. `AbstractIoUringChannel`：为什么它要跟踪这么多 outstanding I/O 状态
- pollIn/out/rdhup、write/read/connect scheduled 状态位。
- outstanding reads/writes、多 shot poll in、delayed close、connectPromise/timeout。
- 说明 completion-oriented 模型下，Channel 状态机必须跟踪“已经提交但尚未完成”的操作。
- 预计 2200-2800 字。

### 4. `IoUringSocketChannel`：零拷贝与多写路径为什么更显眼
- `scheduleWriteSingle` / `scheduleWriteMultiple`。
- send_zc / sendmsg_zc 条件与 zero-copy queue。
- `handleWriteCompleteZeroCopy` 为什么需要延迟释放缓冲区。
- 预计 2200-2800 字。

### 5. 测试回读：它真正验证了哪些边界
- `IoUringEventLoopTest`：任务提交、schedule、graceful shutdown。
- `CombinationOfEpollAndIoUringTest`：平台共存能力。
- `IoUringSocketConditionalWritabilityTest`：和出站主线的兼容。
- 预计 1400-1800 字。

### 6. 收网：替换的是提交/完成模型，不是上层主线
- Pipeline、Promise、ChannelOutboundBuffer、HTTP/2 仍然延续前文主线。
- 变化的是 I/O 承载层从 readiness-oriented 变为 completion-oriented。
- 预计 700-1000 字。

## 证据清单

- `transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringIoHandler.java:51-149`
- `transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringIoHandler.java:151-299`
- `transport-classes-io_uring/src/main/java/io/netty/channel/uring/AbstractIoUringChannel.java:73-260`
- `transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringSocketChannel.java:33-220`
- `transport-native-io_uring/src/test/java/io/netty/channel/uring/IoUringEventLoopTest.java:36-111`
- `transport-native-io_uring/src/test/java/io/netty/channel/uring/CombinationOfEpollAndIoUringTest.java:24-37`
- `transport-native-io_uring/src/test/java/io/netty/channel/uring/IoUringSocketConditionalWritabilityTest.java:28-38`

## 误解清单

1. io_uring 只是另一个事件通知器，和 epoll 差不多。
2. 切到 io_uring 后，上层 Promise / ChannelOutboundBuffer / HTTP/2 主线要全部重学。
3. zero-copy send_zc 只是性能优化，不会影响缓冲区 release 边界。
4. outstanding read/write/connect 状态只是实现噪声，不影响 Channel 语义。
5. `IoUringIoHandler` 和 `IoUringSocketChannel` 可以脱离 pendingOps / completion queue 单独理解。

## 边界清单

- 本篇不展开 native C / liburing 细节。
- 本篇不把 io_uring 写成所有 Linux 环境的普适性能结论。
- 本篇不重讲上层主线，只强调哪些没变、哪些换了承载模型。
- 本篇不把 zero-copy 路径写成总是启用，它仍受平台能力和 config 条件约束。

## 深审预警

- [ ] 不把 io_uring 写成“更快 epoll”。
- [ ] 不把 completion-oriented 模型写漏。
- [ ] 不把 zero-copy queue 的延迟 release 边界写漏。
- [ ] 不把 outstanding I/O 状态位写成无关细节。