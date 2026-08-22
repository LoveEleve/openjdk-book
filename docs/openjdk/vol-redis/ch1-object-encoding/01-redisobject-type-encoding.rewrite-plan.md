# 篇：01 redisObject 类型系统：type 与 encoding 为什么分离

- 域：`R-1 redisObject 类型系统`
- 卷：`vol-redis`
- 目标：回答 `redisObject` 为什么把 `type` 与 `encoding` 分离，以及一个对象如何决定用哪种底层编码。

## 前置依赖

- HARD：无（第一卷第一篇）。
- SOFT：了解 C 语言结构体与位域。

## 读者问题

为什么 Redis 不直接用 C 的 `char *` / `long` 存值，而要包一层 `redisObject`？以及：

1. `type`（对外类型）与 `encoding`（对内编码）为什么分开？
2. 一个 String 为什么有 INT / EMBSTR / RAW 三种编码？
3. 共享整数 `shared.integers[10000]` 省了什么？
4. `lru:24bit` 怎么同时承载 LRU 和 LFU？
5. 编码何时会升级？为什么 Redis 只升级不降级？

## 主结论

`redisObject` 不是"对象的存储结构"，而是 **类型-编码开关**：`type` 决定逻辑语义（是什么），`encoding` 决定物理布局（怎么存）。同一个 type 可以有多种 encoding，编码选择是"内存 vs 性能"的运行时决策。这是 Redis 所有数据结构卷的地基——后续 R-3~R-10 每一种结构都是 `encoding` 字段的展开。

`server.h:907` 起 20 行：

```c
struct redisObject {
    unsigned type:4;
    unsigned encoding:4;
    unsigned lru:LRU_BITS; /* LRU time or LFU data */
    int refcount;
    void *ptr;
};
```

## 结构设计

1. 困惑开场：为什么一个 `char *` 不够，要包一层对象
2. `struct redisObject`：五个字段的位预算（type:4 / encoding:4 / lru:24 / refcount / ptr）
3. `type` 与 `encoding` 分离：为什么 type 对外、encoding 对内
4. String 的三种编码：INT / EMBSTR / RAW 的分界
5. 共享对象：`shared.integers[10000]` 省了什么
6. `lru` 的双重身份：LRU 时钟 vs LFU 的 freq+access
7. refcount 与对象的生命周期
8. 编码升级与"只升不降"
9. 失败路径：EMBSTR 阈值、refcount 误用、检测编码时的分支
10. 收网：`redisObject` 是所有数据结构卷的编码开关
11. 下篇桥接：R-4 SDS

## 必须回填的源码锚点

- `src/server.h:70` `typedef struct redisObject robj;`
- `src/server.h:906` `struct redisObject` 结构体起始
- `src/server.h:907`-`:910` type/encoding/lru/refcount/ptr 字段
- `src/server.h:882`-`:896` encoding 枚举（RAW/INT/HT/.../LISTPACK_EX）
- `src/server.h:108` `OBJ_SHARED_INTEGERS 10000`
- `src/server.h:1332` `shared.integers` 声明
- `src/server.c:1991` 共享整数初始化循环
- `src/object.c:101` `OBJ_ENCODING_EMBSTR_SIZE_LIMIT 44`
- `src/object.c:102`-`:114` `createStringObject()` EMBSTR/RAW 分界
- `src/object.c:128` `createStringObjectFromLongLongWithOptions()` INT 编码候选

## 必须引用的测试/证据

- `tests/unit/type/string.tcl`
- `tests/unit/object.tcl`（如果存在则引用）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。