# universe_init —— JVM 运行时世界的 Genesis

> **前置依赖**：[ch04 init_globals 总览](openjdk/vol-01/ch04/01-overview.md) 了解了 30 项初始化时序；[ch05-ch08](openjdk/vol-01/ch05) 走完了 Block A（codeCache、stubRoutines、VM_Version、os_init_globals）
> **后续**：[ch10 initialize_heap](openjdk/vol-01/ch10) 展开 G1 堆细节；[ch12 三表](openjdk/vol-01/ch12) 展开 SymbolTable/StringTable/ResolvedMethodTable 初始化

---

Block A 的 8 步走完，`init_globals()` 做了不少事——JMX 管理注册了、字节码表填了、CodeCache 三段堆分配了、CPU 特性检测完了。但 JVM 本质上还是个空壳。

没有堆。`new Object()` 没法分配内存。没有 Metaspace——连 `java.lang.Object` 这个类的元数据（Klass）都没地方存。没有 SymbolTable——类名、方法名、签名这些字符串散落在各处，每次比较都要 `strcmp`。类字典不存在，`forName("java.lang.String")` 只会给你一个 NULL。

`universe_init()` 是填这个坑的入口。75 行代码，`init_globals()` 里排第 9——之前 8 个函数都是 `void`（不检查失败），从它开始返回值真正有意义。堆创建可能因为系统内存不够失败，compressed oops 编码可能和堆基址冲突，这些失败不能忽略。

---

## 为什么不放在更前面？

`init.cpp` 的声明里藏着两条约束（`L58/60`）：

```cpp
// init.cpp:58
void os_init_globals();        // depends on VM_Version_init, before universe_init
// init.cpp:60
jint universe_init();          // depends on codeCache_init and stubRoutines_init
```

展开成依赖图：

```
codeCache_init ─────┐
stubRoutines_init1 ─┤──→ universe_init
VM_Version_init ─────┤
os_init_globals ─────┘
```

四条理由是逐步递进的。

`codeCache_init` 在 ch06 里做了 CodeCache 三段堆分配——NonNMethod 堆（5MB，放 stub/adapter）、Profiled 堆（22MB）、NonProfiled 堆（21MB）。`universe_init` 内部不直接调 CodeCache，但紧接其后的 `interpreter_init` 需要通过 `TemplateInterpreterGenerator::generate_all()` 把 202 个字节码的汇编桩写入 code cache。CodeCache 不存在，解释器模板无法生成——解释器启动不了。所以 CodeCache 在 `universe_init` 之前分配好，不是 `universe_init` 要用它，是 `universe_init` 之后的步骤要用它。

`stubRoutines_init1` 在 ch08 里注册了一组全局函数指针——`call_stub`（C++ 调用 Java 的入口桩）、`forward_exception_entry`（异常转发）、`atomic_cmpxchg` 等原子操作用例程。compressed oops 的编解码最终走这些汇编桩——`arrayof_oop_copy` 在压缩指针和解压指针之间切换时调用 stub。如果 stubRoutines 没注册，`initialize_heap` 里的 compressed oops 编码阶段找不到编解码入口——不是编译错误，是运行时 `NULL` 函数指针调用，直接 SIGSEGV。

`VM_Version_init` 在 ch07 里执行了 CPUID 指令，把 42 个特性位（SSE、AVX、AES 等）写入 `_features` 掩码，同时把 CPU 核数、L1 cache line 大小、虚拟化类型写入全局字段。`universe_init` 的调用链中有 `Metaspace::global_initialize()`——Metaspace 的 VirtualSpaceList 预留策略依赖 `UseLargePages` flag 和 NUMA 拓扑信息，而这些 flag 的值来自 `VM_Version_init` 的 CPU 检测结果。如果 CPU 不支持大页但 Metaspace 按大页分配——`mmap` 返回 `MAP_FAILED`，Metaspace 初始化静默失败，后续第一次类加载时崩溃。

`os_init_globals` 是最简单的——Linux 上它是个空函数。真正 OS 级的初始化（信号处理器、线程调度、页大小）在更早的 `os::init()` 和 `os::init_2()` 里完成了。这个空壳留在这里是为了平台兼容——某些嵌入式/实时系统在堆创建之前需要额外的 OS 级设置。Linux 不需要，所以一行都不执行。

四条约束不是随便排的——它们是 JVM 开发者从几十年的移植经验里总结出来的。随便调换顺序，在 x86 Linux 上可能"碰巧"能跑（CodeCache 先分还是后分反正内存刚好够），但换成 ARM 嵌入式平台就崩了。

---

## 全貌

`universe.cpp:675-749`，75 行。先完整看一遍——不需要立刻理解每行，知道有什么就够了。

```cpp
jint universe_init() {
  assert(!Universe::_fully_initialized, "called after initialize_vtables");
  guarantee(1 << LogHeapWordSize == sizeof(HeapWord), "...");
  guarantee(sizeof(oop) >= sizeof(HeapWord), "...");
  guarantee(sizeof(oop) % sizeof(HeapWord) == 0, "...");
  TraceTime timer("Genesis", TRACETIME_LOG(Info, startuptime));

  JavaClasses::compute_hard_coded_offsets();

  jint status = Universe::initialize_heap();
  if (status != JNI_OK) return status;

  SystemDictionary::initialize_oop_storage();
  Metaspace::global_initialize();
  MetaspaceCounters::initialize_performance_counters();
  CompressedClassSpaceCounters::initialize_performance_counters();
  AOTLoader::universe_init();

  if (!JVMFlagConstraintList::check_constraints(
        JVMFlagConstraint::AfterMemoryInit))
    return JNI_EINVAL;

  ClassLoaderData::init_null_class_loader_data();

  Universe::_finalizer_register_cache = new LatestMethodCache();
  Universe::_loader_addClass_cache    = new LatestMethodCache();
  Universe::_pd_implies_cache         = new LatestMethodCache();
  Universe::_throw_illegal_access_error_cache = new LatestMethodCache();
  Universe::_throw_no_such_method_error_cache = new LatestMethodCache();
  Universe::_do_stack_walk_cache = new LatestMethodCache();

  if (UseSharedSpaces) {
    MetaspaceShared::initialize_shared_spaces();
    StringTable::create_table();
  } else {
    SymbolTable::create_table();
    StringTable::create_table();
  }
  ResolvedMethodTable::create_table();
  return JNI_OK;
}
```

前 6 行是防御，后面才是真正的业务逻辑。`assert` 挡重复调用——`universe_init` 只能调一次，第二次进来 `_fully_initialized` 已经是 `true` 了，断言直接崩。三个 `guarantee` 是给移植者的安全网——`LogHeapWordSize` 这个宏在不同平台上意义不同（一个 HeapWord 可能是 4 字节也可能是 8 字节），设错了 `oop` 的大小就对不上了，这个 guarantee 让程序在启动时就崩溃而不是运行中随机出现内存越界。`TraceTime` 是计时器——构造时记录当前时间，析构时输出 `[Genesis <ms>ms]`，你可以在 `-Xlog:startuptime=info` 的日志里看到它。

真正的活从 `compute_hard_coded_offsets()` 开始。

---

## GC 需要的四个字段偏移量

```cpp
JavaClasses::compute_hard_coded_offsets();
```

这行做的事情小，但位置很关键——在堆创建**之前**，在 GC 需要**之前**。

GC 在标记 `java.lang.ref.Reference` 子类对象时，要沿着 `referent → queue → next → discovered` 这四个字段的引用链往下走。这四个字段在 `Reference` 类里是 `private` 的——JDK 代码随便改它们的声明顺序，GC 不能假设"queue 在 referent 后面 8 个字节"。但 GC 的热路径上又不能每次都翻 `InstanceKlass` 的 field layout 查偏移。

HotSpot 的做法是把这四个偏移量在编译期算好，存成全局常量：

```cpp
// JavaClasses::compute_hard_coded_offsets() 内部
java_lang_ref_Reference::referent_offset  = member_offset(hc_referent_offset);
java_lang_ref_Reference::queue_offset     = member_offset(hc_queue_offset);
java_lang_ref_Reference::next_offset      = member_offset(hc_next_offset);
java_lang_ref_Reference::discovered_offset = member_offset(hc_discovered_offset);
```

`hc_` 前缀的值来自 HotSpot 编译期硬编码——不是运行时从 JDK 的 `Reference.class` 里反射出来的，是一个写死在 HotSpot 源码里的偏移量。前提是 HotSpot 的编译版本和 JDK 的类布局必须一致——JDK 改了 `Reference` 的字段顺序，HotSpot 也得同步改这个硬编码值。不一致的话 GC 会读到错误的内存位置——不是 crash 就是静默数据损坏。

这四个偏移量在 `initialize_heap` 后面的 compressed oops 编码阶段就要用到——`oopDesc::encode_heap_oop` 在编码/解码 oop 时需要知道 referent 字段的偏移，因为压缩指针的编码模式对 referent 字段有特殊处理。算偏移在前、建堆在后——逻辑上先准备数据再分配空间。

---

## initialize_heap——Java 对象的物理空间

```cpp
jint status = Universe::initialize_heap();
if (status != JNI_OK) return status;
```

两行。但这两行是整个 `universe_init` 第一个"真可能失败"的地方，也是整个 `init_globals()` 30 步中第一个返回值检查点。

`Universe::initialize_heap()` 在 `universe.cpp:765`，内部调用链：

```
Universe::initialize_heap()
  GCConfig::arguments()->create_heap()
    // 根据 UseG1GC / UseParallelGC / UseSerialGC / UseZGC 选择 CollectedHeap 子类
    // 本卷讲的是 G1：new G1CollectedHeap()
  _collectedHeap->initialize()
    // G1: 计算 heap region 大小 → 预留堆地址空间 → 创建 G1 子结构
    //   G1ConcurrentMark、G1RemSet、CardTable、G1CollectorPolicy...
  compressed oops 编码
    // 根据堆基址自动选择 4 种编码模式之一
  TLAB::startup_initialization()
    // 初始化 Thread-Local Allocation Buffer 的全局参数
```

G1 的堆创建在 ch10 有整整 18 篇文章的篇幅展开。这里只需要理解为什么它是 `universe_init` 的核心——因为它创建了 Java 程序赖以生存的物理空间。没堆，`new Object()` 就是非法的。没堆，后面 `interpreter_init` 生成 202 条字节码的模板桩之后，这些桩的第一个 `new` 指令就会撞墙。

compressed oops 是一个值得在这里停下来讲清楚的设计。Java 对象在堆里的地址是 64 位的（x86_64），但如果每个 oop（ordinary object pointer）都存 64 位，不但对象头大，cache line 的利用率也低。HotSpot 的 compressed oops 把 64 位 oop 压缩成 32 位——前提是堆的基址和大小满足某些条件。

编码公式是 `narrow_oop = (oop - heap_base) >> shift`。`heap_base` 是堆的起始地址，`shift` 是对象对齐粒度（默认 8 字节对齐所以 shift=3）。解码时反过来：`oop = (narrow_oop << shift) + heap_base`。

根据堆基址的不同，有四种编码模式：

- **Unscaled**：堆基址为 0 且堆 ≤ 4GB——`narrow_oop` 直接用 32 位存地址，解码时只做 shift
- **ZeroBased**：堆基址不为 0 但 ≤ 32GB——解码时 `narrow_oop << 3` 直接得到 32 位地址，无需加基址
- **DisjointBase**：堆基址 > 32GB——`narrow_oop` 从堆基址开始计数，是相对偏移而非绝对地址
- **HeapBased**：DisjointBase 的变体，使用堆本身的某一段地址作为编码基准

`initialize_heap` 内部自动探测——先尝试 Unscaled，不行换 ZeroBased，以此类推。如果四种模式都不兼容（比如你显式设了 `-XX:ObjectAlignmentInBytes=16` 同时堆 > 64GB），JVM 拒绝启动，不给你搞成 64 位 oops 默默降性能。

---

## SystemDictionary 和 OopStorage

```cpp
SystemDictionary::initialize_oop_storage();
```

堆有了，但堆里的全局对象需要被 GC 追踪。`SystemDictionary` 是一个特殊的字典——它持有所有已加载类的 `java.lang.Class` 镜像。一个典型的 JVM 进程加载 20,000+ 个类，每个类的 `Class` 对象都是堆上的 oop。

如果 `SystemDictionary` 用 `oop*` 数组直接存这些引用——GC 的并发标记阶段可能在遍历这个数组的同时，别的线程（或者 GC 自己的清理线程）正在移除数组元素。CAS 无锁数组的并发删除是可能的——但 Java 的 class 卸载频繁度远超直觉（自定义 ClassLoader 加载的临时类、lambda 的代理类），用普通数组管理的复杂度太高。

HotSpot 的答案是 `OopStorage`——一个专门为 GC 并发访问设计的容器。内部结构是 Block/Slot 两层：

```
OopStorage
  └── Block[] (固定大小数组，每个 Block = 4KB 或 8KB)
       └── Slot[] (每个 Slot = 一个 oop*，两个相邻 Slot 形成双向链表节点)
```

分配新 oop 引用时，从一个空闲 Slot 链表里 CAS 取一个节点，写入 oop 地址。删除引用时，CAS 把 Slot 插回空闲链表。GC 遍历时直接顺序扫 Block 数组——不需要关心哪些 Slot 是空闲的，只要读到的 oop 不是 NULL 就追下去。Slot 链表只在"分配"和"删除"两个写路径上被修改——GC 的读路径完全不碰链表，避免了读写竞争。

`OopStorage` 的详细实现在 ch09/02。这里只需要知道 `initialize_oop_storage()` 创建了一个全局 OopStorage 实例，后续 class loading 的所有 SystemDictionary 操作都通过它存取。

---

## Metaspace——类元数据的家园

```cpp
Metaspace::global_initialize();
```

Java 对象存在堆里，但 Java 类的元数据（`InstanceKlass`、`Method`、`ConstantPool`、`ConstantPoolCache`）存哪里？JDK 7 以前它们也在堆里——PermGen。问题是用 `-XX:MaxPermSize=256m` 限制最大空间，一旦超过就 OOM，不管你物理内存还有多少 GB 空闲。Spring 应用经常因为动态代理、CGLIB、lambda 表达式生成大量类而撑爆 PermGen。

JDK 8 开始把这些元数据移出了堆——独立的内存区域叫 Metaspace。Metaspace 由多个 VirtualSpaceNode 组成，每个 VirtualSpaceNode 向 OS 预留一块连续虚拟地址空间（比如 2MB），然后通过 ChunkManager 切分成不同大小的 chunk 分配给各个类加载器。chunk 的粒度从 1KB（放小对象）到 64KB（放大对象）不等。

`global_initialize()` 做的事就是创建全局的 VirtualSpaceList 和 ChunkManager——之后每个 ClassLoader 加载类时，Metaspace 为它的 Klass、Method、ConstantPool 等元数据分配 chunk 空间。

跟在后面的两行：

```cpp
MetaspaceCounters::initialize_performance_counters();
CompressedClassSpaceCounters::initialize_performance_counters();
```

注册了 Metaspace 的 PerfData 计数器。`jstat -gc` 看到的 MU（Metaspace Used）和 MC（Metaspace Capacity）就来自这里。没有这些计数器，你的 Metaspace 快满了你都不知道——GC 日志不单独报 Metaspace 使用率，`jcmd` 的诊断命令也依赖这些 PerfData 注册。

Metaspace 的完整机制——VirtualSpaceNode 的内部布局、ChunkManager 的分配/回收算法、MetaspaceGC 的扩容触发条件——在 ch09/07 和 ch12 展开。

---

## 约束检查——参数打架了没有

```cpp
if (!JVMFlagConstraintList::check_constraints(
      JVMFlagConstraint::AfterMemoryInit))
  return JNI_EINVAL;
```

HotSpot 有 800+ 启动参数，很多之间有隐式约束。比如 `SurvivorRatio` 定义 Eden:Survivor = N:1——Eden 是 Survivor 的 N 倍——但如果 `N * SurvivorSize > MaxHeapSize`，Eden 就把堆空间吃光了。

约束系统有三个检查时机：

- **AtParse**：参数刚解析完。只能做"值域检查"——`SurvivorRatio` 不能是负数。
- **AfterErgo**：ergonomics 自动调优后。`Flags::apply_ergo()` 根据 CPU 核数、物理内存自动推算了 `MaxHeapSize` 等默认值——现在可以检查"两个 ergo 得出的值是否矛盾"。
- **AfterMemoryInit**：此刻。堆和 Metaspace 的大小已经确定——可以检查"堆大小的约束是否和 Metaspace 大小的约束兼容"。

`AfterMemoryInit` 是最晚也是范围最广的检查——任何依赖堆/Metaspace 大小的约束都在这里验证。通过了就继续，不通过就 `JNI_EINVAL`——JVM 拒绝启动，因为参数矛盾意味着用户意图无法实现。

ch09/05 展示约束系统的注册和分发机制——每个 flag constraint 通过 `JVMFlagConstraintList::register_constraint()` 注册自己的检查函数和检查时机，`check_constraints()` 遍历所有标记了对应该时机的约束挨个调用。

---

## bootstrap 类加载器的锚点

```cpp
ClassLoaderData::init_null_class_loader_data();
```

每个 ClassLoader 对应一个 `ClassLoaderData`（CLD）。CLD 是一个结构体，记录了这个 ClassLoader 加载的所有类：

```cpp
class ClassLoaderData {
  ClassLoaderData* _next;           // 全局链表指针
  Klass* _klasses;                  // 加载的所有 Klass 链表头
  Metaspace* _metaspace;            // 属于这个 CLD 的 Metaspace
  Dictionary* _dictionary;          // 类名 → Klass 的字典
  bool _keep_alive;                 // 是否永驻（bootstrap CLD = true）
  OopHandle _class_loader;          // Java 层的 ClassLoader 对象引用
};
```

bootstrap class loader 是 C++ 实现的——没有 Java 端的 `java.lang.ClassLoader` 对象——所以 `_class_loader` 存的是一个空 `Handle()`。`_keep_alive = true` 意味着 GC 不能卸载它——bootstrap 加载的 JDK 核心类（`java.lang.Object`、`java.lang.String` 等）永远不会被卸载。

所有 CLD 通过 `_next` 指针串成全局链表——`ClassLoaderDataGraph::_head` 指向链表头。GC 的 root scanning 阶段从这个链表出发遍历每一个 CLD 里的 `_klasses` 链表——这样就找到了所有存活类。类卸载时（自定义 ClassLoader 被 GC），CLD 节点从链表移除，对应的 Metaspace chunk 被回收。

ch09/03 展开 CLD 的完整结构和 Graph 遍历机制。

---

## 收尾——缓存和表

函数最后的 20 行做了三件事。

第一件，创建 6 个 `LatestMethodCache`：

```cpp
Universe::_finalizer_register_cache = new LatestMethodCache();
Universe::_loader_addClass_cache    = new LatestMethodCache();
Universe::_pd_implies_cache         = new LatestMethodCache();
Universe::_throw_illegal_access_error_cache = new LatestMethodCache();
Universe::_throw_no_such_method_error_cache = new LatestMethodCache();
Universe::_do_stack_walk_cache = new LatestMethodCache();
```

JVM 的 C++ 代码在某些路径上需要调 Java 方法。GC 的 `Object.finalize()` 调用路径要调 `Finalizer.register(Object)`。类加载器路径要调 `ClassLoader.addClass(Class)`。栈回溯路径要调 `StackStreamFactory$AbstractStackWalker.doStackWalk()`。

朴素做法每次现查——用方法名和签名在 Klass 的方法数组里逐个比对，`strcmp` + 数组遍历 = O(n*m)。但这些方法调用频率极高（每个带 finalize 的对象一次、每个类一次、每次栈回溯一次）。

`LatestMethodCache` 是单槽缓存——每个缓存存一个 `method_idnum`（方法在类中的索引编号，int）。启动时查一次填进去，运行时直接通过 `method_idnum` 拿到 `Method*` 指针——从 O(n*m) 降到 O(1)。6 个缓存对应 6 个高频调用点，各自独立不互相踢。

为什么只缓存 `method_idnum` 而不是 `Method*`？因为类被 redefine 时（JVMTI RedefineClasses），`Method*` 指针会过期。`method_idnum` 是稳定的——它是类方法表中的索引位置，redefine 后旧方法的位置被新方法占据，索引不变。通过 `method_idnum` 拿到的永远是当前类版本的最新 `Method*`。

ch13 展开 LatestMethodCache 的完整机制。

第二件，根据 CDS 是否开启决定表格创建方式：

```cpp
if (UseSharedSpaces) {
  MetaspaceShared::initialize_shared_spaces();
  StringTable::create_table();
} else {
  SymbolTable::create_table();
  StringTable::create_table();
}
```

CDS（Class Data Sharing）是 JDK 5 引入的启动加速技术——把 JVM 第一次启动时解析的类数据和符号表 dump 到一个归档文件（`classes.jsa`），后续启动直接 `mmap` 映射这个文件而不是重新解析 class 文件。

CDS 路径下，`MetaspaceShared::initialize_shared_spaces()` 做了两件事：(1) `mmap` 归档文件到内存，(2) 把共享符号表的地址赋给 `SymbolTable::_shared_table`。共享表里的 Symbol* 直接指向 mmap 的内存区域——不重新分配、不需要 `create_table`。但 StringTable 不能共享——字符串是堆对象，每次启动堆布局不同，必须新建。

非 CDS 路径下来，SymbolTable 和 StringTable 都是新建——`create_table()` 分配 hash bucket 数组，准备接收 class file 解析过程中产生的符号和字符串。

第三件，创建 `ResolvedMethodTable`：

```cpp
ResolvedMethodTable::create_table();
```

`ResolvedMethodTable` 是 `invokedynamic` 和 `MethodHandles` 的方法解析缓存——和 SymbolTable 不同的数据结构（用的 `Hashtable<ClassLoaderWeakHandle, mtClass>`），也不参与 CDS。

三条路汇成最后一行：`return JNI_OK`。

---

## 设计思考

前面写了为什么 `universe_init` 第一个返回 `jint`——它之前的函数操作"不可能失败"，它的核心操作（堆创建）可能失败。但还有一个更微妙的点：为什么 `compute_hard_coded_offsets()` 放在堆创建之前？

这两个操作的顺序其实可以调——`initialize_heap` 内部不读 `reference_offset` 这些值。但在 compressed oops 的编码阶段，`oopDesc::encode_heap_oop` 对 `Reference.referent` 字段有特殊处理——编码 deferent 时需要知道 referent_offset。编码在 `initialize_heap` 内部完成——所以实际上，如果 `compute_hard_coded_offsets` 放在 `initialize_heap` 之后也没问题，反正 `initialize_heap` 不直接用它。

那为什么 HotSpot 把它放在前面？逻辑上"算偏移"是纯计算（CPU 算几个数），"建堆"是分配几十 GB 内存（系统调用）。算偏移失败（几乎没有可能）比建堆失败便宜太多了——先做轻量操作遵循"快速失败"设计原则。但真要说严格的依赖关系——它们之间没有。

CDS 路径的 `if-else` 也有学问。SymbolTable 的创建被包在 `#if INCLUDE_CDS` 里，但 StringTable 在两个分支分别创建——不是提取到 if-else 外面共用一个。这是因为 CDS 路径的 StringTable 创建顺序有要求：`MetaspaceShared::initialize_shared_spaces()` 会检查共享归档的兼容性（JDK 版本、CPU 架构、GC 类型），通过后才创建 StringTable。如果提取到外面，非 CDS 路径会先创建 StringTable 再检查 CDS——检查失败时 StringTable 已经浪费了。

`ResolvedMethodTable` 不属于 CDS——invokedynamic 的解析结果不能跨启动复用，因为每次启动的 MethodHandle 目标可能不同（用户换了 JDK 版本、换了 classpath 的 jar）。它在 CDS if-else 之后独立创建，两个路径都执行它。
