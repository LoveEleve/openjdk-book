# vol-elasticsearch E-17 Query DSL — review notes

## 事实审
- `index/query/BoolQueryBuilder.java:40` class BoolQueryBuilder ✅
- `index/query/BoolQueryBuilder.java:325` toQuery() ✅
- `index/query/FuzzyQueryBuilder.java:33` class FuzzyQueryBuilder ✅
- `search/rescore/RescorePhase.java:26` execute() ✅

## 因果审
- QueryBuilder.toQuery() 编译 JSON 结构为 Lucene Query ✅
- BoolQuery 四种子句（MUST/FILTER/SHOULD/MUST_NOT）语义 ✅
- RescorePhase 重打分优化排序 ✅

## 结构审
- 从"JSON 怎么变成 Lucene 查询"困惑开场到 BoolQuery/FuzzyQuery/Rescore 主线集中 ✅

## 读者审
- 读完能回答：BoolQuery 的 MUST/FILTER 区别 ✅

## 依赖审
- 前置 E-2b，后续 E-18 ✅

## 结论
E-17 通过六层审查。
ENDOFFILE