# Ch8-05 池化分配器总图：Allocator、Arena、Chunk、Subpage 与 ThreadCache — rewrite-plan

## 篇章定位

- 核心困惑：Netty 的 `PooledByteBufAllocator` 为什么不是“维护一个大 byte[]，切一块给你”这么简单？`arena`、`chunk`、`page`、`run`、`subpage`、`PoolChunkList`、`PoolThreadCache` 分别解决什么问题？一次 `allocator.buffer()` 到底经过哪条路径？
- 一句话顿悟：Netty 把池化分配拆成多级尺度：allocator 先选择 heap/direct arena，arena 先让 thread cache 尝试命中；未命中时，小对象进入 subpage 位图，中等对象进入 chunk 的 page-run，chunk 再按利用率在多条 `PoolChunkList` 之间移动；超大对象跳过池化直接分配。释放时则反向经过 thread cache、subpage/run 和 chunk 回收。
- 文章边界：本篇建立池化分配总图，主讲 allocator -> arena -> thread cache -> size class -> subpage/run -> chunk list 的职责和路径，解释 small/normal/huge 三类分配、chunk 利用率迁移和释放回收；不深入 buddy/run 搜索的全部位运算、不深入 `PoolThreadCache` 每种 cache 数组实现、不重复 Ch5-03 的 FastThreadLocal/Recycler 原理。

## 依赖

### HARD

- Ch4-02 `ch4-bytebuf/02-allocator-system.md`：理解 ByteBuf allocator 入口和容量选择。
- Ch4-06 `ch4-bytebuf/06-ownership-and-reference-counting.md`：理解释放不是 GC 自动行为，池化对象归还也受 ownership 驱动。
- Ch5-03 `ch5-eventloop/03-fastthreadlocal-and-recycler.md`：理解 thread-local 复用基础设施，但本篇只复用结论，不重讲实现。

### SOFT

- Ch4-03 heap/direct：理解 heap arena 和 direct arena 的差异。
- Ch8-01~04：已有 allocator、chunk/buddy、subpage/threadcache、pooledbuf lifecycle 篇章作为局部前置；本篇负责把它们重新串成总图。

### NAV

- 后续：Allocator metrics / pinned memory / direct memory 诊断。
- 后续：池化参数调优与真实基准验证。

## 素材事实卡片

### 卡片 A：Allocator 先决定 arena 和 thread cache

- `PooledByteBufAllocator` 默认计算 heap/direct arena 数量、pageSize、maxOrder、cache size、trim interval、是否对所有线程启用 cache。
- allocator 持有 `heapArenas`、`directArenas`、`PoolThreadLocalCache`、chunkSize。
- 结论：池化总图的最上层不是 chunk，而是 allocator 的 arena 选择和线程缓存入口。

### 卡片 B：Arena 把请求分成 Small / Normal / Huge

- `PoolArena.allocate(...)` 先通过 `SizeClasses.size2SizeIdx(reqCapacity)` 得到 sizeIdx。
- sizeIdx <= smallMaxSizeIdx：small 路径，优先 thread cache，未命中走 subpage。
- sizeIdx < nSizes：normal 路径，优先 thread cache，未命中走 PoolChunkList。
- 其余：huge 路径，跳过 cache，直接 `allocateHuge` 创建 unpooled chunk。
- 结论：三类分配不是名称分类，而是三条不同的物理路径。

### 卡片 C：Chunk 是 page/run 的统一大容器

- `PoolChunk` 注释明确：page 是最小单位，run 是 page 集合，chunk 是 run 集合。
- `runsAvailMap` 保存可用 run 边界，`runsAvail` 用优先队列管理不同大小的可用 run。
- run 分配会切分空闲 run；释放会合并连续空闲 run。
- handle 编码 runOffset、run pages、used/subpage 标志和 subpage bitmap index。

### 卡片 D：Subpage 处理小对象，不和 normal run 混为一谈

- `PoolSubpage` 用 bitmap 管理一个 page/run 内的固定大小元素。
- allocate 从 bitmap 找空闲元素，numAvail 归零时从 subpage pool 移除。
- free 后重新加入 pool；完全空闲时根据是否为 pool 中唯一 subpage 决定保留或销毁。
- 结论：small 分配的粒度是 subpage element，normal 分配的粒度是 page run。

### 卡片 E：PoolChunkList 按利用率迁移 chunk

- Arena 创建 `qInit/q000/q025/q050/q075/q100` 六条利用率链。
- allocate 后若 freeBytes 低于阈值，chunk 向利用率更高的 next list 移动。
- free 后若 freeBytes 高于阈值，chunk 向利用率更低的 prev list 移动；完全空闲且没有前置 list 时可销毁。
- 结论：chunk list 不是六个独立池，而是同一批 chunk 按利用率分层管理。

### 卡片 F：释放路径不是“归还一块内存”这么简单

- `PoolArena.free(...)` 先判断 unpooled/pooled，再根据 handle 判断 Small/Normal。
- 如果 thread cache 能接收，则进入 cache，不立即回到 arena；否则进入 chunk.free / subpage.free / run 合并。
- 结论：释放路径也有 cache、size class、chunk 状态和销毁决策。

### 卡片 G：测试揭示缓存和 chunk 保留语义

- `PooledByteBufAllocatorTest.expectedUsedMemoryAfterRelease` 明确：释放后可能仍保留一个 chunk，因为 qInit 中 chunk 不会立即释放直到迁移到 q000。
- `testWithoutUseCacheForAllThreads` 说明普通线程默认可以不使用 cache。
- `testArenaMetricsCache/NoCache` 说明 cache 命中会改变 arena allocation/deallocation 统计。

## 理解路径

1. **从“池化就是切大数组”切入**：指出这个模型解释不了不同大小对象、线程局部缓存、chunk 利用率和释放后内存保留。
2. **先画总图**：allocator -> arena -> thread cache -> size class -> subpage/run -> chunk list。
3. **按请求大小分三路**：small、normal、huge，分别解释为什么不能共用同一分配器路径。
4. **再解释 chunk 内部**：normal 是 page run，small 是 subpage bitmap，二者共享 chunk 但粒度不同。
5. **解释 chunk list**：利用率迁移解决“新 chunk / 热 chunk / 空 chunk”如何组织。
6. **反向走释放**：thread cache 优先接收，未命中才回 arena；空闲 chunk 不一定立即销毁。
7. **用测试纠正直觉**：释放 ByteBuf 不等于进程 RSS 立即下降，cache 和 qInit 语义会保留内存。

## 失败方案推演

- 只有一个全局大 byte[]：线程竞争、碎片和不同大小对象分配无法同时处理。
- 所有对象都按 page 分配：小对象会和 page 粒度强绑定，因此需要再引入 subpage 这种更细的管理层。
- 所有对象都走 subpage：中等对象也会被迫落到固定元素模型里，难以表达连续 run 的空间需求。
- 释放后立即销毁所有 chunk：会削弱池化保留可复用空间的意义，也让 chunk 生命周期失去缓冲区间。这里表达的是结构取舍，不替具体性能收益下基准结论。
- 所有线程都强制使用 thread cache：普通线程生命周期和清理能力不一致，缓存保留可能反而成为负担。
- 只看 allocator 的 active allocation 指标：无法解释 cache 中待回收对象、chunk 利用率和 huge allocation。

## 文章结构与预算

1. 开场：为什么池化分配不是“从大数组切一段”（1000-1400 字）
2. 总图：allocator、arena、thread cache、size class、chunk 的角色关系（1600-2200 字）
3. 三条分配路径：small / normal / huge（1800-2400 字）
4. Chunk 内部：page、run、handle、空闲 run 合并（1800-2400 字）
5. Small 与 Subpage：bitmap 固定元素分配（1400-1900 字）
6. PoolChunkList：利用率迁移与 chunk 生命周期（1600-2200 字）
7. 释放与测试：cache 接收、chunk 保留、指标解释（1600-2200 字）
8. 收网：池化总图和参数调优桥接（700-1000 字）

目标：去掉代码块后的叙述性正文 9500-12000 字，最低不低于 8000 字。

## 证据清单

- `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:38-185`
- `buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:190-206`
- `buffer/src/main/java/io/netty/buffer/PoolArena.java:35-113`
- `buffer/src/main/java/io/netty/buffer/PoolArena.java:129-235`
- `buffer/src/main/java/io/netty/buffer/PoolArena.java:237-289`
- `buffer/src/main/java/io/netty/buffer/PoolChunk.java:30-137`
- `buffer/src/main/java/io/netty/buffer/PoolChunk.java:152-224`
- `buffer/src/main/java/io/netty/buffer/PoolChunkList.java:30-72`
- `buffer/src/main/java/io/netty/buffer/PoolChunkList.java:99-153`
- `buffer/src/main/java/io/netty/buffer/PoolSubpage.java:26-151`
- `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:51-94`
- `buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:129-192`

## 边界清单

- 本篇不重新展开 Ch5-03 的 FastThreadLocal 访问实现和 Recycler 内部队列，只说明 PoolThreadCache 在总图中的位置。
- 本篇不把 qInit/q000 等名称写成六个互不相干的 allocator，它们是按 chunk 利用率组织的链表。
- 本篇不把释放 ByteBuf 写成底层内存立即归还给操作系统；cache、chunk list 和池化策略会延迟销毁。
- 本篇不把 huge allocation 写成异常路径；它是 size class 超出池化范围时的正常分支。
- 本篇不把 arena 数量、pageSize、maxOrder 的默认值外推为所有环境的最佳配置。

## 深审预警

- [ ] 不把池化总图简化成 allocator -> chunk 两级，必须保留 arena、thread cache、size class、subpage/run、chunk list。
- [ ] 不把 small 与 normal 混成同一分配粒度。
- [ ] 不把 PoolChunkList 写成按请求大小分组，它按 chunk 利用率分层。
- [ ] 不把释放后 chunk 保留写成泄漏，必须区分池化保留、thread cache 和真正 ownership leak。
- [ ] 不把测试指标直接当作所有平台的内存行为保证。