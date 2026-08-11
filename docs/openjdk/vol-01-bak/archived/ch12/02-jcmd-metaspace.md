# 12.2 jcmd VM.metaspace —— 主动诊断通道

> **本文定位**：jcmd 全线——从命令行的 `VM.metaspace basic=true` 到 `VM_PrintMetadata` 进入 safepoint 遍历 CLDG 的完整 Metaspace 侧源码路径。覆盖 jcmd 基础、print_basic_report（无锁快速通道）、print_report（8 参数 × 6 ReportFlag）、JMX MemoryPool MXBean、以及 GC.class_stats per-class 元数据分解。
>
> **前置依赖**：[ch10/07 Metaspace 背景知识](../ch10/07-metaspace.md) + [12.1 jstat + GC 日志](01-jstat-gc-log.md)——理解 committed/used/reserved 三层、capacity vs committed 差异、PerfData 更新时机。
>
> **JDK 版本**：本文基于 **JDK 11u** 源码，实证输出使用 jdk11u-copy slowdebug 构建。

---

## 1. jcmd 基础

### 1.1 jcmd 是什么

`jcmd` 是 JDK 内置的诊断命令工具——通过 Attach API 连接到目标 JVM 进程，发送命令字符串 → JVM 内部 `DCmd::parse_and_execute` 解析调度 → `outputStream` 写回客户端。

与 Metaspace 相关的 4 条命令：

| 命令 | 作用 | safepoint | 展开位置 |
|------|------|-----------|----------|
| `VM.metaspace basic=true` | 快速摘要——Usage + Virtual space + Chunk freelists | **不需要** | Section 2 |
| `VM.metaspace [show-loaders\|by-chunktype\|...]` | 详细诊断——per-CLD + per-Klass | 需要 | Section 3 |
| `VM.classloader_stats` | per-CLD 类计数 + chunk_sz/block_sz | 需要 (Low) | 本文末尾 |
| `GC.class_stats [-csv] [columns=...]` | per-class 元数据按类别分解 | 需要 | Section 5 |

`VM.info` 内部也会调用 `print_vm_info` → `print_basic_report`，输出等同于 `VM.metaspace basic=true` 的超集（嵌在系统信息中），本文不单独展开。

### 1.2 jcmd 的 DCmd 调度链

一条 `jcmd <pid> VM.metaspace` 命令经过的调用链：

```
jcmd 客户端
  → Attach API 连接目标 JVM
    → AttachListener::jcmd (attachListener.cpp:200)
      → DCmd::parse_and_execute(source, out, cmdline, delim, THREAD)
        → DCmdFactory::create_local_DCmd → 实例化 MetaspaceDCmd
        → command->parse() → 解析参数
        → command->execute() → Section 2 或 Section 3 的路径
```

`MetaspaceDCmd::execute`（`metaspaceDCmd.cpp:68`）根据 `_basic` 参数分叉：

```cpp
/* === src/hotspot/share/memory/metaspace/metaspaceDCmd.cpp === */

if (_basic.value() == true) {
    // 如果 basic=true，立即直接调用 print_basic_report——不需要 safepoint
    MetaspaceUtils::print_basic_report(output(), scale);
} else {
    // 默认模式：组合 ReportFlag → VM_PrintMetadata → safepoint
    int flags = 0;
    if (_show_loaders.value())  flags |= MetaspaceUtils::rf_show_loaders;
    if (_show_classes.value())  flags |= MetaspaceUtils::rf_show_classes;
    // ... 同样处理其它 4 个 flag ...
    VM_PrintMetadata op(output(), scale, flags);
    VMThread::execute(&op);  // ← 这里进入 safepoint
}
```

`safepoint` 的代价取决于已加载的类数量——`MetaspaceDCmd::impact()` 声明为 `"Medium: Depends on number of classes loaded."`。生产环境诊断优先用 `basic=true`。

> DCmd 框架完整源码（`DCmdFactory` 注册机制、`parse_and_execute` 调度链、AttachListener 协议）在独立章展开，ch12 只讲用法和 Metaspace 侧接口。

---

## 2. print_basic_report —— 无锁快速通道

### 2.1 调用链

`jcmd <pid> VM.metaspace basic=true` 经过的完整路径：

```
MetaspaceDCmd::execute → MetaspaceUtils::print_basic_report(out, scale)
```

**不需要 safepoint、不需要 CLDG_lock**——因为数据来源是 SpaceManager 的全局原子计数器。

### 2.2 计数器的锁策略——不是全部原子

`MetaspaceUtils` 维护了 3 个全局计数器数组（`metaspace.hpp:315-320`）：

```cpp
static size_t _capacity_words[Metaspace::MetadataTypeCount];
static size_t _overhead_words[Metaspace::MetadataTypeCount];
static volatile size_t _used_words[Metaspace::MetadataTypeCount];
```

其中 `_used_words` 是 `volatile`——因为 bump pointer 在多线程分配中可能不持锁，需要 `Atomic::add` 保护。`_capacity_words` 和 `_overhead_words` 的更新始终在 `MetaspaceExpand_lock` 保护下，用裸 `+=` 即可。

**它们用了不同的并发策略**：

| 计数器 | 更新函数 | 并发策略 | 原因 |
|--------|---------|---------|------|
| `_capacity_words` | `inc_stat_nonatomically`（`metaspace.cpp:380-383`） | `assert_lock_strong(MetaspaceExpand_lock)` 下的裸 `(*pstat) += words` | SpaceManager 分配 chunk 时已持锁 |
| `_overhead_words` | `inc_stat_nonatomically` | 同 capacity——持 `MetaspaceExpand_lock` 下的裸 `+=` | 与 capacity 同步更新 |
| `_used_words` | `inc_stat_atomically`（`metaspace.cpp:394-396`） | `Atomic::add(words, pstat)`——真正的原子操作 | bump pointer 前进不持全局锁，需原子保护 |

源码对比：

```cpp
/* === src/hotspot/share/memory/metaspace.cpp === */

// capacity/overhead: 非原子——调用方已持 MetaspaceExpand_lock
static void inc_stat_nonatomically(size_t* pstat, size_t words) {
  assert_lock_strong(MetaspaceExpand_lock);
  (*pstat) += words;
}

// used: 原子——bump pointer 在多线程 CLD 分配中无需全局锁
static void inc_stat_atomically(volatile size_t* pstat, size_t words) {
  Atomic::add(words, pstat);
}
```

`print_basic_report` 注释称"guaranteed not to lock or to walk the CLDG"——这里的"不锁"指不拿 CLDG_lock（不遍历 ClassLoaderDataGraph）。`free_chunks_total_bytes` 实际只是读取 `ChunkManager` 的成员变量 `_free_chunks_total`（`chunkManager.cpp:192-194`），是一个单纯的内存读取，不需要遍历 freelist 也不需要锁。

---

### 2.3 输出详解

jdk11u-copy 实测输出：

```
Usage:
  Non-class:      6.19 MB capacity,     6.11 MB ( 99%) used,    64.98 KB (  1%) free+waste,    13.31 KB ( <1%) overhead. 
      Class:    703.00 KB capacity,   626.43 KB ( 89%) used,    68.51 KB ( 10%) free+waste,     8.06 KB (  1%) overhead. 
       Both:      6.88 MB capacity,     6.73 MB ( 98%) used,   133.48 KB (  2%) free+waste,    21.38 KB ( <1%) overhead. 

Virtual space:
  Non-class space:        8.00 MB reserved,       6.25 MB ( 78%) committed 
      Class space:        1.00 GB reserved,     768.00 KB ( <1%) committed 
             Both:        1.01 GB reserved,       7.00 MB ( <1%) committed 

Chunk freelists:
   Non-Class:  17.00 KB
       Class:  1.00 KB
        Both:  18.00 KB

MaxMetaspaceSize: unlimited
CompressedClassSpaceSize: 1.00 GB
Initial GC threshold: 20.80 MB
Current GC threshold: 20.80 MB
CDS: off
```

#### Usage 行

4 个指标每行 × 3 行（NonClass / Class / Both）：

| 指标 | 源码来源 | 含义 |
|------|---------|------|
| `capacity` | `MetaspaceUtils::capacity_words(mdtype)` → SpaceManager `_capacity_words` 全局累加 | **chunk 逻辑分配量**——所有 CLD 的 SpaceManager 已持有的 chunk 总大小 |
| `used` | `MetaspaceUtils::used_words(mdtype)` → `_used_words`（`Atomic::add` 更新） | bump pointer 已分配的元数据实际占用量 |
| `free+waste` | `capacity - overhead - used`（计算值，不是直接存储的计数器） | chunk 内未使用空间 |
| `overhead` | `MetaspaceUtils::overhead_words(mdtype)` | Metachunk 对象自身 + `_block_freelists` 链表开销 |

**capacity 与 committed 的关系**（12.1 已详述，此处回顾）：

```
capacity（Usage 行）= chunk 逻辑分配量
committed（Virtual space 行）= VSL 物理提交量
→ committed ≥ capacity（差额 = VSL 中已 commit 但未分配给 ChunkManager 的原始空间）
```

实测中：Non-Class capacity=6.19MB，committed=6.25MB，差额 0.06MB——VSL 留有少量已 commit 但未分配的空间。

#### Virtual space 行

从 VSL 的 `_reserved_words` / `_committed_words` 读取。每行 = NonClass / Class / Both 三行。`reserved` 约 1GB 因为压缩类空间默认 1GB（`CompressedClassSpaceSize`），`committed` 仅 0.77MB 因为只用了极少页。

#### Chunk freelists 行

`free_chunks_total_bytes` **遍历** ChunkManager freelist 累加（不是走计数器），需持 `MetaspaceExpand_lock`。这个值反映"chunk 已从 CLD 归还但还在等复用"的空间。

实测中 Non-Class freelist 仅 17KB——因为 JVM 才启动，还没大量类卸载。

#### Basic switches 行

来自 JVM flag 值：`MaxMetaspaceSize`（未设置时显示 unlimited）、`CompressedClassSpaceSize`、MetaspaceGC 阈值、CDS 状态。

---

## 3. print_report —— per-CLD 详细诊断

### 3.1 8 个参数

`MetaspaceDCmd` 构造函数（`metaspaceDCmd.cpp:34-55`）注册了 8 个 `DCmdArgument`：

| 参数 | 类型 | 默认值 | 对应 ReportFlag | 作用 |
|------|------|--------|---------------|------|
| `basic` | bool | false | — | true 时走 Section 2 的快速通道，忽略以下所有参数 |
| `show-loaders` | bool | false | `rf_show_loaders` | 按 class loader 分解 |
| `show-classes` | bool | false | `rf_show_classes` | 在 show-loaders 基础上列出每个 loader 下每个类 |
| `by-chunktype` | bool | false | `rf_break_down_by_chunktype` | 按 chunk size class 分解——碎片化诊断 |
| `by-spacetype` | bool | false | `rf_break_down_by_spacetype` | 按 loader 类型分解——判断匿名类膨胀 |
| `show-vslist` | bool | false | `rf_show_vslist` | 每个 VirtualSpaceNode 详情 |
| `show-vsmap` | bool | false | `rf_show_vsmap` | chunk 在虚拟空间中的 ASCII 布局图 |
| `scale` | string | "dynamic" | — | 单位：1/KB/MB/GB/dynamic |

6 个 ReportFlag 对应 `MetaspaceUtils::ReportFlag` 枚举（`metaspace.hpp:403-416`）：

```cpp
enum ReportFlag {
  rf_show_loaders            = (1 << 0),  // per-CLD 分解
  rf_break_down_by_chunktype = (1 << 1),  // per-chunk-type
  rf_break_down_by_spacetype = (1 << 2),  // per-space-type
  rf_show_vslist             = (1 << 3),  // VS details
  rf_show_vsmap              = (1 << 4),  // chunk map
  rf_show_classes            = (1 << 5)   // per-class within loader
};
```

常用组合：

```
jcmd <pid> VM.metaspace basic=true                              # 生产安全——快速看总量
jcmd <pid> VM.metaspace show-loaders=true                       # 找哪个 CLD 占用最大
jcmd <pid> VM.metaspace show-loaders=true by-chunktype=true      # 碎片化诊断
jcmd <pid> VM.metaspace show-loaders=true show-classes=true      # 每个 loader 包含哪些类
jcmd <pid> VM.metaspace show-loaders=true by-chunktype=true by-spacetype=true show-vslist=true show-vsmap=true  # 全面排查
```

### 3.2 VM_PrintMetadata —— safepoint + CLDG 遍历

默认模式下（`basic=false`），`MetaspaceDCmd::execute` 创建 `VM_PrintMetadata(output, scale, flags)` 并提交给 `VMThread::execute`——JVM 所有 Java 线程停在 safepoint 后执行 `doit()`。`doit()` 中的逻辑：

```
VM_PrintMetadata::doit()
  ├─ ① print_basic_report(out, scale)          ← 先输出 Section 2 的快速摘要
  ├─ ② create ClassLoaderMetaspaceStatistics   ← 统计收集器
  ├─ ③ ClassLoaderDataGraph::cld_do(&cl)       ← 持 CLDG_lock 遍历所有 CLD
  │     └─ PrintCLDMetaspaceInfoClosure::do_cld ← 每个 CLD 累加 used/waste/overhead/capacity
  └─ ④ print per-CLD（flags 控制详细程度）
```

### 3.3 per-CLD 输出

jdk11u-copy 实测 `show-loaders=true` 输出（节选前几行）：

```
Usage per loader:

   1: CLD 0x...: "app" instance of ClassLoaders$AppClassLoader, 1 class
  Non-Class:    2 chunks,     2 chunk MB capacity, committed%, used(KB) used%, free(KB) free%, waste
      Class:    1 chunk,       ... 同上 ...
       Both:    3 chunks,      ... 总和 ...

   ...
  Total Usage - 3 loaders, 915 classes:
  Non-Class:   ... chunks,    total capacity, committed, used, free, waste, deallocated blocks
      Class:   ...
       Both:   ...
```

每个 CLD 包含 3 行（NonClass / Class / Both），每行展示 ch unks 数量、capacity、committed（百分比）、used（百分比）、free、waste、以及 deallocated 统计。

bootstrap class loader 显示为 `"<bootstrap>"`，自定义 loader 显示其 `toString()` 名。

### 3.4 VM.classloader_stats —— 简洁版 per-CLD

`jcmd <pid> VM.classloader_stats` 的影响级别为 `"Low"`，与 `VM.metaspace show-loaders` 输出不同——更简洁、聚焦 chunk/block 总量：

```
ClassLoader         Parent              CLD*               Classes   ChunkSz   BlockSz  Type
0x0000000800010300  0x...               0x00007f21b8e98e70       1      6144      1664  AppClassLoader
0x0000000000000000  0x...               0x00007f21b8cb6e90     848   6479872   6449072  <boot class loader>
                                                                66    185344    121248   + unsafe anonymous classes
Total = 3                                                      915   6671360   6571984  
```

- **ChunkSz** = 该 CLD 持有的所有 chunk 总大小
- **BlockSz** = 实际使用的 block 总大小（≤ ChunkSz，差额 = waste+free）
- `+ unsafe anonymous classes` 行 = 匿名类（`sun.misc.Unsafe.defineAnonymousClass` 创建的），不计入正式类计数

---

## 4. JMX MemoryPool MXBean

### 4.1 JMX MemoryPool——另一种 Metaspace 数据获取路径

这是第 8 条 Metaspace 诊断通道——通过 `MemoryPoolMXBean` MBean 暴露 Metaspace 数据。JConsole、VisualVM、Prometheus JMX exporter 都是通过这条路读取 Metaspace 信息的，

### 4.2 初始化

`MemoryService::add_metaspace_memory_pools()`（`memoryService.cpp:111-125`）在 JVM 初始化时创建两个 Pool：

```cpp
void MemoryService::add_metaspace_memory_pools() {
  MemoryManager* mgr = MemoryManager::get_metaspace_memory_manager();

  _metaspace_pool = new MetaspacePool();           // 全局 Metaspace
  mgr->add_pool(_metaspace_pool);
  _pools_list->append(_metaspace_pool);

  if (UseCompressedClassPointers) {
    _compressed_class_pool = new CompressedKlassSpacePool();  // 压缩类空间
    mgr->add_pool(_compressed_class_pool);
    _pools_list->append(_compressed_class_pool);
  }

  _managers_list->append(mgr);
}
```

### 4.3 MetaspacePool 源码（`memoryPool.cpp:193-208`）

```cpp
MetaspacePool::MetaspacePool() :
  MemoryPool("Metaspace", NonHeap, 0, calculate_max_size(), true, false) { }

MemoryUsage MetaspacePool::get_memory_usage() {
  size_t committed = MetaspaceUtils::committed_bytes();
  return MemoryUsage(initial_size(), used_in_bytes(), committed, max_size());
}

size_t MetaspacePool::used_in_bytes() {
  return MetaspaceUtils::used_bytes();
}

size_t MetaspacePool::calculate_max_size() const {
  return !FLAG_IS_DEFAULT(MaxMetaspaceSize) ? MaxMetaspaceSize :
                                              MemoryUsage::undefined_size();
}
```

`CompressedKlassSpacePool` 同理，max = `CompressedClassSpaceSize`。

### 4.4 与 jstat 的关键差异

JMX 的 max 在不同设置下的表现：

| 场景 | JMX MetaspacePool max | jstat MR |
|------|---------------------|----------|
| `-XX:MaxMetaspaceSize=256M` | 256M | `reserved_bytes()`（VSL mmap 预约量） |
| 未设 MaxMetaspaceSize | `undefined_size()`（-1） | `reserved_bytes()` |

**两者完全不同**。JMX 报告的是"配置允许的上限"，jstat MR 报告的是"已预约的虚拟地址空间总量"。这也是为什么实测中 jstat MR 接近 1GB（CompressedClassSpace 1GB reserved），而 JMX 会报告 max=unlimited。

### 4.5 实时性

`MemoryService::track_memory_usage()`（`memoryService.cpp:147-156`）遍历所有 pool 调 `record_peak_memory_usage` → 调用 `get_memory_usage` → 实时读取 `MetaspaceUtils`。**不依赖 GC 完成**——这与 jstat 不同。

`LowMemoryDetector::detect_low_memory()` 会检查 `MetaspacePool` 的 usage 是否超过 JMX 配置的高阈值，可触发 JMX notification。

### 4.6 访问方式

```java
ManagementFactory.getMemoryPoolMXBeans().stream()
    .filter(p -> "Metaspace".equals(p.getName()))
    .findFirst().get().getUsage();  // MemoryUsage{init=0, used=N, committed=M, max=X}
```

---

## 5. GC.class_stats —— per-class 元数据分解

### 5.1 命令

`jcmd <pid> GC.class_stats [-csv] [-all] [columns=...]`

默认柱（`heapInspection.cpp:580`）：

```
InstBytes,KlassBytes,CpAll,annotations,MethodCount,Bytecodes,MethodAll,ROAll,RWAll,Total
```

| 列名 | 含义 | 属于 Metaspace 的哪个部分 |
|------|------|--------------------------|
| `InstBytes` | 实例占用的堆内存 | 不属 Metaspace |
| `KlassBytes` | Klass 结构大小 | 元数据——SpaceManager ClassType 分配 |
| `CpAll` | ConstantPool 大小 | 元数据——NonClassType |
| `annotations` | 注解数据 | 元数据 |
| `MethodCount` | 方法数 | — |
| `Bytecodes` | 字节码大小 | 元数据 |
| `MethodAll` | 方法相关元数据总量 | 元数据——NonClassType |
| `ROAll` | Read-Only 元数据（符号等） | 元数据 |
| `RWAll` | Read-Write 元数据（vtables 等） | 元数据 |
| `Total` | 总元数据大小 | = ROAll + RWAll |

### 5.2 数据来源

`ClassStatsDCmd::execute` → `VM_GC_HeapInspection` → `KlassInfoHisto::print_class_stats`（`heapInspection.cpp:561`）。对每个 Klass 调用 `Klass::collect_statistics(&sz)` 填充 `KlassSizeStats` 结构。

与 `VM.metaspace show-classes` 对比：前者的 "used" 是 bump pointer 已分配量（不分类），`GC.class_stats` 按元数据类别分解（Klass 结构 / ConstantPool / Method / 注解 / RO / RW）——知道"哪种元数据在膨胀"。

需 safepoint（`VM_GC_HeapInspection` 是 VM 操作），生产慎用。

---

## 6. 小结

```
jcmd 两条路径对比：

print_basic_report（basic=true）:
  - 无 safepoint——生产中安全
  - 数据来自 3 个全局计数器（_capacity_words / _used_words / _overhead_words）
  - capacity 非原子（持锁 +=），只有 _used_words 是 Atomic::add
  - 输出 4 组：Usage + Virtual space + Chunk freelists + switches
  - 不能 per-CLD 分解——只有全局总和

print_report（默认）:
  - 需 safepoint——遍历 CLDG
  - 8 个参数 × 6 个 ReportFlag 控制输出级别
  - per-CLD 分解：3 行（NonClass/Class/Both）× 每个 CLD
  - by-chunktype / by-spacetype / show-vslist / show-vsmap 进行高级诊断

JMX MemoryPool:
  - MBean: java.lang:type=MemoryPool,name=Metaspace
  - max = MaxMetaspaceSize（或 undefined）——不同于 jstat MR（reserved_bytes）
  - 实时更新（不依赖 GC 完成）
  - JConsole/VisualVM/Prometheus 都通过此通道读取

GC.class_stats:
  - per-class 元数据按类别分解——判断哪种类型在膨胀
  - 需 safepoint——生产慎用
```

下一篇（12.3）讲解 NMT——从开启参数到 mtClass 分解到 diff 判泄漏的完整路径。
