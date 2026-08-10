# PROMPT: 请撰写 09-G1-Concurrent-Marking-Infra.md

## ⚠️ 关键：本 prompt 是导航地图，不是预制答案。你必须亲自读源码。

- 本 prompt 的 §四 答案方向是"指引"——告诉你去源码里找什么、从哪个角度分析。不能把"答案方向"直接抄到文档里。
- **你必须用 codegraph_explore 或 Read 工具逐个读取 §三 列出的每一个源文件**（至少读核心段落），基于自己的源码理解来写文档。
- 源码是证据（20%），你基于源码的分析洞察是正文（80%）。prompt 告诉你去找什么，不替你写答案。

## §〇 Production Scenario

```
$ java -Xms8g -Xmx8g -XX:+UseG1GC \
    -XX:ParallelGCThreads=13 \
    -XX:ConcGCThreads=3 \
    -XX:ConcGCThreads=3 \
    -XX:InitiatingHeapOccupancyPercent=45 \
    -XX:+UseStringDeduplication \
    MyApp
```

GC 日志中出现 `[GC concurrent-root-region-scan-start]` → `[GC concurrent-mark-start]` → `[GC concurrent-mark-end, 1.2345678 secs]`。1.2 秒的并发标记是如何执行的？13 个 `G1CMTask` 如何通过工作窃取并行标记整个堆？全局 `G1CMMarkStack`（32MB chunk 链表）如何在任务队列溢出时接管灰色对象？`G1ConcurrentRefine` 的三色区域（green=13/yellow=39/red=65）如何动态调整精炼线程数？

这些问题的答案在 `G1ConcurrentMark` 构造函数（`g1ConcurrentMark.cpp:371-613`，~240 行）创建的完整并发标记基础设施中。

**三步诊断**：

```bash
# 1. 查看并发标记线程
jstack <pid> | grep -A2 "G1 Main Concurrent Mark"
# 期望: "G1 Main Concurrent Mark GC Thread" os_prio=0 tid=... runnable

# 2. 查看并发精炼线程
jstack <pid> | grep "G1 Refine"
# 期望: "G1 Refine Thread#0" (primary), "G1 Refine Thread#1" (secondary)...

# 3. 查看字符串去重线程
jstack <pid> | grep "StringDedup"
# 期望: "String Deduplication Thread" (如果 -XX:+UseStringDeduplication)

# 4. GDB 验证标记基础设施
gdb -ex "break G1ConcurrentMark::G1ConcurrentMark" \
    -ex "run" \
    -ex "print _max_num_tasks" \
    -ex "print _task_queues->_n" \
    -ex "print _global_mark_stack.capacity()" \
    -ex "print _cm_thread" \
    --args java -version
# 期望: _max_num_tasks=13, _n=13, capacity()=4096, _cm_thread 非 NULL
```

**反事实**：如果并发标记没有全局溢出栈（`G1CMMarkStack`）→ 当某个 worker 的本地队列满时 → push 灰色对象失败 → 丢失待标记对象 → live object 被错误回收 → JVM crash 或静默数据损坏。`G1CMMarkStack` 用 chunk 链表（每个 chunk 8KB，1023 个 entry）提供无限溢出能力——初始 4096 chunks (32MB)，最大 16384 chunks (128MB)。`_first_overflow_barrier_sync` 和 `_second_overflow_barrier_sync` 双屏障协议确保所有 worker 在溢出后同步重启，不会遗漏任何灰色对象。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

本文深度分析 G1 并发标记基础设施在 JVM 启动时的初始化——`G1ConcurrentMark` 构造函数（~240 行）创建的完整标记子系统，以及 `G1ConcurrentRefine`（并发精炼）、`G1YoungRemSetSamplingThread`（RSet 采样）、`G1StringDedup`（字符串去重）的初始化。

**前置**: [02-G1-Heap-Startup]（堆内存布局 + 6 Mapper + Card Table + SATB 队列）+ [08-G1-Policy-Analytics]（G1Policy 决策引擎）。本文聚焦"如何标记"的执行引擎。

### Narrative

`G1CollectedHeap::initialize()` 的 Step 14（`:2255 new G1ConcurrentMark(this, prev, next)`）触发了 G1 最复杂的构造函数——`G1ConcurrentMark::G1ConcurrentMark()`（`g1ConcurrentMark.cpp:371-613`）在初始化列表中创建双缓冲位图、全局标记栈、任务队列集合、并行终止器、溢出同步屏障、区域统计数组等 20+ 个成员，构造函数体再创建标记线程、工作线程池、13 个 G1CMTaskQueue（各 1MB）、13 个 G1CMTask 对象。

双缓冲位图机制：`_mark_bitmap_1` 和 `_mark_bitmap_2` 是两个 `G1CMBitMap` 对象（各 ~76B），通过 `_prev_mark_bitmap` 和 `_next_mark_bitmap` 指针引用。标记周期完成时交换两个指针（O(1)），不复制 1GB 位图数据。每个 bit 对应 8 字节堆内存（`mark_distance() = 1 << LogMinObjAlignment = 8`），8GB 堆 → 1GB 位图。

`G1CMMarkStack` 用 chunk 链表管理灰色对象。每个 `TaskQueueEntryChunk` 8KB（1 个 next 指针 + 1023 个 `G1TaskQueueEntry`），初始分配 4096 个 chunk（32MB 虚拟内存），最大 16384 个（128MB）。使用 4 个 cache line 分离 `_free_list`（CL1）、`_chunk_list`（CL2）、`_hwm`（CL3）——防止 push/pop 的 false sharing。

13 个 `G1CMTask` 各自持有：`_task_queue`（`G1CMTaskQueue`，1MB `_elems` 环形缓冲区，131072 个 entry）→ `_mark_stats_cache`（`G1RegionMarkStatsCache`，1024 条目缓存，~12KB，减少全局 `_region_mark_stats` 的原子操作竞争）→ `_finger`（本地扫描指针）→ `_objArray_processor`（大对象数组处理）。工作窃取：worker 的本地队列空时 → 随机选另一个 worker → `steal()` 窃取队列底部的 entry。

`G1ConcurrentRefine::create()`（`g1ConcurrentRefine.cpp:283-331`）计算三色区域：green=13, yellow=39, red=65。`[0, green)` 不做任何事（利用 card 缓存效应），`[green, yellow)` 逐步激活精炼线程，`[yellow, red)` 全线程运行，≥red 应用线程也参与处理。primary 线程（worker 0）由 mutator 的写屏障直接通知（通过 `DirtyCardQ_CBL_mon`），非 primary 线程由前一个线程级联激活。

`G1YoungRemSetSamplingThread` 每 300ms 采样年轻代 Region 的 RSet 长度——数据反馈给 G1Policy 动态调整年轻代大小。`G1StringDedup::initialize()` 创建 `StringDedupThread` + `G1StringDedupQueue`（去重候选队列）+ `StringDedupTable`（去重哈希表）。

### Interview Story Format Answer（必须出现在 §一 末尾）

"`G1ConcurrentMark` 构造函数（`g1ConcurrentMark.cpp:371-613`）在初始化列表中创建双缓冲位图（`_mark_bitmap_1/2` 各 ~76B，通过 `_prev/_next_mark_bitmap` 指针引用——标记完成时交换指针 O(1)）→ 全局溢出栈 `G1CMMarkStack`（4 cache-line padded 字段，`TaskQueueEntryChunk` 链表每个 8KB 含 1023 个 8B entry，初始 4096 chunks=32MB，最大 16384=128MB）→ 13 个 `G1CMTaskQueue` 指针数组（104B）→ `ParallelTaskTerminator`（`_n_threads=13, _offered_termination=0`）→ 双溢出屏障 `WorkGangBarrierSync`（`_first/_second_overflow_barrier_sync`，`_n_workers=13`）→ `_region_mark_stats`（2048 个 `G1RegionMarkStats`，每个 8B=16KB）→ `_top_at_rebuild_starts`（2048 个 `HeapWord*`，16KB）。

构造函数体（`:470-613`）中：`_mark_bitmap_1.initialize(heap_region, prev_bitmap_storage)` 将位图关联到 128MB 物理存储 → `new G1ConcurrentMarkThread(this)` 创建标记主控线程（~264B，三态状态机 Idle/Started/InProgress）→ 配置 SATB buffer_size=1024 → `_root_regions.init(survivor_regions, this)` 注册 Survivor 为根 → 计算 `ConcGCThreads = max((ParallelGCThreads+2)/4, 1) = 3` → `new WorkGang("G1 Conc", 3)` 创建 3 个 GangWorker 线程 → `_global_mark_stack.initialize(4096, 16384)` 预分配 32MB chunk 内存 → for i=0..12: `new G1CMTaskQueue()`（1MB `_elems`）→ `new G1CMTask(i, this, queue, region_mark_stats, max_regions)`（~360B + `_mark_stats_cache` 12KB）。

`G1ConcurrentRefine::create()`（`g1ConcurrentRefine.cpp:283-331`）计算 `min_yellow=26, green=13, yellow=39, red=65` → `new G1ConcurrentRefine(green, yellow, red, min_yellow)`（~56B）→ `cr->initialize()` 创建 1 个 primary 精炼线程（`G1ConcurrentRefineThread` ~248B，`_worker_id=0, _monitor=DirtyCardQ_CBL_mon`）→ 若 `UseDynamicNumberOfGCThreads=false` 则创建 max_num_threads() 个线程（primary + N secondary）。

`G1YoungRemSetSamplingThread`（~256B）构造函数内 `set_name("G1 Young RemSet Sampling")` + `create_and_start()` → 每 `G1YoungRemSetSamplingIntervalMillis=300` ms 采样一次。`G1StringDedup::initialize()`（`g1StringDedup.cpp:39-44`）调用 `StringDedup::initialize_impl<G1StringDedupQueue, G1StringDedupStat>()` → 创建去重线程 + 去重表。总内存开销（不含位图物理存储）：~14MB（主要是 13 个 1MB 任务队列 + 32MB 标记栈 chunk），含位图存储 2GB + 14MB（双 1GB 位图）。"

### Beginner Callout Boxes（≥7，全部 inline 在 §一 中）

1. **双缓冲位图 (Double-Buffered Bitmap)**：`_mark_bitmap_1` 和 `_mark_bitmap_2` 是两个独立对象。`_prev_mark_bitmap` 指向已完成标记的位图（Mixed GC 读取），`_next_mark_bitmap` 指向当前标记位图（并发标记线程写入）。标记周期结束时交换两个指针——O(1) 而非 O(1GB)。Source: `g1ConcurrentMark.cpp:371-376, 471-472`。

2. **G1CMMarkStack 的 chunk 链表设计**：不是连续数组——是 `TaskQueueEntryChunk` 链表。每个 chunk 8KB（1 个 8B next 指针 + 1023 个 8B entry）。`_free_list`（CL1）维护空闲 chunk，`_chunk_list`（CL2）维护已使用 chunk。push 时从 `_free_list` 取 chunk → 填充 → 挂到 `_chunk_list`。pop 时从 `_chunk_list` 最后一个 chunk 取。4 个 cache line padding 防止 false sharing。Source: `g1ConcurrentMark.hpp:151-239`。

3. **工作窃取 (Work Stealing)**：13 个 worker 各自有本地 `G1CMTaskQueue`（1MB 环形缓冲区）。worker 的本地队列空时 → 随机选另一个 worker（`_hash_seed` 决定）→ `steal()` 从队列底部窃取。`ParallelTaskTerminator` 用 `_offered_termination` 计数——所有 worker 都 `offer_termination()` 后标记阶段结束。Source: `g1ConcurrentMark.hpp:111-112`，`taskqueue.hpp` GenericTaskQueueSet::steal。

4. **三色区域与精炼线程激活**：`[0, green=13)` 不处理——利用 card 缓存效应，连续写入同一 card 时只标记一次。`[green=13, yellow=39)` 逐步激活——primary 线程处理，若 `_completed_buffers` 继续增长则激活 secondary。`[yellow=39, red=65)` 全线程运行。≥65 应用线程也参与处理（STW assist）。Source: `g1ConcurrentRefine.cpp:283-331`。

5. **G1CMTask 的 _mark_stats_cache**：1024 条目缓存（`G1RegionMarkStatsCache`，每条目 12B = `uint region_idx + size_t live_words`，共 12KB）。标记 worker 频繁更新 Region 的 `_live_words`——如果每次直接写全局 `_region_mark_stats[2048]`，13 个 worker 的原子操作会严重竞争。缓存批量 flush 到全局数组，减少原子操作竞争。Source: `g1RegionMarkStatsCache.hpp:62-128`。

6. **SATB buffer 与并发标记的协作**：`satb_qs.set_buffer_size(G1SATBBufferSize=1024)`（`:488`）——每个 Java 线程的 SATB buffer 可存 1024 个旧引用。并发标记期间，`_cm_thread` 定期调用 `drain_satb_buffers()` 处理 completed buffers。标记完成前必须 drain 所有 SATB buffer——确保 SATB snapshot 完整性。Source: `g1ConcurrentMark.cpp:488-489`。

7. **StringDedup 的初始化**：`G1StringDedup::initialize()` 是模板方法的包装——`StringDedup::initialize_impl<G1StringDedupQueue, G1StringDedupStat>()`。模板参数决定队列类型（G1StringDedupQueue）和统计类型（G1StringDedupStat）。创建 `StringDedupThread` 后台线程 + `StringDedupTable`（共享哈希表）。G1 的 StringDedup 区别于其他 GC——只在 G1 下可用。Source: `g1StringDedup.cpp:39-44`。

8. **WorkGang 线程池的层次**：G1 有三个 WorkGang：`_workers`（"GC Thread", ParallelGCThreads=13）在 `G1CollectedHeap` 构造中创建——用于 STW GC 暂停；`_concurrent_workers`（"G1 Conc", ConcGCThreads=3）在 `G1ConcurrentMark` 构造中创建——用于并发标记；精炼线程（1-N）由 `G1ConcurrentRefineThreadControl` 管理——不通过 WorkGang。Source: `g1CollectedHeap.cpp:1546-1550`, `g1ConcurrentMark.cpp:516-517`。

---

## §二 Standard Environment（必须写入文档 §二）

文档 §二 必须包含以下内容：

### Source Roots

| 文件 | 关键行号 | 角色 |
|------|---------|------|
| `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp` | `:371-613` (构造函数) | G1ConcurrentMark 主类实现 |
| `src/hotspot/share/gc/g1/g1ConcurrentMark.hpp` | `:111-112` (类型别名), `:151-239` (G1CMMarkStack), `:301-634` (类定义), `:637-863` (G1CMTask) | G1ConcurrentMark 类定义 |
| `src/hotspot/share/gc/g1/g1ConcurrentMarkThread.hpp` | `:36-99` (三态状态机) | 标记主控线程 |
| `src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp` | `:283-331` (create + 三色区域计算) | 并发精炼器创建 |
| `src/hotspot/share/gc/g1/g1ConcurrentRefine.hpp` | `:71-137` (类定义 + 三色区域) | G1ConcurrentRefine 类 |
| `src/hotspot/share/gc/g1/g1ConcurrentRefineThread.hpp` | `:37-69` (类定义) | 精炼线程类 |
| `src/hotspot/share/gc/g1/g1YoungRemSetSamplingThread.hpp` | `:42-58` (类定义) | RSet 采样线程 |
| `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | `:1610-1635` (两个线程创建包装函数), `:2255` (new G1ConcurrentMark), `:2302-2342` (SATB/DirtyCard 队列), `:2428` (G1StringDedup::initialize) | G1CollectedHeap 中的线程创建 |
| `src/hotspot/share/gc/g1/g1StringDedup.cpp` | `:39-44` (initialize) | 字符串去重初始化 |
| `src/hotspot/share/gc/g1/g1StringDedup.hpp` | `:63-86` (类定义) | G1StringDedup 接口 |
| `src/hotspot/share/gc/g1/g1CMBitMap.hpp` | `:62-125` (类定义) | 并发标记位图 |
| `src/hotspot/share/gc/g1/g1RegionMarkStatsCache.hpp` | `:39-52` (G1RegionMarkStats), `:62-128` (Cache) | Region 标记统计缓存 |
| `src/hotspot/share/gc/g1/g1OldGenAllocationTracker.hpp` | `:34-67` (类定义) | 老年代分配追踪 |
| `src/hotspot/share/gc/g1/g1ConcurrentMarkObjArrayProcessor.hpp` | 全文 | 大对象数组处理器 |

### Build & Binary

```bash
make jdk-image
# 产物: build/linux-x86_64-server-release/jdk/lib/server/libjvm.so
```

### Syscall 速查表

| Syscall | man | 调用点 | 说明 |
|---------|-----|--------|------|
| `mmap` | `man 2 mmap` | `g1ConcurrentMark.cpp:471-472` (位图关联存储) | `G1CMBitMap::initialize()` 将位图关联到 G1RegionToSpaceMapper 预留的虚拟空间 |
| `pthread_create` | `man 3 pthread_create` | `WorkGang::initialize_workers()` → `os::create_thread()` | 创建 3 个 GangWorker 线程 + 1 个 G1ConcurrentMarkThread + 1-N 个精炼线程 |

### /proc 接口速查

| 路径 | man | 作用 | 本文涉及 |
|------|-----|------|---------|
| `/proc/<pid>/maps` | `man 5 proc` | 查看位图 mmap 区域（2×1GB for 8GB heap） | 双位图各 1GB 虚拟预留 |
| `/proc/<pid>/status` | `man 5 proc` | 查看线程数（Threads 字段） | 并发标记 + 精炼 + 采样 + 去重线程 |
| `jstack <pid>` | - | 查看线程栈 | 验证 G1ConcMark/G1Refine/StringDedup 线程 |

### 全局状态变量

| 变量 | 类型 | 位置 | 初始值 |
|------|------|------|--------|
| `_cm->_prev_mark_bitmap` | `G1CMBitMap*` | `g1ConcurrentMark.hpp:319` | `&_mark_bitmap_1` |
| `_cm->_next_mark_bitmap` | `G1CMBitMap*` | `g1ConcurrentMark.hpp:320` | `&_mark_bitmap_2` |
| `_cm->_global_mark_stack` | `G1CMMarkStack` | `g1ConcurrentMark.hpp:331` | `_chunk_capacity=4096` |
| `_cm->_max_num_tasks` | `uint` | `g1ConcurrentMark.hpp:337` | `ParallelGCThreads=13` |
| `_cm->_concurrent_workers` | `WorkGang*` | `g1ConcurrentMark.hpp:382` | `"G1 Conc", 3 threads` |
| `_cm->_cm_thread` | `G1ConcurrentMarkThread*` | `g1ConcurrentMark.hpp:312` | 三态 Idle |
| `_cr->_green_zone` | `size_t` | `g1ConcurrentRefine.hpp:90` | 13 |
| `_cr->_yellow_zone` | `size_t` | `g1ConcurrentRefine.hpp:91` | 39 |
| `_cr->_red_zone` | `size_t` | `g1ConcurrentRefine.hpp:92` | 65 |
| `_young_gen_sampling_thread` | `G1YoungRemSetSamplingThread*` | `g1CollectedHeap.hpp` | 每 300ms 采样 |

---

## §三 Source Files Table（必须写入文档 §三）

| # | 源文件 | 关键行号 | 角色 | 应在文档 §一 讨论 |
|---|--------|---------|------|-----------------|
| 1 | `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp` | `:371-613` | G1ConcurrentMark 构造函数（~240 行） | §1.1-§1.8 |
| 2 | `src/hotspot/share/gc/g1/g1ConcurrentMark.hpp` | `:111-112`, `:151-239`, `:301-634`, `:637-863` | 类定义 + G1CMMarkStack + G1CMTask | §1.1-§1.8 |
| 3 | `src/hotspot/share/gc/g1/g1ConcurrentMarkThread.hpp` | `:36-99` | 标记主控线程（三态状态机） | §1.2 |
| 4 | `src/hotspot/share/gc/g1/g1CMBitMap.hpp` | `:62-125` | 并发标记位图（mark_distance=8B/bit） | §1.3 |
| 5 | `src/hotspot/share/gc/g1/g1RegionMarkStatsCache.hpp` | `:39-52`, `:62-128` | Region 标记统计缓存（1024 条目） | §1.7 |
| 6 | `src/hotspot/share/gc/g1/g1ConcurrentMarkObjArrayProcessor.hpp` | 全文 | 大对象数组处理器 | §1.7 |
| 7 | `src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp` | `:283-331` | create() — 三色区域计算 + 线程启动 | §1.9 |
| 8 | `src/hotspot/share/gc/g1/g1ConcurrentRefine.hpp` | `:71-137` | G1ConcurrentRefine 类定义 | §1.9 |
| 9 | `src/hotspot/share/gc/g1/g1ConcurrentRefineThread.hpp` | `:37-69` | 精炼线程类定义 | §1.9 |
| 10 | `src/hotspot/share/gc/g1/g1YoungRemSetSamplingThread.hpp` | `:42-58` | RSet 采样线程类定义 | §1.10 |
| 11 | `src/hotspot/share/gc/g1/g1StringDedup.cpp` | `:39-44` | initialize() | §1.11 |
| 12 | `src/hotspot/share/gc/g1/g1StringDedup.hpp` | `:63-86` | G1StringDedup 接口 | §1.11 |
| 13 | `src/hotspot/share/gc/g1/g1OldGenAllocationTracker.hpp` | `:34-67` | 老年代分配追踪（5×size_t） | §1.8 |
| 14 | `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | `:1610-1635`, `:2255`, `:2428` | 线程创建包装函数 + G1ConcurrentMark 创建 | §1.9-§1.11 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### Q1: G1ConcurrentMark 构造函数初始化列表创建了哪些数据结构？初始化顺序有何含义？

**定位**：`g1ConcurrentMark.cpp:371-468` 初始化列表。

**必读源码**：`g1ConcurrentMark.cpp:371-468`（完整初始化列表），`g1ConcurrentMark.hpp:301-634`（成员变量声明）。

**答案方向**（≥8 行）：

1. 列出初始化列表中创建的全部对象（非指针赋值），标注每个对象的类型和 sizeof 估算。初始化列表共创建 ~15 个对象/数组。
2. `_mark_bitmap_1()` 和 `_mark_bitmap_2()` 先于 `_prev_mark_bitmap(&_mark_bitmap_1)` ——为什么？（答案：C++ 成员初始化顺序 = 声明顺序。`_mark_bitmap_1` 在 `.hpp:317` 声明，`_prev_mark_bitmap` 在 `.hpp:319`——所以 `_mark_bitmap_1` 先构造，`_prev_mark_bitmap` 可以安全引用它）
3. `_heap(_g1h->reserved_region())` 在 `:377` —— `_g1h` 在初始化列表中第 2 个（`:372`）——为什么顺序重要？（答案：`_heap` 依赖 `_g1h`，C++ 保证声明顺序初始化）
4. `_worker_id_offset = DirtyCardQueueSet::num_par_ids() + G1ConcRefinementThreads`（`:385`）——为什么需要这个偏移？（答案：GC worker 线程的 ID 需要避让 DirtyCard 队列线程和精炼线程——这些线程共享一个 ID 空间）
5. `_max_num_tasks = ParallelGCThreads`（`:386`）——为什么是 ParallelGCThreads 而非 ConcGCThreads？（答案：并发标记的 task 数等于 GC worker 数——因为 remark/cleanup 的 STW 阶段也需要这些 task 并行处理）
6. `_terminator(ParallelTaskTerminator(_max_num_tasks, _task_queues))`（`:390-391`）——`ParallelTaskTerminator` 的 `_n_threads` 初始化为 `_max_num_tasks`（13）——这意味着什么？（答案：所有 13 个 worker 都需要 offer_termination 才能结束标记阶段）
7. `_region_mark_stats(NEW_C_HEAP_ARRAY(G1RegionMarkStats, _g1h->max_regions(), mtGC))`（`:418`）——2048 个元素，每个 8B = 16KB——为什么用 `NEW_C_HEAP_ARRAY` 而非成员数组？（答案：max_regions 在运行时才知道——不是编译期常量）
8. **反事实**：如果初始化列表顺序错误（如 `_prev_mark_bitmap(&_mark_bitmap_1)` 在 `_mark_bitmap_1()` 之前）→ 引用未构造对象 → 未定义行为（UB）→ 可能 crash 或静默错误。C++ 标准保证声明顺序初始化，但初始化列表的书写顺序可以不同——如果写错顺序，编译器只警告不报错。

### Q2: 双缓冲位图如何实现 O(1) 交换？每个 bit 对应多少堆内存？

**定位**：`g1CMBitMap.hpp:62-125` 类定义 + `g1ConcurrentMark.cpp:371-376, 471-472` 构造。

**必读源码**：`g1CMBitMap.hpp:62-125`（类定义），`g1CMBitMap.cpp` 中 `initialize()` 实现。

**答案方向**（≥8 行）：

1. `_mark_bitmap_1` 和 `_mark_bitmap_2` 是两个独立 `G1CMBitMap` 对象（各 ~76B）。`_prev_mark_bitmap` 和 `_next_mark_bitmap` 是 `G1CMBitMap*` 指针——交换只需 swap 两个 8B 指针，不复制 1GB 数据。
2. `G1CMBitMap` 继承自什么？（答案：`BitMapView`——一个指向实际位图存储的视图。实际存储由 `G1RegionToSpaceMapper` 管理）
3. `mark_distance()` 返回 `1 << LogMinObjAlignment` = 8——物理含义：每个 bit 对应 8 字节堆内存。8GB 堆 → 1GB 位图。为什么是 8 而非 1？（答案：Java 对象最小对齐 8 字节——按 1 字节粒度浪费 8× 内存）
4. `heap_map_factor()` 返回 `mark_distance()`——即 1 bit = 8 bytes——这个 factor 用于 `G1RegionToSpaceMapper` 计算 commit 粒度。
5. `is_marked(addr)` 实现（`g1CMBitMap.hpp:98-103`）：`_bm.at(addr_to_offset(addr))`——`addr_to_offset()` 如何计算？（答案：`(addr - _covered.start()) >> _shifter`，`_shifter = LogMinObjAlignment = 0`）
6. `par_mark(addr)` vs `mark(addr)` 的区别？（答案：`par_mark` 用原子 `par_set_bit`，并发安全；`mark` 用非原子 `set_bit`，STW 阶段使用）
7. **反事实**：如果只用 1 个位图 → 并发标记写入时 Mixed GC 无法读取稳定的上一轮标记结果 → 必须等标记完成才能 Mixed GC → 标记和回收串行化 → 吞吐量大幅下降。双缓冲允许标记和回收重叠——prev 供回收读取，next 供标记写入。

### Q3: G1CMMarkStack 的 chunk 链表如何实现无锁 push/pop？

**定位**：`g1ConcurrentMark.hpp:151-239` 类定义 + `g1ConcurrentMark.cpp` 中 `par_push()`/`par_pop()` 实现。

**必读源码**：`g1ConcurrentMark.hpp:151-239`（类定义，特别是 cache-line padded 字段），`g1ConcurrentMark.inline.hpp` 中 `par_push()`/`par_pop()` 实现。

**答案方向**（≥8 行）：

1. `TaskQueueEntryChunk` 结构：`next` 指针（8B）+ `data[1023]`（8184B）= 8192B = 8KB。为什么是 1023 而非 1024？（答案：`EntriesPerChunk = 1024 - 1 = 1023`——1 个位置留给 next 指针的 cache line 对齐）
2. `_free_list`（CL1）、`_chunk_list`（CL2）、`_hwm`（CL3）各占一个 cache line——为什么？（答案：push 线程写 `_chunk_list`（CL2），pop 线程读 `_chunk_list`（CL2）——如果不分离，push/pop 产生 false sharing → 性能下降）
3. `par_push(entry)` 的算法：从 `_free_list` CAS pop 一个 chunk → 填充 entry → CAS push 到 `_chunk_list` 头部。如果 `_free_list` 空？（答案：从 `_chunk_list` 的预留空间中分配新 chunk——`_hwm` 递增）
4. `par_pop(entry)` 的算法：从 `_chunk_list` 头部取 chunk → 取最后一个 entry → chunk 空了则 CAS 从 `_chunk_list` 摘除 → 归还到 `_free_list`。如果 `_chunk_list` 空？（答案：返回 false——调用方需从其他 worker 窃取）
5. `_chunk_capacity`（初始 4096）和 `_max_chunk_capacity`（16384）——为什么有最大限制？（答案：防止无限溢出导致 OOM——如果标记栈超过 128MB，说明对象图异常大或存在泄漏）
6. **反事实**：如果标记栈用连续数组而非 chunk 链表 → 需要预分配最大容量（128MB）→ 即使大多数 GC 只用到几 MB → 浪费 ~120MB 虚拟内存。chunk 链表按需分配——初始 4096 chunks (32MB)，不够再扩——节省内存。

### Q4: 13 个 G1CMTaskQueue 各 1MB —— 为什么需要这么大的本地队列？

**定位**：`g1ConcurrentMark.cpp:572-579` 队列创建。

**必读源码**：`taskqueue.hpp` 中 `GenericTaskQueue` 模板实现（特别是 `_elems[N]` 和 `max_elems()`）。

**答案方向**（≥8 行）：

1. `GenericTaskQueue<G1TaskQueueEntry, mtGC>` 的 `N = TASKQUEUE_SIZE = 131072`——`_elems[N]` = 131072 × 8B = 1MB。为什么这么大？（答案：标记一个 Region（4MB / 8B = 512K 个 word）可能产生大量灰色对象——队列必须能容纳一个 Region 的所有引用）
2. `max_elems()` 返回 `N - 2 = 131070`——为什么减 2？（答案：环形缓冲区需要 1 个空位区分 full/empty——`_bottom` 和 `_age` 之间的 gap 判断满状态）
3. `OverflowTaskQueue` 继承自 `GenericTaskQueue`，额外包含什么？（答案：`_overflow_stack`——当本地队列满时 push 到溢出栈而非丢失。溢出栈用 `G1CMMarkStack` 的 chunk 链表）
4. `G1CMTaskQueueSet` 包含 `_queues` 指针数组（13 × 8B = 104B）——`steal(queue_num, seed, t)` 的实现：`seed = (seed + 1) % _n`（round-robin）→ 从选中的队列 `pop_global(t)` 窃取。`pop_global` 与 `push` 的竞争：`_age` 字段用 CAS 保护 pop 端（队列底部），`_bottom` 字段只被 owner 写入（队列顶部）——push/pop 在队列两端，减少竞争。
5. 追问：如果所有队列都空 → worker 调用 `offer_termination()` → `ParallelTaskTerminator` 计数 → 所有 13 个 worker 都 offer_termination → 标记阶段结束。
6. **反事实**：如果队列太小（如 1KB）→ 频繁溢出到全局 `G1CMMarkStack` → 增加 CAS 竞争和 cache miss → 标记吞吐量下降。1MB 队列在大多数 GC 中足够容纳一个 Region 的灰色对象——溢出是异常路径。

### Q5: G1ConcurrentRefine 的三色区域如何控制精炼线程的激活和停用？

**定位**：`g1ConcurrentRefine.cpp:283-331` create + `g1ConcurrentRefine.cpp` 中 `adjust_threads_periodically()`。

**必读源码**：`g1ConcurrentRefine.cpp:283-331`（create + 三色区域计算），`g1ConcurrentRefine.cpp` 中 `activation_threshold()` 实现。

**答案方向**（≥8 行）：

1. `calc_init_green_zone()` 为什么默认 = `ParallelGCThreads`（13）？（答案：经验值——当 completed dirty card buffers 少于 GC 线程数时，意味着每个线程平均不到 1 个 buffer → 不值得启动精炼线程——card 的缓存效应使重复 dirty 的 card 被合并）
2. `calc_init_yellow_zone()` 默认 = `green × 2`（26），但 ≥ `min_yellow_zone_size`（26）→ 最终 = 39。为什么 yellow 和 min_yellow 可能不同？（答案：`calc_init_yellow_zone` 从 green 推导，`calc_min_yellow_zone_size` 从 `G1ConcRefinementThresholdStep × max_num_threads()` 推导——两者考虑不同的约束）
3. `calc_init_red_zone()` 默认 = `yellow + (yellow - green)` = 39 + 26 = 65——为什么 red 的增量等于 yellow-green？（答案：red 是 yellow 的对称扩展——保持激活梯度的线性性）
4. `G1ConcurrentRefineThreadControl::initialize()` 创建多少个线程？（答案：`UseDynamicNumberOfGCThreads=true` 时只创建 1 个 primary——其他 secondary 在需要时动态创建；`false` 时创建 `max_num_threads()` 个）
5. primary 线程（worker 0）的 `_monitor = DirtyCardQ_CBL_mon`——其他线程的 monitor 是什么？（答案：每个 secondary 线程创建自己的 Monitor——由前一个线程 `notify()` 唤醒，形成级联激活链）
6. **反事实**：如果没有精炼线程 → 所有 RSet 更新在 mutator 的写屏障中同步完成 → 每次引用存储触发 RSet 更新 → 10M writes/sec → 10M 次 RSet 操作 → mutator 吞吐量下降 20-30%。精炼线程将 RSet 更新从 mutator 的热路径移出——mutator 只需标记 card 为 dirty（1 条指令），精炼线程异步处理 dirty card。

### Q6: G1YoungRemSetSamplingThread 如何影响年轻代大小调整？

**定位**：`g1YoungRemSetSamplingThread.hpp:42-58` 类定义 + `g1YoungRemSetSamplingThread.cpp` 实现。

**必读源码**：`g1YoungRemSetSamplingThread.hpp:42-58`，`g1YoungRemSetSamplingThread.cpp` 中 `run()` 和 `sample_young_list_rs_lengths()` 实现。

**答案方向**（≥8 行）：

1. `G1YoungRemSetSamplingThread` 继承自 `ConcurrentGCThread` ——构造函数内 `set_name("G1 Young RemSet Sampling")` + `create_and_start()`——线程在构造时立即启动。
2. `run()` 方法的主循环：`_monitor.wait(G1YoungRemSetSamplingIntervalMillis=300)` → `sample_young_list_rs_lengths()` → 更新 `G1Policy::revise_young_list_target_length_if_necessary()`。
3. `sample_young_list_rs_lengths()` 采样什么？（答案：遍历所有 young region → 读取每个 region 的 RSet 长度（`hr->rem_set()->occupied()`）→ 计算 `rs_lengths` 总和 → 反馈给 G1Policy）
4. 为什么需要采样？（答案：RSet 长度决定 GC 暂停时间——如果 young gen 太大，RSet 总长度超出预测 → 暂停超标 → 下次 GC 缩小 young gen。采样提供数据给 G1Policy 动态调整）
5. 追问：为什么采样间隔是 300ms？（答案：`G1YoungRemSetSamplingIntervalMillis` 默认值——平衡采样精度和 CPU 开销。太频繁 → 采样线程消耗 CPU；太稀疏 → RSet 变化来不及反映）
6. **反事实**：如果没有采样线程 → young gen 大小调整只能依赖 GC 暂停时间反馈——但 GC 暂停时间受多种因素影响（allocation rate、RSet 长度、evacuation failure 等）→ 难以分离 RSet 的影响。采样线程提供 RSet 的独立信号——使 young gen sizing 更精准。

### Q7: StringDedup 的初始化——G1StringDedupQueue 和 StringDedupTable 的内部结构

**定位**：`g1StringDedup.cpp:39-44` initialize + `g1StringDedupQueue.cpp` + `stringDedupTable.cpp`。

**必读源码**：`g1StringDedup.cpp:39-44`，`g1StringDedupQueue.hpp`（类定义），`stringDedupTable.hpp`（类定义）。

**答案方向**（≥8 行）：

1. `StringDedup::initialize_impl<G1StringDedupQueue, G1StringDedupStat>()` 是模板方法——为什么用模板？（答案：不同 GC 实现需要不同的队列和统计类型——G1 用 `G1StringDedupQueue`（基于 G1 的并发队列），ZGC 可能有自己的实现）
2. `G1StringDedupQueue` 的内部存储？（答案：`G1StringDedupQueue` 是静态类——内部用 `StringDedupQueue` 基类的共享数据结构：链表节点池 + free list + completed list）
3. `StringDedupTable` 是什么？（答案：共享哈希表——存储已去重的字符串的 hash→char[] 映射。查表：`String::value()` → hash → lookup → 找到相同内容的 char[] → 返回共享 char[]）
4. `StringDedupThread` 何时创建？（答案：`initialize_impl()` 中 `StringDedupThread::create()`——1 个后台线程，处理 completed queue 中的候选字符串）
5. 追问：StringDedup 只在 G1 下可用——为什么？（答案：`G1StringDedup::initialize()` 有 `assert(UseG1GC)`——其他 GC 不需要或尚未实现）
6. **反事实**：如果没有 StringDedup → 大量重复字符串（如 XML 标签名、JSON key、SQL 列名）→ 每个副本占用独立的 char[] → 内存浪费。StringDedup 将多个 String 对象指向同一个 char[]——减少 char[] 内存使用（通常节省 10-20% 堆内存）。

### Q8: G1OldGenAllocationTracker 如何为 IHOP 提供数据？

**定位**：`g1OldGenAllocationTracker.hpp:34-67` 类定义。

**必读源码**：`g1OldGenAllocationTracker.hpp:34-67`（完整类定义 + inline 方法实现）。

**答案方向**（≥8 行）：

1. 5 个 `size_t` 成员各自的含义：`_last_period_old_gen_bytes`（上一 mutator 周期的老年代总分配）、`_last_period_old_gen_growth`（净增长 = 分配 - eager reclaim）、`_humongous_bytes_after_last_gc`（上次 GC 后的 humongous 字节）、`_allocated_bytes_since_last_gc`（非 humongous 分配）、`_allocated_humongous_bytes_since_last_gc`（humongous 分配）。
2. `reset_after_gc(humongous_bytes_after_gc)` 的核心计算（`:66`）：`_last_period_old_gen_growth = _allocated_bytes_since_last_gc + _allocated_humongous_bytes_since_last_gc - (_humongous_bytes_after_last_gc - humongous_bytes_after_gc)`——解释公式中 humongous 部分的含义。
3. 为什么区分 humongous 和非 humongous 分配？（答案：humongous 对象直接分配到 old gen——跳过 young gen——需要单独追踪以便 IHOP 计算准确的 old gen 分配速率）
4. `_last_period_old_gen_bytes` 包含 humongous 吗？（答案：`add_allocated_bytes_since_last_gc()` 只累加非 humongous——humongous 由 `add_allocated_humongous_bytes_since_last_gc()` 单独累加）
5. 追问：`record_collection_pause_humongous_allocation(bytes)` 何时调用？（答案：GC 暂停期间的 humongous 分配——计入上一周期而非当前周期——因为上一周期的 GC 已经结束，这些分配属于上一 mutator 周期）
6. **反事实**：如果 IHOP 不追踪 humongous 分配 → 大量 humongous 对象分配被忽略 → old gen 实际增长被低估 → IHOP 阈值过高 → 并发标记来不及完成 → Full GC。humongous 分配单独追踪使 IHOP 能准确计算 old gen 的真实增长速率。

---

## §五 Article Structure（文档 §一 结构）

文档 §一 按以下顺序组织：

### §1.1 G1ConcurrentMark 构造函数初始化列表
- 初始化列表创建的全部对象（15 个），标注每个对象的类型和 sizeof
- 声明顺序 vs 初始化列表顺序——C++ 规则和潜在 UB
- `_worker_id_offset` 的 ID 空间避让设计

### §1.2 G1ConcurrentMarkThread — 三态状态机
- Idle → Started → InProgress 状态转换
- `_phase_manager_stack` 的 ConcurrentGCPhaseManager 用途
- 继承链：G1ConcurrentMarkThread → ConcurrentGCThread → NamedThread → NonJavaThread → Thread

### §1.3 双缓冲位图 — G1CMBitMap
- `mark_distance() = 8` 的物理含义：1 bit = 8 heap bytes
- `is_marked()` / `par_mark()` / `mark()` 的实现
- `_covered` MemRegion 和 `_shifter` 的寻址计算
- 位图存储由 G1RegionToSpaceMapper 管理（见 02-G1-Heap-Startup）

### §1.4 G1CMMarkStack — chunk 链表的无锁溢出栈
- `TaskQueueEntryChunk` 结构：8KB = 1×next + 1023×entry
- 4 个 cache-line padded 字段的 false sharing 防护
- `par_push()` / `par_pop()` 的 CAS 算法
- 初始 4096 chunks (32MB) → 最大 16384 (128MB)

### §1.5 13 个 G1CMTaskQueue + G1CMTaskQueueSet
- `GenericTaskQueue<G1TaskQueueEntry>` 的 1MB `_elems` 环形缓冲区
- `max_elems() = N-2 = 131070` 的原因
- `OverflowTaskQueue` 的溢出栈与 G1CMMarkStack 的协作
- `G1CMTaskQueueSet::steal()` 的 round-robin 工作窃取

### §1.6 ParallelTaskTerminator + 双溢出屏障
- `ParallelTaskTerminator` 的 `offer_termination()` 协议
- `WorkGangBarrierSync`（`_first/_second_overflow_barrier_sync`）的双屏障协议
- 溢出处理：所有 worker 暂停 → drain 全局栈 → 重启

### §1.7 G1CMTask — 单个标记任务的执行单元
- `_task_queue`（1MB 队列）+ `_mark_stats_cache`（12KB 缓存）
- `_finger`（本地扫描指针）+ `_region_limit`（扫描上限）
- `_words_scanned` / `_refs_reached` 的自适应限流
- `_objArray_processor`（大对象数组处理器）
- 工作窃取：`_hash_seed` + `steal()` + `offer_termination()`

### §1.8 G1RegionMarkStats + G1RegionMarkStatsCache
- `G1RegionMarkStats`：单个 `size_t _live_words`（8B）
- `G1RegionMarkStatsCache`：1024 条目 × 12B = 12KB 每 worker
- 缓存批量 flush 到全局数组——减少原子操作竞争

### §1.9 G1ConcurrentRefine — 三色区域 + 精炼线程
- `create()` 中 green/yellow/red zone 的计算公式
- primary vs secondary 线程的级联激活
- `DirtyCardQ_CBL_mon` 的 mutator 通知路径
- `adjust_threads_periodically()` 的动态线程调整

### §1.10 G1YoungRemSetSamplingThread
- 300ms 采样间隔 + `_monitor.wait()` 等待
- `sample_young_list_rs_lengths()` 的 RSet 长度采样
- 反馈给 G1Policy 的 `revise_young_list_target_length_if_necessary()`

### §1.11 G1StringDedup 初始化
- `StringDedup::initialize_impl<G1StringDedupQueue, G1StringDedupStat>()` 模板方法
- `StringDedupThread` + `G1StringDedupQueue` + `StringDedupTable` 的创建
- G1 独占（`assert(UseG1GC)`）

---

## §六 Writing Requirements（含"不要写成→应该写成"对照表）

| # | 不要写成 | 应该写成 |
|---|---------|---------|
| 1 | "G1ConcurrentMark 管理并发标记" | "`G1ConcurrentMark` 构造函数（`g1ConcurrentMark.cpp:371-613`）在初始化列表中创建 `_mark_bitmap_1/2`（`g1ConcurrentMark.hpp:317-318`，`G1CMBitMap` 各 ~76B）→ `_global_mark_stack`（`:331`，`G1CMMarkStack`，4 cache-line padded 字段 ~256B）→ `_task_queues`（`:341`，`G1CMTaskQueueSet*`，13 个 NULL 指针 104B）→ `_terminator`（`:342`，`ParallelTaskTerminator`，`_n_threads=13`）→ `_region_mark_stats`（`:480`，2048×8B=16KB）" |
| 2 | "位图用双缓冲避免冲突" | "`_prev_mark_bitmap`（`g1ConcurrentMark.hpp:319`）指向 `_mark_bitmap_1`，`_next_mark_bitmap`（`:320`）指向 `_mark_bitmap_2`。标记完成时交换两个指针（O(1)）。`G1CMBitMap::mark_distance()`（`g1CMBitMap.hpp:84`）返回 `1 << LogMinObjAlignment = 8`——每个 bit 对应 8 字节堆内存，8GB 堆 → 1GB 位图。`par_mark(addr)`（`:120`）用 `_bm.par_set_bit()` 原子操作，并发安全" |
| 3 | "标记栈用链表管理溢出" | "`G1CMMarkStack`（`g1ConcurrentMark.hpp:151-239`）用 `TaskQueueEntryChunk` 链表。每个 chunk 8KB（`next` 指针 8B + `data[1023]` 8184B = `EntriesPerChunk=1023`）。`_free_list`（`:170`，CL1）→ `_chunk_list`（`:172`，CL2）→ `_hwm`（`:176`，CL3）各占一个 cache line。`par_push()` CAS 从 `_free_list` pop chunk → 填充 → CAS push 到 `_chunk_list`。初始 `_chunk_capacity=4096`（32MB），最大 `_max_chunk_capacity=16384`（128MB）" |
| 4 | "每个 worker 有自己的任务队列" | "13 个 `G1CMTaskQueue`（`g1ConcurrentMark.hpp:111`，`GenericTaskQueue<G1TaskQueueEntry, mtGC>`）各含 `_elems[N]` 环形缓冲区（`N=TASKQUEUE_SIZE=131072`，1MB）。`max_elems()=N-2=131070`——减 2 用于区分 full/empty。`OverflowTaskQueue` 额外含 `_overflow_stack`——本地队列满时溢出到全局 `G1CMMarkStack`。`G1CMTaskQueueSet::steal()` round-robin 从其他 worker 窃取" |
| 5 | "精炼线程处理 dirty card" | "`G1ConcurrentRefine::create()`（`g1ConcurrentRefine.cpp:283-331`）计算 `min_yellow=26` → `green=13` → `yellow=39` → `red=65`。`new G1ConcurrentRefine(green,yellow,red,min_yellow)`（`:315`）→ `cr->initialize()`（`:326`）创建 primary 精炼线程（`G1ConcurrentRefineThread`，`_worker_id=0, _monitor=DirtyCardQ_CBL_mon`）。`[0,green)` 不处理，`[green,yellow)` 逐步激活，`[yellow,red)` 全线程运行，≥red 应用线程参与" |
| 6 | "G1CMTask 执行标记" | "`G1CMTask`（`g1ConcurrentMark.hpp:637-863`）含 `_task_queue`（`G1CMTaskQueue*`，1MB 环形缓冲区）→ `_mark_stats_cache`（`G1RegionMarkStatsCache`，1024 条目×12B=12KB）→ `_finger`（`HeapWord*`，本地扫描指针）→ `_words_scanned_limit`（`size_t`，每次 step 最多扫描 12K words）→ `_objArray_processor`（`G1CMObjArrayProcessor`，处理大对象数组）。`_mark_stats_cache` 批量 flush 到 `_region_mark_stats[2048]`——减少 13 worker 的原子操作竞争" |

---

## §七 Output Format

文档输出路径：`/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/09-G1-Concurrent-Marking-Infra.md`

### 文档标题格式

```
# 09-G1-Concurrent-Marking-Infra — G1 并发标记执行引擎与辅助线程
```

### Section 编号（写入文档时使用此编号）

```
§〇 Production Scenario — 并发标记的 1.2 秒与三色区域
§一 G1 并发标记基础设施初始化（11 小节）
§二 Standard Environment
§三 Source Files Table
§四 异常路径分析（G1ConcurrentMark 构造失败 / 精炼线程 OOM / 采样线程创建失败）
§五 GDB 断点验证（≥7 断言）
§六 总内存开销
§七 Cross-Reference
§八 Mermaid 架构图（双缓冲位图 + chunk 链表 + 工作窃取）
§九 Mermaid 线程关系图（_cm_thread + _concurrent_workers + _cr + _young_gen_sampling_thread + StringDedupThread）
```

### GDB Verification（≥7 断言）

```
断言 1: G1ConcurrentMark 构造完成 (g1ConcurrentMark.cpp:613 之后)
  (gdb) print _cm
  期望: 非 NULL
  (gdb) print _cm->_max_num_tasks
  期望: 13 (= ParallelGCThreads)

断言 2: 双缓冲位图 (g1ConcurrentMark.cpp:472 之后)
  (gdb) print _cm->_prev_mark_bitmap
  期望: == &_cm->_mark_bitmap_1
  (gdb) print _cm->_next_mark_bitmap
  期望: == &_cm->_mark_bitmap_2
  (gdb) print _cm->_prev_mark_bitmap->mark_distance()
  期望: 8

断言 3: 全局标记栈 (g1ConcurrentMark.cpp:554 之后)
  (gdb) print _cm->_global_mark_stack.capacity()
  期望: 4096 (初始 chunk 数)
  (gdb) print _cm->_global_mark_stack.is_empty()
  期望: true

断言 4: 13 个任务队列 (g1ConcurrentMark.cpp:579 之后)
  (gdb) print _cm->_task_queues->_n
  期望: 13
  (gdb) print _cm->_task_queues->queue(0)->max_elems()
  期望: 131070

断言 5: 并发工作线程池 (g1ConcurrentMark.cpp:517 之后)
  (gdb) print _cm->_concurrent_workers->total_workers()
  期望: 3 (= ConcGCThreads)
  (gdb) print _cm->_cm_thread
  期望: 非 NULL

断言 6: 并发精炼器 (g1ConcurrentRefine.cpp:331 之后)
  (gdb) print _cr->_green_zone
  期望: 13
  (gdb) print _cr->_yellow_zone
  期望: 39
  (gdb) print _cr->_red_zone
  期望: 65

断言 7: 采样线程 + 字符串去重 (g1CollectedHeap.cpp:2428 之后)
  (gdb) print _young_gen_sampling_thread
  期望: 非 NULL
  (gdb) print G1StringDedup::is_enabled()
  期望: true (如果 -XX:+UseStringDeduplication)
```

---

## §八 Prohibited（≥8 条）

1. **禁止只写概念不写代码行号**：每个技术断言必须有 `file:line` 引用。
2. **禁止把 G1ConcurrentMark 构造函数写成摘要**：必须逐段展开初始化列表和构造函数体，标注每个对象的创建位置和大小。
3. **禁止跳过 cache line padding 的设计理由**：`G1CMMarkStack` 的 4 个 cache line 分离 `_free_list`/`_chunk_list`/`_hwm`——必须解释 false sharing 的防护机制。
4. **禁止忽略 `_worker_id_offset` 的 ID 空间避让**：GC worker 线程的 ID 需要避让 DirtyCard 队列和精炼线程——必须解释原因和计算方式。
5. **禁止把工作窃取写成概念描述**：必须展示 `G1CMTaskQueueSet::steal()` 的 round-robin 算法和 `pop_global()` 的 CAS 竞争细节。
6. **禁止把精炼线程写成"后台线程"**：必须展示三色区域的激活阶梯、primary/secondary 级联通知链、`DirtyCardQ_CBL_mon` 的 mutator 通知路径。
7. **禁止省略 `G1RegionMarkStatsCache` 的批量 flush 机制**：1024 条目缓存的设计目的（减少原子操作竞争）必须解释。
8. **禁止把 StringDedup 写成独立功能**：必须展示 `StringDedup::initialize_impl<G1StringDedupQueue, G1StringDedupStat>()` 的模板方法模式和 G1 独占限制。
9. **禁止写成 Java GC 教程**：这是 C++ 源码分析文档。不要解释什么是并发标记/精炼/去重——直接分析源码中的数据结构、算法和内存布局。

---

## §九 Required（≥8 条）

1. **Mermaid 双缓冲位图架构图**：展示 `_mark_bitmap_1` / `_mark_bitmap_2` → `_prev_mark_bitmap` / `_next_mark_bitmap` → `G1RegionToSpaceMapper` 物理存储的层次关系。
2. **Mermaid chunk 链表结构图**：展示 `G1CMMarkStack` → `_free_list` (CL1) → `_chunk_list` (CL2) → `_hwm` (CL3) → `TaskQueueEntryChunk` (8KB: next + 1023×entry)。
3. **Mermaid 工作窃取流程图**：13 个 worker → 各自 `G1CMTaskQueue` → 空时 `steal()` → round-robin 选 victim → `pop_global()`。
4. **Mermaid 线程关系图**：`G1CollectedHeap` → `_cm` → `_cm_thread` (1) + `_concurrent_workers` (3) + `_cr` → 精炼线程 (1-N) + `_young_gen_sampling_thread` (1) + `StringDedupThread` (1)。
5. **三色区域激活阶梯表**：`[0,13)` 不处理 → `[13,39)` 逐步激活 → `[39,65)` 全线程 → `[65,∞)` mutator 参与。
6. **总内存开销表**：G1ConcurrentMark (~450B) + G1ConcurrentMarkThread (~264B) + G1CMBitMap×2 (~152B) + G1CMMarkStack (~256B + 32MB chunks) + G1CMTaskQueue×13 (13MB) + G1CMTask×13 (~4.7KB + 156KB cache) + G1RegionMarkStats (16KB) + G1ConcurrentRefine (~56B) + G1ConcurrentRefineThread×1 (~248B) + G1YoungRemSetSamplingThread (~256B) + WorkGang×2 (~2KB) = **总计 ~45MB**（含 32MB mark stack chunks + 13MB 任务队列）。
7. **§〇 诊断步骤**：jstack 验证线程 + jcmd VM.flags 验证参数 + GDB 断点验证内部状态。
8. **§一 末尾 Interview Story Format Answer**：完整的技术叙述，覆盖 G1ConcurrentMark 构造函数的初始化列表 + 构造函数体 + 三色区域 + 采样线程 + StringDedup。
9. **Callout 框 ≥7 个**：全部 inline 在 §一 中，不在 §二 出现。

---

## §十 与 README 和同组文档的连续性

- **前置文档**：[02-G1-Heap-Startup]（堆内存布局 + SATB/DirtyCard 队列）+ [08-G1-Policy-Analytics]（G1Policy 决策引擎 + 遗漏构造函数成员）
- **配套文档**：[08-G1-Policy-Analytics] — Policy 层（本文）负责决策"何时 GC"，Concurrent Mark 层（本文）负责执行"如何标记"
- **后续文档**：所有 GC 运行时 Phase（Young GC / Mixed GC / Full GC / Concurrent Mark Cycle）依赖本文创建的标记执行引擎
- **与 init_globals 的关系**：本文覆盖的子系统在 `init_globals` 第 9 步 `universe_init()` 中创建——G1ConcurrentMark 在 `G1CollectedHeap::initialize()` 的 `:2255` 创建，精炼线程在 `:2307` 创建，采样线程在 `:2312` 创建，StringDedup 在 `:2428` 初始化
