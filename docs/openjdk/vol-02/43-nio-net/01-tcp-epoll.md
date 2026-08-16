# 01. TCP Socket — PlainSocketImpl + ServerSocket + epoll

> **前置依赖**:[33-jmx/02 — JDK 怎么查询 JVM 内存状态？— JMM 接口 + JDK Management](openjdk/vol-02/33-jmx/02-jmm-interface.md):JDK 侧 native 库的 JNI_OnLoad/函数表模式,本篇的 libnet/libnio 是同样的 JNI 通道;[42-core-native/01 — JNI 工具层与系统属性 — libjava 的骨架](openjdk/vol-02/42-core-native/01-jni-system.md):JNI native 方法的基本形态与错误翻译模式
> → **后续**:[43-nio-net/02 — UDP + DNS + NetworkInterface — Datagram + InetAddress](02-udp-dns.md)
> 关联域: 42-core-native(JNI 通道)、33-jmx(管理通道对照)

## 一次 connect,两条路

[strace 实证](planning/outlines/00-jvm-tools/materials/commands/33-nio-strace.txt)跑同一个程序: 先用 `new Socket()` 做一次阻塞回环,再用 `SocketChannel` 走 NIO Selector。内核侧的两个世界泾渭分明:

```
# 阻塞 Socket: connect 直接完成(回环立即成功)
socket(AF_INET, SOCK_STREAM, IPPROTO_IP) = 6
connect(6, {sa_family=AF_INET, sin_port=htons(43087), sin_addr=inet_addr("127.0.0.1")}, 16) = 0
accept(5, ...) = 7

# NIO: connect 进入 EINPROGRESS,交给 epoll
socket(AF_INET, SOCK_STREAM, IPPROTO_IP) = 9
connect(9, {sa_family=AF_INET, sin_port=htons(35361), ...}, 16) = -1 EINPROGRESS (Operation now in progress)
epoll_create(256)                = 6
epoll_ctl(6, EPOLL_CTL_ADD, 9, {events=EPOLLOUT, ...}) = 0
epoll_wait(6, [{events=EPOLLOUT, data={u32=9, ...}}], 1024, 2000) = 1
epoll_ctl(6, EPOLL_CTL_ADD, 10, {events=EPOLLIN, ...}) = 0
epoll_wait(6, [{events=EPOLLOUT, data={u32=9, ...}}, {events=EPOLLIN, data={u32=10, ...}}], 1024, 2000) = 2
```

两条值得先记住的事实: ①阻塞 Socket 的 connect 是**一条系统调用直接完成**(回环上无 EINPROGRESS);NIO 的 connect 是**非阻塞 + EPOLLOUT 等待**;②第二次 epoll_wait 返回 2 个事件——**fd 9 的 EPOLLOUT 还在**(level-triggered 的残留就绪),这就是 JDK Selector 用 level-triggered 而不是边缘触发的直接证据。这篇拆: 阻塞 Socket 的 native 管道(PlainSocketImpl.c:227 起)、NIO 通道层(Net.c:194 起)、Selector 的 epoll 底座(EPoll.c:59 起)。

## 1. PlainSocketImpl: 阻塞 Socket 的 native 管道

`java.net.Socket` 的 native 在 `java.base/unix/native/libnet/PlainSocketImpl.c:1-1038`(1038 行)——connect/accept/close/读写四个函数,每个都是"JNI 取 fd → 系统调用 → 异常翻译"的骨架。

**socketConnect**(:227): 第一个分叉是**超时**。timeout<=0 直接 `NET_Connect(fd, &sa, len)`(阻塞 connect,一条调用);**timeout>0 时 JDK 在用户态模拟带超时 connect**——注释 :312-317 是权威说明:

```cpp
// PlainSocketImpl.c:312-317(截取核心,逐字)
        /*
         * A timeout was specified. We put the socket into non-blocking
         * mode, connect, and then wait for the connection to be
         * established, fail, or timeout.
         */
        SET_NONBLOCKING(fd);
```

之后的流程: `connect(fd, ...)`(注释 "no need to use NET_Connect as non-blocking" :319)→ 若 `errno == EINPROGRESS`(:328)则进入**poll 循环**: `struct pollfd {fd, POLLOUT}` + `NET_Poll(&pfd, 1, timeout)`(:348)——**注意是 poll(2) 不是 epoll,POLLOUT 不是 EPOLLOUT**;EINTR 时按 `JVM_NanoTime` 重算剩余超时继续(:358-369);超时归零 → `SocketTimeoutException` + `shutdown(fd, 2)`(:373-382,注释 "Timeout out but connection may still be established...just in case we make the socket blocking again and shutdown input & output");poll 就绪后 `getsockopt(fd, SOL_SOCKET, SO_ERROR)` 确认连接结果(:388-393),最后 `SET_BLOCKING(fd)` 恢复阻塞模式。*关键设计: Java 层在 POSIX 上"模拟"了带超时的 connect*——内核只提供 connect+EINPROGRESS,等待与超时全部由 JDK 用 poll(2)+纳秒时钟实现,不依赖任何内核扩展。大纲的"PollArrayWrapper"是 Windows 类(JDK8 的 unix 版本也没有用它),Linux 这条链是纯 poll(2)。

**socketAccept**(:587): 同样先做**可读性等待**——`NET_Timeout(env, fd, ...)`(:644-652,阻塞 accept 的超时也在这里实现);`NET_Accept(fd, &sa, &slen)`(:664);成功后 `SET_BLOCKING(newfd)`(:668)——服务端监听 fd 是非阻塞的(见下),新连接显式恢复阻塞模式;循环处理 `ECONNABORTED/EWOULDBLOCK/EAGAIN`(连接被对端 RST 抢先、或 accept 超时竞态)并调整剩余超时(:673-694)。大纲的"accept 后设置 SO_REUSEADDR"是编造的——SO_REUSEADDR 在 **socketCreate**(:159)里对**服务端 socket**(`psi_serverSocketID` 字段非空)设置(:200-215,注释 "If this is a server socket then enable SO_REUSEADDR automatically and set to non blocking"——服务端 fd 一并设成非阻塞,配合上面的 NET_Timeout 实现 accept 超时)。

**socketClose0**(:769): 大纲的 "SO_LINGER→RST 硬关闭" 是 JDK8 旧形态——JDK11 的关闭是**延迟关闭(useDeferredClose)**: 若在阻塞 I/O 中关闭,`NET_Dup2(marker_fd, fd)` 用**标志 fd 顶替**(:783-786)——marker_fd 是启动时 `getMarkerFD()`(:73)用 `socketpair(AF_UNIX)` 建立并 shutdown 的 fd(注释 :68-72 "The result is an fd that can be used for read/write");被顶替后,阻塞中的 read/write 在新 fd 上立即返回而非继续阻塞,配合 Java 侧中断语义;否则置 `IO_fd_fdID=-1` + `NET_SocketClose(fd)`。**linger 是在 `socketSetOption0`(:826)里单独设置的选项**,不参与 close 的 RST 决策。

**读写**: 不在 PlainSocketImpl.c:1-1038(全文件)——`SocketInputStream.socketRead0`(unix/native/libnet/SocketInputStream.c:91)与 `SocketOutputStream.socketWrite0`(SocketOutputStream.c:57)。socketRead0 的骨架: 大读走堆缓冲(超过 `MAX_HEAP_BUFFER_LEN` 截断,:114-131)→ 有超时走 `NET_ReadWithTimeout`(:127)、否则 `NET_Read`(:135)。这些 `NET_*` 工具声明在 net_util_md.h:80-92(`NET_Timeout`/`NET_Read`/`NET_Connect`/`NET_Accept`/`NET_SocketClose`/`NET_Poll`),实现按平台在 net_util_md.c:1068(NET_Wait)等。

## 2. NIO 通道层(Net.c:194 起)

NIO 的 SocketChannel/ServerSocketChannel 的 native 在 `java.base/unix/native/libnio/ch/Net.c:1-814`(814 行,与大纲行数一致但路径是 libnio/ch 不是 libnet)。四个核心函数:

- **socket0**(:194): `socket(AF_INET/AF_INET6, SOCK_STREAM, ...)` 建 fd,按 `preferIPv6` 选族;
- **bind0**(:280)/**listen**(:299): 绑定与监听;
- **connect0**(:306-322): **非阻塞语义的三态返回**——`connect()` 成功返回 **1**;`EINPROGRESS` 返回 `IOS_UNAVAILABLE`(连接进行中,Java 侧注册 OP_CONNECT 等 epoll);`EINTR` 返回 `IOS_INTERRUPTED`;其他错误走 `handleSocketError`。

`handleSocketError`(Net.c:783-812)是 errno→Java 异常的翻译器: `ECONNREFUSED/ETIMEDOUT/ENOTCONN`→`ConnectException`、`EHOSTUNREACH`→`NoRouteToHostException`、`EADDRINUSE/EADDRNOTAVAIL`→`BindException`、默认 `SocketException`;`EINPROGRESS` 特判返回 0。*设计要点: 阻塞 API 与 NIO 共享同一套 `NET_*` 工具,区别只在"谁等待"*——阻塞 Socket 自己 poll,Channel 交给 Selector 的 epoll。

## 3. Selector 的 epoll 底座(EPoll.c:41 起)

**EPoll.c:1-97**(`java.base/linux/native/libnio/ch/` 下,共 97 行)是 Linux 专属的薄 JNI 包装。除 create/ctl/wait 三兄弟外,还有**布局三函数** `eventSize`/`eventsOffset`/`dataOffset`(:41-56)——把 C 的 `struct epoll_event {uint32_t events; epoll_data_t data}` 布局告诉 Java 侧:

```cpp
// EPoll.c:58-80(截取核心,逐字)
JNIEXPORT jint JNICALL
Java_sun_nio_ch_EPoll_create(JNIEnv *env, jclass clazz) {
    /* size hint not used in modern kernels */
    int epfd = epoll_create(256);
    if (epfd < 0) {
        JNU_ThrowIOExceptionWithLastError(env, "epoll_create failed");
    }
    return epfd;
}

JNIEXPORT jint JNICALL
Java_sun_nio_ch_EPoll_ctl(JNIEnv *env, jclass clazz, jint epfd,
                          jint opcode, jint fd, jint events)
{
    struct epoll_event event;
    int res;

    event.events = events;
    event.data.fd = fd;

    res = epoll_ctl(epfd, (int)opcode, (int)fd, &event);
    return (res == 0) ? 0 : errno;
}
```

`EPoll_wait`(:83-97): `struct epoll_event *events = jlong_to_ptr(address)`——**address 是 Java 侧 unsafe.allocateMemory 的裸内存地址(EPoll.allocatePollArray,EPoll.java:72-74;不是 DirectBuffer),epoll_wait 直接往里面写事件,零拷贝**;`EINTR` 返回 `IOS_INTERRUPTED`(:89-90)让 Java 侧重试;其他错误 throw+`IOS_THROWN`。

**Java 侧 EPoll 类**(`linux/classes/sun/nio/ch/EPoll.java`): 静态常量 `SIZEOF_EPOLLEVENT = eventSize()` 等(:53-55)——**Java 代码直接按 C 结构布局分配与读写事件**;`allocatePollArray(count) = unsafe.allocateMemory(count * SIZEOF_EPOLLEVENT)`(:72-74,裸内存——epoll_wait 的 address 参数就是它);`getDescriptor`/`getEvents` 用 `unsafe.getInt(eventAddress + OFFSETOF_*)` 读就绪事件(:93-105)。操作码/事件常量(:58-67): `EPOLL_CTL_ADD=1/DEL=2/MOD=3`、`EPOLLIN=0x1`、`EPOLLOUT=0x4`、`EPOLLONESHOT=1<<30`——**注意没有 EPOLLET 常量**: JDK11 的 Selector 是 **level-triggered**(大纲的 EPOLLET 描述不适用);`EPOLLONESHOT` 只被**异步通道**(EPollPort.java:178-180,AsynchronousSocketChannel 的每次事件重注册)使用。

**EPollSelectorImpl**(`linux/classes/sun/nio/ch/EPollSelectorImpl.java`)把 Selector 语义接到 epoll 上:
- 构造(:50-93): `epfd = EPoll.create()`(:79);`pollArrayAddress = EPoll.allocatePollArray(NUM_EPOLLEVENTS)`(NUM_EPOLLEVENTS=min(fdLimit,1024));`fd0/fd1 = IOUtil.makePipe()` **自唤醒管道**——`EPoll.ctl(epfd, ADD, fd0, EPOLLIN)`(:93)让 `Selector.wakeup()` 只需往管道写一字节,epoll_wait 立即返回;
- `doSelect`(:100-120): `EPoll.wait(epfd, pollArrayAddress, NUM_EPOLLEVENTS, to)`——**epoll_wait 就绪事件直接落进 pollArray 的裸内存**;
- `processUpdateQueue`(:143-170): 兴趣集变化时 `EPOLL_CTL_DEL`(原来注册过→清 0)/`ADD`(从 0 开始)/`MOD`(变化);
- 注销时 `EPOLL_CTL_DEL`(:233-235)。

实证的 strace 就是这条链的完整快照: `epoll_create(256)=6` → `epoll_ctl(ADD, 7, EPOLLIN)`(fd0 唤醒端)→ 非阻塞 connect 返回 EINPROGRESS → `epoll_ctl(ADD, 9, EPOLLOUT)` → `epoll_wait=1`(connect 就绪)→ `epoll_ctl(ADD, 10, EPOLLIN)`(OP_READ)→ `epoll_wait=2`——**第二次还带着 fd 9 的 EPOLLOUT**(level-triggered: 未 MOD 的事件持续就绪),与 `EPoll.java` 里"没有 EPOLLET"相互印证。

## 核心悬念

TCP 的 Java→native→内核链路拆完: 阻塞 Socket 走 PlainSocketImpl.c:227(poll(2) 模拟超时 connect、NET_Timeout 等 accept、deferred close);NIO 通道层 Net.c:306 把 connect 变成三态返回(1/IOS_UNAVAILABLE/IOS_INTERRUPTED)交给 Selector;Selector 坐在 epoll 上——EPoll.c:41-56 的布局三函数让 Java 侧直接按 `struct epoll_event` 布局读写 unsafe 裸内存(零拷贝),level-triggered + 自唤醒管道 + ADD/MOD/DEL 增量注册。但网络域还有两条独立的路没拆: **UDP**(DatagramSocket 的 sendto/recvfrom 无连接语义、组播 setsockopt)与 **DNS**(InetAddress.getByName→getaddrinfo 的解析链路),以及网络接口枚举。下一篇: UDP + DNS + NetworkInterface。

> → [43-nio-net/02 — UDP + DNS + NetworkInterface — Datagram + InetAddress](02-udp-dns.md)
