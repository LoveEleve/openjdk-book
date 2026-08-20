# Ch8-05 池化分配器总图：Allocator、Arena、Chunk、Subpage 与 ThreadCache — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `PooledByteBufAllocator` 当前维护 heap/direct arenas、thread cache 和 chunk size，并读取 page、maxOrder、cache 等参数，证据：`buffer/src/main/java/io/netty/buffer/PooledByteBufAllocator.java:38`、`:190`。  
2. `PoolArena.allocate(...)` 当前通过 `SizeClasses.size2SizeIdx(reqCapacity)` 把请求分成 small、normal、huge 三条路径，证据：`buffer/src/main/java/io/netty/buffer/PoolArena.java:129`。  
3. small 路径当前优先尝试 thread cache，未命中后进入 `smallSubpagePools`，证据：`buffer/src/main/java/io/netty/buffer/PoolArena.java:150`。  
4. normal 路径当前依次尝试多条 `PoolChunkList`，都失败后创建新 chunk，证据：`buffer/src/main/java/io/netty/buffer/PoolArena.java:206`。  
5. huge 路径当前跳过 cache，调用 `allocateHuge(...)` 创建 unpooled chunk，证据：`buffer/src/main/java/io/netty/buffer/PoolArena.java:142`、`:229`。  
6. `PoolChunk` 当前把 page 定义为最小单位、run 定义为 page 集合、chunk 定义为 run 集合，并维护可用 run map/priority queues，证据：`buffer/src/main/java/io/netty/buffer/PoolChunk.java:30`、`:158`。  
7. `PoolChunk` 当前 handle 编码 run offset、page 数、used/subpage 标志和 bitmap index，证据：`buffer/src/main/java/io/netty/buffer/PoolChunk.java:76`。  
8. `PoolSubpage` 当前使用 bitmap 管理固定大小元素，分配时置位、释放时清位，并按可用数量决定是否留在 subpage pool，证据：`buffer/src/main/java/io/netty/buffer/PoolSubpage.java:64`、`:90`、`:118`。  
9. `PoolArena` 当前创建 qInit/q000/q025/q050/q075/q100 六条 `PoolChunkList` 利用率链，证据：`buffer/src/main/java/io/netty/buffer/PoolArena.java:91`。  
10. `PoolChunkList.allocate(...)` 当前在利用率升高越过阈值后把 chunk 移向 next list，`free(...)` 当前在利用率下降后向 prev list 移动或允许销毁，证据：`buffer/src/main/java/io/netty/buffer/PoolChunkList.java:99`、`:119`。  
11. `PoolArena.free(...)` 当前先区分 unpooled/pooled，再区分 Small/Normal，并优先尝试 thread cache，证据：`buffer/src/main/java/io/netty/buffer/PoolArena.java:237`。  
12. `PooledByteBufAllocatorTest` 当前验证释放后 qInit 中的 chunk 可能继续保留，证据：`buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:64`。  
13. `PooledByteBufAllocatorTest` 当前分别验证 cache 开启/关闭下的 arena allocation/deallocation metrics，证据：`buffer/src/test/java/io/netty/buffer/PooledByteBufAllocatorTest.java:147`。

### 深审发现

1. **高风险：容易把池化简化成 allocator -> chunk 两级。** 正文已建立 allocator、arena、thread cache、size class、subpage/run、chunk list 总图。  
2. **高风险：容易把 small/normal/huge 写成名称分类。** 正文已明确三条物理分配路径。  
3. **中风险：容易把 PoolChunkList 误写成按请求大小分组。** 正文已限定为按 chunk 利用率分层。  
4. **中风险：容易把 release 后 chunk 保留写成泄漏。** 正文已改成测试路径限定，区分 ownership leak、cache/chunk 保留和 huge allocation 路径。  
5. **中风险：容易把 small 未命中路径写成必然创建新的 subpage backing。** 正文已改成“优先复用已有 subpage，不够时再向下层要 backing”。  
6. **中风险：容易把分层结构动机写成已被基准证明的性能结论。** 正文已把相关句子收紧为设计动机或结构取舍。  
7. **低风险：容易把默认 pageSize/maxOrder/arena 数写成最佳配置。** 正文保留当前实现默认值的边界，没有外推调优结论。

## 第二轮：因果审

- allocator 选择 arena/thread cache -> arena 按 size class 分流 -> small/normal/huge 各走不同物理路径：✅  
- small 需要固定大小元素 -> subpage bitmap；normal 需要连续空间 -> page-run：✅  
- chunk 利用率变化 -> PoolChunkList 链间迁移 -> 空闲 chunk 在合适条件下销毁：✅  
- release 归零 -> cache 或 arena 回收 -> 不代表底层 chunk 立即销毁：✅  
- 测试保留 qInit chunk -> 证明池化保留不能直接等同泄漏：✅

## 第三轮：结构审

正文结构按“拆掉大数组模型 -> 总图 -> arena/cache -> 三类分流 -> chunk/page/run -> subpage -> chunk list -> 释放与测试 -> 收网”推进，没有按源码文件顺序平铺。✅

失败方案已覆盖：
- 只有一个全局大 byte[]  
- 所有对象都按 page 分配  
- 所有对象都走 subpage  
- 释放后立即销毁所有 chunk  
- 所有线程强制使用 thread cache  
- 只看 active allocation 指标  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- allocator、arena、thread cache、size class、chunk 的角色关系  
- small、normal、huge 三条路径的差异  
- subpage bitmap 和 normal page-run 的差异  
- chunk list 按利用率迁移的意义  
- release 后 cache/chunk 保留为何不自动等于泄漏  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重新展开 FastThreadLocal/Recycler 内部机制。✅  
- 未把 qInit/q000 等写成六个独立 allocator。✅  
- 未把 release 后内存写成立即归还操作系统。✅  
- 未把 huge allocation 写成异常路径。✅  
- 未把默认参数外推为所有环境最佳配置。✅

## 第六轮：依赖审

- 依赖 Ch4 allocator、ownership 基础，真实存在。✅  
- 依赖 Ch5-03 thread-local/Recycler 结论，正文未重复其内部实现。✅  
- 依赖 Ch8 前置局部章节，并承担把局部机制串成总图的职责。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 10,208。  
- 去掉常见 markdown 标记后的字符数：约 9,958。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经建立池化分配器的多级总图：allocator -> arena -> thread cache -> size class -> subpage/run -> chunk list，并覆盖了释放、缓存保留和测试证据。Ch8-05 可作为后续池化参数调优、指标诊断和具体分配算法专题的总图前置篇。