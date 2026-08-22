# 01 · 对象、内存与 GC

> 目标：判断候选人是否真正理解对象头、引用可见性、GC 工作集和搬移协议，而不是会背“G1 有 Region”。

## 1. 一个 mark word 为什么能同时表示 hash、锁和 forwarding？

**主问题**

对象头只有一个 mark word。identity hash、年龄、偏向/栈锁/monitor、GC forwarding 都想使用它。HotSpot 为什么没有把这些信息拆成多个固定字段？

**必须回答**

- 低位 tag 如何选择解释；
- neutral、biased、stack locked、inflated、forwarded 的信息分别放在哪里；
- hash 与轻量锁 displaced mark 冲突时为什么可能膨胀；
- forwarding 之后旧地址为什么不能再按普通对象头解释。

**追问**

1. CAS 安装 hash 失败后为什么不能无限重试？
2. ObjectMonitor 保存的 header 与对象 mark word 是什么关系？
3. `INFLATING` 的 0 为什么不能当作 unlocked？
4. 如果对象处于锁状态，GC 怎样避免破坏 displaced mark？

**源码路线**

`oopDesc` → `markOopDesc` → `ObjectSynchronizer::FastHashCode` → `inflate` → `oopDesc::forward_to`。

**反事实**

如果 mark word 只保存锁状态、hash 永远放外部表，哪两条最常用路径会变慢？外部表的生命周期和并发回收又会引入什么问题？

**验证方向**

使用 `System.identityHashCode`、竞争锁、对象搬移和 `-XX:+PrintGCDetails` 组合实验；源码核对 `markOop.hpp`、`synchronizer.cpp`、`oop.inline.hpp`。

## 2. RSet 为什么记录“谁指向我”，而不是“我指向谁”？

**主问题**

G1 只想回收 Collection Set。为什么目标 Region 需要保存来源 Region 的 card，而不是每个 Region 保存自己指向的目标集合？

**必须回答**

- evacuation 的扫描问题是反向查询；
- post-write barrier 只产生 dirty card 线索；
- 并发精炼如何从来源 card 找到目标 Region；
- Update RS 与 Scan RS 为什么有先后顺序。

**追问**

1. coarse/fine/sparse 是三态状态机还是混合容器？
2. dirty card 已经进队列，为什么 pause 开始还要 `concatenate_logs()`？
3. 目标 Region 的 RSet 过粗会损失什么，过细又会损失什么？
4. 如果 mutator 直接维护完整 RSet，热路径具体多了哪些工作？

**源码路线**

`g1BarrierSet` → `DirtyCardQueue` → `G1ConcurrentRefine` → `G1ConcurrentRefineOopClosure` → `HeapRegionRemSet` → `G1RemSet::scan_rem_set`。

**反事实**

把 RSet 改成“来源 Region 集合”而不是“来源 card 集合”，正确性是否仍成立？暂停时间和重复扫描会怎样变化？

**验证方向**

使用 G1 GC 日志观察 `Update RS`/`Scan RS`，结合 `-XX:+G1SummarizeRSetStats` 和源码中的 card claim 路径验证。

## 3. 为什么 GC 不能只扫描对象图中的强引用？

**主问题**

GC 似乎只需要沿着强引用遍历活对象。为什么 HotSpot 还要维护 OopMap、SATB、RSet、code roots 和处理器队列？

**必须回答**

- “对象是否存活”“栈槽是否为 oop”“跨 Region 入边”“并发标记快照”是四个不同问题；
- 编译帧不能靠猜 slot，必须依赖 safepoint OopMap；
- 并发标记期间 mutator 的删除操作为什么需要 SATB；
- evacuation 期间外部入边为什么需要 RSet。

**追问**

1. OopMap 与 RSet 是否都属于 remembered set？
2. SATB 解决的是新增引用还是删除引用？
3. 如果只保留 SATB、不保留 RSet，Mixed GC 会在哪一步退化？
4. 如果只保留 RSet、不做并发标记，Mixed GC 的收益还剩多少？

**源码路线**

`frame::oops_do` → `OopMapSet`；`G1SATBCardTableLoggingModRefBS` → SATB queue；`HeapRegionRemSet` → `G1RemSet`。

**反事实**

将并发标记改成全堆 stop-the-world 标记，哪些队列和 barrier 可以删除，哪些仍然不能删除？

## 4. 对象为什么会从 TLAB 退化到共享分配，再退化到 GC？

**主问题**

G1 分配为什么不能始终从一个全局空闲表取一块内存？TLAB、PLAB、Eden Region、Humongous Region 和 GC 失败之间如何接力？

**必须回答**

- TLAB 把分配竞争隔离到线程本地；
- Region 粒度决定普通对象与 humongous 对象的不同路径；
- 分配失败不是立即 OOM，而是触发扩容、GC、退化或错误报告链；
- 晋升失败与普通 Eden 分配失败不是同一故障。

**追问**

1. 为什么 TLAB 剩余空间不足时不一定立刻申请新 Region？
2. humongous 对象为什么会改变回收和 remembered-set 成本？
3. GC locker 为什么可能阻止某些回收路径？
4. 如果所有线程共享一个 bump pointer，最先出现的是锁竞争、局部性问题还是安全性问题？

**源码路线**

`G1CollectedHeap::attempt_allocation` → `G1AllocRegion` → TLAB slow path → `G1CollectedHeap::do_collection_pause`。

**验证方向**

用不同对象大小、线程数和 `-XX:+PrintGCDetails`/`-Xlog:gc+heap=debug` 观察普通分配、humongous 分配与 GC 触发差异。
