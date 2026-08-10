# G1 GC 专家面试题库 — 大纲完备性验证

> 2026-08-08 | 45692行源码 / 195文件 → 10篇文章 → 每题对应一个必须覆盖的知识点
> 如果某题没有对应大纲 → 大纲不完备

---

## 篇1：Region 模型与堆布局

### 基础（面试必问）
1. G1 的 Region 和 CMS/Parallel 的分代模型有什么区别？
2. 一个 Region 多大？由什么参数控制？为什么必须是 2 的幂？
3. Region 的四种角色（Eden/Survivor/Old/Humongous）如何动态切换？
4. `HeapRegionType` 的 `_tag` 字段编码了哪些信息？
5. Humongous 对象多大才触发？为什么 threshold=50% Region 大小？
6. `StartHumongous` 和 `ContinuesHumongous` 怎么连在一起？

### 进阶
7. Region 的 `commit`/`uncommit` 怎么和 OS 的物理内存管理交互？
8. `HeapRegion::block_start()` 怎么 O(1) 定位对象所属 Region？
9. Region 的 `_bot`（BlockOffsetTable）怎么实现卡表映射？
10. `G1HeapRegionAttr` 枚举如何通过地址范围反查 Region 属性？

### 专家
11. 为什么 Region 大小默认 = 堆大小/2048？2048 这个数字怎么来的？
12. Region 大小对 Humongous 分配、RSet 扫描、疏散效率的三角权衡是什么？
13. 如果堆大小不是 Region 大小的整数倍会怎样？
14. `_is_old` 标记和实际 Old Generation 的概念什么时候不一致？

---

## 篇2：GC 周期编排 (G1Policy)

### 基础
15. G1 的 GC 周期分几个阶段？每个阶段做什么？
16. `G1Policy` 怎么决定"该做 young GC 还是 mixed GC"？
17. `MaxGCPauseMillis` 怎么影响 GC 行为？默认值多少？
18. `GCPauseIntervalMillis` 和 `MaxGCPauseMillis` 怎么配合？
19. Young-only 阶段为什么可以连续做很多次？

### 进阶
20. `G1Policy::collection_set()` 怎么选择哪些 Region 进入 CSet？
21. `G1MMUTracker` 怎么跟踪 GC 暂停时间？和 `G1Policy` 的反馈环路是什么？
22. `IHOP`（Initiating Heap Occupancy Percent）怎么动态调整？
23. 为什么初始标记（initial-mark）可以 piggyback 在 young GC 上？
24. marking 和 mixed GC 之间的"lull"期发生了什么？

### 专家
25. G1Policy 的预测模型怎么从历史数据推断"哪些 Old Region 回收效率高"？
26. `predict_young_other_time_ms` / `predict_old_other_time_ms` 怎么校准？
27. adaptive IHOP 的指数衰减公式是什么？为什么不能直接用简单平均？
28. 如果 Mixed GC 在 `MaxGCPauseMillis` 内完不成——policy 怎么降级？

---

## 篇3：Young GC 与 PLAB

### 基础
29. G1 的 young GC 和 Parallel/CMS 的 young GC 有什么不同？
30. PLAB（Promotion Local Allocation Buffer）是什么？为什么需要？
31. `G1ParScanThreadState` 怎么分配对象到 Survivor Region？
32. 对象从 Eden 晋升到 Old 的年龄阈值怎么决定的？
33. `tenuring_threshold` 怎么动态调整？

### 进阶
34. 多个 GC 线程怎么在不加锁的情况下分配 PLAB？
35. PLAB 的 waste 怎么控制？`G1PLABWasteTargetPercent` 怎么起作用？
36. `G1ParScanThreadState::copy_to_survivor_space` 怎么处理对象已经在前一个 GC 线程中被拷贝的情况？
37. Forwarding pointer 在 young GC 中怎么用于避免重复拷贝？

### 专家
38. PLAB 的 `_alloc_buffers` 和 `_undo_waste` 的交互——waste 过大时怎么回退？
39. `G1ParScanThreadStateSet::flush()` 为什么在 GC 末尾需要把所有线程的 PLAB 剩余空间 retire？
40. 对象年龄跟踪在 PLAB 层面怎么实现？`ageTable` 和 `surviving_young_words` 的关系？
41. Young GC 的 card table 扫描怎么优化？`G1RemSet::scan_rem_set` 中的 dirty card 批量处理？

---

## 篇4：SATB 并发标记

### 基础
42. SATB（Snapshot-At-The-Beginning）和 CMS 的增量更新（Incremental Update）有什么区别？
43. SATB 写屏障做了什么？在什么时机触发？
44. `G1SATBCardTableModRefBS` 的 pre-write barrier 怎么实现？
45. 为什么 SATB 不会漏掉"标记过程中新出现的引用"？
46. `G1ConcurrentMark` 怎么管理标记栈（marking stack）？

### 进阶
47. SATB buffer 满了怎么办？`PtrQueue` 的 enqueue/dequeue 怎么实现？
48. `concurrent marking` 中多个 marking 线程怎么分配扫描任务？
49. `CMTask::drain_satb_buffers` 怎么批量处理 SATB buffer？
50. `G1CMBitMap` 的 `mark()`/`is_marked()` 怎么实现并发安全？
51. marking 线程和应用线程之间的内存模型保证是什么？

### 专家
52. SATB 的 floating garbage 会持续多久？对 mixed GC 有什么影响？
53. `G1ConcurrentMark::remark()` 为什么必须 STW？remark 做了什么？
54. SATB buffer 的 `process_or_enqueue` 在并发标记和 remark 阶段的行为差异？
55. marking stack overflow 怎么处理？`global_marking_stack` 和 `task_queue` 的双层架构？
56. SATB 预屏障（pre-barrier）在 JIT 编译代码中怎么注入？和 C2 的 BarrierSetC2 怎么协作？

---

## 篇5：RSet 与 Card Table

### 基础
57. Remembered Set（RSet）是什么？为什么 G1 需要它而 CMS 不需要？
58. Card Table 和 RSet 的关系是什么？
59. 一个 card 对应多大的内存区域？为什么是 512 字节？
60. "dirty card" 怎么产生？谁负责把 card 标记为 dirty？

### 进阶
61. RSet 的三级存储——sparse / fine / coarse——各有什么用途？
62. `HeapRegionRemSet` 怎么从 sparse 升级到 fine、再降级？
63. `PerRegionTable` 和 `OtherRegionsTable` 的区别？
64. `G1RemSet::scan_rem_set` 怎么用 RSet 避免全堆扫描？
65. Coarse-grained bitmap 什么时候使用？代价是什么？

### 专家
66. RSet 的内存占用估算——每个 Region 的 RSet 最小/最大是多少？
67. `G1RemSetSummary` 怎么统计 RSet 占用？`-XX:+G1SummarizeRSetStats` 输出什么？
68. card 的 refining 和 scanning 怎么分工？为什么不在同一个阶段做？
69. RSet 的 `_coarse_map` 在什么情况下会导致"假阳性"引用扫描（scan entire heap）？
70. `G1HotCardCache` 怎么缓存频繁 dirty 的 card？和 RSet 的交互是什么？

---

## 篇6：Concurrent Refinement 线程

### 基础
71. `G1ConcurrentRefineThread` 做什么？和 GC 线程有什么区别？
72. 为什么 dirty card 需要"refine"？不能直接在 GC 时扫描吗？
73. `G1ConcurrentRefine` 怎么控制 refinement 线程数量？
74. refinement 线程和应用线程怎么共享 dirty card queue？

### 进阶
75. `DirtyCardQueueSet` 的 `apply_closure_to_completed_buffer` 怎么批量 refine？
76. refinement 的 green/yellow/red zone 怎么定义？阈值怎么动态调整？
77. `G1ConcurrentRefine::threads_do` 怎么遍历所有 refinement 线程？

### 专家
78. refinement 线程过多会导致什么问题？过少呢？自适应调整算法是什么？
79. `G1ConcurrentRefineThread::wait_for_completed_buffers` 的等待策略？怎么避免忙等？
80. refinement 的 activation threshold 和 deactivation threshold 之间的 hysteresis 怎么设计？
81. 如果 dirty card 产生速度超过 refinement 速度——系统怎么降级？

---

## 篇7：Mixed GC 与疏散

### 基础
82. Mixed GC 回收哪些 Region？和 young GC 的差别？
83. `G1CollectionSet` 怎么选择 Old Region 进入 mixed CSet？
84. 一次 Mixed GC 回收多少个 Old Region？由什么上限控制？
85. 疏散（evacuation）过程中对象的 forwarding pointer 怎么设置？

### 进阶
86. `G1ParCopyClosure` 怎么区分"对象在 CSet 中"和"对象不在 CSet 中"？
87. Mixed GC 的 liveness 预测——怎么估算一个 Old Region 中有多少存活对象？
88. `G1ParScanThreadState::trim_queue` 怎么处理 overflow 的引用队列？
89. PLAB 在 mixed GC 中和 young GC 中的使用差异？

### 专家
90. Mixed GC 的疏散失败（Evacuation Failure）怎么处理？
91. `G1CollectedHeap::handle_evacuation_failure_par` 中的 self-forwarding 怎么保证安全？
92. `RemoveSelfForwardPtrObjClosure` 怎么在 GC 后清理自转发对象？
93. CSet 选择算法中的 efficiency 排序——回收效率 = liveness / predicted_time？

---

## 篇8：Humongous 对象

### 基础
94. Humongous 对象怎么分配？为什么不能走 TLAB？
95. `StartHumongous` Region 后面的 `ContinuesHumongous` Region 能不能被其他对象使用？
96. Humongous 对象什么时候被回收？
97. 为什么 Humongous 分配可能导致"Humongous fragmentation"？

### 进阶
98. `G1CollectedHeap::humongous_obj_allocate` 怎么找连续的 Region 序列？
99. `_humongous_reclaim_candidates` 集合怎么维护？
100. Humongous 对象在并发标记的 cleanup 阶段怎么判断是否存活？

### 专家
101. Humongous 对象的 RSet 有什么特殊性？
102. 连续的 Humongous 分配/释放会导致什么碎片化问题？G1 有 defragmentation 吗？
103. `G1CollectedHeap::do_collection_pause_at_safepoint` 中的 humongous eager reclaim 逻辑？

---

## 篇9：Full GC 与退化

### 基础
104. G1 什么时候触发 Full GC？
105. G1 的 Full GC 用什么算法？Serial/Parallel？
106. Full GC 和 mixed GC 的边界——什么时候 G1"放弃"mixed 退到 Full？
107. `-XX:G1ReservePercent` 怎么影响 Full GC 触发？

### 进阶
108. `G1FullGCScope` 和 `VM_G1CollectFull` 的执行流程？
109. G1 Full GC 的 marking-compaction 怎么实现？`G1FullGCPrepareTask` 做什么？
110. `G1FullGCCompactTask` 怎么判断对象应该移动到哪个 Region？

### 专家
111. G1 Full GC 的 remembered set 重建——`G1FullGCRebuildRSClosure`？
112. `G1FullGCMarker::mark_and_push` 的标记栈管理？
113. 为什么 G1 的 Full GC 可能比 CMS Full GC 慢？Region 模型带来的额外复杂度？
114. `G1FullGCAdjustTask` 怎么更新跨 Region 引用？

---

## 篇10：调优、日志与预测

### 基础
115. `-XX:+PrintGCDetails` 输出的每个字段怎么读？
116. `gc+heap=info` 日志中的 Eden/Survivor/Old/Humongous 容量变化？
117. `-XX:G1HeapRegionSize` 设为 1MB vs 32MB 分别适合什么场景？
118. `-XX:ConcGCThreads` 和 `-XX:ParallelGCThreads` 怎么合理配置？

### 进阶
119. `G1Predictions` 的置信区间怎么计算？`get_new_prediction` 的衰减模型？
120. `G1Analytics` 怎么从 recent 序列中计算 `_recent_avg_pause_time_ratio`？
121. gc+ergo+cset 日志中的 `predicted young region time` 和 `predicted old region time`？

### 专家
122. gc+heap=region 日志中的 `"E"`/`"S"`/`"O"`/`"H"` 如何映射到实际的 GC 行为？
123. `G1HeapTransition` 怎么追踪每次 GC 前后的 Region 分类变化？
124. 一个 Region 标记为"需要回收"→"被加入 CSet"→"被疏散"→"释放归还"的完整生命周期，在日志中怎么看？
125. 从 gc 日志反推应用的对象分配速率和 promotion rate？怎么计算？
