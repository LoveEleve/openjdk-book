# Ch8-06 PoolThreadCache：线程本地缓存与回收路径

## 先把一个最容易混淆的点拆开

前一篇讲池化分配器总图时，thread cache 已经出现过一次：allocator 先让当前线程尝试从本地 cache 命中，命不中才回到 arena、chunk、subpage 或 run。很多读者在这里会自然地形成一个半对半错的印象：既然都叫 cache，而且还能让释放后的空间先留在线程本地，那 `PoolThreadCache` 大概就是“另一个更小的内存池”。

这个印象只对了一半。它确实是一个线程本地缓存层，但它并不是一套与 arena 平行、能独立完成全部分配回收的第二内存池。它既不直接拥有整块底层内存，也不缓存 `ByteBuf` Java 对象本体，更不处理 huge allocation。它缓存的是一些已经由 arena/chunk/subpage 体系分配出来的**底层区域描述**，然后在当前线程再次申请同类容量时，优先把这份区域描述重新装回一个新的 `PooledByteBuf` 外壳。

所以要理解 `PoolThreadCache`，第一步不是问“它缓存了多少块内存”，而是先问：**它到底缓存的是什么，位于池化总图的哪一层，以及为什么释放后不立刻回 arena。**

答案可以先压成一句话：`PoolThreadCache` 不是第二个池，而是 arena 前后的一个线程本地回收面。分配时它站在 arena 前面，尽量让当前线程就地复用；释放时它站在 arena 前面，尽量把空间先留在当前线程，以便下一次同类请求不用重新进入共享结构。

一旦把这层定位看清，后面的几个现象就会顺起来：为什么它只缓存 small 和 normal，不碰 huge；为什么它既有 heap cache 又有 direct cache；为什么它要维护 `freeSweepAllocationThreshold` 和 `trim()`；为什么线程退出后 cache 还要再走一轮销毁；为什么 arena 的 `numThreadCaches` 会跟线程生命周期一起变化。

## 先看总图里的位置：它不是独立池，而是 arena 的前置与回收缓冲层

把 `PoolThreadCache` 放回前一篇的总图里，位置其实非常明确：

`allocator -> arena -> thread cache -> size class -> subpage/run`

但这条箭头在分配和释放两个方向上意义不同。

分配方向上，`PoolArena.allocate(...)` 会先把请求映射到 size index，然后根据 small 或 normal 路径，先调用 `cache.allocateSmall(...)` 或 `cache.allocateNormal(...)` 尝试命中；只有命不中时，才继续走 subpage 或 chunk list，见 `buffer/src/main/java/io/netty/buffer/PoolArena.java:135`、`:150`、`:191`。也就是说，thread cache 站在 arena 共享结构前面，目的是拦住那些“当前线程刚释放、很快又重新需要”的热点请求。

释放方向上，`PoolArena.free(...)` 先判断当前 chunk 是否 unpooled、当前 handle 属于 Small 还是 Normal；如果存在 `PoolThreadCache`，就先尝试 `cache.add(...)`，只有 add 失败才真正回到 `freeChunk(...)` 路径，见 `buffer/src/main/java/io/netty/buffer/PoolArena.java:237`。换句话说，空间释放以后并不会必然马上回到 chunk list 或 subpage pool，而是先给当前线程一次“留作本地重用”的机会。

这两条路径合在一起，正是 thread cache 的核心角色：**它既是 arena 之前的命中层，也是 arena 之前的缓冲层。**

这和“第二个独立内存池”有本质区别。独立池意味着自己决定分配粒度、自己拥有完整生命周期、自己可以脱离 arena 单独存在。`PoolThreadCache` 并不是这样。它不决定 size class，不管理 chunk 利用率，不负责 huge 分配，也不直接创建底层内存。它只是把 arena 已经定义好的 small/normal 空间描述，暂时留在当前线程手边。

所以本篇第一层心智模型应该先立住：**thread cache 是局部复用面，不是第二个 allocator。**后面所有设计细节，都是围绕这层定位展开的。

## 四组缓存，而不是一锅队列：heap/direct × small/normal

只要接受了它是局部复用面，下一步就会自然问：那它具体缓存什么类别的东西？源码的第一答案是：它不是一锅统一队列，而是至少四组缓存。

`PoolThreadCache` 内部有四类数组字段：

- `smallSubPageHeapCaches`
- `smallSubPageDirectCaches`
- `normalHeapCaches`
- `normalDirectCaches`

定义见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:52`。从名字就能看出，它沿着两个维度把缓存拆开了：

- heap 与 direct 两类底层 memory；
- small 与 normal 两类 size class。

而且这里没有 huge cache。构造器也明确只在 heap/direct arena 不为空时创建 small/normal cache 数组，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:68`。这说明 thread cache 的职责边界从一开始就非常明确：它只服务池化体系里的 small 和 normal 分配，不接 huge。

为什么要拆成四组？因为这四类请求复用时需要回到完全不同的初始化路径。

- small + heap：最终要走 `initBufWithSubpage(...)`，而且底层 memory 是 heap 类型；
- small + direct：仍然是 subpage 粒度，但底层 memory 是 direct；
- normal + heap：走普通 run 初始化，底层是 heap；
- normal + direct：走普通 run 初始化，底层是 direct。

如果把它们混在一个大队列里，命中后还得在队列元素层面重新判断“这块描述到底适配哪种 arena 和 size class”，不如一开始就按类别拆开。这样一来，命中路径只需要根据 arena 和 sizeIdx 选择正确数组，再从对应队列里拿 entry 即可。

构造器里对 `numThreadCaches` 的计数也进一步说明这四组缓存是挂在 arena 身上的。只要 directArena 或 heapArena 存在，对应的 `numThreadCaches` 就会递增，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:75`。这说明 cache 不是某个游离线程的私有玩具，而是 arena 需要感知、统计并在生命周期结束时回收的局部扩展层。

所以第二层心智模型可以立成：**`PoolThreadCache` 不是一个“大缓存”，而是 heap/direct 与 small/normal 交叉后的多组局部队列。**这样后面看到 `cacheForSmall`、`cacheForNormal`、`SubPageMemoryRegionCache`、`NormalMemoryRegionCache` 时，就不会再觉得它们只是命名啰嗦，而会知道这是分配粒度和底层 memory 类型共同决定的结构拆分。

## 它缓存的不是 ByteBuf 对象，而是 `(chunk, handle, nioBuffer, normCapacity)` 这组区域描述

理解 `PoolThreadCache` 最关键的一步，是把“缓存对象”说准。很多人一听到对象池、缓存和复用，很容易下意识以为：那它大概就是把 `PooledByteBuf` 本身放进队列里，下次直接拿出来继续用。源码恰恰证明不是这样。

真正进入缓存队列的是 `MemoryRegionCache.Entry`。这个 entry 里持有的是：

- `PoolChunk chunk`
- `ByteBuffer nioBuffer`
- `long handle`
- `int normCapacity`

定义见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:428`。这组信息不是一个 Java ByteBuf 对象外壳，而是一份底层区域描述：它告诉系统“那块可复用空间在哪个 chunk 里、用哪个 handle 可以重新定位、容量归到哪个 size class”。

命中路径也证明了这一点。`MemoryRegionCache.allocate(...)` 从队列里 poll 一个 entry，然后调用 `initBuf(...)`，用 entry 里携带的 chunk、handle 和容量信息去重新初始化传入的 `PooledByteBuf`，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:364`。也就是说，thread cache 命中后，并不是“把旧 ByteBuf 原样拿回来”，而是“把旧底层区域重新装配到当前要返回的 ByteBuf 容器上”。

这条差别非常重要，因为它直接决定了 thread cache 和前一篇里 `Recycler` 的边界不一样。`Recycler` 复用的更像是某些 Java 小对象外壳；`PoolThreadCache` 复用的则是已经分配好的底层内存区域描述。两者都叫复用，但复用的对象层级完全不同。

这也解释了为什么本篇要反复强调 ownership。一个 ByteBuf 的引用计数生命周期结束了，不代表它的 Java 外壳必须复用；真正值得尽快留下来的是底层空间描述，因为再次走 arena、chunk、subpage 或 run 的定位路径通常比直接重装这份描述更重。thread cache 就是抓住了这一点：外壳重新来过没关系，底层空间描述尽量别让它那么快掉回共享结构。

因此，理解 `PoolThreadCache` 的第三层心智模型是：**它缓存的不是 ByteBuf 本体，而是“这块底层区域如何被重新找到并重新装入 ByteBuf”的描述。**

## 分配命中与回退：先试本地队列，命不中再回 arena

有了前面的三层心智图，再看分配路径就很直观了。

无论是 small 还是 normal，`PoolThreadCache` 都通过统一的 `allocate(...)` 辅助方法工作。small 分支调用 `allocateSmall(...)`，normal 分支调用 `allocateNormal(...)`，它们的差别只在于选哪一组 cache 数组，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:143`。

真正的分配逻辑是：

1. 根据 arena 和 sizeIdx 找到对应的 `MemoryRegionCache`；
2. 若 cache 不存在，直接返回 false；
3. 若 cache 存在，就从队列 poll 一个 entry；
4. 成功命中后调用 `initBuf(...)` 或 `initBufWithSubpage(...)` 重建当前 `PooledByteBuf`；
5. 命中或未命中之后都增加 `allocations` 计数；
6. 达到 `freeSweepAllocationThreshold` 时触发一次 `trim()`。

对应实现见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:157`。

这里有两个非常重要的细节。

第一，命中和未命中都会累计 `allocations`。这说明 trim 触发条件不是“命中了多少次”，而是“这个线程已经发生了多少次分配尝试”。Netty 要观察的不是 cache 本身有多忙，而是当前线程是否持续在消费池化分配路径。只要分配行为足够多，就该重新检查缓存里有没有长期没被碰过的 entry。

第二，cache 找不到或命不中时，并不会报错，也不会强行塞一个空对象，而是老老实实返回 false，让上层 arena 继续走正常分配路径。这说明 thread cache 从设计上就是一个“有则更近、没有就退回共享结构”的前置加速层，而不是成功与否都要由它拍板的强制层。

从运行时语义上看，命中与回退分别代表两件事：

- 命中：当前线程手边恰好有同类底层区域描述，可以直接重用；
- 回退：当前线程手边没有合适描述，或者根本没有这种 cache，那就回到 arena 共享结构重新找。

只要把这个意义看清，thread cache 的位置就非常自然：它并没有改变 allocator 的正确性，只是在局部路径上争取省掉一次回到共享结构的成本。

## 释放路径：优先尝试进 cache，失败才真正回到 arena

分配路径容易理解，释放路径更容易被误会。因为很多人看到 `release()` 以后，直觉就会觉得“空间现在应该已经还给 arena 了”。thread cache 恰好打断了这个直觉。

`PoolThreadCache.add(...)` 会先根据当前 arena、sizeIdx 和 `SizeClass` 找到对应的 `MemoryRegionCache`；如果 cache 不存在，或者当前 cache 已经标记为 `freed`，就返回 false；否则就把 `(chunk, nioBuffer, handle, normCapacity)` 包进一个 entry 尝试放入队列，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:175`。

这意味着释放路径首先不是“归还给 arena”，而是“问当前线程：你要不要先把这块区域留下来”。只有当 thread cache 根本没有对应队列、已经在销毁状态，或者队列已满无法 `offer`，才会真正回退给 arena 的 `freeChunk(...)` 路径。

这条路径的一个关键后果是：底层 chunk 的利用率、subpage 空位和 arena metrics，并不一定在每次 ByteBuf `release()` 后立即可见地变化。因为空间可能只是先停在当前线程的本地缓存队列里，还没重新进入 arena 那一套共享结构。

从实现看，`MemoryRegionCache.add(...)` 也说明了 thread cache 并不会无限吞空间。如果队列 `offer` 失败，entry 会立刻 `unguardedRecycle()`，然后返回 false，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:349`。这说明“先尝试进 cache”并不等于“无条件塞进 cache”；局部缓存容量是有上限的，超出以后就必须回到 arena 正常回收。

所以释放路径的正确心智图是：

`ByteBuf release -> arena.free -> 先问 thread cache 要不要接 -> 接住则暂留本地 -> 接不住再回 chunk/subpage/run`

这个顺序非常重要。它解释了为什么 thread cache 会影响 arena 指标、为什么某些 chunk 在短时间内看起来没有立刻空出来、也解释了为什么“release 返回 true”不能被简单理解成“底层空间已回到共享池”。对于池化系统来说，release 结束的是对象 ownership，不是底层空间的唯一回收终点。

## trim：不是按时间扫缓存，而是按分配尝试次数做局部修剪

thread cache 既然会把底层区域描述先留在本地，那下一个问题就是：这些缓存何时会被清掉？如果没有清理机制，它迟早会从“局部复用”滑成“线程本地堆积”。

Netty 在这里给出的主路径，不是定时器，不是后台线程，而是 `freeSweepAllocationThreshold + trim()` 这套按分配尝试次数触发的修剪逻辑。

前面已经看到，每次走 `allocate(...)` 都会增加 `allocations`。一旦达到 `freeSweepAllocationThreshold`，计数就清零，并触发一次 `trim()`，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:163`。而 `MemoryRegionCache.trim()` 的逻辑也很直接：用 `size - allocations` 估算这轮分配周期里“有多少缓存元素没有真正被用到”，然后把这部分释放回 arena，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:401`。

这说明 trim 的目标不是“定期全部清空”，而是“把一段分配周期里明显没有被消费到的那部分缓存逐步削掉”。如果某个 cache 队列确实一直在被命中，allocations 就会高，`size - allocations` 就小，trim 回收的也少；如果某条队列长期几乎没被使用，那它就会在 trim 时更明显地被缩减。

这种设计很像对 thread cache 进行按需收缩，而不是按时间统一裁员。它更贴近 event loop 线程的实际负载节奏：线程忙的时候，命中多、保留多；线程换了工作集，长期闲置的 cache entry 就在后续分配尝试中被慢慢释放。

所以 trim 不是一种“线程退出时的清理”，而是一种“线程仍然活着，但本地缓存不能无限闲置”的自我修剪机制。它负责的是运行中收缩，而不是生命周期终点收尾。

## free、线程退出和 finalizer：三种清理边界不是一回事

理解了 trim 以后，另一个特别容易混的地方是：`trim()`、`free()`、线程退出和 `FreeOnFinalize` 到底什么关系？

最稳的理解方式，是把它们当成三类不同边界。

第一类边界，是运行中自我修剪，也就是刚讲的 `trim()`。线程还活着，cache 还在用，只是本轮没有用到那么多 entry，于是按阈值回收一部分。

第二类边界，是显式释放整个 thread cache，也就是 `free(boolean finalizer)`。这个方法会通过 `freed.compareAndSet(false, true)` 确保只执行一次，然后依次释放四组缓存里的 entry，并递减 heap/direct arena 的 `numThreadCaches`，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:201`。这一步意味着：从 allocator 和 arena 的视角看，这条线程本地缓存面已经彻底退出，不再参与池化路径。

第三类边界，是 finalizer 兜底。`FreeOnFinalize.finalize()` 会在对象最终被回收前尝试调用 `cache.free(true)`，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:474`。这里要特别克制地理解：它不是首选清理路径，而是“如果正常线程级移除没及时发生，至少还有一次兜底机会”。源码注释自己都写了，未来更适合用 Cleaner 这类机制，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:482`。

这三层边界合起来，刚好回答了“局部缓存如何不会无限悬挂”这个问题：

- trim 负责活着时的收缩；
- free 负责线程级缓存退出；
- finalizer 负责异常或延迟场景下的兜底。

所以千万不要把它们混成一种“清缓存动作”。它们解决的是完全不同的生命周期阶段。

## 测试真正暴露的，是 thread cache 生命周期如何离开线程

讲到这里，最有价值的测试其实不是某个单次分配结果，而是 thread cache 和线程生命周期的关系。

`PooledByteBufAllocatorTest.testThreadCacheDestroyedByThreadCleaner()` 与 `testThreadCacheDestroyedAfterExitRun()` 正好提供了两种线程退出路径。测试分别构造 `FastThreadLocalThread`，然后根据 `willCleanupFastThreadLocals()` 是 true 还是 false，让线程在结束后走不同的 cache 销毁路径，最后等待 `allocator.metric().numThreadLocalCaches()` 回到 0，见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:353`。

这个测试说明了两个事实。

第一，thread cache 的销毁不是“线程 run 方法返回那一刻同步完成”的。测试要显式循环等待 `numThreadLocalCaches()` 下降，甚至主动触发 GC，以便处理 ThreadCleanerReference 路径，见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:409`。这意味着线程退出和 cache 完全销毁之间，本来就允许存在一段过渡窗口。

第二，`FastThreadLocalThread` 是否会主动清理 fast thread locals，会影响 thread cache 的离场方式。也就是说，thread cache 的生命周期并不只受 allocator 控制，还受线程模型和线程退出清理策略影响。

`testNumThreadCachesWithNoDirectArenas()` 则从另一个角度证明，allocator metric 里的 `numThreadLocalCaches()` 的确反映这层生命周期变化：创建新的 thread cache，数值增加；显式 destroy 以后，数值下降，见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:419`。

这些测试的价值不在于数字本身，而在于它们把“thread cache 不只是一个队列，而是一段与线程绑定的运行时生命周期”这件事钉死了。只要线程还在、cache 还没 free、trim 也没清完，局部缓存就可能继续存在；线程离场后，它才会逐步退出 allocator 的状态世界。

所以排障时，如果看到 allocator 的 `numThreadLocalCaches()`、arena metrics 或内存保留行为一时没有立刻下降，不该先假设泄漏，而要先问：当前线程是不是还活着？它会不会自动 cleanup fast thread locals？cache 是还在正常工作、正在 trim，还是还没走完退出路径？

## 收网：PoolThreadCache 不是“缓存 ByteBuf”，而是缓存底层区域描述的线程本地回收面

现在可以把整条主线收回来。

- `PoolThreadCache` 不是另一套独立内存池，而是 arena 之前和 arena 之后都要经过的线程本地复用面。  
- 它维护的是 heap/direct × small/normal 四组缓存，没有 huge cache，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:52`。  
- 缓存 entry 存的是 `(chunk, nioBuffer, handle, normCapacity)` 这种底层区域描述，而不是 ByteBuf Java 对象本体，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:428`。  
- 分配时优先命中 cache，命不中再回 arena；释放时优先尝试进 cache，接不住再真正回 arena，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:157`、`:175`。  
- trim 负责运行中收缩，free 负责整个 cache 退出，finalizer 只是兜底路径，见 `buffer/src/main/java/io/netty/buffer/PoolThreadCache.java:201`、`:250`、`:474`。  
- 线程退出后的 cache 销毁不是同步瞬间完成，测试已经把这一点说明得很清楚，见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:353`。

所以本篇真正要留下来的心智模型是：**PoolThreadCache 缓存的不是 ByteBuf 外壳，而是底层区域描述；它的职责不是替代 arena，而是把“刚释放、很快又会再用到的空间”尽量留在线程本地，直到 trim、free 或线程退出再把它们有边界地还回去。**

有了这层理解，前一篇总图里那句“释放后不一定立刻回到 arena”就彻底落地了。后面再去看 thread cache 对 arena metrics 的影响、对 chunk 保留的影响，或者继续分析 write task、entry、codec 小对象等别的复用使用方，就不会再把它们误解成“泄漏”或“第二个池”，而会知道：它们只是 Netty 在池化总图和线程模型之间加的一层局部回收缓冲区。