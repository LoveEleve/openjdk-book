# R-5 List/quicklist · 六层深度审查报告

> 审查基线：R-5 四件套全部文件，Redis 7.4.2 源码
> 审查日期：2026-08-21

---

## 1️⃣ 事实审

### 锚点逐行核实

| 正文引用 | 源码行 | 核实结果 |
|---------|:------:|:--------:|
| `quicklist.h:47-59` quicklistNode | `quicklist.h:47-59` | ✅ |
| `quicklist.h:99-108` quicklist | `quicklist.h:99-108` | ✅ |
| `quicklist.h:66` quicklistLZF | `quicklist.h:66-69` | ✅ |
| `quicklist.c:127` create | `quicklist.c:127` | ✅ |
| `quicklist.c:557` createNode | `quicklist.c:557` | ✅ |
| `quicklist.c:583/611` PushHead/PushTail | `quicklist.c:583/611` | ✅ |
| `listpack.c:84-89` header | `listpack.c:84-89` | ✅ |
| `lpEncodeBacklen` / `lpDecodeBacklen` 自包含长度 | `listpack.c:335/:374` | ✅ |
| `ziplist.c:16` 布局注释 | `ziplist.c:16` | ✅ |
| `lpushCommand@493` → 调用 quicklistPushHead | `t_list.c:493` → `pushGenericCommand@464` → `listTypePush@144` | ⚠️ 间接调用，已修正为完整链路 |
| `t_list.c:846/851/856` pop/lrange | `t_list.c:846/851/856` | ✅ |
| `list-max-ziplist-size` 配置名 | `config.c:3152` `list-max-listpack-size`（旧名别名） | ⚠️ 已修正为 `list-max-listpack-size` |

### 发现的关键事实缺口（已补齐）

**正文原稿只讲了 quicklist（listpack 做节点），遗漏了 Redis 7.0 的 List 双编码机制**：

- **小 List**：`createListListpackObject()`（`object.c:221`）→ `OBJ_ENCODING_LISTPACK`（`server.h:893`），直接一个 listpack，**没有 quicklist 包装**
- **大 List**：超过 `list-max-listpack-size` 时，`listTypeTryConvertListpack()`（`t_list.c:21`）→ `OBJ_ENCODING_QUICKLIST`
- **可逆**：List 缩小后 `listTypeTryConvertQuicklist()`（`t_list.c:65`）转回 listpack

这个"双编码"是 Redis 7.0 的关键设计——小 List 用 listpack 直存比 quicklist（链表节点+listpack+位域）省内存得多。已补入正文第三节。

### 配置名修正

正文原写 `list-max-ziplist-size`。实际源码 `config.c:3152` 主名是 `list-max-listpack-size`，`list-max-ziplist-size` 只是兼容别名。已修正。

### 命令调用链修正

正文原写"lpushCommand 调用 quicklistPushHead"。实际调用链是：

```
lpushCommand → pushGenericCommand(t_list.c:464) → listTypePush(t_list.c:144)
  → 若 quicklist：quicklistPush
  → 若 listpack：lpPrependInteger / lpAppendInteger
```

已修正为完整链路。

---

## 2️⃣ 因果审

| 主张 | 源码证据 | 成立 |
|------|---------|:----:|
| ziplist 连锁更新由 prevlen 引起 | `ziplist.c:16` + 1字节→5字节扩展 | ✅ |
| listpack backlen 自包含消除连锁更新 | `listpack.c:335/:374` | ✅ |
| 小 List 用 listpack 直存，大 List 转 quicklist | `object.c:221` + `t_list.c:21` | ✅（补） |
| fill 控制每节点元素量 | `quicklist.h` QL_FILL_BITS | ✅ |
| compress 控制两端免压缩深度 | `quicklist.c:307` len<2*compress 不压缩 | ✅ |

---

## 3️⃣ 结构审

修正后章节结构：
```
困惑开场 → ziplist 问题 → listpack 方案 → List 双编码（新） → quicklist 分页 → fill/compress → t_list 命令链 → 失败路径
```

新插入的"List 双编码"在 ziplist/listpack 之后、quicklist 之前，位置合理，补上了事实链的关键一环。

## 4️⃣ 读者审

- 读完能回答：小 List 编码、何时转 quicklist ✅（补）
- 读完能回答：lpush 的完整调用链 ✅（补）
- 读完能回答 fill/compress 语义 ✅

## 5️⃣ 边界审

- 未透支 BLPOP/BRPOP（R-30）
- 未透支 R-6 ZSet
- 边界成立

## 6️⃣ 依赖审

- 前置 R-1（HARD），后续 R-6
- 无循环依赖

---

## 结论

| 审层 | 修正前 | 修正后 |
|:----:|:------:|:------:|
| 事实审 | ⚠️ 1 事实缺口 + 2 处简化 | ✅ 全部补齐 |
| 因果审 | ⚠️ 派生缺口 | ✅ |
| 结构审 | ✅ | ✅ |
| 读者审 | ✅ | ✅ |
| 边界审 | ✅ | ✅ |
| 依赖审 | ✅ | ✅ |

R-5 已完成深度复审与修正，可进入 R-6 ZSet。
