# 02. UDP + DNS + NetworkInterface — Datagram + InetAddress

> **前置依赖**:[43-nio-net/01 — TCP Socket — PlainSocketImpl + ServerSocket + epoll](openjdk/vol-02/43-nio-net/01-tcp-epoll.md):`NET_*` 工具族(net_util_md.h:80-92)与 `handleSocketError` 的 errno→异常翻译模式,本篇三个 native 文件共用同一套工具;[33-jmx/02 — JDK 怎么查询 JVM 内存状态？— JMM 接口 + JDK Management](openjdk/vol-02/33-jmx/02-jmm-interface.md):JDK native 库的调用模式
> → **后续**:[43-nio-net/03 — NIO FileSystem — stat/readdir/inotify](03-filesystem.md)
> 关联域: 42-core-native(JNI 通道)、43-nio-net/01(`NET_*` 工具)

## 三种数据,一条实证

[strace 实证](planning/outlines/00-jvm-tools/materials/commands/33-nio-udp-strace.txt)一个程序同时跑 UDP echo、DNS 解析、网卡枚举:

```
# UDP echo: sendto/recvfrom,无连接(每次 send 带目标地址)
sendto(5, "hello-udp", 9, 0, {sa_family=AF_INET, sin_port=htons(42319), sin_addr=inet_addr("127.0.0.1")}, 16) = 9
recvfrom(4, "hello-udp", 64, 0, {sa_family=AF_INET, sin_port=htons(53718), sin_addr=inet_addr("127.0.0.1")}, [28 => 16]) = 9
sendto(4, "hello-udp", 9, 0, {sa_family=AF_INET, sin_port=htons(53718), ...}, 16) = 9

# DNS: glibc getaddrinfo 先读 /etc/hosts(本地命中)
openat(AT_FDCWD, "/etc/hosts", O_RDONLY|O_CLOEXEC) = 4
openat(AT_FDCWD, "/etc/gai.conf", O_RDONLY|O_CLOEXEC) = -1 ENOENT

# 网卡枚举: getifaddrs 内部就是 netlink(glibc 实现)
socket(AF_NETLINK, SOCK_RAW|SOCK_CLOEXEC, NETLINK_ROUTE) = 4
sendto(4, [{nlmsg_type=RTM_GETADDR, nlmsg_flags=NLM_F_REQUEST|NLM_F_DUMP, ...}], 20, 0, ...) = 20
recvmsg(4, ... RTM_NEWADDR ... ifa_index=if_nametoindex("lo") ... inet_addr("127.0.0.1") ...) = 156
```

程序输出: `udp echo: hello-udp`、`localhost/127.0.0.1`、`eth1 mtu=1500 mac=c6:e1:8e:92:05:dc`、`lo mtu=65536 mac=null`。三条线分别对应三个 native 文件: PlainDatagramSocketImpl.c:1-2221(2221 行)、Inet4AddressImpl.c:1-517(517 行)、NetworkInterface.c:1-2172(2172 行)。这篇拆: 无连接的 UDP 收发与组播、getaddrinfo 的解析链、getifaddrs 的枚举链。

## 1. DatagramSocket: 无连接的 send/receive

UDP 与 TCP 的 native 差异浓缩在 `send0`(PlainDatagramSocketImpl.c:334)的一个分支里——**connected 状态决定 sendto 的目标从哪来**:

```cpp
// PlainDatagramSocketImpl.c:380-388(截取核心,逐字)
    // arg to NET_Sendto() null, if connected
    if (!connected) {
        packetPort = (*env)->GetIntField(env, packet, dp_portID);
        if (NET_InetAddressToSockaddr(env, packetAddress, packetPort, &rmtaddr,
                                      &len, JNI_TRUE) != 0) {
            return;
        }
        rmtaddrP = &rmtaddr.sa;
    }
```

非 connected: 从 DatagramPacket 里取目标地址/端口转成 sockaddr,`NET_SendTo(fd, fullPacket, packetBufferLen, 0, rmtaddrP, len)`(:433)——**每次 send 都带完整目标**;connected(调过 `connect0` :237): `rmtaddrP=NULL`,sendto 用内核记住的对端——UDP connect 的意义: sendto 免地址、且 recvfrom 只收该对端的包。*关键设计: UDP 没有连接,connected 只是给 sendto 省了地址参数*。

send0 还有两个值得记的细节: ①**大缓冲必须 malloc 整包**(:391-404 注释 "one big send != several smaller sends"——文件 IO/TCP 的 2048 分段策略会破坏 UDP 语义,一次 send 必须是一次 sendto;超过 `MAX_PACKET_LEN`(65536)截断,:405-406);②**ECONNREFUSED→`PortUnreachableException`**(:437-441,connected UDP 收到 ICMP port unreachable)。

`receive0`(:708)对称: `NET_RecvFrom(fd, fullPacket, packetBufferLen, 0, ...)`(:818)→ `NET_SockaddrToInetAddress(env, &rmtaddr, &port)`(:864)把来源地址写回 DatagramPacket。**socketCreate 的选项**在 `datagramSocketCreate`(:891): `SO_BROADCAST`(:939)+`IP_MULTICAST_ALL`(:949,默认关多播接收)。

**组播**: Java 侧 `joinGroup` 走 native `join`(:2180)/`leave`(:2192)(大纲的 "joinGroup" 函数名是 JDK8 残留),都进 `mcast_join_leave`(:1890): IPv4 用 `setsockopt(IPPROTO_IP, IP_ADD_MEMBERSHIP/IP_DROP_MEMBERSHIP, &mreq)`(注释 :1925-1927 "For IPv4 join use IP_ADD_MEMBERSHIP...");IPv6 把 IPv4 组地址转成 **IPv4-mapped 地址**(:2110-2125,`::ffff:a.b.c.d`)走 `IPV6_JOIN_GROUP`;**接口选择**——`netIf` 参数为空则 `getsockopt(IPV6_MULTICAST_IF)`(:2133)取当前默认接口 index,非空则用 `ni_indexID` 字段。TTL 经 `setTimeToLive`(:1786)→`setsockopt(IPPROTO_IP, IP_MULTICAST_TTL, &ittl)`(:1761)。

## 2. InetAddress: getaddrinfo 的解析链

Java 侧分发链: `InetAddress.getByName`(InetAddress.java:1255)→`getAllByName`→`getAllByName0`→`impl.lookupAllHostAddr(host)`(:930)——`impl` 是 `InetAddressImplFactory.create()`(:1141)按平台创建的 Inet4AddressImpl/Inet6AddressImpl。

`Inet4AddressImpl.lookupAllHostAddr`(Inet4AddressImpl.c:105)是 DNS 解析的核心:

```cpp
// Inet4AddressImpl.c:124-139(截取核心,逐字)
    memset(&hints, 0, sizeof(hints));
    hints.ai_flags = AI_CANONNAME;
    hints.ai_family = AF_INET;

    error = getaddrinfo(hostname, NULL, &hints, &res);

    if (error) {
#if defined(MACOSX)
        // If getaddrinfo fails try getifaddrs, see bug 8170910.
        ret = lookupIfLocalhost(env, hostname, JNI_FALSE);
...
        // report error
        NET_ThrowUnknownHostExceptionWithGaiError(env, hostname, error);
```

`hints` 的关键是 `ai_family=AF_INET`——**限定只查 IPv4**(Inet6AddressImpl 用 AF_INET6 或 AF_UNSPEC;大纲"重置 hints 防止 IPv4 优先于 IPv6"是误读,它只是限定地址族)。getaddrinfo 成功后:**去重**(遍历已有结果比较 `sin_addr.s_addr`,:145-178,同一主机多 DNS 记录可能重复)→ 拷贝进新链表 resNew→ `NewObjectArray`(:181) + 逐个构造 InetAddress。错误经 `NET_ThrowUnknownHostExceptionWithGaiError`(:139)报 UnknownHostException。

**getaddrinfo 是 glibc 的**,实证里它的动作一览无余: 先 `open("/etc/hosts")`(本地命中 "localhost"),再查 `/etc/gai.conf`(ENOENT),必要时再向 resolv.conf 的 DNS 服务器发 UDP 查询——**纯库调用,strace 只能看到文件访问**。`getLocalHostName`(:60)更简单: `gethostname`(:64)拿主机名,再 getaddrinfo 规范化。

## 3. NetworkInterface: getifaddrs 与 ioctl

Java 侧 `NetworkInterface.getNetworkInterfaces()`(NetworkInterface.java:357)→ native `getAll()`(:425)。C 侧 `getAll`(NetworkInterface.c:422)三件事: `enumInterfaces`(:816)枚举→计数→`createNetworkInterface`(:659)逐个建 Java 对象。

`enumInterfaces` = **enumIPv4Interfaces(:2004)+enumIPv6Interfaces**,都从 `getifaddrs(&origifa)`(:2007)拿 `struct ifaddrs` 链表,逐项过滤地址族、`addif` 进内部链表——**strace 里的 RTM_GETADDR/RTM_NEWADDR 就是 glibc getifaddrs 内部走的 netlink**。

**MAC 地址不走 getifaddrs**(ifa 里没有硬件地址),而是 `getMacAddress`(NetworkInterface.c:1275):

```cpp
// NetworkInterface.c:1282-1304(截取核心,逐字)
    if ((sock = openSocketWithFallback(env, ifname)) < 0) {
        return -1;
    }

    memset((char *)&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, ifname, sizeof(ifr.ifr_name) - 1);
    if (ioctl(sock, SIOCGIFHWADDR, &ifr) < 0) {
        JNU_ThrowByNameWithMessageAndLastError
            (env, JNU_JAVANETPKG "SocketException", "ioctl(SIOCGIFHWADDR) failed");
        close(sock);
        return -1;
    }

    close(sock);
    memcpy(buf, &ifr.ifr_hwaddr.sa_data, IFHWADDRLEN);

    // all bytes to 0 means no hardware address
    for (i = 0; i < IFHWADDRLEN; i++) {
        if (buf[i] != 0)
            return IFHWADDRLEN;
    }

    return -1;
```

临时 `openSocketWithFallback` 建一个 AF_INET socket(不开监听,只用 ioctl)→ `ioctl(sock, SIOCGIFHWADDR, &ifr)`(:1288)拿 `ifr_hwaddr.sa_data` 的 6 字节→ **全 0 检测**(:1299-1304): 全 0 表示没有硬件地址,返回 -1——实证里 lo 的 `mac=null` 就是这个检测的结果(loopback 无 MAC),eth1 的 `c6:e1:8e:92:05:dc` 是容器 veth 的 MAC。MTU 与标志同理: `getMTU`(:1307,SIOCGIFMTU)/`getFlags`(SIOCGIFFLAGS)也是一组 ioctl。*设计要点: 枚举(名字/地址/掩码)用 getifaddrs 一次拿全,硬件的边角信息(MTU/MAC/标志)用 ioctl 逐个问*。

## 核心悬念

43 域第二条线拆完: DatagramSocket 的 send0/receive0 是"无连接语义的 sendto/recvfrom"(connected 只是省地址参数,大缓冲必须整包,ICMP 回错转 PortUnreachableException);组播 join/leave 走 IP_ADD_MEMBERSHIP(IPv6 转 IPv4-mapped);DNS 是 glibc getaddrinfo 的薄封装(Inet4/Inet6 两实现按族分发,hints 限定地址族,去重后构造数组);网卡枚举是 getifaddrs(内部 netlink)+ioctl(SIOCGIFHWADDR/MTU/FLAGS)的组合。三条路都验证了"native 是系统调用的翻译器"。最后一个域是**文件系统**: java.nio.file 的 stat/readdir 怎么调 POSIX,inotify 怎么监视文件变更。下一篇: NIO FileSystem。

> → [43-nio-net/03 — NIO FileSystem — stat/readdir/inotify](03-filesystem.md)
