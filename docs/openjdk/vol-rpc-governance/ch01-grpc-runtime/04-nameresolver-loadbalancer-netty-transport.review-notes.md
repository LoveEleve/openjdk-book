# gRPC-Java：NameResolver、LoadBalancer 与 Netty Transport — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `NameResolver` 当前不是一次性解析器，而是可持续产出地址更新的可插拔协议组件，证据：`api/src/main/java/io/grpc/NameResolver.java:39`、`:45`、`:48`。  
2. `NameResolver` 当前明确要求有副作用的方法在同一个 `SynchronizationContext` 上串行调用，但不得阻塞；耗时工作应 offload，证据：`api/src/main/java/io/grpc/NameResolver.java:52`。  
3. `NameResolver.Factory` 当前按 URI scheme 决定能否解析目标，`Args` 则提供 defaultPort、proxyDetector、serviceConfigParser、scheduledExecutor、offloadExecutor、custom args 等完整运行时支撑，证据：`api/src/main/java/io/grpc/NameResolver.java:149`、`:169`、`:348`。  
4. `LoadBalancer` 当前不是选址函数，而是以 `LoadBalancer`/`SubchannelPicker`/`Factory` 三层结构组织的状态机，证据：`api/src/main/java/io/grpc/LoadBalancer.java:37`。  
5. `LoadBalancer` 当前强调所有方法都运行在同一个 `SynchronizationContext` 上，并采用 picker snapshot 模式避免与 LB 可变状态纠缠，证据：`api/src/main/java/io/grpc/LoadBalancer.java:58`、`:85`。  
6. `LoadBalancer.acceptResolvedAddresses()` 当前接收的不只是地址列表，而是 `ResolvedAddresses`（地址 + attributes + lb config），并定义了空地址和 name resolution error 的处理边界，证据：`api/src/main/java/io/grpc/LoadBalancer.java:188`、`:368`。  
7. `SubchannelPicker` 当前负责每个新 RPC 的 pick 决策快照，而不是 transport 实现本身，证据：`api/src/main/java/io/grpc/LoadBalancer.java:452`、`:470`。  
8. `ManagedChannelImpl.exitIdleMode()` 当前会真正创建 LB、启动 resolver，并把 channel 状态切到 CONNECTING，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:389`、`:403`、`:414`。  
9. `ManagedChannelImpl.refreshNameResolution()` 当前说明 resolver 生命周期受 channel/syncContext 统管，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:454`。  
10. `ManagedChannelImpl.ChannelStreamProvider.newStream()` 当前把调用在现有 Context 下压给 delayed transport/RetriableStream，说明 picker 结果与真实 transport 下沉之间仍隔着 channel 桥接层，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:461`。  
11. `ManagedChannelImpl` 构造器当前会集中装配 `NameResolver.Args`，并通过 `getNameResolver(...)` 创建 resolver、包上 `RetryingNameResolver` 和可选 authority override，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:582`、`:595`、`:669`。  
12. `GrpcHttp2ConnectionHandler` 当前只是 gRPC 对 `Http2ConnectionHandler` 的 wrapper，不负责上游解析与选址，证据：`netty/src/main/java/io/grpc/netty/GrpcHttp2ConnectionHandler.java:32`、`:75`。  
13. `NettyClientHandler` 当前关心的是 authority、keepalive、in-use state、flow control、buffering encoder 和 HTTP/2 连接主链，而不是 resolver/LB 状态机，证据：`netty/src/main/java/io/grpc/netty/NettyClientHandler.java:120`、`:156`、`:177`。  
14. `NettyServerHandler` 当前服务端 transport 组装的是 connection、flow controller、settings、keepalive enforcement 等 HTTP/2 运行时结构，同样不参与客户端侧发现/选址，证据：`netty/src/main/java/io/grpc/netty/NettyServerHandler.java:159`、`:254`。

### 测试证据已核对

1. `ManagedChannelImplTest.startCallBeforeNameResolution()` 当前证明调用可以先创建，resolver/LB/transport ready 之后才真正落到 `mockTransport.newStream()`，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:520`。  
2. `ManagedChannelImplTest.newCallWithConfigSelector()` 当前证明 config selector 能在 pick 前改写调用行为，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:565`。  
3. `ManagedChannelImplTest` 中 retry/hedging 相关用例当前证明解析结果会先进入 LB，picker 选择的 subchannel 再转成 transport/stream，并与后续重试/hedging 时序交互，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3411`。  
4. `ManagedChannelImplTest.nameResolverArgsPropagation()` 当前证明 defaultPort、proxyDetector、offloadExecutor、自定义 args 会真实传播进 `NameResolver.Args`，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3835`。  
5. `ManagedChannelImplTest.nameResolverHelper_*` 与 `disableServiceConfigLookUp_*` 当前证明 service config 解析、LB config 选择与 default config 回退都发生在这条桥里，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3901`。  
6. `ManagedChannelImplIdlenessTest.newCallExitsIdleness()` 当前证明新 call 会退出 idle 并启动 resolver/LB，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplIdlenessTest.java:229`。  
7. `ManagedChannelImplIdlenessTest.delayedTransportHoldsOffIdleness()` 当前证明 delayed transport 上的 pending RPC 会阻止 channel 进入 idle，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplIdlenessTest.java:282`。  
8. `ManagedChannelImplIdlenessTest.oobTransportDoesNotAffectIdleness()` 当前证明 OOB transport 不应影响主 channel 的 idleness，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplIdlenessTest.java:472`。  
9. `DnsNameResolverTest.shouldUseJndi_*` 当前证明 DNS/JNDI 解析策略存在明确 host 类型边界，并非“凡 DNS 必查”，证据：`core/src/test/java/io/grpc/internal/DnsNameResolverTest.java:1135`。  
10. `DnsNameResolverTest.parseServiceConfig_capturesParseError()` 当前证明 TXT/service config 解析失败会转成解析错误，证据：`core/src/test/java/io/grpc/internal/DnsNameResolverTest.java:1208`。  
11. `PickFirstLeafLoadBalancerTest` 当前证明 picker 在 `IDLE/CONNECTING/READY/TRANSIENT_FAILURE` 之间如何 requestConnection、refreshNameResolution、替换 subchannel 与输出新的 pick 结果，证据：`core/src/test/java/io/grpc/internal/PickFirstLeafLoadBalancerTest.java:432`、`:457`、`:488`、`:506`、`:530`。

### 深审发现

1. **高风险：容易把 NameResolver 写成一次性 DNS 查询。** 当前正文已提升到“持续解析结果流”的协议层。  
2. **高风险：容易把 LoadBalancer 写成选址函数。** 当前正文已压回 subchannel/picker 状态机。  
3. **中风险：容易把 picker 误写成 transport 本体。** 当前正文已明确 picker 只是 pick 快照出口。  
4. **中风险：容易低估 `ManagedChannelImpl` 的桥接角色。** 当前正文已强调 idle、pending call、delayed transport、resolver/lb 装配。  
5. **中风险：容易让 Netty handler 抢走上游发现/选址主线。** 当前正文已把它收在“承接已选好的 transport/stream 与 HTTP/2 主链”这一层，并补强了 `NettyServerHandler` 在 client/server 双侧共同钉边界的作用。  
6. **低风险：容易顺手扩成 Spring/Nacos/Dubbo 的发现系统总览。** 当前正文边界收在 gRPC 自身桥接协议上。

## 第二轮：因果审

- 逻辑 target 必须先被持续翻译成地址/属性/config 结果流，否则后面的选址状态机无处接起：✅  
- 解析结果不能直接喂给 transport，必须先经过 LB 吸收并快照化成 picker：✅  
- picker 只负责每个新 RPC 的决策快照，不应直接接管 transport 生命周期：✅  
- `ManagedChannelImpl` 必须站在中间统一调度 idle、resolver、lb、delayed transport，否则发现/选址与调用主线会脱节：✅  
- Netty transport 只承接已选好的连接和 stream，不负责上游发现/选址：✅

## 第三轮：结构审

正文结构按“困惑 -> 失败方案 -> 最小总图 -> NameResolver -> LoadBalancer -> ManagedChannelImpl -> picker 到 transport -> Netty bridge -> 收网”推进，没有退化成 API 手册或测试摘要。✅

失败方案已覆盖：
- channel 自己拿 target 去建连接  
- 解析结果出来后随便挑一个就结束  
- picker 直接控制 transport 细节  
- Netty handler 负责发现和负载均衡  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `NameResolver` 是持续解析协议  
- `LoadBalancer` 是 subchannel/picker 状态机  
- `ManagedChannelImpl` 是 resolver/lb/delayed transport 的桥接中枢  
- picker 结果要继续压成 transport/stream  
- Netty handler 承接的是已选好的连接与 HTTP/2 运行时  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开 Spring Cloud/Nacos/Dubbo 的发现系统对照。✅  
- 未把第四篇写成 LB 策略大全。✅  
- 未重讲前三篇客户端/服务端/横切面主线。✅  
- 未重写 Netty HTTP/2 细节，只在 transport 承接位置点到。✅  
- 重点仍压在发现、选址与 transport 桥接协议，边界收得住。✅

## 第六轮：依赖审

- 已承接第一篇客户端主线：resolver/lb/transport 桥正好补上“调用真正发出去之前”的一段空白。✅  
- 已承接第三篇横切面主线：Context/Deadline 仍会沿这条桥继续下沉到 delayed transport / real transport。✅  
- 以整卷顺序看，第四篇也自然承接了第二篇服务端篇：服务端 handler 在本篇中的价值，是帮助读者确认 transport 双侧都只承接已到达的连接/stream，不再回头参与发现与选址。✅  
- `ManagedChannelImplTest`、`ManagedChannelImplIdlenessTest`、`DnsNameResolverTest`、`PickFirstLeafLoadBalancerTest` 的组合足以支撑“发现/选址/transport 是三段不同协议”的论断。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：仅使用文字图代码块，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验实现或测试。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数：约 `29,215`。  
- 目标定位：重大桥接篇，满足篇幅要求。✅

## 结论

当前三件套的目标明确：第四篇应把 `NameResolver -> LoadBalancer -> SubchannelPicker -> ManagedChannelImpl -> Netty transport` 这条桥接主线立住，并解释 gRPC 怎样把“找人、选人、发出去”拆成三段不同协议。只要正文按这个 review 结论收口，它就能成为后续跨框架发现/路由机制对照的稳定基准篇。