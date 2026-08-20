# grpc-java xDS 客户端：从 Bootstrap/ADS 到动态路由与负载均衡 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `XdsNameResolverProvider` 注册 `xds` scheme 并创建 `XdsNameResolver`，证据：`xds/src/main/java/io/grpc/xds/XdsNameResolverProvider.java:37`、`:80`。
2. `GrpcBootstrapperImpl` 负责读取 bootstrap 配置并按环境变量/系统属性优先级选择来源，证据：`xds/src/main/java/io/grpc/xds/GrpcBootstrapperImpl.java:65`。
3. `Bootstrapper` 的配置模型包含 server、node、authority、credential、certificate provider 和 listener resource name template，证据：`xds/src/main/java/io/grpc/xds/client/Bootstrapper.java:32`、`:144`。
4. `XdsClient` 抽象暴露的是资源 watch API，而不是一次性 `getConfig()`，证据：`xds/src/main/java/io/grpc/xds/client/XdsClient.java:44`。
5. `XdsClientImpl` 首次 watch 时创建 subscriber / ControlPlaneClient，收到 response 后处理资源、ACK/NACK 和 watcher 通知，证据：`XdsClientImpl.java:251`、`:559`、`:1011`。
6. `ControlPlaneClient` 管理 version、nonce、subscription、ADS stream、response 处理、backoff/reconnect，证据：`ControlPlaneClient.java:55`、`:143`、`:333`、`:371`、`:424`、`:475`。
7. `XdsDependencyManager` 从 LDS 启动 RDS/CDS/EDS 依赖链，并把资源组装成 `XdsConfig`，证据：`XdsDependencyManager.java:60`、`:119`、`:192`。
8. `XdsConfig` 是 listener、route、virtual host、cluster、endpoint/aggregate cluster 等数据面的中间表示，证据：`XdsConfig.java:35`、`:104`。
9. `XdsNameResolver` 生成 `cluster_manager_experimental` service config，并创建 per-RPC `InternalConfigSelector` 做 route/cluster 选择，证据：`XdsNameResolver.java:314`、`:412`。
10. `ClusterManagerLoadBalancer` 根据 CallOptions 中的 cluster name 选择 child picker，`CdsLoadBalancer2` 把 CDS cluster 翻译成 EDS/aggregate/priority 等下游 LB 配置，证据：`ClusterManagerLoadBalancer.java:42`、`:140`、`CdsLoadBalancer2.java:76`、`:104`。

### 测试证据已核对

1. `XdsNameResolverTest` — resolver、route、cluster selection 主线。
2. `XdsDependencyManagerTest` — LDS/RDS/CDS/EDS 资源依赖编排。
3. `XdsClientImplTest` — watch、ACK/NACK、fallback、resource 更新。
4. `ControlPlaneClientTest` — ADS stream 生命周期、response、重连。
5. `ClusterManagerLoadBalancerTest` — cluster_manager child picker。
6. `CdsLoadBalancer2Test` — CDS 到 child LB 配置转换。

### 深审发现

1. **高风险：容易把 xDS 写成 resolver 使用手册。** 当前正文已统一到“控制面资源 → grpc-java 数据面模型”的翻译链。  
2. **高风险：容易把 LDS/RDS/CDS/EDS 写成平行资源清单。** 当前正文已用资源树和 `XdsDependencyManager` 解释依赖一致性。  
3. **中风险：容易忽略 per-RPC ConfigSelector。** 当前正文已强调 resolver 更新规则、每次 RPC 执行规则。  
4. **中风险：容易把 ADS response 到达等同于配置已经生效。** 当前正文已补充校验、依赖补齐、XdsConfig、resolver、child LB 多阶段转换。  
5. **低风险：容易把 xDS 看成替代普通 LB/transport 的独立数据面。** 当前正文已收束到 cluster_manager/cds/child LB/subchannel/transport 原有主线。

## 第二轮：因果审

- bootstrap 必须先确定 control plane、node 和 authority，否则 xDS 客户端没有稳定的配置来源：✅  
- xDS client 必须以 resource watch/ADS 持续同步，而不是启动时只拉一份配置，否则动态路由无法生效：✅  
- LDS/RDS/CDS/EDS 必须由依赖管理器编排，否则半成品资源会直接污染数据面：✅  
- resolver 必须输出 service config 和 ConfigSelector，而不是只返回地址，否则 route/cluster/retry/timeout 无法进入 grpc-java：✅  
- ConfigSelector 必须参与每次 RPC，否则 weighted cluster、header/path route 等动态规则不会真正执行：✅  
- cluster_manager/cds 必须继续接入普通 child LB，否则 xDS 资源无法落到 subchannel/picker/transport：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → 最小总图 → bootstrap → XdsClient/ADS → 资源依赖 → XdsNameResolver/ConfigSelector → cluster_manager/CDS/child LB → 误解澄清 → 收网总结”推进，没有退化成 xDS 目录导览。

失败方案已覆盖：
- xDS 就是高级版名字解析  
- ADS response 直接交给 LB  
- route 只在 resolver 阶段算一次  

每一层拆解均包含：控制面动机 → grpc-java coordinator → 数据面转换 → file:line 证据，符合高阶机制篇要求。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- `xds:///service` 如何进入 bootstrap/ADS。
- LDS/RDS/CDS/EDS 如何形成依赖资源树。
- `XdsDependencyManager` / `XdsConfig` 的中间接缝。
- `XdsNameResolver` 如何生成 service config 与 `InternalConfigSelector`。
- `cluster_manager` / `cds` / child LB 如何落回普通 transport 主线。

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未扩入 xDS 服务端 `XdsServerWrapper`、filter chain、TLS。✅  
- 未展开 RBAC、ext_authz、ext_proc、fault injection 的内部实现。✅  
- 未展开 ORCA/LRS、locality、ring hash、outlier detection 的算法细节。✅  
- 未把 VHDS 写成当前实现中的完整独立资源主线。✅  
- 重点仍压在客户端 bootstrap/ADS/resource dependency/resolver/LB 主链路，边界收得住。✅

## 第六轮：依赖审

- 已承接 ch01/04：普通 resolver/LB/transport 主线已知，本篇解释 xDS 如何重写这条链。✅  
- 已承接 ch03/01：service config/retry/hedging 如何进入运行时已知，本篇解释 xDS 如何动态生成配置。✅  
- 已承接 ch05/02：picker/subchannel/transport 最终落点已知，本篇补充它们之前的 xDS 控制面层。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：使用少量文字图，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验 `XdsNameResolverProvider`、`GrpcBootstrapperImpl`、`XdsClientImpl`、`ControlPlaneClient`、`XdsDependencyManager`、`XdsConfig`、`XdsNameResolver`、`ClusterManagerLoadBalancer`、`CdsLoadBalancer2`。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数（不含代码块与空白行）：约 `16,663`。  
- 目标定位：xDS 客户端高阶机制篇，篇幅与结构均满足要求。✅

## 结论

当前三件套的目标明确：这一篇应把 xDS 客户端从“高级 resolver”提升到“控制面持续重写 grpc-java 调用主线”的位置，讲清 bootstrap/ADS、LDS/RDS/CDS/EDS 资源树、`XdsDependencyManager`/`XdsConfig`、`InternalConfigSelector` 以及 cluster_manager/cds/child LB 如何共同把控制面配置落到每次 RPC 与最终 transport。