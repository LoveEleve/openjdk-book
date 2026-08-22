# vol-elasticsearch E-4 Routing — note

## 本篇主张

- RoutingTable 的 `version + indicesRouting` 提供索引→分片→节点的映射。
- ShardRouting 的 4 种状态（UNASSIGNED/INITIALIZING/STARTED/RELOCATING）决定分片可用性。
- OperationRouting 读路由 round-robin 到副本，写路由 `routing=_id` 的 Murmur3 hash 到 Primary。
- AllocationDeciders + BalancedShardsAllocator 决定分片分配策略。

## 下篇桥接

- E-3 Translog WAL 写入日志。
ENDOFFILE