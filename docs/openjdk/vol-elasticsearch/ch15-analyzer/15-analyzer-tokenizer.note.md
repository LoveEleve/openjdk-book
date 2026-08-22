# vol-elasticsearch E-14 分析器/分词器 — note

## 本篇主张

- 分析器三阶段管道：Character Filter → Tokenizer → Token Filter，决定文本怎么变成 term。
- `StandardTokenizer`（`StandardTokenizerFactory.java:18`）按空格和标点分词，是默认配置。
- `CustomAnalyzerProvider.java:25` 支持自定义组合。
- 默认 `standard` 分析器 = StandardTokenizer + LowercaseTokenFilter。

## 下篇桥接

- E-15 聚合框架。
ENDOFFILE