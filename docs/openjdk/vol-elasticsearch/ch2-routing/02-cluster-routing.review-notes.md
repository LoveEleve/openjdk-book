# vol-elasticsearch E-4 Routing — review notes

## 事实审
- `cluster/routing/RoutingTable.java:45` class RoutingTable ✅
- `cluster/routing/RoutingTable.java:49` version 字段 ✅
- `cluster/routing/RoutingTable.java:52` indicesRouting 映射 ✅
- `cluster/routing/ShardRouting.java:57` state 字段 ✅
- `cluster/routing/ShardRoutingState.java:15` class 枚举 + `:19`-`:32`（UNASSIGNED/INITIALIZING/STARTED/RELOCATING）✅
- `cluster/routing/OperationRouting.java:36` class OperationRouting ✅
- `cluster/routing/OperationRouting.java:63` getShards() ✅
- `cluster/routing/OperationRouting.java:269` Murmur3HashFunction.hash ✅
- `cluster/routing/allocation/decider/AllocationDeciders.java` 存在 ✅
- `cluster/routing/allocation/allocator/BalancedShardsAllocator.java` 存在 ✅

## 因果审
- RoutingTable version + indicesRouting 提供完整路由映射 ✅
- ShardRouting 4 种状态决定可用性 ✅
- OperationRouting 读 route round-robin / 写 route hash 到 Primary ✅

## 结构审
- 从"写入去哪个分片"困惑开场到 RoutingTable/ShardRouting/OperationRouting 主线集中 ✅

## 读者审
- 读完能回答：RoutingTable 怎么路由读写请求 ✅

## 依赖审
- 前置 E-10，后续 E-3 ✅

## 结论
E-4 通过六层审查。
ENDOFFILE