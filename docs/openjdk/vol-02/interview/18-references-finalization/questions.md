# 18 · ReferenceProcessor、Finalizer 与对象生命周期：深度题目

## 1. GC 为什么不能像扫描普通对象一样扫描 Reference 对象？

WeakReference、SoftReference、PhantomReference 的 referent 在 GC 遍历时为什么不能像普通字段一样跟着对象图走，而是必须被“截获”进 discovered 列表？

回答必须覆盖：

- 强可达、软可达、弱可达、虚可达、不可达的定义区别；
- `InstanceRefKlass::oop_oop_iterate_discovery` 与普通 `oop_iterate` 的差异；
- 发现成功时 referent 不再按强引用遍历的含义；
- 预检过滤：referent 已标记强可达时不发现、软引用当场裁决不发现；
- 为什么 discovered 列表借 Reference 对象自身的 `discovered` 字段串链，而不是独立存储。

追问：如果发现失败（退化为普通引用扫描），referent 会怎样被处理？为什么发现阶段不能预先判断 FinalReference 的复活语义？

源码入口：`share/oops/instanceRefKlass.inline.hpp:65`、`share/gc/shared/referenceProcessor.cpp:1146`、`share/gc/shared/referenceProcessor.hpp:267`。

## 2. 引用处理的四个阶段为什么必须按 Phase1→4 依次执行？

GC 在处理发现的引用时，SoftReference 重新考虑、Weak+Soft+Final 清理、Final 复活、Phantom 清理为什么必须是这个顺序，不能调换？

回答必须覆盖：

- Phase1 软引用重新考虑：根据 LRU 策略决定是否保留，保留的 referent 被 `make_referent_alive`；
- Phase2 清理：referent 已死 → `clear_referent` + `enqueue`，referent 还活着 → 移除并保持；
- Phase3 Final 复活：所有 FinalReference 的 referent 被强制 `make_referent_alive`；
- Phase4 Phantom 清理：referent 已死 → clear+enqueue，活/NULL → 移除；
- 为什么 Finalizer 的复活必须发生在 Phantom 之前，否则语义会崩坏。

追问：如果把 Phase2 和 Phase3 合并，Finalizer 的“复活”语义会在哪一步被破坏？如果 Phase1 决定不清除的软引用在 Phase2 又被重新判定，会出现什么冲突？

源码入口：`share/gc/shared/referenceProcessor.cpp:201`、`share/gc/shared/referenceProcessor.cpp:795`、`share/gc/shared/referenceProcessor.cpp:839`、`share/gc/shared/referenceProcessor.cpp:917`、`share/gc/shared/referenceProcessor.cpp:956`。

## 3. SoftReference 的 LRU 策略为什么不是“存活时间”而是“访问间隔的容忍度”？

`SoftRefLRUPolicyMSPerMB` 为什么不是“软引用对象最多存活多少秒”，而是“距上次访问的间隔不超过多少毫秒”？clock 和 timestamp 的推进机制是什么？

回答必须覆盖：

- `SoftReference` 的 `timestamp` 字段在每次 `get()` 时更新；
- `clock` 在每次 GC 时推进，`update_soft_ref_master_clock` 使用 `os::javaTimeNanos()/1e6`；
- `interval = clock - timestamp` 的含义：距上次访问的毫秒数；
- `_max_interval = heapMB × SoftRefLRUPolicyMSPerMB`；
- 设为 0 时等价于弱引用，不是“永不清理”。

追问：如果 `SoftRefLRUPolicyMSPerMB` 设得非常大，软引用对象会变成类似强引用吗？堆大小变化后，同一个软引用对象的保留时间为什么会改变？

源码入口：`share/gc/shared/referencePolicy.cpp:69`、`share/gc/shared/referenceProcessor.cpp:157`、`share/runtime/globals.hpp:1852`。

## 4. FinalReference 和 Finalizer 为什么能让对象“复活”？

Finalizer 线程等待执行 finalize() 的对象，为什么 GC 不能直接回收它们，而是必须让它们“复活”进存活集？

回答必须覆盖：

- FinalReference 的 referent 在 Phase2 中不清除也不入队，留在列表等待 Phase3 复活确认；
- Phase3 中 `process_final_keep_alive` 强制 `make_referent_alive`；
- `set_next_raw(obj, obj)` 自环标记非活跃的语义；
- 为什么 Finalizer 线程的 `remove()` 是真正的回收触发点；
- 如果 finalize() 方法中对象再次被引用，生命周期会如何延长。

追问：如果 Finalizer 线程一直不执行，GC 会怎样处理这些对象？finalize() 抛出异常后，对象的引用状态会怎样变化？

源码入口：`share/gc/shared/referenceProcessor.cpp:917`、`share/gc/shared/referenceProcessor.cpp:425`、`java.base/share/classes/java/lang/ref/Finalizer.java:112`。

## 5. ReferenceQueue 和 ReferenceHandler 的关系是什么？

Reference 对象被 enqueue 后，谁在消费这个 pending 列表？为什么 ReferenceHandler 线程是 daemon 的瞬时高优先级线程？

回答必须覆盖：

- `Reference.enqueue()` 把对象挂到 pending 列表上；
- `ReferenceHandler` 线程的 `run()` 是 `Reference.tryHandlePending` 的死循环；
- 为什么 SpecialCleanup 和 Finalizer 的入队由 ReferenceHandler 触发；
- 为什么 ReferenceHandler 线程是 daemon 且高优先级；
- 如果 ReferenceHandler 线程被阻塞，pending 列表会怎样。

追问：如果 ReferenceHandler 线程来不及处理 pending 列表，GC 中 enqueue 的 Reference 对象会堆积在哪个队列？`ReferenceQueue.poll()` 和 `ReferenceQueue.remove()` 的区别是什么？

源码入口：`java.base/share/classes/java/lang/ref/Reference.java:213`、`java.base/share/classes/java/lang/ref/Reference.java:85`、`java.base/share/classes/java/lang/ref/Finalizer.java:112`。

## 6. PhantomReference 与 WeakReference 的根本区别，不是“对象死后才获通知”这么简单？

很多人说“PhantomReference 在对象死后才入队，WeakReference 在对象还活着时就能 get”。但这个回答忽略了 VM 层一个更关键的区别，是什么？

回答必须覆盖：

- PhantomReference 的 `get()` 始终返回 null，WeakReference 的 `get()` 在对象存活时返回引用；
- 在 Phase2 中 WeakReference 的 referent 被 `clear_referent` 并 `enqueue`；
- 在 Phase4 中 PhantomReference 的 referent 被 `clear_referent` 并 `enqueue`；
- 关键区别：PhantomReference 的 referent 在发现阶段被标记为不可达后，GC 才进入 Phantom 处理阶段，此时 referent 已经被判定为不可达——而 WeakReference 的 referent 在 Phase2 时可能还活着；
- PhantomReference 必须等 Finalizer 的复活阶段之后，所以它是“对象真正不可达且不可复活”的最后确认。

追问：为什么 PhantomReference 通常用于直接内存的清理，而不是 WeakReference？如果 PhantomReference 的 `get()` 返回引用，会破坏哪条语义？

源码入口：`java.base/share/classes/java/lang/ref/PhantomReference.java:59`、`share/gc/shared/referenceProcessor.cpp:956`、`share/gc/shared/referenceProcessor.cpp:452`。

## 7. GC 的引用处理为什么是“并行任务”，而不是单线程串行？

ReferenceProcessor 的 discovered 列表为什么按 worker 数分槽？`maybe_balance_queues` 在解决什么问题？

回答必须覆盖：

- `DiscoveredList` 数组按 `_max_num_queues` 分槽；
- 每个 worker 可以从自己的槽中获取引用进行处理；
- 偷取协议：worker 处理完自己的槽后可以从其他 worker 的槽中偷取任务；
- `maybe_balance_queues` 在列表倾斜时重新分配；
- 为什么引用处理并行化不会破坏 Phase1→4 的顺序约束。

追问：如果 `_max_num_queues` 小于 GC worker 数，会怎样处理？如果某个 worker 的槽中引用特别多，其他 worker 如何帮助分担？

源码入口：`share/gc/shared/referenceProcessor.cpp:529`、`share/gc/shared/referenceProcessor.hpp:267`、`share/gc/shared/referenceProcessor.cpp:123`。