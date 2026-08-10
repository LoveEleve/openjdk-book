# 01. jmap -dump 怎么工作？— Heap Dumper + hprof 格式

> 🔴 Deep | 1 KP 中的堆快照
> 读者处境: `jmap -dump:live,file=heap.hprof <pid>` → JVM 在 safepoint 暂停→遍历所有 oop→写入 hprof binary records→MAT 分析。

### 1. "hprof format — binary heap dump"

场景: dump heap → GC root set → iterate all instances per class → write class info + instance data。

**HeapDumper** (`services/heapDumper.hpp:40-150 + heapDumper.cpp:200-800`):
```
dump_heap():
  1. Safepoint stop
  2. Write hprof header(magic: JAVA PROFILE 1.0.2, id size, timestamp)
  3. GC Roots: JNI global/thread stacks/classes/system
  4. Classes: per-class metadata(name, super, class loader, field descriptors)
  5. Instances: per-instance data(field values per object)
  6. Primitive arrays: byte/int/long array content
  7. Object arrays: element oop IDs
```
- 源码: `services/heapDumper.cpp:200-800` + `heapDumper.hpp:40-150`
- 关键设计: `-dump:live` option → GC_full before dump →只 dump 存活对象 (excluding dead objects)。Dump 在 safepoint 中执行→STW 时间与 heap size 线性增长
- [C++: `DumperWriter` 管道是 OutputStream 子类(can be file/gzip/file+compress)——支持边 dump 边 compress。`DumperSupport::dump_instance()` iterate fields via Klass→`field_descriptor`→read value from oop→write to stream]

---

### 核心悬念

**"HeapDumper 在 safepoint 中遍历 GC roots+classes+instances→写入 hprof binary records。`-dump:live` 先 Full GC 只存存活对象。"** — 下一篇: Compression。

> → [02-compression-triggers.md](02-compression-triggers.md)
