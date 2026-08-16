# 06. 字符串去重和 GC 统计 — OopStorage + StringDedup + GC Stats

> 🟡 Working | 3 KP 中的辅助设施
> 读者处境: JVM 堆中有 100 万个相同 String "hello"。StringDedup 消除重复(节约 ~30MB)。OopStorage 是这些重复 string 的并发存储。GC Stats 报告每次 GC 的详细信息。

### 1. "OopStorage — 无锁并发 oop 存储"
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/06 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"无锁 block 分配/thread-local/CMpxchg 链头" 编造(重要)**: JDK11 **allocate 锁 _allocation_mutex**(oopStorage.hpp:105-108 注释 "Locks _allocation_mutex");无锁的是 **release(CAS 清位,27-jni/01 :575-587)与迭代**;**GC 迭代走 ActiveArray 快照**(hpp:175/:209)+SingleWriterSynchronizer(:220)+ParState(:152 "Parallel iteration is for the exclusive use of the GC");Block=固定大小数组+AllocationList 双向链表(:179-205);delete_empty_blocks_safepoint/concurrent(:157-158)
> - **"_block_size=64/oop _data[64]" 伪代码编造**: Block 内部实现未公开(私有类,TestAccess 供单测);不写伪字段
> - **与 27-jni/01 分工**: 存储语义(Global/Weak 实例/release)已讲;本篇补 GC 视角(allocate 锁/ActiveArray 迭代/弱清理 weakProcessor.cpp:37)


场景: ReferenceProcessor、StringTable、JNI global refs 都需要无锁并发存储 oop。OopStorage 用分段 block 分配避免全局锁。

**OopStorage 块结构** (`oopStorage.hpp:40-150 + oopStorage.cpp:80-250`):
```cpp
class OopStorage {
  static const int _block_size = 64; // 64 oops per block
  struct Block {
    oop _data[_block_size];
    Block* _next;     // linked list
    int _allocated;   // count of allocated oops in this block
  };
  Block* _active_head; // 活跃 blocks (link to process)
  void* allocate();    // 分配新 oop slot
  void oops_do(OopClosure* cl); // GC 遍历
};
```
- 源码: `oopStorage.hpp:40-150` + `oopStorage.cpp:80-250` allocate + oops_do
- 关键设计: allocate 是 thread-local——每 thread 有活跃 block→bump allocate within block→满时 allocate new block and chain→no global lock。oops_do 是并发安全——新 block 插在头部→existing blocks 不可变→safe to iterate during GC
- [C++: Block 分配用 `Atomic::cmpxchg` for block chain head insert. 线程冲突时: 1 线程抢到→others retry with new head→~2-3 retries in high contention]
- [C++: Block 分配用 `Atomic::cmpxchg` for block chain head insert. 线程冲突时: 1 线程抢到→others retry with new head→~2-3 retries in high contention]

### 2. "StringDedup — 字符串去重"
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/06 已按真实源码成文):
> - **"默认 10% GC cycles 触发" 错**: UseStringDeduplication **默认 false**(globals.hpp:2586);StringDeduplicationAgeThreshold=3(globals.hpp:2589)是 **String 年龄阈值**(flag 注释 "A string must reach this age (or be promoted to an old region)"),非"10% GC cycles"
> - **"dedup 在 GC 的 Reference Processing 期间处理" 错(重要)**: 真实=两阶段(stringDedup.hpp:35-49 注释): GC 周期内检查候选入 dedup 队列 + **GC 后并发阶段**(StringDedupThread 拉队列处理,"The second part...is a concurrent phase which starts right after the stop-the-wold marking/evacuation phase...executed by the deduplication thread")
> - **"dedup table 用 oopStorage 分配...4MB" 编造**: 真实=StringDedupTable 传统 hashtable+entry cache(stringDedupTable.cpp:204 单例/add :246/lookup :280),**非 OopStorage**;条目**弱指向** char 数组(hpp:35/:97)
> - **候选选择 GC 特定**: G1 按年龄判定(g1StringDedup.cpp:47-75);interned 字符串插入 StringTable 前立即 dedup(stringDedup.hpp:65-73 注释);JEP 192
> - **实证**: "Concurrent String Deduplication" 并发阶段日志(100 万重复 String 检查 31 万/4488B->2816B);flag 名 UseStringDeduplication(-XX:+UseStringDedup 报错)


场景: 年轻代和年老代中有大量重复 String(如 "com.example.User" 类名)→StringDedup 在 GC 期间检查并合并它们。

**StringDedup 共享层** (`stringDedup/stringDedup.hpp/cpp`):
```
StringDedupQueue:  持有待 dedup 检查的 String 引用(有容量上限)
StringDedupTable:  hash table 存 dedup'd Strings (和原 String 共享 char[])
Deduplication:     if two Strings' value arrays identical→redirect reference→save memory
```
- 源码: `stringDedup/stringDedupQueue.cpp:40-150` enqueue + `stringDedupTable.cpp:40-200` lookup + `stringDedup.cpp:50-120` deduplicate
- 关键设计: 不是所有 GC cycle 都做 dedup——默认 10% 的 GC cycles 触发(`StringDeduplicationAgeThreshold=3`即第 3 次 GC age 后)。dedup 候选: 刚晋升到老年代的 String→在 GC 的 Reference Processing 期间处理
- [C++: dedup table 用 `oopStorage` 分配—每个 block 64 oop, 1K blocks=64K oops→~4MB for table。collision rate: ~5%(table load factor → capacity automatic resize)]

### 3. "GC 统计 — 每次 GC 的完整报告"
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/06 已按真实源码成文):
> - **类归属**: GCTimer(gcTimer.hpp:131,187 行)/GCId(gcId.hpp:30,59 行)/gcTrace.hpp(313 行);**GCTraceTime 在 39-02 已证是 GCTraceTimeImpl**(gcTraceTime.hpp:46-65)非 gcTrace.hpp 的类
> - **"GCTraceTime RAII...析构时调用 UnifiedLogging::gc_log" 简化**: 真实=GCTraceTimeImpl RAII+日志框架(39-02 已详);本篇补 GCId("GC(N)" 前缀,跨标签共享,GCIdMark 入栈)
> - **悬念指向错(重要)**: "下一篇域 26 G1 GC"过期(26 是第 7 批)——正确 **28-jvmti**(第 6 批剩余;01 标题="JVMTI Agent 怎么工作？— Agent 架构与事件系统")


场景: 生产环境 GC log — `[GC pause (G1 Evacuation Pause) 123.4ms]`。背后是一整套统计基础设施。

**GC Stats 核心类** (`gcTimer.hpp`, `gcTrace.hpp`, `gcCause.hpp`):
```
GCTimer:      记录 GC phase 的时间(ms/nanos)
GCTraceTime:  RAII timer—构造记录开始时间→析构记录结束并输出 log
GCCause:      30+ GC 触发原因(System.gc/allocation/evacuation)
GCId:         唯一 GC ID (JFR tracing 用)
```
- 源码: `gcTimer.hpp:40-80` GCTimer 声明, `gcTrace.hpp:40-150` GCTraceTime RAII, `gcCause.hpp:40-120` GCCause enum
- 关键设计: GCTraceTime RAII 让 timer 自动记录——不需要显式 start/stop。析构时调用 `UnifiedLogging::gc_log(gc_id, phase_name, duration)`——统一 logging 框架(minimal overhead)

### 4. "死代码——历史的见证" — GenCollectedHeap 经典代际
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/06 已按真实源码成文):
> - **"per-region overhead ~5% heap" 无源码依据删**(正文明确不采信)
> - 死代码链确认: GenCollectedHeap/cardGeneration/CardTableRS(25-05 已证)/generation/space——INCLUDE_SERIALGC/PARALLELGC/CMSGC=0


场景: G1-ONLY 构建中，GenCollectedHeap 的代码从未执行——INCLUDE_SERIALGC=INCLUDE_PARALLELGC=0。但这些代码保留了并行代际模型的设计意图——对理解 GC 设计演进有价值。

**死代码清单** (用于理解 G1 设计动机):
```
GenCollectedHeap(Serial/Parallel/CMS):
  - 两个 Generation(Young+Old)——每个 Generation 独立收集
  - CardGeneration 用 card table 追踪 inter-generational refs
  - Space(MemRegion) vs Region(G1's fixed-size 1-32MB)
  - CardTableRS: Remembered Set 实现(比 G1 的 PRT 更简单)
```
- 关键设计: 对照理解——G1 用 region(统一大小)替代 generation(不同大小). G1 的 Remembered Set(每 region 记录哪些 card 有跨 region ref)比 CardTable 更细粒度但是 per-region overhead ~5% heap。经典代际模型的简化版为何 G1 选择更复杂的 per-region header

---

### 核心悬念

**"OopStorage 用无锁 block 分配存储并发 oop。StringDedup 每 10% GC cycles 去重重叠 String。GC Stats 用 GCTraceTime RAII timer 自动记录每个 GC phase。死代码 GenCollectedHeap 记录了 GC 设计从代际到 Region 的演变。"** — 下一篇: 域26 G1 GC——G1 的具体实现。

> → 域26 G1 GC
