# Ch8-01 池化入口与 Arena — rewrite-plan

## 篇章定位

- 核心困惑：第 4 章已经讲过 ByteBuf 为什么需要引用计数，第 7 章又讲了 pipeline/write 会不停分配和释放 ByteBuf。那 Netty 为什么不满足于“每次 new 一个、用完 release”——为什么还要再建 `PooledByteBufAllocator`、`PoolArena`、`SizeClasses` 这一整套分层入口？
- 一句话顿悟：池化的第一步不是“先讨论 Buddy 算法”，而是先把“请求大小”映射到稳定的 size class，再把小块、整页块和巨大块分流到不同路径；`PoolArena` 正是这条分流与复用入口的核心协调者。
- 篇章边界：重点讲 `PooledByteBufAllocator` 默认参数、Arena 数量、`SizeClasses`、PoolArena 的 `Small/Normal/Huge` 分流与 ChunkList 入口；不深入 `PoolChunk` Buddy 分裂与 `PoolThreadCache` 缓存命中细节，这些留后续篇。

## 依赖

### HARD

- Ch4 ByteBuf：Heap/Direct、capacity/maxCapacity、引用计数、allocator 基本语义。
- Ch7 Pipeline/OutboundBuffer：大量 write/read 会频繁分配和释放 ByteBuf。

### SOFT

- Ch5 EventLoop：arena 数量与线程数默认值有设计呼应，但本篇只把它作为背景。
- OS/JVM 堆外分配成本：只作动机补充，不深入 native malloc 细节。

### NAV

- Ch8-02：PoolChunk、run、handle 编码与 Buddy 分裂/合并。
- Ch8-03：PoolSubpage 与 PoolThreadCache。
- Ch8-04：PooledByteBuf 生命周期和回收路径。

## 素材事实卡片

### 卡片 A：PooledByteBufAllocator 默认值与 arena 数量

- `PooledByteBufAllocator.java:68-91`：`DEFAULT_PAGE_SIZE=8192`、`DEFAULT_MAX_ORDER=9`，默认 chunkSize = pageSize << maxOrder = 4 MiB。
- `PooledByteBufAllocator.java:93-117`：默认 `nHeapArena/nDirectArena` 取 `min(cpu*2, maxMemory/defaultChunkSize/2/3)` 的形式。
- `PooledByteBufAllocator.java:119-183`：small/normal cache、max cached buffer capacity、trim interval 等默认值。
- `PooledByteBufAllocator.java:289-337`：创建 heap/direct arenas，并为各自构造 `SizeClasses`。
- 关键边界：CPU*2 不是池化理论，而是当前默认值；arena 数量受最大内存和 chunkSize 共同约束。

### 卡片 B：SizeClasses 是入口分层而不是实现细枝末节

- `SizeClasses.java:20-45`：类注释已经说明 nSubpages/nSizes/nPSizes/lookup table 等整体结构。
- `SizeClasses.java:97-185`：构造时生成 sizeClasses 表、统计 `nSubpages/nPSizes/lookupMaxSize`，建立 `sizeIdx2sizeTab/pageIdx2sizeTab/size2idxTab`。
- `SizeClasses.java:316-343`：`size2SizeIdx` 把请求大小映射到 sizeIdx；超过 chunkSize 返回 `nSizes`，作为 huge 边界。
- `SizeClasses.java:391-412`：`normalizeSize` 将任意请求归一到 size class。
- 关键叙事：池化系统的第一层不是直接找 chunk，而是先把“任意大小请求”归一到有限的 size class 空间。

### 卡片 C：PoolArena 的三路分流

- `PoolArena.java:38-41`：`SizeClass { Small, Normal }`，Huge 作为 arena 外单独路径。
- `PoolArena.java:45-54`：smallSubpagePools 与 qInit/q000/q025/q050/q075/q100 六段 chunkList。
- `PoolArena.java:129-148`：`allocate(cache, reqCapacity, maxCapacity)` 先 `newByteBuf`，再按 `size2SizeIdx(reqCapacity)` 路由：small / normal / huge。
- `PoolArena.java:150-188`：small 路径先查 thread cache，再查 smallSubpagePool，缺失时回退到 normal allocation。
- `PoolArena.java:191-223`：normal 路径先 thread cache，再按 chunkList 顺序尝试，没有则创建新 chunk 丢到 qInit。
- `PoolArena.java:229-235`：huge 直接 `newUnpooledChunk(reqCapacity)`。
- 关键叙事：PoolArena 不是“内存块本身”，而是“把请求导流到哪条复用路径”的调度器。

### 卡片 D：PoolChunk/PoolSubpage 的位置边界

- `PoolChunk.java:29-137`：类注释完整描述了 run/subpage/chunk 与 handle 编码，说明它承担的是 chunk 内部空间管理。
- `PoolChunk.java:198-220`：初始化时整块 chunk 的 freeBytes = chunkSize，并插入一个“整块可用 run”。
- `PoolSubpage.java:64-85`、`:90-150`：Subpage 把一个 run 切成等长小元素，用 bitmap 管理。
- 关键边界：本篇只借它们说明“small 最终会落到 subpage，normal 最终会落到 run/chunk”，不深入具体分裂/位图流程。

## 理解路径

1. **从“每次 new/free 为什么不够”切入**：出站写和入站读会高频借还 ByteBuf，光靠 allocator 把对象类型选对还不够，必须进一步复用底层内存。
2. **先讲 PooledByteBufAllocator 只是总入口**：先给出 pageSize/maxOrder/chunkSize、heap/direct arena 数量的默认值与边界。
3. **再讲 SizeClasses**：为什么任何请求都先被归一到 size class，而不是直接找一块“刚好够大”的空间。
4. **再讲 Arena 的三路分流**：small -> subpage 池，normal -> chunk list，huge -> unpooled chunk。
5. **最后讲 ChunkList 的角色**：PoolArena 不是亲自分裂 chunk，而是先在不同利用率区间的 chunk list 中找空间，不够再创建新 chunk。
6. **收网**：池化的第一层核心不是算法炫技，而是“请求归一化 + 路径分流 + 复用边界”。

## 失败方案推演

- 每次都分配独立 ByteBuf：正确但高频 read/write 下分配/释放压力大，尤其 direct 内存成本明显。
- 所有请求都直接塞进一个巨大的共享 chunk，不做 size class：小请求会严重浪费，大请求也难以稳定复用。
- 不区分 small/normal/huge：subpage 位图、小块 run、超大块直分配的成本模型完全不同，混在一起会让任一类都不理想。
- arena 不分 heap/direct：两种底层存储的分配/回收路径本就不同，不能靠一个统一容器含糊处理。

## 文章结构与预算

1. 为什么 allocator 之后还需要池化层（1000-1300 字）
2. `PooledByteBufAllocator`：默认参数和 arena 规模（1800-2300 字）
3. `SizeClasses`：先归一请求，再谈分配（2200-2800 字）
4. `PoolArena`：small/normal/huge 三路分流（2200-2800 字）
5. ChunkList / Subpage 只做定位性解释（1400-1800 字）
6. 误解澄清与 Ch8-02/03 桥接（1000-1300 字）

目标：删掉代码后的叙述性正文 9500-11000 字。

## 证据清单

- `PooledByteBufAllocator.java:68-117`
- `PooledByteBufAllocator.java:289-337`
- `SizeClasses.java:20-45`
- `SizeClasses.java:97-185`
- `SizeClasses.java:316-343`
- `SizeClasses.java:391-412`
- `PoolArena.java:38-54`
- `PoolArena.java:129-235`
- `PoolChunk.java:29-137`
- `PoolChunk.java:198-220`
- `PoolSubpage.java:64-150`

## 边界清单

- CPU*2、pageSize=8192、maxOrder=9、chunkSize=4MiB 都是当前默认配置，不外推为所有部署的固定真理。
- 本篇聚焦“入口分流”，不提前展开 Buddy 分裂/位图细节和 thread cache 命中策略。
- `SizeClasses` 只是请求归一化和查表层，不直接等于物理内存布局本身。
- huge 路径当前通过 `newUnpooledChunk` 走不经 cache 的分配，不把它误写成“arena 内也照常复用”。
- 若深审发现 Arena/ChunkList 在边界条件上的真实缺陷候选，按方法论记录 issue 候选。

## 深审预警

- [ ] 不把默认参数写成性能定理。
- [ ] `SizeClass` 枚举只有 Small/Normal，Huge 是外部路径，要讲清。
- [ ] 解释 `size2SizeIdx(reqCapacity) > nSizes` 的 huge 边界时要按当前源码说。
- [ ] 不提前把 PoolChunk Buddy 和 PoolThreadCache 的细节抢到本篇主线。
