# Netty Ch2-03 Channel 阻塞 vs 非阻塞 — 正文写作规划

## 前置依赖

### HARD

- Ch1 ByteBuffer 三篇：尤其是 `flip/compact/clear` 与 position/limit 的状态机。
- Ch2-01 `01-read-write.md`：已经建立 `read/write` 返回值、部分进度、`IOStatus.normalize` 与两把锁。
- Ch2-02 `02-connect-accept.md`：已经建立 `connect/finishConnect` 两拍模型，以及 `accept()` 返回 child channel 默认阻塞这一陷阱。

### SOFT

- 传统 `Socket` / `InputStream` 阻塞读写经验：有助于理解 NIO 为什么要保留 `SocketAdaptor` 这样的过渡桥。
- 基本操作系统文件描述符概念：有助于理解 `configureBlocking` 会改变 fd 的行为合同，但正文只讲 JDK 层可证实事实。

### NAV

- Ch3 Selector：非阻塞模式下“什么时候再试”将由 `select()` 接管。
- Netty Ch5 EventLoop：后续会把裸 `Channel + Selector` 收编成单线程事件循环。
- Netty Ch4 ByteBuf：本篇最后会把 `read -> flip -> process -> compact` 桥接到 ByteBuf 如何取消 `flip/compact` 成本。
- Netty Ch7 / Ch10：只导航到后续 pipeline、codec，不提前展开。

## 一句话困惑

同一个 `SocketChannel.read(buf)`，为什么切换一次 `configureBlocking(true/false)` 就会从“线程停住等数据”变成“立即返回 0 自己决定下一步”，而一旦进入真实收发循环，又为什么总离不开 `flip/compact` 这套看起来很别扭的配合？

## 一句话顿悟

阻塞与非阻塞的区别，不在于换了一套 API，而在于谁来承担“等待”的责任：阻塞模式把等待包进 `read/write/connect/accept` 内部，非阻塞模式把等待交给调用方或 Selector；而 ByteBuffer 的 `flip/compact` 正是在这种“部分进度 + 多次重试”的模型里保存现场。

## 理解路径

1. 先从 `configureBlocking` 切换同一个 API 行为切入，解释“谁来等”。
2. 再系统对照阻塞与非阻塞四类动作：`read/write/connect/accept`。
3. 插入 `SocketAdaptor`：解释 JDK 为什么还保留一座从 NIO 回到 BIO 的桥。
4. 最后把抽象模式落到最小收发循环：`read -> flip -> process -> compact` 与非阻塞写剩余进度。
5. 结尾桥接 Selector 和 Netty ByteBuf/EventLoop。

## 失败方案

- 把非阻塞模式理解成“下次立刻再调一次就行”：代码退化成忙轮询。
- 把阻塞/非阻塞理解成“两个不同类”而不是“同一 Channel 的两种等待责任分配”。
- 在 `process` 后直接 `clear()`：一旦消息只处理了一半，未读半包会被丢掉。
- 非阻塞写返回 0 后继续死循环写：CPU 空转，且无法让出线程处理其他连接。
- 误以为 `SocketAdaptor` 是高性能生产方案：忽略它只是兼容层。

## 误解清单

- `configureBlocking(false)` 不是“换一个 Java 包装器”，而是切换 Channel 的阻塞语义。
- 非阻塞 `read()` 返回 0 不等于 EOF，也不等于“马上重试就更好”。
- 阻塞模式不是“更高级”，只是把等待责任放回 API 内部。
- `SocketAdaptor` 不是 NIO 的推荐终态，而是对旧 `Socket` 代码的兼容桥。
- `compact()` 不是“清空 Buffer”，而是把未消费的数据前移，为下一轮追加留空间。
- `clear()` 只适用于当前 Buffer 内容已经全部处理完的情况。

## 字数预算

- 开场困惑与前情回顾：700-1000 字
- `configureBlocking` 与等待责任：1300-1700 字
- 阻塞/非阻塞的完整行为对照：1600-2200 字
- `SocketAdaptor` 兼容桥：1000-1400 字
- 最小收发循环与 `flip/compact`：1600-2200 字
- 误解澄清与总图回收：900-1300 字

## 目标结构

1. 同一个 API，为什么能活成两种模型
2. `configureBlocking`：切换的不是方法名，而是谁来等
3. 四类动作的阻塞/非阻塞对照：`read/write/connect/accept`
4. `SocketAdaptor`：JDK 给旧世界留的过渡桥
5. 最小收发循环：`read -> flip -> process -> compact` 和非阻塞写剩余
6. 收网：Selector 与 Netty 接手等待责任

## 证据清单

写作时重新核对当前 JDK 11 源码：

- `java/nio/channels/spi/AbstractSelectableChannel.java:282-313`：`isBlocking`、`configureBlocking` 与 `nonBlocking` 标志位。
- `sun/nio/ch/SocketChannelImpl.java:535-550`：`implConfigureBlocking` 最终调用 `IOUtil.configureBlocking(fd, block)`。
- `sun/nio/ch/SocketChannelImpl.java:300-367`：`read()` 在阻塞/非阻塞下共用同一 API，但返回值语义不同。
- `sun/nio/ch/SocketChannelImpl.java:410-529`：`write()` 与 `sendOutOfBandData()` 的阻塞/非阻塞路径。
- `sun/nio/ch/SocketChannelImpl.java:672-795`：`connect()` / `finishConnect()` 的等待责任差异。
- `sun/nio/ch/ServerSocketChannelImpl.java:274-324`：`accept()` 返回值与 child 默认阻塞。
- `sun/nio/ch/SocketAdaptor.java:83-139`：超时连接如何临时切到非阻塞并用 `pollConnected + finishConnect` 模拟传统 `Socket.connect`。
- `sun/nio/ch/SocketAdaptor.java:186-218`：`SocketInputStream` 如何通过 `pollRead` + `sc.read(bb)` 提供超时阻塞读语义。
- `sun/nio/ch/ChannelInputStream.java:47-108`：`ReadableByteChannel` 如何被包装成 `InputStream`。

## 边界清单

- 本篇基于 JDK 11 `java.base` NIO 实现，不外推到所有平台细节。
- 不把 `IOUtil.configureBlocking` 的 native 实现细节写死成某个平台唯一行为；正文只写 Java 层可验证合同。
- 不把 `SocketAdaptor` 写成性能推荐方案，只解释其兼容意义。
- 不提前展开 Selector 实现细节、epoll bug 修复和 Netty EventLoop 机制，只做导航桥接。

## 深审清单

- [ ] 不把阻塞/非阻塞误写成两套不同 API 家族
- [ ] 明确“等待责任”是本篇主线，而不是 OS 细节
- [ ] 不把 `SocketAdaptor` 说成自旋忙等；要按当前 JDK 11 源码描述其 `pollRead/pollConnected` 行为
- [ ] 明确 `accept()` 新 child 默认阻塞是上一节已建立的事实，这里只回收不重复展开过深
- [ ] 明确 `compact()` 与 `clear()` 的分工，不能混写
- [ ] 明确非阻塞写返回 0 后应保留 remaining，而不是原地死循环
- [ ] 桥接 Selector / Netty 时只做导航，不提前透支后文
