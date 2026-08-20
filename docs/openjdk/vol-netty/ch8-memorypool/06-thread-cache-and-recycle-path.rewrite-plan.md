# Ch8-06 PoolThreadCache：线程本地缓存与回收路径 — rewrite-plan

## 篇章定位

- 核心困惑：前一篇已经知道 allocator 会先经过 thread cache，但 `PoolThreadCache` 到底缓存了什么？为什么 small 和 normal 都有自己的 cache 数组？什么时候命中 cache，什么时候回落到 arena？为什么它还要有 `freeSweepAllocationThreshold`、`trim()`、`freeOnFinalize` 和 `NOOP_HANDLE` 这种清理边界？
- 一句话顿悟：`PoolThreadCache` 不是另一套独立内存池，而是 arena 之前和 arena 之后都要经过的一层线程本地回收面：分配时优先按 size class 从本地 cache 拿 handle，释放时优先把 chunk/handle 放回本地队列；一旦线程不再可控、cache 长时间不命中或线程退出，就通过 trim、free 和 finalizer 把缓存还回 arena。
- 文章边界：本篇主讲 `PoolThreadCache`、`MemoryRegionCache`、small/normal caches、trim 触发、thread exit/freeOnFinalize、cache 命中与回退路径，以及它如何与 arena/PoolChunk 协作；不重复讲 FastThreadLocal/Recycler 内部实现，不重新展开 allocator 总图和 chunk/subpage 基本结构。

## 依赖

### HARD

- Ch8-05 `ch8-memorypool/05-pooled-allocator-overview.md`：理解 allocator -> arena -> thread cache -> size class -> subpage/run 的总图。
- Ch5-03 `ch5-eventloop/03-fastthreadlocal-and-recycler.md`：理解线程本地缓存、统一清理和受控复用的总体思想。
- Ch4-06 `ch4-bytebuf/06-ownership-and-reference-counting.md`：理解 release 后进入 cache 不等于生命周期未结束，而是底层空间回收路径变化。

### SOFT

- Ch4-07：只借 leak-aware/touch 的背景，不做展开。
- Ch8 前文：只复用 allocator/chunk/subpage 基础，不重复主线。

### NAV

- 后续：池化参数调优与 arena metrics。
- 后续：write task / outbound entry 等对象复用使用方专题。

## 素材事实卡片

### 卡片 A：PoolThreadCache 持有哪几类缓存

- `smallSubPageHeapCaches` / `smallSubPageDirectCaches`
- `normalHeapCaches` / `normalDirectCaches`
- 没有 huge cache。
- 结论：thread cache 只服务 small/normal，huge 不进 cache。

### 卡片 B：构造时机和 arena 计数

- 构造器按 heap/direct arena 分别创建 small/normal cache 数组。
- 创建成功后会递增对应 arena 的 `numThreadCaches`。
- 若根本没有任何 cache in use，却设置了非法的 `freeSweepAllocationThreshold`，会直接报错。

### 卡片 C：分配命中与 trim 机制

- `allocateSmall/allocateNormal` 都委托到 `allocate(cache, ...)`。
- allocate 成功/失败后都累计 `allocations`；达到 `freeSweepAllocationThreshold` 就触发 `trim()`。
- 结论：trim 不是按时间发生，而是按“发生了多少次分配尝试”发生。

### 卡片 D：释放进入 cache 的条件

- `add(...)` 会根据 arena、sizeIdx、SizeClass 找到对应 `MemoryRegionCache`。
- 若 cache 不存在或 `freed` 已置位，直接返回 false，回退给 arena 正常 free。
- 命中 cache 时只是把 `(chunk, nioBuffer, handle, normCapacity)` 封装成 entry 放进固定 MPSC 队列。

### 卡片 E：MemoryRegionCache 并不是再切一块内存，而是缓存 handle

- queue 存的是 `Entry(chunk, nioBuffer, handle, normCapacity)`，不是 ByteBuf 本体。
- allocate 时从队列 poll 一个 entry，再通过 `chunk.initBuf(...)` 或 `chunk.initBufWithSubpage(...)` 重建 `PooledByteBuf`。
- 结论：thread cache 复用的是“已经分配好的底层区域描述”，不是复用 Java ByteBuf 对象外壳。

### 卡片 F：trim、free、finalizer 的边界

- `trim()` 根据“缓存容量 - 实际 allocations”决定要释放多少 entry。
- `free(boolean finalizer)` 只允许执行一次，并会递减 arena 的 `numThreadCaches`。
- `FreeOnFinalize.finalize()` 兜底调用 `cache.free(true)`。
- 测试说明 `FastThreadLocalThread` 是否 `willCleanupFastThreadLocals()` 会影响 thread cache 销毁路径。

### 卡片 G：测试暴露的重要语义

- `testThreadCacheDestroyedByThreadCleaner` / `testThreadCacheDestroyedAfterExitRun`：线程结束后 cache 最终会被销毁。
- `testNumThreadCachesWithNoDirectArenas`：`numThreadLocalCaches()` 跟 thread cache 生命周期一致变化。
- `testArenaMetricsCache/NoCache`：cache 是否启用会影响 arena 统计可见性。

## 理解路径

1. **从误解开场**：thread cache 不是独立内存池，也不是把 ByteBuf 对象整个缓存下来。
2. **先画四组缓存图**：heap/direct × small/normal。
3. **解释 entry 里到底放什么**：不是数据副本，而是 chunk/handle 描述。
4. **走一遍命中与回退路径**：分配先命中 cache，未命中回 arena；释放先尝试进 cache，不行再回 arena。
5. **再讲 trim 和线程退出**：为什么 cache 不能无限保留，如何通过分配阈值、线程退出和 finalizer 兜底回收。
6. **最后用测试解释指标和生命周期**：为什么 thread cache 数量、arena metrics 和 chunk 保留行为会变化。

## 失败方案推演

- 每次释放都直接回 arena：会放弃线程本地重用机会。
- 缓存整个 ByteBuf 外壳：对象生命周期和底层空间描述会缠在一起，复用边界更混乱。
- huge 也强行进 thread cache：缓存占用和生命周期都会失控。
- cache 不做 trim / free：线程本地缓存会无限堆积。
- 线程退出不清 cache：arena 的 numThreadCaches、handle 和底层空间都会残留。

## 文章结构与预算

1. 开场：thread cache 不是第二个池（900-1200 字）
2. 四组缓存图：heap/direct × small/normal（1400-1800 字）
3. entry 语义：缓存的是 handle，不是 ByteBuf 外壳（1600-2100 字）
4. 分配命中与释放回退（1800-2400 字）
5. trim、free、线程退出和 finalizer（1800-2400 字）
6. 测试与指标：numThreadCaches、metrics、销毁路径（1400-1800 字）
7. 收网：thread cache 在池化总图中的位置（600-900 字）

目标：去掉代码块后的叙述性正文 8500-11000 字，最低不低于 8000 字。

## 证据清单

- `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:37-103`
- `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:105-187`
- `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:201-270`
- `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:273-499`
- `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:147-178`
- `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:353-437`

## 边界清单

- 本篇不重新展开 FastThreadLocal/Recycler 的内部队列与清理实现，只复用其结论。
- 本篇不把 thread cache 命中写成必然更优，只说明当前源码的分层设计和回收路径。
- 本篇不把 finalizer 写成首选清理机制；它是兜底路径。
- 本篇不把 arena metrics 直接当成操作系统内存曲线。

## 深审预警

- [ ] 不把 PoolThreadCache 写成独立内存池。
- [ ] 不把 cache entry 写成缓存 ByteBuf Java 对象本体。
- [ ] 不把 huge 分配写进 thread cache。
- [ ] 不把 trim/free/finalizer 混成同一触发条件。
- [ ] 不把线程退出后的 cache 销毁写成同步立即完成。