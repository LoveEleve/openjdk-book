# 篇：09 打分与 Query 重写：BM25 与 Lucene 查询扩展

- 域：`E-2b 打分与 Query 重写`
- 卷：`vol-elasticsearch`
- 目标：回答 ES 怎么用 BM25 打分，以及自定义 Query 怎么扩展 Lucene。

## 前置依赖

- HARD：已读 `E-2a Search 查询阶段`（知道 QueryPhase 执行搜索）、`E-12 Lucene 集成层`（lucene/ 包）。

## 读者问题

1. ES 的 BM25 相似度怎么配置？默认 k1/b 值是多少？
2. `LegacyBM25Similarity` 是 ES 定制还是 Lucene 自带？
3. 自定义 Query（如 `BinaryDocValuesRangeQuery`）怎么扩展 `createWeight` / `scorer`？
4. 文档长度归一化怎么影响打分？

## 主结论

ES 的 BM25 相似度通过 `index/similarity/SimilarityProviders.java:255` 的 `createBM25Similarity()` 创建，默认 `k1=1.2, b=0.75`。实现类 `LegacyBM25Similarity`（95 行）在 `lucene/similarity/`，是 ES 对 Lucene `Similarity` 的定制扩展。自定义 Query（`lucene/queries/`）通过重写 `createWeight()` 扩展 Lucene 查询。

## 必须回填的源码锚点

- `index/similarity/SimilarityProviders.java:255` `createBM25Similarity()`
- `index/similarity/SimilarityProviders.java:258`-`:259` k1=1.2 / b=0.75
- `lucene/similarity/LegacyBM25Similarity.java:35` 类声明
- `lucene/queries/BinaryDocValuesRangeQuery.java:30` 类声明
- `lucene/queries/BinaryDocValuesRangeQuery.java:59` `createWeight()`
- `index/similarity/SimilarityService.java` 相似度服务

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE