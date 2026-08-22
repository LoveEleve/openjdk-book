# R-6 ZSet · 六层深度审查报告

> 审查基线：R-6 四件套全部文件，Redis 7.4.2 源码
> 审查日期：2026-08-21

---

## 1️⃣ 事实审

### 锚点逐行核实

| 正文引用 | 源码行 | 核实结果 |
|---------|:------:|:--------:|
| `server.h:1357-1359` zset 结构 | `server.h:1357-1359` | ✅ |
| `server.h:1341-1349` zskiplistNode | `server.h:1341-1349` | ✅ |
| `server.h:1351-1355` zskiplist | `server.h:1351-1355` | ✅ |
| `server.h:514-515` MAXLEVEL/P | `server.h:514-515` | ✅ |
| `t_zset.c:120-131` zslRandomLevel | `t_zset.c:120-131` | ✅ |
| `t_zset.c:137` zslInsert | `t_zset.c:137` | ✅ |
| `t_zset.c:1240-1243` listpack 创建条件 | `t_zset.c:1240-1243` | ✅ |
| `t_zset.c:1425` zsetAdd | `t_zset.c:1425` | ✅ |
| `t_zset.c:3905` zrankCommand | `t_zset.c:3905` | ✅ |
| `config.c:3219` zset-max-listpack-entries=128 | `config.c:3219` | ✅ |
| `config.c:3223` zset-max-listpack-value=64 | `config.c:3223` | ✅ |
| `t_zset.c:69` zsetConvertAndExpand | `t_zset.c:69` | ✅ |

### 发现 1 个事实错误（已修正）

**正文"失败路径 3"中"双结构不一致"描述错误**。原写：

> `zslInsert` 和 `dictAdd` 必须同时成功或同时回滚。如果 skiplist 删除成功但 dict 更新失败，双结构不一致。先更新 skiplist 再更新 dict，如果 dict 操作失败，整个函数返回错误，但 skiplist 的修改已经生效——这是源码中一个已知的边界。

实际源码 `t_zset.c:1542-1543` 是：

```c
znode = zslInsert(zs->zsl,score,ele);
serverAssert(dictAdd(zs->dict,ele,&znode->score) == DICT_OK);
```

`dictAdd` 后面是 `serverAssert`，不是"返回错误"。如果 dictAdd 失败（OOM），直接 `serverAssert` 崩溃，不会留下静默不一致状态。已修正为"serverAssert 防御性保证一致性"。

另外更新 score 路径不是"先删 skiplist 再插"，而是用 `zslUpdateScore`（`t_zset.c:264`），它内部优化了"位置不变只改 score 字段"免去删插，只有位置变化时才 `zslDeleteNode` + `zslInsert`。正文已修正。

---

## 2️⃣ 因果审

| 主张 | 源码证据 | 成立 |
|------|---------|:----:|
| zset 包含 dict + zsl 双结构互补 | `server.h:1357-1359` | ✅ |
| level[].span 实现 O(logN) ZRANK | `server.h:1345-1346` span 字段 | ✅ |
| P=0.25 比 0.5 更稀疏 | `server.h:515` | ✅ |
| 小 ZSet 用 listpack 编码 | `t_zset.c:1240-1243` + `config.c:3219/3223` | ✅ |
| 新增时 zslInsert + serverAssert(dictAdd) | `t_zset.c:1542-1543` | ✅（修正） |
| 更新时用 zslUpdateScore 优化 | `t_zset.c:1532` + `:264` | ✅（补） |

---

## 3️⃣ 结构审

正文结构：困惑开场 → 双结构 → skiplist 节点 → zslRandomLevel → 双编码 → ZADD 流程 → 失败路径 → 收网

- 主线集中，无冗余
- 失败路径 3 修正后与源码一致

---

## 4️⃣ 读者审

- 读完能回答：为什么 skiplist 和 dict 缺一不可 ✅
- 读完能回答：span 如何实现 O(logN) ZRANK ✅
- 读完能回答：ZSet 的 listpack 编码阈值 ✅
- 读完能回答：双结构一致性如何保证 ✅（修正后）

---

## 5️⃣ 边界审

- 未透支 R-7 Set/intset
- 未透支 R-10 Stream
- 边界成立

---

## 6️⃣ 依赖审

- 前置 R-1（HARD）+ R-3 Dict（HARD）
- 后续 R-7 Set/intset
- 无循环依赖

---

## 结论

| 审层 | 结果 | 核心发现 |
|:----:|:----:|---------|
| 事实审 | ⚠️→✅ | 1 处失败路径描述错误，已修正 |
| 因果审 | ✅ | 修正后成立 |
| 结构审 | ✅ | 主线集中 |
| 读者审 | ✅ | 关键问题有答案 |
| 边界审 | ✅ | 未透支 |
| 依赖审 | ✅ | 无循环 |

R-6 已完成深度复审，`serverAssert` 的防御性一致性保证已修正，可进入 R-7 Set/intset。
