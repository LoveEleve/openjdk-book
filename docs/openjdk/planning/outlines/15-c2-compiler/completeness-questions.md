# 域 15: C2 Compiler — 全视角提问验证

> 16 KP / 🔴6 + 🟡5 + 🟢5 | ~136文件/~176K行 | 拆 8 篇

## 维度 1: 开发者

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| D1 | IGVN::transform 怎么迭代 Ideal→Value→Identity 直到 fixpoint？ | ✅ 01 §3 |
| D2 | Parse::do_call() inline 决策基于哪些条件？ | ✅ 02 §1 |
| D3 | Chaitin 的 IFG+simplify stack——Degree<N 简化 vs Degree>N spill？ | ✅ 05 §1 |

## 维度 2: 架构师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| A1 | Sea-of-nodes vs basic block based IR——C2 vs C1 的根本差异？ | ✅ 01 §1 |
| A2 | C2 的 EA ConnectionGraph 为什么比 C1 的 bcEscapeAnalyzer 精确？ | ✅ 03 §2 |
| A3 | 36815 行 .ad 文件——ADL 的 DFA matcher 怎么用？ | ✅ 06 §1 |

---

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 开发者 | 3 | 3 | ✅ |
| 架构师 | 3 | 3 | ✅ |
| **合计** | **6** | **6** | ✅ |
