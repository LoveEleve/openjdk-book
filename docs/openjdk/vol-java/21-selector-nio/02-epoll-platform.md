# 02. epoll 实现与平台分层 — EPollSelectorImpl、native 三调用、与 select 对比

> 本文基于 JDK 11 Linux 平台 `EPollSelectorImpl`、`EPoll` 封装与 `SelectorProvider` 分层。本文聚焦 create/ctl/wait 三调用、事件表在内核、水平触发默认选择、自管道唤醒与 provider 分层；socket/channel 行为留到下一篇。本文讨论的是 JDK 11 Linux 上的 Selector 平台实现，不把这里的 epoll 路径、自管道唤醒和水平触发取舍外推成所有平台、所有 NIO 实现都必须遵守的统一规范。
> **前置依赖**：[21-selector-nio/01 — Selector 抽象与选择机制](01-selector-mechanism.md)(骨架、selectedKeys、wakeup)
> **后续**：[21-selector-nio/03 — SocketChannel 与阻塞/非阻塞](03-socketchannel-blocking.md)

## 为什么 Selector 到了 Linux 上,真正值钱的不是 Java API,而是内核里那张事件表

上一篇已经把 Selector 的抽象骨架立住了：通道声明兴趣、选择器统一等待、SelectionKey 承载结果。但如果继续追问一句——`Selector.open()` 到了 Linux 上到底开出了什么?为什么它能让上万连接的等待成本不再和连接总数一比一膨胀?答案其实已经不在 Java 代码表面,而在平台层的 epoll 机制上。

真正改变游戏规则的不是 `select()` 这个方法名,而是 **“谁在维护事件表、谁在筛选就绪项、谁在把阻塞中的等待叫醒”** 这三件事被下沉到了内核。Java 层的 `EPollSelectorImpl` 做的,不是重写一套等待器,而是把 epoll 的 create/ctl/wait 三个系统调用和 Java 的 key/readyOps/selectedKeys 语义焊在一起。

所以这一篇的主线不是 epoll 名词解释,而是沿着这个问题展开: 为什么事件表常驻内核会改变复杂度,为什么 JDK 默认水平触发,以及为什么 `wakeup()` 最终必须被翻译成一个 fd 可读事件,才能把阻塞中的 `epoll_wait` 自然叫醒。

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

## 七、五个最容易混掉的边界：epoll 不是 Java 轮询优化，事件表不在用户态，水平触发不是低级模式，wakeup 不是信号，wait 也不是返回所有 fd 状态

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，epoll 不是 Java 自己把轮询写得更聪明了。真正改变复杂度的，是事件表和就绪队列都下沉进了内核；Java 层只是把这套内核结果翻译回 `SelectionKey` 语义。

第二，所谓“事件表在内核”，也不是一句口号。它直接意味着 `ctl` 维护的是一张常驻内核的兴趣表，`wait` 拿回的是这一刻真正就绪的那些 fd，而不是每次把全量 fd 集合重新搬进内核再扫一遍。

第三，水平触发更不是“比边缘触发低级”。它代表的是另一种默认取舍：重复通知换取更简单、更不容易漏事件的应用语义。JDK 默认站在这里，不是因为不会做边缘触发，而是因为它优先要和 select/poll 的心智保持一致。

第四，`wakeup()` 也不是靠信号或 Java 线程中断把 `epoll_wait` 叫醒。真正起作用的是自管道制造出的一个 fd 可读事件：对 epoll 来说，它醒来的原因仍然是“有事件到了”，只是这个事件是 Selector 自己伪造出来的控制信号。

第五，`epoll_wait` 也不是“把所有 fd 当前状态都返回给你”。它只返回本轮已经就绪的事件项；这正是 epoll 能把总连接数和当前处理成本解耦的关键。如果把它想成状态全量快照，就会看不懂为什么大多数空闲连接几乎不增加 wait 的返回处理成本。

把这五条边界记稳，epoll 这一篇就不会重新塌回“Linux 上的更快 Selector”这种表面印象。它真正讲的是：Java 选择器抽象怎样借 create/ctl/wait 三调用，把等待与就绪维护这件事扎扎实实地下沉到了内核事件表里。

## 收网：Linux 上真正值钱的不是 Java API 名字，而是 epoll 把“谁就绪了”这件事长期留在了内核里

回到开头那个问题，现在已经能看清为什么 Selector 到了 Linux 上之后，真正值钱的不是 `select()` 这个方法名，而是 epoll 这套平台机制。它把“谁被监听”“谁刚就绪”“谁该把阻塞中的等待叫醒”这三件事拆成 create/ctl/wait 三步，并让事件表常驻内核，避免每次等待都从用户态重新搬一份全量 fd 集合进去。

这也把整篇的主线收回来了：

- provider 分层负责把统一 Selector 抽象落到 Linux 的 `EPollSelectorImpl`；
- create/ctl/wait 负责事件表生命周期；
- 水平触发决定默认的就绪通知哲学；
- 自管道 wakeup 则把外部控制动作翻译成 epoll 能看见的可读事件。

把整篇压成一张总图，就是：

```text
epoll 平台层
  → create：建内核事件表
  → ctl：增删改兴趣 fd
  → wait：只返回当前就绪项

JDK 桥接层
  → EPollSelectorImpl 维护 epfd / pollArray / wakeup pipe
  → 把内核事件翻译回 readyOps / selectedKeys

控制路径
  → wakeup 通过自管道制造可读事件
  → 让阻塞中的 epoll_wait 自然返回
```

如果说上一篇解决的是“为什么等待能从每个连接自己的阻塞点上被集中剥离出来”，这一篇真正补上的就是：**这件事在 Linux 上具体是怎样靠内核事件表被做成 O(就绪项) 语义的。** 下一篇就会把镜头从等待器转回通道本身：`SocketChannel` 在阻塞和非阻塞两种模式下，到底怎样改写 connect、accept 和 read 的语义。
