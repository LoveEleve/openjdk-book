# 32-unsafe/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `sun.misc.Unsafe` 与 `jdk.internal.misc.Unsafe` 的 CAS、`getAndAdd*`、`park/unpark`、fence 原语。本文聚焦无锁更新模板、线程停放许可语义与内存有序性；AQS 和原子类的更高层实现已在前文，不重复展开。
> 目标：把“CAS 原语与线程控制”改写成一篇围绕“Unsafe 在并发里提供的不是现成锁或同步器，而是三块更底层的地基：原子比较交换、线程停放许可、以及内存顺序屏障；JDK 上层并发大厦正是把这三块原语组装成原子类、AQS、线程池和并发容器”展开的机制文章。

## 1. 读者困惑

- Unsafe 提供了 CAS，为什么这还不等于“并发问题解决了”？
- `compareAndSet` 和 `getAndAdd` 的关系是什么，为什么后者本质上是 CAS 自旋模板？
- weak CAS 为什么明明可能“假失败”，却依然大量出现在内部循环里？
- `park/unpark` 为什么不是 `wait/notify` 的换皮，而是另一套许可模型？
- 为什么只有原子更新还不够，还需要 `loadFence/storeFence/fullFence` 这种看不见值变化的原语？

## 2. 一句话顿悟

**Unsafe 在并发里真正提供的是三块底层杠杆：CAS 负责“一个位置如何被原子更新”，`park/unpark` 负责“一个线程何时可以停下或被唤醒”，fence 负责“这些读写在内存里按什么顺序被看见”。原子类、AQS、并发容器之所以成立，不是因为 Unsafe 给了现成高层结构，而是因为它把这三件最底层的控制权交给了 JDK。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 compareAndSet、getAndAdd、自旋、ABA、park/unpark 与 fence，素材点是完整的。
- 已正确指出 `park/unpark` 是许可模型，不是监视器模型。
- 已把 fence 放进并发原语总图，而不是孤立补充。

### 必须重写

- 旧稿偏知识点平铺，需要先立住总问题：Unsafe 在并发里到底补的是哪三块地基。
- CAS 与 `getAndAdd` 要放到“原子更新模板”这条线上统一讲。
- ABA 要作为 CAS 局限性的结果，而不是单独背面试陷阱。
- fence 要讲成“原子更新之外还需要可见性/顺序控制”，否则容易变成零散 API 罗列。

## 4. 理解路径

### 第一节：从“为什么有了 CAS 还不等于有了并发库”开场

先立总问题：并发不仅是改值，还要决定线程什么时候停、什么时候醒、读写按什么顺序可见。Unsafe 提供的是地基，不是成品。

### 第二节：CAS 为什么是原子更新的最小地基

证据：
- `sun.misc.Unsafe.java:859/875/891`
- `jdk.internal.misc.Unsafe.java:1300/1361/1908`

主线：
- compareAndSet 的核心是“比较 + 交换”作为单步原子动作。
- 它适合乐观并发，失败由调用者决定后续策略。
- 这解释了为什么原子类、CHM、同步器状态字段都以它为底座。

### 第三节：`getAndAdd` 为什么本质上是 CAS 自旋模板

证据：
- `sun.misc.Unsafe.java:1105/1121/1137`
- `jdk.internal.misc.Unsafe.java:2334/2372/2569`
- `jdk.internal.misc.Unsafe.java:1406/1953`

主线：
- 读取旧值 → 计算新值 → weak CAS 提交 → 失败重试。
- weak CAS 在循环里可接受，因为外层本来就会重试。
- 这说明很多“现成原子操作”本质上只是 CAS 循环模板的封装。

### 第四节：ABA 为什么暴露了 CAS 的天然盲区

主线：
- CAS 只比对当前值是否等于期望值，不记录历史。
- 这让引用结构比纯计数器更容易被 ABA 伤到。
- 解决方向是把版本/标记也纳入原子比较对象。

### 第五节：`park/unpark` 为什么是线程许可原语，而不是监视器等待模型

证据：
- `sun.misc.Unsafe.java:1050/1066`
- `jdk.internal.misc.Unsafe.java:2280/2294`

主线：
- park/unpark 直接面向线程，不要求先占有锁对象。
- 许可可先发后用，这和 `wait/notify` 的对象监视器模型不同。
- 这正是 AQS / LockSupport 能精细挂起特定线程的原因。

### 第六节：为什么 CAS 和 park 之外还需要 fence

证据：
- `sun.misc.Unsafe.java:1187/1204/1218`
- `jdk.internal.misc.Unsafe.java:3288/3303/3315`

主线：
- 原子更新只解决“这一写是否原子”，不自动解决所有重排与可见性问题。
- fence 提供读写顺序边界，补齐并发协议中的有序性控制。
- 这把 Unsafe 并发原语收束成“改值、停线程、控顺序”三件套。

## 5. 失败方案清单

1. 以为有了 compareAndSet 就天然有完整并发协议。
2. 把 `getAndAdd` 当成硬件直接提供的高级语义，不看其 CAS 自旋本质。
3. 忽略 ABA，在引用结构上只按值相等判断安全性。
4. 把 `park/unpark` 当成 `wait/notify` 的别名使用。
5. 只关注原子性，不考虑可见性与重排边界。

## 6. 误解清单

1. CAS 失败就说明并发算法有 bug。
2. weak CAS 因为可能假失败，所以没有实际价值。
3. `unpark` 必须等线程已经 `park` 才有效。
4. fence 是性能优化细节，不影响并发正确性。
5. Unsafe 已经提供了并发原语，所以业务代码直接用它最简单。

## 7. 证据清单

- `sun.misc.Unsafe.java:859/875/891/1050/1066/1105/1121/1137/1187/1204/1218`
- `jdk.internal.misc.Unsafe.java:1300/1361/1406/1908/1953/2280/2294/2334/2372/2569/3288/3303/3315`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇不重复展开 AQS/AtomicInteger 的完整上层逻辑，只解释它们依赖的底层原语。
- 不扩展到 VarHandle 全景，只以 Unsafe 版本收束本域。
- 不把硬件指令级实现展开到汇编级别。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 Unsafe 在并发里提供的是三块地基 → CAS 如何支撑原子更新 → `getAndAdd` 为什么是 CAS 自旋模板 → ABA 暴露了什么局限 → `park/unpark` 为什么是许可模型 → fence 为什么补齐有序性控制”。
- 必须把 CAS / park / fence 讲成同一张并发地基图。
- 必须自然收束 `32-unsafe` 全域。
