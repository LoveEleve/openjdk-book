# 篇：14 倒排索引与 Lucene 存储基础

- 域：`E-13 倒排索引与 Lucene 存储`
- 卷：`vol-elasticsearch`
- 目标：回答倒排索引怎么建、怎么存、怎么查。

## 前置依赖

- HARD：已读 `E-1a Engine 写入路径`（知道写入通过 IndexWriter）。

## 读者问题

1. 倒排索引的 term → doc_id 映射怎么构建？
2. `IndexWriter.addDocuments()` 怎么把文档写入倒排索引？
3. `DirectoryReader.open()` 怎么打开索引供搜索？
4. Segment 是什么？怎么存倒排索引？

## 主结论

ES 的倒排索引由 Lucene 管理。`IndexWriter.addDocuments()`（`InternalEngine.java:1465`）把文档写入倒排索引：分词 → 建立 term → 关联 doc_id → 写入 Segment。`DirectoryReader.open(indexWriter)`（`InternalEngine.java:766`）打开索引供搜索。

## 必须回填的源码锚点

- `index/engine/InternalEngine.java:1465` `indexWriter.addDocuments()`
- `index/engine/InternalEngine.java:766` `DirectoryReader.open(indexWriter)`
- `index/engine/InternalEngine.java:138` `indexWriter` 字段
- `common/lucene/Lucene.java` Lucene 工具类

## note / review 约束

- 四件套标准格式。
ENDOFFILE