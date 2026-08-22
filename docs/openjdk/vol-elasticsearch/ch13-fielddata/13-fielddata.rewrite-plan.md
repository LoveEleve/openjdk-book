# 篇：13 FieldData 聚合/排序性能与 DocValues

- 域：`E-11 FieldData 聚合/排序性能`
- 卷：`vol-elasticsearch`
- 目标：回答 FieldData 怎么加载 DocValues 以及 CircuitBreaker 怎么限制内存。

## 前置依赖

- HARD：已读 `E-2a Search 查询阶段`（知道聚合在查询阶段执行）。

## 读者问题

1. DocValues 和 FieldData 有什么区别？
2. GlobalOrdinals 怎么跨 segment 去重编号？
3. CircuitBreaker 怎么防止 OOM？

## 主结论

`IndexFieldData.load()` 按 Segment 加载 DocValues。`GlobalOrdinals` 跨 Segment 去重编号。`CircuitBreaker` 的 `fielddata.breaker.limit` 默认 JVM heap 40%，超限抛 `CircuitBreakingException`。

## 必须回填的源码锚点

- `index/fielddata/IndexFieldData.java` 255 行
- `indices/breaker/` CircuitBreaker 相关

## note / review 约束

- 四件套标准格式。
ENDOFFILE