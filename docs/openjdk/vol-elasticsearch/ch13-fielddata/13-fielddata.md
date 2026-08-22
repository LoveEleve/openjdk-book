# FieldData：聚合/排序性能与 DocValues

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第十三篇，回答 FieldData 和 DocValues。

## DocValues vs FieldData

- **DocValues**（列式存储）—— ES 5.0+ 默认，聚合/排序通过 DocValues 直接从磁盘读取，不占堆内存
- **FieldData**（旧版）—— 聚合/排序加载到堆内存，5.0 前唯一方式，容易 OOM

## GlobalOrdinals

跨 Segment 去重编号——terms 聚合合并所有 Segment 词条，分配全局唯一 ID。

## CircuitBreaker

`fielddata.breaker.limit` 限制单节点 fielddata 总内存（默认 JVM heap 40%），超限抛 `CircuitBreakingException` 拒绝查询。

## 失败路径

- fielddata 堆内存耗尽 → OOM（经典面试事故，5.0 前常见）
- DocValues 读取性能依赖磁盘 IO，大量聚合时可能成为瓶颈

## 收网

DocValues 是 ES 5.0+ 的默认聚合/排序方式，列式存储不占堆内存。FieldData 是旧版堆内存方案。GlobalOrdinals 跨 segment 去重编号。CircuitBreaker 限制 fielddata 总内存超限拒绝查询。

## 卷级闭合

vol-elasticsearch 全部 13 个域完成。
ENDOFFILE