# PROMPT: 请撰写 01-Socket-Data-Close.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

`java.io.IOException: Too many open files` at `ServerSocketChannel.accept()`. Server crashes at ~1020th connection during peak traffic.

Every new TCP connection consumes 1 file descriptor. `ulimit -n` defaults to 1024 → after accounting for stdin(0), stdout(1), stderr(2), JAR fd(3), listen fd(4), epoll fd(5), wakeup pipe fds(6,7) → ~1016 remain for client connections. The 1017th connection triggers `accept()` → kernel `socket()` returns -1 + errno=EMFILE. Java side: `ServerSocketChannelImpl.accept()` calls `accept0()` (ServerSocketChannelImpl.c:77) → POSIX `accept(fd, &sockaddr, &addrlen)` → returns -1 → EMFILE → `JNU_ThrowIOExceptionWithLastError` → `IOException("Too many open files")`.

The server doesn't crash gracefully—it throws an IOException from `accept()`, but the Selector loop continues trying. Each iteration: `select()` returns OP_ACCEPT ready (the listen fd still has backlog) → `accept()` throws IOException → loop repeats. Effective denial-of-service.

还有一个场景：你写了一个 NIO client, `connect()` 调用后立即返回了——但 `finishConnect()` 返回 false，你不知道连接是成功了还是失败了。或者你分配了 `ByteBuffer.allocateDirect(8192)` → `channel.read(buf)` → 数据到底存在 GC heap 还是 native 内存？最后：你的服务器调用 `channel.close()`，但那个阻塞在 `read()` 上的线程再也没有醒来——fd 泄漏 + 线程泄漏。

**三步诊断**：

```bash
# 1. Check fd limit and consumption
ulimit -n; cat /proc/{pid}/limits | grep "Max open files"; ls -l /proc/{pid}/fd | wc -l

# 2. strace confirm accept EMFILE + connect EINPROGRESS
strace -e trace=accept,connect -p $(pgrep -f java) 2>&1 | head -10
# accept(4,...) = -1 EMFILE; connect(8,{AF_INET6,...}) = -1 EINPROGRESS

# 3. DirectBuffer native memory usage
jcmd $(pgrep -f java) VM.native_memory summary | grep "Other"
```

**反事实**: fd pool (pre-open /dev/null × 65536 + dup2) 可绕过 ulimit 但 lifecycle 不可维护。connect 反事实：不检查 SO_ERROR → 应用认为已连接 → read()→-1+ENOTCONN → 根因远离数百行。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

This document starts from **NIO client connect + server read/write code** (~40 lines) and traces every line through Java NIO → JNI → Linux kernel. ENGINEERING documentation with file:line references.

Reader completed **00-Server-Selector-Engine** (Selector register/select/wakeup, epoll engine, fdToKey). This doc: **how `connect()`/`read(DirectBuffer)`/`close()` actually work** — from your Java code to the Linux kernel's TCP state machine.

### 你写的代码（引子）

**Client**:
```java
SocketChannel sc = SocketChannel.open(); sc.configureBlocking(false);
sc.connect(new InetSocketAddress("192.168.1.1", 8080));
Selector sel = Selector.open(); sc.register(sel, OP_CONNECT);
sel.select();
if (sc.finishConnect()) { sc.register(sel, OP_READ); }
```

**Server**:
```java
SocketChannel client = server.accept();
client.configureBlocking(false); client.register(sel, OP_READ);
ByteBuffer buf = ByteBuffer.allocateDirect(8192); client.read(buf); buf.flip(); client.write(buf);
client.close();
```

### 板块规划（7 板块）

| # | 板块 | 行数 | 核心 |
|---|------|:---:|------|
| 1 | 非阻塞 connect() | ~800 | Net.connect0→EINPROGRESS→IOS_UNAVAILABLE→epoll EPOLLOUT→checkConnect (poll+SO_ERROR)→tcp_syn_retries |
| 2 | SocketChannel 状态机 | ~300 | 五态+translateInterestOps |
| 3 | accept() 完整路径 | ~500 | accept0→ECONNABORTED retry→EAGAIN→EMFILE→SecurityManager→fd leak guard |
| 4 | read(DirectBuffer) **5子板块** | ~1600 | 4a.allocateDirect(~400) 4b.read0+DMA(~400) 4c.HeapBuffer(~200) 4d.ScatterGather(~300) 4e.Deallocator(~300) |
| 5 | Socket Options | ~700 | SO_LINGER(RST/FIN)+TCP_NODELAY+SO_KEEPALIVE+SO_RCVBUF/SO_SNDBUF+IP_TOS |
| 6 | close() dup2 trick | ~1000 | lock+dup2(marker_fd,fd)+WAKEUP_SIGNAL+BLOCKING_IO_RETURN_INT+BIO vs NIO close |
| 7 | BIO vs NIO 对比 | ~400 | PlainSocketImpl vs Net 两套 C 实现+SocketAdaptor overhead |

### Interview Story Format Answer（~350字）

"Java NIO's socket lifecycle wraps POSIX socket/bind/listen/accept/connect with non-blocking mode, dup2 safe-close, and IPV6_V6ONLY=0 dual-stack. `Net.socket0()`(Net.c:193-277)→`socket(AF_INET6)`→`setsockopt(IPV6_V6ONLY,0)`. Non-blocking `connect()`→`Net.connect0()`(Net.c:306-327)→EINPROGRESS→`IOS_UNAVAILABLE`(-2)—NOT an error. Java registers OP_CONNECT, epoll_wait returns EPOLLOUT, `checkConnect()`(SocketChannelImpl.c:49-88) two-step: `poll(fd,POLLOUT)` then `getsockopt(fd,SO_ERROR)`. Data I/O: `channel.read(DirectBuffer)`→`IOUtil.read`→`((DirectBuffer)buf).address()+pos`→`FileDispatcherImpl.read0`→`read(fd,ptr,len)`—DMA to native memory, zero GC heap copies. DirectBuffer lifecycle: `Unsafe.allocateMemory`→`Cleaner.create(new Deallocator)`→PhantomReference→Cleaner thread→`Unsafe.freeMemory`. HeapBuffer fallback: temporary DirectBuffer+2 memcpy. Scatter/Gather: `IOVecWrapper`→native `struct iovec[]`→`readv/writev`. dup2 trick (linux_close.c:275-321): direct `close(fd)` doesn't wake blocked reader. Three layers: `pthread_mutex_lock`→`dup2(marker_fd,fd)` replaces fd with shutdown AF_UNIX endpoint→`pthread_kill(thr,WAKEUP_SIGNAL=SIGRTMAX-2)`→blocked read() returns EBADF. `BLOCKING_IO_RETURN_INT` provides post-I/O verification on BIO paths."

### Beginner Callout Boxes（6 个）

1. **EINPROGRESS**: Net.c:319→IOS_UNAVAILABLE(-2). NOT error. Two-step: epoll EPOLLOUT + getsockopt SO_ERROR. Source: Net.c:306-327, SocketChannelImpl.c:49-88.

2. **dup2 trick**: Three layers: lock→dup2(marker_fd,fd)→pthread_kill(WAKEUP_SIGNAL)→EBADF return. `BLOCKING_IO_RETURN_INT` post-verify. Source: linux_close.c:275-366.

3. **DirectBuffer**: `Unsafe.allocateMemory`→native ptr→DMA direct write. No young GC→PhantomReference→Cleaner thread→`freeMemory`. MaxDirectMemorySize quota. Source: Direct-X-Buffer.java.template.

4. **Scatter/Gather**: `IOVecWrapper`→native `struct iovec[]`→`readv(fd,iov,cnt)` one syscall per N buffers. Source: IOVecWrapper.java, FileDispatcherImpl.c:99-105.

5. **SocketChannel state machine**: UNCONNECTED(0)→PENDING(1)→CONNECTED(2)→KILLPENDING(3)→KILLED(4). translateInterestOps maps state→epoll events. Source: SocketChannelImpl.java.

6. **SO_LINGER**: `struct linger{l_onoff,l_linger}`→RST(skip TIME_WAIT) vs FIN→TIME_WAIT(60s). Net.c:446-497.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Sources: `Net.c`(814L socket0/connect0/bind0/listen/setIntOption0), `PlainSocketImpl.c`(1038L socketCreate/socketConnect BIO poll loop/socketClose0), `linux_close.c`(450L closefd/BLOCKING_IO_RETURN_INT/NET_Read/Accept), `ServerSocketChannelImpl.c`(~200L accept0+initIDs), `SocketChannelImpl.c`(~250L checkConnect), `Direct-X-Buffer.java.template`(543L allocateDirect/Cleaner/Deallocator), `IOUtil.java`(~400L read/write+heap fallback), `FileDispatcherImpl.c`(373L read0/write0/readv0/writev0), `IOVecWrapper.java`(162L native iovec builder). Build: `make jdk`. Binaries: `libnet.so`+`libnio.so`.

---

## §三 Source Files Table

| # | File | Lines | Core Functions | Role |
|---|------|:--:|-------|------|
| 1 | Net.c | 814 | socket0(:193) connect0(:306) bind0(:280) listen(:299) setIntOption0(:446) handleSocketError(:782) | 🔥 NIO |
| 2 | PlainSocketImpl.c | 1038 | socketCreate(:159) socketConnect(:227 BIO poll) socketClose0(:769) | 🔥 BIO |
| 3 | linux_close.c | 450 | closefd(:275 lock+dup2+signal) BLOCKING_IO_RETURN_INT(:352) | 🔥 Close |
| 4 | ServerSocketChannelImpl.c | ~200 | accept0(:77 ECONNABORTED+EAGAIN+EMFILE) | Accept |
| 5 | SocketChannelImpl.c | ~250 | checkConnect(:49 poll+SO_ERROR+POLLHUP) | Connect verify |
| 6 | Direct-X-Buffer.java.template | 543 | allocateDirect→Cleaner+Deallocator address() | Buffer lifecycle |

---

## §四 Deep Dive Question Groups（≥8）

### 4.1 ★★★ 非阻塞 connect — EINPROGRESS 两步验证

```
问题：
  ① Net.c:306-327 connect0 — EINPROGRESS → Java 如何验证连接结果？
      答案方向: Net.c connect0 核心:
          rv = connect(fdval(env, fdo), &sa.sa, sa_len);
          if (rv != 0) {
              if (errno == EINPROGRESS) return IOS_UNAVAILABLE;  // step 1
              else if (errno == EINTR) return IOS_INTERRUPTED;
              else return handleSocketError(env, errno);
          }
          return 1;  // 立即成功 (localhost, 罕见)

        Java: IOS_UNAVAILABLE(-2) → SocketChannelImpl 注册 OP_CONNECT →
        epoll_wait 返回 EPOLLOUT → finishConnect() → checkConnect() (SocketChannelImpl.c:49-88):
          poll(fd, POLLOUT) 确认可写 → getsockopt(fd, SOL_SOCKET, SO_ERROR) 确认无 error
          → 最后检查 POLLHUP (line 81-82) 处理握手期间 RST

        追问: 为什么两步验证 (EPOLLOUT + SO_ERROR)？
        → EPOLLOUT 只表示 socket 可写——连接成功和连接被拒(RST)都会使 socket 可写。
          getsockopt SO_ERROR 区分二者。常见值: 0=成功 ECONNREFUSED=端口无监听 EHOSTUNREACH=路由不可达

        追问: connect timeout 谁控制？
        → 内核: /proc/sys/net/ipv4/tcp_syn_retries (default 6) → 1+2+4+8+16+32=63s→~127s total
          Java: Selector.select(timeout) 控制等待时间 → finishConnect 失败→SocketTimeoutException

  ② Counterfactual: 不检查 SO_ERROR → 应用认为已连接 → read()→-1+ENOTCONN → 根因远离数百行
      决策点: SocketChannelImpl.c:76 getsockopt SO_ERROR 是必须的第二步
```

### 4.2 ★★★ accept0 — ECONNABORTED retry + EMFILE

```
问题：
  ① ServerSocketChannelImpl.c:77-119 accept0 如何从内核获取新 client fd？
      答案方向: accept0 核心:
          for (;;) {
              newfd = accept(ssfd, &sa.sa, &sa_len);
              if (newfd >= 0) break;
              if (errno != ECONNABORTED) break;  // 非 ECONNABORTED→退出
              /* ECONNABORTED => restart */
          }
          if (newfd < 0) {
              if (errno == EAGAIN) return IOS_UNAVAILABLE;
              if (errno == EINTR) return IOS_INTERRUPTED;
              JNU_ThrowIOExceptionWithLastError(env, ...);
              return IOS_THROWN;  // EMFILE 落这里
          }
        ECONNABORTED: client SYN→server accept()唤醒→client RST before accept returns→重试
        Java: configureBlocking(true)→accept0(fd)→SecurityManager.checkAccept→configureBlocking(false)
        SecurityException→newfd must close in catch

        追问: 为什么临时阻塞？→ 非阻塞无连接 EAGAIN→busy-wait。阻塞→内核挂起线程→零CPU

  ② Counterfactual: 永远非阻塞→EAGAIN→反复重试→busy-wait
      决策点: ServerSocketChannelImpl.java temporarily-blocking 设计
```

### 4.3 ★★★ DirectBuffer 分配 + I/O 数据路径（5 子问题）

```
问题：
  ① allocateDirect(8192) 分配链路？read(DirectBuffer) 数据怎么到达？

      ①a. 分配 (Direct-X-Buffer.java.template):
          Bits.reserveMemory(size, cap)            // [1] MaxDirectMemorySize 配额
          long base = UNSAFE.allocateMemory(size)  // [2] malloc in C heap
          UNSAFE.setMemory(base, size, (byte)0)    // [3] 清零
          this.address = base                      // [4] 存储 native ptr as Java long
          cleaner = Cleaner.create(this, new Deallocator(base, size, cap)) // [5] PhantomReference

      ①b. 读取路径:
          IOUtil.java: ((DirectBuffer)buf).address() + pos → native addr
          FileDispatcherImpl.c read0:
            void *buf = (void *)jlong_to_ptr(address);          // Java long→C ptr
            return convertReturnVal(env, read(fd, buf, len), JNI_TRUE);
          内核: TCP socket buffer→tcp_recvmsg()→copy_to_user()→DMA→DirectBuffer native addr
          convertReturnVal: n>0→n bytes, n==0→IOS_EOF, EAGAIN→IOS_UNAVAILABLE, EINTR→IOS_INTERRUPTED

      ①c. HeapBuffer fallback: 无 stable address→分配临时 DirectBuffer→put heap→native→read
          →get native→heap → 额外 2 次 memcpy。开销: ~2ms for 1MB buffer

      ①d. Scatter/Gather: IOVecWrapper→native struct iovec[]→readv(fd,iov,cnt)/writev(fd,iov,cnt)
           一次 syscall 处理 N 个 buffer。putBase(i,addr) putLen(i,len)

      ①e. Deallocator: GC→DirectByteBuffer unreachable→PhantomReference→Cleaner线程→
          Unsafe.freeMemory(address)+Bits.unreserveMemory → 释放 native 内存

      追问 a: 为什么 DirectBuffer 不在年轻代 GC 时回收？
      → Java 对象(~100B)在 heap→GC 可回收, 但 native 内存(8KB)在堆外→GC 不追踪。
        PhantomReference 延迟→必须 Full GC+Cleaner。这就是 MaxDirectMemorySize 存在的原因。

      追问 b: OOM 场景: MaxDirectMemorySize 耗尽 → DirectBuffer 堆外内存不被 young GC 回收
      → 必须 Full GC 触发 Cleaner → 如果 -XX:+DisableExplicitGC 则 System.gc() 无效

  ② Counterfactual: 不用 DirectBuffer → 每次 I/O: kernel→temp native→heap (2 memcpy)
      DirectBuffer: kernel→native (1 DMA copy)。复用场景 ~20x faster
      决策点: Direct-X-Buffer.java.template allocateDirect 为长期复用而设计
```

### 4.4 ★★★ dup2 trick — closefd 的三层防护

```
问题：
  ① linux_close.c:275-321 closefd 三层防护分别是什么？竞态如何被防止？
      答案方向: closefd 完整流程:
          pthread_mutex_lock(&(fdEntry->lock));   // Layer 1: 锁

          if (fd1 < 0) {
              rv = close(fd2);                    // NET_SocketClose
          } else {
              do { rv = dup2(fd1, fd2); } while (rv==-1 && errno==EINTR); // Layer 2: dup2
          }

          threadEntry_t *curr = fdEntry->threads;
          while (curr != NULL) {
              curr->intr = 1;
              pthread_kill(curr->thr, WAKEUP_SIGNAL); // Layer 3: signal (SIGRTMAX-2)
              curr = curr->next;
          }

          orig_errno = errno; pthread_mutex_unlock(&(fdEntry->lock)); errno = orig_errno; return rv;

        Layer 2: marker_fd = AF_UNIX socketpair 的 shutdown 端点→dup2 后 fd→marker→阻塞 read()→EBADF
        Layer 3: sig_wakeup()(linux_close.c:99) 空 handler 仅中断 syscall→read() 返回 EINTR
        双保: EBADF(dup2) + EINTR(signal)

        BLOCKING_IO_RETURN_INT (linux_close.c:352-366):
          #define BLOCKING_IO_RETURN_INT(FD, FUNC) { \
              startOp(fdEntry,&self); ret = FUNC; endOp(fdEntry,&self); \
          } while (ret == -1 && errno == EINTR);
          endOp 检查: if (fdEntry->intr) errno=EBADF; ret=-1;

        追问: NIO epoll_wait 需要 BLOCKING_IO_RETURN_INT 吗？
        → 不需要。epoll instance 持有 fd 引用→dup2 后仍可检测 fd 关闭。
          BIO read(fd) 直接操作 fd 号→需要此宏验证。

  ② Counterfactual: 只用 close(fd) 不 dup2 → 阻塞 read() 线程可能永不被唤醒
      决策点: linux_close.c closefd 的 dup2 是 Linux 唯一可靠唤醒机制
```

### 4.5 ★★★ socket() — AF_INET6 + IPV6_V6ONLY=0 dual-stack

```
问题：
  ① Net.c:193-277 socket0 如何创建双栈 socket？
      答案方向: domain = (ipv6_available() && preferIPv6) ? AF_INET6 : AF_INET; fd=socket(domain,type,0);
        if (domain == AF_INET6) { int arg=0; setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &arg, sizeof(arg)); }
        if (reuse) { setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, 1); }
        内核映射: IPv4 sockaddr_in → ::ffff:a.b.c.d mapped IPv6
        PlainSocketImpl.c:159-216 socketCreate 同逻辑, 额外 SET_NONBLOCKING(fd)

        追问: 为什么 JDK 默认 AF_INET6？→ 单 socket 双 IP 版本, fd/Selector/epoll_ctl 减半
        追问: SO_REUSEADDR 服务器 vs 客户端差异？→ 服务器传 reuse=true, 客户端 false

  ② Counterfactual: IPV6_V6ONLY=1→AF_INET+AF_INET6 两套 socket→双倍消耗
      决策点: Net.c:207-216 setsockopt(arg=0)
```

### 4.6 ★★★ bind() listen() — 端口绑定 + 队列截断

```
问题：
  ① Net.c:280-303 bind0+listen0 — backlog 如何被内核静默截断？
      答案方向: bind0: POSIX bind(fd,&sockaddr)→EADDRINUSE→BindException
        listen: actual_backlog = min(backlog, /proc/sys/net/core/somaxconn) 默认 128
        两个队列: SYN queue(tcp_max_syn_backlog) + accept queue(min(backlog,somaxconn))
        ss -lnt: Recv-Q 积压→已完成握手等待 accept→消费<到达

        追问: SO_REUSEADDR 与 TIME_WAIT 交互？→ 服务器重启, 旧连接 TIME_WAIT 60s→bind EADDRINUSE→SO_REUSEADDR 允许复用
        追问: SYN flood 影响？→ SYN queue 满→合法 SYN 被丢→tcp_syncookies=1 缓解

  ② Counterfactual: somaxconn=128 而 backlog=1024→129后 SYN 被丢→client Connection timed out→根因被 somaxconn 掩盖
      决策: sysctl -w net.core.somaxconn=4096
```

### 4.7 ★★★ Socket Options — SO_LINGER / TCP_NODELAY

```
问题：
  ① Net.c:446-497 setIntOption0 setsockopt 如何设 socket 选项？
      答案方向: SO_LINGER: parg=&linger; arglen=sizeof(linger)
        if (arg>=0) { linger.l_onoff=1; linger.l_linger=arg; } else { l_onoff=0; }
        setsockopt(fd, SOL_SOCKET, SO_LINGER, parg, arglen)
        l_onoff=1,l_linger=0→close()发 RST→跳过 TIME_WAIT(60s)→不保证数据完整
        l_onoff=1,l_linger=N→close()最多阻塞 N 秒
        l_onoff=0→正常 FIN→TIME_WAIT→保证数据完整但端口不能复用
        TCP_NODELAY(disable Nagle), SO_KEEPALIVE, SO_RCVBUF/SO_SNDBUF, IP_TOS

        追问: getsockopt SO_ERROR 在 connect 后？→ 返回 pending error: 0/ECONNREFUSED/EHOSTUNREACH, 获取后清除

  ② Counterfactual: 所有 close 都发 RST→零 TIME_WAIT 但数据可能丢失→peer 收到 Connection reset
      决策: 根据场景选择 SO_LINGER
```

### 4.8 ★★★ PlainSocketImpl.c BIO vs Net.c NIO

```
问题：
  ① 为什么同一 socket 功能有两套 C 实现？
      答案方向: PlainSocketImpl.c (libnet.so) = java.net.Socket BIO:
        socketConnect(:227-426) → SET_NONBLOCKING→connect→EINPROGRESS→poll(POLLOUT)循环→getsockopt→SET_BLOCKING
        ~400行, 含超时+SO_LINGER+SO_KEEPALIVE。历史: JDK 1.0(1996)早于 NIO(JDK 1.4,2002)
        Net.c (libnio.so) = NIO: connect0(:306-327)→EINPROGRESS→立即返回 IOS_UNAVAILABLE, ~20行
        共享: linux_close.c closefd, IPV6_V6ONLY=0, SO_REUSEADDR

        追问: SocketAdaptor 如何模拟阻塞 I/O？→ SocketAdaptor.java(~300)包装 SocketChannel→
          getInputStream→ChannelInputStream→若 channel.read=0→Selector.select() 等待→模拟阻塞
          ~2-3μs extra overhead per operation

  ② Counterfactual: 去掉 PlainSocketImpl.c→所有 Socket→NIO SocketAdaptor→遗留 BIO 代码退化
      决策: 两套并存是向后兼容的务实选择
```

---

## §五 Article Structure

```
§〇 生产场景 — EMFILE+EINPROGRESS+close deadlock+OOM DirectBuffer
§一 ★★★ Client+Server Data Path 全链路源码走读
  1.1 non-blocking connect 1.2 state machine 1.3 accept() 1.4 read(DirectBuffer) 5子板  
  1.5 socket options 1.6 close() dup2 1.7 BIO vs NIO 1.8 Mermaid 1.9 Interview Answer
§二 ★★★ 6 Beginner Callout 框
§三 ★★ Diagnostics (strace GDB /proc jstack ss)
§四 Cross-Reference
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
| 1. connect() | Net.connect0 调了 connect(fd) 然后返回 IOS_UNAVAILABLE | **为什么非阻塞 connect 需要两步验证 (EPOLLOUT + SO_ERROR)？** TCP 状态机：connect() 发送 SYN → 进入 SYN_SENT 状态 → 内核返回 EINPROGRESS。对端可能：1) 正常响应 SYN+ACK → 进入 ESTABLISHED → epoll 检测 fd 可写 → EPOLLOUT。2) 对端 RST（端口无监听）→ socket 仍然"可写"但连接失败 → getsockopt(SO_ERROR) 读取到 ECONNREFUSED。**这就是为什么 EPOLLOUT 不够——socket 可写 ≠ 连接已建立**。更深一层：connect timeout 的控制——不是由 Java 的 select timeout 单方面控制，内核有自己独立的 `tcp_syn_retries` (default 6)，总共 ~127s 的重试窗口。你的 select(5000ms) 只是 Java 侧的等待上限——如果内核还在重试 SYN，等 5000ms 后 Java 认为超时了，但内核可能还在继续握手——这就是 `shutdown(fd, 2)` 被调用的原因（取消未完成的连接）。 |
| 3. accept() | accept0 调了 accept() 然后返回 newfd | **ECONNABORTED 为什么需要重试？** TCP 三次握手：client SYN → server SYN+ACK → client ACK → 连接进入 accept queue。但有一个 race window：client 收到 SYN+ACK 后但还没发 ACK 时，client 进程崩溃 → kernel 发了 RST → server 的 accept queue 中这条连接在 accept() 返回前被移除。POSIX 标准：`accept()` 应返回 ECONNABORTED。如果 server 不重试 → select() 的下一次 EPOLLIN 可能不会再触发（因为这条失效连接已经从 backlog 计数中移除，但新连接也在排队）。ECONNABORTED 重试循环保证了一个有效的连接被 accept。**更深一层：accept queue 的"容量"用尽——两个队列的设计：SYN queue (tcp_max_syn_backlog) + accept queue (min(backlog, somaxconn))。为什么分两个？因为 SYN queue 用 SYN cookie 可以动态扩容（防御 SYN flood），但 accept queue 受物理内存限制——分而治之是两个不同内核子系统的职责边界。** |
| 4. read(DirectBuffer) | IOUtil.read→FileDispatcherImpl.read0→read(fd, ptr, len)→DMA | **为什么需要 DirectBuffer 而不是直接用 HeapBuffer？** 这归结到 GC 的一个根本约束：**heap 对象地址不稳定**。`read(fd, ptr, len)` 是一个阻塞系统调用——可能持续数毫秒到数秒。如果 `ptr` 指向 Java heap 中的一个 byte[] 对象：GC 可能在 read() 返回前移动对象（压缩指针/拷贝收集）→ ptr 变成悬空指针 → 数据写入错误的地址 → JVM 崩溃或静默数据损坏。解决方案只有两个：1) 在 read() 期间"固定"对象（pinning，但 JVM 不普遍支持因为会阻碍 GC）；2) 用 native 内存（地址永不移动）。DirectBuffer 选了方案 2。**更深一层：HeapBuffer fallback 的 2 次 memcpy 开销不是错误——是安全性的代价。** 临时 DirectBuffer (native malloc)→ put (heap→native memcpy #1)→ read(fd, native) (DMA)→ get (native→heap memcpy #2)。如果你复用同一个 DirectBuffer 10 次：10×1=10 次 DMA，0 次 memcpy。复用 HeapBuffer 10 次：10×2=20 次 memcpy。这就是 break-even 是 ~10 次复用的原因。 |
| 4e. Deallocator | GC 回收集成 PhantomReference | **PhantomReference 和 Cleaner 的关系不是"自动 GC 回收"。** DirectByteBuffer 的 Java 对象可能只有 ~100 bytes——GC 很容易回收它。但 native 内存 8KB 是堆外分配的——GC 不管理它。回收流程：1) DirectByteBuffer 对象不可达 → 2) GC 将其加入 ReferenceQueue → 3) Cleaner 线程（不是 GC 线程！）从 Reference 队列取出 → 4) Deallocator.run() → Unsafe.freeMemory(address) → Bits.unreserveMemory。**这里有两个巨大陷阱：** 陷阱 A：如果 DirectByteBuffer 被提升到 old generation，但 old generation 从未 GC（内存充足）→ Cleaner 线程永不执行 → native 内存泄漏 → 系统 OOM killer。陷阱 B：`-XX:+DisableExplicitGC` → System.gc() 无效 → 你唯一强制 Full GC 的方法被禁用了 → OOM。这就是为什么很多框架实现自己的 DirectBuffer 池（Netty PooledByteBufAllocator）——不依赖 GC+Cleaner 的回收时序。 |
| 6. close() dup2 | closefd: lock+dup2+signal | **为什么 direct close(fd) 不唤醒阻塞的 read()？** 这是 Linux 内核的一个设计选择：`close()` 只减少 fd 的引用计数，但不中断正在进行的 I/O。如果你在 Linux 源码中找，`fs/file_table.c:__fput()` 在最后一个引用被释放时才调用 `filp->f_op->release()`，但 `release()` 不会唤醒阻塞在 `read()` 上的进程。这就是 dup2 trick 的本质：不是"关闭" fd——是**把 fd 号替换成另一个已经 shutdown 的文件描述符**，让已存在的 read() 调用在新文件上返回 EBADF，然后才真正 close 原始 fd。信号是**双重保障**——如果 dup2 的 EBADF 因为内核某些 edge case 没有触发，pthread_kill 用 EINTR 作为 fallback 中断 syscall。**你不需要理解全部内核细节才能诊断 close hang——但你需要知道这三层保护存在，以及为什么单靠 close(fd) 不够。** |
| 7. BIO vs NIO | PlainSocketImpl 和 Net 是两套 C 实现 | **为什么 Java 保留两套实现 25 年了？** 这不仅仅是"历史兼容"。更深层的原因：BIO 的阻塞语义需要 poll() 循环 + timeout 管理——PlainSocketImpl.c 中的 `socketConnect` 有完整的 poll+nanotime 调整逻辑 (~100 行)。如果只用 NIO 的 SocketAdaptor 模拟阻塞：每次 connect/read/write 都需要一个临时 Selector + select() + synchronized——~2-3μs extra overhead per operation。对于数据库连接池（成千上万次 connect/close），这是一个微秒级但累加的性能退步。**反过来：PlainSocketImpl 的 poll 循环是 NIO 的 Selector 在 BIO 侧的等价体——它们解决同一个问题（"等待 I/O 就绪"）但**使用不同的内核 API** (poll vs epoll)。** |

### 每板块原理密度要求
1. Every paragraph opens with WHY — "Because direct close(fd) doesn't wake the blocked reader on Linux, closefd() uses dup2..."
2. Your NIO client + server code appears at the very beginning (~40 lines total)
3. 3-5 lines source code per claim — 作为证据
4. Board 4 (read/DirectBuffer) MUST have 5 labeled sub-sections (4a-4e)
5. 每个 300 行以上的板块必须包含至少 1 个反事实 + 1 个 Linux/内核知识引用
6. Mermaid: Client(connect)+Server(accept+read)+Close(dup2) triple scene, every step file:line
7. GDB 5 assertions + strace + jstack
8. 6 Beginner callout boxes
9. Interview answer ~350 words
10. Client/Server 各~50%

---

## §七 Output Format

File: `01-Socket-Data-Close.md`, Path: `/data/workspace/openjdk-cut-new/probe_md/16-nio-network/`

Header:
```
> **阶段**：[16-nio-network]
> **前置**：[00-Server-Selector-Engine]（Selector engine）、[09-native-interface]、[11-os-layer]
> **配套**：[00-Server-Selector-Engine]（register to Selector）、[02-ZeroCopy-Threads-Diag]（sendfile+diag）
> **阅读收益**：connect→read→close 完整调用链
```
Target: ~5000 lines

---

## §八 Prohibited（≥10）

- ❌ EINPROGRESS 说成"错误" — 预期返回值, Net.c:319→IOS_UNAVAILABLE
- ❌ dup2 trick 只说"close trick" — 三层: lock+dup2+signal, 每层 linux_close.c 行号
- ❌ Server/Client imbalance — 各~50%
- ❌ 不提 SecurityManager check+fd leak guard
- ❌ 不提 IPV6_V6ONLY=0 dual-stack
- ❌ 不提 BLOCKING_IO_RETURN_INT 宏
- ❌ 不提 PlainSocketImpl vs Net 对比
- ❌ 不提 connect timeout tcp_syn_retries
- ❌ 不提 EMFILE accept fd limit 耗尽
- ❌ 不提 DirectBuffer Cleaner/Deallocator/PhantomReference 生命周期

---

## §九 Required（≥12）

- ✅ Client+Server code as opener
- ✅ Mermaid 三场景: Client(connect)+Server(accept+read)+Close(dup2)
- ✅ Net.c: socket0, connect0, bind0, listen, setIntOption0 源码
- ✅ PlainSocketImpl.c: socketCreate, socketConnect (BIO poll loop), socketClose0 源码
- ✅ linux_close.c: closefd 三层源码 + BLOCKING_IO_RETURN_INT
- ✅ ServerSocketChannelImpl.c: accept0 (ECONNABORTED+EAGAIN+EMFILE)
- ✅ SocketChannelImpl.c: checkConnect (poll+SO_ERROR+POLLHUP)
- ✅ DirectBuffer 5 子板块 (allocateDirect/read0+DMA/HeapBuffer fallback/ScatterGather/Deallocator)
- ✅ BIO vs NIO 对比
- ✅ 6 Beginner Callout 框
- ✅ Interview Story ~350 words
- ✅ GDB 5 + strace + jstack

---

## §十 GDB + strace + jstack Verification（≥5 assertions）

```
断言 1: socket creation (Net.c socket0)
  (gdb) break Java_sun_nio_ch_Net_socket0; run
  (gdb) print fd→>0; print domain→10(AF_INET6); next→setsockopt IPV6_V6ONLY=0

断言 2: connect EINPROGRESS (Net.c:319)
  (gdb) break Java_sun_nio_ch_Net_connect0; continue
  (gdb) print rv→-1; print errno→115(EINPROGRESS)

断言 3: accept new fd (ServerSocketChannelImpl.c accept0)
  (gdb) break Java_sun_nio_ch_ServerSocketChannelImpl_accept0; continue
  (gdb) print newfd→>0

断言 4: dup2 trick (linux_close.c closefd)
  (gdb) break closefd; trigger: channel.close()
  (gdb) print fd2→the fd; next→dup2(marker,fd2)(Layer 2)

断言 5: SO_ERROR check (SocketChannelImpl.c checkConnect)
  (gdb) break Java_sun_nio_ch_SocketChannelImpl_checkConnect
  (gdb) print error→0/111(ECONNREFUSED)/113(EHOSTUNREACH)

strace: strace -e trace=socket,bind,listen,accept4,connect,setsockopt,getsockopt,dup2,close,read,write java TestClient 2>&1 | head -40

jstack: jstack $(pgrep -f java) | grep -A10 "finishConnect"
```

---

## §十一 与 README 和同组 prompt 的连续性

1. 从 00 承接: Selector register+epoll engine→本文 connect/accept/close 使用 00 的引擎
2. 从 README §二.5: dup2 trick→本文 linux_close.c 验证三层防护
3. 从 README §二.6: EINPROGRESS→本文 Net.c connect0+SocketChannelImpl.c checkConnect 验证两步
4. 从 README §二.3: DirectBuffer→本文 Direct-X-Buffer+IOUtil+FileDispatcherImpl 验证分配→I/O→回收
5. 同组边界: 本文 socket+connect+data+close; 00 Selector engine; 02 sendfile+Reactor+diag
