# Nacos：cluster membership 与 server-to-server coordination — rewrite plan

## 篇章定位

- 写作卷：`vol-nacos`
- 章节：`ch02-remote-cluster-auth`
- 篇：`04 Nacos：cluster membership 与 server-to-server coordination`
- 对应主题：`N-04 cluster substrate`
- 文章类型：集群底座篇
- 正文状态：未开始
- 分析对象：`Nacos 3.0.3`

## 文章定位

- 核心困惑：很多人对 Nacos 集群的理解停留在“配一个 `cluster.conf`，再加上 Raft 或 distro”。但真实源码里，`cluster.conf` 只是 lookup 来源之一，真正统一掌握成员集合、节点健康、能力信息、事件传播、server-to-server RPC 的核心，是 `ServerMemberManager`。问题不是“集群是不是有配置文件”，而是：**Nacos 到底怎样从启动期确定成员集合，再怎样把这个集合变成运行期的 cluster substrate，并供 consistency、naming、config 等上层消费。**
- 一句话顿悟：Nacos 3.0.3 的 cluster substrate 不是“配置文件 + 心跳”的松散组合，而是**`ServerMemberManager` 作为唯一成员视图 authority，`LookupFactory` 决定成员来源，`memberChange()` 作为 canonical 成员集替换操作，`MembersChangeEvent` 作为统一传播机制，`ClusterRpcClientProxy` 负责 server-to-server gRPC 客户端维护，Web ready 后再用 member report 任务持续修正健康与元数据。**
- 文章边界：本篇重点讲 membership source、成员对象、lookup、memberChange、event fan-out、cluster RPC substrate 与 peer report；不深讲 AP/CP 算法细节，不展开 naming/config 对 cluster substrate 的具体业务消费。

## 前置依赖

### HARD

- `02-shared-kernel-core-sys-startup-cluster-remote-auth.md`
- `03-remote-grpc-request-handler-connection-auth.md`

### SOFT

- 对集群节点发现、成员表、健康检查有基本直觉会有帮助，但不是前提。

### NAV

- 后续可接：consistency(AP/CP)、naming 的 distro mapping、config 的 cluster sync。

## 一句话困惑

Nacos 集群到底是怎样从“知道有哪些节点”走到“这些节点能互相协调并向上层提供统一成员视图”的？

## 一句话顿悟

Nacos 先用 `LookupFactory` 选出成员发现方式，再由 `ServerMemberManager` 把它收束成唯一运行时成员视图；之后通过 `MembersChangeEvent` 扩散给 `ClusterRpcClientProxy`、`ProtocolManager`、`DistroMapper` 等消费者，并在 Web ready 后用 member report 持续校正节点健康与元数据。

## 读者理解路径

1. 先否定“`cluster.conf` 就是整个集群系统”这个直觉。
2. 建立 `ServerMemberManager` 是唯一 membership authority 的总图。
3. 解释 lookup 选择顺序：standalone / file / address-server / property override。
4. 解释 `memberChange()` 为什么是 canonical member-set replace 操作。
5. 解释 lookup 刷新与 peer report 是两套不同职责：前者换拓扑，后者修健康和元数据。
6. 解释 server-to-server RPC 是 shared remote substrate 上的 cluster lane，而不是另一套独立栈。
7. 解释 `MembersChangeEvent` 如何向 consistency、naming 等上层传播。
8. 收束到：集群底座先成型，AP/CP 和业务消费再在上面展开。

## 失败方案推演

### 失败方案一：`cluster.conf` 就是 Nacos 集群机制本身

- `cluster.conf` 只是成员来源之一。
- clustered 模式下，lookup 可能来自 file，也可能来自 address server，还可被显式 property override。
- 真正的运行时成员 authority 是 `ServerMemberManager`，不是配置文件本身。

### 失败方案二：lookup 和节点健康维护是一回事

- lookup 的职责是发现/刷新 candidate member set。
- 节点健康、能力、元数据修正则依赖 Web ready 后的 peer report 任务。
- 两者属于不同阶段、不同责任的机制。

### 失败方案三：cluster RPC 是独立于 shared remote 的另一套 transport 栈

- cluster lane 仍然复用 shared remote/gRPC substrate。
- 它只是在 client/server concrete variant、`source=cluster`、固定 peer 目标上做定制。
- 所以它不是第二套 remote 系统，而是 shared remote 的 cluster 分支。

### 失败方案四：consistency 协议自己发现成员

- `ProtocolManager` 消费的是 `MembersChangeEvent`，不是自己去做成员发现。
- AP/CP 都建立在 shared cluster substrate 提供的统一成员视图上。
- 所以 cluster substrate 是 consistency 的上游，而不是反过来。

## 必须澄清的误解

1. `cluster.conf` 不是 cluster substrate 本体，只是成员来源之一。
2. `ServerMemberManager` 才是唯一成员视图 authority。
3. lookup 刷新与 peer report 不是同一机制。
4. cluster RPC 不是另一套 transport stack，而是 shared remote 的 cluster lane。
5. AP/CP 协议消费成员变化，而不是自己去发现成员。

## 文章结构与字数预算

1. 困惑开场：为什么 `cluster.conf` 直觉是错的（800-1000 字）
2. 总图：`LookupFactory -> ServerMemberManager -> MembersChangeEvent -> ClusterRpcClientProxy / ProtocolManager / DistroMapper`（1200-1600 字）
3. `ServerMemberManager`：self、serverList、authority 地位（1600-2200 字）
4. lookup 选择与三种 lookup 模式（1600-2200 字）
5. `memberChange()`：canonical 成员集替换操作（1600-2200 字）
6. peer report：健康与元数据修正链（1400-2000 字）
7. cluster RPC：fixed-target gRPC client 与 cluster server lane（1400-2000 字）
8. event fan-out：进入 consistency / naming（1000-1400 字）
9. 收网总结（600-800 字）

目标叙述性正文：`10000-13000` 字；代码块不计入目标。

## 证据清单

- `core/cluster/ServerMemberManager.java:151` — self init
- `core/cluster/ServerMemberManager.java:231` — lookup startup
- `core/cluster/ServerMemberManager.java:356` — `memberChange()`
- `core/cluster/ServerMemberManager.java:409` — topology event publish
- `core/cluster/ServerMemberManager.java:481` — web ready 后进入协调阶段
- `core/cluster/ServerMemberManager.java:530` — peer report scheduling
- `core/cluster/ServerMemberManager.java:616` — peer report over gRPC
- `core/cluster/lookup/LookupFactory.java:64` — lookup selection
- `core/cluster/lookup/LookupFactory.java:119` — file/memberList vs address-server
- `core/cluster/lookup/FileConfigMemberLookup.java:55` — file mode start
- `core/cluster/lookup/FileConfigMemberLookup.java:77` — file watcher
- `core/cluster/lookup/AddressServerMemberLookup.java:134` — address-server startup fetch
- `core/cluster/lookup/AbstractMemberLookup.java:43` — `afterLookup -> memberChange`
- `core/cluster/Member.java:41` — member shape
- `core/cluster/MemberUtil.java:80` — address parse to runtime member
- `core/cluster/MemberUtil.java:144` — `onFail`
- `core/cluster/MemberUtil.java:178` — `onSuccess`
- `core/cluster/MemberMetaDataConstants.java:47` — basic meta keys
- `core/cluster/remote/ClusterRpcClientProxy.java:60` — cluster RPC client proxy
- `core/cluster/remote/ClusterRpcClientProxy.java:136` — fixed-target peer client
- `common/remote/client/RpcClientFactory.java:205` — create cluster gRPC client
- `core/cluster/remote/MemberReportHandler.java:44` — cluster-only handler
- `core/cluster/remote/MemberReportHandler.java:55` — member report handling
- `core/remote/grpc/GrpcClusterServer.java:46` — cluster lane server
- `core/remote/grpc/BaseGrpcServer.java:188` — source allow check
- `core/distributed/ProtocolManager.java:163` — event into consistency
- `naming/core/DistroMapper.java:128` — event into naming AP mapping

## 测试与辅助证据

- `core/cluster/ServerMemberManagerTest.java:103`
- `core/cluster/ServerMemberManagerTest.java:122`
- `core/cluster/ServerMemberManagerTest.java:188`
- `core/cluster/ServerMemberManagerTest.java:233`
- `core/cluster/remote/ClusterRpcClientProxyTest.java:83`
- `test/core-test/.../MemberLookupCoreITCase.java:97`
- `test/core-test/.../ServerMemberManagerCoreITCase.java:108`

## 版本边界

- 当前分析对象固定为 `Nacos 3.0.3`。
- 不深讲 AP/CP 算法细节。
- 不深讲 naming/config 的业务消费逻辑。
- 不回退旧版本 cluster 模型做主体叙述。

## 与后续篇章的边界

### 本篇要讲清

- 成员来源如何被统一收束为运行时成员视图。
- `memberChange()` 的 authority 地位。
- cluster RPC 如何建立在 shared remote 上。
- `MembersChangeEvent` 如何把 substrate 暴露给上层。

### 本篇不深讲

- AP distro 分片/路由算法
- CP raft/jraft 细节
- naming/config 的具体 cluster 业务行为

## 写作后检查

- [ ] 开篇先抓“为什么 `cluster.conf` 直觉是错的”，而不是直接列 lookup 类名。
- [ ] 至少展开 4 个失败方案，且包含“lookup = 健康维护”“consistency 自己发现成员”。
- [ ] 明确给出 `Lookup -> MemberManager -> Event -> Consumers` 总图。
- [ ] 清楚区分 topology replace 与 health/meta refresh。
- [ ] 每个关键结论落到 file:line。
- [ ] 删除代码块后，读者仍能复述 cluster substrate 与 consistency/naming 的上下游边界。
- [ ] 通过一次性深审收口。
