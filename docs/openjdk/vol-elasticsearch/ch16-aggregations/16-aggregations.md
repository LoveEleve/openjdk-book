# 聚合框架：terms 聚合怎么遍历文档分桶

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第十六篇，回答聚合框架。

## 困惑：`{"size":0,"aggs":{"by_name":{"terms":{"field":"name"}}}}` 怎么算出每个名字的数量？

聚合不是普通查询——它在查询命中的文档上做**分组统计**。terms 聚合遍历所有命中文档，按字段值分桶，统计每个桶的文档数。

## 分层拆解

### 1. Aggregator 基类：聚合的骨架

`search/aggregations/Aggregator.java:33`：

```java
public abstract class Aggregator extends BucketCollector implements Releasable {
```

`Aggregator` 继承 Lucene 的 `BucketCollector`。搜索时作为 Collector 的一部分，在 `collect()` 回调中逐文档处理。

### 2. TermsAggregatorFactory：桶聚合工厂

`search/aggregations/bucket/terms/TermsAggregatorFactory.java:50`：

```java
public class TermsAggregatorFactory extends ValuesSourceAggregatorFactory {
```

`TermsAggregatorFactory` 创建 `TermsAggregator`，按字段值分组。底层用 DocValues（通过 `ValuesSource`）读取字段值，然后分桶。`buildAggregator` 创建具体聚合器。

### 3. CardinalityAggregator：度量聚合

`search/aggregations/metrics/CardinalityAggregator.java:43`：

```java
public class CardinalityAggregator extends NumericMetricsAggregator.SingleValue {
    collector = pickCollector(aggCtx.getLeafReaderContext());
```

`CardinalityAggregator`（基数聚合，distinct count）用 HyperLogLog 估算唯一值数量。`pickCollector`（`:117`）选择收集器。

### 4. 聚合的收集流程

查询执行时，`Aggregator` 作为 Collector 的叶子节点：
1. 搜索遍历命中文档
2. 每个文档触发 `collect()` 回调
3. 聚合器读取当前文档的字段值，更新对应桶/度量
4. 搜索结束，聚合器输出结果

## 收网

聚合框架（516 文件）是 ES 分析能力的基础。`Aggregator`（L33）继承 Lucene BucketCollector，在搜索过程中逐文档收集。`TermsAggregatorFactory` 分桶，`CardinalityAggregator` 估算基数。底层都用 DocValues 读取字段值。

## 下篇桥接

E-16 分布式搜索协调。
ENDOFFILE