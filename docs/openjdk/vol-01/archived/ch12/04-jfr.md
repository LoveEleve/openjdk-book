# 12.4 JFR —— 唯一的生产可用通道

> **本文定位**：JFR（Java Flight Recorder）全线——从 `JfrEvent` 基类和 `metadata.xml` 生成 event 类的机制，到 `MetaspaceTracer` 的 3 个 event 的完整触发链，再到 `JfrClassLoaderStatsClosure` 定期 per-CLD 采集。JFR 是 7 条诊断通道中**唯一能在生产环境长期开启**的——不需要 safepoint、不需要重启 VM、开销 <1%、支持事后回放。
>
> **前置依赖**：[ch09/07 Metaspace 背景知识](../ch09/07-metaspace.md) + [12.1 jstat](01-jstat-gc-log.md) + [12.2 jcmd](02-jcmd-metaspace.md) + [12.3 NMT](03-nmt.md)。
>
> **JDK 版本**：本文基于 **JDK 11u** 源码，实证输出使用 jdk11u-copy slowdebug 构建（JFR.start/dump/summary）。

---

## 1. JFR 基础

### 1.1 JFR 是什么

JFR 是 JVM 内建的**低开销事件记录系统**——不是采样器，是事件驱动：JVM 源码在关键位置调用 `event.commit()` 提交事件，JFR 框架写入线程本地缓冲区 → 周期性刷新到 `.jfr` 二进制文件。

**低开销三要素**：

1. **线程本地缓冲区**——每个 Java 线程有自己的 event buffer（`ThreadLocalBuffer`），写入无需跨线程同步
2. **紧凑二进制编码**——`BigEndianEncoder` + `CompressedIntegerEncoder` 编码，不是文本
3. **异步刷新**——后台 `JfrRecorderThread` 定期将 buffer 写入磁盘

**开启方式**：
```bash
java -XX:StartFlightRecording:filename=metaspace.jfr ...       # 启动时
jcmd <pid> JFR.start name=metaspace                            # 运行时（最灵活）
jcmd <pid> JFR.dump name=metaspace filename=metaspace.jfr       # 导出
jcmd <pid> JFR.stop name=metaspace                             # 停止
```

**查看**：`jfr print` / `jfr summary` / JDK Mission Control。

### 1.2 event 模型——从 metadata.xml 到 JfrEvent

JFR event 不是手写的——是通过 `metadata.xml`（`src/hotspot/share/jfr/metadata/`）描述的，构建时 `GenerateJfrFiles` 工具生成对应的 C++ 类。事件定义示例：

```xml
<Event name="MetaspaceGCThreshold" category="Java Virtual Machine, Memory, Metaspace"
       label="Metaspace GC Threshold" thread="true" stackTrace="true">
  <Field type="ulong" name="oldValue" label="Old Value" />
  <Field type="ulong" name="newValue" label="New Value" />
  <Field type="uint"  name="updater" label="Updater" />
</Event>
```

build 后生成的 C++ class `EventMetaspaceGCThreshold` 继承自 `JfrEvent`，每个 `Field` 成为 `set_oldValue(size_t)` 等方法。

使用时是栈对象——构造 = 记录时间戳，`set_xxx()` 填充字段，`commit()` 提交：
```cpp
EventMetaspaceGCThreshold event;          // 栈对象，构造时记时间戳
if (event.should_commit()) {              // 检查此事件类型是否在录制配置中启用
  event.set_oldValue(old_val);            // 填充字段
  event.set_newValue(new_val);           
  event.commit();                         // 提交到线程本地缓冲区
}
```

`should_commit()` 的开销极小——仅检查此事件类型在 `JfrEventManager` 注册表中的标志位，一次 bool 判断。未启用时整段代码的额外开销为零（编译器优化会跳过后面的 `set_xxx` 和 `commit`）。

### 1.3 event 的 commit() 链路

```
event.commit()
  → JfrEventWriterHost::commit(event)
    → JfrEventWriter::write_event_header(event)   // 写入 event 类型 ID + 时间戳
    → event.write_data(writer)                     // 写入字段数据（set_xxx 已填充）
    → writer.flush()                               // 如 buffer 满则触发刷新
      → JfrRecorderThread::process_full_buffer()  // 异步写入磁盘
```

线程本地缓冲区写满后，当前线程**不阻塞**——换一个新 buffer 继续写，旧 buffer 加入刷新队列由 `JfrRecorderThread` 异步处理。这是 JFR 能做到 <1% 开销的关键技术。

---

## 2. JFR 与其他 3 条通道的全量对比

在深入 MetaspaceTracer 之前，先建立 JFR 在完整工具箱中的定位：

| 维度 | jstat | jcmd print_basic | NMT | JFR |
|------|-------|-----------------|-----|-----|
| **触发方式** | 自动（GC epilogue） | 手动（jcmd） | 需启动参数（-XX） | 运行时 `jcmd JFR.start` |
| **数据源** | PerfData 计数器（共享内存） | SpaceManager/VSL 实时计数器 | MemTracker 实时记录（mmap 时） | MetaspaceTracer 回调 + 定期 VM 操作 |
| **更新时机** | GC 后 | 调用时 | mmap/malloc 发生时 | 事件发生时 / 定期 |
| **首次 GC 前** | MC=MU=0 ❌ | 正确值 ✅ | 正确值 ✅ | 正确值 ✅ |
| **per-CLD** | 不支持 | 不支持（basic）；支持（print_report） | 不支持 | 支持（ClassLoaderStatistics） |
| **事后回放** | 不支持 | 不支持 | 不支持 | ✅ .jfr 文件 |
| **事件上下文** | 无 | 无 | 无（除非 detail 模式） | ✅ classLoader/size/mdtype |
| **生产开销** | 极低 | safepoint（默认） | 1-5% | <1% |
| **重启 JVM** | 不需要 | 不需要 | 需要（已开则不需要） | 不需要 |
| **追踪历史** | GC 间 gap | 仅手动触发瞬间 | 开启后全部记录 | 开启后全部记录 |
| **OOM 回溯** | 只有 GC 瞬间的总量 | 来不及手动触发 | 需要事先开启 | ✅ .jfr 保存事件时间线 |

关键结论：**JFR 是唯一同时满足"低开销 + 事后回放 + per-CLD + 无需重启"的通道**。

---

## 3. MetaspaceTracer —— 事件驱动的 3 个关键节点

### 3.1 初始化与定位

`Metaspace::global_initialize()` 最后一行：

```cpp
_tracer = new MetaspaceTracer();   // metaspace.cpp:1341
```

`MetaspaceTracer`（`metaspaceTracer.hpp`）是 `CHeapObj<mtClass>` 子类，本身不存业务状态——只充当 3 个回调方法的载体。在整个 JVM 中只有这一个实例，通过 `Metaspace::tracer()` 全局访问。

### 3.2 三个事件——完整源码 + 触发链

`metaspaceTracer.cpp` 全部源码 75 行，3 个事件 + 1 个模板函数：

```cpp
/* === src/hotspot/share/memory/metaspaceTracer.cpp === */

// 事件 1：GC 高水位线被调整（升高或降低）
void MetaspaceTracer::report_gc_threshold(size_t old_val, size_t new_val,
                                          MetaspaceGCThresholdUpdater::Type updater) const {
  EventMetaspaceGCThreshold event;
  if (event.should_commit()) {
    event.set_oldValue(old_val);
    event.set_newValue(new_val);
    event.set_updater((u1)updater);
    event.commit();
  }
}

// 事件 2：分配全部失败（ChunkManager+VSL 都无空间）
void MetaspaceTracer::report_metaspace_allocation_failure(
    ClassLoaderData *cld, size_t word_size,
    MetaspaceObj::Type objtype, Metaspace::MetadataType mdtype) const {
  send_allocation_failure_event<EventMetaspaceAllocationFailure>(cld, word_size, objtype, mdtype);
}

// 事件 3：已确认要抛 OOM 异常
void MetaspaceTracer::report_metadata_oom(
    ClassLoaderData *cld, size_t word_size,
    MetaspaceObj::Type objtype, Metaspace::MetadataType mdtype) const {
  send_allocation_failure_event<EventMetaspaceOOM>(cld, word_size, objtype, mdtype);
}

// 事件 2 和 3 共用此模板
template <typename E>
void MetaspaceTracer::send_allocation_failure_event(
    ClassLoaderData *cld, size_t word_size,
    MetaspaceObj::Type objtype, Metaspace::MetadataType mdtype) const {
  E event;
  if (event.should_commit()) {
    event.set_classLoader(cld);
    event.set_anonymousClassLoader(cld->is_anonymous());
    event.set_size(word_size * BytesPerWord);
    event.set_metadataType((u1)mdtype);
    event.set_metaspaceObjectType((u1)objtype);
    event.commit();
  }
}
```

### 3.3 完整触发链——从分配请求到 OOM event

以 `Metaspace::allocate` 失败为例，从分配请求到 JFR event 提交的完整调用链：

```
Metaspace::allocate(loader_data, word_size, objtype, THREAD)
  │ metaspace.cpp:1366
  │
  ├─ ClassLoaderMetaspace::allocate(word_size, mdtype)
  │   └─ SpaceManager::allocate(word_size)
  │       ├─ 查 _block_freelists    → 命中 → 返回 ✅
  │       ├─ _current_chunk 有空间  → bump pointer 分配 → 返回 ✅
  │       └─ _current_chunk 满了    → SpaceManager::get_new_chunk()
  │           ├─ ChunkManager::chunk_freelist_allocate() → 命中 → 返回 ✅
  │           ├─ ChunkManager::chunk_freelist_allocate() → 未命中
  │           │   └─ VSL::get_new_chunk() → expand_by() → commit 更多页
  │           │       ├─ 成功 → 分配新 chunk → 返回 ✅
  │           │       └─ 失败（commit 也失败了）
  │           │           └─ CHAOS 开始 ↓
  │           │
  │           ├─ [再次尝试：触发了 GC，GC 后重试分配]
  │           │   └─ 同样失败
  │           │
  │           ├─ MetaspaceTracer::report_metaspace_allocation_failure() ⬅ 事件 2
  │           │
  │           └─ Metaspace::report_metadata_oome() ⬅ 事件 3
  │               ├─ tracer()->report_metadata_oom()         // 提交 JFR OOM event
  │               ├─ Log(gc, metaspace, freelist, oom)       // GC 日志
  │               ├─ MetaspaceUtils::print_basic_report()    // 自动 print_basic_report
  │               ├─ report_java_out_of_memory(space_string) // "Metaspace" 或 "Compressed class space"
  │               └─ THROW_OOP(Universe::out_of_memory_error_metaspace())
```

### 3.4 三个事件的字段与时间线

| 事件 | 字段 | 触发位置（源码） | 面试要点 |
|------|------|---------------|---------|
| **GCThreshold** | oldValue, newValue, updater | `MetaspaceGC::inc/dec_capacity_until_GC` / `compute_new_size` | 水位线为什么会降？GC 后 `compute_new_size` 调 `dec_capacity_until_GC`——如果 GC 后 committed 远低于期望容量 |
| **AllocationFailure** | classLoader, size, metadataType, metaspaceObjectType, anonymousClassLoader | `Metaspace::expand_and_allocate` 失败后（`metaspace.cpp:1366`） | 能定位到具体 CLD——知道是哪个 loader 的分配失败 |
| **OOM** | 同 AllocationFailure | `Metaspace::report_metadata_oome` 末尾（`metaspace.cpp:1416`） | AllocationFailure 和 OOM 有时间差——中间可能有一次 GC 尝试 |

时间线：
```
水位线升高 → GCThreshold: old=20M, new=40M
  ↓
... 若干次扩展尝试失败 ...
  ↓
AllocationFailure: loader=<app>, size=8192, mdtype=NonClassType
  ↓
触发一次 GC 尝试回收 Metaspace
  ↓
仍失败
  ↓
OOM: loader=<app>, size=8192, mdtype=NonClassType（与 AllocationFailure 参数完全一致）
  ↓
java.lang.OutOfMemoryError: Metaspace
```

---

## 4. MetaspaceTracer vs NMT —— 低开销替代方案

这是 12.3 NMT 篇中预告的核心对比：

| | NMT（mtClass 类别） | JFR（MetaspaceTracer） |
|---|---|---|
| **粒度** | 每次 mmap/malloc——数百条记录 | 仅关键事件——3 种 event |
| **开销来源** | 每次 `os::malloc`/`os::reserve_memory` 抓 `NativeCallStack`（调用栈哈希） | 仅在 if 判定 + 写几字节到线程本地 buffer |
| **开销量级** | 1-5%（频繁 mmap 场景更明显） | <1%（事件稀疏） |
| **优势场景** | 追踪"native memory 从哪来"——需要调用栈信息 | 追踪"Metaspace 哪里出问题了"——需要 classLoader + 时间线 |
| **事后回放** | 不支持 | 支持——.jfr 文件保存整个录制期 |
| **CLD 定位** | 不支持 | 支持——AllocationFailure 和 OOM 都记录 classLoader |

**面试高频题**："NMT 开销太大，有什么替代方案追踪 Metaspace 问题？"

→ JFR 的 MetaspaceTracer。NMT 的开销主要在**每 mmap 都抓调用栈**——Metaspace 分配通常不频繁（vs ZGC Page），但 NMT 对整个 JVM 的所有 `os::malloc` 都记录，全局开销不可忽略。JFR 只在 Metaspace 关键事件（GC 水位线变化 / 分配失败 / OOM）时记录，事件频率远低于 mmap 频率，开销几乎可以忽略。

---

## 5. JfrClassLoaderStatsClosure —— 定期 per-CLD 采集

### 5.1 架构

JFR 有两个 Metaspace 数据采集通道：**事件驱动**（MetaspaceTracer，上述 3 个 event）和**定期采集**（JfrClassLoaderStatsClosure，每 ~1s 运行一次）。

`JfrClassLoaderStatsClosure` 是 JFR Periodic Event 的一种——JFR 框架有一个定时器线程定期触发（默认 1 秒间隔），调用注册的 `TRACE_REQUEST_FUNC`：

```cpp
/* === src/hotspot/share/jfr/periodic/jfrPeriodic.cpp === */

TRACE_REQUEST_FUNC(ClassLoaderStatistics) {
  JfrClassLoaderStatsVMOperation op;
  VMThread::execute(&op);          // ← 这里进入 safepoint
}

// VM 操作在 safepoint 中执行
class JfrClassLoaderStatsVMOperation : public ClassLoaderStatsVMOperation {
  void doit() {
    JfrClassLoaderStatsClosure clsc;
    ClassLoaderDataGraph::cld_do(&clsc);   // 遍历所有 CLD
    clsc.createEvents();                    // 提交 JFR event
  }
};

// 对每个 CLD 提交一个 EventClassLoaderStatistics
class JfrClassLoaderStatsClosure : public ClassLoaderStatsClosure {
  bool do_entry(oop const& key, ClassLoaderStats* const& cls) {
    EventClassLoaderStatistics event;
    event.set_classLoader(this_cld);
    event.set_parentClassLoader(parent_cld);
    event.set_classLoaderData((intptr_t)cls->_cld);
    event.set_classCount(cls->_classes_count);
    event.set_chunkSize(cls->_chunk_sz);
    event.set_blockSize(cls->_block_sz);
    event.set_anonymousClassCount(cls->_anon_classes_count);
    event.set_anonymousChunkSize(cls->_anon_chunk_sz);
    event.set_anonymousBlockSize(cls->_anon_block_sz);
    event.commit();
    return true;
  }
};
```

**关键问题：这个定期采集需要 safepoint 吗？** 是的——`VMThread::execute(&op)` 会暂停所有 Java 线程（safepoint）。但因为是定期触发（每 1s 一次）且 CLDG 遍历在典型的几百到几千个 CLD 下很快（<1ms），分散到 1s 时间窗口里开销可忽略。

### 5.2 与 jcmd classloader_stats 的对比

| | jcmd VM.classloader_stats | JFR ClassLoaderStatistics |
|---|---|---|
| 触发 | 手动 | 自动每 ~1s |
| safepoint | 是（"Low"） | 是（分散到定期调度） |
| 输出 | 文本 | .jfr 二进制 |
| 事后回放 | 否 | 是——可以看到历史 per-CLD 变化 |
| 字段 | ChunkSz, BlockSz, Classes | chunkSize, blockSize, classCount, anonymousChunkSize, anonymousBlockSize, classLoader parent |

**生产价值**：JFR 版本不需要手动 jcmd——录制开启后自动每 1s 采集一次，OOM 后回放 .jfr 文件就知道"哪个 CLD 在 OOM 前 30 秒内 chunk 用量飙升了"。

---

## 6. JFR 实测——jdk11u-copy

### 6.1 启动录制

```bash
$ jcmd <pid> JFR.start name=metaspace
Started recording 1. No limit specified, using maxsize=250MB as default.
```

### 6.2 录制结果

7 秒录制（纯 sleep 的 HelloWorld），dump 出 263KB 文件：

```bash
$ jcmd <pid> JFR.dump name=metaspace filename=/tmp/metaspace11.jfr
Dumped recording "metaspace", 262.4 kB written to: /tmp/metaspace11.jfr
```

`jfr summary` 查看事件统计：

```
Event Type                              Count  Size (bytes)
=============================================================
jdk.ClassLoaderStatistics                  42          1192   ← JfrClassLoaderStatsClosure 每 ~1s
jdk.ClassLoadingStatistics                  6            84   ← 类加载统计
jdk.ThreadAllocationStatistics             43           584
jdk.ActiveSetting                         863         28152
```

**实证结论**：

1. **42 个 `ClassLoaderStatistics` 事件** → JfrClassLoaderStatsClosure 确实在工作。无 Metaspace 压力的 HelloWorld 也产生了每 ~1s 一次的 per-CLD 快照——但开销几乎为零（每个 CLD 几字节）。

2. **MetaspaceTracer 的 3 个事件未触发** → 符合预期。纯 sleep 不产生 GC 水位线变化或分配失败，验证了 JFR 的"按需记录"特性。

3. **263KB 文件中 ActiveSetting 事件占大头（863 个）** → 这是 JFR 启动时一次性记录的 JMX/flags 状态，与 Metaspace 无关。录制继续运行产生的数据量主要由定期采集贡献。

---

## 7. 全通道总结——诊断决策矩阵

写完 4 条通道（jstat → jcmd → NMT → JFR），给一个综合诊断决策矩阵：

```
需求                            推荐通道                为什么

日常监控 Metaspace 总量          jstat                  零成本，自动
首次看到异常——哪个 CLD 最大     jcmd show-loaders       能看到 per-CLD
怀疑泄漏——趋势确认              NMT baseline + diff    唯一能看历史趋势
事后审计——OOM 回溯              JFR                    唯一能事后回放 + 有时间线
生产环境长期监控                 JFR                    唯一 <1% 开销 + 可动态开启
crash 后查 Metaspace            hs_err 文件（被动）      自动输出 print_basic_report
看 per-CLD 历史变化             JFR ClassLoaderStats    唯一能回溯 per-CLD 历史
看"哪种元数据在膨胀"            jcmd GC.class_stats     per-class 分解（Knass/Cp/Method）
```

---

## 8. 小结

```
JFR × Metaspace 三条数据源：

1. MetaspaceTracer（事件驱动）
   → GCThreshold / AllocationFailure / OOM
   → NMT 的低开销替代方案——事件驱动 vs 每次 mmap 记录

2. JfrClassLoaderStatsClosure（定期 ~1s）
   → per-CLD chunkSize / blockSize / anonymous
   → jcmd classloader_stats 的 JFR 自动版本——OOM 回溯的关键

3. 类加载/卸载事件（JFR 内置）
   → ClassLoad / ClassDefine / ClassUnload
   → 提供 Metaspace 变化的业务语义上下文
```

下一篇（12.5）将前 4 篇全部通道综合运用，完成 4 种实战诊断场景。
