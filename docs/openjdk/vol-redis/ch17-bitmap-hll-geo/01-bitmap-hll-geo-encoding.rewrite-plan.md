# 篇：01 Bitmap / HyperLogLog / GEO：位与概率与空间编码

- 域：`R-11 Bitmap / R-12 HyperLogLog / R-13 GEO`
- 卷：`vol-redis`
- 目标：回答三个"基于现有结构的算法编码"域——Bitmap 的位操作、HLL 的基数估算、GEO 的地理编码。

## 前置依赖

- HARD：已读 `R-1 redisObject`（String 编码）、`R-6 ZSet`（GEO 用 ZSet 存储）。

## 读者问题

1. Bitmap 为什么能做到 SETBIT/GETBIT 都是 O(1)？
2. BITCOUNT 用查表法是怎么优化的？
3. HyperLogLog 的 16384 个寄存器怎么做到 12KB 固定内存？
4. HLL 的稀疏/稠密编码怎么切换？
5. GEO 为什么用 52-bit geohash 作为 ZSet 的 socre？geohash 怎么编码经纬度？

## 主结论

三个扩展编码的共同点是**把 Redis 的现有数据结构当"内存/寄存器/位图"用**：
- Bitmap 在 SDS 字符串上做位操作
- HLL 在字符串上做基数估算
- GEO 在 ZSet 上做地理编码

## 结构设计

1. 困惑开场：为什么都是"借壳"编码
2. Bitmap：SDS 字符串上的位操作
3. HyperLogLog：16384 寄存器 + 稠密/稀疏编码
4. GEO：52-bit geohash 作为 ZSet 的 score
5. 收网与下篇桥接 R-8 持久化

## 必须回填的源码锚点

- `src/bitops.c:511` `setbitCommand()`
- `src/bitops.c:558` `getbitCommand()`
- `src/bitops.c:775` `bitcountCommand()`
- `src/bitops.c:23` `bitsinbyte[256]` 查表
- `src/hyperloglog.c:1171` `pfaddCommand()`
- `src/hyperloglog.c:1211` `pfcountCommand()`
- `src/hyperloglog.c:176` `HLL_REGISTERS 16384`
- `src/hyperloglog.c:180` `HLL_HDR_SIZE`
- `src/hyperloglog.c:1432` `relerr 1.04/sqrt(16384)`
- `src/geo.c:445` `geoaddCommand()`
- `src/geo.c:866` `geosearchCommand()`
- `src/geohash_helper.c:213` `geohashAlign52Bits()`
- `src/geo.c:365` `membersOfAllNeighbors()`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
