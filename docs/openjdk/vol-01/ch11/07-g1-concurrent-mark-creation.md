# G1ConcurrentMark 创建——并发标记引擎初始化

> **本文定位**：`G1CollectedHeap::initialize()` 第 1661-1668 行。创建 G1 的**并发标记引擎**——双缓冲位图、标记线程、并行工作任务、全局标记栈。这是 G1 "边跑边标"能力的核心基础设施。
>
> **前置依赖**：[ch11/06](06-remset-bot.md)（RemSet + BOT + CSet 快速测试）。


## 1. 执行位置与构造函数总揽

06 篇覆盖到 1659 行。紧接其后，`initialize()` 进入并发标记引擎的创建（`g1CollectedHeap.cpp:1660-1668`）：

```cpp
// Create the G1ConcurrentMark data structure and thread.
// (Must do this late, so that "max_regions" is defined.)
_cm = new G1ConcurrentMark(this, prev_bitmap_storage, next_bitmap_storage);
if (_cm == NULL || !_cm->completed_initialization()) {
    vm_shutdown_during_initialization("Could not create/initialize G1ConcurrentMark");
    return JNI_ENOMEM;
}
_cm_thread = _cm->cm_thread();
```

注释说得很清楚——**"Must do this late"**，必须等 `max_regions` 算好（ch11/05 里 HRM 初始化计算出来的）才能创建 CM。因为内部要分配 `max_regions` 大小的数组。

三行代码，但 `new G1ConcurrentMark(...)` 的构造函数有 **152 行**（`g1ConcurrentMark.cpp:344-495`），创建了上图中所有的数据结构。`completed_initialization()` 检查的就是构造函数最后一行设的 `_completed_initialization = true`——如果构造函数中间因为参数校验失败而提前 return，这个标志就是 false，`initialize()` 会 shutdown。

`G1ConcurrentMark` 是 G1 中**最复杂的单类之一**——它管理并发标记的全生命周期。但本文只关注**构造时创建了什么**，不讲解完整标记周期（那是后续篇章的事情）。

### 1.1 构造函数创建了什么——全景

构造函数做的事按逻辑关系分成 6 组：

```
G1ConcurrentMark 构造函数（344-495）
│
├── 位图（351-354, 400-401）──────────────────────── §2
│   ├── _mark_bitmap_1 / _mark_bitmap_2      两个物理位图实例
│   └── _prev_mark_bitmap / _next_mark_bitmap 两个指针，初始指向不同位图
│
├── CM 线程（404-407）─────────────────────────────── §3
│   └── _cm_thread = new G1ConcurrentMarkThread(this)  标记驱动线程
│
├── 并行工作任务（364, 477-491）────────────────────── §4
│   ├── _tasks[ParallelGCThreads]            每个 STW worker 一个 CMTask
│   ├── _task_queues                         G1CMTaskQueueSet——无锁队列集
│   └── _terminator                          ParallelTaskTerminator——终止协议
│
├── 全局标记栈（360, 439-475）─────────────────────── §5
│   ├── _global_mark_stack                   任务间溢出卸载的共享栈
│   └── MarkStackSize 自动调优
│
├── 根 Region（358, 414）─────────────────────────── §6
│   └── _root_regions                        并发标记起始点——survivor Region
│
└── 其余（364-396, 416-437, 493）──────────────────── §7
    ├── ConcGCThreads 计算（416-437）        并发 GC 线程数（≠ ParallelGCThreads）
    ├── WorkGang（436-437）                  并发 worker 线程池
    ├── SATB buffer size（411-412）
    ├── 统计计时字段
    └── reset_at_marking_complete()（493）   初始化状态到"标记完成"状态
```

每一组都在构造函数里做了实质性的分配和初始化。下面逐个展开。

---

## 2. 双缓冲位图——prev 和 next 指针交换

### 2.1 两个位图 + 两个指针——先认结构，原因后讲

`G1ConcurrentMark` 持有两张物理位图和两个角色指针：

```cpp
G1CMBitMap  _mark_bitmap_1;       // 物理位图 A
G1CMBitMap  _mark_bitmap_2;       // 物理位图 B
G1CMBitMap* _prev_mark_bitmap;    // 角色指针——"上一轮完整标记"
G1CMBitMap* _next_mark_bitmap;    // 角色指针——"本轮构建中的标记"
```

初始化：

```cpp
// 初始化列表
_prev_mark_bitmap(&_mark_bitmap_1),   // 初始：物理 A 扮演 "prev"
_next_mark_bitmap(&_mark_bitmap_2),   // 初始：物理 B 扮演 "next"

// 构造函数体——把物理位图和 Mapper 绑定
_mark_bitmap_1.initialize(g1h->reserved_region(), prev_bitmap_storage);
_mark_bitmap_2.initialize(g1h->reserved_region(), next_bitmap_storage);
```

>`prev_bitmap_storage` 和 `next_bitmap_storage` 是 [ch11/05](05-memory-layout-mapper.md) 中创建的 6 个 `G1RegionToSpaceMapper` 中的两个——一个对应"上一轮标记位图"的存储，一个对应"本轮标记位图"的存储。每个 Mapper 各自预留一块独立的虚拟地址空间（8GB 堆各约 16MB），ch11/05 §4 的表格里有详细数据。

两个物理位图对象是**值成员**（嵌入在 G1ConcurrentMark 里），各自用一个独立的 `G1RegionToSpaceMapper` 做存储。`_prev` 和 `_next` 是指针——它们不持有数据，指向哪块物理位图，哪块就扮演哪个角色。

**swap 操作**（`g1ConcurrentMark.cpp:1759`）只交换指针：

```cpp
void G1ConcurrentMark::swap_mark_bitmaps() {
    G1CMBitMap* temp = _prev_mark_bitmap;
    _prev_mark_bitmap = _next_mark_bitmap;   // prev → 旧 next（刚完成标记的位图）
    _next_mark_bitmap = temp;                // next → 旧 prev（需要被清除的位图）
    _g1h->collector_state()->set_clearing_next_bitmap(true);
}
```

swap 之后角色互换——刚标记完的变成"档案"（prev，供 GC 读），旧的"档案"变成"画布"（next，需要被清除）。为什么需要两张而不是一张——这个问题留到后面讲 GC 生命周期时再展开，这里先记住`构造时创建了两张`这个事实。

### 2.2 G1CMBitMap——位图本身

```cpp
class G1CMBitMap {
    MemRegion _covered;     // 覆盖的堆范围
    const int _shifter;     // 地址到位图索引的位移量
    BitMapView _bm;         // 实际的位存储
    G1CMBitMapMappingChangedListener _listener;  // 堆扩展时的 commit 回调
};
```

**不继承自任何类**——是一个独立的包装器，围绕 `BitMapView`（继承自 `BitMap`）构建。

**位图粒度**：每个 bit 对应堆上 **64 字节**。`_shifter` 被初始化为 `LogMinObjAlignment`（= 3，因为 2^3 = 8），从堆地址到位图索引的换算：

```
bitmap_index = pointer_delta(addr, heap_base) >> _shifter
             = (addr 的 HeapWord 偏移量) >> LogMinObjAlignment
             = (addr 的 HeapWord 偏移量) / 8
             // 每个 bit 覆盖 8 个 HeapWord = 64 字节
```

**位图总大小**：`heap_size / 64 bytes * 1 bit = heap_size / 512`。一个 8GB 的堆，位图大约 16MB。

### 2.3 位图的物理存储——Mapper 提供内存，BitMapView 提供操作

位图的数据存在哪？不是 `new` 出来的——由 [ch11/05](05-memory-layout-mapper.md) 的 `G1RegionToSpaceMapper` 提前 `mmap` 好的一块虚拟内存。初始化就是**把这块内存"绑定"到位图对象上**：

```cpp
void G1CMBitMap::initialize(MemRegion heap, G1RegionToSpaceMapper* storage) {
    _covered = heap;                     // 记录位图覆盖的堆范围
    _bm = BitMapView(                    // ← 构造一个"位图视图"
        (BitMap::bm_word_t*) storage->reserved().start(),  // 参数1: 内存地址
        _covered.word_size() >> _shifter                    // 参数2: 需要多少 bit
    );
    storage->set_mapping_changed_listener(&_listener);
}
```

**这行干了什么——拆开看**：

```
参数1:  storage->reserved().start()
        ↑ Mapper mmap 预留的一块虚拟内存的起始地址
        → 比如地址 0x7f0000000000

参数2:  _covered.word_size() >> _shifter
        ↑ 堆有多少个 HeapWord  /  8  (因为 _shifter=3, 每 bit 覆盖 8 个 HeapWord)
        → 结果 = 位图需要多少个 bit
        → 8GB 堆 = 134,217,728 个 bit (约 16MB)

结果:  _bm 现在就指向 0x7f0000000000，可以调 _bm.set_bit(100) 把第 100 个 bit 置 1
      也可以调 _bm.at(100) 检查第 100 个 bit 是不是 1
```

**类比**——就像一个 `bool[]` 数组：

```
普通写法:  bool* marks = new bool[堆的HeapWord数 / 8];
          marks[12345] = true;

G1 写法:  Mapper 用 mmap 提前留好内存 (比 new 灵活——可以按需 commit/uncommit)
          BitMapView 把这片内存包装成 "set_bit(index) / at(index)" 接口
          → _bm.set_bit(12345)  // 效果一样——把第 12345 个 bit 置 1
```

**为什么不用 `new` 而用 Mapper？** 因为 G1 需要**按 Region 粒度 commit/uncommit**。堆扩展到某个 Region 时，Mapper 只 commit 那个 Region 对应的位图页面（而不是整张位图），节约物理内存。`new[]` 出来的内存全量 commit，没法按需控制。

**和 card table 的对比**：card table 用偏置数组（`_byte_map_base + (addr >> 9)`）一行算出地址直接写（ch11/05 §3）。位图定位更复杂——`offset / word_bits` 算字索引 + `offset % word_bits` 算位偏移——没法缩成一行裸地址计算，所以走了 `BitMap` 的方法调用。

当 Mapper commit 新页面时，`G1CMBitMapMappingChangedListener::on_commit()` 回调自动清零新页面对应的位图范围，保证新 Region 的位图从全零开始。

### 2.4 mark() 和 is_marked()

两个操作本身很简单（`g1ConcurrentMarkBitMap.inline.hpp`）：

```cpp
inline void G1CMBitMap::mark(HeapWord* addr) {
    check_mark(addr);
    _bm.set_bit(addr_to_offset(addr));   // (addr - base) >> _shifter → 置位
}

inline bool G1CMBitMap::is_marked(HeapWord* addr) const {
    return _bm.at(addr_to_offset(addr)); // (addr - base) >> _shifter → 读取
}
```

但有一个关键细节——`par_mark(addr)` 用 `_bm.par_set_bit(offset)`（**原子 CAS**），允许多个标记线程安全地并发标记同一位。这是并发标记的基础——多个 worker 可能同时扫描到同一个对象，所有人尝试标记同一 bit，只有一个 CAS 成功，但不影响正确性（bit 已经置位了，后续 CAS 虽然失败但 bit 本来就是 1）。

---

## 3. CMThread——标记周期的指挥者

### 3.1 它是干什么的——按顺序跑剧本的线程

CMThread 不执行标记本身。**标记是 CMTask 干的**（§4 会讲——CMTask 被 WorkGang 的并发 worker 线程执行，追踪引用图、写 `_next` 位图）。CMThread 只负责一件事：**按顺序推动标记周期的每一个阶段。**

具体来说，CMThread 被唤醒后做的事就是——

1. 调 `_cm->scan_root_regions()` → 启动并发 worker 扫描 Init Mark 暂停中生成的 survivor Region，把对象标到 `_next` 位图（详见 [§6](#6-g1cmrootregions根-region-追踪器)）。CMThread 等着。
2. 调 `_cm->mark_from_roots()` → 启动并发 worker 去标记。等。
3. 调 `VMThread::execute(remark_op)` → 请求 VMThread 做一次 STW 暂停。等。
4. 调 `_cm->rebuild_rem_set_concurrently()` → 启动并发 worker 重建 RSet。等。
5. 调 `VMThread::execute(cleanup_op)` → 再请求一次 STW 暂停。等。
6. 调 `_cm->cleanup_for_next_mark()` → CMThread **自己**并发清除 next 位图。
7. 跳回第 1 步的 sleep，等着下一次被叫醒。

它自己不追踪引用、不标记对象、不暂停 JVM——它只是**按顺序调函数，等每个函数跑完，再调下一个**。就像个按剧本念台词的导演——真正搬道具、演戏的是别人。

### 3.2 为什么要这样一个线程——标记的"拆开"和"重组"

全量标记如果一次 STW 做完，堆大了要几百毫秒，应用卡死。G1 把标记拆成"并发做大部分 + 两次短暂 STW 收尾"。

但拆开之后，谁来保证步骤按对顺序执行？谁等在 scan 完成后再开始 mark？谁在 remark 之后决定"要不要重来"？——**CMThread 就是来重新组装的**——它知道完整剧本，按顺序执行，每一步等前一步确认完成后再走下一步。

### 3.3 怎么被叫醒——三态状态机

```cpp
enum State {
    Idle,        // 在 CGC_lock 上 wait()，睡觉
    Started,     // 有人发了启动信号，但 CMThread 还没读到——一个瞬态
    InProgress   // CMThread 正在执行标记周期
};
```

**睡觉**（Idle）——`sleep_before_next_cycle()` 里在 `CGC_lock` 上调 `wait()`：

```cpp
void G1ConcurrentMarkThread::sleep_before_next_cycle() {
    MutexLockerEx x(CGC_lock, Mutex::_no_safepoint_check_flag);
    while (!started() && !should_terminate()) {
        CGC_lock->wait(...);   // 释放锁，park 自己
    }
    if (started()) {
        set_in_progress();     // Started → InProgress
    }
}
```

**被叫醒**——当 G1Policy 判定该做并发标记时，下一次 Young GC 会从 "Normal Young GC" 升级为 "Initial-Mark Young GC"（也叫 concurrent start pause, `g1CollectedHeap.cpp:2839`）。它和 Normal Young GC 一样是 STW、一样有 evacuation，但多了以下几步（按源码执行顺序, `g1CollectedHeap.cpp:2940-3016`）：

> **本节读者**：下面四步只看个大概即可——TAMS 是什么、什么时候开的 SATB、在哪里发的信号。Init Mark Young GC 本身的完整讲解在后面的 Young GC 系列章节，这里只是为 CMThread 的"被唤醒"提供上下文，不需要深究细节。重心在"暂停结束后 CMThread 收到信号"。

1. **`pre_initial_mark()`**（`g1ConcurrentMark.cpp:751-758`）
   - 调 `reset()` 初始化标记数据结构
   - 对每个 Region 调 `r->note_start_of_marking()`——把 `top()` 快照为 NTAMS（Next Top At Mark Start）。NTAMS 以上的对象都是并发标记开始后才分配的，天然存活，不需要标记

2. **`evacuate_collection_set()`**（`g1CollectedHeap.cpp:2975`）
   - 和 Normal Young GC 一样撤离 young Region，但用的是 `G1InitialMarkClosures`（`g1RootClosures.cpp:59`）
   - 闭包内对每个在 CSet 中的对象：拷贝到 survivor/old 后，把**新位置**标记到 `_next` 位图（`g1OopClosures.inline.hpp:260-263`）
   - 闭包内对每个**不在 CSet 中但被 GC Root 引用的对象**：直接标记原位置到 `_next` 位图（`g1OopClosures.inline.hpp:276-277`）
   - Normal Young GC 的闭包用 `G1MarkNone`（不标记），Init Mark 用 `G1MarkFromRoot`（标记）——这就是两种 Young GC 的核心区别

3. **`post_initial_mark()`**（`g1ConcurrentMark.cpp:761-780`）
   - 启动 CM 弱引用发现（`enable_discovery()`）
   - **打开 SATB 写屏障开关**：`set_active_all_threads(true)`——从此刻起 mutator 覆盖引用字段时把旧值记入 SATB 队列
   - 准备 root region 扫描：`_root_regions.prepare_for_scan()`

4. **`do_concurrent_mark()`**（`g1CollectedHeap.cpp:3111-3119`，在日志输出之后）
   - 调 `_cm_thread->set_started()` + `CGC_lock->notify()`——但 CMThread 还在 safepoint 里冻结着，收不到信号

**暂停结束后**，CMThread 恢复运行，`sleep_before_next_cycle()` 里的 `CGC_lock->wait()` 收到 notify 返回，读到 `started() == true`，推进到 `InProgress`——开始跑 §3.5 的 7 步并发标记周期。

Init Mark Young GC 本身是另一个大章节的主题（Young GC 序列 + 后续并发标记融合），本文只用到它和 CMThread 的接口——**暂停结束后 CMThread 被唤醒**。

**构造时就启动**——CMThread 在 G1ConcurrentMark 构造函数里 `new + create_and_start()`，立即创建 OS 线程并启动。线程一启动就跑 `run_service()`，但第一时间就进入 `sleep_before_next_cycle()` 睡觉。所以直到第一次 initial-mark 暂停发生前，它都是睡着的。

### 3.4 完整触发链——从 IHOP 到 Mixed GC

在深入 CMThread 的 7 步剧本之前，先把整条链串起来——CMThread 不是凭空启动的：

```
Normal Young GC 结束
  → G1Policy 检查 IHOP（Initiating Heap Occupancy Percent）
  → old 区占用率超过阈值 → set_initiate_conc_mark_if_possible = true
    ↓
下一次 Young GC 开始
  → decide_on_conc_mark_initiation() 读到 flag = true
  → in_initial_mark_gc = true → 这次变成 Init-Mark Young GC（§3.3）
    ↓
Init-Mark Young GC STW 暂停
  → 设 TAMS + 撤离并标记 next + 开 SATB + do_concurrent_mark()
  → 唤醒 CMThread
    ↓
CMThread 醒来 → 7 步标记周期（下面详述）
    ↓
⑥ CLEANUP STW
  → swap 位图 + record_concurrent_mark_cleanup_end()
  → next_gc_should_be_mixed() → 设 in_young_gc_before_mixed = true
    ↓
下一次 Young GC → 变成 Mixed GC（读 prev 位图判断死活）
    ↓
多轮 Mixed GC，直到候选 old Region 回收完毕或收益低于阈值
  → 回到 Normal Young GC
```

`decide_on_conc_mark_initiation()` 和 `next_gc_should_be_mixed()` 都在 `g1Policy.cpp` 中，它们分别控制 Init-Mark Young GC 和 Mixed GC 的触发。

### 3.5 CMThread 的 7 步标记周期

CMThread 醒来后按 7 步跑完一个完整的标记周期。先看总览，再逐个拆解。

```
┌─ Idle (睡觉) ─────────────────────────────────────────────────────────┐
│                                                                        │
│  ← Init Mark Young GC STW 暂停: 设 TAMS + 撤离并标记 + 开 SATB + notify ──┘
│     (详见 §3.3; 暂停结束后 CMThread 恢复运行，收到 notify 醒来)
│
│  状态: Started → InProgress
│
│  ① CLEAR_CLAIMED_MARKS         清 CLD claimed 标记（几微秒）
│  ② SCAN_ROOT_REGIONS           并发扫描 survivor Region（详见 §6）
│  ③ CONCURRENT_MARK             标记主体（见下方展开）
│  ④ REBUILD_REMEMBERED_SETS     并发重建 RSet
│  ⑤ delay_to_keep_mmu()         等一会儿（让 mutator 跑够）
│  ⑥ CLEANUP (STW)               swap 位图 + 决定 mixed GC
│  ⑦ CLEANUP_FOR_NEXT_MARK       并发清除 next 位图
│
│  状态: InProgress → Idle  （CMThread 睡觉，但 Mixed GC 可能还在跑）
│
└→ 回到 Idle，继续睡觉
```

**关键区分**：
- **③ 是"并发标记"**（CMTask 追踪引用图，写 `_next` 位图）。**⑦ 是"并发清除"**（CMThread 擦 next 位图）。③ 在 ⑥ 之前完成，Mixed GC **不和 ③ 并发**，但**和 ⑦ 并发**。
- **① ② ④ ⑦** 是并发的（CMThread 派活给 worker，自己等，应用继续跑）。
- **③ 中的 REMARK 和 ⑥ CLEANUP** 是 STW 暂停（CMThread 请求 VMThread 让全 JVM 停下）。

---

#### ① CLEAR_CLAIMED_MARKS——初始化

调 `ClassLoaderDataGraph::clear_claimed_marks()`，清类加载数据的 claimed 标记。几微秒的事。

#### ② SCAN_ROOT_REGIONS——扫描 survivor Region

Init Mark Young GC 暂停中，young Region 被撤离到 survivor Region。这些 survivor Region 里的对象在 `_next` 位图中还是"未标记"状态——但它们是存活的。如果不趁早扫一遍，后续 evacuation 暂停可能误把它们当死的回收。

CMThread 启动多个并发 worker，用 `claim_next()` 原子认领 survivor Region，逐个扫描里面所有对象，标记到 `_next`。详见 §6。

#### ③ CONCURRENT_MARK——标记主体

这是整个周期中最耗时的一步，内部是一个子循环（可能因栈溢出而重来多次）：

**mark_from_roots()**——CMThread 把活派给 `ConcGCThreads` 个 worker（不是 `ParallelGCThreads`，并发标记不占满 CPU）。每个 worker 拿一个 CMTask，从 GC Root 出发追踪引用图：遇到对象就标记到 `_next` 位图，把未扫描的灰色对象 push 到本地队列，继续追踪。§4 会详细讲 CMTask 的工作方式。

**preclean()**——预清理引用，减少后续 Remark 的工作量。

**delay_to_keep_mmu()**——等一会儿，让 mutator 跑够。G1 要保证 mutator 在 GC 周期内仍然有足够的 CPU 时间（MMU = Mutator Utilization）。不能一直疯狂标记把应用卡住。

**REMARK（STW 暂停）**——并发标记跑完后，`_next` 位图里已经有大部分存活对象的标记了，但还差一批：并发标记期间 mutator 覆盖引用字段时被 SATB 写屏障记录下来的"旧引用"。Remark 暂停时全 JVM 停下，排空所有线程的 SATB 队列，追踪那些旧引用，把它们也标记到 `_next`——**此时 `_next` 才真正完整**。若标记栈溢出（全局 Mark Stack 装不下了，见 §5），`restart_for_overflow()` 返回 true，回到 ③ 重来一遍。

**Remark 之前的位图状态**：`_next` 里大部分存活对象已标，但漏了 SATB 队列里攒的旧引用。Remark 补上这最后一块，之后 `_next` = 完整的存活快照。

#### ④ REBUILD_REMEMBERED_SETS——重建 RSet

并发标记证实了哪些对象存活，现在可以更新 RSet 了。CMThread 启动并发 worker，重新扫描选中的 old Region，更新它们内部对象的"谁引用了我"信息。和 ch11/06 讲过的 RSet 是同一套数据。

#### ⑤ delay_to_keep_mmu()——再等一会儿

和 ③ 中的 delay 一样——给 mutator 让路，保证 MMU。

#### ⑥ CLEANUP（STW 暂停）——swap 收尾

全 JVM 暂停。做三件事：

1. **swap 位图**：调 `swap_mark_bitmaps()`（§2.1）。`_next`（现在完整了）变成 `_prev`——从此 GC 可以用它判断对象死活。`_prev` 变成 `_next`——上面有上一轮的旧标记，需要清除。
2. **选 Mixed GC 候选**：调 `G1Policy::record_concurrent_mark_cleanup_end()` → `next_gc_should_be_mixed()`。基于 `_prev` 的存活率选出哪些 old Region 值得回收，设 `in_young_gc_before_mixed = true`。下一次分配触发的 Young GC 会晋升为 Mixed GC。
3. **标记周期结束**：`in_young_only_phase` 根据是否有 Mixed GC 候选来设置。

#### ⑦ CLEANUP_FOR_NEXT_MARK——并发清空下一轮画布

⑥ CLEANUP STW 结束后，CMThread **不睡觉**——直接进入 ⑦。`run_service()` 中 ⑥ 和 ⑦ 之间没有 `sleep_before_next_cycle()`，是连续执行的（`g1ConcurrentMarkThread.cpp:382-384`）。

**这里容易混淆**：CMThread 跑了完整的 7 步，但**只有第 ⑦ 步和 Mixed GC 重叠**。前 6 步（包括 ③ 并发标记）全部在 Mixed GC 开始前就完成了。

**实现**——CMThread 调用 `_cm->cleanup_for_next_mark()`（`g1ConcurrentMark.cpp:698`），内部：

```cpp
// g1ConcurrentMark.cpp:709
clear_bitmap(_next_mark_bitmap, _concurrent_workers, true);  // may_yield=true
```

`clear_bitmap`（`:683`）创建 `G1ClearBitMapTask`，把 `_next` 位图分成 1MB 的块，派给 `ConcGCThreads` 个并发 worker 并行清零。每个 worker 执行 `G1ClearBitMapTask::work()`（`:673`）：

```cpp
void work(uint worker_id) {
    SuspendibleThreadSetJoiner sts_join(_suspendible);  // :674, 加入 STS
    G1CollectedHeap::heap()->heap_region_par_iterate_from_worker_offset(&_cl, ...);
    // → G1ClearBitmapHRClosure::do_heap_region(r)       // :632
    // → _bitmap->clear_range(mr)                        // :640 ★ 真正写 0
    // → do_yield_check()                                // :645 检查是否需 yield
}
```

`run_task()` 是阻塞调用——全部 worker 干完才返回。`:695` 有 hard guarantee：`must_yield || cl.is_complete()`——**必须全部清完，CMThread 才继续。**

**时钟调度——SuspendibleThreadSet**：HotSpot 自己实现的一套阻塞/恢复机制（底层是 `pthread_cond_wait` / `pthread_cond_broadcast`，不是 Linux 独有的内核特性）。G1 中所有并发线程都加入 STS：

| 线程 | 代码位置 |
|------|---------|
| CMThread 自身 | `g1ConcurrentMarkThread.cpp:120` |
| 并发标记 worker（③ mark_from_roots） | `g1ConcurrentMark.cpp:838` |
| 并发清位图 worker（⑦ clear_bitmap） | `g1ConcurrentMark.cpp:674` |
| Concurrent Refinement 线程（消费 DCQ） | `g1ConcurrentRefineThread.cpp:108` |
| RSet rebuild worker（④） | `g1RemSet.cpp:985` |
| YoungGenSamplingThread | `g1YoungRemSetSamplingThread.cpp:107` |

每次 STW 暂停的开始/结束，VMThread 调用 G1CollectedHeap 的两个钩子（`g1CollectedHeap.cpp:1763-1768`）：

```
STW 开始 → safepoint_synchronize_begin()
    → SuspendibleThreadSet::synchronize()     // 阻塞所有 STS 线程

STW 结束 → safepoint_synchronize_end()
    → SuspendibleThreadSet::desynchronize()   // 一次性广播解除阻塞
```

所以 timeline：CMThread 在 ⑦ 中启动并发 worker 清 `_next` → 清的过程中混入 Mixed GC STW → STS 自动阻塞 worker → STW 结束 → STS 自动解除阻塞 → worker 继续清 → …。等到全部 Mixed GC 结束，`_next` 也清干净了。各干各的位图，没有冲突。

---

理解以上 7 步后，再看 §3.7（SATB）就有上下文了——知道 Remark 是什么、swap 在哪一步发生、`_next` 什么时候完整、`_prev` 什么时候产生。

### 3.6 类定义——附带的代码

```cpp
// g1ConcurrentMarkThread.hpp
class G1ConcurrentMarkThread : public ConcurrentGCThread {
    G1ConcurrentMark* _cm;          // 指向标记管理器（知道位图、CMTask、全局栈等）
    volatile State _state;          // Idle / Started / InProgress
    double _vtime_accum;            // 累积虚拟时间（JMX 监控用）
};
```

继承自 `ConcurrentGCThread`（→ `NamedThread` → `Thread`）。基类提供 `_should_terminate`（由 `stop()` 设 true，用于 JVM 关机时让线程退出循环）以及 `create_and_start()` / `stop_service()` 方法。

构造函数（`g1ConcurrentMarkThread.cpp`）：
```cpp
G1ConcurrentMarkThread::G1ConcurrentMarkThread(G1ConcurrentMark* cm) :
    ConcurrentGCThread(), _cm(cm), _state(Idle) {
    set_name("G1 Main Marker");
    create_and_start();  // 创建 OS 线程，线程一启动就 run() → run_service() → sleep
}
```

在 G1ConcurrentMark 构造函数（`g1ConcurrentMark.cpp:404-407`）中：
```cpp
_cm_thread = new G1ConcurrentMarkThread(this);
if (_cm_thread->osthread() == NULL) {
    vm_shutdown_during_initialization("Could not create ConcurrentMarkThread");
}
// _cm_thread->cm_thread() 就是把这个线程指针返回给 initialize()
```
### 3.7 SATB 和双缓冲位图的关系

SATB（Snapshot At The Beginning）是 G1 的核心并发标记算法。它和双缓冲位图的互动是理解整个并发标记的关键。

**并发标记周期的起点**——Init Mark Young GC（STW 暂停, §3.3）。在撤离 young Region 的过程中，`G1InitialMarkClosures` 把 GC Root 直接可达的对象和 evacuate 到新位置的对象标记到 `_next` 位图（`g1OopClosures.inline.hpp:260-277`）。此时 `_next` 是一个**不完整的快照**——只有 Root 直接可达和被搬走的对象被标记，间接可达的需要后续并发扫描。

**并发标记期间**——mutator 在跑，可能修改引用。每次覆盖一个引用字段，SATB 写屏障把**覆盖前的旧值**记录到线程的 SATB 本地队列里：

```
mutator 执行: obj.field = new_value;
  └→ SATB 写屏障: enqueue(old_value)  // 快照了被覆盖的旧引用
```

为什么要记录旧值？Init Mark Young GC 结束时，`_next` 位图里存的是"那个时刻对象图的快照"——"obj.field 指向 old_value"在这个快照里是存活的。即使 mutator 后来把它改掉了，标记也必须覆盖 old_value 及它所能到达的所有对象。如果不记录，这些引用就"漏标"了（被并发标记线程认为已死，但实际上是存活）。

**Remark 暂停时**——所有 SATB 队列被排空，里面的引用被追踪并标记到 `_next_mark_bitmap`：

```
所有线程的 SATB 本地队列 → completed buffers → remark 阶段排空
  → 遍历每个旧引用 → 标记到 _next_mark_bitmap
  → 追踪可达对象 → 也标记到 _next_mark_bitmap
```

**swap 之后**——`_next`（现在是完整的 SATB 快照）变成 `_prev`，GC 用它判断存活：

```
swap_mark_bitmaps() 之后:
  _prev 持有了完整的存活对象标记 → 供 GC 疏散时查阅
  _next 被清除 → 供下一轮标记使用
```

**一个具体的例子**——从 Init Mark Young GC 到 swap 的完整流程：

```
Init Mark Young GC（§3.3）:
  对象 A 的字段 f 指向对象 B
  evacuate A（A 在 young Region 中）→ A 搬走，标记 B 到 _next

并发标记期间，mutator 修改（在 ③ mark_from_roots 之后、Remark 之前）:
  A.f = C;  // 把指向 B 的引用改成指向 C
  SATB 写屏障: enqueue(&B)  // 记录被覆盖的旧引用 B

并发标记线程可能已经扫过了 A，不会再看到 B
  → 如果没有 SATB 记录 B，B 就被"漏标"了

Remark 暂停（③ 末尾）:
  排空 SATB 队列 → 找到 B → 标记到 _next → 追踪 B 的引用
  → B 仍然被正确标记为存活

⑥ CLEANUP swap:
  _prev = _next（是完整的存活标记）
  _next = _prev_old（被清除，下一轮用）
```

**关键洞察**——SATB 保证了"标记开始时对象图的完整性"：即使 mutator 在并发标记期间改了引用，旧引用链上的对象也不会被遗漏。双缓冲位图让这个"上一轮的完整标记"和"当前轮的不完整标记"物理分离，swap 时只需交换指针，代价极低。

### 3.8 构造时的初始化——回调 §2

有了标记周期的背景，回头再看 §2.1 中构造函数初始化位图的那几步就更清楚了：

```cpp
// 初始化列表
_prev_mark_bitmap(&_mark_bitmap_1),   // 初始：物理 A 扮演 prev
_next_mark_bitmap(&_mark_bitmap_2),   // 初始：物理 B 扮演 next

// 构造函数体
_mark_bitmap_1.initialize(g1h->reserved_region(), prev_bitmap_storage);
_mark_bitmap_2.initialize(g1h->reserved_region(), next_bitmap_storage);
```

初始指向是任意的——`_mark_bitmap_1` 当 prev、`_mark_bitmap_2` 当 next。第一次 cleanup STW 的 swap 之后就会反过来。swap 只是交换指针，物理位图对象本身不变。

`initialize(g1h->reserved_region(), mapper)` 把 Mapper 预留的虚拟内存地址作为位图存储（§2.3 讲过了），两个 Mapper（`prev_bitmap_storage` 和 `next_bitmap_storage`）来自 ch11/05 的 6 个 Mapper。

---

## 4. CMTask 并行框架——构造时造了什么，运行时怎么用

§3.5 的 ③ 中提到：CMThread 在 `mark_from_roots()` 里把活派给并发 worker。这个"派活"依赖于构造函数中创建的一套基础设施。

### 4.1 构造时——G1ConcurrentMark::G1ConcurrentMark() 中创建了什么

片段（`g1ConcurrentMark.cpp:364-491`，删掉了位图和 CMThread 部分）：

```cpp
// 初始化列表:
_worker_id_offset(DirtyCardQueueSet::num_par_ids() + G1ConcRefinementThreads),
_max_num_tasks(ParallelGCThreads),         // CMTask 槽位数 = STW GC 线程数

// 构造函数体:
_task_queues = new G1CMTaskQueueSet(_max_num_tasks);     // ① 全局队列集
_terminator = ParallelTaskTerminator(_max_num_tasks, _task_queues);  // ② 终止协议

// ConcGCThreads 计算 + WorkGang 创建（§7.1）:
_concurrent_workers = new WorkGang("G1 Conc", ConcGCThreads, ...);  // ③ 线程池

// MarkStackSize 计算 + _global_mark_stack 初始化（§5）

_tasks = NEW_C_HEAP_ARRAY(G1CMTask*, _max_num_tasks, mtGC);
_accum_task_vtime = NEW_C_HEAP_ARRAY(double, _max_num_tasks, mtGC);

for (uint i = 0; i < _max_num_tasks; ++i) {
    G1CMTaskQueue* task_queue = new G1CMTaskQueue();
    task_queue->initialize();
    _task_queues->register_queue(i, task_queue);           // ④ 登记队列

    _tasks[i] = new G1CMTask(i, this, task_queue, ...);    // ⑤ 创建 CMTask
    _accum_task_vtime[i] = 0.0;
}
```

**构造时创建的 5 样东西及其关系**：

```
G1ConcurrentMark
├── _task_queues  (G1CMTaskQueueSet)     ← 管理全部队列，供偷活用
│   └── queues[0..N-1]                    ← N = ParallelGCThreads 个队列
│
├── _tasks[]      (G1CMTask* 数组)       ← 标记逻辑载体，每个绑一个队列
│   └── _tasks[i] → CMTask#i  ─→ _task_queue → queues[i]
│                                  ↑ 同一份队列，两处引用
│
├── _concurrent_workers (WorkGang)       ← 线程池，管实际 OS 线程
│   └── GangWorker[0..M-1]               ← M = ConcGCThreads (≤ N)
│
└── _terminator   (ParallelTaskTerminator) ← 全部 worker 完成的判定
```

- `_task_queues`：N 个队列的集合，每个队列无锁——自己操作自己的不竞争
- `_tasks[i]`：每个 CMTask 绑一个 `worker_id`（= i）和一个队列。构造完不再变，标记周期之间只 `reset()`
- `_concurrent_workers`：M 个 GangWorker 线程。M = ConcGCThreads ≤ N = ParallelGCThreads。为什么 M ≤ N？并发标记不占满 CPU，给 mutator 留核
- `_terminator`：判断"所有 worker 都干完了"的协调器（§4.5）

### 4.2 运行时——mark_from_roots() 中怎么用

CMThread 在 step ③ 中调用 `mark_from_roots()`（`g1ConcurrentMark.cpp:976-991`）：

```cpp
_num_concurrent_workers = calc_active_marking_workers();    // M = ConcGCThreads
_concurrent_workers->update_active_workers(active_workers);
set_concurrency_and_phase(active_workers, true);             // 激活前 M 个 CMTask

G1CMConcurrentMarkingTask marking_task(this);               // 包装成一个 GangTask
_concurrent_workers->run_task(&marking_task);                // ★ 阻塞等待全部完成
```

`run_task()` 内部：WorkGang 把 `marking_task` 分发给 M 个 GangWorker。每个 GangWorker 的 `work(worker_id)` 中（`:831-855`）：

```cpp
G1CMTask* task = _cm->task(worker_id);                    // worker_id=3 → _tasks[3]
do {
    task->do_marking_step(G1ConcMarkStepDurationMillis,
                          true,   // do_termination
                          false); // is_serial
    _cm->do_yield_check();                                 // 检查 safepoint
} while (!_cm->has_aborted() && task->has_aborted());     // 异常退出 → 可能重启
```

`do_marking_step()` 的流程（`:2592-2790+`）：

```
① drain_satb_buffers()       排空 SATB 缓冲（mutator 攒的被覆盖旧引用）
② drain_local_queue()        排空本地队列（上一步残留的灰色对象）
③ drain_global_stack()       排空全局 Mark Stack（其他 worker 卸载的，§5）
↓
主循环:
  ├── 持有 Region？→ bitmap_closure 遍历该 Region，找已标记的对象
  │                    → 对每个已标对象调 oop_closure 扫其引用字段
  │                    → 引用的新对象标记到 _next，push 到本地队列
  ├── drain_local_queue() / drain_global_stack()
  ├── 没有 Region 了？→ _cm->claim_region(worker_id) 认领下一个 Region
  ├── 所有 Region 扫完了？→ try_stealing() 偷别人的队列（§4.4）
  └── 也没有可偷的 → offer_termination() 请求终止（§4.5）
```

**关键**：GC Root 的标记在 Init Mark Young GC（§3.3）和 scan_root_regions（§3.5 ②）中已经完成。到这一步时，`_next` 位图里已经有最初一批被标的对象了。

**为什么并发标记要读 bitmap 而不是直接从 GC Root 往下追？** STW GC 可以这样做——暂停时对象图是静态的，从 Root 出发追踪引用链，遇到一个标一个。但并发标记不能——应用线程同时在跑，对象图在变。G1 的策略是：把"发现对象"和"扫描对象"分离。Init Mark 阶段在 `_next` bitmap 里标上第一批对象，然后 CM Task 通过 **bitmap 迭代**找到这些已标对象，扫描它们的引用字段，把新发现的对象也标到 `_next` 里。下一轮 bitmap 迭代又会发现这些新标的对象……直到没有任何新 bit 被置 1——引用图闭合。

**`_next` 位图就是 CM Task 的"待处理对象目录"**——有点像一个巨大的 to-do list：某 bit=1 表示"Heap 上对应位置的 64 字节里有一个已知存活但还没扫描引用字段的对象"，CM Task 的工作就是逐一处理这些 bit。`do_marking_step()` 做的是持续追踪——根据 bitmap 找到已标对象 → 扫描引用 → 标新对象 → 再根据新的 bitmap 继续追踪——直到整个引用图闭合。

### 4.3 本地队列——每个 worker 的"待办清单"

并发标记用的是**三色标记算法**：白色=未访问，灰色=已发现但未扫完引用，黑色=全部扫完。

**本地队列就是灰色对象的"待办清单"。** 标记过程中：遇到一个新对象 → 标到 `_next` 位图（白→灰）→ push 到本地队列 → 排队处理完后 pop 出来扫其引用字段 → 扫完变黑。如果扫描时发现新的引用对象，继续 push。

```
Bitmap:   □ □ □ □ □ ■ □ ■ ...    ← 白色=未标, 黑色=已标
本地队列: [obj5, obj8, obj3, ...]  ← 灰色="知道是活的但还没扫完"
Worker:   pop obj5 → 扫引用 → 发现 obj9 → push obj9 → pop obj8 → ...
```

#### 队列归谁——CMTask 的属性

构造函数（`g1ConcurrentMark.cpp:483-491`）中创建，同时绑两份引用：

```
for (i = 0; i < ParallelGCThreads; i++) {
    G1CMTaskQueue* queue = new G1CMTaskQueue();      // ① new 出来
    _task_queues->register_queue(i, queue);           // ② 挂到全局集里
    _tasks[i] = new G1CMTask(i, this, queue, ...);    // ③ CMTask 存为 _task_queue 字段
}
// → 同一份队列，CMTask._task_queue 和 _task_queues.queues[i] 都指过去
```

队列属于 **CMTask**，不属线程。GangWorker 通过 `worker_id` $\to$ `_tasks[id]` $\to$ `_task_queue` 操作。队列生命周期和 CMTask 一致，标记周期之间只 `reset()` 清空，不重建。

#### 队列类型——GenericTaskQueue

> **阅读提示**：下面涉及无锁队列的 Age/CAS/push_slow 实现细节，属于并发数据结构范畴。首次阅读可跳过，不影响后续理解——只需知道"队列是固定容量的环形数组，owner 从底部操作，偷活者从顶部操作，满了会卸载到 §5 的全局 Mark Stack"。后续有空再回头细看。

```cpp
typedef GenericTaskQueue<G1TaskQueueEntry, mtGC> G1CMTaskQueue;
// template <class E, MEMFLAGS F, unsigned int N = TASKQUEUE_SIZE>
// N 默认为 TASKQUEUE_SIZE（HotSpot 内部常量）
```

底层是**固定容量 N 的环形数组双端队列**。`max_elems() = N - 2`（`taskqueue.hpp:214`），即可用容量为 N-2——留两个槽位用于 push 的满/空判断。内部三个字段：

```
           _age (volatile Age)    _bottom (volatile uint)
         ┌──────────────────┐     ┌──┐
         │ _top (uint)      │     │  │ ← 本地端，owner push/pop_local
         │ _tag (uint,版本号)│     └──┘
         └──────────────────┘        ↗ push: if dirty<max_elems → _elems[bot]=t, _bottom++
  _elems [0][1][2]...[N-1]          ↙  pop_local: _bottom--, 读 _elems[bottom]
         ↑
    pop_global: CAS _age, top++, 读 _elems[old_top]
    （全局端，偷活的人用）
```

`push()`（`taskqueue.inline.hpp:79`）的满/空判断：

```
dirty = (bottom - top) % N

if dirty < N-2  → 队列有空位，直接写 _elems[bottom]，然后 bottom++
if dirty == N-2 → 队列满，调 push_slow
   push_slow: dirty == N-1？ → 并发导致脏数据，实际为空 → 推入成功
              dirty == N-2？ → 真正满 → 返回 false（push 失败！）
```

**push 失败会发生什么？** `do_marking_step()` 中 push 失败时，不是丢弃灰色对象——调 `move_entries_to_global_stack()` 把一批对象卸载到全局 Mark Stack（§5），腾出本地队列空间再继续。这是 worker 之间的负载均衡机制。**

`_age` 结构体（`taskqueue.hpp:120-147`）把 `_top` 和 `_tag`（版本号）打包在一个 `size_t` 里：

`_age` 把 `_top`（uint）和 `_tag`（版本号）打包在一个 `size_t` 里（`taskqueue.hpp:130-147`）：

```cpp
struct Age {
    union {
        struct { idx_t _top; idx_t _tag; } _fields;
        size_t _data;
    };
};
Age newAge((idx_t)localBot, oldAge.tag() + 1); // 打包 bottom 位置 + 版本号+1
_age.cmpxchg(newAge, oldAge);  // 一次 CAS 同时更新 top 和 tag
```

**为什么打包**：`pop_local()` 和 `pop_global()` 并发时，各自操作不同端（一个动 `_bottom`，一个动 `_top`），正常情况下不冲突。唯一冲突是当队列只剩一个元素时——两边可能同时抢。`_tag` 充当版本号：`pop_local()` 用 CAS 把 `{bottom, tag+1}` 原子写入 `_age`，如果旧值不匹配说明 `pop_global()` 已抢先，`pop_local()` 让给它。

#### 队列存什么——G1TaskQueueEntry

```cpp
class G1TaskQueueEntry {
    void* _holder;
    static const uintptr_t ArraySliceBit = 1;

    static G1TaskQueueEntry from_oop(oop obj);       // _holder = obj（低位 0）
    static G1TaskQueueEntry from_slice(HeapWord* addr); // _holder = addr | 1
    bool is_array_slice() const { return ((uintptr_t)_holder & ArraySliceBit) != 0; }
    oop obj() const { return (oop)((uintptr_t)_holder & ~ArraySliceBit); }
};
```

两种元素：
- **低位 0 → 普通 oop**："这个对象还没扫它的引用字段"
- **低位 1 → 数组分片地址**："这个大数组还没扫完，从这里继续"

**为什么数组要分片**：Java 数组可以很大（几万个元素）。如果把整个数组 push，一个 worker 扫完全部元素会阻塞很久。分片方案：只扫一段（比如前 128 个元素），剩余部分包装成 `from_slice(续扫地址)` push 回队列——其他 worker 偷走也能继续扫，负载自然分散。

#### 为什么每个 worker 一个队列——LIFO vs FIFO

Owner（拥有该队列的 CMTask）用 `pop_local()` 从底部取——**LIFO**，刚 push 的最先处理。这对 cache 友好：刚扫描 push 的对象往往还在 CPU cache 里。

Stealer（偷活者）用 `pop_global()` 从顶部取——**FIFO**，偷的是最早入队的。两个方向相反，正常情况下互不碰头。只有在只剩一个元素时才需要 Age CAS 裁定归属。

### 4.4 工作窃取——谁干完了就帮谁

标记过程中，worker A 可能早早干完了本地队列和全局栈——但 worker B 的队列里还堆着一堆灰色对象。A 不想闲着等 B，于是去**偷 B 的队列**：

```
Worker A (空闲)                          Worker B (忙碌)
  本地队列: [空]                          本地队列: [obj1, obj2, obj3, obj4, ...]
  全局栈取不到  ───────────────────────────→
              → steal_best_of_2()          pop_global() → 从 B 的队列顶部偷一个
              ← 偷到 obj1 ←
              标记 obj1 → 发现新引用 → push 到自己的队列 → 继续干活
```

具体算法（`taskqueue.inline.hpp`）：用 `hash_seed` 随机挑两个非己队列，**从更满的那个偷**。偷的时候用 `pop_global()`（顶部），本地 worker 自己用的是 `pop_local()`（底部）——一个 FIFO、一个 LIFO，方向相反，不冲突。

### 4.5 终止协议——怎么知道"全干完了"

所有 worker 都会走到同一个问题："我没事可做了"。但"我没事"不等于"全没事"——可能别的 worker 还被一个刚被偷走的新对象引出了更多工作。

所以需要一个协调机制：`ParallelTaskTerminator`。每个 worker 在确认自己"彻底没事"（本地队列空、全局栈空、偷也偷不到）后，调 `offer_termination()`：

```
worker 说"我没事了" → 原子递增 _offered_termination

→ 所有人都说了？→ 检查全部队列确实空 → 返回 true，全部结束
→ 还没齐？→ 等着，期间 peek 队列：
    → 发现谁队列非空 → 减计数器，"我没说过了"，继续干活
    → 等太久 → should_exit_termination() 返回 true（超时或 SATB 有新数据）
```

在 G1ConcurrentMark 构造时创建：

```cpp
_terminator = ParallelTaskTerminator((int) _max_num_tasks, _task_queues);
```

`_n_threads` 在每次 `set_concurrency()` 时重建——不同标记周期活跃 worker 数可能不同。

### 4.6 双哨同步——overflow 后的重组

> **阅读提示**：首次阅读可先跳过，简单理解为"集合→重置→再集合→继续"，具体在 §5 展开。后续有空再回来细看。

构造函数还创建了两个 `WorkGangBarrierSync`（`_first_overflow_barrier_sync` 和 `_second_overflow_barrier_sync`）。标记栈溢出时（§5），需要重启所有 worker：

```
第一道 barrier:  所有 worker 集合 → 确认全部停止操作全局数据
                 → 各自重置本地数据结构、全局栈 expand 扩容
第二道 barrier:  所有 worker 再次集合 → 确认全部重置完毕
                 → 放开，重新开始标记
```

**为什么两道？** 如果只有一道，某个 worker 刚重置完就开始干活了，另一个 worker 还没重置完——新干活的人可能读到半残的全局数据。第一道保证"所有人停了"，第二道保证"所有人都准备好了"。

## 5. 全局 Mark Stack——溢出卸载

### 5.1 为什么需要全局栈——本地队列不够用

每个 CMTask 有自己的本地队列（`G1CMTaskQueue`），但它是**固定容量**的（环形数组）。并发标记期间，某些 Region 的引用可能非常多——本地队列满了怎么办？

**不能丢掉**——灰色对象还没扫描完，丢掉会漏标。

**解法**——本地队列满了，就把一批条目**卸载到全局共享的 Mark Stack**（`_global_mark_stack`）。空闲的 worker 可以从全局栈**领取**条目到本地队列。全局栈是所有 worker 之间的**负载均衡器**。

```
worker 本地队列满了 → push chunk 到全局栈
worker 本地队列空了 → pop chunk 从全局栈
```

### 5.2 类结构——chunk 链表

```cpp
class G1CMMarkStack {
    size_t _max_chunk_capacity;    // chunk 数量的硬上限
    TaskQueueEntryChunk* _base;     // 底层内存（mmap 预留）

    size_t _chunk_capacity;        // 当前可用 chunk 数量
    TaskQueueEntryChunk* volatile _free_list;    // 空闲 chunk 链表
    TaskQueueEntryChunk* volatile _chunk_list;   // 含数据的 chunk 链表
    volatile size_t _chunks_in_chunk_list;       // chunk_list 中的 chunk 数
    volatile size_t _hwm;          // high water mark——从 _base 分配新 chunk 的指针
};
```

**核心数据结构**——`TaskQueueEntryChunk` 是一个单链表节点，每个 chunk 存 **1023 个 `G1TaskQueueEntry`**：

```
TaskQueueEntryChunk[0]     TaskQueueEntryChunk[1]
┌─────────────────┐     ┌─────────────────┐
│ data[0]          │     │ data[0]          │
│ data[1]          │     │ data[1]          │
│ ...              │     │ ...              │
│ data[1022]       │     │ data[1022]       │
│ next → chunk[1]  │     │ next → chunk[2]  │
└─────────────────┘     └─────────────────┘
```

两个链表：
- `_free_list`：空闲 chunk——pop 时归还的 chunk 挂在这里，下次 push 时复用
- `_chunk_list`：含数据的 chunk——push 时把 chunk 挂在这里，pop 时从这里取

**push/pop 操作的都是"一整个 chunk（1023 个 entry）"**——不是单个 oop。这和本地队列的 push/pop 单个 entry 完全不同。原因：批量传输减少全局栈的 CAS 竞争次数。

### 5.3 push/pop 流程

**`par_push_chunk(arr)`**（从数组 `arr` 推入 1023 个 entry）：

```
1. 从 _free_list 取一个空闲 chunk
   ├── 有 → 直接拿来用
   └── 无 → allocate_new_chunk() 从 _base 内存按 _hwm 分配新 chunk
         └── 仍分配不到 → 返回 false（触发 overflow）

2. Copy::conjoint_memory_atomic → 把 arr 的 1023 个 entry 拷贝到 chunk

3. add_chunk_to_chunk_list(chunk) → 把 chunk 挂到 _chunk_list 头部
```

**`par_pop_chunk(arr)`**（弹出 1023 个 entry 到数组 `arr`）：

```
1. 从 _chunk_list 移除头部 chunk
   ├── 有 → 取出数据
   └── 无 → 返回 false

2. Copy::conjoint_memory_atomic → 把 chunk 的 1023 个 entry 拷贝到 arr

3. 把空 chunk 归还到 _free_list 头部
```

**`Copy::conjoint_memory_atomic`** 保证拷贝期间 chunk 不会处于"半满"状态——并发 push/pop 看到的一直是完整副本。

### 5.4 Overflow 处理——栈满了怎么办

**触发**：`mark_stack_push()` 中 `par_push_chunk` 返回 false（后备内存用尽）：

```cpp
bool G1ConcurrentMark::mark_stack_push(G1TaskQueueEntry* arr) {
    if (!_global_mark_stack.par_push_chunk(arr)) {
        set_has_overflown();  // 置 _has_overflown = true
        return false;
    }
    return true;
}
```

**overflow 后的连锁反应**：

```
某 worker 的 mark_stack_push 失败
  → set_has_overflown()
    ↓

其他 worker 在 regular_clock_call() 检测到 has_overflown()
  → set_has_aborted() → 退出 marking
    ↓

所有 worker 通过 _first_overflow_barrier_sync 同步
  → 确保没有人还在操作全局数据结构
    ↓

reset_marking_for_restart()
  → _global_mark_stack.expand() 翻倍容量
  → clear_has_overflown()
    ↓

所有 worker 通过 _second_overflow_barrier_sync 同步
  → 确保重置完成，无人提前开始工作
    ↓

重新开始标记（回到 do_marking_step）
```

**双哨同步（`_first_overflow_barrier_sync` / `_second_overflow_barrier_sync`）**就是为了这个流程。源码注释写得很清楚：

```cpp
// Two sync barriers that are used to synchronize tasks when an
// overflow occurs. The algorithm is the following. All tasks enter
// the first one to ensure that they have all stopped manipulating
// the global data structures. After they exit it, they re-initialize
// their data structures and task 0 re-initializes the global data
// structures. Then, they enter the second sync barrier. This
// ensure, that no task starts doing work before all data
// structures (local and global) have been re-initialized.
```

两个 barrier 确保：
1. **第一道**——所有 worker 都停了，没人再碰全局数据
2. **第二道**——所有 worker 的本地数据和全局数据都重置完了，可以重新开始

### 5.5 构造时的初始化

```cpp
// MarkStackSize 计算
if (FLAG_IS_DEFAULT(MarkStackSize)) {
    size_t mark_stack_size =
        MIN2(MarkStackSizeMax,
            MAX2(MarkStackSize, (size_t)(_max_concurrent_workers * TASKQUEUE_SIZE)));
    FLAG_SET_ERGO(size_t, MarkStackSize, mark_stack_size);
}

// 初始化全局栈
if (!_global_mark_stack.initialize(MarkStackSize, MarkStackSizeMax)) {
    vm_exit_during_initialization("Failed to allocate initial concurrent mark overflow mark stack.");
}
```

**MarkStackSize 自动调优**——默认值基于 `ConcGCThreads * TASKQUEUE_SIZE`（每个并发 worker 的本地队列容量总和），下限是 `MarkStackSize`，上限是 `MarkStackSizeMax`。这保证全局栈至少能容纳所有 worker 本地队列的全部内容——理论上如果所有 worker 同时满了，全局栈能接住。

**`_global_mark_stack.initialize()`** 通过 `mmap` 预留一段虚拟内存作为 chunk 的后备池（`_base`），初始 `_chunk_capacity` 用来限制可用 chunk 数量。`expand()` 时增加 `_chunk_capacity`，允许从 `_base` 分配更多 chunk。

---

## 6. G1CMRootRegions——根 Region 追踪器

> **阅读提示**：构造时只初始化了空壳，运行时逻辑（扫描 survivor、claim_next 等）首次阅读可快速浏览。具体在 GC 流程章节会详细展开。

构造时 `_root_regions` 只是初始化了一个**空壳**——存了 survivor Region 集合的指针和 CM 的指针，没有 survivor 数据。此时 JVM 还在初始化，任何 GC 都还没发生过。

```cpp
// G1ConcurrentMark 构造函数（:414）
_root_regions.init(_g1h->survivor(), this);
//                 ↑ 指针，初始化时为空集  ↑
```

`init()` 只做两件事（`g1ConcurrentMark.hpp:264-267`）：

```cpp
void G1CMRootRegions::init(const G1SurvivorRegions* survivors, G1ConcurrentMark* cm) {
    _survivors = survivors;  // 存指针，不是复制数据
    _cm = cm;
}
```

真正的数据要等到**运行时**——第一次 Init-Mark Young GC 暂停中，young Region 的存活对象被搬迁到 survivor Region，暂停结束时 `post_initial_mark()` 调 `_root_regions.prepare_for_scan()` 标记"可以扫了"。然后 CMThread 的 step ② 中 `scan_root_regions()` 启动并发 worker 去扫。

`scan_root_regions()`（`g1ConcurrentMark.cpp:924`）创建 `G1CMRootRegionScanTask`，worker 数取 `min(活跃并发 worker 数, survivor Region 数)`，并发扫描：

```cpp
_num_concurrent_workers = MIN2(calc_active_marking_workers(), root_regions()->num_root_regions());
G1CMRootRegionScanTask task(this);
_concurrent_workers->run_task(&task, _num_concurrent_workers);
```

每个 worker 通过 `claim_next()` 原子认领下一个 survivor（`g1CMRootRegions.cpp:286`）：

```cpp
HeapRegion* claim_next() {
    int claimed = Atomic::add(1, &_claimed_survivor_index);
    if (claimed < num_root_regions()) {
        return _survivors->regions()->at(claimed);
    }
    return NULL;
}
```

认领后扫描 Region 内所有对象，对每个对象调 `G1RootRegionScanClosure`——就是普通标记操作（`mark_in_next_bitmap(obj)` + push 到本地队列继续追踪）。扫完后 `scan_finished()` 通知标记完成。

根 Region 扫描是**并发标记的第一个阶段**——在 initial-mark 暂停完成后立即启动。扫描完成后才进入 `mark_from_roots()` 主循环。

---

## 7. 其余基础设施

### 7.1 _worker_id_offset——CM worker 的全局唯一编号

```cpp
_worker_id_offset = DirtyCardQueueSet::num_par_ids() + G1ConcRefinementThreads;
_max_num_tasks = ParallelGCThreads;
```

`_worker_id_offset` 是 CM worker 编号的**起始偏移量**。为什么需要偏移？因为 G1 中有多种线程类型都会调用 `add_reference()`——而 `add_reference()` 内部查 `G1FromCardCache`（ch11/06, `_cache[region_idx][worker_id]`），不同线程如果使用相同编号会互相覆盖缓存条目：

```
线程编号分配:
  [0, num_par_ids)                            ← Mutator 背压或 GC Worker 处理 DCQ
  [num_par_ids, num_par_ids + G1ConcRefinementThreads)  ← Concurrent Refinement 线程
  [_worker_id_offset, _worker_id_offset + ParallelGCThreads)  ← CM worker（本节）

_worker_id_offset = num_par_ids + G1ConcRefinementThreads
                  ≈ ParallelGCThreads + G1ConcRefinementThreads
```

CM 代码中用到偏移的地方（`g1RemSet.cpp:989`）：
```cpp
// RSet 重建时，CM worker 调用 add_reference:
cl(g1h, _cm, _worker_id_offset + worker_id)  // worker_id 0..N-1 → 实际编号加上偏移
```

这样 CM worker #0 实际使用 G1FromCardCache 的槽位 `_cache[reg][_worker_id_offset + 0]`，不会和 ConcurrentRefine 线程的槽位冲突。三类线程的编号分配详情见 [ch11/06 §3.3.4](06-remset-bot.md)。

**ConcGCThreads 计算**：

```cpp
if (FLAG_IS_DEFAULT(ConcGCThreads) || ConcGCThreads == 0) {
    uint marking_thread_num = scale_concurrent_worker_threads(ParallelGCThreads);
    FLAG_SET_ERGO(uint, ConcGCThreads, marking_thread_num);
}
```

`scale_concurrent_worker_threads()` 根据 `ParallelGCThreads` 计算——通常是 `max(1, ParallelGCThreads * 0.5 ~ 0.625)`，不超过 `ParallelGCThreads`。**并发标记用的线程数通常小于 STW GC 的线程数**——因为并发标记和 mutator 同时跑，不能占满所有 CPU。

**WorkGang 创建**——线程池管理器（`workgroup.hpp:225`）：

```cpp
_concurrent_workers = new WorkGang(
    "G1 Conc",                    // 名称（日志用）
    _max_concurrent_workers,      // GangWorker 线程数 = ConcGCThreads
    false,                        // are_GC_task_threads = false（不是 STW 任务线程）
    true                          // are_ConcurrentGC_threads = true（是并发线程）
);
_concurrent_workers->initialize_workers();  // 创建 OS 线程
```

`WorkGang` 继承 `AbstractWorkGang`（`workgroup.hpp:109`），内部结构：

```
WorkGang
├── _dispatcher: GangTaskDispatcher       ← 协调者：发/收信号
│     ├── _start_semaphore (Semaphore)    ← worker 等在这里
│     ├── _end_semaphore   (Semaphore)    ← 协调者等在这里（阻塞到全完成）
│     └── _task, _not_finished, _started  ← 共享状态
│
└── _workers[]: GangWorker[_total_workers]   ← 线程数组（继承自 AbstractWorkGang）
      └── 每个 GangWorker 执行 loop():
            while (true) {
                wait_for_task()           ← block on _start_semaphore
                task->work(worker_id)     ← 执行实际任务
                signal_task_done()        ← --_not_finished, last one → signal _end_semaphore
            }
```

**`run_task()` 调用时**（`workgroup.cpp:150-168`）：

```
1. 协调者设 _task = &task, _not_finished = N
2. _start_semaphore->signal(N)              → 批量唤醒 N 个 worker
3. _end_semaphore->wait()                   → 协调者阻塞

   worker: _start_semaphore->wait()         → 唤醒, Atomic 拿 worker_id
           task->work(worker_id)            → 干活的代码在这里
           Atomic::sub(&_not_finished)      → 最后一个减到 0 → signal _end_semaphore

4. 协调者收到 _end_semaphore → 返回        ← 全部完成
```

默认用 `SemaphoreGangTaskDispatcher`（POSIX 信号量），备选 `MutexGangTaskDispatcher`（Monitor 的 `notify_all()`）。

`initialize_workers()`（`workgroup.cpp:41`）分配数组后调 `add_workers()`：

```cpp
void AbstractWorkGang::initialize_workers() {
    _workers = NEW_C_HEAP_ARRAY(GangWorker*, total_workers());  // ① 分配
    add_workers(true);   // ② true = initializing
}
```

`add_workers()` 判断线程类型，委托给 `WorkerManager`（`workgroup.cpp:62-79`）：

```cpp
void AbstractWorkGang::add_workers(uint active_workers, bool initializing) {
    os::ThreadType worker_type = are_ConcurrentGC_threads()
        ? os::cgc_thread    // ← ConcurrentGCThread
        : os::pgc_thread;   // ← ParallelGCThread
    _created_workers = WorkerManager::add_workers(
        this, active_workers, _total_workers, _created_workers,
        worker_type, initializing);
    _active_workers = MIN2(_created_workers, _active_workers);
}
```

`WorkerManager::add_workers()` 核心是一个 `for` 循环（`workerManager.hpp:52-82`）：

```cpp
for (uint worker_id = 0; worker_id < ConcGCThreads; worker_id++) {
    new_worker = holder->install_worker(worker_id);      // ③ new GangWorker
    os::create_thread(new_worker, worker_type);           // ④ pthread_create
    os::start_thread(new_worker);                         // ⑤ 启动 → run() → loop()
}
// 创建失败: initializing=true → vm_exit_out_of_memory（死路）; false → 打日志继续
```

**③ `install_worker()` → `allocate_worker()`**（`workgroup.cpp:52-55, :284`）：

```cpp
AbstractGangWorker* install_worker(uint id) {
    AbstractGangWorker* w = allocate_worker(id); // WorkGang 重写: return new GangWorker(this, id);
    set_thread(id, w);                           // 存入 _workers[id]
    return w;
}
```

**④ `os::create_thread(new_worker, cgc_thread)`**：底层 POSIX `pthread_create`。`cgc_thread` 和 `pgc_thread` 的区别只在于栈大小（`os_posix.cpp:1587`）和 JVM 监控分类。STS 的注册不在线程层面——每个任务在 `work()` 中显式 `SuspendibleThreadSetJoiner` 加入（§3.5 ⑦）。

**⑤ `os::start_thread(new_worker)`**——启动线程 → `run()` → `initialize()` → `loop()`：`while(true) { wait_for_task(); run_task(data); signal_task_done(); }`

`initializing = true` 时，创建失败直接 `vm_exit_out_of_memory`（死路一条）。运行时 `run_task()` 需要更多 worker 时传 `false`，创建失败只打日志。

**⑤ `os::create_thread(new_worker, cgc_thread)`**——创建底层 OS 线程（POSIX 下是 `pthread_create`）。`cgc_thread` 控制的是栈大小（`:1587-1597`）和 JVM 监控分类，不影响 STS——STS 注册由各任务在 `work()` 中显式加入（§3.5 ⑦）。

**⑥ `os::start_thread(new_worker)`**——启动线程 → GangWorker 的 `run()`（`:309`）→ `initialize()` → `loop()`：`while(true) { wait_for_task(); run_task(data); signal_task_done(); }`

**`initializing` 参数**：构造时传 `true`，创建失败 → `vm_exit_out_of_memory`——死路一条。运行时 `run_task()` 需要更多 worker 时传 `false`，创建失败只 `break` 循环、打日志，不崩溃。

G1ConcurrentMark 中三次调用 `_concurrent_workers->run_task(&task)`：
- ③ mark_from_roots：`G1CMConcurrentMarkingTask`（并发标记）
- ④ rebuild_rem_sets：`G1RebuildRemSetTask`（重建 RSet）
- ⑦ cleanup_for_next_mark：`G1ClearBitMapTask`（清位图）

### 7.2 SATB Buffer Size

```cpp
SATBMarkQueueSet& satb_qs = G1BarrierSet::satb_mark_queue_set();
satb_qs.set_buffer_size(G1SATBBufferSize);
```

`G1SATBBufferSize`（`g1_globals.hpp:91`）是 JVM product flag，默认值 **1KB**。`set_buffer_size()` 告诉 SATB 全局队列系统：每个线程的本地 SATB buffer 多大。

**SATB 本地 buffer 的用途**：§3.7 讲过，mutator 线程覆盖引用字段时，SATB 写屏障把旧值记入线程本地的 SATB buffer。buffer 写满后刷到全局 `SATBMarkQueueSet` 的 completed list。Remark 暂停时排空 completed list，把里面的旧引用追踪并标记到 `_next` 位图。

buffer 越小 $\to$ 越频繁刷到全局 $\to$ Remark 时 completed list 越长 $\to$ Remark 耗时越长。buffer 越大 $\to$ 每个线程占用更多内存（线程数 $\times$ buffer_size）。1KB 是在"频繁刷新"和"内存占用"之间的折中。

### 7.3 统计数组——per-Region 存活数据

```cpp
_region_mark_stats = NEW_C_HEAP_ARRAY(G1RegionMarkStats, _g1h->max_regions(), mtGC);
_top_at_rebuild_starts = NEW_C_HEAP_ARRAY(HeapWord*, _g1h->max_regions(), mtGC);
```

两个 per-Region 数组，大小 = `max_regions()`（默认 2048）：

**`_region_mark_stats[i]`**（`g1RegionMarkStatsCache.hpp:39`）——每个 Region 的存活字节统计：

```cpp
struct G1RegionMarkStats {
    size_t _live_words;   // 这个 Region 里标记确认存活的 HeapWord 数
};
```

CMTask 在标记过程中每标一个对象，就用 `add_to_liveness()`（`g1ConcurrentMark.cpp:2176`）把对象的 `size()` 加到对应 Region 的 `_live_words` 上。标记完成后，G1 用它判断"这个 Region 存活数据多不多，值不值得回收"——`_live_words` 越高 -> 回收收益越低 -> 不列入 mixed GC 候选。

**`_top_at_rebuild_starts[i]`**——RSet 重建时 Region i 的 `top()` 快照。并发标记结束后的 RSet rebuild 阶段（§3.5 ④）需要重新扫描选中的 old Region，但只需扫到标记完成时的堆水位线——`top()` 以上的对象是后来新分配的，天然存活，不需要重建 RSet。`_top_at_rebuild_starts[i]` 就是在 rebuild 开始前拍的快照。

### 7.4 统计计时字段

初始化列表中全部置零，类型为 `NumberSeq`（滑动窗口统计器，记录最近 N 次的数据）和 `double`：

```
_init_times          // NumberSeq——initial-mark 暂停耗时
_remark_times        // NumberSeq——remark 暂停总耗时
_remark_mark_times   // NumberSeq——remark 中纯粹的标记耗时
_remark_weak_ref_times // NumberSeq——remark 中弱引用处理耗时
_cleanup_times       // NumberSeq——cleanup 暂停耗时
_total_cleanup_time  // double——cleanup 累计总耗时

_accum_task_vtime[]  // double[N]——每 CMTask 累积的虚拟时间
```

**谁在什么时候填**：每次标记周期结束时，CMThread 的 `run_service()` 中把本轮各阶段的耗时追加到对应的 `NumberSeq` 里（`add()` 方法）。`NumberSeq` 只保留最近几次数据（默认 3 次），旧数据自动丢弃。

**谁在什么时候读**：G1Policy 用这些历史数据**预测下一次标记周期的耗时**，从而决定何时启动标记（IHOP 计算依赖这些预测值）。`_accum_task_vtime[i]` 用于 JMX 监控，不参与 GC 决策。

> **阅读提示**：这些只是统计容器，填数据的具体逻辑在 CMThread 的 `run_service()` 中。本节只需知道构造函数分配了它们，详细用法留到后续章节。

### 7.5 reset_at_marking_complete()

构造函数**最后一步**：

```cpp
reset_at_marking_complete();       // :604-609
_completed_initialization = true;  // 标记初始化完成
```

`reset_at_marking_complete()` 调 `reset_marking_for_restart()`（`:557-577`）：

```cpp
void G1ConcurrentMark::reset_marking_for_restart() {
    _global_mark_stack.set_empty();            // 清空全局栈
    if (has_overflown()) {                     // 溢出过？expand + 清统计
        _global_mark_stack.expand();
        for (uint i = 0; i < max_regions; i++)
            _region_mark_stats[i].clear_during_overflow();
    }
    clear_has_overflown();                     // → _has_overflown = false
    _finger = _heap.start();                   // 初始指向堆起始
    for (uint i = 0; i < _max_num_tasks; ++i)  // 清空所有 CMTask 队列
        _task_queues->queue(i)->set_empty();
}

void G1ConcurrentMark::reset_at_marking_complete() {
    reset_marking_for_restart();
    _num_active_tasks = 0;                     // 额外：关闭所有 task
}
```

构造函数中初始化列表已预先设置的状态（不在此方法中）：
- `_has_aborted = false`（初始化列表 `:377`）
- `_concurrent = false`（初始化列表 `:376`）

结果是一个"安全初始态"——栈空、队列空、无活跃 task、无溢出标志。任何标记周期开始时的 `reset()` 会覆盖这些值，构造函数只需保证不是未定义。

---

## 8. 概念链——构造函数创建的全部属性

G1ConcurrentMark 构造函数共创建以下字段（按初始化列表 + 构造函数体顺序）：

| 字段 | 类型 | 数量/大小 | 作用 | 详见 |
|------|------|----------|------|------|
| `_cm_thread` | `G1ConcurrentMarkThread*` | 1 | CMThread 驱动线程，睡着等唤醒 | §3 |
| `_mark_bitmap_1` | `G1CMBitMap` | 1 | 物理位图 A（值成员） | §2.2 |
| `_mark_bitmap_2` | `G1CMBitMap` | 1 | 物理位图 B（值成员） | §2.2 |
| `_prev_mark_bitmap` | `G1CMBitMap*` | 1 | 角色指针——"上一轮完整标记"，供 GC 读 | §2.1 |
| `_next_mark_bitmap` | `G1CMBitMap*` | 1 | 角色指针——"本轮构建中的标记"，标记线程写 | §2.1 |
| `_heap` | `MemRegion` | 1 | 堆范围 | — |
| `_root_regions` | `G1CMRootRegions` | 1 | survivor Region 追踪器（初值为空） | §6 |
| `_global_mark_stack` | `G1CMMarkStack` | 1 | 全局 Mark Stack（chunk 链表，mmap 预留） | §5 |
| `_tasks` | `G1CMTask**` | `ParallelGCThreads` 个 | per-worker 标记任务数组 | §4.1 |
| `_task_queues` | `G1CMTaskQueueSet*` | `ParallelGCThreads` 个队列 | 本地队列集，每个 CMTask 一个 | §4.3 |
| `_terminator` | `ParallelTaskTerminator` | 1 | 全部 worker 完成的判定协议 | §4.5 |
| `_concurrent_workers` | `WorkGang*` | `ConcGCThreads` 个 GangWorker | 并发 worker 线程池 | §7.1 |
| `_region_mark_stats` | `G1RegionMarkStats*` | `max_regions` 个 | per-Region 存活字节统计 | §7.3 |
| `_top_at_rebuild_starts` | `HeapWord**` | `max_regions` 个 | RSet rebuild 时的 top 快照 | §7.3 |
| `_accum_task_vtime` | `double*` | `ParallelGCThreads` 个 | 每 CMTask 累积虚拟时间 | §7.4 |
| `_first_overflow_barrier_sync` | `WorkGangBarrierSync` | 1 | overflow 第一道同步 | §4.6 |
| `_second_overflow_barrier_sync` | `WorkGangBarrierSync` | 1 | overflow 第二道同步 | §4.6 |

**关键尺寸**（典型的 8GB 堆）：
- `max_regions = 2048`，`ParallelGCThreads = 8`，`ConcGCThreads = 4`
- 位图：每张 16MB × 2 = 32MB
- `_tasks` 数组：8 个 `G1CMTask*`（64 字节指针）
- `_task_queues`：8 个队列，每队列大小 TASKQUEUE_SIZE（128）× `sizeof(G1TaskQueueEntry)`（8 字节）= 1KB
- `_region_mark_stats`：2048 × `sizeof(G1RegionMarkStats)`（8 字节）= 16KB
- `_top_at_rebuild_starts`：2048 × 8 字节 = 16KB

---

## 9. 程序员影响

- **`-XX:ConcGCThreads`**——并发标记线程数（默认按 `ParallelGCThreads` 的 50%~62.5% 缩放）。增加可提升并发标记速度，但会抢占 mutator CPU
- **`-XX:MarkStackSize`**——全局标记栈的 chunk 数量（默认自动调优，基于 `ConcGCThreads * TASKQUEUE_SIZE`）。如果频繁 overflow（日志中见 `restart for overflow`），可以调大
- **`-XX:MarkStackSizeMax`**——MarkStackSize 的硬上限（默认 128MB）。全局栈通过 mmap 预留；expand 只是增加可用 chunk 数，不重新分配
- **`-XX:G1SATBBufferSize`**——每个线程的 SATB 本地 buffer 大小（默认 1KB）。太小会导致频繁 flush 到全局队列，太大增加内存占用
- **位图内存开销**——两张位图各占堆的 1/512（8GB 堆 ≈ 16MB 每张），两张约 32MB。这是固定开销，不受其他参数影响
