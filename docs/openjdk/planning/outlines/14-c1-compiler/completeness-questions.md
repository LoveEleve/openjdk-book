# 域 14: C1 Compiler — 全视角提问验证

> 11 KP / 🔴4 + 🟡4 + 🟢3 | ~65文件/~51,750行 | 拆 4 篇

## 维度 1: 开发者

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| D1 | GraphBuilder 怎么把隐式操作栈转换为显式 SSA 变量？ | ✅ 01 §2 |
| D2 | LinearScan 的 Interval 怎么表示 value 的活跃范围？ | ✅ 03 §1 |
| D3 | Runtime1::patch_code 怎么修改已编译代码的 call 地址？ | ✅ 04 §1 |

## 维度 2: 架构师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| A1 | C1 的 Linear scan O(n) vs C2 Chaitin graph coloring O(n²)——什么时候 C1 的 spill 策略够用？ | ✅ 03 §1 |
| A2 | C1 Canonicalizer 为什么用多趟规范化——而不像 C2 的 single-pass GVN？ | ✅ 02 §1 |
| A3 | C1 为什么要纯 runtime——不能像 C2 生成全部 inline 码？ | ✅ 04 §1 |

---

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 开发者 | 3 | 3 | ✅ |
| 架构师 | 3 | 3 | ✅ |
| **合计** | **6** | **6** | ✅ |
