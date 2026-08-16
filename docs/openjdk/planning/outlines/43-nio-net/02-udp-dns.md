# 02. UDP + DNS + NetworkInterface — Datagram + InetAddress

> 🟡 Working | UDP send/receive + getaddrinfo + getifaddrs
> 读者处境: `DatagramSocket.send(packet)`→sendto syscall→无连接(no connect step)。`InetAddress.getByName("google.com")`→Native getaddrinfo→DNS→IPv4+IPv6 addresses。`NetworkInterface.getNetworkInterfaces()`→native getifaddrs→MAC/IP/MTU。

> ⚠️ 写作期修正(2026-08-16,43-nio-net/02 完成):
> - **"joinGroup(env, this, mcastaddr, netIf)" 名字错**: 真实 native=**join**(PlainDatagramSocketImpl.c:2180)/**leave**(:2192)→`mcast_join_leave`(:1890): IPv4 用 setsockopt IP_ADD_MEMBERSHIP/IP_DROP_MEMBERSHIP(注释 :1925-1927);IPv6 把 IPv4 组地址转 IPv4-mapped(::ffff:a.b.c.d,:2110-2125)走 IPV6_JOIN_GROUP;接口选择=niObj 空→getsockopt(IPV6_MULTICAST_IF)(:2133)取默认,非空→ni_indexID
> - **行号全错**: send0=**:334**(非 300-500,函数名是 send0 非 send);receive0=**:708**(NET_RecvFrom :818/NET_SockaddrToInetAddress :864);joinGroup 在 **:2180**(非 1400-1500);setTimeToLive=**:1786**(IP_MULTICAST_TTL :1761);datagramSocketCreate=**:891**(SO_BROADCAST :939/IP_MULTICAST_ALL :949)
> - **send0 细节(大纲漏,重要)**: connected 时 rmtaddrP=NULL(注释 "arg to NET_Sendto() null, if connected" :380)——UDP connect 的意义=sendto 免地址+recvfrom 只收对端;大缓冲必须 malloc 整包(注释 "one big send != several smaller sends" :391-404,2048 分段策略破坏 UDP 语义;MAX_PACKET_LEN 65536 截断 :405-406);ECONNREFUSED→PortUnreachableException(:437-441,ICMP)
> - **"AF_INET 重置 hints 防止 IPv4 优先于 IPv6" 误读**: hints.ai_family=AF_INET(Inet4AddressImpl.c:126)只是**限定地址族**;lookupAllHostAddr=**:105**(getaddrinfo :128,去重 :145-178,NewObjectArray :181);getLocalHostName=**:60**(gethostname :64)
> - **NetworkInterface 行号错**: getAll=**:422**;getMacAddress=**:1275**(ioctl SIOCGIFHWADDR :1288,**全 0 检测** :1298-1304=无硬件地址返回 -1——loopback mac=null 的机制);getMTU=**:1307**;大纲"getHardwareAddress(500-700)"错(500-700 是别的内容)
> - **getifaddrs 内部=netlink(实证)**: enumInterfaces(:816)=enumIPv4Interfaces(:2004,getifaddrs :2007)+enumIPv6Interfaces;strace 的 RTM_GETADDR/RTM_NEWADDR 是 glibc getifaddrs 内部的 netlink 实现
> - **悬念指向** ✓(03-filesystem);素材: 33-nio-udp-strace.txt(UDP sendto/recvfrom 全链路+getaddrinfo 文件访问+netlink 枚举)

### 1. "PlainDatagramSocketImpl — UDP send/receive"

场景: `DatagramSocket socket = new DatagramSocket(9999); socket.send(new DatagramPacket(buf, len, addr, port))` — native send→sendto→immediate(无连接→no 3-way handshake)。

**PlainDatagramSocketImpl** (`PlainDatagramSocketImpl.c:300-800`):
```
Java_java_net_PlainDatagramSocketImpl_send(env, this, packet):
  → NET_InetAddressToSockaddr(dst_addr) → struct sockaddr
  → NET_SendTo(fd, buf, len, flags, &sa, sa_len) → sendto() syscall
  → 无连接——每次 send 指定目标地址

Java_java_net_PlainDatagramSocketImpl_receive(env, this, packet):
  → NET_RecvFrom(fd, buf, len, flags, &sa, &sa_len)
  → sockaddr→NET_SockaddrToInetAddress(env, &sa, &port)
  → set packet address+port+length

Java_java_net_PlainDatagramSocketImpl_joinGroup(env, this, mcastaddr, netIf):
  → setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq)
  → IGMP join → kernel 开始接收组播包
```
- 源码: `PlainDatagramSocketImpl.c:300-500` (send) + `PlainDatagramSocketImpl.c:500-700` (receive) + `PlainDatagramSocketImpl.c:1400-1500` (joinGroup)

- 关键设计: **组播(IP_ADD_MEMBERSHIP)** — setsockopt 注册 IGMP——kernel 开始接收组地址的包→网卡硬件 filter(MAC=01:00:5E)+软件 filter(IP)。**setTimeToLive** — setsockopt(IP_MULTICAST_TTL)→控制组播范围(TTL=1→本子网, TTL=32→同 AS)。

### 2. "InetAddress — DNS 解析 (getaddrinfo)"

场景: `InetAddress.getByName("www.google.com")`→Inet4AddressImpl.lookupAllHostAddr→getaddrinfo("www.google.com", NULL, &hints)→IPv4/IPv6 地址→InetAddress[]。

**Inet4AddressImpl** (`Inet4AddressImpl.c:100-300`):
```
Java_java_net_Inet4AddressImpl_lookupAllHostAddr(env, this, host):
  → getaddrinfo(host, NULL, &hints_AF_INET)→addrinfo linked list→IPv4 only
  → 遍历 results→extract sin_addr→create Inet4Address Java objects
  → return InetAddress[]

Java_java_net_Inet4AddressImpl_getLocalHostName(env, this):
  → gethostname(buf, NI_MAXHOST)→return Java String
[C++: Inet4AddressImpl.c:517行——getaddrinfo 替代已弃用的 gethostbyname(线程安全)]
```
- 源码: `Inet4AddressImpl.c:100-250` (lookupAllHostAddr→getaddrinfo loop) + `Inet6AddressImpl.c:100-300` (IPv6 version)

- 关键设计: **Inet4 和 Inet6 是**两个独立 native 类——InetAddress 根据 address 的字节数(4→IPv4, 16→IPv6)分发。**getaddrinfo 是 glibc**——结果来自 `/etc/hosts`+`/etc/resolv.conf` DNS 配置→thread-safe(AF_INET 重置 hints 防止 IPv4 优先于 IPv6)。

### 3. "NetworkInterface"

场景: `NetworkInterface.getNetworkInterfaces()`→getAll→getifaddrs→linked list→per-interface: name+index+MAC+IPv4/IPv6 addresses→Enumeration<NetworkInterface>。

**NetworkInterface.c** (`NetworkInterface.c:200-500`):
```
Java_java_net_NetworkInterface_getAll(env, cls):
  → getifaddrs(&ifap) → ifaddrs linked list
  → 遍历→区分 physical/loopback/point-to-point
  → per-interface: ifa_name(eth0/wlan0/lo), ifa_flags(IFF_UP/IFF_RUNNING/IFF_LOOPBACK)
  → MAC: ioctl(sock, SIOCGIFHWADDR, &ifr)→ifr_hwaddr.sa_data(6 bytes)
  → IPv4/IPv6: ifa_addr(sockaddr_in/sockaddr_in6)→extract IP + netmask
[C++: NetworkInterface.c:2172行——getifaddrs 返回所有接口 including tun/bridge/wireguard]
```
- 源码: `NetworkInterface.c:200-400` (getAll→getifaddrs→per-interface loop) + `NetworkInterface.c:500-700` (getHardwareAddress→ioctl SIOCGIFHWADDR)

- 关键设计: **SIOCGIFHWADDR(ioctl)** 读取 MAC 地址——socket ioctl 需要临时创建一个 AF_INET socket(不需绑定)→然后 close。**MAC 在 loopback 不可用** — ioctl 返回 `00:00:00:00:00:00`。

---

### 核心悬念

**"DatagramSocket: send→sendto(无连接)+receive→recvfrom+组播→IP_ADD_MEMBERSHIP。InetAddress: getaddrinfo→DNS→IPv4/IPv6→InetAddress[]。NetworkInterface: getifaddrs→per-if name+MAC(SIOCGIFHWADDR)+IPv4/IPv6。"** — 下一篇: NIO FileSystem (stat/readdir/inotify)。

> → [03-filesystem.md](03-filesystem.md)
