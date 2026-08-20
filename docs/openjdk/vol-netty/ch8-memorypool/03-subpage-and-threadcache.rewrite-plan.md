# Ch8-03 Subpage 与 ThreadCache — rewrite-plan

## 篇章定位

- 核心困惑：上一节已经知道 small 路径会“先借一段 run，再切 subpage”；那页内到底怎么找第一个空闲小块？而且 Arena 明明已经能分配，为什么还要再套一层 ThreadCache，难道不是多此一举？
- 一句话顿悟：Subpage 解决的是“一个 run 内如何用位图切成很多小元素”，ThreadCache 解决的是“别让每次小/中等分配都回到 Arena 抢锁”；两者一个压缩页内碎片，一个压缩跨线程竞争。
- 篇章边界：重点讲 `PoolSubpage.allocate/free` 位图分配、`PoolThreadCache` 的 small/normal caches、`MemoryRegionCache` 队列、trim 机制和 thread-local cache 的 arena 选择；ChunkList 详细策略和 PooledByteBuf 生命周期留前后篇。

## 依赖

### HARD

- Ch8-01：size class 与 Arena 三路分流。
- Ch8-02：`allocateSubpage` 先借 run，再在页内分小块；handle 带 `bitmapIdx`。
- Ch4 ByteBuf：PooledByteBuf 需要被重新初始化为具体偏移/容量。

### SOFT

- 线程本地缓存概念：正文会给最小解释。
- 位运算基础：帮助理解 bitmap 和 `bitmapIdx`。

### NAV

- Ch8-04：PooledByteBuf 生命周期、双归还、Recycler 与 derived buffer 顺序。
- 如果后续要写 AdaptivePooling/Cache policy，可从本篇 thread cache 继续展开。

## 素材事实卡片

### 卡片 A：PoolSubpage 位图分配

- `PoolSubpage.java:64-85`：构造时计算 `maxNumElems/numAvail/bitmapLength`，并加入 pool 链。
- `PoolSubpage.java:90-112`：`allocate()` -> `getNextAvail()` -> 置位 -> `numAvail--` -> 满则从 pool 链移除 -> 返回带 `bitmapIdx` 的 handle。
- `PoolSubpage.java:118-150`：`free(head, bitmapIdx)` 清位、`setNextAvail(bitmapIdx)`；从 0 可用变 1 可用时重新挂回 pool，全部空闲时根据 `prev==next` 和 `doNotDestroy` 决定是否允许 page 级回收。
- `PoolSubpage.java:153-167`：pool 双向链表 add/remove。
- `PoolSubpage.java:173-205`：`getNextAvail()/findNextAvail()` 扫描 bitmap 找第一个 0 bit；有 `nextAvail` 快路径。
- `PoolSubpage.java:208-214`：`toHandle(bitmapIdx)` 在 run handle 上写 `bitmapIdx`。
- 关键边界：当前实现不是用 `Long.numberOfTrailingZeros`，而是手写按 word/bit 扫描；正文需纠正大纲旧认知。

### 卡片 B：ThreadCache 总体结构

- `PoolThreadCache.java:49-58`：heap/direct arena + 四组 cache（smallSubPageHeap/direct、normalHeap/direct）+ `freeSweepAllocationThreshold`。
- `PoolThreadCache.java:68-103`：构造时根据 arena / cache size / maxCachedBufferCapacity 建各层 cache，增加 `arena.numThreadCaches`。
- `PoolThreadCache.java:105-135`：subpage caches 是固定数量数组，normal caches 根据 `nSubpages..nSizes` 和 `maxCachedBufferCapacity` 构造。
- `PoolThreadCache.java:143-187`：allocateSmall/allocateNormal -> `allocate(cache, buf, reqCapacity)`；free/add 回 arena 前先尝试加入 cache。
- `PooledByteBufAllocator.java:523-551`：threadLocal 初始值选择 least-used arena，是否对当前线程启用 cache 与 `useCacheForAllThreads` / FastThreadLocalThread / 是否在 executor 线程上有关。

### 卡片 C：MemoryRegionCache

- `PoolThreadCache.java:328-460`：`MemoryRegionCache` 抽象类：固定容量 MPSC 队列、`allocations` 计数、`add/allocate/free/trim`。
- `PoolThreadCache.java:334-338`：cache 大小先对齐到下一个 2 次幂，并使用 `PlatformDependent.newFixedMpscUnpaddedQueue(size)`。
- `PoolThreadCache.java:364-375`：命中时 `queue.poll()` -> `initBuf(...)` -> 回收 Entry -> `allocations++`。
- `PoolThreadCache.java:349-359`：add 失败(队列满)则立即回收 entry，返回 false，让上层继续回 Arena。
- `PoolThreadCache.java:401-408`：trim 按 `size - allocations` 释放“这轮没怎么被命中的缓存条目”。
- 关键叙事：trim 不是 per-entry LRU，而是按“这轮分配次数与队列容量差值”粗粒度释放。

### 卡片 D：trim 与启用条件

- `PoolThreadCache.java:163-167`：每次 allocate 后 `allocations++`，达到 `freeSweepAllocationThreshold` 就清零并 `trim()`。
- `PoolThreadCache.java:250-270`：trim 遍历四组 caches；每个 cache 自己 trim。
- `PooledByteBufAllocator.java:531-551`：并非所有线程默认启用 cache；普通线程若未开启 `useCacheForAllThreads` 且不是 FastThreadLocalThread / EventExecutor 线程，会创建 0-size cache。
- `PooledByteBufAllocator.java:541-547`、`:763-769`：按时间周期 trim 当前线程 cache 的入口。
- 关键边界：trim 触发不只是“每 8192 次全局分配”，而是每个 thread cache 自己按分配计数触发；另外还有按毫秒定期 trim 的可选任务。

## 理解路径

1. **从 small 请求切入**：Arena 已经把 512B 归到 small，可一页里有多个元素，谁负责页内找空位？
2. **先讲 PoolSubpage**：bitmap、`nextAvail` 快路径、满时摘链、重新空出时挂回池头。
3. **再讲为什么光有 Subpage 还不够**：如果每次 512B 分配都回到 Arena，就还要经过锁、ChunkList 查找和 handle 初始化路径。
4. **讲 ThreadCache**：按 heap/direct + small/normal 维度分层，先 thread-local 命中，失败再回 Arena。
5. **讲 MemoryRegionCache**：固定 MPSC 队列、Entry 回收、命中/失效/trim 语义。
6. **讲 trim**：不是精细 LRU，而是粗粒度清理“不够热”的 cache；并补充哪些线程默认启用缓存。
7. **收网**：Subpage 解决“页内怎么切”，ThreadCache 解决“常见分配怎么尽量不碰 Arena 锁”。

## 失败方案推演

- small 请求每次都占整页：小对象空间浪费过大。
- 每次 small 分配都从 bitmap 头扫完整个位图：命中热点场景下重复开销明显，所以 `nextAvail` 先兜一把。
- 没有 thread-local cache：所有高频 small/normal 分配都回 Arena 抢锁。
- ThreadCache 无限保留缓存：热点过去之后缓存长期占内存，需要 trim 回收。
- trim 做成 per-entry 精细 LRU：开销过大，不适合热路径。

## 文章结构与预算

1. small 请求为什么不能每次都占整页（1000-1300 字）
2. PoolSubpage：位图、`nextAvail`、pool 链（2200-2800 字）
3. ThreadCache：为什么先命中线程本地（1800-2300 字）
4. MemoryRegionCache：固定队列、命中与回退（1800-2300 字）
5. trim 与启用条件（1600-2100 字）
6. 误解澄清与 Ch8-04 桥接（900-1200 字）

目标：删掉代码后的叙述性正文 9500-11000 字。

## 证据清单

- `PoolSubpage.java:64-85`
- `PoolSubpage.java:90-150`
- `PoolSubpage.java:153-167`
- `PoolSubpage.java:173-214`
- `PoolThreadCache.java:49-103`
- `PoolThreadCache.java:105-187`
- `PoolThreadCache.java:250-460`
- `PooledByteBufAllocator.java:523-551`
- `PooledByteBufAllocator.java:763-769`

## 边界清单

- 当前 `PoolSubpage.getNextAvail()` 是手写扫描，不沿用旧资料里的 `Long.numberOfTrailingZeros` 叙事。
- ThreadCache 只缓存 small/normal，不缓存 huge。
- trim 是粗粒度、按 cache/队列级别的释放，不是精细 LRU。
- 是否启用 thread-local cache 取决于当前线程类型和配置，不是所有线程天然都有满配 cache。
- 本篇不展开 Recycler / PooledByteBuf 对象生命周期细节，留下一篇。

## 深审预警

- [ ] 纠正旧大纲里关于 `Long.numberOfTrailingZeros` 和 “每 8192 次全局分配 trim” 的旧说法。
- [ ] 不把 MPSC cache 队列写成无上限。
- [ ] 不把 `allocations` 计数误写成全局 allocator 计数；它是 cache 本地热度计数。
- [ ] `prev == next` 的特殊情况与 `doNotDestroy` 语义需要讲清，避免把 subpage 提前回收到 run。
- [ ] 如发现 trim 或 cache 启用条件中的真实边界缺陷，按方法论记录 issue 候选。
