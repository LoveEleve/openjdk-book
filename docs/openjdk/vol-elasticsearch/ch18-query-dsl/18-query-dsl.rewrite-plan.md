# 篇：18 Query DSL 与搜索优化

- 域：`E-17 Query DSL`
- 卷：`vol-elasticsearch`
- 目标：回答 Query DSL 怎么编译成 Lucene 查询。

## 前置依赖
- HARD：已读 `E-2b 打分与 Query 重写`。

## 读者问题
1. QueryBuilder.toQuery() 怎么编译 JSON 结构？
2. BoolQuery 四种子句（MUST/FILTER/SHOULD/MUST_NOT）语义？
3. FuzzyQuery 怎么按编辑距离匹配？
4. RescorePhase 怎么重打分？

## 主结论
Query DSL 通过 QueryBuilder.toQuery() 编译成 Lucene Query。BoolQueryBuilder 组合四种子句。

## 结构设计
1. 困惑开场：JSON 怎么变成 Lucene 查询
2. BoolQueryBuilder 四种子句
3. FuzzyQueryBuilder
4. RescorePhase

## 必须回填的源码锚点
- `index/query/BoolQueryBuilder.java:40` + `:325` toQuery()
- `index/query/FuzzyQueryBuilder.java:33`
- `search/rescore/RescorePhase.java:26`

## note / review 约束
- 四件套标准格式。
