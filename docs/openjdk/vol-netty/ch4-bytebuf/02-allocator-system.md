# ByteBufAllocator：把“我要什么缓冲区”交给策略决定

> 本文基于当前 Netty `buffer` 与 `common` 模块源码。前置：Ch4-01 `01-dual-index-and-refcnt.md`、Ch1 Heap/Direct 基础、Ch2/Ch3 I/O 场景；本文解释 `ByteBufAllocator` 的意图接口、模板分发、`ioBuffer` 选择、容量增长和返回边界包装，不深入 Arena/Chunk/Subpage、Heap/Direct 访问实现或 Composite 内部算法。

## ByteBuf 已经解决“怎么用”，但谁负责“创建”

上一篇我们把 ByteBuf 拆成了三套协议：

```text
readerIndex / writerIndex  -> 数据读写进度
capacity / maxCapacity     -> 当前空间与增长边界
refCnt / retain / release  -> 资源 ownership 与释放时机
```

但这些协议都有一个隐含前提：先得有一块 ByteBuf。

业务代码可能只是想做三种完全不同的事情：

- 临时拼一段普通业务数据。
- 给 Socket I/O 准备一块更适合传输的缓冲区。
- 明确要求堆内或堆外存储。

如果每个调用方都自己决定具体实现，就会出现另一种耦合：业务代码开始知道 `HeapByteBuf`、`DirectByteBuf`、池化对象和泄漏检测包装器。换机器、换传输方式、换内存策略，都可能逼着业务代码改动。

于是 ByteBuf 的“怎么使用”和“怎么创建”必须分开：

```text
调用方表达意图
  -> allocator 选择存储类型和分配策略
  -> 具体实现创建 ByteBuf
  -> 返回前统一接上诊断/生命周期包装
```

这就是 `ByteBufAllocator` 的角色。它不是一个简单的 `new` 工厂，而是把“调用者的需求语言”和“底层内存策略”隔开的边界。

本篇会沿着一条主线展开：调用方只提出意图，allocator 如何把意图翻译成对象；对象空间不够时，allocator 又如何决定下一次长到哪里。

## 一、第一层解耦：按意图申请，不按实现类申请

### 1. `buffer()` 故意不承诺 heap 还是 direct

最普通的入口是：

```text
ByteBuf buf = allocator.buffer(1024);
```

调用者表达的是“我要一块初始容量为 1024 的 ByteBuf”，并没有表达“必须是 heap”或“必须是 direct”。这不是接口遗漏，而是有意留下的策略空间。

`ByteBufAllocator` 的接口文档明确说，`buffer()` 返回 heap 还是 direct，取决于实际实现，见 `ByteBufAllocator.java:25-43`。

这条约束很重要。它让调用方依赖 ByteBuf 能提供的行为，而不是依赖具体存储类型：

```text
业务代码：我需要 ByteBuf 的读写协议
allocator：我根据当前策略决定具体实现
```

如果今天某个部署环境偏好 direct，allocator 可以改变默认选择；如果另一个环境更看重简单回收或没有可靠 direct 释放能力，也可以返回 heap。业务层不需要修改每一处 `new`。

这背后的失败方案很直觉：让业务代码直接写：

```text
new HeapByteBuf(...)
```

它看起来简单，实际上把三个问题绑死了：

1. 业务知道了实现类，接口替换变难。
2. 每个调用方都要重复处理初始容量、maxCapacity、计量和泄漏检测。
3. I/O、普通业务、池化与非池化无法通过统一入口切换。

`buffer()` 的“不承诺”换来的是策略可替换性。它不是降低了类型信息，而是把不应该由业务决定的类型决策收回 allocator。

### 2. `heapBuffer`、`directBuffer` 是明确意图的另一侧

如果调用方确实有存储约束，接口也没有把所有决策都藏起来：

- `heapBuffer()`：明确要求堆内 ByteBuf。
- `directBuffer()`：明确要求堆外 ByteBuf。
- `compositeBuffer()`：明确需要 CompositeByteBuf，但 heap/direct 仍可由实现决定。

这些入口在 `ByteBufAllocator.java:60-122` 定义。

所以 allocator 的接口不是“所有事情都自动猜”，而是把意图分成不同强度：

```text
buffer       = 只需要 ByteBuf，类型交给策略
ioBuffer     = 用于 I/O，优先适合 I/O 的 direct
heapBuffer   = 类型约束为 heap
 directBuffer = 类型约束为 direct
composite    = 需要组件聚合，存储类型按入口决定或交给策略
```

这里的 `directBuffer()` 与 `buffer()` 有一个关键区别：前者是调用者承担了 direct 选择责任，后者把选择责任交给 allocator。接口越明确，调用者得到的实现保证越强，同时也放弃一部分策略自由。

### 3. `ioBuffer()` 是用途语义，不是类型别名

I/O 场景经常需要 direct buffer，但把 `ioBuffer()` 简单理解成 `directBuffer()` 仍然不准确。

接口对 `ioBuffer` 的措辞是“preferably a direct buffer which is suitable for I/O”，见 `ByteBufAllocator.java:45-58`。关键词是 preferably：它表达偏好，不构成无条件承诺。

为什么要保留这个弹性？因为 direct 是否适合当前平台和当前 allocator，不能只看调用点。还要考虑：

- 平台是否能可靠释放 direct memory。
- 当前 allocator 是否已经池化 direct buffer。
- 具体传输实现是否能从 direct 选择中获得收益。
- 如果 direct 路径不满足安全条件，是否需要降级到 heap。

所以 `ioBuffer()` 的真正意义是：调用方告诉 allocator“这是 I/O 用途”，allocator 再基于当前环境决定最佳实现，而不是让每个调用方自己复制一份 direct 选择规则。

到这里先记一个边界：

```text
buffer() 不是 heap/direct 的承诺
ioBuffer() 不是 direct 的承诺
heapBuffer()/directBuffer() 才是明确类型要求
```

接下来要看的是，这些入口如何落到具体对象。否则“策略可替换”还只是接口口号。

## 二、第二层解耦：抽象 allocator 统一默认值，子类只负责真正创建

### 1. 模板方法把公共流程收在一处

如果每种 allocator 都自己实现 `buffer()`、`ioBuffer()`、`heapBuffer()`、`directBuffer()`、`compositeBuffer()`，公共规则很快会分散：默认容量到处复制，零容量处理不一致，参数校验也可能各写一套。

Netty 用 `AbstractByteBufAllocator` 收住这部分公共流程。它定义当前实现的默认值：初始容量 256、最大容量 `Integer.MAX_VALUE`、默认 Composite 组件数 16，以及容量计算阈值 4 MiB，见 `AbstractByteBufAllocator.java:31-34`。

以普通入口为例，抽象类只根据 `directByDefault` 做方向分发：

```text
buffer(initial, max)
  -> directByDefault ? directBuffer(initial, max)
                     : heapBuffer(initial, max)
```

随后 heap/direct 入口统一做两件事：

1. 如果 initialCapacity 和 maxCapacity 都是 0，返回 allocator 持有的空 buffer。
2. 否则校验容量关系，再调用子类的 `newHeapBuffer` 或 `newDirectBuffer`。

完整分发位于 `AbstractByteBufAllocator.java:85-169`。

这个设计把公共流程与具体创建分成两层：

```text
AbstractByteBufAllocator：默认值、校验、意图分发
具体子类：newHeapBuffer / newDirectBuffer
```

子类只需实现两个抽象方法，见 `AbstractByteBufAllocator.java:216-224`，就能自动获得整套入口的共同语义。新增一种 allocator 时，不需要重新发明所有 API 的行为。

### 2. `directByDefault` 不是“我喜欢 direct”这么简单

抽象 allocator 的构造函数接受 `preferDirect`，但它不会无条件把这个偏好变成 direct 默认值。当前源码把 `preferDirect` 与 `PlatformDependent.canReliabilyFreeDirectBuffers()` 共同用于计算 `directByDefault`，见 `AbstractByteBufAllocator.java:64-82`。

也就是说：

```text
preferDirect = true
  -> 还要检查当前平台能否可靠释放 direct buffer
  -> 两个条件都满足，才让普通 buffer 默认走 direct
```

这体现的是一个资源边界判断：分配 direct 不只是“访问可能更快”，还意味着 allocator 必须有可靠的释放责任。如果平台能力不满足，抽象层宁可不采纳 direct 偏好。

这里不能把它讲成性能定律。源码只证明当前实现把 direct 偏好和释放能力绑定；至于具体应用中 heap/direct 的性能差异，还要结合访问路径、I/O API、池化状态和消息大小，留到 Ch4-03。

### 3. `ioBuffer` 走的是另一条判断链

`buffer()` 依赖 `directByDefault`，而 `ioBuffer()` 有自己的条件：当前平台能可靠释放 direct buffer，或者 allocator 报告 direct buffer 已池化时，选择 direct；否则选择 heap，见 `AbstractByteBufAllocator.java:109-131`。

这两条路径不能混成一个开关：

```text
普通 buffer：看 directByDefault
I/O buffer：看 direct 可可靠释放 || direct 已池化
```

为什么当前实现把 direct pooling 纳入判断？从源码行为看，池化 allocator 具备自己的资源归还路径，因此 `ioBuffer()` 将“direct 已池化”作为选择 direct 的条件之一；这是当前 Netty 的策略实现，不应外推成所有 allocator 或所有平台都能靠池化解决 direct 释放问题。这里先停在策略判断，不提前展开池化内部的 Arena 与 Chunk。

### 4. composite 也被纳入同一套公共入口

抽象 allocator 还统一了 `compositeBuffer()`、`compositeHeapBuffer()` 和 `compositeDirectBuffer()` 的分发，见 `AbstractByteBufAllocator.java:171-205`。

普通 `compositeBuffer()` 仍遵守 `directByDefault`；明确的 heap/direct Composite 则交给对应子类构造。无论结果是普通 ByteBuf 还是 CompositeByteBuf，调用方都通过 allocator 获取，不必直接依赖具体构造函数。

本节的主线到这里已经闭合：Allocator SPI 负责让调用方表达意图，抽象模板负责把默认值、校验和公共分发集中起来，具体子类负责把最后一段对象真正创建出来。

## 三、扩容不是“随便长大”：4 MiB 三级容量算法

### 1. 调用者为什么不应该自己算下一次容量

上一篇的 `ensureWritable` 已经把职责交代清楚了：当当前 writable 空间不够时，ByteBuf 会向 allocator 请求一个新的容量。

调用者面对的是：

```text
minNewCapacity = writerIndex + 本次需要写入的字节数
maxCapacity    = 这块 ByteBuf 的硬上限
```

它不应该再自己决定“翻倍还是加 4 MiB”。如果每个协议、每个 handler 都有一套增长公式，容量行为就会失去统一性：同样大小的消息，在不同代码路径上产生完全不同的重分配频率和内存峰值。

`ByteBufAllocator.calculateNewCapacity(minNewCapacity, maxCapacity)` 就是这个策略边界，接口在 `ByteBufAllocator.java:124-133` 声明，抽象实现位于 `AbstractByteBufAllocator.java:232-259`。

它先做一件不能省的事：如果最小所需容量超过 maxCapacity，直接拒绝。这一步把“不可能满足的请求”和“可以通过增长满足的请求”分开。

### 2. 小于 4 MiB：向上取 2 的幂，但不低于 64

当 `minNewCapacity` 小于阈值时，当前实现先把它和 64 取最大值，再找不小于它的下一个正 2 次幂，最后用 maxCapacity 截断，见 `AbstractByteBufAllocator.java:256-258`。

可以把它理解成：

```text
minNewCapacity = 100
  -> 至少按 64 作为下界
  -> 找下一个 2 的幂
  -> newCapacity = 128
```

再比如：

```text
minNewCapacity = 500 KiB
  -> 找到不小于它的 2 次幂
  -> newCapacity = 1 MiB
```

这种增长方式的目的不是让每次容量都刚好等于请求，而是用少量空间冗余换较少的重新分配次数。若每次只增加刚好够用的容量，连续写入会反复分配和复制；向上取整可以让后续一段写入直接使用现有空间。

但 2 的幂策略不能无限延伸到大 buffer。对 10 MiB 的需求直接翻到 16 MiB，浪费和瞬时峰值都可能变得明显。因此实现需要在某个尺度切换策略。

### 3. 等于 4 MiB：为什么专门返回边界值

当前阈值是 `4 * 1024 * 1024`，定义在 `AbstractByteBufAllocator.java:31-34`。

当 `minNewCapacity == threshold` 时，算法直接返回 threshold，见 `AbstractByteBufAllocator.java:239-243`。它没有把 4 MiB 再翻到 8 MiB，也没有进入“大于阈值”的步进分支。

这个精确匹配很容易被写成“4 MiB 是所有 allocator 的神奇常数”，但源码能证明的只是：它是当前抽象 allocator 的容量计算阈值。它与默认 Pooled chunk 大小存在数值上的呼应：`PooledByteBufAllocator` 的默认 page size 是 8192，默认 max order 是 9，源码注释直接写出 `8192 << 9 = 4 MiB per chunk`，见 `PooledByteBufAllocator.java:44-45`、`:68-105`。

不过 page size 和 max order 都是可配置的，不能把这种数值关系外推成所有部署下永远成立的硬约束。更稳妥的理解是：当前容量算法选择 4 MiB 作为小对象幂次增长与大对象步进增长的分界；默认池化布局恰好也以 4 MiB 作为 chunk 尺寸，这让边界具有工程上的对齐意义。

### 4. 大于 4 MiB：按 4 MiB 步进，而不是继续翻倍

当 `minNewCapacity > threshold` 时，当前实现先计算 `minNewCapacity / threshold * threshold`，得到不超过需求的 4 MiB 对齐基线；随后如果再增加一个 threshold 不会超过 maxCapacity，就加上一个 threshold，否则直接取 maxCapacity，见 `AbstractByteBufAllocator.java:245-253`。因此它不是简单向上取整：即使需求本身正好落在 4 MiB 的整数倍上，也可能在 maxCapacity 允许时再预留一个步长。

例如：

```text
minNewCapacity = 10 MiB
threshold = 4 MiB

先对齐到 8 MiB
再加一个 threshold
newCapacity = 12 MiB
```

它不是把 10 MiB 翻倍到 20 MiB，而是把增长控制在一个相对稳定的步长。对于大消息或长期缓冲，步进增长可以避免一次扩容产生过大的空余容量和瞬时内存峰值。

但要注意一个实现细节：这不是简单的“向上取整到下一个 4 MiB 倍数”。对于恰好落在倍数上的需求，大于阈值的分支会先得到当前倍数，再加一个 threshold。例如需求是 8 MiB，结果会进入 8 MiB 对齐后再增长到 12 MiB，除非 maxCapacity 更小。这正是“为下一段增长预留空间”，而不是“只分配刚好容纳当前请求”。

### 5. 三段算法放在一条数据流里

把 `ensureWritable` 与 allocator 连接起来，完整路径是：

```text
write 发现 writableBytes 不足
  -> ensureWritable(minNewCapacity, force)
  -> allocator.calculateNewCapacity(minNewCapacity, maxCapacity)
       min < 4 MiB  : 64 起步的 2 次幂
       min == 4 MiB : 精确 4 MiB
       min > 4 MiB  : 4 MiB 对齐后再增加一个步长
  -> capacity(newCapacity)
  -> 继续写入
```

这条路径让容量增长从业务代码中收了回来。业务只需要提供“最少需要多少”和“最多允许多少”，allocator 负责统一增长策略。

到这里先停一下，回收本节主线：4 MiB 不是一个适合所有场景的魔法答案，而是当前实现用来切换增长策略的分界线。小容量更在意减少重分配，大容量更在意控制浪费，maxCapacity 则始终负责阻止无界增长。

## 四、同一套 SPI 后面，Unpooled 和 Pooled 可以换策略

### 1. Unpooled：每次创建具体内存，不维护池

`UnpooledByteBufAllocator` 的类注释直接说明，它是不做池化的简单实现，见 `UnpooledByteBufAllocator.java:25-32`。

它仍然遵循 `AbstractByteBufAllocator` 的 SPI：调用方照样使用 `buffer`、`heapBuffer`、`directBuffer`，但具体创建时根据 Unsafe、noCleaner 等能力分发到不同实现，见 `UnpooledByteBufAllocator.java:81-98`。

这套策略的优点是路径直观：申请一块资源，使用引用计数管理 ByteBuf 的生命周期，释放时归还给底层对象/内存路径。它适合简单场景、测试、特定的外部内存包装和不希望引入池化管理的场景。

代价也很直接：高频创建和释放会反复触发底层分配与清理；如果 Direct 资源没有合适的 noCleaner 或清理路径，生命周期成本会更加明显。

Unpooled 不是“错误实现”，而是把分配策略保持简单，放弃池化带来的复用收益。

### 2. Pooled：调用接口不变，内部复用内存

`PooledByteBufAllocator` 同样继承 `AbstractByteBufAllocator`，但内部会围绕 page、chunk、arena、cache 等结构管理内存。当前源码中，默认 page size 和 max order 的读取、默认 chunk size 的计算，以及缓存参数的初始化，都集中在 `PooledByteBufAllocator.java:38-126`。

本篇不进入这些结构的内部遍历，只需要抓住策略差异：

```text
Unpooled：一次申请，一次释放，路径直接
Pooled：从池中取，使用后归还，减少重复底层分配
```

调用者看到的仍是 `ByteBufAllocator` 和 `ByteBuf`。这就是 SPI 的价值：底层从 Unpooled 切换到 Pooled，不需要把业务代码里的创建入口整体替换掉。

但“接口不变”不等于“代价不变”。池化会引入 arena、缓存和归还策略；如果缓存保留过多，也会让进程持有更多内存；如果线程和 arena 配置不匹配，还可能产生竞争或利用率问题。具体取舍属于后续内存池化章节。

### 3. 为什么不能用一个 allocator 结论覆盖所有场景

“生产一定用 Pooled”或“调试一定用 Unpooled”都过于粗糙。真正的选择要看：

- 分配频率和对象大小是否稳定。
- 内存峰值是否需要通过复用控制。
- 线程模型与缓存是否匹配。
- Direct memory 的释放与监控是否可接受。
- 是否需要更简单、更容易定位的分配路径。

当前篇只建立策略切换的接口事实，不为所有业务给出脱离负载数据的固定答案。Allocator SPI 的意义正是让这些选择停留在策略层，而不是渗透到每个 Handler。

## 五、返回 ByteBuf 前，allocator 还会接上一层诊断包装

### 1. 为什么包装应该发生在分配边界

引用计数能让 ByteBuf 确定性释放，但它也带来一个新责任：如果某个使用者忘记 release，内存就不会按预期归还。

如果让业务代码自己决定什么时候包装泄漏检测器，会出现两个问题：一是调用方容易遗漏，二是不同调用点的诊断行为不一致。更自然的边界是 allocator：它刚创建对象，正好知道这个对象要交给谁，也能在返回前统一决定是否装饰。

`AbstractByteBufAllocator.toLeakAwareBuffer(...)` 先让 leak detector 尝试跟踪原始 ByteBuf；如果成功，再根据 `isRecordEnabled()` 选择 Advanced 或 Simple 包装，见 `AbstractByteBufAllocator.java:36-49`。CompositeByteBuf 使用另一组对应的包装器，见 `AbstractByteBufAllocator.java:52-62`。

```text
创建原始 ByteBuf
  -> leakDetector.track(buf)
  -> 没有 tracker：原样返回
  -> 有 tracker 且记录开启：AdvancedLeakAwareByteBuf
  -> 有 tracker 但不记录完整操作：SimpleLeakAwareByteBuf
```

这就是 Decorator：调用方仍然拿到 ByteBuf 接口，但返回对象可能在外面多了一层诊断行为。

### 2. Advanced 与 Simple 这里只需要知道差异边界

本篇不展开泄漏检测器的采样算法和报告格式，只保留分配边界必须知道的差异：

- Simple 包装提供较轻的生命周期跟踪。
- Advanced 包装会记录更多操作信息，便于在泄漏报告中还原使用路径。
- 是否真的发生包装，受 leak detector 是否返回 tracker 影响。
- Composite 需要独立包装类型，因为它不是普通 ByteBuf 的具体委托结构。

Unpooled direct 创建路径还会先根据 `disableLeakDetector` 决定是否进入 LeakAware 包装，见 `UnpooledByteBufAllocator.java:89-98`。这说明“allocator 统一包装”与“具体 allocator 允许关闭检测”可以同时存在：公共机制提供默认边界，策略实现保留配置出口。

还有一个细节值得记住：抽象 allocator 在静态初始化时把 `toLeakAwareBuffer` 加入 ResourceLeakDetector 的排除列表，见 `AbstractByteBufAllocator.java:36-38`。否则检测器追踪自己包装对象的过程，可能把诊断逻辑再次纳入追踪，形成递归或噪声。

### 3. 包装改变的是观察能力，不是 ownership 规则

LeakAware 包装不会替调用者自动 release。它只能在引用计数操作和配置的内容操作发生时记录线索，并在发现泄漏时提供更好的定位信息。

因此这条关系不能写反：

```text
retain/release：决定 ownership 与释放
LeakAware：观察 ownership 是否被正确使用
```

如果关闭泄漏检测，引用计数仍然存在；如果启用泄漏检测，也仍然必须配对 release。诊断层不能取代资源协议。

## 六、几个容易混淆的判断

### 1. `buffer()` 返回什么类型都不重要吗？

对只依赖 ByteBuf 公共读写协议的调用方来说，通常不需要知道具体类型；但如果代码依赖 `hasArray()`、内存地址或特定 I/O 互操作，就必须明确选择或检查能力，不能把“接口不承诺类型”误解成“所有实现能力完全相同”。

### 2. `ioBuffer()` 一定比 `buffer()` 好吗？

不一定。`ioBuffer()` 表达 I/O 用途，allocator 可能优先选择 direct；但它不是对所有场景都更快的保证。消息大小、访问方式、池化状态和平台释放能力都会改变结果。

### 3. 4 MiB 是所有 ByteBuf 的固定增长单位吗？

不是。它是当前 `AbstractByteBufAllocator.calculateNewCapacity` 的阈值。小于阈值走 2 的幂，大于阈值走步进；具体 allocator 配置、maxCapacity 和底层池化布局仍会影响最终容量。

### 4. Pooled 就意味着不会分配新内存吗？

不是。池化减少的是重复底层分配，不是让所有请求都不发生分配；池可能扩展、创建新的 chunk，缓存也可能失效或被裁剪。

### 5. LeakAware 会自动修复泄漏吗？

不会。它提供发现线索，不能替使用者补上一对缺失的 release。

## 收网：Allocator 是创建策略的边界

现在把整篇压回开头的问题：调用 `allocator.buffer(1024)` 时，谁决定得到什么？

答案不是某一个具体工厂方法，而是一条分层链：

```text
调用方
  -> 说“我要普通 buffer / I/O buffer / heap / direct / composite”
ByteBufAllocator SPI
  -> 保留意图，隐藏具体实现
AbstractByteBufAllocator
  -> 默认值、容量校验、direct/heap 分发、模板入口
具体 allocator
  -> Unpooled 或 Pooled，选择具体 ByteBuf 和底层策略
返回边界
  -> 按配置接入 Simple/Advanced LeakAware
```

当 ByteBuf 后续写不下时，第二条链接上：

```text
writableBytes 不足
  -> ensureWritable
  -> calculateNewCapacity
       小于 4 MiB：至少 64 的 2 次幂
       等于 4 MiB：精确返回阈值
       大于 4 MiB：按 4 MiB 步进并受 maxCapacity 限制
  -> capacity(newCapacity)
  -> 继续写
```

这说明 Allocator 并不是“负责 new 一个对象”的薄包装。它同时管理两个边界：

- 创建边界：调用者的意图如何落成 heap/direct、pooled/unpooled 的具体对象。
- 增长边界：ByteBuf 需要更多空间时，如何在复用、冗余、峰值和 maxCapacity 之间做决定。

上一篇回答的是“ByteBuf 如何把数据进度、空间和寿命拆开”；本篇继续回答“谁负责把这种协议创建出来，并统一决定它怎么长大”。

下一篇进入 Heap 与 Direct 的存储差异：Allocator 已经选定了具体方向，但 HeapByteBuf 和 DirectByteBuf 在分配、访问、扩容和释放四个维度上，到底为什么会走不同路径？