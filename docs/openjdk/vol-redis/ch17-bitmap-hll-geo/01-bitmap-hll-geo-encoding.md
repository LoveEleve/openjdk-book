# Bitmap / HyperLogLog / GEO：把内存当数组/寄存器/位图用

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第十七篇，回答 Bitmap、HyperLogLog 和 GEO 三个"借壳编码"域的设计。

## 为什么"Bitmap 就是位数组"这个理解会把扩展编码读浅

很多人第一次用 Redis 的 Bitmap / HLL / GEO，觉得它们是独立的数据结构。

但这三个域的共同点是：**它们都不是独立的数据结构，而是借用了 Redis 现有结构（String / ZSet）做编码**。Bitmap 在 SDS 上做位操作，HLL 在字符串上做基数估算，GEO 在 ZSet 上做地理编码。

## 一、Bitmap：SDS 字符串上的位操作

关键命令在 `src/bitops.c`：

- `setbitCommand`（`:511`）：`SETBIT key offset value`，定位到 `offset / 8` 字节，修改 `offset % 8` 位
- `getbitCommand`（`:558`）：`GETBIT key offset`，读取对应位
- `bitcountCommand`（`:775`）：`BITCOUNT key`，统计 1 的位数
- `bitopCommand`（`:586`）：`BITOP AND/OR/XOR/NOT`，多 key 按位运算

`bitcountCommand` 使用查表法优化（`src/bitops.c:23` `bitsinbyte[256]` 预计算了 0-255 每个值的 1 位个数）：

```c
static const unsigned char bitsinbyte[256] = {0,1,1,2,1,2,2,3,...};
// 遍历字符串的每个字节，bits += bitsinbyte[*p++];
```

Bitmap 的 SDS 字符串在 `SETBIT` 时如果 `offset` 超过当前字符串长度，自动扩容（`sdsgrowzero`），所以 Bitmap 是 O(1) 定位 + O(1) 位操作。

## 二、HyperLogLog：概率基数估算

HyperLogLog 用 **16384 个寄存器**（`HLL_REGISTERS`，`src/hyperloglog.c:176`），每个寄存器 6 位，总内存固定约 12KB。标准误差约 0.81%（`src/hyperloglog.c:1432` `1.04/sqrt(16384)`）。

### 两种编码

- **稠密编码**（`HLL_DENSE`）：16384 个 6 位寄存器连续存储，每个寄存器 6 位，`HLL_DENSE_SIZE = header + 16384*6/8` 字节
- **稀疏编码**（`HLL_SPARSE`）：用 ZERO/XZERO/VAL 三种 opcode 表示大量未使用寄存器，小基数时更省内存

`PFADD`（`src/hyperloglog.c:1171`）计算元素哈希，确定寄存器索引（`HLL_P` 的前 14 位）和前导零计数（剩余位），更新寄存器。`PFCOUNT`（`:1211`）从 16384 个寄存器中估算基数。`PFMERGE`（`:1307`）合并多个 HLL 的寄存器值。

## 三、GEO：52-bit geohash 作为 ZSet 的 score

GEO 不是独立数据结构——它在 ZSet 上做地理编码。`GEOADD`（`src/geo.c:445`）把经纬度编码成 52-bit geohash 作为 ZSet 的 score，member 存储位置名。

`geohashEncode` 把经纬度按 geohash 算法编码，`geohashAlign52Bits`（`src/geohash_helper.c:213`）对齐到 52 位作为 double 类型的 score 存入 ZSet。

`GEORADIUS` / `GEOSEARCH`（`src/geo.c:866`）用 `geohashGetAreasByRadiusWGS84` 计算目标区域的 9 宫格 geohash，`membersOfAllNeighbors`（`src/geo.c:365`）遍历邻居网格，对每个命中的 member 用 Haversine 公式计算精确距离。

## 四、收网

三个扩展编码的共同设计模式：

1. **Bitmap**：借 SDS 字符串，按位操作，查表法 BITCOUNT
2. **HLL**：借字符串，16384 个 6 位寄存器，稠密/稀疏两套编码
3. **GEO**：借 ZSet，52-bit geohash 作为 score，9 宫格 + Haversine 距离

## 下篇桥接

R-8 持久化将展开 RDB 快照与 AOF 追加日志的完整实现。
