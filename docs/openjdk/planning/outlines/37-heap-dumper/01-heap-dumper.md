# 01. jmap -dump 怎么工作？ — HeapDumper + hprof 格式

> 🔴 Deep | heap dump 全管道
> 读者处境: `jmap -dump:live,file=heap.hprof <pid>` — JVM 进入 safepoint → GC(若 -dump:live) → 遍历所有 oop → 写入 hprof binary records → MAT 分析。10GB heap → 10GB file(慢)。转储在 STW 中执行——heap size 越大 STW 越长。

### 1. "hprof 格式 — binary heap dump 结构"

场景: Heap dump 不是 JSON/XML——是 JDK 专有的 hprof binary 格式。MAT/jhat/YourKit 等工具都解析这个格式。

**hprof 记录序列** (`heapDumper.hpp:40-80`):
```
1. Header: "JAVA PROFILE 1.0.2\0" + id size(4/8字节) + 时间戳(ms since epoch)
2. STRING records: 所有 interned String → UTF-8 id + 字符内容
3. LOAD CLASS records: 每个加载的 class → class ID + name + serial number
4. GC ROOT records: JNI global refs / thread stacks / system classes / sticky classes
5. HEAP DUMP segment[hprof spec]:
   a. CLASS DUMP: per-class metadata(super class / class loader / field descriptors / static fields)
   b. INSTANCE DUMP: per-instance → class ID + per-field values(primitive or oop IDs)
   c. OBJECT ARRAY DUMP: object[] → element oop IDs
   d. PRIMITIVE ARRAY DUMP: byte[]/int[]/long[] → raw bytes
```
- 源码: `heapDumper.hpp:40-80` (hprof header 定义) + `heapDumper.cpp:1931-2100` (HeapDumper::dump 主入口)

- 关键设计: **ID 不是 address**——hprof 中的每个 oop 有一个递增的序列号(id)，不是堆地址。这样 MAT 可以在跨 dump 的加载/卸载间追踪对象生命周期。**id size** 在 64-bit JVM 为 8 字节——写入 256M+ 对象时 ID 占用 2GB。

### 2. "HeapDumper::dump — safepoint + iterate"

场景: `jmap -dump:live,file=dump.hprof 1234` → Attach API 请求 → `HeapDumper::dump(path)` → safepoint → GC → 遍历 → 写文件。

**VM_HeapDumper::work** (`heapDumper.cpp:1809-1860`):
```
VM_HeapDumper::work(worker_id):  // VMThread 执行——在 safepoint 内
  → write_raw("JAVA PROFILE 1.0.2") + write_u1(0) + write_u4(oopSize) + write_u8(timestamp)
  → SymbolTable::symbols_do() → HPROF_UTF8 records
  → ClassLoaderDataGraph::classes_do(&do_load_class) → HPROF_LOAD_CLASS records
  → dump_stack_traces() → HPROF_FRAME + HPROF_TRACE records (thread stacks)
  → ClassLoaderDataGraph::classes_do(&do_class_dump) → HPROF_GC_CLASS_DUMP (per-class metadata)
  → Universe::heap()->safe_object_iterate(&obj_dumper) → HPROF_GC_INSTANCE_DUMP (per-object data)
  → do_threads() → HPROF_GC_ROOT_THREAD_OBJ + frames + JNI locals
  → ObjectSynchronizer::oops_do() → HPROF_GC_ROOT_MONITOR_USED
  → JNIHandles::oops_do() → HPROF_GC_ROOT_JNI_GLOBAL
[C++: heapDumper.cpp:2112行——work() 在 safepoint 中执行——VMThread→dump→concurrent worker threads→分 block 写文件]
```
- 源码: `heapDumper.cpp:1931-2000` (dump 入口) + `heapDumper.cpp:1400-1600` (do_dump_heap + do_gc_roots) + `heapDumper.cpp:928-990` (dump_instance)

- 关键设计: **VM_HeapDumper 是 VM_Operation**——在 safepoint 中执行→全部 mutator threads 暂停→保证 heap 一致性但没有并发。**`-dump:live` 通过 `_gc_before_heap_dump` flag 控制**(`heapDumper.cpp:1783`)——GC 在 `doit()` 中、work() 之前执行。**DumperWriter 抽象**——Output 可以是 FileStream/GZipStream/nullStream——writer() 通过 `writer_loop()` 支持并发 worker threads 边遍历边写流不需要暂存全部对象。**oopSize** (`heapDumper.cpp:1821`) 写入 hprof header——64-bit JVM=8 字节。

---

### 核心悬念

**"HeapDumper = VM_Operation → safepoint → hprof binary format(Header+Strings+Classes+GC Roots+Instances+Arrays) → DumperWriter 边遍历边写。`-dump:live` 先 Full GC 去 dead objects 但延长 STW。"** — 下一篇: 压缩 + 多触发入口。

> → [02-compression-triggers.md](02-compression-triggers.md)
