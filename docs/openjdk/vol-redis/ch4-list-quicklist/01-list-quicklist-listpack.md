# 为什么一个 List 要换四次编码

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第四篇，回答 List 从 ziplist 到 quicklist 再到 listpack 加 quicklist 的编码演进，以及 quicklist 的分页存储与 LZF 压缩设计。

## 为什么"List 就是链表"这个理解会把 List 读浅

很多人第一次用 Redis List，觉得它就是一个链表 lpush/rpush 就行了。

但 Redis 的 List 编码换了四次：
- 早期：ziplist（紧凑编码，但有连锁更新问题）
- 中期：quicklist（双向链表 + ziplist 分页，缓解连锁更新）
- Redis 7.0：**小 List 用 listpack 直存，大 List 用 quicklist（listpack 做节点容器），彻底消除连锁更新**

这个演进不是为了"换口味"，而是为了在**内存紧凑**和**操作性能**之间找到更好的平衡点。**许多读者以为 7.0 只是把 quicklist 的节点从 ziplist 换成 listpack，但真正变化是：小 List 根本不需要 quicklist 包装——直接一个 listpack 就够了。**

## 一、ziplist 的布局与连锁更新问题

ziplist 是一种紧凑的连续内存数据结构，布局在 `src/ziplist.c:16` 的注释中描述：

```
<zlbytes> <zltail> <zllen> <entry> <entry> ... <entry> <zlend>
```

- `zlbytes`（4 字节）：整个 ziplist 的字节数
- `zltail`（4 字节）：最后一个 entry 的偏移量，用于 O(1) 尾操作
- `zllen`（2 字节）：entry 数量

每个 entry 的格式包含 `prevlen`（前一个 entry 的长度，用于反向遍历）和 `encoding` + `data`。

**连锁更新问题**：当 `prevlen` 用 1 字节表示（< 254）但前一个 entry 增长到 >= 254 字节时，`prevlen` 需要从 1 字节扩展到 5 字节。如果这个 entry 接下来又推动了下一个 entry 的 `prevlen` 扩展，就会形成**连锁反应**，最坏情况下 O(n^2) 的 realloc 成本。

## 二、listpack：消除连锁更新

listpack 的代码在 `src/listpack.c`。它的核心设计是**每 entry 自包含长度，不依赖前个 entry 的信息**。

listpack header 格式（`src/listpack.c:84`-`89`）：

```
<4 bytes total_bytes> <2 bytes num_elements> <entry> ... <entry> <end>
```

每 entry 的编码：前几个字节编码了 entry 自身的总长度，且**编码在后向而不是前向**：

```
<encoding-type><element-data><element-backlen>
```

`element-backlen` 编码在 entry 的末尾，告诉解码器从后往前读多长。这意味着**每个 entry 都是自包含的**——不需要知道前一个 entry 的尺寸来定位自己，也没有 `prevlen` 字段，所以完全消除了连锁更新。

## 三、List 的双编码：listpack 直存 vs quicklist 包装

Redis 7.0 以后，List 使用**两种编码**，不是只有 quicklist：

### 1. `OBJ_ENCODING_LISTPACK`（11）：小 List 直存

创建新 List 时，`createListListpackObject()`（`src/object.c:221`）直接创建一个 listpack 对象，`encoding = OBJ_ENCODING_LISTPACK`。此时 List 就是一个 listpack，没有 quicklist 包装。

### 2. `OBJ_ENCODING_QUICKLIST`（9）：大 List 转 quicklist

当 listpack 的大小超过 `list-max-listpack-size`（`src/config.c:3152`，旧名 `list-max-ziplist-size`）时，`listTypeTryConvertListpack()`（`src/t_list.c:21`）在 `pushGenericCommand` 中调用，把 listpack 转换为 quicklist：

```c
quicklist *ql = quicklistNew(server.list_max_listpack_size, server.list_compress_depth);
quicklistAppendListpack(ql, o->ptr);
o->encoding = OBJ_ENCODING_QUICKLIST;
```

转换后，原来的 listpack 成为 quicklist 的第一个节点，后续元素继续追加到 quicklist 的节点中。反过来，如果 List 被 `ltrim` 或 `lpop` 缩小到足够小，也会从 quicklist 转回 listpack（`src/t_list.c` 中 `listTypeTryConvertQuicklist` 处理）。

## 四、quicklist 结构：分页存储

关键代码在 `src/quicklist.h:47`-`:59` 和 `:99`-`:108`：

```c
typedef struct quicklistNode {
    struct quicklistNode *prev;
    struct quicklistNode *next;
    unsigned char *entry;          /* 指向 listpack 或原始数据 */
    size_t sz;                     /* entry 的字节数 */
    unsigned int count : 16;       /* 该节点中的元素数 */
    unsigned int encoding : 2;     /* RAW=1, LZF=2 */
    unsigned int container : 2;    /* PLAIN=1, PACKED=2 */
    unsigned int recompress : 1;   /* 是否刚被解压 */
    // ...
} quicklistNode;

typedef struct quicklist {
    quicklistNode *head;
    quicklistNode *tail;
    unsigned long count;           /* 所有 node 的总元素数 */
    unsigned long len;             /* node 数量 */
    signed int fill : QL_FILL_BITS; /* 节点填充因子 */
    unsigned int compress : QL_COMP_BITS; /* 不压缩的端部节点深度 */
} quicklist;
```

`quicklist` 是一个双向链表，每个节点（`quicklistNode`）包含一个 **listpack**（`container=PACKED`）或**原始数据**（`container=PLAIN`）。`encoding=RAW` 表示不压缩，`encoding=LZF` 表示已用 LZF 算法压缩。

## 五、`fill` 与 `compress` 参数

### `fill`（填充因子）

`fill` 控制每个 quicklistNode 最多存多少元素。正数：每节点最多存 `fill` 个元素；负数：每节点大小限制（如 `-1` = 4KB，`-2` = 8KB）。

`fill` 在 `src/quicklist.h` 的 `QL_FILL_BITS` 位宽中定义。`list-max-listpack-size` 配置项控制它（旧名 `list-max-ziplist-size` 保留为别名，`src/config.c:3152`）。

### `compress`（压缩深度）

`compress` 控制两端不压缩的节点数。`0` = 不压缩，`1` = 两端各 1 个节点不压缩，中间节点压缩，`2` = 两端各 2 个节点不压缩，以此类推。

压缩使用 **LZF 算法**（`quicklist.h:66` `quicklistLZF` 结构体）。`src/quicklist.c` 中 `__quicklistCompress()` 负责压缩，`__quicklistCompressNode()` 调用 `lzf_compress`。解压发生在操作访问该节点时，解压后设置 `recompress=1`，操作完成后重新压缩。

## 六、t_list.c 命令入口

`src/t_list.c` 中的命令实现：

- `lpushCommand`（`:493`）→ `pushGenericCommand` → `listTypePush` → `quicklistPush`（或 listpack 的 `lpPrependInteger`）
- `rpushCommand`（`:498`）→ `pushGenericCommand` → `listTypePush` → `quicklistPush`（或 `lpAppendInteger`）
- `lpopCommand`（`:846`）→ 从头部弹出
- `rpopCommand`（`:851`）→ 从尾部弹出
- `lrangeCommand`（`:856`）→ 范围遍历

`pushGenericCommand`（`src/t_list.c:464`）先检查编码是 quciklist 还是 listpack，再分别调用 `listTypePush`（`src/t_list.c:144`）做不同的插入。`listTypePush` 内部对 `OBJ_ENCODING_QUICKLIST` 调 `quicklistPush`，对 `OBJ_ENCODING_LISTPACK` 调 `lpPrependInteger`/`lpAppendInteger`。

`quicklistPushHead`（`src/quicklist.c:583`）先检查当前头节点是否有空间（`fill`），如果已满则创建新节点并插入链表头部。

## 七、失败路径

### 1. 连锁更新（ziplist，已淘汰）

如果使用旧版 ziplist，最坏情况下一次插入可能触发 O(n^2) 的 realloc。Redis 7.0 全面迁移到 listpack 后这个风险消除。

### 2. LZF 压缩开销

`compress > 0` 时，被压缩的节点每次访问都需要解压再压缩。如果 `compress` 设置过大，热点数据在压缩节点中，会引入额外的 CPU 开销。

### 3. `fill` 设置不当

`fill` 太小，每个 listpack 中存储的元素太少，quicklistNode 数量过多，增加了链表遍历的节点数。`fill` 太大，单个 listpack 过大，插入/删除的 realloc 成本增加。

## 到这里，R-5 真正立住的是"quicklist 是分页式 List"

如果只看表面，List 被读成"双向链表"。

更稳的理解方式应该是：

1. ziplist 紧凑但连锁更新，listpack 自包含每 entry 长度，消除连锁更新
2. Redis 7.0 全面迁移到 listpack（作为 quicklist 的 entry 容器）
3. quicklist 是双向链表，每个节点指向一个 listpack（分页存储）
4. `fill` 控制每节点元素量，`compress` 控制两端免压缩深度
5. LZF 压缩中间节点，访问时解压，操作完重新压缩

## 下篇桥接

R-6 ZSet 将展开另一种双结构组合——skiplist + dict 的 ZSet 实现，以及 ZRANK 的 O(logN) span 机制。
