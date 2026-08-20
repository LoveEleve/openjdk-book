# 21-selector-nio/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `SocketChannel`、`ServerSocketChannel` 及 Linux/Unix `SocketChannelImpl`/`ServerSocketChannelImpl` 行为。本文聚焦阻塞/非阻塞模式切换、非阻塞 connect 三阶段、accept/read 行为差异与事件循环语义；JMX 及更高层框架不在本文展开。
> 目标：把“SocketChannel 与阻塞/非阻塞”改写成一篇围绕“同一个通道为什么能从‘线程自己阻塞等数据’切换到‘把等待外包给 Selector’，以及 connect/accept/read 在这种双模式下如何改变语义”的机制文章。

## 1. 读者困惑

- `SocketChannel` 和传统 `Socket` 的根本差异到底是什么，为什么单靠 `configureBlocking(false)` 就能变成事件驱动基石？
- 非阻塞 connect 为什么要分成 `connect()` 和 `finishConnect()` 两段，为什么一次调用不能直接结束？
- `OP_CONNECT` 就绪到底表示“已经连上了”还是“可以去确认了”？
- 非阻塞 `accept()` 返回 null、非阻塞 `read()` 返回 0，这两个“什么都没发生”的结果分别在说什么？
- 为什么已注册到 Selector 的通道不能再切回阻塞模式？

## 2. 一句话顿悟

**SocketChannel 的核心不是“比 Socket 多几个方法”，而是它把一个 fd 的等待语义做成了可切换模式：阻塞模式下，线程自己睡在 connect/read/accept 上；非阻塞模式下，系统调用立刻返回，把等待职责外包给 Selector。`connect` 因为握手天然要跨越时间，所以非阻塞连接被拆成“发起”和“确认”两段；accept/read 在非阻塞下则把“当前没结果”编码成 null/0，让事件循环下一轮再来。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 configureBlocking 的 `O_NONBLOCK` 本质、三态连接状态机、connect/finishConnect 路径、accept/read 非阻塞返回语义与线程模型对比。
- 已把 OP_CONNECT 和 finishConnect 的两段式语义讲出来，这是本篇关键。
- 已把 SocketChannel 细节和 Selector 骨架自然衔接，方向合理。

### 必须重写

- 主要不是内容缺失，而是需要统一风格计划文件与更强的问题驱动开场。
- 阻塞/非阻塞切换要更明显地讲成“等待职责从线程转移到 Selector”的核心变化。
- connect 三阶段要强调“发起成功并不等于握手已完成”，避免被误解成多余 API。
- accept/read 的 null/0 返回要讲成事件循环语义，而不是“奇怪返回值”。

## 4. 理解路径

### 第一节：从“为什么一个 Socket 只加了个开关，就能从 BIO 走到事件驱动”开场

用一连接一线程的 BIO 对照开场。先立住总问题：变化并不在读写 API 名字，而在等待责任从线程自身迁到 Selector / 内核就绪事件。

### 第二节：configureBlocking 为什么改的是 fd 语义而不是 Java 标志位

证据：
- `AbstractSelectableChannel.java:298-313`
- `IOUtil.c:69-76`（`O_NONBLOCK`）

主线：
- 切换不是 Java 层 if 标记，而是改 fd 的 `O_NONBLOCK`。
- 已注册 Selector 的通道禁止切回阻塞，是为了保持选择器模型不被单个阻塞调用破坏。

### 第三节：非阻塞 connect 为什么必须拆成“发起 + 确认”

证据：
- `SocketChannelImpl.java:95-97`：连接状态三态
- `SocketChannelImpl.java:672-710`：`connect`
- `Net.c:317-326`：`EINPROGRESS`
- `SocketChannelImpl.java:757-789`：`finishConnect`

主线：
- 三次握手本来就跨时间，不可能在非阻塞调用里假装瞬间完成。
- connect 在非阻塞下只负责发起并把状态推到 pending；真正确认要靠 `finishConnect`。
- `OP_CONNECT` 表示“连接完成待确认”，不是“你可以跳过 finishConnect”。

### 第四节：accept/read 为什么在非阻塞下要用 null/0 表达“现在还没结果”

证据：
- `ServerSocketChannelImpl.java:274-302`：`accept`
- `SocketChannelImpl.java:336-363`：`read(ByteBuffer)`
- 相关 `IOStatus.normalize` 路径（旧稿已有说明）

主线：
- 非阻塞 accept 返回 null = 当前还没有新连接可接。
- 非阻塞 read 返回 0 = 当前还没有新数据可读，不是 EOF。
- 这两个返回值都在把“继续等”转交给事件循环下一轮处理。

### 第五节：事件循环为什么由 accept → configureBlocking(false) → register → read 串成闭环

主线：
- 服务端拿到 OP_ACCEPT，就 accept 出一个新 socket。
- 新 socket 初始仍是阻塞语义，需要显式切成非阻塞后再注册 OP_READ。
- 后续数据到来再由 selected key 驱动 read/write。
- 这把前两篇 Selector 抽象和本篇通道语义真正接成一条线。

## 5. 失败方案清单

1. 把 `configureBlocking(false)` 只当 Java 标志位切换，不看底层 fd 语义改变。
2. 以为非阻塞 connect 一次调用就该得到最终连接结果。
3. 在 OP_CONNECT 就绪后不调 `finishConnect()` 就开始读写。
4. 把非阻塞 accept 的 null 和 read 的 0 当异常情况处理。
5. 把已注册 Selector 的通道切回阻塞模式，破坏事件循环模型。

## 6. 误解清单

1. SocketChannel 和 Socket 的差别主要在包名和是否能配合 ByteBuffer。
2. 非阻塞 connect 失败返回 false 就等于连接失败。
3. `finishConnect()` 只是历史遗留兜底方法。
4. read 返回 0 和 -1 在非阻塞模式下语义差不多。
5. 事件循环里 accept 出来的新通道天然就是非阻塞的。

## 7. 证据清单

- `AbstractSelectableChannel.java:298-313`
- `IOUtil.c:69-76`
- `SocketChannelImpl.java:95-97`
- `SocketChannelImpl.java:672-710`
- `Net.c:317-326`
- `SocketChannelImpl.java:757-789`
- `ServerSocketChannelImpl.java:274-302`
- `SocketChannelImpl.java:336-363`

## 8. 版本与边界

- 基于 JDK 11 Unix/Linux 路径解释。
- 本篇聚焦 SocketChannel/ServerSocketChannel 的模式语义，不展开上层框架 reactor 线程模型实现。
- 不把 connect 握手细节扩成 TCP 协议教程，只解释到 Java API 语义分裂为止。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么阻塞/非阻塞切换本质上是在改 fd 等待语义 → 非阻塞 connect 为什么分成 connect+finishConnect → accept/read 的 null/0 如何表达‘当前没结果’ → 新接入通道为什么还要再切非阻塞并注册 Selector”。
- 必须把三态连接和事件循环闭环讲清。
- 必须自然收束 21 域并衔接后续域。
