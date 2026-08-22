# 为什么 Redis 不直接用 C 的 `char *`，而要包一层 `redisObject`

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第一篇，回答 `redisObject` 为什么把 `type` 与 `encoding` 分离，以及一个对象如何决定用哪种底层编码。

## 为什么"redisObject 就是存值的结构体"这个理解会把类型系统读浅

很多人第一次看 Redis 源码，看到 `redisObject` 只有 5 个字段，会觉得很普通：

- `type`
- `encoding`
- `lru`
- `refcount`
- `ptr`

这当然不是错，但这样理解，就看不出来为什么 `redisObject` 是Redis 所有数据结构卷的地基：

因为 `encoding` 字段不是"存储格式"，而是 **运行时编码决策的开关**。同一种 `type`（比如 `OBJ_STRING`）可以对应 `INT`、`EMBSTR`、`RAW` 三种编码。编码的选择不是编译时决定的，而是由 `createStringObject()` 在创建时根据字符串长度决定，并且可以在运行时通过 `tryObjectEncoding()` 升级。

也就是说，`redisObject` 不是"存值的对象"，而是 **类型-编码开关**。

## 一、`struct redisObject`：5 个字段的位预算

关键代码在：

- `src/server.h:906`-`:910` 结构体定义
- `src/server.h:882`-`:896` encoding 枚举

```c
struct redisObject {
    unsigned type:4;
    unsigned encoding:4;
    unsigned lru:LRU_BITS; // LRU_BITS = 24
    int refcount;
    void *ptr;
};
```

### 1. `type:4` 和 `encoding:4`：各占 4 位

`type` 决定逻辑语义（是什么），`encoding` 决定物理布局（怎么存）。

`type` 取值很少（`OBJ_STRING`、`OBJ_LIST`、`OBJ_SET`、`OBJ_ZSET`、`OBJ_HASH` 等），4 位完全够用。

`encoding` 取值在 7.4 版本中已经扩展到 13 种：

- `src/server.h:882`-`896`：
  - `OBJ_ENCODING_RAW 0`：原始 SDS 字符串
  - `OBJ_ENCODING_INT 1`：整数编码
  - `OBJ_ENCODING_HT 2`：哈希表
  - `OBJ_ENCODING_ZIPMAP 3`：已废弃
  - `OBJ_ENCODING_LINKEDLIST 4`：已废弃
  - `OBJ_ENCODING_ZIPLIST 5`：已废弃
  - `OBJ_ENCODING_INTSET 6`：整数集合
  - `OBJ_ENCODING_SKIPLIST 7`：跳表
  - `OBJ_ENCODING_EMBSTR 8`：嵌入式 SDS
  - `OBJ_ENCODING_QUICKLIST 9`：quicklist
  - `OBJ_ENCODING_STREAM 10`：Stream
  - `OBJ_ENCODING_LISTPACK 11`：listpack
  - `OBJ_ENCODING_LISTPACK_EX 12`：带扩展元数据的 listpack

3 个已废弃（ZIPMAP / LINKEDLIST / ZIPLIST），10 个活跃。4 位编码（0-15）完全够用。

### 2. `lru:24`：LRU 时钟与 LFU 的双重身份

`lru` 字段的 24 位在不同的淘汰策略下承载不同的含义：

- **LRU 模式**：存 `lru_clock` 时钟值，`LRU_CLOCK_RESOLUTION = 1000ms`，24 位足以覆盖 ~194 天
- **LFU 模式**：拆成 16 位访问时间 + 8 位频率计数，`log` 化计数器

### 3. `refcount`：引用计数，不是 GC

- `OBJ_SHARED_REFCOUNT = INT_MAX`：共享对象永不销毁
- `OBJ_STATIC_REFCOUNT = INT_MAX-1`：栈上分配的对象
- `refcount > 1` 时，`tryObjectEncoding()` 跳过编码升级

### 4. `ptr`：万能指针

指向底层数据结构的实际存储。对于 `INT` 编码，直接存 `(void*)value`。

## 二、`type` 与 `encoding` 分离：为什么 type 对外、encoding 对内

`type` 与 `encoding` 分离解决了两个问题：

### 1. 对外保证语义不变

`type = OBJ_STRING` 永远是字符串，不管背后是 `INT` 编码（长整数）、`EMBSTR` 编码（小字符串）还是 `RAW` 编码（大字符串）。

### 2. 对内允许编码优化

`encoding` 可以在运行时改变，不影响外部语义。例如：

- `SET` 一个整数 → `createStringObjectFromLongLongWithOptions()` 创建 `INT` 编码（`src/object.c:128`）
- `APPEND` 之后字符串变长 → `tryObjectEncodingEx()` 检查是否还能保持 `INT` 编码，不能则转为 `RAW`（`src/object.c:607`）

`type` 与 `encoding` 分离，是**接口与实现分离**在 C 语言中的朴素实现。

## 三、String 的三种编码：INT / EMBSTR / RAW 的分界

### 1. `INT` 编码

- `src/object.c:607`-`:679` `tryObjectEncodingEx()`
- 条件：字符串可以用 `string2l()` 解析为长整数，且值在 `[0, OBJ_SHARED_INTEGERS)` 范围
- `shared.integers[value]` 返回共享对象（`src/server.c:1991`-`1998`）

### 2. `EMBSTR` 编码

- `src/object.c:101` `OBJ_ENCODING_EMBSTR_SIZE_LIMIT` = 44
- `src/object.c:76`-`:90` `createEmbeddedStringObject()`
- `redisObject` + `sdshdr8` + `buf[]` 一同分配在 64 字节的 jemalloc arena 中
- `createStringObject()` 在 `src/object.c:102`-`:114` 判断：`len <= 44` → EMBSTR，否则 RAW

### 3. `RAW` 编码

- `src/object.c:63`-`:66` `createRawStringObject()`：`redisObject` 和 SDS 分别分配
- 用于大于 44 字节的字符串，或需要频繁修改的字符串

### 4. 编码升级的边界

`tryObjectEncodingEx()` 的逻辑（`src/object.c:607`-`:679`）：

1. 只对 `OBJ_STRING` 类型操作
2. 跳过共享对象（`refcount > 1`）
3. 检查能否转为 `INT` 编码：长度 ≤ 20 且 `string2l()` 返回 true
4. 不能转为 INT 则检查能否转为 `EMBSTR`：长度 ≤ 44
5. 都不能则保持 `RAW` 编码，尝试 `trimStringObjectIfNeeded()`

## 四、共享对象：`shared.integers[10000]`

关键代码在：

- `src/server.h:108` `OBJ_SHARED_INTEGERS 10000`
- `src/server.h:1332` `shared.integers` 声明
- `src/server.c:1991`-`1998` 初始化循环

共享整数对象可以省去重复创建，但有一个限制：**当 `maxmemory` 开启且策略为 LRU/LFU 时，共享整数被禁用**，因为每个对象需要独立的 `lru` 字段。

## 五、`lru` 的双重身份

`lru` 在 LRU 模式下存 `lru_clock`，在 LFU 模式下被拆解为：

- 高 16 位：访问时间（分钟级）
- 低 8 位：`log` 化的频率计数器

`server.h:910` 的注释已说明其双重身份。LRU 与 LFU 的选择在 `maxmemory-policy` 配置中。

## 六、refcount 与对象的生命周期

`refcount` 控制对象的销毁时机：

- `decrRefCount()` 在引用计数降为 0 时调用 `freeObject()` 释放内存
- 共享对象（`refcount = INT_MAX`）永不释放
- 栈上对象（`refcount = INT_MAX-1`）也不释放

## 七、编码升级与"只升不降"

Redis 的编码升级是**单向的**：

- `INT` → `EMBSTR` → `RAW`：只升不降
- 不会出现 `RAW` → `INT` 的降级（即使字符串内容可以转为整数）

这是因为编码升级通常是因为字符串变长、计算复杂度升高，而降级需要额外的扫描成本，且很少发生。

## 八、失败路径

### 1. EMBSTR 阈值 44 字节

`OBJ_ENCODING_EMBSTR_SIZE_LIMIT = 44` 不是随意选的，而是 `jemalloc 64 byte arena` 下的最优值：`sizeof(robj)` + `sizeof(sdshdr8)` + `len + 1` <= 64。

### 2. 共享整数在 maxmemory 下的禁用

`tryObjectEncodingEx():619`-`623`：当 `maxmemory > 0` 且策略不支持共享整数时，走 `INT` 编码但不共享。

### 3. 检测编码时的分支

`switch (o->encoding)` 在 `object.c` 各处出现，每个分支必须覆盖所有可能的编码值。漏掉一个编码可能导致误判类型。

## 到这里，R-1 真正立住的是"redisObject 是类型-编码开关"

如果只看表面，`redisObject` 被读成一个"5 个字段的内存对象"。

更稳的理解方式应该是：

1. `redisObject` 不是"存值的结构体"，而是 **类型-编码开关**
2. `type:4` 决定逻辑语义（是什么），`encoding:4` 决定物理布局（怎么存）
3. 同一个 `type` 可以有多种 `encoding`，编码选择是"内存 vs 性能"的运行时决策
4. 编码升级是单向的（只升不降），发生在字符串变长或计算复杂度升高时
5. `redisObject` 是所有数据结构卷的地基，R-3 到 R-10 每一种结构都是 `encoding` 字段的展开

## 下篇桥接

R-4 SDS 将展开 `encoding` 为 `RAW` 或 `EMBSTR` 时的实际存储载体——SDS 字符串的 5 种 header、二进制安全、预分配策略与 sdshdr5 的陷阱。
