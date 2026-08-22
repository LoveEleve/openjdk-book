# vol-elasticsearch E-15 聚合框架 — note

## 本篇主张

- 聚合框架在查询命中的文档上做分组统计，`Aggregator.java:33` 继承 Lucene BucketCollector。
- `TermsAggregatorFactory` 按字段值分桶，底层用 DocValues 读取字段值。
- `CardinalityAggregator` 用 HyperLogLog 估算基数，`pickCollector`（`:117`）选择收集器。
- 聚合在搜索过程中以 Collector 回调方式逐文档处理。

## 下篇桥接

- E-16 分布式搜索协调。
ENDOFFILE