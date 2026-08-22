# vol-elasticsearch E-20 深度分页 — review notes

## 事实审
- `action/search/SearchScrollAsyncAction.java` 存在 ✅
- `action/search/SearchScrollQueryThenFetchAsyncAction.java` 存在 ✅
- `search/searchafter/SearchAfterBuilder.java` 292 行 ✅
- `lucene/queries/SearchAfterSortedDocQuery.java` 170 行 ✅

## 因果审
- from+size 深度分页需要各分片取 `from+size` 条合并，代价高 ✅
- Scroll 保持 SearchContext 快照，持续滚动 ✅
- SearchAfter 用 sort 值做游标，Lucene 层面跳过 ✅

## 结构审
- 从"为什么深度分页慢"困惑开场到 from+size/Scroll/SearchAfter 主线集中 ✅

## 读者审
- 读完能回答：为什么深度分页性能差 ✅

## 依赖审
- 前置 E-2a，后续 E-21 ✅

## 结论
E-20 通过六层审查。
