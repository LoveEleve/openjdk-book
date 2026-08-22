# 18 · ReferenceProcessor、Finalizer 与对象生命周期：专家答案锚点

## 1. Reference 的 referent 不能被当作普通 oop 遍历，否则引用语义会消失

如果 GC 把 WeakReference 的 referent 当普通字段跟着对象图扫描，那么只要 WeakReference 对象本身可达，referent 就永远可达，WeakReference 就完全没有意义了。所以 GC 在对象图遍历时，对 `InstanceRefKlass` 的对象走发现路径而非普通 oop 遍历：`InstanceRefKlass::oop_oop_iterate_discovery`（`share/oops/instanceRefKlass.inline.hpp:65`）先尝试 `try_discover`，发现成功就不再按普通 oop 遍历该引用。

发现需要预检：referent 已被标记（强可达）就不发现；软引用当场被 LRU 策略判断不清理时也不发现，直接作为强引用扫过。discovered 列表不使用独立存储，而是借 Reference 对象自身的 `discovered` 字段串链，`DiscoveredList`（`share/gc/shared/referenceProcessor.hpp:267`）只保存头指针与长度。

## 2. Phase1→4 的顺序由语义依赖决定，不能调换

`process_discovered_references`（`share/gc/shared/referenceProcessor.cpp:201`）按四阶段处理，它们的顺序是硬约束：

- **Phase1**：软引用按 LRU 策略重新考虑；策略说保留的，referent 被 `make_referent_alive` 救活；
- **Phase2**：软/弱/final 引用统一清理；referent 已死 → `clear_referent` + `enqueue`，referent 仍可达 → 移除并 `make_referent_alive`；
- **Phase3**：Final 复活——所有 final 引用的 referent 被强制 `make_referent_alive`，并 `set_next_raw(obj, obj)` 自环标记；
- **Phase4**：Phantom 清理。

Finalizer 的复活必须发生在 Phantom 之前：PhantomReference 必须在对象真正不可达、且不可能再被 finalize 复活之后才入队。如果先处理 phantom 再复活对象，等同于给一个可复活对象贴上了“已判死”标签，语义崩坏。

## 3. SoftReference 的保留依据是“访问间隔”，不是“存活时长”

`SoftRefLRUPolicyMSPerMB` 控制的是：距上次访问的间隔不超过多少毫秒就保留。机制是：

- `SoftReference.get()` 时会更新对象的 `timestamp` 字段；
- 每次 GC 推进 `clock`（`update_soft_ref_master_clock`，`share/gc/shared/referenceProcessor.cpp:157`，使用 `os::javaTimeNanos()/1e6`）；
- `interval = clock - timestamp` 是距上次访问的毫秒数；
- `_max_interval = heapMB × SoftRefLRUPolicyMSPerMB`（`share/gc/shared/referencePolicy.cpp:69`）；
- `interval <= _max_interval` 就不清除。

所以“最近被访问过”的软引用会继续存活，访问过后 refresh 使 interval 归零。设置为 0 时 interval 几乎总是超过 0，等价于弱引用。这不是“存活时间限制”，而是对“有多久没被使用”的容忍度。

## 4. Finalizer 通过“复活 + 入队”让对象再活一轮

`FinalReference` 在 Phase2 中既不清除 referent 也不 enqueue——`do_enqueue_and_clear` 对 Final 引用为 false，引用留在 discovered 列表中等待 Phase3。Phase3 的 `process_final_keep_alive` 把所有 final 引用的 referent 强制 `make_referent_alive`，让终结器要运行的对象“复活”进存活集，并 `set_next_raw(obj, obj)` 自环标记它在 final 队列中已入队。

真正触发回收的不是 GC，而是 Finalizer 线程从队列取出对象并执行 `finalize()`。如果 finalize() 中对象再次被强引用，对象会延长到剩余引用路径再次不可达。如果 Finalizer 线程一直不执行，对象会停留在“已复活”状态等待下一轮 GC。

## 5. ReferenceHandler 是 pending 列表的消费者，而不是 GC 的产物

GC 只负责把 `discovered` 列表中的引用 `enqueue` 到 `pending` 列表。消费 pending 列表的是 Java 层的 `ReferenceHandler` 线程——一个 daemon 的瞬时高优先级线程，其 `run()` 循环调用 `tryHandlePending`。

`Finalizer.register` 会让 `Finalizer` 实例也通过它的 `referenceQueue` 入队，由 ReferenceHandler 提取 final 引用交给 Finalizer 线程处理。ReferenceHandler 是 daemon，因此不会阻止 JVM 退出；高优先级保证它尽量及时消费 pending 列表。若它被阻塞，pending 列表会堆积，但 GC 的引用处理本身不受影响。

## 6. PhantomReference 的关键是“referrer 已不可达且不可能复活才通知”

WeakReference 的 `get()` 在对象存活时可返回引用，PhantomReference 的 `get()` 永远返回 null。但更关键的是它在 VM 的引用处理阶段的位置：

- Phase2（Weak 清理）发生在 Phase3（Final 复活）之前；此时 referent 可能还活着，只是弱引用被清除；
- Phase4（Phantom 清理）发生在 Phase3 之后；此时 referent 已经被判定为不可达，且经过 finalize 复活确认。

因此 PhantomReference 语义是最强的“对象真正结束生命周期”的信号，适合配合直接内存、资源清理。如果 PhantomReference 的 `get()` 返回引用，就会让对象又被“拉回”强可达，破坏它作为回收终点的语义。

## 7. 引用处理通过分槽 + 偷取实现并行，但顺序仍全局保持

ReferenceProcessor 维护四类 discovered 列表，每类实际是一个连续数组的四段，按 `_max_num_queues` 分槽。GC worker 从自己的槽中取引用处理；处理完可以偷取其他 worker 槽中的任务。`maybe_balance_queues` 在列表严重倾斜时重新分配槽。

并行处理不破坏 Phase1→4 的顺序约束，因为四阶段是串行调用的：每个阶段内并行处理，阶段之间按顺序推进。分槽让多 worker 并发消费同一类列表成为可能，同时保持阶段级时序。

## 评分锚点

- **合格**：能说出软/弱/虚引用和 Finalizer 的“通用行为”。
- **良好**：能区分 discovered 列表/pending 列表、ReferenceHandler 与 GC 引用处理的关系。
- **专家级**：能用“发现 → 四阶段裁断 → 入队/复活/清除”这条主线，说明每种引用的语义为什么由它在阶段序列中的位置决定，并解释为什么顺序不能调换。