# Ch8-02 PoolChunk 的 run 管理与 handle 编码 — rewrite-plan

## 篇章定位

- 核心困惑：上一节已经知道请求会被 `PoolArena` 分流到 small/normal/huge，但一旦落到 normal/small 路径，Chunk 内部到底怎么知道“哪段 run 还空着”“怎么把一段 run 切出需要的 pages”“释放时怎么把连续空 run 合并回去”？
- 一句话顿悟：当前 Netty 的 `PoolChunk` 并不是旧资料里常见的“memoryMap[] 深度树”版本，而是用 `runsAvailMap + runsAvail 优先队列数组 + handle 位编码` 管理可用 run；small 再在此基础上把一个 run 交给 `PoolSubpage` 做页内位图切分。
- 篇章边界：聚焦 `PoolChunk` 的 run 管理、64 位 handle、`allocateRun/allocateSubpage/free/collapseRuns`；Subpage 位图与 ThreadCache 深挖留到下一篇。

## 依赖

### HARD

- Ch8-01：allocator/pageSize/chunkSize/sizeIdx/Arena 三路分流。
- Ch4 ByteBuf：PooledByteBuf 最终需要用 handle 初始化自己的偏移和长度。

### SOFT

- 位运算和优先队列基本概念：正文给最小解释。

### NAV

- Ch8-03：PoolSubpage 位图与 PoolThreadCache。
- Ch8-04：PooledByteBuf 生命周期和双归还。

## 素材事实卡片

### 卡片 A：当前 PoolChunk 不是旧版 memoryMap 实现

- `PoolChunk.java:29-137`：类注释明确描述的是 `runsAvailMap`、`runsAvail`、`allocateRun(size)`、`allocateSubpage(size)`、`free(handle)` 的算法，不再是 `memoryMap[]` 树深度表。
- `PoolChunk.java:161-168`：`runsAvailMap` + `runsAvail` + `runsAvailLock`。
- 必须显式纠正旧大纲里的 memoryMap/二叉树叙事，避免把过时版本当成当前实现事实。

### 卡片 B：handle 位编码

- `PoolChunk.java:76-87`：handle 位布局注释：runOffset / size(pages) / isUsed / isSubpage / bitmapIdx。
- `PoolChunk.java:147-150`：相关 shift 常量。
- `PoolChunk.java:600-606`（继续读取后补精确位置）：`toRunHandle`。
- `PoolSubpage.java:208-214`：subpage handle 在 run handle 基础上额外写入 `isSubpage` 和 `bitmapIdx`。
- 关键叙事：handle 不是对象，而是跨 Arena/Chunk/Subpage/Buf 的压缩定位票据。

### 卡片 C：可用 run 管理

- `PoolChunk.java:212-220`：初始化时把整个 chunk 作为一个完整可用 run 插入。
- `PoolChunk.java:253-287`：`insertAvailRun/removeAvailRun` 同时维护 `runsAvailMap`（按偏移查）和 `runsAvail`（按大小类/优先队列查）。
- `PoolChunk.java:293-295`：`getAvailRunByOffset`。
- `PoolChunk.java:426-437`：`runFirstBestFit(pageIdx)` 从对应页数等级往上找第一个非空优先队列。
- 关键叙事：当前实现不是按树深搜索，而是“按页数等级索引一组优先队列，再按最小 offset 取 run”。

### 卡片 D：allocateRun / splitLargeRun

- `PoolChunk.java:370-399`：`allocateRun(runSize)` -> pages -> pageIdx -> `runFirstBestFit` -> 取队列最小 offset handle -> `removeAvailRun0` -> `splitLargeRun` -> `freeBytes -= pinnedSize`。
- `PoolChunk.java:439-462`：`splitLargeRun` 如果剩余 pages > 0，就把尾部余量重新插回 avail 结构；返回前半段已用 run handle。
- 关键边界：这不是通用 Buddy 树“逐层一分为二”，而是对当前可用 run 做“前段分配、尾段回填”。

### 卡片 E：allocateSubpage

- `PoolChunk.java:401-423`：`calculateRunSize(sizeIdx)` 先找能整除 elemSize 的最小 runSize。
- `PoolChunk.java:473-490`：`allocateSubpage(sizeIdx, head)` 先 `allocateRun(runSize)`，再创建 `PoolSubpage`，存进 `subpages[runOffset]`，最后 `subpage.allocate()` 返回带 bitmapIdx 的 handle。
- 关键叙事：small 路径并不是“直接按 bit 分配”，而是先向 chunk 借一个 run，再在 run 内分 bit。

### 卡片 F：free 与 collapseRuns

- `PoolChunk.java:500-545`：如果 handle 是 subpage，先回到 `PoolSubpage.free`；subpage 真正空了才回退到 run free。之后 `collapseRuns(handle)`、清 used/subpage 位、重新插入 avail、增加 freeBytes。
- `PoolChunk.java:548-598`：`collapsePast/collapseNext` 通过相邻偏移在 `runsAvailMap` 中查找连续空 run 并合并。
- 关键叙事：当前实现的“合并”是按连续偏移查前后邻居，不是旧 memoryMap 树的兄弟节点回溯。

## 理解路径

1. **先明确版本边界**：当前源码不是旧 memoryMap 树，防止读者带错地图进来。
2. **先讲 handle**：为什么 Arena 不返回一个对象结果，而是一个压缩 long 票据。
3. **再讲可用 run 如何被记录**：offset 查找靠 map，按大小找候选靠优先队列数组。
4. **讲 normal 分配**：从 sizeIdx -> pageIdx -> best-fit queue -> splitLargeRun -> 前半给你、后半回填。
5. **讲 small 分配**：先借 run，再交给 Subpage 做位图切小块。
6. **讲 free 合并**：先释放子页或 run，再沿前后连续 run 合并，恢复大块可用性。
7. **收网**：Chunk 的核心不是“树”，而是“压缩 handle + 分级可用表 + 连续 run 合并”。

## 失败方案推演

- 每次 normal 分配都线性扫描整块 chunk：大块越多越慢，难以快速找到可用 run。
- 不把 offset 和 size 编进 handle，而是返回新对象：高频分配/free 额外制造 GC 压力。
- small 直接固定用一页，不先算最小可整除 run：小对象可能浪费页空间，或无法与 elemSize 对齐。
- free 时只标记当前 run 空闲，不尝试合并：chunk 很快碎成大量小 run，大块分配越来越困难。

## 文章结构与预算

1. 先纠正旧地图：当前实现不是 memoryMap 树（900-1200 字）
2. handle：跨层传递的定位票据（1800-2300 字）
3. runsAvailMap + runsAvail：可用 run 如何被记录（1800-2300 字）
4. allocateRun + splitLargeRun：normal 路径怎么切（1900-2400 字）
5. allocateSubpage：small 先借 run 再切位图（1500-1900 字）
6. free + collapseRuns：怎样把碎片重新并回去（1800-2300 字）
7. 误解澄清与 Ch8-03 桥接（900-1200 字）

目标：删掉代码后的叙述性正文 9500-11000 字。

## 证据清单

- `PoolChunk.java:29-137`
- `PoolChunk.java:147-168`
- `PoolChunk.java:212-220`
- `PoolChunk.java:253-295`
- `PoolChunk.java:370-462`
- `PoolChunk.java:401-423`
- `PoolChunk.java:473-545`
- `PoolChunk.java:548-598`
- `PoolSubpage.java:208-214`

## 边界清单

- 当前实现与旧 memoryMap/Buddy 教材版本不同，正文必须显式标注版本边界。
- “Buddy”一词如果使用，只能作为“连续块切分/合并”的高层比喻，不能写成当前源码真的维护 `memoryMap[]`。
- `collapseRuns` 的合并依据是连续偏移邻居，而不是树兄弟节点。
- 本篇不展开 Subpage 位图和 ThreadCache 命中细节。
- 如果在 run 合并或 handle 编码路径中发现真实缺陷候选，按方法论记录 issue 候选。

## 深审预警

- [ ] 必须纠正大纲里的旧 `memoryMap[]` 叙事。
- [ ] handle 位字段要与当前源码位布局严格对齐。
- [ ] 不把 `splitLargeRun` 写成“对半分裂”；当前实现是前段分配、尾段回填。
- [ ] `allocateSubpage` 要强调先向 chunk 借 run，再进入 subpage 位图。
- [ ] `collapseRuns` 不能写成树回溯兄弟合并。
