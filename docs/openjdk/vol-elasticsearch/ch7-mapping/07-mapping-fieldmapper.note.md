# vol-elasticsearch E-7 Mapping — note

## 本篇主张

- Mapping 是 JSON Schema 定义字段类型，`Mapping.java:29` 管理根对象映射。
- `FieldMapper` 体系：TextFieldMapper(1454行)/KeywordFieldMapper(1070行)/NumberFieldMapper(1947行)/DateFieldMapper(987行)，各管不同字段类型和 Lucene 索引方式。
- `DocumentParser` 解析 JSON 按 Mapping 提取字段值，构建 ParsedDocument。
- Dynamic Mapping 自动检测新字段类型。

## 下篇桥接

- E-2a Search 查询阶段。
ENDOFFILE