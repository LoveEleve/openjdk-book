# 12.3 NMT —— Native Memory Tracking

> **本文定位**：NMT 全线——开启方式、`MemTracker` 拦截 mmap/malloc 的完整路径、`MemSummaryReporter::report_metadata` 的 free/waste 合成公式、diff 模式判泄漏、以及 NMT 内部 `MetaspaceSnapshot` / `MemBaseline` 的工作机制。
>
> NMT 是 Metaspace 诊断工具箱中的**趋势分析**通道——jstat 是免费快照但不实时，jcmd 是手动触发但能 per-CLD，NMT 需要启动参数但有 jstat 和 jcmd 都不具备的能力：在两次采样点之间的**所有** Metaspace 内存事件都有记录。
>
> **前置依赖**：[ch09/07 Metaspace 背景知识](../ch09/07-metaspace.md) + [12.1 jstat + GC 日志](01-jstat-gc-log.md) + [12.2 jcmd VM.metaspace](02-jcmd-metaspace.md)——已经理解 committed/used/reserved 三层、capacity vs committed 差异。
>
> **JDK 版本**：本文基于 **JDK 11u** 源码，实证输出使用 jdk11u-copy slowdebug 构建。

---

## 1. NMT 基础——什么是 Native Memory Tracking

### 1.1 追踪范围

NMT 追踪的是 **HotSpot JVM 自身的 native memory**，具体分两类：

- **virtual memory**：`os::reserve_memory` / `os::commit_memory` / `os::uncommit_memory` / `os::release_memory`——mmap 生命周期
- **malloc memory**：`os::malloc` / `os::free`——C 堆分配

**不包括 Java 堆**。Java 堆由 GC 管理，堆内存的 mmap 也在 `mtJavaHeap` 类别中记录，但那不是 NMT 管理的，只是记录了元信息。

Metaspace 的内存全部归入 `mtClass` 类别——因为元数据内存是"类（Class）相关的"。分配 Metaspace 的 VirtualSpaceNode 时，`ReservedSpace::initialize` 内部调用 `os::reserve_memory`，然后通过 `MemTracker::record_virtual_memory_reserve` 记入 mtClass。

> **NMT 框架源码**（`MemTracker` 拦截 mmap 的完整实现、`MemBaseline` 快照 diff 算法、`MallocSiteTable` 调用栈追踪）在独立章节展开，ch12 只讲 Metaspace 如何通过 NMT 暴露数据。

### 1.2 开启与基本命令

```bash
# 启动时开启（必须——JDK 11 不支持运行时动态开启）
java -XX:NativeMemoryTracking=detail ...

# 基本命令
jcmd <pid> VM.native_memory summary              # 按类别汇总
jcmd <pid> VM.native_memory summary scale=KB     # 指定单位
jcmd <pid> VM.native_memory detail               # 按调用点展开（输出非常大）
jcmd <pid> VM.native_memory baseline             # 打基线——记录当前快照
jcmd <pid> VM.native_memory summary.diff         # 与 baseline 对比，输出 Δ
```

**性能开销**：开启 `detail` 模式约 1-5%。因为每次 `os::malloc` / `os::reserve_memory` 都要捕获调用栈（`NativeCallStack`）并存入 `MallocSiteTable`（哈希表）。分配频繁的场景（如 ZGC 的 Page 分配）开销更显著，但 Metaspace 分配频率低，影响较小。

### 1.3 类别系统

NMT 按 `MEMFLAGS` 枚举将 native memory 归入不同类别（`nmtCommon.hpp`），与 Metaspace 相关的：

| 类别 | 含义 | Metaspace 中归入此类的内存 |
|------|------|---------------------------|
| **mtClass** | 类元数据 | **Metaspace VSL 的全部 virtual memory**（VSN 的 mmap reserve + commit） |
| **mtChunk** | Arena 分配 | ChunkManager 内部 C heap 管理结构（`ChunkManager` 本身的 `CHeapObj`） |
| **mtInternal** | JVM 内部 | SpaceManager、Metachunk 等对象（这些是 `CHeapObj<mtClass>` 所以实际也归 mtClass） |

### 1.4 NMT 输出结构

`jcmd VM.native_memory summary` 输出按类别分块，每个类别块结构相同：

```
-CategoryName (reserved=总量, committed=总量)
    (特定类别的附加信息，如 classes 计数)
    (malloc=大小 #调用次数)
    (mmap: reserved=大小, committed=大小)
```

对于 mtClass，还会额外展开 `Metadata:` 和 `Class space:` 两个子块——这是 Metaspace 独有的（其他类别没有这种细分）。展开由 `MemSummaryReporter::report_metadata`（`memReporter.cpp:192-217`）完成。

---

## 2. NMT 如何采集 Metaspace 数据

### 2.1 采集路径——mmap 时实时记录

NMT 的数据**不是**从 `MetaspaceUtils` 读的——它有自己的追踪管道，在每次 mmap/malloc 发生时实时记录。Metaspace 相关的采集路径：

```
VirtualSpaceNode 构造
  → ReservedSpace::initialize(size, alignment, requested_addr)
    → os::reserve_memory(size, requested_addr)          // mmap(PROT_NONE) reserve
    → MemTracker::record_virtual_memory_reserve(         // NMT 记录
        base, size, CALLER_NATIVE_CALL_STACK, mtClass)

VirtualSpaceNode::expand_by(min_words, preferred_words)
  → _virtual_space.expand_by(words)
    → os::commit_memory(addr, size)                     // commit 物理页
    → MemTracker::record_virtual_memory_commit(          // NMT 记录
        addr, size, CALLER_NATIVE_CALL_STACK, mtClass)

Metaspace::purge → VirtualSpaceList::purge → ~VirtualSpaceNode
  → VirtualSpace::release()
    → os::uncommit_memory + os::release_memory
    → MemTracker::record_virtual_memory_uncommit + release
```

`CALLER_NATIVE_CALL_STACK` 是一个宏，展开为 `NativeCallStack::EMPTY_STACK`（summary 模式下）或真实的调用栈（detail 模式下）。**不抓调用栈时 NMT 只记录大小和类别**，这就是为什么 summary 模式比 detail 模式快得多。

### 2.2 NMT committed vs jcmd committed

两者都反映 VSL 的物理提交量（committed_bytes），但数据路径不同：

| 维度 | NMT | jcmd |
|------|-----|------|
| 数据来源 | `MemTracker::record_virtual_memory_commit` 在 `os::commit_memory` 时记录 | `MetaspaceUtils::committed_bytes()` → VSL `_committed_words` |
| 更新时机 | **mmap 发生时**实时记录 | **调用时**实时查询 VSL |
| 粒度 | per-mmap-call（每次 commit 都独立记录） | 聚合（VSL 层计数器） |
| 可回溯 | 是——上次 baseline 到现在的所有记录都在 | 否——只读当前状态 |

正常情况下两者数值一致。如果不一致，可能原因：

1. **NMT 开启前已有 Metaspace 分配**——NMT 无法追踪已在追踪前分配的内存（比如 `-XX:NativeMemoryTracking=detail` 在 JVM 启动后期才处理的场景）
2. **NMT 计数器和 VSL 计数器有偏差**——极端情况下 `MemTracker` 的哈希表可能丢记录
3. **采样时间差**——NMT 是累积记录，jcmd 是瞬间快照——理论上不应该差但实践中有极微小偏差

---

## 3. mtClass 类别逐行解读

jdk11u-copy 实测 NMT summary 输出（mtClass 部分）：

```
-                     Class (reserved=1057082KB, committed=7482KB)
                            (classes #1026)
                            (  instance classes #923, array classes #103)
                            (malloc=314KB #2266)
                            (mmap: reserved=1056768KB, committed=7168KB)
                            (  Metadata:   )
                            (    reserved=8192KB, committed=6400KB)
                            (    used=6266KB)
                            (    free=134KB)
                            (    waste=0KB =0.00%)
                            (  Class space:)
                            (    reserved=1048576KB, committed=768KB)
                            (    used=627KB)
                            (    free=141KB)
                            (    waste=0KB =0.00%)
```

对比一下同一时刻 jcmd 的输出：

```
# jcmd VM.metaspace basic=true
Non-class: committed=6.25MB (≈6400KB)
Class: committed=768KB
```

NMT 的 Metadata.committed=6400KB = jcmd 的 Non-class committed。数值吻合——因为两者都是 `committed_bytes()`，只是采集路径不同。

### 3.1 第 1 行——类别摘要

jdk11u-copy 实测（NMT detail 模式，已加载 1026 个类）：

```
-Class (reserved=1057082KB, committed=7482KB)
```

`reserved` = 该类别的全部保留内存（mmap reserve + malloc）。`committed` = 全部提交量（mmap commit + 已用的 malloc 空间）。7482KB committed 与 jcmd 显示的 7.00MB 提交量一致。

### 3.2 classes 计数

```
(classes #1025)
```

这个计数来自 `ClassLoaderDataGraph::num_instance_classes()` + `num_array_classes()` 的累计，与 Metaspace 本身的内存无关——它只是附加的信息性统计。12.2 的 `VM.classloader_stats` 中也输出类似计数。

### 3.3 malloc 行

```
(malloc=108KB #1149)
```

mtClass 中的 C heap 分配总量。包含什么？`CHeapObj<mtClass>` 的所有子类——SpaceManager、Metachunk、VirtualSpaceNode、ChunkManager 等对象本身使用的是 C heap（`os::malloc`），而它们管理的元数据才用 VSL mmap。这些 C heap 分配非常零碎（1149 次分配才 108KB），对 Metaspace 内存总量影响很小。

### 3.4 mmap 行——Metaspace 的主体

```
(mmap: reserved=1048576KB, committed=128KB)
```

VSL 的 mmap reserve + commit。1048576KB = 1GB——这是因为 `CompressedClassSpaceSize` 默认 1GB，Class VSL reserve 了 1GB（NonClass VSL 的 reserve 远小于此，因为 NonClass 不需要压缩指针可达区）。

committed 只有 128KB——说明大部分 reser ved 空间没有被 commit。这是正常状态：VSL reserve 一大块虚拟地址空间但只在需要时按需 commit 物理页。

### 3.5 Metadata: 和 Class space:——两种 VSL 的细分

`(Metadata:)` → NonClass VSL 的细分。`(Class space:)` → Class VSL 的细分（只在 `UseCompressedClassPointers=true` 时存在）。两者的格式相同：

```
(Metadata:)
(reserved=65536KB, committed=640KB)
(used=602KB)
(waste=38KB =5.99%)
```

`reserved` 和 `committed` 来自 VSL。`used` 来自 SpaceManager 的 `_used_words`。`waste` 的计算见下节的 free 合成公式。

---

## 4. free 和 waste 的合成

`MemSummaryReporter::report_metadata`（`memReporter.cpp:192-217`）为 Metadata 和 Class space 各计算 free 和 waste：

```cpp
/* === src/hotspot/share/services/memReporter.cpp === */

void MemSummaryReporter::report_metadata(Metaspace::MetadataType type) const {
  size_t committed = MetaspaceUtils::committed_bytes(type);
  size_t used = MetaspaceUtils::used_bytes(type);

  // free 是三项的合成——对应 Metaspace 三层架构的不同层
  size_t free = (MetaspaceUtils::capacity_bytes(type) - used)     // ① chunk 内
              + MetaspaceUtils::free_chunks_total_bytes(type)      // ② ChunkManager
              + MetaspaceUtils::free_in_vs_bytes(type);            // ③ VSL 原始

  assert(committed >= used + free, "Sanity");
  size_t waste = committed - (used + free);
}
```

三项 free 的逐层拆解：

```
① capacity_bytes - used
   └─ SpaceManager 层：持有的 chunk 中 bump pointer 之后未分配空间
      → "chunk 中还有地方，可以直接分配，不需要新 chunk"

② free_chunks_total_bytes
   └─ ChunkManager 层：freelist 中的空闲 chunk
      → 注意：这里 chunk 里的空间已在 committed 中（VSL commit 过），
         但目前不属于任何活跃 CLD

③ free_in_vs_bytes
   └─ VSL 层：已 commit 但尚未被 get_new_chunk 分配给 ChunkManager
      → 纯"待分配"空间——commit 了但还没用
```

三项加起来 = Metaspace 三层架构中所有的"空闲但已提交"空间。`waste = committed - (used + free)` 是 committed 中不属于三者的剩余——通常极小，来自 VirtualSpaceNode 内部的对齐碎片或统计偏差。

**waste 很高怎么办？** 在 JDK 11 中，waste 高通常意味着 ChunkManager freelist 中堆积了大量 chunk（commit 了但未被复用），但它们物理上不连续，coalesce 失败，Node 无法被整个释放。JDK 16+ 的 per-granule uncommit 解法了这个问题。

---

## 5. diff 模式——判定是否泄漏

### 5.1 使用方法

```bash
jcmd <pid> VM.native_memory baseline          # T1：记录当前快照
# ... 等待 30 分钟——期间可能有加载/卸载类 ...
jcmd <pid> VM.native_memory summary.diff      # T2：与 T1 对比
```

diff 输出格式与 summary 相同，但数字后带 `+xxx` / `-xxx` 变化量：

```
-Class (reserved=1048684KB +24576KB, committed=236KB +128KB)
    (mmap: reserved=1048576KB +24576KB, committed=128KB +64KB)
    (  Metadata:   )
    (    committed=640KB +64KB)
    (    used=602KB +32KB)
    (    waste=38KB =5.99%)
```

变化量来自 `MemSummaryDiffReporter::diff_summary_of_type`（`memReporter.cpp:423`），内部调 `diff_in_current_scale` 对比两个 `MetaspaceSnapshot` 的差异。

### 5.2 判断

jdk11u-copy 实测 baseline + diff（15 秒后）：

```
# diff 15 秒后——mtClass 基本无变化（无新类加载，Metaspace 稳定）
-Class (reserved=1057082KB, committed=7482KB)
    (mmap: reserved=1056768KB, committed=7168KB)
    (Metadata: committed=6400KB, used=6266KB, free=134KB, waste=0KB)
    (Class space: committed=768KB, used=627KB, free=141KB, waste=0KB)
```

diff 数字前无 `+` 或 `-`——说明此时 Metaspace 已稳定（类加载完成了，没有再新增或卸载）。如果类泄漏存在，会看到 committed 持续 `+` 增长。

| diff 信号 | 解读 | 行动 |
|----------|------|------|
| committed +X, used +X（≈X） | 正常——加载了新类，元数据同步增长 | 继续观察 |
| committed +X, used +0 | 碎片化——chunk 被 commit 但没有被用完，或 freelist 堆积 | jcmd per-CLD 定位、考虑类加载器池化 |
| committed +X, used +X 但 X 不回落 | 可能泄漏——类被加载后永不卸载 | jcmd per-CLD 找增长最大的 loader |
| committed -X, used -X | 类卸载 + purge 生效——内存已经被回收 | 健康 |

**与 jstat 趋势的协同判断**：NMT diff 看到 committed +128KB → 但 jstat 的 MC 没变（还是 0 因为还没 GC）→ 说明 NMT 更早发现了问题。

---

## 6. 三条通道的三角对比

| 维度 | NMT | jstat | jcmd print_basic_report |
|------|-----|-------|------------------------|
| 数据源 | `MemTracker` 实时记录（mmap 时） | PerfData `MetaspaceCounters` | `MetaspaceUtils` 实时读取 |
| 更新时机 | mmap/malloc 发生瞬间 | **GC epilogue 后** | **调用时** |
| 首次 GC 前 | 反映真实值 | 全 0 | 反映真实值 |
| committed 含义 | VSL 物理提交（`os::commit_memory` 记录） | `committed_bytes()` | `committed_bytes()` |
| used 含义 | `used_bytes()` | `used_bytes()` | `used_bytes()`（`_capacity_words` 在 Usage 行中显示） |
| per-CLD 分解 | 不支持 | 不支持 | 不支持（basic 模式）；支持（print_report 模式） |
| 历史对比 | **支持——baseline + diff** | 不支持 | 不支持 |
| 生产可用性 | 需启动参数 + 1-5% 开销 | 随时可用 | basic=true 安全 |

---

## 7. 局限性

- **必须启动参数**：没有 `-XX:NativeMemoryTracking=detail` 就不能用——旧的 JVM 只能重启
- **开销 1-5%**：每次 `os::malloc` / `os::commit_memory` 都要抓调用栈（detail 模式）
- **不能 per-CLD**：只知道 mtClass 总量——要定位到底是哪个 loader 在涨，还得靠 jcmd `show-loaders`
- **不能区分活类和死类**：CLD 可能已经 dead 但 GC 还没跑到——NMT 记录的是"是否还有物理内存"，不是"是否还有存活对象"
- **detail 输出量大**：per-call-site 展开可能导致 jcmd 输出几百 MB——生产谨慎

---

## 8. 小结

```
NMT 核心结论：

1. NMT 追踪的是 JVM native memory（malloc + mmap），不是 Java 堆
2. Metaspace 的内存全部在 mtClass 类别——mmap 时 MemTracker 实时记录
3. free = (capacity-used) + free_chunks_total + free_in_vs（三层空闲空间）
4. diff 模式是追踪 Metaspace 历史趋势的唯一工具
5. NMT committed ≈ jstat MC ≈ jcmd committed——都是 committed_bytes()，数据源不同

诊断决策流程：
  日常监控      → jstat（0 成本）
  问题发生      → jcmd VM.metaspace basic=true / show-loaders=true（快速定位）
  怀疑泄漏      → NMT baseline + summary.diff（唯一能看趋势）
  事后审计      → JFR（下一节）
```

下一篇（12.4）讲解 JFR——`MetaspaceTracer` 的 3 个 JFR event。
