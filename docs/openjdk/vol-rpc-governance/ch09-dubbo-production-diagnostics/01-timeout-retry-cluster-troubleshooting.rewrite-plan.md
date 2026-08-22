# Dubbo：Timeout、Retry 与 Cluster 线上排障 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch09-dubbo-production-diagnostics`
- 篇：`01 Timeout、Retry 与 Cluster 线上排障`
- 对应主题：`D-PROD-1 Timeout / Retry / Cluster Troubleshooting`
- 文章类型：生产诊断主线篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：Dubbo 线上失败最难判的不是“报错了”，而是“为什么会以这种方式报错”。同样一个 `RpcException.TIMEOUT_EXCEPTION`，有时是 consumer 侧发送/等待超时，有时是 provider 端处理太慢；同样一个失败，有时会被 failover 放大成多次调用，有时 failfast 一次就结束，有时 forking 会并发打多台，有时 broadcast 会把错误拖到最后才抛。读者真正困惑的是：这些差异到底是状态码不同，还是 cluster 语义不同，还是 registry/router/configurator 在放大现象？
- 一句话顿悟：Dubbo 线上调用失败不是“一个错误码代表一个原因”，而是三层共同决定的：上游 `Directory/Router` 决定当前还能打谁，`ClusterInvoker` 决定失败后是否重试/并发/广播，remoting 的 `DefaultFuture` 决定超时究竟归因于 client-side 发送阶段还是 server-side 等待阶段；所以排障必须先区分“候选集出了什么问题”“cluster 语义允许做几次尝试”“timeout 到底发生在发送前还是等待后”。
- 文章边界：本篇重点讲 timeout 的来源与文本差异、failover/failfast/forking/broadcast 四种 cluster 语义、registry/router/configurator 如何改变失败形态，以及如何从最终异常回推真正来源；不展开具体网络层细节（remoting 篇已覆盖），不展开 metadata / config-center 的细节，只在需要时点到它们如何放大症状。

## 前置依赖

### HARD

- `ch06-dubbo-runtime/03-directory-router-loadbalance-cluster.md`
- `ch06-dubbo-runtime/04-remoting-exchange-dispatcher-network.md`
- `ch08-dubbo-control-plane/01-registryprotocol-registrydirectory-address-update.md`
- `ch08-dubbo-control-plane/03-config-center-dynamic-override.md`

### SOFT

- 不要求先懂具体 registry vendor。
- 不要求先懂全部路由算法。

### NAV

- 后续可接：Dubbo 生产排障中的 registry/config/metadata 失配专题。
- 后续可接：线程池 / 队列堆积 / provider 假死专题。

## 一句话困惑

为什么 Dubbo 里同样一个失败，有时表现成 consumer timeout，有时像 provider timeout，有时会被重试放大成多次请求，有时又一枪就停？

## 一句话顿悟

线上判因要拆三层：先看 `Directory/Router` 这次给了多少候选、是不是已经被裁空，再看 `ClusterInvoker` 当前采用的是 failover / failfast / forking / broadcast 哪种失败语义，最后看 `DefaultFuture` 的 timeout 文本究竟是在 client-side 发送阶段超时，还是在 server-side 响应等待阶段超时。最终 `RpcException` 只是结果，不是全部原因。

## 读者理解路径

1. 先否定“看异常码就能知道原因”的直觉。
2. 建立最小总图：候选集层 -> cluster 语义层 -> remoting timeout 层。
3. 解释 `NO_INVOKER_AVAILABLE_AFTER_FILTER` 与 `FORBIDDEN_EXCEPTION` 的差别。
4. 解释 consumer-side timeout 与 server-side timeout 都如何映射成 `RpcException.TIMEOUT_EXCEPTION`。
5. 解释 failover / failfast / forking / broadcast 的运行语义差异。
6. 解释 registry/router/configurator 的变化如何在不改业务代码的情况下改变失败形态。
7. 收束到：排障不能只看“报了什么错”，而要问“候选集是什么、cluster 会怎么做、timeout 文本说了什么”。

## 失败方案推演

### 失败方案一：最终异常码就等于最初来源

- `RpcException.TIMEOUT_EXCEPTION` 可能来自 client-side sending timeout，也可能来自 server-side waiting timeout。
- `NO_INVOKER_AVAILABLE_AFTER_FILTER` 可能是 provider 真没了，也可能是 router 把它们都裁没了。
- 所以最终码不是原始事实，而是运行链收束结果。

### 失败方案二：Failover 只是“静态列表换一台再试”

- Dubbo failover 每次 retry 前会重新 `list(invocation)`，拿到的是新的 routed invoker 视图。
- 所以它可能在 registry 更新、router 变化、本地可用性变化之后，重试到完全不同的 provider 集合。
- 它是动态视图上的重试，不是静态 for-loop。

### 失败方案三：只要 provider 地址没变，失败形态就不会变

- router 和 configurator 变化就足以改变候选集或 timeout/loadbalance/retries 语义。
- 所以不改代码、不改地址，consumer 也可能从“偶发成功”变成“一直 no provider”或“timeout 变短后连续失败”。

## 必须澄清的误解

1. `RpcException.TIMEOUT_EXCEPTION` 不是单一来源，要看 timeout 文本和触发路径。
2. `NO_INVOKER_AVAILABLE_AFTER_FILTER` 不等于 registry 没 provider，router 也可能把候选集裁空。
3. failover 不是静态列表轮换，而是动态重新 list。
4. forking 和 broadcast 会天然放大一次业务调用的后端负载。
5. 配置变化和地址变化都可能改写失败形态。

## 文章结构与字数预算

1. 困惑开场：同一个错误为什么长得完全不同（800-1000 字）
2. 最小总图：候选集层 / cluster 语义层 / remoting timeout 层（1000-1400 字）
3. `Directory/Router` 侧的“无可用 provider”错误（1400-2000 字）
4. timeout 判因：consumer-side vs server-side（1600-2200 字）
5. failover / failfast / forking / broadcast 的语义差异（2000-2600 字）
6. registry/router/configurator 如何放大失败（1400-2000 字）
7. 排障四问法（800-1200 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/AbstractClusterInvoker.java:345` — cluster invoke 入口
- `AbstractClusterInvoker.java:355` — `list(invocation)`
- `AbstractClusterInvoker.java:386` — `NO_INVOKER_AVAILABLE_AFTER_FILTER`
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/DynamicDirectory.java:197` — `FORBIDDEN_EXCEPTION`
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/FailoverClusterInvoker.java:68` — failover retry loop
- `FailoverClusterInvoker.java:71` — retry 前重新 list
- `FailoverClusterInvoker.java:129` — `retries + 1`
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/FailfastClusterInvoker.java:46` — failfast single shot
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/ForkingClusterInvoker.java:76` — forks selection
- `ForkingClusterInvoker.java:115` — first success / timeout wait
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/support/BroadcastClusterInvoker.java:64` — fail percent
- `BroadcastClusterInvoker.java:76` — call all invokers
- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboInvoker.java:107` — timeout 计算
- `DubboInvoker.java:146` — remoting timeout -> `RpcException.TIMEOUT_EXCEPTION`
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/support/RpcUtils.java:280` — timeout 获取
- `RpcUtils.java:293` — countdown timeout
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/exchange/support/DefaultFuture.java:128` — future / timeout 注册
- `DefaultFuture.java:260` — timeout response -> exception
- `DefaultFuture.java:294` — client-side/server-side timeout 文本
- `DefaultFuture.java:212` — late response warning
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryDirectory.java:652` — configurator override provider URL
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/AbstractConfiguratorListener.java:85` — dynamic rule process

## 测试证据清单

- `FailoverClusterInvokerTest.java:80`
- `FailoverClusterInvokerTest.java:103`
- `FailoverClusterInvokerTest.java:122`
- `FailoverClusterInvokerTest.java:270`
- `FailfastClusterInvokerTest.java:82`
- `ForkingClusterInvokerTest.java:103`
- `ForkingClusterInvokerTest.java:118`
- `BroadCastClusterInvokerTest.java:85`
- `BroadCastClusterInvokerTest.java:100`
- `DefaultFutureTest.java:107`
- `DefaultFutureTest.java:231`

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇聚焦 runtime 判因，不展开具体 registry vendor、config-center backend 或 remoting 网络细节。
- 不展开完整生产调参和线程池专题。

## 与其他篇的边界

### 本篇要讲清

- timeout / no-provider / retry 放大的运行时判因。
- 四种 cluster 策略的真实语义差异。
- registry/router/configurator 变化如何放大失败。

### 本篇不深讲

- remoting request/response 网络细节。
- registry notify / refreshInvoker 基础实现细节（上一章已覆盖）。
- config center 规则加载细节（上一章已覆盖）。

## 写作后检查

- [ ] 开篇先抓“同一个错误为什么长得完全不同”，而不是直接讲 `FailoverClusterInvoker`。
- [ ] 至少展开 3 个失败方案，且包含“异常码=来源”“failover=静态轮换”。
- [ ] 明确给出三层判因总图。
- [ ] 不把本文写成 cluster 策略清单。
- [ ] 每个判因结论都落到 file:line 和测试。
- [ ] 删除代码块后，读者仍能复述 timeout/retry/cluster 的排障四问法。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。