# 篇：15 分析器/分词器管道

- 域：`E-14 分析器/分词器`
- 卷：`vol-elasticsearch`
- 目标：回答文本怎么被拆分成可搜索的 term。

## 前置依赖
- HARD：已读 `E-13 倒排索引`（term 是被倒排索引存储的基本单元）。

## 读者问题
1. 分析器三阶段管道是什么？
2. StandardTokenizer 怎么分词？
3. 默认 standard 分析器由哪些组件组合？
4. 自定义分析器怎么配置？

## 主结论
分析器三阶段（CharFilter→Tokenizer→TokenFilter）决定文本怎么变成 term。StandardTokenizer 按空格和标点分词 + LowercaseTokenFilter 转小写是默认配置。

## 结构设计
1. 困惑开场：Hello World! 怎么变成 hello/world
2. 三阶段管道总图
3. 各阶段组件
4. 默认 standard 分析器
5. 自定义分析器

## 必须回填的源码锚点
- `index/analysis/Analysis.java:74` class Analysis
- `index/analysis/StandardTokenizerFactory.java:18` StandardTokenizer 工厂
- `index/analysis/CustomAnalyzerProvider.java:25` 自定义分析器
- `index/analysis/AnalysisRegistry.java:657` standard 分析器注册

## note / review 约束
- 四件套标准格式。
