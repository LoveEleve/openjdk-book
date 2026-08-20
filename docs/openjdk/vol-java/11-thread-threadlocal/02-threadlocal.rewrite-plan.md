# 11-thread-threadlocal/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ThreadLocal`、`ThreadLocalMap`、`InheritableThreadLocal`。本文聚焦值存储位置、`get/set/remove`、弱 key 强 value、开放寻址与清理链、继承时机与线程池失效边界；不展开阿里 TTL 内部实现，只用它说明局限。
> 目标：把“ThreadLocal 原理与内存泄漏”改写成一篇围绕“为什么值不存在线程局部栈里，而要挂在线程对象上的专用 map；又为什么这个设计会在长寿命线程上留下泄漏与值串用风险”的机制文章。

## 1. 读者困惑

- `ThreadLocal` 说是“线程本地变量”，值到底存在哪，为什么不是直接存在 `ThreadLocal` 对象里？
- 为什么同一个 `ThreadLocal` 能被很多线程共享，却互不影响？
- `ThreadLocalMap.Entry` 为什么要让 key 用弱引用，value 却还是强引用？
- 既然 key 是弱引用，为什么线程池里还是会内存泄漏？
- JDK 自己什么时候清理这些脏槽，为什么还要求业务代码手动 `remove()`？
- `0x61c88647` 这个常量在干什么，为什么这里不用普通 `HashMap`？
- `InheritableThreadLocal` 为什么在 `new Thread()` 好使，到线程池里却经常失效？

## 2. 一句话顿悟

**ThreadLocal 的关键不是“每线程一份变量”这句口号，而是：值并不存在线程局部栈里，也不存在线程共享的 `ThreadLocal` 对象里，而是存放在每个 `Thread` 自己的 `ThreadLocalMap` 中；这个设计天然免锁，但也把值的生命周期绑到了线程上。在线程池这类长寿命线程场景里，如果不主动 `remove()`，弱 key 只能让 `ThreadLocal` 对象自己被回收，却挡不住 value 和脏槽继续挂在活着的线程上。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `Thread.threadLocals` / `inheritableThreadLocals`、`Entry extends WeakReference`、黄金分割哈希、开放寻址、脏槽清理链和线程池泄漏根因。
- 已讲到 `InheritableThreadLocal` 是创建时复制而非后续同步，这个边界抓得对。
- 已指出泄漏的不是真正的 key，而是 value 与长寿命线程上的残留槽位。

### 必须重写

- 旧稿更像知识点堆叠，需要先建立“值到底存在哪、为什么放那里”的总问题。
- 弱引用和泄漏要讲成一组失败方案推演：强 key 更糟，弱 key 仍不足，remove 才是根治。
- 哈希常量、开放寻址、清理链要回到“为什么 ThreadLocalMap 不像普通 HashMap”这一设计题里，而不是各讲各的。
- `InheritableThreadLocal` 应作为“线程生命周期边界”的延伸，回扣上一篇 `start/new Thread`，避免孤立附录化。
- 必须明确区分“被动清理”和“主动 remove”的责任边界。

## 4. 理解路径

### 第一节：从“值到底存在哪”这个最常见误解开场

用面试/生产困惑开场：很多人以为值在 `ThreadLocal` 对象自己身上，或者以为在线程栈里。先指出真正问题：一个 `ThreadLocal` 会被很多线程共享，但每个线程都要看到自己版本的值，这决定了存储位置必须是“按线程分桶”的结构。

### 第二节：为什么值挂在线程对象上，而不挂在 ThreadLocal 自己身上

证据：
- `Thread.java:180`：`threadLocals`
- `Thread.java:186`：`inheritableThreadLocals`
- `ThreadLocal.java:161`：`get`
- `ThreadLocal.java:194`：`setInitialValue`
- `ThreadLocal.java:218`：`set`
- `ThreadLocal.java:264`：`createMap`

主线：
- 当前线程先通过 `Thread.currentThread()` 取到自己，再在自己的 `threadLocals` 上找值。
- `ThreadLocal` 对象只是 key，真正的 value 在当前线程的 `ThreadLocalMap` 里。
- 这样设计后，同一个 `ThreadLocal` 可被多线程共享，而值天然按线程隔离，不需要锁。

### 第三节：ThreadLocalMap 为什么不用普通 HashMap ——开放寻址、小数组和固定 key 模式

证据：
- `ThreadLocal.java:87`：`threadLocalHashCode`
- `ThreadLocal.java:101`：`HASH_INCREMENT`
- `ThreadLocal.java:319`：`ThreadLocalMap`
- `ThreadLocal.java:329`：`Entry`
- `ThreadLocal.java:342`：`INITIAL_CAPACITY`
- `ThreadLocal.java:348`：`table`

主线：
- 每个线程有自己的小 map，访问模式偏向少量键、频繁按当前 key 查找。
- 因此 JDK 选了开放寻址数组而不是通用 HashMap 桶链结构。
- `0x61c88647` 让连续创建的 `ThreadLocal` key 在 2 的幂数组中分布更均匀，降低线性探测聚集。
- 这一节不是数学课，重点是把它讲成“为线程私有小表量身定做”的存储结构选择。

### 第四节：为什么 key 是弱引用，value 却还是会泄漏

证据：
- `ThreadLocal.java:329-333`：`Entry extends WeakReference<ThreadLocal<?>>`
- `Thread.java:848-849`：线程退出时清空 `threadLocals` / `inheritableThreadLocals`

主线：
- 先推演强 key 失败方案：如果 Entry 强引用 `ThreadLocal`，外部把 ThreadLocal 变量置空也回收不掉 key，本体更糟。
- JDK 改成弱 key，让 ThreadLocal 对象本身可被 GC。
- 但 value 仍由 Entry 强持有，只要线程活着、槽位还在，value 就不会自动跟着 key 一起消失。
- 因此弱 key 只是降低“key 永远活着”的风险，不等于 value 已经安全释放。

### 第五节：JDK 自己怎么清理脏槽，为什么 remove 仍然是必需品

证据：
- `ThreadLocal.java:239`：`remove`
- `ThreadLocal.java:460`：`expungeStaleEntry`
- `ThreadLocal.java:540`：`replaceStaleEntry`
- `ThreadLocal.java:669`：`cleanSomeSlots`
- `ThreadLocal.java:690`：`rehash`
- `ThreadLocal.java:701`：`resize`

主线：
- 脏槽清理不是后台线程主动巡检，而是 get/set/rehash 过程中“顺路清理”。
- `expungeStaleEntry` 会清 value 并重排后续探测链；`cleanSomeSlots` 是启发式扫描；`replaceStaleEntry` 遇到脏槽时原地替换。
- 被动清理意味着：如果线程长期活着但后续很少再碰那段探测路径，残留 value 可能挂很久。
- 因此业务 finally 里 `remove()` 不是锦上添花，而是主动结束这次线程绑定值的生命周期。

### 第六节：线程池为什么最容易把问题放大成“泄漏 + 串值”

证据：
- `Thread.java:848-849`：线程退出才整体清空 map

主线：
- 普通短命线程结束后，整张 `threadLocals` 跟着线程对象一起收掉，问题常被掩盖。
- 线程池 worker 长时间复用，线程不结束，map 就不结束。
- 如果任务没 `remove()`，不只是 value 占内存，还可能让后续任务读到前一个任务留下的值。
- 所以线上比“内存泄漏”更早爆出来的，常常其实是“上下文串值”。

### 第七节：InheritableThreadLocal 为什么在 new Thread 有效、在线程池失效

证据：
- `Thread.java:443-445`：构造器里复制 `inheritableThreadLocals`
- `ThreadLocal.java:275`：`createInheritedMap`
- `InheritableThreadLocal.java:53`：类定义
- `InheritableThreadLocal.java:66`：`childValue`
- `InheritableThreadLocal.java:75`：`getMap`
- `InheritableThreadLocal.java:85`：`createMap`

主线：
- 继承发生在线程构造阶段，而不是任务提交阶段。
- 子线程拿到的是父线程当时值的副本，不会后续联动更新。
- 线程池复用线程时没有“重新构造线程”这一步，所以不会重新继承。
- 这把上一篇 `start/new Thread` 的生命周期边界和 ThreadLocal 继承问题收在一起。

## 5. 失败方案清单

1. 以为 ThreadLocal 的值存在 ThreadLocal 对象本身上。
2. 用强引用 key 实现线程本地 map，导致 ThreadLocal 对象本身永远回收不掉。
3. 只把外部 ThreadLocal 变量设为 null，却不主动 `remove()`，期待 value 自动消失。
4. 在长寿命线程池任务里使用 ThreadLocal 后不清理。
5. 把 ThreadLocalMap 当普通 HashMap，忽略开放寻址和探测链重排约束。
6. 以为 `InheritableThreadLocal` 会自动跨线程池任务传播上下文。
7. 以为“线程本地”就等于“绝不会泄漏”。

## 6. 误解清单

1. ThreadLocal 的值放在线程栈里，所以线程退出前不会有额外对象残留。
2. key 用了弱引用，就说明 value 也会自动一并释放。
3. JDK 有清理链，所以业务代码不必 `remove()`。
4. 线程池里的问题只是内存泄漏，不会影响业务正确性。
5. `0x61c88647` 只是随便挑的魔法数。
6. `InheritableThreadLocal` 和 `ThreadLocal` 只是 API 名字不同，内部没区别。
7. 线程结束时清空 map，说明所有场景都不会出问题。

## 7. 证据清单

- `Thread.java:180`：`threadLocals`
- `Thread.java:186`：`inheritableThreadLocals`
- `Thread.java:443-445`：继承 map 复制
- `Thread.java:848-849`：线程退出时清空 map
- `ThreadLocal.java:87`：`threadLocalHashCode`
- `ThreadLocal.java:101`：`HASH_INCREMENT`
- `ThreadLocal.java:161`：`get`
- `ThreadLocal.java:194`：`setInitialValue`
- `ThreadLocal.java:218`：`set`
- `ThreadLocal.java:239`：`remove`
- `ThreadLocal.java:264`：`createMap`
- `ThreadLocal.java:275`：`createInheritedMap`
- `ThreadLocal.java:319`：`ThreadLocalMap`
- `ThreadLocal.java:329-333`：`Entry`
- `ThreadLocal.java:342`：`INITIAL_CAPACITY`
- `ThreadLocal.java:348`：`table`
- `ThreadLocal.java:460`：`expungeStaleEntry`
- `ThreadLocal.java:540`：`replaceStaleEntry`
- `ThreadLocal.java:669`：`cleanSomeSlots`
- `ThreadLocal.java:690`：`rehash`
- `ThreadLocal.java:701`：`resize`
- `InheritableThreadLocal.java:53`：类定义
- `InheritableThreadLocal.java:66`：`childValue`
- `InheritableThreadLocal.java:75`：`getMap`
- `InheritableThreadLocal.java:85`：`createMap`

## 8. 版本与边界

- 基于 JDK 11。
- 本文讨论的是 Java 层 `ThreadLocalMap` 设计，不展开 `ScopedValue` 等后续版本替代方案。
- 不把弱引用讲成“自动无泄漏”，也不把清理链讲成后台定时回收器。
- `InheritableThreadLocal` 只解释 JDK 11 的构造期复制语义，不展开第三方上下文透传库内部实现。
- 线程池泄漏这里强调的是长寿命线程复用模型，不外推为“所有 ThreadLocal 都必泄漏”。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“值为什么挂在线程对象上 → ThreadLocalMap 为什么是开放寻址小表 → 弱 key 强 value 为什么仍会泄漏 → JDK 的清理链为什么只是被动补救 → 线程池为什么放大成泄漏和串值 → InheritableThreadLocal 为什么只在构造期复制有效”。
- 必须把弱引用与泄漏讲成一组失败方案推演。
- 必须讲清 `remove()` 的责任边界。
- 必须把 `InheritableThreadLocal` 回扣到线程创建时机，而不是孤立附录。
- 结尾要自然引到 `03-exception-random.md`。
