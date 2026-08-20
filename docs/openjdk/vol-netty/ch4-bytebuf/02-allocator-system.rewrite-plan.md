# Ch4-02 ByteBufAllocator 分配器体系 — rewrite-plan

## 篇章定位

- 核心困惑：上一篇已经知道 ByteBuf 如何管理索引、容量和寿命，但调用 `allocator.buffer(1024)` 时，谁决定它是堆内还是堆外？容量不足时为什么不是简单翻倍？
- 一句话顿悟：Allocator 把“我要什么用途”与“具体创建哪种 ByteBuf”分开；它用模板方法统一入口，用 `ioBuffer` 表达 I/O 偏好，用受 maxCapacity 约束的三级容量算法控制增长，用泄漏包装把诊断能力接在返回边界。
- 篇章边界：重点讲 SPI、模板分发、`ioBuffer` 选择、`calculateNewCapacity` 和 Unpooled/Pooled 的策略对照；LeakAware 只讲分配边界的 Decorator，Adaptive、Composite 详细机制留后续篇。

## 依赖

### HARD

- Ch4-01：reader/writer index、capacity/maxCapacity、ensureWritable 触发 allocator.calculateNewCapacity。
- Ch1-02：Heap/Direct 的基本差异，只复用 I/O 与内存释放动机。
- Ch2/Ch3：I/O 场景背景，说明 `ioBuffer` 为什么是一个单独的意图入口。

### SOFT

- Java 接口/抽象模板方法：正文提供最小解释。
- Netty ResourceLeakDetector：本篇只解释 allocator 返回边界的包装选择，不展开检测器内部采样和报告。

### NAV

- Ch4-03：Heap vs Direct 的访问、分配、释放路径。
- Ch4-04：派生视图与引用计数共享边界。
- Ch4-05：CompositeByteBuf 的组件聚合和零拷贝。
- Ch5：EventLoop 如何消费 allocator 创建的 I/O buffer。
- Ch8：PooledByteBufAllocator 的 Arena/Chunk/Subpage/ThreadCache 细节。

## 素材事实卡片

### 卡片 A：SPI 与模板方法

- `ByteBufAllocator.java:25-43`：`buffer()` 由实现决定 heap/direct。
- `ByteBufAllocator.java:45-58`：`ioBuffer()` 是 preferably direct 的 I/O 意图。
- `ByteBufAllocator.java:60-90`：heap/direct 明确类型入口。
- `ByteBufAllocator.java:124-133`：direct 是否池化、容量算法入口。
- `AbstractByteBufAllocator.java:31-34`：默认初始容量 256、默认最大容量 Integer.MAX_VALUE、默认组件数 16、4 MiB 计算阈值。
- `AbstractByteBufAllocator.java:85-169`：buffer/ioBuffer/heapBuffer/directBuffer 分发。
- `AbstractByteBufAllocator.java:171-205`：composite 分发。
- `AbstractByteBufAllocator.java:216-224`：子类只需实现 `newHeapBuffer/newDirectBuffer`。
- `AbstractByteBufAllocator.java:64-82`：`directByDefault` 受 `preferDirect` 与 direct 可可靠释放能力共同约束。

### 卡片 B：ioBuffer 的真实边界

- `AbstractByteBufAllocator.java:109-131`：`ioBuffer` 在 direct 可可靠释放或 direct buffer 已池化时选 direct，否则 heap。
- 不能写成“ioBuffer 永远 direct”；它是 preferably direct。
- `isDirectBufferPooled()` 是策略查询，不是底层实现类型承诺。

### 卡片 C：calculateNewCapacity 三级策略

- `AbstractByteBufAllocator.java:232-259`：先校验 `minNewCapacity <= maxCapacity`。
- 等于 4 MiB：精确返回 threshold。
- 大于 4 MiB：向 4 MiB 对齐后再增加一个 threshold，接近步进增长；接近 maxCapacity 时返回 maxCapacity。
- 小于 4 MiB：取至少 64 的下一个 2 次幂，并以 maxCapacity 截断。
- 4 MiB 是当前 allocator 的容量计算阈值；Pooled 的默认 chunk 由 `PooledByteBufAllocator.java:44-45` 和 `:83-105` 体现 8192 << 9 = 4 MiB，但不能把两者写成所有配置下永远相等。

### 卡片 D：Unpooled/Pooled 策略对照

- `UnpooledByteBufAllocator.java:25-32`：不做池化，保留 metric、leak detector、noCleaner 配置。
- `UnpooledByteBufAllocator.java:81-98`：Unsafe/非 Unsafe、Cleaner/noCleaner、LeakAware 的分发。
- `UnpooledByteBufAllocator.java:113-115`：direct 不池化。
- `PooledByteBufAllocator.java:38-57`、`:68-126`：page/maxOrder/chunk/cache 等默认参数和可配置项；本篇只用于说明池化策略存在，不展开 Arena。
- 不把 `io.netty.allocator.type` 三种模式当成当前篇的完整实现主题；配置选择可导航到后文。

### 卡片 E：泄漏包装边界

- `AbstractByteBufAllocator.java:36-62`：排除自身 `toLeakAwareBuffer` 防止检测器递归；普通 ByteBuf 与 CompositeByteBuf 分别包装。
- `AbstractByteBufAllocator.java:40-49`：track 成功后按 `isRecordEnabled()` 选择 Advanced/Simple。
- `UnpooledByteBufAllocator.java:89-98`：Unpooled direct buffer 可按 `disableLeakDetector` 不包装，否则进入 LeakAware。
- 本篇只讲“返回对象可能是 decorator”，不讲 Advanced 80+ 方法成本（Ch4-04/后续）。

## 理解路径

1. **从调用者意图切入**：业务只说“普通 buffer、I/O buffer、堆、直接”，不应该知道具体实现类。
2. **拆开两层决策**：接口表达意图；抽象 allocator 负责默认值、校验和模板分发；具体 allocator 才决定对象实现。
3. **解释 ioBuffer 的条件选择**：为什么 I/O 偏好 direct，但不能写成 direct 承诺；direct 释放能力和 direct pooling 改变降级路径。
4. **从一次写入超限进入扩容算法**：小容量用 2 次幂，大容量用 4 MiB 步进，阈值等于时精确返回；maxCapacity 负责封顶。
5. **比较 Unpooled/Pooled**：同一 SPI 后面可以换“不池化”和“池化”，调用者不改 API；本篇只讲策略差异，不提前进入 Arena。
6. **把诊断放在返回边界**：Allocator 创建后立即决定是否包 LeakAware，说明 decorator 如何保持 ByteBuf API 不变。
7. **收网**：Allocator 是 ByteBuf 的“创建策略边界”，而不是一个简单 new 工厂；下一篇进入存储类型差异。

## 失败方案推演

- 业务代码直接 `new HeapByteBuf/new DirectByteBuf`：实现类型渗透业务，无法按部署环境切换，也难以统一容量与诊断策略。
- `buffer()` 永远返回 direct：非 I/O、无法可靠释放或未池化场景可能产生资源/性能风险；SPI 保留实现选择。
- 所有扩容都按 2 倍：大 buffer 的瞬时内存峰值和浪费扩大；所有扩容都按固定小步长：小 buffer 重分配频繁。
- 每次调用都让业务手动包装泄漏检测：容易遗漏、破坏统一诊断边界；allocator 在返回边界集中装饰。
- 直接把 4 MiB 写成“所有池化内存结构永远固定 chunk”：忽略 allocator 配置和实现版本边界。

## 文章结构与预算

1. 先问：ByteBuf 是谁创建的（1000-1300 字）
2. SPI：按意图申请，不承诺实现（1800-2200 字）
3. 模板分发：默认值、校验与 heap/direct/io/composite（1500-1900 字）
4. ioBuffer：I/O 偏好为何不是 direct 保证（1200-1600 字）
5. calculateNewCapacity：4 MiB 三级增长（2200-2800 字）
6. Unpooled/Pooled 与 LeakAware 返回边界（1800-2300 字）
7. 误解澄清、总图和 Ch4-03 桥接（1000-1400 字）

目标：删掉代码后的叙述性正文 9000-10500 字。

## 证据清单

- `ByteBufAllocator.java:25-43`
- `ByteBufAllocator.java:45-58`
- `ByteBufAllocator.java:60-90`
- `ByteBufAllocator.java:124-133`
- `AbstractByteBufAllocator.java:31-34`
- `AbstractByteBufAllocator.java:36-62`
- `AbstractByteBufAllocator.java:64-82`
- `AbstractByteBufAllocator.java:85-169`
- `AbstractByteBufAllocator.java:171-224`
- `AbstractByteBufAllocator.java:232-259`
- `UnpooledByteBufAllocator.java:25-32`
- `UnpooledByteBufAllocator.java:81-115`
- `PooledByteBufAllocator.java:38-57`
- `PooledByteBufAllocator.java:68-126`

## 边界清单

- 基于当前 Netty 源码；4 MiB、默认初始容量、默认 maxCapacity 都是当前实现默认值，不外推为所有版本/配置的永恒规范。
- `buffer()` 不承诺 heap/direct；`ioBuffer()` 只 preferably direct。
- `directByDefault` 与 `ioBuffer` 的 direct 选择条件不同，不能混成一个开关。
- 4 MiB 是容量计算 threshold；默认 Pooled chunk 也为 4 MiB，但 pageSize/maxOrder 可配置。
- Unpooled/Pooled 只做策略层对照；Arena、Chunk、Subpage、ThreadCache 留 Ch8。
- LeakAware 是返回对象的 decorator，不代表每个操作都在本篇展开；检测级别和性能成本留后续。
- 本篇不解释 Heap/Direct 具体内存访问与释放差异，只把它们作为 allocator 的选择结果导航到 Ch4-03。

## 深审预警

- [ ] 不把 `ioBuffer()` 写成永远返回 Direct。
- [ ] 不把 `buffer()` 写成只由 `directByDefault` 决定的全部行为，注意 zero/zero 和具体子类分发。
- [ ] 三级扩容要准确写出 `minNewCapacity == threshold` 的特殊分支。
- [ ] 大于 threshold 时要说明当前实现先向 threshold 对齐，再加一个 threshold，并受 maxCapacity 截断。
- [ ] 不把 `CALCULATE_THRESHOLD` 与所有 Pooled chunk 配置硬绑定。
- [ ] 不把 LeakAware 的 Advanced/Simple 选择写成 ResourceLeakDetector 全部机制。
- [ ] 先讲调用者问题，再出源码证据；删码后仍能复述分配和扩容主线。
