# vol-redis R-1 redisObject 类型系统 — review notes

## 事实审

- 已核对 `src/server.h:906`-`:910`（`struct redisObject` 定义）：type:4 / encoding:4 / lru:24 / refcount / ptr，正文成立。
- 已核对 `src/server.h:882`-`:896`（encoding 枚举）：13 种编码，3 个已废弃，正文成立。
- 已核对 `src/server.h:108`（`OBJ_SHARED_INTEGERS 10000`）、`:1332`（`shared.integers` 声明）、`src/server.c:1991`-`1998`（初始化循环），正文成立。
- 已核对 `src/object.c:101`（`OBJ_ENCODING_EMBSTR_SIZE_LIMIT 44`）、`:102`-`:114`（`createStringObject()` EMBSTR/RAW 分界）、`:128`（`createStringObjectFromLongLongWithOptions()` INT 编码候选），正文成立。
- 已核对 `src/object.c:607`-`:679`（`tryObjectEncodingEx()` 编码升级逻辑）：refcount > 1 跳过、INT 候选（长度 ≤ 20）、EMBSTR 候选（长度 ≤ 44）、RAW 保持，正文成立。

## 因果审

- `type` 与 `encoding` 分离的原因是接口与实现分离，正文成立。
- `INT` / `EMBSTR` / `RAW` 三种编码的分界是长度 + 内容类型，正文成立。
- 共享整数在 `maxmemory` 下被禁用，因为每个对象需要独立 LRU 字段，正文成立。
- 编码升级只升不降，因为降级需要额外扫描成本且很少发生，正文成立。

## 结构审

- 从"为什么一个 char * 不够"困惑开场，再落到结构体字段、type/encoding 分离、编码分界、共享对象、lru 双重身份、refcount、编码升级，主线集中。

## 读者审

- 读完应能回答：为什么 `type` 与 `encoding` 要分离。
- 读完应能回答：String 有三种编码，各自在什么条件下使用。
- 读完后能自然进入 R-4 SDS，理解 EMBSTR 和 RAW 的实际存储载体。

## 边界审

- 本篇没有展开 SDS 内部实现，没有展开 Dict/quicklist/skiplist 等具体数据结构。
- R-4~R-10 都未提前透支，边界成立。

## 依赖审

- 前置依赖：无（第一卷第一篇）。
- 后续桥接：R-4 SDS、R-3 Dict、R-5 List 等。

## 结论

R-1 已完成单域四件套的事实回填与六层审查，可进入 R-4 SDS。