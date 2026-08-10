# 域 12: Compiler Interface (ci) — 全视角提问验证

> 11 KP / 🔴3 + 🟡4 + 🟢4 | 74文件/20,932行 | 拆 3 篇

## 维度 1: 开发者

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| D1 | ciKlass::is_subtype_of 怎么在 ci 层做——不调 Klass 虚函数？ | ✅ 01 §2 |
| D2 | ciTypeFlow 的 StateVector::meet——两个分支汇合怎么取 common_type？ | ✅ 02 §1 |
| D3 | ciObjectFactory 的 `oop→ciObject` 映射——GC safe 怎么保证？ | ✅ 03 §1 |

## 维度 2: 架构师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| A1 | 为什么编译器不直接用 Klass/Method——需要 ci 镜像层？ | ✅ 01 §1 |
| A2 | ConnectionGraph 怎么判断对象逃逸——DFS 找逃逸点的完整路径？ | ✅ 02 §2 |
| A3 | ciReplay 怎么保证确定性——profiling data 都用录制的而非 runtime？ | ✅ 03 §2 |

---

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 开发者 | 3 | 3 | ✅ |
| 架构师 | 3 | 3 | ✅ |
| **合计** | **6** | **6** | ✅ |
