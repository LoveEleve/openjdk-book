# 为什么 Set 有三种编码：intset / listpack / HT

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第六篇，回答 Set 为什么有三种编码，以及 intset 的升级机制。

## 为什么"Set 就是集合"这个理解会把 Set 读浅

很多人第一次用 Redis Set，觉得它就是一个集合，SADD 进去就完了。

但 Redis 的 Set 在 7.4 中有 **三种编码**，不是一种：

- **intset**（`OBJ_ENCODING_INTSET`）：全整数小集合，有序数组 + 二分查找
- **listpack**（`OBJ_ENCODING_LISTPACK`）：非整数小集合，紧凑编码
- **HT**（`OBJ_ENCODING_HT`）：大集合，dict 哈希表

三种编码在运行时按需切换，目的是让**小集合紧凑省内存，大集合用哈希表保证 O(1) 操作**。

## 一、intset 结构：encoding + length + contents[]

关键代码在 `src/intset.h:35`-`:39`：

```c
typedef struct intset {
    uint32_t encoding;
    uint32_t length;
    int8_t contents[];
} intset;
```

intset 是一个**有序整数数组**。`encoding` 决定每个元素占用多少字节（INT16=2、INT32=4、INT64=8），`length` 是元素数量，`contents[]` 是连续存储的整数数组。

编码宏在 `src/intset.c:41`-`:43`：

```c
#define INTSET_ENC_INT16 (sizeof(int16_t))
#define INTSET_ENC_INT32 (sizeof(int32_t))
#define INTSET_ENC_INT64 (sizeof(int64_t))
```

## 二、intset 编码升级：INT16→INT32→INT64 单向升级

`intsetAdd()`（`src/intset.c:206`）先检查新值的编码是否大于当前编码：

```c
uint8_t valenc = _intsetValueEncoding(value);
if (valenc > intrev32ifbe(is->encoding))
    return intsetUpgradeAndAdd(is,value);
```

`_intsetValueEncoding()`（`src/intset.c:46`）根据值范围选择编码：

- `[-2^15, 2^15-1]` → INT16
- `[-2^31, 2^31-1]` → INT32
- 其他 → INT64

`intsetUpgradeAndAdd()`（`src/intset.c:159`）先在新编码下重分配内存，然后从后往前把旧元素逐个迁移到新数组，最后插入新值。因为新值一定大于（或小于）所有旧值，所以插入在头部或尾部，不需要查找位置。

**intset 只升不降**——即使所有元素都在 INT16 范围内，也不会从 INT32 降回 INT16。因为降级需要重新分配所有元素，且很少发生，不值得做。

## 三、intset 的二分查找

`intsetSearch()` 在 intset 中通过二分查找定位元素或插入位置。因为 `contents[]` 始终有序，二分查找 O(logN) 在 512 个元素以内比哈希表 O(1) 的常数更低。

## 四、listpack 编码的 Set

当元素不是整数（比如字符串）但集合还小时，Redis 用 `OBJ_ENCODING_LISTPACK` 编码。`setTypeCreate()`（`src/t_set.c:25`）决定创建哪种编码：

```c
if (isSdsRepresentableAsLongLong(value,NULL) == C_OK && size_hint <= server.set_max_intset_entries)
    return createIntsetObject();
if (size_hint <= server.set_max_listpack_entries)
    return createSetListpackObject();
return createSetObject();  // HT
```

默认配置：`set-max-intset-entries = 512`（`src/config.c:3216`），`set-max-listpack-entries = 128`（`src/config.c:3217`），`set-max-listpack-value = 64`（`src/config.c:3218`）。

## 五、编码转换：intset/listpack ↔ HT

转换发生在 `setTypeMaybeConvert()`（`src/t_set.c:40`）中：

```c
if ((set->encoding == OBJ_ENCODING_LISTPACK && size_hint > server.set_max_listpack_entries)
    || (set->encoding == OBJ_ENCODING_INTSET && size_hint > server.set_max_intset_entries))
    setTypeConvertAndExpand(set, OBJ_ENCODING_HT, size_hint, 1);
```

**intset → HT**：当 intset 元素数超过 512 时，`maybeConvertIntset()`（`src/t_set.c:57`）直接转 HT（跳过 listpack）。

**listpack → HT**：当 listpack 元素数超过 128 或元素长度超过 64 时，转 HT。

**HT → intset**：`maybeConvertToIntset()`（`src/t_set.c:67`）检查 HT 中所有元素是否都是整数且大小 <= 512，如果是则转回 intset。

**HT → listpack**：不支持。HT 只能转回 intset（如果所有元素都是整数），不能转回 listpack。

## 六、SADD 命令入口

`src/t_set.c:583` `saddCommand()` 调用 `setTypeAdd()`（`:94`）→ `setTypeAddAux()`（`:99`），根据编码分派操作：

- intset 编码：调 `intsetAdd()`
- listpack 编码：在 listpack 中插入
- HT 编码：调 `dictFindPositionForInsert` + `dictInsertAtPosition`

## 七、失败路径

### 1. intset 只升不降

intset 从 INT16 升级到 INT32 后，即使所有元素都删到 INT16 范围内，也不会降级。这是 Redis 的"单向升级"策略——降级成本高且很少发生。

### 2. 频繁编码转换

如果元素数在阈值附近波动（如 510~515 个整数），可能反复触发 intset↔HT 转换，每次转换 O(N) 复制。阈值 512 的 2 个缓冲余量不足以完全避免，但实际中很少出现。

### 3. intset 升级时的全量重分配

`intsetUpgradeAndAdd` 需要重新分配全部内存，O(N) 重写所有元素。大集合升级时（如 INT16 到 INT64）有短暂延迟。

## 到这里，R-7 真正立住的是"Set 是三种编码的运行时切换"

如果只看表面，Set 被读成"一个集合"。

更稳的理解方式应该是：

1. intset：有序整数数组 + 二分查找，INT16/32/64 三级编码，只升不降
2. listpack：非整数小集合的紧凑编码
3. HT：大集合的 dict 哈希表
4. intset/listpack 超阈值后转 HT，HT 条件满足时转回 intset
5. `set-max-intset-entries`（512）和 `set-max-listpack-entries`（128）控制转换阈值

## 下篇桥接

R-10 Stream/rax 将展开 Stream 的基数树（rax）实现和消费者组机制。
