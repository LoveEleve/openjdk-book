# 域 21: Selector 与网络 NIO — 知识规划

> 源码路径: java.base/share/classes/java/nio/channels/{Selector,SelectionKey,SelectableChannel,SocketChannel,ServerSocketChannel,DatagramChannel,Asynchronous*}.java + share/classes/sun/nio/ch/{SelectorImpl,SelectorProviderImpl,SocketChannelImpl,ServerSocketChannelImpl}.java + **linux/classes/sun/nio/ch/{EPollSelectorImpl,EPoll,EPollSelectorProvider}** + unix/classes/sun/nio/ch/{PollSelectorImpl,PollSelectorProvider}
> 源码量: ~45 文件 / ~25,000 行 | 非巨型域
> 写作层: Layer 4(前置: 域 17 IO、19 Buffer/Channel;IO 多路复用)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| channels/Selector.java (633) | **选择器抽象**: open()、select()(418)/select(timeout)/selectNow、selectedKeys()(344)/keys()、wakeup()(609)——多路复用入口 | High |
| channels/SelectionKey.java (466) | **就绪键**: interestOps(168)/readyOps、事件常量(OP_READ=1<<0 296/OP_WRITE/OP_CONNECT/OP_ACCEPT)、channel()/selector()/attach | High |
| channels/SelectableChannel.java (319) | **可注册通道**: configureBlocking(295)/isBlocking/register(257,注册到 Selector)——**注册与选择事件** | High |
| share sun/nio/ch/SelectorImpl.java | **选择骨架**: doSelect 抽象(111)、select(long)(133)/select()(140,委托 doSelect)、processReadyEvents(279)、wakeup | High |
| linux/classes/sun/nio/ch/EPollSelectorImpl.java | **epoll 实现**: extends SelectorImpl、epfd(56,EPoll.create())、socketpair 唤醒注册(93,EPOLL_CTL_ADD fd0)、doSelect(102:EPoll.wait)、事件增删改(160-167:DEL/ADD/MOD) | High |
| linux/classes/sun/nio/ch/EPoll.java | **native 封装**: create(112)/ctl(114,opcode+fd+events)/wait(116,epfd+pollAddress+numfds+timeout)/eventSize(106)/dataOffset(110) | High |
| unix/classes/sun/nio/ch/PollSelectorImpl | **poll 回退实现**(非 linux 平台) | Medium |
| linux/DefaultSelectorProvider.java | **平台选择**: linux → EPollSelectorProvider | Medium |
| share sun/nio/ch/SocketChannelImpl.java | **套接字通道**: read(336,阻塞时 doBlock 循环 351-354 IOStatus.INTERRUPTED 重试)/write(448)/connect(672)/finishConnect/isConnected(603) | High |
| share sun/nio/ch/ServerSocketChannelImpl.java | **监听通道**: accept(274,accept0 native 543)/bind | High |
| channels/Asynchronous* | **异步通道族**: AsynchronousSocketChannel/ServerSocketChannel(JDK7+,异步回调/CompletionHandler) | Low |

*11 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | Selector 三件套与选择流程 | 4 (Selector/SelectionKey/SelectableChannel/SelectorImpl) | 面试必考(多路复用原理) |
| P1 | epoll 实现 | 3 (EPollSelectorImpl/EPoll/Provider) | 面试必考(epoll vs select vs poll);生产(Netty 底层) |
| P1 | SocketChannel 阻塞/非阻塞 | 2 (SocketChannelImpl/ServerSocketChannelImpl) | 面试常问(BIO vs NIO) |
| P2 | 平台分层 | 2 (DefaultSelectorProvider/Poll) | 面试偶尔(平台差异) |
| P3 | 异步通道族 | 5 | 面试低频(Netty 用自研) |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | 选择机制(register/select/readyOps) | 面试必考(selector 怎么知道可读) |
| 🔴 Deep | epoll 原理 | 面试必考(epoll 三调用/水平 vs 边缘触发/与 select 对比) |
| 🔴 Deep | 阻塞 vs 非阻塞 | 面试常问(BIO 线程模型 vs NIO 单线程多路复用) |
| 🟡 Working | 平台分层 | 面试偶尔 |
| 🟢 Surface | 异步通道 | 使用层(Netty 自实现) |

## 04 聚类

### 依赖图(域内)
```
Selector(抽象) ←── SelectorImpl(骨架) ←── EPollSelectorImpl(linux)
SelectionKey(就绪键) ←── SelectableChannel.register
SocketChannelImpl ←── Selector(注册后多路复用)
ServerSocketChannelImpl(accept) ←── Selector(OP_ACCEPT)
平台: DefaultSelectorProvider → EPollSelectorProvider/PollSelectorProvider
```

### 教学顺序与文章拆分(3 篇)

1. **Selector 抽象与选择机制** — 三件套、register/interestOps、select 流程(doSelect/processReadyEvents)、wakeup、selectedKeys 消费
2. **epoll 实现与平台分层** — EPollSelectorImpl、EPoll native 三调用(create/ctl/wait)、socketpair 唤醒、水平触发、与 select/poll 对比、平台分层
3. **SocketChannel 与阻塞/非阻塞** — SocketChannelImpl read/write(doBlock)、connect/finishConnect、accept、阻塞 vs 非阻塞 vs 异步、BIO/NIO 线程模型

> 前置: 域 17/19(流与 Buffer)。跨层: epoll 系统调用(内部卷 01-os/内核);Channel 的 fd(内部卷 01-os)
