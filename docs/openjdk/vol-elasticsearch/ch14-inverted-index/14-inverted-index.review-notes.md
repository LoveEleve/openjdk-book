# vol-elasticsearch E-13 倒排索引 — review notes

## 事实审
- `InternalEngine.java:1465` addDocs() → `indexWriter.addDocuments(docs)` ✅
- `InternalEngine.java:766` `DirectoryReader.open(indexWriter)` ✅
- `InternalEngine.java:138` `indexWriter` 字段 ✅

## 因果审
- 倒排索引是 term→doc_id 映射，不是正向索引 ✅
- IndexWriter.addDocuments() 构建倒排索引 ✅
- DirectoryReader.open() 打开索引供搜索 ✅
- Segment 存储倒排索引，refresh 使其可见 ✅

## 结构审
- 从"ES 为什么比 MySQL 快"困惑开场到倒排索引结构/构建/读取/Segment 主线集中 ✅

## 读者审
- 读完能回答：倒排索引为什么比 MySQL 快 ✅

## 边界审
- 不展开 Lucene 文件格式 ✅

## 依赖审
- 后续 E-14 分析器 ✅

## 结论
E-13 通过六层审查。
ENDOFFILE