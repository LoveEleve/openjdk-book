# 域 11: CDS — 全视角提问验证

> 8 KP / 🔴3 + 🟡3 + 🟢2 | ~17文件/~9,000行 | 拆 2 篇

## 维度 1: 开发者

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| D1 | Dump 时 `MetaspaceShared::serialize` 怎么递归序列化 Klass→Method→ConstantPool 的对象树？ | ✅ 01 §1 |
| D2 | mmap MAP_FIXED 为什么必须映射到预留地址——偏移不到会怎样？ | ✅ 02 §1 |

## 维度 2: 架构师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| A1 | MAP_SHARED vs MAP_PRIVATE——为什么选 shared？ | ✅ 02 §1 |
| A2 | CompactHashtable——为什么在 archive 内重构 hashtable 而非直接用 Metaspace 中的？ | ✅ 02 §3 |
| A3 | Dump 时的 classlist——为什么不能 dump 所有已加载类？ | ✅ 01 §1 |

---

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 开发者 | 2 | 2 | ✅ |
| 架构师 | 3 | 3 | ✅ |
| **合计** | **5** | **5** | ✅ |
