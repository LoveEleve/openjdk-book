# 06 · GC 收集器与回收策略：深度题目

## 1. 为什么 HotSpot 不把所有 GC 都做成“统一算法 + 几个参数”？

Serial、Parallel、CMS、G1、ZGC、Shenandoah 都在解决垃圾回收，但它们为什么没有收敛成同一套 collector pipeline 的简单调参版本？

回答必须覆盖：

- stop-the-world、并发标记、并发迁移、压缩/复制、Region 化与分代化分别在解决什么矛盾；
- 吞吐、停顿、额外内存、屏障成本和实现复杂度的交换；
- 为什么“缩短停顿”不能只靠增加并行线程；
- 为什么“并发”通常会把工作转移到 barrier、元数据和恢复协议上。

追问：把 G1 改成整堆并发搬移，它最先缺的是屏障、元数据还是地址稳定性协议？把 CMS 改成精确压缩，它最先撞上的约束是什么？

源码入口：`share/gc/shared/collectedHeap.hpp:96`、`share/gc/shared/gcConfig.cpp:68`、`share/gc/shared/genCollectedHeap.hpp:43`。

## 2. Serial/Parallel 的主干优势到底是什么，而不是“老”或“简单”？

为什么一类收集器宁愿长时间 stop-the-world，也不把核心工作并发化？Serial/Parallel 在什么场景下反而是最合理的工程答案？

回答必须覆盖：

- 分代、复制、压缩和 card table 如何降低实现复杂度；
- Parallel 解决的是 STW 期间的吞吐，不是并发停顿；
- 年轻代和老年代策略为什么可以在同一代际堆中耦合；
- promotion failure、full GC、reference processing 和 soft reference 清理如何影响暂停分布。

追问：为什么“多线程 STW”不等于“低停顿”？如果应用线程很多但活对象比例高，Parallel 的哪部分成本仍然无法隐藏？

源码入口：`share/gc/shared/genCollectedHeap.cpp:91`、`share/gc/shared/genCollectedHeap.cpp:276`、`share/gc/shared/cardTableRS.cpp:600`。

## 3. CMS 的关键 trade-off 为什么不是“并发清理”，而是“允许碎片换停顿”？

CMS 最本质的设计取舍是什么？为什么它能缩短某些停顿，却又必须承担浮动垃圾、remark、碎片和 promotion failure 风险？

回答必须覆盖：

- 并发标记/清扫与 stop-the-world 初始标记/remark 的边界；
- 增量更新（incremental update）与 SATB 的方向差异；
- 不压缩意味着什么，以及为什么 free list 和分配路径会变复杂；
- promotion failure 为什么可能把一次并发收集退化成更重的 stop-the-world 路径。

追问：如果 CMS 想加并发压缩，会破坏哪些已有假设？为什么 remark 仍然逃不掉 stop-the-world？

源码入口：`share/gc/shared/gcConfig.cpp:68`、`share/gc/shared/cardTableRS.cpp:455`、`share/gc/shared/vmGCOperations.cpp:196`。

## 4. G1 的核心不是 Region，而是“把暂停工作集收窄到可预算的单位”吗？

很多人会说 G1 的特点是 Region。这个回答为什么远远不够？G1 真正靠什么把 pause time 从“堆大小”改写成“本次工作集大小”？

回答必须覆盖：

- Region、CSet、RSet、SATB、并发标记、Mixed GC 和 pause budgeting 的关系；
- 为什么 remembered set 记录“谁指向我”；
- 为什么分配、并发标记和 evacuation 需要不同的元数据视角；
- G1 与传统代际整堆/连续空间思路的根本差别。

追问：如果删掉 RSet，只保留 SATB 和并发标记，Mixed GC 会在哪一步退化？如果不做 pause budgeting，G1 和一个“Region 化的 Parallel”还有什么本质差别？

源码入口：`share/gc/g1/g1CollectedHeap.hpp:338`、`share/gc/g1/g1RemSet.cpp:425`、`share/gc/g1/g1ConcurrentMark.cpp:700`。

## 5. ZGC/Shenandoah 为什么把难题从“标记谁活着”转移到了“对象地址如何稳定地变化”？

低停顿收集器为什么不再把核心问题放在 stop-the-world 标记，而是放在并发 relocation、load/store barrier 和对象地址语义上？

回答必须覆盖：

- 并发移动对象时，mutator 还能看到一致地址语义的原因；
- colored pointer / Brooks pointer 一类方案在本质上分别承担什么；
- 为什么 barrier 会从“记日志/记脏卡”升级到“参与对象访问协议”；
- 低停顿的收益为什么要用更高的屏障成本和实现复杂度交换。

追问：如果把 ZGC/Shenandoah 的 barrier 改成 G1 式 post-write barrier，会先坏在读路径、转发语义还是 relocation 竞态？

源码入口：如果当前 OpenJDK 11u 源码树包含 ZGC/Shenandoah，则从各自的 `ZCollectedHeap` / `ShenandoahHeap` 与 barrier set 入口开始；若发行版源码树未包含这两个收集器，则这一题按“范围边界与设计对比题”处理，不强行要求本地 `file:line`。
## 6. “屏障”为什么不是一个统一概念？

写屏障、读屏障、SATB 记录、增量更新、卡表脏化、load barrier、访问屏障为什么不能统称为“GC barrier”后就算解释完？

回答必须覆盖：

- barrier 发生在读、写、引用发布、日志记录还是对象解引用的哪一步；
- 不同收集器的 barrier 保护的是不同不变量；
- card table 解决的是 remembered set/代际跨区问题，不等于并发 relocation；
- SATB 与 incremental update 的“记录方向”不同。

追问：为什么有的 barrier 可以延后批处理，有的 barrier 必须参与每次对象访问的即时语义？哪一类 barrier 最容易变成 mutator 热路径成本？

源码入口：`share/gc/shared/cardTableBarrierSet.hpp:41`、`share/gc/g1/g1BarrierSet.hpp:44`。若当前源码树包含 ZGC/Shenandoah，再分别从它们各自的 barrier set 入口继续展开。
## 7. 跨收集器真正的面试分水岭是什么？

如果让你比较 Serial/Parallel、CMS、G1、ZGC、Shenandoah，真正能区分工程师深度的不是“谁快谁慢”，而是哪几个统一维度？

回答必须覆盖：

- 对象移动时机；
- 是否并发标记、并发重定位或并发清扫；
- 需要哪类 barrier；
- 如何维护 root、引用处理和线程栈可达性；
- 遇到失败路径时如何退化或自救。

追问：为什么“低停顿”与“低 CPU 开销”常常冲突？为什么“更复杂的 barrier”与“更少的 stop-the-world”几乎总是一笔交易，而不是白赚？

源码入口：`share/gc/shared/collectedHeap.hpp:188`、`share/gc/shared/gcConfig.cpp:68`、`share/gc/shared/referenceProcessor.cpp:44`。
