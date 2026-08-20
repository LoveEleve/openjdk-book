# Ch8-05 池化分配器总图：Allocator、Arena、Chunk、Subpage 与 ThreadCache

## 先把“池化就是切大数组”这个模型拆掉

很多人第一次理解 Netty 池化内存时，脑子里会先出现一张很直观的图：系统申请一块很大的内存，后面每次 `allocator.buffer()` 就从这块大内存里切一段出来，释放时再把这一段放回去。这个模型并非完全错误，但它太粗了，解释不了 Netty 源码里为什么同时出现 `PooledByteBufAllocator`、`PoolArena`、`PoolThreadCache`、`SizeClasses`、`PoolChunk`、`PoolChunkList`、`PoolSubpage` 这么多层。

它也解释不了几个真实现象：为什么一个几十字节的小对象和一个几十 KB 的普通对象不会走同一条路径？为什么超过某个范围的 huge allocation 会绕过池化？为什么释放 ByteBuf 以后，allocator 统计里的 chunk 仍然可能保留？为什么有些线程会命中 thread cache，有些线程却默认不使用？为什么同一批 chunk 还要按照 0%、25%、50%、75%、100% 这样的利用率区间分成多条链？

这些问题共同说明，Netty 的池化不是一个单层容器，而是一套按**线程、大小、空间布局、利用率和释放时机**共同组织的分层系统。

本篇不从某个 `allocate()` 方法逐行展开，而是先建立一张总图：

- allocator 决定使用 heap 还是 direct，以及选择哪个 arena；
- arena 决定请求属于 small、normal 还是 huge；
- thread cache 尝试在当前线程本地快速满足请求；
- small 对象进入 subpage 的固定大小元素；
- normal 对象进入 chunk 的 page-run；
- chunk 按利用率在多条 PoolChunkList 之间移动；
- huge 对象跳过池化，直接走独立分配；
- 释放时则从 ByteBuf 反向进入 cache、subpage/run 和 chunk 生命周期管理。

所以本篇真正要解决的核心困惑是：**一次池化 ByteBuf 分配，如何在多个粒度和多个缓存层之间找到合适的位置；释放时又为什么不一定立刻让底层 chunk 消失。**

## 总图先立起来：不是 allocator 直接面对 chunk

先把参与者摆到同一张图上，后面每一节只是在这张图上放大一个局部：

`PooledByteBufAllocator`

`-> heap/direct PoolArena`

`-> PoolThreadCache 尝试命中`

`-> SizeClasses 选择 sizeIdx`

`-> Small: PoolSubpage bitmap`

`-> Normal: PoolChunk page-run`

`-> PoolChunkList 按利用率管理 chunk`

`-> Huge: unpooled chunk`

这里最容易被忽略的是 `PoolArena`。很多人把 allocator 和 chunk 之间直接画一条线，仿佛 allocator 直接管理所有 chunk。源码显示，allocator 持有的是 heap arenas、direct arenas、thread cache 和 chunk size 等更高层结构，见 `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:190`。真正把请求按大小分流、把 chunk list 和 subpage pool 组织起来的是 arena。

`PooledByteBufAllocator` 的静态初始化也说明，它在创建 allocator 之前就要确定很多全局参数：heap/direct arena 数量、page size、max order、small/normal cache size、最大缓存 buffer 容量、trim interval、是否给所有线程使用 cache 等，见 `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:38`。这些参数不是单纯的调优开关，而是在决定池化系统的空间尺度和线程边界。

比如源码默认用 `pageSize << maxOrder` 计算 chunk size，默认 page size 是 8192，默认 max order 是 9，因此注释中给出的默认 chunk 规模是 4 MiB，见 `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:44`、`:83`。这里的数字不能被当成所有环境的最佳配置，但它能帮助我们理解层级关系：page 是较小的分配基本单位，多个 page 组成 chunk，arena 再把很多 chunk 按利用率组织起来。

因此，池化总图的第一条原则是：**allocator 负责选择资源域，arena 负责选择分配路径，chunk 负责提供空间，subpage/run 负责提供具体粒度。**如果把这些角色压成一个“大内存池”，后面 small、normal、huge 和释放路径都会无法解释。

## 第一层分流：heap/direct arena 与 thread cache

`PooledByteBufAllocator` 首先要处理两个问题：这次请求最终来自 heap arena 还是 direct arena，以及当前线程能不能先从自己的 cache 中取到可用空间。

allocator 内部分别维护 `heapArenas` 和 `directArenas`，并通过 `PoolThreadLocalCache` 为线程提供 cache 入口，见 `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:190`。所以 `heapBuffer()` 和 `directBuffer()` 不是简单地调用不同构造器，而是进入不同 arena 集合、不同底层 memory 类型的池化系统。

arena 数量的默认计算也不是随便拍出来的。源码会根据可用处理器数量、heap/direct memory 上限和 chunk size 推导默认 arena 数，见 `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:93`。注释说明，这样做是为了减少多个线程在同一 arena 上争用；但这仍然只是当前实现的默认推导，不代表每种部署环境都应该照搬。

接下来是 thread cache。这里需要和前一篇区分开：Ch5-03 讲的是 `FastThreadLocal` 如何提供线程本地访问、`Recycler` 如何复用小对象；本篇只关心 `PoolThreadCache` 在池化分配总图中的位置。它的职责是：当前线程请求某个大小类别的 buffer 时，先看看本地是否已有可以直接取出的 cache entry；命中就不必立即回到 arena 的共享结构。

这个顺序有两个含义。

第一，thread cache 是池化分配的前置加速层，不是独立的第二套内存池。cache 没命中，分配仍然要回到 arena、chunk、subpage 或 run；cache 命中，也只是把之前释放回 cache 的空间重新拿出来。

第二，thread cache 会影响释放后的可见行为。一个 ByteBuf `release()` 以后，底层空间可能先回到当前线程 cache，而不是马上回到 arena 的 subpage 或 chunk list。因此“引用计数归零”与“chunk 利用率立刻改变”之间，不一定是同步一一对应的。

这也是为什么 `PooledByteBufAllocatorTest` 对 cache 开启和关闭分别验证 arena metrics。测试使用没有 cache 和有 cache 的 allocator，观察 active、allocation、deallocation 统计存在差异，见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:147`。测试不是在说哪一种永远更好，而是在提醒：cache 是分配总图中的独立阶段，会改变对象归还的路径和统计可见性。

## 第二层分流：SizeClasses 把请求拆成 Small、Normal、Huge

arena 拿到请求以后，不会直接问 chunk“给我一块内存”。它先通过 `SizeClasses.size2SizeIdx(reqCapacity)` 把请求映射到一个 size index，见 `buffer/src/main/java/io/netty/buffer/PoolArena.java:129`。

随后，源码把 size index 分成三段：

- `sizeIdx <= smallMaxSizeIdx`：走 small 路径；
- `sizeIdx < nSizes`：走 normal 路径；
- 其余：走 huge 路径。

对应实现见 `buffer/src/main/java/io/netty/buffer/PoolArena.java:135`。这三条路径不是标签不同，而是空间管理粒度完全不同。

### Small：在固定大小元素里找空位

small 请求通常不值得为每个对象单独管理一个 page-run。更合适的方式是：先拿一个 page 或 page 内的一段 run，再把它切成很多相同大小的元素，用 bitmap 标记每个元素是否已占用。这就是 `PoolSubpage` 的职责。

所以 small 路径会先让 thread cache 尝试分配；未命中时，arena 按 size index 找到对应的 `smallSubpagePools`，如果已经存在有空位的 subpage，就从 bitmap 中取一个元素；如果没有，才会继续走后面的 normal allocation 路径，为 small 分配准备新的 backing，见 `buffer/src/main/java/io/netty/buffer/PoolArena.java:150`。这里的关键不是“每次都新建 subpage backing”，而是 small 请求会优先复用已有 subpage，不够时再向更下层要新的支撑空间。

### Normal：按 page-run 管理连续空间

normal 请求的容量已经不适合塞进固定大小元素池，但仍然没有大到需要完全独立分配。它会经过 `PoolChunkList`，在某个 chunk 中寻找足够大的连续 page-run。arena 会依次尝试多条 chunk list，找到可用 chunk 后分配；如果都找不到，就创建一个新 chunk 并放入初始利用率链，见 `buffer/src/main/java/io/netty/buffer/PoolArena.java:206`。

### Huge：超出池化范围后独立分配

超过 `SizeClasses` 能处理的范围后，arena 不再强行把对象塞进 chunk。源码会把请求容量按 direct memory alignment 处理，然后调用 `allocateHuge(...)` 创建 unpooled chunk，见 `buffer/src/main/java/io/netty/buffer/PoolArena.java:142`、`:229`。

这条分流非常重要，因为它避免了一个常见误解：池化 allocator 并不意味着每一个 ByteBuf 都来自同一套 chunk 池。huge allocation 是池化系统承认“这个对象已经不适合用小粒度池化管理”的正常出口。

因此，大小分流可以总结为：

- small 追求固定元素的高密度复用；
- normal 追求连续 page-run 的空间分配；
- huge 追求直接、独立地满足大容量请求。

如果强行让三类请求共用一种结构，小对象和大对象的管理粒度就会被迫绑在一起：要么小对象空间利用率变差，要么大对象需要承受更细粒度的管理结构。当前源码把它们拆开，体现的是一种明确的结构取舍。

## Chunk 内部：page、run 和 handle 如何共同描述空间

`PoolChunk` 的类注释提供了一张很好的空间地图：page 是 chunk 中的最小分配单位，run 是多个 page 的集合，chunk 则是多个 run 的集合，见 `buffer/src/main/java/io/netty/buffer/PoolChunk.java:30`。

chunk 创建时，会先准备一整块底层 memory，并把整个 chunk 当成一个初始空闲 run 插入可用结构，见 `buffer/src/main/java/io/netty/buffer/PoolChunk.java:198`。后续 normal 分配会找到一个足够大的可用 run；如果请求只需要其中一部分，就把原 run 切成已用部分和剩余空闲部分，把尾部重新放回可用结构。

源码用 `runsAvailMap` 记录可用 run 的边界，用 `runsAvail` 这组优先队列管理不同大小的可用 run，见 `buffer/src/main/java/io/netty/buffer/PoolChunk.java:158`。这种双重结构的意义是：既能快速知道某个 offset 对应的 run，也能按 page 数和位置寻找适合请求的空闲段。

释放时，chunk 不只是把某个 handle 标成 free。它会识别相邻可用 run，并尝试把连续空间合并成更大的 run，再重新放回可用结构。这样做的目标不是让每个释放动作都立即还给系统，而是让 chunk 内部的空间重新形成可供后续 normal 请求使用的连续区域。

`handle` 则是这套空间状态的压缩描述。源码注释列出它编码了 run offset、run 的 page 数量、used 标志、subpage 标志和 subpage bitmap index，见 `buffer/src/main/java/io/netty/buffer/PoolChunk.java:76`。因此 handle 不是一个普通数组下标，而是释放、识别分配粒度和定位底层空间所需的一组状态。

理解 handle 的最好方式，不是背位布局，而是知道它连接了三件事：

- 这次分配在 chunk 的什么位置；
- 它占了多少 page；
- 它到底是 normal run，还是 subpage 中的某个固定元素。

正因为 handle 同时携带这些信息，释放路径才能在 `PoolArena.free(...)` 中判断应该回到 Small 还是 Normal 分支，见 `buffer/src/main/java/io/netty/buffer/PoolArena.java:237`。

## Small 与 Subpage：bitmap 管理固定大小元素

small 路径的核心不是“分配更小”，而是“把一个 backing region 切成同规格的很多小元素”。`PoolSubpage` 正是这块固定大小元素区域的管理者。

创建 subpage 时，源码会记录 `elemSize`、run offset、run size，并根据 `runSize / elemSize` 计算最多能容纳多少个元素；随后用 `long[] bitmap` 记录每个元素是否已占用，见 `buffer/src/main/java/io/netty/buffer/PoolSubpage.java:64`。

分配时，`allocate()` 先检查 subpage 是否仍然可用，然后找到下一个空闲 bitmap index，设置对应 bit，减少 `numAvail`；当可用元素降到 0 时，subpage 会从可用 subpage 链表移除，见 `buffer/src/main/java/io/netty/buffer/PoolSubpage.java:87`。

释放时则反向操作：清掉 bitmap 对应 bit，记录下一个可用位置，增加 `numAvail`；如果 subpage 重新出现空位，就加入可用池。如果完全空闲，还要判断它是不是池中最后一个 subpage：如果不是，就可能从池中移除并允许销毁；如果是唯一一个，则保留它，避免把对应管理结构彻底拆掉，见 `buffer/src/main/java/io/netty/buffer/PoolSubpage.java:118`。

这段逻辑揭示了 small 分配与 normal 分配的本质差异：

- normal 关注连续空间，核心动作是 run 的切分与合并；
- small 关注固定元素，核心动作是 bitmap 的置位与清位。

两者共享 chunk 作为更大的内存容器，却使用不同的内部索引结构。如果把 small 也当成普通 run 分配，就会为几十字节对象支付过大的空间和管理成本；如果把 normal 也切成 bitmap 元素，就会失去连续大块空间的表达能力。

## `PoolChunkList`：六条链其实是一条利用率分层链

理解池化 allocator 时，`qInit`、`q000`、`q025`、`q050`、`q075`、`q100` 这几个名字很容易让人误以为是六个互不相干的内存池。源码显示，它们实际构成的是一条按 chunk 利用率组织的双向链。

`PoolArena` 创建这些 `PoolChunkList` 时，为每条链设置不同的 minUsage 和 maxUsage，并通过 `prevList`、`nextList` 把它们连起来，见 `buffer/src/main/java/io/netty/buffer/PoolArena.java:91`。这些链管理的是 chunk 当前用了多少，而不是请求本身属于哪种 size class。

`PoolChunkList.allocate(...)` 成功从 chunk 分配以后，会检查 chunk 的 freeBytes 是否已经低于当前链的阈值。如果利用率继续升高，chunk 就从当前链移到 next list，见 `buffer/src/main/java/io/netty/buffer/PoolChunkList.java:99`。

释放路径则反过来。`free(...)` 先把 handle 交回 chunk；如果 chunk 的空闲空间超过当前链的阈值，就把它移向利用率更低的前置链。如果已经回到足够空闲、且没有更低的前置链，最终可能返回 false，让 arena 销毁这个 chunk，见 `buffer/src/main/java/io/netty/buffer/PoolChunkList.java:119`。

这套设计解决的是一个池化系统必须面对的问题：如何在“继续使用已有 chunk”和“创建新 chunk”之间找到空间状态的平衡。

- 利用率较低的 chunk 继续接收请求，避免一有小请求就创建新底层内存；
- 利用率较高的 chunk 被放到更后面的链，逐渐减少继续分配的空间；
- 完全空闲的 chunk 在合适条件下可以被销毁，避免池化结构无限保留。

所以 `PoolChunkList` 不是按照请求大小分组，也不是六个独立 allocator。它是一种利用率分层结构，让 arena 能根据 chunk 当前状态选择合适的空间来源。

## 释放以后，为什么 chunk 可能还在

很多人第一次用池化 allocator 时，会把“ByteBuf 的 `release()` 返回 true”和“底层 chunk 应该立刻消失”联系起来。这个推断不成立。

`release()` 归零，只说明这一个 ByteBuf 的 ownership 已经结束，底层空间可以回到池化系统；它不代表池化系统应该立刻销毁承载这块空间的 chunk。释放之后，空间可能先进入当前线程的 `PoolThreadCache`；即使最终回到 arena，也可能只是让 chunk 的 freeBytes 增加、让它在 PoolChunkList 链中向前移动，而不是销毁。

测试直接暴露了这一点。`PooledByteBufAllocatorTest.expectedUsedMemoryAfterRelease(...)` 明确预期：释放后仍可能保留一个 chunk，因为 qInit 中的 chunk 在迁移到 q000 之前不会释放，见 `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:64`。在这条测试路径里，这种保留属于池化 allocator 为后续分配保留可复用空间的策略结果；仅凭“chunk 仍然存在”本身，还不能直接判定为泄漏或非泄漏。

所以排查内存问题时，不能只看到“释放后 chunk 还存在”就下结论。至少要区分三种情况：

- ByteBuf ownership 没有归零：可能是真正的引用计数泄漏；
- ownership 已归零，但空间在 thread cache 或 chunk 中保留：属于池化保留；
- huge allocation 没有正常销毁：需要检查独立分配路径。

这也是为什么 allocator metrics 不能只看一个 active allocation 数字。cache 中的对象、chunk 的利用率、huge allocation、arena 数量和 pinned memory 都可能影响进程的实际内存表现。

## 收网：池化分配器不是一个池，而是一组按尺度协作的路径

现在可以把总图完整收回来了。

- `PooledByteBufAllocator` 负责 heap/direct arena、线程 cache、page/chunk 参数和整体资源入口；
- `PoolArena` 负责把请求按 `SizeClasses` 分成 Small、Normal、Huge 三条路径；
- `PoolThreadCache` 先尝试在线程本地满足请求，也会影响释放后的归还位置；
- `PoolSubpage` 用 bitmap 管理固定大小的小元素；
- `PoolChunk` 用 page-run 管理中等连续空间，并通过 handle 描述分配位置和粒度；
- `PoolChunkList` 按 chunk 利用率分层，推动 chunk 在不同链之间迁移或最终销毁；
- huge allocation 则跳过池化结构，使用独立 chunk。

因此，一次分配的心智图是：

`allocator -> arena -> thread cache -> size class -> subpage/run/unpooled`

一次释放的心智图则是：

`ByteBuf release -> arena.free -> thread cache 或 subpage/run -> chunk 利用率迁移或销毁`

本篇真正要留下来的结论是：**Netty 池化的核心不是“把内存放进一个池”，而是用不同尺度的结构匹配不同大小和不同生命周期的请求。**small 需要 bitmap 密度，normal 需要连续 run，huge 需要独立分配；thread cache 负责局部复用，chunk list 负责全局利用率，arena 负责把这些路径组织起来。

这张总图也解释了后续所有调优问题应该怎么问。不要笼统地问“池化是不是更快”，而要问：请求主要落在哪个 size class？thread cache 是否命中？arena 是否竞争？chunk 是否在合适的利用率链？释放后的空间停在 cache、subpage、run 还是 huge chunk？只有把问题放回对应层级，参数调整和内存诊断才不会变成盲目试值。