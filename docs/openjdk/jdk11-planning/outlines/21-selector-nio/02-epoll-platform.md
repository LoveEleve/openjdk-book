# 02. epoll 实现与平台分层 — EPollSelectorImpl、native 三调用、与 select 对比

> 🔴 Deep | 域 21 Selector 与网络 NIO 第 2 篇 | Layer 4
> 读者处境: 面试"epoll 原理"必考——三个系统调用、事件表、与 select/poll 的 O(1) vs O(n)。

### 1. "linux 上的 Selector 是什么？" — EPollSelectorImpl

场景: `Selector.open()` 在 linux 返回什么对象?

- 平台选择: `linux/classes/sun/nio/ch/DefaultSelectorProvider.java:45` — `new EPollSelectorProvider()` → `openSelector`(EPollSelectorProvider:35)→ **EPollSelectorImpl**
- `EPollSelectorImpl.java:50` — `class EPollSelectorImpl extends SelectorImpl` — 平台实现
- `EPollSelectorImpl.java:56` — `private final int epfd` = `EPoll.create()`(79)— **epoll 实例 fd**
- 就绪处理: `processUpdateQueue`(143,兴趣变更队列)→ `EPoll.wait` 结果写入 pollAddress(AllocatedNativeObject)内存区
- 关键设计 (斜体): *"平台分层"= 共享骨架(SelectorImpl)+ 平台实现(EPoll/Poll)——DefaultSelectorProvider 是工厂;面试"Selector.open 在 linux 是什么"——EPollSelectorImpl*
- 非 linux 回退: unix 层 `PollSelectorImpl`(poll 系统调用)
- [内核: epoll_create(2);内部卷 01-os 平台层]

### 2. "epoll 三调用" — create/ctl/wait

场景: epoll 怎么做到 O(1) 事件通知?

- `linux/classes/sun/nio/ch/EPoll.java` native 封装:
  - `create()`(112)— epoll 实例
  - `ctl(epfd, opcode, fd, events)`(114)— **事件表增删改**(EPOLL_CTL_ADD/MOD/DEL)
  - `wait(epfd, pollAddress, numfds, timeout)`(116)— 等待就绪,结果写内存(pollAddress,AllocatedNativeObject)
- 注册/更新(`EPollSelectorImpl.java:160-167`): 通道注册时 EPOLL_CTL_ADD(164)/兴趣变化 EPOLL_CTL_MOD(167)/注销 DEL(160)
- 就绪数据: `eventSize`(106)/`eventsOffset`(108)/`dataOffset`(110)— 事件数组布局
- 关键设计 (斜体): *epoll 三调用的本质: create 建表、ctl 维护事件表、wait 等待就绪——**事件表在内核**(O(1) 就绪查询,无需每次全量拷贝 fd 集合);对比 select: 每次全量扫描 O(n)*
- 面试: "epoll vs select/poll"——select 每次拷全量 fd 集合 O(n)+上限 1024;epoll 内核事件表+回调 O(1) 就绪通知
- [内核: epoll_create(2)/epoll_ctl(2)/epoll_wait(2);man 2 epoll]

### 3. "水平触发" — JDK 的默认模式

场景: 就绪事件没处理完——下次 select 还会通知吗?

- JDK epoll 用 **水平触发(level-triggered)**: 数据没读完,epoll_wait 持续返回就绪
- 对比边缘触发(edge-triggered): 只在状态变化时通知一次(需一次读完)
- JDK 选择水平触发的原因: 与 select/poll 语义一致、实现简单、不会丢事件
- 关键设计 (斜体): *"水平 vs 边缘"是 epoll 的经典题——水平=持续通知(简单安全),边缘=变化通知(高效但易漏);Netty 用边缘触发优化,JDK 默认水平;面试讲清两种模式即可*
- 面试: "为什么 Netty 用边缘触发?"——减少重复系统调用(配合一次读尽)
- [内核: EPOLLET 标志;关联: Netty(域外)]

### 4. "唤醒机制" — socketpair

场景: wakeup() 怎么让阻塞的 epoll_wait 立即返回?

- `EPollSelectorImpl.java:93` — 构造时 `EPoll.ctl(epfd, EPOLL_CTL_ADD, fd0, EPOLLIN)` — **注册自管道一端**
- wakeup: 向管道写字节 → fd0 可读 → epoll_wait 返回
- 关闭: 反向写管道解除阻塞后关闭
- 关键设计 (斜体): *"自管道"是经典唤醒技巧——不依赖信号(信号处理复杂),用 fd 事件让 epoll 自然醒来;面试"wakeup 原理"——管道写入*
- 生产: 优雅停机/动态注册都要先 wakeup

---

### 核心悬念

选择器能"知道"哪个通道就绪了——但**通道本身怎么读写**?SocketChannel 的阻塞/非阻塞切换、connect 的三次握手、accept 的连接建立——BIO 和 NIO 的线程模型差异在哪?——下一篇: SocketChannel 与阻塞/非阻塞。

> → [03-socketchannel-blocking.md](03-socketchannel-blocking.md)
