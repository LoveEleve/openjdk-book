# 43-nio-net/02-udp-dns 重写规划

> 基于 `OpenJDK 11u / Linux / x86_64 / libnet`
> 目标：解释 UDP、DNS、网卡枚举为什么虽然都挂在 `java.net` 域里，但底层其实对应三种完全不同的“外部输入”模型：无连接报文、名字解析服务、系统网络配置枚举；并把 DatagramSocket、InetAddress、NetworkInterface 的 native 路径收成一条统一的翻译主线

## 1. 选题判断

现稿已有较强事实基础：
- `PlainDatagramSocketImpl.send0/receive0`
- `mcast_join_leave` / TTL / 组播接口逻辑
- `Inet4AddressImpl.lookupAllHostAddr` / `getaddrinfo`
- `NetworkInterface.getAll` / `enumInterfaces` / `getMacAddress`

但当前正文仍偏“UDP 一节 + DNS 一节 + 网卡枚举一节”的并列清单。真正该打穿的读者困惑更集中：

**它们都挂在 `java.net` 下面，看起来都像“网络 API”，为什么底层行为却完全不像一家人？UDP 为什么根本不关心连接状态而关心每个报文的边界；DNS 为什么 JDK 更像是 glibc `getaddrinfo` 的薄翻译层；网卡枚举为什么既要走 `getifaddrs` 又要逐个 ioctl？JDK 到底在统一什么，又没有统一什么？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**UDP、DNS、NetworkInterface 虽然都属于 `java.net`，但 JDK native 层面对的是三类完全不同的外部输入：UDP 是“每个报文自带边界和来源”的无连接数据面，DNS 是“把主机名交给系统解析器服务”的名字翻译面，网卡枚举是“从内核网络配置视图拼出 Java 对象”的配置面。JDK 在三者中共享的是 JNI/异常/地址结构翻译工具，不共享的是状态模型——连接、解析、枚举本来就不是一回事。**

## 3. 总图

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

## 4. 结构大纲与字数预算

### 第一节：开场困惑——同属 `java.net`，为什么三条 native 路几乎互不相像

目标约 1200 字。

- 从 UDP echo、`InetAddress.getByName("localhost")`、`NetworkInterface.getNetworkInterfaces()` 并列切入
- 点出三者底层分别是 sendto/recvfrom、getaddrinfo、getifaddrs+ioctl
- 埋主线：JDK 统一的是 Java 语义入口，不是内核数据源形态

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. `java.net` 底层最终都是一套 socket 调用的薄封装
2. JDK 自己实现 DNS 和网卡枚举主逻辑，不依赖 libc/内核视图

结论：
- UDP、DNS、网卡枚举的状态模型根本不同
- JDK 很多时候是在翻译系统服务结果，而不是自己重做系统服务

### 第三节：DatagramSocket——为什么 connected UDP 也仍然是“每个报文一笔账”

目标约 2200 字。

- `send0`
- `connected` 分支只是决定是否显式构造远端 sockaddr
- 大报文必须整包 malloc，不像 TCP/文件能分段搬
- `ECONNREFUSED -> PortUnreachableException`
- 强调 UDP 的核心是报文边界，不是连接状态

### 第四节：receive 与组播——为什么无连接数据面反而更依赖地址回填与 setsockopt 组合

目标约 2200 字。

- `receive0`
- timeout 仍然是 `NET_Timeout`
- 来源地址回填到 DatagramPacket
- `mcast_join_leave`
- IPv4/IPv6 分支、IPv4-mapped 地址、接口 index 与 TTL
- 收回“UDP 语义核心是每个报文自带来源/目标”主线

### 第五节：InetAddress——为什么 JDK 更像 getaddrinfo 的翻译器而不是 DNS 实现者

目标约 2000 字。

- `lookupAllHostAddr`
- `hints.ai_family = AF_INET`
- `getaddrinfo`
- 去重与数组构造
- `NET_ThrowUnknownHostExceptionWithGaiError`
- 强调系统解析策略（/etc/hosts、resolv.conf、nsswitch）主要不由 JDK 决定

### 第六节：NetworkInterface——为什么 getifaddrs 还不够，还得逐个 ioctl

目标约 2200 字。

- `getAll` / `enumInterfaces`
- `enumIPv4Interfaces + enumIPv6Interfaces`
- `getifaddrs` 负责名字/地址/掩码
- `getMacAddress/getMTU/getFlags` 用 ioctl 补边角硬件属性
- 全 0 MAC 判空
- 收回“配置面 ≠ 数据面 ≠ 名字解析面”主线

### 第七节：误解澄清与收网

目标约 1300 字。

至少回答：
1. connected UDP 是否等于 TCP 式连接
2. DNS 解析是否由 JDK 自己实现完整递归逻辑
3. `getaddrinfo` 是否天然同时返回 IPv4/IPv6 于 `Inet4AddressImpl`
4. getifaddrs 是否能直接给出 MAC/MTU
5. `PortUnreachableException` 是否只会出现在 connect 语义里

## 5. 失败方案必须写进正文

1. 把 UDP、DNS、网卡枚举都看成同一类“socket 封装”
2. 把 DNS 解析看成 JDK 自己实现的解析器
3. 把 getifaddrs 当成网卡所有属性的单一来源

## 6. 证据清单

- `src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:334`：`send0`
- `src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:380`：connected 与 `rmtaddrP`
- `src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:390`：UDP 整包 malloc 注释
- `src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:433`：`NET_SendTo`
- `src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:708`：`receive0`
- `src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:818`：`NET_RecvFrom`
- `src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:1786`：`setTimeToLive`
- `src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:1890`：`mcast_join_leave`
- `src/java.base/unix/native/libnet/Inet4AddressImpl.c:64`：`lookupAllHostAddr`
- `src/java.base/unix/native/libnet/net_util_md.c:419`：`NET_ThrowUnknownHostExceptionWithGaiError`
- `src/java.base/unix/native/libnet/NetworkInterface.c:422`：`getAll`
- `src/java.base/unix/native/libnet/NetworkInterface.c:816`：`enumInterfaces`
- `src/java.base/unix/native/libnet/NetworkInterface.c:1275`：`getMacAddress`
- `src/java.base/unix/native/libnet/NetworkInterface.c:1307`：`getMTU`
- `src/java.base/unix/native/libnet/NetworkInterface.c:1321`：`getFlags`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / Linux / x86_64 / libnet`
- 本篇聚焦 UDP、DNS、NetworkInterface，NIO datagram / multicast channel 不展开
- 解析链主要讲系统调用/库调用边界，不扩成 glibc/nsswitch 全专题
- NetworkInterface 只讲 native 枚举与属性来源，不扩展到 Java 侧缓存策略
- 下一篇若继续文件系统，要让本篇自然收束在“网络域剩余输入面”上

## 8. 完成后 review

- 删除代码后，能否复述“UDP、DNS、网卡枚举是三类不同输入面，不共享同一状态模型”
- 是否清楚区分 JDK 翻译系统服务结果 与 JDK 自己实现协议逻辑 的边界
- 是否讲清 connected UDP 只是省目标参数/限制来源，不是 TCP 连接
- 是否讲清 getifaddrs 与 ioctl 的职责拆分
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
