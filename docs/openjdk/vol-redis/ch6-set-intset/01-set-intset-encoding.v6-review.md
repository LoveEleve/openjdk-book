# R-7 Set/intset · 六层深度审查报告

> 审查基线：R-7 四件套全部文件，Redis 7.4.2 源码
> 审查日期：2026-08-21

---

## 1️⃣ 事实审

### 锚点逐行核实

| 正文引用 | 源码行 | 核实结果 |
|---------|:------:|:--------:|
| `intset.h:35-39` intset 结构体 | `intset.h:35-39` | ✅ |
| `intset.c:41-43` INTSET_ENC_INT16/32/64 | `intset.c:41-43` | ✅ |
| `intset.c:206` intsetAdd | `intset.c:206` | ✅ |
| `intset.c:159` intsetUpgradeAndAdd | `intset.c:159` | ✅ |
| `intset.c:46` _intsetValueEncoding | `intset.c:46` | ✅ |
| `t_set.c:25-33` setTypeCreate 三种编码创建 | `t_set.c:25-33` | ✅ |
| `t_set.c:57-60` maybeConvertIntset intset→HT | `t_set.c:57-60` | ✅ |
| `t_set.c:67-87` maybeConvertToIntset HT→intset | `t_set.c:67-87` | ✅ |
| `t_set.c:37-44` setTypeMaybeConvert listpack→HT | `t_set.c:37-44` | ✅ |
| `t_set.c:94/99` setTypeAdd / setTypeAddAux | `t_set.c:94/99` | ✅ |
| `t_set.c:583` saddCommand | `t_set.c:583` | ✅ |
| `config.c:3216` set-max-intset-entries=512 | `config.c:3216` | ✅ |
| `config.c:3217` set-max-listpack-entries=128 | `config.c:3217` | ✅ |
| `config.c:3218` set-max-listpack-value=64 | `config.c:3218` | ✅ |

### 无事实错误

正文包含了规划中遗漏的 Set listpack 编码，完整覆盖了三种编码（intset / listpack / HT）及其转换关系。所有锚点精确。

---

## 2️⃣ 因果审

| 主张 | 源码证据 | 成立 |
|------|---------|:----:|
| intset 有序数组 + 二分查找在 512 元素内比哈希表高效 | `intset.c` `intsetSearch` 二分查找 + `intsetAdd` 有序插入 | ✅ |
| 编码升级单向只升不降 | `intset.c` 只有 `intsetUpgradeAndAdd`，无降级函数 | ✅ |
| intset/listpack 超阈值后转 HT，HT 条件满足时转回 intset | `t_set.c:57-60` →HT, `t_set.c:67-87` →intset | ✅ |
| HT 不能转回 listpack | `maybeConvertToIntset` 只转 intset，listpack 无反向转换入口 | ✅ |

---

## 3️⃣ 结构审

正文结构：困惑开场 → intset 结构 → 编码升级 → 二分查找 → listpack 编码 → 转换逻辑 → SADD → 失败路径 → 收网

- 主线集中，无冗余
- 三种编码的创建和转换关系清晰

---

## 4️⃣ 读者审

- 读完能回答：Set 三种编码各什么时候用 ✅
- 读完能回答：intset 为什么只升不降 ✅
- 读完能回答：HT 什么时候能转 intset、什么时候不能转 listpack ✅
- 读完后能自然进入 R-10 Stream ✅

---

## 5️⃣ 边界审

- 未透支 R-10 Stream/rax
- 未透支 R-3 Dict 的 rehash 细节（HT 编码只提 dict 不展开）
- 边界成立

---

## 6️⃣ 依赖审

- 前置 R-1（HARD）+ R-3 Dict（HARD）
- 后续 R-10 Stream/rax
- 无循环依赖

---

## 结论

| 审层 | 结果 |
|:----:|:----:|
| 事实审 | ✅ 全部通过，无修正 |
| 因果审 | ✅ 全部通过 |
| 结构审 | ✅ 主旨集中 |
| 读者审 | ✅ 关键问题有答案 |
| 边界审 | ✅ 未透支 |
| 依赖审 | ✅ 无循环 |

R-7 通过深度复审，无需修正，可直接进入 R-10 Stream/rax。
