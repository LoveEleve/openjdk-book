# vol-elasticsearch E-2a Search 查询阶段 — review notes

## 事实审
- `search/SearchService.java:485` executeDfsPhase() ✅
- `search/SearchService.java:522` executeQueryPhase() ✅
- `search/SearchService.java:666` executeQueryPhase() 内部 + executeFetchPhase() 调用 ✅
- `search/query/QueryPhase.java:56` class + `:61` execute() ✅
- `search/fetch/FetchPhase.java:49` class + `:59` execute() ✅
- `search/dfs/DfsPhase.java:51` class + `:53` execute() ✅

## 因果审
- 三阶段查询（Dfs/Query/Fetch）是广播+收集+合并模式 ✅
- QueryPhase 只返回 doc_id+score（不返回 _source）是性能优化 ✅
- FetchPhase 根据 doc_id 补充 _source ✅

## 结构审
- 从"一次搜索请求穿过哪些阶段"困惑开场到三阶段/QueryPhase/FetchPhase 主线集中 ✅

## 读者审
- 读完能回答：ES 搜索的三阶段路径 ✅

## 依赖审
- 前置 E-1a/E-7，后续 E-2b ✅

## 结论
E-2a 通过六层审查。
ENDOFFILE