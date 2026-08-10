# 域 10: Metaspace — 全视角提问验证

> 9 KP / 🔴3 + 🟡3 + 🟢3 | ~48文件/~13,300行 | 拆 3 篇

## 维度 1: 开发者

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| D1 | Metaspace::allocate 从入口到 Metablock bump-pointer 走了几层？ | ✅ 01 §2 + 02 §1 |
| D2 | BlockFreelist 怎么合并相邻 free block？ | ✅ 02 §2 |
| D3 | VirtualSpaceNode retire 的完整流程——什么条件触发 OS 回收？ | ✅ 03 §1 |

## 维度 2: 架构师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| A1 | Metaspace vs PermGen——为什么要迁移到 native memory？ | ✅ 01 §1 |
| A2 | ChunkManager 的 free list——为什么有 8 种粒度分级？ | ✅ 02 §1 |
| A3 | MetaspaceArena per-CL——为什么不全局共享一个 Arena？ | ✅ 03 §2 |
| A4 | CDS archive 共享——多 JVM 进程怎么共享同一份 Metaspace？ | ✅ 03 §3 |

---

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 开发者 | 3 | 3 | ✅ |
| 架构师 | 4 | 4 | ✅ |
| **合计** | **7** | **7** | ✅ |
