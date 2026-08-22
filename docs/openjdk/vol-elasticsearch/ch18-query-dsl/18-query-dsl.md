# Query DSL：BoolQuery 怎么把 JSON 结构编译成 Lucene 查询

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第十八篇，回答 ES 的查询类型。

## 困惑：`{"bool":{"must":[{"term":{"name":"x"}}],"filter":[{"range":{"age":{"gt":18}}}]}}` 怎么变成 Lucene 查询？

Query DSL 的 JSON 结构要通过 `QueryBuilder.toQuery()` 编译成 Lucene 的 `Query` 对象，才能被 `IndexSearcher` 执行。

## 分层拆解

### 1. BoolQueryBuilder：最常用的复合查询

`index/query/BoolQueryBuilder.java:40`：

```java
public class BoolQueryBuilder extends AbstractQueryBuilder<BoolQueryBuilder> {
```

`toQuery()`（`:325`）把子查询都编译成 Lucene Query，再组合成 `BooleanQuery.Builder`：

```java
Query luceneQuery = query.toQuery(context);  // 编译每个子查询
```

BoolQuery 的四种子句：
- **MUST**：必须匹配且贡献分数（`+`）
- **FILTER**：必须匹配但不贡献分数（`#`，可缓存）
- **SHOULD**：可选匹配（最多匹配一个也加分）
- **MUST_NOT**：必须不匹配（`-`）

### 2. FuzzyQueryBuilder：模糊查询

`index/query/FuzzyQueryBuilder.java:33`：

```java
public class FuzzyQueryBuilder extends AbstractQueryBuilder<FuzzyQueryBuilder>
    implements MultiTermQueryBuilder {
```

按 Levenshtein 编辑距离（最多 2 次编辑）匹配相似词——换字符（box→fox）、删字符、插字符、换序（act→cat）。

### 3. RescorePhase：重打分

`search/rescore/RescorePhase.java:26`：

```java
public static void execute(SearchContext context) {
```

QueryPhase 返回 top N 后，RescorePhase 用更复杂的打分公式重新排序非 top 的结果。

## 收网

Query DSL 通过 `QueryBuilder.toQuery()` 编译成 Lucene Query。`BoolQueryBuilder` 组合 MUST/FILTER/SHOULD/MUST_NOT。`FuzzyQueryBuilder` 按编辑距离模糊匹配。`RescorePhase` 在 Query 后优化排序。

## 下篇桥接

E-18 向量搜索/kNN。
ENDOFFILE