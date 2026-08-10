# Synchronization（同步）— 文章大纲

> vol-02 · 域 12 · 🔴 A | 拓扑排序 #12 | vol-02 末域
> 依赖：OS（PlatformEvent/Parker）+ OOPs（mark word）+ Threads（JavaThread 状态）

## 叙事计划

**开篇场景**：你写 `synchronized(obj) { ... }`，JVM 不会每次都创建一把重量级互斥锁。90% 的情况只有一个线程在争——JVM 用三级方案应对：偏向锁（单线程时零开销）、轻量锁（CAS 栈上 Lock Record）、重量锁（ObjectMonitor + pthread_mutex）。只有争用升级时才膨胀。

**第一层：mark word 的锁编码——回顾并深入**

OOPs 域讲了 mark word 的 5 种锁状态编码（`01`=无锁, `01`+bias=偏向, `00`=轻量, `10`=重量, `11`=GC）。现在补全：`biased_lock=1` 且 `lock=01` 时，mark word 低 3 位 = `101`（biased_lock_pattern=5, `markOop.hpp:150-151`）。前 54 位是持有偏向锁的 `JavaThread*`，epoch 用 2 位跟踪批量重偏向。

hash 和偏向锁互斥：`identityHashCode` 计算后 hash 存入 mark word，覆盖了偏向锁线程指针的位域——偏向锁必须撤销。这个互斥是由 mark word 的物理布局决定的，不是策略选择。

**第二层：偏向锁——单线程时的零开销**

`BiasedLocking`（`biasedLocking.hpp`）在对象创建时给 mark word 预设偏向锁模式（anonymously biased，线程 ID 为 0）。第一个获取锁的线程 CAS 把自己的 `JavaThread*` 写入 mark word——成功后持有偏向锁，后续获取只需检查"mark word 里的线程 ID 是我不"——不需要 CAS，内存屏障都不需要。

批量重偏向（bulk rebias）：如果同一个类的对象频繁撤销偏向锁，JVM 递增该类的 epoch。所有该类的已偏向对象被标记为"epoch 过期"——下次获取锁时走快速重偏向路径而不是完整撤销。

偏向锁撤销触发 handshake（JEP 312）——不触发全局 safepoint，只暂停持有偏向锁的那个线程。

**第三层：轻量锁——CAS + 栈上 Lock Record**

当偏向锁被撤销或对象已经有竞争时，升级到轻量锁。`ObjectSynchronizer::fast_enter()`（`synchronizer.hpp:73`）在方法栈上分配 `BasicLock`（Lock Record），存储"原始 mark word（持有偏向锁信息时的那一版）"→ CAS 把 mark word 换成"指向 Lock Record 的指针"（低 2 位 = `00`）。

成功：持有轻量锁。失败：说明有竞争——膨胀到重量锁（`slow_enter`）。

`fast_exit()` 反过来：CAS 把 Lock Record 里的原始 mark word 写回对象头。失败（说明有其他线程在等）→ `slow_exit()` 释放 ObjectMonitor。

**第四层：ObjectMonitor——重量锁**

`ObjectMonitor`（`objectMonitor.hpp:128`）的三队列模型：`_owner`（持有线程）、`_EntryList`（等待获取锁的线程——CXQ 竞争队列）、`_WaitSet`（`Object.wait()` 的线程）。

`enter()`：线程自旋尝试 CAS 设 `_owner`。自旋失败 → 入 `_cxq` → `park()` 阻塞。`exit()`：释放 `_owner`，从 `_EntryList` 选一个线程 unpark。

`Object.wait()`：当前线程入 `_WaitSet`，释放锁，`park()`。`notify()`：从 `_WaitSet` 移一个线程到 `_EntryList`——不立即唤醒（被 notify 的线程需要重新竞争锁）。

`_recursions` 支持重入——同一线程多次 `enter()` 不阻塞，只递增计数。

**第五层：ObjectSynchronizer——整个锁子系统的入口**

`ObjectSynchronizer`（`synchronizer.hpp:43`）是 `synchronized` 字节码的 JVM 入口。`monitorenter` 字节码的执行路径：`fast_enter` → CAS 设轻量锁 → 成功返回 / 失败走 `slow_enter` → `inflate()` 创建 ObjectMonitor → `ObjectMonitor::enter()`。

`inflate()` 的触发原因（`inflate_cause_*`）：`monitor_enter`（轻量锁 CAS 失败）、`wait`（调了 `Object.wait()`——必须用 ObjectMonitor 因为 WaitSet 在 Monitor 里）、`notify`、`hash_code`（hash 冲掉了偏向锁）、`jni_enter`。

ObjectMonitor 池化：`omAlloc()` 从全局池中取而不是逐个 `new`——减少频繁分配开销。

**设计权衡**

一、三级锁 vs 总是重量锁。偏向锁零开销适合单线程、轻量锁 CAS 适合短期竞争、重量锁适合长期竞争。代价是实现复杂度高——三种路径的交互（偏向锁撤销、轻量锁膨胀、重量锁降级）。

二、handshake vs safepoint 撤销。JDK11 偏向锁撤销用 handshake——只影响目标线程。但批量撤销仍需 safepoint（影响所有线程）。

三、Notify 不立即唤醒 vs 立即移交。被 notify 的线程从 WaitSet 移到 EntryList 而不是立即获得锁——避免"生产者-消费者"模式下 notify 线程还没释放锁消费者就被唤醒再竞争一次。

## 核心悬念

**一行 `synchronized(obj)`，JVM 怎么从零开销的偏向锁、到 CAS 的轻量锁、再到 pthread_mutex 的重量锁——三级自适应，90% 的情况只走第一条路径？**

**→ 卷 03**：锁管好了、线程也协调了——但 Java 对象创建后去哪了？堆上的内存怎么分配、怎么回收？GC Framework 篇见。

## 预估

1 篇，5 层递进，预估 2800-3500 行。
