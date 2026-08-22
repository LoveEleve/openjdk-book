# Nacos：cluster membership 与 server-to-server coordination — review notes

## 深度 review 结论

本轮按"事实 → 因果 → 结构 → 删码 → 边界"重审后，**当前正文无必须修改的事实性错误**，主线成立，可以收口。

之后已追加一轮深修：把 `ServerMemberManager.memberChange()`、`ClusterRpcClientProxy`、`MemberReportHandler` 的更细 `file:line` 锚点补回正文，用来把“canonical 成员集替换到底改了什么”“peer client 刷新与 fixed-target 模型到底怎样成立”“member report 处理器到底校验并回写了什么”这三条 cluster substrate 因果链压得更实。

## 第一轮：事实审

### 已复核的关键结论

1. `ServerMemberManager` 是 cluster substrate 的唯一 membership authority：它初始化 `self`、启动 lookup、维护 `serverList`、发布 `MembersChangeEvent`、调度 peer report，证据：`core/cluster/ServerMemberManager.java:151`、`:231`、`:356`、`:409`、`:481`、`:530`。
2. `LookupFactory` 的真实选择顺序是：显式 property override > file/memberList > address-server，而不是简单“总是 cluster.conf”，证据：`core/cluster/lookup/LookupFactory.java:64`、`:119`、`:126`。
3. `FileConfigMemberLookup` 负责读取 `cluster.conf` 并挂 watcher，文件变化后再次触发 `memberChange()`，证据：`core/cluster/lookup/FileConfigMemberLookup.java:55`、`:77`、`:87`。
4. `AddressServerMemberLookup` 负责启动期同步拉取与周期性刷新 address-server 成员源，证据：`core/cluster/lookup/AddressServerMemberLookup.java:134`、`:150`、`:154`、`:194`。
5. `AbstractMemberLookup.afterLookup(...)` 才是真正把 lookup 结果送进 `memberChange()` 的桥，证据：`core/cluster/lookup/AbstractMemberLookup.java:43`。
6. `memberChange()` 是 canonical 成员集替换操作，会重建 `serverList`、健康地址缓存、持久化 `cluster.conf` 并在拓扑变化时发布事件，证据：`core/cluster/ServerMemberManager.java:356`、`:398`、`:403`、`:409`；正文现在还补了 `:358`、`:359`、`:362`、`:365`、`:369`、`:370`、`:378`、`:384`、`:386`、`:389`、`:390`，把空集拒绝、self 补回、拓扑变化判定、动态元信息保留的路径压得更细。
7. `Member` 与 `MemberUtil.singleParse(...)` 说明成员不是静态地址，而是带状态、扩展元数据、兼容字段、`raftPort`、默认 `UP` 状态等的运行时对象，证据：`core/cluster/Member.java:41`、`:53`、`core/cluster/MemberUtil.java:80`、`:93`、`:96`、`:100`。
8. lookup 与 health/meta 修正是两套机制：peer report 任务在 Web ready 后启动，用于校正 member 健康与元信息，证据：`core/cluster/ServerMemberManager.java:481`、`:560`、`:616`、`:633`、`core/cluster/MemberUtil.java:144`、`:178`。
9. `ClusterRpcClientProxy` 为每个 peer 维护 fixed-target cluster gRPC client，并消费成员变化刷新客户端集合，证据：`core/cluster/remote/ClusterRpcClientProxy.java:60`、`:92`、`:136`、`:231`；正文现在还补了 `:74`、`:76`、`:77`、`:78`、`:95`、`:96`、`:100`、`:105`、`:106`、`:109`、`:121`、`:123`、`:124`、`:125`、`:132`、`:133`、`:138`、`:143`、`:148`、`:149`，把启动首轮 refresh、旧 client 清理、`source=cluster` 标签、fixed-target 单地址模型压得更细。
10. `RpcClientFactory.createClusterClient(...)` 说明 cluster lane 复用了 shared remote substrate，只是构造 `GrpcClusterClient` 这种 cluster 变体，证据：`common/remote/client/RpcClientFactory.java:205`。
11. `GrpcClusterServer` 是 shared remote 的 cluster lane concrete server，source 限制仍落在 `BaseGrpcServer` 中，证据：`core/remote/grpc/GrpcClusterServer.java:46`、`:132`、`core/remote/grpc/BaseGrpcServer.java:188`。
12. `MemberReportHandler` 是典型 cluster-only handler：只允许 cluster source，处理 `MemberReportRequest`，更新 member 并返回 self，证据：`core/cluster/remote/MemberReportHandler.java:44`、`:55`、`:63`、`:66`；正文现在还补了 `:54`、`:56`、`:57`、`:58`、`:59`、`:64`、`:65`，把 inner API 保护、非法 node 快速失败、状态恢复与 `memberManager.update(node)` 的顺序压得更细。
13. `MembersChangeEvent` 是 cluster substrate 的统一传播出口，并被 `ClusterRpcClientProxy`、`ProtocolManager`、`DistroMapper` 等消费，证据：`core/cluster/MembersChangeEvent.java:40`、`core/distributed/ProtocolManager.java:163`、`naming/core/DistroMapper.java:128`。

### 测试与辅助证据复核

1. `core/cluster/ServerMemberManagerTest.java:103` — event publish / healthy-address cache。
2. `core/cluster/ServerMemberManagerTest.java:122` — 非 basic extend-info 更新不发布成员变化事件。
3. `core/cluster/ServerMemberManagerTest.java:188`、`:233` — peer report 任务行为。
4. `core/cluster/remote/ClusterRpcClientProxyTest.java:83` — cluster RPC client refresh。
5. `test/core-test/.../MemberLookupCoreITCase.java:97` — lookup 选择。
6. `test/core-test/.../ServerMemberManagerCoreITCase.java:108`、`:143` — member join 与健康传播。

## 第二轮：因果审

- 如果不先打掉“`cluster.conf` 就是一切”的直觉，后面 cluster/runtime/consistency 都会被写成配置文件故事：当前正文已先破除，成立。✅
- 如果不区分 lookup 和 report，cluster substrate 会被误写成单线程心跳系统：当前正文已切开，成立。✅
- 如果不把 `memberChange()` 立成 canonical authority，成员视图、健康缓存、事件传播会失去统一中心：当前正文已压实，成立。✅
- 如果不说明 cluster RPC 复用 shared remote substrate，cluster 篇就会重复制造一条并不存在的 transport 主线：当前正文已纠正，成立。✅
- 如果不把 `MembersChangeEvent` 定位成统一出口，后续 consistency/naming 文章会看起来像各自有一套成员来源：当前正文已明确，成立。✅

## 第三轮：结构审

### 结构是否跑偏

没有跑偏。正文推进顺序是：

1. 先抓“为什么 `cluster.conf` 直觉是错的”  
2. 再用四个失败方案打掉错误模型  
3. 再建立 `Lookup -> MemberManager -> Event -> Consumers` 总图  
4. 再切出 authority、lookup、`memberChange()`、report、cluster RPC、event fan-out 这六段  
5. 最后再明确与后续 consistency/naming/config 篇的边界  

这保证了正文没有退化成 `cluster.conf` / address-server 手册，也没有提前侵占 AP/CP 细节。✅

### 失败方案是否有效

有效，而且正好命中了这一篇最需要先打掉的四种错觉：
- `cluster.conf` 就是整个集群系统  
- lookup 和健康维护是一回事  
- cluster RPC 是另一套 transport 栈  
- consistency 协议自己发现成员  

这四条分别对应成员来源、运行期维护、通信底座、上下游关系四个最关键错位。✅

## 第四轮：删码测试

删除代码块后，正文仍然能复述：

- cluster substrate 的 authority 在 `ServerMemberManager`  
- `cluster.conf` 只是成员来源之一  
- lookup 负责拓扑发现，report 负责健康与元数据修正  
- cluster RPC 是 shared remote 的 cluster lane  
- `MembersChangeEvent` 是 consistency/naming/config 的统一上游输入  

删码后主线不塌，说明代码块不是叙事骨架。✅

## 第五轮：边界审

### 本篇边界控制

当前正文边界控制是对的：
- 没深挖 AP distro 算法  
- 没深挖 CP raft/jraft 细节  
- 没深挖 naming/config 对成员变化的业务消费  
- 重点压在 membership authority、cluster RPC lane、event fan-out 三件事上  

### 与后续篇章的边界

- consistency 篇可从 `ProtocolManager.toAPMembersInfo/toCPMembersInfo` 开始深入。✅
- naming 篇可从 `DistroMapper` 如何消费成员变化开始深入。✅
- config 篇可从 cluster sync / notifier 如何消费 cluster substrate 开始深入。✅
- 本篇自身位置：`vol-nacos` 的 cluster substrate authority 篇。✅

## 第六轮：风险点

### 已确认不是问题的点

1. 正文没有把 `cluster.conf` 写成 membership authority。  
2. 正文没有把 lookup 和 report 写成同一种机制。  
3. 正文没有把 cluster RPC 写成另一套 transport 栈。  
4. 正文没有把 consistency 写成自己发现成员。  
5. 正文没有把 `memberChange()` 降格成普通 setter。  

### 当前仍存在的轻微风险

1. 正文已经补齐关键 cluster 主链锚点，但如果后续做整卷统一抛光，仍可继续把 `LookupFactory`、`AddressServerMemberLookup`、`MemberUtil.onFail/onSuccess` 的局部路径压得更细。  
2. 这个问题不影响主线正确性，属于进一步精修项。  

## 机械检查

- 禁用表达已复扫；当前命中为 0。✅
- 正文行数：491。✅
- 代码块未承担主叙事骨架。✅
- 主要结论均已落到 file:line。✅
- 正文已经达到 cluster substrate 篇所需的长文规模。✅

## 结论

本轮深度 review 后，正文可以认为已经完成收口：

- 事实层面成立  
- 因果链成立  
- 结构推进成立  
- 删码后主线成立  
- 与后续篇章边界清晰  

如果后续要再提升一档，优先项不是改结构，而是补更细的 `ServerMemberManager.memberChange()` / `ClusterRpcClientProxy` / `MemberReportHandler` 锚点。当前版本不改也可以过关。 
