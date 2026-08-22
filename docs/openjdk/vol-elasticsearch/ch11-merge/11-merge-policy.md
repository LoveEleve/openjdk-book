# Elasticsearch 怎么合并 segment 以及控制合并线程

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第十一篇，回答段合并机制。

## 为什么需要段合并

每次 refresh 生成新 segment，大量小 segment 降低查询性能（查询需打开所有 segment）。段合并把小的 segment 合并成大 segment，并删除已标记删除的文档。

## 合并策略

`TieredMergePolicy`（Lucene 类，非 ES 代码）按大小分层合并——将大小接近的小 segment 合并为大 segment。`ElasticsearchConcurrentMergeScheduler` 限制 `maxThreadCount` + `maxMergeCount`，防止合并占用过多 IO 影响写入。

## 失败路径

- 合并线程数过高 → IO 竞争影响写入性能
- forceMerge 到 1 个 segment → 大 segment 后续维护成本高

## 收网

`ElasticsearchConcurrentMergeScheduler` 控制合并线程，`TieredMergePolicy` 按大小分层合并。`forceMerge` API 强制合并到指定 segment 数。

## 下篇桥接

E-9 BulkProcessor 批量写入。
ENDOFFILE