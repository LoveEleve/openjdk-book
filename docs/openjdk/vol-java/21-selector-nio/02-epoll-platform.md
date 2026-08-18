# 02. epoll 实现与平台分层 — EPollSelectorImpl、native 三调用、与 select 对比

> **前置依赖**: [21-selector-nio/01 — Selector 抽象与选择机制](01-selector-mechanism.md)(骨架、selectedKeys、wakeup)
> → **后续**: [21-selector-nio/03 — SocketChannel 与阻塞/非阻塞](03-socketchannel-blocking.md)
> 关联: 内部卷 01-os(平台层 fd 语义);域 19 BufferChannel(就绪后的数据读写)

## Selector.open() 在 linux 上是什么

上一篇看了共享骨架 `SelectorImpl`——平台层只实现一个"内核等待"的 `doSelect`。这一篇看 linux 上这个 doSelect 的实体: `EPollSelectorImpl` 怎么包装 epoll 的三个系统调用、事件表为什么在内核、水平触发与边缘触发的差别、以及 wakeup 的自管道在 epoll 下怎么落地。

## 1. "linux 上的 Selector 是什么" — EPollSelectorImpl

### 1.1 工厂链

`Selector.open()` 在 linux 上的完整链路:

```
Selector.open()                                   // Selector.java:294
  └─ SelectorProvider.provider()                  // :171(SPI 加载)
  └─ DefaultSelectorProvider.create()             // linux 层
      └─ return new EPollSelectorProvider();      // DefaultSelectorProvider.java:45
  └─ EPollSelectorProvider.openSelector()         // EPollSelectorProvider.java:35
      └─ return new EPollSelectorImpl(this);
```

`EPollSelectorImpl`(`EPollSelectorImpl.java:50`,`extends SelectorImpl`)就是 linux 的答案。

### 1.2 三个关键字段

| 字段 | 源码 | 作用 |
|------|------|------|
| `epfd` | `:56`,构造 `EPoll.create()`(`:79`) | **epoll 实例 fd**(内核事件表的句柄) |
| `pollArrayAddress` | `:59`,`EPoll.allocatePollArray(NUM_EPOLLEVENTS)`(`:80`) | `epoll_wait` 结果写入的 native 内存区 |
| `fd0`/`fd1` | `:62-63`,`IOUtil.makePipe`(`:83-85`) | socketpair 唤醒管道(§4) |

`NUM_EPOLLEVENTS = min(IOUtil.fdLimit(), 1024)`(`:53`)——单次 wait 最多取回的事件数。

### 1.3 非 linux 回退

unix 通用层是 `PollSelectorImpl`(`unix/classes/sun/nio/ch/PollSelectorImpl.java`),用 `poll(2)` 系统调用——语义与 epoll 一致,实现不同(内核每次全量扫描)。

关键设计(斜体):*"平台分层"= 共享骨架(SelectorImpl)+ 平台实现(EPoll/Poll)——DefaultSelectorProvider 是工厂。面试"Selector.open 在 linux 是什么": EPollSelectorImpl;面试"平台怎么选": DefaultSelectorProvider 按平台编译(java.base 的 linux/unix 目录分层)。*

## 2. "epoll 三调用" — create/ctl/wait

### 2.1 三个 native 封装

`EPoll`(`linux/classes/sun/nio/ch/EPoll.java`,122 行)是 epoll 的纯 native 封装:

| 方法 | 源码 | 作用 |
|------|------|------|
| `create()` | `:112` | `epoll_create`——建 epoll 实例 |
| `ctl(epfd, opcode, fd, events)` | `:114` | `epoll_ctl`——事件表增删改 |
| `wait(epfd, pollAddress, numfds, timeout)` | `:116` | `epoll_wait`——等待就绪,结果写入 pollAddress 内存区 |

- opcode 常量(`:58-60`): `EPOLL_CTL_ADD = 1`、`EPOLL_CTL_DEL = 2`、`EPOLL_CTL_MOD = 3`
- 事件常量(`:63-64`): `EPOLLIN = 0x1`、`EPOLLOUT = 0x4`
- 事件数组布局(`:53-55`): `SIZEOF_EPOLLEVENT = eventSize()`、`OFFSETOF_EVENTS = eventsOffset()`、`OFFSETOF_FD = dataOffset()`——三个 native 方法(`:106/108/110`)在类加载时探测 `struct epoll_event` 的布局,`getEvent`(`:86`)/`getDescriptor`(`:93`)/`getEvents`(`:100`)据此从内存区读出事件

### 2.2 何时调 ctl: processUpdateQueue

`doSelect` 每次先处理兴趣变更队列 `processUpdateQueue`(`EPollSelectorImpl.java:143-175`,截取,逐字):

```java
// EPollSelectorImpl.java:157-170(截取,逐字)
                    if (newEvents != registeredEvents) {
                        if (newEvents == 0) {
                            // remove from epoll
                            EPoll.ctl(epfd, EPOLL_CTL_DEL, fd, 0);
                        } else {
                            if (registeredEvents == 0) {
                                // add to epoll
                                EPoll.ctl(epfd, EPOLL_CTL_ADD, fd, newEvents);
                            } else {
                                // modify events
                                EPoll.ctl(epfd, EPOLL_CTL_MOD, fd, newEvents);
                            }
                        }
                        ski.registeredEvents(newEvents);
                    }
```

- 新注册(registeredEvents == 0)→ **ADD**(`:164`)
- 兴趣变化 → **MOD**(`:167`)
- 兴趣清空(newEvents == 0)→ **DEL**(`:160`)
- `doSelect` 开头先 `processUpdateQueue()`(`:113`)——把兴趣变更同步进内核再等待

面试"epoll vs select/poll": select 每次调用**全量拷贝 fd 集合 + 内核线性扫描 O(n)**,且受 `FD_SETSIZE`(1024)上限约束;epoll 的事件表**在内核**(create/ctl 维护),就绪靠回调挂入就绪队列,`epoll_wait` 只取就绪事件——复杂度 O(就绪事件数),与总连接数无关。

关键设计(斜体):*epoll 三调用的本质: create 建表、ctl 维护事件表、wait 等待就绪——**事件表在内核**(O(1) 就绪查询,无需每次全量拷贝 fd 集合)。面试"epoll vs select/poll": select 每次拷全量 fd 集合 O(n)+ 上限 1024;epoll 内核事件表 + 回调,wait 只拿就绪事件。*

## 3. "水平触发" — JDK 的默认模式

### 3.1 源码事实

`EPoll` 的事件常量只有 `EPOLLIN`/`EPOLLOUT`(`EPoll.java:63-64`),另有 `EPOLLONESHOT`(`:67`)——**没有 `EPOLLET`**。epoll 默认(不设 EPOLLET)就是水平触发: 数据没读完,`epoll_wait` 每次都返回该 fd 就绪,直到读完/清空。

对比边缘触发(EPOLLET 标志): 只在**状态变化**时通知一次,应用必须一次把数据读尽,否则可能漏事件。JDK 用水平触发(`EPoll.java` 无 EPOLLET 常量): 行为与 select/poll 的水平语义一致,应用每次读到读尽为止,不担心漏事件。

### 3.2 面试

"水平 vs 边缘"是 epoll 经典题: 水平 = 持续通知(简单安全,JDK 默认);边缘 = 变化通知(高效但易漏,需一次读尽)。"为什么 Netty 用边缘触发": 减少重复系统调用(配合一次读尽),代价是处理复杂。

关键设计(斜体):*"水平 vs 边缘"是 epoll 经典题——水平 = 持续通知(简单安全),边缘 = 变化通知(高效但易漏)。JDK 的 EPoll.java 没有 EPOLLET 常量,默认水平;Netty 用边缘触发优化,面试讲清两种模式 + JDK 的取舍即可。*

## 4. "唤醒机制" — 自管道

### 4.1 构造: 自管道一端注册进 epoll

`EPollSelectorImpl` 构造时 `IOUtil.makePipe` 建一对管道 fd(`:83-85`,native 实现是 `pipe(2)`,`unix/native/libnio/ch/IOUtil.c:87-89`),把**读端 fd0 注册 EPOLLIN**(`:93`,01 篇 §4.2 已展示逐字块)。

### 4.2 wakeup 与清除

- `wakeup()`: 向写端 fd1 写一个字节(`:254`,`IOUtil.write1`)→ fd0 可读 → 正在阻塞的 `epoll_wait` 返回
- `doSelect` 的 `processEvents` 识别出 fd0(`:191-192`)→ 标记 interrupted
- `clearInterrupt`(`:262-267`): `IOUtil.drain(fd0)` 把管道读空,interruptTriggered 复位——下一次 select 才能再次被唤醒
- 关闭: `implClose`(`:210-223`)关 epfd/fd0/fd1,先置 interruptTriggered 阻止后续 wakeup

面试"wakeup 原理": 自管道写入——向 fd1 写一字节,fd0 可读事件让 epoll_wait 自然返回,不依赖信号。

关键设计(斜体):*"自管道"是经典唤醒技巧——不依赖信号(信号处理复杂易错),用 fd 事件让 epoll 自然醒来。面试"wakeup 原理": 管道写入 + epoll 就绪返回;生产: 优雅停机/动态注册都要先 wakeup 解除阻塞。*

跨层标注: [内部卷 01-os——fd 就绪语义与平台层;域 19 BufferChannel——就绪事件触发后,读写的载体是 Buffer]

## 核心悬念

选择器能"知道"哪个通道就绪了——但**通道本身怎么读写**?`SocketChannel` 的阻塞/非阻塞切换、connect 的三次握手、accept 的连接建立——BIO 和 NIO 的线程模型差异在哪?——下一篇: SocketChannel 与阻塞/非阻塞。

> → [21-selector-nio/03 — SocketChannel 与阻塞/非阻塞](03-socketchannel-blocking.md)
