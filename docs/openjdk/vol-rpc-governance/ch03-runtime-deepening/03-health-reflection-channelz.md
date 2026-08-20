# grpc-java：Health、Reflection 与 Channelz — 自描述诊断层

> 基于 grpc-java v1.83.1

## 一、困惑开场：一个具体的问题

假设你第一次在生产环境部署了一套 gRPC 服务。上线半小时后，客户端报了 "service not found" 错误。你要做的第一件事是什么？大概率是查一下服务端到底注册了哪些服务、每个服务是否健康、客户端的连接状态有没有异常。

如果你的 gRPC 服务器注册了 Health、Reflection 和 Channelz 这三个服务，你可以直接用 `grpcurl` 列出服务端的所有方法，用 `grpc-health-probe` 检查服务活性，用 `grpcdebug` 或 `channelz` 工具查看连接状态。但如果你没有注册它们，这一切都无从查起——你只能回去看日志，猜端口，或者临时加一行 `addService` 后重新部署。

这个场景引出了一个更根本的问题：为什么这三个能力不是"日志里多打印几行"就能解决的？为什么它们必须被设计成独立的 gRPC 服务，拥有自己的 proto 定义、自己的 RPC 签名、自己的状态机？

## 二、前情回顾：主干跑通了，但你看不见它

在前面的章节中，我们已经走通了 grpc-java 的四条主干：客户端调用怎么从 stub 走到 transport（ch01/01），服务端怎么把 transport 送来的请求变成 ServerCall 回调（ch01/02），横切面逻辑怎么通过拦截器挂进调用链（ch01/03），发现与选址怎么桥接到 Netty 传输层（ch01/04）。这四条主干解决的都是同一个问题：**调用怎么走通**。

它们没有回答另一个问题：**调用走通之后，你怎么知道它走得对不对？**

当客户端发出一个请求，你知道它成功还是失败。但你知道服务器上有多少个 channel 处于 TRANSIENT_FAILURE 状态吗？你知道某个服务实例是否已经因为后端数据库不可用而应该被摘掉吗？你知道服务端到底注册了哪些方法，能让一个通用的 gRPC 调试工具自动发现吗？

这些问题的答案，恰好就是 Health、Reflection 和 Channelz 要提供的。它们不参与调用链，但调用链上发生的每一件事，都在它们那里留下了痕迹。

## 三、先走两条失败的路

### 失败方案一：把它们当三个独立工具，互不相关

最容易想到的理解方式是：Health 是健康检查，Reflection 是 proto 查询，Channelz 是运行时统计。三个工具，各自独立，互不相关。

这种理解看起来合理，但一落到实现层面就会发现问题。如果它们只是独立的工具，那它们应该可以各自独立地选择注册方式、数据来源和暴露协议。但实际代码显示，这三个服务在 grpc-java 中的结构位置惊人地一致。

首先，它们都是通过 `ServerBuilder.addService()` 注册的 `BindableService`。这意味着它们不是独立于 Server 之外的工具，而是 Server 运行时的一部分。其次，它们都不在核心调用链上，不参与 stub→transport→ServerCall 的路径，但都依赖运行时组件（`ServerImpl`、`ManagedChannelImpl`、`InternalSubchannel`）提供数据源。最后，它们都通过 gRPC 协议本身暴露数据——不是通过 HTTP 端点、Unix socket 或文件系统，而是通过标准的 gRPC RPC。

如果只看到"三个独立工具"，就会错过它们共同的"自描述"模式：通过 gRPC，暴露 gRPC。这个模式恰恰是 grpc-java 完整卷里必须补深的机制层。

### 失败方案二：把 Channelz 当成 Prometheus 指标

如果你熟悉微服务监控，你可能会想：Channelz 不就是 gRPC 版的 Prometheus 指标吗？暴露一些 callsStarted、callsSucceeded、callsFailed 之类的计数器，方便你来聚合和报警。

但 Channelz 的设计跟 Prometheus 指标有本质区别。

第一，它不是一个打平的指标集合。Prometheus 指标是扁平的——每个 metric 有名字、标签和值，你可以按任意维度聚合。但 Channelz 的数据是树形的：RootChannel 包含 Subchannel 列表，Subchannel 包含 Socket 列表，Server 包含 listenSockets 和 per-server-sockets。你不能直接问"所有 channel 的平均调用成功率是多少"——你得先从 RootChannel 走进去，再看它的 Subchannel，再看 Socket。这不是 Channelz 的缺陷，而是它的设计目标：不聚合，可钻取。

第二，每个节点不只包含数值，还包含事件日志。`ChannelTrace` 记录了 channel 生命周期中的关键事件——"连接状态从 CONNECTING 变成 READY"、"进入 TRANSIENT_FAILURE"——每个事件都有时间戳、严重等级，以及关联的 channelRef 或 subchannelRef。这已经超出了"指标"的范畴，进入了"诊断日志"的领域。

第三，Socket 级数据含 TCP 信息（`TcpInfo` 的 29 个字段，包括 rtt、snd_cwnd、retrans、reordering）、TLS 证书详情、socket 选项。这些信息在 Prometheus 里通常需要独立的 exporter 或 sidecar 来采集，而且往往是打平后再也还原不出原始结构。

所以，Channelz 不是 gRPC 版的 Prometheus 指标，它是运行时全景诊断 API。设计者之所以不把它做成平铺指标，是因为聚合应该由使用者自己决定，而不是由框架提前压平。当你想知道"为什么这个 channel 有问题"时，你不是去看一个聚合值，而是从 channel 查到 subchannel，再查到 socket，最后看到 TCP 重传和流控窗口。

### 失败方案三：把 Health 当成简单的存活检查

HTTPS 的健康检查通常是一个"发请求、看 200"的二元判断。但 gRPC 的 Health 协议不是这样设计的。它支持按 service name 粒度报告状态，一个服务器上可以同时运行多个 proto service，其中一些可能因为依赖的后端数据库不可用而暂时无法服务，另一些仍然正常。Health 还支持流式推送（Watch），让客户端不需要轮询。如果只把它当成"ping 一下"的存活检查，就完全错过了它最核心的能力。

## 四、最小总图：自描述诊断层的三个侧面

在进入具体实现之前，先建立一张总图。这张图不复杂，但它是理解三个服务的核心框架。

有一个运行中的 grpc-java 进程。它有一个 `ServerImpl`，可能有一个或多个 `ManagedChannelImpl`。这些运行时组件在运转过程中积累了三类内部状态：

- **服务活性状态**：哪些服务是 SERVING 状态，哪些是 NOT_SERVING。
- **运行时统计**：通道状态、连接状态、调用计数、消息计数、TCP 信息。
- **服务描述信息**：注册了哪些服务，每个服务的 proto 文件描述符是什么。

这三类状态分别被三个服务暴露出去：

- **Health** 暴露服务活性状态。`HealthStatusManager` 维护一个 `service name → ServingStatus` 的映射，`HealthServiceImpl` 通过 `Check()`（unary）和 `Watch()`（server-streaming）两个 RPC 让客户端查询这个映射。
- **Channelz** 暴露运行时统计。`InternalChannelz` 是一个全局单例注册表，`ManagedChannelImpl`、`ServerImpl`、`InternalSubchannel` 在构造时自动向它注册自己，`ChannelzService` 通过七个查询 RPC 暴露这些注册数据。
- **Reflection** 暴露服务描述信息。`ProtoReflectionServiceV1` 通过 `InternalServer.SERVER_CONTEXT_KEY` 从 Context 中获取当前 Server 实例，读取其注册的服务列表，构建 `FileDescriptor` 索引，通过 `ServerReflectionInfo` 这个 bidi-streaming RPC 暴露查询接口。

三个服务的共同模式是：**先注册（addService），再自动发现（运行时组件自动注册或通过 Context 获取），最后通过 gRPC 协议暴露（标准 gRPC 服务）**。它们不需要第三方依赖，不需要外部代理，不需要额外的配置中心——只要 grpc-java 进程在运行，它们就能工作。

下面分层拆解每个服务的实现。

## 五、Health：按服务粒度的活性广播

### 5.1 为什么需要按服务粒度报告活性

想象你在运营一个 gRPC 服务集群。你的 load balancer 需要知道哪些后端实例可以接收流量。最朴素的做法是配一个"健康检查端口"——发一个 HTTP 请求，返回 200 就算活着，否则摘掉。

但 gRPC 服务的健康检查比 HTTP 存活检查复杂。一个 gRPC 服务器可以同时运行多个服务（不同的 proto service），其中一些可能因为依赖的后端数据库不可用而暂时无法服务，另一些仍然正常。如果只用一个 binary "活着/死了"来判断，load balancer 就无法做出精细的流量调度决策。

gRPC 的健康检查协议（`grpc.health.v1.Health`）设计了两个机制来解决这个问题：一是按 service name 粒度报告状态，二是支持流式推送（Watch），让客户端不需要轮询。

### 5.2 架构总览

这个机制在 grpc-java 中由三个组件组成：

1. **`HealthStatusManager`**：对外管理类，用户通过它设置和清除状态。
2. **`HealthServiceImpl`**：实际实现 `HealthGrpc.HealthImplBase`，处理 `Check` 和 `Watch` RPC。
3. **`HealthCheckResponse.ServingStatus`**：状态枚举，取值 `SERVING`、`NOT_SERVING`、`UNKNOWN`、`SERVICE_UNKNOWN`。

用户的使用方式只有三步：

```
HealthStatusManager manager = new HealthStatusManager();
manager.setStatus("my.Service", ServingStatus.SERVING);
serverBuilder.addService(manager.getHealthService());
```

注册后，客户端就可以通过标准的 Health RPC 查询任何 service name 的状态。

### 5.3 HealthServiceImpl 需要追踪什么

`HealthServiceImpl` 要回答两个问题：一个服务当前是什么状态？哪些客户端正在 Watch 这个服务的状态变化？为此，它维护了两个核心数据结构。

第一个问题是靠 `statusMap` 解决的。`HealthServiceImpl` 用一个 `ConcurrentHashMap<String, ServingStatus>` 来记录每个 service name 当前是什么状态。这个 map 在构造时被放入了一个默认条目：`SERVICE_NAME_ALL_SERVICES`（空字符串）被初始化为 `SERVING`。这意味着，即使你没有为任何具体服务设置状态，通过空字符串查询也能得到一个默认值——这是从 Go 和 C++ 实现复制过来的跨语言一致行为，保证用不同语言实现的服务端都能对空字符串给出同样的答复。

`HealthServiceImpl.java:46` — `statusMap = new ConcurrentHashMap<>()`
`HealthServiceImpl.java:65` — `statusMap.put(SERVICE_NAME_ALL_SERVICES, ServingStatus.SERVING)`

第二个问题更复杂。`HealthServiceImpl` 需要知道每个 service name 上有哪些客户端正在 Watch，而且这些客户端是通过 `StreamObserver` 回调来推送的。关键问题是：不同的 `StreamObserver` 实例可能在 `equals()` 上相等——如果两个不同的客户端恰好构造了行为相同的 StreamObserver 实现，`HealthServiceImpl` 不能把它们的身份混为一谈，否则当一个客户端断开时可能会有错误的清理。

所以 `HealthServiceImpl` 用了一个 `HashMap<String, IdentityHashMap<StreamObserver, Boolean>>`（受 `watchLock` 保护）来维护 watcher 注册表。`IdentityHashMap` 按引用比较而不是按 `equals()` 比较，正好解决了"身份混淆"的问题。

`HealthServiceImpl.java:60` — `watchers = HashMap<String, IdentityHashMap<StreamObserver, Boolean>>`

### 5.4 Check 与 Watch：两种暴露方式

`Check` 是一个 unary RPC：客户端发一个 `HealthCheckRequest`（包含 service name），服务端立即返回当前状态。如果 service name 在 `statusMap` 中不存在，返回 `NOT_FOUND` 错误。

`HealthServiceImpl.java:69` — `check()` 方法：查 `statusMap`，找到则返回，找不到则 `onError(NOT_FOUND)`

`Watch` 是一个 server-streaming RPC：客户端发一个请求，服务端先发送当前状态，然后把 `responseObserver` 注册到 watchers 表中。之后每当这个 service 的状态发生变化，所有已注册的 watcher 都会收到推送。

`HealthServiceImpl.java:83` — `watch()` 方法：发当前状态，注册 watcher，设置取消监听器

Watch 的实现有一个关键细节：它在 `Context` 上注册了一个 `CancellationListener`。当客户端断开连接或取消 RPC 时，这个监听器会调用 `removeWatcher()` 清理已注册的 watcher。这样就不会出现"客户端断开后 watcher 泄漏"的问题。

`HealthServiceImpl.java:102` — `Context.current().addListener(cancellationListener, ...)`

### 5.5 状态变化与通知

当用户调用 `manager.setStatus("my.Service", ServingStatus.NOT_SERVING)` 时，调用链如下：

`HealthStatusManager.setStatus()` → `HealthServiceImpl.setStatus()` → 加锁，检查 terminal 标志 → `setStatusInternal()` → 更新 `statusMap`，如果状态真的变了 → `notifyWatchers()` → 遍历 `IdentityHashMap`，逐个推送 `onNext(response)`

`HealthServiceImpl.java:126` — `setStatus()` 方法：`synchronized (watchLock)` 保护
`HealthServiceImpl.java:183` — `notifyWatchers()`：遍历 watcher 并推送

`clearStatus()` 的语义值得注意：它不是把状态设为 UNKNOWN，而是从 `statusMap` 中移除条目。之后 `Check` 这个 service 会返回 `NOT_FOUND`，而正在 Watch 的客户端会收到 `SERVICE_UNKNOWN`。

`HealthServiceImpl.java:144` — `clearStatus()`：`statusMap.remove(service)`，通知 watchers 为 null（代表 SERVICE_UNKNOWN）

### 5.6 优雅退出：enterTerminalState

`enterTerminalState()` 是 Health 机制中一个容易被忽略但很重要的设计。它的作用是：在服务器 shutdown 之前，把所有已注册的服务状态设为 `NOT_SERVING`，并阻止后续任何状态更新。

`HealthServiceImpl.java:157` — `enterTerminalState()`：设置 `terminal = true`，遍历 `statusMap` 全部设为 `NOT_SERVING`

这为什么重要？因为不这样做的话，服务器 shutdown 过程中，load balancer 可能还在向这个服务器发请求。通过先主动声明"所有服务都不 serving"，Health 给了 load balancer 一个明确的信号来切换流量，而不是让请求在连接断开时被硬中断。

### 5.7 边界与局限

Health 机制不负责自动检测服务健康状态。它只提供一个"状态发布"的通道。实际的健康检测逻辑（比如检查数据库连接、缓存状态等）由使用者自行实现，通过 `setStatus()` 发布。

这是正确的设计边界：Health 不是健康检测框架，它是健康状态发布协议。

这里先做一个路标。Health 已经讲完了。下面进入 Channelz。注意它们的模式不同：Health 的数据是用户主动推入的，Channelz 的数据是运行时组件自动注册的。如果你只对"自动注册"这个机制感兴趣，可以重点看 6.4 节和 6.5 节；注册表结构（6.3）和查询接口（6.6）可以先跳过，需要时再回来看。

## 六、Channelz：运行时全景诊断 API

### 6.1 什么时候需要诊断全景

假设你的 gRPC 服务在生产环境出了问题：调用延迟升高、部分请求失败、连接异常断开。你第一步会想查什么？大概率是：当前有多少 channel？每个 channel 处于什么连接状态？每个 channel 上有多少活跃调用？调用成功率是多少？连接级别的问题（比如 TCP 重传、流控窗口耗尽）有没有发生？

这些信息在传统的诊断方案中分散在不同的地方：连接状态在 LB 层，调用计数在调用层，TCP 信息在操作系统层。Channelz 的设计目标就是把这些分散的信息统一到一个树形 API 中，让开发者可以逐层钻取：从 channel 到 subchannel 再到 socket，每一步都能看到详细的统计和事件。

### 6.2 架构总览

Channelz 由三层组成：

1. **`InternalChannelz`**（`api/` 模块）：全局单例注册表，负责存储所有运行时组件的引用。标注为 `@Internal`，不对外暴露。
2. **运行时组件自动注册**：`ManagedChannelImpl`、`ServerImpl`、`InternalSubchannel` 在构造时自动向 `InternalChannelz` 注册自己，在 shutdown 时注销。
3. **`ChannelzService`**（`services/` 模块）：对外暴露的 gRPC 服务，封装 `InternalChannelz` 的查询接口，通过 `ChannelzProtoUtil` 将内部数据类转换为 proto 消息。

### 6.3 InternalChannelz 怎么存放运行时实体

`InternalChannelz` 要面对的问题是：它需要存放五类不同的运行时实体，而且每一类实体的查询方式不同。Server 和 RootChannel 需要支持按 ID 排序和分页，Subchannel 只需要按 ID 精确查找，Socket 则需要按所属 Server 分组。

为此，`InternalChannelz` 设计了五张并发 map：

- **servers**（`ConcurrentSkipListMap<Long, InternalInstrumented<ServerStats>>`）：存放所有 `ServerImpl` 实例。需要支持范围查询，所以用 `ConcurrentSkipListMap`。
- **rootChannels**（`ConcurrentSkipListMap<Long, InternalInstrumented<ChannelStats>>`）：存放所有 `ManagedChannelImpl` 实例。同样需要分页，也用 `ConcurrentSkipListMap`。
- **subchannels**（`ConcurrentHashMap<Long, InternalInstrumented<ChannelStats>>`）：存放所有 `InternalSubchannel` 实例。只按 ID 精确查找，用 `ConcurrentHashMap` 就够了。
- **otherSockets**（`ConcurrentHashMap<Long, InternalInstrumented<SocketStats>>`）：存放客户端 socket 和监听 socket。精确查找，`ConcurrentHashMap`。
- **perServerSockets**（`ConcurrentHashMap<Long, ServerSocketMap>`）：每个 server 的 socket 集合，`ServerSocketMap` 本身是 `ConcurrentSkipListMap<Long, InternalInstrumented<SocketStats>>`。外层按 server ID 查找，内层按 socket ID 排序分页。

`InternalChannelz.java:52` — `servers = new ConcurrentSkipListMap<>()`
`InternalChannelz.java:54` — `rootChannels = new ConcurrentSkipListMap<>()`
`InternalChannelz.java:61` — `perServerSockets = new ConcurrentHashMap<>()`

选择 `ConcurrentSkipListMap` 而不是 `ConcurrentHashMap` 是有意设计的——因为 Channelz 支持分页查询（`getRootChannels(fromId, maxPageSize)`），需要按 ID 排序和范围查询，`ConcurrentSkipListMap` 的 `tailMap(fromId)` 正好满足这个需求。

### 6.4 谁在什么时候把运行时实体登记进注册表

Channelz 最有意思的设计是：注册完全是自动的，使用者不需要做任何额外操作。先记住这个结论，再看证据——下面四个注册点覆盖了"进程里有没有一个东西需要被监控，它就自动出现在注册表里"这条主线。

`InternalChannelz` 的第一类登记来自客户端侧。当你的应用通过 `ManagedChannelBuilder` 创建了一个 `ManagedChannelImpl`，它的构造函数会顺手把自己登记为 root channel：

`ManagedChannelImpl.java:657` — `channelz.addRootChannel(this)`

服务端侧也同样主动。当你的应用创建 `ServerBuilder` 启动了 `ServerImpl`，它会在构造函数里登记为一个 server：

`ServerImpl.java:168` — `channelz.addServer(this)`

上面这两个是"实体本身"的登记。接下来还有一层更细的登记：连接。当 `InternalSubchannel` 为主连接建立了一个新的 transport 连接时，这个 socket 会被登记；当 `ServerImpl` 接受远端客户端的一个新连接时，这个 server socket 也会被登记。这说明注册粒度一直细到单个连接：

`InternalSubchannel.java:281` — `channelz.addClientSocket(transport)`
`ServerImpl.java:435` — `channelz.addServerSocket(ServerImpl.this, transport)`

有进就有出。这些注销点都发生在各自的 shutdown/terminated 生命周期里，保证 Channelz 不会积累死对象：

`ManagedChannelImpl.java:1185` — `channelz.removeRootChannel(this)`
`ServerImpl.java:360` — `channelz.removeServer(this)`
`InternalSubchannel.java:679` — `channelz.removeClientSocket(transport)`

到这里你可以看到全貌：实体创建时自动注册，实体销毁时自动注销，全程不需要使用者参与。你创建的每个 `ManagedChannel` 和 `Server` 都自动进入了 `InternalChannelz` 的注册表。你不需要手动"启用"Channelz——它总是开着，只是数据需要通过 `ChannelzService` 来查询。

### 6.5 数据模型：ChannelStats 到 SocketStats

当 `ChannelzService` 收到一个 `getChannel` 请求时，它拿到的是一份 `ChannelStats` 快照。这份快照要能回答一个通道最重要的诊断问题：这个通道指向哪里、现在是什么连接状态、历史上累计了多少调用、这些调用成功了多少失败了多少、它还管着哪些子通道。所以 `ChannelStats` 被设计成由这几个维度拼成，核心是 **target + state + 三组计数 + 树形引用**（`subchannels` 或 `sockets`）。

`InternalChannelz.java:369` — `ChannelStats` 数据类，含 target/state/calls 计数/子级引用

`ChannelStats` 里有一个关键的互斥约束：root channel 可以有 `subchannels`，subchannel 可以有 `sockets`，但同一个 `ChannelStats` 不能同时携带这两者。这个约束由构造函数的 `checkState` 强制执行——它保证了"channel → subchannel → socket"是一棵严格的树，不会出现一个节点既指着下面又指着侧面导致钻取歧义。

`InternalChannelz.java:394` — `checkState(subchannels.isEmpty() || sockets.isEmpty(), ...)`

`ChannelStats` 只是第一层。当你要继续往下钻取时，会发现每层的统计信息都越来越细。`ChannelTrace` 记的是事件——一个 channel 生命周期里发生了什么（"连接状态从 CONNECTING 变成 READY"、"进入 TRANSIENT_FAILURE"），每个事件带时间戳、严重等级和关联的 channelRef/subchannelRef；`SocketStats` 则直面传输层，`TransportStats` 有 streams/messages/keepalive 计数和两个流控窗口，`TcpInfo` 直接给到 29 个 TCP 协议字段（rtt、snd_cwnd、retrans、reordering），`Security` 记录 TLS 加密套件和证书。越往下越像"读操作系统"。

`InternalChannelz.java:1055` — `TransportStats` 含流控窗口、keepalive、streams/messages 计数
`InternalChannelz.java:730` — `TcpInfo` 29 个 TCP 协议字段

### 6.6 外用接口：ChannelzService 的七个查询 RPC

`InternalChannelz` 是内部注册表，外面的人不能直接碰它。`ChannelzService` 把 `InternalChannelz` 的查询能力（`getRootChannels`、`getChannel`、`getServers`、`getServer`、`getSubchannel`、`getSocket`、`getServerSockets`）一一映射成为七个标准的 gRPC unary RPC。七个 RPC 的名字和内部查询方法一一对应，看起来像一层薄薄的翻译层——但它承担了两件真正有价值的事。

第一件事是分页。四类"列表查询"（`getTopChannels`、`getServers`、`getServerSockets`）都带分页参数：调用方传入 `startId`（起始 ID）和 `maxPageSize`（最大返回数），服务端从 `startId` 开始返回连续条目，并在响应里标注 `end`（是否已到末尾）。这是典型的"按 ID 游标分页"模式——它避免了基于偏移量的分页在并发写入时出现重复或缺失。

`ChannelzService.java:70` — `getTopChannels()` 调用 `channelz.getRootChannels()`
`ChannelzService.java:212` — `getServerSockets()` 调用 `channelz.getServerSockets()`

第二件事是边界控制。`ChannelzService`（以及它上面的 `ChannelzProtoUtil`）是唯一被允许暴露 `InternalChannelz` 数据的合法出口——`InternalChannelz` 标注了 `@Internal`，不能直接依赖。

还有一点需要明确边界：`ChannelzService` 只暴露原始数据，不做聚合。你要算"所有 channel 的成功率"，得自己把原始结果拼起来——这正是它和 Prometheus 的根本区别（我们在失败方案里已经区分过）。

### 6.7 Channelz 的边界与局限

`InternalChannelz` 标注为 `@Internal`，这意味着它不应该被直接使用。正确的用法是注册 `ChannelzService` 到你的 gRPC 服务器，然后通过 gRPC 协议查询。

`ChannelzService` 本身不提供聚合功能。它暴露的是原始数据，聚合（如"计算所有 channel 的调用成功率"）需要由客户端完成。

再做一个路标。Channelz 已经讲完了，下面进入 Reflection。这是三个服务中唯一一个不使用注册表的——它不依赖 `InternalChannelz`，而是通过 `SERVER_CONTEXT_KEY` 从 Context 中动态获取当前 Server。如果你对"如何在 gRPC 内部获取当前 Server 实例"这个机制感兴趣，可以重点看 7.3 节，它是 Reflection 的钥匙。

## 七、Reflection：运行时服务描述索引

### 7.1 为什么需要运行时发现服务描述

在 gRPC 生态中，客户端需要知道服务端提供了哪些服务、每个服务有哪些方法、每个方法的请求和响应类型是什么，才能正确地发起调用。在开发阶段，客户端和服务端通常共享 `.proto` 文件，通过 codegen 生成代码，所以这些信息是编译时已知的。

但在生产环境中，很多场景下客户端并不知道服务端的具体 proto 定义——比如通用的 gRPC 调试工具（如 `grpcurl`）、API 网关、服务网格的控制面。这些工具需要一种方式在运行时发现服务端的能力。

gRPC 的 Server Reflection 协议（`grpc.reflection.v1.ServerReflection`）就是为了解决这个问题而设计的。它允许客户端在运行时查询服务端的所有 proto 文件描述符，包括服务定义、方法签名、消息类型、枚举值、扩展等。

### 7.2 架构总览

Reflection 在 grpc-java 中由以下组件组成：

1. **`ProtoReflectionServiceV1`**（`services/` 模块）：实现 `ServerReflectionGrpc.ServerReflectionImplBase`，对外暴露 `ServerReflectionInfo` bidi-streaming RPC。
2. **`ServerReflectionIndex`**（`ProtoReflectionServiceV1` 的内部类）：包含 `FileDescriptorIndex` 的 immutable 和 mutable 两份索引。
3. **`FileDescriptorIndex`**（`ProtoReflectionServiceV1` 的内部类）：对一组 `ServerServiceDefinition` 的 proto 文件描述符建立文件名、符号名、扩展名倒排索引。
4. **`InternalServer.SERVER_CONTEXT_KEY`**：从 Context 中获取当前 Server 实例的上下文键。

### 7.3 自动发现：SERVER_CONTEXT_KEY

Reflection 最巧妙的设计是它如何"发现"当前服务器注册了哪些服务。

当 `ProtoReflectionServiceV1` 处理一个查询请求时，它需要知道当前是哪个 `ServerImpl` 在处理这个请求。但 `ProtoReflectionServiceV1` 本身只是个 `BindableService`，它没有持有一个特定的 `Server` 引用——同一个 `ProtoReflectionServiceV1` 实例可以被注册到多个 `Server` 上。

解决方案是：`ServerImpl` 在调用服务方法之前，会在 `Context` 中设置当前 `Server` 实例。`ProtoReflectionServiceV1` 通过 `InternalServer.SERVER_CONTEXT_KEY.get()` 从 Context 中取出当前 `Server`。

`ProtoReflectionServiceV1.java:89` — `Server server = InternalServer.SERVER_CONTEXT_KEY.get()`
`ServerImpl.java:156` — `Context.withValue(InternalServer.SERVER_CONTEXT_KEY, ServerImpl.this)`

这样，无论 `ProtoReflectionServiceV1` 被注册到多少个 Server 上，它都能正确响应每个 Server 的注册服务列表。

### 7.4 索引构建：ProtoReflectionServiceV1 怎么知道服务变了

`ProtoReflectionServiceV1` 每次收到查询请求时，都要先确认自己的索引是不是最新的。它通过 `getRefreshedIndex()` 方法来做这件事，逻辑分四步：

第一步，从 Context 里拿到当前是哪个 `Server` 在处理这个请求。这一步依赖 7.3 节讲的 `SERVER_CONTEXT_KEY` 机制。

第二步，查缓存。`ProtoReflectionServiceV1` 内部用一个 `WeakHashMap<Server, ServerReflectionIndex>` 来缓存每个 Server 的索引。用 `WeakHashMap` 的好处是：当 Server 被 GC 回收时，对应的索引也会被自动清理，不用担心内存泄漏。

第三步，如果缓存里没有这个 Server 的索引，就重新创建一个。创建时传入 `getImmutableServices()` 和 `getMutableServices()` 两组服务列表。

第四步，也是最关键的一步：如果缓存已经存在，`ProtoReflectionServiceV1` 需要检查 mutable services 有没有变化。它比较当前 mutable services 的 `FileDescriptor` 集合和 `serviceName` 集合是否与缓存中的一致，如果不一致就重建索引。

`ProtoReflectionServiceV1.java:87` — `getRefreshedIndex()` 完整流程
`ProtoReflectionServiceV1.java:98-125` — 检测 mutable services 变化

这里有一个设计选择值得注意：为什么要区分 immutable 和 mutable？因为 `ServerImpl` 支持两种注册方式：`addService()` 注册的服务在启动后不会变化（immutable），而另一类服务可能被动态添加或移除。immutable 的索引只需要构建一次，mutable 的索引每次查询都要检测变化。这个区分不是性能微优化——它直接决定了动态添加的服务能不能被 Reflection 正确发现。

### 7.5 FileDescriptorIndex：把 proto 文件描述符变成可查询的索引

`ServerReflectionIndex` 负责的是"有哪些服务"，而 `FileDescriptorIndex` 负责的是更底层的问题：给定一组服务，怎么让客户端能按文件名、按符号名、按扩展编号来查到对应的 `FileDescriptor`？

`FileDescriptorIndex` 的做法是：遍历所有服务的 `FileDescriptor`（以及它们的依赖文件），建立三个倒排索引。

第一个索引是按文件名（`fileDescriptorsByName`），客户端可以说"我要 `helloworld.proto`"。第二个是按符号名（`fileDescriptorsBySymbol`），客户端可以说"我要 `helloworld.Greeter`"或"我要 `helloworld.Greeter.SayHello`"。第三个是按扩展类型加编号的组合（`fileDescriptorsByExtensionAndNumber`），客户端可以说"我要 `google.protobuf.Any` 的扩展 100"。

建立这三个索引的过程是 BFS 遍历：从每个服务的 `FileDescriptor` 出发，处理当前文件（注册里面的 service、method、type、extension），然后把它所有的 `dependencies` 入队继续处理，直到所有依赖文件都被覆盖。这样，即使一个 proto 文件通过 `import` 依赖了另外十个文件，客户端也能一次查到完整的 `FileDescriptor` 链。

`ProtoReflectionServiceV1.java:408` — `FileDescriptorIndex` 构造器，BFS 遍历依赖
`ProtoReflectionServiceV1.java:479` — `processFileDescriptor()` 注册 service/method/type/extension

### 7.6 查询处理

`ProtoReflectionStreamObserver` 是处理 bidi-streaming 消息的内部类。它支持五种查询类型：

- `FILE_BY_FILENAME`：按 proto 文件名查找文件描述符。
- `FILE_CONTAINING_SYMBOL`：按符号名（如 `"helloworld.Greeter"`、`"helloworld.Greeter.SayHello"`）查找包含该符号的文件描述符。
- `FILE_CONTAINING_EXTENSION`：按扩展类型和编号查找文件描述符。
- `ALL_EXTENSION_NUMBERS_OF_TYPE`：查询某个类型的所有扩展编号。
- `LIST_SERVICES`：列出所有已注册的服务名称。

`ProtoReflectionServiceV1.java:172` — `handleReflectionRequest()` 按 `MessageRequestCase` 分发

当查询需要返回 `FileDescriptor` 时，`createServerReflectionResponse()` 会做一次 BFS 遍历，收集该文件及其所有依赖文件的 `FileDescriptorProto` 字节——这样客户端就获得了完整的类型解析上下文，而不只是单个文件。

`ProtoReflectionServiceV1.java:296` — `createServerReflectionResponse()` BFS 收集依赖

### 7.7 边界与局限

`ProtoReflectionServiceV1` 只支持 protobuf 服务。如果你的 gRPC 服务使用其他序列化协议（如自定义 marshaller），Reflection 无法提供服务描述。

它不提供服务调用能力——它只回答"服务端有什么"，不回答"怎么调用"。调用能力由 `grpcurl` 等工具自行实现。

到这里，三个服务的实现已经全部走完了。如果你是一路读下来的，这里的"三个服务对比"可以作为你的记忆锚点；如果你只对某一个服务感兴趣，可以直接跳到对应章节。下面把三者放在一起，看它们的共同模式。

## 八、三个诊断服务的对比

把三个服务放在一起对比，它们的模式更加清晰。

| 维度 | Health | Channelz | Reflection |
|------|--------|----------|------------|
| 暴露什么 | 服务活性状态 | 运行时统计（channel/socket/server） | 服务描述（proto FileDescriptor） |
| 数据来源 | `HealthStatusManager` 手动设置 | `InternalChannelz` 自动注册 | `ServerImpl` 自动发现（Context） |
| 注册方式 | `ServerBuilder.addService()` | `ServerBuilder.addService()` | `ServerBuilder.addService()` |
| 数据采集方式 | 用户调用 `setStatus()` | 运行时组件自动注册 | 从 Context 获取 Server 后构建索引 |
| 请求方式 | Check（unary）+ Watch（streaming） | 7 个 unary RPC（含分页） | 1 个 bidi-streaming RPC（5 种查询） |
| 权限 | 无内置认证 | 无内置认证 | 无内置认证 |
| 版本状态 | `@ExperimentalApi` | `@Internal` + `@ExperimentalApi` | `@ExperimentalApi` |

三个服务的共同点是：它们都是通过 `ServerBuilder.addService()` 注册的 `BindableService`，都不在核心调用链上，都依赖 grpc-java 运行时提供数据，都通过 gRPC 协议本身暴露数据。

它们的差异在于数据来源的方式：Health 的数据是用户主动推入的（`setStatus()`），Channelz 的数据是运行时组件自动注册的（构造时自动调用 `addRootChannel/addServer`），Reflection 的数据是通过 Context 从 `ServerImpl` 拉取的（`getRefreshedIndex()`）。

## 九、收网总结

回到开头的困惑：Health、Reflection、Channelz 为什么不是"辅助服务杂项"？

因为它们并不是独立于运行时之外的额外工具。它们暴露的正是运行时内部的状态——服务活性、连接统计、服务描述。没有这些状态，grpc-java 进程对外界来说就是一个黑盒：你只知道它在运行，但不知道它运行得好不好、连接到谁、提供了什么能力。

这三个服务共同构成了 grpc-java 的自描述诊断层。它们不参与调用链，但调用链的每一次执行都会在它们内部留下痕迹。Health 记录着服务的活性，Channelz 记录着调用的计数和连接的状态，Reflection 记录着服务的能力边界。

这正是《源码范围规划复盘方法论》中强调的"不能低估运行时诊断能力"的含义。在主干运行时篇中，我们关注的是"调用怎么走通"；在机制补深篇中，我们关注的是"运行时怎么被看见"。没有后者，前者就是一个不可观测的黑盒。

**三句话总结：**

1. Health、Reflection、Channelz 不是三个独立的辅助工具，而是 grpc-java 自描述诊断层的三个侧面，共享"通过 gRPC 协议暴露运行时内部状态"的模式。
2. Health 通过 `check()`/`watch()` 暴露服务活性，Channelz 通过 `InternalChannelz` 注册表暴露运行时全景，Reflection 通过 `ServerReflectionIndex` 暴露服务 proto 描述。
3. 它们都需要通过 `ServerBuilder.addService()` 显式注册，但注册之后的数据采集是自动的——这是 grpc-java 生产可见性的基础。

**下篇预告：** 下一篇将进入压缩与编解码机制（Compression / Codec / Message Framing），看 grpc-java 如何在消息传输层做压缩协商、编解码器选择和失败路径处理。