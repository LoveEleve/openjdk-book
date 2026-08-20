# Ch8-03 Subpage 与 ThreadCache — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| `PoolSubpage` 构造时计算 `maxNumElems/numAvail/bitmapLength` 并挂入 pool | `PoolSubpage.java:64-85` | ✅ |
| `allocate()` 找空位、置位、满则摘链、返回带 `bitmapIdx` 的 handle | `PoolSubpage.java:90-112` | ✅ |
| `free()` 清位、回填 `nextAvail`、必要时重新挂回 pool 或允许 page 级回收 | `PoolSubpage.java:118-150` | ✅ |
| `addToPool/removeFromPool` 的双向链表语义 | `PoolSubpage.java:153-167` | ✅ |
| `getNextAvail` 当前实现是 `nextAvail` 快路径 + 手写扫描，不是 `Long.numberOfTrailingZeros` | `PoolSubpage.java:173-205` | ✅ |
| `toHandle(bitmapIdx)` 写入 subpage 位信息 | `PoolSubpage.java:208-214` | ✅ |
| `PoolThreadCache` 四组 cache 与 `freeSweepAllocationThreshold` | `PoolThreadCache.java:49-58` | ✅ |
| 构造时按 arena / cache size 创建 subpage/normal caches | `PoolThreadCache.java:68-103`、`:105-135` | ✅ |
| `allocateSmall/allocateNormal` 先走 thread cache | `PoolThreadCache.java:143-187` | ✅ |
| `MemoryRegionCache` 用固定容量队列并按 2 次幂对齐 size | `PoolThreadCache.java:328-338` | ✅ |
| `MemoryRegionCache.allocate/add/free/trim` 主逻辑 | `PoolThreadCache.java:349-422` | ✅ |
| trim 触发是本地 `allocations` 达阈值，不是全局计数 | `PoolThreadCache.java:163-167` | ✅ |
| `PooledByteBufAllocator` 只在满足线程条件时启用实缓存，否则构造 0-size cache | `PooledByteBufAllocator.java:523-551` | ✅ |
| 可选的定时 trim 与手动 `trimCurrentThreadCache()` 入口 | `PooledByteBufAllocator.java:541-547`、`:763-769` | ✅ |

### 深审发现

- **无高风险事实错误。** 旧大纲中关于 `Long.numberOfTrailingZeros` 和“全局 8192 次 trim”的说法都已按当前源码纠正。✅
- **边界已收紧：** `MemoryRegionCache` 被表述为当前实现使用的固定容量队列，不夸大成所有线程缓存的一般理论。✅

## 第二轮：因果审

- small 请求不能每次占整页 -> 需要页内位图切分：✅
- 位图切分解决空间浪费，但还没解决 Arena 锁竞争 -> 需要 thread-local cache：✅
- `nextAvail` 快路径避免每次都全图扫描 bitmap：✅
- ThreadCache 让高频 small/normal 分配先命中本地，miss 才回 Arena：✅
- cache 不能无限囤积 -> trim 用粗粒度热度差值回收：✅

因果链完整，没有把 Subpage 和 ThreadCache 混成同一层问题。✅

## 第三轮：结构审

正文按“small 请求为什么不够 -> PoolSubpage -> ThreadCache -> MemoryRegionCache -> trim -> 收网”推进，符合从页内切分到线程本地复用的理解路径。✅

没有被 `PoolThreadCache` 文件顺序牵着走，也没有把 ChunkList 重新拉回主线。✅

## 第四轮：读者审

删掉代码块后，主线仍可复述：

- Subpage 用位图管理 run 内小块。
- ThreadCache 让高频 small/normal 请求尽量不回 Arena 抢锁。
- `MemoryRegionCache` 负责缓存条目队列与 trim。
- trim 按“这一轮够不够热”粗粒度回收缓存。

对“只知道有线程本地缓存”的读者来说，已足够形成闭环。✅

## 第五轮：边界审

- 已明确当前 `getNextAvail` 是手写扫描，不沿用旧实现传说。✅
- 已明确 huge 不进 thread cache。✅
- 已明确 trim 不是 per-entry LRU。✅
- 已明确不是所有线程都有满配 cache。✅
- 未提前展开 Recycler / PooledByteBuf 对象生命周期。✅

## 第六轮：依赖审

- Ch8-01 allocator/arena/sizeIdx 与 Ch8-02 run/subpage handle 前置已正确复用。✅
- Ch8-04 仅作生命周期桥接，没有提前透支对象/内存双归还细节。✅
- 没有把旧版本 Subpage 实现当成当前事实。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 406。
- 去码后字符数：约 8,025。
- 去码去空白后字符数：约 7,098。
- 对 Subpage + ThreadCache 专题已形成闭环。✅

## 结论

Ch8-03 六轮 review 完成，无需修订。可进入 Ch8-04 PooledByteBuf 生命周期。
