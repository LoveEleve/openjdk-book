# 03. SocketChannel 与阻塞/非阻塞 — 模式切换、connect 三阶段、事件循环

> **前置依赖**: [21-selector-nio/01 — Selector 抽象与选择机制](01-selector-mechanism.md)(注册、就绪事件)、[21-selector-nio/02 — epoll 实现与平台分层](02-epoll-platform.md)(内核等待)
> → **后续**: 域 34 JMX 与监控管理(34-jmx 系列,按写作顺序)
> 关联: 域 19 BufferChannel(读写载体);内部卷 01-os(平台 fd)

## 同一个通道,两种灵魂

`SocketChannel` 默认和 BIO 的 `Socket` 一样是阻塞的——但多了一个开关: 切成非阻塞后,读写立即返回,配合 Selector 就成了"单线程管 N 连接"的基石。这一篇讲双模式切换的本质(fd 的 O_NONBLOCK)、非阻塞 connect 的三阶段状态机、以及事件循环里 accept/read 的处理。

## 1. "阻塞 vs 非阻塞" — 双模式通道

### 1.1 模式切换的本质: fd 的 O_NONBLOCK

`configureBlocking(block)`(`spi/AbstractSelectableChannel.java:298-313`):

- 未注册时随意切换;但**已注册 Selector 的通道不能切回阻塞**(`:306-307`,`IllegalBlockingModeException`)——Selector 的非阻塞轮询要求通道绝不能挂起线程
- 切换最终落到 native: `IOUtil.configureBlocking` 用 `fcntl` 改 fd 的 `O_NONBLOCK` 标志(`unix/native/libnio/ch/IOUtil.c:69-76`,逐字):

```c
// IOUtil.c:69-76(截取,逐字)
static int
configureBlocking(int fd, jboolean blocking)
{
    int flags = fcntl(fd, F_GETFL);
    int newflags = blocking ? (flags & ~O_NONBLOCK) : (flags | O_NONBLOCK);

    return (flags == newflags) ? 0 : fcntl(fd, F_SETFL, newflags);
}
```

### 1.2 模式决定语义

- **阻塞**: 没有数据/连接就挂起线程(内核等待,线程睡着)
- **非阻塞**: 立即返回(读返回 0/EOF,accept 返回 null)——把"等"的职责让给 Selector

面试"SocketChannel 和 BIO Socket 区别": 双模式(configureBlocking)+ 可注册 Selector——BIO 的 Socket 只有一个模式,一连接一线程。

关键设计(斜体):*"模式决定语义"——阻塞 = 线程挂起等数据;非阻塞 = 立即返回让出线程;Selector 只与非阻塞配合(已注册通道禁止切回阻塞)。面试"SocketChannel 和 BIO Socket 区别": 双模式 + 可注册 Selector,单线程管 N 连接的前提。*

## 2. "非阻塞 connect" — 三阶段状态机

### 2.1 状态常量

`SocketChannelImpl.java:95-97`:

```java
// SocketChannelImpl.java:95-97(逐字)
    private static final int ST_UNCONNECTED = 0;
    private static final int ST_CONNECTIONPENDING = 1;
    private static final int ST_CONNECTED = 2;
```

### 2.2 connect: 发起

`connect(SocketAddress)`(`SocketChannelImpl.java:672-710`)的核心:

```java
// SocketChannelImpl.java:690-698(截取,逐字)
                        beginConnect(blocking, isa);
                        do {
                            n = Net.connect(fd, ia, isa.getPort());
                        } while (n == IOStatus.INTERRUPTED && isOpen());
                    } finally {
                        endConnect(blocking, (n > 0));
                    }
                    assert IOStatus.check(n);
                    return n > 0;
```

native 层(`unix/native/libnio/ch/Net.c:317-326`,截取,逐字):

```c
    rv = connect(fdval(env, fdo), &sa.sa, sa_len);
    if (rv != 0) {
        if (errno == EINPROGRESS) {
            return IOS_UNAVAILABLE;
        } else if (errno == EINTR) {
            return IOS_INTERRUPTED;
        }
        return handleSocketError(env, errno);
    }
    return 1;
```

- **状态转换发生在 `beginConnect`**(`:625-648`): 先置 `ST_CONNECTIONPENDING`(`:641`,阻塞/非阻塞都一样),握手完成由 `endConnect` 置 `ST_CONNECTED`
- **阻塞模式**: `connect(2)` 在内核里完成三次握手后才返回 → 返回 true
- **非阻塞模式**: 握手未完成时内核返回 `EINPROGRESS` → native 返回 `IOStatus.UNAVAILABLE`(-2,`IOStatus.java:37`)→ `return n > 0` 为 false,状态保持 pending,等 `finishConnect` 确认

### 2.3 finishConnect: 确认

`finishConnect()`(`SocketChannelImpl.java:757-789`)的核心:

```java
// SocketChannelImpl.java:770-779(截取,逐字)
                        beginFinishConnect(blocking);
                        int n = 0;
                        if (blocking) {
                            do {
                                n = checkConnect(fd, true);
                            } while ((n == 0 || n == IOStatus.INTERRUPTED) && isOpen());
                        } else {
                            n = checkConnect(fd, false);
                        }
                        connected = (n > 0);
```

- 阻塞: do-while 一直等到握手完成(`:774-775`)
- 非阻塞: **单次** `checkConnect(fd, false)`(`:777`)——没完成返回 false,完成了置 `ST_CONNECTED`(`endFinishConnect`,`:741-754`)

### 2.4 与 Selector 配合

非阻塞 connect 的正确姿势: 注册 `OP_CONNECT` 兴趣 → select 就绪(内核握手完成)→ `finishConnect()` 确认 → 返回 true 后开始读写。

面试"非阻塞 connect 怎么等完成": connect 发起(EINPROGRESS)→ 注册 OP_CONNECT → 就绪后 finishConnect 确认——两段式。

关键设计(斜体):*"非阻塞 connect 分两段"——connect 发起、finishConnect 确认;OP_CONNECT 就绪表示"连接已完成待确认"。面试"非阻塞 connect 怎么等完成": OP_CONNECT 事件 + finishConnect;状态机三态(ST_UNCONNECTED → ST_CONNECTIONPENDING → ST_CONNECTED)是完整答案。*

## 3. "accept 与读写" — 事件循环三件事

### 3.1 accept: 非阻塞无连接返回 null

`ServerSocketChannelImpl.accept()`(`ServerSocketChannelImpl.java:274-302`)关键点:

```java
// ServerSocketChannelImpl.java:284-296(截取,逐字)
                do {
                    n = accept(this.fd, newfd, isaa);
                } while (n == IOStatus.INTERRUPTED && isOpen());
            } finally {
                end(blocking, n > 0);
                assert IOStatus.check(n);
            }

            if (n < 1)
                return null;

            // newly accepted socket is initially in blocking mode
            IOUtil.configureBlocking(newfd, true);
```

- 非阻塞且无新连接 → `n < 1` → **返回 null**(`:292-293`)
- 新连接初始是**阻塞模式**(`:296` 注释 "newly accepted socket is initially in blocking mode")——要进事件循环,应用自己再 `configureBlocking(false)` + 注册 OP_READ

### 3.2 read: 阻塞重试,非阻塞一次

`read(ByteBuffer)`(`SocketChannelImpl.java:336-363`)的关键分支(`:351-356`,截取,逐字):

```java
// SocketChannelImpl.java:351-356(截取,逐字)
                if (blocking) {
                    do {
                        n = IOUtil.read(fd, buf, -1, nd);
                    } while (n == IOStatus.INTERRUPTED && isOpen());
                } else {
                    n = IOUtil.read(fd, buf, -1, nd);
                }
```

- 阻塞: 中断(INTERRUPTED)重试,否则一直等到数据
- 非阻塞: 一次调用——native 没数据返回 `UNAVAILABLE`(-2),`IOStatus.normalize` 转成 0(`IOStatus.java:59-64`),即"返回 0"

### 3.3 线程模型对比

| | BIO | NIO |
|--|-----|-----|
| 线程数 | 每连接一个线程 | 一个线程(或少量) |
| 阻塞点 | 每个连接的 read 都阻塞线程 | 只阻塞在 select |
| 模型 | 同步阻塞 | 事件驱动 |

完整事件循环: `OP_ACCEPT` 就绪 → `accept()` → 新通道 `configureBlocking(false)` + 注册 `OP_READ` → 数据就绪 → `read()` 消费。

关键设计(斜体):*"事件循环三件事"——accept/read 都由 readyOps 驱动,NIO = 单线程 + 事件驱动 vs BIO = 每连接一线程阻塞等待。面试"BIO 和 NIO 线程模型差异": 线程数、阻塞点、事件驱动;面试"非阻塞 read 返回 0 什么意思": 暂时没数据,注册的 OP_READ 会再次通知。*

跨层标注: [域 19 BufferChannel——read/write 的载体 Buffer(19-buffer-channel/01);内部卷 01-os——fcntl/O_NONBLOCK 与 fd 平台层]

## 核心悬念

NIO 收官——**JMX 管理框架**来了: `MBeanServer` 怎么注册/查询对象?`MXBean` 和 `StandardMBean` 的差异?JVM 内置的 `java.lang` 域管理什么?——下一篇: 域 34 JMX 与监控管理。

> → 域 34 JMX 与监控管理(34-jmx 系列)| 关联: 域 01 字符串(对象名解析)、域 04 反射(MBean 元数据)
