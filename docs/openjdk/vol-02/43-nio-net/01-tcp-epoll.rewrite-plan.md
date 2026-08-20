# 43-nio-net/01-tcp-epoll 重写规划

> 基于 `OpenJDK 11u / Linux / x86_64 / libnet + libnio`
> 目标：解释同样是 TCP，为什么 Java 世界会分成“阻塞式 Socket”与“NIO Channel + Selector”两条 native 路径；并讲清 JDK 怎样把超时、非阻塞 connect、epoll 等 Linux 原语组织成两种完全不同的上层语义

## 1. 选题判断

现稿已有很强事实基础：
- `PlainSocketImpl.c` 的 connect/accept/close 逻辑
- `SocketInputStream.c`
- `Net.c` 的非阻塞三态返回
- `EPoll.c` / `EPoll.java` / `EPollSelectorImpl.java`
- epoll 的裸内存数组与 wakeup pipe

但当前正文更像“阻塞 Socket 一章 + NIO/epoll 一章”的并列清单。真正该打穿的读者困惑更集中：

**同样是一条 TCP 连接，为什么 `new Socket()` 和 `SocketChannel + Selector` 在 native 侧会走出两条几乎相反的路线？前者为什么自己在用户态用 poll 模拟超时，后者为什么把 `EINPROGRESS` 留给 selector，再靠 epoll 驱动？JDK 到底是在同一套内核原语上叠出了两种 API 语义，还是根本走了两套独立世界？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**Java 的 TCP 世界不是“一套内核 socket API 的薄封装”，而是 JDK 在同一组 Linux 原语之上主动搭出的两种语义层：传统 `Socket` 走阻塞流语义，所以 connect/accept 的等待和超时由自己在 native 里用 `poll(2)` 补出来；NIO `SocketChannel` 则把 socket 长期保持在非阻塞模式，把“现在做不到”翻译成 `IOS_UNAVAILABLE/IOS_INTERRUPTED` 交给 Selector，再由 epoll 统一等待就绪。**

## 3. 总图

```text
阻塞式 Socket
  PlainSocketImpl / SocketInputStream
    ├─ socket/connect/accept 仍像同步调用
    ├─ 超时由 native 自己 poll/NET_Timeout 模拟
    └─ 成功后返回已就绪结果给 Java 线程

NIO
  Net.c / SocketChannel
    ├─ connect 非阻塞返回 1 / IOS_UNAVAILABLE / IOS_INTERRUPTED
    └─ Java 层把“未完成”交给 Selector

Selector on Linux
  EPoll.c + EPoll.java + EPollSelectorImpl
    ├─ epoll fd
    ├─ unsafe poll array
    ├─ wakeup pipe
    └─ ADD/MOD/DEL 驱动兴趣集
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么同一条 TCP 在 Java 里会变成两套 native 路径

目标约 1200 字。

- 从 `Socket.connect()` 和 `SocketChannel.connect()` 对比切入
- 点出 strace 上一条直接完成、一条 `EINPROGRESS + epoll`
- 埋主线：JDK 在相同内核原语上搭出两种不同的语义层

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. 阻塞 Socket 与 NIO 只是同一套 native 封装的薄薄语法糖差异
2. 带超时 connect 是内核直接提供的能力，JDK 只负责透传

结论：
- 两条路径真正分界在“谁负责等待、谁持有非阻塞状态”
- 超时与 ready-notification 有大量用户态协议工作

### 第三节：PlainSocketImpl——为什么阻塞 Socket 要在 native 里自己补等待语义

目标约 2300 字。

- `socketCreate`：server socket 自动 nonblocking + SO_REUSEADDR
- `socketConnect`：timeout<=0 直接 `NET_Connect`，timeout>0 走 `poll`
- `socketAccept`：`NET_Timeout` + `NET_Accept`
- `socketClose0`：deferred close / marker fd
- 强调：阻塞 API 的“同步语义”是 JDK native 自己组织出来的

### 第四节：读写路径——为什么传统 Socket 的正文 I/O 不在 PlainSocketImpl 里

目标约 1600 字。

- `SocketInputStream.socketRead0`
- 堆/栈缓冲切换
- `NET_ReadWithTimeout` vs `NET_Read`
- 说明 control path 与 data path 分离

### 第五节：NIO 通道层——为什么 connect 会被翻译成三态返回

目标约 2100 字。

- `Net.socket0/bind0/listen/connect0`
- `IOS_UNAVAILABLE` / `IOS_INTERRUPTED` / success
- `handleSocketError`
- 强调 NIO 不自己等待，而是把“尚未就绪”保留给上层 selector 协议

### 第六节：epoll 底座——为什么 Java 侧要直接操作 `struct epoll_event` 裸内存

目标约 2200 字。

- `EPoll.c` 的 `eventSize/eventsOffset/dataOffset/create/ctl/wait`
- `EPoll.java` 的 `unsafe.allocateMemory`
- `EPollSelectorImpl` 的 `epfd`、`pollArrayAddress`、wakeup pipe
- 说明零拷贝不是炫技，而是为了减少 selector 事件搬运层

### 第七节：Selector 语义——为什么 JDK 11 是 level-triggered，不是 EPOLLET 世界

目标约 1800 字。

- `EPoll.java` 没有 `EPOLLET`
- `processUpdateQueue` 的 ADD/MOD/DEL
- wakeup pipe 的注册
- `EPOLLONESHOT` 只在异步通道 `EPollPort` 用
- 收回主线：Selector 关心的是“兴趣集和就绪集协议”，不是裸 epoll 能力炫技

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. 阻塞 connect 带超时是否是内核原生特性
2. `Socket` 是否也会走 epoll
3. NIO connect 返回 `IOS_UNAVAILABLE` 是否等于失败
4. EPoll.java 是否直接把 DirectByteBuffer 传给 epoll_wait
5. JDK 11 Selector 是否默认边缘触发

## 5. 失败方案必须写进正文

1. 把阻塞 Socket 和 NIO 理解成同一套 native 薄封装
2. 把超时 connect 理解成内核直接给的同步语义
3. 把 epoll 事件机制误解成“JDK 自动就用最炫的 EPOLLET”

## 6. 证据清单

- `src/java.base/unix/native/libnet/PlainSocketImpl.c:159`：`socketCreate`
- `src/java.base/unix/native/libnet/PlainSocketImpl.c:227`：`socketConnect`
- `src/java.base/unix/native/libnet/PlainSocketImpl.c:312`：timeout connect 注释
- `src/java.base/unix/native/libnet/PlainSocketImpl.c:587`：`socketAccept`
- `src/java.base/unix/native/libnet/PlainSocketImpl.c:769`：`socketClose0`
- `src/java.base/unix/native/libnet/SocketInputStream.c:91`：`socketRead0`
- `src/java.base/unix/native/libnet/net_util_md.h:80`：`NET_Timeout/NET_Read/NET_Connect/NET_Accept/NET_Poll`
- `src/java.base/unix/native/libnio/ch/Net.c:194`：`socket0`
- `src/java.base/unix/native/libnio/ch/Net.c:306`：`connect0`
- `src/java.base/linux/native/libnio/ch/EPoll.c:41`：布局三函数
- `src/java.base/linux/native/libnio/ch/EPoll.c:58`：`EPoll_create`
- `src/java.base/linux/native/libnio/ch/EPoll.c:68`：`EPoll_ctl`
- `src/java.base/linux/native/libnio/ch/EPoll.c:82`：`EPoll_wait`
- `src/java.base/linux/classes/sun/nio/ch/EPoll.java:53`：`SIZEOF_EPOLLEVENT` 等
- `src/java.base/linux/classes/sun/nio/ch/EPoll.java:72`：`allocatePollArray`
- `src/java.base/linux/classes/sun/nio/ch/EPollSelectorImpl.java:76`：构造与 wakeup pipe
- `src/java.base/linux/classes/sun/nio/ch/EPollSelectorImpl.java:102`：`doSelect`
- `src/java.base/linux/classes/sun/nio/ch/EPollSelectorImpl.java:143`：`processUpdateQueue`
- `src/java.base/linux/classes/sun/nio/ch/EPollPort.java:176`：`EPOLLONESHOT` 用法

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / Linux / x86_64 / libnet + libnio`
- 本篇聚焦 TCP 与 epoll；UDP、DNS、NetworkInterface 放下一篇
- 不把 Windows 的 IOCP / select 路径混进来
- Selector 行为以 JDK 11 当前实现为准，不外推到所有 JDK/NIO 提供者
- strace 现象只能作实证，不替代源码主线

## 8. 完成后 review

- 删除代码后，能否复述“JDK 在同一组 socket 原语上叠出了阻塞语义与 selector 语义两条路”
- 是否清楚区分 control path（connect/accept/close）与 data path（read/write）
- 是否讲清传统 Socket 的超时等待是 JDK native 自己补的
- 是否明确 JDK 11 Selector 的 level-triggered 边界
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
