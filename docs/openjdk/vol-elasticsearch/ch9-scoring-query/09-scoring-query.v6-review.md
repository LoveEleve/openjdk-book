# E-2b 打分与 Query 重写 · 六层深度审查报告

> 审查基线：E-2b 四件套，ES v8.12.2 源码
> 审查日期：2026-08-21

---

## 1️⃣ 事实审

| 锚点 | 源码行 | 结果 |
|------|:------:|:----:|
| `SimilarityProviders.java:255` createBM25Similarity() | 255 | ✅ |
| `SimilarityProviders.java:258` k1=1.2 | 258 | ✅ |
| `SimilarityProviders.java:259` b=0.75 | 259 | ✅ |
| `LegacyBM25Similarity.java:35` class 声明 | 35 | ✅ |
| `BinaryDocValuesRangeQuery.java:30` class 声明 | 30 | ✅ |
| `BinaryDocValuesRangeQuery.java:59` createWeight() | 59 | ✅ |
| `SimilarityService.java` 存在 | 268 行 | ✅ |

**7 个锚点全部通过，无事实错误。**

---

## 2️⃣ 因果审

- BM25 公式 k1(1.2)+b(0.75) 控制词频饱和与文档长度归一化 ✅
- LegacyBM25Similarity 是 ES 对 Lucene Similarity 的定制 ✅
- 自定义 Query 通过重写 createWeight() 扩展 Lucene 查询 ✅

## 3️⃣ 结构审

- 从"为什么排名高的在前"困惑开场到 BM25/LegacyBM25/自定义 Query 主线集中 ✅

## 4️⃣ 读者审

- 读完能回答：BM25 的 k1/b 默认值各控制什么 ✅

## 5️⃣ 边界审

- 不展开所有 Similarity 实现（ScriptedSimilarity 等扩展）✅

## 6️⃣ 依赖审

- 前置 E-2a/E-12，后续 E-12 ✅

---

## 结论

| 审层 | 结果 |
|:----:|:----:|
| 事实审 | ✅ 7 锚点全部通过 |
| 因果审 | ✅ |
| 结构审 | ✅ |
| 读者审 | ✅ |
| 边界审 | ✅ |
| 依赖审 | ✅ |

E-2b 通过六层审查，无修正，可进入 E-12 Lucene 集成层。
ENDOFFILE