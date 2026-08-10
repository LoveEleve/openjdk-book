# 25 — Java Flight Recorder — libjvm.so (jfr/)

## §〇 概述

分析 HotSpot JFR（Java Flight Recorder）事件记录子系统，215 个源文件 ~34K 行。

**源码路径**：`src/hotspot/share/jfr/`

### BUILD_LIBRARY

属于 libjvm.so 内部编译：
```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM
```

JFR 通过 `--with-jfr` configure 选项控制是否编译进入 libjvm.so。

---

## §一 架构概览

```
jfr/ (215 files, ~34K lines)

┌─ Recorder Engine (69 files, ~12K lines) ──── 核心记录管道
│  recorder/service/      13 files, 2786行  JfrRecorder: start/stop/rotate/chunk lifecycle
│  recorder/checkpoint/   25 files, 4895行  检查点序列化 (types + traceid)
│  recorder/storage/      13 files, 3037行  环形缓冲区 (JfrBuffer + epoch + DMA)
│  recorder/repository/   10 files, 1223行  Chunk 文件写入 (ChunkWriter + ChunkReader)
│  recorder/stacktrace/    4 files,  702行  调用栈哈希与去重
│  recorder/stringpool/    6 files,  522行  字符串池（常量去重）
│
├─ Event System (68 files, ~12K lines) ─────── 事件从 Java 到 buffer
│  writers/               20 files, 2491行  事件写出器 (struct type-safe 写入)
│  jni/                   12 files, 2296行  JNI 桥接 (Java→C++ 事件提交)
│  support/               15 files, 1209行  JFR 支持类 (Thread/Safepoint/VMError hooks)
│  periodic/              15 files, 2466行  周期事件 (GC/Thread/OS/ClassLoading 采样)
│  metadata/               1 file,   100行  事件元数据描述符
│  dcmd/                   2 files,   852行  JFR 诊断命令 (VM.jfr)
│  utilities/             20 files, 1986行  JFR 内部工具类
│  top-level/              3 files,   198行  JfrEvent/JfrEvents 门面
│
└─ Leak Profiler (47 files, ~8K lines) ─────── 对象泄漏分析
   leakprofiler/           4 files,   250行  LeakProfiler 入口
   leakprofiler/sampling/  7 files,  1046行  对象采样器 (SampleList + ObjectSampler)
   leakprofiler/chains/   19 files,  1988行  引用链构建 (BFS 从 root 到 target)
   leakprofiler/checkpoint/10 files, 2208行  泄漏检查点序列化
   leakprofiler/utilities/ 7 files,   566行  采样工具
   instrumentation/        4 files,  1957行  BCI 插桩 (字节码改写)
```

---

## §二 文档拆分规划

| 编号 | 标题 | 源文件数 | 源码行数 | 状态 |
|:---:|------|:---:|:---:|:---:|
| 00 | Recorder Engine | ~69 | ~12,000 | 待开始 |
| 01 | Event System | ~68 | ~12,000 | 待开始 |
| 02 | Leak Profiler | ~47 | ~8,000 | 待开始 |

### doc-00: Recorder Engine

recorder/service + recorder/checkpoint + recorder/storage + recorder/repository + recorder/stacktrace + recorder/stringpool

**关键问题**：
- JfrRecorder 生命周期状态机 (NEW→CREATED→RUNNING→CLOSED)
- JfrChunkWriter 的 chunk 文件格式 (constant pool + event section + metadata)
- JfrBuffer 环形缓冲区的 epoch 老化机制
- 检查点序列化：TypeSet + TraceId + 常量池去重
- Repository 的 chunk rotation 策略

### doc-01: Event System

writers/ + jni/ + support/ + periodic/ + metadata/ + dcmd/ + utilities/

**关键问题**：
- EventWriter 模板的类型安全写出 (struct field → buffer offset)
- JNI 桥接：Java Event.commit() → JfrEvent::commit() C++ 路径
- 周期事件调度框架 (PeriodicType → EventEmitter)
- VM.log JFR DCMD 实现
- Thread/JFR/Safepoint hooks

### doc-02: Leak Profiler

leakprofiler/ + instrumentation/

**关键问题**：
- ObjectSampler 的弱引用跟踪与 GC 协作
- BFS 引用链构建 (从 GCRoot 到 sampled object)
- BCI 插桩：ClassFileLoadHook → 字节码改写
- 泄漏检测检查点：什么时候采样、什么时候报告

---

## §三 旧文档重叠

- `libjvm-analysis/07-thread-lock/15-JVM-JFR-Sampling.md` 仅覆盖 SamplingThread 线程管理
- 新文档覆盖 jfr/ 源码内部实现，旧引用标记互补

---

## §四 待完成

- [x] 遍历 jfr/ 子目录结构
- [x] 确定 BUILD_LIBRARY 引用
- [ ] 写 prompt（并行 3 篇）
- [ ] 新会话生成文档
- [ ] Review
