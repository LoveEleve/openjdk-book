# Ch5-03 FastThreadLocal、InternalThreadLocalMap 与 Recycler — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `FastThreadLocal` 当前类注释明确：只有在 `FastThreadLocalThread` 上才走数组槽位 fast path，其他线程回退到普通 `ThreadLocal`，证据：`common/src/main/java/io/netty/util/concurrent/FastThreadLocal.java:28`。  
2. 每个 `FastThreadLocal` 当前都会通过 `InternalThreadLocalMap.nextVariableIndex()` 分配一个全局索引，证据：`common/src/main/java/io/netty/util/concurrent/FastThreadLocal.java:126`。  
3. `get()` / `initialize()` 当前会把值放进 `InternalThreadLocalMap` 的 indexedVariables，并登记到 `variablesToRemove`，证据：`common/src/main/java/io/netty/util/concurrent/FastThreadLocal.java:136`、`:175`。  
4. `removeAll()` 当前会统一遍历本线程已登记的 `FastThreadLocal` 并最终移除整个 `InternalThreadLocalMap`，证据：`common/src/main/java/io/netty/util/concurrent/FastThreadLocal.java:49`。  
5. `InternalThreadLocalMap` 当前不只保存 indexedVariables，还保存 `futureListenerStackDepth`、`localChannelReaderStackDepth`、`handlerSharableCache`、`TypeParameterMatcher` cache、`StringBuilder`、charset encoder/decoder cache、ArrayList cache 等，证据：`common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:66`。  
6. `InternalThreadLocalMap` 当前对 `FastThreadLocalThread` 走 `fastGet()`，其他线程走 `slowGet()`，证据：`common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:110`、`:119`、`:127`。  
7. `stringBuilder()` 当前会复用已有 builder，并在容量过大时主动收缩，证据：`common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:213`。  
8. charset encoder/decoder cache 与 `arrayList()` 当前都体现了线程本地复用策略，证据：`common/src/main/java/io/netty/util/internal/InternalThreadLocalMap.java:226`、`:242`。  
9. `Recycler` 当前类注释明确：它是基于 thread-local stack 的轻量对象池，证据：`common/src/main/java/io/netty/util/Recycler.java:39`。  
10. `Recycler` 当前会读取 `maxCapacityPerThread`、`ratio`、`chunkSize`、`blocking`、`batchFastThreadLocalOnly` 等参数，证据：`common/src/main/java/io/netty/util/Recycler.java:77`。  
11. `Recycler.get()` 当前在不满足 `FastThreadLocalThread.currentThreadWillCleanupFastThreadLocals()` 时会直接回退到 `newObject(NOOP_HANDLE)`，证据：`common/src/main/java/io/netty/util/Recycler.java:303`。  
12. `Recycler` 的 `threadLocalPool` 当前会在 `onRemoval(...)` 中清空池句柄并解除 owner 关联，证据：`common/src/main/java/io/netty/util/Recycler.java:272`、`:279`。  
13. `ObjectPool.newPool(...)` 当前内部直接 new 一个 `Recycler`，证据：`common/src/main/java/io/netty/util/internal/ObjectPool.java:70`。  
14. `CodecOutputList` 当前使用 `FastThreadLocal<CodecOutputLists>` 缓存一批 list 实例，而不是每次新建 ArrayList，证据：`codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:38`。  
15. `TypeParameterMatcher.get/find` 当前直接把 matcher cache 存在 `InternalThreadLocalMap` 中，证据：`common/src/main/java/io/netty/util/internal/TypeParameterMatcher.java:31`、`:48`。

### 深审发现

1. **中风险：容易把 `FastThreadLocal` 写成对所有线程都更快。** 正文已明确它依赖 `FastThreadLocalThread` 和受控线程模型。  
2. **中风险：容易把 `InternalThreadLocalMap` 缩成“只是一个存值数组”。** 正文已把字符串缓存、类型匹配器、listener 深度等一起立出来。  
3. **中风险：容易把 `Recycler` 写成“任何线程都值得池化”的通用对象池。** 正文已保留 cleanup、owner、受控线程和回退路径边界。  
4. **低风险：容易把 `ObjectPool` 写成另一套并列主线。** 正文已改成“兼容包装层”定位。

## 第二轮：因果审

- EventLoop 长寿命热点线程 + 高频 handler/codec 调用 -> 小成本会持续累积：✅  
- `FastThreadLocal` 通过索引化访问解决线程本地热点值访问：✅  
- `InternalThreadLocalMap` 负责承载整批线程级缓存和元信息，而不是单值 thread-local：✅  
- `Recycler` 解决的是受控线程模型里的短命热点对象复用，不是通用池化教条：✅  
- `CodecOutputList` / `TypeParameterMatcher` 证明这条基础设施线已经进入 codec 和反射热点：✅

## 第三轮：结构审

正文结构按“放回 Netty 运行时环境 -> 为什么重写 thread-local -> `InternalThreadLocalMap` 运行时容器 -> removeAll 清理边界 -> `Recycler` 目标 -> owner/cleanup 约束 -> `ObjectPool` 兼容层 -> `CodecOutputList` / `TypeParameterMatcher` 落地 -> 收网”推进，没有按类文件顺序平铺。✅

失败方案已覆盖：
- 全靠普通 `ThreadLocal`  
- 全靠 `new` + GC  
- 任意线程统一走对象池  
- 把所有缓存拆成零散静态变量  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `FastThreadLocal` 解决的是受控线程模型下的索引化访问  
- `InternalThreadLocalMap` 是 Netty 线程级运行时容器  
- `Recycler` 解决的是热点短命对象的受控复用  
- 这套基础设施同时强调 cleanup 边界，不只是强调快  
- `CodecOutputList` / `TypeParameterMatcher` 证明它已经渗入真实热点路径  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把 `FastThreadLocal` 写成无条件比 `ThreadLocal` 快。✅  
- 未把 `InternalThreadLocalMap` 缩减成只给 `FastThreadLocal` 存值。✅  
- 未把 `Recycler` 写成跨线程随便复用对象的无约束池。✅  
- 未深入 jctools 队列细节，只聚焦这套基础设施的设计意图。✅

## 第六轮：依赖审

- 依赖 EventLoop 热点线程背景，真实存在。✅  
- 依赖 Pipeline / codec 热点背景，真实存在。✅  
- 依赖 Ch4-06 的 ownership 前置，真实存在。✅  
- 后续 memory pool / write task / outbound buffer 使用方只作桥接，没有把后文结论当前置。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 禁用词复查：0 命中。✅  
- 术语复查：`fast path`、`cleanup`、`thread-local object pool`、`thread-local stack`、`isolated optimization`、`哈希表查找` 均已处理。✅  
- 正文字符数：约 11,272。  
- 去掉常见 markdown 标记后的字符数：约 10,875。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经建立 `FastThreadLocal -> InternalThreadLocalMap -> Recycler` 这条热点运行时基础设施主线，并明确它不是并发小专题，而是 Netty 热点运行时的公共底盘。Ch5-03 可作为后续内存池线程缓存、write task 复用和更多对象池使用方分析的直接前置篇。