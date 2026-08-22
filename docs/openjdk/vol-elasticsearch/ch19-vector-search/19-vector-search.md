# 向量搜索/kNN：ES 8.x 怎么按向量相似度检索

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第十九篇，回答向量搜索。

## 困惑：`dense_vector` 字段怎么被 `knn` 查询检索？

ES 8.x 的 `dense_vector` 字段存浮点数向量（如 embedding 的 768 维）。`knn` 查询按向量相似度（cosine/dot_product/l2）返回最相似的文档，不用传统倒排索引。

## 分层拆解

### 1. KnnVectorQueryBuilder：向量查询构建器

`search/vectors/KnnVectorQueryBuilder.java:51`：

```java
public class KnnVectorQueryBuilder extends AbstractQueryBuilder<KnnVectorQueryBuilder> {
    public static final ParseField VECTOR_SIMILARITY_FIELD = new ParseField("similarity");
```

`fromXContent`（`:90`）解析 JSON 里的查询参数。支持 `similarity` 参数（cosine/dot_product/l2）。

### 2. KnnScoreDocQuery：向量评分查询

`search/vectors/KnnScoreDocQuery.java:35`：

```java
public class KnnScoreDocQuery extends Query {
    private final float[] scores;
    ...
    public KnnScoreDocQuery(float[] scores, int[] docs, int[] segmentStarts) {
```

持有预计算的分数，匹配指定 docs 并打分数。

### 3. 执行位置：DfsPhase

`search/dfs/DfsPhase.java:56` + `:175`：

```java
public void execute(SearchContext context) {
    executeKnnVectorQuery(context);   // kNN 在 DFS 阶段执行
}
```

向量搜索在 `executeKnnVectorQuery`（`:175`）中执行，用 Lucene 的 HNSW 索引做近似最近邻搜索——不是精确扫描，而是用图结构近似查找。

## 收网

向量搜索通过 `dense_vector` 字段 + `KnnVectorQueryBuilder` 实现。kNN 在 DfsPhase 的 `executeKnnVectorQuery`（`DfsPhase.java:175`）执行，用 HNSW 算法做近似最近邻。`KnnScoreDocQuery` 持有预计算分数。

## 卷级闭合

vol-elasticsearch 全部 19 个域完成。
ENDOFFILE