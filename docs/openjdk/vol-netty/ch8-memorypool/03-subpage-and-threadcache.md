# Subpage 与 ThreadCache：为什么小块分配不该每次都回 Arena 抢锁

> 本文基于当前 Netty `PoolSubpage`、`PoolThreadCache` 与 `PooledByteBufAllocator` 实现。前置：Ch8-01 `01-allocator-and-arena.md`、Ch8-02 `02-chunk-and-buddy.md`；本文解释 small 分配的页内位图、thread-local cache 的 small/normal 路径和 trim 机制，不展开 Recycler 与 PooledByteBuf 生命周期。

## normal 已经能从 Chunk 切 run，为什么 small 还不够

上一节已经把 `PoolChunk` 的主线讲清楚了：

- Arena 先把请求归到 small / normal / huge。
- normal 通过 `allocateRun` 在 chunk 里切一段连续 run。
- huge 直接跳出去单独分配。

可 small 路径比 normal 多了一层难题：

```text
512B、128B、64B 这样的请求
如果每次都直接占整页
浪费会非常严重
```

一个 page 默认是 8KB。要一个 128B buffer，如果直接借整页，绝大部分空间都白白闲着。于是当前实现选择的是：

```text
先向 Chunk 借一段 run
再把这段 run 切成很多等长小元素
用位图管理这些元素
```

这就是 `PoolSubpage` 的角色。

但到这里问题又没有结束。就算你已经能把一页切成 64 个、128 个小块，如果每次 128B 分配都还要回到 Arena 走一遍锁、ChunkList、run/subpage 结构，那高频小对象路径仍然会很重。

所以 Netty 又在 Subpage 之上加了一层 `PoolThreadCache`：

```text
Arena/Subpage 解决“从哪块底层内存切”
ThreadCache 解决“常见请求尽量别每次都回去抢那把锁”
```

这篇文章的主线就围绕这两层展开：

1. 小块页内到底怎么用位图找空位。
2. 为什么 90% 的 small/normal 分配希望先命中线程本地 cache。

## 一、`PoolSubpage`：一页之内，真正被分配的是哪个 bit

### 1. Subpage 不是“更小的 chunk”，而是 run 内部的第二层切分器

上一节已经看到，small 路径不是直接从 Arena 得到一个小对象，而是先由 `PoolChunk.allocateSubpage(sizeIdx, head)` 借到一段 run，再基于这段 run 创建 `PoolSubpage`，最后由 `subpage.allocate()` 返回带 `bitmapIdx` 的 handle。

所以 `PoolSubpage` 的定位必须先摆正：

```text
Arena 负责把请求分流到 small
Chunk 负责先给 small 借一段 run
Subpage 负责在这段 run 里切出更小的等长元素
```

它不是独立于 Chunk 之外的另一套总分配器，而是 page/run 管理之后的页内二级分配器。

### 2. 一个 Subpage 一开始就知道“这页能切成多少块”

`PoolSubpage` 构造函数接收 head、chunk、pageShifts、runOffset、runSize、elemSize。它会立刻算出：

- `maxNumElems = runSize / elemSize`
- `numAvail = maxNumElems`
- `bitmapLength` 需要多少个 `long`
- `nextAvail = 0`

然后把自己挂进所在大小类的 subpage 池头，见 `PoolSubpage.java:64-85`。

这说明一个 subpage 从诞生开始，就已经不是“随便切着看”的弹性结构，而是：

```text
这一段 run 将被切成固定 elemSize 的若干格子
每个格子由一个 bitmap bit 表示
```

因此它和普通堆上的“小对象池”很不一样：它从一开始就绑定了某一个大小类，而不是可以在运行中自由改变每格大小。

### 3. `allocate()` 的核心是“找一个空 bit，然后把它置 1”

`PoolSubpage.allocate()` 的主线非常直接：

1. 如果 `numAvail == 0` 或者 `doNotDestroy == false`，直接失败。
2. 调 `getNextAvail()` 取得一个空闲 bitmapIdx。
3. 计算这是 `bitmap` 数组里的哪一个 `long`、哪一个 bit。
4. 把对应 bit 置 1。
5. `numAvail--`。
6. 如果刚好变成 0，就把这个 subpage 从 pool 链中摘掉。

见 `PoolSubpage.java:90-112`。

这条路径说明 small 分配真正的“命中点”不是对象，不是列表节点，而是一个 bit：

```text
找到空 bit
  -> 置 1
  -> 这个 elem 从现在起属于某个 ByteBuf
```

所以 Subpage 的时间复杂度核心不在“创建多少对象”，而在“多快找到下一个 0 bit”。

### 4. 当前实现先走 `nextAvail` 快路径，再手写扫描 bitmap

大纲里很容易沿用一种旧说法：`getNextAvail()` 靠 `Long.numberOfTrailingZeros(~bits)` 一步找出空位。当前这份源码不是这样写的。

`getNextAvail()` 先看 `nextAvail`；只要它是非负，直接返回，并把 `nextAvail` 设回 -1。只有快路径没有可用值时，才进入 `findNextAvail()` 扫描整个 bitmap 数组，再在 `findNextAvail0()` 里逐 bit 向右移检查，见 `PoolSubpage.java:173-205`。

所以当前实现的真实逻辑是：

```text
如果上次 free 已经告诉我“这里有个刚空出来的位置”
  -> 先直接复用它

否则
  -> 按 word 扫 bitmap
  -> 在某个非满 word 里逐 bit 找第一个 0
```

这比“每次都全图扫描”便宜，也比“旧资料里的 trailingZeros 版本”更贴近当前实现事实。正文必须按这个版本讲，不然读者会拿着错误源码模型去读现有代码。

### 5. 为什么满了要从 pool 链上摘掉

当 `numAvail` 递减到 0 时，`allocate()` 会把当前 subpage 从 pool 链表中摘掉，见 `PoolSubpage.java:107-109`。

这一步很关键。small 分配在下一次从 Arena 的 `smallSubpagePools[sizeIdx]` 查找现成 subpage 时，只想看到“还有空位的 subpage”。一个已经满员的 subpage 继续留在可用链上，只会让后续查找反复撞到死胡同。

所以 pool 链的语义其实非常具体：

```text
这不是“所有 subpage 的总表”
而是“当前这个大小类里仍然可继续分配 elem 的 subpage 表”
```

## 二、free 一个小块，不等于立刻把整页还给 Chunk

### 1. free 的第一步只是把那个 bit 清掉

`PoolSubpage.free(head, bitmapIdx)` 会先算出位图里的 q/r，把对应 bit 从 1 清回 0，然后 `setNextAvail(bitmapIdx)`，见 `PoolSubpage.java:118-125`。

这说明一个小块释放时，最直接的结果只是：

```text
这个 elem 可以再次被分配了
```

它还远没到“整页可以回收”的阶段。

### 2. 从 0 可用变成 1 可用时，要重新挂回 pool

如果释放前 `numAvail == 0`，这意味着这个 subpage 原来是满的、并且已经从 pool 链摘掉了。此时 free 会把它重新 `addToPool(head)`，见 `PoolSubpage.java:126-135`。

这就形成了一个清晰的状态转换：

```text
满员 -> 不在可分配链里
释放一个 elem -> 重新回到“可继续分配”的链里
```

所以 free 对 subpage pool 的影响，不只是改变位图，还会改变“这个 subpage 现在是否对后续分配可见”。

### 3. 什么时候整段 run 才能真的回到 Chunk

只有当 `numAvail == maxNumElems`，也就是整段 subpage 全空了，free 才会进入“这整段 run 是否可以彻底回收”的判断。但它还要再看一个边界：如果这个 subpage 在 pool 链里是唯一剩下的那个节点（`prev == next`），就先不销毁；否则才会把 `doNotDestroy` 设为 false，并把自己从池里移除，返回 false，见 `PoolSubpage.java:137-150`。

这说明 small 释放的完整语义是分层的：

```text
释放一个 elem
  -> 先恢复这个 elem 的可分配性

只有整段 subpage 全空
  -> 才有资格让对应 run 回到 Chunk 层继续 free/merge
```

也正因为如此，上一节才强调：small free 不能简单理解成“把 run 标回空闲”。Subpage 先要把页内状态管理完，Chunk 才接手 run 级回收。

## 三、光有 Subpage 还不够：没有 ThreadCache，每次都得回 Arena 抢锁

### 1. page 内切分解决了空间浪费，但没解决热点争用

到这里，small 路径至少已经足够节省空间了：512B、128B、64B 不会再每次都占一整页。

但如果每次分配都还要走：

```text
EventLoop / 业务线程
  -> PoolArena
  -> smallSubpagePools / Chunk
  -> 锁
  -> 再回到 PooledByteBuf
```

那热点仍然很明显：高频、小而稳定的请求会反复回到同一套共享结构，线程之间继续争用 Arena 锁。

所以 Netty 又在 Arena 前面加了一层更激进的假设：

```text
同一条线程刚刚释放过某个 size class 的块
下一次再要同类块的概率很高
```

这就是 `PoolThreadCache` 的存在理由。它不是为了替代 Arena，而是为了让最常见的命中路径尽量先停在线程本地，不必每次都回到共享池。

### 2. 当前 ThreadCache 分成四组 cache，而不是一个通用 Map

`PoolThreadCache` 保存：

- `smallSubPageHeapCaches`
- `smallSubPageDirectCaches`
- `normalHeapCaches`
- `normalDirectCaches`

见 `PoolThreadCache.java:49-58`。

这说明 ThreadCache 的第一层分维，不是“按所有请求统一建一张表”，而是先按：

```text
heap / direct
small / normal
```

分成四组。Huge 不在这里缓存。因为 huge 本来就不走常规缓存复用路径。

所以 ThreadCache 的角色非常聚焦：

```text
替 high-frequency 的 small / normal 请求提供 thread-local 快路径
```

### 3. 默认不是所有线程都有满配 cache

`PooledByteBufAllocator.PoolThreadLocalCache.initialValue()` 会先为当前线程选出 least-used 的 heap/direct arena，然后判断：

- `useCacheForAllThreads` 是否开启；
- 当前线程是不是 `FastThreadLocalThread`；
- 当前线程是不是某个 `EventExecutor` 线程。

只有这些条件满足时，才创建正常大小的 `PoolThreadCache`；否则创建一个 cache size 全是 0 的“无缓存”版本，见 `PooledByteBufAllocator.java:523-551`。

这点特别重要，因为它说明 thread-local cache 不是默认无上限扩散到所有线程的。当前实现承认：

```text
不是每条线程都值得养一套本地缓存
尤其是那些不常分配 ByteBuf 的普通线程
```

这也是一种资源平衡：多给一点局部命中率，就可能多占一些常驻内存。只有真正高概率受益的线程，才默认启用缓存。

## 四、`MemoryRegionCache`：ThreadCache 命中路径为什么几乎不碰 Arena

### 1. cache 命中路径的关键是“poll 一个条目，然后直接 initBuf”

`PoolThreadCache.allocateSmall/allocateNormal` 最终都会落到一个私有的 `allocate(cache, buf, reqCapacity)`。如果 cache 为 null，直接 miss；否则就 `queue.poll()` 取出一个 Entry，调用 `initBuf(...)` 把目标 `PooledByteBuf` 初始化好，再回收这个 Entry 对象，见 `PoolThreadCache.java:143-187`、`:328-460`。

这意味着 thread-local 命中路径真正省掉的是：

- 不再回 Arena 走锁。
- 不再重新查 `smallSubpagePools` 或 chunk lists。
- 不再重新从 chunk 结构里寻找可用 run。

它仍然要重新初始化目标 PooledByteBuf，但这已经是远比共享结构查找更轻的本地操作。

### 2. `MemoryRegionCache` 不是无限队列，而是固定容量 MPSC

`MemoryRegionCache` 构造时会把配置的 cache size 先对齐到下一个 2 次幂，再创建一个固定容量的 `newFixedMpscUnpaddedQueue(size)`，见 `PoolThreadCache.java:328-338`。

这说明 thread cache 不是“想存多少存多少”。它的设计非常明确：

```text
缓存容量有上限
满了就不能再继续囤
```

这和前几章的所有设计取向都一致：Netty 不会为了局部快路径把资源边界完全放开。

### 3. 放不进 cache，就立即回退给 Arena

`PoolThreadCache.add(...)` 会找到对应的 cache；如果 cache 不存在、线程缓存已 freed，或者 `queue.offer(entry)` 失败，就返回 false。上层看到 false 后，就继续把这块内存走 `arena.free(...)` 归还共享池，见 `PoolThreadCache.java:175-187`、`:349-359`。

所以 thread cache 的策略不是“必须缓存成功”，而是：

```text
能留在线程本地就留
留不下就立刻回共享池
```

这条回退路径确保缓存层永远只是加速器，不会变成资源黑洞。

### 4. small/normal cache 的索引方式不同

`cacheForSmall(area, sizeIdx)` 对 small 直接用 `sizeIdx` 取缓存槽；`cacheForNormal(area, sizeIdx)` 则先减去 `nSubpages` 再索引，因为 normal 的 sizeIdx 空间是整体表里的后半段，见 `PoolThreadCache.java:273-293`。

这看起来像小细节，实际上再次证明了第一篇的结论：池化系统真正稳定的中间语言是 sizeIdx，而不是原始字节数。ThreadCache 只是在不同类型路径上对这份索引做了不同切片。

## 五、trim：本地缓存不是永远增长，而是按热度粗粒度回收

### 1. trim 触发不是“全局每 8192 次”，而是本地计数达到阈值

大纲里很容易把 trim 讲成“每 8192 次分配就清理一次”，好像全局只有一个计数器。当前源码不是这样。

`PoolThreadCache.allocate(...)` 每次命中后会 `allocations++`；如果达到 `freeSweepAllocationThreshold`，就把本地计数清零并执行 `trim()`，见 `PoolThreadCache.java:163-167`。

这说明 trim 的核心不是全局节拍，而是：

```text
当前这个 thread cache
已经发生了足够多次本地分配
现在该检查哪些缓存槽不够热
```

所以它是每个 thread cache 自己的热度周期，不是全局 allocator 的统一节拍器。

### 2. trim 不是逐 entry LRU，而是按“这轮用了多少”粗粒度释放

`MemoryRegionCache.trim()` 的核心非常简单：

```text
free = size - allocations
allocations = 0
if (free > 0) {
    free(free, false)
}
```

见 `PoolThreadCache.java:401-408`。

这意味着：

- 如果这一轮分配几乎把这个 cache 用满了，说明它很热，trim 释放得就少。
- 如果这一轮几乎没怎么命中这个 cache，说明它不够热，就按差值释放更多条目。

这不是精细的 per-entry LRU，也不记录每个条目的时间戳。它是一种更粗粒度、更便宜的近似热度回收。

所以 trim 最重要的设计感在于：

```text
我不试图精确回答“哪个 entry 最老”
我只回答“这个 size class 的队列最近热不热”
```

### 3. 除了分配计数触发，还可以按时间周期 trim

`PooledByteBufAllocator.PoolThreadLocalCache.initialValue()` 里，如果 `DEFAULT_CACHE_TRIM_INTERVAL_MILLIS > 0` 且当前线程有 executor，就会让 executor 定期 `scheduleAtFixedRate(trimTask, ...)`，见 `PooledByteBufAllocator.java:541-547`。同时，allocator 也提供 `trimCurrentThreadCache()` 主动触发入口，见 `PooledByteBufAllocator.java:763-769`。

这说明 trim 不只有一种触发方式：

- 本地 allocations 计数到阈值 -> 被动触发
- executor 定时任务 -> 周期触发
- 外部主动调用 -> 显式触发

它们共同服务于同一个目标：不要让 thread-local cache 因为“曾经热过”就永久囤住那一堆块。

## 六、最容易错的五个判断

### 1. `PoolSubpage` 每次都用某种单条 CPU 指令瞬间找到空位

不成立。当前实现先走 `nextAvail` 快路径；否则再按 `long` word 和 bit 手写扫描 bitmap。不能沿用旧资料里的 `Long.numberOfTrailingZeros` 叙事。

### 2. small 分配就是直接查位图，不需要先借 run

不成立。small 路径先由 Chunk 借一段 run，再由 PoolSubpage 在这段 run 里做位图切分。

### 3. ThreadCache 命中就是“完全免费”

不成立。它确实绕开了 Arena 锁和共享结构查找，但仍然需要 poll queue、initBuf 和 Entry 回收。

### 4. 每个线程默认都有完整 thread-local cache

不成立。当前实现会根据线程类型和配置决定是否启用满配 cache；不满足条件时，会创建 0-size 的无缓存版本。

### 5. trim 是精确 LRU 垃圾回收

不成立。它是按 cache 级别、按“这轮用了多少”进行的粗粒度释放，不是逐 entry 的精确年龄排序。

## 收网：Subpage 解决“页内怎么切”，ThreadCache 解决“常见请求怎么别总回共享池”

现在可以回到这一篇真正的问题：small 分配为什么还要再拆两层？

当前实现的答案非常清楚：

```text
PoolSubpage
  -> 解决 run 内部如何切成很多等长小元素
  -> 用 bitmap + pool 链维护页内可用性

PoolThreadCache
  -> 解决 small/normal 高频请求如何先在线程本地命中
  -> 用固定容量 cache 队列减少 Arena 锁竞争
```

它们并不重复，而是恰好站在两个不同层面：

- Subpage 解决的是空间切分粒度。
- ThreadCache 解决的是共享结构访问频率。

所以 Ch8-03 最该带走的结论不是“Netty 用了位图和线程缓存”，而是：

```text
small 对象池化要同时解决两件事
一是页内别浪费
二是高频命中别总回去抢共享锁
```

下一篇进入 `PooledByteBuf` 生命周期。因为到这里为止，我们已经知道内存怎么被切出来、怎么被缓存起来，但还没讲清对象自己什么时候从 Recycler 借来、什么时候把内存还回 arena、什么时候把对象壳子还回 Recycler，以及派生视图为什么要“先回收自己，再 release parent”。