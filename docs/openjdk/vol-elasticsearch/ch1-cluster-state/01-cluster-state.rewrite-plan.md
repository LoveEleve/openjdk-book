# 篇：01 ClusterState 集群状态：ES 分布式协调的基础设施

- 域：`E-10 ClusterState 与协调层`
- 卷：`vol-elasticsearch`
- 目标：回答 ClusterState 的三层结构、CoordinationState 的 Raft 风格共识、两阶段发布。

## 前置依赖

- HARD：了解 ES 的分片、索引、节点概念。
- SOFT：了解 Raft 共识的基本概念（term、选举、日志复制）。

## 读者问题

1. `ClusterState` 包含哪几层？`version` 字段解决什么？
2. `CoordinationState` 怎么实现 Raft 风格共识？
3. 两阶段发布（publish）怎么让所有节点拿到一致状态？
4. `Metadata` 和 `RoutingTable` 各自存什么？
5. Follower/Leader 心跳怎么检测故障？

## 主结论

ClusterState（1195 行）是 ES 集群的**权威状态**，包含 Metadata（索引元数据）+ RoutingTable（分片路由）+ ClusterBlocks（集群锁）。CoordinationState（656 行）用 Raft 风格 term-based 共识保证状态一致：Master 收到变更 → CoordinationState → ClusterStatePublisher 发布到所有节点。

## 结构设计

1. 困惑开场：ES 怎么让所有节点拿着同一份状态
2. ClusterState 三层结构
3. version 字段与 Diffable 机制
4. Metadata 元数据
5. RoutingTable 路由表
6. CoordinationState Raft 风格共识
7. 两阶段发布
8. 失败路径
9. 收网与下篇桥接 E-4 Routing

## 必须回填的源码锚点

- `cluster/ClusterState.java:110` 类声明
- `cluster/ClusterState.java:156` `version` 字段
- `cluster/ClusterState.java:166` `routingTable` 字段
- `cluster/ClusterState.java:175` `metadata` 字段
- `cluster/coordination/CoordinationState.java:32` 类声明
- `cluster/coordination/CoordinationState.java:67` `getCurrentTerm()`
- `cluster/coordination/CoordinationState.java:71` `getLastAcceptedState()`
- `cluster/metadata/Metadata.java:99` 类声明
- `cluster/metadata/Metadata.java:212` `transientSettings` / `persistentSettings`
- `cluster/coordination/ClusterStatePublisher.java:68`（发布接口）

## 必须引用的测试/证据

- `test/framework` 中 ClusterState 测试
- `server/src/test/` 的 coordination 测试

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
ENDOFFILE