# vol-elasticsearch E-2a Search 查询阶段 — note

## 本篇主张

- ES 分布式查询 = 协调节点广播 + 分片本地执行 + 协调节点合并。
- `QueryPhase`（`search/query/QueryPhase.java:56`）执行 Lucene 搜索返回 doc_id+score，**不返回 _source**。
- `FetchPhase`（`search/fetch/FetchPhase.java:49`）根据 doc_id 拉取 _source/stored_fields/highlight。
- `DfsPhase`（`search/dfs/DfsPhase.java:51`）收集全局词频用于三阶段查询。
- 两阶段（Query+Fetch）是默认模式，三阶段（Dfs+Query+Fetch）需要显式指定。

## 下篇桥接

- E-2b 打分与 Query 重写。
ENDOFFILE