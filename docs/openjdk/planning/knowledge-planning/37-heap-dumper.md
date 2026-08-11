# 域 37: Heap Dumper — 知识规划

> 源码: services/heapDumper.* + heapDumperCompression.* | 4文件 | 🟡 普通域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| services/heapDumper.hpp/cpp | **HeapDumper — hprof 格式 dump**: dump_heap()→write hprof header→iterate oops(GC root+klass+instances)→write records, parallel GC during dump, JMM/jcmd/DCmd/JFR 多种触发入口 | High |
| services/heapDumperCompression.hpp/cpp | **Compression**: gzip compress on-the-fly(OutputStream wrapper), deflater/inflater, 边写边压缩不存temp file | Medium |

*2 知识点*

## 02 聚合 — P1/P2/P3

### P2 (2-4文件)
| KP | 出现文件 |
|----|---------|
| HeapDumper + hprof format | heapDumper.cpp, heapDumper.hpp |

### P3 (=1文件)
| KP | 出现文件 |
|----|---------|
| GZip Compression on-the-fly | heapDumperCompression.cpp, heapDumperCompression.hpp |

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| HeapDumper — hprof binary format | jmap/jcmd/JFR 多种方式触发 heap dump——JVM 在 safepoint 暂停→遍历所有 oop(GC root→klass→instances)→写入 hprof binary records。压缩 on-the-fly zlib 避免 前写入大 tmp file。并行 GC 线程 dump 减少 STW 时间 |

### 🟡 Working (1 KP)
| KP | 说明 |
|----|------|
| Compression | gzip deflater 流式压缩 |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | Heap Dumper | "jmap -dump:live,file=heap.hprof 怎么工作？hprof 格式是什么？" |
| 2 | Compression + 多触发入口 | "怎么在 GC 期间一边 dump 一边压缩？从哪些入口可以触发 dump？" |
