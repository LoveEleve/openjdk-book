# Ch8-06 PoolThreadCache：线程本地缓存与回收路径 — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `PoolThreadCache` 当前维护 `smallSubPageHeapCaches`、`smallSubPageDirectCaches`、`normalHeapCaches`、`normalDirectCaches` 四组缓存，没有 huge cache，证据：`buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:52`。  
2. 构造器当前在 heap/direct arena 存在时分别创建 cache 数组，并递增对应 `numThreadCaches`，证据：`buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:68`。  
3. `allocateSmall/allocateNormal` 当前统一走 `allocate(cache, ...)` 辅助逻辑，证据：`buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:143`。  
4. `allocate(...)` 当前在每次分配尝试后累计 `allocations`，达到 `freeSweepAllocationThreshold` 时触发 `trim()`，证据：`buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:157`。  
5. `add(...)` 当前根据 arena、sizeIdx、SizeClass 找到对应 cache；若 cache 不存在或已 `freed`，直接返回 false，证据：`buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:175`。  
6. `MemoryRegionCache.Entry` 当前缓存的是 `chunk`、`nioBuffer`、`handle`、`normCapacity`，不是 ByteBuf Java 对象本体，证据：`buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:428`。  
7. `MemoryRegionCache.allocate(...)` 当前通过 `initBuf(...)` / `initBufWithSubpage(...)` 重建 `PooledByteBuf`，证据：`buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:364`。  
8. `MemoryRegionCache.add(...)` 当前若队列已满，会立即回收 entry 包装而不是强行缓存，证据：`buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:349`。  
9. `MemoryRegionCache.trim()` 当前用 `size - allocations` 决定要回收多少闲置 entry，证据：`buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:401`。  
10. `free(boolean finalizer)` 当前通过 CAS 保证只执行一次，并在结束时递减 arena 的 `numThreadCaches`，证据：`buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:201`。  
11. `FreeOnFinalize.finalize()` 当前会兜底调用 `cache.free(true)`，证据：`buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:474`。  
12. `PooledByteBufAllocatorTest.testThreadCacheDestroyedByThreadCleaner/AfterExitRun` 当前证明线程结束后 thread cache 最终会被销毁，但不是同步瞬间完成，证据：`buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:353`。  
13. `testNumThreadCachesWithNoDirectArenas` 当前证明 `numThreadLocalCaches()` 会随 thread cache 创建与销毁变化，证据：`buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:419`。  
14. `testArenaMetricsCache/NoCache` 当前证明 cache 开启与否会改变 arena metrics 的可见性，证据：`buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:147`。

### 深审发现

1. **高风险：容易把 PoolThreadCache 写成第二个独立内存池。** 正文已明确它只是 arena 前后的线程本地回收面。  
2. **高风险：容易把 cache entry 写成缓存 ByteBuf Java 对象本体。** 正文已明确缓存的是底层区域描述。  
3. **中风险：容易把 huge 误写进 thread cache。** 正文已明确 huge 不进 cache。  
4. **中风险：容易把 trim/free/finalizer 混成同一种清理动作。** 正文已明确三类触发边界。  
5. **低风险：容易把线程退出后的 cache 销毁写成立刻同步完成。** 正文已用测试限定为“最终销毁”。

## 第二轮：因果审

- 分配先试 cache、释放先试 cache -> thread cache 站在 arena 前后的局部回收面：✅  
- cache entry 保存 chunk/handle 描述 -> 复用的是底层区域，而不是 Java 外壳：✅  
- trim 按分配尝试次数收缩 -> 不是定时清扫，也不是线程退出清理：✅  
- free/finalizer -> 处理整个 cache 生命周期退出：✅  
- 线程退出与 `willCleanupFastThreadLocals()` 差异 -> thread cache 销毁路径也受线程模型影响：✅

## 第三轮：结构审

正文结构按“thread cache 不是第二池 -> 总图位置 -> 四组缓存 -> entry 语义 -> 命中与回退 -> trim -> free/finalizer -> 线程退出测试 -> 收网”推进，没有按类文件顺序平铺。✅

失败方案已覆盖：
- 每次释放都直接回 arena  
- 缓存整个 ByteBuf 外壳  
- huge 也强行进 cache  
- cache 不做 trim/free  
- 线程退出不清 cache  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- thread cache 不是第二个池，而是局部回收面  
- 它缓存的是底层区域描述，不是 ByteBuf 外壳  
- 分配命中与释放回退各自如何经过 cache  
- trim、free、finalizer、线程退出分别对应什么边界  
- arena metrics 和 numThreadLocalCaches 为什么会受 thread cache 生命周期影响  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重新展开 FastThreadLocal/Recycler 内部细节。✅  
- 未把 thread cache 命中写成必然更优，只保留当前源码分层设计。✅  
- 未把 finalizer 写成首选清理路径。✅  
- 未把 arena metrics 直接当成操作系统内存曲线。✅

## 第六轮：依赖审

- 依赖 Ch8-05 池化总图，真实存在。✅  
- 依赖 Ch5-03 线程本地/复用总体思想，正文未重复其内部实现。✅  
- 依赖 Ch4-06 ownership 前置，真实存在。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 11,415。  
- 去掉常见 markdown 标记后的字符数：约 11,108。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经建立 PoolThreadCache 的局部回收面主线：缓存的是底层区域描述，命中/回退围绕 arena 工作，trim/free/finalizer/线程退出共同定义 cache 生命周期。Ch8-06 可作为后续 arena metrics、thread cache 调优和更多池化回收路径专题的直接前置篇。