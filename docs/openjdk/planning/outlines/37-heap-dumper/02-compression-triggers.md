# 02. 流式压缩 + 多触发入口 — jcmd/JMX/JFR/OOM

> 🟡 Working | gzip on-the-fly + 4种触发路径
> 读者处境: 10GB heap dump → 不压缩写 10GB 文件(I/O bottleneck, 磁盘满)。gzip 流式压缩 → ~2.5GB 文件。jcmd/JMX/JFR/OnOOMError 四种方式触发——各自适用不同诊断场景。

> ⚠️ 写作期修正(2026-08-15, vol-02/37-heap-dumper/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"deflater 在 safepoint 外异步压缩" 错(重要)**: 压缩在 **WorkGang worker 线程**上跑(thread_loop :277-303),与遍历并行但**全程在 safepoint 内**(VM_Operation 的 run_task STW);顺序保证=_finished.add_by_id 按块 id 写文件(finish_work :461-482);无线程时 VM 线程同步压(thread_loop(true) :259-261/deactivate);无 temp 文件 ✓
> - **"GZipCompressor 是 DumpWriter 的子类" 错**: GZipCompressor 继承 **AbstractCompressor**(heapDumperCompression.hpp:81);DumpWriter 组合 **CompressionBackend**(块队列/worker);管线=DumpWriter(缓冲)→CompressionBackend(get_new_buffer :381-444)→FileWriter
> - **"JFR: GC 事件 → JfrEmergencyDump → HeapDumper::dump" 编造(重要)**: JfrEmergencyDump(jfr/recorder/repository/jfrEmergencyDump.cpp)是 **JFR 录制数据**的应急转储,与 heap dump 无关;JDK11 JFR 无 heap dump 集成——大纲把两个东西混了
> - **"jcmd → JMM_DumpHeap0" 错**: jcmd 的 GC.heap_dump 走 **HeapDumpDCmd**(diagnosticCommand.cpp:510-544,注册 :92 Internal|AttachAPI;filename 是**位置参数**;参数 -all/-gz 1-9 默认 1/-overwrite);**JMM_DumpHeap0 是 JMX 入口**(management.cpp:1901-1920)
> - **"四路触发" 不全**: 真实**五路**——①attach dumpheap(jmap;attachListener.cpp:220-242)②DCmd GC.heap_dump(唯一压缩路)③JMX HotSpotDiagnosticMXBean.dumpHeap(jmm_DumpHeap0)④OOM(HeapDumpOnOutOfMemoryError globals.hpp:660 默认 false→report_java_out_of_memory debug.cpp:322-337 **cmpxchg 只报一次**→dump_heap_from_oome heapDumper.cpp:2023-2025→dump_heap(true) 文件名 java_pid<pid>.hprof+HeapDumpPath+.<seq> :2032-2111,**不做 GC** :2108)⑤**GC 前后**(HeapDumpBeforeFullGC/AfterFullGC globals.hpp:654/657→full_gc_dump collectedHeap.cpp:514-528)
# - **行号漂移**: heapDumperCompression.cpp **477 行**(大纲 70-140): load_gzip_func :77-91;init :93-119(needed_out_size+1024 注释空间 :116);compress :121-139
# - **"找不到 libzip→fallback 无压缩" 半对**: dlsym 失败→init 返回错误消息→CompressionBackend set_error→**dump 报错**(不是静默降级);压缩器为 NULL 时才是无压缩直写模式(finish_work :471-472 分支)
# - **缺机制(重要)**: ①gzip 第一块带 **"HPROF BLOCKSIZE=..." 注释**(compress :125-132;实证文件头 1f8b 0810 FCOMMENT + 注释);②实测压缩比 ~12x(1318476 vs 15430735);③OOM dump 顺序=OOM 消息→dump→异常抛出;④64MB 堆 dump 出 34MB
# - **实证**: 37-heap-dumper-gzip-oome-demo.txt(自 attach+executeJCmd 需 --add-exports sun.tools.attach+cast HotSpotVirtualMachine;GC.heap_dump 的 filename 是位置参数;gzip 头/解压验证;OOM 自动 dump java_pid<pid>.hprof)
# - **悬念指向错**: "→ 域38 PerfData" 过期(38 域第 2 批已完结);按 writing-order 37→39,正确 **39-runtime-monitoring/01**(ServiceThread)

### 1. "流式压缩 — gzip deflater on-the-fly"

场景: `heapDumper.cpp` 创建 `GZipOutputStream` 包裹 `FileOutputStream` → 写 hprof record 时自动 deflate → 不需要 temp file → 磁盘只需存 ~25% 原始大小。

**GZipCompressor** (`heapDumperCompression.cpp:70-140`):
```
GZipCompressor::init():
  → load ZIP_GZip_InitParams (dlsym from libzip.so → heapDumperCompression.cpp:107)
  → allocate output buffer (compressed_size returned by init)

GZipCompressor::compress(in, in_size, out, out_size):
  → ZIP_GZip_Fully(in, in_size, out, out_size, tmp, tmp_size, level, msg) 
  → 调用 libzip.so 的 ZIP_GZip_Fully(block-based compression)
  → 返回 compressed_size

GZipCompressor 是 DumpWriter 的子类——上层 HeapDumper::work() 无需知道数据被压缩
[C++: heapDumperCompression.cpp:477行——gzip 通过 dlsym 动态加载 libzip.so 中的 ZIP_GZip_* 函数]
```
- 源码: `heapDumperCompression.cpp:70-110` (GZipCompressor::init → load_gzip_func) + `heapDumperCompression.cpp:120-140` (compress → ZIP_GZip_Fully)

- 关键设计: **压缩委托给 libzip.so**——不是 JVM 内联的 deflater 循环。`ZIP_GZip_Fully` 是 block-based 压缩——每次调用压缩一个 block→JVM 边写边压不需要暂存全 dump。**动态加载 (dlsym)**——如果 libzip.so 不存在或不含 ZIP_GZip_Fully→压缩不可用→fallback 到 Uncompressed DumpWriter。**无 temp file**——压缩后的数据直接写入最终 .hprof 文件 via FileWriter。

### 2. "四路触发入口"

场景: 生产环境用 JMX(避免 STW 太长的 jmap)、开发用 jcmd(快速)、JFR 自动触发(GC 后 dump)、OOM 自动 dump(事后分析)。

**4 触发路径** (`heapDumper.cpp:1931-2100`):
```
1. jcmd <pid> GC.heap_dump file=dump.hprof
   → Attach Listener → JMM_DumpHeap0 → HeapDumper::dump(path)

2. JMX HotSpotDiagnosticMXBean.dumpHeap(file, live)
   → DiagnosticCommand.dumpHeap → HeapDumper::dump(path)

3. JFR: GC 事件触发 → on_vm_shutdown / full GC
   → JfrEmergencyDump → HeapDumper::dump(path)

4. -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/tmp/
   → report_java_out_of_memory → HeapDumper::dump_heap_from_oome() (heapDumper.cpp:2023)
[C++: 四入口通过 HeapDumper::dump_heap() (heapDumper.cpp:2032)→VM_HeapDumper VM_Operation→safepoint→work()]
```
- 源码: `heapDumper.cpp:2023-2050` (OOM dump) + `heapDumper.cpp:50-100` (JMM 入口) + `diagnosticCommand.cpp` (JMX 入口)

- 关键设计: **OOM dump 是最关键的生产诊断工具**——`-XX:+HeapDumpOnOutOfMemoryError` 默认关——因为 OOM 时 heap 已满→dump 可能在已满的堆上失败(需要额外内存分配)。**JFR 应急 dump**——JFR 记录 full GC 事件→可选触发 heap dump——但不等于 OOM dump(JFR 优先于 OOM 探测)。

---

### 核心悬念

**"gzip 流式压缩 on-the-fly——deflater 在 safepoint 外异步压缩→无 temp file→无双倍磁盘。jcmd/JMX/JFR/OnOOMError 四路触发——共用同一个 HeapDumper::dump() in safepoint。"** — 下一篇: 域38 PerfData (mmap shared memory counter)。

> → 域38 PerfData
