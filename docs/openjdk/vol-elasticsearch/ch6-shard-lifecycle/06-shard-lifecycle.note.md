# vol-elasticsearch E-5 分片生命周期与复制 — note

## 本篇主张

- IndexShard 的 5 种状态（CREATED→RECOVERING→POST_RECOVERY→STARTED→CLOSED）是分片的完整生命周期。
- ReplicationGroup 的 `inSyncAllocationIds`（已同步）和 `trackedAllocationIds`（跟踪中）维护副本集合。
- ReplicationOperation：Primary 执行 → 按 seqNo 顺序复制到 Replicas → 收集 ack。
- SeqNo 递增 + GlobalCheckpoint 保证主副本一致性。

## 下篇桥接

- E-7 Mapping 文档映射。
ENDOFFILE