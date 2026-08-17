# 02. 应用还在跑——你怎么知道谁活着？— 并发标记 + SATB

> 🔴 Deep | 5 KP 中的并发标记
> 读者处境: GC 通常 STW(Stop-The-World)——但 G1 的标记是在应用运行时并发做的。应用在修改对象引用——标记线程怎么知道"我刚标记完的对象的引用被改了"？

### 1. "快照——标记开始时的 heap" — SATB

场景: 并发标记开始时——用 pre-write barrier 保存旧值到 SATB buffer。标记线程通过 SATB buffer 找到未被 trace 的对象→保证不丢失存活对象。如果不用 SATB, 标记线程可能 tracing path 中另一个线程改了引用→丢失 live object→dangling pointer→crash。

**SATB pre-write barrier** (`g1BarrierSet.inline.hpp:36-46`):
```cpp
// 修改 oop field 前: 保存旧值
inline void G1BarrierSet::write_ref_field_pre(T* field) {
  if (HasDecorator<decorators, IS_DEST_UNINITIALIZED>::value ||
      HasDecorator<decorators, AS_NO_KEEPALIVE>::value) {
    return;
  }
  T heap_oop = RawAccess<MO_VOLATILE>::oop_load(field);
  if (!CompressedOops::is_null(heap_oop)) {
    enqueue(CompressedOops::decode_not_null(heap_oop));
  }
}
```
- 源码: `g1BarrierSet.inline.hpp:36-46` + `g1BarrierSet.cpp:61-73` enqueue(is_active 门控;Java 线程→线程本地 satb_mark_queue,非 Java→共享队列 Shared_SATB_Q_lock)+ `satbMarkQueue.hpp:36-53` SATBMarkQueue 继承 PtrQueue
- 关键设计: SATB = Snapshot-At-The-Beginning——整个并发标记看到的 heap 是"标记开始时的快照"。任何标记开始后的指针更新→通过 pre-barrier 保存旧值→标记线程找到旧值→递归标记→不丢对象。overhead: pre-barrier~15-20 cycles(仅当 SATB active 时)
- ⚠️ 漂移修正: 大纲原写 ":40-80" → 实际 :36-46;enqueue 逻辑在 g1BarrierSet.cpp:61-73 而非 inline(模板里只有调用);"每线程一个 SATB buffer,写满整块交 completed buffer 列表" — 队列属于每个 Java 线程(不限于标记 worker),标记 worker 消费的是 completed 列表

**并发标记三阶段** (`g1ConcurrentMark.hpp:288-360` G1ConcurrentMark 成员):
```
Phase 1: concurrent marking(并发)—CMTask 线程并行 trace root→down oop graph
Phase 2: remark(STW)—补充标记并发期间遗漏的对象(updated SATB buffers), finalize liveness
Phase 3: cleanup(STW)—收尾(不计算 liveness、不选 CSet)
```
- 源码: `g1ConcurrentMark.hpp:288-360` + `g1ConcurrentMark.cpp:remark`(:1139-1227)+ `g1ConcurrentMark.cpp:cleanup`(:1356-1417)
- ⚠️ 漂移修正: ①CMTask 不继承 AbstractGangTask——`G1CMTask : public TerminatorTerminator`(:622),继承 AbstractGangTask 的是 G1CMConcurrentMarkingTask(:827)与 G1CMRemarkTask(:1828);②cleanup 不计算 liveness(liveness 在 remark 内 Update Remembered Set Tracking Before Rebuild 的 update_marked_bytes 记入 _next_marked_bytes,heapRegion.hpp:403-406 add_to_marked_bytes),也不选 CSet(那是 G1Policy/05 篇);③Rebuild RS 不是 remark 的第 4 步——Concurrent Rebuild Remembered Sets 是 remark 后的并发阶段(run_service 里);④实测阶段序列: Concurrent Cycle → Clear Claimed Marks → Scan Root Regions → Mark From Roots(循环,可 Preclean)→ Pause Remark(STW)→ Concurrent Rebuild Remembered Sets → Pause Cleanup(STW)→ Cleanup for Next Mark
- [C++: G1ConcurrentMark 双 bitmap 成员: `G1CMBitMap _mark_bitmap_1/_mark_bitmap_2` + 指针 `_prev_mark_bitmap/_next_mark_bitmap`(:304-310)。G1CMTask 有局部队列 _task_queue + G1CMTaskQueueSet 全局,ParallelTaskTerminator _terminator(:327)做终止;并行通过 WorkGang(域25)→ mark_from_roots(g1ConcurrentMark.cpp:973-992)调 G1CMConcurrentMarkingTask,work 里 do_marking_step(G1ConcMarkStepDurationMillis 默认 10ms,时间片轮转,到点 abort)。并发标记 lock-free: par_mark CAS + 全局 finger(claim_region CAS 认领 region)+ make_reference_grey 的 is_below_finger 判断(在已扫区域→入栈,未扫区域→bitmap 迭代自然覆盖;typeArray 直接记账不入栈)]

### 2. "标记位图 — 两个 bit per object"

场景: 并发标记需要知道每个对象是否存活——且不能和老标记结果混淆。prev/next 双 bitmap 分离上下轮标记——cleanup 用 prev(数据稳定)，concurrent marking 填充 next。

**prev/next marking bitmap** (`g1ConcurrentMark.hpp:304-310`):
```
G1CMBitMap  _mark_bitmap_1;   // 两个 bitmap 成员(对象)
G1CMBitMap  _mark_bitmap_2;
G1CMBitMap* _prev_mark_bitmap; // 上一轮标记结果(cleanup 时使用)
G1CMBitMap* _next_mark_bitmap; // 当前轮标记(concurrent 期间填充)
```
- 源码: `g1ConcurrentMark.hpp:304-310` + `g1ConcurrentMarkBitMap.hpp:62-140` G1CMBitMap(addr_to_offset = pointer_delta >> LogMinObjAlignment=3,8 字节粒度)
- 关键设计: 双 bitmap 让标记和清扫并发——cleanup 使用 prev bitmap(数据稳定),concurrent marking 填充 next bitmap。不需要等 marking 完成→prev bitmap 随时可用
- ⚠️ 漂移修正: ①不是"每个对象 2 bits 在一个 bitmap"——是两个独立 bitmap,每对象各 1 bit;②成员名不是 _prevMarkBitMap——真实 _mark_bitmap_1/_mark_bitmap_2 + 指针 _prev/_next_mark_bitmap;③par_mark 的 CAS 是 BitMap::par_set_bit(bitMap.inline.hpp:41-58,Atomic::cmpxchg 循环,已标返回 false);④开销 1/64 = 1.5625% ≈ 1.6% per bitmap(8 字节 1 bit → heap/64 bytes),两个共 ~3.2%;⑤remark 结束 swap_mark_bitmaps(g1ConcurrentMark.cpp:1179)安装本轮结果,cleanup_for_next_mark 用 WorkGang 并行清 next bitmap
- [C++: bitmap set bit 用 `Atomic::cmpxchg`(par_set_bit)——避免 overwrite another thread's set。每个 bit 覆盖一个对象头(8 bytes)→overhead ~1.6% of heap size per bitmap。bitmap 寻址: `bit_offset = (obj_addr - heap_base) / 8`(8 bytes per object granularity)]

### 3. "remark phase — 最后补漏"

场景: concurrent marking 结束后——有些在标记期间通过 SATB buffer 和与分配的队列中"catch up"的对象需要 finalize。Remark phase(STW) 解决这些。

**Remark 流程** (`g1ConcurrentMark.cpp:1139-1227`):
```
remark:
  1. finalize_marking(:1858-1890)—G1CMRemarkTask 并行: Threads::threads_do 扫全部
     Java 线程根(栈/寄存器)+ do_marking_step(极大超时)消费剩余 SATB buffer 与灰栈
  2. weak_refs_work(Reference/Weak Processing)
  3. satb set_active_all_threads(false)—关闭 SATB
  4. flush_all_task_caches + swap_mark_bitmaps(next→prev)
  5. Update Remembered Set Tracking Before Rebuild(并行,liveness 记入每 Region 的
     _next_marked_bytes,add_to_marked_bytes heapRegion.hpp:403-406)
  6. reclaim_empty_regions(全空 Region 回 freelist)
  7. ClassLoaderData::purge(ClassUnloadingWithConcurrentMark)+ compute_new_sizes
  溢出→ _restart_for_overflow=true + reset_marking_for_restart(重启并发标记)
```
- 源码: `g1ConcurrentMark.cpp:remark`(:1139-1227)+ `finalize_marking`(:1858-1890)+ `cleanup`(:1356-1417)
- ⚠️ 漂移修正: ①Remark 的第 1 步不是直接处理 SATB buffer——G1CMRemarkTask::work(:1828-1855)先 Threads::threads_do 扫线程根,再 do_marking_step(第一步 drain_satb_buffers 才消费 SATB);②"Rebuild RS" 不在 remark 内——是 remark 后的并发阶段(Concurrent Rebuild Remembered Sets);③per-region liveness 的"计算"在 remark 的 Update Remembered Set Tracking Before Rebuild(update_marked_bytes),不是 cleanup;④实测 phases 日志(:-Xlog:gc+phases=debug)与函数一一对应: Finalize Marking→Reference Processing→Weak Processing→ClassLoaderData→ProtectionDomainCacheTable→Class Unloading→Flush Task Caches→Update Remembered Set Tracking Before Rebuild→Reclaim Empty Regions→Purge Metaspace→Report Object Count;cleanup 里是 Update Remembered Set Tracking After Rebuild + Finalize Concurrent Mark Cleanup
- 关键设计: Remark 是 STW(唯一需要全局停止的阶段)——但 remark 时间很短(~1-5ms)compared to concurrent mark(~10-100ms)。Remark 后→cleanup(rebuild liveness)→collection set ready for Mixed GC

---

### 核心悬念

**"SATB pre-write barrier 保存旧值→并发标记线程通过 SATB buffer 追踪来保证不丢对象。prev/next 双 bitmap 区分上下轮标记结果。"** — 下一篇: RSet + CardTable。

> → [03-rem-set.md](03-rem-set.md)
