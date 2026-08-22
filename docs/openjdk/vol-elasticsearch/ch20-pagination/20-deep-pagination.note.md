# vol-elasticsearch E-20 深度分页 — note

## 本篇主张
- `from+size` 深度分页性能差因为协调节点需要从各分片取 `from+size` 条再合并排序。
- Scroll 保持 SearchContext 快照，`SearchScrollAsyncAction` 处理滚动请求。
- SearchAfter 用上一页的 sort 值做游标，`SearchAfterBuilder`（292 行）构建请求。
- `SearchAfterSortedDocQuery`（170 行）在 Lucene 层面跳过已读文档。

## 下篇桥接
- E-21 GEO 地理查询。
