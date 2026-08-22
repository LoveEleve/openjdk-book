# 分布式搜索协调：协调节点怎么把分片结果合并

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第十七篇，回答搜索请求的完整链路。

## 困惑：搜索请求发到任意节点，但数据在多个分片，结果怎么合并？

`GET /my_index/_search?q=hello` 可能发到 node-2，但数据分布在 5 个分片上。协调节点怎么知道去哪些分片查、怎么合并各分片返回的结果？

## 总图：搜索协调的完整链路

```
TransportSearchAction
  → Routing 确定目标分片
    → AbstractSearchAsyncAction(广播到各分片)
      → 各分片执行 QueryPhase → 返回 doc_id+score
        → SearchPhaseController(合并各分片 topN)
          → FetchPhase 拉取完整文档
```

## 分层拆解

### 1. TransportSearchAction：入口

`action/search/TransportSearchAction.java:114`：

```java
public class TransportSearchAction extends HandledTransportAction<SearchRequest, SearchResponse> {
```

`executeSearch()`（`:1069`）解析请求，确定目标分片，启动搜索协调。

### 2. AbstractSearchAsyncAction：搜索协调基类

`action/search/AbstractSearchAsyncAction.java:67`：

```java
abstract class AbstractSearchAsyncAction<Result extends SearchPhaseResult>
    extends SearchPhase implements SearchPhaseContext {
```

`start()`（`:205`）是搜索协调的入口：广播到各分片 → 收集结果 → 触发下一阶段。

### 3. SearchPhaseController：合并结果

`action/search/SearchPhaseController.java:66`：

```java
public final class SearchPhaseController {
    public static List<DfsKnnResults> mergeKnnResults(...) {
        TopDocs mergedTopDocs = TopDocs.merge(request.source().knnSearch().get(i).k(), topDocsLists.get(i).toArray(new TopDocs[0]));
```

`SearchPhaseController` 负责合并各分片返回的 `TopDocs`。`TopDocs.merge()` 取各分片的 top N 结果，合并排序后取全局 top N。

## 收网

分布式搜索 = `TransportSearchAction` 入口 → `AbstractSearchAsyncAction` 广播 → `SearchPhaseController` 合并（`TopDocs.merge`）。协调节点不存数据，只负责路由请求和合并结果。

## 下篇桥接

E-17 Query DSL 与搜索优化。
ENDOFFILE