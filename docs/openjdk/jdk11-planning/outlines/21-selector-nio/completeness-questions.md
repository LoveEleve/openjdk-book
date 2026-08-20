# 域 21: Selector 与网络 NIO — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "Selector 原理(三件套/三阶段)" — 01 篇 §1(Selector.java:418, SelectionKey.java:296-332, SelectableChannel.java:257)
- [x] "selectedKeys 为什么要 remove" — 01 篇 §3(344)
- [x] "wakeup 原理(自管道)" — 01 篇 §4(609, EPollSelectorImpl:93)
- [x] "epoll 三调用/为什么 O(1)" — 02 篇 §2(EPoll.java:112/114/116)
- [x] "epoll vs select/poll" — 02 篇 §2
- [x] "水平 vs 边缘触发" — 02 篇 §3
- [x] "linux Selector 是什么(平台分层)" — 02 篇 §1(DefaultSelectorProvider:45)
- [x] "BIO vs NIO vs AIO 线程模型" — 03 篇 §4
- [x] "非阻塞 connect/finishConnect" — 03 篇 §2(672)
- [x] "accept 流程" — 03 篇 §3(274/543)

## 身份 2: 生产工程师
- [x] 高并发连接服务(事件循环)— 01 篇 §3
- [x] BIO 线程爆炸问题 — 03 篇 §4
- [x] 优雅停机(wakeup)— 01 篇 §4

## 身份 3: 框架工程师
- [x] Netty 底层机制 — 01-02 篇
- [x] 事件循环模型 — 01 篇 §3

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 Selector.java:344/418/609, SelectionKey.java:168/296-332, SelectableChannel.java:257/295, SelectorImpl.java:111/133/136/140/279, EPollSelectorImpl.java:50/56/76/93/102/160-167, EPoll.java:106-116, EPollSelectorProvider.java:32/35, DefaultSelectorProvider.java:45, SocketChannelImpl.java:336/342/354-357/448/603/672/678-700, ServerSocketChannelImpl.java:274/533/543)/关键设计/跨层([内核]/[man]/[内部卷])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] JDK11 实测: EPoll 实现位于 **linux/classes/sun/nio/ch/**(平台目录),非 share——域发现 v2 已同步;无 EPollArrayWrapper(JDK11 用 AllocatedNativeObject pollAddress)

## 身份 5: 完整性缺口检查
- [x] 选择机制(01)/epoll(02)/SocketChannel(03)三篇覆盖域全部面试主战场
- [x] DatagramChannel 并入 03 篇提及(UDP,面试低频)
- [x] 异步通道族(🟢)并入 03 篇 §4 对比表
- [x] 未覆盖确认: SelectorProvider 自定义(SPI)、通道注册的键冲突细节——写作时按需
- [x] 二次 review 修正: EPoll.create() 调用精确行(79)、connect 阻塞循环精确(690-698)、补 processUpdateQueue(143)就绪处理
- [x] 验证通过: read 阻塞循环(336-363:342 blocking/345 beginRead/351 if blocking/354-357 do-while/363 normalize)、epoll 三调用(EPoll.java:112/114/116)、水平触发(无 EPOLLET)、PollSelectorImpl 回退
- [ ] 待办: 写作时验证 lockAndDoSelect 精确行号、EPollSelectorImpl 就绪事件读取(processUpdateQueue/pollAddress 区域)、Asynchronous* 实现细节
