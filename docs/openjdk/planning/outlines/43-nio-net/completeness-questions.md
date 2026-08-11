# 域 43 NIO & Net — 全视角提问验证

> 🟡 大域 | 5 身份 | 8 问

## 1. Java 开发者 (2问)

1. `Socket.connect(addr, 5000)` 怎么实现带超时连接？底层 native socketConnect 怎么用 O_NONBLOCK+PollArrayWrapper 等 EPOLLOUT？
2. `Selector.select()` — epoll_wait 超时参数是 -1/0/>0——三种模式对应 Java 层的什么行为？边缘触发 vs Level-Triggered 用哪个？

## 2. SRE/运维 (2问)

3. `NetworkInterface.getHardwareAddress()` — MAC 地址是怎么读到的？为什么 loopback(lo) 返回 `00:00:00:00:00:00` 而不是真实 MAC？
4. `InetAddress.getLocalHost()` — 在容器中返回什么？/etc/hostname 没有正确配置会怎样？

## 3. 框架/库开发者 (2问)

5. PlainSocketImpl 和 NIO SocketChannel 两个 native 实现共享 net_util_md.c 的工具层——我能只用 Net.c 的 finishConnect 非阻塞实现同步 Socket 吗？
6. inotify 监视目录时只监视顶层——子目录需要递归 walk——Java 的 WatchService 怎么做到递归监视？

## 4. 安全研究者 (1问)

7. `DatagramSocket.receive()` 的 recvfrom 返回 sender 地址——如果有攻击者发 UDP 包到我的绑定端口——receive() 会返回 sender IP 吗？怎么区分合法 vs 恶意包？

## 5. 性能工程师 (1问)

8. epoll_wait 的 events 数组是 DirectByteBuffer——零拷贝从 kernel→Java。但每次 epoll_ctl(ADD/DEL) 需要 JNI 调用——10000 个 SocketChannel 注册时 JNI overhead 有多少？
