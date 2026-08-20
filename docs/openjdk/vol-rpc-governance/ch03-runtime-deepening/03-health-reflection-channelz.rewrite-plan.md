# grpc-java：Health、Reflection 与 Channelz — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch03-runtime-deepening`
- 篇：`03 Health、Reflection 与 Channelz`
- 对应主题：`G-DEEP-5 Health / Reflection / Channelz`
- 文章类型：运行时机制补深篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：Health、Reflection、Channelz 三个服务看起来像是"辅助工具杂项"——它们没有参与调用链核心路径，那么它们为什么值得被放进 grpc-java 完整卷一起讨论？它们和 server、metadata、status、transport 到底有什么关系？
- 一句话顿悟：这三个服务本质上把 grpc-java 运行时内部状态（服务健康、服务描述、通道/套接字/服务器统计）通过 gRPC 协议本身暴露出来——它们不是外部监控插件，而是 grpc-java 的自描述诊断层；Health 暴露服务活性状态，Reflection 暴露协议描述，Channelz 暴露运行时统计。
- 文章边界：本篇重点讲 `HealthStatusManager`/`HealthServiceImpl`、`ChannelzService`/`InternalChannelz`、`ProtoReflectionServiceV1`/`ServerReflectionIndex` 各自与运行时（ServerImpl、ManagedChannelImpl 等）的对接机制；不展开到 OpenTelemetry/gcp-observability 等外部监控适配，不把 Health/Reflection/Channelz 的生产排障用法全吞进本篇（留给后续生产诊断卷）。

## 前置依赖

### HARD

- `vol-rpc-governance/ch01-grpc-runtime/02-servercall-and-streaming-model.md`：已经知道服务端如何注册服务、`ServerServiceDefinition` 和 `ServerImpl` 如何管理注册的服务。
- `vol-rpc-governance/ch01-grpc-runtime/04-nameresolver-loadbalancer-netty-transport.md`：已经知道 `ManagedChannelImpl` 和 `InternalSubchannel` 的运行时结构。
- `vol-rpc-governance/ch02-codegen-builders/02-channel-server-builders.md`：已经知道 `ServerBuilder` 和 `ManagedChannelBuilder` 的装配方式。

### SOFT

- 不要求先懂 xDS 或生产排障。
- 不要求先懂 `CallTracer` 的所有细节。

### NAV

- 后续可接：生产诊断卷中的 `Channelz / Health / Reflection 的生产使用`。
- 后续可接：`Compression / Codec / Message Framing`。

## 一句话困惑

Health、Reflection、Channelz 这三个"辅助服务"跟 grpc-java 的核心运行时到底有什么关系？它们为什么不是在外部用 curl 或 prometheus 解决的，而是必须作为 gRPC 服务本身自带的一部分？

## 一句话顿悟

这三个服务共同构成 grpc-java 的自描述诊断层：Health 通过 `HealthStatusManager` 暴露服务活性状态，Reflection 通过 `ProtoReflectionServiceV1` 暴露 proto 描述，Channelz 通过 `InternalChannelz` 注册表暴露通道/套接字/服务器统计；它们都是"通过 gRPC 协议暴露 gRPC 运行时内部状态"，而不是外部监控工具。

## 读者理解路径

1. 先否定"这些只是辅助杂项，不需要理解它们和运行时关系"的粗糙印象。
2. 建立最小总图：`ServerBuilder.addService(HealthStatusManager.getHealthService())` → 运行时状态通过 gRPC 协议暴露出去。
3. 解释 Health 的机制：`HealthStatusManager` → `HealthServiceImpl` → `statusMap` + `watcher` 模式，对比 `check()`（unary）与 `watch()`（server-streaming）的差异。
4. 解释 Reflection 的机制：`ProtoReflectionServiceV1` → `ServerReflectionIndex` → `FileDescriptorIndex`，通过 `SERVER_CONTEXT_KEY` 自动发现服务注册。
5. 解释 Channelz 的机制：`InternalChannelz` 单例注册表 → `ManagedChannelImpl`/`ServerImpl`/`InternalSubchannel` 自动注册 → `ChannelzService` 暴露查询 RPC。
6. 收束对比：三个服务如何在"注册方式、暴露方式、数据来源"上形成统一的诊断层模式。
7. 扣回 "为什么这是一篇，而不是三个独立篇"：三个服务共享"自描述诊断层"的机制定位，共同构成 grpc-java 的运行时可见性基础。

## 失败方案推演

### 失败方案一：Health/Reflection/Channelz 是三个独立的辅助工具，互不相关

- 这会漏掉它们共同的模式：
  - 都是通过 gRPC 协议暴露 gRPC 运行时状态
  - 都需要通过 `ServerBuilder.addService()` 显式注册
  - 都依赖运行时组件（ServerImpl、ManagedChannelImpl）提供数据源
  - 都承担"生产可见性"职责，而非"调用链参与"职责
- 所以它们不是三个杂项，而是一个机制层：自描述诊断层。

### 失败方案二：Health 检查只是简单的"服务器是否存活"

- 这会漏掉：
  - `HealthServiceImpl` 的 service name 粒度（不是 binary alive/dead，而是每个服务可独立设置状态）
  - `SERVICE_NAME_ALL_SERVICES`（空字符串）作为默认整体健康状态
  - `watch()` 的流式推送模式
  - `enterTerminalState()` 的优雅退出（标记所有服务 NOT_SERVING 并阻止后续更新）
  - `clearStatus()` 使 check 返回 NOT_FOUND
  - 所以 Health 不是简单的存活检查，而是一个按服务粒度的活性状态广播机制。

### 失败方案三：Channelz 等价于 Prometheus 指标

- 这会漏掉：
  - `InternalChannelz` 的数据是运行时内部结构的直接映射（Channel → Subchannel → Socket 树形结构），不是打平的指标
  - 它有分页查询（`getTopChannels(fromId, maxPageSize)`）
  - 它有 `ChannelTrace` 事件记录（不是纯数值指标，还有带时间戳的事件日志）
  - 它有 `TcpInfo` 这样的 TCP 级诊断信息
  - 所以 Channelz 是运行时全景诊断 API，不是指标集合。

### 失败方案四：Reflection 只是 gRPC 调试工具，不涉及运行时机制

- 这会漏掉：
  - `ProtoReflectionServiceV1` 通过 `InternalServer.SERVER_CONTEXT_KEY` 从 Context 中获取当前 Server 实例
  - 它需要区分 immutable 和 mutable services，并检测 mutable services 的变化
  - `FileDescriptorIndex` 的 BFS 遍历依赖关系和符号注册
  - 所以 Reflection 不是静态文件查询，而是对运行时服务注册的实时索引。

## 必须澄清的误解

1. Health/Reflection/Channelz 不是三个主题，而是 grpc-java 自描述诊断层的三个侧面。
2. Health 不是简单的"服务器是否存活"，而是按 service name 粒度的活性状态，支持 `check()` unary 和 `watch()` 流式推送。
3. Channelz 不是 Prometheus 指标，而是运行时内部结构的树形 API，包含 ChannelTrace 事件日志和 TCP 级诊断。
4. Reflection 不是静态 proto 文件查询，而是通过 `SERVER_CONTEXT_KEY` 自动发现运行时服务注册的实时索引。
5. 这三个服务都不在核心调用链上，但它们暴露的正是核心调用链的状态。

## 文章结构与字数预算

1. 困惑开场：为什么"辅助服务"值得独立成篇——它们不是杂项，而是诊断层（800-1000 字）
2. 最小总图：自描述诊断层的三个侧面（1000-1400 字）
3. Health：`HealthStatusManager` → `HealthServiceImpl` → `statusMap` + `watcher` 模式（2000-2800 字）
4. Channelz：`InternalChannelz` 注册表 → `ManagedChannelImpl`/`ServerImpl` 自动注册 → `ChannelzService`（2000-2800 字）
5. Reflection：`ProtoReflectionServiceV1` → `ServerReflectionIndex` → `FileDescriptorIndex` + `SERVER_CONTEXT_KEY`（1800-2400 字）
6. 三层对比：注册方式、数据来源、暴露方式对比（1000-1400 字）
7. 收网总结：为什么自描述诊断层是完整卷必须补的机制层（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### Health
- `services/src/main/java/io/grpc/protobuf/services/HealthStatusManager.java:34` — `HealthStatusManager` 类定义，管理 health check 服务
- `services/src/main/java/io/grpc/protobuf/services/HealthStatusManager.java:39` — `SERVICE_NAME_ALL_SERVICES = ""` 特殊空字符串代表所有服务
- `services/src/main/java/io/grpc/protobuf/services/HealthStatusManager.java:53` — `getHealthService()` 返回 `BindableService`
- `services/src/main/java/io/grpc/protobuf/services/HealthStatusManager.java:86` — `enterTerminalState()` 在 shutdown 前标记所有服务 NOT_SERVING
- `services/src/main/java/io/grpc/protobuf/services/HealthServiceImpl.java:40` — `HealthServiceImpl` 继承 `HealthGrpc.HealthImplBase`
- `services/src/main/java/io/grpc/protobuf/services/HealthServiceImpl.java:46` — `statusMap = ConcurrentHashMap` 存储 service name → ServingStatus
- `services/src/main/java/io/grpc/protobuf/services/HealthServiceImpl.java:60` — `watchers = HashMap<String, IdentityHashMap<StreamObserver, Boolean>>` 流式 watcher 注册表
- `services/src/main/java/io/grpc/protobuf/services/HealthServiceImpl.java:65` — 默认 `SERVICE_NAME_ALL_SERVICES` → `SERVING`
- `services/src/main/java/io/grpc/protobuf/services/HealthServiceImpl.java:69` — `check()` unary：立即返回当前状态或 NOT_FOUND
- `services/src/main/java/io/grpc/protobuf/services/HealthServiceImpl.java:83` — `watch()` server-streaming：发送当前状态后注册 watcher
- `services/src/main/java/io/grpc/protobuf/services/HealthServiceImpl.java:126` — `setStatus()`：更新状态并通知 watchers（仅在状态变化时）
- `services/src/main/java/io/grpc/protobuf/services/HealthServiceImpl.java:144` — `clearStatus()`：移除状态并通知 watchers SERVICE_UNKNOWN
- `services/src/main/java/io/grpc/protobuf/services/HealthServiceImpl.java:157` — `enterTerminalState()`：所有服务 → NOT_SERVING，阻止后续更新
- `services/src/main/java/io/grpc/protobuf/services/HealthServiceImpl.java:183` — `notifyWatchers()`：遍历 `IdentityHashMap` 逐个推送状态变化

### Channelz
- `api/src/main/java/io/grpc/InternalChannelz.java:48` — `InternalChannelz` 类定义，内部 API
- `api/src/main/java/io/grpc/InternalChannelz.java:50` — `INSTANCE = new InternalChannelz()` 单例
- `api/src/main/java/io/grpc/InternalChannelz.java:52` — `servers = ConcurrentSkipListMap<Long, InternalInstrumented<ServerStats>>`
- `api/src/main/java/io/grpc/InternalChannelz.java:54` — `rootChannels = ConcurrentSkipListMap<Long, InternalInstrumented<ChannelStats>>`
- `api/src/main/java/io/grpc/InternalChannelz.java:56` — `subchannels = ConcurrentMap<Long, InternalInstrumented<ChannelStats>>`
- `api/src/main/java/io/grpc/InternalChannelz.java:59` — `otherSockets = ConcurrentMap<Long, InternalInstrumented<SocketStats>>`（客户端/监听 socket）
- `api/src/main/java/io/grpc/InternalChannelz.java:61` — `perServerSockets = ConcurrentMap<Long, ServerSocketMap>`（服务端 socket）
- `api/src/main/java/io/grpc/InternalChannelz.java:79` — `addServer(InternalInstrumented<ServerStats>)`
- `api/src/main/java/io/grpc/InternalChannelz.java:91` — `addRootChannel(InternalInstrumented<ChannelStats>)`
- `api/src/main/java/io/grpc/InternalChannelz.java:145` — `getRootChannels(fromId, maxPageSize)` 分页查询
- `api/src/main/java/io/grpc/InternalChannelz.java:159` — `getChannel(id)` 单通道查询
- `api/src/main/java/io/grpc/InternalChannelz.java:190` — `getServerSockets(serverId, fromId, maxPageSize)` 服务端 socket 分页
- `api/src/main/java/io/grpc/InternalChannelz.java:369` — `ChannelStats` 数据类（target, state, channelTrace, callsStarted/Succeeded/Failed, subchannels, sockets）
- `api/src/main/java/io/grpc/InternalChannelz.java:487` — `ChannelTrace`（numEventsLogged, creationTimeNanos, events）
- `api/src/main/java/io/grpc/InternalChannelz.java:707` — `SocketStats`（TransportStats, local, remote, socketOptions, security）
- `api/src/main/java/io/grpc/InternalChannelz.java:1055` — `TransportStats`（streamsStarted/Succeeded/Failed, messagesSent/Received, keepAlivesSent, flowControlWindows）
- `core/src/main/java/io/grpc/internal/ServerImpl.java:168` — `channelz.addServer(this)` 在 ServerImpl 构造时注册
- `core/src/main/java/io/grpc/internal/ServerImpl.java:347` — `channelz.removeServerSocket(ServerImpl.this, transport)`
- `core/src/main/java/io/grpc/internal/ServerImpl.java:360` — `channelz.removeServer(this)` 在 shutdown 时注销
- `core/src/main/java/io/grpc/internal/ServerImpl.java:435` — `channelz.addServerSocket(ServerImpl.this, transport)`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:657` — `channelz.addRootChannel(this)` 在 ManagedChannelImpl 构造时注册
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1185` — `channelz.removeRootChannel(this)` 在 shutdown 时注销
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1856` — `channelz.addSubchannel(internalSubchannel)`
- `core/src/main/java/io/grpc/internal/InternalSubchannel.java:281` — `channelz.addClientSocket(transport)`
- `core/src/main/java/io/grpc/internal/InternalSubchannel.java:679` — `channelz.removeClientSocket(transport)`
- `services/src/main/java/io/grpc/protobuf/services/ChannelzService.java:51` — `ChannelzService` 继承 `ChannelzGrpc.ChannelzImplBase`
- `services/src/main/java/io/grpc/protobuf/services/ChannelzService.java:59` — `newInstance(int maxPageSize)` 工厂方法
- `services/src/main/java/io/grpc/protobuf/services/ChannelzService.java:70` — `getTopChannels` RPC
- `services/src/main/java/io/grpc/protobuf/services/ChannelzService.java:89` — `getChannel` RPC
- `services/src/main/java/io/grpc/protobuf/services/ChannelzService.java:116` — `getServers` RPC
- `services/src/main/java/io/grpc/protobuf/services/ChannelzService.java:134` — `getServer` RPC
- `services/src/main/java/io/grpc/protobuf/services/ChannelzService.java:161` — `getSubchannel` RPC
- `services/src/main/java/io/grpc/protobuf/services/ChannelzService.java:188` — `getSocket` RPC
- `services/src/main/java/io/grpc/protobuf/services/ChannelzService.java:212` — `getServerSockets` RPC
- `services/src/main/java/io/grpc/protobuf/services/ChannelzProtoUtil.java:19` — `ChannelzProtoUtil` 内部→proto 转换层

### Reflection
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:65` — `ProtoReflectionServiceV1` 继承 `ServerReflectionGrpc.ServerReflectionImplBase`
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:77` — `newInstance()` 返回 `BindableService`
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:87` — `getRefreshedIndex()` 通过 `InternalServer.SERVER_CONTEXT_KEY.get()` 获取当前 Server
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:89` — `Server server = InternalServer.SERVER_CONTEXT_KEY.get()`
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:93` — 首次创建 `ServerReflectionIndex`
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:98-125` — 检测 mutable services 变化并重建索引
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:129` — `serverReflectionInfo()` 入口，bidi-streaming RPC
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:141` — `ProtoReflectionStreamObserver` 内部类处理请求分发
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:172` — `handleReflectionRequest()` 按请求类型分发
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:217` — `getFileByName()` 按文件名查询
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:227` — `getFileContainingSymbol()` 按符号名查询
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:269` — `listServices()` 列出所有已注册服务
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:296` — `createServerReflectionResponse()` BFS 遍历依赖关系
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:330` — `ServerReflectionIndex` 内部类，分 immutable/mutable 索引
- `services/src/main/java/io/grpc/protobuf/services/ProtoReflectionServiceV1.java:398` — `FileDescriptorIndex` 内部类，构建文件名/符号/扩展名索引
- `api/src/main/java/io/grpc/InternalServer.java:26` — `SERVER_CONTEXT_KEY = Server.SERVER_CONTEXT_KEY`
- `core/src/main/java/io/grpc/internal/ServerImpl.java:156` — `Context.withValue(InternalServer.SERVER_CONTEXT_KEY, ServerImpl.this)` 设置上下文

## 测试证据清单

- `services/src/test/java/io/grpc/protobuf/services/HealthStatusManagerTest.java:75` — `enterTerminalState_check()` 验证 terminal 后 check 返回 NOT_SERVING
- `services/src/test/java/io/grpc/protobuf/services/HealthStatusManagerTest.java:99` — `enterTerminalState_watch()` 验证 terminal 后 watcher 收到 NOT_SERVING
- `services/src/test/java/io/grpc/protobuf/services/HealthStatusManagerTest.java:155` — `defaultIsServing()` 验证默认 SERVICE_NAME_ALL_SERVICES 为 SERVING
- `services/src/test/java/io/grpc/protobuf/services/HealthStatusManagerTest.java:175` — `checkValidStatus()` 验证不同 service 不同状态
- `services/src/test/java/io/grpc/protobuf/services/HealthStatusManagerTest.java:193` — `checkStatusNotFound()` 验证未设置状态返回 NOT_FOUND
- `services/src/test/java/io/grpc/protobuf/services/HealthStatusManagerTest.java:207` — `notFoundForClearedStatus()` 验证 clearStatus 后 check 返回 NOT_FOUND
- `services/src/test/java/io/grpc/protobuf/services/HealthStatusManagerTest.java:222` — `watch()` 验证 watcher 注册和状态变化推送
- `services/src/test/java/io/grpc/protobuf/services/HealthStatusManagerTest.java:276` — `watchRemovedWhenClientCloses()` 验证 Context 取消时 watcher 被移除
- `services/src/test/java/io/grpc/protobuf/services/ChannelzServiceTest.java:57` — `getTopChannels_empty()` 验证空列表
- `services/src/test/java/io/grpc/protobuf/services/ChannelzServiceTest.java:64` — `getTopChannels_onePage()` 验证注册后查询
- `services/src/test/java/io/grpc/protobuf/services/ChannelzServiceTest.java:78` — `getChannel()` 验证 add/remove 前后查询
- `services/src/test/java/io/grpc/protobuf/services/ChannelzServiceTest.java:95` — `getSubchannel()` 验证 subchannel 注册和查询
- `services/src/test/java/io/grpc/protobuf/services/ProtoReflectionServiceTest.java` — 验证 reflection 各查询类型

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讨论的是 grpc-java 的 `services/` 模块内置诊断服务，不展开 OpenTelemetry/gcp-observability/OkHttp/Cronet 等平台变体对这些机制的再包装。
- `InternalChannelz` 标注为 `@Internal`，是 grpc-java 内部 API，不对外暴露（`ChannelzService` 才是对外暴露的 gRPC 服务）。
- `HealthStatusManager` 和 `ProtoReflectionServiceV1` 标注为 `@ExperimentalApi`，API 可能在未来版本变化。
- Health/Reflection 的 protobuf wire format 由 grpc 规范定义，不在本篇展开。

## 与其他篇的边界

### 本篇要讲清

- 三个服务如何与运行时对接（注册方式、数据来源、暴露方式）。
- 三个服务为何构成"自描述诊断层"的统一机制定位。
- Health 的 `check()` / `watch()` 模式和 `statusMap` + `watcher` 机制。
- Channelz 的 `InternalChannelz` 注册表结构和 `ManagedChannelImpl`/`ServerImpl` 的自动注册。
- Reflection 的 `ServerReflectionIndex` / `FileDescriptorIndex` 和 `SERVER_CONTEXT_KEY` 机制。

### 本篇不深讲

- Channelz 的 `ChannelTrace` 事件记录细节（可随生产排障篇展开）。
- TLS/ALTS 安全细节（已有 `CallCredentials` 篇覆盖安全边界）。
- xDS 对这三个服务的包装。
- 生产排障中的具体用法（留给后续生产诊断卷）。
- OpenTelemetry/gcp-observability 等外部监控适配。

## 写作后检查

- [ ] 开篇先抓"辅助服务不是杂项，而是自描述诊断层"，而不是直接讲配置项。
- [ ] 至少展开 3 个失败方案，且包含"Health/Reflection/Channelz 是三个独立主题""Channelz 等价于 Prometheus 指标""Reflection 只是调试工具"。
- [ ] 明确给出"自描述诊断层"的总图，把三个服务统一到同一个机制定位。
- [ ] 不把本篇写成三个独立的使用手册。
- [ ] 每个服务都讲清楚"注册方式""数据来源""暴露方式"三个维度。
- [ ] 删除代码块后，读者仍能复述三个服务的运行时机制和统一定位。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。