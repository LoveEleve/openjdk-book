# 01. Selector 抽象与选择机制 — 三件套、注册、select 流程

> 🔴 Deep | 域 21 Selector 与网络 NIO 第 1 篇 | Layer 4
> 读者处境: 面试"NIO 的 Selector 原理"——注册、就绪、消费三阶段,一个线程怎么管上万连接。

### 1. "Selector 三件套" — 角色分工

场景: Selector/SelectionKey/SelectableChannel — 各自职责

- `channels/Selector.java:418` `select()` — **多路复用器**(等待就绪事件)
- `channels/SelectionKey.java` — **就绪键**(通道+选择器的配对凭证): interestOps(168,感兴趣的事件)/readyOps(就绪事件)/channel()/attach
- `channels/SelectableChannel.java:257` `register(sel, ops)` — **通道注册**(把自己挂到 Selector)
- 事件常量(`SelectionKey.java:296-332`): OP_READ=1<<0/OP_WRITE=1<<2/OP_CONNECT=1<<3/OP_ACCEPT=1<<4
- 关键设计 (斜体): *"注册(登记兴趣)→ select(等待就绪)→ 消费(selectedKeys)"三阶段模型——通道声明"我对什么事件感兴趣",选择器统一等待;SelectionKey 是两者间的"契约对象"*
- 面试: "selector 是怎么工作的"——单线程注册 N 个通道,内核等待任一就绪

### 2. "select 的流程" — SelectorImpl 骨架

场景: `selector.select()` 阻塞到什么时候?——内部怎么走

- `SelectorImpl.java:133` `select(long)` → `lockAndDoSelect`(136)→ 平台 `doSelect`(111 抽象)
- `SelectorImpl.java:279` `processReadyEvents` — 就绪事件 → 更新 key 的 readyOps
- `select()/selectNow`: 阻塞无限等待/非阻塞立即返回
- 关键设计 (斜体): *"骨架 + 平台 doSelect"是模板方法——共享层处理 key 管理/就绪消费,平台层只做"内核等待";面试"select 阻塞在哪"——平台 doSelect(linux 是 epoll_wait)*
- 面试: "select 返回后做什么"——遍历 selectedKeys,按 readyOps 分支处理

### 3. "selectedKeys 怎么消费？" — 就绪键集

场景: 处理就绪事件的循环——为什么要 remove?

- `Selector.java:344` `selectedKeys()` — **就绪键集合**(只读集合,但可 remove)
- 经典循环:
  ```java
  while (selector.select() > 0) {
      Iterator<SelectionKey> it = selector.selectedKeys().iterator();
      while (it.hasNext()) { ...; it.remove(); }   // 必须 remove!
  }
  ```
- 不 remove 的后果: 已处理事件下次仍重复遍历(且新事件可能覆盖 readyOps)
- 关键设计 (斜体): *selectedKeys 是"一次性快照"——消费后必须 remove(框架不自动清);面试"为什么 iterator.remove()"——否则同一 key 反复处理*
- [关联: 域 19 Buffer(就绪后读写的数据载体);内核: 文件描述符就绪语义(select/poll/epoll 的统一抽象)]
- 生产: 高并发服务器的事件循环(Netty 的 boss/worker 同构思想)

### 4. "wakeup" — 唤醒阻塞中的 select

场景: 别的线程想让阻塞的 select 立即返回——wakeup 机制

- `Selector.java:609` `wakeup()` — 唤醒阻塞的 select(线程安全)
- linux 实现: **socketpair**——wakeup 向管道写一个字节,epoll_wait 因 fd0 可读返回(EPollSelectorImpl:93 注册 fd0)
- 典型: 优雅关闭/注册新通道需要 select 立即醒来
- 关键设计 (斜体): *"自管道唤醒"是跨平台技巧——不需要信号,用管道事件让等待返回;面试"wakeup 原理"——自管道/自 socket*
- 生产: Netty 的线程模型用它做任务唤醒

---

### 核心悬念

骨架通了——**linux 上内核等待怎么实现**?`EPollSelectorImpl` 的 epfd、`EPoll.create/ctl/wait` 三个 native 调用、socketpair 唤醒、epoll 与 select/poll 的差别——下一篇: epoll 实现与平台分层。

> → [02-epoll-platform.md](02-epoll-platform.md)
