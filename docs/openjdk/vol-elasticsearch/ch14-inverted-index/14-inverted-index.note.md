# vol-elasticsearch E-13 倒排索引 — note

## 本篇主张

- 倒排索引是 term→doc_id 的映射（反向索引），不是文档→字段的正向映射。
- `IndexWriter.addDocuments()`（`InternalEngine.java:1465`）构建倒排索引——分词、提取 term、建映射、写 Segment。
- `DirectoryReader.open()`（`InternalEngine.java:766`）打开索引视图，refresh 使新 Segment 可见。
- Segment 是倒排索引的存储单元，每次 refresh 生成新 Segment。

## 本篇边界

- 不展开 Lucene 的倒排索引文件格式（.tim/.tip/.doc 等）。
- 不展开分词细节（E-14 覆盖）。

## 下篇桥接

- E-14 分析器：怎么把文本变成 term。
ENDOFFILE