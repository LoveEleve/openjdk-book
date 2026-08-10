# 02. 应用还在跑——你怎么知道谁活着？— 并发标记 + SATB

> 🔴 Deep | 5 KP 中的并发标记
> 读者处境: GC 通常 STW(Stop-The-World)——但 G1 的标记是在应用运行时并发做的。应用在修改对象引用——标记线程怎么知道"我刚标记完的对象的引用被改了"？

### 1. "快照——标记开始时的 heap" — SATB

场景: 并发标记开始时——用 pre-write barrier 保存旧值到 SATB buffer。标记线程通过 SATB buffer 找到未被 trace 的对象→保证不丢失存活对象。如果不用 SATB, 标记线程可能 tracing path 中另一个线程改了引用→丢失 live object→dangling pointer→crash。

**SATB pre-write barrier** (`g1BarrierSet.inline.hpp:40-80`):
```cpp
// 修改 oop field 前: 保存旧值
if (old_value != NULL && gc_state & SATB_active) {
  satb_mark_queue.enqueue(old_value); // push to local buffer
}
```
- 源码: `g1BarrierSet.inline.hpp:40-80` + `satbMarkQueue.hpp:30-100`
- 关键设计: SATB = Snapshot-At-The-Beginning——整个并发标记看到的 heap 是"标记开始时的快照"。任何标记开始后的指针更新→通过 pre-barrier 保存旧值→标记线程找到旧值→递归标记→不丢对象。overhead: pre-barrier~15-20 cycles(仅当 SATB active 时)

**并发标记三阶段** (`g1ConcurrentMark.hpp:60-200`):
```
Phase 1: concurrent marking(并发)—CMTask 线程并行 trace root→down oop graph
Phase 2: remark(STW)—补充标记并发期间遗漏的对象(updated SATB buffers), finalize liveness
Phase 3: cleanup(STW)—计算 per-region liveness, 选择 collection set
```
- 源码: `g1ConcurrentMark.hpp:60-200` + `g1ConcurrentMark.cpp:remarks`
- [C++: CMTask 继承自 AbstractGangTask — 通过 WorkGang(域25) 分发到多个 GC worker 线程。每个 worker 有 private SATB queue→mark oop→push to global discovered fields→steal work from others' queues。并发标记是 lock-free 设计——每个 worker 有自己的 mark bit set+queue]

### 2. "标记位图 — 两个 bit per object"

场景: 并发标记需要知道每个对象是否存活——且不能和老标记结果混淆。prev/next 双 bitmap 分离上下轮标记——cleanup 用 prev(数据稳定)，concurrent marking 填充 next。

**prev/next marking bitmap** (`g1ConcurrentMark.hpp:80-120`):
```
G1CMBitMap* _prevMarkBitMap; // 上一轮标记结果(cleanup 时使用)
G1CMBitMap* _nextMarkBitMap; // 当前轮标记(concurrent 期间填充)
```
- 每个 object 在 bitmap 中有 2 bits(prev+next)——atomic set bit via CAS
- 关键设计: 双 bitmap 让标记和清扫并发——cleanup 使用 prev bitmap(数据稳定)，concurrent marking 填充 next bitmap。不需要等 marking 完成→prev bitmap 随时可用
- [C++: bitmap set bit 用 `Atomic::cmpxchg`——避免 overwrite another thread's set。每个 bit 覆盖一个 object header→overhead ~1.6% of heap size per bitmap。bitmap 寻址: `bit_offset = (obj_addr - heap_base) / 8`(8 bytes per object granularity)]

### 3. "remark phase — 最后补漏"

场景: concurrent marking 结束后——有些在标记期间通过 SATB buffer 和与分配的队列中"catch up"的对象需要 finalize。Remark phase(STW) 解决这些。

**Remark 流程** (`g1ConcurrentMark.cpp:remarks`):
```
remark:
  1. Process remaining SATB buffers(enqueue'd during concurrent mark)
  2. Finalize marking bitmap(next bitmap complete)
  3. Calculate per-region liveness(how many bytes alive per Old Region)
  4. Rebuild RS(update stale card data)
```
- 源码: `g1ConcurrentMark.cpp:remark` + `g1ConcurrentMark.cpp:cleanup`
- 关键设计: Remark 是 STW(唯一需要全局停止的阶段)——但 remark 时间很短(~1-5ms)compared to concurrent mark(~10-100ms)。Remark 后→cleanup(rebuild liveness)→collection set ready for Mixed GC

---

### 核心悬念

**"SATB pre-write barrier 保存旧值→并发标记线程通过 SATB buffer 追踪来保证不丢对象。prev/next 双 bitmap 区分上下轮标记结果。"** — 下一篇: RSet + CardTable。

> → [03-rem-set.md](03-rem-set.md)
