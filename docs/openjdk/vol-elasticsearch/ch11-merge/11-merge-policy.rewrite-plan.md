# 篇：11 MergePolicy 段合并与 ElasticsearchConcurrentMergeScheduler

- 域：`E-8 MergePolicy 段合并`
- 卷：`vol-elasticsearch`
- 目标：回答 ES 怎么合并 segment 以及怎么控制合并线程。

## 前置依赖

- SOFT：了解 Lucene 的 segment 概念。

## 读者问题

1. 为什么需要段合并？
2. `ElasticsearchConcurrentMergeScheduler` 怎么限制合并线程数？
3. `TieredMergePolicy` 怎么按大小分层合并？

## 主结论

`ElasticsearchConcurrentMergeScheduler`（约100行）继承 Lucene 的 `ConcurrentMergeScheduler`，限制 `maxThreadCount` + `maxMergeCount`，防止合并占用过多 IO。`TieredMergePolicy`（Lucene 类）按大小分层合并。

## 必须回填的源码锚点

- `index/engine/ElasticsearchConcurrentMergeScheduler.java` 类
- `index/engine/EngineConfig.java:58` mergePolicy 字段
- `index/merge/MergeStats.java` 合并统计

## note / review 约束

- 四件套标准格式。
ENDOFFILE