# 02. 流式压缩 + 多触发入口 — jcmd/JMX/JFR/OOM

> **前置依赖**:[37-heap-dumper/01 — jmap -dump 怎么工作?— HeapDumper + hprof 格式](01-heap-dumper.md):DumpWriter 与段分割、VM_HeapDumper 执行模型都在上一篇;[36-attach/02 — 怎么在运行时动态加载 JVMTI agent?— JDK Attach API + loadAgent](openjdk/vol-02/36-attach/02-jdk-attach.md):jcmd 命令经 attach 通道进 DCmd 框架
> → **后续**:[39-runtime-monitoring/01 — JVM 的后台线程做什么?— ServiceThread](openjdk/vol-02/39-runtime-monitoring/01-service-thread.md):38-perfdata 域已完结,37 域收官后按写作顺序进入 39-runtime-monitoring
> 关联域: 35-dcmd(GC.heap_dump 是 DCmd)、25-gc(GC 前后 dump)

## 15MB 的 dump,怎么压到 1.3MB

01 篇把 hprof 格式拆完了——但 15MB 的转储文件写盘很慢、很占空间。这篇回答两个问题: **压缩是怎么流式做掉的**(不产临时文件、不把整个 dump 留在内存);以及 **heap dump 到底有几个触发入口**(jmap/jcmd/JMX/OOM/GC 前后),各自的语义差异。核心答案是: 压缩是**块级 gzip**,由 JVM 动态加载的 libzip 库完成,块在 WorkGang worker 线程上与遍历并行压缩、按序落盘;触发入口比"四路"还多一路,而 **JFR 的"应急 dump"是编造**——JFR 的 JfrEmergencyDump 转储的是录制数据,与 heap dump 无关。

## 1. 流式压缩: 块队列 + 并行 worker

压缩管线是三层: `DumpWriter`(缓冲)→ `CompressionBackend`(块队列与压缩线程)→ `FileWriter`。`DumpWriter::flush` 只做一件事——`_backend.get_new_buffer(&_buffer, &_pos, &_size)`(heapDumper.cpp:496-498): 把写满的块交给后端,换回新块。`CompressionBackend::get_new_buffer`(heapDumperCompression.cpp:381-444)把满块按 `_id` 进 `_to_compress` 队列并唤醒 worker;**worker 线程**(`thread_loop`,:277-303)循环 `get_work → do_compress → finish_work`——`do_compress` 调压缩器(:432-446),`finish_work` 把压完的块放进 `_finished` 并按 **_id 顺序写文件**(:461-482,`add_by_id` 保证先压完的块也不能乱序落盘)。**没有 worker 时**(deactivate 尾部或单线程)VM 线程自己同步压缩(`thread_loop(true)`,:259-261)。

压缩器是 `GZipCompressor`(heapDumperCompression.hpp:81)——**不是 JVM 内联的 deflater**,而是 **dlsym 动态加载 libzip.so 的 `ZIP_GZip_Fully`/`ZIP_GZip_InitParams`**(heapDumperCompression.cpp:70-119,`load_gzip_func` :77-91: `os::dll_locate_lib(dll_dir, "zip")`+`dll_load`+`dll_lookup`——就是 JDK 自带的 libzip);`init`(:93-119)让 libzip 算出输出/临时缓冲大小,再**多留 1024 字节**给第一个 chunk 的注释;`compress`(:121-139)分块调用,第一个块带注释:

```cpp
// heapDumperCompression.cpp:125-132(截取核心,逐字)
  if (_is_first) {
    char buf[128];
    // Write the block size used as a comment in the first gzip chunk, so the
    // code used to read it later can make a good choice of the buffer sizes it uses.
    jio_snprintf(buf, sizeof(buf), "HPROF BLOCKSIZE=" SIZE_FORMAT, _block_size);
    *compressed_size = gzip_compress_func(in, in_size, out, out_size, tmp, tmp_size, _level,
                                          buf, &msg);
    _is_first = false;
```

[实证](planning/outlines/00-jvm-tools/materials/commands/37-heap-dumper-gzip-oome-demo.txt): `jcmd` 发 `GC.heap_dump /tmp/heap-gz.hprof -gz=1` 产出 **1318476 字节**(同进程非压缩 15430735,**压缩比约 12x**),文件头 `1f8b 0810 ...`——gzip magic + deflate + **FCOMMENT**,注释正是 **`HPROF BLOCKSIZE=1048576`**(块大小 1MB);python `gzip.decompress` 还原出 "JAVA PROFILE 1.0.2\0" 头,解压后结构与 01 篇一致。*关键设计: 压缩在 WorkGang worker 线程上与遍历并行——但**仍然在 safepoint 内**(VM_Operation 的 run_task 全程 STW),不是"异步在 safepoint 外";顺序靠块 id 保证,不产 temp 文件,磁盘峰值就是最终文件大小*。

## 2. 触发入口: 五路,不是四路

**①attach `dumpheap` 操作**(jmap -dump;attachListener.cpp:220-242)——36-attach/02 已述,参数 path/-live/-all。**②DCmd `GC.heap_dump`**(jcmd 工具;`HeapDumpDCmd`,diagnosticCommand.cpp:510-544,注册 :92 为 Internal|AttachAPI)——**唯一带压缩参数的路**: `-gz`(1-9,默认 1)由 `dumper.dump(filename, output(), level, overwrite)` 传进 HeapDumper::dump 的 compression 参数(:539-543);`-all` 反向控制 `_gc_before_heap_dump`。**③JMX `HotSpotDiagnosticMXBean.dumpHeap(file, live)`**(jdk.management 的 `com.sun.management.internal.HotSpotDiagnostic`;native 入口 **`jmm_DumpHeap0`**,management.cpp:1901-1920,构造 `HeapDumper dumper(live)` → `dumper.dump(name)`)——01 篇的实证入口,无压缩参数。**④OOM**: `-XX:+HeapDumpOnOutOfMemoryError`(globals.hpp:660,默认 false)+ `HeapDumpPath`(:663,文件或目录)→ OOM 时 `report_java_out_of_memory`(debug.cpp:322-337,**`Atomic::cmpxchg` 保证多个 OOM 线程只 dump 一次**)→ `HeapDumper::dump_heap_from_oome()`(heapDumper.cpp:2023-2025)→ `dump_heap(true)`(:2032-2111: 文件名 `java_pid<pid>.hprof` 默认 cwd、HeapDumpPath 指定文件或目录、后续 dump 追加 `.1/.2...` 序号;`HeapDumper dumper(false, oome)`——**OOM dump 不做 GC**)。**⑤GC 前后**: `-XX:+HeapDumpBeforeFullGC/AfterFullGC`(globals.hpp:654/657)→ `CollectedHeap::full_gc_dump`(collectedHeap.cpp:514-528)在 Full GC 前后调 `HeapDumper::dump_heap()`——用于对比 GC 前后堆形态。

[实证](planning/outlines/00-jvm-tools/materials/commands/37-heap-dumper-gzip-oome-demo.txt)的 OOM 路: `-Xmx64m -XX:+HeapDumpOnOutOfMemoryError` 无限分配 → 输出顺序 "java.lang.OutOfMemoryError: Java heap space" → "Dumping heap to java_pid1633032.hprof ..." → "Heap dump file created [34657391 bytes in 0.016 secs]" → 异常抛出——**dump 发生在异常抛出前**(report_java_out_of_memory 在抛异常路径上);64MB 堆 dump 出 34MB(G1 区域全景)。*关键设计: OOM dump 默认关是对的——OOM 时堆已满,dump 自身还要 malloc 缓冲(DumpWriter 的 1MB 缓冲、文件名路径等)与触发 Full GC 之外的工作,在崩溃边缘再分配有风险;开启时 dump 不做 GC(避免雪上加霜)*。

**JFR 澄清**: 大纲想象的 "JFR GC 事件 → JfrEmergencyDump → HeapDumper::dump" **不存在**——`JfrEmergencyDump`(jfr/recorder/repository/jfrEmergencyDump.cpp)在 VM 崩溃时转储 **JFR 录制数据**(chunk),与 heap dump 无关;JDK11 的 JFR 没有 heap dump 集成。

## 3. 段分割与压缩的协作

01 篇的段分割是**内容层**概念(HEAP_DUMP_SEGMENT 记录在 hprof 格式里),压缩是**传输层**概念(gzip 块包裹任意字节流)——两者正交: DumpWriter 照常切段、写 sub-record,块满就交给后端压缩;解压后仍是完整合法的 hprof 段序列([实证](planning/outlines/00-jvm-tools/materials/commands/37-heap-dumper-gzip-oome-demo.txt)里解压头验证)。这也解释了 gzip 头里 `HPROF BLOCKSIZE` 注释的用途: 读取端(MAT 之类工具)拿它预估解压缓冲。压缩入口只此一条(-gz),JMX/OOM/GC 前后三路都不压缩。

## 核心悬念

37 域收官: 压缩是块级 gzip(libzip 的 ZIP_GZip_Fully 经 dlsym 加载,第一块带 HPROF BLOCKSIZE 注释),CompressionBackend 的 worker 与遍历并行、按块 id 顺序落盘——全程在 safepoint 内;触发有五路: attach dumpheap / DCmd GC.heap_dump(-gz 唯一压缩路)/ JMX dumpHeap / OOM(默认关,只 dump 一次,不做 GC)/ GC 前后;JFR 的"应急 heap dump"是编造。[实证](planning/outlines/00-jvm-tools/materials/commands/37-heap-dumper-gzip-oome-demo.txt)把 gzip 头、12x 压缩比、OOM 自动 dump 顺序全部对上。至此 39-runtime-monitoring 域之前的地基都齐了——下一篇进入运行时监控域: 它把 38-perfdata 的计数器、NMT 的报告、attach 的命令都收拢到"运行时观测"这条主线上,而第一个主角就是 ServiceThread——20-02 域里见过它的背影。

> → [39-runtime-monitoring/01 — JVM 的后台线程做什么?— ServiceThread](openjdk/vol-02/39-runtime-monitoring/01-service-thread.md)
