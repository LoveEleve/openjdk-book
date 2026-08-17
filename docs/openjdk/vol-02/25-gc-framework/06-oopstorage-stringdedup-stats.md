# 06. 字符串去重和 GC 统计 — OopStorage + StringDedup + GC Stats

> **前置依赖**:[27-jni/01 — jobject 在 JVM 内部怎么存的?— JNI Handle 系统](openjdk/vol-02/27-jni/01-handle-system.md):OopStorage 的存储语义(Global/Weak 两实例、release 无锁 CAS)已拆,本篇补 GC 视角;[39-runtime-monitoring/02 — Timer + Monitoring Services — 高精度计时 + JMX 统计](openjdk/vol-02/39-runtime-monitoring/02-timer-stats.md):GC 计时的家族(GCTraceTimeImpl/阶段树)已讲;[25-gc-framework/05 — 一次赋值在 GC 眼里怎么变成"脏卡片"？— CardTable + DirtyCardQueue](openjdk/vol-02/25-gc-framework/05-cardtable-dirtycardq.md):GC 阶段树的 Processed Buffers 等读数是本篇 GC 统计的素材;[25-gc-framework/02 — new Object() 走到了哪？— CollectedHeap + 分配路径](openjdk/vol-02/25-gc-framework/02-collected-heap.md):GC cause 枚举已讲
> → **后续**:[28-jvmti/01 — JVMTI Agent 怎么工作？— Agent 架构与事件系统](openjdk/vol-02/28-jvmti/01-agent-architecture.md)
> 关联域: 27-jni(OopStorage)、39-runtime-monitoring(计时)、25-05(阶段树读数)

## GC 的"后勤部门"

前五篇是 GC 的**作战机制**——barrier、分配、引用、并行、脏卡。本篇是**后勤**: 引用和字符串往哪存(OopStorage)、重复字符串怎么省内存(StringDedup)、一次暂停怎么被记录(GC 统计)、以及一套没被 G1 用上的历史代码(GenCollectedHeap)。四件事没有共同机制,但共同回答一个问题:**GC 之外,谁在支撑 GC**。

## 1. OopStorage — 引用存储的 GC 视角

27-jni/01 已拆 OopStorage 的语义: JNI Global/Weak 句柄的存储槽、`release` 无锁 CAS 清位。本篇补 GC 视角的三个真相(大纲的"无锁 thread-local block 分配"是编造的):

1. **allocate 是加锁的**(oopStorage.hpp:105-108,注释明写 "Locks _allocation_mutex")——从 `AllocationList`(双向链表,:179-205)找有空间的 Block,没有就新建;无锁的部分是 **release**(引用清空,CAS 位清除,27-jni/01 的 :575-587)与**迭代**;
2. **GC 迭代走 ActiveArray 快照**(oopStorage.hpp:175/:209): Block 列表的指针数组 + `SingleWriterSynchronizer` 保护(:220)——GC 拿快照后并发迭代,新分配的 Block 追加不影响已拿到的快照;`ParState`(:152,注释 "Parallel iteration is for the exclusive use of the GC")是 GC worker 的并行迭代入口;
3. **弱存储的清理由 GC 做**: 27-jni/01 已述,Weak 存储的槽在 GC 弱处理后置 NULL(weakProcessor.cpp:37)——OopStorage 只提供"槽的存储","何时清"是 GC 的活。

## 2. StringDedup — 让 100 万个 "hello" 只有一份

堆里重复的 String 很常见(`new String("hello")` 100 万次,100 万个对象 100 万个 char[])。StringDedup(JDK 8 引入,JEP 192)在 **GC 时**把这些 String 合并到共享的 char[]。机制是**两阶段**(stringDedup.hpp:35-49 的权威注释):

```
GC 周期内(标记/疏散):  检查每个对象是否候选 String → 入 dedup 队列
GC 之后(并发阶段):     StringDedupThread 拉队列 → 查表 → 合并/入表
```

- **候选选择是 GC 特定的**(注释 "Candidate selection criteria is GC specific")——G1 的 `G1StringDedup` 按 String **年龄**判定(g1StringDedup.cpp:47-75): flag 注释原文 "A string must reach this age (or be promoted to an old region) to be considered for deduplication"(globals.hpp:2590)——**存活满 3 次年轻代 GC(或晋升到老区)才候选**,避免短命字符串白查;
- **哈希表存"唯一 char[]"**: `StringDedupTable`(stringDedupTable.cpp:204 单例;add :246/lookup :280)是传统 hashtable + 条目缓存,**不是 OopStorage**(大纲"table 用 oopStorage 分配...4MB"编造);**表条目弱指向 char 数组**(hpp:35/:97)——表不延长 char[] 的生命;
- **合并动作**: lookup 命中 → String 的 value 字段指向已存在的 char[](释放自己的引用);未命中 → 插入表。interned 字符串特殊: 插入 StringTable 前**立即 dedup**(stringDedup.hpp:65-73 注释,避免抵消 C2 对字符串字面量的优化)。

**[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/25-gc-aux-demo.txt)**: `-XX:+UseStringDeduplication`(**默认 false**,globals.hpp:2586)开启后,`-Xlog:gc+stringdedup=trace` 看到 **"Concurrent String Deduplication"**(并发阶段)与统计: 100 万重复 String 检查 31 万、4488B→2816B 共享 char[](素材 A)。注意 flag 名是 `UseStringDeduplication`(`-XX:+UseStringDedup` 直接报 Unrecognized)。

## 3. GC 统计 — "GC(33)" 背后的架子

GC 日志里每个事件都带 `GC(N)` 编号——那是 **GCId**(gcId.hpp:30,59 行的 AllStatic): 每次暂停/并发周期分配唯一 id,跨标签共享(素材 C: gc/gc+phases/gc+stringdedup 同号)。计时与阶段树在 39-02 已拆(`GCTraceTimeImpl`,gcTraceTime.hpp:46-65;GCTimer 类在 gcTimer.hpp:131)。本篇补一句设计观: **GC 统计是"RAII 嵌入"**——每个阶段代码块用 GCTraceTimeImpl 构造/析构自动计时(39-02 的 Phase 树),GCId 用 GCIdMark 入栈——统计代码与 GC 逻辑**同构嵌套**,想漏记一个阶段都难。

## 4. 死代码 — GenCollectedHeap 的墓碑

25-05 已证 CardTableRS 是死代码。它服务的整条链——`GenCollectedHeap`(两个 Generation 独立收集)、`generation`/`space`(MemRegion 连续空间)、`CardTableRS`(跨代引用卡表)——在 G1-only 构建中 `INCLUDE_SERIALGC/PARALLELGC/CMSGC=0`,全部编译时剔除。它对本书的意义是**对照**: G1 用统一大小的 region(1-32MB)替代不同大小的 generation,用 per-region RSet 替代整代卡表——**更细的粒度换更均匀的暂停,代价是每 region 的簿记**(大纲的"~5% heap overhead"数字无源码依据,不采信)。

## 核心悬念

后勤部门到齐: **OopStorage**(allocate 加锁/release 无锁/ActiveArray 快照迭代,GC 的引用槽)、**StringDedup**(两阶段: GC 内入队+并发线程查表合并,AgeThreshold=3)、**GC 统计**(GCId 编号+RAII 阶段计时)、**死代码对照**(GenCollectedHeap 墓碑)。25 域(GC 框架)收官——但 GC 的正确性不止靠框架自身: **外部的观察者**——调试器、profiler、agent——需要通过 JVMTI 窗口看进来。下一篇进入 JVMTI。

> → [28-jvmti/01 — JVMTI Agent 怎么工作？— Agent 架构与事件系统](openjdk/vol-02/28-jvmti/01-agent-architecture.md)
