# EXPAND PROMPT: 扩容 02-ZeroCopy-Threads-Diag.md（~4000 行缺口）

## 目标

当前文档 981 行，需要扩容到 ~5000 行。

---

## 缺口 1: transferTo sendfile 零拷贝 (+1450 行)

### 要加的内容

**A. sendfile64 内核路径完整解释 (~500 行)**

不只是贴 `FileChannelImpl.c transferTo0` 源码 → 解释内核发生了什么：

- `sendfile64(out_fd, in_fd, &offset, count)` → kernel `fs/read_write.c:__do_sendfile64` → `do_sendfile64` → `splice_file_to_socket` → 内核内部调用链
- 内核数据路径: page cache → `splice()` → `tcp_sendpage()` → `skb` 数据包 → socket buffer → NIC DMA
- 为什么不需要 copy_to_user/copy_from_user？因为 sendfile 走的是内核的 `splice` 机制——直接在内核中建立两个 fd 的数据通道 (splice_pipe)
- DMA 的 4 次转移: 1. disk → page cache (DMA read) 2. page cache → socket buffer (DMA gather) 3. socket buffer → NIC (DMA send)
- 对比 read()+write() 的 6 次: 1. disk→page cache 2. page cache→user buf (CPU) 3. user buf→socket buffer (CPU) 4. socket buffer→NIC (DMA) — **多 2 次 CPU copy**
- 为什么 in_fd 必须是普通文件？sendfile 依赖 page cache → socket/pipe 没有文件对应的 page cache → 不支持做 in_fd
- 为什么 out_fd 必须是 socket？sendfile 调用 `tcp_sendpage()` → 这是 TCP 协议栈内部 API → 不适用于其他 fd 类型

**B. 三条 fallback 的原理分析 (~450 行)**

不只是列出三个方法 → 解释每层为何存在：

- `transferToDirectly`: sendfile64 成功 → 0 次用户态拷贝 → 最优路径
- `transferToTrustedChannel` (mmap+write): sendfile EINVAL 时 → `map0` (mmap64) → 文件映射到用户虚拟地址 → `write(fd, mmap_addr, 8MB)` → **1 次 CPU copy** (kernel→mmap via copy_from_user on write) — 比 sendfile 多 1 次但比传统快
- `transferToArbitraryChannel` (heap byte[]): mmap 也失败 → `byte[] buf = new byte[8192]` → `read(srcFD, buf)` → `write(dstFD, buf)` → **2 次 CPU copy + 2 次 syscall** — 最慢但保底
- `transferSupported/pipeSupported/fileSupported` 三个 volatile boolean — 缓存能力探测结果 — 避免每次 transferTo 都重新探测

**C. mmap fallback 深入 (~300 行)**

- `map0`: `mmap64(0, len, protections, flags, fd, off)` → kernel allocates VMA (virtual memory area) → page fault 时 lazy load
- mmap 的 8MB chunk 为什么是这个大小？32-bit JVM 虚拟地址空间 ~3GB → 8MB chunk 不长驻 → 频繁 map/unmap 但不超 VM
- 为什么 mmap 后要 munmap？内存映射不显式 munmap → 泄漏直到 MappedByteBuffer 被 GC → 但 GC 不定时 → 可能内存不足
- `unmap0`: `munmap((void*)jlong_to_ptr(address), (size_t)size)` → kernel 释放 VMA + 回收物理页面
- mmap vs sendfile benchmark: 10GB 文件 → sendfile (1 syscall, 0 user copy) vs mmap+write (256 syscalls, 1 kernel copy per 8MB)

**D. 平台差异 (~200 行)**

- Linux: sendfile64 → EAGAIN (partial write) → restart from updated offset; EINVAL → fallback
- macOS: sendfile → header 格式不同 → Java 单独处理 → EAGAIN 语义类似
- AIX: send_file → 不同的 errno 映射 → 能力探测需要单独路径
- 为什么需要平台差异？sendfile 不是 POSIX 标准 → Linux/macOS/BSD/Solaris 各有各的 sendfile → Java 用 `#if defined(__linux__)` 条件编译

---

## 缺口 2: Reactor 多线程 (+1350 行)

### 要加的内容

**A. lockAndDoSelect 并发语义深入 (~500 行)**

- `synchronized(this)` 在 SelectorImpl 上 → register 和 select 在同一 Selector 上互斥 → 保证 fdToKey HashMap 不被并发修改
- 不同 Worker Selector 之间**没有锁竞争** — each Selector has its own `this` monitor
- Boss→Worker 注册: accept() → new SocketChannel → workerSelector.wakeup() (必须!) → sc.register(worker, OP_READ) → synchronized(worker) → 如果 worker 在 select() 中则被锁阻止 → register 成功 → release 锁 → worker select() 醒来
- `inSelect` 标志: doSelect entry → inSelect=true; doSelect exit → inSelect=false。register 时检查 — if (inSelect) 并且调用者来自其他线程 → 必须等 select 返回才能注册

**B. interestOps 变 updateKeys 延迟 — 完整的陷阱解析 (~350 行)**

- `key.interestOps(OP_WRITE)` → `SelectionKeyImpl.interestOps()` → `setEventOps(ski)` → `synchronized(updateLock)` `updateKeys.addLast(ski)` — **只是排队，不立即 epoll_ctl**
- `processUpdateQueue` 什么时候调？next select() — 不是立即 → 如果 Selector 正在 select(timeout=-1) → 永远等不到
- Selector Javadoc: "Changes made to interest set will only be reflected in next selection operation. If selector is currently blocked, invoking wakeup() will cause it to return immediately." — 这是设计约束，不是 bug
- Netty 处理: NioEventLoop 在 event loop 线程内做 interest 变更 → 在 select 返回后立即 processUpdateQueue → 不需要额外的 wakeup。来自其他线程的变更 → 提交 task → wakeup 确保下一个 select 循环处理

**C. Selector 关闭的完整流程 (~250 行)**

- `selector.close()` → `SelectorImpl.implCloseSelector()` → 先 `wakeup()` 确保 select 返回 → 遍历所有 key → `epoll_ctl(DEL)` → `fdToKey.clear()` → close wakeup pipe fds + epoll fd
- 关闭期间 register: `ensureOpen()` 检查 isOpen → false → `ClosedSelectorException`
- 关闭期间 select: `ensureOpen()` → `ClosedSelectorException` → 线程安全释放

**D. Netty NioEventLoop 的 Reactor 模型对比 (~250 行)**

- 单 event loop 线程 → select + processEvents 串行 → 无锁 Selector
- Boss event loop: 只 accept → 创建 NioSocketChannel → 注册到 Worker event loop
- Worker event loop: select → process I/O → fire pipeline events
- Netty 的 wakeup 机制: `if (!inEventLoop())` → `execute(task)` → `if (needWakeup) wakeup()` → 封装了 JDK 的 interestOps/wakeup 陷阱

---

## 缺口 3: 诊断工具链 (+650 行)

### 每个工具必须体现诊断思维

**A. strace 诊断思维 (~200 行)**

不只是贴命令 — 解释每个 trace line 的诊断意义：
- `sendfile64(10,15,[0],8388608) = 8388608` → sendfile 成功，内部 offset 前进到 8388608
- `sendfile64(10,16,[8388608],8388608) = -1 EINVAL` → fd 16 不支持 → Java 降级
- `mmap(NULL, 8388608, PROT_READ, MAP_SHARED, 16, 8388608)` → fallback 1: mmap
- `writev(10, [{iov_base=..., iov_len=8388608}], 1) = 8388608` → 写入 socket
- `munmap(...)` → 释放 mmap 区域
- 这个 strace 序列告诉你 Java 的完整降级过程 — 不需要读源码就能推断三层 fallback 的存在

**B. GDB 7 断点诊断 (~200 行)**

每个断点的诊断价值（不只是列出断点）：
- `Net.socket0`: 验证 socket 被创建，AF_INET6 被选中，IPV6_V6ONLY=0 被设置
- `Net.connect0`: 捕获 EINPROGRESS 返回值，验证 errno=115
- `closefd`: 逐层验证 lock/dup2/signal 的执行 — 查看 fdEntry->lock, marker_fd, WAKEUP_SIGNAL
- `FileChannelImpl.transferTo0`: 捕获 sendfile64 的三个可能返回值 (EAGAIN/EINVAL/success)

**C. /proc 文件系统诊断 (~150 行)**

- `/proc/{pid}/fd/`: 计数 fd → 接近 ulimit → 需要在accept 循环中 break
- `/proc/{pid}/fdinfo/`: epoll fd info → 列出所有被监视的 fd → 确认 channel 正确注册
- `/proc/sys/net/core/somaxconn`: 检查 listen backlog 的有效上限 → 和 Java 设的比较
- `/proc/sys/net/ipv4/tcp_syn_retries`: 连接超时参数 → 影响测试等待时间

**D. ss 和 jcmd (~100 行)**

- `ss -lnt | grep :8080`: Recv-Q -> 积压的已完成握手等待 accept
- `jcmd <pid> Thread.print`: 查看 Selector 线程是阻塞在 EPoll.wait 还是在 doSelect 中循环 — 区分正常和 epoll CPU spin bug

---

## 缺口 4: 面试题 12 (+500 行)

每題 ~40 行结构：问题 → 源码依据 → 调用链 → 反事实
每个题必须提及文件:行号的位置引用

### 12 题列表
1. epoll vs select — O(1) vs O(n), 10K fd benchmark
2. 非阻塞 connect — EINPROGRESS + SO_ERROR 两步验证
3. wakeup pipe vs 信号 — 为什么用 pipe
4. LT vs ET — Java 的选择 + Netty 的覆盖
5. dup2 trick 三重防护 — lock/dup2/signal 每一步的必要性
6. DirectBuffer vs HeapBuffer — 内存布局本质差异
7. sendfile vs mmap — 0 copy vs 1 copy 的内核路径对比
8. Kafka 为什么用 sendfile — 磁盘到 socket 全流程
9. selector.select() 不返回的原因 — interestOps 忘 wakeup
10. maxDirectMemory 限制 — PhantomReference + Cleaner + OOM
11. epoll 100% CPU 根因 — stale epitem (引用 00 详细分析)
12. Project Loom — Virtual Thread 还需要 Selector 吗？

---

## 缺口 5: 生产场景速查表 (+370 行)

每个场景 ~50 行: 症状 → 根因 → 诊断命令 → 修复方案

### 7 场景
1. EMFILE — accept fd 耗尽 → ulimit -n + strace
2. dup2 trick — close 阻塞线程不醒来 → strace dup2/close + jstack
3. sendfile EINVAL — 吞吐量突然降到 200MB/s → strace sendfile/mmap
4. epoll 100% CPU — CPU 打满没有 I/O → strace epoll_wait=0 + jcmd
5. TIME_WAIT flood — can't open new connections → SO_LINGER + RST
6. OOM DirectBuffer — OutOfMemoryError → jcmd VM.native_memory + GC log
7. select stuck — Worker 线程不返回 → jstack + interestOps + wakeup 检查

---

## 执行命令

```
/jvm @probe_md/16-nio-network/prompts/expand-02.md
```

## 输出要求

- 在对应板块插入新内容
- sendfile: 不只贴 `trasnferTo0` 源码 → 讲 DMA/splice/内核路径
- Reactor: 不只列 `lockAndDoSelect` → 讲 Boss/Worker 的完整并发语义
- 诊断: 每工具不只列命令 → 展示诊断思维 (看什么、为什么、下一步)
- 面试题: 每題 ~40 行 (问题+源码+调用链+反事实)
- 速查表: 每场景 ~50 行 (症状+根因+诊断+修复)
