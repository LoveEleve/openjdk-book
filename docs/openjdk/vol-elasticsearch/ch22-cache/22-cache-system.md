# ES 的三种缓存：Query Cache / Request Cache / Field Data Cache

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第二十二篇，回答 ES 缓存体系。

## 困惑：ES 搜索这么快，数据是从磁盘读还是从缓存读？

ES 不只靠倒排索引快，还有多层缓存。Query Cache 缓存 filter 结果，Request Cache 缓存查询结果，Field Data Cache 缓存排序/聚合数据。

## 分层拆解

### 1. Query Cache（节点级）：缓存 filter 后的 doc_id 集合

`indices/IndicesQueryCache.java`（389 行）缓存 FILTER 上下文的查询结果。`BoolQuery` 的 `FILTER` 子句不贡献分数但可缓存——第一次查询后缓存 doc_id 集合，相同 filter 再次查询时直接复用。

失效条件：segment 合并、refresh、索引写入。

### 2. Request Cache（分片级）：缓存查询结果

`indices/IndicesRequestCache.java`（354 行）缓存分片级别查询结果（包括 `hits.total`、`aggregations`、`suggestions`）。`size=0` 的查询（只 count 不返回文档）是典型场景。

失效条件：segment 合并、refresh、索引写入。

### 3. Field Data Cache（节点级）：缓存字段数据

`indices/fielddata/cache/IndicesFieldDataCache.java`（256 行）缓存 DocValues 加载后的字段数据（用于排序/聚合）。`fielddata.breaker.limit` 控制 JVM heap 40% 上限，超限抛 `CircuitBreakingException`。

失效条件：heap 压力触发 GC 回收，断路器超限拒绝查询。

## 收网

ES 三层缓存：Query Cache（filter 结果）、Request Cache（查询结果）、Field Data Cache（字段数据）。Query 和 Request 缓存随 segment 生命周期失效，Field Data 缓存受断路器限制。

## 卷级闭合

vol-elasticsearch 全部 22 个域完成。
