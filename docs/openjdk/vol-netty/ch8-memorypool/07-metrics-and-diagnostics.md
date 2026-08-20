# Ch8-07 池化分配器指标、ThreadCache 调优与诊断

## 先拆掉一个最常见的误诊模式

只要开始排查 Netty 的内存问题，几乎所有人都会很快遇到同一个困惑：明明 `ByteBuf.release()` 都已经返回 true 了，为什么 `usedDirectMemory` 没立刻掉下去？为什么某些 arena 的 active bytes 还在，chunk 还挂在某条 list 上，`dumpStats()` 看起来也不空？更让人不安的是，thread cache 还可能继续存在，`numThreadLocalCaches()` 也不一定马上降到 0。

如果脑子里只有一个简单模型——“对象 release 了，底层内存就应该立刻完全释放”——那这些现象看起来就像泄漏前兆。可前面几篇已经反复提醒过：池化 allocator 的回收路径不是“归零 -> 立刻归还操作系统”的直线。对象 ownership 的结束、线程本地 cache 的保留、chunk 在利用率链里的迁移、huge allocation 的销毁条件，这些都可能让“释放完成”与“指标立刻清零”之间拉开距离。

所以真正的问题不是“为什么指标没掉”，而是：**现在看到的这个指标，站在池化总图的哪一层？它到底在说明 ownership 泄漏、thread cache 仍在、chunk 仍在利用率链里，还是只是在表达 allocator 仍保留了可复用空间？**

这就是本篇要解决的核心困惑。池化 allocator 的指标不是一个单一真相，而是一组分层信号。只有把 allocator 级、arena 级、chunk list/subpage 级、thread cache 级指标重新放回分配/回收路径里，读者才不会把所有“内存还在”都误诊成 leak，也不会把所有“指标看着正常”都误判成没问题。

## 第一层：Allocator 级指标告诉你的，是池总体状态，不是每个对象的即时去留

最容易先看到的一层，是 `PooledByteBufAllocatorMetric`。这个类暴露的指标包括：`numHeapArenas`、`numDirectArenas`、`heapArenas`、`directArenas`、`numThreadLocalCaches`、`smallCacheSize`、`normalCacheSize`、`chunkSize`、`usedHeapMemory` 和 `usedDirectMemory`，见 `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocatorMetric.java:22`。

这些指标最大的问题不是“名字难懂”，而是特别容易被读者拿来做过度推断。比如很多人看到 `usedDirectMemory`，就会自然以为它代表“JVM 当前真正占用的 direct memory 总量”；看到 `numThreadLocalCaches`，就会以为“只要这个数归零，池化占用就应该一起归零”。源码其实已经给出更克制的边界。

`PooledByteBufAllocator.usedMemory(...)` 的实现很直接：它只是把各个 arena 的 `numActiveBytes()` 累加起来，见 `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:703`。这说明 `usedHeapMemory()` 和 `usedDirectMemory()` 说的是**allocator 眼里的当前活动字节总量**，不是操作系统 RSS，也不是 JVM native memory tracking 的完整视图。

`pinnedHeapMemory()` 和 `pinnedDirectMemory()` 也类似。它们只是把各 arena 的 `numPinnedBytes()` 聚合起来，见 `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:717`。也就是说，这一层指标关心的是 allocator 自己掌握的 pinned 状态，而不是系统层面“还有多少页没被回收”的最终答案。

这就决定了 allocator 级指标的正确用法：它们适合回答“这个池现在总体上有多大、配了多少 arena、每个线程 cache 的规模上限大概是什么、当前线程 cache 总数有多少、活动字节是否还在增长”，却不适合直接回答“这一个具体 ByteBuf release 以后，底层物理内存有没有立刻消失”。

所以第一层心智图应该这样立：

- `numHeapArenas/numDirectArenas`：资源域规模；
- `smallCacheSize/normalCacheSize/chunkSize`：池化结构参数；
- `numThreadLocalCaches`：线程本地 cache 当前数量；
- `usedHeapMemory/usedDirectMemory`：池从自己角度观察到的 active bytes 总量；
- `pinnedHeapMemory/pinnedDirectMemory`：池从自己角度观察到的 pinned bytes 总量。

只要把这些指标的层级先放正，后面就不容易把它们当成“系统唯一真相”。

## 第二层：Arena 级指标回答“哪类分配和回收还在发生”

如果 allocator 级指标是池总体状态，那 `PoolArenaMetric` 就是在问：每个 arena 内部，到底是哪类分配和回收在发生。

`PoolArenaMetric` 暴露的指标很多，核心可以分成四组，见 `buffer/src/main/java/io/netty/buffer/PoolArenaMetric.java:22`。

第一组是结构类：

- `numThreadCaches()`
- `smallSubpages()`
- `chunkLists()`

它们回答的是“这个 arena 挂了多少线程 cache、有哪些 subpage、有哪些 chunk 利用率链”。

第二组是累计类：

- `numAllocations()`
- `numSmallAllocations()`
- `numNormalAllocations()`
- `numHugeAllocations()`
- 对应的 deallocations

它们回答的是“从 arena 视角看，各类分配和回收累计发生了多少次”。

第三组是 active 类：

- `numActiveAllocations()`
- `numActiveSmallAllocations()`
- `numActiveNormalAllocations()`
- `numActiveHugeAllocations()`
- `numActiveBytes()`

它们回答的是“当前还有多少 allocation/bytes 仍处于活动状态”。

第四组是利用率布局类：

- `chunkLists()` 里的各条链
- `smallSubpages()` 里的元素占用

它们回答的是“活动空间正以什么形态留在 arena 里”。

这一层指标最大的价值，是把“池总体还不小”进一步拆成“到底是哪条路径还在活跃”。比如：

- 如果 `numHugeAllocations` 和 `numActiveHugeAllocations` 特别高，说明问题可能根本不在线程 cache，而在 huge 分配路径；
- 如果 `numSmallAllocations` 很高但 `numDeallocations` 跟不上，就要区分是 cache 命中造成统计可见性变化，还是 ownership 真有问题；
- 如果 `numThreadCaches()` 高，arena 本身再活跃，说明你看到的保留可能大量来自线程本地缓存而不是 chunk 无法回收。

也就是说，arena 指标开始把池化问题按 size class、利用率和线程 cache 参与度拆开。和 allocator 级总量相比，这一层更接近“哪一条分配/回收路径在说话”。

## 为什么 Arena 的 allocation/deallocation 计数不能直接当“真实请求次数”

arena 级指标看起来已经够细了，但这里又有一个很容易踩的坑：很多人会下意识把 `numAllocations - numDeallocations` 直接理解成“还有这么多真实对象没释放”。这个推断并不可靠。

最直接的证据来自 `PooledByteBufAllocatorTest.testArenaMetricsNoCache()` 和 `testArenaMetricsCache()`。没有 cache 时，测试预期 100 次分配、100 次释放都会直接落到 arena metrics 上；有 cache 时，同样循环 100 次，预期的 active/alloc/dealloc 统计却完全不同，见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:147`。

这组测试说明，arena metrics 并不是“每个业务请求的绝对历史账本”，而是“从 arena 视角能看见多少次分配/回收”。一旦 thread cache 命中，很多对象的分配和释放不会再完整穿过 arena 的共享结构，于是某些统计就会显著不同。

所以 arena 的 allocation/deallocation 指标更适合回答：

- arena 这一层正在承担多大分配压力；
- cache 是否明显改变了共享结构的可见分配量；
- 哪类分配是经常回到 arena，哪类更多在本地 cache 内完成复用。

它们不适合单独回答“真实业务申请了多少次 buffer、释放了多少次 buffer”。一旦把这一层误用成绝对真相，就会把“cache 命中改变统计可见性”误诊成“计数失真”或“潜在泄漏”。

因此第二层心智图还要再补一句：**arena 指标已经很有用，但它仍然是池化分层设计视角里的计数，不是脱离 cache 和分配路径的绝对业务真相。**

## 第三层：ChunkList 和 Subpage 指标回答“空间现在是怎么摆着的”

当问题继续往下追，就不能只问“分了多少、还活着多少”，还要问“这些空间现在是以什么形态摆在池里”。这时才轮到 `PoolChunkListMetric` 和 `PoolSubpageMetric` 真正有意义。

`testPoolChunkListMetric()` 是很好的入口。测试验证 allocator 默认会暴露 6 条 chunk list，并且每条链都有明确的利用率区间，比如 1-25、1-50、25-75、75-100、100-100，见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:195`。这说明 chunk list 指标回答的根本问题不是“有多少 chunk”，而是“这些 chunk 当前分布在哪个利用率层里”。

这层信息在诊断时非常有价值。因为同样是 `usedDirectMemory` 偏高，可能出现至少几种完全不同的布局：

- 大量 chunk 还挂在低利用率链，说明空间保留很多但使用并不密集；
- 很多 chunk 堆在高利用率链，说明池里确实有大量活跃数据；
- huge 路径占用高，则 chunk list 反而不一定能解释现象。

再看 subpage。`testSmallSubpageMetric()` 会分配一个 500 字节 heap buffer，然后检查 `smallSubpages().get(0)` 的 `maxNumElements - numAvailable` 是否等于 1，见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:217`。这说明 subpage 指标不是抽象存在，它确实能直接反映某个固定大小元素池里目前用了多少个元素。

所以如果把指标按诊断问题重新分类，可以这样理解：

- allocator 级：池总体是否大、线程 cache 有多少；
- arena 级：small/normal/huge 哪条路径活跃；
- chunk list 级：空间保留主要落在哪个利用率层；
- subpage 级：小对象元素池当前占用情况怎样。

这四层一起用，才可能把“内存没降”从一句抽象抱怨，拆成更具体的空间状态图。

## `numThreadLocalCaches` 说的是 cache 生命周期，不是池是否彻底空了

前面两篇已经讲过 thread cache 会让释放后的空间暂时留在线程本地，所以 `numThreadLocalCaches()` 往往是诊断时非常敏感的指标。问题是，它特别容易被过度解读。

`PooledByteBufAllocatorMetric.numThreadLocalCaches()` 最终只是把各 arena 的 `numThreadCaches` 聚合起来，见 `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocatorMetric.java:63` 与 `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:632`。这意味着这个数字回答的是：当前 allocator 视角下，还有多少 thread cache 活着；它并不直接回答 arena/chunk 是否已经空、底层内存是否已经回到系统。

测试把这个边界写得很清楚。`testNumThreadCachesWithNoDirectArenas()`、`testNumThreadCachesAccountForDirectAndHeapArenas()` 和 `testThreadCacheToArenaMappings()` 分别验证：

- thread cache 数量会随创建和销毁变化；
- heap/direct arena 都会各自维护 `numThreadCaches`；
- 一个 allocator 总数归零之前，各 arena 上的 cache 绑定关系也会逐步变化。

见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:419`。

这说明 `numThreadLocalCaches()` 最适合回答的是：当前线程本地缓存层还在不在，在哪些 arena 上还挂着。它不能直接回答：

- 这些 cache 里还剩多少 entry；
- arena 里的 chunk 是否已经清空；
- JVM 或 OS 层内存是否已经下降。

所以诊断时如果看到 `numThreadLocalCaches() > 0`，结论应该是“thread cache 仍然活着，局部缓存层可能继续保留空间”；而不是“这就是 leak”。反过来，如果 `numThreadLocalCaches() == 0`，也不能立刻说“池已经彻底空了”，因为 arena/chunk 依然可能保留可复用空间。

这层边界越早立住，后面越不容易误诊。

## 为什么 thread cache 销毁不一定同步瞬间完成

真正容易让人误判的，是 thread cache 的销毁时机。很多读者会自然期待：线程结束了，对应 cache 应该立刻消失；如果指标没掉，那大概哪里出问题了。测试恰好说明这个直觉过于理想化。

`testThreadCacheDestroyedByThreadCleaner()` 和 `testThreadCacheDestroyedAfterExitRun()` 分别构造 `FastThreadLocalThread`，让线程结束后沿不同路径销毁 cache；测试不会在线程 `join()` 的下一行就断言 cache 数量为 0，而是会循环等待 `allocator.metric().numThreadLocalCaches()` 下降，并且在等待过程中主动触发 GC，见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:353`。

这组测试清楚地表明：thread cache 的销毁是“最终完成”的语义，不是“线程 run 返回那一刻同步完成”的语义。原因也不神秘：thread cache 的离场可能依赖 `FastThreadLocal` 的清理路径，也可能依赖 cleaner/finalizer 的兜底路径，而这些路径和线程退出之间本来就允许存在延迟。

所以一旦看见 `numThreadLocalCaches()` 没有立刻归零，最先要问的不是“泄漏了吗”，而是：

- 当前线程是不是刚退出，还没走完 cache 清理路径；
- 它是会主动 cleanup fast thread locals，还是更依赖 cleaner/finalizer 兜底；
- 当前看到的是短暂过渡态，还是长时间稳定卡住。

这层诊断顺序非常重要，因为它直接影响你是继续观察线程生命周期，还是转去查 ownership 与真正 leak。把“延迟离场”错判成“资源丢失”，会把排障带到完全错误的方向上。

## 一个很关键的测试：释放后 chunk 真能完全移出所有 chunk list 吗

前面几层指标解释完以后，还有一个特别关键的现象要单独强调：释放之后，chunk 有时会保留，有时又会完全离开所有 chunk list。`testFreePoolChunk()` 正好把这种行为钉死了。

测试会构造一个较大的 heap buffer，使其占满一个 chunk，然后验证：分配时这个 chunk 会落入最高利用率链；当该 buffer release 之后，6 条 chunk list 都重新变空，见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:249`。

这说明“release 后 chunk 还在不在”并没有单一答案。它取决于：

- 这次分配属于 small、normal 还是 huge；
- chunk 当前在什么利用率链；
- 释放后 freeBytes 是否越过迁移/销毁阈值；
- thread cache 是否先接住了空间；
- arena 是否最终允许该 chunk 销毁。

因此，看到 chunk 仍在 list 上，不应直接判 leak；看到 chunk 完全消失，也不应以为池化总是如此。真正该做的是把现象放回具体路径上：当前是不是 qInit 保留？是不是 thread cache 先接住了？是不是 huge 路径？是不是这次刚好满足完全销毁条件？

也就是说，chunk 是否仍存在，本身就是诊断结果，而不是诊断结论。

## 诊断顺序：先判断 ownership，再判断池化保留，再看线程 cache

到这里为止，已经可以把池化指标的诊断顺序收成一套稳定方法了。

第一步，先看 ownership 闭没闭环。也就是：相关 ByteBuf 是否都真正 `release()` 了，引用计数是否归零。如果 ownership 本身没闭环，后面的池化指标再漂亮也没意义，因为那是真正的 leak 风险。

第二步，如果 ownership 已经闭环，再看 thread cache 是否仍活着。`numThreadLocalCaches()` 和对应 arena 的 `numThreadCaches()` 能告诉你局部缓存层还在不在、还挂在哪些 arena 上。这个阶段主要排查的是“线程还没退出”“cache 仍在复用面上”“cleaner/finalizer 还没跑完”等现象。

第三步，再看 arena 和 chunk list 指标。`numActiveAllocations()`、`numActiveBytes()`、`chunkLists()`、`smallSubpages()` 等能告诉你保留空间主要落在哪条路径，是 small/subpage、normal/chunk list，还是 huge allocation。这个阶段排查的是“池化保留”和“空间布局状态”。

第四步，最后才去对照进程 RSS、NMT 或其他系统级指标。因为 allocator metrics 本来就不是 OS 内存的镜像。只有当前三层都看明白以后，系统级内存表现的变化才有机会被正确解释。

这套顺序的意义，在于把“release 了但内存没掉”拆成多个不同层级的问题，而不是一句含糊的抱怨。很多误诊，本质上都是跳过了前面的分层，直接拿 allocator 指标去对照系统内存，再把所有不一致都喊成 leak。

## 收网：指标不是判决书，而是沿着池化路径分层发声的信号

现在可以把整条主线收回来了。

- `PooledByteBufAllocatorMetric` 告诉你池总体规模、线程本地 cache 数量和 active bytes 聚合值，见 `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocatorMetric.java:22`。  
- `PoolArenaMetric` 告诉你 small/normal/huge 哪条路径在活跃、各类分配和回收如何变化，见 `buffer/src/main/java/io/netty/buffer/PoolArenaMetric.java:22`。  
- `chunkLists()` 和 `smallSubpages()` 则进一步回答：空间当前以什么利用率层、什么元素池形态留在池里。  
- `numThreadLocalCaches()` 和相关测试告诉你 thread cache 仍是否活着，它的离场是否只是延迟而非异常，见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:353`。  
- `testArenaMetricsCache/NoCache`、`testFreePoolChunk` 等测试则提醒我们：cache 是否启用、chunk 当前所在路径、释放后是否满足销毁条件，都会改变指标的可见形态。

所以本篇真正要留下来的结论是：**池化 allocator 的指标不是一张“泄漏/不泄漏”的判决书，而是一组沿着分配与回收路径分层发声的信号。**

只有先弄清楚自己现在看的到底是 ownership、thread cache、arena/chunk 还是系统层内存，后面的调优和排障才不会混在一起。否则很容易把正常的池化保留误判成 leak，也很容易把真正的 leak 错看成“只是 allocator 还没缩下去”。

这也正好把后续专题自然引出来。接下来如果继续深入，最值得展开的方向就不再是“池化总图长什么样”，而是“如何根据这些指标去调 `cacheSize`、`arena` 数量、trim 频率，以及如何把 allocator 视角与系统级内存诊断接起来”。