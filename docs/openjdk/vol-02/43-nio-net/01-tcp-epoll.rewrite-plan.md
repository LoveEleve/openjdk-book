# 43-nio-net/01-tcp-epoll 重写规划

> 基于 `OpenJDK 11u / Linux / x86_64 / libnet + libnio`
> 目标：解释为什么同一条 TCP 在 Java 世界会走出两条几乎相反的 native 路——传统阻塞 `Socket` 自己在 native 里补等待/超时语义，NIO `SocketChannel`/`Selector` 则把未完成状态上抛给 selector，并由 `epoll` 统一等待

## 1. 选题判断

现稿事实基础已经很强：
- `PlainSocketImpl.socketCreate/socketConnect/socketAccept/socketClose0`
- `SocketInputStream.socketRead0`
- `Net.connect0`
- `EPoll.c` / `EPoll.java` / `EPollSelectorImpl` / `EPollPort`

但当前正文仍偏“阻塞路径一节 + NIO 一节 + epoll 一节”的机制并列。真正该打穿的读者困惑更集中：

**同样是一条 TCP 连接，为什么 `new Socket()` 和 `SocketChannel + Selector` 在 native 侧会走出两条几乎相反的路线？传统 `Socket` 为什么自己在用户态用 `poll(2)` 模拟超时，NIO 为什么把 `EINPROGRESS` 留给 selector，再靠 `epoll` 统一驱动？JDK 到底是在同一套内核原语上叠出了两种语义，还是根本走了两套独立世界？**

## 2. 一句话顿悟

**Java 的 TCP 世界不是“一套 socket 系统调用的薄封装”，而是 JDK 在同一组 Linux 原语之上主动搭出的两种语义层：传统 `Socket` 走阻塞流语义，所以 connect/accept 的等待和超时由自己在 native 里用 `poll(2)`/`NET_Timeout` 补出来；NIO `SocketChannel` 则把 socket 长期保持在非阻塞模式，把“现在做不到”翻译成 `IOS_UNAVAILABLE/IOS_INTERRUPTED` 上抛给 Selector，再由 `epoll` 统一等待就绪。**

## 3. 总图

```text
阻塞式 Socket
  PlainSocketImpl / SocketInputStream
    ├─ connect(timeout<=0) 直接 NET_Connect
    ├─ connect(timeout>0)  nonblock connect + poll(POLLOUT) + SO_ERROR + JVM_NanoTime
    ├─ accept              NET_Timeout + NET_Accept + 竞态重试
    └─ read/write          SocketInputStream/OutputStream + NET_Read/Write

NIO
  Net.c / SocketChannel
    ├─ connect0 成功 -> 1
    ├─ EINPROGRESS -> IOS_UNAVAILABLE
    ├─ EINTR -> IOS_INTERRUPTED
    └─ 其余错误 -> handleSocketError

Selector on Linux
  EPoll.c + EPoll.java + EPollSelectorImpl
    ├─ epfd
    ├─ unsafe poll array (struct epoll_event 裸内存)
    ├─ wakeup pipe
    └─ ADD / MOD / DEL 驱动兴趣集
```

## 4. 结构大纲

### 第一节：开场困惑——同一条 TCP 为什么有两条 native 路

目标约 1200 字。

- 从 `Socket` vs `SocketChannel + Selector` 切入
- 点出：不是“一个阻塞、一个非阻塞”这么浅的差别，而是“谁负责等待、谁负责把未完成状态翻译给上层”的协议责任分配完全不同
- 埋主线：阻塞流语义 vs selector 就绪语义

### 第二节：两个朴素方案为什么都不对

目标约 1500 字。

必须推演：
1. 阻塞 Socket 和 NIO 只是同一套 native 薄封装的语法糖差异
2. 带超时的阻塞 connect 是内核直接提供给 Java 的能力

结论：
- 底层原语相同，但等待责任完全不同
- 带超时的阻塞 connect 是 JDK native 自己模拟出来的

### 第三节：`PlainSocketImpl`——阻塞 Socket 为什么自己补等待语义

目标约 2600 字。

- `socketCreate` 服务端自动 `SO_REUSEADDR` + non-blocking
- `socketConnect` timeout<=0 vs >0 两条实现路径
- timeout > 0: non-blocking connect + poll(POLLOUT) + EINTR 重算剩余超时 + SO_ERROR
- `socketAccept` 也是 `NET_Timeout` + `NET_Accept` + 竞态重试
- `socketClose0` 的 deferred close
- 总结：阻塞 API 的“同步感”是 native 自己补出来的

### 第四节：数据路径——为什么正文 I/O 不在 `PlainSocketImpl`

目标约 1400 字。

- `SocketInputStream.socketRead0`
- stack buffer / heap buffer
- timeout 走 `NET_ReadWithTimeout`
- `NET_*` 工具层才是共享底板

### 第五节：NIO 通道层——为什么 connect 被翻译成三态返回

目标约 1800 字。

- `Net.connect0` 成功=1 / EINPROGRESS=IOS_UNAVAILABLE / EINTR=IOS_INTERRUPTED
- “未完成”是一等返回值，不在 native 自己等完
- 关键边界：谁负责等待

### 第六节：`epoll` 底座——Java 为什么直接操作 `struct epoll_event` 裸内存

目标约 2000 字。

- `EPoll.c` 暴露 eventSize/eventsOffset/dataOffset + create/ctl/wait
- `EPoll.java` 直接 `unsafe.allocateMemory`
- 减掉一层事件搬运

### 第七节：Selector 语义——JDK 11 关心的是兴趣集增量更新

目标约 1800 字。

- `EPoll.java` 无 `EPOLLET`，有 `EPOLLONESHOT`
- `EPollSelectorImpl` 构造 epfd/poll array/wakeup pipe
- `processUpdateQueue()` 做 ADD/MOD/DEL
- `EPollPort` 才用 `EPOLLONESHOT`

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. 带超时阻塞 connect 是否内核直接提供
2. 阻塞 Socket 是否也走 epoll
3. `IOS_UNAVAILABLE` 是否等于失败
4. `EPoll.java` 是否用 DirectByteBuffer
5. JDK 11 Selector 是否默认 EPOLLET

## 5. 失败方案必须写进正文

1. 阻塞 Socket 和 NIO 只是同一套 native 薄封装的语法糖差异
2. 带超时的阻塞 connect 是内核直接提供给 Java 的能力

## 6. 证据清单

- `src/java.base/unix/native/libnet/PlainSocketImpl.c:159-216`
- `src/java.base/unix/native/libnet/PlainSocketImpl.c:227-359`
- `src/java.base/unix/native/libnet/PlainSocketImpl.c:587-700`
- `src/java.base/unix/native/libnet/PlainSocketImpl.c:769-807`
- `src/java.base/unix/native/libnet/SocketInputStream.c:91-170`
- `src/java.base/unix/native/libnio/ch/Net.c:306-327`
- `src/java.base/linux/native/libnio/ch/EPoll.c:41-97`
- `src/java.base/linux/classes/sun/nio/ch/EPoll.java:53-104`
- `src/java.base/linux/classes/sun/nio/ch/EPollSelectorImpl.java:76-175`
- `src/java.base/linux/classes/sun/nio/ch/EPollPort.java:176-183`
- `src/java.base/unix/native/libnet/net_util_md.h:80`

## 7. 完成后 review

- 删除代码后，能否复述“同一组原语上叠出的两种等待协议”
- 是否讲清阻塞 connect 的 timeout 是 native 自己模拟出来的
- 是否讲清 NIO 为何把未完成状态上抛给 Selector
- 是否讲清 epoll 底座的裸内存布局与兴趣集更新
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验