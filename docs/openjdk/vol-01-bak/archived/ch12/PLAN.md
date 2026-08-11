# ch12 Metaspace 诊断与排查写作规划

> 2024-07-23 v2 — 从 1 篇改为 5 篇。每篇写完前用 MCP 验证关键结论。

---

## ch12 目标

读者读完 5 篇后能**独立排查生产环境 Metaspace 问题**——不是记住几个 jcmd 命令，而是通晓每条诊断通道的数据源路径、知道结论为什么正确、能区分误判信号：

1. **jstat MU/MC 的数据从哪条代码路径来？** ——追踪 `MetaspaceCounters::update_performance_counters` 的完整调用链：从 GC epilogue 到 PerfData 共享内存。关键陷阱：MC 的值是 `MetaspaceUtils::committed_bytes()`（VSL 物理提交量），不是 SpaceManager 的 `_capacity_words`
2. **GC 日志里 `[Metaspace: beforeK->afterK(committedK)]` 怎么生成的？** ——`MetaspaceSizesSnapshot` 快照 → `print_metaspace_change` 对比输出，不依赖 GC 算法
3. **`jcmd VM.metaspace` 的 8 个参数各自调了哪段源码？** ——`basic=true` 走 `print_basic_report`（无 safepoint），默认走 `VM_PrintMetadata`（safepoint + 遍历 CLDG）
4. **NMT 的 free 三部分各是什么含义？** ——`(capacity-used)` + `free_chunks_total` + `free_in_vs`，各自在 VSL/ChunkManager/SpaceManager 哪一层
5. **MetaspaceTracer 的 3 个 JFR 事件的触发顺序和字段差异？** ——GCThreshold → AllocationFailure → OOM，共用同一个模板函数 `send_allocation_failure_event<E>`

---

## 定位：ch10/07 的工程实践延伸

ch10/07 已经把 Metaspace 的核心机制讲透。ch12 是**维修手册**——每条诊断通道追踪完整的 Metaspace 侧源码路径。

### ch12 覆盖范围

- **Metaspace 侧源码全路径追踪**（`MetaspaceUtils::print_report`、`MetaspaceCounters::update_performance_counters`、`MetaspaceTracer` 的 3 个 event、`MemSummaryReporter::report_metadata`）
- **工具用法入门**（jcmd / jstat / NMT / JFR 怎么用——够用即可）

### ch12 不覆盖（交给独立章）

| 工具框架 | 需要独立展开的内容 |
|----------|-------------------|
| **PerfData** | 共享内存布局、`PerfLongCounter`、jstat 客户端读取协议 |
| **DCmd** | `DCmdFactory` 注册、`parse_and_execute` 调度、AttachListener |
| **NMT** | `MemTracker` 拦截 mmap/malloc、`MemBaseline` 快照 diff |
| **JFR** | `JfrRecorder` 录制引擎、`EventWriter` 线程本地缓冲 |

---

## 验证要求

每篇开始写之前，先用 MCP 验证该篇的 3-5 个关键结论。不允许发布未经 MCP 验证的结论。已知陷阱（从 v1 错误中吸取）：

| 陷阱 | 错误写法 | 正确写法 |
|------|---------|---------|
| capacity 更新方式 | "原子计数器" | `inc_stat_nonatomically`，持 `MetaspaceExpand_lock` 的裸 `+=`。仅 `_used_words` 用 `Atomic::add` |
| jstat MC 含义 | "chunk 逻辑分配量" | `MetaspaceCounters::capacity()` → `MetaspaceUtils::committed_bytes()`（VSL 物理提交量），不是 `_capacity_words` |
| jstat MR 含义 | "MaxMetaspaceSize（硬上限）" | `MetaspaceCounters::max_capacity()` → `MetaspaceUtils::reserved_bytes()`（VSL 预约的虚拟地址空间总量），**不是** `MaxMetaspaceSize` |
| capacity vs committed 关系 | "capacity ≥ committed" | **committed ≥ capacity**——chunk 是 VSL committed 空间的子分配 |
| PerfData 计数器命名 | — | `sun.gc.metaspace.capacity`（实则 committed）、`sun.gc.metaspace.used`、`sun.gc.metaspace.maxCapacity`（实则 reserved）、`sun.gc.metaspace.minCapacity`（常量 0）；压缩类空间同理 `sun.gc.compressedclassspace.*` |

---

## 文章结构（5 篇）

按认知依赖排序：零门槛通道 → 需一个命令 → 需学新框架 → 综合场景。

```
ch10/07 核心机制
  │
  ├─→ 01-jstat-gc-log.md        ← 零门槛（不加参数就能用）
  │     ├─ jstat 数据源全路径
  │     └─ GC 日志底层实现
  │
  ├─→ 02-jcmd-metaspace.md      ← 需 jcmd 用法入门
  │     ├─ jcmd 基础 + 2 条 Metaspace 命令
  │     ├─ print_basic_report（无锁真相）
  │     └─ print_report（8 参数 × 6 ReportFlag × safepoint 遍历）
  │
  ├─→ 03-nmt.md                 ← 需学 NMT 框架
  │     ├─ NMT 基础（开启、命令、类别）
  │     └─ NMT × Metaspace（free 合成、diff 判泄漏）
  │
  ├─→ 04-jfr.md                 ← 需学 JFR 框架（学习成本最高）
  │     ├─ JFR 基础（event 模型、低开销原理）
  │     └─ JFR × Metaspace（3 个 event 完整字段 + 模板函数）
  │
  └─→ 05-diagnostic-scenarios.md ← 综合实战
        └─ 4 种场景 × 多通道横向对比
```

**依赖保证**：
- 05 可以自由引用 01-04 的任何内容——读者此时已学完全部通道
- 02 不引用 "像 NMT 那样"（NMT 在 03 才讲）
- 03 不引用 "像 JFR event 那样"（JFR 在 04 才讲）

---

## 各篇规划

### 01 — jstat + GC 日志

- [ ] **01-jstat-gc-log.md**
  | 定位: 零门槛通道——不加任何 JVM 参数就能用的两条诊断线
  | 前置: ch10/07

  **验证要点（写之前 MCP 确认）**：
  - [ ] jstat MC = `committed_bytes()` 不是 `_capacity_words` （已确认 ✓）
  - [ ] `MetaspaceCounters::update_performance_counters` 只在 GC epilogue 调用（已确认 ✓）
  - [ ] `MetaspaceSizesSnapshot` 构造时快照 6 个字段（已确认 ✓）
  - [ ] `print_metaspace_change` 的调用方在 `g1HeapTransition.cpp` 和 `genCollectedHeap.cpp`

  **Section 1. jstat MU/MC/MR★★** 
  - 工具入门：`jstat -gc` 列含义，聚焦 MU/MC/CCSC/CCSU
  - **数据源追踪**（核心）：`MetaspaceCounters` 的 PerfData 注册和更新全路径
    - 注册时（`initialize_performance_counters`）→ 在 `SUN_GC` 命名空间下创建 4 个 `PerfVariable`：
      - `sun.gc.metaspace.minCapacity`（常量 0）
      - `sun.gc.metaspace.capacity` ← `MetaspaceCounters::capacity()` = `committed_bytes()`
      - `sun.gc.metaspace.maxCapacity` ← `MetaspaceCounters::max_capacity()` = `reserved_bytes()`（不是 `MaxMetaspaceSize`！）
      - `sun.gc.metaspace.used` ← `MetaspaceCounters::used()` = `used_bytes()`
    - `CompressedClassSpaceCounters` 同理，命名空间 `sun.gc.compressedclassspace`
    - 更新时机：GC epilogue 调用 `update_performance_counters` → `MetaspacePerfCounters::update` → `PerfVariable::set_value` 写入共享内存
  - **关键陷阱 × 2**：
    - 陷阱一：MC 显示的是 `committed_bytes()`（VSL 物理提交量），不是 SpaceManager 的 `_capacity_words`
    - 陷阱二：MR 显示的是 `reserved_bytes()`（VSL mmap 预约总量），**不是** `MaxMetaspaceSize`（硬上限）——两者在 `global_initialize` 后可能不同
  - 趋势判读表 + 局限性

  **Section 2. GC 日志★★** 
  - 工具入门：`-Xlog:gc*=info` 输出结构
  - Metaspace 相关的 3 个 log tag 组合：
    - `gc+metaspace`：`Metaspace GC threshold reached`（MetaspaceGC 触发 GC 时）
    - `gc+metaspace+freelist`：chunk 分配/归还日志（调试用途）
    - `gc+metaspace+freelist+oom`：OOM 时的自动诊断（含自动 `print_basic_report` 输出）
  - **底层实现**：`MetaspaceSizesSnapshot` 6 字段 → `print_metaspace_change` 对比 → GC 无关
  - Full GC 行 + GC 触发日志的判读

### 02 — jcmd VM.metaspace + JMX MemoryPool

- [ ] **02-jcmd-metaspace.md**
  | 定位: jcmd 全线 + JMX MemoryPool MXBean——两种"主动查询" Metaspace 状态的通道
  | 前置: ch10/07 + 01（已理解 MU/MC/committed/used 关系）

  **验证要点（写之前 MCP 确认）**：
  - [ ] `_capacity_words` 用 `inc_stat_nonatomically`（持 `MetaspaceExpand_lock`），`_used_words` 用 `inc_stat_atomically`（Atomic::add）（已确认 ✓）
  - [ ] `free_chunks_total_bytes` 遍历 ChunkManager freelist 需要 `MetaspaceExpand_lock`
  - [ ] `VM_PrintMetadata::doit` 中先调 `print_basic_report` 再遍历 CLDG
  - [ ] `MetaspacePool::calculate_max_size()` 返回 `MaxMetaspaceSize`（显式设置时）否则 `undefined_size()`；与 jstat MR（`reserved_bytes()`）不同（已确认 ✓）
  - [ ] `VM_PrintMetadata::doit` 中先调 `print_basic_report` 再遍历 CLDG
  - [ ] `ClassLoaderMetaspaceStatistics` 的统计收集是 per-CLD 的 SpaceManager 累加

  **Section 1. jcmd 基础★** 
  - jcmd 是什么、怎么用
  - jcmd 与 Metaspace 相关的 4 条命令：
    | 命令 | 作用 | 影响 |
    |------|------|------|
    | `VM.metaspace` | Metaspace 内存布局诊断 | Medium（默认）/ 零（basic） |
    | `VM.classloader_stats` | per-CLD 类计数 + `_chunk_sz`/`_block_sz` | Low |
    | `VM.info` | 系统信息总览——内部调 `print_vm_info` → `print_basic_report`，等同超集 | Low |
    | `GC.class_stats` | per-class Metaspace 按类别分解（Klass/Cp/Method/annotations） | Medium（需 safepoint） |
  - safepoint 代价说明

  **Section 2. print_basic_report★★** 
  - 调用链追踪：`jcmd` → `DCmd::parse_and_execute` → `MetaspaceDCmd::execute` → `print_basic_report`
  - **计数器的锁策略**：`_capacity_words`/`_overhead_words` → `inc_stat_nonatomically`（持锁 `+=`），`_used_words` → `inc_stat_atomically`（`Atomic::add`）。为什么 `_capacity_words` 不用原子操作——因为 SpaceManager 分配时已持锁
  - 输出 4 组详解 + capacity vs committed 差异

**Section 3. print_report★★**
  - `VM_PrintMetadata` → safepoint → `CLDG_lock` → 遍历 CLDG
  - 8 参数 × 6 ReportFlag 详解
  - per-CLD 输出格式 + `ClassLoaderMetaspaceStatistics` 统计累加
  - `basic=true` vs 默认模式差异

**Section 4. JMX MemoryPool MXBean★**
  - 定位：JMX 通道——JConsole/VisualVM/Prometheus JMX exporter 通过这些 MBean 获取 Metaspace 数据
  - 初始化：`MemoryService::add_metaspace_memory_pools()`（`memoryService.cpp:111-125`）→ 创建 `MetaspacePool` 和 `CompressedKlassSpacePool` → 注册到全局 pool list → 绑定 "Metaspace" MemoryManager
  - `MetaspacePool`（`memoryPool.cpp:193-208`）：
    - `used_in_bytes()` → `MetaspaceUtils::used_bytes()`（total used）
    - `get_memory_usage()` → `MemoryUsage(0, used_bytes(), committed_bytes(), max_size())`
    - `calculate_max_size()` → `MaxMetaspaceSize`（显式设置时）或 `MemoryUsage::undefined_size()`（默认时）
  - `CompressedKlassSpacePool`（`memoryPool.cpp:210-220`）：同理，max = `CompressedClassSpaceSize`
  - **与 jstat 的关键差异**：JMX 的 max 是 `MaxMetaspaceSize`，jstat 的 MR 是 `reserved_bytes()`——两者完全不同。JMX 报告的是"允许达到的上限"，jstat 报告的是"已预约的虚拟地址空间"
  - 实时更新：`MemoryService::track_memory_usage()`（`memoryService.cpp:147-156`）遍历所有 pool 调 `record_peak_memory_usage` → 调用 `get_memory_usage` → 实时读取 `MetaspaceUtils`（不依赖 GC 完成）
  - 低内存检测：`LowMemoryDetector::detect_low_memory()` 检查 `MetaspacePool` 的 usage 是否超过高阈值——可触发 JMX notification
  - 访问方式：`ManagementFactory.getMemoryPoolMXBeans()` → 过滤 `name="Metaspace"`

**Section 5. GC.class_stats★★**
  - `jcmd <pid> GC.class_stats [-csv] [-all] [columns=...]` → `VM_GC_HeapInspection` → `KlassInfoHisto::print_class_stats`（`heapInspection.cpp:561`）
  - 默认显示 10 列：`InstBytes`（实例大小）/ `KlassBytes`（Klass 结构）/ `CpAll`（ConstantPool）/ `annotations` / `MethodCount` / `Bytecodes` / `MethodAll`（Method 元数据总量）/ `ROAll`（read-only，如符号）/ `RWAll`（read-write，如 vtables）/ `Total`
  - per-class 分解：每种元数据类型（Klass/Cp/Method/annotations/ro/rw）各行独立统计，可知晓"哪种元数据类型在膨胀"
  - 与 `VM.metaspace show-classes` 对比：前者的 used 是 bump pointer 已分配量（无分类），`GC.class_stats` 按元数据类别分解（`Klass::collect_statistics` 填充 `KlassSizeStats`）
  - 需 safepoint（`VM_GC_HeapInspection` 是 VM 操作）——生产慎用

### 03 — NMT

- [ ] **03-nmt.md**
  | 定位: NMT 全线——从开启参数到 diff 判泄漏的完整链路
  | 前置: ch10/07 + 01（已理解 Metaspace 内存三层状态）+ 02（已理解 capacity/committed 差异）

  **验证要点**：
  - [ ] `MemSummaryReporter::report_metadata` 的 free 合成公式（已确认 ✓）
  - [ ] `waste = committed - (used + free)` + `assert(committed >= used + free)`（已确认 ✓）
  - [ ] `MetaspaceSnapshot` 采集路径：mmap reserve/commit 时 `MemTracker` 记录

  **Section 1. NMT 基础★**
  - NMT 是什么、开启方式、基本命令
  - 类别系统（mtClass/mtThread/mtGC）
  - 不覆盖 `MemTracker` 拦截机制（留给 NMT 独立章）

  **Section 2. NMT × Metaspace★★**
  - mtClass 类别专节：`MemSummaryReporter::report_metadata` → committed/used/free/waste
  - free 合成公式的三部分拆解
  - diff 模式判泄漏：baseline → summary.diff → mtClass committed Δ
  - NMT vs jstat 对比表（数据源、更新时机、粒度、开销）

### 04 — JFR

- [ ] **04-jfr.md**
  | 定位: JFR 全线——event 模型到 MetaspaceTracer 的 3 个事件
  | 前置: ch10/07 + 01-03（已掌握全部其他通道）

  **验证要点**：
  - [ ] `MetaspaceTracer` 有 3 个方法：report_gc_threshold / report_metaspace_allocation_failure / report_metadata_oom（已确认 ✓）
  - [ ] `send_allocation_failure_event<E>` 模板函数——`EventMetaspaceAllocationFailure` 和 `EventMetaspaceOOM` 共用（已确认 ✓）
  - [ ] 3 个 event 的字段：classLoader/size/metadataType/metaspaceObjectType/anonymousClassLoader（已确认 ✓）
  - [ ] OOM 时 `report_metadata_oome` 同时做 JFR + GC 日志 + print_basic_report（已确认 ✓）

  **Section 1. JFR 基础★**
  - JFR 是什么、event 模型、低开销原理
  - 不覆盖录制引擎（留给 JFR 独立章）

  **Section 2. JFR × Metaspace★★**
  - `MetaspaceTracer` 的 3 个 event 完整字段
  - 模板函数 `send_allocation_failure_event<E>` 源码
  - 为什么 JFR 是唯一生产可用的通道

### 05 — 实战诊断场景

- [ ] **05-diagnostic-scenarios.md**
  | 定位: 综合实战——4 种常见 Metaspace 故障的完整排查链路
  | 前置: 01-04 全部（已掌握全部 4 条主动通道）
  | 预估: ~350-450 行

  4 种场景，每种按"现象 → 判据 → 排查链路（含具体 jcmd 命令行示例）→ 决策分支"组织：

  - **场景 1 - MU 只涨不跌**：jstat 趋势 → jcmd show-loaders 定位 → jcmd VM.classloader_stats 看 chunk_sz → NMT diff 确认
  - **场景 2 - MC>>MU 碎片化**：jstat 差距 → jcmd freelist → GC.run 判 purge 效果 → JDK 11 局限 vs JEP 387
  - **场景 3 - OOM: Metadata space**：MC≈MR？→ 罪魁 CLD？→ 5 种根因分类矩阵（含 CDS 未开 / Compressed class space 满了）
  - **场景 4 - fast load/unload 不释放**：freelist 复用策略 → 设计 trade-off → JDK 11 缓解方案

---

## 写作进度

| 篇 | 状态 | 日期 | 备注 |
|----|------|------|------|
| 01 | ✅ | 07/24 | jstat + GC 日志 (318行) |
| 02 | ✅ | 07/24 | jcmd 全线 + JMX + GC.class_stats (418行) |
| 03 | ✅ | 07/24 | NMT (307行) |
| 04 | ✅ | 07/24 | JFR — MetaspaceTracer + ClassLoaderStats (374行) |
| 05 | ✅ | 07/24 | 实战诊断场景 (329行) |

---

## 与前后章节的连接

```
ch10/07 核心机制 ──→ ch12 诊断（维修手册，5 篇）
  │                   │
  │  读者已理解：         ├─ 01: jstat + GC 日志（零门槛）
  │  VSL/ChunkManager   ├─ 02: jcmd VM.metaspace（需命令入门）
  │  SpaceManager       ├─ 03: NMT（需学框架）
  │  split/coalesce     ├─ 04: JFR（需学框架）
  │  MetaspaceGC/purge  └─ 05: 4 种实战场景（综合）
  │
  └──────────────────→ ch13 CDS 初始化
                       ch14 StringTable...
```
