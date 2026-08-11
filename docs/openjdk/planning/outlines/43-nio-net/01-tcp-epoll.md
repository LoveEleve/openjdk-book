# 01. TCP Socket — PlainSocketImpl + ServerSocket + epoll

> 🔴 Deep | connect/read/write/accept + epoll event loop
> 读者处境: `new Socket("example.com", 80)` — Java→native socketConnect→`NET_Connect` with PollArrayWrapper 非阻塞→connect+EPOLLOUT wait。`ServerSocket.accept()`→socketAccept→setBlocking→return Socket。NIO ServerSocketChannel→epoll_create→epoll_ctl(ADD)→epoll_wait→Selector.selectedKeys。

### 1. "PlainSocketImpl — connect/read/write/accept"

场景: `new Socket("example.com", 80).getOutputStream().write("GET /")` — PlainSocketImpl_socketConnect→NET_Connect→connect syscall→PollArrayWrapper 等待→socketWrite→NET_Send。

**PlainSocketImpl** (`PlainSocketImpl.c:227-800`):
```
Java_java_net_PlainSocketImpl_socketConnect(env, this, address, port, timeout) (line 227):
  → NET_InetAddressToSockaddr → 转换 Java InetAddress→struct sockaddr
  → socket(AF_INET, SOCK_STREAM, 0) or AF_INET6 → create TCP socket
  → NET_Connect(fd, &sa, sa_len) → connect() syscall → 非阻塞(先设 O_NONBLOCK)
  → PollArrayWrapper.poll(timeout) → wait for EPOLLOUT ready
  → setBlocking(fd, true) → restore blocking mode

Java_java_net_PlainSocketImpl_socketAccept(env, this, newSocket) (line 587):
  → NET_Accept(fd, &sa, &sa_len) → accept() syscall
  → NET_SetSockOpt(newfd, SO_REUSEADDR) → 端口复用
  → setBlocking(newfd, true)

Java_java_net_PlainSocketImpl_socketClose0(env, this) (line 769):
  → linger: if SO_LINGER enabled→linger=0→RST reset→hard close
  → NET_SocketClose(fd) → close(fd)
[C++: PlainSocketImpl.c:1038行——connect 使用 PollArrayWrapper 实现超时非阻塞(Java 风格)]
```
- 源码: `PlainSocketImpl.c:227-350` (socketConnect + PollArrayWrapper) + `PlainSocketImpl.c:587-700` (socketAccept) + `PlainSocketImpl.c:769-810` (socketClose0)

- 关键设计: **connect 的非阻塞实现** — Java Socket connect 带 timeout→先设 O_NONBLOCK→connect→如果 EINPROGRESS→PollArrayWrapper 等待可写(timeout)→成功→设回 blocking。这是 Java 层在 POSIX 上模拟的带超时 connect——无需修改内核。

### 2. "epoll — Selector 的 Linux 底层"

场景: `Selector.open()`→EPollSelectorImpl→epoll_create→register Channel→epoll_ctl(ADD)→select()→epoll_wait→selectedKeys。

**EPoll JNI** (`EPoll.c:40-97`):
```
Java_sun_nio_ch_EPoll_create(env, clazz) (line 58):
  → epoll_create(256) → return epfd(内核 epoll instance)

Java_sun_nio_ch_EPoll_ctl(env, epfd, opcode, fd, events) (line 68):
  → struct epoll_event.events = events(EPOLLIN|EPOLLOUT...)
  → epoll_ctl(epfd, EPOLL_CTL_ADD/EPOLL_CTL_MOD/EPOLL_CTL_DEL, fd, &event)

Java_sun_nio_ch_EPoll_wait(env, epfd, address, numfds, timeout) (line 82):
  → events = jlong_to_ptr(address) — 指向 Java DirectBuffer
  → epoll_wait(epfd, events, numfds, timeout)
  → if EINTR → return IOS_INTERRUPTED (Java 层重试)
[C++: EPoll.c:98行——thin JNI wrapper, epoll_wait 超时 -1=block / 0=non-block / >0=timeout ms]
[内核: epoll_create(2)→内核分配 epoll 文件描述符, epoll_ctl(2)→注册 fd+events 到内核红黑树, epoll_wait→阻塞直到事件就绪]
```
- 源码: `EPoll.c:58-65` (epoll_create) + `EPoll.c:68-80` (epoll_ctl) + `EPoll.c:82-97` (epoll_wait)

- 关键设计: **EPOLLET(边缘触发) vs Level-Triggered 默认** — JDK 用 level-triggered 默认(不需要管理状态——每次 epoll_wait 返回所有就绪 fd)。`events` buffer 是 Java DirectByteBuffer — 通过 `jlong_to_ptr(address)` 获取 C 指针——零拷贝。**EPOLLONESHOT** — 每个 fd 在触发后自动从 epoll 移除——处理完需显式 epoll_ctl(ADD) 重新注册。

---

### 核心悬念

**"PlainSocketImpl: connect(PollArrayWrapper 非阻塞超时)→accept+setBlocking→close with SO_LINGER。epoll: epoll_create→epoll_ctl(ADD/MOD/DEL)→epoll_wait(Level-Triggered)→Selector.selectedKeys。Java NIO 的 Selector 直接坐在 Linux epoll 上——events buffer 是 DirectByteBuffer 零拷贝。"** — 下一篇: UDP + DNS + NetworkInterface。

> → [02-udp-dns.md](02-udp-dns.md)
