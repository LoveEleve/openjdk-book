# 前置概念：initialize_heap() 要做什么？G1 的五步堆创建全景

> **本文定位**：背景知识文章。本文从最基础的问题出发——JVM 什么时候创建堆、为什么需要这么多步骤——建立第一个最小知识点：`initialize_heap()` 的五个阶段全景。你要理解的是 `UseG1GC` 标志被设置后，从 `universe_init` 到 G1 堆完全就绪之间发生了什么。
>
> 本文是一本电子书的章节——不限制长度。每一行源码都被拆开、每一步数据结构的变化都被展示。
>
> **阅读提示**：本文是最小知识点链的起点。后续文章（02-07）每一篇都会明确引用前面的概念。读完本文后，你只需要知道 `initialize_heap` 分哪五个阶段、每个阶段做什么——不需要理解 `setup_heap_region_size` 怎么算的、`G1ConcurrentMark` 怎么创建线程。那些是后续文章的主题。

---

## 1. 场景：universe_init 里需要堆

### 1.1 回顾：`universe_init` 是整个阶段 6 的中枢

ch04 总览已经讲过：`init_globals()` 的 30 个子函数按依赖链分为 5 个 Block，Block B 的中枢叫 `universe_init`。它的内部调用链开头是这样的：

```
universe_init()
├─ JavaClasses::compute_hard_coded_offsets()
├─ Universe::initialize_heap()          // ← 本文的主角
├─ SystemDictionary::initialize_oop_storage()
├─ Metaspace::global_initialize()
├─ ClassLoaderData::init_null_class_loader_data()
├─ 6× new LatestMethodCache()
├─ SymbolTable/StringTable::create_table()
└─ ResolvedMethodTable::create_table()
```

`universe_init()` 是阶段 6 的中枢，因为它建立了后续所有 Java 代码运行的物质基础——堆（对象分配）、Metaspace（Klass/metadata）、符号表（字符串和符号的 intern）、方法缓存（反射调用 Java 方法的 fast path）。

`initialize_heap` 排在 `compute_hard_coded_offsets()` 之后——此时 Java 类的硬编码偏移量已算好，但堆还不存在。排在 `Metaspace::global_initialize()` 之前——因为 CDS 的共享空间映射需要堆先就绪。

### 1.2 `universe_init` 源码中调用 `initialize_heap` 的位置

从 `universe.cpp:675` 开始，`universe_init` 调用 `initialize_heap` 的地方在这：

```cpp
/* === src/hotspot/share/memory/universe.cpp === */

675  jint universe_init() {
676    assert(!Universe::_fully_initialized, "called after initialize_vtables");
677    guarantee(1 << LogHeapWordSize == sizeof(HeapWord),
678           "LogHeapWordSize is incorrect.");
679    guarantee(sizeof(oop) >= sizeof(HeapWord), "HeapWord larger than oop?");
680    guarantee(sizeof(oop) % sizeof(HeapWord) == 0,
681              "oop size is not not a multiple of HeapWord size");
682
683    TraceTime timer("Genesis", TRACETIME_LOG(Info, startuptime));
684
685    JavaClasses::compute_hard_coded_offsets();
686
687    jint status = Universe::initialize_heap();    // ← 这里
688    if (status != JNI_OK) {
689      return status;                               // ← 失败时提前返回
690    }
```

第 687-690 行是 `universe_init` 中**第一个返回值检查点**。如果堆创建失败——内存不够、压缩指针无法设置——`init_globals()` 会得到 `status != JNI_OK`，直接 `return status`，后续的 Metaspace、符号表、方法缓存全部不会初始化。这是一个不可恢复的致命失败——没有堆，JVM 无法使用。

### 1.3 `initialize_heap` 调用前 JVM 的状态

- `_collectedHeap == NULL`——`Universe` 的静态字段 `_collectedHeap` 还是空指针。对象的分配、回收、TLAB 申请全部走不通
- `UseG1GC == true`——用户在命令行上设了 `-XX:+UseG1GC`，或者 JVM 在 server-class 机器上自动选了 G1（`GCConfig::select_gc_ergonomically()`）
- G1 相关全局静态变量未初始化——`HeapRegion::GrainBytes` 还是 0（调用 `setup_heap_region_size` 之后才有值）
- CodeCache 已创建（`codeCache_init` 在 Block A 执行过，stubRoutines_init1 也已完成）

---

## 2. `initialize_heap()` 的全过程——五阶段全景

### 2.1 完整源码

```cpp
/* === src/hotspot/share/memory/universe.cpp === */
/* === 行号 765-826 === */

765  jint Universe::initialize_heap() {
766    _collectedHeap = create_heap();                    // 阶段 1: 选择 GC，构造堆对象
767    jint status = _collectedHeap->initialize();        // 阶段 2: 初始化堆（预约内存、创建数据区）
768    if (status != JNI_OK) {
769      return status;
770    }
771    log_info(gc)("Using %s", _collectedHeap->name());  // 日志: "Using G1 GC"
772
773    ThreadLocalAllocBuffer::set_max_size(               // 阶段 3: TLAB 最大尺寸
774        Universe::heap()->max_tlab_size());
775
776  #ifdef _LP64
777    if (UseCompressedOops) {                            // 阶段 4: 压缩指针编码
778      if ((uint64_t)Universe::heap()->reserved_region().end()
779          > UnscaledOopHeapMax) {
780        Universe::set_narrow_oop_shift(LogMinObjAlignmentInBytes);
781      }
782      if ((uint64_t)Universe::heap()->reserved_region().end()
783          <= OopEncodingHeapMax) {
784        Universe::set_narrow_oop_base(0);
785      }
786      Universe::set_narrow_ptrs_base(Universe::narrow_oop_base());
787      Arguments::PropertyList_add(
788          new SystemProperty("java.vm.compressedOopsMode",
789                             narrow_oop_mode_to_string(narrow_oop_mode()),
790                             false));
791    }
792  #endif
793
794    if (UseTLAB) {                                     // 阶段 5: TLAB 启动
795      ThreadLocalAllocBuffer::startup_initialization();
796    }
797    return JNI_OK;
798  }
```

**这 62 行是本文要建立的全景图。后续 02-06 的六篇文章各自展开其中一个阶段——先不看细节，先看懂这五个阶段各自解决什么问题。**

### 2.2 五阶段分块标注

```
Universe::initialize_heap()   ← universe_init() 调用
│
├─ [阶段 1] create_heap()                          ← 本文下面第 3 节展开
│   └─ GCConfig::arguments()->create_heap()
│       └─ G1Arguments::create_heap()
│           └─ create_heap_with_policy<G1CollectedHeap, G1CollectorPolicy>()
│               ├─ new G1CollectorPolicy()          → ch11/02 详讲
│               │   ├─ setup_heap_region_size()     → ch11/02 详讲
│               │   └─ setup_remset_size()          → ch11/02 详讲
│               └─ new G1CollectedHeap(policy)     → ch11/03 详讲
│
├─ [阶段 2] _collectedHeap->initialize()            ← G1CollectedHeap::initialize()
│   │ 201 行，是整个 initialize_heap 中最重的一步   → ch11/03-05 详讲
│   │
│   ├─ Universe::reserve_heap()                     → ch11/03 详讲
│   │   └─ ReservedHeapSpace → mmap                 → ch11/03 详讲
│   │
│   ├─ 6 个 G1RegionToSpaceMapper                   → ch11/04 详讲
│   │   └─ HeapRegionManager::initialize()
│   │
│   ├─ G1ConcurrentMark(~150行)                     → ch11/05 详讲
│   │   └─ SATB / DirtyCard 队列初始化
│   │
│   ├─ ConcurrentRefinement 线程                     → ch11/05 详讲
│   ├─ expand(init_byte_size) —— 真正 commit 物理页  → ch11/05 详讲
│   └─ g1_policy()->init()                          → ch11/05 详讲
│
├─ [阶段 3] ThreadLocalAllocBuffer::set_max_size()   ← G1 视角：humongous threshold
│
├─ [阶段 4] Compressed Oops 编码设置                  → ch11/06 详讲
│   ├─ narrow_oop_shift / narrow_oop_base 设置
│   └─ narrow_ptrs_base 同步
│
└─ [阶段 5] ThreadLocalAllocBuffer::startup_initialization()
    ├─ _target_refills 计算                          → ch11/06 详讲
    ├─ GlobalTLABStats 创建                           → ch11/06 详讲
    └─ 主线程 TLAB 重新初始化                         → ch11/06 详讲
```

### 2.3 各个阶段的定位

| 阶段 | 行数 | 本质 | 谁做的 |
|------|------|------|--------|
| 1 create_heap | 1 行调用 + 3 行子函数 | **选择 GC 类型，构造堆对象** | G1Arguments → G1CollectorPolicy → G1CollectedHeap 构造 |
| 2 initialize | 1 行调用 + 201 行 G1 专属 | **分配虚拟地址空间、创建数据结构、创建 GC 线程** | G1CollectedHeap::initialize() |
| 3 tlab_max_size | 1 行 | **设置 TLAB 的最大尺寸 = G1 的 humongous 阈值** | G1CollectedHeap::max_tlab_size() |
| 4 compressed_oops | 17 行 | **根据堆的物理地址设置 oop 编码方式** | Universe 静态方法 |
| 5 tlab_startup | 1 行调用 + 45 行 | **初始化 TLAB 全局统计和主线程的 TLAB** | ThreadLocalAllocBuffer 静态方法 |

---

## 3. 阶段 1 展开：`create_heap()` —— 从 `UseG1GC` 到 `G1CollectedHeap` 对象

### 3.1 代码——四行，四个角色

`create_heap()` 的源码只有 4 行（`universe.cpp:752-755`）：

```cpp
CollectedHeap* Universe::create_heap() {
  assert(_collectedHeap == NULL, "Heap already created");
  return GCConfig::arguments()->create_heap();
}
```

这 4 行背后涉及四个角色：

```
Universe::create_heap()
  └─ GCConfig::arguments()
       │
       └─→ 返回选中的 GCArguments*（这里 = G1Arguments*）
            └─ G1Arguments::create_heap()
                 └─ create_heap_with_policy<G1CollectedHeap, G1CollectorPolicy>()
                      ├─ new G1CollectorPolicy()
                      │    ├─ HeapRegion::setup_heap_region_size()
                      │    │    └─ 决定 Region 大小 (1/2/4/8/16/32 MB)
                      │    └─ HeapRegionRemSet::setup_remset_size()
                      │         └─ 决定 RSet 表容量
                      │
                      └─ new G1CollectedHeap(policy)
                           └─ 92 行构造函数
```

`GCConfig::arguments()` 返回的就是**被选中的那个 GC 的 Arguments 对象**——G1Arguments 在这里是 `FOR_EACH_SUPPORTED_GC` 循环中找到 `UseG1GC == true` 的那个。这个选择过程（`select_gc` + `SupportedGCs[]` 表）在 ch11/02 详讲。

### 3.2 `G1Arguments::create_heap()` → 模板 `create_heap_with_policy`

```cpp
/* === src/hotspot/share/gc/shared/gcArguments.inline.hpp === */
/* === 行号 29-34 === */

29  template <class Heap, class Policy>
30  CollectedHeap* GCArguments::create_heap_with_policy() {
31    Policy* policy = new Policy();           // 步骤 A: new G1CollectorPolicy
32    policy->initialize_all();                // 步骤 B: 设置对齐/校验参数/算大小
33    return new Heap(policy);                 // 步骤 C: new G1CollectedHeap(policy)
34  }
```

三行模板代码展示了 G1 堆创建的三段式：
- **步骤 A — `new G1CollectorPolicy()`**：构造时调用 `setup_heap_region_size`（确定 Region 大小的 47 行逻辑）和 `setup_remset_size`（确定 RSet 表容量的 13 行逻辑）——这两步决定了 G1 最基本的空间单元大小。ch11/02 详讲。
- **步骤 B — `policy->initialize_all()`**：调用继承自 `CollectorPolicy` 的三阶段初始化：`initialize_alignments()` 设对齐粒度 → `initialize_flags()` 校验和调整堆大小 → `initialize_size_info()` 打日志。ch11/02 详讲。
- **步骤 C — `new G1CollectedHeap(policy)`**：G1 堆对象的 92 行构造函数。创建 `WorkGang`（GC 线程池）、`G1Allocator`（分配器）、`G1HeapSizingPolicy`（堆大小策略）、`RefToScanQueue`（per-worker ref 队列）。但此时**堆内存还没分配**——构造函数只创建对象，不碰 OS 内存。ch11/03 详讲。

---

## 4. 阶段 2 到底做了什么——`G1CollectedHeap::initialize()` 速览

阶段 2 是整个 `initialize_heap` 中最重的一步——`G1CollectedHeap::initialize()` 有 **201 行**。本文只给出快速概览，让读者知道它分成 22 个子步骤——ch11/03、04、05 再逐层展开。

### 4.1 22 个步骤的高层分组

```
G1CollectedHeap::initialize()  201行 ──→ 22个步骤 ──→ 分入 ch11/03、04、05
│
├─ [ch11/03 详讲] 基本初始化 (步骤1-4)
│   ├─ 1. os::enable_vtime() + Heap_lock 获取
│   ├─ 2. 获取 init/max byte size + heap_alignment
│   ├─ 3. 校验对齐(G1)
│   └─ 4. Universe::reserve_heap(max_byte_size, alignment)
│       → ReservedHeapSpace 创建 → OS 层面 mmap 预留虚拟地址空间
│
├─ [ch11/04 详讲] 内存映射体系 (步骤5-10)
│   ├─ 5. G1CardTable + G1BarrierSet 创建
│   ├─ 6. G1HotCardCache 创建
│   ├─ 7. 6 个 G1RegionToSpaceMapper 创建
│   │    (heap / BOT / cardtable / card_counts / prev_bitmap / next_bitmap)
│   ├─ 8. HeapRegionManager::initialize()
│   │    → _regions 数组 + _available_map 位图
│   ├─ 9. CardTable 二次初始化 (绑定 cardtable_storage)
│   └─ 10. Region 数量校验
│
├─ [ch11/05 详讲] 并发引擎 + 物理内存 (步骤11-18)
│   ├─ 11. G1RemSet 创建并初始化
│   ├─ 12. G1BlockOffsetTable 创建
│   ├─ 13. CSet 快速判断 + Humongous 回收候选 初始化
│   ├─ 14. G1ConcurrentMark 构造(~150行) ← 最重单步
│   │    └─ 双缓冲位图 + G1ConcurrentMarkThread + WorkGang("G1 Conc")
│   │       + MarkStackSize + per-worker G1CMTask/G1CMTaskQueue
│   ├─ 15. expand(init_byte_size) —— commit 物理页
│   ├─ 16. g1_policy()->init() —— 策略初始化
│   ├─ 17. SATB 队列初始化
│   └─ 18. ConcurrentRefinement 初始化
│
└─ [ch11/05 详讲] 收尾 (步骤19-22)
    ├─ 19. Young RemSet Sampling 线程
    ├─ 20. DirtyCard 双队列初始化
    ├─ 21. Dummy Region + 分配器初始化
    └─ 22. G1MonitoringSupport + StringDedup + preserved marks
```

### 4.2 三个"为什么"

在看 ch11/03-05 的详细拆解之前，读者需要带着三个问题：

1. **为什么构造函数和 `initialize()` 要分开？** 构造函数做"轻量创建"——不需要锁、不依赖堆地址的纯计算和纯对象分配。`initialize()` 做"重量初始化"——需要持 Heap_lock、需要依赖 reserved_region() 的结果才能创建 CardTable、需要在 `_hrm` 就绪后才能创建 ConcurrentMark。错误处理路径也不同——构造失败只能抛异常让进程退出，initialize 返回 `JNI_ENOMEM` 可以优雅退出。

2. **为什么需要 6 个 Mapper？** G1 比 Serial/Parallel 更复杂——除了堆内存本身，还有 BOT（Block Offset Table，快速找对象起始位置）、CardTable（跨 Region 引用追踪）、CardCounts（Hot Card Cache 用）、prev/next bitmap（并发标记的双缓冲位图）。每种元数据区的地址范围、commit 粒度、生命周期都不同——用一个 mapper 管理一种，各自按需 commit。

3. **为什么 `G1ConcurrentMark` 的构造是 150 行？** 因为并发标记需要：双缓冲位图（prev/next——一个正在用，另一个为下次标记做准备）、独立的标记线程（`G1ConcurrentMarkThread`）、独立的线程池（`WorkGang("G1 Conc")`）、全局标记栈（`MarkStackSize` + `G1CMMarkStack`）、每个 worker 的任务描述（`G1CMTask`）和任务队列（`G1CMTaskQueue`）。这是 G1 对比分代 GC 最大的差异点。

---

## 5. 阶段 3-5 做了什么

### 5.1 阶段 3: TLAB 最大尺寸（1 行）

```cpp
ThreadLocalAllocBuffer::set_max_size(Universe::heap()->max_tlab_size());
```

这句话在 G1 下的实际语义是：

```cpp
// G1CollectedHeap 的 max_tlab_size() 返回 humongous 阈值
// = HeapRegion::GrainWords / 2（即 Region 大小的一半）
```

含义：G1 中单个 TLAB 不能跨越多个 Region，因此 TLAB 最大不能超过 Region 大小的一半（留下至少一半的空间给其他线程的 TLAB）。这个限制来自 Region 大小——在第 3 节中 `setup_heap_region_size` 已经确定了 GrainWords。

### 5.2 阶段 4: 压缩指针编码（17 行）

```
if (heap_end > UnscaledOopHeapMax (4GB))
    → narrow_oop_shift = LogMinObjAlignmentInBytes (= 3)
    → 编码公式: narrow_oop = (oop - base) >> 3
    → 解码公式: oop = base + (narrow_oop << 3)

if (heap_end <= OopEncodingHeapMax (32GB))
    → narrow_oop_base = 0
    → "Zero-based" 模式——不需要 base
否则
    → narrow_oop_base = 堆地址（由 ReservedHeapSpace 预计算）
```

G1 的大堆场景（>4GB）几乎必定需要压缩指针——32 位 oop 指向 64 位堆空间。压缩模式的决策细节——四种模式（Unscaled/ZeroBased/DisjointBase/HeapBased）的完整决策树、`narrow_klass` 的独立编码体系——在 ch11/06 详讲。

### 5.3 阶段 5: TLAB 启动（1 行调用 + 45 行）

```cpp
ThreadLocalAllocBuffer::startup_initialization();
```

这 45 行做的三件事——`_target_refills` 公式、`GlobalTLABStats` 单例创建、主线程 TLAB 重新初始化——在 ch11/06 详讲。

---

## 6. 五阶段之间的依赖关系

```
阶段 1 (create_heap)
  │  Region 大小确定了、G1CollectedHeap 对象存在了
  │
  ├──→ 阶段 2 (initialize)
  │      │  用 Region 大小(GrainBytes)创建 6 个 Mapper
  │      │  ↓
  │      ├──→ HeapRegionManager 初始化（需要 Mapper 的 reserved regions）
  │      │      │  ↓
  │      │      ├──→ G1ConcurrentMark 创建（需要 max_regions() 来分配 per-region 结构）
  │      │      │    ↓
  │      │      ├──→ expand(init_byte_size)（需要 _workers 已创建）
  │      │      │    ↓
  │      │      └──→ g1_policy()->init()（需要 expand 后的 free region 数量）
  │      │
  │      └──→ 阶段 2 结束：堆内存已预留、GC 线程已创建、并发标记就绪
  │            │
  ├─────────────┴──→ 阶段 3 (set_max_size) ← 需要 heap 已初始化以调用 max_tlab_size()
  │                       │
  │                       ├──→ 阶段 4 (CompressedOops) ← 需要 heap 地址范围以判断模式
  │                       │
  │                       └──→ 阶段 5 (TLAB startup) ← 需要 heap 已初始化
```

关键时序约束：

- 阶段 2 必须在阶段 1 之后——`initialize()` 需要 `_collectedHeap` 指针已指向一个有效的（半初始化的）G1CollectedHeap 对象
- 阶段 3 必须在阶段 2 之后——`heap()->max_tlab_size()` 依赖 `initialize` 完成后的 Region 元数据
- 阶段 4 必须在阶段 2 之后——`reserved_region().end()` 只有在堆预约完成后才知道
- 阶段 5 必须在阶段 2 之后——TLAB 的 `initial_desired_size` 需要 `heap()->tlab_capacity(myThread())` 来算初始大小

---

## 7. 本文总结与后续文章路径

读完本文后你需要知道的：

- **`initialize_heap` 在 `universe_init` 内部第 687 行被调用**——这是整个阶段 6 的第一个返回值检查点
- **五个阶段**：`create_heap`（选 GC）→ `initialize`（分配堆内存 + 创建数据区 + 启动 GC 线程）→ `tlab_max_size` → `CompressedOops` → `tlab_startup`
- **阶段 2 是最重的一步**——G1CollectedHeap::initialize 的 201 行（22 个子步骤）比其余四个阶段加起来都重
- **G1 的堆创建是分两段的**——构造函数（92 行）做轻量创建，`initialize()`（201 行）做重量初始化

后续 02-07 的路径：

```
01 本文（全景）
│
├─→ 02 G1 Region 与策略
│    └─ setup_heap_region_size(47行) + setup_remset_size(13行) + initialize_all
│
├─→ 03 G1 骨干构建
│    └─ G1CollectedHeap 构造函数(92行) + Universe::reserve_heap
│
├─→ 04 G1 内存映射体系
│    └─ 6 个 Mapper + HeapRegionManager + CardTable + BarrierSet
│
├─→ 05 G1 并发标记初始化
│    └─ G1ConcurrentMark(~150行) + SATB/DirtyCard + ConcurrentRefinement + expand
│
├─→ 06 压缩指针与 TLAB
│    └─ CompressedOops(G1 视角) + TLAB startup(G1 特殊行为)
│
└─→ 07 完整串联
     └─ initialize_heap(62行) + G1::initialize(201行) 逐行拆解
```

**下一篇 ch11/02 从 `G1CollectorPolicy` 的构造函数开始**——Region 大小怎么算、RSet 表容量怎么定、`initialize_all` 三阶段各自校验什么。
