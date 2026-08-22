# Nacos：cluster membership 与 server-to-server coordination

> 基于 Nacos 3.0.3

## 一、困惑开场：为什么 `cluster.conf` 直觉是错的

很多人一说 Nacos 集群，第一反应就是：

- 配一个 `cluster.conf`
- 几个节点互相知道地址
- 再加上 Raft 或 distro
- 集群就成了

这个理解不算完全错，但它只解释了“节点名单从哪来”这个最表层的问题，并没有解释真正的运行时链：

- 谁是真正的成员视图 authority
- 成员集合是谁维护的
- 成员变化怎样传播给上层
- 节点健康与元数据是谁持续修正的
- server-to-server RPC 到底走哪条通道
- consistency、naming、config 是怎么消费这套 cluster substrate 的

如果不把这些问题拆开，后面一写到 AP/CP、distro、cluster sync，读者就会下意识把所有行为都归到“cluster.conf + 心跳”这类模糊直觉上。

这篇真正要回答的问题是：**Nacos 3.0.3 到底怎样从“知道有哪些节点”走到“这些节点能互相协调，并向上层暴露统一成员视图”。**

先把结论放前面：Nacos 3.0.3 的 cluster substrate 不是“配置文件 + 心跳”的松散组合，而是**`ServerMemberManager` 作为唯一成员视图 authority，`LookupFactory` 决定成员来源，`memberChange()` 作为 canonical 成员集替换操作，`MembersChangeEvent` 作为统一传播机制，`ClusterRpcClientProxy` 维护 server-to-server gRPC 客户端，Web ready 后再用 member report 任务持续修正健康与元数据。**

## 二、先走四条失败的路

### 失败方案一：`cluster.conf` 就是整个集群系统

这是一种极其常见的误解，因为 `cluster.conf` 很容易被当成“集群核心配置”。

但在 3.0.3 里，`cluster.conf` 最多只是**成员来源之一**。真正 clustered 模式下的 lookup 选择顺序是：

- 如果显式配了 `nacos.core.member.lookup.type`，优先按它指定
- 否则，如果有 `cluster.conf` 或者 `memberList`，走 file 模式
- 否则，才退到 address-server 模式

`core/cluster/lookup/LookupFactory.java:64`  
`core/cluster/lookup/LookupFactory.java:119`  
`core/cluster/lookup/LookupFactory.java:126`

所以真正的 cluster substrate 不是某个配置文件，而是：

- lookup 来源
- membership authority
- 成员集替换逻辑
- 事件传播
- peer report 校正链

五件事合在一起。

### 失败方案二：lookup 和节点健康维护是一回事

很多人会把“发现成员”和“判断成员活不活着”混成一条线。

但源码里这两件事是明确拆开的：

- lookup 负责发现 candidate member set，再调用 `memberChange()` 替换拓扑  
  `core/cluster/lookup/AbstractMemberLookup.java:43`
- peer report 任务负责在 runtime 中持续修正某个已有节点的健康状态、能力表和元数据  
  `core/cluster/ServerMemberManager.java:530`  
  `core/cluster/ServerMemberManager.java:616`

所以：

- lookup 更偏“拓扑发现”
- report 更偏“健康与元数据维护”

两者不是一回事。

### 失败方案三：cluster RPC 是独立于 shared remote 的另一套 transport 栈

看见 `ClusterRpcClientProxy`、`GrpcClusterServer` 这些名字，很容易误以为 cluster 自己另起了一套远程通信体系。

但它并没有脱离 shared remote substrate。真正发生的是：

- server-to-server 这条 lane 仍然复用 shared gRPC substrate
- 只是 client 侧用固定 peer 地址建连
- server 侧用 `source=cluster` 进行隔离
- handler 侧可通过 `@InvokeSource(cluster)` 限制只允许 cluster 请求进入

`core/cluster/remote/ClusterRpcClientProxy.java:121`  
`core/cluster/remote/ClusterRpcClientProxy.java:136`  
`core/remote/grpc/GrpcClusterServer.java:132`  
`core/remote/grpc/BaseGrpcServer.java:188`

所以 cluster RPC 不是第二套 transport 系统，而是 shared remote 的 cluster 分支。

### 失败方案四：consistency 协议自己发现成员

这条误解会让后面的 AP/CP 篇全写反。

真实情况是：一致性协议并不自己做成员发现。`ProtocolManager` 消费的是 `MembersChangeEvent`，也就是 shared cluster substrate 已经收束好的成员视图。  
`core/distributed/ProtocolManager.java:163`

再进一步说：

- `ServerMemberManager` 提供统一成员集合
- `ProtocolManager` 把它翻译成 AP / CP 所需的成员表示
- 然后 consistency 协议才继续往下跑自己的逻辑

所以 cluster substrate 是 consistency 的上游，而不是反过来。

## 三、最小总图：`Lookup -> MemberManager -> MembersChangeEvent -> Consumers`

先把整篇最关键的总图压出来：

```text
LookupFactory
    ↓ 选择 lookup 实现
Standalone / FileConfig / AddressServer Lookup
    ↓ afterLookup(...)
ServerMemberManager.memberChange(...)
    ↓
serverList / healthyAddress / metadata update
    ↓
MembersChangeEvent
    ├─ ClusterRpcClientProxy 刷新 peer 客户端
    ├─ ProtocolManager 更新 AP/CP 成员视图
    └─ DistroMapper 等上层消费者刷新映射
```

这张图里最重要的不是“类名多不多”，而是先把层级定住：

- lookup 决定成员来源
- `ServerMemberManager` 决定当前 authoritative view
- `MembersChangeEvent` 决定怎么传播
- 具体上层模块只是消费者

也就是说，**真正的集群 substrate 在 `ServerMemberManager` 这一层收束。**

## 四、`ServerMemberManager`：唯一 membership authority

### 4.1 self 是怎么建立的

`ServerMemberManager` 构造时会直接 `init()`。  
`core/cluster/ServerMemberManager.java:151`

在这一步里，它会：

- 解析本机地址
- 构造 `self`
- 写入版本与升级相关元信息
- 初始化 server abilities
- 先把自己塞进当前 `serverList`

`core/cluster/ServerMemberManager.java:156`  
`core/cluster/ServerMemberManager.java:160`  
`core/cluster/ServerMemberManager.java:161`  
`core/cluster/ServerMemberManager.java:167`

这一点很关键：cluster substrate 不是“先等别人来告诉我成员表”，而是**每个节点先把自己建成一个 runtime member，再去发现别人。**

### 4.2 成员 authority 体现在哪

真正能说明 authority 地位的，不是它叫 `Manager`，而是它掌握了：

- `self`
- `serverList`
- `memberAddressInfos`
- `memberLookup`
- `memberChange()`
- `update()`
- 事件发布
- report 调度

也就是说，凡是“当前有哪些节点、这些节点目前是不是健康、它们有什么元数据、这些变化该不该广播”的问题，最后都要回到它这里。

### 4.3 `Member` 到底是什么对象

`Member` 不是只有 ip/port 这么简单。

它在 `NacosMember` 基础上，还带着：

- 失败访问计数
- 兼容性相关 flag
- extend-info
- 状态、能力、附加元数据

`core/cluster/Member.java:41`  
`core/cluster/Member.java:45`  
`core/cluster/Member.java:53`  
`core/cluster/Member.java:77`

而 `MemberUtil.singleParse(...)` 在把地址解析成 runtime member 时，会补上：

- 默认 main port
- 默认状态 `UP`
- `raftPort`
- `readyToUpgrade=true`
- `grpcReportEnabled=true`

`core/cluster/MemberUtil.java:80`  
`core/cluster/MemberUtil.java:93`  
`core/cluster/MemberUtil.java:96`  
`core/cluster/MemberUtil.java:100`

所以 member 不是静态配置行，而是一个运行时状态对象。

## 五、lookup 选择：不是只有 `cluster.conf`

### 5.1 `LookupFactory` 的真实选择顺序

`LookupFactory.createLookUp(this)` 决定了 clustered 模式下怎么找成员。  
`core/cluster/lookup/LookupFactory.java:64`

真实顺序是：

1. 如果有显式 lookup type property，优先用它
2. 否则，看有没有 `cluster.conf` 或 `memberList`
3. 再不行，才去 address server

`core/cluster/lookup/LookupFactory.java:119`  
`core/cluster/lookup/LookupFactory.java:126`

这一点值得在正文里讲透，因为它会直接打掉“集群 = cluster.conf”这种过于单薄的模型。

### 5.2 file 模式到底做什么

`FileConfigMemberLookup` 的职责不是神秘算法，而是：

- 启动时先读一次 `cluster.conf`
- 然后给 `conf` 目录挂 watcher
- 文件变化时重读，再触发一次 `memberChange()`

`core/cluster/lookup/FileConfigMemberLookup.java:55`  
`core/cluster/lookup/FileConfigMemberLookup.java:61`  
`core/cluster/lookup/FileConfigMemberLookup.java:77`  
`core/cluster/lookup/FileConfigMemberLookup.java:87`

所以 file 模式的本质是“配置驱动的拓扑发现”。

### 5.3 address-server 模式到底做什么

`AddressServerMemberLookup` 则是另一条路：

- 启动时同步抓取 server list
- 失败会重试几次
- 还不行就让 startup fail
- 成功后每 5 秒再周期性同步一次

`core/cluster/lookup/AddressServerMemberLookup.java:134`  
`core/cluster/lookup/AddressServerMemberLookup.java:150`  
`core/cluster/lookup/AddressServerMemberLookup.java:154`  
`core/cluster/lookup/AddressServerMemberLookup.java:194`

这说明 address-server 更像“外部权威成员源”。

### 5.4 standalone 不是“一个简化版 cluster”

`StandaloneMemberLookup` 本质上就是一个单节点 self lookup。  
`core/cluster/lookup/StandaloneMemberLookup.java:33`

这意味着 standalone 模式不是 clustered 模式缺了一半，而是 membership source 就变成了“只有我自己”。

## 六、`memberChange()`：canonical 成员集替换操作

### 6.1 为什么这一步要单独成节

如果说 cluster substrate 有一个真正的收束点，那就是 `memberChange()`。

它不是一个普通 setter，而是当前成员视图的 canonical replace 操作。  
`core/cluster/ServerMemberManager.java:356`

### 6.2 它到底做了什么

`memberChange()` 至少做了下面几件关键事：

- 如果传入成员集合为空，直接拒绝这次替换
- 先检查新成员集合里是否包含 self；如果没有，会强行补回 self
- 比较新旧成员集合规模和地址差异，决定这次是否算拓扑变化
- 对地址未变化的节点，优先保留旧对象中的动态元信息和能力
- 重建 `serverList`
- 重建健康地址缓存
- 把新的集群视图持久化到 `cluster.conf`
- 如果拓扑确实变化了，再发布 `MembersChangeEvent`

`core/cluster/ServerMemberManager.java:358`、`:359` 说明空成员集会被直接拒绝。  
`core/cluster/ServerMemberManager.java:362`、`:365`、`:369`、`:370` 说明它会先检查 self 是否在新列表里，不在就强行补回并打告警。  
`core/cluster/ServerMemberManager.java:378`、`:384`、`:386` 说明拓扑变化判断同时考虑规模和地址差异。  
`core/cluster/ServerMemberManager.java:389`、`:390` 说明对已有地址会尽量保留旧 member 中动态 extend-info 和 abilities。  
`core/cluster/ServerMemberManager.java:398`、`:399` 说明新的 authoritative 视图最终落到 `serverList` 和健康地址集合。  
`core/cluster/ServerMemberManager.java:403`、`:409` 是持久化与事件发布。  

所以 `memberChange()` 不只是“我收到了一个新列表”，而是“我决定把它变成新的 authoritative runtime cluster view”。

### 6.3 为什么这和 `update()` 不一样

还有一个很关键的边界：`memberChange()` 和 `update()` 不是一回事。

- `memberChange()` 处理的是整组成员视图替换
- `update()` 更像对某个已有 member 的状态/元信息做局部更新

这也是为什么 lookup 刷新和 peer report 不应该混成一件事。

## 七、拓扑替换之外，还有 health / metadata 修正链

### 7.1 Web ready 之后才进入协调活跃阶段

真正从“成员视图已知”走到“开始协调”，要等 Web server ready。

`NacosWebServerListener` 在 web server 初始化完成后会调用：

- `serverMemberManager.setSelfReady(actualPort)`

`core/web/NacosWebServerListener.java:45`  
`core/web/NacosWebServerListener.java:52`

而 `setSelfReady(...)` 里会：

- 设置本机实际端口
- 更新本机地址信息
- 安排 peer report 任务

`core/cluster/ServerMemberManager.java:481`

这一步很重要，因为它标志着：cluster substrate 从“拓扑已知”转入“运行中持续协调”。

### 7.2 report 任务在修什么

后续会有两类 report task：

- 面向普通成员的 report
- 面向不健康成员的 report

它们的重点不是重新发现拓扑，而是：

- 探测节点是否可达
- 刷新远端 self 元数据
- 更新能力信息
- 修正健康状态

`core/cluster/ServerMemberManager.java:530`  
`core/cluster/ServerMemberManager.java:560`  
`core/cluster/ServerMemberManager.java:616`

### 7.3 `MemberUtil.onFail / onSuccess` 说明了什么

`MemberUtil.onFail(...)` 会：

- 从 healthy 集合移除该地址
- 把节点状态标成 `SUSPICIOUS`
- 增加失败次数
- 必要时最终标成 `DOWN`

`core/cluster/MemberUtil.java:144`  
`core/cluster/MemberUtil.java:160`

而 `onSuccess(...)` 则会：

- 恢复 `UP`
- 刷新元数据 / abilities
- 恢复健康状态

`core/cluster/MemberUtil.java:178`  
`core/cluster/MemberUtil.java:197`

这就把第二条链讲清楚了：**lookup 决定“有哪些成员”，report 决定“这些成员现在怎么样”。**

## 八、cluster RPC：shared remote 上的 cluster lane

### 8.1 `ClusterRpcClientProxy` 不是 transport 栈，而是 peer client 管理器

`ClusterRpcClientProxy` 的职责不是重新发明 transport，而是：

- 订阅成员变化
- 启动时先按当前 `allMembersWithoutSelf()` 建一轮 peer client
- 为每个 peer 维护一个固定目标 gRPC client
- 刷新和销毁这些 peer client
- 在发送请求前补 server identity 头

`core/cluster/remote/ClusterRpcClientProxy.java:60`  
`core/cluster/remote/ClusterRpcClientProxy.java:74`、`:76`、`:77`、`:78` 说明它启动时就会先订阅事件并按当前 peer 列表做首轮 refresh。  
`core/cluster/remote/ClusterRpcClientProxy.java:92`、`:95`、`:96` 说明 refresh 会先确保新 peer 的 client 被创建并启动。  
`core/cluster/remote/ClusterRpcClientProxy.java:100`、`:105`、`:106`、`:109` 说明 refresh 还会把已经离开的旧 peer client 关闭并移除。  
`core/cluster/remote/ClusterRpcClientProxy.java:121`、`:123`、`:124`、`:125` 说明 cluster client 会显式打上 `source=cluster` 标签并按 member 生成固定 client key。  

### 8.2 fixed-target peer client 是真正的特点

最值得指出的一点是：这里的 client 不是服务发现式负载均衡 client，而是 **one peer one client** 的 fixed-target 模型。

`core/cluster/remote/ClusterRpcClientProxy.java:132`、`:133` 说明只有在 client 还处于 wait-init 阶段时才真正启动新 peer client。  
`ClusterRpcClientProxy.java:136` 附近通过 `ServerListFactory` 只返回一个目标地址。  
`core/cluster/remote/ClusterRpcClientProxy.java:136`、`:138`、`:143`、`:148`、`:149` 说明无论 `genNextServer()`、`getCurrentServer()` 还是 `getServerList()`，返回的都是同一个 peer 地址。  

而 client 创建最终走的是 `RpcClientFactory.createClusterClient(...)`。  
`common/remote/client/RpcClientFactory.java:205`

所以 cluster lane 的真正特点不是 transport 变了，而是目标选择模型变成了固定 peer。

### 8.3 server 侧也是 shared remote 的 cluster 版本

server 侧对应的是 `GrpcClusterServer`，它只是把：

- 端口 offset
- executor
- plugin/interceptor
- `source = cluster`

这些 cluster lane 相关定制挂上去。  
`core/remote/grpc/GrpcClusterServer.java:46`  
`core/remote/grpc/GrpcClusterServer.java:132`

而 source 限制最终还是在 `BaseGrpcServer` 的 shared 逻辑里做。  
`core/remote/grpc/BaseGrpcServer.java:188`

### 8.4 一个最小例子：`MemberReportRequest`

`MemberReportHandler` 是一个非常好的例子，因为它能把 cluster lane、source restriction 和 member update 串起来。

它：

- 声明只允许 cluster source 进入  
  `core/cluster/remote/MemberReportHandler.java:44`
- 还声明这是一个 `INNER_API` 且资源名为 `report` 的受保护处理器  
  `core/cluster/remote/MemberReportHandler.java:54`
- 收到 `MemberReportRequest` 后，先从请求里拿 `node`，再校验这个 node 是否合法  
  `core/cluster/remote/MemberReportHandler.java:55`、`:56`、`:57`
- 如果节点非法，会直接返回错误响应，而不是继续更新 member 视图  
  `core/cluster/remote/MemberReportHandler.java:58`、`:59`
- 对合法节点，则强制把状态拉回 `UP`、失败计数清零，再调用 `memberManager.update(node)`  
  `core/cluster/remote/MemberReportHandler.java:63`、`:64`、`:65`
- 最后返回自己的 `self` 作为响应  
  `core/cluster/remote/MemberReportHandler.java:66`

这说明 cluster server-to-server coordination 不是抽象概念，而是明确建立在 shared remote substrate 上的一条业务 lane。

## 九、`MembersChangeEvent`：cluster substrate 向上层的统一出口

### 9.1 事件是怎么定义的

`MembersChangeEvent` 携带的是：

- 当前完整 member set
- 可选的 trigger members

`core/cluster/MembersChangeEvent.java:40`  
`core/cluster/MembersChangeEvent.java:42`

这说明它不是某个微小回调，而是统一的成员变化传播载体。

### 9.2 它先喂给谁

至少有三个关键消费者：

- `ClusterRpcClientProxy`：刷新 peer gRPC clients  
  `core/cluster/remote/ClusterRpcClientProxy.java:231`
- `ProtocolManager`：把成员变化翻译给 AP/CP 协议  
  `core/distributed/ProtocolManager.java:163`  
  `core/distributed/ProtocolManager.java:174`  
  `core/distributed/ProtocolManager.java:177`
- `DistroMapper`：更新 naming AP shard 视角  
  `naming/core/DistroMapper.java:128`

### 9.3 这就是和后续篇章的边界

所以到这里应该立住的层级关系是：

- cluster substrate 先把统一成员视图准备好
- 事件把它传播出去
- consistency、naming、config 等再按自己的业务方式消费

也就是说，**第 04 篇只负责讲“统一成员视图是怎么来的、怎么传播的”，不负责讲“每个消费者怎么用”。**

## 十、误解澄清

### 误解一：`cluster.conf` 就是 Nacos 的集群机制

不是。它只是成员来源之一，不是 membership authority。

### 误解二：lookup 就是在做健康维护

不是。lookup 负责拓扑发现，report 负责健康与元数据修正。

### 误解三：cluster RPC 是第二套 transport 栈

不是。它是 shared remote substrate 上的 cluster lane。

### 误解四：consistency 协议自己发现成员

不是。它消费的是 `MembersChangeEvent` 和统一成员视图。

### 误解五：`memberChange()` 只是普通更新方法

不是。它是 canonical 成员集替换操作。

## 十一、收网总结：Nacos 先把统一成员视图收束好，再把它交给上层消费

回到开头的问题：Nacos 集群到底怎样从“知道有哪些节点”走到“这些节点能互相协调”？

答案不是“配好 `cluster.conf` 再加心跳”，而是：

- 先由 `LookupFactory` 选成员来源
- 再由 `ServerMemberManager` 把它收束成 authoritative member view
- 再由 `MembersChangeEvent` 传播给 `ClusterRpcClientProxy`、`ProtocolManager`、`DistroMapper` 等上层消费者
- 再由 peer report 任务持续修正节点健康与元数据

把整篇压成三句话：

1. Nacos 的 cluster substrate 核心不是某个配置文件，而是 `ServerMemberManager` 对统一成员视图的维护。  
2. lookup 决定“有哪些节点”，report 决定“这些节点现在怎么样”，两者不是同一机制。  
3. consistency、naming、config 都是这套 cluster substrate 的消费者，而不是成员发现的发明者。  
