# 分析器怎么把文本变成可搜索的 term

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第十五篇，回答分析器/分词器管道。

## 困惑：写入 "Hello World!"，搜索 "hello" 为什么能搜到？

因为分析器把 "Hello World!" 处理成了 `["hello", "world"]` 两个 term。这个过程不是简单的 `toLowerCase()`，而是三阶段管道。

## 总图：分析器三阶段管道

```
原始文本 → Character Filter(字符过滤) → Tokenizer(分词) → Token Filter(词元过滤) → term[]
```

## 分层拆解

### 1. three 阶段

- **Character Filter**：`html_strip` 去掉 HTML 标签，`mapping` 替换字符
- **Tokenizer**：`StandardTokenizer`（`StandardTokenizerFactory.java:18`）按空格和标点分词。还有其他 Tokenizer：`WhitespaceTokenizer`（按空格）、`KeywordTokenizer`（不分词，整句当一词）、`PatternTokenizer`（按正则）
- **Token Filter**：`lowercase`（转小写）、`stop`（去停用词）、`stemmer`（词干提取）

### 2. 默认分析器：standard

`AnalysisRegistry.java:657` 注册默认 `standard` 分析器 → `StandardTokenizer` + `LowercaseTokenFilter`。不需额外配置就可用的通用分析器。

### 3. 自定义分析器

`CustomAnalyzerProvider.java:25` 通过 `index.analysis.analyzer.my_analyzer` 配置，组合不同的 Tokenizer + TokenFilter。

## 收网

分析器三阶段管道决定文本怎么被拆分成 term。`StandardTokenizer` 按空格分词 + `LowercaseTokenFilter` 转小写是默认配置。`CustomAnalyzerProvider` 支持自定义组合。

## 下篇桥接

E-15 聚合框架。
ENDOFFILE