# 篇：19 向量搜索/kNN

- 域：`E-18 向量搜索`
- 卷：`vol-elasticsearch`
- 目标：回答 dense_vector 字段怎么被 knn 查询检索。

## 前置依赖
- HARD：已读 `E-2a Search 查询阶段`（kNN 在 DfsPhase 执行）。

## 读者问题
1. KnnVectorQueryBuilder 怎么构建向量查询？
2. kNN 在哪个阶段执行？
3. HNSW 算法怎么近似最近邻？

## 主结论
dense_vector 字段 + knn 查询实现向量检索。kNN 在 DfsPhase 的 executeKnnVectorQuery（DfsPhase.java:175）执行，用 HNSW 近似最近邻。

## 结构设计
1. 困惑开场：向量字段怎么被检索
2. KnnVectorQueryBuilder
3. KnnScoreDocQuery
4. 执行位置（DfsPhase）

## 必须回填的源码锚点
- `search/vectors/KnnVectorQueryBuilder.java:51` + `:90`
- `search/vectors/KnnScoreDocQuery.java:35`
- `search/dfs/DfsPhase.java:56` + `:175`

## note / review 约束
- 四件套标准格式。
