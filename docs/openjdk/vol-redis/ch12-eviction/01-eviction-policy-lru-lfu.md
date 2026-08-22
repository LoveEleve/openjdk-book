# 为什么 Redis 不用教科书 LRU

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第十二篇，回答 Redis 的 8 种淘汰策略、近似 LRU 的采样池实现、LFU 的对数计数与衰减机制。

## 为什么"LRU 就是淘汰最久没用的"这个理解会把淘汰读浅

很多人第一次看 Redis 的淘汰，觉得 LRU 就是教科书版：维护一个全局链表，访问时移到表头，淘汰时删表尾。

但 Redis 的 LRU 不是教科书版——全局链表在高并发下多线程竞争锁的开销太大。Redis 用了 **近似 LRU**：随机采样 + 候选池，用更少的元数据操作达到接近 LRU 的效果。

## 一、8 种策略

关键代码在 `src/server.h:562`-`:569`：

```c
#define MAXMEMORY_VOLATILE_LRU       ((0<<8)|MAXMEMORY_FLAG_LRU)
#define MAXMEMORY_VOLATILE_LFU       ((1<<8)|MAXMEMORY_FLAG_LFU)
#define MAXMEMORY_VOLATILE_TTL       (2<<8)
#define MAXMEMORY_VOLATILE_RANDOM    (3<<8)
#define MAXMEMORY_ALLKEYS_LRU        ((4<<8)|MAXMEMORY_FLAG_LRU|MAXMEMORY_FLAG_ALLKEYS)
#define MAXMEMORY_ALLKEYS_LFU        ((5<<8)|MAXMEMORY_FLAG_LFU|MAXMEMORY_FLAG_ALLKEYS)
#define MAXMEMORY_ALLKEYS_RANDOM     ((6<<8)|MAXMEMORY_FLAG_ALLKEYS)
#define MAXMEMORY_NO_EVICTION        (7<<8)
```

8 种策略分为两类：

- **`volatile-*`**：只对有 `expire` 的 key 生效。如果所有 key 都没设 TTL，退化为 `noeviction`。
- **`allkeys-*`**：对所有 key 生效。
- **`noeviction`**：不淘汰，写命令返回 `OOM` 错误。

## 二、近似 LRU：采样 + 候选池

`evictionPoolEntry`（`src/evict.c:35`-`:40`）：

```c
struct evictionPoolEntry {
    unsigned long long idle;    /* 空闲时间（LRU）/ 逆频率（LFU） */
    sds key;                    /* key 名称 */
    sds cached;                 /* 缓存的 key 名称 SDS */
    int dbid;                   /* 库编号 */
    int slot;                   /* 槽位 */
};
```

`EvictionPoolLRU`（`src/evict.c:43`）是一个静态候选池，`evictionPoolPopulate()`（`src/evict.c:125`）从 dict 随机采样 `maxmemory-samples`（默认 5，`src/config.c:3163`）个 key，计算每个 key 的 `idle` 时间（或 LFU 逆频率），把候选插入池中。

`performEvictions()`（`src/evict.c:520`）从候选池中淘汰 `idle` 最大的 key。

## 三、`maxmemory-samples` 与准确性

`maxmemory-samples` 默认 5，范围 1-64。采样数越大，淘汰结果越接近全局最优，但每次淘汰的 CPU 开销越大。5 是默认值，在大多数场景下能达到接近全局 LRU 的效果。

## 四、LFU 对数计数

LFU 的 `lru:24bit` 字段被拆为 16 位访问时间 + 8 位频率计数器。

`LFULogIncr()`（`src/evict.c:281`）实现概率递增：

```c
uint8_t LFULogIncr(uint8_t counter) {
    if (counter == 255) return 255;  // 封顶
    double r = (double)rand() / RAND_MAX;
    double base = counter - LFU_INIT_VAL;
    if (base < 0) base = 0;
    double p = 1.0 / (base * server.lfu_log_factor + 1);
    if (r < p) counter++;
    return counter;
}
```

计数器越大，继续递增的概率越小。这就是"对数增长"——少量访问就能把计数器拉到较高值，但继续升到更高值需要越来越多的访问。`lfu-log-factor` 配置控制增长速率。

## 五、LFU 周期衰减

`LFUDecrAndReturn()`（`src/evict.c:162` 附近调用）在每次访问时计算自上次访问以来的分钟数，按 `lfu-decay-time`（默认 1 分钟）衰减计数器。如果 `lfu-decay-time = 1`，每过 1 分钟计数器减 1。

## 六、过期删除 vs 内存淘汰（易混淆对）

| 维度 | 过期删除（expire） | 内存淘汰（evict） |
|------|------------------|-----------------|
| 触发条件 | TTL 到了 | `maxmemory` 满了 |
| 作用对象 | 设置了 `expire` 的 key | 所有 key（或 `volatile-*` 子集） |
| 触发时机 | `lookupKeyRead` 惰性 + `serverCron` 定期 | `processCommand` 中 `performEvictions` |
| 后果 | 删除 key，释放空间 | 踢 key，释放空间 |
| 关系 | 两者独立工作，同一 key 可同时被两者选中 | |

## 七、失败路径

### 1. `volatile-*` 退化为 `noeviction`

如果所有 key 都没设 TTL，`volatile-lru` 找不到可淘汰的 key，退化为 `noeviction`，写命令返回 OOM。

### 2. `maxmemory-samples` 太小

采样数太小（如 1），淘汰结果接近随机，LRU 效果差。采样数太大（如 64），每次淘汰前采样开销大，但精度提升有限。

### 3. LFU 新 key 竞争劣势

新 key 的 `LFU_INIT_VAL` 计数器初始值较低，在淘汰时容易被优先选走。`LFU_INIT_VAL` 默认 5，让新 key 在访问几次后快速积累频率。

## 到这里，R-28 真正立住的是"采样 + 候选池的近似 LRU"

如果只看表面，淘汰被读成"LRU 就是淘汰最久没用的"。

更稳的理解方式应该是：

1. 8 种策略：`volatile-lru/lfu/ttl/random` + `allkeys-lru/lfu/random` + `noeviction`
2. 近似 LRU：随机采样 `maxmemory-samples` 个 key，候选池中选 `idle` 最大的淘汰
3. LFU：8 位计数器对数增长 + 概率递增 + 周期衰减
4. 过期删除 vs 内存淘汰：前者 TTL 到了删，后者内存满了踢

## 下篇桥接

R-29 键空间与 SCAN 将展开 `redisDb` 结构、`lookupKeyRead/Write` 路径、KEYS 阻塞 vs SCAN 游标式遍历。
