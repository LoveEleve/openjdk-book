# 为什么 ZSet 同时用 skiplist 和 dict

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第五篇，回答 ZSet 为什么同时用 skiplist 和 dict 两种结构，以及 ZRANK 如何 O(logN) 排名。

## 为什么"ZSet 就是有序集合"这个理解会把 ZSet 读浅

很多人第一次用 ZSet，觉得它就是一个"按 score 排序的集合"。

这当然不是错，但这样理解，就没看到 ZSet 的真正设计精髓：**ZSet 不是"一个带排序的 Set"，而是 skiplist（按 score 排序） + dict（按 member 查 score）的双结构组合**。两个结构共享同一个 `ele` 指针，没有重复存储。

`zset.dict` 负责 O(1) 的 member → score 查找，`zset.zsl` 负责 O(logN) 的按 score 范围查询和排名。缺一不可。

## 一、zset 结构：dict + zskiplist 双结构

关键代码在 `src/server.h:1357`-`:1359`：

```c
typedef struct zset {
    dict *dict;
    zskiplist *zsl;
} zset;
```

`zset.dict` 的 key 是 member（ele），value 是 score。`zset.zsl` 的节点同时存储 ele 和 score。两个结构**共享同一个 `ele` 指针**，不需要各自复制一份数据。

## 二、skiplist 节点：level[] 数组 + forward + span

关键代码在 `src/server.h:1341`-`:1349`：

```c
typedef struct zskiplistNode {
    sds ele;
    double score;
    struct zskiplistNode *backward;
    struct zskiplistLevel {
        struct zskiplistNode *forward;
        unsigned long span;
    } level[];
} zskiplistNode;
```

每个节点包含一个 `level[]` 柔性数组，每个 level 包含 `forward`（指向该层下一个节点）和 `span`（到下一个节点的跨度）。`span` 实现了 **O(logN) 的 ZRANK**——从头节点开始，沿搜索路径累加各层的 span，就能得到该元素的排名，不需要遍历全部节点。

`zskiplist` 结构体（`src/server.h:1351`-`:1355`）包含 `header`（头节点，不存数据，有 `ZSKIPLIST_MAXLEVEL` 层）、`tail`、`length`（元素总数）和 `level`（当前最高层数）。

## 三、zslRandomLevel：P=0.25，最大 32 层

关键代码在 `src/t_zset.c:120`-`:131`：

```c
int zslRandomLevel(void) {
    static const int threshold = ZSKIPLIST_P * RAND_MAX;
    int level = 1;
    while (random() < threshold)
        level += 1;
    return (level < ZSKIPLIST_MAXLEVEL) ? level : ZSKIPLIST_MAXLEVEL;
}
```

`ZSKIPLIST_P = 0.25`（`src/server.h:515`），`ZSKIPLIST_MAXLEVEL = 32`（`src/server.h:514`）。

每次随机上升一层的概率是 25%，所以：
- 第 1 层：100%
- 第 2 层：25%
- 第 3 层：6.25%
- ...
- 第 32 层：0.25^31 ≈ 无法达到

`P=0.25` 比经典 skiplist 的 `P=0.5` 更小，意味着 Redis 的 skiplist 层数更少、节点更稀疏，但查询时跳跃更大。这是 Redis 在"内存"和"查询速度"之间的权衡——更少的层意味着更少的 `level[]` 数组内存开销。

## 四、双编码：listpack 编码的 ZSet

ZSet 和 List 一样，小数据也用 listpack 编码。创建时判断（`src/t_zset.c:1240`-`:1243`）：

```c
if (size_hint <= server.zset_max_listpack_entries &&
    val_len_hint <= server.zset_max_listpack_value)
    return createZsetListpackObject();
return createZsetObject();
```

默认配置：`zset-max-listpack-entries = 128`（`src/config.c:3219`），`zset-max-listpack-value = 64` 字节（`src/config.c:3223`）。当元素数超过 128 或任一元素长度超过 64 字节时，`zsetConvertAndExpand()`（`src/t_zset.c:69`）将 listpack 编码转换为 skiplist + dict 编码。

## 五、ZADD 流程：双结构同步操作

`zsetAdd()`（`src/t_zset.c:1425`）是 ZADD 的统一入口：

1. 先通过 `zsetScore()` 查 dict 看 member 是否已存在
2. 如果新增，同时插入 skiplist（`zslInsert`）+ dict（`dictAdd`）
3. 如果更新 score，先删 skiplist（`zslDelete`）再插（`zslInsert`），同时更新 dict
4. 如果编码是 listpack，直接在 listpack 上操作，满足条件时调用 `zsetConvertAndExpand` 转 skiplist

## 六、失败路径

### 1. skiplist 层数分布不均

`zslRandomLevel` 基于概率，可能出现某个节点层数特别高（虽然概率极低）。`ZSKIPLIST_MAXLEVEL = 32` 限制了最大层数，2^64 个元素以内 32 层足够。

### 2. score 相同时的字典序

skiplist 按 score 排序，score 相同时按 ele 字典序排序。`zslInsert` 中 `score == curscore` 时用 `sdscmp(ele, cur->ele) > 0` 决定位置。这意味着不同 member 但相同 score 时，ZRANK 排名可能因字典序变化。

### 3. 双结构一致性问题

`zslInsert` 和 `dictAdd` 必须同步成功。实际源码用 **`serverAssert` 强制一致性**，不是"返回错误"：

新增路径（`src/t_zset.c:1542`-`1543`）：

```c
znode = zslInsert(zs->zsl,score,ele);
serverAssert(dictAdd(zs->dict,ele,&znode->score) == DICT_OK);
```

`dictAdd` 一旦失败直接 `serverAssert` 崩溃，不会留下"skiplist 改了 dict 没改"的不一致状态。这是因为 Redis 单线程模型下，skiplist 和 dict 是同步操作的，唯一可能失败的是 `zmalloc` 分配内存失败（OOM），此时断言崩溃比静默不一致更安全。

更新 score 路径（`t_zset.c:1532`-`1537`）也不一样：不是先删再插，而是调用 `zslUpdateScore()`（`t_zset.c:264`）——它内部判断新 score 是否让节点还留在原位置（`x->backward->score < newscore && x->level[0].forward->score > newscore`），如果位置不变只更新 `x->score`，如果位置变了才 `zslDeleteNode` + `zslInsert`。然后 `dictSetVal` 更新 dict 中存的 score 指针。

所以"双结构不一致"在单线程模型下不会发生——它是被 `serverAssert` 防御性保证的，而不是一个未处理的边界。

## 到这里，R-6 真正立住的是"skiplist + dict 双结构互补"

如果只看表面，ZSet 被读成"带排序的集合"。

更稳的理解方式应该是：

1. `zset` 包含 `dict`（O(1) 查 score） + `zskiplist`（O(logN) 排序和排名），互补
2. skiplist 的 `level[].span` 实现 O(logN) ZRANK
3. `P=0.25` 比经典 `P=0.5` 更稀疏，减少内存
4. 小 ZSet 用 listpack 编码，超阈值后转 skiplist
5. score 相同时按 ele 字典序排序

## 下篇桥接

R-7 Set/intset 将展开 Set 的两种编码——intset（整数集合）和 HT（哈希表），以及 intset 升级时的全量重分配。
