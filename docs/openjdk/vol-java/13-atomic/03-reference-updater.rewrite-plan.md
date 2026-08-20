# 13-atomic/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `AtomicReference`、`AtomicStampedReference`、`AtomicMarkableReference`、`AtomicIntegerFieldUpdater`。本文聚焦引用 CAS、ABA 版本化、mark 语义、FieldUpdater 的内存节约与使用约束；不展开 AQS、无锁链表完整实现与序列化深坑。
> 目标：把“引用原子与 FieldUpdater”改写成一篇围绕“CAS 不只会改数字，还能改引用和现有对象字段，但代价是 ABA、内存语义细节和访问约束”的机制文章。

## 1. 读者困惑

- `AtomicReference` 和 `volatile` 引用到底差在哪？
- 为什么“整体替换不可变对象”经常比“改对象内部字段”更适合并发配置更新？
- ABA 为什么在计数器上无感，在引用结构上却致命？
- `AtomicStampedReference` 的 stamp 为什么要和引用一起打包？
- `AtomicMarkableReference` 与 Stamped 解决的是同一个问题吗？
- 已有对象字段能不能不包一层 `AtomicInteger` 也做原子更新？
- FieldUpdater 为什么能省内存，又为什么它的保证比 AtomicInteger 更弱？

## 2. 一句话顿悟

**原子数值类解决的是“一个值”的 CAS；原子引用类把同一套 CAS 语义套到对象引用上，用于无锁整体替换与指针更新；当引用会遇到 ABA，就给它再绑一个 stamp 或 mark 一起 CAS。FieldUpdater 则进一步把‘每个对象带一个原子包装’改写成‘所有对象共享一个 updater，对某个 `volatile` 字段按偏移做 CAS’，用 API 复杂度和约束换取内存节省。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `AtomicReference`、`AtomicStampedReference`、`AtomicMarkableReference`、FieldUpdater 的主用途与关键源码。
- 已点出 ABA 的计数器/引用场景差异，以及 FieldUpdater 的“省包装对象”价值。
- 已有选型矩阵，可保留为结尾收束。

### 必须重写

- 旧稿容易像“原子家族百科”，应先立一个统一问题：CAS 从数值扩展到引用与字段时，多了哪些新问题。
- `AtomicReference` 需要突出“不可变对象整体替换”的核心工程模式，而不只是 API 罗列。
- Stamped/Markable 要讲成“为什么单值 CAS 在引用结构上会失真”，而不是先背名字。
- FieldUpdater 要把“共享 updater + 目标字段必须 volatile + 只能保证通过 updater 的操作彼此原子”讲成一套边界，不只是省内存一句话。
- 要明确 `AtomicReference` 用 VarHandle，而 `AtomicInteger` 上篇用了 Unsafe，这是两代门面的差异而不是语义变化。

## 4. 理解路径

### 第一节：先从“配置对象怎么无锁热更新”切入

用一个最直观场景：配置对象、游标、链表头节点不是数字，怎么原子替换？引出 `AtomicReference` 的角色：把“整体引用”当成 CAS 单位。

### 第二节：AtomicReference 为什么与 AtomicInteger 同构，但语义更偏“对象切换”

证据：
- `AtomicReference.java:43-63`：类注释 + `VarHandle VALUE` + `volatile V value`
- `AtomicReference.java:86-98`：`get` / `set`
- `AtomicReference.java:121-123`：`compareAndSet`
- `AtomicReference.java:167-170`：`getAndSet`
- `AtomicReference.java:183-240`：`getAndUpdate` / `updateAndGet` / `getAndAccumulate`

主线：
- 结构上和 AtomicInteger 同构：一个 volatile 字段 + 一个 CAS 门面。
- 不同的是值语义：这里 CAS 的单位是“整段引用”，而不是数值。
- 典型模式：不可变对象整体替换；读线程只拿完整旧对象或完整新对象，不会看到半更新状态。

### 第三节：为什么 ABA 在引用场景才真正致命

主线：
- 计数器里 A→B→A 往往等价于“最终值还是 A”，中间过程对语义无害。
- 引用结构里 A→B→A 可能意味着旧节点被摘走、复用、再放回，状态早已变了。
- 因此引用 CAS 必须额外携带“版本”或“标记”信息，才能区分“值相同”与“历史未变”。

### 第四节：AtomicStampedReference 如何把“引用 + 版本戳”绑成一个 CAS 单位

证据：
- `AtomicStampedReference.java:41-67`：类注释、`Pair<T>`、`volatile pair`
- `AtomicStampedReference.java:106-109`：`get(int[] stampHolder)`
- `AtomicStampedReference.java:148-159`：`compareAndSet`
- `AtomicStampedReference.java:167-170`：`set`
- `AtomicStampedReference.java:186-191`：`attemptStamp`
- `AtomicStampedReference.java:194-208`：`PAIR` VarHandle 与 `casPair`

主线：
- 不是两个独立字段，而是把 reference 与 stamp 打成不可变 Pair，再整体 CAS。
- CAS 成功条件从“值相等”升级到“引用和版本都相等”。
- 这样 A-1 → B-2 → A-3 就不再骗过期望 A-1 的线程。

### 第五节：AtomicMarkableReference 为什么只要布尔标记

证据：
- `AtomicMarkableReference.java:41-67`：类注释、`Pair<T>`、`mark`
- `AtomicMarkableReference.java:106-109`：`get(boolean[] markHolder)`
- `AtomicMarkableReference.java:148-159`：`compareAndSet`
- `AtomicMarkableReference.java:186-191`：`attemptMark`

主线：
- Stamped 适合关心“改过多少次 / 版本必须精确区分”的场景。
- Markable 适合只关心“这个引用是不是已经被逻辑删除/标记过”。
- 两者都用“打包 Pair 一起 CAS”的套路，只是辅助信息的粒度不同。

### 第六节：FieldUpdater 到底省了什么内存

证据：
- `AtomicIntegerFieldUpdater.java:51-63`：类注释，强调适用于同一节点多个字段、保证更弱
- `AtomicIntegerFieldUpdater.java:90-95`：`newUpdater`
- `AtomicIntegerFieldUpdater.java:143-162`：`set/lazySet/get`
- `AtomicIntegerFieldUpdater.java:172-276`：默认 CAS 循环派生操作
- 需补读实现类中反射校验和 `offset` 的精确段（上一轮旧稿已定位在 416-434、489-492，可重读或在正文谨慎引用）

主线：
- 每个对象都包一个 AtomicInteger，会多一个对象头、引用和分配成本。
- FieldUpdater 把“原子能力”提到类静态层：所有对象共享一个 updater，真正的状态仍存在原对象字段里。
- 这是典型的“空间换 API 简洁度”：对象更省，使用更绕。

### 第七节：FieldUpdater 的使用边界为什么比 AtomicInteger 更苛刻

需要补充实现类源码证据：
- 字段必须是 `volatile int`
- 有反射访问控制检查
- offset 由 `Unsafe.objectFieldOffset(field)` 获取
- `compareAndSet` 前有 `accessCheck`

主线：
- updater 不能强制所有人都通过它访问该字段，所以它只能保证“走这个 updater 的 compareAndSet / set 之间”的原子性。
- 直接对字段做普通写，仍能破坏更高层语义。
- 这比 AtomicInteger 自带封装边界更弱，但换来的是显著内存节约。

### 第八节：收束到原子家族选型

按三个问题收束：
1. 更新的是数值还是引用？
2. 是否存在 ABA 语义风险？
3. 能否接受每对象一个包装，还是必须压缩内存？

用矩阵收口：AtomicInteger / LongAdder / AtomicReference / Stamped / Markable / FieldUpdater / Atomic*Array。

## 5. 失败方案清单

1. 用 `volatile` 引用代替 `AtomicReference.compareAndSet` 做条件替换。
2. 在无锁链表/栈头指针更新场景只用 `AtomicReference`，忽略 ABA。
3. 把 `AtomicStampedReference` 当成“更慢的 AtomicReference”，却不知道它解决的是版本一致性。
4. 用 FieldUpdater 却让目标字段不是 `volatile` 或随手做普通写。
5. 在千万级对象上给每个实例塞一个 AtomicInteger，忽略对象包装开销。
6. 用有副作用的函数配合 `getAndUpdate` / `updateAndGet`。

## 6. 误解清单

1. 原子引用类只是“把 int 换成对象”这么简单，没有新问题。
2. ABA 只要 CAS 成功就说明没问题。
3. Stamped 和 Markable 是同一个东西，随便选一个都行。
4. FieldUpdater 和 AtomicInteger 一样强，只是写法不同。
5. FieldUpdater 不会走反射和访问检查。
6. AtomicReference 比 `volatile` 引用强的地方只是“读得更快”。

## 7. 证据清单

- `AtomicReference.java:43-63`：类注释、VarHandle、`volatile value`
- `AtomicReference.java:86-98`：`get` / `set`
- `AtomicReference.java:121-123`：`compareAndSet`
- `AtomicReference.java:167-170`：`getAndSet`
- `AtomicReference.java:183-240`：函数式更新 API
- `AtomicStampedReference.java:41-67`：类注释 + `Pair` + `pair`
- `AtomicStampedReference.java:106-109`：`get(stampHolder)`
- `AtomicStampedReference.java:148-159`：`compareAndSet`
- `AtomicStampedReference.java:167-170`：`set`
- `AtomicStampedReference.java:186-191`：`attemptStamp`
- `AtomicStampedReference.java:194-208`：`PAIR` VarHandle / `casPair`
- `AtomicMarkableReference.java:41-67`：类注释 + `Pair` + `pair`
- `AtomicMarkableReference.java:106-109`：`get(markHolder)`
- `AtomicMarkableReference.java:148-159`：`compareAndSet`
- `AtomicMarkableReference.java:186-191`：`attemptMark`
- `AtomicIntegerFieldUpdater.java:51-63`：类注释与更弱保证
- `AtomicIntegerFieldUpdater.java:90-95`：`newUpdater`
- `AtomicIntegerFieldUpdater.java:103-162`：抽象 API 语义
- `AtomicIntegerFieldUpdater.java` 实现类中字段检查/offset/CAS（重写时补精确行号）

## 8. 版本与边界

- 基于 JDK 11。
- 不展开无锁链表完整算法，只用它解释 ABA 的现实危害。
- 不在本文深入 VarHandle / Unsafe 演进史，只在必要处点明门面差异。
- 不展开 `AtomicReferenceArray` 和 `AtomicLongFieldUpdater` 的全部对称实现，只在收束矩阵中点名。

## 9. 删除代码测试与最终验收标准

- 删除源码块后，读者仍能复述“AtomicReference 用 CAS 替换整段引用 → ABA 在引用场景致命 → Stamped 用引用+版本戳一并 CAS，Markable 用引用+布尔标记 → FieldUpdater 让现有对象字段获得原子更新能力，但前提是 volatile 字段且保证范围更弱”。
- 必须把 ABA 的‘为什么在引用场景致命’讲具体，而不只是定义。
- 必须说明 FieldUpdater 省的是‘每对象一个包装对象’的内存。
- 必须明确 AtomicReference 与 FieldUpdater 都是把 CAS 套到不同载体上：一个是独立对象字段，一个是已有对象字段。
- 结尾要自然收束到原子家族全景与后续并发主题。
