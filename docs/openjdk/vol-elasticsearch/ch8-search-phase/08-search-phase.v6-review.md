# E-2a Search 查询阶段 · 六层深度审查报告

> 审查基线：E-2a 四件套，ES v8.12.2 源码
> 审查日期：2026-08-21

---

## 1️⃣ 事实审

| 锚点 | 源码行 | 结果 |
|------|:------:|:----:|
| `SearchService.java:485` executeDfsPhase() | 485 | ✅ |
| `SearchService.java:522` executeQueryPhase() | 522 | ✅ |
| `SearchService.java:666` queryPhase 内部 | 666 | ✅ |
| `QueryPhase.java:56` class 声明 | 56 | ✅ |
| `QueryPhase.java:61` execute() | 61 | ✅ |
| `FetchPhase.java:49` class 声明 | 49 | ✅ |
| `FetchPhase.java:59` execute() | 59 | ✅ |
| `DfsPhase.java:51` class 声明 | 51 | ✅ |
| `DfsPhase.java:53` execute() | 53 | ✅ |

### 关键断言核实

| 断言 | 源码证据 | 成立 |
|------|---------|:----:|
| QueryPhase 执行 Lucene 搜索 | `QueryPhase.execute()` → `executeQuery(searchContext)` | ✅ |
| FetchPhase 补充 _source | `FetchPhase.execute(context, docIdsToLoad)` | ✅ |
| Query 阶段结束后进入 Fetch | `SearchService.java:688` `executeFetchPhase(...)` | ✅ |

**9 个锚点全部通过，无事实错误。**

---

## 2️⃣ 因果审

- 三阶段查询（Dfs/Query/Fetch）覆盖协调节点广播 + 分片本地执行 + 合并 ✅
- QueryPhase 只返回 doc_id+score（不返回 _source）是性能优化 ✅
- FetchPhase 根据 doc_id 补充 _source/stored_fields/highlight ✅

## 3️⃣ 结构审

- 从"一次搜索请求穿过哪些阶段"困惑开场到三阶段/QueryPhase/FetchPhase 主线集中 ✅

## 4️⃣ 读者审

- 读完能回答：ES 搜索的三阶段路径 ✅
- 读完能回答：QueryPhase 为什么只返回 doc_id ✅

## 5️⃣ 边界审

- 不展开 BM25 打分公式（E-2b 覆盖）✅
- 不展开 Query 重写细节（E-2b 覆盖）✅

## 6️⃣ 依赖审

- 前置 E-1a/E-7，后续 E-2b ✅

---

## 结论

| 审层 | 结果 |
|:----:|:----:|
| 事实审 | ✅ 9 锚点全部通过 |
| 因果审 | ✅ |
| 结构审 | ✅ |
| 读者审 | ✅ |
| 边界审 | ✅ |
| 依赖审 | ✅ |

E-2a 通过六层审查，无修正，可进入 E-2b 打分与 Query 重写。
ENDOFFILE