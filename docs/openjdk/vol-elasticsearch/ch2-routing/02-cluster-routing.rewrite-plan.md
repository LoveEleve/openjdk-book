# 篇：02 Cluster Routing：分片路由与请求分发

- 域：`E-4 Cluster Routing—分片路由`
- 卷：`vol-elasticsearch`
- 目标：回答 RoutingTable 怎么路由请求到正确分片。

## 前置依赖

- HARD：已读 `E-10 ClusterState`（RoutingTable 是 ClusterState 的一部分）。

## 读者问题

1. RoutingTable 的 `version` 和 `indicesRouting` 各管什么？
2. ShardRouting 的 4 种状态（UNASSIGNED/INITIALIZING/STARTED/RELOCATING）分别代表什么？
3. OperationRouting 怎么根据 `preference` 和 `routing` 选目标分片？
4. 写路由和读路由有什么区别？
5. AllocationDeciders 和 BalancedShardsAllocator 怎么分配分片？

## 主结论

RoutingTable（654 行）是 ClusterState 的路由层，`version` 每次变更递增。ShardRouting 的 4 种状态决定分片当前可用性。OperationRouting 根据 `preference` 和 `routing` 参数选择目标分片——读路由 round-robin 到任意副本，写路由 `routing=_id` 的 hash 固定到 Primary。

## 必须回填的源码锚点

- `cluster/routing/RoutingTable.java:45` 类声明
- `cluster/routing/RoutingTable.java:49` `version` 字段
- `cluster/routing/RoutingTable.java:52` `indicesRouting` 映射
- `cluster/routing/ShardRouting.java:57` `state` 字段
- `cluster/routing/ShardRoutingState.java:15` 枚举 + `:19`-`:32`（UNASSIGNED/INITIALIZING/STARTED/RELOCATING）
- `cluster/routing/OperationRouting.java:36` 类声明
- `cluster/routing/OperationRouting.java:63` `getShards()` 路由入口
- `cluster/routing/OperationRouting.java:269` `Murmur3HashFunction.hash(preference)`
- `cluster/routing/allocation/decider/AllocationDeciders.java` 决策器
- `cluster/routing/allocation/allocator/BalancedShardsAllocator.java` 平衡分配器

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE