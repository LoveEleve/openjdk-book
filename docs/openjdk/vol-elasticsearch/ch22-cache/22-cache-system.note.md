# vol-elasticsearch E-22 缓存体系 — note

## 本篇主张
- Query Cache（`IndicesQueryCache` 389 行）缓存 FILTER 子句的 doc_id 集合，节点级。
- Request Cache（`IndicesRequestCache` 354 行）缓存分片级查询结果，`size=0` 时典型。
- Field Data Cache（`IndicesFieldDataCache` 256 行）缓存字段数据，断路器限制 40% JVM heap。

## 卷级闭合
- vol-elasticsearch 全部 22 个域完成。
