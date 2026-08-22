# vol-elasticsearch E-5 分片生命周期与复制 — review notes

## 事实审
- `index/shard/IndexShardState.java:11` enum + `:12`-`:17`（CREATED/RECOVERING/POST_RECOVERY/STARTED/CLOSED）✅
- `index/shard/ReplicationGroup.java:22` class + `:24` inSyncAllocationIds ✅
- `index/seqno/SequenceNumbers.java:16` class + `:23` UNASSIGNED_SEQ_NO ✅
- `action/support/replication/ReplicationOperation.java:48` class + `:126` perform() ✅
- `index/shard/GlobalCheckpointSyncer.java` 25 行 ✅

## 因果审
- 5 种状态决定分片可用性 ✅
- ReplicationGroup 维护副本集合 ✅
- ReplicationOperation Primary→Replicas 复制 ✅
- SeqNo + GlobalCheckpoint 保证一致性 ✅

## 结构审
- 从"分片不是一直活着"困惑开场到状态/复制/SeqNo 主线集中 ✅

## 读者审
- 读完能回答：IndexShard 的 5 种状态和复制协议 ✅

## 依赖审
- 前置 E-1a/E-4，后续 E-7 ✅

## 结论
E-5 通过六层审查。
ENDOFFILE