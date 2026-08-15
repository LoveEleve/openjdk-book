# 01. jmap -dump 怎么工作？ — HeapDumper + hprof 格式

> 🔴 Deep | heap dump 全管道
> 读者处境: `jmap -dump:live,file=heap.hprof <pid>` — JVM 进入 safepoint → GC(若 -dump:live) → 遍历所有 oop → 写入 hprof binary records → MAT 分析。10GB heap → 10GB file(慢)。转储在 STW 中执行——heap size 越大 STW 越长。

> ⚠️ 写作期修正(2026-08-15, vol-02/37-heap-dumper/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"ID 不是 address——递增序列号" 编造(重要)**: JDK11 的 `write_objectID` **直接写 oop 地址**(heapDumper.cpp:526-533,`write_u8((u8)a)`);class ID = **java mirror 地址**(:553-555 注释 "We use java mirror as the class ID");符号 ID = Symbol 指针(:535-542)——地址作 ID 正是转储必须 safepoint 的原因(GC 压缩会移动对象);"跨 dump 追踪生命周期/ID 占 2GB" 段落全部删除(基于序列号假设)
> - **"heapDumper.hpp:40-80 定义头" 错**: heapDumper.hpp 仅 83 行;格式注释在 **heapDumper.cpp:52-130**(从 hprof_io.c 复制);"JAVA PROFILE 1.0.2" 写于 work() :1816-1822(header+u4 oopSize+u8 时间戳)
> - **"heapDumper.cpp:1931-2100 dump 主入口" 行号错**: HeapDumper::dump 在 **:1931-1984**(文件总 2112 行);VM_HeapDumper::doit :1775-1806;work :1809-1894
> - **"VM_HeapDumper 是 VM_Operation" 半对**: 真实=**VM_GC_Operation + AbstractGangTask**(:1477);GC 在 **doit() 内 `ch->collect_as_vm_thread(GCCause::_heap_dump)`**(:1786,非 VM_GC_Operation prologue),**GCLocker 活跃时跳过并 warning**(:1781-1784);执行: VM 线程直接 doit() 否则 VMThread::execute(:1966-1977);**ensure_parsability 必须先于任何遍历**(:1778,即使不做 GC);WorkGang 并行(:1796-1801: VM 线程跑 work 主流程,worker 线程 writer_loop 只写文件 :1813-1815)
> - **"DumperWriter" 名字错**: 真实=**DumpWriter**(heapDumper.cpp:380)+ AbstractWriter/CompressionBackend;writer_loop 是 DumpWriter 方法
> - **sub-record 格式与标准 hprof spec 不同(重要,实证逐字节验证)**: ①CLASS_DUMP(0x20)= `id class + u4 STACK_TRACE_ID + id×6(super/loader/signers/protection_domain/reserved×2) + u4 instance size + 常量池/static/instance 字段描述符`(dump_class_and_array_classes :994-1033)——**无 u4 class serial**;②INSTANCE_DUMP(0x21)= `id object + u4 STACK_TRACE_ID + id class + u4 size + 字段值`(dump_instance :969-987)——标准 spec 无 object id/stid;③OBJ_ARRAY(0x22)/PRIM_ARRAY(0x23)同样带 u4 STACK_TRACE_ID(:1145-1159/:1179-1193);STACK_TRACE_ID=常量 1(:373);④sub-record = u1 tag+body(无 time/len,长度由类型决定),9 字节头只属于段记录(1C+u4 time+u4 len)
> - **"-dump:live 通过 _gc_before_heap_dump flag" ✓**(构造传 VM_GC_Operation :1519-1523)
> - **"10GB heap → 10GB file" 无源码依据**(规划数字,删除)
> - **缺机制(重要)**: ①段分割=start_sub_record(:575-603): 段头 1C+u4(0)+u4(len) **动态回填**("Will be fixed up later"),放不下/超大 sub-record 时 finish_dump_segment 开新段;HEAP_DUMP_SEGMENT=0x1C/HEAP_DUMP_END=0x2C(:307-342);②work() 顺序: UTF8 符号→LOAD_CLASS→FRAME/TRACE→CLASS_DUMP→safe_object_iterate INSTANCE/ARRAY(:1864-1865)→THREAD_OBJ/JNI locals→MONITOR_USED→JNI_GLOBAL(含 Universe::oops_do 全局根 :1877-1879)→**STICKY_CLASS=null class loader 的类**(:1883-1887)→END;③do_object 跳过 Class 对象(:1451-1457)+CDS dormant 对象(:1459-1461);④压缩=GZipCompressor(HeapDumper::dump :1940-1944,02 篇主题);⑤输出 "Heap dump file created [N bytes in X secs]"(:1969-1973);⑥OOME 路径(_oome 参数,OOME 构造器假帧)
> - **实证**: 37-heap-dumper-demo.txt(15.4MB/16 段 vs live 6.0MB/4 段;顶层 UTF8 49109/LOAD_CLASS 2211/FRAME 30/TRACE 8;段内 INSTANCE 104269/PRIM_ARRAY 34837/OBJ_ARRAY 23378/CLASS_DUMP 2021/STICKY 1601/JNI_GLOBAL 64/THREAD_OBJ 7;live 后 INSTANCE 37782(-64%);文件头 xxd;JDK11 变体逐字节验证)——解析脚本: 顶层记录 9 字节头、段内 sub-record 9 字节头、CLASS_DUMP 无 serial 64 字节头
> - **悬念指向 02 ✓**(压缩+多触发;02-compression-triggers.md 标题 "流式压缩 + 多触发入口")

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
