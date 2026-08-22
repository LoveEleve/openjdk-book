# vol-redis R-10 Stream/rax — note

## 本篇主张

- Stream 不是"消息队列"，而是 **rax 基数树（按 ID 存储）+ listpack（每节点批量存消息）+ 消费者组（last_id/pel/consumers）** 的三层结构。
- 消息 ID 是 128 位 `ms:seq`，编码成 16 字节 key 插入 rax 树。
- rax 树压缩共享前缀，减少内存；listpack 批量存储多条消息。
- `streamCG` 的 `last_id` 记录交付进度，`pel`（待确认列表）记录未 ACK 消息，`consumers` 管理消费者。
- XREADGROUP 把消息 ID 同时加入全局 PEL 和消费者 PEL，XACK 从两个 PEL 移除。

## 本篇边界

- 不展开 rax 树的分裂/合并算法细节。
- 不展开阻塞版 XREAD BLOCK 的实现（R-30 覆盖）。

## 下篇桥接

- R-2 事件驱动 + IO 多线程将展开 ae 事件循环、epoll、serverCron 和 IO 多线程的两阶段读写。
