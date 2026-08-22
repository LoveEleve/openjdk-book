# vol-elasticsearch E-16 分布式搜索协调 — note

## 本篇主张

- 搜索协调 = `TransportSearchAction` 入口 → `AbstractSearchAsyncAction` 广播 → `SearchPhaseController` 合并。
- `SearchPhaseController.java:66` 负责合并各分片的 TopDocs，`TopDocs.merge()` 取全局 top N。
- 协调节点不存数据，只负责路由和合并。

## 下篇桥接

- E-17 Query DSL 与搜索优化。
ENDOFFILE