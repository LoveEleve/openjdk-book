# 篇：01 SDS 字符串：为什么 Redis 不直接用 C 字符串

- 域：`R-4 SDS 字符串`
- 卷：`vol-redis`
- 目标：回答 Redis 为什么不用 C 字符串，而自建 SDS（Simple Dynamic String），以及 5 种 header 如何做内存分级。

## 前置依赖

- HARD：已读 `R-1 redisObject`，知道 `encoding=RAW/EMBSTR` 时 `ptr` 指向的是 SDS。

## 读者问题

C 的 `char *` + `strlen` + `strcat` 已经用了五十年，Redis 为什么还要自己造一个字符串结构？以及：

1. SDS 为什么能 O(1) 拿到长度，C 字符串为什么只能 O(n)？
2. 5 种 header（sdshdr5/8/16/32/64）各管多长的字符串？
3. `sdshdr5` 为什么不用于追加？为什么追加时自动升级到 `sdshdr8`？
4. 预分配策略"<1MB 翻倍、≥1MB +1MB"解决了什么？
5. `__packed__` 属性为什么重要？

## 主结论

SDS 不是"更聪明的 char *"，而是 **带长度的动态字符串头 + 连续内存缓冲区**。关键设计：

1. `sds` 本身就是 `char *`，指向 `buf[]`，但 `buf` 前面紧跟一个 header 结构体（`sdshdrN`）记录 `len`/`alloc`/`flags`。
2. `__packed__` 让 header 不补齐对齐字节，`sdsHdrSize(type)` 能精确算出 header 长度，`SDS_HDR(s)` 用类型名拼接从 `s` 反推 header 指针。
3. 5 种 header 覆盖不同长度区间：sdshdr5(<32)、sdshdr8(<256)、sdshdr16(<64K)、sdshdr32(<4G)、sdshdr64(>=4G)，小字符串省 header 空间。
4. `_sdsMakeRoomFor()` 做预分配：`newlen < 1MB` 翻倍，`>=1MB` 则 `+= 1MB`，避免每次追加都 realloc。
5. `sdscatlen()` 是二进制安全的，`memcpy` 长度显式传入，不以 `\0` 为终点。

`src/sds.c:233`-`236`：

```c
if (greedy == 1) {
    if (newlen < SDS_MAX_PREALLOC)   /* SDS_MAX_PREALLOC = 1MB */
        newlen *= 2;
    else
        newlen += SDS_MAX_PREALLOC;
}
```

## 结构设计

1. 困惑开场：为什么 `char *` 不够
2. `sds = char *` 但 header 紧跟在 buf 前的布局
3. 5 种 `sdshdrN` 与 `sdsReqType()` 的分级策略
4. `__packed__` 与 `SDS_HDR(s)` 宏的反推机制
5. `sdshdr5` 的陷阱：不记录空余空间，追加即升级
6. 预分配：`_sdsMakeRoomFor()` 的翻倍与 +1MB 策略
7. 二进制安全：`sdscatlen()` 显式长度
8. 扩容时的 header 升级：同 type realloc / 异 type 搬家
9. 失败路径：OOM、size_t 溢出、header 尺寸漂移
10. 收网与下篇桥接 R-3 Dict

## 必须回填的源码锚点

- `src/sds.h:20` `typedef char *sds;`
- `src/sds.h:24`-`:47` sdshdr5/8/16/32/64 结构体
- `src/sds.h:53`-`:57` SDS_TYPE_5/8/16/32/64
- `src/sds.h:60`-`:61` `SDS_HDR_VAR`/`SDS_HDR` 宏
- `src/sds.h:13` `SDS_MAX_PREALLOC (1024*1024)`
- `src/sds.c:81` `_sdsnewlen()`（创建入口，类型选择）
- `src/sds.c:217`-`:260` `_sdsMakeRoomFor()`（预分配核心）
- `src/sds.c:272` `sdsMakeRoomFor()`（greedy=1 入口）
- `src/sds.c:463`-`:469` `sdscatlen()`（批量追加）
- `src/sds.c:172` `sdsfree()`（释放）
- `src/sds.c` `sdsReqType()`（类型选择，14 行 inline）
- `src/object.c:76` `createEmbeddedStringObject()`（EMBSTR 用 sdshdr8）

## 必须引用的测试/证据

- `tests/unit/string.tcl`（字符串基础测试）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
