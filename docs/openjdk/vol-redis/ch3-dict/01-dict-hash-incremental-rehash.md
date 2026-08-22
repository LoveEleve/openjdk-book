# 为什么 Redis 的哈希表扩容不用"停一下"

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第三篇，回答 Dict 如何通过双表 + 渐进式 rehash 把扩容/缩容的 O(n) 开销摊到后续每次操作上。

## 为什么"rehash 就是重建哈希表"这个理解会把 Dict 读浅

很多人第一次看 Redis 的 Dict 源码，觉得它就是一个普通的链式哈希表，扩容时重建一次就完了。

这当然不是错，但这样理解，就没看到 Redis 的 Dict 真正的设计精髓：**Dict 用双表（`ht_table[2]`）把扩容拆成"准备 + 渐进迁移 + 交换"三步，迁移过程不阻塞任何读写操作。**

`rehashidx` 标记进度（-1 表示未在 rehash），每次操作（增删改查）后迁移 1 个桶（`dictRehash(d, 1)`）。rehash 期间，增删改查同时在两个表上操作。

## 一、struct dict：双表与 rehashidx

关键代码在：

- `src/dict.h:96`-`:110` `struct dict` 定义

```c
struct dict {
    dictType *type;
    dictEntry **ht_table[2];
    unsigned long ht_used[2];
    long rehashidx;       /* rehashing not in progress if rehashidx == -1 */
    unsigned pauserehash : 15;
    signed char ht_size_exp[2]; /* exponent of size. (size = 1<<exp) */
    int16_t pauseAutoResize;
    void *metadata[];
};
```

关键字段：

- `ht_table[2]`：两个哈希表。`ht_table[0]` 是旧表，`ht_table[1]` 是新表。
- `ht_used[2]`：两个表各自的元素数量。
- `ht_size_exp[2]`：两个表的大小指数。表大小 = `1 << ht_size_exp[n]`。
- `rehashidx`：rehash 进度。`-1` = 未在 rehash，`0` 开始递增，迁移完 `ht[0]` 的所有桶后回到 `-1`。
- `pauserehash`：暂停 rehash。>0 时 rehash 不进行。

`dictIsRehashing` 宏（`src/dict.h:170`）检查 `rehashidx != -1`。

## 二、扩容触发：`dictExpandIfNeeded`

`dictExpandIfNeeded()`（实现在 `src/dict.c:1492`）在每次插入查找时被调用（`dictFindPositionForInsert` 里 `src/dict.c:1592`）。判断逻辑：

1. 如果已经在 rehash 中，直接返回。
2. `DICT_RESIZE_ENABLE`（正常模式）：`ht_used[0] >= DICTHT_SIZE(ht_size_exp[0])`（负载因子 >= 1）就扩。
3. `DICT_RESIZE_AVOID`（有 fork 子进程时）：`ht_used[0] >= dict_force_resize_ratio * size`（负载因子 >= 4，`dict_force_resize_ratio = 4`）才强制扩。

关键判断在 `src/dict.c:1504`-`1509`：

```c
if ((dict_can_resize == DICT_RESIZE_ENABLE &&
     d->ht_used[0] >= DICTHT_SIZE(d->ht_size_exp[0])) ||
    (dict_can_resize != DICT_RESIZE_FORBID &&
     d->ht_used[0] >= dict_force_resize_ratio * DICTHT_SIZE(d->ht_size_exp[0])))
```

`dict_can_resize` 初始为 `DICT_RESIZE_ENABLE`（`src/dict.c:41`）。`DICT_RESIZE_FORBID` 时**不触发任何自动扩容/缩容**（`src/dict.c:1629` `dictSetResizeEnabled()` 控制）。

扩容调用 `dictExpand(d, d->ht_used[0] + 1)`，新大小经 `_dictNextExp()` 取到下一个 2 的幂，即 `2 * 当前大小`。

## 三、缩容边界：`dictShrinkIfNeeded`

缩容条件与扩容不同，且有两个阈值档位。`_dictShrinkIfNeeded()` 在 `dictDelete` 后检查（实现在 `src/dict.c:1551`，真正的判定在调用的 `dictShrinkIfNeeded()`，`src/dict.c:1529`）：

- **`DICT_RESIZE_ENABLE`（正常模式）**：`ht_used[0] * HASHTABLE_MIN_FILL <= size`，即负载因子 <= 1/8（`HASHTABLE_MIN_FILL = 8`，`src/dict.h:27`）就触发缩容
- **`DICT_RESIZE_AVOID`（有 fork 子进程时）**：`ht_used[0] * HASHTABLE_MIN_FILL * dict_force_resize_ratio <= size`，即负载因子 <= 1/32 才触发缩容

关键判断在 `src/dict.c:1540`-`1543`：

```c
d->ht_used[0] * HASHTABLE_MIN_FILL <= DICTHT_SIZE(d->ht_size_exp[0])   /* ENABLE: 1/8 */
d->ht_used[0] * HASHTABLE_MIN_FILL * dict_force_resize_ratio <= DICTHT_SIZE(d->ht_size_exp[0])  /* AVOID: 1/32 */
```

缩容调用 `dictShrink(d, d->ht_used[0])`，新大小取 `_dictNextExp(ht_used[0])`（`src/dict.c:1545`），即元素数向上取到 2 的幂，但不会小于初始大小。

为什么 AVOID 时缩容阈值被压到 1/32？因为 AVOID 表示"正在 fork 或刚 fork 完"，此时所有 dict 都会放大缩容阈值，避免子进程 COW 或主进程在 fork 压力下额外的 rehash 内存开销。正常模式下 1/8 就够用——缩容的成本是重建哈希表，收益只在内存明显过剩时才值得。

## 四、`dictRehash()`：增量迁移核心

关键代码在 `src/dict.c:385`-`:425`：

```c
int dictRehash(dict *d, int n) {
    int empty_visits = n*10; /* 最多跳过 n*10 个空桶 */
    unsigned long s0 = DICTHT_SIZE(d->ht_size_exp[0]);
    unsigned long s1 = DICTHT_SIZE(d->ht_size_exp[1]);
    if (dict_can_resize == DICT_RESIZE_FORBID || !dictIsRehashing(d)) return 0;
    /* AVOID 模式下：扩容若 s1 < 4*s0、缩容若 s0 < 32*s1，暂停迁移 */
    if (dict_can_resize == DICT_RESIZE_AVOID &&
        ((s1 > s0 && s1 < dict_force_resize_ratio * s0) ||
         (s1 < s0 && s0 < HASHTABLE_MIN_FILL * dict_force_resize_ratio * s1)))
        return 0;

    while (n-- && d->ht_used[0] != 0) {
        while (d->ht_table[0][d->rehashidx] == NULL) {
            d->rehashidx++;
            if (--empty_visits == 0) return 1; /* 空桶太多，下次继续 */
        }
        rehashEntriesInBucketAtIndex(d, d->rehashidx);
        d->rehashidx++;
    }
    return !dictCheckRehashingCompleted(d);
}
```

参数 `n` 是要迁移的桶数。`empty_visits = n*10` 限制空桶扫描次数——如果遇到连续空桶，最多跳过 `n*10` 个，避免 rehash 在稀疏表上耗时。**开头的 FORBID 判断与 AVOID 阈值判断说明：`dict_can_resize` 不仅控制是否触发扩容/缩容，也控制进行中的 rehash 是否继续迁移。**

`dictCheckRehashingCompleted(d)` 检查 `ht[0]` 是否已全部迁移完。如果是，交换 `ht[0]` 和 `ht[1]`，释放 `ht[1]`，`rehashidx` 回到 `-1`。

## 五、每次操作一步：`dictRehash(d, 1)`

关键代码在 `src/dict.c:449`：

```c
if (d->pauserehash == 0) dictRehash(d, 1);
```

这行出现在 `dictAdd`、`dictFind`、`dictDelete`、`dictGetRandomKey` 等几乎所有操作入口中。每次操作后，迁移 1 个桶。

如果 rehash 正在进行（`rehashidx != -1`），操作会依次检查两个表：

- **查找**：先查 `ht[0]`，再查 `ht[1]`。
- **新增**：总是加到 `ht[1]`（新表）。
- **删除**：先从 `ht[0]` 删，找不到再从 `ht[1]` 删。
- **更新**：先找 `ht[0]`，找不到再找 `ht[1]`。

## 六、rehash 与 fork 的关系：`dict_can_resize` 全局开关

**正文写 `pauserehash` 用于 fork 是错误的。** 真实机制分两个独立开关：

### 1. `dict_can_resize`：控制"是否允许下次触发扩容/缩容"

`dict_can_resize` 是全局三态开关（`DICT_RESIZE_ENABLE` / `DICT_RESIZE_AVOID` / `DICT_RESIZE_FORBID`）。`updateDictResizePolicy()`（`src/server.c:643`）在 fork 生命周期中调整它：

- **`fork` 子进程内**（RDB 快照 / AOF 重写）：`DICT_RESIZE_FORBID`——子进程完全禁止扩容缩容
- **有 `fork` 子进程在跑**（主进程）：`DICT_RESIZE_AVOID`——除非负载因子 >= 4（扩容）或 <= 1/32（缩容），否则不触发
- **无子进程**：`DICT_RESIZE_ENABLE`

关键代码 `src/server.c:643`-`648`：

```c
void updateDictResizePolicy(void) {
    if (server.in_fork_child != CHILD_TYPE_NONE)
        dictSetResizeEnabled(DICT_RESIZE_FORBID);
    else if (hasActiveChildProcess())
        dictSetResizeEnabled(DICT_RESIZE_AVOID);
    else
        dictSetResizeEnabled(DICT_RESIZE_ENABLE);
}
```

这个开关影响的是**扩容/缩容的判定函数**（`dictExpandIfNeeded` / `dictShrinkIfNeeded`），不暂停已经开始进行的 rehash。

### 2. `pauserehash`：控制"已开始的 rehash 是否继续迁移"

`pauserehash` 是 dict 实例级字段，用于 `dictTwoPhaseUnlinkFree`（`dict.c:815`）这类**两阶段删除/遍历**场景：先找到 entry 并 unlink，暂停 rehash 再释放，避免释放期间迁移导致条目移位。它与 fork 无关。

`pauserehash > 0` 时，`_dictRehashStep` / `dictRehashMicroseconds` / `_dictBucketRehash` 都直接返回（`dict.c:427`/`:449`/`:454`）。

## 七、SipHash 替换 MurmurHash

Redis 4.0 之前使用 MurmurHash2，4.0 之后切换到 SipHash。

SipHash 是一种**密钥化的哈希函数**，使用 16 字节的随机种子（`dict_hash_function_seed[16]`，`src/dict.c:92` 中定义，`dictSetHashFunctionSeed()` 初始化，`src/dict.c:94`）。相同输入在不同种子下产生不同哈希值，攻击者无法预测哈希分布，从而防止 HashDoS 攻击。

## 八、失败路径

### 1. `DICT_RESIZE_AVOID` 期间负载因子居高不下

fork 子进程运行期间，`dict_can_resize = DICT_RESIZE_AVOID`，扩容阈值被抬到负载因子 >= 4、缩容阈值被压到 <= 1/32。此时如果数据持续增长但没到 4:1，哈希表保持原大小不变，**负载因子持续上升**（比如到 3:1），哈希冲突变多，读写性能下降。这不是内存膨胀，而是"该扩没扩"时的密度压力——fork 结束后 `dict_can_resize` 回到 `ENABLE`，负载因子 >= 1 即触发扩容。

### 2. `DICT_RESIZE_FORBID` 期间完全不自动扩缩

fork 子进程**内部**（RDB 快照/AOF 重写子进程）`dict_can_resize = FORBID`，任何自动扩容/缩容都禁止。注意：子进程本来就不该写数据（COW），所以这是防御性约束，不是正常路径。

### 3. rehash 已在迁移中，AVOID 会暂停迁移本身

`dictRehash()` 开头有 AVOID 检查（`dict.c:390`-`398`）：如果 `s1 > s0`（正在扩容）但 `s1 < 4*s0`，或 `s1 < s0`（正在缩容）但 `s0 < 32*s1`，直接返回 0 ——**已开始的 rehash 也可能在 AVOID 期间暂停**。此时 `rehashidx` 停在半途，`ht[0]` 和 `ht[1]` 双表并存，内存占用量是单表的两倍，且要等 fork 结束后才继续迁移。

### 4. 内存碎片 / 双表并存

rehash 进行期间 `ht_table[0]` 和 `ht_table[1]` 同时存在，内存使用量翻倍。大 dict 在 rehash 时可能瞬间需要接近两倍的内存，接近 `maxmemory` 时更容易触发淘汰。

## 到这里，R-3 真正立住的是"双表 + 渐进式 rehash"

如果只看表面，Dict 被读成"带了 rehash 功能的哈希表"。

更稳的理解方式应该是：

1. `struct dict` 用 `ht_table[2]` + `rehashidx` 实现双表结构
2. 扩容由 `dictExpandIfNeeded` 在插入时触发，ENABLE 下负载因子 >= 1 扩，AVOID 下 >= 4 才扩
3. 缩容由 `dictShrinkIfNeeded` 在删除后触发，ENABLE 下 <= 1/8 缩，AVOID 下 <= 1/32 才缩
4. `dictRehash(d, 1)` 每次操作后迁移 1 个桶，把 O(n) 摊到 O(1) 均摊
5. rehash 期间增删改查同时在两个表上操作，不阻塞
6. fork 用 `dict_can_resize` 全局开关（ENABLE/AVOID/FORBID）控制"是否允许扩缩"，不用 `pauserehash`
7. `pauserehash` 是 dict 实例级字段，用于两阶段删除/遍历时临时暂停迁移，与 fork 无关
8. SipHash 防止 HashDoS 攻击

## 下篇桥接

R-5 List/quicklist 将展开另一种数据结构——List 从 ziplist 到 listpack 的迁移，以及 quicklist 的分页存储设计。
