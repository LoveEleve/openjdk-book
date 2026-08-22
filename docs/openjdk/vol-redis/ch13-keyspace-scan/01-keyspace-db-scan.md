# key 到底存在哪里

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第十三篇，回答键空间结构、lookupKey 路径、KEYS 与 SCAN 的差异。

## 为什么"key 存在 dict 里"这个理解会过时

很多人学 Redis 6.x 会记得"键空间是一个 dict"。但 Redis 7.x 把键空间从单 dict 改成了 **kvstore**（多个 dict 的容器）。

只记住"key 存在 dict 里"，就解释不了：为什么 `redisDb.keys` 的类型变了、为什么 cluster 模式下键空间按槽位分片。

## 一、redisDb 结构

关键代码在 `src/server.h:968`-`:980`：

```c
typedef struct redisDb {
    kvstore *keys;              /* 键空间 */
    kvstore *expires;           /* 有过期时间的 key */
    ebuckets hexpires;          /* 过期哈希表 */
    dict *blocking_keys;        /* 等待 BLPOP 数据的 key */
    dict *ready_keys;           /* 收到 PUSH 的阻塞 key */
    dict *watched_keys;         /* MULTI/EXEC WATCH 的 key */
    int id;                     /* 库编号 */
    unsigned long expires_cursor; /* 过期循环游标 */
} redisDb;
```

`keys` 和 `expires` 都是 `kvstore` 类型，`hexpires` 是 `ebuckets`（哈希过期时间结构）。`blocking_keys` / `ready_keys` 服务 R-30 的阻塞命令，`watched_keys` 服务 R-16 的事务。

## 二、kvstore：多 dict 容器

`kvstore` 是 Redis 7.0 引入的键空间容器，内部是**多个 dict 的数组**（按 cluster slot 分片）。每个 slot 一个 dict，当 key 添加到 redisDb 时，根据 `keyHashSlot` 决定进入哪个 dict。

好处：
1. **cluster 模式**：key 按 slot 分布在不同 dict 中，slot 迁移时只处理对应 dict
2. **并发/分区**：不同 slot 的 key 可以独立操作，rehash 不互相影响

## 三、lookupKeyRead/Write 路径

`lookupKeyReadWithFlags()`（`src/db.c:138`）是所有读命令查 key 的必经之路：

```c
robj *lookupKeyReadWithFlags(redisDb *db, robj *key, int flags) {
    // 1. 调 expireIfNeeded() 检查是否过期
    //    -> 过期则删除 deazzle，返回 NULL
    // 2. 从 db->keys 查 key
    // 3. (flags & LOOKUP_NOTOUCH) 控制是否更新 LRU/LFU
}
```

`lookupKeyRead()`（`db.c:146`）是 `lookupKeyReadWithFlags(db, key, LOOKUP_NONE)` 的简化版。`lookupKeyWriteWithFlags()`（`db.c:155`）是写命令路径，除查 key 外还会做 WATCH 记录和过期检查。

`expireIfNeeded()`（`src/db.c:35`）是惰性删除的核心——key 被访问时才检查是否过期。

## 四、KEYS 为什么阻塞

`keysCommand()`（`src/db.c:864`）实现 KEYS：

```c
void keysCommand(client *c) {
    // 调 kvstoreScanAll() / dictScan() 遍历所有 key
    // 匹配模式，返回所有匹配的 key
}
```

`dictScan`（`src/dict.c:1369`）遍历整个键空间的所有 dict 桶。在百万级 key 上，遍历全部桶需要数十毫秒甚至数秒，期间主线程无法处理其他命令——这就是 KEYS 阻塞的根因。

## 五、SCAN 为什么是游标式的

SCAN 也用 `dictScan`，但每次命令返回一个**游标**（`v` 参数）：

```c
unsigned long dictScan(dict *d, unsigned long v, ...) {
    // 从游标 v 开始遍历一部分桶
    // 返回新的游标（v=0 表示遍历完成）
}
```

SCAN 的游标使用**反向二进制迭代**（reversed bits），保证：

- **不遗漏**：rehash 时一个 key 至少被访问一次
- **不保证不重复**：rehash 过程中一个 key 可能被遍历两次，调用方需要去重

每次 SCAN 只扫描部分桶，返回后客户端下次带新游标继续。这是"分批遍历"，所以不阻塞主线程。

## 六、失败路径

### 1. KEYS 大库阻塞

百万级 key 上 `KEYS *` 阻塞数秒，生产禁止使用，用 `SCAN` 替代。

### 2. SCAN rehash 期间重复

rehash 过程中同一个 key 可能出现在新旧两个表中被遍历两次，客户端需要 `set` 去重。

### 3. SCAN count 太小

每次返回的 key 太少，需要很多次调用才能扫完整个库。

## 到这里，R-29 真正立住的是"kvstore 键空间 + lookupKey 路径 + KEYS/SCAN 差异"

如果只看表面，键空间被读成"key 存在 dict 里"。

更稳的理解方式应该是：

1. `redisDb.keys` / `.expires` 是 `kvstore`（多 dict 容器），不是单 dict
2. `lookupKeyRead/Write` 是所有命令的必经之路，`expireIfNeeded` 做惰性删除
3. KEYS 用 `dictScan` 全表遍历，阻塞主线程
4. SCAN 用反向二进制迭代游标，分批遍历不阻塞，不遗漏但不保证不重复

## 下篇桥接

R-30 阻塞命令将展开 BLPOP/BRPOP 的 `blockForKeys` / `signalKeyAsReady` 实现。
