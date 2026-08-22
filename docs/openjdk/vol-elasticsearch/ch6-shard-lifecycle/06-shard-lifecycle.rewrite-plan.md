# 篇：06 分片生命周期与复制协议

- 域：`E-5 分片生命周期与复制`
- 卷：`vol-elasticsearch`
- 目标：回答 IndexShard 的 5 种状态和 ReplicationOperation 的复制协议。

## 前置依赖

- HARD：已读 `E-1a Engine 写入路径`（知道 Engine 在 IndexShard 内）、`E-4 Routing`（知道 ShardRouting）。

## 读者问题

1. IndexShard 的 5 种状态（CREATED/RECOVERING/POST_RECOVERY/STARTED/CLOSED）各代表什么？
2. ReplicationGroup 的 inSyncAllocationIds 和 trackedAllocationIds 各管什么？
3. ReplicationOperation 怎么在 Primary 和 Replicas 间复制？
4. SeqNo 和 GlobalCheckpoint 怎么保证数据一致性？

## 主结论

IndexShard 的 5 种状态决定分片从创建到关闭的完整生命周期。ReplicationGroup 维护已同步副本集合。ReplicationOperation 将操作从 Primary 序列化发送到 Replicas，SeqNo 递增 + GlobalCheckpoint 保证所有副本一致性。

## 必须回填的源码锚点

- `index/shard/IndexShardState.java:11` 枚举 + `:12`-`:17`（CREATED/RECOVERING/POST_RECOVERY/STARTED/CLOSED）
- `index/shard/ReplicationGroup.java:22` 类声明 + `:24` inSyncAllocationIds
- `index/seqno/SequenceNumbers.java:16` 类声明 + `:23` UNASSIGNED_SEQ_NO
- `action/support/replication/ReplicationOperation.java:48` 类声明 + `:126` perform()
- `index/shard/GlobalCheckpointSyncer.java` 25 行

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE