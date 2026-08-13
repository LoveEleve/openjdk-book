# 03. Arena + ResourceArea — VM 自己的 C++ 内存分配器

> **前置依赖**:[09-memory-core/02 — VirtualSpace](openjdk/vol-02/09-memory-core/02-virtualspace.md):VirtualSpace 之上"谁把区域切成可复用小块"就是这一篇;[09-memory-core/01 — Universe + CollectedHeap](openjdk/vol-02/09-memory-core/01-universe-heap.md):genesis 里就有 `ResourceMark rm`(universe.cpp:322);[07-classfile-classloader/01 — ClassFile 解析](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md):解析器是 ResourceArea 的大户(classFileParser.cpp 41 处 ResourceMark/ResourceArea)
> → **后续**:[10-metaspace/01 — Metaspace 概览](openjdk/vol-02/10-metaspace/01-metaspace-overview.md)(类元数据怎么分配+回收)
> 关联域: 09-memory-core(内存管理)、10-metaspace、16-code-cache

## JVM 的 C++ 代码从哪拿内存

前两讲解决的是"Java 对象的堆"与"大面积区域的虚拟地址"。但 JVM 自己的 C++ 代码——C2 编译方法时的中间表示、GC 标记的临时位图、类文件解析的临时结构——它们不调裸 `malloc/free`,而是四个专用分配器: **Arena**(Chunk 内 bump)、**ResourceArea**(per-thread 的栈式 Arena)、**AllocateHeap**(带 NMT 追踪的 malloc)、**GuardedMemory**(debug 的 canary 守卫)。这一篇按"一次分配+整批释放"这条主线把它们串起来——这也是 09 域的收官篇。

## 1. Arena: 一次分配,整批释放

### 场景: 一堆短命对象,一次性丢弃

G1 并发标记的每个 worker 任务函数以一层 `ResourceMark` 打底(G1CMConcurrentMarkingTask::work,g1ConcurrentMark.cpp:833),C2 编译要存 IR 节点图——单个分配很快,但数量多、生命周期短、而且**不需要逐个 free**——scope 一结束整批作废。Arena 就是为这种模式设计的: 大块内存切成 Chunk,分配只在 Chunk 里 bump 指针,释放=整批销毁 Arena。

### Chunk: 四种规格的内存块

Chunk 是 Arena 的基本单位(arena.hpp:45-89),四种规格定义在枚举里(arena.hpp:55-70,截取核心,逐字):

```cpp
// arena.hpp:55-70(截取核心,逐字)
  enum {
    // default sizes; make them slightly smaller than 2**k to guard against
    // buddy-system style malloc implementations
#ifdef _LP64
    slack      = 40,            // [RGV] Not sure if this is right, but make it
                                //       a multiple of 8.
#else
    slack      = 20,            // suspected sizeof(Chunk) + internal malloc headers
#endif

    tiny_size  =  256  - slack, // Size of first chunk (tiny)
    init_size  =  1*K  - slack, // Size of first chunk (normal aka small)
    medium_size= 10*K  - slack, // Size of medium-sized chunk
    size       = 32*K  - slack, // Default size of an Arena chunk (following the first)
    non_pool_size = init_size + 32 // An initial size which is not one of above
  };
```

注意两个细节: 规格**故意比 2^k 略小**(注释原话: "guard against buddy-system style malloc implementations"——2^k 尺寸在 buddy 式分配器里有特殊合并/切分行为,略小一点让块走普通槽位);`init_size`(1K-slack)是**第一个** chunk,32K-slack 是**后续默认** chunk——流传的"第一个 Chunk 就是 32KB"是错的(Arena 构造用 init_size,arena.cpp:244-251)。

### Amalloc: 对齐 + 溢出检查 + bump

分配核心 `Amalloc`(arena.hpp:144-159,截取核心,逐字):

```cpp
// arena.hpp:144-159(截取核心,逐字)
  // Fast allocate in the arena.  Common case is: pointer test + increment.
  void* Amalloc(size_t x, AllocFailType alloc_failmode = AllocFailStrategy::EXIT_OOM) {
    assert(is_power_of_2(ARENA_AMALLOC_ALIGNMENT) , "should be a power of 2");
    x = ARENA_ALIGN(x);
    debug_only(if (UseMallocOnly) return malloc(x);)
    if (!check_for_overflow(x, "Arena::Amalloc", alloc_failmode))
      return NULL;
    NOT_PRODUCT(inc_bytes_allocated(x);)
    if (_hwm + x > _max) {
      return grow(x, alloc_failmode);
    } else {
      char *old = _hwm;
      _hwm += x;
      return old;
    }
  }
```

- `ARENA_ALIGN`(arena.hpp:37-41): 按 `ARENA_AMALLOC_ALIGNMENT = 2*BytesPerWord`(16 字节,:37)对齐;
- 快路径就是注释说的 "pointer test + increment": `_hwm + x > _max` 则 `grow`,否则 `_hwm += x` 返回旧水位——两三次比较加一次加法,无锁无 malloc;
- 慢路径 `grow`(arena.cpp:360-383): `len = MAX2(x, Chunk::size)` 定新 chunk 大小,`new Chunk(len)`——Chunk 的 `operator new`(arena.cpp:198-216)按长度**匹配四个 ChunkPool**(32K→large、10K→medium、1K→small、256→tiny),匹配不上才 `os::malloc`。新 chunk 挂到链表尾(`k->set_next(_chunk)`),水位重置。

`Afree`(arena.hpp:202-210)是"释放"的全部真相: **通常 NOP**——只有释放的恰好是最近分配的那块(`ptr+size == _hwm`)才把水位退回去。真正的释放发生在 Arena 析构: `~Arena` → `destruct_contents`(arena.cpp:309-323) → `_first->chop()`(Chunk::chop,arena.cpp:230-239)沿链表逐个 `delete`——每个 Chunk 的 `operator delete`(arena.cpp:218-228)又按规格把块还给对应 ChunkPool,不调 os::free。整批归还,零逐个开销。

### ChunkPool: 四个池 + 定时瘦身

ChunkPool(arena.cpp:43-140)不是单个全局池,是**四个静态池**(arena.cpp:49-52: `_large_pool`/`_medium_pool`/`_small_pool`/`_tiny_pool`,初始化 :126-129)。取块 `allocate`(:75-88): `ThreadCritical` 锁内从池头取,池空才 `os::malloc`;还块 `free`(:91-103): 挂回池头。池子本身会膨胀——`ChunkPoolCleaner`(arena.cpp:169-181)是 5 秒一次的 PeriodicTask,调 `clean()` → 每个池 `free_all_but(5)`(:140-146,保留 5 块,其余 os::free 真释放)。这就是 GC 并发任务反复建销毁 Arena 却很少碰系统 malloc 的原因: 块在池里循环,只有 5 秒清算一次。

**关键设计 (斜体)**: *Arena 的哲学是"把释放推迟到整批"——分配是 bump,释放是整条链表还池,单个对象的生命周期根本不在 Arena 的视野里。代价是碎片: 块内分配与释放交错会留空洞,但 Arena 的寿命(一个 GC 阶段、一次编译)远短于碎片累积的周期,所以"不回收"反而是最优解。*

## 2. ResourceArea: 每线程一把栈

### 从 Arena 到栈式生命周期

`ResourceArea : public Arena`(resourceArea.hpp:44)——它就是 Arena 的 per-thread 实例,每个 Java 线程一个(`Thread::resource_area()`,thread.hpp:506),编译器线程的还会 `bias_to(mtCompiler)`(thread.cpp:3447)让 NMT 统计归到编译器名下。它和普通 Arena 的区别是配套的 `ResourceMark`: 栈对象,构造时存档、析构时回滚。

### ResourceMark: 存档、回滚、还块

ResourceMark 保存 Arena 的完整状态(resourceArea.hpp:82-96: `_chunk`/`_hwm`/`_max`/`_size_in_bytes`),析构时 `reset_to_mark`(resourceArea.hpp:128-149,截取核心,逐字):

```cpp
// resourceArea.hpp:128-149(截取核心,逐字)
  void reset_to_mark() {
    if (UseMallocOnly) free_malloced_objects();

    if( _chunk->next() ) {       // Delete later chunks
      // reset arena size before delete chunks. Otherwise, the total
      // arena size could exceed total chunk size
      assert(_area->size_in_bytes() > size_in_bytes(), "Sanity check");
      _area->set_size_in_bytes(size_in_bytes());
      _chunk->next_chop();
    } else {
      assert(_area->size_in_bytes() == size_in_bytes(), "Sanity check");
    }
    _area->_chunk = _chunk;     // Roll back arena to saved chunk
    _area->_hwm = _hwm;
    _area->_max = _max;

    // clear out this chunk (to detect allocation bugs)
    if (ZapResourceArea) memset(_hwm, badResourceValue, _max - _hwm);
  }
```

注意流传说法"ResourceMark 析构就是把 `_top` 指回 `_saved_top`"只对了一半: 回滚水位之后,还要 `_chunk->next_chop()`(:135)——**mark 之后新加的 chunk 当场销毁还池**,否则一个大编译任务留下的整链 chunk 会一直占着 Arena。`ZapResourceArea` 时把回滚区填 `badResourceValue`(0xAB)方便抓悬垂指针。

嵌套天然正确: 内层 ResourceMark 只回滚到自己的存档点,外层不受影响——C2 方法内联一层一个 mark,内联失败只丢那一层的 IR 节点。`allocate_bytes`(resourceArea.inline.hpp:31-43)在 ASSERT 下还会检查 nesting: **没有 ResourceMark 就分配 = 泄漏,直接 fatal**(`"memory leak: allocating without ResourceMark"`)。

**关键设计 (斜体)**: *ResourceArea 把"栈式生命周期"变成语法: 谁需要临时内存,谁在作用域里声明一个 ResourceMark,析构时整批归还(含 chunk 链)。没有引用计数、没有所有权转移——编译器代码因此不需要手动管理临时对象。*

## 3. AllocateHeap: 生产环境的长命 malloc

需要跨作用域存活、生命周期不可预测的分配(如 JVM 内部数据结构)走 `AllocateHeap`(allocation.cpp:40-49,截取核心,逐字):

```cpp
// allocation.cpp:39-49(截取核心,逐字)
// allocate using malloc; will fail if no memory available
char* AllocateHeap(size_t size,
                   MEMFLAGS flags,
                   const NativeCallStack& stack,
                   AllocFailType alloc_failmode /* = AllocFailStrategy::EXIT_OOM*/) {
  char* p = (char*) os::malloc(size, flags, stack);
  if (p == NULL && alloc_failmode == AllocFailStrategy::EXIT_OOM) {
    vm_exit_out_of_memory(size, OOM_MALLOC_ERROR, "AllocateHeap");
  }
  return p;
}
```

它只是 `os::malloc` 的包装 + 失败策略(默认 OOM 直接 vm_exit,可换 RETURN_NULL)。NMT 的记账是 `os::malloc` 内部的事: 每个分配前垫一个 **16 字节的 `MallocHeader`**(mallocTracker.hpp:246,`assert(sizeof(MallocHeader) == sizeof(void*) * 2)` :263,内嵌 size/flags 与两个索引);**分配点调用栈并不内嵌**——`_pos_idx`/`_bucket_idx` 指向 `MallocSiteTable` 的槽位,`get_stack` 按索引查回调用栈(mallocTracker.cpp:92-94)。所以 `jcmd VM.native_memory detail` 能按 MEMFLAGS 与调用栈拆账,代价是每块 16 字节 + 一张全局调用栈表。配套的 `ReallocateHeap`/`FreeHeap` 同理,都是 os::realloc/os::free 的薄包装。

## 4. GuardedMemory: 裸指针的 canary 守卫

`GuardedMemory`(guardedMemory.hpp:83)给"裸指针"加守卫,它的真实用户不是 debug 专属,而是 **jniCheck 模式**(-Xcheck:jni 打开时 JNI 层的参数/返回检查,jniCheck.cpp:384 用 `wrap_copy` 包数组元素、:395/:422-433 检查后 `free_copy`;`get_tag` 还能把原始指针存进守卫头): 分配时在用户数据**前后各放一个 16 字节守卫**(`GUARD_SIZE = 16`,guardedMemory.hpp:96-98),守卫内容是 **`badResourceValue`(0xAB,globalDefinitions.hpp:1012)**——流传说法里的"0xBAADF00D/0xDEADBEEF"是 glibc MALLOC_CHECK_ 的值,JVM 没用。`Guard::verify()`(guardedMemory.hpp:107-112)逐字节核对,`verify_guards()`(guardedMemory.hpp:212)一头一尾各查一次: 头坏=underflow、尾坏=overflow。配套的 `wrap_copy`/`free_copy`(guardedMemory.cpp:31-54)负责包/拆: `wrap_copy` 分配 `get_total_size(len)` 外层块、把用户数据拷进守卫中间;`free_copy` 先 verify 再释放,守卫被踩坏会在此时暴露。

## 核心悬念

四种分配器到齐,09 域收官: Arena 用 Chunk + bump 把"一次分配整批释放"做到极致(Chunk 四规格防 buddy 特殊行为、ChunkPool 四池 + 5 秒清算);ResourceArea 把它变成 per-thread 的栈式生命周期(ResourceMark 存档回滚 + next_chop 还块);AllocateHeap 是带 NMT 追踪的生产 malloc(16 字节头 + 调用栈表索引);GuardedMemory 用 0xAB 守卫抓越界(-Xcheck:jni 的 jniCheck 就是它的客户)。但有一个大客户一直没登场: **类元数据**——InstanceKlass、ConstantPool、Method 这些 07 域讲过的东西住在哪?它们既不在堆上(不是 Java 对象)也不在这些 Arena 里(生命周期与类一样长,不可整批回滚)——它们住在 **Metaspace**: VirtualSpaceNode → ChunkManager → Metablock 的专门世界。下一篇: Metaspace——类的元数据怎么分配与回收。

> → [10-metaspace/01 — Metaspace 概览](openjdk/vol-02/10-metaspace/01-metaspace-overview.md)
