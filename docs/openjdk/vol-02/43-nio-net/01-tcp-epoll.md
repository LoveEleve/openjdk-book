# 01. 为什么同一条 TCP 在 Java 里会走两条 native 路？— `Socket`、`SocketChannel` 与 `epoll`

> **版本边界**：本文基于 `OpenJDK 11u / Linux / x86_64 / libnet + libnio`。这里讨论的是 TCP 在两条 Java API 路径下的 native 实现分层：传统阻塞式 `Socket` / `ServerSocket`，以及 NIO `SocketChannel` / `Selector` 的 Linux `epoll` 底座。Windows 的 IOCP 路径不在本文展开。
>
> **前置依赖**：[42-core-native/03 — 为什么这些看起来无关的 native 杂事会落在同一层？— ClassLoader、FileDescriptor 与 TimeZone](../42-core-native/03-class-io.md)
> → **后续**：[02 — UDP + DNS + NetworkInterface](02-udp-dns.md)

Java 网络 API 最容易制造的一种错觉，是把“阻塞 Socket”和“NIO Channel + Selector”想成同一组 socket 系统调用上套了两层不同 Java 包装。

这话只对了一半。

它们底下当然都还是 Linux 的 `socket/connect/accept/read/write` 那套原语，但 JDK native 层给这两条 API 路径叠出来的语义完全不一样：

- 传统 `Socket` 的承诺是“你在这里等，等到成功、失败或超时再回来”；
- NIO `SocketChannel` 的承诺则是“如果现在做不到，我先把‘未完成’交还给你，由 Selector 去等后续就绪”。

这就逼出本篇最该回答的问题：**同样是一条 TCP 连接，为什么 `new Socket()` 和 `SocketChannel + Selector` 在 native 侧会走出两条几乎相反的路线？前者为什么自己在用户态用 `poll(2)` 模拟超时，后者为什么把 `EINPROGRESS` 留给 selector，再靠 `epoll` 驱动？JDK 到底是在同一套内核原语上叠出了两种 API 语义，还是根本走了两套独立世界？**

先把答案压成一句话：**Java 的 TCP 世界不是“一套内核 socket API 的薄封装”，而是 JDK 在同一组 Linux 原语之上主动搭出的两种语义层：传统 `Socket` 走阻塞流语义，所以 connect/accept 的等待和超时由自己在 native 里用 `poll(2)` 补出来；NIO `SocketChannel` 则把 socket 长期保持在非阻塞模式，把“现在做不到”翻译成 `IOS_UNAVAILABLE/IOS_INTERRUPTED` 交给 Selector，再由 `epoll` 统一等待就绪。**

## 先试两个最自然的理解，看看为什么都不对

### 朴素方案一：阻塞 Socket 和 NIO 只是同一套 native 薄封装的语法糖差异

这是最常见的第一反应。

毕竟两边最后都要调同样的系统调用：`socket`、`connect`、`accept`、`read`、`write`。既然底层原语一样，那上层差异大概只是“一个阻塞、一个不阻塞”的 Java 封装风格问题。

这个理解的问题在于，它低估了“谁负责等待、谁负责把未完成状态翻译给上层”这件事的重要性。

同样是 `connect`：

- 对传统 `Socket` 来说，Java 调用方想要的是“别让我拿到一个半成品，等事情有结论再回来”；
- 对 NIO `SocketChannel` 来说，Java 调用方想要的是“如果现在还没连上，就把‘未完成’告诉我，我自己决定是否注册到 Selector 上继续等”。

这两种语义对 native 层的要求完全不同：

- 前者要求 native 自己补出等待与超时；
- 后者要求 native 保留非阻塞状态，把“未完成”作为一等返回值交出去。

所以两条路径虽然站在同一组内核原语上，但 JDK 在其上叠加的协议完全不同。不是简单“一个包个 try/catch，一个再包个 Selector”这么浅的差别。

### 朴素方案二：带超时的阻塞 connect 本来就是内核直接提供的

第二个很自然的想法是：阻塞 Socket 的 `connect(timeout)` 之所以能“等到超时”，大概就是内核 socket 本来就有一套直接的同步超时 connect 机制，JDK 只不过顺手透传出来了。

这个理解在 Linux 上并不成立。

OpenJDK 的 Unix `PlainSocketImpl.socketConnect()` 在 timeout > 0 时，根本不是调一个“带超时的 connect 系统调用”，而是：

- 先把 fd 设成 non-blocking；
- 自己调一次 `connect`；
- 如果得到 `EINPROGRESS`，再用 `poll(2)` 等待 `POLLOUT`；
- 期间如果被 `EINTR` 打断，还要自己用 `JVM_NanoTime` 重算剩余超时；
- 最后再 `getsockopt(SO_ERROR)` 确认连接到底成功还是失败。`src/java.base/unix/native/libnet/PlainSocketImpl.c:227`

也就是说，**带超时的阻塞 connect 不是内核直接给 Java 的现成语义，而是 JDK 在 native 层自己模拟出来的。**

这件事特别重要，因为它说明阻塞 API 在 Java 世界里的“同步感”，并不是内核天然提供，而是 JDK 主动组织出来的结果。

这两个失败方案合起来，正好引出全篇主线：**JDK 并不是在同一套 socket 原语上做两层薄包装，而是在同一组原语之上叠出了“阻塞流语义”和“selector 就绪语义”两条不同的 native 协议。**

## `PlainSocketImpl`：为什么阻塞 Socket 要在 native 里自己补等待语义

先看传统阻塞路径。

`java.net.Socket` / `ServerSocket` 的关键 native 实现集中在 `PlainSocketImpl.c` 里。它最重要的特点不是“会调 socket 系统调用”，而是：**它不断在 native 层主动补 Java 阻塞 API 期望的同步语义。**

### `socketCreate`：服务端从一开始就不是“纯阻塞 fd”

先从最容易被忽视的一点开始。

`socketCreate()` 在创建服务端 socket 时，如果 `psi_serverSocketID` 不为空，会自动：

- 打开 `SO_REUSEADDR`；
- 并把这个监听 fd 设成 non-blocking。`src/java.base/unix/native/libnet/PlainSocketImpl.c:159`

这已经很说明问题：哪怕 Java 世界后来把它当阻塞式 `ServerSocket` 来用，native 层也未必真的把底层 fd 始终维持在“完全阻塞”的朴素形态。相反，JDK 会根据后续等待协议的需要，自己组织出一层更适合实现超时和中断语义的底座。

### `socketConnect`：timeout <= 0 和 timeout > 0 其实是两条实现路径

`socketConnect()` 真正的第一处分叉，就是 timeout。

- `timeout <= 0`：直接 `NET_Connect(fd, ...)`；
- `timeout > 0`：完全换成另一条用户态协议。`src/java.base/unix/native/libnet/PlainSocketImpl.c:227`

源码注释写得非常直白：指定了 timeout 时，JDK 会把 socket 放进 non-blocking 模式，先调一次 `connect`，然后等待它建立、失败或者超时。`src/java.base/unix/native/libnet/PlainSocketImpl.c:312`

注意这里等的是 `pollfd{fd, POLLOUT}`，也就是 `poll(2)` 的 `POLLOUT`，不是 NIO 侧 selector 的 `EPOLLOUT`。这一步特别值得停一下，因为它把阻塞 Socket 和 NIO 的边界一下子拉清楚了：**传统 Socket 的超时 connect 虽然也借助“就绪等待”原语，但等待动作仍然发生在它自己的 native 函数里，而不是外包给 Selector。**

### timeout 语义是 native 自己维持的，不是内核替你记着的

这条路径里最有设计味道的地方，是 `EINTR` 处理。

`poll` 被中断后，JDK 不会简单重试，而是会：

- 调 `JVM_NanoTime` 取当前时间；
- 扣掉已经过去的那部分；
- 只拿剩余 timeout 继续等。`src/java.base/unix/native/libnet/PlainSocketImpl.c:341`

这说明 timeout 并不是“我把 5 秒丢给内核，让它替我记着”，而是 **JDK native 自己维护的一份剩余预算**。

这就是我说它在补阻塞语义的原因：Java API 暴露的是“等待最多 N 毫秒”，而 Linux 给你的只是 `EINPROGRESS + poll + SO_ERROR` 这堆原语，预算管理全得自己做。

### `socketAccept`：同样是阻塞 API，底层也不是傻等

`socketAccept()` 的逻辑与 connect 很像：

- 先通过 `NET_Timeout` 做可读性等待；
- 再调用 `NET_Accept`；
- 对 `ECONNABORTED`、`EWOULDBLOCK`、`EAGAIN` 这些竞态错误继续循环；
- 如果 timeout 存在，还要边循环边重算剩余时间。`src/java.base/unix/native/libnet/PlainSocketImpl.c:587`

这再次说明，传统阻塞 API 的“阻塞感”并不是“系统调用天然帮你包好了所有等待细节”，而是 JDK native 一直在现场维持这份同步错觉。

### `socketClose0`：为什么 JDK 11 的 close 重点是 deferred close

关闭也不是一句 `close(fd)`。

`socketClose0()` 在 `useDeferredClose` 为真、而且 `marker_fd` 可用时，会先 `NET_Dup2(marker_fd, fd)`；否则才把 Java 侧 fd 设成 `-1` 并真正 `NET_SocketClose(fd)`。`src/java.base/unix/native/libnet/PlainSocketImpl.c:769`

这一步很能说明 JDK 的思路：**关闭不是只追求“尽快把 fd 关掉”，还要考虑别的线程是否可能正阻塞在这个 fd 上。** deferred close 正是为此补的一层协议。

所以本节最该记住的一句话是：**阻塞 Socket 的同步语义，不是内核直接给的，而是 JDK 在 native 层一层层补出来的。**

## 数据路径：为什么传统 Socket 的正文 I/O 不在 `PlainSocketImpl` 里

讲完 connect/accept/close 这些 control path，再看真正读写正文的 data path。

这一步特别容易被误会成“还在 `PlainSocketImpl.c` 里继续写 read/write 就完了”。实际不是。

### `SocketInputStream.socketRead0`：JNI 数组搬运和系统调用是两层

真正的读路径在 `SocketInputStream.c`。`socketRead0()` 会：

- 检查 `fdObj` 和 fd 是否关闭；
- 视长度决定用栈上缓冲还是堆缓冲；
- 有 timeout 时走 `NET_ReadWithTimeout`，否则走 `NET_Read`；
- 最后再把读到的数据拷回 Java `byte[]`。`src/java.base/unix/native/libnet/SocketInputStream.c:91`

这很能说明一件事：JDK 把“连接管理”和“正文 I/O”故意分成了两层 native 路径。

- `PlainSocketImpl` 更偏控制协议：connect、bind、listen、accept、close、选项；
- `SocketInputStream` / `SocketOutputStream` 更偏数据搬运：缓冲、超时读写、异常翻译。

### `NET_*` 工具层才是两边共享的底板

无论阻塞式 Socket 还是后面的 NIO，真正共享的底板其实是 `net_util_md.h` 里的那一组 `NET_*` 工具：

- `NET_Timeout`
- `NET_Read`
- `NET_Connect`
- `NET_Accept`
- `NET_SocketClose`
- `NET_Poll`。`src/java.base/unix/native/libnet/net_util_md.h:80`

所以不是说阻塞路径和 NIO 完全两套世界，而是：**它们共享底层工具，但在“谁来等待、谁来翻译未完成状态”这件事上走了两条协议路线。**

## NIO 通道层：为什么 connect 会被翻译成三态返回

接下来就能看 NIO 那条路了。

这里最该带着的问题不是“它也调 connect 吗”，而是：**既然它调的是同样的 connect，为什么它不在 native 里自己等完？**

### `Net.connect0`：把“未完成”变成一等返回值

`Net.connect0()` 的逻辑非常紧凑：

- `connect()` 成功，返回 `1`；
- `errno == EINPROGRESS`，返回 `IOS_UNAVAILABLE`；
- `errno == EINTR`，返回 `IOS_INTERRUPTED`；
- 其它错误才走 `handleSocketError`。`src/java.base/unix/native/libnio/ch/Net.c:306`

这和上一节的 `socketConnect()` 形成了鲜明对比：PlainSocketImpl 看到 `EINPROGRESS` 会自己进入等待循环，而 `Net.connect0()` 看到 `EINPROGRESS` 时，**把“现在还没连上”当成一个有语义的正常返回值交给上层。**

这就是 NIO 路径最根本的区别：它不在 native 里把连接补成“有结果再返回”的同步操作，而是把“未完成”这件事显式保留下来。

### 谁在负责等待，这才是 NIO 与传统 Socket 的分界线

所以 NIO 通道和传统 Socket 的真正分界，不是“一个是 `java.net`，一个是 `java.nio`”，而是：

- 阻塞式 `Socket`：native 自己等待，把同步语义补给 Java 调用者；
- `SocketChannel`：native 不等待，把未完成状态交出去，让 Selector 再决定后面怎么等。

同样的 socket、同样的 Linux 原语，因为 JDK 选择了不同的等待责任分配方式，最后长出了两条完全不同的上层 API 语义。

这就是本篇最重要的结构性结论之一。

## `epoll` 底座：为什么 Java 侧要直接操作 `struct epoll_event` 裸内存

既然 NIO 把“未完成”和“等待就绪”外包给了 Selector，那下一层最关键的问题就是：Selector 在 Linux 上到底靠什么等。

答案是 `epoll`，但 JDK 的用法并不是很多人想象的那种“JNI 层包一大坨 Java 对象进进出出”。它反而非常薄。

### `EPoll.c`：native 侧只暴露最薄的布局和系统调用壳

Linux 专属的 `EPoll.c` 只有不到 100 行，核心就三类东西：

- 布局查询：`eventSize()`、`eventsOffset()`、`dataOffset()`；
- 系统调用壳：`EPoll_create`、`EPoll_ctl`、`EPoll_wait`。`src/java.base/linux/native/libnio/ch/EPoll.c:41`

这说明 JDK 在这里没有想把 epoll 整套语义都藏在 JNI 后面，而是刻意暴露了一层“**让 Java 代码能自己理解并操作 `struct epoll_event` 布局**”的最薄接口。

### `EPoll.java`：直接 `unsafe.allocateMemory`，不是 DirectByteBuffer

`EPoll.java` 侧会先拿到：

- `SIZEOF_EPOLLEVENT`
- `OFFSETOF_EVENTS`
- `OFFSETOF_FD`。`src/java.base/linux/classes/sun/nio/ch/EPoll.java:50`

然后直接：

```java
unsafe.allocateMemory(count * SIZEOF_EPOLLEVENT)
```

去分配一块裸内存数组作为 poll array。`src/java.base/linux/classes/sun/nio/ch/EPoll.java:72`

这非常值得讲清楚，因为它说明 JDK 这里不是“构造一堆 DirectByteBuffer 再让 native 去填”，而是 Java 侧主动以 C 结构体布局思维来组织一块原始内存，然后把地址直接传给 `epoll_wait`。

换句话说，**epoll 这条链路里，Java 代码自己就在按 native 结构体布局思考。**

### 为什么这不是炫技，而是减少一层事件搬运

如果不这么做，JDK 完全可以：

- native 里申请事件数组；
- 把事件结果再逐个 JNI 回填到 Java 对象或缓冲区。

但那样就会多出一整层“从内核事件数组搬到 JVM 世界事件容器”的转换成本。

JDK 现在的做法是：**让 `epoll_wait` 直接往 Java 预分配好的裸内存里写**，后续 Java 再按偏移直接读 `fd` 和 `events`。这才是它的真正价值。

## Selector 语义：为什么 JDK 11 走的是 level-triggered，不是 EPOLLET 世界

讲到 epoll，另一个特别容易被先入为主的点是：既然是 epoll，那 JDK 当然会用最“高级”的边缘触发 EPOLLET。

OpenJDK 11 的默认 Selector 路径并不是这样。

### `EPoll.java` 没有 `EPOLLET`，却有 `EPOLLONESHOT`

`EPoll.java` 里定义了：

- `EPOLLIN`
- `EPOLLOUT`
- `EPOLLONESHOT`

但没有 `EPOLLET` 常量。`src/java.base/linux/classes/sun/nio/ch/EPoll.java:57`

这已经很能说明 JDK 11 Selector 的基本选择：**它不是以边缘触发为默认控制面来组织兴趣集和就绪集协议。**

### `EPollSelectorImpl`：真正关心的是兴趣集增量更新

`EPollSelectorImpl` 构造时会：

- 创建 `epfd`；
- 分配 poll array 裸内存；
- 建一对 wakeup pipe；
- 把 pipe 的读端注册成 `EPOLLIN`。`src/java.base/linux/classes/sun/nio/ch/EPollSelectorImpl.java:76`

随后 `doSelect()` 只是：

- 处理 interest set 更新队列；
- 调 `EPoll.wait(...)`；
- 再消费事件。`src/java.base/linux/classes/sun/nio/ch/EPollSelectorImpl.java:102`

而真正让 Selector 语义成立的是 `processUpdateQueue()`：

- 新兴趣集从 0 变非 0 就 `EPOLL_CTL_ADD`；
- 变动就 `EPOLL_CTL_MOD`；
- 归零就 `EPOLL_CTL_DEL`。`src/java.base/linux/classes/sun/nio/ch/EPollSelectorImpl.java:143`

这说明 JDK 11 Selector 在这里真正关心的不是“选没选最炫的 epoll 模式”，而是“**兴趣集变化怎样增量映射成 epoll ctl 操作**”。

### `EPOLLONESHOT` 只在异步通道那条线有戏份

还有一点很容易混淆：虽然 `EPoll.java` 定义了 `EPOLLONESHOT`，但它并不是 `EPollSelectorImpl` 这条 Selector 主路径的核心常量。

真正把 `EPOLLONESHOT` 用起来的是 `EPollPort.startPoll()`，也就是异步通道那条线，会把 `events | EPOLLONESHOT` 注册进去。`src/java.base/linux/classes/sun/nio/ch/EPollPort.java:176`

这再次说明 NIO/Net 内部也不是一锅粥：Selector 和异步通道虽然共享 epoll 底座，但上面叠的调度语义并不相同。

所以本节最该记住的一句话是：**JDK 11 的 epoll 使用重点在“兴趣集/就绪集协议”和“事件搬运成本”，不是追求边缘触发标签本身。**

## 到这里为止，主线其实只发生了四件事

如果前面细节很多，这里先把整件事压回四步：

1. 传统 `Socket` 把超时与等待责任留在 native 自己手里，用 `poll(2)` 和超时预算补出同步语义；
2. `SocketChannel` 则把“未完成”翻译成状态值交给 Selector，不自己等待到底；
3. Linux 上 Selector 再用 `epoll` 统一等待这些就绪事件；
4. `EPoll.java` / `EPollSelectorImpl` 把 epoll 事件数组直接放进 Java 可操作的裸内存里，尽量省掉事件搬运层。

只要这四步还在脑子里，同一条 TCP 的两条 native 路就不会再显得是“重复实现”。

## 常见误解澄清

### 误解一：阻塞 connect 带超时是内核原生直接给 Java 的能力

不是。

Unix `PlainSocketImpl` 在 timeout > 0 时会主动切成 non-blocking，再自己用 `poll(2)`、纳秒时钟和 `SO_ERROR` 补完整个超时等待语义。`src/java.base/unix/native/libnet/PlainSocketImpl.c:312`

### 误解二：传统 `Socket` 也会走 epoll

不对。

传统阻塞路径这里用的是 `poll(2)` / `NET_Timeout`，不是 `epoll_wait` 这条 Selector 底座。两条路共享的是 socket 原语，不共享等待协议。

### 误解三：NIO connect 返回 `IOS_UNAVAILABLE` 就等于失败

不是。

它表达的是“连接尚未完成、请交给后续等待机制继续处理”，不是“连接建立失败”。真正失败会走 `handleSocketError`。`src/java.base/unix/native/libnio/ch/Net.c:306`

### 误解四：`EPoll.java` 是把 DirectByteBuffer 传给 `epoll_wait`

也不是。

它直接用 `unsafe.allocateMemory` 分配裸内存，再把地址作为 `jlong` 传给 native。`src/java.base/linux/classes/sun/nio/ch/EPoll.java:72`

### 误解五：JDK 11 Selector 默认就是 EPOLLET 边缘触发

不对。

当前实现里 `EPoll.java` 并没有 `EPOLLET` 常量；Selector 主路径关注的是 ADD/MOD/DEL 与 level-triggered 的就绪消费，而 `EPOLLONESHOT` 主要出现在异步通道 `EPollPort` 路径。`src/java.base/linux/classes/sun/nio/ch/EPoll.java:57`、`src/java.base/linux/classes/sun/nio/ch/EPollPort.java:176`

## 收网：同一组 socket 原语，在 JDK 里被叠成了两种完全不同的等待协议

现在再回头看最开头那个问题，答案已经能收成一张总图了。

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

把它再压成三句话：

- JDK 没有把 Linux socket 原语一股脑直出给 Java，而是在其上叠出了“阻塞等待语义”和“就绪通知语义”两条不同协议。
- 传统 `Socket` 把等待和超时责任留在 native 自己手里，NIO 则把“未完成”状态上抛给 Selector。
- epoll 在这里不是“更底层的 connect”，而是 Selector 路径里承接未完成和就绪事件的统一等待底座。

所以这一篇真正该记住的，不是 `poll` 和 `epoll` 哪个名字更熟。

真正该记住的是：**同一条 TCP 连接在 Java 世界里为什么会长成两种完全不同的调用体验，根本原因不在内核，而在 JDK native 层怎样分配“谁负责等待、谁负责翻译未完成状态”这份协议责任。**

下一篇就顺着这条边界继续往外扩。TCP 讲完后，网络域里剩下的正好是另一批同样会跨出内核边界、但语义完全不同的输入：无连接的 UDP、名字解析的 DNS、以及网卡枚举。

> → [02 — UDP + DNS + NetworkInterface](02-udp-dns.md)
