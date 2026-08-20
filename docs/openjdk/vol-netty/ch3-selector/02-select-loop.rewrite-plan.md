# Netty Ch3-02 单线程 select 循环 — 正文写作规划

## 前置依赖

### HARD

- Ch3-01 `01-selector-model.md`：已经建立 register、三套 key 集合、`SelectionKey`、四种事件、`selectedKeys`、`wakeup/cancel` 的基本语义。
- Ch2-01 `01-read-write.md`：已经建立 `read/write` 返回值与部分进度。
- Ch2-02 `02-connect-accept.md`：已经建立 `accept()` 返回 child channel 默认阻塞，以及 `finishConnect()` 的两拍收尾。
- Ch2-03 `03-blocking-vs-nonblocking.md`：已经建立 `read -> flip -> process -> compact` 与等待责任上浮。
- Ch1 ByteBuffer 三篇：attachment 中缓冲区状态与 `flip/compact/clear` 分工。

### SOFT

- Reactor 模式的术语背景：本篇会给最小解释，但不做模式史回顾。
- 旧 BIO 线程-per-connection 经验：有助于对照单线程 select loop 的价值。

### NAV

- Ch3-03 Selector 工程陷阱：本篇会提到 `OP_WRITE` 和 cancel/wakeup 的坑，但空轮询 bug 等工程问题留后文。
- Netty Ch5 EventLoop：后续把这里的裸 select loop 收编进 `NioEventLoop`。
- Netty Ch4 ByteBuf：本篇会回扣 `flip/compact` 的痛点，作为后续 ByteBuf 动机之一。

## 一句话困惑

知道了 Selector 能告诉你“哪个 Channel 现在值得继续”，但一个真实的单线程 NIO 服务端循环到底怎么写，为什么写着写着就会踩到 `OP_WRITE`、`cancel`、`iter.remove()` 这些看似零碎却会致命的细节？

## 一句话顿悟

单线程 select 循环的核心不是 `while(true)`，而是把“阻塞等待 → 遍历就绪 key → 按事件分流 → 消费后清理”四步做成一个严格闭环；只要任何一步偷懒，NIO 就会从多路复用退化成忙轮询或脏结果集。

## 理解路径

1. 先从“一个线程怎么同时管理多个连接”切入，立起 select loop 骨架。
2. 再拆 Accept / Read / Connect / Write 四类分支在循环里各自承担什么责任。
3. 专门讲 `OP_WRITE`：为什么它不是默认常驻兴趣位。
4. 再讲 `iter.remove()` 与 `cancel()`：为什么结果消费与注销清理都不是自动收尾。
5. 最后给一版最小可运行骨架，并桥接 Netty EventLoop。

## 失败方案

- 每轮先遍历全部 Channel 再决定谁可读：CPU 被“非阻塞忙轮询”吞掉。
- 收到 Read 后直接 `clear()`：半包丢失，协议状态断裂。
- 没有待发数据也一直挂 `OP_WRITE`：select 长期不阻塞，循环退化为空转。
- 遍历 `selectedKeys` 不 `iter.remove()`：结果集消费不收尾，旧 key 反复参与后续逻辑。
- `close()` 之后假设 key 已经同步消失：忽略 cancel 的异步清理窗口。

## 误解清单

- 单线程 select loop 不是“一个线程做所有工作”，而是“一个线程统一调度 I/O 等待时机”。
- `select()` 返回后拿到的不是消息，而是“哪些 key 现在值得继续处理”。
- `OP_ACCEPT` 分支不只接新连接，还必须立刻把 child channel 调成非阻塞并注册后续兴趣。
- `OP_WRITE` 不是“我要写数据时默认就应该一直开着”的常驻位。
- `iter.remove()` 清的是结果集，不是注销注册关系。
- `key.cancel()` / `channel.close()` 不是同步立刻把 key 从 Selector 里抹掉。

## 字数预算

- 开场困惑与 Reactor 骨架：900-1300 字
- select loop 四步闭环：1500-1900 字
- Accept / Read / Connect / Write 分支：1800-2400 字
- `OP_WRITE` 按需注册：1200-1700 字
- `iter.remove()` 与 cancel 异步清理：1200-1700 字
- 最小服务端骨架与 Netty 桥接：900-1300 字

## 目标结构

1. 一个线程怎样管住所有连接
2. select loop 的四步闭环：等、取、分流、清理
3. Accept / Read / Connect / Write 在循环里各做什么
4. `OP_WRITE`：为什么必须按需注册、写完即删
5. `iter.remove()` 与 cancel：结果消费和异步注销
6. 收网：这是 Netty EventLoop 的最小前身

## 证据清单

写作时重新核对当前 JDK 11 源码：

- `Selector.java:105-165`：selection 对 selected-key set 的增加/更新语义，以及 `select/select(timeout)/selectNow` 的区别。
- `Selector.java:216-224`：interest set 变更只影响下一轮 selection，key 在集合里不等于仍然有效。
- `SelectorImpl.java:133-168`：`select/selectNow` 到 `doSelect` 的入口。
- `SelectorImpl.java:244-304`：`processDeregisterQueue` 与 `processReadyEvents`。
- `AbstractSelectableChannel.java:200-223`：已注册 key 的 register 更新路径。
- `AbstractSelectableChannel.java:241-258`：channel close 会 cancel 所有 key。
- `SelectionKeyImpl.java:95-124`：`interestOps` / `interestOpsOr` / `interestOpsAnd` 的更新。
- `SocketChannelImpl.java:336-367`、`:447-500`：read/write 返回值与非阻塞部分进度。
- `ServerSocketChannelImpl.java:274-311`：accept 返回 child channel 与默认阻塞。
- `SocketChannel.java:397-445`：`finishConnect()` 的 API 合同，供 `OP_CONNECT` 分支回扣。

## 边界清单

- 本篇基于 JDK 11 Java 层 Selector/Channel 行为与最小 Reactor 骨架，不把 epoll/kqueue 差异写成抽象规范。
- 不把单线程 select loop 写成“所有业务都必须单线程处理”的通用架构结论；这里只讨论 I/O 等待和最小服务端骨架。
- 不把 Netty 的 ChannelPipeline、任务队列、selector rebuild 等后续实现提前写成本篇事实。
- `OP_WRITE` 的危险性按常见 socket 场景解释，不写成数学上的“永远就绪”。

## 深审清单

- [ ] 不把 `iter.remove()` 误写成注销 key；它只消费 selectedKeys 结果集
- [ ] 明确 child channel 在 `accept()` 后仍需 `configureBlocking(false)`
- [ ] `OP_CONNECT` 只回扣最小必要语义，不抢走 Ch2 主线
- [ ] 不把 `cancel()` 清理时机写成立即同步删除
- [ ] 明确 `channel.close()` 会导致 key cancel，但真正从 selector 集合移除发生在后续 selection
- [ ] `OP_WRITE` 只写“按需注册、写完即删”，不夸大成所有平台都永久就绪
- [ ] 桥接 Netty 时只做导航，不提前展开 EventLoop 内部实现
