# EXPAND PROMPT: 扩容 00-Server-Selector-Engine.md（~3000 行缺口）

## 目标

当前文档 1947 行，需要扩容到 ~5000 行。本次只修复以下缺口，不重写已有内容。

---

## 缺口 1: Selector.open() 板块 (当前 ~400 → 目标 1300，+900 行)

### 要加的内容

**A. epoll 架构对比 — 为什么 epoll 是 O(1) 而 select 是 O(n)? (~200 行)**

不只说结果，解释架构层的根本差异：
- select/poll 是"一次性"模型：每次调用传入全量 fd → 内核每次重建内部状态 → O(n) 扫描
- epoll 是"持久化"模型：epoll_create 创建持久内核对象 `struct eventpoll` → 含红黑树(全量fd)+ready-list(就绪fd) → epoll_wait 只从 ready-list 取 O(1)
- 红黑树为什么选这个结构？fd 频繁增删 (epoll_ctl ADD/DEL) → rbtree O(logN) 稳定 → hash 表有 resize 问题
- ready-list 为什么是双向链表？epoll_wait O(1) 弹出头部 + ep_remove O(1) 删除任一节点 + epoll 可能从中间取事件

**B. 红黑树在 epoll 中的具体角色 (~200 行)**

- ep_insert() → 在 ep->mtx 下插入 epitem 到 rbtree (内核源码 `fs/eventpoll.c`)
- epitem 结构: 包含 epoll_event (events+data) + 红黑树节点 + 就绪链表节点
- 查找: ep_find() → 用 fd 和 file ptr 做 key → rbtree lookup O(logN)
- 为什么 epoll_wait 不需要 rbtree？因为 ready-list 已经只含就绪 fd — rbtree 只在 epoll_ctl 时被访问

**C. ready-list 的工作机制 (~200 行)**

- ep_poll_callback: 当 fd 有事件到达时 → 内核把对应的 epitem 从 rbtree 节点链入 ready-list (list_add_tail)
- epoll_wait: 遍历 ready-list → copy_to_user 把 events 拷贝给用户态 → 返回数
- Level-triggered: epoll_wait 返回 epitem 后，如果数据未读完 → epitem 留在 ready-list → 下次 epoll_wait 再返回
- Edge-triggered: epoll_wait 返回 epitem 后立即从 ready-list 移除(list_del_init) → 只在状态变化时通知一次

**D. eventSize/eventsOffset/dataOffset 深度解释 (~150 行)**

- 为什么需要 JNI 查询而非 hardcode？不同平台的 struct alignment 原则 (自然对齐 + padding)
- x86-64: 12 bytes, ARM64: 可能 16 bytes (8-byte alignment on 8-byte union member)
- 反事实: hardcode 12 → ARM64 错位 → 垃圾 fd 值 → fdToKey.get(garbage) → null → 静默丢失所有 I/O 事件

**E. SO_REUSEADDR 在 open() 中的设置时机和原因 (~150 行)**

- 为什么服务器自动设 SO_REUSEADDR？服务器重启时旧连接 TIME_WAIT 60s → bind EADDRINUSE → SO_REUSEADDR 允许复用
- 内核实现: `inet_csk_get_port()` → 检查 SO_REUSEADDR → 允许非 LISTEN 状态端口复用
- 为什么客户端不设？客户端端口由内核随机分配 → 不冲突

---

## 缺口 2: select() 板块 (当前 ~400 → 目标 1300，+900 行)

### 要加的内容

**A. EINTR 机制深度解释 (~250 行)**

- SIGPROF @ 100Hz: HotSpot 的 CPU sampling profiler 如何工作 — 每隔 10ms 发送 SIGPROF 信号 → 中断当前执行的任何 syscall
- 信号处理流程: kernel → signal handler → 被中断的 epoll_wait 返回 EINTR → Java 层的 `to -= elapsed` 精确超时调整
- 为什么 `to -= elapsed` 是必需的？100Hz 下每次中断都重试原 timeout → select(5000ms) 需要 ~500 次 EINTR → 实际阻塞 >5s
- 反事实: 如果不调整 — High-frequency profiling (100Hz) 下 select() 几乎永不返回

**B. begin(blocking)/end(blocking) 的虚拟线程支持 (~200 行)**

- `SelectorImpl.begin(blocking)`: 通知 ForkJoinPool/ForkJoinWorkerThread → 当前线程即将阻塞 → 虚拟线程调度器可以挂起当前虚拟线程并释放 carrier thread
- `SelectorImpl.end(blocking)`: 告知调度器线程已恢复 → 虚拟线程重新获取 carrier → 继续执行
- try/finally 确保 `end(blocking)` 在 epoll_wait 返回后一定被调 — 包括异常路径
- 这是 Project Loom 的基础设施之一

**C. processDeregisterQueue 为什么调两次？(~150 行)**

- 第一次在 epoll_wait 前: 处理此前 cancel() 的 key → 确保本次 select 不返回已取消的 key
- 第二次在 epoll_wait 后: 处理 select 期间被 cancel() 的 key → 确保 fdToKey 和 epoll 状态一致
- 为什么不是一次就够了？select 期间可能有异步 close → key 被标记为 invalid → 必须在下一次 select 前清除

**D. Level-triggered vs Edge-triggered 完整比较 (~200 行)**

- 不只是证明 Java 是 LT → 解释两种模式下的编程模型差异
- LT: 部分读安全 → 应用可以只读部分数据 → epoll_wait 继续通知 → 适合"每次读一点"的模型
- ET: 必须读到 EAGAIN → 每个就绪 fd 只通知一次 → 适合"每次读到底"的模型 → Netty 为什么选择 ET
- Netty 的 EpollEventLoop: 设置 EPOLLET → for(;;) read until EAGAIN → 处理完毕 → 再 select

**E. NUM_EPOLLEVENTS=1024 的完整历史 (~100 行)**

- 旧 JDK 栈分配 → stack overflow → SIGSEGV (根本原因)
- JDK 11 改为 native heap → 不再有 stack limit
- 为什么保留 1024 不增大？Level-triggered 保证不丢事件 → 1024 够用 → 增大会增加 native heap 占用 → 没收益

---

## 缺口 3: bind/listen 板块 (+300 行)

### 要加的内容

**A. somaxconn 内核截断 (~150 行)**

- `listen(fd, backlog)` → 内核 `inet_listen()` → `sk->sk_max_ack_backlog = min(backlog, somaxconn)`
- somaxconn default 128 → Java 设 backlog=1024 就白白浪费了 896
- 内核两个队列: SYN queue (incomplete) + Accept queue (complete)
- `/proc/sys/net/core/somaxconn` 的位置和含义

**B. TCP 握手与队列的交互 (~150 行)**

- client SYN → server SYN queue → server SYN+ACK → client ACK → server accept queue → accept() 取出
- SYN queue 满: 丢弃 SYN → client TCP 重试 → 延迟增加 → tcp_syncookies=1 缓解
- Accept queue 满: 新完成握手的连接被丢弃 → client 以为已连接但 server 不知道 → 数据发送丢失
- ss -lnt 诊断: Recv-Q = accept queue 中的连接数 → >0 表示 accept 速度跟不上 accept queue 填充速度

---

## 执行命令

```
/jvm @probe_md/16-nio-network/prompts/expand-00.md
```

## 输出要求

- 直接编辑 00-Server-Selector-Engine.md，在对应板块**插入**新内容（不替换已有内容）
- 每个新板块必须带 ## 标题，方便定位
- 保持 WHW 原则 (Why-How-What)
- 贴源码作为证据 (每 block 10-20 行)，正文是原理 (~100-200 行)
- 每个 500 行以上的新板块至少包含 2 个反事实 + 2 个 Linux 内核引用
