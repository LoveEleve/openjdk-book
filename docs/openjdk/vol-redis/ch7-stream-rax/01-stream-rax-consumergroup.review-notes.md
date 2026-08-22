# vol-redis R-10 Stream/rax — review notes

## 事实审

- 已核对 `src/stream.h:11`-`:14`（`streamID`：ms/seq），正文成立。
- 已核对 `src/stream.h:16`-`:24`（`stream`：rax/length/last_id/first_id/max_deleted_entry_id/entries_added/cgroups），正文成立。
- 已核对 `src/stream.h:55`-`:73`（`streamCG`：last_id/entries_read/pel/consumers），正文成立。
- 已核对 `src/stream.h:76`-`:85`（`streamConsumer`：seen_time/active_time/name/pel），正文成立。
- 已核对 `src/stream.h`（`streamNACK`：delivery_time/delivery_count/consumer），正文成立。
- 已核对 `src/rax.h:169`-`:182`（`raxNew/raxInsert/raxFind/raxStart/raxNext`），正文成立。
- 已核对 `src/t_stream.c:344`（`streamEncodeID()`）、`:408`（`streamAppendItem()`）、`:1996`（`xaddCommand()`）、`:2552`（`streamLookupConsumer()`），正文成立。

## 因果审

- Stream 用 rax 树按 ID 排序存储 + listpack 批量存储，兼顾范围查询和内存紧凑，正文成立。
- 每条消息不是独立 rax 节点，而是 listpack batch 存放，正文成立。
- `ms:seq` 128 位 ID 保证全局唯一且单调递增，正文成立。
- 消费者组用 last_id 记交付进度、pel 记未确认消息、consumers 管消费者，正文成立。
- XREADGROUP 把 ID 同时加入全局 PEL 和消费者 PEL，XACK 从两者移除，正文成立。

## 结构审

- 从"为什么不是队列而是树"困惑开场，再落到 stream 结构、rax 树、listpack 存储、streamID、消费者组、命令，主线集中。

## 读者审

- 读完应能回答：Stream 的 rax 树 key 是什么。
- 读完应能回答：为什么每条消息不是独立 rax 节点。
- 读完应能回答：消费者组的 last_id / pel / consumers 各管什么。
- 读完应能回答：XREADGROUP 如何避免消费者冲突。
- 读完后能自然进入 R-2 事件驱动。

## 边界审

- 本篇没有展开 rax 树分裂/合并算法细节。
- R-30 阻塞版 XREAD BLOCK 未提前透支，边界成立。

## 依赖审

- 前置依赖：R-1 redisObject（HARD）、R-4 SDS（HARD）、R-5 listpack（HARD）。
- 后续桥接：R-2 事件驱动。

## 结论

R-10 已完成四件套的事实回填与六层审查，数据结构层全部完成，可进入 R-2 事件驱动。
