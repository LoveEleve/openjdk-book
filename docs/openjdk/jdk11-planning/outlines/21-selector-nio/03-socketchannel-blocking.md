# 03. SocketChannel 与阻塞/非阻塞 — 模式切换、connect 三阶段、事件循环

> 🔴 Deep | 域 21 Selector 与网络 NIO 第 3 篇(收官)| Layer 4
> 读者处境: 面试"SocketChannel 和 BIO Socket 差异""非阻塞 connect 怎么等完成"——双模式与 Selector 的配合。

### 1. "阻塞 vs 非阻塞" — 双模式通道

场景: 同一个通道,两种读写语义?

- `AbstractSelectableChannel.configureBlocking(block)`(`:298`)——模式切换;**已注册 Selector 的通道不能切回阻塞**(`:306-307`,IllegalBlockingModeException)
- 本质: fd 的 O_NONBLOCK 标志(`IOUtil.configureBlocking` native)
- 阻塞: 没有数据/连接就挂起线程;非阻塞: 立即返回(0/EOF/null)
- 关键设计 (斜体): *"模式决定语义"——阻塞 = 线程挂起等数据;非阻塞 = 立即返回让出线程;Selector 只与非阻塞配合*
- 面试: "SocketChannel 和 BIO Socket 区别"——双模式 + 可注册 Selector(单线程管 N 连接的前提)

### 2. "非阻塞 connect" — 三阶段状态机

场景: connect 在非阻塞下怎么"等"完成?

- `SocketChannelImpl.java:95-97` — 状态常量: ST_UNCONNECTED(0)/ST_CONNECTIONPENDING(1)/ST_CONNECTED(2)
- `connect`(`SocketChannelImpl.java:672`)— `Net.connect` native(`:692`);非阻塞下立即返回(内核 EINPROGRESS),状态转 CONNECTIONPENDING
- `finishConnect`(`:757`)— 非阻塞单次 `checkConnect(fd, false)`(`:777`);阻塞 do-while(`:774-775`)
- 与 Selector 配合: 注册 OP_CONNECT → 就绪事件 → finishConnect → ST_CONNECTED
- 关键设计 (斜体): *"非阻塞 connect 分两段"——connect 发起、finishConnect 确认;OP_CONNECT 就绪表示"连接已完成待确认"*
- 面试: "非阻塞 connect 怎么等完成"——注册 OP_CONNECT,就绪后调 finishConnect

### 3. "accept 与读写" — 事件循环三件事

场景: 就绪事件怎么变成连接与数据?

- `accept`(`ServerSocketChannelImpl.java:274`)— 非阻塞无连接返回 null(`:292-293`);新连接初始阻塞模式(`:296`,IOUtil.configureBlocking(newfd, true))
- `read`(`SocketChannelImpl.java:336`)— 阻塞对 INTERRUPTED 重试(`:351-354`),非阻塞一次(`:355-356`)
- 完整事件循环: OP_ACCEPT → accept → 新通道 configureBlocking(false) + 注册 OP_READ → 就绪读
- 关键设计 (斜体): *"事件循环三件事"——accept/read/write 都由 readyOps 驱动;NIO = 单线程 + 事件驱动 vs BIO = 每连接一线程阻塞等待*
- 面试: "BIO 和 NIO 线程模型差异"——线程数、阻塞点、事件驱动

---

### 核心悬念

NIO 收官——**JMX 管理框架**来了: `MBeanServer` 怎么注册/查询对象?`MXBean` 和 `StandardMBean` 的差异?JVM 内置的 `java.lang` 域管理什么?——下一篇: 域 34 JMX 与监控管理。

> → 域 34 JMX 与监控管理(34-jmx 系列)| 关联: 域 01 字符串(对象名解析)、域 04 反射(MBean 元数据)
