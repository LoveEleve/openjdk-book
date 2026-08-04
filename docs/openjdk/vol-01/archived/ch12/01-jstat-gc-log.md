# 12.1 jstat + GC 日志 —— 零门槛通道

> **本文定位**：两条不需要任何 JVM 启动参数的 Metaspace 诊断通道——jstat（PerfData 共享内存计数器）和 GC 日志（`MetaspaceSizesSnapshot` + `print_metaspace_change`）。追踪完整的 Metaspace 侧源码路径，验证每条通道的数据来源和更新时机。
>
> **前置依赖**：[ch10/07 Metaspace 背景知识](../ch10/07-metaspace.md)——理解 VSL/ChunkManager/SpaceManager、committed/used/reserved 三层、MetaspaceGC。
>
> **JDK 版本**：本文基于 **JDK 11u** 源码，实证输出使用 jdk11u-copy slowdebug 构建。JDK 16+ JEP 387 "Elastic Metaspace" 的实现不同但诊断接口兼容。

---

## 1. jstat MU/MC/MR

### 1.1 工具入门

`jstat -gc <pid>` 不需要任何 JVM 启动参数，因为它读的是 JVM 自动建立的 PerfData 共享内存文件。输出中与 Metaspace 相关的四列：

```
 S0C    S1C    S0U    S1U      EC       EU        OC         OU       MC     MU    CCSC   CCSU   YGC ...
 0.0    0.0    0.0    0.0   442368.0 69632.0  7946240.0     0.0      0.0    0.0    0.0    0.0      0 ...
```

| 列 | 含义 | 对应源码值 |
|----|------|----------|
| **MC** | Metaspace Capacity | `MetaspaceUtils::committed_bytes()`（VSL 物理提交量） |
| **MU** | Metaspace Used | `MetaspaceUtils::used_bytes()`（实际被元数据占用的字节） |
| **CCSC** | Compressed Class Space Capacity | `MetaspaceUtils::committed_bytes(ClassType)` |
| **CCSU** | Compressed Class Space Used | `MetaspaceUtils::used_bytes(ClassType)` |

`jstat -gccapacity` 和 `jstat -gcutil` 还分别多显示一列 MR（Max）和百分比格式，数据来源相同。

**关键陷阱 #1：MC 不是 "capacity"**。虽然列名是 "MC = Metaspace Capacity"，但它的值来自 `committed_bytes()`（VSL 物理提交量），不是 SpaceManager 的 `_capacity_words`（chunk 逻辑分配量）。命名是历史遗留——`MetaspaceCounters` 内部把计数器取名叫 `_capacity`，但实际赋的是 `committed_bytes()`。

**关键陷阱 #2：MR 不是 `MaxMetaspaceSize`**。`jstat -gccapacity` 的 MR 列来自 `MetaspaceCounters::max_capacity()`，返回 `reserved_bytes()`（VSL mmap 预约的虚拟地址空间总量），**不是** JVM 的 `-XX:MaxMetaspaceSize`。如果 `MaxMetaspaceSize` 未显式设置，MR 会远比它大（因为 VSL reserve 的是连续虚拟地址段）。

实证——jdk11u-copy 刚启动时 jstat 显示全零，但 jcmd 同时显示真实的 committed/used：

```
# jstat -gc (JVM 启动后，尚未触发任何 GC)
MC=0.0  MU=0.0  CCSC=0.0  CCSU=0.0

# 同一时刻 jcmd VM.metaspace basic=true
Non-class: 5.76 MB capacity, 5.72 MB (>99%) used
    Class: 620.00 KB capacity, 560.86 KB (90%) used
Non-class space: 8.00 MB reserved, 6.00 MB (75%) committed
    Class space: 1.00 GB reserved, 640.00 KB (<1%) committed
MaxMetaspaceSize: unlimited
```

jstat 全是 0——因为 PerfData 计数器还没更新。jcmd 显示 6.62MB committed、6.27MB used——这是真实值，从 SpaceManager/VSL 的实时计数器读取。两者数据源不同、更新时机不同。

---

### 1.2 数据源：PerfData 计数器的完整路径

#### 1.2.1 计数器注册

`MetaspaceCounters` 在 `universe_init` 中初始化（`metaspaceCounters.cpp:80-88`）：

```cpp
/* === src/hotspot/share/memory/metaspaceCounters.cpp === */

void MetaspaceCounters::initialize_performance_counters() {
  if (UsePerfData) {
    assert(_perf_counters == NULL, "Should only be initialized once");
    size_t min_capacity = 0;
    _perf_counters = new MetaspacePerfCounters("metaspace", min_capacity,
                                               capacity(), max_capacity(), used());
  }
}
```

`MetaspacePerfCounters` 构造函数（`metaspaceCounters.cpp:49-57`）在 `SUN_GC` 命名空间下创建 4 个 `PerfVariable`。最终暴露给 jstat 的 PerfData 名称是：

| PerfData 名称 | PerfData 类型 | 赋的值 | jstat 列 |
|--------------|-------------|--------|----------|
| `sun.gc.metaspace.minCapacity` | constant | 0 | — |
| `sun.gc.metaspace.capacity` | variable | `committed_bytes()` | MC |
| `sun.gc.metaspace.maxCapacity` | variable | `reserved_bytes()` | MR |
| `sun.gc.metaspace.used` | variable | `used_bytes()` | MU |

`CompressedClassSpaceCounters` 同理，命名空间 `sun.gc.compressedclassspace`，对应 CCSC/CCSU 列。

PerfData 变量创建时调的是 `PerfDataManager::create_variable(SUN_GC, name, U_Bytes, value, THREAD)`（`metaspaceCounters.cpp:38-41`），写入 JVM 共享内存文件 `/tmp/hsperfdata_<user>/<pid>`。jstat 客户端通过 `PerfMemory` 协议读取这个文件。

#### 1.2.2 计数器更新——关键：只在 GC 结束时

`MetaspaceCounters::update_performance_counters()`（`metaspaceCounters.cpp:90-96`）：

```cpp
void MetaspaceCounters::update_performance_counters() {
  if (UsePerfData) {
    assert(_perf_counters != NULL, "Should be initialized");
    _perf_counters->update(capacity(), max_capacity(), used());
  }
}
```

`MetaspacePerfCounters::update`（`metaspaceCounters.cpp:59-63`）直接调用 `PerfVariable::set_value` 写入共享内存：

```cpp
void update(size_t capacity, size_t max_capacity, size_t used) {
  _capacity->set_value(capacity);    // committed_bytes()
  _max_capacity->set_value(max_capacity); // reserved_bytes()
  _used->set_value(used);            // used_bytes()
}
```

**整个函数只有 2 个调用方**，且都在 GC 的 epilogue 路径：

1. `GenCollectedHeap::gc_epilogue`（`genCollectedHeap.cpp:1329`）—— Serial/Parallel GC 的 GC 后处理
2. G1 的 post-GC 路径（`g1MonitoringSupport.cpp`）—— G1 GC 后更新监控计数器

`MemoryService::track_memory_usage()`（`memoryService.cpp:147-156`）**不包含** `MetaspaceCounters::update_performance_counters()`——它只调 `record_peak_memory_usage` 和 `detect_low_memory`。

这意味着：**jstat 的 MC/MU/CCSC/CCSU 在首次 GC 之前一直显示 0**。不论 Metaspace 分配了多少元数据，只要 GC 还没跑，jstat 就是 0。这就是上文实测中 jstat 全 0 而 jcmd 显示 6.27MB used 的原因。

#### 1.2.3 三个 capacity/used/max_capacity 的源码对应

```
MetaspaceCounters::capacity()      → MetaspaceUtils::committed_bytes()       [metaspaceCounters.cpp:72-73]
MetaspaceCounters::used()          → MetaspaceUtils::used_bytes()            [metaspaceCounters.cpp:68-69]
MetaspaceCounters::max_capacity()  → MetaspaceUtils::reserved_bytes()        [metaspaceCounters.cpp:76-78]
```

`committed_bytes()` 来自 VSL（`virtualSpaceList.hpp:124-125` `_committed_words * BytesPerWord`）。`used_bytes()` 来自 SpaceManager 的 `_used_words`（原子计数器，`Atomic::add` 更新）。`reserved_bytes()` 来自 VSL 的 `_reserved_words`。

注意 `MetaspaceCounters::capacity()` 返回的是 `committed_bytes()`，不是 `MetaspaceUtils::capacity_words()`。这是 PerfData 命名上的历史包袱——计数器内部叫 `_capacity` 但含义是 committed。

---

### 1.3 趋势判读

| jstat 信号 | 含义 | 诊断方向 |
|-----------|------|----------|
| MC=MU=0 | 尚无 GC 发生——计数器未初始化 | 正常（JVM 刚启动） |
| MU 持续增长、从不回落 | used 只升不降，无类卸载 | 类泄漏——class loader 未被 GC 回收 |
| MC 稳定、MU 随 GC 波动 | 类加载/卸载平衡 | 健康 |
| MC >> MU（差距 >50MB 且持续） | committed 远大于 used | 碎片化——chunk 已提交但未使用 |
| MU 突然飙升 | 批量动态类生成 | 反射/CGLIB/ByteBuddy/Groovy |
| MC ≈ MR → 即将 OOM | committed 接近 MaxMetaspaceSize（如果 MR 直接对应硬上限） | 需检查 MC 是否逼近限制 |

#### 实证：jdk11u-copy 中 GC 前后对比

用 jdk11u-copy slowdebug 构建实测，HelloWorld 启动时分配 200MB 对象并调用两次 `System.gc()` 强制触发 Full GC。GC 前后分别抓 jstat：

```
# GC 前——PerfData 计数器为初始化的 0
jstat -gc <pid>
 MC=0.0  MU=0.0  CCSC=0.0  CCSU=0.0  YGC=0  FGC=0

# System.gc() 触发 2 次 Full GC 后——计数器已更新
jstat -gc <pid>
 MC=7168.0  MU=6887.1  CCSC=768.0  CCSU=626.4  FGC=2

# 同一时刻 jcmd VM.metaspace basic=true
Non-class: 6.19 MB capacity, 6.11 MB (99%) used
Class:     703.00 KB capacity, 626.43 KB (89%) used
Non-class space: 8.00 MB reserved, 6.25 MB (78%) committed
Class space:     1.00 GB reserved, 768.00 KB (<1%) committed
```

GC 前 jstat 全是 0——因为 `MetaspaceCounters::update_performance_counters()` 只在 GC epilogue 被调用，启动后尚未触发任何 GC。GC 后 MC=7168（7MB committed），与 jcmd 显示的 committed=7.00MB 吻合。若程序大量加载类但不触发 GC，jstat 的 MU 会一直显示 0，与实际的元数据用量严重偏离。

---

### 1.4 局限性

- **不知道哪个 CLD 是元凶**——只有全局总量，无 per-CLD 分解
- **不是实时更新**——首次 GC 前全为零，GC 之间不刷新
- **MC 不是 "capacity"**——虽叫 "Metaspace Capacity" 但实际是 committed
- **MR 不是 MaxMetaspaceSize**——是 reserved_bytes()
- **无法区分 NonClass 和 Class 各自的 used**——需要看 CCSC/CCSU

---

## 2. GC 日志

### 2.1 工具入门

只需启动时加 `-Xlog:gc*=info`（JDK 9+ 统一日志框架）或 `-XX:+PrintGCDetails`（JDK 8 兼容方式）。

JDK 11 中 Metaspace 相关的 3 个 Unified Logging tag 组合：

| 日志标签 | 何时输出 | 输出内容 |
|---------|---------|----------|
| `gc+metaspace` | MetaspaceGC 触发 GC 时 | `Metaspace GC threshold reached: committed/capacity/used/free` |
| `gc+metaspace+freelist` | chunk 分配/归还时 | per-chunk 操作日志（trace 级别，调试用） |
| `gc+metaspace+freelist+oom` | 即将抛 OOM 时 | OOM 自动诊断（含完整 `print_basic_report` 输出） |

这些 tag 通过 `Log(gc, metaspace)` 宏发出，JVM 启动时 `LogConfiguration` 根据 `-Xlog` 参数决定哪些 tag 输出到哪些位置。

---

### 2.2 Full GC 中的 Metaspace 行

GC 日志中典型的一行：

```
[Full GC (Metadata GC Threshold) ...
 [Metaspace: 12288K->11264K(16384K)], 0.1234567 secs]
```

三个数字的含义：
- **第一个数** = GC 前的 Metaspace used（`used_bytes()` 快照值）
- **第二个数** = GC 后的 Metaspace used（类卸载释放后）
- **括号内** = committed 总量（`committed_bytes()`）

---

### 2.3 底层实现：MetaspaceSizesSnapshot → print_metaspace_change

这行数据的生成链路跨越 GC 暂停的始终：

```
GC 暂停开始
  → MetaspaceSizesSnapshot() 构造（快照 GC 前 used/committed，共 6 个字段）
  
GC 执行（可能触发类卸载、MetaspaceGC::compute_new_size 调整高水位线、Metaspace::purge 释放空 Node）

GC 暂停结束
  → G1HeapTransition::print()（G1 路径，g1HeapTransition.cpp）
    或 GenCollectedHeap::gc_epilogue（Serial/Parallel 路径，genCollectedHeap.cpp）
      → MetaspaceUtils::print_metaspace_change(pre_snapshot)
        → 对比快照值与当前值 → 输出 "used: before→after, committed: current"
```

`MetaspaceSizesSnapshot`（`metaspaceSizesSnapshot.hpp:31`）是一个简单的 RAII 快照对象，构造时一次性捕获 6 个值：

```cpp
/* === src/hotspot/share/memory/metaspace/metaspaceSizesSnapshot.cpp === */

MetaspaceSizesSnapshot::MetaspaceSizesSnapshot()
    : _used(MetaspaceUtils::used_bytes()),
      _committed(MetaspaceUtils::committed_bytes()),
      _non_class_used(MetaspaceUtils::used_bytes(Metaspace::NonClassType)),
      _non_class_committed(MetaspaceUtils::committed_bytes(Metaspace::NonClassType)),
      _class_used(MetaspaceUtils::used_bytes(Metaspace::ClassType)),
      _class_committed(MetaspaceUtils::committed_bytes(Metaspace::ClassType)) { }
```

6 个字段分为 3 对：
- `_used` / `_committed`（total）
- `_non_class_used` / `_non_class_committed`
- `_class_used` / `_class_committed`

`print_metaspace_change`（`metaspace.cpp:472`）接收这个快照，对比当前值输出 delta。这个函数 **GC 无关**——G1 用、Serial GC 用、Parallel GC 也用，所有 GC 实现的 Metaspace 日志行格式一致。

---

### 2.4 Metaspace GC 阈值触发日志

当 Metaspace 分配量超过 `_capacity_until_GC` 高水位线时，`MetaspaceGC` 会触发一次 GC。此时输出：

```
[gc,metaspace] GC(3) Metaspace GC threshold reached: committed: 16384K, capacity: 16384K, used: 12288K, free: 4096K
```

这条日志由 `Log(gc, metaspace)` 宏发出——只在达到阈值时输出。日志中的 `capacity` 这里指 `_capacity_words`（SpaceManager 层面的 chunk 逻辑分配量），**不是** jstat 的 MC。

#### Metaspace GC 阈值触发源码路径

在 `MetaspaceGC::compute_new_size`（`metaspace.cpp:235`）中，当 committed 超过水位线时：

```cpp
// 简化后的逻辑
if (committed_bytes > _capacity_until_GC) {
  // 触发一次 GC
  // GC 后重新计算水位线
}
```

水位线调整逻辑：GC 后根据 `MinMetaspaceFreeRatio` / `MaxMetaspaceFreeRatio` 参数计算期望容量，然后通过 CAS（`Atomic::cmpxchg`）调整 `_capacity_until_GC`。

---

### 2.5 GC 日志示例

GC 日志中的 Metaspace 行与 jcmd 输出的术语对应关系：

```
[gc,metaspace] GC(1) Metaspace GC threshold reached: committed: 7168K, capacity: 7040K, used: 6723K, free: 317K
[gc          ] GC(1) Pause Full (Metadata GC Threshold) 7M->0M(8M) 2.718ms
```

日志术语对照（与 jcmd basic 输出对比）：

| 日志用词 | 实际含义 | 对应 jcmd 输出 |
|---------|---------|---------------|
| `committed` | VSL 物理提交量 | Virtual space 行的 committed |
| `capacity` | SpaceManager chunk 逻辑分配量 | Usage 行的 capacity |
| `used` | bump pointer 已分配量 | Usage 行的 used |

注意日志中的 `committed` = jstat 的 MC（都是 `committed_bytes()`），但日志中的 `capacity` ≠ jstat 的 MC——两者是不同的量。

> **面试常问**：GC 日志中 `[Metaspace: A->B(C)]` 的三个数字分别是什么？答：A=GC 前 used，B=GC 后 used（类卸载释放后的量），C=committed 总量。

但 jstat 的 MC 对应的是日志中的 `committed`，不是 `capacity`。

---

### 2.6 如何从 GC 日志判读

| 观察 | 意义 |
|------|------|
| GC 后 used 从前值 12M 降到 9M | 类卸载成功——释放了 3MB 元数据 |
| GC 后 used 不变 | 类卸载无效——无 dead CLD 或 CLD 泄漏 |
| committed 从 256M 降到 128M | `Metaspace::purge` 释放了空 Node（m unmap）→ 碎片化程度低 |
| committed 不变，used 降了 | 类卸载了但 chunk 还在 ChunkManager freelist（正常——等待复用） |
| committed 持续增长且不回落 | Metaspace 持续分配 → 检查类加载频率或泄漏 |

---

## 3. 小结

```
两条通道对比：

jstat:
  - 数据源：PerfData 共享内存 sun.gc.metaspace.* 计数器
  - 更新时机：仅在 GC epilogue
  - MC = committed_bytes()（VSL 物理），不是 SpaceManager _capacity_words
  - MR = reserved_bytes()（VSL 预约），不是 MaxMetaspaceSize
  - 首次 GC 前 MC/MU = 0 —— 不是 bug，是设计
  - 适用：长期趋势监控、GC 频率关联分析

GC 日志:
  - 数据源：MetaspaceSizesSnapshot（GC 前快照）+ print_metaspace_change（GC 后对比）
  - 更新时机：每次 GC 结束时
  - 内置 3 个 tag：gc+metaspace / freelist / freelist+oom
  - 日志中的 "capacity" = SpaceManager _capacity_words，"committed" = VSL committed_bytes
  - 适用：判断类卸载是否有效、committed 是否随 GC 回落
```

下一节（12.2）讲解 jcmd VM.metaspace——jstat/GC 日志通道之外的另一条主动查询路径，可以 per-CLD 分解 Metaspace 用量。
