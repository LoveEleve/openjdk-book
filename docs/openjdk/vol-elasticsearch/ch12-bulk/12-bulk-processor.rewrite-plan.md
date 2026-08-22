# 篇：12 BulkProcessor 批量写入

- 域：`E-9 BulkProcessor 批量写入`
- 卷：`vol-elasticsearch`
- 目标：回答 Bulk API 怎么做批量写入。

## 前置依赖

- HARD：已读 `E-1a Engine 写入路径`（知道单条写入路径）。

## 读者问题

1. Bulk API 的 NDJSON 格式怎么解析？
2. BulkRequest 怎么按 shard 分组？
3. 批量优化在哪些环节？

## 主结论

Bulk API 的 NDJSON 格式 → `TransportBulkAction` 预检 → 按 shard 分组(`BulkShardRequest`) → 每个 shard 内部 apply 多条操作。`BulkProcessor`(540行) 封装这个流程。

## 必须回填的源码锚点

- `action/bulk/TransportShardBulkAction.java` 存在
- `action/bulk/BulkProcessor.java` 存在

## note / review 约束

- 四件套标准格式。
ENDOFFILE