# universe_init —— JVM 运行时世界的 Genesis

> **本文定位**：`universe_init()` 全貌。75 行代码，是 `init_globals()` 第 10 个子函数——它之前 9 个都是 void，它第一个返回 `jint`。它创建 Java 堆、Metaspace、类加载器元数据、符号表，把 JVM 从"有线程没业务"推进到"能跑字节码"。

---

## 需要的前置知识

- ch04/01-overview `init_globals` 总览和依赖关系图
- ch06-ch09 Block A (`compilationPolicy_init`/`codeCache_init`/`VM_Version_init`/`stubRoutines_init1`)
- C++ 基础：`return` 语句、`#if` 条件编译

---

## 0. 源码清单

| 文件 | 行号 | 内容 |
|------|------|------|
| `universe.cpp` | 675-749 | `universe_init()` 完整 75 行 |
| `universe.hpp` | - | Universe 类静态字段声明 |
| `init.cpp` | 115-121 | `init_globals()` 中调用 `universe_init()` |
| `thread.cpp` | - | `create_vm` 阶段 6 调用 `init_globals()` |

---

## 1. 全貌

```cpp
jint universe_init() {
  assert(!Universe::_fully_initialized, "called after initialize_vtables");
  guarantee(1 << LogHeapWordSize == sizeof(HeapWord), "...");
  guarantee(sizeof(oop) >= sizeof(HeapWord), "...");
  guarantee(sizeof(oop) % sizeof(HeapWord) == 0, "...");
  TraceTime timer("Genesis", TRACETIME_LOG(Info, startuptime));

  JavaClasses::compute_hard_coded_offsets();              // ch10-04

  jint status = Universe::initialize_heap();               // → ch11  ★★★
  if (status != JNI_OK) return status;

  SystemDictionary::initialize_oop_storage();              // ch10-02
  Metaspace::global_initialize();                          // → ch12  ★★
  MetaspaceCounters::initialize_performance_counters();    // ch10-06
  CompressedClassSpaceCounters::initialize_performance_counters();
  #if INCLUDE_AOT
  AOTLoader::universe_init();
  #endif
  if (!JVMFlagConstraintList::check_constraints(           // ch10-05
        JVMFlagConstraint::AfterMemoryInit))
    return JNI_EINVAL;
  ClassLoaderData::init_null_class_loader_data();          // ch10-03
  Universe::_finalizer_register_cache = new LatestMethodCache();  // → ch15
  Universe::_loader_addClass_cache    = new LatestMethodCache();
  Universe::_pd_implies_cache         = new LatestMethodCache();
  Universe::_throw_illegal_access_error_cache = new LatestMethodCache();
  Universe::_throw_no_such_method_error_cache = new LatestMethodCache();
  Universe::_do_stack_walk_cache = new LatestMethodCache();
#if INCLUDE_CDS
  if (UseSharedSpaces) {
    MetaspaceShared::initialize_shared_spaces();           // → ch13  ★★
    StringTable::create_table();
  } else
#endif
  {
    SymbolTable::create_table();                           // → ch14
    StringTable::create_table();
  }
  ResolvedMethodTable::create_table();
  return JNI_OK;
}
```

开头 6 行是防御代码：assert 防止第二次调用，3 个 guarantee 是给移植者的编译期兜底（`LogHeapWordSize` 设错会崩溃）。`TraceTime` 计时整个函数——析构时输出 `[Genesis <耗时>ms]`。

真正的初始化从第 8 行开始。

---

## 2. 逐层拆解

### 2.1 `compute_hard_coded_offsets()` — 紧贴 GC 需求的字段偏移

在堆还没创建时，算出 `java.lang.ref.Reference` 的 `referent`/`queue`/`next`/`discovered` 四个字段在 oop 中的字节偏移。GC 一启动就需要遍历 Reference 链——翻 `InstanceKlass` 的 field layout 来查偏移量太慢，这里是编译期常量换算。

```cpp
java_lang_ref_Reference::referent_offset = member_offset(hc_referent_offset);
// member_offset = hc_offset * heapOopSize + base_offset_in_bytes
```

**细节在 [04-javaclasses-offsets.md](04-javaclasses-offsets.md)**。

### 2.2 `Universe::initialize_heap()` — 创建 GC 堆

```cpp
jint status = Universe::initialize_heap();
if (status != JNI_OK) return status;  // 第一个返回值检查
```

内部调用链：

```
Universe::initialize_heap()
  GCConfig::create_heap()          // 选 GC 类型，new CollectedHeap
  _collectedHeap->initialize()     // 堆内存预留 + 初始化
  compressed oops 设置              // 堆基址 + 编码模式（4 种）
  TLAB::startup_initialization()    // 线程本地分配缓冲
```

失败含义：堆创建失败（OOM）或 compressed oops 配置不兼容。这是 `universe_init` 的第一个返回值检查——失败直接返回，JVM 不启动。

**细节在 ch11**。

### 2.3 `SystemDictionary::initialize_oop_storage()` — GC 安全的全局 oop 存储

```cpp
_vm_weak_oop_storage =
  new OopStorage("VM Weak Oop Handles", VMWeakAlloc_lock, VMWeakActive_lock);
```

SystemDictionary 持有所有已加载类的 `java.lang.Class` 镜像、class loader 等全局 oop 引用。这些引用需要 GC 可见——OopStorage 就是专门解决这个问题的容器。Block/Slot 模型 + CAS 无锁分配 + GC 并发迭代。

**细节在 [02-oopstorage.md](02-oopstorage.md)**。

### 2.4 `Metaspace::global_initialize()` — 元数据空间

```cpp
Metaspace::global_initialize();
```

创建全局 VirtualSpaceList 和 ChunkManager，分配 compressed class space。之后所有 Klass、Method、ConstantPool 的元数据都在这里分配。

**细节在 ch12**。

### 2.5 计数器和 AOT — 监控管道 + 预编译加载

```cpp
MetaspaceCounters::initialize_performance_counters();
CompressedClassSpaceCounters::initialize_performance_counters();
AOTLoader::universe_init();  // #if INCLUDE_AOT
```

前两个创建 PerfData 计数器——jstat 显示的 MU/MC/MR 就来自这里。AOT 验证 narrow oop/klass shift 兼容后加载预编译的 .so。代码量小但意义不小——没有它们 Metaspace 内存排查就是盲的。

**细节在 [06-auxiliary-trivial.md](06-auxiliary-trivial.md)**。

### 2.6 `check_constraints(AfterMemoryInit)` — 堆和 Metaspace 就绪后的约束检查

```cpp
if (!JVMFlagConstraintList::check_constraints(JVMFlagConstraint::AfterMemoryInit))
  return JNI_EINVAL;  // 第二个返回值检查
```

JVM 有 800+ 启动参数，有些约束必须在堆大小确定之后才能验证。例如 `SurvivorRatio` 是否超过 `MaxHeapSize / space_alignment`、`TLABWasteIncrement` 是否超出 refill_waste_limit 范围。

约束系统有三个检查时机：`AtParse`（参数解析时）、`AfterErgo`（ergonomics 调整后）、`AfterMemoryInit`（universe_init 这里）。按顺序递增执行，`_validating_type` 单调递增保证不会乱序。

**细节在 [05-jvmflag-constraints.md](05-jvmflag-constraints.md)**。

### 2.7 `init_null_class_loader_data()` — bootstrap 类加载器的元数据容器

```cpp
_the_null_class_loader_data = new ClassLoaderData(Handle(), false);
ClassLoaderDataGraph::_head = _the_null_class_loader_data;
```

每个 ClassLoader 对应一个 `ClassLoaderData`（CLD）——记录它加载的所有 Klass 链表、持有自己的 Metaspace 和 Dictionary。bootstrap class loader 是 C++ 实现的，没有 Java 对象（`Handle()` 是空句柄），它的 CLD 永远不被卸载（`_keep_alive=1`）。

CLD 通过 `ClassLoaderDataGraph::_head` 串成全局链表——GC 遍历它来找到所有存活类。

**细节在 [03-classloader-data-null.md](03-classloader-data-null.md)**。

### 2.8 后置：LatestMethodCache + CDS/Table

```cpp
Universe::_finalizer_register_cache = new LatestMethodCache();
// ... 6 个 \
"单槽方法缓存" —— 每次调用固定用途的 Java 方法（如 Object.finalize），先查这个 1 槽缓存而非 SystemDictionary。命中率极高所以 1 槽够用。

```cpp
if (UseSharedSpaces) {
  MetaspaceShared::initialize_shared_spaces();  // 复用上次 CDS 归档的类
  StringTable::create_table();
} else {
  SymbolTable::create_table();                   // 新建符号表
  StringTable::create_table();                   // 新建字符串表
}
ResolvedMethodTable::create_table();
```

**细节分别在 ch15、ch13、ch14**。

---

## 3. 返回值——3 种路径

| 路径 | 返回值 | 触发条件 |
|------|--------|----------|
| 正常 | `JNI_OK` | 全部成功 |
| 堆失败 | `status`（透传） | `initialize_heap()` 返回非 0 |
| 约束失败 | `JNI_EINVAL` | `check_constraints()` 返回 false |

`init_globals()` 检查 `universe_init()` 的返回值——失败意味着 JVM 创建失败，`create_vm` 做 `main_thread->smr_delete()` 后退出。

---

## 4. 本章地图

| 篇 | 文件 | 知识点 |
|----|------|--------|
| 01 | 本文 | universe_init 全貌、逐层拆解、返回值 |
| 02 | [02-oopstorage.md](02-oopstorage.md) | OopStorage——Block/Slot + CAS + GC 并发迭代 |
| 03 | [03-classloader-data-null.md](03-classloader-data-null.md) | CLD 核心结构 + Graph 链表 + null CLD |
| 04 | [04-javaclasses-offsets.md](04-javaclasses-offsets.md) | hc_ 偏移量转换 + member_offset 公式 + InjectedField |
| 05 | [05-jvmflag-constraints.md](05-jvmflag-constraints.md) | JVMFlag 约束系统——3 个检查时机 + 注册机制 |
| 06 | [06-auxiliary-trivial.md](06-auxiliary-trivial.md) | MetaspaceCounters/CompressedClassSpaceCounters/AOTLoader |
| 07 | [07-metaspace.md](07-metaspace.md) | Metaspace 背景——VSL/Node/ChunkManager/SpaceManager + OccupancyMap + MetaspaceGC + purge + JEP 387 演进 |

不属于 ch10 的 `universe_init` 子函数：
- `Universe::initialize_heap()` → ch11（10 篇，按设计决策组织）
- `Metaspace::global_initialize()` → 核心机制在 ch10/07，深入诊断在 ch12（2 篇）
- `MetaspaceShared::initialize_shared_spaces()` → ch13
- SymbolTable/StringTable/ResolvedMethodTable → ch14
- 6× LatestMethodCache → ch15
