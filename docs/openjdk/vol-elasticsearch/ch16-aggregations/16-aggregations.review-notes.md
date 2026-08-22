# vol-elasticsearch E-15 聚合框架 — review notes

## 事实审
- `search/aggregations/Aggregator.java:33` abstract class Aggregator extends BucketCollector ✅
- `search/aggregations/bucket/terms/TermsAggregatorFactory.java:50` class TermsAggregatorFactory ✅
- `search/aggregations/metrics/CardinalityAggregator.java:43` class CardinalityAggregator ✅
- `search/aggregations/metrics/CardinalityAggregator.java:117` pickCollector ✅

## 因果审
- Aggregator 继承 BucketCollector，在搜索过程中逐文档收集 ✅
- TermsAggregatorFactory 按字段值分桶 ✅
- CardinalityAggregator 用 HyperLogLog 估算基数 ✅

## 结构审
- 从"terms 聚合怎么分桶"困惑开场到 Aggregator/TermsAggregatorFactory/CardinalityAggregator 主线集中 ✅

## 读者审
- 读完能回答：terms 聚合怎么遍历文档分桶 ✅

## 边界审
- 不展开所有聚合类型（每个 Bucket/Metric 聚合的具体实现）✅

## 依赖审
- 前置 E-11 FieldData，后续 E-16 ✅

## 结论
E-15 通过六层审查。
ENDOFFILE