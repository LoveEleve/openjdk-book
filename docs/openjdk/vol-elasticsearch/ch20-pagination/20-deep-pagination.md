# 为什么深度分页性能差——Scroll 与 SearchAfter

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第二十篇，回答深度分页。

## 困惑：为什么 `from=1000&size=10` 比 `from=0&size=10` 慢很多？

直觉上，只是跳过 1000 条而已，应该很快。但实际 ES 需要从每个分片取 1010 条，在协调节点合并排序后再取最后 10 条。分片越多、from 越大，性能越差。

## 总图：两种深度分页方案

```
from+size:   协调节点取 1010×N 条 → 合并排序 → 取最后 10 条
Scroll:      保持 SearchContext 快照 → 每次滚动取下一批
SearchAfter: 记录上一页最后文档的 sort 值 → 下一页从该值开始
```

## 分层拆解

### 1. from+size 的代价

`from=1000, size=10` 在 5 个分片上的代价：每个分片执行 QueryPhase 返回 1010 条 → 协调节点 `SearchPhaseController` 合并 5050 条 → 排序后取最后 10 条。from 越大，各分片返回越多，合并排序越慢。

### 2. Scroll：保持搜索上下文快照

`action/search/SearchScrollAsyncAction.java` 处理 Scroll 请求。`SearchScrollQueryThenFetchAsyncAction` 执行 Query+Fetch。Scroll 保持 `SearchContext`（包括结果集快照），在滚动期间不释放。`search.keep_alive` 控制上下文保持时长。

### 3. SearchAfter：基于排序值的游标

`search/searchafter/SearchAfterBuilder.java`（292 行）构建 SearchAfter 请求。`lucene/queries/SearchAfterSortedDocQuery.java`（170 行）是 Lucene 查询实现，用上一页最后文档的 sort 值作为起点，在 Lucene 层面跳过已读文档。

## 收网

`from+size` 深度分页性能差是因为协调节点需要从各分片取 `from+size` 条再合并。Scroll 保持 SearchContext 快照，SearchAfter 用 sort 值做游标。生产深度分页推荐 SearchAfter。

## 下篇桥接

E-21 GEO 地理查询。
