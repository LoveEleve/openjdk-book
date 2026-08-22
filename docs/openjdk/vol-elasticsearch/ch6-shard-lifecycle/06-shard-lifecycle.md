# IndexShard 怎么从创建到关闭，数据怎么复制

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第六篇，回答分片生命周期和复制协议。

## 困惑：分片不是"一直活着"的，它有自己的状态机

直觉上，分片创建后就直接服务读写请求了。但实际 ES 的分片有 5 种状态，只有 STARTED 才能服务读写。而且 Primary 写入后，数据要复制到 Replicas，怎么保证一致性？

## 分层拆解

### 1. IndexShard 的 5 种状态

`index/shard/IndexShardState.java:11`：

```java
public enum IndexShardState {
CREATED((byte) 0),        // 创建完成
     RECOVERING((byte) 1),     // 正在恢复（从 peer 或本地）
     POST_RECOVERY((byte) 2),  // 恢复完成
     STARTED((byte) 3),        // 已启动，可服务读写
     // 4 曾是 RELOCATED，已移除
     CLOSED((byte) 5);         // 已关闭
}
```

`IndexShard`（4242 行）是分片的运行时核心，包含：
- **Engine**（InternalEngine）：Lucene Engine
- **Translog**：WAL
- **Store**：文件存储
- **ShardPath**：磁盘目录

只有 STARTED 状态的分片才处理读写请求。

### 2. ReplicationGroup：复制组

`index/shard/ReplicationGroup.java:22`：

```java
public class ReplicationGroup {
    private final Set<String> inSyncAllocationIds;   // 已同步副本集合
    private final Set<String> trackedAllocationIds;   // 跟踪中的副本
}
```

- `inSyncAllocationIds`：已确认与 Primary 数据的副本集合
- `trackedAllocationIds`：正在恢复/跟踪的副本集合

只有 `inSyncAllocationIds` 中的副本才参与复制。

### 3. ReplicationOperation：复制协议

`action/support/replication/ReplicationOperation.java:48`：

```java
public class ReplicationOperation<...> {
    public void execute() {
        primary.perform(request, listener);  // ① Primary 先执行
    }
    private void performOnReplicas(...) {     // ② Primary 完成后复制到 Replicas
        performOnReplica(shard, replicaRequest, globalCheckpoint, maxSeqNoOfUpdatesOrDeletes, ...);
    }
}
```

流程：
1. `primary.perform()`：Primary 先执行操作
2. `performOnReplicas()`：收集 `inSyncAllocationIds` 中的副本
3. `performOnReplica()`：按 seqNo 顺序逐个 apply 到每个副本
4. 收集 ack，达到 `wait_for_active_shards` 数量后确认成功

### 4. SeqNo 和 GlobalCheckpoint

`index/seqno/SequenceNumbers.java:16`：

```java
public class SequenceNumbers {
    public static final long UNASSIGNED_SEQ_NO = -2L;
    public static final long NO_OPS_PERFORMED = -1L;
}
```

- **SeqNo 递增**：每次写入 Engine 分配递增的 seqNo，主副分片共享同一序列
- **PrimaryTerm**：主分片每次当选获得新 primaryTerm，防止老主继续写入
- **GlobalCheckpoint**：所有活跃副本中已确认完成的最小 seqNo——peer recovery 从此位置开始

`GlobalCheckpointSyncer`（25 行，`index/shard/`）定期同步 GlobalCheckpoint。

## 失败路径

- Primary 故障 → 新的 Primary 从 GlobalCheckpoint 恢复，未确认的操作丢失
- 网络分区 → 副本无法 ack → Primary 阻塞直到超时
- 副本长时间不同步 → 从 `inSyncAllocationIds` 移除 → 后续 peer recovery

## 收网

IndexShard 的 5 种状态（CREATED→RECOVERING→POST_RECOVERY→STARTED→CLOSED）是分片的完整生命周期。ReplicationGroup 的 `inSyncAllocationIds`/`trackedAllocationIds` 维护副本集合。ReplicationOperation 在 Primary 执行后按 seqNo 复制到 Replicas，收集 ack 确认。SeqNo 递增 + GlobalCheckpoint 保证主副本一致性。

## 下篇桥接

E-7 Mapping 文档映射。
ENDOFFILE