# Ch5-03 FastThreadLocal、InternalThreadLocalMap 与 Recycler — rewrite-plan

## 篇章定位

- 核心困惑：Netty 为什么老喜欢自己造 `FastThreadLocal`、`InternalThreadLocalMap`、`Recycler` 这一套？JDK `ThreadLocal`、普通 `new`、GC 不够用吗？为什么连 `CodecOutputList`、类型匹配器、字符串缓存这些看起来零碎的东西，也都往这条线上靠？
- 一句话顿悟：Netty 并不是为了“炫技地重写 JDK”，而是在高频事件循环线程上把三件事拆开处理：`FastThreadLocal` 为受控线程提供固定索引的线程本地访问路径，`InternalThreadLocalMap` 负责承载这批线程级缓存和 indexed variable，`Recycler` 负责把大量短命小对象纳入线程本地复用与受控归还。具体性能收益仍需结合基准和运行环境验证。
- 文章边界：本篇主讲 `FastThreadLocal`、`FastThreadLocalThread`、`InternalThreadLocalMap`、`Recycler`、`ObjectPool`、`CodecOutputList`、`TypeParameterMatcher` 这条基础设施链，回答“为什么需要这套运行时缓存和对象复用面”；不展开全部 jctools 队列实现细节，不完整展开每个使用方。

## 依赖

### HARD

- Ch5 EventLoop 前文：理解 Netty 大量热点代码都跑在长寿命 event loop 线程上。
- Ch7 Pipeline：理解 handler / codec / promise 等组件在同一线程上被高频调用。
- Ch4-06：理解对象生命周期和 ownership，不把“对象复用”误解成“跳过生命周期责任”。

### SOFT

- Ch10 codec：这里只借 `CodecOutputList` 说明 codec 也在吃这套基础设施红利。
- Ch6 promise：这里只借 `futureListenerStackDepth` 说明 `InternalThreadLocalMap` 里不只放业务缓存。

### NAV

- Ch8 memory pool：后续可桥接到 `PoolThreadCache` 和更多 thread-local cache 视角。
- 后续篇（待写）：`Recycler` 使用方，如 `ChannelOutboundBuffer.Entry`、write task 等。

## 素材事实卡片

### 卡片 A：`FastThreadLocal` 的优化目标

- 类注释：对 `FastThreadLocalThread` 走数组槽位快速路径，普通线程回退到普通 ThreadLocal。
- `index = InternalThreadLocalMap.nextVariableIndex()`：每个 FastThreadLocal 拿一个全局索引。
- `get()` / `initialize()`：不存在则在 `InternalThreadLocalMap` 的 indexedVariables 数组里初始化并登记到 `variablesToRemove`。
- `removeAll()`：不是只删一个变量，而是按当前线程已登记的 FastThreadLocal 集合统一清理。

### 卡片 B：`InternalThreadLocalMap` 不是“一个 threadlocal 值”，而是整个线程本地运行时容器

- 既有 `indexedVariables`，也有 `futureListenerStackDepth`、`localChannelReaderStackDepth`、`handlerSharableCache`、`TypeParameterMatcher` cache、`StringBuilder`、charset encoder/decoder cache、ArrayList cache。
- `fastGet()` 与 `slowGet()`：FastThreadLocalThread 走专用字段，其他线程回退到普通 ThreadLocal。
- `stringBuilder()` / charset cache / arrayList()：都表现出“高频、可重用、避免反复 new”的同一设计倾向。

### 卡片 C：`TypeParameterMatcher` 和 `CodecOutputList` 说明这套基础设施不是只服务并发包

- `TypeParameterMatcher.get/find` 直接把 matcher cache 放进 `InternalThreadLocalMap`。
- `CodecOutputList` 用 `FastThreadLocal` 缓存一批 list 实例，而不是每次 encode 都新建 ArrayList。
- 结论：这条线服务的是整个运行时热点面，不是某个单点组件。

### 卡片 D：`Recycler` 的真实目标

- 类注释：轻量对象池，基于线程本地栈和 local pool。
- 静态参数：`maxCapacityPerThread`、`ratio`、`chunkSize`、`batchFastThreadLocalOnly`。
- `get()`：优先从线程本地池取，若当前线程不会清理快速线程本地变量，则直接退回 `newObject(NOOP_HANDLE)`。
- 结论：Netty 并不是“任何线程都强行复用对象”，而是优先在受控线程模型里复用。

### 卡片 E：`ObjectPool` 只是过渡抽象，底层其实已经回收进 `Recycler`

- `ObjectPool.newPool()` 内部直接 new 一个 `Recycler`。
- 说明 ObjectPool 不是另一套并列机制，而是逐步被 Recycler 吞并/替代的兼容层。

## 理解路径

1. **从 EventLoop 热点现实开场**：不是所有框架都需要这套东西，但 Netty 的 event loop + handler + codec 热点足够密，普通 `ThreadLocal` 和短命小对象分配会反复出现在热路径上。
2. **先拆缓存面和对象池面**：`FastThreadLocal/InternalThreadLocalMap` 解决“线程本地高频访问”，`Recycler` 解决“短命小对象反复分配”。
3. **推演失败方案**：全靠普通 `ThreadLocal`、全靠 `new` + GC、跨线程无约束复用，分别会出什么问题。
4. **讲 `FastThreadLocal` 最小心智图**：数组槽位 + FastThreadLocalThread + removeAll 生命周期。
5. **讲 `InternalThreadLocalMap` 为什么是运行时容器**：不只是存一个值，而是承载整批缓存与运行时元信息。
6. **讲 `Recycler` 的约束性**：它不是魔法对象池，而是依赖线程模型、容量、比例和 cleanup 能力的受控复用。
7. **用 `CodecOutputList` / `TypeParameterMatcher` 收网**：证明这套基础设施已经渗入 codec 与反射型热点，不是并发包里的孤立实现。

## 失败方案推演

- 全靠普通 `ThreadLocal`：每次哈希查找和清理成本在热点线程上反复出现。
- 全靠 `new` + GC：短命小对象分配/回收在事件循环热点上变成持续噪声。
- 任意线程都统一走对象池：线程模型一乱，复用收益和清理安全性都不可控。
- 把所有缓存拆成零散静态变量：生命周期、清理点、跨组件复用都难统一。

## 文章结构与预算

1. 开场：为什么 Netty 要自己造这套基础设施（1000-1400 字）
2. 两大问题面：线程本地热点访问 vs 短命小对象复用（1400-1900 字）
3. `FastThreadLocal`：数组槽位、FastThreadLocalThread、removeAll（1800-2400 字）
4. `InternalThreadLocalMap`：运行时容器而不是单值 threadlocal（1800-2400 字）
5. `Recycler`：受控线程本地对象池的目标与边界（2200-2800 字）
6. `CodecOutputList` / `TypeParameterMatcher`：基础设施如何渗入 codec 热点（1400-1900 字）
7. 收网：桥到后续内存池和更多使用方（600-900 字）

目标：去掉代码块后的叙述性正文 9000-12000 字，最低不低于 8000 字。

## 证据清单

- `common/src/main/java/io/netty/util/concurrent/FastThreadLocal.java:28-188`
- `common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:63-302`
- `common/src/main/java/io/netty/util/Recycler.java:39-358`
- `common/src/main/java/io/netty/util/internal/ObjectPool.java:20-99`
- `codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:27-202`
- `common/src/main/java/io/netty/util/internal/TypeParameterMatcher.java:22-68`

## 边界清单

- 本篇不把 `FastThreadLocal` 写成对所有线程都更快；普通线程会回退到普通 ThreadLocal 路径。
- 本篇不把 `Recycler` 写成“池化总是更好”；必须保留线程模型和清理约束。
- 本篇不深入 jctools 队列细节，只聚焦 Netty 为什么要这套基础设施。
- 本篇不枚举所有使用方，只选 `CodecOutputList`、`TypeParameterMatcher` 这些足够说明问题的代表。

## 深审预警

- [ ] 不把 `FastThreadLocal` 说成无条件比 ThreadLocal 快。
- [ ] 不把 `InternalThreadLocalMap` 写成只给 `FastThreadLocal` 存值，它还承载很多运行时缓存。
- [ ] 不把 `Recycler` 写成“跨线程随便复用对象”的无约束对象池。
- [ ] 不把 `ObjectPool` 写成另一套独立新机制，要写出它当前更多是兼容包装层。