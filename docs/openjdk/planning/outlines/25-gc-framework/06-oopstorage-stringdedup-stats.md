# 06. 字符串去重和 GC 统计 — OopStorage + StringDedup + GC Stats

> 🟡 Working | 3 KP 中的辅助设施
> 读者处境: JVM 堆中有 100 万个相同 String "hello"。StringDedup 消除重复(节约 ~30MB)。OopStorage 是这些重复 string 的并发存储。GC Stats 报告每次 GC 的详细信息。

### 1. "OopStorage — 无锁并发 oop 存储"

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
