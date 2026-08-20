# Ch8-01 池化入口与 Arena — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| 默认 pageSize / maxOrder / chunkSize | `PooledByteBufAllocator.java:68-91`、`:160-173` | ✅ |
| 默认 heap/direct arena 数量受 cpu*2 与内存约束共同影响 | `PooledByteBufAllocator.java:93-117` | ✅ |
| heap/direct arenas 各自构造 `SizeClasses` | `PooledByteBufAllocator.java:289-337` | ✅ |
| `SizeClasses` 管理 nSubpages/nSizes/nPSizes 和查表结构 | `SizeClasses.java:20-45`、`:117-185` | ✅ |
| `size2SizeIdx` 超过 chunkSize 直接返回 `nSizes` | `SizeClasses.java:316-343` | ✅ |
| `normalizeSize` 把请求归一到 size class | `SizeClasses.java:391-412` | ✅ |
| `PoolArena.SizeClass` 只有 `Small`/`Normal` | `PoolArena.java:38-41` | ✅ |
| `PoolArena` 持有 smallSubpagePools 和 6 段 chunk lists | `PoolArena.java:45-54`、`:80-112` | ✅ |
| Arena 按 sizeIdx 分 small/normal/huge 三路 | `PoolArena.java:129-148` | ✅ |
| small 路径：cache -> subpage -> normal fallback | `PoolArena.java:150-188` | ✅ |
| normal 路径：cache -> chunk lists -> new chunk | `PoolArena.java:191-223` | ✅ 已补“当前实现顺序”边界 |
| huge 路径：`newUnpooledChunk` | `PoolArena.java:229-235` | ✅ |
| `PoolChunk` 的 page/run/chunk/handle 总注释与初始整块 run | `PoolChunk.java:29-137`、`:198-220` | ✅ |
| `PoolSubpage` 位图与 pool 链表行为 | `PoolSubpage.java:64-150` | ✅ |

### 深审发现

1. **低风险：normal 路径的 chunkList 搜索顺序需要限定为当前实现。** 初稿容易让读者误会成池化的一般规律，已补充“这是当前实现顺序，不是抽象规范”。
2. **无高风险事实错误。** Huge 不被误写成 `SizeClass.Huge`，默认参数也未被写成固定真理。✅

## 第二轮：因果审

- 高频 ByteBuf 借还 -> allocator 选类型还不够 -> 需要进一步复用底层内存：✅
- 任意请求大小过于离散 -> 先归一到有限 size class 才能稳定复用：✅
- `sizeIdx` 进入 Arena -> Arena 再做 small/normal/huge 分流：✅
- small 走 subpage / normal 走 chunk list / huge 走 unpooled chunk：✅
- `PoolChunk`/`PoolSubpage` 是后续具体空间管理者，不是入口分流器：✅

因果链完整，没有把 Buddy 或 bitmap 抢成入口层主线。✅

## 第三轮：结构审

正文按“为什么 allocator 之后还要池化 -> allocator 默认参数 -> size class -> arena 分流 -> chunk/subpage 定位 -> 收网”推进，符合理解路径。✅

没有被 PoolChunk 复杂注释拉偏成实现细节翻译文。✅

## 第四轮：读者审

删掉代码块后，主线仍能复述：

- 池化的第一步不是分配算法，而是 size class 归一化。
- `PooledByteBufAllocator` 决定 arena 规模和默认参数。
- `PoolArena` 根据 sizeIdx 分流到 small/normal/huge。
- `PoolChunk`/`PoolSubpage` 负责各自路径里的具体空间管理。

对陌生读者而言，这篇已经形成“入口层闭环”。✅

## 第五轮：边界审

- `pageSize=8192`、`maxOrder=9`、`chunkSize=4MiB`、cpu*2 都已限定为默认值。✅
- Huge 已明确为 arena 正常 size class 之外的单独路径。✅
- 没提前展开 Buddy 分裂、位图和 ThreadCache 命中细节。✅
- normal 搜索顺序被限定为当前实现。✅
- 未将 allocator 默认值包装成性能结论。✅

## 第六轮：依赖审

- Ch4 ByteBuf（allocator、heap/direct、refCnt）和 Ch7 Pipeline（高频 write/read 场景）已正确复用。✅
- Ch8-02/03/04 只作导航，没有透支后文细节。✅
- 没引用未分析的 jemalloc/系统 allocator 细节作为既成事实。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 409。
- 去码后字符数：约 7,670。
- 去码去空白后字符数：约 6,810。
- 对池化入口专题篇已形成闭环。✅

## 结论

Ch8-01 六轮 review 完成，深审修正 1 处 normal 搜索顺序的边界表述。可进入 Ch8-02 PoolChunk 与 Buddy。
