# Mapping 怎么定义字段类型，FieldMapper 怎么处理不同类型

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第七篇，回答 Mapping 的 FieldMapper 体系。

## 困惑：写入一个 JSON 文档，ES 怎么知道字段是什么类型？

`PUT /my_index/_doc/1 {"title":"hello","price":19.9}` 之后，ES 知道 `title` 是 text、`price` 是 float。怎么知道的？

## 分层拆解

### 1. Mapping：JSON Schema 定义

`Mapping.java:29`：

```java
public final class Mapping implements ToXContentFragment {
    // RootObjectMapper 管理整个 mapping 的根对象
    // meta 字段存储用户自定义元数据
    // routing 字段控制路由
}
```

`Mapping.merge()`（L138）把新 mapping 合并到现有 mapping。`Mapping` + `MapperService` 共同管理索引的字段类型定义。

### 2. MapperService：字段映射的总入口

`MapperService.java:52` 提供 `documentMapper()`（L589）获取当前文档映射。MapperRegistry 管理所有已注册的 `FieldMapper` 解析器。

### 3. DocumentParser：JSON 解析

`DocumentParser.java` 解析 JSON 文档：
- 按 Mapping 中定义的字段类型提取字段值
- 未定义字段：走 Dynamic Mapping 自动检测
- 构建 `ParsedDocument`（含 Lucene Document + docValues + termVectors）

### 4. FieldMapper 体系

`FieldMapper.java:57` 是抽象基类，具体实现：

| 实现 | 行数 | 用途 | Lucene 索引方式 |
|------|:----:|------|----------------|
| TextFieldMapper | 1454 | 全文搜索 | 倒排索引 |
| KeywordFieldMapper | 1070 | 精确匹配+聚合 | 倒排索引 + DocValues |
| NumberFieldMapper | 1947 | 数值范围 | PointValues + DocValues |
| DateFieldMapper | 987 | 日期 | PointValues + DocValues |

每种 `FieldMapper` 指定 Lucene 索引方式（倒排索引/DocValues/PointValues/termVectors），决定字段可以被怎么搜索和聚合。

## 失败路径

- Dynamic Mapping 自动检测到错误类型（如 `"123"` 被检测为 long 而非 text）
- Mapping 已存在但后续文档包含不兼容类型（抛 `MappingException`）
- `merge` 冲突：新创建的 mapping 与已有 mapping 冲突时 merge 失败

## 收网

Mapping 是 JSON Schema 定义字段类型。`FieldMapper` 体系（TextField/Keyword/Number/Date）各管不同字段类型，指定 Lucene 索引方式。`DocumentParser` 解析 JSON 按 Mapping 提取字段值。Dynamic Mapping 自动检测新字段类型。

## 下篇桥接

E-2a Search 查询阶段。
ENDOFFILE