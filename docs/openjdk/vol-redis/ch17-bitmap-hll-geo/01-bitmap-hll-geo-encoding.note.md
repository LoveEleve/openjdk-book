# vol-redis R-11/12/13 Bitmap/HLL/GEO — note

## 本篇主张

- Bitmap、HLL、GEO 都不是独立数据结构，而是**借用 Redis 现有结构做编码**：Bitmap 借 SDS、HLL 借字符串、GEO 借 ZSet。
- Bitmap 按位 O(1) 定位 + 查表法 BITCOUNT（`bitsinbyte[256]`）。
- HLL 用 16384 个 6 位寄存器（约 12KB），标准误差 0.81%，稠密/稀疏两套编码。
- GEO 用 52-bit geohash 作为 ZSet 的 score，9 宫格 + Haversine 公式算精确距离。

## 本篇边界

- 不展开 geohash 的完整 52 位编码算法。
- 不展开 HLL 稀疏编码的 opcode 细节。

## 下篇桥接

- R-8 持久化将展开 RDB 快照与 AOF 追加日志的完整实现。
