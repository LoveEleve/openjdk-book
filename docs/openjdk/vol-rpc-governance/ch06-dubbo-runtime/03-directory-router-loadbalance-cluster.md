# Dubbo：Directory、Router、LoadBalance、Cluster consumer 流量主线

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：拿到远程代理之后，为什么还没结束

如果你已经读完前两篇，直觉上会以为 Dubbo consumer 的故事差不多讲完了：`ReferenceConfig.get()` 拿到一个 Java 代理，代理背后连着 `Invoker`，`Invoker` 再交给协议层去发远程调用。

但真正跑到线上，你很快会发现事情远没有这么简单。

同一个接口、同一个代理对象、同一次业务调用，为什么有时候换一台 provider 再试就能成功，有时候第一次失败立刻抛错，有时候会并发打多台，有时候干脆要广播给所有 provider？为什么注册中心里 provider 列表刚变，后续调用就已经换了路由？为什么明明 provider 还在 registry 里，某台机器却临时被本地 consumer 踢出了可用集合？

这些问题都说明：consumer 侧真正的主线不是“拿到一个 invoker 就调用”，而是“拿到一个会动态选 provider、动态路由、动态容错的聚合 invoker 去调用”。这个聚合调用体就是 `ClusterInvoker`，而它前面还站着 `Directory`、`Router` 和 `LoadBalance` 三层。

## 二、前情回顾：第一篇立住入口，第二篇立住窄腰，这一篇立住流量选择

在第一篇里，我们已经知道 `ReferenceConfig` 会从 URL、registry 或 injvm 入口一路走到 `Protocol.refer()`，再把拿回来的 `Invoker` 变成 Java 代理。

在第二篇里，我们又知道 `Invoker` 是 Dubbo 的窄腰，`Protocol` 负责 export/refer，`ProxyFactory` 负责对象与 `Invoker` 的双向变形，`Filter` 和 `Listener` 通过 wrapper 在窄腰外织入。

但到这里为止，读者仍然会天然产生一个误解：好像 consumer 拿到的就是“某个远程目标的 Invoker”。这不对。

在真正的 registry / cluster 场景里，consumer 拿到的通常不是一个“单点 invoker”，而是一个能在一组 provider 之间动态决策的 `ClusterInvoker`。而这条决策链，正是本篇的主角：

```text
Directory -> RouterChain -> LoadBalance -> ClusterInvoker
```

## 三、先走三条失败的路

### 失败方案一：从 registry 拿到 provider 列表就结束了

很多人一说 Dubbo consumer，就下意识想到：从注册中心拿到 provider 地址列表，然后选一个发过去。

但这只是最外层输入。真正参与一次调用的，不是 registry 里那份原始 provider 列表，而是经过 `Directory` 持有、`RouterChain` 裁剪、`LoadBalance` 选择、`ClusterInvoker` 包装后的运行时视图。

也就是说，registry 提供的是“候选材料”，不是“最终调用答案”。

### 失败方案二：Router 就是在多个 provider 里选一个

如果把 Router 当成“选择器”，你就会把它和 LoadBalance 混成一层。

但 Router 的职责不是“选谁”，而是“删谁”。它根据这次 invocation 的上下文，把不该参与的 invoker 裁掉；最后还剩多台时，才轮到 LoadBalance 从中挑一个。

所以 Router 更像筛子，LoadBalance 才更像单点选择器。

### 失败方案三：failover 就是在原始 provider 列表里换一台重试

如果你把 failover 理解成“一个静态 for-loop，失败了就拿下一个地址重试”，那会错过 Dubbo 最重要的一层动态性。

在 Dubbo 里，failover 每轮失败之后，不是直接在原始旧列表里轮换，而是重新 `list(invocation)`，重新拿 routed invokers。这样它才能吸收 registry 最新变化、router 新规则、本地可用性变化。

所以 failover 不是“静态列表轮换”，而是“动态视图上的再次选择”。

## 四、最小总图：一次 consumer 调用在四层里被加工

先把整篇文章的主图压出来：

```text
ReferenceConfig.get()
    ↓
RegistryProtocol.refer()
    ↓
DynamicDirectory / RegistryDirectory
    ↓  每次调用
Directory.list(invocation)
    ↓
RouterChain.route(...)
    ↓
routed invokers
    ↓
LoadBalance.select(...)
    ↓
selected invoker
    ↓
ClusterInvoker.doInvoke(...)
    ↓
单点调用 / 重试 / 并发调用 / 广播调用
```

这四层分别回答四个不同的问题：

- **Directory**：现在有哪些 invoker 可参与这次调用？
- **Router**：这次调用里，哪些 invoker 根本不该参与？
- **LoadBalance**：在剩下的候选里，先挑哪一个？
- **Cluster**：如果这个选择失败了，接下来怎么办？

这里先做一个路标。后面这四层不是并列抽象名词，而是一条严格的 consumer 调用加工链：**先得到视图，再做裁剪，再做单点选择，最后定义失败语义。**

## 五、`Directory`：consumer 侧的动态 invoker 视图

### 5.1 `Directory` 不是 registry client

`Directory` 的接口看起来很简单：它本质上就是一个 `Node`，再加上 `list(invocation)`，返回当前 invocation 下可参与的 invoker 列表。

`Directory.java:35` — `Directory` 定义

这一步最容易被误解成“它就是 registry 客户端”。其实不是。registry 只是它的上游数据源之一。`Directory` 真正代表的是：**consumer 当前可用的 invoker 视图**。

### 5.2 `Directory.list()` 返回的不是原始 provider 全量

对 `AbstractDirectory` 来说，`list(invocation)` 不是简单返回缓存数组，而是：

1. 取当前 `validInvokers` 或 `invokers` 快照  
2. 根据 router chain 做路由  
3. 返回 routed candidates

`AbstractDirectory.java:204` — `list(invocation)`
`AbstractDirectory.java:229` — 从 `validInvokers` / `invokers` 取快照
`AbstractDirectory.java:245` — 选择 router chain 并继续 `doList()`

对于 `DynamicDirectory`，真正的 `doList()` 就是一句：把当前 invokers 丢给 `singleRouterChain.route(...)`。

`DynamicDirectory.java:212` — `doList()`

所以 `Directory.list()` 的语义不是“给我 provider 全表”，而是“给我这次 invocation 当前还能考虑的候选集合”。

### 5.3 本地可用性也会影响视图

这也是一个经常被忽略的点。provider 是否进入当前有效视图，不只由 registry 决定，本地 consumer 也会根据 `invoker.isAvailable()` 把某些 invoker 暂时踢出 `validInvokers`。

`AbstractClusterInvoker.select(...)` 如果发现某个 invoker 不可用，会通过 `directory.addInvalidateInvoker(invoker)` 把它加入重新探测队列。

`AbstractClusterInvoker.java:203` — 不可用 invoker 进入 invalidate 逻辑
`AbstractDirectory.java:320` — `addInvalidateInvoker()`
`AbstractDirectory.java:384` — `checkConnectivity()` 后恢复 valid invoker

所以 live 视图不是“注册中心的客观真相”，而是“注册中心 + 本地路由 + 本地可用性探测”共同作用后的结果。

## 六、`RouterChain`：先删候选，再谈选择

### 6.1 Router 只负责裁剪，不负责单点选择

`Router` 的接口是 `route(...)`，返回的是一个 `RouterResult`，而不是一个 `Invoker`。

`Router.java:35` — `Router` 定义

这说明它的职责是“调整候选集”，而不是“做最后选择”。

### 6.2 路由执行顺序

`SingleRouterChain.route(...)` 先跑 state routers，再跑普通 routers，而且可以在中间因为 `isNeedContinueRoute()` 停止后续路由。

`SingleRouterChain.java:162` — route 主入口
`SingleRouterChain.java:165` — state router 先执行
`SingleRouterChain.java:176` — 普通 router 顺序执行
`SingleRouterChain.java:186` — 可提前中断后续 route

这说明 routing 不是一个“算完就完”的静态规则，而是一个带阶段性的裁剪流水线。

### 6.3 为什么要先路由再负载均衡

如果不先路由，LoadBalance 看到的会是一个逻辑上不合法的全量候选集：

- 某些 provider 可能因标签、条件、版本不该参与  
- 某些 provider 可能因禁用、隔离、迁移策略不该参与  
- 某些 provider 可能已经被 state router 提前标记掉了  

所以 Router 在 LoadBalance 前面，不是实现细节，而是职责边界本身。

## 七、`LoadBalance`：只负责从候选里挑一个

### 7.1 负载均衡接口很窄

`LoadBalance` 的核心接口是 `select(invokers, url, invocation)`。

`LoadBalance.java:37` — `LoadBalance` 定义

它只做一件事：从当前候选集中挑一个。它不负责重试，不负责广播，不负责并发，不负责维护 registry 更新。

### 7.2 `LoadBalance` 不是真正的容错层

很多人会把“换一台机器再试一次”也记到负载均衡头上，但那其实已经进入 cluster 语义了。

LB 只是决定“先试哪台”。如果这台失败了，是否重试、是否重算候选、是否改换别台、是否并发发多台，这都不由 `LoadBalance` 决定。

### 7.3 sticky / reselect 为什么不算 LB 逻辑

`AbstractClusterInvoker.select(...)` 在调用 LB 之前/之后还会叠加 sticky、availableCheck、reselect 这些 cluster 侧增强。

`AbstractClusterInvoker.java:155` — `select(...)`

这恰好说明：最终“选中谁”的动作，不是纯粹由 LB 决定，而是 cluster 在 LB 结果上继续加工。

## 八、`ClusterInvoker`：真正决定失败后怎么办

### 8.1 `Cluster.join()` 生成的是“虚拟 Invoker”

`Cluster` 的接口本质上是：把一个 `Directory` 合并成一个“虚拟 Invoker”。

`Cluster.java:40` — `Cluster.join()`
`ClusterInvoker.java:23` — `ClusterInvoker` 定位

这说明 cluster 层不是一个“外围策略模块”，而是 consumer 最终拿到的调用入口。

### 8.2 `AbstractClusterInvoker.invoke()` 是总入口

真正的 consumer 调用主入口在 `AbstractClusterInvoker.invoke()`：

1. 检查自身是否可用  
2. `list(invocation)` 拿 routed candidates  
3. `checkInvokers(...)` 确保还有可用 provider  
4. `initLoadBalance(...)` 选 LB 策略  
5. 调具体 cluster 的 `doInvoke(...)`

`AbstractClusterInvoker.java:345` — `invoke()` 总入口
`AbstractClusterInvoker.java:355` — `list(invocation)`
`AbstractClusterInvoker.java:358` — `checkInvokers(...)`
`AbstractClusterInvoker.java:360` — 调 `doInvoke(...)`
`AbstractClusterInvoker.java:466` — `initLoadBalance()`

这一步非常关键：**真正决定这次调用怎么走的，不是 Directory、不是 Router、不是 LoadBalance 单独任何一层，而是 ClusterInvoker 把三者串起来之后形成的调用语义。**

### 8.3 `Failover`：动态视图上的重试

`FailoverClusterInvoker` 失败后会重新 `list(invocation)`，再重新 `select(...)`。这意味着它不是在一个静态列表上做循环，而是在一个可能已经被 registry、router 或本地可用性更新过的动态视图上做重试。

`FailoverClusterInvoker.java:68` — failover retry loop
`FailoverClusterInvoker.java:71` — 失败后重新 list

它还会维护 `invoked` 集，尽量避免前面已经失败的 invoker 再次被选中。

### 8.4 `Failfast`：一次就给结论

`FailfastClusterInvoker` 没有重试环，选一次，打一枪，失败就抛。

`FailfastClusterInvoker.java:46` — failfast single shot

所以当线上表现是“第一次失败就直接出错”，不要先怀疑 LB 没换机器，先看 cluster 策略是不是本来就选了 failfast。

### 8.5 `Forking`：并发打多台，谁先回来谁赢

`ForkingClusterInvoker` 会选出若干 invokers，并发发起请求，谁先成功谁赢。它更像“并发探测多个 provider”的模型。

`ForkingClusterInvoker.java:93` — forking parallel invoke

这类行为在线上特别容易被误解成“怎么同一个请求发了多次”，其实那是 cluster 策略本身就在设计上允许的。

### 8.6 `Broadcast`：不是选一个，而是全打一遍

`BroadcastClusterInvoker` 会顺序遍历所有 invokers。它适用于需要把某个请求广播给全量 provider 的场景。

`BroadcastClusterInvoker.java:76` — broadcast all invoke

默认即使前面有人失败，也会继续广播到所有 invokers，最后再决定是否抛错。

## 九、live 更新：provider 列表怎样流进运行时

### 9.1 订阅入口：`directory.subscribe(...)`

consumer 不是一次性从 registry 拿完地址就结束。`RegistryProtocol.doCreateInvoker()` 会让 `DynamicDirectory` 向 registry 订阅变化。

`RegistryProtocol.java:647` — `doCreateInvoker()`
`RegistryProtocol.java:667` — `directory.subscribe(...)`
`DynamicDirectory.java:184` — 真正执行 subscribe

### 9.2 `notify()`：变更先分桶，再分发

registry 回推变化时，`RegistryDirectory.notify(List<URL>)` 会先按 providers / routers / configurators 分桶。

`RegistryDirectory.java:201` — notify 入口
`RegistryDirectory.java:216` — configurators
`RegistryDirectory.java:219` — routers

然后 provider URLs 会进入 `refreshOverrideAndInvoker(...)`。

`RegistryDirectory.java:257` — `refreshOverrideAndInvoker(...)`

### 9.3 `refreshInvoker()`：把地址变成 live invokers

`refreshInvoker(...)` 会做几件关键的事情：

- 处理 forbid / `EMPTY_PROTOCOL` 的极端情况  
- URL 去重  
- 复用旧 invoker cache  
- 对新增 URL 做 `protocol.refer(serviceType, url)` 生成 invoker  
- 先刷新 router，再原子切换 invokers  
- 销毁旧而无用的 invokers

`RegistryDirectory.java:278` — forbid / `EMPTY_PROTOCOL`
`RegistryDirectory.java:315` — URL 去重与 cache reuse
`RegistryDirectory.java:452` — `toInvokers(...)`
`RegistryDirectory.java:363` — `refreshRouter(... setInvokers ...)`
`RouterChain.java:128` — main/backup 双链切换

这一段是整篇最重要的 live 更新链。它说明 Dubbo 并不是“拿到地址立刻覆盖原数组”，而是小心地同步更新 invoker 集合和 router cache，避免请求落在半更新状态上。

## 十、误解澄清

### 误解一：`Directory` 就是 registry client

不是。registry 只是上游数据源，`Directory` 是 consumer 当前可调用 invoker 的动态视图。

### 误解二：`Router` 就是在多台 provider 里选一台

不是。Router 负责删候选，LoadBalance 才负责从剩余候选里选一台。

### 误解三：`LoadBalance` 决定失败后是否重试

不是。重试、并发打多台、广播、快速失败，这些都属于 cluster 语义，不属于单点负载均衡。

### 误解四：failover 就是静态地址列表轮换

不是。Dubbo failover 每轮失败后会重新 `list(invocation)`，拿的是最新 routed invokers 视图。

### 误解五：provider 还在 registry 里，就一定还在当前可用集合里

也不是。consumer 本地的可用性探测、路由裁剪和 invalidate/reconnect 机制都可能让它暂时不在 `validInvokers` 里。

## 十一、收网总结：consumer 侧不是“打一台”，而是“先组织视图，再定义失败语义”

回到开头的困惑：为什么 consumer 拿到一个远程代理之后，故事还远远没有结束？

因为这时候你拿到的不是一个“单点远程调用入口”，而是一个 `ClusterInvoker` 风格的聚合调用体。它背后有一整套 consumer 侧流量主线：

- `Directory` 持有动态 invoker 视图  
- `RouterChain` 裁掉这次 invocation 不该参与的候选  
- `LoadBalance` 从剩余候选中挑一个  
- `ClusterInvoker` 决定失败后是重试、快速失败、并发探测还是广播  

所以 Dubbo consumer 的主线不是“拿到 provider 列表然后打一台”，而是“拿到一个会随着地址、路由、可用性和容错策略不断变化的调用视图”。

**三句话总结：**

1. `Directory`、`Router`、`LoadBalance`、`Cluster` 四层分别负责“看见谁”“删掉谁”“先选谁”“失败后怎么办”，不能混成一层。  
2. registry 只是上游数据源，真正把地址变化变成运行时流量语义的，是 `RegistryDirectory -> RouterChain -> ClusterInvoker` 这条链。  
3. 理解 Dubbo consumer，关键不是“打到哪台机器”，而是“候选集怎么形成、为什么删减、单点怎么选、失败后怎么演化”。  

**下篇预告：** 下一篇进入 remoting / exchange / dispatcher 主线，看 Dubbo 最终如何把一次 invocation 变成真正的网络请求与线程派发。