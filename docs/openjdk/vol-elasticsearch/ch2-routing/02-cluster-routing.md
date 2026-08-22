# RoutingTable 怎么把请求路由到正确的分片

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第二篇，回答 RoutingTable 和 OperationRouting 的路由机制。

## 困惑：写入一个文档，ES 怎么知道该去哪个分片？

`PUT /my_index/_doc/1 {"title":"hello"}` 发送到任意节点，但最终只有 Primary 分片会执行写入。ES 怎么知道该去哪个分片？

## 分层拆解

### 1. RoutingTable：索引→分片→节点的映射

`cluster/routing/RoutingTable.java:45`：

```java
public class RoutingTable implements Iterable<IndexRoutingTable>, Diffable<RoutingTable> {
    private final long version;
    private final ImmutableOpenMap<String, IndexRoutingTable> indicesRouting;
}
```

`version` 每次路由变更递增，节点通过 version 判断路由表是否过时。`indicesRouting` 从索引名映射到 `IndexRoutingTable`（索引级分片分布）。

### 2. ShardRouting 的 4 种状态

`ShardRoutingState.java:15` 枚举（`ShardRoutingState.java:19`-`:32`）：

- **UNASSIGNED**：分片未分配到任何节点
- **INITIALIZING**：分片正在初始化（从 peer 或 gateway 恢复）
- **STARTED**：分片已启动，可提供服务
- **RELOCATING**：分片正在迁移到其他节点

`ShardRouting.java:57` `state` 字段存储当前状态。只有 STARTED 的分片才能处理读写请求。

### 3. OperationRouting：读路由 vs 写路由

`cluster/routing/OperationRouting.java:36`：

- **读路由**（`getShards()` L63）：根据 `preference` 参数选目标分片——默认 round-robin 到任意副本。`_preference=_local` 优先本地分片，`_preference=_shards:0` 指定分片。
- **写路由**（`getShards()` L75）：`routing=_id` 的 hash 确定目标分片，只发 Primary。

`OperationRouting.java:269`：

```java
int routingHash = 31 * Murmur3HashFunction.hash(preference) + indexShard.shardId.hashCode();
```

`routing` 参数（默认 `_id`）通过 `Murmur3HashFunction` 计算 hash → `hash % numShards` 确定目标 shard。

### 4. AllocationDeciders 和 BalancedShardsAllocator

分片分配由 `AllocationDeciders`（10+ 决策器）和 `BalancedShardsAllocator` 算法决定。决策器包括磁盘阈值、副本数、热/冷节点等。`BalancedShardsAllocator` 平衡分片在各节点上的分布。

## 失败路径

- 指定了不存在的 `routing` 值 → 写操作路由到错误 shard（创建新 shard 不可用）
- 分片处于 UNASSIGNED 或 INITIALIZING → 读操作返回空，写操作等待
- 分片 RELOCATING 期间 → 读写路由到目标节点

## 收网

RoutingTable 的 `version + indicesRouting` 提供索引→分片→节点的完整映射。ShardRouting 的 4 种状态决定分片可用性。OperationRouting 根据 `preference` 和 `routing` 参数选择目标分片，读路由 round-robin 到副本，写路由 hash 到 Primary。AllocationDeciders + BalancedShardsAllocator 决定分片分配策略。

## 下篇桥接

E-3 Translog WAL 写入日志。
ENDOFFILE