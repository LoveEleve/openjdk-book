# PROMPT: 请撰写 00-Core-Containers-Concurrent.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**场景 1: StringTable safepoint 膨胀**

`# Internal Error (safepoint.cpp:919), pid=12345, tid=12346` — Java application freezes 8 seconds during String.intern() under load.

Root cause: StringTable 底层用 `RehashableHashtable<oop, mtSymbol>` (`hashtable.hpp:246`), bucket 链过深(>60× 平均)触发 rehash → 整个 StringTable 在 safepoint 重建 → 有 2M interned strings 时耗时 ~5-8 秒。ConcurrentHashTable (`concurrentHashTable.hpp:35`) 的 grow/shrink 是分桶进行的(bucket-level locking)，不阻塞读者也不需要全局 safepoint——理论上可以对 StringTable 做类似改进。

**场景 2: JIT Compiler Arena 溢出**

C2 compiler crash: `# Internal Error (growableArray.hpp:583), pid=23456, tid=23457` — `GrowableArray<Phase*>::append()` 在 C2 编译巨型方法时触发了 `grow()`，但 C2 用的是 Arena 分配的 GrowableArray (`growableArray.hpp:191`)，Arena 内的数据会随 `ResourceMark` 释放。如果 ResourceMark 在编译中途销毁了 Arena 而 GrowableArray 还持有指针 → use-after-free。

**三步诊断**：

```bash
# 1. 查看当前 StringTable 统计
jcmd <pid> VM.stringtable -verbose
# 输出: Number of buckets: 65536, Number of entries: 2500000, Avg bucket size: 38.1

# 2. 检查 safepoint 级别的 rehash
rg "rehash_table" hs_err_pid12345.log
# 看到 StringTable::rehash_table() 触发了 safepoint 级别的全表重建

# 3. GDB 验证 bucket 链深度
gdb -ex "break hashtable.cpp:107" \
    -ex "run" \
    -ex "print count" \
    -ex "print this->number_of_entries()" \
    -ex "print this->table_size()" \
    --args java -XX:+PrintStringTableStatistics -jar app.jar
```

**反事实**: 如果 StringTable 用 ConcurrentHashTable（CAS insert + RCU lookup）而不是 Hashtable → intern() 永远不需要全局 safepoint → 2M entry 的 grow 操作只需 3ms（分桶迁移不阻塞读者）→ 但代价是 String 引用死亡判断需要 GlobalCounter::write_synchronize()（等待所有读者离开临界区，~10µs per delete）。

---

## §一 Task + Narrative + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the CORE CONTAINERS AND CONCURRENT DATA STRUCTURES that underpin the entire HotSpot JVM. These are NOT general-purpose collections — they are JVM-specific containers designed around HotSpot's unique constraints: safepoint/GC interaction, multiple allocation arenas (C_HEAP/Arena/ResourceArea), Handle/oop lifetime management, and concurrent access patterns in the string/symbol/method tables.

Reader completed **03-object-model** (oop, Klass, Handle), **06-GC-shared** (GC threads, safepoints), **15-core-native** (native entry/exit). This doc: **how JVM's own container library is designed** — from the 2× doubling of GrowableArray to the CAS-based lock-free insert of ConcurrentHashTable.

### Interview Story Format Answer（必须出现在 §一 末尾）

"HotSpot doesn't use STL. Instead it implements its own container library in `src/hotspot/share/utilities/`. The most fundamental is GrowableArray — a dynamic array with three allocation backends: ResourceArea (fast, scoped), Arena (custom lifetime), and C_HEAP (permanent). It doubles capacity on overflow (amortized O(1) append), and `at_grow(i, fill)` fills uninitialized gaps — key for compiler phase tables where phases are inserted out-of-order. The Hashtable hierarchy (BasicHashtable → Hashtable → RehashableHashtable) uses fixed bucket arrays with singly-linked chains; entries are allocated in blocks (power-of-2 sized to reduce allocation overhead) and recycled via a free list. Rehash triggers when any bucket exceeds 60× the average — at safepoint, all entries move to a new table with alternate hashing to mitigate hash-collision attacks. The ConcurrentHashTable is a newer design: each bucket's first pointer embeds a spinlock (bit 0) and redirect marker (bit 1) in its two low bits, allowing lock-free readers and bucket-granularity writers. Insert uses CAS on the bucket head (lock-free), delete locks the bucket then calls GlobalCounter::write_synchronize() to wait for readers to drain. Grow splits each bucket into even/odd halves in a new 2× table; bucket-by-bucket lock + redirect ensures readers follow to the new table. GlobalCounter is a degraded RCU — only guarantees write-side grace periods, doesn't protect data from being freed. SingleWriterSynchronizer provides version-based synchronization using dual exit counters with polarity flipping. BitMap uses uintptr_t words with template allocators (Resource/Arena/CHeap) for compact heap region marking. Stack links segments with a pointer field after the array, caching freed segments to avoid malloc/free ping-ponging. All class hierarchy is in `make/hotspot/lib/CompileJvm.gmk:153` — utilities compile into libjvm.so."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **ResourceObj vs CHeapObj vs ArenaObj**: `ResourceObj` = allocated in ResourceArea, freed at ResourceMark scope exit. `CHeapObj<F>` = allocated with NEW_C_HEAP_ARRAY / AllocateHeap, managed by NMT (Native Memory Tracking) with MEMFLAGS `F`. `Arena` = custom allocation lifetime, freed when Arena is destroyed. GrowableArray uses all three: `new GrowableArray<T>(10)` → ResourceArea, `new GrowableArray<T>(10, true, mtGC)` → C_HEAP, `new(arena) GrowableArray<T>(10, 0, filler)` → Arena. Source: `growableArray.hpp:108-149`.

2. **Handle Safety**: Handles are oop references that stay valid only within their HandleMark scope. GrowableArray<Handle> is dangerous because the GrowableArray may outlive the HandleMark. `growableArray.hpp:42-65` has a multi-line WARNING comment demonstrating the bug. Never store Handle in C_HEAP GrowableArrays.

3. **Arena vs Store Allocation**: `_arena == NULL` → ResourceArea (scoped by ResourceMark), `_arena == (Arena*)1` → C_HEAP (permanent until explicit free), `_arena > (Arena*)1` → custom Arena. This 3-way dispatch is in `GenericGrowableArray::raw_allocate()` at `growableArray.cpp:49-58`. The `on_stack()` / `on_C_heap()` / `on_arena()` predicates at `growableArray.hpp:102-104` encode this convention.

4. **Bucket Embedded State**: ConcurrentHashTable packs two bits into bucket's `_first` pointer: bit 0 = LOCK_BIT (bucket is being mutated), bit 1 = REDIRECT_BIT (bucket has been moved to a new table). This is safe because Node pointers are 4-byte aligned (16-bit aligned on assertions: `concurrentHashTable.hpp:48`). Readers strip the state bits with `clear_state()` (`concurrentHashTable.inline.hpp:108`), writers use `trylock()` CAS (`concurrentHashTable.inline.hpp:155-167`). Source: `concurrentHashTable.hpp:87-88`.

5. **GlobalCounter as Degraded RCU**: Unlike Linux kernel RCU which protects data from being freed while readers hold references, HotSpot's GlobalCounter only guarantees write-side ordering. Readers call `critical_section_begin()` which stores a generation number with ACTIVE bit, and `critical_section_end()` clears it. `write_synchronize()` increments the global counter and spins on all threads until they have moved past the old generation. This is sufficient for ConcurrentHashTable node deletion but NOT for protecting arbitrary data structures from use-after-free. Source: `globalCounter.cpp:60-73`.

6. **Placement New in Templates**: GrowableArray uses placement `::new ((void*)&_data[i]) E()` to construct elements in pre-allocated memory. This bypasses the default allocation path. In `grow()` (`growableArray.hpp:452-458`), old elements are copy-constructed to new array, then destructed with `_data[i].~E()`. This pattern is essential because the element type E might be a complex type (e.g. oop, Handle) that requires proper construction/destruction.

7. **memset in BitMap**: `set_large_range_of_words()` uses `memset(beg, ~0, len)` for full-word bulk set — ~5× faster than per-word loop due to CPU-level SIMD streaming stores. `clear_large_range_of_words()` similarly uses `memset(beg, 0, len)`. The threshold to switch from loop to memset is `small_range_words = 32` words (`bitMap.hpp:67`). Source: `bitMap.inline.hpp:306-313`.

---

## §二 Standard Environment

OpenJDK 11, 64-bit Linux, slowdebug build.

Source roots:
- `src/hotspot/share/utilities/` — 21 source files covering containers + concurrent

Build: `make hotspot`

Key binary: `build/linux-x86_64-normal-server-slowdebug/hotspot/lib/server/libjvm.so` — all utilities compile into libjvm.so via `make/hotspot/lib/CompileJvm.gmk:153`

Allocation API reference:
- `src/hotspot/share/memory/allocation.hpp` — ResourceObj/CHeapObj/Arena/AllocateHeap/FreeHeap
- `src/hotspot/share/memory/allocation.inline.hpp` — inline helpers
- `src/hotspot/share/memory/resourceArea.hpp` — ResourceMark/ResourceArea
- `src/hotspot/share/runtime/atomic.hpp` — Atomic::cmpxchg/add/load/store
- `src/hotspot/share/runtime/orderAccess.hpp` — OrderAccess::load_acquire/release_store/fence

Syscall table (containers don't directly syscall; allocations use):
| Syscall | man | Used by | Purpose |
|---------|-----|---------|---------|
| `mmap(2)` | `man 2 mmap` | `os::reserve_memory` | Arena backing store (large allocations) |
| `malloc(3)` | `man 3 malloc` | `AllocateHeap` | CHeap backing store |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Contents | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **growableArray.hpp** | `src/hotspot/share/utilities/growableArray.hpp` | 583 | GenericGrowableArray (:79-150), GrowableArray<E> (:155-441), grow() (:445-464), at_grow() (:283-293), clear_and_deallocate() (:479-488), Iterator (:499-575) | 最常用容器 — 4700+ 引用站点 |
| 2 | **growableArray.cpp** | `src/hotspot/share/utilities/growableArray.cpp` | 64 | set_nesting() (:32-36), check_nesting() (:38-47), raw_allocate() (:49-58) | 分配器三路分发 |
| 3 | **hashtable.hpp** | `src/hotspot/share/utilities/hashtable.hpp` | 323 | BasicHashtableEntry<F> (:44-96), HashtableEntry<T,F> (:100-117), HashtableBucket<F> (:121-139), BasicHashtable<F> (:142-243), Hashtable<T,F> (:246-286), RehashableHashtable (:288-320) | SymbolTable/StringTable 基类 |
| 4 | **hashtable.cpp** | `src/hotspot/share/utilities/hashtable.cpp` | 485 | new_entry() (:59-78), resize() (:269-311), move_to() (:120-159), check_rehash_table() (:106-114), bulk_free_entries() (:181-200), print_table_statistics() (:322-359) | rehash 分发 + CDS 序列化 |
| 5 | **hashtable.inline.hpp** | `src/hotspot/share/utilities/hashtable.inline.hpp` | 112 | constructors (:39-55), bucket get/set entry with acquire/release (:71-91), add_entry (:99-103), free_entry (:105-109) | 内联关键路径 |
| 6 | **concurrentHashTable.hpp** | `src/hotspot/share/utilities/concurrentHashTable.hpp` | 535 | Node (:41-68), Bucket embedded state (:73-161), InternalTable (:168-185), ScopedCS (:246-253), resize control (:207-224), public API (:370-531) | 无锁并发哈希 |
| 7 | **concurrentHashTable.inline.hpp** | `src/hotspot/share/utilities/concurrentHashTable.inline.hpp` | 1287 | Bucket trylock/unlock/redirect (:108-185), get_node (:621-645), internal_insert (CAS) (:877-942), internal_remove (:458-488), grow/shrink (:419-853), write_synchonize_on_visible_epoch (:300-314) | 核心并发算法 |
| 8 | **concurrentHashTableTasks.inline.hpp** | `src/hotspot/share/utilities/concurrentHashTableTasks.inline.hpp` | 203 | BucketsOperation (:36-116), BulkDeleteTask (:119-161), GrowTask (:163-200), claim() (:55-63) | 并行任务框架 |
| 9 | **linkedlist.hpp** | `src/hotspot/share/utilities/linkedlist.hpp` | 422 | LinkedListNode<E> (:38-54), LinkedList<E> 抽象接口 (:59-111), LinkedListImpl<E,T,F> (:113-332), SortedLinkedList (:334-399), LinkedListIterator (:401-419) | 通用双向链表 |
| 10 | **stack.hpp** | `src/hotspot/share/utilities/stack.hpp` | 215 | StackBase<F> (:58-86), Stack<E,F> (:92-166), ResourceStack (:167-186), StackIterator (:188-208) | 分段链式栈 |
| 11 | **stack.inline.hpp** | `src/hotspot/share/utilities/stack.inline.hpp` | 277 | push/pop (:61-81), push_segment/pop_segment (:152-191), segment layout (link stored after array) (:103-132), ResourceStack alloc/free (:243-251) | 栈操作实现 |
| 12 | **bitMap.hpp** | `src/hotspot/share/utilities/bitMap.hpp` | 443 | BitMap base (:48-306), BitMapView (:311-315), ResourceBitMap (:318-341), ArenaBitMap (:344-351), CHeapBitMap (:353-386), BitMap2D (:388-431) | 三层分配器阶梯 |
| 13 | **bitMap.cpp** | `src/hotspot/share/utilities/bitMap.cpp` | 703 | Allocator templates (Resource/Arena/CHeap:38-174), range operations (set/clear/large:192-394), set operations (union/difference/intersection:447-556), count_one_bits(:668-680) | 位运算 + 分配器 |
| 14 | **bitMap.inline.hpp** | `src/hotspot/share/utilities/bitMap.inline.hpp` | 358 | set_bit/clear_bit/par_set_bit/par_clear_bit (:31-77), get_next_one_offset/get_next_zero_offset (:144-287), large range memset (:306-313), BitMap2D (:322-355) | 内联位操作 |
| 15 | **globalCounter.hpp** | `src/hotspot/share/utilities/globalCounter.hpp` | 83 | PaddedCounter (:47-51), API (:65-76), COUNTER_ACTIVE/INCREMENT常量 (:57-59) | 退化 RCU |
| 16 | **globalCounter.cpp** | `src/hotspot/share/utilities/globalCounter.cpp` | 74 | CounterThreadCheck (:36-58), write_synchronize() (:60-73) | 线程迭代等待逻辑 |
| 17 | **globalCounter.inline.hpp** | `src/hotspot/share/utilities/globalCounter.inline.hpp` | 60 | critical_section_begin/end (:32-45), CriticalSection RAII (:47-57) | 读端关键路径 |
| 18 | **singleWriterSynchronizer.hpp** | `src/hotspot/share/utilities/singleWriterSynchronizer.hpp` | 123 | enter() (:91-93), exit() (:95-103), synchronize() 声明 (:85), CriticalSection RAII (:105-120) | 单写者同步器 |
| 19 | **singleWriterSynchronizer.cpp** | `src/hotspot/share/utilities/singleWriterSynchronizer.cpp` | 101 | Constructor (:33-41), synchronize() 5-step (:45-100) | 版本翻转 + semaphore |
| 20 | **resourceHash.hpp** | `src/hotspot/share/utilities/resourceHash.hpp` | 180 | ResourceHashtable<K,V,HASH,EQUALS,SIZE,ALLOC_TYPE,MEM_TYPE> (:56-176), Node (:59-68), lookup_node/get/put/remove (:74-153), iterate (:160-171) | Resource 域小型哈希 |
| 21 | **pair.hpp** | `src/hotspot/share/utilities/pair.hpp` | 42 | Pair<T,V,ALLOC_BASE> (:30-38) | 值对 |

---

## §四 Deep Dive Question Groups（≥6 组，EXACT questions + answer directions 含 counterfactual）

### 4.1 ★★★ GrowableArray 三层分配器架构与 growth 策略

```
问题：
  ① GenericGrowableArray 如何通过 _arena 字段实现三种分配策略的隐式分发？
      答案方向: _arena == NULL → on_stack() true → ResourceArea (ResourceMark scoped)
      _arena == (Arena*)1 → on_C_heap() true → AllocateHeap(byte_size, _memflags)
      _arena > (Arena*)1 → on_arena() true → _arena->Amalloc(byte_size)
      源码 (growableArray.cpp:49-58): raw_allocate() 用 if-else-if 分发。
      
      GrowableArray 构造函数选择:
      - GrowableArray(Thread* thread, int size) → GenericGrowableArray(size, 0, false) → _arena=NULL
      - GrowableArray(int size, bool C_heap, MEMFLAGS F) → GenericGrowableArray(size, 0, C_heap, F)
      - GrowableArray(Arena* arena, int size, int len, const E& filler) → GenericGrowableArray(arena, size, len)
      
      追问: 为什么用 (Arena*)1 作为 C_HEAP 哨兵而非 enum？
      → 省一个字段。enum 需要额外 int 字段，但 _arena 字段本身就需要——复用它能避免内存膨胀。
      同时 (Arena*)1 是非对齐地址的哨兵——libc malloc 返回的指针始终满足对齐要求，
      所以 (Arena*)1 永远不会是有效的 Arena 地址。这是一个利用平台保证的空间优化。

  ② Counterfactual: 如果 GrowableArray 统一用 C_HEAP 分配（没有 Arena/ResourceArea 选项）？
      答案方向: C2 编译器每方法编译产生数百个临时 GrowableArray<Phase*>。
      如果每个都是 malloc → 每方法 ~500 malloc + 500 free → 1000 syscall 级别操作。
      用 ResourceArea → 所有临时 GrowableArray 从线程本地 Arena 分配 → 0 次 malloc。
      编译结束后 ResourceMark 析构一次性释放全部 Arena 内存。实测差异:
      - C_HEAP: ~5ms per method malloc overhead
      - ResourceArea: ~0.1ms per method (bump-pointer allocation)
      ~50× 加速，对于编译 5000 方法的大型项目 (如 Spring)，差异是 25s vs 0.5s。
```

### 4.2 ★★★ Hashtable 的块分配与 free_list 循环

```
问题：
  ① new_entry() 如何用块分配（block allocation）减少 malloc 调用？
      答案方向: 每次 new_entry() 先尝试 _free_list（recycled entries 链表）。
      如果 free_list 空 → 检查 block 空间 (_first_free_entry + _entry_size >= _end_block?)。
      如果不够 → 分配新 block (hashtable.cpp:63-69):
        block_size = MIN2(512, MAX2(table_size/2, number_of_entries))
        长度 = _entry_size * block_size，round down to power of 2
        用 NEW_C_HEAP_ARRAY2(char, len, F) 分配
      然后从 block 中切割一个 entry 返回。
      
      追问: 为什么 block_size 计算用 MIN2(512, MAX2(table_size/2, number_of_entries))?
      → 512 是上限（防止一次分配过多内存），table_size/2 是下限（每个桶平均至少半个 entry），
        number_of_entries 当表已有大量 entry 时作为基线。这个启发式在 JVM 启动（表小）时
        分配小 block (~32 entries)，在大表增长时分配更大 block (~256 entries)，
        平衡内存使用和分配频率。

  ② Counterfactual: 如果每个 entry 都单独 malloc（不做块分配）？
      答案方向: SymbolTable ~50K entries → 50K malloc → 每个 malloc 64B + header ~16B = 80B
      → 50K × 80B = 4MB。块分配: 512 entries per block → ~98 blocks → 98 malloc → 
      98 × (512 × 16B + header) → ~0.8MB overhead。块分配还改善了缓存局部性——同 block
      的 entries 在物理内存中连续，bucket 链遍历有预取效应（~20% faster lookup）。
```

### 4.3 ★★★ ConcurrentHashTable 的 Bucket 嵌入式状态与 CAS 插入

```
问题：
  ① Bucket 的 3 态 FSM (unlocked → locked → unlock/redirect) 如何实现 wait-free 读者 + lock-free 写入者？
      答案方向: 每个 bucket 的 _first 指针低 2 位编码状态:
        STATE_LOCK_BIT = 0x1, STATE_REDIRECT_BIT = 0x2
      - trylock() (concurrentHashTable.inline.hpp:155-167): CAS(lock_bit_set, &_first, current_first)
      - lock() (concurrentHashTable.inline.hpp:109-124): spin on trylock(), 8192 次 SpinPause 后 naked_yield
      - unlock(): release_store(&_first, clear_state(first()))
      - redirect(): release_store(&_first, set_state(_first, STATE_REDIRECT_BIT))
      
      读者路径 (get_node): 只通过 first() = clear_state(load_acquire(&_first)) 读指针，
      不检查锁状态——读者完全 wait-free，不因写入者而阻塞。
      
      插入 (internal_insert, hashtable.inline.hpp:877-942):
      1. ScopedCS 保护表不被 resize 销毁
      2. 查找是否已存在 → 如果存在返回 old value
      3. 如果不存在 → Node::create_node → cas_first(new_node, first_at_start)
         → 成功: 直接插入（lock free！）
         → 失败: 另一个线程竞态插入成功 → 释放 node，重新查找
      
      追问: 为什么 Bucket trylock 不尊重 redirect？
      → 注释明确 (hashtable.hpp:78-84): lock() 不检查 redirect，调用者必须先获得 _resize_lock。
      只有 resize 逻辑（拥有 _resize_lock）才会 lock 然后 redirect。这是分层锁定的经典模式。

  ② Counterfactual: 如果 ConcurrentHashTable 用全局锁替代 bucket 锁？
      答案方向: 读操作（get）hot path 可达到每秒百万次（String dedup 检查）。
      全局锁意味着每次 get 都 acquire/release → 在 64 核机器上，每次查找 ~500ns (cache coherency)。
      bucket-level 嵌入状态方案 → get 只需 load_acquire → ~5ns per lookup。
      差异 100×。在高频读场景下，bucket 嵌入状态是必须的——它把同步成本从
      "每次访问"降为"每次写入"（而且写入还只是影响同一 bucket 的写入者）。
```

### 4.4 ★★★ GlobalCounter — 退化 RCU 的设计限制

```
问题：
  ① GlobalCounter::write_synchronize() 如何确保所有读者离开了临界区？
      答案方向: 三步(globalCounter.cpp:60-73):
      1. Atomic::add(COUNTER_INCREMENT=2, &_global_counter._counter) → 得到新 counter 值 gbl_cnt
      2. 遍历所有 JavaThread + NonJavaThread（CounterThreadCheck），每个线程:
         while ((cnt & COUNTER_ACTIVE) && (cnt - gbl_cnt) > (max_uintx/2))
           yield.wait()  // 线程还在旧 generation 中，等待
      3. 返回时保证所有线程都已进入 ≥ gbl_cnt 的 generation
      
      关键判断: cnt - gbl_cnt > max_uintx/2 用无符号整数环绕处理——如果线程的 counter
      远小于 gbl_cnt（差超过 max_uintx/2），说明线程还在旧 generation 中。
      
      追问: 为什么不做真正的 RCU（call_rcu callback 延迟释放）？
      → HotSpot 的 GlobalCounter 简化了内核 RCU——不需要后台 thread (rcu_kthread)
      来执行延迟释放。牺牲了"读者保护数据不被释放"的保证，换来了简单的实现（~74 lines）。
      ConcurrentHashTable 的 delete 先 unlink node from bucket，然后 write_synchronize 等待
      所有读者离开才 destruct node——手动时序化释放，不需要自动化的 callback 机制。

  ② Counterfactual: 如果 GlobalCounter 实现完整 RCU（像 Linux 内核）？
      答案方向: 需要 per-CPU thread state tracking + 后台 grace period 线程 + call_rcu callback 队列。
      实现增长到 ~500 lines。HotSpot 的退化版本只有 ~74 行——够用且简单。
      退化 RCU 的 gap: 如果对象被从链表取下但 reader 还持有一个局部指针 → use-after-free。
      ConcurrentHashTable 通过 write_synchronize 在 node 删除前等待所有读者来避免这种情况——
      虽然 GlobalCounter 自身不保护数据，但删除方必须手动配合 wait。
      如果忘记调用 write_synchronize → bug。这种"手册化"比 callback 更容易出错但更轻量。
```

### 4.5 ★★★ SingleWriterSynchronizer — 版本翻转 vs GlobalCounter

```
问题：
  ① SingleWriterSynchronizer::synchronize() 的双版本翻转（polarity flip）如何实现？
      答案方向: 5 步算法 (singleWriterSynchronizer.cpp:45-100):
      1. 读 _enter 当前值（包含 polarity bit 0）
      2. 初始化新 exit counter: _exit[(old + 1) & 1] = old + 1
      3. CAS 翻转 _enter: CAS(value+1, &_enter, old)
         → 成功: 新 reader 将用新 polarity，旧 readers 继续用旧 polarity
      4. 设置 _waiting_for = old 并 fence → 等待 _exit[old & 1] == old
         → 循环 semaphore wait 直到匹配
      5. 排空 semaphore 中的 spurious wakeups
      
      enter() 和 exit() 的实现 (singleWriterSynchronizer.hpp:91-103):
      - enter(): Atomic::add(2u, &_enter) — 偶数值，bit 0 是 polarity
      - exit(): Atomic::add(2u, &_exit[enter_value & 1]) — 用 polarity 选 exit counter
        如果 _exit 值 == _waiting_for → 发送 signal
      
      追问: 与 GlobalCounter 相比，SingleWriterSynchronizer 有什么用？
      → SWS 支持嵌套（nested critical sections），GlobalCounter 不支持 (assert 检查)。
      SWS 用 semaphore 等待（可能 slow path），GlobalCounter 用 spin-wait（fast path）。
      SWS 单写者约束（同时只有一个 synchronize）限制其使用场景。

  ② Counterfactual: 如果 SingleWriterSynchronizer 只用单版本（无 polarity flip）？
      答案方向: 单版本意味着 writer 等待所有 enter() 调用退出。但 enter() 是永续的——
      在等待过程中新的 enter() 不断增加。→ 永不终止的 wait。双版本翻转创建了
      "关闭进入"的边界：旧 polarity 的 enter()s 会逐渐退出被耗尽，新 polarity 的 enter()s
      属于下一轮同步，不受本轮 wait 影响。这是一个标准的 RCU 式 quiescent state 设计。
```

### 4.6 ★★★ BitMap 三层阶梯 — 分配器模板 vs 继承层次

```
问题：
  ① BitMap 为什么用模板分配器（template <class Allocator>）+ 继承子类而非虚函数？
      答案方向: 注释明确 (bitMap.hpp:43-44): "Bitmap class doesn't use virtual calls —
      to ensure we don't get a vtable unnecessarily." 这意味着 BitMap 对象不携 vtable 指针
      → 每个 BitMap 省 8 字节（64bit）→ 堆中常有数十万个 BitMap（每个 Java 方法一个 BitMap
      用于 code cache marking）→ 省 MB 级内存。
      
      子类层次:
      - BitMap: 纯逻辑，不管理内存 (protected ctor/dtor，不能直接创建)
      - BitMapView: 对外部内存的非所有权引用
      - ResourceBitMap: 用 ResourceBitMapAllocator (resource_allocate_bytes)
      - ArenaBitMap: 用 ArenaBitMapAllocator (_arena->Amalloc)
      - CHeapBitMap: 用 CHeapBitMapAllocator (ArrayAllocator<bm_word_t>)
      每个子类包装自己的 Allocator 对象并调用基类的模板方法。
      
      Allocation policy pattern (bitMap.cpp:38-72):
      - ResourceBitMapAllocator: allocate()=NEW_RESOURCE_ARRAY, free()=nop
      - CHeapBitMapAllocator: allocate()=ArrayAllocator::allocate, free()=ArrayAllocator::free
      - ArenaBitMapAllocator: allocate()=_arena->Amalloc, free()=nop
      
      追问: set_large_range_of_words 为什么用 memset 替代循环？
      → memset 在 glibc 实现中检测到对齐的大块后切换到 SIMD stores (x86: rep stosq, ~4B/s)。
      Loop 版本每次 store 一行，还需要回路跳转→对 ~1000 字(8KB) 范围有 ~5× 差异。

  ② Counterfactual: 如果 BitMap 用 STL 的 vector<bool>？
      答案方向: vector<bool> 用 per-bit bitfield → 1 bit = 1 bool → 内存紧凑。但
      - 无 par_set/par_clear CAS 原子操作支持
      - 无 set_union/set_intersection 集合操作
      - 无 get_next_one_offset/get_next_zero_offset 快速扫描
      - 无法选择分配策略（ResourceArea vs Arena vs CHeap）
      BitMap 的 API 是专门为 GC 标记位图 + 代码缓存管理设计的——
      这些是 vector<bool> 完全不提供的功能。而且 vector<bool> 的 iterator 不是 RandomAccessIterator
      → 不能传递给需要 & 迭代器的算法。BitMap 绕过了这些 C++ STL 限制。
```

### 4.7 ★★★ Stack 的段缓存 — 避免 malloc/free 乒乓效应

```
问题：
  ① Stack 的 _cache 字段如何实现 segment 复用？
      答案方向: 每个 segment 是 "E[_seg_size] + E* link" 的布局。link 存在
      segment_bytes() = align_up(_seg_size * sizeof(E), sizeof(E*)) + sizeof(E*) 偏移处。
      
      push_segment (stack.inline.hpp:152-170):
      - 如果 _cache_size > 0: next = _cache, _cache = get_link(_cache), --_cache_size
      - 否则: alloc(segment_bytes())
      
      pop_segment (stack.inline.hpp:172-191):
      - 如果 _cache_size < _max_cache_size: 将当前 segment 挂入缓存链表
      - 否则: free(seg, segment_bytes())
      
      默认 max_cache_size = 4 (stack.hpp:108)，segment_size 从 4096 减去开销计算。
      
      追问: 为什么缓存 4 个 segment 而不是无限？
      → 4 = 乒乓效应深度——典型的 push/pop 波动不超过 4 个 segment。
      无限缓存 → 内存泄漏风险（物理内存被搁置的缓存消耗）。
      这个数字来自 GC 代码路径的 push/pop 模式经验——GC 扫描对象栈的深度波动
      典型地不超过 3-4 个 segment 的容量。

  ② Counterfactual: 如果 Stack 用连续数组（如 std::vector）而不用分段链表？
      答案方向: 栈最大深度可达 1M 元素（GC 标记栈）。连续数组需要一次分配 1M × sizeof(E)
      → 对 E=oop* (8 bytes) 是 8MB — 而且是 Arena 分配（不可能逐次增长）。
      分段链表允许伸缩而不要求连续内存——GC 的标记栈从 32 元素开始，随递归深度
      增长到需要的段数。避免了 "预留所有内存以防万一" 的问题。代价是
      pop 超过段边界时需要额外的指针追踪（但 pop_segment 只发生在 push/pop 完成时）。
```

### 4.8 ★★★ 并发 vs 非并发 — Hashtable vs ConcurrentHashTable 设计哲学对比

```
问题：
  ① 两种哈希表的并发模型根本差异是什么？
      答案方向: 
      Hashtable:
      - 写需 safepoint 或全局锁（Dictionary_lock 等）
      - 读可无锁（read-only）但 insert/remove 需要锁保护
      - bucket 链表可被 resize 打断—→需要全局 safepoint 重建
      - Entry 分配: 块分配 + free_list 循环, 删除只是回收到 free_list (不 free 内存)
      
      ConcurrentHashTable:
      - 读完全 wait-free（无需任何锁或 safepoint）
      - 写 bucket 粒度 (CAS insert + bucket lock for delete)
      - bucket redirect 允许并发 resize（读者自动跟随 redirect 到新表）
      - Node 分配: 每次 insert 独立 malloc/free（Node::create_node/destroy_node）
      - 删除: lock bucket, unlink, write_synchronize, destroy_node
      
      关键设计差异表:
      | 维度 | Hashtable | ConcurrentHashTable |
      |------|-----------|---------------------|
      | 并发读 | MT-safe (无锁) | Wait-free (无锁 + redirect) |
      | 并发写 | 需要全局锁 | Bucket 级 CAS/Lock |
      | Resize | safepoint 全表重建 | 分桶渐进迁移 |
      | Entry 分配 | 块分配 + free_list | per-node malloc |
      | 内存管理 | 不释放已分配 block | 删除时 free node |

  ② Counterfactual: 为什么 StringTable 和 SymbolTable 还是用 Hashtable 而非 ConcurrentHashTable？
      答案方向: StringTable 和 SymbolTable 是 JVM 启动早期就存在的代码（1997年）。
      Hashtable 的 insert 需要全局 safepoint → 对 String.intern() 高并发场景形成瓶颈。
      ConcurrentHashTable 是 2018 年才添加的——用于较新的子系统（如 nmethod 条目管理）。
      迁移 StringTable 到 ConcurrentHashTable 的技术风险:
      - StringTable 的 entry 不仅仅是哈希 — 它还有 weak reference + GC 清理逻辑
      - ConcurrentHashTable 的 node 删除需要 write_synchronize（所有线程离开临界区）→ 
        在 GC 线程中调用可能导致长时间等待（GC 不能阻塞其他线程）。
      - 块分配的 Hashtable 更适合 CDS（Class Data Sharing）序列化到共享归档
      所以设计差异不完全是"新旧代码"——是子系统需求决定的取舍。
```

---

## §五 Article Structure

```
§〇 生产场景 — StringTable safepoint 膨胀 + JIT Arena 溢出
  ★ 真实错误: safepoint 8 sec during StringTable rehash (Hashtable 桶深>60×)
  ★ 根源: RehashableHashtable::check_rehash_table() 触发 safepoint 全量迁移
  ★ 三步诊断: jcmd VM.stringtable → hs_err 日志检查 → GDB peek bucket depth
  ★ 反事实: ConcurrentHashTable 代替 Hashtable → 无全局 safepoint

§一 ★★★ 核心容器全链路源码走读 — 6 容器家族深度分析
  ❓ 这不是 API 文档——这是 JVM 内部容器的 ENGINEERING 深入分析
  1.1 GrowableArray — GenericGrowableArray → GrowableArray 两层继承
      1.1.1 三层分配策略: ResourceArea / C_HEAP / Arena (_arena 哨兵)
      1.1.2 2× doubling growth (grow()，amortized O(1) append)
      1.1.3 at_grow() 边界语义: 填充空洞 + 扩容 + 边界检查
      1.1.4 clear_and_deallocate() 仅 C_HEAP (调用 T::~T())
      1.1.5 GrowableArrayIterator 和 FilterIterator
  1.2 Hashtable — BasicHashtable → Hashtable → RehashableHashtable 三层
      1.2.1 Bucket entry 链 + _next LSB shared bit (CDS 标记)
      1.2.2 块分配: MIN2(512, MAX2(table_size/2, num_entries))
      1.2.3 Rehash 触发: check_rehash_table() 60× average heuristic
      1.2.4 move_to() 全表迁移 + alternate hashing
      1.2.5 resize() safepoint-only 重建（旧桶释放，新桶接管）
      1.2.6 OrderAccess::release_store/get_entry load_acquire (MT-safe 读)
  1.3 ConcurrentHashTable — 无锁并发哈希表
      1.3.1 Bucket 嵌入式状态: LOCK_BIT(0x1) + REDIRECT_BIT(0x2) 3 态 FSM
      1.3.2 CAS insert (internal_insert: try cas_first on bucket head)
      1.3.3 Lock-based delete (lock bucket → unlink → write_synchronize)
      1.3.4 RCU-based grow: lock+redirect old bucket → unzip into new table (even/odd)
      1.3.5 Shrink: combine two buckets → 1 (release_assign_last_node_next)
      1.3.6 ScopedCS + GlobalCounter critical sections (读者保护)
      1.3.7 write_synchonize_on_visible_epoch optimization (避免多余 fence)
      1.3.8 BulkDeleteTask + GrowTask 并行框架 (claim-based range splitting)
  1.4 LinkedList — 双向链表 + 排序变体
      1.4.1 LinkedListNode<E> _data + _next (单向链)
      1.4.2 LinkedList<E> 抽象接口: 8 virtual methods
      1.4.3 LinkedListImpl<E,T,F,failmode>: 模板分配策略 (ARENA/C_HEAP/RESOURCE)
      1.4.4 SortedLinkedList: sorted insert by comparison function
  1.5 Stack — 分段链式栈 + 段缓存
      1.5.1 Segment layout: E[_seg_size] + E* link (link 存在数组末尾)
      1.5.2 _cache 复用 (max_cache_size=4) → 避免 malloc/free ping-pong
      1.5.3 ResourceStack: alloc/free override → resource_allocate_bytes
  1.6 BitMap — 位图集合操作
      1.6.1 三层阶梯: BitMapView → ResourceBitMap → ArenaBitMap → CHeapBitMap
      1.6.2 Template Allocator pattern (无 vtable 代价)
      1.6.3 Range ops: set_range / clear_range / large_range (memset)
      1.6.4 Parallel ops: par_set_bit / par_clear_bit (CAS based)
      1.6.5 Set algebra: union/difference/intersection/contains/intersects
      1.6.6 count_one_bits pop-table (8-bit LUT per byte)
  1.7 GlobalCounter — 退化 RCU
      1.7.1 COUNTER_ACTIVE + COUNTER_INCREMENT 编码
      1.7.2 critical_section_begin/end (per-thread counter with load_acquire/release_store)
      1.7.3 write_synchronize: increment + thread-iteration spin-wait
  1.8 SingleWriterSynchronizer — 双版本翻转同步
      1.8.1 Polarity flip: enter(odd/even) → select exit counter
      1.8.2 synchronize() 5-step algorithm (CAS polarity + fence + semaphore)
  1.9 ResourceHash — 小型编译期哈希表
      1.10 Pair — 泛型值对

§二 ★★★ 分配器策略全景 — ResourceArea vs C_HEAP vs Arena
  ❓ 为什么 3 种分配策略而非 1 种？每个容器的分配决策依据是哪些？
  2.1 ResourceArea (ResourceMark scoped): compiler temp data, GC temp arrays
  2.2 C_HEAP (permanent): JVM global tables, NMT-tracked
  2.3 Arena (custom lifetime): per-classloader metaspaces, arena-based GC
  2.4 Template Allocator pattern (BitMap 的无 vtable 策略)
  2.5 对比表: 每个容器 → 可用的分配策略 → 典型使用场景

§三 ★★ 并发安全模型演进 — Hashtable → ConcurrentHashTable 的路径
  ❓ 从 safepoint 保护到 bucket 级 lock-free 的演化
  3.1 Hashtable 的 safepoint-based concurrency (安全但性能差)
  3.2 ConcurrentHashTable 的 bucket embedded state (复杂但高性能)
  3.3 GlobalCounter 作为同步后端 (RCU 退化版)
  3.4 SingleWriterSynchronizer 作为备选方案 (支持嵌套)

§四 ★ GDB 断点验证 — 12 个断言覆盖所有容器
  （详见 §十）

§五 ★ Cross-Reference
  ❓ 03-object-model — oop, Klass, Handle (GrowableArray 存储的类型)
  ❓ 06-GC-shared — GC 标记栈 (Stack 在其中被使用)
  ❓ 15-core-native — JVM_ENTRY/JVM_LEAF 使用这些容器的上下文
  ❓ 后续 doc-01 — Streams & Output (使用这些容器的流输出子系统)
  ❓ 后续 doc-02 — Debug & Diagnostic (debug.hpp 依赖这些容器)
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because GrowableArray must support ResourceArea, C_HEAP, and Arena allocation without adding a vtable pointer, it uses a sentinel convention (_arena == (Arena*)1 for C_HEAP)..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C++ code from the source files, do not describe it. Every line number citation must be exact.

3. **Mermaid** — ConcurrentHashTable insert sequence diagram. 4 lanes: Reader Thread / Writer Thread / Bucket / GlobalCounter. Complete flow: `ScopedCS begin` → `get_bucket(hash)` → `bucket->first()` (clear state bits) → `get_node` (walk chain) → `Node::create_node` → `cas_first(new_node, first_at_start)` → `callback(true, value)`. Also show resize flow: `lock bucket` → `redirect` → `unzip_bucket` → `new_table` → `set_table_from_new`. Annotate every step with file:line.

4. **GDB session** — 12 breakpoints with exact file:line numbers (full details in §十).

5. **7 Beginner callout boxes** — exact text from §一: ResourceObj vs CHeapObj, Handle Safety, Arena vs Store Allocation, Bucket Embedded State, GlobalCounter Degraded RCU, Placement New in Templates, memset in BitMap.

6. **Cross-reference at three points**:
   - At `GenericGrowableArray::raw_allocate()` → "→ 03-object-model for allocation.hpp ResourceObj/CHeapObj conventions"
   - At `ConcurrentHashTable::internal_remove()` → "→ 06-GC-shared for safepoint interaction and thread iteration"
   - At `GlobalCounter::write_synchronize()` → "→ 15-core-native for OrderAccess::load_acquire/release_store semantics"

7. **Story-format interview answer** — at §一末尾: 从 "HotSpot doesn't use STL. Instead..." 开始的完整叙事。覆盖所有 8 个容器家族的设计理由和关键权衡。

8. **不要写成→应该写成** 对照表：

| 不要写成 | 应该写成 |
|---------|---------|
| "GrowableArray 是一个动态数组" | "GrowableArray 用 _arena 哨兵 ((Arena*)1==C_HEAP, NULL==ResourceArea) 实现无 vtable 的三路分配分发 (growableArray.hpp:102-104)，2× doubling 提供摊销 O(1) append，at_grow() 自动填充空位以支持乱序插入 (growableArray.hpp:283-293)" |
| "Hashtable 有 bucket 和 entry" | "BasicHashtable 用固定 bucket 数组 + 单向链表 entry，_next LSB 编码共享标记位 (hashtable.hpp:50-55)，块分配用 MIN2(512, MAX2(table_size/2, num_entries)) 启发式 (hashtable.cpp:63-69)，rehash 在 safepoint 通过 alternate hashing 全量迁移 (hashtable.cpp:120-159)" |
| "ConcurrentHashTable 支持并发" | "Bucket 的 _first 指针低 2 位嵌入 3 态 FSM (unlocked/locked/redirect, concurrentHashTable.hpp:87-161)，insert 用 lock-free CAS (hashtable.inline.hpp:904)，read 用 wait-free load_acquire (hashtable.inline.hpp:91)，delete 后 write_synchronize 等待读者排空 (hashtable.inline.hpp:484)" |
| "GlobalCounter 是类似 RCU 的机制" | "GlobalCounter 退化 RCU——仅保证写端 grace period，不保护数据防止 use-after-free (globalCounter.inline.hpp:32-44)，线程通过 per-thread counter 的 COUNTER_ACTIVE bit 标记临界区，write_synchronize() 自旋等待所有线程离开旧 generation (globalCounter.cpp:60-73)" |
| "BitMap 操作位图" | "BitMap 用 bm_word_t (uintptr_t) 数组 + 模板 Allocator (Resource/CHeap/Arena, bitMap.cpp:38-72) 实现无 vtable 的三层分配阶梯，set/clear_large_range 切换到 memset SIMD (bitMap.inline.hpp:306-313)，par_set_bit 用 CAS loop (bitMap.inline.hpp:41-58)" |
| "Stack 是栈" | "Stack 分段链式设计：每个 segment 是 E[_seg_size] + E* link (link 存数组末尾之后，stack.inline.hpp:103-132)，pop_segment 时把空段缓存 (_cache, max_size=4) 避免 malloc/free 乒乓 (stack.inline.hpp:172-191)" |
| "SingleWriterSynchronizer 是同步器" | "双版本翻转设计：_enter 的 bit 0 是 polarity，enter() 加 2 保留 bit 0 (singleWriterSynchronizer.hpp:91-93)，synchronize() 用 CAS 翻转 polarity + fence + semaphore 等待旧版本读者排空 (singleWriterSynchronizer.cpp:45-100)" |
| "这些是 JVM 需要的数据结构" | "每个容器的设计都围绕 HotSpot 的独特约束：safepoint 安全性 (Hashtable resize)、Arena 生命周期管理 (GrowableArray 256-byte sentinel)、并发读者优先 (ConcurrentHashTable wait-free reader)、无 vtable 内存零头 (BitMap Allocator pattern)" |

---

## §七 Output Format

- Markdown file, named `00-Core-Containers-Concurrent.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/24-utilities/docs/`
- 元信息头:

```
> **阶段**：[24-utilities]
> **前置**：[03-object-model]（oop, Klass, Handle — 容器的元素类型）、[06-GC-shared]（GC 标记栈、safepoint — 容器并发语义的基础）、[15-core-native]（OrderAccess — Container 并发操作的底层原语）
> **配套**：[01-Streams-Output]（流输出子系统 — 使用 GrowableArray/Hashtable 作为内部存储）、[02-Debug-Diagnostic]（诊断工具 — debug.hpp 内部依赖 BitMap/Stack）
> **后续依赖本文**：几乎所有 Phase（GrowableArray 4,700+ 站点引用，Hashtable 800+ 站点引用）
> **阅读收益**：追踪 HotSpot 内部容器库的完整设计哲学——理解 GrowableArray 的三层分配策略（ResourceArea/C_HEAP/Arena）与 2× doubling growth、Hashtable 的块分配+free_list 循环与 safepoint rehash、ConcurrentHashTable 的 Bucket 嵌入式 3 态 FSM（CAS insert + RCU delete）、BitMap 的模板 Allocator 无 vtable 阶梯、GlobalCounter 退化 RCU 与 SingleWriterSynchronizer 双版本翻转、Stack 的段缓存复用；掌握从 safepoint 保护到 lock-free 的并发模型演进路径
```

- 目标行数: 2500+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "GrowableArray 是一个动态增长数组" 而不解释 _arena 哨兵的三路分发机制 — 必须从 GenericGrowableArray::raw_allocate() 的 if-else 分支 (growableArray.cpp:49-58) 完整展示分配策略切换
- ❌ 不解释 Hashtable 的块分配为什么用 MIN2(512, MAX2(table_size/2, num_entries)) — 必须展示这个启发式的 512 上限、table_size/2 下限的理论依据
- ❌ 不展示 ConcurrentHashTable Bucket 的 3 态 FSM — 必须展示 trylock() CAS (hashtable.inline.hpp:155-167) 和 get_node() wait-free reader (hashtable.inline.hpp:621-645) 的完整源码
- ❌ 不解释 GlobalCounter 的退化本质 — 必须对比内核 RCU（保护数据 + call_rcu callback）vs HotSpot 退化版（仅写端 grace period），说清楚 "不保护数据" 是什么意思
- ❌ 不对比 Hashtable 和 ConcurrentHashTable 的并发模型 — 必须建表对比 safepoint-based vs bucket-lock-based vs CAS-based 三种并发策略的取舍
- ❌ 不对 BitMap 做 Allocator pattern 解释 — 必须展示 Resource/CHeap/Arena 三个 Allocator 类的源码 (bitMap.cpp:38-72) 和子类如何通过模板参数传递分配策略
- ❌ 不解释 Stack 的 segment 内存布局 — 必须展示 segment_bytes() = link_offset() + sizeof(E*) 的计算 (stack.inline.hpp:103-132) 和 _cache 缓存的 push_segment/pop_segment 逻辑
- ❌ 忘记 SingleWriterSynchronizer 的 dual-counter 设计 — 必须展示 enter() (singleWriterSynchronizer.hpp:91-93) 和 synchronize() 5 步算法 (singleWriterSynchronizer.cpp:45-100)
- ❌ 不对 LinkedList 做存储策略模板解释 — 必须展示 LinkedListImpl 的 new_node() switch(T) (linkedlist.hpp:306-324) 如何根据 ARENA/C_HEAP/RESOURCE 选择不同的 placement new
- ❌ 忘记各容器的分配器在 JVM 场景中的实际使用 — 至少 3 个具体例子：GrowableArray 在 C2 编译器、Hashtable 在 SymbolTable、BitMap 在 GC marking

---

## §九 Required（≥8）

- ✅ **★ Mermaid ConcurrentHashTable insert 序列图** — 4 lanes: Reader Thread / Writer Thread / Bucket / GlobalCounter — `ScopedCS begin` → `get_bucket(hash)` → `first()` (strip state bits) → `get_node` → `create_node` → `cas_first(new_node, first_at_start)` → `callback(true, value)`
- ✅ **★ Mermaid 并发数据结构对比图** — 展示 Hashtable vs ConcurrentHashTable vs GlobalCounter 的并发模型差异 (safepoint / bucket lock / CAS / grace period wait)
- ✅ **★ GrowableArray _arena 哨兵源码展示** — on_stack()/on_C_heap()/on_arena() 三谓词 (growableArray.hpp:102-104) + raw_allocate() 三路分发 (growableArray.cpp:49-58) 完整源码
- ✅ **★ ConcurrentHashTable insert 完整源码** — internal_insert() CAS loop + get_node() chain walk + cas_first() + cleanup path (hashtable.inline.hpp:877-942)
- ✅ **★ Hashtable vs ConcurrentHashTable 并发模型对比表** — 6 个维度 (阅读并发/写入并发/Resize/Entry分配/内存管理/典型延迟) 的数值和文件引用对比
- ✅ **★ BitMap Allocator pattern 源码展示** — 三个 Allocator 类 (bitMap.cpp:38-72) + 子类如何包装
- ✅ **★ Stack segment 布局图** — ASCII 图：`[E₀...Eₙ₋₁][padding][link_ptr → prev segment]`，标注 segment_bytes() 和 link_offset()
- ✅ **★ 7 Beginner Callout 框** — exact text from §一: ResourceObj/CHeapObj、Handle Safety、Arena Sentinel、Bucket Embedded State、GlobalCounter Degraded RCU、Placement New、memset in BitMap
- ✅ **★ 交叉引用** — 03-object-model (分配基类), 06-GC-shared (safepoint), 15-core-native (OrderAccess 原型)
- ✅ **★ 不要写成→应该写成 对照表** — ≥8 行，每行含具体源码位置

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: GrowableArray _arena 哨兵 (growableArray.cpp:49)
  (gdb) break growableArray.cpp:49
  (gdb) print this->_arena → 期望: NULL (0x0) 为 ResourceArea, (Arena*)0x1 为 C_HEAP, 或其他 Arena 地址
  (gdb) print elementSize → 期望: sizeof(E) 的元素大小
  (gdb) print this->_max → 期望: 当前容量 (>0)
  (gdb) print on_stack() → 期望: true (如果 _arena==NULL)
  (gdb) print on_C_heap() → 期望: true (如果 _arena==(Arena*)1)
  (gdb) print on_arena() → 期望: true (如果 _arena>(Arena*)1)

断言 2: GrowableArray 2× doubling (growableArray.hpp:448)
  (gdb) break growableArray.hpp:448
  (gdb) print _max → 期望: 扩容前的旧容量
  (gdb) print j → 期望: 触发了扩容的请求索引 (≥ _max)
  (gdb) continue (跳过 while 循环)
  (gdb) print _max → 期望: ≥ 2× old_max 的 power-of-2 近似 (如 8→16, 16→32)
  (gdb) print newData → 期望: 新分配的数组指针 (与 _data 不同)

断言 3: Hashtable block allocation (hashtable.cpp:63)
  (gdb) break hashtable.cpp:63
  (gdb) print _first_free_entry → 期望: NULL (首次分配) 或有效地址
  (gdb) print _end_block → 期望: NULL (首次分配) 或有效地址
  (gdb) print _entry_size → 期望: sizeof(HashtableEntry<T,F>) 
  (gdb) continue (进入 block 分配)
  (gdb) print block_size → 期望: MIN2(512, MAX2(table_size/2, num_entries))
  (gdb) print len → 期望: 向下取整到 2 的幂

断言 4: ConcurrentHashTable bucket CAS insert (concurrentHashTable.inline.hpp:904)
  (gdb) break concurrentHashTable.inline.hpp:904
  (gdb) print bucket->first() → 期望: 当前 bucket 头部 (状态位已清除)
  (gdb) print first_at_start → 期望: 等于 bucket->first()
  (gdb) print new_node → 期望: 非 NULL (新创建的 Node)
  (gdb) print new_node->next() → 期望: 等于 first_at_start
  (gdb) print "cas_first result" → 期望: true (成功插入) 或 false (竞态重试)

断言 5: ConcurrentHashTable bucket redirect (concurrentHashTable.inline.hpp:437)
  (gdb) break concurrentHashTable.inline.hpp:437
  (gdb) print bucket->is_locked() → 期望: true
  (gdb) print bucket->have_redirect() → 期望: false (redirect 前)
  (gdb) continue (执行 redirect)
  (gdb) print bucket->have_redirect() → 期望: true (STATE_REDIRECT_BIT 已设)
  (gdb) print first_raw() & 0x2 → 期望: 0x2 (REDIRECT_BIT)

断言 6: GlobalCounter write_synchronize thread spin (globalCounter.cpp:66)
  (gdb) break globalCounter.cpp:66
  (gdb) print gbl_cnt → 期望: Atomic::add 返回的新全局计数 (偶数)
  (gdb) print thread->get_rcu_counter() → 期望: 线程当前计数
  (gdb) print (*thread->get_rcu_counter() & COUNTER_ACTIVE) → 期望: 0 或 1
  (gdb) continue (等待循环完成)
  (gdb) print "all threads have exited old generation" → 期望: 验证通过

断言 7: BitMap set_bit + par_set_bit (bitMap.inline.hpp:32 / bitMap.inline.hpp:42)
  (gdb) break bitMap.inline.hpp:32
  (gdb) print bit → 期望: 目标位索引 (0 <= bit < _size)
  (gdb) print word_addr(bit) → 期望: 包含此位的 word 地址
  (gdb) print bit_mask(bit) → 期望: 1 << (bit % BitsPerWord)
  (gdb) break bitMap.inline.hpp:42 (par_set_bit CAS loop)
  (gdb) print *addr → 期望: 当前 word 值
  (gdb) print mask → 期望: 1 << (bit % BitsPerWord)
  (gdb) print Atomic::cmpxchg result → 期望: 返回 old_val (成功) 或不同值 (重试)

断言 8: Stack segment link chain (stack.inline.hpp:158)
  (gdb) break stack.inline.hpp:158 (push_segment: set_link)
  (gdb) print this->_cur_seg → 期望: 当前段指针 (即将成为 prev)
  (gdb) print next → 期望: 来自缓存或新分配的段
  (gdb) continue (执行 set_link)
  (gdb) print get_link(next) → 期望: 等于旧的 _cur_seg (链式结构验证)

断言 9: SingleWriterSynchronizer polarity CAS (singleWriterSynchronizer.cpp:67)
  (gdb) break singleWriterSynchronizer.cpp:67 (Atomic::cmpxchg)
  (gdb) print old → 期望: 当前 _enter 值
  (gdb) print value → 期望: old + 1 (翻转了 polarity)
  (gdb) print *_exit[(old+1)&1] → 期望: 已被初始化为 old + 1
  (gdb) print Atomic::cmpxchg result → 期望: == old (CAS 成功)

断言 10: ResourceHash lookup (resourceHash.hpp:74)
  (gdb) break resourceHash.hpp:74
  (gdb) print hash → 期望: unsigned hash value
  (gdb) print hash % SIZE → 期望: bucket index (0 <= idx < 256)
  (gdb) print _table[hash % SIZE] → 期望: Node* (NULL 或链表头)
  (gdb) print "lookup path follows" → 期望: while loop tracing chain

断言 11: LinkedList clear traversal (linkedlist.hpp:129)
  (gdb) break linkedlist.hpp:129
  (gdb) print this->head() → 期望: Node* (非空才进入 clear)
  (gdb) print *this->head()->peek() → 期望: E 类型数据
  (gdb) continue (while loop iteration)
  (gdb) print p → 期望: 下一个节点或 NULL

断言 12: GrowableArray at_grow fill (growableArray.hpp:288)
  (gdb) break growableArray.hpp:288
  (gdb) print i → 期望: 请求的索引 (可能 > _len)
  (gdb) print _len → 期望: 当前长度
  (gdb) print fill → 期望: 默认构造值 (E()) 或显式填充值
  (gdb) continue (for loop filling)
  (gdb) print _data[j] → 期望: j 位置的填充值 (从 _len 到 i)
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §二 doc-00 承接**：本文展开 README 中定义的 "Core Containers & Concurrent" 组——growableArray, hashtable, concurrentHashTable, linkedlist, stack, bitMap, globalCounter, singleWriterSynchronizer, resourceHash, pair。

2. **这是 24-utilities 的首篇文档** —— 建立整个 Phase 的基础词汇和并发原语概念。后续 doc-01 (Streams & Output) 和 doc-02 (Debug & Diagnostic) 都会使用本文中分析的容器。

3. **与 README 提出的关键问题对应**：
   - "Hashtable vs ConcurrentHashTable 的并发设计哲学差异" → §四.4.8 完整回答
   - "GrowableArray 的 2× 扩容策略与内存碎片" → §四.4.1 完整回答 + counterfactual
   - "BitMap 的三层阶梯" → §四.4.6 完整回答
   - "globalCounter 作为退化 RCU" → §四.4.4 完整回答 + 与内核 RCU 的对比
   - "singleWriterSynchronizer 的 lock-free 读者保证" → §四.4.5 完整回答

4. **同组边界**：本文覆盖容器和并发数据结构（11 源文件 ~6,500 行）。doc-01 覆盖流式输出（12 源文件 ~4,650 行，使用本文容器）。doc-02 覆盖调试诊断（15 源文件 ~6,500 行）。三篇共享相同的分配器术语和并发原语。

5. **全部文档共享 §一 开头语**："Reader completed 03-object-model (oop, Klass, Handle), 06-GC-shared (GC threads, safepoints), 15-core-native (native entry/exit). This doc: how JVM's own container library is designed."
