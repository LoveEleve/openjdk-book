# vol-elasticsearch E-2b 打分与 Query 重写 — review notes

## 事实审
- `index/similarity/SimilarityProviders.java:255` createBM25Similarity() ✅
- `index/similarity/SimilarityProviders.java:258` k1=1.2 ✅
- `index/similarity/SimilarityProviders.java:259` b=0.75 ✅
- `lucene/similarity/LegacyBM25Similarity.java:35` class 声明 ✅
- `lucene/queries/BinaryDocValuesRangeQuery.java:30` class 声明 ✅
- `lucene/queries/BinaryDocValuesRangeQuery.java:59` createWeight() ✅
- `index/similarity/SimilarityService.java` 存在 ✅

## 因果审
- BM25 公式 k1+b 控制词频饱和与文档长度归一化 ✅
- LegacyBM25Similarity 是 ES 对 Lucene Similarity 的定制 ✅
- 自定义 Query 通过 createWeight() 扩展 Lucene ✅

## 结构审
- 从"为什么排名高的在前"困惑开场到 BM25/LegacyBM25/自定义 Query 主线集中 ✅

## 读者审
- 读完能回答：BM25 的 k1/b 默认值各控制什么 ✅

## 依赖审
- 前置 E-2a/E-12，后续 E-12 ✅

## 结论
E-2b 通过六层审查。
ENDOFFILE