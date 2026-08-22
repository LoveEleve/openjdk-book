# 一次 ES 搜索请求穿过哪些阶段

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第八篇，回答 ES 分布式查询的三阶段路径。

## 困惑：一次 `_search` 请求，协调节点到底做了什么？

`GET /my_index/_search?q=hello` 发送到任意节点，但数据分散在多个分片、多个节点上。协调节点要把请求广播到所有相关分片，收集结果再合并返回。这个"广播 + 收集 + 合并"的过程就是三阶段查询。

## 总图：三阶段查询路径

```
协调节点
  ├── DFS阶段(可选,三阶段查询): 收集词频
  ├── Query阶段: 广播到所有相关分片 → 各分片执行 Lucene 搜索
  │     └── 返回 doc_id + score(不返回 _source)
  └── Fetch阶段: 根据 doc_id 从分片拉取完整文档
        └── _source / stored_fields / highlight
```

## 分层拆解

### 1. SearchService.executeQueryPhase()：广播查询

`search/SearchService.java:522`：

```java
public void executeQueryPhase(ShardSearchRequest request, SearchShardTask task, ActionListener<SearchPhaseResult> listener) {
    // 分片执行查询 → 返回 SearchPhaseResult(doc_id + score)
}
```

`executeQueryPhase()` 内部（`SearchService.java:666`）调用 `QueryPhase.execute()` 执行 Lucene 搜索。协调节点把请求广播到分片，各分片在本地执行查询，返回 `doc_id + score`（不包含 _source）。

### 2. QueryPhase：分片本地搜索

`search/query/QueryPhase.java:56` + `:61`：

```java
public class QueryPhase {
    public static void execute(SearchContext searchContext) throws QueryPhaseExecutionException {
        // 执行 Lucene IndexSearcher.search(query, collector)
        // 返回 TopDocs(doc_id + score)
    }
}
```

QueryPhase 的关键：
- 执行 Lucene `IndexSearcher.search(Query, Collector)`
- 返回 doc_id + score（TopDocs）
- **不返回 _source**（性能优化，_source 很大）

### 3. FetchPhase：拉取完整文档

`search/fetch/FetchPhase.java:49` + `:59`：

```java
public final class FetchPhase {
    public void execute(SearchContext context, int[] docIdsToLoad) {
        // 根据 doc_id 从分片拉取完整文档
        // _source / stored_fields / highlight
    }
}
```

FetchPhase 根据 QueryPhase 返回的 doc_id 从分片拉取完整文档内容。因为查询阶段只返回 doc_id+score，需要 FetchPhase 补充 _source/stored_fields/highlight。

### 4. DfsPhase：分布式词频

`search/dfs/DfsPhase.java:51` + `:53`：

```java
public class DfsPhase {
    public void execute(SearchContext context) {
        // 收集全局词频，用于跨分片一致性打分
    }
}
```

DFS（Distributed Frequency Search）用于三阶段查询——先收集词频，再 Query，再 Fetch。默认两阶段查询（Query+Fetch）不收集全局词频，保证了查询性能但分数略不精确。

## 失败路径

- 某个分片查询失败 → 协调节点收不到该分片结果，可能返回部分结果或失败
- Fetch 阶段分片间 doc_id 冲突 → 协调节点需要处理
- 超时设置 `timeout` 参数 → 部分分片未返回，协调节点返回超时标记

## 收网

ES 的分布式查询是"协调节点广播 + 分片本地执行 + 协调节点合并"模式。`QueryPhase`（`search/query/`）执行 Lucene 搜索返回 doc_id+score，`FetchPhase`（`search/fetch/`）根据 doc_id 拉取完整文档，`DfsPhase`（`search/dfs/`）收集全局词频用于三阶段查询。查询阶段只返回 doc_id，Fetch 阶段补充 _source——这是性能优化的关键设计。

## 下篇桥接

E-2b 打分与 Query 重写。
ENDOFFILE