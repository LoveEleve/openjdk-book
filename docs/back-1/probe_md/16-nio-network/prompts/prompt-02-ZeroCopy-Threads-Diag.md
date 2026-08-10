# PROMPT: 请撰写 02-ZeroCopy-Threads-Diag.md

## §〇 Production Scenario

Kafka broker 日志大量 `sendfile returns EINVAL` — `FileChannel.transferTo()` 不传输数据。Java 自动降级到 mmap+write 路径，吞吐量从 1GB/s 降到 200MB/s。Root cause: Linux `sendfile64` 对 fd 对有限制 — `out_fd` 必须是 socket, `in_fd` 必须普通文件。特定内核版本或 fd 类型上，`sendfile64()`→-1+EINVAL。Java 三层 fallback: `transferToDirectly`(sendfile,0拷贝)→`transferToTrustedChannel`(mmap+write,1拷贝,8MB chunk)→`transferToArbitraryChannel`(heap byte[],2拷贝+2 syscall)。`transferSupported/pipeSupported/fileSupported` 三个 volatile boolean 缓存内核能力(FileChannelImpl.java:471-483)。

还有一个场景：你写了 Boss/Worker Reactor — Worker Selector `select()` 永不返回，因为 Boss `register(newChannel,OP_READ)` 后忘了调 `selector.wakeup()`。`interestOps` 变更只排入 `updateKeys` 队列——不调 `wakeup()` 则 Selector 继续等待旧事件集。

另有一个场景：线上 NIO 服务器 CPU 打到 100% — `epoll_wait` 在阻塞模式下不停返回 0。这正是 00 文档深入分析的 Linux <2.6.27 `ep_remove()` bug。本文档从**诊断视角**覆盖此问题——三步诊断 + poll 降级方案。（深度源码分析在 00 文档中，本文引用即可，避免重复。）

**三步诊断**:

```bash
# 1. sendfile EINVAL fallback
strace -e trace=sendfile64,mmap,writev -p $(pgrep -f kafka) 2>&1 | head -10
# sendfile64(10,15,[0],8388608) = -1 EINVAL → mmap(...)→writev(...)

# 2. Reactor select stuck
jstack $(pgrep -f java) | grep -A5 "selector.select"
# Worker 线程 BLOCKED in EPoll.wait, Boss 刚 register 了但没 wakeup

# 3. epoll CPU spin (引用 00 文档的深度分析)
strace -e trace=epoll_wait -p $(pgrep -f java) 2>&1 | head -5
# epoll_wait(5,[],1024,-1)=0 repeatedly → 100% CPU
```

**反事实**: sendfile 无 fallback→EINVAL 时直接 IOException→Kafka broker 崩溃→partition leader 切换→集群级故障。Reactor 反事实: `interestOps` 立即 epoll_ctl→每次变更一次 syscall→高频场景性能退化。

---

## §一 Task + Narrative + Beginner Callouts

### Task

This document covers two advanced NIO topics: (1) **kernel zero-copy** — Kafka's `FileChannel.transferTo()` uses `sendfile64` for data transfer without user-space copies; (2) **Reactor thread model** — Boss/Worker pattern, `lockAndDoSelect` concurrency, interestOps wakeup pitfall. Plus production diagnostics toolkit and 12 interview questions.

Reader completed **00-Server-Selector-Engine** (Selector engine, epoll bug deep analysis) and **01-Socket-Data-Close** (socket lifecycle, DirectBuffer I/O, dup2 close). This doc: **how to make NIO fast** — zero-copy file transfer and multi-threaded event loops.

### 你写的代码（引子）

**Kafka zero-copy**:
```java
FileChannel fc = FileChannel.open(Paths.get("/data/topic-0/000000.log"));
SocketChannel sc = ...;
long pos=0; long count=fc.size();
while (count>0) {
    long n = fc.transferTo(pos, count, sc);  // ← sendfile64(dstFD,srcFD,&offset,count)
    pos+=n; count-=n;  // EAGAIN→retry; EINVAL→automatic fallback to mmap+write
}
```

**Reactor Boss/Worker**:
```java
Selector boss=Selector.open(); ssc.register(boss,OP_ACCEPT);
Selector[] workers={Selector.open(),Selector.open(),Selector.open()};
int idx=0;
while(true){boss.select();
  for(SelectionKey k:boss.selectedKeys()){
    SocketChannel sc=ssc.accept(); sc.configureBlocking(false);
    Selector w=workers[idx++%workers.length];
    w.wakeup();                         // ← 忘了这行→Worker select()永不返回!
    sc.register(w,OP_READ);             // ← interestOps 只排入 updateKeys
  }
}
while(true){worker.select();  /* ← 可能永不返回 */  for(...){/* I/O */}}
```

### 板块规划（6 板块）

| # | 板块 | 行数 | 核心 |
|---|------|:---:|------|
| 1 | transferTo sendfile 零拷贝 | ~1800 | sendfile64 kernel path→3 fallbacks→capability detection→platform diff→EAGAIN/EINTR→mmap fallback→benchmark |
| 2 | Reactor 多线程模型 | ~1600 | Boss/Worker→lockAndDoSelect→inSelect→interestOps trap→Selector close→Netty NioEventLoop |
| 3 | epoll bug 诊断视角 | ~400 | 三步诊断+poll 降级（**引用 00 文档的深度分析，不重复内核源码，只讲诊断面**） |
| 4 | 诊断工具链 | ~800 | strace(sendfile fallback+epoll lifecycle)+GDB 7+/proc/ss/jcmd |
| 5 | 面试题集 12 题 | ~600 | 每题含源码验证+调用链+反事实 |
| 6 | 生产场景速查表 | ~400 | 7 场景: EMFILE→sendfile EINVAL→epoll CPU→TIME_WAIT→OOM DirectBuffer→select stuck→accept stuck |

### Interview Story Format Answer（~350字）

"Kafka's zero-copy relies on `FileChannel.transferTo()` which calls `sendfile64(dstFD,srcFD,&offset,count)` (FileChannelImpl.c) — the kernel DMA-copies from disk to page cache, then splices directly to the socket buffer via DMA gather, never touching user space. 0 user-space copies, 1 context switch vs. traditional read()+write()'s 4 copies and 2 switches. When sendfile64 returns EINVAL, Java's three-tier fallback: `transferToDirectly`(sendfile64 success,0 copies)→`transferToTrustedChannel`(mmap+write,1 kernel copy,8MB chunks)→`transferToArbitraryChannel`(heap byte[] read()+write(),2 copies+2 syscalls). Three volatile booleans `transferSupported/pipeSupported/fileSupported`(FileChannelImpl.java:471-483) probe and cache kernel capabilities on first use. For Reactor: `SelectorImpl.lockAndDoSelect()` uses `synchronized(this)` to serialize register/select on the same Selector. `inSelect` guard prevents reentrant selects. Most common pitfall: `key.interestOps()` only pushes to `updateKeys` Deque via `setEventOps()`(EPollSelectorImpl.java:242-247) — takes effect next `select()`, but if Selector is blocking in epoll_wait, you MUST call `wakeup()`. Forgetting wakeup() in Boss→Worker registration is the #1 cause of 'selector stuck forever'. The Linux<2.6.27 ep_remove() bug (analyzed in-depth in 00) — from diagnostic perspective: stale epitems→epoll_wait returns 0→100% CPU→poll fallback."

### Beginner Callout Boxes（6 个）

1. **sendfile64 kernel path**: disk DMA→page cache→splice/DMA gather→socket buffer→NIC. 0 user-space copies, 1 context switch. Vs read()+write(): 4 copies, 2 switches. Source: FileChannelImpl.c, man 2 sendfile.

2. **三层 fallback**: (1)transferToDirectly: sendfile64 success,0 copies. (2)transferToTrustedChannel: mmap+write 8MB chunks,1 copy. (3)transferToArbitraryChannel: heap byte[] read()+write(),2 copies+2 syscalls. volatile capability flags cached. Source: FileChannelImpl.java.

3. **mmap vs sendfile**: mmap maps file→user virtual addr→write(fd,mmap_addr,len)→1 kernel copy(page cache→socket buffer via copy_from_user). sendfile: 0 copies (splice in kernel). mmap works on any writable fd. 8MB chunks for efficiency.

4. **Reactor Boss/Worker**: Boss=OP_ACCEPT only, Worker=OP_READ/OP_WRITE. lockAndDoSelect synchronized(this) per Selector—no cross-Selector lock. interestOps trap: only enqueued, needs wakeup() if Selector blocking.

5. **epoll bug 诊断** (引用 00): Linux<2.6.27 ep_remove()→stale epitem→epoll_wait=0→100% CPU. 三步诊断: uname -r+strace+jcmd. Fix: upgrade kernel or -Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider.

6. **strace 诊断 sendfile 降级**: `sendfile64(10,15,[0],8M)=-1 EINVAL`→`mmap(NULL,8M,PROT_READ,MAP_SHARED,15,0)`→`writev(10,[{iov_base=...,iov_len=8M}],1)=8M`. 8MB=MAPPED_TRANSFER_SIZE. 1GB file: sendfile=1 syscall, mmap+write=256 syscalls.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Sources: `FileChannelImpl.c`(247L transferTo0 sendfile64+map0 mmap64+unmap0 munmap), `FileChannelImpl.java`(1215L transferTo 3fallbacks+capability detection), `SelectorImpl.java`(311L lockAndDoSelect+inSelect+implCloseSelector), `EPollSelectorImpl.java`(270L setEventOps updateKeys defer), `Net.c`(814L setIntOption0 SO_LINGER), `PlainSocketImpl.c`(1038L socketClose0 SO_LINGER). Build: `make jdk`. Binary: `libnio.so`.

---

## §三 Source Files Table

| # | File | Lines | Core Functions | Role |
|---|------|:--:|-------|------|
| 1 | FileChannelImpl.c | 247 | transferTo0(sendfile64→EAGAIN/EINVAL) map0(mmap64) unmap0(munmap) | 🔥 Zero-copy |
| 2 | FileChannelImpl.java | 1215 | transferTo→3 fallbacks+transferSupported/pipeSupported/fileSupported | 🔥 Fallback orchestration |
| 3 | SelectorImpl.java | 311 | lockAndDoSelect(synchronized) register(inSelect guard) implCloseSelector | Reactor concurrency |
| 4 | EPollSelectorImpl.java | 270 | setEventOps(updateKeys) doSelect(epollWait) | wakeup+interestOps |
| 5 | Net.c | 814 | setIntOption0(SO_LINGER linger struct) | Socket options |

---

## §四 Deep Dive Question Groups（≥8）

### 4.1 ★★★ sendfile64 — 内核零拷贝路径

```
问题：
  ① FileChannelImpl.c transferTo0 sendfile64 调用？三条 fallback 分别是什么？
      答案方向: FileChannelImpl.c transferTo0:
          #if defined(__linux__)
              off64_t offset = (off64_t)position;
              jlong n = sendfile64(dstFD, srcFD, &offset, (size_t)count);
              if (n == -1) {
                  if (errno == EAGAIN) return IOS_UNAVAILABLE;
                  if (errno == EINVAL) return IOS_UNSUPPORTED_CASE;
                  return handle(env, errno, "Transfer failed");
              }
              return n;

        Java 三层 (FileChannelImpl.java):
        transferToDirectly: sendfile64 success→0次用户态拷贝, 1 syscall
        transferToTrustedChannel: UNSUPPORTED_CASE→mmap file→write(dstFD,mmap_addr,len)8MB chunk→1次内核拷贝
        transferToArbitraryChannel: 都失败→heap byte[]→read(srcFD,buf,len)→write(dstFD,buf,len)→2次拷贝+2次syscall

        能力探测 (FileChannelImpl.java:471-483):
          transferSupported/pipeSupported/fileSupported 三个 volatile boolean, 首次尝试后缓存

        追问: sendfile64 内核数据路径？
        → 磁盘 DMA→page cache→sendfile64 触发 splice()→DMA gather→socket buffer→NIC。
          全程内核态。对比 read+write: disk DMA→page cache→read() copy_to_user→user buf→write() copy_from_user→socket buffer→NIC。多2次拷贝+1次上下文切换。

        追问: EAGAIN 如何处理？
        → sendfile64→-1+EAGAIN→IOS_UNAVAILABLE→transferTo 循环 while(count>0)→next iteration from updated offset。
          sendfile64 内部更新 &offset 为已传输字节数。

  ② Counterfactual: 没有 fallback→sendfile64 EINVAL 时直接 IOException→Kafka broker 崩溃→集群故障。
      决策点: FileChannelImpl.java 三层 fallback 是可用性保障。
```

### 4.2 ★★★ mmap fallback — 一次内核拷贝

```
问题：
  ① FileChannelImpl.c map0 mmap64？transferToTrustedChannel 如何使用？
      答案方向: map0: void *address = mmap64(0,len,protections,flags,fd,off);
        if (address==MAP_FAILED) { ENOMEM→OOMError, else handle error; }
        return jlong_to_ptr(address);
        transferToTrustedChannel: mbb=fileChannel.map(READ_ONLY,pos,count)→dstChannel.write(mbb)→
          write(fd,mbb.address(),mbb.remaining()) 8MB chunks.

        追问: mmap 优缺点？
        → 优点: 比 read+write 少1次拷贝, 比 sendfile 通用 (any writable fd)。
          缺点: 比 sendfile 多1次拷贝, 8MB chunk→N chunks→2N syscalls vs sendfile's 1.

  ② Counterfactual: 用更大 chunk→1GB mmap→耗尽虚拟地址空间(32-bit JVM)或 OOM Killer。
      决策: FileChannelImpl.MAPPED_TRANSFER_SIZE=8MB 经验安全值。
```

### 4.3 ★★★ Reactor Boss/Worker — lockAndDoSelect 并发

```
问题：
  ① SelectorImpl.lockAndDoSelect 如何保证 register 和 select 互斥？
      答案方向: lockAndDoSelect: synchronized(this) { return lockAndDoSelect(action,timeout); }
        register: synchronized(this) { implRegister; }  同一把锁, 互斥。
        不同 Worker Selector 无锁——各自 own this monitor。

        Boss→Worker: 1.accept()→2.workerSelector.wakeup()←必须! 3.sc.register(worker,OP_READ)→
          inSelect→拒绝→setEventOps→updateKeys.addLast(ski)→只排队

        inSelect: doSelect 开始时设 true, 结束时 false。register()中 if(inSelect)→
          必须调用者先 wakeup 再同步 register。

        追问: 为什么不直接在 setEventOps 中立即 epoll_ctl？
        → 立即 epoll_ctl 需持 updateLock 同时调 native—可能阻塞(closefd 同步操作同一 fd)。
          延迟到 select() 线程批量处理→更安全, 减少锁持有时间。

  ② Counterfactual: register 不在 synchronized(this) 下→多线程并发 register→fdToKey HashMap 损坏。
      决策: synchronized(this) 是 Selector 线程安全基础。
```

### 4.4 ★★ epoll bug — 诊断视角（不重复 00 深度分析）

```
问题：
  ① 生产中如何诊断 Linux<2.6.27 ep_remove() bug？(详细源码分析在 00 文档)
      答案方向: 三步诊断: 1.uname -r (确认<2.6.27) 2.strace -e epoll_wait (确认 tight loop 返回0)
        3.jcmd Thread.print | grep doSelect (确认在 processUpdateQueue↔doSelect 间循环)
        修复: 升级内核或 JDK9+ (EPollArrayWrapper 在 DEL 前清 pending events)或 poll 降级:
        -Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider

        追问: RecycledSelector 模式为何触发？
        → 频繁 unregister+reregister→epoll_ctl(DEL)→ep_remove→last watched fd→stale epitem。
          单次 register→use→deregister 不会触发。

  ② Counterfactual: EPOLLET edge-triggered 不受此 bug→删除的 fd 无新事件→但所有 NIO 代码需改写。
      决策: Java 选 LT 简单性但付出此 bug 代价。(00 文档已完整分析)
```

### 4.5 ★★★ interestOps 变更不调 wakeup 陷阱

```
问题：
  ① key.interestOps(OP_WRITE) 后为什么必须调 selector.wakeup()？
      答案方向: interestOps()→setEventOps(ski)→synchronized(updateLock){updateKeys.addLast(ski)}
        仅排队! 不立即 epoll_ctl。生效: next select() 中的 processUpdateQueue()。
        Selector.java API doc: "Changes to interest set will only be reflected in next selection.
        If selector is currently blocked, invoking wakeup() will cause it to return immediately."
        典型: Worker select(timeout=-1)→Boss register→setEventOps→Worker 永不被唤醒→新channel 不监视。

        追问: Netty 如何避免？
        → NioEventLoop.inEventLoop() 检查: 同线程→直接处理, 否则→提交 task queue→wakeup。

  ② Counterfactual: 立即 epoll_ctl→每次变更 syscall→N 并发 Worker→N 次 epoll_ctl→性能OK但锁竞争加剧。
      决策: 延迟批处理是 tradeoff—牺牲即时性换取 syscall 效率。
```

### 4.6 ★★ mmap unmap — Cleaner 自动释放

```
问题：
  ① Java 如何释放 mmap 内存？为什么没有显式 unmap？
      答案方向: map()→addr=map0(imode,mapPos,mapSize)→new DirectByteBuffer(...,unmapper)
        unmapper: Runnable→native unmap0(address,size)→munmap((void*)ptr,(size_t)size)
        释放: MappedByteBuffer unreachable→Cleaner(PhantomReference)→Deallocator thread→unmapper.run()
        为什么无显式 unmap: Java 安全模型→try-with-resources 不可靠→forget→leak。Cleaner 自动回收更安全。
        计入 MaxDirectMemorySize: map() Bits.reserveMemory 配额→防止 OOM。

  ② Counterfactual: 显式 unmap→忘记调用→泄漏到 GC→内存不足。自动 Cleaner 安全选择。
      决策: FileChannelImpl 无 public unmap API。
```

### 4.7 ★★★ SO_LINGER — RST vs FIN

```
问题：
  ① SO_LINGER 如何影响 close()？生产何时使用？
      答案方向: Net.c:446-497 setIntOption0: struct linger{l_onoff,l_linger};
        if(arg>=0){l_onoff=1;l_linger=arg} else{l_onoff=0}
        l_onoff=0→正常 close→FIN→四次挥手→TIME_WAIT(60s)
        l_onoff=1,l_linger=0→close 发 RST→跳过 TIME_WAIT(ephemeral ports 耗尽时)
        l_onoff=1,l_linger=N→close 阻塞最多 N 秒等待确认→超时返回
        PlainSocketImpl.c socketClose0: 先查 SO_LINGER→决定 FIN vs RST→closefd dup2

        追问: RST 代价？→未确认数据丢失, peer Connection reset by peer, 对端无法区分崩溃 vs 主动 RST。

  ② Counterfactual: 所有 close 都发 RST→零 TIME_WAIT 但数据完整性问题→应用层重试风险。
      决策: 根据应用语义选择。
```

### 4.8 ★★★ 诊断工具链

```
问题：
  ① strace/GDB//proc/jcmd 如何诊断 NIO 生产问题？
      答案方向: strace: epoll_create/ctl/wait+socket/bind/listen/accept4/connect+sendfile64/mmap+dup2/close
        正常: sendfile64=8M; 异常: sendfile64=-1 EINVAL→mmap+writev; CPU spin: epoll_wait=0 tight loop
        GDB 7: Net.socket0,Net.connect0,EPoll.epollWait,closefd,accept0,checkConnect,FileChannelImpl.transferTo0
        /proc: fd/计数+fdinfo/ epoll watches+limits ulimit+somaxconn listen截断+tcp_syn_retries connect超时
        ss -lnt: Send-Q backlog,Recv-Q 积压。jcmd: Thread.print VM.native_memory

  ② Counterfactual: 缺工具→只能日志猜测→MTTR 分钟级变小时级。诊断链是可用性基硅。
```

---

## §五 Article Structure

```
§〇 Production — sendfile EINVAL+Reactor stuck+epoll CPU
§一 ZeroCopy+Reactor walkthrough (1.1-1.6) with Kafka+Boss/Worker code
§二 6 Beginner Callout boxes
§三 Diagnostics: strace/GDB//proc/ss/jcmd
§四 12 interview questions (source-verified)
§五 7 production scenario lookup table
§六 Cross-Reference
```

---

## §六 Writing Requirements

### 核心规则：源码是证据，原理是正文

```
文档不是"源码翻译机"——是"原理讲解课"。
贴源码的目的是证明你说的原理是对的，不是用源码填满篇幅。
每 100 行文档的分配比例:
  源码引用: ~20 行（完整函数贴入，作为证据块）
  逐行解释: ~30 行（只解释关键行，不是逐行翻译）
  原理展开: ~30 行（为什么这么设计？知识性内容）
  反事实+诊断+Linux内核: ~20 行
```

### 每个板块的"原理"具体指什么

| 板块 | 不要写成 | 应该写成 |
|------|---------|---------|
| 1. transferTo sendfile | FileChannelImpl.c 调了 sendfile64() | **sendfile64 为什么能做到零拷贝？** 这归结到 Linux 内核的一个架构选择：`splice()` 系统调用是内核态的"管道"——它不需要经过用户空间就可以在内核的两个 file descriptor 之间传输数据。sendfile64 是 splice 之上的一层优化——它的语义更特殊（必须 in_fd 是普通文件，out_fd 是 socket），所以可以做更激进的优化：用 **DMA gather** 直接从 page cache 复制数据到 socket buffer，完全不经过 CPU。传统 read()+write() 路径：磁盘 DMA→page cache→CPU 执行 copy_to_user→用户 buffer→CPU 执行 copy_from_user→socket buffer→网卡 DMA。共 4 次拷贝(2次 DMA+2次 CPU copy)，2 次 context switch。sendfile64 路径：磁盘 DMA→page cache→DMA gather→socket buffer→网卡 DMA。共 2 次拷贝(全是 DMA，0 次 CPU copy)，1 次 context switch。**这不是"快了两倍"——是完全消除了 CPU 参与数据传输。** 为什么入 fd 必须是普通文件？因为 sendfile 依赖 page cache 作为中间层——socket 和 pipe 没有 page cache 映射，所以不能做 in_fd。 |
| 1b. mmap fallback | sendfile 失败后用 mmap 替代 | **mmap 比 sendfile 慢多少——以及为什么 Java 仍然保留它？** mmap 把文件映射到用户虚拟地址空间——当 `write(fd, mmap_addr, len)` 调用时，CPU 执行 copy_from_user 从 mmap 区域复制到 socket buffer。这是 1 次 CPU copy——比 sendfile 的 0 次多了 1 次，但比 read()+write() 的 2 次少了 1 次。Java 选择 8MB 的 chunk 大小是有原因的：1) 32-bit JVM 的虚拟地址空间只有 ~3GB——8MB chunk 需要 8MB 虚拟地址映射，频繁 map/unmap 但保持总量可控；2) 一次 8MB mmap 的使用时间短，减少"长期占住虚拟地址"的碎片风险；3) 8MB 是 Linux 页缓存预读的合理大小。**更深一层：为什么 mmap 比 sendfile 更通用？** 因为 mmap 不关心 out_fd 的类型——它返回的是用户态地址，你可以把它写入 socket、pipe、甚至拷贝到另一个 mmap 区域——而 sendfile 严格要求 out_fd 是 socket。 |
| 2. Reactor | Boss 线程 accept→Worker 线程 select | **为什么 Boss/Worker 分离？** 一个 Selector 线程可以管理 10000 个连接——但 `processEvents` 是串行的。如果 Boss 在同一 Selector 上同时处理 accept 和 I/O：当 100 个 SocketChannel 同时就绪 OP_READ 时，`processEvents` 逐个处理它们——Boss 线程可能需要 ~5ms 才能回到 `select()` 循环——在这 5ms 内，新到达的 TCP 连接在 accept queue 中等待。对于 10000 qps 的服务器，5ms 的 accept 延迟意味着 ~50 个连接在排队。Boss/Worker 分离：Boss 只做 accept（<1μs per accept），立即回到 select()——Worker 单独处理 I/O，互不阻塞。**更深一层：为什么 `interestOps` 变更不立即生效？** 不是 JDK 的设计缺陷——是 select() 的语义继承自 POSIX select/poll——它们在"调用时"传入 interest set，在下一次调用前内部状态不变。epoll 实际上支持"随时修改"——epoll_ctl 随时可用——JDK 选择 delay 是为了减少 syscall：10 个 channel 的 interest 变更 → batch 成 10 次 epoll_ctl 在一个 processUpdateQueue 中发出 vs 10 次 epoll_ctl 分散在各处。**代价：延迟生效 → 需要 wakeup() 强制中断 select() → 让新变更被下一轮 processUpdateQueue 处理。** 如果忘记 wakeup()——这就是"Selector stuck forever"的根因。 |
| 3. epoll bug 诊断 | kernel bug + 三步命令 | 本文档从**诊断视角**覆盖此问题（深度内核源码分析在 00 文档中）。需要讲清楚：1) **为什么诊断工具链能发现这个 bug**——strace 中的 `epoll_wait(5, [], 1024, -1) = 0` 在阻塞模式下不断重复，这是内核 bug 的唯一签名（正常的 epoll_wait 要么返回 >0，要么在 timeout 后返回 0，要么被 EINTR 中断返回 -1——**level-triggered 阻塞模式永远不会正常返回 0**）；2) **为什么 RecycledSelector 触发这个 bug**——因为同一个 epoll instance 内的 fd 计数从 1→0 触发了 `ep_remove` 的最后一个 watched fd 路径；3) **降级方案** `-Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider` 的工作原理——把整个 Selector 从 epoll 切换到 poll，牺牲 O(1) 换取正确性；4) **为什么升级 JDK 9+ 可以修复**——EPollArrayWrapper 在 `epoll_ctl(DEL)` 前先调 `epoll_ctl(epfd, MOD, fd, {0})` 清空 pending events，阻止 stale epitem 残留。 |
| 4. 诊断工具链 | 列出工具和命令 | **不是列出工具——是展示"诊断思维"。** strace 告诉你的：`sendfile64(10,15,...)=-1 EINVAL` 告诉你内核不支持这个 fd pair→Java 会降级到 mmap。`mmap(NULL,8M,...)`+`writev(10,...)` 连在一起告诉你"Java 在走 mmap fallback 路径"。`epoll_wait(5,[],1024,-1)=0` 不断重复告诉你"epoll bug"。**这些输出不是孤立的——它们组成一条"内核→Java→应用"的证据链。** |

### 每板块原理密度要求
1. Every paragraph opens with WHY
2. Kafka+Reactor code ~60 lines as anchor
3. 3-5 lines C/Java source per claim — 作为证据
4. 每个 300 行以上的板块必须包含至少 1 个反事实 + 1 个 Linux 内核原理引用
5. Mermaid dual: (1)sendfile kernel data path (2)Reactor Boss→Worker flow
6. GDB 7 assertions + strace + /proc + ss + jcmd
7. 6 Beginner callout boxes + Interview ~350 words
8. 12 interview questions with source verification
9. 7 production scenarios: symptom→root→diagnostic→fix
10. epoll bug at diagnostic perspective only (~400 lines)—reference 00 for deep kernel source analysis

---

## §七 Output Format

File: `02-ZeroCopy-Threads-Diag.md`, Path: `/data/workspace/openjdk-cut-new/probe_md/16-nio-network/`

Header:
```
> **阶段**：[16-nio-network]
> **前置**：[00-Server-Selector-Engine]（Selector engine, epoll bug deep analysis）、[01-Socket-Data-Close]（socket+DirectBuffer）
> **配套**：[00]（epoll bug reference）、[01]（SO_LINGER reference）
> **阅读收益**：sendfile64 zero-copy+Reactor multi-thread+production diagnostics complete chain
```
Target: ~5000 lines

---

## §八 Prohibited（≥10）

- ❌ sendfile64 说"fast"而不解释 why (0 user-space copies kernel path)
- ❌ 不提 3 fallbacks: transferToDirectly/transferToTrustedChannel/transferToArbitraryChannel
- ❌ 不提 capability detection: transferSupported/pipeSupported/fileSupported volatile cache
- ❌ register 后不提 wakeup trap: interestOps only enqueued in updateKeys
- ❌ lockAndDoSelect 不展示 synchronized(this)
- ❌ epoll bug deep repeat from 00: 400 line max, diagnostic perspective, reference 00 for kernel source analysis
- ❌ 不提 mmap auto-unmap: Cleaner/PhantomReference
- ❌ 不提 platform diff: Linux sendfile64/macOS sendfile/AIX send_file
- ❌ 不提 SO_LINGER RST vs FIN
- ❌ 不提 diagnostic toolkit: strace+GDB+/proc+ss+jcmd

---

## §九 Required（≥12）

- ✅ Kafka+Reactor code as opener
- ✅ Mermaid dual: (1)sendfile kernel path (2)Reactor Boss→Worker register flow
- ✅ FileChannelImpl.c: transferTo0(sendfile64) map0(mmap64) unmap0(munmap) 源码
- ✅ FileChannelImpl.java: transferTo+3 fallbacks+capability detection 源码
- ✅ SelectorImpl.java: lockAndDoSelect(synchronized)+inSelect 源码
- ✅ EPollSelectorImpl.java: setEventOps(updateKeys)+doSelect 源码
- ✅ epoll bug diagnostic perspective (~400 lines, reference 00)
- ✅ Diagnostics: strace(sendfile fallback)+GDB 7+/proc+ss+jcmd
- ✅ 12 interview questions (source+chain+counterfactual)
- ✅ 7 production scenarios lookup
- ✅ 6 Beginner Callout boxes
- ✅ Interview ~350 words

---

## §十 GDB + strace Verification（≥7 assertions）

```
断言 1: sendfile64 (FileChannelImpl.c transferTo0)
  (gdb) break Java_sun_nio_ch_FileChannelImpl_transferTo0; print dstFD→socket,srcFD→file,count→remaining

断言 2: mmap fallback (FileChannelImpl.c map0)
  (gdb) break Java_sun_nio_ch_FileChannelImpl_map0; print len→>0; next→mmap64 called

断言 3: lockAndDoSelect (SelectorImpl)
  (gdb) break SelectorImpl.lockAndDoSelect; print this→Selector instance

断言 4: dup2 trick (linux_close.c closefd)
  (gdb) break closefd; print fd2→closed fd; next→Layer1 lock→Layer2 dup2→Layer3 signal

断言 5: accept new fd (ServerSocketChannelImpl.c accept0)
  (gdb) break Java_sun_nio_ch_ServerSocketChannelImpl_accept0; print newfd→>0

断言 6: SO_ERROR (SocketChannelImpl.c checkConnect)
  (gdb) break Java_sun_nio_ch_SocketChannelImpl_checkConnect; print error→0/111/113

断言 7: SO_LINGER (Net.c setIntOption0)
  (gdb) break Java_sun_nio_ch_Net_setIntOption0; cond: opt==13; print arg→-1/0/N

strace sendfile fallback:
  strace -e trace=sendfile64,mmap,writev,munmap -p $(pgrep -f kafka) 2>&1 | head -10
  sendfile64(10,15,[0],8M)=8M→sendfile64(10,16,[8M],8M)=-1 EINVAL→mmap→writev→munmap
```

---

## §十一 Cross-Reference

1. 从 00: Selector engine+epoll bug deep analysis—本文 Reactor 复用 00 机制, epoll 诊断引用 00
2. 从 01: Socket lifecycle+DirectBuffer+SO_LINGER—本文 sendfile+Reactor+诊断使用这些
3. 从 README §二.4: sendfile64—本文 FileChannelImpl.c 验证内核路径+3 fallback
4. 从 README §二.7: Reactor—本文 SelectorImpl.java lockAndDoSelect 验证并发语义
5. 同组边界: 本文 zero-copy+m-thread+diag+QA+scenarios; 00 Selector engine; 01 socket+data+close
