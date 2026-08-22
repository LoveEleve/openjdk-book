# 篇：16 聚合框架

- 域：`E-15 聚合框架`
- 卷：`vol-elasticsearch`
- 目标：回答 terms 聚合怎么遍历文档分桶。

## 前置依赖
- HARD：已读 `E-11 FieldData`（聚合底层用 DocValues）。

## 读者问题
1. Aggregator 怎么作为 Collector 参与搜索？
2. TermsAggregatorFactory 怎么分桶？
3. CardinalityAggregator 怎么估算基数？
4. 聚合在查询流程的什么位置执行？

## 主结论
Aggregator（`Aggregator.java:33`）继承 Lucene BucketCollector，在搜索 collect() 回调中逐文档处理。TermsAggregatorFactory 按字段值分桶，CardinalityAggregator 用 HyperLogLog 估算。

## 结构设计
1. 困惑开场：terms 聚合怎么分桶
2. Aggregator 基类
3. TermsAggregatorFactory
4. CardinalityAggregator
5. 收集流程

## 必须回填的源码锚点
- `search/aggregations/Aggregator.java:33` 抽象类
- `search/aggregations/bucket/terms/TermsAggregatorFactory.java:50`
- `search/aggregations/metrics/CardinalityAggregator.java:43`
- `search/aggregations/metrics/CardinalityAggregator.java:117` pickCollector

## note / review 约束
- 四件套标准格式。
