# 篇：07 Mapping 文档映射：FieldMapper 体系与 Dynamic Mapping

- 域：`E-7 Mapping 文档映射`
- 卷：`vol-elasticsearch`
- 目标：回答 Mapping 怎么定义字段类型，FieldMapper 体系怎么处理不同类型。

## 前置依赖

- HARD：已读 `E-1a Engine 写入路径`（Engine 写入时使用 Mapping）。

## 读者问题

1. Mapping 定义了什么？`Mapping.java` 怎么管理根对象映射？
2. `DocumentParser` 怎么解析 JSON 文档按 Mapping 提取字段？
3. `FieldMapper` 体系（TextFieldMapper/KeywordFieldMapper/NumberFieldMapper/DateFieldMapper）各管什么？
4. Dynamic Mapping 怎么自动检测新字段？

## 主结论

`Mapping.java`（29 行）是 JSON Schema 定义字段类型。`FieldMapper` 体系：`TextFieldMapper`(1454行，全文搜索)/`KeywordFieldMapper`(1070行，精确匹配+聚合)/`NumberFieldMapper`(1947行，数值范围)/`DateFieldMapper`(987行，日期)。`DocumentParser` 解析 JSON → 按 Mapping 提取字段值 → 构建 `ParsedDocument`。Dynamic Mapping 自动检测新字段类型并添加到 Mapping。

## 必须回填的源码锚点

- `index/mapper/Mapping.java:29` 类声明
- `index/mapper/Mapping.java:138` `merge()` 方法
- `index/mapper/MapperService.java:52` 类声明
- `index/mapper/MapperService.java:589` `documentMapper()`
- `index/mapper/DocumentMapper.java:18` 类声明
- `index/mapper/DocumentMapper.java:91` `parse()`
- `index/mapper/FieldMapper.java:57` 抽象类
- `index/mapper/TextFieldMapper.java` 1454 行
- `index/mapper/KeywordFieldMapper.java` 1070 行
- `index/mapper/NumberFieldMapper.java` 1947 行
- `index/mapper/DateFieldMapper.java` 987 行
- `index/mapper/DocumentParser.java` 存在

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE