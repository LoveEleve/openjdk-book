# 辅助子系统：PerfData / MetaspaceCounters / CompressedClassSpaceCounters / AOTLoader

> **本文定位**：`universe_init` 中三个轻量初始化函数——`MetaspaceCounters::initialize_performance_counters()`、`CompressedClassSpaceCounters::initialize_performance_counters()`、`AOTLoader::universe_init()`。代码量很小（每个不到 20 行），但支撑 `jstat`/`jconsole`/JMX 的 Metaspace 监控，以及 JDK 9/10 的 AOT 预编译加载。
>
> **前置知识**：PerfData 机制见 [ch04/02-management.md](../../ch04/02-management.md)——本文不重复讲解 mmap 共享内存、`create_counter` 工厂方法等。本文只讲计数器在 Metaspace 上的具体使用。
>
> 本文按 **PerfData 基础设施 -> MetaspaceCounters -> CompressedClassSpaceCounters -> AOTLoader -> 共同模式** 五层结构组织。

---

## 0. 完整源码清单

| 文件 | 行号 | 内容 |
|------|------|------|
| `runtime/perfData.hpp` | 665-877 | PerfDataManager 工厂方法 |
| `runtime/perfData.hpp` | 244-339 | PerfData 基类——Variability/Units/Flags |
| `runtime/perfMemory.hpp` | 114-165 | PerfMemory——mmap 共享内存管理器 |
| `os/linux/perfMemory_linux.cpp` | 56-75, 1306-1329 | create_memory_region 实现 |
| `memory/metaspaceCounters.cpp` | 32-133 | MetaspacePerfCounters + 两个 Counter 类 |
| `memory/metaspace.hpp` | 305-442 | MetaspaceUtils 四个查询方法 |
| `memory/metaspace.cpp` | 425-433 | committed/reserved 委托到 VirtualSpaceList |
| `memory/universe.cpp` | 675-702 | universe_init 中三次调用 |
| `code/aotLoader.cpp` | 171-210 | AOTLoader::universe_init() |
| `code/codeCache.cpp` | 387-402 | CodeCache::add_heap |

---

## 1. 第一层：PerfData —— JVM 的性能计数器基础设施

### 1.1 没有这层之前

用户运行 `jstat -gc <pid>` 看到 MU/MC/MR 时，这些数字是从一个共享内存文件里直接读出来的——不是解析日志，不是读 `/proc`。如果不用 PerfData，可用方案各有致命缺陷：

- `/proc/self/statm`：粒度太粗。只能看到进程的总 RSS/VSZ，不知道哪部分是 Metaspace、哪部分是 Heap
- 日志文件：每次查询需要打开、查找、解析，不能高频采样
- JMX Bean：JVM 启动早期（`universe_init` 阶段）Java 层未就绪，无法创建 MBean

PerfData 的方案：JVM 启动时 `mmap` 创建共享内存文件（`/tmp/hsperfdata_<user>/<pid>`），所有计数器序列化进去。`jstat`/`jconsole` 直接 mmap 同一个文件，读取开销几乎为零。

### 1.2 PerfData 的三个组织维度

PerfData 体系用三个维度组织计数器：

**CounterNS 名字空间**——决定前缀和稳定性：

```
SUN_GC   -> "sun.gc"     GC 指标（Metaspace、堆使用量）
SUN_CI   -> "sun.ci"     JIT 编译指标
SUN_RT   -> "sun.rt"     运行时指标（线程数、safepoint）
JAVA_NS  -> "java"       标准接口，跨版本稳定
COM_NS   -> "com.sun"    不稳定但受支持的接口
```

名字空间还编码了接口稳定性。HotSpot 用 `ns % 3` 分组：
- `ns % 3 == JAVA_NS`：稳定接口，JCP 标准约束，不能随便修改
- `ns % 3 == COM_NS`：不稳定但受支持
- 其余 SUN_NS：不稳定且不受支持——`jstat` 可读，但 HotSpot 不保证版本兼容

**Variability 变异性**——区分值的更新模式：

```cpp
// perfData.hpp:254-258
enum Variability {
  V_Constant  = 1,   // 初始化后不再变化
  V_Monotonic = 2,   // 只增不减（GC 累计次数）
  V_Variable  = 3,   // 可增可减（Metaspace 当前使用量）
};
```

**Units 单位**——`U_Bytes`、`U_Ticks`、`U_Events`、`U_Hertz`，决定监控工具如何解读数值。

### 1.3 Counter 和 Variable 的区别：为什么 Metaspace 用 Variable

`PerfDataManager` 提供两套创建方法：

```cpp
// perfData.hpp:833-836 —— 创建 PerfLongVariable（V_Variable）
static PerfVariable* create_variable(CounterNS ns, const char* name,
                                     PerfData::Units u, jlong ival, TRAPS);
```

```cpp
// perfData.hpp:854-857 —— 创建 PerfLongCounter（V_Monotonic）
static PerfCounter* create_counter(CounterNS ns, const char* name,
                                   PerfData::Units u, jlong ival, TRAPS);
```

`create_variable` 创建的计数器值可增可减。`create_counter` 创建的值只能通过 `inc()` 递增。Metaspace 计数器用 `create_variable`——因为 GC 后会回收 Class metadata，`used_bytes` 会下降。如果用 Counter 类型，`inc()` 无法表示减少。两者的写入都是写一个 `jlong` 到 mmap 区域，开销相同，但 Variability 标记让 `jstat` 区分了"绝对变化量"和"当前快照值"。

### 1.4 mmap 内存分配

PerfMemory 用三个指针管理 mmap 区域：

```cpp
// perfMemory.hpp:118-124
static char*  _start;       // 区域起始地址
static char*  _end;         // 区域结束地址
static char*  _top;         // 已分配边界
```

每个计数器通过 `PerfMemory::alloc(size)` 从区域内部分配——从 `_top` 切出 `size` 字节，`_top += size`，相当于在 mmap 内部做 bump allocator。所有计数器的名称和数值紧凑排列在这片区域中。

共享内存的创建逻辑优先尝试共享 mmap，失败回退到普通内存：

```cpp
// perfMemory_linux.cpp:1306-1327（缩略）
void PerfMemory::create_memory_region(size_t size) {
  if (PerfDisableSharedMem) {
    _start = create_standard_memory(size);    // 不共享，jstat 不可读
  } else {
    _start = create_shared_memory(size);      // 共享，jstat 可读
    if (_start == NULL) {
      PerfDisableSharedMem = true;
      _start = create_standard_memory(size);  // 回退
    }
  }
}
```

共享模式的文件路径 `/tmp/hsperfdata_<user>/<pid>`，权限限制为 owner 可读写——同用户的 `jstat` 进程可以 mmap 读取，其他用户不行。

jstat 读取时，先通过 `PerfDataFile.getFile(user, lvmid)` 定位文件（`vmId` 从输入参数或默认的当前 VM 中获取），然后 `mmap` 整个文件。PerfData 区域的头格式是 `PerfDataPrologue`，包含 entry 数量、魔数、字节序标志。jstat 按 entry_length 逐个跳转遍历所有 entry，根据 name 匹配需要读取的计数器。

PerfMemory 在 `vm_init_globals()` 阶段初始化——这是 `universe_init` 之前的很早期阶段。PerfDataManager 的 `_all` 列表在 `initialize_performance_counters()` 调用时才开始填充——在此之前 PerfMemory 区域已经分配好，只是空的。

---

## 2. 第二层：MetaspaceCounters —— 暴露 Metaspace 使用量

### 2.1 没有这层之前

`Metaspace::global_initialize()` 之后 VirtualSpaceList 和 ChunkManager 已就绪。但外部无法知道 Metaspace 状态——接近 OOM 时只能等 JVM 崩溃后从 hs_err 日志找原因。`MetaspaceCounters::initialize_performance_counters()` 把 Metaspace 的三种内存状态写入 PerfData，让 `jstat -gc` 实时显示。

> VirtualSpaceList 和 ChunkManager 是 Metaspace 内部的 native memory 管理结构——将单独文章讲解。本文只需要知道"元数据从现在起可以分配了"。

### 2.2 MetaspacePerfCounters 辅助类

`MetaspaceCounters` 和 `CompressedClassSpaceCounters` 共用内部类 `MetaspacePerfCounters`：

```cpp
// metaspaceCounters.cpp:49-57（缩略）
MetaspacePerfCounters(const char* ns, ...) {
  create_constant(ns, "minCapacity", min_capacity, THREAD);
  _capacity = create_variable(ns, "capacity", curr_capacity, THREAD);
  _max_capacity = create_variable(ns, "maxCapacity", max_capacity, THREAD);
  _used = create_variable(ns, "used", used, THREAD);
}
```

三个 Variable（可变）+ 一个 Constant（固定为 0）。`create_variable` 内部构造完整的 PerfData 名称：

```cpp
// metaspaceCounters.cpp:38-40
PerfVariable* create_variable(const char *ns, const char *name, ...) {
  const char *path = PerfDataManager::counter_name(ns, name);
  return PerfDataManager::create_variable(SUN_GC, path, ...);
}
```

`counter_name("metaspace", "used")` 生成 `"metaspace.used"`，`create_variable(SUN_GC, ...)` 拼上前缀 `"sun.gc"`，最终名称为 `"sun.gc.metaspace.used"`——jstat 读到的 MU。

### 2.3 数据源和关键命名约定

`MetaspaceCounters` 通过 `MetaspaceUtils` 查询，不直接操作 VirtualSpaceList：

```cpp
// metaspaceCounters.cpp:68-78
size_t MetaspaceCounters::used() {
  return MetaspaceUtils::used_bytes();          // NonClassType + ClassType
}
size_t MetaspaceCounters::capacity() {
  return MetaspaceUtils::committed_bytes();     // 注意：是 committed，不是 capacity
}
size_t MetaspaceCounters::max_capacity() {
  return MetaspaceUtils::reserved_bytes();
}
```

一个关键约定：`MetaspaceCounters::capacity()` 返回 `committed_bytes()`，不是 `MetaspaceUtils::capacity_bytes()`。jstat 的 MC 含义是"OS 已提交的物理内存"，不是"所有 chunk 的总容量"。

`MetaspaceUtils` 的四类查询来源不同：

- `used_bytes`：来自运行计数器 `_used_words[]`，由 SpaceManager 在每次分配/释放时原子更新
- `capacity_bytes`：来自 `_capacity_words[]` = used + free + waste + overhead（内部扩容决策用，jstat 不展示）
- `committed_bytes`：委托给 `VirtualSpaceList::committed_bytes()`——OS 实际分配了物理页的大小
- `reserved_bytes`：委托给 `VirtualSpaceList::reserved_bytes()`——OS 预留的虚拟地址空间总大小

MetaspaceCounters 对外暴露的是 used / committed / reserved 三级（对应 jstat 的 MU/MC/MR）。

四个状态的大小关系（通常情况）：

```
used < capacity < committed < reserved
```

- `used`（已分配）最小：实际被 class metadata 占用的字节
- `capacity`（chunk 总容量）更大：因为 chunk 内有空闲碎片（free + waste + overhead）
- `committed`（OS 提交）更大：VirtualSpace 在扩大时以 chunk 为单位提交物理页，但新提交的空间不一定立刻被分配为 chunk
- `reserved`（虚拟地址空间）最大：在 64 位系统上默认预留数 GB，但只提交用得到的小部分

注意这个关系不是绝对值保证的——在某些边界条件下（如 Metaspace 刚初始化、ClassType 和 NonClassType 分开统计），committed 可以等于 reserved。但 used < committed < reserved 是正常稳态下的典型关系。

### 2.4 四种状态差距的诊断意义

- `used` 接近 `committed`：Metaspace 用得很满，即将触发 GC 或扩容
- `committed` 接近 `reserved`：地址空间快用完，如果受 `-XX:MaxMetaspaceSize` 限制，这是 OOM 前兆
- `capacity` 远小于 `committed`：有大量已提交但未分配的 chunk——刚扩容，chunk 还没被领走

### 2.5 初始化和运行时更新

```cpp
// metaspaceCounters.cpp:80-87
void MetaspaceCounters::initialize_performance_counters() {
  if (UsePerfData) {
    _perf_counters = new MetaspacePerfCounters("metaspace", 0,
                                               capacity(), max_capacity(), used());
  }
}
```

初始化后，每次 GC 结束触发 `update_performance_counters()`，通过 `_capacity->set_value(...)` 直接写 mmap 中的 jlong。因为写是对齐的 8 字节原子操作，jstat 的读也是对齐的 8 字节读取，不需要锁。

`MetaspaceCounters::update_performance_counters()` 被 GC 的各阶段调用——具体在 `MetaspaceGC::compute_new_size()` 和 `CollectedHeap::post_full_gc_dump()` 中。这意味着 GC 结束后的瞬间是 jstat 获取最新 Metaspace 数据的最佳时间窗口。在 GC 执行期间，计数器值会暂时落后于实际使用量——但这不影响监控，GC 期间 Metaspace 处于可回收状态。

---

## 3. 第三层：CompressedClassSpaceCounters —— Klass 的独立统计

### 3.1 为什么 Klass 需要独立空间

64 位 JVM 上启用 Compressed Oops 时，`-XX:+UseCompressedClassPointers`（默认开启）把 Klass 对象从 Metaspace 分离到 Compressed Class Space：

```
   Java Heap       (compressed oop, 基址 A)
   Metaspace       (NonClassType: 字节码、常量池)
   Class Space     (ClassType: InstanceKlass 等, 基址 B, 上限 ~1GB)
```

分离的根本原因是 32 位压缩指针的编码需求——`real_addr = base + (compressed << shift)`。Heap oop 有一套基址+移位，Class pointer 需要另一套。如果 Klass 混在 Metaspace 里，Class Space 基址会随着 Metaspace 扩容变动，所有已编码的 compressed klass pointer 立刻失效。Class Space 固定大小（受 `-XX:CompressedClassSpaceSize` 控制），不能动态扩容——所以 Class Space OOM 和 Metaspace OOM 是两种不同的故障模式，需要独立的计数器。

### 3.2 实现

```cpp
// metaspaceCounters.cpp:100-110
size_t CompressedClassSpaceCounters::used() {
  return MetaspaceUtils::used_bytes(Metaspace::ClassType);
}
size_t CompressedClassSpaceCounters::capacity() {
  return MetaspaceUtils::committed_bytes(Metaspace::ClassType);
}
size_t CompressedClassSpaceCounters::max_capacity() {
  return MetaspaceUtils::reserved_bytes(Metaspace::ClassType);
}
```

与 MetaspaceCounters 的唯一区别：全部传 `Metaspace::ClassType`，只查询 Class Space 的数据。

### 3.3 双分支初始化

```cpp
// metaspaceCounters.cpp:120-133（缩略）
void CompressedClassSpaceCounters::initialize_performance_counters() {
  if (UsePerfData) {
    if (UseCompressedClassPointers) {
      _perf_counters = new MetaspacePerfCounters(ns, 0, capacity(),
                                                 max_capacity(), used());
    } else {
      _perf_counters = new MetaspacePerfCounters(ns, 0, 0, 0, 0);
    }
  }
}
```

当 `UseCompressedClassPointers = false`（32 位 JVM 或显式关闭），Class Space 不存在。计数器仍被创建——全部置零。这保证 `jstat -gc` 的 CCSU/CCSC/CCSR 列始终存在，值为 0 代表"没有独立 Class Space"。

### 3.4 jstat 对照

```
$ jstat -gc <pid>
 MU     MC     MR     CCSU   CCSC   CCSR
```

| jstat 列 | PerfData 全名 | 实际源 |
|----------|--------------|-------|
| MU | sun.gc.metaspace.used | used_bytes(NonClassType+ClassType) |
| MC | sun.gc.metaspace.capacity | committed_bytes(NonClassType+ClassType) |
| MR | sun.gc.metaspace.maxCapacity | reserved_bytes(NonClassType+ClassType) |
| CCSU | sun.gc.compressedclassspace.used | used_bytes(ClassType) |
| CCSC | sun.gc.compressedclassspace.capacity | committed_bytes(ClassType) |
| CCSR | sun.gc.compressedclassspace.maxCapacity | reserved_bytes(ClassType) |

注意 MC 的命名：jstat 的"Capacity"对应的是 HotSpot 的 `committed_bytes()`，不是 `MetaspaceUtils::capacity_bytes()`。

---

## 4. 第四层：AOTLoader —— JDK 9/10 的 AOT 预编译加载

> **跳过提示**：AOT 从未成为主流——JDK 17 已移除（JEP 410）。本节可跳过，不影响后续文章理解。

### 4.1 设计动机

JVM 从 `main()` 到产生业务效果之间有一段"预热期"——C1/C2 需要积累足够的调用次数才触发编译。AOT 用 `jaotc` 在构建时预编译 Java 类为 x86-64 机器码打包成 `.so`，启动时加载，跳过解释执行和 JIT 编译。JDK 17 已移除 AOT（JEP 410），因为 GraalVM Native Image 提供了更好的替代方案。

### 4.2 两阶段初始化

AOT 的初始化分两个阶段嵌入启动流程。

阶段一在 `initialize_heap()` 中，compressed oops 模式确定后记录：

```cpp
// universe.cpp:791-793
#if INCLUDE_AOT
AOTLoader::set_narrow_oop_shift();
#endif
```

阶段二在 `universe_init()` 中，遍历 AOT 库验证并注册：

```cpp
// aotLoader.cpp:171-210（缩略）
void AOTLoader::universe_init() {
  if (UseAOT) {
    for (int i = 0; i < _libraries.length(); i++) {
      AOTLibrary* lib = _libraries.at(i);
      if (lib->config()->_narrowOopShift != Universe::narrow_oop_shift() ||
          lib->config()->_narrowKlassShift != Universe::narrow_klass_shift()) {
        vm_exit_during_initialization("incompatible narrow oop shift");
      }
      AOTCodeHeap* heap = new AOTCodeHeap(lib);
      CodeCache::add_heap(heap);
    }
  }
}
```

### 4.3 为什么验证 shift

压缩指针解码公式 `real_addr = base + (compressed << shift)` 在 AOT 编译时被"烧"进机器码。如果编译时 `shift = 3`，生成的指令是 `mov eax, [rdi + compressed*8]`；运行时 `shift = 0`，则同样的指令访问错误地址。验证发生在 `initialize_heap` 之后——此时 Heap 地址已定，shift 不变。不兼容时 JVM 选择退出而非回退，因为无法在每条 AOT 解压指令前插入动态检查。

### 4.4 CodeCache 集成

AOT 代码需要独立 `CodeHeap`——不和 JIT 编译的方法混在一起。JIT 方法可被卸载，AOT 代码永久存活，混在一起卸载 JIT 方法时会产生碎片。

```cpp
// codeCache.cpp:387-388
void CodeCache::add_heap(CodeHeap* heap) {
  assert(!Universe::is_fully_initialized(), "late heap addition?");
```

`add_heap` 的断言要求 AOT 堆必须在 `universe_init` 阶段注册，之后不能再添加。

---

## 5. 第五层：三个函数的共同角色

### 5.1 hook-after-init 模式

三个函数共享同一设计模式——主系统初始化完成后立即注册辅助子系统：

```
initialize_heap() 完成  ->  MetaspaceCounters 注册
Metaspace 就绪          ->  CompressedClassSpaceCounters 注册
heap + metaspace 就绪   ->  AOTLoader 验证+注册
```

这保证辅助子系统初始化时能访问完整的主系统状态。如果 `MetaspaceCounters` 在 `Metaspace::global_initialize()` 之前调用，`MetaspaceUtils::used_bytes()` 会访问未初始化的 `VirtualSpaceList`。

### 5.2 对外连接的关键性

去掉 `MetaspaceCounters`：`jstat -gc` 的 MU/MC/MR 归零，`jconsole` 看不到 Metaspace 数据，排查 Metaspace OOM 只能等 crash 后查 hs_err。

去掉 `CompressedClassSpaceCounters`：CCSU/CCSC/CCSR 归零，Class Space 接近 1GB 上限时无法提前预警。

去掉 `AOTLoader`（JDK 9/10）：`-XX:AOTLibrary` 无效，预编译的 `.so` 加载后不生效。

三个函数代码量总共不超过 150 行，但它们连接了 JVM 的两个关键对外接口（jstat/JMX 监控和 AOT 预编译）。不需要单独章节——设计深度不足以支撑独立文章——但理解它们的存在是理解 JVM 全局监控体系的前置条件。

---

## 6. 总结

| 概念 | 核心含义 |
|------|---------|
| PerfData | JVM 内部计数器的 mmap 共享内存机制。文件 `/tmp/hsperfdata_<user>/<pid>` |
| CounterNS | 名字空间：`sun.gc`/`sun.ci`/`sun.rt`，决定前缀和接口稳定性 |
| Variable vs Counter | Variable 可增减（Metaspace），Counter 只增（GC 累计次数） |
| MetaspaceCounters | 暴露 used/committed/reserved（jstat MU/MC/MR），源为 MetaspaceUtils |
| CompressedClassSpaceCounters | 只查 ClassType。`UseCompressedClassPointers=false` 全部置零 |
| AOTLoader | JDK 9/10 独有。验证 shift 后为 AOT 库创建独立 CodeHeap |
| hook-after-init | 三个函数的共同模式——主系统就绪后立即注册 |

ch10 到此结束。下一章（ch11）进入 `Universe::initialize_heap`——堆创建、compressed oops 四模式、TLAB 启动。
