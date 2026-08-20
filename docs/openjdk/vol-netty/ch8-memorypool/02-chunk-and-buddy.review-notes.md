# Ch8-02 PoolChunk 的 run 管理与 handle 编码 — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| 当前 `PoolChunk` 类注释围绕 `runsAvailMap/runsAvail/allocateRun/allocateSubpage/free`，不是旧 `memoryMap[]` | `PoolChunk.java:29-137` | ✅ |
| handle 位布局与 shift 常量 | `PoolChunk.java:76-87`、`:147-150` | ✅ |
| `toRunHandle` 只写入 runOffset/runPages/inUsed | `PoolChunk.java:600-604` | ✅ |
| subpage handle 额外写入 `isSubpage` 和 `bitmapIdx` | `PoolSubpage.java:208-214` | ✅ |
| 初始化时整块 chunk 作为一个可用 run 插入 | `PoolChunk.java:198-220` | ✅ |
| `insertAvailRun/removeAvailRun` 同时维护 map 和 queue | `PoolChunk.java:253-287` | ✅ |
| `runFirstBestFit` + `allocateRun` 正常路径 | `PoolChunk.java:370-437` | ✅ |
| `splitLargeRun` 是前段分配、尾段回填 | `PoolChunk.java:439-462` | ✅ |
| `calculateRunSize` 为 subpage 先找合适 run 大小 | `PoolChunk.java:401-423` | ✅ |
| `allocateSubpage` 先 `allocateRun` 再创建 `PoolSubpage` | `PoolChunk.java:473-490` | ✅ |
| `free()` 先处理 subpage，再回到 run free | `PoolChunk.java:500-545` | ✅ |
| `collapseRuns = collapsePast + collapseNext` 按连续偏移邻居合并 | `PoolChunk.java:548-598` | ✅ |
| `initBuf/initBufWithSubpage` 用 handle 初始化 buf 的 offset/maxLength/elemSize | `PoolChunk.java:606-628` | ✅ |

### 深审发现

- **无高风险事实错误。** 旧大纲中的 `memoryMap[]`/树深叙事已被完全替换为当前源码事实。✅
- **边界已收紧：** “Buddy”只保留为高层比喻，正文没有再把连续 run 合并写成树兄弟回溯。✅

## 第二轮：因果审

- Arena 已决定 small/normal/huge -> Chunk 继续解决 chunk 内部空间管理：✅
- handle 把定位元数据压成 long -> 后续 init/free 不需要分配结果对象：✅
- `runsAvailMap` 管偏移邻居，`runsAvail` 管大小候选 -> 分配与合并各自高效：✅
- normal 路径先找可用 run，再把余量回填：✅
- small 路径先借 run，再切 subpage：✅
- free 不是简单标 free，而是先处理 subpage，再合并连续 run 恢复大块：✅

因果链完整，没有把 Arena/Chunk/Subpage 的职责混在一起。✅

## 第三轮：结构审

正文按“先纠正旧地图 -> handle -> avail 结构 -> normal 分配 -> small 分配 -> free 合并 -> 收网”推进，符合读者从误解到新模型重建的理解路径。✅

没有被 `PoolChunk` 大段注释牵回旧 memoryMap 叙事。✅

## 第四轮：读者审

删掉代码块后，主线仍能复述：

- 当前 Chunk 用的是 run 表而不是树表。
- handle 是跨层传递的定位票据。
- normal 路径从 sizeIdx -> 页数等级 -> 可用 run -> 前段分配尾段回填。
- small 路径先借 run，再进位图。
- free 时按连续偏移邻居并回去。

对“老资料读者”尤其友好，因为一开始先纠正地图。✅

## 第五轮：边界审

- 没把旧 `memoryMap[]` 当成当前实现。✅
- 没把 `splitLargeRun` 写成对半拆。✅
- 没把 small 路径写成直接位图分配。✅
- 没把 `collapseRuns` 写成树兄弟回溯。✅
- 没提前展开 PoolThreadCache 和 Subpage 位图细节。✅

## 第六轮：依赖审

- Ch8-01 的 allocator/arena/sizeIdx 前置已正确复用。✅
- Ch8-03/04 只作导航，没有提前透支位图与生命周期细节。✅
- 没引用未分析的旧 Netty 版本实现作为当前事实。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 391。
- 去码后字符数：约 7,700。
- 去码去空白后字符数：约 6,800。
- 对 PoolChunk 入口结构专题已形成闭环。✅

## 结论

Ch8-02 六轮 review 完成，无需修订。可进入 Ch8-03 PoolSubpage 与 ThreadCache。
