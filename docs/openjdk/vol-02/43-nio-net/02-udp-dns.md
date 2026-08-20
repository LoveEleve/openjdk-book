# 02. 为什么 UDP、DNS、网卡枚举看起来像一类 API，底下却完全不是一回事？— Datagram、InetAddress 与 NetworkInterface

> **版本边界**：本文基于 `OpenJDK 11u / Linux / x86_64 / libnet`。这里讨论的是 `java.net` 域里三条常被混看、但底层模型完全不同的 native 路径：UDP `DatagramSocket`、主机名解析 `InetAddress`、网卡枚举 `NetworkInterface`。本文重点是它们的状态模型和系统依赖边界，不展开 NIO datagram channel、Windows 路径或完整 glibc/nsswitch 实现。
>
> **前置依赖**：[01 — 为什么同一条 TCP 在 Java 里会走两条 native 路？— `Socket`、`SocketChannel` 与 `epoll`](01-tcp-epoll.md)
> → **后续**：[03 — NIO FileSystem](03-filesystem.md)

上一章的 TCP 很容易让人形成一种惯性：既然 `java.net` 里的网络 API 最后都要落到 socket、poll、epoll、地址结构这些底层原语，那同一域里的 UDP、DNS、网卡枚举，大概也只是“不同方向的 socket 调用”而已。

顺着源码往下看，你会发现这恰恰是最容易想错的地方。

表面上它们确实都挂在 `java.net` 下面，但底层面对的其实是三种完全不同的“外部输入面”：

- UDP 面对的是**每个报文自带边界和来源**的无连接数据面；
- `InetAddress` 面对的是**把名字交给系统解析器服务**的名字翻译面；
- `NetworkInterface` 面对的是**从内核网络配置视图拼装 Java 对象**的配置面。

这就逼出本篇最该回答的问题：**它们都挂在 `java.net` 下面，看起来都像“网络 API”，为什么底层行为却完全不像一家人？UDP 为什么根本不关心连接状态而关心每个报文的边界；DNS 为什么 JDK 更像是 glibc `getaddrinfo` 的薄翻译层；网卡枚举为什么既要走 `getifaddrs` 又要逐个 ioctl？JDK 到底在统一什么，又没有统一什么？**

先把答案压成一句话：**UDP、DNS、`NetworkInterface` 虽然都属于 `java.net`，但 JDK native 层面对的是三类完全不同的外部输入：UDP 是“每个报文自带边界和来源”的无连接数据面，DNS 是“把主机名交给系统解析器服务”的名字翻译面，网卡枚举是“从内核网络配置视图拼出 Java 对象”的配置面。JDK 在三者中共享的是 JNI/异常/地址结构翻译工具，不共享的是状态模型——连接、解析、枚举本来就不是一回事。**

## 先试两个最自然的理解，看看为什么都不对

### 朴素方案一：`java.net` 底层最终都是一套 socket 调用的薄封装

这是最自然的第一反应。

UDP 有 socket，DNS 解析最后要得到地址，网卡枚举也离不开网卡和 IP 地址。既然都和网络打交道，那大概底层就是一批 `socket`、`connect`、`sendto`、`recvfrom`、`ioctl` 之类调用的不同排列组合。

这个理解的问题在于，它把“都和网络相关”误当成了“都共享同一状态模型”。

实际上这三条线分别在问三种完全不同的问题：

- UDP 在问：这个报文现在发给谁、从谁那里收来、边界在哪里；
- DNS 在问：这个名字在系统解析器看来对应哪些地址；
- 网卡枚举在问：系统当前有哪些接口、地址、掩码、MAC、MTU、flag。

它们甚至连“状态”这件事都不一样：

- UDP 更关心每个报文自己的目标与来源；
- DNS 更关心一次解析请求返回的一组结果；
- `NetworkInterface` 更关心一份系统配置快照。

所以第一种朴素方案失败，不是因为三者完全不碰 socket，而是因为**JDK 共享的只是底层工具，不是同一套语义模型。**

### 朴素方案二：JDK 自己实现了 DNS 和网卡枚举的主体逻辑

第二个也很自然的想法是：既然这些功能都对 Java API 很重要，那 JDK 大概会自己把解析器、接口枚举器这些都完整实现一遍，最多最后再借几个 libc 或内核调用。

这对 UDP 路径不算太离谱，因为 UDP 的收发和组播行为很多确实是 JDK 自己在组织协议细节。

但对 DNS 和 `NetworkInterface` 并不成立。

- `InetAddress` 在 Unix/Linux 上大量依赖 `getaddrinfo`，JDK 更像是在把系统解析器返回的结果去重、包装成 Java 对象，再把错误翻译成 `UnknownHostException`；
- `NetworkInterface` 则先用 `getifaddrs` 吃系统给出的接口链表，再额外用 `ioctl` 去补 MAC、MTU、flags 这类边角硬件属性。

也就是说，JDK 在这里更多是一个**翻译器和组装器**，不是完整替代 glibc 和内核配置接口的重实现者。

所以第二种朴素方案失败，不是因为 JDK 什么都没做，而是因为**它做的重点是把系统已有视图翻成 Java 语义，而不是自己再造一套同类系统服务。**

这两个失败方案合起来，正好引出本篇主线：**这三条路径同属 `java.net`，但面对的是三类不同输入面，JDK 统一的是翻译方式，不是状态模型。**

## `DatagramSocket`：为什么 connected UDP 也仍然是“每个报文一笔账”

先看最容易被拿来和 TCP 类比、也最容易被类比错的一条线：UDP。

`PlainDatagramSocketImpl.send0()` 最关键的分叉不是 IPv4/IPv6，而是 `connected`。`src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:334`

### connected 只是在决定“目标从哪来”

源码很直接：如果 socket 还没 connected，就从 `DatagramPacket` 里取出 address/port，转成 `sockaddr`，再把 `rmtaddrP` 指过去；如果已经 connected，就让 `rmtaddrP` 保持 NULL。`src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:380`

这一步非常值得停一下，因为它几乎浓缩了 UDP 与 TCP 的精神差异。

TCP 里的 connect 是“建立一条有状态连接”；UDP 里的 connect 在这里并不是创建一条 TCP 式会话，而更像是：

- 以后发包时不用每次再显式带目标地址；
- 收包时只接这个对端来的数据；
- 某些 ICMP 错误（如 port unreachable）会更直接反馈回来。

也就是说，**connected UDP 的本质仍然是报文协议，只是“目标是谁”从每包自带，变成了 socket 上记住的默认值。**

这一步很适合拿来纠正一个常见误解：connected UDP 不是变成了“小号 TCP”，它只是给 send/receive 增加了一层默认对端语义。

### 为什么大报文必须整包 malloc

`send0()` 里还有一段非常有代表性的注释：当报文大于默认栈上缓冲时，JDK 不能像文件 I/O 或 TCP 那样把大块数据拆成多个小段慢慢发，因为“one big send != several smaller sends”。所以这里必须整包分配缓冲，必要时还会按 `MAX_PACKET_LEN` 截断。`src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:390`

这段注释特别能体现 UDP 的本体：**对 UDP 来说，报文边界就是语义。**

文件 I/O 和 TCP 流里，分段搬运通常只是性能或缓冲策略问题；而在 UDP 里，分段发送会直接改变协议语义，因为接收方看到的就不再是“一个报文”，而是几个报文。

所以 JDK 这里不是单纯在优化 native 缓冲策略，而是在保护 UDP 最核心的协议边界。

### `ECONNREFUSED -> PortUnreachableException` 说明了什么

`NET_SendTo` 失败后，`send0()` 对 `ECONNREFUSED` 有一个专门分支，直接翻译成 `PortUnreachableException`。`src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:433`

这一步也很值得记，因为它说明 UDP 虽然“不建连接”，但在 connected 语义下，内核仍然会把某些与对端可达性相关的网络反馈（例如 ICMP port unreachable）转回来，而 JDK 又把这种反馈翻成 Java 世界能理解的异常语义。

这再次印证了本篇主线：JDK 统一的是“如何把底层网络反馈翻译给 Java”，不是把各种网络协议都揉成一种状态模型。

## receive 与组播：为什么无连接数据面更依赖“来源回填”和 setsockopt 组合

UDP 的另一半是接收。

`receive0()` 这条线和 send 的最大不同，在于它不仅要拿到一段字节，还要把**来源地址和端口回填**到 `DatagramPacket` 里。`src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:708`

### `receive0`：真正返回的不只是 payload

`receive0()` 在 timeout 存在时仍会先走 `NET_Timeout` 等待，然后调用 `NET_RecvFrom` 真正收包。`src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:818`

拿到数据后，它不会像 TCP 的 `read()` 那样只把字节塞回缓冲区就算完，而是还要：

- 从 `sockaddr` 里构造或复用 `InetAddress`；
- 回填 `DatagramPacket.address`；
- 回填 `DatagramPacket.port`；
- 再写入 payload 和 length。`src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:842`

这一步非常能说明 UDP 的协议本体：**一个 receive 的结果天然包含“是谁发来的”这部分元信息。**

TCP 流里“来源是谁”基本已经由 socket 对象持有，不必对每个 read 反复回填；UDP 则不一样，每个报文都可能来自不同地方，所以接收语义本身就包含来源写回。

### 组播为什么会拖出一长串 `setsockopt`

再往下看组播，`mcast_join_leave()` 会根据 IPv4/IPv6、是否有接口对象、接口 index、IPv4-mapped 地址这些条件，分不同路径组织 `IP_ADD_MEMBERSHIP` / `IP_DROP_MEMBERSHIP` 或 `IPV6_JOIN_GROUP` / `IPV6_DROP_GROUP` 之类的 `setsockopt` 调用。`src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:1890`

这说明组播不是“普通 send/recv 再多一个组地址参数”，而是一套高度依赖 socket option 的协议配置面。

而 TTL 这条线也一样，`setTimeToLive()` 不是修改一个 Java 字段，而是实际下沉到：

- IPv4 的 `IP_MULTICAST_TTL`
- 以及 IPv6 的 hop limit 路径。`src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:1786`

这很能说明 UDP 这条线为什么不能和上一章 TCP 视作同一模型：**TCP 的重点是连接状态和就绪等待；UDP 这里的重点反而更像“每包元信息 + 多播/TTL 这类配置型 socket 选项”。**

所以本节最该记住的一句话是：**UDP 的 native 路径核心不是连接，而是报文边界、来源回填和 socket 选项组合。**

## `InetAddress`：为什么 JDK 更像 `getaddrinfo` 的翻译器，而不是 DNS 实现者

接下来切到名字解析这条线。

如果把 UDP 想成“报文面”，那 `InetAddress` 更像“名字到地址的翻译面”。它在 native 里最重要的事实，不是“会发 DNS 包”，而是：**在 Unix/Linux 上，JDK 大量把这件事交给了系统解析器。**

### `lookupAllHostAddr`：关键不是自己解析，而是给 `getaddrinfo` 设 hints

`Inet4AddressImpl.lookupAllHostAddr` 一开头会：

- 清空 `hints`；
- 设 `AI_CANONNAME`；
- 设 `ai_family = AF_INET`；
- 然后直接调用 `getaddrinfo(hostname, NULL, &hints, &res)`。`src/java.base/unix/native/libnet/Inet4AddressImpl.c:64`

这段代码里最容易忽略的一点，是 `Inet4AddressImpl` 本身并没有试图“实现 DNS”，它主要在做两件事：

- 选定这次向系统解析器提出的约束（这里只要 IPv4）；
- 把系统解析器返回的结果整理成 Java 对象。

所以 `Inet4AddressImpl` 真正的角色，不是解析器，而是**系统解析服务的 Java 侧翻译器**。

### 为什么后面还要去重和重新组链

`getaddrinfo` 返回结果后，JDK 会沿 `addrinfo` 链表去重：如果两个结果里的 `sin_addr.s_addr` 一样，就跳过重复项；否则才复制进自己的 `resNew` 链表，最后再构造 Java 数组和 `InetAddress` 对象。`src/java.base/unix/native/libnet/Inet4AddressImpl.c:95`

这一步非常说明 JDK 的角色边界：

- 它不决定解析顺序，不决定 `/etc/hosts`、`resolv.conf`、DNS 服务器、nsswitch 那些策略；
- 但它会对系统返回值做 Java 世界需要的清洗、去重和对象化。

也就是说，JDK 没在重做系统解析器，却也不是纯粹透明透传。

### UnknownHostException 也是翻译产物，不是解析器原生对象

当 `getaddrinfo` 返回错误时，JDK 走的是 `NET_ThrowUnknownHostExceptionWithGaiError`，把 `hostname + gai_strerror()` 拼成 `UnknownHostException`。`src/java.base/unix/native/libnet/net_util_md.c:419`

这很能说明本篇主线：**系统调用/库调用给你的只是 errno、gai_error、链表、sockaddr 这些原始世界结构；JDK 要负责把它们翻成 Java API 承诺的异常和对象。**

所以这一节最该记住的一句话是：**在 Unix 路径里，DNS 解析更多是系统解析器在工作，JDK 负责的是约束、去重、对象化和异常翻译。**

## `NetworkInterface`：为什么 `getifaddrs` 还不够，还得逐个 `ioctl`

最后看网卡枚举。

如果说 UDP 是“数据面”，DNS 是“名字面”，那 `NetworkInterface` 更像“配置面”：它关心的是系统当前有哪些网卡、各自挂了哪些地址、MTU 多大、MAC 是什么、flag 怎么样。

### `getAll()`：真正的第一层其实只是把 native 列表翻成 Java 数组

`NetworkInterface.getAll()` native 入口自己并不复杂：先调 `enumInterfaces()` 拿一份 native 链表，数一遍长度，再逐个 `createNetworkInterface()` 构造 Java 对象。`src/java.base/unix/native/libnet/NetworkInterface.c:422`

这和前几篇很多 native 入口一样，说明 Java 边界点通常只是“拿一份 native 世界组织好的中间结构，再翻成 Java 容器”。

真正复杂的是 `enumInterfaces()` 本身。

### `enumInterfaces()`：先用 `getifaddrs` 拿地址视图

`enumInterfaces()` 会先打开一个 IPv4 socket，然后跑 `enumIPv4Interfaces()`；如果 IPv6 可用，再补跑一轮 `enumIPv6Interfaces()`。`src/java.base/unix/native/libnet/NetworkInterface.c:816`

这些函数的核心来源是 `getifaddrs`：也就是说，名字、地址、掩码、广播地址这类“接口地址视图”，JDK 不是自己发 netlink 或 ioctl 零拼，而是先吃系统给出的 `ifaddrs` 链表，再组装自己的 `netif` / `netaddr` 结构。

这一步特别重要，因为它说明 `NetworkInterface` 的主输入并不是 socket 数据流，而是**内核对网络配置的枚举视图**。

### 为什么 `getifaddrs` 还不够

如果 `getifaddrs` 真给齐了一切，那 `NetworkInterface` 大概在这里就结束了。

但实际并没有。

MAC 地址、MTU、flags 这些信息，JDK 仍然要额外通过 `ioctl` 去问：

- `SIOCGIFHWADDR` 拿 MAC；
- `SIOCGIFMTU` 拿 MTU；
- `SIOCGIFFLAGS` 拿 flags。`src/java.base/unix/native/libnet/NetworkInterface.c:1275`

这说明系统给 JDK 的“接口配置视图”本来就是分散的：地址类信息和硬件/控制类信息，不在一个统一容器里一次返回。

所以 `NetworkInterface` 的真正工作，是把这几路来源重新拼装成 Java 世界里的“一个接口对象”。

### `getMacAddress`：为什么还要特判“全 0 MAC”

`getMacAddress()` 里一个特别值得讲的小细节是：把 `SIOCGIFHWADDR` 读回来的 6 字节复制出来后，会逐字节检查，如果全是 0，就返回 -1，也就是“没有硬件地址”。`src/java.base/unix/native/libnet/NetworkInterface.c:1275`

这正说明 JDK 不是无脑把 ioctl 返回的每个字节都原样上抛，而是在做“**这对 Java API 来说到底算不算一个有效 MAC**”的语义判断。

所以本节最该记住的一句话是：**网卡枚举不是单次系统调用结果，而是 `getifaddrs` 和多组 `ioctl` 拼起来的一份 Java 配置对象。**

## 到这里为止，主线其实只发生了四件事

如果前面细节不少，这里先把整件事压回四步：

1. UDP 这条线关心的是报文边界、来源回填和组播/TTL 配置，而不是连接状态；
2. DNS 这条线关心的是把系统解析器结果翻成 Java 地址对象与异常；
3. `NetworkInterface` 这条线关心的是把内核配置枚举视图拼成 Java 接口对象；
4. 三者共享的是 JNI/异常/地址结构翻译工具，不共享的是底层状态模型。

只要这四步还在脑子里，这一篇就不会再像“三段 unrelated native 代码”的并排介绍。

## 常见误解澄清

### 误解一：connected UDP 就等于 TCP 式连接

不是。

它的主要意义是给 send 省目标参数、给 receive 限定来源，并接住某些 ICMP 错误反馈；报文边界和无连接本质都没变。`src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:380`

### 误解二：DNS 解析是 JDK 自己实现的一套完整解析器

不对。

Unix/Linux 路径里，核心工作主要还是 `getaddrinfo` 和系统解析器在做；JDK 负责的是 hints、去重、对象化和异常翻译。`src/java.base/unix/native/libnet/Inet4AddressImpl.c:64`

### 误解三：`Inet4AddressImpl` 这里的 `getaddrinfo` 会自然把 IPv4/IPv6 都一起返回

不是。

这里明确把 `hints.ai_family` 限定成了 `AF_INET`，也就是只走 IPv4 结果集。`src/java.base/unix/native/libnet/Inet4AddressImpl.c:64`

### 误解四：`getifaddrs` 就能直接给出 MAC、MTU 和 flags

不够。

地址和掩码主要来自 `getifaddrs`，但 MAC、MTU、flags 仍要通过 `ioctl` 分别补问。`src/java.base/unix/native/libnet/NetworkInterface.c:816`、`src/java.base/unix/native/libnet/NetworkInterface.c:1275`

### 误解五：`PortUnreachableException` 只会出现在“连接型协议”里

也不是。

connected UDP 在收到 ICMP port unreachable 时同样会把 `ECONNREFUSED` 翻译成 `PortUnreachableException`。`src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:433`

## 收网：同属 `java.net`，不等于共享同一种 native 状态模型

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
UDP
  DatagramPacket / DatagramSocket
    ├─ sendto/recvfrom
    ├─ connected 只改变“目标从哪来/收谁的包”
    └─ 组播靠 setsockopt(IP_ADD_MEMBERSHIP/IPV6_JOIN_GROUP)

DNS
  InetAddress
    └─ getaddrinfo(hostname, hints)
         ├─ 系统解析器决定 /etc/hosts / DNS 服务器顺序
         └─ JDK 负责去重、对象构造、异常翻译

网卡枚举
  NetworkInterface
    ├─ getifaddrs -> 名字/地址/掩码
    └─ ioctl(SIOCGIFHWADDR/MTU/FLAGS) -> MAC/MTU/标志
```

把它再压成三句话：

- UDP、DNS、`NetworkInterface` 都在 `java.net` 里，但底层分别面向报文、名字和配置三种不同输入面。
- JDK 在三者中统一的是“如何把系统返回值翻成 Java 对象和异常”，而不是统一底层状态模型。
- 一旦读懂这一点，就不会再把 connected UDP、`getaddrinfo` 和 `getifaddrs` 当成同一类网络原语的不同写法。

所以这一篇真正该留下来的，不是三份系统调用菜单。

真正该留下来的是：**`java.net` 看上去像一个域，底层却连接着三种完全不同的外部世界；JDK native 层做的，是把这三种输入面各自翻译成 Java 侧觉得“像一回事”的对象语义。**

下一篇就顺着这个思路离开网络域，转到另一类同样是“外部世界快照”的输入面：文件系统。那时 JNI 和 native 层又会再次扮演翻译器，但对象、错误模型和事件来源都会换成目录项、stat 和 inotify。

> → [03 — NIO FileSystem](03-filesystem.md)
