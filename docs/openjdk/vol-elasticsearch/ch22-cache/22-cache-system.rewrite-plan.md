# 篇：22 缓存体系：Query Cache/Request Cache/Field Data Cache

- 域：`E-22 缓存体系`
- 卷：`vol-elasticsearch`
- 目标：回答 ES 的三种缓存各自的作用、生命周期和限制。

## 前置依赖
- HARD：已读 `E-2a Search 查询阶段`（Query 缓存）、`E-11 FieldData`（FieldData 缓存）。

## 读者问题
1. Query Cache（节点级）怎么缓存 filter 后的 doc_id 集合？
2. Request Cache（分片级）怎么缓存查询结果？
3. Field Data Cache 怎么缓存 DocValues 排序/聚合值？
4. 三种缓存的失效条件和内存限制？

## 主结论
ES 有三种缓存：`IndicesQueryCache`(389行，节点级，缓存 filter 后的 doc_id 集合)、`IndicesRequestCache`(354行，分片级，缓存查询结果)、`IndicesFieldDataCache`(256行，字段数据缓存，用于排序/聚合)。

## 结构设计
1. 困惑开场：ES 有哪些缓存，各管什么
2. Query Cache 节点级缓存
3. Request Cache 分片级缓存
4. Field Data Cache 字段数据缓存
5. 各缓存的失效条件

## 必须回填的源码锚点
- `indices/IndicesQueryCache.java` 389 行
- `indices/IndicesRequestCache.java` 354 行
- `indices/fielddata/cache/IndicesFieldDataCache.java` 256 行

## note / review 约束
- 四件套标准格式。
