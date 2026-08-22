# Bulk API 怎么做批量写入

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第十二篇，回答 Bulk 批量写入。

## 批量写入流程

Bulk API 的 NDJSON 格式：`{"index":{"_id":"1"}}\n{"field":"value"}\n` → `TransportBulkAction` 预检 index/delete/create → 按 shard 分组(`BulkShardRequest`) → 每个 shard 内部 apply 多条操作。

## 批量优化

- 按 shard 聚合同一节点批操作
- 顺序执行非冲突操作（同一 doc 的多个操作需排序）
- `pipeline` 预处理器在 write 阶段前执行

## 收网

BulkProcessor 封装批量写入流程，TransportBulkAction 预检 → 按 shard 分组 → 逐条 apply。批量优化通过按 shard 聚合和 pipeline 预处理实现。

## 下篇桥接

E-11 FieldData 聚合/排序性能。
ENDOFFILE