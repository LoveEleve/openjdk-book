# 02. 应用还在跑——你怎么知道谁活着？— 并发标记 + SATB

> **前置依赖**:[26-g1-gc/01 — 堆被切成 2048 块](01-heapregion.md):Region 模型与 §1.1 尺寸公式,本篇的 bitmap/region 语义都建立在它上面;[25-gc-framework/01 — BarrierSet + Access API](openjdk/vol-02/25-gc-framework/01-barrier-access.md):pre-write barrier 的挂载点与"GC 在每次 oop 访问旁听"的机制,本篇把 G1 那道 SATB pre-barrier 讲透;[25-gc-framework/02 — CollectedHeap + 分配路径](openjdk/vol-02/25-gc-framework/02-collected-heap.md):分配路径与暂停语义
> → **后续**:[26-g1-gc/03 — RSet + CardTable](03-rem-set.md)
> 关联域: 01-oops(对象访问)、15-c2(C2 barrier 节点优化)、08-interpreter(解释器模板)

经典 GC 标记是 STW 的: 全停,安全。G1 说"标记在你跑着的时候做"——应用在改引用,标记线程怎么知道"我还没扫到的那个对象被另一个线程改掉了"?三件事: SATB 快照保证不丢对象(§1);并发标记循环的状态机与实测(§2);remark 补漏 + liveness 入账(§4,把存活字节数记入每个 Region 的 `_next_marked_bytes`,26-01 §1.3 见过它)。

---

## 1. 快照: 先拍照,后追踪 — SATB

### 丢失的场景

假设不做任何记录。应用先把 A.b 从 B 改成 C——然后标记线程才扫到 A,它读到的是 C,B 永远没机会被扫描。而 B 只有 A 这一条入边,在标记开始那一刻是活的。B 在对象图里消失了。回收一个活对象 = 崩溃。

**解决: 在写引用之前,把旧值先保存下来。** 标记线程拿到"标记开始时所有引用的快照",旧的引用指向的对象一定被补扫,绝不会丢。

### pre-write barrier

`write_ref_field_pre`(g1BarrierSet.inline.hpp:36-45):

```cpp
// g1BarrierSet.inline.hpp:36-46(截取核心,逐字)
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

`IS_DEST_UNINITIALIZED`(新对象 TLAB 用,不需旧值)和 `AS_NO_KEEPALIVE`(弱引用的 load 不触发 keepalive)直接返回。其他情况 enqueue 旧值。真正的逻辑在 enqueue(g1BarrierSet.cpp:61-73):

```cpp
// g1BarrierSet.cpp:61-73(截取核心,逐字)
void G1BarrierSet::enqueue(oop pre_val) {
  // Nulls should have been already filtered.
  assert(oopDesc::is_oop(pre_val, true), "Error");

  if (!_satb_mark_queue_set.is_active()) return;
  Thread* thr = Thread::current();
  if (thr->is_Java_thread()) {
    G1ThreadLocalData::satb_mark_queue(thr).enqueue(pre_val);
  } else {
    MutexLockerEx x(Shared_SATB_Q_lock, Mutex::_no_safepoint_check_flag);
    _satb_mark_queue_set.shared_satb_queue()->enqueue(pre_val);
  }
}
```

两个要点:

1. **`is_active()` 门控** — 队列只在并发标记进行中打开。标记没在跑时 pre-barrier 等于不存在,0 开销。
2. **线程本地** — Java 线程写自己的 `satb_mark_queue`(per-thread buffer),从 buffer 尾部递减写 `_index`(25-gc-framework/05 的 PtrQueue 语义),无锁。buffer 写满才整块交给 completed buffer 列表——常规开销 ~15-20 cycles(推断值,无源码直证),仅 SATB active 期间。非 Java 线程(编译器线程)进共享队列(Shared_SATB_Q_lock)。

### queue 的设计

SATBMarkQueue(satbMarkQueue.hpp:45-88) 继承 PtrQueue: 每线程一个 buffer,buffer 里的 oop 是"标记开始时存活的引用"——它们可能已经过期(对象已死),但标记时按存活处理。多的标记无害,漏的标记致命。

---

## 2. 并发标记循环 — 状态机

### run_service: 循环骨架

`G1ConcurrentMarkThread::run_service`(g1ConcurrentMarkThread.cpp:247-265):

```cpp
// g1ConcurrentMarkThread.cpp:247-265(截取核心,逐字)
void G1ConcurrentMarkThread::run_service() {
  _vtime_start = os::elapsedVTime();

  G1CollectedHeap* g1h = G1CollectedHeap::heap();
  G1Policy* g1_policy = g1h->g1_policy();

  G1ConcPhaseManager cpmanager(G1ConcurrentPhase::IDLE, this);

  while (!should_terminate()) {
    // wait until started is set.
    sleep_before_next_cycle();
    if (should_terminate()) {
      break;
    }

    cpmanager.set_phase(G1ConcurrentPhase::CONCURRENT_CYCLE, false /* force */);

    GCIdMark gc_id_mark;
```

while + sleep: 平时睡在 CGC_lock 上。年轻代 GC 检查后发现占用超 IHOP(或 humongous 分配)→ `Concurrent Start`→ 唤醒此线程 → set_phase → 开始 cycle。整个循环的阶段序列如下:

### 实测: 完整 Concurrent Cycle

**[实证](materials/commands/26-g1-gc-concurrent-mark-demo.txt)**: 512KB 数组在 1MB region 下含 16B 头共 512KB+16B → humongous 分配触发 Concurrent Start。-Xms32m -Xmx64m -XX:+UseG1GC -XX:InitiatingHeapOccupancyPercent=30,-Xlog:gc -Xlog:gc+marking=info:

```
GC(0) Pause Young (Concurrent Start) (G1 Humongous Allocation) 9M->8M(34M) 2.188ms
GC(1) Concurrent Cycle
GC(1) Concurrent Clear Claimed Marks 0.004ms
GC(1) Concurrent Scan Root Regions 0.301ms
GC(1) Concurrent Mark (0.027s)
GC(1) Concurrent Mark From Roots 1.094ms
GC(1) Concurrent Preclean 0.076ms
GC(1) Concurrent Mark (0.027s, 0.028s) 1.181ms
GC(1) Pause Remark 18M->18M(34M) 0.168ms
GC(1) Concurrent Rebuild Remembered Sets 0.163ms
GC(1) Pause Cleanup 20M->20M(34M) 0.021ms
GC(1) Concurrent Cleanup for Next Mark 0.215ms
GC(1) Concurrent Cycle 2.541ms
```

整个 cycle 2.541ms,两次 STW 暂停(Remark 0.168ms + Cleanup 0.021ms = 0.189ms)不到总时间的 8%,92% 的时间标记与应用并行。

### Root Regions: 为什么 survivor 要优先扫?

G1CMRootRegions 的注释(g1ConcurrentMark.hpp:228-240):

```cpp
// g1ConcurrentMark.hpp:228-240(截取核心,逐字)
// Root Regions are regions that are not empty at the beginning of a
// marking cycle and which we might collect during an evacuation pause
// while the cycle is active. Given that, during evacuation pauses, we
// do not copy objects that are explicitly marked, what we have to do
// for the root regions is to scan them and mark all objects reachable
// from them. According to the SATB assumptions, we only need to visit
// each object once during marking. So, as long as we finish this scan
// before the next evacuation pause, we can copy the objects from the
// root regions without having to mark them or do anything else to them.
//
// Currently, we only support root region scanning once (at the start
// of the marking cycle) and the root regions are all the survivor
// regions populated during the initial-mark pause.
```

根 region = initial-mark 暂停时存活的 survivor 区域。为什么它们必须最先扫完? 并发标记进行中,Evacuation Pause 照常在跑——会把 survivor 区的对象拷走。如果 root region 里的对象没被标记就拷走了,标记就漏了。所以 cycle 一开始就抢在下一个暂停前把 survivor 扫完;scan 不能进 STS(必须一口气完成,不能被暂停打断)。scan 完后,下一次 Evacuation Pause 就能正常拷贝 survivor 而不担心遗漏。

### mark_from_roots: 并发 gang 主入口

`mark_from_roots`(g1ConcurrentMark.cpp:973-992):

```cpp
// g1ConcurrentMark.cpp:973-992(截取核心,逐字)
void G1ConcurrentMark::mark_from_roots() {
  _restart_for_overflow = false;

  _num_concurrent_workers = calc_active_marking_workers();

  uint active_workers = MAX2(1U, _num_concurrent_workers);

  active_workers = _concurrent_workers->update_active_workers(active_workers);
  log_info(gc, task)("Using %u workers of %u for marking", active_workers, _concurrent_workers->total_workers());

  set_concurrency_and_phase(active_workers, true /* concurrent */);

  G1CMConcurrentMarkingTask marking_task(this);
  _concurrent_workers->run_task(&marking_task);
  print_stats();
}
```

calc_active_marking_workers 动态计算并行度(不超过 ConcGCThreads);G1CMConcurrentMarkingTask 继承 AbstractGangTask,在 G1CMConcurrentMarkingTask::work 里对每个 worker 调 `task->do_marking_step(G1ConcMarkStepDurationMillis, ...)`——时间片轮转,到就让出。

### do_marking_step: 标记主循环

G1CMTask::do_marking_step(g1ConcurrentMark.cpp:2592 起):

1. **drain_satb_buffers()** — 先把 completed SATB buffer 里的旧值标记完,保证快照全部被消费。
2. **drain_local_queue(true) + drain_global_stack(true)** — 局部队列 + 全局 mark stack,把灰对象扫完。
3. **bitmap 迭代** — 持有 region,从 `_finger` 开始扫 bitmap 里的已标对象,通过 G1CMBitMapClosure 对每个标记过的对象遍历引用字段,未标的新对象进 make_reference_grey。
4. **claim_region()** — 当前 region 扫完,通过 CAS 全局 `_finger` 认领下一个 region。
5. **do_stealing** — 本地没工作时偷别人的队列(work stealing)。

do_marking_step 是可中断的(G1ConcMarkStepDurationMillis 默认 10ms): 到时间就置本 task 的 abort 标志让出 CPU;worker 循环(task->has_aborted() 且标记未中止)接着再来一个时间片。SATB buffer 与灰队列在每次调用内被逐步清空,全部清空后各 worker 经终止协议同步退出,一轮 mark_from_roots 完成。

### make_reference_grey: 对象标记入口

`make_reference_grey`(g1ConcurrentMark.inline.hpp:213-253):

```cpp
// g1ConcurrentMark.inline.hpp:213-253(截取核心,逐字)
inline bool G1CMTask::make_reference_grey(oop obj) {
  if (!_cm->mark_in_next_bitmap(_worker_id, obj)) {
    return false;
  }

  // No OrderAccess:store_load() is needed. It is implicit in the
  // CAS done in G1CMBitMap::parMark() call in the routine above.
  HeapWord* global_finger = _cm->finger();

  ...

  if (is_below_finger(obj, global_finger)) {
    G1TaskQueueEntry entry = G1TaskQueueEntry::from_oop(obj);

    ...

      process_grey_task_entry<false>(entry);
    } else {
      push(entry);
    }
  }
  return true;
}
```

`mark_in_next_bitmap` → par_mark → CAS 原子 set bit。`is_below_finger`: 全局 finger 以下是已扫描区域,如果新标到的对象在已扫描区域——它还没被扫到引用,必须入灰栈;如果在未扫描区域(≥ finger),bitmap 迭代自然会走到它,不重复入栈。typeArray 没引用,直接记账不入栈。

### work stealing

G1CMTask 的 _task_queue 由 G1CMTaskQueueSet 管理。每个 worker 有自己的本地队列,本地空了就从别人的队列偷。`ParallelTaskTerminator`(g1ConcurrentMark.hpp:327): 所有 worker 用 barrier 同步终止(termination protocol)。

---

## 3. 双 bitmap — 两轮标记互不干扰

### G1ConcurrentMark 成员

G1ConcurrentMark 的 bitmap 相关字段(g1ConcurrentMark.hpp:304-310):

```cpp
// g1ConcurrentMark.hpp:304-310(截取核心,逐字)
  G1CMBitMap              _mark_bitmap_1;
  G1CMBitMap              _mark_bitmap_2;
  G1CMBitMap*             _prev_mark_bitmap; // Completed mark bitmap
  G1CMBitMap*             _next_mark_bitmap; // Under-construction mark bitmap
```

双 bitmap: `_prev_mark_bitmap` = 上一轮完成的标记结果,cleanup/reclaim 用它判断对象生死;`_next_mark_bitmap` = 本轮标记填充的目标。并发标记期间,bitmap 迭代扫 next bitmap 的 marked 对象,对每个引用字段调 make_reference_grey → CAS 标 next bitmap。

### G1CMBitMap: par_mark + CAS

G1CMBitMap::par_mark(g1ConcurrentMarkBitMap.inline.hpp:81-85):

```cpp
// g1ConcurrentMarkBitMap.inline.hpp:81-85(截取核心,逐字)
inline bool G1CMBitMap::par_mark(HeapWord* addr) {
  check_mark(addr);
  return _bm.par_set_bit(addr_to_offset(addr));
}
```

`addr_to_offset`: pointer_delta(obj, _covered.start()) >> LogMinObjAlignment(=3)。8 字节粒度 → 1 bit/8 bytes。

par_set_bit 的 CAS 循环(bitMap.inline.hpp:41-57):

```cpp
// bitMap.inline.hpp:41-58(截取核心,逐字)
inline bool BitMap::par_set_bit(idx_t bit) {
  verify_index(bit);
  volatile bm_word_t* const addr = word_addr(bit);
  const bm_word_t mask = bit_mask(bit);
  bm_word_t old_val = *addr;

  do {
    const bm_word_t new_val = old_val | mask;
    if (new_val == old_val) {
      return false;     // Someone else beat us to it.
    }
    const bm_word_t cur_val = Atomic::cmpxchg(new_val, addr, old_val);
    if (cur_val == old_val) {
      return true;      // Success.
    }
    old_val = cur_val;  // The value changed, try again.
  } while (true);
}
```

CAS 保证: 一个 bit 被标且仅被标一次;多个线程同时标同一对象,只有一个成功,其余跳过(不重复入栈,不重复遍历)。bitmap 读写无锁——lock-free。

### 开销

1 个 bitmap 覆盖整个堆,每 8 字节 1 bit → 开销 = 1/64 = 1.5625% ≈ 1.6% per bitmap。两个 bitmap 共约 3.2%。用 G1RegionToSpaceMapper 按需 commit(26-01 §2.3 讲过)。

### swap + clear

remark 结束时 `swap_mark_bitmaps()`(g1ConcurrentMark.cpp:1179): next→prev(安装本轮结果为"上一轮"),clear 旧 bitmap 为下一轮准备。cleanup_for_next_mark: 用 WorkGang 并行 clear next bitmap 里的 marked bit,为下一轮做准备。

---

## 4. Remark — 最后补漏

remark() 在 STW 内执行(g1ConcurrentMark.cpp:1139-1158):

```cpp
// g1ConcurrentMark.cpp:1139-1158(截取核心,逐字)
void G1ConcurrentMark::remark() {
  assert_at_safepoint_on_vm_thread();

  if (has_aborted()) {
    return;
  }

  G1Policy* g1p = _g1h->g1_policy();
  g1p->record_concurrent_mark_remark_start();

  double start = os::elapsedTime();

  verify_during_pause(G1HeapVerifier::G1VerifyRemark, VerifyOption_G1UsePrevMarking, "Remark before");

  {
    GCTraceTime(Debug, gc, phases) debug("Finalize Marking", _gc_timer_cm);
    finalize_marking();
  }
```

### finalize_marking

finalize_marking(g1ConcurrentMark.cpp:1858-1890):

```cpp
// g1ConcurrentMark.cpp:1858-1890(截取核心,逐字)
void G1ConcurrentMark::finalize_marking() {
  ResourceMark rm;
  HandleMark   hm;

  _g1h->ensure_parsability(false);

  uint active_workers = _g1h->workers()->active_workers();
  set_concurrency_and_phase(active_workers, false /* concurrent */);

  {
    StrongRootsScope srs(active_workers);

    G1CMRemarkTask remarkTask(this, active_workers);
    _g1h->workers()->run_task(&remarkTask);
  }

  SATBMarkQueueSet& satb_mq_set = G1BarrierSet::satb_mark_queue_set();
  guarantee(has_overflown() ||
            satb_mq_set.completed_buffers_num() == 0,
            "Invariant: has_overflown = %s, num buffers = " SIZE_FORMAT,
            BOOL_TO_STR(has_overflown()),
            satb_mq_set.completed_buffers_num());
}
```

G1CMRemarkTask::work(g1ConcurrentMark.cpp:1828-1855)在 STW 内并行做两件事: 先 `Threads::threads_do` 把全部 Java 线程的根(栈/寄存器/nmethod 常量池里的引用)扫进标记——线程根在 Concurrent Start 暂停里已被扫过一遍,但并发期间栈引用一直在变,SATB 只记录被覆盖的旧值,remark 在 STW 下重扫当前值才能保证不漏;并发循环本身只扫 root regions,不碰线程根;再以极大超时(`1000000000.0`)调 do_marking_step,其第一步 `drain_satb_buffers()` 把剩余 SATB buffer 全部消费,然后反复走到本地与全局队列清空。全部完成才能返回;若标记栈溢出则中止 remark、`_restart_for_overflow` 走溢出重启。`completed_buffers_num() == 0` 确认没有残留。

### remark 内部阶段

**[实证](materials/commands/26-g1-gc-concurrent-mark-demo.txt)**: 同一程序,-Xlog:gc+phases=debug:

```
GC(1) Finalize Marking 0.032ms
GC(1) Reference Processing 0.014ms
GC(1) Weak Processing 0.002ms
GC(1) ClassLoaderData 0.005ms
GC(1) ProtectionDomainCacheTable 0.001ms
GC(1) Class Unloading 0.080ms
GC(1) Flush Task Caches 0.014ms
GC(1) Update Remembered Set Tracking Before Rebuild 0.021ms
GC(1) Reclaim Empty Regions 0.024ms
GC(1) Purge Metaspace 0.000ms
GC(1) Report Object Count 0.000ms
GC(1) Update Remembered Set Tracking After Rebuild 0.002ms
GC(1) Finalize Concurrent Mark Cleanup 0.022ms
```

阶段名与源码函数一一对应:

- **Finalize Marking**: G1CMRemarkTask 并行处理剩余 SATB buffer + drain 灰栈
- **Reference/Weak Processing**: 弱引用处理(JNI Global/Weak Global 等)
- **Class Unloading + Purge Metaspace**: 并发标记模式下的类卸载
- **Flush Task Caches**: 把 worker 本地 mark stats cache 汇总到全局
- **Update Remembered Set Tracking Before Rebuild**: 本轮的核心 — 把 bitmap 上的存活字节数记入每个 Region 的 `_next_marked_bytes`(26-01 §1.3 的字段)。这就是 liveness 入账: 每个 Region 有多少字节存活,Mixed GC 的 CSet 选择直接从这里读
- **Reclaim Empty Regions**: 把全空的 Region 回收到 freelist

**注意: Update Remembered Set Tracking Before Rebuild 在 remark 内(上面的 phases 日志清楚地显示它在 "Finalize Marking" 之后、"Reclaim Empty Regions" 之前),Rebuild Remembered Sets 是 remark 之后的并发阶段(素材 A 日志: "GC(1) Concurrent Rebuild Remembered Sets 0.163ms")。**

### 溢出重启

如果标记栈溢出: `has_overflown()=true` → restart_for_overflow=true → swap_mark_bitmaps 被跳过 → reset_marking_for_restart → 下一轮 mark_from_roots 重启。remark:1214-1220:

```cpp
// g1ConcurrentMark.cpp:1214-1220(截取核心,逐字)
    _restart_for_overflow = true;

    verify_during_pause(G1HeapVerifier::G1VerifyRemark, VerifyOption_G1UsePrevMarking, "Remark overflow");

    // Clear the marking state because we will be restarting
    // marking due to overflowing the global mark stack.
    reset_marking_for_restart();
```

---

## 5. Cleanup — 收尾

cleanup()(g1ConcurrentMark.cpp:1356-1369):

```cpp
// g1ConcurrentMark.cpp:1356-1369(截取核心,逐字)
void G1ConcurrentMark::cleanup() {
  assert_at_safepoint_on_vm_thread();

  if (has_aborted()) {
    return;
  }

  G1Policy* g1p = _g1h->g1_policy();
  g1p->record_concurrent_mark_cleanup_start();

  double start = os::elapsedTime();

  verify_during_pause(G1HeapVerifier::G1VerifyCleanup, VerifyOption_G1UsePrevMarking, "Cleanup before");
```

cleanup 非常短(0.021ms): 它不再计算 liveness(liveness 在 remark 的 Update Remembered Set Tracking Before Rebuild 已完成),只做 Update Remembered Set Tracking After Rebuild(收尾) + liveness 日志(可选) + 增计数。真正的"选择 collection set"在 G1Policy,由 _next_marked_bytes 驱动——那是 05-mixed-gc-policy 的故事。

---

## 核心悬念

**liveness 数据进了每个 Region 的 _next_marked_bytes,remark 结束就位。但 Mixed GC 怎么知道老年代哪些 Region 被年轻代对象引用了?** 答案: RSet——一个只记录"我这个 Region 被谁引用"的反向索引。G1 的 Evacuation Pause 不需要扫描整个老年代,只需要扫脏 card 指向的 RSet。写 barrier 的第二道(post-write barrier)在每次引用更新时默默记账,卡片在 GC 间按需重建——这些都是并发的,下次 STW 暂停时直接查 RSet 就知道"年轻代需要拷哪些"。RSet 的结构与 CardTable 的关系,是 G1 性能的第二根支柱。

> → [03-rem-set.md](03-rem-set.md)
