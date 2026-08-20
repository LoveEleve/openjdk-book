# 池化入口与 Arena：Netty 为什么不满足于每次都 new / free ByteBuf

> 本文基于当前 Netty `PooledByteBufAllocator`、`SizeClasses`、`PoolArena`、`PoolChunk` 和 `PoolSubpage` 实现。前置：Ch4 ByteBuf 五篇、Ch7 Pipeline 四篇；本文聚焦池化体系的入口分层——默认参数、size class 归一化、Arena 三路分流和 ChunkList 角色，不深入 Buddy 分裂、Subpage 位图和 ThreadCache 命中细节。

## EventLoop 和 Pipeline 都跑起来了，但 ByteBuf 还在一遍遍地借、还、再借

到第 7 章为止，Netty 的 I/O 运行时已经完整闭环：

- EventLoop 知道什么时候驱动 I/O 和任务。
- Pipeline 知道数据流过谁、什么时候 write、什么时候 flush。
- ByteBuf 知道索引、容量、引用计数、视图和 Composite。

但这些机制都默认了一件事：ByteBuf 已经存在。

一旦把视角从“单次操作”拉到“持续运行的服务端”，你会发现另一个高频动作一直在反复发生：

```text
分配 ByteBuf
  -> 写/读/切片/拼接
  -> release
  -> 再分配下一批 ByteBuf
```

如果服务端每秒处理成千上万次 write/read，这条链就不再只是 API 细节，而是资源热点。特别是 direct ByteBuf 的分配、扩容和释放路径，前面已经反复证明它不是“白送”的。

于是问题从“ByteBuf 是什么”变成了：

```text
既然这些缓冲区会被高频借用和归还
为什么不把底层内存复用起来？
```

这就是内存池化的起点。

但一上来就谈 Buddy、位图、缓存，很容易把读者拖进实现细节的海里，看不到入口真正的第一刀落在哪里。当前 Netty 的池化入口其实先做的不是“复杂分配算法”，而是两件更基础的事：

1. 先把任意请求大小归一到有限的 size class。
2. 再把这些 size class 分流到 small / normal / huge 不同路径。

也就是说，池化的第一层主线不是：

```text
我有个神奇的数据结构，能分配所有内存
```

而是：

```text
不是所有请求都值得走同一条分配路径
先把请求分层，复用才有可能稳定成立
```

这正是 `PooledByteBufAllocator`、`SizeClasses` 和 `PoolArena` 这一篇真正要讲的东西。

## 一、为什么 allocator 之后还需要池化层

### 1. Allocator 解决的是“创建哪种 ByteBuf”，池化还要解决“底层内存从哪复用”

第 4 章第二篇已经把 `ByteBufAllocator` 的角色讲清楚了：调用方表达 `buffer()/ioBuffer()/heapBuffer()/directBuffer()` 的意图，allocator 决定实际创建什么实现。

但 allocator 的那一层主要回答的是：

```text
这次要 heap 还是 direct
要 pooled 还是 unpooled
默认容量怎么起
容量不够时往哪里长
```

它还没有深入回答：

```text
如果这是 pooled
那这块底层内存具体从哪个复用结构里来
又按什么粒度复用
```

也就是说，allocator 只是池化世界的门，不是池化世界本身。

### 2. 如果不分层，池化会被两种极端同时拖垮

想象最粗暴的池化做法：服务端里所有 ByteBuf 都从一大块共享内存里切一段出来，用完再塞回去。

这个想法看起来简洁，实际会立刻撞上两个相反方向的问题：

- 32B、128B、1KB 这类小请求，如果都按页或整块切，会浪费大量空间。
- 1MB、4MB、10MB 这种大请求，如果也走同样的小块复用策略，管理成本和碎片都会迅速放大。

也就是说，“池化”本身不是答案。真正的问题是：

```text
不同大小的请求
应该先被划到哪一类，再决定怎么复用
```

这就是 Netty 为什么把池化入口做成“总入口 -> 大小归一 -> 路径分流”的三层结构，而不是一个单一容器包打天下。

## 二、`PooledByteBufAllocator`：总入口先决定默认参数和 Arena 规模

### 1. pageSize / maxOrder / chunkSize 是当前池化世界的默认基线

`PooledByteBufAllocator` 的静态初始化里，当前默认页大小是 8192，默认 `maxOrder` 是 9，最终默认 chunkSize 就是：

```text
chunkSize = pageSize << maxOrder = 8192 << 9 = 4 MiB
```

源码见 `PooledByteBufAllocator.java:68-91`，日志里也会打印 `chunkSize`，见 `PooledByteBufAllocator.java:160-173`。

这三个值的关系很重要，但必须加上版本/配置边界：它们是当前默认值，不是不可更改的协议真理。Netty 允许通过系统属性调整 pageSize 和 maxOrder，只是默认恰好落在这个组合上。

所以本篇不该把“4 MiB”写成神秘常数，而应该理解为：

```text
当前默认池化布局以 8KB 页和 4MiB chunk 为起点
后续所有 size class / subpage / run 的讨论都围绕这个默认坐标展开
```

### 2. Arena 数量不是简单等于 CPU，也不是随便给个固定数

`PooledByteBufAllocator` 在初始化时会推导 `DEFAULT_NUM_HEAP_ARENA` 和 `DEFAULT_NUM_DIRECT_ARENA`。公式大意是：

- 默认起步以 `availableProcessors() * 2` 作为一个上界候选。
- 再用“每个 arena 假设有 3 个 chunk，池化不应消耗超过一半内存”的估算，把 arena 数压到最大内存或最大 direct memory 所允许的范围内。

源码见 `PooledByteBufAllocator.java:93-117`。

这说明 Arena 数量不是纯粹的 CPU 参数，也不是纯粹的内存参数，而是二者共同约束下的默认折中。

这里也要谨慎：不要把它写成“这就是最优 arena 数”。源码能证明的只是当前默认策略想达到两个目标：

```text
arena 不要少到明显竞争
也不要多到预留 chunk 把可用内存吃掉太多
```

### 3. Pooled allocator 一上来就同时建 heap 和 direct 两套 arena

构造函数里，如果 `nHeapArena > 0`，就为 heap 建一组 `PoolArena.HeapArena`；如果 `nDirectArena > 0`，就为 direct 建一组 `PoolArena.DirectArena`。并且两边都会各自构造一份 `SizeClasses`，只是在 direct 侧会把 `directMemoryCacheAlignment` 带进去，见 `PooledByteBufAllocator.java:289-337`。

这说明池化不是“先有一套统一算法，再顺便支持 heap/direct”，而是从入口层就承认：

```text
heap 和 direct 的底层存储不同
但它们在“如何按 size class 分层、如何按 arena 复用”这件事上
仍然共享一套大框架
```

因此本篇后面会反复强调：Arena 是路径分流者，不是某一种内存类型本身。

## 三、`SizeClasses`：池化世界的第一层不是找内存，而是先把请求“翻译”成有限档位

### 1. 任何任意大小请求，如果不先归一，就无法稳定复用

假设调用方要 33B、37B、41B、45B、49B …… 如果池化系统对每个原始大小都维护一套独立复用单元，几乎等于没有池化，因为每种尺寸的命中率都很低，管理结构却极其分散。

所以池化的第一步必须是：

```text
把“任意字节数请求”归一化到一组有限的 size class
```

这就是 `SizeClasses` 的工作。类注释开头其实已经把职责写得很清楚：它生成 size class 表，统计 `nSubpages`、`nSizes`、`nPSizes`，并维护 `sizeIdx2size`、`size2idx`、`pageIdx2size` 等查表结构，见 `SizeClasses.java:20-45`。

### 2. `sizeIdx` 是池化体系里真正稳定的中间语言

`SizeClasses` 在构造时会生成一整张 sizeClasses 表，再统计：

- 一共有多少个 size class（`nSizes`）
- 其中多少个属于 subpage（`nSubpages`）
- 多少个恰好是 pageSize 的倍数（`nPSizes`）
- lookup table 能覆盖到多大的请求（`lookupMaxSize`）

见 `SizeClasses.java:97-185`。

这意味着在池化体系里，“33B”“40KB”“2MB”这些原始请求值，并不是后续模块长期直接交流的语言。更稳定的中间语言是：

```text
这个请求对应哪个 sizeIdx
这个 sizeIdx 对应哪种归一化大小
它是 subpage 还是 page/run 级别
```

这让后续分配路径可以按离散档位处理，而不必每次都从原始字节数开始推导。

### 3. `size2SizeIdx` 把 huge 请求也明确分出来了

`size2SizeIdx(size)` 会先处理 size=0；如果 size 超过 chunkSize，就直接返回 `nSizes`，见 `SizeClasses.java:316-343`。

这点很重要。它说明 huge 不是在后面某个 arena 里“再看情况决定”的，而是在 size class 翻译阶段就已经被隔离出来了：

```text
size <= chunkSize
  -> 进入 small / normal 的 sizeIdx 空间

size > chunkSize
  -> 直接落到 huge 边界之外
```

所以 huge 不是 `SizeClass` 枚举中的第三个值，而是“不再进入常规 sizeIdx 范围”的外部路径。这个边界一定要在正文里讲准，否则后面 Arena 分流会被讲乱。

### 4. 归一化不是为了漂亮，而是为了复用稳定

`normalizeSize(size)` 的作用，就是把任意请求提升到最近的可用 size class 大小，见 `SizeClasses.java:391-412`。

这会带来一个看似“浪费”的现象：你要 33B，可能实际拿到 48B 或 64B；你要略大于某个边界的值，可能被抬到下一个档位。

但这正是复用稳定性的来源。池化系统需要的是：

```text
我宁可为少量请求多给一点对齐/档位冗余
也要把大量请求收敛到有限规格上
这样缓存、arena、subpage、chunk 才有稳定命中机会
```

所以 normalized size 的本质不是“精确”，而是“可复用”。

## 四、`PoolArena`：真正的入口协调者，不是内存块本身

### 1. Arena 的角色不是“这块内存”，而是“把请求导向哪条路径”

`PoolArena` 内部维护了：

- `smallSubpagePools`
- 六段 `PoolChunkList`：`qInit/q000/q025/q050/q075/q100`
- 统计字段
- `SizeClasses sizeClass`

见 `PoolArena.java:38-54`、`:80-112`。

光看字段名就能看出，它不像一个单独的 chunk，更像一个调度中枢：小块有 subpage 池，正常块有 chunk lists，超大块还有独立路径。

这就是 Arena 的第一层本质：

```text
Arena 不是“具体内存单元”
而是“根据 size class 决定下一步去哪”的入口协调者
```

### 2. 当前 `SizeClass` 枚举只有 Small 和 Normal

`PoolArena.SizeClass` 只有两个枚举值：`Small` 和 `Normal`，见 `PoolArena.java:38-41`。

这点看起来细小，实际上非常重要。因为它说明：Huge 在 Arena 内部不是一个和 Small/Normal 对称的枚举分支，而是一个 arena 正常复用路径之外的特殊处理。

于是 Arena 的分流主线其实是：

```text
small  -> 走 subpage 池 / 小块路径
normal -> 走 chunk list / run 路径
huge   -> 跳出常规池化复用，单独处理
```

如果正文把 Huge 写成 `SizeClass.Huge`，就会直接和当前源码事实冲突。

### 3. `allocate(...)` 真正的第一步就是按 sizeIdx 分三路

`PoolArena.allocate(cache, reqCapacity, maxCapacity)` 会先创建一个 `PooledByteBuf` 容器，再进入私有 `allocate(cache, buf, reqCapacity)`。这一步首先调用：

```text
sizeIdx = sizeClass.size2SizeIdx(reqCapacity)
```

然后分三路：

- `sizeIdx <= smallMaxSizeIdx` -> small
- `sizeIdx < nSizes` -> normal
- 否则 -> huge

见 `PoolArena.java:127-148`。

这条分流正好把前一节 `SizeClasses` 的结果真正用起来：size class 不只是分类表，而是 Arena 路由的直接输入。

所以最小总图就是：

```text
reqCapacity
  -> size2SizeIdx
  -> small / normal / huge
  -> 各自进入不同复用路径
```

### 4. small：先看 thread cache，再看 subpage 池，不行就退到 normal

small 路径会先问 `PoolThreadCache` 能不能分配；命中就直接返回。没命中时，再去对应 `smallSubpagePools[sizeIdx]` 的链表头下找可用 subpage；如果连 subpage 池也没有合适项，才退回到 normal allocation，见 `PoolArena.java:150-188`。

这个路径很值得注意，因为它说明 small 并不是“永远只在 subpage 里找”。真实策略是：

```text
cache 命中最便宜
不命中 -> subpage 池里找
subpage 也没得给 -> 向 normal 要一段 run，再切成 subpage
```

这也解释了为什么本篇要把 thread cache 放到后面再展开：即使不读它的细节，也能先看清 small 路径的层级关系。

### 5. normal：先在现有 chunk lists 里找，再考虑新建 chunk

normal 路径同样先看 thread cache；不命中后，进入 `allocateNormal(...)`。当前实现会按 `q050 -> q025 -> q000 -> qInit -> q075` 的顺序尝试现有 chunk list，任何一段分配成功就返回；如果都失败，才新建一个 chunk，先在这个 chunk 上分配，再把 chunk 放进 `qInit`，见 `PoolArena.java:191-223`。这里要注意，这是一条当前实现顺序，不应被外推成“所有池化分配器都必须按利用率从低到高或从高到低搜索”的抽象规范。

这说明 Arena 对 normal 的策略不是“每次都新建 chunk”，而是：

```text
先在现有 chunk 池的不同利用率区间里找空间
实在找不到，再创建新 chunk
```

所以 ChunkList 的第一层角色不是“为了好看分六段”，而是把 chunk 按利用率分层，让 Arena 更可能在合适的复用区间里找到位置。

### 6. huge：直接走 unpooled chunk

huge 路径会按 `normCapacity = reqCapacity`（或带对齐后的 normalized 值）直接调用 `allocateHuge(buf, normCapacity)`；它内部创建的是 `newUnpooledChunk(reqCapacity)`，见 `PoolArena.java:142-147`、`:229-235`。

这说明 huge 的语义非常明确：

```text
太大了
  -> 不再走常规 cache / subpage / chunk list 复用
  -> 直接给一块独立 chunk
```

也就是说，池化系统在 huge 场景下宁愿承认“这次不适合常规复用”，也不强行把超大请求塞进同一套小块/整页管理结构。

## 五、`PoolChunk` 和 `PoolSubpage` 在本篇里各自只占一个位置

### 1. `PoolChunk` 解释的是“chunk 内怎么把 run 管起来”

`PoolChunk` 的大段类注释已经把 page、run、chunk、handle 编码、可用 run 管理和 subpage 分配流程讲得很详细，见 `PoolChunk.java:29-137`。构造时它会把整块 chunk 视作一个初始可用 run，`freeBytes = chunkSize`，并插入可用结构，见 `PoolChunk.java:198-220`。

在本篇里，`PoolChunk` 的定位只需要记住一句：

```text
Arena 找到了“该去哪类 chunk”以后
Chunk 再负责 chunk 内部的 run/subpage 具体空间管理
```

也就是说，Chunk 解决的是“这块 4MiB 左右的大块内部怎么切”，不是“请求到底该不该先归到这个路径”。

### 2. `PoolSubpage` 解释的是“小块如何塞进一个 run”

`PoolSubpage` 会把一个 run 切成等长小元素，用 bitmap 记录哪些槽位已占用，见 `PoolSubpage.java:64-150`。当没有可用元素时，它会从 pool 链上摘掉；当元素被释放又从 0 变成非满时，再重新挂回池头。

它的定位也只需要记住一句：

```text
small 路径不是直接给你整页
而是把某个 run 再切成更小的等长单元来复用
```

这正好和前面的 Arena 分流闭环：

- Arena 决定你属于 small。
- subpage 才决定 small 里的具体位图槽位。

本篇不再把位图操作深入展开，留给下一篇更细讲。否则会把“入口分流”主题稀释掉。

## 六、最容易错的五个判断

### 1. 池化的核心就是 Buddy 算法

不完整。Buddy/位图是 chunk 内部的具体分配技术；在它之前，Netty 先要解决“请求大小如何归一、走哪条路径、从哪个 Arena/ChunkList 里找”。

### 2. huge 也是 Arena 的一个普通 `SizeClass`

不成立。当前 `PoolArena.SizeClass` 只有 `Small` 和 `Normal`；Huge 是 sizeIdx 超出常规范围后的单独路径。

### 3. `PooledByteBufAllocator` 的默认参数就是最优参数

不成立。`pageSize=8192`、`maxOrder=9`、`chunkSize=4MiB`、`arena≈cpu*2` 都是当前默认值，不是通用性能定理。

### 4. `normalizeSize` 是为了精确匹配用户请求

不成立。它恰恰会把任意请求抬到有限档位，以换取稳定复用和查表路径。

### 5. small / normal / huge 只是名字不同，本质一样

不成立。当前实现里 small 会走 cache/subpage 路径，normal 走 chunk list/run 路径，huge 则直接 new unpooled chunk，成本模型完全不同。

## 收网：池化的第一层，不是“怎么切内存”，而是“先把请求分好类”

现在可以回到开篇的问题：为什么 Netty 不满足于每次都 new / free ByteBuf？

因为一旦 ByteBuf 进入 EventLoop、Pipeline 和写缓冲区的高频路径，分配/释放本身就会变成性能与资源热点。而“池化”如果不先把请求分层，只会把所有复杂度堆进一个大容器里，既难命中，又难管理。

当前实现给出的第一层答案是：

```text
PooledByteBufAllocator
  -> 决定默认页大小、chunk 大小、arena 规模

SizeClasses
  -> 把任意请求归一到有限档位

PoolArena
  -> 根据 sizeIdx 把请求分流到 small / normal / huge

PoolChunk / PoolSubpage
  -> 分别处理大块内部 run 和小块位图分配
```

所以 Ch8-01 最该带走的结论不是“Netty 有内存池”，而是：

```text
内存池化的第一层核心
不是先谈复杂分配算法
而是先把请求归一，再把路径分流
```

下一篇进入 `PoolChunk` 与 Buddy。因为本篇已经决定了某个请求该落到 normal 路径，接下来真正要回答的是：这块 chunk 内部到底怎么切 run、怎么编码 handle、怎么在释放时合并回去。