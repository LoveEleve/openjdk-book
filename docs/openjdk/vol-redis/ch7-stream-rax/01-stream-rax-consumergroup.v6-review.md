# R-10 Stream/rax · 六层深度审查报告

> 审查基线：R-10 四件套全部文件，Redis 7.4.2 源码
> 审查日期：2026-08-21

---

## 1️⃣ 事实审

### 锚点逐行核实

| 正文引用 | 源码行 | 核实结果 |
|---------|:------:|:--------:|
| `stream.h:11-14` streamID（ms/seq） | `stream.h:11-14` | ✅ |
| `stream.h:16-24` stream（rax/length/last_id/first_id/max_deleted_entry_id/entries_added/cgroups） | `stream.h:16-24` | ✅ |
| `stream.h:55-73` streamCG（last_id/entries_read/pel/consumers） | `stream.h:55-73` | ✅ |
| `stream.h:76-85` streamConsumer（seen_time/active_time/name/pel） | `stream.h:76-85` | ✅ |
| streamNACK（delivery_time/delivery_count/consumer） | `stream.h:92-97` | ✅ |
| `rax.h:169-182` raxNew/raxInsert/raxFind/raxStart/raxNext | `rax.h:169-182` | ✅ |
| `t_stream.c:344` streamEncodeID（htonu64 big-endian） | `t_stream.c:344` | ✅ |
| `t_stream.c:408` streamAppendItem | `t_stream.c:408` | ✅ |
| `t_stream.c:1996` xaddCommand | `t_stream.c:1996` | ✅ |
| `t_stream.c:2552` streamLookupConsumer | `t_stream.c:2552` | ✅ |

### 关键断言核实

| 正文断言 | 源码证据 | 成立 |
|---------|---------|:----:|
| listpack 作为 rax 叶子节点批量存消息 | `t_stream.c:531` raxInsert + `:550` lpNew | ✅ |
| seq 溢出返回 EDOM | `t_stream.c:421-423` `if (last_id.seq == UINT64_MAX) errno=EDOM` | ✅ |
| streamID 编码成 16 字节 big-endian key | `t_stream.c:344` htonu64 × 2 | ✅ |
| XACK 从 PEL 移除 ID | stream.c XACK 处理 | ✅ |

### 无事实错误

正文与源码一致，无修正。

---

## 2️⃣ 因果审

| 主张 | 源码证据 | 成立 |
|------|---------|:----:|
| Stream 用 rax 树按 ID 排序 + listpack 批量存储，兼顾范围查询和内存紧凑 | `stream.h:16-24` + `t_stream.c:531/550` | ✅ |
| 消息不是独立 rax 节点而是 listpack batch | `t_stream.c:550-558` lpAppend 多条 | ✅ |
| ms:seq 128 位 ID 保证唯一且单调递增 | `stream.h:11-14` + `streamAppendItem` seq+1 | ✅ |
| 消费者组 last_id 记交付、pel 记未确认、consumers 管消费者 | `stream.h:55-73` | ✅ |
| XREADGROUP 同时入全局 PEL 和消费者 PEL | `stream.h` CG+Consumer 各含 pel | ✅ |

---

## 3️⃣ 结构审

正文结构：困惑开场 → stream 结构 → rax 树 → listpack 存储 → streamID → 消费者组 → 三命令 → 失败路径 → 收网

- 主线集中，无冗余
- 三层结构（rax + listpack + CG）组织清晰

---

## 4️⃣ 读者审

- 读完能回答：Stream 的 rax 树 key 是什么 ✅
- 读完能回答：为什么消息不用独立 rax 节点 ✅
- 读完能回答：消费者组三字段各管什么 ✅
- 读完后能自然进入 R-2 事件驱动 ✅

---

## 5️⃣ 边界审

- 未透支 rax 树分裂/合并算法细节
- 未透支 XREAD BLOCK 阻塞实现（R-30）
- 边界成立

---

## 6️⃣ 依赖审

- 前置 R-1（HARD）+ R-4 SDS（HARD）+ R-5 listpack（HARD）
- 后续 R-2 事件驱动
- 无循环依赖

---

## 结论

| 审层 | 结果 |
|:----:|:----:|
| 事实审 | ✅ 全部通过，无修正 |
| 因果审 | ✅ 全部通过 |
| 结构审 | ✅ 三层结构清晰 |
| 读者审 | ✅ 关键问题有答案 |
| 边界审 | ✅ 未透支 |
| 依赖审 | ✅ 无循环 |

R-10 通过深度复审，无需修正。**数据结构层（A）7 个域全部完成并复核通过。**
