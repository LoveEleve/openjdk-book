# 域 43: NIO & Net — 知识规划

> 源码: unix/native/libnet/ + unix/native/libnio/ + linux/native/libnio/ | ~55文件/~31667行 | 🟡 大域(3篇)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| PlainSocketImpl.c (1038行) | **Socket 操作**: socketConnect(connect+PollArrayWrapper 非阻塞), socketAccept(accept+setBlocking), socketClose(close+linger), socketRead/socketWrite(阻塞 I/O) | High |
| Net.c (814行) | **NIO Channel 网络**: ServerSocketChannel.bind/listen, SocketChannel.connect(finishConnect 非阻塞), SocketChannel.read/write, translateToSocketException(errno→Java异常) | High |
| EPoll.c (98行) | **epoll JNI 包装**: epoll_create/epoll_ctl(ADD/MOD/DEL)/epoll_wait — linux 事件驱动 I/O 多路复用, thin JNI wrapper | High |
| PlainDatagramSocketImpl.c (2221行) | **UDP 操作**: socketCreate/send/peek/receive/joinGroup/leaveGroup(组播), TTL/setTimeToLive, connect/disconnect | High |
| NetworkInterface.c (2172行) | **网络接口枚举**: getifaddrs→getAll/getByIndex/getByName, MAC/hardware address, MTU, IPv4/IPv6 addresses, isLoopback/isUp | High |
| Inet4AddressImpl.c (517行) / Inet6AddressImpl.c (728行) | **DNS 解析**: getLocalHostName, lookupAllHostAddr→getaddrinfo→IPv4/IPv6 addresses, InetAddress.getByName | High |
| net_util_md.c (1101行) | **网络工具**: NET_InetAddressToSockaddr, NET_SetSockOpt/GetSockOpt, NET_Bind/Connect, reuseAddress/setTcpNoDelay/linger, NET_GetError | High |
| DefaultProxySelector.c (510行) | **代理选择**: getSystemProxy→gsettings(Gnome) / KDE / environment variables(http_proxy) | Low |
| UnixNativeDispatcher.c (1244行) | **POSIX I/O 包装**: stat/open/close/readdir/link/unlink/chmod/rename—所有 POSIX 文件系统调用 JNI | High |
| LinuxWatchService.c | **inotify 文件监视**: inotify_init/inotify_add_watch(IN_CREATE/IN_DELETE/IN_MODIFY), read events, 文件变更通知 | Medium |

*10 知识点*

## 02 聚合

### P1 (≥5文件)
| KP | 出现文件 |
|----|---------|
| 网络工具层 (sockaddr/connect/bind/opt) | net_util_md.c, PlainSocketImpl.c, Net.c, PlainDatagramSocketImpl.c, Inet4AddressImpl.c |

### P2 (2-4文件)
| KP | 出现文件 |
|----|---------|
| TCP Socket 操作 (connect/read/write) | PlainSocketImpl.c, Net.c |
| NIO Channel + epoll | Net.c, EPoll.c |
| UDP + 组播 | PlainDatagramSocketImpl.c |
| DNS 解析 | Inet4AddressImpl.c, Inet6AddressImpl.c |
| 网络接口枚举 | NetworkInterface.c |
| POSIX 文件系统操作 | UnixNativeDispatcher.c, LinuxWatchService.c |

### P3 (=1文件)
| KP | 出现文件 |
|----|---------|
| 代理选择 | DefaultProxySelector.c |

## 03 深度分类

### 🔴 Deep (2 KP)
| KP | 为什么 🔴 |
|----|---------|
| TCP Socket(PlainSocketImpl + Net NIO) | PlainSocketImpl 是 java.net.Socket 的 native 实现——socketConnect→NET_Connect(PollArrayWrapper 非阻塞), socketAccept→NET_Accept→setBlocking。Net.c 是 NIO SocketChannel 的 native——ServerSocketChannel.bind→listen, SocketChannel.connect→NET_Connect0→finishConnect 非阻塞 + epoll。两者共享 net_util_md.c 的工具层。Java 网络 I/O 的全部 native 管道 |
| epoll 事件循环 | EPoll.c(epoll_create/ctl/wait JNI)——Java Selector 的 Linux 底层。epoll_wait 返回就绪 fd→Selector.selectedKeys→Channel ready ops。epoll_ctl ADD/MOD/DEL 注册/修改/删除 fd 监听。EPOLLET(边缘触发) + EPOLLONESHOT(单次) 两种模式 |

### 🟡 Working (3 KP)
| KP | 为什么 🟡 |
|----|---------|
| UDP + 组播 | send/receive via sendto/recvfrom——无连接→无 connect 步骤。组播: setsockopt(IP_ADD_MEMBERSHIP) + setTTL |
| DNS 解析 | getaddrinfo→IPv4+IPv6 地址→InetAddress[]——getLocalHostName 读 /etc/hostname |
| POSIX 文件系统 | stat/open/readdir→UnixNativeDispatcher.c(Linux), LinuxWatchService(inotify 文件变更监视) |

### 🟢 Surface (2 KP)
| KP | 为什么 🟢 |
|----|---------|
| 网络接口枚举 | getifaddrs→简单的 struct ifaddrs 遍历→extract MAC/IP/MTU |
| 代理选择 | DefaultProxySelector→Gnone/KDE/env var——边缘用例 |

## 04 聚类 — 3篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | TCP Socket + epoll | "java.net.Socket 怎么调 connect/read/write？NIO SocketChannel 怎么用 epoll_wait 非阻塞？" |
| 2 | UDP + DNS + NetworkInterface | "DatagramSocket send/receive 怎么工作？InetAddress.getByName 怎么调 getaddrinfo？" |
| 3 | NIO FileSystem | "java.nio.file.Files.readAttributes 怎么调 stat？inotify 怎么监视文件变更？" |

**聚类决策**: (1) TCP+epoll 是核心——覆盖最常用的 Socket/ServerSocket/SocketChannel 三层 (2) UDP+ DNS+NetworkInterface 打包——都是 net 相关但独立性高 (3) FileSystem NIO——独立于网络栈、用 POSIX syscall 实现。每篇 50-70 行——三篇覆盖 ~31K 行 native 代码。
