# PROMPT: 请撰写 04-Full-GC.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

线上故障：G1 堆 32GB，`-XX:MaxGCPauseMillis=200`，`-XX:InitiatingHeapOccupancyPercent=45`。业务高峰期突然出现每秒 1 次 Full GC，每次暂停 2-5 秒，服务完全不可用。

GC 日志显示：
```
[1234.567s] Full GC (Concurrent Mode Failure) 28G->15G(32G), 3.452s
[1238.210s] Full GC (Concurrent Mode Failure) 30G->22G(32G), 5.211s
[1243.876s] Full GC (Concurrent Mode Failure) 31G->26G(32G), 4.890s
[1248.345s] Full GC (Concurrent Mode Failure) 32G->29G(32G), 5.764s  ← 每秒 1 次！
```

根因诊断链：

```bash
# 1. jstat 实时监控 — 发现 Full GC 频率异常
jstat -gc <pid> 1000
# 输出: FGC 每 1-2 秒递增，老年代使用率 90%+
# YGC 正常执行但 FGC 不停止

# 2. jstat -gccause — 确认触发原因
jstat -gccause <pid> 1000
# LGCC: Concurrent Mode Failure ← 根本原因！
# 并发标记速度追不上分配速度

# 3. GDB 现场 — 验证 Full GC 内部状态
gdb -ex "break g1FullCollector.cpp:173" \
    -ex "break g1FullGCMarker.inline.hpp:40" \
    -ex "break g1FullGCCompactionPoint.cpp:97" \
    -ex "run" \
    -ex "print _num_workers" \
    -ex "print _scope->region()" \
    --args java -Xmx32g -XX:+UseG1GC -jar app.jar
# 发现：_num_workers=8 并行执行，但标记 bitmap 中 live objects 超过 90%
# → 可回收对象极少 → 压缩后 heap 基本无变化 → 下次分配再次触发 Full GC → 死循环

# 4. 确认根因
# IHOP=45 但 allocation rate 在 GC 期间远高于 mark rate
# Concurrent Mark 从未真正完成 → "Last Resort" Full GC 被反复调用
# 每次 Full GC 后 heap resize 回原大小 → 空间仍然不够 → 下一轮失败
```

**反事实**：如果 Full GC 也用复制 (evacuation) 而非压缩 (compaction) → 需要与 Young GC 一样多的空 Region 做目标 → Full GC 通常发生在堆几乎满的时候（空 Region 极少）→ 复制不可行。压缩在堆满时仍然能工作——它把活对象挤在一起，释放出连续的可用空间段。这就是 Full GC 作为 "Last Resort" 的核心语义：**空间最少时仍能完成回收**。

三步诊断（直接写进 §〇）：
1. `jstat -gccause <pid> 1000` → 确认 LGCC 为 Concurrent Mode Failure
2. GDB 断点 `g1FullCollector.cpp:173` → 打印 `_num_workers` + `_scope->region()` 验证并行度
3. GDB 断点 `g1FullGCCompactionPoint.cpp:97` → 验证 forward pointer 设置 + `_compaction_top` 推进

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces G1 Full GC as the JVM's ultimate safety net — the "Last Resort" when incremental GC strategies fail. This is NOT a tutorial on what Full GC does — it's ENGINEERING documentation on HOW the JVM implements the Mark → Prepare → Adjust → Compact 4-phase pipeline in source-code-specific detail.

Reader completed **01-02-G1-Heap-Startup** (G1CollectedHeap 构造 18 步、Region 类型初始化、mmap commit/commit)、**01-08-G1-Policy-Analytics** (G1Policy 8 子组件、IHOP 自适应阈值)、**01-09-G1-Concurrent-Marking-Infra** (双缓冲 Bitmap + CMTask×13)。本文：**当并发标记失败后，JVM 如何用全 STW 压缩回收整个堆**——从 `do_full_collection` 到达安全点、到 `G1FullCollector::collect()` 编排 4 个阶段、到 `compact_region` 调用 `Copy::aligned_conjoint_words` 物理移动对象、到 `restore_marks` 恢复偏向锁标记。

### Interview Story Format Answer（必须出现在 §一 末尾）

"When Concurrent Mode Failure occurs — the concurrent marking couldn't keep up with allocation rate — G1 has only one move left: a full STW compaction via `G1FullCollector`. The process begins with `do_full_collection` creating a `G1FullCollector` with one `G1FullGCMarker` and one `G1FullGCCompactionPoint` per worker thread. Phase 1 (`phase1_mark_live_objects` at g1FullCollector.cpp:238) runs a parallel mark task using `mark_object` (g1FullGCMarker.inline.hpp:40) which CAS-marks bitmap bits. For large object arrays, `follow_array_chunk` (inline.hpp:106) splits marking into strides for work stealing. Phase 2 (`phase2_prepare_compaction` at :271) uses `G1FullGCCompactionPoint::forward` (:97) to compute new addresses by slide compaction — every live object gets a forwarding pointer. Because each worker owns a disjoint set of regions (via `HeapRegionClaimer`), there's zero contention despite parallel execution. Phase 3 (`phase3_adjust_pointers` at :282) walks ALL references in the heap using `G1AdjustClosure::adjust_pointer` (g1FullGCOopClosures.inline.hpp:63) — `obj->forwardee()` yields the new address and `RawAccess::oop_store` writes it. Phase 4 (`phase4_do_compaction` at :290) physically moves objects using `Copy::aligned_conjoint_words` (g1FullGCCompactTask.cpp:74) — the same semantics as `memmove` (handles overlapping regions). After all 4 phases, `complete_collection` restores biased locking marks (`BiasedLocking::restore_marks` at g1FullCollector.cpp:224), updates CodeCache (`CodeCache::gc_epilogue` at :225), and triggers `resize_if_necessary_after_full_collection` to adjust heap size based on `MinHeapFreeRatio`/`MaxHeapFreeRatio`."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **STW (Stop-The-World) vs Concurrent**: Full GC is 100% STW — every Java thread is frozen at a safepoint during all 4 phases. Young GC is also STW but shorter (evacuation only ~10-50ms). Concurrent Mark runs while mutators execute, only pausing at Initial Mark (embedded in Young GC) and Remark. Full GC STW means: no mutator allocation, no compiler threads, no GC threads trying to run concurrently — the entire heap is the GC's exclusive domain. Source: `VM_G1CollectFull::doit` at vm_operations_g1.cpp:37 → `g1h->do_full_collection`.

2. **Bitmap-Based Marking vs Mark Word Bits**: Full GC marking uses separate `G1FullGCMarker::_bitmap` (a parallel bitmap stored in `G1CMBitMap`) — NOT the object header mark word's GC bits. The mark word is used for forwarding pointers during compaction and must be preserved/restored. Marking the bitmap has zero impact on lock state, identity hash, or GC age. Source: `mark_object` at g1FullGCMarker.inline.hpp:40 → `_bitmap->par_mark(obj)`.

3. **Forwarding Pointer**: During Phase 2, `forward_to(new_addr)` writes the new address into the object's mark word (replacing lock/hash data temporarily). The mark word's original content is saved in `PreservedMarksSet` via `must_be_preserved`. During Phase 3, `forwardee()` reads the forwarding pointer from the mark word to update references. During Phase 4, after the object is moved, `init_mark_raw()` clears the forwarding pointer and restores to prototype mark. This double-duty of the mark word (lock + forwarding) is why biased locking marks must be preserved separately. Source: `G1FullGCCompactionPoint::forward` at g1FullGCCompactionPoint.cpp:97-127.

4. **Slide Compaction (vs Evacuation)**: Slide compaction pushes all live objects to one end of each Region — they "slide" together, eliminating all gaps (fragmentation). Evacuation (used in Young GC) copies objects to a SEPARATE destination Region. Slide compaction works even when the heap has ZERO free regions because objects are moved within the same region (`(HeapWord*)object != _compaction_top` check at g1FullGCCompactionPoint.cpp:106). Evacuation requires free destination regions — which don't exist during Full GC.

5. **Concurrent Mode Failure**: This is THE most common trigger for Full GC in G1. It means the concurrent marking cycle (Phase 1-5 of marking lifecycle) could not complete before the heap filled. G1 promises "incremental pauses with bounded latency" — but when allocation rate exceeds mark rate, the JVM's fallback is to abort concurrent marking and run a full STW compaction. Common causes: IHOP too high (marking starts too late), allocation spikes (sudden surge of large objects), or NUMA memory latency causing slow marking. Source: `g1CollectedHeap.cpp:1164` → `do_full_collection` called with `GCCause::_g1_inc_collection_pause` or `GCCause::_g1_concurrent_marking_failure`.

6. **OOM Serial Fallback**: After Phase 2, if NOT a single HeapRegion could be freed (all regions are full of live objects), the parallel compaction plan can't work — there's nowhere to compact INTO. The system falls back to `prepare_serial_compaction()` which uses a single serial compaction point. This is an "extreme last resort" — it means the heap is genuinely out of memory and the Full GC may still fail. Source: `g1FullCollector.cpp:277-278` → `if (!task.has_freed_regions()) { task.prepare_serial_compaction(); }`.

7. **Heap Resize After Full GC**: After `complete_collection`, G1 evaluates whether to grow or shrink the heap based on `MinHeapFreeRatio` (default 40%) and `MaxHeapFreeRatio` (default 70%). If used/capacity ratio is too high → expand heap. If too low → shrink heap. This is critical because a Full GC that barely succeeds will trigger again immediately unless the heap grows. Source: `resize_if_necessary_after_full_collection` at g1CollectedHeap.cpp:1203-1279.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/gc/g1/` — G1 GC 主目录（197 文件，~65K 行）
- `src/hotspot/share/gc/shared/` — GC 共享框架（referenceProcessor, preserveMarks, taskqueue）
- `src/hotspot/share/oops/` — oop 对象模型（markOop, forward_to, forwardee, init_mark）
- `src/hotspot/share/utilities/` — Copy::aligned_conjoint_words memmove 实现

Build: `make hotspot`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — 所有 G1 Full GC 源码编译在内

Full GC 的关键 syscall（`Copy::aligned_conjoint_words` 底层调用的内存操作）：
| syscall | man | 用途 |
|---------|-----|------|
| `memmove` | `man 3 memmove` | 对象物理移动（支持重叠） |
| `mprotect` | `man 2 mprotect` | HeapRegion commit/uncommit 保护 |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **g1FullCollector.cpp** | `src/hotspot/share/gc/g1/g1FullCollector.cpp` | 335 | `collect()`(:173, 4 阶段编排), `phase1_mark_live_objects`(:238), `phase2_prepare_compaction`(:271), `phase3_adjust_pointers`(:282), `phase4_do_compaction`(:290), `prepare_collection`(:141, CodeCache+BiasedLocking), `complete_collection`(:211, restore+resize) | 总指挥 |
| 2 | **g1FullGCMarker.inline.hpp** | `src/hotspot/share/gc/g1/g1FullGCMarker.inline.hpp` | 176 | `mark_object`(:40, CAS bitmap 标记), `follow_array_chunk`(:106, 大数组分块), `follow_object`(:156, stop-the-world closure dispatch) | 标记内核 |
| 3 | **g1FullGCMarkTask.cpp** | `src/hotspot/share/gc/g1/g1FullGCMarkTask.cpp` | 71 | `work()` — parallel mark task with work stealing queue | Phase 1 并行执行体 |
| 4 | **g1FullGCPrepareTask.cpp** | `src/hotspot/share/gc/g1/g1FullGCPrepareTask.cpp` | 221 | `work()` — per-region prepare + `prepare_serial_compaction` | Phase 2 并行执行体 |
| 5 | **g1FullGCAdjustTask.cpp** | `src/hotspot/share/gc/g1/g1FullGCAdjustTask.cpp` | 118 | `work()` — adjust all oop references via closure | Phase 3 并行执行体 |
| 6 | **g1FullGCCompactTask.cpp** | `src/hotspot/share/gc/g1/g1FullGCCompactTask.cpp` | 113 | `compact_region`(:81, 逐 Region 压缩), `serial_compaction` | Phase 4 并行执行体 |
| 7 | **g1FullGCCompactionPoint.cpp** | `src/hotspot/share/gc/g1/g1FullGCCompactionPoint.cpp` | 146 | `forward`(:97, 计算新地址+设置 forward ptr), `object_will_fit`(:84), `switch_region`(:89) | 压缩点管理 |
| 8 | **g1FullGCOopClosures.inline.hpp** | `src/hotspot/share/gc/g1/g1FullGCOopClosures.inline.hpp` | 104 | `G1AdjustClosure::adjust_pointer`(:63, forwardee→store), `G1MarkAndPushClosure::do_oop_work`(:39), `G1IsAliveClosure`(:95) | 闭包集合 |
| 9 | **g1CollectedHeap.cpp** | `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | ~4500 | `do_full_collection`(:1164, :1195 两个重载), `satisfy_failed_allocation`(:1313, 3 次重试), `resize_if_necessary_after_full_collection`(:1203) | 触发入口 + 堆大小调整 |
| 10 | **vm_operations_g1.cpp** | `src/hotspot/share/gc/g1/vm_operations_g1.cpp` | ~165 | `VM_G1CollectFull::doit`(:37, safepoint 同步+调用 do_full_collection) | VM 操作层 |

### 补充文件（跨子系统交互）

| # | File | Full Path | Key Functions | Role |
|---|------|-----------|-------|------|
| 11 | **biasedLocking.cpp** | `src/hotspot/share/runtime/biasedLocking.cpp` | `preserve_marks`, `restore_marks` — save/restore biased lock marks across GC | 锁子系统 |
| 12 | **codeCache.cpp** | `src/hotspot/share/code/codeCache.cpp` | `gc_prologue`, `gc_epilogue` — flush bytecode pointers before GC, restore after | 代码缓存 |
| 13 | **jvmtiExport.cpp** | `src/hotspot/share/prims/jvmtiExport.cpp` | `gc_epilogue` — notify JVMTI agents of GC completion | JVM TI 通知 |
| 14 | **preservedMarks.cpp** | `src/hotspot/share/gc/shared/preservedMarks.cpp` | `push_if_necessary`, `restore` — save mark words during bitmap marking, restore after compaction | mark word 保存/恢复 |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ Full GC 触发条件 — 4 种路径 + 3 次重试

```
问题：
  ① Full GC 的 4 种触发路径分别是什么？各自的入口和 GCCause 是什么？
      答案方向:
      Path A: Allocation Failure (最频繁)
        → G1CollectedHeap::satisfy_failed_allocation(:1313)
        → 第 1 次: try 普通 allocation → expand_and_allocate → do_full_collection(clear_all_soft_refs=false)
        → 第 2 次: 如果第一次 Full GC 后仍失败 → do_full_collection(clear_all_soft_refs=true) 清软引用
        → 第 3 次: 如果仍失败 → 纯 allocation 尝试（不再 GC）→ 返回 NULL → OutOfMemoryError
        GCCause: _g1_inc_collection_pause
      Path B: Concurrent Mode Failure
        → Concurrent Mark 未完成（allocation > mark rate）
        → G1ConcurrentMark::abort_concurrent_cycle() → Full GC
        GCCause: _g1_concurrent_marking_failure
      Path C: System.gc() or JVM_GC
        → VM_G1CollectFull::doit (vm_operations_g1.cpp:37)
        → do_full_collection(explicit_gc=true, clear_all_soft_refs=false)
        GCCause: _java_lang_system_gc 或 _jvm_allocate_for_..._system_gc
      Path D: Metadata GC 阈值
        → Metaspace 空间不足 → collector_policy()->collect_as_vm_thread(GCCause::_metadata_GC_threshold)
        → do_full_collection
        GCCause: _metadata_GC_threshold

      追问: 3 次重试为什么不直接在 satisfy_failed_allocation 中循环而是 3 次独立调用？
      → 每次 do_full_collection 的 clear_all_soft_refs 参数不同:
        第 1 次 false: 保留 SoftReference（给应用一次机会）
        第 2 次 true: 清 SoftReference（如果第 1 次不够）
        第 3 次 false: 不再 GC（已经在 2 次 Full GC 后——空间应该已经最大化了）
      → 如果 3 次后仍失败：`expand_and_allocate` 扩展物理堆 + 再试 — 因为可能存在虚拟空间未提交
      源码验证: satisfy_failed_allocation_helper(:1281-1311) 的调用逻辑
```

### 4.2 ★★★ Phase 1: 并行标记 — mark_object CAS + work stealing + 引用处理

```
问题：
  ① mark_object (g1FullGCMarker.inline.hpp:40) 的原子标记流程是什么？
      答案方向:
      1. 检查是否为 archive object → G1ArchiveAllocator::marked(obj) → 跳过
      2. _bitmap->par_mark(obj): CAS 原子操作设置 bitmap bit
         → 返回 true = 首次标记（this thread won the CAS race）
         → 返回 false = 已标记（another worker already marked it）
      3. 如果首次标记 + mark->must_be_preserved(obj):
         → _preserved_stack->push(obj, mark) — 保存原始 mark word
      4. StringDedup::enqueue_from_mark → 去重候选入队
      5. return true — 调用者知道需要继续扫描此对象的引用
      
      追问: 为什么用独立 bitmap 而非 mark word bits？
      → Full GC 期间 mark word 被复用为 forwarding pointer (Phase 2)
      → Bitmap 标记与 mark word 解耦 — 标记完成后 bitmap 用于 Phase 2 查找活对象
      → mark word 在此处只被读取（must_be_preserved 检查）和保存（push to preserved stack）
      → 如果标记写入 mark word → Phase 2 的 forward 会覆盖标记 → Phase 3 无法区分活对象

  ② follow_array_chunk (inline.hpp:106) 的大数组分块策略是什么？
      答案方向:
        stride = MIN2(len - beg_index, ObjArrayMarkingStride)  ← 默认 512
        算法: 先 push 剩余 chunk 到 work queue → 再处理当前 chunk
        这确保 work stealing 能偷到更大的任务→负载均衡
        push 格式: G1FullGCArrayTask(array, beg_index + stride)  ← "剩菜先入队"
        之后处理当前元素: beg_index 到 beg_index + stride - 1
      
      追问: 为什么 push 剩余而非当前？只有剩余先入队才能 work stealing 偷到最大 chunk
      → 如果先 push 当前 chunk（小）→ 剩余 chunk 在 worker 本地继续处理（大）
      → 其他 worker 只能偷到小 chunk → 负载不均 → 尾巴阶段长

  ③ Counterfactual: 如果 Full GC 标记沿用 Concurrent Mark 的 SATB buffer？
      答案方向: SATB (Snapshot-At-The-Beginning) 依赖 pre-write barrier 记录
      并发标记期间的旧值。但 Full GC 100% STW — 没有 mutator 写入，没有新对象，
      SATB buffer 为空。SATB 机制完全冗余。Full GC 用递归追踪（transitive closure）
      而非 SATB——标记从根集合出发，通过引用图遍历所有可达对象。在 STW 保证下，
      递归追踪比 SATB 更快（无 barrier 开销）。
```

### 4.3 ★★★ Phase 2: Slide Compaction — forward 算法 + 多 worker 无冲突原理

```
问题：
  ① G1FullGCCompactionPoint::forward (g1FullGCCompactionPoint.cpp:97) 的 slide compaction 新地址算法是什么？
      答案方向:
      — _compaction_top 是线性推进的指针，每次 forward 调用后 += size
      — new_addr = _compaction_top（当前压缩位置的地址）
      — object_will_fit (cpp:84): 检查 `size <= (current_region->end() - _compaction_top)`
        • 如果 fit → 直接使用 _compaction_top
        • 如果 not fit → switch_region() (cpp:89): 保存当前 region 的 compaction_top →
          取下一个 region → 重置 _compaction_top 到新区 region 的 bottom
      — 核心分支 (cpp:106): `if ((HeapWord*)object != _compaction_top)`
        • 如果不同位置 → object->forward_to(oop(_compaction_top)) 设置 forwarding pointer
        • 如果相同位置 (对象已在正确位置) → 清除可能被标记污染的 mark word → init_mark_raw()
          （如果 forwardee 返回非NULL 但对象不应该移动 — 说明标记 word 被误读为 forwarding）
      — _compaction_top += size（线性推进）
      
      追问: "slide" 的名字从何而来？
      → 所有活对象"滑"到一个 Region 的开头紧紧排列 → 消除所有碎片
      → 如果 Region 有 [gap][liveA][gap][liveB][gap] → compact 后变成 [A][B][gap...] — A 和 B 都滑到了开头
      → 不重新分配 Region（不复制到其他 Region）除非当前 Region 空间不够

  ② 多 worker 并行压缩如何保证无冲突？
      答案方向:
      — HeapRegionClaimer: 并行任务启动前分配 regions，确保每个 worker 独占一组 region
      — 每个 worker 有独立的 G1FullGCCompactionPoint:
        • 独立的 _compaction_top
        • 独立的 _compaction_regions 列表
        • 独立的 _current_region 指针
      — Worker A 压缩 Region [1,5,9] → 只用 CompactionPoint A
      — Worker B 压缩 Region [2,6,10] → 只用 CompactionPoint B
      — 无需任何锁或 CAS — 天然无冲突
      
      追问: 跨 Region 引用如何处理？如果 Worker A 压缩的 Region 1 包含指向 Region 2 的引用？
      → Phase 2 只计算新地址（设置 forward pointer）→ 不修改引用
      → 跨 Region 引用在 Phase 3 才处理（那时所有 forward pointer 已就位）

  ③ Counterfactual: 如果 Full GC 用 Evacuation（复制到新 Region）而非 Slide Compaction？
      答案方向: 复制需要：
        1. 目标 Region（分配了且空闲的 HeapRegion）
        2. 每个对象的内存分配 + memcpy 到新地址
      但 Full GC 的核心场景是堆几乎满（这就是为什么需要 Full GC）→ 空闲 Region 数量极少
      → 复制不可行。Slide Compaction 在原地 Region 内使用可用空间 → 即使只有 1 个 Region 可用
      → 仍能压缩整个 Region 的内容到其开头，释放出末尾的连续空间。
      Slide Compaction 的代价：需要遍历所有引用更新指针（Phase 3），而 Evacuation 可以
      在复制时一步完成地址更新。但这在"Last Resort"场景下是必要代价。
```

### 4.4 ★★★ Phase 3: 指针调整 — adjust_pointer 遍历所有 mark obj

```
问题：
  ① G1AdjustClosure::adjust_pointer (g1FullGCOopClosures.inline.hpp:63) 如何更新引用？
      答案方向:
      1. `T heap_oop = RawAccess<>::oop_load(p)` — 加载当前 oop 值
      2. `if (CompressedOops::is_null(heap_oop)) return` — null 指针不需要调整
      3. `oop obj = CompressedOops::decode_not_null(heap_oop)` — 解码压缩指针
      4. `if (G1ArchiveAllocator::is_closed_archive_object(obj)) return` — archive 对象不移动
      5. `assert(_bm->is_marked(obj), "must be marked")` — 只有活对象有 forward pointer
      6. `oop forwardee = obj->forwardee()` — 从 mark word 读取 forwarding pointer
      7. `if (forwardee != NULL)` — 对象确实移动了
         `RawAccess<IS_NOT_NULL>::oop_store(p, forwardee)` — 更新引用为压缩后地址
      注意: 调整的时机很重要——必须 Phase 2 全部完成后才执行 Phase 3。如果在 Phase 2 执行
      过程中就调整指针 → 可能的竞态：Worker A 读了 forwardee，但 Worker B 还没完成 forward → 读到 NULL → 引用丢失。
      源码验证: adjust_pointer 的 inline 实现 (:63-90)
      
      追问: 为什么 RawAccess::oop_store 而非直接 `*p = new_oop`？
      → RawAccess 处理压缩指针 (CompressedOops) 的编解码
      → 在 64-bit JVM with CompressedOops: oop 存储为 32-bit offset（压缩）
      → 而 forwardee 是完整的 64-bit oop → 需要编码回压缩格式后存储
      → RawAccess<IS_NOT_NULL>::oop_store 自动处理这个转换

  ② Counterfactual: 如果 Phase 2 和 Phase 3 合并（在 forward 时同时调整引用）？
      答案方向: 无法做到——因为在 Phase 2 中，某个 Worker A 正在 forward Region 5 的对象，
      但 Region 5 的对象可能被 Region 3（Worker B 的域）引用。Worker A 不知道 Worker B 
      是否已经完成了 Region 3 的 forward。如果 Worker B 还没开始 → 引用指向的 forwardee 未设置
      → 更新为 NULL。这将导致对象"丢失"。4 阶段严格顺序是必要的：先全局设置所有 forward pointer
      (Phase 2)，后全局调整所有引用 (Phase 3)。
```

### 4.5 ★★★ Phase 4: 物理移动 — compact_region + Copy::aligned_conjoint_words

```
问题：
  ① compact_region (g1FullGCCompactTask.cpp:81) 如何执行物理对象移动？
      答案方向:
      1. 从 compaction_point 获取此 region 的 compaction_queue（有序的对象偏移队列）
      2. 遍历队列中的每个对象:
         a. `oop obj = obj_...` — 获取原始对象
         b. `HeapWord* obj_addr = (HeapWord*)obj` — 对象当前物理地址
         c. `size_t size = obj->size()` — 对象大小
         d. `HeapWord* destination = (HeapWord*)(obj->forwardee())` — 压缩后目标地址
         e. `Copy::aligned_conjoint_words(obj_addr, destination, size)` (:74) — 物理移动！
            • aligned = 按 HeapWord (8-byte) 对齐移动，CPU 高效
            • conjoint = 等价于 memmove —— 支持重叠区域
            • 为什么需要 conjoint？slide compaction 中对象向前移动 → src > dst → 可能重叠
              （对象被移到它前面的位置，但前后对象都向前移 → 重叠不可避免）
         f. `obj->init_mark_raw()` — 清除 forward pointer，恢复为 prototype mark word
         g. `mark_bitmap->clear_region` — 清除标记 bitmap 位
      3. complete_compaction: 设置 region 的 bottom/top/end + 标记为 Old 类型
      
      追问: Copy::aligned_conjoint_words vs memcpy 的区别？
      → 与 §〇 的分析相同：Java spec 不要求 Full GC 支持重叠移动，但实现上 slide compaction 
        经常产生重叠（对象被移动到前面的位置）。Copy::aligned_conjoint_words 等价于 memmove——支持重叠，
        按 8-byte 对齐移动（CPU 使用 MOVSD 指令，32-byte SSE/AVX 向量化）。

  ② Counterfactual: 如果压缩阶段不移动对象，只是更新堆边界跳过间隙？
      答案方向: 这就是 "mark-sweep" (标记-清除) 策略而非 "mark-compact" (标记-压缩)。
      Mark-sweep 只标记活对象 → 释放间隙 → 不移动。优势: 快（无对象移动 + 无指针调整）。
      劣势: 碎片化 — 5 个 1MB 的间隙无法满足 3MB 分配 → 即使有 5MB 空闲仍会 OOM。
      Full GC 选择压缩而非清除是因为它是 "Last Resort" —— 这是最后一次回收机会，
      必须最大化可用性：消除所有碎片 + 释放出连续空间。
```

### 4.6 ★★★ OOM 串行 Fallback — prepare_serial_compaction + serial_compaction

```
问题：
  ① 什么时候会触发串行 Fallback？它的执行路径是什么？
      答案方向:
      触发条件 (g1FullCollector.cpp:277):
        if (!task.has_freed_regions())  ← 并行压缩中没有任何 Region 被释放
        → task.prepare_serial_compaction()  ← 串行重新计算压缩计划
      
      为什么并行压缩可能无 Region 被释放？:
        • 堆中几乎所有 Region 都是活的 → 没有足够空间做 slide compaction
        • 并行压缩需要独立的 free region per worker → 没有 free regions → 没有 destination
      
      prepare_serial_compaction 做什么？:
        • 收集所有 region 的 compaction_point 数据到单个 serial compaction point
        • 重新运行 prepare 逻辑（forward → switch_region 如果 fit fail）→ 尝试找出至少 1 个可压缩 region
        • 如果有 → Phase 4 会执行 serial_compaction (g1FullCollector.cpp:298)
        • 如果没有 → 真正的 OOM — Full GC 也救不了
      
      追问: 为什么不能并行失败时转为串行？
      → 并行压缩的 forward 计划已经基于多 worker 的独立 compaction_point 计算了
      → 如果并行方案没有 free region → 可能是因为资源被过度分裂（每个 worker 需要至少 1 个 free region）
      → 串行方案只需 1 个全局 free region → 成功率更高
      → 但串行压缩慢（1 个线程 vs N 线程）

  ② Counterfactual: 如果并行压缩继续执行而不检查 has_freed_regions？
      答案方向: Phase 4 在 compact_region 中执行 `destination = obj->forwardee()` → 
      compaction_point 为空 → destination = NULL → copy 到地址 0 → SIGSEGV → JVM crash。
      或者 forward pointer 指向无效地址（compaction_point 从未被分配）→ 
      写入受保护内存页面 → SIGSEGV。编译期无法检测——只能运行时 has_freed_regions 检查。
```

### 4.7 ★★★ 跨子系统影响 — BiasedLocking + CodeCache + JVM TI

```
问题：
  ① Full GC 如何与偏向锁交互？为什么必须 preserve/restore marks？
      答案方向:
      偏向锁 (BiasedLocking) 将线程 ID 和 Epoch 存储在对象 mark word 中。
      Full GC 的 Phase 1 (marking) 会覆盖 mark word: `mark->must_be_preserved(obj)` 检测到
      biased pattern 返回 true → mark word 被保存到 PreservedMarksSet。
      Phase 2 (forward) 写入 forward pointer 到 mark word → 覆盖 lock data。
      Phase 4 (compact) 移动对象后 init_mark_raw() 清除 forward pointer。
      complete_collection → BiasedLocking::restore_marks() (:224) → 从 PreservedMarksSet 恢复原始
      biased lock mark word 到对象。
      
      如果不做 preserve/restore → 所有偏向锁状态丢失 → 下次 synchronized 获取重新 bias
      → 无功能错误但性能退化（rebiase 需要 STW bulk rebias）。源码验证: biasedLocking.cpp
      的 `preserve_marks` 和 `restore_marks` 调用点。

  ② CodeCache::gc_prologue / gc_epilogue 做什么？为什么 Full GC 需要？
      答案方向:
      CodeCache::gc_prologue() → 将所有 CompiledMethod 的 bytecode pointers (bcp) 
      刷新为 bytecode indices (bci)。bcp 是绝对地址（指向 Klass 常量池中的字节码），
      在 GC 移动 Class/Method 元数据后变成野针。bcp→bci 转换为相对索引——GC 后可以
      通过 Method* + bci 重新计算正确的内存地址。
      CodeCache::gc_epilogue() → bci 重新转换为 bcp。
      Full GC 因为可能执行 Class unloading → Method* 可能被移动 → bcp→bci 转换是必要的。
      源码验证: g1FullCollector.cpp:163 (gc_prologue), :225 (gc_epilogue)

  ③ Counterfactual: 如果 Full GC 不做 CodeCache::gc_prologue？
      答案方向: 无 Class unloading 时可能无事，但如果 GC 决定 unload 一个 class:
        → CompiledMethod::code_begin() 中的 bcp 指向旧 Method* 中的字节码
        → Method* 被卸载 → 访问已释放内存 → SIGSEGV 或静默执行错误代码
        → 但 JVM 不能确定是否执行 class unloading（取决于 ClassUnloading flag + 根集合）
        → 所以始终调用 gc_prologue 作为安全措施。
```

### 4.8 ★★★ Full GC 与 Young GC / Mixed GC 的对比

```
问题：
  ① Full GC 压缩与 Young GC 复制的实现区别？为什么不同的策略？
      答案方向:
      
      维度          | Young GC (Evacuation)           | Full GC (Compaction)
      ─────────────┼─────────────────────────────────┼────────────────────────────
      对象移动      | 复制到 Survivor/Old Region       | 原地滑动到 Region 开头
      空间需求      | 需要 free Region 作为 target      | 原地，仅需 Region 内部空间
      暂停时间      | 短（~10-50ms）                   | 长（~100ms-10s）
      碎片处理      | 无碎片（新 Region 紧密排列）      | 消除碎片（旧 Region 内滑动）
      标记方式      | 不标记（只看 age table）          | 标记 bitmap（mark live objs）
      引用更新      | 在复制时一步完成（closure）       | 需要专门的 Phase 3（全局遍历）
      并行策略      | Worker 各自处理自己的 Region 集合  | Worker 各自有独立的 CompactionPoint
      开销          | 复制所有 Eden 活对象（额外内存）   | 移动所有 Old 活对象 + 更新所有引用
      
      为什么不同？:
      Young GC 针对短命对象: Eden 中大部分对象已死 → 复制少量活对象到新 Region 更便宜
      Full GC 针对全堆: 堆中大部分对象活着时，复制代价太高（需要 target Region = live set size）
      + 如果堆已满 → 没有 free Region 做 target → slide compaction 是唯一选择
      
      追问: Mixed GC 使用 Evacuation 从 Old Region 复制到 free Region——为什么 Mixed GC 不用 Compaction？
      → Mixed GC 只选择部分 Old Region (G1CollectionSet) → 有足够的 free Region 做 target
      → Evacuation 比 Compaction 快（无全局指针调整 Phase 3）
      → Mixed GC 的目标是 "部分回收" —— 不是 "最后一招"

  ② Counterfactual: 如果 G1 消除 Full GC 只用 Mixed GC？
      答案方向: 理想情况下可以——如果 IHOP 足够低、Concurrent Mark 能在堆满前完成、
      Mixed GC 能回收足够的 Old Region —— 理论上市面上有 JVM 提供 "pause-free" 的承诺。
      但现实是: 业务 spikes (突增分配)、NUMA 延迟、操作系统调度、compiler 竞争 → 
      没有 100% 保证 Concurrent Mark 不会失败。Full GC 是 safety net —— 无它时，
      Concurrent Mode Failure → OOM。有它时 → 3 秒暂停转 OOM 为 Full GC 后继续运行。
      这也是 G1 设计为 "pauseless with safety net" 而非 "guaranteed pauseless"。
```

---

## §五 Article Structure

```
§〇 生产场景 — Concurrent Mode Failure 死循环到 Full GC
  ★ 真实故障: 每秒 1 次 Full GC，LGCC = "Concurrent Mode Failure"
  ★ Root cause: IHOP=45, Concurrent Mark 追不上 allocation rate
  ★ 三步诊断: jstat -gccause → GDB g1FullCollector.cpp:173 → forward pointer 验证
  ★ 反事实: Full GC 用复制 vs 压缩的可行性分析

§一 ★★★ Full GC as Last Resort — 全链路源码走读
  ❓ Full GC 是 JVM 的终极安全网
  1.1 触发到 safepoint: VM_G1CollectFull::doit (vm_operations_g1.cpp:37-43)
  1.2 do_full_collection 双入口: explicit_gc + clear_all_soft_refs (g1CollectedHeap.cpp:1164-1201)
  1.3 G1FullCollector 创建: per-worker Marker + CompactionPoint (g1FullCollector.cpp 构造)
  1.4 prepare_collection: abort_concurrent_cycle + BiasedLocking + CodeCache (:141-171)
  1.5 collect() 4 阶段编排: phase1→phase2→phase3→phase4 (:173-207)
  1.6 complete_collection: restore_marks + BiasedLocking + CodeCache epilogue + heap resize (:211-236)
  1.7 ★ Mermaid: 4 阶段泳道图 Java Threads / VM Thread / Workers / CompactionPoint / Heap
      Lanes: Java Threads / VM_G1CollectFull / G1FullCollector / Worker×N / Heap
      Flow: Safepoint Sync → do_full_collection → prepare → [Phase1 Mark → Phase2 Prepare → Phase3 Adjust → Phase4 Compact] → complete
      Annotate every step with file:line
  1.8 ★ 面试 Story Format 答案 — 从 Concurrent Mode Failure 到 Copy::aligned_conjoint_words 的完整叙事

§二 ★★★ 7 Beginner Callout 框
  2.1 STW vs Concurrent
  2.2 Bitmap-Based Marking vs Mark Word Bits
  2.3 Forwarding Pointer (mark word 双重用途)
  2.4 Slide Compaction vs Evacuation
  2.5 Concurrent Mode Failure
  2.6 OOM Serial Fallback
  2.7 Heap Resize After Full GC

§三 ★★★ 触发条件深度分析 — 4 种路径 + 3 次重试
  ❓ Allocation Failure 的 3 次重试为什么这么设计？
  3.1 Allocation Failure Path: satisfy_failed_allocation→attempt_allocation→expand_and_allocate→do_full_collection×2
  3.2 Concurrent Mode Failure Path: abort_concurrent_cycle→do_full_collection
  3.3 System.gc() Path: VM_G1CollectFull→do_full_collection(explicit_gc=true)
  3.4 Metadata GC Path: collector_policy→collect_as_vm_thread
  3.5 3 次重试的 clear_all_soft_refs 参数递进逻辑

§四 ★★★ Phase 1: 并行标记详解
  ❓ mark_object CAS bitmap 标记 + must_be_preserved 保存
  4.1 G1FullGCMarker 结构: _bitmap + _marking_stack (_oop_stack) + _compaction_point
  4.2 mark_object 全流程: archive check → par_mark CAS → preserved check → dedup enqueue
  4.3 follow_array_chunk: 大数组分块 + work stealing 策略
  4.4 引用处理: G1FullGCReferenceProcessingExecutor 发现→Process→Enqueue
  4.5 Weak oops cleanup + Class unloading (SystemDictionary::do_unloading)
  4.6 ★ 代码展示: mark_object (inline.hpp:40-75) + follow_array_chunk (inline.hpp:106-162)

§五 ★★★ Phase 2: 计算新地址 (Slide Compaction)
  ❓ forward 如何计算新地址 + 多 worker 无冲突原理
  5.1 G1FullGCCompactionPoint 结构: _compaction_top + _current_region + _compaction_regions
  5.2 forward 算法: object_will_fit → switch_region(if not fit) → forward_to(oop(_compaction_top))
  5.3 forwarding pointer 与 mark word 冲突处理（:105-127 的关键 assert 和 init_mark_raw）
  5.4 HeapRegionClaimer 保证多 worker 无冲突
  5.5 ★ 代码展示: forward (g1FullGCCompactionPoint.cpp:97-127) 完整实现
  5.6 Mermaid: Slide Compaction 示意图 — 压缩前后的 Region 内存布局对比

§六 ★★★ Phase 3: 调整指针
  ❓ adjust_pointer 遍历所有引用 → forwardee → oop_store
  6.1 G1AdjustClosure 结构: _bitmap + do_oop_work
  6.2 adjust_pointer 完整流程: oop_load → null check → archive check → forwardee → oop_store
  6.3 CompressedOops 编码/解码: 为什么不能用 `*p = new_oop`
  6.4 为什么 Phase 3 必须在 Phase 2 完成后？竞态分析
  6.5 ★ 代码展示: adjust_pointer (g1FullGCOopClosures.inline.hpp:63-90)

§七 ★★★ Phase 4: 压缩移动 + 收尾
  ❓ compact_region → Copy::aligned_conjoint_words → init_mark_raw → bitmap clear
  7.1 compact_region 流程: 遍历 compaction_queue→destination=forwardee→copy→init_mark→bitmap_clear
  7.2 Copy::aligned_conjoint_words: memmove 语义 + 8-byte 对齐 + CPU 指令级优化
  7.3 为什么 copy 支持重叠？slide compaction 的 src > dst 重叠
  7.4 serial_compaction: OOM 场景的串行压缩
  7.5 complete_compaction: 设置 region bottom/top/end + 标记 Old
  7.6 ★ 代码展示: compact_region (g1FullGCCompactTask.cpp:81-110)

§八 ★★ OOM 串行 Fallback + Heap Resize
  ❓ 并行压缩失败 → 串行重试 → 如果仍失败 → 真正的 OOM
  8.1 has_freed_regions 检查: 并行压缩后仍无 free region
  8.2 prepare_serial_compaction: 单线程重新计算压缩计划
  8.3 serial_compaction: 单线程执行 Phase 4
  8.4 Heap Resize: MinHeapFreeRatio/MaxHeapFreeRatio 驱动 expand/shrink

§九 ★★ 跨子系统交互
  ❓ BiasedLocking + CodeCache + JvmtiExport 如何与 Full GC 协作
  9.1 BiasedLocking::preserve_marks → PreservedMarksSet → restore_marks 完整流程
  9.2 CodeCache::gc_prologue (bci→bcp 转换) + gc_epilogue (恢复)
  9.3 JvmtiExport::gc_epilogue (JVMTI agent 通知)
  9.4 PreservedMarksSet: SharedRestorePreservedMarksTaskExecutor 并行恢复

§十 ★★★ 与 Young GC / Mixed GC 的对比
  ❓ 为什么 Young GC 复制、Full GC 压缩？
  10.1 对比表: Evacuation vs Compaction (7 维度)
  10.2 为什么 Mixed GC 不用 Compaction (有 free regions)
  10.3 为什么 Full GC 不用 Evacuation (无 free regions)
  10.4 各策略的适用场景: allocation rate / heap occupancy / pause time 三角分析

§十一 ★ 诊断工具五件套
  ❓ strace + jstat + jcmd + GDB + /proc
  11.1 strace: 追踪 Full GC 期间的 mmap/mprotect/memmove 系统调用
  11.2 jstat -gccause: 监控 FGC 次数 + LGCC 触发原因
  11.3 jcmd GC.class_histogram + GC.heap_dump: post-mortem 分析
  11.4 GDB 断点验证: 7 断言验证 Full GC 内部状态
  11.5 /proc/<pid>/smaps: 观察 heap commit/uncommit 变化

§十二 ★ Cross-Reference 总表
  01-02-G1-Heap-Startup — G1CollectedHeap 构造 + Region 初始化（本文的堆在构造后运行）
  01-08-G1-Policy-Analytics — G1Policy + IHOP 自适应（本文的 Concurrent Mode Failure 根因）
  01-09-G1-Concurrent-Marking-Infra — 双缓冲 Bitmap + CMTask（本文的失败场景）
  30-01-Young-GC-Evacuation — Young GC Evacuation（本文的 Evacuation 对比）
  30-02-Concurrent-Marking — Concurrent Mark Lifecycle（本文的失败原因）
  30-03-Mixed-GC-Policy — Mixed GC 决策（本文的前一阶段）
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because Concurrent Mark failed to complete before heap exhaustion, G1 falls back to Full GC as the safety net..." — not "G1 Full GC has 4 phases."

2. **3-5 lines source code per claim** — paste relevant C++ code from g1FullCollector.cpp / g1FullGCMarker.inline.hpp / g1FullGCCompactionPoint.cpp / g1FullGCOopClosures.inline.hpp / g1FullGCCompactTask.cpp, do not describe it.

3. **Mermaid sequence diagram** — Phase 30 doc-04 Full GC 4 阶段泳道图。6 lanes: Java Threads / VM Thread (VM_G1CollectFull) / G1FullCollector / Worker Threads × N / CompactionPoint × N / Heap Memory. Complete flow: Java thread reaches safepoint → VM_G1CollectFull::doit → do_full_collection → G1FullCollector 构造 → prepare (abort concurrent cycle + BiasedLocking + CodeCache) → Phase 1 (parallel mark — mark_object CAS + follow_array_chunk steal) → Phase 2 (forward — compaction_top linear push + switch_region) → Phase 3 (adjust — forwardee lookup + oop_store) → Phase 4 (compact — aligned_conjoint_words + init_mark) → complete (restore marks + resize heap). Annotate every step with exact file:line.

4. **GDB session** — 7 breakpoints with exact file:line numbers:
   - `vm_operations_g1.cpp:37` VM_G1CollectFull::doit → verify Full GC cause
   - `g1FullCollector.cpp:173` collect() entry → verify 4 阶段开始
   - `g1FullGCMarker.inline.hpp:40` mark_object → verify CAS bitmap marking
   - `g1FullGCCompactionPoint.cpp:97` forward → verify forwarding pointer
   - `g1FullGCOopClosures.inline.hpp:63` adjust_pointer → verify oop_store
   - `g1FullGCCompactTask.cpp:74` Copy::aligned_conjoint_words → verify physical move
   - `g1FullCollector.cpp:224` BiasedLocking::restore_marks → verify lock restoration
   Each with expected variable values to verify.

5. **7 Beginner callout boxes** — exact text from §一: STW vs Concurrent, Bitmap-Based Marking vs Mark Word Bits, Forwarding Pointer, Slide Compaction vs Evacuation, Concurrent Mode Failure, OOM Serial Fallback, Heap Resize After Full GC.

6. **Cross-reference at four points**:
   - At `do_full_collection` → "→ 01-02-G1-Heap-Startup for G1CollectedHeap initialization"
   - At `G1FullGCMarker::_bitmap` → "→ 01-09-G1-Concurrent-Marking-Infra for G1CMBitMap construction"
   - At `satisfy_failed_allocation` → "→ 30-03-Mixed-GC-Policy for the Mixed GC decision that preceded Full GC"
   - At `Evacuation comparison` → "→ 30-01-Young-GC-Evacuation for Evacuation mechanics"

7. **Story-format interview answer** — at §一末尾: 从 Concurrent Mode Failure 到 `Copy::aligned_conjoint_words` 完成压缩的叙事。从 `do_full_collection` 创建 `G1FullCollector` 构建 per-worker Marker + CompactionPoint → prepare 阶段 abort_concurrent_cycle + BiasedLocking save → 4 阶段调度 + 指针链 → complete 阶段 restore marks + heap resize。

---

## §七 Output Format

- Markdown file, named `04-Full-GC.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/30-g1-runtime-gc/docs/`
- 元信息头:

```
> **阶段**：[30-g1-runtime-gc]
> **前置**：[01-02-G1-Heap-Startup]（G1CollectedHeap 构造 18 步、Region 初始化）、[01-09-G1-Concurrent-Marking-Infra]（G1CMBitMap 双缓冲设计、CMTask 框架）、[30-02-Concurrent-Marking]（Concurrent Mark Lifecycle — Full GC 是标记失败的 Fallback）
> **配套**：[30-00-Region-Runtime]（Region 9 态状态机）、[30-01-Young-GC-Evacuation]（Young GC 疏散）、[30-02-Concurrent-Marking]（并发标记生命周期）、[30-03-Mixed-GC-Policy]（Mixed GC 决策引擎）
> **后续依赖本文**：无（Full GC 是 GC 路径的终点站）
> **阅读收益**：追踪 G1 Full GC 从 Concurrent Mode Failure 到 `Copy::aligned_conjoint_words` 完成压缩的完整 4 阶段流程——理解 `satisfy_failed_allocation` 的 3 次重试 + `do_full_collection` 的 4 种触发路径、`mark_object` 的 CAS bitmap 原子标记 + `follow_array_chunk` 的 work stealing、`G1FullGCCompactionPoint::forward` 的 slide compaction 新地址算法、`G1AdjustClosure::adjust_pointer` 的 forwardee 查找→`RawAccess::oop_store`、`compact_region` 的 `Copy::aligned_conjoint_words` 物理移动、OOM 串行 Fallback + `prepare_serial_compaction`、`BiasedLocking::preserve/restore` 与 `CodeCache::gc_prologue/epilogue` 的跨子系统协作
```

- 目标行数: 3500+ lines（Full GC 是 G1 的终极安全网，必须深度覆盖 4 阶段 + 4 种触发路径 + 跨子系统交互）

---

## §八 Prohibited（≥8）

- ❌ 只说 "Phase 1 marks objects" 而不展示 `mark_object` 的 CAS bitmap 标记 + `must_be_preserved` 检测 → 必须从 `g1FullGCMarker.inline.hpp:40-75` 完整展示标注源码
- ❌ 不解释 `G1FullGCCompactionPoint::forward` 的 slide compaction 新地址算法 → 必须展示 `_compaction_top` 线性推进 + `object_will_fit` → `switch_region` 的完整逻辑
- ❌ 不解释 `adjust_pointer` 中 `forwardee()` 查找 + `RawAccess::oop_store` 的压缩指针处理 → 必须展示 `g1FullGCOopClosures.inline.hpp:63-90` 的完整内联代码
- ❌ 跳过 `Copy::aligned_conjoint_words` 的物理移动细节 → 必须解释为什么用 conjoint (memmove) 而非 aligned_disjoint (memcpy) — slide compaction 的 src>dst 重叠问题
- ❌ 忘记 `preserved_marks` + `BiasedLocking::preserve/restore` 的跨子系统交互 → 必须展示 mark word 被 marking 覆盖后被保存+恢复的完整路径
- ❌ 不做 OOM 串行 Fallback 分析 → 必须展示 `has_freed_regions` 检查 + `prepare_serial_compaction` + `serial_compaction` 的降级路径
- ❌ 不做 Full GC 与 Young GC / Mixed GC 的策略对比 → 必须展示 Evacuation vs Compaction 的 7 维度对比表
- ❌ 不展示 `satisfy_failed_allocation` 的 3 次重试逻辑 → 必须展示每次调用 `satisfy_failed_allocation_helper` 的 `clear_all_soft_refs` 参数递进
- ❌ 没有 Mermaid 泳道图 → 必须新增 §一 的 6-lane Mermaid 4 阶段全景图
- ❌ 没有 Beginner callout ≥7 → 必须包含 §一 中指定的所有 7 个 callout
- ❌ 忘记 `resize_if_necessary_after_full_collection` 的堆大小动态调整 → 必须展示 MinHeapFreeRatio/MaxHeapFreeRatio 驱动 expand/shrink
- ❌ 不要写成 G1 教程或 GC 入门 — 这是工程级源码分析文档
- ❌ 不要解释 C++ 基础语法或 HotSpot 通用框架（如 JVM_ENTRY/oop 模型已在 01-02 + 01-09 覆盖）

---

## §九 Required（≥8）

- ✅ **★ Mermaid 4 阶段泳道图** — 6 lanes: Java Threads / VM Thread / G1FullCollector / Workers × N / CompactionPoint × N / Heap Memory — 完整展示从 safepoint sync 到 heap resize 的全流程
- ✅ **★ 4 种触发路径完整分析** — Allocation Failure (3 次重试) + Concurrent Mode Failure + System.gc() + Metadata GC — 含 GCCause + 入口 file:line
- ✅ **★ mark_object 源码展示** — g1FullGCMarker.inline.hpp:40-75 — CAS bitmap 标记 + must_be_preserved + StringDedup enqueue 完整代码流程
- ✅ **★ forward 算法源码展示** — g1FullGCCompactionPoint.cpp:97-127 — forward_to + object_will_fit + switch_region + init_mark_raw 完整逻辑含注释
- ✅ **★ adjust_pointer 源码展示** — g1FullGCOopClosures.inline.hpp:63-90 — forwardee → RawAccess::oop_store 完整 inline 代码
- ✅ **★ compact_region 源码展示** — g1FullGCCompactTask.cpp:81-110 — destination=forwardee → Copy::aligned_conjoint_words → init_mark_raw → bitmap clear 流程
- ✅ **★ Evacuation vs Compaction 7 维度对比表** — 对象移动/空间需求/暂停时间/碎片处理/标记方式/引用更新/并行策略
- ✅ **★ 7 Beginner Callout 框** — exact text from §一: STW vs Concurrent, Bitmap-Based Marking, Forwarding Pointer, Slide Compaction vs Evacuation, Concurrent Mode Failure, OOM Serial Fallback, Heap Resize
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事：Concurrent Mode Failure → prepare → 4 phases → complete → heap resize
- ✅ **★ GDB 断点 ≥7 条** — 精确到 file:line，每断点有预期变量值，覆盖 VM_G1CollectFull→collect→mark→forward→adjust→compact→restore
- ✅ **★ Cross-Reference 表** — 01-02 (Heap Startup) + 01-09 (Marking Infra) + 30-01 (Young GC) + 30-02 (Concurrent Mark) + 30-03 (Mixed GC) — 5 个交叉引用
- ✅ **★ 跨子系统交互完整覆盖** — BiasedLocking::preserve→PreservedMarksSet→restore + CodeCache::gc_prologue→gc_epilogue + JvmtiExport::gc_epilogue

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: VM_G1CollectFull 入口 — 验证 Full GC cause (vm_operations_g1.cpp:37)
  (gdb) break vm_operations_g1.cpp:37
  (gdb) run
  (gdb) print _gc_cause → 期望: GCCause object (例如 _g1_concurrent_marking_failure)
  (gdb) print g1h->_gc_cause → 期望: 与 _gc_cause 相同
  (gdb) continue → 进入 do_full_collection
  (gdb) print explicit_gc → 期望: false (System.gc() 为 true)

断言 2: collect() 入口 — 验证 4 阶段开始 (g1FullCollector.cpp:173)
  (gdb) break g1FullCollector.cpp:173
  (gdb) print collector->_num_workers → 期望: >=1 (并行度)
  (gdb) print collector->_markers[0] → 期望: 非 NULL G1FullGCMarker 指针
  (gdb) print collector->_compaction_points[0] → 期望: 非 NULL CompactionPoint 指针
  (gdb) print collector->_scope->is_explicit_gc() → 期望: true/false
  (gdb) print collector->_scope->should_clear_soft_refs() → 期望: true/false

断言 3: mark_object — 验证 CAS bitmap 标记 (g1FullGCMarker.inline.hpp:40)
  (gdb) break g1FullGCMarker.inline.hpp:40
  (gdb) print obj → 期望: 有效的 oop (非 NULL)
  (gdb) print obj->klass()->name() → 期望: 对象类的名称
  (gdb) continue → 进入 par_mark
  (gdb) print _bitmap->par_mark(obj) → 期望: true (首次标记) 或 false (已标记)
  (gdb) print mark->must_be_preserved(obj) → 期望: true (biased lock) 或 false (正常对象)
  (gdb) print _preserved_stack->size() → 期望: ≥0 (preserve 次数)

断言 4: forward — 验证 forwarding pointer (g1FullGCCompactionPoint.cpp:97)
  (gdb) break g1FullGCCompactionPoint.cpp:97
  (gdb) print object → 期望: 有效的 oop (phase 2 is processing)
  (gdb) print size → 期望: >0 (对象字节数)
  (gdb) print _compaction_top → 期望: 当前 region 内的地址偏移
  (gdb) print _current_region → 期望: 非 NULL
  (gdb) continue 经过 forward_to
  (gdb) print object->forwardee() → 期望: 非 NULL (已设置 forwarding pointer)
  (gdb) print _compaction_top → 期望: 原值 + size (线性推进)

断言 5: adjust_pointer — 验证 oop_store (g1FullGCOopClosures.inline.hpp:63)
  (gdb) break g1FullGCOopClosures.inline.hpp:63
  (gdb) print p → 期望: oop* 或 narrowOop* 指针 (指向堆中的引用)
  (gdb) print RawAccess<>::oop_load(p) → 期望: 原始 oop 值 (调整前)
  (gdb) continue 进入 forwardee
  (gdb) print obj → 期望: 从 p 加载的 oop
  (gdb) print obj->forwardee() → 期望: 非 NULL (forwarding pointer 已设置)
  (gdb) continue 经过 oop_store
  (gdb) print RawAccess<>::oop_load(p) → 期望: forwardee 的值 (已更新为新地址)

断言 6: compact_region — 验证物理移动 (g1FullGCCompactTask.cpp:74)
  (gdb) break g1FullGCCompactTask.cpp:74
  (gdb) print obj_addr → 期望: 对象原始物理地址
  (gdb) print destination → 期望: obj->forwardee() 返回的地址
  (gdb) print size → 期望: >0
  (gdb) print (destination < obj_addr) → 期望: true (slide compaction 向前移动)
  (gdb) continue 经过 Copy::aligned_conjoint_words
  (gdb) print *(HeapWord*)destination → 期望: 与原始 *(HeapWord*)obj_addr 相同 (数据已复制)
  (gdb) print obj->mark_raw() → 期望: prototype 值 (已清除 forwarding pointer)

断言 7: restore_marks — 验证 BiasedLocking 恢复 (g1FullCollector.cpp:224)
  (gdb) break g1FullCollector.cpp:224
  (gdb) print _preserved_marks_set.size() → 期望: ≥0 (preserved marks 数量)
  (gdb) continue 经过 BiasedLocking::restore_marks
  (gdb) print _preserved_marks_set.size() → 期望: 0 (所有 mark 已恢复)
  (gdb) print _heap->used() → 期望: < 压缩前的 used (已回收空间)

断言 8: complete_collection — 验证 heap resize (g1FullCollector.cpp:230)
  (gdb) break g1FullCollector.cpp:230
  (gdb) print _heap->capacity() → 期望: 调整后容量
  (gdb) print _heap->used() → 期望: 压缩后的实际使用量
  (gdb) print _heap->used() / (double)_heap->capacity() → 期望: 在 MinHeapFreeRatio ~ MaxHeapFreeRatio 之间
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §二.4 承接**：本文展开 §二.4 的 "Full GC — Last Resort" 问题——从 Concurrent Mode Failure 触发到 Copy::aligned_conjoint_words 完成压缩的完整代码级解答。

2. **同组边界**：
   - `prompt-00` 覆盖 HeapRegion 运行时 + Allocation + Barrier + Card Table + Free List
   - `prompt-01` 覆盖 Young GC Evacuation（本文的对比参照）
   - `prompt-02` 覆盖 Concurrent Marking Lifecycle（本文的失败场景）
   - `prompt-03` 覆盖 Mixed GC + Policy Decision Engine（本文的前一阶段——Mixed GC 失败后进入 Full GC）
   - **prompt-04（本文）** 覆盖 Full GC 的 4 阶段完整流程 + 4 种触发条件 + 跨子系统交互

3. **与已有 Phase 01 文档的衔接**：
   - 本文的 `G1FullCollector` 使用 `G1CollectedHeap`（已在 01-02 初始化）
   - 本文的 `G1FullGCMarker::_bitmap` 使用与 `G1ConcurrentMark::_prevMarkBitMap` 相同的 `G1CMBitMap` 类型（已在 01-09 介绍）
   - 本文的 `do_full_collection` 调用 `g1_policy()->record_full_collection_end()` 更新已在 01-08 初始化的 G1Policy 状态

4. **全部文档共享 §一 开头语**："Reader completed 01-02-G1-Heap-Startup (G1CollectedHeap 构造 18 步)、01-08-G1-Policy-Analytics (G1Policy 8 子组件初始化)、01-09-G1-Concurrent-Marking-Infra (双缓冲 Bitmap + CMTask)。This doc: how G1's Last Resort safety net works — from Concurrent Mode Failure to Copy::aligned_conjoint_words."
