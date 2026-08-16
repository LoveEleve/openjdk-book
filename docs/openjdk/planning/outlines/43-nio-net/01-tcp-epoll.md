# 01. TCP Socket — PlainSocketImpl + ServerSocket + epoll

> 🔴 Deep | connect/read/write/accept + epoll event loop
> 读者处境: `new Socket("example.com", 80)` — Java→native socketConnect→`NET_Connect` with PollArrayWrapper 非阻塞→connect+EPOLLOUT wait。`ServerSocket.accept()`→socketAccept→setBlocking→return Socket。NIO ServerSocketChannel→epoll_create→epoll_ctl(ADD)→epoll_wait→Selector.selectedKeys。

> ⚠️ 写作期修正(2026-08-16,43-nio-net/01 完成):
> - **"PollArrayWrapper.poll(timeout) → wait for EPOLLOUT ready" 编造(重要)**: PollArrayWrapper 是 **windows 类**(src/java.base/windows/classes/sun/nio/ch/);linux 的带超时 connect 用 **poll(2)**——`struct pollfd {fd, POLLOUT}` + `NET_Poll(&pfd, 1, timeout)`(PlainSocketImpl.c:348,EINTR 按 JVM_NanoTime 重算 :358-368,超时 SocketTimeoutException+shutdown :373-382);**POLLOUT 不是 EPOLLOUT**
> - **"socketAccept 后 NET_SetSockOpt(newfd, SO_REUSEADDR)" 编造**: SO_REUSEADDR 在 **socketCreate**(PlainSocketImpl.c:159)里对**服务端 socket**(psi_serverSocketID 非空)设置(:200-215,注释 "If this is a server socket then enable SO_REUSEADDR automatically and set to non blocking");accept 流程=NET_Timeout 可读等待(:644-652)→NET_Accept(:664)→SET_BLOCKING(:668)→ECONNABORTED/EWOULDBLOCK 循环调整超时(:673-694)
> - **"socketClose0 linger→RST" 编造(JDK8 形态)**: JDK11=**deferred close**(useDeferredClose): marker_fd(getMarkerFD :73,socketpair+shutdown 注释 :66-71)→NET_Dup2(marker_fd, fd)(:783-786)顶替让阻塞 read/write 立即返回;linger 在 socketSetOption0(:826)单独设置
> - **"EPoll.c:40-97/:58-65/:68-80/:82-97" 行号偏 1**: EPoll.c **97 行**;eventSize :41/eventsOffset :47/dataOffset :53(布局三兄弟,大纲漏)/create :59(epoll_create(256),注释 "size hint not used in modern kernels")/ctl :69/wait :83(jlong_to_ptr DirectBuffer 零拷贝 :86,EINTR→IOS_INTERRUPTED :89-90)
> - **"EPOLLET vs Level-Triggered" 表述错(重要)**: JDK11 **无 EPOLLET 常量**(EPoll.java:58-67 只有 ADD/DEL/MOD=1/2/3、EPOLLIN=0x1、EPOLLOUT=0x4、EPOLLONESHOT=1<<30)——Selector 是 **level-triggered**;EPOLLONESHOT 只被**异步通道**(EPollPort.java:178-180)使用;实证 strace: 第二次 epoll_wait 仍带 fd9 EPOLLOUT=level-triggered 残留就绪
> - **Net.c 路径错**: 在 `java.base/unix/native/libnio/ch/Net.c`(814 行,非 libnet);socket0 :194/bind0 :280/listen :299/**connect0 :306-322(三态: 1=成功/IOS_UNAVAILABLE(EINPROGRESS)/IOS_INTERRUPTED(EINTR))**;handleSocketError :783-812(errno→ConnectException/NoRouteToHostException/BindException/SocketException)
> - **EPollSelectorImpl 机制(大纲漏,重要)**: epfd=EPoll.create(:79)+pollArrayAddress=allocatePollArray(NUM_EPOLLEVENTS=min(fdLimit,1024),:51-52)+**自唤醒管道** fd0/fd1=IOUtil.makePipe+EPOLL_CTL_ADD fd0 EPOLLIN(:93,wakeup 写一字节 :254);doSelect→EPoll.wait :120;更新队列 **processUpdateQueue(:143-170,非 updateRegistrations)** DEL/ADD/MOD;注销 DEL :233-235
> - **Java 侧 EPoll 布局**: SIZEOF_EPOLLEVENT=eventSize() 等(:53-55);allocatePollArray=unsafe.allocateMemory(count*SIZEOF_EPOLLEVENT)(:72-74);getDescriptor/getEvents unsafe.getInt(:93-105)——Java 直接按 C struct epoll_event 布局读写,零拷贝
> - **socketRead0/socketWrite0 不在 PlainSocketImpl.c**: 在 SocketInputStream.c:91(NET_ReadWithTimeout :127/NET_Read :135)/SocketOutputStream.c:57
> - **悬念指向** ✓(02-udp-dns);素材: 33-nio-strace.txt(阻塞 connect=0 vs NIO EINPROGRESS+epoll 全链路)

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
