# 02. 边 dump 边压缩 + 多触发入口

> 🟡 Working | 1 KP 中的压缩+入口
> 读者处境: 10GB heap dump → 不压缩写 10GB 文件(I/O bottleneck)。压缩 on-the-fly → 只写 ~2GB gzip。

### 1. "压缩 — gzip 流式"

场景: `OutputStream*` wrapper → gzip deflater→写 chunk→另一端 decompress。

**Compression** (`services/heapDumperCompression.hpp/cpp:40-200`):
```
GZipOutputStream:
  write(data, len):
    → deflater.setInput(data, len)
    → while(!deflater.needsInput): write(deflater.deflate()) // ~2x compression
```
- 源码: `services/heapDumperCompression.hpp:30-80` + `heapDumperCompression.cpp:50-200`

### 2. "多触发入口"

**HeapDump 触发路径** (`heapDumper.cpp:50-100`):
```
jcmd:   jcmd <pid> GC.heap_dump file=heap.hprof
JMX:    HotSpotDiagnosticMXBean.dumpHeap()
JFR:    JFR记录 full GC→触发 heap dump(optional)
JMM:    jmm_DumpHeap0 → JMM via jmm.h
```
- 源码: `heapDumper.cpp:50-100`

---

### 核心悬念

**"gzip deflater 流式压缩 on-the-fly——no temp file。jcmd/JMX/JFR 多入口触发 heap dump。"** — 下一篇: 域38 PerfData。

> → 域38 PerfData
