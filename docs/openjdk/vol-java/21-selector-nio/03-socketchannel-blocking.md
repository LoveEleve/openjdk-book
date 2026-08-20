# 03. SocketChannel 与阻塞/非阻塞 — 模式切换、connect 三阶段、事件循环

> 本文基于 JDK 11 `SocketChannel`、`ServerSocketChannel` 及 Linux/Unix `SocketChannelImpl`/`ServerSocketChannelImpl` 行为。本文聚焦阻塞/非阻塞模式切换、非阻塞 connect 三阶段、accept/read 行为差异与事件循环语义；JMX 及更高层框架不在本文展开。本文讨论的是 JDK 11 Unix/Linux 路径下的 SocketChannel 语义，不把这里的 `O_NONBLOCK` 切换、connect 状态机和返回值约定外推成所有平台、所有通道实现都必须遵守的统一规范。
> **前置依赖**：[21-selector-nio/01 — Selector 抽象与选择机制](01-selector-mechanism.md)(注册、就绪事件)、[21-selector-nio/02 — epoll 实现与平台分层](02-epoll-platform.md)(内核等待)
> **后续**：域 34 JMX 与监控管理(34-jmx 系列,按写作顺序)

## 为什么同一个通道,只改一个阻塞开关,线程模型就会从“一连接一线程”等级跳到事件驱动

`SocketChannel` 最容易被低估的一点,是它看起来只比传统 `Socket` 多了一个 `configureBlocking(false)` 开关,好像只是“读写方式不同一点”。但真正变掉的不是方法返回值风格,而是**等待职责到底落在线程自己身上,还是被外包给 Selector 和内核就绪事件**。阻塞模式下,线程直接睡在 connect/read/accept 上;非阻塞模式下,这些调用必须立刻返回,把“等”的责任让回事件循环。

这也是为什么 `SocketChannel` 会把很多原本在 BIO 里看起来简单的动作拆成两段甚至三段: connect 不再是一口气完成,而是先发起、后确认; accept/read 不再保证“调用了就得到结果”,而是用 null/0 表达“现在还没有,等下一轮事件”。一旦这层等待语义变化没看清,后面的 `OP_CONNECT`、`finishConnect()`、非阻塞读 0 返回值,都会被误解成怪异 API 细节。

所以这一篇的主线不是接口速览,而是沿着这个总问题展开: 为什么同一个 fd 只改 `O_NONBLOCK` 就会把 BIO 模型改写成事件驱动,以及 connect/accept/read 在这种双模式语义下到底发生了什么变化。

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

## 六、五个最容易混掉的边界：非阻塞不是异步完成，connect false 不是失败，finishConnect 不是多余，accept 的 null 不是异常，read 的 0 也不是 EOF

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，非阻塞并不是“系统会在后台帮你自动完成一切”。它真正改变的是等待责任：当前调用不能再把线程睡在系统调用里，而必须立刻返回，把“等结果”这件事交给 Selector 和后续事件循环。

第二，`connect()` 在非阻塞下返回 false 也不是连接失败。更多时候，它表达的是“握手已经发起，但现在还没完成”，也就是状态已经从未连接推进到 pending，而不是直接宣布这条路走不通。

第三，`finishConnect()` 更不是历史遗留补丁。它恰恰是非阻塞连接语义能成立的关键第二步：`OP_CONNECT` 就绪只说明“可以来确认了”，真正把状态推进到 connected 的，是这次确认动作本身。

第四，非阻塞 `accept()` 返回 null 也不是异常。它只是很朴素地在说：当前没有新连接可拿。既然等待已经外包给 Selector 了，那“现在没结果”本来就应该被编码成一个立即返回值，而不是线程继续睡在这里。

第五，非阻塞 `read()` 返回 0 同样不是 EOF。它表达的是“现在还没数据”；只有返回 -1，才是对端真正关闭。把 0 和 -1 混在一起，事件循环的读语义就会立刻出错。

把这五条边界记稳，SocketChannel 这一篇就不会重新塌回“Socket 多了个非阻塞开关”这种扁平印象。它真正讲的是：只改一个 fd 等待模式，connect/accept/read 这些原本看似线性的动作就会全部拆成事件驱动语义。

## 收网：SocketChannel 真正改写的不是 API 表面，而是“等待”到底落在线程自己身上，还是外包给事件循环

回到开头那个总问题，现在已经能看清为什么同一个通道只改一个阻塞开关，线程模型就会发生质变。阻塞模式下，线程自己承担等待：connect 要等握手完成，read 要等数据到来，accept 要等新连接。非阻塞模式下，这些动作都必须立刻返回，把“等待尚未完成”编码成 pending、null、0 这类状态，再交回 Selector 驱动的事件循环继续推进。

这也把整篇的主线收回来了：

- `configureBlocking` 真正在改的是 fd 的 `O_NONBLOCK` 语义；
- 非阻塞 connect 被自然拆成“发起 + 确认”两段；
- accept/read 则把“当前没结果”显式编码成 null/0；
- 事件循环最后把它们串成 `OP_ACCEPT → configureBlocking(false) → register(OP_READ) → read/write` 的闭环。

把整篇压成一张总图，就是：

```text
阻塞模式
  → 线程自己睡在 connect/read/accept 上

非阻塞模式
  → 调用立刻返回
  → Selector 负责等待就绪
  → connect 用 finishConnect 确认
  → accept/read 用 null/0 表达“现在没结果”

事件循环
  → 接收连接
  → 新通道切非阻塞并注册
  → 后续读写由 readyOps 驱动
```

如果说前两篇解决的是“等待如何被集中剥离出来、Linux 上又怎样落到 epoll 事件表里”，这一篇真正补上的就是：**通道本身怎样配合这种等待语义变化，把 BIO 的线性阻塞流程改写成 NIO 的事件驱动闭环。**
