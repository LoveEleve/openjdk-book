# 为什么 Stream 不是列表，而是树

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第七篇，回答 Stream 如何用 rax 基数树存储消息，以及消费者组如何协调多个消费者。

## 为什么"Stream 就是消息队列"这个理解会把 Stream 读浅

很多人第一次用 Redis Stream，觉得它就是一个消息队列，XADD 进去、XREADGROUP 消费。

但 Stream 的真正设计不是"一个队列"，而是 **rax 基数树（按 ID 排序存储消息）+ 每节点一个 listpack（批量存消息）+ 消费者组（last_id/pel/consumers 协调进度）** 的三层结构。

消息 ID 是 128 位（`ms:seq`），编码成 16 字节 key 插入 rax 树。rax 树把共享前缀的 key 压缩到一个节点，减少内存。每个 rax 叶子节点是一个 listpack，包含多条消息。

## 一、stream 结构：rax + length + last_id + cgroups

关键代码在 `src/stream.h:16`-`:24`：

```c
typedef struct stream {
    rax *rax;               /* 基数树，按 ID 存储消息 */
    uint64_t length;        /* 当前元素数量 */
    streamID last_id;       /* 最后一条消息的 ID */
    streamID first_id;      /* 第一条非墓碑消息的 ID */
    streamID max_deleted_entry_id; /* 被删除的最大 ID */
    uint64_t entries_added; /* 历史总添加数 */
    rax *cgroups;           /* 消费者组字典: name -> streamCG */
} stream;
```

`stream.rax` 是核心存储——按消息 ID 排序的 rax 基数树，key 是 16 字节的编码后 ID，value 是一个 listpack（包含多条消息）。

## 二、rax 基数树：压缩前缀

rax 树（`src/rax.h`）是一种**压缩前缀树**（compressed radix tree）。与普通前缀树不同，rax 树把只有一个子节点的路径压缩到一个节点中，减少内存占用。

例如，如果 key 是 `0000000000000001` 和 `0000000000000002`，共享前缀 `000000000000000` 被压缩到一个节点，不需要逐字符创建子树。

rax 核心函数：`raxNew()`（`src/rax.h:169`）、`raxInsert()`（`:171`）、`raxFind()`（`:174`）、`raxStart()`（`:180`，用于迭代）。

## 三、消息存储：listpack 作为 rax 叶子节点

每条 Stream 消息不是一个独立的 rax 节点，而是**多个消息 batch 在同一个 listpack 中**，listpack 作为 rax 的叶子节点。

`streamAppendItem()`（`src/t_stream.c:408`）追加消息时：

1. 检查当前 rax 末尾的 listpack 是否还有空间
2. 如果有，直接追加到 listpack 中
3. 如果没有，创建新的 rax 节点 + 新的 listpack

这样的设计让消息在内存中紧凑存储，同时 rax 树保证按 ID 范围查找 O(logN)。

## 四、streamID：ms:seq

`src/stream.h:11`-`:14` `streamID` 包含两个 64 位整数：

```c
typedef struct streamID {
    uint64_t ms;     /* Unix 毫秒时间戳 */
    uint64_t seq;    /* 序列号 */
} streamID;
```

`streamEncodeID()`（`src/t_stream.c:344`）把 `streamID` 编码成 16 字节的 big-endian key，保证 rax 树按 ID 顺序迭代。

`streamAppendItem()` 生成新 ID 的逻辑：
- 如果显式指定了 ID（`MAXLEN ~` 等），使用或验证它
- 否则：`ms = server.mstime()`，如果 `ms > last_id.ms` 则 `seq = 0`，否则 `seq = last_id.seq + 1`（防止在同一毫秒内冲突）

## 五、消费者组 streamCG

关键代码在 `src/stream.h:55`-`:73`：

```c
typedef struct streamCG {
    streamID last_id;        /* 最后交付的（未确认的）ID */
    long long entries_read;  /* 消费者组读取的总消息数 */
    rax *pel;                /* 待确认列表（全局），key=ID, value=streamNACK */
    rax *consumers;          /* 消费者字典，name -> streamConsumer */
} streamCG;
```

`streamCG.last_id` 记录组内最后交付的消息 ID。`pel`（Pending Entries List）是全局待确认列表，记录已交付但未 `XACK` 的消息。`consumers` 是组内所有消费者。

`streamConsumer`（`src/stream.h:76`-`:85`）包含 `pel`（消费者级别的待确认列表，是全局 PEL 的子集）和 `name`。

`streamNACK` 包含 `delivery_time`（最后交付时间）、`delivery_count`（交付次数，用于重试检测）和 `consumer`（最后交付给谁）。

## 六、XADD / XREADGROUP / XACK

`xaddCommand()`（`src/t_stream.c:1996`）调 `streamAppendItem()` 追加消息，然后调 `streamNotifyConsumerGroup()` 通知消费者组新消息到达。

`streamLookupCG()`（`t_stream.c` 中）从 `stream.cgroups` 中查找消费者组。

`XREADGROUP` 的核心逻辑：从 `streamCG.last_id` 之后开始读取，把每条消息的 ID 同时加入全局 PEL 和消费者自己的 PEL 中，设置 `streamNACK` 的 `delivery_time` 和 `delivery_count`。

`XACK` 从 PEL 中移除消息 ID——从全局 PEL 和消费者 PEL 中同时删除。

## 七、失败路径

### 1. PEL 无限增长

如果消费者挂掉不 `XACK`，PEL 持续增长，占用内存。`XCLAIM` 可以转移未确认消息给其他消费者，`XAUTOCLAIM`（Redis 6.2+）自动处理。

### 2. 同一毫秒 seq 耗尽

`seq = UINT64_MAX` 时，`streamAppendItem` 返回 `C_ERR`。理论上需要等待下一毫秒。实现在 `t_stream.c` 的 `streamAppendItem` 中，`if (s->last_id.seq == UINT64_MAX) { errno = EDOM; return C_ERR; }`。

### 3. rax 节点分裂/合并

rax 树在插入 key 时如果共享前缀不匹配，会分裂节点。分裂后节点数增加，但压缩前缀仍然有效。rax 树不自动合并移除 key 后的节点。

## 到这里，R-10 真正立住的是"Stream 是 rax + listpack + CG 三层结构"

如果只看表面，Stream 被读成"消息队列"。

更稳的理解方式应该是：

1. `stream.rax` 是基数树，key 是 16 字节编码后的消息 ID
2. 每个 rax 叶子节点是一个 listpack，包含多条消息（batch 存储）
3. `streamCG` 包含 `last_id`（交付进度）、`pel`（待确认列表）、`consumers`（消费者字典）
4. XREADGROUP 从 last_id 开始读，ID 同时入全局 PEL 和消费者 PEL
5. XACK 从 PEL 中移除 ID

## 下篇桥接

R-2 事件驱动 + IO 多线程将展开 ae 事件循环、epoll、serverCron 和 IO 多线程的两阶段读写。
