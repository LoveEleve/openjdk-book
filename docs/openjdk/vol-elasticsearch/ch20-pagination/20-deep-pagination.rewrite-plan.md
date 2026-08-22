# 篇：20 深度分页：Scroll/SearchAfter 与 from+size 的代价

- 域：`E-20 深度分页(Scroll/SearchAfter)`
- 卷：`vol-elasticsearch`
- 目标：回答为什么深度分页性能差，Scroll 和 SearchAfter 怎么解决。

## 前置依赖
- HARD：已读 `E-2a Search 查询阶段`（知道 QueryPhase 返回 TopDocs）。

## 读者问题
1. `from+size` 为什么深度分页性能差？
2. Scroll 怎么保持搜索上下文？
3. SearchAfter 怎么用上一页的最后文档做下一页？
4. SearchContext 的持有时长和清理机制？

## 主结论
`from+size` 深度分页性能差因为协调节点需要从各分片取 `from+size` 个结果再合并，取前 1000 条也需要查 100*1000 条再排序。Scroll 保持 `SearchContext` 快照，SearchAfter 用上一页的 sort 值做下一页。

## 结构设计
1. 困惑开场：为什么 `from=1000&size=10` 比 `from=0&size=10` 慢很多
2. from+size 的代价
3. Scroll 机制
4. SearchAfter 机制

## 必须回填的源码锚点
- `action/search/SearchScrollAsyncAction.java` Scroll 异步协调
- `action/search/SearchScrollQueryThenFetchAsyncAction.java` Scroll 执行
- `search/searchafter/SearchAfterBuilder.java`（292 行）SearchAfter 构建器
- `lucene/queries/SearchAfterSortedDocQuery.java`（170 行）SearchAfter Lucene 查询

## note / review 约束
- 四件套标准格式。
