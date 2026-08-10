Plan and write README.md for phase 16-nio-network (libnio.so + libnet.so). Two-step: FIRST verify source code extensively, THEN write README with verified content.

## Phase context (continuity MUST be explicit)
16 covers the I/O backbone of every production Java service. Netty, Tomcat, Kafka, gRPC — all of them depend on epoll Selector, SocketChannel, DirectByteBuffer. The reader finished 15-core-native (most-called native methods). Now they learn: how does a SINGLE thread manage 10,000 connections? How does DirectByteBuffer bypass GC heap? How does Kafka use sendfile to move 1GB/s without touching Java memory?

16 connects to:
- 09-native-interface: all Selector/SocketChannel/FileChannel are native-backed Java objects
- 11-os-layer: epoll_create/epoll_ctl/epoll_wait are POSIX syscalls
- 03-object-model: DirectByteBuffer is a Java object with a native memory address
- 05-jit-compiler: C2 can optimize DirectBuffer address loading
- 15-core-native: JNI_ENTRY used by all I/O native methods

## Step 1: Source code verification (MANDATORY first — ~20 files, read and report)

### EPoll Selector core (libnio):
**EPoll.c** (src/java.base/linux/native/libnio/ch/EPoll.c):
1. `Java_sun_nio_ch_EPoll_epollCreate()` — creates epoll fd. What's the size parameter? Since Linux 2.6.8, size is ignored. What value does Java pass?
2. `Java_sun_nio_ch_EPoll_epollCtl()` — ADD/MOD/DEL operations. Does Java use EPOLLET (edge-triggered) or level-triggered? Find the exact flags.
3. `Java_sun_nio_ch_EPoll_epollWait()` — blocks waiting for events. Timeout handling? Returns count of ready fds.

**EPollArrayWrapper.c** (src/java.base/linux/native/libnio/ch/EPollArrayWrapper.c):
4. How many events can epollWait return at once? Is there a max? How is the event array allocated?
5. How does Java map epoll_event back to SelectionKey? The fd→SelectionKey mapping mechanism.

**EPollSelectorImpl.java**: (src/java.base/linux/classes/sun/nio/ch/EPollSelectorImpl.java)
6. How does this Java class use EPoll native? What's the constructor flow? epollCreate → register existing channels?
7. How does wakeup work? The selector wakeup pipe mechanism.

**IOUtil.c** (src/java.base/share/native/libnio/ch/IOUtil.c):
8. How does native I/O read/write with DirectBuffer? Calls GetDirectBufferAddress → gets native pointer → read(fd, addr, len).
9. How does scatter/gather work with DirectBuffer? readv/writev system calls.

### SocketChannel native (libnet):
**PlainSocketImpl.c** (src/java.base/unix/native/libnet/):
10. Native socket creation: socket(AF_INET6, SOCK_STREAM, 0). How does dual-stack (IPv4 mapped IPv6) work?
11. bind / listen / accept — how does accept return a new fd? What's the backlog parameter?
12. connect — non-blocking connect with EINPROGRESS? How does Selector detect connection completion?

**linux_close.c** (src/java.base/linux/native/libnet/linux_close.c):
13. The dup2 trick — how does Java close a socket that another thread is blocked on? dup2(fd, -1) to invalidate fd → read returns EBADF → wake up.
14. What's the race condition? Another thread could create a NEW socket reusing the same fd number between dup2 and close. How does Java prevent this?

**SocketDispatcher.c** (src/java.base/unix/native/libnet/):
15. read / write — simple pread/pwrite or with scatter/gather? Nagle algorithm interaction (TCP_NODELAY)?

### FileChannel / sendfile:
**FileDispatcherImpl.c** (src/java.base/unix/native/libnio/ch/):
16. `Java_sun_nio_ch_FileDispatcherImpl_transferTo0()` — calls sendfile64(). Does it work with SocketChannel or only FileChannel? What's the Linux sendfile signature?
17. What if sendfile returns 0? Does the Java layer retry?

### DirectByteBuffer:
**Direct-X-Buffer.java.template** — DirectByteBuffer allocation.
18. How does DirectByteBuffer.allocateDirect() work? `Unsafe.allocateMemory(size)` → native pointer → wrap as Java Buffer.

### Selector thread model:
19. How does `Selector.wakeup()` work? Write 1 byte to wakeup pipe → epoll detects pipe readable → select() returns.

## Step 2: Write README

Output: probe_md/16-nio-network/README.md (target: 550+ lines)

### Quality mandate
- **Depth**: every claim from Step 1 source line numbers. EPOLLET flag verified? dup2 trick line number? sendfile signature?
- **Breadth**: cover epoll Selector + SocketChannel + DirectBuffer + FileChannel.sendfile + wakeup + socket options
- **Interview**: ≥10 Qs with concrete source-backed answers. NIO is THE most common I/O interview topic.
- **Continuity**: explicit connections to 09-JNI, 11-os-layer (epoll syscalls), 03-object-model (DirectBuffer memory)
- **First principles**: "If you designed a Java I/O framework from scratch, would you pick epoll or io_uring?"
- **Beginner**: epoll, edge-triggered vs level-triggered, DirectBuffer, zero-copy, sendfile, wakeup pipe — all defined

### Required sections

#### §〇 上手指南
- 3-tier reading paths (入门/进阶/专家)
- Prerequisites: 09-native-interface (JNI), 11-os-layer (epoll syscalls), 03-object-model (DirectByteBuffer), 15-core-native (native JNI patterns)
- 3-sentence essence: "Java NIO 不是 Java 的发明——它是 Linux epoll 的 JNI 包装。Selector 在一个线程上管理 10,000 个 Socket 连接——每个连接注册到 epoll fd。当数据到达时，epoll_wait 返回就绪 fd 集合——Java 层只处理就绪连接，不轮询空闲连接。DirectByteBuffer 允许数据从网卡直接读到 native 内存——跳过 GC 堆，达到零拷贝。"
- Core terminology table: epoll fd, EPOLLET edge-triggered, EPOLLIN/EPOLLOUT events, DirectByteBuffer native address, sendfile zero-copy, wakeup pipe, dup2 socket close trick, Reactor pattern, scatter/gather I/O, TCP_NODELAY, SO_LINGER, EINPROGRESS non-blocking connect

#### §一 The Selector Lifecycle (verified ASCII from Step 1)
```
Java: Selector.open()
  → native: EPollArrayWrapper.epollCreate() → epoll_create(size) → epoll fd
  → returns Selector object wrapping epoll fd

Java: ssChannel.register(selector, OP_ACCEPT)
  → native: EPoll.epollCtl(epfd, ADD, ssfd, EPOLLIN)
  → selection key added to fd→key map

Java: selector.select()
  → native: EPollArrayWrapper.epollWait(timeout)
  → kernel: blocks until any registered fd becomes ready
  → returns count of ready fds + event array

Java: selectedKeys iteration
  → for each ready fd: wakeup pipe? → wakeup(). socketfd? → OP_READ/OP_WRITE
  → process I/O, remove from selectedKeys

Java: sc.read(buf), sc.write(buf)
  → if buf is DirectBuffer: GetDirectBufferAddress → native pointer → read/write syscall
  → if buf is HeapBuffer: copy to temp native buffer → read/write → copy back
```
Every step has file:line from Step 1 verification.

#### §二 First-Principles Design Decisions (≥8, derived from Step 1)

1. **Why epoll instead of select/poll?**
select: O(n) — kernel iterates ALL fds to find ready ones. 10K fds → 10K checks per select() → 10ms wasted.
poll: same O(n) but supports more fds (no FD_SETSIZE limit of 1024).
epoll: O(1) — kernel maintains ready list internally. Only returns ready fds → 1 check per ready fd → 100x faster for 10K connections.
Plus: epoll supports edge-triggered (EPOLLET) — notifies ONCE when data arrives, not every time you call epoll_wait. Forces the user to read ALL data before next wait → resolves starvation.

2. **Why edge-triggered (EPOLLET) instead of level-triggered?**
Level-triggered: "fd still has data → keep telling you." epoll_wait returns the same fd every time until you read it → 1000 useless wakeups for 1 slow connection.
Edge-triggered: "new data arrived → tell you ONCE." Forces you to read until EAGAIN. Risk: if you read 4KB of 8KB data, edge-triggered won't tell you about remaining 4KB → must use non-blocking sockets and read fully.
Java NIO uses edge-triggered: forces the programming model to be more efficient.

3. **Why DirectByteBuffer for I/O instead of HeapBuffer?**
HeapBuffer: bytes in Java heap → GC can move them → can't pass address to kernel (write syscall would write garbage if GC moved data mid-I/O).
DirectBuffer: bytes in native memory (off-heap) → address stable → kernel can read/write directly. Zero-copy from NIC → kernel socket buffer → DirectBuffer (no Java heap copy).
Cost: allocation via Unsafe.allocateMemory → slower than new byte[]. Deallocation: Cleaner/PhantomReference → lag before GC detects unreachable. Tradeoff: allocation cost vs I/O speed (10-100x for large buffers).

4. **Why sendfile for FileChannel.transferTo?**
Without sendfile: disk→kernel buffer→user buffer (Java)→kernel buffer (socket)→NIC (4 copies, 2 context switches).
With sendfile: disk→kernel buffer→socket buffer→NIC (2 copies IN KERNEL, 0 copies to user space, 1 context switch). Zero-copy. Kafka uses sendfile to serve topics: file on disk → sendfile → socket → consumer. 1GB/s with <5% CPU.
Limitation: only works from FileChannel to SocketChannel, not arbitrary streams.

5. **Why the dup2 trick for socket close?**
Problem: Thread A blocked in read(sockfd, buf, len). Thread B calls Socket.close(). On Linux: close(sockfd) → fd freed but read() does NOT return → thread A blocked forever.
dup2 trick: dup2(dev_null_fd, sockfd) → replaces sockfd with /dev/null → read on /dev/null returns EBADF → thread A wakes up. Then close the dup'd fd.
Race: between dup2 and close, another thread could open a NEW socket reusing the same fd number. Java prevents this by holding the fd lock across both operations.

6. **Why non-blocking connect with EINPROGRESS?**
Blocking connect: thread blocks until TCP handshake completes → 1-3s for remote host → 10K connections × 3s = 30,000s (8 hours).
Non-blocking connect: socket non-blocking → connect() returns EINPROGRESS immediately → register fd with Selector for OP_CONNECT → epoll_wait returns when handshake completes. 10K connections all started in parallel → 3s total.

7. **Why 1 Selector thread for 10K connections?**
BIO (Blocking I/O): 1 thread per connection → 10K threads × 1MB stack = 10GB memory → context switching kills CPU.
NIO: 1 Selector thread → epoll_wait returns ready fds → thread processes only active connections → other 9,900 idle connections cost ZERO CPU. Same memory: ~100MB (with DirectBuffers).

8. **Why wakeup pipe instead of signal?**
epoll_wait blocks thread. To wake it up (e.g., to register new channel): write 1 byte to wakeup pipe. epoll sees pipe fd has EPOLLIN → returns from epoll_wait → Selector thread processes wakeup → reads pipe → clears event.
Counterfactual: "If signal (SIGUSR1): kernel delivers signal → signal handler runs → modifications to Selector state FROM signal handler → race condition with normal Selector thread → non-trivial locking. Pipe: same thread context, no signal-safety issues."

#### §三 Source Files Table (populated from Step 1, ~15 files)
| File | Lines | Key Functions | Role |
|---|---|---|
(Key files: EPoll.c, EPollArrayWrapper.c, IOUtil.c, PlainSocketImpl.c, linux_close.c, SocketDispatcher.c, FileDispatcherImpl.c, EPollSelectorImpl.java, DirectByteBuffer template, + platform variants for MacOS/Windows)

#### §四 Document Plan (5-6 docs)

### 00-Epoll-Selector.md — the event loop engine
**Core ❓**: "一个线程管理 10,000 个 Socket——Selector 怎么做到 epoll_wait 只返回就绪 fds 而不是轮询所有 fds？"

**Production**: "Selector 线程 100% CPU——epoll_wait 没有阻塞而是不断返回 0——因为某个 channel 注册了 OP_CONNECT 但已连接状态没被清除。每次 epoll_wait 返回这个 channel 为 ready → 浪费 CPU。"

**Coverage**: EPollSelectorImpl.open → epollCreate → epollCtl ADD/MOD/DEL → epollWait → pollWrapper → fdToKey mapping → updateSelectedKeys → remove from selectedKeys → wakeup pipe mechanism.
**Source**: EPoll.c, EPollArrayWrapper.c, EPollSelectorImpl.java

### 01-SocketChannel-Native.md — socket lifecycle
**Core ❓**: "ServerSocketChannel.accept() 返回一个 SocketChannel——native 层 socket/bind/listen/accept 全链路是什么？"

**Production**: "Too many open files——accept 创建新 fd，但 ulimit -n 限制为 1024。每个新连接消耗 1 个 fd → 1025th 连接 → IOException: Too many open files。"

**Coverage**: socket(AF_INET6, SOCK_STREAM) → bind → listen(backlog) → accept → EINPROGRESS non-blocking connect → dual-stack IPv4 mapped IPv6.
**Source**: PlainSocketImpl.c, SocketDispatcher.c

### 02-DirectByteBuffer-IO.md — zero-copy I/O
**Core ❓**: "SocketChannel.read(DirectBuffer)——数据怎么从网卡直接读到 DirectBuffer 而不经过 Java heap？"

**Production**: "OOM with DirectBuffer——ByteBuffer.allocateDirect(10MB) fails because maxDirectMemory exceeded. DirectBuffer 在年轻代 GC 时不会被回收→需要 Full GC 或 System.gc() 才能回收。"

**Coverage**: Unsafe.allocateMemory → native address → GetDirectBufferAddress → read(fd, addr, len) → Cleaner deallocation → maxDirectMemory limit.
**Source**: IOUtil.c, Direct-X-Buffer template

### 03-FileChannel-sendfile.md — kernel zero-copy
**Core ❓**: "Kafka 怎么用 FileChannel.transferTo 实现 1GB/s 零拷贝？sendfile64 的系统调用签名是什么？"

**Production**: "sendfile returns 0—Linux 2.4 kernel bug: sendfile returns 0 instead of -1 for non-socket output fds. Java must retry. In JDK 8, if sendfile is not supported for this fd pair: fall back to byte[] copy."

**Coverage**: transferTo0 → sendfile64(fd_out, fd_in, offset, count) → splice (kernel pipe zero-copy) → mmap fallback → retry logic for partial writes.
**Source**: FileDispatcherImpl.c

### 04-Selector-Thread-Model.md — Reactor pattern
**Core ❓**: "Netty 的 Boss-Worker Reactor 模型——多个 Selector 线程同时 select() 会竞争吗？Selector.wakeup 怎么做到非阻塞？"

**Production**: "Selector.select() not returning——另一个线程调用了 key.interestOps() 但没有调用 selector.wakeup()。Selector 不知道 interest set 改变了 → 继续等待旧的事件集上的事件。"

**Coverage**: Reactor pattern → single-threaded Selector → Boss thread accepts → Worker threads process I/O → wakeup mechanism → wakeup pipe contention → JDK epoll bug 100% CPU spin.
**Source**: EPollSelectorImpl (wakeup), SelectorImpl

### 05-Socket-Options-Native.md — TCP tunables
**Core ❓**: "SO_LINGER, TCP_NODELAY, SO_KEEPALIVE, SO_RCVBUF——这些在 native 层怎么通过 setsockopt 设置？"

**Production**: "TIME_WAIT flood——30000 TIME_WAIT connections → can't open new connections → SO_LINGER with linger=0 sends RST instead of FIN → skip TIME_WAIT (but unsafe for data loss)."

**Coverage**: setsockopt → SO_LINGER (time + enabled), TCP_NODELAY (disable Nagle), SO_KEEPALIVE, SO_RCVBUF/SO_SNDBUF, SO_REUSEADDR.
**Source**: PlainSocketImpl.c, Net.c

#### §五 Interview Questions (≥10, verified from Step 1)

1. "epoll vs select/poll — 为什么？" → 00: select O(n)=10K scans for 10K fds. epoll O(1)=returns only ready fds. Plus edge-triggered.
2. "DirectByteBuffer vs HeapBuffer — 为什么 NIO 用 Direct?" → 02: heap address unstable (GC moves). Direct address stable → kernel can DMA. Zero-copy.
3. "sendfile 怎么做到零拷贝？" → 03: disk→kernel→socket→NIC, 2 copies (both in kernel), zero user-space copy.
4. "Selector.wakeup 怎么实现？" → 04: write 1 byte to pipe → epoll detects readable → select() returns.
5. "NIO non-blocking connect 怎么工作？" → 01: socket(O_NONBLOCK) → connect(EINPROGRESS) → register OP_CONNECT → epoll_wait → getsockopt(SO_ERROR) checks success.
6. "dup2 trick 为什么需要？" → 05: close(fd) while thread reads → read doesn't return on Linux. dup2 to /dev/null → EBADF → wake up.
7. "Reactor 模型 — Boss+Worker 线程怎么分工？" → 04: Boss = accept → register Worker selector. Worker = process I/O. Boss doesn't touch data.
8. "EDGE-triggered vs level-triggered — 区别？" → 00: Edge notifies ONCE per data arrival → forces full read. Level keeps notifying → starvation for slow connections.
9. "maxDirectMemory 限制是什么？为什么需要？" → 02: -XX:MaxDirectMemorySize=10G. DirectBuffer not GC'd in young gen → need explicit limit.
10. "SO_LINGER=0 强制 RST 跳过 TIME_WAIT — 危险在哪？" → 05: Data loss if socket buffer has unacked data. Use only for idempotent connections.

#### §六 Production Scenarios (≥5, with exact errors)

| Scenario | Symptom | Doc | Diagnostic |
|---------|---------|-----|------------|
| Selector 100% CPU spin | select() returns 0 immediately in tight loop | 00 | JDK epoll bug: pollWrapper.c events corrupted. Fix: `-Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider` |
| Too many open files | IOException: Too many open files | 01 | `ulimit -n 65536`. Each connection = 1 fd. 10K connections + stdin/out/err + JAR files. |
| OOM with DirectBuffer | OutOfMemoryError: Direct buffer memory | 02 | `-XX:MaxDirectMemorySize=1G`. Check netty buffer pool settings. |
| sendfile returns 0 | FileChannel.transferTo not working on socket | 03 | Java retry: if sendfile unsupported for fd pair → mmap fallback. Kernel version mismatch. |
| TIME_WAIT flood | 30000+ TIME_WAIT sockets, can't accept new | 05 | SO_LINGER=0 → RST skip TIME_WAIT. Or: SO_REUSEADDR + lower tcp_fin_timeout. |

#### §七 Quality Audit Matrix (5-6 planned docs)

#### §八 Deep Questions (≥12, 5 tiers)
Tier 1 Basic: "为什么需要 NIO？BIO 有什么问题？" "epoll fd 是什么？"
Tier 2 Design: "为什么选择 edge-triggered 而不是 level-triggered？" "为什么 wakeup 用 pipe 而不是信号？"
Tier 3 Performance: "DirectBuffer 的分配成本 vs HeapBuffer 的 I/O 成本——break-even 是多少？" "sendfile 和 mmap 的区别——什么时候用哪个？"
Tier 4 Production: "Kafka 为什么用 sendfile 而不是 DirectBuffer 读+SocketChannel 写？" "Netty 的 PooledByteBufAllocator 怎么减少 DirectBuffer 分配成本？"
Tier 5 Future: "如果 Linux 有 io_uring——Java 的 NIO 怎么演进？" "Project Loom 的 Virtual Thread——Selectors 还需要吗？"

#### §九 Cross-Phase Connections
| Phase | Connection |
|-------|-----------|
| 09-native-interface | JNI entry points for all native I/O methods |
| 11-os-layer | epoll_create/epoll_ctl/epoll_wait syscall signatures, dup2, sendfile |
| 03-object-model | DirectByteBuffer object layout, Cleaner/PhantomReference lifecycle |
| 05-jit-compiler | C2 optimization of DirectBuffer address loading |
| 15-core-native | JNI_ENTRY/JVM_ENTRY pattern applied to I/O natives |
