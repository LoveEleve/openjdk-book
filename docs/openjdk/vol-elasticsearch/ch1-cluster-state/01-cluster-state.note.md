# vol-elasticsearch E-10 ClusterState — note

## 本篇主张

- ClusterState 是 ES 集群的权威状态，包含 Metadata（索引元数据）+ RoutingTable（分片路由）+ DiscoveryNodes（节点列表）+ ClusterBlocks（集群锁）。
- `version` 字段每次变更递增，`Diffable` 接口支持差异化传输。
- CoordinationState 用 Raft 风格 term-based 共识保证状态一致：`getCurrentTerm()` 和 `getLastAcceptedState()` 是核心方法。
- 两阶段发布：Master 变更 → ClusterStatePublisher 发布 → 多数节点确认 → commit。

## 本篇边界

- 不展开 RoutingTable 的详细路由算法（E-4 覆盖）。
- 不展开 FollowerChecker/LeaderChecker 的完整心跳逻辑。

## 下篇桥接

- E-4 Routing 将展开 RoutingTable 的分片路由算法。
ENDOFFILE