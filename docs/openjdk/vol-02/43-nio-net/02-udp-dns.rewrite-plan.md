# 43-nio-net/02-udp-dns 重写规划

> 基于 `OpenJDK 11u / Linux / x86_64 / libnet`
> 目标：解释为什么 UDP、DNS、网卡枚举都挂在 `java.net` 下面，但底层面对的是三类完全不同的输入面：报文、名字解析、配置视图

## 1. 选题判断

现稿事实基础很强：
- `PlainDatagramSocketImpl.send0/receive0/mcast_join_leave/setTimeToLive`
- `Inet4AddressImpl.lookupAllHostAddr` / `net_util_md.c` 的 UnknownHostException 翻译
- `NetworkInterface.getAll` / `enumInterfaces` / `getifaddrs` / `ioctl`

真正该打穿的困惑更集中：

**它们都挂在 `java.net` 下面，看起来都像“网络 API”，为什么底层行为却完全不像一家人？UDP 为什么根本不关心连接状态而关心每个报文的边界；DNS 为什么 JDK 更像是 glibc `getaddrinfo` 的薄翻译层；网卡枚举为什么既要走 `getifaddrs` 又要逐个 ioctl？JDK 到底在统一什么，又没有统一什么？**

## 2. 一句话顿悟

**UDP、DNS、`NetworkInterface` 虽然都属于 `java.net`，但 JDK native 层面对的是三类完全不同的外部输入：UDP 是“每个报文自带边界和来源”的无连接数据面，DNS 是“把主机名交给系统解析器服务”的名字翻译面，网卡枚举是“从内核网络配置视图拼出 Java 对象”的配置面。JDK 在三者中共享的是 JNI/异常/地址结构翻译工具，不共享的是状态模型——连接、解析、枚举本来就不是一回事。**

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
         ├─ 系统解析器决定 /etc/hosts / DNS / nsswitch 顺序
         └─ JDK 负责去重、对象构造、异常翻译

网卡枚举
  NetworkInterface
    ├─ getifaddrs -> 名字/地址/掩码
    └─ ioctl(SIOCGIFHWADDR/MTU/FLAGS) -> MAC/MTU/标志
```

## 4. 结构大纲

### 第一节：开场困惑——同属 `java.net`，为什么完全不像一家人

- 从“都和网络相关”切入
- 点出三条完全不同输入面：报文 / 名字 / 配置视图
- 埋主线：JDK 统一的是翻译方式，不是状态模型

### 第二节：两个朴素方案为什么都不对

1. `java.net` 底层最终都是一套 socket 调用的薄封装
2. JDK 自己实现了 DNS 和网卡枚举的主体逻辑

### 第三节：UDP——connected 也仍然是“每个报文一笔账”

- `send0` 的 connected 分叉
- “大报文必须整包 malloc” 的语义原因
- `ECONNREFUSED -> PortUnreachableException`
- `receive0` 的来源回填
- 组播与 TTL 的 setsockopt 组合

### 第四节：`InetAddress`——JDK 是系统解析器的翻译器

- `lookupAllHostAddr` 的 hints + `getaddrinfo`
- 去重与对象化
- `NET_ThrowUnknownHostExceptionWithGaiError`

### 第五节：`NetworkInterface`——先吃 `getifaddrs`，再补 `ioctl`

- `getAll()` 翻译 native 链表
- `enumInterfaces()` 分 IPv4/IPv6
- MAC / MTU / flags 的额外 `ioctl`
- 全 0 MAC 的语义判断

### 第六节：误解澄清与收网

## 5. 失败方案

1. `java.net` 底层最终都是一套 socket 薄封装
2. JDK 自己实现了 DNS 和网卡枚举的主体逻辑

## 6. 证据清单

- `src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:334-447`
- `src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:708-870`
- `src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:1786`
- `src/java.base/unix/native/libnet/PlainDatagramSocketImpl.c:1890`
- `src/java.base/unix/native/libnet/Inet4AddressImpl.c:64-170`
- `src/java.base/unix/native/libnet/net_util_md.c:419`
- `src/java.base/unix/native/libnet/NetworkInterface.c:422-520`
- `src/java.base/unix/native/libnet/NetworkInterface.c:816`
- `src/java.base/unix/native/libnet/NetworkInterface.c:1275`

## 7. 完成后 review

- 删除代码后，能否复述“三类输入面：报文 / 名字 / 配置视图”
- 是否讲清 UDP 的 connected 不等于 TCP 连接
- 是否讲清 DNS 主要依赖系统解析器
- 是否讲清 `getifaddrs` + `ioctl` 的双来源
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验