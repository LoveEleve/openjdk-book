# Dubbo：Directory、Router、LoadBalance、Cluster consumer 流量主线 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch06-dubbo-runtime`
- 篇：`03 Directory、Router、LoadBalance、Cluster consumer 流量主线`
- 对应主题：`D-MAIN-3 Consumer Traffic Spine`
- 文章类型：主干运行时核心机制篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：第二篇已经把 `Invoker / Protocol / Exporter / Proxy / Filter` 这条窄腰立住了，但对 consumer 而言，真正困难的问题还在后面：`ReferenceConfig` 最终拿到的不是一个单点 invoker，而往往是一个 `ClusterInvoker`。那么 provider 列表怎么进入 consumer？路由在哪一层做？负载均衡在哪一层做？failover / failfast / forking / broadcast 为什么会让同一次调用呈现完全不同的语义？
- 一句话顿悟：Dubbo consumer 侧真正的运行主线不是“拿到一个 invoker 就调用”，而是：`Directory` 持有动态 provider 视图，`RouterChain` 把这次 invocation 下不该参与的 invoker 剪掉，`LoadBalance` 从剩余候选中挑一个，`ClusterInvoker` 再决定是打一台、重试别台、并发打多台，还是广播给全部；注册中心和服务发现只是上游数据源，真正把“地址变化”变成“可调用流量语义”的，是 `Directory -> Router -> LoadBalance -> ClusterInvoker` 这条链。
- 文章边界：本篇重点讲 consumer 侧流量选择主线：`RegistryProtocol.refer()`、`DynamicDirectory/RegistryDirectory`、`RouterChain`、`LoadBalance`、`AbstractClusterInvoker`、以及 failover/failfast/forking/broadcast 四种 cluster 语义；不深入具体 registry 实现、SPI 生成细节，也不深入 remoting/network/request-response 细节。

## 前置依赖

### HARD

- `ch06-dubbo-runtime/01-serviceconfig-referenceconfig-export-refer.md`：已经知道 `ReferenceConfig` 最终通过 registry / protocol 拿到 invoker。
- `ch06-dubbo-runtime/02-invoker-protocol-exporter-proxy-filter.md`：已经知道 `Invoker` 是 Dubbo 的窄腰，consumer 拿到的是 `ClusterInvoker` 风格的 invoker。

### SOFT

- 不要求先懂 registry 内部实现。
- 不要求先懂 remoting 或具体网络协议。

### NAV

- 后续可接：`Remoting、Exchange、Dispatcher 与网络/线程派发`
- 后续可接：`ExtensionLoader、Adaptive 与 Dubbo SPI 机制`
- 后续可接：生产诊断篇：cluster / routing / registry 排障

## 一句话困惑

consumer 拿到一个远程代理之后，Dubbo 是怎么从一组 provider 中选出这一次真正要调用的那个目标的？路由、负载均衡、失败重试各在哪一层起作用？

## 一句话顿悟

Dubbo consumer 的真正主线是：`Directory` 维护“现在有哪些 invoker 可用”的动态视图，`RouterChain` 根据这次 invocation 裁掉不该参与的候选，`LoadBalance` 再从剩余候选里挑一个，而 `ClusterInvoker` 决定如果这个 invoker 失败了，是立即抛错、换一台重试、并发打多台，还是广播给全部；所以 Registry/ServiceDiscovery 只是“喂数据”的上游，真正把“地址列表”变成“调用语义”的，是这四层组合。

## 读者理解路径

1. 先否定“从 registry 拉到 provider 列表就结束了”的直觉。
2. 建立最小总图：`RegistryProtocol.refer -> DynamicDirectory -> RouterChain -> LoadBalance -> ClusterInvoker`。
3. 解释 `Directory` 为什么不是 registry client，而是动态 invoker 视图。
4. 解释 `Router` 为什么是裁剪集合，不是挑一台。
5. 解释 `LoadBalance` 为什么只负责“从候选中选一个”，不负责重试和容错。
6. 解释 `Cluster` 为什么真正定义了 failover/failfast/forking/broadcast 的调用语义。
7. 解释 provider 列表变更如何通过 `RegistryDirectory.notify()`、`refreshInvoker()`、`RouterChain.setInvokers()` 进入 live runtime。
8. 收束到：consumer 侧并不是“一个 invoker 调一次”，而是“多 provider 视图 -> 路由裁剪 -> 单点选择 -> 失败语义”。

## 失败方案推演

### 失败方案一：从 registry 拿到 provider 列表就结束了

- 这会把 registry 误当作 consumer 主线的终点。
- 实际上 registry 只负责把地址和配置变化推送给 Directory；调用时真正参与的是路由后的 invoker 集合、LB 选择和 cluster 容错语义。
- 所以 provider 列表只是输入，不是最终调用主线。

### 失败方案二：Router 就是在多个 provider 里选一个

- 这会把 Router 和 LoadBalance 混成一层。
- Router 负责“删掉谁不该参与”，LoadBalance 负责“从剩下的人里选谁”。
- 如果把二者混为一谈，就无法理解为什么一个请求可能在路由之后只剩 1 个候选，也无法理解为什么 sticky/reselect 属于 cluster 而不是 router。

### 失败方案三：failover 就是在原始 provider 列表里换一台重试

- 实际源码不是在一个静态列表里简单轮换。
- failover 每轮失败后会重新 `list(invocation)`，重新获取当前 routed invokers，这样才能吸收 registry 更新、地址变化、router 规则变化。
- 所以 failover 的 retry 是动态视图上的重试，不是静态列表上的 for-loop。

## 必须澄清的误解

1. `Directory` 不是 registry client 本身，而是 consumer 侧的动态 invoker 视图。
2. `Directory.list()` 返回的不是原始 provider 全量，而是经过 routing 之后的候选集。
3. `Router` 负责过滤/分流，不负责最终单点选择。
4. `LoadBalance` 负责从候选中选一个，不负责重试、广播、并发。
5. `Cluster` 才真正决定“失败后怎么办”。

## 文章结构与字数预算

1. 困惑开场：拿到远程代理之后，为什么还没结束（800-1000 字）
2. 最小总图：Directory -> RouterChain -> LoadBalance -> ClusterInvoker（1000-1400 字）
3. `Directory`：动态 invoker 视图（1400-2000 字）
4. `RouterChain`：先删候选，再谈选择（1200-1800 字）
5. `LoadBalance`：只做单点选择（1200-1600 字）
6. `ClusterInvoker`：真正决定 failover/failfast/forking/broadcast（1800-2400 字）
7. live 更新：registry notify -> refreshInvoker -> setInvokers（1400-2000 字）
8. 收网总结：调用语义不是“打一台”，而是“怎么选、怎么失败”（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### directory / router chain / loadbalance / cluster
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/Directory.java:35` — `Directory` 定义
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/Router.java:35` — `Router` 定义
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/LoadBalance.java:37` — `LoadBalance` 定义
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/Cluster.java:40` — `Cluster.join()`
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/ClusterInvoker.java:23` — `ClusterInvoker` 定位

### main runtime chain
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:647` — `doCreateInvoker()`
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:667` — `directory.subscribe(...)`
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:669` — `cluster.join(directory, true)`
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/AbstractClusterInvoker.java:345` — consumer 调用主入口 `invoke()`
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/AbstractClusterInvoker.java:355` — `list(invocation)`
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/AbstractClusterInvoker.java:466` — `initLoadBalance()`
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/AbstractClusterInvoker.java:155` — `select(...)`

### live updates
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/DynamicDirectory.java:184` — subscribe
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryDirectory.java:201` — notify 入口
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryDirectory.java:257` — `refreshOverrideAndInvoker(...)`
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryDirectory.java:278` — forbid / EMPTY_PROTOCOL 分支
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryDirectory.java:315` — URL 去重与 reuse cache
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryDirectory.java:452` — `toInvokers(...)`
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryDirectory.java:363` — `refreshRouter(... setInvokers ...)`
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/RouterChain.java:128` — main/backup 双链切换

### cluster semantics
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/FailoverClusterInvoker.java:68` — failover retry loop
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/FailfastClusterInvoker.java:46` — failfast single shot
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/ForkingClusterInvoker.java:93` — forking parallel invoke
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/BroadcastClusterInvoker.java:76` — broadcast all invoke

## 测试证据清单

- `dubbo-cluster/src/test/java/org/apache/dubbo/rpc/cluster/support/FailoverClusterInvokerTest.java:102` — failover 重试与切换成功
- `dubbo-cluster/src/test/java/org/apache/dubbo/rpc/cluster/support/FailoverClusterInvokerTest.java:270` — retry 前重新 list 吸收目录更新
- `dubbo-cluster/src/test/java/org/apache/dubbo/rpc/cluster/support/FailfastClusterInvokerTest.java:81` — failfast 一次即抛
- `dubbo-cluster/src/test/java/org/apache/dubbo/rpc/cluster/support/BroadCastClusterInvokerTest.java:74` — broadcast 默认调用全部
- `dubbo-cluster/src/test/java/org/apache/dubbo/rpc/cluster/support/BroadCastClusterInvokerTest.java:100` — broadcast 失败阈值
- `dubbo-rpc/dubbo-cluster/src/test/java/org/apache/dubbo/rpc/cluster/filter/DefaultFilterChainBuilderTest.java`（如需要对比 filter 与 cluster 层边界）

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇聚焦 consumer 流量主线，不展开 registry 底层实现与协议细节。
- live 更新讨论以 `RegistryDirectory` / `DynamicDirectory` 为主，不展开 service-discovery migration 细节。
- loadbalance 只作为边界说明，不做算法对比专章。

## 与其他篇的边界

### 本篇要讲清

- `Directory` / `Router` / `LoadBalance` / `Cluster` 四层职责。
- live invoker 列表如何从 registry 变化流入运行时。
- failover / failfast / forking / broadcast 四类 cluster 语义。
- consumer 调用主线为什么不是“拿到一个 invoker 就结束了”。

### 本篇不深讲

- registry 实现细节和服务发现迁移。
- remoting / exchange / codec / dispatcher。
- Triple / Dubbo2 具体协议细节。
- SPI/adaptive 装配原理。

## 写作后检查

- [ ] 开篇先抓“拿到远程代理之后为什么还没结束”，而不是直接讲 Directory 接口。
- [ ] 至少展开 3 个失败方案，且包含“Router 负责选一个”“failover 是静态列表轮换”。
- [ ] 明确给出 consumer 运行总图。
- [ ] 不把本篇写成接口清单。
- [ ] 每个 live 更新和 cluster 语义结论都落到具体 file:line。
- [ ] 删除代码块后，读者仍能复述 consumer 主线的四层职责和 failover/failfast 差异。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。