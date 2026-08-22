# R-3 Dict 渐进式 rehash · 六层深度审查报告

> 审查基线：R-3 四件套全部文件，Redis 7.4.2 源码
> 审查日期：2026-08-21

---

## 1️⃣ 事实审

### 锚点逐行核实

| 正文行 | 引用锚点 | 源码行 | 核实结果 |
|-------|----------|:------:|:--------:|
| 17 | `src/dict.h:96-110` struct dict | `dict.h:96-110` | ✅ 字段与正文一致 |
| 40 | `src/dict.h:170` dictIsRehashing | `dict.h:170` | ✅ |
| — | `_dictExpandIfNeeded` @63 | `dict.c:63` 仅是原型声明 | ⚠️ 已修正为 `dictExpandIfNeeded` 实现在 `:1492` |
| 50 | `dict.c:41-42` dict_can_resize / ratio | `dict.c:41-42` | ✅ |
| 66 | `dict.c:385-425` dictRehash | `dict.c:385-425` | ✅ |
| 91 | `dict.c:449` dictRehash(d,1) | `dict.c:448-449` `_dictRehashStep` | ✅ 448 是函数定义，449 是 body |
| — | 缩容阈值 1/32 | `dict.c:1529` dictShrinkIfNeeded | ⚠️ 已修正：实为两档（ENABLE=1/8, AVOID=1/32） |
| — | fork 用 `pauserehash` | `server.c:643` updateDictResizePolicy | ⚠️ 已修正：fork 用 `dict_can_resize` 全局开关 |
| 116 | `dict_hash_function_seed[16]` @92、dictSetHashFunctionSeed @94 | `dict.c:92,94` | ✅ |
| 87 | `dictCheckRehashingCompleted` | `dict.c:385-425` 范围内 | ✅ |

### 发现的 4 个事实错误（已全部修正）

1. **缩容阈值写法错误**：原文只写"负载因子 < 1/32 触发缩容"。实际源码 `dictShrinkIfNeeded`（`dict.c:1529`）是**两档**：
   - `DICT_RESIZE_ENABLE`：`used * 8 <= size`（1/8）
   - `DICT_RESIZE_AVOID`：`used * 32 <= size`（1/32）
   源码注释在 `dict.c:390-392` 明确 `HASHTABLE_MIN_FILL=8`。已修正。

2. **扩容触发函数/锚点错误**：原文写 `_dictExpandIfNeeded` @ `dict.c:63` 且"在每次 dictAdd 时被调用"。实际：
   - `dict.c:63` 只是原型声明，实现是 `dictExpandIfNeeded` @ `dict.c:1492`（`_dictExpandIfNeeded` 包裹 @`1519`）
   - 调用点不在 dictAdd，而在 `dictFindPositionForInsert` @ `dict.c:1592`（dictAdd → dictAddRaw → dictFindPositionForInsert）
   已修正为"实现 `dict.c:1492`，调用 `src/dict.c:1592`"。

3. **`pauserehash` 用途完全错误（最严重）**：原文写"Redis 在 fork 子进程做 RDB 快照或 AOF 重写时，会设置 pauserehash = 1"。实际：
   - fork 用 `updateDictResizePolicy()`（`server.c:643`）设置 `dict_can_resize = FORBID/AVOID/ENABLE`
   - `pauserehash` 是 dict **实例级**字段，用于 `dictTwoPhaseUnlinkFree`（`dict.c:815`）等两阶段删除/遍历场景，与 fork 无关
   已重写第六节。

4. **失败路径 1 错误**：原文写"`pauserehash > 0` 期间所有新元素都加到 ht[0]"。实际：
   - rehash 时新元素受 `dictInsertAtPosition`（`dict.c:521`）`htidx = dictIsRehashing(d) ? 1 : 0` 决定，始终加到 ht[1]
   - 与 pauserehash 无关
   已重写失败路径 1~4。

### 额外修正

5. `dictRehash` 代码块漏了开头的 FORBID/AVOID 检查（`dict.c:389-398`）——已补全，并为此增加了"dict_can_resize 也控制进行中 rehash 是否继续"的说明（与失败路径 3 对应）。

---

## 2️⃣ 因果审（修正后）

| 主张 | 源码证据 | 成立 |
|------|---------|:----:|
| 双表 + rehashidx 把 O(n) 拆成逐步迁移 | `dict.h:96-110` + `dict.c:385` | ✅ |
| ENABLE 下扩容阈值 1、AVOID 下 4，全由 `dict_can_resize` 控制 | `dict.c:1504-1509` | ✅ |
| 缩容两档：ENABLE 1/8、AVOID 1/32 | `dict.c:1540-1543` + `dict.h:27` HASHTABLE_MIN_FILL=8 | ✅ |
| 每次操作一步 `dictRehash(d,1)` | `_dictRehashStep` @ `dict.c:448-449` | ✅ |
| rehash 时新增进 ht[1] | `dict.c:521` `htidx = dictIsRehashing(d) ? 1 : 0` | ✅ |
| fork 用 `dict_can_resize` 而非 pauserehash | `server.c:643-648` updateDictResizePolicy | ✅ |
| AVOID 期间进行中的 rehash 也会暂停 | `dict.c:390-398` | ✅ |
| SipHash 防 HashDoS | `dict.c:92,94` + siphash 调用 | ✅ |

---

## 3️⃣ 结构审

正文结构：困惑开场 → struct dict → 扩容 → 缩容 → dictRehash → 每次一步 → fork 关系（重写） → SipHash → 失败路径（重写） → 收网

修正后六、八节与事实一致。结构无冗余。

## 4️⃣ 读者审

- 读完能回答：扩容/缩容阈值为什么有 ENABLE/AVOID 两档 ✅
- 读完能回答：fork 期间为什么禁止/限制自动扩缩 ✅
- 读完能回答：rehash 时新元素进哪张表 ✅
- 读完能回答：进行中的 rehash 在 AVOID 下也会暂停 ✅

## 5️⃣ 边界审

- 未透支 R-29 键空间（redisDb.dict 的使用）
- 未透支 R-5 List/quicklist
- 边界成立

## 6️⃣ 依赖审

- 前置 R-1（HARD），后续 R-5
- 无循环依赖

---

## 结论

| 审层 | 修正前 | 修正后 |
|:----:|:------:|:------:|
| 事实审 | ⚠️ 4 处错误 | ✅ 全部修正 |
| 因果审 | ⚠️ 派生自事实错误 | ✅ |
| 结构审 | ✅ | ✅ |
| 读者审 | ✅ | ✅ |
| 边界审 | ✅ | ✅ |
| 依赖审 | ✅ | ✅ |

R-3 已完成深度复审与修正，可进入 R-5 List/quicklist。
