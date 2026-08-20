# Ch8-07 池化分配器指标、ThreadCache 调优与诊断 — rewrite-plan

## 篇章定位

- 核心困惑：真正排查 Netty 池化内存问题时，到底该看哪些指标？`usedHeapMemory`、`usedDirectMemory`、`numThreadLocalCaches`、arena allocations/deallocations、activeBytes、chunkLists` 分别说明什么？为什么 ByteBuf 已经 release，指标和内存保留行为却不一定立刻下降？
- 一句话顿悟：池化 allocator 的指标不是“内存是否泄漏”的单一真相，而是一组分层信号：allocator 级指标回答池总体占用和线程缓存规模，arena 级指标回答 small/normal/huge 分配与活动量，chunk list 与 subpage 指标回答空间布局状态，thread cache 指标回答局部缓存是否仍然活着。只有把这些信号放回分配/回收路径里，才能区分池化保留、thread cache 未清、chunk 仍在利用率链中，以及真正的 ownership 泄漏。
- 文章边界：本篇主讲 `PooledByteBufAllocatorMetric`、`PoolArenaMetric`、`usedHeapMemory/usedDirectMemory`、`pinnedHeapMemory/pinnedDirectMemory`、`numThreadLocalCaches`、chunkLists、subpage metrics、`dumpStats()` 和相关测试如何帮助诊断；不做 JVM native memory 全景诊断，不把 allocator 指标外推成操作系统 RSS 的一一映射。

## 依赖

### HARD

- Ch8-05 `ch8-memorypool/05-pooled-allocator-overview.md`：理解 allocator、arena、size class、chunk list 的总图。
- Ch8-06 `ch8-memorypool/06-thread-cache-and-recycle-path.md`：理解 thread cache 如何影响释放后的可见路径。
- Ch4-06 `ch4-bytebuf/06-ownership-and-reference-counting.md`：理解 `release()` 结束的是对象 ownership，不等于底层 chunk 必然立即消失。
- Ch4-07 `ch4-bytebuf/07-leak-detector-and-tracking.md`：理解“池化保留”和“真正 leak”要分开判断。

### SOFT

- Ch5-03：只复用 FastThreadLocal/线程退出对 thread cache 生命周期的影响。

### NAV

- 后续：真实服务里的 direct memory 诊断与参数调优。
- 后续：JFR buffer event / native memory tracking 辅助诊断。

## 素材事实卡片

### 卡片 A：Allocator 级指标回答什么

- `PooledByteBufAllocatorMetric` 提供 `numHeapArenas`、`numDirectArenas`、`numThreadLocalCaches`、`smallCacheSize`、`normalCacheSize`、`chunkSize`、`usedHeapMemory`、`usedDirectMemory`。
- `PooledByteBufAllocator` 的 `usedMemory(...)` 聚合的是各 arena 的 `numActiveBytes()`。
- `pinnedHeapMemory/pinnedDirectMemory` 聚合的是各 arena 的 `numPinnedBytes()`。
- 结论：allocator 级指标是池的总览，不是每个对象的即时去留明细。

### 卡片 B：Arena 级指标回答什么

- `PoolArenaMetric` 提供 `numThreadCaches`、smallSubpages、chunkLists、各类 allocations/deallocations、active allocations、active bytes 等。
- `testArenaMetricsCache/NoCache` 表明 cache 启用与否会改变 alloc/dealloc 的统计可见性。
- 结论：arena 级统计需要结合 cache 路径理解，不能直接当作“真实分配次数”。

### 卡片 C：Chunk list / subpage 指标如何读

- `testPoolChunkListMetric` 验证 6 条利用率链的 min/max usage 语义。
- `testSmallSubpageMetric` 验证 small subpage 的 `maxNumElements - numAvailable` 能反映当前占用元素数。
- `testFreePoolChunk` 说明大对象落入高利用率链，释放后所有 chunk list 可能重新清空。

### 卡片 D：ThreadCache 指标如何读

- `numThreadLocalCaches()` 聚合的是各 arena 的 `numThreadCaches` 总数。
- `testNumThreadCachesWithNoDirectArenas`、`testNumThreadCachesAccountForDirectAndHeapArenas`、`testThreadCacheToArenaMappings` 说明 thread cache 数量和 arena 绑定关系、销毁时机。
- `testThreadCacheDestroyedByThreadCleaner/AfterExitRun` 说明 thread cache 销毁可能延迟到线程清理或 cleaner 路径，而非同步瞬时完成。

### 卡片 E：为什么“release 了但还占着”不能直接判定 leak

- `expectedUsedMemoryAfterRelease` 说明 qInit 中 chunk 在迁移前可能继续保留。
- thread cache 命中后会改变 arena metrics 和底层 chunk 的即时可见性。
- 结论：要先区分 ownership leak、池化保留、thread cache 未清、chunk 尚未降到可销毁条件。

## 理解路径

1. **从误诊场景开场**：ByteBuf 都 release 了，为什么 metric / dumpStats / 进程内存还没掉？
2. **先分层**：allocator 级、arena 级、chunk list/subpage 级、thread cache 级，各自回答什么。
3. **再解释“为什么指标不是即时真相”**：cache、chunk list、qInit 保留、线程退出延迟都会影响可见性。
4. **用测试建立诊断规则**：cache on/off、thread cache 数量变化、subpage metric、chunk list metric、free chunk 行为。
5. **最后给诊断顺序**：先看 ownership，再看 thread cache，再看 arena/chunk list，最后才谈 OS 层内存。

## 失败方案推演

- 只看 `usedDirectMemory` 就判断 leak：它只是一层聚合结果。
- 只看 `release()` 返回 true 就以为底层内存已回到 OS：忽略了 cache 和 chunk 保留。
- 只看 arena allocations/deallocations 差值：cache 命中会改变统计语义。
- 只看 `numThreadLocalCaches()==0` 就断言池完全空：arena/chunk 仍可能保留可复用空间。
- 把 allocator 指标直接等同于 RSS / NMT：层级完全不同。

## 文章结构与预算

1. 开场：为什么 release 了，指标却不一定立刻降（1000-1300 字）
2. Allocator 级指标：池总览能告诉你什么（1400-1800 字）
3. Arena / chunk list / subpage 指标：空间布局如何被观察（1800-2300 字）
4. ThreadCache 指标：线程本地缓存为什么延迟可见（1600-2200 字）
5. 测试证据：cache on/off、destroy、mapping、free chunk（1800-2300 字）
6. 诊断顺序：怎样区分池化保留与真正 leak（1000-1400 字）
7. 收网：指标的边界与后续系统级诊断（600-900 字）

目标：去掉代码块后的叙述性正文 8500-11000 字，最低不低于 8000 字。

## 证据清单

- `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocatorMetric.java:22-123`
- `buffer/src/main/java/io/netty/buffer/PoolArenaMetric.java:22-176`
- `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:632-800`
- `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:147-215`
- `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:249-309`
- `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:353-486`
- `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:692-705`

## 边界清单

- 本篇不把 allocator metrics 直接当作操作系统 RSS 或 JVM native memory 曲线。
- 本篇不把池化保留写成 leak，也不把所有保留都写成正常；必须结合 ownership 和路径判断。
- 本篇不做完整参数调优指南，只建立诊断心智图。
- 本篇不重新展开 allocator/thread cache 内部实现，只消费前文结论。

## 深审预警

- [ ] 不把 `usedHeapMemory/usedDirectMemory` 写成真实物理占用的唯一真相。
- [ ] 不把 thread cache 销毁写成立刻同步完成。
- [ ] 不把 arena allocation/deallocation 计数写成“真实请求次数”的简单镜像。
- [ ] 不把 qInit/chunk 保留直接判成 leak。