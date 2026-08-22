# 篇：08 Search 查询阶段：Dfs/Query/Fetch 三阶段查询

- 域：`E-2a Search 查询阶段`
- 卷：`vol-elasticsearch`
- 目标：回答协调节点到分片的分布式查询路径。

## 前置依赖

- HARD：已读 `E-1a Engine 写入路径`（知道 Engine 写入的数据）、`E-7 Mapping`（知道字段类型）。

## 读者问题

1. `SearchService.executeQueryPhase()` 和 `executeFetchPhase()` 各做什么？
2. Dfs/Query/Fetch 三阶段各自解决什么问题？
3. QueryPhase 返回什么？FetchPhase 返回什么？
4. 协调节点怎么把请求广播到所有相关分片？

## 主结论

ES 的分布式查询是 **协调节点广播 + 分片本地执行 + 协调节点合并** 的模式。`QueryPhase`（`search/query/QueryPhase.java`，270 行）让各分片执行 Lucene 搜索返回 doc_id+score（不返回 _source），`FetchPhase`（`search/fetch/FetchPhase.java`，378 行）根据 doc_id 拉取完整文档。DFS 用于三阶段查询的词频统计。

## 必须回填的源码锚点

- `search/SearchService.java:485` `executeDfsPhase()`
- `search/SearchService.java:522` `executeQueryPhase()`
- `search/SearchService.java:666` `executeQueryPhase()` 内部 + `executeFetchPhase()` 调用
- `search/query/QueryPhase.java:56` 类声明 + `:61` `execute()`
- `search/fetch/FetchPhase.java:49` 类声明 + `:59` `execute()`
- `search/dfs/DfsPhase.java:51` 类声明 + `:53` `execute()`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE