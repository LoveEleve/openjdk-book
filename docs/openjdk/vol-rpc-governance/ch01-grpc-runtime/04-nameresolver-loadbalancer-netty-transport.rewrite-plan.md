# gRPC-Java：NameResolver、LoadBalancer 与 Netty Transport — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch01-grpc-runtime`
- 篇：`04 NameResolver、LoadBalancer 与 Netty Transport`
- 对应主题：`G-RPC-4 传输与实例选择桥接层`
- 文章类型：发现/选址/transport 桥接篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：前面三篇已经把客户端调用、服务端调用和横切面协议立住了，但一次 RPC 真正发出去之前，到底是谁把逻辑 target 解析成地址、谁在多个实例间做选择、谁把这次选择继续压到真正的 HTTP/2 transport 上？
- 一句话顿悟：gRPC 并没有把“找人、选人、发出去”混成一层；`NameResolver` 负责把目标名持续解析成地址与配置，`LoadBalancer` 负责把这些结果收束成 `SubchannelPicker` 的选址决策，而 `ManagedChannelImpl` 与 Netty transport 再把这个决策压成真正的 `ClientTransport`/HTTP/2 连接动作。
- 文章边界：本篇重点解释 `NameResolver / LoadBalancer / SubchannelPicker / ManagedChannelImpl / GrpcHttp2ConnectionHandler / NettyClientHandler / NettyServerHandler` 之间的桥接关系；不展开 Dubbo/Commons/Nacos 横向对照，不重讲前三篇客户端/服务端/Context 基线。

## 前置依赖

### HARD

- `vol-rpc-governance/ch01-grpc-runtime/01-stub-channel-clientcall.md`：已经知道调用会走到 `ClientCallImpl` 与 stream。
- `vol-rpc-governance/ch01-grpc-runtime/03-interceptors-context-deadline.md`：已经知道横切面协议怎样挂回调用主线。
- `vol-netty/ch12-http2/04-grpc-and-triple-on-http2.md`：已经知道 gRPC transport 最终落在 HTTP/2 连接主链。

### SOFT

- service config、retry/hedging 只在解析结果和 delayed transport 边界上点到，不展开重试策略专题。
- 健康检查策略和 xDS 只作为 LoadBalancer 扩展背景，不作为本篇主线。

### NAV

- 后续可进入与 Spring Cloud Commons / Nacos / Dubbo Registry 的跨框架对照篇。

## 一句话困惑

一次 RPC 真正发出去之前，gRPC 到底是怎样把“逻辑目标名”一步步变成“某个被选中的具体连接”，并最终压到 Netty HTTP/2 transport 上的？

## 一句话顿悟

gRPC 先让 `NameResolver` 连续产出“地址 + 属性 + config”，再让 `LoadBalancer` 把这些结果快照化成 `SubchannelPicker` 的选址决策；`ManagedChannelImpl` 则负责在 idle、pending call、delayed transport 与真实 transport 之间衔接，最后由 Netty handler 把选中的 stream 落进 HTTP/2 连接主链。

## 读者理解路径

1. 先否定“channel 自己知道连谁”和“负载均衡只是随手挑一个地址”的粗糙理解。
2. 建立最小总图：`target -> NameResolver -> ResolvedAddresses -> LoadBalancer -> SubchannelPicker -> ClientTransport -> Netty HTTP/2 handler`。
3. 解释 `NameResolver` 为什么不是一次性 DNS 查询，而是持续更新的解析协议。
4. 解释 `LoadBalancer` 为什么不直接管理调用，而是快照化成 `SubchannelPicker`。
5. 解释 `ManagedChannelImpl` 为什么要插在中间：它既要处理 idle/pending call，又要衔接 resolver、lb、delayed transport 与真实 transport。
6. 解释 picker 的选择结果怎样真正变成 subchannel / transport / stream。
7. 最后桥到 Netty transport：`GrpcHttp2ConnectionHandler / NettyClientHandler / NettyServerHandler` 不是重新决定“连谁”，而是承接已经选好的连接与 HTTP/2 运行时。

## 失败方案推演

### 失败方案一：channel 自己直接拿 target 去建连接

- 这会跳过：
- 连续地址更新
- 解析错误与 refresh/backoff
- service config 与属性
- 多实例与地址组语义
- 所以 gRPC 必须先有独立的解析协议，而不能让 channel 自己“一步到位”。

### 失败方案二：解析出地址后，随机挑一个就结束

- 这会低估 `LoadBalancer` 的职责。
- 它不仅要挑实例，还要：
- 管 subchannel 生命周期
- 响应连接状态变化
- 在 `IDLE / CONNECTING / READY / TRANSIENT_FAILURE` 之间更新 picker
- 决定何时 refresh name resolution
- 所以负载均衡不是“挑地址函数”，而是持续演化的状态机。

### 失败方案三：picker 直接控制 transport 细节

- 这会把“选人”和“发出去”混成一层。
- gRPC 的选择是：picker 只返回决策快照，`ManagedChannelImpl`/delayed transport/real transport 再把它继续压成 stream 和 HTTP/2 连接动作。
- 这样选址状态机和 transport 运行时才能解耦。

### 失败方案四：Netty handler 负责发现和负载均衡

- 这会把 HTTP/2 transport 写成“连接策略总管”。
- 实际上 Netty handler 承接的是已经选好的连接与 stream 运行时，不负责上游解析与 picker 决策。

## 必须澄清的误解

1. `NameResolver` 不是一次性 DNS 查询，而是连续解析结果流。
2. `LoadBalancer` 不是“挑一个地址”的函数，而是围绕 subchannel/picker 的状态机。
3. `SubchannelPicker` 不是 transport 实现，它只是新的 RPC 到来时的选址快照。
4. `ManagedChannelImpl` 不是薄转发器，它负责把 idle、pending call、resolver、lb、delayed transport 串起来。
5. Netty transport 不负责解析和负载均衡，它负责承接已经完成选择的连接/stream 并进入 HTTP/2 主线。

## 文章结构与字数预算

1. 困惑开场：为什么“找人、选人、发出去”不能混成一层（800-1000 字）
2. 最小总图：从 target 到 HTTP/2 transport 的桥接链（1200-1600 字）
3. `NameResolver`：为什么它是持续解析协议，而不是一次性查地址（1800-2400 字）
4. `LoadBalancer`：为什么它是 subchannel/picker 状态机，而不是选址函数（2200-3000 字）
5. `ManagedChannelImpl`：idle、pending call、resolver、lb、delayed transport 怎样串起来（1800-2400 字）
6. picker 到 transport：一次 pick 怎样真正落成 subchannel/stream（1400-2000 字）
7. Netty transport 桥接：`GrpcHttp2ConnectionHandler / NettyClientHandler / NettyServerHandler` 在这条链上的真正位置（1400-2000 字）
8. 收网总结：gRPC 怎样把发现、选址和 HTTP/2 transport 接成整体（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `api/src/main/java/io/grpc/NameResolver.java:39`
- `api/src/main/java/io/grpc/NameResolver.java:48`
- `api/src/main/java/io/grpc/NameResolver.java:52`
- `api/src/main/java/io/grpc/NameResolver.java:74`
- `api/src/main/java/io/grpc/NameResolver.java:123`
- `api/src/main/java/io/grpc/NameResolver.java:146`
- `api/src/main/java/io/grpc/NameResolver.java:169`
- `api/src/main/java/io/grpc/NameResolver.java:348`
- `api/src/main/java/io/grpc/LoadBalancer.java:37`
- `api/src/main/java/io/grpc/LoadBalancer.java:58`
- `api/src/main/java/io/grpc/LoadBalancer.java:85`
- `api/src/main/java/io/grpc/LoadBalancer.java:188`
- `api/src/main/java/io/grpc/LoadBalancer.java:368`
- `api/src/main/java/io/grpc/LoadBalancer.java:452`
- `api/src/main/java/io/grpc/LoadBalancer.java:470`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:389`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:403`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:414`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:454`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:461`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:582`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:595`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:669`
- `netty/src/main/java/io/grpc/netty/GrpcHttp2ConnectionHandler.java:32`
- `netty/src/main/java/io/grpc/netty/GrpcHttp2ConnectionHandler.java:75`
- `netty/src/main/java/io/grpc/netty/NettyClientHandler.java:120`
- `netty/src/main/java/io/grpc/netty/NettyClientHandler.java:156`
- `netty/src/main/java/io/grpc/netty/NettyClientHandler.java:177`
- `netty/src/main/java/io/grpc/netty/NettyServerHandler.java:159`
- `netty/src/main/java/io/grpc/netty/NettyServerHandler.java:254`

## 测试证据清单

- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:520`：调用在 name resolution/LB/transport ready 之后才真正落到 `mockTransport.newStream()`。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:565`：config selector 可在 pick 前改写调用行为。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3411`：解析结果进入 LB，picker 选择的 subchannel 最终转成 transport/stream，并与 retry/hedging 时序交互。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3835`：`NameResolver.Args` 会传播 defaultPort、proxyDetector、offloadExecutor、自定义参数。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3901`：service config 解析与 LB config 选择的 helper 路径。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplIdlenessTest.java:229`：新 call 会退出 idle 并启动 resolver/LB。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplIdlenessTest.java:282`：delayed transport 会阻止 idleness。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplIdlenessTest.java:472`：OOB transport 不应影响主 channel 的 idleness。
- `core/src/test/java/io/grpc/internal/DnsNameResolverTest.java:1135`：JNDI 使用条件并不是“凡 DNS 必查”，解析策略有明确边界。
- `core/src/test/java/io/grpc/internal/DnsNameResolverTest.java:1208`：service config 解析失败会被转成解析错误。
- `core/src/test/java/io/grpc/internal/PickFirstLeafLoadBalancerTest.java:432`：picker 在 IDLE/CONNECTING/READY 转换中的行为与 `requestConnection()` 触发。
- `core/src/test/java/io/grpc/internal/PickFirstLeafLoadBalancerTest.java:457`：连接断裂时 LB 会 refresh name resolution。
- `core/src/test/java/io/grpc/internal/PickFirstLeafLoadBalancerTest.java:488`：解析结果不变时不会无谓重连。
- `core/src/test/java/io/grpc/internal/PickFirstLeafLoadBalancerTest.java:506`：解析结果变化时会替换 subchannel 并重连。
- `core/src/test/java/io/grpc/internal/PickFirstLeafLoadBalancerTest.java:530`：健康检查/状态监听会影响 picker 输出与连接状态机。

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讨论的是 gRPC Java 内部发现/选址/transport 桥接，不展开 Spring Cloud / Nacos / Dubbo Registry 对照。
- `PickFirstLeafLoadBalancerTest` 等较新实现用于说明状态机与 picker 语义；不把某个具体 LB 策略写成抽象规范。
- Netty handler 只在“transport 如何承接上游选择结果”的边界上出场，不重写 HTTP/2 细节。

## 与其他篇的边界

### 本篇要讲清

- `NameResolver` 怎样把 target 持续解析成地址、属性和 config。
- `LoadBalancer` 怎样把解析结果变成 subchannel/picker 状态机。
- `ManagedChannelImpl` 怎样把 resolver、lb、delayed transport、real transport 串起来。
- 一次 pick 怎样最终落成 `ClientTransport` / `ClientStream`。
- Netty transport 在这条链上承接什么，不承接什么。

### 本篇不深讲

- 具体 Spring / Nacos / Dubbo 发现机制对照。
- 具体 LB 策略实现大全。
- retry/hedging 的独立专题。
- Netty HTTP/2 主链细节重讲。

## 写作后检查

- [ ] 开篇先抓“找人、选人、发出去”为什么不能混成一层。
- [ ] 至少展开 3 个失败方案，且包含“解析不是一次性 DNS”“LB 不是选址函数”。
- [ ] 明确给出 `NameResolver -> LoadBalancer -> SubchannelPicker -> transport` 总图。
- [ ] 不把本篇写成 NameResolver/LoadBalancer API 手册。
- [ ] 不把第四篇扩成跨框架发现系统总览。
- [ ] 删除代码块后，读者仍能复述 gRPC 如何把发现、选址和 HTTP/2 transport 接成整体。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。
