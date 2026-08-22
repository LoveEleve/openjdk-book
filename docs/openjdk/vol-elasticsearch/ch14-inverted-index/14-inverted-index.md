# ES 搜索为什么这么快——倒排索引

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第十四篇，回答倒排索引怎么建、怎么存、怎么查。

## 困惑：ES 搜索为什么比 MySQL LIKE 快？

MySQL `WHERE title LIKE '%hello%'` 要全表扫描，ES 为什么能在毫秒级返回？答案是倒排索引——不是"文档→字段"的映射，而是**"词→文档"的映射**。

## 总图：倒排索引的结构

```
正向索引（MySQL）：doc_id → title → "hello world"
倒排索引（ES）：   term → doc_id
                   hello → [1, 3, 5]
                   world → [2, 4]
```

查询 `hello` 时，倒排索引直接定位到 doc 1,3,5，不需要扫描所有文档。

## 分层拆解

### 1. 倒排索引怎么建：IndexWriter.addDocuments()

`InternalEngine.java:1465`：

```java
private void addDocs(final List<LuceneDocument> docs, final IndexWriter indexWriter) throws IOException {
    if (docs.size() > 1) {
        indexWriter.addDocuments(docs);      // 批量添加
    } else {
        indexWriter.addDocument(docs.get(0)); // 单条添加
    }
    numDocAppends.inc(docs.size());
}
```

`indexWriter`（`InternalEngine.java:138`）是 Lucene 的 `IndexWriter`。`addDocument` 内部：分词 → 提取每个 term → 建立 term→doc_id 映射 → 写入 Segment。

### 2. 倒排索引怎么读：DirectoryReader.open()

`InternalEngine.java:766`：

```java
directoryReader = ElasticsearchDirectoryReader.wrap(DirectoryReader.open(indexWriter), shardId);
```

`DirectoryReader.open(indexWriter)` 打开当前可搜索的索引视图。`refresh` 后新 Segment 可见，新数据才能被搜索到。

### 3. Segment 是倒排索引的存储单元

每次 refresh 生成一个新 Segment。每个 Segment 独立存储倒排索引。查询时打开所有 Segment 搜索，合并结果。

## 收网

倒排索引是 ES 搜索速度的根基。`IndexWriter.addDocuments()`（`InternalEngine.java:1465`）构建 term→doc_id 映射，`DirectoryReader.open()`（`InternalEngine.java:766`）打开索引供搜索。Segment 是存储单元，refresh 使其可见。

## 下篇桥接

E-14 分析器：怎么把文本变成 term。
ENDOFFILE