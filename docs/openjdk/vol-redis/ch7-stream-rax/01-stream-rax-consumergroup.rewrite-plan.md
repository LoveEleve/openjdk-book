# 篇：01 Stream：rax 基数树 + 消费者组

- 域：`R-10 Stream/rax`
- 卷：`vol-redis`
- 目标：回答 Stream 如何用 rax 基数树存储消息，以及消费者组 XREADGROUP / ACK / PEL 如何协调多个消费者。

## 前置依赖

- HARD：已读 `R-1 redisObject`（encoding=STREAM）、`R-4 SDS`（消息字段是 SDS）。

## 读者问题

1. Stream 的 `stream` 结构体包含哪些字段？
2. rax 基数树是怎么压缩前缀节省内存的？
3. Stream 消息为什么要用 listpack 存储在一个 rax 节点里？
4. 消费者组（streamCG）的 last_id / pel / consumers 各管什么？
5. XREADGROUP 如何做到"每个消费者只读自己不冲突的消息"？
6. XACK 之后 PEL 怎么处理？

## 主结论

Stream 不是"一个消息列表"，而是 **rax 基数树（按 ID 排序存储消息）+ 每节点一个 listpack（批量存消息）+ 消费者组（last_id/pel/consumers 协调进度）** 的三层结构。

消息 ID 是 128 位（`ms:seq`），编码成 16 字节 key 插入 rax 树。rax 树把共享前缀的 key 压缩到一个节点，减少内存。每个 rax 叶子节点是一个 listpack，包含多条消息。

## 结构设计

1. 困惑开场：Stream 为什么不是列表而是树
2. stream 结构：rax + length + last_id + cgroups
3. rax 基数树：压缩前缀原理
4. 消息存储：listpack 作为 rax 叶子节点
5. streamID：ms:seq 的 128 位 id 生成
6. 消费者组 streamCG：last_id / pel / consumers
7. XADD / XREADGROUP / XACK 命令
8. 失败路径
9. 收网与下篇桥接 R-2 事件驱动

## 必须回填的源码锚点

- `src/stream.h:11`-`:14` `streamID`（ms/seq）
- `src/stream.h:16`-`:24` `stream` 结构体（rax/length/last_id/first_id/cgroups）
- `src/stream.h:55`-`:73` `streamCG`（last_id/pel/consumers）
- `src/stream.h:76`-`:85` `streamConsumer`（seen_time/pel）
- `src/stream.h` `streamNACK`（delivery_time/delivery_count/consumer）
- `src/rax.h:169`-`:182` `raxNew/raxInsert/raxFind/raxStart/raxNext`
- `src/t_stream.c:344` `streamEncodeID()`
- `src/t_stream.c:408` `streamAppendItem()`（追加消息）
- `src/t_stream.c:1996` `xaddCommand()`（XADD 命令）
- `src/t_stream.c:2552` `streamLookupConsumer()`
- `src/t_stream.c` `streamLookupCG()`（在 active prefix listpack 中查 consumer group）

## 必须引用的测试/证据

- `tests/unit/type/stream.tcl`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
