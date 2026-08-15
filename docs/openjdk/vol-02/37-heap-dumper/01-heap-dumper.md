# 01. jmap -dump 怎么工作?— HeapDumper + hprof 格式

> **前置依赖**:[36-attach/01 — jcmd 怎么连接到运行中的 JVM?— AttachListener + Socket IPC](openjdk/vol-02/36-attach/01-attach-listener.md):dumpheap 操作(attachListener.cpp:220-242)是 attach 通道的入口之一;[36-attach/02 — 怎么在运行时动态加载 JVMTI agent?— JDK Attach API + loadAgent](openjdk/vol-02/36-attach/02-jdk-attach.md):jmap 工具经 attach 发送 dumpheap 命令;[20-vm-operations/01 — "帮我做 GC"——VM_Operation 从提交到执行](openjdk/vol-02/20-vm-operations/01-vm-operation.md):HeapDumper 是 VM_Operation 家族
> → **后续**:[37-heap-dumper/02 — 流式压缩 + 多触发入口: jcmd/JMX/JFR/OOM](02-compression-triggers.md)
> 关联域: 25-gc(safepoint 与 GC 集成)、10-metaspace(类数据)

## 一坨 15MB 的二进制,怎么描述整个堆

`jmap -dump:live,file=heap.hprof <pid>` 出来的文件不是 JSON 也不是 XML——是 JDK 专有的 **hprof binary 格式**,MAT/jhat/YourKit 都解析它。这份文件的头部只有 19 个字节("JAVA PROFILE 1.0.2\0"),其余全是**记录流**;堆里的每个对象最终对应一条 INSTANCE_DUMP 或数组 dump 记录。这篇拆三层: 触发与执行模型(VM 操作 + safepoint + 可选 GC)、hprof 格式(头部/记录/段/sub-record)、对象 ID 的真相(地址即 ID,不是序列号)。[实证](planning/outlines/00-jvm-tools/materials/commands/37-heap-dumper-demo.txt)里 15MB 的文件被逐字节解析,记录结构与源码逐行对上。

## 1. 执行模型: 一个 VM 操作,可选 GC,并行写

入口链: jmap → attach 的 `dumpheap` 操作(attachListener.cpp:220-242)→ `HeapDumper::dump`(heapDumper.cpp:1931-1984)。`dump` 先建 `DumpWriter`(文件 + 可选 GZipCompressor,:1940-1944,压缩是 02 篇主题),再构造 **`VM_HeapDumper`——同时继承 `VM_GC_Operation` 与 `AbstractGangTask`**(:1477)。执行: 若已在 VM 线程(如 OOME 场景)直接 `doit()`;否则 `VMThread::execute` 提交(20-01 域的机制,:1966-1977)。

`doit()`(:1775-1806)是三段式:

```cpp
// heapDumper.cpp:1777-1794(截取核心,逐字)
  HandleMark hm;
  CollectedHeap* ch = Universe::heap();

  ch->ensure_parsability(false); // must happen, even if collection does
                                 // not happen (e.g. due to GCLocker)

  if (_gc_before_heap_dump) {
    if (GCLocker::is_active()) {
      warning("GC locker is held; pre-heapdump GC was skipped");
    } else {
      ch->collect_as_vm_thread(GCCause::_heap_dump);
    }
  }
```

①`ensure_parsability`(:1778)——让堆"可遍历": 所有线程退出 TLAB 等,即使不做 GC 也必须执行;②`-dump:live` 的 `_gc_before_heap_dump` 为 true 时做 **Full GC**(`collect_as_vm_thread(GCCause::_heap_dump)`);**GCLocker 活跃时跳过 GC 并打 warning**(:1781-1784);③设置全局 dumper/writer,用 **WorkGang 并行**执行 `work()`(:1796-1801): gang 存在则 `run_task`(VM 线程跑 work 主流程、worker 线程跑 `writer_loop` 只写文件),否则单线程。*关键设计: 转储在 safepoint 内(STW)完成——堆一致性换暂停;并行 worker 只做 IO 不遍历,遍历集中在 VM 线程*。

`work()`(:1809-1894)的产出顺序就是文件记录顺序: **头部** → UTF8 符号(`SymbolTable::symbols_do`)→ LOAD_CLASS(`ClassLoaderDataGraph::classes_do`+基本类型数组类)→ FRAME/TRACE(线程栈)→ CLASS_DUMP(`classes_do`+`do_basic_type_array_class_dump`)→ INSTANCE/ARRAY DUMP(**`Universe::heap()->safe_object_iterate`**,:1864-1865)→ THREAD_OBJ/线程帧/JNI locals(`do_threads`)→ MONITOR_USED(`ObjectSynchronizer::oops_do`)→ JNI_GLOBAL(`JNIHandles::oops_do`+`Universe::oops_do`,注释 "technically not jni roots, but global roots for things like preallocated throwable backtraces")→ STICKY_CLASS(**null class loader 的类**,:1883-1887)→ HEAP_DUMP_END。`do_object` 有个细节: **Class 对象不 dump 为 instance**(它们以 CLASS_DUMP 记录出现,:1451-1457),CDS 归档的 dormant 对象也跳过(:1459-1461)。

## 2. hprof 格式: 记录、段与 sub-record

文件头(注释从 `hprof_io.c` 复制,heapDumper.cpp:52-130): `"JAVA PROFILE 1.0.2\0"`(19 字节)+ `u4 id size` + `u8 时间戳(ms)`——[实证](planning/outlines/00-jvm-tools/materials/commands/37-heap-dumper-demo.txt)里 `id_size=8`(64 位)、时间戳与运行时刻吻合。**顶层记录**: `u1 tag + u4 time + u4 len + body`;**堆数据在 HEAP_DUMP_SEGMENT(0x1C)记录里**,1.0.2 格式允许把堆 dump 拆成多个段,以 HEAP_DUMP_END(0x2C)收尾(:307-342)。

段由 `DumpWriter::start_sub_record` 管理(heapDumper.cpp:575-603): 第一个 sub-record 前写 `1C + u4(0) + u4(len)` 的段头,len **动态回填**("Will be fixed up later if we add more sub-records");sub-record 放不下(超过 1MB 缓冲区)时 `finish_dump_segment` 结束当前段、开新段。**段内 sub-record 头也是 9 字节(u1 tag + u4 time + u4 len)**,body 长度由类型决定。

sub-record 种类与 JDK11 的实现形态(注意与标准 hprof spec 的差异): **CLASS_DUMP(0x20)** = `id class + u4 STACK_TRACE_ID + id×6(super/loader/signers/protection_domain/reserved×2) + u4 instance size + 常量池/static/instance 字段描述符`(dump_class_and_array_classes :994-1033)——**没有标准 spec 里的 u4 class serial**;`STACK_TRACE_ID` 是常量 1(:373),不是真实栈轨迹;static 字段值按类型宽度写入,instance 字段只写描述符(id name + u1 type)。**INSTANCE_DUMP(0x21)** = `id object + u4 STACK_TRACE_ID + id class + u4 size + 字段值`(dump_instance :969-987)——标准 spec 里没有 object id 与 stack trace id 这两个字段;实例字段值按类字段布局写入(实例大小由 `instance_size` 算,:827)。**OBJ_ARRAY_DUMP(0x22)** = `id + u4 stid + u4 len + id 元素类 + 元素 id 数组`(:1145-1159);**PRIM_ARRAY_DUMP(0x23)** = `id + u4 stid + u4 len + u1 元素类型 + 原始字节`(:1179-1193)。还有 `GC_ROOT_*` 家族(0x01-0x08 与 0xFF): JNI_GLOBAL/JNI_LOCAL/JAVA_FRAME/NATIVE_STACK/STICKY_CLASS/THREAD_BLOCK/MONITOR_USED/THREAD_OBJ/UNKNOWN(:357-364)。

## 3. 对象 ID 的真相: 地址即 ID

hprof 里所有"引用"都是 **id 字段**——而 JDK11 的 id **就是对象地址**(write_objectID,heapDumper.cpp:526-533,`write_u8((u8)a)`);class id 用 **java mirror 的地址**(write_classID :553-555,注释 "We use java mirror as the class ID");符号 id 用 Symbol 指针(:535-542)。[实证](planning/outlines/00-jvm-tools/materials/commands/37-heap-dumper-demo.txt)里解析出的 INSTANCE_DUMP 的 class id 字段 `ff 53 b6 30...` 正是堆内地址形态。*关键设计: 地址作 id 让引用解析变成零成本指针,但 dump 文件不跨进程稳定*——**这也意味着转储必须在 safepoint 里做**: 遍历过程中对象不允许移动(GC 压缩),地址才是有效的。

## 4. 实证对照: 结构与 live 语义

[实证](planning/outlines/00-jvm-tools/materials/commands/37-heap-dumper-demo.txt)的两个 dump(同进程、同参数,只差 live):
- **live=false**: 15.4MB、16 个段;顶层 UTF8 49109 / LOAD_CLASS 2211 / FRAME 30 / TRACE 8;段内 **INSTANCE_DUMP 104269 / PRIM_ARRAY 34837 / OBJ_ARRAY 23378 / CLASS_DUMP 2021 / ROOT_STICKY_CLASS 1601 / ROOT_JNI_GLOBAL 64 / ROOT_THREAD_OBJ 7**——CLASS_DUMP 数与 LOAD_CLASS 数同量级(数组类合并),STICKY_CLASS 1601 条印证"null 类加载器的类"的语义,THREAD_OBJ 7 条与运行线程数一致。
- **live=true**(先 Full GC): 6.0MB、4 个段;**INSTANCE_DUMP 37782(减少 64%)**、数组同理——GC 清掉了不可达对象,文件显著变小,代价是转储时间里的 STW 多一段 Full GC。

转储完成输出 "Heap dump file created [15430735 bytes in 0.264 secs]"(HeapDumper::dump :1969-1973)。

## 核心悬念

HeapDumper 拆完: 它是 VM_GC_Operation+AbstractGangTask——safepoint 内 ensure_parsability → 可选 Full GC(GCLocker 跳过)→ WorkGang 并行写;文件是 "JAVA PROFILE 1.0.2" 头 + 记录流,堆数据在 HEAP_DUMP_SEGMENT 里,段内 sub-record 是 **JDK11 专有形态**(CLASS_DUMP 无 serial、各类 dump 带 STACK_TRACE_ID);**对象 ID 就是地址**(所以必须 safepoint);实证把 15MB 文件逐字节解析、live 对照验证 GC 语义。剩两件事没展开: dump 文件可以 **gzip 压缩**(GZipCompressor),以及 heap dump 除了 jmap 还有**哪些入口**(HeapDumpOnOutOfMemoryError/DCmd/API);它们都绕不开一个更细的问题——**压缩后的文件与段分割怎么协作**。下一篇: 压缩与多触发入口。

> → [37-heap-dumper/02 — 流式压缩 + 多触发入口: jcmd/JMX/JFR/OOM](02-compression-triggers.md)
