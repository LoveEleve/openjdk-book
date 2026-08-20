# Ch8-07 池化分配器指标、ThreadCache 调优与诊断 — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `PooledByteBufAllocatorMetric` 当前提供 allocator 级总览指标：arena 数量、threadLocalCaches、cacheSize、chunkSize、usedHeapMemory、usedDirectMemory，证据：`buffer/src/main/java/io/netty/buffer/PooledByteBufAllocatorMetric.java:22`。  
2. `usedHeapMemory/usedDirectMemory` 当前通过聚合各 arena 的 `numActiveBytes()` 计算，证据：`buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:695`、`:703`。  
3. `pinnedHeapMemory/pinnedDirectMemory` 当前通过聚合各 arena 的 `numPinnedBytes()` 计算，证据：`buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:717`、`:737`。  
4. `numThreadLocalCaches()` 当前通过聚合各 arena 的 `numThreadCaches` 计算，证据：`buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:632`。  
5. `PoolArenaMetric` 当前暴露 `numThreadCaches`、smallSubpages、chunkLists、alloc/dealloc、active allocations/bytes 等分层指标，证据：`buffer/src/main/java/io/netty/buffer/PoolArenaMetric.java:22`。  
6. `testArenaMetricsNoCache / Cache` 当前证明 cache 开启与否会改变 arena alloc/dealloc 统计可见性，证据：`buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:147`。  
7. `testPoolChunkListMetric` 当前验证 6 条 chunk list 的 min/max usage 区间，证据：`buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:195`。  
8. `testSmallSubpageMetric` 当前证明 smallSubpage metric 可以反映当前元素占用，证据：`buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:217`。  
9. `testFreePoolChunk` 当前证明大块分配释放后，所有 chunk list 可能重新清空，证据：`buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:249`。  
10. `testThreadCacheDestroyedByThreadCleaner/AfterExitRun` 当前证明 thread cache 销毁最终完成，但不是线程结束瞬间同步完成，证据：`buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:353`。  
11. `testNumThreadCachesWithNoDirectArenas / AccountForDirectAndHeapArenas / ToArenaMappings` 当前证明 thread cache 数量和 arena 绑定关系会随创建/销毁变化，证据：`buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:419`。  
12. `dumpStats()` 当前输出 heap/direct arenas 的文本状态，但文档明确它可能昂贵，不适合高频调用，证据：`buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:772`。

### 深审发现

1. **高风险：容易把 allocator 级指标直接当作 OS/RSS 真相。** 正文已明确它们只是 allocator 分层信号。  
2. **中风险：容易把 `numAllocations - numDeallocations` 直接当作真实业务未释放数量。** 正文已补 cache 命中会改变统计可见性。  
3. **中风险：容易把 `numThreadLocalCaches()==0` 理解成池完全空。** 正文已明确 cache 层和 arena/chunk 层要分开看。  
4. **中风险：容易把 thread cache 销毁写成立刻同步完成。** 正文已用测试限定为最终销毁。  
5. **低风险：容易把 qInit/chunk 保留直接判成 leak。** 正文已把它放回具体分配/回收路径解释。

## 第二轮：因果审

- ownership 结束 != allocator 指标或系统内存立刻清零：✅  
- allocator 级指标回答池总体状态，不回答每个对象即时去留：✅  
- arena 级指标回答 small/normal/huge 哪条路径在说话：✅  
- chunk list / subpage 指标回答空间以什么布局仍留在池里：✅  
- thread cache 生命周期和销毁延迟会直接影响指标可见性：✅  
- 因此诊断必须先分层，再判断 leak / 保留 / 延迟销毁：✅

## 第三轮：结构审

正文结构按“误诊场景 -> allocator 级 -> arena 级 -> chunk/subpage 级 -> thread cache 级 -> 销毁时机 -> free chunk 测试 -> 诊断顺序 -> 收网”推进，没有按接口列表平铺。✅

失败方案已覆盖：
- 只看 `usedDirectMemory` 就判断 leak  
- 只看 `release()` 返回 true 就以为底层已回 OS  
- 只看 arena alloc/dealloc 差值  
- 只看 `numThreadLocalCaches()==0`  
- 把 allocator 指标直接等同 RSS/NMT  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- allocator、arena、chunk/subpage、thread cache 四层指标分别在说什么  
- 为什么 release 后指标不一定立刻下降  
- cache on/off 会如何影响 arena 统计可见性  
- thread cache 销毁为什么可能延迟  
- 真正诊断时应该按什么顺序排查  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把 allocator metrics 直接当作操作系统内存曲线。✅  
- 未把池化保留统统写成 leak，也未把所有保留都写成正常。✅  
- 未把 thread cache 销毁写成立刻同步完成。✅  
- 未把参数调优写成固定处方，只建立了诊断心智图。✅

## 第六轮：依赖审

- 依赖 Ch8-05 池化总图，真实存在。✅  
- 依赖 Ch8-06 thread cache 前置，真实存在。✅  
- 依赖 Ch4-06/07 ownership 与 leak detection 前置，真实存在。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 10,004。  
- 去掉常见 markdown 标记后的字符数：约 9,747。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经建立 allocator metrics 的分层诊断心智图：ownership、thread cache、arena/chunk 与系统层内存必须分层观察。Ch8-07 可作为后续参数调优、系统级内存诊断和真实案例排障篇的直接前置篇。