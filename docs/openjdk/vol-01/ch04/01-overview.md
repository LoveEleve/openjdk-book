# 4.1 init_globals() 总览

Stage 4 结束时（参见 [3.6](#/openjdk/vol-01/ch03/06-main-thread-create)），JVM 拥有了第一个 `JavaThread` 对象——TLS 绑定完成、栈边界记录完成、守卫区保护到位、PerfData 计数器就绪。`ObjectMonitor::Initialize()` 也注册了 `synchronized` 的 7 个性能计数器。但 JVM 本质上还是个空壳——没有 Java 堆、没有解释器、没有编译器、没有 SystemDictionary，连 `java.lang.Object` 的 Klass 镜像都还不存在。

`create_vm` 阶段 6 的第二项就是填满这个空壳的入口：

```cpp
/* === src/hotspot/share/runtime/thread.cpp === */

  jint status = init_globals();
```

`init_globals()` 定义在 `src/hotspot/share/runtime/init.cpp`，函数体依次调用 **30 个子函数**，把 JVM 从"有线程没业务"推进到"能跑字节码的运行时"。本章（ch04）的任务就是把这 30 个函数以及背后的原理全部搞清楚。

---

## 两轮初始化：vm_init_globals vs init_globals

`init.cpp` 里定义了两个紧挨着的初始化函数。它们看起来相似，但执行时机、执行线程、性质都不同：

| 维度 | `vm_init_globals()` | `init_globals()` |
|------|---------------------|------------------|
| 调用时机 | 阶段 4 | 阶段 6 |
| 执行线程 | VM 线程（此时**还没有** JavaThread） | Java 线程（主线程已在阶段 5 登记为 JavaThread） |
| 函数数量 | 7 | 30 |
| 返回值 | `void`（不检查） | `jint`（3 个返回值检查点） |
| 性质 | **基础设施**：锁、日志、内存池、PerfData 共享内存 | **业务系统**：堆、解释器、编译器、SystemDictionary |
| 代表子函数 | `mutex_init` / `eventlog_init` / `chunkpool_init` | `universe_init` / `interpreter_init` / `compileBroker_init` |
| 已讲章节 | ch03/05、06 | **本章 ch04** |

为什么必须分两轮？`vm_init_globals()` 执行时连 `JavaThread` 都不存在——`Thread::current()` 返回的是裸 OS 线程，没有 HandleMark、没有 ResourceArea、没有 JNIHandleBlock。所以这一轮只能做不依赖 JavaThread 的"裸"初始化：注册全局锁、建事件日志池、建 ChunkPool、映射 PerfData 共享内存。等到阶段 5 把主线程登记为 `JavaThread` 之后，`init_globals()` 才能在"有线程承载"的前提下初始化堆、解释器、编译器这些会创建 Handle、会分配 ResourceArea 的业务系统。

`init_globals()` 第一行是 `HandleMark hm;`——这正是"在 Java 线程上下文中执行"的标志。`HandleMark` 是 RAII 对象，构造时记录当前线程 HandleMark 栈顶位置，析构时释放本区间内创建的临时 Handle。后续 `universe_post_init()` 会预分配 6 个 OOM 异常实例，这些操作会创建 Handle；`HandleMark hm` 确保临时 Handle 在 `init_globals()` 返回时被清理，而持久的预分配实例由 `Universe` 静态字段持有不会被误释放。`vm_init_globals()` 里没有这一行——因为它执行时还没有 HandleMark 栈。

---

## init_globals() 全貌源码

`init_globals()` 的完整函数体：

```cpp
/* === src/hotspot/share/runtime/init.cpp === */

jint init_globals() {
  HandleMark hm;
  management_init();
  bytecodes_init();
  classLoader_init1();
  compilationPolicy_init();
  codeCache_init();
  VM_Version_init();
  os_init_globals();
  stubRoutines_init1();
  jint status = universe_init();  // dependent on codeCache_init and
                                  // stubRoutines_init1 and metaspace_init.
  if (status != JNI_OK)
    return status;

  gc_barrier_stubs_init();   // depends on universe_init, must be before interpreter_init
  interpreter_init();        // before any methods loaded
  invocationCounter_init();  // before any methods loaded
  accessFlags_init();
  templateTable_init();
  InterfaceSupport_init();
  VMRegImpl::set_regName();  // need this before generate_stubs (for printing oop maps).
  SharedRuntime::generate_stubs();
  universe2_init();  // dependent on codeCache_init and stubRoutines_init1
  javaClasses_init();// must happen after vtable initialization, before referenceProcessor_init
  referenceProcessor_init();
  jni_handles_init();
#if INCLUDE_VM_STRUCTS
  vmStructs_init();
#endif // INCLUDE_VM_STRUCTS

  vtableStubs_init();
  InlineCacheBuffer_init();
  compilerOracle_init();
  dependencyContext_init();

  if (!compileBroker_init()) {
    return JNI_EINVAL;
  }

  if (!universe_post_init()) {
    return JNI_ERR;
  }
  stubRoutines_init2(); // note: StubRoutines need 2-phase init
  MethodHandles::generate_adapters();

#if INCLUDE_NMT
  // Solaris stack is walkable only after stubRoutines are set up.
  // On Other platforms, the stack is always walkable.
  NMT_stack_walkable = true;
#endif // INCLUDE_NMT

  // All the flags that get adjusted by VM_Version_init and os::init_2
  // have been set so dump the flags now.
  if (PrintFlagsFinal || PrintFlagsRanges) {
    JVMFlag::printFlags(tty, false, PrintFlagsRanges);
  }

  return JNI_OK;
}
```

源码里的注释是理解依赖关系的关键——每个 `// depends on ...` 或 `// must be before ...` 都是一条硬约束。下一节的时序图按这些约束组织。

---

## 30 项执行时序

按执行顺序和功能聚合，30 个子函数可归为 5 个 Block。★ 数量代表重要度（★★★ = 阶段中枢，★★ = 重量级，★ = 有实质内容，无星 = trivial 单行委托）：

```
init_globals()
│
├─ HandleMark hm                                 RAII，标记 Handle 区边界
│
├─ [Block A] 前置轻量（universe_init 的依赖项）
│  ├─ management_init()                    JMX 管理初始化
│  ├─ bytecodes_init()                     字节码表（trivial）
│  ├─ classLoader_init1()                  类加载器（trivial）
│  ├─ compilationPolicy_init()       ★    编译策略
│  ├─ codeCache_init()              ★★   代码缓存
│  ├─ VM_Version_init()                   CPU 特性检测
│  ├─ os_init_globals()                    OS 全局（依赖 VM_Version_init）
│  └─ stubRoutines_init1()                存根例程 phase1（trivial）
│
├─ [Block B] universe_init  ★★★  阶段 6 中枢
│  └─ 返回值检查 #1：status != JNI_OK → return status
│     ├─ Universe::initialize_heap()            堆创建 + compressed oops + TLAB
│     ├─ Metaspace::global_initialize()         元空间
│     ├─ 6× new LatestMethodCache()              finalizer/register 等方法缓存
│     └─ SymbolTable / StringTable / ResolvedMethodTable ::create_table()
│
├─ [Block C] 解释器与运行时
│  ├─ gc_barrier_stubs_init()              GC 屏障存根（依赖 universe_init）
│  ├─ interpreter_init()             ★    解释器（before any methods loaded）
│  ├─ invocationCounter_init()            调用计数器（trivial）
│  ├─ accessFlags_init()                  访问标志（trivial，仅 assert）
│  ├─ templateTable_init()                模板表（trivial）
│  ├─ InterfaceSupport_init()             接口支持
│  ├─ VMRegImpl::set_regName()            寄存器名（平台相关）
│  ├─ SharedRuntime::generate_stubs() ★   共享运行时存根
│  ├─ universe2_init()                    原始类加载
│  ├─ javaClasses_init()             ★   Java 类（after vtable，before referenceProcessor）
│  ├─ referenceProcessor_init()           引用处理器（trivial）
│  ├─ jni_handles_init()                  JNI 句柄（trivial）
│  └─ vmStructs_init()                    VM 结构（debug only，INCLUDE_VM_STRUCTS）
│
├─ [Block D] 编译器
│  ├─ vtableStubs_init()                  vtable 存根（trivial）
│  ├─ InlineCacheBuffer_init()            IC 缓冲（trivial）
│  ├─ compilerOracle_init()          ★    编译指令
│  ├─ dependencyContext_init()            依赖上下文（trivial）
│  └─ compileBroker_init()          ★    编译代理
│     └─ 返回值检查 #2：!compileBroker_init() → return JNI_EINVAL
│
└─ [Block E] 后置
   ├─ universe_post_init()        ★★    预分配异常实例（after compiler_init）
   │  └─ 返回值检查 #3：!universe_post_init() → return JNI_ERR
   ├─ stubRoutines_init2()               存根 phase2（trivial）
   ├─ MethodHandles::generate_adapters() 方法句柄适配器
   ├─ NMT_stack_walkable = true          本地内存跟踪（INCLUDE_NMT）
   └─ JVMFlag::printFlags()              标志最终打印
```

30 个子函数里，**12 个是 trivial 单行委托**（如 `bytecodes_init`、`accessFlags_init` 仅 `assert`）。真正有实质内容的约 10 个，其中 `universe_init`（76 行）和 `universe_post_init`（111 行）是两个重头戏。本章按 Block 分节展开，trivial 函数合并为"轻量委托清单"表格，不单独占节。

---

## 依赖关系与返回值检查

源码注释里埋了 6 条硬约束（`init.cpp` 行内注释）：

```
依赖链（从 init.cpp 注释提取）：

VM_Version_init ──→ os_init_globals                  // os depends on VM_Version, before universe
                         │
codeCache_init ─────┐    │
stubRoutines_init1 ─┼───→ universe_init               // universe depends on codeCache + stubRoutines
                    │      │
                    │      ↓
                    │   gc_barrier_stubs_init          // depends on universe, before interpreter
                    │      │
                    │      ↓
                    │   interpreter_init               // before any methods loaded
                    │   invocationCounter_init          // before any methods loaded
                    │
                    ├──→ universe2_init                // depends on codeCache + stubRoutines
                    │
                    │      javaClasses_init             // after vtable, before referenceProcessor
                    │           │
                    │           ↓
                    │   referenceProcessor_init
                    │
                    └──→ ... ──→ compileBroker_init ──→ universe_post_init
                                                       // post_init must be after compiler_init
```

**3 个返回值检查点**——只有这 3 个函数的失败会让 `init_globals()` 提前返回，其余 27 个函数都是 `void` 或返回值被忽略：

| # | 函数 | 失败返回值 | 失败含义 |
|---|------|-----------|----------|
| 1 | `universe_init()` | `status`（透传） | 堆/Metaspace/CDS 创建失败，或 `AfterMemoryInit` 约束检查失败返回 `JNI_EINVAL` |
| 2 | `compileBroker_init()` | `JNI_EINVAL` | 编译指令文件解析失败（`DirectivesParser::parse_from_flag()`） |
| 3 | `universe_post_init()` | `JNI_ERR` | 预分配 OOM/NPE 等异常实例失败，或 `heap->post_initialize()` 失败 |

`init_globals()` 的返回值在 `create_vm` 阶段 6 被检查——失败时 `main_thread->smr_delete()` 删除主线程并设置 `*canTryAgain = false`，禁止重试。

---

## universe_init：阶段 6 的中枢

30 个子函数中，`universe_init()`（`universe.cpp`，76 行）是整个阶段的中枢。它的内部调用链：

```
universe_init()
├─ guarantee HeapWord/oop 大小约束              编译期布局自检
├─ JavaClasses::compute_hard_coded_offsets()    计算 Java 类硬编码偏移
├─ Universe::initialize_heap()         ★★★      堆创建
│   ├─ create_heap()                              GCConfig 选 GC 类型，new CollectedHeap
│   ├─ _collectedHeap->initialize()               堆内存预留 + 初始化
│   ├─ compressed oops 设置                        堆基址 + 编码模式（Unscaled/ZeroBased/HeapBased）
│   └─ ThreadLocalAllocBuffer::startup_initialization()  TLAB
├─ SystemDictionary::initialize_oop_storage()   oop 存储
├─ Metaspace::global_initialize()      ★★       元空间
├─ MetaspaceCounters / CompressedClassSpaceCounters ::initialize_performance_counters()
├─ AOTLoader::universe_init()                    INCLUDE_AOT
├─ JVMFlagConstraintList::check_constraints(AfterMemoryInit)  返回 JNI_EINVAL
├─ ClassLoaderData::init_null_class_loader_data() null ClassLoader 的 ClassLoaderData
├─ 6× new LatestMethodCache()                    finalizer_register / loader_addClass /
│                                                pd_implies / throw_illegal_access /
│                                                throw_no_such_method / do_stack_walk
├─ [CDS 分支] MetaspaceShared::initialize_shared_spaces()  UseSharedSpaces
│            或 SymbolTable::create_table() + StringTable::create_table()
└─ ResolvedMethodTable::create_table()
```

`universe_init` 之所以是中枢，因为它建立了后续所有 Java 代码运行的物质基础——堆（对象分配）、Metaspace（Klass/metadata）、符号表（SymbolTable/StringTable，Java 字符串和符号的 intern）、方法缓存（`LatestMethodCache`，JVM 反射调用 Java 方法的 fast path）。它之后的 `interpreter_init`、`universe2_init`、`javaClasses_init` 都依赖这些已就绪。

堆与 GC 的细节在本章 4.4 节完整展开（不依赖 ch11-heap，自包含讲解 `Universe::initialize_heap` 的堆预留、compressed oops 三种模式、TLAB 启动）。

---

## 章节地图

本章按 Block 分为 7 个子节：

| 节 | 文件 | Block | 覆盖函数 | 重头戏 |
|----|------|-------|---------|--------|
| 4.1 | 本文件 | — | 总览 | — |
| 4.2 | [02-pre-universe-light.md](#/openjdk/vol-01/ch04/02-pre-universe-light) | A（前 4 项） | management / bytecodes / classLoader / compilationPolicy | compilationPolicy_init |
| 4.3 | [03-codecache-stubs.md](#/openjdk/vol-01/ch04/03-codecache-stubs) | A（后 4 项） | codeCache / VM_Version / os_init_globals / stubRoutines_init1 | codeCache_init（委托 CodeCache::initialize） |
| 4.4 | [04-universe-init.md](#/openjdk/vol-01/ch04/04-universe-init) | B | universe_init + gc_barrier_stubs_init | universe_init ★★★ |
| 4.5 | [05-interpreter-java-classes.md](#/openjdk/vol-01/ch04/05-interpreter-java-classes) | C | 解释器/模板表/运行时存根/universe2/javaClasses 等 12 项 | interpreter_init / generate_stubs / javaClasses_init |
| 4.6 | [06-compiler-init.md](#/openjdk/vol-01/ch04/06-compiler-init) | D | vtableStubs / ICB / compilerOracle / dependencyContext / compileBroker | compileBroker_init |
| 4.7 | [07-post-init.md](#/openjdk/vol-01/ch04/07-post-init) | E | universe_post_init / stubRoutines_init2 / MethodHandles / NMT / Flags | universe_post_init ★★ |

下一节（4.2）从 Block A 的前 4 个轻量函数开始——`management_init`（JMX）、`bytecodes_init`、`classLoader_init1`、`compilationPolicy_init`。它们是 `universe_init` 的前置依赖中最轻的一组，多数是 trivial 委托，为 4.3 的 `codeCache_init` 和 4.4 的 `universe_init` 做铺垫。
