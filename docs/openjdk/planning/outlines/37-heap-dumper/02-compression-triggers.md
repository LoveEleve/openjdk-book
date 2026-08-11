# 02. 流式压缩 + 多触发入口 — jcmd/JMX/JFR/OOM

> 🟡 Working | gzip on-the-fly + 4种触发路径
> 读者处境: 10GB heap dump → 不压缩写 10GB 文件(I/O bottleneck, 磁盘满)。gzip 流式压缩 → ~2.5GB 文件。jcmd/JMX/JFR/OnOOMError 四种方式触发——各自适用不同诊断场景。

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
