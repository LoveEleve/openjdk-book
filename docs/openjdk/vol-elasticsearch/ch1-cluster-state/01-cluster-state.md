# ClusterState 怎么让 ES 集群所有节点拿着同一份状态

> 本文基于 Elasticsearch v8.12.2 当前源码。本文是 `vol-elasticsearch` 的第一篇，回答 ClusterState 三层结构、CoordinationState 的 Raft 风格共识、两阶段发布。不展开 RoutingTable 的详细路由算法（E-4 覆盖）。

## 为什么"集群状态就是一份配置"这个理解，会把 ClusterState 读浅

第一次看 ES 集群的人，很容易觉得 ClusterState 就是一份"集群配置"——Master 改了，广播给所有节点。

但问题在于：如果 Master 挂了，新 Master 怎么知道上一份状态是什么？如果两个节点同时收到不同的状态更新，怎么判断谁是对的？如果网络分区后节点恢复，怎么追上落下的状态更新？

ClusterState 解决的远不止"存一份配置"——它用 **version 递增 + Diffable 差异化传输 + CoordinationState Raft 风格共识** 保证集群所有节点最终持有同一份权威状态。

## 总图：ClusterState 的三层结构

```
ClusterState
  ├── Metadata(索引元数据)
  │     ├── IndexMetadata(每个索引的配置)
  │     ├── templates(模板)
  │     ├── dataStreams(数据流)
  │     └── aliases(别名)
  ├── RoutingTable(分片路由表)
  │     └── IndexRoutingTable(索引级分片分布)
  ├── DiscoveryNodes(集群节点列表)
  ├── ClusterBlocks(集群级读写锁)
  └── version(每次变更递增)
```

## 分层拆解

### 1. ClusterState 的三层

`cluster/ClusterState.java:110`：

```java
public class ClusterState implements ChunkedToXContent, Diffable<ClusterState> {
    private final long version;           // 每次变更递增
    private final RoutingTable routingTable;  // 分片路由
    private final DiscoveryNodes nodes;   // 节点列表
    private final Metadata metadata;      // 索引元数据
    private final ClusterBlocks blocks;   // 集群锁
}
```

`version` 是核心设计——每次集群状态变更 version+1。节点通过 version 判断是否需要更新本地状态。`Diffable<ClusterState>` 接口允许差异化传输（只发送变更部分，而不是全量状态）。

### 2. Metadata：索引元数据的容器

`cluster/metadata/Metadata.java:99`：

```java
public class Metadata implements Iterable<IndexMetadata> {
    private final Settings transientSettings;     // 临时设置（重启丢失）
    private final Settings persistentSettings;    // 持久设置（重启保留）
    private final ImmutableOpenMap<String, IndexTemplateMetadata> templates;  // 索引模板
}
```

`IndexMetadata` 包含单个索引的全部配置（mapping、setting、别名等）。`templates` 管理索引模板（自动匹配新索引的配置）。`transientSettings` 重启丢失，`persistentSettings` 重启保留。

### 3. CoordinationState：Raft 风格共识

`cluster/coordination/CoordinationState.java:32`：

```java
public class CoordinationState {
    private final PersistedState persistedState;  // 持久化 currentTerm + lastAcceptedState
    private VoteCollection publishVotes;          // 发布投票收集
    // ...
    public long getCurrentTerm() { return persistedState.getCurrentTerm(); }
    public ClusterState getLastAcceptedState() { return persistedState.getLastAcceptedState(); }
}
```

核心字段：
- `persistedState`：持久化 `currentTerm`（当前任期）和 `lastAcceptedState`（最后接受的状态）
- `publishVotes`：发布投票收集，用于两阶段提交

`getCurrentTerm()`（L67）返回当前选举 term。`getLastAcceptedState()`（L71）返回最后被接受的状态。

### 4. 两阶段发布

Master 收到集群变更后：
1. 调用 `CoordinationState` 处理变更
2. 通过 `ClusterStatePublisher`（68 行）发布到所有节点
3. 每个节点收到后 apply 到本地
4. Master 收集多数节点确认后提交

`FollowerChecker`/`LeaderChecker` 负责心跳检测，`ClusterBootstrapService` 处理集群首次引导。

## 失败路径

- **脑裂**：网络分区后旧 Master 仍在运行，新 Master 被选出。旧 Master 的 term 低于新 Master，旧 Master 的写操作被拒绝（`CoordinationState` 的 term 比较）。
- **集群引导失败**：`ClusterBootstrapService` 配置错误导致集群无法形成 quorum。
- **状态版本冲突**：节点收到旧 version 的状态更新，拒绝 apply。

## 收网

ClusterState 是 ES 集群的权威状态，三层结构覆盖索引元数据（Metadata）、分片路由（RoutingTable）、节点列表（DiscoveryNodes）和集群锁（ClusterBlocks）。CoordinationState 用 Raft 风格 term-based 共识保证多数节点确认后才 commit。`version` 递增 + `Diffable` 差异化传输，保证状态变更高效传播。

## 下篇桥接

E-4 Routing 将展开 RoutingTable 怎么在分片级别路由请求。
ENDOFFILE