# vol-redis R-11/12/13 Bitmap/HLL/GEO — review notes

## 事实审

- 已核对 `src/bitops.c:511`（`setbitCommand()`）、`:558`（`getbitCommand()`）、`:775`（`bitcountCommand()`）、`:586`（`bitopCommand()`），正文成立。
- 已核对 `src/bitops.c:23`（`bitsinbyte[256]` 查表），正文成立。
- 已核对 `src/hyperloglog.c:1171`（`pfaddCommand()`）、`:1211`（`pfcountCommand()`）、`:1307`（`pfmergeCommand()`），正文成立。
- 已核对 `src/hyperloglog.c:176`（`HLL_REGISTERS 16384`）、`:180`（`HLL_HDR_SIZE`）、`:1432`（`relerr 1.04/sqrt(16384)`），正文成立。
- 已核对 `src/geo.c:445`（`geoaddCommand()`）、`:866`（`geosearchCommand()`）、`:365`（`membersOfAllNeighbors()`），正文成立。
- 已核对 `src/geohash_helper.c:213`（`geohashAlign52Bits()`），正文成立。

## 因果审

- Bitmap 借 SDS 字符串按位操作，O(1) 定位 + 查表法 BITCOUNT，正文成立。
- HLL 借字符串用 16384 个 6 位寄存器估算基数，稠密/稀疏两套编码切换，正文成立。
- GEO 借 ZSet 用 52-bit geohash 作为 score，9 宫格 + Haversine 距离，正文成立。

## 结构审

- 从"为什么都是借壳编码"困惑开场，再落到 Bitmap/HLL/GEO 三个子域，主线集中。

## 读者审

- 读完应能回答：三个域的公共设计模式是什么。
- 读完应能回答：BITCOUNT 的查表法怎么优化。
- 读完应能回答：GEO 为什么用 ZSet 存储。
- 读完后能自然进入 R-8 持久化。

## 边界审

- 本篇没有展开 geohash 完整编码算法。
- R-8 持久化未提前透支，边界成立。

## 依赖审

- 前置依赖：R-1 redisObject（HARD）、R-6 ZSet（SOFT）。
- 后续桥接：R-8 持久化 RDB+AOF。

## 结论

R-11/12/13 已完成四件套的事实回填与六层审查，可进入 R-8 持久化。
